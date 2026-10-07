// Vertrieb: genau zwei Angebote (CHF 150 / CHF 500), Evidence nur aus echten Audit-Befunden, Lead-Lebenszyklus,
// Verkäufe und Kennzahlen – ohne die Versandgrundlagen-Prüfung je aufzuweichen. Ohne Netzwerk.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OFFERS, OFFER_CLASSES, NONE, classifyOffer, observedEvidence, recordSale, setPipelineStatus, lifecycleStatus, loadPipeline, computeMetrics, persistMetrics, LIFECYCLE } from "../sales.js";
import { legalBasis, HARD_LIMIT, DEFAULT_CONFIG } from "../mail-worker.js";
import { DAILY_SEND_LIMIT, assertOwnedDraft } from "../gmail.js";
import { sanitizeState, findSensitiveKeys } from "../shared-state.js";

const T0 = new Date("2026-10-06T08:00:00Z");
const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const issue = (type, severity, evidence = `Beleg für ${type}`, url = "https://muster.ch/") => ({ type, url, evidence, severity, detectedAt: T0.toISOString() });
const discoveredLead = (over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: "https://muster.ch/", domain: "muster.ch", approved: false, consentBasis: null,
  consentAt: null, consentSource: null, existingCustomer: false, similarService: false, status: "blocked_no_legal_basis", auditedAt: T0.toISOString(),
  reachable: true, websiteIssues: [issue("broken_link", "medium", "HTTP 404 (verlinkt auf https://muster.ch/)", "https://muster.ch/alt")], ...over,
});

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-sales-")); });
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));

// ---------- Angebote ----------

