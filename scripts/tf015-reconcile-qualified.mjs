// TF-JARVIS-CRM-015 – QUALIFIED-Leads (Lead-Datenbank) ohne Cold-Queue-Eintrag abgleichen.
// Erweitert TF-058 (scripts/tf058-requeue-qualified.mjs) um eine begründete Einordnung JEDES Kandidaten:
//   - nur Discovery-Status blocked_no_legal_basis darf in die Cold-Queue (already_in_lead_list / matched_existing_lead = Chris' Liste,
//     dort entscheidet die Versandgrundlage – bewusst NIE als Cold-Entwurf, vgl. lead-finder.js:499-514)
//   - bereits anderswo vertreten (Queue-Eintrag unter anderer Domain/Adresse/Firma, Gmail-Entwurf/-Versand an dieselbe Adresse oder Domain)
//   - Sperren (DNC, Opt-out, Suppression, CRM-DNC), Kunde, bereits kontaktiert, Sperrfrist
//   - aktueller, vollständig belegter, für Besucher sichtbarer Befund (Audit ≤ 7 Tage) – sonst Neuprüfung nötig
//   - Schweiz-/Repair-/Kontaktregeln (qualifyRepairLead → Stufe cold_lead_draft_only)
// Dry-Run ist Standard und schreibt nichts. Apply schreibt NUR neue «queued»-Einträge in individual_reviews.json (Sicherung,
// Compare-and-retry, atomares Umbenennen) – bestehende Einträge/Status bleiben unverändert. Kein Gmail-Aufruf, nie senden.
// Den Gmail-ENTWURF legt danach der laufende Mail-Worker mit seinem Pacing an; das Register übernimmt gmail_draft_status selbst.
//
// TF-CRM-016: Die passive Neuprüfung veralteter Audits (recheckStale) ist davon GETRENNT: sie schreibt nur ihre eigene Ergebnisdatei
// (tf016_recheck_results.json), nie Queue, Register, CRM oder Gmail. Ein Ergebnis ist reine Evidence und KEINE Kontakt-Freigabe –
// ob ein Lead eingereiht werden darf, entscheidet allein dieser Abgleich mit allen Regeln, und eingereiht wird nur im Apply (eigene Freigabe).
//
// Läuft im Mail-Worker-Container (Module unter /app, Zustand unter /data/secrets), per stdin:
//   docker exec -i -e TF015_RUN=1 -e TF015_MODE=dry jarvis-mail-mail-worker-1 node --input-type=module - < scripts/tf015-reconcile-qualified.mjs
//   Neuprüfung (nur nach Freigabe): -e TF015_MODE=recheck -e TF015_RECHECK_BATCH=10 [-e TF015_RECHECK_GAP_MS=5000] [-e TF015_RECHECK_TIMEOUT_MS=60000]
//   Einreihen (nur nach separater Freigabe): -e TF015_MODE=apply
// Ausgabe: nur Zahlen und Kategorien (keine Firmen, Adressen, Domains).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRESH_MS = 7 * 86_400_000;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const QUEUEABLE_SOURCE = "blocked_no_legal_basis";
const iso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const evidenceComplete = (issues) => Array.isArray(issues) && issues.length > 0 && issues.every((i) => i?.type && i.url && i.evidence && iso(i.detectedAt));
const domainOf = (addr = "") => String(addr).split("@")[1]?.toLowerCase() || "";

