// Restore eines verschlüsselten State-Backups (siehe docs/DISASTER_RECOVERY.md). Schreibt NUR in ein neues/leeres Verzeichnis –
// bestehender Zustand (lokal oder auf dem VPS) wird nie überschrieben. Gibt keine Inhalte aus, nur Dateinamen und Prüfergebnisse.
//
//   node scripts/restore-state.mjs --list                               Offsite-Backups auflisten
//   node scripts/restore-state.mjs --verify [--date 2026-10-07]         Herunterladen + ohne Schlüssel prüfen
//   node scripts/restore-state.mjs --date 2026-10-07 --out restore-dir  Entschlüsseln + prüfen + nach restore-dir schreiben
//   node scripts/restore-state.mjs --file state-….json --out restore-dir (lokale Backup-Datei statt Offsite)
// Zugang offsite: x-jarvis-worker aus .secrets/vps_worker.env oder JARVIS_PASSWORD (Umgebungsvariable). Private Key:
// --key <pem> oder .secrets/backup_private.pem (aus dem Passwort-Manager wiederhergestellt).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptBackup, verifyBackup, restoreTo } from "../backup.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes(n);
const origin = (process.env.JARVIS_SYNC_URL || "https://chrisjarvis.netlify.app").replace(/\/api\/state$/, "").replace(/\/+$/, "");

function authHeaders() {
  try {
    const t = fs.readFileSync(path.join(SECRETS, "vps_worker.env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("JARVIS_MAIL_WORKER_TOKEN="))?.slice(25);
    if (t) return { "x-jarvis-worker": t };
  } catch {}
  if (process.env.JARVIS_PASSWORD) return { "x-jarvis-key": process.env.JARVIS_PASSWORD };
  throw new Error("Kein Zugang: .secrets/vps_worker.env oder Umgebungsvariable JARVIS_PASSWORD nötig.");
}
async function get(q) {
  const r = await fetch(`${origin}/api/backup${q}`, { headers: authHeaders(), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const out = {};
try {
  if (has("--list")) { out.backups = (await get("")).backups; }
  else {
    let env;
    if (arg("--file")) env = JSON.parse(fs.readFileSync(arg("--file"), "utf8"));
    else {
      const list = (await get("")).backups;
      const key = arg("--date") ? `daily/${arg("--date")}` : list.at(-1);
      if (!key || !list.includes(key)) throw new Error(`Kein Backup ${key || ""} gefunden (vorhanden: ${list.length}).`);
      env = await get(`?key=${encodeURIComponent(key)}`);
      out.source = key;
    }
    out.created_at = env.created_at; out.key_id = env.key_id; out.files = env.files;
    out.verify_without_key = verifyBackup(env);
    if (!has("--verify")) {
      const dir = arg("--out");
      if (!dir) throw new Error("--out <neues Verzeichnis> fehlt.");
      const pem = fs.readFileSync(arg("--key") || path.join(SECRETS, "backup_private.pem"), "utf8");
      out.restored = restoreTo(decryptBackup(env, pem), path.resolve(dir));
      out.out = path.resolve(dir);
    }
  }
  console.log(JSON.stringify({ ok: true, ...out }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message, ...out }, null, 2));
  process.exit(1);
}
