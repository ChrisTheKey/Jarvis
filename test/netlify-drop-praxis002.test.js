// TF-JARVIS-PRAXIS-002: Netlify-Drop-Adapter (Site-Erkennung, Berechtigung, vollständige Dateierhaltung, Entwurf/Vorschau, kontrollierte
// Veröffentlichung, Rollback, ungültige Zugangsdaten, falsche Site-ID, fehlende Deploy-Berechtigung, doppelte Anforderungen), generische
// Quelltext-Fixes (inkl. Negativfälle) und TEST/LIVE-Isolation des internen Admin-Testauftrags. Alles gegen eine Netlify-Attrappe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { netlifyDropAdapter, setDropMapping, bindingProblem, readNetlifyToken, NETLIFY_DROP_LOG } from "../repair-adapters/netlify-drop.js";
import { locateStaticFix, applyStaticFix, anchorCandidates, idTypoCandidates } from "../static-site-fixes.js";
import { createRepairOrder, createInternalTestRepairOrder, internalTestWaiverOk, authorizeRepair, createRepairEngine, REPAIR_ORDERS_FILE, INTERNAL_TEST_KIND, isTestOrder } from "../repair-workflow.js";
import { e2eConfig } from "../e2e-test.js";
import { createNetlifyMock, GOOD_TOKEN, READONLY_TOKEN } from "./netlify-mock.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-nfd-"));
const DOMAIN = "praxis-test.netlify.app";
const MAILBOX = "test-postfach@example.ch";
const E2E = e2eConfig({ JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: DOMAIN, JARVIS_E2E_TEST_MAILBOXES: MAILBOX });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const BUGGY = `<!doctype html><html><head><title>T</title><style>
.wrap{overflow:hidden}
.cards{display:grid;grid-template-columns:repeat(4,minmax(260px,1fr));gap:16px}
</style></head><body><nav><a href="#termin">Termin buchen</a></nav>
<section class="wrap"><h2>Notfall</h2><div class="cards"><div>A</div><div>B</div><div>C</div><div>D</div></div></section>
<section id="booking"><h2>Termin</h2></section>
<footer><span id="footer-year"></span></footer>
<script>document.getElementById('footer-yaer').textContent = 2026;</script></body></html>`;
const FILES = { "/index.html": BUGGY, "/style.css": "body{margin:0}", "/logo.png": PNG };
const ISSUES = [
  { type: "broken_anchor", detail: { page_path: "/", anchor: "termin", key: "anchor:termin" } },
  { type: "content_clipped", location: "Notfall", detail: { page_path: "/", element: { tag: "div", id: null, class: "cards" }, min_child_px: 260, key: "clip:notfall" } },
  { type: "js_runtime_error", detail: { page_path: "/", missing_ids: ["footer-yaer"], message: "Cannot set properties of null", key: "js:x" } },
];

function setup({ token = GOOD_TOKEN, mockOpts = {}, order: orderOpts = {}, mapping = {} } = {}) {
  const dir = tmp(), store = createStore(dir);
  const mock = createNetlifyMock({ files: FILES, ...mockOpts });
  setDropMapping(store, DOMAIN, { netlify_site_id: mock.siteId, site_name: mock.siteName, ...mapping });
  const adapter = netlifyDropAdapter({ dir, store, env: token ? { JARVIS_REPAIR_NETLIFY_TOKEN: token } : {}, fetchFn: mock.fetchFn, sleep: async () => {}, pollMs: 1,
    permalinkOf: (id, site) => `http://${id}--${site.name}.netlify.app` });
  const order = { order_id: "RF480-20261022-abc123", domain: DOMAIN, website: `https://${DOMAIN}/`, delivery_email: MAILBOX, ...orderOpts };
  return { dir, store, mock, adapter, order };
}
// Backup + alle drei Fixes wie die Engine (locate auf dem gesicherten Stand, dann applyFix nacheinander).
async function repaired(ctx) {
  const b = await ctx.adapter.backup(ctx.order);
  ctx.order.backup = b;
  const plan = [];
  for (const i of ISSUES) { const loc = await ctx.adapter.locate(i, ctx.order); assert.ok(loc, `locate ${i.type}`); plan.push({ issue_id: i.type, fix: loc.fix, planned_change: loc.planned_change }); }
  for (const p of plan) assert.equal((await ctx.adapter.applyFix(p, ctx.order)).ok, true, `applyFix ${p.issue_id}`);
  return { b, plan };
}
const count = (mock, method, re) => mock.calls.filter((c) => c.method === method && re.test(c.path)).length;

