// Lead-Datenbank – gemeinsames Modell (ohne Node-Abhängigkeiten: VPS UND Netlify Function).
// Statusmodell, Zusammenführen ohne Informationsverlust, öffentliche Sicht per Allowlist, Filter, Kennzahlen, CSV-Export.
// Die Datenbank ist ein GEDÄCHTNIS, keine Versandgrundlage: kein Feld hier erlaubt je einen Versand. Cold-Leads bleiben
// COLD_LEAD_DRAFT_ONLY (legal_basis NONE, automatic_send_allowed false) – gesendet wird nur von Chris selbst in Gmail.

export const LEAD_STATUSES = Object.freeze(["DISCOVERED", "AUDITED", "QUALIFIED", "WAITING_FOR_DRAFT", "DRAFT_CREATED", "MANUALLY_SENT", "REPLIED", "CUSTOMER",
  "NOT_INTERESTED", "SUPPRESSED", "OPT_OUT", "DO_NOT_CONTACT", "DISCARDED"]);
export const DRAFT_STATES = Object.freeze(["none", "blocked", "queued", "draft_created", "discarded", "manually_sent"]);
export const CUSTOMER_STATES = Object.freeze(["none", "not_interested", "customer"]);
export const OFFER_CLASSES = Object.freeze(["REPAIR_CHECK_150", "REPAIR_FIX_500", "NONE"]);
export const LANGUAGES = Object.freeze(["de", "fr", "it", "rm"]);
export const CANTON_CODES = Object.freeze(["ZH", "BE", "LU", "UR", "SZ", "OW", "NW", "GL", "ZG", "FR", "SO", "BS", "BL", "SH", "AR", "AI", "SG", "GR", "AG", "TG", "TI", "VD", "VS", "NE", "GE", "JU"]);
export const STATUS_LABEL = Object.freeze({ DISCOVERED: "gefunden", AUDITED: "geprüft", QUALIFIED: "qualifiziert", WAITING_FOR_DRAFT: "wartet auf Entwurf", DRAFT_CREATED: "Entwurf erstellt",
  MANUALLY_SENT: "manuell versendet", REPLIED: "Antwort erhalten", CUSTOMER: "Kunde", NOT_INTERESTED: "kein Interesse", SUPPRESSED: "gesperrt", OPT_OUT: "abgemeldet",
  DO_NOT_CONTACT: "nicht kontaktieren", DISCARDED: "verworfen" });
export const OFFER_LABEL = Object.freeze({ REPAIR_CHECK_150: "CHF 150 Check & Anleitung", REPAIR_FIX_500: "CHF 480 Check & Reparatur", NONE: "kein Angebot" });
// Lead-ID: die Domain (wie überall in Jarvis); nur ohne Website die geschäftliche Adresse.
export const REGISTRY_ID_RE = /^[a-z0-9][a-z0-9.@_+-]{2,252}$/;

const FREEMAIL_DOMAIN = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|bluewin|hispeed|sunrise|protonmail|proton|yandex|aol)\.[a-z.]+$/i;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const URLISH = /https?:|www\.|[<>{}]|\/[a-z0-9_-]+\.(php|html?|aspx?)/i;
const PLACE_RE = /^[\p{L}\p{N} .'’()\/-]{1,60}$/u;
export const normEmail = (s = "") => String(String(s).match(/<([^>]+)>/)?.[1] || s || "").trim().toLowerCase();
export const normDomain = (u = "") => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
export const normCompany = (s = "") => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/\b(ag|gmbh|sa|s[àa]rl|sagl|kg|klg|e\.?\s?k\.?|ltd|inc|co|und|&|et)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
export const emailDomain = (e) => normEmail(e).split("@")[1] || "";
export const isFreemail = (e) => FREEMAIL_DOMAIN.test(emailDomain(e));
const str = (v, n) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : null) || null;
const iso = (v) => (typeof v === "string" && ISO_RE.test(v) ? v : null);
const oneOf = (v, list, d = null) => (list.includes(v) ? v : d);
const minIso = (a, b) => (!a ? b || null : !b ? a : a < b ? a : b);
const maxIso = (a, b) => (!a ? b || null : !b ? a : a > b ? a : b);
const DRAFT_RANK = { none: 0, blocked: 1, queued: 2, discarded: 3, draft_created: 4, manually_sent: 5 };
const CUSTOMER_RANK = { none: 0, not_interested: 1, customer: 2 };

