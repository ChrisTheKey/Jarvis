// REPAIR QUALITY REVALIDATION (TF-054) – beweist gegen das isolierte TF-044-Docker-Lab (OpenSSH/SFTP + Caddy-HTTPS) mit echtem Chromium,
// dass Jarvis den tatsächlichen Defekt repariert: Baseline (echter site-auditor + echter Browser-Validator, Desktop 1440×900 + Mobile
// 390×844) → produktiver Pfad (bestätigter CHF-480-Auftrag, Test-Ledger CHF 240, sicherer Zugang über das echte Kundenformular, Tresor,
// Freigabe, PROFILE_READY, echtes Objekt-Backup, echter SFTP-Adapter locate/apply/validate, Browser-Gate, Abschluss-Gate, Lieferung an
// Fake-Gmail) → unabhängiger HTTP- + Browser-Retest. Negativfälle: Regression → Rollback → Baseline; Teilreparatur; geschützter Bereich;
// Neustart/Absturz mitten in REPAIRING. Nur Lab-Domains (*.test), zur Laufzeit erzeugte Test-Zugangsdaten, keine echte Mail/Zahlung.
// Läuft NUR über «npm run test:repair-quality-integration» (JARVIS_REPAIR_LAB=1) – fehlt Docker oder Chromium, schlägt der Lauf fehl.
import { test as baseTest, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../../../mail-worker.js";
import { recordPayment } from "../../../payments.js";
import { REPAIR_ORDERS_FILE, FULFILLMENT_CLASS, createConfirmedRepairOrder, createRepairEngine, runRepairOrders, completionGate, completeOrder, reportUnsafe } from "../../../repair-workflow.js";
import { createAuditor } from "../../../site-auditor.js";
import { createAccessIntakeHandler, memoryIntakeStore } from "../../../access-intake-api.js";
import { intakeClient, syncAccessIntake, ACCESS_VAULT_DIR } from "../../../access-intake.js";
import { sftpAdapter } from "../../../repair-adapters/sftp.js";
import { createAdapterRegistry } from "../../../repair-adapters/router.js";
import { chromiumLauncher, chromiumExecutable, rollbackMatchesBaseline } from "../../../repair-browser-validator.js";
import { dockerAvailable, cleanupAll, labResources, startLab, resetSite, siteFile, webrootSnapshot, labBrowserValidator, DOMAINS, FIXTURES } from "../repair-lab/lab.mjs";

const ENABLED = process.env.JARVIS_REPAIR_LAB === "1";
const test = (name, fn) => baseTest(name, { timeout: 900_000 }, fn);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "..", "..", "public");
const FX = "browser-broken";
const DOMAIN = DOMAINS.site;
const ORIGIN = `https://${DOMAIN}`;
const EMAIL = "auftrag@muster-kunde.test";
const WT = crypto.randomBytes(32).toString("base64url");
const T_TMP = /^jarvis-(q54|shot|chromium)-/;
const CLEAN_CSS = () => fs.readFileSync(path.join(FIXTURES, FX, "css/site.css"), "utf8").replace(".hero { width: 1400px; }", ".hero { max-width: 100%; }");

// ---------- Testwebsite (nur Testdaten): vor der Reparatur nachweisbar kaputt ----------
// A: wichtiger interner Navigationslink «Kontakt» → /kontakt-alt.html (404); /kontakt.html existiert genau einmal.
// B: Bild /assets/lab-logo.svg (404); dieselbe Datei liegt genau einmal unter /assets/img/lab-logo.svg (Repair-Matrix: replace_src).
const html = ({ title, nav = '<a href="/">Start</a> <a href="/team.html">Team</a> <a href="/kontakt.html">Kontakt</a>', main }) => `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Repair Lab – nur Testdaten">
<title>${title}</title>
<link rel="stylesheet" href="/css/site.css">
</head>
<body>
<header class="site-header"><a class="brand" href="/"><img src="/assets/img/brand.svg" alt="" width="16" height="16"> Browser Lab</a>
<button class="menu-toggle" type="button" aria-controls="site-nav" aria-expanded="false">Menü</button>
<nav id="site-nav" class="site-nav">${nav}</nav></header>
<main>
${main}
</main>
<footer><p>Repair Lab – nur Testdaten.</p></footer>
<script src="/js/site.js"></script>
</body>
</html>
`;
const HERO = '<section class="hero"><h1>Browser Lab Testseite</h1><p>Nur Testdaten – keine echte Kundenwebsite.</p><img src="/assets/img/hero.svg" alt="Hero" width="320" height="120"></section>';
const BROKEN_INDEX = html({ title: "Browser Lab Testseite", nav: '<a href="/">Start</a> <a href="/team.html">Team</a> <a href="/kontakt-alt.html">Kontakt</a>',
  main: `${HERO}\n<p><a href="/team.html">Unser Team</a></p>\n<p><img src="/assets/lab-logo.svg" alt="Lab Logo" width="64" height="64"></p>` });
