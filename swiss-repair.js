// Swiss Repair Outreach (TF-022 / TF-025) – Jarvis sucht Schweizer Firmen mit grundsätzlich brauchbarer Website und einem
// konkreten, passiv belegten Reparaturbefund. Angeboten werden ausschliesslich REPAIR_CHECK_150 (CHF 150) und REPAIR_FIX_500 (CHF 480).
// Kein Neubau, kein Redesign, kein Upsell. Dieses Modul sendet nie selbst.
//
// Versandgrundlagen (contact_basis):
//   OPT_IN                              dokumentierte Einwilligung                    → automatische Fenster erlaubt
//   EXISTING_CUSTOMER_SIMILAR_SERVICE   Bestandskunde + ähnliche eigene Leistung       → automatische Fenster erlaubt
//   REQUESTED_CONTACT                   Empfänger hat selbst angefragt (Quelle/Datum/Umfang),
//                                       nur wenn der Umfang Website/Reparatur abdeckt → automatische Fenster erlaubt
//   COLD_LEAD_DRAFT_ONLY (TF-025)       neue Schweizer Firma, öffentliche GESCHÄFTLICHE Adresse, keine obige Grundlage:
//                                       Jarvis legt genau EINEN Gmail-Entwurf an – und sendet ihn NIE. Kein Worker, kein VPS,
//                                       keine Kampagne, keine Cloud-Queue. Chris entscheidet selbst in Gmail. legal_basis bleibt NONE,
//                                       auch nach einem manuellen Versand. Kein automatischer Follow-up.
//   NONE                                kein Kontakt (blocked_no_contact_basis)
// Eine öffentlich gefundene Adresse (auch info@, Impressum, Verzeichnis) ist nie eine automatische Versandgrundlage.
import crypto from "node:crypto";
import { legalBasis, normEmail } from "./mail-worker.js";
import { evaluateSwissEmailPermission } from "./email-permission.js";
import { OFFERS, NONE, LANDING_PAGE_URL } from "./sales.js";

// Lokales Register der Cold-Lead-Entwürfe (Dateiname aus TF-022 beibehalten, damit vorhandene Daten lesbar bleiben).
export const REVIEWS_FILE = "individual_reviews.json";
export const COLD_DRAFTS_FILE = REVIEWS_FILE;
export const COLD_MODE = "COLD_LEAD_DRAFT_ONLY";
export const COLD_DRAFT_COOLDOWN_DAYS = 180; // keine zweite Cold-Mail an dieselbe Firma/Adresse innerhalb dieses Zeitraums
export const CONTACT_BASIS = Object.freeze({
  EXPLICIT_OPT_IN: "EXPLICIT_OPT_IN", EXISTING_CUSTOMER_SIMILAR_SERVICE: "EXISTING_CUSTOMER_SIMILAR_SERVICE", REQUESTED_CONTACT: "REQUESTED_CONTACT",
  ACTIVE_RFP_RESPONSE: "ACTIVE_RFP_RESPONSE",
  COLD_LEAD_DRAFT_ONLY: COLD_MODE, NONE: "NONE",
});
// TF-024: Marketing nur EXPLICIT_OPT_IN / EXISTING_CUSTOMER_SIMILAR_SERVICE; Anfrage/Ausschreibung nur SOLICITED_RESPONSE.
const AUTO_BASIS = { opt_in: "EXPLICIT_OPT_IN", existing_customer: "EXISTING_CUSTOMER_SIMILAR_SERVICE", requested_contact: "REQUESTED_CONTACT", active_rfp: "ACTIVE_RFP_RESPONSE" };
const MARKETING_BASIS = new Set(["opt_in", "existing_customer"]);
export const SITE_CONDITIONS = Object.freeze(["modern_maintainable", "repairable", "unclear", "redesign_likely"]);
export const REPAIR_LIFECYCLE = Object.freeze(["discovered", "audited", "swiss_verified", "modern_repair_fit", "repair_candidate", "blocked_no_contact_basis",
  "cold_lead_draft_only", "draft_created", "contacted", "replied", "customer", "not_interested", "do_not_contact"]);

// ---------- 1) Schweiz-Signale ----------