// Status aus den (nie zurückgenommenen) Fakten. Sperren haben IMMER Vorrang, dann der späteste Vertriebsschritt.
export function deriveStatus(l = {}) {
  if (l.do_not_contact) return "DO_NOT_CONTACT";
  if (l.opt_out) return "OPT_OUT";
  if (l.suppressed) return "SUPPRESSED";
  if (l.customer_status === "customer") return "CUSTOMER";
  if (l.customer_status === "not_interested") return "NOT_INTERESTED";
  if (l.reply_status === "replied") return "REPLIED";
  if (l.manual_send_detected || l.first_contacted_at || l.gmail_draft_status === "manually_sent") return "MANUALLY_SENT";
  if (l.gmail_draft_status === "draft_created") return "DRAFT_CREATED";
  if (l.gmail_draft_status === "queued") return "WAITING_FOR_DRAFT";
  if (l.gmail_draft_status === "discarded") return "DISCARDED";
  if (l.qualified) return "QUALIFIED";
  if (l.audited || l.last_audited_at) return "AUDITED";
  return "DISCOVERED";
}
export const contacted = (l) => !!(l.first_contacted_at || l.manual_send_detected || ["MANUALLY_SENT", "REPLIED", "CUSTOMER", "NOT_INTERESTED"].includes(l.status));
// Darf zu diesem Datensatz (bzw. derselben Firma) noch ein NEUER Cold-Entwurf entstehen? Grund oder null. Nie ein Freibrief zum Senden.
export function contactBlockReason(l) {
  if (!l) return null;
  if (l.do_not_contact) return "do-not-contact";
  if (l.opt_out) return "opt-out";
  if (l.suppressed) return "suppression";
  if (l.customer_status === "customer") return "bestehender Kunde";
  if (l.customer_status === "not_interested") return "kein Interesse";
  if (l.reply_status === "replied") return "Antwort erhalten";
  if (contacted(l)) return "bereits angeschrieben";
  return null;
}

