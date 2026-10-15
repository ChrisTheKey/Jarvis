// TF-059 – Website-Paket nach der CHF-480-Reparatur: NETLIFY_READY nur nach Selbstprüfung (entpackt, statisch geprüft, lokal
// serviert, Chromium Desktop 1440×900 + Mobile 390×844), WordPress/PHP nie Netlify-Ready, Adapter ohne Webroot-Leserechte →
// EXPORT_NOT_AVAILABLE (Auftrag bleibt erfolgreich), Secrets/Traversal/Symlinks nie im ZIP, Paket erst NACH dem Abschluss-Gate.
// Nur synthetische Daten in Temp-Verzeichnissen, kein Netz nach aussen, kein Senden. Browser-Tests nacheinander.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, publicRepairOrders, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { gateDecision, chromiumLauncher } from "../repair-browser-validator.js";
import { sftpAdapter } from "../repair-adapters/sftp.js";
import { bridgeAdapter } from "../repair-adapters/router.js";
import { createPackager, createPackageBrowserCheck, createRepairPackage, readZip, createZipWriter, staticChecks, classifyWebroot, excludedReason, safeRelPath,
  skipPath, packageSummary, NETLIFY_ZIP, BACKUP_ZIP, ARTIFACT_JSON } from "../repair-package.js";
import { cleanRepair } from "../server-control.js";
import { exe } from "./crm-browser-harness.js";

const T0 = new Date("2026-10-15T08:00:00Z");
const dirs = [];
const tmp = (p = "jarvis-p59-") => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
process.on("exit", () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const POSIX = process.platform !== "win32";
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#0a7"/></svg>';
const page = (title, body) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/css/site.css"></head><body><header><nav><a href="/">Start</a> <a href="/kontakt.html">Kontakt</a> <a href="/ueber-uns/">Über uns</a></nav></header>
<main>${body}</main><script src="/js/app.js"></script></body></html>`;
// Statischer Webroot nach der Reparatur + Dinge, die NIE ins ZIP dürfen.
const SECRET = "sk_live_" + "A".repeat(24);
function staticSite(extra = {}) {
  const d = tmp("jarvis-p59-site-");
  const w = (rel, data) => { const f = path.join(d, ...rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  w("index.html", page("Muster AG", `<h1>Muster AG</h1><p>Willkommen.</p><img src="/assets/img/lab-logo.svg" alt="Logo" width="40" height="20"><img src="assets/team.png" alt="Team" width="1" height="1">`));
  w("kontakt.html", page("Kontakt", "<h1>Kontakt</h1><p>Telefon 031 000 00 00</p>"));
  w("ueber-uns/index.html", page("Über uns", "<h1>Über uns</h1>"));
  w("css/site.css", "body{font-family:sans-serif;margin:0;padding:16px;max-width:100%}nav a{margin-right:8px}img{max-width:100%}");
  w("js/app.js", "document.documentElement.dataset.ok='1';");
  w("assets/img/lab-logo.svg", SVG); w("assets/team.png", PNG);
  // verboten:
  w(".env", "DB_PASSWORD=supersecret123\n"); w(".env.production", "X=1"); w(".git/config", "[core]"); w(".git/HEAD", "ref"); w("id_rsa", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\nabc\n`); // Attrappe, zur Laufzeit zusammengesetzt (Secret-Scan)
  w("node_modules/x/index.js", "module.exports=1"); w("config/keys.js", `const k="${SECRET}";`); w("backup-2026.sql", "INSERT"); w("error.log", "boom");
  w(".jarvis-probe-abc.tmp", "a"); w("secrets/api.txt", "token"); w(".htpasswd", "u:p"); w("server.pem", "-----BEGIN CERTIFICATE-----");
  for (const [rel, data] of Object.entries(extra)) w(rel, data);
  return d;
}
// SFTP-Attrappe über ein lokales Verzeichnis (für den ECHTEN sftpAdapter.exportWebroot) + ein Symlink nach draussen.
const ROOT = "/srv/kunde/public_html";
function fakeSftp(base, { symlink = true } = {}) {
  const loc = (p) => path.join(base, ...p.slice(ROOT.length).split("/").filter(Boolean));
  const reads = [];
  return { reads, connect: async () => ({
    realpath: async (p) => p,
    readdir: async (p) => [...fs.readdirSync(loc(p), { withFileTypes: true }).map((e) => ({ filename: e.name, attrs: { isDir: e.isDirectory(), isFile: e.isFile(), isSymlink: false } })),
      ...(symlink && p === ROOT ? [{ filename: "escape-link", attrs: { isSymlink: true } }] : [])],
    lstat: async (p) => { const s = fs.lstatSync(loc(p)); return { isSymlink: s.isSymbolicLink(), isFile: s.isFile(), isDir: s.isDirectory() }; },
    readFile: async (p) => { reads.push(p.slice(ROOT.length + 1)); return fs.readFileSync(loc(p)); },
    close: async () => {},
  }) };
}
const order = (o = {}) => ({ order_id: "RF480-20261015-a1b2c3", domain: "muster.ch", stack: { type: "static" }, issues: {}, plan: [], ...o });
const exportVia = (base, opts) => { const f = fakeSftp(base, opts); const a = sftpAdapter({ connect: f.connect }); return { reads: f.reads, exportFiles: (onFile, o = {}) => a.exportWebroot(order(), { remote_root: ROOT }, { ...o, onFile }) }; };
const browserCheck = () => (exe ? createPackageBrowserCheck({ launch: chromiumLauncher({ executablePath: exe }) }) : null);
const BROWSER = { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 };

