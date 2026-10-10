// Jarvis Server Control – VPS-Agent (läuft im Cloud-Core-Prozess, nur ausgehend, kein offener Port).
// Holt Aufträge von /api/server-control, führt NUR die fest definierten Aktionen aus server-control.js aus und meldet Ergebnis + Status.
// Kein exec/spawn, keine Shell, kein Docker-Socket, keine Pfade vom Client. Dateizugriff nur über safePath() auf Jarvis-Dateien.
// Im Container ist /opt/fiverr gar nicht eingebunden; safePath sperrt es (und SSH-/Secret-Dateien) trotzdem ausdrücklich.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTIONS, MAX_LOG_LINES, validateAction, redact, cleanResult } from "./server-control.js";
import { leadsFingerprint } from "./cloud-leads.js";
import { dbFingerprint } from "./lead-db.js";

// Lead-Datenbank in die Cloud: eigene Operation (grösser als der Status-Pull), nur bei Änderung bzw. spätestens alle 30 min.
export const LEADDB_MAX_BYTES = 4_500_000;
export const LEADDB_RESEND_MS = 30 * 60_000;

// ---------- Pfad-Schutz ----------
export const BLOCKED_PATH_RE = /(^|[\\/])(fiverr|\.ssh|ssh_host_[^\\/]*|shadow|gshadow|sudoers|passwd)([\\/]|$)|\/root([\\/]|$)|\.env$|\.pem$|id_(rsa|ecdsa|ed25519)|gmail_token|gmail_credentials|gmail_jarvis|jarvis_sync|vps_worker|server_control/i;
// Nur Dateien unterhalb der erlaubten Jarvis-Wurzeln, nach Auflösung von ".." und Symlinks; gesperrte Muster gewinnen immer.
export function safePath(p, roots) {
  if (typeof p !== "string" || !p || p.includes("\0")) throw Object.assign(new Error("Pfad ungültig."), { code: "PATH_DENIED" });
  const abs = path.resolve(p);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch {}
  for (const x of [abs, real]) if (BLOCKED_PATH_RE.test(x.replace(/\\/g, "/"))) throw Object.assign(new Error("Pfad gesperrt."), { code: "PATH_DENIED" });
  const inside = (x) => roots.some((r) => { const root = path.resolve(r); return x === root || x.startsWith(root + path.sep); });
  if (!inside(abs) || !inside(real)) throw Object.assign(new Error("Pfad ausserhalb von Jarvis."), { code: "PATH_DENIED" });
  return real;
}

// ---------- Logs: nur Jarvis-Ereignisse, begrenzt, bereinigt ----------
export function logSource(event = "") {
  const e = String(event);
  if (/backup/.test(e)) return "backup";
  if (/^(worker_started|state_migrated|state_schema_refused|deploy)/.test(e)) return "deploy";
  if (/window|schedul|discovery|sales|metrics|lead/.test(e)) return "scheduler";
  if (/mail|send|gmail|reply|draft|cloud_requests|heartbeat|escalat|opt_?out|suppress|ai_|budget|bounce|inbox/.test(e)) return "mail";
  return "core";
}
const SAFE_STR_FIELDS = ["error", "reason", "holder", "role", "status", "kind", "local", "code"];
export function cleanLogLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const out = { ts: typeof o.ts === "string" ? o.ts.slice(0, 30) : null, level: ["info", "warn", "error"].includes(o.level) ? o.level : "info", event: redact(String(o.event || "").slice(0, 60), 60) };
  for (const [k, v] of Object.entries(o)) {
    if (["ts", "level", "event"].includes(k) || !/^[a-zA-Z_]{1,30}$/.test(k)) continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && SAFE_STR_FIELDS.includes(k)) out[k] = redact(v, 200);
  }
  return out;
}
export function readLogs({ dir, source, lines = 50, roots = [dir] }) {
  const n = Math.max(1, Math.min(MAX_LOG_LINES, lines | 0));
  const out = [];
  for (const f of ["worker.log", "worker.log.1"]) {
    let text = "";
    try { text = fs.readFileSync(safePath(path.join(dir, f), roots), "utf8"); } catch (e) { if (e.code === "PATH_DENIED") throw e; continue; }
    const tail = text.length > 3_000_000 ? text.slice(-3_000_000) : text;
    const matched = tail.split("\n").filter(Boolean).map(cleanLogLine).filter((l) => l && logSource(l.event) === source);
    out.unshift(...matched);
    if (out.length >= n) break;
  }
  return { source, lines: out.slice(-n) };
}

