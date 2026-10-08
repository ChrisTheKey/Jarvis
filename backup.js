// Disaster Recovery: verschlüsseltes, versioniertes Backup des Operational State (nicht der Secrets).
// - Inhalt: mail_worker/*.json (ohne Logs/Locks/Temp), gmail_jarvis.json (Register), shared_state.json. NIE gmail_token.json,
//   gmail_credentials.json, .env oder andere Secrets – die stellt Chris nach docs/DISASTER_RECOVERY.md wieder her.
// - Verschlüsselung: zufälliger AES-256-GCM-Schlüssel je Backup, verpackt mit dem RSA-Public-Key (OAEP/SHA-256) aus
//   deploy/vps/backup-public.pem. Den Private Key hat nur Chris (Passwort-Manager) – der VPS kann seine Backups nicht lesen.
// - Integrität: GCM-Tag + SHA-256 des Klartexts (mit Schlüssel) und SHA-256 des Chiffrats (ohne Schlüssel prüfbar).
// - Rotation: lokal BACKUP_KEEP Generationen; offsite (Netlify Blobs) über /api/backup mit dem Worker-Token.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const BACKUP_FORMAT = "jarvis-state-backup";
export const BACKUP_VERSION = 1;
export const BACKUP_KEEP = 14;
export const BACKUP_STATUS_FILE = "backup_status.json";
const SECRET_NAMES = /^(gmail_token|gmail_credentials|vps_worker|backup_private|jarvis_sync)|\.env$|\.pem$|\.key$/i;
const SKIP = /(^|\/)(worker\.log|worker\.lock|.*\.tmp|.*\.lock)$/;

// Welche Dateien gehören zum Operational State? Relativ zu secretsDir, nie Secrets, nie Backups selbst.
export function stateFiles(secretsDir) {
  const out = [];
  const mw = path.join(secretsDir, "mail_worker");
  try { for (const f of fs.readdirSync(mw)) if (f.endsWith(".json") && !SKIP.test(f) && !SECRET_NAMES.test(f)) out.push(`mail_worker/${f}`); } catch {}
  for (const f of ["gmail_jarvis.json", "shared_state.json"]) if (fs.existsSync(path.join(secretsDir, f))) out.push(f);
  return out.sort();
}

export const keyId = (publicKeyPem) => crypto.createHash("sha256").update(crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

export function createBackup({ secretsDir, publicKeyPem, now = new Date() }) {
  const files = stateFiles(secretsDir);
  if (files.some((f) => SECRET_NAMES.test(path.basename(f)))) throw new Error("Secret im Backup-Umfang – Abbruch.");
  const payload = { format: BACKUP_FORMAT, v: BACKUP_VERSION, created_at: now.toISOString(), files: Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(secretsDir, f), "utf8")])) };
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const wrapped = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return {
    format: BACKUP_FORMAT, v: BACKUP_VERSION, alg: "RSA-OAEP-256+A256GCM", key_id: keyId(publicKeyPem), created_at: payload.created_at,
    files: files, plaintext_sha256: sha(plain), ciphertext_sha256: sha(ct),
    wrapped_key: wrapped.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ciphertext: ct.toString("base64"),
  };
}

// Ohne Schlüssel: Format und Chiffrat-Prüfsumme.
export function verifyBackup(env) {
  if (env?.format !== BACKUP_FORMAT || env.v !== BACKUP_VERSION) return { ok: false, error: "unbekanntes Format" };
  try { return sha(Buffer.from(env.ciphertext, "base64")) === env.ciphertext_sha256 ? { ok: true } : { ok: false, error: "Prüfsumme falsch" }; }
  catch { return { ok: false, error: "beschädigt" }; }
}

// Mit Private Key: entschlüsseln und vollständig prüfen. Wirft bei jeder Abweichung (fail closed).
export function decryptBackup(env, privateKeyPem) {
  const v = verifyBackup(env);
  if (!v.ok) throw new Error(`Backup ungültig: ${v.error}`);
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(env.wrapped_key, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv, "base64"));
  d.setAuthTag(Buffer.from(env.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(env.ciphertext, "base64")), d.final()]);
  if (sha(plain) !== env.plaintext_sha256) throw new Error("Backup ungültig: Klartext-Prüfsumme falsch");
  const payload = JSON.parse(zlib.gunzipSync(plain).toString("utf8"));
  if (payload.format !== BACKUP_FORMAT) throw new Error("Backup ungültig: Inhalt");
  return payload;
}

// Entschlüsselten Stand in ein NEUES/leeres Verzeichnis schreiben – nie über bestehenden Zustand.
export function restoreTo(payload, outDir) {
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`Ziel ${outDir} ist nicht leer – Restore überschreibt nie bestehenden Zustand.`);
  for (const [f, text] of Object.entries(payload.files)) {
    if (f.includes("..") || path.isAbsolute(f) || SECRET_NAMES.test(path.basename(f))) throw new Error(`Unzulässiger Pfad im Backup: ${f}`);
    const p = path.join(outDir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, text, { mode: 0o600 });
  }
  return Object.keys(payload.files);
}

