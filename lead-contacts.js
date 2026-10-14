// TF-051 Lead-Kontaktverzeichnis – dauerhaft wachsende Liste aller eindeutig Jarvis-eigenen Cold Leads (COLD_LEAD_DRAFT_ONLY mit
// Gmail-Entwurf), angereichert um öffentlich publizierte GESCHÄFTS-Telefonnummer und Inhaber/Geschäftsführung.
//
// Authoritative Quelle: <JARVIS_CONTACTS_DIR>/lead_contact_directory.json (VPS: /opt/jarvis-mail/data). Exporte (CSV/PDF) atomar nach
// <JARVIS_EXPORTS_DIR> (VPS: /opt/jarvis-mail/exports). Läuft als eigener Dienst (Projekt jarvis-contacts) – der Mail-Worker wird nie
// berührt, die Entwurfserstellung hängt nie an der Anreicherung (kein Import dieses Moduls im Mail-/Discovery-Pfad).
//
// Harte Regeln: nur Register + Gmail-Mapping bestimmen, was ein Jarvis-Lead ist (nie Betreff/Text). Nur öffentliche Seiten der
// offiziellen Firmen-Domain (normale GET-Aufrufe, robots.txt respektiert, gedrosselt). Nichts raten: ohne eindeutigen Beleg bleiben
// Telefon bzw. Person null. Keine private Nummer (Label „privat“, ohne Geschäftskontext, Mobile neben Festnetz). Nie senden, nie
// Gmail ansprechen, nie Entwürfe ändern – Register und Gmail-Register werden nur gelesen.
//
//   node lead-contacts.js --backfill [--limit n]   Register abgleichen + alle offenen Leads anreichern (Checkpoint je Lead), dann Export
//   node lead-contacts.js --export                 CSV + PDF neu erzeugen
//   node lead-contacts.js --report                 Kennzahlen (keine personenbezogenen Daten)
//   node lead-contacts.js --service                Dauerbetrieb: Abgleich + Anreicherung neuer Leads + entprellter Export
//   node lead-contacts.js --healthcheck
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normDomain, normEmail } from "./lead-db.js";
import { UA } from "./site-auditor.js";

export const COLD_MODE = "COLD_LEAD_DRAFT_ONLY"; // = swiss-repair.js COLD_MODE (hier ohne den Vertriebs-Importbaum)
export const DIRECTORY_FILE = "lead_contact_directory.json";
export const DIRECTORY_SCHEMA = 1;
export const CSV_NAME = "Jarvis_Lead_Kontaktliste.csv";
export const PDF_NAME = "Jarvis_Lead_Kontaktliste.pdf";
export const DRAFT_STATUSES = Object.freeze(["DRAFT", "MANUALLY_SENT", "NO_LONGER_DRAFT", "SKIPPED"]);
export const DRAFT_STATUS_LABEL = Object.freeze({ DRAFT: "Entwurf", MANUALLY_SENT: "manuell gesendet", NO_LONGER_DRAFT: "kein Entwurf mehr", SKIPPED: "übersprungen" });
const REVIEW_STATUS = { draft_created: "DRAFT", manually_sent: "MANUALLY_SENT", sent: "MANUALLY_SENT", discarded: "NO_LONGER_DRAFT", blocked: "SKIPPED" };
export const PDF_MIN_INTERVAL_MS = 5 * 60_000;
export const REVERIFY_AFTER_MS = 90 * 86_400_000;
const RETRY_BACKOFF_MS = [3_600_000, 6 * 3_600_000, 24 * 3_600_000, 72 * 3_600_000];
export const MAX_ATTEMPTS = 5;

// ---------- 1) Welche Leads gehören eindeutig Jarvis? (Register + Gmail-Mapping, nie Betreff/Text) ----------
// reviews: individual_reviews.json → reviews; gmail: gmail_jarvis.json ({ drafts, sent }).
export function ownedColdLeads(reviews = {}, gmail = {}) {
  const sent = Object.values(gmail.sent || {});
  const out = [];
  for (const [id, r] of Object.entries(reviews || {})) {
    if (!r || r.draft_mode !== COLD_MODE || !r.gmail_draft_id) continue;
    const d = gmail.drafts?.[r.gmail_draft_id];
    const draftOwned = !!d && d.mode === COLD_MODE && d.leadId === id && !d.messageClass;
    const sentOwned = sent.some((s) => s?.fromDraft === r.gmail_draft_id && s.mode === COLD_MODE && (!s.leadId || s.leadId === id));
    if (!draftOwned && !sentOwned) continue;
    let draft_status = REVIEW_STATUS[r.status] || "SKIPPED";
    if (sentOwned || r.manual_send_detected) draft_status = "MANUALLY_SENT";
    else if (draft_status === "DRAFT" && !draftOwned) draft_status = "NO_LONGER_DRAFT";
    out.push({ lead_id: id, company: r.company || null, domain: normDomain(r.domain || "") || null, email: normEmail(r.recipient || r.business_email || "") || null,
      draft_status, gmail_draft_id: r.gmail_draft_id, draft_created_at: r.draft_created_at || r.created_at || null });
  }
  return out;
}

// ---------- 2) Verzeichnis (Upsert ohne Duplikate) ----------
export function emptyDirectory(now = new Date()) {
  return { schema: DIRECTORY_SCHEMA, created_at: now.toISOString(), updated_at: now.toISOString(), leads: {}, meta: { exports: {} } };
}
export function loadDirectory(dir) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, DIRECTORY_FILE), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error(`${DIRECTORY_FILE} nicht lesbar – fail closed (${e.message})`); }
  if (d && d.schema > DIRECTORY_SCHEMA) throw new Error(`${DIRECTORY_FILE} hat Schema ${d.schema}, dieser Code kennt nur ${DIRECTORY_SCHEMA} – fail closed.`);
  d = d || emptyDirectory();
  d.leads ||= {}; d.meta ||= {}; d.meta.exports ||= {};
  return d;
}
export function saveDirectory(dir, d, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  d.updated_at = now.toISOString();
  writeAtomic(path.join(dir, DIRECTORY_FILE), JSON.stringify(d, null, 1));
}
export function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

