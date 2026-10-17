// Jarvis Lead-CRM – VPS-Dienst (TF-053). Eigener Container jarvis-crm-worker (Projekt jarvis-crm), getrennt vom Mail-Worker.
//
//   Browser (x-jarvis-key)  →  /api/crm (Netlify, nur crm.*-Allowlist)  ←  dieser Dienst (x-jarvis-crm, nur ausgehend)
//
// - Liest die bestehenden Quellen NUR (Lead-Datenbank, Cold-Register, Gmail-Register: /data/mail read-only; Kontaktverzeichnis
//   /data/crm/lead_contact_directory.json) und baut daraus zur Laufzeit die CRM-Sicht (lead-crm.js). Keine Kopie der Kontaktdaten.
// - Einziger Schreiber von lead_crm.json: jede Änderung unter Datei-Lock (crm.lock, exklusiv, verwaist nach 30 s), frisch gelesen,
//   atomar geschrieben (tmp + fsync + rename), Audit-Zeile in crm_audit.jsonl (ohne Notiz-Inhalte). Idempotent je request_id.
// - Keine Shell, kein exec, kein Docker-Socket, keine Pfade aus Aufträgen: nur die festen crm.*-Aktionen aus lead-crm.js.
// - Kein gmail.js im Image: der Dienst kann strukturell nicht senden, keine Entwürfe anlegen und nicht anrufen.
// - Tägliches verschlüsseltes Backup (backup.js, Public Key) von lead_crm.json + crm_audit.jsonl + Kontaktverzeichnis, lokal + offsite.
// - TF-055: passiver Hintergrund-Audit (site-backfill.js, eine Website gleichzeitig, nur GET) schreibt site_findings.json; der
//   Repair-Service liefert repair_findings.json (read-only Mount). Beides fliesst nur in die Fehlerzahl der CRM-Sicht.
//   Abschalten: JARVIS_CRM_BACKFILL=off.
// - TF-058: discovery_issue_history.json (discovery-history.js) – historische Website-Fehler-Leads als zusätzliche CRM-Lesequelle (nie
//   Outreach). Beobachtet discovered.json read-only und prüft Domains, die nur noch im audited_index.json stehen, passiv neu (Checkpoint
//   discovery_recheck.json). Teilt sich mit dem Backfill genau EINEN Website-Slot. Abschalten: JARVIS_CRM_HISTORY=off.
//
//   node crm-service.js --service | --healthcheck | --report | --backup-now | --history-migrate [--dry-run] [--import datei]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CRM_FILE, CRM_AUDIT_FILE, normalizeCrmState, emptyCrmState, buildCrmView, buildCrmLead, crmUniverse, applyCrmAction, cleanCrmLead, CRM_ACTIONS } from "./lead-crm.js";
import { crmStats, compactCrmLead } from "./public/crm-model.js";
import { crmAgentToken } from "./crm-api.js";
import { SITE_FINDINGS_FILE, REPAIR_FINDINGS_FILE } from "./site-findings.js";
import { PHONEBOOK_CACHE_FILE, multisourceConfig, multisourceLookup, normalizePhonebookCache, emptyPhonebookCache, providerStatus, runPhonebookBackfill, inspectSchema, normalizeSwissPhone } from "./phonebook-compliance.js";

const HISTORY_FILE = "discovery_issue_history.json"; // = discovery-history.js HISTORY_FILE (dort importiert dieses Modul den Lock)

export const LOCK_FILE = "crm.lock";
export const HEALTH_FILE = "crm_health.json";
export const BACKUP_STATUS = "crm_backup_status.json";
export const BACKUP_DIR = "crm_backups";
export const BACKUP_FILES = Object.freeze([CRM_FILE, CRM_AUDIT_FILE, "lead_contact_directory.json"]);
export const VIEW_RESEND_MS = 30 * 60_000;
export const STALE_REQUEST_MS = 5 * 60_000;
export const ADMISSION_FILE = "crm_admission.json";

