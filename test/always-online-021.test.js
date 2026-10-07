// TF-JARVIS-ALWAYS-ONLINE-MAIL-021: Always-on Mail-Worker auf dem VPS, Windows offline, Leases, Send-Locks, Heartbeat.
// Ohne Netzwerk und ohne echte Mails: Gmail, Netlify Blobs, Anthropic-API und die Cloud-Endpunkte sind Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, workerIteration, resolveAuthority, healthy, heartbeat, pollMs, apiCompose, mailClassOf, createStore, zurichDay, CLOUD_INBOX, AUTHORITY_FILE, AiBudgetError, AI_BUDGET_EXHAUSTED, AI_BUDGET_FILE } from "../mail-worker.js";
import * as mailRequests from "../mail-requests.js";
import { createMailRequestHandler, createMailQueue, cloudSendGuard, acquireSendLock, finishSendLock, refHash, HEARTBEAT_STALE_MS, LEASE_MS } from "../mail-requests.js";
import { memoryStore, createStateHandler, findSensitiveKeys, sanitizeState } from "../shared-state.js";
import { createEscalationNotifier, createAiBudgetNotifier, createLocalState } from "../local-state.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const NIGHT = new Date("2026-10-06T20:00:00Z"); // 22:00 Zürich – kein Versandfenster
const MORNING = new Date("2026-10-06T07:35:00Z"); // 09:35 Zürich
// TF-024: vollständig belegte Grundlagen (Empfänger, Quelle, Datum, Umfang, Beleg, vorher eingeholt, aktiv, Vertrauen HIGH).
const OPTIN = { approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular helvetic-webdesign.ch mit Einwilligungs-Checkbox",
  consentScope: "Hinweise und Angebote zu Website-Prüfung und Website-Reparatur von Helvetic Webdesign", consentEvidence: "Double-Opt-in bestätigt am 2026-09-01 (Formular-Eintrag 4711)",
  obtainedBeforeMarketingSend: true, withdrawalStatus: "active", consentConfidence: "HIGH" };
const optIn = (email) => ({ ...OPTIN, consentRecipient: email });
const CUSTOMER = { approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true,
  customerRelationshipEvidence: "Auftrag und Rechnung 2025-118 (Website-Wartung)", relationshipDate: "2025-05-10", previousService: "Website-Wartung",
  advertisedService: "Website-Reparatur", similarityRationale: "Gleiche Website, gleiche Art Leistung (Pflege/Reparatur)", emailSource: "Kundenkorrespondenz zum Auftrag 2025-118",
  sameProvider: true, optOutStatus: "none", customerConfidence: "HIGH" };
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-windows-token", JARVIS_MAIL_WORKER_TOKEN: "vps-worker-token" };
const MAIL = { recipient: "anna@laden.ch", subject: "Ihr Website-Check", body: "Guten Tag Frau Muster, wie besprochen sende ich Ihnen die Infos." };
let clock, blob, env, handler, vpsDir, winDir, g;

