// Jarvis Geräte-Isolation (TF-073) – gemeinsamer Kern OHNE Node-Abhängigkeiten (Netlify Function, Tests, lokaler Agent).
//
// Modell: jeder Jarvis-Benutzer (chris, giuliano, mario, damiano, Kudoshin) hat EIGENE Geräte (PC/Telefon). Kein Mesh, kein gemeinsamer
// Geräte-Pool, kein globaler Geräte-Token, keine Peer-to-Peer-Verbindung. Ein Gerät verbindet sich nur AUSGEHEND (HTTPS) zur Cloud.
//
// Zwei getrennte Rechte-Welten:
//   Cloud-Admin-RBAC (auth-core.js PERMISSIONS)  → Chris (OWNER) verwaltet Verkäufer-Konten, Leads, Verkäufe, Provisionen, CRM.
//   Geräte-Steuerung (hier)                      → NUR der Eigentümer des Geräts: authenticated_user_id === device.owner_user_id.
// OWNER ist KEINE Ausnahme: Chris steuert nur Chris-Geräte. Er darf Geräte administrativ deaktivieren und Metadaten sehen – das öffnet
// ihm nie eine Verbindung zu einem fremden Gerät.
//
// Speicher (Netlify Blobs "jarvis-devices"): "devices" (Registry), "pairings" (nur SHA-256 der Einmal-Codes), "sessions" (nur SHA-256 der
// Sitzungs-Tokens), "commands" (Warteschlange je Gerät), "audit". Geräte-Secrets liegen nur als SHA-256 vor – nie Klartext.
import { USERS, OWNER_ID, sha256Hex, randomToken } from "./auth-core.js";
import { safeEqual, netlifyBlobStore } from "./shared-state.js";

// "pc" = DESKTOP (Windows/macOS/Linux-Rechner mit lokalem Jarvis), "phone" = PHONE. Eingaben "desktop"/"DESKTOP" werden zu "pc".
export const DEVICE_TYPES = Object.freeze(["pc", "phone"]);
export const DEVICE_TYPE_LABEL = Object.freeze({ pc: "DESKTOP", phone: "PHONE" });
export function normalizeDeviceType(v) {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return t === "desktop" || t === "pc" ? "pc" : t === "phone" ? "phone" : null;
}
export const DEVICE_STATUSES = Object.freeze(["active", "revoked", "disabled"]);
export const PAIRING_FLOW = "device_pair";
export const PAIRING_TTL_MS = 10 * 60_000;     // Einmal-Code: 10 Minuten
export const MAX_OPEN_PAIRINGS = 3;            // offene Codes je Benutzer
export const MAX_DEVICES_PER_USER = 10;        // aktive Geräte je Benutzer
export const SESSION_TTL_MS = 30 * 60_000;     // Geräte-Sitzung: 30 Minuten, nicht verlängerbar
export const ONLINE_MS = 2 * 60_000;           // "online" = Agent hat sich in den letzten 2 min gemeldet
export const DEVICE_HEADER = "x-jarvis-device";      // "<device_id>.<secret>" – nur der Agent
export const DEVICE_FP_HEADER = "x-jarvis-device-fp"; // SHA-256 der geräteeigenen Identität
export const DEVICE_CV_HEADER = "x-jarvis-device-cv"; // TF-074: Credential-Version (muss zur gespeicherten passen)

// Einzige Quelle der Geräte-Aktionen (TF-074: je Gerätetyp). Benannte, feste Fähigkeiten ohne Parameter – KEINE Shell, kein exec(command),
// kein freier Dateipfad, kein Desktop. Neue Aktionen nur hier (deny by default) und nur mit passendem Handler im Agenten.
const ALL_TYPES = Object.freeze(["pc", "phone"]), DESKTOP = Object.freeze(["pc"]);
export const DEVICE_ACTIONS = Object.freeze({
  "device.ping": Object.freeze({ label: "Erreichbarkeit prüfen", types: ALL_TYPES }),
  "device.status": Object.freeze({ label: "Agent-Status (Version, Plattform, Laufzeit)", types: ALL_TYPES }),
  get_agent_status: Object.freeze({ label: "Agent-Status", types: ALL_TYPES }),
  heartbeat: Object.freeze({ label: "Lebenszeichen", types: ALL_TYPES }),
  get_system_status: Object.freeze({ label: "System-Status (CPU, Speicher, Laufzeit – keine Dateien)", types: DESKTOP }),
  sync_jarvis_state: Object.freeze({ label: "Jarvis-Zustand jetzt abgleichen", types: DESKTOP }),
  read_jarvis_project_status: Object.freeze({ label: "Projektstand lesen (nur Kopfzeile aus PROJECT_STATE.md)", types: DESKTOP }),
  run_predefined_jarvis_health_check: Object.freeze({ label: "Vordefinierter Jarvis-Health-Check", types: DESKTOP }),
});
export const actionSupported = (action_id, device_type) => Object.hasOwn(DEVICE_ACTIONS, action_id) && DEVICE_ACTIONS[action_id].types.includes(device_type);
export const capabilitiesFor = (device_type) => Object.entries(DEVICE_ACTIONS).filter(([, a]) => a.types.includes(device_type)).map(([action_id, a]) => ({ action_id, label: a.label }));
// Felder, die nach freien Befehlen/Pfaden aussehen: jede Aktion mit einem davon wird abgewiesen (keine "Parameter-Hintertür").
export const ARBITRARY_FIELDS = Object.freeze(["command", "cmd", "script", "shell", "exec", "powershell", "bash", "args", "argv", "path", "file", "files", "dir", "url", "params"]);