const emptyEntry = (inc, t) => ({
  lead_id: inc.lead_id, company_name: null, domain: null, email: null,
  phone: null, phone_normalized: null, phone_original: null, phone_source_url: null, phone_confidence: null,
  first_name: null, last_name: null, role: null, person_source_url: null, person_confidence: null, people: [],
  draft_status: null, gmail_draft_id: null, first_seen_at: t, last_seen_at: t, contact_enriched_at: null, sources: [],
  enrichment: { status: "pending", attempts: 0, last_attempt_at: null, next_retry_at: null, last_error: null },
});
// Schlüssel: bestehende Jarvis-Lead-ID; Fallback normalisierte Domain + normalisierte Adresse.
export function findEntryKey(d, inc) {
  if (inc.lead_id && d.leads[inc.lead_id]) return inc.lead_id;
  const dom = normDomain(inc.domain || ""), em = normEmail(inc.email || "");
  if (!dom && !em) return null;
  for (const [k, e] of Object.entries(d.leads)) if ((e.domain || "") === dom && (e.email || "") === em) return k;
  return null;
}
// Register-Stand übernehmen. Gibt { created, updated, missing } zurück. Nie löschen: nicht mehr geführte Leads → NO_LONGER_DRAFT.
export function syncDirectory(d, owned = [], now = new Date()) {
  const t = now.toISOString();
  let created = 0, updated = 0, missing = 0;
  const seen = new Set();
  for (const inc of owned) {
    const key = findEntryKey(d, inc) || inc.lead_id;
    if (!key) continue;
    seen.add(key);
    const cur = d.leads[key];
    const e = cur ? structuredClone(cur) : emptyEntry({ ...inc, lead_id: key }, t);
    if (!cur) created++;
    e.company_name = inc.company || e.company_name;
    e.domain = inc.domain || e.domain;
    e.email = inc.email || e.email;
    e.draft_status = DRAFT_STATUSES.includes(inc.draft_status) ? inc.draft_status : e.draft_status;
    e.gmail_draft_id = inc.gmail_draft_id || e.gmail_draft_id;
    e.last_seen_at = t;
    if (cur && JSON.stringify({ ...cur, last_seen_at: null }) !== JSON.stringify({ ...e, last_seen_at: null })) updated++;
    d.leads[key] = e;
  }
  // Leeres Register bei bestehendem Verzeichnis = eher Lese-/Mount-Problem als „alles weg“ → nichts umstufen.
  if (owned.length) for (const [k, e] of Object.entries(d.leads)) {
    if (seen.has(k) || e.draft_status === "NO_LONGER_DRAFT" || e.draft_status === "MANUALLY_SENT") continue;
    e.draft_status = "NO_LONGER_DRAFT"; missing++;
  }
  return { created, updated, missing, total: Object.keys(d.leads).length };
}

