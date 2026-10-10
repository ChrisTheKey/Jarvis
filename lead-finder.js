// Jarvis Lead-Finder – findet öffentliche Websites von Schweizer KMU, prüft sie passiv (site-auditor.js)
// und legt daraus Leads in .secrets/mail_worker/discovered.json an. Er sendet NIE und gibt NIE frei:
// gefundene Leads starten mit approved=false und consentBasis=null. Eine öffentliche Adresse ist keine Einwilligung.
// Versendet wird nur über den Mail-Worker und dessen Versandgrundlagen-Prüfung (leads.json).
//
// Quelle: OpenStreetMap (Overpass API) – öffentliche Firmeneinträge mit Website, Gebiete und Branchen konfigurierbar.
// Gebiete: die GANZE SCHWEIZ (26 Kantone, alle Gemeinden, Rotation Kanton → Gemeinde → Branche, swiss-areas.js). Ketten/Konzerne (OSM-Tag brand)
// werden übersprungen. Wenige gedrosselte Suchen je Lauf; qualifizierte Leads landen dauerhaft in der Lead-Datenbank (lead-registry.js).
//
//   node lead-finder.js --once     genau ein Such-/Prüflauf (eigenes Lock, unabhängig von server.js)
//   node lead-finder.js --report   Übersicht über gefundene Leads
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditor } from "./site-auditor.js";
import { swissSignals, qualifyRepairLead, ensureColdDraft, discoverBusinessContact, PLACEHOLDER_RE, REVIEWS_FILE } from "./swiss-repair.js";
import { WORKER_DIR, createStore, createLogger, acquireLock, releaseLock, heartbeat, legalBasis, normEmail, zurichDay } from "./mail-worker.js";
import { loadGeo, saveGeo, nextJob, advance, enqueue, coverage, categoryKey, categoryLabel, matchCategory, findMunicipality, GEO_FILE } from "./swiss-areas.js";
import { knownKeys, recordLead, registryBlock, fromDiscovered, TRACKED_DISCOVERY } from "./lead-registry.js";

export const DISCOVERY_LOCK = "discovery.lock";
// Overpass verlangt eine erkennbare Anwendung als User-Agent (generische Browser-Kennungen werden mit 406 abgelehnt).
const OVERPASS_UA = "JarvisLeadFinder/1.0 (Helvetic Webdesign; https://helvetic-webdesign.ch)";
// 24/7-Discovery (VPS): ein Lauf alle intervalMinutes, rund um die Uhr, mit zentralen Sicherheitslimits (Websites je Stunde/Tag), begrenzter
// Parallelität (maxConcurrency, pro Domain höchstens eine aktive Prüfung) und Backoff bei 429/5xx/Netzwerkfehlern der Datenquelle.
// Datenquelle (Overpass) und Website-Audits werden getrennt limitiert. Alle Werte per config.json → discovery überschreibbar.
export const DEFAULT_DISCOVERY = {
  enabled: true,
  intervalMinutes: 20, // ein Lauf alle 20 Minuten (24/7), nie eine Endlosschleife
  sitesPerRun: 105,    // 105 × 3 Läufe = 315 je Stunde
  maxSitesPerHour: 315,
  maxSitesPerDay: 7500, // harter Prüfdeckel: 7500 unterschiedliche Websites pro Tag
  maxConcurrency: 6,    // gleichzeitige Website-Audits (zentral einstellbar, VPS-Benchmark: kleinste stabile Zahl); nie unbegrenzt
  runBudgetMinutes: 19, // nach dieser Zeit werden keine neuen Audits mehr gestartet (der nächste Zyklus macht weiter)
  auditTotalMs: 90_000, // Zeitbudget je Website für Zusatzprüfungen (Links/Bilder)
  // Datenquelle (Overpass): höchstens maxSearchesPerRun Abfragen je Lauf, mindestens searchMinGapMs Abstand, nie parallel.
  maxSearchesPerRun: 6,
  searchLimit: 250,     // Treffer je Abfrage
  searchMinGapMs: 6000,
  pairRetryHours: 72,   // Ort/Branche ohne neue Firmen wird so lange nicht erneut abgefragt (keine Firma unnötig erneut prüfen)
  // KEIN geschäftliches Maximum für Cold-Entwürfe: null = unbegrenzt. Jeder qualifizierte Lead wird persistent zur Entwurfserstellung
  // vorgemerkt (individual_reviews.json, Status queued → draft_created). Nur technisches Pacing gegenüber der Gmail-API (unten).
  maxDraftsPerHour: null,
  maxDraftsPerDay: null,
  draftPaceMs: 1500,    // technische Pause zwischen zwei Gmail-Entwürfen (API-Schonung) – verschiebt nur, verwirft nie
  draftsPerPass: 25,    // technisch je Worker-Durchlauf (alle 2 min) – Rest bleibt in der Queue, nichts geht verloren
  backoffMinutes: 15,   // nach Quellenfehler: 15 → 30 → 60 … bis backoffMaxMinutes (Retry-After der Quelle hat Vorrang, wenn länger)
  backoffMaxMinutes: 360,
  minScore: 6,
  // Gebiete: GANZE SCHWEIZ (26 Kantone, alle Gemeinden aus data/swiss-municipalities.json, Rotation in swiss-areas.js / discovery_geo.json).
  // Nur wenn config.json → discovery.areas ausdrücklich eine Liste enthält, gilt der alte Modus mit fester Ortsliste (Tests/Fehlersuche).
  maxSplitSearchesPerRun: 2,  // höchstens so viele Folgeabfragen (Gemeinde → Branche, grosse Gemeinden) je Lauf – Rest kommt reihum aus allen Kantonen
  maxAuditsPerAreaPerRun: 35, // Fairness: aus EINER Abfrage höchstens so viele neue Firmen je Lauf (Rest folgt später per Folgeabfrage)
  categories: [
    { key: "craft" }, { key: "shop" }, { key: "office", value: "company" }, { key: "office", value: "estate_agent" },
    { key: "amenity", value: "restaurant" }, { key: "amenity", value: "dentist" }, { key: "healthcare", value: "physiotherapist" },
    { key: "tourism", value: "hotel" }, { key: "office", value: "accountant" }, { key: "shop", value: "hairdresser" },
    { key: "office", value: "lawyer" }, { key: "office", value: "architect" }, { key: "office", value: "insurance" }, { key: "office", value: "tax_advisor" },
    { key: "office", value: "it" }, { key: "office", value: "consulting" }, { key: "amenity", value: "cafe" }, { key: "amenity", value: "doctors" },
    { key: "amenity", value: "veterinary" }, { key: "leisure", value: "fitness_centre" }, { key: "tourism", value: "guest_house" }, { key: "shop", value: "car_repair" },
    { key: "shop", value: "beauty" }, { key: "healthcare", value: "doctor" },
  ],
  excludeDomains: [], // z. B. bekannte Grosskonzerne oder Chris’ eigene Kunden
  overpassUrl: "https://overpass-api.de/api/interpreter",
};
// Keine eigene Firmenwebsite: Social-Media-/Verzeichnis-/Plattformseiten werden vor dem Audit verworfen (Firmen mit eigener Website zuerst).
const PLATFORM_RE = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|xing|pinterest|tripadvisor|booking|google|goo|linktr|yelp|local|search|moneyhouse|zefix|wikipedia|business)\.[a-z.]+$/i;

