// TF-077B PhonebookComplianceProvider – Telefonbuch-Sternchen («Keine Werbung», search.ch-Feld tel:nopromo) ohne Abhängigkeiten
// (CRM-Dienst, Netlify-Funktion, Tests).
//
//   PHONEBOOK_STAR_PRESENT   ausdrücklicher, strukturierter Beleg (tel:nopromo positiv) → Nummer nie für Werbe-/Kaltanrufe, auch nicht mit
//                            CONTACT_FORM_P0; die Nummer wird im CRM nicht als anrufbar geführt (phone_tel entfällt, Text bleibt sichtbar).
//   PHONEBOOK_STAR_CLEAR     ausdrücklicher Beleg einer erfolgreichen Abfrage OHNE Sternchen (Quelle + Zeitpunkt + Nummer).
//   PHONEBOOK_STAR_UNKNOWN   kein Beleg («Telefonbuch: NICHT GEPRÜFT») – nie als CLEAR behandelt, nie Beweis für «kein Sternchen».
//   PHONEBOOK_LOOKUP_FAILED  Abfrage technisch gescheitert.
//
// Jarvis fragt search.ch nicht ab und scrapt kein Verzeichnis. TF-078: einziger Anbieter ist multisource (kommerziell, unten) – ohne
// MULTISOURCE_API_KEY PHONEBOOK_PROVIDER_NOT_CONFIGURED. Ein Sternchen wird NIE aus einer formatierten Telefonnummer («*» im Text) abgeleitet und nie entfernt.
import crypto from "node:crypto";
export const PHONEBOOK_STATES = Object.freeze(["PHONEBOOK_STAR_CLEAR", "PHONEBOOK_STAR_PRESENT", "PHONEBOOK_STAR_UNKNOWN", "PHONEBOOK_LOOKUP_FAILED"]);
export const PROVIDER_NOT_CONFIGURED = "PHONEBOOK_PROVIDER_NOT_CONFIGURED";
export const NOPROMO_FIELD = "tel:nopromo"; // offizielles strukturiertes Feld der search.ch-Telefonbuch-API
const ISO = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const E164 = /^\+\d{8,15}$/;

// Beleg aus einem gespeicherten Datensatz (Kontaktverzeichnis: { phonebook: { status|nopromo|"tel:nopromo", source, checked_at, phone } }).
// Nur strukturierte Felder zählen. Positiv = "*", true, "1", "yes". CLEAR nur mit ausdrücklich negativem Ergebnis + Quelle + Zeitpunkt.
export function phonebookFromRecord(rec, phoneE164 = null) {
  const pb = rec && typeof rec === "object" ? rec.phonebook : null;
  if (!pb || typeof pb !== "object") return { status: "PHONEBOOK_STAR_UNKNOWN", source: null, checked_at: null };
  const src = typeof pb.source === "string" ? pb.source.slice(0, 40) : null, at = ISO(pb.checked_at);
  // Der Beleg gilt nur für die Nummer, für die er erhoben wurde.
  if (pb.phone && phoneE164 && E164.test(String(pb.phone)) && pb.phone !== phoneE164) return { status: "PHONEBOOK_STAR_UNKNOWN", source: src, checked_at: at };
  const raw = pb[NOPROMO_FIELD] ?? pb.nopromo;
  if (pb.status === "PHONEBOOK_STAR_PRESENT" || raw === true || raw === "*" || raw === 1 || /^(true|yes|1|\*)$/i.test(String(raw ?? ""))) return { status: "PHONEBOOK_STAR_PRESENT", source: src, checked_at: at };
  if (pb.status === "PHONEBOOK_LOOKUP_FAILED") return { status: "PHONEBOOK_LOOKUP_FAILED", source: src, checked_at: at };
  if ((pb.status === "PHONEBOOK_STAR_CLEAR" || raw === false) && src && at) return { status: "PHONEBOOK_STAR_CLEAR", source: src, checked_at: at };
  return { status: "PHONEBOOK_STAR_UNKNOWN", source: src, checked_at: at };
}