// ---------- 3) Telefonnummern ----------
// Nur Schweizer Nummern (+41 / 0041 / 0…, 10 Stellen national). Mehrwertnummern (090x) und Kurznummern nie.
export function normalizeSwissPhone(raw = "") {
  const s = String(raw).replace(/\(0\)/g, "").replace(/[^\d+]/g, "");
  let nat = null;
  if (/^\+41\d{9}$/.test(s)) nat = "0" + s.slice(3);
  else if (/^0041\d{9}$/.test(s)) nat = "0" + s.slice(4);
  else if (/^0[1-9]\d{8}$/.test(s)) nat = s;
  if (!nat) return null;
  const kind = /^07[5-9]/.test(nat) ? "mobile" : /^08(00|4[0248])/.test(nat) ? "service" : /^0(2[1-7]|3[1-4]|4[1-4]|5[2-8]|6[12]|71|81|91)/.test(nat) ? "landline" : null;
  if (!kind) return null;
  const d = nat.slice(1);
  const normalized = kind === "service" ? `+41 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : `+41 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
  return { normalized, national: nat, kind };
}
const PHONE_LABEL = /(?:^|[\s(|•·,;:/])(tel(?:efon|ephone|éphone|efono)?|phone|fon|t|mobile?|mobil|natel|handy|zentrale|büro|office|geschäft|tél|cell)\.?\s*[:.]?\s*$/i;
const FAX = /(?:tele)?fax\.?\s*[:.]?\s*$/i;
const PRIVATE = /\b(privat|private|privé|privee|privato|abends|wochenende|notfall(?:nummer)?)\b/i;
// Bereich Webdesign/Hosting-Nachweis im Impressum: Nummern/Personen dort gehören zur Agentur, nicht zum Lead.
const CREDIT = /\b(web-?design|website|webseite|homepage|realisation|realisierung|umsetzung|programmierung|gestaltung|design|hosting|bildnachweis|fotos?|bilder|konzept)\b[^\n]{0,25}?\b(by|von|durch)\b|\b(web-?design|realisation|realisierung|umsetzung|programmierung|gestaltung|hosting|bildnachweis|fotos?|bilder|konzept|webagentur|internetagentur)\s*:|powered by/i;
const creditBefore = (prev = "") => CREDIT.test(String(prev).split("\n").slice(-3).join("\n"));
const PHONE_TEXT = /(?:\+|00)\s?41[\s.\-/]*(?:\(0\)[\s.\-/]*)?\d{2,3}(?:[\s.\-/]*\d){6,7}|\b0\d{2,3}(?:[\s.\-/]*\d){6,7}/g;

// HTML → Text mit Zeilenumbrüchen an Blockgrenzen (für Kontext-/Labelprüfung).
const ENT = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", acirc: "â", ocirc: "ô", icirc: "î", euml: "ë", iuml: "ï", Eacute: "É", rsquo: "’", lsquo: "‘", middot: "·", bull: "•", shy: "" };
export const decodeEntities = (s = "") => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? (() => { try { return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)); } catch { return m; } })() : ENT[e] ?? ENT[e.toLowerCase()] ?? m);
export function htmlToText(html = "") {
  return decodeEntities(String(html).replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|header|footer|address|dt|dd|ul|ol|table|nav|aside)>|<(p|div|li|tr|h[1-6]|section|article|footer|address|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ").replace(/<[^>]+>/g, " "))
    .replace(/[ \t   ]+/g, " ").replace(/ *\n[ \n]*/g, "\n").trim();
}
const lineAround = (text, idx, len) => {
  const start = text.lastIndexOf("\n", idx - 1) + 1, end = text.indexOf("\n", idx + len);
  return { before: text.slice(start, idx), after: text.slice(idx + len, end < 0 ? undefined : end), prevText: text.slice(Math.max(0, idx - 220), idx) };
};
// Kandidaten einer Seite. kind: impressum|kontakt|team|about|home|other. JSON-LD "telephone" und tel:-Links gelten als publizierte Kontaktnummer.
// Kandidat: { normalized, national, kind (landline|mobile|service), raw, via (jsonld|tel_link|label|line), url, page, rejected? }
export function extractPhones(html = "", { url = null, kind: page = "other" } = {}) {
  const out = [];
  // before/after: Text derselben Zeile (Label „Privat“ gilt nur für die eigene Zeile), prev: vorangehender Kontext (Agentur-Nachweis).
  const push = (raw, via, prev = "", after = "", before = "") => {
    const n = normalizeSwissPhone(raw);
    if (!n) return;
    const c = { ...n, raw: String(raw).replace(/\s+/g, " ").trim(), via, url, page };
    if (PRIVATE.test(before.slice(-40) + " " + after.slice(0, 40))) return out.push({ ...c, rejected: "private" });
    if (creditBefore(prev)) return out.push({ ...c, rejected: "credit" });
    out.push(c);
  };
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of m[1].matchAll(/"telephone"\s*:\s*"([^"]{6,40})"/gi)) push(decodeEntities(t[1]), "jsonld");
  }
  const text = htmlToText(html);
  for (const m of String(html).matchAll(/<a\b[^>]*href\s*=\s*["']tel:([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let raw; try { raw = decodeURIComponent(m[1]); } catch { raw = m[1]; }
    const label = htmlToText(m[2]);
    if (/fax/i.test(label)) continue;
    // Kontext: Textstelle des Links im Seitentext (falls auffindbar), sonst nur der Linktext.
    const pos = label ? text.indexOf(label) : -1;
    const around = pos >= 0 ? lineAround(text, pos, label.length) : { prevText: "", after: "", before: label };
    if (FAX.test(around.before.slice(-12))) continue;
    push(raw, "tel_link", around.prevText, around.after, around.before + " " + label);
  }
  for (const m of text.matchAll(PHONE_TEXT)) {
    const { before, after, prevText } = lineAround(text, m.index, m[0].length);
    const near = before.slice(-28);
    if (FAX.test(near)) continue;
    const labeled = PHONE_LABEL.test(near);
    if (!labeled && PRIVATE.test(near)) { push(m[0], "line", prevText, after, near); continue; } // „Privat: 079 …“ → als privat gemerkt
    // Ohne Label nur auf Impressum/Kontakt und nur als eigene Zeile (keine UID/IBAN/Fliesstext-Ziffern).
    if (!labeled && (!["impressum", "kontakt"].includes(page) || before.trim() || after.trim())) continue;
    push(m[0], labeled ? "label" : "line", prevText, after, before);
  }
  return out;
}
const PAGE_WEIGHT = { impressum: 3, kontakt: 3, home: 2, about: 1, team: 1, other: 1 };
const VIA_WEIGHT = { jsonld: 3, tel_link: 3, label: 2, line: 1 };
// Beste Geschäftsnummer über alle Seiten. Mobile nur, wenn KEINE Festnetz-/Servicenummer publiziert ist (zentrale Nummer eines
// Einzelunternehmens) und sie auf Impressum/Kontakt/Startseite beschriftet oder als tel:-Link steht – dann höchstens „medium“.
export function choosePhone(cands = []) {
  const privates = new Set(cands.filter((c) => c.rejected === "private").map((c) => c.normalized));
  const byNum = new Map();
  for (const c of cands) {
    if (c.rejected || privates.has(c.normalized)) continue; // irgendwo als privat bezeichnet → nie
    const w = PAGE_WEIGHT[c.page] * VIA_WEIGHT[c.via];
    const cur = byNum.get(c.normalized) || { normalized: c.normalized, kind: c.kind, score: 0, pages: new Set(), best: c };
    cur.score += w;
    cur.pages.add(c.url);
    if (w > PAGE_WEIGHT[cur.best.page] * VIA_WEIGHT[cur.best.via]) cur.best = c;
    byNum.set(c.normalized, cur);
  }
  let list = [...byNum.values()];
  const fixed = list.filter((c) => c.kind !== "mobile");
  list = fixed.length ? fixed : list.filter((c) => ["impressum", "kontakt", "home"].includes(c.best.page) && c.best.via !== "line");
  if (!list.length) return null;
  list.sort((a, b) => b.score - a.score || b.pages.size - a.pages.size);
  const top = list[0];
  const strong = ["jsonld", "tel_link", "label"].includes(top.best.via) && ["impressum", "kontakt", "home"].includes(top.best.page);
  const confidence = top.kind === "mobile" ? "medium" : strong || top.pages.size >= 2 ? "high" : "medium";
  return { phone: top.normalized, phone_normalized: top.normalized, phone_original: top.best.raw, phone_source_url: top.best.url, phone_confidence: confidence, kind: top.kind };
}

// ---------- 4) Inhaber / Geschäftsführung ----------
// rank 1 Inhaber · 2 Geschäftsführer · 3 Geschäftsleiter · 4 Managing Director/CEO. „Mitglied der …“, „Stv.“, „Assistent“ etc. nie.
const ROLE_DEFS = [
  [1, /\b(inhaber(?:in)?|firmeninhaber(?:in)?|geschäftsinhaber(?:in)?|owner|propriétaire|titolare)\b/i],
  [2, /\b(geschäftsführer(?:in)?|geschäftsführende[rn]? (?:inhaber(?:in)?|gesellschafter(?:in)?|partner(?:in)?)|geschäftsführung|gérant(?:e)?|directeur général|directrice générale|amministratore unico|direttore generale)\b/i],
  [3, /\b(geschäftsleiter(?:in)?|geschäftsleitung|betriebsleiter(?:in)?|direttore|directeur|directrice)\b/i],
  [4, /\b(managing director|ceo|chief executive officer)\b/i],
];
// Für Muster mit Namen (case-sensitiv, damit „Grossbuchstabe = Name“ gilt): Rollenwörter mit beiden Schreibweisen je Buchstabe.
const ROLE_WORDS = ["geschäftsführende inhaberin", "geschäftsführender inhaber", "geschäftsführende gesellschafterin", "geschäftsführender gesellschafter",
  "firmeninhaberin", "firmeninhaber", "geschäftsinhaberin", "geschäftsinhaber", "inhaberin", "inhaber", "owner", "propriétaire", "titolare",
  "geschäftsführerin", "geschäftsführer", "geschäftsführung", "gérante", "gérant", "directrice générale", "directeur général", "amministratore unico", "direttore generale",
  "geschäftsleiterin", "geschäftsleiter", "geschäftsleitung", "betriebsleiterin", "betriebsleiter", "managing director", "chief executive officer", "ceo"];
const ci = (w) => w.replace(/[a-zäöüéè]/g, (c) => `[${c}${c.toUpperCase()}]`).replace(/ /g, "\\s+");
const ROLE_CI = `(?:${ROLE_WORDS.map(ci).join("|")})`;
const ROLE_ANY = new RegExp(ROLE_DEFS.map(([, r]) => r.source).join("|"), "i");
const ROLE_EXCLUDE = /\b(mitglied|stv\.?|stellvertret\w*|assistent\w*|assistant|sekretariat|vorsitz(?:ende)?|präsident\w*|verwaltungsrat\w*|ehemalige\w*|ex-|früher\w*|nachfolger\w*|gründer(?:in)?)\b/i;
export const ROLE_LABEL = { 1: "Inhaber", 2: "Geschäftsführer", 3: "Geschäftsleiter", 4: "Managing Director/CEO" };
const FEMALE = /(inhaberin|geschäftsführerin|geschäftsleiterin|gérante|directrice|betriebsleiterin|firmeninhaberin|geschäftsinhaberin)/i;
export function roleOf(text = "") {
  if (!text || ROLE_EXCLUDE.test(text)) return null;
  for (const [rank, re] of ROLE_DEFS) { const m = text.match(re); if (m) return { rank, label: FEMALE.test(m[0]) ? { 1: "Inhaberin", 2: "Geschäftsführerin", 3: "Geschäftsleiterin" }[rank] : ROLE_LABEL[rank], raw: m[0] }; }
  return null;
}
const NAME_TOKEN = "[A-ZÄÖÜÉÈÀÂÇ][a-zäöüéèàâçëïôûêîß'’]+(?:-[A-ZÄÖÜÉÈ][a-zäöüéèàâçëïôûêîß'’]+)?(?![\\wÄÖÜÉÈÀÂÇäöüéèàâçëïôûêîß])";
const PARTICLE = "(?:von|van|de|di|da|del|della|dal|le|la|du|des|zu|von der|van der|de la)";
const NAME_RE_SRC = `(${NAME_TOKEN}(?:\\s+${NAME_TOKEN})?(?:\\s+${PARTICLE})?\\s+${NAME_TOKEN})`;
const HONORIFIC = "(?:(?:Herr|Frau|Hr\\.|Fr\\.|Dr\\.(?:\\s?med\\.)?|Prof\\.|lic\\.\\s?\\w+\\.?|dipl\\.\\s?[\\wäöü.-]+|M\\.\\s?A\\.|MSc|BSc|MBA)\\s+)*";
// Wörter, die nie Teil eines Personennamens sind (Firmen-, Orts-, Seiten- und Rechtsbegriffe).
const NOT_NAME = new Set(("gmbh ag sa sàrl sarl sagl klg kg ltd inc co und et the für fur der die das den dem des telefon tel fax mobile email e-mail adresse kontakt impressum " +
  "team firma unternehmen webdesign design gestaltung datenschutz haftung inhalt inhalte copyright verantwortlich verantwortliche mitglied geschäftsführer geschäftsführerin " +
  "geschäftsführung geschäftsleitung geschäftsleiter inhaber inhaberin owner ceo managing director handelsregister mwst uid nummer schweiz suisse svizzera switzerland " +
  "bern zürich zurich basel luzern genève geneve lausanne st gallen postfach strasse weg platz gasse muster mustermann musterfrau beispiel lorem ipsum über uns ueber " +
  "home startseite angebot angebote leistungen dienstleistungen öffnungszeiten montag dienstag mittwoch donnerstag freitag samstag sonntag sitz rechtsform " +
  "aktiengesellschaft genossenschaft einzelunternehmen einzelfirma verein stiftung praxis atelier studio salon restaurant hotel garage " +
  "gemeinde kanton stadt bank konto iban partner partnerin mitarbeiter mitarbeitende kunden news blog jobs").split(" "));
const PARTICLE_RE = new RegExp(`^${PARTICLE}$`);
const LEGAL_SUFFIX = /^\s*(?:&\s*\w+\s*)?(gmbh|ag|sa|s[àa]rl|sagl|klg|kg|ltd|inc|holding|group|gruppe|&\s*co|und\s*co|partner)\b/i;
export function validName(name = "", company = "") {
  const toks = String(name).trim().split(/\s+/);
  const core = toks.filter((t) => !PARTICLE_RE.test(t));
  if (core.length < 2 || core.length > 3) return false;
  for (const t of core) {
    const low = t.toLowerCase().replace(/[’']/g, "");
    if (t.length < 2 || NOT_NAME.has(low) || /(strasse|gasse|platz)$/.test(low)) return false;
  }
  const n = core.join(" ").toLowerCase(), c = String(company || "").toLowerCase().replace(/\b(gmbh|ag|sa|sàrl|sarl|sagl|klg|kg)\b/g, "").replace(/\s+/g, " ").trim();
  return !(c && n === c);
}
const B = "(?<![A-Za-zÄÖÜäöüéèàç])", E = "(?![A-Za-zÄÖÜäöüéèàç])";
// Personen mit ausdrücklicher Rolle auf EINER Seite: „Rolle: Name“, „Name, Rolle“ (gleiche Zeile) oder Rolle/Name auf direkt
// benachbarten Zeilen ohne weiteren Text. Nie Namen ohne Rolle, nie aus dem Webdesign-/Hosting-Nachweis, nie Firmennamen.
export function extractPeople(html = "", { url = null, kind: page = "other", company = "" } = {}) {
  const text = htmlToText(html);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  const add = (name, roleText, prev, after = "") => {
    const role = roleOf(roleText);
    if (!role) return;
    const clean = name.replace(new RegExp(`^${HONORIFIC}`), "").replace(/\s+/g, " ").trim();
    if (!validName(clean, company) || LEGAL_SUFFIX.test(after) || creditBefore(prev)) return;
    const toks = clean.split(" ");
    const pIdx = toks.findIndex((t, i) => i > 0 && PARTICLE_RE.test(t));
    const split = pIdx > 0 ? pIdx : toks.length - 1; // zweiter Vorname bleibt beim Vornamen, Namenspartikel beim Nachnamen
    out.push({ first_name: toks.slice(0, split).join(" "), last_name: toks.slice(split).join(" "), role: role.label, rank: role.rank, url, page });
  };
  const ROLE_CHAIN = `${B}(${ROLE_CI}(?:\\s*\\([Ii]n\\))?(?:\\s*(?:und|&|/|,)\\s*${ROLE_CI}(?:\\s*\\([Ii]n\\))?)?)${E}`;
  const roleThenName = new RegExp(`${ROLE_CHAIN}\\s*(?:[:\\-–—|]\\s*)?${HONORIFIC}${NAME_RE_SRC}`, "g");
  const nameThenRole = new RegExp(`${HONORIFIC}${NAME_RE_SRC}\\s*(?:,|–|—|-|\\||\\(|:)\\s*(?:[\\wäöüéÄÖÜ.]+(?:\\s+|\\s*/\\s*)){0,3}?${ROLE_CHAIN}`, "g");
  const nameOnly = new RegExp(`^${HONORIFIC}${NAME_RE_SRC}$`);
  const roleOnly = (s) => s.length <= 60 && !!roleOf(s) && s.replace(new RegExp(ROLE_CI, "g"), "").replace(/[\s,:&/()|·•–-]|und|\b[Ii]n\b/g, "").length <= 3;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines.slice(Math.max(0, i - 3), i).join("\n") + "\n";
    if (line.length > 220) continue; // Fliesstext: zu unsicher
    let hit = false;
    for (const m of line.matchAll(roleThenName)) {
      if (ROLE_EXCLUDE.test(line.slice(Math.max(0, m.index - 30), m.index + m[1].length))) continue;
      add(m[2], m[1], prev + line.slice(0, m.index), line.slice(m.index + m[0].length)); hit = true;
    }
    if (!hit) for (const m of line.matchAll(nameThenRole)) {
      if (ROLE_EXCLUDE.test(line.slice(m.index + m[1].length, m.index + m[0].length + 25))) continue;
      add(m[1], m[2], prev + line.slice(0, m.index), line.slice(m.index + m[1].length)); hit = true;
    }
    if (hit) continue;
    // Zeilenpaar: „Max Muster“ / „Geschäftsführer“ bzw. Rollen-Überschrift gefolgt von Namenszeilen (alle übernommen – mehr als
    // zwei Personen auf dem höchsten Rang machen die Zuordnung in choosePeople mehrdeutig → niemand).
    const next = lines[i + 1];
    if (!next || ROLE_EXCLUDE.test(line + " " + next)) continue;
    if (nameOnly.test(line) && roleOnly(next)) { add(line.match(nameOnly)[1], next, prev); i++; continue; } // Rollenzeile verbraucht
    // Namenszeile, auf die selbst eine Rollenzeile folgt, gehört zu DIESER Rolle (Kartenlayout Name/Rolle/Name/Rolle).
    if (roleOnly(line)) for (let j = i + 1; j < Math.min(lines.length, i + 5) && nameOnly.test(lines[j]) && !roleOnly(lines[j + 1] || ""); j++) add(lines[j].match(nameOnly)[1], line, prev + line, lines[j + 1] || "");
  }
  return out;
}
// Primäre Person (höchste operative Verantwortung). Mehrdeutig (mehr als 2 verschiedene Personen auf dem höchsten Rang) → niemand.
// Höchstens 2 Personen intern (gemeinsam geführt), Export nur die erste.
export function choosePeople(cands = []) {
  if (!cands.length) return { people: [], ambiguous: false };
  const best = Math.min(...cands.map((c) => c.rank));
  const top = new Map();
  for (const c of cands.filter((x) => x.rank === best)) {
    const k = `${c.first_name} ${c.last_name}`.toLowerCase();
    const cur = top.get(k);
    if (!cur) top.set(k, { ...c, pages: new Set([c.url]), kinds: new Set([c.page]) });
    else { cur.pages.add(c.url); cur.kinds.add(c.page); }
  }
  if (top.size > 2) return { people: [], ambiguous: true };
  const list = [...top.values()].sort((a, b) => b.pages.size - a.pages.size);
  return {
    ambiguous: false,
    people: list.map((p) => ({ first_name: p.first_name, last_name: p.last_name, role: p.role, source_url: p.url,
      confidence: p.kinds.has("impressum") || p.kinds.has("team") || p.kinds.has("about") || p.pages.size >= 2 ? "high" : "medium" })),
  };
}

// ---------- 5) Recherche auf der offiziellen Website (höflich, gecacht, mit Backoff) ----------
const PAGE_LINK = [
  ["impressum", /impressum|imprint|mentions[-_ ]?l[ée]gales|legal[-_ ]?notice|colophon|note[-_ ]?legali|rechtliche/i],
  ["kontakt", /kontakt|contact|contatt|anfahrt|standort/i],
  ["team", /\bteam\b|unser[-_ ]?team|mitarbeit|equipe|équipe|personen|wir[-_ ]?sind/i],
  ["about", /[uü]ber[-_ ]?uns|ueber[-_ ]?uns|about|portr[aä]i?t|unternehmen|firma|geschichte|a[-_ ]?propos|qui[-_ ]?sommes|chi[-_ ]?siamo/i],
];
const sameSite = (host, domain) => { const h = String(host).toLowerCase().replace(/^www\./, ""); return h === domain || h.endsWith("." + domain); };
function robotsAllows(txt = "", pathname = "/") {
  let applies = false, rules = [];
  const groups = [];
  for (const raw of String(txt).split(/\r?\n/)) {
    const l = raw.replace(/#.*/, "").trim(); if (!l) continue;
    const [k, ...v] = l.split(":"); const key = k.trim().toLowerCase(), val = v.join(":").trim();
    if (key === "user-agent") { if (rules.length || !groups.length) groups.push({ agents: [], rules: (rules = []) }); groups.at(-1).agents.push(val.toLowerCase()); }
    else if ((key === "disallow" || key === "allow") && groups.length) rules.push([key, val]);
  }
  const g = groups.find((x) => x.agents.some((a) => a.includes("jarvissitecheck"))) || groups.find((x) => x.agents.includes("*"));
  if (!g) return true;
  let best = null;
  for (const [k, v] of g.rules) if (v && pathname.startsWith(v) && (!best || v.length > best[1].length || (v.length === best[1].length && k === "allow"))) best = [k, v];
  applies = best ? best[0] === "disallow" : false;
  return !applies;
}
export function createResearcher({ fetchFn = globalThis.fetch, timeoutMs = 15_000, gapMs = 1500, retries = 2, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPages = 6 } = {}) {
  const domainCache = new Map();
  let requests = 0;
  async function research(lead, { origin = null } = {}) {
    const domain = normDomain(lead.domain || "");
    if (!domain) return { ok: false, error: "no_domain" };
    if (domainCache.has(domain)) return domainCache.get(domain);
    const p = run(domain, lead, origin).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 80) }));
    domainCache.set(domain, p);
    return p;
  }
  async function run(domain, lead, origin) {
    let last = 0;
    const errors = [];
    async function get(url, { text = true } = {}) {
      for (let attempt = 0; ; attempt++) {
        const wait = last + gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        last = Date.now(); requests++;
        try {
          const r = await fetchFn(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "de-CH,de;q=0.9,fr;q=0.7,it;q=0.6,en;q=0.5" } });
          if ((r.status === 429 || r.status >= 500) && attempt < retries) {
            await r.body?.cancel?.().catch(() => {});
            const ra = Number(r.headers.get("retry-after")); await sleep(Math.min(30_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 3 ** attempt)); continue;
          }
          const type = r.headers.get("content-type") || "";
          const body = text && r.ok && /html|text\/plain/i.test(type) ? (await r.text()).slice(0, 1_500_000) : "";
          if (!body) await r.body?.cancel?.().catch(() => {});
          return { status: r.status, url: r.url || url, html: body };
        } catch (e) {
          const code = e?.cause?.code || (e?.name === "TimeoutError" || e?.name === "AbortError" ? "TIMEOUT" : e?.code || "NETWORK");
          if (attempt < retries) { await sleep(2000 * 3 ** attempt); continue; }
          return { error: code, url };
        }
      }
    }
    const bases = origin ? [origin] : [`https://${domain}`, `https://www.${domain}`, `http://${domain}`];
    let home = null, base = null;
    for (const b of bases) {
      const r = await get(b + "/");
      if (r.html && r.status < 400) {
        let host; try { host = new URL(r.url).host; } catch { host = ""; }
        if (origin || sameSite(host.split(":")[0], domain)) { home = r; base = new URL(r.url).origin; break; }
        errors.push("redirect_offsite");
        break;
      }
      errors.push(r.error || `http_${r.status}`);
    }
    if (!home) return { ok: false, error: errors.at(-1) || "unreachable", errors };
    const robots = await get(base + "/robots.txt");
    const robotsTxt = robots.status === 200 && /disallow|allow|user-agent/i.test(robots.html) ? robots.html : "";
    const pages = [{ kind: "home", url: home.url, html: home.html }];
    // Links zu Impressum/Kontakt/Team/Über uns auf derselben Website.
    const found = new Map();
    for (const m of home.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      let u; try { u = new URL(decodeEntities(m[1]), home.url); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || !(origin ? u.origin === base : sameSite(u.hostname, domain))) continue;
      if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(u.pathname)) continue;
      const label = htmlToText(m[2]).slice(0, 60) + " " + u.pathname;
      for (const [kind, re] of PAGE_LINK) if (re.test(label) && !found.has(kind)) { found.set(kind, u.href.split("#")[0]); break; }
    }
    if (!found.has("impressum")) found.set("impressum", base + "/impressum");
    if (!found.has("kontakt")) found.set("kontakt", base + "/kontakt");
    const fetched = new Set([home.url]);
    for (const [kind, url] of [...found.entries()].slice(0, maxPages - 1)) {
      if (fetched.has(url)) continue;
      fetched.add(url);
      if (robotsTxt && !robotsAllows(robotsTxt, new URL(url).pathname)) { errors.push("robots"); continue; }
      const r = await get(url);
      if (r.html && r.status < 400) pages.push({ kind, url: r.url, html: r.html });
    }
    const phones = pages.flatMap((p) => extractPhones(p.html, { url: p.url, kind: p.kind }));
    const people = pages.flatMap((p) => extractPeople(p.html, { url: p.url, kind: p.kind, company: lead.company }));
    const phone = choosePhone(phones);
    const pc = choosePeople(people);
    const fetchedAt = new Date().toISOString();
    const sources = pages.map((p) => ({ url: p.url, kind: p.kind, fetched_at: fetchedAt,
      used_for: [phone && p.url === phone.phone_source_url ? "phone" : null, pc.people.some((x) => x.source_url === p.url) ? "person" : null].filter(Boolean) }));
    return { ok: true, phone, people: pc.people, ambiguous_people: pc.ambiguous, rejected_private: phones.filter((c) => c.rejected === "private").length, sources, errors, pages: pages.length };
  }
  return { research, stats: () => ({ requests, domains: domainCache.size }) };
}

