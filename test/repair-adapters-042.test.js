// AUTHORIZED REPAIR ADAPTERS (TF-042): WordPress REST, SFTP, SSH/SFTP, Router, Capability-Modell, Issue→Fix-Matrix, Backup vor
// jedem Write, Minimal-Fix, Validierung, Rollback, Domain-Bindung, Payment/Auth-Gate, geschützte Bereiche, Secret-Sicherheit.
// Nur Attrappen: WordPress über Mock-fetch, SFTP als In-Memory-Dateisystem, SSH als Spion – keine Netzwerkverbindung, keine echte
// Website, keine echte Mail, keine echte Zahlung, keine echten Zugangsdaten (der Marker wird je Lauf zufällig erzeugt).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, authorizeRepair, createRepairEngine, completeOrder, publicRepairOrders, BLOCKED_STATES } from "../repair-workflow.js";
import { consentText, tokenHash } from "../access-intake-api.js";
import { applyAccessSubmission, accessKeys, sealEnvelope, hasAccessSecret, ACCESS_VAULT_DIR, ACCESS_KEY_FILE } from "../access-intake.js";
import { cleanRepair } from "../server-control.js";
import { CAPABILITIES, ISSUE_FIX_MATRIX, fixSpecFor, patchReference, sanitizeText, MAX_AUTO_FIXES_PER_ORDER, sha256 } from "../repair-adapters/common.js";
import { wordpressAdapter, WP_WRITE_PATH_RE, resolveApiBase } from "../repair-adapters/wordpress.js";
import { sftpAdapter, sandboxPath, resolveSafe, validateRemoteRoot } from "../repair-adapters/sftp.js";
import { sshAdapter, assertSafeArgv, checkArgv, validateChecks } from "../repair-adapters/ssh.js";
import { routeRepair, createAdapterRegistry, bridgeAdapter, setAccessProfile, loadAccessProfiles, ACCESS_PROFILES_FILE } from "../repair-adapters/router.js";
import { githubNetlifyAdapter } from "../repair-adapters/github-netlify.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T12:00:00Z");
const MARKER = "MRK" + crypto.randomBytes(12).toString("hex"); // künstliches Test-Credential, je Lauf neu
const HOST_KEY = "SHA256:" + "Q".repeat(43);
const WEBROOT = "/home/kunde/www";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-adp42-"));
const ISSUE = (url = "https://muster.ch/team-alt", over = {}) => ({ type: "broken_link", url, page: "https://muster.ch/", label: "Unser Team",
  evidence: "HTTP 404 (verlinkt auf https://muster.ch/)", severity: "medium", detectedAt: T0.toISOString(), ...over });
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const okRetester = () => { const urls = []; const fn = async (u) => { urls.push(u); return { ok: true, method: "Playwright", desktop: { ok: true, viewport: "Desktop 1440×900", problems: [] }, mobile: { ok: true, viewport: "Smartphone 390×844", problems: [] } }; }; fn.urls = urls; return fn; };

// Antwort-Attrappe im fetch-Format.
const res = (status, body, { url, headers = {} } = {}) => ({ status, url, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => { if (typeof body === "string") throw new Error("kein JSON"); return body; }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

// ---------- Auftrag mit sicher übermitteltem Zugang (echter Tresor, echte Prüfung von access-intake.js) ----------
function orderWithAccess(store, dir, { access_type, payload, domain = "muster.ch", payChf = 480 }) {
  const o = createRepairOrder(store, { domain, website: `https://${domain}/`, company: "Muster AG", delivery_email: "kunde@muster.ch", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: payChf, reference: `Test-${o.order_id}`, now: T0 });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const token = "t".repeat(43);
  Object.assign(data.orders[o.order_id], { state: "ACCESS_REQUESTED", access_request: { token_hash: tokenHash(token), expires_at: new Date(+T0 + 72 * 3600e3).toISOString(), sent_at: T0.toISOString(), draft_id: "d1" } });
  store.write(REPAIR_ORDERS_FILE, data);
  const envelope = sealEnvelope({ access_type, ...payload }, accessKeys(dir).publicKeyPem);
  const r = applyAccessSubmission(store, { order_id: o.order_id, token_hash: tokenHash(token), domain,
    submission: { submitted_at: T0.toISOString(), access_domain: domain, consent: true, consent_text: consentText(domain), access_type, envelope } }, { now: T0 });
  assert.ok(r.ok, r.reason);
  return o.order_id;
}

// ---------- WordPress-Welt (Mock-REST + öffentliche Seite) ----------
const HOME_RAW = '<!-- wp:navigation-link {"url":"/team-alt"} /--><p><a href="/team-alt">Unser Team</a> · <a href="/kontakt/">Kontakt</a></p>';
function wpWorld({ caps = { edit_pages: true, edit_published_pages: true }, redirectTo = null, regress = false, failRestore = false, extraPages = [] } = {}) {
  const pages = { 12: { id: 12, slug: "home", title: { raw: "Startseite" }, content: { raw: HOME_RAW }, modified_gmt: "2026-10-01T00:00:00" },
    7: { id: 7, slug: "team", link: "https://muster.ch/team/", title: { raw: "Team" }, content: { raw: "<p>Team</p>" }, modified_gmt: "2026-10-01T00:00:00" } };
  for (const p of extraPages) pages[p.id] = p;
  const calls = [];
  let posts = 0;
  const fetchFn = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url, auth: !!init.headers?.authorization });
    const u = new URL(url);
    if (u.pathname.startsWith("/wp-json")) {
      const p = u.pathname.slice("/wp-json".length) || "/";
      if (p === "/") return res(200, { namespaces: ["oembed/1.0", "wp/v2"] }, { url });
      if (p === "/wp/v2/users/me") return res(200, { id: 3, capabilities: caps }, { url });
      if (/^\/wp\/v2\/(pages|posts)$/.test(p) && u.searchParams.get("slug")) {
        const list = p.endsWith("pages") ? Object.values(pages).filter((x) => x.slug === u.searchParams.get("slug")) : [];
        return res(200, list.map((x) => ({ id: x.id, slug: x.slug, link: x.link || `https://muster.ch/${x.slug}/` })), { url });
      }
      if (p === "/wp/v2/pages") return res(200, Object.values(pages), { url, headers: { "x-wp-totalpages": "1" } });
      if (p === "/wp/v2/posts" || p === "/wp/v2/navigation") return res(200, [], { url, headers: { "x-wp-totalpages": "1" } });
      if (p === "/wp/v2/media") return res(200, [], { url });
      const m = p.match(/^\/wp\/v2\/pages\/(\d+)$/);
      if (m && pages[m[1]]) {
        if (method === "POST") {
          posts++;
          if (failRestore && posts > 1) return res(500, {}, { url });
          pages[m[1]].content.raw = JSON.parse(init.body).content;
        }
        return res(200, pages[m[1]], { url });
      }
      return res(404, {}, { url });
    }
    // Öffentliche Seiten (passiv).
    if (redirectTo) return res(200, "<html>fremd</html>", { url: redirectTo });
    if (u.pathname === "/") return res(200, `<html><body>${pages[12].content.raw}</body></html>`, { url });
    if (u.pathname === "/team/") return res(200, "<html><body>Team</body></html>", { url });
    return res(404, "nicht gefunden", { url });
  };
  const repaired = () => !pages[12].content.raw.includes("/team-alt");
  const auditor = { audit: async (website) => ({ website, reachable: true, finalUrl: website, title: "Muster AG", requests: 2,
    issues: [...(repaired() ? [] : [ISSUE()]), ...(regress && repaired() ? [ISSUE("https://muster.ch/neu-kaputt", { type: "broken_image", severity: "high" })] : [])],
    pages: { home: '<html><head><meta name=viewport content=x><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head><body>wp</body></html>' } }) };
  return { pages, calls, fetchFn, auditor, repaired };
}
const WP_PAYLOAD = { host: "https://muster.ch", username: "jarvis-temp", secret: MARKER };

