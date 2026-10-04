// Jarvis-Server: liefert das HUD aus und leitet jeden Sprachbefehl an Claude Code weiter.
// Keine Abhängigkeiten nötig – nur Node.js 18+ und das installierte Claude Code (`claude`).
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.JARVIS_MODEL || "sonnet";
const FULL_ACCESS = process.env.JARVIS_FULL_ACCESS === "1";
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const WORKSPACE = path.join(ROOT, "workspace");
const PERSONA = path.join(ROOT, "persona.md");
const SESSION_FILE = path.join(ROOT, ".session");
const WIN = process.platform === "win32";
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
// Die eigene Netlify-Seite darf den Kern auf diesem Rechner steuern (kommagetrennt, z. B. https://mein-jarvis.netlify.app)
const WEB_ORIGINS = new Set((process.env.JARVIS_WEB_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean));
const LOCAL_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const originAllowed = (o) => LOCAL_ORIGINS.has(o) || WEB_ORIGINS.has(o);

let sessionId = readSession();
let current = null; // laufender Claude-Code-Prozess
let claudeVersion = null;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
function readSession() {
  try { return fs.readFileSync(SESSION_FILE, "utf8").trim() || null; } catch { return null; }
}
function saveSession(id) {
  sessionId = id;
  try { id ? fs.writeFileSync(SESSION_FILE, id) : fs.rmSync(SESSION_FILE, { force: true }); } catch {}
}

// Unter Windows ist `claude` ein .cmd-Skript und braucht eine Shell; Argumente mit Leerzeichen werden gequotet.
function runClaude(args, opts = {}) {
  return spawn("claude", WIN ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args, {
    cwd: WORKSPACE, shell: WIN, env: process.env, ...opts,
  });
}

// Beendet Claude Code samt Unterprozessen (unter Windows hängt er hinter einer Shell)
function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  if (WIN) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill();
}

function checkClaude() {
  const p = runClaude(["--version"]);
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.on("error", () => (claudeVersion = null));
  p.on("close", (code) => (claudeVersion = code === 0 ? out.trim() : null));
}

function describeTool(name, input = {}) {
  if (input.file_path) {
    const rel = path.relative(WORKSPACE, input.file_path);
    return rel.startsWith("..") ? input.file_path : rel;
  }
  const v = input.command || input.query || input.url || input.file_path || input.pattern || input.description || input.prompt;
  return String(v ?? JSON.stringify(input)).replace(/\s+/g, " ").slice(0, 140);
}

function ask(text, res, retried = false) {
  stopChild(current);
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", MODEL, "--append-system-prompt-file", PERSONA];
  if (sessionId) args.push("--resume", sessionId);
  if (FULL_ACCESS) args.push("--dangerously-skip-permissions");

  const child = runClaude(args);
  current = child;
  const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  let buf = "", stderr = "", gotOutput = false, finished = false;

  child.stdin.end(text);
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      gotOutput = true;
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id) saveSession(ev.session_id);
      else if (ev.type === "assistant" && !ev.parent_tool_use_id) {
        for (const b of ev.message?.content || []) {
          if (b.type === "text" && b.text.trim()) send({ type: "text", text: b.text });
          else if (b.type === "tool_use") send({ type: "tool", name: b.name, detail: describeTool(b.name, b.input) });
        }
      } else if (ev.type === "user") {
        for (const b of ev.message?.content || []) {
          if (b.type === "tool_result" && b.is_error) {
            const msg = Array.isArray(b.content) ? b.content.map((c) => c.text || "").join(" ") : String(b.content || "");
            send({ type: "tool_error", detail: msg.replace(/\s+/g, " ").slice(0, 160) });
          }
        }
      } else if (ev.type === "result") {
        finished = true;
        send({ type: "done", error: ev.is_error ? String(ev.result || ev.subtype || "Fehler") : null });
      }
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  child.on("error", (err) => {
    send({ type: "error", message: err.code === "ENOENT"
      ? "Claude Code ist nicht installiert. Führe aus: npm install -g @anthropic-ai/claude-code"
      : "Claude Code konnte nicht starten: " + err.message });
    finished = true;
    res.end();
  });
  child.on("close", (code) => {
    if (current === child) current = null;
    // Alte Sitzung nicht mehr vorhanden? Einmal mit frischer Sitzung neu versuchen.
    if (!gotOutput && code !== 0 && sessionId && !retried && /session|conversation/i.test(stderr)) {
      saveSession(null);
      return ask(text, res, true);
    }
    if (!finished) {
      const hint = /log ?in|auth|api key|credential/i.test(stderr) ? " Bitte einmal im Terminal `claude` starten und anmelden." : "";
      send({ type: "error", message: (stderr.trim().split("\n").pop() || `Claude Code wurde beendet (Code ${code}).`) + hint });
    }
    res.end();
  });
  res.on("close", () => stopChild(child));
}

