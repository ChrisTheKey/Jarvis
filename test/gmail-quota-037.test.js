// GMAIL INCREMENTAL SYNC + QUOTA-SAFE WORKER (037): kein Vollscan aller Threads/Entwürfe je Tick mehr. Budget je Durchlauf,
// persistente Round-Robin-Cursor, History-API-Priorität, 429/Quota → DEGRADED statt Tick-Abbruch (Heartbeat-Stats laufen weiter),
// Draft-Queue verliert nie etwas, Foreign-Gmail-Schutz unverändert, 0 Send-Events. Keine echte Mail, kein echtes Netz.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, DEFAULT_CONFIG } from "../mail-worker.js";

const T0 = new Date("2026-10-12T08:00:00Z");
let dir, g, clock;

// Schlanke Gmail-Attrappe: zählt jeden Aufruf; Threads kommen aus reg.sent (wie im echten Register).
function fakeGmail() {
  const calls = [];
  const reg = { labelId: "L1", drafts: {}, sent: {}, sending: {} };
  const threads = {};
  const api = {
    calls, reg, threads,
    listOwned: () => structuredClone(reg),
    readThread: async (id) => {
      calls.push("read " + id);
      if (api.failOn && api.failOn(id)) throw new Error(`Gmail GET /threads/${id}?format=full: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'.`);
      return { threadId: id, messages: threads[id] || [{ messageId: "s-" + id, from: "chris@x.ch", to: "kunde@firma.ch", subject: "Ihre Website", body: "Hallo", sent: true, draft: false, internalDate: +T0 - 3600e3 }] };
    },
    replyToThread: async (id, { body }) => { calls.push("reply " + id); return { draftId: "dr-" + id, threadId: id, messageId: "m-" + id }; },
    createDraft: async (x) => {
      calls.push("draft " + x.to);
      if (api.draftFails) throw new Error("Gmail POST /drafts: 429 rateLimitExceeded");
      const id = "dr" + calls.length;
      reg.drafts[id] = { threadId: "t-" + id, messageId: "m-" + id, to: x.to, mode: x.mode };
      return { draftId: id, threadId: "t-" + id, messageId: "m-" + id };
    },
    updateDraft: async () => ({}), deleteDraft: async () => ({}), markDraftForReview: async () => {},
    sendDraft: async (id) => { calls.push("SEND " + id); return {}; },
    syncColdDrafts: async ({ max } = {}) => { calls.push("coldsync max=" + max); return []; },
  };
  return api;
}
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const readState = () => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", reason: "", subject: "Re", body: "Gerne." }) });
const manyThreads = (n) => { for (let i = 0; i < n; i++) { const id = "t" + String(i).padStart(3, "0"); g.reg.sent["s-" + id] = { messageId: "s-" + id, threadId: id, to: `k${i}@firma.ch`, subject: "Ihre Website", sentAt: new Date(+T0 - 3600e3).toISOString() }; } };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-quota37-"));
  g = fakeGmail();
  clock = T0;
  write("config.json", { dryRun: false, offer: "Ich prüfe Websites.", sender: { name: "Chris", signature: "Chris" } });
});

test("Defaults: Budget je Tick dokumentiert und aktiv", () => {
  assert.equal(DEFAULT_CONFIG.maxThreadReadsPerTick, 20);
  assert.equal(DEFAULT_CONFIG.maxColdDraftChecksPerTick, 40);
});

test("507 bekannte Threads → KEIN Vollscan: genau Budget-Reads je Tick, Cursor schreitet, überlebt Neustart", async () => {
  manyThreads(507);
  await worker().tick();
  const first = g.calls.filter((c) => c.startsWith("read "));
  assert.equal(first.length, 20);
  assert.equal(readState().threadScanCursor, first.at(-1).slice(5));
  await worker().tick();
  const second = g.calls.filter((c) => c.startsWith("read ")).slice(20);
  assert.equal(second.length, 20);
  assert.deepEqual([...new Set(first.concat(second))].length, 40, "keine Doppel-Reads – der Cursor schreitet weiter");
  // „Neustart“: neue Worker-Instanz auf demselben Verzeichnis liest den Cursor aus state.json.
  const w2 = createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", body: "x" }) });
  await w2.tick();
  const third = g.calls.filter((c) => c.startsWith("read ")).slice(40);
  assert.equal(third.length, 20);
  assert.equal(new Set(first.concat(second, third)).size, 60);
  // Cold-Sync bekommt das Budget übergeben.
  assert.ok(g.calls.some((c) => c === "coldsync max=40"));
});

test("History-Sync: geänderte eigene Threads haben Vorrang; historyId rückt nur nach vollständigem Prio-Scan vor; fremde Threads nie gelesen", async () => {
  manyThreads(100);
  const saved = [];
  let syncState = { history_id: "H1" };
  g.changedThreadIds = async ({ sinceHistoryId }) => { g.calls.push("history " + sinceHistoryId); return { threadIds: ["t099", "fremd1"], historyId: "H2" }; };
  g.loadSyncState = () => syncState;
  g.saveSyncState = (p) => { saved.push(p); syncState = { ...syncState, ...p }; return syncState; };
  await worker().tick();
  const reads = g.calls.filter((c) => c.startsWith("read "));
  assert.equal(reads[0], "read t099", "geänderter Thread zuerst");
  assert.ok(!g.calls.includes("read fremd1"), "fremder Thread aus der History wird NIE gelesen (Foreign-Gmail-Schutz)");
  assert.equal(reads.length, 20);
  assert.equal(saved.at(-1).history_id, "H2", "historyId nach erfolgreichem Prio-Scan vorgerückt");
});

