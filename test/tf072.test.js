// TF-072 Tests – (A) direkte CRM-Fehlerlinks je verifiziertem Fehler (betroffene Seite, nie erfunden, nur sichere öffentliche URLs) in
// CRM-Detail, Anrufansicht und Calling-Agent-Kontext (nur aktueller Lead); (B) Verkäufer-Provision 60 % (6000 bps) für NEUE Verkäufe,
// Satz je Auftrag eingefroren, historische 3500-bps-Einträge unverändert. Alles RAM/Temp – keine Anrufe, Zahlungen, Mails oder Websites.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, makeReq, CONTROL, env } from "./tf063-helpers.js";
import { memoryStore } from "../shared-state.js";
import { authStoreFrom, publicUser, SELLER_IDS } from "../auth-core.js";
import { cleanCrmLead } from "../lead-crm.js";
import { safePublicUrl, issueLink, issueLinks, priorityOf } from "../public/crm-model.js";
import { normalizeIssue, partialFindings } from "../site-findings.js";
import { createCallingHandler, callingAgentToken, callIssueLinks } from "../calling-api.js";
import { createSalesHandler } from "../sales-api.js";
import { deriveLedger, ordersFromSnapshot, emptyLedger, summarize, recordPayout, RATE_BPS, SELLERS, commissionMinor, fromMinor } from "../commission-ledger.js";
import { SELLER_COMMISSION_BPS, COMMISSION_BPS_SCHEDULE, commissionBpsAt, toMinor, MARKET_PRICES } from "../pricing.js";
import { createStore } from "../mail-worker.js";
import { createCheck150Order, publicCheck150Orders } from "../check-150-workflow.js";
import { createRepairOrder, publicRepairOrders } from "../repair-workflow.js";
import { applyOrderRequest } from "../order-intake.js";
import { cleanRepair, cleanCheck150 } from "../server-control.js";

const K = "Kudoshin";
const AT = "2026-10-16T12:00:00.000Z";
const AFTER = "2026-10-17T08:00:00.000Z"; // nach TF-072 (Satzwechsel 2026-10-16T15:00Z)
const BEFORE = "2026-10-16T03:00:00.000Z"; // vor TF-072

// Verifizierte Fehler eines Leads (CRM-Sicht wie vom CRM-Dienst geliefert, danach durch die Cloud-Allowlist).
const item = (x) => ({ severity: "high", verified_at: AT, source: "full_audit", status: "OPEN", ...x });
function errorsFor(domain) {
  const items = [
    item({ key: `mailto|page:/kontakt`, type: "broken_mailto", category: "contact", text: "E-Mail-Link auf Seite «Kontakt» funktioniert nicht", page: `https://${domain}/kontakt` }),
    item({ key: `link|${domain}/angebot/alt`, type: "broken_link", category: "http", text: "Link «Angebot» führt auf eine Fehlerseite", page: `https://${domain}/angebot`, target: `https://${domain}/angebot/alt`, label: "Angebot", http_status: 404 }),
    item({ key: "text|historisch", type: null, category: "other", text: "Historischer Fund ohne Seite", page: null, source: "cold" }), // unbekannte Seite
    item({ key: "cert|site", type: "https_certificate", category: "navigation", text: "Browser zeigt beim Öffnen eine Warnmeldung", page: "http://127.0.0.1/admin" }), // privat
    item({ key: "area:x", type: "visible_layout_error", category: "other", text: "Bereich «Kopf» wird verschoben dargestellt", page: `https://${domain}/`, affected_url: "javascript:alert(1)", location: "Kopf" }),
  ];
  return { audit: "FULL", count: items.length, exact: true, checked_at: AT, full_checked_at: AT, scope: "Test", top: items.slice(0, 2), items, resolved: 0, manual_open: 0, repair: null };
}
const withErrors = (l) => { const x = cleanCrmLead({ ...l, errors: errorsFor(l.domain) }); x.priority = priorityOf(x); return x; };

