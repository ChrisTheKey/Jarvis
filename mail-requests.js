// Cloud-Mailaufträge: Der Cloud-Jarvis darf ausschliesslich strukturierte Mailaufträge in eine begrenzte Warteschlange
// legen (Netlify Blobs). Gesendet wird nur vom Mail-Worker mit send_authority (VPS, sonst lokal), der jeden Auftrag nach
// allen bestehenden Regeln prüft (Versandgrundlage, Suppression, Opt-out, Limits) und das Ergebnis zurückmeldet.
// Dazu: Lease je Auftrag, serverseitige Send-Locks (jede Mail genau einmal) und Worker-Heartbeat (MAIL SERVICE ONLINE/OFFLINE).
// Bewusst ohne Node-Abhängigkeiten: läuft lokal (Node), als Netlify Function und in der Edge Function.
// Nie in der Cloud: Gmail-Zugangsdaten, OAuth-Tokens, .secrets, lokale Pfade, Befehle, Anhänge.
import { safeEqual, findSensitiveKeys } from "./shared-state.js";
import { cleanCore } from "./cloud-core.js";

export const MAIL_REQUEST_LIMITS = { recipientChars: 254, subjectChars: 200, bodyChars: 5000, reasonChars: 200, queue: 100, pending: 25,
  ttlHours: 24, maxTtlHours: 72, duplicateHours: 24, bodyBytes: 16_000 };
export const REQUEST_STATUSES = ["pending", "processing", "accepted_local", "blocked", "sent", "failed", "expired"];
export const FINAL_STATUSES = ["blocked", "sent", "failed", "expired"];
export const INTENTS = ["sales", "follow_up", "reply", "info"];
// Mailklassen: A/B nur in den Versandfenstern 09:30/14:30, C/D zeitnah (24/7) – immer nach allen Schutzregeln.
export const MAIL_CLASSES = ["automatic_sales_outreach", "sales_followup", "conversation_reply", "manual_chris_mail"];
// Lease eines übernommenen Auftrags bzw. Send-Locks; ein Heartbeat älter als HEARTBEAT_STALE_MS = MAIL SERVICE OFFLINE.
export const LEASE_MS = 10 * 60_000;
export const HEARTBEAT_STALE_MS = 5 * 60_000;
const LOCK_LIMIT = 2000, LOCK_DAYS = 30, CLAIM_MAX = 10;
const REF_RE = /^[a-f0-9]{12,32}$/;
const FIELDS = ["request_id", "recipient", "subject", "body", "optional_thread_reference", "intent", "ttl_hours"];
const ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Kurzer, nicht-kryptografischer Fingerabdruck (FNV-1a) für den Duplikat-Schutz.
function fingerprint(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0001")) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const newId = () => "mr-" + (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// Baut einen Auftrag ausschliesslich aus erlaubten Feldern. Liefert { request } oder { error }.
export function sanitizeMailRequest(input, { now = new Date(), requestedBy = "chris" } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Ungültiger Auftrag." };
  if ("attachments" in input || "attachment" in input) return { error: "Anhänge sind nicht erlaubt." };
  const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k) && k !== "op");
  if (unknown.length) return { error: "Unbekannte Felder: " + unknown.slice(0, 5).join(", ") };
  const bad = findSensitiveKeys(input);
  if (bad.length) return { error: "Sensible Felder sind nicht erlaubt." };
  const L = MAIL_REQUEST_LIMITS;
  const recipient = typeof input.recipient === "string" ? input.recipient.trim().toLowerCase() : "";
  if (!recipient || recipient.length > L.recipientChars || /[\r\n,;]/.test(recipient) || !EMAIL_RE.test(recipient)) return { error: "Empfänger ungültig (genau eine E-Mail-Adresse)." };
  const subject = typeof input.subject === "string" ? input.subject.replace(CONTROL, "").replace(/[\r\n]+/g, " ").trim() : "";
  if (!subject || subject.length > L.subjectChars) return { error: `Betreff fehlt oder ist länger als ${L.subjectChars} Zeichen.` };
  const body = typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").replace(CONTROL, "").trim() : "";
  if (!body || body.length > L.bodyChars) return { error: `Text fehlt oder ist länger als ${L.bodyChars} Zeichen.` };
  const ref = input.optional_thread_reference ?? null;
  if (ref !== null && !(typeof ref === "string" && /^[a-f0-9]{12}$/.test(ref))) return { error: "Thread-Referenz ungültig." };
  if (input.request_id !== undefined && !(typeof input.request_id === "string" && ID_RE.test(input.request_id))) return { error: "request_id ungültig." };
  const ttl = Math.min(L.maxTtlHours, Math.max(1, Number(input.ttl_hours) || L.ttlHours));
  const created = now.toISOString();
  return {
    request: {
      request_id: input.request_id || newId(), created_at: created, expires_at: new Date(+now + ttl * 3_600_000).toISOString(),
      requested_by: requestedBy, recipient, subject, body, optional_thread_reference: ref,
      intent: INTENTS.includes(input.intent) ? input.intent : "sales", status: "pending", reason: null, updated_at: created,
      fingerprint: fingerprint(recipient, subject.toLowerCase(), body), mail_class: "manual_chris_mail", lease_owner: null, lease_expires_at: null, attempts: 0,
    },
  };
}

