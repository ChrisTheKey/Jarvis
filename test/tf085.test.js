// TF-085 – Zahlungsstatus in `--show` live aus dem Ledger (nicht aus dem gespeicherten Auftrags-Schnappschuss).
// Reine Leseansicht: keine Buchung, keine Änderung an Ledger/Auftrag. TEST/LIVE strikt getrennt. Nur Fixtures, 0 echte Zahlungen/Mails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment, withLivePayment, paymentsForOrder, PAYMENTS_FILE } from "../payments.js";
import { createCheck150Order, CHECK150_ORDERS_FILE } from "../check-150-workflow.js";
import { createContactFormRepairOrder, createConfirmedRepairOrder, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { memoryStore } from "../shared-state.js";
import { createPaymentsHandler } from "../payments-api.js";
import { signStripePayload } from "../stripe-payments.js";
import { syncStripePayments } from "../stripe-webhook.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T0 = new Date("2026-10-19T12:00:00Z");
const RUN = "e2e-0123456789ab";
const E2E = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "jarvis-sandbox.ch", JARVIS_E2E_TEST_MAILBOXES: "e2e@helvetic-test.ch" };
const WH = { STRIPE_WEBHOOK_SECRET: "whsec_fixtLive", STRIPE_TEST_WEBHOOK_SECRET: "whsec_fixtTest", JARVIS_MAIL_WORKER_TOKEN: "w".repeat(43) };

// Verzeichnis wie im Container: JARVIS_SECRETS_DIR/mail_worker (so liest das echte CLI dieselben Dateien).
function env() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf085-")); const dir = path.join(root, "mail_worker"); fs.mkdirSync(dir, { recursive: true }); return { root, dir, store: createStore(dir) }; }
const cli = (root, file, ...args) => { const r = spawnSync(process.execPath, [path.join(ROOT, file), ...args], { env: { ...process.env, JARVIS_SECRETS_DIR: root }, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const bytes = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return null; } };
const testCheck = (store) => createCheck150Order(store, { domain: "jarvis-sandbox.ch", delivery_email: "e2e@helvetic-test.ch", test: { run_id: RUN }, env: E2E, now: T0 });
const pay = (store, o, amount, mode, ref) => recordPayment(store, { order_id: o.order_id, amount, currency: "CHF", source: mode === "TEST" ? "stripe_test_payment_link" : "stripe_payment_link", reference: ref, provider_mode: mode, now: T0 });

test("withLivePayment: CHF-150-Testauftrag – CHF 150 / PAID_FULL aus dem Ledger; Auftrag, Ledger und Schnappschuss bleiben unverändert", () => {
  const { dir, store } = env(), o = testCheck(store);
  const before = withLivePayment(store, o);
  assert.equal(before.payment.paid_chf, 0); assert.equal(before.payment.satisfied, false); assert.equal(before.payment_status, "UNPAID");
  pay(store, o, 150, "TEST", "stripe:pi_a1");
  const orderBytes = bytes(dir, CHECK150_ORDERS_FILE), ledgerBytes = bytes(dir, PAYMENTS_FILE);
  const v = withLivePayment(store, store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id]);
  assert.equal(v.payment.paid_chf, 150); assert.equal(v.payment.required_chf, 75); assert.equal(v.payment.satisfied, true);
  assert.equal(v.payment_status, "PAID_FULL"); assert.equal(v.payment_source, "ledger");
  assert.equal(v.payment_snapshot_stored.paid_chf, 0, "gespeicherter Schnappschuss wird nur angezeigt, nie überschrieben");
  assert.equal(v.test_order, true); assert.equal(v.environment, "TEST"); assert.equal(v.commission_rate_bps, 0);
  for (let i = 0; i < 3; i++) withLivePayment(store, v);
  assert.equal(bytes(dir, CHECK150_ORDERS_FILE), orderBytes, "Auftragsdatei unverändert"); assert.equal(bytes(dir, PAYMENTS_FILE), ledgerBytes, "Ledger unverändert (keine Buchung durch die Ansicht)");
  assert.equal(paymentsForOrder(store, o.order_id).length, 1);
});