// ---------- Bausteine ----------
test("Pfade: Traversal/absolut/Backslash/Steuerzeichen blockiert; Secrets/Temp/Logs/node_modules ausgeschlossen", () => {
  for (const p of ["../x", "a/../../etc/passwd", "/etc/passwd", "C:/x", "a\\b", "a//b", "./a", "a\u0000b", ""]) assert.equal(safeRelPath(p), null, p);
  assert.equal(safeRelPath("css/site.css"), "css/site.css");
  for (const p of [".env", ".env.local", ".git/config", "a/.git/HEAD", "id_rsa", "id_ed25519.pub", "server.key", "cert.pem", "wp-config.php", "config.php", "credentials.json",
    "secrets/x.txt", "node_modules/a.js", "logs/a.txt", "error_log", "debug.log", "dump.sql", "db.sqlite", "sess_abc", ".htaccess", ".htpasswd", ".npmrc", ".jarvis-probe-1.tmp",
    "site-backup.zip", "tmp/x.html", "backup/x.html"]) assert.ok(excludedReason(p), p);
  for (const p of ["index.html", "css/site.css", "assets/img/logo.svg", "js/app.js", "downloads/preisliste.pdf", "jarvis-logo.png"]) assert.equal(excludedReason(p), null, p);
  assert.equal(skipPath(".git", true), true); assert.equal(skipPath("node_modules", true), true); assert.equal(skipPath("assets", true), false);
  const z = path.join(tmp(), "t.zip"), w = createZipWriter(z);
  assert.throws(() => w.add("../evil.txt", Buffer.from("x"))); assert.throws(() => w.add("/abs.txt", Buffer.from("x")));
  w.add("a.txt", Buffer.from("a")); assert.throws(() => w.add("A.TXT", Buffer.from("b")), /doppelt/); w.finish();
  assert.deepEqual(readZip(fs.readFileSync(z)).map((e) => e.name), ["a.txt"]);
});

