// TF-073: Geräte-Isolation pro Benutzer (kein Mesh, keine Fremd-Steuerung, auch nicht für Chris/OWNER) + Provision 60 % (Prüfung).
process.env.JARVIS_DEVICE_KEY_PROTECTION ||= "file"; // TF-074: Geräte-Tresor im Test ohne DPAPI (DPAPI selbst: tf074)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, makeReq, ORIGIN, env } from "./tf063-helpers.js";
import { memoryStore } from "../shared-state.js";
import { authStoreFrom, publicUser, USERS } from "../auth-core.js";
import { createAuthHandler } from "../auth-api.js";
import { resolveActor } from "../auth-core.js";
import { createDeviceHandler, terminateUserDevices } from "../device-api.js";
import { deviceStoreFrom, authorizeDeviceAccess, PAIRING_FLOW, PAIRING_TTL_MS, DEVICE_HEADER, DEVICE_FP_HEADER } from "../device-core.js";
import { pairDevice, pollOnce, rotateCredential, loadCredential, loadIdentity, assertOutbound } from "../device-agent.js";
import { deriveLedger, ordersFromSnapshot, emptyLedger, RATE_BPS, SELLERS, fromMinor, commissionMinor } from "../commission-ledger.js";
import { SELLER_COMMISSION_BPS, COMMISSION_BPS_SCHEDULE, commissionBpsAt, toMinor, MARKET_PRICES } from "../pricing.js";

const K = "Kudoshin";
const ALL = ["chris", "giuliano", "mario", "damiano", K];
const SELLER = ["giuliano", "mario", "damiano", K];