test("TEST/LIVE getrennt: Testzahlung erscheint nie bei einem Live-Auftrag; Live-Zahlungen nur bei Live-Aufträgen", () => {
  const { store } = env(), t = testCheck(store);
  const live = createCheck150Order(store, { domain: "kunde-check.ch", delivery_email: "k@kunde-check.ch", now: T0 });
  pay(store, t, 150, "TEST", "stripe:pi_t1");
  assert.equal(withLivePayment(store, live).payment.paid_chf, 0); assert.equal(withLivePayment(store, live).payment_status, "UNPAID");
  pay(store, live, 75, "LIVE", "stripe:pi_l1");
  assert.equal(withLivePayment(store, live).payment_status, "DEPOSIT_MET"); assert.equal(withLivePayment(store, live).payment.paid_chf, 75);
  assert.equal(withLivePayment(store, t).payment.paid_chf, 150, "Testauftrag sieht keine Live-Zahlung dazu");
  pay(store, live, 75, "LIVE", "stripe:pi_l2");
  assert.equal(withLivePayment(store, live).payment_status, "PAID_FULL"); assert.equal(withLivePayment(store, live).payment.paid_chf, 150);
  assert.throws(() => pay(store, live, 150, "TEST", "stripe:pi_x"), /echt/); assert.throws(() => pay(store, t, 150, "LIVE", "stripe:pi_y"), /E2E-Test/);
});

test("CLI `check-150-workflow.js --show` (echter Prozess): paid_chf 150, PAID_FULL, test_order, Provision 0 – ohne Schreibzugriff und ohne Verkauf", () => {
  const { root, dir, store } = env(), o = testCheck(store);
  pay(store, o, 150, "TEST", "stripe:pi_cli1");
  const snap = { order: bytes(dir, CHECK150_ORDERS_FILE), ledger: bytes(dir, PAYMENTS_FILE) };
  const out = cli(root, "check-150-workflow.js", "--show", o.order_id);
  assert.equal(out.payment.paid_chf, 150); assert.equal(out.payment.satisfied, true); assert.equal(out.payment_status, "PAID_FULL");
  assert.equal(out.test_order, true); assert.equal(out.environment, "TEST"); assert.equal(out.commission_rate_bps, 0); assert.equal(out.state, "ORDER_CONFIRMED");
  assert.equal(cli(root, "check-150-workflow.js", "--show", o.order_id).payment.paid_chf, 150, "wiederholt aufgerufen: gleiches Ergebnis, nie 300");
  assert.equal(bytes(dir, CHECK150_ORDERS_FILE), snap.order); assert.equal(bytes(dir, PAYMENTS_FILE), snap.ledger);
  assert.equal(bytes(dir, "sales.json"), null, "kein Verkauf, keine Statistik"); assert.equal(paymentsForOrder(store, o.order_id).length, 1);
});

test("CLI `check-150-workflow.js --show`: unbezahlter Testauftrag bleibt UNPAID/0", () => {
  const { root, store } = env(), o = testCheck(store);
  const out = cli(root, "check-150-workflow.js", "--show", o.order_id);
  assert.equal(out.payment.paid_chf, 0); assert.equal(out.payment.satisfied, false); assert.equal(out.payment_status, "UNPAID");
});

