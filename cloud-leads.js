// Cloud-Lead-Ansicht (READ-only) für Handy/Cloud: nur serverseitig definierte Felder per Allowlist.
// Quelle ist die Lead-Pipeline auf dem VPS (sales.loadPipeline); der VPS-Agent schickt die bereinigte Liste mit seinem Status-Pull an
// /api/server-control, die Cloud prüft sie erneut (cleanLeads) und zeigt sie Chris im HUD. Nie dabei: technische Roh-Evidence, Befund-URLs,
// Gmail-/Thread-/Message-IDs, Tokens, Pfade, interne Diagnosen. Bewusst ohne Node-Abhängigkeiten (Netlify Function + VPS).
export const CLOUD_LEAD_LIMIT = 150;
export const LEAD_ID_RE = /^[a-z0-9][a-z0-9.-]{2,252}$/;
export const DRAFT_STATUSES = ["none", "queued", "draft_created", "manually_sent", "sent", "discarded", "blocked"];
const STAGES = ["discovered", "audited", "swiss_verified", "modern_repair_fit", "repair_candidate", "individual_review_required", "blocked_no_contact_basis", "no_visible_issue",
  "cold_lead_draft_only", "draft_created", "approved_one_to_one", "contacted", "replied", "customer", "not_interested", "do_not_contact", "blocked_no_legal_basis", "approved"];
const OFFERS = ["REPAIR_CHECK_150", "REPAIR_FIX_500", "NONE"];
// Diese Felder – und nur diese – erreichen den Browser.
export const CLOUD_LEAD_FIELDS = Object.freeze(["lead_id", "company", "website", "problems", "contact_name", "contact_role", "business_email", "stage", "offer_class",
  "draft_status", "draft_in_gmail", "draft_updated_at", "suppressed", "opted_out", "draft_eligible", "draft_mode", "last_contact_at", "replied", "customer", "updated_at"]);
export const COLD_MODE = "COLD_LEAD_DRAFT_ONLY";

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const URLISH = /https?:|www\.|[<>{}]|\/[a-z0-9_-]+\.(php|html?|aspx?)/i;
const norm = (s) => String(s || "").trim().toLowerCase();
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : null) || null;
const iso = (v) => (typeof v === "string" && ISO_RE.test(v) ? v : null);
const oneOf = (v, list, d = null) => (list.includes(v) ? v : d);
// Kundentext ohne Fachbegriffe, ohne URLs, kurz. Alles andere fällt weg (nie „irgendwas“ anzeigen).
const problem = (v) => { const s = str(v, 240); return s && !URLISH.test(s) ? s : null; };