async function world() {
  let clock = new Date("2026-10-17T08:00:00.000Z");
  const now = () => { clock = new Date(+clock + 1); return new Date(clock); }; // tickt (Sessions nach Passwortsetzen gültig)
  const S = await setup({ ch: 20, vn: 4, now });
  const getAuthStore = async () => authStoreFrom((k) => (S.authMem[k] ||= memoryStore()));
  const devMem = {};
  const devStore = deviceStoreFrom((k) => (devMem[k] ||= memoryStore()));
  const getStore = async () => devStore;
  const devices = createDeviceHandler({ getStore, getAuthStore, now, resolveActor: (req) => resolveActor(req, { env, getAuthStore, now }) });
  // Auth-Handler wie in netlify/functions/auth.mjs: Konto deaktivieren → Geräte-Sitzungen beenden.
  const auth = createAuthHandler({ env, getStore: getAuthStore, now, onUserDisabled: (user_id, actor_user_id) => terminateUserDevices(devStore, { user_id, actor_user_id, now: now() }) });
  const fetchImpl = async (url, init) => devices(new Request(url, init));
  const call = async (user, p, body, method = body === undefined ? "GET" : "POST") => {
    const res = await devices(makeReq(`/api/devices${p}`, { method, cookie: user ? S.cookies[user] : undefined, body }));
    return { status: res.status, body: await res.json().catch(() => null), text: null };
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf073-"));
  const dirs = Object.fromEntries(ALL.map((u) => [u, path.join(tmp, u)]));
  const pair = async (user, { name = `${user} PC`, type = "pc", dir = dirs[user] } = {}) => {
    const s = await call(user, "/pair/start", {});
    assert.equal(s.status, 200, `${user} pair/start`);
    return { ...(await pairDevice({ cloud: ORIGIN, code: s.body.pairing_code, name, type, dir, fetchImpl })), pairing_code: s.body.pairing_code };
  };
  return { S, auth, devices, devMem, devStore, call, pair, fetchImpl, dirs, tmp, advance: (ms) => { clock = new Date(+clock + ms); }, now };
}

test("TF-073 Kernregel: Eigentum zwingend, keine OWNER-Ausnahme, Status und Aktion geprüft", () => {
  const d = (owner, status = "active") => ({ device_id: "dev_x", owner_user_id: owner, status });
  for (const u of ALL) assert.equal(authorizeDeviceAccess({ requesting_user_id: u, device: d(u) }).ok, true, `${u} → eigenes Gerät`);
  for (const a of ALL) for (const b of ALL) if (a !== b) {
    const r = authorizeDeviceAccess({ requesting_user_id: a, device: d(b) });
    assert.deepEqual([r.ok, r.status, r.code], [false, 403, "DEVICE_FORBIDDEN"], `${a} → ${b}`);
  }
  // Fremde erfahren den Status nicht (Eigentum wird zuerst geprüft).
  assert.equal(authorizeDeviceAccess({ requesting_user_id: "chris", device: d("mario", "revoked") }).code, "DEVICE_FORBIDDEN");
  assert.equal(authorizeDeviceAccess({ requesting_user_id: "mario", device: d("mario", "revoked") }).code, "DEVICE_REVOKED");
  assert.equal(authorizeDeviceAccess({ requesting_user_id: "mario", device: d("mario", "disabled") }).code, "DEVICE_DISABLED");
  assert.equal(authorizeDeviceAccess({ requesting_user_id: "mario", device: d("mario"), action_id: "shell.exec" }).code, "UNKNOWN_ACTION");
  assert.equal(authorizeDeviceAccess({ requesting_user_id: "lap", device: d("lap") }).ok, false, "kein Nicht-Benutzer");
  assert.equal(authorizeDeviceAccess({ requesting_user_id: "chris", device: null }).code, "DEVICE_FORBIDDEN");
});

test("TF-073 eigenes Gerät: alle fünf Benutzer koppeln, öffnen eine Sitzung und steuern NUR ihr eigenes Gerät (nur ausgehend)", async () => {
  const W = await world();
  const dev = {};
  for (const u of ALL) {
    const p = await W.pair(u, { type: u === K ? "phone" : "pc" });
    assert.equal(p.ok, true, u); assert.equal(p.owner_user_id, u);
    dev[u] = p.device_id;
  }
  assert.equal(new Set(Object.values(dev)).size, 5, "eigene Geräte-IDs");
  const creds = ALL.map((u) => loadCredential(W.dirs[u]).credential);
  assert.equal(new Set(creds).size, 5, "kein gemeinsamer Geräte-Token");
  for (const u of ALL) {
    const list = await W.call(u, "");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.devices.map((d) => d.device_id), [dev[u]], `${u} sieht nur eigene Geräte`);
    assert.equal(list.body.code, undefined);
    const s = await W.call(u, `/${dev[u]}/session`, {});
    assert.equal(s.status, 200, `${u} → eigenes Gerät: erlaubt`);
    const a = await W.call(u, `/${dev[u]}/actions`, { session_id: s.body.session_id, action_id: "device.status" });
    assert.equal(a.status, 200);
    const polled = await pollOnce({ dir: W.dirs[u], fetchImpl: W.fetchImpl });
    assert.deepEqual(polled.done, [{ command_id: a.body.command_id, ok: true }], `${u} Agent führt eigenen Befehl aus`);
    const d = await W.call(u, `/${dev[u]}`);
    assert.equal(d.body.commands.at(-1).status, "done");
    assert.equal(d.body.commands.at(-1).result.agent_version, "tf073-1");
    assert.equal(d.body.device.online, true);
  }
  // Ein Agent bekommt nie Befehle eines anderen Geräts.
  for (const u of ALL) assert.deepEqual((await pollOnce({ dir: W.dirs[u], fetchImpl: W.fetchImpl })).done, []);
  // Nur HTTPS nach aussen.
  assert.throws(() => assertOutbound("http://jarvis.example.com"), /HTTPS/);
  assert.equal(assertOutbound("https://jarvis.example.com/x"), "https://jarvis.example.com");
  fs.rmSync(W.tmp, { recursive: true, force: true });
});

