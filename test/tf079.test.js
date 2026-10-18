// TF-079 – Kontaktformular → automatisches Gespräch → bestätigter FIX-Auftrag → Zahlungsschwelle → sicherer Link → Zugang → Backup → Reparatur →
// Validierung → Retest → Abschluss → Tresor zerstört. Alles mit Attrappen: 0 echte Mails, 0 echte Websites, 0 echte Zugangsdaten, 0 Netz.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { REPAIR_ORDERS_FILE, createConfirmedRepairOrder, runRepairOrders } from "../repair-workflow.js";
import { runCheck150Orders } from "../check-150-workflow.js";
import { createAccessIntakeHandler, memoryIntakeStore } from "../access-intake-api.js";
import { intakeClient, sealEnvelope, hasAccessSecret } from "../access-intake.js";
import { gateDecision } from "../repair-browser-validator.js";
import { processRepairOutbox } from "../repair-outbox.js";
import { repairServiceIteration } from "../repair-service.js";
import * as C from "../onboarding-core.js";
import { createOnboarding, loadOnboarding } from "../onboarding-dialogue.js";
import { readOrdersExport, listContactOrderRequests } from "../onboarding-store.js";
import { detectPlatform } from "../hosting-detect.js";
import * as cf from "../contact-form.js";
import { processContactJourneys, contactThreadFor, journeyThreads, isOrderConfirmation, decideJourney, journeyWorkflow } from "../contact-form-journey.js";
import { applyContactFormOrders } from "../onboarding-repair.js";
import { cleanContactForm } from "../lead-crm.js";

const T0 = new Date("2026-10-18T09:00:00Z");
const MIN = 60_000;
const DOMAIN = "muster-garage.ch", SITE = `https://${DOMAIN}/`, EMAIL = "anna@muster-garage.ch";
const GOOD = "Tf79-Gut-Secret-7c1e", PW_MAIL = "Geheim-TF79-Mail-x9q!";
const MAILBOX = "chris@helvetic.test";
const AUTH = "mx.google.com; dkim=pass header.i=@netlify.com header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@netlify.com; dmarc=pass (p=NONE) header.from=netlify.com";
const CFG = { ...cf.DEFAULT_CONTACT_FORM_CONFIG, forms: [{ form_name: "anfrage", site: "helvetic-webdesign-reperatur", market: "CH" }], receivingMailboxes: [MAILBOX] };
const ASKS_PASSWORD_BY_MAIL = /(senden|schicken|mailen|teilen) Sie (mir|uns) (bitte )?(Ihr(en)?|das|den) (Passwort|Benutzernamen|Zugangsdaten|Login)/i;
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf079-")); made.push(d); return d; };
const body = ({ interest = "Check & Reparatur", website = "https://www.muster-garage.ch", name = "Anna Muster", email = EMAIL, msg = "Das Kontaktformular sendet nichts ab." } = {}) =>
  ["Ihre Website *:", website, "", "Name *:", name, "", "E-Mail *:", email, "", "Interesse an:", interest, "", "Was funktioniert nicht?", msg, ""].join("\r\n");

