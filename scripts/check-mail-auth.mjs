// Prüft, wer in der Cloud send_authority hat und ob der VPS-Worker-Token akzeptiert wird – nur lesend (GET /api/mail-requests),
// übernimmt keinen Auftrag, sendet nichts. Gibt NIE Token-Werte aus, nur Länge, SHA-256-Präfix und Whitespace-Status.
//
//   node scripts/check-mail-auth.mjs
//
// Erwartung Windows aktiv:  windows → 200, authority { dedicated: false, self: true };  vps → 401
// Erwartung VPS aktiv:      windows → 200, authority { dedicated: true, self: false };  vps → 200, authority.self = true
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncConfig } from "../local-state.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
const cfg = syncConfig();
const url = cfg.url.replace(/\/api\/state$/, "") + "/api/mail-requests";
let worker = "";
try { worker = fs.readFileSync(path.join(SECRETS, "vps_worker.env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("JARVIS_MAIL_WORKER_TOKEN="))?.slice(25) ?? ""; } catch {}
const describe = (v) => v ? { length: v.length, sha256_12: crypto.createHash("sha256").update(v).digest("hex").slice(0, 12),
  whitespace: /^\s|\s$/.test(v) ? "am Rand" : /\s/.test(v) ? "innen" : "keiner", quotes: /^["']|["']$/.test(v) } : null;
async function probe(headers) {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, authority: j.authority || null, pending: Array.isArray(j.requests) ? j.requests.length : null };
  } catch (e) { return { error: e.message }; }
}
console.log(JSON.stringify({
  endpoint: url,
  windows_sync: cfg.token ? await probe({ "x-jarvis-sync": cfg.token }) : "kein JARVIS_SYNC_TOKEN",
  vps_worker: worker ? await probe({ "x-jarvis-worker": worker }) : "kein .secrets/vps_worker.env",
  vps_worker_token_local: describe(worker),
}, null, 2));