// Einzelner, bereits vorliegender search.ch-Eintrag (z. B. aus einer erlaubten Einzelabfrage): <tel:nopromo> vorhanden und nicht leer → Sternchen.
export function phonebookFromSearchChEntry(entry, { checked_at = null } = {}) {
  if (!entry || typeof entry !== "object") return { status: "PHONEBOOK_LOOKUP_FAILED", source: "search.ch", checked_at };
  const v = entry[NOPROMO_FIELD];
  return { status: v != null && String(v).trim() !== "" ? "PHONEBOOK_STAR_PRESENT" : "PHONEBOOK_STAR_CLEAR", source: "search.ch", checked_at };
}

// Anbieter: ohne erlaubte, konfigurierte Quelle immer NOT_CONFIGURED – lookup liefert UNKNOWN und ruft nichts ab.
export function createPhonebookProvider(cfg = {}) {
  const lookup = typeof cfg.lookup === "function" && cfg.permitted === true ? cfg.lookup : null;
  return {
    configured: !!lookup, state: lookup ? "PHONEBOOK_PROVIDER_CONFIGURED" : PROVIDER_NOT_CONFIGURED,
    async lookup(phoneE164) {
      if (!lookup) return { status: "PHONEBOOK_STAR_UNKNOWN", reason: PROVIDER_NOT_CONFIGURED };
      try { const r = await lookup(phoneE164); return PHONEBOOK_STATES.includes(r?.status) ? r : { status: "PHONEBOOK_LOOKUP_FAILED" }; }
      catch { return { status: "PHONEBOOK_LOOKUP_FAILED" }; }
    },
  };
}

// ======================================================================================================================================
// TF-078 – kommerzieller Anbieter MULTISOURCE (https://api.multisource.ch, GET /v2/Search/CallLookup?number=…, Header auth-key).
//
// Schlüssel nur aus der Umgebung (MULTISOURCE_API_KEY) – nie im Git, nie im Log, nie in der Sicht. Ein Sternchen/CLEAR wird AUSSCHLIESSLICH
// aus einem ausdrücklich bestätigten Werbe-/Sternchen-Feld abgeleitet (MULTISOURCE_NOPROMO_FIELD + MULTISOURCE_NOPROMO_SEMANTICS, beide
// gesetzt, erst nachdem Anbieter-Dokumentation oder das Schema-Diagnose-Ergebnis das Feld belegt). Ohne bestätigtes Feld ist jedes Ergebnis
// UNKNOWN – auch ein Treffer, eine Firma, ein fehlendes nopromo oder eine Nummer ohne «*». Kein erfundenes Feld, keine Heuristik.
// ======================================================================================================================================
export const MULTISOURCE = "multisource";
export const MULTISOURCE_DEFAULT_BASE = "https://api.multisource.ch";
export const MULTISOURCE_CALL_LOOKUP = "/v2/Search/CallLookup";
export const PHONEBOOK_CACHE_FILE = "phonebook_compliance.json";
export const PHONEBOOK_TTL_MS = 30 * 24 * 3600_000; // erfolgreiche Prüfung: Neuprüfung nach 30 Tagen
export const PHONEBOOK_FAILED_TTL_MS = 24 * 3600_000; // fehlgeschlagene Prüfung: frühestens nach 1 Tag erneut
export const DEFAULT_MAX_PER_RUN = 50, DEFAULT_MAX_PER_DAY = 500;
// Ausdrücklich definierte Bedeutungen eines bestätigten Feldes (nur echte Booleans zählen – "true"/1/"*" bleiben UNKNOWN):
//   TRUE_IS_STAR   Feld === true → STAR_PRESENT, Feld === false → STAR_CLEAR   (z. B. ein «noPromo»-Feld)
//   FALSE_IS_STAR  Feld === false → STAR_PRESENT, Feld === true → STAR_CLEAR   (z. B. ein «advertisingAllowed»-Feld)
export const NOPROMO_SEMANTICS = Object.freeze(["TRUE_IS_STAR", "FALSE_IS_STAR"]);
export const PHONEBOOK_REASONS = Object.freeze(["PROVIDER_NOT_CONFIGURED", "AUTH_FAILED", "RATE_LIMIT", "NETWORK", "HTTP_ERROR", "INVALID_RESPONSE", "INVALID_NUMBER",
  "NO_HIT", "PROMO_FIELD_NOT_CONFIRMED", "PROMO_FIELD_MISSING", "EXPLICIT_STAR", "EXPLICIT_CLEAR"]);
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/;

