// TF-064 Tests – VN-Auftrag: Sicherheit der Order-Aktion (32 A–J), Übernahme auf dem VPS (Repair-Dienst, idempotent, Preis neu
// bestimmt), Zahlungs-Gate in VND und VN-Check-Workflow bis zur vietnamesischen Liefermail. Nur RAM-/Temp-Stores, Gmail-/Auditor-Attrappen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, makeReq, ENV } from "./tf063-helpers.js";
import { createStore } from "../mail-worker.js";
import { applyOrderRequest, syncOrderIntake, ORDER_INTAKE_FILE } from "../order-intake.js";
import { createCheck150Engine, CHECK150_ORDERS_FILE, publicCheck150Orders } from "../check-150-workflow.js";
import { REPAIR_ORDERS_FILE, publicRepairOrders } from "../repair-workflow.js";
import { recordPayment } from "../payments.js";
import { cleanCheck150, cleanRepair } from "../server-control.js";

const LAP_LEAD = "vn-cong-ty-1.vn";      // eigener VN-Lead mit E-Mail
const OWNER_LEAD = "vn-cong-ty-5.vn";
const order = (t, user, body) => t.sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies[user], body: { op: "order.createConfirmed", ...body } }));
const worker = (t, body, token = ENV.JARVIS_MAIL_WORKER_TOKEN) => t.sales(makeReq("/api/sales", { method: "POST", origin: null, headers: { "x-jarvis-worker": token }, body }));
const tmpStore = () => createStore(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-064-order-")));

test("TF-064 VN-Order A, D–J: Kudoshin eigener Lead → Auftrag (Server-Preis/-Währung/-Markt); Manipulation 400; Mario/Giuliano 403; Owner; Doppelbestellung", async () => {
  const t = await setup({ ch: 900, vn: 20 });
  // D/E/F: Client darf Preis/Währung/Markt/Kundendaten nicht senden.
  for (const extra of [{ price: 1 }, { currency: "CHF" }, { market: "CH" }, { domain: "evil.vn" }, { email: "x@evil.vn" }, { recipient: "x@evil.vn" }])
    assert.equal((await order(t, "Kudoshin", { lead_id: LAP_LEAD, offer: "CHECK", confirmed: true, ...extra })).status, 400, JSON.stringify(extra));
  assert.equal((await order(t, "Kudoshin", { lead_id: LAP_LEAD, offer: "PLUS", confirmed: true })).status, 400, "kein drittes Angebot");
  assert.equal((await order(t, "Kudoshin", { lead_id: LAP_LEAD, offer: "CHECK" })).status, 400, "ohne Kundenbestätigung kein Auftrag");
  // G/H: CH-Verkäufer dürfen keine VN-Aufträge.
  for (const u of ["mario", "giuliano", "damiano"]) assert.equal((await order(t, u, { lead_id: LAP_LEAD, offer: "CHECK", confirmed: true })).status, 403, u);
  // A: Kudoshin legt den Auftrag für den eigenen Lead an – alle Werte vom Server.
  const a = await t.json(await order(t, "Kudoshin", { lead_id: LAP_LEAD, offer: "CHECK", confirmed: true }));
  assert.equal(a.status, 202);
  assert.deepEqual([a.body.order.price, a.body.order.currency, a.body.order.market, a.body.order.offer_class, a.body.order.deposit, a.body.order.commission_expected],
    [990000, "VND", "VN", "VN_REPAIR_CHECK", 495000, "346500"]);
  const req = (await t.salesMem.orders.get()).state.requests[0];
  assert.deepEqual([req.domain, req.delivery_email, req.market, req.currency, req.price, req.seller_id, req.actor_user_id, req.status],
    [LAP_LEAD, `lienhe@${LAP_LEAD}`, "VN", "VND", 990000, "Kudoshin", "Kudoshin", "pending"]);
  // J: Doppelbestellung (offene Anfrage) verhindert – auch mit dem anderen Angebot.
  const dup = await t.json(await order(t, "Kudoshin", { lead_id: LAP_LEAD, offer: "FIX", confirmed: true }));
  assert.deepEqual([dup.status, dup.body.code], [409, "DUPLICATE_OPEN_ORDER"]);
  // DNC / ohne E-Mail → kein Auftrag.
  assert.equal((await t.json(await order(t, "Kudoshin", { lead_id: "vn-cong-ty-3.vn", offer: "CHECK", confirmed: true }))).body.code, "DO_NOT_CONTACT");
  assert.equal((await t.json(await order(t, "Kudoshin", { lead_id: "vn-cong-ty-2.vn", offer: "CHECK", confirmed: true }))).body.code, "NO_EMAIL");
  // I: Owner kann prüfen/verwalten (eigener Auftrag für einen VN-Lead, Verkäufer bleibt Kudoshin; Sicht auf alle VN-Aufträge).
  const o = await t.json(await order(t, "chris", { lead_id: OWNER_LEAD, offer: "FIX", confirmed: true }));
  assert.deepEqual([o.status, o.body.order.price, o.body.order.seller_id], [202, 3900000, "Kudoshin"]);
  const ov = await t.json(await t.sales(makeReq("/api/sales?view=orders", { cookie: t.cookies.chris })));
  assert.equal(ov.body.orders.length, 2);
  const lv = await t.json(await t.sales(makeReq(`/api/sales?view=orders&lead_id=${LAP_LEAD}`, { cookie: t.cookies.Kudoshin })));
  assert.equal(lv.body.orders.length, 1);
  assert.deepEqual(lv.body.offers.map((x) => [x.offer, x.price, x.currency]), [["CHECK", 990000, "VND"], ["FIX", 3900000, "VND"]]);
  assert.ok(!JSON.stringify(lv.body).includes("lienhe@"), "keine Kunden-E-Mail in der Verkäufer-Sicht");
  assert.equal((await t.sales(makeReq("/api/sales?view=orders", { cookie: t.cookies.mario }))).status, 403);
  // Zahlungen: keine Cloud-Operation – Kudoshin bekommt 403, auch Owner hat hier keinen Zahlungsweg.
  for (const op of ["payment.record", "payment.refund", "payment.void", "payment.markFull"]) {
    assert.equal((await t.sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies.Kudoshin, body: { op, order_id: "VNCHECK-20261015-abcdef", amount: 990000 } }))).status, 403, op);
    assert.equal((await t.sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies.chris, body: { op } }))).status, 400, `${op}: nicht über die Cloud`);
  }
});

