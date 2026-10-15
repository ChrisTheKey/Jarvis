// Discovery-Fehler-Historie (TF-058) – CRM-eigene, abgeleitete Lesequelle discovery_issue_history.json (Datenbereich des CRM-Dienstes).
//
// Zweck: Leads, die Jarvis früher gefunden hat und bei denen mindestens ein für Besucher sichtbarer Website-Fehler BELEGT ist, auch dann
// im CRM zeigen, wenn sie wegen low_score / no_contact / alter Qualifikationsregel nie in die Sales-Pipeline kamen.
//
// - KEINE Outreach-Quelle: der Mail-Worker liest diese Datei nie; ein Eintrag hier erzeugt nie einen Entwurf. Entwürfe entstehen nur
//   über die bestehende Lead-Datenbank (TF-050-Regel, COLD_LEAD_DRAFT_ONLY).
// - lead_registry.json bleibt unberührt: knownKeys() (permanente Discovery-Dedupe) sieht diese Leads nicht – sie dürfen später
//   erneut geprüft und regulär qualifiziert werden; dann haben Registry/Review im CRM Vorrang.
// - Je Lead nur minimale Felder + normalisierte Befunde (site-findings.js). Keine Roh-HTML, keine Evidence-Texte, keine Logs, keine Secrets.
// - Quellen: discovered.json (laufend, read-only beobachtet, bevor lead-finder.js alte Einträge in audited_index.json auslagert),
//   entschlüsselte State-Backups (einmalig, lokal extrahiert → --import) und der passive Recheck von Domains, die nur noch im
//   audited_index.json stehen (eine Website gleichzeitig, nur GET, robots.txt, ≥ 2 s zwischen Anfragen, Checkpoint je Website).
// - Schreiber: nur der CRM-Dienst (bzw. seine CLI) unter history.lock, atomar (tmp + fsync + rename).
import fs from "node:fs";
import path from "node:path";
import { normalizeIssue, dedupeFindings, rankFindings, fullAuditEntry, normDomain, FULL_AUDIT_MAX_AGE_MS, COUNTED_TYPES, ISSUE_CATEGORIES } from "./site-findings.js";
import { buildIndex, findId, normEmail, isFreemail } from "./lead-db.js";
import { withCrmLock, writeAtomic } from "./crm-service.js";

export const HISTORY_FILE = "discovery_issue_history.json";
export const RECHECK_FILE = "discovery_recheck.json";
export const HISTORY_LOCK = "history.lock";
export const HISTORY_SCHEMA = 1;
export const HISTORY_SOURCES = Object.freeze(["discovered", "backup", "index_recheck"]);
export const MAX_HISTORY_FINDINGS = 20;
export const INGEST_EVERY_MS = 10 * 60_000;
export const QUEUE_REFRESH_MS = 6 * 3_600_000;
export const RECHECK_PAUSE_MS = 20_000;     // Pause nach jeder Website
export const RECHECK_IDLE_MS = 10 * 60_000;
export const RECHECK_MAX_TRIES = 2;
// Konservativer Recheck: eine Website gleichzeitig, ≥ 2 s zwischen zwei Anfragen, wenige Unterseiten (nie als vollständiger Audit gewertet).
export const RECHECK_AUDIT_OPTIONS = Object.freeze({ delayMs: 2000, maxLinks: 10, maxImages: 6, totalMs: 90_000 });

