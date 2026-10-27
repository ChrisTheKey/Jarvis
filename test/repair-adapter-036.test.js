// GITHUB+NETLIFY REPAIR-ADAPTER + ECHTER RENDERTEST + DASHBOARD (036): explizites Domain→Repo→Netlify-Mapping (nie raten),
// Credentials nur aus Env (nie gespeichert/geloggt), Repair-Branch + Preview vor Production, Playwright-Retest 1440×900/390×844,
// Regression-Gate, Live-Retest, Rollback über Netlify-Restore, Allowlist-Dashboard. Kein Netzwerk, keine Mail, kein echter Kunde.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, publicRepairOrders, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { githubNetlifyAdapter, setRepairMapping, loadRepairMappings, uniqueReplacement, uniqueImageReplacement, replaceRefs,
  REPAIR_MAPPINGS_FILE, GITHUB_TOKEN_ENV, NETLIFY_TOKEN_ENV } from "../repair-adapters/github-netlify.js";
import { createRenderRetester, checkViewport, VIEWPORTS, RENDER_METHOD } from "../repair-render-test.js";
import { cleanRepair } from "../server-control.js";
import { recordPayment } from "../payments.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T08:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-repair36-"));
const HOME = "https://muster.ch/";
const SITE_ID = "0123456789abcdef0123";
const GH_TOKEN = "ghp_FAKE_NUR_TEST_1234567890";
const NF_TOKEN = "nfp_FAKE_NUR_TEST_0987654321";
const ENV = { [GITHUB_TOKEN_ENV]: GH_TOKEN, [NETLIFY_TOKEN_ENV]: NF_TOKEN };

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const INDEX_HTML = '<html><body><a href="/team-alt">Unser Team</a><a href="/kontakt.html">Kontakt</a></body></html>';

// Mock-Fetch: Router über URL+Methode, zeichnet jeden Aufruf auf. state.repaired wird vom PUT (Commit) gesetzt.
function mkFetch(state = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url });
    const reply = (status, json) => ({ status, json: async () => json });
    if (url.includes("/repos/chris/muster-website/git/ref/heads/main")) return reply(200, { object: { sha: "aaa111" } });
    if (url.endsWith("/repos/chris/muster-website") ) return reply(200, { permissions: { push: state.push !== false } });
    if (url.includes("/git/refs") && method === "POST") return reply(state.branchExists ? 422 : 201, {});
    if (url.includes("/git/ref/heads/repair")) return reply(200, { object: { sha: "aaa111" } });
    if (url.includes("/git/trees/aaa111")) return reply(200, { truncated: false, tree: [
      { path: "index.html", type: "blob" }, { path: "team.html", type: "blob" }, { path: "kontakt.html", type: "blob" }, { path: "img/logo.png", type: "blob" }] });
    if (url.includes("/search/code")) return reply(200, { items: [{ path: "index.html" }] });
    if (url.includes("/contents/index.html") && method === "GET") return reply(200, { sha: "f1", content: b64(state.repaired ? INDEX_HTML.replace("/team-alt", "/team.html") : INDEX_HTML) });
    if (url.includes("/contents/index.html") && method === "PUT") { state.repaired = true; return reply(200, { commit: { sha: "ccc333" } }); }
    if (url.includes("/merges") && method === "POST") { state.merged = true; return reply(state.mergeFails ? 409 : 201, {}); }
    if (url.includes(`/sites/${SITE_ID}/deploys?branch=repair`)) return reply(200, state.previewFails
      ? [{ state: "error" }] : [{ state: "ready", deploy_ssl_url: "https://repair--muster.netlify.app", created_at: "2026-10-12T09:00:00Z" }]);
    if (url.includes(`/sites/${SITE_ID}/deploys?branch=main`)) return reply(200, [{ id: "dep1", state: "ready", created_at: "2026-10-12T09:30:00Z" }]);
    if (url.includes(`/sites/${SITE_ID}/deploys/dep0/restore`)) { state.rolledBack = true; return reply(200, {}); }
    if (url.includes(`/sites/${SITE_ID}`)) return reply(200, { custom_domain: state.siteDomain ?? "muster.ch", domain_aliases: [], published_deploy: { id: "dep0" }, ssl_url: `https://${state.siteDomain ?? "muster.ch"}` });
    return reply(404, {});
  };
  return { fetchFn, calls, state };
}

