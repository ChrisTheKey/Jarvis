// SALE VOID / TEST-SALE REVERSAL (TF-040): `node sales.js void-sale <domain> --reason "<grund>"` storniert einen
// versehentlich erfassten Verkauf OHNE ihn zu löschen (sale_status=voided, voided_at, void_reason; Original bleibt).
// Fail closed: exakte Domain, Grund Pflicht, offene/abgeschlossene Aufträge blockieren. Ein voided Verkauf zählt nirgends
// mehr (Umsatz, sales_150/500, Kunden, Dashboard) und bestätigt NIE einen CHF-150- oder CHF-480-Workflow. Nach dem Void
// eines Direkt-/Testkunden gibt es keinen Cold-Outreach-Reentry, keine Gmail- und keine Website-Aktion. Ohne Netz.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { OFFERS, recordSale, recordDirectSale, voidSale, collectDomainOrders, isVoidedSale, loadPipeline, computeMetrics, lifecycleStatus } from "../sales.js";
import { reconcileRegistry, loadRegistry, registryBlock } from "../lead-registry.js";
import { publicLead, deriveStatus, contactBlockReason, leadStats, filterLeads, mergeLead } from "../lead-db.js";
import { CHECK150_ORDERS_FILE, createCheck150Order, cancelCheck150Order, createCheck150Engine, confirmedCheck150Sale } from "../check-150-workflow.js";
import { REPAIR_ORDERS_FILE, NEVER_AUTHORIZATION, createRepairOrder, authorizeRepair } from "../repair-workflow.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T12:00:00Z");
let dir, store;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-void-")); store = createStore(dir); });

const directSale = (over = {}) => recordDirectSale({}, { domain: "echtefirma.ch", offer: "REPAIR_CHECK_150",
  delivery_email: "info@echtefirma.ch", company: "Echte Firma AG", contact_name: "Max Muster", now: T0, ...over });
const voided = (over = {}) => voidSale(directSale(), "echtefirma.ch", { reason: "Testverkauf mit Platzhalterdaten", now: T0, ...over });
const issue = (type, severity) => ({ type, url: "https://muster.ch/", evidence: `Beleg für ${type}`, severity, detectedAt: T0.toISOString() });
const jarvisLead = () => ({ domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", email: "info@muster.ch",
  status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true, websiteIssues: [issue("broken_link", "medium")] });

function fakeGmail() {
  const calls = [];
  return { calls,
    createDraft: async (x) => { calls.push({ op: "create", to: x.to }); return { draftId: "dr1", threadId: "t1", messageId: "m1" }; },
    updateDraft: async (id) => { calls.push({ op: "update", id }); return { draftId: id }; },
    sendDraft: async () => { calls.push({ op: "SEND" }); throw new Error("darf nie aufgerufen werden"); } };
}
function fakeAuditor() {
  const calls = [];
  return { calls, audit: async (website) => { calls.push(website); return { website, reachable: true, finalUrl: website, title: "x", issues: [], pages: {}, requests: 1 }; } };
}

// 1+2+3) Fail closed: unbekannte Domain, Datensatz ohne Verkauf, fehlender Grund, ungültige Domain – und NIE Fuzzy-Match.
test("1-3: void-sale blockiert unbekannte Domain, fehlenden Verkauf, fehlenden Grund, ungültige Domain", () => {
  const records = directSale();
  assert.throws(() => voidSale(records, "andereFirma.ch", { reason: "x", now: T0 }), /Kein Verkaufs-Datensatz/);
  // Ähnliche Domain wird NIE automatisch gewählt – exakter Treffer oder Fehler.
  assert.throws(() => voidSale(records, "echtefirma.com", { reason: "x", now: T0 }), /Kein Verkaufs-Datensatz/);
  assert.throws(() => voidSale(records, "www.echtefirmaa.ch", { reason: "x", now: T0 }), /Kein Verkaufs-Datensatz/);
  assert.throws(() => voidSale({ "nurstatus.ch": { status: "replied" } }, "nurstatus.ch", { reason: "x", now: T0 }), /kein Verkauf erfasst/);
  for (const bad of [undefined, null, "", "   "]) assert.throws(() => voidSale(records, "echtefirma.ch", { reason: bad, now: T0 }), /--reason/);
  for (const bad of ["", "ohnepunkt", undefined]) assert.throws(() => voidSale(records, bad, { reason: "x", now: T0 }), /Ungültige Domain/);
  assert.ok(!isVoidedSale(records["echtefirma.ch"].sale), "fehlgeschlagene Voids verändern nichts");
});