export const backupName = (createdAt) => `state-${createdAt.replace(/[:.]/g, "").replace(/-/g, "")}.json`;

// Lokal ablegen + rotieren. Liefert den Dateinamen.
export function storeLocal(env, backupDir, keep = BACKUP_KEEP) {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const name = backupName(env.created_at), file = path.join(backupDir, name), tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
  fs.renameSync(tmp, file);
  const all = fs.readdirSync(backupDir).filter((f) => /^state-.*\.json$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(backupDir, old), { force: true });
  return { name, generations: Math.min(all.length, keep) };
}

// Einmal je Zürcher Tag (ab 03:00), lokal + offsite. Fehler offsite → ok=false im Status, lokales Backup bleibt.
export async function dailyBackup({ secretsDir, workerDir, publicKeyPem, now = new Date(), zurichDay, upload = null, log = () => {} }) {
  const statusFile = path.join(workerDir, BACKUP_STATUS_FILE);
  let st = {};
  try { st = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
  const day = zurichDay(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", hourCycle: "h23" }).format(now));
  const write = (next) => { const tmp = `${statusFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(tmp, statusFile); return next; };
  // Offsite fehlgeschlagen: dasselbe lokale Backup höchstens stündlich erneut hochladen (kein neues Backup, keine Schleife).
  if (st.day === day && !st.ok && st.local && upload && +now - Date.parse(st.attempt_at || st.last_at || 0) >= 60 * 60_000) {
    let offsite;
    try { offsite = await upload(JSON.parse(fs.readFileSync(path.join(secretsDir, "backups", st.local), "utf8"))); } catch (e) { offsite = { ok: false, error: e.message }; }
    st = write({ ...st, ok: !!offsite.ok, attempt_at: now.toISOString(), offsite_error: offsite.ok ? null : String(offsite.error || "").slice(0, 120) });
    log(offsite.ok ? "info" : "warn", "state_backup_offsite_retry", { offsite: !!offsite.ok });
    return { skipped: false, retried: true, status: st };
  }
  if (st.day === day || hour < 3) return { skipped: true, status: st };
  const env = createBackup({ secretsDir, publicKeyPem, now });
  const local = storeLocal(env, path.join(secretsDir, "backups"));
  let offsite = { ok: false, error: "kein Upload konfiguriert" };
  if (upload) { try { offsite = await upload(env); } catch (e) { offsite = { ok: false, error: e.message }; } }
  st = write({ day, last_at: env.created_at, attempt_at: now.toISOString(), ok: !!offsite.ok, local: local.name, generations: local.generations, offsite_error: offsite.ok ? null : String(offsite.error || "").slice(0, 120), key_id: env.key_id, files: env.files.length });
  log(offsite.ok ? "info" : "warn", "state_backup", { local: local.name, generations: local.generations, offsite: !!offsite.ok, files: env.files.length });
  return { skipped: false, status: st };
}

// Manuell (Server Control „Backup jetzt“): sofort ein neues Backup, lokal + offsite, Status wie beim Tageslauf. Löscht nie mehr als die Rotation.
export async function backupNow({ secretsDir, workerDir, publicKeyPem, now = new Date(), zurichDay, upload = null, log = () => {} }) {
  const statusFile = path.join(workerDir, BACKUP_STATUS_FILE);
  const env = createBackup({ secretsDir, publicKeyPem, now });
  const local = storeLocal(env, path.join(secretsDir, "backups"));
  let offsite = { ok: false, error: "kein Upload konfiguriert" };
  if (upload) { try { offsite = await upload(env); } catch (e) { offsite = { ok: false, error: e.message }; } }
  const st = { day: zurichDay(now), last_at: env.created_at, attempt_at: now.toISOString(), ok: !!offsite.ok, local: local.name, generations: local.generations,
    offsite_error: offsite.ok ? null : String(offsite.error || "").slice(0, 120), key_id: env.key_id, files: env.files.length, manual: true };
  const tmp = `${statusFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 }); fs.renameSync(tmp, statusFile);
  log(offsite.ok ? "info" : "warn", "state_backup_manual", { generations: local.generations, offsite: !!offsite.ok, files: env.files.length });
  return { ok: !!offsite.ok, local_ok: true, offsite_ok: !!offsite.ok, generations: local.generations, files: env.files.length, created_at: env.created_at };
}

export function backupInfo(workerDir) {
  try { const st = JSON.parse(fs.readFileSync(path.join(workerDir, BACKUP_STATUS_FILE), "utf8")); return { last_at: st.last_at, ok: st.ok, generations: st.generations }; }
  catch { return null; }
}