test("TF-064 VN-Order B/C: Kudoshin mit CH-Lead oder fremder/unbekannter lead_id → 403; CSRF ohne Origin → 403", async () => {
  const t = await setup({ ch: 900, vn: 20 });
  assert.equal((await t.json(await order(t, "Kudoshin", { lead_id: "ch-firma-0001.ch", offer: "CHECK", confirmed: true }))).status, 403);
  assert.equal((await t.json(await order(t, "Kudoshin", { lead_id: "unbekannt-firma.vn", offer: "CHECK", confirmed: true }))).status, 403);
  assert.equal((await t.json(await order(t, "chris", { lead_id: "ch-firma-0001.ch", offer: "CHECK", confirmed: true }))).status, 403, "Owner: CH-Lead nicht über den VN-Weg");
  const r = await t.sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies.Kudoshin, origin: "https://evil.example", body: { op: "order.createConfirmed", lead_id: LAP_LEAD, offer: "CHECK", confirmed: true } }));
  assert.equal(r.status, 403);
  assert.equal((await t.salesMem.orders?.get())?.state?.requests?.length || 0, 0, "nichts angelegt");
});

test("TF-064 VPS-Übernahme: Repair-Dienst holt ab (Worker-Token), legt VNCHECK an, idempotent, meldet zurück; falscher Token 401", async () => {
  const t = await setup({ ch: 900, vn: 20 });
  assert.equal((await order(t, "Kudoshin", { lead_id: LAP_LEAD, offer: "CHECK", confirmed: true })).status, 202);
  assert.equal((await worker(t, { op: "orders.pull" }, "falsch".repeat(8))).status, 401);
  const store = tmpStore();
  const client = { pull: async () => (await (await worker(t, { op: "orders.pull" })).json()).requests, result: async (x) => (await worker(t, { op: "orders.result", ...x })).json() };
  const r = await syncOrderIntake({ dir: store.dir, client });
  assert.deepEqual([r.pulled, r.created, r.failed], [1, 1, 0]);
  const o = Object.values(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders)[0];
  assert.match(o.order_id, /^VNCHECK-\d{8}-[0-9a-f]{6}$/);
  assert.deepEqual([o.market, o.currency, o.price_amount, o.offer_class, o.domain, o.delivery_email, o.seller_id, o.lead_id, o.locale, o.state],
    ["VN", "VND", 990000, "VN_REPAIR_CHECK", LAP_LEAD, `lienhe@${LAP_LEAD}`, "Kudoshin", LAP_LEAD, "vi-VN", "ORDER_RECEIVED"]);
  const sale = store.read("sales.json", { records: {} }).records[LAP_LEAD].sale;
  assert.deepEqual([sale.selected_offer, sale.sale_value, sale.currency, sale.market, sale.source], ["VN_REPAIR_CHECK", 990000, "VND", "VN", "vn_sales_confirmed"]);
  const reqs = (await t.salesMem.orders.get()).state.requests;
  assert.deepEqual([reqs[0].status, reqs[0].order_id], ["done", o.order_id]);
  // Erneut abholen: nichts offen; Wiederholung derselben Anfrage (z. B. Lease-Ablauf) erzeugt kein Duplikat.
  assert.equal((await client.pull()).length, 0);
  const again = applyOrderRequest(store, { ...reqs[0], confirmed_at: reqs[0].created_at });
  assert.deepEqual([again.ok, again.duplicate, again.order_id], [true, true, o.order_id]);
  assert.equal(Object.keys(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders).length, 1);
  // Sicht für Kudoshin: Auftragsnummer + Status in VND.
  const lv = await t.json(await t.sales(makeReq(`/api/sales?view=orders&lead_id=${LAP_LEAD}`, { cookie: t.cookies.Kudoshin })));
  assert.equal(lv.body.orders[0].order_id, o.order_id);
  // Manipulierte Anfrage (Preis/Markt/Verkäufer) wird auf dem VPS nie angelegt.
  const base = { request_id: "11111111-2222-3333-4444-555555555555", lead_id: "x.vn", offer_class: "VN_REPAIR_FIX", market: "VN", currency: "VND", price: 3900000, domain: "x.vn", delivery_email: "a@x.vn", actor_user_id: "Kudoshin", seller_id: "Kudoshin" };
  assert.equal(applyOrderRequest(store, { ...base, price: 1 }).code, "PRICE_MISMATCH");
  assert.equal(applyOrderRequest(store, { ...base, currency: "CHF" }).code, "PRICE_MISMATCH");
  assert.equal(applyOrderRequest(store, { ...base, market: "CH" }).code, "BAD_MARKET");
  assert.equal(applyOrderRequest(store, { ...base, offer_class: "REPAIR_FIX_500", price: 480, currency: "CHF" }).code, "BAD_MARKET");
  assert.equal(applyOrderRequest(store, { ...base, actor_user_id: "mario" }).code, "BAD_ACTOR");
  const fix = applyOrderRequest(store, base);
  assert.ok(fix.ok && /^VNFIX-/.test(fix.order_id));
  const rf = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[fix.order_id];
  assert.deepEqual([rf.market, rf.currency, rf.price_amount, rf.payment.required, rf.price_chf], ["VN", "VND", 3900000, 1950000, undefined]);
  assert.equal(applyOrderRequest(store, { ...base, request_id: "11111111-2222-3333-4444-666666666666" }).code, "DUPLICATE_OPEN_ORDER");
  assert.ok(store.read(ORDER_INTAKE_FILE, {}).applied[base.request_id]);
  // Snapshot-Allowlist (Cloud) lässt VN-Aufträge mit Markt/Währung/Beträgen durch – nie Adressen.
  const pc = cleanCheck150(publicCheck150Orders(store.dir)).orders[0], pr = cleanRepair(publicRepairOrders(store.dir)).orders[0];
  assert.deepEqual([pc.order_id, pc.market, pc.currency, pc.price_amount, pc.payment_required_amount, pc.paid_chf], [o.order_id, "VN", "VND", 990000, 495000, null]);
  assert.deepEqual([pr.order_id, pr.market, pr.currency, pr.price_amount, pr.payment_required_amount], [fix.order_id, "VN", "VND", 3900000, 1950000]);
  assert.ok(!JSON.stringify([pc, pr]).includes("@"), "keine Kundenadressen im Snapshot");
});