const mkAdapter = (store, { env = ENV, state = {}, over = {} } = {}) => {
  const f = mkFetch(state);
  return { adapter: githubNetlifyAdapter({ store, env, fetchFn: f.fetchFn, sleep: async () => {}, pollMs: 0, buildTimeoutMs: 500, now: () => T0, ...over }), ...f };
};
const mapMuster = (store) => setRepairMapping(store, "muster.ch", { repo: "chris/muster-website", production_branch: "main", netlify_site_id: SITE_ID });
const ORDER = { order_id: "RF480-20261012-abc123", domain: "muster.ch", website: HOME, backup: { production_ref: "aaa111", rollback_point: "netlify:dep0", branch: "repair/RF480-20261012-abc123" } };

test("Mapping: explizit, validiert, ohne Secrets; kein Mapping → kein Zugang (nichts wird erraten)", async () => {
  const store = createStore(tmp());
  const { adapter } = mkAdapter(store);
  assert.deepEqual(await adapter.checkAccess({ domain: "muster.ch" }), { ok: false, reason: "no_mapping" });
  assert.equal(await adapter.claims({ domain: "muster.ch" }), false);
  assert.throws(() => setRepairMapping(store, "muster.ch", { repo: "kein-slash", netlify_site_id: SITE_ID }), /owner\/name/);
  mapMuster(store);
  assert.equal(await adapter.claims({ domain: "muster.ch" }), true);
  const raw = JSON.stringify(store.read(REPAIR_MAPPINGS_FILE, {}));
  assert.ok(!raw.includes(GH_TOKEN) && !raw.includes(NF_TOKEN)); // Mapping-Datei enthält nie Tokens
  assert.ok(loadRepairMappings(store)["muster.ch"].repo === "chris/muster-website");
});

test("Zugang: fehlende Tokens, fehlendes Push-Recht, falsche Site-Domain → kein Zugang; sonst ok ohne Token im Ergebnis", async () => {
  const store = createStore(tmp());
  mapMuster(store);
  const noTok = mkAdapter(store, { env: {} });
  assert.deepEqual(await noTok.adapter.checkAccess(ORDER), { ok: false, reason: "no_token" });
  const noPush = mkAdapter(store, { state: { push: false } });
  assert.deepEqual(await noPush.adapter.checkAccess(ORDER), { ok: false, reason: "github_no_push" });
  const wrongSite = mkAdapter(store, { state: { siteDomain: "andere-firma.ch" } });
  assert.deepEqual(await wrongSite.adapter.checkAccess(ORDER), { ok: false, reason: "site_domain_mismatch" });
  const ok = mkAdapter(store);
  const r = await ok.adapter.checkAccess(ORDER);
  assert.deepEqual(r, { ok: true, connector: "github+netlify:chris/muster-website" });
  assert.ok(!JSON.stringify(r).includes(GH_TOKEN));
});

test("Backup: Production-Commit + Repair-Branch + Netlify-Rollback-Punkt; vorhandener Branch (Neustart) wird akzeptiert", async () => {
  const store = createStore(tmp());
  mapMuster(store);
  const { adapter, calls } = mkAdapter(store);
  const b = await adapter.backup(ORDER, { branch: "repair/RF480-20261012-abc123" });
  assert.deepEqual(b, { production_ref: "aaa111", backup_ref: "git:aaa111", rollback_point: "netlify:dep0", branch: "repair/RF480-20261012-abc123" });
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/git/refs")));
  const again = mkAdapter(store, { state: { branchExists: true } });
  assert.equal((await again.adapter.backup(ORDER, { branch: "repair/RF480-20261012-abc123" })).production_ref, "aaa111");
});

