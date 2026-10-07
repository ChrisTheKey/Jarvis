// Jarvis Vertrieb für Helvetic Webdesign – genau ZWEI Angebote, Lead-Lebenszyklus, Verkäufe und Kennzahlen.
// Reine Auswertung: sendet nie, gibt nie frei und ändert keine Versandgrundlage. Ob ein Lead angeschrieben werden darf,
// entscheidet ausschliesslich legalBasis() aus mail-worker.js (opt_in / existing_customer / requested_contact).
// Swiss Repair Outreach (Schweiz-Signale, Website-Zustand, Einzelprüfung) liegt in swiss-repair.js.
//
// Angebote (keine weiteren Preisstufen, kein Neubau, kein Redesign, kein Upsell):
//   REPAIR_CHECK_150  CHF 150  Website prüfen, Probleme dokumentieren, Empfehlungen liefern – keine Umsetzung
//   REPAIR_FIX_500    CHF 500  konkrete Probleme auf der bestehenden Website reparieren bzw. optimieren
// Lässt sich keines aus belegten Audit-Befunden begründen: NONE. Evidence stammt nur aus websiteIssues des Audits.
//
//   node sales.js report                         Kennzahlen (auch in .secrets/mail_worker/metrics.json)
//   node sales.js leads                          Pipeline-Übersicht ohne Kontaktdaten
//   node sales.js sale <domain> <REPAIR_CHECK_150|REPAIR_FIX_500> [--date JJJJ-MM-TT] [--work open|in_progress|delivered]
//   node sales.js status <domain> <replied|not_interested>
//   node sales.js work <domain> <open|in_progress|delivered>
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore, legalBasis, normEmail } from "./mail-worker.js";
import { qualifyRepairLead, REVIEWS_FILE } from "./swiss-repair.js";

export const OFFERS = Object.freeze({
  REPAIR_CHECK_150: Object.freeze({ price: 150, currency: "CHF", label: "Website-Check CHF 150", scope: "Website prüfen, konkrete Probleme dokumentieren, Ergebnisse und Empfehlungen liefern – keine umfangreiche Reparatur." }),
  REPAIR_FIX_500: Object.freeze({ price: 500, currency: "CHF", label: "Reparatur CHF 500", scope: "Konkrete technische oder sichtbare Probleme auf der bestehenden Website reparieren bzw. optimieren." }),
});
export const OFFER_CLASSES = Object.freeze(Object.keys(OFFERS));
export const NONE = "NONE";
export const isOfferClass = (c) => OFFER_CLASSES.includes(c);

export const LIFECYCLE = Object.freeze(["discovered", "audited", "repair_candidate", "blocked_no_legal_basis", "approved", "contacted", "replied", "customer", "not_interested", "do_not_contact"]);
export const WORK_STATUS = Object.freeze(["open", "in_progress", "delivered"]);

// Konkrete, auf der bestehenden Website behebbare Probleme (nur mit Schweregrad mittel/hoch) → Reparatur CHF 500.
const FIXABLE = new Set(["https_certificate", "no_https", "redirect_loop", "mixed_content", "broken_link", "broken_image", "contact_page_broken", "http_error", "missing_title", "slow_response", "outdated_cms"]);
// Diese Befunde sprechen gegen ein Weiterverwenden bzw. lassen sich passiv nicht beurteilen → nie Grundlage für CHF 500.
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
// .secrets/mail_worker/sales.json: { records: { <domain>: { status?, statusAt?, sale?: { selected_offer, sale_date, sale_value, currency, customer_status, work_status, evidence[] } } } }

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

export function setPipelineStatus(records, key, status, now = new Date()) {
  if (!["replied", "not_interested"].includes(status)) throw new Error("Von Hand setzbar sind nur replied und not_interested.");
  return { ...records, [key]: { ...(records[key] || {}), status, statusAt: now.toISOString() } };
}

export function setWorkStatus(records, key, work_status) {
  if (!records[key]?.sale) throw new Error("Für diesen Lead ist kein Verkauf erfasst.");
  if (!WORK_STATUS.includes(work_status)) throw new Error(`Ungültiger work_status. Erlaubt: ${WORK_STATUS.join(", ")}.`);
  return { ...records, [key]: { ...records[key], sale: { ...records[key].sale, work_status } } };
}

// Ein Verkauf zählt nur mit einem der zwei Angebote und dem dazu gehörenden Preis – alles andere wird ignoriert.
const validSale = (s) => s && isOfferClass(s.selected_offer) && s.sale_value === OFFERS[s.selected_offer].price;

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
  const reviews = store.read(REVIEWS_FILE, { reviews: {} }).reviews || {};
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
    const repair = qualifyRepairLead(l, { now, review, base: status });
    return {
      key: l.domain, company: l.company || null, domain: l.domain, website: l.website || null,
      contact: { email: l.email || null, emailSource: l.emailSource || null, name: l.name || null, nameSource: l.nameSource || null },
      issues: observedEvidence(l.websiteIssues), auditedAt: l.auditedAt || null, auditScore: l.auditScore ?? null,
      offer, legalBasis: basis, eligible: !!basis && !suppression[email], legalBasisStatus: basis ? `versandberechtigt (${basis})` : "NICHT VERSANDBERECHTIGT",
      status, repair, review, suppressed: !!(email && suppression[email]) || l.status === "suppressed", optedOut: !!(email && /opt-out/i.test(suppression[email]?.reason || "")),
      rawStatus: l.status || null, source: l.source,
      lastContactAt: lastSent(registry, email), replied: !!(email && replied.has(email)) || record.status === "replied",
      sale: validSale(record.sale) ? record.sale : null, customerStatus: validSale(record.sale) ? record.sale.customer_status : null,
    };
  });
  return { leads, records };
}
function lastSent(registry, email) {
  if (!email) return null;
  return Object.values(registry.sent || {}).filter((x) => normEmail(x.to || "") === email).map((x) => x.sentAt).filter(Boolean).sort().at(-1) || null;
}

export function computeMetrics(leads = [], now = new Date()) {
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
    individual_review_required: count((l) => l.repair?.stage === "individual_review_required"),
    blocked: count((l) => ["blocked_no_contact_basis", "blocked_no_legal_basis", "do_not_contact"].includes(l.repair?.stage) || l.status === "blocked_no_legal_basis"),
    revenue_150: s150.length * OFFERS.REPAIR_CHECK_150.price, revenue_500: s500.length * OFFERS.REPAIR_FIX_500.price,
  };
  m.total_revenue = m.revenue_150 + m.revenue_500;
  return m;
}

// Kennzahlen berechnen und lokal festhalten (metrics.json). Gibt nur Zahlen zurück – sicher für den gemeinsamen Zustand.
export function persistMetrics({ dir = WORKER_DIR, registry, now = new Date() } = {}) {
  const { leads } = loadPipeline({ dir, registry, now });
  const metrics = computeMetrics(leads, now);
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
    else if (cmd === "status") { lead(); store.write("sales.json", { records: setPipelineStatus(data.records, key, value) }); console.log("Status gesetzt:", key, value); persistMetrics({ registry }); }
    else if (cmd === "work") { store.write("sales.json", { records: setWorkStatus(data.records, key, value) }); console.log("Arbeitsstatus gesetzt:", key, value); }
    else { console.log("Befehle: report | leads | sale <domain> <REPAIR_CHECK_150|REPAIR_FIX_500> [--date JJJJ-MM-TT] | status <domain> <replied|not_interested> | work <domain> <open|in_progress|delivered>"); return 1; }
    return 0;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
