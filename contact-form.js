// TF-075A: Kontaktformular-Anfragen (CONTACT_FORM_INQUIRY) – höchste Mail-Priorität P0, Antwort ausschliesslich als Gmail-ENTWURF.
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
//   - Gespeichert (contact_forms.json): nur Metadaten (Anbieter, Formular, Zeit, IDs, Kundenadresse, Zuordnung, Status) – nie der Mailtext.
import crypto from "node:crypto";

export const CONTACT_FORM_CLASS = "CONTACT_FORM_INQUIRY";
export const CONTACT_FORM_DRAFT_MODE = "CONTACT_FORM_DRAFT_ONLY";
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
});
export const MATCH = Object.freeze({
  LEAD: "CONTACT_FORM_MATCHED_LEAD",
  ORDER: "CONTACT_FORM_MATCHED_ORDER",
  UNMATCHED: "CONTACT_FORM_UNMATCHED",
  REVIEW: "CONTACT_FORM_MATCH_REVIEW_REQUIRED",
});
const REVIEW_STATES = new Set([STATES.RECIPIENT_REVIEW, STATES.INVALID, STATES.UNKNOWN_FORM, STATES.FAILED, STATES.DRAFT_UNKNOWN]);

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
export function parseFormFields(body = "") {
  const fields = {};
  let last = null;
  for (const raw of String(body).replace(/\r/g, "").split("\n")) {
    const line = raw.replace(/^\s*[*•-]\s*/, "");
    const m = line.match(/^\s*([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ0-9 _./-]{0,40}?)\s*:\s*(.*)$/u);
    if (m && !/^https?$/i.test(m[1])) { last = lc(m[1]).replace(/[\s_.-]+/g, "_"); fields[last] = (fields[last] ? fields[last] + "\n" : "") + m[2].trim(); continue; }
    if (/^\s*https?:\/\/\S+\s*$/.test(line) && /submissions?\//i.test(line)) { last = null; continue; } // Anbieter-Link, kein Kundentext
    if (last && line.trim()) fields[last] += "\n" + line.trim();
    else if (!line.trim()) last = last && ["message", "nachricht", "anliegen", "comments", "comment", "noi_dung", "tin_nhan"].includes(last) ? last : null;
  }
  return fields;
}
const EMAIL_KEYS = ["email", "e_mail", "mail", "email_address", "e_mail_adresse", "emailadresse", "your_email", "ihre_e_mail", "dia_chi_email", "địa_chỉ_email"];
const NAME_KEYS = ["name", "full_name", "your_name", "ihr_name", "vorname_nachname", "ho_ten", "họ_tên", "họ_và_tên", "ten"];
const MSG_KEYS = ["message", "nachricht", "anliegen", "ihre_nachricht", "comments", "comment", "anfrage", "noi_dung", "nội_dung", "tin_nhan", "tin_nhắn"];
const SUBJECT_KEYS = ["subject", "betreff", "thema", "tieu_de", "tiêu_đề"];
const FORMNAME_KEYS = ["form_name", "form", "formular"];
const pick = (f, keys) => { for (const k of keys) if (typeof f[k] === "string" && f[k].trim()) return f[k].trim(); return ""; };

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
  const item = { ...base, form_market: form?.market === "VN" ? "VN" : form?.market === "CH" ? "CH" : null, form_lead_id: form?.lead_id || null, form_order_id: form?.order_id || null };
  if (!rec.ok) return { contactForm: true, item: { ...item, state: STATES.RECIPIENT_REVIEW, reason: rec.reason }, inquiry };
  return { contactForm: true, item: { ...item, state: STATES.NEW, customer_email: rec.email, recipient_source: rec.source }, inquiry };
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
export function composeReply({ lang = "de", inquiry = {}, sender = {}, vnSignature = "" }) {
  const name = String(inquiry.name || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 80);
  if (lang === "vi") {
    const subject = inquiry.subject ? `Re: ${inquiry.subject}` : "Phản hồi yêu cầu liên hệ của anh/chị";
    const body = [`Kính gửi ${name || "anh/chị"},`, "",
      "Cảm ơn anh/chị đã liên hệ với chúng tôi qua biểu mẫu trên website. Chúng tôi đã nhận được yêu cầu và sẽ phản hồi chi tiết trong thời gian sớm nhất.", "",
      "Nội dung anh/chị đã gửi:", quote(inquiry.message), "", vnSignature].join("\n");
    return { subject, body: body.normalize("NFC").trim() };
  }
  const subject = inquiry.subject ? `Re: ${inquiry.subject}` : "Ihre Anfrage über unser Kontaktformular";
  const signature = sender.signature?.trim() || [sender.name, sender.company, sender.email].filter(Boolean).join("\n");
  const body = [name ? `Guten Tag ${name}` : "Guten Tag", "",
    "Vielen Dank für Ihre Nachricht über unser Kontaktformular. Wir haben Ihre Anfrage erhalten und melden uns so rasch wie möglich ausführlich bei Ihnen.", "",
    "Ihre Nachricht:", quote(inquiry.message), "", "Freundliche Grüsse", ...(signature ? ["", signature] : [])].join("\n");
  return { subject, body: body.trim() };
}

// ---------- Ablage ----------
export const loadContactForms = (store) => { const s = store.read(CONTACT_FORMS_FILE, {}) || {}; return { v: 1, ...s, items: s.items || {}, seen: s.seen || {} }; };
export const STATUS_WORD = (state) => (state === STATES.DRAFTED ? "DRAFT_CREATED" : state === STATES.NEW || state === STATES.DRAFTING ? "NEW" : "REVIEW_REQUIRED");
// Öffentliche Sicht für CRM/Dashboard: nur zugeordnete Leads, nur Status-Wörter und Zeiten.
export function publicContactForms(st) {
  const leads = {};
  for (const it of Object.values(st.items || {}).sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)))) {
    if (!it.lead_id || ![MATCH.LEAD, MATCH.ORDER].includes(it.match_state)) continue;
    const prev = leads[it.lead_id];
    leads[it.lead_id] = { status: STATUS_WORD(it.state), matched: true, received_at: it.received_at, count: (prev?.count || 0) + 1 };
  }
  return { v: 1, leads };
}