test("Klassifizierung: statisch → Netlify-Kandidat; PHP/WordPress/ohne index.html → nie", () => {
  assert.equal(classifyWebroot(["index.html", "css/a.css"]).netlify_candidate, true);
  assert.deepEqual(classifyWebroot(["index.php", "style.css"]), { netlify_candidate: false, reason: "server_side_code" });
  assert.equal(classifyWebroot(["index.html", "wp-content/themes/x/style.css"]).reason, "wordpress");
  assert.equal(classifyWebroot(["index.html"], { stack: "wordpress" }).netlify_candidate, false);
  assert.equal(classifyWebroot(["site/index.html"]).reason, "no_root_index");
});

test("Statische Prüfung: fehlende Assets, lokale absolute Pfade, verbotene Dateien und Symlinks werden erkannt", () => {
  const html = (b) => Buffer.from(`<html><body>${b}</body></html>`);
  const ok = staticChecks([{ name: "index.html", data: html('<img src="a.png"><a href="/x/">x</a>') }, { name: "a.png", data: PNG }, { name: "x/index.html", data: html("") }]);
  assert.equal(ok.ok, true);
  const bad = staticChecks([{ name: "index.html", data: html('<img src="/fehlt.png"><link rel="stylesheet" href="file:///C:/site/a.css"><a href="/gibts-nicht">x</a>') },
    { name: ".env", data: Buffer.from("x") }, { name: "l", data: Buffer.from(""), symlink: true }], { domain: "muster.ch" });
  assert.equal(bad.ok, false);
  assert.deepEqual([bad.missing_assets.length, bad.local_paths.length, bad.missing_pages.length, bad.forbidden.length, bad.symlinks], [1, 1, 1, 1, 1]);
  // Bekannt kaputte, nicht reparierte Seite (manueller Punkt) ist kein Paketfehler.
  assert.equal(staticChecks([{ name: "index.html", data: html('<a href="/agb-alt">x</a>') }], { knownBroken: ["/agb-alt"] }).ok, true);
  // Externe Links/CDN zählen nicht als fehlend; gleiche Domain absolut schon.
  const ext = staticChecks([{ name: "index.html", data: html('<script src="https://cdn.example/x.js"></script><img src="https://www.muster.ch/fehlt.jpg">') }], { domain: "muster.ch" });
  assert.deepEqual(ext.missing_assets, ["index.html → /fehlt.jpg"]);
});

