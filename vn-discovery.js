// Jarvis Vietnam-Discovery (TF-063) – EIGENER Dienst (Docker-Projekt jarvis-vn), eigener State unter JARVIS_VN_DIR, eigener Agent-Schlüssel.
// Berührt nie die Schweizer Discovery (discovery_geo.json, lead_registry.json, audited_index, Mail-Worker) – andere Dateien, anderer Container.
//
//   Ziel: bis zu VN_DAILY_WEBSITE_AUDITS = 1000 abgeschlossene Website-Audits je vietnamesischem Kalendertag (Asia/Ho_Chi_Minh).
//         Gezählt werden Audits (geprüfte Websites) – nicht Leads, E-Mails oder Entwürfe. Das 1001. Audit desselben Tages startet nie.
//   Geografie: data/vietnam-admin.json (34 Einheiten auf Provinzebene seit 01.07.2025). Faire Rotation: Einheit für Einheit reihum
//         (persistenter Cursor, neustartfest), je Einheit wechselnde Such-Anker und Branchengruppen – keine Konzentration auf HCM/Hanoi.
//   Quelle: OpenStreetMap (Overpass) – nur Objekte INNERHALB des Landesgebiets Vietnam (area ISO3166-1=VN) mit Geschäfts-Tag + Website
//         (= belegbare Vietnam-Zuordnung; .vn / +84 nur Zusatzsignale; nie aus dem Firmennamen geraten; nur Unternehmen/Organisationen).
//   Audit: passiv wie die Schweiz (site-auditor.js): Erreichbarkeit, HTTPS/Zertifikat, Weiterleitungen, kaputte Links/Bilder, Kontaktseite,
//         Mobile-Viewport, mailto – nur GET, robots.txt, gedrosselt. Nie Formulare absenden, nie bestellen, nie Konten anlegen, nichts ändern.
//   Dedupe: eigener Index je Domain (market VN) mit Cooldown – dieselbe Website wird nie am selben Tag erneut geprüft; Leads je Domain einmal.
//         Global: die Cloud verwirft VN-Leads, deren Domain bereits als Schweizer CRM-Lead existiert (crm-api.js cleanVnLeads).
//   Outreach: COLD_LEAD_DRAFT_ONLY – dieser Dienst sendet nie und legt keine Entwürfe an.
//
//   node vn-discovery.js --service      Dienst (Discovery + CRM-Agent)       --healthcheck   Herzschlag < 5 min
//   node vn-discovery.js --report       Kennzahlen (keine personenbezogenen Daten)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAuditor } from "./site-auditor.js";
import { fullAuditEntry, siteHealth, normDomain } from "./site-findings.js";
import { normalizeCrmState, applyCrmAction, effectiveStage, cleanCrmLead, CRM_SCHEMA } from "./lead-crm.js";
import { priorityOf, followUpBucket, callRecommended, CALL_STATUSES, CONTACT_STATUSES, crmActive, compactCrmLead } from "./public/crm-model.js";
import { displayCategory, categoryKey } from "./category-labels.js";
import { ISSUE_TYPE_TEXT } from "./public/i18n.js";