async function world() {
  const s = await setup({ ch: 600, vn: 6 }); // ≥ 2 × 200 geeignete CH-Leads für die Portfolio-Verteilung Mario/Damiano
  for (const key of ["view", "vnView"]) {
    const { state, etag } = await s.stores[key].get();
    state.leads = state.leads.map((l, i) => (key === "view" || i < 3 ? withErrors({ ...l, market: key === "vnView" ? "VN" : "CH" }) : l));
    assert.ok(await s.stores[key].set(state, etag));
  }
  const mem = { control: memoryStore({ config: { legal_vn: { status: "APPROVED", reference: "TEST" } } }), history: memoryStore(), consents: memoryStore({ schema: 1, leads: {}, dnc: {} }) };
  const calling = createCallingHandler({ env, getCallingStore: async (k) => mem[k], getAuthStore: async () => authStoreFrom((k) => (s.authMem[k] ||= memoryStore())), getViewStore: async () => s.stores.view,
    getVnViewStore: async () => s.stores.vnView, getSalesStore: async (k) => (s.salesMem[k] ||= memoryStore()), getCrmQueueStore: async () => s.stores.queue, getVnQueueStore: async () => s.stores.vnQueue });
  const as = async (user, body, q = "") => { const r = await calling(makeReq(`/api/calling${q}`, { method: body ? "POST" : "GET", body: body ?? undefined, cookie: user ? s.cookies[user] : undefined })); return { status: r.status, body: await r.json() }; };
  const agent = async (body) => { const r = await calling(makeReq("/api/calling", { method: "POST", body, origin: null, headers: { "x-jarvis-calling": callingAgentToken(CONTROL) } })); return { status: r.status, body: await r.json() }; };
  const crm = async (user) => (await s.json(await s.crm(makeReq("/api/crm", s.as(user))))).body.leads;
  return { s, mem, as, agent, crm };
}

// ================= A: CRM-Fehlerlinks =================
test("TF-072 URL-Sicherheit: nur öffentliche http(s); javascript/data/file/localhost/127/privat/IPv6/Zugangsdaten/Ports/kaputt blockiert", () => {
  for (const u of ["https://example.ch/kontakt", "http://example.ch/impressum", "https://shop.example.ch/produkte/item?id=2#x", "https://xn--mnchen-3ya.de/", "https://8.8.8.8/"]) assert.ok(safePublicUrl(u), u);
  for (const u of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "ftp://example.ch/", "http://localhost/", "http://foo.localhost/",
    "http://127.0.0.1/", "http://0x7f.1/", "http://2130706433/", "http://10.0.0.5/", "http://172.16.3.4/", "http://192.168.1.1/router", "http://169.254.169.254/latest/meta-data",
    "http://100.64.1.1/", "http://0.0.0.0/", "http://[::1]/", "http://[fd00::1]/", "http://user:pw@example.ch/", "http://example.ch:8080/", "http://intranet/", "http://nas.local/",
    "http://svc.internal/", "https://exa mple.ch/", "not a url", "", null, 42, "https://" + "a".repeat(400) + ".ch/"]) assert.equal(safePublicUrl(u), null, String(u));
});

test("TF-072 kanonische Befunde: affected_url = genau die geprüfte Seite; ohne belegte Seite null (nie Startseite)", () => {
  const n = normalizeIssue({ type: "broken_link", url: "https://a.ch/alt", page: "https://a.ch/angebot", severity: "high" }, { verified_at: AT });
  assert.deepEqual([n.page, n.affected_url, n.target], ["https://a.ch/angebot", "https://a.ch/angebot", "https://a.ch/alt"]);
  const m = normalizeIssue({ type: "broken_mailto", url: "mailto:x", evidence: "Ungültige Adresse (verlinkt auf https://a.ch/kontakt)" }, { verified_at: AT });
  assert.equal(m.affected_url, "https://a.ch/kontakt");
  const [p] = partialFindings([{ text: "Telefonnummer falsch", verified_at: AT }]);
  assert.equal(p.affected_url, null, "Teilprüfung ohne Seite → kein Link");
});

