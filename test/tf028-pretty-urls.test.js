// TF-JARVIS-028 (K9): Netlify «Pretty URLs» schreibt interne Links beim Ausliefern um (/team.html → /team). Der Browser-Validator
// muss /x.html, /x und /x/ als dieselbe Seite erkennen – für den erwarteten UND den kaputten Link (sonst gilt ein umgeschriebener
// kaputter Link fälschlich als «weg»). Echter Chromium gegen eine hermetische Testseite (nur site.test/fremd.test, kein Netzwerk).
// Dazu: --revalidate-qc – einmalige, eng begrenzte QC-Wiederaufnahme eines E2E-Testauftrags nach genau diesem Fehlalarm.
import { test, after } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, revalidateQcRepairOrder, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { createBrowserValidator, chromiumLauncher, chromiumExecutable, safeSnapshot, pagePathKey, browserProbeScript, SAFE_INTERACTIONS } from "../repair-browser-validator.js";
import { githubNetlifyAdapter, setRepairMapping, GITHUB_TOKEN_ENV, NETLIFY_TOKEN_ENV } from "../repair-adapters/github-netlify.js";
import { recordPayment } from "../payments.js";
import { e2eConfig } from "../e2e-test.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf028p-"));

// ---------- (1) Pfad-Normalisierung (rein) ----------
test("K9 pagePathKey: /x.html ≡ /x ≡ /x/, index.html ≡ Verzeichnis; andere Seiten, Endungen und Gross-/Kleinschreibung bleiben verschieden", () => {
  for (const p of ["/team.html", "/team", "/team/", "/team.htm", "/team//"]) assert.equal(pagePathKey(p), "/team", p);
  for (const p of ["/", "/index.html", "/index.htm", ""]) assert.equal(pagePathKey(p), "/", p);
  assert.equal(pagePathKey("/ueber/index.html"), "/ueber");
  assert.equal(pagePathKey("/a/b.html"), "/a/b");
  for (const [a, b] of [["/team-alt.html", "/team"], ["/teams", "/team.html"], ["/team.php", "/team"], ["/Team.html", "/team"], ["/team.html/x", "/team"], ["/team.json", "/team"]])
    assert.notEqual(pagePathKey(a), pagePathKey(b), `${a} ≠ ${b}`);
});

