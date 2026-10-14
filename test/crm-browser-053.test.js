// TF-053 Browser-Test: echte Oberfläche (public/index.html + crm.js) in Chromium, Desktop 1440×900 und Smartphone 390×844.
// Lokaler HTTP-Server: statische Dateien aus public/ + echte /api/crm-Funktion (Speicher im RAM) + echter CRM-Dienst (Temp-Verzeichnis,
// synthetische 387 Leads). Kein Netz nach aussen (fremde Anfragen werden blockiert), keine echten Daten, kein Senden.
// Ohne lokalen Chrome/Edge/Chromium wird der Test übersprungen. Screenshots optional nach $CRM_SHOTS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { makeSources, writeSources } from "./crm-fixture.js";
import { createCrmHandler, crmAgentToken } from "../crm-api.js";
import { createCrmAgent, createSourceReader, loadCrm } from "../crm-service.js";
import { memoryStore } from "../shared-state.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const BROWSERS = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter(Boolean);
const exe = BROWSERS.find((p) => fs.existsSync(p));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

async function startServer() {
  const src = makeSources(387), dirs = writeSources(src);
  const sources = createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail });
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
async function openCrm(browser, srv, ctxOpts) {
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
const noOverflow = (page) => page.evaluate(() => { const c = document.getElementById("crm"); return { doc: document.documentElement.scrollWidth <= innerWidth + 1, crm: c.scrollWidth <= c.clientWidth + 1, w: innerWidth }; });
const shot = async (page, name) => { if (process.env.CRM_SHOTS) { fs.mkdirSync(process.env.CRM_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.CRM_SHOTS, name) }); } };

test("N: Desktop-Rendering (1440×900) – Tabelle, Karten, Drawer A–F, Links, Speichern über /api/crm, Do Not Contact", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 120_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer();
  try {
    const { page, errors, external, posts } = await openCrm(browser, srv, { viewport: { width: 1440, height: 900 } });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain tbody tr").length === 387, null, { timeout: 15_000 });
    assert.equal(await page.locator(".crm-card").count(), 12);
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 1440 });
    const heads = await page.locator(".crm-table th").allTextContents();
    for (const h of ["Firma", "Website", "Probleme", "Ansprechpartner", "Telefon", "E-Mail", "Draft", "Status", "Telefonstatus", "Nächster Schritt"]) assert.ok(heads.includes(h), h);
    const tels = await page.locator('#crmMain a[href^="tel:"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert.ok(tels.length > 200 && tels.every((h) => /^tel:\+41\d{9}$/.test(h)));
    const mails = await page.locator('#crmMain a[href^="mailto:"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert.ok(mails.length > 300 && mails.every((h) => /^mailto:[^?&]+$/.test(h)), "mailto ohne Betreff/Text");
    const sites = await page.locator("#crmMain td:nth-child(2) a").evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.target, a.rel]));
    assert.ok(sites.every(([h, t, r]) => /^https:\/\//.test(h) && t === "_blank" && /noopener/.test(r)));
    await shot(page, "crm-desktop.png");
    // Suche + Kartenfilter
    await page.fill("#crmF_q", "firma-007");
    assert.equal(await page.locator("#crmMain tbody tr").count(), 1);
    await page.fill("#crmF_q", "");
    await page.click(".crm-card:has-text('Kunden')");
    assert.equal(await page.locator("#crmMain tbody tr").count(), 1);
    await page.click(".crm-card:has-text('Alle Leads')");
    // Detail
    await page.click('#crmMain tr[data-id="firma-021.ch"]');
    await page.waitForSelector("#crmDrawer:not([hidden])");
    const h4 = await page.locator("#crmDrawer h4").allTextContents();
    for (const s of ["A · Kontakt", "B · Website", "C · Website-Probleme", "D · Outreach", "E · Telefon", "F · Notizen"]) assert.ok(h4.includes(s), s);
    assert.equal(await page.locator('#crmDrawer a:has-text("ANRUFEN")').getAttribute("href"), "tel:+41311234567");
    assert.ok(await page.locator('#crmDrawer a:has-text("GMAIL-ENTWURF ÖFFNEN")').count());
    await shot(page, "crm-desktop-detail.png");
    // Notiz speichern (Auftrag → Dienst → Ergebnis)
    await page.fill('#crmDrawer textarea[placeholder^="Neue Notiz"]', "Browser-Testnotiz");
    await page.click('#crmDrawer button:has-text("NOTIZ HINZUFÜGEN")');
    await page.waitForFunction(() => document.getElementById("crmActStatus")?.textContent.includes("Gespeichert"), null, { timeout: 20_000 });
    assert.ok((await page.locator("#crmDrawer .crm-hist").allTextContents()).join(" ").includes("Browser-Testnotiz"));
    assert.equal(loadCrm(srv.dirs.data).leads["firma-021.ch"].notes[0].text, "Browser-Testnotiz");
    // Anruf dokumentieren
    await page.click('#crmDrawer button:has-text("ANRUF DOKUMENTIEREN")');
    await page.selectOption("#crmCallForm select", "CALLBACK_REQUESTED");
    await page.fill("#crmCallForm textarea", "Bitte Donnerstag anrufen");
    await page.click('#crmCallForm button:has-text("ANRUF SPEICHERN")');
    await page.waitForFunction(() => document.getElementById("crmActStatus")?.textContent.includes("Gespeichert"), null, { timeout: 20_000 });
    assert.equal(loadCrm(srv.dirs.data).leads["firma-021.ch"].call_history[0].result, "CALLBACK_REQUESTED");
    // Do Not Contact
    page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Browser-Test" : undefined));
    await page.click('#crmDrawer button:has-text("DO NOT CONTACT SETZEN")');
    await page.waitForSelector("#crmDrawer .crm-dnc-banner", { timeout: 20_000 });
    assert.equal(await page.locator('#crmDrawer a:has-text("ANRUFEN")').count(), 0, "kein Anruf-Knopf bei Do Not Contact");
    assert.equal(await page.locator('#crmMain tr.dnc[data-id="firma-021.ch"]').count(), 1);
    assert.equal(loadCrm(srv.dirs.data).leads["firma-021.ch"].do_not_contact, true);
    assert.deepEqual(errors, []);
    assert.ok(external.every((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)), "keine fremden Anfragen ausser Schriften (blockiert)");
    assert.ok(posts.length && posts.every((p) => p === "/api/crm"), "Schreiben nur über /api/crm");
  } finally { srv.close(); await browser.close(); }
});