async function wpEngine(world, { dir, store, logs = [] }) {
  const reg = await createAdapterRegistry({ dir, store, fetchFn: world.fetchFn, legacy: {}, contracts: { wordpress: wordpressAdapter({ dir, fetchFn: world.fetchFn }) } });
  const retester = okRetester();
  const engine = createRepairEngine({ store, adapters: reg.adapters, router: reg.router, auditor: world.auditor, retester, now: () => T0,
    log: (level, event, data) => logs.push(JSON.stringify({ level, event, data })) });
  return { engine, reg, retester, logs };
}

// ---------- In-Memory-SFTP (Dateien, Symlinks, posix-rename) ----------
function memSftp({ files = {}, symlinks = {}, atomic = true } = {}) {
  const F = new Map(Object.entries(files).map(([k, v]) => [k, { data: Buffer.from(v), mode: 0o100644, mtime: 1760000000 }]));
  const calls = [];
  const norm = (p) => path.posix.normalize(p).replace(/(.)\/$/, "$1");
  const real = (p) => {
    const parts = norm(p).split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur += "/" + parts[i];
      if (symlinks[cur]) return real(symlinks[cur] + (i + 1 < parts.length ? "/" + parts.slice(i + 1).join("/") : ""));
    }
    return cur || "/";
  };
  const isDir = (p) => p === "/" || [...F.keys(), ...Object.keys(symlinks)].some((k) => k.startsWith(p + "/"));
  const st = (p) => {
    const f = F.get(p);
    if (f) return { isSymlink: false, isDir: false, isFile: true, mode: f.mode, size: f.data.length, mtime: f.mtime };
    if (isDir(p)) return { isSymlink: false, isDir: true, isFile: false, mode: 0o40755 };
    const e = new Error("No such file"); e.code = 2; throw e;
  };
  const client = {
    calls, F,
    realpath: async (p) => real(p),
    lstat: async (p) => (symlinks[norm(p)] ? { isSymlink: true, isDir: false, isFile: false, mode: 0o120777 } : st(real(p))),
    stat: async (p) => st(real(p)),
    readFile: async (p) => { calls.push(["read", p]); const f = F.get(real(p)); if (!f) throw new Error("No such file"); return Buffer.from(f.data); },
    writeFile: async (p, data, { mode } = {}) => { calls.push(["write", p]); F.set(real(p), { data: Buffer.from(data), mode: mode != null ? 0o100000 | mode : 0o100644, mtime: 1760000001 }); },
    rename: async (a, b) => { if (!atomic) throw new Error("rename unsupported"); calls.push(["rename", a, b]); F.set(real(b), F.get(real(a))); F.delete(real(a)); },
    unlink: async (p) => { calls.push(["unlink", p]); if (!F.delete(real(p))) throw new Error("No such file"); },
    chmod: async (p, mode) => { const f = F.get(real(p)); if (f) f.mode = 0o100000 | mode; },
    readdir: async (p) => {
      const r = real(p);
      const names = new Map();
      for (const k of [...F.keys(), ...Object.keys(symlinks)]) {
        if (!k.startsWith(r + "/")) continue;
        const rest = k.slice(r.length + 1).split("/");
        const full = r + "/" + rest[0];
        names.set(rest[0], rest.length > 1 ? { isSymlink: false, isDir: true, isFile: false } : symlinks[full] ? { isSymlink: true, isDir: false, isFile: false } : st(full));
      }
      return [...names].map(([filename, attrs]) => ({ filename, attrs }));
    },
    close: async () => {},
  };
  return client;
}
const INDEX_HTML = '<html><body><nav><a href="/team-alt">Unser Team</a><a href="/kontakt.html">Kontakt</a></nav></body></html>';
function fileWorld({ atomic = true, regress = false, extraFiles = {}, symlinks = {} } = {}) {
  const fsm = memSftp({ files: { [`${WEBROOT}/index.html`]: INDEX_HTML, [`${WEBROOT}/team.html`]: "<html>Team</html>", [`${WEBROOT}/kontakt.html`]: "<html>Kontakt</html>", ...extraFiles }, symlinks, atomic });
  const index = () => fsm.F.get(`${WEBROOT}/index.html`).data.toString("utf8");
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === "/") return res(200, index(), { url });
    const f = fsm.F.get(WEBROOT + u.pathname);
    return f ? res(200, f.data.toString("utf8"), { url }) : res(404, "nicht gefunden", { url });
  };
  const repaired = () => !index().includes("/team-alt");
  const auditor = { audit: async (website) => ({ website, reachable: true, finalUrl: website, title: "Muster AG", requests: 2,
    issues: [...(repaired() ? [] : [ISSUE()]), ...(regress && repaired() ? [ISSUE("https://muster.ch/neu-kaputt", { type: "broken_image", severity: "high" })] : [])],
    pages: { home: "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" } }) };
  return { fsm, fetchFn, calls, auditor, index, repaired };
}
const FILE_PAYLOAD = (scheme) => ({ host: `${scheme}://files.hoster-test.ch`, username: "kunde", secret: MARKER });
async function fileEngine(world, { dir, store, logs = [], sshExec = null }) {
  const execCalls = [];
  const connect = async () => world.fsm;
  const sshConnect = async () => ({ sftp: world.fsm, exec: async (argv) => { assertSafeArgv(argv); execCalls.push(argv); return { exit_code: sshExec ? sshExec(argv) : 0 }; }, close: async () => {} });
  const reg = await createAdapterRegistry({ dir, store, fetchFn: world.fetchFn, legacy: {}, contracts: {
    sftp: sftpAdapter({ dir, connect, fetchFn: world.fetchFn }), ssh: sshAdapter({ dir, connect: sshConnect, fetchFn: world.fetchFn }) } });
  const engine = createRepairEngine({ store, adapters: reg.adapters, router: reg.router, auditor: world.auditor, retester: okRetester(), now: () => T0,
    log: (level, event, data) => logs.push(JSON.stringify({ level, event, data })) });
  return { engine, reg, execCalls };
}
const profile = (store, extra = {}) => setAccessProfile(store, "muster.ch", { remote_root: WEBROOT, host_key_sha256: HOST_KEY, ...extra });
// Alle Klartext-Dateien im Worker-Verzeichnis (Tresor = nur Chiffrat, Private Key ausgenommen).
const plainFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => !f.startsWith(ACCESS_VAULT_DIR) && f !== ACCESS_KEY_FILE && fs.statSync(path.join(dir, f)).isFile())
  .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
const assertNoSecret = (label, text) => {
  for (const v of [MARKER, Buffer.from(`jarvis-temp:${MARKER}`).toString("base64"), Buffer.from(`kunde:${MARKER}`).toString("base64")])
    assert.ok(!String(text).includes(v), `${label} enthält Zugangsdaten`);
};

