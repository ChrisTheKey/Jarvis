// BROWSER REPAIR VALIDATION LAB (TF-045): echtes Chromium gegen das isolierte TF-044-Docker-Lab (Caddy-HTTPS, OpenSSH/SFTP, WordPress).
// Vor jeder Reparatur Browser-Baseline, danach Desktop 1440×900 + Smartphone 390×844, Befund, Navigation, VORHER/NACHHER; absichtliche
// Regressionen (Mobile-Overflow, JS-Fehler, kaputtes Bild, WordPress-Nebenwirkung) → Rollback → Browser-Retest → REPAIR_FAILED.
// Nur Testdaten, Zugangsdaten nur zur Laufzeit, Gmail nur Attrappe, Zahlungen nur im Test-Ledger. Läuft NUR über
// «npm run test:browser-integration» (JARVIS_REPAIR_LAB=1) – fehlt Docker oder Chromium, schlägt der Lauf fehl (kein Skip).
import { test as baseTest, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../../../mail-worker.js";
import { recordPayment } from "../../../payments.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, createRepairEngine, completeOrder, completionGate, publicRepairOrders } from "../../../repair-workflow.js";
import { consentText, tokenHash } from "../../../access-intake-api.js";
import { applyAccessSubmission, accessKeys, sealEnvelope, ACCESS_VAULT_DIR } from "../../../access-intake.js";
import { sftpAdapter } from "../../../repair-adapters/sftp.js";
import { sshAdapter } from "../../../repair-adapters/ssh.js";
import { wordpressAdapter } from "../../../repair-adapters/wordpress.js";
import { createAdapterRegistry, setAccessProfile } from "../../../repair-adapters/router.js";
import { safeSnapshot, rollbackMatchesBaseline, SAFE_INTERACTIONS } from "../../../repair-browser-validator.js";
import { cleanRepair } from "../../../server-control.js";
import { dockerAvailable, cleanupAll, labResources, startLab, resetSite, resetWp, siteFile, writeSiteFile, removeSiteFile, sshdLog, wpContent, wpGuardSnapshot,
  labAuditor, labRetester, labBrowserValidator, docker, DOMAINS, FIXTURES, WP_BROKEN } from "./lab.mjs";

const ENABLED = process.env.JARVIS_REPAIR_LAB === "1";
const test = (name, fn) => baseTest(name, { timeout: 600_000 }, fn);
const ROOT = "/home/labuser/public_html";
const FX = "browser-broken";
const fixture = (rel) => fs.readFileSync(path.join(FIXTURES, FX, rel), "utf8");
const CLEAN_CSS = () => fixture("css/site.css").replace(".hero { width: 1400px; }", ".hero { max-width: 100%; }");
const SITE = (p = "/") => `https://${DOMAINS.site}${p}`;
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lab45w-")); dirs.push(d); return d; };
const browserTemp = () => fs.readdirSync(os.tmpdir()).filter((f) => /^jarvis-(shot|chromium)-/.test(f)).length;
let lab, browser, tempBefore = 0;
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const secretsOf = () => [lab.secrets.labuser_password, lab.secrets.key_passphrase, lab.secrets.wp_app_password, lab.secrets.wp_editor_password, lab.secrets.wp_admin_password,
  lab.privateKey.split(/\r?\n/)[2]].filter(Boolean);
const assertNoSecrets = (label, text) => { for (const v of secretsOf()) assert.ok(!String(text).includes(v), `${label} enthält Test-Zugangsdaten`); };
const filesOf = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
function fakeGmail() { const calls = []; return { calls, createDraft: async (x) => { calls.push({ op: "create", to: x.to }); return { draftId: "dr" + calls.length }; }, sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "m" }; } }; }
const pathOf = (o) => o.state_history.map((h) => h.to);

