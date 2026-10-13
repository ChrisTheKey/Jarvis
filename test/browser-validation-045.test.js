// BROWSER REPAIR VALIDATION & VISUAL REGRESSION GATE (TF-045): Bereinigung, Klick-Allowlist, Regression-Levels, Engine-Gate
// (Baseline → Retest → Rollback → Browser-Retest), Abschluss-Gate, Kundenbericht, Dashboard-Allowlist – plus echte Chromium-Läufe
// gegen eine hermetische In-Memory-Testseite (Transport, kein Netzwerk, keine echte Website, keine Mail, keine Zahlung).
import { test, after } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, completeOrder, completionGate, publicRepairOrders, buildCustomerReport,
  PUBLIC_REPAIR_FIELDS, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { sanitizeUrl, isSafeClickTarget, classifyConsoleSource, compareViewport, gateDecision, combineDecisions, rollbackMatchesBaseline,
  createBrowserValidator, chromiumLauncher, chromiumExecutable, safeSnapshot, browserRuntimeStatus, REGRESSION_LEVELS, SAFE_INTERACTIONS } from "../repair-browser-validator.js";
import { cleanRepair } from "../server-control.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-12T08:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-brw45-"));
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];

// ---------- Viewport-Ergebnis (Form wie runViewport) ----------
function vp({ load_ok = true, px = 0, pageErrors = 0, kinds = [], brokenImgs = 0, nav = 3, navFailed = 0, sameSite = 0, thirdParty = 0, height = 1000, findingsOk = null,
  present = null, entries = [], header = true, footer = true, cross = false, mainCovered = false } = {}) {
  return { load_ok, status: load_ok ? 200 : 500, final_same_domain: !cross, redirected_cross_domain: cross, metrics: { scroll_width: 390 + px, viewport_width: 390, doc_height: height, text_length: 400 },
    overflow: { horizontal: px > 2, px, offscreen_elements: px > 8 ? 2 : 0, images_over_viewport: 0, clipped_text: 0 },
    critical: { header, nav: nav > 0, main: true, footer, hero: true, cta: false, main_covered: mainCovered, body_visible: true },
    nav: { links_visible: nav, menu_toggle: true, menu_toggle_used: true, targets_checked: 3, targets_ok: 3 - navFailed, targets_failed: navFailed },
    images: { visible: 3, broken: brokenImgs, broken_paths: [] }, console: { page_errors: pageErrors, page_error_kinds: kinds, errors_same_site: sameSite, errors_third_party: thirdParty, errors_ignored: 0 },
    network: { failed_same_site: entries.filter((e) => e.same_domain).length, failed_cross_site: 0, entries }, fingerprints: { header: "a", nav: "b", main: "c", footer: "d" },
    findings: findingsOk == null ? [] : [{ type: "broken_link", ok: findingsOk, present, code: findingsOk ? null : "finding_unresolved" }] };
}
const page = (before, after) => ({ before: { desktop: before.desktop ?? before, mobile: before.mobile ?? before }, desktop: after.desktop ?? after, mobile: after.mobile ?? after });

// =====================================================================================================================
// Bereinigung, Klick-Allowlist, Console-Filter
// =====================================================================================================================
test("Request-Sanitization: token/key/secret/password/auth/code/session-Werte entfernt, Userinfo + Fragment weg, harmlose Parameter bleiben", () => {
  const u = sanitizeUrl("https://user:pw@muster.ch/a/b.js?token=abc&api_key=k1&client_secret=s&password=p&auth=x&code=123&session=s1&sid=9&page=2#frag");
  for (const v of ["abc", "k1", "=s&", "=p&", "=x&", "=123", "s1", "user", "pw@", "#frag"]) assert.ok(!u.includes(v), `${v} in ${u}`);
  assert.match(u, /page=2/);
  assert.match(u, /token=REDACTED/);
  assert.equal(sanitizeUrl("https://muster.ch/x?v=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xyz"), "https://muster.ch/x?v=REDACTED", "opake Langwerte (JWT o. ä.) auch ohne sensiblen Namen");
  assert.equal(sanitizeUrl("data:image/png;base64,AAAA"), "data:");
  assert.equal(sanitizeUrl("kein url"), null);
});

