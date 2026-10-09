// Jarvis Lead-Finder – findet öffentliche Websites von Schweizer KMU, prüft sie passiv (site-auditor.js)
// und legt daraus Leads in .secrets/mail_worker/discovered.json an. Er sendet NIE und gibt NIE frei:
// gefundene Leads starten mit approved=false und consentBasis=null. Eine öffentliche Adresse ist keine Einwilligung.
// Versendet wird nur über den Mail-Worker und dessen Versandgrundlagen-Prüfung (leads.json).
//
// Quelle: OpenStreetMap (Overpass API) – öffentliche Firmeneinträge mit Website, Gebiete und Branchen konfigurierbar.
// Ketten/Konzerne (OSM-Tag brand) werden übersprungen. Höchstens eine Suche je Lauf, Websites gedrosselt geprüft.
//
//   node lead-finder.js --once     genau ein Such-/Prüflauf (eigenes Lock, unabhängig von server.js)
//   node lead-finder.js --report   Übersicht über gefundene Leads
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAuditor } from "./site-auditor.js";
import { swissSignals, qualifyRepairLead, ensureColdDraft, discoverBusinessContact, PLACEHOLDER_RE, REVIEWS_FILE } from "./swiss-repair.js";
import { WORKER_DIR, createStore, createLogger, acquireLock, releaseLock, heartbeat, legalBasis, normEmail, zurichDay } from "./mail-worker.js";

export const DISCOVERY_LOCK = "discovery.lock";
// Overpass verlangt eine erkennbare Anwendung als User-Agent (generische Browser-Kennungen werden mit 406 abgelehnt).
const OVERPASS_UA = "JarvisLeadFinder/1.0 (Helvetic Webdesign; https://helvetic-webdesign.ch)";
// 24/7-Discovery (VPS): kleiner Lauf alle intervalMinutes, rund um die Uhr, mit zentralen Sicherheitslimits (Websites je Stunde/Tag,
// Gmail-Entwürfe je Stunde/Tag) und Backoff bei 429/5xx/Netzwerkfehlern der Datenquelle. Alle Werte per config.json → discovery überschreibbar.
export const DEFAULT_DISCOVERY = {
  enabled: true,
  intervalMinutes: 20, // ein Lauf alle 20 Minuten (24/7), nie eine Endlosschleife
  sitesPerRun: 21,     // 21 × 3 Läufe = 63 je Stunde
  maxSitesPerHour: 63,
  maxSitesPerDay: 1500, // harter Prüfdeckel: 1500 unterschiedliche Websites pro Tag
  // KEIN geschäftliches Maximum für Cold-Entwürfe: null = unbegrenzt. Jeder qualifizierte Lead wird persistent zur Entwurfserstellung
  // vorgemerkt (individual_reviews.json, Status queued → draft_created). Nur technisches Pacing gegenüber der Gmail-API (unten).
  maxDraftsPerHour: null,
  maxDraftsPerDay: null,
  draftPaceMs: 1500,    // technische Pause zwischen zwei Gmail-Entwürfen (API-Schonung) – verschiebt nur, verwirft nie
  draftsPerPass: 25,    // technisch je Worker-Durchlauf (alle 2 min) – Rest bleibt in der Queue, nichts geht verloren
  backoffMinutes: 15,   // nach Quellenfehler: 15 → 30 → 60 … bis backoffMaxMinutes
  backoffMaxMinutes: 360,
  minScore: 6,
  areas: ["Winterthur", "St. Gallen", "Luzern", "Thun", "Aarau", "Chur", "Schaffhausen", "Frauenfeld", "Zug", "Solothurn", "Baden", "Uster", "Wil (SG)", "Rapperswil-Jona"],
  categories: [
    { key: "craft" }, { key: "shop" }, { key: "office", value: "company" }, { key: "office", value: "estate_agent" },
    { key: "amenity", value: "restaurant" }, { key: "amenity", value: "dentist" }, { key: "healthcare", value: "physiotherapist" },
    { key: "tourism", value: "hotel" }, { key: "office", value: "accountant" }, { key: "shop", value: "hairdresser" },
  ],
  excludeDomains: [], // z. B. bekannte Grosskonzerne oder Chris’ eigene Kunden
  overpassUrl: "https://overpass-api.de/api/interpreter",
};