// ---------- 1. Site-Erkennung / 2. Berechtigung ----------
test("1/2 Site-Erkennung: Zuordnung + Domain + Name + ohne Git → Zugang ok; falscher Name/fremde Domain/Git-Site → abgelehnt", async () => {
  const ok = setup();
  const r = await ok.adapter.checkAccess(ok.order);
  assert.equal(r.ok, true); assert.match(r.connector, /^netlify-drop:praxis-test$/);
  assert.ok(r.capabilities.includes("BACKUP") && r.capabilities.includes("ROLLBACK"));
  assert.equal((await setup({ mapping: { site_name: "andere-site" } }).adapter.checkAccess(ok.order)).reason, "site_name_mismatch");
  const foreign = setup();
  assert.equal((await foreign.adapter.checkAccess({ ...foreign.order, domain: "fremde-domain.ch" })).reason, "no_mapping", "ohne Zuordnung nie eine Site erraten");
  const git = setup({ mockOpts: { repoUrl: "https://github.com/x/y" } });
  const g = await git.adapter.checkAccess(git.order);
  assert.equal(g.reason, "site_has_git_repo"); assert.equal(g.blocked_state, "BLOCKED_UNSUPPORTED_STACK");
  assert.equal(await ok.adapter.claims(ok.order), true);
  assert.equal(await ok.adapter.claims({ domain: "fremde-domain.ch" }), false);
});

// ---------- 7. Ungültige Zugangsdaten / 8. Falsche Site-ID ----------
test("7 Ungültige/fehlende Zugangsdaten → invalid_credentials/no_token, kein Token in Log oder Antwort", async () => {
  const bad = setup({ token: "nfp_falsch_9999999999" });
  const r = await bad.adapter.checkAccess(bad.order);
  assert.equal(r.ok, false); assert.equal(r.reason, "invalid_credentials");
  assert.equal((await setup({ token: null }).adapter.checkAccess(bad.order)).reason, "no_token");
  await assert.rejects(bad.adapter.backup(bad.order), /invalid_credentials/);
  const logText = fs.readFileSync(path.join(bad.dir, NETLIFY_DROP_LOG), "utf8");
  assert.ok(!logText.includes("nfp_falsch"), "Token nie im Protokoll");
  assert.equal(readNetlifyToken({}), "");
  const f = path.join(bad.dir, "tok"); fs.writeFileSync(f, " nfp_aus_datei \n");
  assert.equal(readNetlifyToken({ JARVIS_REPAIR_NETLIFY_TOKEN_FILE: f }), "nfp_aus_datei");
  // Bestehende .env-Datei (KEY=value) als Token-Datei: nur NETLIFY_AUTH_TOKEN bzw. JARVIS_REPAIR_NETLIFY_TOKEN, nie ein anderer Schlüssel
  const e = path.join(bad.dir, ".env");
  fs.writeFileSync(e, "# Kommentar\r\nANDERES=geheim\r\nNETLIFY_AUTH_TOKEN=\"nfp_aus_env\"\r\n");
  assert.equal(readNetlifyToken({ JARVIS_REPAIR_NETLIFY_TOKEN_FILE: e }), "nfp_aus_env");
  fs.writeFileSync(e, "NETLIFY_AUTH_TOKEN=nfp_alt\nJARVIS_REPAIR_NETLIFY_TOKEN=nfp_vorrang\n");
  assert.equal(readNetlifyToken({ JARVIS_REPAIR_NETLIFY_TOKEN_FILE: e }), "nfp_vorrang");
  fs.writeFileSync(e, "ANDERES=geheim\n");
  assert.equal(readNetlifyToken({ JARVIS_REPAIR_NETLIFY_TOKEN_FILE: e }), "", "fremde Schlüssel werden nie als Token gelesen");
});
test("8 Falsche Site-ID (404) → site_not_found, keine Deploy-Aufrufe", async () => {
  const c = setup({ mapping: { netlify_site_id: "99999999-2222-4333-8444-555555555555" } });
  assert.equal((await c.adapter.checkAccess(c.order)).reason, "site_not_found");
  assert.equal(count(c.mock, "POST", /deploys/), 0);
});