// Neuen Stand in einen bestehenden Datensatz übernehmen – nie etwas wegwerfen:
// Sperren und Kontaktfakten bleiben (OR), erste Zeitpunkte = frühester, letzte = spätester, abweichende Domain/Adresse → alt_*.
// authoritative: Felder, die diese Quelle verbindlich kennt (z. B. gmail_draft_status aus individual_reviews.json) – werden übernommen.
export function mergeLead(cur = null, inc = {}, { now = new Date(), source = null, authoritative = [] } = {}) {
  const t = now.toISOString();
  const out = cur ? structuredClone(cur) : { lead_id: inc.lead_id, created_at: t, alt_domains: [], alt_emails: [], sources: [], history: [],
    suppressed: false, opt_out: false, do_not_contact: false, manual_send_detected: false, reply_status: "none", customer_status: "none", gmail_draft_status: "none",
    qualified: false, audited: false, customer_visible_findings: [], offer_class: "NONE" };
  out.alt_domains ||= []; out.alt_emails ||= []; out.sources ||= []; out.history ||= [];
  const fill = (k) => { if (inc[k] != null && inc[k] !== "" && (out[k] == null || out[k] === "")) out[k] = inc[k]; };
  for (const k of ["company", "website", "contact_name", "contact_role", "canton", "municipality", "municipality_bfs", "language", "category", "category_label", "discovery_source"]) fill(k);
  // Domain / geschäftliche Adresse: erste bleibt führend, weitere werden gemerkt.
  const d = inc.domain ? normDomain(inc.domain) : "";
  if (d) { if (!out.domain) out.domain = d; else if (d !== out.domain && !out.alt_domains.includes(d)) out.alt_domains.push(d); }
  const e = inc.business_email ? normEmail(inc.business_email) : "";
  if (e && EMAIL_RE.test(e)) { if (!out.business_email) out.business_email = e; else if (e !== out.business_email && !out.alt_emails.includes(e)) out.alt_emails.push(e); }
  // Audit-Felder: der neuere Audit gewinnt, ein leerer neuer Befund löscht keinen alten.
  const newerAudit = !!inc.last_audited_at && (!out.last_audited_at || inc.last_audited_at >= out.last_audited_at);
  if (newerAudit || out.repair_fit_score == null) if (inc.repair_fit_score != null) out.repair_fit_score = inc.repair_fit_score;
  if ((newerAudit || !out.customer_visible_findings?.length) && Array.isArray(inc.customer_visible_findings) && inc.customer_visible_findings.length) out.customer_visible_findings = inc.customer_visible_findings.slice(0, 3);
  if (inc.offer_class && inc.offer_class !== "NONE" && (newerAudit || out.offer_class === "NONE" || !out.offer_class)) out.offer_class = inc.offer_class;
  out.first_discovered_at = minIso(out.first_discovered_at, inc.first_discovered_at);
  out.last_audited_at = maxIso(out.last_audited_at, inc.last_audited_at);
  // Klebrige Fakten (werden nie automatisch zurückgenommen)
  for (const k of ["suppressed", "opt_out", "do_not_contact", "manual_send_detected", "qualified", "audited"]) out[k] = !!(out[k] || inc[k]);
  if (inc.reply_status === "replied") out.reply_status = "replied";
  out.reply_at = minIso(out.reply_at, inc.reply_at);
  if (CUSTOMER_RANK[inc.customer_status] > CUSTOMER_RANK[out.customer_status || "none"]) out.customer_status = inc.customer_status;
  out.first_contacted_at = minIso(out.first_contacted_at, inc.first_contacted_at);
  out.last_contacted_at = maxIso(out.last_contacted_at, inc.last_contacted_at || inc.first_contacted_at);
  out.draft_created_at = maxIso(out.draft_created_at, inc.draft_created_at);
  if (inc.gmail_draft_status && DRAFT_STATES.includes(inc.gmail_draft_status)) {
    // Ein manueller Versand wird nie durch einen späteren Entwurfsstatus überschrieben.
    if (out.gmail_draft_status !== "manually_sent" && (authoritative.includes("gmail_draft_status") || DRAFT_RANK[inc.gmail_draft_status] > DRAFT_RANK[out.gmail_draft_status || "none"])) out.gmail_draft_status = inc.gmail_draft_status;
  }
  if (inc.draft_blocked_reason) out.draft_blocked_reason = String(inc.draft_blocked_reason).slice(0, 80);
  // Interne Gmail-Referenzen (nur auf dem VPS, nie Cloud/Export)
  if (inc.refs && typeof inc.refs === "object") out.refs = { ...(out.refs || {}), ...Object.fromEntries(Object.entries(inc.refs).filter(([, v]) => typeof v === "string" && v)) };
  if (source && !out.sources.includes(source)) out.sources.push(source);
  const status = deriveStatus(out);
  if (status !== out.status) { out.history.push({ at: t, status, ...(source ? { source } : {}) }); out.history = out.history.slice(-30); out.status = status; }
  if (!cur || JSON.stringify({ ...cur, last_updated_at: null }) !== JSON.stringify({ ...out, last_updated_at: null })) out.last_updated_at = t;
  return out;
}

