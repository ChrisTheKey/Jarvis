// Local Core: Healthcheck, Doppelstart-Schutz, nur localhost, Aufpasser, Autostart-Installer, Local/Cloud-Erkennung im HUD.
// Echte server.js-Prozesse auf freien Ports, mit eigenem leeren .secrets-Ordner (keine echten Daten, kein Netzwerk nach aussen).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { createCoreLogger, acquireSupervisorLock, releaseSupervisorLock, EXIT_BUSY, EXIT_PORT_CONFLICT } from "../local-core.js";
import { sanitizeState, findSensitiveKeys } from "../shared-state.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const SERVER = path.join(ROOT, "server.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();
after(() => { for (const p of procs) try { p.kill(); } catch {} });

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function get(port, p, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const r = http.get({ host, port, path: p, headers: { host: `localhost:${port}` }, timeout: 3000 }, (res) => {
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json, body }); });
    });
    r.on("timeout", () => r.destroy());
    r.on("error", (e) => resolve({ error: e.code || e.message }));
  });
}
function startCore(port, { args = [], secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-core-")) } = {}) {
  const p = spawn(process.execPath, [SERVER, ...args], { cwd: ROOT, windowsHide: true,
    env: { ...process.env, PORT: String(port), JARVIS_SECRETS_DIR: secrets, JARVIS_SYNC_TOKEN: "", JARVIS_SYNC_URL: "http://127.0.0.1:9/api/state", JARVIS_CORE_SUPERVISED: "" } });
  procs.add(p);
  p.out = ""; p.stdout.on("data", (c) => (p.out += c)); p.stderr.on("data", (c) => (p.out += c));
  p.exited = new Promise((r) => p.on("exit", (code) => r(code)));
  p.secrets = secrets;
  return p;
}
async function waitHealthy(port, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const r = await get(port, "/api/health");
    if (r.json?.service === "jarvis-local-core") return r.json;
  }
  return null;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Local Core Healthcheck: /api/health antwortet lokal als jarvis-local-core", async () => {
  const port = await freePort();
  const core = startCore(port);
  const h = await waitHealthy(port);
  assert.ok(h, core.out);
  assert.equal(h.ok, true);
  assert.equal(h.mode, "local");
  assert.equal(h.pid, core.pid);
  const status = await get(port, "/api/status");
  assert.equal(status.status, 200, "lokale Jarvis-Funktionen verfügbar");
  const leads = await get(port, "/api/leads");
  assert.equal(leads.status, 200);
  assert.deepEqual(Object.keys(leads.json.offers), ["REPAIR_CHECK_150", "REPAIR_FIX_500"]);
  // Fremde Host-Header (DNS-Rebinding) werden abgewiesen
  const evil = await new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode)).on("error", () => resolve(0)));
  assert.equal(evil, 403);
  core.kill();
});

test("keine doppelte Local-Core-Instanz: zweiter Start beendet sich, erster läuft weiter", async () => {
  const port = await freePort();
  const first = startCore(port);
  assert.ok(await waitHealthy(port), first.out);
  const second = startCore(port);
  assert.equal(await second.exited, EXIT_BUSY, second.out);
  assert.match(second.out, /läuft bereits/);
  assert.equal((await get(port, "/api/health")).json.pid, first.pid, "der erste Kern bedient weiterhin");
  first.kill();
});

test("Port-Konflikt mit fremdem Programm wird sauber gemeldet", async () => {
  const port = await freePort();
  const foreign = http.createServer((q, s) => s.end("fremd")).listen(port, "127.0.0.1");
  await new Promise((r) => foreign.on("listening", r));
  const core = startCore(port);
  assert.equal(await core.exited, EXIT_PORT_CONFLICT, core.out);
  assert.match(core.out, /anderen Programm belegt/);
  foreign.close();
});

