// Swiss Repair Outreach (TF-022) – Jarvis sucht Schweizer Firmen mit grundsätzlich brauchbarer Website und einem konkreten,
// passiv belegten Reparaturbefund. Angeboten werden ausschliesslich REPAIR_CHECK_150 (CHF 150) und REPAIR_FIX_500 (CHF 500).
// Kein Neubau, kein Redesign, kein Upsell. Dieses Modul sendet nie selbst.
//
// Versandgrundlagen (contact_basis):
//   OPT_IN                              dokumentierte Einwilligung                    → automatische Fenster erlaubt
//   EXISTING_CUSTOMER_SIMILAR_SERVICE   Bestandskunde + ähnliche eigene Leistung       → automatische Fenster erlaubt
//   REQUESTED_CONTACT                   Empfänger hat selbst angefragt (Quelle/Datum/Umfang),
//                                       nur wenn der Umfang Website/Reparatur abdeckt → automatische Fenster erlaubt
//   INDIVIDUAL_ONE_TO_ONE_REVIEW        neue Schweizer Firma ohne obige Grundlage      → NIE automatisch, nie Batch, nie Follow-up.
//                                       Einzelner Entwurf, Chris prüft und gibt genau diese Mail frei (lead_id + Empfänger +
//                                       draft_hash + Befund-Hash). Jede Änderung an Entwurf oder Empfänger hebt die Freigabe auf.
//   NONE                                kein Kontakt (blocked_no_contact_basis)
// Eine öffentliche Adresse allein (public_email_only) ist nie eine automatische Versandgrundlage.
import crypto from "node:crypto";
import { legalBasis, normEmail, finalizeCommercial } from "./mail-worker.js";
import { OFFERS, NONE } from "./sales.js";

export const REVIEWS_FILE = "individual_reviews.json";
export const CONTACT_BASIS = Object.freeze({
  OPT_IN: "OPT_IN", EXISTING_CUSTOMER_SIMILAR_SERVICE: "EXISTING_CUSTOMER_SIMILAR_SERVICE", REQUESTED_CONTACT: "REQUESTED_CONTACT",
  INDIVIDUAL_ONE_TO_ONE_REVIEW: "INDIVIDUAL_ONE_TO_ONE_REVIEW", NONE: "NONE",
});
const AUTO_BASIS = { opt_in: "OPT_IN", existing_customer: "EXISTING_CUSTOMER_SIMILAR_SERVICE", requested_contact: "REQUESTED_CONTACT" };
export const SITE_CONDITIONS = Object.freeze(["modern_maintainable", "repairable", "unclear", "redesign_likely"]);
export const REPAIR_LIFECYCLE = Object.freeze(["discovered", "audited", "swiss_verified", "modern_repair_fit", "repair_candidate", "blocked_no_contact_basis",
  "individual_review_required", "approved_one_to_one", "contacted", "replied", "customer", "not_interested", "do_not_contact"]);

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

// "fix": Umsetzung sinnvoll (CHF 500); "check": zuerst Analyse/Dokumentation (CHF 150).
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
    `Website grundsätzlich weiterverwendbar; konkrete reparierbare Befunde: ${types(fix)}.`, "Reparatur CHF 500 anbieten – nur mit diesen Befunden.");
  return out("REPAIR_CHECK_150", evidence.some((e) => e.reproducible) ? "medium" : "low",
    `Befunde (${types(evidence)}) rechtfertigen Analyse/Dokumentation, keine grössere Umsetzung.`, "Website-Check CHF 150 anbieten – nur mit diesen Befunden.");
}

// ---------- 5) Versandgrundlage ----------