test("Eindeutigkeit: genau ein Ersatzziel, sonst null; replaceRefs ersetzt nur den kaputten Verweis", () => {
  assert.equal(uniqueReplacement("/team-alt", ["index.html", "team.html", "img/logo.png"]), "/team.html");
  assert.equal(uniqueReplacement("/team-alt", ["team.html", "unterseiten/team.html"]), null); // zwei Kandidaten → nicht eindeutig
  assert.equal(uniqueReplacement("/gibt-es-nicht", ["index.html"]), null);
  assert.equal(uniqueImageReplacement("/img/team.jpg", ["bilder/team.jpg", "index.html"]), "/bilder/team.jpg");
  assert.equal(uniqueImageReplacement("/img/team.jpg", ["bilder/team.jpg", "alt/team.jpg"]), null);
  const out = replaceRefs(INDEX_HTML, { fullUrl: "https://muster.ch/team-alt", brokenPath: "/team-alt", replacement: "/team.html" });
  assert.ok(out.includes('href="/team.html"') && !out.includes("/team-alt") && out.includes("/kontakt.html"));
});

test("locate: eindeutige Ursache → Fix-Details; applyFix committet NUR im Repair-Branch", async () => {
  const store = createStore(tmp());
  mapMuster(store);
  const { adapter, calls } = mkAdapter(store);
  const issue = { type: "broken_link", url: "https://muster.ch/team-alt" };
  const loc = await adapter.locate(issue, ORDER);
  assert.equal(loc.target, "index.html");
  assert.deepEqual(loc.fix, { files: ["index.html"], fullUrl: "https://muster.ch/team-alt", brokenPath: "/team-alt", replacement: "/team.html" });
  assert.match(loc.planned_change, /\/team-alt → \/team\.html/);
  const r = await adapter.applyFix({ issue_id: "I1", fix: loc.fix, planned_change: loc.planned_change }, ORDER);
  assert.deepEqual(r, { ok: true, change_ref: "git:ccc333" });
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put && !put.url.includes("main")); // Commit geht in den Branch (Body), nie direkt auf main-URL
  assert.equal(await adapter.locate({ type: "slow_response", url: HOME }, ORDER), null); // nicht unterstützter Typ → nie raten
});

test("Preview: ready → preview_url; Build-Fehler → build_ok false; Production-Merge erst bei deployProduction", async () => {
  const store = createStore(tmp());
  mapMuster(store);
  const okA = mkAdapter(store);
  const order = { ...ORDER, plan: [{ issue_id: "I1" }] };
  const v = await okA.adapter.validate(order);
  assert.deepEqual(v, { build_ok: true, preview_url: "https://repair--muster.netlify.app" });
  assert.ok(!okA.calls.some((c) => c.url.includes("/merges"))); // Preview verändert Production nie
  const bad = mkAdapter(store, { state: { previewFails: true } });
  assert.equal((await bad.adapter.validate(order)).build_ok, false);
  const d = await okA.adapter.deployProduction(order);
  assert.deepEqual(d, { ok: true, deploy_ref: "netlify:dep1" });
  assert.ok(okA.state.merged);
  const conflict = mkAdapter(store, { state: { mergeFails: true } });
  assert.equal((await conflict.adapter.deployProduction(order)).ok, false);
});

test("Rollback: Netlify-Restore auf den Deploy vor der Reparatur", async () => {
  const store = createStore(tmp());
  mapMuster(store);
  const { adapter, state } = mkAdapter(store);
  assert.deepEqual(await adapter.rollback(ORDER), { ok: true });
  assert.ok(state.rolledBack);
  assert.equal((await adapter.rollback({ ...ORDER, backup: null })).ok, false);
});

// ---------- Echter Rendertest (Playwright-Schnittstelle, hier mit Browser-Attrappe) ----------
function fakePage({ failMobile = false, status = 200 } = {}) {
  const viewports = [];
  let current = null;
  return {
    viewports,
    setViewportSize: async (v) => { viewports.push(v); current = v; },
    goto: async () => ({ status: () => status }),
    evaluate: async () => (failMobile && current?.width === 390
      ? { problems: ["Horizontaler Overflow (450px Inhalt bei 390px Breite)"], info: { links: 5, buttons: 1, images_visible: 2, contact_found: true } }
      : { problems: [], info: { links: 5, buttons: 1, images_visible: 2, contact_found: true } }),
  };
}
const fakeBrowser = (page) => async () => ({ newPage: async () => page, close: async () => {} });

