// Cloud-Mailaufträge: Der Cloud-Jarvis darf ausschliesslich strukturierte Mailaufträge in eine begrenzte Warteschlange
import crypto from "node:crypto";

// legen (Netlify Blobs). Gesendet wird nur vom Mail-Worker mit send_authority (VPS, sonst lokal), der jeden Auftrag nach
// allen bestehenden Regeln prüft (Versandgrundlage, Suppression, Opt-out, Limits) und das Ergebnis zurückmeldet.
// Dazu: Lease je Auftrag, serverseitige Send-Locks (jede Mail genau einmal) und Worker-Heartbeat (MAIL SERVICE ONLINE/OFFLINE).
// Bewusst ohne Node-Abhängigkeiten: läuft lokal (Node), als Netlify Function und in der Edge Function.
// Nie in der Cloud: Gmail-Zugangsdaten, OAuth-Tokens, .secrets, lokale Pfade, Befehle, Anhänge.
import { safeEqual, findSensitiveKeys } from "./shared-state.js";
import { MANUAL_TEST_MAIL, isManualTestMail } from "./manual-test-mail.js";
export { MANUAL_TEST_MAIL, isManualTestMail };
import { cleanCore } from "./cloud-core.js";
import { migrateMailQueue, migrateStoreDoc, migrateOnce } from "./seller-identity.js";
import { mailAccessFor, draftRefOf, DRAFT_REF_RE, SELLER_SEND_DAILY_LIMIT } from "./mail-access.js";
import { buildSalesIntakeMail, buildSalesIntakePreview, newIntakeToken, salesOrderRefs, salesVaultLink, SALES_DIRECT_OFFERS } from "./sales-intake.js";
import { salesBundleId } from "./sales-intake-bundle.js";
import { signCrmClick, CRM_CLICK_RE, SALES_SEND_FAILED_REASON } from "./security-capabilities.js";

export const MAIL_REQUEST_LIMITS = { recipientChars: 254, subjectChars: 200, bodyChars: 5000, reasonChars: 200, queue: 100, pending: 25,
  ttlHours: 24, maxTtlHours: 72, duplicateHours: 24, bodyBytes: 16_000 };
export const REQUEST_STATUSES = ["pending", "processing", "accepted_local", "blocked", "sent", "drafted", "failed", "expired"];
export const FINAL_STATUSES = ["blocked", "sent", "drafted", "failed", "expired"];
export const INTENTS = ["sales", "follow_up", "reply", "info"];
// delivery "draft": der Worker legt nur einen Gmail-Entwurf an (COLD_LEAD_DRAFT_ONLY) – Jarvis sendet ihn nie von sich aus.
// delivery "send_prepared" (TF-077B, SEND_PREPARED_LEAD_DRAFT): ein Verkäufer hat «E-Mail lossenden» geklickt – der Worker sendet GENAU den
// vorbereiteten Jarvis-Entwurf dieses Leads (draft_ref), ohne Betreff/Text aus der Cloud. Empfänger = CRM-Adresse des Leads.
export const DELIVERIES = ["send", "draft", "send_prepared", "sales_intake"];
// Wiederholen nach einem Fehlschlag ist erlaubt (der Worker sendet nur einen noch unversendet in Gmail liegenden Entwurf), aber begrenzt.
export const SEND_PREPARED_MAX_ATTEMPTS = 3;
const OPEN_OR_SENT = ["pending", "processing", "accepted_local", "sent"];
// Mailklassen: A/B nur in den Versandfenstern 09:30/14:30, C/D zeitnah (24/7) – immer nach allen Schutzregeln.
export const MAIL_CLASSES = ["automatic_sales_outreach", "sales_followup", "conversation_reply", "manual_chris_mail"];
// Lease eines übernommenen Auftrags bzw. Send-Locks; ein Heartbeat älter als HEARTBEAT_STALE_MS = MAIL SERVICE OFFLINE.
export const LEASE_MS = 10 * 60_000;
export const HEARTBEAT_STALE_MS = 5 * 60_000;
const LOCK_LIMIT = 2000, LOCK_DAYS = 30, CLAIM_MAX = 10;
const REF_RE = /^[a-f0-9]{12,32}$/;
const FIELDS = ["request_id", "recipient", "subject", "body", "optional_thread_reference", "intent", "ttl_hours", "delivery", "draft_ref", "manual_test", "manual_test_lead_id"];
const ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// TF-064: serverseitig gebundene Metadaten eines Verkäufer-Entwurfs (aus Session + autorisiertem Lead – nie aus dem Browser).
// Der Mail-Worker wählt damit Absenderprofil, Signatur und Abmeldezeile (sender-profiles.js).
const META_LEAD_RE = /^[a-z0-9][a-z0-9.@_+-]{2,252}$/;
export function cleanMeta(m) {
  if (!m || typeof m !== "object") return null;
  // TF-070: Benutzer-IDs dürfen Grossbuchstaben enthalten ("Kudoshin").
  const actor = typeof m.actor_user_id === "string" && /^[A-Za-z]{2,20}$/.test(m.actor_user_id) ? m.actor_user_id : null;
  const market = ["CH", "VN"].includes(m.market) ? m.market : null;
  const locale = ["de-CH", "vi-VN"].includes(m.locale) ? m.locale : null;
  const lead_id = typeof m.lead_id === "string" && META_LEAD_RE.test(m.lead_id) ? m.lead_id : null;
  const sales = m.sales_intake === true && typeof m.preview_ref === "string" && /^[a-f0-9]{64}$/.test(m.preview_ref)
    ? { sales_intake: true, preview_ref: m.preview_ref, bundle_id: salesBundleId(m.preview_ref), order150_id: m.order150_id, order480_id: m.order480_id,
      ...(CRM_CLICK_RE.test(String(m.click_attestation || "")) ? { click_attestation: m.click_attestation } : {}),
      ...(m.sales_intake_direct === true ? {
        sales_intake_direct: true, sales_sandbox: m.sales_sandbox === true, synthetic_test: m.synthetic_test === true,
        idempotency_key: typeof m.idempotency_key === "string" && /^[a-f0-9]{64}$/.test(m.idempotency_key) ? m.idempotency_key : null,
        access_expires_at: typeof m.access_expires_at === "string" && Number.isFinite(Date.parse(m.access_expires_at)) ? new Date(m.access_expires_at).toISOString() : null,
        ...(SALES_DIRECT_OFFERS[m.offer] && /^(?:CA150|RF480)-\d{8}-[0-9a-f]{6}$/.test(String(m.order_id || ""))
          ? { offer: m.offer, offer_class: SALES_DIRECT_OFFERS[m.offer].offer_class, price: SALES_DIRECT_OFFERS[m.offer].price, order_id: m.order_id } : {}),      } : {}) } : {};
  return actor && market && locale && lead_id ? { actor_user_id: actor, market, locale, lead_id, ...sales } : null;
}