// ---------- Lokales Audit (zusätzlich zum Audit in der Cloud) ----------
export const AUDIT_FILE = "control_audit.jsonl";
export function auditLocal(dir, entry) {
  try {
    const file = path.join(dir, AUDIT_FILE);
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.renameSync(file, file + ".1");
    const e = { ts: new Date().toISOString(), request_id: entry.request_id || null, action: entry.action || null, source: entry.source || "cloud-ui", outcome: entry.outcome, reason: entry.reason ? redact(entry.reason, 160) : null };
    fs.appendFileSync(file, JSON.stringify(e) + "\n", { mode: 0o600 });
  } catch {}
}

// ---------- Status (Snapshot) ----------
const COOLDOWN_FILE = "control_state.json";
export function collectSnapshot({ dir, startedAt, core = null, mail = null, queue = null, backup = null, healthy = () => true, env = process.env, now = new Date(), lastIterationAt = null, pollMs = 120_000 }) {
  const total = os.totalmem(), avail = os.freemem(), cpus = os.cpus().length || 1, load1 = os.loadavg()[0];
  let disk = null;
  try { const s = fs.statfsSync(dir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
  const isHealthy = !!healthy();
  const iterFresh = !!lastIterationAt && +now - Date.parse(lastIterationAt) < 3 * pollMs + 60_000;
  const b = backup || null;
  return {
    at: now.toISOString(),
    system: { status: "ONLINE", uptime_s: os.uptime(), cpus, load1, cpu_pct: Math.min(100, (load1 / cpus) * 100),
      mem_total: total, mem_available: avail, mem_pct: total ? ((total - avail) / total) * 100 : null,
      disk_total: disk?.total ?? null, disk_free: disk?.free ?? null, disk_pct: disk?.total ? ((disk.total - disk.free) / disk.total) * 100 : null },
    // Dieser Prozess läuft im Jarvis-Container – meldet er sich, laufen Docker-Dienst und Container. Kein Docker-Socket nötig.
    docker: { status: "ONLINE", container: isHealthy ? "HEALTHY" : "UNHEALTHY", container_uptime_s: process.uptime(), in_container: fs.existsSync("/.dockerenv") },
    jarvis: { core: isHealthy ? "HEALTHY" : "UNHEALTHY", role: core?.role || "vps", started_at: startedAt || null, schema_version: core?.schema_version ?? null, node: process.version },
    mail: mail || { worker: "UNKNOWN", authority: "UNKNOWN", self: null, last_iteration_at: lastIterationAt },
    scheduler: { status: iterFresh ? "ONLINE" : "STALE", morning: core?.scheduler?.morning || null, afternoon: core?.scheduler?.afternoon || null, discovery_last_run: core?.discovery_last_run || null },
    queue: queue || { pending: null, processing: null },
    backup: { status: !b ? "NONE" : b.ok ? "OK" : "FAILED", last_at: b?.last_at || null, generations: b?.generations ?? 0, offsite_ok: b ? b.ok === true : null },
    deploy: { commit: env.JARVIS_COMMIT || null, deployed_at: env.JARVIS_DEPLOYED_AT || null, container_started_at: startedAt || null },
  };
}

// ---------- Aktionen (VPS) ----------
// deps: snapshot(), runBackup(), restartCore(), restartMailWorker(), restartScheduler() – vom Worker-Prozess bereitgestellt.
export function createVpsActions({ dir, roots = [dir], deps, now = () => new Date() }) {
  const snap = () => deps.snapshot();
  const health = () => {
    const s = snap();
    const checks = {
      core_healthy: s.jarvis.core === "HEALTHY",
      scheduler_online: s.scheduler.status === "ONLINE",
      mail_authority_vps: s.mail.authority === "VPS" && s.mail.self === true,
      disk_ok: s.system.disk_pct === null || s.system.disk_pct < 90,
      memory_ok: s.system.mem_pct === null || s.system.mem_pct < 95,
      backup_recent: !!s.backup.last_at && +now() - Date.parse(s.backup.last_at) < 48 * 3_600_000,
      backup_offsite_ok: s.backup.offsite_ok === true,
      schema_ok: Number.isInteger(s.jarvis.schema_version) && s.jarvis.schema_version >= 1,
    };
    return { ok: Object.values(checks).every(Boolean), checks, at: s.at };
  };
  const fileStats = () => {
    const out = {};
    for (const f of ["state.json", "registry.json", "leads.json", "discovered.json", "suppression.json", "cloud_requests.json", "worker.log", "backup_status.json", "schema.json", AUDIT_FILE]) {
      try { out[f] = fs.statSync(safePath(path.join(dir, f), roots)).size; } catch { out[f] = null; }
    }
    return out;
  };
  const read = (part) => () => snap()[part];
  return {
    "system.health": () => ({ ...snap().system, health: health().ok ? "OK" : "DEGRADED" }),
    "system.uptime": () => ({ uptime_s: snap().system.uptime_s }),
    "system.resources": read("system"),
    "docker.status": read("docker"),
    "jarvis.status": read("jarvis"),
    "mail.status": read("mail"),
    "scheduler.status": read("scheduler"),
    "queue.status": read("queue"),
    "backup.status": read("backup"),
    "deploy.status": read("deploy"),
    "service.logs": ({ source, lines = 50 }) => readLogs({ dir, source, lines, roots }),
    "jarvis.runHealthCheck": health,
    "jarvis.runSafeDiagnostics": () => {
      const errors = readLogs({ dir, source: "core", lines: MAX_LOG_LINES, roots }).lines.filter((l) => l.level === "error").length;
      return { health: health(), files: fileStats(), node: process.version, core_errors_recent: errors, pid_uptime_s: process.uptime() };
    },
    "jarvis.runBackup": () => deps.runBackup(),
    "jarvis.restartScheduler": () => deps.restartScheduler(),
    "jarvis.restartMailWorker": () => deps.restartMailWorker(),
    "jarvis.restartCore": () => deps.restartCore(),
    // Cold-Lead-Entwürfe (TF-025): genau EIN Lead je Aufruf, nur Entwurf/Verwerfen – deps.coldDraft kennt keinen Sendepfad.
    "leads.createDraft": ({ lead_id }) => (typeof deps.coldDraft === "function" ? deps.coldDraft("create", lead_id) : { ok: false, error: "NOT_IMPLEMENTED" }),
    "leads.discardDraft": ({ lead_id }) => (typeof deps.coldDraft === "function" ? deps.coldDraft("discard", lead_id) : { ok: false, error: "NOT_IMPLEMENTED" }),
    // 24/7-Discovery: Pause/Fortsetzen – nur ein Flag, keine Scheduler-Befehle, keine Daten löschen.
    "discovery.pause": () => (typeof deps.setDiscovery === "function" ? deps.setDiscovery("pause") : { ok: false, error: "NOT_IMPLEMENTED" }),
    "discovery.resume": () => (typeof deps.setDiscovery === "function" ? deps.setDiscovery("resume") : { ok: false, error: "NOT_IMPLEMENTED" }),
  };
}

// ---------- Agent: abholen → prüfen → ausführen → melden ----------
// config: { url (…/api/state oder Origin), controlToken }. Ohne eigenen Token läuft der Agent nicht (kein Fallback auf andere Tokens).
export function createControlAgent({ dir, config, actions, snapshot, leads = null, leadDb = null, fetchFn = globalThis.fetch, log = () => {}, now = () => new Date(), timeoutMs = 60_000 }) {
  if (!config?.controlToken || config.controlToken.length < 32) return null;
  const endpoint = config.url.replace(/\/api\/state$/, "").replace(/\/+$/, "") + "/api/server-control";
  // Lead-Liste (Allowlist, cloud-leads.js) nur mitschicken, wenn sie sich geändert hat oder die letzte Übertragung > 10 min zurückliegt.
  let leadsSent = { fp: null, at: 0 };
  const leadsPayload = () => {
    if (typeof leads !== "function") return {};
    try {
      const list = leads();
      if (!Array.isArray(list)) return {};
      const fp = leadsFingerprint(list);
      if (fp === leadsSent.fp && +now() - leadsSent.at < 10 * 60_000) return {};
      leadsSent = { fp, at: +now() };
      return { leads: list };
    } catch (e) { log("warn", "control_leads_failed", { error: e.message }); return {}; }
  };
  // Lead-Datenbank (Allowlist aus lead-db.js): neueste Änderungen zuerst; zu gross → älteste fallen weg (truncated), nie Rohdaten.
  let dbSent = { fp: null, at: 0 }, dbRetryAt = 0;
  const leadDbPayload = () => {
    if (typeof leadDb !== "function") return null;
    try {
      let list = leadDb();
      if (!Array.isArray(list)) return null;
      if (+now() < dbRetryAt) return null; // Cloud hat abgelehnt (z. B. noch alte Netlify-Version) → nicht jede Minute Megabytes schicken
      const fp = dbFingerprint(list), total = list.length;
      if (fp === dbSent.fp && +now() - dbSent.at < LEADDB_RESEND_MS) return null;
      let truncated = false, json = JSON.stringify(list);
      while (json.length > LEADDB_MAX_BYTES && list.length) { list = list.slice(0, Math.floor(list.length * 0.9)); truncated = true; json = JSON.stringify(list); }
      return { fp, body: { op: "leaddb", leads: list, total, truncated, generated_at: now().toISOString() } };
    } catch (e) { log("warn", "control_leaddb_failed", { error: e.message }); return null; }
  };
  const post = async (body) => {
    const r = await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-control": config.controlToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  };
  const cooldowns = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, COOLDOWN_FILE), "utf8")); } catch { return {}; } };
  const setCooldown = (action, t) => { try { const c = cooldowns(); c[action] = t.toISOString(); const f = path.join(dir, COOLDOWN_FILE); fs.writeFileSync(f + ".tmp", JSON.stringify(c), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); } catch {} };

  async function execute(rq) {
    const t = now();
    // Erneut prüfen – der VPS vertraut der Cloud nicht blind (fail closed).
    const v = validateAction({ action: rq.action, params: rq.params ?? {} });
    if (!v.ok) return { ok: false, error: v.code };
    if (!rq.created_at || +t - Date.parse(rq.created_at) > 5 * 60_000) return { ok: false, error: "STALE_REQUEST" };
    const fn = actions[v.action];
    if (typeof fn !== "function") return { ok: false, error: "NOT_IMPLEMENTED" };
    const cd = ACTIONS[v.action].cooldownMs || 0, last = cooldowns()[v.action];
    if (v.tier === "control" && cd && last && +t - Date.parse(last) < cd) return { ok: false, error: "COOLDOWN" };
    if (v.tier === "control") setCooldown(v.action, t);
    try {
      const result = await Promise.race([Promise.resolve().then(() => fn(v.params)), new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), timeoutMs).unref?.())]);
      const after = result && typeof result === "object" && typeof result.after === "function" ? result.after : null;
      const { after: _a, ...rest } = result && typeof result === "object" && !Array.isArray(result) ? result : { value: result };
      return { ok: rest.ok !== false, result: cleanResult(rest), after };
    } catch (e) { return { ok: false, error: e.code === "PATH_DENIED" ? "PATH_DENIED" : redact(e.message, 160) }; }
  }

  // Ein Durchlauf. Rückgabe { hot, handled, status }. Wirft nie.
  async function pollOnce() {
    let pulled;
    try { pulled = await post({ op: "pull", snapshot: snapshot(), ...leadsPayload() }); }
    catch (e) { log("warn", "control_pull_failed", { error: e.message }); return { hot: false, handled: 0, status: 0 }; }
    if (pulled.status !== 200) { if (pulled.status !== 503) log("warn", "control_pull_refused", { status: pulled.status }); return { hot: false, handled: 0, status: pulled.status }; }
    let handled = 0;
    for (const rq of Array.isArray(pulled.body.requests) ? pulled.body.requests.slice(0, 5) : []) {
      const res = await execute(rq);
      let reported = false;
      try { reported = (await post({ op: "result", request_id: rq.request_id, ok: res.ok, result: res.result ?? null, error: res.error || null })).status === 200; }
      catch (e) { log("warn", "control_result_failed", { error: e.message }); }
      auditLocal(dir, { request_id: rq.request_id, action: rq.action, source: "cloud-ui", outcome: res.ok ? "success" : "failure", reason: res.error || null });
      log(res.ok ? "info" : "warn", "control_action", { action: String(rq.action).slice(0, 40), ok: res.ok, reason: res.error || null });
      handled++;
      // Neustart erst NACH bestätigter Rückmeldung – sonst kein Neustart (fail closed, keine Schleife).
      if (res.after && res.ok && reported) { try { await res.after(); } catch (e) { log("error", "control_after_failed", { error: e.message }); } }
    }
    const db = leadDbPayload();
    if (db) {
      try {
        const r = await post(db.body);
        if (r.status === 200) { dbSent = { fp: db.fp, at: +now() }; dbRetryAt = 0; }
        else { dbRetryAt = +now() + 10 * 60_000; log("warn", "control_leaddb_refused", { status: r.status }); }
      } catch (e) { dbRetryAt = +now() + 10 * 60_000; log("warn", "control_leaddb_failed", { error: e.message }); }
    }
    return { hot: !!pulled.body.hot, handled, status: 200 };
  }
  return { pollOnce, execute, endpoint };
}