const REPAIRED_INDEX = BROKEN_INDEX.replace('href="/kontakt-alt.html"', 'href="/kontakt.html"').replace('src="/assets/lab-logo.svg"', 'src="/assets/img/lab-logo.svg"');
const SITE_054 = { "index.html": BROKEN_INDEX, "css/site.css": CLEAN_CSS() };
// Geschützter Bereich: Links «AGB» und «Preise» zeigen ins Leere – ein eindeutiges Ziel existiert (agb.html/preise.html), trotzdem nie automatisch.
const PROTECTED_INDEX = html({ title: "Browser Lab Testseite", main: `${HERO}\n<p><a href="/agb-alt.html">AGB</a> <a href="/preise-alt.html">Preise</a></p>\n<p><img src="/assets/img/lab-logo.svg" alt="Lab Logo" width="64" height="64"></p>` });
const SITE_PROTECTED = { "index.html": PROTECTED_INDEX, "css/site.css": CLEAN_CSS(), "agb.html": html({ title: "AGB", main: "<h1>AGB</h1><p>Testdaten.</p>" }),
  "preise.html": html({ title: "Preise", main: "<h1>Preise</h1><p>Testdaten.</p>" }) };
const FINDINGS = [{ type: "contact_page_broken", broken_path: "/kontakt-alt.html", expected_path: "/kontakt.html" },
  { type: "broken_image", broken_path: "/assets/lab-logo.svg", expected_path: "/assets/img/lab-logo.svg" }];

let lab, browser, intake, customer, tempBefore = [];
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-q54-")); dirs.push(d); return d; };
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const tmpEntries = () => fs.readdirSync(os.tmpdir()).filter((f) => T_TMP.test(f));
const secretsOf = () => [lab.secrets.labuser_password, lab.secrets.key_passphrase, lab.privateKey.split(/\r?\n/)[2], WT].filter(Boolean);
const assertNoSecrets = (label, text) => { for (const v of secretsOf()) assert.ok(!String(text).includes(v), `${label} enthält Test-Zugangsdaten`); };
const filesOf = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
const inOrder = (list, wanted) => { let i = 0; for (const x of list) if (x === wanted[i]) i++; return i === wanted.length; };
// Echter produktiver Auditor (site-auditor.js) – nur der Transport ist das Lab (labFetch: nur *.test, nur Test-CA, nur 127.0.0.1).
const realAuditor = () => createAuditor({ fetchFn: lab.fetch, delayMs: 0, maxLinks: 80, maxImages: 25, totalMs: 120_000 });
const TERMINAL = ["COMPLETED", "REPAIR_FAILED", "MANUAL_REVIEW_REQUIRED", "VALIDATION_FAILED", "BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION", "PAYMENT_REVIEW_REQUIRED", "BLOCKED_UNSAFE_ACCESS", "BLOCKED_HOST_KEY_CHANGED"];