function orderWithAccess(store, dir, { domain, access_type, payload }) {
  const now = new Date();
  const o = createRepairOrder(store, { domain, website: `https://${domain}/`, company: "Lab Test AG", delivery_email: `kunde@${domain}`, contact_name: "Lab Kunde", now });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: `Lab-${o.order_id}`, now });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const token = crypto.randomBytes(32).toString("base64url");
  Object.assign(data.orders[o.order_id], { state: "ACCESS_REQUESTED", access_request: { token_hash: tokenHash(token), expires_at: new Date(+now + 72 * 3600e3).toISOString(), sent_at: now.toISOString(), draft_id: "d1" } });
  store.write(REPAIR_ORDERS_FILE, data);
  const envelope = sealEnvelope({ access_type, ...payload }, accessKeys(dir).publicKeyPem);
  const r = applyAccessSubmission(store, { order_id: o.order_id, token_hash: tokenHash(token), domain,
    submission: { submitted_at: now.toISOString(), access_domain: domain, consent: true, consent_text: consentText(domain), access_type, envelope } }, { now });
  assert.ok(r.ok, r.reason);
  return o.order_id;
}
const sftpPayload = () => ({ host: `sftp://${lab.ssh.host}:${lab.ssh.port}`, username: "labuser", secret: lab.secrets.labuser_password, remote_root: "public_html", ssh_host_key_sha256: lab.hostKeys.rsa });
const wpPayload = () => ({ host: `https://${DOMAINS.wp}`, username: "jarvislab", secret: lab.secrets.wp_app_password });

// Absichtlich fehlerhafte «Reparatur» (Testdoppel): der echte Adapter-Fix läuft, danach entsteht eine Nebenwirkung im Lab. rollback()
// macht – wie ein vollständiger Rollback – den echten Adapter-Rollback UND entfernt die Nebenwirkung (restore=null: Rollback unvollständig).
function faulty(real, { inject, restore = null }) {
  let injected = false;
  return { ...real,
    async applyFix(issue, loc, order, c) { const r = await real.applyFix(issue, loc, order, c); if (r?.ok && !injected) { injected = true; await inject(); } return r; },
    async rollback(order, b, c) { const r = await real.rollback(order, b, c); if (injected && restore) { await restore(); injected = false; } return r; } };
}
async function engineFor(dir, store, { wrap = {}, gmail = fakeGmail(), logs = [], alerts = [] } = {}) {
  const real = { wordpress: wordpressAdapter({ dir, fetchFn: lab.fetch }), sftp: sftpAdapter({ dir, fetchFn: lab.fetch }), ssh: sshAdapter({ dir, fetchFn: lab.fetch }) };
  const contracts = Object.fromEntries(Object.entries(real).map(([k, a]) => [k, wrap[k] ? faulty(a, wrap[k]) : a]));
  const reg = await createAdapterRegistry({ dir, store, fetchFn: lab.fetch, legacy: {}, contracts });
  const engine = createRepairEngine({ store, adapters: reg.adapters, router: reg.router, preflight: reg.preflight, auditor: labAuditor(lab.fetch), retester: labRetester(lab.fetch),
    browserValidator: browser, requireBrowser: true, gmail, alert: async (a) => alerts.push(a.kind), log: (level, event, data) => logs.push(JSON.stringify({ level, event, data })) });
  return { engine, gmail, logs, alerts };
}
// Persistierter Auftrag: nur sichere Browser-Metadaten – keine Screenshots/Cookies/Header/DOM, Netzwerk-URLs nur Lab-Domains, bereinigt.
function assertSafeBrowserRecord(o) {
  const raw = JSON.stringify({ b: o.browser_baseline, v: o.browser_validation, g: o.browser_gate, r: o.retest });
  for (const bad of [/screenshot|(desktop|mobile)-[0-9a-f]{8}\.png/i,/cookie|set-cookie|authorization|bearer/i, /<html|<main|<body/i, /\/tmp\/|AppData|jarvis-shot|jarvis-chromium/i]) assert.ok(!bad.test(raw), `${bad} im Auftrag`);
  for (const m of raw.matchAll(/"url":"([^"]+)"/g)) assert.ok(Object.values(DOMAINS).includes(new URL(m[1]).hostname), m[1]);
  assertNoSecrets("Browser-Daten", raw);
}