test("es gibt genau zwei Angebote: CHF 150 und CHF 480 – keine dritte Klasse", () => {
  assert.deepEqual(OFFER_CLASSES, ["REPAIR_CHECK_150", "REPAIR_FIX_500"]);
  assert.deepEqual(OFFER_CLASSES.map((c) => OFFERS[c].price), [150, 480]);
  assert.ok(Object.isFrozen(OFFERS));
  assert.throws(() => { OFFERS.REDESIGN_2490 = { price: 2490 }; });
  // Über alle denkbaren Befund-Kombinationen kommt nur 150, 500 oder NONE heraus.
  const types = ["https_certificate", "no_https", "redirect_loop", "mixed_content", "broken_link", "broken_image", "contact_page_broken", "http_error",
    "missing_title", "slow_response", "outdated_cms", "outdated_technology", "unreachable", "no_mobile_viewport", "missing_meta_description", "missing_lang", "missing_alt", "no_https_redirect", "outdated_library", "outdated_content"];
  const seen = new Set();
  for (const t of types) for (const sev of ["low", "medium", "high"]) for (const extra of [[], [issue("missing_alt", "low")], [issue("broken_image", "medium")]]) {
    seen.add(classifyOffer(discoveredLead({ websiteIssues: [issue(t, sev), ...extra] })).offer_class);
  }
  for (const c of seen) assert.ok([...OFFER_CLASSES, NONE].includes(c), c);
  const src = fs.readFileSync(path.join(ROOT, "sales.js"), "utf8") + fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.doesNotMatch(src, /2['’]?490|redesign_|neubau_|REPAIR_[A-Z]+_(?!150|500)\d+/i, "keine weitere Preisstufe im Code oder Dashboard");
});

test("CHF-480: konkrete, behebbare Probleme auf bestehender Website", () => {
  const c = classifyOffer(discoveredLead({ websiteIssues: [issue("https_certificate", "high", "TLS-Fehler beim Aufruf: CERT_HAS_EXPIRED"), issue("missing_alt", "low")] }));
  assert.equal(c.offer_class, "REPAIR_FIX_500");
  assert.equal(c.price_chf, 480);
  assert.equal(c.confidence, "high");
  assert.deepEqual(c.evidence.map((e) => e.type), ["https_certificate"]);
  for (const k of ["offer_class", "confidence", "evidence", "rationale", "recommended_next_step"]) assert.ok(k in c, k);
  assert.equal(classifyOffer(discoveredLead()).offer_class, "REPAIR_FIX_500", "kaputter interner Link (404) ist reparierbar");
});

test("CHF-150: nur Hinweise für eine Prüfung, keine konkrete Reparatur", () => {
  const c = classifyOffer(discoveredLead({ websiteIssues: [issue("missing_meta_description", "low"), issue("missing_lang", "low")] }));
  assert.equal(c.offer_class, "REPAIR_CHECK_150");
  assert.equal(c.price_chf, 150);
  assert.equal(c.evidence.length, 2);
  assert.equal(classifyOffer(discoveredLead({ websiteIssues: [issue("no_mobile_viewport", "medium")] })).offer_class, "REPAIR_CHECK_150");
  assert.equal(classifyOffer(discoveredLead({ websiteIssues: [issue("outdated_technology", "high", "Flash-Inhalt (.swf) eingebunden")] })).offer_class, "REPAIR_CHECK_150",
    "veraltete Technik: kein Reparaturversprechen (Neubau wird nicht angeboten)");
});

test("ungenügende Evidence → NONE", () => {
  assert.equal(classifyOffer(discoveredLead({ websiteIssues: [] })).offer_class, NONE);
  assert.equal(classifyOffer(discoveredLead({ websiteIssues: undefined })).offer_class, NONE);
  assert.equal(classifyOffer(discoveredLead({ websiteIssues: [issue("missing_alt", "low")] })).offer_class, NONE, "ein einzelner Kleinbefund reicht nicht");
  const down = classifyOffer(discoveredLead({ reachable: false, websiteIssues: [issue("unreachable", "high", "Keine Antwort: HTTPS ENOTFOUND, HTTP ENOTFOUND")] }));
  assert.equal(down.offer_class, NONE);
  assert.equal(down.price_chf, null);
});

test("keine erfundene Evidence: nur beobachtete Befunde mit Beleg, nichts kommt hinzu", () => {
  const real = issue("broken_image", "medium", "Bild liefert HTTP 404", "https://muster.ch/a.png");
  const fake = [
    { type: "broken_link", url: "https://muster.ch/x", severity: "high", detectedAt: T0.toISOString() }, // ohne Beleg
    { type: "slow_response", url: "https://muster.ch/", evidence: "  ", severity: "high", detectedAt: T0.toISOString() }, // leerer Beleg
    { type: "redirect_loop", url: "muster.ch", evidence: "x", severity: "high", detectedAt: T0.toISOString() }, // keine URL
    { type: "http_error", url: "https://muster.ch/", evidence: "x", severity: "kritisch", detectedAt: T0.toISOString() }, // unbekannter Schweregrad
    { type: "mixed_content", url: "https://muster.ch/", evidence: "x", severity: "high" }, // ohne Zeitpunkt
    "Website ist langsam",
  ];
  assert.deepEqual(observedEvidence([real, ...fake]), [real]);
  const c = classifyOffer(discoveredLead({ websiteIssues: [real, ...fake] }));
  assert.deepEqual(c.evidence, [real]);
  const onlyFake = classifyOffer(discoveredLead({ websiteIssues: fake }));
  assert.equal(onlyFake.offer_class, NONE);
  assert.deepEqual(onlyFake.evidence, []);
  // Jeder Evidence-Eintrag ist wörtlich ein Audit-Befund
  for (const e of classifyOffer(discoveredLead({ websiteIssues: [real, issue("no_https", "medium")] })).evidence) assert.ok([real, issue("no_https", "medium")].some((i) => JSON.stringify(i) === JSON.stringify(e)));
});

// ---------- Compliance ----------

test("öffentliche E-Mail-Adresse allein erzeugt KEINE Versandberechtigung", () => {
  const lead = discoveredLead();
  assert.equal(legalBasis(lead, T0), null);
  assert.equal(legalBasis({ ...lead, approved: true }, T0), null, "auch freigegeben ohne Einwilligung nicht");
  assert.equal(legalBasis({ ...lead, approved: true, consentBasis: "opt_in" }, T0), null, "opt_in ohne Zeitpunkt und Quelle nicht");
  const c = classifyOffer(lead);
  assert.equal(c.offer_class, "REPAIR_FIX_500");
  assert.match(c.recommended_next_step, /NICHT VERSANDBERECHTIGT/);
  write("discovered.json", { leads: { "muster.ch": lead } });
  const { leads } = loadPipeline({ dir, now: T0 });
  assert.equal(leads[0].eligible, false);
  assert.equal(leads[0].legalBasisStatus, "NICHT VERSANDBERECHTIGT");
  assert.equal(computeMetrics(leads, T0).eligible_to_contact, 0);
  // Kein Mechanismus, um eine öffentliche Adresse zum Opt-in zu machen
  const src = fs.readFileSync(path.join(ROOT, "sales.js"), "utf8") + fs.readFileSync(path.join(ROOT, "server.js"), "utf8") + fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.doesNotMatch(src, /consentBasis\s*[:=]\s*["']opt_in|consentAt\s*=|approved\s*=\s*true/);
});

test("blocked_no_legal_basis bleibt blockiert – auch mit Angebot, Antwortstatus oder Verkauf an anderer Stelle", () => {
  const lead = discoveredLead();
  assert.equal(lifecycleStatus(lead, { now: T0 }), "blocked_no_legal_basis");
  assert.equal(lifecycleStatus({ ...lead, approved: true }, { now: T0 }), "blocked_no_legal_basis");
  const records = recordSale({}, "andere.ch", { offer: "REPAIR_CHECK_150", lead: {}, now: T0 });
  assert.equal(lifecycleStatus(lead, { now: T0, record: records["muster.ch"] }), "blocked_no_legal_basis");
  const after = structuredClone(lead);
  recordSale({}, "muster.ch", { offer: "REPAIR_FIX_500", lead: after, now: T0 });
  assert.deepEqual(after, lead, "ein Verkauf ändert nie die Versandgrundlage des Leads");
  // Mit echter Grundlage: approved
  const ok = { ...lead, approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular", status: undefined };
  assert.equal(lifecycleStatus(ok, { now: T0 }), "approved");
});

test("Suppression bleibt aktiv: do_not_contact hat Vorrang vor allem", () => {
  const lead = { ...discoveredLead(), approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular", status: undefined };
  assert.equal(lifecycleStatus(lead, { now: T0, suppression: { "info@muster.ch": { reason: "opt-out" } } }), "do_not_contact");
  write("leads.json", [lead]);
  write("suppression.json", { "info@muster.ch": { reason: "opt-out" } });
  const { leads } = loadPipeline({ dir, now: T0 });
  assert.equal(leads[0].status, "do_not_contact");
  assert.equal(leads[0].eligible, false);
  assert.equal(computeMetrics(leads, T0).eligible_to_contact, 0);
});

test("Tageslimit 100 (je Fenster 50) überall gleich", () => {
  assert.equal(HARD_LIMIT, 100);
  assert.equal(DAILY_SEND_LIMIT, 100);
  assert.equal(DEFAULT_CONFIG.dailyLimit, 100);
  assert.equal(sanitizeState({ business: { worker: { todaySent: 180, limit: 999 } } }).business.worker.limit, 100);
  assert.equal(sanitizeState({ business: { worker: { windows: { morning: { count: 70, limit: 99 } } } } }).business.worker.windows.morning.limit, 50);
});

test("fremde Gmail-Entwürfe bleiben geschützt", async () => {
  await assert.rejects(assertOwnedDraft("fremder-entwurf", { drafts: {}, sent: {} }), /nicht von Jarvis erstellt/);
  for (const f of ["sales.js", "local-core.js"]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /sendDraft|createDraft|updateDraft|replyToThread/, f);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"), /sendDraft|createDraft|updateDraft|replyToThread/, "Server nutzt Gmail nur lesend (Register)");
});

// ---------- Pipeline und Kennzahlen ----------

test("Lebenszyklus: alle Stufen, bestehende Datensätze ohne Migration", () => {
  assert.deepEqual([...LIFECYCLE], ["discovered", "audited", "repair_candidate", "blocked_no_legal_basis", "approved", "contacted", "replied", "customer", "not_interested", "do_not_contact"]);
  const basis = { approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Formular" };
  const L = (o) => ({ ...discoveredLead(), status: undefined, ...o });
  assert.equal(lifecycleStatus({ status: "discovered" }, { now: T0 }), "discovered");
  assert.equal(lifecycleStatus(L({ status: "no_issues", websiteIssues: [] }), { now: T0 }), "audited");
  assert.equal(lifecycleStatus(L({ status: "low_score", websiteIssues: [issue("missing_alt", "low")] }), { now: T0 }), "audited");
  assert.equal(lifecycleStatus(L({ status: "no_contact" }), { now: T0 }), "repair_candidate");
  assert.equal(lifecycleStatus(L({}), { now: T0 }), "repair_candidate");
  assert.equal(lifecycleStatus(L({ status: "blocked_no_legal_basis" }), { now: T0 }), "blocked_no_legal_basis");
  assert.equal(lifecycleStatus(L(basis), { now: T0 }), "approved");
  assert.equal(lifecycleStatus(L(basis), { now: T0, contacted: new Set(["info@muster.ch"]) }), "contacted");
  assert.equal(lifecycleStatus(L(basis), { now: T0, contacted: new Set(["info@muster.ch"]), replied: new Set(["info@muster.ch"]) }), "replied");
  assert.equal(lifecycleStatus(L(basis), { now: T0, record: { status: "not_interested" } }), "not_interested");
  assert.equal(lifecycleStatus(L(basis), { now: T0, record: recordSale({}, "muster.ch", { offer: "REPAIR_CHECK_150", now: T0 })["muster.ch"] }), "customer");
  assert.equal(lifecycleStatus(L({ status: "suppressed" }), { now: T0 }), "do_not_contact");
  assert.throws(() => setPipelineStatus({}, "muster.ch", "customer"), /nur replied und not_interested/);
});

test("Verkauf: nur CHF 150 oder CHF 480, Wert immer aus dem Angebot", () => {
  const lead = discoveredLead();
  const r = recordSale({}, "muster.ch", { offer: "REPAIR_FIX_500", date: "2026-10-06", lead, now: T0 })["muster.ch"];
  assert.deepEqual(Object.keys(r.sale).sort(), ["currency", "customer_status", "evidence", "sale_date", "sale_value", "selected_offer", "work_status"]);
  assert.equal(r.sale.sale_value, 480);
  assert.equal(r.sale.customer_status, "customer");
  assert.equal(r.sale.work_status, "open");
  assert.deepEqual(r.sale.evidence, observedEvidence(lead.websiteIssues));
  assert.equal(recordSale({}, "x", { offer: "REPAIR_CHECK_150", now: T0 }).x.sale.sale_value, 150);
  for (const bad of ["REDESIGN", "REPAIR_2490", "NONE", "", undefined, "repair_fix_500"]) assert.throws(() => recordSale({}, "x", { offer: bad, now: T0 }), /Erlaubt sind nur/);
  assert.throws(() => recordSale({}, "x", { offer: "REPAIR_FIX_500", date: "06.10.2026" }), /JJJJ-MM-TT/);
});

test("Kennzahlen: Kandidaten, Verkäufe und Umsatz nur aus den zwei Angeboten; manipulierte Verkäufe zählen nicht", () => {
  write("discovered.json", { leads: {
    "a.ch": discoveredLead({ domain: "a.ch", website: "https://a.ch/", email: "info@a.ch" }),
    "b.ch": discoveredLead({ domain: "b.ch", website: "https://b.ch/", email: "info@b.ch", websiteIssues: [issue("missing_lang", "low"), issue("missing_alt", "low")] }),
    "c.ch": discoveredLead({ domain: "c.ch", website: "https://c.ch/", email: null, status: "no_issues", websiteIssues: [] }),
    "d.ch": { domain: "d.ch", website: "https://d.ch/", status: "discovered", websiteIssues: [] },
  } });
  let records = recordSale({}, "a.ch", { offer: "REPAIR_FIX_500", now: T0 });
  records = recordSale(records, "b.ch", { offer: "REPAIR_CHECK_150", now: T0 });
  records["c.ch"] = { status: "customer", sale: { selected_offer: "REDESIGN_2490", sale_value: 2490 } }; // von Hand manipuliert
  records["d.ch"] = { sale: { selected_offer: "REPAIR_FIX_500", sale_value: 9999 } }; // falscher Preis
  write("sales.json", { records });
  const m = persistMetrics({ dir, now: T0 });
  const legacy = ["discovered", "audited", "qualified_repair", "offer_150_candidates", "offer_500_candidates", "eligible_to_contact", "blocked_no_legal_basis", "contacted",
    "replies", "customers", "sales_150", "sales_500", "revenue_150", "revenue_500", "total_revenue"];
  assert.deepEqual({ ...Object.fromEntries(legacy.map((k) => [k, m[k]])), updatedAt: undefined }, { updatedAt: undefined,
    discovered: 4, audited: 3, qualified_repair: 2, offer_150_candidates: 1, offer_500_candidates: 1, eligible_to_contact: 0,
    blocked_no_legal_basis: 0, contacted: 0, replies: 0, customers: 2, sales_150: 1, sales_500: 1, revenue_150: 150, revenue_500: 480, total_revenue: 630 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "metrics.json"), "utf8")).total_revenue, 630, "persistiert");
  // Kennzahlen sind sicher für den gemeinsamen Zustand: nur Zahlen, keine Lead-Daten
  const shared = sanitizeState({ sales: { ...m, company: "Muster AG", email: "info@a.ch" } });
  assert.equal(shared.sales.total_revenue, 630);
  assert.ok(!JSON.stringify(shared).includes("info@a.ch"));
  assert.deepEqual(findSensitiveKeys(shared), []);
});

test("Kennzahlen kontaktiert/Antworten aus Jarvis-Register und Worker-Zustand", () => {
  const basis = { approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true };
  write("leads.json", [{ ...discoveredLead({ status: undefined }), ...basis }]);
  write("state.json", { actions: { "reply:m1": { status: "prepared", to: "Info@Muster.ch" } } });
  const registry = { sent: { s1: { to: "Muster AG <info@muster.ch>", sentAt: "2026-10-01T09:00:00Z" } }, drafts: {} };
  const { leads } = loadPipeline({ dir, registry, now: T0 });
  assert.equal(leads[0].status, "replied");
  assert.equal(leads[0].lastContactAt, "2026-10-01T09:00:00Z");
  const m = computeMetrics(leads, T0);
  assert.equal(m.contacted, 1);
  assert.equal(m.replies, 1);
});
