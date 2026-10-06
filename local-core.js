// Jarvis Local Core – Aufpasser für den bestehenden lokalen Server (server.js), gestartet vom Task „Jarvis Local Core“.
// Keine zweite Serverarchitektur: der Aufpasser startet nur `node server.js` als Kindprozess und startet ihn nach einem
// Absturz neu. Doppelstart-Schutz ist der Port selbst: server.js bindet ausschliesslich 127.0.0.1 und beendet sich mit
// EXIT_BUSY, wenn dort schon ein Jarvis antwortet (z. B. start.bat), bzw. EXIT_PORT_CONFLICT bei einem fremden Programm.
// Ein zweiter Aufpasser erkennt den ersten am Lock (.secrets/local_core/core.lock) und beendet sich sofort.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redact } from "./shared-state.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
export const CORE_DIR = path.join(SECRETS, "local_core");
export const EXIT_BUSY = 3; // Port belegt durch einen laufenden Jarvis
export const EXIT_PORT_CONFLICT = 4; // Port belegt durch ein fremdes Programm
export const SERVICE = "jarvis-local-core";
const LOG_MAX = 1_000_000;

// Kurzes, begrenztes Log (rotiert bei 1 MB, eine Vorgängerdatei). Inhalte werden vor dem Schreiben geschwärzt.
export function createCoreLogger(dir = CORE_DIR) {
  return (level, event, data = {}) => {
    const clean = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === "string" ? redact(v).slice(0, 500) : v]));
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean }) + "\n";
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "core.log");
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + ".1");
      fs.appendFileSync(file, line);
    } catch {}
  };
}

// Fragt den Healthcheck eines Jarvis auf 127.0.0.1:port ab. true nur, wenn wirklich der Jarvis-Kern antwortet.
export function probeCore(port, { timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", headers: { host: `localhost:${port}` }, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(res.statusCode === 200 && JSON.parse(body).service === SERVICE); } catch { resolve(false); } });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
// Lock mit Herzschlag: Nach einem Neustart kann Windows die alte PID an einen fremden Prozess vergeben – ein Lock gilt
// deshalb nur, solange sein Besitzer lebt UND sich in den letzten zwei Minuten gemeldet hat. Sonst wird übernommen.
export const LOCK_STALE_MS = 120_000;
export function acquireSupervisorLock(dir = CORE_DIR, pid = process.pid, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "core.lock");
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid, beat: now }), { flag: "wx" }); return true; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let lock = {};
      try { lock = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      if (typeof lock !== "object" || !lock) lock = {}; // altes Format (nur PID, ohne Herzschlag) gilt als verwaist
      if (lock.pid && lock.pid !== pid && alive(lock.pid) && now - (lock.beat || 0) < LOCK_STALE_MS) return false;
      fs.rmSync(file, { force: true }); // verwaist
    }
  }
  return false;
}
export function supervisorHeartbeat(dir = CORE_DIR, pid = process.pid) {
  try { fs.writeFileSync(path.join(dir, "core.lock"), JSON.stringify({ pid, beat: Date.now() })); } catch {}
}
export function releaseSupervisorLock(dir = CORE_DIR, pid = process.pid) {
  const file = path.join(dir, "core.lock");
  try { if (JSON.parse(fs.readFileSync(file, "utf8")).pid === pid) fs.rmSync(file, { force: true }); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Startet server.js und hält ihn am Leben. Kehrt nur zurück, wenn schon ein Aufpasser läuft (Rückgabe EXIT_BUSY).
export async function supervise({ dir = CORE_DIR, server = path.join(ROOT, "server.js"), log = createCoreLogger(dir), busyWaitMs = 60_000 } = {}) {
  if (!acquireSupervisorLock(dir)) { log("info", "supervisor_already_running"); return EXIT_BUSY; }
  const release = () => releaseSupervisorLock(dir);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => process.exit(0));
  log("info", "supervisor_started", { pid: process.pid });
  setInterval(() => supervisorHeartbeat(dir), 30_000).unref();
  // Endet der startende Prozess (beim Task: conhost, z. B. durch „Aufgabe beenden“), endet der Local Core mit.
  let child = null;
  const parent = process.ppid;
  setInterval(() => {
    try { process.kill(parent, 0); } catch (e) {
      if (e.code === "EPERM") return;
      log("info", "supervisor_parent_gone", { parent });
      try { child?.kill(); } catch {}
      process.exit(0);
    }
  }, 5_000).unref();
  for (let delay = 5_000; ;) {
    const started = Date.now();
    child = spawn(process.execPath, [server], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, JARVIS_CORE_SUPERVISED: "1" } });
    log("info", "core_started", { pid: child.pid });
    // Ausgaben des Servers zeilenweise, geschwärzt und gekürzt ins Log (keine Secrets).
    for (const [stream, level] of [[child.stdout, "info"], [child.stderr, "error"]]) {
      let buf = "";
      stream.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) log(level, "core_output", { line: l }); } });
    }
    const code = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)).on("error", () => r(1)));
    // Ein anderer Jarvis (z. B. start.bat) hält den Port: nicht verdoppeln, regelmässig prüfen und übernehmen, sobald er weg ist.
    if (code === EXIT_BUSY) { log("info", "core_already_running"); await sleep(busyWaitMs); delay = 5_000; continue; }
    if (code === EXIT_PORT_CONFLICT) { log("error", "port_conflict", { hint: "Port von einem fremden Programm belegt – PORT in .env ändern" }); await sleep(5 * 60_000); continue; }
    if (Date.now() - started > 600_000) delay = 5_000; // lief lange stabil → Wartezeit zurücksetzen
    log("error", "core_exited", { code, restartInMs: delay });
    await sleep(delay);
    delay = Math.min(delay * 2, 300_000);
  }
}