const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|gmx|web|bluewin|hispeed|sunrise|protonmail|proton|yandex|aol)\.[a-z.]+$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PRIVATE_RE = /\b(privat(e|seite)?|hobby|familie|family|mein blog|my blog|fotoalbum|hochzeit|wedding|portfolio von)\b/i;
const LEGAL_FORM = /\b(ag|gmbh|sa|s[àa]rl|sagl|kg|klg|e\.?\s?k\.?|ltd|inc|co|und|&|et)\b/g;

export const normDomain = (u = "") => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
export const normCompany = (s = "") => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(LEGAL_FORM, " ").replace(/[^a-z0-9]+/g, " ").trim();
const emailDomain = (e) => normEmail(e).split("@")[1] || "";
const strip = (html = "") => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");

// ---------- Suche (Overpass / OpenStreetMap) ----------

export function overpassSearch({ fetchFn = globalThis.fetch, url = DEFAULT_DISCOVERY.overpassUrl, retryMs = 30_000 } = {}) {
  return async ({ area, category, limit = 60 }) => {
    const q = (s) => String(s).replace(/["\\]/g, "");
    const filter = category.value ? `["${q(category.key)}"="${q(category.value)}"]` : `["${q(category.key)}"]`;
    const query = `[out:json][timeout:60];area["name"="${q(area)}"]["boundary"="administrative"]->.a;nwr(area.a)${filter}[~"^(website|contact:website)$"~"."];out tags ${limit};`;
    const ask = () => fetchFn(url, { method: "POST", headers: { "user-agent": OVERPASS_UA, accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(90_000) });
    let r = await ask();
    // Überlastet: genau ein zweiter Versuch nach einer Pause, sonst beim nächsten Lauf weiter.
    if ([429, 502, 503, 504].includes(r.status)) { await new Promise((res) => setTimeout(res, retryMs)); r = await ask(); }
    if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
    const { elements = [] } = await r.json();
    return elements.map((e) => ({
      company: e.tags?.name || "", website: e.tags?.website || e.tags?.["contact:website"] || "",
      email: e.tags?.email || e.tags?.["contact:email"] || "", chain: !!(e.tags?.brand || e.tags?.["brand:wikidata"]),
      source: `OpenStreetMap ${e.type}/${e.id} (${area}, ${category.key}${category.value ? "=" + category.value : ""})`,
    }));
  };
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
// Pause/Fortsetzen (Server Control discovery.pause / discovery.resume): nur ein Flag, keine Daten werden gelöscht.
export function setDiscoveryPaused(dir, paused, { now = new Date(), reason = "server_control" } = {}) {
  const store = createStore(dir);
  const data = { leads: {}, cursor: 0, lastRunAt: null, stats: {}, ...store.read("discovered.json", {}) };
  data.paused = !!paused;
  data.pausedAt = paused ? now.toISOString() : null;
  data.pausedBy = paused ? reason : null;
  store.write("discovered.json", data);
  return { paused: data.paused, pausedAt: data.pausedAt };
}
// Status für HUD/Mobile (nur Zahlen, Zeitpunkte, feste Wörter, bereinigter Fehlertext).
export function discoveryStatus(dir = WORKER_DIR, now = new Date()) {
  const store = createStore(dir);
  const cfg = discoveryConfig(store);
  const data = { leads: {}, stats: {}, ...store.read("discovered.json", {}) };
  const reviews = Object.values(store.read(REVIEWS_FILE, { reviews: {} }).reviews || {});
  const today = data.stats?.[zurichDay(now)] || {};
  const h = data.hourly?.[hourKey(now)] || {};
  const backoffActive = !!data.backoffUntil && Date.parse(data.backoffUntil) > +now;
  const lastRun = data.lastRunAt ? Date.parse(data.lastRunAt) : null;
  const next = data.paused ? null : backoffActive ? data.backoffUntil : new Date(Math.max(+now, (lastRun || 0) + cfg.intervalMinutes * 60_000)).toISOString();
  const dayStart = zurichDay(now);
  const draftsToday = reviews.filter((r) => r.created_at && zurichDay(new Date(r.created_at)) === dayStart).length;
  const draftsHour = reviews.filter((r) => r.created_at && +now - Date.parse(r.created_at) < 3_600_000).length;
  const dw = store.read(REVIEWS_FILE, { reviews: {} }).draft_worker || {};
  const dwBackoff = !!dw.backoffUntil && Date.parse(dw.backoffUntil) > +now;
  const gmailToday = reviews.filter((r) => r.draft_created_at && zurichDay(new Date(r.draft_created_at)) === dayStart).length;
  return {
    status: !cfg.enabled ? "DISABLED" : data.paused ? "PAUSED" : backoffActive ? "BACKOFF" : "ACTIVE",
    paused: !!data.paused, paused_at: data.pausedAt || null,
    // Websites: harter Prüfdeckel je Tag; Leads: qualifiziert = persistent zur Entwurfserstellung vorgemerkt (kein Business-Cap).
    audited_today: today.audited || 0, websites_limit: cfg.maxSitesPerDay, new_leads_today: today.found || 0, qualified_today: today.qualified || 0,
    qualified_total: reviews.length,
    drafts_today: draftsToday, drafts_hour: draftsHour, blocked_today: today.blocked || 0, errors_today: today.errors || 0,
    audited_hour: h.audited || 0,
    last_run_at: data.lastRunAt || null, next_run_at: next, backoff_until: backoffActive ? data.backoffUntil : null, backoff_count: data.backoffCount || 0,
    queue: reviews.filter((r) => r.status === "queued").length, // = waiting_for_draft
    waiting_for_draft: reviews.filter((r) => r.status === "queued").length,
    gmail_drafts_today: gmailToday,
    open_drafts_total: reviews.filter((r) => r.status === "draft_created").length,
    draft_worker: { status: dwBackoff ? "BACKOFF" : "ACTIVE", backoff_until: dwBackoff ? dw.backoffUntil : null, backoff_count: dw.backoffCount || 0, last_draft_at: dw.lastDraftAt || null,
      last_error: dw.lastError ? { at: dw.lastError.at, message: String(dw.lastError.message || "").slice(0, 160) } : null },
    last_error: data.lastError ? { at: data.lastError.at, stage: data.lastError.stage, message: String(data.lastError.message || "").slice(0, 160) } : null,
    limits: { interval_minutes: cfg.intervalMinutes, sites_per_run: cfg.sitesPerRun, max_sites_per_hour: cfg.maxSitesPerHour, max_sites_per_day: cfg.maxSitesPerDay,
      max_drafts_per_hour: null, max_drafts_per_day: null, draft_pace_ms: cfg.draftPaceMs, drafts_per_pass: cfg.draftsPerPass }, // null = kein Business-Cap
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
  if (!force && hour.audited >= cfg.maxSitesPerHour) return { skipped: "hour_limit" };
  if (!acquireLock(dir, { pid, name: DISCOVERY_LOCK })) return { busy: true };
  const stats = (data.stats[day] ||= { found: 0, audited: 0, withIssues: 0, qualified: 0, errors: 0, blocked: 0, drafts: 0 });
  stats.blocked ??= 0; stats.drafts ??= 0;
  const save = () => {
    // nur die letzten 14 Tage Statistik behalten
    for (const d of Object.keys(data.stats).sort().slice(0, -14)) delete data.stats[d];
    store.write("discovered.json", data);
    heartbeat(dir, pid, DISCOVERY_LOCK);
  };
  // Backoff bei Quellenfehlern (429/5xx/Netz): 15 → 30 → 60 … min, gedeckelt; ein erfolgreicher Lauf setzt zurück.
  const backoff = (stage, e) => {
    data.backoffCount = (data.backoffCount || 0) + 1;
    const minutes = Math.min(cfg.backoffMaxMinutes, cfg.backoffMinutes * 2 ** (data.backoffCount - 1));
    data.backoffUntil = new Date(+t + minutes * 60_000).toISOString();
    data.lastError = { at: t.toISOString(), stage, message: String(e.message || e).slice(0, 160) };
    log("warn", "discovery_backoff", { stage, minutes, count: data.backoffCount });
  };
  const out = { day, query: null, found: [], errors: [] };
  try {
    search ||= overpassSearch({ url: cfg.overpassUrl });
    auditor ||= createAuditor();
    const pairs = cfg.areas.flatMap((area) => cfg.categories.map((category) => ({ area, category })));
    if (!pairs.length) { data.lastRunAt = t.toISOString(); save(); return { ...out, skipped: "no_areas" }; }
    const pair = pairs[data.cursor % pairs.length];
    data.cursor = (data.cursor + 1) % pairs.length;
    data.lastRunAt = t.toISOString();
    out.query = `${pair.area} / ${pair.category.key}${pair.category.value ? "=" + pair.category.value : ""}`;
    let candidates = [];
    try { candidates = await search(pair); data.backoffCount = 0; data.backoffUntil = null; }
    catch (e) { stats.errors++; out.errors.push({ stage: "search", error: e.message }); log("error", "discovery_search_failed", { query: out.query, error: e.message }); backoff("search", e); save(); return out; }
    let networkFailures = 0;

    // Bekanntes: gefundene Leads, Chris’ Lead-Liste, eigene Jarvis-Threads, Suppression (hat immer Vorrang)
    const leadsFile = store.read("leads.json", []);
    const reg = gmail?.listOwned?.() || { sent: {}, drafts: {} };
    const supp = store.read("suppression.json", {});
    const known = { domains: new Set(), emails: new Set(), companies: new Set() };
    const remember = (domain, email, company) => {
      if (domain) known.domains.add(domain);
      if (email) { known.emails.add(normEmail(email)); if (!FREEMAIL.test(emailDomain(email))) known.domains.add(emailDomain(email)); }
      if (company && normCompany(company)) known.companies.add(normCompany(company));
    };
    for (const l of Object.values(data.leads)) remember(l.domain, l.email, l.company);
    const contacted = new Set([...Object.values(reg.sent || {}), ...Object.values(reg.drafts || {})].map((s) => normEmail(s.to)));
    const suppressedDomains = new Set(Object.keys(supp).map(emailDomain).filter((d) => d && !FREEMAIL.test(d)));
    const exclude = new Set(cfg.excludeDomains.map(normDomain));

    let audited = 0;
    for (const c of candidates) {
      if (audited >= cfg.sitesPerRun || stats.audited >= cfg.maxSitesPerDay || hour.audited >= cfg.maxSitesPerHour) break;
      const domain = normDomain(c.website);
      if (!domain || c.chain || exclude.has(domain) || FREEMAIL.test(domain)) continue;
      if (known.domains.has(domain) || (c.company && known.companies.has(normCompany(c.company)))) continue; // Duplikat
      stats.found++;
      const lead = {
        email: null, name: null, company: c.company || null, website: `https://${domain}/`, domain,
        approved: false, discoverySource: c.source, discoveredAt: t.toISOString(),
        websiteIssues: [], auditScore: 0, scoreDetails: [],
        consentBasis: null, consentAt: null, consentSource: null, existingCustomer: false, similarService: false,
        status: "discovered",
      };
      try {
        const a = await auditor.audit(c.website);
        audited++;
        stats.audited++;
        hour.audited++;
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
        Object.assign(lead, { site_condition: q.site_condition, repair_fit_score: q.repair_fit_score, repair_stage: q.stage, contact_basis: q.contact_basis });
        // TF-025 COLD_LEAD_DRAFT_ONLY: höchstens EIN lokaler Cold-Entwurf je Firma (Gmail-Entwurf legt der Mail-Worker an). Nie gesendet.
        const sender = store.read("config.json", {}).sender;
        if (lead.status === "blocked_no_legal_basis" && q.stage === "cold_lead_draft_only" && sender?.name) {
          // Kein geschäftliches Entwurfs-Limit: JEDER qualifizierte Lead wird persistent in die Draft-Queue aufgenommen (queued) –
          // den Gmail-Entwurf legt der Draft-Worker mit technischem Pacing an. Blockiert nur durch Dedupe/Suppression/Sperrfrist.
          try {
            const r = ensureColdDraft(store, lead, { sender, now: t, contacted, suppression: supp });
            if (r.blocked) { stats.blocked++; lead.draft_blocked_reason = r.blocked; log("info", "cold_draft_skipped", { domain, reason: r.blocked }); }
            else { stats.drafts++; hour.drafts++; }
          } catch (e) { log("error", "cold_draft_failed", { domain, error: e.message }); }
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
      out.found.push(lead);
      save();
    }
    // Nur Netzwerkfehler und kein einziges erfolgreiches Audit → Quelle/Netz gestört → Backoff statt aggressiver Wiederholung.
    if (networkFailures && out.found.every((l) => l.status === "audit_error")) backoff("audit", new Error("Netzwerk: " + networkFailures + " Websites nicht erreichbar"));
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