test("TF-072 Cloud-Allowlist: einzelner Fehler → genauer Link; mehrere → je eigener Link; unbekannt/unsicher/privat → kein Link", () => {
  const l = withErrors({ lead_id: "firma-a.ch", domain: "firma-a.ch", website: "https://firma-a.ch/", company: "Firma A" });
  const it = l.errors.items;
  assert.equal(it[0].affected_url, "https://firma-a.ch/kontakt");
  assert.deepEqual([it[1].affected_url, it[1].target_url], ["https://firma-a.ch/angebot", "https://firma-a.ch/angebot/alt"]);
  assert.equal(it[2].affected_url, null, "unbekannte Seite → kein Link");
  assert.equal(it[3].affected_url, null, "127.0.0.1 blockiert");
  assert.equal(it[4].affected_url, null, "javascript: blockiert – kein Rückfall auf page/Startseite");
  for (const f of it) assert.notEqual(f.affected_url, l.website, "nie die Startseite als Ersatz");
  const links = issueLinks(l);
  assert.equal(links.length, 5, "jeder Fehler einzeln");
  assert.deepEqual(links.map((x) => x.affected_url), ["https://firma-a.ch/kontakt", "https://firma-a.ch/angebot", null, null, null]);
  assert.equal(new Set(links.filter((x) => x.affected_url).map((x) => x.affected_url)).size, 2, "verschiedene Seiten nicht zusammengefasst");
  // Ältere gespeicherte Befunde ohne affected_url: Link aus der gespeicherten Seite.
  assert.equal(issueLink({ page: "https://firma-a.ch/impressum" }).affected_url, "https://firma-a.ch/impressum");
  assert.equal(issueLink({ text: "nur Text" }).affected_url, null);
  assert.equal(issueLink({ page: "data:text/html,x" }).affected_url, null);
  assert.equal(issueLink({ type: "broken_link", page: "https://a.ch/x", target: "http://192.168.0.1/" }).target_url, null, "privates Ziel blockiert");
});