// Schweizer Nummer → E.164 (+41 + 9 Ziffern). Erlaubt: +41…, 0041…, 0xx… (Leerzeichen, Punkte, Striche, Klammern, Schrägstriche).
// Nur für die Abfrage – die Nummer im CRM wird nie verändert (auch kein «*» entfernt, um ein Sternchen zu umgehen).
export function normalizeSwissPhone(raw) {
  const s = String(raw ?? "").trim().replace(/[\s.\-()/]/g, "");
  let m;
  if ((m = /^\+41(\d{9})$/.exec(s)) || (m = /^0041(\d{9})$/.exec(s)) || (m = /^0(\d{9})$/.exec(s))) return /^[1-9]/.test(m[1]) ? `+41${m[1]}` : null;
  return null;
}
// Eingabe an den Anbieter: genau EIN validiertes Format – nationale Schreibweise 0XXXXXXXXX (aus der E.164-Form abgeleitet).
export const multisourceNumber = (e164) => (/^\+41[1-9]\d{8}$/.test(String(e164 || "")) ? `0${e164.slice(3)}` : null);
// Cache-Schlüssel je Nummer (keine Klartext-Nummer im Cache).
export const phoneHash = (e164) => crypto.createHash("sha256").update(`jarvis-phonebook-v1:${e164}`).digest("hex").slice(0, 32);

// Konfiguration aus der Umgebung. Das Feld gilt nur mit Name (Muster) UND definierter Bedeutung als bestätigt.
export function multisourceConfig(env = process.env) {
  const apiKey = typeof env.MULTISOURCE_API_KEY === "string" ? env.MULTISOURCE_API_KEY.trim() : "";
  const base = String(env.MULTISOURCE_API_BASE_URL || MULTISOURCE_DEFAULT_BASE).trim().replace(/\/+$/, "");
  const field = FIELD_RE.test(String(env.MULTISOURCE_NOPROMO_FIELD || "")) ? env.MULTISOURCE_NOPROMO_FIELD : null;
  const semantics = NOPROMO_SEMANTICS.includes(env.MULTISOURCE_NOPROMO_SEMANTICS) ? env.MULTISOURCE_NOPROMO_SEMANTICS : null;
  const int = (v, d) => (/^\d{1,6}$/.test(String(v ?? "")) ? Number(v) : d);
  return { apiKey, configured: apiKey.length >= 8, baseUrl: /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(base) ? base : MULTISOURCE_DEFAULT_BASE,
    field: field && semantics ? field : null, semantics: field && semantics ? semantics : null, fieldConfirmed: !!(field && semantics),
    maxPerRun: int(env.MULTISOURCE_MAX_LOOKUPS_PER_RUN, DEFAULT_MAX_PER_RUN), maxPerDay: int(env.MULTISOURCE_MAX_LOOKUPS_PER_DAY, DEFAULT_MAX_PER_DAY) };
}

// Ergebnis-Einträge einer Antwort: Array direkt, sonst das erste Array von Objekten auf oberster Ebene, sonst keine.
function itemsOf(body) {
  if (Array.isArray(body)) return body.filter((x) => x && typeof x === "object");
  if (!body || typeof body !== "object") return [];
  for (const v of Object.values(body)) if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) return v.filter((x) => x && typeof x === "object");
  return [];
}
const pick = (obj, dotted) => dotted.split(".").reduce((o, k) => (o && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined), obj);