// Ergebnis in den Eintrag übernehmen (Checkpoint: Status je Lead). Erfolgreich, aber nichts gefunden → Felder null, Lead bleibt.
export function applyEnrichment(e, res, now = new Date()) {
  const t = now.toISOString();
  e.enrichment ||= { status: "pending", attempts: 0 };
  e.enrichment.attempts = (e.enrichment.attempts || 0) + 1;
  e.enrichment.last_attempt_at = t;
  if (!res?.ok) {
    e.enrichment.status = "failed";
    e.enrichment.last_error = String(res?.error || "unknown").slice(0, 80);
    e.enrichment.next_retry_at = new Date(now.getTime() + RETRY_BACKOFF_MS[Math.min(e.enrichment.attempts - 1, RETRY_BACKOFF_MS.length - 1)]).toISOString();
    return e;
  }
  const p = res.phone;
  Object.assign(e, p ? { phone: p.phone, phone_normalized: p.phone_normalized, phone_original: p.phone_original, phone_source_url: p.phone_source_url, phone_confidence: p.phone_confidence }
    : { phone: null, phone_normalized: null, phone_original: null, phone_source_url: null, phone_confidence: null });
  const people = (res.people || []).slice(0, 2);
  const first = people[0];
  Object.assign(e, first ? { first_name: first.first_name, last_name: first.last_name, role: first.role, person_source_url: first.source_url, person_confidence: first.confidence }
    : { first_name: null, last_name: null, role: null, person_source_url: null, person_confidence: null });
  e.people = people;
  e.sources = (res.sources || []).slice(0, 8);
  e.contact_enriched_at = t;
  e.enrichment = { status: "done", attempts: e.enrichment.attempts, last_attempt_at: t, next_retry_at: new Date(now.getTime() + REVERIFY_AFTER_MS).toISOString(), last_error: null,
    ...(res.ambiguous_people ? { note: "person_ambiguous" } : {}) };
  return e;
}
export function dueForEnrichment(e, now = new Date()) {
  const en = e.enrichment || {};
  if (!e.domain) return false;
  if (!en.status || en.status === "pending") return true;
  if (en.status === "failed") return (en.attempts || 0) < MAX_ATTEMPTS && (!en.next_retry_at || en.next_retry_at <= now.toISOString());
  return en.status === "done" && !!en.next_retry_at && en.next_retry_at <= now.toISOString();
}

