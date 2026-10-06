// Cloud-Mailaufträge: Der Cloud-Jarvis darf ausschliesslich strukturierte Mailaufträge in eine begrenzte Warteschlange
// legen (Netlify Blobs). Gesendet wird nur vom lokalen Mail-Worker, der jeden Auftrag nach allen bestehenden Regeln
// prüft (Versandgrundlage, Suppression, Opt-out, Limits, Versandfenster) und das Ergebnis zurückmeldet.
// Bewusst ohne Node-Abhängigkeiten: läuft lokal (Node), als Netlify Function und in der Edge Function.
// Nie in der Cloud: Gmail-Zugangsdaten, OAuth-Tokens, .secrets, lokale Pfade, Befehle, Anhänge.
import { safeEqual, findSensitiveKeys } from "./shared-state.js";

export const MAIL_REQUEST_LIMITS = { recipientChars: 254, subjectChars: 200, bodyChars: 5000, reasonChars: 200, queue: 100, pending: 25,
  ttlHours: 24, maxTtlHours: 72, duplicateHours: 24, bodyBytes: 16_000 };
export const REQUEST_STATUSES = ["pending", "accepted_local", "blocked", "sent", "failed", "expired"];
export const FINAL_STATUSES = ["blocked", "sent", "failed", "expired"];
export const INTENTS = ["sales", "follow_up", "reply", "info"];
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
      fingerprint: fingerprint(recipient, subject.toLowerCase(), body),
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
  const dup = current.find((r) => r.fingerprint === request.fingerprint && r.created_at >= since && ["pending", "accepted_local", "sent"].includes(r.status));
  if (dup) return { status: 200, list: current, request: dup, duplicate: true };
  if (current.filter((r) => r.status === "pending").length >= MAIL_REQUEST_LIMITS.pending) return { status: 429, error: "Zu viele offene Mailaufträge – erst den lokalen Worker abarbeiten lassen." };
  return { status: 201, list: trim([...current, request]), request, duplicate: false };
}

const ALLOWED_TRANSITIONS = { pending: ["accepted_local", "blocked", "sent", "failed", "expired"], accepted_local: ["sent", "failed", "blocked", "expired"] };
// Ergebnis vom lokalen Worker übernehmen. Endzustände sind unveränderlich.
export function applyResult(list, { request_id, status, reason }, now = new Date()) {
  const r = list.find((x) => x.request_id === request_id);
  if (!r) return { status: 404, error: "Auftrag unbekannt." };
  if (r.status === status) return { status: 200, list, request: r };
  if (!(ALLOWED_TRANSITIONS[r.status] || []).includes(status)) return { status: 409, error: `Übergang ${r.status} → ${status} nicht erlaubt.` };
  const t = now.toISOString();
  const next = { ...r, status, reason: typeof reason === "string" ? reason.replace(CONTROL, "").slice(0, MAIL_REQUEST_LIMITS.reasonChars) : null, updated_at: t };
  return { status: 200, list: list.map((x) => (x === r ? next : x)), request: next };
}

// Sicht für den Browser: kein Fingerabdruck, Text gekürzt.
export const publicView = (r) => ({ request_id: r.request_id, created_at: r.created_at, expires_at: r.expires_at, recipient: r.recipient, subject: r.subject,
  intent: r.intent, status: r.status, reason: r.reason, updated_at: r.updated_at, optional_thread_reference: r.optional_thread_reference });