// 4+8) Void ist KEIN Löschen: Markierung + Grund + Zeitpunkt, alle Originaldaten bleiben vollständig erhalten.
test("4/8: Void markiert, löscht nie – Historie (Offer, Betrag, Datum, Quelle, Stammdaten) bleibt", () => {
  const before = directSale();
  const after = voided();
  const rec = after["echtefirma.ch"], sale = rec.sale;
  assert.equal(sale.sale_status, "voided");
  assert.equal(sale.voided, true);
  assert.equal(sale.voided_at, T0.toISOString());
  assert.equal(sale.void_reason, "Testverkauf mit Platzhalterdaten");
  // Originaldaten unverändert erhalten:
  assert.equal(sale.selected_offer, "REPAIR_CHECK_150");
  assert.equal(sale.sale_value, OFFERS.REPAIR_CHECK_150.price);
  assert.equal(sale.sale_date, "2026-10-12");
  assert.equal(sale.currency, "CHF");
  assert.deepEqual(rec.direct_sale, before["echtefirma.ch"].direct_sale, "ursprünglicher Kundendatensatz (Quelle) bleibt");
  assert.equal(rec.status, "sale_voided");
  // voidSale ist pure: Eingabe-Records unverändert.
  assert.ok(!isVoidedSale(before["echtefirma.ch"].sale));
});

// 5) Zweites Void → blockiert (idempotent sicher, nichts wird überschrieben).
test("5: bereits voided → zweites Void blockiert", () => {
  const once = voided();
  assert.throws(() => voidSale(once, "echtefirma.ch", { reason: "nochmal", now: T0 }), /bereits storniert/);
  assert.equal(once["echtefirma.ch"].sale.void_reason, "Testverkauf mit Platzhalterdaten", "erster Grund bleibt");
});

// 6+7+17) Umsatz/sales_150/Kunden fallen korrekt zurück; andere echte Verkäufe bleiben unverändert.
test("6/7/17: Kennzahlen ohne voided Verkauf; fremde Verkäufe unberührt", () => {
  store.write("discovered.json", { leads: { "muster.ch": jarvisLead(), "kunde2.ch": { ...jarvisLead(), domain: "kunde2.ch", website: "https://kunde2.ch/", email: "info@kunde2.ch" } } });
  let records = recordSale({}, "muster.ch", { offer: "REPAIR_CHECK_150", lead: jarvisLead(), now: T0 });
  records = recordSale(records, "kunde2.ch", { offer: "REPAIR_FIX_500", lead: jarvisLead(), now: T0 });
  store.write("sales.json", { records });
  const before = computeMetrics(loadPipeline({ dir, now: T0 }).leads, T0);
  assert.deepEqual([before.sales_150, before.sales_500, before.revenue_150, before.revenue_500, before.total_revenue, before.customers], [1, 1, 150, 480, 630, 2]);
  store.write("sales.json", { records: voidSale(records, "muster.ch", { reason: "Testverkauf", now: T0 }) });
  const p = loadPipeline({ dir, now: T0 });
  const after = computeMetrics(p.leads, T0);
  assert.deepEqual([after.sales_150, after.sales_500, after.revenue_150, after.revenue_500, after.total_revenue, after.customers], [0, 1, 0, 480, 480, 1],
    "CHF 150 fällt auf 0, der echte CHF-480-Verkauf von kunde2.ch bleibt");
  const musterLead = p.leads.find((l) => l.key === "muster.ch");
  assert.equal(musterLead.sale, null, "voided Verkauf erscheint nicht mehr als aktiver Verkauf");
  assert.notEqual(musterLead.status, "customer");
  assert.deepEqual(p.records["kunde2.ch"].sale.selected_offer, "REPAIR_FIX_500", "fremder Datensatz byteweise unangetastet");
  assert.ok(isVoidedSale(p.records["muster.ch"].sale), "Historie bleibt in sales.json gespeichert");
});

