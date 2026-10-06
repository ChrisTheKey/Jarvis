// Mail-Worker: nur eigene Threads, Opt-out, Follow-up-Regeln, Tageslimit und Versand nur mit gültiger Versandgrundlage.
// Läuft ohne Netzwerk – Gmail und der Textgenerator sind Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createWorker, acquireLock, releaseLock, heartbeat, zurichDay, HARD_LIMIT, legalBasis } from "../mail-worker.js";

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
      const ext = (f.threads[threadId] || []).filter((m) => !m.sent).at(-1);
      const to = ext ? ext.from : Object.values(f.reg.sent).find((s) => s.threadId === threadId).to;
      f.reg.drafts[id] = { threadId, to, body, createdAt: clock.toISOString() };
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
    // wie gmail.js: hartes Tages- und Fensterlimit, Register erst nach Erfolg
    async sendDraft(id, { window = null } = {}) {
      f.calls.push("SEND " + id);
      const d = f.reg.drafts[id];
      if (!d) throw new Error(`Entwurf ${id} wurde nicht von Jarvis erstellt – Zugriff verweigert.`);
      const today = Object.values(f.reg.sent).filter((s) => s.sentAt && zurichDay(new Date(s.sentAt)) === zurichDay(clock));
      if (today.length >= 100) throw new Error("Tageslimit");
      if (window && today.filter((s) => s.window === window).length >= 50) throw new Error("Fensterlimit");
      if (f.failSend) throw new Error(f.failSend);
      delete f.reg.drafts[id];
      f.reg.sent["sent-" + id] = { messageId: "sent-" + id, threadId: d.threadId, to: d.to, subject: d.subject, body: d.body, fromDraft: id, window, sentAt: clock.toISOString() };
      (f.threads[d.threadId] ||= []).push({ messageId: "sent-" + id, from: "Chris <chris@x.ch>", to: d.to, subject: d.subject || "", body: d.body, sent: true, draft: false, internalDate: +clock });
      return { messageId: "sent-" + id, threadId: d.threadId };
    },
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
const OPTIN = { approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular helvetic-webdesign.ch" };
const auto = (extra = {}) => live({ sendMode: "compliant_auto", sender: { name: "Chris Muster", company: "Muster Web", email: "chris@x.ch" }, ...extra });
const sends = () => g.calls.filter((c) => c.startsWith("SEND"));
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
  write("leads.json", [{ email: "kunde@firma.ch", ...OPTIN }]);
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
  addOwnFollowUp("t1", +clock); // Chris hat Follow-up 2 gesendet
  delete g.reg.drafts.dr1;
  clock = new Date(+T0 + 30 * DAY);
  await worker().tick();
  assert.equal(g.calls.filter((c) => c === "reply t1").length, 1, "kein drittes Follow-up");
});

