// TF-075A: Kontaktformular-Anfragen (CONTACT_FORM_INQUIRY) – höchste Mail-Priorität P0.
// TF-077C: Netlify-Benachrichtigungen mit benutzerdefiniertem Text (Felder «Name *», «Was funktioniert nicht?», «Ihre Website *», «Interesse an», kein Link,
// keine Submission-ID): Feldnamen mit Sternchen/Fragezeichen werden erkannt; die RFC-Message-ID ersetzt die Submission-ID nur für ein registriertes Formular
// mit verifizierter Site + Postfach; Test-Einsendungen (is_test) werden beantwortet, erzeugen aber keinen CRM-Lead.
// TF-077B (CONTACT_FORM_P0): eine VERIFIZIERTE Anfrage wird sofort automatisch beantwortet (CONTACT_FORM_REPLY_SENT, genau eine Antwort je
// Einsendung). Verifiziert = bekannter Anbieter mit Gmail-bestätigtem DKIM/DMARC UND registriertes Formular UND konfiguriertes Empfangspostfach
// UND Submission-ID UND Kundenadresse aus Reply-To/Formularfeld (verificationOf). Fehlt etwas → CONTACT_FORM_REVIEW_REQUIRED: nur Entwurf
// (CONTACT_FORM_DRAFT_ONLY, wie TF-075A), nie ein automatischer Versand. Jede Anfrage mit gültiger Kundenadresse legt einen CRM-Lead an bzw.
// befördert den bestehenden (publicContactForms → contact_forms_public.json → CRM-Dienst, Abschnitt KONTAKTFORMULAR – SOFORT BEARBEITEN).
//
//   - Gelesen werden NUR Benachrichtigungen bekannter Formular-Anbieter (Allowlist: Absenderadresse UND DKIM/DMARC-Pass laut
//     Gmail-eigenem Authentication-Results-Header UND – falls konfiguriert – Empfangspostfach/Formularname). Ein From-Header allein
//     reicht nie. Gmail-Suche nur mit einer aus der Allowlist gebauten Anfrage (gmail.searchInbound), keine freie Inbox-Analyse.
//   - Kundenadresse: 1. verifiziertes Reply-To, 2. validiertes E-Mail-Feld des Formulars, 3. exakte Lead-/Auftragsadresse aus der
//     Formular-Registrierung. Nie eine Anbieter-/No-reply-/eigene Adresse, nie geraten. Unklar → CONTACT_FORM_RECIPIENT_REVIEW_REQUIRED.
//   - Zuordnung nur exakt (Adresse, Domain, Auftragsnummer, registrierte Formular-Kennung) – nie über ähnliche Namen.
//   - Entwurf: feste Vorlage DE (CH) bzw. VI (VN) mit bestehender Signatur, Modus CONTACT_FORM_DRAFT_ONLY (gmail.js verweigert jeden
//     Send). Kein state.actions-Eintrag → nie in der Send-Queue. Genau ein Entwurf je Anfrage (Schlüssel aus Submission-ID /
//     RFC-Message-ID / Gmail-ID, Claim „drafting“ vor dem Gmail-Aufruf, unklarer Absturz → nie wiederholen, Prüfung).
//   - Warteschlange: FIFO (received_at, dann Gmail-ID). Ein defektes Element wird nach MAX_ATTEMPTS endgültig markiert und blockiert
//     nie die nächsten.
//   - Gespeichert (contact_forms.json): Metadaten (Anbieter, Formular, Zeit, IDs, Kundenadresse, Zuordnung, Status) + für das CRM eine
//     Kurzfassung der Nachricht (≤ 200 Zeichen), Name, validiertes Telefon und – nur bei ausdrücklichem Wunsch – den Rückruf-Beleg.
//     Nie der volle Mailtext, nie Header.
import crypto from "node:crypto";
import { offerOfOrderId } from "./pricing.js";
import { paymentLinesDe, packageOfInterest } from "./payment-links.js";

export const CONTACT_FORM_CLASS = "CONTACT_FORM_INQUIRY";
export const CONTACT_FORM_DRAFT_MODE = "CONTACT_FORM_DRAFT_ONLY";
export const CONTACT_FORM_AUTO_REPLY_MODE = "CONTACT_FORM_AUTO_REPLY"; // = gmail.js (sendbar, nur hier)
export const PRIORITY_CLASS = "CONTACT_FORM_P0";
export const VERIFICATION = Object.freeze({ VERIFIED: "CONTACT_FORM_VERIFIED", REVIEW: "CONTACT_FORM_REVIEW_REQUIRED" });
export const CONTACT_FORMS_FILE = "contact_forms.json";
// CRM-/Dashboard-Sicht (nur Lead-ID → Status-Wörter, keine Adressen/Inhalte) – liest der CRM-Dienst.
export const CONTACT_FORMS_PUBLIC_FILE = "contact_forms_public.json";
export const MAX_ATTEMPTS = 3;
const DRAFTING_STALE_MS = 10 * 60_000;

// Konzeptuelle Mail-Prioritäten (kleiner = früher). P0 wird in jedem Durchlauf vor allem anderen abgearbeitet.
export const MAIL_PRIORITY = Object.freeze({
  CONTACT_FORM_INQUIRY: 0, // P0
  CUSTOMER_ORDER_MAIL: 1, // P1 bestehende direkte Kunden-/Auftragsmail (Antworten in Jarvis-Threads, Onboarding)
  CUSTOMER_MAIL: 2, // P2 übrige Kunden-Workflows
  COLD_OUTREACH_DRAFT: 3, // P3
  BACKGROUND: 4, // P4
});
export const priorityOf = (item = {}) => MAIL_PRIORITY[item.message_class] ?? MAIL_PRIORITY.BACKGROUND;
// Deterministische Reihenfolge: Priorität, dann ältester Eingang, dann stabile Message-ID.
export const compareMailItems = (a, b) => priorityOf(a) - priorityOf(b)
  || String(a.received_at || "").localeCompare(String(b.received_at || ""))
  || String(a.message_id || "").localeCompare(String(b.message_id || ""));
export const orderMailQueue = (items = []) => [...items].sort(compareMailItems);

export const STATES = Object.freeze({
  NEW: "CONTACT_FORM_NEW",
  DRAFTING: "CONTACT_FORM_DRAFTING",
  DRAFTED: "CONTACT_FORM_REPLY_DRAFTED",
  RECIPIENT_REVIEW: "CONTACT_FORM_RECIPIENT_REVIEW_REQUIRED",
  INVALID: "CONTACT_FORM_INVALID",
  UNKNOWN_FORM: "CONTACT_FORM_UNKNOWN_FORM_REVIEW_REQUIRED",
  FAILED: "CONTACT_FORM_FAILED",
  DRAFT_UNKNOWN: "CONTACT_FORM_DRAFT_UNKNOWN",
  SENDING: "CONTACT_FORM_REPLY_SENDING", // Antwort-Entwurf (AUTO_REPLY) liegt in Gmail, Versand steht aus bzw. läuft
  SENT: "CONTACT_FORM_REPLY_SENT",
  SEND_UNKNOWN: "CONTACT_FORM_SEND_UNKNOWN", // Absturz/Unklarheit während des Sendens – nie automatisch wiederholen
});
export const MATCH = Object.freeze({
  LEAD: "CONTACT_FORM_MATCHED_LEAD",
  ORDER: "CONTACT_FORM_MATCHED_ORDER",
  UNMATCHED: "CONTACT_FORM_UNMATCHED",
  REVIEW: "CONTACT_FORM_MATCH_REVIEW_REQUIRED",
});
const REVIEW_STATES = new Set([STATES.RECIPIENT_REVIEW, STATES.INVALID, STATES.UNKNOWN_FORM, STATES.FAILED, STATES.DRAFT_UNKNOWN, STATES.SEND_UNKNOWN]);
// Ohne gültige Kundenadresse kein CRM-Lead (Prüfung bei Chris); alle anderen Anfragen erscheinen im CRM.
const NO_LEAD_STATES = new Set([STATES.RECIPIENT_REVIEW, STATES.INVALID, STATES.UNKNOWN_FORM]);