// ---------- Statische Testwebsite (echter SFTP-Export + echter Browser) ----------
test("Statisch: Reparatur erfolgreich → kompletter Webroot → NETLIFY_READY ZIP (index.html im Root, keine Secrets, SHA korrekt, Desktop/Mobile PASS)", BROWSER, async () => {
  const site = staticSite(), art = tmp("jarvis-p59-art-");
  const ex = exportVia(site);
  const o = order({ issues: { i1: { issue_id: "i1", url: "https://muster.ch/kontakt-alt.html", repair_status: "repaired" } }, plan: [{ issue_id: "i1", fix: { replacement: "/kontakt.html" } }] });
  const r = await createPackager({ artifactsDir: art, browserCheck: browserCheck() }).create({ order: o, exportFiles: ex.exportFiles, now: T0 });
  assert.equal(r.status, "NETLIFY_READY", JSON.stringify(r.validation));
  assert.equal(r.file, NETLIFY_ZIP); assert.equal(r.netlify_ready, true);
  const dir = path.join(art, o.order_id), zip = path.join(dir, NETLIFY_ZIP);
  const names = readZip(fs.readFileSync(zip)).map((e) => e.name).sort();
  assert.deepEqual(names, ["assets/img/lab-logo.svg", "assets/team.png", "css/site.css", "index.html", "js/app.js", "kontakt.html", "ueber-uns/index.html"], "nur die Website, kein Oberordner");
  // Secrets: weder im ZIP noch überhaupt gelesen (verbotene Ordner/Dateien werden nicht geöffnet); Inhalts-Scan verwirft config/keys.js.
  const raw = fs.readFileSync(zip);
  for (const s of ["supersecret123", "OPENSSH PRIVATE", "[core]", SECRET, "INSERT", "BEGIN CERTIFICATE"]) assert.ok(!raw.includes(s), s);
  for (const f of [".env", ".git/config", "id_rsa", "node_modules/x/index.js", "secrets/api.txt", ".htpasswd"]) assert.ok(!ex.reads.includes(f), `nicht gelesen: ${f}`);
  assert.ok(r.excluded.secret_content >= 1 && r.excluded.symlink >= 1, JSON.stringify(r.excluded));
  // SHA + artifact.json
  const a = JSON.parse(fs.readFileSync(path.join(dir, ARTIFACT_JSON), "utf8"));
  assert.equal(a.sha256, sha(zip)); assert.equal(r.sha256, a.sha256); assert.equal(a.size, fs.statSync(zip).size);
  assert.deepEqual([a.order_id, a.domain, a.type, a.file, a.netlify_ready, a.file_count], [o.order_id, "muster.ch", "NETLIFY_READY", NETLIFY_ZIP, true, 7]);
  assert.ok(a.created_at);
  assert.equal(a.validation.desktop, "PASS"); assert.equal(a.validation.mobile, "PASS"); assert.equal(a.validation.index_root, true);
  assert.equal(a.validation.js_errors, 0); assert.equal(a.validation.missing_assets, 0); assert.ok(a.validation.navigation_checked >= 2); assert.equal(a.validation.repaired_links_checked, 1);
  assert.ok(!JSON.stringify(a).match(/supersecret|password|\/srv\/|private_key/i), "artifact.json ohne Zugangsdaten/Pfade");
  if (POSIX) { assert.equal(fs.statSync(dir).mode & 0o777, 0o700); assert.equal(fs.statSync(zip).mode & 0o777, 0o600); assert.equal(fs.statSync(path.join(dir, ARTIFACT_JSON)).mode & 0o777, 0o600); }
  assert.deepEqual(fs.readdirSync(dir).sort(), [ARTIFACT_JSON, NETLIFY_ZIP], "keine Temp-Reste");
});

test("Statisch, aber Selbstprüfung scheitert (JS-Fehler / fehlendes Asset) → nie NETLIFY_READY, Backup-ZIP", BROWSER, async () => {
  const site = staticSite({ "js/app.js": "throw new Error('kaputt');" }), art = tmp("jarvis-p59-art-");
  const r = await createPackager({ artifactsDir: art, browserCheck: browserCheck() }).create({ order: order(), exportFiles: exportVia(site).exportFiles, now: T0 });
  assert.equal(r.status, "PACKAGE_VALIDATION_FAILED"); assert.equal(r.file, BACKUP_ZIP); assert.equal(r.netlify_ready, false);
  assert.ok(r.validation.js_errors >= 1);
  const site2 = staticSite({ "kontakt.html": page("Kontakt", '<img src="/assets/fehlt.jpg" alt="">') });
  const r2 = await createPackager({ artifactsDir: tmp("jarvis-p59-art-"), browserCheck: browserCheck() }).create({ order: order(), exportFiles: exportVia(site2).exportFiles, now: T0 });
  assert.equal(r2.status, "PACKAGE_VALIDATION_FAILED"); assert.equal(r2.validation.missing_assets, 1);
  // Ohne Browser nie „Netlify Ready“.
  const r3 = await createPackager({ artifactsDir: tmp("jarvis-p59-art-"), browserCheck: null }).create({ order: order(), exportFiles: exportVia(staticSite()).exportFiles, now: T0 });
  assert.equal(r3.status, "PACKAGE_VALIDATION_FAILED"); assert.equal(r3.validation.reason, "browser_unavailable");
});