test("Ungültige historyId → kontrollierter Recovery-Pfad (frische historyId, Round-Robin, kein Vollscan, kein Absturz)", async () => {
  manyThreads(100);
  const saved = [];
  g.changedThreadIds = async () => ({ threadIds: [], historyId: "H9", invalid: true });
  g.loadSyncState = () => ({ history_id: "ALT" });
  g.saveSyncState = (p) => { saved.push(p); };
  const r = await worker().tick();
  assert.ok(!r.error);
  assert.equal(g.calls.filter((c) => c.startsWith("read ")).length, 20);
  assert.equal(saved.at(-1).history_id, "H9");
});

test("Quota-Fehler im Reply-Scan → Mail DEGRADED, Tick läuft weiter, Heartbeat-Stats vorhanden, kein Backoff-Livelock, Cursor bleibt", async () => {
  manyThreads(50);
  g.failOn = (id) => id === "t005"; // der 6. Read scheitert an der Minuten-Quota
  const r = await worker().tick();
  assert.ok(!r.error, "Tick bricht nicht mehr ab");
  assert.equal(r.gmail.status, "DEGRADED");
  assert.equal(r.gmail.stage, "reply_scan");
  assert.equal(r.stats.mail_degraded, 1, "Heartbeat-Stats fliessen trotz Gmail-Fehler");
  assert.equal(typeof r.stats.sent_today, "number");
  const s = readState();
  assert.equal(s.failures || 0, 0, "kein tick_failed-Backoff mehr wegen Gmail-Quota");
  assert.equal(s.threadScanCursor, "t004", "Cursor steht auf dem letzten erfolgreich gelesenen Thread");
  // Erholung: nächster Tick ohne Fehler → OK, macht hinter dem Cursor weiter (kein Neubeginn bei t000).
  g.failOn = null;
  const r2 = await worker().tick();
  assert.equal(r2.gmail.status, "OK");
  assert.equal(r2.stats.mail_degraded, 0);
  const after = g.calls.filter((c) => c.startsWith("read ")).slice(6);
  assert.equal(after[0], "read t005");
});

test("Gmail degraded → Draft-Queue verliert nichts (Backoff persistiert, Eintrag bleibt queued), kein Send-Event", async () => {
  write("individual_reviews.json", { reviews: { "muster.ch": { status: "queued", draft_mode: "COLD_LEAD_DRAFT_ONLY", recipient: "info@muster.ch", domain: "muster.ch", company: "Muster AG", subject: "Hinweis", body: "Text", created_at: T0.toISOString() } } });
  g.draftFails = true;
  const r = await worker().tick();
  assert.ok(!r.error);
  assert.equal(r.gmail.status, "DEGRADED");
  const cold = JSON.parse(fs.readFileSync(path.join(dir, "individual_reviews.json"), "utf8"));
  assert.equal(cold.reviews["muster.ch"].status, "queued", "Eintrag bleibt vollständig erhalten");
  assert.ok(cold.draft_worker.backoffUntil, "Draft-Worker-Backoff persistiert");
  // Gmail wieder da → Entwurf entsteht, Queue-Eintrag wird draft_created.
  g.draftFails = false;
  clock = new Date(+T0 + 61 * 60_000); // nach dem Backoff
  await worker().tick();
  const cold2 = JSON.parse(fs.readFileSync(path.join(dir, "individual_reviews.json"), "utf8"));
  assert.equal(cold2.reviews["muster.ch"].status, "draft_created");
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0, "0 Send-Events");
});

test("Reply-Erkennung weiterhin korrekt und ohne Duplikate (state.handled)", async () => {
  g.reg.sent["s-t1"] = { messageId: "s-t1", threadId: "t1", to: "kunde@firma.ch", subject: "Ihre Website", sentAt: new Date(+T0 - 24 * 3600e3).toISOString() };
  g.threads.t1 = [
    { messageId: "s-t1", from: "chris@x.ch", to: "kunde@firma.ch", subject: "Ihre Website", body: "Hallo", sent: true, draft: false, internalDate: +T0 - 24 * 3600e3 },
    { messageId: "in-t1", from: "Anna <kunde@firma.ch>", replyTo: "", to: "chris@x.ch", subject: "Re: Ihre Website", body: "Wie weiter?", sent: false, draft: false, internalDate: +T0 - 3600e3 },
  ];
  await worker().tick();
  assert.equal(g.calls.filter((c) => c === "reply t1").length, 1, "genau ein Antwort-Entwurf");
  await worker().tick();
  assert.equal(g.calls.filter((c) => c === "reply t1").length, 1, "keine Duplicate Replies im zweiten Durchlauf");
});

test("Discovery- und Repair-Status bleiben von Gmail-Degradierung unberührt (eigene Module, kein Gmail-Pfad)", async () => {
  // Discovery/Repair laufen in eigenen Modulen nach der Iteration – hier genügt der Beweis, dass ein degradierter Tick
  // ein normales Ergebnis-Objekt liefert (loop() ruft Discovery/Repair unabhängig von r.gmail auf, siehe mail-worker loop()).
  manyThreads(5);
  g.failOn = () => true;
  const r = await worker().tick();
  assert.ok(r.stats && !r.error, "Ergebnis mit Stats → loop() fährt mit Discovery/Repair/Sync fort");
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "mail-worker.js"), "utf8");
  const loopPart = src.slice(src.indexOf("async function loop()"));
  assert.ok(loopPart.includes("runDiscovery") && loopPart.includes("runRepairOrders"), "Discovery + Repair hängen am Loop, nicht am Gmail-Erfolg");
});