export const VN_DAILY_WEBSITE_AUDITS = 1000;
export const VN_TZ = "Asia/Ho_Chi_Minh";
export const STATE_FILE = "vn_state.json", INDEX_FILE = "vn_index.json", LEADS_FILE = "vn_leads.json", CRM_FILE = "vn_crm.json", HEALTH_FILE = "vn_health.json";
export const COOLDOWN_DAYS = 30;            // dieselbe Domain frühestens nach 30 Tagen erneut prüfen (nie am selben Tag)
export const SEARCH_RADIUS_M = 10_000;      // Umkreis je Such-Anker (früherer Provinz-Hauptort) – innerhalb Vietnams
export const MAX_QUEUE = 400, MAX_PER_SEARCH = 60;
export const AUDIT_OPTIONS = Object.freeze({ delayMs: 1500, timeoutMs: 15_000, totalMs: 90_000, maxLinks: 10, maxImages: 6 });
export const VN_CONTACT_RE = /kontakt|contact|contatto|li[eê]n[- ]?h[eệ]|lienhe/i;
// Branchengruppen (OSM): je Job genau eine Gruppe, reihum je Einheit.
export const CATEGORY_GROUPS = Object.freeze([
  [{ key: "shop" }],
  [{ key: "amenity", value: "restaurant" }, { key: "amenity", value: "cafe" }],
  [{ key: "office", value: "company" }, { key: "office", value: "it" }, { key: "office", value: "consulting" }, { key: "office", value: "lawyer" }, { key: "office", value: "accountant" },
    { key: "office", value: "estate_agent" }, { key: "office", value: "insurance" }, { key: "office", value: "architect" }, { key: "office", value: "tax_advisor" }],
  [{ key: "tourism", value: "hotel" }, { key: "tourism", value: "guest_house" }],
  [{ key: "amenity", value: "dentist" }, { key: "amenity", value: "doctors" }, { key: "healthcare", value: "physiotherapist" }, { key: "healthcare", value: "doctor" }, { key: "amenity", value: "veterinary" }],
  [{ key: "craft" }, { key: "shop", value: "car_repair" }, { key: "shop", value: "beauty" }, { key: "shop", value: "hairdresser" }, { key: "leisure", value: "fitness_centre" }],
]);
const PLATFORM_RE = /(^|\.)(facebook|fb|instagram|linkedin|twitter|x|youtube|tiktok|zalo|shopee|lazada|tiki|sendo|pinterest|tripadvisor|booking|agoda|traveloka|google|goo|linktr|yelp|foody|grab|wikipedia|blogspot|wordpress|wixsite|business)\.[a-z.]+$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- Geografie ----------
export function loadVnAdmin(file = path.join(ROOT, "data", "vietnam-admin.json")) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const units = Array.isArray(d.units) ? d.units : [];
  const codes = new Set(units.map((u) => u.code));
  if (units.length !== 34 || codes.size !== 34) throw new Error(`vietnam-admin.json: ${units.length} Einheiten (erwartet 34)`);
  if (units.filter((u) => u.type === "city").length !== 6 || units.filter((u) => u.type === "province").length !== 28) throw new Error("vietnam-admin.json: erwartet 6 Städte + 28 Provinzen");
  for (const u of units) if (!/^VN-[A-Z0-9]{2,6}$/.test(u.code) || !u.anchors?.length || u.anchors.some((a) => !(a.lat > 8 && a.lat < 24 && a.lon > 102 && a.lon < 110))) throw new Error(`vietnam-admin.json: Einheit ${u.code} ungültig`);
  return { dataset: d.dataset, version: d.version, units };
}
export const vnDay = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: VN_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// ---------- Dateien (atomar) ----------
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return typeof d === "function" ? d() : d; } };
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export const emptyVnState = () => ({ schema: 1, day: null, audits_today: 0, audits_total: 0, cycle: 0, cursor: { unit: 0, anchor: {}, cat: {} }, queue: [], last_audit_at: null, last_search_at: null, search_backoff_until: null });
export function createVnStore(dir) {
  const f = (n) => path.join(dir, n);
  return {
    dir,
    state: () => ({ ...emptyVnState(), ...readJson(f(STATE_FILE), emptyVnState) }),
    saveState: (s) => writeAtomic(f(STATE_FILE), s),
    index: () => { const x = readJson(f(INDEX_FILE), () => ({ domains: {} })); x.domains ||= {}; return x; },
    saveIndex: (x) => writeAtomic(f(INDEX_FILE), x),
    leads: () => { const x = readJson(f(LEADS_FILE), () => ({ leads: {} })); x.leads ||= {}; return x; },
    saveLeads: (x) => writeAtomic(f(LEADS_FILE), x),
    crm: (now = new Date()) => normalizeCrmState(readJson(f(CRM_FILE), null), now),
    saveCrm: (x) => writeAtomic(f(CRM_FILE), x),
    health: (h) => writeAtomic(f(HEALTH_FILE), h),
  };
}