const SWISS_PHONE = /(?:\+|00)41[\s./-]?\(?0?\)?[\s./-]?[1-9]\d(?:[\s./-]?\d){7}|\b0[1-9]\d[\s./-]\d{3}[\s./-]\d{2}[\s./-]\d{2}\b/;
const SWISS_ADDRESS = /\bCH[-\s]?[1-9]\d{3}\s+[A-ZÄÖÜ][\wäöüéèàç.-]+|\b[1-9]\d{3}\s+[A-ZÄÖÜ][\wäöüéèàç.-]+[^\n]{0,40}\b(?:Schweiz|Switzerland|Suisse|Svizzera)\b/;
const SWISS_UID = /CHE[-\s]?\d{3}\.\d{3}\.\d{3}/;
const FOREIGN = /(?:\+|00)(?:49|43|33|39|423)[\s(]|\b(?:Deutschland|Germany|Österreich|Austria|France|Italia|Liechtenstein)\b|\bHRB\s?\d|\bAmtsgericht\b/;
const plain = (html = "") => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");

// Nur belegte Signale; country = "CH" erst ab mindestens einem belastbaren Signal ohne widersprechende Auslandssignale.
export function swissSignals({ domain = "", uid = null, pages = {}, discoverySource = "", sourceUrl = null } = {}) {
  const ev = [];
  const at = (where) => sourceUrl || where;
  if (/\.ch$/i.test(domain)) ev.push({ signal: "ch_domain", value: domain, source: "domain", strength: "medium" });
  const texts = [["impressum", pages.impressum], ["kontakt", pages.contact], ["startseite", pages.home]].filter(([, h]) => h).map(([w, h]) => [w, plain(h)]);
  const firstHit = (re) => { for (const [w, t] of texts) { const m = t.match(re); if (m) return { where: w, value: m[0].trim().slice(0, 80) }; } return null; };
  const uidHit = uid || firstHit(SWISS_UID)?.value;
  if (uidHit) ev.push({ signal: "swiss_uid", value: uidHit, source: at("impressum"), strength: "high" });
  const addr = firstHit(SWISS_ADDRESS);
  if (addr) ev.push({ signal: "swiss_address", value: addr.value, source: at(addr.where), strength: "high" });
  const phone = firstHit(SWISS_PHONE);
  if (phone) ev.push({ signal: "swiss_phone", value: phone.value, source: at(phone.where), strength: "medium" });
  if (/^OpenStreetMap /.test(discoverySource)) ev.push({ signal: "osm_swiss_area", value: discoverySource, source: "OpenStreetMap", strength: "medium" });
  const foreign = firstHit(FOREIGN);
  const strong = ev.some((e) => e.strength === "high");
  let confidence = "none";
  if (ev.length) confidence = strong || ev.length >= 2 ? "high" : "medium";
  if (foreign && !strong) confidence = "unclear";
  return { country: ["high", "medium"].includes(confidence) ? "CH" : null, swiss_evidence: ev, swiss_confidence: confidence, foreign_signal: foreign?.value || null };
}

// ---------- 2) Zustand der Website (nie ein erfundenes Alter) ----------

const LEGACY = new Set(["outdated_cms", "outdated_library", "outdated_content", "no_https"]);
export const PLACEHOLDER_RE = /\b(coming soon|under construction|im aufbau|baustelle|in kürze online|bientôt en ligne|en construction|in costruzione|wartungsarbeiten|maintenance mode|domain (?:is )?for sale|domain zu verkaufen|parked)\b/i;

export function siteCondition(lead = {}) {
  const issues = Array.isArray(lead.websiteIssues) ? lead.websiteIssues : [];
  const has = (t) => issues.some((i) => i?.type === t);
  const reasons = [];
  if (!lead.auditedAt) return { site_condition: "unclear", reasons: ["Nicht passiv geprüft."] };
  if (lead.reachable === false || has("unreachable")) return { site_condition: "unclear", reasons: ["Website nicht erreichbar – Zustand nicht beurteilbar."] };
  if (has("http_error")) return { site_condition: "unclear", reasons: ["Startseite liefert einen HTTP-Fehler – Zustand nicht beurteilbar."] };
  if (lead.placeholder || PLACEHOLDER_RE.test(lead.title || "")) return { site_condition: "unclear", reasons: ["Platzhalter-/Baustellenseite."] };
  if (has("outdated_technology")) return { site_condition: "redesign_likely", reasons: ["Veraltete Seitentechnik belegt (Frameset/Flash) – Reparatur nicht sinnvoll."] };
  const legacy = issues.filter((i) => LEGACY.has(i?.type)).map((i) => i.type);
  if (has("no_mobile_viewport")) {
    if (legacy.length) return { site_condition: "redesign_likely", reasons: [`Kein Mobile-Viewport und weitere Hinweise: ${[...new Set(legacy)].join(", ")}.`] };
    return { site_condition: "unclear", reasons: ["Kein Mobile-Viewport – Weiterverwendbarkeit nicht zuverlässig beurteilbar."] };
  }
  reasons.push("Website erreichbar", "Mobile-Viewport vorhanden");
  if (!has("missing_title")) reasons.push("Seitentitel vorhanden");
  if (!has("https_certificate") && !has("no_https") && !has("redirect_loop")) reasons.push("HTTPS funktioniert");
  if (legacy.length >= 3) return { site_condition: "redesign_likely", reasons: [`Mehrere Wartungsrückstände belegt: ${legacy.join(", ")}.`] };
  if (legacy.length || has("https_certificate") || has("redirect_loop")) return { site_condition: "repairable", reasons: [...reasons, `Behebbare Punkte: ${[...new Set([...legacy, ...issues.filter((i) => ["https_certificate", "redirect_loop"].includes(i.type)).map((i) => i.type)])].join(", ")}.`] };
  return { site_condition: "modern_maintainable", reasons };
}
export const isRepairFit = (c) => c === "modern_maintainable" || c === "repairable";

// ---------- 3) Konkreter Reparaturbefund (nur aus dem passiven Audit) ----------

// "fix": Umsetzung sinnvoll (CHF 480); "check": zuerst Analyse/Dokumentation (CHF 150).
export const REPAIR_TYPES = Object.freeze({
  broken_link: "fix", contact_page_broken: "fix", broken_image: "fix", broken_mailto: "fix", https_certificate: "fix", redirect_loop: "fix",
  missing_title: "fix", no_https: "fix", mixed_content: "check", slow_response: "check", no_https_redirect: "check",
});
const REPRODUCIBLE = new Set(["broken_link", "contact_page_broken", "broken_image", "broken_mailto", "https_certificate", "redirect_loop", "missing_title", "no_https", "mixed_content", "no_https_redirect"]);
const SEVERITY = ["low", "medium", "high"];

export function repairEvidence(issues = []) {
  return (Array.isArray(issues) ? issues : []).filter((i) => i && REPAIR_TYPES[i.type] && typeof i.url === "string" && /^https?:\/\//i.test(i.url)
    && typeof i.evidence === "string" && i.evidence.trim() && SEVERITY.includes(i.severity) && !Number.isNaN(Date.parse(i.detectedAt)))
    .map((i) => ({ issue_type: i.type, url: i.url, evidence: i.evidence, observed_at: i.detectedAt, reproducible: REPRODUCIBLE.has(i.type), severity: i.severity }));
}

// ---------- 4) Angebot (nur zwei Klassen oder NONE) ----------

export function classifyRepairOffer(lead = {}, swiss = swissFor(lead), condition = siteCondition(lead)) {
  const evidence = repairEvidence(lead.websiteIssues);
  const out = (offer_class, confidence, rationale, recommended_next_step) => ({ offer_class, price_chf: OFFERS[offer_class]?.price ?? null, confidence, evidence, rationale, recommended_next_step });
  if (swiss.country !== "CH") return out(NONE, "high", "Kein belastbares Schweiz-Signal – nicht für Repair-Outreach.", "Nicht weiter verfolgen.");
  if (condition.site_condition === "redesign_likely") return out(NONE, "medium", "Website wirkt eher neubaubedürftig – kein Reparaturangebot, kein Neubau-Angebot.", "Ausschliessen.");
  if (!isRepairFit(condition.site_condition)) return out(NONE, "medium", "Zustand der Website unklar – nicht automatisch qualifiziert.", "Nicht weiter verfolgen, solange unklar.");
  if (!evidence.length) return out(NONE, "high", "Kein konkreter, belegter Reparaturbefund.", "Kein Angebot.");
  const fix = evidence.filter((e) => REPAIR_TYPES[e.issue_type] === "fix" && e.severity !== "low" && e.reproducible);
  const types = (list) => [...new Set(list.map((e) => e.issue_type))].join(", ");
  if (fix.length) return out("REPAIR_FIX_500", fix.length >= 2 || fix.some((e) => e.severity === "high") ? "high" : "medium",
    `Website grundsätzlich weiterverwendbar; konkrete reparierbare Befunde: ${types(fix)}.`, "Check & Reparatur CHF 480 anbieten – nur mit diesen Befunden.");
  return out("REPAIR_CHECK_150", evidence.some((e) => e.reproducible) ? "medium" : "low",
    `Befunde (${types(evidence)}) rechtfertigen Analyse/Dokumentation, keine grössere Umsetzung.`, "Website-Check CHF 150 anbieten – nur mit diesen Befunden.");
}

// ---------- 5) Geschäftlicher Kontakt (nur öffentliche Firmenseiten) ----------

// Freemail-/Privatadressen sind nie ein geschäftlicher Cold-Kontakt.
export const FREEMAIL_RE = /@(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|bluewin|hispeed|sunrise|protonmail|proton|yandex|aol)\.[a-z.]+$/i;
const EMAIL_G = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const GENERIC_LOCAL = /^(info|kontakt|contact|office|mail|hallo|hello|post|admin|empfang|reception|sekretariat|team|anfrage|offerte|verkauf|sales|support)$/i;
const ROLE_RE = /(Webmaster|Website|Web|Online[- ]?Marketing|Marketing|Kommunikation|Informatik|IT[- ]?(?:Leiter(?:in)?|Verantwortliche[rn]?|Support)?|Geschäftsführ(?:er|erin|ung)|Geschäftsleitung|Inhaber(?:in)?|CEO|Leiter(?:in)? [A-ZÄÖÜ][a-zäöü]+)/;
const NAME_RE = /([A-ZÄÖÜ][a-zäöüéèàç]+(?:[ -][A-ZÄÖÜ][a-zäöüéèàç]+){1,2})/g;
const fold = (s = "") => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ä/g, "a").replace(/[^a-z]/g, "");
const rolePriority = (role = "") => /web|marketing|kommunikation|informatik|\bIT\b|IT-/i.test(role) ? 4 : /geschäfts|inhaber|ceo/i.test(role) ? 3 : role ? 2 : 1;

