// TF-070 Tests – Konto «lap» → «Kudoshin» (kein neuer Verkäufer): Login, Passwort-Übernahme, RBAC/Scope, andere Benutzer unverändert,
// Calling-Berechtigung, Verkäufe/Auftragsanfragen, Provisionen/Auszahlungen, Rückrufe/Kampagnen/Anrufe, CRM-/Mail-Aufträge, Idempotenz.
// Alles RAM/Temp – keine echten Anrufe, Zahlungen, Mails oder Websites.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, makeReq, cookieOf, CONTROL, env, PW } from "./tf063-helpers.js";
import { memoryStore } from "../shared-state.js";
import { authStoreFrom, USERS, SELLER_IDS, publicUser, userIdOf, actorFor } from "../auth-core.js";
import { createAuthHandler } from "../auth-api.js";
import { createSalesHandler } from "../sales-api.js";
import { createCrmHandler } from "../crm-api.js";
import { createMailRequestHandler } from "../mail-requests.js";
import { createCallingHandler, callingAgentToken, canStartCalls, canUseCalling } from "../calling-api.js";
import { sellerOf, canSeeLead, VN_SELLER } from "../sales-scope.js";
import { deriveLedger, ordersFromSnapshot, emptyLedger, RATE_BPS, CURRENCY_OF_SELLER, SELLERS } from "../commission-ledger.js";
import { applyOrderRequest } from "../order-intake.js";
import { createStore } from "../mail-worker.js";
import { senderProfileFor } from "../sender-profiles.js";
import { VN_SELLER_ID, LEGACY_VN_SELLER_ID, canonicalSellerId, migrateAuthUsers, migrateAuthSessions, migrateLedger, migrateOrderRequests,
  migrateCallingControl, migrateCallingHistory, migrateCrmQueue, migrateMailQueue } from "../seller-identity.js";

const K = "Kudoshin";
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

// Produktionsstand VOR der Migration nachbilden: Kudoshin-Datensätze zurück auf «lap» setzen (gleicher Passwort-Hash).
function toLegacyUsers(authMem) {
  const doc = structuredClone(authMem.users.peek());
  doc.users.lap = doc.users[K]; delete doc.users[K];
  return doc;
}

test("TF-070 Konstanten: kanonische ID Kudoshin, Rolle SALES_AGENT_VN, vi-VN, VN, 60 % (TF-072); «lap» kein Benutzer/Verkäufer", () => {
  assert.equal(VN_SELLER_ID, "Kudoshin"); assert.equal(LEGACY_VN_SELLER_ID, "lap");
  assert.deepEqual(publicUser(K), { user_id: K, name: K, role: "SALES_AGENT_VN", locale: "vi-VN", markets: ["VN"], commission_rate_bps: 6000 });
  assert.equal(publicUser("lap"), null); assert.equal(actorFor("lap"), null);
  assert.ok(!Object.hasOwn(USERS, "lap") && !SELLER_IDS.includes("lap") && !SELLERS.includes("lap"));
  assert.deepEqual(SELLER_IDS, ["giuliano", "mario", "damiano", K]);
  assert.equal(userIdOf("Kudoshin"), K); assert.equal(userIdOf("kudoshin"), K); assert.equal(userIdOf("lap"), null); assert.equal(userIdOf("Lap"), null);
  assert.equal(VN_SELLER, K); assert.equal(RATE_BPS[K], 6000); assert.equal(CURRENCY_OF_SELLER[K], "VND");
  assert.equal(canonicalSellerId("lap"), K); assert.equal(canonicalSellerId("mario"), "mario");
  // Andere Benutzer exakt unverändert.
  assert.deepEqual(publicUser("chris"), { user_id: "chris", name: "Chris", role: "OWNER", locale: "de-CH", markets: ["CH", "VN"], commission_rate_bps: 0 });
  assert.deepEqual(publicUser("giuliano"), { user_id: "giuliano", name: "Giuliano", role: "SALES_MANAGER_CH", locale: "de-CH", markets: ["CH"], commission_rate_bps: 6000 });
  assert.deepEqual(publicUser("mario"), { user_id: "mario", name: "Mario", role: "SALES_AGENT_CH", locale: "de-CH", markets: ["CH"], commission_rate_bps: 6000 });
  assert.deepEqual(publicUser("damiano"), { user_id: "damiano", name: "Damiano", role: "SALES_AGENT_CH", locale: "de-CH", markets: ["CH"], commission_rate_bps: 6000 });
  // Kundensichtbare Persona/Signatur bleibt; VN-Profil auch über die Konto-ID Kudoshin.
  assert.equal(senderProfileFor({ actor_user_id: K, market: "CH" }).id, "vn");
  assert.equal(senderProfileFor({ actor_user_id: "lap", market: "CH" }).id, "ch");
});