test("TF-064 VN CHECK Workflow: wartet bis 495000 VND, danach vietnamesischer Bericht + Liefermail (kein CHF, kein Deutsch)", async () => {
  const store = tmpStore();
  const T0 = new Date("2026-10-15T09:00:00Z");
  const r = applyOrderRequest(store, { request_id: "aaaaaaaa-2222-3333-4444-555555555555", lead_id: "khach-san.vn", offer_class: "VN_REPAIR_CHECK", market: "VN", currency: "VND", price: 990000,
    domain: "khach-san.vn", website: "https://khach-san.vn/", company: "Khách sạn Sông Hàn", delivery_email: "lienhe@khach-san.vn", actor_user_id: "Kudoshin", seller_id: "Kudoshin" }, { now: T0 });
  assert.ok(r.ok);
  const HOME = "https://khach-san.vn/";
  const issues = [{ type: "broken_link", url: "https://khach-san.vn/phong-cu", page: HOME, label: "Phòng nghỉ", evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity: "medium", detectedAt: T0.toISOString() },
    { type: "broken_image", url: "https://khach-san.vn/img/a.jpg", page: HOME, evidence: `Bild liefert HTTP 404 (eingebunden auf ${HOME})`, severity: "medium", detectedAt: T0.toISOString() }];
  const auditor = { audit: async (w) => ({ website: w, host: "khach-san.vn", reachable: true, finalUrl: w, title: "KS", issues, pages: { home: "<html><body>x</body></html>" }, requests: 2 }) };
  const calls = [];
  const gmail = { createDraft: async (x) => { calls.push({ op: "create", ...x }); return { draftId: "d1", threadId: "t1" }; }, updateDraft: async () => ({}), sendDraft: async (id) => { calls.push({ op: "SEND", id }); return {}; } };
  const eng = createCheck150Engine({ store, gmail, auditor, now: () => T0 });
  await eng.processAll();
  const o1 = Object.values(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders)[0];
  assert.equal(o1.state, "BLOCKED_PAYMENT_NOT_RECEIVED");
  assert.match(o1.blocked_reason, /0 ₫ von mind\. 495\.000 ₫/);
  assert.equal(calls.length, 0, "vor der Schwelle nichts");
  recordPayment(store, { order_id: o1.order_id, amount: 494999, reference: "VCB a", now: T0 });
  await eng.processAll();
  assert.equal(Object.values(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders)[0].state, "BLOCKED_PAYMENT_NOT_RECEIVED", "494999 < 495000");
  recordPayment(store, { order_id: o1.order_id, amount: 1, reference: "VCB b", now: T0 });
  await eng.processAll();
  const o2 = Object.values(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders)[0];
  assert.equal(o2.state, "COMPLETED");
  const mail = calls.find((c) => c.op === "create");
  assert.equal(mail.to, "lienhe@khach-san.vn");
  assert.match(mail.subject, /^Kết quả kiểm tra website & hướng dẫn của anh\/chị – khach-san\.vn$/);
  for (const s of ["Kính gửi Khách sạn Sông Hàn,", "VẤN ĐỀ 1 —", "Cách khắc phục:", "Các bước:", "Kiểm tra lại sau đó:", "Trân trọng,\nLap\nHỗ trợ khách hàng Việt Nam\nHelvetic Webdesign\nhttps://lapvietnamese.netlify.app/", "«Phòng nghỉ»"])
    assert.ok(mail.body.includes(s), s);
  assert.ok(!/CHF|Franken/.test(mail.body), "kein CHF");
  assert.ok(!/\b(Sie|Ihre|Ihrer|Website-Check|Freundliche|Grüsse|Anleitung|Schritte|Problem|Hallo|und|der|die|das)\b/.test(mail.body), "keine deutschen Sätze");
  assert.equal(calls.filter((c) => c.op === "SEND").length, 1, "Service-Mail (bezahlt) genau einmal – Lab-Gmail");
});
