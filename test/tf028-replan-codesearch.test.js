// TF-JARVIS-028 Phase 5: (1) GitHub-Codesuche liefert für nicht indexierte Repos 200 + 0 Treffer + incomplete_results – das darf nie als
// «nirgends referenziert» gelten (→ HTML-Scan). (2) --replan: genau EINE, eng begrenzte Wiederaufnahme eines E2E-Testauftrags aus
// MANUAL_REVIEW_REQUIRED («Kein Befund mit eindeutiger Ursache …») auf FULL_AUDIT – ohne zweites Backup, ohne Mail, ohne Duplikate.
// Kein Netzwerk, keine Mail, kein echter Kunde.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, replanRepairOrder, NO_UNIQUE_CAUSE_REASON, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { githubNetlifyAdapter, setRepairMapping, GITHUB_TOKEN_ENV, NETLIFY_TOKEN_ENV } from "../repair-adapters/github-netlify.js";
import { createRenderRetester } from "../repair-render-test.js";
import { recordPayment } from "../payments.js";
import { e2eConfig } from "../e2e-test.js";

const T0 = new Date("2026-10-22T12:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf028-"));
const HOME = "https://muster.ch/";
const SITE_ID = "0123456789abcdef0123";
const ENV = { [GITHUB_TOKEN_ENV]: "ghp_FAKE_NUR_TEST_1234567890", [NETLIFY_TOKEN_ENV]: "nfp_FAKE_NUR_TEST_0987654321" };
const E2E_ENV = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "muster.ch", JARVIS_E2E_TEST_MAILBOXES: "test@muster.ch" };
const E2E = e2eConfig(E2E_ENV);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const NAV = '<nav><a href="/">Start</a> · <a href="/team-alt.html">Team</a></nav>';
const ISSUE = { type: "broken_link", url: "https://muster.ch/team-alt.html", page: HOME, label: "Team", evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity: "medium" };
const ORDER = { order_id: "RF480-20261022-abc123", domain: "muster.ch", website: HOME, backup: { production_ref: "aaa111", rollback_point: "netlify:dep0", branch: "repair/RF480-20261022-abc123" } };

// Mock-GitHub/Netlify wie die Sandbox: index.html verweist auf /team-alt.html, team.html existiert genau einmal; gen.mjs/README.md
// enthalten den Pfad auch (keine HTML-Dateien). search: «incomplete» (200, 0 Treffer, incomplete_results) | «complete» | «error» (403).
function mkFetch({ search = "incomplete", files = { "index.html": `<html><body>${NAV}<a href="/team-alt.html">Team</a></body></html>` } } = {}) {
  const state = { repaired: false, merged: false };
  const calls = [];
  const contentOf = (p) => (p === "index.html" && state.repaired ? files[p].split("/team-alt.html").join("/team.html") : files[p]);
  const fetchFn = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url });
    const reply = (status, json) => ({ status, json: async () => json });
    if (url.includes("/git/ref/heads/main")) return reply(200, { object: { sha: "aaa111" } });
    if (url.endsWith("/repos/chris/muster-website")) return reply(200, { permissions: { push: true } });
    if (url.includes("/git/ref/heads/repair")) return reply(200, { object: { sha: "aaa111" } });
    if (url.includes("/git/trees/aaa111")) return reply(200, { truncated: false, tree: [...Object.keys(files), "team.html", "gen.mjs", "README.md"].map((p) => ({ path: p, type: "blob" })) });
    if (url.includes("/search/code")) {
      if (search === "error") return reply(403, { message: "forbidden" });
      if (search === "complete") return reply(200, { total_count: 1, incomplete_results: false, items: [{ path: "index.html" }] });
      return reply(200, { total_count: 0, incomplete_results: true, items: [] });
    }
    const m = url.match(/\/contents\/([^?]+)/);
    if (m && method === "GET") {
      const p = decodeURIComponent(m[1]);
      if (files[p] != null) return reply(200, { sha: `sha-${p}`, content: b64(contentOf(p)) });
      if (p === "team.html") return reply(200, { sha: "sha-team", content: b64("<html><body>Team</body></html>") });
      if (p === "gen.mjs" || p === "README.md") return reply(200, { sha: `sha-${p}`, content: b64("/team-alt.html") });
      return reply(404, {});
    }
    if (m && method === "PUT") { state.repaired = true; return reply(200, { commit: { sha: "ccc333" } }); }
    if (url.includes("/merges") && method === "POST") { state.merged = true; return reply(201, {}); }
    if (url.includes(`/sites/${SITE_ID}/deploys?branch=repair`)) return reply(200, [{ state: "ready", deploy_ssl_url: "https://repair--muster.netlify.app", created_at: "2026-10-22T12:10:00Z" }]);
    if (url.includes(`/sites/${SITE_ID}/deploys?branch=main`)) return reply(200, [{ id: "dep1", state: "ready", created_at: "2026-10-22T12:20:00Z" }]);
    if (url.includes(`/sites/${SITE_ID}`)) return reply(200, { custom_domain: "muster.ch", domain_aliases: [], published_deploy: { id: "dep0" }, ssl_url: "https://muster.ch" });
    return reply(404, {});
  };
  return { fetchFn, calls, state };
}
const mkAdapter = (f) => {
  const store = createStore(tmp());
  setRepairMapping(store, "muster.ch", { repo: "chris/muster-website", production_branch: "main", netlify_site_id: SITE_ID });
  return githubNetlifyAdapter({ store, env: ENV, fetchFn: f.fetchFn, sleep: async () => {}, pollMs: 0, buildTimeoutMs: 500, now: () => T0 });
};

