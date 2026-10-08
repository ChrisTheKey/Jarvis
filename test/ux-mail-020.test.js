// TF-JARVIS-UX-MAIL-020: Texteingabe, Anrede „Chris“, zwei Versandfenster (50/50/100), Cloud-Mailaufträge, Local Core.
// Ohne Netzwerk und ohne echte Mails: Gmail, Netlify Blobs und Claude-API sind Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createWorker, zurichDay, sendWindowAt, SEND_WINDOWS, HARD_LIMIT, WINDOW_LIMIT, CLOUD_INBOX, inboxAdd, pushInbox, createStore, businessSnapshot } from "../mail-worker.js";
import { createMailRequestHandler, createMailQueue, pullMailRequests, pushMailResult, MAIL_REQUEST_LIMITS } from "../mail-requests.js";
import { memoryStore, sanitizeState, findSensitiveKeys } from "../shared-state.js";
import { acquireSupervisorLock, releaseSupervisorLock, LOCK_STALE_MS } from "../local-core.js";
import { cloudPersona } from "../scripts/build-persona.mjs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const MORNING = new Date("2026-10-06T07:35:00Z"); // 09:35 Zürich (Sommerzeit)
const AFTERNOON = new Date("2026-10-06T12:35:00Z"); // 14:35 Zürich
const BETWEEN = new Date("2026-10-06T10:30:00Z"); // 12:30 Zürich – kein Fenster
// TF-024: vollständig belegte Grundlagen (Empfänger, Quelle, Datum, Umfang, Beleg, vorher eingeholt, aktiv, Vertrauen HIGH).
const OPTIN = { approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular helvetic-webdesign.ch mit Einwilligungs-Checkbox",
  consentScope: "Hinweise und Angebote zu Website-Prüfung und Website-Reparatur von Helvetic Webdesign", consentEvidence: "Double-Opt-in bestätigt am 2026-09-01 (Formular-Eintrag 4711)",
  obtainedBeforeMarketingSend: true, withdrawalStatus: "active", consentConfidence: "HIGH" };
const optIn = (email) => ({ ...OPTIN, consentRecipient: email });
const CUSTOMER = { approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true,
  customerRelationshipEvidence: "Auftrag und Rechnung 2025-118 (Website-Wartung)", relationshipDate: "2025-05-10", previousService: "Website-Wartung",
  advertisedService: "Website-Reparatur", similarityRationale: "Gleiche Website, gleiche Art Leistung (Pflege/Reparatur)", emailSource: "Kundenkorrespondenz zum Auftrag 2025-118",
  sameProvider: true, optOutStatus: "none", customerConfidence: "HIGH" };
let dir, g, clock;

// Gmail-Attrappe wie gmail.js: Tages- (100) und Fensterlimit (50), Register erst nach Erfolg.
function fakeGmail() {
  const f = {
    reg: { labelId: "L", drafts: {}, sent: {} }, threads: {}, calls: [], n: 0,
    listOwned: () => structuredClone(f.reg),
    async readThread(threadId) { return { threadId, messages: structuredClone(f.threads[threadId] || []) }; },
    async replyToThread(threadId, { body }) {
      f.calls.push("reply " + threadId);
      const id = "dr" + ++f.n;
      f.reg.drafts[id] = { threadId, to: Object.values(f.reg.sent).find((s) => s.threadId === threadId).to, body, createdAt: clock.toISOString() };
      return { draftId: id, threadId };
    },
    async createDraft({ to, subject, body }) {
      f.calls.push("create " + to);
      const id = "dr" + ++f.n;
      f.reg.drafts[id] = { threadId: "new" + id, to, subject, body, createdAt: clock.toISOString() };
      return { draftId: id, threadId: "new" + id };
    },
    async updateDraft() { throw new Error("unerwartet"); },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft(id, { window = null } = {}) {
      f.calls.push("SEND " + id);
      const d = f.reg.drafts[id];
      if (!d) throw new Error("nicht von Jarvis");
      const today = Object.values(f.reg.sent).filter((s) => zurichDay(new Date(s.sentAt)) === zurichDay(clock));
      if (today.length >= 100) throw new Error("Tageslimit");
      if (window && today.filter((s) => s.window === window).length >= 50) throw new Error("Fensterlimit");
      delete f.reg.drafts[id];
      f.reg.sent["sent-" + id] = { threadId: d.threadId, to: d.to, subject: d.subject, fromDraft: id, window, sentAt: clock.toISOString() };
      return { messageId: "sent-" + id };
    },
  };
  return f;
}
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", subject: "Kurze Frage", body: "Guten Tag ...\n\nChris Muster" }) });
const auto = () => write("config.json", { dryRun: false, sendMode: "compliant_auto", offer: "Website-Check", sender: { name: "Chris Muster", email: "chris@x.ch" } });
const sends = () => g.calls.filter((c) => c.startsWith("SEND"));
// n versandbereite Kampagnen-Mails (Follow-ups, sales_followup) in zulässigen Threads (wie vom Worker vorbereitet).
// Kampagnen sind an die Versandfenster gebunden; Gesprächsantworten nicht (TF-021).
function queued(n, prefix = "q") {
  const st = { actions: {}, compliantThreads: {} };
  for (let i = 0; i < n; i++) {
    const tid = `${prefix}t${i}`, did = `${prefix}d${i}`, to = `k${i}@${prefix}.ch`;
    g.reg.drafts[did] = { threadId: tid, to, createdAt: "2026-10-05T10:00:00Z" };
    st.actions[`followup:${tid}:1`] = { status: "prepared", autoSend: true, paced: true, kind: "follow-up 1", draftId: did, threadId: tid, to, at: `2026-10-05T10:00:${String(i % 60).padStart(2, "0")}Z` };
    st.compliantThreads[tid] = { to, basis: "opt_in" };
  }
  write("state.json", st);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-020-"));
  g = fakeGmail();
  clock = MORNING;
  auto();
});

