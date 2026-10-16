// Jarvis Geräte-Agent (TF-073/TF-074) – läuft auf dem eigenen PC/Telefon eines Benutzers und verbindet sich NUR AUSGEHEND per HTTPS mit der
// Jarvis-Cloud (/api/devices/channel). Kein offener Port, kein RDP/SSH/VNC/SMB, keine lokale Admin-Oberfläche, kein Mesh, keine Peers.
//
//   node device-agent.js --pair-stdin --name "Chris PC" --type desktop    Einmal-Code aus dem eigenen Dashboard per stdin einlösen
//   node device-agent.js --pair <CODE> --name "Chris PC" --type desktop   (Code als Argument – nur wenn stdin nicht geht)
//   node device-agent.js --status                                          gekoppelt? (Gerät, Konto, Typ, Schutz – nie das Credential)
//   node device-agent.js                                                   Befehle abholen (Schleife, alle 20 s)
//
// Identität: zufällige, lokal erzeugte Geräte-Identität (nur ihr SHA-256 geht an die Cloud). Credential: vom Server je Gerät ausgegeben,
// liegt nur im Geräte-Tresor .secrets/device/ (device-vault.js: Windows DPAPI, gitignored) und wird nie ausgegeben oder geloggt.
// Ausgeführt werden nur DEVICE_ACTIONS des eigenen Gerätetyps – und nur, wenn der Befehl vom Eigentümer dieses Geräts stammt
// (zweite Prüfung zusätzlich zur Cloud). Keine Shell, kein exec(command), keine Pfade von aussen.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEVICE_ACTIONS, DEVICE_HEADER, DEVICE_FP_HEADER, DEVICE_CV_HEADER, PAIRING_FLOW, actionSupported, normalizeDeviceType } from "./device-core.js";
import { createVault } from "./device-vault.js";
import { readWorkspaceFile, projectStatusSummary } from "./device-workspace.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEVICE_DIR = path.join(process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets"), "device");
export const AGENT_VERSION = "tf073-1";
export const AGENT_BUILD = "tf074-1";

// Nur HTTPS nach aussen (http nur für 127.0.0.1/localhost in Tests).
export function assertOutbound(base) {
  const u = new URL(base);
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)) return u.origin;
  throw Object.assign(new Error("Nur HTTPS zur Jarvis-Cloud erlaubt."), { code: "NOT_HTTPS" });
}

export function loadIdentity(dir = DEVICE_DIR) {
  const v = createVault({ dir });
  let id = v.read("identity");
  if (!id?.key) { id = { key: crypto.randomBytes(32).toString("base64url"), created_at: new Date().toISOString() }; v.write("identity", id); }
  return { fp: crypto.createHash("sha256").update(id.key).digest("hex") };
}
export const loadCredential = (dir = DEVICE_DIR) => createVault({ dir }).read("credential");
const saveCredential = (dir, c) => createVault({ dir }).write("credential", c);
const headersOf = (c, fp) => ({ [DEVICE_HEADER]: c.credential, [DEVICE_FP_HEADER]: fp, [DEVICE_CV_HEADER]: String(c.credential_version || 1) });

async function post(fetchImpl, url, body, headers = {}) {
  const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export async function pairDevice({ cloud, code, name, type = "pc", dir = DEVICE_DIR, fetchImpl = fetch }) {
  const origin = assertOutbound(cloud), { fp } = loadIdentity(dir);
  const device_type = normalizeDeviceType(type);
  if (!device_type) return { ok: false, status: 400, code: "BAD_DEVICE" };
  const r = await post(fetchImpl, `${origin}/api/devices/pair/complete`, { flow: PAIRING_FLOW, pairing_code: code, device_fp: fp, device_name: name, device_type });
  if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code || null };
  saveCredential(dir, { cloud: origin, device_id: r.body.device_id, owner_user_id: r.body.owner_user_id, device_type: r.body.device_type || device_type,
    credential_version: r.body.credential_version || 1, credential: r.body.device_credential, paired_at: new Date().toISOString() });
  return { ok: true, device_id: r.body.device_id, owner_user_id: r.body.owner_user_id, device_type: r.body.device_type || device_type };
}

// Lokaler Status – ohne Credential, ohne Fingerprint.
export function deviceStatus(dir = DEVICE_DIR) {
  const v = createVault({ dir });
  if (!v.exists("credential")) return { paired: false, code: "DEVICE_NOT_PAIRED" };
  const c = v.read("credential");
  return { paired: !!c?.credential, device_id: c?.device_id || null, owner_user_id: c?.owner_user_id || null, device_type: c?.device_type || null,
    credential_version: c?.credential_version || 1, cloud: c?.cloud || null, protection: v.protectionInUse() };
}

