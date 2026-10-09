// Jarvis Server Control – Cloud-Seite (Netlify /api/server-control) und gemeinsame Regeln für den VPS-Agenten (server-agent.js).
//
//   Browser (x-jarvis-key = JARVIS_PASSWORD)  →  /api/server-control (Netlify Blobs "jarvis-server-control")
//   VPS-Agent (x-jarvis-control = JARVIS_SERVER_CONTROL_TOKEN, nur ausgehend) holt Aufträge ab und meldet Ergebnis + Status.
//
// Es gibt KEINE Shell, keine Befehle, keine Pfade und keine Docker-Argumente vom Client: nur feste Action-IDs aus ACTIONS,
// Parameter nur, wo sie hier als Enum/Zahl definiert sind. Alles andere → DENY (deny by default, fail closed).
// Eigenes Secret: JARVIS_SERVER_CONTROL_TOKEN (nie Worker-/Sync-Token, Anthropic-Key oder Gmail-Token wiederverwenden).
// Der Token liegt nur in Netlify (Server-Funktion) und in /opt/jarvis-mail/.env – nie im Browser, in Git, Logs oder PROJECT_STATE.
import { safeEqual } from "./shared-state.js";
import { LEAD_ID_RE, cleanLeads } from "./cloud-leads.js";

export const TIERS = ["read", "control", "dangerous"];
export const LOG_SOURCES = ["core", "mail", "scheduler", "backup", "deploy"];
export const MAX_LOG_LINES = 100;

// Einzige Quelle aller ausführbaren Aktionen. snapshot = Antwort direkt aus dem letzten Status des VPS (kein Auftrag nötig).
// cooldownMs = Mindestabstand zwischen zwei Ausführungen (zusätzlich zum Rate Limit).
export const ACTIONS = {
  "system.health":           { tier: "read", snapshot: "system", label: "System-Gesundheit" },
  "system.uptime":           { tier: "read", snapshot: "system", label: "Host-Laufzeit" },
  "system.resources":        { tier: "read", snapshot: "system", label: "CPU / RAM / Disk" },
  "docker.status":           { tier: "read", snapshot: "docker", label: "Docker" },
  "jarvis.status":           { tier: "read", snapshot: "jarvis", label: "Jarvis Core" },
  "mail.status":             { tier: "read", snapshot: "mail", label: "Mail-Worker" },
  "scheduler.status":        { tier: "read", snapshot: "scheduler", label: "Scheduler" },
  "queue.status":            { tier: "read", snapshot: "queue", label: "Warteschlange" },
  "backup.status":           { tier: "read", snapshot: "backup", label: "Backup" },
  "deploy.status":           { tier: "read", snapshot: "deploy", label: "Deploy" },
  "service.logs":            { tier: "read", label: "Logs (gekürzt, bereinigt)", params: { source: LOG_SOURCES, lines: [1, MAX_LOG_LINES] } },
  "jarvis.runHealthCheck":   { tier: "control", label: "Health Check", cooldownMs: 30_000 },
  "jarvis.runSafeDiagnostics": { tier: "control", label: "Diagnose", cooldownMs: 60_000 },
  "jarvis.runBackup":        { tier: "control", label: "Backup jetzt", cooldownMs: 30 * 60_000 },
  "jarvis.restartScheduler": { tier: "control", label: "Scheduler neu starten", cooldownMs: 2 * 60_000 },
  "jarvis.restartMailWorker": { tier: "control", label: "Mail-Worker neu starten", cooldownMs: 5 * 60_000 },
  "jarvis.restartCore":      { tier: "control", label: "Jarvis Core neu starten", cooldownMs: 10 * 60_000 },
  // Cold-Lead-Entwürfe vom Handy: nur ENTWURF in Gmail (COLD_LEAD_DRAFT_ONLY, legal_basis NONE) bzw. Verwerfen – es gibt keine Send-Aktion.
  "leads.createDraft":       { tier: "control", label: "Gmail-Entwurf erstellen (Cold Lead, nie senden)", params: { lead_id: LEAD_ID_RE } },
  "leads.discardDraft":      { tier: "control", label: "Cold-Entwurf verwerfen", params: { lead_id: LEAD_ID_RE } },
  // 24/7-Discovery vom Handy pausieren/fortsetzen: nur ein Flag auf dem VPS, keine Scheduler-Befehle, nichts wird gelöscht.
  "discovery.pause":         { tier: "control", label: "24/7-Discovery pausieren", cooldownMs: 10_000 },
  "discovery.resume":        { tier: "control", label: "24/7-Discovery fortsetzen", cooldownMs: 10_000 },
};
// DANGEROUS: bekannt, aber aus der Cloud-UI immer gesperrt (Reboot, Pakete, Firewall, SSH, Löschen, Secret-Rotation).
export const DANGEROUS = ["system.reboot", "system.shutdown", "system.upgrade", "system.packages", "firewall.change", "ssh.change",
  "state.delete", "backup.delete", "secrets.rotate", "docker.prune", "docker.exec", "shell.exec"];

