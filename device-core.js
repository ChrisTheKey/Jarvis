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

export const DEVICE_TYPES = Object.freeze(["pc", "phone"]);
export const DEVICE_STATUSES = Object.freeze(["active", "revoked", "disabled"]);
export const PAIRING_FLOW = "device_pair";
export const PAIRING_TTL_MS = 10 * 60_000;     // Einmal-Code: 10 Minuten
export const MAX_OPEN_PAIRINGS = 3;            // offene Codes je Benutzer
export const MAX_DEVICES_PER_USER = 10;        // aktive Geräte je Benutzer
export const SESSION_TTL_MS = 30 * 60_000;     // Geräte-Sitzung: 30 Minuten, nicht verlängerbar
export const ONLINE_MS = 2 * 60_000;           // "online" = Agent hat sich in den letzten 2 min gemeldet
export const DEVICE_HEADER = "x-jarvis-device";      // "<device_id>.<secret>" – nur der Agent
export const DEVICE_FP_HEADER = "x-jarvis-device-fp"; // SHA-256 der geräteeigenen Identität

// Einzige Quelle der Geräte-Aktionen. Bewusst KEIN Dateisystem, kein Desktop, keine Shell. Neue Aktionen nur hier (deny by default).
export const DEVICE_ACTIONS = Object.freeze({
  "device.ping": Object.freeze({ label: "Erreichbarkeit prüfen" }),
  "device.status": Object.freeze({ label: "Agent-Status (Version, Plattform, Laufzeit)" }),
});

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
  return { ok: true };
}

const online = (d, now) => !!d.last_seen_at && d.status === "active" && +now - Date.parse(d.last_seen_at) < ONLINE_MS;
// Sicht des Eigentümers – Whitelist: nie credential_hash, nie Identitäts-Fingerprint, keine IP.
export function publicDevice(d, now = new Date()) {
  return { device_id: d.device_id, owner_user_id: d.owner_user_id, device_type: d.device_type, device_name: d.device_name, created_at: d.created_at,
    last_seen_at: d.last_seen_at || null, status: d.status, online: online(d, now) };
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
export function deviceStoreFrom(makeKeyStore) {
  return { devices: makeKeyStore("devices"), pairings: makeKeyStore("pairings"), sessions: makeKeyStore("sessions"), commands: makeKeyStore("commands"), audit: makeKeyStore("audit") };
}
export async function netlifyDeviceStore() {
  const { getStore } = await import("@netlify/blobs");
  const blobs = getStore({ name: "jarvis-devices", consistency: "strong" });
  return deviceStoreFrom((k) => netlifyBlobStore(blobs, k));
}

export { OWNER_ID };
