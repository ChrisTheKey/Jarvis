// TF-074: Chris' lokaler Jarvis → Geräte-Credential (Legacy JARVIS_SYNC_TOKEN bleibt in der Übergangszeit nur für Chris), sichere lokale
// Fähigkeiten je Gerätetyp, Arbeitsbereich-Wächter, Tresor (DPAPI), Migrationsstatus, keine Quer-Zugriffe.
process.env.JARVIS_DEVICE_KEY_PROTECTION ||= "file"; // DPAPI wird unten gezielt einmal echt geprüft
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, makeReq, ORIGIN, env, ENV } from "./tf063-helpers.js";
import { memoryStore, createStateHandler } from "../shared-state.js";
import { authStoreFrom, resolveActor } from "../auth-core.js";
import { createAuthHandler } from "../auth-api.js";
import { createDeviceHandler, createStateDeviceAuth, terminateUserDevices } from "../device-api.js";
import { deviceStoreFrom, DEVICE_HEADER, DEVICE_FP_HEADER, DEVICE_CV_HEADER, PAIRING_TTL_MS, ONLINE_MS, capabilitiesFor, authorizeDeviceAccess, migrationStatus } from "../device-core.js";
import { pairDevice, pollOnce, rotateCredential, loadCredential, loadIdentity, deviceStatus, DEFAULT_HANDLERS } from "../device-agent.js";
import { createVault, loadDeviceAuth, forgetVaultKeys, dpapi } from "../device-vault.js";
import { resolveWorkspacePath, readWorkspaceFile, projectStatusSummary } from "../device-workspace.js";
import { createLocalState, syncWithCloud, deviceSyncAuth } from "../local-state.js";
import { SELLER_COMMISSION_BPS, commissionBpsAt } from "../pricing.js";
import { RATE_BPS } from "../commission-ledger.js";
import { publicUser } from "../auth-core.js";

const K = "Kudoshin";
const ALL = ["chris", "giuliano", "mario", "damiano", K];
const SELLER = ["giuliano", "mario", "damiano", K];
const STATE_URL = `${ORIGIN}/api/state`;