// Name nur, wenn er sicher zur Adresse gehört: lokaler Teil = vorname.nachname / v.nachname / vorname / nachname.
function nameForEmail(local, context) {
  const l = fold(local);
  for (const m of context.matchAll(NAME_RE)) {
    const parts = m[1].split(/[ -]/).map(fold).filter(Boolean);
    if (parts.length < 2) continue;
    const [first, last] = [parts[0], parts.at(-1)];
    if ([first + last, first[0] + last, last + first, first, last].includes(l)) return { name: m[1], at: m.index };
  }
  return null;
}

export function discoverBusinessContact({ pages = {}, domain = "", urls = {}, osmEmail = null, osmSource = null, owner = null, now = new Date() } = {}) {
  const own = (e) => { const d = normEmail(e).split("@")[1] || ""; return d === domain || d.endsWith("." + domain); };
  const found = [], rejected = [];
  const sources = [["team", pages.team], ["impressum", pages.impressum], ["kontakt", pages.contact], ["startseite", pages.home]].filter(([, h]) => h);
  for (const [where, html] of sources) {
    const text = String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<a\b[^>]*href=["']mailto:([^"'?]+)[^>]*>/gi, " $1 ")
      .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
    for (const m of text.matchAll(EMAIL_G)) {
      const email = normEmail(m[0]);
      if (/\.(png|jpe?g|gif|svg|webp)$/i.test(email) || found.some((f) => f.business_email === email) || rejected.some((r) => r.email === email)) continue;
      if (FREEMAIL_RE.test(email)) { rejected.push({ email, reason: "private_or_freemail" }); continue; }
      if (!own(email)) { rejected.push({ email, reason: "not_company_domain" }); continue; }
      const context = text.slice(Math.max(0, m.index - 160), m.index + m[0].length + 40);
      const local = email.split("@")[0];
      const generic = GENERIC_LOCAL.test(local);
      const hit = generic ? null : nameForEmail(local, context);
      const contact_name = hit?.name || null;
      // Rolle nur aus dem Text zwischen Name und Adresse – nie von einer Nachbarperson übernehmen.
      const contact_role = hit ? context.slice(hit.at).match(ROLE_RE)?.[1] || null : null;
      found.push({ business_email: email, contact_name, contact_role, generic, contact_source: where, source_url: urls[where] || null });
    }
  }
  if (osmEmail && own(osmEmail) && !found.some((f) => f.business_email === normEmail(osmEmail)))
    found.push({ business_email: normEmail(osmEmail), contact_name: null, contact_role: null, generic: GENERIC_LOCAL.test(normEmail(osmEmail).split("@")[0]), contact_source: "openstreetmap", source_url: osmSource });
  // Persönliche Adressen nur mit sicher zugeordnetem Namen; Reihenfolge: Web/Marketing/IT > Geschäftsführung > andere Person > info@.
  const usable = found.filter((f) => f.generic || f.contact_name);
  const rank = (f) => (f.contact_name ? rolePriority(f.contact_role) + 1 : 1) * 10 + (f.contact_source === "openstreetmap" ? 0 : 1);
  const best = usable.sort((a, b) => rank(b) - rank(a))[0];
  if (!best) return { business_email: null, contact_name: null, contact_role: null, contact_source: null, source_url: null, collected_at: null, contact_confidence: "none", rejected };
  // Kleine Firma mit info@: Geschäftsführung/Inhaber nur aus dem Impressum (dort ausdrücklich so bezeichnet) für die Anrede.
  const named = best.contact_name || (best.generic && owner ? owner : null);
  return {
    business_email: best.business_email, contact_name: named, contact_role: best.contact_role || (named && !best.contact_name ? "Geschäftsführung/Inhaber (Impressum)" : null),
    contact_source: best.contact_source, source_url: best.source_url, collected_at: now.toISOString(),
    contact_confidence: best.contact_source === "openstreetmap" ? "low" : best.contact_name ? "high" : "medium", rejected,
  };
}

// ---------- 5b) Versandgrundlage ----------

export function contactBasis(lead = {}, { candidate = false, now = new Date(), suppressed = false } = {}) {
  const basis = legalBasis(lead, now);
  const email = normEmail(lead.email || "");
  const business = !!email && !FREEMAIL_RE.test(email);
  const public_email_only = !!email && !basis;
  const out = (contact_basis, extra = {}) => ({ contact_basis, automatic_send_eligible: false, automatic_marketing_send_eligible: false, draft_creation_eligible: false,
    individual_review_required: false, message_class: null, legal_basis: "NONE", automatic_send_allowed: false, public_email_only, ...extra });
  if (basis) return out(AUTO_BASIS[basis], { automatic_send_eligible: true, automatic_marketing_send_eligible: MARKETING_BASIS.has(basis), automatic_send_allowed: true,
    legal_basis: AUTO_BASIS[basis], message_class: MARKETING_BASIS.has(basis) ? "MARKETING" : "SOLICITED_RESPONSE" });
  // Cold Lead: nur Entwurf. Gefundene Adresse, Impressum, .ch, Befund oder guter Lead lösen NIE Auto-Send aus.
  if (candidate && business && !suppressed && lead.status !== "do_not_contact" && lead.status !== "suppressed")
    return out(CONTACT_BASIS.COLD_LEAD_DRAFT_ONLY, { draft_creation_eligible: true, individual_review_required: true, message_class: "DRAFT_ONLY" });
  return out(CONTACT_BASIS.NONE);
}

// ---------- 6) Ranking ----------

const LEVEL = { high: 3, medium: 2, low: 1 };
export function repairFitScore({ swiss, condition, evidence = [], lead = {} }) {
  const parts = {
    swiss_confidence: LEVEL[swiss?.swiss_confidence] || 0,
    site_maintainability: { modern_maintainable: 3, repairable: 2 }[condition?.site_condition] || 0,
    repair_issue_confidence: Math.min(3, evidence.filter((e) => e.reproducible).length),
    repair_issue_value: Math.max(0, ...evidence.map((e) => LEVEL[e.severity] || 0)),
    contact_quality: (lead.email && lead.contact_source ? 2 : lead.email ? 1 : 0) + (lead.uid ? 1 : 0),
  };
  return { repair_fit_score: Object.values(parts).reduce((a, b) => a + b, 0), components: parts };
}

// ---------- 7) Gesamtbewertung + Lebenszyklus ----------

const swissFor = (lead) => lead.swiss_evidence ? { country: lead.country || null, swiss_evidence: lead.swiss_evidence, swiss_confidence: lead.swiss_confidence || "none" }
  : swissSignals({ domain: lead.domain || "", uid: lead.uid, discoverySource: lead.discoverySource || "" });

export function qualifyRepairLead(lead = {}, { now = new Date(), review = null, base = null, suppressed = false } = {}) {
  const swiss = swissFor(lead);
  const condition = siteCondition(lead);
  const offer = classifyRepairOffer(lead, swiss, condition);
  const candidate = offer.offer_class !== NONE;
  const blocked = suppressed || ["do_not_contact"].includes(base);
  const contact = contactBasis(lead, { candidate, now, suppressed: blocked });
  const score = repairFitScore({ swiss, condition, evidence: offer.evidence, lead });
  let stage = "discovered";
  if (lead.auditedAt || lead.websiteIssues?.length) stage = "audited";
  if (stage === "audited" && swiss.country === "CH") stage = "swiss_verified";
  if (stage === "swiss_verified" && isRepairFit(condition.site_condition)) stage = "modern_repair_fit";
  if (stage === "modern_repair_fit" && candidate) {
    stage = contact.automatic_send_eligible ? "repair_candidate" : contact.draft_creation_eligible
      ? (review?.status === "draft_created" ? "draft_created" : "cold_lead_draft_only") : "blocked_no_contact_basis";
  }
  // Spätere Pipeline-Stufen (kontaktiert, Antwort, Kunde, Sperre) aus dem bestehenden Lebenszyklus haben Vorrang.
  if (["contacted", "replied", "customer", "not_interested", "do_not_contact"].includes(base)) stage = base;
  if (["manually_sent", "sent"].includes(review?.status) && !["replied", "customer", "not_interested", "do_not_contact"].includes(stage)) stage = "contacted";
  return {
    country: swiss.country, swiss_evidence: swiss.swiss_evidence, swiss_confidence: swiss.swiss_confidence,
    site_condition: condition.site_condition, site_condition_reasons: condition.reasons,
    repair_evidence: offer.evidence, offer, ...contact, ...score, stage,
    contact_name: lead.contact_name || null, contact_role: lead.contact_role || null, business_email: contact.draft_creation_eligible || contact.automatic_send_eligible ? normEmail(lead.email || "") : null,
    contact_source: lead.contact_source || lead.emailSource || null, source_url: lead.source_url || null, collected_at: lead.collected_at || lead.auditedAt || null,
    contact_confidence: lead.contact_confidence || (lead.email ? "medium" : "none"),
    // TF-024: Begründung der Permission-Engine (nur Anzeige; entscheidet legalBasis in mail-worker.js).
    permission: contact.automatic_send_eligible ? null : evaluateSwissEmailPermission(lead, { type: contact.draft_creation_eligible ? "COLD_DRAFT" : "MARKETING" }, now).rationale,
  };
}

// ---------- 8) Individueller Entwurf ----------

const fmtDate = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : d.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }); };
const ISSUE_TEXT = {
  broken_link: (e) => `Der interne Link ${e.url} liefert eine Fehlerseite (${e.evidence}).`,
  contact_page_broken: (e) => `Die verlinkte Kontaktseite ${e.url} ist nicht erreichbar (${e.evidence}).`,
  broken_image: (e) => `Ein eingebundenes Bild wird nicht geladen: ${e.url} (${e.evidence}).`,
  broken_mailto: (e) => `Ein E-Mail-Link auf ${e.url} ist fehlerhaft (${e.evidence}).`,
  https_certificate: (e) => `Beim Aufruf von ${e.url} meldet der Browser ein Zertifikatsproblem (${e.evidence}).`,
  redirect_loop: (e) => `Der Aufruf von ${e.url} endet in einer Weiterleitungsschleife (${e.evidence}).`,
  missing_title: (e) => `Die Startseite ${e.url} hat keinen Seitentitel (${e.evidence}).`,
  no_https: (e) => `Die Website ist unter ${e.url} nicht verschlüsselt erreichbar (${e.evidence}).`,
  mixed_content: (e) => `Auf ${e.url} werden Inhalte unverschlüsselt eingebunden (${e.evidence}).`,
  slow_response: (e) => `Die Startseite ${e.url} lädt auffällig langsam (${e.evidence}).`,
  no_https_redirect: (e) => `${e.url} leitet nicht automatisch auf HTTPS weiter (${e.evidence}).`,
};
const SUBJECT_TEXT = { broken_link: "defekter Link", contact_page_broken: "Kontaktseite nicht erreichbar", broken_image: "fehlendes Bild", broken_mailto: "fehlerhafter E-Mail-Link",
  https_certificate: "Zertifikatsproblem", redirect_loop: "Weiterleitungsfehler", missing_title: "fehlender Seitentitel", no_https: "HTTPS", mixed_content: "unverschlüsselte Inhalte",
  slow_response: "Ladezeit", no_https_redirect: "HTTPS-Weiterleitung" };

