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
import { createRepairOrder, authorizeRepair, createRepairEngine, replanRepairOrder, revalidateRepairOrder, NO_UNIQUE_CAUSE_REASON, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { githubNetlifyAdapter, setRepairMapping, previewPermalink, GITHUB_TOKEN_ENV, NETLIFY_TOKEN_ENV } from "../repair-adapters/github-netlify.js";
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
const C1 = "d7b0bfbf68cd0bb1ec3a4a840ab42a5cdda785bf"; // Reparatur-Commit
const OLD = "6ada030dfad22fd5f3b63856", NEW = "6ada115b8e67ea1ecd9bb0aa"; // Branch-Deploys: Backup-Stand / Reparatur-Commit
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const NAV = '<nav><a href="/">Start</a> · <a href="/team-alt.html">Team</a></nav>';
const ISSUE = { type: "broken_link", url: "https://muster.ch/team-alt.html", page: HOME, label: "Team", evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity: "medium" };
const ORDER = { order_id: "RF480-20261022-abc123", domain: "muster.ch", website: HOME, backup: { production_ref: "aaa111", rollback_point: "netlify:dep0", branch: "repair/RF480-20261022-abc123" } };

// Mock-GitHub/Netlify wie die Sandbox: index.html verweist auf /team-alt.html, team.html existiert genau einmal; gen.mjs/README.md
// enthalten den Pfad auch (keine HTML-Dateien). search: «incomplete» (200, 0 Treffer, incomplete_results) | «complete» | «error» (403).
function mkFetch({ search = "incomplete", previews = null, files = { "index.html": `<html><body>${NAV}<a href="/team-alt.html">Team</a></body></html>` } } = {}) {
  const state = { repaired: false, merged: false, head: "aaa111", previewPolls: 0 };
  const calls = [];
  const contentOf = (p) => (p === "index.html" && state.repaired ? files[p].split("/team-alt.html").join("/team.html") : files[p]);
  const fetchFn = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url });
    const reply = (status, json) => ({ status, json: async () => json });
    if (url.includes("/git/ref/heads/main")) return reply(200, { object: { sha: "aaa111" } });
    if (url.endsWith("/repos/chris/muster-website")) return reply(200, { permissions: { push: true } });
    if (url.includes("/git/ref/heads/repair")) return reply(200, { object: { sha: state.head } });
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
    if (m && method === "PUT") { state.repaired = true; state.head = C1; return reply(200, { commit: { sha: C1 } }); }
    if (url.includes("/merges") && method === "POST") { state.merged = true; return reply(201, {}); }
    if (url.includes(`/sites/${SITE_ID}/deploys?branch=repair`)) {
      state.previewPolls++;
      // Standard wie in der Sandbox: alter ready-Deploy (Backup-Stand) + Deploy des Reparatur-Commits (ab dem 2. Abruf ready).
      const list = previews ? previews(state) : [
        { id: NEW, state: state.previewPolls >= 2 ? "ready" : "building", commit_ref: C1, deploy_url: `http://${NEW}--muster.netlify.app`, deploy_ssl_url: "https://repair--muster.netlify.app" },
        { id: OLD, state: "ready", commit_ref: "aaa111", deploy_url: `http://${OLD}--muster.netlify.app`, deploy_ssl_url: "https://repair--muster.netlify.app" }];
      return reply(200, list);
    }
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

// ---------- (4) Commit-gebundene Vorschau (K6-Race: alter Branch-Deploy / Alias-URL während des Builds) ----------
const REPAIRED = { ...ORDER, plan: [{ issue_id: "I1" }], issues: { I1: { issue_id: "I1", repair_status: "repaired", change_ref: `git:${C1}` } } };
const repairedFetch = (opts = {}) => { const f = mkFetch(opts); f.state.head = C1; return f; };

test("TF-028 validate: alter ready-Deploy (Backup-Stand) zählt nie – gewartet wird auf den Deploy des Reparatur-Commits, geprüft über dessen Permalink", async () => {
  const f = repairedFetch();
  const v = await mkAdapter(f).validate(REPAIRED);
  assert.deepEqual(v, { build_ok: true, preview_url: `https://${NEW}--muster.netlify.app`, preview_deploy: NEW, preview_commit: C1 });
  assert.ok(f.state.previewPolls >= 2, "erster Abruf: neuer Deploy baut noch → weiter warten, alten nicht nehmen");
  assert.ok(!v.preview_url.includes("repair--"), "nie die Branch-Alias-URL");
});