test("Tageslimit: bei 99 genau noch ein Entwurf, bei 100 keiner mehr", async () => {
  for (let i = 0; i < 99; i++) g.reg.sent["old" + i] = { threadId: "alt" + i, to: "a@b.ch", sentAt: new Date(+T0 - 3600e3).toISOString() };
  for (let i = 0; i < 99; i++) g.threads["alt" + i] = []; // ohne Antworten, Follow-ups noch nicht fällig
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

test("Tageslimit lässt sich per config nicht über 100 anheben", async () => {
  live({ dailyLimit: 500 });
  assert.equal(worker().config().limit, 100);
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
    { email: "info@laden.ch", name: "Laden", ...OPTIN },
    { email: "INFO@laden.ch", ...OPTIN },
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

test("ohne sendMode compliant_auto wird nie gesendet – auch nicht bei gültiger Versandgrundlage", async () => {
  ownThread("t1", { replies: ["Wann passt es Ihnen?"] });
  write("state.json", { compliantThreads: { t1: { to: "kunde@firma.ch", basis: "opt_in" } } });
  write("leads.json", [{ email: "neu@laden.ch", ...OPTIN }]);
  await worker().tick();
  assert.deepEqual(sends(), []);
  const src = fs.readFileSync(new URL("../mail-worker.js", import.meta.url), "utf8");
  assert.ok(!/drafts\/send|messages\/send/.test(src), "gesendet wird nur über gmail.sendDraft mit allen Schutzprüfungen");
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
  write("leads.json", [{ email: "Kunde@Firma.ch", ...OPTIN }]);
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
  write("leads.json", [{ email: "neu@laden.ch", ...OPTIN }]);
  const r = await worker().tick();
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.plan.map((p) => [p.kind, p.to]), [["antwort", "a@firma.ch"], ["follow-up 1", "c@firma.ch"], ["erstkontakt", "neu@laden.ch"]]);
  assert.deepEqual(r.optouts.map((o) => o.address), ["b@firma.ch"]);
  assert.deepEqual(r.ownThreads.map((x) => [x.threadId, x.newReplies]), [["t1", 1], ["t2", 1], ["t3", 0], ["t4", 0]]);
  assert.ok(r.ownThreads.find((x) => x.threadId === "t4").followUpDue, "nächstes Follow-up-Datum sichtbar");
  assert.deepEqual([r.sentToday, r.used, r.free], [1, 4, 96]);
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
  assert.deepEqual([out.dryRun, out.limit, out.sentToday, out.free], [true, 100, 0, 100]);
});

// ---------- Echtversand nur mit Versandgrundlage (sendMode compliant_auto) ----------

test("Versandgrundlage: opt_in und Bestandskunde mit ähnlicher Leistung erlaubt, alles andere nicht", () => {
  assert.equal(legalBasis({ ...OPTIN }, T0), "opt_in");
  assert.equal(legalBasis({ approved: true }, T0), null, "approved ohne consentBasis");
  assert.equal(legalBasis({ ...OPTIN, consentAt: undefined }, T0), null, "ohne consentAt");
  assert.equal(legalBasis({ ...OPTIN, consentSource: " " }, T0), null, "ohne consentSource");
  assert.equal(legalBasis({ ...OPTIN, consentAt: "2027-01-01" }, T0), null, "Einwilligung in der Zukunft");
  assert.equal(legalBasis({ ...OPTIN, approved: false }, T0), null);
  assert.equal(legalBasis({ approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true }, T0), "existing_customer");
  assert.equal(legalBasis({ approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: false }, T0), null);
  assert.equal(legalBasis({ approved: true, consentBasis: "existing_customer", existingCustomer: false, similarService: true }, T0), null);
  assert.equal(legalBasis({ approved: true, consentBasis: "public_address" }, T0), null);
});

test("opt_in-Lead: Erstkontakt wird gesendet, mit Absenderidentität und Abmeldehinweis", async () => {
  auto();
  write("leads.json", [{ email: "anna@laden.ch", name: "Anna Muster", company: "Laden AG", ...OPTIN }]);
  const r = await worker().tick();
  assert.deepEqual(sends(), ["SEND dr1"]);
  assert.deepEqual(r.sends.map((x) => [x.kind, x.to]), [["erstkontakt", "anna@laden.ch"]]);
  const mail = g.reg.sent["sent-dr1"];
  assert.match(mail.body, /Chris Muster/, "Absendername");
  assert.match(mail.body, /Muster Web/, "Unternehmen");
  assert.match(mail.body, /chris@x\.ch/, "reale Absenderadresse");
  assert.match(mail.body, /antworten Sie einfach mit «Abmelden»/, "Abmeldehinweis");
  assert.equal(composed[0].kind, "outreach");
  assert.equal(composed[0].lead.consentSource, undefined, "Consent-Daten gehen nicht an den Textgenerator");
});

test("Abmeldehinweis in der Sprache des Empfängers und nie doppelt", async () => {
  auto();
  composeResult = () => ({ decision: "draft", subject: "Hi", body: "Hello Anna, ...\n\nChris Muster" });
  write("leads.json", [{ email: "anna@shop.com", language: "en", ...OPTIN }]);
  await worker().tick();
  const body = g.reg.sent["sent-dr1"].body;
  assert.match(body, /reply with "unsubscribe"/);
  assert.equal(body.match(/unsubscribe/gi).length, 1);
});

test("approved ohne Versandgrundlage und öffentliche info@-Adresse: blockiert und markiert", async () => {
  auto();
  write("leads.json", [
    { email: "info@firma.ch", company: "Firma AG", website: "https://firma.ch", approved: true },
    { email: "chef@firma.ch", approved: true, consentBasis: "opt_in" },
    { email: "alt@kunde.ch", approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: false },
  ]);
  const r = await worker().tick();
  assert.deepEqual(sends(), []);
  assert.ok(!g.calls.some((c) => c.startsWith("create")), "nicht einmal ein Entwurf");
  assert.equal(r.blockedLeads, 3);
  const leads = JSON.parse(fs.readFileSync(path.join(dir, "leads.json"), "utf8"));
  assert.deepEqual(leads.map((l) => l.status), ["blocked_no_legal_basis", "blocked_no_legal_basis", "blocked_no_legal_basis"]);
  assert.equal(leads[0].consentBasis, undefined, "keine Grundlage erfunden");
});

test("Bestandskunde mit ähnlicher Leistung: Versand erlaubt", async () => {
  auto();
  write("leads.json", [{ email: "kunde@alt.ch", approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true }]);
  await worker().tick();
  assert.deepEqual(sends(), ["SEND dr1"]);
});

test("Opt-out nach Erstkontakt: dauerhaft gesperrt, kein Follow-up, keine Antwort, kein neuer Erstkontakt", async () => {
  auto();
  write("leads.json", [{ email: "anna@laden.ch", ...OPTIN }]);
  await worker().tick();
  const tid = g.reg.sent["sent-dr1"].threadId;
  g.threads[tid].push({ messageId: "in-1", from: "Anna <anna@laden.ch>", to: "chris@x.ch", subject: "Re", body: "Abmelden", sent: false, draft: false, internalDate: +T0 + 3600e3 });
  clock = new Date(+T0 + 2 * 3600e3);
  await worker().tick();
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "suppression.json"), "utf8"))["anna@laden.ch"]);
  write("leads.json", [{ email: "anna@laden.ch", ...OPTIN }, { email: "ANNA@laden.ch", ...OPTIN }]);
  for (const d of [4, 10, 20]) { clock = new Date(+T0 + d * DAY); await worker().tick(); }
  assert.deepEqual(sends(), ["SEND dr1"], "nur der ursprüngliche Erstkontakt");
  assert.ok(!g.calls.some((c) => /^(reply|create)/.test(c) && c !== "create anna@laden.ch"));
});