// Anreicherung mit Checkpoint: jedes Ergebnis wird sofort frisch-gelesen eingetragen und gespeichert (Abbruch → nächster Lauf macht weiter).
export async function enrichPending(dir, { research, concurrency = 3, limit = Infinity, now = () => new Date(), onProgress = () => {}, shouldStop = () => false } = {}) {
  const d0 = loadDirectory(dir);
  const queue = Object.values(d0.leads).filter((e) => dueForEnrichment(e, now())).map((e) => e.lead_id).slice(0, limit);
  const total = queue.length;
  const stats = { total, processed: 0, phones: 0, people: 0, both: 0, errors: 0 };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length && !shouldStop()) {
      const id = queue.shift();
      const snap = loadDirectory(dir).leads[id];
      if (!snap) continue;
      let res;
      try { res = await research(snap); } catch (err) { res = { ok: false, error: String(err?.message || err).slice(0, 80) }; }
      const d = loadDirectory(dir);
      const e = d.leads[id];
      if (!e) continue;
      applyEnrichment(e, res, now());
      d.meta.exports.dirty_since ||= now().toISOString();
      saveDirectory(dir, d, now());
      stats.processed++;
      if (!res?.ok) stats.errors++;
      if (e.phone && res?.ok) stats.phones++;
      if (e.first_name && res?.ok) stats.people++;
      if (e.phone && e.first_name && res?.ok) stats.both++;
      onProgress({ ...stats });
    }
  }));
  return stats;
}