test("Local Core bindet nicht öffentlich: nur 127.0.0.1, nie 0.0.0.0", async () => {
  const src = fs.readFileSync(SERVER, "utf8");
  assert.match(src, /server\.listen\(PORT, "127\.0\.0\.1"/);
  assert.doesNotMatch(src, /0\.0\.0\.0|"::"/);
  const port = await freePort();
  const core = startCore(port);
  assert.ok(await waitHealthy(port), core.out);
  const external = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  for (const ip of external) {
    const r = await get(port, "/api/health", ip);
    assert.ok(r.error, `über ${ip} nicht erreichbar`);
  }
  core.kill();
});

test("Aufpasser: startet server.js, verhindert zweiten Aufpasser, startet nach Absturz neu, räumt beim Ende auf", { timeout: 60_000 }, async () => {
  const port = await freePort();
  const sup = startCore(port, { args: ["--supervise"] });
  const h1 = await waitHealthy(port, 20_000);
  assert.ok(h1, sup.out);
  assert.equal(h1.supervised, true);
  assert.notEqual(h1.pid, sup.pid, "Server läuft als Kindprozess des Aufpassers");
  const sup2 = startCore(port, { args: ["--supervise"], secrets: sup.secrets });
  assert.equal(await sup2.exited, EXIT_BUSY, "zweiter Aufpasser beendet sich sofort");
  process.kill(h1.pid); // Absturz simulieren
  await sleep(500);
  const h2 = await waitHealthy(port, 20_000);
  assert.ok(h2 && h2.pid !== h1.pid, "neu gestartet");
  sup.kill();
  for (let i = 0; i < 40 && alive(h2.pid); i++) await sleep(250);
  assert.ok(!alive(h2.pid), "Server endet mit dem Aufpasser (kein verwaister Kern)");
  const log = fs.readFileSync(path.join(sup.secrets, "local_core", "core.log"), "utf8");
  assert.match(log, /supervisor_started/);
  assert.match(log, /core_exited/);
});

test("Supervisor-Lock und Log: begrenzt, geschwärzt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-corelog-"));
  assert.equal(acquireSupervisorLock(dir, process.pid), true);
  assert.equal(acquireSupervisorLock(dir, 4242), false, "ein zweiter Aufpasser bekommt das Lock nicht");
  releaseSupervisorLock(dir, process.pid);
  assert.equal(acquireSupervisorLock(dir, 4242), true);
  releaseSupervisorLock(dir, 4242);
  const log = createCoreLogger(dir);
  log("error", "core_output", { line: "token ist sk-ant-api03-abcdefghijklmnop und ya29.abcdefghijklmnopqrstuvwxyz C:\\Users\\Administrator\\x" });
  const text = fs.readFileSync(path.join(dir, "core.log"), "utf8");
  for (const s of ["sk-ant-api03", "ya29.", "Administrator"]) assert.ok(!text.includes(s), s);
  fs.writeFileSync(path.join(dir, "core.log"), "x".repeat(1_100_000));
  log("info", "x");
  assert.ok(fs.statSync(path.join(dir, "core.log")).size < 1000, "rotiert");
  assert.ok(fs.existsSync(path.join(dir, "core.log.1")));
});

test("Autostart-Installer: eigener Task, unabhängig vom Mail-Worker, idempotent, ohne Admin-Zwang", () => {
  const ps = fs.readFileSync(path.join(ROOT, "install-local-core.ps1"), "utf8");
  assert.ok(ps.charCodeAt(0) === 0xfeff, "UTF-8 mit BOM für Windows PowerShell 5.1");
  assert.match(ps, /\$TaskName = "Jarvis Local Core"/);
  assert.doesNotMatch(ps, /Jarvis Mail Worker|mail-worker/i, "berührt den Mail-Worker-Task nie");
  for (const re of [/-AtLogOn/, /-MultipleInstances IgnoreNew/, /-RunLevel Limited/, /-RestartCount/, /--headless/, /--supervise/, /-Force \| Out-Null/, /\/api\/health/, /127\.0\.0\.1/])
    assert.match(ps, re);
  assert.doesNotMatch(ps, /0\.0\.0\.0|New-NetFirewallRule|netsh/i, "kein Port nach aussen");
  assert.doesNotMatch(ps, /-RunLevel Highest/);
  // Prozesse nur über server.js dieses Ordners beenden
  assert.match(ps, /CommandLine\.Contains\(\$Server\)/);
  const worker = fs.readFileSync(path.join(ROOT, "install-mail-worker.ps1"), "utf8");
  assert.match(worker, /\$TaskName = "Jarvis Mail Worker"/);
  assert.doesNotMatch(worker, /Local Core|server\.js/);
});

// ---------- Local/Cloud-Erkennung (public/mode-detect.js) ----------

function detector() {
  const ctx = { setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "public", "mode-detect.js"), "utf8"), ctx);
  return ctx.JarvisModeDetect;
}
function harness({ local = true, cloud = true } = {}) {
  const st = { local, cloud, busy: false, changes: [], timers: [] };
  const d = detector().createModeDetector({
    probeLocal: async () => { if (st.local === "throw") throw new Error("ECONNREFUSED"); return st.local; },
    probeCloud: async () => st.cloud, onChange: (next, prev) => st.changes.push([prev, next]), isBusy: () => st.busy,
    intervalMs: 20_000, setTimer: (fn, ms) => { st.timers.push(ms); st.fire = fn; return st.timers.length; }, clearTimer: () => {},
  });
  return { st, d };
}