test("Kein generisches Klicken: nur Menü-Button + reparierter Link; nie Formular/Login/Checkout/Newsletter/Cookie/Delete/Upload/Zahlung/Admin", () => {
  assert.equal(isSafeClickTarget({ tag: "button", type: "button", menu_toggle: true, text: "Menü" }), true);
  assert.equal(isSafeClickTarget({ tag: "a", href_path: "/team.html", protocol: "https:", text: "Unser Team" }), true);
  const bad = [
    { tag: "button", type: "submit", menu_toggle: true, text: "Menü" }, { tag: "button", type: "button", menu_toggle: false, text: "Mehr" },
    { tag: "a", href_path: "/team.html", protocol: "https:", in_form: true }, { tag: "a", href_path: "/login", protocol: "https:" }, { tag: "a", href_path: "/checkout", protocol: "https:" },
    { tag: "a", href_path: "/warenkorb", protocol: "https:" }, { tag: "a", href_path: "/newsletter", protocol: "https:" }, { tag: "button", type: "button", menu_toggle: true, text: "Cookies akzeptieren" },
    { tag: "a", href_path: "/konto/loeschen", protocol: "https:", text: "Konto löschen" }, { tag: "a", href_path: "/upload", protocol: "https:" }, { tag: "a", href_path: "/zahlung", protocol: "https:" },
    { tag: "a", href_path: "/wp-admin/", protocol: "https:" }, { tag: "a", href_path: "/x", protocol: "javascript:" }, { tag: "a", href_path: "/datei.pdf", protocol: "https:", download: true },
    { tag: "input", type: "submit" }, { tag: "a", href_path: "/kontakt", protocol: "https:", text: "Nachricht senden" }, null,
  ];
  for (const d of bad) assert.equal(isSafeClickTarget(d), false, JSON.stringify(d));
  assert.deepEqual([...SAFE_INTERACTIONS], ["open_page", "open_navigation", "check_navigation_target", "click_repaired_link", "verify_image", "verify_target_url", "measure_overflow"]);
});

test("Console-Filter konservativ: eigene Website nie ignoriert, nur bekannte Tracking-Hosts + favicon, unbekannte Dritte bleiben sichtbar", () => {
  assert.equal(classifyConsoleSource("https://muster.ch/app.js", "muster.ch"), "same_site");
  assert.equal(classifyConsoleSource("https://cdn.muster.ch/app.js", "muster.ch"), "same_site");
  assert.equal(classifyConsoleSource("", "muster.ch"), "same_site", "Inline-Fehler zählt zur Website");
  assert.equal(classifyConsoleSource("https://www.googletagmanager.com/gtm.js", "muster.ch"), "ignored");
  assert.equal(classifyConsoleSource("https://muster.ch/favicon.ico", "muster.ch"), "ignored");
  assert.equal(classifyConsoleSource("https://widgets.unbekannt.example/x.js", "muster.ch"), "third_party");
});

// =====================================================================================================================
// Regression-Levels (VORHER/NACHHER)
// =====================================================================================================================
test("Regression-Levels: NONE/LOW/MEDIUM/HIGH – Overflow, JS-Crash, Bilder, Navigation, Console, Requests, Redirect, Befund", () => {
  assert.deepEqual([...REGRESSION_LEVELS], ["NONE", "LOW", "MEDIUM", "HIGH"]);
  const L = (b, a) => compareViewport(vp(b), vp(a)).level;
  assert.equal(L({}, {}), "NONE");
  assert.equal(L({}, { px: 510 }), "HIGH", "massiver Overflow");
  assert.equal(L({}, { px: 20 }), "MEDIUM", "sichtbarer neuer Layoutfehler");
  assert.equal(L({ px: 600 }, { px: 600 }), "NONE", "bestehender Overflow ist keine Regression");
  assert.equal(L({}, { pageErrors: 1, kinds: ["TypeError"] }), "HIGH", "neuer JS-Crash");
  assert.equal(L({}, { brokenImgs: 1 }), "MEDIUM");
  assert.equal(L({}, { brokenImgs: 2 }), "HIGH", "mehrere zentrale Bilder kaputt");
  assert.equal(L({}, { nav: 0 }), "HIGH", "Navigation kaputt");
  assert.equal(L({}, { navFailed: 1 }), "MEDIUM", "Navigation teilweise kaputt");
  assert.equal(L({}, { sameSite: 1 }), "MEDIUM", "neuer same-site Console-Fehler");
  assert.equal(L({}, { thirdParty: 1 }), "LOW", "Drittanbieter-Fehler nur LOW");
  assert.equal(L({}, { entries: [{ url: "https://muster.ch/style.css", status: 404, resource_type: "stylesheet", same_domain: true }] }), "MEDIUM", "neuer same-site 4xx");
  assert.equal(L({}, { load_ok: false }), "HIGH", "Seite lädt nicht");
  assert.equal(L({}, { cross: true }), "HIGH", "Weiterleitung auf fremde Domain");
  assert.equal(L({}, { footer: false }), "MEDIUM");
  assert.equal(L({}, { mainCovered: true }), "MEDIUM", "überdeckter Hauptinhalt");
  assert.equal(L({}, { findingsOk: false, present: true }), "HIGH", "reparierter Befund weiterhin da");
  // Massive Layout-Verschiebung ohne erklärenden Fehler → nicht eindeutig → MANUAL_REVIEW (kein blindes Pixel-Gate).
  const d = gateDecision(page(vp({ height: 1000 }), vp({ height: 2200 })));
  assert.deepEqual([d.verdict, d.unclear], ["MANUAL_REVIEW", true]);
  assert.equal(gateDecision(page(vp({}), vp({ thirdParty: 1 }))).verdict, "PASS", "akzeptables LOW");
  assert.equal(gateDecision(page(vp({}), { desktop: vp({}), mobile: vp({ px: 400 }) })).mobile_ok, false);
  assert.equal(combineDecisions([]).verdict, "MANUAL_REVIEW", "nichts geprüft = nie PASS");
});