// ---------- Index & Dedupe ----------
export function buildIndex(leads = {}) {
  const byDomain = new Map(), byEmail = new Map(), byCompany = new Map();
  for (const [id, l] of Object.entries(leads)) {
    for (const d of [l.domain, ...(l.alt_domains || [])].filter(Boolean)) if (!byDomain.has(d)) byDomain.set(d, id);
    for (const e of [l.business_email, ...(l.alt_emails || [])].filter(Boolean)) {
      if (!byEmail.has(e)) byEmail.set(e, id);
      if (!isFreemail(e) && !byDomain.has(emailDomain(e))) byDomain.set(emailDomain(e), id);
    }
    const c = normCompany(l.company);
    if (c.length >= 4 && !byCompany.has(c)) byCompany.set(c, id);
  }
  return { byDomain, byEmail, byCompany };
}
// Bekannter Datensatz zu Domain / geschäftlicher Adresse / Firma (in dieser Reihenfolge) – oder null.
export function findId(idx, { lead_id, domain, email, company } = {}) {
  const d = domain ? normDomain(domain) : "", e = email ? normEmail(email) : "", c = normCompany(company || "");
  return (lead_id && idx.ids?.has(lead_id) ? lead_id : null) || (d && idx.byDomain.get(d)) || (e && idx.byEmail.get(e)) || (e && !isFreemail(e) && idx.byDomain.get(emailDomain(e))) || (c.length >= 4 && idx.byCompany.get(c)) || null;
}
// Alle Datensätze, die dieselbe Firma meinen (Domain, Adresse oder Firmenname).
// Mehrfach-Index (Schlüssel → alle Lead-IDs) für schnelle Prüfungen in Schleifen; je Datenbank-Objekt einmal gebaut.
const MULTI = new WeakMap();
function multiIndex(leads) {
  let m = MULTI.get(leads);
  if (m) return m;
  m = { id: new Map(), domain: new Map(), email: new Map(), company: new Map() };
  const add = (map, k, id) => { if (!k) return; const a = map.get(k); if (a) { if (!a.includes(id)) a.push(id); } else map.set(k, [id]); };
  for (const [id, l] of Object.entries(leads)) {
    add(m.id, l.lead_id, id);
    for (const d of [l.domain, ...(l.alt_domains || [])]) add(m.domain, d, id);
    for (const e of [l.business_email, ...(l.alt_emails || [])]) add(m.email, e, id);
    const c = normCompany(l.company); if (c.length >= 4) add(m.company, c, id);
  }
  MULTI.set(leads, m);
  return m;
}
export function matchingLeads(leads = {}, q = {}) {
  const d = q.domain ? normDomain(q.domain) : "", e = q.email ? normEmail(q.email) : "", c = normCompany(q.company || "");
  const m = multiIndex(leads), ids = new Set();
  const pick = (map, k) => { for (const id of (k && map.get(k)) || []) ids.add(id); };
  pick(m.id, q.lead_id); pick(m.domain, d); pick(m.email, e);
  if (e && !isFreemail(e)) pick(m.domain, emailDomain(e));
  if (c.length >= 4) pick(m.company, c);
  return [...ids].map((id) => leads[id]).filter(Boolean);
}

// ---------- öffentliche Sicht (Cloud, Handy, Export) – nur diese Felder, keine Gmail-/Thread-IDs, keine Roh-Evidence ----------
export const PUBLIC_FIELDS = Object.freeze(["lead_id", "company", "website", "domain", "business_email", "contact_name", "contact_role", "canton", "municipality", "language",
  "category", "discovery_source", "first_discovered_at", "last_audited_at", "customer_visible_findings", "repair_fit_score", "offer_class", "status", "draft_created",
  "draft_created_at", "gmail_draft_status", "manual_send_detected", "first_contacted_at", "last_contacted_at", "reply_status", "reply_at", "customer_status",
  "suppressed", "opt_out", "do_not_contact", "last_updated_at"]);