// Discovery-Status → Historie? Nur mit Firma, Domain, Audit-Zeitpunkt und ≥ 1 gültigem sichtbaren Befund.
const TAKE = new Set(["low_score", "no_contact", "blocked_no_legal_basis", "matched_existing_lead", "already_in_lead_list"]);
const SKIP = { no_issues: "no_issues", audit_error: "audit_error", excluded_private: "excluded", excluded_no_company: "excluded", suppressed: "suppressed", duplicate: "duplicate" };
export const HISTORICAL_STATUSES = Object.freeze([...TAKE, "no_issues", "audit_error", "recheck"]);
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const PRIVATE_RE = /\b(privat(e|seite)?|hobby|familie|family|mein blog|my blog|fotoalbum|hochzeit|wedding|portfolio von)\b/i;
const str = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "") || null;
const iso = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const httpUrl = (u) => { if (typeof u !== "string" || u.length > 300) return null; try { const x = new URL(u); return ["http:", "https:"].includes(x.protocol) ? x.href : null; } catch { return null; } };
const businessEmail = (e) => { const m = normEmail(e || ""); return EMAIL_RE.test(m) && m.length <= 200 && !isFreemail(m) ? m : null; };
const SEVERITIES = ["critical", "high", "medium", "low"];
// Bereits normalisierter Befund (site-findings.js) – nur gezählte Typen, nur bekannte Felder.
const cleanFinding = (f) => (f && COUNTED_TYPES.includes(f.type) && str(f.text, 140) && str(f.key, 200) ? { key: str(f.key, 200), type: f.type,
  category: ISSUE_CATEGORIES.includes(f.category) ? f.category : "other", text: str(f.text, 140), page: httpUrl(f.page), target: httpUrl(f.target),
  severity: SEVERITIES.includes(f.severity) ? f.severity : "medium", verified_at: iso(f.verified_at), status: "OPEN", source: "cold", manual: false, ...facts(f) } : null);
// TF-059: belegte CRM-Fakten (Linktext, HTTP-Status, Bereich, Viewport) mitführen – nur wenn vorhanden, sonst null (nie erfunden).
const facts = (f) => ({ label: str(f.label, 40), http_status: Number.isInteger(f.http_status) && f.http_status >= 100 && f.http_status <= 599 ? f.http_status : null,
  location: str(f.location, 60), viewport: Number.isInteger(f.viewport) ? f.viewport : null });
const slim = (f) => ({ key: f.key, type: f.type, category: f.category, text: f.text, page: f.page, target: f.target, severity: f.severity, verified_at: f.verified_at, ...facts(f) });
export const isStale = (h, now = new Date()) => !iso(h?.last_verified_at) || +now - Date.parse(h.last_verified_at) > FULL_AUDIT_MAX_AGE_MS;

// ---------- Ein Discovery-Ergebnis (discovered.json, auch aus einem Backup) → Historien-Eintrag oder Grund ----------
export function historyRecord(l, { source = "discovered" } = {}) {
  if (!l || typeof l !== "object") return { skip: "invalid" };
  if (SKIP[l.status]) return { skip: SKIP[l.status] };
  if (!TAKE.has(l.status)) return { skip: "invalid" }; // z. B. „discovered“ (Audit lief noch)
  const domain = normDomain(l.domain || l.website || "");
  if (!domain || !DOMAIN_RE.test(domain)) return { skip: "invalid" };
  const company = str(l.company, 120);
  if (!company) return { skip: "excluded" };
  const at = iso(l.auditedAt);
  if (!at) return { skip: "audit_error" }; // ohne Audit-Zeitpunkt kein belegter Befund
  const findings = rankFindings(dedupeFindings((Array.isArray(l.websiteIssues) ? l.websiteIssues : [])
    .map((i) => normalizeIssue(i, { verified_at: at, source: "cold" })).filter(Boolean))).slice(0, MAX_HISTORY_FINDINGS).map(slim);
  if (!findings.length) return { skip: "no_visible_finding" };
  return { record: {
    lead_id: domain, domain, company, website: httpUrl(l.website) && normDomain(l.website) === domain ? httpUrl(l.website) : `https://${domain}/`,
    business_email: businessEmail(l.business_email || l.email), contact_name: str(l.contact_name || l.name, 80), contact_role: str(l.contact_role, 60),
    canton: /^[A-Z]{2}$/.test(l.canton || "") ? l.canton : null, municipality: str(l.municipality, 60), category: str(l.category, 40),
    historical_status: l.status, verified_findings: findings, last_verified_at: at, complete: false, reverified: false, source,
  } };
}