// ---------- 1. Texteingabe ----------

function loadComposer() {
  const ctx = { Event: class { constructor(t) { this.type = t; } } };
  vm.runInNewContext(read("public/composer.js"), ctx);
  return ctx.JarvisComposer;
}
function fakeComposer() {
  const handlers = {}, form = { submits: 0, requestSubmit() { this.submits++; } };
  const input = { value: "", style: {}, scrollHeight: 40, focused: 0, addEventListener: (t, fn) => (handlers[t] = fn), focus() { this.focused++; } };
  const key = (k, mods = {}) => { const e = { key: k, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...mods }; handlers.keydown(e); return e; };
  return { form, input, handlers, key };
}

test("Composer: Enter sendet, Shift+Enter neue Zeile, keine Sendung während IME-Eingabe", () => {
  const C = loadComposer();
  const { form, input, key } = fakeComposer();
  C.attach({ form, input });
  const enter = key("Enter");
  assert.equal(form.submits, 1);
  assert.equal(enter.prevented, true);
  const shift = key("Enter", { shiftKey: true });
  assert.equal(form.submits, 1, "Shift+Enter sendet nicht");
  assert.equal(shift.prevented, false, "Shift+Enter: Standardverhalten = neue Zeile");
  key("Enter", { isComposing: true });
  key("a");
  assert.equal(form.submits, 1);
});

