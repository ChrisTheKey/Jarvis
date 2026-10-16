// TF-064 Tests – Provision Kudoshin (35 % = 3500 bps) in VND, market-aware Ledger, getrennte Summen je Währung (31 A–H).
import test from "node:test";
import assert from "node:assert/strict";
import { deriveLedger, ordersFromSnapshot, summarize, totalsByCurrency, emptyLedger, MARKET_PRICING, commissionMinor } from "../commission-ledger.js";
import { memoryStore } from "../shared-state.js";
import { setup, makeReq } from "./tf063-helpers.js";

const T0 = new Date("2026-10-15T12:00:00Z"), later = (min) => new Date(+T0 + min * 60_000);
const vn = (x) => ({ order_id: "VNCHECK-20261016-aaaaaa", domain: "vn-cong-ty-1.vn", offer_class: "VN_REPAIR_CHECK", market: "VN", currency: "VND", price_amount: 990000,
  paid_amount: 0, state: "ORDER_CONFIRMED", payment_status: "UNPAID", created_at: later(5).toISOString(), ...x });
const vnFix = (x) => vn({ order_id: "VNFIX-20261016-bbbbbb", offer_class: "VN_REPAIR_FIX", price_amount: 3900000, ...x });
const snap = (...orders) => ({ repair: { orders: orders.filter((o) => /^(RF480|VNFIX)/.test(o.order_id)) }, check150: { orders: orders.filter((o) => /^(CA150|VNCHECK)/.test(o.order_id)) } });
const lap = () => ({ seller_id: "Kudoshin", lead_id: "vn-cong-ty-1.vn", source: "vn_default" });
const run = (orders, ledger = { ...emptyLedger(), eligible_from: T0.toISOString() }, now = later(60)) => deriveLedger({ ledger, orders: ordersFromSnapshot(snap(...orders)), resolveSeller: lap, now }).ledger;
const entry = (L) => Object.values(L.entries)[0];

test("TF-064 Provision A/B: VN CHECK/FIX abgeschlossen + PAID_FULL → Kudoshin PAYABLE 346500 / 1365000 VND (aus Preis × 3500 bps)", () => {
  assert.equal(MARKET_PRICING.VN.configured, true); assert.equal(MARKET_PRICING.VN.currency, "VND");
  const a = entry(run([vn({ state: "COMPLETED", payment_status: "PAID_FULL", paid_amount: 990000 })]));
  assert.deepEqual([a.status, a.currency, a.market, a.seller_id, a.rate_bps, a.payable_minor, a.price_minor], ["PAYABLE", "VND", "VN", "Kudoshin", 3500, 346500, 990000]);
  assert.equal(a.payable_minor, commissionMinor(990000, 3500));
  const b = entry(run([vnFix({ state: "COMPLETED_WITH_MANUAL_ITEMS", payment_status: "PAID_FULL", paid_amount: 3900000 })]));
  assert.deepEqual([b.status, b.payable_minor], ["PAYABLE", 1365000]);
  const s = summarize(run([vn({ state: "COMPLETED", payment_status: "PAID_FULL", paid_amount: 990000 })]), ["Kudoshin"])[0];
  assert.deepEqual([s.currency, s.payable, s.orders[0].commission, s.orders[0].price], ["VND", "346500", "346500", "990000"]);
});

test("TF-064 Provision C–E: nur Anzahlung / abgeschlossen ohne PAID_FULL / PAID_FULL ohne Abschluss → PENDING", () => {
  for (const o of [vn({ state: "FULL_AUDIT", payment_status: "DEPOSIT_MET", paid_amount: 495000 }), vn({ state: "COMPLETED", payment_status: "DEPOSIT_MET", paid_amount: 495000 }),
    vn({ state: "REPORT_FAILED", payment_status: "PAID_FULL", paid_amount: 990000 }), vnFix({ state: "REPAIRING", payment_status: "PAID_FULL", paid_amount: 3900000 })]) {
    const e = entry(run([o]));
    assert.equal(e.status, "PENDING", `${o.state}/${o.payment_status}`); assert.equal(e.payable_minor, 0);
  }
});