test("Rendertest: Desktop 1440×900 + Smartphone 390×844, beide Viewports geprüft; Mobile-Problem → nicht bestanden", async () => {
  assert.deepEqual([VIEWPORTS.desktop.width, VIEWPORTS.desktop.height, VIEWPORTS.mobile.width, VIEWPORTS.mobile.height], [1440, 900, 390, 844]);
  const page = fakePage();
  const retest = createRenderRetester({ browserFactory: fakeBrowser(page) });
  const r = await retest(HOME);
  assert.equal(r.ok, true);
  assert.equal(r.method, RENDER_METHOD);
  assert.deepEqual(page.viewports, [{ width: 1440, height: 900 }, { width: 390, height: 844 }]);
  assert.deepEqual([r.desktop.viewport, r.mobile.viewport], ["Desktop 1440×900", "Smartphone 390×844"]);
  const bad = await createRenderRetester({ browserFactory: fakeBrowser(fakePage({ failMobile: true })) })(HOME);
  assert.deepEqual([bad.ok, bad.desktop.ok, bad.mobile.ok], [false, true, false]);
  assert.match(bad.mobile.problems[0], /Overflow/);
  const err = await checkViewport(fakePage({ status: 500 }), HOME, VIEWPORTS.desktop);
  assert.equal(err.ok, false);
});