test("TF-028 validate: nur alter Deploy vorhanden (neuer nie ready) → Timeout → build_ok false, nie der alte", async () => {
  const f = repairedFetch({ previews: () => [{ id: OLD, state: "ready", commit_ref: "aaa111", deploy_url: `http://${OLD}--muster.netlify.app` }] });
  assert.equal((await mkAdapter(f).validate(REPAIRED)).build_ok, false);
});

test("TF-028 validate: Build-Fehler genau des Reparatur-Commits → false; Fehler eines ALTEN Deploys stört nicht", async () => {
  const err = repairedFetch({ previews: () => [{ id: NEW, state: "error", commit_ref: C1 }] });
  assert.equal((await mkAdapter(err).validate(REPAIRED)).build_ok, false);
  const oldErr = repairedFetch({ previews: () => [{ id: OLD, state: "error", commit_ref: "aaa111" }, { id: NEW, state: "ready", commit_ref: C1, deploy_url: `http://${NEW}--muster.netlify.app` }] });
  assert.equal((await mkAdapter(oldErr).validate(REPAIRED)).preview_url, `https://${NEW}--muster.netlify.app`);
});

test("TF-028 validate: Branch steht nicht auf dem Reparatur-Commit / Commit unbekannt / kein Permalink → fail closed", async () => {
  const moved = mkFetch(); moved.state.head = "e".repeat(40);
  assert.equal((await mkAdapter(moved).validate(REPAIRED)).build_ok, false);
  assert.equal((await mkAdapter(repairedFetch()).validate({ ...REPAIRED, issues: { I1: { issue_id: "I1", change_ref: "git:repair/RF480-20261022-abc123" } } })).build_ok, false);
  const noLink = repairedFetch({ previews: () => [{ id: NEW, state: "ready", commit_ref: C1, deploy_ssl_url: "https://repair--muster.netlify.app" }] });
  assert.equal((await mkAdapter(noLink).validate(REPAIRED)).build_ok, false);
});

test("TF-028 previewPermalink: nur https://<deploy-id>--<site>.netlify.app", () => {
  assert.equal(previewPermalink({ id: NEW, deploy_url: `http://${NEW}--jarvis-sandbox-e2e.netlify.app` }), `https://${NEW}--jarvis-sandbox-e2e.netlify.app`);
  assert.equal(previewPermalink({ id: NEW, links: { permalink: `https://${NEW}--jarvis-sandbox-e2e.netlify.app` } }), `https://${NEW}--jarvis-sandbox-e2e.netlify.app`);
  assert.equal(previewPermalink({ id: NEW, deploy_url: "https://repair-rf480--jarvis-sandbox-e2e.netlify.app" }), null);
  assert.equal(previewPermalink({ id: NEW, deploy_url: `http://${OLD}--x.netlify.app` }), null);
  assert.equal(previewPermalink({ id: "kurz", deploy_url: "http://kurz--x.netlify.app" }), null);
});

// ---------- (5) --revalidate ----------
const STILL = "1 reparierte(r) Befund(e) weiterhin vorhanden.";
const VFAILED = (over = {}) => ({ ...BLOCKED(), state: "VALIDATION_FAILED", blocked_reason: STILL, stack: { type: "github_netlify" },
  plan: [{ issue_id: "I1", fix: { files: ["index.html"] } }], issues: { I1: { issue_id: "I1", type: "broken_link", repair_status: "still_broken", change_ref: `git:${C1}` } },
  validation: null, regression: null, ...over });

