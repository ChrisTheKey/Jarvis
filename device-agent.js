// Jarvis Geräte-Agent (TF-073) – läuft auf dem eigenen PC/Telefon eines Benutzers und verbindet sich NUR AUSGEHEND per HTTPS mit der
// Jarvis-Cloud (/api/devices/channel). Kein offener Port, kein RDP/SSH/VNC/SMB, keine lokale Admin-Oberfläche, kein Mesh, keine Peers.
//
//   node device-agent.js --pair <CODE> --name "Chris PC" --type pc   Einmal-Code aus dem eigenen Dashboard einlösen
//   node device-agent.js                                              Befehle abholen (Schleife, alle 20 s)
//
// Identität: zufällige, lokal erzeugte Geräte-Identität (nur ihr SHA-256 geht an die Cloud). Credential: vom Server je Gerät ausgegeben,
// liegt nur in .secrets/device/ (gitignored, Dateirechte 600). Ausgeführt werden nur DEVICE_ACTIONS – und nur, wenn der Befehl vom
// Eigentümer dieses Geräts stammt (zweite Prüfung zusätzlich zur Cloud).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DEVICE_ACTIONS, DEVICE_HEADER, DEVICE_FP_HEADER, PAIRING_FLOW } from "./device-core.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DEVICE_DIR = path.join(process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets"), "device");
export const AGENT_VERSION = "tf073-1";

// Nur HTTPS nach aussen (http nur für 127.0.0.1/localhost in Tests).
export function assertOutbound(base) {
  const u = new URL(base);
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)) return u.origin;
  throw Object.assign(new Error("Nur HTTPS zur Jarvis-Cloud erlaubt."), { code: "NOT_HTTPS" });
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writeSecret(f, data) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 }); }

export function loadIdentity(dir = DEVICE_DIR) {
  const f = path.join(dir, "identity.json");
  let id = readJson(f);
  if (!id?.key) { id = { key: crypto.randomBytes(32).toString("base64url"), created_at: new Date().toISOString() }; writeSecret(f, id); }
  return { fp: crypto.createHash("sha256").update(id.key).digest("hex") };
}
export const loadCredential = (dir = DEVICE_DIR) => readJson(path.join(dir, "credential.json"));

async function post(fetchImpl, url, body, headers = {}) {
  const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export async function pairDevice({ cloud, code, name, type = "pc", dir = DEVICE_DIR, fetchImpl = fetch }) {
  const origin = assertOutbound(cloud), { fp } = loadIdentity(dir);
  const r = await post(fetchImpl, `${origin}/api/devices/pair/complete`, { flow: PAIRING_FLOW, pairing_code: code, device_fp: fp, device_name: name, device_type: type });
  if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code || null };
  writeSecret(path.join(dir, "credential.json"), { cloud: origin, device_id: r.body.device_id, owner_user_id: r.body.owner_user_id, credential: r.body.device_credential });
  return { ok: true, device_id: r.body.device_id, owner_user_id: r.body.owner_user_id };
}

const started = Date.now();
export const DEFAULT_HANDLERS = Object.freeze({
  "device.ping": async () => ({ pong: true }),
  "device.status": async () => ({ agent_version: AGENT_VERSION, platform: process.platform, uptime_s: Math.round((Date.now() - started) / 1000) }),
});

// Ein Abhol-Durchgang: Befehle holen, nur erlaubte + eigene ausführen, Ergebnis melden.
export async function pollOnce({ dir = DEVICE_DIR, fetchImpl = fetch, handlers = DEFAULT_HANDLERS } = {}) {
  const c = loadCredential(dir);
  if (!c?.credential) return { ok: false, code: "DEVICE_NOT_PAIRED" };
  const origin = assertOutbound(c.cloud), { fp } = loadIdentity(dir);
  const h = { [DEVICE_HEADER]: c.credential, [DEVICE_FP_HEADER]: fp };
  const r = await post(fetchImpl, `${origin}/api/devices/channel`, { op: "poll" }, h);
  if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code || null };
  const done = [];
  for (const cmd of r.body.commands || []) {
    const mineOk = cmd.owner_user_id === c.owner_user_id && cmd.requesting_user_id === c.owner_user_id && r.body.owner_user_id === c.owner_user_id;
    const fn = mineOk && Object.hasOwn(DEVICE_ACTIONS, cmd.action_id) ? handlers[cmd.action_id] : null;
    let ok = false, result = {};
    if (fn) { try { result = await fn(); ok = true; } catch { result = { error: "failed" }; } } else result = { error: "rejected" };
    await post(fetchImpl, `${origin}/api/devices/channel`, { op: "result", command_id: cmd.command_id, ok, result }, h);
    done.push({ command_id: cmd.command_id, ok });
  }
  return { ok: true, done };
}

export async function rotateCredential({ dir = DEVICE_DIR, fetchImpl = fetch } = {}) {
  const c = loadCredential(dir);
  if (!c?.credential) return { ok: false, code: "DEVICE_NOT_PAIRED" };
  const origin = assertOutbound(c.cloud), { fp } = loadIdentity(dir);
  const r = await post(fetchImpl, `${origin}/api/devices/channel`, { op: "rotate" }, { [DEVICE_HEADER]: c.credential, [DEVICE_FP_HEADER]: fp });
  if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code || null };
  writeSecret(path.join(dir, "credential.json"), { ...c, credential: r.body.device_credential });
  return { ok: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const cloud = arg("--cloud") || process.env.JARVIS_CLOUD_URL;
  if (arg("--pair")) {
    const r = await pairDevice({ cloud, code: arg("--pair"), name: arg("--name") || os.hostname(), type: arg("--type") || "pc" });
    console.log(r.ok ? `Gekoppelt: ${r.device_id} (Konto ${r.owner_user_id})` : `Kopplung fehlgeschlagen: ${r.code || r.status}`);
    process.exit(r.ok ? 0 : 1);
  }
  for (;;) {
    const r = await pollOnce().catch((e) => ({ ok: false, code: e.code || "ERROR" }));
    if (!r.ok && ["DEVICE_NOT_PAIRED", "DEVICE_REVOKED", "DEVICE_DISABLED", "DEVICE_UNAUTHORIZED", "NOT_HTTPS"].includes(r.code)) { console.log(`Agent beendet: ${r.code}`); process.exit(1); }
    await new Promise((res) => setTimeout(res, 20_000));
  }
}