const RELEVANT = new Set(["cold_lead_draft_only", "draft_created", "repair_candidate", "approved_one_to_one", "contacted", "replied", "customer", "not_interested", "individual_review_required", "approved"]);
// Aus einem Pipeline-Lead (sales.loadPipeline) die öffentliche Sicht bauen. Keine Rohdaten, keine IDs.
export function publicLead(l, now = new Date()) {
  if (!l || typeof l !== "object" || !LEAD_ID_RE.test(norm(l.domain))) return null;
  const rp = l.repair || {}, rv = l.review || null, c = l.contact || {};
  const findings = Array.isArray(rp.customer_findings) ? rp.customer_findings : [];
  const problems = findings.map((f) => [problem(f?.text), problem(f?.impact)].filter(Boolean).join(" – ")).filter(Boolean).slice(0, 2);
  const suppressed = l.suppressed === true || l.status === "do_not_contact";
  const optedOut = l.optedOut === true;
  const draftStatus = rv ? oneOf(rv.status, DRAFT_STATUSES, "blocked") : "none";
  const openDraft = ["queued", "draft_created", "manually_sent", "sent"].includes(draftStatus);
  const eligible = rp.draft_creation_eligible === true && rp.contact_basis === COLD_MODE && problems.length > 0 && !suppressed && !optedOut && !openDraft && !!(rp.business_email || c.email);
  return {
    lead_id: norm(l.domain), company: str(l.company, 120), website: str(l.website, 200) || `https://${norm(l.domain)}`,
    problems, contact_name: str(rp.contact_name || c.name, 80), contact_role: str(rp.contact_role, 80),
    business_email: EMAIL_RE.test(norm(rp.business_email || c.email)) ? norm(rp.business_email || c.email) : null,
    stage: oneOf(rp.stage, STAGES, oneOf(l.status, STAGES, "discovered")), offer_class: oneOf(rp.offer?.offer_class || l.offer?.offer_class, OFFERS, "NONE"),
    draft_status: draftStatus, draft_in_gmail: !!rv?.gmail_draft_id, draft_updated_at: iso(rv?.updated_at),
    suppressed, opted_out: optedOut, draft_eligible: eligible, draft_mode: COLD_MODE,
    last_contact_at: iso(l.lastContactAt), replied: l.replied === true, customer: l.status === "customer" || !!l.customerStatus, updated_at: now.toISOString(),
  };
}
// Nur relevante Leads (Cold Leads, Entwürfe, Kandidaten, Kontaktierte), sortiert: offene Entwürfe, dann erstellbare, dann Rest. Begrenzt.
export function publicLeads(list = [], now = new Date()) {
  const rank = (p) => (["queued", "draft_created"].includes(p.draft_status) ? 0 : p.draft_eligible ? 1 : p.replied ? 2 : 3);
  return (Array.isArray(list) ? list : []).map((l) => publicLead(l, now)).filter((p) => p && (RELEVANT.has(p.stage) || p.draft_status !== "none" || p.draft_eligible || p.offer_class !== "NONE"))
    .sort((a, b) => rank(a) - rank(b) || String(a.company || a.lead_id).localeCompare(String(b.company || b.lead_id))).slice(0, CLOUD_LEAD_LIMIT);
}
// Cloud-Seite: alles, was der Agent schickt, erneut auf die Allowlist bringen (unbekannte Felder fallen weg, Typen erzwungen).
export function cleanLead(p) {
  if (!p || typeof p !== "object" || !LEAD_ID_RE.test(String(p.lead_id || ""))) return null;
  const problems = (Array.isArray(p.problems) ? p.problems : []).map(problem).filter(Boolean).slice(0, 2);
  return {
    lead_id: p.lead_id, company: str(p.company, 120), website: (() => { const w = str(p.website, 200); return w && /^https?:\/\/[^\s/]+/.test(w) && !/[<>"' ]/.test(w) ? w : null; })(),
    problems, contact_name: str(p.contact_name, 80), contact_role: str(p.contact_role, 80), business_email: EMAIL_RE.test(norm(p.business_email)) ? norm(p.business_email) : null,
    stage: oneOf(p.stage, STAGES, "discovered"), offer_class: oneOf(p.offer_class, OFFERS, "NONE"),
    draft_status: oneOf(p.draft_status, DRAFT_STATUSES, "none"), draft_in_gmail: p.draft_in_gmail === true, draft_updated_at: iso(p.draft_updated_at),
    suppressed: p.suppressed === true, opted_out: p.opted_out === true, draft_eligible: p.draft_eligible === true && p.suppressed !== true && p.opted_out !== true, draft_mode: COLD_MODE,
    last_contact_at: iso(p.last_contact_at), replied: p.replied === true, customer: p.customer === true, updated_at: iso(p.updated_at),
  };
}
export const cleanLeads = (list) => (Array.isArray(list) ? list : []).map(cleanLead).filter(Boolean).slice(0, CLOUD_LEAD_LIMIT);
// Kurzer Fingerabdruck, damit der Agent die Liste nur bei Änderung schickt.
export function leadsFingerprint(list = []) {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(list.map(({ updated_at, ...p }) => p))) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
