// FIRST CUSTOMER PRODUCTION READINESS & FULL ORDER DRY-RUN (TF-046) – EIN vollständiger Kundenauftrag Ende-zu-Ende gegen das isolierte
// TF-044-Docker-Lab (WordPress REST + MariaDB, OpenSSH/SFTP, Caddy-HTTPS) mit echtem Chromium – für das Browser-Gate UND für das
// Kundenformular (public/access.html: Verschlüsselung im Browser → Intake-API über HTTP → VPS-Pull → Entschlüsselung nur im Speicher →
// Tresor). Produktive Einstiegspunkte: createConfirmedRepairOrder, payments.js, runRepairOrders/runCheck150Orders, syncAccessIntake und
// die Engine-Schritte (Worker-Neustart = frische Engine + frische Adapter + frischer Store nach JEDEM Schritt).
// Nur Attrappen: Fake-Gmail (nichts verlässt den Rechner), Test-Ledger, Lab-Domains (*.test), zur Laufzeit erzeugte Test-Zugangsdaten.
// Läuft NUR über «npm run test:full-order-integration» (JARVIS_REPAIR_LAB=1) – fehlt Docker oder Chromium, schlägt der Lauf fehl.
import { test as baseTest, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../../../mail-worker.js";
import { recordDirectSale } from "../../../sales.js";
import { recordPayment, refundPayment, paymentsForOrder } from "../../../payments.js";
import { REPAIR_ORDERS_FILE, FULFILLMENT_CLASS, PUBLIC_REPAIR_FIELDS, createConfirmedRepairOrder, createRepairEngine, runRepairOrders, cancelRepairOrder,
  publicRepairOrders, reportUnsafe } from "../../../repair-workflow.js";
import { CHECK150_ORDERS_FILE, createCheck150Order, runCheck150Orders } from "../../../check-150-workflow.js";
import { createAccessIntakeHandler, memoryIntakeStore } from "../../../access-intake-api.js";
import { intakeClient, syncAccessIntake, sealEnvelope, ACCESS_VAULT_DIR } from "../../../access-intake.js";
import { sftpAdapter } from "../../../repair-adapters/sftp.js";
import { sshAdapter } from "../../../repair-adapters/ssh.js";
import { wordpressAdapter } from "../../../repair-adapters/wordpress.js";
import { createAdapterRegistry } from "../../../repair-adapters/router.js";
import { chromiumLauncher, chromiumExecutable } from "../../../repair-browser-validator.js";
import { cleanRepair } from "../../../server-control.js";
import { dockerAvailable, cleanupAll, labResources, startLab, resetSite, siteFile, writeSiteFile, sshdLog, wpCli, wpContent, wpGuardSnapshot, webrootSnapshot,
  labAuditor, labRetester, labBrowserValidator, DOMAINS, FIXTURES, WP_BROKEN } from "../repair-lab/lab.mjs";

const ENABLED = process.env.JARVIS_REPAIR_LAB === "1";
const test = (name, fn) => baseTest(name, { timeout: 900_000 }, fn);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "..", "..", "public");
const FX = "browser-broken";
const fixture = (rel) => fs.readFileSync(path.join(FIXTURES, FX, rel), "utf8");
const CLEAN_CSS = () => fixture("css/site.css").replace(".hero { width: 1400px; }", ".hero { max-width: 100%; }");
const COMPANY = "Muster Kunde AG";
const EMAIL = "auftrag@muster-kunde.test";
const WT = crypto.randomBytes(32).toString("base64url"); // Test-Worker-Token nur für diesen Lauf
const T_TMP = /^jarvis-(fo46|shot|chromium)-/;
// WordPress-Ausgangslage dieses Laufs: Startseite zusätzlich mit Link aufs Impressum, dort ein kaputter Link (geschützte Seite).
const START46 = `${WP_BROKEN.start}<p><a href="/impressum/">Impressum</a></p>`;
const IMPRESSUM = '<p>Impressum (nur Testdaten).</p><p><a href="/agb-alt/">AGB</a></p>';

let lab, browser, intake, customer, tempBefore = [];
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-fo46-")); dirs.push(d); return d; };
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const tmpEntries = () => fs.readdirSync(os.tmpdir()).filter((f) => T_TMP.test(f));
const secretsOf = () => [lab.secrets.labuser_password, lab.secrets.key_passphrase, lab.secrets.wp_app_password, lab.secrets.wp_editor_password, lab.secrets.wp_admin_password,
  lab.privateKey.split(/\r?\n/)[2], WT].filter(Boolean);
const assertNoSecrets = (label, text) => { for (const v of secretsOf()) assert.ok(!String(text).includes(v), `${label} enthält Test-Zugangsdaten`); };
const filesOf = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
const inOrder = (list, wanted) => { let i = 0; for (const x of list) if (x === wanted[i]) i++; return i === wanted.length; };

// ---------- Fake-Gmail: zeichnet nur auf, nichts verlässt den Rechner ----------
function fakeGmail() {
  const calls = [];
  return { calls,
    createDraft: async (x) => { calls.push({ op: "create", id: "dr" + (calls.length + 1), to: x.to, subject: x.subject, body: x.body, messageClass: x.messageClass }); return { draftId: "dr" + calls.length }; },
    sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "m-" + id }; },
    sentOf: (cls) => calls.filter((c) => c.op === "SEND").map((s) => calls.find((c) => c.op === "create" && c.id === s.id)).filter((c) => c && (!cls || c.messageClass === cls)) };
}