// Kurzer, nicht-kryptografischer Fingerabdruck (FNV-1a) für den Duplikat-Schutz.
function fingerprint(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0001")) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const newId = () => "mr-" + (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

// Baut einen Auftrag ausschliesslich aus erlaubten Feldern. Liefert { request } oder { error }.
export function sanitizeMailRequest(input, { now = new Date(), requestedBy = "chris", meta = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Ungültiger Auftrag." };
  if ("attachments" in input || "attachment" in input) return { error: "Anhänge sind nicht erlaubt." };
  const unknown = Object.keys(input).filter((k) => !FIELDS.includes(k) && k !== "op");
  if (unknown.length) return { error: "Unbekannte Felder: " + unknown.slice(0, 5).join(", ") };
  const bad = findSensitiveKeys(input);
  if (bad.length) return { error: "Sensible Felder sind nicht erlaubt." };
  const L = MAIL_REQUEST_LIMITS;
  const recipient = typeof input.recipient === "string" ? input.recipient.trim().toLowerCase() : "";
  if (!recipient || recipient.length > L.recipientChars || /[\r\n,;]/.test(recipient) || !EMAIL_RE.test(recipient)) return { error: "Empfänger ungültig (genau eine E-Mail-Adresse)." };
  if (input.delivery !== undefined && !DELIVERIES.includes(input.delivery)) return { error: "delivery ungültig (send, draft oder send_prepared)." };
  const manualTest = input.manual_test === true;
  if (manualTest && !isManualTestMail(input)) return { error: "MANUAL_TEST-Auftrag ist nicht exakt an den autorisierten Praxis-Kälin-Test gebunden." };
  if (!manualTest && (input.manual_test !== undefined || input.manual_test_lead_id !== undefined)) return { error: "MANUAL_TEST-Felder sind nur für den gebundenen Testauftrag erlaubt." };
  const prepared = input.delivery === "send_prepared";
  // send_prepared: nie Betreff/Text aus der Cloud – gesendet wird ausschliesslich der vorbereitete Entwurf (draft_ref) des Leads aus den Metadaten.
  if (prepared && (input.subject || input.body || input.optional_thread_reference)) return { error: "send_prepared: kein Betreff, kein Text, kein Thread." };
  if (prepared && (!DRAFT_REF_RE.test(String(input.draft_ref || "")) || !cleanMeta(meta))) return { error: "send_prepared: Entwurfsreferenz oder Lead fehlt." };
  if (!prepared && input.draft_ref !== undefined) return { error: "draft_ref nur mit send_prepared." };
  const subject = prepared ? "" : typeof input.subject === "string" ? input.subject.replace(CONTROL, "").replace(/[\r\n]+/g, " ").trim() : "";
  if (!prepared && (!subject || subject.length > L.subjectChars)) return { error: `Betreff fehlt oder ist länger als ${L.subjectChars} Zeichen.` };
  const body = prepared ? "" : typeof input.body === "string" ? input.body.replace(/\r\n/g, "\n").replace(CONTROL, "").trim() : "";
  if (!prepared && (!body || body.length > L.bodyChars)) return { error: `Text fehlt oder ist länger als ${L.bodyChars} Zeichen.` };
  const ref = input.optional_thread_reference ?? null;
  if (ref !== null && !(typeof ref === "string" && /^[a-f0-9]{12}$/.test(ref))) return { error: "Thread-Referenz ungültig." };
  if (input.request_id !== undefined && !(typeof input.request_id === "string" && ID_RE.test(input.request_id))) return { error: "request_id ungültig." };
  const delivery = DELIVERIES.includes(input.delivery) ? input.delivery : "send";
  const ttl = Math.min(L.maxTtlHours, Math.max(1, Number(input.ttl_hours) || L.ttlHours));
  const created = now.toISOString();
  const safeMeta = cleanMeta(meta);
  const directSales = safeMeta?.sales_intake_direct === true && typeof safeMeta.idempotency_key === "string";
  return {
    request: {
      request_id: input.request_id || newId(), created_at: created, expires_at: new Date(+now + ttl * 3_600_000).toISOString(),
      requested_by: requestedBy, recipient, subject, body, optional_thread_reference: ref,
      intent: INTENTS.includes(input.intent) ? input.intent : "sales", status: "pending", reason: null, updated_at: created,
      fingerprint: prepared ? fingerprint(recipient, "send_prepared", safeMeta.lead_id, input.draft_ref) : directSales
        ? fingerprint("sales_intake_direct", safeMeta.idempotency_key)
        : fingerprint(recipient, subject.toLowerCase(), body, ...(delivery === "draft" ? ["draft"] : []), ...(manualTest ? ["manual_test", MANUAL_TEST_MAIL.lead_id] : [])),
      mail_class: "manual_chris_mail", delivery, lease_owner: null, lease_expires_at: null, attempts: 0, ...(safeMeta ? { meta: safeMeta } : {}),
      ...(manualTest ? { manual_test: true, manual_test_lead_id: MANUAL_TEST_MAIL.lead_id } : {}),
      ...(prepared ? { draft_ref: input.draft_ref } : {}),
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
    mail_class: "manual_chris_mail", delivery: DELIVERIES.includes(r.delivery) ? r.delivery : "send", lease_owner: s(r.lease_owner, 20), lease_expires_at: s(r.lease_expires_at, 40), attempts: Number.isFinite(r.attempts) ? r.attempts : 0,
    ...(r.manual_test === true && r.manual_test_lead_id === MANUAL_TEST_MAIL.lead_id ? { manual_test: true, manual_test_lead_id: MANUAL_TEST_MAIL.lead_id } : {}),
    ...(cleanMeta(r.meta) ? { meta: cleanMeta(r.meta) } : {}), ...(r.delivery === "send_prepared" && DRAFT_REF_RE.test(r.draft_ref || "") ? { draft_ref: r.draft_ref } : {}),
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
export function addRequest(list, input, { now = new Date(), requestedBy, meta = null } = {}) {
  const { request, error } = sanitizeMailRequest(input, { now, requestedBy, meta });
  if (error) return { status: 400, error };
  const current = expireRequests(cleanList(list), now);
  const same = current.find((r) => r.request_id === request.request_id);
  if (same) return same.fingerprint === request.fingerprint ? { status: 200, list: current, request: same, duplicate: true } : { status: 409, error: "request_id bereits mit anderem Inhalt vergeben." };
  if (request.delivery === "send_prepared") {
    // TF-077B Idempotenz: derselbe Entwurf (Lead + draft_ref) hat höchstens EINEN offenen oder gesendeten Auftrag – Doppelklick/Wiederholung
    // liefert ihn zurück. Nach einem Fehlschlag ist ein neuer Versuch erlaubt (begrenzt); der Worker sendet nur einen noch unversendeten Entwurf.
    const same = current.filter((r) => r.fingerprint === request.fingerprint);
    const live = same.find((r) => OPEN_OR_SENT.includes(r.status));
    if (live) return { status: 200, list: current, request: live, duplicate: true };
    if (same.length >= SEND_PREPARED_MAX_ATTEMPTS) return { status: 429, error: "Zu viele Sendeversuche für diesen Entwurf – bitte Chris informieren.", code: "SEND_RETRY_LIMIT" };
  } else {
    const since = new Date(+now - MAIL_REQUEST_LIMITS.duplicateHours * 3_600_000).toISOString();
    const dup = current.find((r) => r.fingerprint === request.fingerprint && r.created_at >= since && ["pending", "processing", "accepted_local", "sent", "drafted"].includes(r.status));
    if (dup) return { status: 200, list: current, request: dup, duplicate: true };
  }
  if (current.filter((r) => r.status === "pending").length >= MAIL_REQUEST_LIMITS.pending) return { status: 429, error: "Zu viele offene Mailaufträge – erst den lokalen Worker abarbeiten lassen." };
  return { status: 201, list: trim([...current, request]), request, duplicate: false };
}

const ALLOWED_TRANSITIONS = { pending: ["processing", "accepted_local", "blocked", "sent", "drafted", "failed", "expired"], processing: ["accepted_local", "blocked", "sent", "drafted", "failed", "expired"],
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
const STAT_FIELDS = ["sent_today", "campaign_morning", "campaign_afternoon", "campaign_today", "replies_today", "manual_today", "blocked_today", "escalations_today", "ai_paused", "mail_degraded"];
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
    // TF-037: Mail-Lesepfad gedrosselt (Quota-Backoff) → Mail DEGRADED, der Core bleibt ONLINE.
    mail_health: hb?.at ? (s.mail_degraded ? "degraded" : "ok") : null,
    sales: { morning: s.campaign_morning || 0, afternoon: s.campaign_afternoon || 0, today: s.campaign_today || 0, window_limit: 50, daily_limit: 100 },
    // Cloud Core (gleicher Prozess wie der Mail-Worker): Schema, Scheduler-Checkpoints, Discovery, Backup – nur Whitelist-Felder.
    core: hb?.core ? cleanCore(hb.core) : null,
  };
}

// Sicht für den Browser: kein Fingerabdruck, kein Lease-Inhaber, Text gekürzt.
export const publicView = (r) => ({ request_id: r.request_id, created_at: r.created_at, expires_at: r.expires_at, recipient: r.recipient, subject: r.subject,
  intent: r.intent, mail_class: r.mail_class || "manual_chris_mail", delivery: r.delivery || "send", status: r.status, reason: r.reason, updated_at: r.updated_at, optional_thread_reference: r.optional_thread_reference,
  ...(r.manual_test === true && r.manual_test_lead_id === MANUAL_TEST_MAIL.lead_id ? { manual_test: true, manual_test_lead_id: MANUAL_TEST_MAIL.lead_id } : {}),
  ...(r.delivery === "send_prepared" ? { lead_id: r.meta?.lead_id || null, draft_ref: r.draft_ref || null } : {}),
  ...(r.delivery === "sales_intake" ? { lead_id: r.meta?.lead_id || null, sales_intake_direct: r.meta?.sales_intake_direct === true } : {}) });
// TF-077B: Sicht eines Verkäufers auf seine eigenen Aufträge – ohne Empfängeradresse und Text.
const sellerView = (r) => ({ request_id: r.request_id, created_at: r.created_at, delivery: r.delivery || "send", status: r.status, reason: r.reason, updated_at: r.updated_at,
  lead_id: r.meta?.lead_id || null, ...(r.delivery === "send_prepared" ? { draft_ref: r.draft_ref || null } : {}),
  ...(r.delivery === "sales_intake" ? { sales_intake_direct: r.meta?.sales_intake_direct === true, offer: r.meta?.offer || null, order_id: r.meta?.order_id || null } : {}) });

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
    create: (input, requestedBy = "chris", meta = null) => mutate(({ requests }) => addRequest(requests, input, { now: now(), requestedBy, meta })),
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
//
// TF-063 (resolveActor/resolveLead): Browser-Benutzer per Session. Nur der OWNER legt freie Mailaufträge an und sieht die Warteschlange.
// Verkäufer: ausschliesslich op "lead_draft" { lead_id, subject, body } für einen VN-Lead IM EIGENEN SCOPE – der Empfänger wird
// serverseitig aus diesem Lead aufgelöst (ein mitgeschickter recipient wird abgelehnt), immer delivery "draft" (COLD_LEAD_DRAFT_ONLY,
// nie Versand). DNC/Opt-out/Suppression → abgelehnt (der Mail-Worker prüft Suppression zusätzlich). GET: nur eigene Entwurfsaufträge.
export const LEAD_DRAFT_FIELDS = Object.freeze(["op", "lead_id", "subject", "body"]);
export function createMailRequestHandler({ getStore, env, now = () => new Date(), resolveActor = null, resolveLead = null }) {
  // TF-070: Aufträge des Kontos «lap» gehören Kudoshin (requested_by + Metadaten) – einmal je Instanz, idempotent.
  const migrateIdentity = migrateOnce(async () => migrateStoreDoc(await getStore(), migrateMailQueue));
  return async (req) => {
    await migrateIdentity();
    const syncToken = env("JARVIS_SYNC_TOKEN"), password = env("JARVIS_PASSWORD"), workerToken = env("JARVIS_MAIL_WORKER_TOKEN");
    const dedicated = !!workerToken;
    const isWorker = dedicated && safeEqual(req.headers.get("x-jarvis-worker"), workerToken);
    const isLocal = !!syncToken && safeEqual(req.headers.get("x-jarvis-sync"), syncToken);
    let isUser = false, actor = null;
    if (!isWorker && !isLocal) {
      if (resolveActor) {
        const a = await resolveActor(req);
        if (!a.actor) return reply(a.status || 401, { error: a.error || "Nicht berechtigt.", ...(a.code ? { code: a.code } : {}) });
        actor = a.actor; isUser = actor.role === "OWNER";
      } else isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    }
    if (!isWorker && !isLocal && !isUser && !actor) return reply(401, { error: "Nicht berechtigt." });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    if (actor && !isUser) return sellerRequest(req, actor);
    if (isUser && req.method === "POST" && actor) {
      // OWNER darf ebenfalls lead_draft für VN-Leads nutzen (gleiche serverseitige Empfänger-Auflösung).
      const peek = await req.clone().json().catch(() => null);
      if (["lead_draft", "send_lead_draft", "sales_intake_preview", "sales_intake_confirm", "sales_intake_send"].includes(peek?.op)) return sellerRequest(req, actor);
    }
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
      if (input.delivery === "send_prepared") return reply(400, { error: "send_prepared nur über send_lead_draft.", code: "BAD_PARAMS" });
      const r = await queue.create(input);
      return r.status >= 400 ? reply(r.status, { error: r.error }) : reply(r.status, { request: publicView(r.request), duplicate: !!r.duplicate });
    }
    if (!["result", "claim", "lock", "unlock", "heartbeat"].includes(body.op)) return reply(400, { error: "Unbekannte Operation." });
    if (!owner) return reply(403, { error: "Kein send_authority: nur der zuständige Mail-Worker darf das.", authority });
    let r;
    if (body.op === "result") {
      if (!["processing", "accepted_local", "blocked", "sent", "drafted", "failed", "expired"].includes(body.status) || typeof body.request_id !== "string") return reply(400, { error: "Ungültiges Ergebnis." });
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

  async function sellerRequest(req, actor) {
    const queue = createMailQueue(await getStore(), { now, dedicated: !!env("JARVIS_MAIL_WORKER_TOKEN") });
    if (req.method === "GET") return reply(200, { requests: (await queue.list()).filter((r) => r.requested_by === actor.user_id).map(sellerView).slice(-50) });
    let body;
    try { body = JSON.parse((await req.text()).slice(0, MAIL_REQUEST_LIMITS.bodyBytes) || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    if (body?.op === "send_lead_draft") return sendPrepared(queue, body, actor);
    if (body?.op === "sales_intake_preview") return salesPreview(body, actor);
    if (body?.op === "sales_intake_confirm") return salesConfirm(queue, body, actor);
    if (body?.op === "sales_intake_send") return salesSend(queue, body, actor);
    if (body?.op !== "lead_draft") return reply(403, { error: "Keine Berechtigung für diese Aktion.", code: "FORBIDDEN" });
    if (Object.keys(body).some((k) => !LEAD_DRAFT_FIELDS.includes(k))) return reply(400, { error: "Nur lead_id, subject und body sind erlaubt (kein Empfänger).", code: "BAD_PARAMS" });
    // TF-077: Entwürfe entstehen im einzigen verbundenen Gmail (Chris) – Verkäufer ohne eigene verbundene Mailbox nie (kein Fallback auf Chris).
    const mail = mailAccessFor(actor);
    if (!mail.draft_requests) return reply(403, { error: mail.mode === "OWN_MAILBOX" ? `Mailbox ${mail.mailbox} ist nicht verbunden – kein Entwurf.` : "Mail-Aktionen sind für dieses Konto deaktiviert.",
      code: mail.mode === "SERVER_SEND" ? "FORBIDDEN" : mail.state, ...(mail.mailbox ? { mailbox: mail.mailbox, connect_path: mail.connect_path || null } : {}) });
    if (!resolveLead) return reply(403, { error: "Keine Berechtigung.", code: "FORBIDDEN" });
    const found = await resolveLead(actor, body.lead_id);
    if (!found?.lead) return reply(found?.status || 403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: found?.code || "OUT_OF_SCOPE" });
    const lead = found.lead;
    if (lead.market !== "VN") return reply(403, { error: "Entwürfe über diesen Weg nur für Vietnam-Leads.", code: "FORBIDDEN" });
    if (lead.do_not_contact) return reply(409, { error: "Do Not Contact – kein Entwurf.", code: "DO_NOT_CONTACT" });
    if (!lead.email) return reply(400, { error: "Keine E-Mail-Adresse für diesen Lead.", code: "NO_EMAIL" });
    // TF-064: Metadaten nur aus Session (actor) + autorisiertem Lead (market, lead_id) – der Mail-Worker wählt damit das VN-Profil.
    const meta = { actor_user_id: actor.user_id, market: lead.market === "VN" ? "VN" : "CH", locale: lead.market === "VN" ? "vi-VN" : actor.locale, lead_id: lead.lead_id };
    const r = await queue.create({ recipient: lead.email, subject: body.subject, body: body.body, intent: "sales", delivery: "draft" }, actor.user_id, meta);
    return r.status >= 400 ? reply(r.status, { error: r.error, code: "BAD_PARAMS" }) : reply(r.status, { request: { request_id: r.request.request_id, status: r.request.status, delivery: "draft", lead_id: lead.lead_id }, duplicate: !!r.duplicate });
  }

  async function salesPreview(body, actor) {
    const mail = mailAccessFor(actor);
    if (!mail.send_prepared && actor.role !== "OWNER") return reply(403, { error: "Keine Berechtigung für den Erstmail-Versand.", code: "FORBIDDEN" });
    if (Object.keys(body).some((k) => !["op", "lead_id"].includes(k)) || typeof body.lead_id !== "string") return reply(400, { error: "Nur lead_id ist erlaubt.", code: "BAD_PARAMS" });
    if (!resolveLead) return reply(403, { error: "Keine Berechtigung.", code: "FORBIDDEN" });
    const found = await resolveLead(actor, body.lead_id);
    if (!found?.lead) return reply(found?.status || 403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: found?.code || "OUT_OF_SCOPE" });
    const lead = found.lead;
    if (lead.market === "VN") return reply(403, { error: "Die Erstmail ist nur für Schweizer Leads verfügbar.", code: "FORBIDDEN" });
    const refs = salesOrderRefs(lead.lead_id, now());
    const origin = env("JARVIS_WEB_ORIGIN");
    const vault = salesVaultLink({ origin, leadId: lead.lead_id, orderId: refs.order480Id, secret: env("JARVIS_SALES_VAULT_SECRET") });
    const result = buildSalesIntakePreview({ lead, ...refs, vaultLink: vault, now: now() });
    if (!result.ok) return reply(result.code === "NO_CONTACT_PERMISSION" ? 403 : 409, { error: result.reason, code: result.code });
    return reply(200, { preview_ref: result.preview_ref, preview: result.preview });
  }

  async function salesConfirm(queue, body, actor) {
    const mail = mailAccessFor(actor);
    if (!mail.send_prepared && actor.role !== "OWNER") return reply(403, { error: "Keine Berechtigung für den Erstmail-Versand.", code: "FORBIDDEN" });
    if (Object.keys(body).some((k) => !["op", "lead_id", "preview_ref", "confirmed"].includes(k)) || body.confirmed !== true || !/^[a-f0-9]{64}$/.test(String(body.preview_ref || "")))
      return reply(400, { error: "Ausdrückliche Bestätigung und gültige Vorschau-Referenz fehlen.", code: "CONFIRMATION_REQUIRED" });
    if (!resolveLead) return reply(403, { error: "Keine Berechtigung.", code: "FORBIDDEN" });
    const found = await resolveLead(actor, body.lead_id);
    if (!found?.lead) return reply(found?.status || 403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: found?.code || "OUT_OF_SCOPE" });
    const lead = found.lead, refs = salesOrderRefs(lead.lead_id, now());
    const vault = salesVaultLink({ origin: env("JARVIS_WEB_ORIGIN"), leadId: lead.lead_id, orderId: refs.order480Id, secret: env("JARVIS_SALES_VAULT_SECRET") });
    const result = buildSalesIntakePreview({ lead, ...refs, vaultLink: vault, now: now() });
    if (!result.ok || result.preview_ref !== body.preview_ref) return reply(409, { error: "Die Vorschau ist abgelaufen oder wurde geändert. Bitte neu laden.", code: "PREVIEW_CHANGED" });
    const meta = { actor_user_id: actor.user_id, market: "CH", locale: "de-CH", lead_id: lead.lead_id, sales_intake: true, preview_ref: result.preview_ref, order150_id: refs.order150Id, order480_id: refs.order480Id };
    return queueCrmClick(queue, { recipient: result.preview.recipient, subject: result.preview.subject, body: result.preview.body }, actor, meta, lead);
  }

  // TF-040: Nur diese beiden CRM-Klick-Wege (nach Session, Recht und Lead-Bereich) stellen einen Klick-Beleg aus. Signiert wird der bereinigte Auftrag,
  // also genau das, was der Mail-Worker später erhält. Ein Doppelklick liefert über den Duplikat-Schutz den ersten Auftrag zurück.
  async function queueCrmClick(queue, mail, actor, meta, lead) {
    const secret = env("JARVIS_MAIL_WORKER_TOKEN");
    if (!secret) return reply(503, { error: "CRM-Versand ist nicht eingerichtet.", code: "CRM_CLICK_UNAVAILABLE" });
    const input = { ...mail, request_id: newId(), intent: "sales", delivery: "sales_intake" };
    const { request, error } = sanitizeMailRequest(input, { now: now(), requestedBy: actor.user_id, meta });
    if (error) return reply(400, { error, code: "QUEUE_ERROR" });
    const r = await queue.create(input, actor.user_id, { ...meta, click_attestation: signCrmClick(secret, request) });
    if (r.status >= 400) return reply(r.status, { error: r.error, code: r.code || "QUEUE_ERROR" });
    return reply(r.status, { request: { request_id: r.request.request_id, status: r.request.status, delivery: "sales_intake", lead_id: lead.lead_id }, duplicate: !!r.duplicate });
  }

  async function salesSend(queue, body, actor) {
    const mail = mailAccessFor(actor);
    if (!mail.send_prepared && actor.role !== "OWNER") return reply(403, { error: "Keine Berechtigung für den Erstmail-Versand.", code: "FORBIDDEN" });
    if (Object.keys(body).some((k) => !["op", "lead_id", "offer"].includes(k)) || typeof body.lead_id !== "string") return reply(400, { error: "Nur lead_id und optional offer sind erlaubt.", code: "BAD_PARAMS" });
    if (body.offer !== undefined && (typeof body.offer !== "string" || !SALES_DIRECT_OFFERS[body.offer])) return reply(400, { error: "Ein zulässiges Paket (CHF150 oder CHF480) ist erforderlich.", code: "UNSUPPORTED_OFFER" });
    if (!resolveLead) return reply(403, { error: "Keine Berechtigung.", code: "FORBIDDEN" });
    const found = await resolveLead(actor, body.lead_id);
    if (!found?.lead) return reply(found?.status || 403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: found?.code || "OUT_OF_SCOPE" });
    const lead = found.lead;
    if (lead.market === "VN") return reply(403, { error: "Die Erstmail ist nur für Schweizer Leads verfügbar.", code: "FORBIDDEN" });
    // Der neue direkte Weg darf bis zur separaten Produktionsfreigabe niemals einen realen Empfänger erreichen.
    if (env("JARVIS_SALES_SANDBOX_MODE") !== "true") return reply(403, { error: "Direkter Erstmail-Versand ist bis zur Produktionsfreigabe gesperrt.", code: "SANDBOX_ONLY" });
    if (lead.is_test !== true) return reply(403, { error: "Direkter Erstmail-Versand ist nur für synthetische Leads zulässig.", code: "SYNTHETIC_ONLY" });
    const t = now();
    // TF-044: Nur CHF 150 des autorisierten Test-Leads: Jeder eindeutig fehlgeschlagene Versuch des Tages ergibt beim nächsten Klick neue Auftrags- und Bundle-IDs.
    let attempt = 0;
    if (body.offer === "CHF150" && lead.lead_id === MANUAL_TEST_MAIL.lead_id) {
      const dayPrefix = `CA150-${t.toISOString().slice(0, 10).replace(/-/g, "")}-`;
      const failed = (await queue.list()).filter((r) => r.delivery === "sales_intake" && r.status === "failed" && r.meta?.sales_intake_direct === true && r.meta.lead_id === lead.lead_id && r.meta.offer === "CHF150" && String(r.meta.order_id).startsWith(dayPrefix));
      if (failed.some((r) => r.reason !== SALES_SEND_FAILED_REASON)) return reply(409, { error: "Versandstatus unklar – kein neuer Versuch, Chris prüft.", code: "SEND_STATUS_UNCLEAR" });
      attempt = failed.length;
    }
    const refs = salesOrderRefs(attempt ? `${lead.lead_id}#${attempt}` : lead.lead_id, t), token = newIntakeToken({ now: t });
    const result = buildSalesIntakeMail({ lead, ...refs, offer: body.offer, accessToken: token.token, accessExpiresAt: token.expires_at, accessOrigin: env("JARVIS_WEB_ORIGIN"), sandbox: true, now: t });
    if (!result.ok) return reply(result.code === "NO_CONTACT_PERMISSION" ? 403 : 409, { error: result.reason, code: result.code });
    const idempotency_key = crypto.createHash("sha256").update(`sales_intake_direct:${lead.lead_id}:${body.offer || "bundle"}:${t.toISOString().slice(0, 10)}${attempt ? `:${attempt}` : ""}`).digest("hex");
    const meta = { actor_user_id: actor.user_id, market: "CH", locale: "de-CH", lead_id: lead.lead_id, sales_intake: true, sales_intake_direct: true,
      sales_sandbox: true, synthetic_test: true, idempotency_key, preview_ref: result.preview_ref, access_expires_at: result.mail.access_expires_at,
      ...(result.mail.offer ? { offer: result.mail.offer, offer_class: result.mail.offer_class, price: result.mail.price, order_id: result.mail.order_id,
        [result.mail.offer === "CHF150" ? "order150_id" : "order480_id"]: result.mail.order_id } : { order150_id: refs.order150Id, order480_id: refs.order480Id }) };
    return queueCrmClick(queue, { recipient: result.mail.recipient, subject: result.mail.subject, body: result.mail.body }, actor, meta, lead);
  }

  // TF-077B «E-Mail lossenden» (SEND_PREPARED_LEAD_DRAFT): nur lead_id + draft_ref vom Browser. Geprüft: Recht (Giuliano/Mario/Damiano, Owner),
  // Lead im eigenen Bereich, CH-Markt, Adresse aus dem CRM, kein DNC/Opt-out/Suppression, Entwurf offen und GENAU der angezeigte (draft_ref),
  // Tageslimit je Verkäufer. Der Mail-Worker prüft Besitz, Empfänger, Suppression und DNC vor dem Senden erneut und sendet genau einmal.
  async function sendPrepared(queue, body, actor) {
    const mail = mailAccessFor(actor);
    if (!mail.send_prepared && actor.role !== "OWNER") return reply(403, { error: mail.mode === "OWN_MAILBOX" ? `Mailbox ${mail.mailbox} ist nicht verbunden – kein Versand.` : "Keine Berechtigung für diese Aktion.",
      code: mail.mode === "OWN_MAILBOX" ? mail.state : "FORBIDDEN" });
    if (Object.keys(body).some((k) => !SEND_FIELDS.includes(k))) return reply(400, { error: "Nur lead_id und draft_ref sind erlaubt (kein Empfänger, kein Text).", code: "BAD_PARAMS" });
    if (!DRAFT_REF_RE.test(String(body.draft_ref || ""))) return reply(400, { error: "Entwurfsreferenz ungültig.", code: "BAD_PARAMS" });
    if (!resolveLead) return reply(403, { error: "Keine Berechtigung.", code: "FORBIDDEN" });
    const found = await resolveLead(actor, body.lead_id);
    if (!found?.lead) return reply(found?.status || 403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: found?.code || "OUT_OF_SCOPE" });
    const lead = found.lead;
    if (lead.market === "VN") return reply(403, { error: "Vietnam-Leads werden nicht über das Jarvis-Postfach gesendet.", code: "FORBIDDEN" });
    if (lead.do_not_contact) return reply(409, { error: "Do Not Contact – kein Versand.", code: "DO_NOT_CONTACT" });
    if (!lead.email) return reply(400, { error: "Keine E-Mail-Adresse für diesen Lead.", code: "NO_EMAIL" });
    const ref = draftRefOf(lead);
    if (!ref) return reply(409, { error: "Für diesen Lead liegt kein vorbereiteter Entwurf (mehr) bereit.", code: "NO_PREPARED_DRAFT" });
    if (ref !== body.draft_ref) return reply(409, { error: "Der Entwurf wurde inzwischen geändert – bitte neu laden.", code: "DRAFT_CHANGED" });
    const day = (v) => String(v || "").slice(0, 10), today = day(now().toISOString());
    const mine = new Set((await queue.list()).filter((r) => r.delivery === "send_prepared" && r.requested_by === actor.user_id && day(r.created_at) === today).map((r) => r.meta?.lead_id));
    mine.delete(lead.lead_id); // Wiederholung für denselben Lead zählt nicht doppelt
    if (actor.role !== "OWNER" && mine.size >= SELLER_SEND_DAILY_LIMIT) return reply(429, { error: `Tageslimit von ${SELLER_SEND_DAILY_LIMIT} Sendungen erreicht.`, code: "SEND_DAILY_LIMIT" });
    const meta = { actor_user_id: actor.user_id, market: "CH", locale: "de-CH", lead_id: lead.lead_id };
    const r = await queue.create({ recipient: lead.email, intent: "sales", delivery: "send_prepared", draft_ref: ref }, actor.user_id, meta);
    if (r.status >= 400) return reply(r.status, { error: r.error, code: r.code || "BAD_PARAMS" });
    return reply(r.status, { request: { request_id: r.request.request_id, status: r.request.status, delivery: "send_prepared", lead_id: lead.lead_id, draft_ref: ref }, duplicate: !!r.duplicate });
  }
}
export const SEND_FIELDS = Object.freeze(["op", "lead_id", "draft_ref"]);

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
