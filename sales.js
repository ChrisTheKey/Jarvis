// Jarvis Vertrieb für Helvetic Webdesign – genau ZWEI Angebote, Lead-Lebenszyklus, Verkäufe und Kennzahlen.
// Reine Auswertung: sendet nie, gibt nie frei und ändert keine Versandgrundlage. Ob ein Lead angeschrieben werden darf,
// entscheidet ausschliesslich legalBasis() aus mail-worker.js (opt_in / existing_customer / requested_contact).
// Swiss Repair Outreach (Schweiz-Signale, Website-Zustand, Einzelprüfung) liegt in swiss-repair.js.
//
// Angebote (keine weiteren Preisstufen, kein Neubau, kein Redesign, kein Upsell):
//   REPAIR_CHECK_150  CHF 150  Check & Anleitung: Fehler prüfen, erklären, Schritt-für-Schritt-Anleitung – Reparatur macht der Kunde selbst
//   REPAIR_FIX_500    CHF 480  Check & Reparatur: kompletter Check, alle gefundenen Fehler beheben, Test Desktop/Smartphone
// Die Klassen-IDs (…_500) bleiben aus Kompatibilität mit gespeicherten Daten; massgeblich ist OFFERS[…].price
// bzw. die Landingpage LANDING_PAGE_URL.
// Lässt sich keines aus belegten Audit-Befunden begründen: NONE. Evidence stammt nur aus websiteIssues des Audits.
//
//   node sales.js report                         Kennzahlen (auch in .secrets/mail_worker/metrics.json)
//   node sales.js leads                          Pipeline-Übersicht ohne Kontaktdaten
//   node sales.js sale <domain> <REPAIR_CHECK_150|REPAIR_FIX_500> [--date JJJJ-MM-TT] [--work open|in_progress|delivered]
//   node sales.js direct-sale <domain> <REPAIR_CHECK_150|REPAIR_FIX_500> --email <kunde@firma.ch>
//                 [--company "Firma AG"] [--name "Anrede"] [--website URL] [--date JJJJ-MM-TT] [--work …]
//                 Tatsächlich bestätigter Kundenauftrag (Formular/Direktanfrage/Empfehlung/Kontakt) – nur bewusst von
//                 Chris über die Kommandozeile. Braucht KEINEN bestehenden Discovery-Lead; erfindet nie Discovery-,
//                 Outreach- oder Versandgrundlagen-Historie (source = direct_customer, Basis = manual_confirmed_order).
//   node sales.js void-sale <domain> --reason "<grund>"
//                 Versehentlich erfassten Verkauf stornieren (TF-040): NIE löschen, nur markieren (sale_status=voided,
//                 voided_at, void_reason). Historie bleibt vollständig; voided zählt nirgends mehr als Umsatz/Kunde und
//                 bestätigt keinen Workflow. Fail closed: exakte Domain, Grund Pflicht, offene/abgeschlossene Aufträge blockieren.
//   node sales.js status <domain> <replied|not_interested>
//   node sales.js work <domain> <open|in_progress|delivered>
//
// VERKAUF != ZAHLUNG (TF-041): sale / direct-sale / create-confirmed / ORDER_CONFIRMED bestätigen nur den AUFTRAG –
// Geldeingang wird ausschliesslich im Payment-Ledger (payments.js, an die ORDER_ID gebunden) verbucht. Die Workflows
// starten die bezahlte Leistung erst ab der Zahlungsschwelle (CHF 75 bzw. CHF 240 = erste Hälfte des Festpreises).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore, legalBasis, normEmail } from "./mail-worker.js";
import { qualifyRepairLead, COLD_DRAFTS_FILE, FREEMAIL_RE } from "./swiss-repair.js";