// CPU-Last aus der Differenz zweier Messungen
let lastCpu = os.cpus().map((c) => c.times);
function cpuLoad() {
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] || t;
    const sum = (x) => x.user + x.nice + x.sys + x.idle + x.irq;
    idle += t.idle - p.idle;
    total += sum(t) - sum(p);
  });
  lastCpu = now;
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > limit) { reject(new Error("zu groß")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  // Schutz: nur Aufrufe vom eigenen Rechner und von dieser Oberfläche (gegen fremde Webseiten und DNS-Rebinding)
  if (!ALLOWED_HOSTS.has(req.headers.host || "")) return json(res, 403, { error: "Nur über localhost erreichbar." });
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  if (req.method === "OPTIONS") {
    if (!origin || !originAllowed(origin)) return json(res, 403, { error: "Diese Seite ist nicht freigegeben." });
    res.writeHead(204, {
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type, x-jarvis",
      "access-control-allow-private-network": "true",
      "access-control-max-age": "600",
    });
    return res.end();
  }
  if (req.method === "POST" && ((origin && !originAllowed(origin)) || req.headers["x-jarvis"] !== "1")) {
    return json(res, 403, { error: "Abgelehnt." });
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return fs.createReadStream(path.join(ROOT, "public", "index.html")).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, { claude: claudeVersion, model: MODEL, fullAccess: FULL_ACCESS, tts: ELEVEN_KEY ? "elevenlabs" : "browser", session: Boolean(sessionId) });
    }
    if (req.method === "GET" && url.pathname === "/api/system") {
      const mem = 1 - os.freemem() / os.totalmem();
      return json(res, 200, {
        cpu: cpuLoad(), mem: Math.round(mem * 100), memTotal: Math.round(os.totalmem() / 2 ** 30),
        uptime: os.uptime(), host: os.hostname(), platform: `${os.type()} ${os.release()}`, cores: os.cpus().length,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/ask") {
      const { text } = JSON.parse(await readBody(req));
      if (!text || typeof text !== "string") return json(res, 400, { error: "Kein Befehl." });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      return ask(text.slice(0, 4000), res);
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      stopChild(current);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      stopChild(current);
      saveSession(null);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/tts") {
      if (!ELEVEN_KEY) return json(res, 404, { error: "Keine ElevenLabs-Stimme eingerichtet." });
      const { text } = JSON.parse(await readBody(req));
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE)}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_KEY, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: String(text || "").slice(0, 2500), model_id: "eleven_multilingual_v2" }),
      });
      if (!r.ok) return json(res, 502, { error: "ElevenLabs: " + (await r.text()).slice(0, 200) });
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    json(res, 404, { error: "Nicht gefunden." });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

checkClaude();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  J.A.R.V.I.S. ist online:  http://localhost:${PORT}\n`);
  console.log(`  Modell: ${MODEL} · Zugriff: ${FULL_ACCESS ? "VOLLZUGRIFF" : "Standard"} · Stimme: ${ELEVEN_KEY ? "ElevenLabs" : "Browser"}`);
  if (WEB_ORIGINS.size) console.log(`  Freigegebene Web-Oberfläche: ${[...WEB_ORIGINS].join(", ")}`);
  console.log(`  Öffne die Adresse in Chrome oder Edge. Beenden mit Strg+C.\n`);
});
