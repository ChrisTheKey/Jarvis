// TF-062 – kein Website-Paket/ZIP mehr nach der CHF-480-Reparatur. Die reparierte Website bleibt live beim Kunden; nach bestandenem
// Abschluss-Gate folgen direkt Abschluss + Bericht. Backup vor der ersten Änderung, Rollback-Punkt, Browser- und Regression-Gate
// bleiben unverändert Pflicht. Alte Aufträge mit historischem `package`-Feld bleiben lesbar (Feld wird ignoriert, nie migriert).
// Nur synthetische Daten in Temp-Verzeichnissen, kein Netz nach aussen, kein Senden.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, publicRepairOrders, loadDefaultRepairDeps, PUBLIC_REPAIR_FIELDS, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { gateDecision } from "../repair-browser-validator.js";
import { sftpAdapter } from "../repair-adapters/sftp.js";
import { sshAdapter } from "../repair-adapters/ssh.js";
import { bridgeAdapter } from "../repair-adapters/router.js";
import { cleanRepair } from "../server-control.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-15T08:00:00Z");
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-p62-")); dirs.push(d); return d; };
process.on("exit", () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const snap = (o = {}) => ({ load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
  overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
  critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
  nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 2, targets_ok: 2, targets_failed: 0 }, images: { visible: 2, broken: 0, broken_paths: [] },
  console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 }, network: { failed_same_site: 0, failed_cross_site: 0, entries: [] },
  fingerprints: { header: "a", nav: "b", main: "c", footer: "d" }, findings: [], ...o });
const BROKEN = { type: "contact_page_broken", url: "https://muster.ch/kontakt-alt.html", page: "https://muster.ch/", severity: "high" };
const UNCLEAR = { type: "broken_link", url: "https://muster.ch/alt/preise.html", page: "https://muster.ch/angebot/", severity: "medium" };
// Lab-Adapter: zeichnet die Reihenfolge auf; ein (Alt-)exportWebroot würde als "export" auffallen.
function world({ html = "<html></html>", regress = false, unclear = false, mobileBreaksAfterFix = false, claims = false } = {}) {
  const st = { fixed: false }, events = [];
  const adapter = {
    direct_live: true,
    ...(claims ? { claims: async () => true } : {}),
    checkAccess: async () => ({ ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] }),
    backup: async () => { events.push("backup"); return { production_ref: "p1", backup_ref: "b1", rollback_point: "r1" }; },
    locate: async (i) => (i.type === BROKEN.type ? { target: "index.html", cause: "404, Ziel existiert genau einmal", planned_change: "Verweis ersetzen", risk: "niedrig", fix: { replacement: "/kontakt.html" } } : null),
    applyFix: async () => { st.fixed = true; events.push("fix"); return { ok: true, change_ref: "lab:1" }; },
    validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }),
    rollback: async () => { st.fixed = false; events.push("rollback"); return { ok: true }; },
    exportWebroot: async () => { events.push("export"); return { ok: false }; },
  };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Muster", requests: 3, pages: { home: html },
    issues: [...(st.fixed ? [] : [BROKEN]), ...(unclear ? [UNCLEAR] : []), ...(regress && st.fixed ? [{ type: "broken_link", url: "https://muster.ch/neu.html", page: "https://muster.ch/", severity: "medium" }] : [])]
      .map((i) => ({ ...i, evidence: "HTTP 404", reproducible: true, detectedAt: T0.toISOString() })) }) };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    events.push(`browser:${phase}`);
    const broken = mobileBreaksAfterFix && st.fixed;
    const out = { url, phase, desktop: snap(), mobile: broken ? snap({ overflow: { horizontal: true, px: 300, offscreen_elements: 4, images_over_viewport: 1, clipped_text: 2 }, metrics: { scroll_width: 690, viewport_width: 390, doc_height: 1000, text_length: 400 } }) : snap() };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  return { adapter, auditor, browserValidator, events };
}
function setup() {
  const dir = tmp(), store = createStore(dir);
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "kunde@muster.ch", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_reply_email", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: "TF062-Test-Ledger", now: T0 });
  return { dir, store, id: o.order_id };
}
const gmail = (drafts = []) => ({ createDraft: async (d) => { drafts.push(d); return { draftId: "d1" }; }, sendDraft: async () => ({}) });
const run = (store, w, { key = "static", drafts = [] } = {}) => createRepairEngine({ store, adapters: { [key]: w.adapter }, auditor: w.auditor, browserValidator: w.browserValidator,
  requireBrowser: true, autoDeliver: true, gmail: gmail(drafts), now: () => T0 }).processAll();
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const NO_PKG = /\.zip\b|netlify[-_ ]?ready|website-paket|artifact\.json|FULL_BACKUP_ONLY|EXPORT_NOT_AVAILABLE|PACKAGE_VALIDATION_FAILED/i;