export const OFFERS = Object.freeze({
  REPAIR_CHECK_150: Object.freeze({ price: 150, currency: "CHF", label: "Check & Anleitung für CHF 150", scope: "Ich prüfe Ihre Website auf Fehler, erkläre jedes gefundene Problem verständlich und liefere eine Schritt-für-Schritt-Anleitung, mit der Sie die Reparatur selbst durchführen können. Festpreis." }),
  REPAIR_FIX_500: Object.freeze({ price: 480, currency: "CHF", label: "Check & Reparatur für CHF 480", scope: "Kompletter Check der gesamten Website, alle gefundenen Fehler werden behoben und auf Desktop und Smartphone getestet. Festpreis, Rechnung erst nach Ihrer Abnahme – kein Fix, keine Rechnung." }),
});
export const OFFER_CLASSES = Object.freeze(Object.keys(OFFERS));
// Landingpage von Chris mit beiden Angeboten und Anfrageformular – wird in Werbemails verlinkt.
export const LANDING_PAGE_URL = "https://helvetic-webdesign-reperatur.netlify.app/";
export const NONE = "NONE";
export const isOfferClass = (c) => OFFER_CLASSES.includes(c);

export const LIFECYCLE = Object.freeze(["discovered", "audited", "repair_candidate", "blocked_no_legal_basis", "approved", "contacted", "replied", "customer", "not_interested", "do_not_contact"]);
export const WORK_STATUS = Object.freeze(["open", "in_progress", "delivered"]);

// Konkrete, auf der bestehenden Website behebbare Probleme (nur mit Schweregrad mittel/hoch) → Reparatur CHF 480.
const FIXABLE = new Set(["https_certificate", "no_https", "redirect_loop", "mixed_content", "broken_link", "broken_image", "contact_page_broken", "http_error", "missing_title", "slow_response", "outdated_cms"]);
// Diese Befunde sprechen gegen ein Weiterverwenden bzw. lassen sich passiv nicht beurteilen → nie Grundlage für CHF 480.
const NOT_REPAIRABLE = new Set(["unreachable", "outdated_technology"]);
const SEVERITY = ["low", "medium", "high"];

// Nur tatsächlich beobachtete Audit-Befunde zählen: Typ, URL, nicht-leerer Beleg, Schweregrad und Zeitpunkt müssen vorhanden sein.
export function observedEvidence(issues = []) {
  return (Array.isArray(issues) ? issues : []).filter((i) => i && typeof i.type === "string" && i.type
    && typeof i.url === "string" && /^https?:\/\//i.test(i.url) && typeof i.evidence === "string" && i.evidence.trim()
    && SEVERITY.includes(i.severity) && !Number.isNaN(Date.parse(i.detectedAt)))
    .map(({ type, url, evidence, severity, detectedAt }) => ({ type, url, evidence, severity, detectedAt }));
}

// Liefert immer genau eine von drei Klassen: REPAIR_CHECK_150, REPAIR_FIX_500 oder NONE.
export function classifyOffer(lead = {}) {
  const evidence = observedEvidence(lead.websiteIssues);
  const result = (offer_class, confidence, ev, rationale, next) => ({
    offer_class, price_chf: isOfferClass(offer_class) ? OFFERS[offer_class].price : null, confidence, evidence: ev, rationale, recommended_next_step: next(),
  });
  const contactStep = (offer) => () => {
    if (legalBasis(lead)) return `${OFFERS[offer].label} anbieten – nur mit den belegten Befunden, ohne weitere Behauptungen.`;
    return "NICHT VERSANDBERECHTIGT: nicht anschreiben. Befunde dokumentiert lassen; Kontakt nur, wenn eine echte Versandgrundlage (opt_in oder existing_customer) vorliegt.";
  };
  const none = (why) => result(NONE, evidence.length ? "medium" : "high", evidence, why, () => "Kein Angebot. Lead nicht weiter verfolgen, solange keine belegten Befunde vorliegen.");

  if (lead.reachable === false || evidence.some((e) => e.type === "unreachable"))
    return none("Website nicht erreichbar – Zustand und Weiterverwendbarkeit lassen sich nicht belegen.");
  if (!evidence.length) return none("Keine belegten Audit-Befunde – kein Angebot begründbar.");

  const fix = evidence.filter((e) => FIXABLE.has(e.type) && e.severity !== "low" && !NOT_REPAIRABLE.has(e.type));
  if (fix.length) {
    const types = [...new Set(fix.map((e) => e.type))];
    return result("REPAIR_FIX_500", fix.length >= 2 || fix.some((e) => e.severity === "high") ? "high" : "medium", fix,
      `Konkrete, auf der bestehenden Website behebbare Probleme belegt: ${types.join(", ")}.`, contactStep("REPAIR_FIX_500"));
  }
  const meaningful = evidence.filter((e) => e.severity !== "low");
  if (meaningful.length || evidence.length >= 2) {
    const types = [...new Set(evidence.map((e) => e.type))];
    return result("REPAIR_CHECK_150", meaningful.length ? "medium" : "low", evidence,
      `Belegte Hinweise (${types.join(", ")}) rechtfertigen eine Prüfung mit Dokumentation, aber keine konkrete Reparatur.`, contactStep("REPAIR_CHECK_150"));
  }
  return none("Nur ein einzelner geringfügiger Befund – zu wenig für ein Angebot.");
}