if (!ENABLED) {
  baseTest("Browser Validation Lab (Docker + Chromium) – nur über «npm run test:browser-integration»", { skip: "JARVIS_REPAIR_LAB=1 nicht gesetzt (eigene Docker-Suite)" }, () => {});
} else {
  before(async () => {
    assert.ok(await dockerAvailable(), "Docker nicht verfügbar – das TF-045-Release-Gate verlangt die echte Integration.");
    tempBefore = browserTemp();
    await cleanupAll();
    lab = await startLab({ log: (m) => console.log(`# ${m}`) });
    browser = await labBrowserValidator(lab, { screenshots: true }); // Screenshots nur temporär – nach jedem Lauf gelöscht (geprüft)
  }, { timeout: 900_000 });

  after(async () => {
    if (lab) await lab.stop();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    const left = await labResources();
    console.log(`# Lab-Cleanup: ${JSON.stringify(left)} · Browser-Temp: ${browserTemp() - tempBefore}`);
    assert.deepEqual(left, { containers: 0, volumes: 0, networks: 0 }, "Lab vollständig entfernt");
    assert.equal(browserTemp(), tempBefore, "keine Browser-Profile/Screenshots übrig");
  }, { timeout: 300_000 });

  // ===================================================================================================================
  // SFTP-Lab (statische Seite): Link + Bild + CSS
  // ===================================================================================================================
  test("SFTP LAB: Browser VORHER zeigt kaputten Link, kaputtes Bild, Mobile-Overflow → 3 echte SFTP-Fixes → Browser NACHHER Desktop+Mobile PASS → Rollback → Browser = Ausgangszustand", async () => {
    await resetSite(lab, { fixture: FX });
    const a = sftpAdapter({ dir: tmp(), fetchFn: lab.fetch });
    const o = { order_id: "RF480-20261012-b45001", domain: DOMAINS.site, website: SITE(), customer_authorized_repair: true, authorization: { authorized_domain: DOMAINS.site, source: "customer_order_form" } };
    const c = { host: lab.ssh.host, port: lab.ssh.port, username: "labuser", password: lab.secrets.labuser_password, remote_root: ROOT, host_key_sha256: lab.hostKeys.rsa, host_key_algorithm: "rsa-sha2-512" };
    const findings = [{ type: "broken_link", broken_path: "/team-alt.html", expected_path: "/team.html" }, { type: "broken_image", broken_path: "/assets/lab-logo.svg", expected_path: "/assets/img/lab-logo.svg" },
      { type: "mobile_overflow" }];
    const base = await browser.validate({ url: SITE(), expected_domain: DOMAINS.site, findings, phase: "baseline" });
    assert.deepEqual(base.desktop.findings.map((f) => f.present), [true, true, false], "Desktop: Link + Bild kaputt, kein Overflow");
    assert.deepEqual(base.mobile.findings.map((f) => f.present), [true, true, true], "Smartphone: zusätzlich horizontaler Overflow");
    assert.ok(base.mobile.overflow.px > 500, String(base.mobile.overflow.px));
    assert.ok(base.desktop.network.entries.some((e) => e.url === SITE("/assets/lab-logo.svg") && e.status === 404 && e.same_domain));
    assert.deepEqual([base.screenshots.created > 0, base.screenshots.deleted], [true, true]);
    const snap = { desktop: safeSnapshot(base.desktop), mobile: safeSnapshot(base.mobile) };
    await a.checkAccess(o, c);
    await a.backup(o, c);
    for (const issue of [{ type: "broken_link", url: SITE("/team-alt.html"), page: SITE() }, { type: "broken_image", url: SITE("/assets/lab-logo.svg"), page: SITE() },
      { type: "mobile_overflow", page: SITE(), css_fix: { file: "css/site.css", from: ".hero { width: 1400px; }", to: ".hero { max-width: 100%; }" } }]) {
      const loc = await a.locate(issue, o, c);
      assert.ok(loc, issue.type);
      assert.equal((await a.applyFix(issue, loc, o, c)).ok, true);
      assert.equal((await a.validate({ ...issue, location: loc }, o, c)).build_ok, true);
    }
    const res = await browser.validate({ url: SITE(), expected_domain: DOMAINS.site, findings, phase: "after", before_snapshot: snap });
    assert.equal(res.decision.verdict, "PASS", JSON.stringify(res.decision));
    assert.deepEqual([res.decision.level, res.decision.desktop_ok, res.decision.mobile_ok], ["NONE", true, true]);
    for (const vp of ["desktop", "mobile"]) {
      assert.ok(res[vp].findings.every((f) => f.ok === true), `${vp}: ${JSON.stringify(res[vp].findings)}`);
      assert.deepEqual([res[vp].overflow.horizontal, res[vp].images.broken, res[vp].console.page_errors, res[vp].network.failed_same_site], [false, 0, 0, 0], vp);
      assert.ok(res[vp].interactions.includes("click_repaired_link") && res[vp].interactions.every((i) => SAFE_INTERACTIONS.includes(i)));
      assert.ok(res[vp].nav.targets_checked >= 2 && res[vp].nav.targets_failed === 0);
    }
    assert.equal(res.mobile.nav.menu_toggle_used, true, "Smartphone-Navigation über den Menü-Button geprüft");
    // Rollback über echtes SFTP → Browser neu gestartet, gleiche URL → Ausgangszustand bestätigt.
    assert.equal((await a.rollback(o, null, c)).ok, true);
    assert.equal(await siteFile(lab, "index.html"), fixture("index.html"));
    const rb = await browser.validate({ url: SITE(), expected_domain: DOMAINS.site, findings, phase: "rollback" });
    assert.equal(rollbackMatchesBaseline(snap, rb), true);
    assert.ok(!rb.desktop.interactions.includes("click_repaired_link"));
  });

  test("FULL SFTP ORDER + BROWSER GATE: Baseline vor dem Write → Fix → Validation → HTTP-Retest → Desktop+Mobile Browser → READY → COMPLETED", async () => {
    await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
    const dir = tmp(), store = createStore(dir);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "sftp", payload: sftpPayload() });
    const { engine, gmail, logs } = await engineFor(dir, store);
    await engine.processAll();
    let o = readOrder(store, id);
    assert.equal(o.state, "READY_FOR_DELIVERY", `${o.blocked_reason} ${JSON.stringify(o.browser_validation?.codes)}`);
    assert.ok(Date.parse(o.browser_baseline.created_at) <= Date.parse(o.state_history.find((h) => h.to === "REPAIRING").at), "Baseline vor REPAIRING");
    assert.deepEqual(o.browser_baseline.pages["/"].desktop.findings.map((f) => f.present), [true, true], "VORHER im Browser: Link + Bild kaputt");
    assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.navigation, o.browser_gate.regression], ["JA", "JA", "JA", "KEINE"]);
    assert.deepEqual([o.validation.build_ok, o.retest.http_ok, o.retest.browser], [true, true, true]);
    assert.deepEqual(completionGate(o), { ok: true, missing: [] });
    for (const line of ["Desktop geprüft: Ja", "Mobile geprüft: Ja", "Navigation geprüft: Ja", "Keine neuen relevanten Darstellungsfehler gefunden."]) assert.ok(o.report.body.includes(line), line);
    assert.ok(!/console|screenshot|public_html|127\.0\.0\.1|https?:\/\//i.test(o.report.body), "Bericht ohne Debugdaten/URLs/Pfade");
    assertSafeBrowserRecord(o);
    const pub = publicRepairOrders(dir).orders.find((x) => x.order_id === id);
    assert.deepEqual([pub.browser_desktop, pub.browser_mobile, pub.browser_regression], ["JA", "JA", "KEINE"]);
    const cloud = cleanRepair(publicRepairOrders(dir));
    assert.equal(cloud.orders[0].browser_desktop, "JA");
    assert.ok(!/https?:\/\/|\.png|entries|fingerprint/.test(JSON.stringify(cloud)), "Cloud-Snapshot ohne URLs/Screenshots/Logs");
    completeOrder(store, id);
    o = readOrder(store, id);
    assert.equal(o.state, "COMPLETED");
    assert.equal(fs.existsSync(path.join(dir, ACCESS_VAULT_DIR, `${id}.json`)), false);
    assert.equal(gmail.calls.filter((x) => x.op === "SEND").length, 0, "keine echte Mail");
    for (const [f, text] of filesOf(dir)) assertNoSecrets(f, text);
    assertNoSecrets("Logs", logs.join("\n"));
  });

  test("SSH/SFTP LAB: Repair per SFTP + Health per SSH (allowlisted) + Browser – alle drei Gates bestanden → READY → COMPLETED", async () => {
    await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
    const dir = tmp(), store = createStore(dir);
    setAccessProfile(store, DOMAINS.site, { interface: "ssh", remote_root: ROOT,
      checks: { build: { php_lint: { binary: "php", args: ["-l", "lab-check.php"] } }, health: { php_health: { binary: "php", args: ["-l", "lab-check.php"] } } } });
    const mark = (await sshdLog(lab)).length;
    const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "ssh",
      payload: { host: `ssh://${lab.ssh.host}:${lab.ssh.port}`, username: "labuser", secret: lab.privateKey, passphrase: lab.secrets.key_passphrase, ssh_host_key_sha256: lab.hostKeys.ed25519 } });
    const { engine } = await engineFor(dir, store);
    await engine.processAll();
    let o = readOrder(store, id);
    assert.equal(o.state, "READY_FOR_DELIVERY", `${o.blocked_reason} ${JSON.stringify(o.browser_validation?.codes)}`);
    assert.equal(o.route.adapter, "ssh");
    assert.equal(o.validation.build_ok, true, "SFTP-Validierung");
    assert.equal(o.deployment.deploy_ref, "live:ssh+sftp", "SSH-Health-Check");
    assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.regression], ["JA", "JA", "KEINE"], "Browser-Gate");
    const log = (await sshdLog(lab)).slice(mark);
    assert.ok((log.match(/Starting session: command for labuser/g) || []).length >= 2 && !/Starting session: shell/.test(log));
    completeOrder(store, id);
    o = readOrder(store, id);
    assert.equal(o.state, "COMPLETED");
  });

  // ===================================================================================================================
  // Absichtliche Regressionen: technische Prüfung ok, Browser-Gate erkennt → Rollback → Browser-Retest → REPAIR_FAILED
  // ===================================================================================================================
  const REGRESSIONS = [
    ["Mobile-Overflow", "massive_overflow", { inject: () => writeSiteFile(lab, "css/site.css", CLEAN_CSS().replace(".hero { max-width: 100%; }", ".hero { width: 900px; }")), restore: () => writeSiteFile(lab, "css/site.css", CLEAN_CSS()) }],
    ["JS Runtime Error", "new_js_error", { inject: () => writeSiteFile(lab, "js/site.js", "window.labConfig.menu.open();\n"), restore: () => writeSiteFile(lab, "js/site.js", fixture("js/site.js.fixture")) }],
    ["Bild neu kaputt", "image_broken", { inject: () => removeSiteFile(lab, "assets/img/brand.svg"), restore: () => writeSiteFile(lab, "assets/img/brand.svg", fixture("assets/img/brand.svg")) }], // Header-Logo: ausserhalb <main>, vom HTTP-Audit nicht erfasst
  ];
  for (const [label, code, hooks] of REGRESSIONS) {
    test(`INTENTIONAL REGRESSION (${label}): Link behoben, Datei-/HTTP-Prüfung ok, Browser-Gate erkennt ${code} → Rollback → Browser bestätigt Ausgangszustand → REPAIR_FAILED`, async () => {
      await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
      const dir = tmp(), store = createStore(dir);
      const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "sftp", payload: sftpPayload() });
      const { engine } = await engineFor(dir, store, { wrap: { sftp: hooks } });
      await engine.processAll();
      const o = readOrder(store, id);
      assert.equal(o.state, "REPAIR_FAILED", `${o.blocked_reason} ${JSON.stringify(o.browser_validation?.codes)}`);
      assert.ok(pathOf(o).includes("RETEST"), "technische Validierung bestanden – erst der Browser stoppt");
      assert.equal(o.validation.build_ok, true);
      assert.ok(o.browser_validation.codes.some((c) => c.endsWith(`:${code}`)), o.browser_validation.codes.join());
      assert.deepEqual([o.regression.browser, o.regression.rolled_back, o.regression.browser_rollback_verified], [true, true, true]);
      assert.equal(o.browser_gate.regression, "ROLLBACK");
      assert.equal(await siteFile(lab, "index.html"), fixture("index.html"), "Original wiederhergestellt");
      assert.equal(publicRepairOrders(dir).orders.find((x) => x.order_id === id).browser_regression, "ROLLBACK");
      assert.throws(() => completeOrder(store, id));
      assertSafeBrowserRecord(o);
    });
  }

  test("Rollback unvollständig (Nebenwirkung bleibt) → Browser-Retest bestätigt Ausgangszustand NICHT → MANUAL_REVIEW_REQUIRED + Chris informiert", async () => {
    await resetSite(lab, { fixture: FX, files: { "css/site.css": CLEAN_CSS() } });
    const dir = tmp(), store = createStore(dir);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "sftp", payload: sftpPayload() });
    const alerts = [];
    const { engine } = await engineFor(dir, store, { alerts, wrap: { sftp: { inject: () => writeSiteFile(lab, "css/site.css", CLEAN_CSS().replace(".hero { max-width: 100%; }", ".hero { width: 900px; }")) } } });
    await engine.processAll();
    const o = readOrder(store, id);
    assert.equal(o.state, "MANUAL_REVIEW_REQUIRED", o.blocked_reason);
    assert.deepEqual([o.regression.rolled_back, o.regression.browser_rollback_verified], [true, false]);
    assert.ok(alerts.includes("rollback_unverified"));
  });

  // ===================================================================================================================
  // Redirects (echter Caddy): same-domain zulässig, fremde Domain → FAIL
  // ===================================================================================================================
  test("REDIRECT (echtes HTTPS): same-domain 301 zulässig; 302 auf fremde Domain → cross_domain_redirect FAIL; Seite selbst auf fremder Domain → stoppt", async () => {
    await resetSite(lab, { fixture: FX });
    const url = SITE("/weiterleitung.html");
    const ok = await browser.validate({ url, expected_domain: DOMAINS.site, findings: [{ type: "broken_link", expected_path: "/umzug.html" }], phase: "after", before_snapshot: { desktop: null, mobile: null } });
    assert.deepEqual([ok.desktop.findings[0].ok, ok.desktop.findings[0].checks.target_same_domain], [true, true], JSON.stringify(ok.desktop.findings[0]));
    const bad = await browser.validate({ url, expected_domain: DOMAINS.site, findings: [{ type: "broken_link", expected_path: "/weg.html" }], phase: "after", before_snapshot: { desktop: null, mobile: null } });
    assert.deepEqual([bad.desktop.findings[0].ok, bad.desktop.findings[0].code], [false, "cross_domain_redirect"]);
    assert.equal(bad.decision.verdict, "ROLLBACK");
    const away = await browser.validate({ url: `https://${DOMAINS.redirect}/`, expected_domain: DOMAINS.redirect, findings: [], phase: "after", before_snapshot: { desktop: null, mobile: null } });
    assert.deepEqual([away.desktop.redirected_cross_domain, away.desktop.interactions], [true, ["open_page"]]);
  });

  // ===================================================================================================================
  // WordPress-Lab (echtes WordPress hinter Caddy)
  // ===================================================================================================================
  test("WORDPRESS LAB + BROWSER GATE: VORHER kaputter Link/Bild im Browser → REST-Fix → Desktop+Mobile Browser PASS → READY → COMPLETED", async () => {
    await resetWp(lab);
    const guard = await wpGuardSnapshot(lab);
    const dir = tmp(), store = createStore(dir);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.wp, access_type: "wordpress_cms", payload: wpPayload() });
    const { engine } = await engineFor(dir, store);
    await engine.processAll();
    let o = readOrder(store, id);
    assert.equal(o.state, "READY_FOR_DELIVERY", `${o.blocked_reason} ${JSON.stringify(o.browser_validation)}`);
    assert.deepEqual(Object.keys(o.browser_baseline.pages).sort(), ["/", "/lab-news/"]);
    assert.equal(o.browser_baseline.pages["/"].desktop.findings[0].present, true, "VORHER: kaputter Link sichtbar");
    assert.equal(o.browser_baseline.pages["/lab-news/"].desktop.findings[0].present, true, "VORHER: kaputtes Bild");
    assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.regression], ["JA", "JA", "KEINE"]);
    assert.equal(await wpContent(lab, lab.wp.start), WP_BROKEN.start.replace("/team-alt/", "/team/"));
    assertSafeBrowserRecord(o);
    completeOrder(store, id);
    o = readOrder(store, id);
    assert.equal(o.state, "COMPLETED");
    assert.equal(await wpGuardSnapshot(lab), guard, "kein Plugin/Theme/User/Setting geändert");
  });

  test("WORDPRESS LAB REGRESSION: Fix korrekt, Nebenwirkung erzeugt Mobile-Overflow → Browser-Gate → REST-Rollback → Browser = Ausgangszustand → REPAIR_FAILED", async () => {
    await resetWp(lab);
    const mu = "/var/www/html/wp-content/mu-plugins/jarvis-lab-regression.php";
    const inject = () => docker(["exec", "-i", lab.names.wp, "sh", "-c", `mkdir -p /var/www/html/wp-content/mu-plugins && cat > ${mu} && chown -R 33:33 /var/www/html/wp-content/mu-plugins`],
      { input: "<?php // Lab-Testdoppel (TF-045): absichtliche Darstellungs-Regression\nadd_action('wp_head', function () { echo '<style>body{min-width:1100px}</style>'; });\n" });
    const restore = () => docker(["exec", lab.names.wp, "rm", "-f", mu]);
    const dir = tmp(), store = createStore(dir);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.wp, access_type: "wordpress_cms", payload: wpPayload() });
    try {
      const { engine } = await engineFor(dir, store, { wrap: { wordpress: { inject, restore } } });
      await engine.processAll();
      const o = readOrder(store, id);
      assert.equal(o.state, "REPAIR_FAILED", `${o.blocked_reason} ${JSON.stringify(o.browser_validation?.codes)}`);
      assert.ok(o.browser_validation.codes.some((c) => /overflow/.test(c)), o.browser_validation.codes.join());
      assert.deepEqual([o.regression.rolled_back, o.regression.browser_rollback_verified], [true, true]);
      assert.equal(await wpContent(lab, lab.wp.start), WP_BROKEN.start, "WordPress-Inhalt im Original");
    } finally { await restore(); }
  });
}