test("TF-072 Rollen: Kudoshin Anrufansicht + Detail mit Links für eigenen Lead, fremde Leads 403; CH-Verkäufer Links für eigene Leads; Calling-Agent nur aktueller Lead", async () => {
  const w = await world();
  // Kudoshin: eigene VN-Leads im CRM mit Links, kein CH-Lead.
  const kl = await w.crm(K);
  assert.ok(kl.length > 0 && kl.every((l) => l.market === "VN"));
  const own = kl.find((l) => l.errors.items.length === 5);
  assert.ok(own, "VN-Lead mit Fehlern sichtbar");
  assert.deepEqual(own.errors.items.map((f) => f.affected_url), [`https://${own.domain}/kontakt`, `https://${own.domain}/angebot`, null, null, null]);
  // Anrufansicht (/api/calling?lead=): Website + je Fehler Kurztext + betroffene Seite.
  const d = await w.as(K, null, `?lead=${encodeURIComponent(own.lead_id)}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.website, own.website);
  assert.deepEqual(d.body.issues.map((x) => x.affected_url), [`https://${own.domain}/kontakt`, `https://${own.domain}/angebot`, null, null, null]);
  assert.ok(d.body.issues.every((x) => x.title && x.category));
  assert.ok(!/passw|token|secret|credential/i.test(JSON.stringify(d.body)), "keine Zugangsdaten");
  // Fremder Lead (CH) → 403; Mario/Giuliano/Damiano haben kein Calling.
  const ch = (await w.crm("mario"))[0];
  assert.equal((await w.as(K, null, `?lead=${encodeURIComponent(ch.lead_id)}`)).status, 403, "Cross-lead blockiert");
  for (const u of ["mario", "giuliano", "damiano"]) assert.equal((await w.as(u, null, `?lead=${encodeURIComponent(own.lead_id)}`)).status, 403, u);
  assert.equal((await w.as(null, null, `?lead=${encodeURIComponent(own.lead_id)}`)).status, 401);
  // CH-Verkäufer: Links für die eigenen Leads, nie VN-Leads.
  for (const u of ["mario", "damiano", "giuliano"]) {
    const ls = await w.crm(u);
    assert.ok(ls.every((l) => l.market === "CH"), u);
    assert.ok(ls.length > 0, u);
    for (const l of ls) assert.deepEqual(l.errors.items.map((f) => f.affected_url), [`https://${l.domain}/kontakt`, `https://${l.domain}/angebot`, null, null, null], `${u} ${l.lead_id}`);
  }
  // Calling-Agent: get_current_lead liefert die Links NUR für den Lead des Anrufs; anderer Lead → 403 CROSS_LEAD.
  const call_id = crypto.randomUUID();
  w.mem.control.peek().calls = { [call_id]: { call_id, lead_id: own.lead_id, market: "VN", status: "ANSWERED", dry_run: true, started_at: AT, tool: {} } };
  const g = await w.agent({ op: "tool", call_id, lead_id: own.lead_id, tool: "get_current_lead", idempotency_key: "tf072-get-0001" });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(g.body.lead.issue_links.map((x) => x.affected_url), [`https://${own.domain}/kontakt`, `https://${own.domain}/angebot`, null, null, null]);
  const other = kl.find((l) => l.lead_id !== own.lead_id);
  const x = await w.agent({ op: "tool", call_id, lead_id: other.lead_id, tool: "get_current_lead", idempotency_key: "tf072-get-0002" });
  assert.equal(x.status, 403); assert.equal(x.body.code, "CROSS_LEAD");
  // Kein Schreiben von URLs über den Calling-Flow (Allowlist unverändert).
  assert.equal((await w.agent({ op: "tool", call_id, lead_id: own.lead_id, tool: "crm.update", params: { website: "https://evil.example/" }, idempotency_key: "tf072-w-0001" })).status, 400);
  assert.equal((await w.agent({ op: "tool", call_id, lead_id: own.lead_id, tool: "mark_interested", params: { summary: "x", affected_url: "https://evil.example/" }, idempotency_key: "tf072-w-0002" })).status, 400);
  assert.deepEqual(callIssueLinks({ errors: { items: [{ text: "x", page: "file:///etc/passwd" }] } }).map((y) => y.affected_url), [null]);
});

// ================= B: Provision 60 % =================
const snapOrder = (order_id, domain, offer_class, market, currency, price, created_at, x = {}) => ({ order_id, domain, offer_class, market, currency, price_amount: price, paid_amount: price,
  state: "COMPLETED", payment_status: "PAID_FULL", created_at, ...x });
const derive = (ledger, orders, seller, now = new Date("2026-10-18T08:00:00Z")) => deriveLedger({ ledger, orders: ordersFromSnapshot({ repair: { orders } }),
  resolveSeller: (o) => ({ seller_id: typeof seller === "function" ? seller(o) : seller, lead_id: o.domain, source: "test" }), now });
const base = () => ({ ...emptyLedger(), eligible_from: "2026-10-01T00:00:00.000Z" });

test("TF-072 Satz: aktueller Satz 6000 bps für Giuliano/Mario/Damiano/Kudoshin, Chris 0, keine doppelte Verkäuferkonfiguration", () => {
  assert.equal(SELLER_COMMISSION_BPS, 6000);
  assert.deepEqual(COMMISSION_BPS_SCHEDULE.map((r) => r.bps), [3500, 6000]);
  assert.deepEqual(SELLERS, ["giuliano", "mario", "damiano", K]);
  assert.deepEqual(SELLER_IDS, SELLERS);
  for (const u of SELLERS) { assert.equal(RATE_BPS[u], 6000, u); assert.equal(publicUser(u).commission_rate_bps, 6000, u); }
  assert.equal(publicUser("chris").commission_rate_bps, 0);
  assert.equal(RATE_BPS.chris, undefined, "Chris ist kein Verkäufer");
  assert.deepEqual([publicUser(K).role, publicUser(K).markets, publicUser(K).locale], ["SALES_AGENT_VN", ["VN"], "vi-VN"]);
  assert.equal(commissionBpsAt(BEFORE), 3500); assert.equal(commissionBpsAt(AFTER), 6000);
});

test("TF-072 neue Provision: CH CHECK 90.00 / FIX 288.00 CHF, VN CHECK 594000 / FIX 2340000 VND – aus Preis × 6000 / 10000", () => {
  const P = MARKET_PRICES;
  const orders = [snapOrder("CA150-20261017-aaaaa1", "a.ch", "REPAIR_CHECK_150", "CH", "CHF", P.CH.offers.CHECK.price, AFTER, { commission_rate_bps: 6000 }),
    snapOrder("RF480-20261017-aaaaa2", "b.ch", "REPAIR_FIX_500", "CH", "CHF", P.CH.offers.FIX.price, AFTER), // ohne gespeicherten Satz → Satz zum Auftragszeitpunkt
    snapOrder("VNCHECK-20261017-aaaaa3", "c.vn", "VN_REPAIR_CHECK", "VN", "VND", P.VN.offers.CHECK.price, AFTER, { commission_rate_bps: 6000 }),
    snapOrder("VNFIX-20261017-aaaaa4", "d.vn", "VN_REPAIR_FIX", "VN", "VND", P.VN.offers.FIX.price, AFTER)];
  const L = derive(base(), orders, (o) => (o.market === "VN" ? K : "mario")).ledger;
  const e = (id) => L.entries[id];
  assert.deepEqual(["CA150-20261017-aaaaa1", "RF480-20261017-aaaaa2"].map((id) => fromMinor(e(id).payable_minor, "CHF")), ["90.00", "288.00"]);
  assert.deepEqual(["VNCHECK-20261017-aaaaa3", "VNFIX-20261017-aaaaa4"].map((id) => fromMinor(e(id).payable_minor, "VND")), ["594000", "2340000"]);
  for (const x of Object.values(L.entries)) {
    assert.deepEqual([x.rate_bps, x.commission_rate_bps, x.status], [6000, 6000, "PAYABLE"]);
    assert.equal(x.payable_minor, commissionMinor(toMinor(x.price_minor / (x.currency === "CHF" ? 100 : 1), x.currency), 6000));
  }
  const s = summarize(L, ["mario", K]);
  assert.deepEqual(s.map((x) => [x.seller_id, x.rate_bps, x.payable]), [["mario", 6000, "378.00"], [K, 6000, "2934000"]]);
  assert.ok(s.every((x) => x.orders.every((o) => o.rate_bps === 6000 && o.offer_class)));
  // Chris (Direktkunde ohne Verkäufer): keine Provision.
  const D = derive(base(), [snapOrder("CA150-20261017-aaaaa5", "e.ch", "REPAIR_CHECK_150", "CH", "CHF", 150, AFTER)], null).ledger.entries["CA150-20261017-aaaaa5"];
  assert.deepEqual([D.seller_id, D.rate_bps, D.payable_minor], [null, 0, 0]);
});

test("TF-072 Historie: gespeicherte 3500-bps-Provision unverändert, alte Aufträge behalten ihren Satz, nie rückwirkend 60 %", () => {
  const id = "VNCHECK-20261016-bbbbb1";
  const hist = [{ at: "2026-10-16T08:00:00.000Z", status: "PAYABLE", amount_minor: 346500, reason: "completed_and_paid_full", seller_id: K }];
  const ledger = { ...base(), entries: { [id]: { order_id: id, market: "VN", currency: "VND", created_at: BEFORE, seller_id: K, seller_override: null, seller_locked: true, seller_source: "vn_default",
    lead_id: "c.vn", rate_bps: 3500, price_minor: 990000, paid_minor: 990000, base_minor: 990000, expected_minor: 346500, payable_minor: 346500, reversed_minor: 0,
    order_state: "COMPLETED", payment_status: "PAID_FULL", status: "PAYABLE", history: hist } } };
  const L = derive(ledger, [snapOrder(id, "c.vn", "VN_REPAIR_CHECK", "VN", "VND", 990000, BEFORE)], K).ledger;
  const e = L.entries[id];
  assert.deepEqual([e.rate_bps, e.commission_rate_bps, e.payable_minor, e.expected_minor, e.status], [3500, 3500, 346500, 346500, "PAYABLE"]);
  assert.deepEqual(e.history, hist, "Verlauf unverändert");
  // Offener Auftrag mit beim Auftrag gespeichertem Satz 3500 (noch kein Eintrag) → 3500, auch nach TF-072 abgeschlossen.
  const o2 = snapOrder("VNFIX-20261016-bbbbb2", "d.vn", "VN_REPAIR_FIX", "VN", "VND", 3900000, AFTER, { commission_rate_bps: 3500 });
  assert.equal(derive(base(), [o2], K).ledger.entries[o2.order_id].payable_minor, 1365000);
  // Alter Auftrag ohne gespeicherten Satz (vor TF-072 erstellt) → damaliger Satz 3500.
  const o3 = snapOrder("CA150-20261016-bbbbb3", "a.ch", "REPAIR_CHECK_150", "CH", "CHF", 150, BEFORE);
  assert.equal(fromMinor(derive(base(), [o3], "mario").ledger.entries[o3.order_id].payable_minor, "CHF"), "52.50");
  // Eintrag PENDING mit 3500 wird später bezahlt → bleibt 3500.
  const p0 = derive(base(), [{ ...o3, state: "REPAIRING", payment_status: "DEPOSIT_MET", paid_amount: 75 }], "mario").ledger;
  assert.equal(p0.entries[o3.order_id].commission_rate_bps, 3500);
  assert.equal(derive(p0, [o3], "mario").ledger.entries[o3.order_id].payable_minor, 5250);
});

test("TF-072 Refund, Teilauszahlung, Duplikate mit 60-%-Provision", () => {
  const id = "VNCHECK-20261017-ccccc1";
  const o = snapOrder(id, "c.vn", "VN_REPAIR_CHECK", "VN", "VND", 990000, AFTER, { commission_rate_bps: 6000 });
  const L1 = derive(base(), [o], K).ledger;
  assert.equal(L1.entries[id].payable_minor, 594000);
  // Duplikat: erneute Ableitung → genau ein Eintrag, Betrag unverändert, kein neuer Verlaufseintrag.
  const again = derive(L1, [o, { ...o }], K);
  assert.equal(Object.keys(again.ledger.entries).length, 1);
  assert.equal(again.ledger.entries[id].history.length, L1.entries[id].history.length);
  // Teilauszahlung 200000 → offen 394000; Überzahlung und doppelte Referenz blockiert.
  const { ledger: L2 } = recordPayout(L1, { seller_id: K, amount: 200000, currency: "VND", paid_at: "2026-10-17T09:00:00.000Z", reference: "VCB-TF072-1", actor_user_id: "chris", now: new Date("2026-10-18T08:00:00Z") });
  const s2 = summarize(L2, [K])[0];
  assert.deepEqual([s2.by_currency.VND.paid_out, s2.by_currency.VND.outstanding], ["200000", "394000"]);
  assert.throws(() => recordPayout(L2, { seller_id: K, amount: 394001, currency: "VND", paid_at: "2026-10-17T09:00:00.000Z", reference: "VCB-TF072-2", actor_user_id: "chris", now: new Date("2026-10-18T08:00:00Z") }), /übersteigt/);
  assert.throws(() => recordPayout(L2, { seller_id: K, amount: 1000, currency: "VND", paid_at: "2026-10-17T09:00:00.000Z", reference: "vcb-tf072-1", actor_user_id: "chris", now: new Date("2026-10-18T08:00:00Z") }), /bereits erfasst/);
  // Refund → REVERSED mit dem 60-%-Betrag.
  const L3 = derive(L2, [{ ...o, payment_status: "REFUNDED", paid_amount: 0 }], K).ledger.entries[id];
  assert.deepEqual([L3.status, L3.reversed_minor, L3.payable_minor, L3.rate_bps], ["REVERSED", 594000, 0, 6000]);
});

test("TF-072 Auftrags-Snapshot: neue Aufträge speichern commission_rate_bps 6000 (CH + VN), Anfrage → Auftrag übernimmt den Satz, Snapshot-Allowlist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-072-")), store = createStore(dir);
  const now = new Date(AFTER);
  const c = createCheck150Order(store, { domain: "muster.ch", company: "Muster AG", delivery_email: "auftrag@muster.ch", now });
  const r = createRepairOrder(store, { domain: "muster2.ch", company: "Muster 2 AG", delivery_email: "auftrag@muster2.ch", now });
  const v = createRepairOrder(store, { domain: "cong-ty-b.vn", company: "Công ty B", delivery_email: "lienhe@cong-ty-b.vn", offer_class: "VN_REPAIR_FIX", now });
  assert.deepEqual([c.commission_rate_bps, r.commission_rate_bps, v.commission_rate_bps], [6000, 6000, 6000]);
  // VN-Anfrage mit gespeichertem Satz → Auftrag trägt genau diesen Satz.
  const req = { request_id: "11111111-2222-3333-4444-555555555555", lead_id: "cong-ty-c.vn", offer_class: "VN_REPAIR_CHECK", market: "VN", currency: "VND", price: 990000, domain: "cong-ty-c.vn",
    website: "https://cong-ty-c.vn/", company: "Công ty C", delivery_email: "lienhe@cong-ty-c.vn", actor_user_id: K, seller_id: K, confirmed_at: AFTER, commission_rate_bps: 6000 };
  const res = applyOrderRequest(store, req, { now });
  assert.equal(res.ok, true, JSON.stringify(res));
  const pubC = publicCheck150Orders(dir).orders.find((o) => o.order_id === res.order_id);
  assert.equal(pubC.commission_rate_bps, 6000);
  assert.equal(publicRepairOrders(dir).orders.find((o) => o.order_id === r.order_id).commission_rate_bps, 6000);
  // Server-Control-Allowlist reicht den Satz durch (nur gültige bps).
  assert.equal(cleanCheck150({ orders: [pubC] }).orders[0].commission_rate_bps, 6000);
  assert.equal(cleanRepair({ orders: [{ ...publicRepairOrders(dir).orders[0], commission_rate_bps: 999999 }] }).orders[0].commission_rate_bps, null);
  // Ledger nutzt den gespeicherten Satz des Auftrags.
  assert.equal(ordersFromSnapshot({ check150: { orders: [pubC] } })[0].commission_rate_bps, 6000);
});