// TF-076: idempotenter Abgleich des aktiven CRM mit der Aufnahmeregel (≥ 1 verifizierter Fehler). Löscht NICHTS: die Sicht filtert ohnehin
// zur Laufzeit; hier wird nur festgehalten, welche Kandidaten (seit wann, mit welchem Zustand) ausserhalb des aktiven CRM stehen
// (crm_admission.json, Rückverfolgbarkeit) + eine Audit-Zeile ohne personenbezogene Daten. Erneuter Lauf mit gleichem Stand = gleiches Ergebnis.
export function admissionSync({ dataDir, sources, now = new Date(), write = true }) {
  const src = { ...sources(), crm: loadCrm(dataDir, now) };
  const v = buildCrmView(src, now);
  let prev = { excluded: {} }; try { prev = JSON.parse(fs.readFileSync(path.join(dataDir, ADMISSION_FILE), "utf8")); } catch {}
  const active = new Set(v.leads.map((l) => l.lead_id));
  const excluded = {};
  for (const id of crmUniverse(src, now)) {
    if (active.has(id)) continue;
    const st = buildCrmLead(id, src, now).admission;
    const was = prev.excluded?.[id];
    excluded[id] = { state: st, since: was?.state === st ? was.since : now.toISOString() };
  }
  const readmitted = Object.keys(prev.excluded || {}).filter((id) => active.has(id)).length;
  const newly = Object.keys(excluded).filter((id) => !prev.excluded?.[id]).length;
  const doc = { schema: 1, updated_at: now.toISOString(), candidates: v.candidates, active: v.total, excluded_counts: v.excluded, excluded };
  if (write) { writeAtomic(path.join(dataDir, ADMISSION_FILE), JSON.stringify(doc)); audit(dataDir, { action: "crm.admissionSync", source: "tf076", outcome: "success", candidates: v.candidates, active: v.total, excluded: v.excluded, newly_excluded: newly, readmitted }); }
  return { candidates: v.candidates, active: v.total, excluded: v.excluded, newly_excluded: newly, readmitted, written: write };
}