// ---------- End-to-End: Engine + echter Adapter (Mock-Fetch) + Rendertest – komplette Kette bis READY_FOR_DELIVERY ----------
function e2e({ failMobile = false, state = {} } = {}) {
  const dir = tmp();
  const store = createStore(dir);
  mapMuster(store);
  const o = createRepairOrder(store, { domain: "muster.ch", website: HOME, company: "Muster AG", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_order_form", reference: "Bestellung 2026-10-12", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, now: T0 }); // Zahlungsschwelle CHF 240 (TF-041)
  const f = mkFetch(state);
  const adapter = githubNetlifyAdapter({ store, env: ENV, fetchFn: f.fetchFn, sleep: async () => {}, pollMs: 0, buildTimeoutMs: 500, now: () => T0 });
  const issue = { type: "broken_link", url: "https://muster.ch/team-alt", page: HOME, label: "Unser Team",
    evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity: "medium", detectedAt: T0.toISOString() };
  const auditor = { audit: async (website) => ({ website, host: "muster.ch", reachable: true, finalUrl: website, title: "Muster AG",
    issues: f.state.repaired ? [] : [issue], pages: { home: "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" }, requests: 2 }) };
  const retester = createRenderRetester({ browserFactory: fakeBrowser(fakePage({ failMobile })) });
  const engine = createRepairEngine({ store, adapters: { github_netlify: adapter }, auditor, retester, now: () => T0 });
  return { dir, store, order_id: o.order_id, engine, f };
}
const read = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];

test("E2E: statisch gerenderte Site mit explizitem Mapping → github_netlify; Branch→Fix→Preview→Rendertests→Merge→Live-Retest→READY", async () => {
  const { store, order_id, engine, f } = e2e();
  await engine.processAll();
  const saved = read(store, order_id);
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.deepEqual(saved.stack, { type: "github_netlify", evidence: ["explicit_mapping"] });
  assert.equal(saved.backup.rollback_point, "netlify:dep0");
  assert.equal(saved.plan[0].fix.replacement, "/team.html");
  assert.equal(saved.validation.preview_url, "https://repair--muster.netlify.app");
  assert.match(saved.retest.desktop.method, /1440×900/);
  assert.match(saved.retest.mobile.method, /390×844/);
  assert.deepEqual([saved.retest.desktop.ok, saved.retest.mobile.ok], [true, true]);
  assert.deepEqual(saved.deployment, { deployed: true, deploy_ref: "netlify:dep1", at: T0.toISOString(), live_retest_ok: true });
  // Reihenfolge: Commit (PUT) → Preview-Deploys gepollt → erst DANACH der Merge nach main.
  const idx = (p) => f.calls.findIndex((c) => (c.method + " " + c.url).includes(p));
  assert.ok(idx("PUT https") < f.calls.findIndex((c) => c.url.includes("deploys?branch=repair")));
  assert.ok(f.calls.findIndex((c) => c.url.includes("deploys?branch=repair")) < idx("/merges"));
  // Keine Tokens/Secrets im persistierten Auftrag.
  const raw = JSON.stringify(saved);
  assert.ok(!raw.includes(GH_TOKEN) && !raw.includes(NF_TOKEN));
  // Kundenbericht: verständlich, ohne interne IDs, Git-SHAs, Dateipfade, Preview-URLs.
  const body = saved.report.body;
  assert.ok(body.startsWith("Webseiten-Check – Abschlussbericht"));
  for (const verboten of [order_id, "git:", "ccc333", "aaa111", "index.html", "netlify.app", "repair/", GH_TOKEN]) assert.ok(!body.includes(verboten), `Bericht enthält "${verboten}"`);
  assert.ok(body.includes("Smartphone") && body.includes("Desktop") && body.includes("live"));
});

test("E2E: Mobile-Rendertest schlägt fehl → VALIDATION_FAILED, Production bleibt unverändert", async () => {
  const { store, order_id, engine, f } = e2e({ failMobile: true });
  await engine.processAll();
  const saved = read(store, order_id);
  assert.equal(saved.state, "VALIDATION_FAILED");
  assert.equal(saved.retest.mobile.ok, false);
  assert.ok(!f.state.merged, "Merge nach main darf nie passieren, wenn der Retest scheitert");
});

test("Dashboard: publicRepairOrders + cleanRepair sind Allowlists ohne Branches/Preview-URLs/Referenzen", async () => {
  const { dir, store, order_id, engine } = e2e();
  await engine.processAll();
  const pub = publicRepairOrders(dir);
  assert.equal(pub.orders.length, 1);
  const o = pub.orders[0];
  assert.deepEqual([o.state, o.findings, o.repaired, o.backup_ok, o.desktop_retest, o.mobile_retest, o.production, o.report_available],
    ["READY_FOR_DELIVERY", 1, 1, true, true, true, "DEPLOYED", true]);
  const raw = JSON.stringify(pub);
  for (const verboten of ["netlify.app", "repair/", "git:", "aaa111", "dep0", GH_TOKEN, "evidence", "preview"]) assert.ok(!raw.includes(verboten), `Dashboard-Sicht enthält "${verboten}"`);
  // Cloud erzwingt die Whitelist erneut: unbekannte/gefährliche Felder fallen weg.
  const cleaned = cleanRepair({ ...pub, secret_token: "x", orders: [{ ...o, branch: "repair/geheim", preview_url: "https://x", token: "y" }] });
  const craw = JSON.stringify(cleaned);
  assert.ok(!craw.includes("geheim") && !craw.includes("preview_url") && !craw.includes("secret_token"));
  assert.equal(cleaned.orders[0].state, "READY_FOR_DELIVERY");
  assert.equal(read(store, order_id).state, "READY_FOR_DELIVERY");
});

test("HUD: Repair-Kachel vorhanden, reine Anzeige (keine Repair-Aktionen aus dem Browser), Snapshot-Verdrahtung vorhanden", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.ok(html.includes('id="repairPanel"') && html.includes("Reparaturaufträge") && html.includes("renderRepair"));
  const panel = html.slice(html.indexOf('id="repairPanel"'), html.indexOf("</section>", html.indexOf('id="repairPanel"')));
  assert.ok(!/data-action/.test(panel), "Repair-Panel darf keine Server-Control-Aktionen enthalten");
  assert.ok(fs.readFileSync(path.join(ROOT, "server-agent.js"), "utf8").includes("o.repair"));
  assert.ok(fs.readFileSync(path.join(ROOT, "mail-worker.js"), "utf8").includes("publicRepairOrders"));
});