export const CATEGORIES = Object.freeze([
  "recoverable",                       // würde queued
  "represented_queue_entry",           // Queue-Eintrag existiert bereits (gleiche Domain/Adresse/Firma, offen)
  "represented_gmail",                 // Gmail-Entwurf oder -Versand an dieselbe Adresse/Domain
  "excluded_source_existing_list",     // already_in_lead_list – Chris' Liste, bewusst kein Cold-Entwurf
  "excluded_source_matched_existing",  // matched_existing_lead – Befunde an Chris' Lead gehängt, bewusst kein Cold-Entwurf
  "excluded_source_other",             // Discovery-Status nicht (mehr) qualifiziert
  "excluded_not_cold_stage",           // Schweiz-/Repair-/Kontaktregeln nicht erfüllt
  "excluded_no_visible_finding",       // kein aktueller, sichtbarer Befund (auch: Neuprüfung ohne belegten Befund / nicht erreichbar)
  "blocked_dnc",                       // DNC / Opt-out / Suppression / CRM-DNC
  "blocked_customer",                  // Kunde / stornierter Testverkauf
  "blocked_contacted_or_cooldown",     // bereits kontaktiert, Antwort, kein Interesse, Sperrfrist
  "blocked_no_business_email",         // keine (geschäftliche) Adresse
  "pending_recheck",                   // Audit älter als 7 Tage oder unvollständig → passive Neuprüfung nötig
  "pending_no_discovery_record",       // keine Evidence mehr in discovered.json (archiviert) → nie aus Registry-Text allein
  "error_build_failed",
]);

// Ergebnisse der Neuprüfung: verwendbar nur endgültig, ≤ 7 Tage alt und vollständig belegt; «kein Befund / nicht erreichbar» gilt 14 Tage.
export const RECHECK_RESULTS_FILE = "tf016_recheck_results.json";
export const RECHECK_LOCK_FILE = "tf016_recheck.lock";
const NO_FINDING_COOLDOWN_MS = 14 * 86_400_000;
const TRANSIENT_AUDIT_RE = /\b(429|5\d\d)\b|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timeout|aborted|network|socket/i;
const atomicWrite = (file, data) => {
  const tmp = `${file}.tf015-${process.pid}.tmp`, fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
};