export const COLD_FOOTER = "Falls solche Hinweise für Sie nicht relevant sind, genügt eine kurze Antwort und ich melde mich diesbezüglich nicht erneut.";

export function buildColdDraft(lead = {}, q = qualifyRepairLead(lead), sender = {}) {
  const ev = q.offer.evidence.slice(0, 3);
  if (!ev.length || q.offer.offer_class === NONE) throw new Error("Kein belegter Reparaturbefund – kein Entwurf.");
  const site = (lead.domain || "").replace(/^www\./, "");
  const o = OFFERS[q.offer.offer_class];
  // Anrede nur mit sicher bekanntem Namen – ohne Annahmen über Geschlecht („Guten Tag Vorname Nachname“).
  const hello = q.contact_name ? `Guten Tag ${q.contact_name}` : "Guten Tag";
  const lines = ev.map((e) => `- ${ISSUE_TEXT[e.issue_type](e)} Beobachtet am ${fmtDate(e.observed_at)}.`);
  const signature = sender.signature?.trim() || [sender.name, sender.company, sender.email].filter(Boolean).join("\n");
  const body = [
    hello,
    "",
    `bei der Durchsicht der Website von ${lead.company || site} (${site}) ist mir Folgendes aufgefallen:`,
    "",
    ...lines,
    "",
    "Ihre bestehende Website wirkt grundsätzlich weiterverwendbar. Der Punkt lässt sich voraussichtlich gezielt beheben, ohne die Website neu aufzubauen.",
    "",
    `Für solche Fälle biete ich «${o.label}» an: ${o.scope}`,
    "",
    `Ablauf und Angebote im Überblick: ${LANDING_PAGE_URL}`,
    "",
    "Wenn das für Sie interessant ist, genügt eine kurze Antwort.",
    "",
    "Freundliche Grüsse",
    signature,
    "",
    COLD_FOOTER,
  ].join("\n");
  const subject = `${lead.company || site}: ${SUBJECT_TEXT[ev[0].issue_type]} auf ${site}`;
  return { subject, body };
}
// TF-022-Name bleibt als Alias erhalten.
export const buildIndividualDraft = buildColdDraft;