test("Composer bleibt nach einer Antwort nutzbar und wächst mit", () => {
  const C = loadComposer();
  const { form, input, handlers, key } = fakeComposer();
  const c = C.attach({ form, input });
  key("Enter"); key("Enter");
  assert.equal(form.submits, 2, "mehrfach hintereinander nutzbar");
  input.value = "Zeile 1\nZeile 2"; input.scrollHeight = 64; handlers.input();
  assert.equal(input.style.height, "64px");
  c.clear();
  assert.equal(input.value, "");
  const html = read("public/index.html");
  assert.ok(!/cmdInput"\)\.disabled = true/.test(html), "Eingabe wird nie gesperrt");
  assert.match(html, /\$\("cmdInput"\)\.disabled = false;\s*\n\s*if \(fromComposer\) \$\("cmdInput"\)\.focus\(\);/, "nach jeder Antwort wieder bedienbar und fokussiert");
});

test("Composer sichtbar in LOCAL und CLOUD: gleiches Markup, nicht verdeckt, im Viewport", () => {
  const html = read("public/index.html");
  // Ein einziges Composer-System für beide Modi – nicht an mode gebunden.
  assert.match(html, /<form class="cmd" id="cmd">[\s\S]*<textarea id="cmdInput" rows="1"[^>]*enterkeyhint="send"[\s\S]*<button type="submit" id="send">SENDEN<\/button>/);
  assert.ok(!/id="cmdInput"[^>]*hidden/.test(html) && !/\$\("cmd(Input)?"\)\.hidden/.test(html), "nie versteckt");
  assert.match(html, /<script src="composer.js"><\/script>/);
  // Layout: mittlere Zeile darf schrumpfen (vorher schob das rechte Panel die Eingabe aus dem Bild).
  assert.match(html, /grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(html, /\.bottom \{[^}]*position: relative; z-index: 5; min-width: 0;/);
  assert.match(html, /\.right \{[^}]*min-height: 0; overflow: hidden;/);
  assert.match(html, /@media \(max-width: 860px\)[\s\S]*\.left, \.right \{ display: none; \}/, "kleine Fenster: nur Kern und Eingabe");
  assert.ok(fs.existsSync(path.join(ROOT, "public", "composer.js")), "Netlify (Cloud) liefert public/ aus");
  assert.match(read("server.js"), /\["\/mode-detect\.js", "\/composer\.js", "\/mail-status\.js", "\/server-status\.js"\]/, "Local Core liefert dasselbe Skript");
  // Leertaste/Escape-Kurzbefehle greifen im Textfeld nicht
  assert.match(html, /if \(e\.target\.closest\("input, select, textarea, button"\)\) return;/);
});

// ---------- 2. Immer „Chris“ ----------

test("Persona: user_preferred_name = Chris, lokal und in der Cloud identisch, kein produktives „Sir“", async () => {
  const md = read("persona.md");
  assert.match(md, /user_preferred_name: Chris/);
  assert.match(md, /„Guten Morgen, Chris\.“/);
  const { PERSONA } = await import("../netlify/shared/persona.generated.js");
  assert.equal(PERSONA, cloudPersona(md), "Cloud-Fassung aus derselben Quelle");
  assert.match(PERSONA, /Dein Nutzer heisst Chris\. Du nennst ihn immer Chris/);
  // Einzige erlaubte Erwähnung: das Verbot selbst.
  const lines = (s) => s.split("\n").filter((l) => /\bSir\b|Herr Kälin/.test(l) && !/Keine Anrede mit „Sir“, kein „Herr Kälin“/.test(l));
  assert.deepEqual(lines(md), []);
  assert.deepEqual(lines(PERSONA), []);
  for (const f of ["public/index.html", "netlify/edge-functions/cloud.js", "local-state.js", "server.js", "workspace/CLAUDE.md", "mail-writer.md", "workspace/memory/chris.md"])
    assert.ok(!/\bSir\b/.test(read(f)), `${f}: keine Anrede „Sir“`);
  const html = read("public/index.html");
  assert.match(html, /const USER_NAME = "Chris";/);
  assert.match(html, /`Guten Morgen, \$\{USER_NAME\}\.`/);
  assert.match(html, /`Guten Abend, \$\{USER_NAME\}\.`/);
  assert.match(read("server.js"), /"--append-system-prompt-file", PERSONA/, "Local nutzt persona.md");
  assert.match(read("workspace/memory/chris.md"), /user_preferred_name: Chris/);
});

// ---------- 3.–7. Zwei Versandfenster ----------

test("Fenster 09:30 und 14:30 Europe/Zurich, sommerzeitfest", () => {
  assert.deepEqual(SEND_WINDOWS.map((w) => [w.id, w.start, w.limit]), [["morning", "09:30", 50], ["afternoon", "14:30", 50]]);
  assert.equal([HARD_LIMIT, WINDOW_LIMIT].join(), "100,50");
  const at = (iso) => sendWindowAt(new Date(iso))?.id || null;
  // Sommerzeit (UTC+2)
  assert.equal(at("2026-10-06T07:29:00Z"), null);
  assert.equal(at("2026-10-06T07:30:00Z"), "morning");
  assert.equal(at("2026-10-06T12:29:00Z"), null);
  assert.equal(at("2026-10-06T12:30:00Z"), "afternoon");
  // Winterzeit (UTC+1)
  assert.equal(at("2026-12-01T08:29:00Z"), null);
  assert.equal(at("2026-12-01T08:30:00Z"), "morning");
  assert.equal(at("2026-12-01T13:30:00Z"), "afternoon");
  // Umstellungstag 25.10.2026 (03:00 → 02:00): 09:30 Zürich = 08:30 UTC
  assert.equal(at("2026-10-25T07:30:00Z"), null);
  assert.equal(at("2026-10-25T08:30:00Z"), "morning");
  // Umstellung im März 29.03.2026: 09:30 Zürich = 07:30 UTC
  assert.equal(at("2026-03-29T07:30:00Z"), "morning");
  assert.equal(at("2026-03-29T07:29:00Z"), null);
});

test("max 50 morgens, max 50 nachmittags, max 100 am Tag – Rest wartet, nichts erzwungen", async () => {
  queued(130);
  const r1 = await worker().tick();
  assert.equal(sends().length, 50, "Morgenfenster: 50");
  assert.equal(r1.windows.morning.sent, 50);
  clock = AFTERNOON;
  const r2 = await worker().tick();
  assert.equal(sends().length, 100, "Nachmittagsfenster: weitere 50");
  assert.deepEqual([r2.windows.morning.sent, r2.windows.afternoon.sent, r2.windows.afternoon.executed], [50, 50, true]);
  assert.equal(Object.values(g.reg.sent).filter((s) => s.window === "morning").length, 50);
  assert.equal(Object.values(g.reg.sent).filter((s) => s.window === "afternoon").length, 50);
  clock = new Date("2026-10-06T14:00:00Z"); // 16:00, noch im Nachholzeitraum
  await worker().tick();
  assert.equal(sends().length, 100, "kein 101. Send am selben Tag");
  assert.equal(Object.values(readJson("state.json").actions).filter((a) => a.status === "prepared").length, 30, "Rest bleibt vorbereitet");
});

test("wenige berechtigte Mails: nur diese senden; keine: 0 Sends", async () => {
  queued(8);
  await worker().tick();
  assert.equal(sends().length, 8, "nur 8, keine Quote erzwungen");
  clock = AFTERNOON;
  const r = await worker().tick();
  assert.equal(sends().length, 8, "nachmittags nichts mehr da: 0");
  assert.equal(r.windows.afternoon.executed, true);
});

test("101. Send blockiert: 100 heute bereits gesendet → Fenster sendet nichts", async () => {
  for (let i = 0; i < 100; i++) g.reg.sent["old" + i] = { threadId: "alt" + i, to: "x@y.ch", sentAt: new Date(+MORNING - 3600e3).toISOString() };
  for (let i = 0; i < 100; i++) g.threads["alt" + i] = [];
  queued(3);
  const r = await worker().tick();
  assert.deepEqual(sends(), []);
  assert.ok(r.notes.some((n) => /Tageslimit von 100/.test(n)));
});

test("zweiter Worker-Tick und Worker-Neustart wiederholen ein Fenster nie", async () => {
  queued(2);
  await worker().tick();
  assert.equal(sends().length, 2);
  // Nach dem Lauf neu vorbereitete Mails warten auf das nächste Fenster
  const st = readJson("state.json");
  g.reg.drafts.late = { threadId: "lt", to: "late@x.ch" };
  st.actions["followup:lt:1"] = { status: "prepared", autoSend: true, paced: true, kind: "follow-up 1", draftId: "late", threadId: "lt", to: "late@x.ch", at: MORNING.toISOString() };
  st.compliantThreads.lt = { basis: "opt_in" };
  write("state.json", st);
  clock = new Date(+MORNING + 5 * 60_000);
  await worker().tick(); // zweiter Tick, gleicher Worker-Stand
  await createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({}) }).tick(); // „Neustart“
  assert.equal(sends().length, 2, "kein zweiter Morgenlauf");
  assert.ok(readJson("state.json").windows["2026-10-06"].morning.executedAt, "morning_window_executed persistiert");
  clock = AFTERNOON;
  await worker().tick();
  assert.deepEqual(sends().slice(2), ["SEND late"], "geht ins nächste zulässige Fenster");
});

