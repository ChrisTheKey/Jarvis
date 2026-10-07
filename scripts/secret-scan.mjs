// Secret-Scan vor jedem Commit: prüft alle getrackten und gestagten Dateien (Index-Stand) auf
//  1) echte Secret-Werte aus .secrets/ (Gmail-Token/Credentials, Worker-/Sync-Token, Anthropic-Key, Backup-Private-Key) – per Vergleich,
//  2) typische Muster (Private-Key-Blöcke, lange sk-ant-/ya29.-Werte).
// Gibt NIE Werte aus, nur Datei + Art des Treffers. Exit 1 bei Treffer.
//   node scripts/secret-scan.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
const values = new Set();
// URLs (z. B. token_uri) sind öffentlich und keine Secrets.
const add = (v) => { if (typeof v === "string" && v.trim().length >= 16 && !/^https?:\/\//.test(v.trim())) values.add(v.trim()); };
const walk = (o) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (/token|secret|key|password|private/i.test(k)) add(v); walk(v); } };
for (const f of ["gmail_token.json", "gmail_credentials.json", "jarvis_sync.json"]) { try { walk(JSON.parse(fs.readFileSync(path.join(SECRETS, f), "utf8"))); } catch {} }
for (const f of ["vps_worker.env", "../.env"]) {
  try { for (const l of fs.readFileSync(path.join(SECRETS, f), "utf8").split(/\r?\n/)) { const i = l.indexOf("="); if (i > 0 && /TOKEN|KEY|SECRET|PASSWORD/i.test(l.slice(0, i))) add(l.slice(i + 1).replace(/^["']|["']$/g, "")); } } catch {}
}
try { const pk = fs.readFileSync(path.join(SECRETS, "backup_private.pem"), "utf8"); add(pk.split(/\r?\n/).filter((l) => l && !l.startsWith("-----")).slice(0, 3).join("")); } catch {}

const PATTERNS = [
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{30,}/],
  ["google-access-token", /ya29\.[A-Za-z0-9_-]{30,}/],
  ["google-refresh-token", /1\/\/0[A-Za-z0-9_-]{30,}/],
];
const files = execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const hits = [];
for (const f of files) {
  let text;
  try { text = execFileSync("git", ["show", `:${f}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 2 ** 20 }); } catch { continue; }
  for (const v of values) if (text.includes(v)) hits.push([f, "echter Secret-Wert aus .secrets"]);
  for (const [name, re] of PATTERNS) if (re.test(text)) hits.push([f, name]);
}
console.log(JSON.stringify({ files: files.length, known_secret_values: values.size, hits: hits.map(([f, k]) => `${f}: ${k}`) }, null, 2));
process.exit(hits.length ? 1 : 0);