test("WordPress/PHP: Backup-ZIP möglich, netlify_ready=false, nie als NETLIFY READY angezeigt", async () => {
  const d = tmp("jarvis-p59-wp-");
  const w = (rel, data) => { const f = path.join(d, ...rel.split("/")); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  w("index.php", "<?php require 'wp-blog-header.php';"); w("wp-blog-header.php", "<?php"); w("wp-config.php", "<?php define('DB_PASSWORD','geheim-db-pw');");
  w("wp-content/themes/muster/style.css", "body{}"); w("wp-content/uploads/2026/10/a.png", PNG); w("wp-includes/version.php", "<?php $wp_version='6.6';");
  w("wp-content/debug.log", "PHP Warning"); w(".htaccess", "RewriteEngine On");
  const art = tmp("jarvis-p59-art-");
  const r = await createPackager({ artifactsDir: art, browserCheck: async () => { throw new Error("darf nicht laufen"); } })
    .create({ order: order({ stack: { type: "wordpress" } }), exportFiles: exportVia(d, { symlink: false }).exportFiles, now: T0 });
  assert.equal(r.status, "FULL_BACKUP_ONLY"); assert.equal(r.reason, "wordpress"); assert.equal(r.netlify_ready, false); assert.equal(r.file, BACKUP_ZIP);
  const zip = path.join(art, "RF480-20261015-a1b2c3", BACKUP_ZIP);
  const names = readZip(fs.readFileSync(zip)).map((e) => e.name);
  assert.ok(names.includes("index.php") && names.includes("wp-content/themes/muster/style.css") && names.includes("wp-includes/version.php"));
  for (const n of ["wp-config.php", ".htaccess", "wp-content/debug.log"]) assert.ok(!names.includes(n), n);
  assert.ok(!fs.readFileSync(zip).includes("geheim-db-pw"));
  const a = JSON.parse(fs.readFileSync(path.join(art, "RF480-20261015-a1b2c3", ARTIFACT_JSON), "utf8"));
  assert.equal(a.netlify_ready, false); assert.equal(a.note, "NICHT DIREKT AUF NETLIFY DEPLOYBAR");
  // Dashboard/Cloud: selbst ein manipuliertes netlify_ready=true wird nie als Netlify-Ready durchgereicht.
  assert.equal(packageSummary({ ...r, netlify_ready: true }).netlify_ready, false);
  const c = cleanRepair({ orders: [{ order_id: "RF480-20261015-a1b2c3", state: "COMPLETED", package: { status: "FULL_BACKUP_ONLY", netlify_ready: true, file: BACKUP_ZIP, sha256_short: "abcdef012345", size: 10 } }] });
  assert.equal(c.orders[0].package.netlify_ready, false); assert.equal(c.orders[0].package.status, "FULL_BACKUP_ONLY");
  assert.equal(cleanRepair({ orders: [{ order_id: "RF480-20261015-a1b2c3", package: { status: "NETLIFY_READY", file: "/opt/jarvis-repair/artifacts/x.zip" } }] }).orders[0].package.file, null, "nie VPS-Pfade");
});

test("Adapter ohne Webroot-Leserechte / Fehler beim Export → EXPORT_NOT_AVAILABLE, nichts abgelegt", async () => {
  const art = tmp("jarvis-p59-art-");
  const p = createPackager({ artifactsDir: art });
  assert.equal((await p.create({ order: order(), exportFiles: null, now: T0 })).status, "EXPORT_NOT_AVAILABLE");
  assert.equal((await p.create({ order: order(), exportFiles: async () => { throw new Error("Permission denied"); }, now: T0 })).reason, "export_failed");
  assert.equal((await p.create({ order: order(), exportFiles: async (onFile) => { onFile("index.html", Buffer.from("<html>")); return { ok: true, complete: false, reason: "too_many_files" }; }, now: T0 })).status, "EXPORT_NOT_AVAILABLE");
  assert.deepEqual(fs.readdirSync(path.join(art, "RF480-20261015-a1b2c3")), [], "kein halbes ZIP, keine Temp-Datei");
  // Path-Traversal / Symlink direkt vom Exporter → nie im ZIP
  const r = await createRepairPackage({ order: order({ stack: { type: "php" } }), artifactsDir: art, now: T0, exportFiles: async (onFile) => {
    for (const [rel, meta] of [["../../etc/passwd", {}], ["/etc/shadow", {}], ["a\\..\\b", {}], ["link", { symlink: true }], ["index.php", {}]]) onFile(rel, Buffer.from("root:x"), meta);
    return { ok: true, complete: true };
  } });
  assert.equal(r.status, "FULL_BACKUP_ONLY");
  assert.deepEqual(readZip(fs.readFileSync(path.join(art, "RF480-20261015-a1b2c3", BACKUP_ZIP))).map((e) => e.name), ["index.php"]);
  assert.deepEqual([r.excluded.unsafe_path, r.excluded.symlink], [3, 1]);
  // Ungültige Order-ID → nie ein Verzeichnis
  assert.equal((await p.create({ order: order({ order_id: "../../x" }), exportFiles: async () => ({ ok: true, complete: true }), now: T0 })).reason, "invalid_order");
});

test("Bridge: Datei mit dem Zugangspasswort des Auftrags erreicht den Packer nie (credential_match)", async () => {
  const pw = "Kunden-Passwort-987!";
  const contract = { detectCapabilities: () => [], exportWebroot: async (o, cred, { onFile }) => { onFile("index.html", Buffer.from("<html>ok</html>")); onFile("notes.txt", Buffer.from(`login ${pw}`)); return { ok: true, complete: true }; } };
  const b = bridgeAdapter("sftp", contract);
  const seen = [];
  const accessCtx = { connector_type: "sftp", credential: () => ({ access_type: "sftp", host: "sftp.muster.ch", username: "kunde", secret: pw }) };
  const r = await b.exportWebroot(order(), accessCtx, { onFile: (rel, data, meta) => { seen.push([rel, data ? data.toString() : null, !!meta?.credential_match]); return true; } });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [["index.html", "<html>ok</html>", false], ["notes.txt", null, true]]);
});

