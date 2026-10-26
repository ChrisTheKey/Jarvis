// Gemeinsames Gerüst der CRM-Browser-Tests (TF-053/TF-055): lokaler HTTP-Server mit statischen Dateien aus public/, echter
// /api/crm-Funktion (RAM-Speicher) und echtem CRM-Dienst (Temp-Verzeichnis, synthetische Leads). Kein Netz nach aussen.
// prepare(dirs) darf vor dem ersten Abholen Testdateien schreiben (z. B. site_findings.json, repair_findings.json).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { makeSources, writeSources } from "./crm-fixture.js";
import { createCrmHandler, crmAgentToken } from "../crm-api.js";
import { createCallingHandler } from "../calling-api.js";
import { createCrmAgent, createSourceReader } from "../crm-service.js";
import { memoryStore, createStateHandler } from "../shared-state.js";
import { createAuthHandler } from "../auth-api.js";
import { authStoreFrom, resolveActor } from "../auth-core.js";
import { createSalesHandler } from "../sales-api.js";
import { createSalesData } from "../sales-data.js";
import { createMailRequestHandler } from "../mail-requests.js";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const BROWSERS = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
export const exe = BROWSERS.find((p) => fs.existsSync(p));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

const FIXTURE_NOW = "2026-10-14T10:00:00Z";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const shiftDates = (v, ms) => typeof v === "string" ? (ISO_RE.test(v) ? new Date(Date.parse(v) + ms).toISOString() : v)
  : Array.isArray(v) ? v.map((x) => shiftDates(x, ms)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftDates(x, ms)])) : v;

// TF-063: Anmeldung wie in Produktion (Session-Cookie über /api/auth/*); vnLeads = optionale VN-Sicht, seller = Verkäufer-Passwörter.
export async function startServer({ n = 387, prepare = null, vnLeads = null, sellers = null, snapshot = null } = {}) {
  // Die Browser-Tests laufen mit der echten Uhr (Server + Browser). Fixture-Zeitpunkte relativ zur Fixture-Zeit (14.10.2026) auf «jetzt»
  // verschieben – sonst wird die synthetische Teilprüfung nach 7 Tagen realer Zeit als «veraltet» angezeigt (Alter bleibt wie entworfen).
  const src = shiftDates(makeSources(n), Date.now() - Date.parse(FIXTURE_NOW)), dirs = writeSources(src);
  const repairDir = path.join(dirs.base, "repair-export"); fs.mkdirSync(repairDir);
  if (prepare) prepare({ ...dirs, repairDir });
  const sources = createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail, repairDir });
  const control = "k".repeat(48), password = "pw-browser";
  const env = (k) => ({ JARVIS_SERVER_CONTROL_TOKEN: control, JARVIS_PASSWORD: password, JARVIS_WEB_ORIGIN: "https://synthetic.jarvis.test", JARVIS_SALES_VAULT_SECRET: "synthetic-sales-vault-secret" })[k];
  const authMem = {}, salesMem = {}, userMem = {};
  const authStore = authStoreFrom((k) => (authMem[k] ||= memoryStore()));
  const getAuthStore = async () => authStore, getSalesStore = async (k) => (salesMem[k] ||= memoryStore());
  const vnq = memoryStore(), vnv = memoryStore(vnLeads ? { leads: vnLeads, generated_at: new Date().toISOString() } : null);
  const handler = createCrmHandler({ getQueueStore: async () => qs, getViewStore: async () => vs, getVnQueueStore: async () => vnq, getVnViewStore: async () => vnv, getSalesStore, getAuthStore, env });
  const qs = memoryStore(), vs = memoryStore();
  const auth = createAuthHandler({ env, getStore: getAuthStore });
  const cs = memoryStore(snapshot ? { snapshot } : null); // TF-066: optionaler Server-Control-Snapshot (Aufträge + Onboarding)
  const data = async () => createSalesData({ getViewStore: async () => vs, getVnViewStore: async () => vnv, getSalesStore, getControlStore: async () => cs });
  const ra = (req) => resolveActor(req, { env, getAuthStore });
  const resolveSyntheticLead = async (actor, id) => {
    const found = await data().then((d) => d.resolveLead(actor, id));
    if (found?.lead?.lead_id !== "firma-021.ch") return found;
    return { lead: { ...found.lead, errors: { ...found.lead.errors, items: [{ text: "Synthetic confirmed website repair finding", confirmed: true }] }, request: { basis: "REQUESTED_CONTACT", requestSource: "synthetic fixture request", requestDate: "2026-10-09T09:00:00Z", requestScope: "Website-Reparatur", requestEvidence: "Synthetic request for the website repair review", responseScope: "Website-Analyse und Website-Reparatur", recipientOrSubmissionChannel: "info@firma-021.ch", requestConfidence: "HIGH" } } };
  };
  const apis = { "/api/crm": handler, "/api/sales": createSalesHandler({ env, data, getSalesStore, getAuthStore }),
    "/api/state": createStateHandler({ env, getStore: async () => memoryStore(), resolveActor: ra, getUserStore: async (u) => (userMem[u] ||= memoryStore()) }),
    "/api/calling": createCallingHandler({ env, getCallingStore: async (k) => (salesMem[`__calling_${k}`] ||= memoryStore()), getAuthStore, getViewStore: async () => vs, getVnViewStore: async () => vnv, getSalesStore, getCrmQueueStore: async () => qs, getVnQueueStore: async () => vnq }),
    "/api/mail-requests": createMailRequestHandler({ env, getStore: async () => (salesMem.__mail ||= memoryStore()), resolveActor: ra, resolveLead: resolveSyntheticLead }) };
  const agent = createCrmAgent({ dataDir: dirs.data, sources, url: "http://local.test", token: crmAgentToken(control), fetchFn: (u, init) => handler(new Request(u, init)) });
  await agent.pollOnce();
  let stop = false;
  (async () => { while (!stop) { await agent.pollOnce().catch(() => {}); await new Promise((r) => setTimeout(r, 300)); } })();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const api = apis[u.pathname] || (u.pathname.startsWith("/api/auth/") ? auth : null);
    if (api) {
      const body = await new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)).on("end", () => r(b)); });
      const out = await api(new Request(`http://${req.headers.host}` + req.url, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body } : {}) }));
      res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer())); return;
    }
    if (u.pathname.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
    const file = path.join(ROOT, "public", u.pathname === "/" ? "index.html" : path.normalize(u.pathname).replace(/^([\\/])+/, ""));
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }); res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  // Owner-Bootstrap + Verkäufer-Passwörter über die echte Owner-API (nie im Browser gespeichert).
  if (sellers) {
    const login = await auth(new Request(url + "/api/auth/login", { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify({ username: "chris", password }) }));
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    for (const [user_id, pw] of Object.entries(sellers)) await auth(new Request(url + "/api/auth/admin/password", { method: "POST", headers: { origin: url, cookie, "content-type": "application/json" }, body: JSON.stringify({ user_id, password: pw }) }));
  }
  return { url, dirs, password, close: () => { stop = true; server.close(); } };
}
export async function loginAs(ctx, srv, username = "chris", password = srv.password) {
  const r = await ctx.request.post(srv.url + "/api/auth/login", { headers: { origin: srv.url }, data: { username, password } });
  if (!r.ok()) throw new Error("Login fehlgeschlagen: " + r.status());
}
export async function openCrm(browser, srv, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  await loginAs(ctx, srv); // TF-063: Session-Cookie statt Passwort im localStorage
  const page = await ctx.newPage();
  const errors = [], external = [], posts = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  await page.route("**/*", (r) => { const u = r.request().url(); if (!u.startsWith(srv.url)) { external.push(u); return r.abort(); } if (r.request().method() === "POST") posts.push(new URL(u).pathname === "/api/mail-requests" ? JSON.parse(r.request().postData() || "{}") : new URL(u).pathname); return r.continue(); });
  await page.goto(srv.url + "/#crm");
  await page.evaluate(() => { document.getElementById("boot").hidden = true; }); // Startbildschirm (Audio-Freigabe) ist nicht Teil des CRM-Tests
  return { ctx, page, errors, external, posts };
}
export const noOverflow = (page) => page.evaluate(() => { const c = document.getElementById("crm"); return { doc: document.documentElement.scrollWidth <= innerWidth + 1, crm: c.scrollWidth <= c.clientWidth + 1, w: innerWidth }; });
export const shot = async (page, name) => { if (process.env.CRM_SHOTS) { fs.mkdirSync(process.env.CRM_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.CRM_SHOTS, name) }); } };