// =====================================================================================================================
// Contract, Capabilities, Matrix
// =====================================================================================================================
test("Contract + Capability-Modell: alle Adapter melden ihre tatsächlichen Fähigkeiten und haben den gemeinsamen Contract", () => {
  assert.deepEqual(CAPABILITIES, ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK", "BUILD_TEST", "HEALTH_CHECK"]);
  const dir = tmp();
  for (const a of [wordpressAdapter({ dir }), sftpAdapter({ dir, connect: async () => { throw new Error("kein Netz"); } }), sshAdapter({ dir, connect: async () => { throw new Error("kein Netz"); } })]) {
    for (const m of ["checkAccess", "backup", "locate", "applyFix", "validate", "deployProduction", "rollback", "cleanup", "detectCapabilities"]) assert.equal(typeof a[m], "function", `${a.stack}.${m}`);
    assert.ok(a.detectCapabilities().every((c) => CAPABILITIES.includes(c)));
  }
  assert.ok(wordpressAdapter({ dir }).detectCapabilities().includes("REST_CONTENT_WRITE"));
  assert.ok(!wordpressAdapter({ dir }).detectCapabilities().includes("WRITE_FILES"));
  assert.ok(sshAdapter({ dir }).detectCapabilities().includes("BUILD_TEST"));
});

test("Issue→Fix-Matrix: nur Verweis-/Asset-Fixes automatisch; Zertifikat, DNS, Security, Auth NIE", () => {
  for (const t of ["broken_link", "contact_page_broken", "navigation_broken", "broken_image", "missing_asset"]) assert.ok(fixSpecFor(t), t);
  for (const t of ["https_certificate", "certificate_error", "dns", "server_security", "authentication", "redirect_loop", "no_https", "contact_form_broken"]) assert.equal(fixSpecFor(t), null, t);
  assert.deepEqual(ISSUE_FIX_MATRIX.mobile_overflow.families, ["files"]);
  assert.equal(MAX_AUTO_FIXES_PER_ORDER, 10);
});

test("Minimal-Patch: genau das kaputte href (Pfad + absolute URL + Block-JSON), sonst nichts; Fliesstext-Treffer → nicht eindeutig", () => {
  const p = patchReference(HOME_RAW, { attr: "href", brokenPath: "/team-alt", replacement: "/team/", domain: "muster.ch", blockJson: true });
  assert.equal(p.ok, true);
  assert.equal(p.text, HOME_RAW.split("/team-alt").join("/team/"));
  assert.equal(p.count, 2);
  const abs = patchReference('<a href="https://www.muster.ch/team-alt">T</a>', { attr: "href", brokenPath: "/team-alt", replacement: "/team/", domain: "muster.ch" });
  assert.equal(abs.text, '<a href="https://www.muster.ch/team/">T</a>');
  assert.equal(patchReference('<a href="/team-alt">x</a> siehe /team-alt', { attr: "href", brokenPath: "/team-alt", replacement: "/team/", domain: "muster.ch" }).reason, "ambiguous_location");
  assert.equal(patchReference('<a href="/team-alt-2">x</a>', { attr: "href", brokenPath: "/team-alt", replacement: "/team/", domain: "muster.ch" }).reason, "not_found"); // kein Teiltreffer
  assert.equal(patchReference('<img src="/team-alt">', { attr: "href", brokenPath: "/team-alt", replacement: "/team/", domain: "muster.ch" }).reason, "ambiguous_location"); // anderes Attribut
});

// =====================================================================================================================
// WordPress
// =====================================================================================================================
test("WordPress Access: HTTPS Pflicht, Domain-Bindung, gültige Auth → OK mit Capabilities; read-only → kein Repair", async () => {
  const dir = tmp();
  const order = { order_id: "RF480-20261012-aaaaaa", domain: "muster.ch" };
  assert.equal(resolveApiBase({ host: "http://muster.ch" }, order).error, "https_required");
  assert.equal(resolveApiBase({ host: "https://andere-firma.ch/wp-json" }, order).error, "domain_mismatch");
  const w = wpWorld();
  const a = wordpressAdapter({ dir, fetchFn: w.fetchFn });
  assert.deepEqual(await a.checkAccess(order, { host: "https://andere-firma.ch", username: "u", password: MARKER }), { ok: false, reason: "domain_mismatch" });
  const ok = await a.checkAccess(order, { host: "https://muster.ch", username: "u", password: MARKER });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.capabilities, ["REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK", "HEALTH_CHECK"]);
  const ro = wordpressAdapter({ dir, fetchFn: wpWorld({ caps: { read: true } }).fetchFn });
  const r = await ro.checkAccess(order, { host: "https://muster.ch", username: "u", password: MARKER });
  assert.deepEqual([r.ok, r.reason], [false, "read_only"]);
  assert.ok(!w.calls.some((c) => c.method !== "GET"), "Access-Check schreibt nie");
});

test("WordPress E2E (Mock): CHF 240 → Zugang → Freigabe → Backup → Broken Link → EIN Minimal-Fix → Validierung → Desktop/Mobile → COMPLETED", async () => {
  const dir = tmp(), store = createStore(dir), w = wpWorld(), logs = [];
  const id = orderWithAccess(store, dir, { access_type: "wordpress_cms", payload: WP_PAYLOAD });
  const { engine, retester } = await wpEngine(w, { dir, store, logs });
  await engine.processAll();
  let o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.equal(o.route.adapter, "wordpress");
  assert.equal(o.access.connector, "wordpress_rest");
  assert.ok(o.access.capabilities.includes("REST_CONTENT_WRITE"));
  // Genau EIN Write, nur auf das betroffene Objekt; nur das kaputte href (+ Block-Attribut) geändert.
  const writes = w.calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => new URL(c.url).pathname), ["/wp-json/wp/v2/pages/12"]);
  assert.equal(w.pages[12].content.raw, HOME_RAW.split("/team-alt").join("/team/"));
  // Plan + Backup: before_hash, Rollback-Repräsentation (Originalinhalt) vorhanden.
  assert.equal(o.plan.length, 1);
  assert.deepEqual([o.plan[0].adapter, o.plan[0].before_hash, o.plan[0].risk], ["wordpress", sha256(HOME_RAW), "niedrig"]);
  for (const k of ["issue", "capability", "target", "planned_change", "validation", "rollback"]) assert.ok(o.plan[0][k], k);
  const bk = JSON.parse(fs.readFileSync(path.join(dir, "repair_backups", `${id}.json`), "utf8")).entries;
  assert.equal(bk.length, 1);
  assert.deepEqual([bk[0].object_type, bk[0].object_id, bk[0].original_hash, Buffer.from(bk[0].original_content, "base64").toString()], ["wp_pages", "12", sha256(HOME_RAW), HOME_RAW]);
  assert.ok(bk[0].backup_created_at && bk[0].modified_at && bk[0].after_hash);
  assert.deepEqual([o.retest.desktop.ok, o.retest.mobile.ok], [true, true]);
  assert.match(o.retest.desktop.method, /1440×900/); assert.match(o.retest.mobile.method, /390×844/);
  assert.equal(o.deployment.deployed, true);
  assert.equal(o.deployment.live_retest_ok, true);
  assert.ok(retester.urls.length >= 1);
  // Kein Plugin-/Theme-/User-/Settings-Write.
  assert.ok(!w.calls.some((c) => c.method !== "GET" && /plugins|themes|users|settings/.test(c.url)));
  completeOrder(store, id, { now: T0 });
  o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED");
  assert.equal(o.access_intake.status, "DESTROYED");
  assert.equal(o.access_intake.revoked_required, true);
  assert.equal(hasAccessSecret(dir, id), false);
  // Kundenbericht: Probleme, Retest, Hinweis auf temporären Zugang – keine Interna.
  assert.ok(o.report.body.includes("Desktop") && o.report.body.includes("Smartphone") && o.report.body.includes("temporären Zugang"));
  for (const v of [id, "wp:", "pages/12", "repair_backups", "B" + bk[0].backup_id.slice(1), MARKER, "jarvis-temp", "wp-json"]) assert.ok(!o.report.body.includes(v), `Bericht enthält ${v}`);
});

test("WordPress: Regression → sofort Rollback (Original exakt wiederhergestellt, erneut geprüft) → REPAIR_FAILED, Tresor zerstört", async () => {
  const dir = tmp(), store = createStore(dir), w = wpWorld({ regress: true });
  const id = orderWithAccess(store, dir, { access_type: "wordpress_cms", payload: WP_PAYLOAD });
  const { engine } = await wpEngine(w, { dir, store });
  await engine.processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "REPAIR_FAILED", o.blocked_reason);
  assert.equal(w.pages[12].content.raw, HOME_RAW);
  assert.deepEqual([o.regression.rolled_back, o.regression.rollback_verified], [true, true]);
  assert.equal(o.access_intake.status, "DESTROYED");
  assert.equal(hasAccessSecret(dir, id), false);
});

