// Mail-Worker: bereitet nur Entwürfe vor, nur in eigenen Threads, mit Opt-out, Follow-up-Regeln und Tageslimit.
// Läuft ohne Netzwerk – Gmail und der Textgenerator sind Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createWorker, acquireLock, releaseLock, heartbeat, zurichDay, HARD_LIMIT } from "../mail-worker.js";

const DAY = 86_400_000;
const T0 = new Date("2026-10-06T08:00:00Z"); // 10:00 in Zürich, im Zeitfenster
let dir, g, clock, composed, composeResult;

// Gmail-Attrappe mit derselben Schnittstelle wie gmail.js
function fakeGmail() {
  const f = {
    reg: { labelId: "L", drafts: {}, sent: {} },
    threads: {}, // threadId -> Nachrichten (wie readThread sie liefert)
    calls: [], n: 0,
    listOwned: () => structuredClone(f.reg),
    async readThread(threadId) {
      f.calls.push("read " + threadId);
      if (!Object.values(f.reg.sent).some((s) => s.threadId === threadId)) throw new Error(`Thread ${threadId} wurde nicht von Jarvis begonnen – Zugriff verweigert.`);
      return { threadId, messages: structuredClone(f.threads[threadId] || []) };
    },
    async replyToThread(threadId, { body }) {
      f.calls.push("reply " + threadId);
      if (!Object.values(f.reg.sent).some((s) => s.threadId === threadId)) throw new Error("nicht von Jarvis begonnen");
      const id = "dr" + ++f.n;
      f.reg.drafts[id] = { threadId, to: "x", body, createdAt: clock.toISOString() };
      return { draftId: id, messageId: "m" + id, threadId };
    },
    async updateDraft(id, { body }) { f.calls.push("update " + id); f.reg.drafts[id].body = body; return { draftId: id, threadId: f.reg.drafts[id].threadId }; },
    async createDraft({ to, subject, body }) {
      f.calls.push("create " + to);
      const id = "dr" + ++f.n;
      f.reg.drafts[id] = { threadId: "new" + id, to, subject, body, createdAt: clock.toISOString() };
      return { draftId: id, messageId: "m" + id, threadId: "new" + id };
    },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft() { f.calls.push("SEND"); throw new Error("darf nie aufgerufen werden"); },
  };
  return f;
}

// Jarvis hat an `to` gesendet (Thread `tid`), optional mit einer Antwort von `to`.
function ownThread(tid, { to = "kunde@firma.ch", sentAt = T0, replies = [] } = {}) {
  g.reg.sent["s-" + tid] = { messageId: "s-" + tid, threadId: tid, to, subject: "Ihre Website", sentAt: sentAt.toISOString() };
  g.threads[tid] = [
    { messageId: "s-" + tid, from: "Chris <chris@x.ch>", to, subject: "Ihre Website", body: "Hallo, mir ist etwas aufgefallen.", sent: true, draft: false, internalDate: +sentAt },
    ...replies.map((r, i) => ({ messageId: `in-${tid}-${i}`, from: `Anna <${to}>`, replyTo: "", to: "chris@x.ch", subject: "Re: Ihre Website", body: r, sent: false, draft: false, internalDate: +sentAt + (i + 1) * 3600e3 })),
  ];
}
function addOwnFollowUp(tid, at) {
  g.reg.sent["f-" + tid + at] = { messageId: "f-" + tid + at, threadId: tid, to: "kunde@firma.ch", subject: "Re: Ihre Website", sentAt: new Date(at).toISOString() };
  g.threads[tid].push({ messageId: "f-" + tid + at, from: "chris@x.ch", to: "kunde@firma.ch", subject: "Re: Ihre Website", body: "Nachfrage", sent: true, draft: false, internalDate: at });
}

const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async (task) => { composed.push(task); return composeResult(task); } });
const live = (extra = {}) => write("config.json", { dryRun: false, offer: "Ich prüfe Websites.", sender: { name: "Chris", signature: "Chris" }, ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-worker-"));
  g = fakeGmail();
  clock = T0;
  composed = [];
  composeResult = () => ({ decision: "draft", reason: "", subject: "Kurze Frage", body: "Guten Tag Frau Muster, ..." });
  live();
});