// ---------- 9) Cold-Lead-Entwurf (nur Entwurf, nie gesendet) ----------

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const draftHash = (subject = "", body = "") => sha(`${subject}\n\n${body}`);
export const evidenceHash = (evidence = []) => sha(JSON.stringify(evidence.map((e) => [e.issue_type, e.url, e.evidence, e.observed_at, e.severity])));
const DAY_MS = 86_400_000;
const LEGAL = Object.freeze({ draft_mode: COLD_MODE, message_class: "DRAFT_ONLY", automatic_send_allowed: false, legal_basis: "NONE",
  manual_send_decision_required: true, legal_status: "NO_AUTOMATIC_SEND_BASIS" });
// Diese Felder sind fest – kein Aufruf (Dashboard, manueller Versand, Bearbeitung) kann sie ändern.
const withLegal = (r) => ({ ...r, ...LEGAL });

export function createColdDraft(lead, { sender = {}, now = new Date(), q = qualifyRepairLead(lead, { now }) } = {}) {
  if (!q.draft_creation_eligible || q.contact_basis !== COLD_MODE) throw new Error("Nur für COLD_LEAD_DRAFT_ONLY.");
  const { subject, body } = buildColdDraft(lead, q, sender);
  const issue_evidence = q.offer.evidence.slice(0, 3);
  return withLegal({
    lead_id: lead.domain, jarvis_draft_id: `cold:${lead.domain}:${now.getTime()}`, company: lead.company || null, domain: lead.domain,
    recipient: normEmail(lead.email), contact_name: q.contact_name, contact_role: q.contact_role, business_email: normEmail(lead.email),
    contact_source: q.contact_source, source_url: q.source_url, collected_at: q.collected_at, contact_confidence: q.contact_confidence,
    offer_class: q.offer.offer_class, issue_evidence, evidence_hash: evidenceHash(issue_evidence), repair_fit_score: q.repair_fit_score,
    subject, body, draft_hash: draftHash(subject, body),
    status: "queued", gmail_draft_id: null, message_id: null, thread_id: null,
    manual_send_detected: false, manual_send_at: null, gmail_message_id: null, created_at: now.toISOString(), updated_at: now.toISOString(),
  });
}