test("WordPress: Rollback scheitert → MANUAL_REVIEW_REQUIRED + Chris informiert", async () => {
  const dir = tmp(), store = createStore(dir), w = wpWorld({ regress: true, failRestore: true }), logs = [];
  const id = orderWithAccess(store, dir, { access_type: "wordpress_cms", payload: WP_PAYLOAD });
  const { engine } = await wpEngine(w, { dir, store, logs });
  await engine.processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(o.alerts.at(-1).kind, "rollback_failed");
  assert.ok(logs.some((l) => l.includes("repair_chris_alert")));
});

test("WordPress: read-only Zugang → BLOCKED_NO_ACCESS, 0 Writes", async () => {
  const dir = tmp(), store = createStore(dir), w = wpWorld({ caps: { read: true } });
  const id = orderWithAccess(store, dir, { access_type: "wordpress_cms", payload: WP_PAYLOAD });
  const { engine } = await wpEngine(w, { dir, store });
  await engine.processAll();
  assert.equal(readOrder(store, id).state, "BLOCKED_NO_ACCESS");
  assert.equal(w.calls.filter((c) => c.method !== "GET").length, 0);
});

test("WordPress: Domain-Mismatch (Weiterleitung auf fremde Domain) vor dem Write → STOP, 0 Writes", async () => {
  const dir = tmp(), w = wpWorld();
  const a = wordpressAdapter({ dir, fetchFn: w.fetchFn });
  const order = { order_id: "RF480-20261012-bbbbbb", domain: "muster.ch", website: "https://muster.ch/", customer_authorized_repair: true, authorization: { authorized_domain: "muster.ch" } };
  const cred = { host: "https://muster.ch", username: "u", password: MARKER };
  const loc = await a.locate(ISSUE(), order, cred);
  assert.ok(loc && loc.objects.length === 1);
  const redirected = wordpressAdapter({ dir, fetchFn: wpWorld({ redirectTo: "https://boese-firma.ch/" }).fetchFn });
  const r = await redirected.applyFix(ISSUE(), loc, order, cred);
  assert.deepEqual([r.ok, r.domain_mismatch], [false, true]);
  const wrongAuth = await a.applyFix(ISSUE(), loc, { ...order, authorization: { authorized_domain: "andere.ch" } }, cred);
  assert.equal(wrongAuth.domain_mismatch, true);
  assert.equal(w.calls.filter((c) => c.method !== "GET").length, 0);
});

test("WordPress: geschützte Seite → kein Write; unbekannte Ursache → MANUAL_REVIEW_REQUIRED; kein Plugin/Theme/User-Write möglich", async () => {
  const dir = tmp();
  const order = { order_id: "RF480-20261012-cccccc", domain: "muster.ch", website: "https://muster.ch/", customer_authorized_repair: true, authorization: { authorized_domain: "muster.ch" } };
  const cred = { host: "https://muster.ch", username: "u", password: MARKER };
  // Verweis liegt (nur) auf dem Impressum → nie automatisch.
  const w = wpWorld({ extraPages: [{ id: 30, slug: "impressum", title: { raw: "Impressum" }, content: { raw: '<a href="/team-alt">Team</a>' } }] });
  w.pages[12].content.raw = "<p>ohne Verweis</p>";
  const a = wordpressAdapter({ dir, fetchFn: w.fetchFn });
  assert.equal(await a.locate(ISSUE(), order, cred), null);
  assert.equal(await a.locate(ISSUE("https://muster.ch/team-alt", { page: "https://muster.ch/datenschutz/" }), order, cred), null);
  // Ziel existiert nicht eindeutig → null (nie raten); Engine-E2E → MANUAL_REVIEW_REQUIRED ohne Write.
  assert.equal(await a.locate(ISSUE("https://muster.ch/gibt-es-nicht"), order, cred), null);
  const dir2 = tmp(), store2 = createStore(dir2), w2 = wpWorld();
  w2.auditor.audit = async (website) => ({ website, reachable: true, finalUrl: website, requests: 1, issues: [ISSUE("https://muster.ch/gibt-es-nicht")],
    pages: { home: '<html><link href="/wp-content/x.css"></html>' } });
  const id = orderWithAccess(store2, dir2, { access_type: "wordpress_cms", payload: WP_PAYLOAD });
  const { engine } = await wpEngine(w2, { dir: dir2, store: store2 });
  await engine.processAll();
  assert.equal(readOrder(store2, id).state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(w2.calls.filter((c) => c.method !== "GET").length, 0);
  // Schreib-Allowlist: nur pages/posts/navigation per ID.
  for (const p of ["/wp/v2/plugins", "/wp/v2/plugins/akismet", "/wp/v2/themes/x", "/wp/v2/users/1", "/wp/v2/users", "/wp/v2/settings", "/wp/v2/media/5", "/wc/v3/products/1"]) assert.ok(!WP_WRITE_PATH_RE.test(p), p);
  assert.ok(WP_WRITE_PATH_RE.test("/wp/v2/pages/12"));
  const evil = { family: "content", attr: "href", brokenPath: "/team-alt", replacement: "/team/", objects: [{ object_type: "plugins", object_id: 1, before_hash: "x" }] };
  await assert.rejects(() => wordpressAdapter({ dir, fetchFn: wpWorld().fetchFn }).applyFix(ISSUE(), evil, order, cred), /nicht erlaubt/);
});

// =====================================================================================================================
// SFTP
// =====================================================================================================================
test("SFTP Sandbox: remote_root Pflicht; ../, absolute Escape, /etc, /root, .ssh, .env, Symlink-Escape blockiert", async () => {
  assert.equal(validateRemoteRoot(undefined).reason, "remote_root_missing");
  for (const r of ["/", "/etc", "/etc/nginx", "/root", "/root/www", "/usr/share/www", "/home", "/home/kunde"]) assert.equal(validateRemoteRoot(r).ok, false, r);
  assert.equal(validateRemoteRoot(WEBROOT).ok, true);
  for (const bad of ["../etc/passwd", "sub/../../x", "/etc/passwd", "/root/.bashrc", "/home/andere/www/index.html", ".ssh/authorized_keys", "a/.ssh/id_rsa", ".env", ".env.local", ".htaccess", "wp-config.php", "key.pem"])
    assert.throws(() => sandboxPath(WEBROOT, bad), /verweigert|ausserhalb|Traversal|Geschützte/, bad);
  assert.equal(sandboxPath(WEBROOT, "index.html"), `${WEBROOT}/index.html`);
  assert.equal(sandboxPath(WEBROOT, `${WEBROOT}/sub/a.html`), `${WEBROOT}/sub/a.html`);
  const fsm = memSftp({ files: { [`${WEBROOT}/index.html`]: "x", "/etc/passwd": "root:x", "/home/andere/www/a.html": "y" },
    symlinks: { [`${WEBROOT}/data`]: "/etc", [`${WEBROOT}/pw.html`]: "/etc/passwd", [`${WEBROOT}/nachbar`]: "/home/andere/www" } });
  await assert.rejects(() => resolveSafe(fsm, WEBROOT, "data/passwd"), /Symlink-Escape/);
  await assert.rejects(() => resolveSafe(fsm, WEBROOT, "pw.html"), /Symlink-Escape/);
  await assert.rejects(() => resolveSafe(fsm, WEBROOT, "nachbar/a.html"), /Symlink-Escape/);
  assert.equal((await resolveSafe(fsm, WEBROOT, "index.html")).full, `${WEBROOT}/index.html`);
  // Adapter: ohne remote_root kein Zugang; root-Login → BLOCKED_UNSAFE_ACCESS; Systemverzeichnis → unsicher.
  const dir = tmp();
  let connects = 0;
  const a = sftpAdapter({ dir, connect: async () => { connects++; return fsm; } });
  const base = { host: "files.hoster-test.ch", username: "kunde", password: MARKER, host_key_sha256: HOST_KEY };
  assert.equal((await a.checkAccess({ order_id: "RF480-20261012-dddddd" }, base)).reason, "remote_root_missing");
  assert.equal((await a.checkAccess({ order_id: "RF480-20261012-dddddd" }, { ...base, remote_root: WEBROOT, username: "root" })).blocked_state, "BLOCKED_UNSAFE_ACCESS");
  assert.equal((await a.checkAccess({ order_id: "RF480-20261012-dddddd" }, { ...base, remote_root: "/etc" })).blocked_state, "BLOCKED_UNSAFE_ACCESS");
  assert.equal((await a.checkAccess({ order_id: "RF480-20261012-dddddd" }, { ...base, remote_root: WEBROOT, host_key_sha256: null })).reason, "host_key_missing");
  assert.equal(connects, 0, "unsichere Zugänge verbinden nie");
});

test("SFTP: Read + Capabilities; ohne atomaren Rename keine ATOMIC_REPLACE/ROLLBACK-Fähigkeit", async () => {
  const dir = tmp(), order = { order_id: "RF480-20261012-eeeeee", domain: "muster.ch" };
  const cred = { host: "files.hoster-test.ch", username: "kunde", password: MARKER, remote_root: WEBROOT, host_key_sha256: HOST_KEY };
  const w = fileWorld();
  const a = sftpAdapter({ dir, connect: async () => w.fsm, fetchFn: w.fetchFn });
  const r = await a.checkAccess(order, cred);
  assert.equal(r.ok, true);
  assert.deepEqual(r.capabilities.sort(), ["ATOMIC_REPLACE", "BACKUP", "HEALTH_CHECK", "READ_FILES", "ROLLBACK", "WRITE_FILES"]);
  assert.equal(await a._internals.readText(w.fsm, WEBROOT, "index.html"), INDEX_HTML);
  assert.ok(![...w.fsm.F.keys()].some((k) => k.includes("jarvis-probe")), "Probe-Dateien entfernt");
  const noAtomic = fileWorld({ atomic: false });
  const r2 = await sftpAdapter({ dir, connect: async () => noAtomic.fsm }).checkAccess(order, cred);
  assert.ok(r2.ok && !r2.capabilities.includes("ATOMIC_REPLACE") && !r2.capabilities.includes("ROLLBACK"));
});

test("SFTP E2E (Fixture): CHF 240 → Zugang → Freigabe → Backup → HTML-Link-Fix → Temp-Upload → atomarer Rename → Validierung → Retest → COMPLETED", async () => {
  const dir = tmp(), store = createStore(dir), w = fileWorld(), logs = [];
  profile(store);
  const id = orderWithAccess(store, dir, { access_type: "sftp", payload: FILE_PAYLOAD("sftp") });
  const { engine } = await fileEngine(w, { dir, store, logs });
  await engine.processAll();
  let o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.deepEqual([o.route.adapter, o.access.connector], ["sftp", "sftp"]);
  assert.equal(w.index(), INDEX_HTML.replace("/team-alt", "/team.html"));
  // Ablauf: Temp im selben Verzeichnis → atomarer Rename auf die Zieldatei.
  const ren = w.fsm.calls.filter((c) => c[0] === "rename" && c[2] === `${WEBROOT}/index.html`);
  assert.equal(ren.length, 1);
  assert.match(ren[0][1], new RegExp(`^${WEBROOT}/\\.index\\.html\\.jarvis-[0-9a-f]+\\.tmp$`));
  assert.ok(w.fsm.calls.findIndex((c) => c[0] === "write" && c[1] === ren[0][1]) < w.fsm.calls.indexOf(ren[0]));
  assert.ok(!w.fsm.calls.some((c) => c[0] === "write" && c[1] === `${WEBROOT}/index.html`), "nie direkt überschrieben");
  // Hash vorher/nachher + Backup.
  const bk = JSON.parse(fs.readFileSync(path.join(dir, "repair_backups", `${id}.json`), "utf8")).entries;
  assert.deepEqual([bk[0].object_id, bk[0].original_hash, bk[0].after_hash], ["index.html", sha256(INDEX_HTML), sha256(w.index())]);
  assert.deepEqual([o.issues[o.plan[0].issue_id].before_hash, o.issues[o.plan[0].issue_id].after_hash], [sha256(INDEX_HTML), sha256(w.index())]);
  assert.equal(w.fsm.F.get(`${WEBROOT}/index.html`).mode & 0o777, 0o644, "Dateirechte unverändert");
  completeOrder(store, id, { now: T0 });
  o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED");
  assert.equal(hasAccessSecret(dir, id), false);
  for (const v of [WEBROOT, "files.hoster-test.ch", "index.html", "repair_backups", MARKER]) assert.ok(!o.report.body.includes(v), `Bericht enthält ${v}`);
});

test("SFTP: Regression → Rollback (Datei atomar wiederhergestellt, Hash = Original) → REPAIR_FAILED", async () => {
  const dir = tmp(), store = createStore(dir), w = fileWorld({ regress: true });
  profile(store);
  const id = orderWithAccess(store, dir, { access_type: "sftp", payload: FILE_PAYLOAD("sftp") });
  const { engine } = await fileEngine(w, { dir, store });
  await engine.processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "REPAIR_FAILED", o.blocked_reason);
  assert.equal(w.index(), INDEX_HTML);
  assert.equal(o.regression.rollback_verified, true);
});

