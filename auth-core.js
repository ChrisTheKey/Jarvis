// Jarvis Multi-User-Auth (TF-063) – gemeinsamer Kern OHNE Node-Abhängigkeiten (Netlify Functions, Edge Function, Tests).
// Benutzer, Rollen, Rechte, Session-Auflösung (Cookie → SHA-256-Hash → Session-Blob) und Origin-/CSRF-Prüfung.
// Passwort-Hashing (scrypt) liegt bewusst NUR in auth-api.js (Node) – hier wird nie ein Passwort verarbeitet.
//
// Speicher (Netlify Blobs "jarvis-auth"): "users" (aktiv, scrypt-Parameter/Salt/Hash, Zeitpunkte), "sessions" (nur SHA-256 des
// Tokens als Schlüssel), "limits" (fehlgeschlagene Logins), "audit". Niemals Klartext-Passwörter oder Session-Tokens.
//
// Legacy: x-jarvis-key = JARVIS_PASSWORD (Chris, konstant verglichen) gilt weiterhin als OWNER – nur für Chris' Skripte/Tests;
// die Oberfläche speichert das Passwort nicht mehr (kein localStorage, kein ?key= in URLs).
import { safeEqual, netlifyBlobStore } from "./shared-state.js";
import { VN_SELLER_ID } from "./seller-identity.js";

export const ROLES = Object.freeze(["OWNER", "SALES_MANAGER_CH", "SALES_AGENT_CH", "SALES_AGENT_VN"]);
export const LOCALES = Object.freeze(["de-CH", "vi-VN"]);
export const OWNER_ID = "chris";
// TF-070: Vietnam-Verkäufer «Kudoshin» (vormals «lap», siehe seller-identity.js) – «lap» ist kein Benutzer mehr.
export const SELLER_IDS = Object.freeze(["giuliano", "mario", "damiano", VN_SELLER_ID]);
// Feste Benutzer: Rolle, Sprache, Markt und Provisionssatz sind Code – nicht per API änderbar.
export const USERS = Object.freeze({
  chris: Object.freeze({ id: "chris", name: "Chris", role: "OWNER", locale: "de-CH", markets: Object.freeze(["CH", "VN"]), commission_rate_bps: 0 }),
  giuliano: Object.freeze({ id: "giuliano", name: "Giuliano", role: "SALES_MANAGER_CH", locale: "de-CH", markets: Object.freeze(["CH"]), commission_rate_bps: 3500 }),
  mario: Object.freeze({ id: "mario", name: "Mario", role: "SALES_AGENT_CH", locale: "de-CH", markets: Object.freeze(["CH"]), commission_rate_bps: 3500 }),
  damiano: Object.freeze({ id: "damiano", name: "Damiano", role: "SALES_AGENT_CH", locale: "de-CH", markets: Object.freeze(["CH"]), commission_rate_bps: 3500 }),
  [VN_SELLER_ID]: Object.freeze({ id: VN_SELLER_ID, name: "Kudoshin", role: "SALES_AGENT_VN", locale: "vi-VN", markets: Object.freeze(["VN"]), commission_rate_bps: 3500 }),
});
export const COOKIE = "jarvis_session";
export const SESSION_MAX_MS = 7 * 86_400_000;       // absolute Höchstdauer
export const SESSION_TOUCH_MS = 10 * 60_000;        // last_seen_at höchstens alle 10 min schreiben
export const MIN_PASSWORD = 12;

// Rechte je Rolle. Alles, was hier fehlt, ist verboten (deny by default).
const SELLER = ["crm.read", "crm.write", "crm.export", "commission.own", "chat.own", "draft.own_vn"];
export const PERMISSIONS = Object.freeze({
  OWNER: Object.freeze(["*"]),
  SALES_MANAGER_CH: Object.freeze(SELLER),
  SALES_AGENT_CH: Object.freeze(SELLER),
  SALES_AGENT_VN: Object.freeze(SELLER),
});
export const can = (actor, perm) => !!actor && (actor.role === "OWNER" || (PERMISSIONS[actor.role] || []).includes(perm));
export const isOwner = (actor) => actor?.role === "OWNER";

export function publicUser(id) {
  const u = USERS[id];
  return u ? { user_id: u.id, name: u.name, role: u.role, locale: u.locale, markets: [...u.markets], commission_rate_bps: u.commission_rate_bps } : null;
}
export const actorFor = (id, source = "session") => { const u = publicUser(id); return u ? { ...u, market: u.markets.length === 1 ? u.markets[0] : "ALL", source } : null; };
// Benutzername → kanonische ID (Gross/Klein egal, Anzeigename erlaubt: "Kudoshin"/"kudoshin" → "Kudoshin"). Unbekannt (auch "lap") → null.
const USER_BY_LOWER = new Map(Object.keys(USERS).map((id) => [id.toLowerCase(), id]));
export const userIdOf = (name) => USER_BY_LOWER.get(String(name || "").trim().toLowerCase()) ?? null;

// ---------- Cookies ----------
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k && !(k in out)) out[k] = v;
  }
  return out;
}
const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
export const sessionToken = (req) => { const t = parseCookies(req.headers.get("cookie"))[COOKIE]; return typeof t === "string" && TOKEN_RE.test(t) ? t : null; };
export function sessionCookie(token, { secure = true, maxAgeS = SESSION_MAX_MS / 1000 } = {}) {
  return `${COOKIE}=${token}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=${Math.floor(maxAgeS)}`;
}
export const clearCookie = ({ secure = true } = {}) => `${COOKIE}=; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Path=/; Max-Age=0`;
export const isHttps = (req) => { try { return new URL(req.url).protocol === "https:"; } catch { return true; } };