// Gespeicherten Eintrag wieder auf das Schema zurückführen (unbekannte Felder fallen weg).
function clean(r) {
  if (!r || typeof r !== "object" || !ID_RE.test(r.request_id || "")) return null;
  const s = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  return {
    request_id: r.request_id, created_at: s(r.created_at, 40), expires_at: s(r.expires_at, 40), requested_by: s(r.requested_by, 40) || "chris",
    recipient: s(r.recipient, MAIL_REQUEST_LIMITS.recipientChars), subject: s(r.subject, MAIL_REQUEST_LIMITS.subjectChars), body: s(r.body, MAIL_REQUEST_LIMITS.bodyChars),
    optional_thread_reference: typeof r.optional_thread_reference === "string" && /^[a-f0-9]{12}$/.test(r.optional_thread_reference) ? r.optional_thread_reference : null,
    intent: INTENTS.includes(r.intent) ? r.intent : "sales", status: REQUEST_STATUSES.includes(r.status) ? r.status : "pending",
    reason: s(r.reason, MAIL_REQUEST_LIMITS.reasonChars), updated_at: s(r.updated_at, 40), fingerprint: s(r.fingerprint, 16),
    mail_class: "manual_chris_mail", lease_owner: s(r.lease_owner, 20), lease_expires_at: s(r.lease_expires_at, 40), attempts: Number.isFinite(r.attempts) ? r.attempts : 0,
  };
}
export const cleanList = (list) => (Array.isArray(list) ? list : []).map(clean).filter(Boolean);

// Offene Aufträge nach Ablauf als expired markieren. Ein lokal angenommener Auftrag läuft nicht mehr ab.
export function expireRequests(list, now = new Date()) {
  const t = now.toISOString();
  return list.map((r) => (r.status === "pending" && r.expires_at && r.expires_at <= t ? { ...r, status: "expired", reason: "Abgelaufen, bevor der lokale Worker ihn prüfen konnte.", updated_at: t } : r));
}

