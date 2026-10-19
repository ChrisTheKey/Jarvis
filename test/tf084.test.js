// TF-084 – Sandbox-Testauftrag für «Check & Anleitung» (CHF 150) + strikte Trennung von Live-Aufträgen bei Stripe-Zahlungen.
// Nur Fixtures (Stripe-TESTmodus, signierte Ereignisse mit Test-Secret). 0 echte Zahlungen, 0 Mails, 0 echte Kunden.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { paymentGateForOrder, paymentsForOrder, paymentSummary, recordPayment } from "../payments.js";
import { createCheck150Order, createCheck150Engine, runCheck150Orders, check150Status, publicCheck150Orders, cancelCheck150Order, CHECK150_ORDERS_FILE } from "../check-150-workflow.js";
import { recordDirectSale } from "../sales.js";
import { ORDER_ID_RE, SELLER_COMMISSION_BPS } from "../pricing.js";
import { PAYMENT_LINKS, TEST_PAYMENT_LINK_RE, testPaymentLinkUrl, paymentLinkFor } from "../payment-links.js";
import { memoryStore } from "../shared-state.js";
import { createPaymentsHandler } from "../payments-api.js";
import { signStripePayload } from "../stripe-payments.js";
import { syncStripePayments, STRIPE_FILE } from "../stripe-webhook.js";

const T0 = new Date("2026-10-19T12:00:00Z");
const RUN = "e2e-0123456789ab";
const E2E = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "jarvis-sandbox.ch", JARVIS_E2E_TEST_MAILBOXES: "e2e@helvetic-test.ch" };
const SANDBOX_LINK = "https://buy.stripe.com/test_dRm3cw5A5fo3caR9ov7Re00";
const WH = { STRIPE_WEBHOOK_SECRET: "whsec_fixtLive", STRIPE_TEST_WEBHOOK_SECRET: "whsec_fixtTest", JARVIS_MAIL_WORKER_TOKEN: "w".repeat(43) };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf084-"));
const mkTest = (store, o = {}) => createCheck150Order(store, { domain: "jarvis-sandbox.ch", delivery_email: "e2e@helvetic-test.ch", test: { run_id: RUN }, env: E2E, now: T0, ...o });
const mkLive = (store, o = {}) => createCheck150Order(store, { domain: "kunde-check.ch", delivery_email: "k@kunde-check.ch", contact_name: "Kunde", now: T0, ...o });