test("TF-028 revalidate: zulässiger Fall → VALIDATION mit bestehendem Commit, Befund wieder «repaired», dokumentiert", () => {
  const store = seed(VFAILED());
  const o = revalidateRepairOrder(store, "RF480-20261022-f1f061", ARGS);
  const saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders["RF480-20261022-f1f061"];
  assert.equal(o.state, "VALIDATION");
  assert.equal(saved.issues.I1.repair_status, "repaired");
  assert.equal(saved.issues.I1.change_ref, `git:${C1}`);
  assert.deepEqual(saved.backup, BLOCKED().backup);
  assert.equal(saved.revalidations.length, 1);
  assert.deepEqual(saved.revalidations[0].change_refs, [`git:${C1}`]);
  assert.equal(saved.blocked_reason, null);
  assert.equal(saved.state_history.at(-1).from, "VALIDATION_FAILED");
});

test("TF-028 revalidate: höchstens EINMAL – auch nach erneutem VALIDATION_FAILED", () => {
  const store = seed(VFAILED());
  revalidateRepairOrder(store, "RF480-20261022-f1f061", ARGS);
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(data.orders["RF480-20261022-f1f061"], { state: "VALIDATION_FAILED", blocked_reason: STILL });
  data.orders["RF480-20261022-f1f061"].issues.I1.repair_status = "still_broken";
  store.write(REPAIR_ORDERS_FILE, data);
  assert.throws(() => revalidateRepairOrder(store, "RF480-20261022-f1f061", ARGS), /bereits einmal/);
});

test("TF-028 revalidate: jede verletzte Bedingung → Fehler, Auftrag byte-gleich", () => {
  const cases = [
    ["falsche ID", VFAILED(), { id: "VNFIX-20261022-f1f061" }, /Ungültige Auftrags-ID/],
    ["ohne Begründung", VFAILED(), { reason: "" }, /Begründung/],
    ["falsche Domain", VFAILED(), { domain: "praxis-kaelin.netlify.app" }, /stimmt nicht/],
    ["Echtauftrag", VFAILED({ test_order: false, environment: "LIVE" }), {}, /Nur für E2E-Testaufträge/],
    ["E2E aus", VFAILED(), { env: { ...SANDBOX_ENV, JARVIS_E2E_TEST_ENABLED: "false" } }, /E2E-Sandbox-Domain/],
    ["anderer Zustand", VFAILED({ state: "MANUAL_REVIEW_REQUIRED" }), {}, /Nur im Zustand VALIDATION_FAILED/],
    ["anderer Grund (Build)", VFAILED({ blocked_reason: "Build/Prüfung nach der Reparatur nicht erfolgreich." }), {}, /anderer Prüfgrund/],
    ["anderer Grund (Retest)", VFAILED({ blocked_reason: "Retest nicht bestanden (Desktop ok, Smartphone fehlgeschlagen)." }), {}, /anderer Prüfgrund/],
    ["anderer Adapter", VFAILED({ stack: { type: "wordpress" } }), {}, /GitHub\/Netlify/],
    ["ohne Freigabe", VFAILED({ customer_authorized_repair: false }), {}, /Kundenfreigabe/],
    ["ohne Backup", VFAILED({ backup: null }), {}, /Backup unvollständig/],
    ["Deployment vorhanden", VFAILED({ deployment: { deployed: true } }), {}, /Deployment oder Regression/],
    ["Regression vorhanden", VFAILED({ regression: { found: [{ type: "x" }] } }), {}, /Deployment oder Regression/],
    ["kein Plan", VFAILED({ plan: [] }), {}, /Reparatur-Commit/],
    ["Commit fehlt", VFAILED({ issues: { I1: { issue_id: "I1", repair_status: "still_broken" } } }), {}, /Reparatur-Commit/],
    ["Commit nur Branchname", VFAILED({ issues: { I1: { issue_id: "I1", repair_status: "still_broken", change_ref: "git:repair/RF480" } } }), {}, /Reparatur-Commit/],
    ["Fix gescheitert", VFAILED({ issues: { I1: { issue_id: "I1", repair_status: "repair_failed", change_ref: `git:${C1}` } } }), {}, /Reparatur-Commit/],
  ];
  for (const [name, order, over, re] of cases) {
    const store = seed(order);
    const before = JSON.stringify(store.read(REPAIR_ORDERS_FILE, {}));
    const { id = "RF480-20261022-f1f061", ...args } = over;
    assert.throws(() => revalidateRepairOrder(store, id, { ...ARGS, ...args }), re, name);
    assert.equal(JSON.stringify(store.read(REPAIR_ORDERS_FILE, {})), before, `${name}: Auftrag darf nicht verändert werden`);
  }
});

