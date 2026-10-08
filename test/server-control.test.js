// Server Control: Cloud (Netlify) → VPS nur über feste Action-IDs. Keine Shell, keine Pfade, eigenes Secret, Audit, Redaction.
// Alles mit Mocks: kein Netzwerk, keine echte Mail, kein echter Neustart, keine destruktive Aktion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { ACTIONS, DANGEROUS, validateAction, redact, cleanResult, cleanSnapshot, createServerControlHandler, REQUEST_TTL_MS } from "../server-control.js";
import { safePath, readLogs, createVpsActions, createControlAgent, collectSnapshot, cleanLogLine, logSource, AUDIT_FILE, nextDelayMs } from "../server-agent.js";
import { memoryStore } from "../shared-state.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const CONTROL = "ctl-" + "c".repeat(40);
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SERVER_CONTROL_TOKEN: CONTROL, JARVIS_MAIL_WORKER_TOKEN: "worker-" + "w".repeat(40), JARVIS_SYNC_TOKEN: "sync-" + "s".repeat(40) };
const URL_ = "https://jarvis.test/api/server-control";
const req = (method, body, headers = {}, q = "") => new Request(URL_ + q, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const USER = { "x-jarvis-key": "pw-test" }, AGENT = { "x-jarvis-control": CONTROL };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-srv-"));

function setup({ env = ENV, t0 = Date.parse("2026-10-08T10:00:00Z") } = {}) {
  const store = memoryStore();
  let now = t0, n = 0;
  const handler = createServerControlHandler({ env: (k) => env[k], getStore: async () => store, now: () => new Date(now), newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  const call = async (...a) => { const r = await handler(req(...a)); return { status: r.status, body: await r.json() }; };
  return { store, call, handler, advance: (ms) => { now += ms; }, now: () => new Date(now) };
}
function fakeVps(dir, over = {}) {
  const calls = [];
  const snap = () => collectSnapshot({ dir, startedAt: "2026-10-08T09:00:00.000Z", core: { role: "vps", schema_version: 1, scheduler: { morning: { start: "09:30", limit: 50, executed: true }, afternoon: { start: "14:30", limit: 50, executed: false } }, backup: { last_at: new Date().toISOString(), ok: true, generations: 2 } },
    mail: { worker: "VPS ACTIVE", authority: "VPS", self: true, last_iteration_at: new Date().toISOString() }, queue: { pending: 0, processing: 0 }, backup: { last_at: new Date().toISOString(), ok: true, generations: 2 },
    healthy: () => true, lastIterationAt: new Date().toISOString(), env: { JARVIS_COMMIT: "abc1234", JARVIS_DEPLOYED_AT: "2026-10-08T08:00:00Z" } });
  const deps = {
    snapshot: snap,
    runBackup: async () => { calls.push("backup"); return { ok: true, generations: 3, offsite_ok: true }; },
    restartCore: () => ({ ok: true, restarted: "core", after: () => calls.push("restartCore") }),
    restartMailWorker: () => ({ ok: true, restarted: "mail_worker", after: () => calls.push("restartMailWorker") }),
    restartScheduler: () => ({ ok: true, restarted: "scheduler", after: () => calls.push("restartScheduler") }),
    ...over,
  };
  return { calls, snap, actions: createVpsActions({ dir, deps }) };
}
// Agent spricht direkt mit dem Handler (statt Netzwerk) – so läuft der ganze Weg Cloud → VPS ohne Windows.
const bridge = (handler) => async (url, init) => handler(new Request(url, init));

test("Allowlist: nur feste Action-IDs; READ/CONTROL getrennt, DANGEROUS immer gesperrt", () => {
  assert.equal(validateAction({ action: "system.health" }).tier, "read");
  assert.equal(validateAction({ action: "jarvis.restartCore" }).tier, "control");
  for (const a of DANGEROUS) { const v = validateAction({ action: a }); assert.equal(v.ok, false); assert.equal(v.code, "DANGEROUS_BLOCKED"); assert.equal(v.status, 403); }
  for (const a of DANGEROUS) assert.equal(Object.hasOwn(ACTIONS, a), false);
  for (const a of ["system.exec", "constructor", "__proto__", "toString", "hasOwnProperty", "jarvis.restartcore", "", null, 42])
    assert.equal(validateAction({ action: a }).ok, false, String(a));
  assert.equal(validateAction({ action: "system.health", command: "ls" }).code, "UNKNOWN_FIELD");
  assert.equal(validateAction({ action: "system.health", params: { path: "/etc" } }).code, "BAD_PARAMS");
});

test("Shell-Injection und beliebige Befehle werden abgelehnt", () => {
  for (const a of ["system.health; rm -rf /", "system.health && reboot", "$(reboot)", "`id`", "system.health|sh", "bash -c id", "docker exec x sh", "system.health\nreboot"])
    assert.equal(validateAction({ action: a }).ok, false, a);
  assert.equal(validateAction({ action: "service.logs", params: { source: "core; cat /etc/shadow" } }).code, "BAD_PARAMS");
  assert.equal(validateAction({ action: "service.logs", params: { source: "core", lines: "50; id" } }).code, "BAD_PARAMS");
  assert.equal(validateAction({ action: "service.logs", params: { source: "core", lines: 100000 } }).code, "BAD_PARAMS");
  // Kein exec/spawn/child_process im Server-Control-Code.
  for (const f of ["server-control.js", "server-agent.js", "netlify/functions/server-control.mjs"]) assert.doesNotMatch(read(f), /child_process|\bexec(Sync|File)?\(|\bspawn(Sync)?\(|eval\(|new Function/, f);
});

test("Pfad-Schutz: nur Jarvis-Dateien; /opt/fiverr, SSH, /etc/shadow, Secrets und .. werden abgelehnt", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "worker.log"), "");
  assert.ok(safePath(path.join(dir, "worker.log"), [dir]));
  const bad = ["/opt/fiverr/app/.env", "/opt/fiverr", "/root/.ssh/id_ed25519", "/home/fiverradmin/.ssh/authorized_keys", "/etc/shadow", "/etc/passwd",
    path.join(dir, "..", "..", "etc", "shadow"), path.join(dir, "gmail_token.json"), path.join(dir, "gmail_credentials.json"), path.join(dir, ".env"),
    path.join(dir, "backup_private.pem"), path.join(dir, "vps_worker.env"), path.join(dir, "fiverr", "x.log"), "", "a\0b"];
  for (const p of bad) assert.throws(() => safePath(p, [dir]), (e) => e.code === "PATH_DENIED", p);
});

test("valid READ action: Status sofort aus dem VPS-Snapshot (Cloud), ohne Windows", async () => {
  const s = setup();
  const dir = tmp();
  const vps = fakeVps(dir);
  const agent = createControlAgent({ dir, config: { url: "https://jarvis.test/api/state", controlToken: CONTROL }, actions: vps.actions, snapshot: vps.snap, fetchFn: bridge(s.handler), now: s.now });
  assert.equal((await agent.pollOnce()).status, 200);
  const r = await s.call("POST", { action: "system.resources" }, USER);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "done");
  assert.ok(r.body.result.mem_total > 0);
  const g = await s.call("GET", null, USER);
  assert.equal(g.status, 200);
  assert.equal(g.body.online, true);
  assert.equal(g.body.snapshot.mail.worker, "VPS ACTIVE");
  assert.equal(g.body.snapshot.deploy.commit, "abc1234");
  // READ erzeugt einen Audit-Eintrag mit request_id, Zeit, Aktion und Ergebnis.
  const ra = g.body.audit.find((a) => a.request_id === r.body.request_id);
  assert.deepEqual({ action: ra.action, tier: ra.tier, outcome: ra.outcome, source: ra.source }, { action: "system.resources", tier: "read", outcome: "success", source: "cloud-ui" });
  assert.ok(Date.parse(ra.ts));
  // Status veraltet → kein Raten.
  s.advance(4 * 60_000);
  assert.equal((await s.call("POST", { action: "docker.status" }, USER)).body.code, "SERVER_OFFLINE");
});

test("valid CONTROL action (Mock): Auftrag → VPS führt aus → Ergebnis + Audit; Neustart erst nach Rückmeldung", async () => {
  const s = setup();
  const dir = tmp();
  const vps = fakeVps(dir);
  const agent = createControlAgent({ dir, config: { url: "https://jarvis.test", controlToken: CONTROL }, actions: vps.actions, snapshot: vps.snap, fetchFn: bridge(s.handler), now: s.now });
  const q = await s.call("POST", { action: "jarvis.runHealthCheck" }, USER);
  assert.equal(q.status, 202);
  const id = q.body.request.request_id;
  const p = await agent.pollOnce();
  assert.equal(p.handled, 1);
  const g = await s.call("GET", null, USER);
  const done = g.body.requests.find((x) => x.request_id === id);
  assert.equal(done.status, "done");
  assert.equal(done.result.ok, true);
  assert.equal(done.result.checks.mail_authority_vps, true);
  assert.deepEqual(g.body.audit.filter((a) => a.request_id === id).map((a) => a.outcome), ["queued", "success"]);
  for (const a of g.body.audit) for (const k of ["ts", "action", "outcome", "source", "request_id"]) assert.ok(k in a, k);
  // Lokales Audit auf dem VPS.
  const local = fs.readFileSync(path.join(dir, AUDIT_FILE), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(local.at(-1).action, "jarvis.runHealthCheck");
  assert.equal(local.at(-1).outcome, "success");

  // Restart Core: nur gemockt; ausgeführt erst nach bestätigtem Ergebnis.
  const rc = await s.call("POST", { action: "jarvis.restartCore" }, USER);
  assert.equal(rc.status, 202);
  await agent.pollOnce();
  assert.deepEqual(vps.calls, ["restartCore"]);
  // Zweiter Restart sofort danach: Cooldown (Cloud und VPS).
  assert.equal((await s.call("POST", { action: "jarvis.restartCore" }, USER)).body.code, "COOLDOWN");
  assert.equal((await agent.execute({ action: "jarvis.restartCore", params: {}, created_at: new Date().toISOString() })).error, "COOLDOWN");
});

test("kein Neustart, wenn das Ergebnis nicht gemeldet werden kann (fail closed)", async () => {
  const s = setup();
  const dir = tmp();
  const vps = fakeVps(dir);
  let failResult = false;
  const fetchFn = async (url, init) => { if (failResult && JSON.parse(init.body).op === "result") throw new Error("offline"); return bridge(s.handler)(url, init); };
  const agent = createControlAgent({ dir, config: { url: "https://jarvis.test", controlToken: CONTROL }, actions: vps.actions, snapshot: vps.snap, fetchFn, now: s.now });
  await s.call("POST", { action: "jarvis.restartMailWorker" }, USER);
  failResult = true;
  await agent.pollOnce();
  assert.deepEqual(vps.calls, []);
});

test("Auftrag, den der VPS nicht abholt, verfällt (kein später Überraschungs-Restart)", async () => {
  const s = setup();
  await s.call("POST", { action: "jarvis.restartCore" }, USER);
  s.advance(REQUEST_TTL_MS + 1000);
  const pulled = await s.call("POST", { op: "pull" }, AGENT);
  assert.deepEqual(pulled.body.requests, []);
  const g = await s.call("GET", null, USER);
  assert.equal(g.body.requests[0].status, "expired");
  assert.ok(g.body.audit.some((a) => a.outcome === "expired"));
});

test("arbitrary action / DANGEROUS über die API: abgelehnt und auditiert, nichts in der Warteschlange", async () => {
  const s = setup();
  for (const body of [{ action: "shell.exec", params: {} }, { action: "system.reboot" }, { action: "secrets.rotate" }, { action: "bash -c reboot" }, { command: "reboot" }, { action: "service.logs", params: { source: "../../../opt/fiverr" } }]) {
    const r = await s.call("POST", body, USER);
    assert.ok([400, 403].includes(r.status), JSON.stringify(body));
  }
  const pulled = await s.call("POST", { op: "pull" }, AGENT);
  assert.deepEqual(pulled.body.requests, []);
  const g = await s.call("GET", null, USER);
  assert.equal(g.body.audit.filter((a) => a.outcome === "denied").length, 6);
  assert.ok(g.body.audit.some((a) => a.tier === "dangerous"));
  // Der VPS prüft selbst noch einmal – eine manipulierte Cloud-Antwort wird nicht ausgeführt.
  const dir = tmp();
  const agent = createControlAgent({ dir, config: { url: "https://x.test", controlToken: CONTROL }, actions: fakeVps(dir).actions, snapshot: () => ({}), fetchFn: async () => new Response("{}") });
  for (const a of ["system.reboot", "shell.exec", "rm -rf /"]) assert.equal((await agent.execute({ action: a, params: {}, created_at: new Date().toISOString() })).ok, false);
  assert.equal((await agent.execute({ action: "service.logs", params: { source: "core", path: "/etc/shadow" }, created_at: new Date().toISOString() })).ok, false);
  assert.equal((await agent.execute({ action: "jarvis.runHealthCheck", params: {}, created_at: "2020-01-01T00:00:00.000Z" })).error, "STALE_REQUEST");
});

test("Auth: falscher/fremder Token → 401; Worker-, Sync- und Anthropic-Credential gelten nicht; fehlender Token → 503", async () => {
  const s = setup();
  for (const h of [{}, { "x-jarvis-key": "falsch" }, { "x-jarvis-control": "falsch" }, { "x-jarvis-control": ENV.JARVIS_MAIL_WORKER_TOKEN }, { "x-jarvis-control": ENV.JARVIS_SYNC_TOKEN },
    { "x-jarvis-worker": ENV.JARVIS_MAIL_WORKER_TOKEN }, { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }, { "x-jarvis-key": CONTROL }]) {
    assert.equal((await s.call("GET", null, h)).status, 401, JSON.stringify(Object.keys(h)));
    assert.equal((await s.call("POST", { op: "pull" }, h)).status, 401);
  }
  // Browser darf keine Agent-Operationen.
  assert.equal((await s.call("POST", { op: "pull" }, USER)).status, 400);
  const off = setup({ env: { ...ENV, JARVIS_SERVER_CONTROL_TOKEN: "" } });
  const r = await off.call("GET", null, USER);
  assert.equal(r.status, 503);
  assert.equal(r.body.configured, false);
  // Probe ohne Auth: nur konfiguriert/Länge, nie der Wert.
  const pr = await s.call("GET", null, {}, "?probe=1");
  assert.deepEqual(pr.body, { configured: true, length: CONTROL.length });
  assert.equal((await off.call("GET", null, {}, "?probe=1")).body.configured, false);
  // Rand-Leerzeichen in der Netlify-Variable stören nicht.
  const ws = setup({ env: { ...ENV, JARVIS_SERVER_CONTROL_TOKEN: CONTROL + "\n" } });
  assert.equal((await ws.call("POST", { op: "pull" }, AGENT)).status, 200);
  // Agent ohne eigenen Token startet gar nicht (kein Fallback auf den Worker-Token).
  assert.equal(createControlAgent({ dir: tmp(), config: { url: "https://x.test", controlToken: "" }, actions: {}, snapshot: () => ({}) }), null);
});

test("Rate Limit: höchstens 6 Control-Aktionen je 10 Minuten", async () => {
  const s = setup();
  const ids = ["jarvis.runHealthCheck", "jarvis.runSafeDiagnostics", "jarvis.runBackup", "jarvis.restartScheduler", "jarvis.restartMailWorker", "jarvis.restartCore"];
  for (const a of ids) assert.equal((await s.call("POST", { action: a }, USER)).status, 202, a);
  s.advance(61_000);
  const r = await s.call("POST", { action: "jarvis.runHealthCheck" }, USER);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, "RATE_LIMIT");
});

test("Secrets: nie im Ergebnis, Snapshot, Audit oder Browser; Server-Token nie im Frontend", async () => {
  const s = setup();
  const dir = tmp();
  const leaky = fakeVps(dir, { runBackup: async () => ({ ok: true, token: CONTROL, nested: { api_key: "sk-ant-api03-SECRETSECRET", note: `ANTHROPIC_API_KEY=sk-ant-x JARVIS_MAIL_WORKER_TOKEN=${ENV.JARVIS_MAIL_WORKER_TOKEN} mail an kunde@firma.ch` } }) });
  const agent = createControlAgent({ dir, config: { url: "https://jarvis.test", controlToken: CONTROL }, actions: leaky.actions, snapshot: () => ({ ...leaky.snap(), secret: CONTROL, system: { ...leaky.snap().system, token: CONTROL } }), fetchFn: bridge(s.handler), now: s.now });
  await s.call("POST", { action: "jarvis.runBackup" }, USER);
  await agent.pollOnce();
  const all = JSON.stringify((await s.call("GET", null, USER)).body) + JSON.stringify(s.store.peek());
  for (const secret of [CONTROL, ENV.JARVIS_MAIL_WORKER_TOKEN, ENV.JARVIS_SYNC_TOKEN, "pw-test", "sk-ant-", "kunde@firma.ch"]) assert.ok(!all.includes(secret), secret);
  assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /\[redacted\]/);
  const pk = ["PRIVATE", "KEY"].join(" "); // zusammengesetzt, damit der Secret-Scan keinen Schlüsselblock im Repo sieht
  assert.match(redact(`-----BEGIN OPENSSH ${pk}-----\nAAAA\n-----END OPENSSH ${pk}-----`), /^\[private-key\]$/);
  assert.match(redact("refresh 1//0gABCDEFGHIJKLMNOP"), /\[oauth-token\]/);
  assert.deepEqual(cleanResult({ password: "x", client_secret: "y", ok: true }), { ok: true });
  assert.equal(cleanSnapshot({ secret: "x" }).secret, undefined);
  // Frontend: nur das Cloud-Passwort, nie JARVIS_SERVER_CONTROL_TOKEN oder x-jarvis-control.
  for (const f of ["public/index.html", "public/server-status.js", "public/mail-status.js"]) assert.doesNotMatch(read(f), /JARVIS_SERVER_CONTROL_TOKEN|x-jarvis-control/, f);
});

test("Logs: nur Jarvis-Quellen, begrenzt, bereinigt (keine Tokens, Adressen, ENV-Werte)", async () => {
  const dir = tmp();
  const lines = [
    { ts: "2026-10-08T09:00:00.000Z", level: "info", event: "worker_started", pid: 7, role: "vps" },
    { ts: "2026-10-08T09:01:00.000Z", level: "error", event: "send_failed", error: "Gmail 401 for anna@laden.ch token=ya29.ABCDEFGHIJKLMNOPQRSTUV", recipient: "anna@laden.ch", subject: "Geheim" },
    { ts: "2026-10-08T09:02:00.000Z", level: "warn", event: "state_backup", generations: 2, offsite: false, error: "JARVIS_MAIL_WORKER_TOKEN=abc123 Bearer qwertyuiopasdfgh" },
    { ts: "2026-10-08T09:03:00.000Z", level: "info", event: "crash", error: "read /opt/fiverr/app/.env and /root/.ssh/id_rsa failed" },
  ];
  fs.writeFileSync(path.join(dir, "worker.log"), lines.map((l) => JSON.stringify(l)).join("\n") + "\nkein json\n");
  const mail = readLogs({ dir, source: "mail", lines: 10 });
  assert.equal(mail.lines.length, 1);
  assert.equal(mail.lines[0].recipient, undefined);
  assert.equal(mail.lines[0].subject, undefined);
  const txt = JSON.stringify([mail, readLogs({ dir, source: "backup" }), readLogs({ dir, source: "core" }), readLogs({ dir, source: "deploy" })]);
  for (const bad of ["anna@laden.ch", "ya29.", "abc123", "qwertyuiopasdfgh", "/opt/fiverr", "/root/.ssh", "Geheim"]) assert.ok(!txt.includes(bad), bad);
  assert.equal(readLogs({ dir, source: "deploy" }).lines[0].event, "worker_started");
  assert.equal(readLogs({ dir, source: "core", lines: 1 }).lines.length, 1);
  assert.equal(logSource("state_backup_manual"), "backup");
  assert.equal(cleanLogLine("{kaputt"), null);
  // Über die Aktion: Quelle nur als Enum.
  const { actions } = fakeVps(dir);
  assert.equal(actions["service.logs"]({ source: "mail", lines: 5 }).lines.length, 1);
});

test("Windows offline: Server Control läuft nur mit VPS + Cloud (kein Local Core, kein Windows-Worker, kein Sync-Token)", async () => {
  const s = setup({ env: { JARVIS_PASSWORD: "pw-test", JARVIS_SERVER_CONTROL_TOKEN: CONTROL } });
  const dir = tmp();
  const vps = fakeVps(dir);
  const agent = createControlAgent({ dir, config: { url: "https://jarvis.test/api/state", controlToken: CONTROL }, actions: vps.actions, snapshot: vps.snap, fetchFn: bridge(s.handler), now: s.now });
  await s.call("POST", { action: "jarvis.runBackup" }, USER);
  await agent.pollOnce();
  const g = await s.call("GET", null, USER);
  assert.equal(g.body.online, true);
  assert.equal(g.body.requests[0].status, "done");
  assert.deepEqual(vps.calls, ["backup"]);
  // Der Agent spricht nur mit der Cloud – nie mit localhost / dem PC.
  assert.doesNotMatch(read("server-agent.js"), /localhost|127\.0\.0\.1|:3000/);
});

test("Panel offen → Agent fragt im 5-s-Takt, sonst 60 s; nicht konfiguriert → 5 min", async () => {
  const s = setup();
  assert.equal((await s.call("POST", { op: "pull" }, AGENT)).body.hot, false);
  await s.call("GET", null, USER, "?watch=1");
  assert.equal((await s.call("POST", { op: "pull" }, AGENT)).body.hot, true);
  assert.equal(nextDelayMs({ hot: true, status: 200 }), 5_000);
  assert.equal(nextDelayMs({ hot: false, status: 200 }), 60_000);
  assert.equal(nextDelayMs({ hot: false, status: 503 }), 300_000);
});

test("HUD: SERVER-Panel zeigt ONLINE/OFFLINE, Uptime, CPU, RAM, Disk, Docker, Core, Mail, Scheduler, Backup, Deploy – keine Terminalbox", () => {
  const ctx = {};
  vm.runInNewContext(read("public/server-status.js"), ctx);
  const { summarizeServer } = ctx.JarvisServerStatus;
  const snap = cleanSnapshot(fakeVps(tmp()).snap());
  const now = Date.now();
  const m = summarizeServer({ configured: true, snapshot: snap, snapshot_at: new Date(now - 10_000).toISOString() }, now);
  assert.equal(m.server, "ONLINE");
  assert.equal(m.rows.docker, "ONLINE");
  assert.equal(m.rows.core, "HEALTHY");
  assert.equal(m.rows.mail, "VPS ACTIVE");
  assert.equal(m.rows.scheduler, "ONLINE");
  assert.equal(m.rows.backup, "OK");
  assert.match(m.rows.deploy, /^abc1234/);
  for (const k of ["uptime", "cpu", "ram", "disk"]) assert.notEqual(m.rows[k], "–", k);
  assert.equal(summarizeServer({ configured: true, snapshot: snap, snapshot_at: new Date(now - 10 * 60_000).toISOString() }, now).server, "OFFLINE");
  assert.equal(summarizeServer({ configured: false }, now).server, "NICHT KONFIGURIERT");
  const html = read("public/index.html");
  for (const id of ["srvState", "srvUptime", "srvCpu", "srvRam", "srvDisk", "srvDocker", "srvCore", "srvMail", "srvScheduler", "srvBackup", "srvDeploy"]) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const a of ["jarvis.runHealthCheck", "jarvis.restartCore", "jarvis.restartMailWorker", "jarvis.runBackup"]) assert.match(html, new RegExp(`data-action="${a.replace(".", "\\.")}"`));
  // Keine Eingabe für Befehle im Server-Panel.
  const panel = html.slice(html.indexOf('id="serverPanel"'), html.indexOf("</section>", html.indexOf('id="serverPanel"')));
  assert.doesNotMatch(panel, /<input|<textarea|contenteditable/);
});

test("Deploy: Netlify-Funktion vorhanden, Dockerfile kopiert die neuen Module, Token nur aus der Umgebung", () => {
  assert.match(read("netlify/functions/server-control.mjs"), /path: "\/api\/server-control"/);
  const df = read("deploy/vps/Dockerfile");
  for (const f of ["server-control.js", "server-agent.js"]) assert.match(df, new RegExp(f.replace(".", "\\.")));
  assert.match(read("deploy/vps/env.example"), /^JARVIS_SERVER_CONTROL_TOKEN=$/m);
  assert.match(read("server-agent.js"), /process\.env\.JARVIS_SERVER_CONTROL_TOKEN/);
  // Keine echte Mail: Server Control kennt Gmail nicht.
  for (const f of ["server-control.js", "server-agent.js"]) assert.doesNotMatch(read(f), /gmail\.js|sendMail|messages\.send/, f);
});