test("Rollback-Bestätigung: nur wenn Browser-Zustand = Baseline (inkl. Befund wieder wie vorher)", () => {
  const base = { desktop: safeSnapshot(vp({ findingsOk: false, present: true })), mobile: safeSnapshot(vp({ px: 0, findingsOk: false, present: true })) };
  assert.equal(rollbackMatchesBaseline(base, { desktop: vp({ findingsOk: false, present: true }), mobile: vp({ findingsOk: false, present: true }) }), true);
  assert.equal(rollbackMatchesBaseline(base, { desktop: vp({ findingsOk: false, present: true }), mobile: vp({ px: 500, findingsOk: false, present: true }) }), false, "Overflow blieb");
  assert.equal(rollbackMatchesBaseline(base, { desktop: vp({ findingsOk: true, present: false }), mobile: vp({ findingsOk: true, present: false }) }), false, "Änderung nicht zurückgerollt");
  assert.equal(rollbackMatchesBaseline(base, { desktop: vp({ load_ok: false }), mobile: vp({}) }), false);
});

// =====================================================================================================================
// Engine-Gate (Attrappen-Website + Attrappen-Browser, echte Entscheidungslogik)
// =====================================================================================================================
function world({ regress = null, rollbackRestores = true, unclear = false, browserDown = false, mobileOnlyFail = false } = {}) {
  const st = { fixed: false, regressed: false, writes: 0, rollbacks: 0, browserRuns: [] };
  const adapter = {
    direct_live: true,
    checkAccess: async () => ({ ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] }),
    backup: async () => ({ production_ref: "p1", backup_ref: "b1", rollback_point: "r1" }),
    locate: async () => ({ target: "index.html", cause: "Link auf /team-alt (404); /team.html existiert", planned_change: "href ersetzen", risk: "niedrig", fix: { replacement: "/team.html" } }),
    applyFix: async () => { st.writes++; st.fixed = true; if (regress) st.regressed = true; return { ok: true, change_ref: "lab:1" }; },
    validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }),
    rollback: async () => { st.rollbacks++; st.fixed = false; if (rollbackRestores) st.regressed = false; return { ok: true }; },
  };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Muster", requests: 3, pages: { home: "<html><body>Muster</body></html>" },
    issues: st.fixed ? [] : [{ type: "broken_link", url: "https://muster.ch/team-alt", page: "https://muster.ch/", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true }] }) };
  const view = (vpName, phase) => {
    const findings = phase === "baseline" || !st.fixed ? { findingsOk: false, present: true } : { findingsOk: true, present: false };
    const bad = st.regressed ? { overflow: { px: 510 }, js: { pageErrors: 1, kinds: ["TypeError"] }, image: { brokenImgs: 1, entries: [{ url: "https://muster.ch/hero.svg", status: 404, resource_type: "image", same_domain: true }] } }[regress] : {};
    const extra = vpName === "mobile" && mobileOnlyFail && st.fixed ? { px: 30 } : {};
    return vp({ ...findings, ...(vpName === "mobile" || regress !== "overflow" ? bad : {}), ...extra, ...(unclear && st.fixed ? { height: 2500 } : {}) });
  };
  const browserValidator = { validate: async ({ url, phase, before_snapshot, findings }) => {
    if (browserDown) throw new Error("chromium missing");
    st.browserRuns.push({ url, phase, findings: findings.length });
    const out = { url, phase, desktop: view("desktop", phase), mobile: view("mobile", phase) };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  return { st, adapter, auditor, browserValidator };
}
function setup() {
  const dir = tmp(), store = createStore(dir);
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_reply_email", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: "Test-Ledger", now: T0 });
  return { dir, store, id: o.order_id };
}
const engineOf = (store, w, over = {}) => createRepairEngine({ store, adapters: { static: w.adapter }, auditor: w.auditor, browserValidator: w.browserValidator, requireBrowser: true, now: () => T0, ...over });

test("Desktop + Mobile Erfolg: Baseline VOR der Änderung → Fix → Browser-Retest PASS → READY → COMPLETED; Bericht + Dashboard nur sichere Wörter", async () => {
  const { dir, store, id } = setup();
  const w = world();
  await engineOf(store, w).processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.deepEqual(w.st.browserRuns.map((r) => r.phase), ["baseline", "after"], "Baseline vor dem Write, Retest danach");
  assert.ok(o.state_history.findIndex((h) => h.to === "REPAIRING") > 0 && o.browser_baseline.created_at, "Baseline existiert vor REPAIRING");
  assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile, o.browser_gate.navigation, o.browser_gate.regression, o.browser_gate.level], ["JA", "JA", "JA", "KEINE", "NONE"]);
  assert.equal(o.retest.http_ok, true);
  assert.deepEqual(completionGate(o), { ok: true, missing: [] });
  for (const line of ["Desktop geprüft: Ja", "Mobile geprüft: Ja", "Navigation geprüft: Ja", "Keine neuen relevanten Darstellungsfehler gefunden."]) assert.ok(o.report.body.includes(line), line);
  for (const bad of [/console/i, /screenshot/i, /request/i, /\/home\/|\/var\/|public_html/, /https?:\/\/muster\.ch\/team/, /pageerror|TypeError|HIGH|MEDIUM/]) assert.ok(!bad.test(o.report.body), `Bericht enthält ${bad}`);
  const pub = publicRepairOrders(dir).orders[0];
  assert.deepEqual([pub.browser_desktop, pub.browser_mobile, pub.browser_regression], ["JA", "JA", "KEINE"]);
  assert.ok(PUBLIC_REPAIR_FIELDS.includes("browser_desktop") && PUBLIC_REPAIR_FIELDS.includes("browser_regression"));
  assert.deepEqual(Object.keys(pub).sort(), [...PUBLIC_REPAIR_FIELDS].sort(), "Allowlist exakt");
  assert.ok(!/browser_baseline|browser_validation|entries|fingerprint/.test(JSON.stringify(pub)));
  completeOrder(store, id, { now: T0 });
  assert.equal(readOrder(store, id).state, "COMPLETED");
});