export const DEVICE_ID_RE = /^dev_[A-Za-z0-9_-]{22}$/;
export const FP_RE = /^[a-f0-9]{64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const CODE_RE = /^[A-Za-z0-9_-]{32}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{43}$/;
const COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{22}$/;

export const isCanonicalUser = (id) => typeof id === "string" && Object.hasOwn(USERS, id);
export const newDeviceId = () => `dev_${randomToken(16)}`;
export const newCommandId = () => `cmd_${randomToken(16)}`;
export const newDeviceSecret = () => randomToken(32);
export const newPairingCode = () => randomToken(24);
export const newSessionToken = () => randomToken(32);
export const isDeviceId = (v) => typeof v === "string" && DEVICE_ID_RE.test(v);
export const isPairingCode = (v) => typeof v === "string" && CODE_RE.test(v);
export const isSessionToken = (v) => typeof v === "string" && SESSION_RE.test(v);
export const isCommandId = (v) => typeof v === "string" && COMMAND_ID_RE.test(v);

// ---------- Kernregel (unterste serverseitige Schicht) ----------
// Jede Geräte-Sitzung und jede Geräte-Aktion läuft hier durch – beim Öffnen, beim Einreihen UND bei der Auslieferung an den Agenten.
// Reihenfolge: zuerst Eigentum (fremde Anfragen erfahren nichts über Status/Existenz), dann Status, dann Aktion.
export function authorizeDeviceAccess({ requesting_user_id, device, action_id = null }) {
  const no = (status, code, error) => ({ ok: false, status, code, error });
  if (!isCanonicalUser(requesting_user_id)) return no(403, "DEVICE_FORBIDDEN", "Kein Zugriff auf dieses Gerät.");
  if (!device || typeof device !== "object") return no(403, "DEVICE_FORBIDDEN", "Kein Zugriff auf dieses Gerät.");
  // Keine OWNER-Ausnahme: auch Chris braucht Eigentum.
  if (!isCanonicalUser(device.owner_user_id) || device.owner_user_id !== requesting_user_id) return no(403, "DEVICE_FORBIDDEN", "Kein Zugriff auf dieses Gerät.");
  if (device.status === "revoked") return no(403, "DEVICE_REVOKED", "Gerät widerrufen.");
  if (device.status !== "active") return no(403, "DEVICE_DISABLED", "Gerät deaktiviert.");
  if (action_id != null && !Object.hasOwn(DEVICE_ACTIONS, action_id)) return no(400, "UNKNOWN_ACTION", "Unbekannte Geräte-Aktion.");
  if (action_id != null && !actionSupported(action_id, device.device_type)) return no(400, "DEVICE_ACTION_UNSUPPORTED", "Diese Aktion unterstützt der Gerätetyp nicht.");
  return { ok: true };
}

const online = (d, now) => !!d.last_seen_at && d.status === "active" && +now - Date.parse(d.last_seen_at) < ONLINE_MS;
// Sicht des Eigentümers – Whitelist: nie credential_hash, nie Identitäts-Fingerprint, keine IP.
export function publicDevice(d, now = new Date()) {
  return { device_id: d.device_id, owner_user_id: d.owner_user_id, device_type: d.device_type, device_type_label: DEVICE_TYPE_LABEL[d.device_type] || null, device_name: d.device_name,
    created_at: d.created_at, last_seen_at: d.last_seen_at || null, status: d.status, online: online(d, now), credential_version: d.credential_version || 1,
    capabilities: d.status === "active" ? capabilitiesFor(d.device_type).map((c) => c.action_id) : [] };
}
// Owner-Übersicht (Monitoring/Admin, keine Fernsteuerung): nur Metadaten.
export function adminDevice(d, now = new Date()) {
  return { device_id: d.device_id, owner_user_id: d.owner_user_id, device_type: d.device_type, device_name: d.device_name, status: d.status,
    online: online(d, now), last_seen_at: d.last_seen_at || null, created_at: d.created_at };
}

export function cleanDeviceName(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
  return s.length >= 2 ? s : null;
}
// Ergebnis eines Agenten: nur flache Primitive, kurze Strings, wenige Schlüssel (keine Dateiinhalte, keine Pfadlisten).
export function cleanResult(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return {};
  const out = {};
  for (const [k, v] of Object.entries(r).slice(0, 10)) {
    if (!/^[a-z_]{1,30}$/.test(k)) continue;
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 100);
  }
  return out;
}