test("eigener Thread mit neuer Antwort: Antwort-Entwurf im selben Thread, nichts gesendet", async () => {
  ownThread("t1", { replies: ["Danke, wann hätten Sie Zeit?"] });
  const r = await worker().tick();
  assert.deepEqual(r.plan.map((p) => [p.kind, p.threadId, p.review]), [["antwort", "t1", false]]);
  assert.ok(g.calls.includes("reply t1"));
  assert.equal(composed[0].kind, "reply");
  assert.match(composed[0].thread.at(-1).body, /wann hätten Sie Zeit/);
  assert.ok(!g.calls.includes("SEND"));
  await worker().tick(); // dieselbe Antwort wird nicht noch einmal bearbeitet
  assert.equal(g.calls.filter((c) => c.startsWith("reply")).length, 1);
});

test("fremde Mail/fremder Thread: wird nie gelesen oder angefasst", async () => {
  ownThread("t1");
  g.threads.tFremd = [{ messageId: "x", from: "boss@firma.ch", body: "Privat", sent: false, draft: false, internalDate: +T0 }];
  await worker().tick();
  assert.ok(!g.calls.some((c) => c.includes("tFremd")));
  await assert.rejects(g.readThread("tFremd"), /nicht von Jarvis begonnen/); // auch direkt verweigert
});

test("Opt-out: dauerhaft gesperrt, keine Antwort, kein Follow-up, kein Erstkontakt", async () => {
  ownThread("t1", { replies: ["Bitte keine weiteren Mails."] });
  write("leads.json", [{ email: "kunde@firma.ch", approved: true }]);
  await worker().tick();
  const supp = JSON.parse(fs.readFileSync(path.join(dir, "suppression.json"), "utf8"));
  assert.ok(supp["kunde@firma.ch"]);
  clock = new Date(+T0 + 20 * DAY);
  await worker().tick();
  assert.ok(!g.calls.some((c) => /^(reply|create)/.test(c)), "nie wieder ein Entwurf");
});

test("Follow-up 1 frühestens nach 3 Tagen", async () => {
  ownThread("t1", { sentAt: new Date(+T0 - 2 * DAY) });
  await worker().tick();
  assert.ok(!g.calls.includes("reply t1"), "nach 2 Tagen noch zu früh");
  clock = new Date(+T0 + DAY + 3600e3);
  const r = await worker().tick();
  assert.deepEqual(r.plan.map((p) => p.kind), ["follow-up 1"]);
  assert.equal(composed[0].followupNumber, 1);
});

test("Follow-up 2 frühestens 5 Tage nach Follow-up 1, danach Schluss", async () => {
  ownThread("t1", { sentAt: new Date(+T0 - 10 * DAY) });
  addOwnFollowUp("t1", +T0 - 4 * DAY);
  await worker().tick();
  assert.ok(!g.calls.includes("reply t1"), "erst 4 Tage nach Follow-up 1");
  clock = new Date(+T0 + DAY + 3600e3);
  const r = await worker().tick();
  assert.deepEqual(r.plan.map((p) => p.kind), ["follow-up 2"]);
  addOwnFollowUp("t1", +clock); // Sir hat Follow-up 2 gesendet
  delete g.reg.drafts.dr1;
  clock = new Date(+T0 + 30 * DAY);
  await worker().tick();
  assert.equal(g.calls.filter((c) => c === "reply t1").length, 1, "kein drittes Follow-up");
});

test("Tageslimit: bei 49 genau noch ein Entwurf, bei 50 keiner mehr", async () => {
  for (let i = 0; i < 49; i++) g.reg.sent["old" + i] = { threadId: "alt" + i, to: "a@b.ch", sentAt: new Date(+T0 - 3600e3).toISOString() };
  for (let i = 0; i < 49; i++) g.threads["alt" + i] = []; // ohne Antworten, Follow-ups noch nicht fällig
  ownThread("t1", { replies: ["Frage 1"] });
  ownThread("t2", { replies: ["Frage 2"] });
  // t1/t2 wurden gestern gesendet → zählen nicht für heute
  g.reg.sent["s-t1"].sentAt = g.reg.sent["s-t2"].sentAt = new Date(+T0 - DAY).toISOString();
  const r = await worker().tick();
  assert.equal(r.plan.length, 1);
  assert.equal(r.used, HARD_LIMIT);
  assert.equal(r.free, 0);
  const r2 = await worker().tick();
  assert.equal(r2.plan.length, 0);
  assert.equal(g.calls.filter((c) => c.startsWith("reply")).length, 1);
});