const finding = (v) => { const s = str(typeof v === "string" ? v : v?.text, 240); return s && !URLISH.test(s) ? s : null; };
const sourceWord = (s = "") => (/^OpenStreetMap/i.test(s) ? "OpenStreetMap" : /lead-?liste|leads\.json/i.test(s) ? "Lead-Liste Chris" : /gmail/i.test(s) ? "Gmail" : s ? "Jarvis" : null);
export function publicLead(l) {
  if (!l || typeof l !== "object" || !REGISTRY_ID_RE.test(String(l.lead_id || ""))) return null;
  const website = str(l.website, 200);
  return {
    lead_id: l.lead_id, company: str(l.company, 120), website: website && /^https?:\/\/[^\s/]+/.test(website) && !/[<>"' ]/.test(website) ? website : l.domain ? `https://${l.domain}/` : null,
    domain: str(l.domain, 120), business_email: EMAIL_RE.test(normEmail(l.business_email)) ? normEmail(l.business_email) : null,
    contact_name: str(l.contact_name, 80), contact_role: str(l.contact_role, 80),
    canton: oneOf(l.canton, CANTON_CODES), municipality: typeof l.municipality === "string" && PLACE_RE.test(l.municipality) ? l.municipality : null, language: oneOf(l.language, LANGUAGES),
    category: str(l.category_label || l.category, 40), discovery_source: sourceWord(l.discovery_source),
    first_discovered_at: iso(l.first_discovered_at), last_audited_at: iso(l.last_audited_at),
    customer_visible_findings: (Array.isArray(l.customer_visible_findings) ? l.customer_visible_findings : []).map(finding).filter(Boolean).slice(0, 3),
    repair_fit_score: Number.isFinite(l.repair_fit_score) ? Math.max(0, Math.min(100, Math.round(l.repair_fit_score))) : null,
    offer_class: oneOf(l.offer_class, OFFER_CLASSES, "NONE"), status: oneOf(l.status, LEAD_STATUSES, "DISCOVERED"),
    draft_created: !!l.draft_created_at || ["draft_created", "manually_sent"].includes(l.gmail_draft_status), draft_created_at: iso(l.draft_created_at),
    gmail_draft_status: oneOf(l.gmail_draft_status, DRAFT_STATES, "none"), manual_send_detected: l.manual_send_detected === true,
    first_contacted_at: iso(l.first_contacted_at), last_contacted_at: iso(l.last_contacted_at), reply_status: l.reply_status === "replied" ? "replied" : "none", reply_at: iso(l.reply_at),
    customer_status: oneOf(l.customer_status, CUSTOMER_STATES, "none"), suppressed: l.suppressed === true, opt_out: l.opt_out === true, do_not_contact: l.do_not_contact === true,
    last_updated_at: iso(l.last_updated_at),
  };
}
// Cloud-Seite: was der VPS schickt, erneut auf die Allowlist bringen (unbekannte Felder fallen weg). publicLead ist idempotent.
export const cleanLead = (p) => publicLead(p && typeof p === "object" ? { ...p, category_label: p.category } : null);

// ---------- Filter (Suche, Kanton, Gemeinde, Status, Branche, Angebot, Monat, Schnellfilter) ----------
export const FILTER_KEYS = Object.freeze(["q", "company", "domain", "email", "canton", "municipality", "status", "category", "offer", "language", "month", "from", "to", "view"]);
const has = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle).toLowerCase());
export function filterLeads(list = [], f = {}) {
  const statuses = f.status ? String(f.status).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
  return list.filter((l) => {
    if (f.q && ![l.company, l.domain, l.business_email, l.contact_name, l.municipality, l.category].some((v) => has(v, f.q))) return false;
    if (f.company && !has(l.company, f.company)) return false;
    if (f.domain && !has(l.domain, f.domain)) return false;
    if (f.email && !has(l.business_email, f.email)) return false;
    if (f.canton && l.canton !== String(f.canton).toUpperCase()) return false;
    if (f.municipality && !has(l.municipality, f.municipality)) return false;
    if (statuses && !statuses.includes(l.status)) return false;
    if (f.category && !has(l.category, f.category)) return false;
    if (f.offer && l.offer_class !== f.offer) return false;
    if (f.language && l.language !== f.language) return false;
    if (f.month && !String(l.first_discovered_at || "").startsWith(f.month)) return false;
    if (f.from && String(l.first_discovered_at || "") < f.from) return false;
    if (f.to && String(l.first_discovered_at || "").slice(0, 10) > f.to) return false;
    const reached = !!l.first_contacted_at || l.manual_send_detected || ["MANUALLY_SENT", "REPLIED", "CUSTOMER", "NOT_INTERESTED"].includes(l.status);
    if (f.view === "contacted" && !reached) return false;
    if (f.view === "no_reply" && !(reached && l.reply_status !== "replied" && l.customer_status !== "customer")) return false;
    if (f.view === "replied" && l.reply_status !== "replied") return false;
    if (f.view === "customers" && l.customer_status !== "customer") return false;
    if (f.view === "blocked" && !(l.suppressed || l.opt_out || l.do_not_contact)) return false;
    return true;
  });
}
const zurichDay = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
export function leadStats(list = [], now = new Date()) {
  const today = zurichDay(now);
  const n = (f) => list.filter(f).length;
  const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, n((l) => l.status === s)]));
  const byCanton = {};
  for (const l of list) if (l.canton) byCanton[l.canton] = (byCanton[l.canton] || 0) + 1;
  return {
    total: list.length,
    new_today: n((l) => l.first_discovered_at && zurichDay(new Date(l.first_discovered_at)) === today),
    qualified: n((l) => l.offer_class !== "NONE" || !["DISCOVERED", "AUDITED"].includes(l.status)),
    drafts: n((l) => l.gmail_draft_status === "draft_created"),
    waiting_for_draft: n((l) => l.status === "WAITING_FOR_DRAFT"),
    contacted: n((l) => !!l.first_contacted_at || l.manual_send_detected || ["MANUALLY_SENT", "REPLIED", "CUSTOMER", "NOT_INTERESTED"].includes(l.status)),
    replies: n((l) => l.reply_status === "replied"),
    customers: n((l) => l.customer_status === "customer"),
    suppressed: n((l) => l.suppressed), opt_out: n((l) => l.opt_out), do_not_contact: n((l) => l.do_not_contact),
    by_status: byStatus, by_canton: byCanton, cantons_with_leads: Object.keys(byCanton).length,
  };
}

