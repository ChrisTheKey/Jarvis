// TF-063 Tests – Authentifizierung (A–L) + Owner-only-Grenzen (Server Control, Backup, Benutzerverwaltung, State, Mail).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup, makeReq, cookieOf, PW, ENV } from "./tf063-helpers.js";
import { hashPassword, verifyPassword, SCRYPT } from "../auth-api.js";

const me = async (t, cookie) => t.json(await t.auth(makeReq("/api/auth/me", { cookie })));

test("TF-063 Auth A–E: Rollen und Sprachen je Benutzer", async () => {
  const t = await setup({ assign: false });
  const exp = { chris: ["OWNER", "de-CH"], giuliano: ["SALES_MANAGER_CH", "de-CH"], mario: ["SALES_AGENT_CH", "de-CH"], damiano: ["SALES_AGENT_CH", "de-CH"], Kudoshin: ["SALES_AGENT_VN", "vi-VN"] };
  for (const [u, [role, locale]] of Object.entries(exp)) {
    const r = await me(t, t.cookies[u]);
    assert.equal(r.status, 200, u);
    assert.equal(r.body.user.role, role, u); assert.equal(r.body.user.locale, locale, u);
    assert.equal(r.body.user.commission_rate_bps, u === "chris" ? 0 : 6000); // TF-072
  }
});

test("TF-063 Auth F/G: falsches Passwort → 401, danach Rate Limit 429", async () => {
  const t = await setup({ assign: false });
  for (let i = 0; i < 5; i++) assert.equal((await t.login("mario", "falsches-passwort-xx")).status, 401);
  assert.equal((await t.login("mario", "falsches-passwort-xx")).status, 429, "6. Versuch gesperrt");
  assert.equal((await t.login("mario", PW.mario)).status, 429, "auch das richtige Passwort im Sperrfenster");
  assert.equal((await t.login("unbekannt", "irgendwas-123456")).status, 401);
  assert.equal((await t.login("giuliano", PW.giuliano)).status, 200, "anderer Benutzer nicht betroffen");
});

test("TF-063 Auth H: Session-Cookie HttpOnly, Secure, SameSite=Strict, Path=/, ≤ 7 Tage; nicht im Body", async () => {
  const t = await setup({ assign: false });
  const r = await t.login("Kudoshin", PW.Kudoshin);
  const c = r.headers.get("set-cookie");
  assert.match(c, /^jarvis_session=[A-Za-z0-9_-]{40,64};/);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(c.includes(flag), flag);
  assert.equal(Number(c.match(/Max-Age=(\d+)/)[1]), 7 * 86400);
  const body = await r.text();
  assert.ok(!body.includes(c.split(";")[0].split("=")[1]), "Token nicht im Body");
  // Im Speicher nur der Hash – nie das Token selbst.
  const sess = JSON.stringify(t.authMem.sessions.peek());
  assert.ok(!sess.includes(c.split(";")[0].split("=")[1]));
  assert.match(Object.keys(t.authMem.sessions.peek().sessions)[0], /^[0-9a-f]{64}$/);
});

test("TF-063 Auth I: Logout invalidiert die Session serverseitig", async () => {
  const t = await setup({ assign: false });
  const c = t.cookies.damiano;
  assert.equal((await me(t, c)).status, 200);
  const out = await t.auth(makeReq("/api/auth/logout", { method: "POST", cookie: c }));
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await me(t, c)).status, 401, "altes Cookie gilt nicht mehr");
});

test("TF-063 Auth J: deaktivierter Benutzer → kein Login, bestehende Session beendet", async () => {
  const t = await setup({ assign: false });
  const r = await t.json(await t.auth(makeReq("/api/auth/admin/active", { method: "POST", cookie: t.cookies.chris, body: { user_id: "mario", active: false } })));
  assert.equal(r.status, 200);
  assert.equal((await me(t, t.cookies.mario)).status, 401);
  assert.equal((await t.login("mario", PW.mario)).status, 401);
  await t.auth(makeReq("/api/auth/admin/active", { method: "POST", cookie: t.cookies.chris, body: { user_id: "mario", active: true } }));
  assert.equal((await t.login("mario", PW.mario)).status, 200);
});