test("Tageslimit lässt sich per config nicht über 50 anheben", async () => {
  live({ dailyLimit: 500 });
  assert.equal(worker().config().limit, 50);
});

test("Neustart erhält den Zähler (persistenter Zustand)", async () => {
  ownThread("t1", { replies: ["Frage"] });
  g.reg.sent["s-t1"].sentAt = new Date(+T0 - DAY).toISOString();
  const r = await worker().tick();
  assert.equal(r.used, 1);
  const neu = createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", body: "x" }) });
  assert.equal((await neu.plan()).used, 1, "neue Instanz kennt den heutigen Entwurf");
  assert.equal(zurichDay(T0), "2026-10-06");
});

test("doppelter Worker: zweiter Start wird blockiert, abgestandenes Lock wird übernommen", () => {
  assert.equal(acquireLock(dir, { pid: process.pid }), true);
  heartbeat(dir);
  assert.equal(acquireLock(dir, { pid: 999999 }), false, "läuft schon");
  fs.writeFileSync(path.join(dir, "worker.lock"), JSON.stringify({ pid: process.pid, beat: Date.now() - 3600e3 }));
  assert.equal(acquireLock(dir, { pid: 999999 }), true, "alter Herzschlag → übernehmen");
  releaseLock(dir, 999999);
  assert.ok(!fs.existsSync(path.join(dir, "worker.lock")));
});

test("gleicher Lead mehrfach in der Liste: nur ein Erstkontakt", async () => {
  write("leads.json", [
    { email: "info@laden.ch", name: "Laden", approved: true },
    { email: "INFO@laden.ch", approved: true },
    { email: "ohne-freigabe@x.ch" },
    { email: "kaputt", approved: true },
  ]);
  await worker().tick();
  clock = new Date(+T0 + 600e3);
  await worker().tick();
  assert.deepEqual(g.calls.filter((c) => c.startsWith("create")), ["create Laden <info@laden.ch>"]);
});

test("Absender einer Thread-Antwort wird nie zum Lead", async () => {
  ownThread("t1", { to: "anna@firma.ch", replies: ["Ich leite das an bernd@firma.ch weiter."] });
  await worker().tick();
  assert.ok(!g.calls.some((c) => c.startsWith("create")), "keine Erstkontakte ohne Lead-Liste");
});

test("Eskalationsfall: nur Entwurf, für Sir markiert, nie gesendet", async () => {
  ownThread("t1", { replies: ["Schicken Sie mir den Vertrag und Ihre IBAN?"] });
  const r = await worker().tick();
  assert.equal(r.plan[0].review, true);
  assert.ok(g.calls.includes("review dr1"));
  assert.ok(!g.calls.includes("SEND"));
});

test("Dry-Run (Standard): zeigt den Plan, legt nichts an", async () => {
  fs.rmSync(path.join(dir, "config.json"));
  ownThread("t1", { replies: ["Frage"] });
  const r = await worker().tick();
  assert.equal(r.dryRun, true);
  assert.equal(r.plan.length, 1);
  assert.ok(!g.calls.some((c) => /^(reply|create|update|review)/.test(c)));
  assert.equal(composed.length, 0);
});

test("Worker kennt sendDraft nicht", () => {
  const src = fs.readFileSync(new URL("../mail-worker.js", import.meta.url), "utf8");
  assert.ok(!/sendDraft|drafts\/send/.test(src));
});

test("Secrets und Worker-Zustand sind von Git ausgeschlossen", () => {
  const root = fileURLToPathSafe(new URL("..", import.meta.url));
  for (const f of [".secrets/gmail_token.json", ".secrets/gmail_credentials.json", ".secrets/gmail_jarvis.json", ".secrets/mail_worker/state.json", ".secrets/mail_worker/leads.json", ".secrets/mail_worker/suppression.json"])
    execFileSync("git", ["check-ignore", "-q", f], { cwd: root }); // wirft, wenn nicht ignoriert
});
function fileURLToPathSafe(u) { return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, "$1"); }