// ---------- Lock: genau ein Schreiber für lead_crm.json (Dienst, CLI, Tests – auch über Prozess-/Containergrenzen) ----------
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// name: eigener Lock je Datei (TF-058: history.lock für discovery_issue_history.json / discovery_recheck.json).
export function withCrmLock(dir, fn, { timeoutMs = 15_000, staleMs = 30_000, name = LOCK_FILE } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name), token = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { fs.writeFileSync(file, JSON.stringify({ token, at: Date.now() }), { flag: "wx", mode: 0o600 }); break; }
    catch (e) {
      // EPERM/EBUSY/EACCES: Windows meldet so eine Datei, die ein anderer Prozess gerade löscht – wie „belegt“ behandeln.
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      let held = null; try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (held && Date.now() - held.at > staleMs) {
        // Verwaister Lock (Prozess abgestürzt): beiseite legen und prüfen, dass es wirklich der alte war – sonst zurücklegen.
        const aside = `${file}.stale-${token}`;
        try {
          fs.renameSync(file, aside);
          const got = JSON.parse(fs.readFileSync(aside, "utf8"));
          if (got.token !== held.token) { try { fs.linkSync(aside, file); } catch {} }
          fs.rmSync(aside, { force: true });
        } catch {}
        continue;
      }
      if (Date.now() > deadline) throw Object.assign(new Error("CRM-Lock belegt – bitte erneut versuchen."), { code: "LOCKED" });
      sleepSync(10 + Math.floor(Math.random() * 25));
    }
  }
  try { return fn(); }
  finally { try { if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.rmSync(file, { force: true }); } catch {} }
}
export function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; }
      catch (e) { if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e; sleepSync(10 + i * 5); } // Windows: Leser hält die Datei kurz offen
    }
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
export function loadCrm(dir, now = new Date()) {
  let s = null;
  try { s = JSON.parse(fs.readFileSync(path.join(dir, CRM_FILE), "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw new Error(`${CRM_FILE} nicht lesbar – fail closed (${e.message})`); }
  return normalizeCrmState(s || emptyCrmState(now), now);
}
export const saveCrm = (dir, st) => writeAtomic(path.join(dir, CRM_FILE), JSON.stringify(st));
export function audit(dir, entry) {
  fs.appendFileSync(path.join(dir, CRM_AUDIT_FILE), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
}

// ---------- Quellen (nur lesen; nach Grösse+Änderungszeit gecacht; kaputte/halb geschriebene Datei → letzter guter Stand) ----------
export function createSourceReader({ dataDir, mailDir, repairDir = null, env = process.env }) {
  const cache = new Map();
  const read = (file, fallback) => {
    let st; try { st = fs.statSync(file); } catch { cache.delete(file); return fallback; }
    const key = `${st.size}|${st.mtimeMs}`, c = cache.get(file);
    if (c && c.key === key) return c.data;
    try { const data = JSON.parse(fs.readFileSync(file, "utf8")); cache.set(file, { key, data }); return data; }
    catch { return c ? c.data : fallback; }
  };
  return () => ({
    registry: read(path.join(mailDir, "mail_worker", "lead_registry.json"), { leads: {} }),
    reviews: read(path.join(mailDir, "mail_worker", "individual_reviews.json"), { reviews: {} }).reviews || {},
    gmail: read(path.join(mailDir, "gmail_jarvis.json"), null),
    directory: read(path.join(dataDir, "lead_contact_directory.json"), { leads: {} }),
    siteFindings: read(path.join(dataDir, SITE_FINDINGS_FILE), { domains: {} }),
    repairFindings: repairDir ? read(path.join(repairDir, REPAIR_FINDINGS_FILE), { orders: {} }) : { orders: {} },
    history: read(path.join(dataDir, HISTORY_FILE), { leads: {} }), // TF-058: historische Funde (CRM-eigen, niedrigste Priorität)
    // TF-075A: Kontaktformular-Anfragen je zugeordnetem Lead (nur Status-Wörter, keine Adressen/Inhalte; Schreiber: Mail-Worker).
    contactForms: read(path.join(mailDir, "mail_worker", "contact_forms_public.json"), { leads: {} }),
    // TF-078: Telefonbuch-Ergebnisse je Nummer (nur phone_hash + Status, Schreiber: --phonebook-backfill) + Anbieter-Zustand ohne Schlüssel.
    phonebookCache: read(path.join(dataDir, PHONEBOOK_CACHE_FILE), null),
    phonebookProvider: { configured: multisourceConfig(env).configured },
  });
}

// Eine Schreibaktion: Lock → frisch lesen → prüfen (Lead muss bekannt sein) → anwenden → atomar speichern → Audit. Gibt den neuen Lead zurück.
export function applyRequest({ dataDir, sources, req, now = new Date(), source = "cloud-ui" }) {
  return withCrmLock(dataDir, () => {
    const st = loadCrm(dataDir, now);
    const src = { ...sources(), crm: st };
    const known = crmUniverse(src);
    const lookup = (id) => (known.has(id) ? buildCrmLead(id, src, now) : null);
    const res = applyCrmAction(st, req, { now, lookup });
    if (res.ok && !res.duplicate) saveCrm(dataDir, st);
    audit(dataDir, { request_id: req.request_id || null, action: String(req.action || "").slice(0, 40), lead_id: res.lead_id || (typeof req.params?.lead_id === "string" ? req.params.lead_id.slice(0, 120) : null),
      source, outcome: res.ok ? (res.duplicate ? "duplicate" : "success") : "denied", code: res.code || null, changed: res.changed || [] });
    const lead = res.ok ? buildCrmLead(res.lead_id, { ...src, crm: st }, now) : null;
    return { ...res, lead };
  });
}

// ---------- Verschlüsseltes Backup (gleiches Format wie backup.js, eigener Umfang, eigener Ordner) ----------
export async function crmBackup({ dataDir, publicKeyPem, now = new Date(), upload = null, force = false, zurichDay }) {
  const { createBackup, storeLocal } = await import("./backup.js");
  const statusFile = path.join(dataDir, BACKUP_STATUS);
  let st = {}; try { st = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
  const today = zurichDay(now);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", hourCycle: "h23" }).format(now));
  const retry = st.day === today && !st.offsite_ok && st.local && upload && +now - Date.parse(st.attempt_at || 0) >= 60 * 60_000;
  if (!force && !retry && (st.day === today || hour < 3)) return { skipped: true, status: st };
  let env;
  if (retry && !force) env = JSON.parse(fs.readFileSync(path.join(dataDir, BACKUP_DIR, st.local), "utf8"));
  else {
    const files = BACKUP_FILES.filter((f) => fs.existsSync(path.join(dataDir, f)));
    // Konsistenter Stand: lead_crm.json unter dem Schreib-Lock lesen (kein halber Zustand zwischen zwei Änderungen).
    env = withCrmLock(dataDir, () => createBackup({ secretsDir: dataDir, files, publicKeyPem, now }));
  }
  const local = retry && !force ? { name: st.local, generations: st.generations } : storeLocal(env, path.join(dataDir, BACKUP_DIR));
  let offsite = { ok: false, error: "kein Upload konfiguriert" };
  if (upload) { try { offsite = await upload(env); } catch (e) { offsite = { ok: false, error: e.message }; } }
  const next = { day: today, last_at: env.created_at, attempt_at: now.toISOString(), local: local.name, generations: local.generations, files: env.files.length,
    key_id: env.key_id, offsite_ok: !!offsite.ok, offsite_error: offsite.ok ? null : String(offsite.error || "").slice(0, 120) };
  writeAtomic(statusFile, JSON.stringify(next, null, 2));
  return { skipped: false, status: next };
}
// TF-078: Anbieter-Zustand für die Owner-Sicht (kein Schlüssel, keine Nummern).
export const loadPhonebookCache = (dataDir) => { try { return normalizePhonebookCache(JSON.parse(fs.readFileSync(path.join(dataDir, PHONEBOOK_CACHE_FILE), "utf8"))); } catch { return emptyPhonebookCache(); } };
export const phonebookSummary = (dataDir, now = new Date(), env = process.env) => providerStatus(loadPhonebookCache(dataDir), multisourceConfig(env), now);
export const PHONEBOOK_LOCK = "phonebook.lock";

// TF-078: gestaffelte Telefonbuch-Prüfung der aktiven CH-Leads (nur verifizierte Fehler-Leads/Kunden/Kontaktformular = buildCrmView).
// Ohne Schlüssel: keine Abfrage. Ohne bestätigtes Werbe-Feld: KEIN Backfill (jede Abfrage wäre UNKNOWN = Kosten ohne Nutzen) – ausser
// ausdrücklich --allow-unconfirmed. Ergebnis + Nutzung landen im Cache (fortsetzbar). Nur Zähler im Rückgabewert.
export async function phonebookBackfill({ dataDir, sources, env = process.env, now = () => new Date(), fetchFn = globalThis.fetch, dryRun = false, allowUnconfirmed = false }) {
  const config = multisourceConfig(env);
  if (!config.configured) return { ok: false, code: "PHONEBOOK_PROVIDER_NOT_CONFIGURED", env: "MULTISOURCE_API_KEY" };
  if (!config.fieldConfirmed && !allowUnconfirmed && !dryRun) return { ok: false, code: "PROMO_FIELD_NOT_CONFIRMED", env: ["MULTISOURCE_NOPROMO_FIELD", "MULTISOURCE_NOPROMO_SEMANTICS"] };
  const t = now();
  const src = { ...sources(), crm: loadCrm(dataDir, t) };
  const leads = buildCrmView(src, t).leads.filter((l) => !l.archived).map((l) => {
    const dir = src.directory?.leads?.[l.lead_id];
    return { lead_id: l.lead_id, market: l.market || "CH", do_not_contact: l.do_not_contact, phone: dir?.phone_normalized || dir?.phone || l.phone || null };
  });
  // Eigener Lock (phonebook.lock): nie zwei Läufe gleichzeitig (Tageslimit), blockiert lead_crm.json-Schreiber nicht.
  const lockFile = path.join(dataDir, PHONEBOOK_LOCK);
  try { fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx", mode: 0o600 }); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    let held = null; try { held = JSON.parse(fs.readFileSync(lockFile, "utf8")); } catch {}
    if (held && Date.now() - held.at < 30 * 60_000) return { ok: false, code: "ALREADY_RUNNING" };
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
  }
  try {
    const cache = loadPhonebookCache(dataDir);
    const save = () => writeAtomic(path.join(dataDir, PHONEBOOK_CACHE_FILE), JSON.stringify(cache));
    const sum = await runPhonebookBackfill({ leads, cache, now, dryRun, maxPerRun: config.maxPerRun, maxPerDay: config.maxPerDay,
      lookup: (e164) => multisourceLookup(e164, { config, fetchFn }), onProgress: (s) => { if (s.looked_up % 10 === 0) save(); } });
    if (!dryRun) { save(); audit(dataDir, { action: "phonebook.backfill", source: "tf078", outcome: sum.stopped || "success", looked_up: sum.looked_up, by_status: sum.by_status, due: sum.due }); }
    return { ok: true, field_confirmed: config.fieldConfirmed, max_per_run: config.maxPerRun, max_per_day: config.maxPerDay, ...sum, usage: providerStatus(cache, config, now()) };
  } finally { try { fs.rmSync(lockFile, { force: true }); } catch {} }
}
// TF-078: Schema-Diagnose mit GENAU EINER Abfrage – Ausgabe nur HTTP-Status + Feldnamen + Kandidaten-Hinweis, nie Werte.
export async function phonebookDiagnose({ dataDir, sources, env = process.env, number = null, fetchFn = globalThis.fetch, now = new Date() }) {
  const config = multisourceConfig(env);
  if (!config.configured) return { ok: false, code: "PHONEBOOK_PROVIDER_NOT_CONFIGURED", env: "MULTISOURCE_API_KEY" };
  let e164 = normalizeSwissPhone(number);
  if (!e164) {
    const src = { ...sources(), crm: loadCrm(dataDir, now) };
    for (const l of buildCrmView(src, now).leads) {
      const d = src.directory?.leads?.[l.lead_id];
      const n = (l.market || "CH") === "CH" ? normalizeSwissPhone(d?.phone_normalized || d?.phone) : null;
      if (n) { e164 = n; break; }
    }
  }
  if (!e164) return { ok: false, code: "NO_TEST_NUMBER" };
  const cache = loadPhonebookCache(dataDir);
  if (cache.usage.rate_limited_until && Date.parse(cache.usage.rate_limited_until) > +now) return { ok: false, code: "RATE_LIMITED" };
  const r = await multisourceLookup(e164, { config: { ...config, field: null, semantics: null }, fetchFn, raw: true });
  return { ok: r.http_status != null && r.http_status < 300, status_reason: r.reason, ...inspectSchema(r.body ?? null, r.http_status), configured_field: config.field, configured_semantics: config.semantics };
}

export const backupSummary = (dataDir) => { try { const s = JSON.parse(fs.readFileSync(path.join(dataDir, BACKUP_STATUS), "utf8")); return { last_at: s.last_at || null, offsite_ok: !!s.offsite_ok, generations: s.generations || 0 }; } catch { return null; } };

// ---------- Agent: holt CRM-Aufträge ab, meldet Ergebnis + aktuelle Sicht (nur Allowlist-Felder) ----------
export { crmAgentToken }; // Ableitung des Agent-Schlüssels: genau eine Definition (crm-api.js)
export function createCrmAgent({ dataDir, sources, url, token, fetchFn = globalThis.fetch, now = () => new Date(), log = () => {} }) {
  if (!token || token.length < 32 || !url) return null;
  const endpoint = url.replace(/\/api\/(state|crm)$/, "").replace(/\/+$/, "") + "/api/crm";
  let sent = { fp: null, at: 0 };
  const post = async (body) => {
    const r = await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-crm": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const view = () => {
    const t = now();
    const v = buildCrmView({ ...sources(), crm: loadCrm(dataDir, t) }, t);
    // TF-076: nur aktive Leads (buildCrmView); errors.top weglassen (= items[0..1], Netlify-Limit 6 MB).
    const leads = v.leads.map(cleanCrmLead).filter(Boolean).map(compactCrmLead);
    const fp = crypto.createHash("sha256").update(JSON.stringify(leads.map(({ follow_up, ...l }) => l))).digest("hex").slice(0, 24);
    return { fp, body: { leads, total: leads.length, generated_at: v.generated_at, stats: crmStats(leads, t), backup: backupSummary(dataDir), phonebook_provider: phonebookSummary(dataDir, t) } };
  };
  async function pollOnce() {
    let v = null, payload = {};
    try {
      v = view();
      const backoff = sent.tooLarge && +now() - sent.at <= VIEW_RESEND_MS; // nach 413 höchstens alle VIEW_RESEND_MS erneut versuchen
      if (!backoff && (v.fp !== sent.fp || +now() - sent.at > VIEW_RESEND_MS)) payload = { view: v.body };
    } catch (e) { log({ event: "view_failed", error: String(e.message).slice(0, 160) }); }
    let pulled;
    try { pulled = await post({ op: "pull", ...payload }); }
    catch (e) { log({ event: "pull_failed", error: String(e.message).slice(0, 120) }); return { hot: false, handled: 0, status: 0 }; }
    // Sicht zu gross (413): Aufträge trotzdem abholen (Pull ohne Sicht), damit Notizen/DNC/Anrufe nicht blockiert sind. Die Sicht in der Cloud
    // bleibt dann veraltet – sichtbar über view_too_large im Log und viewStatus 413 im Health-File (nie stillschweigend).
    let viewStatus = payload.view ? pulled.status : null;
    if (pulled.status === 413 && payload.view) {
      log({ event: "view_too_large", bytes: JSON.stringify(payload.view).length, leads: payload.view.leads?.length || 0 });
      try { pulled = await post({ op: "pull" }); }
      catch (e) { log({ event: "pull_failed", error: String(e.message).slice(0, 120) }); return { hot: false, handled: 0, status: 0, viewStatus }; }
    }
    if (pulled.status !== 200) { log({ event: "pull_refused", status: pulled.status }); return { hot: false, handled: 0, status: pulled.status, viewStatus }; }
    if (viewStatus === 200) sent = { fp: v.fp, at: +now() };
    else if (viewStatus === 413) sent = { fp: null, at: +now(), tooLarge: true }; // nicht bei jedem Takt erneut 6+ MB schicken
    let handled = 0;
    for (const rq of Array.isArray(pulled.body.requests) ? pulled.body.requests.slice(0, 20) : []) {
      let res;
      if (!rq || typeof rq.action !== "string" || CRM_ACTIONS[rq.action]?.kind !== "write") res = { ok: false, code: "UNKNOWN_ACTION", error: "Unbekannte Aktion." };
      else if (!rq.created_at || +now() - Date.parse(rq.created_at) > STALE_REQUEST_MS) res = { ok: false, code: "STALE_REQUEST", error: "Auftrag zu alt." };
      else {
        try { res = applyRequest({ dataDir, sources, req: { request_id: rq.request_id, action: rq.action, params: rq.params || {} }, now: now() }); }
        catch (e) { res = { ok: false, code: e.code === "LOCKED" ? "LOCKED" : "FAILED", error: String(e.message).slice(0, 160) }; }
      }
      try { await post({ op: "result", request_id: rq?.request_id, ok: !!res.ok, code: res.code || null, error: res.ok ? null : res.error, lead: res.lead ? cleanCrmLead(res.lead) : null }); }
      catch (e) { log({ event: "result_failed", error: String(e.message).slice(0, 120) }); }
      log({ event: "crm_action", action: String(rq?.action || "").slice(0, 40), ok: !!res.ok, code: res.code || null });
      handled++;
    }
    return { hot: !!pulled.body.hot || handled > 0, handled, status: 200, viewStatus };
  }
  const uploadBackup = async (env) => {
    const r = await post({ op: "backup", backup: env });
    return r.status === 200 ? { ok: true, key: r.body.key } : { ok: false, error: `HTTP ${r.status}` };
  };
  return { pollOnce, uploadBackup, endpoint, viewTooLarge: () => !!sent.tooLarge };
}
export const nextDelayMs = ({ hot, status }) => (status === 200 ? (hot ? 3_000 : 20_000) : status === 0 ? 30_000 : 5 * 60_000);

// ---------- Kommandozeile / Dienst ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const DATA = process.env.JARVIS_CRM_DIR || "/data/crm";
  const MAIL = process.env.JARVIS_MAIL_SECRETS || "/data/mail";
  const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
  const zurichDay = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const pem = () => { for (const p of ["backup-public.pem", "deploy/vps/backup-public.pem"]) { try { return fs.readFileSync(new URL(p, import.meta.url), "utf8"); } catch {} } return null; };
  const REPAIR_EXPORT = process.env.JARVIS_REPAIR_EXPORT_DIR || "/data/repair-export";
  const sources = createSourceReader({ dataDir: DATA, mailDir: MAIL, repairDir: REPAIR_EXPORT });
  const main = async () => {
    if (args.includes("--healthcheck")) {
      try { const h = JSON.parse(fs.readFileSync(path.join(DATA, HEALTH_FILE), "utf8")); return Date.now() - h.beat < 3 * 60_000 ? 0 : 1; } catch { return 1; }
    }
    if (args.includes("--report")) {
      // Nur Kennzahlen – keine personenbezogenen Daten.
      const t = new Date(), v = buildCrmView({ ...sources(), crm: loadCrm(DATA, t) }, t), st = crmStats(v.leads, t);
      const ids = v.leads.map((l) => l.lead_id), crmEntries = Object.keys(loadCrm(DATA, t).leads).length;
      const audits = {}; for (const l of v.leads) audits[l.errors.audit] = (audits[l.errors.audit] || 0) + 1;
      const doms = v.leads.map((l) => l.domain).filter(Boolean);
      log({ event: "report", leads: v.total, candidates: v.candidates, excluded: v.excluded, view_bytes: JSON.stringify(v.leads.map(cleanCrmLead).filter(Boolean).map(compactCrmLead)).length, duplicates: ids.length - new Set(ids).size, domain_duplicates: doms.length - new Set(doms).size, crm_entries: crmEntries, ...st,
        with_findings_total: v.leads.filter((l) => l.findings_total > 0).length, audits, backup: backupSummary(DATA),
        history: { badges: v.leads.reduce((a, l) => (l.history_badge ? ((a[l.history_badge] = (a[l.history_badge] || 0) + 1), a) : a), {}),
          stale: v.leads.filter((l) => l.history_badge && l.errors.audit === "STALE").length, no_email: v.leads.filter((l) => l.history_badge && !l.email).length,
          ...(await import("./discovery-history.js").then((h) => { const s = h.readHistory(DATA), q = h.readRecheck(DATA); const out = {}; for (const d of Object.values(q.done)) out[d.outcome] = (out[d.outcome] || 0) + 1;
            return { entries: Object.keys(s.leads).length, recheck_pending: q.pending.length, recheck_done: out }; })) } });
      return 0;
    }
    if (args.includes("--admission")) {
      // TF-076: --dry-run zählt nur; ohne --dry-run wird crm_admission.json (Rückverfolgbarkeit) + Audit-Zeile geschrieben. Nur Zahlen im Log.
      log({ event: "admission", ...admissionSync({ dataDir: DATA, sources, write: !args.includes("--dry-run") }) });
      return 0;
    }
    if (args.includes("--phonebook-backfill")) {
      // TF-078: npm run phonebook:backfill [-- --dry-run]. Nur Zähler im Log (keine Nummern, Namen, Adressen, kein Schlüssel).
      const r = await phonebookBackfill({ dataDir: DATA, sources, dryRun: args.includes("--dry-run"), allowUnconfirmed: args.includes("--allow-unconfirmed") });
      log({ event: "phonebook_backfill", ...r });
      return r.ok ? 0 : 2;
    }
    if (args.includes("--phonebook-diagnose")) {
      // TF-078: npm run phonebook:diagnose [-- --number 0XXXXXXXXX]. Ohne --number: erste aktive CH-Nummer (nie ausgegeben).
      const i = args.indexOf("--number");
      const r = await phonebookDiagnose({ dataDir: DATA, sources, number: i >= 0 ? args[i + 1] : null });
      log({ event: "phonebook_diagnose", ...r });
      return r.ok ? 0 : 2;
    }
    if (args.includes("--history-migrate")) {
      // TF-058: idempotent. --dry-run schreibt nichts. --import: lokal aus den verschlüsselten Backups extrahierte Minimaldaten (danach gelöscht).
      const { migrateHistory } = await import("./discovery-history.js");
      const i = args.indexOf("--import"), file = i >= 0 ? args[i + 1] : null;
      let importData = null;
      if (file) { if (!path.resolve(file).startsWith(path.resolve(DATA) + path.sep)) throw new Error("--import nur aus dem CRM-Datenverzeichnis."); importData = JSON.parse(fs.readFileSync(file, "utf8")); }
      const dry = args.includes("--dry-run");
      const r = await migrateHistory({ dataDir: DATA, mailDir: MAIL, sources, importData, dryRun: dry });
      if (file && !dry) fs.rmSync(file, { force: true });
      log({ event: "history_migrate", ...r });
      return 0;
    }
    const token = process.env.JARVIS_CRM_AGENT_TOKEN || "";
    const agent = createCrmAgent({ dataDir: DATA, sources, url: process.env.JARVIS_CRM_URL || "https://chrisjarvis.netlify.app", token, log });
    if (args.includes("--backup-now")) {
      const k = pem(); if (!k) { log({ event: "backup_failed", error: "Public Key fehlt" }); return 1; }
      const r = await crmBackup({ dataDir: DATA, publicKeyPem: k, force: true, zurichDay, upload: agent?.uploadBackup || null });
      log({ event: "backup", ...r.status }); return r.status.local ? 0 : 1;
    }
    if (args.includes("--service")) {
      if (!agent) { log({ event: "not_configured", note: "JARVIS_CRM_AGENT_TOKEN fehlt – Dienst wartet." }); }
      let stop = false;
      for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stop = true; });
      log({ event: "service_start", configured: !!agent, backfill: process.env.JARVIS_CRM_BACKFILL !== "off", history: process.env.JARVIS_CRM_HISTORY !== "off" });
      // Genau EINE Website gleichzeitig über Backfill (TF-055) und Recheck (TF-058) hinweg.
      let tail = Promise.resolve();
      const slot = (fn) => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
      // TF-055: passiver Hintergrund-Audit – eigene Schleife, blockiert Abholen/Backup/Herzschlag nie.
      if (process.env.JARVIS_CRM_BACKFILL !== "off") {
        const { createBackfill } = await import("./site-backfill.js");
        const bf = createBackfill({ dataDir: DATA, sources: () => ({ ...sources(), crm: loadCrm(DATA) }), universe: (s) => crmUniverse(s, new Date()), slot, log });
        bf.run(() => stop).catch((e) => log({ event: "backfill_stopped", error: String(e?.message || e).slice(0, 120) }));
      }
      // TF-058: historische Website-Fehler-Leads (discovered.json beobachten + passiver Recheck der Index-Domains) – eigener Takt, gleicher Slot.
      if (process.env.JARVIS_CRM_HISTORY !== "off") {
        const { createHistoryWorker, RECHECK_AUDIT_OPTIONS } = await import("./discovery-history.js");
        const { createAuditor } = await import("./site-auditor.js");
        const hw = createHistoryWorker({ dataDir: DATA, mailDir: MAIL, sources, auditor: createAuditor(RECHECK_AUDIT_OPTIONS), slot, log });
        hw.run(() => stop).catch((e) => log({ event: "history_stopped", error: String(e?.message || e).slice(0, 120) }));
      }
      let admissionAt = 0;
      while (!stop) {
        // TF-076: Aufnahme-Stand stündlich festhalten (Recheck ohne Fehler → NO_VERIFIED_ERRORS seit …; nur Zahlen im Log).
        if (Date.now() - admissionAt > 60 * 60_000) {
          admissionAt = Date.now();
          try { const a = admissionSync({ dataDir: DATA, sources }); log({ event: "admission", active: a.active, excluded: a.excluded, newly_excluded: a.newly_excluded, readmitted: a.readmitted }); }
          catch (e) { log({ event: "admission_failed", error: String(e?.message || e).slice(0, 120) }); }
        }
        let r = { hot: false, status: 0 };
        try { if (agent) r = await agent.pollOnce(); } catch (e) { log({ event: "iteration_failed", error: String(e?.message || e).slice(0, 160) }); }
        try {
          const k = pem();
          if (k) { const b = await crmBackup({ dataDir: DATA, publicKeyPem: k, zurichDay, upload: agent?.uploadBackup || null }); if (!b.skipped) log({ event: "backup", files: b.status.files, generations: b.status.generations, offsite_ok: b.status.offsite_ok }); }
        } catch (e) { log({ event: "backup_failed", error: String(e?.message || e).slice(0, 160) }); }
        try { writeAtomic(path.join(DATA, HEALTH_FILE), JSON.stringify({ beat: Date.now(), status: r.status, ...(agent?.viewTooLarge() ? { view: "TOO_LARGE_STALE" } : {}) })); } catch {}
        const wait = agent ? nextDelayMs(r) : 60_000;
        for (let t = 0; t < wait && !stop; t += 500) await new Promise((res) => setTimeout(res, 500));
      }
      return 0;
    }
    console.log("Befehle: --service | --healthcheck | --report | --backup-now | --phonebook-backfill [--dry-run] | --phonebook-diagnose [--number N]");
    return 1;
  };
  main().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