test("TF-070 Login: Migration übernimmt den Passwort-Hash von «lap» → Kudoshin gültig, «lap» abgelehnt, alte «lap»-Sitzung ungültig, idempotent", async () => {
  const t = await setup({ ch: 20, vn: 6 });
  const hashBefore = structuredClone(t.authMem.users.peek().users[K].password);
  // Vorher-Zustand: users.lap mit Hash, Kudoshin fehlt, eine «lap»-Sitzung existiert.
  const legacy = toLegacyUsers(t.authMem);
  { const { etag } = await t.authMem.users.get(); assert.ok(await t.authMem.users.set(legacy, etag)); }
  const lapCookie = t.cookies[K]; // Sitzung zeigt nach dem Zurücksetzen auf user_id lap
  { const { state, etag } = await t.authMem.sessions.get(); for (const s of Object.values(state.sessions)) if (s.user_id === K) s.user_id = "lap"; assert.ok(await t.authMem.sessions.set(state, etag)); }
  assert.ok(Object.values(t.authMem.sessions.peek().sessions).some((s) => s.user_id === "lap"));

  const auth = createAuthHandler({ env, getStore: async () => authStoreFrom((k) => t.authMem[k]) });
  const login = (username, password) => auth(makeReq("/api/auth/login", { method: "POST", body: { username, password } }));
  const ok = await login("Kudoshin", PW[K]);
  assert.equal(ok.status, 200, "Kudoshin mit bestehendem Passwort");
  const me = await json(ok);
  assert.deepEqual([me.body.user.user_id, me.body.user.role, me.body.user.locale, me.body.user.markets], [K, "SALES_AGENT_VN", "vi-VN", ["VN"]]);
  const users = t.authMem.users.peek();
  assert.ok(!Object.hasOwn(users.users, "lap"), "users.lap entfernt");
  assert.deepEqual(users.users[K].password, hashBefore, "Passwort-Hash unverändert übernommen (kein neues Passwort)");
  assert.equal(users.identity_migrations["TF-070"].password_transferred, true);
  assert.ok(!Object.values(t.authMem.sessions.peek().sessions).some((s) => s.user_id === "lap"), "«lap»-Sitzungen entfernt");
  assert.equal((await login("lap", PW[K])).status, 401, "lap: Login abgelehnt (kein Alias)");
  assert.equal((await login("kudoshin", PW[K])).status, 200, "Gross/Klein wie bei allen Benutzern egal");
  assert.equal((await t.auth(makeReq("/api/auth/me", { cookie: lapCookie }))).status, 401, "alte lap-Sitzung");
  assert.equal((await t.sales(makeReq("/api/sales?view=commission", { cookie: lapCookie }))).status, 401);
  // Antworten/Audit enthalten nie Hash oder Passwort.
  assert.ok(!JSON.stringify(me.body).includes(hashBefore.hash) && !JSON.stringify(t.authMem.audit.peek()).includes(PW[K]));
  // Idempotent: zweiter Lauf ändert nichts.
  const again = migrateAuthUsers(users);
  assert.equal(again.changed, false);
  assert.equal(migrateAuthSessions(t.authMem.sessions.peek()).changed, false);
  // Owner-Karte: Kudoshin mit gesetztem Passwort, keine «lap»-Karte; andere unverändert.
  const cards = await json(await t.auth(makeReq("/api/auth/admin/users", { cookie: t.cookies.chris })));
  assert.deepEqual(cards.body.users.map((u) => u.user_id), ["giuliano", "mario", "damiano", K]);
  assert.equal(cards.body.users.find((u) => u.user_id === K).password_set, true);
  assert.equal((await t.auth(makeReq("/api/auth/admin/revoke", { method: "POST", cookie: t.cookies.chris, body: { user_id: "lap" } }))).status, 400, "lap ist kein verwaltbares Konto");
  // Ein bereits gesetztes Kudoshin-Passwort wird von einem späten «lap»-Rest nie überschrieben.
  const mixed = migrateAuthUsers({ users: { lap: { password: { algo: "scrypt", hash: "ALT" } }, [K]: { password: { algo: "scrypt", hash: "NEU" } } } });
  assert.equal(mixed.doc.users[K].password.hash, "NEU"); assert.ok(!mixed.doc.users.lap);
});