test("K9 Seitenkontext: browserProbeScript und locateScript nutzen dieselbe Normalisierung wie pagePathKey (serialisiert, daher inline)", () => {
  const src = fs.readFileSync(new URL("../repair-browser-validator.js", import.meta.url), "utf8");
  const inline = String(pagePathKey).match(/replace\(.*$/m)[0];
  assert.ok(String(browserProbeScript).includes(inline), "browserProbeScript");
  assert.equal(src.split(inline).length - 1, 3, "pagePathKey + browserProbeScript + locateScript");
});

// ---------- (2) Echter Browser gegen eine Netlify-artige Testseite ----------
// pretty=true: wie Netlify «Pretty URLs» – jedes href="/x.html" wird als href='/x' ausgeliefert; /x, /x/ und /x.html liefern die Seite.
const page = ({ link, nav = "/team.html", extra = "" }) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lab</title>
<style>body{margin:0;font-family:sans-serif}header{padding:12px}main{padding:16px}footer{padding:16px}</style></head>
<body><header><nav><a href="/">Start</a> · <a href="${nav}">Team</a> · <a href="/kontakt.html">Kontakt</a></nav></header>
<main><h1>Testseite</h1><p><a href="${link}">Unser Team</a></p>${extra}</main><footer><p>Fusszeile</p></footer></body></html>`;
const sub = (t) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><header><nav><a href="/">Start</a></nav></header><main><h1>${t}</h1></main><footer>F</footer></body></html>`;
const prettify = (html) => html.replace(/href="(\/[^"#?]*?)(?:index)?\.html([?#][^"]*)?"/g, (_, p, rest = "") => `href='${p.length > 1 ? p.replace(/\/$/, "") : p}${rest}'`);
const PAGES = { team: "Team", kontakt: "Kontakt" };
let server = null, port = 0;
const live = { state: {}, seen: [] };
async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    const host = String(req.headers.host || "").split(":")[0], u = new URL(req.url, "http://x");
    live.seen.push({ host, method: req.method, path: u.pathname });
    const send = (status, body) => { res.writeHead(status, { "content-type": "text/html" }); res.end(body); };
    if (host === "fremd.test") return send(200, sub("Fremd"));
    if (host !== "site.test") return send(421, "falscher Host");
    const st = live.state;
    if (u.pathname === "/") return send(200, st.pretty === false ? page(st) : prettify(page(st)));
    const m = u.pathname.match(/^\/([a-z-]+)(\.html|\/)?$/);
    const name = m && (st.pretty !== false || m[2] === ".html") ? m[1] : null;
    if (name && PAGES[name] && !(st.missing || []).includes(name)) return send(200, sub(PAGES[name]));
    send(404, "nicht gefunden");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
}
after(() => server?.close());
const validator = () => createBrowserValidator({ launch: chromiumLauncher({ extraArgs: [`--host-resolver-rules=MAP site.test 127.0.0.1:${port}, MAP fremd.test 127.0.0.1:${port}, MAP * ~NOTFOUND`] }),
  allowHosts: ["site.test", "fremd.test"] });
const browserTest = (name, fn) => test(name, { timeout: 300_000 }, async () => {
  assert.ok(chromiumExecutable(), "Chromium nicht verfügbar – K9 verlangt einen echten Browser (kein Skip).");
  await fn();
});
const FINDING = [{ type: "broken_link", broken_path: "/team-alt.html", expected_path: "/team.html" }];
async function beforeAfter(beforeState, afterState, findings = FINDING) {
  await startServer();
  live.state = { ...beforeState }; live.seen = [];
  const v = validator();
  const base = await v.validate({ url: "http://site.test/", expected_domain: "site.test", findings, phase: "baseline" });
  live.state = { ...afterState };
  const res = await v.validate({ url: "http://site.test/", expected_domain: "site.test", findings, phase: "after", before_snapshot: { desktop: safeSnapshot(base.desktop), mobile: safeSnapshot(base.mobile) } });
  return { base, after: res, seen: live.seen };
}

browserTest("K9 ECHTER BROWSER: Pretty URLs – Reparatur /team-alt.html → /team.html (ausgeliefert als /team) → Desktop + Mobile PASS, Link angeklickt", async () => {
  const { base, after: a, seen } = await beforeAfter({ link: "/team-alt.html" }, { link: "/team.html" });
  for (const vp of ["desktop", "mobile"]) assert.equal(base[vp].findings[0].present, true, `VORHER ${vp}: kaputter Link trotz Umschreibung (/team-alt) erkannt`);
  assert.equal(a.decision.verdict, "PASS", JSON.stringify([a.decision, a.desktop.findings, a.mobile.findings]));
  for (const vp of ["desktop", "mobile"]) {
    const f = a[vp].findings[0];
    assert.deepEqual([f.ok, f.present, f.checks.broken_reference_gone, f.checks.link_present, f.checks.target_loads, f.checks.target_same_domain], [true, false, true, true, true, true], `${vp}: ${JSON.stringify(f)}`);
    assert.ok(a[vp].interactions.includes("click_repaired_link") && a[vp].interactions.every((i) => SAFE_INTERACTIONS.includes(i)), a[vp].interactions.join());
  }
  assert.ok(seen.some((s) => s.path === "/team"), "geklickt wurde der ausgelieferte Link (/team)");
  assert.ok(seen.every((s) => s.method === "GET" || s.method === "HEAD"));
});

browserTest("K9 ECHTER BROWSER: Schreibweisen /team/ und /team?x=1#a zählen als vorhandener Link; ohne Pretty URLs (/team.html) unverändert PASS", async () => {
  for (const link of ["/team/", "/team?ref=nav#top", "/team.html?x=1"]) {
    const { after: a } = await beforeAfter({ link: "/team-alt.html" }, { link, nav: "/kontakt.html" });
    assert.equal(a.decision.verdict, "PASS", `${link}: ${JSON.stringify(a.desktop.findings)}`);
    assert.equal(a.desktop.findings[0].checks.link_present, true, link);
  }
  const { after: plain } = await beforeAfter({ link: "/team-alt.html", pretty: false }, { link: "/team.html", pretty: false });
  assert.equal(plain.decision.verdict, "PASS", JSON.stringify(plain.desktop.findings));
});

browserTest("K9 NEGATIV: kaputter Link bleibt (umgeschrieben zu /team-alt), obwohl die Navigation schon /team zeigt → present, ROLLBACK (nie falsches «weg»)", async () => {
  const { after: a } = await beforeAfter({ link: "/team-alt.html" }, { link: "/team-alt.html" });
  for (const vp of ["desktop", "mobile"]) {
    const f = a[vp].findings[0];
    assert.deepEqual([f.ok, f.present, f.checks.broken_reference_gone, f.code], [false, true, false, "finding_unresolved"], `${vp}: ${JSON.stringify(f)}`);
  }
  assert.equal(a.decision.verdict, "ROLLBACK");
});

browserTest("K9 NEGATIV: falsches Ziel (/teams statt /team) → link_present false; Ziel fehlt (404) → target_loads false; nur fremde Domain → nie bestanden", async () => {
  const wrong = await beforeAfter({ link: "/team-alt.html" }, { link: "/teams", nav: "/kontakt.html" });
  assert.deepEqual([wrong.after.desktop.findings[0].checks.link_present, wrong.after.decision.verdict], [false, "ROLLBACK"]);
  const missing = await beforeAfter({ link: "/team-alt.html" }, { link: "/team.html", missing: ["team"] });
  for (const vp of ["desktop", "mobile"]) assert.deepEqual([missing.after[vp].findings[0].ok, missing.after[vp].findings[0].checks.target_loads], [false, false], vp);
  assert.equal(missing.after.decision.verdict, "ROLLBACK");
  const foreign = await beforeAfter({ link: "/team-alt.html" }, { link: "http://fremd.test/team.html", nav: "/kontakt.html" });
  const f = foreign.after.desktop.findings[0];
  assert.deepEqual([f.ok, f.checks.target_same_domain], [false, false], JSON.stringify(f));
  assert.equal(foreign.after.decision.verdict, "ROLLBACK");
});

// ---------- (3) --revalidate-qc ----------
const C1 = "d7b0bfbf68cd0bb1ec3a4a840ab42a5cdda785bf";
const T0 = new Date("2026-10-22T15:00:00Z");
const RETEST_FAIL = "Retest nicht bestanden (Desktop fehlgeschlagen, Smartphone fehlgeschlagen).";
const SANDBOX = "jarvis-sandbox-e2e.netlify.app";
const SANDBOX_ENV = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: SANDBOX, JARVIS_E2E_TEST_MAILBOXES: "test@muster.ch" };
const PREVIEW = `https://6ada115b8e67ea1ecd9bb0aa--${SANDBOX}`;
const QCFAILED = (over = {}) => ({ order_id: "RF480-20261022-f1f061", domain: SANDBOX, website: `https://${SANDBOX}/`, test_order: true, environment: "TEST", test_run_id: "e2e-9b6ef14d983a",
  state: "VALIDATION_FAILED", blocked_reason: RETEST_FAIL, customer_authorized_repair: true, stack: { type: "github_netlify" },
  backup: { production_ref: "2ce721d244d0", backup_ref: "git:2ce721d244d0", rollback_point: "netlify:6ad91363", branch: "repair/RF480-20261022-f1f061", created_at: T0.toISOString() },
  plan: [{ issue_id: "I1", fix: { files: ["index.html"] } }], issues: { I1: { issue_id: "I1", type: "broken_link", repair_status: "repaired", change_ref: `git:${C1}` } },
  validation: { build_ok: true, preview_url: PREVIEW, preview_deploy: "6ada115b8e67ea1ecd9bb0aa", preview_commit: C1, target: PREVIEW, open_issues: 0 },
  regression: { found: [{ type: "HIGH:finding_unresolved" }], browser: true, level: "HIGH" },
  browser_validation: { verdict: "ROLLBACK", level: "HIGH", codes: ["HIGH:finding_unresolved"], pages: {} },
  browser_gate: { required: true, desktop: "NEIN", mobile: "NEIN", navigation: "JA", regression: "GEFUNDEN", level: "HIGH" },
  retest: { desktop: { ok: false }, mobile: { ok: false }, http_ok: true, browser: true, target: PREVIEW },
  deployment: null, revalidations: [{ at: T0.toISOString() }], state_history: [], ...over });
