// Jarvis Lead-CRM (TF-053) – Zusammenführung, CRM-Aktionen und Allowlist. Ohne Node-Abhängigkeiten (VPS-Dienst UND Netlify-Funktion).
//
// Authoritativ bleiben die bestehenden Quellen (nur gelesen, nie kopiert):
//   lead_registry.json (Mail-Worker)          Firma, Gebiet, Branche, Sperren (DNC/Opt-out/Suppression), Kunde, Kontakt-Historie
//   lead_contact_directory.json (Kontakte)    Website, E-Mail, Geschäftstelefon, Inhaber/GF + Rolle, Website-Prüfung, Draft-Status
//   individual_reviews.json (Cold-Register)   bestätigte Befunde (Kundentext), Audit-Evidence, Entwurf erstellt/manuell gesendet
//   gmail_jarvis.json (Gmail-Register)        ob der Entwurf noch existiert (Link nur dann), manueller Versand
//   site_findings.json (CRM-Dienst, TF-055)    vollständige passive Audits je Domain (site-backfill.js) → genaue Fehlerzahl
//   repair_findings.json (Repair, TF-055)      Stand nach einer CHF-480-Reparatur (RESOLVED fällt aus der Zahl, manuelle Punkte bleiben)
//   discovery_issue_history.json (CRM, TF-058) historische Discovery-Funde mit belegtem Fehler (low_score/no_contact/Backup/Recheck) –
//                                              niedrigste Priorität, nie eine Outreach-Quelle (discovery-history.js)
// lead_crm.json hält NUR CRM-Eigenes (Stufe, Kontakt-/Telefonstatus, Anrufe, Notizen, Follow-up, Do Not Contact, Archiv).
// Die CRM-Sicht entsteht zur Laufzeit – neue Leads, neue Telefonnummern/Personen und neue Befunde erscheinen ohne Migration.
//
// Nichts hier sendet, ruft an oder erstellt Entwürfe. Do Not Contact wirkt sofort im CRM (keine Anruf-Empfehlung, kein Follow-up,
// keine Outreach-Queue) und – über lead-registry.js registryBlock – auf neue Cold-Entwürfe des Mail-Workers.
import { SALES_STAGES, CALL_STATUSES, CONTACT_STATUSES, PRIORITY_LEVELS, DRAFT_STATUSES, priorityOf, followUpBucket, callRecommended, issueLines, issueLink } from "./public/crm-model.js";
import { siteHealth, httpStatusOf, AUDIT_STATES, ISSUE_CATEGORIES, FINDING_SOURCES } from "./site-findings.js";
import { buildIndex, findId, normCompany } from "./lead-db.js";
import { displayCategory } from "./category-labels.js";

export const CRM_FILE = "lead_crm.json";
export const CRM_AUDIT_FILE = "crm_audit.jsonl";
export const CRM_SCHEMA = 1;
export const COLD_MODE = "COLD_LEAD_DRAFT_ONLY";
export const MAX_NOTES = 500;
export const MAX_CALLS = 500;
export const APPLIED_KEEP = 2000;
export const LEAD_ID_RE = /^[a-z0-9][a-z0-9.@_+-]{2,252}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const HEX_RE = /^[0-9a-f]{10,24}$/;
const REQ_RE = /^[0-9a-f-]{36}$/;