// ---------- Welt: Mail-Worker (Kontaktformular + Kundenweg + Outbox + Onboarding) und Repair-Service ----------
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
      log.push({ threadId: d.threadId, to: d.to, messageClass: d.messageClass, subject: d.subject, body: d.body, inReplyTo: d.inReplyTo });
      return { messageId: mid, threadId: d.threadId };
    },
    async readThread(threadId) { if (!owned(threadId)) throw new Error("Thread nicht von Jarvis."); return { threadId, messages: threads.get(threadId).map((m) => ({ ...m })) }; },
    customer(threadId, { from = `Anna Muster <${EMAIL}>`, body }) {
      const mid = `c${++n}`;
      threads.get(threadId).push({ messageId: mid, rfcMessageId: `<${mid}@kunde.test>`, from, replyTo: "", to: MAILBOX, subject: "Re: Ihre Anfrage", body, sent: false, draft: false, internalDate: clock() + 1000 });
      return mid;
    },
    notify(id, { rfc = `<${id}.formresponses@netlify.com>`, b = body() } = {}) {
      inbound[id] = { messageId: id, rfcMessageId: rfc, threadId: "nf-" + id, from: '"helvetic-webdesign-reperatur.netlify.app" <formresponses@netlify.com>', replyTo: "",
        to: MAILBOX, deliveredTo: MAILBOX, subject: "Neue Kundenanfrage – submission from helvetic-webdesign-reperatur (anfrage)", body: b, internalDate: String(clock()),
        headers: { "authentication-results": [AUTH] } };
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
function labWorld({ regress = false } = {}) {
  const st = { linkFixed: false, checks: [], preflights: [], backups: 0, fixes: 0, rollbacks: 0, page: '<html><body><h1>Muster Garage</h1><a href="/team-alt">Team</a></body></html>' };
  const BROKEN = { type: "broken_link", url: `${SITE}team-alt`, page: SITE, label: "Team", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true };
  const NEW = { type: "broken_image", url: `${SITE}logo.png`, page: SITE, label: "Logo", evidence: "HTTP 404", severity: "high", detectedAt: T0.toISOString(), reproducible: true };
  const secretOf = (ctx) => ctx?.credential?.()?.secret || null;
  const adapter = { direct_live: true,
    checkAccess: async (_o, ctx) => { st.checks.push(secretOf(ctx)); return secretOf(ctx) === GOOD ? { ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] } : { ok: false, reason: "auth_failed" }; },
    backup: async () => { st.backups++; return { production_ref: "p1", backup_ref: "local:object-backup", rollback_point: "per-object-original" }; },
    locate: async () => ({ target: "index.html", cause: "Link 404", planned_change: "href ersetzen", risk: "niedrig", fix: { replacement: "/team.html" } }),
    applyFix: async () => { st.fixes++; st.linkFixed = true; st.page = st.page.replace("/team-alt", "/team.html"); return { ok: true, change_ref: "lab:link" }; },
    validate: async () => ({ build_ok: true }), deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }),
    rollback: async () => { st.rollbacks++; st.linkFixed = false; st.rolledBack = true; st.page = st.page.replace("/team.html", "/team-alt"); return { ok: true }; } };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Muster Garage", requests: 3, pages: { home: st.page },
    issues: [...(st.linkFixed ? [] : [BROKEN]), ...(regress && st.linkFixed ? [NEW] : [])] }) };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    const out = { url, phase, desktop: vp(phase !== "baseline" && st.linkFixed), mobile: vp(phase !== "baseline" && st.linkFixed) };
    if (regress && phase === "after") { out.desktop.images = { visible: 3, broken: 1, broken_paths: ["/logo.png"] }; out.mobile.images = { visible: 3, broken: 1, broken_paths: ["/logo.png"] }; }
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  const preflight = { run: async (_o, { accessCtx }) => { st.preflights.push(secretOf(accessCtx)); return secretOf(accessCtx) === GOOD
    ? { profile_status: "PROFILE_READY", reason: "lab_verified", profile: { interface: "lab", capabilities: ["READ_FILES", "WRITE_FILES"] } } : { profile_status: "BLOCKED_NO_ACCESS", reason: "auth_failed" }; } };
  return { st, adapter, auditor, browserValidator, preflight, router: { route: async () => ({ adapter: "static", label: "Lab" }) } };
}
const WT = "w".repeat(43);
function cloud() {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined) });
  const call = async (b, headers = {}) => { const r = await handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) })); return { status: r.status, body: await r.json() }; };
  return { blobs, handler, call, client: intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn: async (url, init) => handler(new Request(url, init)) }) };
}
const linkOf = (b) => b.match(/https:\/\/jarvis\.test\/access\.html#t=[A-Za-z0-9_%-]+(&l=vi)?/)?.[0] || null;
const tokenOf = (link) => decodeURIComponent(link.split("#t=")[1].split("&")[0]);

function world({ regress = false } = {}) {
  const state = tmp(), ob = tmp(), mail = tmp();
  const store = createStore(state), mstore = createStore(mail);
  let clock = +T0;
  const now = () => new Date(clock);
  const g = threadGmail(() => clock), c = cloud(), w = labWorld({ regress }), notes = [], logs = [];
  const onbDir = path.join(ob, "onboarding");
  const extract = async () => ({ facts: [], clarifications: [], classes: ["OTHER"], sensitive_detected: false, customer_says_no_more_changes: false, confirmation: false, correction_requested: false, confidence: "low" });
  const onb = createOnboarding({ dir: mail, onboardingDir: onbDir, gmail: g, extract, now, notify: async (x) => { notes.push(x); }, log: (...a) => logs.push(JSON.stringify(a)),
    contactThreadFor: (id, email) => contactThreadFor(mstore, id, email) });
  const runRepair = (opts) => runRepairOrders({ ...opts, adapters: { static: w.adapter }, router: w.router, preflight: w.preflight, browserValidator: w.browserValidator, auditor: w.auditor,
    platformDetector: async () => detectPlatform({ headers: { link: '<https://k.test/wp-json/>; rel="https://api.w.org/"' }, html: '<html><head><meta name="generator" content="WordPress 6.6"><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head></html>' }),
    log: (...a) => logs.push(JSON.stringify(a)) });
  const W = {
    state, ob, mail, store, mstore, g, c, w, notes, logs, onb, onbDir,
    advance: (ms = 5 * MIN) => { clock += ms; },
    contactTick: async () => {
      const r = await cf.processContactForms({ gmail: g, store: mstore, cfg: CFG, sender: { name: "Chris", signature: "Chris\nHelvetic Webdesign" }, ownAddresses: [MAILBOX], now: now(), autoReply: true,
        orders: () => readOrdersExport(onbDir).orders || {}, escalate: async (x) => { notes.push(x); }, log: (...a) => logs.push(JSON.stringify(a)) });
      const j = await processContactJourneys({ gmail: g, store: mstore, onboardingDir: onbDir, boundOrders: () => new Set(onb.boundThreads().values()), now: now(),
        escalate: async (x) => { notes.push(x); }, log: (...a) => logs.push(JSON.stringify(a)) });
      return { r, j };
    },
    repairTick: () => repairServiceIteration({ dir: state, outboxDir: ob, intake: c.client, runRepair, runCheck150: (o) => runCheck150Orders({ ...o, auditor: w.auditor }), onboarding: true }),
    mailTick: async () => { const x = await W.contactTick(); await processRepairOutbox({ dir: ob, gmail: g, onboarding: onb, now }); await onb.process(); return x; },
    tick: async (k = 1) => { for (let i = 0; i < k; i++) { W.advance(); await W.mailTick(); await W.repairTick(); await W.mailTick(); await W.repairTick(); } },
    items: () => Object.values(cf.loadContactForms(mstore).items),
    item: () => W.items()[0],
    orders: () => Object.values(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders || {}),
    order: (id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id],
    exp: (id) => readOrdersExport(onbDir).orders[id],
    rec: (id) => loadOnboarding(mail).records[id],
    say: (b) => { W.advance(MIN); return g.customer(W.item().sent_thread_id, { body: b }); },
    pay: (id, amount = 240) => recordPayment(store, { order_id: id, amount_chf: amount, reference: `TF79-${id}-${amount}`, now: now() }),
    accessMails: () => g.sends().filter((s) => s.messageClass === "CUSTOMER_ACCESS_REQUEST"),
    submit: async (link, { secret = GOOD, domain = DOMAIN, access_type = "wordpress_cms" } = {}) => {
      const info = await c.call({ op: "info", token: tokenOf(link) });
      return c.call({ op: "submit", token: tokenOf(link), access_type, access_domain: domain, consent: true,
        envelope: sealEnvelope({ access_type, host: `${SITE}wp-admin`, username: "jarvis-temp", secret }, info.body.public_key) });
    },
    allFiles: () => [state, ob, mail].flatMap((d) => fs.readdirSync(d, { recursive: true }).map(String).map((f) => path.join(d, f)))
      .filter((f) => fs.statSync(f).isFile() && !/access_vault|access_intake_private/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n"),
  };
  return W;
}
// Bis zum bestätigten Auftrag (gemeinsamer Anfang mehrerer Tests).
async function confirmedOrder(W) {
  W.g.notify("a1b2c3d4e5f60001");
  await W.mailTick();
  W.say("Guten Tag\n\nJa, ich bestätige den Auftrag.\n\nFreundliche Grüsse\nAnna Muster");
  await W.tick(2);
  const [o] = W.orders();
  return o?.order_id;
}

// ======================================================================================================================================
test("TF-079 §3 Interesse: nur das Formularfeld «Interesse an» zählt (Check & Reparatur / CHF 480 / REPAIR_FIX_500), nie eine Problembeschreibung", () => {
  for (const v of ["Check & Reparatur", "check und reparatur", "Check & Reparatur (CHF 480)", "Check & Reparatur – CHF 480.–", "CHF 480", "REPAIR_FIX_500", "«Check & Reparatur»"]) assert.ok(cf.repairInterestOf(v), v);
  for (const v of ["Reparatur und Wartung", "Check & Anleitung", "CHF 150", "Website erstellen", "", null, "Meine Website hat einen Fehler, bitte reparieren"]) assert.equal(cf.repairInterestOf(v), false, String(v));
  const msg = (interest) => ({ messageId: "abcdef0123456789", rfcMessageId: "<x@netlify.com>", from: "formresponses@netlify.com", to: MAILBOX, deliveredTo: MAILBOX,
    subject: "Neue Kundenanfrage – submission from helvetic-webdesign-reperatur (anfrage)", body: body({ interest, msg: "Website kaputt, bitte reparieren!" }), internalDate: String(+T0), headers: { "authentication-results": [AUTH] } });
  assert.equal(cf.classifyInbound(msg("Check & Reparatur"), { cfg: CFG, ownAddresses: [MAILBOX] }).item.intent, cf.REPAIR_INTEREST);
  assert.equal(cf.classifyInbound(msg("Reparatur und Wartung"), { cfg: CFG, ownAddresses: [MAILBOX] }).item.intent, null, "Problemtext allein ist kein FIX");
});

test("TF-079 §29 Happy Path: Formular → sofortige Antwort → P0 → ausdrückliche Bestätigung → genau ein Auftrag → Zahlung blockiert → Zahlung → sicherer Link automatisch → verschlüsselter Zugang → Prüfung → Backup → Reparatur → Validierung → Retest → Abschluss → Tresor zerstört", async () => {
  const W = world();
  W.g.notify("a1b2c3d4e5f60001");
  await W.mailTick();
  // 1. automatische erste Antwort (genau eine), mit den nächsten Schritten – kein Link, keine Passwortfrage.
  const first = W.g.sends();
  assert.equal(first.length, 1);
  assert.equal(first[0].to, EMAIL);
  assert.match(first[0].body, /«Check & Reparatur» \(Festpreis CHF 480\) für Ihre Website muster-garage\.ch/);
  assert.match(first[0].body, /«Ja, ich bestätige den Auftrag»/);
  assert.ok(!linkOf(first[0].body) && !/#t=/.test(first[0].body), "kein Link vor Auftrag/Zahlung");
  assert.doesNotMatch(first[0].body, ASKS_PASSWORD_BY_MAIL);
  const it = W.item();
  assert.deepEqual([it.state, it.verified, it.intent, it.journey.state], [cf.STATES.SENT, true, cf.REPAIR_INTEREST, "WAITING_FOR_CONFIRMATION"]);
  // 2. CONTACT_FORM_P0 + Kundenweg im CRM.
  const pub = JSON.parse(fs.readFileSync(path.join(W.mail, cf.CONTACT_FORMS_PUBLIC_FILE), "utf8")).leads[DOMAIN];
  assert.equal(pub.priority_class, cf.PRIORITY_CLASS);
  assert.equal(pub.workflow_status, "WAITING_FOR_CONFIRMATION");
  assert.equal(cleanContactForm({ ...pub, open: true }).workflow_status, "WAITING_FOR_CONFIRMATION");
  assert.ok(journeyThreads(W.mstore).has(it.sent_thread_id), "Thread vom allgemeinen Antwort-Scan ausgenommen");
  await W.tick();
  assert.equal(W.orders().length, 0, "Interesse allein erzeugt keinen Auftrag");
  // 3./4. ausdrückliche Bestätigung → genau ein Auftrag, keine Reparaturfreigabe.
  W.say("Guten Tag\n\nJa, ich bestätige den Auftrag.\n\nFreundliche Grüsse\nAnna Muster");
  await W.tick(2);
  assert.equal(W.orders().length, 1);
  const id = W.orders()[0].order_id;
  let o = W.order(id);
  assert.match(id, /^RF480-/);
  assert.deepEqual([o.domain, o.delivery_email, o.offer_class, o.price_chf, o.contact_form.key, o.customer_authorized_repair], [DOMAIN, EMAIL, "REPAIR_FIX_500", 480, it.key, false]);
  assert.equal(o.state, "AUTHORIZATION_REQUIRED", "Auftrag ≠ Freigabe");
  const conf = W.g.sends().find((s) => /vielen Dank für Ihre Bestätigung/.test(s.body));
  assert.ok(conf, "Auftragsbestätigung gesendet");
  assert.equal(conf.threadId, it.sent_thread_id, "im selben Verlauf");
  assert.match(conf.body, new RegExp(`Auftragsnummer ${id}`));
  assert.match(conf.body, /ersten Hälfte des Festpreises \(CHF 240\)/);
  assert.doesNotMatch(conf.body, ASKS_PASSWORD_BY_MAIL);
  assert.ok(W.notes.some((n) => /Zahlungsangaben an den Kunden senden/.test(n.reason)), "Chris weiss vom neuen Auftrag");
  // 5. Zahlungsschwelle blockiert: kein Link, keine Registrierung, keine Reparatur.
  await W.tick(2);
  assert.equal(W.accessMails().length, 0);
  assert.equal(JSON.parse(W.c.blobs.dump()).length, 0, "kein Token registriert");
  assert.equal(W.exp(id).payment_gate_met, false);
  assert.equal(W.item().journey.workflow, "WAITING_FOR_PAYMENT");
  // 6./7. Zahlung → sicherer Link automatisch, im Kontaktformular-Verlauf, genau einmal.
  W.pay(id);
  await W.tick(2);
  const acc = W.accessMails();
  assert.equal(acc.length, 1, "genau eine Zugangs-Anfrage");
  assert.equal(acc[0].threadId, it.sent_thread_id, "Link im bestehenden Kontaktformular-Thread");
  const link = linkOf(acc[0].body);
  assert.ok(link, "existierender One-Time-Link (access-intake)");
  assert.ok(acc[0].body.includes(C.NO_PASSWORD_DE));
  assert.doesNotMatch(acc[0].body, ASKS_PASSWORD_BY_MAIL);
  assert.equal(W.order(id).state, "ACCESS_REQUESTED");
  assert.equal(W.item().journey.state, "HANDED_OFF", "Dialog übernimmt den Verlauf");
  assert.equal(W.rec(id).thread_id, it.sent_thread_id);
  assert.equal(W.item().journey.workflow, "ACCESS_REQUESTED");
  assert.equal(Object.values(W.rec(id).processed).filter((p) => p.result !== "pre_binding").length, 0, "frühere Bestätigung nicht erneut als Onboarding-Antwort gewertet");
  // 8./9./10. verschlüsselter Zugang → geprüft, Domain gebunden.
  assert.equal((await W.submit(link)).status, 200);
  await W.tick();
  o = W.order(id);
  assert.equal(o.access_intake.status, "RECEIVED");
  assert.deepEqual([o.customer_authorized_repair, o.authorization.authorized_domain, o.authorization.source], [true, DOMAIN, "secure_order_access_form"]);
  assert.ok(W.w.st.preflights.includes(GOOD) && W.w.st.checks.includes(GOOD), "Preflight + Zugangsprüfung mit dem Tresor-Zugang");
  // Brief-Gate (Onboarding): «Nein» = keine Inhaltsänderungen.
  W.say("Nein, sonst nichts.");
  await W.tick(3);
  o = W.order(id);
  // 11.–16.
  assert.ok(["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"].includes(o.state), o.state);
  assert.equal(W.w.st.backups, 1, "Backup vor der Änderung");
  assert.equal(W.w.st.fixes, 1, "unterstützte Reparatur");
  assert.equal(o.validation.build_ok, true);
  assert.equal(o.retest.http_ok !== false, true);
  assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.regression], ["JA", "JA", "KEINE"]);
  assert.equal(hasAccessSecret(W.state, id), false, "Tresor-Eintrag zerstört");
  assert.equal(o.access_intake.status, "DESTROYED");
  assert.equal(W.item().journey.workflow, "COMPLETED");
  assert.ok(W.g.sends().some((s) => s.messageClass === "CUSTOMER_ORDER_FULFILLMENT"), "Abschlussbericht an den Kunden");
  assert.ok(!W.allFiles().includes(GOOD), "Zugangsdaten nie ausserhalb des Tresors");
  assert.equal(W.g.sends().filter((s) => s.messageClass === "CONTACT_FORM_INQUIRY").length, 1, "genau eine erste Antwort");
});

test("TF-079 §30 Bestätigter Auftrag ohne CHF 240: kein Token, keine Zugangs-Anfrage, keine Reparatur – Kundenfrage zum Zugang wird ohne Link beantwortet", async () => {
  const W = world();
  const id = await confirmedOrder(W);
  W.pay(id, 100); // unter der Schwelle
  await W.tick(3);
  assert.equal(W.accessMails().length, 0);
  assert.equal(JSON.parse(W.c.blobs.dump()).length, 0);
  assert.equal(W.order(id).state, "AUTHORIZATION_REQUIRED");
  assert.equal(W.exp(id).payment_gate_met, false);
  assert.equal(W.item().journey.workflow, "WAITING_FOR_PAYMENT");
  assert.equal(W.w.st.checks.length + W.w.st.backups + W.w.st.fixes, 0);
  const before = W.g.sends().length;
  W.say("Wie gebe ich euch Zugriff?");
  await W.tick();
  const r = W.g.sends().slice(before);
  assert.equal(r.length, 1);
  assert.ok(r[0].body.includes("Für die Reparatur benötigen wir einen sicheren Zugang. Bitte verwenden Sie dafür den einmaligen Zugangslink"));
  assert.match(r[0].body, /sobald die erste Hälfte des Festpreises \(CHF 240\) eingegangen ist/);
  assert.ok(!linkOf(r[0].body));
  assert.doesNotMatch(r[0].body, ASKS_PASSWORD_BY_MAIL);
  W.say("Was kostet das genau?");
  await W.tick();
  assert.match(W.g.sends().at(-1).body, /noch ausstehend/);
});

test("TF-079 §31 Test-Einsendung: Antwort wie bisher, aber 0 Aufträge, 0 Zahlungsbitten, 0 Links, 0 Reparaturen – auch nach «Ja, ich bestätige»", async () => {
  const W = world();
  W.g.notify("a1b2c3d4e5f60002", { b: body({ msg: "Testlauf ohne Echtgeld – bitte ignorieren." }) });
  await W.mailTick();
  assert.equal(W.g.sends().length, 1, "Test-Antwort erlaubt");
  assert.equal(W.item().is_test, true);
  assert.ok(!/Ja, ich bestätige den Auftrag/.test(W.g.sends()[0].body), "keine Auftragsschritte für Tests");
  assert.equal(W.item().journey, undefined);
  W.say("Ja, ich bestätige den Auftrag.");
  await W.tick(3);
  assert.equal(W.orders().length, 0);
  assert.equal(listContactOrderRequests(W.onbDir).length, 0);
  assert.equal(W.g.sends().length, 1, "keine Bestätigung/Zahlungsbitte");
  assert.equal(W.accessMails().length, 0);
  assert.equal(JSON.parse(W.c.blobs.dump()).length, 0);
  assert.equal(W.w.st.fixes, 0);
});

test("TF-079 §32 Zugang für eine andere Domain: abgelehnt, kein Adapter, keine Reparatur", async () => {
  const W = world();
  const id = await confirmedOrder(W);
  W.pay(id);
  await W.tick(2);
  const link = linkOf(W.accessMails()[0].body);
  const r = await W.submit(link, { domain: "fremde-firma.ch" });
  assert.notEqual(r.status, 200, "Cloud lehnt fremde Domain ab");
  await W.tick(2);
  const o = W.order(id);
  assert.equal(o.state, "ACCESS_REQUESTED");
  assert.notEqual(o.access_intake?.status, "RECEIVED");
  assert.equal(hasAccessSecret(W.state, id), false);
  assert.deepEqual([W.w.st.checks.length, W.w.st.preflights.length, W.w.st.fixes], [0, 0, 0]);
});

test("TF-079 §33 Passwort im Klartext per Mail: erkannt, nicht gespeichert, nicht wiederholt, Hinweis auf den sicheren Link", async () => {
  const W = world();
  W.g.notify("a1b2c3d4e5f60003");
  await W.mailTick();
  W.say(`Hallo, hier ist mein WordPress-Login. Benutzer: admin\nPasswort: ${PW_MAIL}\nGruss Anna`);
  await W.tick();
  const hint = W.g.sends().at(-1);
  assert.equal(hint.messageClass, C.ONBOARDING_CLASS);
  assert.ok(hint.body.includes(C.SENSITIVE_NOLINK_DE));
  assert.ok(hint.body.includes("Für die Reparatur benötigen wir einen sicheren Zugang."));
  assert.ok(!hint.body.includes(PW_MAIL) && !hint.body.includes("admin"), "nie wiederholt");
  assert.ok(!W.allFiles().includes(PW_MAIL), "nirgends gespeichert (Zustand, CRM, Logs)");
  assert.ok(!W.logs.join("\n").includes(PW_MAIL));
  assert.ok(!W.notes.some((n) => JSON.stringify(n).includes(PW_MAIL)));
  assert.equal(W.item().journey.sensitive_received, 1);
  assert.equal(W.item().journey.state, "WAITING_FOR_CONFIRMATION", "kein Auftrag aus einer Passwort-Mail");
  assert.equal(W.orders().length, 0);
});

test("TF-079 §34 Duplikate: doppelte Benachrichtigung → 1 Antwort; doppelte Bestätigung → 1 Auftrag; Worker-Zyklen → 1 Zugangs-Anfrage; doppelte Einreichung → ein Tresor-Eintrag, keine doppelte Reparatur", async () => {
  const W = world();
  W.g.notify("a1b2c3d4e5f60004", { rfc: "<same@netlify.com>" });
  W.g.notify("a1b2c3d4e5f60005", { rfc: "<same@netlify.com>" });
  await W.mailTick();
  await W.mailTick();
  assert.equal(W.g.sends().filter((s) => s.messageClass === "CONTACT_FORM_INQUIRY").length, 1);
  assert.equal(W.items().length, 1);
  W.say("Ja, ich bestätige den Auftrag.");
  W.say("Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  W.say("Ich bestätige hiermit den Auftrag.");
  await W.tick(2);
  assert.equal(W.orders().length, 1, "genau ein Auftrag");
  assert.equal(listContactOrderRequests(W.onbDir).length, 1);
  assert.equal(W.g.sends().filter((s) => /vielen Dank für Ihre Bestätigung/.test(s.body)).length, 1, "eine Bestätigungsmail");
  // Erneutes Anwenden derselben Bitte (Neustart) → derselbe Auftrag.
  const again = applyContactFormOrders({ dir: W.state, onboardingDir: W.onbDir });
  assert.deepEqual([again.created, again.bound], [0, 0]);
  const id = W.orders()[0].order_id;
  W.pay(id);
  await W.tick(4);
  assert.equal(W.accessMails().length, 1, "eine Zugangs-Anfrage trotz mehrerer Zyklen");
  const link = linkOf(W.accessMails()[0].body);
  const pk = (await W.c.call({ op: "info", token: tokenOf(link) })).body.public_key;
  assert.equal((await W.submit(link)).status, 200);
  assert.notEqual((await W.c.call({ op: "info", token: tokenOf(link) })).status, 200, "One-Time-Link nach der Einreichung tot");
  const again2 = await W.c.call({ op: "submit", token: tokenOf(link), access_type: "wordpress_cms", access_domain: DOMAIN, consent: true,
    envelope: sealEnvelope({ access_type: "wordpress_cms", host: `${SITE}wp-admin`, username: "x", secret: "Zweit-Versuch-1" }, pk) });
  assert.notEqual(again2.status, 200, "zweite Einreichung abgelehnt");
  W.say("Nein, sonst nichts.");
  await W.tick(4);
  assert.equal(W.w.st.fixes, 1, "keine doppelte Reparatur");
  assert.equal(W.w.st.backups, 1);
  assert.equal((W.order(id).access_intake_history || []).length, 0, "ein angenommener Zugang");
});

test("TF-079 §19 Regression nach der Änderung → Rollback → Retest, nie als Erfolg; Zugang zerstört (REPAIR_FAILED)", async () => {
  const W = world({ regress: true });
  const id = await confirmedOrder(W);
  W.pay(id);
  await W.tick(2);
  assert.equal((await W.submit(linkOf(W.accessMails()[0].body))).status, 200);
  await W.tick();
  W.say("Nein, sonst nichts.");
  await W.tick(3);
  const o = W.order(id);
  assert.ok(["REPAIR_FAILED", "MANUAL_REVIEW_REQUIRED"].includes(o.state), o.state);
  assert.equal(W.w.st.rollbacks, 1, "Rollback ausgeführt");
  assert.ok(!W.g.sends().some((s) => s.messageClass === "CUSTOMER_ORDER_FULFILLMENT"), "keine Erfolgsmail");
  assert.equal(W.item().journey.workflow, "MANUAL_REVIEW");
  if (o.state === "REPAIR_FAILED") assert.equal(hasAccessSecret(W.state, id), false);
});

test("TF-079 §9 Erste Antwort bei bereits bestätigtem + bezahltem Auftrag derselben Adresse/Domain: Hinweis auf den sicheren Link (ohne Link/Token) – unbezahlt nie", async () => {
  for (const paid of [true, false]) {
    const W = world();
    const o = createConfirmedRepairOrder(W.store, { domain: DOMAIN, website: SITE, company: "Muster Garage", delivery_email: EMAIL, contact_name: "Anna Muster", now: T0 });
    if (paid) W.pay(o.order_id);
    // Nur Export schreiben (noch kein Versand): Repair-Service-Lauf ohne Gmail-Zustellung.
    (await import("../onboarding-repair.js")).writeOnboardingOrders({ dir: W.state, onboardingDir: W.onbDir, now: T0 });
    W.g.notify("a1b2c3d4e5f60006");
    await W.contactTick();
    const b = W.g.sends()[0].body;
    assert.ok(!linkOf(b) && !/#t=/.test(b), "nie ein Link in der Formular-Antwort");
    if (paid) {
      assert.ok(b.includes(cf.SECURE_ACCESS_DE), "sicherer Zugangsschritt sofort genannt");
      assert.match(b, new RegExp(`${o.order_id}\\) für ${DOMAIN.replace(".", "\\.")} ist bestätigt`));
      assert.deepEqual([W.item().journey.state, W.item().journey.order_id], ["ORDER_BOUND", o.order_id]);
      await W.tick(2);
      assert.equal(W.accessMails().length, 1);
      assert.equal(W.accessMails()[0].threadId, W.item().sent_thread_id, "Link im Formular-Verlauf");
      assert.equal(W.orders().length, 1, "kein zweiter Auftrag");
    } else {
      assert.ok(!b.includes(cf.SECURE_ACCESS_DE));
      assert.match(b, /«Ja, ich bestätige den Auftrag»/);
    }
  }
});

test("TF-079 §4/§22 Interesse ≠ Freigabe; unklare Antwort, Inhaltswunsch vor Auftrag, Preisverhandlung, Stopp → Chris bzw. Ende, nie geraten", async () => {
  // reine Entscheidungen
  const j = { state: "WAITING_FOR_CONFIRMATION" };
  for (const t of ["Ja, ich bestätige den Auftrag.", "Ja", "Ja bitte", "Wir erteilen Ihnen den Auftrag.", "Ich möchte den Auftrag erteilen."]) assert.ok(isOrderConfirmation(t), t);
  for (const t of ["Ja, aber erst nächsten Monat.", "Vielleicht später.", "Nein danke", "Ich überlege es mir noch.", "Ok", "Meine Website hat einen Fehler.", "> Ja, ich bestätige den Auftrag\nWas kostet es?"]) assert.equal(isOrderConfirmation(t), false, t);
  assert.equal(decideJourney({ j, text: "Bitte ändert zusätzlich meine Telefonnummer auf 044 123 45 67." }).result, "unclear_review");
  assert.equal(decideJourney({ j, text: "Gibt es einen Rabatt?" }).state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(decideJourney({ j, text: "Stop" }).state, "CUSTOMER_STOP_REQUESTED");
  assert.equal(decideJourney({ j: { state: "ORDER_BOUND", order_id: "RF480-20261018-abcdef" }, text: "Bitte stornieren Sie den Auftrag." }).state, "CANCELLATION_REVIEW_REQUIRED");
  assert.equal(decideJourney({ j: { state: "ORDER_BOUND" }, text: "Ja, ich bestätige den Auftrag." }).result, "confirmation_duplicate");
  assert.equal(journeyWorkflow({ state: "ORDER_BOUND", order_id: "x" }, { payment_gate_met: true, access_status: "ACCESS_RECEIVED", order_state: "ACCESS_CHECK" }), "ACCESS_RECEIVED");
  assert.equal(journeyWorkflow({ state: "ORDER_BOUND", order_id: "x" }, { payment_gate_met: true, access_status: "ACCESS_RECEIVED", order_state: "REPAIRING" }), "REPAIR_RUNNING");
  // im Fluss: Stopp → keine weitere Mail, kein Auftrag
  const W = world();
  W.g.notify("a1b2c3d4e5f60007");
  await W.mailTick();
  W.say("Bitte ändert zusätzlich meine Telefonnummer.");
  await W.tick();
  assert.equal(W.g.sends().length, 1, "keine geratene Antwort");
  assert.ok(W.notes.some((n) => /nicht eindeutig/.test(n.reason)));
  W.say("Stop");
  await W.tick();
  W.say("Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  assert.equal(W.item().journey.state, "CUSTOMER_STOP_REQUESTED");
  assert.equal(W.orders().length, 0);
  assert.equal(W.g.sends().length, 1);
  assert.equal(W.item().journey.workflow, "CANCELLED");
});

test("TF-079 §25 Auftragsbitte fail closed: fremde Kundenadresse für offenen Auftrag derselben Domain → Prüfung, kein zweiter Auftrag", async () => {
  const W = world();
  createConfirmedRepairOrder(W.store, { domain: DOMAIN, website: SITE, delivery_email: "jemand-anderes@muster-garage.ch", now: T0 });
  W.g.notify("a1b2c3d4e5f60008");
  await W.mailTick();
  W.say("Ja, ich bestätige den Auftrag.");
  await W.tick(2);
  assert.equal(W.orders().length, 1);
  assert.equal(W.item().journey.state, "MANUAL_REVIEW_REQUIRED");
  assert.ok(W.notes.some((n) => /DUPLICATE_OPEN_ORDER/.test(n.reason)));
  assert.equal(W.accessMails().length, 0);
});

test("cleanup", () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