// ---------- Workflow: erst nach dem Abschluss-Gate, Paket ist nie ein Abbruchgrund ----------
const snap = () => ({ load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
  overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
  critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
  nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 2, targets_ok: 2, targets_failed: 0 }, images: { visible: 2, broken: 0, broken_paths: [] },
  console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 }, network: { failed_same_site: 0, failed_cross_site: 0, entries: [] },
  fingerprints: { header: "a", nav: "b", main: "c", footer: "d" }, findings: [] });
const BROKEN = { type: "contact_page_broken", url: "https://muster.ch/kontakt-alt.html", page: "https://muster.ch/", severity: "high" };
function world({ exportFiles = null, regress = false, events = [] } = {}) {
  const st = { fixed: false };
  const adapter = {
    direct_live: true,
    checkAccess: async () => ({ ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] }),
    backup: async () => ({ production_ref: "p1", backup_ref: "b1", rollback_point: "r1" }),
    locate: async () => ({ target: "index.html", cause: "404, Ziel existiert genau einmal", planned_change: "Verweis ersetzen", risk: "niedrig", fix: { replacement: "/kontakt.html" } }),
    applyFix: async () => { st.fixed = true; events.push("fix"); return { ok: true, change_ref: "lab:1" }; },
    validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }),
    rollback: async () => { st.fixed = false; events.push("rollback"); return { ok: true }; },
    ...(exportFiles ? { exportWebroot: async (order, ctx, { onFile, shouldSkip }) => { events.push("export"); return exportFiles(onFile, { shouldSkip }); } } : {}),
  };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Muster", requests: 3, pages: { home: "<html></html>" },
    issues: [...(st.fixed ? [] : [BROKEN]), ...(regress && st.fixed ? [{ type: "broken_link", url: "https://muster.ch/neu.html", page: "https://muster.ch/", severity: "medium" }] : [])]
      .map((i) => ({ ...i, evidence: "HTTP 404", reproducible: true, detectedAt: T0.toISOString() })) }) };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => { const out = { url, phase, desktop: snap(), mobile: snap() }; if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); } return out; } };
  return { adapter, auditor, browserValidator };
}
function setup() {
  const dir = tmp(), store = createStore(dir);
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "kunde@muster.ch", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_reply_email", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: "TF059-Test-Ledger", now: T0 });
  return { dir, store, id: o.order_id };
}
const gmail = () => ({ createDraft: async () => ({ draftId: "d1" }), sendDraft: async () => ({}) });
const run = (store, w, packager) => createRepairEngine({ store, adapters: { static: w.adapter }, auditor: w.auditor, browserValidator: w.browserValidator,
  requireBrowser: true, autoDeliver: true, gmail: gmail(), packager, now: () => T0 }).processAll();
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];

