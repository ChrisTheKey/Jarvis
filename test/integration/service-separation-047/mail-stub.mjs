// Lab-Mail-Worker (TF-047) – NUR für das Separation-Lab, nie produktiv. Bildet die für den Repair-Deploy relevanten Eigenschaften
// des echten Mail-Workers nach: eigener Container im Projekt jarvis-mail-lab047, Herzschlag (worker.lock), Scheduler-Ticks im
// worker.log, Authority-Datei, Cloud-Queue-Datei – und stellt die Repair-Outbox mit dem ECHTEN processRepairOutbox zu.
// Versand = Attrappe: jede «gesendete» Mail landet als Zeile (nur Klasse + Draft-ID, keine Adresse) in /data/secrets/lab_sent.jsonl.
import fs from "node:fs";
import path from "node:path";
import { processRepairOutbox } from "../../../repair-outbox.js";

const SECRETS = process.env.JARVIS_SECRETS_DIR || "/data/secrets";
const DIR = path.join(SECRETS, "mail_worker");
const OUTBOX = process.env.JARVIS_REPAIR_OUTBOX || "/data/repair-outbox";
const SENT = path.join(SECRETS, "lab_sent.jsonl");
const beatOf = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, "worker.lock"), "utf8")).beat || 0; } catch { return 0; } };

// «npm test» führt jede Datei unter test/ aus – ohne ausdrückliches Lab-Flag passiert hier nichts.
if (process.env.JARVIS_LAB_MAIL_STUB !== "1") process.exit(0);
if (process.argv[2] === "--healthcheck") process.exit(Date.now() - beatOf() < 15_000 ? 0 : 1);

fs.mkdirSync(DIR, { recursive: true });
if (!fs.existsSync(path.join(DIR, "authority.json"))) fs.writeFileSync(path.join(DIR, "authority.json"), JSON.stringify({ holder: "vps", self: true, checkedAt: new Date().toISOString() }));
if (!fs.existsSync(path.join(DIR, "cloud_requests.json"))) fs.writeFileSync(path.join(DIR, "cloud_requests.json"), JSON.stringify({ "lab-req-1": { status: "pending" } }));
const drafts = {};
const gmail = {
  listOwned: () => ({ sent: Object.fromEntries(fs.existsSync(SENT) ? fs.readFileSync(SENT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((s) => ["m-" + s.draft_id, { fromDraft: s.draft_id }]) : []) }),
  createDraft: async (x) => { const id = "lab-dr-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8); drafts[id] = x.messageClass; return { draftId: id }; },
  sendDraft: async (id) => { fs.appendFileSync(SENT, JSON.stringify({ draft_id: id, message_class: drafts[id], at: new Date().toISOString() }) + "\n"); return { messageId: "m-" + id }; },
};
const log = (level, event, data = {}) => fs.appendFileSync(path.join(DIR, "worker.log"), JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) + "\n");
let stop = false;
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { stop = true; });
log("info", "worker_started", { pid: process.pid, role: "vps" });
while (!stop) {
  fs.writeFileSync(path.join(DIR, "worker.lock"), JSON.stringify({ pid: process.pid, beat: Date.now() }));
  log("info", "tick", {});
  try { await processRepairOutbox({ dir: OUTBOX, gmail, log }); } catch (e) { log("error", "repair_outbox_failed", { error: e.message }); }
  await new Promise((r) => setTimeout(r, 1000));
}
process.exit(0);