test("M: Mobile-Rendering (390×844) – Karten, grosse ANRUFEN/WEBSITE/ENTWURF-Knöpfe, kein Querscrollen, Drawer bildschirmbreit", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 120_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer();
  try {
    const { page, errors } = await openCrm(browser, srv, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain li.crm-lcard").length === 387, null, { timeout: 15_000 });
    assert.equal(await page.locator("#crmMain table").count(), 0, "Karten statt Tabelle");
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 390 });
    const card = page.locator('#crmMain li[data-id="firma-021.ch"]');
    const text = await card.textContent();
    for (const s of ["Firma 21 AG", "Problem", "Telefon", "Ansprechpartner", "Entwurf bereit"]) assert.ok(text.includes(s), s);
    const call = card.locator('a:has-text("ANRUFEN")');
    assert.equal(await call.getAttribute("href"), "tel:+41311234567");
    const box = await call.boundingBox();
    assert.ok(box.height >= 44, "Touch-Ziel ≥ 44 px");
    assert.ok(await card.locator('a:has-text("WEBSITE ÖFFNEN")').count());
    assert.ok(await card.locator('a:has-text("ENTWURF ÖFFNEN")').count());
    assert.equal(await page.locator('#crmMain li[data-id="firma-011.ch"] a:has-text("ANRUFEN")').count(), 0, "DNC-Lead ohne Anruf-Knopf");
    await shot(page, "crm-mobile.png");
    await card.locator("h3").tap();
    await page.waitForSelector("#crmDrawer:not([hidden])");
    const w = await page.locator("#crmDrawer").evaluate((d) => d.getBoundingClientRect().width);
    assert.equal(Math.round(w), 390);
    const inputs = await page.locator("#crmDrawer textarea, #crmDrawer input, #crmDrawer select").evaluateAll((xs) => xs.filter((x) => x.offsetParent).map((x) => parseFloat(getComputedStyle(x).fontSize)));
    assert.ok(inputs.every((f) => f >= 16), "kein iOS-Zoom (Schrift ≥ 16 px)");
    assert.ok(await page.evaluate(() => document.getElementById("crmDrawer").scrollWidth <= 391));
    await shot(page, "crm-mobile-detail.png");
    assert.deepEqual(errors, []);
  } finally { srv.close(); await browser.close(); }
});