// ---------- 6) Kennzahlen, CSV, PDF ----------
export function directoryStats(d) {
  const list = Object.values(d.leads || {});
  const n = (f) => list.filter(f).length;
  const keys = list.map((e) => `${e.domain || ""}|${e.email || ""}`);
  return {
    total: list.length, with_phone: n((e) => !!e.phone), with_person: n((e) => !!e.first_name && !!e.last_name), complete: n((e) => !!e.phone && !!e.first_name && !!e.last_name),
    missing_phone: n((e) => !e.phone), missing_person: n((e) => !e.first_name), enriched: n((e) => e.enrichment?.status === "done"), failed: n((e) => e.enrichment?.status === "failed"),
    pending: n((e) => !e.enrichment || e.enrichment.status === "pending"), duplicates: keys.length - new Set(keys).size + (list.length - new Set(list.map((e) => e.lead_id)).size),
    phones_mobile: n((e) => !!e.phone && normalizeSwissPhone(e.phone)?.kind === "mobile"),
    by_draft_status: Object.fromEntries(DRAFT_STATUSES.map((s) => [s, n((e) => e.draft_status === s)])),
  };
}
const zurich = (iso) => (iso ? new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "");
export const sortedEntries = (d) => Object.values(d.leads || {}).sort((a, b) => String(a.company_name || a.domain || "").localeCompare(String(b.company_name || b.domain || ""), "de", { sensitivity: "base", numeric: true }));
const confLabel = (c) => (c === "high" ? "ja (hoch)" : c === "medium" ? "ja (mittel)" : "nein");
export const CSV_HEADERS = Object.freeze(["Firma", "Domain", "E-Mail", "Telefon", "Vorname", "Nachname", "Rolle", "Telefon verifiziert", "Person verifiziert", "Draft Status", "Letzte Prüfung"]);
const csvCell = (v) => {
  let s = v == null ? "" : String(v).replace(/[\r\n]+/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = "'" + s; // keine Formel-Injection (gleiche Regel wie lead-db.js)
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// Semikolon + UTF-8-BOM + CRLF: öffnet direkt in Excel/LibreOffice mit Schweizer Einstellungen (wie lead-db.js leadsToCsv).
// „+41 …“ würde als Formel gelesen – darum wie überall in Jarvis mit vorangestelltem Apostroph als Text.
export function directoryToCsv(d) {
  const rows = sortedEntries(d).map((e) => [e.company_name, e.domain, e.email, e.phone, e.first_name, e.last_name, e.role, confLabel(e.phone && e.phone_confidence),
    confLabel(e.first_name && e.person_confidence), DRAFT_STATUS_LABEL[e.draft_status] || e.draft_status || "", zurich(e.contact_enriched_at)].map(csvCell).join(";"));
  return "﻿" + [CSV_HEADERS.join(";"), ...rows].join("\r\n") + "\r\n";
}
// Standardschriften (WinAnsi): Zeichen ausserhalb Latin-1 → ohne Akzent bzw. „?“ – nie ein kaputtes PDF.
const WINANSI_EXTRA = new Set("–—‘’‚“”„•…€™ŠšŒœŽžŸ†‡ˆ‰‹›".split(""));
const pdfText = (s) => [...String(s ?? "")].map((ch) => (ch.charCodeAt(0) <= 0xff && ch.charCodeAt(0) >= 0x20) || WINANSI_EXTRA.has(ch) ? ch
  : ch.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\xff]/g, "") || "?").join("");
