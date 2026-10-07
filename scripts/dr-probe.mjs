// Disaster-Recovery-Probe (nur lesend): Wie sieht der Cloud-Jarvis OHNE den PC aus? Nutzt nur Cloud-Endpunkte mit der Cloud-Core-
// Credential (x-jarvis-worker bzw. x-jarvis-sync = Worker-Token) – kein Local Core, kein Sync-Token des PCs. Übernimmt nichts (nur GET),
// sendet nichts, gibt keine Inhalte/Adressen/Tokens aus – nur Status, Zeitpunkte und Zähler.
//   node scripts/dr-probe.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
const origin = (process.env.JARVIS_SYNC_URL || "https://chrisjarvis.netlify.app").replace(/\/api\/state$/, "").replace(/\/+$/, "");
const token = fs.readFileSync(path.join(SECRETS, "vps_worker.env"), "utf8").split(/\r?\n/).find((l) => l.startsWith("JARVIS_MAIL_WORKER_TOKEN="))?.slice(25);
if (!token) { console.log(JSON.stringify({ ok: false, error: "kein Worker-Token in .secrets/vps_worker.env" })); process.exit(1); }
const get = async (p, headers = {}) => { const r = await fetch(origin + p, { headers, signal: AbortSignal.timeout(20_000) }); return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() }; };

const ctx = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, "public", "mail-status.js"), "utf8"), ctx);
const [ui, state, mail, backups] = await Promise.all([
  get("/"), get("/api/state", { "x-jarvis-sync": token }), get("/api/mail-requests", { "x-jarvis-worker": token }), get("/api/backup", { "x-jarvis-worker": token }),
]);
const s = state.body || {}, svc = mail.body?.service || null;
const hud = ctx.JarvisMailStatus.summarizeMail({ service: svc, localMode: false, clientSeenAt: s.sync?.lastClientPushAt || null });
console.log(JSON.stringify({
  at: new Date().toISOString(),
  cloud_ui: { http: ui.status, cloud_first_hud: typeof ui.body === "string" && ui.body.includes('id="kJarvisCore"') },
  hud_cloud_mode: { system: hud.system, jarvis_core: hud.core, local_client: hud.client, mail_worker: hud.mailWorker, authority: hud.authority, windows: hud.windows, queue: hud.pending, ai: hud.ai },
  core: { http: mail.status, self: mail.body?.authority?.self ?? null, last_heartbeat: svc?.last_heartbeat || null, started_at: svc?.core?.started_at || null, schema: svc?.core?.schema_version ?? null,
    scheduler: svc?.core?.scheduler || null, discovery_last_run: svc?.core?.discovery_last_run || null, backup: svc?.core?.backup || null },
  state: { http: state.status, notifications: (s.notifications || []).length, conversation_turns: (s.conversation?.turns || []).length, sales_at: s.sales?.updatedAt || null,
    business_at: s.business?.updatedAt || null, core_push: s.sync?.lastCorePushAt || null, client_push: s.sync?.lastClientPushAt || null,
    leads: { cold: s.sales?.cold_leads_found ?? null, drafts_open: s.sales?.drafts_open ?? null, discovered: s.sales?.discovered ?? null } },
  offsite_backups: backups.status === 200 ? backups.body.backups.length : `HTTP ${backups.status}`,
}, null, 2));