const normCo = (s = "") => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\b(ag|gmbh|sa|sarl|sagl|kg|klg)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
// Duplikat: gleiche Firma, Domain, Empfänger oder gleicher Befund – offen, bereits verschickt oder innerhalb der Sperrfrist verworfen.
export function coldDuplicate(records = {}, lead = {}, { contacted = new Set(), now = new Date() } = {}) {
  const to = normEmail(lead.email || ""), co = normCo(lead.company || "");
  if (to && contacted.has(to)) return "bereits kontaktiert";
  for (const r of Object.values(records)) {
    const same = r.lead_id === lead.domain || r.domain === lead.domain || (to && normEmail(r.recipient || "") === to) || (co && normCo(r.company || "") === co);
    if (!same) continue;
    if (["queued", "draft_created"].includes(r.status) || r.discard_requested) return "offener Entwurf vorhanden";
    if (["manually_sent", "sent"].includes(r.status)) return "bereits kontaktiert";
    if (+now - Date.parse(r.updated_at || r.created_at) < COLD_DRAFT_COOLDOWN_DAYS * DAY_MS) return `innerhalb der Sperrfrist (${COLD_DRAFT_COOLDOWN_DAYS} Tage)`;
  }
  return null;
}

// Legt höchstens einen lokalen Cold-Entwurf je Firma an (der Gmail-Entwurf entsteht im Mail-Worker). Nie senden.
export function ensureColdDraft(store, lead, { sender, now = new Date(), contacted, suppression = store.read("suppression.json", {}) } = {}) {
  const data = store.read(COLD_DRAFTS_FILE, { reviews: {} });
  const to = normEmail(lead.email || "");
  if (suppression[to] || Object.keys(suppression).some((a) => a.split("@")[1] === lead.domain && !FREEMAIL_RE.test(a))) return { blocked: "suppression" };
  const dup = coldDuplicate(data.reviews, lead, { contacted, now });
  if (dup) return { blocked: dup, existing: data.reviews?.[lead.domain] || null };
  const r = createColdDraft(lead, { sender, now });
  store.write(COLD_DRAFTS_FILE, { ...data, reviews: { ...(data.reviews || {}), [lead.domain]: r } });
  return r;
}
export const ensureReview = (store, lead, opts) => ensureColdDraft(store, lead, opts);