test("TF-063 Auth K/L: Passwort nie in API-Antworten, Speicher, Audit oder Logs", async () => {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(" "));
  try {
    const t = await setup({ assign: false });
    const users = await t.json(await t.auth(makeReq("/api/auth/admin/users", { cookie: t.cookies.chris })));
    const everything = JSON.stringify(users.body) + JSON.stringify((await me(t, t.cookies.Kudoshin)).body) + JSON.stringify(t.authMem.users.peek()) + JSON.stringify(t.authMem.audit.peek()) + logs.join("\n");
    for (const pw of [...Object.values(PW), ENV.JARVIS_PASSWORD]) assert.ok(!everything.includes(pw), "Klartext-Passwort gefunden");
    assert.ok(!JSON.stringify(users.body).includes("hash") && !JSON.stringify(users.body).includes("salt"), "keine Hash-Daten in der Antwort");
    const rec = t.authMem.users.peek().users.Kudoshin.password;
    assert.equal(rec.algo, "scrypt"); assert.equal(rec.N, SCRYPT.N); assert.ok(rec.salt && rec.hash);
    assert.equal(t.authMem.users.peek().users.chris.password.algo, "scrypt", "Owner-Bootstrap speichert nur einen Hash");
  } finally { Object.assign(console, orig); }
});

test("TF-063 Auth: scrypt mit zufälligem Salt, konstanter Vergleich, ≥ 12 Zeichen", async () => {
  const a = await hashPassword("ein-langes-passwort"), b = await hashPassword("ein-langes-passwort");
  assert.notEqual(a.salt, b.salt); assert.notEqual(a.hash, b.hash);
  assert.equal(await verifyPassword("ein-langes-passwort", a), true);
  assert.equal(await verifyPassword("ein-langes-passworT", a), false);
  const t = await setup({ assign: false });
  const r = await t.json(await t.auth(makeReq("/api/auth/admin/password", { method: "POST", cookie: t.cookies.chris, body: { user_id: "Kudoshin", password: "zu-kurz-11c" } })));
  assert.equal(r.status, 400);
  assert.match(fs.readFileSync(new URL("../auth-api.js", import.meta.url), "utf8"), /timingSafeEqual/);
});

test("TF-063 Auth: Owner-Bootstrap über bestehendes JARVIS_PASSWORD, Reset/Revoke, Verkäufer dürfen nichts verwalten", async () => {
  const t = await setup({ assign: false });
  for (const u of ["giuliano", "mario", "damiano", "Kudoshin"]) {
    for (const [path, method] of [["/api/auth/admin/users", "GET"], ["/api/auth/admin/password", "POST"], ["/api/auth/admin/revoke", "POST"], ["/api/auth/admin/active", "POST"], ["/api/auth/admin/reset", "POST"]]) {
      const r = await t.auth(makeReq(path, { method, cookie: t.cookies[u], ...(method === "POST" ? { body: { user_id: "mario", password: "x".repeat(20), active: false } } : {}) }));
      assert.equal(r.status, 403, `${u} ${path}`);
    }
  }
  assert.equal((await me(t, t.cookies.mario)).status, 200, "Mario unverändert aktiv");
  // Owner-Verwaltung nur für die vier Verkäufer – nie Chris selbst.
  assert.equal((await t.auth(makeReq("/api/auth/admin/password", { method: "POST", cookie: t.cookies.chris, body: { user_id: "chris", password: "neues-owner-pw-123" } }))).status, 400);
  // Reset: kein Login mehr; Revoke: Sessions weg.
  await t.auth(makeReq("/api/auth/admin/revoke", { method: "POST", cookie: t.cookies.chris, body: { user_id: "giuliano" } }));
  assert.equal((await me(t, t.cookies.giuliano)).status, 401);
  await t.auth(makeReq("/api/auth/admin/reset", { method: "POST", cookie: t.cookies.chris, body: { user_id: "giuliano" } }));
  assert.equal((await t.login("giuliano", PW.giuliano)).status, 401);
  const card = (await t.json(await t.auth(makeReq("/api/auth/admin/users", { cookie: t.cookies.chris })))).body.users.find((x) => x.user_id === "giuliano");
  assert.equal(card.password_set, false); assert.equal(card.active_sessions, 0);
});