test("TF-070 RBAC/Scope: Kudoshin nur VN (alle VN-Leads), 0 CH-Leads, CH-Schreibaktion 403; andere Verkäufer unverändert", async () => {
  const t = await setup({ vn: 8 });
  const list = async (u) => (await json(await t.crm(makeReq("/api/crm", t.as(u))))).body;
  const k = await list(K), all = await list("chris"), giu = await list("giuliano");
  assert.equal(k.leads.length, 8); assert.ok(k.leads.every((l) => l.market === "VN"), "nur VN");
  assert.equal(k.leads.filter((l) => l.market !== "VN").length, 0, "0 CH-Leads");
  assert.equal(all.leads.filter((l) => l.market === "VN" && l.seller === K).length, 8, "Owner sieht alle VN-Leads bei Kudoshin");
  assert.equal(all.leads.filter((l) => l.seller === "lap").length, 0, "kein aktiver Verkäufer «lap»");
  assert.ok(giu.leads.every((l) => l.market === "CH"));
  const ch = giu.leads[0];
  assert.equal(sellerOf(ch, null), "giuliano");
  const actor = actorFor(K);
  assert.equal(canSeeLead(actor, ch, null), false);
  assert.equal((await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies[K], body: { action: "crm.addNote", params: { lead_id: ch.lead_id, text: "Test" } } }))).status, 403, "Kudoshin → CH 403");
  assert.equal((await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies.giuliano, body: { action: "crm.addNote", params: { lead_id: k.leads[0].lead_id, text: "Test" } } }))).status, 403, "Giuliano → VN 403");
  // Zuweisungen Mario/Damiano bleiben reine CH-Portfolios; VN nie zugewiesen.
  const asg = await (await t.data()).assignments();
  const vals = Object.values(asg.assignments || {});
  assert.ok(vals.length > 0 && vals.every((a) => ["mario", "damiano"].includes(a.assigned_user_id) && a.market !== "VN"));
  const mar = await list("mario"), dam = await list("damiano");
  assert.ok(mar.leads.length > 0 && mar.leads.every((l) => l.market === "CH") && dam.leads.every((l) => l.market === "CH"));
  // Calling-Rollen
  assert.equal(canStartCalls(actor), true); assert.equal(canUseCalling(actor), true);
  for (const u of ["giuliano", "mario", "damiano"]) assert.equal(canUseCalling(actorFor(u)), false);
  assert.equal(canStartCalls(actorFor("chris")), false);
});

