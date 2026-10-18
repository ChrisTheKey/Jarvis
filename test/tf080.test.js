// TF-080 – Stripe-Checkout-Anzahlung (CHF 240) automatisch + E2E-Testläufe im CRM. Alles mit Attrappen: 0 Netz (Stripe-API ist ein
// injizierter Fake, Webhooks sind signierte Fixtures), 0 echte Mails, 0 echte Websites, 0 echte Zugangsdaten, 0 echtes Geld.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createStore } from "../mail-worker.js";
import { recordPayment, paymentGateForOrder, paymentsForOrder, paymentsStatus, paymentSummary } from "../payments.js";
import { REPAIR_ORDERS_FILE, runRepairOrders, createContactFormRepairOrder, publicRepairOrders } from "../repair-workflow.js";
import { runCheck150Orders } from "../check-150-workflow.js";
import { createAccessIntakeHandler, memoryIntakeStore } from "../access-intake-api.js";
import { intakeClient, sealEnvelope, hasAccessSecret } from "../access-intake.js";
import { gateDecision } from "../repair-browser-validator.js";
import { processRepairOutbox } from "../repair-outbox.js";
import { repairServiceIteration } from "../repair-service.js";
import { createOnboarding } from "../onboarding-dialogue.js";
import { readOrdersExport, readPaymentLinks } from "../onboarding-store.js";
import { detectPlatform } from "../hosting-detect.js";
import * as cf from "../contact-form.js";
import { processContactJourneys, contactThreadFor, TEST_PAYMENT_DE } from "../contact-form-journey.js";
import { buildCrmLead, cleanCrmLead, applyCrmAction } from "../lead-crm.js";
import { crmStats, isTestLead, callRecommended, filterLeads } from "../public/crm-model.js";
import { eligibility } from "../calling-core.js";
import { canSeeLead, sellerOf, scopeLeads } from "../sales-scope.js";
import { ordersFromSnapshot } from "../commission-ledger.js";
import { memoryStore } from "../shared-state.js";
import { createPaymentsHandler } from "../payments-api.js";
import { signStripePayload, stripeStatus, verifyStripeWebhook, normalizeCheckoutEvent, idempotencyKey } from "../stripe-payments.js";
import { syncStripePayments, STRIPE_FILE, processCheckoutEvent } from "../stripe-webhook.js";
import { e2eConfig, testRunId } from "../e2e-test.js";
import { cleanRepair } from "../server-control.js";
import { cleanChLeads } from "../crm-api.js";

const T0 = new Date("2026-10-18T09:00:00Z");
const MIN = 60_000;
const MAILBOX = "chris@helvetic.test";
const AUTH = "mx.google.com; dkim=pass header.i=@netlify.com header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@netlify.com; dmarc=pass (p=NONE) header.from=netlify.com";
const CFG = { ...cf.DEFAULT_CONTACT_FORM_CONFIG, forms: [{ form_name: "anfrage", site: "helvetic-webdesign-reperatur", market: "CH" }], receivingMailboxes: [MAILBOX] };
const SANDBOX = "jarvis-sandbox.ch", TESTBOX = "e2e-postfach@helvetic-test.ch";
const REAL = "muster-garage.ch", REALMAIL = "anna@muster-garage.ch";
const GOOD = "Tf80-Sandbox-Secret-4b2a";
const KEYS = { STRIPE_SECRET_KEY: "sk_live_fixture01", STRIPE_TEST_SECRET_KEY: "sk_test_fixture01" }; // kurze Attrappen (Secret-Scan-Muster ≥ 20)
const WH = { STRIPE_WEBHOOK_SECRET: "whsec_fixtLive", STRIPE_TEST_WEBHOOK_SECRET: "whsec_fixtTest" };
const E2E_ON = e2eConfig({ JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: SANDBOX, JARVIS_E2E_TEST_MAILBOXES: TESTBOX });
const E2E_OFF = e2eConfig({});
const WT = "w".repeat(43);
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf080-")); made.push(d); return d; };
const formBody = ({ website, name, email, msg, interest = "Check & Reparatur" }) =>
  ["Ihre Website *:", website, "", "Name *:", name, "", "E-Mail *:", email, "", "Interesse an:", interest, "", "Was funktioniert nicht?", msg, ""].join("\r\n");
const TEST_FORM = { website: `https://${SANDBOX}`, name: "Sandbox Pruefer", email: TESTBOX, msg: "Testlauf ohne Echtgeld – Kontaktformular der Sandbox prüfen." };
const REAL_FORM = { website: `https://www.${REAL}`, name: "Anna Muster", email: REALMAIL, msg: "Das Kontaktformular sendet nichts ab." };
const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

// ---------- Fake Stripe (nur die zwei genutzten Endpunkte; Idempotenz wie Stripe) ----------
function fakeStripe() {
  const sessions = {}, byIdem = {}, calls = [];
  let n = 0;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {}, method = init.method || "GET";
    const mode = /Bearer sk_live_/.test(h.authorization || "") ? "live" : /Bearer sk_test_/.test(h.authorization || "") ? "test" : null;
    calls.push({ method, path: u.pathname, mode, idem: h["idempotency-key"] || null });
    if (u.hostname !== "api.stripe.com" || !mode) return json(401, { error: { code: "auth" } });
    if (method === "POST" && u.pathname === "/v1/checkout/sessions") {
      const idem = h["idempotency-key"];
      if (byIdem[idem]) return json(200, sessions[byIdem[idem]]);
      const p = new URLSearchParams(init.body);
      const id = `cs_${mode}_fixture${String(++n).padStart(4, "0")}`;
      sessions[id] = { id, object: "checkout.session", livemode: mode === "live", status: "open", payment_status: "unpaid", amount_total: Number(p.get("line_items[0][price_data][unit_amount]")),
        currency: p.get("line_items[0][price_data][currency]"), payment_intent: null, expires_at: Number(p.get("expires_at")), url: `https://checkout.stripe.com/c/pay/${id}`,
        metadata: Object.fromEntries(["order_id", "offer_class", "market", "purpose", "environment"].map((k) => [k, p.get(`metadata[${k}]`)])),
        _customer_email: p.get("customer_email"), _success_url: p.get("success_url"), _pi_meta: p.get("payment_intent_data[metadata][order_id]"), _types: p.get("payment_method_types[0]") };
      byIdem[idem] = id;
      return json(200, sessions[id]);
    }
    const m = u.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[a-z]+_fixture\d+)$/);
    if (method === "GET" && m && sessions[m[1]] && sessions[m[1]].livemode === (mode === "live")) return json(200, sessions[m[1]]);
    return json(404, { error: { code: "resource_missing" } });
  };
  return {
    sessions, calls, fetchFn,
    pay(id) { Object.assign(sessions[id], { status: "complete", payment_status: "paid", payment_intent: `pi_${id.slice(3)}` }); return sessions[id]; },
    expire(id) { sessions[id].status = "expired"; return sessions[id]; },
    event(type, id, { obj = null, evtId = `evt_${type.replace(/\W/g, "")}_${id}`, livemode = null } = {}) {
      const o = obj || sessions[id];
      return { id: evtId, object: "event", type, livemode: livemode ?? o.livemode, created: Math.floor(+T0 / 1000), data: { object: structuredClone(o) } };
    },
    last: () => Object.values(sessions).at(-1),
  };
}
// ---------- Netlify /api/payments (Webhook + Inbox) ----------
function paymentsCloud({ env = { ...WH, JARVIS_MAIL_WORKER_TOKEN: WT }, clock }) {
  const mem = {};
  const handler = createPaymentsHandler({ env: (k) => env[k], getStore: async (k) => (mem[k] ||= memoryStore()), now: () => new Date(clock()) });
  const post = async (evt, { secret = WH.STRIPE_TEST_WEBHOOK_SECRET, raw = JSON.stringify(evt), sig = null } = {}) => {
    const r = await handler(new Request("https://jarvis.test/api/payments", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig ?? signStripePayload(raw, secret, Math.floor(clock() / 1000)) }, body: raw }));
    return { status: r.status, body: await r.json() };
  };
  const inbox = { pull: async () => { const r = await handler(new Request("https://jarvis.test/api/payments", { method: "POST", headers: { "x-jarvis-worker": WT }, body: JSON.stringify({ op: "inbox.pull" }) })); return (await r.json()).events; },
    ack: async (keys) => handler(new Request("https://jarvis.test/api/payments", { method: "POST", headers: { "x-jarvis-worker": WT }, body: JSON.stringify({ op: "inbox.ack", keys }) })) };
  return { handler, post, inbox, mem };
}