test("Local/Cloud-Erkennung: Local Core erreichbar → automatisch LOCAL", async () => {
  const { st, d } = harness({ local: true });
  assert.equal(await d.check(), "local");
  assert.deepEqual(st.changes, [[null, "local"]]);
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.match(html, /<script src="mode-detect.js"><\/script>/);
  assert.match(html, /createModeDetector\(\{ probeLocal, probeCloud, onChange: applyMode, isBusy: \(\) => busy, intervalMs: 20_000 \}\)/);
  assert.match(fs.readFileSync(SERVER, "utf8"), /url\.pathname === "\/mode-detect\.js"/, "lokal ausgeliefert");
});

test("Cloud-Fallback: Local Core fällt aus → CLOUD; ohne Cloud → OFFLINE", async () => {
  const { st, d } = harness({ local: true });
  await d.check();
  st.local = "throw";
  assert.equal(await d.check(), "cloud");
  st.cloud = false;
  assert.equal(await d.check(), "offline");
  assert.deepEqual(st.changes.map((c) => c[1]), ["local", "cloud", "offline"]);
});

test("Local-Reconnect: Core kommt (wieder) hoch → automatisch LOCAL, ruhiges Intervall, nie während einer Antwort", async () => {
  const { st, d } = harness({ local: false });
  assert.equal(await d.check(), "cloud");
  d.start();
  assert.deepEqual(st.timers, [20_000], "ein Timer, 20 s");
  st.local = true;
  st.busy = true;
  await st.fire();
  assert.equal(d.mode, "cloud", "während Jarvis antwortet wird nicht umgeschaltet");
  st.busy = false;
  await st.fire();
  assert.equal(d.mode, "local");
  assert.ok(st.timers.every((ms) => ms === 20_000));
  const J = detector();
  for (const [want, got] of [[1000, 15_000], [60_000, 30_000], [20_000, 20_000]]) assert.equal(J.createModeDetector({ probeLocal: async () => true, intervalMs: want }).interval, got);
  d.stop();
});

test("Cloud bekommt keinen PC-Zugriff; Gmail- und Lead-Daten bleiben lokal", () => {
  const cloud = fs.readFileSync(path.join(ROOT, "netlify", "edge-functions", "cloud.js"), "utf8") + fs.readFileSync(path.join(ROOT, "netlify", "functions", "state.mjs"), "utf8");
  assert.doesNotMatch(cloud, /child_process|node:fs|localhost|gmail\.js|sales\.js|leads\.json/);
  // Lokaler Spiegel mit Gmail-Thread-ID, Auszug und Lead-Daten → in die Cloud geht nur die Whitelist
  const mirror = { notifications: [{ id: "hc-aaaa1111", createdAt: "2026-10-06T08:00:00Z", summary: "x", status: "unread", threadId: "18c0ffee", excerpt: "Mailtext" }],
    sales: { discovered: 3, total_revenue: 650 }, gmail_token: { refresh_token: "1//0abcdefghijklmnopqrstuvwxyz" }, leads: [{ email: "info@muster.ch" }], syncStatus: {} };
  const out = JSON.stringify(sanitizeState(mirror));
  for (const s of ["18c0ffee", "Mailtext", "1//0", "info@muster.ch", "refresh_token"]) assert.ok(!out.includes(s), s);
  assert.deepEqual(findSensitiveKeys(sanitizeState(mirror)), []);
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^\.secrets\/$/m);
});

test("HUD-Endpunkt /api/shared gibt keine Gmail-Thread-IDs oder Auszüge heraus", async () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-core-"));
  fs.writeFileSync(path.join(secrets, "shared_state.json"), JSON.stringify({ notifications: [{ id: "hc-aaaa1111", createdAt: "2026-10-06T08:00:00Z", summary: "x", status: "unread", threadId: "18c0ffee", excerpt: "Mailtext" }] }));
  const port = await freePort();
  const core = startCore(port, { secrets });
  assert.ok(await waitHealthy(port), core.out);
  const r = await get(port, "/api/shared");
  assert.equal(r.status, 200);
  assert.equal(r.json.notifications.length, 1);
  assert.ok(!r.body.includes("18c0ffee") && !r.body.includes("Mailtext"));
  assert.equal(r.json.localCore.online, true);
  core.kill();
});