const seed = (order) => { const store = createStore(tmp()); store.write(REPAIR_ORDERS_FILE, { schema: 1, orders: { [order.order_id]: order } }); return store; };
const ARGS = { domain: SANDBOX, reason: "K9 Pretty-URL-Normalisierung im Browser-Validator", env: SANDBOX_ENV, now: T0 };
const ID = "RF480-20261022-f1f061";

test("K9 revalidate-qc: zulässiger Fall → VALIDATION mit bestehendem Commit, Regression/Browser-Gate zurückgesetzt, Backup unverändert, dokumentiert", () => {
  const store = seed(QCFAILED());
  const o = revalidateQcRepairOrder(store, ID, ARGS);
  const saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[ID];
  assert.equal(o.state, "VALIDATION");
  assert.deepEqual([saved.blocked_reason, saved.regression], [null, null]);
  assert.deepEqual([saved.browser_gate.required, saved.browser_gate.desktop, saved.browser_gate.mobile], [true, "WARTET", "WARTET"]);
  assert.deepEqual(saved.backup, QCFAILED().backup, "kein zweites Backup");
  assert.equal(saved.issues.I1.change_ref, `git:${C1}`);
  assert.equal(saved.qc_revalidations.length, 1);
  assert.deepEqual([saved.qc_revalidations[0].from_reason, saved.qc_revalidations[0].preview_commit, saved.qc_revalidations[0].codes], [RETEST_FAIL, C1, ["HIGH:finding_unresolved"]]);
  assert.equal(saved.revalidations.length, 1, "--revalidate bleibt verbraucht");
  assert.deepEqual([saved.state_history.at(-1).from, saved.state_history.at(-1).to], ["VALIDATION_FAILED", "VALIDATION"]);
});

