// TF-034 – jeder CHF-480-Reparaturpfad verlangt die vollständig bestätigte Zahlung.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { recordPayment, refundPayment, fullPaymentGateForOrder } from "../payments.js";
import { CHECK150_ORDERS_FILE, createCheck150Order } from "../check-150-workflow.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, authorizeRepair, createRepairEngine } from "../repair-workflow.js";

const T0 = new Date("2026-10-27T10:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf034-pay-"));
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];

test("TF-034: Legacy-Reparaturpfad bleibt bei CHF 240 vollständig blockiert", async () => {
  const store = createStore(tmp());
  const order = createRepairOrder(store, { domain: "legacy-tf034.test", website: "https://legacy-tf034.test/", now: T0 });
  authorizeRepair(store, order.order_id, { authorized_domain: "legacy-tf034.test", source: "customer_order_form", now: T0 });
  recordPayment(store, { order_id: order.order_id, amount_chf: 240, reference: "tf034-deposit", now: T0 });
  const calls = { checkAccess: 0, backup: 0, applyFix: 0 };
  const adapter = {
    checkAccess: async () => { calls.checkAccess++; return { ok: true }; },
    backup: async () => { calls.backup++; return { backup_ref: "backup" }; },
    locate: async () => ({ target: "index.html", planned_change: "link" }),
    applyFix: async () => { calls.applyFix++; return { ok: true }; },
  };
  const engine = createRepairEngine({
    store,
    adapters: { static: adapter },
    auditor: { audit: async (website) => ({ website, reachable: true, finalUrl: website, issues: [], pages: { home: "<html></html>" } }) },
    now: () => T0,
  });
  await engine.processAll();
  const saved = readOrder(store, order.order_id);
  assert.equal(fullPaymentGateForOrder(store, saved).satisfied, false);
  assert.deepEqual(saved.payment, { order_id: order.order_id, offer_class: "REPAIR_FIX_500", required_chf: 480, paid_chf: 240, satisfied: false });
  assert.deepEqual(calls, { checkAccess: 0, backup: 0, applyFix: 0 });
});

test("TF-034: CHF-150 plus einmaliges CHF-330-Upgrade ergibt genau CHF 480; Rückerstattung entzieht die Freigabe", () => {
  const store = createStore(tmp());
  const source = createCheck150Order(store, { domain: "upgrade-tf034.test", website: "https://upgrade-tf034.test/", delivery_email: "kunde@upgrade-tf034.test", now: T0 });
  const sourcePayment = recordPayment(store, { order_id: source.order_id, amount_chf: 150, reference: "tf034-check-full", now: T0 });
  const repair = createRepairOrder(store, { domain: "upgrade-tf034.test", website: "https://upgrade-tf034.test/", now: T0 });
  const repairs = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  repairs.orders[repair.order_id].source_check_order_id = source.order_id;
  store.write(REPAIR_ORDERS_FILE, repairs);
  const boundRepair = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[repair.order_id];
  recordPayment(store, { order_id: repair.order_id, amount_chf: 330, reference: "tf034-upgrade", now: T0 });
  assert.deepEqual(fullPaymentGateForOrder(store, boundRepair), { order_id: repair.order_id, offer_class: "REPAIR_FIX_500", required_chf: 480, paid_chf: 480, satisfied: true });
  assert.throws(() => recordPayment(store, { order_id: repair.order_id, amount_chf: 330, reference: " TF034-UPGRADE ", now: T0 }), /Doppelte Zahlungsreferenz/);
  refundPayment(store, sourcePayment.payment_id, { reason: "synthetische Rückerstattung", now: T0 });
  assert.equal(fullPaymentGateForOrder(store, boundRepair).satisfied, false);
  assert.equal(fullPaymentGateForOrder(store, boundRepair).paid_chf, 330);
  assert.ok(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[source.order_id]);
});