function world() {
  const dir = tmp(), store = createStore(dir), mem = {};
  const handler = createPaymentsHandler({ env: (k) => WH[k], getStore: async (k) => (mem[k] ||= memoryStore()), now: () => T0 });
  const req = (body, headers) => new Request("https://jarvis.test/api/payments", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  let n = 0;
  const w = { dir, store,
    async hook(evt, { mode = "TEST" } = {}) {
      const raw = JSON.stringify(evt), secret = mode === "TEST" ? WH.STRIPE_TEST_WEBHOOK_SECRET : WH.STRIPE_WEBHOOK_SECRET;
      const r = await handler(req(raw, { "stripe-signature": signStripePayload(raw, secret, Math.floor(+T0 / 1000)) }));
      return { status: r.status, body: await r.json() };
    },
    inbox: { pull: async () => (await (await handler(req(JSON.stringify({ op: "inbox.pull" }), { "x-jarvis-worker": WH.JARVIS_MAIL_WORKER_TOKEN }))).json()).events,
      ack: async (keys) => handler(req(JSON.stringify({ op: "inbox.ack", keys }), { "x-jarvis-worker": WH.JARVIS_MAIL_WORKER_TOKEN })) },
    async sync() { return syncStripePayments({ dir, inbox: w.inbox, env: {}, now: T0, eventsOnly: true }); },
    stripeState: () => store.read(STRIPE_FILE, {}),
    event({ ref, amount = 15000, currency = "chf", mode = "test", paid = true, plink = "plink_1Fixture0001", evt = null } = {}) {
      n++;
      return { id: evt || `evt_fixture${String(n).padStart(4, "0")}`, object: "event", type: "checkout.session.completed", livemode: mode === "live", created: Math.floor(+T0 / 1000),
        data: { object: { id: `cs_${mode}_a1Fixture${String(n).padStart(4, "0")}`, object: "checkout.session", livemode: mode === "live", status: "complete", payment_status: paid ? "paid" : "unpaid",
          amount_total: amount, currency, payment_intent: `pi_fixture${String(n).padStart(6, "0")}`, client_reference_id: ref, payment_link: plink, metadata: {}, customer_details: { email: "anyone@example.com" } } } };
    } };
  return w;
}
const gate = (w, o) => paymentGateForOrder(w.store, o).satisfied;
const stored = (w, id) => w.store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[id];

test("Testauftrag: test_order/TEST, CHF 150, offen, keine Provision, kein Verkauf, gültige order_id", () => {
  const dir = tmp(), store = createStore(dir);
  const o = mkTest(store);
  assert.match(o.order_id, ORDER_ID_RE); assert.match(o.order_id, /^CA150-20261019-[0-9a-f]{6}$/);
  assert.equal(o.test_order, true); assert.equal(o.environment, "TEST"); assert.equal(o.test_run_id, RUN);
  assert.equal(o.price_chf, 150); assert.equal(o.currency, "CHF"); assert.equal(o.commission_rate_bps, 0);
  assert.equal(o.state, "ORDER_CONFIRMED"); assert.equal(o.automatic_send_allowed, false);
  assert.equal(store.read("sales.json", null), null, "sales.json bleibt unberührt (kein Verkauf, kein Umsatz)");
  assert.equal(paymentsForOrder(store, o.order_id).length, 0);
  assert.equal(paymentGateForOrder(store, o).satisfied, false);
  assert.equal(paymentSummary(store, o).payment_status, "UNPAID");
});

test("Testauftrag: nur ausdrücklich + fail closed (Allowlist, run_id, Angebot)", () => {
  const dir = tmp(), store = createStore(dir);
  const bad = (o, re) => assert.throws(() => mkTest(store, o), re);
  bad({ env: {} }, /TEST_BLOCKED/);                                                           // keine E2E-Konfiguration
  bad({ env: { ...E2E, JARVIS_E2E_TEST_ENABLED: "false" } }, /TEST_BLOCKED/);                 // ausgeschaltet
  bad({ domain: "kunde-check.ch" }, /TEST_BLOCKED/);                                          // echte Kundendomain
  bad({ delivery_email: "k@kunde-check.ch" }, /TEST_BLOCKED/);                                // fremdes Postfach
  bad({ test: { run_id: "e2e-zzzz" } }, /test_run_id/);                                       // ungültige Kennung
  bad({ test: {} }, /test_run_id/);
  bad({ offer_class: "VN_REPAIR_CHECK" }, /nur für CH/);                                      // kein VN-Testauftrag
  assert.equal(check150Status(dir).total, 0, "nichts angelegt");
});

test("Live-Auftrag unverändert: kein Testkennzeichen, volle Provision, Allowlist spielt keine Rolle", () => {
  const dir = tmp(), store = createStore(dir);
  const o = mkLive(store);
  assert.equal(o.test_order, undefined); assert.equal(o.environment, undefined); assert.equal(o.test_run_id, undefined);
  assert.equal(o.state, "ORDER_RECEIVED"); assert.equal(o.commission_rate_bps, SELLER_COMMISSION_BPS); assert.equal(o.confirmed, null);
  assert.equal(check150Status(dir).open, 1); assert.equal(check150Status(dir).test_orders, 0);
});

test("Engine überspringt Testaufträge: kein Audit, kein Entwurf, keine Mail – selbst mit Verkauf und erfüllter Zahlung", async () => {
  const dir = tmp(), store = createStore(dir);
  const o = mkTest(store);
  store.write("sales.json", { records: recordDirectSale({}, { domain: o.domain, offer: "REPAIR_CHECK_150", delivery_email: o.delivery_email, date: "2026-10-19" }) });
  recordPayment(store, { order_id: o.order_id, amount: 150, currency: "CHF", source: "stripe_test_payment_link", reference: "stripe:pi_x1", provider_mode: "TEST", now: T0 });
  const calls = [];
  const boom = (n) => async () => { calls.push(n); throw new Error("darf nie aufgerufen werden: " + n); };
  const gmail = { createDraft: boom("createDraft"), sendDraft: boom("sendDraft") };
  const auditor = { audit: boom("audit"), fullSiteAudit: boom("fullSiteAudit") };
  const eng = createCheck150Engine({ dir, store, gmail, auditor, onboarding: true, now: () => T0 });
  assert.equal(await eng.step(stored({ store }, o.order_id) || o), false);
  const r = await eng.processAll();
  assert.equal(r.processed, 0); assert.deepEqual(calls, []);
  assert.equal(stored({ store }, o.order_id).state, "ORDER_CONFIRMED");
  assert.equal((await runCheck150Orders({ dir, gmail, auditor, onboarding: true })).processed, 0);
  assert.deepEqual(calls, []);
  const pub = publicCheck150Orders(dir).orders.find((x) => x.order_id === o.order_id);
  assert.equal(pub.test_order, true); assert.equal(pub.environment, "TEST");
});

test("Stripe: Sandbox-Zahlung CHF 150 → genau dem TEST-Auftrag zugeordnet, genau eine Buchung, Wiederholung/Doppelzahlung nie zweimal", async () => {
  const w = world(), t = mkTest(w.store), live = mkLive(w.store);
  assert.notEqual(t.order_id, live.order_id);
  assert.equal((await w.hook(w.event({ ref: t.order_id, evt: "evt_fixture_same" }))).status, 200);
  assert.equal((await w.hook(w.event({ ref: t.order_id, evt: "evt_fixture_same" }))).status, 200); // Stripe-Wiederholung
  const out = await w.sync(); assert.equal(out.booked, 1); assert.equal(out.reviews, 0);
  const ps = paymentsForOrder(w.store, t.order_id);
  assert.equal(ps.length, 1); assert.equal(ps[0].amount, 150); assert.equal(ps[0].provider_mode, "TEST"); assert.equal(ps[0].is_test, true); assert.equal(ps[0].source, "stripe_test_payment_link");
  assert.equal(gate(w, t), true);
  // zweite, andere Zahlung auf denselben (schon bezahlten) Auftrag → Prüfung, keine zweite Buchung
  await w.hook(w.event({ ref: t.order_id })); const again = await w.sync();
  assert.equal(again.booked, 0); assert.equal(again.reviews, 1);
  assert.equal(paymentsForOrder(w.store, t.order_id).length, 1);
  assert.equal(w.stripeState().reviews.at(-1).code, "DUPLICATE_PAYMENT");
});

test("TRENNUNG: Sandbox-Zahlung kann nie einen Live-Auftrag als bezahlt markieren (beide Richtungen, alle Wege)", async () => {
  const w = world(), t = mkTest(w.store), live = mkLive(w.store);
  // 1) TEST-Ereignis mit der ID des LIVE-Auftrags
  await w.hook(w.event({ ref: live.order_id, mode: "test" })); let out = await w.sync();
  assert.equal(out.booked, 0); assert.equal(out.reviews, 1); assert.equal(w.stripeState().reviews.at(-1).code, "MODE_MISMATCH");
  // 2) LIVE-Ereignis (LIVE-Secret) mit der ID des TEST-Auftrags
  await w.hook(w.event({ ref: t.order_id, mode: "live" }), { mode: "LIVE" }); out = await w.sync();
  assert.equal(out.booked, 0); assert.equal(out.reviews, 1); assert.equal(w.stripeState().reviews.at(-1).code, "MODE_MISMATCH");
  // 3) TEST-Ereignis, aber mit LIVE-Secret signiert → Signatur ungültig, nichts in der Inbox
  const bad = await w.hook(w.event({ ref: live.order_id, mode: "test" }), { mode: "LIVE" }); assert.equal(bad.status, 400);
  // 4) direkte Buchung: TEST-Zahlung auf Live-Auftrag und LIVE-Zahlung auf TEST-Auftrag werden abgewiesen
  assert.throws(() => recordPayment(w.store, { order_id: live.order_id, amount: 150, currency: "CHF", reference: "stripe:pi_a", provider_mode: "TEST", now: T0 }), /echt/);
  assert.throws(() => recordPayment(w.store, { order_id: t.order_id, amount: 150, currency: "CHF", reference: "stripe:pi_b", provider_mode: "LIVE", now: T0 }), /E2E-Test/);
  assert.equal(paymentsForOrder(w.store, live.order_id).length, 0); assert.equal(paymentsForOrder(w.store, t.order_id).length, 0);
  // 5) erfolgreiche Sandbox-Zahlung auf den TEST-Auftrag lässt den Live-Auftrag völlig unberührt
  await w.hook(w.event({ ref: t.order_id })); out = await w.sync(); assert.equal(out.booked, 1);
  assert.equal(gate(w, t), true); assert.equal(gate(w, live), false);
  assert.equal(paymentSummary(w.store, live).paid_amount, 0); assert.equal(paymentSummary(w.store, live).payment_status, "UNPAID");
  assert.equal(paymentsForOrder(w.store, live.order_id).length, 0);
  assert.equal(stored(w, live.order_id).state, "ORDER_RECEIVED");
});

test("Stripe: falscher Betrag / unbezahlt / ohne Referenz / unbekannter Auftrag → Prüfung, nichts verbucht", async () => {
  const w = world(), t = mkTest(w.store);
  const cases = [[{ ref: t.order_id, amount: 7500 }, "AMOUNT_MISMATCH"], [{ ref: t.order_id, amount: 48000 }, "AMOUNT_MISMATCH"], [{ ref: t.order_id, currency: "eur" }, "CURRENCY_MISMATCH"],
    [{ ref: null }, "PAYMENT_LINK_NO_REFERENCE"], [{ ref: "CA150-20261019-ffffff" }, "UNKNOWN_ORDER"]];
  for (const [e, code] of cases) { await w.hook(w.event(e)); const out = await w.sync(); assert.equal(out.booked, 0, code); assert.equal(w.stripeState().reviews.at(-1).code, code); }
  // unbezahlte Session (z. B. Zahlung noch offen) ist keine Zahlung: nichts verbucht, Auftrag bleibt offen
  const before = w.stripeState().reviews.length;
  await w.hook(w.event({ ref: t.order_id, paid: false })); const pend = await w.sync();
  assert.equal(pend.booked, 0); assert.equal(w.stripeState().reviews.length, before);
  assert.equal(paymentsForOrder(w.store, t.order_id).length, 0); assert.equal(gate(w, t), false);
});

test("Sandbox-Link: nur echte Test-Links mit client_reference_id; Live-Links und Kundenmails bleiben unberührt", () => {
  const u = testPaymentLinkUrl(SANDBOX_LINK, { orderId: "CA150-20261019-abc123" });
  assert.equal(u, `${SANDBOX_LINK}?client_reference_id=CA150-20261019-abc123`);
  assert.equal(testPaymentLinkUrl(PAYMENT_LINKS.REPAIR_CHECK_150, { orderId: "CA150-20261019-abc123" }), null, "Live-Link ist kein Testlink");
  assert.equal(testPaymentLinkUrl(SANDBOX_LINK, { orderId: "nope" }), null);
  assert.equal(testPaymentLinkUrl("https://evil.example/test_abcdefghij12", { orderId: "CA150-20261019-abc123" }), null);
  for (const l of Object.values(PAYMENT_LINKS)) assert.equal(TEST_PAYMENT_LINK_RE.test(l), false);
  assert.ok(!String(paymentLinkFor("REPAIR_CHECK_150", { orderId: "CA150-20261019-abc123" })).includes("test_"));
});

test("Testauftrag lässt sich sauber stornieren (bleibt gespeichert, keine Aktion)", () => {
  const dir = tmp(), store = createStore(dir), o = mkTest(store);
  const c = cancelCheck150Order(store, o.order_id, { reason: "Sandbox fertig", now: T0 });
  assert.equal(c.state, "CANCELLED"); assert.equal(c.test_order, true);
});