test("Suppression wird direkt vor dem Send geprüft", async () => {
  auto();
  write("leads.json", [{ email: "anna@laden.ch", ...OPTIN }]);
  const w = worker();
  const orig = g.createDraft;
  g.createDraft = async (x) => { const d = await orig(x); write("suppression.json", { "anna@laden.ch": { reason: "opt-out" } }); return d; };
  await w.tick();
  assert.deepEqual(sends(), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).actions["outreach:anna@laden.ch"].status, "suppressed");
});

test("Tageslimit bleibt hart: bei 99 genau ein Send, bei 100 keiner", async () => {
  auto();
  for (let i = 0; i < 98; i++) g.reg.sent["old" + i] = { threadId: "alt" + i, to: "x@y.ch", sentAt: new Date(+T0 - 3600e3).toISOString() };
  for (let i = 0; i < 98; i++) g.threads["alt" + i] = [];
  ownThread("t1", { to: "a@firma.ch", replies: ["Frage 1"], sentAt: new Date(+T0 - 2 * 3600e3) });
  ownThread("t2", { to: "b@firma.ch", replies: ["Frage 2"], sentAt: new Date(+T0 - DAY) });
  ownThread("t3", { to: "c@firma.ch", replies: ["Frage 3"], sentAt: new Date(+T0 - DAY) });
  write("state.json", { compliantThreads: { t1: { basis: "opt_in" }, t2: { basis: "opt_in" }, t3: { basis: "opt_in" } } });
  // 99 heute gesendet (98 + t1) → genau eine weitere Mail
  const r = await worker().tick();
  assert.equal(sends().length, 1);
  assert.equal(r.free, 0);
  clock = new Date("2026-10-06T12:35:00Z"); // 14:35 Zürich: Nachmittagsfenster
  await worker().tick();
  assert.equal(sends().length, 1, "bei 100 keine weitere – auch nicht im zweiten Fenster");
});