// ---------- 3. Vollständige Dateierhaltung / 4. Vorschau ----------
test("3/4 Backup sichert alle Dateien (SHA-1 geprüft), Entwurf enthält ALLE Dateien, nur die geänderte wird hochgeladen, Vorschau geprüft", async () => {
  const c = setup();
  const { b } = await repaired(c);
  assert.match(b.rollback_point, /^netlify:[0-9a-f]{24}$/); assert.equal(b.production_ref, b.rollback_point);
  assert.match(b.source_url, /^http:\/\/[0-9a-f]{24}--praxis-test\.netlify\.app\/$/);
  const v = await c.adapter.validate(c.order);
  assert.equal(v.build_ok, true, JSON.stringify(v));
  const draftId = v.preview_url.match(/([0-9a-f]{24})--/)[1];
  const draft = c.mock.state.deploys.get(draftId);
  assert.equal(draft.draft, true, "nur Entwurf – nicht veröffentlicht");
  assert.deepEqual(Object.keys(draft.files).sort(), Object.keys(FILES).sort(), "vollständige Dateiliste");
  const orig = c.mock.state.deploys.get(c.mock.site.published_deploy.id).files;
  assert.equal(draft.files["/style.css"], orig["/style.css"]); assert.equal(draft.files["/logo.png"], orig["/logo.png"]);
  assert.notEqual(draft.files["/index.html"], orig["/index.html"]);
  assert.equal(count(c.mock, "PUT", /\/files\//), 1, "nur index.html hochgeladen");
  assert.notEqual(c.mock.site.published_deploy.id, draftId, "Produktion unverändert");
  const html = c.mock.filesOf(draftId)["/index.html"].toString("utf8");
  assert.match(html, /<span id="termin" aria-hidden="true"><\/span>\n<section id="booking">/);
  assert.match(html, /grid-template-columns:repeat\(auto-fit, minmax\(min\(100%, 260px\), 1fr\)\)/);
  assert.match(html, /getElementById\('footer-year'\)/);
  assert.equal(html.replace(/<span id="termin" aria-hidden="true"><\/span>\n/, "").replace("repeat(auto-fit, minmax(min(100%, 260px), 1fr))", "repeat(4,minmax(260px,1fr))").replace("footer-year')", "footer-yaer')"), BUGGY, "sonst nichts verändert");
});
test("3 Backup fail closed: Datei mit falschem SHA-1 → kein Backup", async () => {
  const c = setup();
  const pub = c.mock.state.deploys.get(c.mock.site.published_deploy.id);
  pub.files["/style.css"] = "0".repeat(40); // Dateiliste passt nicht zum Inhalt
  await assert.rejects(c.adapter.backup(c.order), /nicht vollständig gesichert/);
});

// ---------- 5. Kontrollierte Veröffentlichung / 10. Doppelte Anforderungen ----------
test("5/10 Veröffentlichung nur des geprüften Entwurfs; doppelte Validierung/Veröffentlichung → genau ein Entwurf, genau ein Restore", async () => {
  const c = setup();
  await repaired(c);
  const v1 = await c.adapter.validate(c.order), v2 = await c.adapter.validate(c.order);
  assert.equal(v1.preview_url, v2.preview_url);
  assert.equal(count(c.mock, "POST", /^\/sites\/[^/]+\/deploys$/), 1, "kein zweiter Entwurf");
  const d1 = await c.adapter.deployProduction(c.order), d2 = await c.adapter.deployProduction(c.order);
  assert.equal(d1.ok, true); assert.equal(d2.ok, true); assert.equal(d1.deploy_ref, d2.deploy_ref);
  assert.equal(count(c.mock, "POST", /\/restore$/), 1, "genau eine Veröffentlichung");
  assert.equal(`netlify:${c.mock.site.published_deploy.id}`, d1.deploy_ref);
  const log = fs.readFileSync(path.join(c.dir, NETLIFY_DROP_LOG), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const a of ["backup", "apply_fix", "draft_created", "draft_ready", "publish_requested", "published", "publish_already_live"]) assert.ok(log.some((e) => e.action === a), a);
  assert.ok(log.every((e) => e.at && !JSON.stringify(e).includes(GOOD_TOKEN)), "Zeitstempel, nie Token");
  assert.ok(log.find((e) => e.action === "published").deploy_id.match(/^[0-9a-f]{24}$/));
});
test("5 Veröffentlichung verweigert, wenn sich die Produktion seit dem Backup geändert hat bzw. kein geprüfter Entwurf existiert", async () => {
  const c = setup();
  await repaired(c);
  assert.equal((await c.adapter.deployProduction(c.order)).ok, false, "ohne Entwurf nie veröffentlichen");
  await c.adapter.validate(c.order);
  c.mock.publish(c.mock.addDeploy({ "/index.html": "<html>jemand anderes</html>" }));
  const d = await c.adapter.deployProduction(c.order);
  assert.equal(d.ok, false); assert.match(d.error, /Produktionsstand seit dem Backup verändert/);
  assert.equal(count(c.mock, "POST", /\/restore$/), 0);
});

// ---------- 6. Rollback ----------
test("6 Rollback: vor der Veröffentlichung nichts zu tun (Produktion unverändert); danach Rückkehr auf den Rollback-Punkt, bestätigt", async () => {
  const c = setup();
  const { b } = await repaired(c);
  await c.adapter.validate(c.order);
  assert.equal((await c.adapter.rollback(c.order)).ok, true);
  assert.equal(count(c.mock, "POST", /\/restore$/), 0, "kein unnötiger Restore");
  await c.adapter.deployProduction(c.order);
  assert.notEqual(`netlify:${c.mock.site.published_deploy.id}`, b.rollback_point);
  assert.equal((await c.adapter.rollback(c.order)).ok, true);
  assert.equal(`netlify:${c.mock.site.published_deploy.id}`, b.rollback_point);
});

// ---------- 9. Fehlende Deployment-Berechtigung ----------
test("9 Token ohne Deploy-Recht: Lesen klappt, Entwurf 403 → build_ok false (no_permission), Produktion unverändert", async () => {
  const c = setup({ token: READONLY_TOKEN });
  assert.equal((await c.adapter.checkAccess(c.order)).ok, true);
  await repaired(c);
  const pub = c.mock.site.published_deploy.id;
  const v = await c.adapter.validate(c.order);
  assert.deepEqual(v, { build_ok: false, error: "no_permission" });
  assert.equal((await c.adapter.deployProduction(c.order)).ok, false);
  assert.equal(c.mock.site.published_deploy.id, pub);
});

// ---------- Quell-Deploy + Bindung ----------
test("Quell-Deploy aus der Auftragsbindung: früherer Deploy derselben Site wird repariert, Rollback-Punkt bleibt der veröffentlichte Stand", async () => {
  const c = setup();
  const source = c.mock.site.published_deploy.id;
  const live = c.mock.addDeploy({ "/index.html": "<html>andere Fassung</html>", "/style.css": "x", "/logo.png": PNG });
  c.mock.publish(live);
  c.order = { ...c.order, test_order: true, environment: "TEST", deploy_binding: { domain: DOMAIN, netlify_site_id: c.mock.siteId, deploy_target: "production", source_deploy_id: source, test_recipient: MAILBOX } };
  const b = await c.adapter.backup(c.order);
  assert.equal(b.rollback_point, `netlify:${live}`);
  assert.ok(b.source_url.startsWith(`http://${source}--`));
  // Quell-Deploy einer fremden Site → abgelehnt
  const other = setup({ mockOpts: { siteId: "22222222-2222-4333-8444-555555555555" } });
  const foreignDeploy = other.mock.site.published_deploy.id;
  c.mock.state.deploys.set(foreignDeploy, { ...other.mock.state.deploys.get(foreignDeploy) });
  await assert.rejects(c.adapter.backup({ ...c.order, deploy_binding: { ...c.order.deploy_binding, source_deploy_id: foreignDeploy } }), /gehört nicht zu dieser Site/);
});
test("Bindung: TEST ohne Bindung, falsche Site, falsche Domain, falsches Ziel, falscher Empfänger → kein Zugang", async () => {
  const c = setup();
  const m = { netlify_site_id: c.mock.siteId };
  const b = { domain: DOMAIN, netlify_site_id: c.mock.siteId, deploy_target: "production", source_deploy_id: null, test_recipient: MAILBOX };
  const t = { ...c.order, test_order: true, environment: "TEST" };
  assert.equal(bindingProblem(t, m), "test_order_without_binding");
  assert.equal(bindingProblem({ ...t, deploy_binding: b }, m), null);
  assert.equal(bindingProblem({ ...t, deploy_binding: { ...b, netlify_site_id: "99999999-2222-4333-8444-555555555555" } }, m), "binding_site_mismatch");
  assert.equal(bindingProblem({ ...t, deploy_binding: { ...b, domain: "andere.ch" } }, m), "binding_domain_mismatch");
  assert.equal(bindingProblem({ ...t, deploy_binding: { ...b, deploy_target: "branch" } }, m), "binding_target_invalid");
  assert.equal(bindingProblem({ ...t, deploy_binding: { ...b, test_recipient: "fremd@example.ch" } }, m), "binding_recipient_mismatch");
  assert.equal((await c.adapter.checkAccess(t)).reason, "test_order_without_binding");
  assert.equal(bindingProblem(c.order, null), "no_mapping");
});

// ---------- Generische Quelltext-Fixes (Negativfälle) ----------
test("Fixes: nur eindeutige Ursachen – mehrdeutige Sprungmarke, zwei ähnliche ids, mehrfaches Raster, fehlende Datei → null", () => {
  assert.deepEqual(anchorCandidates("kontakt", ["contact", "hero"]), ["contact"]);
  assert.deepEqual(anchorCandidates("kontakt", ["contact", "kontakte"]).length, 2);
  assert.deepEqual(idTypoCandidates("current-yaer", ["current-year", "hero"]), ["current-year"]);
  const amb = new Map([["/index.html", `<a href="#kontakt">K</a><section id="contact"></section><div id="kontakte"></div>`]]);
  assert.equal(locateStaticFix({ type: "broken_anchor", page_path: "/", anchor: "kontakt" }, amb), null, "zwei Kandidaten → nie raten");
  const none = new Map([["/index.html", `<a href="#preise">P</a><section id="team"></section>`]]);
  assert.equal(locateStaticFix({ type: "broken_anchor", page_path: "/", anchor: "preise" }, none), null, "kein Kandidat");
  const two = new Map([["/index.html", `<span id="year1"></span><span id="year2"></span><script>document.getElementById('yearX').textContent=1</script>`]]);
  assert.equal(locateStaticFix({ type: "js_runtime_error", page_path: "/", missing_ids: ["yearX"] }, two), null, "zwei ähnliche ids");
  const dup = new Map([["/index.html", `<div class="grid grid-cols-[repeat(5,minmax(240px,1fr))]"></div><div class="grid grid-cols-[repeat(5,minmax(240px,1fr))]"></div>`]]);
  assert.equal(locateStaticFix({ type: "content_clipped", page_path: "/", element: { tag: "div", class: "grid grid-cols-[repeat(5,minmax(240px,1fr))]" } }, dup), null, "Element nicht eindeutig");
  assert.equal(locateStaticFix({ type: "broken_anchor", page_path: "/fehlt/", anchor: "kontakt" }, amb), null, "Seite nicht im Stand");
  assert.equal(locateStaticFix({ type: "broken_link", page_path: "/" }, amb), null, "fremder Typ");
});
test("Fixes: Tailwind-Klasse, Inline-Style, Synonym-Sprungmarke – genau eine Stelle geändert", () => {
  const tw = `<section class="overflow-hidden"><div class="grid grid-cols-[repeat(5,minmax(240px,1fr))] gap-6"></div></section>`;
  const l1 = locateStaticFix({ type: "content_clipped", page_path: "/", element: { tag: "div", class: "grid grid-cols-[repeat(5,minmax(240px,1fr))] gap-6" } }, new Map([["/index.html", tw]]));
  assert.equal(applyStaticFix(l1.fix, tw), `<section class="overflow-hidden"><div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-6"></div></section>`);
  const il = `<div id="g" style="display:grid;grid-template-columns:repeat(3, 300px)"></div>`;
  const l2 = locateStaticFix({ type: "content_clipped", page_path: "/", element: { tag: "div", id: "g" } }, new Map([["/index.html", il]]));
  assert.equal(applyStaticFix(l2.fix, il), `<div id="g" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(min(100%, 300px), 1fr))"></div>`);
  const an = `<a href="#kontakt">Termin</a>\n  <section id="contact">x</section>`;
  const l3 = locateStaticFix({ type: "broken_anchor", page_path: "/", anchor: "kontakt" }, new Map([["/index.html", an]]));
  assert.equal(applyStaticFix(l3.fix, an), `<a href="#kontakt">Termin</a>\n  <span id="kontakt" aria-hidden="true"></span>\n  <section id="contact">x</section>`);
  assert.equal(applyStaticFix(l3.fix, applyStaticFix(l3.fix, an)), null, "zweimal anwenden → null (idempotent, nie doppelt)");
});

// ---------- 14. TEST/LIVE-Isolation ----------
test("14 Interner Testauftrag nur mit Testfreigabe (Domain + Empfänger), mit Bindung, ohne Verkauf/Provision; LIVE-Auftrag bekommt nie einen Erlass", async () => {
  const dir = tmp(), store = createStore(dir);
  const site = "11111111-2222-4333-8444-555555555555";
  assert.throws(() => createInternalTestRepairOrder(store, { domain: DOMAIN, delivery_email: MAILBOX, netlify_site_id: site, e2e: e2eConfig({}) }), /TEST_BLOCKED/);
  assert.throws(() => createInternalTestRepairOrder(store, { domain: "kunde.ch", delivery_email: MAILBOX, netlify_site_id: site, e2e: E2E }), /TEST_BLOCKED/);
  assert.throws(() => createInternalTestRepairOrder(store, { domain: DOMAIN, delivery_email: "kunde@kunde.ch", netlify_site_id: site, e2e: E2E }), /TEST_BLOCKED/);
  const o = createInternalTestRepairOrder(store, { domain: DOMAIN, delivery_email: MAILBOX, netlify_site_id: site, source_deploy_id: "a".repeat(24), e2e: E2E });
  assert.equal(o.environment, "TEST"); assert.equal(o.test_order, true); assert.equal(o.test_kind, INTERNAL_TEST_KIND); assert.equal(o.commission_rate_bps, 0);
  assert.match(o.test_run_id, /^e2e-[0-9a-f]{12}$/);
  assert.deepEqual(o.deploy_binding, { domain: DOMAIN, netlify_site_id: site, deploy_target: "production", source_deploy_id: "a".repeat(24), test_recipient: MAILBOX, bound_at: o.deploy_binding.bound_at });
  assert.equal(Object.keys(store.read("sales.json", { records: {} }).records || {}).length, 0, "kein Verkauf, kein Umsatz");
  assert.equal(internalTestWaiverOk(o, E2E), true);
  assert.equal(internalTestWaiverOk(o, e2eConfig({})), false, "Testfreigabe aus → kein Erlass");
  assert.equal(internalTestWaiverOk({ ...o, delivery_email: "fremd@example.ch" }, E2E), false);
  // LIVE-Auftrag mit (unzulässig) gesetzten Testfeldern: nie ein Erlass, wartet auf Zahlung
  const live = createRepairOrder(store, { domain: "kunde-live.ch", delivery_email: "kunde@kunde-live.ch" });
  const forged = { ...live, test_kind: INTERNAL_TEST_KIND, payment_waiver: o.payment_waiver, deploy_binding: { ...o.deploy_binding, domain: "kunde-live.ch" } };
  assert.equal(isTestOrder(forged), false); assert.equal(internalTestWaiverOk(forged, e2eConfig({ JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "kunde-live.ch", JARVIS_E2E_TEST_MAILBOXES: "kunde@kunde-live.ch" })), false);
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} }); data.orders[live.order_id] = forged; store.write(REPAIR_ORDERS_FILE, data);
  authorizeRepair(store, live.order_id, { authorized_domain: "kunde-live.ch", source: "written_confirmation" });
  let adapterCalls = 0;
  const spy = { checkAccess: async () => { adapterCalls++; return { ok: true }; } };
  const eng = createRepairEngine({ dir, store, adapters: { static: spy, netlify_drop: spy }, auditor: { audit: async () => ({ reachable: true, issues: [], pages: { home: "<html></html>" } }) }, e2e: E2E });
  const clean = createRepairOrder(store, { domain: "kunde-zwei.ch", delivery_email: "kunde@kunde-zwei.ch" });
  authorizeRepair(store, clean.order_id, { authorized_domain: "kunde-zwei.ch", source: "written_confirmation" });
  await eng.processAll();
  const orders = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders;
  assert.equal(orders[live.order_id].state, "MANUAL_REVIEW_REQUIRED", "LIVE-Auftrag mit untergeschobenen Testfeldern → gesperrt");
  assert.match(orders[live.order_id].blocked_reason, /TEST_ACCESS_BLOCKED/);
  assert.equal(orders[clean.order_id].state, "PAYMENT_REQUIRED", "normaler LIVE-Auftrag ohne Zahlung bleibt stehen");
  assert.equal(adapterCalls, 0, "kein Zugriff ohne Zahlung");
});
test("14 Interner Testauftrag: Testfreigabe zur Laufzeit entzogen → TEST_ACCESS_BLOCKED, kein Adapter-Aufruf", async () => {
  const dir = tmp(), store = createStore(dir);
  const o = createInternalTestRepairOrder(store, { domain: DOMAIN, delivery_email: MAILBOX, netlify_site_id: "11111111-2222-4333-8444-555555555555", e2e: E2E });
  authorizeRepair(store, o.order_id, { authorized_domain: DOMAIN, source: "written_confirmation" });
  let calls = 0;
  const spy = { claims: async () => true, checkAccess: async () => { calls++; return { ok: true }; } };
  const eng = createRepairEngine({ dir, store, adapters: { netlify_drop: spy }, e2e: e2eConfig({ JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "andere.ch", JARVIS_E2E_TEST_MAILBOXES: MAILBOX }) });
  await eng.processAll();
  const after = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(after.state, "MANUAL_REVIEW_REQUIRED"); assert.match(after.blocked_reason, /TEST_ACCESS_BLOCKED/);
  assert.equal(calls, 0);
});