test("Repair-Module können keine Mail senden: kein Gmail-Import, kein Send-Aufruf", () => {
  for (const f of [path.join("repair-adapters", "github-netlify.js"), "repair-render-test.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/gmail|sendDraft|messages\.send|smtp/i.test(src), `${f} enthält Mail-/Send-Verweise`);
  }
  // TF-041: repair-workflow.js sendet nur über das injizierte gmail-Objekt (kein statischer Gmail-Import, keine SMTP-/messages.send-Wege).
  // TF-046: genau ZWEI Send-Aufrufe – der One-Time-Link-Helfer (Zugangs-Anfrage/Host-Key) und die Kundenlieferung (deliver,
  // CUSTOMER_ORDER_FULFILLMENT, nur aus READY_FOR_DELIVERY mit bestandenem Abschluss-Gate). Nie in einem Arbeits-/Reparaturschritt.
  const src = fs.readFileSync(path.join(ROOT, "repair-workflow.js"), "utf8");
  assert.ok(!/^import .*gmail/im.test(src) && !/messages\.send|smtp/i.test(src), "kein statischer Gmail-Import, keine Direkt-Sendewege");
  assert.equal(src.match(/gmail\.sendDraft\(/g)?.length, 2, "genau zwei Send-Aufrufe (One-Time-Link-Helfer + Kundenlieferung)");
  const deliverAt = src.indexOf("async function deliver(order, t)"), deliverSend = src.indexOf("gmail.sendDraft(", deliverAt);
  assert.ok(deliverAt > 0 && deliverSend > deliverAt && deliverSend < src.indexOf("async function step("), "zweiter Send nur im Helfer deliver");
  assert.ok(src.slice(deliverAt, deliverSend).includes("messageClass: FULFILLMENT_CLASS") && src.slice(deliverAt, deliverSend).includes("completionGate(order)"), "Lieferung nur als CUSTOMER_ORDER_FULFILLMENT nach Abschluss-Gate");
  assert.deepEqual([...src.matchAll(/return deliver\(order, t\)/g)].length, 1);
  assert.ok(/if \(order\.state === "READY_FOR_DELIVERY" && autoDeliver\) return deliver\(order, t\);/.test(src), "deliver nur aus READY_FOR_DELIVERY");
  // TF-043: der einzige Send-Aufruf liegt im Helfer sendLinkMail; genutzt NUR für die Zugangs-Anfrage (ACCESS_REQUESTED) und die
  // Host-Key-Bestätigung (HOST_KEY_CONFIRMATION_REQUIRED) – beide mit One-Time-Link, nie in einem Arbeits-/Reparaturschritt.
  const sendAt = src.indexOf("gmail.sendDraft(");
  assert.ok(sendAt > src.indexOf("const sendLinkMail = async") && sendAt < src.indexOf("async function step("), "Send nur im Helfer sendLinkMail");
  const uses = [...src.matchAll(/await sendLinkMail\(order, "(\w+)"/g)].map((m) => m[1]);
  // TF-071: zusätzlich die Plattform-Frage (ohne Link, CUSTOMER_ONBOARDING_DIALOGUE) – nur im Helfer platformStep, den NUR ACCESS_REQUESTED aufruft.
  assert.deepEqual(uses, ["access_request", "host_key_request"]);
  const callers = [...src.matchAll(/await platformStep\(order, t\)/g)].map((m) => [...src.slice(0, m.index).matchAll(/if \(order\.state === "(\w+)"\)/g)].at(-1)[1]);
  assert.deepEqual(callers, ["ACCESS_REQUESTED"], "platformStep nur aus ACCESS_REQUESTED");
  for (const [field, state] of [["access_request", "ACCESS_REQUESTED"], ["host_key_request", "HOST_KEY_CONFIRMATION_REQUIRED"]]) {
    const at = src.indexOf(`await sendLinkMail(order, "${field}"`);
    const steps = [...src.slice(0, at).matchAll(/if \(order\.state === "(\w+)"\)/g)];
    assert.equal(steps.at(-1)[1], state, `${field} nur im Schritt ${state}`);
  }
});

test("Dockerfile kopiert Adapter + Rendertest", () => {
  const docker = fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile"), "utf8");
  assert.ok(docker.includes("repair-render-test.js") && docker.includes("repair-adapters"));
});
