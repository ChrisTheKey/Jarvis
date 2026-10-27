// SEPARATE REPAIR SERVICE / ZERO-MAILING-DOWNTIME DEPLOY (TF-047) – hermetischer Teil (ohne Docker/Netz):
// Repair-Outbox (einziger Versandweg des Repair-Service, genau einmal über den Mail-Worker), voller CHF-480-Auftrag über
// runRepairOrders mit Outbox statt Gmail (Mail-Worker offline → nie «gesendet»; online → genau 1 Access-Mail + 1 Lieferung),
// Crash-/Fehler-Semantik, Isolation (keine zweite Sender Authority), Readiness des Repair-Service und Deploy-Artefakte
// (eigenes Compose-Projekt, nur repair-worker, nie compose down / Docker-Neustart). Der echte Container-Beweis (Mail-Worker
// ID/StartedAt/RestartCount unverändert) liegt in test/integration/service-separation-047/ (npm run test:separation-integration).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { REPAIR_ORDERS_FILE, FULFILLMENT_CLASS, createConfirmedRepairOrder, runRepairOrders, publicRepairOrders } from "../repair-workflow.js";
import { CHECK150_ORDERS_FILE, createCheck150Order, runCheck150Orders } from "../check-150-workflow.js";
import { recordDirectSale } from "../sales.js";
import { createAccessIntakeHandler, memoryIntakeStore } from "../access-intake-api.js";
import { intakeClient, sealEnvelope } from "../access-intake.js";
import { gateDecision } from "../repair-browser-validator.js";
import { createOutboxMailer, processRepairOutbox, outboxStatus, OUTBOX_PENDING, CONSUMER_FILE } from "../repair-outbox.js";
import { isolationViolations, repairServiceIteration, serviceHealthy, SERVICE_LOCK } from "../repair-service.js";
import { readinessReport, formatReport } from "../production-readiness.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-13T08:00:00Z");
const DOMAIN = "separation-kunde.test", SITE = `https://${DOMAIN}/`, EMAIL = "auftrag@separation-kunde.test";
const TEST_SECRET = "Sep47-Test-Secret-4b7d2a";
// Test-eigene Temp-Verzeichnisse – nach jedem Test wieder entfernt.
const made = [];
const tmp = (p = "jarvis-sep47-") => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const files = (dir) => fs.readdirSync(dir).sort();