// ---------- CSV-Export (Semikolon + UTF-8-BOM: öffnet direkt in Excel/Numbers mit Schweizer Einstellungen) ----------
export const CSV_COLUMNS = Object.freeze([
  ["Firma", (l) => l.company], ["Website", (l) => l.website], ["Domain", (l) => l.domain], ["Business-E-Mail", (l) => l.business_email],
  ["Kontakt", (l) => l.contact_name], ["Rolle", (l) => l.contact_role], ["Kanton", (l) => l.canton], ["Gemeinde", (l) => l.municipality], ["Sprache", (l) => l.language],
  ["Branche", (l) => l.category], ["Status", (l) => STATUS_LABEL[l.status] || l.status], ["Angebot", (l) => OFFER_LABEL[l.offer_class] || l.offer_class],
  ["Erstes Discovery-Datum", (l) => l.first_discovered_at], ["Letztes Audit", (l) => l.last_audited_at], ["Erster Kontakt", (l) => l.first_contacted_at],
  ["Letzter Kontakt", (l) => l.last_contacted_at], ["Antwort", (l) => (l.reply_status === "replied" ? "ja" : "nein")], ["Kunde", (l) => (l.customer_status === "customer" ? "ja" : "nein")],
  ["Suppressed", (l) => (l.suppressed ? "ja" : "nein")], ["Opt-out", (l) => (l.opt_out ? "ja" : "nein")], ["Do-not-contact", (l) => (l.do_not_contact ? "ja" : "nein")],
]);
const cell = (v) => {
  let s = v == null ? "" : String(v).replace(/[\r\n]+/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = "'" + s; // keine Formel-Injection in Tabellenprogrammen
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function leadsToCsv(list = []) {
  const rows = [CSV_COLUMNS.map(([h]) => h).join(";"), ...list.map((l) => CSV_COLUMNS.map(([, f]) => cell(f(l))).join(";"))];
  return "﻿" + rows.join("\r\n") + "\r\n";
}
// Kurzer Fingerabdruck, damit der VPS die Datenbank nur bei Änderung in die Cloud schickt.
export function dbFingerprint(list = []) {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(list)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
