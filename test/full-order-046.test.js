// FIRST CUSTOMER PRODUCTION READINESS & FULL ORDER DRY-RUN (TF-046) – hermetischer Teil (ohne Docker/Netz): kompletter CHF-480-Auftrag
// über den produktiven Einstiegspunkt runRepairOrders (Anfrage → bestätigter Auftrag → CHF 239/240 → genau eine Zugangs-Anfrage →
// sicherer One-Time-Link über die echte Intake-API → Tresor → Freigabe → Profil/Zugang → Backup → Audit → Plan → Fix → Validierung →
// HTTP-Retest → Browser-Gate → Bericht → CUSTOMER_ORDER_FULFILLMENT → COMPLETED → Credential Cleanup) mit Worker-Neustart nach jeder
// Phase, Lieferungs-Idempotenz, Void/Cancel/Payment-Reversal, CHF-150-Vollauftrag und Readiness-Kommando. Nur Attrappen: Fake-Gmail,
// Test-Ledger, In-Memory-Intake, Attrappen-Website/-Browser. Der echte Lauf gegen Docker + Chromium liegt in
// test/integration/full-order-046/ (npm run test:full-order-integration, Teil von npm run test:release-046).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { OFFERS, voidSale, collectDomainOrders, computeMetrics, loadPipeline } from "../sales.js";
import { recordPayment, refundPayment, paymentsForOrder } from "../payments.js";
import { REPAIR_ORDERS_FILE, FULFILLMENT_CLASS, DELIVERY_STATUSES, PUBLIC_REPAIR_FIELDS, createConfirmedRepairOrder, createRepairEngine, runRepairOrders,
  cancelRepairOrder, completeOrder, publicRepairOrders, buildCustomerReport, buildRepairDeliveryMail, reportUnsafe, repairSaleVoided } from "../repair-workflow.js";
import { CHECK150_ORDERS_FILE, createCheck150Order, runCheck150Orders } from "../check-150-workflow.js";
import { recordDirectSale } from "../sales.js";
import { createAccessIntakeHandler, memoryIntakeStore, consentText } from "../access-intake-api.js";
import { intakeClient, sealEnvelope, ACCESS_VAULT_DIR } from "../access-intake.js";
import { gateDecision } from "../repair-browser-validator.js";
import { cleanRepair } from "../server-control.js";
import { readinessReport, formatReport, diskCheck, MIN_FREE_DISK_GB } from "../production-readiness.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-13T08:00:00Z");
const DOMAIN = "muster-kunde.test";
const SITE = `https://${DOMAIN}/`;
const EMAIL = "auftrag@muster-kunde.test";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fo46-"));
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const TEST_SECRET = "Fo46-Test-Secret-9f3c1e";

// ---------- Attrappen ----------
function fakeGmail() {
  const calls = [];
  let failNext = null;
  return { calls, failNextSend: (msg) => { failNext = msg; },
    createDraft: async (x) => { calls.push({ op: "create", to: x.to, subject: x.subject, body: x.body, messageClass: x.messageClass, attachments: x.attachments || [] }); return { draftId: "dr" + calls.length }; },
    sendDraft: async (id) => { if (failNext) { const m = failNext; failNext = null; throw new Error(m); } calls.push({ op: "SEND", id }); return { messageId: "m-" + id }; },
    sent: (cls) => calls.filter((c) => c.op === "SEND").map((s) => calls.find((c) => c.op === "create" && "dr" + (calls.indexOf(c) + 1) === s.id)).filter((c) => !cls || c?.messageClass === cls) };
}
const WT = "w".repeat(43);
function cloud() {
  const blobs = memoryIntakeStore();
  const ops = [];
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined), now: () => new Date() });
  const fetchFn = async (url, init) => { ops.push(JSON.parse(init.body).op); return handler(new Request(url, init)); };
  return { blobs, ops, handler, client: intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn }) };
}
// Attrappen-Website + -Browser (gleiche Entscheidungslogik wie TF-045, gateDecision echt).
function vp({ fixed = false, px = 0, pageErrors = 0 } = {}) {
  return { load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390 + px, viewport_width: 390, doc_height: 1000, text_length: 400 },
    overflow: { horizontal: px > 2, px, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
    critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
    nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 3, targets_ok: 3, targets_failed: 0 },
    images: { visible: 3, broken: 0, broken_paths: [] }, console: { page_errors: pageErrors, page_error_kinds: pageErrors ? ["TypeError"] : [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 },
    network: { failed_same_site: 0, failed_cross_site: 0, entries: [] }, fingerprints: { header: "a", nav: "b", main: "c", footer: "d" },
    findings: [{ type: "broken_link", ok: fixed, present: !fixed, code: fixed ? null : "finding_unresolved" }] };
}
function world({ regress = false, rollbackOk = true, includeProtected = true } = {}) {
  const st = { fixed: false, regressed: false, writes: 0, rollbacks: 0, connects: 0, backups: 0, browser: [], preflights: [] };
  const BROKEN = { type: "broken_link", url: `${SITE}team-alt`, page: SITE, label: "Unser Team", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true };
  const PROTECTED = { type: "broken_link", url: `${SITE}agb-alt`, page: `${SITE}impressum`, label: "AGB", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true };
  const adapter = {
    direct_live: true,
    checkAccess: async (_o, ctx) => { st.connects++; const c = ctx?.credential?.(); return c?.secret === TEST_SECRET ? { ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] } : { ok: false, reason: "kein Zugang" }; },
    backup: async () => { st.backups++; return { production_ref: "p1", backup_ref: "local:object-backup", rollback_point: "per-object-original" }; },
    locate: async (i) => ({ target: "index.html", cause: `Link auf ${new URL(i.url).pathname} (404)`, planned_change: "href ersetzen", risk: "niedrig", before_hash: "h0", fix: { replacement: "/team.html" } }),
    applyFix: async () => { st.writes++; st.fixed = true; if (regress) st.regressed = true; return { ok: true, change_ref: "lab:1", before_hash: "h0", after_hash: "h1" }; },
    validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }),
    rollback: async () => { st.rollbacks++; if (!rollbackOk) return { ok: false }; st.fixed = false; st.regressed = false; return { ok: true }; },
  };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Muster Kunde AG", requests: 3, pages: { home: "<html><body>Muster</body></html>" },
    issues: [...(st.fixed ? [] : [BROKEN]), ...(includeProtected ? [PROTECTED] : [])] }) };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    st.browser.push(phase);
    const v = () => vp({ fixed: phase !== "baseline" && st.fixed, ...(st.regressed ? { px: 510 } : {}) });
    const out = { url, phase, desktop: v(), mobile: v() };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  // Wie im Produktivbetrieb (loadDefaultRepairDeps): Router + Profil-Preflight. Preflight nur lesend – öffnet den Zugang zur
  // Laufzeit, schreibt nie, Ergebnis PROFILE_READY nur mit gültigem Test-Zugang.
  const router = { route: async () => ({ adapter: "static", label: "Lab" }) };
  const preflight = { run: async (o, { adapter, accessCtx }) => {
    st.preflights.push({ adapter, writes_before: st.writes, backups_before: st.backups });
    return accessCtx?.credential?.()?.secret === TEST_SECRET
      ? { profile_status: "PROFILE_READY", reason: "lab_verified", profile: { interface: "lab", capabilities: ["READ_FILES", "WRITE_FILES"] } }
      : { profile_status: "MANUAL_REVIEW_REQUIRED", reason: "credential_invalid" };
  } };
  return { st, adapter, auditor, browserValidator, router, preflight };
}
// Produktiver Einstiegspunkt je «Worker-Lauf» – jeder Aufruf ist ein frischer Prozesszustand (Neustart).
const run = (dir, w, gmail, intake, extra = {}) => runRepairOrders({ dir, adapters: { static: w.adapter }, router: w.router, preflight: w.preflight, browserValidator: w.browserValidator, auditor: w.auditor,
  gmail, intake, log: () => {}, ...extra });