test("Workflow: Paket nach bestandenem Gate (NETLIFY_READY), Auftrag COMPLETED, Dashboard zeigt Paket ohne VPS-Pfad", BROWSER, async () => {
  const { store, id, dir } = setup();
  const events = [], art = tmp("jarvis-p59-art-");
  await run(store, world({ exportFiles: exportVia(staticSite()).exportFiles, events }), createPackager({ artifactsDir: art, browserCheck: browserCheck() }));
  const o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED", o.blocked_reason);
  assert.deepEqual(events, ["fix", "export"], "Export erst nach Fix + Retest + Gate");
  assert.equal(o.package.status, "NETLIFY_READY");
  const pub = publicRepairOrders(dir).orders.find((x) => x.order_id === id).package;
  assert.deepEqual(Object.keys(pub).sort(), ["file", "file_count", "netlify_ready", "sha256_short", "size", "status"]);
  assert.equal(pub.file, NETLIFY_ZIP); assert.equal(pub.sha256_short, o.package.sha256.slice(0, 12)); assert.equal(pub.netlify_ready, true);
  assert.ok(!JSON.stringify(publicRepairOrders(dir)).includes(art), "kein interner Pfad");
});

test("Workflow: Adapter ohne Webroot-Export → EXPORT_NOT_AVAILABLE, Auftrag bleibt erfolgreich; Packer-Absturz ebenso", async () => {
  for (const packager of [createPackager({ artifactsDir: tmp("jarvis-p59-art-") }), { create: async () => { throw new Error("boom"); } }, null]) {
    const { store, id } = setup();
    await run(store, world(), packager);
    const o = readOrder(store, id);
    assert.equal(o.state, "COMPLETED", o.blocked_reason);
    assert.equal(o.package.status, "EXPORT_NOT_AVAILABLE");
  }
});

test("Workflow: Regression → Rollback → kein Paket (nie vor dem Regression-Gate)", async () => {
  const { store, id } = setup();
  const events = [], art = tmp("jarvis-p59-art-");
  await run(store, world({ regress: true, events, exportFiles: exportVia(staticSite()).exportFiles }), createPackager({ artifactsDir: art }));
  const o = readOrder(store, id);
  assert.equal(o.state, "REPAIR_FAILED");
  assert.ok(!events.includes("export")); assert.equal(o.package, undefined);
  assert.deepEqual(fs.readdirSync(art), []);
});

test("Download-Skript: strikte Order-ID, nur Artifact-Verzeichnis, SHA-Prüfung, keine Secret-Abfrage", () => {
  const s = fs.readFileSync(new URL("../scripts/download-repair-package.ps1", import.meta.url), "utf8");
  assert.match(s, /-cnotmatch '\^RF480-\\d\{8\}-\[0-9a-f\]\{6\}\$'/);
  assert.match(s, /\$remoteDir = "\/opt\/jarvis-repair\/artifacts\/\$OrderId"/);
  assert.match(s, /Get-FileHash -Algorithm SHA256/);
  assert.match(s, /BatchMode=yes/);
  assert.match(s, /-cnotin @\("website-netlify-ready\.zip", "website-repaired-backup\.zip"\)/);
  assert.ok(!/Read-Host|Get-Credential|password/i.test(s), "fragt keine Secrets ab");
  assert.match(s, /exports\\repair-packages\\\$OrderId/);
});