// Bekannte Formular-Anbieter. from: exakte Absenderadressen der Benachrichtigung; dkim: Domains, deren DKIM-/DMARC-Pass Gmail
// bestätigen muss. Weitere Anbieter / eigene Weiterleitungen: config.json contactForms.providers (gleiches Schema).
export const DEFAULT_PROVIDERS = Object.freeze([
  { id: "netlify", from: ["formresponses@netlify.com"], dkim: ["netlify.com"] },
  { id: "formspree", from: ["noreply@formspree.io"], dkim: ["formspree.io"] },
]);
export const DEFAULT_CONTACT_FORM_CONFIG = Object.freeze({
  enabled: true,
  providers: [], // zusätzliche Anbieter
  forms: [], // registrierte Formulare: { form_name, site?, market?: "CH"|"VN", lead_id?, order_id?, customer_email? }
  receivingMailboxes: [], // optional: nur Benachrichtigungen an diese Postfächer
  maxPerTick: 20,
  newerThanDays: 14,
});

// ---------- Hilfen ----------
const lc = (s) => String(s ?? "").trim().toLowerCase();
const addrOf = (s = "") => lc(String(s).match(/<([^>]*)>/)?.[1] ?? s);
const domainOf = (e) => lc(String(e).split("@")[1] || "");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 24);
const STRICT_EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const NOREPLY_LOCAL_RE = /^(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|bounces?|notifications?|notify|formresponses|forms?|submissions?|system|daemon|alerts?)([+._-].*)?$/i;
const FREEMAIL_RE = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|bluewin|hispeed|sunrise|protonmail|proton|yandex|aol)\.[a-z.]+$/i;
const ORDER_REF_RE = /\b(CA150|RF480|VNCHECK|VNFIX)-\d{8}-[0-9a-f]{6}\b/gi;
const VI_CHARS_RE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi;

export function providersOf(cfg = {}) {
  const extra = Array.isArray(cfg.providers) ? cfg.providers : [];
  return [...DEFAULT_PROVIDERS, ...extra].filter((p) => p && typeof p.id === "string" && Array.isArray(p.from) && p.from.length && Array.isArray(p.dkim) && p.dkim.length)
    .map((p) => ({ id: p.id, from: p.from.map(lc), dkim: p.dkim.map(lc) }));
}
const providerDomains = (cfg) => new Set(providersOf(cfg).flatMap((p) => [...p.dkim, ...p.from.map(domainOf)]));

// Gmail-Suchanfrage NUR aus der Allowlist (keine freie Eingabe). Liefert null, wenn nichts konfiguriert ist.
export function inboundQuery(cfg = {}) {
  const from = [...new Set(providersOf(cfg).flatMap((p) => p.from))].filter((a) => STRICT_EMAIL_RE.test(a));
  if (!from.length) return null;
  const days = Math.max(1, Math.min(60, Number(cfg.newerThanDays) || 14));
  return `from:(${from.join(" OR ")}) -in:sent -in:drafts -in:spam -in:trash newer_than:${days}d`;
}

// Gmail setzt den obersten Authentication-Results-Header selbst (authserv-id mx.google.com). Nur dieser zählt – tiefer liegende
// Header kann ein Absender beliebig mitschicken.
export function authPassFor(headers = {}, domains = []) {
  const all = Array.isArray(headers["authentication-results"]) ? headers["authentication-results"] : headers["authentication-results"] ? [headers["authentication-results"]] : [];
  const top = String(all[0] || "");
  if (!/^\s*mx\.google\.com\s*;/i.test(top)) return false;
  const ok = (d) => { const x = lc(d); return domains.some((dom) => x === dom || x.endsWith("." + dom)); };
  for (const m of top.matchAll(/dkim=pass[^;]*?header\.(?:i|d)=@?([a-z0-9.-]+)/gi)) if (ok(m[1])) return true;
  for (const m of top.matchAll(/dmarc=pass[^;]*?header\.from=([a-z0-9.-]+)/gi)) if (ok(m[1])) return true;
  return false;
}

// "Feld: Wert"-Zeilen einer Formular-Benachrichtigung. Mehrzeilige Nachricht: Folgezeilen gehören zum letzten Feld.
// TF-077C: Feldnamen dürfen ein Pflichtfeld-Sternchen und/oder Fragezeichen tragen («Name *», «Was funktioniert nicht?») – beides gehört nicht
// zum Schlüssel. Normalisierung: NFC, Kleinbuchstaben, Leerzeichen/Punkt/Bindestrich/Unterstrich → «_» («E-Mail *» → e_mail).
export const normalizeFieldKey = (k) => lc(String(k ?? "").normalize("NFC")).replace(/[*?]+/g, " ").replace(/[\s_.-]+/g, "_").replace(/^_+|_+$/g, "");
const FIELD_LINE_RE = /^\s*([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ0-9 _./-]{0,40}?)\s*[*?]*\s*:\s*(.*)$/u;
export function parseFormFields(body = "") {
  const fields = {};
  let last = null;
  for (const raw of String(body).replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/^\s*[*•-]\s*/, "");
    const m = line.match(FIELD_LINE_RE);
    if (m && !/^https?$/i.test(m[1])) { last = normalizeFieldKey(m[1]); fields[last] = (fields[last] ? fields[last] + "\n" : "") + m[2].trim(); continue; }
    if (/^\s*https?:\/\/\S+\s*$/.test(line) && /submissions?\//i.test(line)) { last = null; continue; } // Anbieter-Link, kein Kundentext
    if (last && line.trim()) fields[last] += "\n" + line.trim();
    else if (!line.trim()) last = last && MSG_KEYS.includes(last) ? last : null;
  }
  return fields;
}
const EMAIL_KEYS = ["email", "e_mail", "mail", "email_address", "e_mail_adresse", "emailadresse", "your_email", "ihre_e_mail", "dia_chi_email", "địa_chỉ_email"];
const NAME_KEYS = ["name", "full_name", "your_name", "ihr_name", "vorname_nachname", "ho_ten", "họ_tên", "họ_và_tên", "ten"];
const MSG_KEYS = ["message", "nachricht", "anliegen", "ihre_nachricht", "comments", "comment", "anfrage", "was_funktioniert_nicht", "noi_dung", "nội_dung", "tin_nhan", "tin_nhắn"];
// TF-077C: nur Anzeige/CRM-Kontext – nie Empfänger, nie Verifikation.
const WEBSITE_KEYS = ["ihre_website", "ihre_webseite", "website", "webseite"];
const INTEREST_KEYS = ["interesse_an", "interesse", "interest"];
const SUBJECT_KEYS = ["subject", "betreff", "thema", "tieu_de", "tiêu_đề"];
const FORMNAME_KEYS = ["form_name", "form", "formular"];
const PHONE_KEYS = ["phone", "telefon", "tel", "telefonnummer", "phone_number", "mobile", "handy", "natel", "ihre_telefonnummer", "so_dien_thoai", "số_điện_thoại", "dien_thoai", "điện_thoại"];
const CALLBACK_KEYS = ["rueckruf", "rückruf", "callback", "call_back", "rueckruf_erwuenscht", "rückruf_erwünscht", "goi_lai", "gọi_lại"];
const pick = (f, keys) => { for (const k of keys) if (typeof f[k] === "string" && f[k].trim()) return f[k].trim(); return ""; };