// ---------- Pipeline (Verkäufe, Antwort-/Absage-Status) ----------
// .secrets/mail_worker/sales.json: { records: { <domain>: { status?, statusAt?, sale?: { selected_offer, sale_date, sale_value, currency, customer_status, work_status, evidence[],
//   sale_status?="voided", voided?, voided_at?, void_reason? } } } } – voided-Felder nur nach `void-sale` (TF-040); Original bleibt erhalten.

const keyOf = (l = {}) => l.domain || (l.website ? safeDomain(l.website) : "") || normEmail(l.email || "");
function safeDomain(u) { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } }

export function recordSale(records, key, { offer, date, work_status = "open", lead = {}, now = new Date() } = {}) {
  if (!isOfferClass(offer)) throw new Error(`Unbekanntes Angebot "${offer}". Erlaubt sind nur: ${OFFER_CLASSES.join(", ")}.`);
  if (!WORK_STATUS.includes(work_status)) throw new Error(`Ungültiger work_status. Erlaubt: ${WORK_STATUS.join(", ")}.`);
  const sale_date = date || now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sale_date) || Number.isNaN(Date.parse(sale_date))) throw new Error("sale_date muss JJJJ-MM-TT sein.");
  // Belege des Verkaufs: nur beobachtete Befunde, die zum gekauften Angebot passen.
  const c = classifyOffer(lead);
  const evidence = c.offer_class === offer ? c.evidence : observedEvidence(lead.websiteIssues);
  const rec = { ...(records[key] || {}) };
  rec.sale = { selected_offer: offer, sale_date, sale_value: OFFERS[offer].price, currency: "CHF", customer_status: "customer", work_status, evidence };
  rec.status = "customer";
  rec.statusAt = now.toISOString();
  return { ...records, [key]: rec };
}

// ---------- Direktkunde / manuell bestätigter Auftrag (TF-039) ----------
// Ein echter Kunde kann ohne Discovery-Lead bestellen (Website-Formular, Direktanfrage, Empfehlung, persönlicher Kontakt).
// Der CLI-Aufruf durch Chris ist die ausdrückliche betriebliche Bestätigung – NIE wird allein aus einer Anfrage oder einem
// Domainnamen ein bezahlter Auftrag. Es entsteht ein Verkaufs-Datensatz mit Kundenstammdaten (source = direct_customer),
// ohne erfundene Discovery-Quelle, ohne Cold-Outreach-Historie und ohne jede Änderung an Versandgrundlagen (legalBasis bleibt
// allein massgeblich; ein Direktkunde ist KEIN Cold-Lead). In die Lead-Datenbank gelangt der Kunde ausschliesslich über die
// bestehende reconcile-Logik (lead-registry.js liest sales.json).
export const DIRECT_CUSTOMER_SOURCE = "direct_customer";
const DELIVERY_EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function recordDirectSale(records, { domain, offer, delivery_email, company = null, contact_name = null, website = null, date, work_status = "open", lead = {}, now = new Date() } = {}) {
  const key = safeDomain(String(domain || ""));
  if (!key || !key.includes(".")) throw new Error(`Ungültige Domain "${domain}".`);
  const email = normEmail(delivery_email || "");
  if (!DELIVERY_EMAIL_RE.test(email)) throw new Error("Gültige Kunden-E-Mail (--email) des bestätigten Auftrags erforderlich.");
  const out = recordSale(records, key, { offer, date, work_status, lead, now });
  const rec = out[key];
  rec.direct_sale = {
    source: DIRECT_CUSTOMER_SOURCE, basis: "manual_confirmed_order", confirmed_by: "chris_cli",
    domain: key, website: website || lead.website || `https://${key}/`,
    company: company || lead.company || null, delivery_email: email, contact_name: contact_name || lead.name || null,
    created_at: records[key]?.direct_sale?.created_at || now.toISOString(), updated_at: now.toISOString(),
  };
  return out;
}