test("SFTP: keine Massenänderung – mehr als 10 automatisch behebbare Befunde → MANUAL_REVIEW_REQUIRED, 0 Writes", async () => {
  const names = "abcdefghijkl".split("");
  const html = `<html><body>${names.map((n) => `<a href="/${n}-alt">${n}</a>`).join("")}</body></html>`;
  const extra = Object.fromEntries(names.map((n) => [`${WEBROOT}/${n}.html`, `<html>${n}</html>`]));
  const dir = tmp(), store = createStore(dir), w = fileWorld({ extraFiles: { ...extra, [`${WEBROOT}/index.html`]: html } });
  w.auditor.audit = async (website) => ({ website, reachable: true, finalUrl: website, requests: 1, issues: names.map((n) => ISSUE(`https://muster.ch/${n}-alt`)), pages: { home: "<html><body>s</body></html>" } });
  profile(store);
  const id = orderWithAccess(store, dir, { access_type: "sftp", payload: FILE_PAYLOAD("sftp") });
  const { engine } = await fileEngine(w, { dir, store });
  await engine.processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.match(o.blocked_reason, /mehr als 10/);
  assert.ok(!w.fsm.calls.some((c) => c[0] === "rename" && !c[2].includes(".jarvis-probe-")), "nur die Access-Probe (Temp-Dateien) darf umbenennen");
  assert.equal(w.fsm.F.get(`${WEBROOT}/index.html`).data.toString(), html);
});