// ---------- (1) Codesuche-Fallback ----------
test("TF-028 locate: Codesuche 200 + 0 Treffer + incomplete_results → HTML-Scan findet index.html, Ersatz /team.html", async () => {
  const f = mkFetch({ search: "incomplete" });
  const loc = await mkAdapter(f).locate(ISSUE, ORDER);
  assert.ok(loc, "locate darf bei unvollständigem Suchindex nicht null liefern");
  assert.deepEqual(loc.fix.files, ["index.html"]);
  assert.equal(loc.fix.brokenPath, "/team-alt.html");
  assert.equal(loc.fix.replacement, "/team.html");
  // Nur HTML gescannt: gen.mjs/README.md (enthalten den Pfad, sind aber keine Seiten) werden nie gelesen oder geändert.
  assert.ok(!f.calls.some((c) => /contents\/(gen\.mjs|README\.md)/.test(c.url)));
});

test("TF-028 locate: Codesuche 200 ohne Treffer, aber vollständig (incomplete_results false) → ebenfalls Scan (leer ist kein Beleg)", async () => {
  const f = mkFetch({ search: "incomplete" });
  const orig = f.fetchFn;
  f.fetchFn = async (url, init) => (url.includes("/search/code") ? { status: 200, json: async () => ({ total_count: 0, incomplete_results: false, items: [] }) } : orig(url, init));
  const loc = await mkAdapter(f).locate(ISSUE, ORDER);
  assert.deepEqual(loc?.fix.files, ["index.html"]);
});

test("TF-028 locate: vollständige Suchtreffer bleiben massgeblich (unverändertes Verhalten, kein zusätzlicher Scan)", async () => {
  const f = mkFetch({ search: "complete", files: { "index.html": `<html>${NAV}</html>`, "kontakt.html": `<html>${NAV}</html>` } });
  const loc = await mkAdapter(f).locate(ISSUE, ORDER);
  assert.deepEqual(loc.fix.files, ["index.html"]);
  assert.ok(!f.calls.some((c) => c.url.includes("contents/kontakt.html")), "bei vollständigen Treffern kein Scan");
});

test("TF-028 locate: Suche nicht verfügbar (403) → Scan wie bisher", async () => {
  const loc = await mkAdapter(mkFetch({ search: "error" })).locate(ISSUE, ORDER);
  assert.deepEqual(loc?.fix.files, ["index.html"]);
});

test("TF-028 locate: mehr als 3 HTML-Dateien betroffen → weiterhin null (keine Massenänderung)", async () => {
  const page = `<html>${NAV}</html>`;
  const f = mkFetch({ search: "incomplete", files: { "index.html": page, "a.html": page, "b.html": page, "c.html": page } });
  assert.equal(await mkAdapter(f).locate(ISSUE, ORDER), null);
});

// ---------- (2) --replan ----------
const BLOCKED = (over = {}) => ({ order_id: "RF480-20261022-f1f061", domain: "jarvis-sandbox-e2e.netlify.app", website: "https://jarvis-sandbox-e2e.netlify.app/",
  test_order: true, environment: "TEST", test_run_id: "e2e-9b6ef14d983a", state: "MANUAL_REVIEW_REQUIRED", blocked_reason: NO_UNIQUE_CAUSE_REASON, customer_authorized_repair: true,
  backup: { production_ref: "2ce721d244d0", backup_ref: "git:2ce721d244d0", rollback_point: "netlify:6ad91363", branch: "repair/RF480-20261022-f1f061", created_at: T0.toISOString() },
  plan: [], deployment: null, issues: { I1: { issue_id: "I1", type: "broken_link", repair_status: "needs_review", repairable: true } },
  manual_review: [{ at: T0.toISOString(), reason: NO_UNIQUE_CAUSE_REASON }], state_history: [], ...over });