async function world({ deployed = false } = {}) {
  let clock = new Date("2026-10-17T08:00:00.000Z");
  const now = () => { clock = new Date(+clock + 1); return new Date(clock); };
  const S = await setup({ ch: 20, vn: 4, now });
  const getAuthStore = async () => authStoreFrom((k) => (S.authMem[k] ||= memoryStore()));
  const devMem = {};
  const devStore = deviceStoreFrom((k) => (devMem[k] ||= memoryStore()));
  const getStore = async () => devStore;
  const devices = createDeviceHandler({ getStore, getAuthStore, now, env, deployed, resolveActor: (req) => resolveActor(req, { env, getAuthStore, now }) });
  const auth = createAuthHandler({ env, getStore: getAuthStore, now, onUserDisabled: (user_id, actor_user_id) => terminateUserDevices(devStore, { user_id, actor_user_id, now: now() }) });
  const stateMem = memoryStore();
  const state = createStateHandler({ env, now, getStore: async () => stateMem, resolveActor: (req) => resolveActor(req, { env, getAuthStore, now }),
    verifyDevice: createStateDeviceAuth({ getStore, getAuthStore, now }) });
  // Gerät spricht nur mit /api/devices/* und /api/state (ausgehend).
  const fetchImpl = async (url, init) => (new URL(url).pathname === "/api/state" ? state : devices)(new Request(url, init));
  const call = async (user, p, body, method = body === undefined ? "GET" : "POST") => {
    const res = await devices(makeReq(`/api/devices${p}`, { method, cookie: user ? S.cookies[user] : undefined, body }));
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf074-"));
  const dirs = Object.fromEntries(ALL.map((u) => [u, path.join(tmp, u)]));
  const pair = async (user, { name = `${user} PC`, type = "desktop", dir = dirs[user] } = {}) => {
    const s = await call(user, "/pair/start", {});
    assert.equal(s.status, 200, `${user} pair/start`);
    return { ...(await pairDevice({ cloud: ORIGIN, code: s.body.pairing_code, name, type, dir, fetchImpl })), pairing_code: s.body.pairing_code };
  };
  const local = createLocalState({ file: path.join(tmp, "mirror.json"), now });
  const sync = (config) => syncWithCloud({ local, fetchFn: fetchImpl, now, force: true, config: { url: STATE_URL, authMode: "auto", ...config } });
  const chan = (headers, body = { op: "poll" }) => devices(makeReq("/api/devices/channel", { method: "POST", origin: null, headers, body }));
  const hdr = (u) => { const c = loadCredential(dirs[u]); return { [DEVICE_HEADER]: c.credential, [DEVICE_FP_HEADER]: loadIdentity(dirs[u]).fp, [DEVICE_CV_HEADER]: String(c.credential_version) }; };
  return { S, auth, devices, state, stateMem, devMem, devStore, call, pair, fetchImpl, dirs, tmp, local, sync, chan, hdr, advance: (ms) => { clock = new Date(+clock + ms); }, now,
    done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
const audit = (W) => W.devMem.audit?.peek()?.entries || [];

test("TF-074 Legacy: JARVIS_SYNC_TOKEN gleicht Chris' Zustand weiter ab – auch neben gekoppeltem Gerät; nie für Verkäufer oder als Geräte-Credential", async () => {
  const W = await world();
  const legacy = await W.sync({ token: ENV.JARVIS_SYNC_TOKEN });
  assert.deepEqual([legacy.ok, legacy.auth], [true, "legacy"], "Legacy-Sync funktioniert");
  assert.ok(W.stateMem.peek().sync.lastClientPushAt);
  await W.pair("chris");
  assert.equal((await W.sync({ token: ENV.JARVIS_SYNC_TOKEN, authMode: "legacy", device: deviceSyncAuth({ dir: W.dirs.chris, url: STATE_URL }) })).auth, "legacy", "erzwungen Legacy");
  // Legacy-Token öffnet keine Geräte-Steuerung und keine Verkäufer-Identität.
  for (const h of [{ "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }, { [DEVICE_HEADER]: ENV.JARVIS_SYNC_TOKEN, [DEVICE_FP_HEADER]: "a".repeat(64) }]) {
    assert.equal((await W.chan(h)).status, 401);
    for (const p of ["", "/admin", "/migration"]) assert.equal((await W.devices(makeReq(`/api/devices${p}`, { headers: h }))).status, 401, p);
  }
  assert.equal((await W.devices(makeReq("/api/devices/pair/start", { method: "POST", headers: { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }, body: {} }))).status, 401);
  W.done();
});

test("TF-074 Chris-Gerät: Kopplung (DESKTOP), Credential nur verschlüsselt lokal + nur Hash in der Cloud, Code verbraucht, Sync per Geräte-Credential", async () => {
  const W = await world();
  const p = await W.pair("chris", { name: "Chris Jarvis PC" });
  assert.deepEqual([p.ok, p.owner_user_id, p.device_type], [true, "chris", "pc"]);
  const rec = W.devMem.devices.peek().devices[p.device_id];
  for (const k of ["device_id", "owner_user_id", "device_type", "device_name", "created_at", "last_seen_at", "status", "credential_hash", "credential_version"]) assert.ok(k in rec, k);
  assert.deepEqual([rec.owner_user_id, rec.device_type, rec.status, rec.credential_version], ["chris", "pc", "active", 1]);
  const secret = loadCredential(W.dirs.chris).credential.split(".")[1];
  assert.match(rec.credential_hash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(Object.fromEntries(Object.entries(W.devMem).map(([k, v]) => [k, v.peek()]))).includes(secret), "Server: nur Hash");
  // Lokal: kein Klartext-Credential, verschlüsselter Tresor.
  const files = fs.readdirSync(W.dirs.chris).sort();
  assert.deepEqual(files, ["credential.enc", "identity.enc", "vault.key"]);
  for (const f of ["credential.enc", "identity.enc"]) assert.ok(!fs.readFileSync(path.join(W.dirs.chris, f), "utf8").includes(secret), f);
  const st = deviceStatus(W.dirs.chris);
  assert.deepEqual([st.paired, st.owner_user_id, st.device_type, st.credential_version], [true, "chris", "pc", 1]);
  assert.ok(!JSON.stringify(st).includes(secret), "Status zeigt kein Credential");
  // Code ist verbraucht.
  const again = await pairDevice({ cloud: ORIGIN, code: p.pairing_code, name: "Zweit", dir: path.join(W.tmp, "re"), fetchImpl: W.fetchImpl });
  assert.equal(again.code, "PAIRING_USED");
  // Authentifizierung + Abgleich per Geräte-Credential.
  const dev = deviceSyncAuth({ dir: W.dirs.chris, url: STATE_URL });
  assert.equal(dev.owner_user_id, "chris");
  const r = await W.sync({ token: ENV.JARVIS_SYNC_TOKEN, device: dev });
  assert.deepEqual([r.ok, r.auth, r.fallback], [true, "device", undefined]);
  const r2 = await W.sync({ token: "", device: dev, authMode: "device" });
  assert.deepEqual([r2.ok, r2.auth], [true, "device"], "auch ganz ohne Legacy-Token");
  assert.equal(W.local.read().syncStatus.auth, "device");
  const d = W.devMem.devices.peek().devices[p.device_id];
  assert.equal(d.sync_ok_count, 2);
  assert.ok(d.last_auth_at && d.last_seen_at);
  assert.ok(audit(W).some((e) => e.action === "device.authenticated" && e.device_id === p.device_id && e.purpose === "state_sync"));
  // Geräte-Header kommen nur für Chris' DESKTOP derselben Cloud zustande.
  assert.equal(deviceSyncAuth({ dir: W.dirs.chris, url: "https://andere-cloud.example/api/state" }), null);
  W.done();
});

test("TF-074 Fähigkeiten: Chris' eigene sichere Aktionen PASS, Ergebnisse ohne Dateiinhalt; freie Befehle/Pfade blockiert", async () => {
  const W = await world();
  const c = (await W.pair("chris")).device_id;
  const s = (await W.call("chris", `/${c}/session`, {})).body.session_id;
  const caps = (await W.call("chris", `/${c}`)).body.actions.map((a) => a.action_id);
  for (const a of ["get_agent_status", "get_system_status", "sync_jarvis_state", "read_jarvis_project_status", "run_predefined_jarvis_health_check"]) assert.ok(caps.includes(a), a);
  let syncCalls = 0;
  const handlers = { ...DEFAULT_HANDLERS, sync_jarvis_state: async () => { syncCalls++; const r = await W.sync({ device: deviceSyncAuth({ dir: W.dirs.chris, url: STATE_URL }) }); return { synced: r.ok, auth: r.auth }; } };
  const prevPort = process.env.PORT; process.env.PORT = "9"; // Health-Check fragt nur 127.0.0.1 (hier: unbenutzter Port)
  const ids = [];
  for (const action_id of ["get_agent_status", "get_system_status", "sync_jarvis_state", "read_jarvis_project_status", "run_predefined_jarvis_health_check", "heartbeat"]) {
    const q = await W.call("chris", `/${c}/actions`, { session_id: s, action_id });
    assert.equal(q.status, 200, action_id); ids.push([action_id, q.body.command_id]);
  }
  const polled = await pollOnce({ dir: W.dirs.chris, fetchImpl: W.fetchImpl, handlers });
  if (prevPort === undefined) delete process.env.PORT; else process.env.PORT = prevPort;
  assert.ok(polled.done.every((x) => x.ok), JSON.stringify(polled.done));
  assert.equal(syncCalls, 1);
  const cmds = Object.fromEntries((await W.call("chris", `/${c}`)).body.commands.map((x) => [x.action_id, x]));
  assert.equal(cmds.get_agent_status.result.agent_build, "tf074-1");
  assert.equal(typeof cmds.get_system_status.result.mem_used_pct, "number");
  assert.deepEqual([cmds.sync_jarvis_state.result.synced, cmds.sync_jarvis_state.result.auth], [true, "device"]);
  const ps = cmds.read_jarvis_project_status.result;
  assert.equal(ps.readable, true); assert.match(ps.current_tf, /^TF-\d{3}$/);
  assert.ok(Object.keys(ps).every((k) => ["readable", "bytes", "last_update", "current_tf"].includes(k)), "nur Kopfdaten, kein Inhalt");
  assert.equal(cmds.run_predefined_jarvis_health_check.result.local_core_ok, false);
  assert.equal(cmds.run_predefined_jarvis_health_check.result.project_state_readable, true);
  for (const [a] of ids) assert.ok(audit(W).some((e) => e.action === "device.action_queued" && e.action_id === a), `Audit erlaubte Fähigkeit ${a}`);
  // Freie Befehle: unbekannte Aktionen und Zusatzfelder.
  for (const action_id of ["exec", "powershell", "cmd", "bash", "shell.exec", "file.read", "exec(command)"]) {
    const r = await W.call("chris", `/${c}/actions`, { session_id: s, action_id });
    assert.deepEqual([r.status, r.body.code], [400, "UNKNOWN_ACTION"], action_id);
  }
  for (const extra of [{ command: "whoami" }, { cmd: "dir" }, { args: ["-c", "x"] }, { path: "C:\\Windows\\win.ini" }, { params: { file: "../.env" } }, { Script: "x" }]) {
    const r = await W.call("chris", `/${c}/actions`, { session_id: s, action_id: "get_agent_status", ...extra });
    assert.deepEqual([r.status, r.body.code], [400, "ARBITRARY_COMMAND_BLOCKED"], JSON.stringify(extra));
  }
  assert.ok(audit(W).some((e) => e.result === "blocked_arbitrary_command"));
  assert.equal(W.devMem.commands.peek().commands.filter((x) => x.status === "queued").length, 0, "nichts Freies eingereiht");
  // Agent: auch ein (gefälschter) Server-Befehl ausserhalb der Liste wird nicht ausgeführt.
  let reported = null;
  const fake = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.op === "poll") return new Response(JSON.stringify({ device_id: c, owner_user_id: "chris", device_type: "pc", commands: [{ command_id: "cmd_AAAAAAAAAAAAAAAAAAAAAA", action_id: "shell.exec", owner_user_id: "chris", requesting_user_id: "chris" }] }));
    reported = b; return new Response("{}");
  };
  const ran = await pollOnce({ dir: W.dirs.chris, fetchImpl: fake, handlers: { ...handlers, "shell.exec": async () => { throw new Error("darf nie laufen"); } } });
  assert.deepEqual(ran.done, [{ command_id: "cmd_AAAAAAAAAAAAAAAAAAAAAA", ok: false }]);
  assert.deepEqual(reported.result, { error: "rejected" });
  W.done();
});

test("TF-074 Isolation: Chris → Verkäufer-Gerät 403, Verkäufer → Chris-Gerät 403, Verkäufer eigenes Gerät PASS, ohne Gerät DEVICE_NOT_PAIRED (kein Fallback)", async () => {
  const W = await world();
  // Ohne Gerät: alle Verkäufer DEVICE_NOT_PAIRED – auch wenn Chris gekoppelt ist.
  const c = (await W.pair("chris")).device_id;
  for (const u of SELLER) {
    const l = await W.call(u, "");
    assert.deepEqual([l.status, l.body.code, l.body.devices.length], [200, "DEVICE_NOT_PAIRED", 0], u);
  }
  const dev = {};
  for (const u of SELLER) {
    const p = await W.pair(u, { type: u === K ? "phone" : "desktop" });
    assert.deepEqual([p.ok, p.owner_user_id], [true, u]); dev[u] = p.device_id;
    const s = await W.call(u, `/${dev[u]}/session`, {});
    assert.equal(s.status, 200, `${u} eigenes Gerät`);
    const a = await W.call(u, `/${dev[u]}/actions`, { session_id: s.body.session_id, action_id: "get_agent_status" });
    assert.equal(a.status, 200);
    assert.deepEqual((await pollOnce({ dir: W.dirs[u], fetchImpl: W.fetchImpl })).done, [{ command_id: a.body.command_id, ok: true }], `${u} PASS`);
  }
  const cs = (await W.call("chris", `/${c}/session`, {})).body.session_id;
  for (const u of SELLER) {
    for (const r of [await W.call("chris", `/${dev[u]}/session`, {}), await W.call("chris", `/${dev[u]}/actions`, { session_id: cs, action_id: "get_agent_status" }), await W.call("chris", `/${dev[u]}`)])
      assert.deepEqual([r.status, r.body.code], [403, "DEVICE_FORBIDDEN"], `chris → ${u}`);
    const us = (await W.call(u, `/${dev[u]}/session`, {})).body.session_id;
    for (const r of [await W.call(u, `/${c}/session`, {}), await W.call(u, `/${c}/actions`, { session_id: us, action_id: "get_agent_status" }), await W.call(u, `/${c}/actions`, { session_id: cs, action_id: "get_agent_status" })])
      assert.deepEqual([r.status, r.body.code], [403, "DEVICE_FORBIDDEN"], `${u} → chris`);
    for (const v of SELLER) if (v !== u) assert.equal((await W.call(u, `/${dev[v]}/session`, {})).status, 403, `${u} → ${v}`);
    assert.equal((await W.call(u, "/admin")).status, 403, `${u} Admin-Liste`);
    assert.equal((await W.call(u, "/migration")).status, 403, `${u} Migration`);
  }
  // Verkäufer-Gerät darf Chris' Owner-State nicht abgleichen; Credential eines Verkäufers wird nie zu Sync-Headern.
  for (const u of SELLER) {
    const r = await W.state(makeReq("/api/state", { method: "POST", origin: null, headers: W.hdr(u), body: { op: "sync", state: {} } }));
    assert.deepEqual([r.status, (await r.json()).code], [403, "DEVICE_SYNC_FORBIDDEN"], u);
    assert.equal(deviceSyncAuth({ dir: W.dirs[u], url: STATE_URL }), null);
  }
  assert.ok(audit(W).some((e) => e.result === "blocked_cross_user" && e.actor_user_id === "chris"));
  assert.ok(audit(W).some((e) => e.result === "blocked_cross_user" && e.owner_user_id === "chris" && e.actor_user_id !== "chris"));
  // Admin-Sicht für Chris: Metadaten aller Konten, kein Credential/keine Sitzung.
  const ov = await W.call("chris", "/admin");
  assert.deepEqual(ov.body.devices.map((d) => d.owner_user_id).sort(), [...ALL].sort());
  for (const u of ALL) assert.ok(!JSON.stringify(ov.body).includes(loadCredential(W.dirs[u]).credential.split(".")[1]));
  W.done();
});

test("TF-074 Gerätetyp: PHONE nur Status/Heartbeat – Desktop-Aktionen blockiert (Cloud UND Agent)", async () => {
  const W = await world();
  const k = (await W.pair(K, { type: "phone", name: "Kudoshin Phone" })).device_id;
  assert.deepEqual(capabilitiesFor("phone").map((x) => x.action_id).sort(), ["device.ping", "device.status", "get_agent_status", "heartbeat"]);
  const caps = (await W.call(K, "")).body.devices[0].capabilities;
  assert.ok(!caps.includes("get_system_status") && !caps.includes("read_jarvis_project_status"));
  const s = (await W.call(K, `/${k}/session`, {})).body.session_id;
  for (const action_id of ["get_system_status", "sync_jarvis_state", "read_jarvis_project_status", "run_predefined_jarvis_health_check"]) {
    const r = await W.call(K, `/${k}/actions`, { session_id: s, action_id });
    assert.deepEqual([r.status, r.body.code], [400, "DEVICE_ACTION_UNSUPPORTED"], action_id);
  }
  assert.equal((await W.call(K, `/${k}/actions`, { session_id: s, action_id: "heartbeat" })).status, 200);
  assert.equal(authorizeDeviceAccess({ requesting_user_id: K, device: { owner_user_id: K, status: "active", device_type: "phone" }, action_id: "get_system_status" }).code, "DEVICE_ACTION_UNSUPPORTED");
  // Agent eines Telefons führt eine Desktop-Aktion auch dann nicht aus, wenn sie (gefälscht) ankäme.
  let reported = null;
  const fake = async (url, init) => {
    const b = JSON.parse(init.body);
    if (b.op === "poll") return new Response(JSON.stringify({ device_id: k, owner_user_id: K, device_type: "phone", commands: [{ command_id: "cmd_BBBBBBBBBBBBBBBBBBBBBB", action_id: "read_jarvis_project_status", owner_user_id: K, requesting_user_id: K }] }));
    reported = b; return new Response("{}");
  };
  assert.deepEqual((await pollOnce({ dir: W.dirs[K], fetchImpl: fake })).done, [{ command_id: "cmd_BBBBBBBBBBBBBBBBBBBBBB", ok: false }]);
  assert.deepEqual(reported.result, { error: "rejected" });
  W.done();
});

test("TF-074 Kopplung/Credential: abgelaufen, wiederverwendet, widerrufen, rotiert (alte Version), Konto deaktiviert – alle blockiert", async () => {
  const W = await world();
  const exp = (await W.call("chris", "/pair/start", {})).body.pairing_code;
  W.advance(PAIRING_TTL_MS + 1000);
  assert.equal((await pairDevice({ cloud: ORIGIN, code: exp, name: "Chris PC", type: "desktop", dir: W.dirs.chris, fetchImpl: W.fetchImpl })).code, "PAIRING_EXPIRED");
  const p = await W.pair("chris");
  assert.equal((await pairDevice({ cloud: ORIGIN, code: p.pairing_code, name: "Zweit", dir: path.join(W.tmp, "zweit"), fetchImpl: W.fetchImpl })).code, "PAIRING_USED");
  // Rotation: Version 2, altes Credential (und alte Version) ungültig – für Kanal UND /api/state.
  const old = W.hdr("chris");
  const rot = await rotateCredential({ dir: W.dirs.chris, fetchImpl: W.fetchImpl });
  assert.deepEqual([rot.ok, rot.credential_version], [true, 2]);
  assert.equal(loadCredential(W.dirs.chris).credential_version, 2);
  assert.equal(W.devMem.devices.peek().devices[p.device_id].credential_version, 2);
  assert.equal((await W.chan(old)).status, 401, "altes Credential");
  assert.equal((await W.state(makeReq("/api/state", { method: "POST", origin: null, headers: old, body: { op: "sync", state: {} } }))).status, 401);
  assert.equal((await W.chan({ ...W.hdr("chris"), [DEVICE_CV_HEADER]: "1" })).status, 401, "neue Credential + alte Version");
  assert.equal((await W.chan(W.hdr("chris"))).status, 200);
  assert.ok(audit(W).some((e) => e.action === "device.credential_rotated" && e.credential_version === 2));
  assert.ok(audit(W).some((e) => e.action === "device.auth_blocked" && e.result === "credential_version_mismatch"));
  // Widerruf: Kanal + Sync per Gerät blockiert; Legacy (Übergang) hält Chris' lokalen Jarvis am Laufen.
  const before = W.hdr("chris");
  assert.equal((await W.call("chris", `/${p.device_id}/revoke`, {})).status, 200);
  assert.equal((await W.chan(before)).status, 401);
  assert.equal((await pollOnce({ dir: W.dirs.chris, fetchImpl: W.fetchImpl })).status, 401);
  const dev = deviceSyncAuth({ dir: W.dirs.chris, url: STATE_URL });
  assert.equal((await W.sync({ token: "", device: dev, authMode: "device" })).ok, false, "Geräte-Sync widerrufen");
  const fb = await W.sync({ token: ENV.JARVIS_SYNC_TOKEN, device: dev });
  assert.deepEqual([fb.ok, fb.auth, fb.fallback], [true, "legacy", "device_http_401"], "kein Rückschritt dank Legacy-Übergang");
  assert.ok(audit(W).some((e) => e.action === "device.revoked" && e.device_id === p.device_id));
  assert.ok(audit(W).some((e) => e.action === "device.auth_blocked" && e.result === "revoked"));
  assert.ok(W.devMem.migration.peek().revocation_verified_at, "Widerruf für die Migration nachgewiesen");
  // Konto deaktiviert: Gerät + Kopplung blockiert.
  const g = await W.pair("giuliano");
  const code = (await W.call("giuliano", "/pair/start", {})).body.pairing_code;
  assert.equal((await W.auth(makeReq("/api/auth/admin/active", { method: "POST", cookie: W.S.cookies.chris, body: { user_id: "giuliano", active: false } }))).status, 200);
  assert.equal((await pollOnce({ dir: W.dirs.giuliano, fetchImpl: W.fetchImpl })).code, "ACCOUNT_DISABLED");
  assert.equal((await pairDevice({ cloud: ORIGIN, code, name: "G2", dir: path.join(W.tmp, "g2"), fetchImpl: W.fetchImpl })).code, "ACCOUNT_DISABLED");
  assert.equal((await W.call("chris", `/${g.device_id}/session`, {})).status, 403, "deaktiviertes Konto → kein Zugriff für Chris");
  // Chris darf sperren (Admin), aber nie steuern.
  const m = (await W.pair("mario")).device_id;
  const dis = await W.call("chris", `/${m}/disable`, {});
  assert.equal(dis.status, 200); assert.equal(dis.body.device_credential, undefined); assert.equal(dis.body.session_id, undefined);
  assert.equal((await pollOnce({ dir: W.dirs.mario, fetchImpl: W.fetchImpl })).code, "DEVICE_DISABLED");
  assert.ok(audit(W).some((e) => e.action === "device.disabled" && e.owner_user_id === "mario" && e.actor_user_id === "chris"));
  // Audit enthält nie Secrets/Codes/Fingerprints.
  const a = JSON.stringify(audit(W));
  assert.ok(!/credential_hash|device_fp|secret|pairing_code|device_credential/.test(a));
  for (const u of ["chris", "mario"]) assert.ok(!a.includes(loadCredential(W.dirs[u]).credential.split(".")[1]));
  assert.ok(!a.includes(p.pairing_code) && !a.includes(ENV.JARVIS_SYNC_TOKEN));
  W.done();
});

test("TF-074 Migrationsstatus: LEGACY_SYNC_ACTIVE → DEVICE_CREDENTIAL_ACTIVE → READY_TO_RETIRE_LEGACY nur wenn ALLE Bedingungen erfüllt; Legacy wird nie gelöscht", async () => {
  const W = await world({ deployed: true });
  let m = (await W.call("chris", "/migration")).body;
  assert.deepEqual([m.state, m.ready_to_retire_legacy, m.legacy_sync_active], ["LEGACY_SYNC_ACTIVE", "NO", true]);
  assert.equal(m.checks.device_api_live, true); assert.equal(m.checks.chris_device_paired, false);
  // Ein Verkäufer-Gerät zählt nie für Chris' Migration.
  await W.pair("mario");
  assert.equal((await W.call("chris", "/migration")).body.checks.chris_device_paired, false);
  const p = await W.pair("chris");
  const dev = deviceSyncAuth({ dir: W.dirs.chris, url: STATE_URL });
  assert.equal((await W.sync({ token: ENV.JARVIS_SYNC_TOKEN, device: dev })).auth, "device");
  m = (await W.call("chris", "/migration")).body;
  assert.deepEqual([m.state, m.ready_to_retire_legacy, m.device_credential_active], ["DEVICE_CREDENTIAL_ACTIVE", "NO", true]);
  // Wiederholte Wiederverbindung (Pause > ONLINE_MS).
  for (let i = 0; i < 3; i++) { W.advance(ONLINE_MS + 1000); assert.equal((await W.sync({ device: dev, authMode: "device" })).ok, true); }
  m = (await W.call("chris", "/migration")).body;
  assert.equal(m.checks.repeated_reconnect_tested, true);
  assert.equal(m.ready_to_retire_legacy, "NO", "Widerruf + Regression noch offen");
  // Widerruf mit einem zweiten (Test-)Gerät von Chris nachweisen.
  const t = await W.pair("chris", { dir: path.join(W.tmp, "chris-test"), name: "Chris Test" });
  const th = { [DEVICE_HEADER]: loadCredential(path.join(W.tmp, "chris-test")).credential, [DEVICE_FP_HEADER]: loadIdentity(path.join(W.tmp, "chris-test")).fp };
  await W.call("chris", `/${t.device_id}/revoke`, {});
  assert.equal((await W.chan(th)).status, 401);
  m = (await W.call("chris", "/migration")).body;
  assert.equal(m.checks.revocation_tested, true);
  assert.equal(m.ready_to_retire_legacy, "NO");
  assert.equal((await W.call("chris", "/migration", { confirm: "irgendwas" })).status, 400);
  m = (await W.call("chris", "/migration", { confirm: "no_regression" })).body;
  assert.deepEqual([m.state, m.ready_to_retire_legacy], ["READY_TO_RETIRE_LEGACY", "YES"]);
  assert.equal(m.chris_device.device_id, p.device_id);
  assert.equal((await W.sync({ token: ENV.JARVIS_SYNC_TOKEN, authMode: "legacy" })).ok, true, "Legacy bleibt trotzdem gültig (nicht gelöscht)");
  for (const u of SELLER) assert.equal((await W.call(u, "/migration", { confirm: "no_regression" })).status, 403);
  // Ohne live Netlify-API nie READY.
  const off = migrationStatus({ devices: W.devMem.devices.peek(), migration: W.devMem.migration.peek(), legacy_configured: true, api_live: false });
  assert.deepEqual([off.state, off.ready_to_retire_legacy], ["DEVICE_CREDENTIAL_ACTIVE", "NO"]);
  assert.ok(!JSON.stringify(m).includes(dev.headers[DEVICE_HEADER].split(".")[1]));
  W.done();
});

test("TF-074 Arbeitsbereich: Traversal, absolute/UNC-Pfade, sensible Orte und Junction-Ausbruch blockiert; PROJECT_STATE lesbar", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf074ws-"));
  const root = path.join(tmp, "ws"), outside = path.join(tmp, "outside");
  fs.mkdirSync(path.join(root, ".secrets", "device"), { recursive: true }); fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(root, "workspace", "memory"), { recursive: true }); fs.mkdirSync(path.join(root, "deploy", "vps"), { recursive: true });
  fs.writeFileSync(path.join(root, "PROJECT_STATE.md"), "# PROJECT_STATE\n\nLetzte Aktualisierung: 2026-10-16 (TF-074)\n\n## TF-074 – x\n");
  fs.writeFileSync(path.join(root, "README.md"), "x"); fs.writeFileSync(path.join(outside, "geheim.txt"), "geheim");
  for (const f of [".env", ".secrets/device/credential.enc", "workspace/memory/chris.md", "deploy/vps/.env"]) fs.writeFileSync(path.join(root, f), "x");
  const roots = [root];
  assert.equal(resolveWorkspacePath("README.md", { roots }).ok, true);
  for (const p of ["../outside/geheim.txt", "..\\outside\\geheim.txt", "a/../../outside/geheim.txt", "./README.md", "..", "...", " README.md"])
    assert.equal(resolveWorkspacePath(p, { roots }).code, "PATH_TRAVERSAL_BLOCKED", p);
  for (const p of ["C:\\Windows\\win.ini", "/etc/passwd", "c:README.md", "~/.ssh/id_rsa", path.join(outside, "geheim.txt")])
    assert.equal(resolveWorkspacePath(p, { roots }).code, "PATH_ABSOLUTE_BLOCKED", p);
  for (const p of ["\\\\server\\share\\x.txt", "//server/share/x.txt", "\\\\?\\C:\\Windows\\win.ini", "\\\\.\\pipe\\x"])
    assert.equal(resolveWorkspacePath(p, { roots }).code, "PATH_UNC_BLOCKED", p);
  assert.equal(resolveWorkspacePath("README.md:stream", { roots }).code, "PATH_INVALID");
  for (const p of [".env", ".secrets/device/credential.enc", "workspace/memory/chris.md", "deploy/vps/.env", ".git/config", "data/lead_crm.json", "id_rsa", "AppData/Local/Google/Chrome/User Data/Default/Login Data", "jarvis_sync_token.json", ".ssh/known_hosts"])
    assert.equal(resolveWorkspacePath(p, { roots }).code, "PATH_SENSITIVE_BLOCKED", p);
  assert.equal(resolveWorkspacePath("README.md", { roots: [process.platform === "win32" ? "C:\\Windows" : "/etc"] }).code, "ROOT_SENSITIVE_BLOCKED");
  // Junction/Symlink im Arbeitsbereich, der nach aussen zeigt: blockiert.
  let linked = false;
  try { fs.symlinkSync(outside, path.join(root, "link"), "junction"); linked = true; } catch {}
  if (linked) assert.equal(resolveWorkspacePath("link/geheim.txt", { roots }).code, "PATH_ESCAPE_BLOCKED");
  // Feste Datei der Fähigkeit: nur Kopfdaten.
  const f = readWorkspaceFile("project_state", { roots });
  assert.equal(f.ok, true);
  assert.deepEqual(projectStatusSummary(f.text), { last_update: "2026-10-16", current_tf: "TF-074" });
  assert.equal(readWorkspaceFile("../.env", { roots }).code, "FILE_NOT_ALLOWED");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("TF-074 Tresor: TF-073-Klartext wird verschlüsselt übernommen; Windows: Schlüssel per DPAPI (CurrentUser) geschützt", { skip: false }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf074v-"));
  // Klartext aus TF-073 → .enc, Klartext gelöscht.
  const d1 = path.join(tmp, "legacy");
  fs.mkdirSync(d1);
  fs.writeFileSync(path.join(d1, "credential.json"), JSON.stringify({ cloud: ORIGIN, device_id: "dev_AAAAAAAAAAAAAAAAAAAAAA", owner_user_id: "chris", credential: "dev_AAAAAAAAAAAAAAAAAAAAAA." + "s".repeat(43) }));
  fs.writeFileSync(path.join(d1, "identity.json"), JSON.stringify({ key: "k".repeat(43) }));
  const a = loadDeviceAuth(d1, { protection: "file" });
  assert.equal(a.owner_user_id, "chris");
  assert.ok(!fs.existsSync(path.join(d1, "credential.json")) && !fs.existsSync(path.join(d1, "identity.json")));
  assert.ok(!fs.readFileSync(path.join(d1, "credential.enc"), "utf8").includes("s".repeat(43)));
  // Manipulierte Datei → Fehler statt falscher Daten (GCM).
  const enc = JSON.parse(fs.readFileSync(path.join(d1, "credential.enc"), "utf8"));
  enc.ct = Buffer.from("x".repeat(40)).toString("base64");
  fs.writeFileSync(path.join(d1, "credential.enc"), JSON.stringify(enc));
  assert.throws(() => createVault({ dir: d1, protection: "file" }).read("credential"));
  if (process.platform === "win32") {
    const d2 = path.join(tmp, "dpapi");
    const v = createVault({ dir: d2, protection: "dpapi" });
    v.write("credential", { credential: "geheim-" + "z".repeat(30) });
    const key = JSON.parse(fs.readFileSync(path.join(d2, "vault.key"), "utf8"));
    assert.deepEqual([key.protection, key.scope, "key" in key], ["dpapi", "CurrentUser", false]);
    forgetVaultKeys(); // neu entschlüsseln über DPAPI
    assert.equal(createVault({ dir: d2 }).read("credential").credential, "geheim-" + "z".repeat(30));
    assert.equal(dpapi("unprotect", dpapi("protect", Buffer.from("abc"))).toString(), "abc");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("TF-074 Trennung: JARVIS_SERVER_CONTROL_TOKEN ≠ Geräte-Credential, keine Inbound-Ports, keine Shell im Geräte-Code; Provision 60 % unverändert", async () => {
  const W = await world();
  await W.pair("chris");
  const h = W.hdr("chris");
  for (const hh of [h, { "x-jarvis-control": h[DEVICE_HEADER] }]) {
    const r = await W.S.server(makeReq("/api/server-control", { method: "POST", origin: null, headers: hh, body: { op: "pull" } }));
    assert.equal(r.status, 401, "Geräte-Credential öffnet keine VPS-Steuerung");
  }
  assert.equal((await W.chan({ [DEVICE_HEADER]: ENV.JARVIS_SERVER_CONTROL_TOKEN, [DEVICE_FP_HEADER]: "a".repeat(64) })).status, 401);
  assert.equal((await W.chan({ "x-jarvis-control": ENV.JARVIS_SERVER_CONTROL_TOKEN })).status, 401);
  const src = ["device-core.js", "device-api.js", "device-agent.js", "device-vault.js", "device-workspace.js"].map((f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  assert.ok(!/createServer|\.listen\(|net\.Server|dgram/.test(src), "kein offener Port");
  assert.ok(!/execSync|execFile|[^.\w]exec\(|\bspawn\(/.test(src.replace(/exec\(command\)/g, "")), "keine Shell-Ausführung");
  assert.ok(!/JARVIS_SERVER_CONTROL_TOKEN/.test(src), "Server-Control-Token nie im Geräte-Code");
  // Einzige Prozess-Nutzung: DPAPI im Tresor (feste PowerShell-Zeile, Daten nur per stdin).
  assert.equal((src.match(/spawnSync\(/g) || []).length, 1);
  // Provision TF-072/TF-073.
  assert.equal(SELLER_COMMISSION_BPS, 6000);
  for (const u of SELLER) { assert.equal(RATE_BPS[u], 6000, u); assert.equal(publicUser(u).commission_rate_bps, 6000, u); }
  assert.equal(publicUser("chris").commission_rate_bps, 0);
  assert.equal(commissionBpsAt("2026-10-16T03:00:00.000Z"), 3500, "Historie 35 %");
  assert.equal(commissionBpsAt("2026-10-17T08:00:00.000Z"), 6000);
  W.done();
});