test("Absturz mitten im Fenster: nach Neustart kein zweiter Lauf", async () => {
  queued(3);
  const st = readJson("state.json");
  st.windows = { "2026-10-06": { morning: { executedAt: MORNING.toISOString(), status: "running", sent: 1 } } };
  write("state.json", st);
  await worker().tick();
  assert.deepEqual(sends(), []);
});

test("Compliance unverändert: suppressed, Opt-out, ohne Versandgrundlage, öffentliche Adresse → 0 Sends", async () => {
  write("suppression.json", { "weg@laden.ch": { reason: "opt-out" }, "abgemeldet@laden.ch": { reason: "unzustellbar" } });
  write("leads.json", [
    { email: "weg@laden.ch", ...optIn("weg@laden.ch") }, // Opt-out
    { email: "abgemeldet@laden.ch", ...optIn("abgemeldet@laden.ch") }, // suppressed
    { email: "info@firma.ch", company: "Firma AG", approved: true, emailSource: "https://firma.ch/impressum" }, // nur öffentlich gefunden
    { email: "chef@firma.ch", approved: true, consentBasis: "opt_in" }, // opt_in ohne Beleg
    { email: "alt@kunde.ch", approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: false },
  ]);
  const r = await worker().tick();
  clock = AFTERNOON;
  await worker().tick();
  assert.deepEqual(sends(), []);
  assert.ok(!g.calls.some((c) => c.startsWith("create")), "nicht einmal Entwürfe");
  assert.equal(r.blockedLeads, 3);
  assert.deepEqual(readJson("leads.json").filter((l) => l.status === "blocked_no_legal_basis").map((l) => l.email), ["info@firma.ch", "chef@firma.ch", "alt@kunde.ch"]);
});