test("K9 revalidate-qc: höchstens EINMAL – auch nach erneutem Retest-Fehlschlag", () => {
  const store = seed(QCFAILED());
  revalidateQcRepairOrder(store, ID, ARGS);
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(data.orders[ID], { state: "VALIDATION_FAILED", blocked_reason: RETEST_FAIL, regression: QCFAILED().regression, browser_validation: QCFAILED().browser_validation });
  store.write(REPAIR_ORDERS_FILE, data);
  assert.throws(() => revalidateQcRepairOrder(store, ID, ARGS), /bereits einmal/);
});

test("K9 revalidate-qc: jede verletzte Bedingung → Fehler, Auftrag byte-gleich", () => {
  const cases = [
    ["falsche ID", QCFAILED(), { id: "VNFIX-20261022-f1f061" }, /Ungültige Auftrags-ID/],
    ["unbekannter Auftrag", QCFAILED(), { id: "RF480-20261022-000000" }, /nicht gefunden/],
    ["ohne Begründung", QCFAILED(), { reason: " " }, /Begründung/],
    ["falsche Domain", QCFAILED(), { domain: "praxis-kaelin.netlify.app" }, /stimmt nicht/],
    ["Echtauftrag", QCFAILED({ test_order: false, environment: "LIVE" }), {}, /Nur für E2E-Testaufträge/],
    ["E2E aus", QCFAILED(), { env: { ...SANDBOX_ENV, JARVIS_E2E_TEST_ENABLED: "false" } }, /E2E-Sandbox-Domain/],
    ["Domain nicht in E2E-Liste", QCFAILED(), { env: { ...SANDBOX_ENV, JARVIS_E2E_TEST_DOMAINS: "andere.ch" } }, /E2E-Sandbox-Domain/],
    ["anderer Zustand", QCFAILED({ state: "MANUAL_REVIEW_REQUIRED" }), {}, /Nur im Zustand VALIDATION_FAILED/],
    ["anderer Grund (weiterhin vorhanden)", QCFAILED({ blocked_reason: "1 reparierte(r) Befund(e) weiterhin vorhanden." }), {}, /anderer Prüfgrund/],
    ["anderer Grund (Build)", QCFAILED({ blocked_reason: "Build/Prüfung nach der Reparatur nicht erfolgreich." }), {}, /anderer Prüfgrund/],
    ["anderer Adapter", QCFAILED({ stack: { type: "wordpress" } }), {}, /GitHub\/Netlify/],
    ["ohne Freigabe", QCFAILED({ customer_authorized_repair: false }), {}, /Kundenfreigabe/],
    ["ohne Backup", QCFAILED({ backup: null }), {}, /Backup unvollständig/],
    ["Deployment vorhanden", QCFAILED({ deployment: { deployed: true } }), {}, /Deployment/],
    ["weiterer Browser-Befund", QCFAILED({ browser_validation: { verdict: "ROLLBACK", codes: ["HIGH:finding_unresolved", "HIGH:new_js_error"] } }), {}, /Browser-Befund/],
    ["anderer Browser-Befund", QCFAILED({ browser_validation: { verdict: "ROLLBACK", codes: ["HIGH:massive_overflow"] } }), {}, /Browser-Befund/],
    ["ohne Browser-Ergebnis", QCFAILED({ browser_validation: null }), {}, /Browser-Befund/],
    ["andere Regression", QCFAILED({ regression: { found: [{ type: "unreachable" }], browser: true } }), {}, /Browser-Befund/],
    ["Live-Regression", QCFAILED({ regression: { found: [{ type: "HIGH:finding_unresolved" }], browser: true, live: true } }), {}, /Browser-Befund/],
    ["passiver Abruf fehlgeschlagen", QCFAILED({ retest: { http_ok: false } }), {}, /passive/],
    ["Vorschau nicht commitgebunden", QCFAILED({ validation: { build_ok: true, preview_url: "https://repair--x.netlify.app" } }), {}, /Vorschau/],
    ["Vorschau anderer Commit", QCFAILED({ validation: { ...QCFAILED().validation, preview_commit: "0".repeat(40) } }), {}, /Vorschau/],
    ["Befund nicht repariert", QCFAILED({ issues: { I1: { issue_id: "I1", repair_status: "still_broken", change_ref: `git:${C1}` } } }), {}, /Reparatur-Commit/],
    ["Commit fehlt", QCFAILED({ issues: { I1: { issue_id: "I1", repair_status: "repaired" } } }), {}, /Reparatur-Commit/],
  ];
  for (const [name, order, over, re] of cases) {
    const store = seed(order);
    const before = JSON.stringify(store.read(REPAIR_ORDERS_FILE, {}));
    const { id = ID, ...args } = over;
    assert.throws(() => revalidateQcRepairOrder(store, id, { ...ARGS, ...args }), re, name);
    assert.equal(JSON.stringify(store.read(REPAIR_ORDERS_FILE, {})), before, `${name}: Auftrag darf nicht verändert werden`);
  }
});