for (const [kind, code] of [["overflow", "massive_overflow"], ["js", "new_js_error"], ["image", "image_broken"]]) {
  test(`Browser-Regression (${kind}): Befund behoben, technische Validierung ok, Browser-Gate → Rollback → Browser-Retest = Ausgangszustand → REPAIR_FAILED`, async () => {
    const { dir, store, id } = setup();
    const w = world({ regress: kind });
    await engineOf(store, w).processAll();
    const o = readOrder(store, id);
    assert.equal(o.state, "REPAIR_FAILED", o.blocked_reason);
    assert.equal(o.validation.build_ok, true, "technische Prüfung bestand");
    assert.equal(w.st.rollbacks, 1);
    assert.deepEqual(w.st.browserRuns.map((r) => r.phase), ["baseline", "after", "rollback"], "Browser nach dem Rollback erneut gestartet");
    assert.ok(o.browser_validation.codes.some((c) => c.endsWith(code)), o.browser_validation.codes.join());
    assert.deepEqual([o.regression.browser, o.regression.rolled_back, o.regression.browser_rollback_verified], [true, true, true]);
    assert.equal(o.browser_gate.regression, "ROLLBACK");
    assert.equal(publicRepairOrders(dir).orders[0].browser_regression, "ROLLBACK");
    assert.throws(() => completeOrder(store, id), /READY_FOR_DELIVERY/);
  });
}

test("Rollback nicht sauber (Browser bestätigt Ausgangszustand nicht) → MANUAL_REVIEW_REQUIRED + Chris informiert", async () => {
  const { store, id } = setup();
  const alerts = [];
  const w = world({ regress: "overflow", rollbackRestores: false });
  await engineOf(store, w, { alert: async (a) => alerts.push(a.kind) }).processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(o.regression.browser_rollback_verified, false);
  assert.deepEqual(alerts, ["rollback_unverified"]);
});

test("Visuell nicht eindeutig (massive Layout-Verschiebung ohne Fehler) → MANUAL_REVIEW_REQUIRED, kein Abschluss, kein blinder Rollback", async () => {
  const { store, id } = setup();
  const w = world({ unclear: true });
  await engineOf(store, w).processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(w.st.rollbacks, 0);
  assert.ok(o.alerts.some((a) => a.kind === "browser_unclear"));
});

test("Mobile-Gate Pflicht: Desktop ok, Smartphone mit neuem Overflow → kein READY/COMPLETED (Rollback); manipulierter READY-Auftrag ohne Mobile-Gate → completeOrder verweigert", async () => {
  const { store, id } = setup();
  const w = world({ mobileOnlyFail: true });
  await engineOf(store, w).processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "REPAIR_FAILED");
  assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile], ["JA", "NEIN"]);
  // Abschluss-Gate unabhängig von der Engine: READY ohne bestandenes Mobile-Gate darf nie COMPLETED werden.
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(data.orders[id], { state: "READY_FOR_DELIVERY", browser_gate: { ...o.browser_gate, desktop: "JA", mobile: "NEIN", regression: "KEINE" } });
  store.write(REPAIR_ORDERS_FILE, data);
  assert.deepEqual(completionGate(readOrder(store, id)).missing, ["browser_mobile"]);
  assert.throws(() => completeOrder(store, id), /browser_mobile/);
  data.orders[id].browser_gate.mobile = "WARTET";
  store.write(REPAIR_ORDERS_FILE, data);
  assert.throws(() => completeOrder(store, id), /Abschluss-Gate/);
});