// Attrappe für gmail.js auf Mail-Worker-Seite (Register mit sent/fromDraft wie gmail.listOwned).
function fakeGmail() {
  const calls = [], reg = { sent: {}, drafts: {} };
  let failCreate = null, failSend = null;
  return { calls, reg, failCreate: (m) => { failCreate = m; }, failSend: (m) => { failSend = m; },
    listOwned: () => reg,
    createDraft: async (x) => { if (failCreate) { const m = failCreate; failCreate = null; throw new Error(m); } calls.push({ op: "create", ...x }); const id = "dr" + calls.length; reg.drafts[id] = { to: x.to }; return { draftId: id }; },
    sendDraft: async (id) => { if (failSend) { const m = failSend; failSend = null; throw new Error(m); } calls.push({ op: "SEND", id }); reg.sent["m-" + id] = { fromDraft: id }; return { messageId: "m-" + id }; },
    sends: () => calls.filter((c) => c.op === "SEND").length,
    created: (cls) => calls.filter((c) => c.op === "create" && (!cls || c.messageClass === cls)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Outbox: Protokoll
// ---------------------------------------------------------------------------------------------------------------------
test("OUTBOX: nur Service-Klassen; Entwurf ist für den Mail-Worker unsichtbar; Übergabe → OUTBOX_PENDING; Mail-Worker sendet GENAU EINMAL; Inhalte danach gelöscht", async () => {
  const ob = tmp(), m = createOutboxMailer({ dir: ob }), g = fakeGmail();
  await assert.rejects(m.createDraft({ to: EMAIL, subject: "Hallo", body: "x", messageClass: "MARKETING" }), /nur Service-Mails/);
  await assert.rejects(m.createDraft({ to: "kaputt", subject: "Hallo", body: "x", messageClass: FULFILLMENT_CLASS }), /Empfänger/);
  const d = await m.createDraft({ to: EMAIL, subject: "Ihr Bericht", body: "Bericht v1", messageClass: FULFILLMENT_CLASS });
  await m.updateDraft(d.draftId, { body: "Bericht v2" });
  // Nur vorbereitet → der Mail-Worker sieht nichts.
  assert.deepEqual(await processRepairOutbox({ dir: ob, gmail: g }), { processed: 0, sent: 0, failed: 0, unclear: 0, rejected: 0, deferred: 0 });
  assert.equal(g.calls.length, 0);
  await assert.rejects(m.sendDraft(d.draftId), (e) => e.code === OUTBOX_PENDING);
  await assert.rejects(m.updateDraft(d.draftId, { body: "zu spät" }), /bereits übergeben/);
  await assert.rejects(m.sendDraft(d.draftId), (e) => e.code === OUTBOX_PENDING, "Mail-Worker offline: nie Erfolg");
  assert.equal(outboxStatus(ob).pending, 1);
  const r1 = await processRepairOutbox({ dir: ob, gmail: g });
  assert.deepEqual([r1.sent, g.sends(), g.created(FULFILLMENT_CLASS).length, g.created()[0].body, g.created()[0].to], [1, 1, 1, "Bericht v2", EMAIL]);
  for (let i = 0; i < 3; i++) await processRepairOutbox({ dir: ob, gmail: g });
  assert.equal(g.sends(), 1, "genau einmal – auch nach weiteren Durchläufen");
  assert.deepEqual(await m.sendDraft(d.draftId), { messageId: null, outbox: d.draftId });
  assert.deepEqual(files(ob), [CONSUMER_FILE, `${d.draftId}.claim`, `${d.draftId}.result.json`], "Adresse/Inhalt gelöscht");
  const res = JSON.parse(fs.readFileSync(path.join(ob, `${d.draftId}.result.json`), "utf8"));
  assert.ok(!JSON.stringify(res).includes(EMAIL) && !JSON.stringify(res).includes("Bericht"), "Ergebnis ohne Adresse/Inhalt");
  assert.equal(outboxStatus(ob).consumer_online, true);
});

test("OUTBOX: Absturz nach Claim → nie ein zweiter Versand (unclear bzw. sent laut Register); vorübergehender Entwurfsfehler → später genau einmal; Versandfehler → failed/unclear; ungültig → rejected", async () => {
  const ob = tmp(), m = createOutboxMailer({ dir: ob }), g = fakeGmail();
  const mk = async (body = "Text") => { const d = await m.createDraft({ to: EMAIL, subject: "S", body, messageClass: "CUSTOMER_ACCESS_REQUEST" }); await m.sendDraft(d.draftId).catch(() => {}); return d.draftId; };
  // a) Claim ohne Ergebnis (Mail-Worker starb mitten im Versand) → unclear, kein Versand.
  const a = await mk();
  fs.writeFileSync(path.join(ob, `${a}.claim`), JSON.stringify({ at: T0.toISOString(), message_class: "CUSTOMER_ACCESS_REQUEST" }));
  // b) Claim mit Draft, Register belegt den Versand → sent (kein zweiter Versand).
  const b = await mk();
  fs.writeFileSync(path.join(ob, `${b}.claim`), JSON.stringify({ at: T0.toISOString(), draft_id: "drX" }));
  g.reg.sent["m-drX"] = { fromDraft: "drX" };
  await processRepairOutbox({ dir: ob, gmail: g });
  assert.equal(g.sends(), 0);
  await assert.rejects(m.sendDraft(a), /unklar/);
  assert.deepEqual(await m.sendDraft(b), { messageId: null, outbox: b });
  // c) 429 beim Entwurf → Claim zurück, nächster Durchlauf sendet genau einmal.
  const c = await mk();
  g.failCreate("Gmail HTTP 429 rate limit");
  const rc = await processRepairOutbox({ dir: ob, gmail: g });
  assert.deepEqual([rc.deferred, g.sends(), fs.existsSync(path.join(ob, `${c}.claim`))], [1, 0, false]);
  await processRepairOutbox({ dir: ob, gmail: g });
  assert.equal(g.sends(), 1);
  // d) 503 beim Versand → unclear (nie wiederholt); e) eindeutige Ablehnung → failed.
  const d = await mk(); g.failSend("Gmail HTTP 503");
  await processRepairOutbox({ dir: ob, gmail: g });
  const e = await mk(); g.failSend("Draft gehört nicht Jarvis");
  await processRepairOutbox({ dir: ob, gmail: g });
  for (let i = 0; i < 2; i++) await processRepairOutbox({ dir: ob, gmail: g });
  assert.equal(g.sends(), 1, "keine Wiederholung nach unklarem/fehlgeschlagenem Versand");
  await assert.rejects(m.sendDraft(d), /unklar/);
  await assert.rejects(m.sendDraft(e), /fehlgeschlagen/);
  // f) Manipulierter Auftrag (falsche Klasse) → rejected, nie gesendet.
  const f = await mk();
  const rf = path.join(ob, `${f}.request.json`);
  fs.writeFileSync(rf, JSON.stringify({ ...JSON.parse(fs.readFileSync(rf, "utf8")), message_class: "MARKETING" }));
  await processRepairOutbox({ dir: ob, gmail: g });
  assert.equal(g.sends(), 1);
  await assert.rejects(m.sendDraft(f), /abgelehnt/);
  // Ohne Outbox-Verzeichnis: No-op, kein Fehler (Mail-Worker ohne Repair-Service).
  assert.equal((await processRepairOutbox({ dir: path.join(ob, "fehlt"), gmail: g })).missing, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Voller CHF-480-Auftrag im Repair-Service: Versand nur über die Outbox → Mail-Worker
// ---------------------------------------------------------------------------------------------------------------------
function vp({ fixed = false } = {}) {
  return { load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
    overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
    critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
    nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 3, targets_ok: 3, targets_failed: 0 },
    images: { visible: 3, broken: 0, broken_paths: [] }, console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 },
    network: { failed_same_site: 0, failed_cross_site: 0, entries: [] }, fingerprints: { header: "a", nav: "b", main: "c", footer: "d" },
    findings: [{ type: "broken_link", ok: fixed, present: !fixed, code: fixed ? null : "finding_unresolved" }] };
}
function world() {
  const st = { fixed: false, writes: 0 };
  const BROKEN = { type: "broken_link", url: `${SITE}team-alt`, page: SITE, label: "Unser Team", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true };
  const adapter = { direct_live: true,
    checkAccess: async (_o, ctx) => (ctx?.credential?.()?.secret === TEST_SECRET ? { ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] } : { ok: false, reason: "kein Zugang" }),
    backup: async () => ({ production_ref: "p1", backup_ref: "local:object-backup", rollback_point: "per-object-original" }),
    locate: async () => ({ target: "index.html", cause: "Link 404", planned_change: "href ersetzen", risk: "niedrig", before_hash: "h0", fix: { replacement: "/team.html" } }),
    applyFix: async () => { st.writes++; st.fixed = true; return { ok: true, change_ref: "lab:1", before_hash: "h0", after_hash: "h1" }; },
    validate: async () => ({ build_ok: true }), deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }), rollback: async () => ({ ok: true }) };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Separation Kunde AG", requests: 3, pages: { home: "<html><body>Kunde</body></html>" }, issues: st.fixed ? [] : [BROKEN] }) };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    const out = { url, phase, desktop: vp({ fixed: phase !== "baseline" && st.fixed }), mobile: vp({ fixed: phase !== "baseline" && st.fixed }) };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  const preflight = { run: async (_o, { accessCtx }) => (accessCtx?.credential?.()?.secret === TEST_SECRET
    ? { profile_status: "PROFILE_READY", reason: "lab_verified", profile: { interface: "lab", capabilities: ["READ_FILES", "WRITE_FILES"] } } : { profile_status: "MANUAL_REVIEW_REQUIRED", reason: "credential_invalid" }) };
  return { st, adapter, auditor, browserValidator, preflight, router: { route: async () => ({ adapter: "static", label: "Lab" }) } };
}
const WT = "w".repeat(43);
function cloud() {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined), now: () => new Date() });
  return { blobs, handler, client: intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn: async (url, init) => handler(new Request(url, init)) }) };
}
async function customerSubmits(c, link) {
  const token = decodeURIComponent(link.split("#t=")[1]);
  const call = async (body) => { const r = await c.handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  const info = await call({ op: "info", token });
  return call({ op: "submit", token, access_type: "other", access_domain: DOMAIN, consent: true, envelope: sealEnvelope({ access_type: "other", host: SITE, username: "jarvis-temp", secret: TEST_SECRET }, info.body.public_key) });
}

test("FULL ORDER über den Repair-Service: Mail-Worker offline → Zugangs-Anfrage/Lieferung NIE «gesendet»; online → genau 1 CUSTOMER_ACCESS_REQUEST + genau 1 CUSTOMER_ORDER_FULFILLMENT, COMPLETED; Neustarts senden nichts doppelt", async () => {
  const state = tmp(), ob = tmp(), store = createStore(state), mailGmail = fakeGmail(), c = cloud(), w = world();
  store.write("config.json", { business_profile: { address: { street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH" } } });
  // Repair-Service: ein Durchlauf = repairServiceIteration mit Outbox (wie im Container), Engine-Deps als Attrappen.
  const runRepair = (opts) => runRepairOrders({ ...opts, adapters: { static: w.adapter }, router: w.router, preflight: w.preflight, browserValidator: w.browserValidator, auditor: w.auditor });
  const repairTick = () => repairServiceIteration({ dir: state, outboxDir: ob, intake: c.client, runRepair, runCheck150: async () => ({ busy: false }) });
  const mailTick = () => processRepairOutbox({ dir: ob, gmail: mailGmail });
  const o0 = createConfirmedRepairOrder(store, { domain: DOMAIN, website: SITE, company: "Separation Kunde AG", delivery_email: EMAIL, contact_name: "Frau Kunde", now: T0 });
  const id = o0.order_id;
  recordPayment(store, { order_id: id, amount_chf: 240, reference: "SEP47-BANK-1", now: T0 });
  recordPayment(store, { order_id: id, amount_chf: 240, reference: "SEP47-BANK-2", now: T0 });

  // Mail-Worker OFFLINE: der Repair-Service übergibt die Zugangs-Anfrage, markiert sie aber nie als gesendet.
  for (let i = 0; i < 3; i++) await repairTick();
  let o = readOrder(store, id);
  assert.equal(o.state, "ACCESS_REQUESTED");
  assert.ok(o.access_request?.draft_id && !o.access_request.sent_at && !o.access_request.send_attempted_at, JSON.stringify(o.access_request));
  assert.notEqual(publicRepairOrders(state).orders[0].phase, "ACCESS_REQUEST_SENT");
  assert.deepEqual([outboxStatus(ob).pending, mailGmail.sends()], [1, 0]);

  // Mail-Worker ONLINE: genau eine Zugangs-Anfrage; danach erkennt der Repair-Service «gesendet».
  await mailTick(); await mailTick();
  assert.deepEqual([mailGmail.sends(), mailGmail.created("CUSTOMER_ACCESS_REQUEST").length], [1, 1]);
  await repairTick();
  o = readOrder(store, id);
  assert.ok(o.access_request.sent_at);
  assert.equal(publicRepairOrders(state).orders[0].phase, "ACCESS_REQUEST_SENT");
  await repairTick(); await mailTick();
  assert.equal(mailGmail.sends(), 1, "Neustart: keine zweite Zugangs-Anfrage");

  // Kunde reicht Zugang ein → Reparatur bis zur Lieferung; Mail-Worker wieder OFFLINE → Lieferung nie «gesendet».
  const link = mailGmail.created("CUSTOMER_ACCESS_REQUEST")[0].body.match(/https:\/\/jarvis\.test\/access\.html#t=[A-Za-z0-9_%-]+/)[0];
  assert.equal((await customerSubmits(c, link)).status, 200);
  for (let i = 0; i < 3; i++) await repairTick();
  o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", `${o.state} ${o.blocked_reason}`);
  assert.deepEqual([o.delivery.status, !!o.delivery.sent_at, !!o.delivery.send_attempted_at, w.st.writes], ["draft_ready", false, false, 1]);
  assert.equal(outboxStatus(ob).pending, 1);

  // Mail-Worker ONLINE: genau eine Lieferung → COMPLETED.
  await mailTick();
  await repairTick();
  o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED");
  assert.deepEqual([o.delivery.status, !!o.delivery.sent_at], ["sent", true]);
  for (let i = 0; i < 2; i++) { await repairTick(); await mailTick(); }
  assert.deepEqual([mailGmail.sends(), mailGmail.created(FULFILLMENT_CLASS).length, mailGmail.created(FULFILLMENT_CLASS)[0].to, w.st.writes], [2, 1, EMAIL, 1]);
  // Outbox enthält danach keine Adresse, keinen Bericht, keinen Link mehr.
  const left = files(ob).map((f) => fs.readFileSync(path.join(ob, f), "utf8")).join("\n");
  assert.ok(!left.includes(EMAIL) && !left.includes("#t=") && !left.includes(TEST_SECRET));
});

test("CHF 150 über den Repair-Service: Lieferung nur über die Outbox, genau einmal, offline nie «gesendet»", async () => {
  const state = tmp(), ob = tmp(), store = createStore(state), g = fakeGmail();
  store.write("config.json", { business_profile: { address: { street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH" } } });
  store.write("sales.json", { records: recordDirectSale({}, { domain: DOMAIN, offer: "REPAIR_CHECK_150", delivery_email: EMAIL, company: "Separation Kunde AG", website: SITE, date: "2026-10-13" }) });
  const o0 = createCheck150Order(store, { domain: DOMAIN, website: SITE, company: "Separation Kunde AG", delivery_email: EMAIL,
    lead_id: "synthetic-sep47-lead", customer_id: "synthetic-sep47-customer", now: T0 });
  // TF-028: Eine vollstÃ¤ndige Abschlussmail inklusive Quittung darf erst nach
  // dem verifizierten Eingang des gesamten CHF-150-Betrags versandbereit werden.
  recordPayment(store, { order_id: o0.order_id, amount_chf: 150, reference: "SEP47-150", now: T0 });
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Kunde", requests: 2, pages: { home: "<html><body>Kunde</body></html>" }, issues: [] }) };
  const env = { STRIPE_SECRET_KEY: ["sk", "live", "synthetic047"].join("_"), JARVIS_WEB_ORIGIN: "https://synthetic.example" };
  const fetchFn = async (_url, options) => {
    const metadata = Object.fromEntries([...new URLSearchParams(options.body)].filter(([key]) => key.startsWith("metadata["))
      .map(([key, value]) => [key.slice(9, -1), value]));
    return { ok: true, json: async () => ({ id: "cs_live_sep47upgrade", livemode: true, status: "open", payment_status: "unpaid", amount_total: 33000,
      currency: "chf", ui_mode: "hosted", url: "https://checkout.stripe.com/c/pay/cs_live_sep47upgrade", metadata }) };
  };
  const tick = () => repairServiceIteration({ dir: state, outboxDir: ob, runRepair: async () => ({ busy: false }),
    runCheck150: (opts) => runCheck150Orders({ ...opts, auditor, env, origin: env.JARVIS_WEB_ORIGIN, fetchFn }) });
  for (let i = 0; i < 3; i++) await tick();
  let o = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o0.order_id];
  assert.notEqual(o.delivery_status, "sent");
  assert.notEqual(o.state, "COMPLETED", `${o.state} ${o.blocked_reason}`);
  await processRepairOutbox({ dir: ob, gmail: g });
  await tick();
  o = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o0.order_id];
  assert.deepEqual([o.state, o.delivery_status, g.sends(), g.created(FULFILLMENT_CLASS).length], ["COMPLETED", "sent", 1, 1], `${o.state} ${o.blocked_reason || ""}`);
  await tick(); await processRepairOutbox({ dir: ob, gmail: g });
  assert.equal(g.sends(), 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Isolation, Service-Iteration, Readiness
// ---------------------------------------------------------------------------------------------------------------------
test("ISOLATION: Repair-Service verweigert den Start mit Gmail-Secrets/Anthropic-Key/Mail-Rolle; Iteration nutzt nur die Outbox und ein Workflow-Fehler stoppt den anderen nie", async () => {
  const s = tmp();
  assert.deepEqual(isolationViolations({ secretsDir: s, env: { JARVIS_WORKER_ROLE: "repair" } }), []);
  fs.writeFileSync(path.join(s, "gmail_token.json"), "{}");
  const v = isolationViolations({ secretsDir: s, env: { JARVIS_WORKER_ROLE: "vps", ANTHROPIC_API_KEY: "sk-ant-test-value-123456" } });
  assert.equal(v.length, 3);
  assert.ok(!v.join(" ").includes("sk-ant-test-value"), "nur Namen, nie Werte");
  const seen = [];
  const r = await repairServiceIteration({ dir: tmp(), outboxDir: tmp(),
    runRepair: async ({ gmail }) => { seen.push(Object.keys(gmail).sort().join(",")); throw new Error("boom"); },
    runCheck150: async ({ gmail }) => { seen.push(typeof gmail.listOwned); return { busy: false, advanced: 0 }; } });
  assert.deepEqual(r.repair, { error: true });
  assert.deepEqual(r.check150, { busy: false, advanced: 0 });
  assert.deepEqual(seen, ["createDraft,outbox,sendDraft,updateDraft", "undefined"], "Engines bekommen nur die Outbox – kein Gmail-Register, kein Senden");
  const svc = read("repair-service.js");
  assert.ok(!/gmail\.js|mail-requests|claimMailRequests|sendHeartbeat|resolveAuthority|server-agent/.test(svc.replace(/\/\/.*$/gm, "")), "keine Sender-Authority-Pfade im Repair-Service");
});

test("READINESS Repair-Service: Isolation + Zustellweg (Mail-Worker-Herzschlag in der Outbox) – ohne Mail-Worker NOT READY; nie Secret-Werte", async () => {
  const secretsDir = tmp(), workerDir = path.join(secretsDir, "mail_worker"), ob = path.join(secretsDir, "repair_outbox");
  fs.mkdirSync(workerDir, { recursive: true }); fs.mkdirSync(ob);
  fs.writeFileSync(path.join(workerDir, SERVICE_LOCK), JSON.stringify({ pid: 1, beat: Date.now() }));
  fs.writeFileSync(path.join(workerDir, "backup_status.json"), JSON.stringify({ last_at: new Date().toISOString(), ok: false, generations: 1 }));
  assert.equal(serviceHealthy(workerDir), true);
  const env = { JARVIS_WORKER_ROLE: "repair", JARVIS_MAIL_WORKER_TOKEN: "t".repeat(43), JARVIS_SYNC_URL: "https://jarvis.test" };
  const opts = { env, secretsDir, workerDir, outboxDir: ob, launchChromium: false, statfs: () => ({ bavail: 60 * 1024 ** 3 / 4096, bsize: 4096 }) };
  const off = await readinessReport(opts);
  assert.equal(off.service, "repair");
  assert.ok(off.reasons.some((x) => /^Delivery: Mail-Worker stellt die Repair-Outbox/.test(x)), off.reasons.join(" | "));
  assert.ok(!off.checks.some((x) => x.name === "Authority"), "keine Authority-Prüfung im Repair-Service");
  // TF-049: Gmail-Status kommt nur aus dem Herzschlag des Mail-Workers (kein eigener Gmail-Zugang im Repair-Service).
  fs.writeFileSync(path.join(ob, CONSUMER_FILE), JSON.stringify({ beat: Date.now(), gmail_auth: { ok: true, at: Date.now() } }));
  const on = await readinessReport(opts);
  const byName = Object.fromEntries(on.checks.map((x) => [x.name, x.status]));
  assert.deepEqual([byName.Core, byName.Isolation, byName.Delivery, byName.Backup], ["OK", "OK", "OK", "OK"]);
  const out = formatReport(on);
  assert.match(out, /Repair-Service/);
  assert.ok(!out.includes(env.JARVIS_MAIL_WORKER_TOKEN));
  fs.writeFileSync(path.join(secretsDir, "gmail_credentials.json"), "{}");
  assert.ok((await readinessReport(opts)).reasons.some((x) => /^Isolation:/.test(x)));
});

// ---------------------------------------------------------------------------------------------------------------------
// Deploy-Artefakte: eigenes Projekt, nur repair-worker, nie Mail-Worker anfassen
// ---------------------------------------------------------------------------------------------------------------------
test("DEPLOY: eigenes Compose-Projekt jarvis-repair mit genau EINEM Service; Repair-Deploy baut/startet nur repair-worker (--no-deps), nie compose down / Docker-Neustart; Mail-Vergleich vorher/nachher", () => {
  const compose = read("deploy/vps/repair/docker-compose.yml");
  assert.match(compose, /^name: jarvis-repair$/m);
  assert.deepEqual([...compose.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]), ["repair-worker"]);
  assert.match(compose, /container_name: jarvis-repair-worker/);
  assert.match(compose, /image: jarvis-repair-worker:latest/);
  for (const re of [/read_only: true/, /cap_drop: \[ALL\]/, /no-new-privileges:true/, /restart: unless-stopped/, /repair-service\.js", "--healthcheck/]) assert.match(compose, re);
  for (const bad of [/jarvis-mail/, /docker\.sock/, /depends_on/, /privileged/, /network_mode: *host/]) assert.doesNotMatch(compose.replace(/^#.*$/gm, ""), bad);
  const remote = read("deploy/vps/repair-remote.sh"), deploy = read("deploy/vps/deploy-repair.sh");
  const code = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const s of [code(remote), code(deploy)]) {
    for (const bad of [/compose[^\n]*\bdown\b/, /systemctl/, /docker\s+restart/, /\brestart\s+"?\$MAIL/, /compose[^\n]*-p "?\$MAIL_PROJECT/, /--with-secrets/, /docker\.sock\s/]) assert.doesNotMatch(s, bad);
  }
  assert.match(remote, /up -d --no-deps --no-build "\$SERVICE"/);
  assert.match(remote, /build "\$SERVICE"/);
  assert.match(remote, /SERVICE=repair-worker/);
  assert.match(remote, /DEPLOY BLOCKED/);
  for (const k of ["Container unverändert", "StartedAt unverändert", "RestartCount unverändert", "Scheduler aktiv", "Queue lesbar", "Authority unverändert", "MAIL_WORKER_UNTOUCHED=YES"]) assert.ok(remote.includes(k), k);
  assert.match(deploy, /repair-remote\.sh/);
});

test("IMAGES: Chromium nur im Repair-Image; Repair-Image ohne Gmail-/Cloud-Mail-/Server-Control-Module; alle importierten Module kopiert; Mail-Worker stellt die Outbox zu und lässt Aufträge im externen Modus aus", () => {
  const rep = read("deploy/vps/Dockerfile.repair"), mail = read("deploy/vps/Dockerfile");
  assert.match(rep, /apk add --no-cache chromium/);
  assert.doesNotMatch(mail.replace(/^#.*$/gm, ""), /chromium/i);
  const copied = new Set(rep.match(/^COPY (repair-service\.js .+) \.\/$/m)[1].split(/\s+/));
  for (const f of ["gmail.js", "mail-requests.js", "server-agent.js", "server-control.js"]) assert.ok(!copied.has(f), `${f} darf nicht ins Repair-Image`);
  for (const f of copied) assert.ok(fs.existsSync(path.join(ROOT, f)), `COPY ${f} existiert`);
  // Statische Import-Hülle des Repair-Service liegt vollständig im Image.
  const seen = new Set();
  const walk = (f) => { if (seen.has(f)) return; seen.add(f); for (const m of read(f).matchAll(/^import [^;]*from "\.\/([^"]+)"/gm)) walk(path.posix.join(path.posix.dirname(f), m[1])); };
  for (const f of ["repair-service.js", "repair-workflow.js", "check-150-workflow.js", "production-readiness.js", "repair-outbox.js"]) walk(f);
  for (const f of seen) assert.ok(f.startsWith("repair-adapters/") ? /COPY repair-adapters/.test(rep) : copied.has(f), `Repair-Image fehlt ${f}`);
  assert.match(rep, /JARVIS_WORKER_ROLE=repair/);
  assert.match(rep, /CMD \["node", "repair-service\.js"\]/);
  const mailCompose = read("deploy/vps/docker-compose.yml");
  assert.match(mailCompose, /JARVIS_REPAIR_OUTBOX: \/data\/repair-outbox/);
  assert.match(mailCompose, /\/opt\/jarvis-repair\/state\/mail_worker:\/data\/repair-state:ro/);
  const mw = read("mail-worker.js");
  assert.match(mw, /if \(!repairRunning && !repairExternal\)/);
  assert.match(mw, /if \(!check150Running && !repairExternal\)/);
  assert.match(mw, /processRepairOutbox\(\{ dir: outboxDir, gmail, gmailAuth, log(, onboarding)? \}\)/); // TF-066: + Onboarding-Hook
  // Outbox-Zustellung nur nach der Standby-Prüfung (send_authority) – im Standby-Zweig steht sie nicht.
  const loopSrc = mw.slice(mw.indexOf("async function loop()"));
  assert.ok(loopSrc.indexOf("if (it.standby)") < loopSrc.indexOf("processRepairOutbox"), "Zustellung nur mit send_authority");
});

test("Release-Gate 047: sequenziell Unit + TF-044 + TF-045 + TF-046 + TF-047-Separation + Secret-Scan + Cleanup", () => {
  const pkg = JSON.parse(read("package.json"));
  const gate = pkg.scripts["test:release-047"];
  const steps = ["npm test", "npm run test:repair-integration", "npm run test:browser-integration", "npm run test:full-order-integration", "npm run test:separation-integration", "node scripts/secret-scan.mjs", "node scripts/lab-cleanup.mjs"];
  assert.equal(gate, steps.join(" && "));
  assert.match(pkg.scripts["test:separation-integration"], /--separation/);
  assert.match(read("scripts/test-repair-integration.mjs"), /service-separation-047/);
});