test("TF-070 Verkäufe + Provisionen: alte «lap»-Anfrage/-Provision/-Auszahlung gehören Kudoshin, Beträge unverändert, keine Duplikate; neue nutzen Kudoshin", async () => {
  const t = await setup({ ch: 20, vn: 10 });
  const order_id = "VNCHECK-20261016-abcdef";
  const hist = [{ at: "2026-10-16T08:00:00.000Z", status: "PAYABLE", amount_minor: 346500, reason: "completed_and_paid_full", seller_id: "lap" }];
  const ledger = { schema: 1, eligible_from: "2026-10-15T00:00:00.000Z", audit: [{ ts: "2026-10-16T08:00:00.000Z", actor_user_id: "chris", action: "commission.payout", seller_id: "lap", result: "success" }],
    entries: { [order_id]: { order_id, market: "VN", currency: "VND", created_at: "2026-10-16T07:00:00.000Z", seller_id: "lap", seller_override: null, seller_locked: true, seller_source: "vn_default",
      lead_id: "vn-cong-ty-1.vn", rate_bps: 3500, price_minor: 990000, paid_minor: 990000, base_minor: 990000, expected_minor: 346500, payable_minor: 346500, reversed_minor: 0,
      order_state: "COMPLETED", payment_status: "PAID_FULL", status: "PAYABLE", history: hist } },
    payouts: [{ payout_id: "PO-20261016-ref11", seller_id: "lap", currency: "VND", amount_minor: 100000, paid_at: "2026-10-16T09:00:00.000Z", reference: "REF-1", status: "PAYOUT_RECORDED", recorded_at: "2026-10-16T09:00:00.000Z", recorded_by: "chris" }] };
  const reqDoc = { schema: 1, audit: [{ ts: "2026-10-16T07:00:00.000Z", actor_user_id: "lap", action: "order.createConfirmed", lead_id: "vn-cong-ty-1.vn", result: "queued" }],
    requests: [{ request_id: "11111111-2222-3333-4444-555555555555", lead_id: "vn-cong-ty-1.vn", offer_kind: "CHECK", offer_class: "VN_REPAIR_CHECK", market: "VN", currency: "VND", price: 990000,
      deposit: 495000, domain: "vn-cong-ty-1.vn", actor_user_id: "lap", seller_id: "lap", customer_confirmed: true, status: "done", order_id, created_at: "2026-10-16T07:00:00.000Z" }] };
  t.salesMem.commissions = memoryStore(ledger);
  t.salesMem.orders = memoryStore(reqDoc);
  const sales = createSalesHandler({ env, data: t.data, getSalesStore: async (k) => (t.salesMem[k] ||= memoryStore()), getAuthStore: async () => authStoreFrom((k) => t.authMem[k]) });

  const mine = await json(await sales(makeReq("/api/sales?view=commission", t.as(K))));
  assert.equal(mine.status, 200);
  assert.equal(mine.body.commission.seller_id, K);
  assert.deepEqual([mine.body.commission.currency, mine.body.commission.payable, mine.body.commission.by_currency.VND.paid_out, mine.body.commission.by_currency.VND.outstanding], ["VND", "346500", "100000", "246500"]);
  assert.deepEqual(mine.body.commission.orders.map((o) => [o.order_id, o.status, o.commission]), [[order_id, "PAYABLE", "346500"]]);
  const L = t.salesMem.commissions.peek();
  assert.equal(Object.keys(L.entries).length, 1, "keine doppelte Provision");
  assert.equal(L.payouts.length, 1, "keine doppelte Auszahlung");
  const e = L.entries[order_id];
  assert.deepEqual([e.seller_id, e.payable_minor, e.expected_minor, e.price_minor, e.status, e.payment_status, e.order_state, e.seller_locked], [K, 346500, 346500, 990000, "PAYABLE", "PAID_FULL", "COMPLETED", true]);
  assert.equal(L.payouts[0].seller_id, K); assert.equal(L.payouts[0].amount_minor, 100000);
  assert.deepEqual(e.history, hist, "Verlauf (Audit) bleibt unverändert – legacy seller_id lap");
  assert.equal(L.audit[0].seller_id, "lap", "Audit bleibt unverändert");
  // Auftragsanfragen: gehören Kudoshin, Audit unverändert, keine neue Anfrage.
  const od = t.salesMem.orders.peek();
  assert.equal(od.requests.length, 1);
  assert.deepEqual([od.requests[0].seller_id, od.requests[0].actor_user_id, od.requests[0].price, od.requests[0].status], [K, K, 990000, "done"]);
  assert.equal(od.audit[0].actor_user_id, "lap");
  const ov = await json(await sales(makeReq("/api/sales?view=orders", t.as(K))));
  assert.deepEqual(ov.body.orders.map((o) => [o.order_id, o.seller_id, o.price, o.commission_expected]), [[order_id, K, 990000, "346500"]], "alte Lap-Sale → Kudoshin");
  // Owner: Verkäuferzeile Kudoshin, keine «lap»-Zeile.
  const own = await json(await sales(makeReq("/api/sales?view=commission", t.as("chris"))));
  assert.deepEqual(own.body.sellers.map((s) => s.seller_id), ["giuliano", "mario", "damiano", K]);
  assert.equal(own.body.totals_by_currency.VND.payable, "346500");
  const so = await json(await sales(makeReq("/api/sales?view=sales_overview", t.as("chris"))));
  assert.ok(!so.body.sellers.some((s) => s.seller_id === "lap") && so.body.payouts.every((p) => p.seller_id === K));
  // Idempotent: erneuter Lauf/zweite Instanz ändert nichts.
  const snapL = JSON.stringify(t.salesMem.commissions.peek()), snapO = JSON.stringify(t.salesMem.orders.peek());
  const sales2 = createSalesHandler({ env, data: t.data, getSalesStore: async (k) => (t.salesMem[k] ||= memoryStore()), getAuthStore: async () => authStoreFrom((k) => t.authMem[k]) });
  await sales2(makeReq("/api/sales?view=orders", t.as(K)));
  assert.equal(JSON.stringify(t.salesMem.orders.peek()), snapO);
  assert.equal(JSON.stringify(migrateLedger(JSON.parse(snapL)).doc), snapL);
  assert.equal(migrateOrderRequests(JSON.parse(snapO)).changed, false);
  // Betriebsnachweis (Worker-Token, nur Zählwerte): alles bei Kudoshin, nichts bei «lap», 0 CH-Leads für Kudoshin.
  const worker = (body, token = env("JARVIS_MAIL_WORKER_TOKEN")) => sales2(makeReq("/api/sales", { method: "POST", body, origin: null, headers: { "x-jarvis-worker": token } }));
  assert.equal((await worker({ op: "identity.status" }, "falsch".repeat(8))).status, 401);
  const st = await json(await worker({ op: "identity.status" }));
  assert.equal(st.status, 200);
  assert.deepEqual([st.body.canonical_seller_id, st.body.vn_seller, st.body.sellers], [K, K, ["giuliano", "mario", "damiano", K]]);
  assert.deepEqual([st.body.auth.canonical_record, st.body.auth.canonical_password_set, st.body.auth.legacy_record, st.body.auth.legacy_sessions], [true, true, false, 0]);
  assert.deepEqual([st.body.leads.vn_total, st.body.leads.vn_canonical, st.body.leads.ch_canonical, st.body.leads.legacy], [10, 10, 0, 0]);
  assert.deepEqual([st.body.commissions.canonical, st.body.commissions.legacy, st.body.commissions.payouts_canonical, st.body.commissions.payouts_legacy], [1, 0, 1, 0]);
  assert.deepEqual([st.body.orders.canonical, st.body.orders.legacy], [1, 0]);
  assert.ok(!/vn-cong-ty|lienhe@|scrypt|"hash"/.test(JSON.stringify(st.body)), "keine Lead-IDs, Kontaktdaten oder Hashes");

  // Neue Provision (nach TF-072): VN-Auftrag → Kudoshin, 594000 / 2340000 VND.
  const vnLead = { lead_id: "vn-cong-ty-2.vn", market: "VN", domain: "vn-cong-ty-2.vn" };
  const snap = { repair: { orders: [{ order_id: "VNFIX-20261017-aaaaaa", domain: "vn-cong-ty-2.vn", market: "VN", currency: "VND", offer_class: "VN_REPAIR_FIX", price_amount: 3900000, paid_amount: 3900000, state: "COMPLETED", payment_status: "PAID_FULL", created_at: "2026-10-17T07:00:00.000Z" }] },
    check150: { orders: [{ order_id: "VNCHECK-20261017-bbbbbb", domain: "vn-cong-ty-2.vn", market: "VN", currency: "VND", offer_class: "VN_REPAIR_CHECK", price_amount: 990000, paid_amount: 990000, state: "COMPLETED", payment_status: "PAID_FULL", created_at: "2026-10-17T07:00:00.000Z" }] } };
  const d = deriveLedger({ ledger: { ...emptyLedger(), eligible_from: "2026-10-16T00:00:00.000Z" }, orders: ordersFromSnapshot(snap), resolveSeller: () => ({ seller_id: sellerOf(vnLead, null), lead_id: vnLead.lead_id, source: "vn_default" }), now: new Date("2026-10-17T08:00:00Z") });
  assert.deepEqual(Object.values(d.ledger.entries).map((x) => [x.seller_id, x.payable_minor]).sort((a, b) => a[1] - b[1]), [[K, 594000], [K, 2340000]]);

  // Neue VN-Sale (Kudoshin, eigener Lead) → seller_id Kudoshin; VPS-Übernahme akzeptiert nur Kudoshin, «lap» → BAD_ACTOR.
  const lead = (await json(await t.crm(makeReq("/api/crm", t.as(K))))).body.leads.find((l) => l.email && !l.do_not_contact && l.lead_id !== "vn-cong-ty-1.vn");
  const created = await json(await sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies[K], body: { op: "order.createConfirmed", lead_id: lead.lead_id, offer: "CHECK", confirmed: true } })));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const nr = t.salesMem.orders.peek().requests.at(-1);
  assert.deepEqual([nr.seller_id, nr.actor_user_id], [K, K]);
  assert.equal(t.salesMem.orders.peek().requests.length, 2, "genau eine neue Anfrage");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-070-order-"));
  const store = createStore(dir);
  const base = { ...nr, confirmed_at: nr.created_at };
  assert.equal(applyOrderRequest(store, { ...base, seller_id: "mario", actor_user_id: "mario" }).code, "BAD_ACTOR", "nur der VN-Verkäufer");
  assert.equal(applyOrderRequest(store, { ...base, seller_id: K, actor_user_id: "giuliano" }).code, "BAD_ACTOR");
  const applied = applyOrderRequest(store, base);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const sale = Object.values(store.read("sales.json", { records: {} }).records).flat().find((x) => x?.order_id === applied.order_id || x?.extra?.order_id === applied.order_id);
  assert.ok(JSON.stringify(sale || store.read("sales.json", {})).includes(`"seller_id":"${K}"`) && !JSON.stringify(store.read("sales.json", {})).includes('"lap"'));
  assert.equal(applyOrderRequest(store, base).duplicate, true, "idempotent je request_id");
  // Übergang: eine vor dem Netlify-Deploy angelegte «lap»-Anfrage wird als Kudoshin übernommen (nie «lap» geschrieben).
  const other = (await json(await t.crm(makeReq("/api/crm", t.as(K))))).body.leads.find((l) => l.email && !l.do_not_contact && ![lead.lead_id, "vn-cong-ty-1.vn"].includes(l.lead_id));
  const legacyReq = { ...base, request_id: "99999999-8888-7777-6666-555555555555", lead_id: other.lead_id, domain: other.domain, delivery_email: other.email, seller_id: "lap", actor_user_id: "lap" };
  const leg = applyOrderRequest(store, legacyReq);
  assert.equal(leg.ok, true, JSON.stringify(leg));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.ok(!/"(seller_id|confirmed_by|actor_user_id)":\s*"lap"/.test(files), "VPS-Daten enthalten nie «lap»");
  assert.equal((files.match(/"seller_id":\s*"Kudoshin"/g) || []).length >= 4, true, "Aufträge + Verkäufe tragen Kudoshin");
});