const SANDBOX_ENV = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "jarvis-sandbox-e2e.netlify.app", JARVIS_E2E_TEST_MAILBOXES: "test@muster.ch" };
const seed = (order) => { const store = createStore(tmp()); store.write(REPAIR_ORDERS_FILE, { schema: 1, orders: { [order.order_id]: order } }); return store; };
const ARGS = { domain: "jarvis-sandbox-e2e.netlify.app", reason: "TF-028 Codesuche-Fallback korrigiert", env: SANDBOX_ENV, now: T0 };

test("TF-028 replan: zulässiger Fall → FULL_AUDIT, bestehendes Backup/Branch bleibt, Grund + Verlauf dokumentiert", () => {
  const store = seed(BLOCKED());
  const o = replanRepairOrder(store, "RF480-20261022-f1f061", ARGS);
  const saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders["RF480-20261022-f1f061"];
  assert.equal(saved.state, "FULL_AUDIT");
  assert.equal(saved.blocked_reason, null);
  assert.deepEqual(saved.backup, BLOCKED().backup, "Backup unverändert – kein zweites Backup");
  assert.equal(saved.replans.length, 1);
  assert.equal(saved.replans[0].from_reason, NO_UNIQUE_CAUSE_REASON);
  assert.equal(saved.state_history.at(-1).from, "MANUAL_REVIEW_REQUIRED");
  assert.equal(saved.state_history.at(-1).to, "FULL_AUDIT");
  assert.equal(o.state, "FULL_AUDIT");
});

test("TF-028 replan: zweite Ausführung wird abgelehnt (auch nach erneutem Block) – keine Duplikate", () => {
  const store = seed(BLOCKED());
  replanRepairOrder(store, "RF480-20261022-f1f061", ARGS);
  assert.throws(() => replanRepairOrder(store, "RF480-20261022-f1f061", ARGS), /MANUAL_REVIEW_REQUIRED|bereits/);
  // Selbst wenn der Auftrag wieder mit demselben Grund blockiert: höchstens EINE Wiederaufnahme.
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(data.orders["RF480-20261022-f1f061"], { state: "MANUAL_REVIEW_REQUIRED", blocked_reason: NO_UNIQUE_CAUSE_REASON });
  store.write(REPAIR_ORDERS_FILE, data);
  assert.throws(() => replanRepairOrder(store, "RF480-20261022-f1f061", ARGS), /bereits einmal/);
});

test("TF-028 replan: jede verletzte Bedingung → Fehler, Auftrag unverändert", () => {
  const cases = [
    ["falsche Auftrags-ID", BLOCKED(), { id: "VNFIX-20261022-f1f061" }, /Ungültige Auftrags-ID/],
    ["unbekannter Auftrag", BLOCKED(), { id: "RF480-20261022-000000" }, /nicht gefunden/],
    ["ohne Begründung", BLOCKED(), { reason: "  " }, /Begründung/],
    ["falsche Domain", BLOCKED(), { domain: "praxis-kaelin.netlify.app" }, /stimmt nicht/],
    ["ohne Domain", BLOCKED(), { domain: undefined }, /stimmt nicht/],
    ["Echtauftrag", BLOCKED({ test_order: false, environment: "LIVE" }), {}, /Nur für E2E-Testaufträge/],
    ["Testauftrag ohne Testlauf-ID", BLOCKED({ test_run_id: null }), {}, /Nur für E2E-Testaufträge/],
    ["E2E aus", BLOCKED(), { env: { ...SANDBOX_ENV, JARVIS_E2E_TEST_ENABLED: "false" } }, /E2E-Sandbox-Domain/],
    ["Domain nicht in E2E-Liste", BLOCKED(), { env: { ...SANDBOX_ENV, JARVIS_E2E_TEST_DOMAINS: "andere.ch" } }, /E2E-Sandbox-Domain/],
    ["anderer Zustand", BLOCKED({ state: "REPAIR_FAILED" }), {}, /Nur im Zustand MANUAL_REVIEW_REQUIRED/],
    ["anderer Prüfgrund", BLOCKED({ blocked_reason: "Backup unvollständig (Produktionsstand/Backup/Rollback-Punkt) – ohne Rollback keine Reparatur." }), {}, /anderer Prüfgrund/],
    ["ohne Kundenfreigabe", BLOCKED({ customer_authorized_repair: false }), {}, /Kundenfreigabe/],
    ["ohne Backup", BLOCKED({ backup: null }), {}, /Backup unvollständig/],
    ["Backup ohne Rollback-Punkt", BLOCKED({ backup: { ...BLOCKED().backup, rollback_point: "" } }), {}, /Backup unvollständig/],
    ["Plan vorhanden", BLOCKED({ plan: [{ issue_id: "I1" }] }), {}, /Plan oder Deployment/],
    ["Deployment vorhanden", BLOCKED({ deployment: { deployed: true } }), {}, /Plan oder Deployment/],
  ];
  for (const [name, order, over, re] of cases) {
    const store = seed(order);
    const before = JSON.stringify(store.read(REPAIR_ORDERS_FILE, {}));
    const { id = "RF480-20261022-f1f061", ...args } = over;
    assert.throws(() => replanRepairOrder(store, id, { ...ARGS, ...args }), re, name);
    assert.equal(JSON.stringify(store.read(REPAIR_ORDERS_FILE, {})), before, `${name}: Auftrag darf nicht verändert werden`);
  }
});

