// TF-086 – CRM: Test-Aufträge (CHF 150 + CHF 480) behalten TEST-Kennzeichen von der Quelle bis in die Cloud-Whitelist,
// zählen nie als offen/Umsatz/Verkauf/Provision; Zahlungsanzeige (CHF 150 / PAID_FULL) bleibt korrekt. Nur Fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { createCheck150Order, publicCheck150Orders, check150Status } from "../check-150-workflow.js";
import { createContactFormRepairOrder, createConfirmedRepairOrder, publicRepairOrders, repairOrdersStatus } from "../repair-workflow.js";
import { cleanCheck150, cleanRepair } from "../server-control.js";
import { deriveLedger, ordersFromSnapshot, emptyLedger } from "../commission-ledger.js";

const T0 = new Date("2026-10-19T12:00:00Z");
const E2E = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "jarvis-sandbox.ch", JARVIS_E2E_TEST_MAILBOXES: "e2e@helvetic-test.ch" };
const RUN = "e2e-0123456789ab";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf086-")); return { dir, store: createStore(dir) }; };
const pay = (store, o, amount, mode, ref) => recordPayment(store, { order_id: o.order_id, amount, currency: "CHF", source: mode === "TEST" ? "stripe_test_payment_link" : "stripe_payment_link", reference: ref, provider_mode: mode, now: T0 });
function fixtures() {
  const { dir, store } = env();
  const t150 = createCheck150Order(store, { domain: "jarvis-sandbox.ch", delivery_email: "e2e@helvetic-test.ch", test: { run_id: RUN }, env: E2E, now: T0 });
  const l150 = createCheck150Order(store, { domain: "kunde-check.ch", delivery_email: "k@kunde-check.ch", now: T0 });
  const t480 = createContactFormRepairOrder(store, { domain: "jarvis-sandbox.ch", delivery_email: "e2e@helvetic-test.ch", contact_form_key: "cf:" + "a".repeat(24), confirmed_at: T0.toISOString(), test: { run_id: RUN }, now: T0 });
  const l480 = createConfirmedRepairOrder(store, { domain: "muster-garage.ch", delivery_email: "anna@muster-garage.ch", contact_name: "Anna Muster", now: T0 });
  pay(store, t150, 150, "TEST", "stripe:pi_t150");
  pay(store, t480, 480, "TEST", "stripe:pi_t480");
  return { dir, store, t150, l150, t480, l480 };
}
const snapshot = (dir) => ({ check150: cleanCheck150(publicCheck150Orders(dir)), repair: cleanRepair(publicRepairOrders(dir)) });

test("CHF 150: TEST-Kennzeichen, Satz 0 und Zahlung (CHF 150 / PAID_FULL) überstehen die Whitelist; Live-Auftrag bleibt LIVE", () => {
  const { dir, t150, l150 } = fixtures();
  const c = snapshot(dir).check150, t = c.orders.find((o) => o.order_id === t150.order_id), l = c.orders.find((o) => o.order_id === l150.order_id);
  assert.equal(t.test_order, true); assert.equal(t.environment, "TEST"); assert.equal(t.commission_rate_bps, 0);
  assert.equal(t.paid_chf, 150); assert.equal(t.payment_status, "PAID_FULL"); assert.equal(t.price_chf, 150);
  assert.equal(l.test_order, false); assert.equal(l.environment, "LIVE"); assert.equal(l.paid_chf, 0); assert.equal(l.payment_status, "UNPAID");
  assert.ok(l.commission_rate_bps > 0, "Live-Auftrag behält seinen gespeicherten Satz (> 0), nie 0");
});