test("dieselbe eingehende Message-ID wird auch über Neustarts nur einmal verarbeitet", async () => {
  ownThread("t1", { replies: ["Haben Sie nächste Woche Zeit?"] });
  g.reg.sent["s-t1"].sentAt = new Date(+T0 - DAY).toISOString();
  await worker().tick();
  delete g.reg.drafts.dr1; // Sir hat den Entwurf verworfen – die Nachricht bleibt trotzdem erledigt
  await worker().tick();
  await createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", body: "x" }) }).tick();
  assert.equal(g.calls.filter((c) => c === "reply t1").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).handled["in-t1-0"], "answered");
});

test("Suppression überlebt Neustart und sperrt Leads, Antworten und Follow-ups", async () => {
  ownThread("t1", { replies: ["Please remove me from your list."] });
  await worker().tick();
  // "Neustart": neue Instanz, neue Mail desselben Kontakts, derselbe Kontakt als freigegebener Lead
  g.threads.t1.push({ messageId: "in-neu", from: "Anna <kunde@firma.ch>", to: "chris@x.ch", subject: "Re", body: "Doch noch eine Frage?", sent: false, draft: false, internalDate: +T0 + 5 * 3600e3 });
  write("leads.json", [{ email: "Kunde@Firma.ch", approved: true }]);
  clock = new Date(+T0 + 10 * DAY);
  const r = await worker().tick();
  assert.equal(r.plan.length, 0);
  assert.ok(!g.calls.some((c) => /^(reply|create|update)/.test(c)));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "suppression.json"), "utf8"))["kunde@firma.ch"]);
});

test("Dry-Run-Bericht: Antworten, Opt-outs, Follow-ups, Leads, Tageszähler und freie Kapazität", async () => {
  fs.rmSync(path.join(dir, "config.json"));
  write("config.json", { offer: "Ich prüfe Websites.", sender: { name: "Chris" } });
  ownThread("t1", { to: "a@firma.ch", replies: ["Wie geht es weiter?"], sentAt: new Date(+T0 - DAY) });
  ownThread("t2", { to: "b@firma.ch", replies: ["Stop."], sentAt: new Date(+T0 - DAY) });
  ownThread("t3", { to: "c@firma.ch", sentAt: new Date(+T0 - 4 * DAY) });
  ownThread("t4", { to: "d@firma.ch", sentAt: new Date(+T0 - 3600e3) }); // heute gesendet
  write("leads.json", [{ email: "neu@laden.ch", approved: true }]);
  const r = await worker().tick();
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.plan.map((p) => [p.kind, p.to]), [["antwort", "a@firma.ch"], ["follow-up 1", "c@firma.ch"], ["erstkontakt", "neu@laden.ch"]]);
  assert.deepEqual(r.optouts.map((o) => o.address), ["b@firma.ch"]);
  assert.deepEqual(r.ownThreads.map((x) => [x.threadId, x.newReplies]), [["t1", 1], ["t2", 1], ["t3", 0], ["t4", 0]]);
  assert.ok(r.ownThreads.find((x) => x.threadId === "t4").followUpDue, "nächstes Follow-up-Datum sichtbar");
  assert.deepEqual([r.sentToday, r.used, r.free], [1, 4, 46]);
  assert.ok(!g.calls.some((c) => /^(reply|create|update|review)/.test(c)), "keine Gmail-Änderung");
});

const ROOT = fileURLToPathSafe(new URL("..", import.meta.url));
const runWorker = (secrets, ...args) => spawnSync(process.execPath, ["mail-worker.js", ...args], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, JARVIS_SECRETS_DIR: secrets } });

test("zwei echte Worker-Prozesse: der zweite wird durch das Lock blockiert", () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-secrets-"));
  const wdir = path.join(secrets, "mail_worker");
  assert.equal(acquireLock(wdir), true); // dieser Testprozess spielt den laufenden Worker
  try {
    const r = runWorker(secrets, "--once");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /läuft bereits/);
  } finally { releaseLock(wdir); }
});

test("Worker läuft eigenständig ohne server.js", () => {
  const src = fs.readFileSync(new URL("../mail-worker.js", import.meta.url), "utf8");
  assert.ok(!/import[^;]*server\.js|localhost|127\.0\.0\.1/.test(src), "keine Abhängigkeit zum Dashboard-Server");
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-secrets-"));
  const r = runWorker(secrets, "--plan");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.dryRun, out.limit, out.sentToday, out.free], [true, 50, 0, 50]);
});