// Eintrag prüfen/bereinigen (z. B. aus einer Import-Datei) – nur bekannte Felder, Befunde erneut normalisiert.
export function cleanRecord(r) {
  if (!r || typeof r !== "object") return null;
  const domain = normDomain(r.domain || "");
  const company = str(r.company, 120), at = iso(r.last_verified_at);
  if (!domain || !DOMAIN_RE.test(domain) || !company || !at) return null;
  const findings = rankFindings(dedupeFindings((Array.isArray(r.verified_findings) ? r.verified_findings : []).map(cleanFinding).filter(Boolean))).slice(0, MAX_HISTORY_FINDINGS).map(slim);
  if (!findings.length) return null;
  return { lead_id: domain, domain, company, website: httpUrl(r.website) || `https://${domain}/`, business_email: businessEmail(r.business_email), contact_name: str(r.contact_name, 80),
    contact_role: str(r.contact_role, 60), canton: /^[A-Z]{2}$/.test(r.canton || "") ? r.canton : null, municipality: str(r.municipality, 60), category: str(r.category, 40),
    historical_status: HISTORICAL_STATUSES.includes(r.historical_status) ? r.historical_status : "recheck", verified_findings: findings, last_verified_at: at,
    complete: r.complete === true, reverified: r.reverified === true, source: HISTORY_SOURCES.includes(r.source) ? r.source : "backup" };
}

// ---------- Zustand ----------
export const emptyHistory = () => ({ schema: HISTORY_SCHEMA, updated_at: null, leads: {}, meta: {} });
const readJson = (file, empty) => {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (s?.schema > HISTORY_SCHEMA) throw new Error(`${path.basename(file)} hat Schema ${s.schema} – fail closed.`);
    return s && typeof s === "object" ? s : empty();
  } catch (e) { if (e.code === "ENOENT") return empty(); throw e; }
};
export const readHistory = (dataDir) => { const s = readJson(path.join(dataDir, HISTORY_FILE), emptyHistory); s.leads ||= {}; s.meta ||= {}; return s; };
export const emptyRecheck = () => ({ schema: HISTORY_SCHEMA, built_at: null, pending: [], done: {} });
export const readRecheck = (dataDir) => { const s = readJson(path.join(dataDir, RECHECK_FILE), emptyRecheck); s.pending ||= []; s.done ||= {}; return s; };
export const writeHistory = (dataDir, st) => writeAtomic(path.join(dataDir, HISTORY_FILE), JSON.stringify(st));
export const writeRecheck = (dataDir, st) => writeAtomic(path.join(dataDir, RECHECK_FILE), JSON.stringify(st));
export const withHistoryLock = (dataDir, fn) => withCrmLock(dataDir, fn, { name: HISTORY_LOCK });

// Upsert je Domain. Gleicher Lead (Domain / geschäftliche Adresse / Firma) = ein Datensatz. Neuester belegter Audit gewinnt (Befunde werden
// ersetzt, nicht vereinigt – ältere könnten behoben sein); leere Stammdaten werden ergänzt. → "added" | "merged" | "unchanged".
const FILL = ["company", "website", "business_email", "contact_name", "contact_role", "canton", "municipality", "category"];
export function upsertHistory(st, rec, now = new Date()) {
  const leads = st.leads;
  let key = leads[rec.domain] ? rec.domain : null;
  if (!key) { const idx = { ...buildIndex(leads), ids: new Set() }; key = findId(idx, { domain: rec.domain, email: rec.business_email, company: rec.company }); }
  const cur = key ? leads[key] : null;
  if (!cur) {
    leads[rec.domain] = { ...rec, first_seen_at: rec.last_verified_at, sources: [rec.source], stale: isStale(rec, now), updated_at: now.toISOString() };
    return "added";
  }
  const before = JSON.stringify(cur);
  const next = { ...cur };
  const newer = rec.last_verified_at > (cur.last_verified_at || "");
  for (const k of FILL) if (rec[k] && (!next[k] || (newer && k !== "company"))) next[k] = rec[k];
  if (newer) Object.assign(next, { verified_findings: rec.verified_findings, last_verified_at: rec.last_verified_at, complete: rec.complete, reverified: rec.reverified,
    historical_status: rec.historical_status, source: rec.source });
  next.first_seen_at = [cur.first_seen_at, rec.last_verified_at].filter(Boolean).sort()[0];
  next.sources = [...new Set([...(cur.sources || []), rec.source])].sort();
  if (key !== rec.domain) next.alt_domains = [...new Set([...(cur.alt_domains || []), rec.domain])].slice(0, 5);
  next.stale = isStale(next, now);
  if (JSON.stringify(next) === before) return "unchanged";
  next.updated_at = now.toISOString();
  leads[key] = next;
  return "merged";
}