// ---------- Intake-Cloud lokal: echte access-intake-API (In-Memory-Blobs) + echtes Kundenformular über HTTP ----------
async function startIntake() {
  const blobs = memoryIntakeStore();
  const ops = [], bodies = [];
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined) });
  const STATIC = { "/access.html": "text/html; charset=utf-8", "/access.js": "text/javascript", "/access-crypto.js": "text/javascript", "/access.css": "text/css" };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && STATIC[u.pathname]) { res.writeHead(200, { "content-type": STATIC[u.pathname], "cache-control": "no-store" }); res.end(fs.readFileSync(path.join(PUBLIC, u.pathname.slice(1)))); return; }
    if (req.method === "POST" && u.pathname === "/api/access-intake") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      bodies.push(raw); try { ops.push(JSON.parse(raw).op); } catch {}
      const headers = { "content-type": "application/json", ...(req.headers["x-jarvis-worker"] ? { "x-jarvis-worker": String(req.headers["x-jarvis-worker"]) } : {}) };
      const r = await handler(new Request(`http://127.0.0.1${u.pathname}`, { method: "POST", headers, body: raw }));
      res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(await r.text()); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = intakeClient({ config: { url: `${origin}/api/state`, workerToken: WT } }); // echter Client, echtes HTTP (nur 127.0.0.1)
  return { blobs, ops, bodies, origin, client, close: () => new Promise((r) => server.close(r)) };
}
const linkIn = (mail) => mail?.body.match(/http:\/\/127\.0\.0\.1:\d+\/access\.html#t=[A-Za-z0-9_%-]+/)?.[0] || null;
const tokenOf = (link) => decodeURIComponent(link.split("#t=")[1]);
const intakeApi = async (body) => { const r = await fetch(`${intake.origin}/api/access-intake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

// ---------- Kunde im echten Chromium ----------
async function startCustomerBrowser() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chromium-customer-"));
  const b = await chromiumLauncher()({ home });
  return { b, home, close: async () => { await b.close().catch(() => {}); fs.rmSync(home, { recursive: true, force: true }); } };
}
async function customerForm(link, { type, host, user, secret, root = null, hostKey = null, consent = true }) {
  const ctx = await customer.b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    const page = await ctx.newPage();
    await page.goto(link, { waitUntil: "load" });
    await page.waitForSelector("#form:not([hidden])", { timeout: 20_000 });
    assert.ok(!page.url().includes("#t="), "Token sofort aus der Adresszeile entfernt");
    const shown = await page.textContent("#domain");
    await page.selectOption("#type", type);
    await page.fill("#host", host); await page.fill("#user", user); await page.fill("#secret", secret);
    if (root) await page.fill("#root", root);
    if (hostKey) await page.fill("#hostKey", hostKey);
    if (consent) await page.check("#consent");
    await page.click("#send");
    if (!consent) { await page.waitForSelector("#formErr:not([hidden])", { timeout: 10_000 }); return { ok: false, shown, error: await page.textContent("#formErr") }; }
    await page.waitForSelector("#done:not([hidden])", { timeout: 30_000 });
    return { ok: true, shown, cleared: (await page.inputValue("#secret")) === "" };
  } finally { await ctx.close(); }
}
async function customerConfirmsHostKey(link) {
  const ctx = await customer.b.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(link, { waitUntil: "load" });
    await page.waitForSelector("#hkForm:not([hidden])", { timeout: 20_000 });
    const fp = (await page.textContent("#hkFingerprint")).trim();
    assert.ok(Object.values(lab.hostKeys).includes(fp), "Kunde vergleicht mit der Angabe des Hosters (Lab: ssh-keygen -lf)");
    await page.check("#hkConsent");
    await page.click("#hkYes");
    await page.waitForSelector("#hkDone:not([hidden])", { timeout: 20_000 });
    return fp;
  } finally { await ctx.close(); }
}

// ---------- Produktions-Abhängigkeiten (echte Adapter + Registry + Preflight), Aufruf-Zähler je Adapter ----------
function counted(real, counts, hooks = {}) {
  const out = { ...real };
  for (const m of ["checkAccess", "backup", "locate", "applyFix", "validate", "deployProduction", "rollback", "cleanup"]) {
    if (typeof real[m] !== "function") continue;
    out[m] = async (...a) => {
      counts.log.push(m);
      if (m === "rollback" && hooks.rollbackFails) return { ok: false };
      const r = await real[m](...a);
      if (m === "applyFix" && r?.ok) { counts.writes++; if (hooks.inject && !counts.injected) { counts.injected = true; await hooks.inject(); } }
      if (m === "rollback" && r?.ok && hooks.restore && counts.injected) { await hooks.restore(); counts.injected = false; }
      return r;
    };
  }
  return out;
}
async function depsFor(ctx) {
  const real = { wordpress: wordpressAdapter({ dir: ctx.dir, fetchFn: lab.fetch }), sftp: sftpAdapter({ dir: ctx.dir, fetchFn: lab.fetch }), ssh: sshAdapter({ dir: ctx.dir, fetchFn: lab.fetch }) };
  const contracts = Object.fromEntries(Object.entries(real).map(([k, a]) => [k, counted(a, ctx.counts, ctx.hooks?.[k] || {})]));
  const reg = await createAdapterRegistry({ dir: ctx.dir, store: createStore(ctx.dir), fetchFn: lab.fetch, legacy: {}, contracts });
  return { adapters: reg.adapters, router: reg.router, preflight: reg.preflight, auditor: labAuditor(lab.fetch), retester: labRetester(lab.fetch), browserValidator: browser };
}
function newCtx({ domain, hooks = {} } = {}) {
  const dir = tmp();
  return { dir, store: createStore(dir), gmail: fakeGmail(), counts: { log: [], writes: 0, injected: false }, hooks, alerts: [], logs: [], domain };
}
const logFn = (ctx) => (level, event, data) => ctx.logs.push(JSON.stringify({ level, event, data }));
// Produktiver Worker-Lauf (eigener Prozesszustand je Aufruf = Neustart).
const runWorker = async (ctx) => runRepairOrders({ dir: ctx.dir, ...(await depsFor(ctx)), requireBrowser: true, autoDeliver: true, gmail: ctx.gmail, intake: intake.client,
  alert: async (a) => ctx.alerts.push(a.kind), log: logFn(ctx) });
// Genau EIN persistierter Schritt mit frischer Engine/Adaptern/Store – danach «stirbt» der Worker.
async function restartStep(ctx, id) {
  const store = createStore(ctx.dir);
  const engine = createRepairEngine({ dir: ctx.dir, store, ...(await depsFor(ctx)), requireBrowser: true, autoDeliver: true, gmail: ctx.gmail, intake: intake.client,
    alert: async (a) => ctx.alerts.push(a.kind), log: logFn(ctx) });
  return engine.step(structuredClone(readOrder(store, id)));
}
const authCalls = () => lab.fetch.calls.filter((c) => c.authorization).length;
const wpWrites = () => lab.fetch.calls.filter((c) => c.authorization && ["POST", "PUT", "PATCH"].includes(c.method) && /^\/wp-json\/wp\/v2\/(pages|posts)\/\d+/.test(c.path)).length;
const pubOf = (ctx, id) => publicRepairOrders(ctx.dir).orders.find((o) => o.order_id === id);
async function resetWp46() {
  await wpCli(lab, 'wp post update "$START_ID" --post_content="$START_HTML" >/dev/null && wp post update "$POST_ID" --post_content="$POST_HTML" >/dev/null && echo OK',
    { env: ["-e", `START_ID=${lab.wp.start}`, "-e", `START_HTML=${START46}`, "-e", `POST_ID=${lab.wp.post}`, "-e", `POST_HTML=${WP_BROKEN.post}`] });
}

// Bis Zugang + Freigabe eingegangen sind: bestätigter Auftrag → CHF 240 → Zugangs-Mail → Kundenformular im Browser → Pull.
async function orderWithSecureAccess(ctx, { domain, form }) {
  const o = createConfirmedRepairOrder(ctx.store, { domain, website: `https://${domain}/`, company: COMPANY, delivery_email: EMAIL, contact_name: "Frau Muster" });
  recordPayment(ctx.store, { order_id: o.order_id, amount_chf: 240, reference: `FO46-${o.order_id}`, source: "test_ledger" });
  await runWorker(ctx);
  const link = linkIn(ctx.gmail.sentOf("CUSTOMER_ACCESS_REQUEST")[0]);
  assert.ok(link, "Zugangs-Mail mit sicherem Link");
  const r = await customerForm(link, form);
  assert.ok(r.ok && r.cleared, "Formular übermittelt, Klartext geleert");
  return { id: o.order_id, link };
}

if (!ENABLED) {
  baseTest("Full Order Dry-Run (Docker + Chromium) – nur über «npm run test:full-order-integration»", { skip: "JARVIS_REPAIR_LAB=1 nicht gesetzt (eigene Docker-Suite)" }, () => {});
} else {
  before(async () => {
    assert.ok(await dockerAvailable(), "Docker nicht verfügbar – das TF-046-Release-Gate verlangt die echte Integration.");
    assert.ok(chromiumExecutable(), "Chromium nicht verfügbar – das TF-046-Release-Gate verlangt einen echten Browser.");
    tempBefore = tmpEntries();
    await cleanupAll();
    lab = await startLab({ log: (m) => console.log(`# ${m}`) });
    browser = await labBrowserValidator(lab);
    intake = await startIntake();
    customer = await startCustomerBrowser();
    // Impressum-Seite (geschützt) mit kaputtem Link – Test-Setup, kein Teil einer Reparatur.
    await wpCli(lab, 'wp post create --post_type=page --post_status=publish --post_title=Impressum --post_name=impressum --post_content="$IMP" --porcelain >/dev/null && echo OK',
      { env: ["-e", `IMP=${IMPRESSUM}`] });
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
    assert.deepEqual(tmpLeft, [], "keine Test-Tresore/-Schlüssel/Screenshots/Browser-Profile übrig");
  }, { timeout: 300_000 });

  // ===================================================================================================================
  // 1) FULL CHF 480 DRY RUN – WordPress (primärer E2E-Fall)
  // ===================================================================================================================
  test("FULL CHF480 DRY RUN (WordPress): Anfrage → ORDER_CONFIRMED → 239/240 → 1 Access-Mail → Browser-Formular → Pull/Tresor → Freigabe → PROFILE_READY → Backup → Audit → Plan → REST-Fix → Validierung → HTTP → Desktop/Mobile → Bericht → 1 Lieferung → Cleanup → COMPLETED", async () => {
    await resetWp46();
    const guard = await wpGuardSnapshot(lab);
    const domain = DOMAINS.wp;
    const ctx = newCtx({ domain });
    const phases = [];
    const snap = (id) => {
      const p = pubOf(ctx, id);
      if (phases.at(-1) !== p.phase) phases.push(p.phase);
      const cloudJson = JSON.stringify(cleanRepair(publicRepairOrders(ctx.dir)));
      assertNoSecrets("Dashboard", cloudJson);
      assert.ok(!cloudJson.includes(EMAIL) && !/access\.html|#t=|token|fingerprint|public_html/i.test(cloudJson), "Dashboard ohne Adresse/Link/Token/Pfad");
      return p;
    };
    const auth0 = authCalls(), w0 = wpWrites();

    // (1) Anfrage allein → kein Verkauf, kein Auftrag, keine Mail, keine Verbindung.
    assert.deepEqual(await runWorker(ctx), { busy: false, processed: 0, advanced: 0, states: {} });
    assert.deepEqual([Object.keys(ctx.store.read("sales.json", { records: {} }).records).length, ctx.gmail.calls.length, authCalls() - auth0], [0, 0, 0]);

    // (2) Bestätigter Auftrag, 0 CHF → WAITING_FOR_DEPOSIT · 0 Zugangs-Anfrage · 0 Adapter · 0 Write.
    const o0 = createConfirmedRepairOrder(ctx.store, { domain, website: `https://${domain}/`, company: COMPANY, delivery_email: EMAIL, contact_name: "Frau Muster" });
    const id = o0.order_id;
    await runWorker(ctx);
    let p = snap(id);
    assert.deepEqual([readOrder(ctx.store, id).state, p.phase, p.paid_chf, ctx.gmail.calls.length, ctx.counts.log.length, authCalls() - auth0], ["AUTHORIZATION_REQUIRED", "WAITING_FOR_DEPOSIT", 0, 0, 0, 0]);

    // (3) CHF 239 → blockiert; kumulativ CHF 240 → genau EINE Zugangs-Anfrage (Neustart dazwischen und danach).
    recordPayment(ctx.store, { order_id: id, amount_chf: 239, reference: "FO46-WP-1", source: "test_ledger" });
    await runWorker(ctx);
    p = snap(id);
    assert.deepEqual([p.phase, p.paid_chf, p.payment_ok, ctx.gmail.calls.length, intake.ops.length], ["WAITING_FOR_DEPOSIT", 239, false, 0, 0]);
    assert.throws(() => recordPayment(ctx.store, { order_id: id, amount_chf: 239, reference: "fo46-wp-1" }), /Doppelte Zahlungsreferenz/);
    await runWorker(ctx); // Neustart nach Payment: unverändert
    recordPayment(ctx.store, { order_id: id, amount_chf: 1, reference: "FO46-WP-2", source: "test_ledger" });
    await runWorker(ctx);
    p = snap(id);
    const accessMails = ctx.gmail.sentOf("CUSTOMER_ACCESS_REQUEST");
    assert.equal(accessMails.length, 1);
    const mail = accessMails[0], link = linkIn(mail);
    assert.deepEqual([mail.to, p.phase, p.paid_chf, p.access_requested], [EMAIL, "ACCESS_REQUEST_SENT", 240, true]);
    assert.ok(link && link.startsWith(intake.origin + "/access.html#t="), "One-Time-Link (Token nur im Fragment)");
    assert.match(mail.body, /KEINE Passwörter per E-Mail/);
    assert.ok(mail.body.includes(domain) && mail.subject.includes(domain) && !mail.body.includes(id) && !link.includes(id), "domaingebunden, keine Auftrags-ID");
    for (const bad of [/rabatt|newsletter|abmelden|jetzt buchen|sonderangebot/i, /passwort\s*:/i]) assert.ok(!bad.test(mail.body), `Access-Mail: ${bad}`);
    assertNoSecrets("Access-Mail", mail.body);
    const reg = JSON.parse(intake.blobs.dump());
    assert.deepEqual([reg.length, reg[0].order_id, reg[0].domain, reg[0].token_hash === crypto.createHash("sha256").update(tokenOf(link)).digest("hex")], [1, id, domain, true]);
    await runWorker(ctx); // Neustart nach der Zugangs-Anfrage
    assert.deepEqual([ctx.gmail.sentOf().length, intake.ops.filter((x) => x === "register").length], [1, 1], "keine zweite Mail, kein zweiter Token");

    // (4) Zugang ohne Freigabe → nie angenommen, 0 Writes. Browser verweigert ohne Zustimmung; manipulierte API-Einreichung → 400.
    const wpForm = { type: "wordpress_cms", host: `https://${domain}`, user: "jarvislab", secret: lab.secrets.wp_app_password };
    const noConsent = await customerForm(link, { ...wpForm, consent: false });
    assert.equal(noConsent.ok, false);
    assert.equal(noConsent.shown, domain, "Formular zeigt die Auftrags-Domain");
    assert.equal(intake.ops.filter((x) => x === "submit").length, 0, "ohne Zustimmung nichts übermittelt");
    const info = await intakeApi({ op: "info", token: tokenOf(link) });
    const env = sealEnvelope({ access_type: "wordpress_cms", host: `https://${domain}`, username: "jarvislab", secret: lab.secrets.wp_app_password }, info.body.public_key);
    assert.equal((await intakeApi({ op: "submit", token: tokenOf(link), access_type: "wordpress_cms", access_domain: domain, consent: false, envelope: env })).status, 400);
    assert.equal((await intakeApi({ op: "submit", token: tokenOf(link), access_type: "wordpress_cms", access_domain: "evil-lab.test", consent: true, envelope: env })).status, 400);
    await runWorker(ctx);
    let o = readOrder(ctx.store, id);
    assert.deepEqual([o.state, o.customer_authorized_repair, ctx.counts.writes, wpWrites() - w0, authCalls() - auth0], ["ACCESS_REQUESTED", false, 0, 0, 0]);

    // (5) Echter Kunden-Flow: Browser verschlüsselt → Intake-API → One-Time-Link tot.
    const sent = await customerForm(link, wpForm);
    assert.ok(sent.ok && sent.cleared);
    for (const b of intake.bodies) assertNoSecrets("Intake-Request (Netz)", b);
    assertNoSecrets("Intake-Cloud", intake.blobs.dump());
    assert.equal((await intakeApi({ op: "info", token: tokenOf(link) })).status, 404, "Link nach Einreichung tot");

    // (6) VPS-Pull → Entschlüsselung nur im Speicher → Tresor (nur Chiffrat) → quittiert. Neustart: kein Duplikat.
    assert.deepEqual(await syncAccessIntake({ store: createStore(ctx.dir), intake: intake.client }), { accepted: 1, rejected: 0 });
    assert.equal(intake.blobs.dump(), "[]", "Cloud-Eintrag gelöscht");
    assert.deepEqual(await syncAccessIntake({ store: createStore(ctx.dir), intake: intake.client }), { accepted: 0, rejected: 0 });
    const vault = path.join(ctx.dir, ACCESS_VAULT_DIR, `${id}.json`);
    assert.ok(fs.existsSync(vault));
    assertNoSecrets("Tresor", fs.readFileSync(vault, "utf8"));
    o = readOrder(ctx.store, id);
    assert.deepEqual([o.access_intake.status, o.access_intake.connector_type, o.authorization.source, o.authorization.authorized_domain, o.customer_authorized_repair],
      ["RECEIVED", "wordpress_cms", "secure_order_access_form", domain, true]);
    p = snap(id);
    assert.deepEqual([p.phase, p.access_received, p.authorized], ["ACCESS_RECEIVED", true, true]);

    // (7) Arbeitsphase: je Schritt ein frischer Worker (Neustart nach Access-Intake, Profil, Backup, Audit, Repair, Validierung, vor/nach Delivery).
    const states = [readOrder(ctx.store, id).state];
    let writesAtBackup = null;
    for (let i = 0; i < 30; i++) {
      await restartStep(ctx, id);
      o = readOrder(ctx.store, id);
      if (o.state !== states.at(-1)) states.push(o.state);
      snap(id);
      if (o.state === "FULL_AUDIT" && writesAtBackup == null) { writesAtBackup = wpWrites() - w0; assert.ok(o.backup?.rollback_point && o.backup?.backup_ref, "Backup + Rollback-Punkt vor jeder Änderung"); }
      if (["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS", "REPAIR_FAILED", "MANUAL_REVIEW_REQUIRED", "VALIDATION_FAILED", "BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION", "PAYMENT_REVIEW_REQUIRED"].includes(o.state)) break;
    }
    // TF-055: der geschützte AGB-Link auf dem Impressum bleibt bewusst offen → abgeschlossen MIT manuellem Punkt, nie «COMPLETED».
    assert.equal(o.state, "COMPLETED_WITH_MANUAL_ITEMS", `${states.join(" → ")} · ${o.blocked_reason} · ${JSON.stringify(o.delivery)} · ${JSON.stringify(o.browser_validation?.codes)}`);
    assert.ok(inOrder(states, ["ACCESS_CHECK", "ACCESS_PROFILE_PREFLIGHT", "ACCESS_CHECK", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED_WITH_MANUAL_ITEMS"]), states.join(" → "));
    assert.match(o.report.body, /Die automatisch reparierbaren Probleme wurden behoben\. Weitere Punkte erfordern eine manuelle Prüfung\./);

    // Profil automatisch (kein Chris-Schritt).
    assert.deepEqual([o.route.adapter, o.access_profile.profile_status, o.access_profile.interface], ["wordpress", "PROFILE_READY", "wordpress_rest"]);
    // Backup tatsächlich vor der ersten Änderung, Rollback möglich, keine Credentials im Backup.
    assert.equal(writesAtBackup, 0);
    assert.ok(ctx.counts.log.indexOf("backup") >= 0 && ctx.counts.log.indexOf("backup") < ctx.counts.log.indexOf("applyFix"));
    const bkFile = path.join(ctx.dir, "repair_backups", `${id}.json`);
    const bk = JSON.parse(fs.readFileSync(bkFile, "utf8"));
    assert.equal(bk.entries.length, 2);
    assert.ok(bk.entries.every((e) => e.status === "applied" && e.original_hash && e.original_content), "je Write ein Objekt-Backup (Original + Hash) → Rollback möglich");
    assert.equal(Buffer.from(bk.entries.find((e) => String(e.object_id) === String(lab.wp.start)).original_content, "base64").toString("utf8"), START46, "Original der Startseite gesichert");
    assertNoSecrets("Objekt-Backup", fs.readFileSync(bkFile, "utf8"));
    // Audit (echt): Link + Bild + geschützte Impressum-Seite.
    const issues = Object.values(o.audit_before.issues);
    assert.ok(issues.some((i) => i.type === "broken_link" && /\/team-alt\/$/.test(i.url)) && issues.some((i) => i.type === "broken_image") && issues.some((i) => i.protected && /impressum/.test(i.page)), JSON.stringify(issues.map((i) => [i.type, i.url, i.page])));
    // Plan: nur sichere Befunde, geschützte Bereiche ausgeschlossen, alle Pflichtfelder, keine Credentials.
    assert.equal(o.plan.length, 2);
    for (const item of o.plan) for (const k of ["issue", "adapter", "target", "before_hash", "planned_change", "validation", "rollback"]) assert.ok(item[k], `Plan.${k}`);
    assert.ok(!o.plan.some((x) => /impressum|agb/i.test(JSON.stringify(x))), "geschützte Seite nicht im Plan");
    assert.ok(o.manual_review.some((m) => /geschützten Seite/.test(m.reason)));
    assertNoSecrets("Plan", JSON.stringify(o.plan));
    // Repair: genau 2 echte REST-Writes (kein Doppelwrite trotz Neustart nach jedem Schritt), Minimal-Fix.
    assert.deepEqual([ctx.counts.writes, wpWrites() - w0], [2, 2]);
    assert.equal(await wpContent(lab, lab.wp.start), START46.replace("/team-alt/", "/team/"));
    assert.ok(!(await wpContent(lab, lab.wp.post)).includes("/2020/01/lab-logo.png"), "Bild neu zugewiesen");
    // Technische Validierung + HTTP-Retest + Browser Desktop/Mobile.
    assert.deepEqual([o.validation.build_ok, o.retest.http_ok, o.deployment.live_retest_ok], [true, true, true]);
    assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.navigation, o.browser_gate.regression, o.browser_validation.verdict], ["JA", "JA", "JA", "KEINE", "PASS"]);
    assert.ok(["NONE", "LOW"].includes(o.browser_validation.level), `${o.browser_validation.level} ${o.browser_validation.codes}`);
    for (const [pg, r] of Object.entries(o.browser_validation.pages)) for (const vp of ["desktop", "mobile"]) {
      const v = r[vp];
      assert.deepEqual([v.load_ok, v.overflow.horizontal, v.images.broken, v.console.page_errors, v.network.failed_same_site], [true, false, 0, 0, 0], `${pg} ${vp}`);
      assert.ok(v.findings.every((f) => f.ok === true), `${pg} ${vp}: ${JSON.stringify(v.findings)}`);
    }
    assert.ok(o.browser_baseline.pages["/"].desktop.findings[0].present && o.browser_baseline.pages["/lab-news/"].desktop.findings[0].present, "VORHER im Browser sichtbar");
    // Kundenbericht + Lieferung (genau 1 CUSTOMER_ORDER_FULFILLMENT).
    const deliveries = ctx.gmail.sentOf(FULFILLMENT_CLASS);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].to, EMAIL);
    const body = deliveries[0].body;
    for (const must of ["Gefundene relevante Punkte: 3", "Behoben wurden:", "Nicht automatisch repariert", "Desktop geprüft: Ja", "Mobile geprüft: Ja", "Retest", "erfolgreich", "temporären Zugang"])
      assert.ok(body.includes(must), `Bericht: ${must}`);
    assert.equal(reportUnsafe(body, o), null);
    for (const bad of ["https://", "127.0.0.1", "/home/", "public_html", "wp-json", id, ...bk.entries.map((e) => e.backup_id), o.backup.production_ref, "Bearer", "console"]) assert.ok(!body.includes(bad), `Bericht enthält ${bad}`);
    assertNoSecrets("Bericht", body);
    assert.deepEqual([o.delivery.status, o.delivery.message_class], ["sent", FULFILLMENT_CLASS]);
    // Credential Cleanup.
    assert.equal(fs.existsSync(vault), false, "Tresor-Eintrag zerstört");
    assert.deepEqual(Object.keys(o.access_intake).sort(), ["access_domain", "connector_type", "destroyed_at", "received_at", "revoked_required", "status"]);
    assert.deepEqual([o.access_intake.status, o.access_intake.revoked_required, !!o.access_intake.destroyed_at], ["DESTROYED", true, true]);
    assert.ok(o.access_profile.cleared_at && !("host_key_sha256" in o.access_profile));
    // Neustart nach der Lieferung (Produktionsweg): nichts mehr – keine Mail, kein Write, keine Zahlung.
    await runWorker(ctx);
    assert.deepEqual([ctx.gmail.sentOf().length, wpWrites() - w0, paymentsForOrder(ctx.store, id).length], [2, 2, 2]);
    // Dashboard-Phasen (feste Wörter, keine Secrets).
    p = snap(id);
    assert.deepEqual([p.phase, p.payment_ok, p.access_received, p.authorized, p.profile_status, p.backup_ok, p.repaired, p.browser_desktop, p.browser_mobile, p.browser_regression, p.delivery_status],
      ["COMPLETED_WITH_MANUAL_ITEMS", true, true, true, "PROFILE_READY", true, 2, "JA", "JA", "KEINE", "sent"]);
    assert.ok(inOrder(phases, ["WAITING_FOR_DEPOSIT", "ACCESS_REQUEST_SENT", "ACCESS_RECEIVED", "ACCESS_PROFILE_PREFLIGHT", "BACKUP", "REPAIRING", "VALIDATING", "LIVE_RETEST", "READY_FOR_DELIVERY", "COMPLETED_WITH_MANUAL_ITEMS"]), phases.join(" → "));
    assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_REPAIR_FIELDS].sort());
    for (const [f, text] of filesOf(ctx.dir)) assertNoSecrets(f, text);
    assertNoSecrets("Logs", ctx.logs.join("\n"));
    assertNoSecrets("Mails", JSON.stringify(ctx.gmail.calls));
    assert.equal(await wpGuardSnapshot(lab), guard, "kein Plugin/Theme/User/Setting geändert");
    console.log(`# CHF480 WordPress: ${states.join(" → ")}`);
    console.log(`# Dashboard-Phasen: ${phases.join(" → ")}`);
  });

  // ===================================================================================================================
  // 2) Zugang vorhanden, Freigabe fehlt → 0 Writes
  // ===================================================================================================================
  test("AUTHORIZATION: Zugang im Tresor, aber customer_authorized_repair=false → BLOCKED_NO_AUTHORIZATION, 0 Adapter-Aufrufe, 0 Writes", async () => {
    await resetWp46();
    const ctx = newCtx({ domain: DOMAINS.wp });
    const { id } = await orderWithSecureAccess(ctx, { domain: DOMAINS.wp, form: { type: "wordpress_cms", host: `https://${DOMAINS.wp}`, user: "jarvislab", secret: lab.secrets.wp_app_password } });
    await syncAccessIntake({ store: ctx.store, intake: intake.client });
    const data = ctx.store.read(REPAIR_ORDERS_FILE, { orders: {} });
    Object.assign(data.orders[id], { customer_authorized_repair: false }); // Freigabe fehlt/entzogen (isolierter Negativfall)
    ctx.store.write(REPAIR_ORDERS_FILE, data);
    const w0 = wpWrites();
    await restartStep(ctx, id);
    await runWorker(ctx);
    const o = readOrder(ctx.store, id);
    assert.equal(o.state, "BLOCKED_NO_AUTHORIZATION", o.blocked_reason);
    assert.deepEqual([ctx.counts.log.length, ctx.counts.writes, wpWrites() - w0], [0, 0, 0]);
    assert.equal(ctx.gmail.sentOf(FULFILLMENT_CLASS).length, 0);
    assert.equal(await wpContent(lab, lab.wp.start), START46);
  });

  // ===================================================================================================================
  // 3) Zweiter Dry-Run: SFTP mit remote_root + Host-Key-Bestätigung durch den Kunden (produktiver Flow)
  // ===================================================================================================================
  test("SFTP DRY RUN: remote_root aus dem Formular, Host-Key unbekannt → Bestätigungs-Mail → Kunde bestätigt im Browser → PROFILE_READY → Atomic Replace → Browser → 1 Lieferung → COMPLETED", async () => {
    await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
    const domain = DOMAINS.site;
    const ctx = newCtx({ domain });
    const sftpForm = { type: "sftp", host: `sftp://${lab.ssh.host}:${lab.ssh.port}`, user: "labuser", secret: lab.secrets.labuser_password, root: "public_html" };
    const mark = (await sshdLog(lab)).length;
    const { id } = await orderWithSecureAccess(ctx, { domain, form: sftpForm });
    await runWorker(ctx); // Pull → Preflight → Host-Key unbekannt
    let o = readOrder(ctx.store, id);
    assert.equal(o.state, "HOST_KEY_CONFIRMATION_REQUIRED", `${o.state} ${o.blocked_reason} ${JSON.stringify(o.access_profile)}`);
    assert.ok(!/Accepted (password|publickey) for labuser/.test((await sshdLog(lab)).slice(mark)), "vor der Bestätigung keine Anmeldung mit Zugangsdaten");
    const hkMails = ctx.gmail.sentOf("CUSTOMER_ACCESS_REQUEST");
    assert.equal(hkMails.length, 2, "Zugangs-Anfrage + Host-Key-Bestätigung");
    assert.ok(!hkMails[1].body.includes("SHA256:"), "Fingerprint nur auf der Link-Seite");
    await runWorker(ctx); // Neustart: keine zweite Bestätigungs-Mail
    assert.equal(ctx.gmail.sentOf().length, 2);
    const fp = await customerConfirmsHostKey(linkIn(hkMails[1]));
    await runWorker(ctx);
    o = readOrder(ctx.store, id);
    assert.equal(o.state, "COMPLETED", `${o.state_history.map((h) => h.to).join(" → ")} · ${o.blocked_reason} · ${JSON.stringify(o.browser_validation?.codes)}`);
    assert.ok(inOrder(o.state_history.map((h) => h.to), ["HOST_KEY_CONFIRMATION_REQUIRED", "ACCESS_PROFILE_PREFLIGHT", "ACCESS_CHECK", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED"]));
    assert.deepEqual([o.route.adapter, o.access_profile.profile_status, o.access_profile.host_key_source, o.access_profile.webroot_source],
      ["sftp", "PROFILE_READY", "customer_confirmation", "customer_form"]);
    assert.ok(fp.startsWith("SHA256:"));
    assert.match((await sshdLog(lab)).slice(mark), /Accepted password for labuser/);
    const index = await siteFile(lab, "index.html");
    assert.ok(!index.includes("/team-alt.html") && !index.includes('src="/assets/lab-logo.svg"') && index.includes("/team.html"), "Link + Bild per Atomic Replace repariert");
    assert.ok(!/\.jarvis-[0-9a-f]+\.tmp/.test(await webrootSnapshot(lab)), "keine Temp-Dateien");
    assert.deepEqual([o.validation.build_ok, o.retest.http_ok, o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.regression], [true, true, "JA", "JA", "KEINE"]);
    assert.equal(ctx.gmail.sentOf(FULFILLMENT_CLASS).length, 1);
    assert.equal(reportUnsafe(ctx.gmail.sentOf(FULFILLMENT_CLASS)[0].body, o), null);
    assert.equal(fs.existsSync(path.join(ctx.dir, ACCESS_VAULT_DIR, `${id}.json`)), false);
    for (const [f, text] of filesOf(ctx.dir)) assertNoSecrets(f, text);
    assertNoSecrets("Mails", JSON.stringify(ctx.gmail.calls));
  });

  // ===================================================================================================================
  // 4) FULL FAILURE FLOW: Reparatur erzeugt Browser-Regression
  // ===================================================================================================================
  test("FAILURE FLOW (E2E): Fix + Nebenwirkung (Mobile-Overflow) → Browser-Gate FAIL → Rollback → Browser-Retest → REPAIR_FAILED, keine Erfolgsmail, kein Erfolgsbericht", async () => {
    await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
    const domain = DOMAINS.site;
    const ctx = newCtx({ domain, hooks: { sftp: {
      inject: () => writeSiteFile(lab, "css/site.css", CLEAN_CSS().replace(".hero { max-width: 100%; }", ".hero { width: 900px; }")),
      restore: () => writeSiteFile(lab, "css/site.css", CLEAN_CSS()) } } });
    // Kunde gibt den Fingerprint seines Hosters gleich im Formular an (customer_form) – Fehlerfall ohne zweite Mail.
    const { id } = await orderWithSecureAccess(ctx, { domain, form: { type: "sftp", host: `sftp://${lab.ssh.host}:${lab.ssh.port}`, user: "labuser", secret: lab.secrets.labuser_password, root: "public_html", hostKey: lab.hostKeys.ed25519 } });
    await runWorker(ctx);
    const o = readOrder(ctx.store, id);
    assert.equal(o.state, "REPAIR_FAILED", `${o.blocked_reason} ${JSON.stringify(o.browser_validation?.codes)}`);
    assert.ok(o.state_history.some((h) => h.to === "RETEST") && o.validation.build_ok === true, "technische Prüfung bestanden – erst der Browser stoppt");
    assert.ok(o.browser_validation.codes.some((c) => /overflow/.test(c)), o.browser_validation.codes.join());
    assert.deepEqual([o.regression.browser, o.regression.rolled_back, o.regression.browser_rollback_verified, o.browser_gate.regression], [true, true, true, "ROLLBACK"]);
    assert.equal(await siteFile(lab, "index.html"), fixture("index.html"), "Original wiederhergestellt");
    assert.equal(ctx.gmail.sentOf(FULFILLMENT_CLASS).length, 0, "keine Customer-Success-Mail");
    assert.equal(o.report, null, "kein Bericht, der eine erfolgreiche Reparatur behauptet");
    assert.ok(Object.values(o.issues).every((i) => i.repair_status !== "repaired"), "zurückgerollte Fixes gelten nicht als repariert");
    assert.equal(pubOf(ctx, id).phase, "BLOCKED");
    assert.equal(fs.existsSync(path.join(ctx.dir, ACCESS_VAULT_DIR, `${id}.json`)), false, "Credentials nach REPAIR_FAILED zerstört");
  });

  // ===================================================================================================================
  // 5) ROLLBACK FAILURE (isoliert)
  // ===================================================================================================================
  test("ROLLBACK FAILURE: Regression + Rollback scheitert → MANUAL_REVIEW_REQUIRED + Chris-Alert, kein COMPLETED, keine Lieferung", async () => {
    await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
    const domain = DOMAINS.site;
    const ctx = newCtx({ domain, hooks: { sftp: { rollbackFails: true,
      inject: () => writeSiteFile(lab, "css/site.css", CLEAN_CSS().replace(".hero { max-width: 100%; }", ".hero { width: 900px; }")) } } });
    const { id } = await orderWithSecureAccess(ctx, { domain, form: { type: "sftp", host: `sftp://${lab.ssh.host}:${lab.ssh.port}`, user: "labuser", secret: lab.secrets.labuser_password, root: "public_html", hostKey: lab.hostKeys.ed25519 } });
    try {
      await runWorker(ctx);
      const o = readOrder(ctx.store, id);
      assert.equal(o.state, "MANUAL_REVIEW_REQUIRED", o.blocked_reason);
      assert.ok(ctx.alerts.includes("rollback_failed"), ctx.alerts.join());
      assert.equal(o.regression.rolled_back, false);
      assert.equal(ctx.gmail.sentOf(FULFILLMENT_CLASS).length, 0);
      assert.equal(pubOf(ctx, id).phase, "MANUAL_REVIEW");
      await runWorker(ctx);
      assert.equal(readOrder(ctx.store, id).state, "MANUAL_REVIEW_REQUIRED", "kein Abschluss");
    } finally { await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } }); }
  });

  // ===================================================================================================================
  // 6) PAYMENT REVERSAL vor und nach dem Write (WordPress)
  // ===================================================================================================================
  test("PAYMENT REVERSAL: vor dem Write → PAYMENT_REQUIRED (0 Writes); erneut bezahlt → läuft weiter; nach dem Write → PAYMENT_REVIEW_REQUIRED ohne automatischen Rollback", async () => {
    await resetWp46();
    const ctx = newCtx({ domain: DOMAINS.wp });
    const w0 = wpWrites();
    const { id } = await orderWithSecureAccess(ctx, { domain: DOMAINS.wp, form: { type: "wordpress_cms", host: `https://${DOMAINS.wp}`, user: "jarvislab", secret: lab.secrets.wp_app_password } });
    await syncAccessIntake({ store: ctx.store, intake: intake.client });
    for (let i = 0; i < 6 && readOrder(ctx.store, id).state !== "BACKUP"; i++) await restartStep(ctx, id);
    assert.equal(readOrder(ctx.store, id).state, "BACKUP");
    refundPayment(ctx.store, paymentsForOrder(ctx.store, id)[0].payment_id, { reason: "Test-Rückerstattung vor dem Write" });
    await restartStep(ctx, id);
    assert.deepEqual([readOrder(ctx.store, id).state, ctx.counts.writes, wpWrites() - w0], ["PAYMENT_REQUIRED", 0, 0]);
    assert.equal(pubOf(ctx, id).phase, "WAITING_FOR_DEPOSIT");
    recordPayment(ctx.store, { order_id: id, amount_chf: 240, reference: `FO46-REPAY-${id}`, source: "test_ledger" });
    for (let i = 0; i < 12 && readOrder(ctx.store, id).state !== "VALIDATION"; i++) await restartStep(ctx, id);
    assert.equal(readOrder(ctx.store, id).state, "VALIDATION");
    assert.equal(ctx.counts.writes, 2);
    const fixed = await wpContent(lab, lab.wp.start);
    refundPayment(ctx.store, paymentsForOrder(ctx.store, id).find((x) => x.status === "RECEIVED").payment_id, { reason: "Test-Rückerstattung nach dem Write" });
    await runWorker(ctx);
    const o = readOrder(ctx.store, id);
    assert.equal(o.state, "PAYMENT_REVIEW_REQUIRED");
    assert.equal(ctx.counts.log.filter((m) => m === "rollback").length, 0, "kein automatischer Rollback nur wegen Zahlung");
    assert.equal(await wpContent(lab, lab.wp.start), fixed);
    assert.equal(ctx.gmail.sentOf(FULFILLMENT_CLASS).length, 0);
    assert.equal(pubOf(ctx, id).phase, "PAYMENT_REVIEW_REQUIRED");
  });

  // ===================================================================================================================
  // 7) CANCEL vor der Reparatur
  // ===================================================================================================================
  test("CANCEL vor der Reparatur → CANCELLED, keine weiteren Adapter-Aufrufe, keine Mail, Credentials bereinigt", async () => {
    await resetWp46();
    const ctx = newCtx({ domain: DOMAINS.wp });
    const { id } = await orderWithSecureAccess(ctx, { domain: DOMAINS.wp, form: { type: "wordpress_cms", host: `https://${DOMAINS.wp}`, user: "jarvislab", secret: lab.secrets.wp_app_password } });
    await syncAccessIntake({ store: ctx.store, intake: intake.client });
    assert.ok(fs.existsSync(path.join(ctx.dir, ACCESS_VAULT_DIR, `${id}.json`)));
    const mails = ctx.gmail.calls.length, calls = ctx.counts.log.length, auth = authCalls();
    cancelRepairOrder(ctx.store, id, { reason: "Kunde storniert vor der Reparatur (Test)" });
    await runWorker(ctx);
    await runWorker(ctx);
    const o = readOrder(ctx.store, id);
    assert.deepEqual([o.state, ctx.counts.log.length - calls, authCalls() - auth, ctx.gmail.calls.length - mails], ["CANCELLED", 0, 0, 0]);
    assert.equal(fs.existsSync(path.join(ctx.dir, ACCESS_VAULT_DIR, `${id}.json`)), false);
    assert.deepEqual([o.access_intake.status, o.access_intake.revoked_required], ["DESTROYED", true]);
    assert.equal(await wpContent(lab, lab.wp.start), START46, "nichts verändert");
  });

  // ===================================================================================================================
  // 8) CHF 150 DRY RUN gegen die isolierte Website
  // ===================================================================================================================
  test("CHF150 DRY RUN: bestätigt → CHF 74 nichts (kein Audit) → CHF 75 echter Audit → Anleitung → Bericht → genau 1 CUSTOMER_ORDER_FULFILLMENT; Neustart kein Doppelversand", async () => {
    await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
    const dir = tmp(), store = createStore(dir), gmail = fakeGmail();
    const domain = DOMAINS.site;
    store.write("sales.json", { records: recordDirectSale({}, { domain, offer: "REPAIR_CHECK_150", delivery_email: EMAIL, company: COMPANY }) });
    const o = createCheck150Order(store, { domain, website: `https://${domain}/`, company: COMPANY, delivery_email: EMAIL, contact_name: "Frau Muster" });
    const r150 = () => store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id];
    const siteCalls = () => lab.fetch.calls.filter((c) => c.host === domain).length;
    const run150 = () => runCheck150Orders({ dir, gmail, auditor: labAuditor(lab.fetch), log: () => {} });
    recordPayment(store, { order_id: o.order_id, amount_chf: 74, reference: "FO46-150-74", source: "test_ledger" });
    const c0 = siteCalls();
    await run150();
    assert.deepEqual([r150().state, siteCalls() - c0, gmail.calls.length], ["BLOCKED_PAYMENT_NOT_RECEIVED", 0, 0], "CHF 74 → nichts");
    recordPayment(store, { order_id: o.order_id, amount_chf: 1, reference: "FO46-150-75", source: "test_ledger" });
    await run150();
    const done = r150();
    assert.equal(done.state, "COMPLETED", done.blocked_reason);
    assert.ok(siteCalls() - c0 > 0, "echter Audit gegen die Lab-Website");
    assert.ok(done.report_findings_count >= 2, String(done.report_findings_count));
    const sent = gmail.sentOf("CUSTOMER_ORDER_FULFILLMENT");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, EMAIL);
    for (const must of ["Schritte:", "Danach prüfen:", "Webseiten-Check"]) assert.ok(sent[0].body.includes(must), must);
    for (const bad of ["127.0.0.1", "/home/", "public_html", o.order_id]) assert.ok(!sent[0].body.includes(bad), bad);
    await run150();
    assert.equal(gmail.sentOf().length, 1, "Neustart: kein Doppelversand");
    assert.equal(await siteFile(lab, "index.html"), fixture("index.html"), "CHF 150 verändert nie die Website");
  });
}