test("TF-073 Quer-Zugriff: Verkäufer → Chris, Verkäufer → Verkäufer und Chris → Verkäufer-Gerät = 403 ohne Datenleck; Chris-Cloud-Admin bleibt", async () => {
  const W = await world();
  const dev = {};
  for (const u of ALL) dev[u] = (await W.pair(u)).device_id;
  const sessions = {};
  for (const u of ALL) sessions[u] = (await W.call(u, `/${dev[u]}/session`, {})).body.session_id;
  for (const a of ALL) for (const b of ALL) {
    if (a === b) continue;
    const id = dev[b];
    const tries = [await W.call(a, `/${id}`), await W.call(a, `/${id}/session`, {}), await W.call(a, `/${id}/actions`, { session_id: sessions[a], action_id: "device.ping" }),
      await W.call(a, `/${id}/actions`, { session_id: sessions[b], action_id: "device.ping" }), await W.call(a, `/${id}/session/close`, { session_id: sessions[b] }),
      await W.call(a, `/${id}/revoke`, {})];
    for (const r of tries) {
      assert.equal(r.status, 403, `${a} → ${b}`);
      assert.deepEqual(Object.keys(r.body).sort(), ["code", "error"], "keine Metadaten");
      assert.equal(r.body.code, "DEVICE_FORBIDDEN");
    }
    const list = await W.call(a, "");
    assert.ok(!list.body.devices.some((d) => d.device_id === id), `${a} listet ${b}-Geräte nicht`);
  }
  // Nicht existierendes Gerät: gleiche Antwort wie fremdes (kein Existenz-Orakel).
  const ghost = await W.call("mario", "/dev_AAAAAAAAAAAAAAAAAAAAAA/session", {});
  assert.deepEqual([ghost.status, ghost.body.code], [403, "DEVICE_FORBIDDEN"]);
  // Kein Befehl wurde für ein fremdes Gerät eingereiht.
  const cmds = W.devMem.commands?.peek()?.commands || [];
  assert.equal(cmds.length, 0);
  // Fremdes Credential mit anderer Geräte-Identität → 401 (Credential an Gerät gebunden).
  const kc = loadCredential(W.dirs[K]).credential;
  const r = await W.devices(makeReq("/api/devices/channel", { method: "POST", origin: null, headers: { [DEVICE_HEADER]: kc, [DEVICE_FP_HEADER]: loadIdentity(W.dirs.chris).fp }, body: { op: "poll" } }));
  assert.equal(r.status, 401);
  // Gerät-ID von Chris + Secret von Kudoshin → 401.
  const forged = `${dev.chris}.${kc.split(".")[1]}`;
  const r2 = await W.devices(makeReq("/api/devices/channel", { method: "POST", origin: null, headers: { [DEVICE_HEADER]: forged, [DEVICE_FP_HEADER]: loadIdentity(W.dirs.chris).fp }, body: { op: "poll" } }));
  assert.equal(r2.status, 401);
  // Chris → Cloud-Kontodaten der Verkäufer: weiterhin erlaubt (OWNER-RBAC).
  const admin = await W.S.auth(makeReq("/api/auth/admin/users", { cookie: W.S.cookies.chris }));
  assert.equal(admin.status, 200);
  assert.deepEqual((await admin.json()).users.map((u) => u.user_id), SELLER);
  for (const v of ["commission", "assignments", "sales_overview"]) assert.equal((await W.S.sales(makeReq(`/api/sales?view=${v}`, { cookie: W.S.cookies.chris }))).status, 200, v);
  for (const u of SELLER) assert.equal((await W.S.auth(makeReq("/api/auth/admin/users", { cookie: W.S.cookies[u] }))).status, 403);
  // Owner-Übersicht: Metadaten aller Geräte, nie Secrets/Fingerprints/Sitzungen; Verkäufer → 403.
  const ov = await W.call("chris", "/admin");
  assert.equal(ov.status, 200);
  assert.deepEqual(ov.body.devices.map((d) => d.owner_user_id).sort(), [...ALL].sort());
  for (const d of ov.body.devices) assert.deepEqual(Object.keys(d).sort(), ["created_at", "device_id", "device_name", "device_type", "last_seen_at", "online", "owner_user_id", "status"]);
  const ovText = JSON.stringify(ov.body);
  for (const u of ALL) { assert.ok(!ovText.includes(loadCredential(W.dirs[u]).credential.split(".")[1])); assert.ok(!ovText.includes(loadIdentity(W.dirs[u]).fp)); }
  for (const u of SELLER) assert.equal((await W.call(u, "/admin")).status, 403);
  fs.rmSync(W.tmp, { recursive: true, force: true });
});

