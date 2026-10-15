// TF-063 Tests – Provision 35 % (A–L): nur abgeschlossen UND voll bezahlt, Storno/Refund → REVERSED, nicht rückwirkend, Sicht je Rolle.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveLedger, ordersFromSnapshot, summarize, commissionMinor, fromMinor, overrideSeller, emptyLedger, MARKET_PRICING } from "../commission-ledger.js";
import { setup, makeReq } from "./tf063-helpers.js";

const T0 = new Date("2026-10-15T12:00:00Z"), later = (min) => new Date(+T0 + min * 60_000);
const order = (x) => ({ order_id: "RF480-20261016-aaaaaa", domain: "kunde.ch", offer_class: "REPAIR_FIX_500", price_chf: 480, paid_chf: 0, state: "ORDER_RECEIVED", payment_status: "UNPAID", created_at: later(5).toISOString(), ...x });
const snap = (...orders) => ({ repair: { orders: orders.filter((o) => o.order_id.startsWith("RF480")) }, check150: { orders: orders.filter((o) => o.order_id.startsWith("CA150")) } });
const seller = () => ({ seller_id: "mario", lead_id: "kunde.ch", source: "assignment" });
function run(orders, ledger = { ...emptyLedger(), eligible_from: T0.toISOString() }, now = later(60)) { return deriveLedger({ ledger, orders: ordersFromSnapshot(snap(...orders)), resolveSeller: seller, now }).ledger; }
const entry = (L) => Object.values(L.entries)[0];

test("TF-063 Provision A–D: Sale/Teilzahlung/offen/unbezahlt → PENDING, CHF 0 auszahlbar", () => {
  for (const o of [order({}), order({ paid_chf: 240, payment_status: "DEPOSIT_MET", state: "REPAIRING" }), order({ paid_chf: 480, payment_status: "PAID_FULL", state: "REPAIRING" }),
    order({ paid_chf: 240, payment_status: "DEPOSIT_MET", state: "COMPLETED" })]) {
    const e = entry(run([o]));
    assert.equal(e.status, "PENDING", `${o.state}/${o.payment_status}`);
    assert.equal(e.payable_minor, 0);
  }
});

test("TF-063 Provision E–G: COMPLETED(+MANUAL_ITEMS) + PAID_FULL → 35 %; CHF 150 → 52.50, CHF 480 → 168.00", () => {
  assert.equal(fromMinor(commissionMinor(15000, 3500)), "52.50");
  assert.equal(fromMinor(commissionMinor(48000, 3500)), "168.00");
  const e150 = entry(run([order({ order_id: "CA150-20261016-bbbbbb", offer_class: "REPAIR_CHECK_150", price_chf: 150, paid_chf: 150, payment_status: "PAID_FULL", state: "COMPLETED" })]));
  assert.equal(e150.status, "PAYABLE"); assert.equal(fromMinor(e150.payable_minor), "52.50");
  const e480 = entry(run([order({ paid_chf: 480, payment_status: "PAID_FULL", state: "COMPLETED" })]));
  assert.equal(fromMinor(e480.payable_minor), "168.00");
  const eMan = entry(run([order({ paid_chf: 480, payment_status: "PAID_FULL", state: "COMPLETED_WITH_MANUAL_ITEMS" })]));
  assert.equal(eMan.status, "PAYABLE"); assert.equal(eMan.seller_locked, true);
  // Überzahlung: keine Provision über dem Angebotspreis.
  const over = entry(run([order({ paid_chf: 600, payment_status: "PAID_FULL", state: "COMPLETED" })]));
  assert.equal(fromMinor(over.payable_minor), "168.00");
});

test("TF-063 Provision H/I: Storno → keine Provision; Refund nach PAYABLE → REVERSED, Historie bleibt", () => {
  const voided = entry(run([order({ state: "CANCELLED" })]));
  assert.equal(voided.status, "REVERSED"); assert.equal(voided.payable_minor, 0); assert.equal(voided.reversed_minor, 0);
  const L1 = run([order({ paid_chf: 480, payment_status: "PAID_FULL", state: "COMPLETED" })]);
  assert.equal(entry(L1).status, "PAYABLE");
  const L2 = run([order({ paid_chf: 0, payment_status: "REFUNDED", state: "COMPLETED" })], L1, later(120));
  const e = entry(L2);
  assert.equal(e.status, "REVERSED"); assert.equal(fromMinor(e.reversed_minor), "168.00"); assert.equal(e.payable_minor, 0);
  assert.deepEqual(e.history.map((h) => h.status), ["PAYABLE", "REVERSED"], "nichts gelöscht");
  // Deckung entfällt ohne Refund-Status (z. B. Zahlung storniert) → ebenfalls REVERSED.
  const L3 = run([order({ paid_chf: 240, payment_status: "DEPOSIT_MET", state: "COMPLETED" })], L1, later(120));
  assert.equal(entry(L3).status, "REVERSED");
  assert.equal(summarize(L2, ["mario"])[0].reversed, "168.00");
});

