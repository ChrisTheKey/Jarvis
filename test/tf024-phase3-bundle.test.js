import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { createOfferIntentBundle, bundleForIntent, selectOfferIntent } from "../sales-intake-bundle.js";
import { processCheckoutEvent } from "../stripe-webhook.js";
import { paymentsForOrder } from "../payments.js";
import { activatePreboundAccess } from "../repair-workflow.js";

const now = new Date("2026-10-26T10:00:00.000Z");
const ids = { bundle_id: "SIB-20261026-a1b2c3", lead_id: "synthetic-024.ch", domain: "synthetic-024.ch", email: "kunde@synthetic-024.ch", order150_id: "CA150-20261026-d4e5f6", order480_id: "RF480-20261026-a7b8c9" };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf024-bundle-"));
  return { dir, store: createStore(dir) };
}

test("TF-024 Phase 3: Bundle persistiert genau zwei offene Offer-Intents ohne Vault-Geheimnis", () => {
  const { store } = fixture();
  const b = createOfferIntentBundle(store, { ...ids, vaultToken: "synthetic-vault-token", vaultExpiresAt: "2026-10-27T10:00:00.000Z", now });
  assert.equal(b.status, "PENDING_SELECTION");
  assert.deepEqual(Object.keys(b.offers).sort(), ["REPAIR_CHECK_150", "REPAIR_FIX_500"]);
  assert.equal(b.offers.REPAIR_CHECK_150.intent_id, ids.order150_id);
  assert.equal(b.offers.REPAIR_FIX_500.intent_id, ids.order480_id);
  const persisted = store.read("sales_intake_bundles.json", { bundles: {} }).bundles[b.bundle_id];
  assert.equal(persisted.vault_token, undefined);
  assert.equal(persisted.offers.REPAIR_FIX_500.status, "OPEN");
});

test("TF-024 Phase 3: Auswahl ist persistent idempotent und schliesst die Gegenofferte", () => {
  const { store } = fixture();
  createOfferIntentBundle(store, { ...ids, now });
  const first = selectOfferIntent(store, ids.order150_id, { now: new Date(+now + 1000) });
  const again = selectOfferIntent(store, ids.order150_id, { now: new Date(+now + 2000) });
  const other = selectOfferIntent(store, ids.order480_id, { now: new Date(+now + 3000) });
  assert.equal(first.result, "SELECTED");
  assert.equal(again.result, "ALREADY_SELECTED");
  assert.equal(other.result, "OFFER_CLOSED");
  assert.equal(bundleForIntent(store, ids.order150_id).selected_offer, "REPAIR_CHECK_150");
  assert.equal(bundleForIntent(store, ids.order480_id).offers.REPAIR_FIX_500.status, "CLOSED");
});

function paymentEvent(ref, amount, id) {
  return { event_id: id, kind: "CHECKOUT_PAID", session_id: `cs_${id}`, provider_mode: "LIVE", payment_status: "paid", currency: "CHF", amount_minor: amount, payment_intent: `pi_${id}`, client_reference_id: ref, payment_link: true };
}

test("TF-024 Phase 3: verifizierte CHF-150-Zahlung materialisiert nur das Check-Angebot", () => {
  const { store } = fixture();
  createOfferIntentBundle(store, { ...ids, now });
  const st = { events: {}, static: {}, attempts: {}, sessions: {}, reviews: [] };
  const r = processCheckoutEvent(store, st, paymentEvent(ids.order150_id, 15000, "tf024-150"), { now });
  assert.equal(r.result, "BOOKED");
  assert.equal(store.read("check150_orders.json", { orders: {} }).orders[ids.order150_id].offer_class, "REPAIR_CHECK_150");
  assert.equal(paymentsForOrder(store, ids.order150_id).length, 1);
  assert.equal(store.read("repair_orders.json", { orders: {} }).orders[ids.order480_id], undefined);
  assert.equal(bundleForIntent(store, ids.order480_id).offers.REPAIR_FIX_500.status, "CLOSED");
});