test("Versandgrundlage wird direkt vor dem Send erneut geprüft (Follow-up/Erstkontakt im Fenster)", async () => {
  clock = BETWEEN;
  write("leads.json", [{ email: "anna@laden.ch", ...optIn("anna@laden.ch") }]);
  await worker().tick();
  assert.deepEqual(sends(), [], "vorbereitet, aber noch kein Fenster");
  write("leads.json", [{ email: "anna@laden.ch", approved: true }]); // Grundlage entfernt
  clock = AFTERNOON;
  await worker().tick();
  assert.deepEqual(sends(), []);
  assert.equal(readJson("state.json").actions["outreach:anna@laden.ch"].status, "blocked_no_legal_basis");
});

test("HUD-Status: Mail heute X/100, Morgen X/50, Nachmittag X/50, sauber über den Shared State", async () => {
  queued(3);
  const r = await worker().tick();
  r.report = { sentToday: 3, freeToday: 97 };
  const snap = businessSnapshot(r, {}, MORNING.toISOString());
  assert.deepEqual(findSensitiveKeys({ op: "sync", state: { business: snap } }), [], "Cloud-Sync akzeptiert den Status (kein gesperrter Feldname)");
  const s = sanitizeState({ business: snap }).business.worker;
  assert.deepEqual([s.todaySent, s.limit, s.windows.morning.count, s.windows.morning.limit, s.windows.morning.executed, s.windows.afternoon.count, s.windows.afternoon.limit], [3, 100, 3, 50, true, 0, 50]);
  const html = read("public/index.html");
  for (const id of ["kMode", "kLocal", "kWorker", "kMail", "kMorning", "kAfternoon", "kSync"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<span>Morgenfenster<\/span>/);
  assert.match(html, /<span>Nachmittagsfenster<\/span>/);
});

// ---------- 8.–10. Cloud-Mailaufträge ----------

const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-test-token" };
const asUser = { "x-jarvis-key": ENV.JARVIS_PASSWORD }, asLocal = { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN };
let qclock;
function cloud() {
  const store = memoryStore();
  qclock = new Date("2026-10-06T06:00:00Z");
  return { store, handler: createMailRequestHandler({ getStore: async () => store, env: (k) => ENV[k], now: () => qclock }) };
}
const req = (method, body, headers = {}) => new Request("https://jarvis.test/api/mail-requests", { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
const viaHandler = (handler) => async (url, opts = {}) => handler(new Request(url, opts));
const MAIL = { recipient: "anna@laden.ch", subject: "Ihr Website-Check", body: "Guten Tag Frau Muster, wie besprochen ..." };

test("Cloud-Auftrag: Auth OK, ohne Auth abgelehnt, Rollen getrennt", async () => {
  const { handler } = cloud();
  assert.equal((await handler(req("POST", { op: "create", ...MAIL }))).status, 401);
  assert.equal((await handler(req("POST", { op: "create", ...MAIL }, { "x-jarvis-key": "falsch" }))).status, 401);
  assert.equal((await handler(req("POST", { op: "create", ...MAIL }, asLocal))).status, 403, "lokaler Token legt keine Aufträge an");
  const r = await handler(req("POST", { op: "create", ...MAIL }, asUser));
  assert.equal(r.status, 201);
  const { request } = await r.json();
  assert.equal(request.status, "pending");
  for (const k of ["request_id", "created_at", "expires_at", "recipient", "subject", "intent", "status"]) assert.ok(k in request, k);
  assert.equal((await handler(req("POST", { op: "result", request_id: request.request_id, status: "sent" }, asUser))).status, 403, "Browser meldet keine Ergebnisse");
  assert.equal((await handler(req("GET", null))).status, 401);
});

test("Cloud-Auftrag: Idempotenz, Duplikat-Schutz, Grössen- und Queue-Limits, keine Anhänge, keine Shell", async () => {
  const { handler, store } = cloud();
  const a = await (await handler(req("POST", { op: "create", request_id: "mr-test-0001", ...MAIL }, asUser))).json();
  const again = await handler(req("POST", { op: "create", request_id: "mr-test-0001", ...MAIL }, asUser));
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  assert.equal((await handler(req("POST", { op: "create", request_id: "mr-test-0001", ...MAIL, body: "anders" }, asUser))).status, 409);
  const dup = await (await handler(req("POST", { op: "create", ...MAIL }, asUser))).json();
  assert.equal(dup.request.request_id, a.request.request_id, "gleicher Inhalt → derselbe Auftrag");
  assert.equal((await handler(req("POST", { op: "create", ...MAIL, recipient: "keine-adresse" }, asUser))).status, 400);
  assert.equal((await handler(req("POST", { op: "create", ...MAIL, recipient: "a@b.ch, c@d.ch" }, asUser))).status, 400);
  assert.equal((await handler(req("POST", { op: "create", ...MAIL, body: "x".repeat(MAIL_REQUEST_LIMITS.bodyChars + 1) }, asUser))).status, 400);
  assert.equal((await handler(req("POST", JSON.stringify({ op: "create", ...MAIL, body: "x".repeat(20_000) }), asUser))).status, 413);
  assert.equal((await handler(req("POST", { op: "create", ...MAIL, attachments: [{ name: "a.exe" }] }, asUser))).status, 400);
  assert.equal((await handler(req("POST", { op: "create", ...MAIL, command: "rm -rf /" }, asUser))).status, 400, "keine ausführbaren Felder");
  assert.equal((await handler(req("POST", { op: "create", ...MAIL, access_token: "ya29.abcdefghijk" }, asUser))).status, 400);
  for (let i = 0; i < MAIL_REQUEST_LIMITS.pending - 1; i++) assert.equal((await handler(req("POST", { op: "create", ...MAIL, subject: "S" + i }, asUser))).status, 201);
  assert.equal((await handler(req("POST", { op: "create", ...MAIL, subject: "zu viel" }, asUser))).status, 429, "begrenzte Queue");
  assert.ok(JSON.stringify(store.peek()).length < 200_000);
  const src = read("mail-requests.js") + read("netlify/functions/mail-requests.mjs") + read("netlify/edge-functions/cloud.js");
  assert.ok(!/child_process|eval\(|new Function|gmail\.js|sendDraft|createDraft|\.secrets|gmail_token|refresh_token/.test(src.replace(/\/\/.*$/gm, "")), "Cloud: keine Shell, kein Gmail, keine Secrets");
});

test("Cloud-Auftrag: Ablaufzeit → expired (Cloud und lokal)", async () => {
  const { handler } = cloud();
  const { request } = await (await handler(req("POST", { op: "create", ...MAIL, ttl_hours: 1 }, asUser))).json();
  qclock = new Date(+qclock + 2 * 3600e3);
  const list = (await (await handler(req("GET", null, asUser))).json()).requests;
  assert.equal(list.find((r) => r.request_id === request.request_id).status, "expired");
  // lokal: abgelaufener Auftrag wird nie gesendet
  inboxAdd(createStore(dir), [{ ...request, body: MAIL.body, expires_at: "2026-10-06T06:30:00Z" }]);
  await worker().tick();
  assert.equal(readJson(CLOUD_INBOX)[request.request_id].status, "expired");
  assert.deepEqual(sends(), []);
});

test("Cloud ist keine Freigabe: ungültig, ohne Versandgrundlage, suppressed → blocked mit Grund", async () => {
  write("leads.json", [{ email: "ohne@grund.ch", approved: true }, { email: "weg@laden.ch", ...optIn("weg@laden.ch") }]);
  write("suppression.json", { "weg@laden.ch": { reason: "opt-out" } });
  const mk = (id, recipient) => ({ request_id: id, recipient, subject: "Hallo", body: "Text", status: "pending", expires_at: "2026-10-07T06:00:00Z", created_at: "2026-10-06T06:00:00Z" });
  inboxAdd(createStore(dir), [mk("mr-invalid-01", "kaputt"), mk("mr-nobasis-01", "ohne@grund.ch"), mk("mr-public-01", "info@gefunden.ch"), mk("mr-suppr-01", "weg@laden.ch")]);
  const r = await worker().tick();
  const inbox = readJson(CLOUD_INBOX);
  assert.deepEqual(Object.values(inbox).map((e) => e.status), ["blocked", "blocked", "blocked", "blocked"]);
  assert.match(inbox["mr-nobasis-01"].reason, /Keine Versandgrundlage/);
  assert.match(inbox["mr-public-01"].reason, /Keine Versandgrundlage/, "öffentliche Adresse allein genügt nicht");
  assert.match(inbox["mr-suppr-01"].reason, /gesperrt/);
  assert.match(inbox["mr-invalid-01"].reason, /ungültig/);
  assert.deepEqual(sends(), []);
  assert.ok(!g.calls.some((c) => c.startsWith("create")));
  assert.equal(r.cloudResults.length, 4);
});

test("gültiger Cloud-Auftrag (manual_chris_mail) erreicht den Worker, wird zeitnah gesendet und das Ergebnis geht zurück in die Cloud", async () => {
  const { handler, store } = cloud();
  const config = { token: ENV.JARVIS_SYNC_TOKEN, url: "https://jarvis.test/api/state" };
  // PC offline: Auftrag bleibt pending
  const { request } = await (await handler(req("POST", { op: "create", ...MAIL }, asUser))).json();
  assert.equal((await pullMailRequests({ config, fetchFn: async () => { throw new Error("offline"); } })).ok, false);
  assert.equal((await createMailQueue(store, { now: () => qclock }).list())[0].status, "pending");
  // Worker wieder online, zwischen den Fenstern: manueller Auftrag von Chris wird geprüft und sofort gesendet (kein Warten auf 14:30).
  write("leads.json", [{ email: MAIL.recipient, language: "de", ...optIn(MAIL.recipient) }]);
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: { name: "Chris Muster", email: "chris@x.ch" } }); // ohne offer: keine eigenen Erstkontakte
  const pulled = await pullMailRequests({ config, fetchFn: viaHandler(handler) });
  assert.equal(pulled.requests.length, 1);
  assert.equal(inboxAdd(createStore(dir), pulled.requests), 1);
  assert.equal(inboxAdd(createStore(dir), pulled.requests), 0, "idempotent");
  clock = BETWEEN;
  const r = await worker().tick();
  assert.equal(sends().length, 1, "zeitnah, nicht erst im Versandfenster");
  const sent = Object.values(g.reg.sent)[0];
  assert.equal(sent.to, MAIL.recipient);
  assert.equal(sent.window, null, "zählt nicht als Kampagne im Fenster");
  assert.equal(r.sends[0].mailClass, "manual_chris_mail");
  await pushInbox(createStore(dir), (x) => pushMailResult({ config, fetchFn: viaHandler(handler), ...x }));
  let cloudList = (await (await handler(req("GET", null, asUser))).json()).requests;
  assert.equal(cloudList[0].status, "sent");
  assert.equal(cloudList[0].request_id, request.request_id);
  // Endzustand unveränderlich; Cloud kennt keine Gmail-Interna
  assert.equal((await handler(req("POST", { op: "result", request_id: request.request_id, status: "failed" }, asLocal))).status, 409);
  const blob = JSON.stringify(store.peek());
  assert.ok(!/dr1|new|draft|thread_?id|token|secrets/i.test(blob.replace(/"optional_thread_reference":null/g, "")), "keine Gmail-IDs, Tokens oder Pfade in der Cloud");
  // Duplikat: zweiter Auftrag an denselben Empfänger als neuer Erstkontakt → blocked
  inboxAdd(createStore(dir), [{ ...request, body: MAIL.body, request_id: "mr-dup-0001", subject: "Nochmal", expires_at: "2026-10-07T12:00:00Z" }]);
  await worker().tick();
  assert.match(readJson(CLOUD_INBOX)["mr-dup-0001"].reason, /Duplikat/);
});

test("Cloud-Jarvis: Werkzeug mail_request legt nur einen strukturierten Auftrag an", async () => {
  process.env.ANTHROPIC_API_KEY ||= "";
  const { createCloudHandler, MAIL_TOOL, statusBlock } = await import("../netlify/edge-functions/cloud.js");
  assert.equal(MAIL_TOOL.name, "mail_request");
  // Ausdrücklicher Sendebefehl → das Modell setzt delivery "send" (Pflichtfeld); fehlt es, wird nur ein Entwurf angelegt.
  assert.ok(MAIL_TOOL.input_schema.required.includes("delivery"));
  const SEND = { ...MAIL, delivery: "send" };
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const sse = ev({ type: "content_block_delta", delta: { type: "text_delta", text: "Gerne, Chris, ich gebe den Auftrag weiter. " } }) +
    ev({ type: "content_block_start", content_block: { type: "tool_use", name: "mail_request", id: "tu1" } }) +
    ev({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(SEND).slice(0, 20) } }) +
    ev({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(SEND).slice(20) } }) +
    ev({ type: "content_block_stop" });
  const queued = [];
  let upstreamBody;
  const h = createCloudHandler({
    env: (k) => ({ JARVIS_PASSWORD: "pw", ANTHROPIC_API_KEY: "k" })[k],
    loadState: async () => null,
    fetchFn: async (url, opts) => { upstreamBody = JSON.parse(opts.body); return new Response(sse); },
    enqueue: async (input) => { queued.push(input); return { status: 201, request: { request_id: "mr-x-00000001", recipient: input.recipient, subject: input.subject, status: "pending" } }; },
  });
  const res = await h(new Request("https://jarvis.test/api/cloud", { method: "POST", headers: { "x-jarvis-key": "pw" }, body: JSON.stringify({ messages: [{ role: "user", content: "Sende Anna die Mail." }] }) }));
  const out = await res.text();
  assert.deepEqual(upstreamBody.tools.map((t) => t.name), ["mail_request"]);
  assert.match(upstreamBody.system[1].text, /keine Freigabe/);
  assert.deepEqual(queued, [{ ...MAIL, intent: undefined, delivery: "send" }]);
  assert.match(out, /"type":"mail_request","ok":true/);
  assert.match(statusBlock({ business: { worker: { todaySent: 7, limit: 100, windows: { morning: { count: 7, limit: 50 } } } }, mailRequests: [{ recipient: "a@b.ch", status: "blocked", reason: "Keine Versandgrundlage" }] }), /7 von 100 \(Morgenfenster 09:30: 7 von 50.*Letzte Mailaufträge: a@b\.ch – blocked \(Keine Versandgrundlage\)/s);
});

// ---------- 11. Local Core ----------

test("Local Core: verwaistes Lock nach Neustart (wiederverwendete PID) blockiert den Autostart nicht", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-core-"));
  const file = path.join(d, "core.lock");
  fs.writeFileSync(file, String(process.ppid)); // altes Format: nur PID eines lebenden fremden Prozesses
  assert.equal(acquireSupervisorLock(d, process.pid), true, "altes Lock ohne Herzschlag gilt als verwaist");
  releaseSupervisorLock(d, process.pid);
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, beat: Date.now() - LOCK_STALE_MS - 1000 }));
  assert.equal(acquireSupervisorLock(d, process.pid), true, "Herzschlag zu alt → übernehmen");
  releaseSupervisorLock(d, process.pid);
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, beat: Date.now() }));
  assert.equal(acquireSupervisorLock(d, process.pid), false, "lebender Aufpasser mit frischem Herzschlag bleibt allein");
  assert.match(read("local-core.js"), /setInterval\(\(\) => supervisorHeartbeat\(dir\), 30_000\)/);
});

