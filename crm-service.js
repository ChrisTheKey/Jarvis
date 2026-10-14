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
//
//   node crm-service.js --service | --healthcheck | --report | --backup-now
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CRM_FILE, CRM_AUDIT_FILE, normalizeCrmState, emptyCrmState, buildCrmView, buildCrmLead, crmUniverse, applyCrmAction, cleanCrmLead, CRM_ACTIONS } from "./lead-crm.js";
import { crmStats } from "./public/crm-model.js";
import { crmAgentToken } from "./crm-api.js";
import { SITE_FINDINGS_FILE, REPAIR_FINDINGS_FILE } from "./site-findings.js";

export const LOCK_FILE = "crm.lock";
export const HEALTH_FILE = "crm_health.json";
export const BACKUP_STATUS = "crm_backup_status.json";
export const BACKUP_DIR = "crm_backups";
export const BACKUP_FILES = Object.freeze([CRM_FILE, CRM_AUDIT_FILE, "lead_contact_directory.json"]);
export const VIEW_RESEND_MS = 30 * 60_000;
export const STALE_REQUEST_MS = 5 * 60_000;

// ---------- Lock: genau ein Schreiber für lead_crm.json (Dienst, CLI, Tests – auch über Prozess-/Containergrenzen) ----------
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withCrmLock(dir, fn, { timeoutMs = 15_000, staleMs = 30_000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE), token = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
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
export function createSourceReader({ dataDir, mailDir, repairDir = null }) {
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
    const leads = v.leads.map(cleanCrmLead).filter(Boolean);
    const fp = crypto.createHash("sha256").update(JSON.stringify(leads.map(({ follow_up, ...l }) => l))).digest("hex").slice(0, 24);
    return { fp, body: { leads, total: leads.length, generated_at: v.generated_at, stats: crmStats(leads, t), backup: backupSummary(dataDir) } };
  };
  async function pollOnce() {
    let v = null, payload = {};
    try {
      v = view();
      if (v.fp !== sent.fp || +now() - sent.at > VIEW_RESEND_MS) payload = { view: v.body };
    } catch (e) { log({ event: "view_failed", error: String(e.message).slice(0, 160) }); }
    let pulled;
    try { pulled = await post({ op: "pull", ...payload }); }
    catch (e) { log({ event: "pull_failed", error: String(e.message).slice(0, 120) }); return { hot: false, handled: 0, status: 0 }; }
    if (pulled.status !== 200) { log({ event: "pull_refused", status: pulled.status }); return { hot: false, handled: 0, status: pulled.status }; }
    if (payload.view) sent = { fp: v.fp, at: +now() };
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
    return { hot: !!pulled.body.hot || handled > 0, handled, status: 200 };
  }
  const uploadBackup = async (env) => {
    const r = await post({ op: "backup", backup: env });
    return r.status === 200 ? { ok: true, key: r.body.key } : { ok: false, error: `HTTP ${r.status}` };
  };
  return { pollOnce, uploadBackup, endpoint };
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
      log({ event: "report", leads: v.total, duplicates: ids.length - new Set(ids).size, domain_duplicates: doms.length - new Set(doms).size, crm_entries: crmEntries, ...st,
        with_findings_total: v.leads.filter((l) => l.findings_total > 0).length, audits, backup: backupSummary(DATA) });
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
      log({ event: "service_start", configured: !!agent, backfill: process.env.JARVIS_CRM_BACKFILL !== "off" });
      // TF-055: passiver Hintergrund-Audit – eigene Schleife, blockiert Abholen/Backup/Herzschlag nie.
      if (process.env.JARVIS_CRM_BACKFILL !== "off") {
        const { createBackfill } = await import("./site-backfill.js");
        const bf = createBackfill({ dataDir: DATA, sources: () => ({ ...sources(), crm: loadCrm(DATA) }), universe: crmUniverse, log });
        bf.run(() => stop).catch((e) => log({ event: "backfill_stopped", error: String(e?.message || e).slice(0, 120) }));
      }
      while (!stop) {
        let r = { hot: false, status: 0 };
        try { if (agent) r = await agent.pollOnce(); } catch (e) { log({ event: "iteration_failed", error: String(e?.message || e).slice(0, 160) }); }
        try {
          const k = pem();
          if (k) { const b = await crmBackup({ dataDir: DATA, publicKeyPem: k, zurichDay, upload: agent?.uploadBackup || null }); if (!b.skipped) log({ event: "backup", files: b.status.files, generations: b.status.generations, offsite_ok: b.status.offsite_ok }); }
        } catch (e) { log({ event: "backup_failed", error: String(e?.message || e).slice(0, 160) }); }
        try { writeAtomic(path.join(DATA, HEALTH_FILE), JSON.stringify({ beat: Date.now(), status: r.status })); } catch {}
        const wait = agent ? nextDelayMs(r) : 60_000;
        for (let t = 0; t < wait && !stop; t += 500) await new Promise((res) => setTimeout(res, 500));
      }
      return 0;
    }
    console.log("Befehle: --service | --healthcheck | --report | --backup-now");
    return 1;
  };
  main().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