// ---------- Laufende Übernahme aus discovered.json (read-only; nur bei geänderter Datei) ----------
export function ingestDiscovered({ dataDir, mailDir, now = new Date(), force = false }) {
  const file = path.join(mailDir, "mail_worker", "discovered.json");
  let stat; try { stat = fs.statSync(file); } catch { return { skipped: "missing" }; }
  const sig = `${stat.size}|${Math.round(stat.mtimeMs)}`;
  if (!force && readHistory(dataDir).meta.discovered_sig === sig) return { skipped: "unchanged" };
  let data; try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { skipped: "unreadable" }; }
  const recs = Object.values(data?.leads || {}).map((l) => historyRecord(l, { source: "discovered" })).filter((r) => r.record).map((r) => r.record);
  return withHistoryLock(dataDir, () => {
    const st = readHistory(dataDir), out = { added: 0, merged: 0, unchanged: 0, total: 0 };
    for (const r of recs) out[upsertHistory(st, r, now)]++;
    st.meta.discovered_sig = sig; st.meta.ingested_at = now.toISOString();
    st.updated_at = now.toISOString(); writeHistory(dataDir, st); // Signatur immer festhalten (nächster Lauf: „unchanged“)
    out.total = Object.keys(st.leads).length;
    return out;
  });
}

// ---------- Recheck-Warteschlange: Domains, die NUR im audited_index.json stehen (keine Evidence → nie direkt übernehmen) ----------
// known(domain) → true, wenn Registry/CRM/Historie die Domain schon kennen. meta: Domain → { company, canton, … , status } aus Backups.
export function refreshRecheckQueue(rq, { index, known, meta = {}, now = new Date() }) {
  const inQueue = new Set(rq.pending.map((p) => p.domain));
  let added = 0;
  const doms = Object.entries(index?.domains || {}).sort((a, b) => String(b[1]).localeCompare(String(a[1])) || a[0].localeCompare(b[0]));
  for (const [d] of doms) {
    const domain = normDomain(d);
    if (!domain || !DOMAIN_RE.test(domain) || inQueue.has(domain) || rq.done[domain] || known(domain)) continue;
    const m = meta[domain] || {};
    if (["excluded_private", "excluded_no_company"].includes(m.status)) { rq.done[domain] = { at: now.toISOString(), outcome: "excluded" }; continue; }
    rq.pending.push({ domain, company: str(m.company, 120), canton: /^[A-Z]{2}$/.test(m.canton || "") ? m.canton : null, municipality: str(m.municipality, 60),
      category: str(m.category, 40), business_email: businessEmail(m.business_email), status: HISTORICAL_STATUSES.includes(m.status) ? m.status : "recheck", tries: 0 });
    inQueue.add(domain); added++;
  }
  rq.built_at = now.toISOString();
  return { added, pending: rq.pending.length };
}