test("A/F/G/I: statische Reparatur → COMPLETED wie bisher, Backup VOR der Änderung, Rollback-Punkt, Bericht – kein ZIP/Export", async () => {
  const { store, id, dir } = setup();
  const w = world(), drafts = [];
  await run(store, w, { drafts });
  const o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED", o.blocked_reason);
  assert.equal(o.package, undefined, "kein package-Feld");
  assert.ok(!w.events.includes("export"), "kein exportWebroot-Aufruf");
  assert.ok(w.events.indexOf("backup") >= 0 && w.events.indexOf("backup") < w.events.indexOf("fix"), "Backup vor der ersten Änderung");
  assert.equal(o.backup.rollback_point, "r1");
  assert.equal(o.completion.kind, "FULL");
  assert.ok(o.report?.body?.length > 50, "Abschlussbericht erzeugt");
  assert.ok(!NO_PKG.test(o.report.body), "Bericht ohne Paket-/ZIP-Hinweis");
  assert.equal(drafts.length, 1, "genau eine Lieferung");
  assert.ok(!drafts[0].attachments && !NO_PKG.test(drafts[0].body), "kein Anhang, kein ZIP");
  assert.ok(!fs.readdirSync(dir, { recursive: true }).some((f) => /\.zip$|artifact\.json$|repair_artifacts/.test(String(f))), "keine Paketdateien");
});

test("B: WordPress-Reparatur → kein ZIP, kein Export", async () => {
  const { store, id } = setup();
  const w = world({ html: '<html><link rel="stylesheet" href="/wp-content/themes/x/style.css"></html>' });
  await run(store, w, { key: "wordpress" });
  const o = readOrder(store, id);
  assert.equal(o.stack.type, "wordpress");
  assert.equal(o.state, "COMPLETED", o.blocked_reason);
  assert.equal(o.package, undefined); assert.ok(!w.events.includes("export"));
});

test("C: SFTP-Reparatur → kein exportWebroot-Aufruf nach Abschluss; Adapter bieten keinen Webroot-Export mehr an", async () => {
  const { store, id } = setup();
  const w = world({ claims: true });
  await run(store, w, { key: "sftp" });
  const o = readOrder(store, id);
  assert.equal(o.stack.type, "sftp");
  assert.equal(o.state, "COMPLETED", o.blocked_reason);
  assert.ok(!w.events.includes("export")); assert.equal(o.package, undefined);
  assert.equal(typeof sftpAdapter({ connect: async () => ({}) }).exportWebroot, "undefined");
  assert.equal(typeof sshAdapter({ connect: async () => ({}) }).exportWebroot, "undefined");
  assert.equal(typeof bridgeAdapter("sftp", { detectCapabilities: () => [], exportWebroot: async () => ({ ok: true }) }).exportWebroot, "undefined");
});

test("D: Browser-Gate weiterhin aktiv – Mobile-Bruch nach dem Fix → Rollback, nie Abschluss", async () => {
  const { store, id } = setup();
  const w = world({ mobileBreaksAfterFix: true });
  await run(store, w);
  const o = readOrder(store, id);
  assert.ok(w.events.includes("browser:baseline") && w.events.includes("browser:after"));
  assert.ok(w.events.includes("rollback"), w.events.join(","));
  assert.ok(!["READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"].includes(o.state), o.state);
  assert.equal(o.browser_gate.mobile, "NEIN");
  // Ohne Browser-Validator (requireBrowser) nie ein Abschluss.
  const s2 = setup(), w2 = world();
  await createRepairEngine({ store: s2.store, adapters: { static: w2.adapter }, auditor: w2.auditor, browserValidator: null, requireBrowser: true, autoDeliver: true, gmail: gmail(), now: () => T0 }).processAll();
  assert.ok(!["READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"].includes(readOrder(s2.store, s2.id).state));
  assert.ok(!w2.events.includes("fix"), "ohne Browser keine Änderung");
});