// ---------- Welt (wie TF-079: Mail-Worker + Kundenweg + Outbox + Onboarding + Repair-Service), zusätzlich Stripe + E2E ----------
function threadGmail(clock) {
  let n = 0;
  const reg = { drafts: {}, sent: {}, sending: {} }, threads = new Map(), log = [], inbound = {};
  const owned = (tid) => Object.values(reg.sent).some((s) => s.threadId === tid);
  const g = {
    reg, threads, log, inbound, listOwned: () => reg,
    async searchInbound() { return Object.keys(inbound); },
    async readInbound(id) { if (!inbound[id]) throw new Error("unbekannt"); return structuredClone(inbound[id]); },
    async createDraft({ to, subject, body, messageClass = null, orderId = null, threadId = null, inReplyTo = "", mode = null, contactFormKey = null }) {
      const id = `d${++n}`, tid = threadId || `t${n}`;
      reg.drafts[id] = { to, subject, threadId: tid, messageClass: messageClass || (mode ? "CONTACT_FORM_INQUIRY" : null), orderId, body, inReplyTo, mode, contactFormKey, createdAt: new Date(clock()).toISOString() };
      return { draftId: id, threadId: tid, messageId: `dm${n}` };
    },
    async replyDraftInThread(threadId, { to, body, messageClass, orderId }) {
      if (!owned(threadId)) throw new Error("Thread nicht von Jarvis.");
      const first = Object.values(reg.sent).find((s) => s.threadId === threadId);
      return g.createDraft({ to, subject: `Re: ${first.subject}`, body, messageClass, orderId, threadId, inReplyTo: threads.get(threadId).at(-1).rfcMessageId });
    },
    async sendDraft(id) {
      const d = reg.drafts[id];
      if (!d) throw new Error("Entwurf fehlt");
      const mid = `m${++n}`;
      if (!threads.has(d.threadId)) threads.set(d.threadId, []);
      threads.get(d.threadId).push({ messageId: mid, rfcMessageId: `<${mid}@jarvis.test>`, from: `Chris <${MAILBOX}>`, replyTo: "", to: d.to, subject: d.subject, body: d.body, sent: true, draft: false, internalDate: clock() });
      reg.sent[mid] = { messageId: mid, threadId: d.threadId, to: d.to, subject: d.subject, fromDraft: id, messageClass: d.messageClass, orderId: d.orderId, mode: d.mode, contactFormKey: d.contactFormKey, sentAt: new Date(clock()).toISOString() };
      delete reg.drafts[id];
      log.push({ threadId: d.threadId, to: d.to, messageClass: d.messageClass, subject: d.subject, body: d.body });
      return { messageId: mid, threadId: d.threadId };
    },
    async readThread(threadId) { if (!owned(threadId)) throw new Error("Thread nicht von Jarvis."); return { threadId, messages: threads.get(threadId).map((m) => ({ ...m })) }; },
    customer(threadId, { from, body }) {
      const mid = `c${++n}`;
      threads.get(threadId).push({ messageId: mid, rfcMessageId: `<${mid}@kunde.test>`, from, replyTo: "", to: MAILBOX, subject: "Re: Ihre Anfrage", body, sent: false, draft: false, internalDate: clock() + 1000 });
      return mid;
    },
    notify(id, b) {
      inbound[id] = { messageId: id, rfcMessageId: `<${id}.formresponses@netlify.com>`, threadId: "nf-" + id, from: '"helvetic-webdesign-reperatur.netlify.app" <formresponses@netlify.com>', replyTo: "",
        to: MAILBOX, deliveredTo: MAILBOX, subject: "Neue Kundenanfrage – submission from helvetic-webdesign-reperatur (anfrage)", body: b, internalDate: String(clock()), headers: { "authentication-results": [AUTH] } };
    },
    sends: () => log,
  };
  return g;
}
function vp(fixed) {
  return { load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
    overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
    critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
    nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 3, targets_ok: 3, targets_failed: 0 },
    images: { visible: 3, broken: 0, broken_paths: [] }, console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 },
    network: { failed_same_site: 0, failed_cross_site: 0, entries: [] }, fingerprints: { header: "a", nav: "b", main: "c", footer: "d" },
    findings: [{ type: "broken_link", ok: fixed, present: !fixed, code: fixed ? null : "finding_unresolved" }] };
}
// Sandbox-Adapter: zählt jede Berührung je Domain – echte Kunden-Domains dürfen nie vorkommen.
function sandbox() {
  const st = { fixed: {}, touched: [], checks: [], backups: 0, fixes: 0, rollbacks: 0 };
  const site = (d) => `https://${d}/`;
  const broken = (d) => ({ type: "broken_link", url: `${site(d)}team-alt`, page: site(d), label: "Team", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true });
  const secretOf = (ctx) => ctx?.credential?.()?.secret || null;
  const adapter = { direct_live: true,
    checkAccess: async (o, ctx) => { st.touched.push(o.domain); st.checks.push(secretOf(ctx)); return secretOf(ctx) === GOOD ? { ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] } : { ok: false, reason: "auth_failed" }; },
    backup: async (o) => { st.touched.push(o.domain); st.backups++; return { production_ref: "p1", backup_ref: "local:object-backup", rollback_point: "per-object-original" }; },
    locate: async () => ({ target: "index.html", cause: "Link 404", planned_change: "href ersetzen", risk: "niedrig", fix: { replacement: "/team.html" } }),
    applyFix: async (_p, o) => { st.touched.push(o.domain); st.fixes++; st.fixed[o.domain] = true; return { ok: true, change_ref: "lab:link" }; },
    validate: async () => ({ build_ok: true }), deployProduction: async (o) => { st.touched.push(o.domain); return { ok: true, deploy_ref: "live:lab" }; },
    rollback: async (o) => { st.touched.push(o.domain); st.rollbacks++; st.fixed[o.domain] = false; return { ok: true }; } };
  const auditor = { audit: async (u) => { const d = new URL(u).hostname; return { website: u, reachable: true, finalUrl: u, title: "Sandbox", requests: 3, pages: { home: "<html><body><a href='/team-alt'>Team</a></body></html>" }, issues: st.fixed[d] ? [] : [broken(d)] }; } };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    const d = new URL(url).hostname;
    const out = { url, phase, desktop: vp(phase !== "baseline" && !!st.fixed[d]), mobile: vp(phase !== "baseline" && !!st.fixed[d]) };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  const preflight = { run: async (o, { accessCtx }) => { st.touched.push(o.domain); return secretOf(accessCtx) === GOOD ? { profile_status: "PROFILE_READY", reason: "lab_verified", profile: { interface: "lab", capabilities: ["READ_FILES", "WRITE_FILES"] } } : { profile_status: "BLOCKED_NO_ACCESS", reason: "auth_failed" }; } };
  return { st, adapter, auditor, browserValidator, preflight, router: { route: async () => ({ adapter: "static", label: "Lab" }) } };
}
function intakeCloud() {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined) });
  const call = async (b) => { const r = await handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })); return { status: r.status, body: await r.json() }; };
  return { blobs, call, client: intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn: async (url, init) => handler(new Request(url, init)) }) };
}
const linkOf = (b) => b.match(/https:\/\/jarvis\.test\/access\.html#t=[A-Za-z0-9_%-]+/)?.[0] || null;
const payLinkOf = (b) => b.match(/https:\/\/checkout\.stripe\.com\/c\/pay\/cs_[a-z]+_fixture\d+/)?.[0] || null;
const tokenOf = (link) => decodeURIComponent(link.split("#t=")[1].split("&")[0]);

function world({ e2e = E2E_ON, keys = KEYS, stripeOn = true } = {}) {
  const state = tmp(), ob = tmp(), mail = tmp();
  const store = createStore(state), mstore = createStore(mail);
  let clock = +T0;
  const now = () => new Date(clock);
  const g = threadGmail(() => clock), ic = intakeCloud(), sb = sandbox(), stripe = fakeStripe(), pc = paymentsCloud({ clock: () => clock }), notes = [], logs = [], wf = new Set();
  const onbDir = path.join(ob, "onboarding");
  const extract = async () => ({ facts: [], clarifications: [], classes: ["OTHER"], sensitive_detected: false, customer_says_no_more_changes: false, confirmation: false, correction_requested: false, confidence: "low" });
  const onb = createOnboarding({ dir: mail, onboardingDir: onbDir, gmail: g, extract, now, notify: async (x) => { notes.push(x); }, log: () => {}, contactThreadFor: (id, email) => contactThreadFor(mstore, id, email) });
  const runRepair = (opts) => runRepairOrders({ ...opts, adapters: { static: sb.adapter }, router: sb.router, preflight: sb.preflight, browserValidator: sb.browserValidator, auditor: sb.auditor,
    platformDetector: async () => detectPlatform({ headers: { link: '<https://k.test/wp-json/>; rel="https://api.w.org/"' }, html: '<html><head><meta name="generator" content="WordPress 6.6"><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head></html>' }),
    log: (...a) => logs.push(JSON.stringify(a)) });
  const W = {
    state, ob, mail, store, mstore, g, ic, sb, stripe, pc, notes, logs, onbDir, wf, now,
    advance: (ms = 5 * MIN) => { clock += ms; },
    contactTick: async () => {
      await cf.processContactForms({ gmail: g, store: mstore, cfg: CFG, sender: { name: "Chris", signature: "Chris\nHelvetic Webdesign" }, ownAddresses: [MAILBOX], now: now(), autoReply: true, e2e,
        orders: () => readOrdersExport(onbDir).orders || {}, escalate: async (x) => { notes.push(x); }, log: () => {} });
      await processContactJourneys({ gmail: g, store: mstore, onboardingDir: onbDir, boundOrders: () => new Set(onb.boundThreads().values()), now: now(), e2e, escalate: async (x) => { notes.push(x); }, log: () => {} });
      for (const it of W.items()) if (it.journey?.workflow) wf.add(it.journey.workflow);
    },
    repairTick: () => repairServiceIteration({ dir: state, outboxDir: ob, intake: ic.client, runRepair, runCheck150: (o) => runCheck150Orders({ ...o, auditor: sb.auditor }), onboarding: true, e2e,
      stripe: stripeOn ? { env: keys, fetchFn: stripe.fetchFn, inbox: pc.inbox, origin: "https://jarvis.test", now: now() } : null }),
    mailTick: async () => { await W.contactTick(); await processRepairOutbox({ dir: ob, gmail: g, onboarding: onb, now }); await onb.process(); },
    tick: async (k = 1) => { for (let i = 0; i < k; i++) { W.advance(); await W.mailTick(); await W.repairTick(); await W.mailTick(); await W.repairTick(); } },
    items: () => Object.values(cf.loadContactForms(mstore).items),
    item: (email) => W.items().find((x) => x.customer_email === email),
    orders: () => Object.values(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders || {}),
    order: (id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id],
    say: (email, from, b) => { W.advance(MIN); return g.customer(W.item(email).sent_thread_id, { from, body: b }); },
    pub: () => JSON.parse(fs.readFileSync(path.join(mail, cf.CONTACT_FORMS_PUBLIC_FILE), "utf8")).leads,
    stripeState: () => store.read(STRIPE_FILE, {}),
    submit: async (link, { domain, secret = GOOD }) => {
      const info = await ic.call({ op: "info", token: tokenOf(link) });
      return ic.call({ op: "submit", token: tokenOf(link), access_type: "wordpress_cms", access_domain: domain, consent: true,
        envelope: sealEnvelope({ access_type: "wordpress_cms", host: `https://${domain}/wp-admin`, username: "jarvis-temp", secret }, info.body.public_key) });
    },
    accessMails: (to) => g.sends().filter((s) => s.messageClass === "CUSTOMER_ACCESS_REQUEST" && (!to || s.to === to)),
    allFiles: () => [state, ob, mail].flatMap((d) => fs.readdirSync(d, { recursive: true }).map(String).map((f) => path.join(d, f)))
      .filter((f) => fs.statSync(f).isFile() && !/access_vault|access_intake_private/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n"),
  };
  return W;
}
// CRM-Sicht eines Kontaktformular-Eintrags (wie crm-service: contact_forms_public.json → buildCrmLead → Cloud-Allowlist).
const crmLead = (W, id) => cleanCrmLead(buildCrmLead(id, { contactForms: { leads: W.pub() } }, W.now()));

// ======================================================================================================================================
test("TF-080 §39 Volle E2E-Fixture: Test-Formular → CRM TEST → Antwort → Test-Bestätigung → TEST-Auftrag → Stripe-TEST-Checkout → signierter TEST-Webhook → Gate → sicherer Zugang → Sandbox → Backup → Reparatur → Validierung → Retest → Abschluss → Tresor zerstört – 0 echtes Geld/Umsatz/Provision/Anrufe/Outreach/Kundenwebsite", async () => {
  const W = world();
  W.g.notify("e2e0000000000001", formBody(TEST_FORM));
  await W.mailTick();
  // 1. CRM: TEST-Eintrag mit eigener Identität, unübersehbar TEST.
  const it = W.item(TESTBOX);
  assert.deepEqual([it.is_test, it.environment, it.e2e_run, it.test_run_id], [true, "TEST", true, testRunId(it.key)]);
  const ids = Object.keys(W.pub());
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^test-cf-[0-9a-f]{16}$/);
  let lead = crmLead(W, ids[0]);
  assert.deepEqual([lead.is_test, lead.environment, lead.test_run_id, lead.contact_form.is_test, lead.contact_form.e2e_run, isTestLead(lead)], [true, "TEST", it.test_run_id, true, true, true]);
  assert.equal(lead.contact_form.call_eligibility, "TEST_BLOCKED");
  assert.deepEqual([lead.phone_tel, lead.call_recommended, callRecommended(lead)], [null, false, false]);
  assert.equal(eligibility(lead).code, "TEST_BLOCKED", "Testlead nie anrufbar");
  // 2. sofortige Antwort, klar als E2E-TEST markiert, mit Auftragsschritten.
  const first = W.g.sends()[0];
  assert.equal(first.to, TESTBOX);
  assert.ok(first.body.includes(cf.E2E_TEST_LINE_DE));
  assert.match(first.body, /«Ja, ich bestätige den Auftrag»/);
  // 3. ausdrückliche Test-Bestätigung → TEST-Auftrag (kein Verkauf, kein Umsatz).
  W.say(TESTBOX, `Sandbox Pruefer <${TESTBOX}>`, "Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  assert.equal(W.orders().length, 1);
  const id = W.orders()[0].order_id;
  let o = W.order(id);
  assert.deepEqual([o.test_order, o.environment, o.test_run_id, o.domain, o.commission_rate_bps, o.customer_authorized_repair], [true, "TEST", it.test_run_id, SANDBOX, 0, false]);
  assert.deepEqual(Object.keys(W.store.read("sales.json", { records: {} }).records || {}), [], "kein Direktverkauf → keine Verkaufs-/Umsatzstatistik");
  // 4. genau EINE Stripe-TEST-Checkout-Session (CHF 240.00, Metadaten, Idempotenz), Link im selben Verlauf, TESTZAHLUNG markiert.
  const created = W.stripe.calls.filter((c) => c.method === "POST");
  assert.equal(created.length, 1, "genau eine Session trotz mehrerer Durchläufe");
  assert.deepEqual([created[0].mode, created[0].idem], ["test", idempotencyKey(id, "TEST")]);
  assert.ok(!W.stripe.calls.some((c) => c.mode === "live"), "TEST-Auftrag nie mit LIVE-Schlüssel");
  const s = W.stripe.last();
  assert.deepEqual([s.amount_total, s.currency, s.metadata.order_id, s.metadata.purpose, s.metadata.environment, s._pi_meta, s._customer_email, s._types],
    [24000, "chf", id, "REPAIR_DEPOSIT", "TEST", id, TESTBOX, null], "CHF 240.00 serverseitig; Zahlungsarten aus dem Stripe-Konto (keine hart kodierten)");
  const conf = W.g.sends().find((x) => /vielen Dank für Ihre Bestätigung/.test(x.body));
  assert.equal(conf.threadId, it.sent_thread_id, "im selben Verlauf");
  assert.equal(payLinkOf(conf.body), s.url);
  assert.ok(conf.body.includes(TEST_PAYMENT_DE) && conf.body.includes(cf.E2E_TEST_LINE_DE));
  assert.match(conf.body, /erste Hälfte des Festpreises \(CHF 240\) fällig/);
  assert.ok(!W.notes.some((n) => /Zahlungsangaben an den Kunden senden/.test(n.reason)), "kein Chris-Schritt bei Stripe");
  await W.tick(2);
  assert.equal(W.g.sends().filter((x) => payLinkOf(x.body)).length, 1, "Zahlungslink-Mail genau einmal");
  assert.equal(W.item(TESTBOX).journey.workflow, "WAITING_FOR_PAYMENT");
  assert.equal(W.accessMails().length, 0);
  // 5. Browser-Rückkehr allein schaltet nichts frei (kein Ereignis, Session noch offen).
  assert.equal(paymentGateForOrder(W.store, o).satisfied, false);
  // 6. signierter TEST-Webhook → Netlify-Inbox → Repair-Service prüft und verbucht (TEST).
  W.stripe.pay(s.id);
  const evt = W.stripe.event("checkout.session.completed", s.id);
  assert.equal((await W.pc.post(evt)).status, 200);
  assert.equal((await W.pc.post(evt)).body.duplicate, true, "Stripe-Retry → ein Inbox-Eintrag");
  await W.tick(2);
  const pays = paymentsForOrder(W.store, id);
  assert.equal(pays.length, 1);
  assert.deepEqual([pays[0].provider_mode, pays[0].is_test, pays[0].amount, pays[0].currency, pays[0].source], ["TEST", true, 240, "CHF", "stripe_test_checkout"]);
  assert.equal(paymentGateForOrder(W.store, W.order(id)).satisfied, true);
  assert.equal(paymentSummary(W.store, W.order(id)).payment_status, "DEPOSIT_MET", "CHF 240 ≠ CHF 480 – Rest CHF 240 bleibt offen");
  // 7. sicherer Zugangslink automatisch, im Kontaktformular-Verlauf.
  const acc = W.accessMails(TESTBOX);
  assert.equal(acc.length, 1);
  assert.equal(acc[0].threadId, it.sent_thread_id);
  // 8. verschlüsselter TEST-Zugang über denselben Intake-Weg → Sandbox → Backup → Reparatur → Validierung → Retest → Abschluss.
  assert.equal((await W.submit(linkOf(acc[0].body), { domain: SANDBOX })).status, 200);
  await W.tick();
  W.say(TESTBOX, `Sandbox Pruefer <${TESTBOX}>`, "Nein, sonst nichts.");
  await W.tick(3);
  o = W.order(id);
  assert.ok(["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"].includes(o.state), o.state);
  assert.deepEqual([W.sb.st.backups, W.sb.st.fixes, o.validation.build_ok, o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.regression], [1, 1, true, "JA", "JA", "KEINE"]);
  assert.equal(hasAccessSecret(W.state, id), false, "Tresor zerstört");
  assert.equal(o.access_intake.status, "DESTROYED");
  // 9. CRM zeigt den Fortschritt als TEST.
  for (const w of ["WAITING_FOR_CONFIRMATION", "WAITING_FOR_PAYMENT", "ACCESS_REQUESTED", "COMPLETED"]) assert.ok(W.wf.has(w), `Stufe ${w} sichtbar`);
  lead = crmLead(W, ids[0]);
  assert.deepEqual([lead.contact_form.workflow_status, lead.contact_form.payment_mode, lead.contact_form.payment_state, lead.is_test], ["COMPLETED", "TEST", "PAID", true]);
  // 10. Isolation: 0 echtes Geld/Umsatz/Provision/Anrufe/Outreach, nur die Sandbox berührt.
  const ps = paymentsStatus(W.state);
  assert.deepEqual([ps.received, ps.received_chf, ps.test_payments], [0, 0, 1], "0 echte Zahlungen, 0 Umsatz");
  const snap = { repair: publicRepairOrders(W.state) };
  assert.equal(snap.repair.orders[0].test_order, true);
  assert.deepEqual(ordersFromSnapshot(snap), [], "0 Provision");
  assert.equal(snap.repair.total, 0, "0 echte Aufträge in den Geschäftszählern");
  assert.deepEqual([...new Set(W.sb.st.touched)], [SANDBOX], "nur die Sandbox-Domain berührt");
  assert.ok(W.g.sends().every((x) => x.to === TESTBOX), "keine fremden Empfänger, kein Cold-Outreach");
  assert.ok(!W.allFiles().includes(GOOD), "Testzugang nie ausserhalb des Tresors");
  assert.ok(!/sk_(live|test)_fixture|whsec_fixt/.test(W.allFiles()), "keine Stripe-Schlüssel im Zustand/Export");
  assert.ok(!JSON.stringify(W.stripeState()).includes("checkout.stripe.com"), "Checkout-Link nie im Repair-Zustand");
  // Cloud-CRM-Allowlist behält das TEST-Kennzeichen (CRM-Ansicht im Browser zeigt TEST).
  const cloud = cleanChLeads([buildCrmLead(ids[0], { contactForms: { leads: W.pub() } }, W.now())]);
  assert.deepEqual([cloud.length, cloud[0].is_test, cloud[0].contact_form.is_test, cloud[0].contact_form.payment_mode], [1, true, true, "TEST"]);
});

test("TF-080 §1/§11 Echter Kunde (LIVE): Live-Checkout CHF 240, Mail mit Link (kein TEST), Rückkehr allein schaltet nichts frei, autoritativer Abgleich verbucht → Gate → sicherer Link", async () => {
  const W = world();
  W.g.notify("real000000000001", formBody(REAL_FORM));
  await W.mailTick();
  assert.equal(W.item(REALMAIL).is_test, false);
  assert.ok(!W.g.sends()[0].body.includes("E2E-TEST"));
  W.say(REALMAIL, `Anna Muster <${REALMAIL}>`, "Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  const [o] = W.orders();
  assert.equal(o.test_order, undefined);
  const post = W.stripe.calls.filter((c) => c.method === "POST");
  assert.deepEqual([post.length, post[0].mode, post[0].idem], [1, "live", idempotencyKey(o.order_id, "LIVE")]);
  const s = W.stripe.last();
  assert.deepEqual([s.amount_total, s.currency, s.livemode, s.metadata.environment], [24000, "chf", true, "LIVE"]);
  const conf = W.g.sends().find((x) => payLinkOf(x.body));
  assert.ok(conf && !conf.body.includes(TEST_PAYMENT_DE) && !conf.body.includes("E2E-TEST"));
  assert.match(conf.body, /Sobald die Zahlung bestätigt ist, erhalten Sie automatisch den sicheren Zugangslink/);
  assert.match(s._success_url, /^https:\/\/jarvis\.test\/zahlung\.html\?s=ok$/);
  // Kunde kehrt zurück (Erfolgsseite), Zahlung bei Stripe aber noch nicht abgeschlossen → nichts.
  await W.tick(3);
  assert.equal(paymentsForOrder(W.store, o.order_id).length, 0);
  assert.equal(W.accessMails().length, 0, "Redirect allein entsperrt nie");
  // Zahlung abgeschlossen, Webhook verloren → Abgleich direkt bei Stripe (alle 10 min) verbucht genau einmal (LIVE).
  W.stripe.pay(s.id);
  W.advance(10 * MIN);
  await W.tick(2);
  const pays = paymentsForOrder(W.store, o.order_id);
  assert.deepEqual([pays.length, pays[0].provider_mode, pays[0].is_test, pays[0].source], [1, "LIVE", undefined, "stripe_checkout"]);
  assert.equal(W.accessMails(REALMAIL).length, 1, "sicherer Link automatisch – kein Chris-Schritt");
  assert.equal(paymentsStatus(W.state).received_chf, 240);
  // Später eintreffender Webhook derselben Zahlung → kein zweiter Eintrag.
  await W.pc.post(W.stripe.event("checkout.session.completed", s.id), { secret: WH.STRIPE_WEBHOOK_SECRET });
  await W.tick();
  assert.equal(paymentsForOrder(W.store, o.order_id).length, 1);
  assert.equal(paymentSummary(W.store, W.order(o.order_id)).payment_status, "DEPOSIT_MET", "nie PAID_FULL mit CHF 240");
});

test("TF-080 §36 Ohne Stripe-Schlüssel: NOT_CONFIGURED, keine API-Aufrufe, nichts vorgetäuscht – Bestätigung wie TF-079 + Hinweis an Chris; Webhook 503", async () => {
  const W = world({ keys: {} });
  W.g.notify("real000000000002", formBody(REAL_FORM));
  await W.mailTick();
  W.say(REALMAIL, `Anna Muster <${REALMAIL}>`, "Ja, ich bestätige den Auftrag.");
  await W.tick(3);
  const [o] = W.orders();
  assert.equal(W.stripe.calls.length, 0);
  assert.equal(readPaymentLinks(W.onbDir).links[o.order_id].status, "NOT_CONFIGURED");
  const conf = W.g.sends().find((x) => /vielen Dank für Ihre Bestätigung/.test(x.body));
  assert.ok(conf && !payLinkOf(conf.body) && /Zahlungsangaben erhalten Sie separat/.test(conf.body), conf?.body);
  assert.ok(W.notes.some((n) => /Zahlungsangaben an den Kunden senden/.test(n.reason) && /NOT_CONFIGURED/.test(n.reason)));
  assert.equal(paymentGateForOrder(W.store, o).satisfied, false);
  assert.equal(W.accessMails().length, 0);
  assert.deepEqual(stripeStatus({}), { provider: "stripe", live: "NOT_CONFIGURED", test: "NOT_CONFIGURED", webhook_live: "NOT_READY", webhook_test: "NOT_READY" });
  assert.equal(stripeStatus({ STRIPE_SECRET_KEY: "sk_test_fixture01" }).live, "NOT_CONFIGURED", "Testschlüssel ist nie ein LIVE-Schlüssel");
  const off = paymentsCloud({ env: { JARVIS_MAIL_WORKER_TOKEN: WT }, clock: () => +T0 });
  assert.equal((await off.post({ id: "evt_x00000", type: "checkout.session.completed", livemode: true, data: { object: {} } })).status, 503);
});

test("TF-080 §38 Webhook fail closed: ungültige Signatur, Modus-Widerspruch, TEST↔LIVE vertauscht, falscher Betrag/Währung/Auftrag, Duplikat-Ereignis, Duplikat-Referenz nach Absturz", async () => {
  const W = world();
  // ein echter (LIVE) und ein TEST-Auftrag mit je einer offenen Session
  W.g.notify("real000000000003", formBody(REAL_FORM));
  W.g.notify("e2e0000000000003", formBody(TEST_FORM));
  await W.mailTick();
  W.say(REALMAIL, `Anna Muster <${REALMAIL}>`, "Ja, ich bestätige den Auftrag.");
  W.say(TESTBOX, `Sandbox Pruefer <${TESTBOX}>`, "Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  const live = W.orders().find((x) => !x.test_order), tst = W.orders().find((x) => x.test_order);
  const sLive = Object.values(W.stripe.sessions).find((x) => x.metadata.order_id === live.order_id);
  const sTest = Object.values(W.stripe.sessions).find((x) => x.metadata.order_id === tst.order_id);
  assert.ok(sLive.livemode && !sTest.livemode);
  // Netlify: ungültige Signatur / falsches Secret / livemode passt nicht zum Secret → 400, nichts gespeichert.
  const e1 = W.stripe.event("checkout.session.completed", sLive.id);
  assert.equal((await W.pc.post(e1, { sig: "t=1,v1=" + "0".repeat(64) })).status, 400);
  assert.equal((await W.pc.post(e1, { secret: "whsec_falsch" })).status, 400);
  assert.equal((await W.pc.post(W.stripe.event("checkout.session.completed", sTest.id, { livemode: true }), { secret: WH.STRIPE_TEST_WEBHOOK_SECRET })).body.code, "MODE_MISMATCH");
  assert.equal(verifyStripeWebhook(JSON.stringify(e1), "t=1,v1=" + "a".repeat(64), WH).ok, false);
  assert.equal((await W.pc.inbox.pull()).length, 0, "nichts in der Inbox");
  // Verarbeitung (Repair): jede Abweichung → Prüfeintrag, nie verbucht.
  const st = { schema: 1, attempts: {}, sessions: {}, events: {}, reviews: [], ...W.stripeState() };
  const paid = (s, patchObj = {}, evtId) => normalizeCheckoutEvent({ ...W.stripe.event("checkout.session.completed", s.id, { evtId }), data: { object: { ...W.stripe.sessions[s.id], status: "complete", payment_status: "paid", payment_intent: `pi_${s.id.slice(3)}`, ...patchObj } } }, s.livemode ? "LIVE" : "TEST");
  const code = (ev) => processCheckoutEvent(W.store, st, ev, { now: W.now() }).code;
  assert.equal(code({ ...paid(sLive, {}, "evt_modeA000001"), provider_mode: "TEST" }), "MODE_MISMATCH", "TEST-Ereignis gegen LIVE-Auftrag");
  assert.equal(code({ ...paid(sTest, {}, "evt_modeB000001"), provider_mode: "LIVE" }), "MODE_MISMATCH", "LIVE-Ereignis gegen TEST-Auftrag");
  assert.equal(code(paid(sLive, { amount_total: 23900 }, "evt_amount00001")), "AMOUNT_MISMATCH");
  assert.equal(code(paid(sLive, { currency: "eur" }, "evt_currency001")), "CURRENCY_MISMATCH");
  assert.equal(code(paid(sLive, { metadata: { ...sLive.metadata, order_id: tst.order_id } }, "evt_order000001")), "METADATA_MISMATCH", "fremder Auftrag in den Metadaten");
  assert.equal(code(paid(sLive, { payment_status: "unpaid" }, "evt_unpaid00001")), "CHECKOUT_PENDING", "unbezahlt (z. B. asynchron) = kein Zahlungsereignis");
  assert.equal(code(normalizeCheckoutEvent({ ...W.stripe.event("checkout.session.completed", sLive.id, { evtId: "evt_unknown0001" }), data: { object: { ...sLive, id: "cs_live_fixture9999", status: "complete", payment_status: "paid" } } }, "LIVE")), "UNKNOWN_SESSION");
  assert.equal(paymentsForOrder(W.store, live.order_id).length + paymentsForOrder(W.store, tst.order_id).length, 0, "nichts verbucht");
  // gültig → 1 Eintrag; dasselbe Ereignis erneut → DUPLICATE_EVENT; Absturz vor der Quittung (Ereignis-ID verloren) → ALREADY_RECORDED.
  const ok = paid(sLive, {}, "evt_valid000001");
  assert.equal(processCheckoutEvent(W.store, st, ok, { now: W.now() }).result, "BOOKED");
  assert.equal(processCheckoutEvent(W.store, st, ok, { now: W.now() }).result, "DUPLICATE_EVENT");
  delete st.events[ok.event_id];
  assert.equal(processCheckoutEvent(W.store, st, ok, { now: W.now() }).result, "ALREADY_RECORDED");
  assert.equal(processCheckoutEvent(W.store, st, paid(sLive, {}, "evt_otherid0001"), { now: W.now() }).result, "ALREADY_RECORDED", "zweites Ereignis derselben Zahlung");
  assert.equal(paymentsForOrder(W.store, live.order_id).length, 1, "genau ein Ledger-Eintrag");
  // payments.js: TEST nie auf LIVE, LIVE nie auf TEST (auch nicht von Hand).
  assert.throws(() => recordPayment(W.store, { order_id: tst.order_id, amount: 240, reference: "manuell-1", now: W.now() }), /E2E-Test/);
  assert.throws(() => recordPayment(W.store, { order_id: live.order_id, amount: 240, reference: "manuell-2", provider_mode: "TEST", now: W.now() }), /TESTzahlung/);
  assert.equal(paymentGateForOrder(W.store, W.order(tst.order_id)).satisfied, false, "TEST-Gate ohne TEST-Zahlung zu");
});

test("TF-080 §13/§32 Abgebrochen/abgelaufen: bleibt WAITING_FOR_PAYMENT, genau EINE Ersatz-Session + EINE Erinnerung, danach EXPIRED_FINAL → Chris; nie Zugang", async () => {
  const W = world();
  W.g.notify("real000000000004", formBody(REAL_FORM));
  await W.mailTick();
  W.say(REALMAIL, `Anna Muster <${REALMAIL}>`, "Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  const [o] = W.orders();
  const s1 = W.stripe.last();
  await W.pc.post(W.stripe.event("checkout.session.expired", s1.id, { obj: W.stripe.expire(s1.id) }), { secret: WH.STRIPE_WEBHOOK_SECRET });
  await W.tick(2);
  const s2 = W.stripe.last();
  assert.notEqual(s2.id, s1.id);
  assert.equal(W.stripe.calls.filter((c) => c.method === "POST").at(-1).idem, idempotencyKey(o.order_id, "LIVE", 2));
  const reminders = W.g.sends().filter((x) => /bisherige Zahlungslink .* ist abgelaufen/.test(x.body));
  assert.equal(reminders.length, 1);
  assert.equal(payLinkOf(reminders[0].body), s2.url);
  assert.equal(W.item(REALMAIL).journey.workflow, "WAITING_FOR_PAYMENT");
  W.stripe.expire(s2.id);
  W.advance(24 * 60 * MIN);
  await W.tick(3);
  assert.equal(Object.keys(W.stripe.sessions).length, 2, "keine dritte Session");
  assert.equal(readPaymentLinks(W.onbDir).links[o.order_id].status, "EXPIRED_FINAL");
  assert.equal(W.g.sends().filter((x) => payLinkOf(x.body)).length, 2, "kein Spam");
  assert.ok(W.notes.some((n) => /zweimal abgelaufen/.test(n.reason)));
  assert.equal(W.accessMails().length, 0);
  assert.equal(paymentsForOrder(W.store, o.order_id).length, 0);
});

test("TF-080 §14 Rückerstattung/Streitfall nach Reparaturstart → PAYMENT_REVIEW_REQUIRED (nie automatisch erstattet, nie blind weiter)", async () => {
  const W = world();
  W.g.notify("e2e0000000000005", formBody(TEST_FORM));
  await W.mailTick();
  W.say(TESTBOX, `Sandbox Pruefer <${TESTBOX}>`, "Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  const [o] = W.orders();
  const s = W.stripe.pay(W.stripe.last().id);
  await W.pc.post(W.stripe.event("checkout.session.completed", s.id));
  await W.tick(2);
  assert.equal((await W.submit(linkOf(W.accessMails(TESTBOX)[0].body), { domain: SANDBOX })).status, 200);
  await W.tick();
  assert.ok(!["COMPLETED", "PAYMENT_REVIEW_REQUIRED"].includes(W.order(o.order_id).state));
  const charge = { id: "ch_fixture0001", object: "charge", amount_refunded: 24000, currency: "chf", payment_intent: s.payment_intent, livemode: false };
  assert.equal((await W.pc.post(W.stripe.event("charge.refunded", s.id, { obj: charge, evtId: "evt_refund000001" }))).status, 200);
  const fixesBefore = W.sb.st.fixes;
  await W.tick(2);
  assert.equal(W.order(o.order_id).state, "PAYMENT_REVIEW_REQUIRED");
  assert.equal(W.sb.st.fixes, fixesBefore, "nicht blind weiter");
  assert.equal(paymentsForOrder(W.store, o.order_id)[0].status, "RECEIVED", "kein automatischer Refund/Storno im Ledger");
  assert.ok(W.stripeState().reviews.some((r) => r.code === "REFUND_REVIEW_REQUIRED"));
  assert.ok(!W.stripe.calls.some((c) => /refund/.test(c.path)), "Jarvis ruft nie die Refund-API");
});

test("TF-080 §28/§43/§44 Test ohne E2E-Freigabe / fremde Domain / fremdes Postfach / historisch: sichtbar als TEST, aber kein Auftrag, keine Zahlung, kein Zugang, keine Reparatur", async () => {
  for (const [label, e2e, form] of [["E2E aus", E2E_OFF, TEST_FORM], ["fremde Domain", E2E_ON, { ...TEST_FORM, website: "https://www.muster-garage.ch" }],
    ["fremdes Postfach", E2E_ON, { ...TEST_FORM, email: "jemand@fremd-firma.ch" }]]) {
    const W = world({ e2e });
    W.g.notify("e2e00000000000a6", formBody(form));
    await W.mailTick();
    const it = W.items()[0];
    assert.deepEqual([it.is_test, it.e2e_run, it.journey], [true, false, undefined], label);
    W.say(it.customer_email, `X <${it.customer_email}>`, "Ja, ich bestätige den Auftrag.");
    await W.tick(3);
    assert.deepEqual([W.orders().length, W.stripe.calls.length, W.accessMails().length, W.sb.st.touched.length], [0, 0, 0, 0], label);
    const id = Object.keys(W.pub())[0];
    assert.match(id, /^test-cf-/, label);
    assert.equal(crmLead(W, id).is_test, true, label);
  }
  // historisch (vor TF-080 gespeichert: is_test ohne test_run_id) → HISTORISCH, auch mit E2E-Freigabe nie gestartet.
  const W = world();
  W.mstore.write(cf.CONTACT_FORMS_FILE, { v: 1, seen: {}, items: { "cf:aaaaaaaaaaaaaaaaaaaaaaaa": { key: "cf:aaaaaaaaaaaaaaaaaaaaaaaa", state: cf.STATES.SENT, is_test: true, verified: true,
    intent: cf.REPAIR_INTEREST, customer_email: TESTBOX, customer_website: `https://${SANDBOX}/`, received_at: T0.toISOString(), sent_at: T0.toISOString(), sent_thread_id: "t-alt", form_market: "CH", language: "de" } } });
  await W.tick(2);
  assert.equal(W.items()[0].journey, undefined, "alter Test startet nie rückwirkend");
  const pub = Object.values(cf.publicContactForms(cf.loadContactForms(W.mstore)).leads)[0];
  assert.deepEqual([pub.is_test, pub.test_historical, pub.e2e_run], [true, true, false]);
  assert.equal(W.g.sends().length, 0, "keine Mail an alte Tests");
  // Repair-seitig: Test-Auftrag, dessen Domain nicht (mehr) freigegeben ist → TEST_ACCESS_BLOCKED, kein Adapter, keine Session.
  const o = createContactFormRepairOrder(W.store, { domain: "muster-garage.ch", delivery_email: TESTBOX, contact_form_key: "cf:bbbbbbbbbbbbbbbbbbbbbbbb", confirmed_at: T0.toISOString(), test: { run_id: "e2e-0123456789ab" }, now: T0 });
  await W.repairTick();
  assert.equal(W.order(o.order_id).state, "MANUAL_REVIEW_REQUIRED");
  assert.match(W.order(o.order_id).blocked_reason, /TEST_ACCESS_BLOCKED/);
  assert.equal(W.sb.st.touched.length, 0);
  assert.ok(!Object.values(W.stripe.sessions).some((s) => s.metadata.order_id === o.order_id));
});

test("TF-080 §18/§20/§47 Geschäftskennzahlen: Tests nie in Umsatz, Provision, Verkäufer-Sicht/-KPIs, Kundenzahl, Anrufen; CRM-Filter ALLE/ECHT/TEST; Testlead-Aktionen begrenzt", () => {
  const real = { lead_id: "echt-firma.ch", company: "Echt AG", domain: "echt-firma.ch", phone: "+41 44 123 45 67", sales_stage: "NEW", customer: true, findings: [], contact_form: { lead_source: "CONTACT_FORM", status: "REPLY_SENT", open: true } };
  const testL = { lead_id: "test-cf-0123456789abcdef", is_test: true, company: "Sandbox", phone: "+41 44 999 99 99", sales_stage: "NEW", customer: true, findings: [], contact_form: { lead_source: "CONTACT_FORM", status: "REPLY_SENT", open: true, is_test: true } };
  const stats = crmStats([real, testL]);
  assert.deepEqual([stats.all, stats.test_leads, stats.contact_form_hot, stats.customers ?? 1], [1, 1, 1, stats.customers ?? 1]);
  assert.deepEqual(filterLeads([real, testL], {}).length, 2, "ALLE: Tests sichtbar (E2E-Prüfung)");
  assert.deepEqual(filterLeads([real, testL], { env: "real" }).map((l) => l.lead_id), ["echt-firma.ch"]);
  assert.deepEqual(filterLeads([real, testL], { env: "test" }).map((l) => l.lead_id), ["test-cf-0123456789abcdef"]);
  // Verkäufer: Testlead gehört niemandem, nur Owner sieht ihn.
  assert.equal(sellerOf(testL, null), null);
  assert.equal(canSeeLead({ role: "SALES_AGENT_CH", user_id: "giuliano" }, testL, null), false);
  assert.equal(canSeeLead({ role: "OWNER", user_id: "chris" }, testL, null), true);
  assert.deepEqual(scopeLeads({ role: "SALES_AGENT_CH", user_id: "giuliano" }, [real, testL], null).map((l) => l.lead_id), ["echt-firma.ch"]);
  // Anrufe: nie (Mensch/KI), auch mit Rückrufwunsch + Einwilligung.
  assert.equal(eligibility({ ...testL, contact_form: { ...testL.contact_form, callback_requested: true, verified: true } }, { consent: { evidence: { ok: true } } }).code, "TEST_BLOCKED");
  assert.equal(callRecommended(testL), false);
  // Provision/Umsatz: Test-Aufträge fallen weg.
  const snap = { repair: { orders: [{ order_id: "RF480-20261018-abcdef", domain: SANDBOX, offer_class: "REPAIR_FIX_500", price_chf: 480, paid_chf: 480, state: "COMPLETED", payment_status: "PAID_FULL", test_order: true, environment: "TEST" },
    { order_id: "RF480-20261018-fedcba", domain: "echt-firma.ch", offer_class: "REPAIR_FIX_500", price_chf: 480, paid_chf: 480, state: "COMPLETED", payment_status: "PAID_FULL", test_order: false, environment: "LIVE" }] } };
  assert.deepEqual(ordersFromSnapshot(snap).map((o) => o.order_id), ["RF480-20261018-fedcba"]);
  // … auch nach der Cloud-Whitelist (Server-Control-Snapshot) – das Test-Kennzeichen geht nie verloren.
  assert.deepEqual(ordersFromSnapshot({ repair: cleanRepair(snap.repair) }).map((o) => o.order_id), ["RF480-20261018-fedcba"]);
  assert.deepEqual(cleanRepair(snap.repair).orders.map((o) => o.environment), ["TEST", "LIVE"]);
  // CRM-Schreibaktionen auf Testleads: nur Notiz/Archiv/erledigt (keine Verkaufsstufe, kein Anruf, kein DNC).
  const state = { leads: {}, meta: { applied: {} } };
  const lookup = (id) => (id === testL.lead_id ? testL : null);
  assert.equal(applyCrmAction(state, { action: "crm.updateStage", params: { lead_id: testL.lead_id, stage: "CUSTOMER" } }, { lookup }).code, "TEST_LEAD");
  assert.equal(applyCrmAction(state, { action: "crm.setDoNotContact", params: { lead_id: testL.lead_id, value: true } }, { lookup }).code, "TEST_LEAD");
  assert.equal(applyCrmAction(state, { action: "crm.addNote", params: { lead_id: testL.lead_id, text: "E2E ok" } }, { lookup }).ok, true);
});

test("TF-080 §27 Bereinigung: nur genau ein Testlauf, nie Platzhalter, echte Datensätze bleiben unberührt", async () => {
  const W = world();
  W.g.notify("e2e0000000000007", formBody(TEST_FORM));
  W.g.notify("real000000000007", formBody(REAL_FORM));
  await W.mailTick();
  W.say(TESTBOX, `Sandbox Pruefer <${TESTBOX}>`, "Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  const run = W.item(TESTBOX).test_run_id;
  // Produktiv läuft die CLI je Container (Mail: Einsendungen, Repair: Aufträge); hier beide Zustände in einem Worker-Verzeichnis.
  const sec = tmp(), wdir = path.join(sec, "mail_worker");
  fs.mkdirSync(wdir);
  for (const [d, f] of [[W.mail, cf.CONTACT_FORMS_FILE], [W.state, REPAIR_ORDERS_FILE], [W.state, "payments.json"]]) if (fs.existsSync(path.join(d, f))) fs.copyFileSync(path.join(d, f), path.join(wdir, f));
  const env = { ...process.env, JARVIS_SECRETS_DIR: sec };
  delete env.NODE_TEST_CONTEXT; // wie von Hand auf dem VPS (nicht als Testdatei)
  const cli = (...a) => spawnSync(process.execPath, ["e2e-test.js", ...a], { cwd: path.resolve(import.meta.dirname, ".."), env, encoding: "utf8" });
  assert.notEqual(cli("cleanup", "*").status, 0, "Platzhalter verweigert");
  assert.notEqual(cli("cleanup").status, 0);
  const lr = cli("list");
  assert.equal(lr.status, 0, lr.stderr);
  const listed = JSON.parse(lr.stdout);
  assert.deepEqual(listed.map((r) => r.test_run_id), [run]);
  const r = cli("cleanup", run);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { test_run_id: run, submissions_archived: 1, test_orders_cancelled: 1 });
  const s = createStore(wdir);
  const after = cf.loadContactForms(s).items;
  assert.equal(Object.values(after).find((x) => x.customer_email === REALMAIL).archived_test, undefined, "echte Anfrage unberührt");
  assert.deepEqual(Object.keys(cf.publicContactForms({ items: after }).leads), [REAL], "Test aus dem CRM, echter Lead bleibt");
  assert.equal(Object.values(s.read(REPAIR_ORDERS_FILE, { orders: {} }).orders)[0].state, "CANCELLED");
});

test("cleanup", () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