// Firmenname nur, wenn das Impressum ihn mit Rechtsform nennt (gleiche Regel wie lead-finder.js extractIdentity) – nie geraten.
const plain = (html = "") => String(html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ");
export const companyFromPages = (pages = {}) => (pages.impressum ? plain(pages.impressum).match(/^\s*([^\n]{2,80}?\b(?:AG|GmbH|SA|Sàrl|Sagl|KlG|KG))\s*$/m)?.[1]?.trim() || null : null);

// Genau EINE Domain passiv prüfen (Audit ausserhalb des Locks), Ergebnis + Checkpoint atomar. → { domain, outcome } oder null (nichts fällig).
export async function recheckStep({ dataDir, auditor, known = () => false, now = () => new Date() }) {
  const job = withHistoryLock(dataDir, () => {
    const rq = readRecheck(dataDir);
    while (rq.pending.length && (rq.done[rq.pending[0].domain] || known(rq.pending[0].domain))) {
      const p = rq.pending.shift();
      if (!rq.done[p.domain]) rq.done[p.domain] = { at: now().toISOString(), outcome: "known" };
    }
    if (!rq.pending.length) { writeRecheck(dataDir, rq); return null; }
    writeRecheck(dataDir, rq);
    return rq.pending[0];
  });
  if (!job) return null;
  const at = now().toISOString();
  let r = null, error = null;
  try { r = await auditor.audit(`https://${job.domain}/`); } catch (e) { error = String(e?.code || e?.message || "ERROR").slice(0, 60); }
  let outcome, rec = null;
  if (error || !r) outcome = "error";
  else if (r.reachable === false) outcome = "unreachable";
  else {
    const entry = fullAuditEntry(r, { domain: job.domain, audited_at: at });
    const company = job.company || companyFromPages(r.pages);
    if (!entry.findings.length) outcome = "no_finding";
    else if (!company) outcome = "no_company";
    else if (PRIVATE_RE.test(`${r.title || ""} ${company}`) && !r.pages?.impressum) outcome = "excluded";
    else {
      outcome = "added";
      const host = normDomain(r.finalUrl || "") === job.domain ? new URL(r.finalUrl).hostname : job.domain;
      rec = { lead_id: job.domain, domain: job.domain, company: str(company, 120), website: `https://${host}/`, business_email: job.business_email || null, contact_name: null, contact_role: null,
        canton: job.canton || null, municipality: job.municipality || null, category: job.category || null, historical_status: job.status || "recheck",
        verified_findings: entry.findings.slice(0, MAX_HISTORY_FINDINGS).map(slim), last_verified_at: at, complete: entry.complete === true, reverified: true, source: "index_recheck" };
    }
  }
  return withHistoryLock(dataDir, () => {
    const rq = readRecheck(dataDir);
    const i = rq.pending.findIndex((p) => p.domain === job.domain);
    const p = i >= 0 ? rq.pending.splice(i, 1)[0] : job;
    // Fehler/nicht erreichbar: einmal später erneut (ans Ende), danach endgültig – nie ein behaupteter Fehler.
    if ((outcome === "error" || outcome === "unreachable") && (p.tries || 0) + 1 < RECHECK_MAX_TRIES) rq.pending.push({ ...p, tries: (p.tries || 0) + 1 });
    else rq.done[job.domain] = { at, outcome };
    if (rec && !known(job.domain)) {
      const st = readHistory(dataDir);
      const res = upsertHistory(st, rec, new Date(at));
      if (res === "merged") rq.done[job.domain] = { at, outcome: "merged" };
      st.updated_at = at; writeHistory(dataDir, st);
    } else if (rec) rq.done[job.domain] = { at, outcome: "known" };
    writeRecheck(dataDir, rq);
    return { domain: job.domain, outcome: rq.done[job.domain]?.outcome || "retry", findings: rec ? rec.verified_findings.length : 0 };
  });
}

// Bekannte Domains (Registry inkl. alt_domains/E-Mail-Domains, Kontaktverzeichnis, Cold-Register, Historie).
export function knownDomainFn(src = {}) {
  const set = new Set([...buildIndex(src.registry?.leads || {}).byDomain.keys()]);
  for (const l of Object.values(src.directory?.leads || {})) if (l?.domain) set.add(normDomain(l.domain));
  for (const r of Object.values(src.reviews || {})) if (r?.domain) set.add(normDomain(r.domain));
  for (const h of Object.values(src.history?.leads || {})) { set.add(h.domain); for (const d of h.alt_domains || []) set.add(d); }
  return (d) => set.has(normDomain(d));
}

// ---------- Hintergrund: Übernahme aus discovered.json + Recheck, nie blockierend, nie ein Absturz des Dienstes ----------
// slot(fn): gemeinsamer Website-Slot mit dem TF-055-Backfill – nie zwei Websites gleichzeitig.
export function createHistoryWorker({ dataDir, mailDir, sources, auditor, slot = (fn) => fn(), now = () => new Date(), log = () => {},
  pauseMs = RECHECK_PAUSE_MS, idleMs = RECHECK_IDLE_MS, sleep = (ms, stop) => new Promise((r) => { const t0 = Date.now(); const i = setInterval(() => { if (stop() || Date.now() - t0 >= ms) { clearInterval(i); r(); } }, 500); }) }) {
  let lastIngest = 0, lastQueue = 0;
  async function tick() {
    const t = +now();
    if (t - lastIngest >= INGEST_EVERY_MS) {
      lastIngest = t;
      try { const r = ingestDiscovered({ dataDir, mailDir, now: now() }); if (!r.skipped) log({ event: "history_ingest", added: r.added, merged: r.merged, total: r.total }); }
      catch (e) { log({ event: "history_ingest_failed", error: String(e?.message || e).slice(0, 120) }); }
    }
    if (t - lastQueue >= QUEUE_REFRESH_MS) {
      lastQueue = t;
      try {
        let index = { domains: {} }; try { index = JSON.parse(fs.readFileSync(path.join(mailDir, "mail_worker", "audited_index.json"), "utf8")); } catch {}
        const known = knownDomainFn(sources());
        const r = withHistoryLock(dataDir, () => { const rq = readRecheck(dataDir); const x = refreshRecheckQueue(rq, { index, known, now: now() }); writeRecheck(dataDir, rq); return x; });
        log({ event: "history_queue", added: r.added, pending: r.pending });
      } catch (e) { log({ event: "history_queue_failed", error: String(e?.message || e).slice(0, 120) }); }
    }
    const known = knownDomainFn(sources());
    return slot(() => recheckStep({ dataDir, auditor, known, now }));
  }
  async function run(stop = () => false, { startDelayMs = 3 * 60_000 } = {}) {
    await sleep(startDelayMs, stop);
    while (!stop()) {
      let r = null;
      try { r = await tick(); if (r) log({ event: "history_recheck", outcome: r.outcome, findings: r.findings }); }
      catch (e) { log({ event: "history_recheck_failed", error: String(e?.message || e).slice(0, 120) }); }
      await sleep(r ? pauseMs : idleMs, stop);
    }
  }
  return { tick, run };
}

// ---------- Migration (idempotent): aktuelle discovered.json + Backup-Import + Recheck-Warteschlange → Dry-Run-Zahlen bzw. Schreiben ----------
// importData: { records: [Historien-Einträge], index_meta: { domain: { company, canton, …, status } }, generations, skipped } (lokal aus den
// verschlüsselten Backups extrahiert, nur minimale Felder). sources(): aktuelle CRM-Quellen (ohne history). Zahlen ohne personenbezogene Daten.
export async function migrateHistory({ dataDir, mailDir, sources, importData = null, dryRun = true, now = new Date() }) {
  const { crmUniverse, buildCrmLead } = await import("./lead-crm.js");
  const recs = [], skipped = {};
  const skip = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  let disc = {}; try { disc = JSON.parse(fs.readFileSync(path.join(mailDir, "mail_worker", "discovered.json"), "utf8")).leads || {}; } catch {}
  for (const l of Object.values(disc)) { const r = historyRecord(l, { source: "discovered" }); if (r.record) recs.push(r.record); else skip(r.skip); }
  for (const raw of Array.isArray(importData?.records) ? importData.records : []) { const r = cleanRecord(raw); if (r) recs.push(r); else skip("invalid_import"); }
  for (const [k, v] of Object.entries(importData?.skipped || {})) skipped[`backup_${k}`] = (skipped[`backup_${k}`] || 0) + (Number.isInteger(v) ? v : 0);
  let index = { domains: {} }; try { index = JSON.parse(fs.readFileSync(path.join(mailDir, "mail_worker", "audited_index.json"), "utf8")); } catch {}
  const apply = (st, rq) => {
    const out = { added: 0, merged: 0, unchanged: 0 };
    for (const r of recs) out[upsertHistory(st, r, now)]++;
    st.meta.migrated_at = now.toISOString(); st.updated_at = now.toISOString();
    const q = refreshRecheckQueue(rq, { index, known: knownDomainFn({ ...sources(), history: st }), meta: importData?.index_meta || {}, now });
    return { ...out, queue_added: q.added, queue_pending: q.pending };
  };
  const base = sources();
  const before = crmUniverse(base, now);
  let st = structuredClone(readHistory(dataDir)), rq = structuredClone(readRecheck(dataDir)), res;
  if (dryRun) res = apply(st, rq);
  else {
    // Sicherung der betroffenen Dateien, dann frisch unter dem Lock lesen, anwenden, atomar schreiben (kein Lost Update mit dem Dienst).
    const tag = now.toISOString().replace(/[:.]/g, "").replace(/-/g, "");
    for (const f of [HISTORY_FILE, RECHECK_FILE]) { const p = path.join(dataDir, f); if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak-tf058-${tag}`); }
    res = withHistoryLock(dataDir, () => { st = readHistory(dataDir); rq = readRecheck(dataDir); const r = apply(st, rq); writeHistory(dataDir, st); writeRecheck(dataDir, rq); return r; });
  }
  const after = crmUniverse({ ...base, history: st }, now);
  const added = [...after].filter((id) => !before.has(id));
  const src2 = { ...base, history: st };
  const addedLeads = added.map((id) => buildCrmLead(id, src2, now));
  // Historien-Einträge, die auf einen schon vorhandenen CRM-/Registry-Lead fallen (Registry/Review gewinnt) = MERGE; sonst Duplikat oder neu.
  const regIdx = { ...buildIndex(base.registry?.leads || {}), ids: new Set() };
  const histValid = Object.values(st.leads).filter((h) => h?.verified_findings?.length && h.company);
  let merge = 0, dupInCrm = 0;
  const addedSet = new Set(added);
  for (const h of histValid) {
    const hit = findId(regIdx, { domain: h.domain, email: h.business_email, company: h.company });
    if (hit ? before.has(hit) : before.has(h.domain)) merge++;
    else if (!addedSet.has(hit || h.domain) && !after.has(hit || h.domain)) dupInCrm++;
  }
  return {
    dry_run: dryRun, history_unique: histValid.length, occurrences: recs.length, history_added: res.added, history_merged: res.merged, history_unchanged: res.unchanged,
    crm_before: before.size, crm_after: after.size, would_add_to_crm: added.length, would_merge: merge,
    would_skip_duplicate: recs.length - res.added + dupInCrm, // mehrfach gesehene Leads (Backups/aktuell) + gleiche Firma/Adresse
    added_badges: addedLeads.reduce((a, l) => ((a[l.history_badge || "REGISTRY"] = (a[l.history_badge || "REGISTRY"] || 0) + 1), a), {}),
    added_audit: addedLeads.reduce((a, l) => ((a[l.errors.audit] = (a[l.errors.audit] || 0) + 1), a), {}),
    added_without_email: addedLeads.filter((l) => !l.email).length, skipped, recheck_queue_added: res.queue_added, recheck_pending: res.queue_pending,
    backup_generations: Number.isInteger(importData?.generations) ? importData.generations : 0,
  };
}