export function setPipelineStatus(records, key, status, now = new Date()) {
  if (!["replied", "not_interested"].includes(status)) throw new Error("Von Hand setzbar sind nur replied und not_interested.");
  return { ...records, [key]: { ...(records[key] || {}), status, statusAt: now.toISOString() } };
}

export function setWorkStatus(records, key, work_status) {
  if (!records[key]?.sale) throw new Error("Für diesen Lead ist kein Verkauf erfasst.");
  if (!WORK_STATUS.includes(work_status)) throw new Error(`Ungültiger work_status. Erlaubt: ${WORK_STATUS.join(", ")}.`);
  return { ...records, [key]: { ...records[key], sale: { ...records[key].sale, work_status } } };
}

// ---------- VOID / Storno eines versehentlich erfassten Verkaufs (TF-040) ----------
// Ein Verkauf wird NIE gelöscht, nur markiert (sale_status=voided + Zeitpunkt + Pflicht-Grund). Alle ursprünglichen Daten
// (Angebot, Betrag, Datum, Evidence, direct_sale-Stammdaten) bleiben unverändert erhalten – die Historie ist nachvollziehbar.
// Fail closed: nur exakter Domain-Treffer (nie ein „ähnlicher“ Datensatz), Grund Pflicht, bereits voided blockiert erneutes Void.
// Verknüpfte Aufträge schützen: offene Aufträge → zuerst stornieren; COMPLETED (echter gelieferter Auftrag) → manuelle Prüfung.
// Nur CANCELLED (bzw. bei CHF-480 terminal gescheiterte BLOCKED_*-Aufträge ohne Storno-Weg) stehen einem Void nicht im Weg.
const VOID_SAFE_ORDER_STATES = new Set(["CANCELLED", "BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION", "BLOCKED_UNSUPPORTED_STACK", "REPAIR_FAILED", "VALIDATION_FAILED"]);
export const VOIDED_TEST_CUSTOMER = "voided_test_customer";

export function voidSale(records, domain, { reason, relatedOrders = [], now = new Date() } = {}) {
  const key = safeDomain(String(domain || ""));
  if (!key || !key.includes(".")) throw new Error(`Ungültige Domain "${domain}".`);
  const r = String(reason || "").replace(/\s+/g, " ").trim();
  if (!r) throw new Error("Begründung ist Pflicht: --reason \"<grund>\".");
  const rec = records[key]; // nur exakter Treffer – nie automatische Auswahl eines ähnlichen Datensatzes
  if (!rec) throw new Error(`Kein Verkaufs-Datensatz für "${key}" vorhanden – nichts wird erraten oder angelegt.`);
  if (!rec.sale) throw new Error(`Für "${key}" ist kein Verkauf erfasst – nichts zu stornieren.`);
  if (isVoidedSale(rec.sale)) throw new Error(`Verkauf für "${key}" ist bereits storniert (voided am ${rec.sale.voided_at || "unbekannt"}).`);
  for (const o of relatedOrders) {
    if (!o || safeDomain(String(o.domain || "")) !== key) continue;
    if (o.state === "COMPLETED") throw new Error(`Abgeschlossener Auftrag ${o.order_id} (COMPLETED) vorhanden – kein automatisches Void, manuelle Prüfung nötig.`);
    if (!VOID_SAFE_ORDER_STATES.has(o.state)) throw new Error(`Offener Auftrag ${o.order_id} (${o.state}) vorhanden – zuerst Auftrag stornieren.`);
  }
  const sale = { ...rec.sale, sale_status: "voided", voided: true, voided_at: now.toISOString(), void_reason: r.slice(0, 300) };
  return { ...records, [key]: { ...rec, sale, status: "sale_voided", statusAt: now.toISOString() } };
}