// ---------- Hilfen ----------
const str = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, n) : null) || null;
const text = (v, n) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, n) : null) || null;
const iso = (v) => (typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const day = (v) => (typeof v === "string" && DAY_RE.test(v) && !Number.isNaN(Date.parse(v + "T12:00:00Z")) ? v : null);
const oneOf = (v, list, d = null) => (list.includes(v) ? v : d);
const maxIso = (...xs) => xs.filter((x) => typeof x === "string" && x).sort().at(-1) || null;
const normDomain = (u = "") => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const httpUrl = (u, n = 300) => { if (typeof u !== "string" || u.length > n) return null; try { const x = new URL(u); return ["http:", "https:"].includes(x.protocol) && !/[<>"'\s]/.test(u) ? x.href : null; } catch { return null; } };
export const telHref = (normalized) => (typeof normalized === "string" && /^\+41\d{9}$/.test(normalized) ? `tel:${normalized}` : null);
// TF-063: Vietnam-Nummern (+84, 9–10 Ziffern nach der Landesvorwahl) – nur für VN-Leads.
export const telHrefVn = (normalized) => (typeof normalized === "string" && /^\+84\d{9,10}$/.test(normalized) ? `tel:${normalized}` : null);
export const draftUrl = (messageId) => (typeof messageId === "string" && HEX_RE.test(messageId) ? `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}` : null);

// ---------- Befunde ----------
// Bestätigt = vom Cold-Register als Kundentext geführt (customer_findings; TF-050 erneut öffentlich geprüft, 1–3 im Entwurf).
// Weitere = beim Audit belegt, aber nicht im Entwurf (nur für Besucher sichtbare Typen, kurze Beschreibung, keine Diagnose).
const VISIBLE_EXTRA = { broken_link: "Ein Link führt auf eine Fehlerseite", broken_image: "Ein Bild wird nicht angezeigt", broken_mailto: "Ein E-Mail-Link funktioniert nicht",
  contact_page_broken: "Der Link zur Kontaktseite führt auf eine Fehlerseite", contact_form_broken: "Das Kontaktformular lässt sich nicht absenden",
  https_certificate: "Der Browser zeigt beim Öffnen eine Warnmeldung", redirect_loop: "Die Website lädt beim Aufruf nicht" };
const SEVERITIES = ["critical", "high", "medium", "low"];
const pageOfEvidence = (e) => (typeof e?.evidence === "string" ? e.evidence.match(/\((?:verlinkt|eingebunden) auf (https?:\/\/[^\s)]+)\)/)?.[1] : null) || null;
// TF-059: belegte Fakten aus der Audit-Evidence (Linktext, HTTP-Status, Bereich) – kein Evidence-Text selbst.
const evidenceFacts = (e) => (e ? { label: str(e.label, 40), http_status: httpStatusOf(e), location: str(e.location, 60), viewport: Number.isInteger(e.viewport) ? e.viewport : null } : {});
const refKey = (t, u) =>`${t}|${String(u || "").replace(/#.*$/, "").replace(/\/+$/, "")}`;
export function findingsOf(review, regLead) {
  const out = [];
  if (review) {
    const ev = Array.isArray(review.issue_evidence) ? review.issue_evidence : [];
    const byRef = new Map(ev.map((e) => [refKey(e.issue_type, e.url), e]));
    const covered = new Set();
    for (const f of Array.isArray(review.customer_findings) ? review.customer_findings : []) {
      const refs = Array.isArray(f?.internal_refs) ? f.internal_refs : [];
      refs.forEach((r) => covered.add(refKey(r.issue_type, r.url)));
      const e = refs.map((r) => byRef.get(refKey(r.issue_type, r.url))).find(Boolean) || null;
      const t = str(f?.text, 240);
      if (!t) continue;
      out.push({ key: str(f.key, 80), text: t, page: httpUrl(pageOfEvidence(e) || (["broken_link", "broken_image", "broken_mailto"].includes(refs[0]?.issue_type) ? null : refs[0]?.url) || null),
        status: "BESTÄTIGT", confirmed: true, severity: oneOf(f.severity || e?.severity, SEVERITIES), verified_at: iso(review.updated_at) || iso(e?.observed_at),
        type: str(refs[0]?.issue_type, 40), target: httpUrl(refs[0]?.url), ...evidenceFacts(e) }); // type/target/Fakten nur intern (Fehlerzahl TF-055, Detail TF-059) – nicht in der Findings-Allowlist
    }
    for (const e of ev) {
      if (!e || !VISIBLE_EXTRA[e.issue_type] || covered.has(refKey(e.issue_type, e.url)) || e.reproducible === false || e.severity === "low") continue;
      covered.add(refKey(e.issue_type, e.url));
      out.push({ key: `${e.issue_type}`, text: VISIBLE_EXTRA[e.issue_type], page: httpUrl(pageOfEvidence(e) || (e.issue_type.startsWith("broken_") ? null : e.url)),
        status: "AUDIT", confirmed: false, severity: oneOf(e.severity, SEVERITIES), verified_at: iso(e.observed_at), type: e.issue_type, target: httpUrl(e.url), ...evidenceFacts(e) });
    }
    return out;
  }
  // Ohne Cold-Register-Eintrag: die (bereits kundentauglichen) Befunde der Lead-Datenbank.
  for (const f of Array.isArray(regLead?.customer_visible_findings) ? regLead.customer_visible_findings : []) {
    const t = str(typeof f === "string" ? f : f?.text, 240);
    if (t) out.push({ key: null, text: t, page: null, status: "BESTÄTIGT", confirmed: true, severity: null, verified_at: iso(regLead.last_audited_at) });
  }
  return out;
}

// ---------- CRM-Zustand ----------
export const emptyCrmState = (now = new Date()) => ({ schema: CRM_SCHEMA, created_at: now.toISOString(), updated_at: now.toISOString(), leads: {}, meta: { applied: {} } });
export function normalizeCrmState(s, now = new Date()) {
  if (s && s.schema > CRM_SCHEMA) throw new Error(`${CRM_FILE} hat Schema ${s.schema}, dieser Code kennt nur ${CRM_SCHEMA} – fail closed.`);
  const st = s && typeof s === "object" ? s : emptyCrmState(now);
  st.schema = CRM_SCHEMA; st.leads ||= {}; st.meta ||= {}; st.meta.applied ||= {};
  return st;
}
export const newCrmEntry = (lead_id, now = new Date()) => ({
  lead_id, sales_stage: null, contact_status: null, call_status: "NOT_CALLED", last_contact_at: null, next_action: null, next_action_at: null,
  notes: [], call_history: [], do_not_contact: false, do_not_contact_at: null, do_not_contact_reason: null, archived: false, archived_at: null,
  created_at: now.toISOString(), updated_at: now.toISOString(),
});

// ---------- Sicht: Quellen + CRM zur Laufzeit zusammenführen ----------
// Welche Leads gehören ins CRM? Alle Jarvis-eigenen Cold Leads (Kontaktverzeichnis), alle Leads der Datenbank, mit denen es
// bereits einen Vertriebsschritt gab (Entwurf, manuell angeschrieben, Antwort, Kunde, kein Interesse), und (TF-057) alle
// qualifizierten Leads mit mindestens einem verifizierten, für Besucher sichtbaren Befund – auch ohne bzw. vor dem Gmail-Entwurf.
// Die Lead-Datenbank enthält nur qualifizierte Discovery-Leads (no_issues/low_score/audit_error/excluded_* kommen nie hinein);
// discovered.json bleibt Rohdaten und wird hier nicht gelesen. Neue Leads erscheinen automatisch.
const CRM_REGISTRY_STATUSES = new Set(["DRAFT_CREATED", "MANUALLY_SENT", "REPLIED", "CUSTOMER", "NOT_INTERESTED"]);
const PRE_DRAFT_STATUSES = new Set(["QUALIFIED", "WAITING_FOR_DRAFT"]);
// Qualifiziert und vertriebsrelevant, aber noch ohne Entwurf: Firma + Domain + ≥ 1 kundensichtbarer Befund (gleiche Auswahl wie im Cold-Entwurf).
export const qualifiedPreDraft = (l) => !!l && PRE_DRAFT_STATUSES.has(l.status) && l.qualified === true && !!str(l.company, 120) && !!normDomain(l.domain || "")
  && (Array.isArray(l.customer_visible_findings) ? l.customer_visible_findings : []).some((f) => str(typeof f === "string" ? f : f?.text, 240));
// TF-058: historischer Discovery-Fund – Firma, Domain, Audit-Zeitpunkt und ≥ 1 belegter, für Besucher sichtbarer Befund.
export const HISTORY_BADGES = Object.freeze(["HISTORICAL", "REVERIFIED"]);
// TF-075A: Kontaktformular-Anfrage zu diesem Lead (nur zugeordnete Anfragen; Status-Wörter, nie Mailinhalt/Header).
export const CONTACT_FORM_STATUSES = Object.freeze(["NEW", "DRAFT_CREATED", "REVIEW_REQUIRED"]);
export function cleanContactForm(c) {
  if (!c || typeof c !== "object" || !CONTACT_FORM_STATUSES.includes(c.status)) return null;
  return { status: c.status, matched: c.matched === true, received_at: iso(c.received_at), count: Number.isInteger(c.count) ? Math.max(1, Math.min(1000, c.count)) : 1 };
}
const histValid = (h) => !!h && typeof h === "object" && LEAD_ID_RE.test(String(h.domain || "")) && !!str(h.company, 120) && !!iso(h.last_verified_at)
  && Array.isArray(h.verified_findings) && h.verified_findings.some((f) => str(f?.text, 240));
export const historyOf = (src, domain) => { const h = domain ? src.history?.leads?.[domain] : null; return histValid(h) ? h : null; };
// Ein aktueller vollständiger Audit (TF-055-Backfill) ohne offenen Befund → der historische Fund ist behoben, kein CRM-Lead mehr.
const resolvedNow = (src, domain, now) => {
  const f = src.siteFindings?.domains?.[domain]?.full;
  return !!f && f.complete === true && !!iso(f.audited_at) && +now - Date.parse(f.audited_at) <= 7 * 86_400_000 && !(f.findings || []).some((x) => x?.status !== "RESOLVED");
};
export function crmUniverse(src = {}, now = new Date()) {
  const leads = src.registry?.leads || {};
  const ids = new Set(Object.keys(src.directory?.leads || {}));
  for (const [id, l] of Object.entries(leads)) if (CRM_REGISTRY_STATUSES.has(l?.status) || l?.customer_status === "customer" || qualifiedPreDraft(l)) ids.add(id);
  // Cold-Entwurf in der Queue (queued) zählt schon – nicht erst mit gmail_draft_id.
  for (const [id, r] of Object.entries(src.reviews || {})) if (r?.draft_mode === COLD_MODE && (r.gmail_draft_id || r.status === "queued")) ids.add(id);
  // Dedupe wie die Lead-Datenbank (Domain / geschäftliche Adresse / Firma): ein Eintrag ausserhalb der Datenbank, der dort schon als
  // anderer CRM-Lead geführt wird, ist kein zweiter Datensatz. Mit eigenen CRM-Daten (Notizen, Anrufe) bleibt er sichtbar – nie Datenverlust.
  const idx = { ...buildIndex(leads), ids: new Set(Object.keys(leads)) };
  // TF-058: historische Funde (niedrigste Priorität). Kennt die Lead-Datenbank die Firma schon → deren Datensatz (Registry gewinnt);
  // sonst genau ein CRM-Lead je Domain/Adresse/Firma. Behoben (aktueller vollständiger Audit ohne offenen Befund) → nicht mehr im CRM.
  const seen = { email: new Set(), company: new Set() };
  const known = new Set([...Object.values(src.directory?.leads || {}), ...Object.values(src.reviews || {})].map((x) => normDomain(x?.domain || "")).filter(Boolean));
  for (const h of Object.values(src.history?.leads || {}).sort((a, b) => String(a?.domain).localeCompare(String(b?.domain)))) {
    if (!histValid(h)) continue;
    const own = !!src.crm?.leads?.[h.domain];
    const hit = findId(idx, { domain: h.domain, email: h.business_email, company: h.company });
    if (hit) { ids.add(hit); continue; }
    if (ids.has(h.domain) || (known.has(h.domain) && !own)) continue;
    if (!own && resolvedNow(src, h.domain, now)) continue;
    const c = normCompany(h.company), e = h.business_email || "";
    if (!own && ((e && seen.email.has(e)) || (c.length >= 4 && seen.company.has(c)))) continue;
    if (e) seen.email.add(e);
    if (c.length >= 4) seen.company.add(c);
    ids.add(h.domain);
  }
  return new Set([...ids].filter((id) => {
    if (!LEAD_ID_RE.test(id)) return false;
    if (leads[id] || src.crm?.leads?.[id]) return true;
    const dir = src.directory?.leads?.[id], rv = src.reviews?.[id], h = dir || rv ? null : historyOf(src, id);
    const hit = findId(idx, { domain: dir?.domain || rv?.domain || h?.domain || (id.includes("@") ? "" : id), email: dir?.email || rv?.recipient || h?.business_email || (id.includes("@") ? id : ""),
      company: dir?.company_name || rv?.company || h?.company });
    return !(hit && hit !== id && ids.has(hit));
  }));
}
function draftInfo(dir, rv, gmail, reg) {
  const draftId = rv?.gmail_draft_id || dir?.gmail_draft_id || null;
  const g = draftId ? gmail?.drafts?.[draftId] : null;
  const sent = draftId ? Object.values(gmail?.sent || {}).find((s) => s?.fromDraft === draftId) : null;
  const owned = !!g && g.mode === COLD_MODE && (!g.leadId || g.leadId === rv?.lead_id || g.leadId === dir?.lead_id);
  let status = oneOf(dir?.draft_status, ["DRAFT", "MANUALLY_SENT", "NO_LONGER_DRAFT", "SKIPPED"]);
  if (sent || rv?.manual_send_detected || rv?.status === "manually_sent") status = "MANUALLY_SENT";
  else if (rv && !status) status = rv.status === "draft_created" ? (owned ? "DRAFT" : "NO_LONGER_DRAFT") : rv.status === "discarded" ? "NO_LONGER_DRAFT" : rv.status === "queued" ? "QUEUED" : "SKIPPED";
  // TF-057: in der Entwurfs-Queue (Gmail-Entwurf folgt mit technischem Pacing) – nur Anzeige, ändert nichts an Gmail.
  else if (!rv && !status && reg?.status === "WAITING_FOR_DRAFT") status = "QUEUED";
  if (status === "DRAFT" && draftId && gmail?.drafts && !owned) status = "NO_LONGER_DRAFT";
  return { status, url: status === "DRAFT" && owned ? draftUrl(g.messageId) : null, created_at: iso(rv?.draft_created_at) || iso(rv?.created_at) || iso(g?.createdAt),
    manual_sent_at: status === "MANUALLY_SENT" ? iso(sent?.sentAt) || iso(rv?.manual_send_at) : null };
}
// Automatische Stufe, solange Chris keine gesetzt hat (Abschnitt 22): Kunde → CUSTOMER, manuell gesendet → CONTACTED, Entwurf → DRAFT_READY, sonst NEW.
export function derivedStage(f) {
  if (f.do_not_contact) return "DO_NOT_CONTACT";
  if (f.customer) return "CUSTOMER";
  if (f.not_interested) return "NOT_INTERESTED";
  if (f.manual_sent || f.replied) return "CONTACTED";
  if (f.draft_status === "DRAFT") return "DRAFT_READY";
  return "NEW";
}
const EARLY = ["NEW", "DRAFT_READY", "TO_CONTACT"];
export function effectiveStage(entry, f) {
  if (f.do_not_contact) return "DO_NOT_CONTACT";
  const explicit = oneOf(entry?.sales_stage, SALES_STAGES);
  if (!explicit) return derivedStage(f);
  if (f.customer && !["CUSTOMER", "CLOSED"].includes(explicit)) return "CUSTOMER";
  if (EARLY.includes(explicit) && (f.manual_sent || f.replied)) return "CONTACTED";
  return explicit;
}
export function buildCrmLead(id, src = {}, now = new Date()) {
  const reg = src.registry?.leads?.[id] || null, dir = src.directory?.leads?.[id] || null, rv = src.reviews?.[id] || null, crm = src.crm?.leads?.[id] || null;
  const domain = normDomain(dir?.domain || reg?.domain || rv?.domain || (id.includes("@") ? "" : id)) || null;
  const hist = historyOf(src, domain); // TF-058: niedrigste Priorität – füllt nur, was Registry/Review/Verzeichnis nicht kennen
  const histOnly = !!hist && !reg && !dir && !rv;
  const d = draftInfo(dir, rv, src.gmail, reg);
  let findings = findingsOf(rv, reg);
  // Ohne Cold-/Registry-Befund: die belegten historischen Befunde (Status AUDIT, nicht „bestätigt“ – nie Grundlage für einen Entwurf).
  if (!findings.length && hist) findings = hist.verified_findings.filter((f) => str(f?.text, 240)).map((f) => ({ key: str(f.key, 80), text: str(f.text, 240), page: httpUrl(f.page),
    status: "AUDIT", confirmed: false, severity: oneOf(f.severity, SEVERITIES), verified_at: iso(f.verified_at) || iso(hist.last_verified_at), type: str(f.type, 40), target: httpUrl(f.target),
    label: str(f.label, 40), http_status: httpStatusOf(f), location: str(f.location, 60), viewport: Number.isInteger(f.viewport) ? f.viewport : null }));
  // TF-055: Website-Zustand – vollständiger Audit (passiv bzw. nach Reparatur) oder nur Teilprüfung („mindestens“). Je Domain.
  const sf = domain ? src.siteFindings?.domains?.[domain] : null;
  const errors = siteHealth({ full: sf?.full || null, incomplete: sf?.partial || null, repair: domain ? src.repairFindings?.orders?.[domain] || null : null,
    partial: findings, partialCheckedAt: rv || reg?.last_audited_at ? maxIso(iso(reg?.last_audited_at), iso(rv?.updated_at)) : hist ? iso(hist.last_verified_at) : null, now });
  const regDnc = !!(reg?.do_not_contact || reg?.opt_out || reg?.suppressed);
  const flags = { do_not_contact: !!crm?.do_not_contact || regDnc, customer: reg?.customer_status === "customer", not_interested: reg?.customer_status === "not_interested",
    manual_sent: d.status === "MANUALLY_SENT" || !!reg?.manual_send_detected, replied: reg?.reply_status === "replied", draft_status: d.status };
  const calls = Array.isArray(crm?.call_history) ? crm.call_history : [];
  const lastCall = calls.filter((c) => c.result !== "WRONG_NUMBER").map((c) => c.at).sort().at(-1) || null;
  const contactAuto = flags.replied ? "REPLIED" : calls.some((c) => REACHED.has(c.result)) ? "REACHED" : calls.length ? "CALLED" : flags.manual_sent ? "EMAIL_SENT" : "NOT_CONTACTED";
  const lead = {
    lead_id: id,
    company: str(dir?.company_name || reg?.company || rv?.company || hist?.company, 120),
    domain,
    website: httpUrl(dir?.website_url) || httpUrl(reg?.website) || httpUrl(hist?.website) || (domain ? `https://${domain}/` : null),
    email: [dir?.email, reg?.business_email, rv?.recipient, hist?.business_email].map((e) => String(e || "").trim().toLowerCase()).find((e) => EMAIL_RE.test(e)) || null,
    phone: str(dir?.phone, 30), phone_tel: telHref(dir?.phone_normalized), phone_confidence: oneOf(dir?.phone_confidence, ["high", "medium"]),
    first_name: str(dir?.first_name, 60), last_name: str(dir?.last_name, 60), role: str(dir?.role, 60),
    canton: str(reg?.canton || hist?.canton, 2), municipality: str(reg?.municipality || hist?.municipality, 60), category: str(displayCategory(reg?.category_label || reg?.category || hist?.category), 40), language: str(reg?.language, 2),
    website_reachable: dir?.enrichment?.status === "done" ? true : dir?.enrichment?.status === "failed" ? false : null,
    website_checked_at: maxIso(iso(reg?.last_audited_at), iso(dir?.enrichment?.last_attempt_at), iso(hist?.last_verified_at)),
    findings, findings_total: findings.length, findings_confirmed: findings.filter((f) => f.confirmed).length, errors,
    // TF-058: nur reine Historien-Leads tragen ein Abzeichen. ERNEUT VERIFIZIERT = aktueller Audit bestätigt ≥ 1 Fehler, sonst HISTORISCHER FUND.
    history_badge: histOnly ? ((errors.count || 0) >= 1 && (errors.audit === "FULL" || (hist.reverified === true && errors.audit === "PARTIAL")) ? "REVERIFIED" : "HISTORICAL") : null,
    contact_form: cleanContactForm(src.contactForms?.leads?.[id]),
    draft_status: d.status, draft_url: d.url, draft_created_at: d.created_at, manual_sent: flags.manual_sent, manual_sent_at: d.manual_sent_at || iso(reg?.first_contacted_at),
    replied: flags.replied, customer: flags.customer,
    sales_stage: effectiveStage(crm, flags), stage_auto: !oneOf(crm?.sales_stage, SALES_STAGES),
    contact_status: oneOf(crm?.contact_status, CONTACT_STATUSES) || contactAuto,
    call_status: oneOf(crm?.call_status, CALL_STATUSES, "NOT_CALLED"),
    last_contact_at: maxIso(iso(crm?.last_contact_at), lastCall, d.manual_sent_at, iso(reg?.last_contacted_at), iso(reg?.reply_at)),
    next_action: str(crm?.next_action, 200), next_action_at: day(crm?.next_action_at) || iso(crm?.next_action_at),
    notes: (Array.isArray(crm?.notes) ? crm.notes : []).map((n) => ({ id: str(n.id, 40), at: iso(n.at), text: text(n.text, 2000) })).filter((n) => n.text),
    call_history: calls.map((c) => ({ id: str(c.id, 40), at: iso(c.at), result: oneOf(c.result, CALL_STATUSES), note: text(c.note, 1000), next_action: str(c.next_action, 200),
      follow_up_at: day(c.follow_up_at), recorded_at: iso(c.recorded_at) })),
    do_not_contact: flags.do_not_contact, dnc_source: crm?.do_not_contact ? "crm" : reg?.do_not_contact ? "registry" : reg?.opt_out ? "opt_out" : reg?.suppressed ? "suppression" : null,
    do_not_contact_at: iso(crm?.do_not_contact_at), archived: !!crm?.archived,
    crm_created_at: iso(crm?.created_at),
    updated_at: maxIso(iso(crm?.updated_at), iso(dir?.contact_enriched_at), iso(reg?.last_updated_at), iso(rv?.updated_at), iso(dir?.first_seen_at), iso(hist?.updated_at)),
  };
  lead.priority = priorityOf(lead);
  lead.follow_up = followUpBucket(lead, now);
  lead.call_recommended = callRecommended(lead);
  return lead;
}
const REACHED = new Set(["CALLBACK_REQUESTED", "SPOKE_TO_EMPLOYEE", "SPOKE_TO_DECISION_MAKER", "INTERESTED", "NOT_INTERESTED", "DO_NOT_CALL"]);
export function buildCrmView(src = {}, now = new Date()) {
  const ids = crmUniverse(src, now);
  const leads = [...ids].map((id) => buildCrmLead(id, src, now));
  return { generated_at: now.toISOString(), total: leads.length, leads };
}

// ---------- Aktionen (Allowlist) ----------
// Lesen: crm.getLead / crm.listLeads. Schreiben: nur diese Aktionen, je genau EIN Lead, Parameter mit festem Schema. Alles andere → DENY.
const P = {
  lead_id: { re: LEAD_ID_RE, max: 253 },
  stage: { enum: SALES_STAGES.filter((s) => s !== "DO_NOT_CONTACT") }, // DNC nur über crm.setDoNotContact
  contact_status: { enum: CONTACT_STATUSES },
  call_status: { enum: CALL_STATUSES },
  result: { enum: CALL_STATUSES.filter((s) => s !== "NOT_CALLED") },
  at: { iso: true },
  note: { text: 1000 }, text: { text: 2000, required: true }, reason: { text: 200 },
  next_action: { text: 200, empty: true }, follow_up_at: { day: true, empty: true }, next_action_at: { day: true, empty: true },
  value: { bool: true },
};
export const CRM_ACTIONS = Object.freeze({
  "crm.listLeads": { kind: "read", params: [], required: [] },
  "crm.getLead": { kind: "read", params: ["lead_id"], required: ["lead_id"] },
  "crm.updateStage": { kind: "write", params: ["lead_id", "stage"], required: ["lead_id", "stage"], label: "Status ändern" },
  "crm.updateContactStatus": { kind: "write", params: ["lead_id", "contact_status"], required: ["lead_id", "contact_status"], label: "Kontaktstatus" },
  "crm.updateCallStatus": { kind: "write", params: ["lead_id", "call_status"], required: ["lead_id", "call_status"], label: "Telefonstatus" },
  "crm.addCall": { kind: "write", params: ["lead_id", "at", "result", "note", "next_action", "follow_up_at"], required: ["lead_id", "result"], label: "Anruf dokumentieren" },
  "crm.addNote": { kind: "write", params: ["lead_id", "text"], required: ["lead_id", "text"], label: "Notiz hinzufügen" },
  "crm.setNextAction": { kind: "write", params: ["lead_id", "next_action", "next_action_at"], required: ["lead_id"], label: "Follow-up setzen" },
  "crm.setDoNotContact": { kind: "write", params: ["lead_id", "value", "reason"], required: ["lead_id", "value"], label: "Do Not Contact" },
  "crm.archive": { kind: "write", params: ["lead_id", "value"], required: ["lead_id", "value"], label: "Archivieren" },
});
const ACTION_RE = /^crm\.[A-Za-z]{3,40}$/;
export function validateCrmAction(input, { now = new Date() } = {}) {
  const deny = (status, code, error) => ({ ok: false, status, code, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return deny(400, "BAD_REQUEST", "Ungültige Anfrage.");
  if (Object.keys(input).some((k) => !["action", "params"].includes(k))) return deny(400, "UNKNOWN_FIELD", "Nur action und params sind erlaubt.");
  const { action } = input;
  if (typeof action !== "string" || !ACTION_RE.test(action) || !Object.hasOwn(CRM_ACTIONS, action)) return deny(400, "UNKNOWN_ACTION", "Unbekannte Aktion.");
  const def = CRM_ACTIONS[action];
  const raw = input.params ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return deny(400, "BAD_PARAMS", "params muss ein Objekt sein.");
  const params = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!def.params.includes(k)) return deny(400, "BAD_PARAMS", `Parameter ${String(k).slice(0, 20)} ist nicht erlaubt.`);
    const r = P[k];
    if (r.re) { if (typeof v !== "string" || v.length > r.max || !r.re.test(v)) return deny(400, "BAD_PARAMS", `${k}: ungültig.`); params[k] = v; }
    else if (r.enum) { if (!r.enum.includes(v)) return deny(400, "BAD_PARAMS", `${k}: unbekannter Wert.`); params[k] = v; }
    else if (r.bool) { if (typeof v !== "boolean") return deny(400, "BAD_PARAMS", `${k}: true/false.`); params[k] = v; }
    else if (r.iso) {
      if (!iso(v)) return deny(400, "BAD_PARAMS", `${k}: Zeitpunkt (ISO, UTC) erwartet.`);
      if (Date.parse(v) > +now + 86_400_000 || Date.parse(v) < Date.parse("2020-01-01T00:00:00Z")) return deny(400, "BAD_PARAMS", `${k}: ausserhalb des erlaubten Bereichs.`);
      params[k] = v;
    } else if (r.day) {
      if (r.empty && (v === null || v === "")) { params[k] = null; continue; }
      if (!day(v)) return deny(400, "BAD_PARAMS", `${k}: Datum JJJJ-MM-TT erwartet.`); params[k] = v;
    } else if (r.text) {
      if (typeof v !== "string" || v.length > r.text * 2) return deny(400, "BAD_PARAMS", `${k}: Text (max. ${r.text} Zeichen).`);
      const t = text(v, r.text);
      if (!t && r.required) return deny(400, "BAD_PARAMS", `${k}: darf nicht leer sein.`);
      if (v.trim().length > r.text) return deny(400, "BAD_PARAMS", `${k}: höchstens ${r.text} Zeichen.`);
      params[k] = t;
    }
  }
  for (const k of def.required) if (params[k] === undefined || params[k] === null) return deny(400, "BAD_PARAMS", `${k} fehlt.`);
  return { ok: true, action, kind: def.kind, params };
}

// Eine geprüfte Schreibaktion auf den CRM-Zustand anwenden (rein, ohne I/O). Idempotent je request_id.
// lookup(lead_id) → aktuelle CRM-Sicht des Leads oder null (unbekannt/fremd → abgelehnt).
export function applyCrmAction(state, req, { now = new Date(), lookup } = {}) {
  const fail = (code, error) => ({ ok: false, code, error });
  const v = validateCrmAction({ action: req?.action, params: req?.params }, { now });
  if (!v.ok) return fail(v.code, v.error);
  if (v.kind !== "write") return fail("NOT_A_WRITE", "Keine Schreibaktion.");
  const rid = typeof req.request_id === "string" && REQ_RE.test(req.request_id) ? req.request_id : null;
  if (rid && state.meta.applied[rid]) return { ok: true, duplicate: true, lead_id: v.params.lead_id, changed: [] };
  const { lead_id } = v.params, p = v.params;
  const cur = lookup ? lookup(lead_id) : null;
  if (!cur) return fail("UNKNOWN_LEAD", "Unbekannter Lead – nur bestehende Jarvis-Leads können bearbeitet werden.");
  const t = now.toISOString();
  const e = structuredClone(state.leads[lead_id] || newCrmEntry(lead_id, now));
  const changed = [];
  const set = (k, val) => { if (JSON.stringify(e[k]) !== JSON.stringify(val)) { e[k] = val; changed.push(k); } };
  const dnc = cur.do_not_contact || e.do_not_contact;
  const blockedByDnc = ["crm.updateStage", "crm.updateContactStatus", "crm.updateCallStatus", "crm.addCall"].includes(v.action) || (v.action === "crm.setNextAction" && (p.next_action || p.next_action_at));
  if (dnc && blockedByDnc) return fail("DO_NOT_CONTACT", "Do Not Contact – keine Kontaktaktion, kein Follow-up.");
  switch (v.action) {
    case "crm.updateStage": set("sales_stage", p.stage); break;
    case "crm.updateContactStatus": set("contact_status", p.contact_status); break;
    case "crm.updateCallStatus": set("call_status", p.call_status); break;
    case "crm.addNote":
      if (e.notes.length >= MAX_NOTES) return fail("LIMIT", `Höchstens ${MAX_NOTES} Notizen je Lead.`);
      e.notes = [...e.notes, { id: rid || `n-${now.getTime().toString(36)}-${e.notes.length}`, at: t, text: p.text }]; changed.push("notes");
      break;
    case "crm.addCall": {
      if (e.call_history.length >= MAX_CALLS) return fail("LIMIT", `Höchstens ${MAX_CALLS} Anrufe je Lead.`);
      const at = p.at || t;
      e.call_history = [...e.call_history, { id: rid || `c-${now.getTime().toString(36)}-${e.call_history.length}`, at, result: p.result, note: p.note || null,
        next_action: p.next_action || null, follow_up_at: p.follow_up_at || null, recorded_at: t }];
      changed.push("call_history");
      set("call_status", p.result);
      if (p.result !== "WRONG_NUMBER" && (!e.last_contact_at || at > e.last_contact_at)) set("last_contact_at", at);
      const contact = cur.contact_status;
      if (!["REPLIED", "MEETING"].includes(contact)) set("contact_status", REACHED.has(p.result) ? "REACHED" : contact === "REACHED" ? "REACHED" : "CALLED");
      const stage = cur.sales_stage;
      if (p.result === "INTERESTED" && [...EARLY, "CONTACTED", "FOLLOW_UP"].includes(stage)) set("sales_stage", "INTERESTED");
      else if (p.result === "NOT_INTERESTED" && !["CUSTOMER", "CLOSED"].includes(stage)) set("sales_stage", "NOT_INTERESTED");
      else if (EARLY.includes(stage) && p.result !== "WRONG_NUMBER") set("sales_stage", p.follow_up_at ? "FOLLOW_UP" : "CONTACTED");
      else if (stage === "CONTACTED" && p.follow_up_at) set("sales_stage", "FOLLOW_UP");
      if (p.next_action) set("next_action", p.next_action);
      if (p.follow_up_at) set("next_action_at", p.follow_up_at);
      break;
    }
    case "crm.setNextAction":
      if (p.next_action !== undefined) set("next_action", p.next_action || null);
      if (p.next_action_at !== undefined) set("next_action_at", p.next_action_at || null);
      break;
    case "crm.setDoNotContact":
      if (!p.value && !e.do_not_contact && cur.do_not_contact) return fail("REGISTRY_BLOCK", "Sperre stammt aus Opt-out/Suppression/Lead-Datenbank – im CRM nicht aufhebbar.");
      set("do_not_contact", p.value);
      if (p.value) { set("do_not_contact_at", e.do_not_contact_at || t); if (p.reason) set("do_not_contact_reason", p.reason); }
      break;
    case "crm.archive":
      set("archived", p.value); set("archived_at", p.value ? t : null);
      break;
  }
  e.updated_at = t;
  state.leads[lead_id] = e;
  if (rid) {
    state.meta.applied[rid] = t;
    const keys = Object.keys(state.meta.applied);
    if (keys.length > APPLIED_KEEP) for (const k of keys.slice(0, keys.length - APPLIED_KEEP)) delete state.meta.applied[k];
  }
  state.updated_at = t;
  return { ok: true, lead_id, changed };
}

// ---------- Allowlist für die Cloud-Kopie (Netlify speichert nur das) ----------
// TF-055 Website-Zustand: nur Zahl, Audit-Art, Zeitpunkte und je Befund Typ/Kategorie/Kurztext/Seite/Schweregrad – nie Evidence.
export const MAX_ERROR_ITEMS = 40;
// TF-059: zusätzlich CRM-interne Fakten (Linktext, HTTP-Status, Bereich, Viewport) und die daraus abgeleitete konkrete Zeile
// crm_title/crm_detail (issueLines). text bleibt der kurze, natürliche Text – der Cold-Mail-Kundentext wird hier nie verändert.
const cleanErrorItem = (f) => {
  if (!f || typeof f !== "object" || !str(f.text, 140)) return null;
  const x = { key: str(f.key, 200), type: typeof f.type === "string" && /^[a-z_]{3,40}$/.test(f.type) ? f.type : null,
    category: oneOf(f.category, ISSUE_CATEGORIES, "other"), text: str(f.text, 140), page: httpUrl(f.page), target: httpUrl(f.target), severity: oneOf(f.severity, SEVERITIES),
    verified_at: iso(f.verified_at), source: oneOf(f.source, FINDING_SOURCES), manual: f.manual === true,
    label: str(f.label, 40), http_status: Number.isInteger(f.http_status) && f.http_status >= 100 && f.http_status <= 599 ? f.http_status : null,
    location: str(f.location, 60), viewport: Number.isInteger(f.viewport) && f.viewport >= 200 && f.viewport <= 4000 ? f.viewport : null };
  const lines = issueLines(x);
  // TF-072: Direktlink auf die betroffene Seite (affected_url, ältere Befunde aus page) + Ziel bei Link-/Bild-Fehlern – nur sichere
  // öffentliche http(s)-Adressen (safePublicUrl), unbekannt → null. Nie erfunden, nie die Startseite als Ersatz.
  return { ...x, crm_title: lines.title, crm_detail: lines.detail, ...issueLink({ ...x, affected_url: f.affected_url }) };
};
export function cleanErrors(e) {
  const x = e && typeof e === "object" ? e : {};
  const audit = oneOf(x.audit, AUDIT_STATES, "NONE");
  const items = (Array.isArray(x.items) ? x.items : []).slice(0, MAX_ERROR_ITEMS).map(cleanErrorItem).filter(Boolean);
  const cnt = (v) => (Number.isInteger(v) ? Math.max(0, Math.min(1000, v)) : 0);
  const count = audit === "NONE" ? null : Math.max(cnt(x.count), items.length);
  const r = x.repair && typeof x.repair === "object" ? x.repair : null;
  return { audit, count, exact: audit === "FULL" && x.exact === true, checked_at: iso(x.checked_at), full_checked_at: iso(x.full_checked_at), scope: str(x.scope, 120),
    top: (Array.isArray(x.top) ? x.top : []).slice(0, 2).map(cleanErrorItem).filter(Boolean), items, resolved: cnt(x.resolved), manual_open: cnt(x.manual_open),
    repair: r ? { state: oneOf(r.state, ["READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"]), completion: oneOf(r.completion, ["FULL", "WITH_MANUAL_ITEMS"]),
      at: iso(r.at), repaired: cnt(r.repaired), manual_open: cnt(r.manual_open) } : null };
}
export function cleanCrmLead(l) {
  if (!l || typeof l !== "object" || !LEAD_ID_RE.test(String(l.lead_id || ""))) return null;
  const n = (v, lo, hi) => (Number.isInteger(v) ? Math.max(lo, Math.min(hi, v)) : 0);
  const pr = l.priority && typeof l.priority === "object" ? l.priority : {};
  return {
    lead_id: l.lead_id, company: str(l.company, 120), domain: str(l.domain, 120) && /^[a-z0-9.-]{3,253}$/.test(l.domain) ? l.domain : null, website: httpUrl(l.website),
    email: typeof l.email === "string" && EMAIL_RE.test(l.email) && l.email.length <= 200 ? l.email : null,
    phone: typeof l.phone === "string" && /^[+0-9 ()\/.-]{6,30}$/.test(l.phone) ? l.phone : null,
    phone_tel: typeof l.phone_tel === "string" && (/^tel:\+41\d{9}$/.test(l.phone_tel) || (l.market === "VN" && /^tel:\+84\d{9,10}$/.test(l.phone_tel))) ? l.phone_tel : null, phone_confidence: oneOf(l.phone_confidence, ["high", "medium"]),
    first_name: str(l.first_name, 60), last_name: str(l.last_name, 60), role: str(l.role, 60),
    // TF-063: Markt (CH Standard, VN nur von der Vietnam-Discovery) + VN-Region (Verwaltungseinheit auf Provinzebene, Stand 2025).
    market: oneOf(l.market, ["CH", "VN"], "CH"), region: l.market === "VN" ? str(l.region, 60) : null, region_code: l.market === "VN" && typeof l.region_code === "string" && /^VN-[A-Z0-9-]{2,24}$/.test(l.region_code) ? l.region_code : null,
    canton: l.market !== "VN" && typeof l.canton === "string" && /^[A-Z]{2}$/.test(l.canton) ? l.canton : null, municipality: str(l.municipality, 60), category: str(displayCategory(l.category), 40), language: oneOf(l.language, ["de", "fr", "it", "rm", "vi", "en"]),
    website_reachable: typeof l.website_reachable === "boolean" ? l.website_reachable : null, website_checked_at: iso(l.website_checked_at),
    findings: (Array.isArray(l.findings) ? l.findings : []).slice(0, 30).map((f) => (f && typeof f === "object" ? { key: str(f.key, 80), text: str(f.text, 240), page: httpUrl(f.page),
      status: oneOf(f.status, ["BESTÄTIGT", "AUDIT"]), confirmed: f.confirmed === true, severity: oneOf(f.severity, SEVERITIES), verified_at: iso(f.verified_at) } : null)).filter((f) => f?.text),
    findings_total: n(l.findings_total, 0, 1000), findings_confirmed: n(l.findings_confirmed, 0, 1000), errors: cleanErrors(l.errors), history_badge: oneOf(l.history_badge, HISTORY_BADGES),
    contact_form: cleanContactForm(l.contact_form),
    draft_status: oneOf(l.draft_status, DRAFT_STATUSES),
    draft_url: typeof l.draft_url === "string" && /^https:\/\/mail\.google\.com\/mail\/u\/0\/#drafts\?compose=[0-9a-f]{10,24}$/.test(l.draft_url) ? l.draft_url : null,
    draft_created_at: iso(l.draft_created_at), manual_sent: l.manual_sent === true, manual_sent_at: iso(l.manual_sent_at), replied: l.replied === true, customer: l.customer === true,
    sales_stage: oneOf(l.sales_stage, SALES_STAGES, "NEW"), stage_auto: l.stage_auto !== false, contact_status: oneOf(l.contact_status, CONTACT_STATUSES, "NOT_CONTACTED"),
    call_status: oneOf(l.call_status, CALL_STATUSES, "NOT_CALLED"), last_contact_at: iso(l.last_contact_at), next_action: str(l.next_action, 200),
    next_action_at: day(l.next_action_at) || iso(l.next_action_at),
    notes: (Array.isArray(l.notes) ? l.notes : []).slice(-MAX_NOTES).map((x) => ({ id: str(x?.id, 40), at: iso(x?.at), text: text(x?.text, 2000) })).filter((x) => x.text),
    call_history: (Array.isArray(l.call_history) ? l.call_history : []).slice(-MAX_CALLS).map((c) => ({ id: str(c?.id, 40), at: iso(c?.at), result: oneOf(c?.result, CALL_STATUSES),
      note: text(c?.note, 1000), next_action: str(c?.next_action, 200), follow_up_at: day(c?.follow_up_at), recorded_at: iso(c?.recorded_at) })).filter((c) => c.result),
    do_not_contact: l.do_not_contact === true, dnc_source: oneOf(l.dnc_source, ["crm", "registry", "opt_out", "suppression"]), do_not_contact_at: iso(l.do_not_contact_at),
    archived: l.archived === true, crm_created_at: iso(l.crm_created_at), updated_at: iso(l.updated_at),
    priority: { score: Number.isInteger(pr.score) ? Math.max(-100, Math.min(100, pr.score)) : 0, level: oneOf(pr.level, PRIORITY_LEVELS, "LOW"),
      reasons: (Array.isArray(pr.reasons) ? pr.reasons : []).slice(0, 10).map((r) => str(r, 60)).filter(Boolean) },
    follow_up: oneOf(l.follow_up, ["OVERDUE", "TODAY", "LATER"]), call_recommended: l.call_recommended === true,
  };
}
