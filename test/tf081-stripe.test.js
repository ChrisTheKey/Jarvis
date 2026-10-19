// TF-081 – Zahlungen über die STATISCHEN Stripe-Payment-Links (CHF 150 / 480): Zuordnung über client_reference_id, strikt fail closed.
// Nur Fixtures im Stripe-TESTmodus (signierte Webhook-Ereignisse mit Test-Secret). 0 echte Zahlungen, 0 Mails, 0 echte Kunden.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { paymentGateForOrder, paymentsForOrder } from "../payments.js";
import { createContactFormRepairOrder, createConfirmedRepairOrder, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { memoryStore } from "../shared-state.js";
import { createPaymentsHandler } from "../payments-api.js";
import { signStripePayload } from "../stripe-payments.js";
import { syncStripePayments, STRIPE_FILE } from "../stripe-webhook.js";
import { writeOrdersExport } from "../onboarding-store.js";

const T0 = new Date("2026-10-19T12:00:00Z");
const WH = { STRIPE_WEBHOOK_SECRET: "whsec_fixtLive", STRIPE_TEST_WEBHOOK_SECRET: "whsec_fixtTest", JARVIS_MAIL_WORKER_TOKEN: "w".repeat(43) };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf081s-"));

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
    // Checkout-Session eines statischen Payment Links (client_reference_id aus dem Link, payment_link gesetzt, KEIN metadata)
    event({ ref, amount, currency = "chf", mode = "test", paid = true, type = "checkout.session.completed", plink = "plink_1Fixture0001" , pi = null, evt = null } = {}) {
      n++;
      return { id: evt || `evt_fixture${String(n).padStart(4, "0")}`, object: "event", type, livemode: mode === "live", created: Math.floor(+T0 / 1000),
        data: { object: { id: `cs_${mode}_a1Fixture${String(n).padStart(4, "0")}`, object: "checkout.session", livemode: mode === "live", status: "complete", payment_status: paid ? "paid" : "unpaid",
          amount_total: amount, currency, payment_intent: pi === false ? null : (pi || `pi_fixture${String(n).padStart(6, "0")}`), client_reference_id: ref, payment_link: plink, metadata: {}, customer_details: { email: "anyone@example.com" } } } };
    } };
  return w;
}
const fixOrder = (w, { test = false } = {}) => (test
  ? createContactFormRepairOrder(w.store, { domain: "jarvis-sandbox.ch", delivery_email: "e2e@helvetic-test.ch", contact_form_key: "cf:" + "a".repeat(24), confirmed_at: T0.toISOString(), test: { run_id: "e2e-0123456789ab" }, now: T0 })
  : createConfirmedRepairOrder(w.store, { domain: "muster-garage.ch", delivery_email: "anna@muster-garage.ch", contact_name: "Anna Muster", now: T0 }));
const checkOrder = (w, id = "CA150-20261019-abc123") => {
  w.store.write("check150_orders.json", { schema: 1, orders: { [id]: { order_id: id, offer_class: "REPAIR_CHECK_150", state: "BLOCKED_PAYMENT_NOT_RECEIVED", market: "CH", domain: "kunde-check.ch", delivery_email: "k@kunde-check.ch" } } });
  return id;
};
const gate = (w, order) => paymentGateForOrder(w.store, order).satisfied;

test("CHF 480 über statischen Link (TEST) → dem richtigen FIX-Auftrag zugeordnet, Gate offen, genau eine Buchung", async () => {
  const w = world(), o = fixOrder(w, { test: true });
  assert.equal(gate(w, o), false);
  const r = await w.hook(w.event({ ref: o.order_id, amount: 48000 })); assert.equal(r.status, 200);
  const out = await w.sync(); assert.equal(out.booked, 1); assert.equal(out.reviews, 0);
  const ps = paymentsForOrder(w.store, o.order_id); assert.equal(ps.length, 1);
  assert.equal(ps[0].amount, 480); assert.equal(ps[0].provider_mode, "TEST"); assert.equal(ps[0].is_test, true); assert.equal(ps[0].source, "stripe_test_payment_link");
  assert.equal(gate(w, o), true);
});

test("CHF 150 über statischen Link (TEST-Modus) auf echten CHECK-Auftrag → Modus passt nicht → Prüfung, nichts verbucht", async () => {
  const w = world(), id = checkOrder(w);
  await w.hook(w.event({ ref: id, amount: 15000 })); const out = await w.sync();
  assert.equal(out.booked, 0); assert.equal(out.reviews, 1);
  assert.equal(paymentsForOrder(w.store, id).length, 0);
  assert.equal(w.stripeState().reviews.at(-1).code, "MODE_MISMATCH");
});

test("CHF 150 LIVE auf echten CHECK-Auftrag (LIVE-Secret) → zugeordnet; Betrag/Währung exakt", async () => {
  const w = world(), id = checkOrder(w);
  const ok = await w.hook(w.event({ ref: id, amount: 15000, mode: "live" }), { mode: "LIVE" });
  assert.equal(ok.status, 200);
  const out = await w.sync(); assert.equal(out.booked, 1);
  const p = paymentsForOrder(w.store, id)[0]; assert.equal(p.amount, 150); assert.equal(p.provider_mode, "LIVE"); assert.equal(p.source, "stripe_payment_link");
});