test("TF-063 Provision L: Aufträge vor TF-063 → keine automatische Provision; VN-Preise seit TF-064 konfiguriert (VND)", () => {
  const L = run([order({ created_at: later(-60).toISOString(), paid_chf: 480, payment_status: "PAID_FULL", state: "COMPLETED" })]);
  assert.equal(Object.keys(L.entries).length, 0);
  assert.equal(MARKET_PRICING.VN.configured, true); assert.equal(MARKET_PRICING.VN.currency, "VND");
  const fresh = deriveLedger({ ledger: null, orders: [], now: T0 }).ledger;
  assert.equal(fresh.eligible_from, T0.toISOString(), "Aktivierung = jetzt, nicht rückwirkend");
});

test("TF-063 Provision: Verkäufer vor Abschluss korrigierbar (auditiert), danach gesperrt", () => {
  let L = run([order({ state: "REPAIRING" })]);
  L = overrideSeller(L, { order_id: "RF480-20261016-aaaaaa", seller_id: "damiano", actor_user_id: "chris", now: later(70) });
  L = run([order({ paid_chf: 480, payment_status: "PAID_FULL", state: "COMPLETED" })], L, later(80));
  assert.equal(entry(L).seller_id, "damiano"); assert.equal(entry(L).status, "PAYABLE");
  assert.ok(L.audit.some((a) => a.action === "commission.set_seller"));
  assert.throws(() => overrideSeller(L, { order_id: "RF480-20261016-aaaaaa", seller_id: "mario", actor_user_id: "chris" }), /gesperrt/);
});

test("TF-063 Provision J/K: Verkäufer sieht nur eigene Provision, Chris alle (API)", async () => {
  const t = await setup();
  const mar = (await t.json(await t.crm(makeReq("/api/crm", { cookie: t.cookies.mario })))).body.leads[0];
  const giu = (await t.json(await t.crm(makeReq("/api/crm", { cookie: t.cookies.giuliano })))).body.leads[0];
  const created = new Date(Date.now() + 60_000).toISOString();
  // Ledger aktivieren, danach Aufträge (nach Aktivierung) im Snapshot.
  await t.sales(makeReq("/api/sales?view=commission", { cookie: t.cookies.chris }));
  await t.stores.control.set({ snapshot: snap(
    order({ order_id: "RF480-20261016-cccccc", domain: mar.domain, paid_chf: 480, payment_status: "PAID_FULL", state: "COMPLETED", created_at: created }),
    order({ order_id: "CA150-20261016-dddddd", domain: giu.domain, offer_class: "REPAIR_CHECK_150", price_chf: 150, paid_chf: 75, payment_status: "DEPOSIT_MET", state: "AUDITING", created_at: created })) }, (await t.stores.control.get()).etag);
  const later2 = new Date(Date.now() + 120_000);
  const t2 = { ...t };
  const { createSalesHandler } = await import("../sales-api.js");
  const sales = createSalesHandler({ env: (k) => ({ JARVIS_PASSWORD: "owner-legacy-pw-123" })[k], data: t.data, getSalesStore: async (k) => (t.salesMem[k] ||= (await import("../shared-state.js")).memoryStore()),
    getAuthStore: async () => (await import("../auth-core.js")).authStoreFrom((k) => t.authMem[k]), now: () => later2 });
  void t2;
  const m = await t.json(await sales(makeReq("/api/sales?view=commission", { cookie: t.cookies.mario })));
  assert.equal(m.status, 200);
  assert.equal(m.body.commission.payable, "168.00"); assert.equal(m.body.commission.paid_completed_orders, 1);
  assert.equal(m.body.sellers, undefined, "keine fremden Verkäufer");
  assert.ok(!JSON.stringify(m.body).includes("CA150-20261016-dddddd"), "Giulianos Auftrag unsichtbar");
  const g = await t.json(await sales(makeReq("/api/sales?view=commission", { cookie: t.cookies.giuliano })));
  assert.equal(g.body.commission.payable, "0.00"); assert.equal(g.body.commission.pending, "52.50");
  const l = await t.json(await sales(makeReq("/api/sales?view=commission", { cookie: t.cookies.lap })));
  assert.equal(l.body.commission.payable, "0"); assert.equal(l.body.commission.currency, "VND"); assert.equal(l.body.commission.orders.length, 0);
  const c = await t.json(await sales(makeReq("/api/sales?view=commission", { cookie: t.cookies.chris })));
  assert.equal(c.body.sellers.length, 4); assert.equal(c.body.totals.payable, "168.00"); assert.equal(c.body.pricing.VN, "CONFIGURED");
  assert.equal((await sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies.mario, body: { op: "commission.setSeller", order_id: "CA150-20261016-dddddd", seller_id: "mario" } }))).status, 403);
});