// Geräte-Credential aus dem Header: "<device_id>.<secret>".
export function parseDeviceCredential(v) {
  if (typeof v !== "string" || v.length > 120) return null;
  const i = v.indexOf(".");
  if (i < 0) return null;
  const device_id = v.slice(0, i), secret = v.slice(i + 1);
  return isDeviceId(device_id) && SECRET_RE.test(secret) ? { device_id, secret } : null;
}
export async function credentialMatches(device, secret) {
  if (!device?.credential_hash || typeof secret !== "string") return false;
  return safeEqual(await sha256Hex(secret), device.credential_hash);
}

// ---------- Speicher ----------
export const emptyDevices = () => ({ schema: 1, devices: {} });
export const emptyPairings = () => ({ schema: 1, codes: {} });
export const emptyDeviceSessions = () => ({ schema: 1, sessions: {} });
export const emptyCommands = () => ({ schema: 1, commands: [] });
export const emptyDeviceAudit = () => ({ schema: 1, entries: [] });
export const emptyMigration = () => ({ schema: 1, revocation_verified_at: null, no_regression_confirmed_at: null, no_regression_confirmed_by: null });
export function deviceStoreFrom(makeKeyStore) {
  return { devices: makeKeyStore("devices"), pairings: makeKeyStore("pairings"), sessions: makeKeyStore("sessions"), commands: makeKeyStore("commands"), audit: makeKeyStore("audit"),
    migration: makeKeyStore("migration") };
}

// ---------- TF-074: Übergang JARVIS_SYNC_TOKEN (Legacy, nur Chris) → Geräte-Credential ----------
// Der Legacy-Token wird hier NIE gelöscht oder rotiert – es wird nur gemeldet, ob alle Voraussetzungen erfüllt sind.
export const MIGRATION_STATES = Object.freeze(["LEGACY_SYNC_ACTIVE", "DEVICE_CREDENTIAL_ACTIVE", "READY_TO_RETIRE_LEGACY"]);
export const MIN_RECONNECTS = 3;
export function migrationStatus({ devices, migration, legacy_configured, api_live }) {
  const chris = Object.values(devices?.devices || {}).filter((d) => d.owner_user_id === OWNER_ID && d.device_type === "pc" && d.status === "active")
    .sort((a, b) => (b.sync_ok_count || 0) - (a.sync_ok_count || 0));
  const d = chris[0] || null, m = migration || emptyMigration();
  const checks = {
    device_api_live: api_live === true,
    chris_device_paired: !!d,
    device_credential_authenticates: !!d?.last_auth_at,
    local_sync_via_device: (d?.sync_ok_count || 0) >= 1,
    repeated_reconnect_tested: (d?.reconnects || 0) >= MIN_RECONNECTS,
    revocation_tested: !!m.revocation_verified_at,
    no_regression_confirmed: !!m.no_regression_confirmed_at,
  };
  const ready = Object.values(checks).every(Boolean);
  const state = ready ? "READY_TO_RETIRE_LEGACY" : checks.local_sync_via_device ? "DEVICE_CREDENTIAL_ACTIVE" : "LEGACY_SYNC_ACTIVE";
  return { state, legacy_sync_configured: !!legacy_configured, legacy_sync_active: !!legacy_configured, device_credential_active: checks.local_sync_via_device,
    ready_to_retire_legacy: ready ? "YES" : "NO", checks, chris_device: d ? { device_id: d.device_id, device_name: d.device_name, last_auth_at: d.last_auth_at || null,
      last_sync_at: d.last_sync_at || null, sync_ok_count: d.sync_ok_count || 0, reconnects: d.reconnects || 0 } : null,
    note: "Legacy-Token bleibt bis zur ausdrücklichen Anweisung aktiv – diese Anzeige löscht/rotiert nichts." };
}
export async function netlifyDeviceStore() {
  const { getStore } = await import("@netlify/blobs");
  const blobs = getStore({ name: "jarvis-devices", consistency: "strong" });
  return deviceStoreFrom((k) => netlifyBlobStore(blobs, k));
}

export { OWNER_ID };