// SHA-256 (Web Crypto – Node 18+ und Deno/Edge).
export async function sha256Hex(s) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken(bytes = 32) {
  const a = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  let s = ""; for (const b of a) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- Origin / CSRF ----------
// Schreibende Requests mit Session-Cookie: Origin muss exakt der eigenen Herkunft entsprechen (bzw. Sec-Fetch-Site same-origin,
// wenn kein Origin mitkommt). Header-Auth (Legacy-Key, Agent-Tokens) ist nicht CSRF-fähig und braucht das nicht.
export function sameOrigin(req) {
  let self;
  try { self = new URL(req.url); } catch { return false; }
  const hosts = new Set([self.host, req.headers.get("x-forwarded-host"), req.headers.get("host")].filter(Boolean).map((h) => String(h).split(",")[0].trim().toLowerCase()));
  const origin = req.headers.get("origin");
  if (origin) { try { const o = new URL(origin); return hosts.has(o.host.toLowerCase()) && (o.protocol === self.protocol || o.protocol === "https:"); } catch { return false; } }
  return req.headers.get("sec-fetch-site") === "same-origin";
}
export const isWrite = (req) => !["GET", "HEAD", "OPTIONS"].includes(req.method);

// ---------- Session-Speicher ----------
export const emptyUsers = () => ({ schema: 1, users: {} });
export const emptySessions = () => ({ schema: 1, sessions: {} });
const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
export function userRecord(doc, id) {
  const r = doc?.users?.[id] || {};
  return { active: r.active !== false, password: r.password && typeof r.password === "object" ? r.password : null, password_set_at: iso(r.password_set_at),
    last_login_at: iso(r.last_login_at), sessions_revoked_at: iso(r.sessions_revoked_at), initialized_at: iso(r.initialized_at) };
}
export const sessionValid = (s, now) => !!s && Object.hasOwn(USERS, s.user_id) && Date.parse(s.expires_at) > +now && Date.parse(s.created_at) <= +now;

// Löst den Akteur eines Requests auf: Session-Cookie (bevorzugt) oder Legacy-Header (nur Chris). Ergebnis:
//   { actor, via: "session"|"legacy", token_hash? } oder { actor: null, status, error }
// Schreibende Cookie-Requests ohne gültigen Origin → 403 (CSRF). Deaktivierte Benutzer → 401.
export async function resolveActor(req, { env, getAuthStore, now = () => new Date(), touch = true } = {}) {
  const password = env?.("JARVIS_PASSWORD");
  if (password && req.headers.get("x-jarvis-key") != null) {
    return safeEqual(req.headers.get("x-jarvis-key"), password) ? { actor: actorFor(OWNER_ID, "legacy"), via: "legacy" } : { actor: null, status: 401, error: "Nicht berechtigt." };
  }
  const token = sessionToken(req);
  if (!token || !getAuthStore) return { actor: null, status: 401, error: "Nicht angemeldet." };
  if (isWrite(req) && !sameOrigin(req)) return { actor: null, status: 403, error: "Ungültige Herkunft (CSRF-Schutz).", code: "BAD_ORIGIN" };
  const store = await getAuthStore();
  const hash = await sha256Hex(token);
  const t = now();
  const { state: sess, etag } = await store.sessions.get();
  const s = sess?.sessions?.[hash];
  if (!sessionValid(s, t)) return { actor: null, status: 401, error: "Sitzung abgelaufen – bitte neu anmelden." };
  const { state: users } = await store.users.get();
  const u = userRecord(users, s.user_id);
  if (!u.active) return { actor: null, status: 401, error: "Zugang deaktiviert." };
  if (u.sessions_revoked_at && Date.parse(u.sessions_revoked_at) >= Date.parse(s.created_at)) return { actor: null, status: 401, error: "Sitzung beendet – bitte neu anmelden." };
  if (touch && +t - Date.parse(s.last_seen_at || s.created_at) > SESSION_TOUCH_MS) {
    // Best effort: nur last_seen_at; bei gleichzeitiger Änderung egal (nächster Request versucht es erneut).
    const next = { ...(sess || emptySessions()), sessions: { ...(sess?.sessions || {}), [hash]: { ...s, last_seen_at: t.toISOString() } } };
    await store.sessions.set(next, etag).catch(() => false);
  }
  return { actor: actorFor(s.user_id), via: "session", token_hash: hash };
}

// Netlify-Blobs-Adapter für die Auth-Daten (ein Store, mehrere Schlüssel, bedingtes Schreiben).
export function authStoreFrom(makeKeyStore) {
  return { users: makeKeyStore("users"), sessions: makeKeyStore("sessions"), limits: makeKeyStore("limits"), audit: makeKeyStore("audit") };
}
export async function netlifyAuthStore() {
  const { getStore } = await import("@netlify/blobs");
  const blobs = getStore({ name: "jarvis-auth", consistency: "strong" });
  return authStoreFrom((k) => netlifyBlobStore(blobs, k));
}

// Einheitliche Antwort bei fehlender Berechtigung (für alle /api/*-Handler).
export const deny = (r) => new Response(JSON.stringify({ error: r.error || "Nicht berechtigt.", ...(r.code ? { code: r.code } : {}) }),
  { status: r.status || 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const forbidden = (msg = "Keine Berechtigung für diese Aktion.") => new Response(JSON.stringify({ error: msg, code: "FORBIDDEN" }),
  { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } });
