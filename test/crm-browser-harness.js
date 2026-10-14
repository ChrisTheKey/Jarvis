// Gemeinsames Gerüst der CRM-Browser-Tests (TF-053/TF-055): lokaler HTTP-Server mit statischen Dateien aus public/, echter
// /api/crm-Funktion (RAM-Speicher) und echtem CRM-Dienst (Temp-Verzeichnis, synthetische Leads). Kein Netz nach aussen.
// prepare(dirs) darf vor dem ersten Abholen Testdateien schreiben (z. B. site_findings.json, repair_findings.json).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { makeSources, writeSources } from "./crm-fixture.js";
import { createCrmHandler, crmAgentToken } from "../crm-api.js";
import { createCrmAgent, createSourceReader } from "../crm-service.js";
import { memoryStore } from "../shared-state.js";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const BROWSERS = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
export const exe = BROWSERS.find((p) => fs.existsSync(p));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

export async function startServer({ n = 387, prepare = null } = {}) {
  const src = makeSources(n), dirs = writeSources(src);
  const repairDir = path.join(dirs.base, "repair-export"); fs.mkdirSync(repairDir);
  if (prepare) prepare({ ...dirs, repairDir });
  const sources = createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail, repairDir });
  const control = "k".repeat(48), password = "pw-browser";
  const handler = createCrmHandler({ getQueueStore: async () => qs, getViewStore: async () => vs, env: (k) => ({ JARVIS_SERVER_CONTROL_TOKEN: control, JARVIS_PASSWORD: password })[k] });
  const qs = memoryStore(), vs = memoryStore();
  const agent = createCrmAgent({ dataDir: dirs.data, sources, url: "http://local.test", token: crmAgentToken(control), fetchFn: (u, init) => handler(new Request(u, init)) });
  await agent.pollOnce();
  let stop = false;
  (async () => { while (!stop) { await agent.pollOnce().catch(() => {}); await new Promise((r) => setTimeout(r, 300)); } })();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/api/crm") {
      const body = await new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => r(b)); });
      const out = await handler(new Request("http://127.0.0.1" + req.url, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body } : {}) }));
      res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer())); return;
    }
    if (u.pathname.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
    const file = path.join(ROOT, "public", u.pathname === "/" ? "index.html" : path.normalize(u.pathname).replace(/^([\\/])+/, ""));
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }); res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, dirs, password, close: () => { stop = true; server.close(); } };
}
export async function openCrm(browser, srv, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript((pw) => { localStorage.setItem("jarvis.cloudKey", JSON.stringify(pw)); }, srv.password);
  const page = await ctx.newPage();
  const errors = [], external = [], posts = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  await page.route("**/*", (r) => { const u = r.request().url(); if (!u.startsWith(srv.url)) { external.push(u); return r.abort(); } if (r.request().method() === "POST") posts.push(new URL(u).pathname); return r.continue(); });
  await page.goto(srv.url + "/#crm");
  await page.evaluate(() => { document.getElementById("boot").hidden = true; }); // Startbildschirm (Audio-Freigabe) ist nicht Teil des CRM-Tests
  return { ctx, page, errors, external, posts };
}
export const noOverflow = (page) => page.evaluate(() => { const c = document.getElementById("crm"); return { doc: document.documentElement.scrollWidth <= innerWidth + 1, crm: c.scrollWidth <= c.clientWidth + 1, w: innerWidth }; });
export const shot = async (page, name) => { if (process.env.CRM_SHOTS) { fs.mkdirSync(process.env.CRM_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.CRM_SHOTS, name) }); } };