// Klassifikation einer 2xx-Antwort. Nur ein bestätigtes Feld mit echtem Boolean entscheidet; ein einziges Sternchen genügt für PRESENT,
// CLEAR nur wenn JEDER Treffer ausdrücklich «kein Sternchen» trägt.
export function classifyMultisource(body, { field = null, semantics = null } = {}) {
  const items = itemsOf(body);
  if (!items.length) return { status: "PHONEBOOK_STAR_UNKNOWN", reason: "NO_HIT", matches: 0 };
  if (!field || !NOPROMO_SEMANTICS.includes(semantics)) return { status: "PHONEBOOK_STAR_UNKNOWN", reason: "PROMO_FIELD_NOT_CONFIRMED", matches: items.length };
  const star = semantics === "TRUE_IS_STAR" ? true : false;
  const vals = items.map((it) => pick(it, field));
  if (vals.some((v) => v === star)) return { status: "PHONEBOOK_STAR_PRESENT", reason: "EXPLICIT_STAR", matches: items.length };
  if (vals.every((v) => v === !star)) return { status: "PHONEBOOK_STAR_CLEAR", reason: "EXPLICIT_CLEAR", matches: items.length };
  return { status: "PHONEBOOK_STAR_UNKNOWN", reason: "PROMO_FIELD_MISSING", matches: items.length };
}

// Eine Abfrage. Gibt nie Namen/Adressen/Nummern zurück – nur Status, Grund, HTTP-Status, Trefferzahl (+ retry_after bei 429).
export async function multisourceLookup(e164, { config = multisourceConfig(), fetchFn = globalThis.fetch, timeoutMs = 15_000, raw = false } = {}) {
  if (!config.configured) return { status: PROVIDER_NOT_CONFIGURED, reason: "PROVIDER_NOT_CONFIGURED", http_status: null };
  const number = multisourceNumber(normalizeSwissPhone(e164));
  if (!number) return { status: "PHONEBOOK_LOOKUP_FAILED", reason: "INVALID_NUMBER", http_status: null };
  let res;
  try {
    res = await fetchFn(`${config.baseUrl}${MULTISOURCE_CALL_LOOKUP}?number=${encodeURIComponent(number)}`,
      { method: "GET", headers: { "auth-key": config.apiKey, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch { return { status: "PHONEBOOK_LOOKUP_FAILED", reason: "NETWORK", http_status: null }; }
  const http = res.status;
  if (http === 401 || http === 403) return { status: "PHONEBOOK_LOOKUP_FAILED", reason: "AUTH_FAILED", http_status: http };
  if (http === 429) {
    const ra = Number(res.headers?.get?.("retry-after"));
    return { status: "PHONEBOOK_LOOKUP_FAILED", reason: "RATE_LIMIT", http_status: http, retry_after_s: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 86_400) : null };
  }
  if (http === 204 || http === 404) return { status: "PHONEBOOK_STAR_UNKNOWN", reason: "NO_HIT", http_status: http, matches: 0, ...(raw ? { body: null } : {}) };
  if (http < 200 || http >= 300) return { status: "PHONEBOOK_LOOKUP_FAILED", reason: "HTTP_ERROR", http_status: http };
  let body;
  try { const txt = await res.text(); body = txt.trim() ? JSON.parse(txt) : null; } catch { return { status: "PHONEBOOK_LOOKUP_FAILED", reason: "INVALID_RESPONSE", http_status: http }; }
  return { ...classifyMultisource(body, config), http_status: http, ...(raw ? { body } : {}) };
}

// Schema-Diagnose: nur Feldnamen (nie Werte). Kandidaten = Feldnamen, die nach Werbung/Sternchen/Sperre klingen – nur Hinweis für den
// Menschen, der die Doku prüft; daraus wird NIE automatisch ein Feld aktiviert.
const CANDIDATE_RE = /promo|werb|advert|reklam|marketing|star|stern|robinson|opt.?out|nocall|no.?call|blocked|sperr|publicit/i;
function keyPaths(obj, prefix = "", depth = 0, out = new Set()) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 3) return out;
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.add(p.slice(0, 120));
    const v = obj[k];
    if (Array.isArray(v)) { for (const x of v.slice(0, 20)) keyPaths(x, `${p}[]`, depth + 1, out); }
    else keyPaths(v, p, depth + 1, out);
  }
  return out;
}
export function inspectSchema(body, httpStatus = null) {
  const top = Array.isArray(body) ? ["[array]"] : body && typeof body === "object" ? Object.keys(body).sort() : [];
  const itemFields = new Set();
  for (const it of itemsOf(body).slice(0, 20)) keyPaths(it, "", 0, itemFields);
  const items = [...itemFields].sort();
  const candidates = [...new Set([...top, ...items])].filter((k) => CANDIDATE_RE.test(k));
  return { http_status: httpStatus, top_level_fields: top, result_item_count: itemsOf(body).length, result_item_fields: items,
    candidate_promotion_fields: candidates, candidate_promotion_field_exists: candidates.length > 0 };
}