const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|bluewin|hispeed|sunrise|protonmail|proton|yandex|aol)\.[a-z.]+$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PRIVATE_RE = /\b(privat(e|seite)?|hobby|familie|family|mein blog|my blog|fotoalbum|hochzeit|wedding|portfolio von)\b/i;
const LEGAL_FORM = /\b(ag|gmbh|sa|s[àa]rl|sagl|kg|klg|e\.?\s?k\.?|ltd|inc|co|und|&|et)\b/g;

export const normDomain = (u = "") => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
export const normCompany = (s = "") => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(LEGAL_FORM, " ").replace(/[^a-z0-9]+/g, " ").trim();
const emailDomain = (e) => normEmail(e).split("@")[1] || "";
const strip = (html = "") => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");

// ---------- Suche (Overpass / OpenStreetMap) ----------

// Quellen-Limiter: Abfragen laufen nie parallel, mit Mindestabstand (minGapMs). 429/502/503/504: Retry-After der Quelle wird respektiert
// (bis maxWaitMs im Lauf, länger → Fehler mit retryAfterMs, der Lauf geht in Backoff), sonst exponentielle Pause (retryMs · 2^n), höchstens maxRetries.
export const parseRetryAfter = (v, nowMs = Date.now()) => {
  if (v == null || v === "") return null;
  if (/^\d+$/.test(String(v).trim())) return Math.min(+v * 1000, 86_400_000);
  const d = Date.parse(v); return Number.isFinite(d) ? Math.max(0, Math.min(d - nowMs, 86_400_000)) : null;
};
export function overpassSearch({ fetchFn = globalThis.fetch, url = DEFAULT_DISCOVERY.overpassUrl, retryMs = 30_000, minGapMs = 0, maxRetries = 2, maxWaitMs = 120_000,
  sleep = (ms) => new Promise((res) => setTimeout(res, ms)) } = {}) {
  let lastAt = 0, tail = Promise.resolve();
  const gate = async () => { const wait = lastAt + minGapMs - Date.now(); if (wait > 0) await sleep(wait); lastAt = Date.now(); };
  const q = (s) => String(s).replace(/["\\]/g, "");
  const tagFilter = (c) => (c.value ? `["${q(c.key)}"="${q(c.value)}"]` : `["${q(c.key)}"]`);
  const WEB = `[~"^(website|contact:website)$"~"."]`;
  const ask = async (query) => {
    let r;
    for (let attempt = 0; ; attempt++) {
      await gate();
      r = await fetchFn(url, { method: "POST", headers: { "user-agent": OVERPASS_UA, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(90_000) });
      lastAt = Date.now();
      if (![429, 502, 503, 504].includes(r.status)) break;
      const ra = parseRetryAfter(r.headers?.get?.("retry-after"));
      const wait = ra ?? retryMs * 2 ** attempt;
      if (attempt >= maxRetries || wait > maxWaitMs) { const e = new Error(`Overpass HTTP ${r.status}`); e.retryAfterMs = ra; throw e; }
      await sleep(wait);
    }
    if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
    return (await r.json()).elements || [];
  };
  // Schweiz-Modus: Gemeinde eindeutig über die BFS-Gemeindenummer (keine Verwechslung gleichnamiger Orte); eine Abfrage über mehrere Branchen.
  // Findet Overpass die Gemeindefläche nicht (Tag fehlt), einmal über den Namen innerhalb des Kantons. Das Ergebnis meldet, ob die Fläche
  // gefunden wurde und ob das Trefferlimit erreicht ist (meta.saturated → Folgeabfragen je Branche).
  const one = async ({ area, category, categories, limit = 60, bfs = null, canton = null, osmName = null }) => {
    const cats = Array.isArray(categories) && categories.length ? categories : [category];
    const body = cats.length === 1 ? `nwr(area.a)${tagFilter(cats[0])}${WEB};` : `(${cats.map((c) => `nwr(area.a)${tagFilter(c)}${WEB};`).join("")});`;
    const legacy = `[out:json][timeout:60];area["name"="${q(area)}"]["boundary"="administrative"]->.a;${body}out tags ${limit};`;
    const byBfs = `[out:json][timeout:90];(area["boundary"="administrative"]["admin_level"="8"]["ref:bfs_Gemeindenummer"="${Number(bfs)}"];area["boundary"="administrative"]["admin_level"="8"]["swisstopo:BFS_NUMMER"="${Number(bfs)}"];)->.a;.a out ids;${body}out tags ${limit};`;
    const byName = `[out:json][timeout:90];area["ISO3166-2"="CH-${q(canton)}"]["admin_level"="4"]->.c;rel(area.c)["boundary"="administrative"]["admin_level"="8"]["name"="${q(osmName || area)}"];map_to_area->.a;.a out ids;${body}out tags ${limit};`;
    let elements = await ask(bfs ? byBfs : legacy);
    let areaFound = !bfs || elements.some((e) => e.type === "area");
    if (bfs && !areaFound && canton) { elements = await ask(byName); areaFound = elements.some((e) => e.type === "area"); }
    const hits = elements.filter((e) => e.type !== "area");
    const label = cats.length === 1 ? categoryKey(cats[0]) : null;
    const list = hits.map((e) => {
      const cat = label || matchCategory(e.tags || {}, cats) || null;
      return {
        company: e.tags?.name || "", website: e.tags?.website || e.tags?.["contact:website"] || "",
        email: e.tags?.email || e.tags?.["contact:email"] || "", chain: !!(e.tags?.brand || e.tags?.["brand:wikidata"]), category: cat,
        source: `OpenStreetMap ${e.type}/${e.id} (${area}, ${cat || "mehrere"})`,
      };
    });
    Object.defineProperty(list, "meta", { value: { areaFound, saturated: hits.length >= limit } });
    return list;
  };
  return (args) => { const p = tail.then(() => one(args)); tail = p.catch(() => {}); return p; }; // strikt nacheinander
}

// ---------- Firmenidentität (nur offizielle Seiten der Firma) ----------

export function extractIdentity(pages = {}, domain = "") {
  const sources = [["impressum", pages.impressum], ["kontakt", pages.contact], ["startseite", pages.home]].filter(([, h]) => h);
  const emails = [];
  for (const [where, html] of sources) {
    const found = [...(html.match(/mailto:([^"'?>\s]+)/gi) || []).map((m) => m.slice(7)), ...(strip(html).match(EMAIL_RE) || [])];
    for (const e of found) {
      const em = normEmail(decodeURIComponent(e));
      if (!/\.(png|jpe?g|gif|svg|webp)$/i.test(em) && !emails.some((x) => x.email === em)) emails.push({ email: em, where });
    }
  }
  // Bevorzugt: Adresse auf der Firmendomain, dann generische Geschäftsadressen.
  const own = emails.filter((e) => emailDomain(e.email) === domain || emailDomain(e.email).endsWith("." + domain));
  const pick = own.find((e) => /^(info|kontakt|contact|office|mail|hallo|hello|post)@/.test(e.email)) || own[0] || null;
  const imp = pages.impressum ? strip(pages.impressum) : "";
  const uid = (imp || strip(pages.home || "")).match(/CHE[-\s]?\d{3}\.\d{3}\.\d{3}/)?.[0] || null;
  // Inhaber nur, wenn das Impressum ihn ausdrücklich so bezeichnet – sonst wird nicht geraten.
  const owner = imp.match(/(?:Inhaber(?:in)?|Geschäftsführer(?:in)?|Geschäftsführung|Geschäftsleitung)\s*:?\s*([A-ZÄÖÜ][a-zäöüéèàç]+(?:[ -][A-ZÄÖÜ][a-zäöüéèàç]+){1,2})(?=\s*(?:\n|,|$))/m)?.[1] || null;
  const company = imp.match(/^\s*([^\n]{2,80}?\b(?:AG|GmbH|SA|Sàrl|Sagl|KlG|KG))\s*$/m)?.[1]?.trim() || null;
  return { email: pick?.email || null, emailSource: pick?.where || null, otherEmails: emails.filter((e) => e !== pick).map((e) => e.email).slice(0, 5), uid, owner, company, hasImpressum: !!pages.impressum };
}

// ---------- Bewertung (nachvollziehbar, nur aus dokumentierten Kriterien) ----------

const POINTS = { high: 3, medium: 2, low: 1 };
export function scoreLead({ issues = [], identity = {}, company, reachable }) {
  const details = [];
  const issuePts = Math.min(10, issues.reduce((s, i) => s + (POINTS[i.severity] || 0), 0));
  if (issuePts) details.push(`+${issuePts} Website-Probleme (${issues.length})`);
  let score = issuePts;
  const add = (pts, why) => { score += pts; details.push(`${pts > 0 ? "+" : ""}${pts} ${why}`); };
  if (company) add(2, "Firmenname bekannt");
  if (identity.uid) add(2, `UID ${identity.uid} im Impressum (aktive Firma)`);
  if (identity.hasImpressum) add(1, "Impressum vorhanden");
  if (identity.email) add(2, "Geschäftsadresse auf eigener Domain");
  if (!reachable) add(-3, "Website nicht erreichbar – Aktivität nicht belegbar");
  return { score, details };
}

// ---------- Lauf ----------

// ---------- 24/7-Steuerung: Pause/Fortsetzen, Backoff, Stundenbudget, Status fürs Dashboard ----------
export const discoveryConfig = (store) => ({ ...DEFAULT_DISCOVERY, ...(store.read("config.json", {}).discovery || {}) });
const hourKey = (t) => new Date(t).toISOString().slice(0, 13); // UTC-Stunde als Schlüssel
const SOURCE_ERROR_RE = /HTTP (429|5\d\d)|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout|TimeoutError|aborted|network/i;
const COUNTER_FILE = "discovery_counter.json";   // winziger Zähler, bei JEDER Reservierung geschrieben: Tages-/Stundendeckel überleben auch einen Absturz
const INDEX_FILE = "audited_index.json";         // kompakter Dedupe-Index bereits geprüfter, nicht qualifizierter Domains (älter als der aktuelle Tag)
const ARCHIVABLE = new Set(["no_issues", "low_score", "no_contact", "excluded_private", "excluded_no_company", "duplicate", "suppressed", "audit_error"]);
const INDEX_KEEP_DAYS = 90;                      // danach darf eine Domain wieder geprüft werden (Audit nicht mehr aktuell)
const pairKey = (p) => `${p.area}|${p.category.key}=${p.category.value || ""}`;

// Zähler für Tag/Stunde: das Maximum aus discovered.json und dem Zählerfile (Absturz-sicher, nie zu niedrig).
function readCounter(store, day, hk) {
  const c = store.read(COUNTER_FILE, {});
  return { day: c.day === day ? c.audited || 0 : 0, hour: c.hour === hk ? c.hourAudited || 0 : 0 };
}
const writeCounter = (store, day, hk, audited, hourAudited) => store.write(COUNTER_FILE, { day, audited, hour: hk, hourAudited }, { compact: true });

// Pause/Fortsetzen (Server Control discovery.pause / discovery.resume): nur ein Flag, keine Daten werden gelöscht.
export function setDiscoveryPaused(dir, paused, { now = new Date(), reason = "server_control" } = {}) {
  const store = createStore(dir);
  const data = { leads: {}, cursor: 0, lastRunAt: null, stats: {}, ...store.read("discovered.json", {}) };
  data.paused = !!paused;
  data.pausedAt = paused ? now.toISOString() : null;
  data.pausedBy = paused ? reason : null;
  store.write("discovered.json", data, { compact: true });
  return { paused: data.paused, pausedAt: data.pausedAt };
}
// Status für HUD/Mobile (nur Zahlen, Zeitpunkte, feste Wörter, bereinigter Fehlertext).
export function discoveryStatus(dir = WORKER_DIR, now = new Date()) {
  const store = createStore(dir);
  const cfg = discoveryConfig(store);
  const data = { leads: {}, stats: {}, ...store.read("discovered.json", {}) };
  const reviews = Object.values(store.read(REVIEWS_FILE, { reviews: {} }).reviews || {});
  const dayStart = zurichDay(now), hk = hourKey(now);
  const ctr = readCounter(store, dayStart, hk);
  const today = data.stats?.[dayStart] || {};
  const h = data.hourly?.[hk] || {};
  const auditedToday = Math.max(today.audited || 0, ctr.day), auditedHour = Math.max(h.audited || 0, ctr.hour);
  const backoffActive = !!data.backoffUntil && Date.parse(data.backoffUntil) > +now;
  const lastRun = data.lastRunAt ? Date.parse(data.lastRunAt) : null;
  const next = data.paused ? null : backoffActive ? data.backoffUntil : new Date(Math.max(+now, (lastRun || 0) + cfg.intervalMinutes * 60_000)).toISOString();
  const draftsToday = reviews.filter((r) => r.created_at && zurichDay(new Date(r.created_at)) === dayStart).length;
  const draftsHour = reviews.filter((r) => r.created_at && +now - Date.parse(r.created_at) < 3_600_000).length;
  const dw = store.read(REVIEWS_FILE, { reviews: {} }).draft_worker || {};
  const dwBackoff = !!dw.backoffUntil && Date.parse(dw.backoffUntil) > +now;
  const gmailToday = reviews.filter((r) => r.draft_created_at && zurichDay(new Date(r.draft_created_at)) === dayStart).length;
  // Discovery-Rate: tatsächlich geprüfte Websites der letzten 60 Minuten (aus den Lauf-Protokollen).
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const rate = runs.filter((r) => r.end && +now - Date.parse(r.end) < 3_600_000).reduce((s, r) => s + (r.audited || 0), 0);
  const lr = runs.length ? runs[runs.length - 1] : null;
  return {
    status: !cfg.enabled ? "DISABLED" : data.paused ? "PAUSED" : backoffActive ? "BACKOFF" : "ACTIVE",
    paused: !!data.paused, paused_at: data.pausedAt || null,
    // Websites: harter Prüfdeckel je Tag/Stunde; Leads: qualifiziert = persistent zur Entwurfserstellung vorgemerkt (kein Business-Cap).
    audited_today: auditedToday, websites_limit: cfg.maxSitesPerDay, websites_hour_limit: cfg.maxSitesPerHour,
    new_leads_today: today.found || 0, qualified_today: today.qualified || 0,
    qualified_total: reviews.length,
    drafts_today: draftsToday, drafts_hour: draftsHour, blocked_today: today.blocked || 0, errors_today: today.errors || 0,
    audited_hour: auditedHour,
    last_run_audited: lr ? lr.audited || 0 : null, last_run_duration_s: lr ? lr.duration_s ?? null : null, discovery_rate_per_hour: rate,
    max_concurrency: cfg.maxConcurrency, pool_exhausted: !!data.poolExhausted,
    // Schweiz-Abdeckung: 26 Kantone, alle Gemeinden, Zyklus/Fortschritt der geografischen Rotation (discovery_geo.json)
    coverage: Array.isArray(cfg.areas) ? { mode: "AREAS", areas: cfg.areas.length } : coverage(store.read(GEO_FILE, null)),
    last_run_at: data.lastRunAt || null, next_run_at: next, backoff_until: backoffActive ? data.backoffUntil : null, backoff_count: data.backoffCount || 0,
    queue: reviews.filter((r) => r.status === "queued").length, // = waiting_for_draft
    waiting_for_draft: reviews.filter((r) => r.status === "queued").length,
    gmail_drafts_today: gmailToday,
    open_drafts_total: reviews.filter((r) => r.status === "draft_created").length,
    draft_worker: { status: dwBackoff ? "BACKOFF" : "ACTIVE", backoff_until: dwBackoff ? dw.backoffUntil : null, backoff_count: dw.backoffCount || 0, last_draft_at: dw.lastDraftAt || null,
      last_error: dw.lastError ? { at: dw.lastError.at, message: String(dw.lastError.message || "").slice(0, 160) } : null },
    last_error: data.lastError ? { at: data.lastError.at, stage: data.lastError.stage, message: String(data.lastError.message || "").slice(0, 160) } : null,
    limits: { interval_minutes: cfg.intervalMinutes, sites_per_run: cfg.sitesPerRun, max_sites_per_hour: cfg.maxSitesPerHour, max_sites_per_day: cfg.maxSitesPerDay,
      max_drafts_per_hour: null, max_drafts_per_day: null, draft_pace_ms: cfg.draftPaceMs, drafts_per_pass: cfg.draftsPerPass, max_concurrency: cfg.maxConcurrency }, // null = kein Business-Cap
  };
}

export async function runDiscovery({ dir = WORKER_DIR, gmail, search, auditor, now = () => new Date(), log = createLogger(dir), pid = process.pid, force = false } = {}) {
  const store = createStore(dir);
  const cfg = discoveryConfig(store);
  if (!cfg.enabled && !force) return { skipped: "disabled" };
  const data = { leads: {}, cursor: 0, lastRunAt: null, stats: {}, hourly: {}, ...store.read("discovered.json", {}) };
  const t = now(), day = zurichDay(t), hk = hourKey(t);
  if (data.paused && !force) return { skipped: "paused" };
  if (!force && data.backoffUntil && Date.parse(data.backoffUntil) > +t) return { skipped: "backoff", until: data.backoffUntil };
  if (!force && data.lastRunAt && +t - Date.parse(data.lastRunAt) < cfg.intervalMinutes * 60_000) return { skipped: "not_due" };
  data.hourly = Object.fromEntries(Object.entries(data.hourly || {}).filter(([k]) => +t - Date.parse(k + ":00:00Z") < 2 * 3_600_000)); // nur aktuelle Stunden
  const hour = (data.hourly[hk] ||= { audited: 0, drafts: 0 });
  const stats = (data.stats[day] ||= { found: 0, audited: 0, withIssues: 0, qualified: 0, errors: 0, blocked: 0, drafts: 0 });
  stats.blocked ??= 0; stats.drafts ??= 0;
  // Deckel gelten für das Maximum aus Statistik und Zählerfile – nie zu niedrig, auch nach Absturz/Neustart.
  const ctr = readCounter(store, day, hk);
  stats.audited = Math.max(stats.audited, ctr.day); hour.audited = Math.max(hour.audited, ctr.hour);
  if (!force && hour.audited >= cfg.maxSitesPerHour) return { skipped: "hour_limit" };
  if (!acquireLock(dir, { pid, name: DISCOVERY_LOCK })) return { busy: true };
  let lastSave = 0;
  const writeAll = () => {
    // nur die letzten 14 Tage Statistik behalten
    for (const d of Object.keys(data.stats).sort().slice(0, -14)) delete data.stats[d];
    store.write("discovered.json", data, { compact: true });
    heartbeat(dir, pid, DISCOVERY_LOCK);
    lastSave = Date.now();
  };
  const save = ({ force: f = true } = {}) => { if (f || Date.now() - lastSave > 5_000) writeAll(); }; // während des Laufs höchstens alle 5 s (grosse Datei), am Ende immer
  // Backoff bei Quellenfehlern (429/5xx/Netz): 15 → 30 → 60 … min, gedeckelt; Retry-After der Quelle hat Vorrang, wenn länger.
  const backoff = (stage, e) => {
    data.backoffCount = (data.backoffCount || 0) + 1;
    let minutes = Math.min(cfg.backoffMaxMinutes, cfg.backoffMinutes * 2 ** (data.backoffCount - 1));
    if (e?.retryAfterMs) minutes = Math.min(cfg.backoffMaxMinutes, Math.max(minutes, Math.ceil(e.retryAfterMs / 60_000)));
    data.backoffUntil = new Date(+t + minutes * 60_000).toISOString();
    data.lastError = { at: t.toISOString(), stage, message: String(e.message || e).slice(0, 160) };
    log("warn", "discovery_backoff", { stage, minutes, count: data.backoffCount });
  };
  const out = { day, query: null, found: [], errors: [], searches: 0, audited: 0 };
  const startedAt = Date.now();
  try {
    search ||= overpassSearch({ url: cfg.overpassUrl, minGapMs: cfg.searchMinGapMs });
    auditor ||= createAuditor({ totalMs: cfg.auditTotalMs });

    // Täglich einmal: nicht qualifizierte Leads früherer Tage in den kompakten Dedupe-Index auslagern (discovered.json bleibt klein und schnell).
    const index = store.read(INDEX_FILE, { domains: {} });
    if (data.archivedDay !== day) {
      const cutoff = new Date(+t - INDEX_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      for (const [d, v] of Object.entries(index.domains)) if (v < cutoff) delete index.domains[d];
      for (const [d, l] of Object.entries(data.leads)) {
        if (ARCHIVABLE.has(l.status) && l.discoveredAt && zurichDay(new Date(l.discoveredAt)) < day) {
          // audit_error (Netz/Timeout) ist kein belastbarer Audit: schon nach 7 statt 90 Tagen wieder prüfbar
          index.domains[d] = zurichDay(new Date(+new Date(l.discoveredAt) - (l.status === "audit_error" ? INDEX_KEEP_DAYS - 7 : 0) * 86_400_000));
          delete data.leads[d];
        }
      }
      store.write(INDEX_FILE, index, { compact: true }); // erst der Index, dann discovered.json: bei Absturz höchstens doppelt vorhanden
      data.archivedDay = day;
    }

    // Gebiete: GANZE SCHWEIZ (Standard) oder – nur wenn config.json → discovery.areas gesetzt ist – die alte feste Ortsliste.
    const swiss = !Array.isArray(cfg.areas);
    const pairs = swiss ? [] : cfg.areas.flatMap((area) => cfg.categories.map((category) => ({ area, category })));
    if (!swiss && !pairs.length) { data.lastRunAt = t.toISOString(); save(); return { ...out, skipped: "no_areas" }; }
    if (swiss) delete data.pairs; // alte Ort/Branche-Paare: die Rotation liegt jetzt in discovery_geo.json
    else data.pairs ||= {};
    data.lastRunAt = t.toISOString();

    // Bekanntes: gefundene Leads, Chris’ Lead-Liste, eigene Jarvis-Threads, Suppression (hat immer Vorrang)
    // und die LEAD-DATENBANK (lead_registry.json): bereits angeschriebene/beantwortete/gesperrte Firmen und Kunden werden nie wieder neu geprüft.
    const leadsFile = store.read("leads.json", []);
    const reg = gmail?.listOwned?.() || { sent: {}, drafts: {} };
    const supp = store.read("suppression.json", {});
    const known = { domains: new Set(Object.keys(index.domains)), emails: new Set(), companies: new Set() };
    const remember = (domain, email, company) => {
      if (domain) known.domains.add(domain);
      if (email) { known.emails.add(normEmail(email)); if (!FREEMAIL.test(emailDomain(email))) known.domains.add(emailDomain(email)); }
      if (company && normCompany(company)) known.companies.add(normCompany(company));
    };
    for (const l of Object.values(data.leads)) remember(l.domain, l.email, l.company);
    const kk = knownKeys(store);
    for (const d of kk.domains) known.domains.add(d);
    for (const e of kk.emails) known.emails.add(e);
    for (const c of kk.companies) known.companies.add(c);
    const contacted = new Set([...Object.values(reg.sent || {}), ...Object.values(reg.drafts || {})].map((s) => normEmail(s.to)));
    const suppressedDomains = new Set(Object.keys(supp).map(emailDomain).filter((d) => d && !FREEMAIL.test(d)));
    const exclude = new Set(cfg.excludeDomains.map(normDomain));
    const sender = store.read("config.json", {}).sender;

    // Wie viele Websites dürfen in diesem Lauf noch geprüft werden (Lauf-, Stunden- und Tagesdeckel)?
    const quota = () => Math.min(cfg.sitesPerRun - out.audited, cfg.maxSitesPerDay - stats.audited, cfg.maxSitesPerHour - hour.audited);
    if (stats.audited >= cfg.maxSitesPerDay) { save(); return { ...out, skipped: "day_limit" }; }

    // ---- 1) Quelle: nacheinander (nie parallel) Gebiete/Branchen abfragen, bis genug NEUE Firmen mit eigener Website vorliegen ----
    const pending = [], seen = new Set();
    const want = Math.max(0, quota());
    let sourceError = null, searchFails = 0;
    // Kandidaten einer Abfrage übernehmen (früh verwerfen, Dedupe); cap = Fairness je Gebiet. Liefert { fresh, more }.
    const take = (candidates, geo, cap = Infinity) => {
      let fresh = 0, more = false;
      for (const c of candidates) {
        const domain = normDomain(c.website);
        // früh verwerfen: keine eigene Firmenwebsite / Kette / Freemail / ausgeschlossen / ohne Firmenname
        if (!domain || c.chain || exclude.has(domain) || FREEMAIL.test(domain) || PLATFORM_RE.test(domain) || !String(c.company || "").trim()) continue;
        if (known.domains.has(domain) || seen.has(domain) || (c.company && known.companies.has(normCompany(c.company)))) continue; // Duplikat / aktuell geprüft / in der Lead-Datenbank
        if (fresh >= cap) { more = true; break; }
        seen.add(domain); fresh++;
        pending.push({ c, domain, osmEmail: c.email && emailDomain(c.email) === domain, geo: { ...geo, ...(c.category ? { category: c.category } : {}) } });
      }
      return { fresh, more };
    };
    const searchFailed = (e, query) => {
      stats.errors++; out.errors.push({ stage: "search", error: e.message }); log("error", "discovery_search_failed", { query, error: e.message });
      // 429 / Retry-After / zweiter Fehler im Lauf = Quelle überlastet → Abbruch + Backoff. Ein einzelner 5xx/Timeout (z. B. zu schwere Abfrage) betrifft nur dieses Gebiet.
      return ++searchFails >= 2 || /HTTP 429/.test(e.message) || !!e.retryAfterMs;
    };
    if (swiss) {
      // GANZE SCHWEIZ: Hauptcursor reihum durch alle Kantone/Gemeinden, Folgeabfragen (Gemeinde → Branche) begrenzt – Cursor persistent nach JEDER Abfrage.
      const g = loadGeo(store, t);
      for (let slot = 0, splitUsed = 0; pending.length < want && slot < cfg.maxSearchesPerRun; slot++) {
        const job = nextJob(g, { slot, splitUsed, maxSplit: cfg.maxSplitSearchesPerRun, now: t });
        if (job.fromQueue) splitUsed++;
        const m = job.m, cat = job.cat != null ? cfg.categories[job.cat] : null;
        out.searches++;
        out.query = `${m.canton} / ${m.name}${cat ? " / " + categoryLabel(categoryKey(cat)) : ""}`;
        let candidates = [];
        try { candidates = await search({ area: m.name, osmName: m.osmName, bfs: m.bfs, canton: m.canton, category: cat || cfg.categories[0], categories: cat ? [cat] : cfg.categories, limit: cfg.searchLimit }); data.backoffCount = 0; data.backoffUntil = null; }
        catch (e) {
          const stop = searchFailed(e, out.query);
          // Gebiet nicht verlieren: genau ein späterer Versuch (frühestens nach 6 h); der Hauptcursor geht weiter, damit keine Gemeinde die Rotation blockiert.
          if ((job.tries || 0) < 1) enqueue(g, { bfs: m.bfs, cat: job.cat, kind: "retry", retryAt: new Date(+t + 6 * 3_600_000).toISOString(), tries: (job.tries || 0) + 1 });
          if (!job.fromQueue) advance(g, m, t);
          saveGeo(store, g);
          if (stop) { sourceError = e; break; }
          continue;
        }
        const geo = { canton: m.canton, municipality: m.name, municipality_bfs: m.bfs, language: m.language, ...(cat ? { category: categoryKey(cat) } : {}) };
        const { more } = take(candidates, geo, cfg.maxAuditsPerAreaPerRun);
        // Gesättigt (Trefferlimit) → je Branche weiter (Gemeinde → Branche); mehr Neues als der Fairness-Deckel → dieselbe Abfrage später erneut.
        // Folgeabfragen frühestens im NÄCHSTEN Lauf (nie mehrfach dasselbe Gebiet in einem Lauf).
        const later = new Date(+t + 1).toISOString();
        if (candidates.meta?.saturated && job.cat == null) cfg.categories.forEach((_, i) => enqueue(g, { bfs: m.bfs, cat: i, retryAt: later }));
        else if (more || candidates.meta?.saturated) enqueue(g, { bfs: m.bfs, cat: job.cat, retryAt: later });
        if (candidates.meta && candidates.meta.areaFound === false) log("warn", "discovery_area_not_found", { bfs: m.bfs, municipality: m.name });
        if (!job.fromQueue) advance(g, m, t);
        saveGeo(store, g);
        if (!force) save({ force: false });
      }
      data.poolExhausted = false; // die Schweiz-Rotation beginnt nach jedem Zyklus neu (Dedupe-/Audit-Alter-Regeln gelten)
    } else {
      const stale = (k) => { const p = data.pairs[k]; return p && p.fresh === 0 && +t - Date.parse(p.at) < (p.error ? 6 : cfg.pairRetryHours) * 3_600_000; }; // nichts Neues (bzw. Abfrage fehlgeschlagen: 6 h) → nicht erneut abfragen
      for (let tries = 0, queried = 0; pending.length < want && queried < cfg.maxSearchesPerRun && tries < pairs.length; tries++) {
        const pair = pairs[data.cursor % pairs.length];
        data.cursor = (data.cursor + 1) % pairs.length;
        if (stale(pairKey(pair))) continue;
        queried++; out.searches++;
        out.query = `${pair.area} / ${pair.category.key}${pair.category.value ? "=" + pair.category.value : ""}`;
        let candidates = [];
        try { candidates = await search({ ...pair, limit: cfg.searchLimit }); data.backoffCount = 0; data.backoffUntil = null; }
        catch (e) {
          data.pairs[pairKey(pair)] = { at: t.toISOString(), fresh: 0, total: 0, error: true };
          if (searchFailed(e, out.query)) { sourceError = e; break; }
          continue;
        }
        const muni = findMunicipality(pair.area);
        const geo = { ...(muni ? { canton: muni.canton, municipality: muni.name, municipality_bfs: muni.bfs, language: muni.language } : {}), category: categoryKey(pair.category) };
        const { fresh } = take(candidates, geo);
        data.pairs[pairKey(pair)] = { at: t.toISOString(), fresh, total: candidates.length };
        if (!force) save({ force: false });
      }
      data.poolExhausted = !sourceError && pending.length < want && pairs.every((p) => stale(pairKey(p)));
    }
    if (sourceError) {
      backoff("search", sourceError);
      if (!pending.length) { save(); return out; } // nichts zu prüfen: kein aggressives Wiederholen, Backoff gilt
    }
    // Firmen mit belegter Geschäftsadresse (OSM) zuerst – dort ist die Chance auf einen qualifizierten Lead am höchsten.
    pending.sort((a, b) => (b.osmEmail ? 1 : 0) - (a.osmEmail ? 1 : 0));

    // ---- 2) Audits: begrenzte Parallelität (maxConcurrency), pro Domain höchstens eine aktive Prüfung, Reservierung atomar ----
    const active = new Set();
    const slots = [];
    let next = 0, peak = 0, auditMs = 0;
    const deadline = startedAt + cfg.runBudgetMinutes * 60_000;
    const claim = () => {
      while (next < pending.length) {
        if (quota() <= 0 || Date.now() > deadline) return null;
        const idx = next++, item = pending[idx], { c, domain } = item;
        // zwischen Suche und Start kann ein Zwilling (gleiche Firma, andere Domain) beansprucht worden sein → synchron neu prüfen
        if (active.has(domain) || known.domains.has(domain) || (c.company && known.companies.has(normCompany(c.company)))) continue;
        active.add(domain); remember(domain, null, c.company);
        out.audited++; stats.audited++; hour.audited++; stats.found++;
        writeCounter(store, day, hk, stats.audited, hour.audited); // Reservierung sofort festhalten: 7500 gilt hart
        return { ...item, idx };
      }
      return null;
    };
    const processOne = async ({ c, domain, idx, geo = {} }) => {
      const lead = {
        email: null, name: null, company: c.company || null, website: `https://${domain}/`, domain,
        approved: false, discoverySource: c.source, discoveredAt: t.toISOString(),
        // Gebiet + Branche (Schweiz-Index): Kanton, Gemeinde (BFS-Nr.), Sprachregion, OSM-Branche
        canton: geo.canton || null, municipality: geo.municipality || null, municipality_bfs: geo.municipality_bfs || null, language: geo.language || null, category: geo.category || null,
        websiteIssues: [], auditScore: 0, scoreDetails: [],
        consentBasis: null, consentAt: null, consentSource: null, existingCustomer: false, similarService: false,
        status: "discovered",
      };
      try {
        const a = await auditor.audit(c.website);
        const id = extractIdentity(a.pages, domain);
        const osmEmail = c.email && emailDomain(c.email) === domain ? normEmail(c.email) : null;
        // TF-025: geschäftlicher Kontakt nur von den öffentlichen Firmenseiten (Team, Impressum, Kontakt, Startseite) bzw. OSM.
        // Bevorzugt: zuständige Person (Web/Marketing/IT) > Geschäftsführung > andere Person > info@. Nie Freemail/Privatadressen.
        const bc = discoverBusinessContact({ pages: a.pages || {}, domain, osmEmail, osmSource: c.source, owner: id.owner, now: t,
          urls: { team: a.teamUrl, impressum: a.impressumUrl, kontakt: a.contactUrl, startseite: a.finalUrl || lead.website } });
        Object.assign(lead, {
          websiteIssues: a.issues, reachable: a.reachable, auditedAt: t.toISOString(), title: a.title || null,
          email: bc.business_email, emailSource: bc.business_email ? (bc.contact_source === "openstreetmap" ? c.source : `${bc.contact_source} (${bc.source_url || a.finalUrl || lead.website})`) : null,
          company: lead.company || id.company, uid: id.uid, name: id.owner, nameSource: id.owner ? a.impressumUrl : null,
        });
        // Swiss Repair Outreach: Schweiz-Signale, Platzhalterseite und Herkunft der Kontaktdaten (Datenminimierung) festhalten.
        const homeText = strip(a.pages?.home || "").slice(0, 3000);
        Object.assign(lead, swissSignals({ domain, uid: id.uid, pages: a.pages || {}, discoverySource: c.source }), {
          placeholder: PLACEHOLDER_RE.test(`${a.title || ""} ${homeText}`),
          contact_name: bc.contact_name, contact_role: bc.contact_role, business_email: bc.business_email, contact_source: bc.contact_source,
          source_url: bc.source_url, collected_at: bc.collected_at, contact_confidence: bc.contact_confidence,
        });
        const { score, details } = scoreLead({ issues: a.issues, identity: id, company: lead.company, reachable: a.reachable });
        Object.assign(lead, { auditScore: score, scoreDetails: details });
        if (a.issues.length) stats.withIssues++;

        // Ab hier alles synchron (kein await): Einordnung, Dedupe und Draft-Queue sind je Lead atomar – keine Race Conditions.
        // Einordnung – in dieser Reihenfolge
        const domainOrEmailSuppressed = suppressedDomains.has(domain) || (lead.email && supp[lead.email]);
        const privateSite = !lead.uid && !id.hasImpressum && PRIVATE_RE.test(`${a.title || ""} ${lead.company || ""}`);
        const meaningful = a.issues.some((i) => i.severity !== "low");
        const existing = leadsFile.find((l) => (lead.email && normEmail(l.email) === lead.email) || normDomain(l.website || "") === domain || (l.email && emailDomain(l.email) === domain));
        if (domainOrEmailSuppressed) lead.status = "suppressed";
        else if (lead.email && (contacted.has(lead.email) || known.emails.has(lead.email))) lead.status = "duplicate";
        else if (privateSite) lead.status = "excluded_private";
        else if (!lead.company) lead.status = "excluded_no_company";
        else if (!a.issues.length) lead.status = "no_issues";
        else if (!meaningful || score < cfg.minScore) lead.status = "low_score";
        else if (!lead.email) lead.status = "no_contact";
        else if (existing && legalBasis(existing, t)) {
          // Nur wenn Chris die Versandgrundlage bereits dokumentiert hat: Befunde an seinen Lead hängen.
          lead.status = "matched_existing_lead";
          enrichExisting(store, existing, a.issues, score);
        } else if (existing) lead.status = "already_in_lead_list"; // steht schon in Chris’ Liste – dort entscheidet die Versandgrundlage
        else lead.status = "blocked_no_legal_basis";
        if (["blocked_no_legal_basis", "matched_existing_lead"].includes(lead.status)) stats.qualified++;
        const q = qualifyRepairLead(lead, { now: t });
        Object.assign(lead, { site_condition: q.site_condition, repair_fit_score: q.repair_fit_score, repair_stage: q.stage, contact_basis: q.contact_basis, repair_offer_class: q.offer?.offer_class || null });
        // Lead-Datenbank: wurde diese Firma schon angeschrieben / hat geantwortet / ist Kunde / gesperrt? Dann nie ein neuer Cold-Entwurf.
        const tracked = TRACKED_DISCOVERY.has(lead.status) || (lead.status === "suppressed" && !!lead.email);
        const dbBlock = tracked ? registryBlock(store, { domain, email: lead.email, company: lead.company }) : null;
        if (dbBlock) { lead.draft_blocked_reason = "Lead-Datenbank: " + dbBlock; stats.blocked++; log("info", "cold_draft_skipped", { domain, reason: lead.draft_blocked_reason }); }
        let draftQueued = false;
        // TF-025 COLD_LEAD_DRAFT_ONLY: höchstens EIN lokaler Cold-Entwurf je Firma (Gmail-Entwurf legt der Mail-Worker an). Nie gesendet.
        if (!dbBlock && lead.status === "blocked_no_legal_basis" && q.stage === "cold_lead_draft_only" && sender?.name) {
          // Kein geschäftliches Entwurfs-Limit: JEDER qualifizierte Lead wird persistent in die Draft-Queue aufgenommen (queued) –
          // den Gmail-Entwurf legt der Draft-Worker mit technischem Pacing an. Blockiert nur durch Dedupe/Suppression/Sperrfrist.
          try {
            const r = ensureColdDraft(store, lead, { sender, now: t, contacted, suppression: supp });
            if (r.blocked) { stats.blocked++; lead.draft_blocked_reason = r.blocked; log("info", "cold_draft_skipped", { domain, reason: r.blocked }); }
            else { stats.drafts++; hour.drafts++; draftQueued = true; }
          } catch (e) { log("error", "cold_draft_failed", { domain, error: e.message }); }
        }
        // Qualifizierte (bzw. gesperrte) Leads dauerhaft in die Lead-Datenbank – synchron, nie gelöscht. Fehler stoppen den Lauf nie.
        if (tracked) {
          try { recordLead(store, fromDiscovered(lead, draftQueued ? { gmail_draft_status: "queued" } : {}), { now: t, source: "discovery" }); }
          catch (e) { log("error", "lead_registry_failed", { domain, error: e.message }); }
        }
        log("info", "lead_discovered", { domain, status: lead.status, score, issues: a.issues.length, repair_stage: lead.repair_stage });
      } catch (e) {
        stats.errors++;
        lead.status = "audit_error";
        lead.error = e.message;
        if (SOURCE_ERROR_RE.test(e.message)) networkFailures++;
        data.lastError = { at: t.toISOString(), stage: "audit", message: String(e.message).slice(0, 160) };
        out.errors.push({ domain, error: e.message });
        log("error", "audit_failed", { domain, error: e.message }); // eine Website stoppt nie den ganzen Lauf
      }
      data.leads[domain] = lead;
      remember(domain, lead.email, lead.company);
      slots[idx] = lead; // Reihenfolge der Ergebnisse = Reihenfolge der Kandidaten, unabhängig von der Fertigstellung
      active.delete(domain);
      save({ force: false });
    };
    let networkFailures = 0, running = 0;
    const worker = async () => {
      for (let item; (item = claim()); ) {
        running++; peak = Math.max(peak, running);
        const t0 = Date.now();
        try { await processOne(item); } finally { running--; auditMs += Date.now() - t0; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(cfg.maxConcurrency, pending.length)) }, worker));
    out.found = slots.filter(Boolean);
    // Nur Netzwerkfehler und kein einziges erfolgreiches Audit → Quelle/Netz gestört → Backoff statt aggressiver Wiederholung.
    if (!sourceError && networkFailures && out.found.every((l) => l.status === "audit_error")) backoff("audit", new Error("Netzwerk: " + networkFailures + " Websites nicht erreichbar"));
    // Lauf-Protokoll (letzte 30 Läufe) für Discovery-Rate und Benchmark: Websites, Dauer, Spitzen-Parallelität, mittlere Auditdauer.
    data.runs = [...(Array.isArray(data.runs) ? data.runs : []), { start: t.toISOString(), end: new Date(Math.max(+t, +now())).toISOString(), audited: out.audited, qualified: out.found.filter((l) => l.status === "blocked_no_legal_basis" || l.status === "matched_existing_lead").length,
      searches: out.searches, duration_s: Math.round((Date.now() - startedAt) / 1000), peak_concurrency: peak, avg_audit_s: out.audited ? +(auditMs / out.audited / 1000).toFixed(1) : 0, errors: out.errors.length }].slice(-30);
    save();
    return out;
  } finally {
    releaseLock(dir, pid, DISCOVERY_LOCK);
  }
}

// Befunde an einen vorhandenen, von Chris freigegebenen Lead hängen – frisch gelesen, nur diese Felder.
function enrichExisting(store, existing, issues, score) {
  const leads = store.read("leads.json", []);
  const key = normEmail(existing.email);
  const l = leads.find((x) => normEmail(x.email) === key);
  if (!l) return;
  l.websiteIssues = issues;
  l.auditScore = score;
  store.write("leads.json", leads);
}

// ---------- Bericht ----------

export function discoveryReport(dir = WORKER_DIR, now = new Date()) {
  const store = createStore(dir);
  const data = store.read("discovered.json", { leads: {}, stats: {} });
  const leads = Object.values(data.leads || {});
  const today = data.stats?.[zurichDay(now)] || { found: 0, audited: 0, withIssues: 0, qualified: 0, errors: 0 };
  const count = (s) => leads.filter((l) => l.status === s).length;
  return {
    websitesFoundToday: today.found, websitesAuditedToday: today.audited, websitesWithIssuesToday: today.withIssues,
    qualifiedLeads: count("blocked_no_legal_basis") + count("matched_existing_lead"),
    leadsWithoutContact: count("no_contact"), leadsWithoutLegalBasis: count("blocked_no_legal_basis"),
    errorsToday: today.errors, totalKnown: leads.length, lastRunAt: data.lastRunAt || null,
  };
}

// ---------- Kommandozeile ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  const run = {
    "--once": async () => {
      const gmail = await import("./gmail.js");
      const r = await runDiscovery({ gmail, force: true });
      if (r.busy) { console.log("Ein anderer Discovery-Lauf ist aktiv."); return 0; }
      console.log(JSON.stringify({
        query: r.query, errors: r.errors,
        found: (r.found || []).map((l) => ({ company: l.company, website: l.website, email: l.email, status: l.status, auditScore: l.auditScore,
          issues: l.websiteIssues.map((i) => `${i.severity}: ${i.type} – ${i.evidence} (${i.url})`) })),
        report: discoveryReport(),
      }, null, 2));
      return 0;
    },
    "--report": async () => { console.log(JSON.stringify(discoveryReport(), null, 2)); return 0; },
  }[arg];
  if (!run) { console.log("Befehle: --once | --report"); process.exit(1); }
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
