// Jarvis Calling Service (TF-065) – Orchestrator im Container jarvis-calling (/opt/jarvis-calling). Getrennt von Mail, Repair, CRM, Kontakten
// und VN-Discovery. Spricht nur ausgehend mit /api/calling (eigener Schlüssel x-jarvis-calling) und mit LiveKit (Server-API + Agent-Worker).
//
// Ablauf je Anruf (ein eigener Room je Kunde, nie geteilt):
//   1. Room jc-<call_id> anlegen   2. Agent jarvis-caller explizit dispatchen (Metadaten: call_id + Einmal-Token, KEINE Lead-/Telefondaten)
//   3. warten bis der Agent bereit ist (AMD lauscht)   4. SIP-Teilnehmer über den gespeicherten Outbound-Trunk des Markts (CH/VN) – nie neuer Trunk
//   5. Status beobachten (dialing/ringing/active/hangup)   6. Gespräch   7. strukturiertes Ergebnis an /api/calling   8. Room löschen.
// Ohne LIVEKIT_URL/API_KEY/API_SECRET: Zustand NOT_CONFIGURED, kein Wählen. CALLING_DRY_RUN=true (Standard): nie SIP, simulierte Ergebnisse.
// Logs: nie Secrets, Telefonnummern nur maskiert (+41*******12). Keine Aufnahme (kein Egress), keine Audiodateien.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configStatus, resolveModels, publicModels, mapSipError, mapSipCallStatus, maskPhone, CALL_AGENT_NAME, MAX_CALL_SECONDS, HARD_MAX_CONCURRENCY, SCHEMA } from "../calling-core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HEALTH_MAX_AGE_MS = 120_000;
const log = (event, data = {}) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`);

// ---------- atomarer, versionierter Zustand ----------
export function loadState(dir) {
  try { const s = JSON.parse(fs.readFileSync(path.join(dir, "calling_state.json"), "utf8")); if (s?.schema === SCHEMA && s.active && typeof s.active === "object") return s; } catch {}
  return { schema: SCHEMA, active: {} };
}
export function saveState(dir, s) {
  const f = path.join(dir, "calling_state.json"), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, f);
}
export function writeHealth(dir, h) {
  const f = path.join(dir, "calling_health.json"), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 }); fs.renameSync(tmp, f);
}

// ---------- Dry-Run-Dialer: nie SIP, simulierte Ergebnisse (deterministisch je Lead + Versuch) ----------
const SIM = ["COMPLETED", "NO_ANSWER", "INTERESTED", "BUSY", "CALLBACK_REQUESTED", "VOICEMAIL", "NOT_INTERESTED"];
export function dryRunDialer({ delayMs = 1500 } = {}) {
  return {
    kind: "dry_run",
    async run(job, { report, signal }) {
      const h = crypto.createHash("sha256").update(`${job.lead_id}:${job.attempt}`).digest()[0];
      const outcome = SIM[h % SIM.length];
      await report({ status: "DIALING" });
      await sleep(delayMs, signal);
      if (signal.aborted) return { status: "CANCELLED", summary: "Simulation abgebrochen." };
      if (["NO_ANSWER", "BUSY", "VOICEMAIL"].includes(outcome)) return { status: outcome, summary: "Simulation (Dry Run)." };
      await report({ status: "ANSWERED" });
      await sleep(delayMs, signal);
      return { status: signal.aborted ? "CANCELLED" : outcome, duration_s: Math.round(delayMs / 1000), summary: "Simulation (Dry Run) – kein echter Anruf.",
        ...(outcome === "CALLBACK_REQUESTED" ? { callback_at: new Date(Date.now() + 86_400_000).toISOString() } : {}) };
    },
  };
}
const sleep = (ms, signal) => new Promise((res) => { const t = setTimeout(res, ms); signal?.addEventListener?.("abort", () => { clearTimeout(t); res(); }, { once: true }); });

// ---------- LiveKit-Dialer (echte Anrufe – nur mit Credentials, verifiziertem Trunk und CALLING_DRY_RUN=false) ----------
export async function livekitDialer({ env, local }) {
  const { RoomServiceClient, AgentDispatchClient, SipClient } = await import("livekit-server-sdk");
  const url = env("LIVEKIT_URL"), key = env("LIVEKIT_API_KEY"), secret = env("LIVEKIT_API_SECRET");
  const rooms = new RoomServiceClient(url, key, secret), dispatch = new AgentDispatchClient(url, key, secret), sip = new SipClient(url, key, secret);
  const del = (room) => rooms.deleteRoom(room).catch(() => {});
  return {
    kind: "livekit", rooms, sip, del,
    async run(job, { report, signal }) {
      const mk = job.market === "VN" ? "VN" : "CH";
      const trunk = env(`LIVEKIT_SIP_TRUNK_${mk}`), callerId = env(`LIVEKIT_CALLER_ID_${mk}`) || undefined;
      const room = `jc-${job.call_id}`;
      const ticket = local.open(job);
      try {
        await rooms.createRoom({ name: room, emptyTimeout: 60, departureTimeout: 10, maxParticipants: 4 });
        await dispatch.createDispatch(room, CALL_AGENT_NAME, { metadata: JSON.stringify({ call_id: job.call_id, token: ticket.token, port: local.port }) });
        const ready = await ticket.waitReady(45_000, signal);
        if (!ready) return { status: "FAILED", retry: !signal.aborted, reason: signal.aborted ? "CANCELLED" : "AGENT_NOT_READY" };
        await report({ status: "DIALING" });
        let answeredAt = null;
        try {
          // Caller-ID nur aus dem autorisierten Trunk-/Provider-Wert (Umgebung), sonst Trunk-Standard. Kein Spoofing.
          await sip.createSipParticipant(trunk, job.phone_e164, room, { participantIdentity: `callee-${job.call_id.slice(0, 8)}`, participantName: "callee",
            ...(callerId ? { fromNumber: callerId } : {}), waitUntilAnswered: true, ringingTimeout: 30, maxCallDuration: Math.max(60, Math.min(MAX_CALL_SECONDS, Number.isInteger(job.max_call_seconds) ? job.max_call_seconds : MAX_CALL_SECONDS)), krispEnabled: true, hidePhoneNumber: true });
          answeredAt = new Date();
          await report({ status: "ANSWERED", answered_at: answeredAt.toISOString() });
        } catch (e) {
          const m = mapSipError(e);
          return { status: m.outcome || "FAILED", retry: m.retry, reason: m.reason };
        }
        // Gespräch beobachten: Ende, wenn der Agent abschliesst, der Angerufene auflegt, Abbruch oder Höchstdauer.
        const deadline = Date.now() + ((Number.isInteger(job.max_call_seconds) ? Math.min(job.max_call_seconds, MAX_CALL_SECONDS) : MAX_CALL_SECONDS) + 30) * 1000;
        while (!signal.aborted && !ticket.finished && Date.now() < deadline) {
          await sleep(3000, signal);
          const ps = await rooms.listParticipants(room).catch(() => null);
          const callee = ps?.find((p) => p.identity === `callee-${job.call_id.slice(0, 8)}`);
          if (ps && !callee) break;
          const st = mapSipCallStatus(callee?.attributes?.["sip.callStatus"]);
          if (st === "COMPLETED") break;
        }
        await sleep(1500);
        const r = ticket.result();
        const duration_s = Math.max(0, Math.round((Date.now() - +answeredAt) / 1000));
        if (signal.aborted && !r.outcome) return { status: "CANCELLED", duration_s, answered_at: answeredAt.toISOString() };
        return { status: r.outcome || "COMPLETED", duration_s, summary: r.summary, callback_at: r.callback_at, transfer: r.transfer, answered_at: answeredAt.toISOString() };
      } finally {
        ticket.close();
        await del(room);
      }
    },
    async probe({ trunkCh, trunkVn }) {
      const out = { livekit_reachable: false, trunk_ch_verified: false, trunk_vn_verified: false };
      try { await rooms.listRooms([`jc-probe-${Date.now()}`]); out.livekit_reachable = true; } catch { return out; }
      const check = async (id) => { if (!id) return false; try { const l = await sip.listSipOutboundTrunk({ trunkIds: [id] }); return Array.isArray(l) && l.some((x) => x?.sipTrunkId === id); } catch { return false; } };
      out.trunk_ch_verified = await check(trunkCh); out.trunk_vn_verified = await check(trunkVn);
      return out;
    },
  };
}

// ---------- lokaler Kanal Agent ↔ Orchestrator (nur 127.0.0.1, Einmal-Token je Anruf) ----------
// TF-068: POST /tool → CRM-Tools des Agenten, weitergereicht an /api/calling (op tool) mit call_id + lead_id DIESES Anrufs.
export function localChannel({ port = 0, modelsOf, transferOf, toolFn = null } = {}) {
  const tickets = new Map();
  const server = http.createServer((req, res) => {
    const send = (s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    const tk = tickets.get(String(req.headers["x-call-token"] || ""));
    if (!tk) return send(403, { error: "forbidden" });
    if (req.method === "GET" && req.url === "/context") return send(200, { call_id: tk.job.call_id, context: tk.job.context, models: modelsOf(tk.job.market), transfer: transferOf(tk.job.market) });
    if (req.method === "POST" && req.url === "/tool") {
      let raw = "";
      req.on("data", (d) => { raw += d; if (raw.length > 8000) req.destroy(); });
      req.on("end", async () => {
        let b; try { b = JSON.parse(raw); } catch { return send(400, { error: "json" }); }
        if (!toolFn) return send(503, { error: "tools_unavailable" });
        const r = await toolFn(tk.job, b).catch((e) => ({ status: e.status || 502, body: e.body || { error: "tool_failed" } }));
        send(r.status, r.body);
      });
      return;
    }
    if (req.method === "POST" && req.url === "/event") {
      let raw = "";
      req.on("data", (d) => { raw += d; if (raw.length > 8000) req.destroy(); });
      req.on("end", () => {
        let ev; try { ev = JSON.parse(raw); } catch { return send(400, { error: "json" }); }
        tk.onEvent(ev);
        send(200, { ok: true });
      });
      return;
    }
    send(404, { error: "not_found" });
  });
  const ch = {
    port: 0,
    listen: () => new Promise((res) => server.listen(port, "127.0.0.1", () => { ch.port = server.address().port; res(); })),
    close: () => new Promise((res) => server.close(() => res())),
    open(job) {
      const token = crypto.randomBytes(32).toString("base64url");
      let readyRes; const readyP = new Promise((r) => { readyRes = r; });
      const st = { outcome: null, summary: null, callback_at: null, transfer: null };
      const t = { token, job, finished: false,
        onEvent(ev) {
          if (ev?.type === "ready") readyRes(true);
          if (ev?.type === "outcome" && typeof ev.outcome === "string") {
            if (st.outcome !== "DO_NOT_CALL") st.outcome = ev.outcome;
            if (typeof ev.summary === "string") st.summary = ev.summary.slice(0, 300);
            if (typeof ev.callback_at === "string") st.callback_at = ev.callback_at;
            if (typeof ev.transfer === "string") st.transfer = ev.transfer;
          }
          if (ev?.type === "finish") t.finished = true;
        },
        waitReady: (ms, signal) => Promise.race([readyP, sleep(ms, signal).then(() => false)]),
        result: () => ({ ...st }),
        close: () => tickets.delete(token) };
      tickets.set(token, t);
      return t;
    },
  };
  return ch;
}

// ---------- Orchestrator ----------
export function createOrchestrator({ env = (k) => process.env[k], fetchImpl = fetch, dialer, dataDir, now = () => new Date(), probe = null }) {
  const cfg = configStatus(env);
  const base = String(env("JARVIS_CALLING_URL") || "").replace(/\/+$/, "");
  const token = env("JARVIS_CALLING_AGENT_TOKEN");
  const st = loadState(dataDir);
  const running = new Map(); // call_id → AbortController
  let probed = { livekit_reachable: false, trunk_ch_verified: false, trunk_vn_verified: false }, workerRegistered = false, recovered = false, startedAt = now().toISOString();
  const providerLimit = Number.parseInt(String(env("CALLING_PROVIDER_MAX_CONCURRENCY") || ""), 10);
  const maxConc = Math.min(cfg.max_concurrency, HARD_MAX_CONCURRENCY, Number.isInteger(providerLimit) && providerLimit > 0 ? providerLimit : HARD_MAX_CONCURRENCY);
  const api = async (body) => {
    const r = await fetchImpl(`${base}/api/calling`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-calling": token }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw Object.assign(new Error(`api ${r.status}`), { status: r.status, body: j });
    return j;
  };
  const statusBody = () => ({ configured: { livekit: cfg.livekit, livekit_url: cfg.livekit_url, api_credentials: cfg.api_credentials, trunk_ch: cfg.trunk_ch, trunk_vn: cfg.trunk_vn,
      caller_id_ch: cfg.caller_id_ch, caller_id_vn: cfg.caller_id_vn, transfer_ch: cfg.transfer_ch, transfer_vn: cfg.transfer_vn, voice_vn: cfg.voice_vn },
    ...probed, worker_registered: workerRegistered, dry_run: cfg.dry_run, default_concurrency: cfg.default_concurrency, max_concurrency: maxConc,
    provider_limit: Number.isInteger(providerLimit) && providerLimit > 0 ? providerLimit : null, recording: false,
    models: { CH: publicModels(resolveModels("CH", env)), VN: publicModels(resolveModels("VN", env)) }, commit: env("JARVIS_COMMIT") || null, started_at: startedAt, active: running.size });
  const persist = () => saveState(dataDir, st);

  async function runJob(job) {
    const ac = new AbortController();
    running.set(job.call_id, ac);
    st.active[job.call_id] = { call_id: job.call_id, lead_id: job.lead_id, market: job.market, started_at: now().toISOString(), dry_run: !!job.dry_run, room: `jc-${job.call_id}` };
    persist();
    const report = (x) => api({ op: "event", call_id: job.call_id, ...x }).catch((e) => log("event_failed", { call: job.call_id.slice(0, 8), status: e.status || null }));
    log("call_start", { call: job.call_id.slice(0, 8), market: job.market, phone: maskPhone(job.phone_e164), dry_run: !!job.dry_run, attempt: job.attempt });
    let out;
    // TF-068 Zusatzschutz: echter VN-Anruf nur mit verifizierter männlicher VN-Stimme und Caller-ID (Server prüft das bereits).
    const realVn = !(job.dry_run || cfg.dry_run || dialer.kind === "dry_run") && job.market === "VN";
    if (realVn && (cfg.voice_vn !== "VOICE_VERIFIED" || !cfg.caller_id_vn)) out = { status: "FAILED", retry: true, reason: cfg.voice_vn !== "VOICE_VERIFIED" ? "VOICE_NOT_VERIFIED" : "CALLER_ID_NOT_CONFIGURED" };
    else try { out = await (job.dry_run || cfg.dry_run || dialer.kind === "dry_run" ? dryDialer : dialer).run(job, { report, signal: ac.signal }); }
    catch (e) { out = { status: "FAILED", reason: "SERVICE_ERROR" }; log("call_error", { call: job.call_id.slice(0, 8), error: String(e?.message || e).slice(0, 120).replace(/\+\d{6,}/g, "[nr]") }); }
    // Abschluss melden; falls /api/calling nicht erreichbar → Eintrag bleibt im Zustand und wird beim nächsten Lauf als Review gemeldet.
    let ok = false;
    for (let i = 0; i < 5 && !ok; i++) { try { await api({ op: "event", call_id: job.call_id, ended_at: now().toISOString(), ...out }); ok = true; } catch { await sleep(2000 * (i + 1)); } }
    running.delete(job.call_id);
    if (ok) { delete st.active[job.call_id]; persist(); }
    log("call_end", { call: job.call_id.slice(0, 8), status: out.status, retry: !!out.retry, reason: out.reason || null });
  }
  const dryDialer = dryRunDialer();

  async function recover() {
    // Nach Absturz/Neustart: aktive Anrufe nie neu wählen. Room noch da → beenden (kein Agent mehr) und zur Prüfung melden.
    for (const a of Object.values(st.active)) {
      if (!a.dry_run && dialer.kind === "livekit") await dialer.del(a.room);
      try { await api({ op: "event", call_id: a.call_id, status: "FAILED", review_required: true, reason: "CALL_STATE_REVIEW_REQUIRED" }); delete st.active[a.call_id]; }
      catch (e) { if (e.status === 404) delete st.active[a.call_id]; }
    }
    persist();
    recovered = true;
  }
  async function tick() {
    if (!recovered) await recover();
    if (probe) probed = { ...probed, ...(await probe().catch(() => ({}))) };
    const capacity = Math.max(0, maxConc - running.size);
    const r = await api({ op: "pull", status: statusBody(), capacity, active_call_ids: [...running.keys()], recovered: true });
    for (const c of r.commands || []) if (c.type === "hangup" && running.has(c.call_id)) { running.get(c.call_id).abort(); log("hangup", { call: c.call_id.slice(0, 8) }); }
    for (const job of r.jobs || []) {
      if (running.size >= maxConc || running.has(job.call_id)) continue; // eigener harter Deckel zusätzlich zum Server
      if (!/^\+\d{8,15}$/.test(String(job.phone_e164 || ""))) continue;
      runJob(job);
    }
    writeHealth(dataDir, { at: now().toISOString(), ok: true, active: running.size, configured: cfg.livekit, dry_run: cfg.dry_run });
    return r;
  }
  // CRM-Tool des Agenten: Server prüft aktiven Anruf, Lead, Allowlist und Idempotenz.
  const tool = async (job, b) => {
    const r = await fetchImpl(`${base}/api/calling`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-calling": token },
      body: JSON.stringify({ op: "tool", call_id: job.call_id, lead_id: typeof b.lead_id === "string" ? b.lead_id : job.lead_id, tool: b.tool, params: b.params || {}, idempotency_key: b.idempotency_key }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { tick, recover, tool, running, state: st, cfg, maxConc, statusBody, setWorker: (v) => { workerRegistered = v; }, setProbe: (p) => { probed = { ...probed, ...p }; } };
}

// ---------- Prozess ----------
async function main() {
  const env = (k) => process.env[k];
  const dataDir = env("JARVIS_CALLING_DIR") || "/data/calling";
  if (process.argv.includes("--healthcheck")) {
    try { const h = JSON.parse(fs.readFileSync(path.join(dataDir, "calling_health.json"), "utf8")); process.exit(Date.now() - Date.parse(h.at) < HEALTH_MAX_AGE_MS ? 0 : 1); } catch { process.exit(1); }
  }
  const cfg = configStatus(env);
  if (process.argv.includes("--status")) {
    // Nur Ja/Nein und Variablennamen – nie Werte.
    const { MISSING_VARS } = await import("../calling-core.js");
    process.stdout.write(`${JSON.stringify({ livekit_url: cfg.livekit_url, api_credentials: cfg.api_credentials, trunk_ch: cfg.trunk_ch, trunk_vn: cfg.trunk_vn, caller_id_ch: cfg.caller_id_ch, caller_id_vn: cfg.caller_id_vn,
      transfer_ch: cfg.transfer_ch, transfer_vn: cfg.transfer_vn, dry_run: cfg.dry_run, default_concurrency: cfg.default_concurrency, max_concurrency: cfg.max_concurrency, recording: "OFF",
      missing: MISSING_VARS(cfg), health: (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, "calling_health.json"), "utf8")); } catch { return null; } })() })}\n`);
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  let dialer = dryRunDialer(), local = null, worker = null;
  const orchRef = {};
  if (cfg.livekit) {
    local = localChannel({ modelsOf: (m) => resolveModels(m, env), transferOf: (m) => ({ configured: cfg[`transfer_${m === "VN" ? "vn" : "ch"}`] }), toolFn: (job, b) => orchRef.tool(job, b) });
    await local.listen();
    dialer = await livekitDialer({ env, local });
  }
  const orch = createOrchestrator({ env, dialer, dataDir, probe: cfg.livekit ? async () => {
    const now = Date.now();
    if (main.lastProbe && now - main.lastProbe < 5 * 60_000) return {};
    main.lastProbe = now;
    return dialer.probe({ trunkCh: env("LIVEKIT_SIP_TRUNK_CH"), trunkVn: env("LIVEKIT_SIP_TRUNK_VN") });
  } : null });
  orchRef.tool = orch.tool;
  log("service_start", { configured: cfg.livekit, dry_run: cfg.dry_run, trunk_ch: cfg.trunk_ch, trunk_vn: cfg.trunk_vn, max_concurrency: orch.maxConc, recording: "OFF" });
  // Agent-Worker als Kindprozess (nur mit Credentials). Explizites Dispatch → ohne unseren Dispatch bekommt er keine Jobs.
  const startWorker = () => {
    worker = spawn(process.execPath, [path.join(HERE, "agent.js"), "start"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const watch = (d) => { if (/registered worker/i.test(String(d))) { orch.setWorker(true); log("worker_registered"); } };
    worker.stdout.on("data", watch); worker.stderr.on("data", watch);
    worker.on("exit", (code) => { orch.setWorker(false); log("worker_exit", { code }); setTimeout(startWorker, 15_000); });
  };
  if (cfg.livekit) startWorker();
  let delay = 5000;
  for (;;) {
    try { const r = await orch.tick(); delay = r.hot ? 5000 : 20_000; }
    catch (e) { log("pull_failed", { status: e.status || null }); writeHealth(dataDir, { at: new Date().toISOString(), ok: true, pull_ok: false }); delay = 30_000; }
    await sleep(delay);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((e) => { log("fatal", { error: String(e?.message || e).slice(0, 200) }); process.exit(1); });