export async function reconcileQualified({ secretsDir, base = "/app", dryRun = true, now = new Date(), repairStateDir = process.env.JARVIS_REPAIR_STATE_DIR || null, maxAttempts = 10,
  withPendingList = false, beforeCommit = () => {} }) {
  const m = (f) => import(pathToFileURL(path.join(base, f)).href);
  const { qualifyRepairLead, createColdDraft, coldDuplicate, REVIEWS_FILE, FREEMAIL_RE } = await m("swiss-repair.js");
  const { loadRegistry, registryBlock, CRM_UNAVAILABLE } = await m("lead-registry.js");
  const { normEmail } = await m("lead-db.js");
  const W = path.join(secretsDir, "mail_worker");
  const read = (file, fb) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return structuredClone(fb); } };
  const store = { dir: W, read: (name, fb) => read(path.join(W, name), fb), write: () => { throw new Error("read-only"); } };
  const reg = loadRegistry(store);
  const disc = store.read("discovered.json", { leads: {} }).leads || {};
  const sender = store.read("config.json", {}).sender;
  if (!sender?.name) throw new Error("config.sender fehlt – kein Entwurf möglich.");
  const gm = read(path.join(secretsDir, "gmail_jarvis.json"), { sent: {}, drafts: {} });
  const gmailRecords = [...Object.values(gm.sent || {}), ...Object.values(gm.drafts || {})];
  const contacted = new Set(gmailRecords.map((s) => normEmail(s?.to || "")).filter(Boolean));
  const gmailDomains = new Set([...contacted].map(domainOf).filter((d) => d && !FREEMAIL_RE.test(`x@${d}`)));
  const supp = store.read("suppression.json", {});
  const suppDomains = new Set(Object.keys(supp).filter((a) => !FREEMAIL_RE.test(a)).map(domainOf).filter(Boolean));
  const sales = { ...(repairStateDir ? read(path.join(repairStateDir, "sales.json"), { records: {} }).records : {}), ...(store.read("sales.json", { records: {} }).records || {}) };
  const file = path.join(W, REVIEWS_FILE);

  // Reste eines unterbrochenen Apply-Laufs (Temp-Datei vor dem Umbenennen) entfernen – nur eigene Muster.
  if (!dryRun) for (const f of fs.readdirSync(W)) if (/^individual_reviews\.json\.tf015-\d+\.tmp$/.test(f)) fs.rmSync(path.join(W, f), { force: true });

  const results = read(path.join(W, RECHECK_RESULTS_FILE), { domains: {} }).domains || {};
  const recheckEvidence = (d) => {
    const e = results[d];
    if (!e || e.final !== true || !iso(e.at)) return null;
    const age = +now - Date.parse(e.at), complete = e.outcome === "audited" && evidenceComplete(e.issues);
    if (complete && age <= FRESH_MS) return { use: true, issues: e.issues, at: e.at };
    if (!complete && age <= NO_FINDING_COOLDOWN_MS) return { use: false };
    return null;
  };

  const plan = async (reviews) => {
    const c = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
    const stages = {}, sources = {}, pendingWhy = { stale_audit: 0, incomplete_evidence: 0 };
    let candidates = 0, fresh_audit = 0, evidenceUsed = 0, noFindingUsed = 0, recheckRecoverable = 0;
    const add = {}, pending = [];
    const reviewDomains = new Set(Object.values(reviews).map((r) => r?.domain || r?.lead_id).filter(Boolean));
    for (const l of Object.values(reg.leads)) {
      if (l?.status !== "QUALIFIED") continue; // WAITING_FOR_DRAFT u. a. haben bereits einen Queue-Eintrag bzw. spätere Status
      candidates++;
      const why = registryBlock(store, { lead_id: l.lead_id, domain: l.domain, email: l.business_email, company: l.company }, reg);
      if (why === CRM_UNAVAILABLE) throw new Error("CRM (Do Not Contact) nicht lesbar – fail-safe, nichts eingeplant.");
      if (why) { if (/do-not-contact|opt-out|suppression/.test(why)) c.blocked_dnc++; else if (/Kunde|Testverkauf/.test(why)) c.blocked_customer++; else c.blocked_contacted_or_cooldown++; continue; }
      if (reviews[l.lead_id] || reviews[l.domain] || reviewDomains.has(l.domain)) { c.represented_queue_entry++; continue; }
      let lead = disc[l.domain] ? { ...disc[l.domain] } : null;
      if (!lead) { c.pending_no_discovery_record++; continue; }
      sources[lead.status] = (sources[lead.status] || 0) + 1;
      if (lead.status === "already_in_lead_list") { c.excluded_source_existing_list++; continue; }
      if (lead.status === "matched_existing_lead") { c.excluded_source_matched_existing++; continue; }
      if (lead.status !== QUEUEABLE_SOURCE) { c.excluded_source_other++; continue; }
      const to = normEmail(lead.email || lead.business_email || "");
      if (!EMAIL_RE.test(to) || FREEMAIL_RE.test(to)) { c.blocked_no_business_email++; continue; }
      if (supp[to] || suppDomains.has(lead.domain)) { c.blocked_dnc++; continue; }
      if (sales[lead.domain]?.sale?.selected_offer) { c.blocked_customer++; continue; }
      if (contacted.has(to) || gmailDomains.has(lead.domain)) { c.represented_gmail++; continue; }
      const dup = coldDuplicate({ ...reviews, ...add }, { ...lead, email: to }, { contacted, now });
      if (dup) { if (/offener Entwurf/.test(dup)) c.represented_queue_entry++; else c.blocked_contacted_or_cooldown++; continue; }
      const isStale = !(iso(lead.auditedAt) && +now - Date.parse(lead.auditedAt) <= FRESH_MS), isIncomplete = !evidenceComplete(lead.websiteIssues);
      let viaRecheck = false;
      if (!isStale && !isIncomplete) fresh_audit++;
      else {
        const rc = recheckEvidence(lead.domain);
        if (!rc) {
          c.pending_recheck++; if (isStale) pendingWhy.stale_audit++; if (isIncomplete) pendingWhy.incomplete_evidence++;
          if (withPendingList) pending.push({ domain: lead.domain, url: /^https?:\/\//i.test(lead.website || "") ? lead.website : `https://${lead.domain}/` });
          continue;
        }
        if (!rc.use) { c.excluded_no_visible_finding++; noFindingUsed++; continue; } // Neuprüfung ohne belegten Befund → nie einen Fehler behaupten
        lead = { ...lead, websiteIssues: rc.issues, auditedAt: rc.at, reachable: true }; viaRecheck = true; evidenceUsed++;
      }
      const q = qualifyRepairLead(lead, { now });
      stages[q.stage] = (stages[q.stage] || 0) + 1;
      if (!q.customer_findings.length) { c.excluded_no_visible_finding++; continue; }
      if (q.stage !== "cold_lead_draft_only") { c.excluded_not_cold_stage++; continue; }
      let r; try { r = createColdDraft({ ...lead, email: to }, { sender, now, q }); } catch { c.error_build_failed++; continue; }
      if (r.status !== "queued" || r.gmail_draft_id) { c.error_build_failed++; continue; }
      add[r.lead_id] = r; c.recoverable++;
      if (viaRecheck) recheckRecoverable++;
    }
    const safeKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [/^[a-z_]{1,40}$/.test(k) ? k : "andere", v]));
    return { summary: { candidates, fresh_audit, ...c, discovery_status: safeKeys(sources), repair_stage: safeKeys(stages), pending_recheck_reason: pendingWhy,
      recheck_evidence: { results_domains: Object.keys(results).length, used_with_finding: evidenceUsed, used_no_finding: noFindingUsed, recoverable_from_recheck: recheckRecoverable } }, add, pending };
  };

  if (dryRun) {
    const { summary, pending } = await plan(store.read(REVIEWS_FILE, { reviews: {} }).reviews || {});
    const accounted = CATEGORIES.reduce((s, k) => s + summary[k], 0);
    return { dry_run: true, ...summary, accounted, consistent: accounted === summary.candidates, ...(withPendingList ? { pending } : {}) };
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = fs.readFileSync(file, "utf8"), h0 = sha(raw), data = JSON.parse(raw);
    const { summary, add } = await plan(data.reviews || {});
    const ids = Object.keys(add).filter((id) => !data.reviews?.[id]);
    if (!ids.length) return { dry_run: false, ...summary, queued: 0, attempts: attempt };
    const tag = now.toISOString().replace(/[:.]/g, "").replace(/-/g, "");
    const bak = `${file}.bak-tf015-${tag}`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    for (const id of ids) data.reviews[id] = add[id];
    await beforeCommit(attempt); // Test-Naht für gleichzeitige Änderungen
    const tmp = `${file}.tf015-${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (sha(fs.readFileSync(file, "utf8")) !== h0) { fs.rmSync(tmp, { force: true }); await new Promise((r) => setTimeout(r, 300 * attempt)); continue; }
    fs.renameSync(tmp, file);
    const after = JSON.parse(fs.readFileSync(file, "utf8")).reviews || {};
    return { dry_run: false, ...summary, queued: ids.filter((id) => after[id]?.status === "queued").length, attempts: attempt, backup: path.basename(bak) };
  }
  throw new Error("individual_reviews.json änderte sich bei jedem Versuch – nichts geschrieben.");
}

// TF-CRM-016 – kontrollierte, passive Neuprüfung der pending_recheck-Kandidaten. Kandidaten kommen aus dem Abgleich oben (alle Sperren,
// Duplikate, Gmail-/Queue-Vertretung sind dort bereits ausgeschlossen – gesperrte Leads werden nie geprüft). Schreibt NUR die Ergebnisdatei:
//   - höchstens maxBatch Websites je Lauf (Standard 10), Mindestabstand gapMs, harte Zeitgrenze je Website (auditTimeoutMs)
//   - vorübergehende Fehler bis auditRetries mal, exponentiell mit Zufallszuschlag, gedeckelt (retryMaxMs); danach «transient_gave_up»
//     (nicht endgültig, frühestens nach transientRetryHours erneut)
//   - Circuit-Breaker: breakerThreshold vorübergehende Fehlschläge in Folge → Lauf endet (eigene Netzstörung, kein Weiterhämmern)
//   - Ergebnis je Domain sofort atomar gespeichert (neu einlesen + zusammenführen → parallele Einträge gehen nicht verloren);
//     Abbruch (shouldStop / Signal / Absturz) verliert höchstens die laufende Prüfung; nächster Lauf setzt fort, nie doppelt
//   - Sperrdatei: nie zwei Neuprüfungen gleichzeitig (veraltete Sperre nach lockStaleMs wird ersetzt)
export async function recheckStale({ secretsDir, base = "/app", dryRun = true, now = new Date(), auditor = null, repairStateDir = process.env.JARVIS_REPAIR_STATE_DIR || null,
  maxBatch = 10, gapMs = 5_000, auditTimeoutMs = 75_000, auditRetries = 2, retryBaseMs = 10_000, retryMaxMs = 60_000, jitter = 0.2, random = Math.random,
  transientRetryHours = 6, breakerThreshold = 5, lockStaleMs = 3 * 3_600_000, shouldStop = () => false, pid = process.pid,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const W = path.join(secretsDir, "mail_worker"), file = path.join(W, RECHECK_RESULTS_FILE);
  const readResults = () => { try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return j && typeof j.domains === "object" ? j : { v: 1, domains: {} }; } catch { return { v: 1, domains: {} }; } };
  const r0 = await reconcileQualified({ secretsDir, base, dryRun: true, now, repairStateDir, withPendingList: true });
  const known = readResults().domains;
  const waitTransient = (d) => { const e = known[d]; return !!e && e.final === false && iso(e.at) && +now - Date.parse(e.at) < transientRetryHours * 3_600_000; };
  const seen = new Set(), queue = [];
  let skippedTransientWait = 0;
  for (const p of r0.pending) {
    if (seen.has(p.domain)) continue; // dieselbe Domain nur einmal
    seen.add(p.domain);
    if (waitTransient(p.domain)) { skippedTransientWait++; continue; }
    queue.push(p);
  }
  const batch = queue.slice(0, maxBatch);
  const head = { pending_total: r0.pending_recheck, pending_reason: r0.pending_recheck_reason, batch_limit: maxBatch, eligible_for_recheck: queue.length,
    skipped_transient_wait: skippedTransientWait, outreach_authorized: false };
  if (dryRun) return { dry_run: true, ...head, next_batch: batch.length, results_domains: Object.keys(known).length };
  if (!auditor) throw new Error("Auditor fehlt – keine Neuprüfung.");

  const lock = path.join(W, RECHECK_LOCK_FILE);
  try { if (Date.now() - fs.statSync(lock).mtimeMs > lockStaleMs) fs.rmSync(lock, { force: true }); } catch {}
  let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); } catch { return { dry_run: false, ...head, locked: true, processed: 0 }; }
  try { fs.writeSync(fd, JSON.stringify({ pid, at: new Date().toISOString() })); } finally { fs.closeSync(fd); }
  const outcome = { audited: 0, audited_no_issue: 0, unreachable: 0, transient_gave_up: 0 };
  const durations = [];
  let retries = 0, processed = 0, evidenceOk = 0, circuitOpen = false, interrupted = false;
  try {
    for (const f of fs.readdirSync(W)) if (/^tf016_recheck_results\.json\.tf015-\d+\.tmp$/.test(f)) fs.rmSync(path.join(W, f), { force: true });
    const save = (d, entry) => { const j = readResults(); j.v = 1; j.domains[d] = entry; atomicWrite(file, j); };
    const timed = (url) => { let t; return Promise.race([Promise.resolve().then(() => auditor.audit(url)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error("audit timeout")), auditTimeoutMs); })]).finally(() => clearTimeout(t)); };
    let lastAt = 0, inARow = 0;
    for (const { domain, url } of batch) {
      if (shouldStop()) { interrupted = true; break; }
      if (inARow >= breakerThreshold) { circuitOpen = true; break; }
      const t0 = Date.now();
      let a = null, err = null, tries = 0;
      for (let attempt = 0; ; attempt++) {
        const wait = lastAt + gapMs - Date.now();
        if (wait > 0) await sleep(wait);
        lastAt = Date.now(); tries++; err = null;
        try { a = await timed(url); } catch (e) { err = e; }
        if (!err || !TRANSIENT_AUDIT_RE.test(String(err.message || err)) || attempt >= auditRetries || shouldStop()) break;
        retries++;
        await sleep(Math.min(retryMaxMs, Math.round(retryBaseMs * 2 ** attempt * (1 + jitter * random()))));
      }
      const transient = !!err && TRANSIENT_AUDIT_RE.test(String(err.message || err));
      const o = err ? (transient ? "transient_gave_up" : "unreachable") : a?.reachable === false ? "unreachable" : a?.issues?.length ? "audited" : "audited_no_issue";
      const issues = o === "audited" ? a.issues : [];
      const complete = evidenceComplete(issues);
      // Nur Evidence (Befunde mit Beleg/Zeitpunkt) – keine Kontaktdaten, keine Freigabe. Endgültig nur, wenn nicht vorübergehend gescheitert.
      save(domain, { at: now.toISOString(), outcome: o, tries, final: o !== "transient_gave_up", duration_ms: Date.now() - t0, evidence_complete: complete, issues, outreach_authorized: false });
      processed++; outcome[o]++; if (complete) evidenceOk++; durations.push(Date.now() - t0);
      inARow = o === "transient_gave_up" ? inARow + 1 : 0;
    }
  } finally { fs.rmSync(lock, { force: true }); }
  const sorted = durations.sort((x, y) => x - y), sec = (ms) => Math.round(ms / 100) / 10;
  // Eignung NACH der Neuprüfung: gleicher Abgleich, alle Regeln – nur gezählt, nichts eingereiht.
  const r1 = await reconcileQualified({ secretsDir, base, dryRun: true, now, repairStateDir });
  return { dry_run: false, ...head, processed, outcome, evidence_complete: evidenceOk, retries, circuit_open: circuitOpen, interrupted,
    remaining: Math.max(0, queue.length - processed), duration_s: { p50: sec(sorted[Math.floor(sorted.length / 2)] || 0), max: sec(sorted.at(-1) || 0), total: sec(sorted.reduce((s, x) => s + x, 0)) },
    results_domains: Object.keys(readResults().domains).length,
    eligibility_after_recheck: { recoverable_requires_approval: r1.recoverable, from_recheck: r1.recheck_evidence.recoverable_from_recheck,
      excluded_no_visible_finding: r1.excluded_no_visible_finding, excluded_not_cold_stage: r1.excluded_not_cold_stage, pending_recheck: r1.pending_recheck, consistent: r1.consistent } };
}

if (process.env.TF015_RUN === "1") {
  const mode = ["dry", "recheck", "apply"].includes(process.env.TF015_MODE) ? process.env.TF015_MODE : "dry";
  const num = (v, d, lo, hi) => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const secretsDir = process.env.TF015_SECRETS || "/data/secrets";
  // Batchgrösse hart begrenzt (1..50, Standard 10), Abstand mindestens 3 s, Zeitgrenze je Website 10..120 s – auch bei falscher Eingabe.
  const maxBatch = num(process.env.TF015_RECHECK_BATCH, 10, 1, 50), gapMs = num(process.env.TF015_RECHECK_GAP_MS, 5_000, 3_000, 120_000);
  const timeoutMs = num(process.env.TF015_RECHECK_TIMEOUT_MS, 60_000, 10_000, 120_000);
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop = true; }); // laufende Prüfung beenden, speichern, Sperre freigeben
  const job = mode === "recheck"
    ? import(pathToFileURL("/app/site-auditor.js").href).then(({ createAuditor }) => recheckStale({ secretsDir, dryRun: false, auditor: createAuditor({ totalMs: timeoutMs }),
      maxBatch, gapMs, auditTimeoutMs: timeoutMs + 15_000, shouldStop: () => stop }))
    : mode === "apply" ? reconcileQualified({ secretsDir, dryRun: false })
    : Promise.all([reconcileQualified({ secretsDir, dryRun: true }), recheckStale({ secretsDir, dryRun: true, maxBatch, gapMs })]).then(([reconcile, recheck]) => ({ reconcile, recheck }));
  // Fehler nur als eigene, feste Meldung oder Fehlerklasse – nie Rohtexte (JSON-/Netzfehler können Inhalte enthalten).
  const safeError = (e) => (/^(config\.sender fehlt|CRM \(Do Not Contact\)|individual_reviews\.json änderte|Auditor fehlt)/.test(String(e?.message)) ? String(e.message).slice(0, 120) : String(e?.name || "Error").slice(0, 40));
  job.then((r) => console.log(JSON.stringify(r)), (e) => { console.log(JSON.stringify({ ok: false, error: safeError(e) })); process.exitCode = 1; });
}