// ---------- Cache je Nummer (phone_hash) + Nutzung/Rate-Limit ----------
export const emptyPhonebookCache = () => ({ schema: 1, entries: {}, usage: { day: null, lookups: 0, matches: 0, last_success_at: null, rate_limited_until: null, rate_limit_hits: 0 } });
export function normalizePhonebookCache(c) {
  const d = emptyPhonebookCache();
  if (!c || typeof c !== "object") return d;
  const entries = {};
  for (const [h, e] of Object.entries(c.entries && typeof c.entries === "object" ? c.entries : {})) {
    if (!/^[a-f0-9]{32}$/.test(h) || !e || !PHONEBOOK_STATES.includes(e.status)) continue;
    entries[h] = { phone_hash: h, provider: MULTISOURCE, status: e.status, reason: PHONEBOOK_REASONS.includes(e.reason) ? e.reason : null, checked_at: ISO(e.checked_at),
      expires_at: ISO(e.expires_at), last_attempt_at: ISO(e.last_attempt_at), provider_reference: null };
  }
  const u = c.usage && typeof c.usage === "object" ? c.usage : {};
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { schema: 1, entries, usage: { day: /^\d{4}-\d{2}-\d{2}$/.test(String(u.day || "")) ? u.day : null, lookups: n(u.lookups), matches: n(u.matches),
    last_success_at: ISO(u.last_success_at), rate_limited_until: ISO(u.rate_limited_until), rate_limit_hits: n(u.rate_limit_hits) } };
}
export const zurichDay = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const rollDay = (usage, now) => { const day = zurichDay(now); if (usage.day !== day) Object.assign(usage, { day, lookups: 0, matches: 0 }); return usage; };

// Gilt der Eintrag noch? Ein ausdrückliches Sternchen bleibt IMMER sperrend (bis eine neue erfolgreiche, massgebliche Prüfung CLEAR ergibt).
// Abgelaufenes CLEAR → UNKNOWN (nicht mehr als geprüft-sauber behandelt). Fehlgeschlagen bleibt sichtbar als «Prüfung fehlgeschlagen».
export function phonebookFromCache(cache, e164, now = new Date()) {
  const n = normalizeSwissPhone(e164);
  const e = n ? cache?.entries?.[phoneHash(n)] : null;
  if (!e) return null;
  const expired = !e.expires_at || Date.parse(e.expires_at) <= +now;
  const status = e.status === "PHONEBOOK_STAR_CLEAR" && expired ? "PHONEBOOK_STAR_UNKNOWN" : e.status;
  return { status, source: MULTISOURCE, checked_at: e.checked_at, reason: e.reason, expired };
}
// Braucht diese Nummer eine (erneute) Abfrage?
export function needsLookup(cache, e164, now = new Date()) {
  const n = normalizeSwissPhone(e164);
  if (!n) return false;
  const e = cache?.entries?.[phoneHash(n)];
  return !e || !e.expires_at || Date.parse(e.expires_at) <= +now;
}
// Ergebnis übernehmen. Ein Sternchen wird nur durch ein neues massgebliches CLEAR ersetzt; UNKNOWN/FAILED überschreiben weder PRESENT noch
// ein gültiges CLEAR (nur Zeitpunkt des Versuchs + kurze Neuprüf-Frist).
export function recordLookup(cache, e164, result, now = new Date()) {
  const n = normalizeSwissPhone(e164);
  if (!n || !PHONEBOOK_STATES.includes(result?.status)) return null;
  const h = phoneHash(n), prev = cache.entries[h], at = now.toISOString();
  const authoritative = result.status === "PHONEBOOK_STAR_PRESENT" || result.status === "PHONEBOOK_STAR_CLEAR";
  const ttl = result.status === "PHONEBOOK_LOOKUP_FAILED" ? PHONEBOOK_FAILED_TTL_MS : PHONEBOOK_TTL_MS;
  const exp = new Date(+now + ttl).toISOString();
  if (!authoritative && prev && (prev.status === "PHONEBOOK_STAR_PRESENT" || (prev.status === "PHONEBOOK_STAR_CLEAR" && prev.expires_at && Date.parse(prev.expires_at) > +now))) {
    cache.entries[h] = { ...prev, last_attempt_at: at, expires_at: prev.status === "PHONEBOOK_STAR_PRESENT" ? new Date(+now + PHONEBOOK_FAILED_TTL_MS).toISOString() : prev.expires_at };
    return cache.entries[h];
  }
  cache.entries[h] = { phone_hash: h, provider: MULTISOURCE, status: result.status, reason: PHONEBOOK_REASONS.includes(result.reason) ? result.reason : null,
    checked_at: result.status === "PHONEBOOK_LOOKUP_FAILED" ? prev?.checked_at || null : at, expires_at: exp, last_attempt_at: at, provider_reference: null };
  return cache.entries[h];
}