const ACTION_RE = /^[a-z]+\.[A-Za-z]+$/;
// Prüft eine Anfrage. Ergebnis: { ok, action, tier, params } oder { ok:false, status, code, error }. Kein Fallback, keine Umdeutung.
export function validateAction(input) {
  const deny = (status, code, error) => ({ ok: false, status, code, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return deny(400, "BAD_REQUEST", "Ungültige Anfrage.");
  const extra = Object.keys(input).filter((k) => !["action", "params"].includes(k));
  if (extra.length) return deny(400, "UNKNOWN_FIELD", "Nur action und params sind erlaubt.");
  const { action } = input;
  if (typeof action !== "string" || action.length > 64 || !ACTION_RE.test(action)) return deny(400, "UNKNOWN_ACTION", "Unbekannte Aktion.");
  if (DANGEROUS.includes(action)) return deny(403, "DANGEROUS_BLOCKED", "Gefährliche Aktion – aus der Cloud gesperrt.");
  if (!Object.hasOwn(ACTIONS, action)) return deny(400, "UNKNOWN_ACTION", "Unbekannte Aktion.");
  const def = ACTIONS[action];
  const raw = input.params ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return deny(400, "BAD_PARAMS", "params muss ein Objekt sein.");
  const spec = def.params || {};
  const params = {};
  for (const [k, v] of Object.entries(raw)) {
    const rule = spec[k];
    if (!rule) return deny(400, "BAD_PARAMS", `Parameter ${String(k).slice(0, 20)} ist nicht erlaubt.`);
    if (rule instanceof RegExp) { if (typeof v !== "string" || v.length > 253 || !rule.test(v)) return deny(400, "BAD_PARAMS", `${k}: ungültig.`); params[k] = v; }
    else if (typeof rule[0] === "string") { if (!rule.includes(v)) return deny(400, "BAD_PARAMS", `${k}: nur ${rule.join(", ")}.`); params[k] = v; }
    else { if (!Number.isInteger(v) || v < rule[0] || v > rule[1]) return deny(400, "BAD_PARAMS", `${k}: ganze Zahl ${rule[0]}–${rule[1]}.`); params[k] = v; }
  }
  if (action === "service.logs" && !params.source) return deny(400, "BAD_PARAMS", "source fehlt.");
  if (action.startsWith("leads.") && !params.lead_id) return deny(400, "BAD_PARAMS", "lead_id fehlt (genau ein Lead, keine Sammelaktion).");
  return { ok: true, action, tier: def.tier, params };
}

// ---------- Redaction: nichts, was wie ein Secret, eine Adresse oder ein fremder Pfad aussieht, verlässt den Server ----------
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private-key]"],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, "[api-key]"],
  [/\bya29\.[A-Za-z0-9._-]+/g, "[oauth-token]"],
  [/\b1\/\/[A-Za-z0-9._-]{10,}/g, "[oauth-token]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]"],
  [/"(access_token|refresh_token|client_secret|token|password|api_key|private_key)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"'],
  [/[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/gi, "[email]"],
  [/(\/opt\/fiverr|\/root|\/home\/[^\s/]+\/\.ssh|\/etc\/(shadow|passwd|ssh))[^\s"']*/gi, "[blocked-path]"],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]"],
];
export function redact(s, max = 300) {
  let out = String(s ?? "");
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out.length > max ? out.slice(0, max) + "…" : out;
}
const SECRET_KEY_RE = /token|secret|password|passwd|credential|api_?key|private|authorization|cookie/i;
// Ergebnis eines Auftrags: nur einfache Werte, Strings bereinigt, keine verdächtigen Schlüssel, Grösse begrenzt.
export function cleanResult(v, depth = 0) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return redact(v, 400);
  if (depth > 5) return null;
  if (Array.isArray(v)) return v.slice(0, MAX_LOG_LINES).map((x) => cleanResult(x, depth + 1));
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 60)) if (!SECRET_KEY_RE.test(k) && /^[A-Za-z0-9_.-]{1,40}$/.test(k)) o[k] = cleanResult(x, depth + 1);
    return o;
  }
  return null;
}
const capResult = (v) => { const c = cleanResult(v); return JSON.stringify(c ?? null).length > 24_000 ? { truncated: true } : c; };