test("TF-028 Engine: veraltete Vorschau → VALIDATION_FAILED → revalidate → Abschluss mit DEMSELBEN Commit, kein 2. Commit/Backup/Branch", async () => {
  const dir = tmp();
  const store = createStore(dir);
  setRepairMapping(store, "muster.ch", { repo: "chris/muster-website", production_branch: "main", netlify_site_id: SITE_ID });
  const o = createRepairOrder(store, { domain: "muster.ch", website: HOME, company: "Muster AG", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_order_form", reference: "E2E", now: T0 });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(data.orders[o.order_id], { test_order: true, environment: "TEST", test_run_id: "e2e-0123456789ab" });
  store.write(REPAIR_ORDERS_FILE, data);
  recordPayment(store, { order_id: o.order_id, amount: 240, currency: "CHF", source: "stripe_test_checkout", reference: "stripe:pi_test_tf028b", provider_mode: "TEST", now: T0 });
  const f = mkFetch({ search: "incomplete" });
  const real = githubNetlifyAdapter({ store, env: ENV, fetchFn: f.fetchFn, sleep: async () => {}, pollMs: 0, buildTimeoutMs: 500, now: () => T0 });
  // Produktion erst nach Merge repariert; Alias-URL zeigt (Race) noch den alten Stand; Permalink des Reparatur-Commits ist repariert.
  const auditor = { audit: async (website) => {
    const fixed = website.includes(`${NEW}--`) ? true : website.includes("repair--") ? false : f.state.merged;
    return { website, host: "muster.ch", reachable: true, finalUrl: website, title: "Muster AG", issues: fixed ? [] : [ISSUE],
      pages: { home: "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" }, requests: 2 }; } };
  const retester = createRenderRetester({ browserFactory: fakeBrowser() });
  // Lauf 1: altes validate()-Verhalten (erster ready-Deploy, Alias-URL) → VALIDATION_FAILED «weiterhin vorhanden».
  const legacy = { ...real, validate: async () => ({ build_ok: true, preview_url: "https://repair--muster.netlify.app" }) };
  await createRepairEngine({ store, adapters: { github_netlify: legacy }, auditor, retester, e2e: E2E, now: () => T0 }).processAll();
  let saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(saved.state, "VALIDATION_FAILED");
  assert.equal(saved.blocked_reason, STILL);
  const puts = () => f.calls.filter((c) => c.method === "PUT").length;
  const refPosts = () => f.calls.filter((c) => c.method === "POST" && c.url.includes("/git/refs")).length;
  assert.equal(puts(), 1);
  const [putsBefore, refsBefore, backupBefore] = [puts(), refPosts(), JSON.stringify(saved.backup)];
  // Ohne revalidate bleibt der Auftrag stehen.
  await createRepairEngine({ store, adapters: { github_netlify: real }, auditor, retester, e2e: E2E, now: () => T0 }).processAll();
  assert.equal(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id].state, "VALIDATION_FAILED");
  revalidateRepairOrder(store, o.order_id, { domain: "muster.ch", reason: "TF-028 Test", env: E2E_ENV, now: T0 });
  const sent = [];
  await createRepairEngine({ store, adapters: { github_netlify: real }, auditor, retester, gmail: { send: async (m) => { sent.push(m); return { id: "x" }; } }, e2e: E2E, now: () => T0 }).processAll();
  saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.equal(saved.validation.preview_url, `https://${NEW}--muster.netlify.app`);
  assert.equal(saved.validation.preview_commit, C1);
  assert.equal(puts(), putsBefore, "kein zweiter Commit");
  assert.equal(refPosts(), refsBefore, "kein zweiter Branch");
  assert.equal(JSON.stringify(saved.backup), backupBefore, "kein zweites Backup");
  assert.ok(f.state.merged);
  assert.equal(saved.deployment.deployed, true);
  assert.ok(Object.values(saved.issues).every((i) => i.repair_status === "repaired"));
  assert.equal(sent.length, 0);
});