// Gestaffelte Nachprüfung (Backfill). leads: [{ lead_id, market, phone, do_not_contact }]. Nur CH, nur mit gültiger Nummer, frische
// Cache-Einträge übersprungen, je Nummer höchstens einmal je Lauf, Lauf-/Tageslimit, 429 → sofort Stopp + Backoff. Idempotent/fortsetzbar:
// der Stand liegt vollständig im Cache. Rückgabe: nur Zähler.
export async function runPhonebookBackfill({ leads = [], cache, now = () => new Date(), lookup, maxPerRun = DEFAULT_MAX_PER_RUN, maxPerDay = DEFAULT_MAX_PER_DAY, dryRun = false, onProgress = null }) {
  const sum = { candidates: 0, skipped_non_ch: 0, skipped_no_phone: 0, skipped_dnc: 0, skipped_fresh: 0, skipped_duplicate: 0, due: 0, looked_up: 0,
    by_status: { PHONEBOOK_STAR_CLEAR: 0, PHONEBOOK_STAR_PRESENT: 0, PHONEBOOK_STAR_UNKNOWN: 0, PHONEBOOK_LOOKUP_FAILED: 0 }, stopped: null, dry_run: !!dryRun };
  const u = rollDay(cache.usage, now());
  if (u.rate_limited_until && Date.parse(u.rate_limited_until) > +now()) sum.stopped = "RATE_LIMITED";
  const seen = new Set();
  for (const l of leads) {
    sum.candidates++;
    if ((l?.market || "CH") !== "CH") { sum.skipped_non_ch++; continue; }
    if (l.do_not_contact) { sum.skipped_dnc++; continue; }
    const e164 = normalizeSwissPhone(l.phone);
    if (!e164) { sum.skipped_no_phone++; continue; }
    if (seen.has(e164)) { sum.skipped_duplicate++; continue; }
    seen.add(e164);
    if (!needsLookup(cache, e164, now())) { sum.skipped_fresh++; continue; }
    sum.due++;
    if (dryRun || sum.stopped) continue;
    if (sum.looked_up >= maxPerRun) { sum.stopped = "RUN_CAP"; continue; }
    rollDay(u, now());
    if (u.lookups >= maxPerDay) { sum.stopped = "DAY_CAP"; continue; }
    u.lookups++; sum.looked_up++;
    const r = await lookup(e164);
    if (r?.status === PROVIDER_NOT_CONFIGURED) { u.lookups--; sum.looked_up--; sum.stopped = "PROVIDER_NOT_CONFIGURED"; continue; }
    if (r?.reason === "RATE_LIMIT") {
      // Backoff: Retry-After, sonst 15 min × 2^(Treffer-1), höchstens 24 h. Keine Wiederholung in diesem Lauf.
      u.rate_limit_hits++;
      const ms = r.retry_after_s ? r.retry_after_s * 1000 : Math.min(15 * 60_000 * 2 ** Math.min(u.rate_limit_hits - 1, 7), 24 * 3600_000);
      u.rate_limited_until = new Date(+now() + ms).toISOString();
      sum.stopped = "RATE_LIMITED";
      continue; // Nummer bleibt fällig (kein FAILED-Eintrag, der 24 h sperren würde)
    }
    if (r?.reason === "AUTH_FAILED") { recordLookup(cache, e164, r, now()); sum.by_status.PHONEBOOK_LOOKUP_FAILED++; sum.stopped = "AUTH_FAILED"; continue; }
    const e = recordLookup(cache, e164, r, now());
    const st = PHONEBOOK_STATES.includes(r?.status) ? r.status : "PHONEBOOK_LOOKUP_FAILED";
    sum.by_status[st]++;
    if (st !== "PHONEBOOK_LOOKUP_FAILED") { u.last_success_at = now().toISOString(); u.rate_limit_hits = 0; if ((r.matches || 0) > 0) u.matches++; }
    if (!e) recordLookup(cache, e164, { status: "PHONEBOOK_LOOKUP_FAILED", reason: "INVALID_RESPONSE" }, now());
    onProgress?.(sum);
  }
  return sum;
}