test("CHF 480: gleiches Verhalten (TEST-Kennzeichen, CHF 480 / PAID_FULL), kein Vermischen mit CHF 150", () => {
  const { dir, t480, l480 } = fixtures();
  const r = snapshot(dir).repair, t = r.orders.find((o) => o.order_id === t480.order_id), l = r.orders.find((o) => o.order_id === l480.order_id);
  assert.equal(t.test_order, true); assert.equal(t.environment, "TEST"); assert.equal(t.paid_chf, 480); assert.equal(t.payment_status, "PAID_FULL"); assert.equal(t.price_chf, 480);
  assert.equal(l.test_order, false); assert.equal(l.environment, "LIVE");
  assert.ok(snapshot(dir).check150.orders.every((o) => o.order_id.startsWith("CA150")) && r.orders.every((o) => o.order_id.startsWith("RF480")));
});

test("Zähler: Testaufträge sind nie «offen» und nie in den Zustandskacheln; separat als test_orders", () => {
  const { dir } = fixtures();
  const c = check150Status(dir), r = repairOrdersStatus(dir);
  assert.equal(c.open, 1); assert.equal(c.total, 1); assert.equal(c.test_orders, 1);
  assert.equal(Object.values(c.states).reduce((a, b) => a + b, 0), 1, "Zustände nur über Live-Aufträge");
  assert.equal(r.open_live, 1); assert.equal(r.test_orders, 1); assert.ok(r.open >= r.open_live);
  const s = snapshot(dir);
  assert.equal(s.check150.open, 1); assert.equal(s.check150.test_orders, 1); assert.equal(s.repair.open_live, 1); assert.equal(s.repair.test_orders, 1);
});

test("Provision: Testaufträge (CHF 150 + 480) erzeugen nach der Whitelist nie einen Provisionseintrag; Live-Aufträge schon", () => {
  const { dir, t150, t480, l150 } = fixtures();
  const orders = ordersFromSnapshot(snapshot(dir));
  const { ledger } = deriveLedger({ ledger: { ...emptyLedger(), eligible_from: new Date(+T0 - 86_400_000).toISOString() }, orders, resolveSeller: (o) => ({ seller_id: "mario", lead_id: o.domain, source: "assignment" }), now: new Date(+T0 + 3_600_000) });
  assert.equal(ledger.entries[t150.order_id], undefined); assert.equal(ledger.entries[t480.order_id], undefined);
  assert.ok(ledger.entries[l150.order_id], "Live-Auftrag bleibt provisionsfähig");
});

test("Regression: ohne durchgereichtes Flag wäre der CHF-150-Testauftrag ein Provisions-Kandidat gewesen (Beleg für den TF-086-Fehler)", () => {
  const { dir, t150 } = fixtures();
  const raw = publicCheck150Orders(dir).orders.find((o) => o.order_id === t150.order_id);
  const { test_order, environment, ...stripped } = raw; // alter Stand: Whitelist verlor beide Felder
  const orders = ordersFromSnapshot({ check150: { orders: [stripped] } });
  assert.equal(orders.length, 1, "ohne Flag wird er als echter Auftrag übernommen");
  assert.equal(ordersFromSnapshot({ check150: { orders: [raw] } }).length, 0, "mit Flag nie");
});

test("Whitelist-Härtung: commission_rate_bps 0 erlaubt, negative/gebrochene/zu grosse Werte → null; Test-Flag nicht fälschbar durch Strings", () => {
  const base = { order_id: "CA150-20261019-aaaaaa", offer_class: "REPAIR_CHECK_150", state: "ORDER_CONFIRMED" };
  const one = (extra) => cleanCheck150({ orders: [{ ...base, ...extra }] }).orders[0];
  assert.equal(one({ commission_rate_bps: 0 }).commission_rate_bps, 0);
  for (const bad of [-1, 1.5, 10_001, "0", null]) assert.equal(one({ commission_rate_bps: bad }).commission_rate_bps, null);
  assert.equal(one({ test_order: "true" }).test_order, false); assert.equal(one({ environment: "TEST" }).test_order, true);
});

test("Dashboard: public/index.html zeigt TEST-Abzeichen für beide Listen und zählt Reparatur-«Offen» ohne Tests", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.equal((html.match(/o\.test_order === true \? "TEST · " : ""/g) || []).length, 2);
  assert.match(html, /rep\.open_live \?\? rep\.open/);
});
