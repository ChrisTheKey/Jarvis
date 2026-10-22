// TF-JARVIS-PRAXIS-002: Browser-Audit mit echtem Chromium – fehlerhafte Sprungmarken, abgeschnittene Responsive-Elemente, Laufzeitfehler
// (Positiv- UND Negativfälle gegen falsche Positivmeldungen) und ein vollständiger Engine-Lauf: interner Testauftrag → Backup des
// gebundenen Quell-Deploys → Browser-Audit → Plan → Reparatur → Netlify-Entwurf → Browser-Gate → Veröffentlichung → Live-Retest →
// Bericht → Outbox → Mail-Worker (genau EINE Mail, Deduplizierung). Netlify = Attrappe + lokaler Proxy; keine echte Website, keine Mail.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { createBrowserSiteAuditor, browserFindingsFrom } from "../browser-site-audit.js";
import { createBrowserValidator, chromiumLauncher, browserRuntimeStatus } from "../repair-browser-validator.js";
import { netlifyDropAdapter, setDropMapping, NETLIFY_DROP_LOG } from "../repair-adapters/netlify-drop.js";
import { createInternalTestRepairOrder, authorizeRepair, createRepairEngine, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { createOutboxMailer, processRepairOutbox } from "../repair-outbox.js";
import { e2eConfig } from "../e2e-test.js";
import { createNetlifyMock, GOOD_TOKEN } from "./netlify-mock.js";

const HAS_BROWSER = browserRuntimeStatus().status === "ACTIVE";
const skip = HAS_BROWSER ? false : "Chromium nicht verfügbar";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bap-"));
const servers = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); });
// Lokale Testseiten: Pfad → HTML (zwei Hostnamen: 127.0.0.1 = eigene Website, localhost = «fremder» Host für Fremd-Skripte).
function serve(pages) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const p = req.url.split("?")[0];
      if (p === "/third-party.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end("null.boom = 1;"); }
      const html = pages[p];
      if (!html) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html.replace(/__PORT__/g, String(s.address().port)));
    });
    s.listen(0, "127.0.0.1", () => { servers.push(s); resolve(`http://127.0.0.1:${s.address().port}`); });
  });
}
const page = (body, head = "") => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>T</title>${head}</head><body style="margin:0">${body}<div style="height:2600px"></div></body></html>`;
const auditor = () => createBrowserSiteAuditor({ launch: chromiumLauncher() });
const types = (r) => r.issues.map((i) => i.type).sort();

// ---------- 11. Fehlerhafte Sprungmarken ----------
test("11 Sprungmarke ohne Ziel wird erkannt (Klick bestätigt), gültige/#top/Skript-gesteuerte Sprünge nicht", { skip }, async () => {
  const base = await serve({
    "/bad": page(`<header><nav><a href="#kontakt">Termin vereinbaren</a> <a href="#leistungen">Leistungen</a> <a href="#top">Oben</a> <a href="#">Menü</a></nav></header>
      <section id="leistungen" style="margin-top:1200px"><h2>Leistungen</h2></section><section id="contact"><h2>Kontakt</h2></section>`),
    "/js": page(`<nav><a href="#unten" class="js">Nach unten</a></nav><section id="ziel" style="margin-top:1500px"><h2>Ziel</h2></section>
      <script>document.querySelector('a.js').addEventListener('click', (e) => { e.preventDefault(); document.getElementById('ziel').scrollIntoView(); });</script>`),
  });
  const bad = await auditor().audit(`${base}/bad`);
  assert.deepEqual(types(bad), ["broken_anchor"]);
  const i = bad.issues[0];
  assert.equal(i.detail.anchor, "kontakt"); assert.equal(i.detail.click_confirmed, true); assert.equal(i.location, "Termin vereinbaren"); assert.equal(i.severity, "high");
  assert.equal(i.reproducible, true); assert.match(i.evidence, /#kontakt/);
  const js = await auditor().audit(`${base}/js`);
  assert.deepEqual(types(js), [], "Skript übernimmt den Sprung → kein Fehler (keine falsche Positivmeldung)");
});

// ---------- 12. Abgeschnittene Responsive-Elemente ----------
test("12 Abgeschnittenes Raster (overflow:hidden) je Viewport erkannt; scrollbare Liste, Karussell, dekorative Elemente nicht", { skip }, async () => {
  const cards = (n, w) => Array.from({ length: n }, (_, k) => `<div style="background:#eef;padding:8px">Notruf ${140 + k}</div>`).join("");
  const base = await serve({
    "/clip": page(`<section style="overflow:hidden;padding:24px"><h2>Notfallnummern</h2><div class="grid5" style="display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:24px">${cards(5)}</div>
      <div style="position:absolute;left:900px;width:600px;height:300px;background:#fdd">Deko</div></section>`),
    "/ok": page(`<section style="overflow:hidden;position:relative"><h2>Notfall</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:24px">${cards(5)}</div>
      <div style="position:absolute;left:1200px;top:0;width:900px;height:200px">Deko-Kreis</div></section>
      <section><h2>Galerie</h2><div style="overflow-x:auto"><div style="display:flex;gap:8px">${Array.from({ length: 6 }, (_, k) => `<div style="min-width:320px">Bild ${k}</div>`).join("")}</div></div></section>
      <section class="carousel" style="overflow:hidden"><div style="display:flex"><div style="min-width:100%">Slide 1</div><div style="min-width:100%">Slide 2</div></div></section>
      <div style="overflow:hidden"><span class="sr-only" style="position:absolute;width:1px;height:1px;overflow:hidden">Nur Screenreader</span></div>`),
  });
  const clip = await auditor().audit(`${base}/clip`);
  assert.deepEqual(types(clip), ["content_clipped"]);
  const c = clip.issues[0];
  assert.equal(c.location, "Notfallnummern"); assert.equal(c.detail.columns, 5); assert.equal(c.detail.element.class, "grid5");
  const vp = Object.fromEntries(c.detail.per_viewport.map((p) => [p.viewport, p.hidden]));
  assert.equal(vp.desktop, undefined, "Desktop 1440: alles sichtbar (5×240+4×24 passt)");
  assert.ok(vp.tablet >= 2 && vp.mobile >= 4, JSON.stringify(vp));
  assert.deepEqual(types(await auditor().audit(`${base}/ok`)), [], "keine falsche Positivmeldung");
});

// ---------- 13. JavaScript-Laufzeitfehler ----------
test("13 Laufzeitfehler eines eigenen Skripts erkannt (mit Ursache), Fremd-Skript-Fehler und abgesicherte Abfragen nicht", { skip }, async () => {
  const base = await serve({
    "/err": page(`<footer>© <span id="current-year"></span></footer><script>document.getElementById('current-yaer').textContent = 2026;</script>`),
    "/guarded": page(`<footer>© <span id="current-year"></span></footer><script>const el = document.getElementById('fehlt-absichtlich'); if (el) el.textContent = 1;</script>`),
    "/third": page(`<p>Hallo</p><script src="http://localhost:__PORT__/third-party.js"></script>`),
  });
  const err = await auditor().audit(`${base}/err`);
  assert.deepEqual(types(err), ["js_runtime_error"]);
  assert.deepEqual(err.issues[0].detail.missing_ids, ["current-yaer"]);
  assert.equal(err.issues[0].detail.name, "TypeError"); assert.equal(err.issues[0].detail.viewports.length, 3, "in allen drei Seitenaufrufen reproduziert");
  assert.deepEqual(types(await auditor().audit(`${base}/guarded`)), [], "abgesichert, kein Fehler → kein Befund");
  assert.deepEqual(types(await auditor().audit(`${base}/third`)), [], "Fremd-Skript zählt nicht");
});
test("13 Einmaliger (nicht reproduzierbarer) Laufzeitfehler zählt nicht", () => {
  const ok = (vp, errs) => ({ viewport: vp, load_ok: true, page_errors: errs, probe: { anchors: [], clipped: [], missing_ids: [] }, anchors_confirmed: {} });
  const r = browserFindingsFrom("https://x.ch/", [ok("desktop", [{ name: "Error", message: "zufällig" }]), ok("tablet", []), ok("mobile", [])]);
  assert.deepEqual(r, []);
});

// ---------- Vollständiger Engine-Lauf + 15. E-Mail-Deduplizierung ----------
const DOMAIN = "praxis-test.netlify.app";
const MAILBOX = "test-postfach@example.ch";
const ENV = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: DOMAIN, JARVIS_E2E_TEST_MAILBOXES: MAILBOX, JARVIS_E2E_FULFILMENT_ENABLED: "true" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SITE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Physio Muster</title>
<link rel="stylesheet" href="/style.css">
<style>
.wrap{overflow:hidden;padding:16px}
.cards{display:grid;grid-template-columns:repeat(4,minmax(260px,1fr));gap:16px}
.card{background:#eef;padding:12px}
</style></head><body>
<header><nav><a href="#leistungen">Leistungen</a> <a href="#termin">Termin buchen</a> <a href="#top">Nach oben</a></nav></header>
<main>
<section id="leistungen"><h2>Leistungen</h2><p>Physiotherapie und Massage.</p></section>
<section class="wrap"><h2>Notfallnummern</h2><div class="cards"><div class="card">Notruf 144</div><div class="card">Polizei 117</div><div class="card">Feuerwehr 118</div><div class="card">Vergiftung 145</div></div></section>
<section><h2>Galerie</h2><div style="overflow-x:auto"><div style="display:flex;gap:8px"><div style="min-width:300px">Bild 1</div><div style="min-width:300px">Bild 2</div><div style="min-width:300px">Bild 3</div><div style="min-width:300px">Bild 4</div><div style="min-width:300px">Bild 5</div></div></div></section>
<div style="height:2400px"></div>
<section id="booking"><h2>Termin</h2><p>Rufen Sie uns an.</p></section>
<div style="height:1200px"></div>
</main>
<footer><p>© <span id="footer-year"></span> Physio Muster</p><img src="/logo.png" alt="Logo" width="20" height="20"></footer>
<script>document.getElementById('footer-yaer').textContent = new Date().getFullYear();</script>
</body></html>
`;
test("Engine end-to-end: Jarvis erkennt, plant, repariert, prüft (Entwurf + Browser), veröffentlicht, prüft live, liefert genau EINE Testmail", { skip, timeout: 600_000 }, async () => {
  const dir = tmp(), outbox = tmp(), store = createStore(dir);
  const e2e = e2eConfig(ENV);
  const mock = createNetlifyMock({ siteName: "praxis-test", files: { "/index.html": SITE, "/style.css": "body{margin:0;font-family:sans-serif}", "/logo.png": PNG } });
  const sourceId = mock.site.published_deploy.id; // fehlerhafter Stand (gebundene Quelle)
  const otherLive = mock.addDeploy({ "/index.html": SITE.replace("footer-yaer", "footer-year"), "/style.css": "body{margin:0;font-family:sans-serif}", "/logo.png": PNG });
  mock.publish(otherLive); // Produktion = anderer Stand (wie bei Praxis Kälin: dort bereits von Hand korrigiert)
  const proxy = await mock.startProxy();
  try {
    setDropMapping(store, DOMAIN, { netlify_site_id: mock.siteId, site_name: "praxis-test", reference: "Test" });
    const o = createInternalTestRepairOrder(store, { domain: DOMAIN, website: `http://${DOMAIN}/`, delivery_email: MAILBOX, netlify_site_id: mock.siteId, source_deploy_id: sourceId, company: "Physio Muster", contact_name: "Test", e2e });
    authorizeRepair(store, o.order_id, { authorized_domain: DOMAIN, source: "written_confirmation", reference: "Inhaber, Testlauf" });
    const launch = chromiumLauncher({ extraArgs: [`--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>"] });
    const adapter = netlifyDropAdapter({ dir, store, env: { JARVIS_REPAIR_NETLIFY_TOKEN: GOOD_TOKEN }, fetchFn: mock.fetchFn, sleep: async () => {}, pollMs: 1, permalinkOf: (id, s) => `http://${id}--${s.name}.netlify.app` });
    const httpAuditor = { audit: async (url) => { const r = await mock.fetchFn(url); const html = await r.text(); return { reachable: r.status === 200, finalUrl: url, title: "Physio Muster", pages: { home: html }, requests: 1, issues: [] }; } };
    const engine = createRepairEngine({ dir, store, adapters: { netlify_drop: adapter }, auditor: httpAuditor, browserAuditor: createBrowserSiteAuditor({ launch }),
      browserValidator: createBrowserValidator({ launch }), requireBrowser: true, autoDeliver: true, gmail: createOutboxMailer({ dir: outbox }), e2e });
    const sent = [];
    const gmail = { createDraft: async (m) => ({ draftId: `d${sent.length}` }), sendDraft: async (id) => { sent.push(id); return { messageId: `m${id}` }; }, listOwned: () => ({ sent: {} }) };
    await engine.processAll();
    let order = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
    assert.equal(order.state, "READY_FOR_DELIVERY", `${order.state}: ${order.blocked_reason || ""} ${JSON.stringify(order.manual_review)}`);
    // Jarvis hat selbst erkannt, geplant und repariert
    const byType = Object.fromEntries(Object.values(order.issues).map((i) => [i.type, i]));
    assert.deepEqual(Object.keys(byType).sort(), ["broken_anchor", "content_clipped", "js_runtime_error"]);
    for (const i of Object.values(byType)) assert.equal(i.repair_status, "repaired", i.type);
    assert.equal(order.plan.length, 3);
    assert.equal(order.audit_before.browser_audit.ok, true);
    assert.ok(order.backup.source_url.includes(sourceId), "Audit auf dem gebundenen Quell-Deploy");
    assert.equal(order.backup.rollback_point, `netlify:${otherLive}`);
    // Entwurf geprüft, dann veröffentlicht; unveränderte Dateien erhalten
    assert.equal(order.validation.build_ok, true); assert.match(order.validation.preview_url, /--praxis-test\.netlify\.app\/$/);
    assert.equal(order.browser_gate.desktop, "JA"); assert.equal(order.browser_gate.mobile, "JA"); assert.equal(order.browser_gate.regression, "KEINE");
    assert.equal(order.deployment.deployed, true); assert.equal(order.deployment.live_retest_ok, true);
    const live = mock.site.published_deploy.id;
    assert.equal(order.deployment.deploy_ref, `netlify:${live}`);
    assert.equal(mock.state.deploys.get(live).draft, true, "veröffentlicht wurde genau der geprüfte Entwurf");
    assert.equal(mock.calls.filter((c) => c.method === "POST" && /\/restore$/.test(c.path)).length, 1);
    assert.equal(mock.calls.filter((c) => c.method === "PUT").length, 1, "nur index.html hochgeladen");
    assert.equal(mock.state.deploys.get(live).files["/logo.png"], mock.state.deploys.get(sourceId).files["/logo.png"]);
    assert.equal(order.payment.satisfied, true); assert.equal(order.payment.waived, "INTERNAL_ADMIN_TEST"); assert.equal(order.payment.paid_chf, 0);
    assert.match(order.report.body, /Behoben wurden:/); assert.match(order.report.body, /live und wurden danach erneut geprüft/);
    // Outbox: genau ein Versandauftrag, als TEST gekennzeichnet; vor Bestätigung nie «gesendet»
    assert.ok(order.delivery?.draft_id); assert.ok(!order.delivery.sent_at);
    const rq = fs.readdirSync(outbox).filter((f) => f.endsWith(".request.json"));
    assert.equal(rq.length, 1);
    const req = JSON.parse(fs.readFileSync(path.join(outbox, rq[0]), "utf8"));
    assert.ok(req.subject.startsWith("[E2E-TEST] ")); assert.equal(req.to, MAILBOX); assert.equal(req.e2e_run_id, order.test_run_id); assert.match(req.body, /^TESTAUFTRAG \(intern\)/);
    // Mail-Worker ohne Erfüllungsfreigabe → abgelehnt (nie an einen nicht freigegebenen Weg)
    const blockedDir = tmp(); fs.copyFileSync(path.join(outbox, rq[0]), path.join(blockedDir, rq[0]));
    const blocked = await processRepairOutbox({ dir: blockedDir, gmail, env: { ...ENV, JARVIS_E2E_FULFILMENT_ENABLED: "" } });
    assert.equal(blocked.rejected, 1); assert.equal(sent.length, 0);
    // Mail-Worker mit Freigabe: genau einmal; Wiederholungen senden nie erneut
    const r1 = await processRepairOutbox({ dir: outbox, gmail, env: ENV });
    const r2 = await processRepairOutbox({ dir: outbox, gmail, env: ENV });
    assert.equal(r1.sent, 1); assert.equal(r2.sent, 0);
    await engine.processAll(); await engine.processAll();
    await processRepairOutbox({ dir: outbox, gmail, env: ENV });
    order = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
    assert.equal(order.state, "COMPLETED", order.state);
    assert.ok(order.delivery.sent_at);
    assert.equal(sent.length, 1, "genau EINE Abschlussmail");
    const hist = order.state_history.map((h) => h.to);
    for (const s of ["ACCESS_CHECK", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED"]) assert.ok(hist.includes(s), s);
    const log = fs.readFileSync(path.join(dir, NETLIFY_DROP_LOG), "utf8");
    assert.ok(!log.includes(GOOD_TOKEN) && /"action":"published"/.test(log));
  } finally { await proxy.close(); }
});