// ---------- Tageskontingent ----------
// Tageswechsel (VN-Zeit) setzt NUR den Tageszähler zurück – Index/Dedupe/Leads/Cursor bleiben.
export function rollDay(st, now = new Date()) {
  const d = vnDay(now);
  if (st.day !== d) return { ...st, day: d, audits_today: 0 };
  return st;
}
export const quotaLeft = (st, inflight = 0, limit = VN_DAILY_WEBSITE_AUDITS) => Math.max(0, limit - (st.audits_today || 0) - inflight);

// ---------- Faire Rotation ----------
// Liefert den nächsten Such-Job und den fortgeschriebenen Cursor (Einheit reihum; je Einheit Branchengruppe, dann Anker weiter).
export function nextJob(st, units) {
  const c = { unit: Number.isInteger(st.cursor?.unit) ? st.cursor.unit % units.length : 0, anchor: { ...(st.cursor?.anchor || {}) }, cat: { ...(st.cursor?.cat || {}) } };
  const u = units[c.unit];
  const ci = c.cat[u.code] || 0, ai = c.anchor[u.code] || 0;
  const job = { unit: u, anchor: u.anchors[ai % u.anchors.length], categories: CATEGORY_GROUPS[ci % CATEGORY_GROUPS.length], cat_index: ci % CATEGORY_GROUPS.length };
  c.cat[u.code] = (ci + 1) % CATEGORY_GROUPS.length;
  if (c.cat[u.code] === 0) c.anchor[u.code] = (ai + 1) % u.anchors.length;
  const wrapped = c.unit + 1 >= units.length;
  c.unit = (c.unit + 1) % units.length;
  return { job, state: { ...st, cursor: c, cycle: (st.cycle || 0) + (wrapped ? 1 : 0) } };
}