test("TF-073 Chris deaktiviert ein Verkäufer-Gerät: keine Verbindung für Chris, Agent gesperrt, Verkäufer-Sitzung beendet", async () => {
  const W = await world();
  const g = (await W.pair("giuliano")).device_id;
  const s = (await W.call("giuliano", `/${g}/session`, {})).body.session_id;
  const q = await W.call("giuliano", `/${g}/actions`, { session_id: s, action_id: "device.ping" });
  assert.equal(q.status, 200);
  const dis = await W.call("chris", `/${g}/disable`, {});
  assert.equal(dis.status, 200);
  assert.equal(dis.body.device.status, "disabled");
  assert.equal(dis.body.session_id, undefined); assert.equal(dis.body.device_credential, undefined);
  assert.equal((await W.call("chris", `/${g}/session`, {})).status, 403, "Deaktivieren gibt Chris keine Steuerung");
  assert.equal((await W.call("giuliano", `/${g}/actions`, { session_id: s, action_id: "device.ping" })).body.code, "DEVICE_DISABLED");
  assert.equal((await pollOnce({ dir: W.dirs.giuliano, fetchImpl: W.fetchImpl })).code, "DEVICE_DISABLED");
  assert.ok((W.devMem.commands.peek().commands).every((c) => c.status === "cancelled"));
  assert.equal((await W.call("mario", `/${g}/disable`, {})).status, 403, "nur Owner deaktiviert");
  assert.equal((await W.call("chris", `/${g}/enable`, {})).status, 200);
  const s2 = await W.call("giuliano", `/${g}/session`, {});
  assert.equal(s2.status, 200, "Eigentümer kann nach Freigabe wieder");
  assert.equal((await W.call("chris", `/${g}/actions`, { session_id: s2.body.session_id, action_id: "device.ping" })).status, 403);
  const audit = W.devMem.audit.peek().entries.map((e) => e.action);
  for (const a of ["device.pair_start", "device.paired", "device.session_opened", "device.disabled", "device.enabled"]) assert.ok(audit.includes(a), a);
  assert.ok(W.devMem.audit.peek().entries.some((e) => e.result === "blocked_cross_user" && e.actor_user_id === "chris" && e.owner_user_id === "giuliano"));
  fs.rmSync(W.tmp, { recursive: true, force: true });
});