// =====================================================================================================================
// SSH
// =====================================================================================================================
test("SSH: keine freie Shell – nur typisierte Funktionen; Injection (; && || | ` $() newline > <) blockiert; kein sudo/apt/useradd", () => {
  const a = sshAdapter({ dir: tmp() });
  for (const k of Object.keys(a)) assert.ok(!/^(exec|shell|run|command|spawn|eval)$/i.test(k), `Adapter darf ${k} nicht anbieten`);
  const src = fs.readFileSync(path.join(ROOT, "repair-adapters", "ssh.js"), "utf8");
  assert.ok(!/child_process|execSync|spawn\(/.test(src), "kein lokaler Prozessstart");
  for (const bad of [
    ["npm", "--prefix", "/x;rm", "run", "build"], ["npm", "run", "build&&curl"], ["npm", "run", "a||b"], ["npm", "run", "a|sh"], ["npm", "run", "`id`"],
    ["npm", "run", "$(id)"], ["npm", "run", "a\nrm"], ["npm", "run", "a>b"], ["npm", "run", "a<b"], ["npm", "run", "a b"], ["npm", "run", "${X}"],
    ["bash", "-c", "id"], ["sh", "x"], ["sudo", "npm"], ["su", "root"], ["apt", "install"], ["apk", "add"], ["yum", "install"], ["useradd", "x"],
    ["userdel", "x"], ["passwd"], ["rm", "-rf"], ["curl", "x"], ["wget", "x"], ["systemctl", "restart"], ["docker", "ps"], ["iptables", "-F"], ["chmod", "-R"], ["chown", "-R"], "npm run build", []])
    assert.throws(() => assertSafeArgv(bad), /verweigert|nicht erlaubt|Argument-Array/, JSON.stringify(bad));
  assert.deepEqual(assertSafeArgv(["npm", "--prefix", `${WEBROOT}`, "run", "build"]), ["npm", "--prefix", WEBROOT, "run", "build"]);
  // Konfigurierte Checks: nur npm/php/node in fester Form, Pfade in remote_root.
  assert.deepEqual(checkArgv({ binary: "php", args: ["-l", "index.php"] }, WEBROOT), ["php", "-l", `${WEBROOT}/index.php`]);
  for (const bad of [{ binary: "npm", args: ["install", "evil"] }, { binary: "npm", args: ["--prefix", "../..", "run", "x"] }, { binary: "php", args: ["-r", "system(1)"] },
    { binary: "node", args: ["-e", "x"] }, { binary: "npm", args: ["--prefix", "/etc", "run", "x"] }, { binary: "bash", args: ["-c", "x"] }])
    assert.throws(() => checkArgv(bad, WEBROOT), Error, JSON.stringify(bad));
  assert.throws(() => validateChecks({ build: { "x y": { binary: "npm", args: ["--prefix", WEBROOT, "test"] } } }, WEBROOT));
});

test("SSH: root-Login → BLOCKED_UNSAFE_ACCESS ohne Verbindung; Webroot-Sandbox in typisierten Funktionen; Writes nur über SFTP", async () => {
  let connects = 0;
  const w = fileWorld();
  const execCalls = [];
  const a = sshAdapter({ dir: tmp(), fetchFn: w.fetchFn, connect: async () => { connects++; return { sftp: w.fsm, exec: async (argv) => { execCalls.push(argv); return { exit_code: 0 }; }, close: async () => {} }; } });
  const cred = { host: "ssh.hoster-test.ch", username: "root", password: MARKER, remote_root: WEBROOT, host_key_sha256: HOST_KEY };
  assert.deepEqual(await a.checkAccess({ order_id: "RF480-20261012-ffffff" }, cred), { ok: false, reason: "root_login", blocked_state: "BLOCKED_UNSAFE_ACCESS" });
  assert.equal(connects, 0);
  const ops = a.typedOps({ sftp: w.fsm, exec: async (argv) => { execCalls.push(argv); return { exit_code: 0 }; } },
    { ...cred, username: "kunde", checks: { build: { build: { binary: "npm", args: ["--prefix", WEBROOT, "run", "build"] } } } });
  assert.deepEqual(Object.keys(ops).sort(), ["atomicRename", "configured", "hashFile", "listDirectory", "readFile", "runConfiguredBuildCheck", "runConfiguredHealthCheck", "statFile", "writeTempFile"].sort());
  assert.equal(await ops.readFile("index.html"), INDEX_HTML);
  assert.equal(await ops.hashFile("index.html"), sha256(INDEX_HTML));
  await assert.rejects(() => ops.readFile("../../etc/passwd"), /Traversal/);
  await assert.rejects(() => ops.readFile("/etc/passwd"), /ausserhalb/);
  await assert.rejects(() => ops.writeTempFile("index.html", "x"), /Temp/);
  await assert.rejects(() => ops.runConfiguredBuildCheck("rm -rf /"), /nicht konfiguriert/);
  await assert.rejects(() => ops.runConfiguredHealthCheck("nicht-da"), /nicht konfiguriert/);
  assert.equal((await ops.runConfiguredBuildCheck("build")).ok, true);
  assert.deepEqual(execCalls, [["npm", "--prefix", WEBROOT, "run", "build"]]);
});

test("SSH/SFTP E2E (Fixture): CHF 240 → Zugang → Freigabe → Backup → SFTP-Datei-Fix → allowlisted Health Check → Retest → COMPLETED", async () => {
  const dir = tmp(), store = createStore(dir), w = fileWorld();
  profile(store, { checks: { health: { site: { binary: "php", args: ["-l", "index.php"] } } } });
  const id = orderWithAccess(store, dir, { access_type: "ssh", payload: FILE_PAYLOAD("ssh") });
  const { engine, execCalls } = await fileEngine(w, { dir, store });
  await engine.processAll();
  let o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.deepEqual([o.route.adapter, o.access.connector], ["ssh", "ssh+sftp"]);
  assert.equal(w.index(), INDEX_HTML.replace("/team-alt", "/team.html"));
  assert.ok(w.fsm.calls.some((c) => c[0] === "rename" && c[2] === `${WEBROOT}/index.html`), "Datei-Write über SFTP (atomarer Rename)");
  assert.deepEqual(execCalls, [["php", "-l", `${WEBROOT}/index.php`]], "SSH nur für den konfigurierten Health Check");
  assert.equal(o.deployment.deploy_ref, "live:ssh+sftp");
  completeOrder(store, id, { now: T0 });
  o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED");
  assert.equal(hasAccessSecret(dir, id), false);
});

test("SSH: fehlgeschlagener Health Check nach dem Write → Rollback", async () => {
  const dir = tmp(), store = createStore(dir), w = fileWorld();
  profile(store, { checks: { health: { site: { binary: "php", args: ["-l", "index.php"] } } } });
  const id = orderWithAccess(store, dir, { access_type: "ssh", payload: FILE_PAYLOAD("ssh") });
  const { engine } = await fileEngine(w, { dir, store, sshExec: () => 1 });
  await engine.processAll();
  assert.equal(readOrder(store, id).state, "REPAIR_FAILED");
  assert.equal(w.index(), INDEX_HTML);
});

// =====================================================================================================================
// Router
// =====================================================================================================================
test("Router: GitHub+Netlify / WordPress / SFTP / SSH(+SFTP) / Hosting nach Fähigkeit; unbekannt + other → BLOCKED_UNSUPPORTED_STACK; nie probieren", () => {
  assert.equal(routeRepair({ access_type: "github_netlify" }).adapter, "github_netlify");
  assert.equal(routeRepair({ access_type: "wordpress_cms", credential_meta: { scheme: "https" } }).adapter, "wordpress");
  assert.equal(routeRepair({ access_type: "sftp", credential_meta: { scheme: "sftp" } }).adapter, "sftp");
  const checks = { checks: { build: { b: { binary: "npm", args: ["--prefix", WEBROOT, "test"] } } } };
  assert.equal(routeRepair({ access_type: "ssh", credential_meta: { scheme: "ssh" }, profile: checks }).adapter, "ssh");
  const sshNoChecks = routeRepair({ access_type: "ssh", credential_meta: { scheme: "ssh" }, detected_stack: "static" });
  assert.deepEqual([sshNoChecks.adapter, sshNoChecks.label], ["sftp", "SSH/SFTP"]); // statisch + SSH → SFTP (minimal nötige Rechte)
  assert.equal(routeRepair({ access_type: "sftp", detected_stack: "wordpress", credential_meta: { scheme: "sftp" } }).adapter, "sftp"); // Zugangsart ≠ Stack
  assert.equal(routeRepair({ access_type: "hosting", credential_meta: { scheme: "sftp" } }).adapter, "sftp");
  assert.equal(routeRepair({ access_type: "hosting", profile: { interface: "wordpress_rest" } }).adapter, "wordpress");
  assert.equal(routeRepair({ access_type: "hosting", has_mapping: true }).adapter, "github_netlify");
  for (const x of [{ access_type: "hosting" }, { access_type: "hosting", credential_meta: { scheme: "https" } }, { access_type: "other" }, { access_type: "other", has_mapping: true },
    { access_type: "sftp", credential_meta: { scheme: "https" } }, { access_type: "wordpress_cms", credential_meta: { scheme: "ftp" } }, { access_type: "unbekannt" }, { access_type: "sftp", detected_stack: "nextjs" }])
    assert.equal(routeRepair(x).state, "BLOCKED_UNSUPPORTED_STACK", JSON.stringify(x));
  // Ohne Backup+Rollback-Fähigkeit nie automatisch.
  assert.equal(routeRepair({ access_type: "sftp", capabilities: { sftp: ["READ_FILES", "WRITE_FILES"] } }).state, "MANUAL_REVIEW_REQUIRED");
  // Router-Quelltext: keine Browser-Automation, kein Login-Panel.
  const src = fs.readFileSync(path.join(ROOT, "repair-adapters", "router.js"), "utf8") + fs.readFileSync(path.join(ROOT, "repair-adapters", "wordpress.js"), "utf8");
  assert.ok(!/playwright|puppeteer|chromium|wp-login\.php|cpanel|plesk/i.test(src.replace(/\/\/.*$/gm, "")), "keine Browser-/Panel-Automation");
});

test("Router E2E: Zugangsart other → BLOCKED_UNSUPPORTED_STACK, 0 Adapter-Aufrufe; unbekanntes Hosting ebenso", async () => {
  for (const access_type of ["other", "hosting"]) {
    const dir = tmp(), store = createStore(dir), w = wpWorld();
    const id = orderWithAccess(store, dir, { access_type, payload: { host: "panel.hoster-test.ch", username: "kunde", secret: MARKER } });
    const { engine } = await wpEngine(w, { dir, store });
    await engine.processAll();
    const o = readOrder(store, id);
    assert.equal(o.state, "BLOCKED_UNSUPPORTED_STACK", access_type);
    assert.equal(w.calls.filter((c) => c.url.includes("/wp-json")).length, 0);
    assert.equal(publicRepairOrders(dir).orders[0].adapter, "UNSUPPORTED");
  }
});

test("Zugangsprofil: nur Metadaten, nie Zugangsdaten; validiert remote_root, Host-Key, wp_api_base, Checks", () => {
  const store = createStore(tmp());
  assert.throws(() => setAccessProfile(store, "muster.ch", { password: "x" }), /nicht erlaubt/);
  assert.throws(() => setAccessProfile(store, "muster.ch", { remote_root: "/etc" }), /remote_root/);
  assert.throws(() => setAccessProfile(store, "muster.ch", { host_key_sha256: "abc" }), /Host-Key/);
  assert.throws(() => setAccessProfile(store, "muster.ch", { wp_api_base: "https://u:p@muster.ch/wp-json" }), /wp_api_base/);
  assert.throws(() => setAccessProfile(store, "muster.ch", { wp_api_base: "https://andere.ch/wp-json" }), /wp_api_base/);
  assert.throws(() => setAccessProfile(store, "muster.ch", { remote_root: WEBROOT, checks: { build: { b: { binary: "bash", args: ["-c", "id"] } } } }));
  setAccessProfile(store, "www.Muster.ch", { remote_root: WEBROOT, host_key_sha256: HOST_KEY, interface: "sftp", port: 2222 });
  assert.deepEqual(Object.keys(loadAccessProfiles(store)), ["muster.ch"]);
  assert.ok(fs.readFileSync(path.join(store.dir, ACCESS_PROFILES_FILE), "utf8").length > 0);
});

test("GitHub+Netlify-Regression: bestehender Adapter bleibt unverändert in der Registry; Router wählt ihn", async () => {
  const dir = tmp(), store = createStore(dir);
  const gh = githubNetlifyAdapter({ store, env: {}, fetchFn: async () => ({ status: 404, json: async () => ({}) }) });
  const reg = await createAdapterRegistry({ dir, store, legacy: { github_netlify: gh }, contracts: {} });
  assert.equal(reg.adapters.github_netlify, gh);
  assert.equal(reg.router.route({ order: { domain: "muster.ch" }, access_type: "github_netlify", detected_stack: "static", accessCtx: {} }).adapter, "github_netlify");
  assert.ok(reg.router.capabilitiesOf("github_netlify").includes("ROLLBACK"));
});

// =====================================================================================================================
// Payment / Auth Gate
// =====================================================================================================================
function spyContract() {
  const calls = [];
  const rec = (m, r) => async () => { calls.push(m); return r; };
  return { calls, adapter: { detectCapabilities: () => ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"],
    checkAccess: rec("checkAccess", { ok: true, connector: "spy", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] }),
    backup: rec("backup", { production_ref: "p", backup_ref: "b", rollback_point: "r" }), locate: rec("locate", null), applyFix: rec("applyFix", { ok: true }),
    validate: rec("validate", { build_ok: true }), deployProduction: rec("deployProduction", { ok: true }), rollback: rec("rollback", { ok: true }), cleanup: rec("cleanup", { ok: true }) } };
}
const gateEngine = (store, spy, auditor = wpWorld().auditor) => createRepairEngine({ store, auditor, now: () => T0,
  adapters: { wordpress: bridgeAdapter("wordpress", spy.adapter), sftp: bridgeAdapter("sftp", spy.adapter) },
  router: { route: () => ({ adapter: "sftp", label: "SFTP", state: null, reason: "test" }), capabilitiesOf: () => [] } });