test("TF-072 API: Kudoshin-Anfrage speichert 6000 bps; Dashboard je Auftrag Satz/Provision; Verkäufer sehen nur eigene Provision mit 60 %", async () => {
  const s = await setup({ ch: 30, vn: 6 });
  const sales = createSalesHandler({ env, data: s.data, getSalesStore: async (k) => (s.salesMem[k] ||= memoryStore()), getAuthStore: async () => authStoreFrom((k) => s.authMem[k]) });
  const lead = (await s.json(await s.crm(makeReq("/api/crm", s.as(K))))).body.leads.find((l) => l.email && !l.do_not_contact);
  const created = await s.json(await sales(makeReq("/api/sales", { method: "POST", cookie: s.cookies[K], body: { op: "order.createConfirmed", lead_id: lead.lead_id, offer: "FIX", confirmed: true } })));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.deepEqual([created.body.order.commission_rate_bps, created.body.order.commission_expected], [6000, "2340000"]);
  assert.equal(s.salesMem.orders.peek().requests.at(-1).commission_rate_bps, 6000);
  // Mitgeschickter Satz vom Client → 400 (Server bestimmt den Satz).
  assert.equal((await sales(makeReq("/api/sales", { method: "POST", cookie: s.cookies[K], body: { op: "order.createConfirmed", lead_id: lead.lead_id, offer: "FIX", confirmed: true, commission_rate_bps: 10000 } }))).status, 400);
  // VPS-Abholung bekommt den Satz mit.
  const pulled = await s.json(await sales(makeReq("/api/sales", { method: "POST", origin: null, body: { op: "orders.pull" }, headers: { "x-jarvis-worker": env("JARVIS_MAIL_WORKER_TOKEN") } })));
  assert.equal(pulled.body.requests[0].commission_rate_bps, 6000);
  // Dashboard (Owner): Aufträge mit Verkäufer, Angebot, Preis, Währung, Satz, Provision, Zahlungs- und Provisionsstatus.
  const vnL = (await s.stores.vnView.get()).state.leads.find((l) => l.lead_id === lead.lead_id);
  // Auftrag NACH der Provisions-Aktivierung (eligible_from = jetzt) – fester Zeitpunkt wäre ab 2026-10-17 08:00 UTC «historisch» (Datumsfalle, TF-076 behoben).
  const snap = { repair: { orders: [snapOrder("VNFIX-20261017-ddddd1", vnL.domain, "VN_REPAIR_FIX", "VN", "VND", 3900000, new Date(Date.now() + 60_000).toISOString(), { commission_rate_bps: 6000 })] } };
  const { state, etag } = await s.stores.control.get();
  assert.ok(await s.stores.control.set({ ...(state || {}), snapshot: snap }, etag));
  const so = await s.json(await sales(makeReq("/api/sales?view=sales_overview", s.as("chris"))));
  assert.equal(so.status, 200);
  const o = so.body.orders.find((x) => x.order_id === "VNFIX-20261017-ddddd1");
  assert.deepEqual([o.seller_id, o.offer, o.price, o.currency, o.commission_rate_bps, o.commission, o.payment_status, o.commission_status], [K, "FIX", 3900000, "VND", 6000, "2340000", "PAID_FULL", "PAYABLE"]);
  assert.equal(so.body.rate_bps, 6000); assert.match(so.body.rule, /60 % \(6000 bps\)/);
  assert.deepEqual(so.body.sellers.filter((x) => x.seller_id !== "direct").map((x) => x.rate_bps), [6000, 6000, 6000, 6000]);
  // Verkäufer: nur eigene Provision, Satz 60 %; Owner-Sicht verboten.
  const mine = await s.json(await sales(makeReq("/api/sales?view=commission", s.as(K))));
  assert.deepEqual([mine.body.commission.seller_id, mine.body.commission.rate_bps, mine.body.commission.payable], [K, 6000, "2340000"]);
  for (const u of ["giuliano", "mario", "damiano"]) {
    const m = await s.json(await sales(makeReq("/api/sales?view=commission", s.as(u))));
    assert.deepEqual([m.status, m.body.commission.seller_id, m.body.commission.rate_bps, m.body.commission.orders.length], [200, u, 6000, 0], u);
    assert.equal((await sales(makeReq("/api/sales?view=sales_overview", s.as(u)))).status, 403, u);
  }
  assert.equal((await sales(makeReq("/api/sales?view=sales_overview", s.as(K)))).status, 403);
});