const one = (id) => { if (typeof id !== "string" || !id || id.length > 253) throw new Error("Genau eine lead_id angeben – keine Sammelaktion."); return id; };

// Dashboard-Aktionen – je Aufruf genau EIN Entwurf. Es gibt kein Senden, kein Erzwingen, keine Rechtsgrundlage zum Setzen.
export function coldDraftAction(store, action, payload = {}, now = new Date()) {
  if (Array.isArray(payload) || Array.isArray(payload.lead_id) || "lead_ids" in payload || "all" in payload) throw new Error("Sammelaktion ist nicht erlaubt – nur einzelne Entwürfe.");
  const id = one(payload.lead_id);
  const data = store.read(COLD_DRAFTS_FILE, { reviews: {} });
  const r = data.reviews?.[id];
  if (!r) throw new Error("Entwurf nicht gefunden.");
  let next;
  if (action === "edit") {
    if (!["queued", "draft_created"].includes(r.status)) throw new Error("Dieser Entwurf kann nicht mehr bearbeitet werden.");
    const { subject = r.subject, body = r.body } = payload;
    if (typeof subject !== "string" || typeof body !== "string" || !subject.trim() || !body.trim() || body.length > 6000 || /[\r\n]/.test(subject)) throw new Error("Betreff und Text erforderlich (max. 6000 Zeichen).");
    next = { ...r, subject, body, draft_hash: draftHash(subject, body), pending_update: r.status === "draft_created", updated_at: now.toISOString() };
  } else if (action === "discard") {
    if (!["queued", "draft_created"].includes(r.status)) throw new Error("Dieser Entwurf kann nicht verworfen werden.");
    next = r.status === "queued" ? { ...r, status: "discarded", updated_at: now.toISOString() } : { ...r, discard_requested: true, updated_at: now.toISOString() };
  } else if (action === "mark-manual-sent") {
    if (r.status !== "draft_created") throw new Error("Nur ein in Gmail vorhandener Entwurf kann als manuell versendet markiert werden.");
    next = { ...r, status: "manually_sent", manual_send_marked: true, manual_send_at: now.toISOString(), updated_at: now.toISOString() };
  } else throw new Error("Unbekannte Aktion.");
  const fresh = store.read(COLD_DRAFTS_FILE, { reviews: {} });
  fresh.reviews = { ...(fresh.reviews || {}), [id]: withLegal(next) };
  store.write(COLD_DRAFTS_FILE, fresh);
  return fresh.reviews[id];
}

// Vom Mail-Worker nach einem erkannten manuellen Versand: nur Fakten (Zeit, IDs) – legal_basis bleibt NONE.
export const markManualSend = (r, { messageId, threadId, sentAt }) =>
  withLegal({ ...r, status: "manually_sent", manual_send_detected: true, manual_send_at: sentAt, gmail_message_id: messageId, thread_id: threadId, updated_at: new Date().toISOString() });
