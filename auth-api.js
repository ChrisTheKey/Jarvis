// /api/auth/* – Login, Sitzung, Logout und OWNER-Benutzerverwaltung (TF-063). Node (Netlify Function), scrypt aus node:crypto.
//
//   POST /api/auth/login              { username, password } → HttpOnly-Session-Cookie (7 Tage), Antwort nur Profil (nie Passwort/Token)
//   GET  /api/auth/me                 Profil der aktuellen Sitzung (user_id, name, role, locale, markets, commission_rate_bps)
//   POST /api/auth/logout             Sitzung serverseitig löschen + Cookie leeren
//   GET  /api/auth/admin/users        OWNER: Karten der vier Verkäufer (Status, letzter Login, aktive Sessions – nie Hashes)
//   POST /api/auth/admin/password     OWNER: { user_id, password } setzen (≥ 12 Zeichen), beendet bestehende Sessions
//   POST /api/auth/admin/reset        OWNER: { user_id } Passwort entfernen (kein Login mehr bis neu gesetzt) + Sessions beenden
//   POST /api/auth/admin/revoke       OWNER: { user_id } alle Sessions abmelden
//   POST /api/auth/admin/active       OWNER: { user_id, active } aktivieren/deaktivieren (deaktivieren beendet Sessions)
//
// Chris (OWNER) – Legacy-Bootstrap: Beim ersten Login als "chris" mit dem bestehenden JARVIS_PASSWORD wird nur ein scrypt-Hash des
// eingegebenen Passworts gespeichert (nie Klartext). JARVIS_PASSWORD bleibt zusätzlich als Owner-Zugang gültig (Wiederherstellung).
// Verwaltung über die API nur für die vier Verkäufer – Chris' Passwort ändert sich nie ohne Chris (Netlify-Variable).
import crypto from "node:crypto";
import { USERS, OWNER_ID, SELLER_IDS, MIN_PASSWORD, SESSION_MAX_MS, COOKIE, publicUser, userIdOf, userRecord, emptyUsers, emptySessions, sessionValid,
  sessionCookie, clearCookie, isHttps, sha256Hex, randomToken, resolveActor, sameOrigin, isOwner, sessionToken } from "./auth-core.js";
import { safeEqual } from "./shared-state.js";
import { migrateAuthUsers, migrateAuthSessions, migrateStoreDoc, migrateOnce } from "./seller-identity.js";

export const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 });
export const RATE = Object.freeze({ windowMs: 15 * 60_000, perUser: 5, perIp: 20 });
const AUDIT_KEEP = 1000;
const MAX_PASSWORD = 256;

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