test("CHF 480: `repair-workflow.js --show` zeigt Zahlungsstand ebenfalls live (240 → DEPOSIT_MET, 480 → PAID_FULL; Live-Auftrag unberührt)", () => {
  const { root, dir, store } = env();
  const t = createContactFormRepairOrder(store, { domain: "jarvis-sandbox.ch", delivery_email: "e2e@helvetic-test.ch", contact_form_key: "cf:" + "a".repeat(24), confirmed_at: T0.toISOString(), test: { run_id: RUN }, now: T0 });
  const live = createConfirmedRepairOrder(store, { domain: "muster-garage.ch", delivery_email: "anna@muster-garage.ch", contact_name: "Anna Muster", now: T0 });
  assert.equal(cli(root, "repair-workflow.js", "--show", t.order_id).payment_status, "UNPAID");
  pay(store, t, 240, "TEST", "stripe:pi_r1");
  let out = cli(root, "repair-workflow.js", "--show", t.order_id);
  assert.equal(out.payment.paid_chf, 240); assert.equal(out.payment.satisfied, true); assert.equal(out.payment_status, "DEPOSIT_MET");
  pay(store, t, 240, "TEST", "stripe:pi_r2");
  const snap = bytes(dir, REPAIR_ORDERS_FILE);
  out = cli(root, "repair-workflow.js", "--show", t.order_id);
  assert.equal(out.payment.paid_chf, 480); assert.equal(out.payment_status, "PAID_FULL"); assert.equal(out.test_order, true); assert.equal(out.environment, "TEST");
  assert.equal(bytes(dir, REPAIR_ORDERS_FILE), snap, "keine Schreibzugriffe");
  const lv = cli(root, "repair-workflow.js", "--show", live.order_id);
  assert.equal(lv.payment.paid_chf, 0); assert.equal(lv.payment_status, "UNPAID"); assert.notEqual(lv.test_order, true);
});

test("Ende-zu-Ende: Stripe-Sandbox-Ereignis wird genau einmal verbucht; Wiederholung ändert weder Ledger noch Anzeige (keine Doppelbuchung)", async () => {
  const { dir, store } = env(), o = testCheck(store), mem = {};
  const handler = createPaymentsHandler({ env: (k) => WH[k], getStore: async (k) => (mem[k] ||= memoryStore()), now: () => T0 });
  const req = (body, headers) => new Request("https://jarvis.test/api/payments", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const evt = { id: "evt_tf085fixture01", object: "event", type: "checkout.session.completed", livemode: false, created: Math.floor(+T0 / 1000),
    data: { object: { id: "cs_test_a1Tf085Fixture01", object: "checkout.session", livemode: false, status: "complete", payment_status: "paid", amount_total: 15000, currency: "chf",
      payment_intent: "pi_tf085fixture01", client_reference_id: o.order_id, payment_link: "plink_1Tf085Fixture", metadata: {} } } };
  const send = async () => { const raw = JSON.stringify(evt); return handler(req(raw, { "stripe-signature": signStripePayload(raw, WH.STRIPE_TEST_WEBHOOK_SECRET, Math.floor(+T0 / 1000)) })); };
  const inbox = { pull: async () => (await (await handler(req(JSON.stringify({ op: "inbox.pull" }), { "x-jarvis-worker": WH.JARVIS_MAIL_WORKER_TOKEN }))).json()).events,
    ack: async (keys) => handler(req(JSON.stringify({ op: "inbox.ack", keys }), { "x-jarvis-worker": WH.JARVIS_MAIL_WORKER_TOKEN })) };
  assert.equal((await send()).status, 200);
  assert.equal((await syncStripePayments({ dir, inbox, env: {}, now: T0, eventsOnly: true })).booked, 1);
  const ledger = bytes(dir, PAYMENTS_FILE);
  assert.equal((await send()).status, 200); // Stripe sendet erneut
  const again = await syncStripePayments({ dir, inbox, env: {}, now: T0, eventsOnly: true });
  assert.equal(again.booked, 0); assert.equal(paymentsForOrder(store, o.order_id).length, 1); assert.equal(bytes(dir, PAYMENTS_FILE), ledger);
  const v = withLivePayment(store, o);
  assert.equal(v.payment.paid_chf, 150); assert.equal(v.payment_status, "PAID_FULL"); assert.equal(v.payment.satisfied, true);
});