test("Local Core nur auf 127.0.0.1, Worker unabhängig, HUD pollt moderat", () => {
  const server = read("server.js");
  assert.match(server, /server\.listen\(PORT, "127\.0\.0\.1"/);
  assert.ok(!/0\.0\.0\.0/.test(server + read("local-core.js") + read("install-local-core.ps1").replace(/#.*$/gm, "")));
  assert.match(read("public/index.html"), /createModeDetector\(\{ probeLocal, probeCloud, onChange: applyMode, isBusy: \(\) => busy, intervalMs: 20_000 \}\)/);
  assert.ok(!/server\.js|localhost|127\.0\.0\.1/.test(read("mail-worker.js").replace(/\/\/.*$/gm, "")), "Mail-Worker ohne Local Core");
});

// ---------- 13. Zwei Angebote unverändert ----------

test("Two-Offer-Pipeline unverändert: nur CHF 150 und CHF 480", async () => {
  const { OFFER_CLASSES, OFFERS } = await import("../sales.js");
  assert.deepEqual(OFFER_CLASSES.map((c) => OFFERS[c].price), [150, 480]);
  for (const f of ["mail-requests.js", "netlify/edge-functions/cloud.js", "public/index.html", "persona.md"]) assert.doesNotMatch(read(f), /2['’]?490|Redesign-Angebot|Neubau-Angebot/i, f);
});