// 9+10+11) Verknüpfte Aufträge: CANCELLED erlaubt Void; offener Auftrag blockiert; COMPLETED blockiert (manuelle Prüfung).
test("9-11: Auftrags-Guard – CANCELLED ok, offen blockiert, COMPLETED blockiert", () => {
  const records = directSale();
  // Offener Auftrag (ORDER_RECEIVED) → blockiert mit klarer Meldung.
  const o = createCheck150Order(store, { domain: "echtefirma.ch", delivery_email: "info@echtefirma.ch", now: T0 });
  assert.throws(() => voidSale(records, "echtefirma.ch", { reason: "x", relatedOrders: collectDomainOrders(store, "echtefirma.ch"), now: T0 }),
    /zuerst Auftrag stornieren/);
  // Nach Stornierung des Auftrags → Void erlaubt.
  cancelCheck150Order(store, o.order_id, { reason: "Testauftrag", now: T0 });
  const ok = voidSale(records, "echtefirma.ch", { reason: "Testverkauf", relatedOrders: collectDomainOrders(store, "echtefirma.ch"), now: T0 });
  assert.ok(isVoidedSale(ok["echtefirma.ch"].sale));
  // COMPLETED (echter gelieferter Auftrag) → fail closed, kein automatisches Void.
  const done = store.read(CHECK150_ORDERS_FILE, { orders: {} });
  done.orders["CA150-20260101-aaaaaa"] = { order_id: "CA150-20260101-aaaaaa", domain: "echtefirma.ch", state: "COMPLETED" };
  store.write(CHECK150_ORDERS_FILE, done);
  assert.throws(() => voidSale(records, "echtefirma.ch", { reason: "x", relatedOrders: collectDomainOrders(store, "echtefirma.ch"), now: T0 }),
    /COMPLETED.*manuelle Prüfung/);
  // CHF-480-Aufträge zählen ebenfalls: offener Repair-Auftrag blockiert.
  const store2 = createStore(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-void2-")));
  createRepairOrder(store2, { domain: "echtefirma.ch", now: T0 });
  const r480 = recordDirectSale({}, { domain: "echtefirma.ch", offer: "REPAIR_FIX_500", delivery_email: "info@echtefirma.ch", now: T0 });
  assert.throws(() => voidSale(r480, "echtefirma.ch", { reason: "x", relatedOrders: collectDomainOrders(store2, "echtefirma.ch"), now: T0 }),
    /zuerst Auftrag stornieren/);
  // Aufträge ANDERER Domains blockieren nie.
  assert.ok(isVoidedSale(voidSale(records, "echtefirma.ch", { reason: "x", relatedOrders: [{ order_id: "CA150-x", state: "ORDER_RECEIVED", domain: "andere.ch" }], now: T0 })["echtefirma.ch"].sale));
});

// 12) Ein voided Verkauf bestätigt NIE einen CHF-150-Auftrag: Engine bleibt blockiert, kein Audit, keine Gmail-Aktion.
test("12: voided Sale bestätigt keinen CHECK150-Workflow (0 Audit, 0 Gmail)", async () => {
  store.write("sales.json", { records: voided() });
  assert.equal(confirmedCheck150Sale(store, "echtefirma.ch"), null, "voided ist keine Bestätigung");
  const o = createCheck150Order(store, { domain: "echtefirma.ch", delivery_email: "info@echtefirma.ch", now: T0 });
  const gmail = fakeGmail(), auditor = fakeAuditor();
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll();
  assert.equal(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id].state, "BLOCKED_ORDER_NOT_CONFIRMED");
  assert.equal(auditor.calls.length, 0, "kein Audit");
  assert.equal(gmail.calls.length, 0, "keine Gmail-Aktion");
  // Aktiver (nicht voided) Verkauf bestätigt weiterhin – Bestandsverhalten unverändert.
  store.write("sales.json", { records: directSale() });
  assert.ok(confirmedCheck150Sale(store, "echtefirma.ch"));
});

// 13) CHF-480: ein voided Verkauf ist NIE eine Reparaturfreigabe; der Workflow liest sales.json gar nicht.
test("13: voided Sale autorisiert keinen CHF-480-Auftrag", () => {
  const o = createRepairOrder(store, { domain: "echtefirma.ch", now: T0 });
  assert.ok(NEVER_AUTHORIZATION.includes("voided_sale"));
  assert.throws(() => authorizeRepair(store, o.order_id, { authorized_domain: "echtefirma.ch", source: "voided_sale", now: T0 }), /NIE eine Reparaturfreigabe/);
  assert.throws(() => authorizeRepair(store, o.order_id, { authorized_domain: "echtefirma.ch", source: "sales_record", now: T0 }), /NIE eine Reparaturfreigabe/);
  assert.equal(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id].customer_authorized_repair, false);
  // Der CHF-480-Workflow kennt sales.json nicht – ein Verkauf (voided oder nicht) kann dort nichts bestätigen.
  const src = fs.readFileSync(path.join(ROOT, "repair-workflow.js"), "utf8");
  assert.ok(!src.includes("sales.json"), "repair-workflow liest nie sales.json");
});