// Kunde öffnet den Link: info → Verschlüsselung (gleiches Verfahren wie public/access-crypto.js) → submit.
async function customerSubmits(c, link, { consent = true, domain = DOMAIN, secret = TEST_SECRET } = {}) {
  const token = decodeURIComponent(link.split("#t=")[1]);
  const call = async (body) => { const r = await c.handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  const info = await call({ op: "info", token });
  assert.equal(info.status, 200, `info: ${JSON.stringify(info.body)}`);
  const envelope = sealEnvelope({ access_type: "other", host: SITE, username: "jarvis-temp", secret }, info.body.public_key);
  return call({ op: "submit", token, access_type: "other", access_domain: domain, consent, envelope });
}
const linkInfo = async (c, link) => (await c.handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ op: "info", token: decodeURIComponent(link.split("#t=")[1]) }) }))).status;
const linkOf = (mail) => mail.body.match(/https:\/\/jarvis\.test\/access\.html#t=[A-Za-z0-9_%-]+/)?.[0];
const phaseOf = (dir, id) => publicRepairOrders(dir).orders.find((o) => o.order_id === id);

// =====================================================================================================================
// FULL CHF 480 DRY RUN (Produktionsweg runRepairOrders, Neustart nach jeder Phase)
// =====================================================================================================================
test("FULL CHF480 DRY RUN: Anfrage → ORDER_CONFIRMED → 239 blockiert → 240 → genau 1 Access-Mail → sicherer Link → Tresor → … → genau 1 Lieferung → COMPLETED → Credentials zerstört", async () => {
  const dir = tmp(), store = createStore(dir), gmail = fakeGmail(), c = cloud(), w = world();
  const phases = [];
  const snap = (id) => { const p = phaseOf(dir, id); phases.push(p.phase); const cloudView = cleanRepair(publicRepairOrders(dir)); assert.ok(!JSON.stringify(cloudView).includes(TEST_SECRET) && !JSON.stringify(cloudView).includes(EMAIL)); return p; };

  // 1) Anfrage allein: kein Verkauf, kein Auftrag, keine Mail, keine Verbindung.
  assert.deepEqual(await run(dir, w, gmail, c.client), { busy: false, processed: 0, advanced: 0, states: {} });
  assert.deepEqual([Object.keys(store.read("sales.json", { records: {} }).records).length, gmail.calls.length, w.st.connects], [0, 0, 0]);

  // 2) Bestätigter Auftrag, 0 CHF → WAITING_FOR_DEPOSIT, nur passiver Vorab-Check, 0 Zugangs-Anfrage, 0 Adapter, 0 Write.
  const o0 = createConfirmedRepairOrder(store, { domain: DOMAIN, website: SITE, company: "Muster Kunde AG", delivery_email: EMAIL, contact_name: "Frau Muster", now: T0 });
  const id = o0.order_id;
  assert.ok(o0.confirmed && o0.state_history.some((h) => /ORDER_CONFIRMED/.test(h.reason)));
  assert.equal(store.read("sales.json", { records: {} }).records[DOMAIN].sale.selected_offer, "REPAIR_FIX_500");
  await run(dir, w, gmail, c.client);
  let p = snap(id);
  assert.deepEqual([readOrder(store, id).state, p.phase, p.paid_chf, gmail.calls.length, w.st.connects, w.st.writes], ["AUTHORIZATION_REQUIRED", "WAITING_FOR_DEPOSIT", 0, 0, 0, 0]);

  // 3) CHF 239 → blockiert. Dann kumulativ CHF 240 (echter Ledger) → genau EINE Zugangs-Anfrage.
  recordPayment(store, { order_id: id, amount_chf: 239, reference: "FO46-BANK-1", now: T0 });
  await run(dir, w, gmail, c.client);
  p = snap(id);
  assert.deepEqual([p.phase, p.paid_chf, p.payment_ok, gmail.calls.length, c.ops.length], ["WAITING_FOR_DEPOSIT", 239, false, 0, 0]);
  assert.throws(() => recordPayment(store, { order_id: id, amount_chf: 239, reference: "fo46-bank-1", now: T0 }), /Doppelte Zahlungsreferenz/, "kein zweites Payment");
  recordPayment(store, { order_id: id, amount_chf: 1, reference: "FO46-BANK-2", now: T0 });
  await run(dir, w, gmail, c.client);
  p = snap(id);
  const access = gmail.calls.filter((x) => x.op === "create");
  assert.equal(access.length, 1);
  assert.deepEqual([access[0].messageClass, access[0].to, gmail.calls.filter((x) => x.op === "SEND").length, p.phase, p.paid_chf], ["CUSTOMER_ACCESS_REQUEST", EMAIL, 1, "ACCESS_REQUEST_SENT", 240]);
  const link = linkOf(access[0]);
  assert.ok(link, "sicherer HTTPS-Link mit Token im Fragment");
  assert.ok(!link.includes(id) && !access[0].body.includes(id), "keine Auftrags-ID im Link/Text");
  assert.match(access[0].body, /KEINE Passwörter per E-Mail/);
  assert.ok(access[0].body.includes(DOMAIN) && access[0].subject.includes(DOMAIN), "domaingebunden");
  for (const bad of [/rabatt|angebot|newsletter|abmelden|jetzt buchen|aktion/i, /passwort\s*:/i]) assert.ok(!bad.test(access[0].body), `Access-Mail: ${bad}`);
  const reg = JSON.parse(c.blobs.dump());
  assert.deepEqual([reg.length, reg[0].order_id, reg[0].domain], [1, id, DOMAIN], "Link an Auftrag + Domain gebunden");

  // Neustart nach der Zugangs-Anfrage: keine zweite Mail, kein zweiter Token.
  await run(dir, w, gmail, c.client);
  assert.deepEqual([gmail.calls.length, c.ops.filter((x) => x === "register").length], [2, 1]);

  // 4) Kunde ohne Freigabe / falsche Domain → abgelehnt, 0 Writes. Dann echter Flow mit Freigabe.
  assert.equal((await customerSubmits(c, link, { consent: false })).status, 400);
  assert.equal((await customerSubmits(c, link, { domain: "fremd.test" })).status, 400);
  await run(dir, w, gmail, c.client);
  assert.deepEqual([readOrder(store, id).state, readOrder(store, id).customer_authorized_repair, w.st.connects, w.st.writes], ["ACCESS_REQUESTED", false, 0, 0]);
  assert.equal((await customerSubmits(c, link)).status, 200);
  assert.ok(!c.blobs.dump().includes(TEST_SECRET), "Cloud sieht nur Chiffrat");
  assert.equal(await linkInfo(c, link), 404, "One-Time-Link nach Einreichung tot");

  // 5) Worker holt ab → Tresor → Freigabe → Zugang → Backup → Audit → Plan → Fix → Validierung → Retest → Bericht → Lieferung → COMPLETED.
  const r = await run(dir, w, gmail, c.client);
  assert.deepEqual(r.access_intake, { accepted: 1, rejected: 0 });
  assert.equal(c.blobs.dump(), "[]", "Einreichung quittiert – Cloud leer");
  const o = readOrder(store, id);
  // TF-028/055: ein geschützter Restpunkt darf keine neue Abschlussmail als vollständig repariert ausgeben.
  assert.equal(o.state, "READY_FOR_DELIVERY", `${o.blocked_reason} ${JSON.stringify(o.delivery)}`);
  const pathOf = o.state_history.map((h) => h.to);
  for (const s of ["ACCESS_PROFILE_PREFLIGHT", "ACCESS_CHECK", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY"]) assert.ok(pathOf.includes(s), s);
  assert.deepEqual([o.authorization.source, o.authorization.authorized_domain, o.customer_authorized_repair], ["secure_order_access_form", DOMAIN, true]);
  assert.equal(o.access_profile?.profile_status, "PROFILE_READY", `Profil: ${JSON.stringify(o.access_profile)}`);
  assert.ok(pathOf.indexOf("ACCESS_PROFILE_PREFLIGHT") < pathOf.indexOf("BACKUP"), "Profil vor Backup");
  assert.deepEqual(w.st.preflights, [{ adapter: "static", writes_before: 0, backups_before: 0 }], "genau 1 Preflight, nur lesend, vor Backup/Write");
  assert.ok(Date.parse(o.backup.created_at) <= Date.parse(o.state_history.find((h) => h.to === "REPAIRING").at) && o.backup.rollback_point, "Backup vor der ersten Änderung");
  assert.deepEqual([w.st.backups, w.st.writes, w.st.rollbacks], [1, 1, 0], "1 Backup, 1 Write, kein Rollback");
  assert.equal(o.plan.length, 1, "nur der sichere Befund geplant");
  for (const k of ["issue", "adapter", "target", "before_hash", "planned_change", "validation", "rollback"]) assert.ok(o.plan[0][k], `Plan.${k}`);
  assert.ok(o.manual_review.some((m) => /geschützten Seite/.test(m.reason)), "Impressum (geschützt) ausgeschlossen");
  assert.deepEqual([o.validation.build_ok, o.retest.http_ok, o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.regression], [true, true, "JA", "JA", "KEINE"]);
  assert.deepEqual(w.st.browser, ["baseline", "after"]);

  // Bericht vorhanden, aber die neue Abschlussmail bleibt wegen des geschützten Restpunkts gesperrt.
  const deliveries = gmail.calls.filter((x) => x.op === "create" && x.messageClass === FULFILLMENT_CLASS);
  assert.equal(deliveries.length, 0);
  assert.equal(o.delivery.status, "failed");
  assert.match(o.delivery.handover_reason, /Abschlussmail nicht freigegeben/);

  // Der Tresor bleibt bis zur expliziten manuellen Abschlussentscheidung erhalten.
  assert.equal(fs.existsSync(path.join(dir, ACCESS_VAULT_DIR, `${id}.json`)), true);
  assert.equal(o.access_intake.status, "RECEIVED");
  assert.ok(!JSON.stringify(o).includes(TEST_SECRET));

  // Neustart nach der Lieferung: nichts passiert mehr (kein Doppelversand, kein Write).
  await run(dir, w, gmail, c.client);
  assert.deepEqual([gmail.calls.filter((x) => x.op === "SEND").length, w.st.writes, paymentsForOrder(store, id).length], [1, 1, 2]);

  // Dashboard: alle Phasen in fester Wortform, keine Secrets.
  p = snap(id);
  assert.deepEqual([p.phase, p.payment_ok, p.access_received, p.authorized, p.backup_ok, p.repaired, p.browser_desktop, p.browser_mobile, p.browser_regression, p.delivery_status],
    ["READY_FOR_DELIVERY", true, true, true, true, 1, "JA", "JA", "KEINE", "failed"]);
  assert.ok(["WAITING_FOR_DEPOSIT", "ACCESS_REQUEST_SENT", "READY_FOR_DELIVERY"].every((x) => phases.includes(x)), phases.join());
  assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_REPAIR_FIELDS].sort());
  const cl = cleanRepair(publicRepairOrders(dir)).orders[0];
  assert.deepEqual([cl.authorized, cl.delivery_status], [true, "failed"]);
  for (const f of fs.readdirSync(dir, { recursive: true }).map(String)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isFile() && !f.endsWith(".pem")) assert.ok(!fs.readFileSync(full, "utf8").includes(TEST_SECRET), `${f} enthält Test-Zugangsdaten`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// =====================================================================================================================
// Lieferung: genau einmal, restart-safe, fail safe
// =====================================================================================================================
// untilReady: nach dem Zugang einmal ohne Lieferung laufen lassen → READY_FOR_DELIVERY (für gezielte Liefer-Szenarien).
async function readyOrder({ w = world({ includeProtected: false }), gmail = fakeGmail(), extra = {}, untilReady = false, fullPayment = true } = {}) {
  const dir = tmp(), store = createStore(dir), c = cloud();
  store.write("config.json", { business_profile: { address: { street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH" } } });
  const o = createConfirmedRepairOrder(store, { domain: DOMAIN, website: SITE, company: "Muster Kunde AG", delivery_email: EMAIL, now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: "R-" + o.order_id, now: T0 });
  if (fullPayment) recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: "R2-" + o.order_id, now: T0 });
  await run(dir, w, gmail, c.client, extra);
  const link = linkOf(gmail.calls.find((x) => x.messageClass === "CUSTOMER_ACCESS_REQUEST"));
  const sub = await customerSubmits(c, link);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  if (untilReady) {
    await run(dir, w, gmail, c.client, { autoDeliver: false });
    assert.equal(readOrder(store, o.order_id).state, "READY_FOR_DELIVERY");
  }
  return { dir, store, id: o.order_id, c, w, gmail };
}

test("LIEFERUNG vor Delivery unterbrochen (Gmail 503) → kein Versand, Neustart → genau 1 Versand → COMPLETED; Absturz nach Sendeversuch → nie erneut (UNKLAR, Chris)", async () => {
  const gmail = fakeGmail();
  const x = await readyOrder({ gmail, untilReady: true });
  gmail.failNextSend("Gmail HTTP 503");
  await run(x.dir, x.w, gmail, x.c.client);
  let o = readOrder(x.store, x.id);
  assert.deepEqual([o.state, o.delivery.status, o.delivery.send_attempted_at], ["READY_FOR_DELIVERY", "draft_ready", null], "vorübergehend → nächster Lauf");
  await run(x.dir, x.w, gmail, x.c.client);
  await run(x.dir, x.w, gmail, x.c.client);
  o = readOrder(x.store, x.id);
  assert.equal(o.state, "COMPLETED");
  assert.equal(gmail.calls.filter((c) => c.op === "create" && c.messageClass === FULFILLMENT_CLASS).length, 1, "ein Entwurf (Draft-ID persistiert)");
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 2, "1 Access-Mail + 1 Lieferung");

  // Absturz zwischen Sendeversuch und Bestätigung (persistiert ist nur send_attempted_at) → nie blind wiederholen.
  const gmail2 = fakeGmail();
  const y = await readyOrder({ gmail: gmail2, untilReady: true });
  const data = y.store.read(REPAIR_ORDERS_FILE, { orders: {} });
  data.orders[y.id].delivery = { status: "draft_ready", draft_id: "dr-crash", send_attempted_at: T0.toISOString() };
  y.store.write(REPAIR_ORDERS_FILE, data);
  const alerts = [];
  await run(y.dir, y.w, gmail2, y.c.client, { alert: async (a) => alerts.push(a.kind) });
  await run(y.dir, y.w, gmail2, y.c.client);
  o = readOrder(y.store, y.id);
  assert.deepEqual([o.state, o.delivery.status], ["READY_FOR_DELIVERY", "unclear"]);
  assert.equal(gmail2.calls.filter((c) => c.op === "SEND").length, 1, "nur die Access-Mail – keine Lieferung");
  assert.ok(alerts.includes("delivery_unclear"));
  assert.equal(phaseOf(y.dir, y.id).delivery_status, "unclear");
  completeOrder(y.store, y.id); // Chris hat im Gesendet-Ordner geprüft und schliesst ab
  assert.deepEqual([readOrder(y.store, y.id).state, fs.existsSync(path.join(y.dir, ACCESS_VAULT_DIR, `${y.id}.json`))], ["COMPLETED", false]);
});

test("LIEFERUNG fail safe: gesperrte Abschlussmail oder Interna → kein Versand; langer freigegebener Bericht → ATTACHMENT_REQUIRED", async () => {
  const mk = () => ({ order_id: "RF480-20261013-abcdef", domain: DOMAIN, contact_name: "Frau Muster", report: { subject: "S", body: "x".repeat(6000) } });
  assert.equal((await buildRepairDeliveryMail(mk())).status, "MANUAL_REVIEW_REQUIRED");
  assert.equal((await buildRepairDeliveryMail(mk())).inline, false);
  const readyMail = await buildRepairDeliveryMail({ ...mk(), website: SITE, issues: { one: { customer_text: "Kontaktlink war nicht erreichbar.", repair_status: "repaired", solution_summary: "Kontaktlink korrigiert." } }, completion: { kind: "FULL" }, validation: { build_ok: true }, retest: { http_ok: true }, browser_gate: { required: false } });
  assert.equal(readyMail.status, "MANUAL_REVIEW_REQUIRED");
  assert.equal(readyMail.inline, false);
  for (const [bad, why] of [["Server 10.0.0.12", "ip"], ["Datei /home/kunde/public_html/index.html", "pfad"], ["https://muster-kunde.test/team", "url"], ["Sicherung B0123456789ab", "backup_id"],
    ["Commit 0123456789abcdef0123456789abcdef01234567", "git"], ["Auftrag RF480-20261013-abcdef", "auftrags_id"], ["passwort: geheim", "secret"], ["TypeError stack trace", "debug"]])
    assert.equal(reportUnsafe(bad), why, bad);

  // Langer Bericht im Ablauf: kein Versand, Chris hängt an.
  const gmail = fakeGmail();
  const x = await readyOrder({ gmail, untilReady: true });
  const data = x.store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const repaired = Object.values(data.orders[x.id].issues)[0];
  data.orders[x.id].issues = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`I${i + 1}`, { ...repaired, finding_id: `I${i + 1}`, customer_text: `Problem ${i + 1} ist dokumentiert.`, solution_summary: `Problem ${i + 1} wurde mit der dokumentierten Änderung behoben.` }]));
  const plan = data.orders[x.id].plan[0];
  data.orders[x.id].plan = Array.from({ length: 80 }, (_, i) => ({ ...plan, issue_id: `I${i + 1}` }));
  x.store.write(REPAIR_ORDERS_FILE, data);
  await run(x.dir, x.w, gmail, x.c.client);
  let o = readOrder(x.store, x.id);
  assert.deepEqual([o.state, o.delivery.status, o.delivery_attachment_required], ["READY_FOR_DELIVERY", "attachment_required", true], o.delivery.handover_reason);
  assert.equal(gmail.calls.filter((c) => c.messageClass === FULFILLMENT_CLASS).length, 0);

  // Bericht mit internem Pfad → nie versenden.
  const gmail2 = fakeGmail();
  const y = await readyOrder({ gmail: gmail2, untilReady: true });
  const d2 = y.store.read(REPAIR_ORDERS_FILE, { orders: {} });
  d2.orders[y.id].report.body += "\nGeändert: /home/labuser/public_html/index.html";
  y.store.write(REPAIR_ORDERS_FILE, d2);
  await run(y.dir, y.w, gmail2, y.c.client);
  o = readOrder(y.store, y.id);
  assert.deepEqual([o.state, o.delivery.status], ["READY_FOR_DELIVERY", "report_unsafe"]);
  assert.equal(gmail2.calls.filter((c) => c.messageClass === FULFILLMENT_CLASS).length, 0);

  // Engine ohne autoDeliver (Werkzeug/Tests) bleibt beim bisherigen Verhalten: READY_FOR_DELIVERY, Chris schliesst ab.
  assert.match(read("repair-workflow.js"), /autoDeliver = true, auditor = null, alert = null/);
  assert.ok(DELIVERY_STATUSES.includes("attachment_required") && DELIVERY_STATUSES.includes("unclear"));
});

// =====================================================================================================================
// Fehlerpfade: Browser-Regression, Rollback scheitert, Payment-Reversal, Cancel, Void
// =====================================================================================================================
test("FAILURE FLOW: Browser-Regression → Rollback → Browser-Retest → REPAIR_FAILED, keine Erfolgsmail, Bericht behauptet nichts", async () => {
  const gmail = fakeGmail(), w = world({ regress: true });
  const x = await readyOrder({ gmail, w });
  await run(x.dir, w, gmail, x.c.client);
  const o = readOrder(x.store, x.id);
  assert.equal(o.state, "REPAIR_FAILED", o.blocked_reason);
  assert.deepEqual(w.st.browser, ["baseline", "after", "rollback"]);
  assert.deepEqual([w.st.rollbacks, o.regression.rolled_back, o.regression.browser_rollback_verified, o.browser_gate.regression], [1, true, true, "ROLLBACK"]);
  assert.equal(gmail.calls.filter((c) => c.messageClass === FULFILLMENT_CLASS).length, 0, "keine Customer-Success-Mail");
  assert.equal(o.report, null);
  assert.ok(!/Behoben wurden:/.test(buildCustomerReport(o).body), "zurückgerollte Fixes gelten nie als behoben");
  assert.equal(phaseOf(x.dir, x.id).repaired, 0);
  assert.equal(fs.existsSync(path.join(x.dir, ACCESS_VAULT_DIR, `${x.id}.json`)), false, "Credentials nach REPAIR_FAILED zerstört");
});

test("ROLLBACK FAILURE: Regression + Rollback scheitert → MANUAL_REVIEW_REQUIRED + Chris-Alert, kein COMPLETED, keine Lieferung", async () => {
  const gmail = fakeGmail(), w = world({ regress: true, rollbackOk: false }), alerts = [];
  const x = await readyOrder({ gmail, w });
  await run(x.dir, w, gmail, x.c.client, { alert: async (a) => alerts.push(a.kind) });
  const o = readOrder(x.store, x.id);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.ok(alerts.includes("rollback_failed"), alerts.join());
  assert.equal(gmail.calls.filter((c) => c.messageClass === FULFILLMENT_CLASS).length, 0);
  assert.throws(() => completeOrder(x.store, x.id), /READY_FOR_DELIVERY/);
});

test("PAYMENT REVERSAL: vor dem Write Refund unter 240 → PAYMENT_REQUIRED, 0 Writes; nach dem Write → PAYMENT_REVIEW_REQUIRED, kein automatischer Rollback, keine Lieferung", async () => {
  // Vor dem Write: Zugang erhalten, dann Rückerstattung → nichts wird verändert.
  const gmail = fakeGmail(), w = world();
  const x = await readyOrder({ gmail, w, fullPayment: false });
  const pay = paymentsForOrder(x.store, x.id)[0];
  refundPayment(x.store, pay.payment_id, { reason: "Test-Rückerstattung" });
  await run(x.dir, w, gmail, x.c.client);
  let o = readOrder(x.store, x.id);
  assert.deepEqual([o.state, w.st.writes, w.st.backups], ["PAYMENT_REQUIRED", 0, 0]);
  assert.equal(phaseOf(x.dir, x.id).phase, "WAITING_FOR_DEPOSIT");

  // Nach dem Write: Zahlung fällt nach REPAIRING unter die Schwelle.
  const gmail2 = fakeGmail(), w2 = world();
  const y = await readyOrder({ gmail: gmail2, w: w2, fullPayment: false });
  const engine = createRepairEngine({ store: y.store, adapters: { static: w2.adapter }, auditor: w2.auditor, browserValidator: w2.browserValidator, requireBrowser: true, autoDeliver: true, gmail: gmail2 });
  const { syncAccessIntake } = await import("../access-intake.js");
  await syncAccessIntake({ store: y.store, intake: y.c.client });
  for (let i = 0; i < 20; i++) { const cur = readOrder(y.store, y.id); if (cur.state === "VALIDATION") break; await engine.step(structuredClone(cur)); }
  assert.equal(readOrder(y.store, y.id).state, "VALIDATION");
  assert.equal(w2.st.writes, 1);
  refundPayment(y.store, paymentsForOrder(y.store, y.id)[0].payment_id, { reason: "Test-Rückerstattung nach Write" });
  await run(y.dir, w2, gmail2, y.c.client);
  o = readOrder(y.store, y.id);
  assert.deepEqual([o.state, w2.st.rollbacks, w2.st.fixed], ["PAYMENT_REVIEW_REQUIRED", 0, true], "kein automatischer Rollback nur wegen Zahlung");
  assert.equal(gmail2.calls.filter((c) => c.messageClass === FULFILLMENT_CLASS).length, 0);
  assert.equal(phaseOf(y.dir, y.id).phase, "PAYMENT_REVIEW_REQUIRED");
});

test("CANCEL vor der Reparatur → CANCELLED, keine Adapter-Aufrufe, keine Mail, Credentials bereinigt", async () => {
  const gmail = fakeGmail(), w = world();
  const x = await readyOrder({ gmail, w });
  const { syncAccessIntake } = await import("../access-intake.js");
  await syncAccessIntake({ store: x.store, intake: x.c.client });
  assert.equal(fs.existsSync(path.join(x.dir, ACCESS_VAULT_DIR, `${x.id}.json`)), true);
  const mails = gmail.calls.length;
  cancelRepairOrder(x.store, x.id, { reason: "Kunde storniert (Test)" });
  await run(x.dir, w, gmail, x.c.client);
  const o = readOrder(x.store, x.id);
  assert.deepEqual([o.state, w.st.connects, w.st.writes, gmail.calls.length], ["CANCELLED", 0, 0, mails]);
  assert.equal(fs.existsSync(path.join(x.dir, ACCESS_VAULT_DIR, `${x.id}.json`)), false);
  assert.equal(o.access_intake.status, "DESTROYED");
});

test("VOID SALE: offene Aufträge blockieren das Void (TF-040); nach Storno → voided, kein Umsatz, keine Reparatur/Lieferung; voided Verkauf stoppt jeden offenen Auftrag", async () => {
  const dir = tmp(), store = createStore(dir), gmail = fakeGmail(), w = world(), c = cloud();
  const o = createConfirmedRepairOrder(store, { domain: DOMAIN, website: SITE, company: "Muster Kunde AG", delivery_email: EMAIL, now: T0 });
  const sales = () => store.read("sales.json", { records: {} }).records;
  assert.throws(() => voidSale(sales(), DOMAIN, { reason: "Test", relatedOrders: collectDomainOrders(store, DOMAIN) }), /zuerst Auftrag stornieren/);
  cancelRepairOrder(store, o.order_id, { reason: "versehentlich erfasst" });
  store.write("sales.json", { records: voidSale(sales(), DOMAIN, { reason: "Testauftrag", relatedOrders: collectDomainOrders(store, DOMAIN) }) });
  const m = computeMetrics(loadPipeline({ dir }).leads);
  assert.deepEqual([m.sales_500, m.revenue_500, m.total_revenue], [0, 0, 0], "voided zählt nie als Umsatz");
  await run(dir, w, gmail, c.client);
  assert.deepEqual([gmail.calls.length, w.st.connects, w.st.writes], [0, 0, 0]);

  // Verteidigung in der Tiefe: voided Verkauf + offener Auftrag (z. B. manuell manipuliert) + CHF 240 → nichts passiert.
  const dir2 = tmp(), store2 = createStore(dir2);
  const o2 = createConfirmedRepairOrder(store2, { domain: DOMAIN, website: SITE, company: "Muster Kunde AG", delivery_email: EMAIL, now: T0 });
  recordPayment(store2, { order_id: o2.order_id, amount_chf: 240, reference: "VOID-240", now: T0 });
  const rec = store2.read("sales.json", { records: {} });
  rec.records[DOMAIN].sale = { ...rec.records[DOMAIN].sale, sale_status: "voided", voided: true, voided_at: T0.toISOString(), void_reason: "Test" };
  store2.write("sales.json", rec);
  assert.equal(repairSaleVoided(store2, o2), true);
  await run(dir2, w, gmail, c.client);
  const s = readOrder(store2, o2.order_id);
  assert.equal(s.state, "BLOCKED_NO_AUTHORIZATION");
  assert.match(s.blocked_reason, /voided/);
  assert.deepEqual([gmail.calls.length, w.st.connects], [0, 0], "keine Zugangs-Anfrage, keine Verbindung");
});

// =====================================================================================================================
// CHF 150 FULL FLOW
// =====================================================================================================================
test("CHF150 FULL FLOW: bestätigt → CHF 74 nichts → CHF 75 Audit → Bericht; fehlende TF-028-Versandvoraussetzungen blockieren die Abschlussmail", async () => {
  const dir = tmp(), store = createStore(dir), gmail = fakeGmail();
  let audits = 0;
  const auditor = (issues) => ({ audit: async (u) => { audits++; return { website: u, reachable: true, finalUrl: u, title: "Muster", requests: 2, pages: { home: "<html><head><meta name=viewport content=x></head><body>x</body></html>" }, issues }; } });
  const issue = (n) => ({ type: "broken_link", url: `${SITE}seite-${n}`, page: SITE, label: `Seite ${n}`, evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true });
  store.write("sales.json", { records: recordDirectSale({}, { domain: DOMAIN, offer: "REPAIR_CHECK_150", delivery_email: EMAIL, company: "Muster Kunde AG", now: T0 }) });
  const o = createCheck150Order(store, { domain: DOMAIN, website: SITE, company: "Muster Kunde AG", delivery_email: EMAIL, now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 74, reference: "C150-74", now: T0 });
  await runCheck150Orders({ dir, gmail, auditor: auditor([issue(1), issue(2)]), log: () => {} });
  const r150 = () => store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.deepEqual([r150().state, audits, gmail.calls.length], ["BLOCKED_PAYMENT_NOT_RECEIVED", 0, 0], "CHF 74 → nichts");
  recordPayment(store, { order_id: o.order_id, amount_chf: 1, reference: "C150-75", now: T0 });
  await runCheck150Orders({ dir, gmail, auditor: auditor([issue(1), issue(2)]), log: () => {} });
  assert.equal(r150().state, "MANUAL_REVIEW_REQUIRED");
  assert.deepEqual([audits, r150().report_findings_count, r150().receipt_status], [1, 2, "MANUAL_REVIEW_REQUIRED"]);
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 0);
  assert.equal(gmail.calls.filter((c) => c.op === "create").length, 0);
  await runCheck150Orders({ dir, gmail, auditor: auditor([]), log: () => {} });
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 0, "Neustart: keine Abschlussmail");

  // Langer Bericht (viele echte Befunde): kein falscher Auto-Send.
  const dir2 = tmp(), store2 = createStore(dir2), gmail2 = fakeGmail();
  store2.write("sales.json", { records: recordDirectSale({}, { domain: DOMAIN, offer: "REPAIR_CHECK_150", delivery_email: EMAIL, now: T0 }) });
  const o2 = createCheck150Order(store2, { domain: DOMAIN, website: SITE, delivery_email: EMAIL, now: T0 });
  recordPayment(store2, { order_id: o2.order_id, amount_chf: 75, reference: "C150-LONG", now: T0 });
  await runCheck150Orders({ dir: dir2, gmail: gmail2, auditor: auditor(Array.from({ length: 14 }, (_, i) => issue(i + 1))), log: () => {} });
  const l = store2.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o2.order_id];
  assert.deepEqual([l.state, l.receipt_status, gmail2.calls.filter((c) => c.op === "SEND").length], ["MANUAL_REVIEW_REQUIRED", "MANUAL_REVIEW_REQUIRED", 0]);
  assert.match(l.state_history.at(-1).reason, /Geschäftsadresse/);
  for (const d of [dir, dir2]) fs.rmSync(d, { recursive: true, force: true });
});