test("Browser nicht verfügbar (fail closed): vor der Reparatur → MANUAL_REVIEW, 0 Write; im Retest → MANUAL_REVIEW statt COMPLETED", async () => {
  const a = setup();
  const w1 = world();
  await createRepairEngine({ store: a.store, adapters: { static: w1.adapter }, auditor: w1.auditor, requireBrowser: true, now: () => T0 }).processAll();
  const o1 = readOrder(a.store, a.id);
  assert.equal(o1.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(w1.st.writes, 0, "ohne Browser keine Änderung");
  assert.ok(o1.alerts.some((x) => x.kind === "browser_unavailable"));
  // Browser fällt zwischen Baseline und Retest aus.
  const b = setup();
  const w2 = world();
  const engine = engineOf(b.store, w2);
  let o = readOrder(b.store, b.id);
  for (let i = 0; i < 20 && o.state !== "RETEST"; i++) { await engine.step(o); o = readOrder(b.store, b.id); }
  assert.equal(o.state, "RETEST");
  w2.browserValidator.validate = async () => { throw new Error("chromium crashed"); };
  await engine.processAll();
  o = readOrder(b.store, b.id);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.deepEqual([o.browser_gate.desktop, o.browser_gate.mobile], ["NEIN", "NEIN"]);
});

test("Produktionsweg: runRepairOrders/loadDefaultRepairDeps verlangen den Browser (requireBrowser=true) und laden den echten Validator", () => {
  const src = read("repair-workflow.js");
  assert.match(src, /export async function runRepairOrders\(\{[^}]*requireBrowser = true/);
  assert.match(src, /browserValidator = browserValidator \|\| defaults\.browserValidator/);
  assert.match(src, /loadBrowserValidator\(\)/);
});

// =====================================================================================================================
// Dashboard / Cloud / Image
// =====================================================================================================================
test("Dashboard-Allowlist: Browser Desktop/Mobile JA/NEIN/WARTET, Regression KEINE/GEFUNDEN/ROLLBACK – keine URLs/Screenshots/Logs/Secrets", () => {
  const c = cleanRepair({ total: 1, orders: [{ order_id: "RF480-20261012-abcdef", state: "RETEST", browser_desktop: "JA", browser_mobile: "WARTET", browser_regression: "ROLLBACK",
    screenshot: "/tmp/x.png", console: ["TypeError at https://muster.ch/app.js?token=geheim"], network: [{ url: "https://muster.ch/?session=1" }] }],
    adapter_registry: { status: "ACTIVE", adapters: ["sftp"], browser_validator: "ACTIVE" } });
  assert.deepEqual([c.orders[0].browser_desktop, c.orders[0].browser_mobile, c.orders[0].browser_regression], ["JA", "WARTET", "ROLLBACK"]);
  assert.equal(c.adapter_registry.browser_validator, "ACTIVE");
  assert.ok(!/screenshot|TypeError|token|session|\/tmp/.test(JSON.stringify(c)));
  const bad = cleanRepair({ orders: [{ browser_desktop: "https://muster.ch/", browser_mobile: "ja", browser_regression: "HIGH:new_js_error" }] });
  assert.deepEqual([bad.orders[0].browser_desktop, bad.orders[0].browser_mobile, bad.orders[0].browser_regression], [null, null, null]);
  const html = read("public/index.html");
  assert.ok(html.includes("Browser Desktop ${bw(o.browser_desktop)}") && html.includes("Browser Mobile ${bw(o.browser_mobile)}") && html.includes("Regression ${"));
  assert.ok(html.includes('reg.browser_validator === "ACTIVE"'));
});

test("Production-Image: Chromium reproduzierbar (apk) + playwright-core gepinnt + Validator im Image; Release-Gate 045 ohne Skip", () => {
  // TF-047: Chromium + Browser-Gate laufen nur noch im separaten Repair-Service-Image.
  const docker = read("deploy/vps/Dockerfile.repair"), pkg = JSON.parse(read("package.json"));
  assert.match(docker, /apk add --no-cache chromium/);
  assert.match(docker, /JARVIS_CHROMIUM_PATH=\/usr\/bin\/chromium/);
  assert.ok(docker.match(/^COPY (.+) \.\/$/m)[1].split(/\s+/).includes("repair-browser-validator.js"));
  assert.match(pkg.dependencies["playwright-core"], /^\d+\.\d+\.\d+$/, "exakt gepinnt");
  assert.ok(!pkg.dependencies.playwright && !pkg.devDependencies?.playwright, "kein Browser-Download-Paket");
  assert.match(pkg.scripts["test:release-045"], /npm test/);
  assert.match(pkg.scripts["test:release-045"], /test:repair-integration/);
  assert.match(pkg.scripts["test:release-045"], /test:browser-integration/);
  const compose = read("deploy/vps/docker-compose.yml");
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  const rt = browserRuntimeStatus();
  assert.deepEqual(Object.keys(rt).sort(), ["chromium", "library", "status"]);
});

// =====================================================================================================================
// ECHTER Chromium-Browser gegen eine In-Memory-Testseite (Transport: nur site.test, alles andere blockiert)
// =====================================================================================================================
const CSS = (hero = "max-width: 100%") => `body{margin:0;font-family:sans-serif}.site-header{display:flex;flex-wrap:wrap;justify-content:space-between;padding:12px}.menu-toggle{display:none}main{padding:16px}.hero{${hero}}img{max-width:100%;height:auto}footer{padding:16px}@media (max-width:700px){.menu-toggle{display:inline-block}.site-nav{display:none;width:100%}.site-nav.open{display:block}.site-nav a{display:block}}`;
const HTML = ({ link = "/team.html", img = "/img/logo.svg", extra = "" } = {}) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lab</title><link rel="stylesheet" href="/css/site.css"></head>
<body><header class="site-header"><a href="/">Lab</a><button class="menu-toggle" type="button" aria-controls="site-nav" aria-expanded="false">Menü</button>
<nav id="site-nav" class="site-nav"><a href="/team.html">Team</a> <a href="/kontakt.html">Kontakt</a></nav></header>
<main><section class="hero"><h1>Testseite</h1><p>Nur Testdaten – keine echte Website.</p><img src="/img/hero.svg" alt="Hero" width="300" height="100"></section>
<p><a href="${link}">Unser Team</a></p><p><img src="${img}" alt="Logo" width="40" height="40"></p>${extra}</main><footer><p>Fusszeile</p></footer><script src="/js/site.js"></script></body></html>`;
const JS_OK = "document.querySelector('.menu-toggle').addEventListener('click',function(){document.getElementById('site-nav').classList.toggle('open')});";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>';
// Echter HTTP-Server auf 127.0.0.1; Chromium löst NUR site.test/fremd.test dorthin auf (host-resolver-rules), alles andere ~NOTFOUND.
let server = null, port = 0;
const live = { state: {}, seen: [] };
async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const host = String(req.headers.host || "").split(":")[0], u = new URL(req.url, "http://x");
    live.seen.push({ host, method: req.method, path: u.pathname });
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { "content-type": type, ...extra }); res.end(body); };
    if (host === "fremd.test") return send(200, "text/html", "<html><body><main>Fremde Domain</main></body></html>");
    if (host !== "site.test") return send(421, "text/plain", "falscher Host");
    const st = live.state;
    if (u.pathname === "/" && st.redirectHome) return send(302, "text/plain", "", { location: "http://fremd.test/" });
    const sub = (t) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header><nav><a href="/">Start</a></nav></header><main><h1>${t}</h1><p>Testdaten.</p></main><footer>F</footer></body></html>`;
    const files = { "/": [200, "text/html", HTML(st)], "/css/site.css": [200, "text/css", st.css ?? CSS()], "/js/site.js": [200, "application/javascript", st.js ?? JS_OK],
      "/team.html": [200, "text/html", sub("Team")], "/kontakt.html": [200, "text/html", sub("Kontakt")], "/img/logo.svg": [200, "image/svg+xml", SVG], "/img/hero.svg": st.heroGone ? null : [200, "image/svg+xml", SVG],
      "/umzug.html": [301, "text/plain", "", { location: "/team.html" }], "/weg.html": [302, "text/plain", "", { location: "http://fremd.test/" }] };
    const f = files[u.pathname];
    if (!f) return send(404, "text/plain", "nicht gefunden");
    send(f[0], f[1], f[2], f[3] || {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
}
after(() => server?.close());
const validator = (opts = {}) => createBrowserValidator({ launch: chromiumLauncher({ extraArgs: [`--host-resolver-rules=MAP site.test 127.0.0.1:${port}, MAP fremd.test 127.0.0.1:${port}, MAP * ~NOTFOUND`] }),
  allowHosts: ["site.test", "fremd.test"], ...opts });
const HAS_CHROMIUM = !!chromiumExecutable();
const browserTest = (name, fn) => test(name, { timeout: 300_000 }, async () => {
  assert.ok(HAS_CHROMIUM, "Chromium nicht verfügbar – TF-045 verlangt einen echten Browser (kein Skip).");
  await fn();
});
const FINDINGS = [{ type: "broken_link", broken_path: "/team-alt.html", expected_path: "/team.html" }, { type: "broken_image", broken_path: "/img/alt.svg", expected_path: "/img/logo.svg" }];
async function beforeAfter(beforeState, afterState, { findings = FINDINGS, screenshots = false } = {}) {
  await startServer();
  live.state = { ...beforeState }; live.seen = [];
  const v = validator({ screenshots });
  const base = await v.validate({ url: "http://site.test/", expected_domain: "site.test", findings, phase: "baseline" });
  live.state = { ...afterState };
  const after = await v.validate({ url: "http://site.test/", expected_domain: "site.test", findings, phase: "after", before_snapshot: { desktop: safeSnapshot(base.desktop), mobile: safeSnapshot(base.mobile) } });
  return { base, after, seen: live.seen };
}

browserTest("ECHTER BROWSER: Desktop + Mobile Erfolg – Link + Bild behoben, Navigation (Menü-Button auf dem Smartphone), keine Regression → PASS", async () => {
  const { base, after, seen } = await beforeAfter({ link: "/team-alt.html", img: "/img/alt.svg" }, {}, { screenshots: true });
  assert.equal(base.desktop.images.broken, 1);
  assert.deepEqual(base.desktop.findings.map((f) => f.present), [true, true], "VORHER: kaputter Link + kaputtes Bild sichtbar");
  assert.equal(after.decision.verdict, "PASS", JSON.stringify(after.decision));
  assert.deepEqual([after.decision.level, after.decision.desktop_ok, after.decision.mobile_ok], ["NONE", true, true]);
  for (const vpName of ["desktop", "mobile"]) {
    const r = after[vpName];
    assert.deepEqual([r.load_ok, r.overflow.horizontal, r.images.broken, r.console.page_errors], [true, false, 0, 0], vpName);
    assert.ok(r.findings.every((f) => f.ok === true), JSON.stringify(r.findings));
    assert.equal(r.findings[0].checks.target_same_domain, true);
    assert.ok(r.interactions.includes("click_repaired_link") && r.interactions.every((i) => SAFE_INTERACTIONS.includes(i)), r.interactions.join());
    assert.ok(r.nav.links_visible >= 2 && r.nav.targets_ok >= 2 && r.nav.targets_failed === 0);
  }
  assert.equal(after.mobile.nav.menu_toggle_used, true, "Smartphone: Navigation über den Menü-Button geöffnet");
  assert.equal(after.desktop.nav.menu_toggle_used, false);
  assert.ok(!base.desktop.interactions.includes("click_repaired_link"), "Baseline klickt nie");
  assert.deepEqual([after.screenshots.created > 0, after.screenshots.deleted], [true, true], "Screenshots nur temporär, danach gelöscht");
  assert.ok(seen.every((s) => s.method === "GET" || s.method === "HEAD"));
});

browserTest("ECHTER BROWSER: Mobile-Overflow-Regression erkannt (Desktop sauber) → ROLLBACK", async () => {
  const { after } = await beforeAfter({ link: "/team-alt.html", img: "/img/alt.svg" }, { css: CSS("width: 900px") });
  assert.equal(after.decision.verdict, "ROLLBACK");
  assert.equal(after.decision.mobile_ok, false);
  assert.ok(after.mobile.overflow.px > 400, String(after.mobile.overflow.px));
  assert.ok(after.decision.mobile.items.some((i) => i.code === "massive_overflow" && i.level === "HIGH"));
});

browserTest("ECHTER BROWSER: neuer JS Runtime Error (pageerror) → HIGH → ROLLBACK; Menü-Button danach ohne Funktion", async () => {
  const { after } = await beforeAfter({ link: "/team-alt.html", img: "/img/alt.svg" }, { js: "window.labConfig.menu.open();" });
  assert.equal(after.decision.verdict, "ROLLBACK");
  assert.ok(after.desktop.console.page_errors >= 1 && after.desktop.console.page_error_kinds.includes("TypeError"));
  assert.ok(after.decision.desktop.items.some((i) => i.code === "new_js_error" && i.level === "HIGH"));
  assert.ok(after.decision.mobile.items.some((i) => i.code === "navigation_broken"), "Smartphone-Navigation nicht mehr bedienbar");
});

browserTest("ECHTER BROWSER: Link korrekt, aber wichtiges Bild neu kaputt → FAIL (same-site 4xx, bereinigt) → ROLLBACK", async () => {
  const { after } = await beforeAfter({ link: "/team-alt.html", img: "/img/alt.svg" }, { heroGone: true });
  assert.equal(after.decision.verdict, "ROLLBACK");
  assert.ok(after.decision.desktop.items.some((i) => i.code === "image_broken"), JSON.stringify([after.decision, after.desktop.images, after.desktop.network]));
  assert.ok(after.desktop.network.entries.some((e) => e.url === "http://site.test/img/hero.svg" && e.status === 404 && e.resource_type === "image" && e.same_domain === true));
});

browserTest("ECHTER BROWSER: Redirect – same-domain zulässig, unerwartet auf fremde Domain → FAIL (nur festgestellt, keine weitere Interaktion)", async () => {
  const ok = await beforeAfter({ link: "/team-alt.html" }, { link: "/umzug.html" }, { findings: [{ type: "broken_link", broken_path: "/team-alt.html", expected_path: "/umzug.html" }] });
  assert.equal(ok.after.desktop.findings[0].ok, true, JSON.stringify(ok.after.desktop.findings[0]));
  const bad = await beforeAfter({ link: "/team-alt.html" }, { link: "/weg.html" }, { findings: [{ type: "broken_link", broken_path: "/team-alt.html", expected_path: "/weg.html" }] });
  const f = bad.after.desktop.findings[0];
  assert.deepEqual([f.ok, f.code, f.checks.target_same_domain], [false, "cross_domain_redirect", false]);
  assert.equal(bad.after.decision.verdict, "ROLLBACK");
  assert.ok(bad.after.decision.desktop.items.some((i) => i.code === "unexpected_redirect"));
  assert.ok(bad.seen.filter((s) => s.host === "fremd.test" && s.path !== "/favicon.ico").every((s) => s.method === "GET" && s.path === "/"), JSON.stringify(bad.seen.filter((s) => s.host === "fremd.test")));
});

browserTest("ECHTER BROWSER: Seite leitet selbst auf fremde Domain → redirected_cross_domain, Prüfung stoppt", async () => {
  await startServer();
  live.state = { redirectHome: true }; live.seen = [];
  const r = await validator().validate({ url: "http://site.test/", expected_domain: "site.test", findings: [], phase: "after", before_snapshot: { desktop: null, mobile: null } });
  assert.deepEqual([r.desktop.redirected_cross_domain, r.desktop.error, r.decision.verdict], [true, "cross_domain_redirect", "ROLLBACK"]);
  assert.deepEqual(r.desktop.interactions, ["open_page"], "keine weitere Interaktion auf der fremden Domain");
});

browserTest("ECHTER BROWSER: Formular/POST nie abgesendet – Auto-Submit + fetch(POST) der Seite werden im Browser abgebrochen; fremde Hosts blockiert", async () => {
  await startServer();
  live.state = { extra: '<form id="f" method="post" action="/kontakt.html"><input name="email" value="x@example.test"></form><img src="https://tracker.example/p.gif" alt=""><script>fetch("/api/newsletter",{method:"POST",body:"a=1"}).catch(function(){});setTimeout(function(){document.getElementById("f").submit()},50)</script>' };
  live.seen = [];
  const r = await validator().validate({ url: "http://site.test/", expected_domain: "site.test", findings: [], phase: "baseline" });
  assert.ok(r.desktop.blocked_requests >= 1 && r.mobile.blocked_requests >= 1, JSON.stringify([r.desktop.blocked_requests, r.mobile.blocked_requests]));
  // TF-046: der blockierte Submit darf keine Fehlerseite committen – der Browser bleibt auf der Seite und misst sie (früher: falsches
  // «cross_domain_redirect» bzw. unter Last «Execution context was destroyed»).
  for (const vp of ["desktop", "mobile"]) assert.deepEqual([r[vp].load_ok, r[vp].final_same_domain, r[vp].error ?? null, r[vp].nav.links_visible > 0], [true, true, null, true], vp);
  // Deterministisch: Submit schon WÄHREND des Ladens (vor dem load-Event) – früher goto-Timeout → load_failed.
  live.state = { extra: '<form id="g" method="post" action="/kontakt.html"></form><script>document.getElementById("g").submit()</script>' };
  const early = await validator().validate({ url: "http://site.test/", expected_domain: "site.test", findings: [], phase: "baseline" });
  for (const vp of ["desktop", "mobile"]) assert.deepEqual([early[vp].load_ok, early[vp].final_same_domain, early[vp].error ?? null, early[vp].blocked_requests >= 1], [true, true, null, true], `früh ${vp}`);
  assert.ok(live.seen.every((s) => s.method === "GET" || s.method === "HEAD"));
  assert.ok(r.desktop.blocked_hosts >= 1, "fremder Host nie kontaktiert");
  assert.ok(live.seen.length > 0 && live.seen.every((s) => s.method === "GET" || s.method === "HEAD"), "kein POST hat den Server erreicht");
  assert.ok(!JSON.stringify(r).includes("x@example.test") && !JSON.stringify(r).includes("a=1"), "keine Formular-/POST-Daten im Ergebnis");
});