// Abfrage-Takt: Panel offen / Auftrag aktiv → 5 s; sonst 60 s; nicht konfiguriert (503) oder abgelehnt → 5 min.
export const nextDelayMs = ({ hot, status }) => (status === 200 ? (hot ? 5_000 : 60_000) : 5 * 60_000);

// ---------- Einbindung in den Cloud-Core-Prozess (mail-worker.js, nur VPS) ----------
// Eigene, weckbare Schleife – unabhängig vom Mail-Takt. Fehler stoppen weder Agent noch Worker.
export function startServerControl(o) {
  const controlToken = process.env.JARVIS_SERVER_CONTROL_TOKEN || "";
  const config = { url: o.syncConfig().url, controlToken };
  const snapshot = () => {
    const it = o.lastIteration();
    const mail = it ? { worker: it.standby ? "STANDBY" : it.holder === "vps" && it.self ? "VPS ACTIVE" : "UNKNOWN", authority: it.holder === "vps" ? "VPS" : it.holder === "local" ? "WINDOWS" : "UNKNOWN", self: it.self, last_iteration_at: it.at } : null;
    let core = null, queue = null, backup = null, discovery = null;
    try { core = o.core(); } catch {}
    try { queue = o.queue(); } catch {}
    try { discovery = typeof o.discovery === "function" ? o.discovery() : null; } catch {}
    backup = core?.backup || null;
    return { ...collectSnapshot({ dir: o.dir, startedAt: o.startedAt, core, mail, queue, backup, healthy: o.healthy, lastIterationAt: it?.at || null, pollMs: o.pollMs() }), discovery };
  };
  const deps = {
    snapshot,
    runBackup: async () => {
      const pem = o.backupPublicKey();
      if (!pem) return { ok: false, error: "Kein Backup-Public-Key." };
      const [{ backupNow }, { backupUploader }] = await Promise.all([import("./backup.js"), import("./backup-api.js")]);
      return backupNow({ secretsDir: o.secretsDir, workerDir: o.dir, publicKeyPem: pem, zurichDay: o.zurichDay, log: o.log, upload: backupUploader({ config: o.syncConfig() }) });
    },
    restartScheduler: () => ({ ok: true, restarted: "scheduler", after: () => o.restartScheduler() }),
    restartMailWorker: () => ({ ok: true, restarted: "mail_worker", after: () => o.restartMailWorker() }),
    restartCore: () => ({ ok: true, restarted: "core", note: "Container-Prozess startet nach dem laufenden Durchlauf neu (Docker).", after: () => o.restartCore() }),
    // Cold-Lead-Entwurf vom Handy: der Worker-Prozess legt nur den lokalen Entwurf an (queued) und wird geweckt, damit der Gmail-Entwurf
    // sofort entsteht. Senden kann dieser Pfad nicht (COLD_LEAD_DRAFT_ONLY, gmail.sendDraft verweigert).
    coldDraft: (op, leadId) => (typeof o.coldDraft === "function" ? o.coldDraft(op, leadId) : { ok: false, error: "NOT_IMPLEMENTED" }),
    setDiscovery: (op) => (typeof o.setDiscovery === "function" ? o.setDiscovery(op) : { ok: false, error: "NOT_IMPLEMENTED" }),
  };
  const agent = createControlAgent({ dir: o.dir, config, actions: createVpsActions({ dir: o.dir, deps }), snapshot, leads: o.leads || null, leadDb: o.leadDb || null, log: o.log });
  if (!agent) { o.log("info", "server_control_disabled", { reason: "JARVIS_SERVER_CONTROL_TOKEN fehlt" }); return null; }
  o.log("info", "server_control_started", {});
  const loop = async () => {
    let r = { hot: false, status: 0 };
    try { r = await agent.pollOnce(); } catch (e) { o.log("error", "server_control_failed", { error: e.message }); }
    setTimeout(loop, nextDelayMs(r)).unref?.();
  };
  setTimeout(loop, 5_000).unref?.();
  return agent;
}