// Begrenzen: erledigte Aufträge zuerst verwerfen, offene bleiben.
function trim(list) {
  const open = list.filter((r) => !FINAL_STATUSES.includes(r.status));
  const done = list.filter((r) => FINAL_STATUSES.includes(r.status)).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  return [...done.slice(-Math.max(0, MAIL_REQUEST_LIMITS.queue - open.length)), ...open].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Reine Logik für „Auftrag anlegen“ – genutzt vom HTTP-Endpunkt und von der Edge Function.
export function addRequest(list, input, { now = new Date(), requestedBy } = {}) {
  const { request, error } = sanitizeMailRequest(input, { now, requestedBy });
  if (error) return { status: 400, error };
  const current = expireRequests(cleanList(list), now);
  const same = current.find((r) => r.request_id === request.request_id);
  if (same) return same.fingerprint === request.fingerprint ? { status: 200, list: current, request: same, duplicate: true } : { status: 409, error: "request_id bereits mit anderem Inhalt vergeben." };
  const since = new Date(+now - MAIL_REQUEST_LIMITS.duplicateHours * 3_600_000).toISOString();
  const dup = current.find((r) => r.fingerprint === request.fingerprint && r.created_at >= since && ["pending", "processing", "accepted_local", "sent"].includes(r.status));
  if (dup) return { status: 200, list: current, request: dup, duplicate: true };
  if (current.filter((r) => r.status === "pending").length >= MAIL_REQUEST_LIMITS.pending) return { status: 429, error: "Zu viele offene Mailaufträge – erst den lokalen Worker abarbeiten lassen." };
  return { status: 201, list: trim([...current, request]), request, duplicate: false };
}

const ALLOWED_TRANSITIONS = { pending: ["processing", "accepted_local", "blocked", "sent", "failed", "expired"], processing: ["accepted_local", "blocked", "sent", "failed", "expired"],
  accepted_local: ["sent", "failed", "blocked", "expired"] };
// Ergebnis vom Mail-Worker übernehmen. Endzustände sind unveränderlich; ein übernommener Auftrag gehört seinem Lease-Inhaber.
export function applyResult(list, { request_id, status, reason, owner = null }, now = new Date()) {
  const r = list.find((x) => x.request_id === request_id);
  if (!r) return { status: 404, error: "Auftrag unbekannt." };
  if (r.lease_owner && owner && r.lease_owner !== owner) return { status: 409, error: "Auftrag gehört einem anderen Worker (Lease)." };
  if (r.status === status) return { status: 200, list, request: r };
  if (!(ALLOWED_TRANSITIONS[r.status] || []).includes(status)) return { status: 409, error: `Übergang ${r.status} → ${status} nicht erlaubt.` };
  const t = now.toISOString();
  const next = { ...r, status, reason: typeof reason === "string" ? reason.replace(CONTROL, "").slice(0, MAIL_REQUEST_LIMITS.reasonChars) : null, updated_at: t };
  return { status: 200, list: list.map((x) => (x === r ? next : x)), request: next };
}

// Offene Aufträge übernehmen (PENDING → PROCESSING) mit Lease. Ein Auftrag mit Lease gehört nur seinem Inhaber:
// nach einem Neustart übernimmt derselbe Worker ihn erneut, ein anderer nie (Ausgang unklar → kein Doppelversand).
export function claimRequests(list, owner, now = new Date()) {
  const t = now.toISOString(), until = new Date(+now + LEASE_MS).toISOString();
  const claimed = [];
  const next = list.map((r) => {
    const mine = r.status === "pending" || (r.status === "processing" && r.lease_owner === owner);
    if (!mine || claimed.length >= CLAIM_MAX) return r;
    const c = { ...r, status: "processing", lease_owner: owner, lease_expires_at: until, attempts: (r.attempts || 0) + 1, updated_at: t };
    claimed.push(c);
    return c;
  });
  return { status: 200, list: next, claimed };
}

// ---------- Serverseitige Send-Locks: jede Mail genau einmal ----------
// lock_key, thread_ref und message_ref sind Hashes – keine Gmail-IDs und keine Adressen in der Cloud.
// Ein Lock geht nie an einen anderen Worker über, auch nicht nach Ablauf: dann ist der Ausgang unklar und es wird nicht gesendet.
export function cleanLocks(locks, now = new Date()) {
  const horizon = new Date(+now - LOCK_DAYS * 86_400_000).toISOString();
  const entries = Object.entries(locks && typeof locks === "object" ? locks : {})
    .filter(([k, l]) => REF_RE.test(k) && l && typeof l.updated_at === "string" && l.updated_at >= horizon)
    .sort(([, a], [, b]) => a.updated_at.localeCompare(b.updated_at)).slice(-LOCK_LIMIT);
  const ref = (v) => (REF_RE.test(v || "") ? v : null);
  return Object.fromEntries(entries.map(([k, l]) => [k, { lock_key: k, request_id: ID_RE.test(l.request_id || "") ? l.request_id : null, thread_ref: ref(l.thread_ref),
    message_ref: ref(l.message_ref), lease_owner: String(l.lease_owner || "").slice(0, 20), lease_expires_at: typeof l.lease_expires_at === "string" ? l.lease_expires_at.slice(0, 40) : null,
    status: ["PROCESSING", "SENT", "FAILED"].includes(l.status) ? l.status : "PROCESSING", updated_at: l.updated_at }]));
}
export function acquireSendLock(locks, { lock_key, request_id = null, thread_ref = null, message_ref = null, owner }, now = new Date()) {
  if (!REF_RE.test(lock_key || "") || !owner) return { status: 400, error: "Ungültiges Lock." };
  const cur = locks[lock_key];
  if (cur?.status === "SENT") return { status: 409, error: "Bereits gesendet.", lock: cur };
  if (cur && cur.lease_owner !== owner) return { status: 409, error: "Lock gehört einem anderen Worker.", lock: cur };
  const lock = { lock_key, request_id: ID_RE.test(request_id || "") ? request_id : null, thread_ref: REF_RE.test(thread_ref || "") ? thread_ref : null,
    message_ref: REF_RE.test(message_ref || "") ? message_ref : null, lease_owner: owner, lease_expires_at: new Date(+now + LEASE_MS).toISOString(), status: "PROCESSING", updated_at: now.toISOString() };
  return { status: 200, locks: { ...locks, [lock_key]: lock }, lock };
}
export function finishSendLock(locks, { lock_key, owner, status }, now = new Date()) {
  const cur = locks[lock_key];
  if (!cur) return { status: 404, error: "Lock unbekannt." };
  if (cur.lease_owner !== owner) return { status: 409, error: "Lock gehört einem anderen Worker." };
  if (!["SENT", "FAILED"].includes(status)) return { status: 400, error: "Ungültiger Status." };
  if (cur.status === "SENT") return { status: 200, locks, lock: cur };
  const lock = { ...cur, status, updated_at: now.toISOString() };
  return { status: 200, locks: { ...locks, [lock_key]: lock }, lock };
}

// ---------- Worker-Heartbeat und Mail-Service-Status (nur Zahlen) ----------
const STAT_FIELDS = ["sent_today", "campaign_morning", "campaign_afternoon", "campaign_today", "replies_today", "manual_today", "blocked_today", "escalations_today", "ai_paused"];
export function cleanHeartbeat(h, owner, now = new Date()) {
  const stats = Object.fromEntries(STAT_FIELDS.map((k) => [k, Number.isFinite(h?.stats?.[k]) ? Math.max(0, Math.min(10_000, Math.round(h.stats[k]))) : 0]));
  return { worker_id: owner, role: owner === "vps" ? "vps" : "local", at: now.toISOString(), started_at: typeof h?.started_at === "string" ? h.started_at.slice(0, 40) : null, stats, core: cleanCore(h?.core) };
}
export function serviceStatus(state, now = new Date(), dedicated = false) {
  const requests = cleanList(state?.requests);
  const workers = state?.workers && typeof state.workers === "object" ? state.workers : {};
  const hb = workers[dedicated ? "vps" : "local"] || null;
  const s = hb?.stats || {};
  return {
    online: !!hb?.at && +now - Date.parse(hb.at) < HEARTBEAT_STALE_MS, authority: dedicated ? "vps" : "local", worker: hb?.role || null, last_heartbeat: hb?.at || null,
    pending: requests.filter((r) => r.status === "pending" || r.status === "processing").length,
    sent_today: s.sent_today || 0, blocked_today: s.blocked_today || 0, escalations_today: s.escalations_today || 0,
    // KI-Dienst des Workers: nur online / paused_credit – keine Keys, keine Billing-Daten.
    ai: hb?.at ? (s.ai_paused ? "paused_credit" : "online") : null,
    sales: { morning: s.campaign_morning || 0, afternoon: s.campaign_afternoon || 0, today: s.campaign_today || 0, window_limit: 50, daily_limit: 100 },
    // Cloud Core (gleicher Prozess wie der Mail-Worker): Schema, Scheduler-Checkpoints, Discovery, Backup – nur Whitelist-Felder.
    core: hb?.core ? cleanCore(hb.core) : null,
  };
}

// Sicht für den Browser: kein Fingerabdruck, kein Lease-Inhaber, Text gekürzt.
export const publicView = (r) => ({ request_id: r.request_id, created_at: r.created_at, expires_at: r.expires_at, recipient: r.recipient, subject: r.subject,
  intent: r.intent, mail_class: r.mail_class || "manual_chris_mail", status: r.status, reason: r.reason, updated_at: r.updated_at, optional_thread_reference: r.optional_thread_reference });

// Ein Blob { requests, locks, workers } mit bedingtem Schreiben (ETag) – gleichzeitige Worker überholen sich nie.
export function createMailQueue(store, { now = () => new Date(), dedicated = false } = {}) {
  async function mutate(fn) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { state, etag } = await store.get();
      const cur = { requests: cleanList(state?.requests), locks: cleanLocks(state?.locks, now()), workers: state?.workers && typeof state.workers === "object" ? state.workers : {} };
      const r = fn(cur);
      if (r.status >= 400 || (!r.list && !r.locks && !r.workers)) return r;
      if (await store.set({ requests: r.list || cur.requests, locks: r.locks || cur.locks, workers: r.workers || cur.workers }, etag)) return r;
    }
    return { status: 409, error: "Gleichzeitige Änderung – bitte erneut versuchen." };
  }
  return {
    create: (input, requestedBy = "chris") => mutate(({ requests }) => addRequest(requests, input, { now: now(), requestedBy })),
    result: (res) => mutate(({ requests }) => applyResult(expireRequests(requests, now()), res, now())),
    claim: (owner) => mutate(({ requests }) => claimRequests(expireRequests(requests, now()), owner, now())),
    lock: (x) => mutate(({ locks }) => acquireSendLock(locks, x, now())),
    unlock: (x) => mutate(({ locks }) => finishSendLock(locks, x, now())),
    heartbeat: (owner, h) => mutate(({ workers }) => ({ status: 200, workers: { ...workers, [owner]: cleanHeartbeat(h, owner, now()) } })),
    async list() { return expireRequests(cleanList((await store.get()).state?.requests), now()); },
    async status() { const { state } = await store.get(); return serviceStatus({ ...state, requests: expireRequests(cleanList(state?.requests), now()) }, now(), dedicated); },
  };
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// /api/mail-requests
// x-jarvis-key (Chris im Browser): Aufträge anlegen, Status und MAIL SERVICE ONLINE/OFFLINE lesen.
// send_authority: Ist JARVIS_MAIL_WORKER_TOKEN gesetzt, ist allein der VPS-Worker (x-jarvis-worker) Sender – er übernimmt Aufträge
// (Lease), setzt Send-Locks, meldet Ergebnisse und Heartbeat. Der Windows-Worker (x-jarvis-sync) bekommt dann nichts zum Senden.
// Ohne JARVIS_MAIL_WORKER_TOKEN bleibt der lokale Worker (x-jarvis-sync) wie bisher der einzige Sender.
export function createMailRequestHandler({ getStore, env, now = () => new Date() }) {
  return async (req) => {
    const syncToken = env("JARVIS_SYNC_TOKEN"), password = env("JARVIS_PASSWORD"), workerToken = env("JARVIS_MAIL_WORKER_TOKEN");
    const dedicated = !!workerToken;
    const isWorker = dedicated && safeEqual(req.headers.get("x-jarvis-worker"), workerToken);
    const isLocal = !!syncToken && safeEqual(req.headers.get("x-jarvis-sync"), syncToken);
    const isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    if (!isWorker && !isLocal && !isUser) return reply(401, { error: "Nicht berechtigt." });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    // Genau ein Sender: der VPS-Worker, wenn eingerichtet – sonst der lokale Worker.
    const owner = isWorker ? "vps" : isLocal && !dedicated ? "local" : null;
    const authority = { dedicated, holder: dedicated ? "vps" : "local", self: !!owner };
    const queue = createMailQueue(await getStore(), { now, dedicated });
    if (req.method === "GET") {
      if (isWorker || isLocal) {
        const list = owner ? await queue.list() : [];
        // service: dieselben Zahlen wie für den Browser (MAIL SERVICE, Authority, Wartend) – der Local Core zeigt sie im HUD an.
        return reply(200, { authority, requests: list.filter((r) => r.status === "pending"), service: await queue.status() });
      }
      return reply(200, { requests: (await queue.list()).map(publicView).slice(-20), service: await queue.status() });
    }
    if (Number(req.headers.get("content-length") || 0) > MAIL_REQUEST_LIMITS.bodyBytes) return reply(413, { error: "Zu gross." });
    const raw = await req.text();
    if (raw.length > MAIL_REQUEST_LIMITS.bodyBytes) return reply(413, { error: "Zu gross." });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    if (!body || typeof body !== "object") return reply(400, { error: "Ungültige Anfrage." });
    if (body.op === "create") {
      if (!isUser) return reply(403, { error: "Nur Chris darf Mailaufträge anlegen." });
      const { op, ...input } = body;
      const r = await queue.create(input);
      return r.status >= 400 ? reply(r.status, { error: r.error }) : reply(r.status, { request: publicView(r.request), duplicate: !!r.duplicate });
    }
    if (!["result", "claim", "lock", "unlock", "heartbeat"].includes(body.op)) return reply(400, { error: "Unbekannte Operation." });
    if (!owner) return reply(403, { error: "Kein send_authority: nur der zuständige Mail-Worker darf das.", authority });
    let r;
    if (body.op === "result") {
      if (!["processing", "accepted_local", "blocked", "sent", "failed", "expired"].includes(body.status) || typeof body.request_id !== "string") return reply(400, { error: "Ungültiges Ergebnis." });
      r = await queue.result({ request_id: body.request_id, status: body.status, reason: body.reason, owner });
      return r.status >= 400 ? reply(r.status, { error: r.error }) : reply(r.status, { request: publicView(r.request) });
    }
    if (body.op === "claim") {
      r = await queue.claim(owner);
      return r.status >= 400 ? reply(r.status, { error: r.error }) : reply(200, { authority, requests: r.claimed });
    }
    if (body.op === "lock" || body.op === "unlock") {
      const x = { lock_key: body.lock_key, request_id: body.request_id ?? null, thread_ref: body.thread_ref ?? null, message_ref: body.message_ref ?? null, status: body.status, owner };
      r = body.op === "lock" ? await queue.lock(x) : await queue.unlock(x);
      const { lease_owner, ...lock } = r.lock || {};
      return r.status >= 400 ? reply(r.status, { error: r.error, lock: r.lock ? { ...lock, mine: lease_owner === owner } : null }) : reply(200, { lock: { ...lock, mine: true } });
    }
    r = await queue.heartbeat(owner, body);
    return r.status >= 400 ? reply(r.status, { error: r.error }) : reply(200, { ok: true, authority });
  };
}