// TF-077C: «Ihre Website» des Kunden – nur URL-validiert (http/https, vollständiger Hostname, keine Zugangsdaten, kein Sonderport, keine IP), ohne
// Query/Fragment. Reiner Kontext für CRM/Anzeige: wird NIE Empfänger, nie Verifikation und nie als Audit-Ziel übernommen.
export function normalizeWebsite(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 200 || /[\s<>"'\\\u0000-\u001f]/.test(s)) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && !["80", "443"].includes(u.port))) return null;
  const host = u.hostname.toLowerCase();
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(host)) return null;
  return `${u.protocol}//${host}${u.pathname === "/" ? "/" : u.pathname.slice(0, 150)}`.slice(0, 200);
}
// «Interesse an»: Freitext, einzeilig, ≤ 80 Zeichen – nur Anzeige/CRM.
export const interestOf = (raw) => String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || null;

// TF-077C: Test-Einsendung = Kundenname entspricht einem bekannten Eigentümer (Anzeigename oder Local-Part einer Adresse aus ownAddresses,
// Umlaute ae/a-tolerant, Reihenfolge egal, ≥ 6 Buchstaben) ODER die Nachricht enthält «testrun»/«testlauf»/«ohne echtgeld». Der Name allein
// beeinflusst nie Empfänger oder Verifikation – er unterdrückt nur den CRM-Lead (Antwort wie gewohnt).
const TEST_MESSAGE_RE = /\b(?:testrun|testlauf)\b|ohne\s+echtgeld/iu;
const foldLetters = (s, translit) => {
  let x = String(s ?? "").normalize("NFC").toLowerCase();
  if (translit) x = x.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
  return x.replace(/ß/g, "ss").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
};
const nameKeys = (s) => {
  const tokens = String(s ?? "").split(/[\s,._+-]+/).filter(Boolean);
  const out = new Set();
  for (const order of tokens.length > 1 ? [tokens, [...tokens].reverse()] : [tokens]) for (const t of [true, false]) { const k = foldLetters(order.join(""), t); if (k.length >= 6) out.add(k); }
  return out;
};
export function isTestSubmission({ name = "", message = "", ownAddresses = [] } = {}) {
  if (TEST_MESSAGE_RE.test(String(message))) return true;
  const mine = nameKeys(name);
  if (!mine.size) return false;
  for (const a of ownAddresses) {
    const raw = String(a ?? "");
    const display = raw.includes("<") ? raw.slice(0, raw.indexOf("<")).replace(/["']/g, "") : "";
    const local = addrOf(raw).split("@")[0] || "";
    for (const k of [...nameKeys(display), ...nameKeys(local)]) if (mine.has(k)) return true;
  }
  return false;
}

// TF-077B: Telefonnummer aus dem Formular – nur validiert (CH +41 9 Ziffern, VN +84 9–10 Ziffern), gehört ausschliesslich zu dieser Einsendung.
export function normalizePhone(raw, market = "CH") {
  const s = String(raw || "").trim();
  if (!s || s.length > 30 || !/^[+0-9 ()\/.-]+$/.test(s)) return null;
  let d = s.replace(/[^\d+]/g, "");
  if (d.startsWith("00")) d = "+" + d.slice(2);
  if (/^0\d{9,10}$/.test(d)) d = (market === "VN" ? "+84" : "+41") + d.slice(1);
  if (/^\+41\d{9}$/.test(d) || /^\+84\d{9,10}$/.test(d)) return { display: s, e164: d };
  return null;
}
// Ausdrücklicher Rückrufwunsch – nur eindeutige Formulierungen bzw. ein ausdrücklich angekreuztes Rückruf-Feld. Ein ausgefülltes Telefonfeld
// allein ist NIE ein Rückrufwunsch und nie eine Werbe-Einwilligung. Verneinungen («bitte nicht anrufen») heben ihn auf.
const CALLBACK_RE = /bitte\s+rufen\s+sie\s+(?:mich|uns)\s+(?:bitte\s+)?(?:zurück|an)\b|rufen\s+sie\s+(?:mich|uns)\s+bitte\s+(?:zurück|an)\b|bitte\s+um\s+(?:einen\s+)?rückruf|rückruf\s+(?:erwünscht|erbeten|gewünscht)|ich\s+bitte\s+um\s+rückruf|please\s+call\s+me(?:\s+back)?|call\s+me\s+back|vui\s+lòng\s+gọi\s+(?:lại\s+)?cho\s+tôi|xin\s+gọi\s+lại\s+cho\s+tôi|hãy\s+gọi\s+lại\s+cho\s+tôi/iu;
const NO_CALL_RE = /nicht\s+(?:an)?rufen|keine\s+anrufe|kein\s+(?:rück)?ruf|bitte\s+nur\s+(?:per\s+)?(?:e-?mail|mail|schriftlich)|do\s+not\s+call|don'?t\s+call|đừng\s+gọi|không\s+gọi/iu;
export function callbackRequest(fields = {}, message = "") {
  const text = String(message || "").normalize("NFC");
  if (NO_CALL_RE.test(text)) return null;
  const box = pick(fields, CALLBACK_KEYS);
  if (box && /^(ja|yes|true|x|on|1|có|bitte)$/i.test(box.trim())) return { source: "FORM_FIELD", evidence: `Rückruf-Feld: ${box.trim().slice(0, 20)}` };
  const m = text.match(CALLBACK_RE);
  return m ? { source: "FORM_MESSAGE", evidence: m[0].replace(/\s+/g, " ").slice(0, 80) } : null;
}
// Verifizierung für die AUTOMATISCHE Antwort (TF-077B §11). Ein From-Header allein genügt nie (DKIM/DMARC prüft classifyInbound vorher).
export function verificationOf(item = {}) {
  const missing = [];
  if (!item.form_registered) missing.push("form_not_registered");
  if (!item.site_verified) missing.push("form_site_not_verified");
  if (!item.mailbox_verified) missing.push("receiving_mailbox_not_verified");
  if (!item.submission_id) missing.push("no_submission_id");
  if (!["reply_to", "form_field"].includes(item.recipient_source)) missing.push("customer_email_not_submitted");
  return { verified: !missing.length, missing };
}

// Empfänger-Validierung: genau EINE syntaktisch saubere Adresse, keine Header-Injection, keine Anbieter-/No-reply-/eigene Adresse.
export function validateCustomerEmail(raw, { cfg = {}, ownAddresses = [] } = {}) {
  const s = String(raw ?? "");
  if (!s.trim()) return { ok: false, reason: "missing" };
  if (/[\r\n\0]|%0[ad]|\\[rn]/i.test(s)) return { ok: false, reason: "header_injection" };
  const inner = s.includes("<") ? s.match(/<([^<>]*)>/)?.[1] : s;
  if (inner == null || (s.match(/@/g) || []).length !== 1 || /[,;]/.test(s) || (s.match(/</g) || []).length > 1) return { ok: false, reason: "multiple_or_malformed" };
  const e = lc(inner);
  if (!STRICT_EMAIL_RE.test(e) || e.includes("..")) return { ok: false, reason: "invalid_syntax" };
  if (NOREPLY_LOCAL_RE.test(e.split("@")[0])) return { ok: false, reason: "noreply_address" };
  const d = domainOf(e);
  if ([...providerDomains(cfg)].some((p) => d === p || d.endsWith("." + p))) return { ok: false, reason: "provider_address" };
  if (ownAddresses.map(addrOf).filter(Boolean).includes(e)) return { ok: false, reason: "own_address" };
  return { ok: true, email: e };
}

// Formular-Registrierung (config.contactForms.forms): Formularname exakt (Gross-/Kleinschreibung egal), optional Site.
function registeredForm(cfg, formName, site) {
  const forms = Array.isArray(cfg.forms) ? cfg.forms : [];
  return forms.find((f) => f && lc(f.form_name) && lc(f.form_name) === lc(formName) && (!f.site || !site || lc(f.site) === lc(site))) || null;
}

// ---------- Erkennung ----------
// msg: { messageId, rfcMessageId, threadId, from, replyTo, to, deliveredTo, subject, body, internalDate, headers: { lowercase → string|string[] } }
// Ergebnis: { contactForm: false, reason } (kein / nicht vertrauenswürdiges Formular) oder { contactForm: true, item } (item.state NEW oder Prüf-/Ablehnungsstatus).
export function classifyInbound(msg = {}, { cfg = {}, ownAddresses = [] } = {}) {
  const from = addrOf(msg.from);
  const provider = providersOf(cfg).find((p) => p.from.includes(from));
  if (!provider) return { contactForm: false, reason: "not_a_form_provider" };
  // Spoofing-Schutz: ohne Gmail-bestätigten DKIM-/DMARC-Pass des Anbieters ist die Mail KEIN Kontaktformular (nie P0, nie Entwurf).
  if (!authPassFor(msg.headers || {}, provider.dkim)) return { contactForm: false, reason: "untrusted_sender", provider: provider.id };
  const boxes = (Array.isArray(cfg.receivingMailboxes) ? cfg.receivingMailboxes : []).map(lc).filter(Boolean);
  if (boxes.length) {
    const rcpt = [msg.to, msg.deliveredTo].join(",").toLowerCase();
    if (!boxes.some((b) => rcpt.includes(b))) return { contactForm: false, reason: "not_for_known_mailbox", provider: provider.id };
  }
  const body = String(msg.body || "");
  const fields = parseFormFields(body);
  const subject = String(msg.subject || "");
  const formName = pick(fields, FORMNAME_KEYS) || subject.match(/\(([^()]{1,60})\)\s*$/)?.[1] || subject.match(/form(?:ular)?\s*[«"“']([^»"”']{1,60})[»"”']/i)?.[1]
    || subject.match(/submission (?:from|for|to)\s+(.{1,60}?)(?:\s+form)?\s*$/i)?.[1] || "";
  const site = lc(subject.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:netlify\.app|ch|vn|com|net|org|de|li))\b/i)?.[1] || "");
  const submission_id = (body.match(/submissions?\/([a-z0-9]{12,40})\b/i)?.[1] || pick(fields, ["submission_id", "submission"]).match(/^[a-z0-9-]{8,64}$/i)?.[0] || null);
  const received_at = new Date(Number(msg.internalDate) || Date.parse(msg.date || "") || 0).toISOString();
  const base = {
    message_class: CONTACT_FORM_CLASS, priority: "P0", source_provider: provider.id, form_name: formName ? formName.slice(0, 60) : null, site: site || null,
    received_at, message_id: String(msg.messageId || ""), rfc_message_id: msg.rfcMessageId ? String(msg.rfcMessageId).slice(0, 200) : null,
    submission_id, thread_id: msg.threadId || null,
  };
  base.key = idempotencyKey(base);
  const form = registeredForm(cfg, formName, site);
  const message = pick(fields, MSG_KEYS);
  const inquiry = { name: pick(fields, NAME_KEYS).slice(0, 120), subject: pick(fields, SUBJECT_KEYS).slice(0, 160), message: message.slice(0, 4000) };
  // Ungültige Benachrichtigung (keine Formularfelder / keine Nachricht) → abgelehnt, kein Entwurf.
  if (!Object.keys(fields).length || !message) return { contactForm: true, item: { ...base, state: STATES.INVALID, reason: "no_form_fields" }, inquiry };
  // Sind Formulare registriert, muss es eines davon sein.
  if ((cfg.forms || []).length && !form) return { contactForm: true, item: { ...base, state: STATES.UNKNOWN_FORM, reason: "form_not_registered" }, inquiry };
  const rec = selectCustomerEmail({ replyTo: msg.replyTo, fieldEmail: pick(fields, EMAIL_KEYS), form, cfg, ownAddresses });
  const form_market = form?.market === "VN" ? "VN" : form?.market === "CH" ? "CH" : null;
  // TF-077B Identität: Website des Formulars = Netlify-Site aus dem Dashboard-Link der Benachrichtigung (bzw. Betreff «from <site>») muss der
  // registrierten Site entsprechen – ein gleichnamiges Formular einer fremden (z. B. Kunden-)Website ist nie «unser» Formular.
  const slug = (s) => lc(s).replace(/^https?:\/\//, "").replace(/\.netlify\.app\/?$/, "").replace(/\/.*$/, "");
  const notifSite = body.match(/app\.netlify\.com\/(?:sites|projects)\/([a-z0-9-]{1,63})\//i)?.[1] || subject.match(/submission from\s+([a-z0-9-]{1,63})\s*\(/i)?.[1] || "";
  const site_verified = !!form?.site && !!notifSite && slug(form.site) === slug(notifSite);
  // Empfangspostfach: konfiguriert (receivingMailboxes, oben geprüft) – sonst Jarvis' eigenes Absenderpostfach als Delivered-To.
  const own = ownAddresses.map(addrOf).filter(Boolean);
  const mailbox_verified = boxes.length > 0 || (!!msg.deliveredTo && own.includes(addrOf(msg.deliveredTo)));
  // TF-077B: CRM-Angaben dieser Einsendung (Kurzfassung, Name, validiertes Telefon, ausdrücklicher Rückrufwunsch) – nie der volle Text.
  const phone = normalizePhone(pick(fields, PHONE_KEYS), form_market || "CH");
  const cb = phone ? callbackRequest(fields, message) : null;
  // TF-077C: Fehlt die Submission-ID in der Benachrichtigung (benutzerdefinierter Netlify-Text ohne Link), gilt NUR für ein registriertes Formular
  // mit verifizierter Site UND verifiziertem Postfach die RFC-Message-ID (Header), sonst die Gmail-ID, als Einsendungs-ID – für Idempotenz
  // (der Schlüssel bleibt derselbe) UND Verifikation. Ohne Registrierung/Site-Verifikation bleibt «no_submission_id».
  let sid = base.submission_id, sid_source = sid ? "provider" : null;
  if (!sid && !!form && site_verified && mailbox_verified) {
    if (base.rfc_message_id) { sid = base.rfc_message_id; sid_source = "rfc_message_id"; }
    else if (base.message_id) { sid = base.message_id; sid_source = "gmail_message_id"; }
  }
  const is_test = isTestSubmission({ name: inquiry.name, message, ownAddresses });
  const item = { ...base, submission_id: sid, submission_id_source: sid_source, is_test, customer_website: normalizeWebsite(pick(fields, WEBSITE_KEYS)), interest: interestOf(pick(fields, INTEREST_KEYS)),
    // TF-079: Zahlungslink(s) in der Antwort – ausdrücklich je Formular (forms[].payment_links true/false); ohne Angabe nur, wenn das Formular das Feld
    // «Interesse an» liefert (Angebots-Landingpage).
    offer_links: form?.payment_links === false ? false : form?.payment_links === true || !!interestOf(pick(fields, INTEREST_KEYS)),
    form_market, form_lead_id: form?.lead_id || null, form_order_id: form?.order_id || null,
    form_registered: !!form, site_verified, mailbox_verified, form_site: lc(form?.site || "") || site || null,
    summary: message.replace(/\s+/g, " ").trim().slice(0, 200), name: inquiry.name || null, phone: phone?.display || null, phone_e164: phone?.e164 || null,
    callback_requested: !!cb, callback_evidence: cb ? `${cb.source}: ${cb.evidence}` : null };
  if (!rec.ok) return { contactForm: true, item: { ...item, state: STATES.RECIPIENT_REVIEW, reason: rec.reason }, inquiry };
  const v = verificationOf({ ...item, recipient_source: rec.source });
  return { contactForm: true, item: { ...item, state: STATES.NEW, customer_email: rec.email, recipient_source: rec.source,
    verified: v.verified, verification: v.verified ? VERIFICATION.VERIFIED : VERIFICATION.REVIEW, verify_missing: v.missing }, inquiry };
}

export function idempotencyKey({ source_provider, submission_id, rfc_message_id, message_id }) {
  if (submission_id) return "cf:" + sha(`${source_provider}|sub|${lc(submission_id)}`);
  if (rfc_message_id) return "cf:" + sha(`${source_provider}|rfc|${lc(rfc_message_id)}`);
  return "cf:" + sha(`${source_provider}|gm|${message_id}`);
}

// Reihenfolge: verifiziertes Reply-To → validiertes Formularfeld → exakte Adresse aus der Formular-Registrierung. Widersprechen sich
// Reply-To und Formularfeld (beide gültig, verschieden) → Prüfung statt raten.
export function selectCustomerEmail({ replyTo = "", fieldEmail = "", form = null, cfg = {}, ownAddresses = [] } = {}) {
  const rt = replyTo ? validateCustomerEmail(replyTo, { cfg, ownAddresses }) : null;
  const fe = fieldEmail ? validateCustomerEmail(fieldEmail, { cfg, ownAddresses }) : null;
  if (rt?.reason === "header_injection" || fe?.reason === "header_injection") return { ok: false, reason: "header_injection" };
  if (rt?.ok && fe?.ok && rt.email !== fe.email) return { ok: false, reason: "reply_to_field_mismatch" };
  if (rt?.ok) return { ok: true, email: rt.email, source: "reply_to" };
  if (fe?.ok) return { ok: true, email: fe.email, source: "form_field" };
  const reg = form?.customer_email ? validateCustomerEmail(form.customer_email, { cfg, ownAddresses }) : null;
  if (reg?.ok) return { ok: true, email: reg.email, source: "registered_form" };
  return { ok: false, reason: fe?.reason || rt?.reason || "no_customer_email" };
}

// ---------- Zuordnung (nur exakt) ----------
// leads: [{ lead_id, domain, emails: [], market, language, company }], orders: { order_id: { order_id, customer_email, domain, market, lead_id, company, locale } }
export function matchInquiry({ item, text = "", leads = [], orders = {} }) {
  const email = lc(item.customer_email);
  const dom = email && !FREEMAIL_RE.test(domainOf(email)) ? domainOf(email) : null;
  const orderList = Object.values(orders || {}).filter((o) => o && o.order_id);
  const refs = [...new Set([...String(text).matchAll(ORDER_REF_RE)].map((m) => m[0].toUpperCase()))];
  const ordersFor = (fn) => orderList.filter(fn);
  const leadOf = (id) => leads.find((l) => l.lead_id === id) || null;
  const out = (state, o = {}) => ({ match_state: state, lead_id: o.lead_id || null, order_id: o.order_id || null, market: o.market || item.form_market || null, language: o.language || null, company: o.company || null });
  // 1) Registrierte Formular-Kennung mit festem Auftrag/Lead (nur mit passender Adresse – sonst nie fremder Kontext).
  if (item.form_order_id) {
    const o = orderList.find((x) => x.order_id === item.form_order_id);
    if (o && lc(o.customer_email) === email) return out(MATCH.ORDER, { order_id: o.order_id, lead_id: o.lead_id, market: o.market, company: o.company, language: o.market === "VN" ? "vi" : "de" });
  }
  // 2) Ausdrückliche Auftragsnummer im Text: nur gültig, wenn die Adresse exakt zum Auftrag passt.
  if (refs.length) {
    const hits = ordersFor((o) => refs.includes(String(o.order_id).toUpperCase()));
    const own = hits.filter((o) => lc(o.customer_email) === email);
    if (own.length === 1) return out(MATCH.ORDER, { ...own[0], language: own[0].market === "VN" ? "vi" : "de" });
    if (hits.length) return out(MATCH.REVIEW);
  }
  // 3) Exakte Kundenadresse eines Auftrags.
  const byMail = ordersFor((o) => email && lc(o.customer_email) === email);
  if (byMail.length === 1) return out(MATCH.ORDER, { ...byMail[0], language: byMail[0].market === "VN" ? "vi" : "de" });
  if (byMail.length > 1) {
    const live = byMail.filter((o) => !o.terminal);
    if (live.length === 1) return out(MATCH.ORDER, { ...live[0], language: live[0].market === "VN" ? "vi" : "de" });
    return out(MATCH.REVIEW);
  }
  // 4) Exakte Adresse eines Leads, danach exakte (geschäftliche) Domain.
  const leadHits = leads.filter((l) => email && (l.emails || []).map(lc).includes(email));
  const uniq = (arr) => [...new Map(arr.map((l) => [l.lead_id, l])).values()];
  const byEmail = uniq(leadHits);
  if (byEmail.length === 1) return out(MATCH.LEAD, { ...byEmail[0] });
  if (byEmail.length > 1) return out(MATCH.REVIEW);
  if (item.form_lead_id) {
    const l = leadOf(item.form_lead_id);
    if (l && dom && lc(l.domain) === dom) return out(MATCH.LEAD, { ...l });
  }
  const byDomain = dom ? uniq(leads.filter((l) => lc(l.domain) === dom)) : [];
  if (byDomain.length === 1) return out(MATCH.LEAD, { ...byDomain[0] });
  if (byDomain.length > 1) return out(MATCH.REVIEW);
  return out(MATCH.UNMATCHED);
}

// Sprache konservativ: Auftrag/Lead → deren Markt; sonst Markt des registrierten Formulars; sonst eindeutig vietnamesischer Text → vi; sonst de.
export function languageOf({ match = {}, item = {}, text = "" }) {
  if (match.order_id || match.lead_id) return match.market === "VN" || match.language === "vi" ? "vi" : "de";
  if (item.form_market === "VN") return "vi";
  if (item.form_market === "CH") return "de";
  return (String(text).match(VI_CHARS_RE) || []).length >= 5 ? "vi" : "de";
}

// ---------- Entwurf (feste Vorlage, keine erfundenen Fakten) ----------
const quote = (s) => String(s || "").split("\n").slice(0, 40).map((l) => "> " + l).join("\n");
// TF-079: Welche(r) Zahlungslink(s) gehören in die Antwort? Zugeordneter, noch unbezahlter CH-Auftrag → sein Paket MIT Auftrags-ID (Zahlung wird automatisch
// zugeordnet). Bezahlt/abgeschlossen/storniert → kein Link. Sonst (Formular mit Angebot): Paket aus «Interesse an», unklar → beide Pakete zur Auswahl.
// VN-Anfragen bekommen nie einen (CHF-)Link.
export function paymentContextOf(it = {}, orderMap = {}) {
  if (it.language === "vi" || it.market === "VN" || it.form_market === "VN") return null;
  const o = it.order_id ? (orderMap || {})[it.order_id] : null;
  if (it.order_id) {
    const info = o ? offerOfOrderId(o.order_id) : null;
    if (!o || o.payment_gate_met === true || o.cancelled || o.terminal || !info || info.market !== "CH") return null;
    return { kind: info.kind, orderId: o.order_id, email: it.customer_email || null };
  }
  if (it.offer_links !== true) return null;
  return { kind: packageOfInterest(it.interest), orderId: null, email: it.customer_email || null };
}
// TF-077B: bezieht sich auf den tatsächlichen Inhalt (zitiert die Nachricht, nennt einen zugeordneten Auftrag bzw. einen notierten Rückrufwunsch) –
// keine Preise, keine Termine, keine Leistungsversprechen, keine Verkaufsbehauptungen.
export function composeReply({ lang = "de", inquiry = {}, sender = {}, vnSignature = "", context = {} }) {
  const name = String(inquiry.name || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 80);
  const order = ORDER_ID_OK.test(String(context.order_id || "")) ? context.order_id : null;
  if (lang === "vi") {
    const subject = inquiry.subject ? `Re: ${inquiry.subject}` : "Phản hồi yêu cầu liên hệ của anh/chị";
    const body = [`Kính gửi ${name || "anh/chị"},`, "",
      "Cảm ơn anh/chị đã liên hệ với chúng tôi qua biểu mẫu trên website. Chúng tôi đã nhận được yêu cầu và sẽ phản hồi chi tiết trong thời gian sớm nhất.",
      ...(order ? ["", `Yêu cầu của anh/chị liên quan đến đơn hàng ${order}.`] : []),
      ...(context.callback ? ["", "Chúng tôi đã ghi nhận yêu cầu gọi lại của anh/chị."] : []), "",
      "Nội dung anh/chị đã gửi:", quote(inquiry.message), "", vnSignature].join("\n");
    return { subject, body: body.normalize("NFC").trim() };
  }
  const subject = inquiry.subject ? `Re: ${inquiry.subject}` : "Ihre Anfrage über unser Kontaktformular";
  const payLines = context.payment ? paymentLinesDe(context.payment) : [];
  const signature = sender.signature?.trim() || [sender.name, sender.company, sender.email].filter(Boolean).join("\n");
  const body = [name ? `Guten Tag ${name}` : "Guten Tag", "",
    "Vielen Dank für Ihre Nachricht über unser Kontaktformular. Wir haben Ihre Anfrage erhalten und melden uns so rasch wie möglich ausführlich bei Ihnen.",
    ...(order ? ["", `Ihre Anfrage betrifft Ihren Auftrag ${order}.`] : []),
    ...(context.callback ? ["", "Ihren Rückrufwunsch haben wir notiert."] : []),
    ...(payLines.length ? ["", "Wenn Sie direkt starten möchten:", "", ...payLines, "", "Sobald die Zahlung bei uns eingegangen ist, melde ich mich mit den nächsten Schritten."] : []), "",
    "Ihre Nachricht:", quote(inquiry.message), "", "Freundliche Grüsse", ...(signature ? ["", signature] : [])].join("\n");
  return { subject, body: body.trim() };
}
const ORDER_ID_OK = /^(CA150|RF480|VNCHECK|VNFIX)-\d{8}-[0-9a-f]{6}$/;

// ---------- Ablage ----------
export const loadContactForms = (store) => { const s = store.read(CONTACT_FORMS_FILE, {}) || {}; return { v: 1, ...s, items: s.items || {}, seen: s.seen || {} }; };
export const STATUS_WORD = (state) => (state === STATES.SENT ? "REPLY_SENT" : state === STATES.DRAFTED ? "DRAFT_CREATED"
  : [STATES.NEW, STATES.DRAFTING, STATES.SENDING].includes(state) ? "NEW" : "REVIEW_REQUIRED");
const LEAD_ID_OK = /^[a-z0-9][a-z0-9.@_+-]{2,252}$/;
// Website des Kunden nur aus einer geschäftlichen Adressdomain (nie Freemail, nie geraten); das Formular selbst liegt auf unserer Website.
const bizSite = (email) => { const d = domainOf(lc(email)); return d && !FREEMAIL_RE.test(d) && /^[a-z0-9.-]+\.[a-z]{2,24}$/.test(d) ? `https://${d}/` : null; };
// CRM-Lead einer Anfrage: zugeordneter Lead (exakt) – sonst geschäftliche Domain der Kundenadresse – sonst die Adresse selbst. Nie über Namen.
export function inquiryLeadId(it = {}) {
  if (it.lead_id && [MATCH.LEAD, MATCH.ORDER].includes(it.match_state) && LEAD_ID_OK.test(it.lead_id)) return it.lead_id;
  const e = lc(it.customer_email);
  if (!e) return null;
  const d = domainOf(e);
  if (it.match_state !== MATCH.REVIEW && d && !FREEMAIL_RE.test(d) && LEAD_ID_OK.test(d)) return d;
  return LEAD_ID_OK.test(e) ? e : `cf-${sha(e)}`;
}
// Sicht für den CRM-Dienst (contact_forms_public.json, nur VPS-intern; das CRM überträgt nur seine Allowlist in die Cloud): je Lead
// CONTACT_FORM_P0-Metadaten der Anfragen mit gültiger Kundenadresse. Ohne Kundenadresse (Prüfung) → kein Lead.
export function publicContactForms(st) {
  const leads = {};
  for (const it of Object.values(st.items || {}).sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)) || String(a.key).localeCompare(String(b.key)))) {
    if (NO_LEAD_STATES.has(it.state) || !it.customer_email || it.is_test === true) continue; // TF-077C: Test-Einsendungen erzeugen nie einen CRM-Lead
    const id = inquiryLeadId(it);
    if (!id) continue;
    const prev = leads[id];
    const matched = !!it.lead_id && [MATCH.LEAD, MATCH.ORDER].includes(it.match_state);
    leads[id] = {
      status: STATUS_WORD(it.state), matched: matched || !!prev?.matched, received_at: it.received_at, count: (prev?.count || 0) + 1,
      lead_source: "CONTACT_FORM", priority_class: PRIORITY_CLASS, priority_at: prev?.priority_at || it.created_at || it.received_at,
      submission_id: it.key, contact_form_status: it.state, verified: it.verified === true, market: it.market === "VN" ? "VN" : "CH",
      email: lc(it.customer_email), name: it.name || prev?.name || null, company: it.company || prev?.company || null, summary: it.summary || null,
      customer_website: it.customer_website || prev?.customer_website || null, interest: it.interest || prev?.interest || null,
      phone: it.phone || prev?.phone || null, phone_e164: it.phone_e164 || prev?.phone_e164 || null, website: bizSite(it.customer_email),
      callback_requested: it.callback_requested === true, callback_evidence: it.callback_requested ? it.callback_evidence || null : null,
      reply_sent_at: it.state === STATES.SENT ? it.sent_at || null : prev?.reply_sent_at || null, order_id: it.order_id || prev?.order_id || null,
      submissions: [...(prev?.submissions || []), { key: it.key, received_at: it.received_at, status: STATUS_WORD(it.state) }].slice(-10),
    };
  }
  return { v: 2, leads };
}

// ---------- P0-Verarbeitung (ein Durchlauf) ----------
// gmail: { searchInbound({ query, max }) → [messageId], readInbound(messageId) → msg, createDraft({ to, subject, body, mode, contactFormKey }), listOwned() }
// TF-077B: autoReply (Mail-Worker: contactForms.autoReply !== false und Absenderidentität vorhanden) + sendGuard (serverseitiges Send-Lock je
// Einsendung, gleiches Lock wie alle Jarvis-Sends) – nur VERIFIZIERTE Anfragen werden automatisch gesendet, genau einmal.
const NO_GUARD = Object.freeze({ acquire: async () => ({ ok: true }), done: async () => {} });
export async function processContactForms({ gmail, store, cfg = {}, sender = {}, vnSignature = "", ownAddresses = [], leads = () => [], orders = () => ({}),
  now = new Date(), log = () => {}, escalate = async () => {}, isTransient = () => false, readOnly = false, autoReply = false, sendGuard = NO_GUARD } = {}) {
  const res = { fetched: 0, new: 0, duplicates: 0, untrusted: 0, drafted: 0, sent: 0, review: 0, failed: 0, pending: 0, degraded: null, processed: [] };
  const canAuto = (it) => autoReply === true && it.verified === true && typeof gmail?.sendDraft === "function";
  if (cfg.enabled === false || !gmail || typeof gmail.searchInbound !== "function" || typeof gmail.readInbound !== "function") return res;
  const st = loadContactForms(store);
  const t = now.toISOString();
  let changed = false;
  const save = () => { if (!readOnly && changed) { store.write(CONTACT_FORMS_FILE, st); store.write(CONTACT_FORMS_PUBLIC_FILE, publicContactForms(st)); } };
  const setState = (it, state, extra = {}) => { Object.assign(it, { state, ...extra, updated_at: t }); changed = true; };
  const review = async (it, reason) => {
    res.review++;
    log("warn", "contact_form_review_required", { key: it.key, state: it.state, reason });
    try { await escalate({ messageId: it.message_id, threadId: it.thread_id, company: it.company || "", contactName: "", reason: `Kontaktformular: ${reason}` }); }
    catch (e) { log("error", "escalate_failed", { key: it.key, error: e.message }); }
  };
  // TF-077B: automatische Antwort genau EINMAL je Einsendung. Vor jedem Versuch: im Gesendet-Register? → SENT. Unklarer Versand (Absturz
  // zwischen Gmail und Register) oder Entwurf verschwunden → SEND_UNKNOWN (Prüfung, nie wiederholen). Dann Send-Lock cf-send:<key>, dann
  // gmail.sendDraft (Gmail verbraucht den Entwurf – eine zweite Mail ist ausgeschlossen). Fehler → nie SENT; vorübergehend → nächster Durchlauf.
  async function sendReply(it) {
    const lockKey = `cf-send:${it.key}`;
    try {
      const regNow = typeof gmail.listOwned === "function" ? gmail.listOwned() : { drafts: {}, sent: {} };
      const done = Object.entries(regNow.sent || {}).find(([, s]) => (it.draft_id && s.fromDraft === it.draft_id) || (s.contactFormKey && s.contactFormKey === it.key));
      if (done) { setState(it, STATES.SENT, { sent_at: done[1].sentAt || t, sent_message_id: done[0], reason: null }); save(); return; }
      if (regNow.sending?.[it.draft_id] || !regNow.drafts?.[it.draft_id]) { setState(it, STATES.SEND_UNKNOWN, { reason: "send_state_unclear" }); save(); await review(it, "Antwort-Versand unklar – nicht wiederholt"); return; }
      const lock = await sendGuard.acquire({ key: lockKey, threadId: it.draft_thread_id || null, messageId: it.message_id || null });
      if (!lock.ok) {
        if (lock.final) { setState(it, STATES.SEND_UNKNOWN, { reason: "send_lock_held" }); save(); await review(it, "Send-Lock gehalten bzw. bereits gesendet"); }
        else res.degraded ||= "send_lock_unreachable"; // Cloud nicht erreichbar: später, Reihenfolge bleibt
        return;
      }
      const info = await gmail.sendDraft(it.draft_id);
      setState(it, STATES.SENT, { sent_at: t, sent_message_id: info?.messageId || null, sent_thread_id: info?.threadId || null, reason: null });
      save();
      await sendGuard.done(lockKey, "SENT");
      res.sent++;
      log("info", "contact_form_reply_sent", { key: it.key, draftId: it.draft_id, language: it.language });
    } catch (e) {
      try { await sendGuard.done(lockKey, "FAILED"); } catch {}
      const transient = isTransient(e), attempts = (it.attempts || 0) + 1;
      if (transient) { setState(it, STATES.SENDING, { attempts: it.attempts || 0, reason: String(e.message).slice(0, 120) }); res.degraded ||= String(e.message).slice(0, 160); }
      else if (attempts >= MAX_ATTEMPTS) {
        // Antwort-Entwurf bleibt in Gmail (Chris kann ihn prüfen und senden) – Anfrage bleibt im CRM sichtbar (Prüfung).
        setState(it, STATES.DRAFTED, { attempts, reason: `auto_send_failed: ${String(e.message).slice(0, 100)}`, verification: VERIFICATION.REVIEW });
        res.failed++;
        await review(it, "Automatische Antwort nicht möglich – Entwurf liegt bereit");
      } else setState(it, STATES.SENDING, { attempts, reason: String(e.message).slice(0, 120) });
      save();
      log(transient ? "warn" : "error", "contact_form_send_failed", { key: it.key, attempts, error: String(e.message).slice(0, 160) });
    }
  }

  // 1) Absturz während „drafting“: liegt der Entwurf im Register → erledigt; sonst nach Ablauf unklar → nie wiederholen (Prüfung).
  const reg = typeof gmail.listOwned === "function" ? gmail.listOwned() : { drafts: {}, sent: {} };
  for (const it of Object.values(st.items)) {
    if (it.state !== STATES.DRAFTING) continue;
    const hit = Object.entries(reg.drafts || {}).find(([, d]) => d.contactFormKey === it.key);
    if (hit) setState(it, hit[1].mode === CONTACT_FORM_AUTO_REPLY_MODE ? STATES.SENDING : STATES.DRAFTED, { draft_id: hit[0], draft_message_id: hit[1].messageId || null, drafted_at: hit[1].createdAt || t });
    else if (+now - Date.parse(it.drafting_at || 0) > DRAFTING_STALE_MS) { setState(it, STATES.DRAFT_UNKNOWN, { reason: "crash_during_draft" }); await review(it, "Entwurf unklar (Absturz) – nicht wiederholt"); }
  }

  // 2) Neue Benachrichtigungen bekannter Anbieter holen (nur Allowlist-Suche, höchstens maxPerTick Volltexte je Durchlauf).
  const query = inboundQuery(cfg);
  if (query && !readOnly) {
    try {
      const ids = (await gmail.searchInbound({ query, max: Math.max(1, Math.min(100, Number(cfg.maxPerTick) || 20)) })) || [];
      for (const id of ids) {
        if (!id || st.seen[id]) continue;
        let msg;
        try { msg = await gmail.readInbound(id); }
        catch (e) {
          if (isTransient(e)) throw e;
          // Einzelne unlesbare Nachricht: einmal vermerken, nie erneut versuchen, die nächste wird gelesen.
          st.seen[id] = { at: t, result: "read_failed" }; changed = true;
          log("error", "contact_form_read_failed", { messageId: id, error: String(e.message).slice(0, 160) });
          continue;
        }
        res.fetched++;
        const c = classifyInbound(msg, { cfg, ownAddresses });
        if (!c.contactForm) {
          st.seen[id] = { at: t, result: c.reason };
          if (c.reason === "untrusted_sender") { res.untrusted++; log("warn", "contact_form_untrusted", { messageId: id, provider: c.provider }); }
          changed = true;
          continue;
        }
        const it = c.item;
        if (st.items[it.key]) { st.seen[id] = { at: t, result: "duplicate", key: it.key }; res.duplicates++; changed = true; log("info", "contact_form_duplicate", { key: it.key, messageId: id }); continue; }
        // Zuordnung + Sprache sofort (nur exakt), Kontext nie aus einem fremden Lead.
        if (it.state === STATES.NEW) {
          const m = matchInquiry({ item: it, text: `${msg.subject || ""}\n${c.inquiry.subject}\n${c.inquiry.message}`, leads: safe(leads, []), orders: safe(orders, {}) });
          const language = languageOf({ match: m, item: it, text: c.inquiry.message });
          Object.assign(it, { match_state: m.match_state, lead_id: m.lead_id, order_id: m.order_id, company: m.company || null, language,
            market: m.lead_id || m.order_id ? (m.market === "VN" ? "VN" : "CH") : language === "vi" ? "VN" : "CH" });
        }
        st.items[it.key] = { ...it, created_at: t, updated_at: t, attempts: 0 };
        st.seen[id] = { at: t, result: "contact_form", key: it.key };
        // Text nur flüchtig für den Entwurf in diesem Durchlauf; nie gespeichert.
        if (it.state === STATES.NEW) pendingInquiry.set(it.key, c.inquiry);
        changed = true;
        res.new++;
        if (it.state !== STATES.NEW) await review(st.items[it.key], it.reason || it.state);
      }
    } catch (e) {
      if (!isTransient(e)) log("error", "contact_form_fetch_failed", { error: String(e.message).slice(0, 160) });
      else { res.degraded = String(e.message).slice(0, 160); log("warn", "contact_form_fetch_degraded", { error: res.degraded }); }
    }
  }

  // 3) P0-Queue FIFO abarbeiten. Ein defektes Element blockiert nie das nächste.
  const queue = readOnly ? [] : orderMailQueue(Object.values(st.items).filter((it) => it.state === STATES.NEW));
  for (const it of queue) {
    try {
      let inquiry = pendingInquiry.get(it.key);
      if (!inquiry) {
        // Element aus einem früheren Durchlauf: Text erneut lesen (nur diese eine Benachrichtigung).
        const msg = await gmail.readInbound(it.message_id);
        inquiry = classifyInbound(msg, { cfg, ownAddresses }).inquiry || null;
      }
      if (!inquiry?.message) throw new Error("Anfrage nicht mehr lesbar");
      const vi = it.language === "vi";
      const auto = canAuto(it);
      const { subject, body } = composeReply({ lang: vi ? "vi" : "de", inquiry, sender, vnSignature, context: { order_id: it.order_id, callback: it.callback_requested === true, payment: paymentContextOf(it, safe(orders, {})) } });
      setState(it, STATES.DRAFTING, { drafting_at: t });
      save();
      const d = await gmail.createDraft({ to: it.customer_email, subject, body, mode: auto ? CONTACT_FORM_AUTO_REPLY_MODE : CONTACT_FORM_DRAFT_MODE, contactFormKey: it.key });
      setState(it, auto ? STATES.SENDING : STATES.DRAFTED, { draft_id: d.draftId, draft_message_id: d.messageId || null, draft_thread_id: d.threadId || null, drafted_at: t, reason: null, attempts: 0 });
      pendingInquiry.delete(it.key);
      save();
      res.drafted++;
      res.processed.push(it.key);
      log("info", "contact_form_drafted", { key: it.key, draftId: d.draftId, match: it.match_state, language: it.language, auto, verification: it.verification || null });
      if (auto) { await sendReply(it); if (res.degraded) break; }
    } catch (e) {
      const transient = isTransient(e);
      const attempts = (it.attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        setState(it, STATES.FAILED, { attempts, reason: String(e.message).slice(0, 120) });
        pendingInquiry.delete(it.key);
        res.failed++;
        await review(it, "Entwurf nicht möglich");
      } else setState(it, STATES.NEW, { attempts, reason: String(e.message).slice(0, 120) });
      save();
      log(transient ? "warn" : "error", "contact_form_draft_failed", { key: it.key, attempts, error: String(e.message).slice(0, 160) });
      if (transient) { res.degraded ||= String(e.message).slice(0, 160); break; } // Gmail gestört: Rest im nächsten Durchlauf (Reihenfolge bleibt)
    }
  }
  // 4) Antworten, deren Versand noch aussteht (Gmail gestört, Lock nicht erreichbar, Neustart) – ebenfalls FIFO, vor allem anderen.
  if (!readOnly) for (const it of orderMailQueue(Object.values(st.items).filter((x) => x.state === STATES.SENDING && !res.processed.includes(x.key)))) {
    if (res.degraded) break;
    await sendReply(it);
  }
  res.pending = Object.values(st.items).filter((it) => it.state === STATES.NEW || it.state === STATES.SENDING).length;
  // „seen“ nur so lange halten, wie die Suche zurückreicht (+ Reserve) – Elemente (items) bleiben dauerhaft (Dedupe je Submission).
  const keepMs = (Math.max(1, Math.min(60, Number(cfg.newerThanDays) || 14)) + 30) * 86_400_000;
  for (const [id, s] of Object.entries(st.seen)) if (+now - Date.parse(s?.at || 0) > keepMs) { delete st.seen[id]; changed = true; }
  save();
  return res;
}
// Formulartext eines frisch gelesenen Elements – nur im Speicher dieses Prozesses, nie auf Platte.
const pendingInquiry = new Map();
const safe = (fn, fb) => { try { return (typeof fn === "function" ? fn() : fn) || fb; } catch { return fb; } };
export const isReviewState = (s) => REVIEW_STATES.has(s);