// Alle Aufträge (CHF 150 und CHF 480) zu einer Domain – Dateinamen bewusst lokal, damit kein Import-Zyklus mit den
// Workflow-Modulen entsteht (check-150-workflow.js und repair-workflow.js importieren beide aus sales.js).
export function collectDomainOrders(store, domain) {
  const key = safeDomain(String(domain || ""));
  const out = [];
  for (const file of ["check150_orders.json", "repair_orders.json"])
    for (const o of Object.values(store.read(file, { orders: {} }).orders || {}))
      if (o && safeDomain(String(o.domain || "")) === key) out.push({ order_id: o.order_id, state: o.state, domain: o.domain, file });
  return out;
}

// Ein Verkauf zählt nur mit einem der zwei Angebote und dem dazu gehörenden Preis – alles andere wird ignoriert.
// Stornierte (voided) Verkäufe bleiben gespeichert, zählen aber NIRGENDS mehr: kein Umsatz, kein Kunde, keine Workflow-Bestätigung.
export const isVoidedSale = (s) => !!s && (s.sale_status === "voided" || s.voided === true);
const validSale = (s) => s && isOfferClass(s.selected_offer) && s.sale_value === OFFERS[s.selected_offer].price && !isVoidedSale(s);

// ---------- Lebenszyklus (abgeleitet, ohne Migration bestehender Daten) ----------

const AUDITED_STATUSES = new Set(["no_issues", "low_score", "no_contact", "excluded_private", "excluded_no_company", "duplicate", "already_in_lead_list", "matched_existing_lead", "blocked_no_legal_basis", "audited"]);

export function lifecycleStatus(lead = {}, ctx = {}) {
  const email = normEmail(lead.email || "");
  const rec = ctx.record || {};
  const offer = classifyOffer(lead);
  if (lead.status === "suppressed" || (email && ctx.suppression?.[email]) || lead.status === "do_not_contact") return "do_not_contact";
  if (validSale(rec.sale)) return "customer";
  if (rec.status === "not_interested") return "not_interested";
  if (rec.status === "replied" || (email && ctx.replied?.has(email))) return "replied";
  if (email && ctx.contacted?.has(email)) return "contacted";
  if (legalBasis(lead, ctx.now)) return "approved";
  if (lead.status === "blocked_no_legal_basis" || (lead.approved === true && !legalBasis(lead, ctx.now))) return "blocked_no_legal_basis";
  if (offer.offer_class !== NONE) return "repair_candidate";
  if (lead.auditedAt || AUDITED_STATUSES.has(lead.status) || lead.websiteIssues?.length) return "audited";
  return "discovered";
}