export function contactBasis(lead = {}, { candidate = false, now = new Date() } = {}) {
  const basis = legalBasis(lead, now);
  const email = normEmail(lead.email || "");
  const public_email_only = !!email && !basis;
  if (basis) return { contact_basis: AUTO_BASIS[basis], automatic_send_eligible: true, individual_review_required: false, public_email_only };
  if (candidate && email) return { contact_basis: CONTACT_BASIS.INDIVIDUAL_ONE_TO_ONE_REVIEW, automatic_send_eligible: false, individual_review_required: true, public_email_only };
  return { contact_basis: CONTACT_BASIS.NONE, automatic_send_eligible: false, individual_review_required: false, public_email_only };
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

export function qualifyRepairLead(lead = {}, { now = new Date(), review = null, base = null } = {}) {
  const swiss = swissFor(lead);
  const condition = siteCondition(lead);
  const offer = classifyRepairOffer(lead, swiss, condition);
  const candidate = offer.offer_class !== NONE;
  const contact = contactBasis(lead, { candidate, now });
  const score = repairFitScore({ swiss, condition, evidence: offer.evidence, lead });
  const approved = !!(review && approvalValid(review) && review.status === "approved");
  let stage = "discovered";
  if (lead.auditedAt || lead.websiteIssues?.length) stage = "audited";
  if (stage === "audited" && swiss.country === "CH") stage = "swiss_verified";
  if (stage === "swiss_verified" && isRepairFit(condition.site_condition)) stage = "modern_repair_fit";
  if (stage === "modern_repair_fit" && candidate) {
    stage = contact.automatic_send_eligible ? "repair_candidate" : contact.individual_review_required ? (approved ? "approved_one_to_one" : "individual_review_required") : "blocked_no_contact_basis";
  }
  // Spätere Pipeline-Stufen (kontaktiert, Antwort, Kunde, Sperre) aus dem bestehenden Lebenszyklus haben Vorrang.
  if (["contacted", "replied", "customer", "not_interested", "do_not_contact"].includes(base)) stage = base;
  if (review?.status === "sent" && !["replied", "customer", "not_interested", "do_not_contact"].includes(stage)) stage = "contacted";
  return {
    country: swiss.country, swiss_evidence: swiss.swiss_evidence, swiss_confidence: swiss.swiss_confidence,
    site_condition: condition.site_condition, site_condition_reasons: condition.reasons,
    repair_evidence: offer.evidence, offer, ...contact, ...score, stage,
    contact_source: lead.contact_source || lead.emailSource || null, source_url: lead.source_url || null, collected_at: lead.collected_at || lead.auditedAt || null,
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

export function buildIndividualDraft(lead = {}, q = qualifyRepairLead(lead), sender = {}) {
  const ev = q.offer.evidence.slice(0, 3);
  if (!ev.length || q.offer.offer_class === NONE) throw new Error("Kein belegter Reparaturbefund – kein Entwurf.");
  const site = (lead.domain || "").replace(/^www\./, "");
  const o = OFFERS[q.offer.offer_class];
  const lines = ev.map((e) => `- ${ISSUE_TEXT[e.issue_type](e)} Beobachtet am ${fmtDate(e.observed_at)}.`);
  const body = [
    "Guten Tag",
    "",
    `beim Besuch von ${site}${lead.company ? ` (${lead.company})` : ""} ist mir eine konkrete Stelle aufgefallen, die nicht wie vorgesehen funktioniert:`,
    "",
    ...lines,
    "",
    "Ihre bestehende Website ist grundsätzlich gut brauchbar – es geht nicht um einen Neubau, sondern um eine gezielte Reparatur dieses Punktes.",
    "",
    `Passend dazu biete ich «${o.label}» an: ${o.scope}`,
    "",
    "Wenn das für Sie interessant ist, genügt eine kurze Antwort. Falls nicht, ist keine Reaktion nötig.",
    "",
    "Freundliche Grüsse",
  ].join("\n");
  const subject = `${lead.company || site}: ${SUBJECT_TEXT[ev[0].issue_type]} auf ${site}`;
  return { subject, body: finalizeCommercial(body, sender, "de") };
}

// ---------- 9) Einzelfreigabe (genau eine Mail, gebunden an Empfänger + Entwurf + Befund) ----------

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const draftHash = (subject = "", body = "") => sha(`${subject}\n\n${body}`);
export const evidenceHash = (evidence = []) => sha(JSON.stringify(evidence.map((e) => [e.issue_type, e.url, e.evidence, e.observed_at, e.severity])));
const binding = (r) => sha(JSON.stringify([r.lead_id, normEmail(r.recipient || ""), r.draft_hash, r.evidence_hash]));

export function createReview(lead, { sender = {}, now = new Date(), q = qualifyRepairLead(lead, { now }) } = {}) {
  if (q.contact_basis !== CONTACT_BASIS.INDIVIDUAL_ONE_TO_ONE_REVIEW) throw new Error("Nur für INDIVIDUAL_ONE_TO_ONE_REVIEW.");
  const { subject, body } = buildIndividualDraft(lead, q, sender);
  const issue_evidence = q.offer.evidence.slice(0, 3);
  return {
    lead_id: lead.domain, company: lead.company || null, domain: lead.domain, recipient: normEmail(lead.email),
    contact_source: q.contact_source, source_url: q.source_url, collected_at: q.collected_at,
    offer_class: q.offer.offer_class, issue_evidence, evidence_hash: evidenceHash(issue_evidence),
    subject, body, draft_hash: draftHash(subject, body), contact_basis: CONTACT_BASIS.INDIVIDUAL_ONE_TO_ONE_REVIEW,
    status: "pending_review", human_reviewed: false, human_approved: false, approval: null, created_at: now.toISOString(), updated_at: now.toISOString(),
  };
}

// Gültig nur, wenn Chris genau diese Kombination freigegeben hat und seither nichts geändert wurde.
export function approvalValid(r) {
  if (!r || r.human_reviewed !== true || r.human_approved !== true || !r.approval) return false;
  if (r.draft_hash !== draftHash(r.subject, r.body) || r.evidence_hash !== evidenceHash(r.issue_evidence || [])) return false;
  const a = r.approval;
  return a.lead_id === r.lead_id && normEmail(a.recipient || "") === normEmail(r.recipient || "") && a.draft_hash === r.draft_hash
    && a.evidence_hash === r.evidence_hash && a.binding === binding(r);
}

const one = (id) => { if (typeof id !== "string" || !id || id.length > 253) throw new Error("Genau eine lead_id angeben – keine Sammelfreigabe."); return id; };

export function approveReview(r, { draft_hash, recipient, now = new Date() } = {}) {
  if (!r) throw new Error("Entwurf nicht gefunden.");
  if (r.status !== "pending_review") throw new Error(`Nur offene Entwürfe können freigegeben werden (Status ${r.status}).`);
  if (draft_hash !== r.draft_hash || draft_hash !== draftHash(r.subject, r.body)) throw new Error("Entwurf hat sich geändert – bitte erneut prüfen.");
  if (normEmail(recipient || "") !== normEmail(r.recipient || "")) throw new Error("Empfänger stimmt nicht mit dem geprüften Entwurf überein.");
  if (r.evidence_hash !== evidenceHash(r.issue_evidence || [])) throw new Error("Befund hat sich geändert – bitte erneut prüfen.");
  const out = { ...r, status: "approved", human_reviewed: true, human_approved: true, updated_at: now.toISOString() };
  out.approval = { lead_id: r.lead_id, recipient: normEmail(r.recipient), draft_hash: r.draft_hash, evidence_hash: r.evidence_hash, approved_at: now.toISOString(), approved_by: "chris" };
  out.approval.binding = binding(out);
  return out;
}

export function editReview(r, { subject = r.subject, body = r.body, recipient = r.recipient, now = new Date() } = {}) {
  if (!r || ["sent", "rejected"].includes(r.status)) throw new Error("Dieser Entwurf kann nicht mehr bearbeitet werden.");
  if (typeof subject !== "string" || typeof body !== "string" || !subject.trim() || !body.trim() || body.length > 6000) throw new Error("Betreff und Text erforderlich (max. 6000 Zeichen).");
  if (Array.isArray(recipient) || !/^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}$/i.test(recipient)) throw new Error("Genau ein gültiger Empfänger.");
  const next = { ...r, subject, body, recipient: normEmail(recipient), draft_hash: draftHash(subject, body), updated_at: now.toISOString() };
  const changed = next.draft_hash !== r.draft_hash || next.recipient !== normEmail(r.recipient);
  // Jede Änderung an Entwurf oder Empfänger: Freigabe verfällt.
  return changed ? { ...next, status: "pending_review", human_reviewed: false, human_approved: false, approval: null } : next;
}

export const rejectReview = (r, { now = new Date() } = {}) => {
  if (!r || r.status === "sent") throw new Error("Dieser Entwurf kann nicht abgelehnt werden.");
  return { ...r, status: "rejected", human_reviewed: true, human_approved: false, approval: null, updated_at: now.toISOString() };
};

// Einzige Aktion-Schnittstelle (Dashboard/Server): genau eine lead_id pro Aufruf. Sammelfreigaben gibt es nicht.
export function reviewAction(store, action, payload = {}, now = new Date()) {
  if (Array.isArray(payload) || Array.isArray(payload.lead_id) || "lead_ids" in payload || "all" in payload) throw new Error("Sammelfreigabe ist nicht erlaubt – nur einzelne Mails.");
  const id = one(payload.lead_id);
  const data = store.read(REVIEWS_FILE, { reviews: {} });
  const r = data.reviews?.[id];
  if (!r) throw new Error("Entwurf nicht gefunden.");
  const next = action === "approve" ? approveReview(r, { ...payload, now }) : action === "reject" ? rejectReview(r, { now }) : action === "edit" ? editReview(r, { ...payload, now }) : null;
  if (!next) throw new Error("Unbekannte Aktion.");
  const fresh = store.read(REVIEWS_FILE, { reviews: {} });
  fresh.reviews = { ...(fresh.reviews || {}), [id]: next };
  store.write(REVIEWS_FILE, fresh);
  return next;
}

// Legt für eine neue Firma höchstens einen offenen Entwurf an (nie überschreiben, nie senden).
export function ensureReview(store, lead, { sender, now = new Date() } = {}) {
  const data = store.read(REVIEWS_FILE, { reviews: {} });
  if (data.reviews?.[lead.domain]) return data.reviews[lead.domain];
  const r = createReview(lead, { sender, now });
  store.write(REVIEWS_FILE, { ...data, reviews: { ...(data.reviews || {}), [lead.domain]: r } });
  return r;
}