// =====================================================================================================================
// READINESS-KOMMANDO (read-only)
// =====================================================================================================================
function readyEnv() {
  const secretsDir = tmp(), workerDir = path.join(secretsDir, "mail_worker");
  fs.mkdirSync(workerDir, { recursive: true });
  fs.writeFileSync(path.join(workerDir, "worker.lock"), JSON.stringify({ pid: 1, beat: Date.now() }));
  fs.writeFileSync(path.join(workerDir, "authority.json"), JSON.stringify({ holder: "vps", self: true }));
  fs.writeFileSync(path.join(workerDir, "backup_status.json"), JSON.stringify({ last_at: new Date(Date.now() - 3600e3).toISOString(), ok: true, generations: 3 }));
  for (const f of ["gmail_credentials.json", "gmail_token.json"]) fs.writeFileSync(path.join(secretsDir, f), JSON.stringify({ secret: "readiness-test-secret-value" }));
  const env = { JARVIS_WORKER_ROLE: "vps", JARVIS_MAIL_WORKER_TOKEN: "rdy-worker-token-0123456789abcdef", ANTHROPIC_API_KEY: "sk-ant-readiness-test" };
  // TF-049: Readiness verlangt aktiven Outbox-Consumer + funktionierendes Gmail OAuth (hier Fake-Check, kein Netz).
  const outboxDir = path.join(secretsDir, "repair_outbox");
  fs.mkdirSync(outboxDir);
  fs.writeFileSync(path.join(outboxDir, "consumer.json"), JSON.stringify({ beat: Date.now(), role: "mail-worker" }));
  return { secretsDir, workerDir, env, outboxDir, gmailCheck: async () => ({ ok: true }) };
}
const snapshotDir = (d) => fs.readdirSync(d, { recursive: true }).map(String).sort().map((f) => { const p = path.join(d, f); return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, "utf8")}` : f; }).join("\n");

test("READINESS: alles vorhanden → READY FOR FIRST CUSTOMER; read-only (Zustand unverändert, kein Schlüssel erzeugt); nur YES/NO, nie Secret-Werte", async () => {
  const e = readyEnv();
  const before = snapshotDir(e.secretsDir);
  const r = await readinessReport({ ...e, statfs: () => ({ bavail: 60 * 1024 ** 3 / 4096, bsize: 4096 }), launchChromium: false });
  const out = formatReport(r);
  assert.equal(snapshotDir(e.secretsDir), before, "kein Schreiben in den Worker-Zustand");
  assert.equal(fs.existsSync(path.join(e.workerDir, "access_intake_private.pem")), false, "kein Schlüssel erzeugt");
  for (const name of ["Core", "Mail", "Payments", "CHF150", "CHF480", "Adapter Registry", "Profile Builder", "Host-Key", "Browser", "Chromium", "Backup", "Authority", "Disk", "Release Gate"])
    assert.ok(r.checks.some((c) => c.name === name), name);
  const failed = r.checks.filter((c) => c.status === "FAIL");
  assert.equal(failed.length, 0, JSON.stringify(failed));
  assert.equal(r.ready, true);
  assert.match(out, /READY FOR FIRST CUSTOMER/);
  assert.ok(r.secrets.every((s) => ["YES", "NO"].includes(s.present)));
  for (const v of Object.values(e.env).filter((x) => x.length > 8)) assert.ok(!out.includes(v) && !JSON.stringify(r).includes(v), "kein Secret-Wert in der Ausgabe");
  assert.ok(!out.includes("readiness-test-secret-value") && !out.includes(e.secretsDir), "keine Inhalte/Pfade");
  const src = read("production-readiness.js");
  assert.ok(!/accessKeys\(|sendDraft|createDraft|recordPayment|globalThis\.fetch\(/.test(src), "keine Aktion im Readiness-Kommando");
  fs.rmSync(e.secretsDir, { recursive: true, force: true });
});

test("READINESS: Disk < 10 GB → NOT READY (keine Löschung); 10–20 GB → WARN; fehlender Worker-Token / kein VPS / kein Backup → NOT READY mit sicheren Gründen", async () => {
  assert.equal(MIN_FREE_DISK_GB, 10);
  assert.equal(diskCheck(8.5).status, "FAIL");
  assert.equal(diskCheck(15).status, "WARN");
  assert.equal(diskCheck(40).status, "OK");
  const e = readyEnv();
  const low = await readinessReport({ ...e, statfs: () => ({ bavail: 8 * 1024 ** 3 / 4096, bsize: 4096 }), launchChromium: false });
  assert.equal(low.ready, false);
  assert.ok(low.reasons.some((x) => /^Disk: .*unter dem Minimum/.test(x)), low.reasons.join());
  fs.rmSync(path.join(e.workerDir, "backup_status.json"));
  const bad = await readinessReport({ ...e, env: { JARVIS_WORKER_ROLE: "local" }, statfs: () => ({ bavail: 60 * 1024 ** 3 / 4096, bsize: 4096 }), launchChromium: false });
  const out = formatReport(bad);
  assert.match(out, /NOT READY/);
  for (const re of [/Authority:/, /Backup:/, /JARVIS_MAIL_WORKER_TOKEN fehlt/]) assert.ok(bad.reasons.some((x) => re.test(x)), `${re} in ${bad.reasons.join(" | ")}`);
  fs.rmSync(e.secretsDir, { recursive: true, force: true });
});

test("Release-Gate 046 + Image: Skript umfasst Unit + TF-044-Lab + TF-045-Browser + TF-046-Full-Order (kein Skip); Readiness im VPS-Image", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["test:release-046"], "npm test && npm run test:repair-integration && npm run test:browser-integration && npm run test:full-order-integration");
  assert.match(pkg.scripts["test:full-order-integration"], /--full-order/);
  assert.match(read("scripts/test-repair-integration.mjs"), /full-order-046/);
  assert.match(read("deploy/vps/Dockerfile"), /production-readiness\.js/);
  assert.equal(OFFERS.REPAIR_FIX_500.price, 480);
});
