// Passiver Hintergrund-Audit für das CRM (TF-055). Läuft im CRM-Dienst neben der Abhol-Schleife und blockiert sie nie.
//
// - Nur öffentlich zugängliche Websites, nur normale GET-Seitenaufrufe wie ein Besucher (site-auditor.js): keine Logins, keine
//   Formulare, keine POST-Requests, robots.txt wird beachtet, höchstens eine Anfrage je 1.5 s und genau EINE Website gleichzeitig.
// - Nach jeder Website eine Pause; Ergebnis je Website sofort atomar in site_findings.json (Checkpoint) – ein Neustart macht dort
//   weiter, wo noch kein (aktueller) Audit vorliegt. Fehler einer Website werden isoliert (Backoff), nie für alle.
// - Leads mit Do Not Contact / Opt-out / Suppression oder archiviert werden nicht geprüft (kein unnötiger Verkehr).
// - Gespeichert werden nur normalisierte Befunde (site-findings.js) – keine Seitentexte, keine Evidence.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAuditor } from "./site-auditor.js";
import { SITE_FINDINGS_FILE, SITE_FINDINGS_SCHEMA, FULL_AUDIT_OPTIONS, fullAuditEntry, normDomain } from "./site-findings.js";

export const REFRESH_AFTER_MS = 6 * 86_400_000; // vor Ablauf der 7-Tage-Frische neu prüfen
export const PAUSE_MS = 60_000;                 // Pause nach jeder Website
export const IDLE_MS = 10 * 60_000;             // nichts fällig → später erneut schauen
export const START_DELAY_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;

export const emptySiteFindings = () => ({ schema: SITE_FINDINGS_SCHEMA, updated_at: null, domains: {} });
export function readSiteFindings(dataDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dataDir, SITE_FINDINGS_FILE), "utf8"));
    if (s?.schema > SITE_FINDINGS_SCHEMA) throw new Error(`${SITE_FINDINGS_FILE} hat Schema ${s.schema} – fail closed.`);
    return s && typeof s === "object" && s.domains ? s : emptySiteFindings();
  } catch (e) { if (e.code === "ENOENT") return emptySiteFindings(); throw e; }
}
export function writeSiteFindings(dataDir, st) {
  const file = path.join(dataDir, SITE_FINDINGS_FILE), tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(st)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}

// Kandidaten aus den bestehenden Quellen (gleiche Domain-Ableitung wie lead-crm.js). Nur öffentliche Website, keine gesperrten Leads.
export function backfillCandidates(src = {}, universe = []) {
  const out = new Map();
  for (const id of universe) {
    const reg = src.registry?.leads?.[id], dir = src.directory?.leads?.[id], rv = src.reviews?.[id], crm = src.crm?.leads?.[id];
    if (reg?.do_not_contact || reg?.opt_out || reg?.suppressed || crm?.do_not_contact || crm?.archived) continue;
    const site = dir?.website_url || reg?.website || src.history?.leads?.[id]?.website || null; // TF-058: historischer Fund
    const domain = normDomain(dir?.domain || reg?.domain || rv?.domain || site || (id.includes("@") ? "" : id));
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) continue;
    let host = domain; try { if (site) host = new URL(site).hostname.toLowerCase(); } catch {}
    if (normDomain(host) !== domain) host = domain;
    if (!out.has(domain)) out.set(domain, { domain, website: `https://${host}/` });
  }
  return [...out.values()];
}
// Nächste fällige Website: nie geprüft zuerst (alphabetisch), dann ältester Stand jenseits REFRESH_AFTER_MS; Fehler mit Backoff.
export function nextDue(state, candidates, now = new Date()) {
  const t = +now, due = [];
  for (const c of candidates) {
    const e = state.domains?.[c.domain];
    if (e?.retry_at && Date.parse(e.retry_at) > t) continue;
    const last = e?.last_attempt_at ? Date.parse(e.last_attempt_at) : 0;
    if (last && t - last < REFRESH_AFTER_MS && !e.retry_at) continue;
    due.push([last, c]);
  }
  due.sort((a, b) => a[0] - b[0] || a[1].domain.localeCompare(b[1].domain));
  return due[0]?.[1] || null;
}