test("TF-070 Calling: Kampagne/Anrufe/Rückruf von «lap» gehören Kudoshin; neuer Anruf seller_id Kudoshin; lap 401, Giuliano/Mario/Damiano 403, Dry Run bleibt", async () => {
  let tick = 0;
  const now = () => new Date(+new Date("2026-10-14T10:00:00+07:00") + (tick++ % 1000)); // tickend wie tf068 (Session nach Passwort-Setzen gültig)
  const t = await setup({ ch: 20, vn: 6, now });
  const { state: vv } = await t.stores.vnView.get();
  const ids = vv.leads.filter((l) => !l.do_not_contact).map((l) => l.lead_id);
  const phones = Object.fromEntries(vv.leads.map((l) => [l.lead_id, (l.phone_tel || "").replace(/^tel:/, "")]));
  const ev = (id) => ({ evidence: { lead_id: id, market: "VN", phone: phones[id], consent_status: "GRANTED", consent_source: "WRITTEN_FORM", consent_timestamp: "2026-10-01T08:00:00.000Z",
    consent_scope: ["ADVERTISING_CALLS"], consent_evidence_reference: `FORM-${id}`, verified_at: "2026-10-02T08:00:00.000Z", revoked_at: null }, dnc_registry: { result: "NOT_LISTED", checked_at: "2026-10-10T08:00:00.000Z" } });
  const cb = { at: "2026-10-13T03:00:00.000Z", callback_at: "2026-10-20T03:00:00.000Z", call_id: "aaaaaaaa-0000-0000-0000-000000000001" };
  const legacyCall = { call_id: "aaaaaaaa-0000-0000-0000-000000000001", campaign_id: "cccccccc-0000-0000-0000-000000000001", lead_id: ids[0], market: "VN", seller: "lap", seller_id: "lap", actor_user_id: "lap",
    dry_run: true, status: "ENDED", started_at: "2026-10-13T03:00:00.000Z", ended_at: "2026-10-13T03:02:00.000Z", outcome: "CALLBACK_REQUESTED", callback_at: cb.callback_at };
  const mem = {
    control: memoryStore({ schema: 1, config: { legal_vn: { status: "APPROVED", reference: "TEST" } }, commands: [], service: null, calls: {}, audit: [{ ts: "2026-10-13T03:00:00.000Z", actor_user_id: "lap", action: "campaign.start", result: "queued" }],
      campaigns: [{ campaign_id: "cccccccc-0000-0000-0000-000000000001", market: "VN", mode: "SINGLE", concurrency: 1, status: "FINISHED", owner_user_id: "lap", dry_run: true, created_at: "2026-10-13T03:00:00.000Z", items: [{ lead_id: ids[0], state: "DONE", attempts: 1 }] }] }),
    history: memoryStore({ schema: 1, calls: [legacyCall] }),
    consents: memoryStore({ schema: 1, leads: { [ids[0]]: { ...ev(ids[0]), requested_callback: cb }, [ids[1]]: ev(ids[1]) }, dnc: {} }),
  };
  const calling = createCallingHandler({ env, now, getCallingStore: async (k) => mem[k], getAuthStore: async () => authStoreFrom((k) => t.authMem[k]), getViewStore: async () => t.stores.view,
    getVnViewStore: async () => t.stores.vnView, getSalesStore: async (k) => (t.salesMem[k] ||= memoryStore()), getCrmQueueStore: async () => t.stores.queue, getVnQueueStore: async () => t.stores.vnQueue });
  const as = async (u, body, q = "") => json(await calling(makeReq(`/api/calling${q}`, { method: body ? "POST" : "GET", body, cookie: u ? t.cookies[u] : undefined })));

  const main = await as(K);
  assert.equal(main.status, 200);
  assert.equal(main.body.actor.user_id, K); assert.equal(main.body.actor.can_start_calls, true);
  assert.deepEqual(main.body.campaigns.map((c) => [c.campaign_id, c.owner_user_id]), [["cccccccc-0000-0000-0000-000000000001", K]], "Kampagne von Lap sichtbar für Kudoshin");
  const cbs = await as(K, undefined, "?view=callbacks");
  assert.deepEqual(cbs.body.callbacks.map((x) => [x.lead_id, x.callback_at]), [[ids[0], cb.callback_at]], "bestehender Rückruf erhalten");
  const detail = await as(K, undefined, `?lead=${encodeURIComponent(ids[0])}`);
  assert.equal(detail.body.last_call.seller_id, K);
  assert.equal(mem.history.peek().calls.length, 1, "kein Duplikat");
  assert.deepEqual([mem.history.peek().calls[0].seller_id, mem.history.peek().calls[0].actor_user_id], [K, K]);
  assert.equal(mem.control.peek().audit[0].actor_user_id, "lap", "Audit unverändert (legacy)");
  assert.equal(Object.keys(mem.consents.peek().leads).length, 2, "Rückrufe/Nachweise unverändert");
  assert.equal(migrateCallingControl(mem.control.peek()).changed, false); assert.equal(migrateCallingHistory(mem.history.peek()).changed, false);

  // Andere Rollen / alte Identität
  for (const u of ["giuliano", "mario", "damiano"]) {
    assert.equal((await as(u)).status, 403, `${u} 403`);
    assert.equal((await as(u, { op: "call.start", lead_id: ids[1], confirmed: true })).status, 403);
  }
  const legacyActorCall = await json(await calling(makeReq("/api/calling", { method: "POST", body: { op: "call.start", lead_id: ids[1], confirmed: true }, cookie: "jarvis_session=" + "x".repeat(43) })));
  assert.equal(legacyActorCall.status, 401, "lap / unbekannte Sitzung → 401");
  assert.equal((await as("chris", { op: "call.start", lead_id: ids[1], confirmed: true })).status, 403, "Chris nur Überwachung");

  // Neuer Anruf durch Kudoshin (Dry Run, alle Gates erfüllt) → seller_id/actor_user_id Kudoshin.
  const AGENT = callingAgentToken(CONTROL);
  const SVC = { configured: { livekit: true, livekit_url: true, api_credentials: true, trunk_vn: true, caller_id_vn: true, voice_vn: "VOICE_VERIFIED" }, livekit_reachable: true, worker_registered: true,
    trunk_vn_verified: true, dry_run: true, default_concurrency: 1, max_concurrency: 5 };
  const pull = async () => json(await calling(makeReq("/api/calling", { method: "POST", body: { op: "pull", status: SVC, capacity: 5, active_call_ids: [] }, origin: null, headers: { "x-jarvis-calling": AGENT } })));
  await pull();
  const start = await as(K, { op: "call.start", lead_id: ids[1], confirmed: true });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const jobs = (await pull()).body.jobs || [];
  assert.equal(jobs.length, 1); assert.equal(jobs[0].dry_run, true, "CALLING_DRY_RUN bleibt");
  const call = mem.control.peek().calls[jobs[0].call_id];
  assert.deepEqual([call.seller_id, call.seller, call.actor_user_id], [K, K, K]);
  assert.equal(mem.control.peek().campaigns.at(-1).owner_user_id, K);
});