// ---------- Mail-Worker (VPS oder lokal): abholen, Locks, Ergebnisse, Heartbeat (wirft nie) ----------

const endpoint = (url) => String(url || "").replace(/\/api\/state$/, "") + "/api/mail-requests";
// Der VPS-Worker weist sich mit seinem eigenen Token aus, der lokale Worker mit dem Sync-Token.
const authHeaders = (config) => (config?.workerToken ? { "x-jarvis-worker": config.workerToken } : { "x-jarvis-sync": config?.token || "" });
const hasAuth = (config) => !!(config?.workerToken || config?.token);
const post = (config, fetchFn, body) => fetchFn(endpoint(config.url), { method: "POST", headers: { "content-type": "application/json", ...authHeaders(config) },
  body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
// Kurzer, stabiler Hash für Lock-Schlüssel und Referenzen (FNV-1a, 4 Runden = 32 Hex-Zeichen). Keine Rohdaten in die Cloud.
export function refHash(value, n = 24) {
  let out = "";
  for (let round = 0; out.length < n; round++) out += fingerprint(String(round), String(value));
  return out.slice(0, n);
}

export async function pullMailRequests({ config, fetchFn = globalThis.fetch }) {
  if (!hasAuth(config)) return { ok: false, skipped: "kein JARVIS_SYNC_TOKEN", requests: [] };
  try {
    const r = await fetchFn(endpoint(config.url), { headers: authHeaders(config), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return { ok: true, authority: j.authority || null, service: j.service || null, requests: cleanList(j.requests).filter((x) => x.status === "pending") };
  } catch (e) { return { ok: false, error: e.message, requests: [] }; }
}

// Offene Aufträge mit Lease übernehmen (PENDING → PROCESSING). Nur der Inhaber von send_authority bekommt etwas.
export async function claimMailRequests({ config, fetchFn = globalThis.fetch }) {
  if (!hasAuth(config)) return { ok: false, skipped: "kein Token", requests: [] };
  try {
    const r = await post(config, fetchFn, { op: "claim" });
    const j = await r.json().catch(() => ({}));
    if (r.status === 403) return { ok: true, authority: j.authority || { self: false }, requests: [] };
    if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}`, requests: [] };
    return { ok: true, authority: j.authority || null, requests: cleanList(j.requests) };
  } catch (e) { return { ok: false, error: e.message, requests: [] }; }
}

// Wer ist send_authority? { dedicated, holder, self } – oder null, wenn die Cloud nicht erreichbar ist.
export async function fetchAuthority({ config, fetchFn = globalThis.fetch }) {
  const r = await pullMailRequests({ config, fetchFn });
  return r.ok ? r.authority : null;
}

// Für das HUD (Local Core): Authority-Sicht dieses Rechners + Service-Status der Cloud (Heartbeat des Zuständigen, Wartend).
// Nur lesend – übernimmt nichts. null-Felder, wenn die Cloud nicht erreichbar ist.
export async function fetchMailService({ config, fetchFn = globalThis.fetch }) {
  if (!hasAuth(config)) return { ok: false, error: "kein Token", authority: null, service: null };
  const r = await pullMailRequests({ config, fetchFn });
  return r.ok ? { ok: true, authority: r.authority, service: r.service } : { ok: false, error: r.error, authority: null, service: null };
}

export async function pushMailResult({ config, fetchFn = globalThis.fetch, request_id, status, reason }) {
  if (!hasAuth(config)) return { ok: false };
  try {
    const r = await post(config, fetchFn, { op: "result", request_id, status, reason });
    // 404/409: Auftrag in der Cloud unbekannt oder schon abgeschlossen – nicht endlos wiederholen.
    return { ok: r.ok || r.status === 404 || r.status === 409, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function sendHeartbeat({ config, fetchFn = globalThis.fetch, stats = {}, started_at = null, core = null }) {
  if (!hasAuth(config)) return { ok: false };
  try { const r = await post(config, fetchFn, { op: "heartbeat", stats, started_at, core: cleanCore(core) }); return { ok: r.ok, status: r.status }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Send-Guard für den Worker: vor jedem Gmail-Send ein serverseitiges Lock, danach SENT/FAILED.
// acquire → { ok: true } | { ok: false, final: true } (anderswo gesendet/gehalten: nie senden) | { ok: false, final: false } (Cloud nicht erreichbar: später).
export function cloudSendGuard({ config, fetchFn = globalThis.fetch }) {
  return {
    async acquire({ key, request_id = null, threadId = null, messageId = null }) {
      try {
        const r = await post(config, fetchFn, { op: "lock", lock_key: refHash(key), request_id, thread_ref: threadId ? refHash(threadId, 12) : null, message_ref: messageId ? refHash(messageId, 12) : null });
        if (r.ok) return { ok: true };
        if (r.status === 409 || r.status === 403) return { ok: false, final: true, reason: r.status === 403 ? "kein send_authority" : "Lock gehalten oder bereits gesendet" };
        return { ok: false, final: false, reason: `HTTP ${r.status}` };
      } catch (e) { return { ok: false, final: false, reason: e.message }; }
    },
    async done(key, status) {
      try { await post(config, fetchFn, { op: "unlock", lock_key: refHash(key), status }); } catch {}
    },
  };
}