function fakeGmail() {
  const calls = [];
  return { calls,
    createDraft: async (x) => { calls.push({ op: "create", id: "dr" + (calls.length + 1), to: x.to, subject: x.subject, body: x.body, messageClass: x.messageClass }); return { draftId: "dr" + calls.length }; },
    sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "m-" + id }; },
    sentOf: (cls) => calls.filter((c) => c.op === "SEND").map((s) => calls.find((c) => c.op === "create" && c.id === s.id)).filter((c) => c && (!cls || c.messageClass === cls)) };
}
async function startIntake() {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined) });
  const STATIC = { "/access.html": "text/html; charset=utf-8", "/access.js": "text/javascript", "/access-crypto.js": "text/javascript", "/access.css": "text/css" };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && STATIC[u.pathname]) { res.writeHead(200, { "content-type": STATIC[u.pathname], "cache-control": "no-store" }); res.end(fs.readFileSync(path.join(PUBLIC, u.pathname.slice(1)))); return; }
    if (req.method === "POST" && u.pathname === "/api/access-intake") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = { "content-type": "application/json", ...(req.headers["x-jarvis-worker"] ? { "x-jarvis-worker": String(req.headers["x-jarvis-worker"]) } : {}) };
      const r = await handler(new Request(`http://127.0.0.1${u.pathname}`, { method: "POST", headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(await r.text()); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { blobs, origin, client: intakeClient({ config: { url: `${origin}/api/state`, workerToken: WT } }), close: () => new Promise((r) => server.close(r)) };
}
const linkIn = (mail) => mail?.body.match(/http:\/\/127\.0\.0\.1:\d+\/access\.html#t=[A-Za-z0-9_%-]+/)?.[0] || null;
async function customerForm(link, { type, host, user, secret, root, hostKey }) {
  const ctx = await customer.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    const page = await ctx.newPage();
    await page.goto(link, { waitUntil: "load" });
    await page.waitForSelector("#form:not([hidden])", { timeout: 20_000 });
    await page.selectOption("#type", type);
    await page.fill("#host", host); await page.fill("#user", user); await page.fill("#secret", secret);
    await page.fill("#root", root); await page.fill("#hostKey", hostKey);
    await page.check("#consent");
    await page.click("#send");
    await page.waitForSelector("#done:not([hidden])", { timeout: 30_000 });
  } finally { await ctx.close(); }
}

// ---------- Produktions-Abhängigkeiten: echter SFTP-Adapter über die Router-Brücke, Aufruf-Protokoll + gezielte Fehlerbilder ----------
// hooks.applyFix(issue, location, order, cred, real) → Ergebnis oder undefined (= echter Aufruf). Nie Zugangsdaten im Protokoll.
function wrapped(real, ctx) {
  const out = { ...real };
  for (const m of ["checkAccess", "backup", "locate", "applyFix", "validate", "deployProduction", "rollback", "cleanup"]) {
    if (typeof real[m] !== "function") continue;
    out[m] = async (...a) => {
      ctx.log.push(m);
      if (m === "applyFix") {
        const hooked = ctx.hooks.applyFix ? await ctx.hooks.applyFix(...a, real) : undefined;
        const r = hooked !== undefined ? hooked : await real.applyFix(...a);
        if (r?.ok) ctx.writes.push(a[0]?.type);
        return r;
      }
      return real[m](...a);
    };
  }
  return out;
}
async function depsFor(ctx) {
  const contracts = { sftp: wrapped(sftpAdapter({ dir: ctx.dir, fetchFn: lab.fetch }), ctx) };
  const reg = await createAdapterRegistry({ dir: ctx.dir, store: createStore(ctx.dir), fetchFn: lab.fetch, legacy: {}, contracts });
  return { adapters: reg.adapters, router: reg.router, preflight: reg.preflight, auditor: realAuditor(), browserValidator: browser };
}
function newCtx(hooks = {}) {
  const dir = tmp();
  return { dir, store: createStore(dir), gmail: fakeGmail(), log: [], writes: [], hooks, alerts: [], logs: [] };
}
const logFn = (ctx) => (level, event, data) => ctx.logs.push(JSON.stringify({ level, event, data }));
const runWorker = async (ctx) => runRepairOrders({ dir: ctx.dir, ...(await depsFor(ctx)), requireBrowser: true, autoDeliver: true, gmail: ctx.gmail, intake: intake.client,
  alert: async (a) => ctx.alerts.push(a.kind), log: logFn(ctx) });
// Genau EIN persistierter Schritt mit frischer Engine/Adaptern/Store – danach «stirbt» der Worker (Neustart).
async function restartStep(ctx, id) {
  const store = createStore(ctx.dir);
  const engine = createRepairEngine({ dir: ctx.dir, store, ...(await depsFor(ctx)), requireBrowser: true, autoDeliver: true, gmail: ctx.gmail, intake: intake.client,
    alert: async (a) => ctx.alerts.push(a.kind), log: logFn(ctx) });
  return engine.step(structuredClone(readOrder(store, id)));
}
// Bestätigter CHF-480-Testauftrag → Test-Ledger CHF 240 → 1 Zugangs-Mail → Kundenformular im Browser (SFTP, remote_root, Host-Key) → Pull/Tresor.
async function orderWithSecureAccess(ctx) {
  const o = createConfirmedRepairOrder(ctx.store, { domain: DOMAIN, website: `${ORIGIN}/`, company: "Muster Kunde AG", delivery_email: EMAIL, contact_name: "Frau Muster" });
  recordPayment(ctx.store, { order_id: o.order_id, amount_chf: 240, reference: `Q54-${o.order_id}`, source: "test_ledger" });
  await runWorker(ctx);
  const link = linkIn(ctx.gmail.sentOf("CUSTOMER_ACCESS_REQUEST")[0]);
  assert.ok(link, "Zugangs-Mail mit sicherem Link");
  await customerForm(link, { type: "sftp", host: `sftp://${lab.ssh.host}:${lab.ssh.port}`, user: "labuser", secret: lab.secrets.labuser_password, root: "public_html", hostKey: lab.hostKeys.ed25519 });
  assert.deepEqual(await syncAccessIntake({ store: createStore(ctx.dir), intake: intake.client }), { accepted: 1, rejected: 0 });
  const r = readOrder(ctx.store, o.order_id);
  assert.deepEqual([r.access_intake.status, r.customer_authorized_repair, r.authorization.source, r.authorization.authorized_domain], ["RECEIVED", true, "secure_order_access_form", DOMAIN]);
  return o.order_id;
}
// Arbeitsphase: Neustart nach JEDEM Schritt; liefert die Zustandsfolge + Beobachtungen VOR dem jeweiligen Schritt.
async function workPhase(ctx, id, { onBefore = () => {} } = {}) {
  const states = [readOrder(ctx.store, id).state];
  let o;
  for (let i = 0; i < 40; i++) {
    onBefore(readOrder(ctx.store, id));
    await restartStep(ctx, id);
    o = readOrder(ctx.store, id);
    if (o.state !== states.at(-1)) states.push(o.state);
    if (TERMINAL.includes(o.state)) break;
  }
  return { o, states };
}

// ---------- Unabhängige Prüfung (nicht über die Engine) ----------
async function httpGet(p) { const r = await lab.fetch(`${ORIGIN}${p}`, { redirect: "manual" }); return { status: r.status, url: r.url, location: r.headers.get("location"), body: await r.text() }; }
const hrefOf = (body, label) => body.match(new RegExp(`<a\\s+href="([^"]+)"[^>]*>${label}</a>`))?.[1] || null;
async function browserCheck(p, { findings = [], before = null, phase = "after" } = {}) {
  return browser.validate({ url: `${ORIGIN}${p}`, expected_domain: DOMAIN, findings, phase, before_snapshot: before });
}
function assertViewportHealthy(v, label) {
  // Navigation vorhanden: sichtbar – oder (Smartphone) eingeklappt und über den Menü-Button geöffnet, Links danach sichtbar.
  const navPresent = v.critical.nav === true || (v.viewport === "mobile" && v.nav.menu_toggle_used === true && v.nav.links_visible > 0);
  assert.deepEqual([v.load_ok, v.status, v.final_same_domain, v.critical.body_visible, v.critical.header, navPresent, v.critical.main, v.critical.footer],
    [true, 200, true, true, true, true, true, true], `${label}: Laden/Body/Header/Nav/Main/Footer`);
  assert.deepEqual([v.nav.targets_failed, v.images.broken, v.overflow.horizontal, v.console.page_errors, v.network.failed_same_site], [0, 0, false, 0, 0],
    `${label}: Navigation/Bilder/Overflow/JS/Netz ${JSON.stringify({ nav: v.nav, img: v.images, of: v.overflow, net: v.network.entries })}`);
  assert.ok(v.nav.links_visible > 0 && v.nav.targets_checked > 0, `${label}: Navigation bedienbar`);
}

if (!ENABLED) {
  baseTest("Repair Quality Revalidation (Docker + Chromium) – nur über «npm run test:repair-quality-integration»", { skip: "JARVIS_REPAIR_LAB=1 nicht gesetzt (eigene Docker-Suite)" }, () => {});
} else {
  before(async () => {
    assert.ok(await dockerAvailable(), "Docker nicht verfügbar – TF-054 verlangt die echte Integration.");
    assert.ok(chromiumExecutable(), "Chromium nicht verfügbar – TF-054 verlangt einen echten Browser.");
    tempBefore = tmpEntries();
    await cleanupAll();
    lab = await startLab({ log: (m) => console.log(`# ${m}`) });
    browser = await labBrowserValidator(lab);
    intake = await startIntake();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chromium-q54-"));
    const b = await chromiumLauncher()({ home });
    customer = { newContext: (o) => b.newContext(o), close: async () => { await b.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); } };
  }, { timeout: 1_200_000 });

  after(async () => {
    if (customer) await customer.close();
    if (intake) await intake.close();
    if (lab) await lab.stop();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    const left = await labResources();
    const tmpLeft = tmpEntries().filter((f) => !tempBefore.includes(f));
    console.log(`# Lab-Cleanup: ${JSON.stringify(left)} · Temp übrig: ${tmpLeft.length}`);
    assert.deepEqual(left, { containers: 0, volumes: 0, networks: 0 }, "Lab vollständig entfernt");
    assert.deepEqual(tmpLeft, [], "keine Test-Tresore/-Schlüssel/Browser-Profile übrig");
  }, { timeout: 300_000 });

  // ===================================================================================================================
  // 1) POSITIV: kaputt → produktiver Pfad → Defekt wirklich behoben, Desktop + Mobile, keine Regression, COMPLETED
  // ===================================================================================================================
  test("POSITIV: Baseline kaputt (Audit + Browser) → runRepairOrders/Engine (Neustart je Schritt) → Backup vor Write → SFTP-Fix → unabhängiger HTTP- + Browser-Retest → Befunde ABSENT → COMPLETED", async () => {
    await resetSite(lab, { fixture: FX, files: SITE_054 });
    const ctx = newCtx();

    // (4) BASELINE unabhängig: echter Auditor + HTTP + echter Browser (Desktop + Mobile).
    const audit0 = await realAuditor().audit(`${ORIGIN}/`);
    const k0 = audit0.issues.find((i) => i.type === "contact_page_broken" && /\/kontakt-alt\.html$/.test(i.url));
    const im0 = audit0.issues.find((i) => i.type === "broken_image" && /\/assets\/lab-logo\.svg$/.test(i.url));
    assert.ok(k0 && im0, JSON.stringify(audit0.issues.map((i) => [i.type, i.url])));
    assert.equal(hrefOf((await httpGet("/")).body, "Kontakt"), "/kontakt-alt.html", "Kontakt-Link zeigt auf die alte Seite");
    assert.equal((await httpGet("/kontakt-alt.html")).status, 404, "Ziel liefert Fehler");
    assert.equal((await httpGet("/assets/lab-logo.svg")).status, 404);
    const b0 = await browserCheck("/", { findings: FINDINGS, phase: "baseline" });
    for (const vp of ["desktop", "mobile"]) {
      const v = b0[vp];
      assert.ok(v.load_ok && v.findings.every((f) => f.present === true), `${vp}: Befund im Browser sichtbar ${JSON.stringify(v.findings)}`);
      assert.ok(v.nav.targets_failed >= 1 && v.images.broken >= 1 && v.network.failed_same_site >= 1, `${vp}: Navigation/Bild kaputt ${JSON.stringify([v.nav, v.images])}`);
    }
    const siteBefore = await webrootSnapshot(lab);

    // (5) Produktiver Pfad bis zum sicheren Zugang, danach Neustart nach jedem Schritt.
    const id = await orderWithSecureAccess(ctx);
    let writesBeforeBackup = null, backupSeenBeforeRepair = false;
    const { o, states } = await workPhase(ctx, id, { onBefore: (x) => {
      if (x.state === "BACKUP") writesBeforeBackup = ctx.writes.length;
      if (x.state === "REPAIRING") backupSeenBeforeRepair = !!(x.backup?.production_ref && x.backup?.backup_ref && x.backup?.rollback_point && x.browser_baseline?.pages?.["/"]);
    } });
    assert.equal(o.state, "COMPLETED", `${states.join(" → ")} · ${o.blocked_reason} · ${JSON.stringify(o.browser_validation?.codes)}`);
    assert.ok(inOrder(states, ["ACCESS_CHECK", "ACCESS_PROFILE_PREFLIGHT", "ACCESS_CHECK", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED"]), states.join(" → "));
    assert.deepEqual([o.route.adapter, o.access_profile.profile_status, o.payment.satisfied, o.access.ok], ["sftp", "PROFILE_READY", true, true]);

    // (6) BACKUP vor dem ersten Write.
    assert.equal(writesBeforeBackup, 0, "kein Write vor dem Backup");
    assert.ok(backupSeenBeforeRepair, "Backup + Rollback-Referenz + Browser-Baseline existieren vor REPAIRING");
    assert.ok(ctx.log.indexOf("backup") >= 0 && ctx.log.indexOf("backup") < ctx.log.indexOf("applyFix"));
    const bk = JSON.parse(fs.readFileSync(path.join(ctx.dir, "repair_backups", `${id}.json`), "utf8"));
    assert.equal(bk.entries.length, 2, "je Write ein Objekt-Backup");
    assert.ok(bk.entries.every((e) => e.status === "applied" && e.object_id === "index.html" && e.original_hash && e.after_hash));
    assert.equal(Buffer.from(bk.entries[0].original_content, "base64").toString("utf8"), BROKEN_INDEX, "Original vor dem ersten Write gesichert");

    // Persistierte Baseline (wie im echten Workflow) + Plan nur aus allowlisteten Fix-Arten.
    const issues = Object.values(o.audit_before.issues);
    assert.ok(issues.some((i) => i.type === "contact_page_broken") && issues.some((i) => i.type === "broken_image"));
    for (const vp of ["desktop", "mobile"]) assert.ok(o.browser_baseline.pages["/"][vp].findings.every((f) => f.present === true), `Baseline ${vp} persistiert`);
    assert.deepEqual(o.plan.map((p) => p.fix.fix_type).sort(), ["replace_href", "replace_src"]);

    // (7) Reparatur unabhängig bewiesen – Datei, HTTP, Browser.
    assert.equal(await siteFile(lab, "index.html"), REPAIRED_INDEX, "genau die zwei Verweise ersetzt, sonst nichts");
    assert.deepEqual(ctx.writes.sort(), ["broken_image", "contact_page_broken"], "genau 2 Writes trotz Neustart nach jedem Schritt");
    const home = await httpGet("/");
    assert.deepEqual([home.status, home.location], [200, null], "Homepage 200 ohne Weiterleitung");
    assert.equal(hrefOf(home.body, "Kontakt"), "/kontakt.html", "Kontakt-Link an derselben Stelle (Navigation), zeigt jetzt auf ein gültiges Ziel");
    const kontakt = await httpGet("/kontakt.html");
    assert.deepEqual([kontakt.status, kontakt.location, new URL(kontakt.url).hostname], [200, null, DOMAIN], "Ziel 200, keine Redirect-Kette, gleiche Domain");
    assert.equal((await httpGet("/assets/img/lab-logo.svg")).status, 200);

    // (8) POST-REPAIR FULL RETEST – Desktop 1440×900 + Mobile 390×844, Klick auf den reparierten Link, Vergleich mit der Baseline.
    const b1 = await browserCheck("/", { findings: FINDINGS, before: o.browser_baseline.pages["/"] });
    for (const vp of ["desktop", "mobile"]) {
      const v = b1[vp];
      assertViewportHealthy(v, `Startseite ${vp}`);
      assert.deepEqual([v.width, v.height], vp === "desktop" ? [1440, 900] : [390, 844]);
      assert.ok(v.findings.length === 2 && v.findings.every((f) => f.ok === true && f.present === false), `${vp}: ${JSON.stringify(v.findings)}`);
      const link = v.findings.find((f) => f.type === "contact_page_broken");
      assert.deepEqual([link.checks.broken_reference_gone, link.checks.link_present, link.checks.target_loads, link.checks.target_same_domain], [true, true, true, true], `${vp}: reparierter Link klickbar`);
      assert.ok(v.interactions.includes("click_repaired_link") || v.interactions.includes("verify_target_url"), `${vp}: reparierter Link im Browser geöffnet`);
      console.log(`# ${vp}: ${v.interactions.join(",")}`);
    }
    if (b1.mobile.nav.menu_toggle) assert.ok(b1.mobile.nav.menu_toggle_used, "Mobile: Menü geöffnet, Navigation geprüft");
    assert.deepEqual([b1.decision.verdict, b1.decision.desktop_ok, b1.decision.mobile_ok], ["PASS", true, true], JSON.stringify(b1.decision));
    const bk1 = await browserCheck("/kontakt.html", { phase: "baseline" });
    for (const vp of ["desktop", "mobile"]) assertViewportHealthy(bk1[vp], `Kontaktseite ${vp}`);

    // (9) VORHER/NACHHER: Befund im unabhängigen Audit verschwunden (nicht nur applyFix ok).
    const audit1 = await realAuditor().audit(`${ORIGIN}/`);
    const key = (i) => `${i.type}|${new URL(i.url).pathname}`;
    assert.ok(!audit1.issues.some((i) => ["contact_page_broken|/kontakt-alt.html", "broken_image|/assets/lab-logo.svg"].includes(key(i))), "BEFORE PRESENT → AFTER ABSENT");
    assert.ok(Object.values(o.issues).filter((i) => ["contact_page_broken", "broken_image"].includes(i.type)).every((i) => i.repair_status === "repaired"));
    // (10) Keine neue Regression: nichts Relevantes, was es vorher nicht gab (Audit + Browser).
    const had = new Set(audit0.issues.map(key));
    assert.deepEqual(audit1.issues.filter((i) => ["medium", "high", "critical"].includes(i.severity) && !had.has(key(i))).map(key), []);
    assert.ok(["NONE", "LOW"].includes(b1.decision.level), `${b1.decision.level} ${b1.decision.codes}`);

    // (15) Abschluss-Gate vollständig + Workflow-Ergebnisse.
    assert.deepEqual(completionGate(o), { ok: true, missing: [] });
    assert.deepEqual([o.validation.build_ok, o.retest.http_ok, o.deployment.live_retest_ok, o.regression.found.length], [true, true, true, 0]);
    assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.navigation, o.browser_gate.regression, o.browser_validation.verdict], ["JA", "JA", "JA", "KEINE", "PASS"]);
    const deliveries = ctx.gmail.sentOf(FULFILLMENT_CLASS);
    assert.equal(deliveries.length, 1);
    assert.equal(reportUnsafe(deliveries[0].body, o), null);
    assert.ok(deliveries[0].body.includes("Behoben wurden:") && !/Nicht automatisch repariert/.test(deliveries[0].body), "Bericht: beide behoben, nichts offen");
    assert.equal(fs.existsSync(path.join(ctx.dir, ACCESS_VAULT_DIR, `${id}.json`)), false, "Credentials nach COMPLETED zerstört");
    for (const [f, text] of filesOf(ctx.dir)) assertNoSecrets(f, text);
    assertNoSecrets("Logs", ctx.logs.join("\n"));
    assert.notEqual(await webrootSnapshot(lab), siteBefore);
    console.log(`# POSITIV: ${states.join(" → ")}`);
    console.log(`# BEFORE: ${[k0, im0].map(key).join(", ")} · AFTER: ${audit1.issues.map(key).join(", ") || "–"} · Browser ${b1.decision.verdict}/${b1.decision.level}`);
  });

  // ===================================================================================================================
  // 2) NEGATIV: Reparatur behebt den Fehler, erzeugt aber eine neue Regression (massiver Overflow) → Rollback → Baseline
  // ===================================================================================================================
  test("REGRESSION: Fix behebt das Bild, schreibt aber zusätzlich eine Mobile-Überbreite (über den echten Adapter + Objekt-Backup) → Browser-Gate → Rollback → Ausgangszustand = Baseline → REPAIR_FAILED, nie COMPLETED", async () => {
    await resetSite(lab, { fixture: FX, files: SITE_054 });
    const siteBefore = await webrootSnapshot(lab);
    const baseline = await browserCheck("/", { findings: FINDINGS, phase: "baseline" });
    // Fehlerhafte Reparatur: dieselbe Stelle, aber mit zusätzlichem Inline-Style (900 px, max-width aufgehoben) – auf dem Desktop
    // (1440 px) unauffällig, auf dem Smartphone (390 px) deutliche Überbreite. Echter Write über den SFTP-Adapter, echtes Objekt-Backup.
    const ctx = newCtx({ applyFix: (issue, location, order, cred, real) => (issue.type === "broken_image"
      ? real.applyFix(issue, { ...location, replacement: `${location.replacement}" style="width:900px;max-width:none` }, order, cred) : undefined) });
    const id = await orderWithSecureAccess(ctx);
    const { o, states } = await workPhase(ctx, id);
    assert.ok(["REPAIR_FAILED", "MANUAL_REVIEW_REQUIRED"].includes(o.state), `${states.join(" → ")} · ${o.blocked_reason}`);
    assert.equal(o.state, "REPAIR_FAILED", o.blocked_reason);
    assert.ok(states.includes("RETEST") && o.validation.build_ok === true, "HTTP/technische Prüfung bestand – erst der Browser stoppt");
    assert.ok(o.browser_validation.codes.some((c) => /overflow|outside_viewport|over_viewport/.test(c)), o.browser_validation.codes.join());
    assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile], ["JA", "NEIN"], "Desktop unauffällig – das Mobile-Gate stoppt");
    assert.deepEqual([o.regression.browser, o.regression.rolled_back, o.regression.browser_rollback_verified, o.browser_gate.regression], [true, true, true, "ROLLBACK"]);
    assert.ok(ctx.log.includes("rollback"));
    // Ausgangszustand entspricht der Baseline – Datei, Webroot, Browser.
    assert.equal(await siteFile(lab, "index.html"), BROKEN_INDEX, "Original wiederhergestellt");
    assert.equal(await webrootSnapshot(lab), siteBefore, "Webroot identisch mit dem Stand vor dem Auftrag");
    const rb = await browserCheck("/", { findings: FINDINGS, phase: "rollback" });
    assert.ok(rollbackMatchesBaseline({ desktop: baseline.desktop, mobile: baseline.mobile }, rb), "Browser bestätigt Baseline");
    assert.ok(Object.values(o.issues).every((i) => i.repair_status !== "repaired"), "zurückgerollte Fixes gelten nicht als repariert");
    assert.equal(completionGate(o).ok, false);
    assert.throws(() => completeOrder(ctx.store, id), /READY_FOR_DELIVERY/);
    assert.deepEqual([ctx.gmail.sentOf(FULFILLMENT_CLASS).length, o.report], [0, null], "keine Erfolgsmail, kein Erfolgsbericht");
    await runWorker(ctx);
    assert.equal(readOrder(ctx.store, id).state, "REPAIR_FAILED", "Neustart: kein Abschluss");
    console.log(`# REGRESSION: ${states.join(" → ")} · ${o.browser_validation.codes.join(",")}`);
  });

  // ===================================================================================================================
  // 3) NEGATIV: Teilreparatur – Befund 1 behoben, Befund 2 bleibt offen
  // ===================================================================================================================
  test("TEILREPARATUR: 2 reparierbare Befunde, Fix 2 schlägt fehl (kein Write) → Befund 2 bleibt offen → nie COMPLETED, keine Erfolgsmail", async () => {
    await resetSite(lab, { fixture: FX, files: SITE_054 });
    const hook = (issue) => (issue.type === "broken_image" ? { ok: false, reason: "write_failed_simulated" } : undefined);
    const ctx = newCtx({ applyFix: hook });
    const id = await orderWithSecureAccess(ctx);
    const { o, states } = await workPhase(ctx, id);
    const before = Object.values(o.audit_before.issues).filter((i) => i.repairable).map((i) => i.type).sort();
    assert.deepEqual(before, ["broken_image", "contact_page_broken"], "2 reparierbare Befunde vorher");
    assert.ok(["REPAIR_FAILED", "MANUAL_REVIEW_REQUIRED"].includes(o.state), `${states.join(" → ")} · ${o.blocked_reason}`);
    assert.ok(!states.includes("READY_FOR_DELIVERY") && !states.includes("COMPLETED"), states.join(" → "));
    assert.equal(completionGate(o).ok, false);
    assert.ok(completionGate(o).missing.includes("repair_unresolved"), completionGate(o).missing.join());
    assert.equal(Object.values(o.issues).find((i) => i.type === "broken_image").repair_status, "repair_failed");
    assert.equal((await httpGet("/assets/lab-logo.svg")).status, 404, "Befund 2 weiterhin offen (unabhängig geprüft)");
    assert.deepEqual([ctx.gmail.sentOf(FULFILLMENT_CLASS).length, o.report], [0, null], "nie «vollständig repariert»");
    await runWorker(ctx);
    assert.notEqual(readOrder(ctx.store, id).state, "COMPLETED");
    console.log(`# TEILREPARATUR: ${states.join(" → ")} · ${o.blocked_reason} · Status: ${JSON.stringify(Object.values(o.issues).filter((i) => i.repairable).map((i) => [i.type, i.repair_status]))}`);
  });

  // ===================================================================================================================
  // 4) GESCHÜTZTER BEREICH: AGB/Preise → keine automatische Inhaltsänderung → MANUAL_REVIEW_REQUIRED
  // ===================================================================================================================
  test("GESCHÜTZT: kaputte Links auf AGB und Preise (eindeutiges Ziel vorhanden) → kein Plan, 0 Writes, Webroot unverändert → MANUAL_REVIEW_REQUIRED", async () => {
    await resetSite(lab, { fixture: FX, files: SITE_PROTECTED });
    const siteBefore = await webrootSnapshot(lab);
    const ctx = newCtx();
    const id = await orderWithSecureAccess(ctx);
    const { o, states } = await workPhase(ctx, id);
    assert.equal(o.state, "MANUAL_REVIEW_REQUIRED", `${states.join(" → ")} · ${o.blocked_reason}`);
    const found = Object.values(o.audit_before.issues).filter((i) => i.type === "broken_link").map((i) => new URL(i.url).pathname).sort();
    assert.deepEqual(found, ["/agb-alt.html", "/preise-alt.html"], "Befunde erkannt");
    assert.deepEqual([o.plan.length, ctx.writes.length, ctx.log.includes("applyFix")], [0, 0, false], "keine automatische Inhaltsänderung");
    assert.equal(await webrootSnapshot(lab), siteBefore);
    assert.equal(ctx.gmail.sentOf(FULFILLMENT_CLASS).length, 0);
    console.log(`# GESCHÜTZT: ${states.join(" → ")} · ${o.blocked_reason}`);
  });

  // ===================================================================================================================
  // 5) NEUSTART / IDEMPOTENZ: Absturz mitten in REPAIRING (nach Fix 1, während Fix 2) → Fortsetzung ohne Doppel-Write/-Lieferung
  // ===================================================================================================================
  test("NEUSTART: Worker «stirbt» während Fix 2 (Fix 1 persistiert) → frischer Worker setzt fort, Fix 1 nie doppelt, 1 Lieferung, Neustarts danach ohne Wirkung, keine Credentials im State", async () => {
    await resetSite(lab, { fixture: FX, files: SITE_054 });
    let hung = false;
    const ctx = newCtx({ applyFix: (issue) => { if (issue.type === "broken_image" && !hung) { hung = true; return new Promise(() => {}); } return undefined; } });
    const id = await orderWithSecureAccess(ctx);
    for (let i = 0; i < 20 && readOrder(ctx.store, id).state !== "REPAIRING"; i++) await restartStep(ctx, id);
    assert.equal(readOrder(ctx.store, id).state, "REPAIRING");
    restartStep(ctx, id); // hängt in Fix 2 – dieser Worker wird aufgegeben (Absturz)
    const until = Date.now() + 120_000;
    while (!hung && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    assert.ok(hung, "Absturz während Fix 2 simuliert");
    const mid = readOrder(ctx.store, id);
    assert.deepEqual([mid.state, Object.values(mid.issues).filter((i) => i.repairable).map((i) => [i.type, i.repair_status]).sort()],
      ["REPAIRING", [["broken_image", "open"], ["contact_page_broken", "repaired"]]], "Fix 1 vor dem Absturz persistiert");
    const { o, states } = await workPhase(ctx, id);
    assert.equal(o.state, "COMPLETED", `${states.join(" → ")} · ${o.blocked_reason}`);
    assert.deepEqual(ctx.writes.sort(), ["broken_image", "contact_page_broken"], "jeder Fix genau einmal");
    assert.equal(ctx.log.filter((m) => m === "applyFix").length, 3, "Fix 1 einmal, Fix 2: abgebrochener + fortgesetzter Versuch");
    assert.equal(await siteFile(lab, "index.html"), REPAIRED_INDEX);
    const bk = JSON.parse(fs.readFileSync(path.join(ctx.dir, "repair_backups", `${id}.json`), "utf8"));
    assert.equal(bk.entries.length, 2, "kein zweites Backup/kein zweiter Write für Fix 1");
    await runWorker(ctx);
    await runWorker(ctx);
    assert.deepEqual([ctx.gmail.sentOf(FULFILLMENT_CLASS).length, ctx.writes.length, readOrder(ctx.store, id).state], [1, 2, "COMPLETED"], "keine zweite Lieferung, kein zweites Repair");
    for (const [f, text] of filesOf(ctx.dir)) assertNoSecrets(f, text);
    assert.ok(!/"(password|private_key|passphrase|secret)"\s*:/.test(JSON.stringify(readOrder(ctx.store, id))), "keine Credentials im Auftrag");
    console.log(`# NEUSTART: ${states.join(" → ")}`);
  });
}
