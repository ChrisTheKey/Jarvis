// Zahlungsabgleich auf dem VPS (TF-068) – verbindet payment-monitor.js (Adapter/Abgleich) mit dem Zahlungsbuch payments.js.
// Nur Chris (CLI im Repair-/Mail-Container). Keine Bank-Zugangsdaten, kein E-Banking-Login, kein Scraping.
//
//   node payment-reconcile.js status                   Überwachungsstatus, verarbeitete Transaktionen, offene Prüfungen
//   node payment-reconcile.js import-camt <datei.xml>  von Chris aus dem E-Banking heruntergeladener camt.053-Auszug (gleiche Datei nur einmal)
//   node payment-reconcile.js pull                     verifizierte Webhook-Ereignisse von /api/payments abholen (nur mit konfiguriertem Provider)
//   node payment-reconcile.js reviews                  offene PAYMENT_REVIEW_REQUIRED-Einträge
// Verbuchte Zahlungen laufen über recordPayment (Auftrag + Währung + Referenz-Duplikatschutz). Erreicht ein Auftrag dadurch die
// Zahlungsschwelle, starten die bestehenden Gates (TF-066 Onboarding, Check/Repair) wie bei jeder Zahlung – genau einmal.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordPayment, findPayableOrder } from "./payments.js";
import { MONITOR_FILE, emptyMonitorState, reconcileTransaction, parseCamt053, monitorStatus } from "./payment-monitor.js";

export function reconcileAll(store, txs, { now = new Date() } = {}) {
  const state = { ...emptyMonitorState(), ...store.read(MONITOR_FILE, emptyMonitorState()) };
  const results = txs.map((tx) => ({ key: tx?.provider && tx?.transaction_id ? `${tx.provider}:${tx.transaction_id}` : null,
    ...reconcileTransaction(state, tx, { now, findOrder: (id) => findPayableOrder(store, id), record: (x) => recordPayment(store, { ...x, now }) }) }));
  store.write(MONITOR_FILE, state);
  return results;
}
// Kontoauszug: dieselbe Datei (SHA-256) wird nie zweimal importiert; jede Gutschrift zusätzlich je Transaktions-ID dedupliziert.
export function importCamt(store, xml, { now = new Date() } = {}) {
  const sha = crypto.createHash("sha256").update(xml).digest("hex");
  const state = { ...emptyMonitorState(), ...store.read(MONITOR_FILE, emptyMonitorState()) };
  if (state.imports?.[sha]) return { duplicate_file: true, results: [] };
  const results = reconcileAll(store, parseCamt053(xml), { now });
  const after = store.read(MONITOR_FILE, emptyMonitorState());
  after.imports = { ...(after.imports || {}), [sha]: { at: now.toISOString(), entries: results.length } };
  store.write(MONITOR_FILE, after);
  return { duplicate_file: false, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { WORKER_DIR, createStore } = await import("./mail-worker.js");
  const store = createStore(WORKER_DIR);
  const [cmd, arg] = process.argv.slice(2);
  const env = (k) => process.env[k];
  const sum = (rs) => Object.fromEntries(["BOOKED", "DUPLICATE", "PAYMENT_REVIEW_REQUIRED", "IGNORED"].map((k) => [k, rs.filter((r) => r.result === k).length]));
  try {
    if (cmd === "status") {
      const s = store.read(MONITOR_FILE, emptyMonitorState());
      console.log(JSON.stringify({ monitor: monitorStatus(env), processed: Object.keys(s.processed || {}).length, open_reviews: (s.reviews || []).filter((r) => r.status === "OPEN").length, imports: Object.keys(s.imports || {}).length }, null, 2));
    } else if (cmd === "import-camt") {
      if (!arg) throw new Error("Datei fehlt: import-camt <datei.xml>");
      const r = importCamt(store, fs.readFileSync(arg, "utf8"));
      console.log(r.duplicate_file ? "Diese Datei wurde bereits importiert – nichts verbucht." : JSON.stringify({ entries: r.results.length, ...sum(r.results) }));
    } else if (cmd === "pull") {
      const ms = monitorStatus(env);
      if (ms.status !== "CONFIGURED" || ms.kind !== "signed_webhook") throw new Error("PAYMENT_MONITOR_NOT_CONFIGURED – kein signierter Webhook-Provider konfiguriert.");
      const base = String(env("JARVIS_CLOUD_URL") || "").replace(/\/+$/, ""), token = env("JARVIS_MAIL_WORKER_TOKEN");
      const call = async (body) => { const r = await fetch(`${base}/api/payments`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-worker": token }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`api ${r.status}`); return r.json(); };
      const { events } = await call({ op: "inbox.pull" });
      const results = reconcileAll(store, events.map((e) => e.tx));
      await call({ op: "inbox.ack", keys: events.map((e) => e.key) });
      console.log(JSON.stringify({ events: events.length, ...sum(results) }));
    } else if (cmd === "reviews") {
      console.log(JSON.stringify((store.read(MONITOR_FILE, emptyMonitorState()).reviews || []).filter((r) => r.status === "OPEN"), null, 2));
    } else { console.log("Befehle: status | import-camt <datei.xml> | pull | reviews"); process.exit(1); }
  } catch (e) { console.error("Fehler: " + e.message); process.exit(1); }
}