const started = Date.now();
const agentStatus = () => ({ agent_version: AGENT_VERSION, agent_build: AGENT_BUILD, platform: process.platform, uptime_s: Math.round((Date.now() - started) / 1000) });
// Feste, parameterlose Fähigkeiten. ctx = { dir, credential } – Handler bekommen nie Daten aus der Cloud ausser der Aktions-ID.
export const DEFAULT_HANDLERS = Object.freeze({
  "device.ping": async () => ({ pong: true }),
  "device.status": async () => agentStatus(),
  get_agent_status: async () => agentStatus(),
  heartbeat: async () => ({ alive: true }),
  get_system_status: async () => ({ platform: process.platform, release: os.release().slice(0, 40), arch: process.arch, cpus: os.cpus().length,
    mem_used_pct: Math.round((1 - os.freemem() / os.totalmem()) * 100), os_uptime_s: Math.round(os.uptime()), node: process.version }),
  sync_jarvis_state: async () => {
    const { createLocalState, syncWithCloud } = await import("./local-state.js");
    const r = await syncWithCloud({ local: createLocalState(), force: true });
    return { synced: r.ok === true, auth: r.auth || null, skipped: r.skipped || null };
  },
  read_jarvis_project_status: async () => {
    const f = readWorkspaceFile("project_state");
    if (!f.ok) return { readable: false, code: f.code };
    return { readable: true, bytes: f.bytes, ...projectStatusSummary(f.text) };
  },
  run_predefined_jarvis_health_check: async () => {
    const port = Number(process.env.PORT) || 3000;
    const core = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
    const { createLocalState } = await import("./local-state.js");
    const st = createLocalState().read().syncStatus || {};
    const ageMin = st.lastSuccessAt ? Math.round((Date.now() - Date.parse(st.lastSuccessAt)) / 60_000) : null;
    return { local_core_ok: core, sync_ok: st.ok === true, sync_age_min: ageMin, sync_auth: st.auth || null, project_state_readable: readWorkspaceFile("project_state").ok,
      node_ok: Number(process.versions.node.split(".")[0]) >= 18, agent_build: AGENT_BUILD };
  },
});

// Ein Abhol-Durchgang: Befehle holen, nur erlaubte + eigene + zum Gerätetyp passende ausführen, Ergebnis melden.
export async function pollOnce({ dir = DEVICE_DIR, fetchImpl = fetch, handlers = DEFAULT_HANDLERS } = {}) {
  const c = loadCredential(dir);
  if (!c?.credential) return { ok: false, code: "DEVICE_NOT_PAIRED" };
  const origin = assertOutbound(c.cloud), { fp } = loadIdentity(dir);
  const h = headersOf(c, fp);
  const r = await post(fetchImpl, `${origin}/api/devices/channel`, { op: "poll" }, h);
  if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code || null };
  const type = c.device_type || r.body.device_type || "pc";
  const done = [];
  for (const cmd of r.body.commands || []) {
    const mineOk = cmd.owner_user_id === c.owner_user_id && cmd.requesting_user_id === c.owner_user_id && r.body.owner_user_id === c.owner_user_id;
    const fn = mineOk && Object.hasOwn(DEVICE_ACTIONS, cmd.action_id) && actionSupported(cmd.action_id, type) && Object.hasOwn(handlers, cmd.action_id) ? handlers[cmd.action_id] : null;
    let ok = false, result = {};
    if (fn) { try { result = await fn({ dir }); ok = true; } catch { result = { error: "failed" }; } } else result = { error: "rejected" };
    await post(fetchImpl, `${origin}/api/devices/channel`, { op: "result", command_id: cmd.command_id, ok, result }, h);
    done.push({ command_id: cmd.command_id, ok });
  }
  return { ok: true, done };
}

export async function rotateCredential({ dir = DEVICE_DIR, fetchImpl = fetch } = {}) {
  const c = loadCredential(dir);
  if (!c?.credential) return { ok: false, code: "DEVICE_NOT_PAIRED" };
  const origin = assertOutbound(c.cloud), { fp } = loadIdentity(dir);
  const r = await post(fetchImpl, `${origin}/api/devices/channel`, { op: "rotate" }, headersOf(c, fp));
  if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code || null };
  saveCredential(dir, { ...c, credential: r.body.device_credential, credential_version: r.body.credential_version || (c.credential_version || 1) + 1, rotated_at: new Date().toISOString() });
  return { ok: true, credential_version: r.body.credential_version || null };
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const has = (k) => process.argv.includes(k);
  const cloud = arg("--cloud") || process.env.JARVIS_CLOUD_URL || (process.env.JARVIS_WEB_ORIGIN || "https://chrisjarvis.netlify.app").split(",")[0].trim();
  if (has("--status")) { console.log(JSON.stringify(deviceStatus(), null, 2)); process.exit(0); }
  if (has("--pair") || has("--pair-stdin")) {
    const code = has("--pair-stdin") ? await readStdin() : arg("--pair");
    const r = await pairDevice({ cloud, code, name: arg("--name") || os.hostname(), type: arg("--type") || "desktop" });
    // Nie das Credential ausgeben – nur Gerät/Konto.
    console.log(r.ok ? `Gekoppelt: ${r.device_id} (Konto ${r.owner_user_id}, ${r.device_type === "phone" ? "PHONE" : "DESKTOP"}) – Credential liegt verschlüsselt im Geräte-Tresor.` : `Kopplung fehlgeschlagen: ${r.code || r.status}`);
    process.exit(r.ok ? 0 : 1);
  }
  for (;;) {
    const r = await pollOnce().catch((e) => ({ ok: false, code: e.code || "ERROR" }));
    if (!r.ok && ["DEVICE_NOT_PAIRED", "DEVICE_REVOKED", "DEVICE_DISABLED", "DEVICE_UNAUTHORIZED", "NOT_HTTPS", "ACCOUNT_DISABLED"].includes(r.code)) { console.log(`Agent beendet: ${r.code}`); process.exit(1); }
    await new Promise((res) => setTimeout(res, 20_000));
  }
}