// ---------- Passwort-Hashing ----------
const scryptAsync = (pw, salt, o) => new Promise((res, rej) => crypto.scrypt(pw, salt, o.keylen, { N: o.N, r: o.r, p: o.p, maxmem: o.maxmem }, (e, k) => (e ? rej(e) : res(k))));
export async function hashPassword(pw, o = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(pw).normalize("NFC"), salt, o);
  return { algo: "scrypt", N: o.N, r: o.r, p: o.p, keylen: o.keylen, salt: salt.toString("base64"), hash: key.toString("base64") };
}
export async function verifyPassword(pw, rec) {
  if (!rec || rec.algo !== "scrypt" || typeof rec.salt !== "string" || typeof rec.hash !== "string") return false;
  const o = { N: rec.N, r: rec.r, p: rec.p, keylen: rec.keylen, maxmem: SCRYPT.maxmem };
  if (![16384, 32768, 65536].includes(o.N) || o.r !== 8 || o.p !== 1 || o.keylen !== 64) return false;
  const want = Buffer.from(rec.hash, "base64");
  const got = await scryptAsync(String(pw).normalize("NFC"), Buffer.from(rec.salt, "base64"), o);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
// Gleiche Rechenzeit für unbekannte Benutzer/ohne Passwort (kein Timing-Orakel für existierende Konten).
let DUMMY = null;
const dummyVerify = async (pw) => { DUMMY ||= await hashPassword("jarvis-dummy-password-never-valid"); await verifyPassword(pw, DUMMY); return false; };

export function passwordProblem(pw) {
  if (typeof pw !== "string") return "Passwort fehlt.";
  if (pw.length < MIN_PASSWORD) return `Passwort zu kurz – mindestens ${MIN_PASSWORD} Zeichen.`;
  if (pw.length > MAX_PASSWORD) return "Passwort zu lang.";
  if (/[\u0000-\u001f\u007f]/.test(pw)) return "Passwort enthält Steuerzeichen.";
  return null;
}

const clientIp = (req) => String(req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0, 64);

export function createAuthHandler({ getStore, env, now = () => new Date() }) {
  async function update(key, fn, empty) {
    const store = await getStore();
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store[key].get();
      const cur = structuredClone(state || empty());
      const res = fn(cur);
      if (res === false) return false;
      if (await store[key].set(cur, etag)) return true;
    }
    throw new Error("Gleichzeitige Änderung – bitte erneut versuchen.");
  }
  // Audit: nie Passwort, Token oder Hash – nur Zeit, Akteur, Aktion, Ziel, Ergebnis.
  const audit = (entry) => update("audit", (a) => { a.entries = [...(a.entries || []), { ts: now().toISOString(), ...entry }].slice(-AUDIT_KEEP); }, () => ({ entries: [] })).catch(() => {});

  async function rateState(user, ip) {
    const { state } = await (await getStore()).limits.get();
    const t = +now();
    const fails = (state?.fails || []).filter((f) => t - Date.parse(f.at) < RATE.windowMs);
    return { user: fails.filter((f) => f.u === user).length, ip: fails.filter((f) => f.ip === ip).length };
  }
  const recordFail = (user, ip) => update("limits", (l) => { const t = +now(); l.fails = [...(l.fails || []).filter((f) => t - Date.parse(f.at) < RATE.windowMs), { u: user, ip, at: new Date(t).toISOString() }].slice(-2000); }, () => ({ fails: [] }));
  const clearFails = (user) => update("limits", (l) => { l.fails = (l.fails || []).filter((f) => f.u !== user); }, () => ({ fails: [] }));

  // TF-070: Konto «lap» → «Kudoshin» (Passwort-Hash übernommen, «lap»-Sitzungen entfernt) – einmal je Instanz, idempotent.
  const migrateIdentity = migrateOnce(async () => {
    const store = await getStore();
    await migrateStoreDoc(store.users, (d) => migrateAuthUsers(d, { now: now() }));
    await migrateStoreDoc(store.sessions, migrateAuthSessions);
  });

  async function readDocs() {
    const store = await getStore();
    return { users: (await store.users.get()).state || emptyUsers(), sessions: (await store.sessions.get()).state || emptySessions() };
  }
  async function revokeAll(userId) {
    const t = now().toISOString();
    await update("users", (d) => { d.users ||= {}; d.users[userId] = { ...(d.users[userId] || {}), sessions_revoked_at: t }; }, emptyUsers);
    await update("sessions", (d) => { d.sessions = Object.fromEntries(Object.entries(d.sessions || {}).filter(([, s]) => s.user_id !== userId)); }, emptySessions);
  }

  async function login(req) {
    if (!sameOrigin(req)) return reply(403, { error: "Ungültige Herkunft.", code: "BAD_ORIGIN" });
    let body;
    try { body = JSON.parse((await req.text()).slice(0, 4000) || "{}"); } catch { return reply(400, { error: "Ungültige Anfrage." }); }
    const id = userIdOf(body?.username), pw = typeof body?.password === "string" ? body.password : "";
    const ip = clientIp(req), key = id || `?${String(body?.username || "").toLowerCase().slice(0, 40)}`;
    const rs = await rateState(key, ip);
    if (rs.user >= RATE.perUser || rs.ip >= RATE.perIp) {
      await audit({ actor_user_id: id, action: "auth.login", result: "rate_limited" });
      return reply(429, { error: "Zu viele Fehlversuche – bitte 15 Minuten warten.", code: "RATE_LIMIT" });
    }
    const fail = async (why) => { await recordFail(key, ip); await audit({ actor_user_id: id, action: "auth.login", result: why }); return reply(401, { error: "Benutzername oder Passwort falsch.", code: "BAD_LOGIN" }); };
    if (!id || !pw || pw.length > MAX_PASSWORD) { await dummyVerify(pw || "x"); return fail("unknown_user"); }
    const { users } = await readDocs();
    const rec = userRecord(users, id);
    if (!rec.active) { await dummyVerify(pw); return fail("inactive"); }
    let ok = rec.password ? await verifyPassword(pw, rec.password) : false;
    let bootstrap = false;
    if (!ok && id === OWNER_ID) {
      // Legacy: bestehendes JARVIS_PASSWORD (konstanter Vergleich). Beim ersten Mal nur scrypt-Hash speichern.
      const legacy = env("JARVIS_PASSWORD");
      if (legacy && safeEqual(pw, legacy)) { ok = true; bootstrap = !rec.password; }
    }
    if (!rec.password && !ok) await dummyVerify(pw);
    if (!ok) return fail(rec.password || id === OWNER_ID ? "bad_password" : "no_password_set");
    const t = now(), token = randomToken(32), hash = await sha256Hex(token);
    const pwRec = bootstrap ? await hashPassword(pw) : null;
    await update("users", (d) => { d.users ||= {}; d.users[id] = { ...(d.users[id] || {}), last_login_at: t.toISOString(), ...(pwRec ? { password: pwRec, password_set_at: t.toISOString(), initialized_at: t.toISOString() } : {}) }; }, emptyUsers);
    await update("sessions", (d) => {
      // Abgelaufene Sessions aufräumen; höchstens 10 gleichzeitige je Benutzer (älteste fallen weg).
      const live = Object.entries(d.sessions || {}).filter(([, s]) => sessionValid(s, t));
      const mine = live.filter(([, s]) => s.user_id === id).sort((a, b) => a[1].created_at.localeCompare(b[1].created_at));
      const drop = new Set(mine.slice(0, Math.max(0, mine.length - 9)).map(([h]) => h));
      const u = USERS[id];
      d.sessions = Object.fromEntries([...live.filter(([h]) => !drop.has(h)), [hash, { user_id: id, role: u.role, locale: u.locale, created_at: t.toISOString(), last_seen_at: t.toISOString(),
        expires_at: new Date(+t + SESSION_MAX_MS).toISOString() }]]);
    }, emptySessions);
    await clearFails(key);
    await audit({ actor_user_id: id, action: "auth.login", result: bootstrap ? "success_owner_bootstrap" : "success" });
    return reply(200, { user: publicUser(id), expires_at: new Date(+t + SESSION_MAX_MS).toISOString() }, { "set-cookie": sessionCookie(token, { secure: isHttps(req) }) });
  }

  async function logout(req) {
    if (!sameOrigin(req)) return reply(403, { error: "Ungültige Herkunft.", code: "BAD_ORIGIN" });
    const token = sessionToken(req);
    if (token) {
      const hash = await sha256Hex(token);
      let who = null;
      await update("sessions", (d) => { who = d.sessions?.[hash]?.user_id || null; if (!who) return false; delete d.sessions[hash]; }, emptySessions);
      if (who) await audit({ actor_user_id: who, action: "auth.logout", result: "success" });
    }
    return reply(200, { ok: true }, { "set-cookie": clearCookie({ secure: isHttps(req) }) });
  }

  async function adminUsers(t) {
    const { users, sessions } = await readDocs();
    const live = Object.values(sessions.sessions || {}).filter((s) => sessionValid(s, t));
    const card = (id) => {
      const r = userRecord(users, id), revoked = r.sessions_revoked_at ? Date.parse(r.sessions_revoked_at) : 0;
      return { ...publicUser(id), active: r.active, password_set: !!r.password, password_set_at: r.password_set_at, last_login_at: r.last_login_at,
        active_sessions: live.filter((s) => s.user_id === id && Date.parse(s.created_at) > revoked).length };
    };
    return { owner: card(OWNER_ID), users: SELLER_IDS.map(card) };
  }

  return async (req) => {
    const url = new URL(req.url);
    const route = url.pathname.replace(/^\/api\/auth\/?/, "").replace(/\/+$/, "");
    await migrateIdentity();
    if (route === "login") return req.method === "POST" ? login(req) : reply(405, { error: "Nur POST." });
    if (route === "logout") return req.method === "POST" ? logout(req) : reply(405, { error: "Nur POST." });
    const r = await resolveActor(req, { env, getAuthStore: getStore, now });
    if (!r.actor) return reply(r.status, { error: r.error, ...(r.code ? { code: r.code } : {}) });
    if (route === "me") return req.method === "GET" ? reply(200, { user: publicUser(r.actor.user_id), via: r.via }) : reply(405, { error: "Nur GET." });
    if (!route.startsWith("admin/")) return reply(404, { error: "Unbekannt." });
    // ---- Nur OWNER (serverseitig, nicht nur in der Oberfläche) ----
    if (!isOwner(r.actor)) {
      await audit({ actor_user_id: r.actor.user_id, action: `auth.${route}`, result: "forbidden" });
      return reply(403, { error: "Nur der Owner verwaltet Zugänge.", code: "FORBIDDEN" });
    }
    const t = now();
    if (route === "admin/users") return req.method === "GET" ? reply(200, await adminUsers(t)) : reply(405, { error: "Nur GET." });
    if (req.method !== "POST") return reply(405, { error: "Nur POST." });
    let body;
    try { body = JSON.parse((await req.text()).slice(0, 4000) || "{}"); } catch { return reply(400, { error: "Ungültige Anfrage." }); }
    const target = typeof body?.user_id === "string" && SELLER_IDS.includes(body.user_id) ? body.user_id : null;
    if (!target) return reply(400, { error: "user_id muss giuliano, mario, damiano oder Kudoshin sein." });
    const done = async (action, extra = {}) => { await audit({ actor_user_id: r.actor.user_id, action, target_user_id: target, result: "success" }); return reply(200, { ok: true, ...(await adminUsers(now())), ...extra }); };
    if (route === "admin/password") {
      const problem = passwordProblem(body.password);
      if (problem) return reply(400, { error: problem });
      const rec = await hashPassword(body.password);
      await update("users", (d) => { d.users ||= {}; d.users[target] = { ...(d.users[target] || {}), password: rec, password_set_at: t.toISOString() }; }, emptyUsers);
      await revokeAll(target);
      return done("auth.admin.password_set");
    }
    if (route === "admin/reset") {
      await update("users", (d) => { d.users ||= {}; d.users[target] = { ...(d.users[target] || {}), password: null, password_set_at: null }; }, emptyUsers);
      await revokeAll(target);
      return done("auth.admin.password_reset");
    }
    if (route === "admin/revoke") { await revokeAll(target); return done("auth.admin.sessions_revoked"); }
    if (route === "admin/active") {
      if (typeof body.active !== "boolean") return reply(400, { error: "active: true/false." });
      await update("users", (d) => { d.users ||= {}; d.users[target] = { ...(d.users[target] || {}), active: body.active }; }, emptyUsers);
      if (!body.active) await revokeAll(target);
      return done(body.active ? "auth.admin.activated" : "auth.admin.deactivated");
    }
    return reply(404, { error: "Unbekannte Admin-Aktion." });
  };
}
export { COOKIE };