// Liest alle lokalen Quellen (nie in die Cloud): gefundene Leads, Sirs Lead-Liste, Jarvis-Register, Worker-Zustand, Suppression, Verkäufe.
export function loadPipeline({ dir = WORKER_DIR, registry = { sent: {}, drafts: {} }, now = new Date() } = {}) {
  const store = createStore(dir);
  const discovered = Object.values(store.read("discovered.json", { leads: {} }).leads || {});
  const listed = store.read("leads.json", []);
  const suppression = store.read("suppression.json", {});
  const state = store.read("state.json", { actions: {} });
  const records = store.read("sales.json", { records: {} }).records || {};
  const reviews = store.read(COLD_DRAFTS_FILE, { reviews: {} }).reviews || {};
  const contacted = new Set(Object.values(registry.sent || {}).map((x) => normEmail(x.to || "")).filter(Boolean));
  const replied = new Set(Object.entries(state.actions || {}).filter(([k]) => k.startsWith("reply:")).map(([, a]) => normEmail(a.to || "")).filter(Boolean));
  // Sirs Lead-Liste hat Vorrang (dort steht die Versandgrundlage); gefundene Leads ergänzen nur.
  const byKey = new Map();
  for (const l of Array.isArray(listed) ? listed : []) if (l && (l.email || l.website)) byKey.set(keyOf(l), { ...l, domain: keyOf(l), source: "leads.json" });
  for (const l of discovered) { const k = keyOf(l); if (k && !byKey.has(k)) byKey.set(k, { ...l, source: "discovered.json" }); }
  const ctx = { suppression, contacted, replied, now };
  const leads = [...byKey.values()].map((l) => {
    const record = records[l.domain] || {};
    const offer = classifyOffer(l);
    const basis = legalBasis(l, now);
    const email = normEmail(l.email || "");
    const status = lifecycleStatus(l, { ...ctx, record });
    const review = reviews[l.domain] || null;
    const suppressed = !!(email && suppression[email]) || l.status === "suppressed";
    const repair = qualifyRepairLead(l, { now, review, base: status, suppressed });
    return {
      key: l.domain, company: l.company || null, domain: l.domain, website: l.website || null,
      contact: { email: l.email || null, emailSource: l.emailSource || null, name: l.name || null, nameSource: l.nameSource || null },
      issues: observedEvidence(l.websiteIssues), auditedAt: l.auditedAt || null, auditScore: l.auditScore ?? null,
      offer, legalBasis: basis, eligible: !!basis && !suppression[email], legalBasisStatus: basis ? `versandberechtigt (${basis})` : "NICHT VERSANDBERECHTIGT",
      status, repair, review, suppressed, optedOut: !!(email && /opt-out/i.test(suppression[email]?.reason || "")),
      rawStatus: l.status || null, source: l.source,
      lastContactAt: lastSent(registry, email), replied: !!(email && replied.has(email)) || record.status === "replied",
      sale: validSale(record.sale) ? record.sale : null, customerStatus: validSale(record.sale) ? record.sale.customer_status : null,
    };
  });
  const optOuts = Object.values(suppression).filter((x) => /opt-out/i.test(x?.reason || "")).length;
  return { leads, records, optOuts };
}
// Roh-Lead zu einer lead_id (= Domain) aus den lokalen Quellen – für den Cold-Entwurf auf Anweisung aus der Cloud. Nie in die Cloud.
export function findRawLead(dir = WORKER_DIR, id = "") {
  const store = createStore(dir), key = String(id || "").toLowerCase();
  if (!key) return null;
  for (const l of Array.isArray(store.read("leads.json", [])) ? store.read("leads.json", []) : []) if (l && keyOf(l) === key) return { ...l, domain: key };
  for (const l of Object.values(store.read("discovered.json", { leads: {} }).leads || {})) if (l && keyOf(l) === key) return { ...l, domain: key };
  return null;
}
function lastSent(registry, email) {
  if (!email) return null;
  return Object.values(registry.sent || {}).filter((x) => normEmail(x.to || "") === email).map((x) => x.sentAt).filter(Boolean).sort().at(-1) || null;
}

const COLD_STAGES = new Set(["cold_lead_draft_only", "draft_created", "contacted", "replied", "customer", "not_interested"]);
export function computeMetrics(leads = [], now = new Date(), { optOuts = null } = {}) {
  const count = (f) => leads.filter(f).length;
  const sales = leads.map((l) => l.sale).filter(validSale);
  const s150 = sales.filter((s) => s.selected_offer === "REPAIR_CHECK_150"), s500 = sales.filter((s) => s.selected_offer === "REPAIR_FIX_500");
  const reached = new Set(["contacted", "replied", "not_interested"]); // Kunden zählen nur, wenn wirklich angeschrieben (lastContactAt)
  const m = {
    updatedAt: now.toISOString(),
    discovered: leads.length,
    audited: count((l) => l.status !== "discovered"),
    qualified_repair: count((l) => l.offer.offer_class !== NONE),
    offer_150_candidates: count((l) => l.offer.offer_class === "REPAIR_CHECK_150"),
    offer_500_candidates: count((l) => l.offer.offer_class === "REPAIR_FIX_500"),
    eligible_to_contact: count((l) => l.eligible && l.status === "approved"),
    blocked_no_legal_basis: count((l) => l.status === "blocked_no_legal_basis"),
    contacted: count((l) => reached.has(l.status) || !!l.lastContactAt),
    replies: count((l) => l.replied),
    customers: count((l) => l.status === "customer"),
    sales_150: s150.length, sales_500: s500.length,
    // Swiss Repair Outreach (nur Schweizer Firmen mit brauchbarer Website und belegtem Reparaturbefund)
    swiss_verified: count((l) => l.repair?.country === "CH" && !!l.auditedAt),
    modern_repair_fit: count((l) => l.repair?.country === "CH" && !!l.auditedAt && ["modern_maintainable", "repairable"].includes(l.repair.site_condition)),
    repair_candidates: count((l) => l.repair && l.repair.offer.offer_class !== NONE),
    repair_150_candidates: count((l) => l.repair?.offer.offer_class === "REPAIR_CHECK_150"),
    repair_500_candidates: count((l) => l.repair?.offer.offer_class === "REPAIR_FIX_500"),
    auto_send_eligible: count((l) => l.repair?.automatic_send_eligible && !l.suppressed),
    // TF-025 Cold-Lead-Entwürfe (nie automatisch gesendet)
    cold_leads_found: count((l) => l.repair?.contact_basis === "COLD_LEAD_DRAFT_ONLY" || l.review?.draft_mode === "COLD_LEAD_DRAFT_ONLY"),
    business_contacts_found: count((l) => !!l.auditedAt && !!l.contact.email && !FREEMAIL_RE.test(l.contact.email)),
    drafts_created: count((l) => !!l.review?.gmail_draft_id),
    drafts_open: count((l) => l.review?.status === "draft_created"),
    drafts_manually_sent: count((l) => l.review?.status === "manually_sent"),
    blocked: count((l) => ["blocked_no_contact_basis", "do_not_contact"].includes(l.repair?.stage) || l.review?.status === "blocked"
      || (l.status === "blocked_no_legal_basis" && !COLD_STAGES.has(l.repair?.stage))),
    opt_outs: optOuts ?? count((l) => l.optedOut),
    revenue_150: s150.length * OFFERS.REPAIR_CHECK_150.price, revenue_500: s500.length * OFFERS.REPAIR_FIX_500.price,
  };
  m.total_revenue = m.revenue_150 + m.revenue_500;
  return m;
}

// Kennzahlen berechnen und lokal festhalten (metrics.json). Gibt nur Zahlen zurück – sicher für den gemeinsamen Zustand.
export function persistMetrics({ dir = WORKER_DIR, registry, now = new Date() } = {}) {
  const { leads, optOuts } = loadPipeline({ dir, registry, now });
  const metrics = computeMetrics(leads, now, { optOuts });
  createStore(dir).write("metrics.json", metrics);
  return metrics;
}

// ---------- Kommandozeile ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, key, value] = process.argv.slice(2);
  const opt = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
  const run = async () => {
    const gmail = await import("./gmail.js");
    const registry = (() => { try { return gmail.listOwned(); } catch { return { sent: {}, drafts: {} }; } })();
    const store = createStore(WORKER_DIR);
    const data = store.read("sales.json", { records: {} });
    const { leads } = loadPipeline({ registry });
    const lead = () => { const l = leads.find((x) => x.key === key); if (!l) throw new Error(`Lead "${key}" nicht gefunden.`); return l; };
    const raw = (k) => {
      const d = Object.values(store.read("discovered.json", { leads: {} }).leads || {}).find((l) => keyOf(l) === k);
      return d || (store.read("leads.json", []) || []).find((l) => keyOf(l) === k) || {};
    };
    if (cmd === "report") console.log(JSON.stringify(persistMetrics({ registry }), null, 2));
    else if (cmd === "leads") console.log(JSON.stringify(leads.map((l) => ({ key: l.key, company: l.company, status: l.status, offer: l.offer.offer_class, legal: l.legalBasisStatus })), null, 2));
    else if (cmd === "sale") { lead(); store.write("sales.json", { records: recordSale(data.records, key, { offer: value, date: opt("date"), work_status: opt("work") || "open", lead: raw(key) }) }); console.log("Verkauf erfasst:", key, value, `CHF ${OFFERS[value].price}`); persistMetrics({ registry }); }
    else if (cmd === "direct-sale") {
      // Bewusst bestätigter Direktauftrag durch Chris: bestehender Lead wird verwendet (kein Duplikat, echte Audit-Evidence),
      // sonst entsteht ein minimaler Kundendatensatz – nie erfundene Discovery-/Outreach-Historie.
      const k = safeDomain(key || "");
      const existing = leads.find((x) => x.key === k) || null;
      store.write("sales.json", { records: recordDirectSale(data.records, { domain: key, offer: value, delivery_email: opt("email"), company: opt("company"), contact_name: opt("name"), website: opt("website"), date: opt("date"), work_status: opt("work") || "open", lead: existing ? raw(k) : {} }) });
      console.log(`Direktverkauf erfasst: ${k} ${value} CHF ${OFFERS[value].price} (Quelle: Direktkunde, ${existing ? "bestehender Lead verwendet" : "neuer Kundendatensatz"})`);
      persistMetrics({ registry });
      // Lead-Datenbank sofort über die BESTEHENDE sichere reconcile-Logik nachführen (idempotent, additiv, nie löschend).
      try { const { reconcileRegistry } = await import("./lead-registry.js"); reconcileRegistry(store, { gmailRegistry: registry, force: true }); } catch (e) { console.error("Hinweis: Lead-Datenbank-Abgleich folgt beim nächsten Worker-Lauf (" + e.message + ")"); }
    }
    else if (cmd === "void-sale") {
      // Storno durch Chris (CLI): markiert den Verkauf als voided (nie löschen), prüft vorher verknüpfte Aufträge beider
      // Workflows. Danach nur Kennzahlen + Lead-Datenbank nachführen – KEIN Cold-Outreach, keine Gmail-, keine Website-Aktion.
      const k = safeDomain(key || "");
      const next = voidSale(data.records, key, { reason: opt("reason"), relatedOrders: collectDomainOrders(store, k) });
      store.write("sales.json", { records: next });
      const s = next[k].sale;
      console.log(`Verkauf storniert: ${k} → VOIDED (CHF ${s.sale_value}). Grund: ${s.void_reason}`);
      persistMetrics({ registry });
      try { const { reconcileRegistry } = await import("./lead-registry.js"); reconcileRegistry(store, { gmailRegistry: registry, force: true }); } catch (e) { console.error("Hinweis: Lead-Datenbank-Abgleich folgt beim nächsten Worker-Lauf (" + e.message + ")"); }
    }
    else if (cmd === "status") { lead(); store.write("sales.json", { records: setPipelineStatus(data.records, key, value) }); console.log("Status gesetzt:", key, value); persistMetrics({ registry }); }
    else if (cmd === "work") { store.write("sales.json", { records: setWorkStatus(data.records, key, value) }); console.log("Arbeitsstatus gesetzt:", key, value); }
    else { console.log("Befehle: report | leads | sale <domain> <REPAIR_CHECK_150|REPAIR_FIX_500> [--date JJJJ-MM-TT] | direct-sale <domain> <offer> --email <adresse> [--company] [--name] [--website] | void-sale <domain> --reason \"<grund>\" | status <domain> <replied|not_interested> | work <domain> <open|in_progress|delivered>"); return 1; }
    return 0;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