test("Payment/Auth: CHF 239 → 0 Adapter-Aufrufe; Anzahlung ohne Zugang → 0 Repair; Freigabe ohne Zugang → 0 Repair", async () => {
  const dir = tmp(), store = createStore(dir), spy = spyContract();
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_reply_email", reference: "Mail", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 239, reference: "R1", now: T0 });
  const eng = gateEngine(store, spy);
  await eng.processAll();
  assert.equal(readOrder(store, o.order_id).state, "PAYMENT_REQUIRED");
  assert.deepEqual(spy.calls, []);
  recordPayment(store, { order_id: o.order_id, amount_chf: 1, reference: "R2", now: T0 }); // CHF 240, Freigabe ja, aber kein sicherer Zugang
  await eng.processAll();
  assert.equal(readOrder(store, o.order_id).state, "BLOCKED_NO_ACCESS");
  assert.deepEqual(spy.calls, [], "ohne Zugang: kein Login, keine Reparatur");
});

test("Payment/Auth: Zugang ohne Freigabe → 0 Repair; Domain-Mismatch → 0 Repair; alles erfüllt → Adapter darf starten", async () => {
  // Zugang ohne Freigabe (Freigabe entzogen) und Zugang für eine andere Domain.
  for (const mutate of [(o) => { o.customer_authorized_repair = false; }, (o) => { o.access_intake.access_domain = "andere-firma.ch"; }]) {
    const dir = tmp(), store = createStore(dir), spy = spyContract();
    const id = orderWithAccess(store, dir, { access_type: "sftp", payload: FILE_PAYLOAD("sftp") });
    const data = store.read(REPAIR_ORDERS_FILE, { orders: {} }); mutate(data.orders[id]); store.write(REPAIR_ORDERS_FILE, data);
    await gateEngine(store, spy).processAll();
    assert.equal(readOrder(store, id).state, "BLOCKED_NO_AUTHORIZATION");
    assert.deepEqual(spy.calls, []);
  }
  const dir = tmp(), store = createStore(dir), spy = spyContract();
  const id = orderWithAccess(store, dir, { access_type: "sftp", payload: FILE_PAYLOAD("sftp") });
  await gateEngine(store, spy).processAll();
  assert.ok(spy.calls.includes("checkAccess") && spy.calls.includes("backup"), "Zahlung + Zugang + Freigabe + Domain → Adapter startet");
  assert.equal(spy.calls.includes("applyFix"), false, "ohne eindeutige Ursache (locate null) kein Write");
  assert.equal(readOrder(store, id).state, "MANUAL_REVIEW_REQUIRED");
});