// ---------- (4) Engine: Retest-Fehlalarm → revalidate-qc → Merge/Produktion mit DEMSELBEN Commit, keine Mail ----------
const HOME = "https://muster.ch/";
const SITE_ID = "0123456789abcdef0123";
const ENV = { [GITHUB_TOKEN_ENV]: "ghp_FAKE_NUR_TEST_1234567890", [NETLIFY_TOKEN_ENV]: "nfp_FAKE_NUR_TEST_0987654321" };
const E2E_ENV = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "muster.ch", JARVIS_E2E_TEST_MAILBOXES: "test@muster.ch" };
const NEW = "6ada115b8e67ea1ecd9bb0aa";
// Minimaler GitHub/Netlify-Fake: Reparatur-Commit liegt bereits im Branch, Deploy NEW (commit C1) ist ready, Merge/Prod-Deploy zählbar.
function mkFetch() {
  const state = { merged: false, calls: [] };
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init = {}) => {
    const method = init.method || "GET";
    state.calls.push({ method, url });
    if (url.includes("/git/ref/heads/")) return json(200, { object: { sha: C1 } });
    if (url.includes(`/sites/${SITE_ID}/deploys?branch=`)) return json(200, [{ id: NEW, state: "ready", commit_ref: C1, links: { permalink: `https://${NEW}--muster.netlify.app` } }]);
    if (url.includes("/merges") || (url.includes("/pulls") && method !== "GET") || (url.includes("/git/refs/heads/main") && method === "PATCH")) { state.merged = true; return json(201, { sha: C1 }); }
    if (url.includes(`/sites/${SITE_ID}/deploys`) || url.includes(`/sites/${SITE_ID}`)) return json(200, state.merged ? [{ id: "6adaprod0000000000000000", state: "ready", context: "production", commit_ref: C1, branch: "main", links: { permalink: "https://6adaprod0000000000000000--muster.netlify.app" } }] : []);
    return json(200, {});
  };
  return { fetchFn, state };
}