// Genau eine Website prüfen und das Ergebnis speichern. Gibt { domain, outcome, complete, findings } zurück (nie Inhalte).
export async function auditOne({ dataDir, candidate, auditor, now = () => new Date() }) {
  const at = now().toISOString();
  let r = null, error = null;
  try { r = await auditor.audit(candidate.website); } catch (e) { error = String(e?.code || e?.message || "ERROR").slice(0, 60); }
  const st = readSiteFindings(dataDir); // frisch lesen – einziger Schreiber ist dieser Prozess, aber nie einen älteren Stand zurückschreiben
  const prev = st.domains[candidate.domain] || { domain: candidate.domain };
  const e = { ...prev, domain: candidate.domain, last_attempt_at: at };
  let outcome;
  if (error || !r) { outcome = "error"; e.failures = (prev.failures || 0) + 1; e.last_error = error || "ERROR"; }
  else if (r.reachable === false) { outcome = "unreachable"; e.failures = (prev.failures || 0) + 1; e.last_error = "UNREACHABLE"; }
  else {
    const entry = fullAuditEntry(r, { domain: candidate.domain, audited_at: at });
    if (entry.complete) { e.full = entry; e.partial = null; outcome = "complete"; }
    else { e.partial = entry; outcome = "incomplete"; }
    e.failures = 0; e.last_error = null;
  }
  // Fehler: erneut mit Backoff (1 h, 2 h, 4 h … max. 24 h); unvollständig (meist dauerhaft, z. B. > 80 Links/robots.txt): nach 24 h;
  // vollständig: nächster Lauf nach REFRESH_AFTER_MS.
  e.retry_at = outcome === "complete" ? null : new Date(+now() + (outcome === "incomplete" ? MAX_BACKOFF_MS
    : Math.min(MAX_BACKOFF_MS, 3_600_000 * 2 ** Math.min(5, Math.max(0, e.failures - 1))))).toISOString();
  st.domains[candidate.domain] = e;
  st.updated_at = at;
  writeSiteFindings(dataDir, st);
  const used = e.full && outcome === "complete" ? e.full : e.partial;
  return { domain: candidate.domain, outcome, complete: outcome === "complete", findings: used?.findings?.length ?? null };
}

// Hintergrund-Schleife. sources() → Quellen inkl. crm; universe(src) → Lead-IDs. stop() → true beendet. Nie ein Absturz des Dienstes.
// slot(fn) (TF-058): gemeinsamer Website-Slot mit dem Historien-Recheck – nie zwei Websites gleichzeitig.
export function createBackfill({ dataDir, sources, universe, auditor = createAuditor(FULL_AUDIT_OPTIONS), now = () => new Date(), log = () => {}, slot = (fn) => fn(),
  pauseMs = PAUSE_MS, idleMs = IDLE_MS, sleep = (ms, stop) => new Promise((r) => { const t0 = Date.now(); const i = setInterval(() => { if (stop() || Date.now() - t0 >= ms) { clearInterval(i); r(); } }, 500); }) }) {
  async function step() {
    const src = sources();
    const c = nextDue(readSiteFindings(dataDir), backfillCandidates(src, universe(src)), now());
    if (!c) return null;
    return slot(() => auditOne({ dataDir, candidate: c, auditor, now }));
  }
  async function run(stop = () => false, { startDelayMs = START_DELAY_MS } = {}) {
    await sleep(startDelayMs, stop);
    while (!stop()) {
      let r = null;
      try { r = await step(); if (r) log({ event: "site_audit", outcome: r.outcome, complete: r.complete, findings: r.findings }); }
      catch (e) { log({ event: "site_audit_failed", error: String(e?.message || e).slice(0, 120) }); }
      await sleep(r ? pauseMs : idleMs, stop);
    }
  }
  return { step, run };
}