test("Unsicherer Zugang wird eigener Blocked-Zustand; Capability fehlt → MANUAL_REVIEW_REQUIRED", async () => {
  assert.ok(BLOCKED_STATES.includes("BLOCKED_UNSAFE_ACCESS"));
  const dir = tmp(), store = createStore(dir), w = fileWorld();
  profile(store);
  const id = orderWithAccess(store, dir, { access_type: "sftp", payload: { host: "sftp://files.hoster-test.ch", username: "root", secret: MARKER } });
  await (await fileEngine(w, { dir, store })).engine.processAll();
  assert.equal(readOrder(store, id).state, "BLOCKED_UNSAFE_ACCESS");
  // Ohne atomaren Rename: Zugang ok, aber ohne ROLLBACK → keine automatische Reparatur.
  const dir2 = tmp(), store2 = createStore(dir2), w2 = fileWorld({ atomic: false });
  profile(store2);
  const id2 = orderWithAccess(store2, dir2, { access_type: "sftp", payload: FILE_PAYLOAD("sftp") });
  await (await fileEngine(w2, { dir: dir2, store: store2 })).engine.processAll();
  assert.equal(readOrder(store2, id2).state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(w2.index(), INDEX_HTML);
});

// =====================================================================================================================
// Secret-Sicherheit, Dashboard, Bankdaten
// =====================================================================================================================
test("Secrets: Test-Marker nie in Order-JSON, payments/sales/lead_registry, Logs, Dashboard, Cloud-Snapshot, Bericht, PROJECT_STATE, Git", async () => {
  const dir = tmp(), store = createStore(dir), w = wpWorld(), logs = [];
  const id = orderWithAccess(store, dir, { access_type: "wordpress_cms", payload: WP_PAYLOAD });
  const { engine } = await wpEngine(w, { dir, store, logs });
  await engine.processAll();
  completeOrder(store, id, { now: T0 });
  assert.ok(w.calls.some((c) => c.auth), "Zugangsdaten wurden zur Laufzeit verwendet");
  for (const [f, text] of plainFiles(dir)) assertNoSecret(f, text);
  for (const f of ["repair_orders.json", "payments.json", "sales.json", "lead_registry.json"]) { try { assertNoSecret(f, fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  assertNoSecret("Logs", logs.join("\n"));
  const pub = publicRepairOrders(dir);
  assertNoSecret("Dashboard", JSON.stringify(pub));
  assertNoSecret("Cloud-Snapshot", JSON.stringify(cleanRepair(pub)));
  assertNoSecret("Bericht", readOrder(store, id).report.body);
  assertNoSecret("PROJECT_STATE", fs.readFileSync(path.join(ROOT, "PROJECT_STATE.md"), "utf8"));
  let gitHit = true;
  try { execFileSync("git", ["grep", "-q", "-F", MARKER], { cwd: ROOT, stdio: "ignore" }); } catch { gitHit = false; }
  assert.equal(gitHit, false, "Marker im Git-Stand");
});

test("Secrets: Fehler werden bereinigt – Exceptions mit Zugangsdaten verlassen die Brücke nie im Klartext", async () => {
  const dir = tmp(), store = createStore(dir);
  const id = orderWithAccess(store, dir, { access_type: "sftp", payload: FILE_PAYLOAD("sftp") });
  const order = readOrder(store, id);
  const throwing = { detectCapabilities: () => [], checkAccess: async (_o, c) => { throw new Error(`login kunde:${c.password}@files.hoster-test.ch password=${c.password} Basic ${Buffer.from(`kunde:${c.password}`).toString("base64")}`); } };
  const b = bridgeAdapter("sftp", throwing);
  const { openAccessCredential } = await import("../access-intake.js");
  const ctx = { connector_type: "sftp", credential: () => openAccessCredential(dir, id) };
  await assert.rejects(() => b.checkAccess(order, ctx), (e) => { assertNoSecret("Fehler", e.message); return true; });
  const leaky = bridgeAdapter("sftp", { detectCapabilities: () => [], checkAccess: async (_o, c) => ({ ok: true, connector: c.password }) });
  await assert.rejects(() => leaky.checkAccess(order, ctx), /Zugangsdaten/);
  const KEY_HEAD = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" "), KEY_TAIL = ["-----END", "OPENSSH", "PRIVATE", "KEY-----"].join(" "); // zur Laufzeit – kein Schlüsselblock im Repo
  const keyText = sanitizeText(`x ${KEY_HEAD}\n${MARKER}\n${KEY_TAIL} token=${MARKER}`, []);
  assert.ok(!keyText.includes(MARKER) && keyText.includes("[redacted-key]"), keyText);
});

test("Dashboard: Adapter/Access/Backup/Rollback/Auto-fixable/Manual Review/Phase als Allowlist; Cloud erzwingt sie erneut", async () => {
  const dir = tmp(), store = createStore(dir), w = wpWorld();
  orderWithAccess(store, dir, { access_type: "wordpress_cms", payload: WP_PAYLOAD });
  await (await wpEngine(w, { dir, store })).engine.processAll();
  const pub = publicRepairOrders(dir);
  const o = pub.orders[0];
  assert.deepEqual([o.adapter, o.access_ok, o.backup_ok, o.rollback_ok, o.auto_fixable, o.manual_review, o.phase], ["WORDPRESS", true, true, true, 1, 0, "READY_FOR_DELIVERY"]);
  assert.deepEqual(pub.adapter_registry.adapters, ["github_netlify", "netlify_drop", "wordpress", "sftp", "ssh"]);
  const c = cleanRepair({ ...pub, orders: [{ ...o, adapter: "wordpress_rest:geheim", host: "files.hoster-test.ch", remote_root: WEBROOT, phase: "LIVE_RETEST" }] });
  assert.equal(c.orders[0].adapter, null);
  assert.equal(c.orders[0].phase, "LIVE_RETEST");
  assert.equal(c.adapter_registry.status, "ACTIVE");
  const raw = JSON.stringify(c);
  for (const v of ["files.hoster-test.ch", WEBROOT, "pages/12", "repair_backups"]) assert.ok(!raw.includes(v), v);
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  for (const s of ['id="repRegistry"', 'id="repManual"', "Auto-fixable", "Rollback", "LIVE_RETEST", "MANUAL_REVIEW"]) assert.ok(html.includes(s), s);
});

test("Bankdaten-Sicherheit + keine Mail: Adapter kennen keine Bank-/Karten-Zugänge, importieren kein Gmail; payments.js unverändert ohne Zugangsdaten", () => {
  for (const f of ["common.js", "wordpress.js", "sftp.js", "ssh.js", "router.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "repair-adapters", f), "utf8");
    assert.ok(!/gmail|sendDraft|messages\.send|smtp/i.test(src), `${f}: Mail-Verweis`);
    assert.ok(!/e-?banking|\btan\b|\bpin\b|card_number|kreditkarte|bank_session|bank_password/i.test(src.replace(/\/\/.*$/gm, "")), `${f}: Bankzugriff`);
  }
  const pay = fs.readFileSync(path.join(ROOT, "payments.js"), "utf8");
  assert.ok(!/password|passwort|\btan\b|\bpin\b|e-?banking|card_number/i.test(pay.replace(/\/\/.*$/gm, "")), "payments.js bleibt reine Metadaten-Struktur");
  const docker = fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile"), "utf8");
  assert.ok(docker.includes("package-lock.json") && docker.includes("npm ci") && docker.includes("--ignore-scripts") && docker.includes("repair-adapters"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.dependencies.ssh2, "1.17.0");
  assert.ok(!pkg.dependencies["basic-ftp"] && !pkg.dependencies.ftp, "kein FTP");
});