// Warteschlange auf einem Speicher mit bedingtem Schreiben (netlifyBlobStore/memoryStore aus shared-state.js).
export function createMailQueue(store, { now = () => new Date() } = {}) {
  async function mutate(fn) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, etag } = await store.get();
      const r = fn(cleanList(state?.requests));
      if (!r.list || r.status >= 400) return r;
      if (await store.set({ requests: r.list }, etag)) return r;
    }
    return { status: 409, error: "Gleichzeitige Änderung – bitte erneut versuchen." };
  }
  return {
    create: (input, requestedBy = "chris") => mutate((list) => addRequest(list, input, { now: now(), requestedBy })),
    result: (res) => mutate((list) => applyResult(expireRequests(list, now()), res, now())),
    async list() { return expireRequests(cleanList((await store.get()).state?.requests), now()); },
  };
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// /api/mail-requests – x-jarvis-key (Chris im Browser): Aufträge anlegen und Status lesen.
// x-jarvis-sync (nur der lokale Worker): offene Aufträge abholen und Ergebnisse melden.
export function createMailRequestHandler({ getStore, env, now = () => new Date() }) {
  return async (req) => {
    const syncToken = env("JARVIS_SYNC_TOKEN"), password = env("JARVIS_PASSWORD");
    const isLocal = !!syncToken && safeEqual(req.headers.get("x-jarvis-sync"), syncToken);
    const isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    if (!isLocal && !isUser) return reply(401, { error: "Nicht berechtigt." });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    const queue = createMailQueue(await getStore(), { now });
    if (req.method === "GET") {
      const list = await queue.list();
      // Der lokale Worker bekommt die offenen Aufträge vollständig, der Browser nur die Statusübersicht.
      return reply(200, isLocal ? { requests: list.filter((r) => r.status === "pending") } : { requests: list.map(publicView).slice(-20) });
    }
    if (Number(req.headers.get("content-length") || 0) > MAIL_REQUEST_LIMITS.bodyBytes) return reply(413, { error: "Zu gross." });
    const raw = await req.text();
    if (raw.length > MAIL_REQUEST_LIMITS.bodyBytes) return reply(413, { error: "Zu gross." });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    if (!body || typeof body !== "object") return reply(400, { error: "Ungültige Anfrage." });
    let r;
    if (body.op === "create") {
      if (!isUser) return reply(403, { error: "Nur Chris darf Mailaufträge anlegen." });
      const { op, ...input } = body;
      r = await queue.create(input);
    } else if (body.op === "result") {
      if (!isLocal) return reply(403, { error: "Nur der lokale Mail-Worker meldet Ergebnisse." });
      if (!["accepted_local", "blocked", "sent", "failed", "expired"].includes(body.status) || typeof body.request_id !== "string") return reply(400, { error: "Ungültiges Ergebnis." });
      r = await queue.result({ request_id: body.request_id, status: body.status, reason: body.reason });
    } else return reply(400, { error: "Unbekannte Operation." });
    return r.status >= 400 ? reply(r.status, { error: r.error }) : reply(r.status, { request: publicView(r.request), duplicate: !!r.duplicate });
  };
}

// ---------- Lokaler Worker: abholen und Ergebnisse melden (wirft nie) ----------

const endpoint = (url) => String(url || "").replace(/\/api\/state$/, "") + "/api/mail-requests";

export async function pullMailRequests({ config, fetchFn = globalThis.fetch }) {
  if (!config?.token) return { ok: false, skipped: "kein JARVIS_SYNC_TOKEN", requests: [] };
  try {
    const r = await fetchFn(endpoint(config.url), { headers: { "x-jarvis-sync": config.token }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ok: true, requests: cleanList((await r.json()).requests).filter((x) => x.status === "pending") };
  } catch (e) { return { ok: false, error: e.message, requests: [] }; }
}

export async function pushMailResult({ config, fetchFn = globalThis.fetch, request_id, status, reason }) {
  if (!config?.token) return { ok: false };
  try {
    const r = await fetchFn(endpoint(config.url), { method: "POST", headers: { "content-type": "application/json", "x-jarvis-sync": config.token },
      body: JSON.stringify({ op: "result", request_id, status, reason }), signal: AbortSignal.timeout(20_000) });
    // 404/409: Auftrag in der Cloud unbekannt oder schon abgeschlossen – nicht endlos wiederholen.
    return { ok: r.ok || r.status === 404 || r.status === 409, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}
