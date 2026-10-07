// Gemeinsamer, sicherer Jarvis-Zustand für Lokal- und Cloud-Modus („safe shared state“).
// Bewusst ohne Node-Abhängigkeiten: läuft lokal (Node) und auf Netlify (Functions/Edge).
//
// Enthält nur: Persona-Version, sichere Präferenzen/Notizen, begrenzten Gesprächsverlauf, Jarvis-Benachrichtigungen,
// Business-Status (Worker, Tageszähler, Discovery) und Sync-Infos. Niemals: Tokens, Zugangsdaten, Gmail-Register,
// Thread-/Message-IDs, Lead-Datenbank, Suppression-Liste, vollständige E-Mail-Inhalte, lokale Pfade.
// Alles wird über eine Whitelist neu aufgebaut – unbekannte Felder fallen weg, sensible Feldnamen werden abgelehnt.

export const LIMITS = { notifications: 50, tombstones: 500, tombstoneDays: 180, turns: 12, turnChars: 600, summaryChars: 200, nameChars: 80, notesChars: 2000, turnsPerWrite: 4, bodyBytes: 64_000 };
export const NOTIFICATION_TYPES = ["human_contact_requested", "call_requested", "mail_escalation", "ai_budget_exhausted", "info"];

// Feldnamen, die nie in den gemeinsamen Zustand gehören.
const SENSITIVE_KEY = /token|secret|passw|kennwort|credential|api[-_]?key|private[-_]?key|refresh|authori[sz]ation|cookie|oauth|client[-_]?id|^(thread|message)[-_]?id$|^(rfc)?message[-_]?id$|registry|^suppression$|^leads$|^drafts$|^sent$|^path$|^file$/i;
// Werte, die wie Geheimnisse aussehen, werden geschwärzt.
const SECRET_VALUE = /(sk-ant-[\w-]{8,}|sk-[A-Za-z0-9]{20,}|ya29\.[\w.-]{10,}|1\/\/0[\w-]{20,}|GOCSPX-[\w-]+|AIza[\w-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)|xox[abprs]-[\w-]+|gh[pousr]_\w{20,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+)/g;
const SECRET_PHRASE = /\b(passwort|password|kennwort|pw|pin|token|api[- ]?key)\b(\s*(?:ist|lautet|is|[:=]))\s*\S+/gi;
const LOCAL_PATH = /\b[A-Z]:\\[^\s"']+|\/(?:Users|home)\/[^\s"']+/g;

export const redact = (s) => String(s).replace(SECRET_VALUE, "[entfernt]").replace(SECRET_PHRASE, "$1$2 [entfernt]").replace(LOCAL_PATH, "[Pfad]");
const str = (v, n) => (typeof v === "string" ? redact(v).replace(/\s+/g, " ").trim().slice(0, n) : "");
const text = (v, n) => (typeof v === "string" ? redact(v).trim().slice(0, n) : "");
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const num = (v, max = 1e9) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const newer = (a, b) => (Date.parse(a || 0) || 0) >= (Date.parse(b || 0) || 0);

// Liefert die Pfade aller verbotenen Feldnamen (rekursiv).
export function findSensitiveKeys(obj, prefix = "") {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj).flatMap(([k, v]) => [...(SENSITIVE_KEY.test(k) ? [prefix + k] : []), ...findSensitiveKeys(v, `${prefix}${k}.`)]);
}

export function emptyState() {
  return { version: 1, updatedAt: null, personaVersion: null, mode: { last: null, at: null }, profile: { notes: "", updatedAt: null },
    conversation: { turns: [], updatedAt: null, resetAt: null }, notifications: [], dismissed: emptyDismissed(), business: null, sales: null, sync: { lastLocalPushAt: null } };
}

// ---------- Erledigte Meldungen (Tombstones) ----------
// Eine erledigte Meldung wird nicht einfach gelöscht, sondern ihre ID als Tombstone gemerkt – sonst brächte der nächste
// Abgleich sie von der anderen Seite zurück. Tombstones sind begrenzt (Anzahl und Alter); was dabei wegfällt, deckt
// „before“ ab: Meldungen, die vor diesem Zeitpunkt entstanden sind, gelten als erledigt. So kann keine Meldung auferstehen.
export const emptyDismissed = () => ({ ids: [], before: null });
const ID_RE = /^[a-z0-9-]{4,64}$/;

export function pruneDismissed(d = emptyDismissed(), now = new Date()) {
  const byId = new Map();
  for (const x of Array.isArray(d?.ids) ? d.ids : []) {
    const at = iso(x?.at);
    if (!x || typeof x.id !== "string" || !ID_RE.test(x.id) || !at) continue;
    const prev = byId.get(x.id);
    if (!prev || at < prev.at) byId.set(x.id, { id: x.id, at }); // früheste Erledigung zählt
  }
  let before = iso(d?.before);
  const horizon = new Date(+now - LIMITS.tombstoneDays * 86_400_000).toISOString();
  const sorted = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const keep = sorted.filter((x) => x.at >= horizon).slice(-LIMITS.tombstones);
  const dropped = sorted.filter((x) => !keep.includes(x));
  if (dropped.length) {
    const last = dropped.at(-1).at;
    if (!before || last > before) before = last;
  }
  return { ids: keep, before };
}

export function mergeDismissed(a, b, now = new Date()) {
  const before = [iso(a?.before), iso(b?.before)].filter(Boolean).sort().at(-1) || null;
  return pruneDismissed({ ids: [...(a?.ids || []), ...(b?.ids || [])], before }, now);
}

// Entfernt erledigte Meldungen (per ID oder per „before“) aus einer Liste.
export function withoutDismissed(list = [], d = emptyDismissed()) {
  const gone = new Set((d?.ids || []).map((x) => x.id));
  return list.filter((n) => n && !gone.has(n.id) && !(d?.before && n.createdAt && n.createdAt <= d.before));
}

export function addDismissed(d, id, at) {
  return mergeDismissed(d, { ids: [{ id, at }], before: null }, new Date(at));
}

export function sanitizeNotification(n) {
  if (!n || typeof n !== "object" || typeof n.id !== "string" || !ID_RE.test(n.id)) return null;
  const createdAt = iso(n.createdAt);
  if (!createdAt) return null;
  const status = oneOf(n.status, ["unread", "read"], "unread");
  return {
    id: n.id, type: oneOf(n.type, NOTIFICATION_TYPES, "info"), kind: oneOf(n.kind, ["call", "meeting", "person"], null),
    priority: oneOf(n.priority, ["high", "normal", "low"], "normal"), createdAt, updatedAt: iso(n.updatedAt) || createdAt,
    readAt: status === "read" ? iso(n.readAt) || iso(n.updatedAt) || createdAt : null,
    company: str(n.company, LIMITS.nameChars), contactName: str(n.contactName, LIMITS.nameChars),
    threadRef: typeof n.threadRef === "string" && /^[a-f0-9]{8,32}$/.test(n.threadRef) ? n.threadRef : null,
    summary: str(n.summary, LIMITS.summaryChars), status,
  };
}

export function sanitizeTurn(t) {
  if (!t || !["user", "assistant"].includes(t.role)) return null;
  const content = text(t.content, LIMITS.turnChars);
  const at = iso(t.at);
  if (!content || !at) return null;
  return { role: t.role, content, at, source: oneOf(t.source, ["local", "cloud"], "cloud") };
}

// Vertriebszahlen: nur Zähler und CHF-Summen der zwei Angebote – keine Firmen, Adressen oder Befunde.
export const SALES_FIELDS = ["discovered", "audited", "qualified_repair", "offer_150_candidates", "offer_500_candidates", "eligible_to_contact",
  "blocked_no_legal_basis", "contacted", "replies", "customers", "sales_150", "sales_500", "revenue_150", "revenue_500", "total_revenue"];
export function sanitizeSales(x) {
  if (!x || typeof x !== "object") return null;
  const out = { updatedAt: iso(x.updatedAt) };
  for (const k of SALES_FIELDS) out[k] = num(x[k]);
  return out;
}

// Versandlimits (wie mail-worker.js/gmail.js): 100 erfolgreiche Sends pro Tag, je 50 im Morgen- und Nachmittagsfenster.
const DAILY_LIMIT = 100, WINDOW_LIMIT = 50, WINDOW_IDS = ["morning", "afternoon"];
function sanitizeBusiness(b) {
  if (!b || typeof b !== "object") return null;
  const w = b.worker || {}, d = b.discovery || {};
  return {
    updatedAt: iso(b.updatedAt),
    worker: { online: w.online === true, lastCycle: iso(w.lastCycle), todaySent: num(w.todaySent, DAILY_LIMIT), limit: num(w.limit, DAILY_LIMIT), capacity: num(w.capacity, DAILY_LIMIT),
      autoSend: w.autoSend === true, eligibleLeads: num(w.eligibleLeads), optOuts: num(w.optOuts),
      windows: Object.fromEntries(WINDOW_IDS.map((id) => [id, { count: num(w.windows?.[id]?.count, WINDOW_LIMIT), limit: num(w.windows?.[id]?.limit, WINDOW_LIMIT), executed: w.windows?.[id]?.executed === true }])) },
    discovery: { lastRunAt: iso(d.lastRunAt), websitesFoundToday: num(d.websitesFoundToday), websitesWithIssuesToday: num(d.websitesWithIssuesToday),
      qualifiedLeads: num(d.qualifiedLeads), leadsWithoutLegalBasis: num(d.leadsWithoutLegalBasis), errorsToday: num(d.errorsToday) },
  };
}

// Baut den Zustand ausschliesslich aus erlaubten Feldern neu auf.
export function sanitizeState(s = {}) {
  const e = emptyState();
  if (!s || typeof s !== "object") return e;
  const conv = s.conversation || {};
  return {
    ...e,
    updatedAt: iso(s.updatedAt),
    personaVersion: typeof s.personaVersion === "string" && /^[a-f0-9]{6,64}$/.test(s.personaVersion) ? s.personaVersion : null,
    mode: { last: oneOf(s.mode?.last, ["local", "cloud"], null), at: iso(s.mode?.at) },
    profile: { notes: text(s.profile?.notes, LIMITS.notesChars), updatedAt: iso(s.profile?.updatedAt) },
    conversation: {
      turns: (Array.isArray(conv.turns) ? conv.turns : []).map(sanitizeTurn).filter(Boolean).slice(-LIMITS.turns),
      updatedAt: iso(conv.updatedAt), resetAt: iso(conv.resetAt),
    },
    dismissed: pruneDismissed(s.dismissed),
    notifications: withoutDismissed((Array.isArray(s.notifications) ? s.notifications : []).map(sanitizeNotification).filter(Boolean), pruneDismissed(s.dismissed)).slice(-LIMITS.notifications * 2),
    business: sanitizeBusiness(s.business),
    sales: sanitizeSales(s.sales),
    sync: { lastLocalPushAt: iso(s.sync?.lastLocalPushAt) },
  };
}

// ---------- Zusammenführen ----------

// Pro ID gewinnt der neuere Stand – aber „gelesen“ wird nie wieder zu „ungelesen“, und Erledigtes (Tombstone) nie wieder sichtbar.
// Felder, die nur eine Seite kennt (z. B. lokale Thread-ID), bleiben erhalten.
export function mergeNotifications(a = [], b = [], dismissed = emptyDismissed()) {
  const byId = new Map();
  for (const n of withoutDismissed([...a, ...b], dismissed)) {
    const prev = byId.get(n.id);
    if (!prev) { byId.set(n.id, { ...n }); continue; }
    const [older, newerOne] = newer(n.updatedAt, prev.updatedAt) ? [prev, n] : [n, prev];
    const merged = { ...older, ...newerOne };
    for (const k of Object.keys(older)) if (merged[k] === undefined || merged[k] === null) merged[k] = older[k];
    if (prev.status === "read" || n.status === "read") {
      merged.status = "read";
      merged.readAt = [prev.readAt, n.readAt].filter(Boolean).sort()[0] || merged.updatedAt;
    }
    merged.createdAt = [prev.createdAt, n.createdAt].sort()[0];
    byId.set(n.id, merged);
  }
  // Ungelesene zuerst behalten, dann die neuesten gelesenen
  const all = [...byId.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const unread = all.filter((n) => n.status === "unread");
  const read = all.filter((n) => n.status === "read").slice(-Math.max(0, LIMITS.notifications - unread.length));
  return [...read, ...unread].sort((x, y) => x.createdAt.localeCompare(y.createdAt)).slice(-LIMITS.notifications);
}

export function mergeConversation(a = {}, b = {}) {
  const resetAt = [a.resetAt, b.resetAt].filter(Boolean).sort().at(-1) || null;
  const seen = new Set(), turns = [];
  for (const t of [...(a.turns || []), ...(b.turns || [])].sort((x, y) => x.at.localeCompare(y.at))) {
    const key = `${t.at}|${t.role}|${t.content.slice(0, 80)}`;
    if (seen.has(key) || (resetAt && t.at <= resetAt)) continue;
    seen.add(key);
    turns.push(t);
  }
  return { turns: turns.slice(-LIMITS.turns), updatedAt: [a.updatedAt, b.updatedAt].filter(Boolean).sort().at(-1) || null, resetAt };
}

// base = gespeicherter Zustand, incoming = bereits bereinigter Teilzustand.
// Business-Status, Persona-Version und Notizen darf nur der lokale Kern (Sync-Token) setzen.
export function mergeState(base, incoming, { fromLocal = false } = {}) {
  const b = sanitizeState(base), i = sanitizeState(incoming);
  const out = { ...b };
  // Tombstones darf jede berechtigte Seite setzen (sie entfernen nur) – sie werden immer vereinigt.
  out.dismissed = mergeDismissed(b.dismissed, i.dismissed);
  out.notifications = mergeNotifications(b.notifications, i.notifications, out.dismissed);
  out.conversation = mergeConversation(b.conversation, i.conversation);
  if (i.mode.last && newer(i.mode.at, b.mode.at)) out.mode = i.mode;
  if (fromLocal) {
    if (i.business && newer(i.business.updatedAt, b.business?.updatedAt)) out.business = i.business;
    if (i.sales && newer(i.sales.updatedAt, b.sales?.updatedAt)) out.sales = i.sales;
    if (i.personaVersion) out.personaVersion = i.personaVersion;
    if (i.profile.updatedAt && newer(i.profile.updatedAt, b.profile.updatedAt)) out.profile = i.profile;
    out.sync = { lastLocalPushAt: i.sync.lastLocalPushAt || new Date().toISOString() };
  }
  return out;
}

// ---------- HTTP-Endpunkt /api/state (Netlify) ----------

// Vergleich in konstanter Zeit
export function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0 && a.length > 0;
}

// Adapter für Netlify Blobs (getStore aus @netlify/blobs) mit bedingtem Schreiben gegen gleichzeitige Änderungen.
export function netlifyBlobStore(blobs, key = "shared-state") {
  return {
    async get() { const r = await blobs.getWithMetadata(key, { type: "json" }); return { state: r?.data ?? null, etag: r?.etag ?? null }; },
    async set(state, etag) { const r = await blobs.setJSON(key, state, etag ? { onlyIfMatch: etag } : { onlyIfNew: true }); return r?.modified !== false; },
  };
}
// Einfacher Speicher für Tests und lokale Läufe
export function memoryStore(initial = null) {
  let state = initial, etag = initial ? "1" : null, n = 1;
  return { async get() { return { state: state && structuredClone(state), etag }; }, async set(s, tag) { if ((tag || null) !== etag) return false; state = structuredClone(s); etag = String(++n); return true; }, peek: () => state };
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Zwei Berechtigungen: x-jarvis-sync (JARVIS_SYNC_TOKEN, nur der lokale Kern) darf alles Erlaubte schreiben;
// x-jarvis-key (JARVIS_PASSWORD, Chris im Browser) darf nur lesen, als gelesen/erledigt markieren, Gesprächsverlauf und Modus setzen.
export function createStateHandler({ getStore, env, now = () => new Date() }) {
  return async (req) => {
    const syncToken = env("JARVIS_SYNC_TOKEN"), password = env("JARVIS_PASSWORD"), workerToken = env("JARVIS_MAIL_WORKER_TOKEN");
    // Der VPS-Mail-Worker synchronisiert mit seinem eigenen Token (gleiche Rechte wie der lokale Kern).
    const isLocal = (!!syncToken && safeEqual(req.headers.get("x-jarvis-sync"), syncToken)) || (!!workerToken && safeEqual(req.headers.get("x-jarvis-sync"), workerToken));
    const isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    if (req.method === "GET" && new URL(req.url).searchParams.has("probe")) return reply(200, { configured: !!syncToken });
    if (!isLocal && !isUser) return reply(401, { error: "Nicht berechtigt." });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    const store = await getStore();
    if (req.method === "GET") return reply(200, sanitizeState((await store.get()).state || emptyState()));

    if (Number(req.headers.get("content-length") || 0) > LIMITS.bodyBytes) return reply(413, { error: "Zu gross." });
    const raw = await req.text();
    if (raw.length > LIMITS.bodyBytes) return reply(413, { error: "Zu gross." });
    let body;
    try { body = JSON.parse(raw); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    if (!body || typeof body !== "object") return reply(400, { error: "Ungültige Anfrage." });
    const bad = findSensitiveKeys(body);
    if (bad.length) return reply(400, { error: "Sensible Felder sind nicht erlaubt: " + bad.slice(0, 5).join(", ") });

    const t = now().toISOString();
    let change;
    if (body.op === "sync") {
      if (!isLocal) return reply(403, { error: "Nur der lokale Jarvis-Kern darf synchronisieren." });
      change = (s) => mergeState(s, { ...body.state, sync: { lastLocalPushAt: t } }, { fromLocal: true });
    } else if (body.op === "read") {
      if (typeof body.id !== "string") return reply(400, { error: "id fehlt." });
      change = (s) => ({ ...s, notifications: s.notifications.map((n) => (n.id === body.id && n.status !== "read" ? { ...n, status: "read", readAt: t, updatedAt: t } : n)) });
    } else if (body.op === "dismiss") {
      if (typeof body.id !== "string" || !ID_RE.test(body.id)) return reply(400, { error: "id fehlt." });
      change = (s) => mergeState(s, { dismissed: { ids: [{ id: body.id, at: t }], before: null } });
    } else if (body.op === "conversation") {
      // Zeitstempel immer vom Server (Reihenfolge per Millisekunden-Versatz) – Client-Zeiten werden ignoriert.
      const turns = (Array.isArray(body.turns) ? body.turns : []).slice(0, LIMITS.turnsPerWrite).map((x, i) => ({ role: x?.role, content: x?.content, at: new Date(Date.parse(t) + i).toISOString(), source: isLocal ? "local" : "cloud" }));
      const conv = { turns, updatedAt: t, resetAt: body.reset === true ? t : null };
      change = (s) => mergeState(s, { conversation: conv, mode: { last: isLocal ? "local" : "cloud", at: t } });
    } else if (body.op === "mode") {
      change = (s) => mergeState(s, { mode: { last: body.mode, at: t } });
    } else return reply(400, { error: "Unbekannte Operation." });

    // Bedingt schreiben; bei gleichzeitiger Änderung neu lesen und erneut zusammenführen.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, etag } = await store.get();
      const next = sanitizeState({ ...change(sanitizeState(state || emptyState())), updatedAt: t });
      if (await store.set(next, etag)) return reply(200, next);
    }
    return reply(409, { error: "Gleichzeitige Änderung – bitte erneut versuchen." });
  };
}