test("E: Regression → weiterhin Rollback, kein Abschluss, kein Export", async () => {
  const { store, id } = setup();
  const w = world({ regress: true });
  await run(store, w);
  const o = readOrder(store, id);
  assert.equal(o.state, "REPAIR_FAILED");
  assert.deepEqual(w.events.filter((e) => ["fix", "rollback", "export"].includes(e)), ["fix", "rollback"]);
  assert.equal(o.package, undefined);
});

test("H: offene manuelle Punkte → COMPLETED_WITH_MANUAL_ITEMS weiterhin korrekt, Bericht erzeugt, kein ZIP", async () => {
  const { store, id } = setup();
  const w = world({ unclear: true });
  await run(store, w);
  const o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED_WITH_MANUAL_ITEMS", o.blocked_reason);
  assert.equal(o.completion.kind, "WITH_MANUAL_ITEMS"); assert.ok(o.completion.manual_items >= 1);
  assert.ok(o.report?.body && !NO_PKG.test(o.report.body));
  assert.equal(o.package, undefined); assert.ok(!w.events.includes("export"));
});

test("J/K: Status/API ohne package; alte Aufträge mit historischem package-Feld bleiben lesbar, Feld ignoriert und unverändert", async () => {
  const { store, id, dir } = setup();
  await run(store, world());
  assert.ok(!PUBLIC_REPAIR_FIELDS.includes("package"));
  const fresh = publicRepairOrders(dir).orders.find((x) => x.order_id === id);
  assert.deepEqual(Object.keys(fresh).sort(), [...PUBLIC_REPAIR_FIELDS].sort());
  // Legacy-Auftrag (TF-059) mit gespeichertem Paket
  const legacy = { status: "NETLIFY_READY", file: "website-netlify-ready.zip", sha256: "a".repeat(64), size: 1234, file_count: 7, netlify_ready: true, created_at: T0.toISOString() };
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  data.orders[id] = { ...data.orders[id], package: legacy };
  store.write(REPAIR_ORDERS_FILE, data);
  const before = fs.readFileSync(path.join(dir, REPAIR_ORDERS_FILE), "utf8");
  const pub = publicRepairOrders(dir);
  const p = pub.orders.find((x) => x.order_id === id);
  assert.equal(p.state, "COMPLETED"); assert.equal(p.package, undefined);
  assert.ok(!NO_PKG.test(JSON.stringify(pub)), "keine Paketinfo in der API");
  const c = cleanRepair({ ...pub, orders: [{ ...p, package: { status: "NETLIFY_READY", file: "website-netlify-ready.zip", sha256_short: "abcdef012345", netlify_ready: true } }] });
  assert.equal(c.orders[0].order_id, id); assert.equal(c.orders[0].package, undefined);
  // Ein weiterer Worker-Lauf lässt den abgeschlossenen Alt-Auftrag unberührt (keine Migration, nichts beschädigt).
  await run(store, world());
  assert.equal(fs.readFileSync(path.join(dir, REPAIR_ORDERS_FILE), "utf8"), before);
  assert.deepEqual(readOrder(store, id).package, legacy);
});

test("L/M: kein repair-package.js, kein Packager, keine Docker-/Deploy-Referenzen, kein Download-Skript, kein Dashboard-Bereich", async () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "repair-package.js")));
  assert.ok(!fs.existsSync(path.join(ROOT, "scripts/download-repair-package.ps1")));
  for (const f of ["repair-workflow.js", "repair-service.js", "server-control.js", "repair-adapters/sftp.js", "repair-adapters/ssh.js", "repair-adapters/router.js"])
    assert.ok(!/repair-package|packager|exportWebroot|JARVIS_REPAIR_ARTIFACTS/i.test(read(f)), f);
  const deps = await loadDefaultRepairDeps({ dir: tmp() });
  assert.ok(!("packager" in deps)); assert.ok("browserValidator" in deps, "BrowserValidator bleibt");
  const dockerfiles = fs.readdirSync(path.join(ROOT, "deploy/vps")).filter((f) => /^Dockerfile/.test(f));
  assert.ok(dockerfiles.length >= 4);
  for (const f of dockerfiles) assert.ok(!/repair-package|JARVIS_REPAIR_ARTIFACTS/.test(read(`deploy/vps/${f}`)), f);
  assert.ok(!/artifacts/.test(read("deploy/vps/repair/docker-compose.yml")));
  assert.ok(!/artifacts/.test(read("deploy/vps/repair-remote.sh")));
  assert.ok(!/WEBSITE-PAKET|NETLIFY READY|Download-Skript|o\.package/.test(read("public/index.html")));
});