// 14) Kein Cold-Outreach-Reentry: Registry stuft nachvollziehbar auf voided_test_customer herab und blockiert Entwürfe.
test("14: nach Void keines Direkt-Testkunden je ein Cold-Entwurf (voided_test_customer)", () => {
  store.write("sales.json", { records: directSale() });
  reconcileRegistry(store, { now: T0, force: true });
  assert.equal(loadRegistry(store).leads["echtefirma.ch"].customer_status, "customer");
  store.write("sales.json", { records: voided() });
  reconcileRegistry(store, { now: new Date(+T0 + 60_000), force: true });
  const lead = loadRegistry(store).leads["echtefirma.ch"];
  assert.equal(lead.customer_status, "voided_test_customer", "nachvollziehbarer Status statt blindem Löschen");
  assert.equal(lead.status, "DISCARDED");
  assert.equal(deriveStatus(lead), "DISCARDED");
  assert.equal(contactBlockReason(lead), "stornierter Testverkauf");
  assert.equal(registryBlock(store, { domain: "echtefirma.ch" }), "stornierter Testverkauf", "kein automatischer Outreach-Reentry");
  // Quelle bleibt nachvollziehbar; Stammdaten bleiben erhalten.
  assert.equal(lead.discovery_source, "direct_customer");
  assert.equal(lead.company, "Echte Firma AG");
  // Dashboard/Export: zählt und erscheint nie als Kunde.
  const pub = publicLead(lead);
  assert.equal(pub.customer_status, "voided_test_customer");
  assert.equal(pub.status, "DISCARDED");
  assert.equal(leadStats([pub], T0).customers, 0);
  assert.deepEqual(filterLeads([pub], { view: "customers" }), []);
  // Ein echter Kunde mit anderem aktivem Verkauf bleibt Kunde (nur authoritative darf herabstufen, Rang nie).
  const kept = mergeLead({ lead_id: "k.ch", customer_status: "customer" }, { customer_status: "voided_test_customer" }, { now: T0 });
  assert.equal(kept.customer_status, "customer", "ohne authoritative keine Herabstufung");
  // Und nach einem späteren ECHTEN Verkauf wird aus voided_test_customer wieder customer.
  const back = mergeLead({ lead_id: "e.ch", customer_status: "voided_test_customer" }, { customer_status: "customer" }, { now: T0 });
  assert.equal(back.customer_status, "customer");
});

// 15+16) CLI-Weg Ende-zu-Ende: korrekte Meldung, Kennzahlen/Registry nachgeführt – keine Gmail-, keine Website-Aktion.
test("15/16: CLI void-sale – Meldung, Persistenz, 0 Sends, 0 Website-Writes", () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-void-sec-"));
  const wdir = path.join(secrets, "mail_worker");
  fs.mkdirSync(wdir, { recursive: true });
  const wstore = createStore(wdir);
  wstore.write("sales.json", { records: directSale() });
  const env = { ...process.env, JARVIS_SECRETS_DIR: secrets };
  // Ohne --reason → Fehler, nichts verändert.
  assert.throws(() => execFileSync(process.execPath, ["sales.js", "void-sale", "echtefirma.ch"], { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" }));
  assert.ok(!isVoidedSale(wstore.read("sales.json", {}).records["echtefirma.ch"].sale));
  const out = execFileSync(process.execPath, ["sales.js", "void-sale", "echtefirma.ch", "--reason", "Testverkauf mit Platzhalterdaten"], { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" });
  assert.match(out, /Verkauf storniert: echtefirma\.ch → VOIDED \(CHF 150\)\. Grund: Testverkauf mit Platzhalterdaten/);
  const rec = wstore.read("sales.json", {}).records["echtefirma.ch"];
  assert.ok(isVoidedSale(rec.sale) && rec.direct_sale, "voided persistiert, Historie erhalten");
  assert.equal(JSON.parse(fs.readFileSync(path.join(wdir, "metrics.json"), "utf8")).total_revenue, 0, "Kennzahlen nachgeführt");
  assert.equal(loadRegistry(wstore).leads["echtefirma.ch"].customer_status, "voided_test_customer", "Registry nachgeführt");
  // Zweites Void über CLI → Fehler (idempotent sicher).
  assert.throws(() => execFileSync(process.execPath, ["sales.js", "void-sale", "echtefirma.ch", "--reason", "nochmal"], { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" }));
  // Der neue Pfad kennt weder Versand noch Website-Schreiboperationen.
  const src = fs.readFileSync(path.join(ROOT, "sales.js"), "utf8");
  for (const verboten of ["sendDraft", "createDraft", "updateDraft", "replyToThread", "applyFix", "deployProduction", "repair-adapters", "netlify.com", "api.github.com"])
    assert.ok(!src.includes(verboten), `sales.js enthält "${verboten}"`);
});

// Pipeline-Lebenszyklus: ein Lead mit voided Verkauf ist nie "customer".
test("Lebenszyklus: voided Verkauf macht keinen customer-Status", () => {
  const rec = voided()["echtefirma.ch"];
  assert.notEqual(lifecycleStatus({ domain: "echtefirma.ch" }, { record: rec, now: T0 }), "customer");
});