test("TF-063 CSRF: schreibende Cookie-Requests mit fremdem Origin → 403", async () => {
  const t = await setup({ assign: false });
  const r = await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies.chris, origin: "https://evil.example", body: { action: "crm.addNote", params: { lead_id: "ch-firma-0001.ch", text: "x" } } }));
  assert.equal(r.status, 403);
  assert.equal((await t.auth(makeReq("/api/auth/login", { method: "POST", origin: "https://evil.example", body: { username: "Kudoshin", password: PW.Kudoshin } }))).status, 403);
});

test("TF-063 Owner-only: Server Control, Backup, State – Verkäufer 403 (GET und POST), Chris 200", async () => {
  const t = await setup({ assign: false });
  for (const u of ["giuliano", "mario", "damiano", "Kudoshin"]) {
    assert.equal((await t.server(makeReq("/api/server-control", { cookie: t.cookies[u] }))).status, 403, `${u} server GET`);
    assert.equal((await t.server(makeReq("/api/server-control", { method: "POST", cookie: t.cookies[u], body: { action: "system.health" } }))).status, 403, `${u} server POST`);
    assert.equal((await t.server(makeReq("/api/server-control?leaddb=1", { cookie: t.cookies[u] }))).status, 403, `${u} leaddb`);
    assert.equal((await t.backup(makeReq("/api/backup", { cookie: t.cookies[u] }))).status, 403, `${u} backup`);
    const st = await t.json(await t.state(makeReq("/api/state", { cookie: t.cookies[u] })));
    assert.equal(st.status, 200);
    assert.deepEqual(Object.keys(st.body).sort(), ["conversation", "user_id"], "Verkäufer sehen nur ihren eigenen Verlauf");
    assert.equal((await t.state(makeReq("/api/state", { method: "POST", cookie: t.cookies[u], body: { op: "dismiss", id: "abcd-1234" } }))).status, 403);
    assert.equal((await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies[u], body: { op: "create", recipient: "x@y.ch", subject: "s", body: "b", delivery: "draft" } }))).status, 403);
  }
  assert.equal((await t.server(makeReq("/api/server-control", { cookie: t.cookies.chris }))).status, 200);
  assert.equal((await t.backup(makeReq("/api/backup", { cookie: t.cookies.chris }))).status, 200);
  assert.equal((await t.state(makeReq("/api/state", { cookie: t.cookies.chris }))).status, 200);
  assert.equal((await t.server(makeReq("/api/server-control"))).status, 401, "ohne Anmeldung 401");
});

test("TF-063 Chat-Verlauf je Benutzer getrennt (kein Chris-Kontext für Verkäufer)", async () => {
  const t = await setup({ assign: false });
  await t.state(makeReq("/api/state", { method: "POST", cookie: t.cookies.chris, body: { op: "conversation", turns: [{ role: "user", content: "Privat von Chris" }] } }));
  await t.state(makeReq("/api/state", { method: "POST", cookie: t.cookies.Kudoshin, body: { op: "conversation", turns: [{ role: "user", content: "Xin chào Jarvis" }] } }));
  const lap = await t.json(await t.state(makeReq("/api/state", { cookie: t.cookies.Kudoshin })));
  const mario = await t.json(await t.state(makeReq("/api/state", { cookie: t.cookies.mario })));
  assert.deepEqual(lap.body.conversation.turns.map((x) => x.content), ["Xin chào Jarvis"]);
  assert.equal(mario.body.conversation.turns.length, 0);
  assert.ok(!JSON.stringify(lap.body).includes("Privat von Chris"));
});