// ---------- P0-Verarbeitung (ein Durchlauf) ----------
// gmail: { searchInbound({ query, max }) → [messageId], readInbound(messageId) → msg, createDraft({ to, subject, body, mode, contactFormKey }), listOwned() }
export async function processContactForms({ gmail, store, cfg = {}, sender = {}, vnSignature = "", ownAddresses = [], leads = () => [], orders = () => ({}),
  now = new Date(), log = () => {}, escalate = async () => {}, isTransient = () => false, readOnly = false } = {}) {
  const res = { fetched: 0, new: 0, duplicates: 0, untrusted: 0, drafted: 0, review: 0, failed: 0, pending: 0, degraded: null, processed: [] };
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

  // 1) Absturz während „drafting“: liegt der Entwurf im Register → erledigt; sonst nach Ablauf unklar → nie wiederholen (Prüfung).
  const reg = typeof gmail.listOwned === "function" ? gmail.listOwned() : { drafts: {}, sent: {} };
  for (const it of Object.values(st.items)) {
    if (it.state !== STATES.DRAFTING) continue;
    const hit = Object.entries(reg.drafts || {}).find(([, d]) => d.contactFormKey === it.key);
    if (hit) setState(it, STATES.DRAFTED, { draft_id: hit[0], draft_message_id: hit[1].messageId || null, drafted_at: hit[1].createdAt || t });
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
      const { subject, body } = composeReply({ lang: vi ? "vi" : "de", inquiry, sender, vnSignature });
      setState(it, STATES.DRAFTING, { drafting_at: t });
      save();
      const d = await gmail.createDraft({ to: it.customer_email, subject, body, mode: CONTACT_FORM_DRAFT_MODE, contactFormKey: it.key });
      setState(it, STATES.DRAFTED, { draft_id: d.draftId, draft_message_id: d.messageId || null, draft_thread_id: d.threadId || null, drafted_at: t, reason: null });
      pendingInquiry.delete(it.key);
      save();
      res.drafted++;
      res.processed.push(it.key);
      log("info", "contact_form_drafted", { key: it.key, draftId: d.draftId, match: it.match_state, language: it.language });
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
  res.pending = Object.values(st.items).filter((it) => it.state === STATES.NEW).length;
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