test("TF-073 Kopplung: nur eigenes Konto, Einmal-Code mit Ablauf, kein Replay, Widerruf, deaktiviertes Konto, Rotation", async () => {
  const W = await world();
  // Fremdes Konto koppeln: blockiert – auch Chris nicht für Verkäufer.
  for (const [a, b] of [["giuliano", "chris"], ["mario", K], ["chris", "giuliano"], [K, "damiano"]]) {
    const r = await W.call(a, "/pair/start", { owner_user_id: b });
    assert.deepEqual([r.status, r.body.code], [403, "PAIR_OTHER_USER"], `${a} → ${b}`);
  }
  assert.equal((await W.call(null, "/pair/start", {})).status, 401, "ohne Sitzung kein Code");
  // Eigenes Gerät: erlaubt; Code ist an den erzeugenden Benutzer gebunden.
  const own = await W.pair("mario");
  assert.deepEqual([own.ok, own.owner_user_id], [true, "mario"]);
  // Wiederverwendeter Code: blockiert.
  const reuse = await pairDevice({ cloud: ORIGIN, code: own.pairing_code, name: "Fremd", dir: path.join(W.tmp, "x1"), fetchImpl: W.fetchImpl });
  assert.deepEqual([reuse.ok, reuse.status, reuse.code], [false, 403, "PAIRING_USED"]);
  // Abgelaufener Code: blockiert.
  const exp = (await W.call("damiano", "/pair/start", {})).body.pairing_code;
  W.advance(PAIRING_TTL_MS + 1000);
  const expired = await pairDevice({ cloud: ORIGIN, code: exp, name: "Damiano PC", dir: W.dirs.damiano, fetchImpl: W.fetchImpl });
  assert.deepEqual([expired.ok, expired.code], [false, "PAIRING_EXPIRED"]);
  // Falscher Ablauf (flow) und Phantasie-Code: ungültig.
  const c2 = (await W.call("damiano", "/pair/start", {})).body.pairing_code;
  const wrongFlow = await W.devices(makeReq("/api/devices/pair/complete", { method: "POST", origin: null, body: { flow: "login", pairing_code: c2, device_fp: "a".repeat(64), device_name: "PC", device_type: "pc" } }));
  assert.equal(wrongFlow.status, 403);
  assert.equal((await pairDevice({ cloud: ORIGIN, code: "Z".repeat(32), name: "PC", dir: W.dirs.damiano, fetchImpl: W.fetchImpl })).code, "PAIRING_INVALID");
  assert.equal((await pairDevice({ cloud: ORIGIN, code: c2, name: "Damiano PC", dir: W.dirs.damiano, fetchImpl: W.fetchImpl })).ok, true, "derselbe Code bleibt nach falschem flow gültig");
  // Höchstens 3 offene Codes.
  for (let i = 0; i < 3; i++) assert.equal((await W.call(K, "/pair/start", {})).status, 200);
  assert.equal((await W.call(K, "/pair/start", {})).status, 429);
  // Gerät, das schon aktiv einem anderen Konto gehört: nicht übernehmbar.
  const steal = await W.pair("giuliano", { dir: W.dirs.mario });
  assert.deepEqual([steal.ok, steal.code], [false, "DEVICE_OWNED_ELSEWHERE"]);
  // Rotation: neues Credential, altes ungültig.
  const old = loadCredential(W.dirs.mario).credential;
  assert.equal((await rotateCredential({ dir: W.dirs.mario, fetchImpl: W.fetchImpl })).ok, true);
  assert.notEqual(loadCredential(W.dirs.mario).credential, old);
  const oldTry = await W.devices(makeReq("/api/devices/channel", { method: "POST", origin: null, headers: { [DEVICE_HEADER]: old, [DEVICE_FP_HEADER]: loadIdentity(W.dirs.mario).fp }, body: { op: "poll" } }));
  assert.equal(oldTry.status, 401);
  assert.equal((await pollOnce({ dir: W.dirs.mario, fetchImpl: W.fetchImpl })).ok, true);
  // Widerruf durch den Eigentümer: kein Reconnect, keine Befehle, alte Sitzung tot.
  const m = own.device_id;
  const sess = (await W.call("mario", `/${m}/session`, {})).body.session_id;
  await W.call("mario", `/${m}/actions`, { session_id: sess, action_id: "device.ping" });
  assert.equal((await W.call("chris", `/${m}/revoke`, {})).status, 403, "Chris widerruft keine fremden Geräte");
  assert.equal((await W.call("mario", `/${m}/revoke`, {})).status, 200);
  assert.equal((await pollOnce({ dir: W.dirs.mario, fetchImpl: W.fetchImpl })).status, 401, "widerrufenes Gerät verbindet sich nicht");
  assert.equal((await rotateCredential({ dir: W.dirs.mario, fetchImpl: W.fetchImpl })).ok, false);
  assert.equal((await W.call("mario", `/${m}/actions`, { session_id: sess, action_id: "device.ping" })).body.code, "DEVICE_REVOKED");
  assert.equal((await W.call("mario", `/${m}/session`, {})).body.code, "DEVICE_REVOKED");
  assert.equal((await W.call("mario", "")).body.code, "DEVICE_NOT_PAIRED", "kein Fallback auf Chris' Computer");
  assert.equal((await W.call("chris", `/${m}/enable`, {})).status, 409, "widerrufen bleibt widerrufen");
  // Eigentümerwechsel nur über Owner-Freigabe + neue Kopplung + Audit (nie owner_user_id umschreiben).
  const before = await W.pair("giuliano", { dir: W.dirs.mario });
  assert.equal(before.code, "DEVICE_OWNED_ELSEWHERE");
  assert.equal((await W.call("mario", `/${m}/release`, {})).status, 403);
  assert.equal((await W.call("chris", `/${m}/release`, {})).status, 200);
  const after = await W.pair("giuliano", { dir: W.dirs.mario });
  assert.deepEqual([after.ok, after.owner_user_id], [true, "giuliano"]);
  assert.notEqual(after.device_id, m, "neue Geräte-ID – alter Datensatz bleibt Mario");
  assert.equal(W.devMem.devices.peek().devices[m].owner_user_id, "mario");
  assert.ok(W.devMem.audit.peek().entries.some((e) => e.action === "device.released_for_repairing" && e.actor_user_id === "chris"));
  assert.ok(W.devMem.audit.peek().entries.some((e) => e.action === "device.revoked" && e.device_id === m));
  fs.rmSync(W.tmp, { recursive: true, force: true });
});