export async function renderPdf(d, file, { now = new Date() } = {}) {
  const { default: PDFDocument } = await import("pdfkit");
  const st = directoryStats(d);
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 40, bottom: 44, left: 36, right: 36 }, bufferPages: true,
    info: { Title: "Jarvis – Lead-Kontaktliste", Author: "Jarvis", Subject: "Öffentlich verifizierte Geschäftskontakte", CreationDate: now } });
  const out = fs.createWriteStream(file, { mode: 0o600 });
  const done = new Promise((res, rej) => { out.on("finish", res); out.on("error", rej); doc.on("error", rej); });
  doc.pipe(out);
  const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right, bottom = () => doc.page.height - doc.page.margins.bottom;
  const cols = [["Firma", 0.27], ["E-Mail", 0.25], ["Telefon", 0.13], ["Ansprechpartner", 0.19], ["Rolle", 0.16]].map(([h, f]) => [h, Math.floor(W * f)]);
  cols[cols.length - 1][1] += W - cols.reduce((a, [, w]) => a + w, 0);
  const PAD = 4, FS = 8.5;
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#111").text(pdfText("Jarvis – Lead-Kontaktliste"), L, 40);
  doc.font("Helvetica").fontSize(11).fillColor("#444").text(pdfText("Öffentlich verifizierte Geschäftskontakte"));
  doc.moveDown(0.6).fontSize(9.5).fillColor("#111");
  const facts = [["Stand", zurich(now.toISOString()) + " (Europe/Zurich)"], ["Gesamtzahl Leads", st.total], ["Mit Telefonnummer", st.with_phone], ["Mit Ansprechpartner", st.with_person], ["Vollständig angereichert", st.complete]];
  for (const [k, v] of facts) doc.font("Helvetica-Bold").text(pdfText(k + ": "), { continued: true }).font("Helvetica").text(pdfText(String(v)));
  doc.moveDown(0.8);
  const header = () => {
    const y = doc.y;
    doc.rect(L, y, W, 16).fill("#1f3b57");
    let x = L;
    doc.font("Helvetica-Bold").fontSize(FS).fillColor("#fff");
    for (const [h, w] of cols) { doc.text(pdfText(h), x + PAD, y + 4, { width: w - 2 * PAD, lineBreak: false }); x += w; }
    doc.y = y + 16;
  };
  header();
  let i = 0;
  for (const e of sortedEntries(d)) {
    const person = e.first_name && e.last_name ? `${e.first_name} ${e.last_name}` : null;
    const cells = [[e.company_name || e.domain || "", false], [e.email || "", false], [e.phone || "nicht verifiziert", !e.phone], [person || "nicht verifiziert", !person], [person ? e.role || "" : "", false]];
    doc.fontSize(FS);
    const h = Math.max(...cells.map(([t, muted], k) => doc.font(muted ? "Helvetica-Oblique" : "Helvetica").heightOfString(pdfText(t) || " ", { width: cols[k][1] - 2 * PAD }))) + 2 * PAD;
    if (doc.y + h > bottom()) { doc.addPage(); doc.y = doc.page.margins.top; header(); }
    const y = doc.y;
    if (i++ % 2) doc.rect(L, y, W, h).fill("#eef2f6");
    let x = L;
    cells.forEach(([t, muted], k) => {
      doc.font(muted ? "Helvetica-Oblique" : "Helvetica").fontSize(FS).fillColor(muted ? "#888" : "#111").text(pdfText(t), x + PAD, y + PAD, { width: cols[k][1] - 2 * PAD });
      x += cols[k][1];
    });
    doc.y = y + h;
  }
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const old = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor("#666")
      .text(pdfText(`Jarvis – Lead-Kontaktliste · Seite ${p - range.start + 1} von ${range.count}`), L, doc.page.height - 28, { width: W, align: "center", lineBreak: false });
    doc.page.margins.bottom = old;
  }
  doc.end();
  await done;
  return { pages: range.count };
}
// Exporte atomar: erst temporäre Datei vollständig schreiben + prüfen, dann umbenennen. Nie eine halbe Datei sichtbar.
export async function writeExports(d, exportsDir, { now = new Date(), pdf = true } = {}) {
  fs.mkdirSync(exportsDir, { recursive: true });
  const csvFile = path.join(exportsDir, CSV_NAME), pdfFile = path.join(exportsDir, PDF_NAME);
  writeAtomic(csvFile, directoryToCsv(d));
  const res = { csv: { file: csvFile, rows: Object.keys(d.leads).length, bytes: fs.statSync(csvFile).size } };
  if (pdf) {
    const tmp = `${pdfFile}.tmp-${process.pid}-${Date.now()}`;
    try {
      const { pages } = await renderPdf(d, tmp, { now });
      const fd = fs.openSync(tmp, "r"), head = Buffer.alloc(5), size = fs.statSync(tmp).size, tail = Buffer.alloc(Math.min(32, size));
      fs.readSync(fd, head, 0, 5, 0); fs.readSync(fd, tail, 0, tail.length, size - tail.length); fs.closeSync(fd);
      if (head.toString() !== "%PDF-" || !tail.toString().includes("%%EOF")) throw new Error("PDF unvollständig");
      fs.renameSync(tmp, pdfFile);
      res.pdf = { file: pdfFile, pages, bytes: size };
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  }
  return res;
}
// Entprellt: CSV bei jeder Änderung, PDF höchstens alle 5 Minuten (ein Prozess, nie parallel).
export async function maybeExport(dir, exportsDir, { now = new Date(), force = false, minIntervalMs = PDF_MIN_INTERVAL_MS } = {}) {
  const d = loadDirectory(dir);
  const ex = d.meta.exports;
  if (!force && !ex.dirty_since) return { skipped: "clean" };
  const pdfDue = force || !ex.last_pdf_at || now.getTime() - Date.parse(ex.last_pdf_at) >= minIntervalMs;
  const res = await writeExports(d, exportsDir, { now, pdf: pdfDue });
  const fresh = loadDirectory(dir); // frisch lesen: Änderungen während des Exports nicht verlieren
  fresh.meta.exports.last_csv_at = now.toISOString();
  if (res.pdf) { fresh.meta.exports.last_pdf_at = now.toISOString(); fresh.meta.exports.last_pdf_pages = res.pdf.pages; }
  if (res.pdf && fresh.meta.exports.dirty_since === ex.dirty_since) delete fresh.meta.exports.dirty_since;
  saveDirectory(dir, fresh, now);
  return res;
}

// ---------- 7) Register lesen (nur lesen) + Abgleich ----------
export function readOwnedFromMail(mailSecretsDir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(mailSecretsDir, f), "utf8"));
  const reviews = read(path.join("mail_worker", "individual_reviews.json")).reviews || {};
  const gmail = read("gmail_jarvis.json");
  return ownedColdLeads(reviews, gmail);
}
export function syncFromMail(dir, mailSecretsDir, now = new Date()) {
  const owned = readOwnedFromMail(mailSecretsDir);
  const d = loadDirectory(dir);
  const res = syncDirectory(d, owned, now);
  if (res.created || res.updated || res.missing) d.meta.exports.dirty_since ||= now.toISOString();
  d.meta.last_sync_at = now.toISOString();
  saveDirectory(dir, d, now);
  return { ...res, owned: owned.length };
}