test("Doppelversand: zweiter Durchlauf und Absturz während des Sendens senden nie erneut", async () => {
  auto();
  write("leads.json", [{ email: "anna@laden.ch", ...OPTIN }]);
  await worker().tick();
  clock = new Date(+T0 + 30 * 60_000);
  await worker().tick();
  assert.deepEqual(sends(), ["SEND dr1"]);
  // Absturz mitten im Senden simulieren: Status "sending", Entwurf existiert noch
  const st = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  g.reg.drafts.dr9 = { threadId: "t9", to: "bob@x.ch", createdAt: clock.toISOString() };
  st.actions["outreach:bob@x.ch"] = { status: "sending", draftId: "dr9", autoSend: true, to: "bob@x.ch", at: clock.toISOString() };
  write("state.json", st);
  clock = new Date(+T0 + 60 * 60_000);
  await worker().tick();
  assert.ok(!sends().includes("SEND dr9"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).actions["outreach:bob@x.ch"].status, "send_unknown");
});

test("fehlgeschlagener Send zählt nicht und wird nicht automatisch wiederholt", async () => {
  auto();
  write("leads.json", [{ email: "anna@laden.ch", ...OPTIN }]);
  g.failSend = "Gmail POST /drafts/send: invalid recipient";
  const r = await worker().tick();
  assert.equal(r.sends.length, 0);
  assert.equal(Object.keys(g.reg.sent).length, 0, "nichts im Gesendet-Register");
  g.failSend = null;
  clock = new Date(+T0 + 30 * 60_000);
  await worker().tick();
  assert.equal(sends().length, 1, "kein automatischer zweiter Versuch");
});

test("Versand nur im Versandfenster: vorbereitete Mails warten auf 14:30, nachts kein Versand", async () => {
  auto();
  clock = new Date("2026-10-06T10:30:00Z"); // 12:30 Zürich: zwischen den Fenstern
  write("leads.json", ["a", "b"].map((x) => ({ email: x + "@laden.ch", ...OPTIN })));
  const r = await worker().tick();
  assert.equal(sends().length, 0, "zwischen den Fenstern kein Versand");
  assert.equal(r.plan.length, 2, "Entwürfe werden trotzdem vorbereitet");
  clock = new Date("2026-10-06T12:30:00Z"); // 14:30 Zürich
  await worker().tick();
  assert.equal(sends().length, 2, "alle vorbereiteten Erstkontakte im Nachmittagsfenster");
  clock = new Date("2026-10-06T20:00:00Z"); // 22:00 Zürich
  write("leads.json", [{ email: "d@laden.ch", ...OPTIN }]);
  await worker().tick();
  assert.equal(sends().length, 2, "nachts kein Versand");
});

test("fremde Gmail-Mail bleibt im Echtversand unangetastet", async () => {
  auto();
  ownThread("t1");
  g.threads.tFremd = [{ messageId: "x", from: "boss@firma.ch", body: "Abmelden? Bitte Vertrag schicken", sent: false, draft: false, internalDate: +T0 }];
  write("leads.json", [{ email: "neu@laden.ch", ...OPTIN }]);
  await worker().tick();
  assert.ok(!g.calls.some((c) => c.includes("tFremd")));
  assert.ok(!sends().some((c) => c.includes("tFremd")));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, "suppression.json"), "utf8"))["boss@firma.ch"]);
});