test("TF-070 CRM-/Mail-Aufträge: «lap»-Aufträge gehören Kudoshin (Metadaten bleiben VN), Audit unverändert, idempotent", async () => {
  const t = await setup({ ch: 20, vn: 6 });
  const vnLead = (await t.stores.vnView.get()).state.leads[1];
  // CRM-Queue
  const crmDoc = { requests: [{ request_id: "r-1", action: "crm.addNote", params: { lead_id: vnLead.lead_id }, status: "done", created_at: "2026-10-15T08:00:00.000Z", actor_user_id: "lap" }],
    audit: [{ ts: "2026-10-15T08:00:00.000Z", actor_user_id: "lap", action: "crm.addNote", outcome: "queued" }], rate: [] };
  const vnQ = memoryStore(crmDoc);
  const crm = createCrmHandler({ env, getQueueStore: async () => t.stores.queue, getViewStore: async () => t.stores.view, getVnQueueStore: async () => vnQ, getVnViewStore: async () => t.stores.vnView,
    getSalesStore: async (k) => (t.salesMem[k] ||= memoryStore()), getAuthStore: async () => authStoreFrom((k) => t.authMem[k]) });
  assert.equal((await crm(makeReq("/api/crm", t.as(K)))).status, 200);
  assert.equal(vnQ.peek().requests[0].actor_user_id, K);
  assert.equal(vnQ.peek().requests.length, 1);
  assert.equal(vnQ.peek().audit[0].actor_user_id, "lap");
  assert.equal(migrateCrmQueue(vnQ.peek()).changed, false);
  // Mail-Queue
  const mailReq = { request_id: "abcdef12-3456-7890-abcd-ef1234567890", created_at: "2026-10-15T08:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", requested_by: "lap", recipient: vnLead.email || "lienhe@vn-cong-ty-1.vn",
    subject: "Xin chào", body: "Nội dung", intent: "sales", status: "drafted", delivery: "draft", attempts: 0, meta: { actor_user_id: "lap", market: "VN", locale: "vi-VN", lead_id: vnLead.lead_id } };
  const mailStore = memoryStore({ requests: [mailReq], locks: [], workers: {} });
  const ra = (req) => import("../auth-core.js").then((m) => m.resolveActor(req, { env, getAuthStore: async () => authStoreFrom((k) => t.authMem[k]) }));
  const mail = createMailRequestHandler({ env, getStore: async () => mailStore, resolveActor: ra, resolveLead: async (a, id) => (await t.data()).resolveLead(a, id) });
  const mine = await json(await mail(makeReq("/api/mail-requests", t.as(K))));
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.requests.map((r) => r.request_id), [mailReq.request_id], "Kudoshin sieht den Entwurf von Lap");
  const stored = mailStore.peek().requests[0];
  assert.deepEqual([stored.requested_by, stored.meta.actor_user_id, stored.meta.market], [K, K, "VN"]);
  assert.equal(senderProfileFor(stored.meta).id, "vn");
  assert.equal(migrateMailQueue(mailStore.peek()).changed, false);
  // Neuer Entwurf: Metadaten actor Kudoshin bleiben erhalten (Grossbuchstaben erlaubt).
  const lead = (await json(await t.crm(makeReq("/api/crm", t.as(K))))).body.leads.find((l) => l.email && !l.do_not_contact);
  const draft = await json(await mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies[K], body: { op: "lead_draft", lead_id: lead.lead_id, subject: "Xin chào", body: "Nội dung thư" } })));
  assert.ok([200, 201, 202].includes(draft.status), JSON.stringify(draft.body));
  const nr = mailStore.peek().requests.at(-1);
  assert.deepEqual([nr.requested_by, nr.meta?.actor_user_id, nr.meta?.market], [K, K, "VN"]);
});