// Ein Schreiber zur Zeit (Dienst ODER Backfill): Lock mit Herzschlag, verwaist nach 10 Minuten.
export function acquireDirLock(dir, name = "contacts.lock") {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, beat: Date.now() }), { flag: "wx", mode: 0o600 }); return true; }
  catch {
    let l = null; try { l = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    if (l && Date.now() - l.beat < 10 * 60_000 && l.pid !== process.pid) return false;
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, beat: Date.now() }), { mode: 0o600 });
    return true;
  }
}
export const beatDirLock = (dir, name = "contacts.lock") => fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid: process.pid, beat: Date.now() }), { mode: 0o600 });
export const releaseDirLock = (dir, name = "contacts.lock") => { try { const l = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); if (l.pid === process.pid) fs.rmSync(path.join(dir, name)); } catch {} };

// ---------- Kommandozeile / Dienst ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
  const DIR = process.env.JARVIS_CONTACTS_DIR || "/data/contacts";
  const EXPORTS = process.env.JARVIS_EXPORTS_DIR || "/data/exports";
  const MAIL = process.env.JARVIS_MAIL_SECRETS || "/data/mail";
  const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
  const brief = (s) => ({ processed: `${s.processed}/${s.total}`, phones_found: s.phones, people_found: s.people, complete: s.both, errors: s.errors });
  const main = async () => {
    if (args.includes("--healthcheck")) {
      try { const l = JSON.parse(fs.readFileSync(path.join(DIR, "contacts.lock"), "utf8")); return Date.now() - l.beat < 5 * 60_000 ? 0 : 1; } catch { return 1; }
    }
    if (args.includes("--report")) { log({ event: "report", ...directoryStats(loadDirectory(DIR)) }); return 0; }
    if (!acquireDirLock(DIR)) { log({ event: "locked", note: "anderer Lauf aktiv (Dienst oder Backfill)" }); return 2; }
    const hb = setInterval(() => { try { beatDirLock(DIR); } catch {} }, 60_000);
    try {
      if (args.includes("--export")) { const r = await maybeExport(DIR, EXPORTS, { force: true }); log({ event: "export", csv_rows: r.csv.rows, pdf_pages: r.pdf?.pages, pdf_bytes: r.pdf?.bytes }); return 0; }
      if (args.includes("--backfill")) {
        log({ event: "sync", ...syncFromMail(DIR, MAIL) });
        const researcher = createResearcher({});
        let lastLog = 0;
        const s = await enrichPending(DIR, { research: (e) => researcher.research(e), concurrency: Number(opt("concurrency") || 3), limit: Number(opt("limit") || Infinity),
          onProgress: (p) => { if (p.processed === p.total || Date.now() - lastLog > 20_000) { lastLog = Date.now(); log({ event: "progress", ...brief(p) }); } } });
        const st = directoryStats(loadDirectory(DIR));
        log({ event: "backfill_done", ...brief(s), requests: researcher.stats().requests, missing_phone: st.missing_phone, missing_person: st.missing_person });
        const r = await maybeExport(DIR, EXPORTS, { force: true });
        log({ event: "export", csv_rows: r.csv.rows, pdf_pages: r.pdf?.pages, pdf_bytes: r.pdf?.bytes });
        return 0;
      }
      if (args.includes("--service")) {
        const pollMs = Number(process.env.JARVIS_CONTACTS_POLL_SECONDS || 120) * 1000;
        let stop = false;
        for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stop = true; });
        log({ event: "service_start", poll_s: pollMs / 1000 });
        while (!stop) {
          try {
            const s = syncFromMail(DIR, MAIL);
            if (s.created || s.missing) log({ event: "sync", created: s.created, updated: s.updated, missing: s.missing, total: s.total });
            // Neue Leads zuerst, pro Durchgang begrenzt (höflich); Fehler → später erneut (Backoff im Eintrag).
            const researcher = createResearcher({});
            const r = await enrichPending(DIR, { research: (e) => researcher.research(e), concurrency: 2, limit: 15, shouldStop: () => stop });
            if (r.processed) log({ event: "enriched", ...brief(r) });
            const ex = await maybeExport(DIR, EXPORTS, { now: new Date() });
            if (!ex.skipped) log({ event: "export", csv_rows: ex.csv.rows, pdf_pages: ex.pdf?.pages ?? null });
          } catch (e) { log({ event: "iteration_failed", error: String(e?.message || e).slice(0, 160) }); }
          beatDirLock(DIR);
          for (let t = 0; t < pollMs && !stop; t += 1000) await new Promise((r) => setTimeout(r, 1000));
        }
        return 0;
      }
      console.log("Befehle: --backfill [--limit n] | --export | --report | --service | --healthcheck");
      return 1;
    } finally { clearInterval(hb); releaseDirLock(DIR); }
  };
  main().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