test("TF-064 Provision F: Refund nach PAYABLE → REVERSED (VND), Historie bleibt; VN ohne market/currency wird ignoriert", () => {
  const L1 = run([vn({ state: "COMPLETED", payment_status: "PAID_FULL", paid_amount: 990000 })]);
  const L2 = run([vn({ state: "COMPLETED", payment_status: "REFUNDED", paid_amount: 0 })], L1, later(120));
  const e = entry(L2);
  assert.deepEqual([e.status, e.reversed_minor, e.payable_minor], ["REVERSED", 346500, 0]);
  assert.ok(e.history.some((h) => h.status === "PAYABLE") && e.history.at(-1).status === "REVERSED");
  assert.equal(summarize(L2, ["Kudoshin"])[0].reversed, "346500");
  // Fail closed: VN-Auftrag ohne explizites market/currency → kein Eintrag (nie blind CH/CHF).
  assert.equal(ordersFromSnapshot(snap(vn({ market: undefined }), vn({ order_id: "VNCHECK-20261016-cccccc", currency: undefined }))).length, 0);
  assert.equal(ordersFromSnapshot(snap({ order_id: "CA150-20261016-dddddd", offer_class: "REPAIR_CHECK_150", price_chf: 150, paid_chf: 150, state: "COMPLETED", payment_status: "PAID_FULL", created_at: later(5).toISOString() }))[0].currency, "CHF", "Legacy CH ohne Felder → CH/CHF");
});

test("TF-064 Provision G/H: Chris summiert CHF und VND getrennt; Kudoshin sieht nur eigene VND-Provision (API)", async () => {
  const t = await setup({ ch: 900, vn: 20 });
  t.salesMem.commissions = memoryStore({ ...emptyLedger(), eligible_from: "2026-01-01T00:00:00Z" });
  const asg = (await t.salesMem.assignments.get()).state;
  const marioLead = Object.entries(asg.assignments).find(([, a]) => a.assigned_user_id === "mario")[0];
  const created = new Date(Date.now() - 60_000).toISOString();
  const { etag } = await t.stores.control.get();
  await t.stores.control.set({ snapshot: snap(
    { order_id: "RF480-20261016-aaaaaa", domain: marioLead, offer_class: "REPAIR_FIX_500", price_chf: 480, paid_chf: 480, state: "COMPLETED", payment_status: "PAID_FULL", created_at: created },
    vn({ domain: "vn-cong-ty-1.vn", state: "COMPLETED", payment_status: "PAID_FULL", paid_amount: 990000, created_at: created })), snapshot_at: new Date().toISOString() }, etag);
  const c = await t.json(await t.sales(makeReq("/api/sales?view=commission", { cookie: t.cookies.chris })));
  assert.equal(c.status, 200);
  assert.deepEqual([c.body.totals_by_currency.CHF.payable, c.body.totals_by_currency.VND.payable], ["168.00", "346500"]);
  assert.equal(c.body.totals.payable, "168.00", "Legacy-Gesamt nur CHF – keine gemischte Summe");
  assert.equal(c.body.pricing.VN, "CONFIGURED");
  const lapRow = c.body.sellers.find((s) => s.seller_id === "Kudoshin");
  assert.deepEqual([lapRow.currency, lapRow.payable], ["VND", "346500"]);
  assert.equal(c.body.sellers.find((s) => s.seller_id === "mario").currency, "CHF");
  assert.deepEqual(totalsByCurrency({ entries: { a: { seller_id: "Kudoshin", currency: "VND", status: "PAYABLE", payable_minor: 1 }, b: { seller_id: "mario", currency: "CHF", status: "PAYABLE", payable_minor: 100 } } }).CHF.payable, "1.00");
  const l = await t.json(await t.sales(makeReq("/api/sales?view=commission", { cookie: t.cookies.Kudoshin })));
  assert.deepEqual([l.body.commission.currency, l.body.commission.payable, l.body.commission.orders.length], ["VND", "346500", 1]);
  assert.ok(!JSON.stringify(l.body).includes("CHF") && !JSON.stringify(l.body).includes("RF480"), "Kudoshin: keine CHF-Anzeige, keine fremden Aufträge");
  assert.equal(l.body.sellers, undefined);
});