// ---------- (3) Engine: Blockade → --replan → genau ein Reparaturlauf auf dem bestehenden Backup ----------
// Render-Attrappe wie test/repair-adapter-036 (Desktop + Smartphone ohne Probleme).
const fakePage = () => ({ setViewportSize: async () => {}, goto: async () => ({ status: () => 200 }),
  evaluate: async () => ({ problems: [], info: { links: 5, buttons: 1, images_visible: 2, contact_found: true } }) });
const fakeBrowser = () => async () => ({ newPage: async () => fakePage(), close: async () => {} });

test("TF-028 Engine: Planungsblock → replan → Reparatur auf bestehendem Backup, kein zweites Backup, keine Mail", async () => {
  const dir = tmp();
  const store = createStore(dir);
  setRepairMapping(store, "muster.ch", { repo: "chris/muster-website", production_branch: "main", netlify_site_id: SITE_ID });
  const o = createRepairOrder(store, { domain: "muster.ch", website: HOME, company: "Muster AG", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_order_form", reference: "E2E", now: T0 });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(data.orders[o.order_id], { test_order: true, environment: "TEST", test_run_id: "e2e-0123456789ab" });
  store.write(REPAIR_ORDERS_FILE, data);
  recordPayment(store, { order_id: o.order_id, amount: 240, currency: "CHF", source: "stripe_test_checkout", reference: "stripe:pi_test_tf028", provider_mode: "TEST", now: T0 });
  const f = mkFetch({ search: "incomplete" });
  const real = githubNetlifyAdapter({ store, env: ENV, fetchFn: f.fetchFn, sleep: async () => {}, pollMs: 0, buildTimeoutMs: 500, now: () => T0 });
  const auditor = { audit: async (website) => ({ website, host: "muster.ch", reachable: true, finalUrl: website, title: "Muster AG",
    issues: f.state.repaired ? [] : [ISSUE], pages: { home: "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" }, requests: 2 }) };
  const sent = [];
  const gmail = { send: async (m) => { sent.push(m); return { id: "x" }; } };
  const retester = createRenderRetester({ browserFactory: fakeBrowser() });
  // Lauf 1: Adapter mit dem alten Verhalten (locate → null) simuliert den Produktionsfehler → MANUAL_REVIEW_REQUIRED.
  const broken = { ...real, locate: async () => null };
  await createRepairEngine({ store, adapters: { github_netlify: broken }, auditor, retester, e2e: E2E, now: () => T0 }).processAll();
  let saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(saved.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(saved.blocked_reason, NO_UNIQUE_CAUSE_REASON);
  const backupBefore = JSON.stringify(saved.backup);
  const branchCreates = () => f.calls.filter((c) => c.method === "POST" && c.url.includes("/git/refs")).length;
  const createsBefore = branchCreates();
  // Ohne replan bewegt sich nichts (MANUAL_REVIEW_REQUIRED ist terminal).
  await createRepairEngine({ store, adapters: { github_netlify: real }, auditor, retester, e2e: E2E, now: () => T0 }).processAll();
  assert.equal(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id].state, "MANUAL_REVIEW_REQUIRED");
  // replan → Lauf 2 mit korrigiertem Adapter.
  replanRepairOrder(store, o.order_id, { domain: "muster.ch", reason: "TF-028 Test", env: E2E_ENV, now: T0 });
  await createRepairEngine({ store, adapters: { github_netlify: real }, auditor, retester, gmail, e2e: E2E, now: () => T0 }).processAll();
  saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.equal(JSON.stringify(saved.backup), backupBefore, "kein zweites Backup");
  assert.equal(branchCreates(), createsBefore, "kein zweiter Branch");
  assert.equal(saved.plan.length, 1);
  assert.deepEqual(saved.plan[0].fix.files, ["index.html"]);
  assert.equal(saved.plan[0].fix.replacement, "/team.html");
  assert.equal(f.calls.filter((c) => c.method === "PUT").length, 1, "genau ein Commit");
  assert.ok(f.state.merged);
  assert.equal(sent.length, 0, "keine Mail durch replan/Reparatur bis zur Lieferung");
});