test("TF-073 Konto deaktiviert: alle Geräte-Sitzungen des Verkäufers enden, Agent erhält keine Befehle, Geräte gehen nicht an Chris", async () => {
  const W = await world();
  const k = (await W.pair(K, { type: "phone" })).device_id;
  const s = (await W.call(K, `/${k}/session`, {})).body.session_id;
  assert.equal((await W.call(K, `/${k}/actions`, { session_id: s, action_id: "device.ping" })).status, 200);
  const off = await W.auth(makeReq("/api/auth/admin/active", { method: "POST", cookie: W.S.cookies.chris, body: { user_id: K, active: false } }));
  assert.equal(off.status, 200);
  assert.ok(Object.values(W.devMem.sessions.peek().sessions).every((x) => x.closed_at && x.close_reason === "account_disabled"));
  assert.ok(W.devMem.commands.peek().commands.every((c) => c.status === "cancelled"));
  assert.equal((await pollOnce({ dir: W.dirs[K], fetchImpl: W.fetchImpl })).code, "ACCOUNT_DISABLED");
  assert.equal((await W.call("chris", `/${k}/session`, {})).status, 403, "Gerät geht nicht an Chris über");
  assert.equal(W.devMem.devices.peek().devices[k].owner_user_id, K);
  assert.ok(W.devMem.audit.peek().entries.some((e) => e.action === "account.disabled" && e.owner_user_id === K && e.sessions === 1));
  // Auch ohne Hook: der Kanal prüft den Kontostatus selbst (fail closed).
  const W2 = await world();
  const d2 = (await W2.pair("damiano")).device_id;
  await W2.S.auth(makeReq("/api/auth/admin/active", { method: "POST", cookie: W2.S.cookies.chris, body: { user_id: "damiano", active: false } }));
  assert.equal((await pollOnce({ dir: W2.dirs.damiano, fetchImpl: W2.fetchImpl })).code, "ACCOUNT_DISABLED");
  assert.ok(d2);
  fs.rmSync(W.tmp, { recursive: true, force: true }); fs.rmSync(W2.tmp, { recursive: true, force: true });
});

test("TF-073 keine Secrets im Speicher/Audit, Befehl trägt requesting_user_id/device_id/owner_user_id/action_id, nur erlaubte Aktionen", async () => {
  const W = await world();
  const c = await W.pair("chris");
  const s = (await W.call("chris", `/${c.device_id}/session`, {})).body.session_id;
  assert.equal((await W.call("chris", `/${c.device_id}/actions`, { session_id: s, action_id: "file.read" })).status, 400);
  assert.equal((await W.call("chris", `/${c.device_id}/actions`, { session_id: s, action_id: "shell.exec" })).status, 400);
  assert.equal((await W.call("chris", `/${c.device_id}/actions`, { action_id: "device.ping" })).body.code, "SESSION_INVALID");
  const ok = await W.call("chris", `/${c.device_id}/actions`, { session_id: s, action_id: "device.ping" });
  const cmd = W.devMem.commands.peek().commands.find((x) => x.command_id === ok.body.command_id);
  assert.deepEqual([cmd.requesting_user_id, cmd.device_id, cmd.owner_user_id, cmd.action_id], ["chris", c.device_id, "chris", "device.ping"]);
  // Sitzung läuft ab und wird nicht verlängert.
  W.advance(31 * 60_000);
  assert.equal((await W.call("chris", `/${c.device_id}/actions`, { session_id: s, action_id: "device.ping" })).body.code, "SESSION_INVALID");
  assert.deepEqual((await pollOnce({ dir: W.dirs.chris, fetchImpl: W.fetchImpl })).done, [], "abgelaufene Sitzung → Befehl nicht ausgeliefert");
  const secret = loadCredential(W.dirs.chris).credential.split(".")[1];
  const all = JSON.stringify(Object.fromEntries(Object.entries(W.devMem).map(([k, v]) => [k, v.peek()])));
  assert.ok(!all.includes(secret), "Geräte-Secret nie im Klartext gespeichert");
  assert.ok(!all.includes(c.pairing_code), "Kopplungs-Code nie im Klartext");
  assert.ok(!all.includes(s), "Sitzungs-Token nie im Klartext");
  const audit = JSON.stringify(W.devMem.audit.peek());
  assert.ok(!/credential_hash|device_fp|secret|pairing_code/.test(audit));
  // Geräte-Liste des Eigentümers: keine Secrets/Fingerprints.
  const mine = await W.call("chris", "");
  assert.ok(!JSON.stringify(mine.body).includes(loadIdentity(W.dirs.chris).fp));
  assert.ok(!("credential_hash" in mine.body.devices[0]));
  fs.rmSync(W.tmp, { recursive: true, force: true });
});

// ================= Provision 60 % (TF-072-Logik, hier nur verifiziert) =================
const AFTER = "2026-10-17T08:00:00.000Z", BEFORE = "2026-10-16T03:00:00.000Z";
const snap = (order_id, domain, offer_class, market, currency, price, created_at, x = {}) => ({ order_id, domain, offer_class, market, currency, price_amount: price, paid_amount: price,
  state: "COMPLETED", payment_status: "PAID_FULL", created_at, ...x });