test("TF-024 Phase 3: verifizierte CHF-480-Zahlung materialisiert nur das Reparatur-Angebot", () => {
  const { store } = fixture();
  createOfferIntentBundle(store, { ...ids, vaultToken: "synthetic-vault-token", vaultExpiresAt: "2026-10-27T10:00:00.000Z", now });
  const st = { events: {}, static: {}, attempts: {}, sessions: {}, reviews: [] };
  const r = processCheckoutEvent(store, st, paymentEvent(ids.order480_id, 48000, "tf024-480"), { now });
  assert.equal(r.result, "BOOKED");
  const order = store.read("repair_orders.json", { orders: {} }).orders[ids.order480_id];
  assert.equal(order.offer_class, "REPAIR_FIX_500");
  assert.equal(order.confirmed.source, "sales.json");
  assert.equal(paymentsForOrder(store, ids.order480_id).length, 1);
  assert.equal(store.read("check150_orders.json", { orders: {} }).orders[ids.order150_id], undefined);
});

test("TF-024 Phase 3: CHF-480-Tresor wird erst nach Zahlung registriert und speichert nur den Hash", async () => {
  const { store } = fixture();
  createOfferIntentBundle(store, { ...ids, vaultToken: "synthetic-vault-token", vaultExpiresAt: "2026-10-27T10:00:00.000Z", now });
  const st = { events: {}, static: {}, attempts: {}, sessions: {}, reviews: [] };
  processCheckoutEvent(store, st, paymentEvent(ids.order480_id, 48000, "tf024-vault"), { now });
  const registrations = [];
  const out = await activatePreboundAccess({ store, intake: { register: async (r) => registrations.push(r) }, now });
  assert.equal(out.activated, 1);
  assert.equal(registrations[0].order_id, ids.order480_id);
  assert.equal(registrations[0].token_hash.length, 64);
  assert.equal(registrations[0].token, undefined);
  const order = store.read("repair_orders.json", { orders: {} }).orders[ids.order480_id];
  assert.equal(order.state, "ACCESS_REQUESTED");
  assert.equal(order.prebound_access.status, "ACTIVE");
  assert.equal(order.access_request.token_hash, registrations[0].token_hash);
});

test("TF-024 Phase 3: falscher Betrag lässt das Bundle unverändert und erzeugt keinen Auftrag", () => {
  const { store } = fixture();
  createOfferIntentBundle(store, { ...ids, now });
  const st = { events: {}, static: {}, attempts: {}, sessions: {}, reviews: [] };
  const r = processCheckoutEvent(store, st, paymentEvent(ids.order150_id, 14900, "tf024-wrong"), { now });
  assert.equal(r.result, "PAYMENT_REVIEW_REQUIRED");
  assert.equal(r.code, "AMOUNT_MISMATCH");
  assert.equal(bundleForIntent(store, ids.order150_id).status, "PENDING_SELECTION");
  assert.deepEqual(store.read("check150_orders.json", { orders: {} }).orders, {});
});

test("TF-024 Phase 3: Zahlung auf geschlossene Gegenofferte bleibt Review und wird nicht verbucht", () => {
  const { store } = fixture();
  createOfferIntentBundle(store, { ...ids, now });
  const st = { events: {}, static: {}, attempts: {}, sessions: {}, reviews: [] };
  assert.equal(processCheckoutEvent(store, st, paymentEvent(ids.order150_id, 15000, "tf024-selected"), { now }).result, "BOOKED");
  const r = processCheckoutEvent(store, st, paymentEvent(ids.order480_id, 48000, "tf024-closed"), { now: new Date(+now + 1000) });
  assert.equal(r.result, "PAYMENT_REVIEW_REQUIRED");
  assert.equal(r.code, "OFFER_CLOSED");
  assert.equal(paymentsForOrder(store, ids.order480_id).length, 0);
  assert.equal(store.read("repair_orders.json", { orders: {} }).orders[ids.order480_id], undefined);
});

test("TF-024 Phase 3: doppeltes Stripe-Ereignis verarbeitet Bundle und Ledger nur einmal", () => {
  const { store } = fixture();
  createOfferIntentBundle(store, { ...ids, now });
  const st = { events: {}, static: {}, attempts: {}, sessions: {}, reviews: [] };
  const event = paymentEvent(ids.order150_id, 15000, "tf024-duplicate");
  assert.equal(processCheckoutEvent(store, st, event, { now }).result, "BOOKED");
  assert.equal(processCheckoutEvent(store, st, event, { now }).result, "DUPLICATE_EVENT");
  assert.equal(paymentsForOrder(store, ids.order150_id).length, 1);
});