// Owner-Sicht: Anbieter-Zustand ohne Schlüssel und ohne personenbezogene Daten.
export function providerStatus(cache, config, now = new Date()) {
  const u = cache?.usage || {};
  const today = u.day === zurichDay(now);
  return { provider: MULTISOURCE, configured: !!config?.configured, field_confirmed: !!config?.fieldConfirmed, last_success_at: u.last_success_at || null,
    lookups_today: today ? u.lookups || 0 : 0, matches_today: today ? u.matches || 0 : 0,
    rate_limit: u.rate_limited_until && Date.parse(u.rate_limited_until) > +now ? "LIMITED" : "OK", max_per_run: config?.maxPerRun ?? DEFAULT_MAX_PER_RUN, max_per_day: config?.maxPerDay ?? DEFAULT_MAX_PER_DAY };
}

// Automatisierter Kaltanruf (CH): nur mit ausdrücklich bestätigtem CLEAR. UNKNOWN/FAILED/PRESENT → nie automatisch anrufbar.
// Kundeninitiierter Rückruf (Kontaktformular / im Anruf erbeten) bleibt eigene Grundlage – ein Sternchen sperrt aber immer.
export function coldCallPhonebookGate(lead) {
  const s = lead?.phonebook?.status || "PHONEBOOK_STAR_UNKNOWN";
  if (s === "PHONEBOOK_STAR_PRESENT") return { ok: false, code: "PHONEBOOK_STAR_PRESENT" };
  return s === "PHONEBOOK_STAR_CLEAR" ? { ok: true, code: "PHONEBOOK_STAR_CLEAR" } : { ok: false, code: "PHONEBOOK_NOT_VERIFIED_CLEAR" };
}

// Künftige Aufnahme neuer Leads (TF-077B §28): verifizierter Fehler + (mit konfiguriertem Anbieter) Telefonbuch CLEAR. Ohne Anbieter wird
// nur PHONEBOOK_PROVIDER_NOT_CONFIGURED festgehalten – kein erfundenes Ergebnis, bestehende Leads bleiben sichtbar (NICHT GEPRÜFT).
export function phonebookAdmission(phonebook, { providerConfigured = false } = {}) {
  const s = phonebook?.status || "PHONEBOOK_STAR_UNKNOWN";
  if (s === "PHONEBOOK_STAR_PRESENT") return { ok: true, callable: false, state: s }; // Lead bleibt (E-Mail), Nummer nie anrufbar
  if (!providerConfigured) return { ok: true, callable: s === "PHONEBOOK_STAR_CLEAR", state: PROVIDER_NOT_CONFIGURED };
  return { ok: s === "PHONEBOOK_STAR_CLEAR", callable: s === "PHONEBOOK_STAR_CLEAR", state: s };
}