const derive = (ledger, orders, seller) => deriveLedger({ ledger, orders: ordersFromSnapshot({ repair: { orders } }),
  resolveSeller: (o) => ({ seller_id: typeof seller === "function" ? seller(o) : seller, lead_id: o.domain, source: "test" }), now: new Date("2026-10-18T08:00:00Z") });
const base = () => ({ ...emptyLedger(), eligible_from: "2026-10-01T00:00:00.000Z" });

test("TF-073 Provision: Giuliano/Mario/Damiano/Kudoshin 6000 bps, Chris 0, neue Beträge aus bps, 3500-Historie unverändert", () => {
  assert.equal(SELLER_COMMISSION_BPS, 6000);
  assert.equal(COMMISSION_BPS_SCHEDULE.at(-1).bps, 6000);
  for (const u of SELLER) { assert.equal(RATE_BPS[u], 6000, u); assert.equal(publicUser(u).commission_rate_bps, 6000, u); assert.equal(USERS[u].commission_rate_bps, 6000); }
  assert.deepEqual(SELLERS, SELLER);
  assert.equal(publicUser("chris").commission_rate_bps, 0);
  const P = MARKET_PRICES;
  const exp = [["CH", "CHF", P.CH.offers.CHECK.price, "90.00"], ["CH", "CHF", P.CH.offers.FIX.price, "288.00"], ["VN", "VND", P.VN.offers.CHECK.price, "594000"], ["VN", "VND", P.VN.offers.FIX.price, "2340000"]];
  assert.deepEqual(exp.map((e) => e[2]), [150, 480, 990000, 3900000]);
  for (const [, cur, price, want] of exp) assert.equal(fromMinor(commissionMinor(toMinor(price, cur), SELLER_COMMISSION_BPS), cur), want);
  const L = derive(base(), [snap("CA150-20261017-ccccc1", "a.ch", "REPAIR_CHECK_150", "CH", "CHF", 150, AFTER), snap("VNFIX-20261017-ccccc2", "d.vn", "VN_REPAIR_FIX", "VN", "VND", 3900000, AFTER)],
    (o) => (o.market === "VN" ? K : "damiano")).ledger;
  assert.equal(fromMinor(L.entries["CA150-20261017-ccccc1"].payable_minor, "CHF"), "90.00");
  assert.equal(fromMinor(L.entries["VNFIX-20261017-ccccc2"].payable_minor, "VND"), "2340000");
  // Historischer 3500-bps-Eintrag bleibt 3500.
  const id = "VNCHECK-20261016-ccccc3";
  const ledger = { ...base(), entries: { [id]: { order_id: id, market: "VN", currency: "VND", created_at: BEFORE, seller_id: K, seller_override: null, seller_locked: true, seller_source: "vn_default",
    lead_id: "c.vn", rate_bps: 3500, price_minor: 990000, paid_minor: 990000, base_minor: 990000, expected_minor: 346500, payable_minor: 346500, reversed_minor: 0,
    order_state: "COMPLETED", payment_status: "PAID_FULL", status: "PAYABLE", history: [] } } };
  const e = derive(ledger, [snap(id, "c.vn", "VN_REPAIR_CHECK", "VN", "VND", 990000, BEFORE)], K).ledger.entries[id];
  assert.deepEqual([e.rate_bps, e.payable_minor], [3500, 346500]);
  assert.equal(commissionBpsAt(BEFORE), 3500);
});

test("TF-073 kein Mesh: kein globaler Geräte-Token, keine Peer-Liste, keine Inbound-Ports im Geräte-Code", () => {
  const src = ["device-core.js", "device-api.js", "device-agent.js"].map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  assert.ok(!/createServer|\.listen\(|net\.Server|dgram/.test(src), "Agent öffnet keinen Port");
  assert.ok(!/JARVIS_DEVICE_TOKEN|env\(["']JARVIS_[A-Z_]*DEVICE/.test(src), "kein globaler Geräte-Token aus der Umgebung");
  assert.ok(!/tailscale|wireguard|peers?\s*:/i.test(src.replace(/kein Mesh, keine Peers|keine Peer-to-Peer|kein Mesh, kein gemeinsamer/g, "")), "kein Mesh/Overlay");
  assert.ok(PAIRING_FLOW === "device_pair");
});