test("Nicht eindeutig zuordenbar → PAYMENT_REVIEW_REQUIRED, nie verbucht (keine/falsche Referenz, falscher Betrag, Fremdwährung, unbezahlt, unbekannter Auftrag)", async () => {
  const w = world(), o = fixOrder(w, { test: true });
  const cases = [
    [{ ref: null, amount: 48000 }, "PAYMENT_LINK_NO_REFERENCE"],
    [{ ref: "RF480-20261019-ffffff", amount: 48000 }, "UNKNOWN_ORDER"],
    [{ ref: "irgendwas'; drop", amount: 48000 }, "PAYMENT_LINK_NO_REFERENCE"],
    [{ ref: o.order_id, amount: 15000 }, "AMOUNT_MISMATCH"],
    [{ ref: o.order_id, amount: 47999 }, "AMOUNT_MISMATCH"],
    [{ ref: o.order_id, amount: 48000, currency: "eur" }, "CURRENCY_MISMATCH"],
  ];
  for (const [c] of cases) await w.hook(w.event(c));
  await w.hook(w.event({ ref: o.order_id, amount: 48000, paid: false })); // unbezahlt (CHECKOUT_PENDING) = kein Beleg, nichts verbucht
  const out = await w.sync();
  assert.equal(out.booked, 0); assert.equal(out.reviews, cases.length);
  assert.deepEqual(w.stripeState().reviews.map((x) => x.code), cases.map((c) => c[1]));
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 0); assert.equal(gate(w, o), false);
});

test("Doppelt: dasselbe Ereignis zweimal, neue Event-ID mit derselben Zahlung, zweite Zahlung nach erfülltem Gate → keine zweite Buchung", async () => {
  const w = world(), o = fixOrder(w, { test: true });
  const e = w.event({ ref: o.order_id, amount: 48000, pi: "pi_fixture999001" });
  await w.hook(e); await w.hook(e);                                                           // Netlify-Inbox: idempotent je Ereignis-ID
  const replay = structuredClone(e); replay.id = "evt_fixture_replay1";                       // Stripe-Wiederholung mit neuer ID, gleiche Zahlung
  await w.hook(replay);
  const second = w.event({ ref: o.order_id, amount: 48000, pi: "pi_fixture999002" });         // zweite, andere Zahlung auf denselben Auftrag
  await w.hook(second);
  const out = await w.sync();
  assert.equal(out.booked, 1);
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 1);
  const codes = w.stripeState().reviews.map((x) => x.code);
  assert.deepEqual(codes, ["DUPLICATE_PAYMENT"].slice(0, codes.length)); // höchstens die zweite Zahlung als Prüfung – Wiederholung der ersten ist ALREADY_RECORDED
  assert.ok(codes.includes("DUPLICATE_PAYMENT"));
  await w.hook(e); await w.sync(); assert.equal(paymentsForOrder(w.store, o.order_id).length, 1);
});

test("Test-Zahlung auf echten Auftrag und echte Zahlung auf Test-Auftrag werden nie verbucht", async () => {
  const w = world(), real = fixOrder(w), test = fixOrder(w, { test: true });
  await w.hook(w.event({ ref: real.order_id, amount: 48000, mode: "test" }));
  await w.hook(w.event({ ref: test.order_id, amount: 48000, mode: "live" }), { mode: "LIVE" });
  const out = await w.sync(); assert.equal(out.booked, 0); assert.equal(out.reviews, 2);
  assert.ok(w.stripeState().reviews.every((x) => x.code === "MODE_MISMATCH"));
});

test("Rückerstattung zu einer Link-Zahlung → Auftrag in Prüfung (PAYMENT_REVIEW_REQUIRED), nie automatisch erstattet", async () => {
  const w = world(), o = fixOrder(w, { test: true });
  await w.hook(w.event({ ref: o.order_id, amount: 48000, pi: "pi_fixture777001" })); await w.sync();
  const refund = { id: "evt_fixture_refund1", object: "event", type: "charge.refunded", livemode: false, created: Math.floor(+T0 / 1000),
    data: { object: { id: "ch_fixture0001", payment_intent: "pi_fixture777001", amount_refunded: 48000, currency: "chf", metadata: {} } } };
  await w.hook(refund); await w.sync();
  assert.equal(w.store.read(REPAIR_ORDERS_FILE, {}).orders[o.order_id].state, "PAYMENT_REVIEW_REQUIRED");
  assert.equal(w.stripeState().reviews.at(-1).code, "REFUND_REVIEW_REQUIRED");
});

test("Bezahlter Kunde: Bestellexport meldet payment_gate_met → Nachfass-Modul schweigt (kein Mail an bezahlte Kunden)", async () => {
  const { createPaymentFollowup } = await import("../payment-followup.js");
  const w = world(), o = fixOrder(w, { test: true }), od = tmp();
  const exp = (gateMet) => writeOrdersExport(od, { [o.order_id]: { order_id: o.order_id, market: "CH", offer_class: "REPAIR_FIX_500", order_confirmed: true, payment_gate_met: gateMet, customer_email: "kunde@muster.ch", contact_name: "A" } });
  await w.hook(w.event({ ref: o.order_id, amount: 48000 })); await w.sync();
  exp(gate(w, o));
  const sent = [], gm = { listOwned: () => ({ drafts: {}, sent: {} }), createDraft: async () => { sent.push("x"); return { draftId: "d", threadId: "t" }; }, sendDraft: async () => { sent.push("s"); return {}; }, readThread: async () => ({ messages: [] }) };
  let clock = T0;
  const f = createPaymentFollowup({ dir: tmp(), onboardingDir: od, gmail: gm, settings: () => ({ enabled: true }), now: () => clock });
  await f.process(); clock = new Date(+clock + 5 * 24 * 3600_000); await f.process(); await f.process();
  assert.equal(sent.length, 0);
});