// ---------- Overpass ----------
const OVERPASS_UA = "JarvisLeadFinder/1.0 (Helvetic Webdesign; https://helvetic-webdesign.ch)";
const q = (s) => String(s).replace(/["\\]/g, "");
const tagFilter = (c) => (c.value ? `["${q(c.key)}"="${q(c.value)}"]` : `["${q(c.key)}"]`);
export function vnQuery({ anchor, categories, radius = SEARCH_RADIUS_M, limit = 200 }) {
  const around = `(around:${Math.round(radius)},${Number(anchor.lat).toFixed(4)},${Number(anchor.lon).toFixed(4)})`;
  const body = categories.map((c) => `nwr${tagFilter(c)}[~"^(website|contact:website)$"~"."]${around}(area.vn);`).join("");
  return `[out:json][timeout:90];area["ISO3166-1"="VN"]["admin_level"="2"]->.vn;(${body});out tags ${limit};`;
}
export function createVnSearch({ fetchFn = globalThis.fetch, url = "https://overpass-api.de/api/interpreter", minGapMs = 8000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = 0;
  return async (job) => {
    const wait = last + minGapMs - Date.now(); if (wait > 0) await sleep(wait);
    last = Date.now();
    const r = await fetchFn(url, { method: "POST", headers: { "user-agent": OVERPASS_UA, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: vnQuery(job) }), signal: AbortSignal.timeout(100_000) });
    if (!r.ok) { const e = new Error(`Overpass HTTP ${r.status}`); e.status = r.status; throw e; }
    return (await r.json()).elements || [];
  };
}
export function normVnPhone(raw) {
  const s = String(raw || "").split(/[;,/]/)[0].replace(/[^\d+]/g, "");
  let d = s.startsWith("+84") ? s.slice(3) : s.startsWith("0084") ? s.slice(4) : s.startsWith("84") && s.length >= 11 ? s.slice(2) : s.startsWith("0") ? s.slice(1) : null;
  if (!d || !/^\d{9,10}$/.test(d)) return null;
  return `+84${d}`;
}
const catOf = (tags, cats) => { for (const c of cats) if (c.value ? tags[c.key] === c.value : tags[c.key]) return categoryKey(c.value ? c : { key: c.key }); return null; };
// OSM-Element → Kandidat (nur Unternehmen/Organisation mit Name + eigener Website, keine Plattform/Kette). Sonst null.
export function candidateOf(e, job) {
  const t = e?.tags || {};
  const name = String(t.name || t["name:vi"] || t["name:en"] || "").trim();
  const website = String(t.website || t["contact:website"] || "").trim();
  const domain = normDomain(website);
  if (!name || name.length > 120 || !domain || !/\./.test(domain) || PLATFORM_RE.test(domain)) return null;
  if (t.brand || t["brand:wikidata"]) return null; // Ketten/Grosskonzerne nicht
  const email = String(t.email || t["contact:email"] || "").trim().toLowerCase();
  return { domain, website: /^https?:\/\//i.test(website) ? website : `https://${domain}/`, company: name, category: catOf(t, job.categories),
    phone: String(t.phone || t["contact:phone"] || "").trim().slice(0, 40) || null, phone_normalized: normVnPhone(t.phone || t["contact:phone"]),
    email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) ? email : null, region: job.unit.name, region_code: job.unit.code, osm: `${e.type}/${e.id}`,
    evidence: ["osm_area_vn", ...(domain.endsWith(".vn") ? ["tld_vn"] : []), ...(normVnPhone(t.phone || t["contact:phone"]) ? ["phone_84"] : []), ...(t["addr:country"] === "VN" ? ["addr_vn"] : [])] };
}
const seenRecently = (idx, domain, now) => { const x = idx.domains?.[domain]; return !!x && (vnDay(new Date(x.at)) === vnDay(now) || +now - Date.parse(x.at) < COOLDOWN_DAYS * 86_400_000); };

// Ein Such-Job: Kandidaten in die (persistente) Queue, ohne Duplikate/Cooldown-Domains/bekannte Leads.
export async function searchStep({ store, units, search, now = new Date() }) {
  let st = store.state();
  const { job, state } = nextJob(st, units);
  st = { ...state, last_search_at: now.toISOString() };
  // Cursor VOR der Abfrage festschreiben: ein fehlgeschlagener Job (Quelle überlastet) blockiert nie eine Einheit – er kommt im nächsten Zyklus wieder.
  store.saveState(st);
  const idx = store.index(), leads = store.leads().leads;
  const queued = new Set((st.queue || []).map((c) => c.domain));
  let added = 0;
  const elements = await search(job);
  st = { ...store.state(), queue: st.queue, search_failures: 0, search_backoff_until: null };
  for (const e of elements) {
    const c = candidateOf(e, job);
    if (!c || queued.has(c.domain) || leads[c.domain] || seenRecently(idx, c.domain, now)) continue;
    queued.add(c.domain); st.queue = [...(st.queue || []), c]; added++;
    if (added >= MAX_PER_SEARCH || st.queue.length >= MAX_QUEUE) break;
  }
  store.saveState(st);
  return { unit: job.unit.code, anchor: job.anchor.name, cat_index: job.cat_index, found: elements.length, added };
}

// ---------- Audit + Qualifizierung ----------
const VISIBLE = new Set(["broken_link", "contact_page_broken", "broken_image", "broken_mailto", "https_certificate", "redirect_loop", "no_mobile_viewport"]);
const siteEmails = (pages = {}, domain) => [...new Set(Object.values(pages).join(" ").match(EMAIL_RE) || [])].map((m) => m.toLowerCase()).filter((m) => m.endsWith(`@${domain}`) || m.endsWith(`.${domain}`));
// Audit-Ergebnis → Lead-Datensatz (nur bei ≥ 1 für Besucher sichtbarem, belegtem Fehler) oder null.
export function leadFromAudit(c, r, now = new Date()) {
  if (!r || r.reachable === false) return null;
  const at = now.toISOString();
  const entry = fullAuditEntry(r, { domain: c.domain, audited_at: at });
  const findings = entry.findings.filter((f) => VISIBLE.has(f.type)).map((f) => ({ ...f, text: ISSUE_TYPE_TEXT["vi-VN"][f.type] || f.text }));
  if (!findings.length) return null;
  const email = c.email || siteEmails(r.pages, c.domain)[0] || null;
  return { ...c, email, audited_at: at, audit: { ...entry, findings } };
}
export async function auditOne({ store, c, auditor, now = () => new Date() }) {
  let r = null, error = null;
  try { r = await auditor.audit(c.website); } catch (e) { error = String(e?.message || e).slice(0, 120); }
  const t = now();
  const lead = r ? leadFromAudit(c, r, t) : null;
  // Abgeschlossen = Audit gelaufen (auch „nicht erreichbar“/„keine Fehler“) → zählt gegen das Tageskontingent.
  const st = rollDay(store.state(), t);
  st.audits_today = (st.audits_today || 0) + 1; st.audits_total = (st.audits_total || 0) + 1; st.last_audit_at = t.toISOString();
  store.saveState(st);
  const idx = store.index();
  idx.domains[c.domain] = { at: t.toISOString(), status: error ? "error" : !r?.reachable ? "unreachable" : lead ? "lead" : "no_visible_issue", market: "VN" };
  store.saveIndex(idx);
  if (lead) { const L = store.leads(); if (!L.leads[c.domain]) { L.leads[c.domain] = lead; store.saveLeads(L); } }
  return { domain: c.domain, lead: !!lead, status: idx.domains[c.domain].status };
}

// ---------- CRM-Sicht für die Cloud (gleiches Schema wie CH, market VN) ----------
const REACHED = new Set(["CALLBACK_REQUESTED", "SPOKE_TO_EMPLOYEE", "SPOKE_TO_DECISION_MAKER", "INTERESTED", "NOT_INTERESTED", "DO_NOT_CALL"]);
export function buildVnLead(base, crmEntry, now = new Date()) {
  const crm = crmEntry || null;
  const errors = siteHealth({ incomplete: base.audit?.complete ? null : base.audit, full: base.audit?.complete ? base.audit : null, now });
  const calls = Array.isArray(crm?.call_history) ? crm.call_history : [];
  const flags = { do_not_contact: !!crm?.do_not_contact, customer: false, not_interested: false, manual_sent: false, replied: false, draft_status: null };
  const lead = {
    lead_id: base.domain, market: "VN", company: base.company, domain: base.domain, website: base.website, email: base.email || null,
    phone: base.phone ? base.phone.replace(/[^+0-9 ()\/.-]/g, "").slice(0, 30) || null : null, phone_tel: base.phone_normalized ? `tel:${base.phone_normalized}` : null, phone_confidence: base.phone_normalized ? "high" : null,
    first_name: null, last_name: null, role: null, region: base.region, region_code: base.region_code, canton: null, municipality: null,
    category: displayCategory(base.category), language: "vi", website_reachable: true, website_checked_at: base.audited_at,
    findings: (base.audit?.findings || []).map((f) => ({ key: f.key, text: f.text, page: f.page, status: "AUDIT", confirmed: true, severity: f.severity, verified_at: f.verified_at })),
    findings_total: (base.audit?.findings || []).length, findings_confirmed: (base.audit?.findings || []).length, errors, history_badge: null,
    draft_status: null, draft_url: null, draft_created_at: null, manual_sent: false, manual_sent_at: null, replied: false, customer: false,
    sales_stage: effectiveStage(crm, flags), stage_auto: !crm?.sales_stage,
    contact_status: CONTACT_STATUSES.includes(crm?.contact_status) ? crm.contact_status : calls.some((c) => REACHED.has(c.result)) ? "REACHED" : calls.length ? "CALLED" : "NOT_CONTACTED",
    call_status: CALL_STATUSES.includes(crm?.call_status) ? crm.call_status : "NOT_CALLED", last_contact_at: crm?.last_contact_at || null,
    next_action: crm?.next_action || null, next_action_at: crm?.next_action_at || null, notes: crm?.notes || [], call_history: calls,
    do_not_contact: flags.do_not_contact, dnc_source: crm?.do_not_contact ? "crm" : null, do_not_contact_at: crm?.do_not_contact_at || null, archived: !!crm?.archived,
    crm_created_at: crm?.created_at || null, updated_at: crm?.updated_at || base.audited_at,
  };
  lead.priority = priorityOf(lead); lead.follow_up = followUpBucket(lead, now); lead.call_recommended = callRecommended(lead);
  return cleanCrmLead(lead);
}
export function buildVnView(store, now = new Date(), units = null) {
  const crm = store.crm(now), base = store.leads().leads;
  // TF-076: nur aktive Leads (≥ 1 verifizierter Fehler) – die Basisdaten bleiben unverändert in vn_leads.json.
  const leads = Object.values(base).map((b) => buildVnLead(b, crm.leads[b.domain], now)).filter((l) => l && crmActive(l)).map(compactCrmLead);
  const st = rollDay(store.state(), now);
  return { generated_at: now.toISOString(), leads, status: { audited_today: st.audits_today, daily_limit: VN_DAILY_WEBSITE_AUDITS, day: st.day, units_total: 34,
    cursor_unit: units?.[st.cursor?.unit || 0]?.name || null, cycle: st.cycle || 0, indexed_domains: Object.keys(store.index().domains).length, last_audit_at: st.last_audit_at } };
}
// CRM-Aufträge der Cloud (nur VN-Leads) anwenden – gleiche Allowlist/Prüfung wie CH (lead-crm.js applyCrmAction).
export function applyVnRequest(store, req, now = new Date()) {
  const crm = store.crm(now);
  // Alle bekannten VN-Leads (auch ausserhalb des aktiven CRM): DNC/Notizen dürfen nie an der Aufnahmeregel scheitern.
  const view = new Map(Object.values(store.leads().leads).map((b) => buildVnLead(b, crm.leads[b.domain], now)).filter(Boolean).map((l) => [l.lead_id, l]));
  const r = applyCrmAction(crm, req, { now, lookup: (id) => view.get(id) || null });
  if (r.ok && !r.duplicate) store.saveCrm(crm);
  return { ...r, lead: r.ok ? buildVnLead(store.leads().leads[r.lead_id], crm.leads[r.lead_id], now) : null };
}

// ---------- Dienst ----------
export function createVnAgent({ store, url, token, fetchFn = globalThis.fetch, now = () => new Date(), log = () => {}, units = null }) {
  let lastSent = 0, lastHash = "";
  const post = async (body) => {
    const r = await fetchFn(`${String(url).replace(/\/+$/, "")}/api/crm`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-vn": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return {
    paused: false,
    async pollOnce() {
      const t = now();
      const view = buildVnView(store, t, units);
      const hash = crypto.createHash("sha256").update(JSON.stringify(view.leads)).digest("hex");
      const send = hash !== lastHash || +t - lastSent > 10 * 60_000;
      const r = await post({ op: "vn_pull", ...(send ? { view: { ...view, status: { ...view.status, paused: this.paused } } } : {}) });
      if (r.status !== 200) { log("warn", "vn_pull_failed", { status: r.status }); return { status: r.status, hot: false }; }
      if (send) { lastHash = hash; lastSent = +t; }
      this.paused = r.body?.paused === true;
      for (const q of r.body?.requests || []) {
        const res = applyVnRequest(store, q, now());
        await post({ op: "vn_result", request_id: q.request_id, ok: res.ok, ...(res.ok ? { lead: res.lead } : { code: res.code, error: res.error }) });
        log("info", "vn_crm_request", { action: q.action, ok: res.ok, code: res.code || null });
      }
      return { status: 200, hot: !!r.body?.hot };
    },
  };
}
export async function runService({ dir = process.env.JARVIS_VN_DIR || "/data/vn", env = process.env, fetchFn = globalThis.fetch, log = (lvl, ev, x = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), lvl, event: ev, ...x })) } = {}) {
  const store = createVnStore(dir);
  const { units, dataset } = loadVnAdmin();
  const limit = Math.min(VN_DAILY_WEBSITE_AUDITS, Number(env.VN_DAILY_WEBSITE_AUDITS) || VN_DAILY_WEBSITE_AUDITS);
  const conc = Math.max(1, Math.min(3, Number(env.VN_CONCURRENCY) || 2)), paceMs = Math.max(20_000, Number(env.VN_PACE_MS) || 60_000);
  const search = createVnSearch({ fetchFn }), auditor = createAuditor({ fetchFn, ...AUDIT_OPTIONS, contactRe: VN_CONTACT_RE });
  const agent = env.JARVIS_VN_AGENT_TOKEN && env.JARVIS_VN_URL ? createVnAgent({ store, url: env.JARVIS_VN_URL, token: env.JARVIS_VN_AGENT_TOKEN, fetchFn, log, units }) : null;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  log("info", "vn_service_started", { dataset, units: units.length, limit, conc, pace_ms: paceMs, agent: !!agent });
  (async () => { for (;;) { let hot = false; try { hot = agent ? (await agent.pollOnce()).hot : false; } catch (e) { log("warn", "vn_agent_error", { message: String(e.message).slice(0, 120) }); } await sleep(hot ? 3_000 : 20_000); } })();
  const inflight = new Set();
  let nextStart = 0;
  for (;;) {
    store.health({ at: new Date().toISOString(), inflight: inflight.size });
    let st = rollDay(store.state()); store.saveState(st);
    if (agent?.paused || quotaLeft(st, inflight.size, limit) <= 0) { await sleep(60_000); continue; }
    if (inflight.size >= conc) { await Promise.race(inflight); continue; }
    if (Date.now() < nextStart) { await sleep(Math.min(5_000, nextStart - Date.now())); continue; }
    if (!st.queue?.length) {
      if (st.search_backoff_until && Date.parse(st.search_backoff_until) > Date.now()) { await sleep(30_000); continue; }
      try { log("info", "vn_search", await searchStep({ store, units, search })); }
      catch (e) {
        // Backoff 1 → 2 → 4 → 8 → 15 min (Overpass „at capacity“), zurückgesetzt beim nächsten Erfolg.
        const s = store.state(); s.search_failures = (s.search_failures || 0) + 1;
        s.search_backoff_until = new Date(Date.now() + Math.min(15, 2 ** (s.search_failures - 1)) * 60_000).toISOString(); store.saveState(s);
        log("warn", "vn_search_failed", { message: String(e.message).slice(0, 120), failures: s.search_failures });
      }
      continue;
    }
    st = store.state();
    const c = st.queue.shift(); store.saveState(st);
    if (quotaLeft(rollDay(store.state()), inflight.size, limit) <= 0) continue;
    nextStart = Date.now() + paceMs;
    const p = auditOne({ store, c, auditor }).then((x) => log("info", "vn_audit", { status: x.status, lead: x.lead }), (e) => log("warn", "vn_audit_failed", { message: String(e.message).slice(0, 120) }))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }
}
export function vnReport(dir = process.env.JARVIS_VN_DIR || "/data/vn", now = new Date()) {
  const store = createVnStore(dir), st = rollDay(store.state(), now), units = loadVnAdmin().units;
  const leads = Object.values(store.leads().leads);
  const byUnit = {}; for (const l of leads) byUnit[l.region_code] = (byUnit[l.region_code] || 0) + 1;
  return { day: st.day, audited_today: st.audits_today, daily_limit: VN_DAILY_WEBSITE_AUDITS, audits_total: st.audits_total, cycle: st.cycle,
    cursor_next_unit: units[st.cursor?.unit || 0]?.code, units_total: units.length, queue: st.queue?.length || 0, indexed_domains: Object.keys(store.index().domains).length,
    leads: leads.length, leads_by_unit: byUnit, crm_schema: CRM_SCHEMA };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--service") runService().catch((e) => { console.error(JSON.stringify({ lvl: "error", event: "vn_service_crash", message: String(e.message).slice(0, 200) })); process.exit(1); });
  else if (arg === "--healthcheck") { const h = readJson(path.join(process.env.JARVIS_VN_DIR || "/data/vn", HEALTH_FILE), null); process.exit(h && Date.now() - Date.parse(h.at) < 5 * 60_000 ? 0 : 1); }
  else if (arg === "--report") console.log(JSON.stringify(vnReport(), null, 2));
  else { console.log("node vn-discovery.js --service | --healthcheck | --report"); process.exit(1); }
}