test("K9 Engine: Retest-Fehlalarm (VALIDATION_FAILED «Retest nicht bestanden») bleibt ohne revalidate-qc stehen; danach Neuvalidierung mit demselben Commit, kein PUT/Branch/Backup, keine Mail", async () => {
  const store = createStore(tmp());
  setRepairMapping(store, "muster.ch", { repo: "chris/muster-website", production_branch: "main", netlify_site_id: SITE_ID });
  const o = createRepairOrder(store, { domain: "muster.ch", website: HOME, company: "Muster AG", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_order_form", reference: "E2E", now: T0 });
  const pre = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(pre.orders[o.order_id], { test_order: true, environment: "TEST", test_run_id: "e2e-0123456789ab" });
  store.write(REPAIR_ORDERS_FILE, pre);
  recordPayment(store, { order_id: o.order_id, amount: 240, currency: "CHF", source: "stripe_test_checkout", reference: "stripe:pi_test_k9", provider_mode: "TEST", now: T0 });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const backup = { production_ref: "2ce721d244d0", backup_ref: "git:2ce721d244d0", rollback_point: "netlify:6ad91363", branch: `repair/${o.order_id}`, created_at: T0.toISOString() };
  Object.assign(data.orders[o.order_id], QCFAILED({ order_id: o.order_id, domain: "muster.ch", website: HOME, test_run_id: "e2e-0123456789ab", backup,
    validation: { build_ok: true, preview_url: `https://${NEW}--muster.netlify.app`, preview_deploy: NEW, preview_commit: C1 }, audit_before: { issues: {} }, state_history: data.orders[o.order_id].state_history }),
    { payment_status: data.orders[o.order_id].payment_status });
  store.write(REPAIR_ORDERS_FILE, data);
  const f = mkFetch();
  const adapter = githubNetlifyAdapter({ store, env: ENV, fetchFn: f.fetchFn, sleep: async () => {}, pollMs: 0, buildTimeoutMs: 500, now: () => T0 });
  const auditor = { audit: async (website) => ({ website, host: "muster.ch", reachable: true, finalUrl: website, title: "Muster AG", issues: [], pages: { home: "<html><head><meta name=viewport content=x></head><body>ok</body></html>" }, requests: 2 }) };
  const sent = [];
  const engine = () => createRepairEngine({ store, adapters: { github_netlify: adapter }, auditor, gmail: { send: async (m) => { sent.push(m); return { id: "x" }; } }, e2e: e2eConfig(E2E_ENV), now: () => T0 });
  await engine().processAll();
  assert.equal(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id].state, "VALIDATION_FAILED", "ohne revalidate-qc keine Bewegung");
  revalidateQcRepairOrder(store, o.order_id, { domain: "muster.ch", reason: "K9 Test", env: E2E_ENV, now: T0 });
  // Nur der erste Schritt (VALIDATION): bindet erneut an den Reparatur-Commit und dessen Permalink.
  const eng = engine();
  await eng.processAll();
  const saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  const steps = saved.state_history.slice(-3).map((h) => `${h.from}→${h.to}`);
  assert.deepEqual(steps.slice(0, 2), ["VALIDATION_FAILED→VALIDATION", "VALIDATION→RETEST"], JSON.stringify(saved.state_history.slice(-3)));
  // Ohne Browser in diesem Test: RETEST stoppt fail closed (MANUAL_REVIEW) statt ohne Browser-Gate abzuschliessen.
  assert.equal(saved.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(saved.deployment ?? null, null, "ohne Browser-Retest kein Produktionsdeploy");
  assert.equal(saved.validation.preview_commit, C1);
  assert.equal(saved.validation.preview_url, `https://${NEW}--muster.netlify.app`);
  assert.equal(f.state.calls.filter((c) => c.method === "PUT").length, 0, "kein neuer Commit");
  assert.equal(f.state.calls.filter((c) => c.method === "POST" && c.url.includes("/git/refs")).length, 0, "kein neuer Branch");
  assert.deepEqual(saved.backup, backup, "kein zweites Backup");
  assert.equal(sent.length, 0, "keine Mail");
});
