// TF-064 Tests – zentrale Preisquelle (29 A–H) und währungsfähige Minor Units / Zahlungsbindung (30 A–G).
// Keine echten Daten, keine Zahlungen im echten Ledger: isolierte Temp-Stores.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pricing from "../pricing.js";
import { MARKET_PRICES, offerFor, offerInfo, OFFER_CLASS_IDS, exponentOf, toMinor, minorString, formatMoney, depositOf, ORDER_ID_RE, offerOfOrderId, orderMoney } from "../pricing.js";
import { OFFERS } from "../sales.js";
import { createStore } from "../mail-worker.js";
import { createCheck150Order } from "../check-150-workflow.js";
import { createRepairOrder } from "../repair-workflow.js";
import { recordPayment, paidAmount, paidChf, paymentGateForOrder, paymentSummary, paymentThreshold, paymentThresholdChf, PAYMENTS_FILE } from "../payments.js";

const T0 = new Date("2026-10-15T09:00:00Z");
let store;
beforeEach(() => { store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-064-price-"))); });
const chCheck = () => createCheck150Order(store, { domain: "muster.ch", company: "Muster AG", delivery_email: "auftrag@muster.ch", now: T0 });
const vnCheck = () => createCheck150Order(store, { domain: "cong-ty-a.vn", company: "Công ty A", delivery_email: "lienhe@cong-ty-a.vn", offer_class: "VN_REPAIR_CHECK", now: T0 });
const vnFix = () => createRepairOrder(store, { domain: "cong-ty-b.vn", company: "Công ty B", delivery_email: "lienhe@cong-ty-b.vn", offer_class: "VN_REPAIR_FIX", now: T0 });

test("TF-064 Pricing A–D: CH CHECK CHF 150 · CH FIX CHF 480 · VN CHECK 990000 VND · VN FIX 3900000 VND", () => {
  assert.deepEqual([offerFor("CH", "CHECK").price, offerFor("CH", "CHECK").currency, offerFor("CH", "CHECK").offer_class], [150, "CHF", "REPAIR_CHECK_150"]);
  assert.deepEqual([offerFor("CH", "FIX").price, offerFor("CH", "FIX").currency, offerFor("CH", "FIX").offer_class], [480, "CHF", "REPAIR_FIX_500"]);
  assert.deepEqual([offerFor("VN", "CHECK").price, offerFor("VN", "CHECK").currency, offerFor("VN", "CHECK").offer_class], [990000, "VND", "VN_REPAIR_CHECK"]);
  assert.deepEqual([offerFor("VN", "FIX").price, offerFor("VN", "FIX").currency, offerFor("VN", "FIX").offer_class], [3900000, "VND", "VN_REPAIR_FIX"]);
  // CH unverändert und Schweizer OFFERS speisen sich aus derselben Quelle (keine Duplikat-Preisliste).
  assert.equal(OFFERS.REPAIR_CHECK_150.price, 150); assert.equal(OFFERS.REPAIR_FIX_500.price, 480);
  assert.equal(offerFor("VN", "CHECK").name_vi, "Kiểm tra website & hướng dẫn sửa lỗi");
  assert.equal(offerFor("VN", "FIX").name_vi, "Kiểm tra & sửa lỗi website");
  // Interne IDs nicht an Preiszahlen gekoppelt (VN).
  assert.ok(!/\d/.test(offerFor("VN", "CHECK").offer_class) && !/\d/.test(offerFor("VN", "FIX").offer_class));
});

test("TF-064 Pricing E/F: Schwelle 50 % – VN CHECK 495000, VN FIX 1950000 (CH weiterhin 75 / 240)", () => {
  assert.equal(offerFor("VN", "CHECK").deposit, 495000); assert.equal(paymentThreshold("VN_REPAIR_CHECK"), 495000);
  assert.equal(offerFor("VN", "FIX").deposit, 1950000); assert.equal(paymentThreshold("VN_REPAIR_FIX"), 1950000);
  assert.equal(paymentThresholdChf("REPAIR_CHECK_150"), 75); assert.equal(paymentThresholdChf("REPAIR_FIX_500"), 240);
  assert.equal(paymentThresholdChf("VN_REPAIR_CHECK"), null, "keine CHF-Schwelle für VN");
  assert.equal(depositOf(990000, "VND"), 495000);
});

test("TF-064 Pricing G/H: keine CHF→VND-Umrechnung, kein Wechselkurs, genau zwei Angebote je Markt", () => {
  const names = Object.keys(pricing).join(" ");
  assert.ok(!/rate|exchange|convert|fx/i.test(names), `keine Umrechnungs-Exporte: ${names}`);
  assert.ok(!/exchange|wechselkurs|convert/i.test(fs.readFileSync(new URL("../pricing.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")), "kein Umrechnungscode");
  assert.deepEqual(Object.keys(MARKET_PRICES).sort(), ["CH", "VN"]);
  for (const m of ["CH", "VN"]) assert.deepEqual(Object.keys(MARKET_PRICES[m].offers), ["CHECK", "FIX"]);
  assert.equal(OFFER_CLASS_IDS.length, 4, "kein drittes Angebot");
  assert.equal(offerFor("VN", "PLUS"), null);
  assert.equal(offerInfo("VN_REPAIR_CHECK").price / offerInfo("REPAIR_CHECK_150").price !== 0, true);
  assert.notEqual(offerInfo("VN_REPAIR_CHECK").price, 150 * 1000, "VN-Preis ist fest, nicht aus CHF abgeleitet");
});

test("TF-064 Currency A–D: CHF Exponent 2, VND Exponent 0, 990000 VND intern 990000, Anzeige ohne .00", () => {
  assert.equal(exponentOf("CHF"), 2); assert.equal(exponentOf("VND"), 0);
  assert.equal(toMinor(150, "CHF"), 15000);
  assert.equal(toMinor(990000, "VND"), 990000); assert.notEqual(toMinor(990000, "VND"), 99000000);
  assert.equal(minorString(990000, "VND"), "990000"); assert.equal(minorString(5250, "CHF"), "52.50");
  assert.equal(formatMoney(990000, "VND"), "990.000 ₫"); assert.equal(formatMoney(3900000, "VND"), "3.900.000 ₫");
  assert.equal(formatMoney(150, "CHF"), "CHF 150.00");
  assert.ok(!/990000\.00|,00|\.\d{2} ₫$/.test(formatMoney(990000, "VND")), "keine Nachkommastellen");
});

test("TF-064 Currency E: CHF-Altbestände (amount_chf ohne currency) bleiben korrekt; neue CH-Aufträge im alten Format", () => {
  const o = chCheck();
  assert.deepEqual([o.order_id.slice(0, 5), o.price_chf, o.currency, o.market, o.payment.required_chf], ["CA150", 150, "CHF", undefined, 75]);
  // Legacy-Eintrag wie vor TF-064 (nur amount_chf/currency CHF).
  store.write(PAYMENTS_FILE, { schema: 1, payments: { "PAY-OLD": { payment_id: "PAY-OLD", order_id: o.order_id, amount_chf: 80, currency: "CHF", status: "RECEIVED", created_at: T0.toISOString() } } });
  assert.equal(paidChf(store, o.order_id), 80);
  assert.deepEqual(paymentGateForOrder(store, o), { order_id: o.order_id, offer_class: "REPAIR_CHECK_150", required_chf: 75, paid_chf: 80, satisfied: true });
  const s = paymentSummary(store, o);
  assert.deepEqual([s.price_chf, s.deposit_chf, s.paid_chf, s.payment_status, s.currency], [150, 75, 80, "DEPOSIT_MET", "CHF"]);
  const p = recordPayment(store, { order_id: o.order_id, amount_chf: 70, reference: "Bank 2", now: T0 });
  assert.deepEqual([p.amount_chf, p.amount, p.currency], [70, 70, "CHF"]);
  assert.equal(paymentSummary(store, o).payment_status, "PAID_FULL");
});

test("TF-064 Currency F/G: VND-Zahlung nie auf CH-Auftrag, CHF-Zahlung nie auf VN-Auftrag; VN-Ledger in VND", () => {
  const ch = chCheck(), vn = vnCheck(), fx = vnFix();
  assert.ok(ORDER_ID_RE.test(vn.order_id) && vn.order_id.startsWith("VNCHECK-") && fx.order_id.startsWith("VNFIX-"));
  assert.equal(offerOfOrderId(vn.order_id).offer_class, "VN_REPAIR_CHECK");
  assert.deepEqual([vn.market, vn.currency, vn.price_amount, vn.price_chf, vn.payment.required], ["VN", "VND", 990000, undefined, 495000]);
  assert.deepEqual([fx.market, fx.currency, fx.price_amount, fx.payment.required], ["VN", "VND", 3900000, 1950000]);
  assert.throws(() => recordPayment(store, { order_id: ch.order_id, amount: 495000, currency: "VND", reference: "x1", now: T0 }), /Nur CHF/);
  assert.throws(() => recordPayment(store, { order_id: vn.order_id, amount: 75, currency: "CHF", reference: "x2", now: T0 }), /Nur VND/);
  assert.throws(() => recordPayment(store, { order_id: vn.order_id, amount: 1000.5, currency: "VND", reference: "x3", now: T0 }), /Betrag/, "VND ohne Unterteilung");
  const p = recordPayment(store, { order_id: vn.order_id, amount: 495000, reference: "VCB 1", now: T0 });
  assert.deepEqual([p.amount, p.currency, p.amount_chf, p.market], [495000, "VND", undefined, "VN"]);
  assert.equal(paidAmount(store, vn.order_id, "VND"), 495000);
  assert.equal(paidChf(store, vn.order_id), 0, "VND zählt nie als CHF");
  const g = paymentGateForOrder(store, vn);
  assert.deepEqual([g.currency, g.required, g.paid, g.satisfied, g.paid_chf], ["VND", 495000, 495000, true, undefined]);
  assert.equal(paymentSummary(store, vn).payment_status, "DEPOSIT_MET");
  recordPayment(store, { order_id: vn.order_id, amount: 495000, reference: "VCB 2", now: T0 });
  assert.equal(paymentSummary(store, vn).payment_status, "PAID_FULL");
  // VN-Auftrag ohne explizite Währung → nie stilles CHF (fail closed).
  assert.equal(orderMoney({ order_id: vn.order_id, offer_class: "VN_REPAIR_CHECK" }), null);
  assert.equal(orderMoney({ order_id: ch.order_id, offer_class: "REPAIR_CHECK_150" }).currency, "CHF");
});