// Gmail-Attrappe wie gmail.js: nur registrierte Threads lesbar, Register erst nach Erfolg, Tageslimit 100.
function fakeGmail() {
  const f = {
    reg: { labelId: "L", drafts: {}, sent: {} }, threads: {}, calls: [], n: 0,
    listOwned: () => structuredClone(f.reg),
    async readThread(threadId) {
      f.calls.push("read " + threadId);
      if (!Object.values(f.reg.sent).some((s) => s.threadId === threadId)) throw new Error(`Thread ${threadId} wurde nicht von Jarvis begonnen – Zugriff verweigert.`);
      return { threadId, messages: structuredClone(f.threads[threadId] || []) };
    },
    async replyToThread(threadId, { body }) {
      f.calls.push("reply " + threadId);
      const id = "dr" + ++f.n, ext = (f.threads[threadId] || []).filter((m) => !m.sent).at(-1);
      f.reg.drafts[id] = { threadId, to: ext ? ext.from : Object.values(f.reg.sent).find((s) => s.threadId === threadId).to, body, createdAt: clock.toISOString() };
      return { draftId: id, threadId };
    },
    async createDraft({ to, subject, body }) {
      f.calls.push("create " + to);
      const id = "dr" + ++f.n;
      f.reg.drafts[id] = { threadId: "new" + id, to, subject, body, createdAt: clock.toISOString() };
      return { draftId: id, threadId: "new" + id };
    },
    async updateDraft(id, { body }) { f.reg.drafts[id].body = body; return { draftId: id, threadId: f.reg.drafts[id].threadId }; },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft(id, { window = null } = {}) {
      f.calls.push("SEND " + id);
      const d = f.reg.drafts[id];
      if (!d) throw new Error("nicht von Jarvis");
      const today = Object.values(f.reg.sent).filter((s) => zurichDay(new Date(s.sentAt)) === zurichDay(clock));
      if (today.length >= 100) throw new Error("Tageslimit");
      if (window && today.filter((s) => s.window === window).length >= 50) throw new Error("Fensterlimit");
      delete f.reg.drafts[id];
      f.reg.sent["sent-" + id] = { threadId: d.threadId, to: d.to, subject: d.subject, body: d.body, fromDraft: id, window, sentAt: clock.toISOString() };
      return { messageId: "sent-" + id };
    },
  };
  return f;
}
// Jarvis hat an `to` gesendet (registrierter Thread `tid`), optional mit einer eingehenden Antwort.
function ownThread(tid, { to = "kunde@firma.ch", reply = null, from = to } = {}) {
  const at = +clock - 86_400_000;
  g.reg.sent["s-" + tid] = { threadId: tid, to, subject: "Ihre Website", sentAt: new Date(at).toISOString() };
  g.threads[tid] = [{ messageId: "s-" + tid, from: "Chris <chris@x.ch>", to, subject: "Ihre Website", body: "Hallo", sent: true, draft: false, internalDate: at },
    ...(reply ? [{ messageId: "in-" + tid, from: `Kunde <${from}>`, replyTo: "", to: "chris@x.ch", subject: "Re: Ihre Website", body: reply, sent: false, draft: false, internalDate: at + 3600e3 }] : [])];
}
const write = (dir, name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const sends = () => g.calls.filter((c) => c.startsWith("SEND"));
const viaHandler = (h) => async (url, opts = {}) => h(new Request(url, opts));
const URL_STATE = "https://jarvis.test/api/state";
const vpsConfig = { token: ENV.JARVIS_MAIL_WORKER_TOKEN, workerToken: ENV.JARVIS_MAIL_WORKER_TOKEN, url: URL_STATE };
const winConfig = { token: ENV.JARVIS_SYNC_TOKEN, workerToken: "", url: URL_STATE };
const req = (method, body, headers = {}) => new Request("https://jarvis.test/api/mail-requests", { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const asUser = { "x-jarvis-key": ENV.JARVIS_PASSWORD };
const autoConfig = (dir) => write(dir, "config.json", { dryRun: false, sendMode: "compliant_auto", sender: { name: "Chris Muster", email: "chris@x.ch" } });
const createRequest = async (input = MAIL) => (await (await handler(req("POST", { op: "create", ...input }, asUser))).json()).request;
const cloudList = async () => (await (await handler(req("GET", null, asUser))).json());
let escalated;
function makeWorker(dir, config, { compose, aiPaused = async () => {} } = {}) {
  return createWorker({ dir, gmail: g, now: () => clock, log: () => {}, escalate: async (e) => { escalated.push(e); }, aiPaused,
    compose: compose || (async () => ({ decision: "draft", reason: "", subject: "Re", body: "Guten Tag, gerne beantworte ich Ihre Frage.\n\nChris Muster" })),
    sendGuard: cloudSendGuard({ config, fetchFn: viaHandler(handler) }) });
}
const iterate = (role, dir, config, opts) => workerIteration({ role, store: createStore(dir), worker: makeWorker(dir, config, opts), config, mailRequests, fetchFn: viaHandler(handler), startedAt: clock.toISOString() });

beforeEach(() => {
  clock = NIGHT;
  blob = memoryStore();
  env = { ...ENV };
  handler = createMailRequestHandler({ getStore: async () => blob, env: (k) => env[k], now: () => clock });
  vpsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-021-vps-"));
  winDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-021-win-"));
  g = fakeGmail();
  escalated = [];
  autoConfig(vpsDir);
  autoConfig(winDir);
});

// ---------- Start, Healthcheck, Restart-Policy ----------

test("VPS-Worker: Start, Heartbeat, Docker-Healthcheck und restart: unless-stopped", async () => {
  const it = await iterate("vps", vpsDir, vpsConfig);
  assert.equal(it.standby, false);
  assert.equal(it.heartbeat, true, "Heartbeat an die Cloud");
  const { service } = await cloudList();
  assert.deepEqual([service.online, service.authority, service.worker], [true, "vps", "vps"]);
  // Healthcheck liest den Lock-Herzschlag des laufenden Prozesses.
  assert.equal(healthy(vpsDir), false, "ohne laufenden Worker ungesund");
  heartbeat(vpsDir);
  assert.equal(healthy(vpsDir), true);
  assert.equal(healthy(vpsDir, Date.now() + 6 * 60_000), false, "Herzschlag älter als 5 Minuten → ungesund");
  const compose = read("deploy/vps/docker-compose.yml"), docker = read("deploy/vps/Dockerfile");
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /test: \["CMD", "node", "mail-worker.js", "--healthcheck"\]/);
  assert.match(compose, /- \.\/secrets:\/data\/secrets/);
  assert.match(docker, /JARVIS_WORKER_ROLE=vps/);
  assert.match(docker, /HEALTHCHECK .*--healthcheck/);
  assert.ok(!/\.secrets|gmail_token|gmail_credentials|\.env/.test(docker.replace(/^#.*$/gm, "")), "keine Secrets im Image");
  // Jedes lokal (transitiv) importierte Modul muss im Image liegen – sonst Crash-Loop ERR_MODULE_NOT_FOUND auf dem VPS.
  const copied = new Set(docker.match(/^COPY (.+) \.\/$/m)[1].split(/\s+/));
  const seen = new Set(), todo = ["mail-worker.js"];
  while (todo.length) {
    const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const [, dep] of read(f).matchAll(/(?:from|import\()\s*["']\.\/([\w.-]+\.js)["']/g)) todo.push(dep);
  }
  for (const f of seen) assert.ok(copied.has(f), `Dockerfile COPY fehlt ${f}`);
  assert.equal(pollMs({ pollMinutes: 5 }, { JARVIS_POLL_MINUTES: "2" }), 120_000, "VPS: alle 2 Minuten");
  assert.equal(pollMs({ pollMinutes: 0 }, { JARVIS_POLL_MINUTES: "0.1" }), 60_000, "nie aggressiver als 1 Minute");
});

test("VPS ohne anerkannten Token (Netlify noch nicht umgestellt): Standby, liest kein Gmail, sendet nichts", async () => {
  delete env.JARVIS_MAIL_WORKER_TOKEN;
  ownThread("t1", { reply: "Was kostet der Check genau?" });
  const it = await iterate("vps", vpsDir, vpsConfig);
  assert.equal(it.standby, true);
  assert.deepEqual(g.calls, [], "kein Gmail-Zugriff");
});

// ---------- Windows offline: Cloud → VPS → Gmail (Attrappe) → Status zurück ----------

test("Windows Local Core OFFLINE: Cloud-Auftrag → VPS übernimmt → Mock-Mail gesendet → Status SENT in der Cloud", async () => {
  write(vpsDir, "leads.json", [{ email: MAIL.recipient, language: "de", ...optIn(MAIL.recipient) }]);
  const request = await createRequest();
  assert.equal(request.status, "pending");
  assert.equal(request.mail_class, "manual_chris_mail");
  // Kein Windows-Durchlauf in diesem Test: der PC ist aus.
  const it = await iterate("vps", vpsDir, vpsConfig);
  assert.equal(it.standby, false);
  assert.equal(sends().length, 1, "zeitnah um 22:00 – kein Warten auf 09:30");
  assert.equal(Object.values(g.reg.sent)[0].to, MAIL.recipient);
  assert.equal(Object.values(g.reg.sent)[0].window, null);
  const { requests, service } = await cloudList();
  assert.equal(requests[0].status, "sent");
  assert.equal(service.online, true);
  assert.equal(service.sent_today, 1);
  assert.equal(service.pending, 0);
});

test("Lease: übernommener Auftrag ist PROCESSING und gehört nur dem VPS", async () => {
  const request = await createRequest();
  const claim = await mailRequests.claimMailRequests({ config: vpsConfig, fetchFn: viaHandler(handler) });
  assert.equal(claim.requests[0].request_id, request.request_id);
  assert.equal(claim.requests[0].status, "processing");
  assert.equal(claim.requests[0].lease_owner, "vps");
  assert.ok(Date.parse(claim.requests[0].lease_expires_at) - +clock === LEASE_MS);
  assert.equal((await cloudList()).requests[0].status, "processing");
  assert.ok(!("lease_owner" in (await cloudList()).requests[0]), "Browser sieht keinen Lease-Inhaber");
  // Windows (Sync-Token) darf weder übernehmen noch Ergebnisse melden
  const win = await mailRequests.claimMailRequests({ config: winConfig, fetchFn: viaHandler(handler) });
  assert.deepEqual([win.ok, win.requests.length, win.authority.self, win.authority.holder], [true, 0, false, "vps"]);
  assert.equal((await mailRequests.pushMailResult({ config: winConfig, fetchFn: viaHandler(handler), request_id: request.request_id, status: "sent" })).status, 403);
});

test("Eingehende Antworten 24/7: registrierter Thread erkannt, fremder Thread ignoriert, sichere Antwort automatisch gesendet", async () => {
  ownThread("t1", { reply: "Danke! Was umfasst der Website-Check genau?" });
  g.threads.tFremd = [{ messageId: "x", from: "boss@firma.ch", body: "Privat", sent: false, draft: false, internalDate: +clock }];
  write(vpsDir, "state.json", { compliantThreads: { t1: { to: "kunde@firma.ch", basis: "opt_in" } } });
  const it = await iterate("vps", vpsDir, vpsConfig);
  assert.ok(g.calls.includes("read t1"));
  assert.ok(!g.calls.some((c) => c.includes("tFremd")), "fremder Gmail-Thread nie gelesen");
  assert.equal(sends().length, 1, "sichere Antwort um 22:00 gesendet");
  assert.equal(it.result.sends[0].mailClass, "conversation_reply");
  assert.equal(it.result.windows.morning.sent + it.result.windows.afternoon.sent, 0, "zählt nicht als Sales-Send");
  assert.deepEqual(escalated, []);
  assert.equal((await cloudList()).service.sent_today, 1);
});

test("Risiko-Antwort: nicht gesendet, Entwurf zur Prüfung, Eskalation an Chris (Cloud und Local)", async () => {
  for (const [tid, text] of [["t1", "Können Sie mir 20 % Rabatt geben? Ich überweise dann sofort."], ["t2", "Schicken Sie mir bitte den Vertrag zur Unterschrift."], ["t3", "Wie lautet Ihre Bankverbindung?"]]) ownThread(tid, { to: `${tid}@firma.ch`, reply: text });
  ownThread("t4", { to: "chef@firma.ch", from: "unbekannt@anders.ch", reply: "Bitte senden Sie mir die Unterlagen." }); // unklare Identität
  write(vpsDir, "state.json", { compliantThreads: Object.fromEntries(["t1", "t2", "t3", "t4"].map((t) => [t, { basis: "opt_in" }])) });
  const it = await iterate("vps", vpsDir, vpsConfig);
  assert.deepEqual(sends(), [], "nichts autonom gesendet");
  assert.equal(g.calls.filter((c) => c.startsWith("review")).length, 4, "Entwürfe als JARVIS-PRUEFEN markiert");
  assert.equal(escalated.length, 4);
  assert.match(escalated.find((e) => e.threadId === "t4").reason, /unklare Identität/);
  assert.match(escalated.find((e) => e.threadId === "t1").reason, /heikler Inhalt/);
  assert.equal(it.result.stats.escalations_today, 4);
  assert.equal((await cloudList()).service.escalations_today, 4, "Status in der Cloud");
  // Meldung: lokal gespeichert, Typ mail_escalation, sicher für den Shared State
  const file = path.join(vpsDir, "mirror.json");
  const local = createLocalState({ file, now: () => clock });
  const notify = createEscalationNotifier({ local, toast: async () => ({ ok: false }), sync: async () => ({ ok: true }) });
  await notify({ messageId: "in-t1", threadId: "t1", company: "Firma AG", reason: "heikler Inhalt: rabatt" });
  assert.equal((await notify({ messageId: "in-t1", threadId: "t1", company: "Firma AG", reason: "x" })).duplicate, true, "je Nachricht nur einmal");
  const n = sanitizeState(local.read()).notifications;
  assert.deepEqual([n.length, n[0].type, n[0].priority], [1, "mail_escalation", "high"]);
  assert.deepEqual(findSensitiveKeys(sanitizeState(local.read())), []);
});

test("Opt-out und Suppression blockieren Antworten und manuelle Aufträge", async () => {
  ownThread("t1", { reply: "Bitte keine weiteren Mails, abmelden." });
  write(vpsDir, "state.json", { compliantThreads: { t1: { basis: "opt_in" } } });
  write(vpsDir, "leads.json", [{ email: "weg@laden.ch", ...optIn("weg@laden.ch") }]);
  write(vpsDir, "suppression.json", { "weg@laden.ch": { reason: "opt-out" } });
  const rq = await createRequest({ ...MAIL, recipient: "weg@laden.ch" });
  await iterate("vps", vpsDir, vpsConfig);
  assert.deepEqual(sends(), []);
  assert.ok(readJson(vpsDir, "suppression.json")["kunde@firma.ch"], "Opt-out dauerhaft gesperrt");
  const { requests } = await cloudList();
  assert.equal(requests.find((r) => r.request_id === rq.request_id).status, "blocked");
  assert.match(requests.find((r) => r.request_id === rq.request_id).reason, /gesperrt/);
});

test("Manueller Auftrag ohne Versandgrundlage bleibt blockiert – keine neue Cold-Mail-Ausnahme", async () => {
  write(vpsDir, "leads.json", [{ email: "info@gefunden.ch", approved: true, emailSource: "https://gefunden.ch/impressum" }]);
  await createRequest({ ...MAIL, recipient: "info@gefunden.ch" });
  await iterate("vps", vpsDir, vpsConfig);
  assert.deepEqual(sends(), []);
  assert.match((await cloudList()).requests[0].reason, /Keine Versandgrundlage/);
});

// ---------- Kampagnen bleiben an die Fenster gebunden ----------

test("Klassen: A/B nur im Fenster (50 + 50, Tag 100, 101. blockiert), C/D sofort", async () => {
  assert.deepEqual(["erstkontakt", "follow-up 1", "antwort", "cloud-auftrag"].map((kind) => mailClassOf({ kind })),
    ["automatic_sales_outreach", "sales_followup", "conversation_reply", "manual_chris_mail"]);
  // 60 vorbereitete Follow-ups: nachts 0, morgens 50, nachmittags 10
  const st = { actions: {}, compliantThreads: {} };
  for (let i = 0; i < 160; i++) {
    g.reg.drafts["d" + i] = { threadId: "ft" + i, to: `k${i}@x.ch`, createdAt: "2026-10-05T10:00:00Z" };
    st.actions[`followup:ft${i}:1`] = { status: "prepared", autoSend: true, paced: true, kind: "follow-up 1", draftId: "d" + i, threadId: "ft" + i, to: `k${i}@x.ch`, at: "2026-10-05T10:00:00Z" };
    st.compliantThreads["ft" + i] = { basis: "opt_in" };
  }
  write(vpsDir, "state.json", st);
  clock = new Date("2026-10-06T04:00:00Z"); // 06:00 Zürich
  await iterate("vps", vpsDir, vpsConfig);
  assert.equal(sends().length, 0, "Kampagne nachts: 0");
  clock = MORNING;
  const m = await iterate("vps", vpsDir, vpsConfig);
  assert.equal(sends().length, 50, "09:30: max 50");
  clock = new Date("2026-10-06T12:35:00Z");
  const a = await iterate("vps", vpsDir, vpsConfig);
  assert.equal(sends().length, 100, "14:30: max 50, Tag 100");
  assert.deepEqual([a.result.stats.campaign_morning, a.result.stats.campaign_afternoon, a.result.stats.campaign_today], [50, 50, 100]);
  clock = new Date("2026-10-06T14:00:00Z");
  await iterate("vps", vpsDir, vpsConfig);
  assert.equal(sends().length, 100, "101. Kampagnen-Send blockiert");
  const s = (await cloudList()).service.sales;
  assert.deepEqual([s.morning, s.afternoon, s.today, s.daily_limit], [50, 50, 100, 100]);
  assert.equal(m.result.stats.campaign_morning, 50);
});

// ---------- Duplikatschutz Windows / VPS ----------

test("Send-Lock: genau einmal – zweiter Owner abgewiesen, nach SENT nie wieder, kein Übergang nach Ablauf", () => {
  const key = refHash("reply:msg-1");
  let r = acquireSendLock({}, { lock_key: key, thread_ref: refHash("t1", 12), message_ref: refHash("msg-1", 12), owner: "vps" }, clock);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.lock).sort(), ["lease_expires_at", "lease_owner", "lock_key", "message_ref", "request_id", "status", "thread_ref", "updated_at"]);
  const locks = r.locks;
  assert.equal(acquireSendLock(locks, { lock_key: key, owner: "local" }, clock).status, 409, "Windows bekommt das Lock nicht");
  assert.equal(acquireSendLock(locks, { lock_key: key, owner: "local" }, new Date(+clock + 2 * LEASE_MS)).status, 409, "auch nicht nach Ablauf (Ausgang unklar)");
  const sent = finishSendLock(locks, { lock_key: key, owner: "vps", status: "SENT" }, clock).locks;
  assert.equal(acquireSendLock(sent, { lock_key: key, owner: "vps" }, clock).status, 409, "nach SENT nie wieder senden");
  assert.equal(acquireSendLock({}, { lock_key: "kein-hash", owner: "vps" }, clock).status, 400);
});

test("Windows- und VPS-Worker gleichzeitig: Windows im Standby, auch ein erzwungener Windows-Send scheitert am Lock", async () => {
  ownThread("t1", { reply: "Wann könnten Sie starten?" });
  for (const d of [vpsDir, winDir]) write(d, "state.json", { compliantThreads: { t1: { basis: "opt_in" } } });
  // Beide Prozesse laufen im selben Moment
  const [win, vps] = await Promise.all([iterate("local", winDir, winConfig), iterate("vps", vpsDir, vpsConfig)]);
  assert.equal(win.standby, true, "Windows ist nicht send_authority");
  assert.equal(vps.standby, false);
  assert.equal(sends().length, 1, "genau ein Send");
  assert.equal(readJson(winDir, AUTHORITY_FILE).holder, "vps");
  // Selbst wenn ein alter Windows-Worker ohne Authority-Prüfung dieselbe Antwort vorbereitet und senden will: Lock → kein Send.
  const g2 = g; ownThread("t2", { reply: "Und wie lange dauert das?" });
  write(winDir, "state.json", { compliantThreads: { t2: { basis: "opt_in" } } });
  await makeWorker(winDir, winConfig).tick();
  assert.equal(sends().length, 1, "Windows sendet nie");
  assert.equal(Object.values(readJson(winDir, "state.json").actions).find((a) => a.threadId === "t2").status, "locked_elsewhere");
  assert.equal(g2, g);
  // Zwei VPS-Instanzen (z. B. Doppelstart) für dieselbe eingehende Nachricht: das Lock lässt nur eine senden.
  const guard = cloudSendGuard({ config: vpsConfig, fetchFn: viaHandler(handler) });
  assert.equal((await guard.acquire({ key: "reply:in-t1" })).ok, false, "bereits gesendet");
});

test("Neustarts ändern die Authority nicht: Windows bleibt Standby, auch wenn die Cloud kurz nicht erreichbar ist", async () => {
  const store = createStore(winDir);
  assert.deepEqual(resolveAuthority(store, null), { holder: "local", self: true, checkedAt: null }, "ohne VPS: wie bisher lokal");
  resolveAuthority(store, { dedicated: true, holder: "vps", self: false }, clock);
  assert.equal(resolveAuthority(createStore(winDir), null).self, false, "Neustart + Cloud offline → weiter Standby");
  assert.equal(resolveAuthority(createStore(vpsDir), null, clock, false).self, false, "VPS ohne Bestätigung → Standby");
  // Nur eine ausdrückliche Cloud-Meldung (kein VPS-Token mehr) gibt Windows die Authority zurück.
  assert.equal(resolveAuthority(store, { dedicated: false, holder: "local", self: true }, clock).self, true);
  // Kein zweiter Supervisor für dieselbe Queue: Windows-Worker hat im Standby keinen Gmail-Zugriff.
  ownThread("t1", { reply: "Frage" });
  write(winDir, AUTHORITY_FILE, { holder: "vps", self: false });
  const it = await workerIteration({ role: "local", store: createStore(winDir), worker: makeWorker(winDir, winConfig), config: winConfig, mailRequests, fetchFn: async () => { throw new Error("offline"); } });
  assert.equal(it.standby, true);
  assert.deepEqual(g.calls, []);
});

// ---------- Failover und Recovery ----------

test("VPS offline: Aufträge bleiben PENDING, Cloud zeigt OFFLINE; nach Wiederanlauf ONLINE, Queue abgearbeitet, keine Duplikate", async () => {
  write(vpsDir, "leads.json", [{ email: MAIL.recipient, ...optIn(MAIL.recipient) }, { email: "bob@laden.ch", ...optIn("bob@laden.ch") }]);
  await iterate("vps", vpsDir, vpsConfig); // war online
  clock = new Date(+clock + HEARTBEAT_STALE_MS + 60_000); // Ausfall
  const a = await createRequest(), b = await createRequest({ ...MAIL, recipient: "bob@laden.ch" });
  let c = await cloudList();
  assert.equal(c.service.online, false, "MAIL SERVICE OFFLINE");
  assert.deepEqual(c.requests.map((r) => r.status), ["pending", "pending"]);
  assert.equal(c.service.pending, 2);
  // Wiederanlauf (neue Worker-Instanz, gleicher Zustand)
  clock = new Date(+clock + 60_000);
  await iterate("vps", vpsDir, vpsConfig);
  c = await cloudList();
  assert.equal(c.service.online, true, "MAIL SERVICE ONLINE");
  assert.deepEqual(c.requests.map((r) => r.status), ["sent", "sent"]);
  // Erneuter Durchlauf und Neustart: nichts doppelt
  await iterate("vps", vpsDir, vpsConfig);
  assert.equal(sends().length, 2);
  assert.deepEqual(Object.values(g.reg.sent).map((s) => s.to).sort(), ["anna@laden.ch", "bob@laden.ch"]);
  assert.ok(a.request_id !== b.request_id);
});

test("Absturz nach Übernahme (PROCESSING): derselbe VPS übernimmt den Auftrag nach Neustart, nichts geht verloren", async () => {
  write(vpsDir, "leads.json", [{ email: MAIL.recipient, ...optIn(MAIL.recipient) }]);
  const rq = await createRequest();
  await mailRequests.claimMailRequests({ config: vpsConfig, fetchFn: viaHandler(handler) }); // übernommen, dann Absturz ohne lokale Ablage
  assert.equal((await cloudList()).requests[0].status, "processing");
  clock = new Date(+clock + 30_000);
  await iterate("vps", vpsDir, vpsConfig); // Neustart
  assert.equal(sends().length, 1);
  assert.equal((await cloudList()).requests[0].status, "sent");
  assert.equal(readJson(vpsDir, CLOUD_INBOX)[rq.request_id].status, "sent");
  // Absturz mitten im Senden: Status "sending" → nach Neustart nie erneut (send_unknown), Lock bleibt beim VPS
  const st = readJson(vpsDir, "state.json");
  g.reg.drafts.dX = { threadId: "tx", to: "x@laden.ch" };
  st.actions["reply:mX"] = { status: "sending", kind: "antwort", draftId: "dX", threadId: "tx", to: "x@laden.ch", autoSend: true, at: clock.toISOString() };
  write(vpsDir, "state.json", st);
  await iterate("vps", vpsDir, vpsConfig);
  assert.equal(sends().length, 1);
  assert.equal(readJson(vpsDir, "state.json").actions["reply:mX"].status, "send_unknown");
});

// ---------- Sicherheit ----------

test("Keine Secrets in der Cloud: Blob ohne Gmail-IDs, Adressen in Locks oder Tokens; Heartbeat nur Zahlen", async () => {
  ownThread("t1", { reply: "Wie geht es weiter?" });
  write(vpsDir, "state.json", { compliantThreads: { t1: { basis: "opt_in" } } });
  await mailRequests.sendHeartbeat({ config: vpsConfig, fetchFn: viaHandler(handler), stats: { sent_today: 1, access_token: "ya29.geheim", campaign_today: "x" } });
  await iterate("vps", vpsDir, vpsConfig);
  const raw = JSON.stringify(blob.peek());
  for (const s of ["t1", "in-t1", "dr1", "kunde@firma.ch", "ya29", ENV.JARVIS_MAIL_WORKER_TOKEN, ENV.JARVIS_SYNC_TOKEN, "refresh_token", "gmail"]) assert.ok(!raw.includes(s), `nicht in der Cloud: ${s}`);
  const lock = Object.values(blob.peek().locks)[0];
  assert.match(lock.lock_key, /^[a-f0-9]{24}$/);
  assert.match(lock.thread_ref, /^[a-f0-9]{12}$/);
  assert.equal(lock.status, "SENT");
  assert.deepEqual(Object.keys(blob.peek().workers.vps.stats).sort(), ["ai_paused", "blocked_today", "campaign_afternoon", "campaign_morning", "campaign_today", "escalations_today", "manual_today", "replies_today", "sent_today"]);
  // Browser-Antwort enthält weder Lease-Inhaber noch Tokens
  const pub = JSON.stringify(await cloudList());
  assert.ok(!/lease_owner|token|fingerprint/.test(pub));
});

test("Keine Gmail-Credentials an Netlify/Browser/Git; Cloud ohne Shell und ohne direkten PC-Zugriff", async () => {
  const cloudSrc = ["mail-requests.js", "netlify/functions/mail-requests.mjs", "netlify/functions/state.mjs", "netlify/edge-functions/cloud.js", "shared-state.js"].map(read).join("\n").replace(/\/\/.*$/gm, "");
  assert.ok(!/child_process|eval\(|new Function|gmail\.js|sendDraft|createDraft|\.secrets|gmail_token|gmail_credentials|refresh_token|localhost|127\.0\.0\.1/.test(cloudSrc));
  assert.ok(!/gmail_token|gmail_credentials|refresh_token|client_secret/.test(read("public/index.html")));
  assert.match(read(".gitignore"), /^\.secrets\/$/m);
  assert.match(read(".gitignore"), /^deploy\/vps\/\.env$/m);
  assert.match(read("deploy/vps/deploy.sh"), /chmod 600/);
  // Unbekannte Operationen (z. B. Befehle) werden abgewiesen – mit jedem Token.
  for (const h of [asUser, { "x-jarvis-worker": ENV.JARVIS_MAIL_WORKER_TOKEN }, { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }])
    assert.equal((await handler(req("POST", { op: "exec", command: "rm -rf /" }, h))).status, 400);
  assert.equal((await handler(req("POST", { op: "claim" }, asUser))).status, 403, "Browser übernimmt keine Aufträge");
  assert.equal((await handler(req("POST", { op: "heartbeat" }, { "x-jarvis-worker": "falsch" }))).status, 401);
  // Worker-Token gilt auch für den Zustandsabgleich, ein falscher nicht
  const state = createStateHandler({ getStore: async () => memoryStore(), env: (k) => env[k] });
  const sync = (tok) => state(new Request(URL_STATE, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-sync": tok }, body: JSON.stringify({ op: "sync", state: {} }) }));
  assert.equal((await sync(ENV.JARVIS_MAIL_WORKER_TOKEN)).status, 200);
  assert.equal((await sync("falsch")).status, 401);
});

test("Texte auf dem VPS über die Anthropic-API: Schlüssel nur im Header, unlesbare Antwort → Eskalation", async () => {
  let sent;
  const ok = apiCompose({ apiKey: "sk-ant-test-key", system: "Schreibe.", fetchFn: async (url, opts) => { sent = { url, opts }; return new Response(JSON.stringify({ content: [{ type: "text", text: '{"decision":"draft","body":"Guten Tag"}' }] })); } });
  assert.deepEqual(await ok({ kind: "reply" }), { decision: "draft", reason: "", body: "Guten Tag" });
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.opts.headers["x-api-key"], "sk-ant-test-key");
  assert.ok(!sent.opts.body.includes("sk-ant-test-key"));
  const bad = apiCompose({ apiKey: "k", system: "x", fetchFn: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "kein json" }] })) });
  assert.equal((await bad({})).decision, "escalate");
  await assert.rejects(apiCompose({ apiKey: "", system: "x" })({}), /ANTHROPIC_API_KEY fehlt/);
});

test("Two-Offer-Pipeline unverändert und keine Preisangebote im neuen Code", async () => {
  const { OFFER_CLASSES, OFFERS } = await import("../sales.js");
  assert.deepEqual(OFFER_CLASSES.map((c) => OFFERS[c].price), [150, 480]);
  for (const f of ["deploy/vps/docker-compose.yml", "deploy/vps/Dockerfile", "mail-requests.js", "public/index.html"]) assert.doesNotMatch(read(f), /2['’]?490|Redesign-Angebot|Neubau-Angebot/i, f);
});

// ---------- Anthropic-API-Guthaben: fail closed (Billing-Fehler gemockt, keine echte API-Belastung) ----------

const apiError = (status, type, message) => async () => new Response(JSON.stringify({ type: "error", error: { type, message } }), { status });

test("Anthropic-Guthaben leer: genau ein Versuch, AI_BUDGET_EXHAUSTED, kein Retry/kein anderer Schlüssel/kein anderer Anbieter", async () => {
  let calls = 0;
  const count = (f) => async (...a) => { calls++; return f(...a); };
  const low = apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.");
  await assert.rejects(apiCompose({ apiKey: "k", system: "x", fetchFn: count(low) })({}), (e) => e.code === AI_BUDGET_EXHAUSTED && !/429|5\d\d|rate|quota|network/i.test(e.message));
  assert.equal(calls, 1, "kein Retry");
  await assert.rejects(apiCompose({ apiKey: "k", system: "x", fetchFn: apiError(402, "billing_error", "Payment required") })({}), (e) => e.code === AI_BUDGET_EXHAUSTED);
  await assert.rejects(apiCompose({ apiKey: "k", system: "x", fetchFn: apiError(400, "invalid_request_error", "You have reached your specified API usage limits.") })({}), (e) => e.code === AI_BUDGET_EXHAUSTED);
  // Rate-Limit und Serverfehler sind keine Guthabenfrage; andere 400er auch nicht.
  await assert.rejects(apiCompose({ apiKey: "k", system: "x", fetchFn: apiError(429, "rate_limit_error", "Number of requests has exceeded your rate limit") })({}), (e) => !e.code && /HTTP 429/.test(e.message));
  await assert.rejects(apiCompose({ apiKey: "k", system: "x", fetchFn: apiError(400, "invalid_request_error", "max_tokens: too large") })({}), (e) => !e.code);
  // Genau ein Anbieter, ein Schlüssel aus der Umgebung, kein Fallback, keine Guthaben-Aufladung.
  const src = read("mail-worker.js");
  assert.equal(src.match(/https:\/\/api\.[a-z.]+\//g).length, 1);
  assert.deepEqual([...new Set(src.match(/process\.env\.[A-Z_]*(KEY|TOKEN)[A-Z_]*/g))], ["process.env.ANTHROPIC_API_KEY"]);
  assert.ok(!/openai|gemini|mistral|auto[-_ ]?reload|top[-_ ]?up/i.test(src.replace(/^\s*\/\/.*$/gm, "")));
});

test("AI_BUDGET_EXHAUSTED im Worker: keine zweite Anfrage, nichts gesendet, Aufträge bleiben, Meldung, Heartbeat läuft, Wiederaufnahme", async () => {
  ownThread("t1", { reply: "Danke! Was umfasst der Website-Check genau?" });
  ownThread("t2", { to: "b@firma.ch", reply: "Wann hätten Sie Zeit für den Check?" });
  write(vpsDir, "state.json", { compliantThreads: { t1: { basis: "opt_in" }, t2: { basis: "opt_in" } } });
  write(vpsDir, "leads.json", [{ email: MAIL.recipient, language: "de", ...optIn(MAIL.recipient) }]);
  let aiCalls = 0, credit = false;
  const paused = [];
  const compose = async () => { aiCalls++; if (!credit) throw new AiBudgetError("HTTP 400"); return { decision: "draft", reason: "", body: "Guten Tag, gerne.\n\nChris Muster" }; };
  const opts = { compose, aiPaused: async (x) => { paused.push(x); } };

  let it = await iterate("vps", vpsDir, vpsConfig, opts);
  assert.equal(aiCalls, 1, "nach dem ersten Guthabenfehler keine weitere KI-Anfrage");
  assert.deepEqual(sends(), [], "keine Mail ohne KI-Antwort");
  assert.deepEqual(Object.keys(g.reg.drafts), [], "kein Platzhalter-Entwurf");
  const b = readJson(vpsDir, AI_BUDGET_FILE);
  assert.equal(b.paused, true);
  assert.deepEqual(Object.values(b.deferred).map((d) => d.status), [AI_BUDGET_EXHAUSTED, AI_BUDGET_EXHAUSTED], "beide Antworten als AI_BUDGET_EXHAUSTED erhalten");
  assert.ok(!readJson(vpsDir, "state.json").handled?.["in-t1"], "Kundenantwort bleibt offen");
  assert.equal(paused.length, 1, "Chris wird benachrichtigt");
  assert.equal(it.heartbeat, true, "Heartbeat läuft weiter");
  assert.equal((await cloudList()).service.ai, "paused_credit", "HUD: AI SERVICE PAUSED — CREDIT LIMIT");

  // Nicht-KI-Funktionen laufen weiter: manueller Cloud-Auftrag (Text von Chris) wird gesendet.
  clock = new Date(+NIGHT + 2 * 60_000);
  const request = await createRequest();
  it = await iterate("vps", vpsDir, vpsConfig, opts);
  assert.equal(aiCalls, 1, "auch im nächsten Durchlauf keine KI-Anfrage");
  assert.equal(paused.length, 1, "Meldung nur einmal je Pause");
  assert.equal((await cloudList()).requests.find((r) => r.request_id === request.request_id).status, "sent");

  // Guthaben wieder da: ein Prüfversuch nach der Wartezeit, dann werden die offenen Antworten verarbeitet – je genau einmal.
  credit = true;
  clock = new Date(+NIGHT + 61 * 60_000);
  it = await iterate("vps", vpsDir, vpsConfig, opts);
  assert.equal(readJson(vpsDir, AI_BUDGET_FILE).paused, false);
  assert.deepEqual(readJson(vpsDir, AI_BUDGET_FILE).deferred, {});
  assert.equal(sends().length, 3, "Cloud-Auftrag + zwei Antworten");
  assert.equal((await cloudList()).service.ai, "online");
  clock = new Date(+NIGHT + 63 * 60_000);
  await iterate("vps", vpsDir, vpsConfig, opts);
  assert.equal(sends().length, 3, "keine Duplikate");
});

test("AI-Pause-Meldung für Chris: lokal und Cloud-sicher, einmal je Pause", async () => {
  const local = createLocalState({ file: path.join(vpsDir, "mirror.json"), now: () => clock });
  const notify = createAiBudgetNotifier({ local, toast: async () => ({ ok: false }), sync: async () => ({ ok: true }) });
  await notify({ since: "2026-10-06T20:00:00.000Z" });
  assert.equal((await notify({ since: "2026-10-06T20:00:00.000Z" })).duplicate, true);
  const n = sanitizeState(local.read()).notifications;
  assert.deepEqual([n.length, n[0].type, n[0].priority, n[0].summary], [1, "ai_budget_exhausted", "high", "Anthropic API-Guthaben aufgebraucht – Jarvis AI pausiert."]);
  assert.deepEqual(findSensitiveKeys(sanitizeState(local.read())), []);
});