test("Follow-ups werden nur in ursprünglich zulässigen Threads gesendet, sonst nur Entwurf", async () => {
  auto();
  ownThread("tOk", { to: "ok@firma.ch", sentAt: new Date(+T0 - 4 * DAY) });
  ownThread("tSir", { to: "sir-kontakt@firma.ch", sentAt: new Date(+T0 - 4 * DAY) });
  write("state.json", { compliantThreads: { tOk: { to: "ok@firma.ch", basis: "opt_in", lang: "de" } } });
  await worker().tick();
  clock = new Date(+T0 + 13 * 60_000);
  await worker().tick();
  const st = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(st.actions["followup:tOk:1"].status, "sent");
  assert.equal(st.actions["followup:tSir:1"].status, "prepared");
  assert.equal(st.actions["followup:tSir:1"].autoSend, false);
  assert.equal(sends().length, 1);
  assert.match(g.reg.sent["sent-" + st.actions["followup:tOk:1"].draftId].body, /«Abmelden»/, "werbliches Follow-up mit Abmeldehinweis");
});

test("Eskalationsfall im zulässigen Thread: nur Entwurf zur Prüfung, kein Versand", async () => {
  auto();
  ownThread("t1", { replies: ["Können Sie mir 20 % Rabatt geben? Dann schicke ich die IBAN."], sentAt: new Date(+T0 - DAY) });
  write("state.json", { compliantThreads: { t1: { basis: "opt_in" } } });
  const r = await worker().tick();
  assert.equal(r.plan[0].review, true);
  assert.ok(g.calls.includes("review dr1"));
  assert.deepEqual(sends(), []);
});

test("unklare Antwort (Textgenerator eskaliert): kein Versand", async () => {
  auto();
  composeResult = () => ({ decision: "escalate", reason: "unklar", body: "Guten Tag ..." });
  ownThread("t1", { replies: ["Und was ist mit dem anderen Thema von letzter Woche?"], sentAt: new Date(+T0 - DAY) });
  write("state.json", { compliantThreads: { t1: { basis: "opt_in" } } });
  await worker().tick();
  assert.deepEqual(sends(), []);
});

test("Antwort im zulässigen Thread wird gesendet und hat Vorrang", async () => {
  auto();
  ownThread("t1", { replies: ["Klingt gut, was wäre der nächste Schritt?"], sentAt: new Date(+T0 - DAY) });
  write("state.json", { compliantThreads: { t1: { basis: "opt_in" } }, lastSendAt: +T0 - 60_000 });
  write("leads.json", [{ email: "neu@laden.ch", ...OPTIN }]);
  const r = await worker().tick();
  assert.equal(r.sends[0].kind, "antwort", "Antwort trotz Versandabstand sofort");
});

test("Echtversand ohne sender.name: nur Entwürfe", async () => {
  auto({ sender: { name: "" } });
  ownThread("t1", { replies: ["Wann passt es?"], sentAt: new Date(+T0 - DAY) });
  write("state.json", { compliantThreads: { t1: { basis: "opt_in" } } });
  const r = await worker().tick();
  assert.deepEqual(sends(), []);
  assert.equal(r.autoSendActive, false);
});

test("Dry-Run bleibt per CLI: --dry-run sendet nie", () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-secrets-"));
  fs.mkdirSync(path.join(secrets, "mail_worker"));
  fs.writeFileSync(path.join(secrets, "mail_worker", "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", sender: { name: "X" } }));
  const r = runWorker(secrets, "--dry-run");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.dryRun, out.autoSendActive, out.sends.length], [true, false, 0]);
});

test("keine Lead- oder Consent-Daten im Git", () => {
  const root = fileURLToPathSafe(new URL("..", import.meta.url));
  execFileSync("git", ["check-ignore", "-q", ".secrets/mail_worker/leads.json"], { cwd: root });
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  // Datendateien (nicht Quellcode wie lead-finder.js) dürfen nie im Repository liegen.
  assert.deepEqual(tracked.filter((f) => /(^|\/)(leads?|discovered|suppression|state|shared_state|jarvis_sync|consent\w*)\.json$|(^|\/)\.secrets\//i.test(f)), []);
});