// Status des VPS (Snapshot) – Whitelist wie cleanCore: Zahlen, Zeitpunkte, feste Zustandswörter.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const iso = (v) => (typeof v === "string" && ISO_RE.test(v) ? v : null);
const num = (v, max = 1e15) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * 100) / 100)) : null);
const word = (v, allowed) => (allowed.includes(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
export function cleanSnapshot(s) {
  if (!s || typeof s !== "object") return null;
  const sys = s.system || {}, d = s.docker || {}, j = s.jarvis || {}, m = s.mail || {}, sc = s.scheduler || {}, q = s.queue || {}, b = s.backup || {}, dp = s.deploy || {};
  const win = (w) => (w && typeof w === "object" ? { start: /^\d{2}:\d{2}$/.test(w.start) ? w.start : null, limit: num(w.limit, 1000), executed: w.executed === true } : null);
  return {
    at: iso(s.at),
    system: { status: word(sys.status, ["ONLINE", "DEGRADED"]), uptime_s: num(sys.uptime_s), cpus: num(sys.cpus, 1024), load1: num(sys.load1, 1e4), cpu_pct: num(sys.cpu_pct, 100),
      mem_total: num(sys.mem_total), mem_available: num(sys.mem_available), mem_pct: num(sys.mem_pct, 100),
      disk_total: num(sys.disk_total), disk_free: num(sys.disk_free), disk_pct: num(sys.disk_pct, 100) },
    docker: { status: word(d.status, ["ONLINE"]), container: word(d.container, ["HEALTHY", "UNHEALTHY"]), container_uptime_s: num(d.container_uptime_s), in_container: bool(d.in_container) },
    jarvis: { core: word(j.core, ["HEALTHY", "UNHEALTHY"]), role: word(j.role, ["vps", "local"]), started_at: iso(j.started_at), schema_version: num(j.schema_version, 10_000), node: typeof j.node === "string" && /^v\d+\.\d+\.\d+$/.test(j.node) ? j.node : null },
    mail: { worker: word(m.worker, ["VPS ACTIVE", "STANDBY", "UNKNOWN"]), authority: word(m.authority, ["VPS", "WINDOWS", "NONE", "UNKNOWN"]), self: bool(m.self), last_iteration_at: iso(m.last_iteration_at) },
    scheduler: { status: word(sc.status, ["ONLINE", "STALE"]), tz: "Europe/Zurich", morning: win(sc.morning), afternoon: win(sc.afternoon), discovery_last_run: iso(sc.discovery_last_run) },
    queue: { pending: num(q.pending, 1e6), processing: num(q.processing, 1e6) },
    backup: { status: word(b.status, ["OK", "FAILED", "NONE"]), last_at: iso(b.last_at), generations: num(b.generations, 1000), offsite_ok: bool(b.offsite_ok) },
    deploy: { commit: typeof dp.commit === "string" && /^[0-9a-f]{7,40}$/.test(dp.commit) ? dp.commit : null, deployed_at: iso(dp.deployed_at), container_started_at: iso(dp.container_started_at) },
    discovery: cleanDiscovery(s.discovery),
  };
}
// 24/7-Discovery (VPS): nur Zähler, Zeitpunkte, feste Wörter; Fehlertext bereinigt und gekürzt.
export function cleanDiscovery(d) {
  if (!d || typeof d !== "object") return null;
  const n = (v, max = 1e6) => num(v, max);
  const lim = d.limits || {};
  return {
    status: word(d.status, ["ACTIVE", "PAUSED", "BACKOFF", "DISABLED"]), paused: bool(d.paused), paused_at: iso(d.paused_at),
    audited_today: n(d.audited_today), new_leads_today: n(d.new_leads_today), qualified_today: n(d.qualified_today), drafts_today: n(d.drafts_today), drafts_hour: n(d.drafts_hour),
    blocked_today: n(d.blocked_today), errors_today: n(d.errors_today), audited_hour: n(d.audited_hour), queue: n(d.queue),
    // 1500/Tag-Discovery + unbegrenzte Draft-Queue: Websites gegen Tagesdeckel, qualifizierte Leads, wartend, heute erstellt, offen gesamt.
    websites_limit: n(d.websites_limit, 100_000), qualified_total: n(d.qualified_total), waiting_for_draft: n(d.waiting_for_draft), gmail_drafts_today: n(d.gmail_drafts_today), open_drafts_total: n(d.open_drafts_total),
    draft_worker: d.draft_worker && typeof d.draft_worker === "object" ? { status: word(d.draft_worker.status, ["ACTIVE", "BACKOFF"]), backoff_until: iso(d.draft_worker.backoff_until), backoff_count: n(d.draft_worker.backoff_count, 1000),
      last_draft_at: iso(d.draft_worker.last_draft_at), last_error: d.draft_worker.last_error && typeof d.draft_worker.last_error === "object" ? { at: iso(d.draft_worker.last_error.at), message: redact(String(d.draft_worker.last_error.message || ""), 160) } : null } : null,
    last_run_at: iso(d.last_run_at), next_run_at: iso(d.next_run_at), backoff_until: iso(d.backoff_until), backoff_count: n(d.backoff_count, 1000),
    last_error: d.last_error && typeof d.last_error === "object" ? { at: iso(d.last_error.at), stage: word(d.last_error.stage, ["search", "audit", "draft"]), message: redact(String(d.last_error.message || ""), 160) } : null,
    // max_drafts_per_*: null = kein Business-Cap (nur technisches Pacing).
    limits: { interval_minutes: n(lim.interval_minutes, 1440), sites_per_run: n(lim.sites_per_run, 1000), max_sites_per_hour: n(lim.max_sites_per_hour, 10_000), max_sites_per_day: n(lim.max_sites_per_day, 100_000),
      max_drafts_per_hour: null, max_drafts_per_day: null, draft_pace_ms: n(lim.draft_pace_ms, 600_000), drafts_per_pass: n(lim.drafts_per_pass, 10_000) },
  };
}

// ---------- Netlify-Seite: Auftrags-Warteschlange, Status, Audit ----------
export const REQUEST_TTL_MS = 3 * 60_000;    // nicht abgeholt → expired (kein später Überraschungs-Restart)
export const LEASE_MS = 2 * 60_000;           // abgeholt, aber kein Ergebnis → failed
export const WATCH_MS = 90_000;               // UI-Panel offen → Agent fragt häufiger nach
export const SNAPSHOT_STALE_MS = 3 * 60_000;  // älterer Status → SERVER OFFLINE
export const RATE = { windowMs: 10 * 60_000, total: 40, control: 6 };
const AUDIT_KEEP = 300, REQUEST_KEEP = 50;
const ID_RE = /^[0-9a-f-]{36}$/;

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const auditEntry = (now, x) => ({ ts: now.toISOString(), request_id: x.request_id || null, action: typeof x.action === "string" && ACTION_RE.test(x.action) ? x.action : "invalid",
  tier: x.tier || null, source: x.source || "cloud-ui", outcome: x.outcome, reason: x.reason ? redact(x.reason, 160) : null });
export const publicRequest = (r) => ({ request_id: r.request_id, action: r.action, tier: r.tier, params: r.params, status: r.status, created_at: r.created_at,
  finished_at: r.finished_at || null, result: r.result ?? null, error: r.error || null });

function expire(requests, now) {
  const t = +now, out = [];
  for (const r of requests) {
    if (r.status === "pending" && t > Date.parse(r.expires_at)) out.push({ ...r, status: "expired", finished_at: now.toISOString(), error: "VPS hat den Auftrag nicht abgeholt." });
    else if (r.status === "running" && t > Date.parse(r.lease_until)) out.push({ ...r, status: "failed", finished_at: now.toISOString(), error: "Kein Ergebnis vom VPS (Lease abgelaufen)." });
    else out.push(r);
  }
  return out;
}

export function createServerControlHandler({ getStore, env, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  async function mutate(fn) {
    const store = await getStore();
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const t = now();
      const cur = { requests: [], audit: [], rate: [], snapshot: null, snapshot_at: null, watch_at: null, leads: null, leads_at: null, ...(state || {}) };
      const before = cur.requests.filter((r) => ["pending", "running"].includes(r.status)).map((r) => r.request_id);
      cur.requests = expire(cur.requests, t);
      // Abgelaufene Aufträge ebenfalls ins Audit.
      let expired = 0;
      for (const r of cur.requests) if (before.includes(r.request_id) && ["expired", "failed"].includes(r.status)) { expired++; cur.audit.push(auditEntry(t, { ...r, source: "cloud-core", outcome: r.status, reason: r.error })); }
      const res = fn(cur, t);
      cur.requests = cur.requests.slice(-REQUEST_KEEP);
      cur.audit = cur.audit.slice(-AUDIT_KEEP);
      cur.rate = cur.rate.filter((x) => +t - Date.parse(x.at) < RATE.windowMs);
      if (res.readOnly && !expired) return res;
      if (await store.set(cur, etag)) return res;
    }
    return { status: 409, body: { error: "Gleichzeitige Änderung – bitte erneut versuchen." } };
  }
  const view = (cur, t, { leads = false } = {}) => ({
    configured: true,
    snapshot: cur.snapshot, snapshot_at: cur.snapshot_at, online: !!cur.snapshot_at && +t - Date.parse(cur.snapshot_at) < SNAPSHOT_STALE_MS,
    requests: cur.requests.slice(-15).map(publicRequest),
    audit: cur.audit.slice(-30),
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([id, a]) => [id, { tier: a.tier, label: a.label }])),
    // Lead-Liste (nur auf Anfrage ?leads=1): bereits beim Empfang auf die Allowlist gebracht (cleanLeads), hier nur ausgeliefert.
    ...(leads ? { leads: cur.leads || [], leads_at: cur.leads_at || null } : {}),
  });

  return async (req) => {
    // Einfügefehler (Leerzeichen/Zeilenumbruch am Rand) in der Netlify-Variable tolerieren – der Vergleich selbst bleibt exakt.
    const controlToken = String(env("JARVIS_SERVER_CONTROL_TOKEN") || "").trim(), password = env("JARVIS_PASSWORD");
    // Diagnose ohne Auth: nur ob konfiguriert und wie lang – nie der Wert, kein Fingerabdruck.
    if (req.method === "GET" && new URL(req.url).searchParams.has("probe")) return reply(200, { configured: controlToken.length >= 32, length: controlToken.length });
    // Getrennte Credentials: Worker-/Sync-Token gelten hier nicht. Fehlt der eigene Token in Netlify → alles gesperrt.
    const isAgent = !!controlToken && controlToken.length >= 32 && safeEqual(req.headers.get("x-jarvis-control"), controlToken);
    const isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    if (!isAgent && !isUser) return reply(401, { error: "Nicht berechtigt." });
    if (!controlToken || controlToken.length < 32) return reply(503, { configured: false, error: "Server Control nicht konfiguriert (JARVIS_SERVER_CONTROL_TOKEN fehlt in Netlify)." });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    if (Number(req.headers.get("content-length") || 0) > 64_000) return reply(413, { error: "Zu gross." });
    let body = {};
    if (req.method === "POST") { try { body = JSON.parse((await req.text()) || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); } }

    // ----- VPS-Agent -----
    if (isAgent && !isUser) {
      if (req.method !== "POST") return reply(405, { error: "Agent: nur POST." });
      if (body.op === "pull") {
        const r = await mutate((cur, t) => {
          if (body.snapshot) { cur.snapshot = cleanSnapshot(body.snapshot); cur.snapshot_at = t.toISOString(); }
          // Lead-Liste vom VPS (nur bei Änderung mitgeschickt): Allowlist erzwingen, nie Rohdaten speichern.
          if (Array.isArray(body.leads)) { cur.leads = cleanLeads(body.leads); cur.leads_at = t.toISOString(); }
          const due = cur.requests.filter((x) => x.status === "pending");
          for (const x of due) { x.status = "running"; x.claimed_at = t.toISOString(); x.lease_until = new Date(+t + LEASE_MS).toISOString(); }
          const hot = due.length > 0 || (!!cur.watch_at && +t - Date.parse(cur.watch_at) < WATCH_MS) || cur.requests.some((x) => x.status === "running");
          return { status: 200, body: { requests: due.map((x) => ({ request_id: x.request_id, action: x.action, params: x.params, created_at: x.created_at })), hot } };
        });
        return reply(r.status, r.body);
      }
      if (body.op === "result") {
        if (typeof body.request_id !== "string" || !ID_RE.test(body.request_id)) return reply(400, { error: "request_id ungültig." });
        const r = await mutate((cur, t) => {
          const x = cur.requests.find((q) => q.request_id === body.request_id);
          if (!x) return { status: 404, body: { error: "Unbekannter Auftrag." } };
          if (x.status !== "running") return { status: 409, body: { error: `Auftrag ist ${x.status}.` } };
          x.status = body.ok === true ? "done" : "failed";
          x.finished_at = t.toISOString();
          x.result = capResult(body.result ?? null);
          x.error = body.ok === true ? null : redact(body.error || "Fehlgeschlagen", 200);
          cur.audit.push(auditEntry(t, { ...x, source: "cloud-core", outcome: body.ok === true ? "success" : "failure", reason: x.error }));
          return { status: 200, body: { ok: true } };
        });
        return reply(r.status, r.body);
      }
      return reply(400, { error: "Unbekannte Operation." });
    }

    // ----- Chris im Browser -----
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams, watch = q.get("watch") === "1", leads = q.get("leads") === "1";
      const r = await mutate((cur, t) => { if (watch) cur.watch_at = t.toISOString(); return { status: 200, body: view(cur, t, { leads }), readOnly: !watch }; });
      return reply(r.status, r.body);
    }
    const v = validateAction(body);
    const r = await mutate((cur, t) => {
      const rid = newId();
      const recent = cur.rate.filter((x) => +t - Date.parse(x.at) < RATE.windowMs);
      if (!v.ok) {
        cur.audit.push(auditEntry(t, { request_id: rid, action: body?.action, tier: DANGEROUS.includes(body?.action) ? "dangerous" : null, outcome: "denied", reason: v.code }));
        return { status: v.status, body: { error: v.error, code: v.code, request_id: rid } };
      }
      if (recent.length >= RATE.total || (v.tier === "control" && recent.filter((x) => x.tier === "control").length >= RATE.control)) {
        cur.audit.push(auditEntry(t, { request_id: rid, ...v, outcome: "denied", reason: "RATE_LIMIT" }));
        return { status: 429, body: { error: "Zu viele Aktionen – bitte kurz warten.", code: "RATE_LIMIT", request_id: rid } };
      }
      const cd = ACTIONS[v.action].cooldownMs || 0;
      const last = [...cur.requests].reverse().find((x) => x.action === v.action && ["pending", "running", "done"].includes(x.status));
      if (cd && last && +t - Date.parse(last.created_at) < cd) {
        cur.audit.push(auditEntry(t, { request_id: rid, ...v, outcome: "denied", reason: "COOLDOWN" }));
        return { status: 429, body: { error: `${ACTIONS[v.action].label}: Abkühlzeit läuft noch.`, code: "COOLDOWN", request_id: rid } };
      }
      cur.rate.push({ at: t.toISOString(), tier: v.tier });
      const def = ACTIONS[v.action];
      // READ aus dem letzten VPS-Status: sofort, ohne Auftrag. Ist der Status veraltet → kein Raten, sondern 503.
      if (def.snapshot) {
        const fresh = !!cur.snapshot_at && +t - Date.parse(cur.snapshot_at) < SNAPSHOT_STALE_MS;
        // Auch READ wird auditiert (ohne Inhalt – nur Aktion, Ergebnis, request_id).
        cur.audit.push(auditEntry(t, { request_id: rid, ...v, outcome: fresh ? "success" : "failure", reason: fresh ? null : "SERVER_OFFLINE" }));
        if (!fresh) return { status: 503, body: { error: "VPS meldet sich nicht – Status unbekannt.", code: "SERVER_OFFLINE", request_id: rid } };
        return { status: 200, body: { request_id: rid, action: v.action, tier: v.tier, status: "done", snapshot_at: cur.snapshot_at, result: cur.snapshot?.[def.snapshot] ?? null } };
      }
      const x = { request_id: rid, action: v.action, tier: v.tier, params: v.params, source: "cloud-ui", status: "pending", created_at: t.toISOString(), expires_at: new Date(+t + REQUEST_TTL_MS).toISOString() };
      cur.requests.push(x);
      cur.watch_at = t.toISOString();
      cur.audit.push(auditEntry(t, { ...x, outcome: "queued" }));
      return { status: 202, body: { request: publicRequest(x) } };
    });
    return reply(r.status, r.body);
  };
}
