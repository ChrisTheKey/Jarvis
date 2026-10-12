// AUTOMATIC REPAIR ACCESS PROFILE & PREFLIGHT (TF-043): aus dem sicher übermittelten Zugang entsteht das Zugangsprofil selbst –
// ohne «router.js --profile/--root/--host-key» für normale Aufträge, ohne eine Sicherheitsprüfung abzuschwächen.
// Nur Attrappen: SFTP als In-Memory-Dateisystem mit Login-Root, Host-Key-Probe/Verbindung als Spione, Cloud-Intake als echter
// Handler mit In-Memory-Blobs, Gmail als Attrappe. Einzige echte Verbindung: ein isolierter lokaler ssh2-Testserver (127.0.0.1)
// für die Host-Key-Erfassung. Keine Kundenserver, keine echte Mail, keine echten Zugangsdaten (Marker je Lauf zufällig).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment, paymentsForOrder, voidPayment } from "../payments.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, createRepairEngine, completeOrder, publicRepairOrders, repairOrdersStatus, ORDER_STATES } from "../repair-workflow.js";
import { createAccessIntakeHandler, memoryIntakeStore, consentText, tokenHash } from "../access-intake-api.js";
import { applyAccessSubmission, applyHostKeyConfirmation, accessKeys, sealEnvelope, openEnvelope, intakeClient, syncAccessIntake,
  ACCESS_VAULT_DIR, ACCESS_KEY_FILE } from "../access-intake.js";
import { sealForVps } from "../public/access-crypto.js";
import { cleanRepair } from "../server-control.js";
import { sftpAdapter } from "../repair-adapters/sftp.js";
import { createAdapterRegistry, setAccessProfile, effectiveProfile, ACCESS_PROFILES_FILE } from "../repair-adapters/router.js";
import { setRepairMapping } from "../repair-adapters/github-netlify.js";
import { createProfilePreflight, splitAccessPayload, ssh2HostKeyProbe, canonicalRemoteRoot, contentMatches, profileRecord, SECRET_FIELDS,
  TRUSTED_HOST_KEY_PROVIDERS } from "../repair-adapters/profile-builder.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T12:00:00Z");
const MARKER = "MRK" + crypto.randomBytes(12).toString("hex");      // künstliches Passwort
const PASSPHRASE = "PPH" + crypto.randomBytes(12).toString("hex");  // künstliche Passphrase
const PRESENTED = "SHA256:" + "Ab3".repeat(14) + "Z";               // vom (Attrappen-)Server präsentiert
const OTHER_KEY = "SHA256:" + "Qx9".repeat(14) + "Y";
const HOME_DIR = "/home/kunde";
const WEBROOT = `${HOME_DIR}/public_html`;
const SERVER = "files.hoster-test.ch";
const WT = "w".repeat(43);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-prf43-"));
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const res = (status, body, { url } = {}) => ({ status, url, headers: { get: () => null }, json: async () => JSON.parse(body), text: async () => body });
const okRetester = () => async () => ({ ok: true, method: "Playwright", desktop: { ok: true, viewport: "Desktop 1440×900", problems: [] }, mobile: { ok: true, viewport: "Smartphone 390×844", problems: [] } });
const ISSUE = { type: "broken_link", url: "https://muster.ch/team-alt", page: "https://muster.ch/", label: "Unser Team", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString() };
const INDEX_HTML = '<html><head><title>Muster AG</title></head><body><nav><a href="/team-alt">Unser Team</a><a href="/kontakt.html">Kontakt</a></nav></body></html>';
const SITE = { [`${WEBROOT}/index.html`]: INDEX_HTML, [`${WEBROOT}/team.html`]: "<html>Team</html>", [`${WEBROOT}/kontakt.html`]: "<html>Kontakt</html>", [`${WEBROOT}/css/site.css`]: "body{}" };
const PAYLOAD = (over = {}) => ({ host: `sftp://${SERVER}`, username: "kunde", secret: MARKER, ...over });

// ---------- In-Memory-SFTP mit Login-Root (realpath(".")) und Protokoll ALLER Zugriffe ----------
function memSftp({ files = {}, symlinks = {}, home = HOME_DIR } = {}) {
  const F = new Map(Object.entries(files).map(([k, v]) => [k, { data: Buffer.from(v), mode: 0o100644, mtime: 1760000000 }]));
  const calls = [];
  const norm = (p) => { const a = p === "." ? home : p.startsWith("/") ? p : path.posix.join(home, p); return path.posix.normalize(a).replace(/(.)\/$/, "$1"); };
  const real = (p) => {
    const parts = norm(p).split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i++) { cur += "/" + parts[i]; if (symlinks[cur]) return real(symlinks[cur] + (i + 1 < parts.length ? "/" + parts.slice(i + 1).join("/") : "")); }
    return cur || "/";
  };
  const isDir = (p) => p === "/" || [...F.keys(), ...Object.keys(symlinks)].some((k) => k.startsWith(p + "/"));
  const st = (p) => {
    const f = F.get(p);
    if (f) return { isSymlink: false, isDir: false, isFile: true, mode: f.mode, size: f.data.length, mtime: f.mtime };
    if (isDir(p)) return { isSymlink: false, isDir: true, isFile: false, mode: 0o40755 };
    const e = new Error("No such file"); e.code = 2; throw e;
  };
  return {
    calls, F,
    realpath: async (p) => { calls.push(["realpath", norm(p)]); return real(p); },
    lstat: async (p) => { calls.push(["lstat", norm(p)]); return symlinks[norm(p)] ? { isSymlink: true, isDir: false, isFile: false, mode: 0o120777 } : st(real(p)); },
    stat: async (p) => { calls.push(["stat", norm(p)]); return st(real(p)); },
    readFile: async (p) => { calls.push(["read", norm(p)]); const f = F.get(real(p)); if (!f) throw new Error("No such file"); return Buffer.from(f.data); },
    writeFile: async (p, data, { mode } = {}) => { calls.push(["write", norm(p)]); F.set(real(p), { data: Buffer.from(data), mode: mode != null ? 0o100000 | mode : 0o100644, mtime: 1760000001 }); },
    rename: async (a, b) => { calls.push(["rename", norm(a), norm(b)]); F.set(real(b), F.get(real(a))); F.delete(real(a)); },
    unlink: async (p) => { calls.push(["unlink", norm(p)]); if (!F.delete(real(p))) throw new Error("No such file"); },
    chmod: async (p, mode) => { const f = F.get(real(p)); if (f) f.mode = 0o100000 | mode; },
    readdir: async (p) => {
      calls.push(["readdir", norm(p)]);
      const r = real(p), names = new Map();
      for (const k of [...F.keys(), ...Object.keys(symlinks)]) {
        if (!k.startsWith(r + "/")) continue;
        const rest = k.slice(r.length + 1).split("/"), full = r + "/" + rest[0];
        names.set(rest[0], rest.length > 1 && !symlinks[full] ? { isSymlink: false, isDir: true, isFile: false } : symlinks[full] ? { isSymlink: true, isDir: false, isFile: false } : st(full));
      }
      return [...names].map(([filename, attrs]) => ({ filename, attrs }));
    },
    close: async () => {},
  };
}
// Preflight-Sicht: nur lesend – jeder Schreibversuch wird protokolliert und scheitert.
const readOnly = (fsm) => ({ ...fsm, writeFile: async (p) => { fsm.calls.push(["PREFLIGHT_WRITE", p]); throw new Error("read-only"); },
  rename: async (p) => { fsm.calls.push(["PREFLIGHT_WRITE", p]); throw new Error("read-only"); }, unlink: async (p) => { fsm.calls.push(["PREFLIGHT_WRITE", p]); throw new Error("read-only"); } });

function world({ files = SITE, symlinks = {}, served = WEBROOT, presented = PRESENTED, probeFails = false } = {}) {
  const fsm = memSftp({ files, symlinks });
  const probeCalls = [], connectCalls = [], adapterConnects = [];
  const probe = async (arg) => { probeCalls.push(arg); if (probeFails) throw new Error("ECONNREFUSED"); return presented; };
  const preflightConnect = async (cred) => {
    connectCalls.push({ host_key: cred.host_key_sha256, username: cred.username });
    if (cred.host_key_sha256 !== presented) throw new Error("Host-Key falsch"); // wie hostVerifier in ssh2Session
    return readOnly(fsm);
  };
  const adapterConnect = async (cred) => {
    adapterConnects.push({ remote_root: cred.remote_root, host_key: cred.host_key_sha256 });
    if (cred.host_key_sha256 !== presented) throw new Error("Host-Key falsch");
    return fsm;
  };
  const index = () => fsm.F.get(`${served}/index.html`)?.data.toString("utf8") ?? "";
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/") return res(200, index(), { url });
    const f = fsm.F.get(served + u.pathname);
    return f ? res(200, f.data.toString("utf8"), { url }) : res(404, "nicht gefunden", { url });
  };
  const repaired = () => !index().includes("/team-alt");
  const auditor = { audit: async (website) => ({ website, reachable: true, finalUrl: website, title: "Muster AG", requests: 2, issues: repaired() ? [] : [ISSUE],
    pages: { home: "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" } }) };
  return { fsm, probe, preflightConnect, adapterConnect, probeCalls, connectCalls, adapterConnects, fetchFn, auditor, repaired, presented };
}

// Auftrag mit sicher übermitteltem Zugang (echter Tresor, echte Prüfung von access-intake.js).
function orderWithAccess(store, dir, { access_type = "sftp", payload = PAYLOAD() } = {}) {
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "kunde@muster.ch", contact_name: "Frau Muster", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: `Test-${o.order_id}`, now: T0 });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const token = "t".repeat(43);
  Object.assign(data.orders[o.order_id], { state: "ACCESS_REQUESTED", access_request: { token_hash: tokenHash(token), expires_at: new Date(+T0 + 72 * 3600e3).toISOString(), sent_at: T0.toISOString(), draft_id: "d1" } });
  store.write(REPAIR_ORDERS_FILE, data);
  const envelope = sealEnvelope({ access_type, ...payload }, accessKeys(dir).publicKeyPem);
  const r = applyAccessSubmission(store, { order_id: o.order_id, token_hash: tokenHash(token), domain: "muster.ch",
    submission: { submitted_at: T0.toISOString(), access_domain: "muster.ch", consent: true, consent_text: consentText("muster.ch"), access_type, envelope } }, { now: T0 });
  assert.ok(r.ok, r.reason);
  return o.order_id;
}
function cloud(clock = () => T0) {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined), now: clock });
  const client = intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn: async (url, init) => handler(new Request(url, init)) });
  const customer = async (body) => { const r = await handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  return { blobs, client, customer };
}
function fakeGmail() {
  const calls = [];
  return { calls, createDraft: async (x) => { calls.push({ op: "create", ...x }); return { draftId: "dr" + calls.length }; }, sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "m-" + id }; } };
}
async function engineFor(w, { dir, store, gmail = null, intake = null, logs = [] }) {
  const reg = await createAdapterRegistry({ dir, store, fetchFn: w.fetchFn, legacy: {}, contracts: { sftp: sftpAdapter({ dir, connect: w.adapterConnect, fetchFn: w.fetchFn }) },
    profileDeps: { probeHostKey: w.probe, connect: w.preflightConnect } });
  const engine = createRepairEngine({ store, adapters: reg.adapters, router: reg.router, preflight: reg.preflight, auditor: w.auditor, retester: okRetester(), gmail, intake,
    now: () => T0, log: (level, event, data) => logs.push(JSON.stringify({ level, event, data })) });
  return { engine, reg, logs };
}
const pf = (w, extra = {}) => createProfilePreflight({ probeHostKey: w.probe, connect: w.preflightConnect, fetchFn: w.fetchFn, capabilitiesOf: () => ["READ_FILES", "WRITE_FILES"], now: () => T0, ...extra });
const ORDER = { order_id: "RF480-20261012-abcdef", domain: "muster.ch" };
const runFile = (p, payload, order = ORDER) => p.run(order, { adapter: "sftp", accessCtx: { credential: () => ({ access_type: "sftp", ...payload }) } });
const plainFiles = (dir) => fs.readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => !f.startsWith(ACCESS_VAULT_DIR) && f !== ACCESS_KEY_FILE && fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
const assertNoSecret = (label, text) => { for (const v of [MARKER, PASSPHRASE]) assert.ok(!String(text).includes(v), `${label} enthält Zugangsdaten`); };

// =====================================================================================================================
// Formular + Trennung geheim / nicht geheim
// =====================================================================================================================
test("Secure Access Form: Server-Felder (Port, Webroot, Host-Key, Passphrase, Stack, Provider) nur im Chiffrat; nichts im Browser-Speicher", async () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "access.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "public", "access.js"), "utf8");
  for (const id of ["serverFields", "port", "root", "hostKey", "passphrase", "stack", "provider", "hkForm", "hkFingerprint", "hkConsent", "hkNo"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/localStorage|sessionStorage|indexedDB|console\.log/.test(js), "nichts im Browser-Speicher/Log");
  for (const k of ["remote_root", "ssh_host_key_sha256", "passphrase", "website_stack_hint", "provider_name"]) assert.ok(js.includes(k), k);
  // Neue Felder laufen durch Browser-Verschlüsselung → VPS-Entschlüsselung; unbekannte Felder werden verworfen (fail closed).
  const { publicKeyPem, privateKeyPem } = accessKeys(tmp());
  const env = await sealForVps(publicKeyPem, { access_type: "ssh", host: SERVER, username: "kunde", secret: MARKER, notes: null, port: "2222", remote_root: "public_html",
    ssh_host_key_sha256: PRESENTED, passphrase: PASSPHRASE, website_stack_hint: "static", provider_name: "Hoster Test" });
  assert.equal(openEnvelope(env, privateKeyPem).remote_root, "public_html");
  assert.throws(() => openEnvelope(sealEnvelope({ access_type: "ssh", password: "x" }, publicKeyPem), privateKeyPem), /ungültig/);
});

test("Geheim vs. Metadaten: password/private_key/passphrase nie in den Metadaten; ungültiger Port/Fingerprint → Fehlercode statt Raten", () => {
  const key = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ") + "\n" + MARKER;
  const s = splitAccessPayload({ access_type: "ssh", host: SERVER, username: "kunde", secret: key, passphrase: PASSPHRASE, port: "2222", remote_root: " www ",
    ssh_host_key_sha256: PRESENTED + "=", website_stack_hint: "evil", provider_name: "Hoster" });
  assert.deepEqual(SECRET_FIELDS, ["secret", "passphrase"]);
  assertNoSecret("Metadaten", JSON.stringify(s.meta));
  assert.deepEqual([s.meta.port, s.meta.remote_root, s.meta.host_key_sha256, s.meta.website_stack_hint, s.meta.errors], [2222, "www", PRESENTED, "unknown", []]);
  assert.deepEqual(splitAccessPayload({ port: "99999", ssh_host_key_sha256: "md5:aa:bb" }).meta.errors, ["port_invalid", "host_key_invalid"]);
  // Am Auftrag landen nur Allowlist-Felder – auch wenn ein Ergebnis mehr enthielte.
  const rec = profileRecord({ profile_status: "PROFILE_READY", reason: "x", profile: { interface: "sftp", remote_root: WEBROOT, host: SERVER, username: "kunde", password: MARKER } });
  assert.deepEqual(Object.keys(rec).sort(), ["interface", "profile_status", "reason", "remote_root", "updated_at"]);
  assert.deepEqual(TRUSTED_HOST_KEY_PROVIDERS, {}, "Quelle C bewusst leer");
});

// =====================================================================================================================
// WordPress + GitHub/Netlify
// =====================================================================================================================
test("WordPress: HTTPS+REST+Domain+Auth+Schreibrecht geprüft → PROFILE_READY ohne Chris; nur lesend → BLOCKED_NO_ACCESS", async () => {
  const ok = createProfilePreflight({ adapters: { wordpress: { checkAccess: async () => ({ ok: true, capabilities: ["REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK"] }) } }, now: () => T0 });
  const r = await ok.run(ORDER, { adapter: "wordpress", accessCtx: {} });
  assert.deepEqual([r.profile_status, r.profile.interface], ["PROFILE_READY", "wordpress_rest"]);
  assert.ok(r.profile.capabilities.includes("REST_CONTENT_WRITE"));
  const ro = createProfilePreflight({ adapters: { wordpress: { checkAccess: async () => ({ ok: false, reason: "read_only" }) } } });
  assert.deepEqual(Object.values(await ro.run(ORDER, { adapter: "wordpress", accessCtx: {} })).slice(0, 2), ["BLOCKED_NO_ACCESS", "read_only"]);
});

test("WordPress E2E (Engine): Zugang → ACCESS_PROFILE_PREFLIGHT → PROFILE_READY → ACCESS_CHECK → BACKUP … ohne Zugangsprofil-Datei", async () => {
  const dir = tmp(), store = createStore(dir);
  const id = orderWithAccess(store, dir, { access_type: "wordpress_cms", payload: { host: "https://muster.ch", username: "jarvis-temp", secret: MARKER } });
  const stub = { detectCapabilities: () => ["REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK", "HEALTH_CHECK"],
    checkAccess: async (_o, c) => (c?.password === MARKER ? { ok: true, connector: "wordpress_rest", capabilities: ["REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK"] } : { ok: false, reason: "no_credentials" }),
    backup: async () => ({ production_ref: "wp:1", backup_ref: "local:object-backup", rollback_point: "per-object-original" }), locate: async () => null,
    applyFix: async () => ({ ok: false }), validate: async () => ({ build_ok: true }), deployProduction: async () => ({ ok: true }), rollback: async () => ({ ok: true }), cleanup: async () => ({ ok: true }) };
  const reg = await createAdapterRegistry({ dir, store, legacy: {}, contracts: { wordpress: stub } });
  const auditor = { audit: async (website) => ({ website, reachable: true, finalUrl: website, issues: [], requests: 1, pages: { home: "<html>wp-content</html>" } }) };
  await createRepairEngine({ store, adapters: reg.adapters, router: reg.router, preflight: reg.preflight, auditor, retester: okRetester(), now: () => T0 }).processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.equal(o.access_profile.profile_status, "PROFILE_READY");
  const path_ = o.state_history.map((h) => h.to);
  assert.ok(path_.indexOf("ACCESS_PROFILE_PREFLIGHT") < path_.indexOf("BACKUP"));
  assert.ok(o.state_history.some((h) => /^PROFILE_READY/.test(h.reason)));
  assert.equal(fs.existsSync(path.join(dir, ACCESS_PROFILES_FILE)), false, "kein manuelles Profil nötig");
});

test("GitHub+Netlify: genau EINE Zuordnung → PROFILE_READY; keine oder mehrere → MANUAL_REVIEW_REQUIRED (nie raten)", async () => {
  const dir = tmp(), store = createStore(dir);
  const mk = () => createProfilePreflight({ mappingsFor: (o) => Object.entries(store.read("repair_mappings.json", { mappings: {} }).mappings).filter(([k]) => k.replace(/^www\./, "") === o.domain).map(([, v]) => v) });
  assert.deepEqual((await mk().run(ORDER, { adapter: "github_netlify" })).profile_status, "MANUAL_REVIEW_REQUIRED");
  setRepairMapping(store, "muster.ch", { repo: "muster/site", production_branch: "main", netlify_site_id: "abcdef0123456789" });
  assert.equal((await mk().run(ORDER, { adapter: "github_netlify" })).profile_status, "PROFILE_READY");
  const data = store.read("repair_mappings.json", { mappings: {} });
  data.mappings["www.muster.ch"] = { repo: "andere/site", production_branch: "main", netlify_site_id: "ffffff0123456789" };
  store.write("repair_mappings.json", data);
  const r = await mk().run(ORDER, { adapter: "github_netlify" });
  assert.deepEqual([r.profile_status, r.reason], ["MANUAL_REVIEW_REQUIRED", "ambiguous_mapping"]);
  // Echte Registry liest dieselbe Datei (normalisiert) – auch dort mehrdeutig.
  const reg = await createAdapterRegistry({ dir, store, legacy: {}, contracts: {} });
  assert.equal((await reg.preflight.run(ORDER, { adapter: "github_netlify" })).reason, "ambiguous_mapping");
});

// =====================================================================================================================
// SFTP: Webroot vom Kunden
// =====================================================================================================================
test("SFTP E2E: Kunde liefert Webroot + Fingerprint → Profil automatisch → Fix → Retest → COMPLETED; kein --profile, Profil danach reduziert", async () => {
  const dir = tmp(), store = createStore(dir), w = world(), logs = [];
  const id = orderWithAccess(store, dir, { payload: PAYLOAD({ remote_root: "public_html", ssh_host_key_sha256: PRESENTED, port: "22" }) });
  const { engine } = await engineFor(w, { dir, store, logs });
  await engine.processAll();
  let o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.deepEqual([o.access_profile.profile_status, o.access_profile.remote_root, o.access_profile.host_key_sha256, o.access_profile.host_key_source, o.access_profile.webroot_source],
    ["PROFILE_READY", WEBROOT, PRESENTED, "customer_form", "customer_form"]);
  assert.equal(w.probeCalls.length, 1);
  assert.deepEqual(Object.keys(w.probeCalls[0]).sort(), ["host", "port"], "Host-Key-Erfassung ohne Zugangsdaten");
  assert.ok(w.adapterConnects.length && w.adapterConnects.every((c) => c.remote_root === WEBROOT && c.host_key === PRESENTED), "Adapter nutzt das automatische Profil");
  assert.ok(w.repaired());
  assert.ok(!w.fsm.calls.some((c) => c[0] === "PREFLIGHT_WRITE"), "Preflight schreibt nie");
  assert.equal(fs.existsSync(path.join(dir, ACCESS_PROFILES_FILE)), false, "Chris musste kein Profil anlegen");
  completeOrder(store, id, { now: T0 });
  o = readOrder(store, id);
  assert.equal(o.access_profile.remote_root, undefined);
  assert.equal(o.access_profile.host_key_sha256, undefined);
  assert.ok(o.access_profile.cleared_at);
  for (const [f, text] of plainFiles(dir)) assertNoSecret(f, text);
  assertNoSecret("Logs", logs.join("\n"));
});

test("SFTP Webroot vom Kunden: kanonisiert + Sandbox + Login-Root + existiert + Startseite – sonst warten bzw. unsicher", async () => {
  const w = world({ files: { ...SITE, "/home/andere/public_html/index.html": "x", [`${HOME_DIR}/leer/readme.txt`]: "x" } });
  const fp = { ssh_host_key_sha256: PRESENTED };
  const r = async (root) => runFile(pf(w), PAYLOAD({ ...fp, remote_root: root }));
  assert.equal((await r("~/public_html")).profile.remote_root, WEBROOT);
  assert.equal((await r(WEBROOT + "/")).profile.remote_root, WEBROOT);
  assert.deepEqual([(await r("../andere/public_html")).profile_status, (await r("../andere/public_html")).reason], ["WAITING_FOR_ACCESS_PROFILE", "remote_root_invalid"]);
  assert.deepEqual(Object.values(await r("/home/andere/public_html")).slice(0, 2), ["WAITING_FOR_ACCESS_PROFILE", "remote_root_outside_login_root"]);
  assert.deepEqual(Object.values(await r("/etc")).slice(0, 2), ["BLOCKED_UNSAFE_ACCESS", "remote_root_unsafe"]);
  assert.deepEqual(Object.values(await r("/root/www")).slice(0, 2), ["BLOCKED_UNSAFE_ACCESS", "remote_root_unsafe"]);
  assert.deepEqual(Object.values(await r("gibtsnicht")).slice(0, 2), ["WAITING_FOR_ACCESS_PROFILE", "remote_root_missing_dir"]);
  assert.deepEqual(Object.values(await r("leer")).slice(0, 2), ["WAITING_FOR_ACCESS_PROFILE", "remote_root_not_webroot"]);
  assert.deepEqual(canonicalRemoteRoot("public_html/../../x", HOME_DIR), { ok: false, reason: "remote_root_invalid" });
  assert.ok(!w.fsm.calls.some((c) => c[0] === "PREFLIGHT_WRITE"));
});

// =====================================================================================================================
// SFTP: sichere Webroot-Discovery (nur lesend, nur im Login-Root)
// =====================================================================================================================
test("Discovery statisch: genau EIN Kandidat + index.html + Inhalt passt zur Domain → PROFILE_READY (mehrere Signale)", async () => {
  const w = world();
  const r = await runFile(pf(w), PAYLOAD({ ssh_host_key_sha256: PRESENTED }));
  assert.deepEqual([r.profile_status, r.profile.remote_root, r.profile.webroot_source], ["PROFILE_READY", WEBROOT, "discovery"]);
  assert.deepEqual(r.profile.webroot_signals, ["single_candidate", "index_html", "content_match", "site_structure"]);
  // Nur lesend, nur im Login-Root: kein Zugriff auf /etc, /root, fremde Homes oder übergeordnete Verzeichnisse.
  const touched = w.fsm.calls.filter((c) => c[0] !== "realpath" || c[1] !== HOME_DIR).map((c) => c[1]);
  assert.ok(touched.every((p) => p === HOME_DIR || p.startsWith(HOME_DIR + "/")), touched.join(", "));
  assert.ok(!w.fsm.calls.some((c) => ["write", "rename", "unlink", "PREFLIGHT_WRITE"].includes(c[0])));
  assert.deepEqual(w.fsm.calls.filter((c) => c[0] === "read").map((c) => c[1]), [`${WEBROOT}/index.html`], "nur die Startseite gelesen");
});

test("Discovery: index.html allein reicht nicht (Inhalt passt nicht) → WAITING; 0 Kandidaten → WAITING; >1 Site → WAITING (nie zufällig)", async () => {
  const fp = PAYLOAD({ ssh_host_key_sha256: PRESENTED });
  const mismatch = world({ files: { ...SITE, [`${WEBROOT}/index.html`]: "<html><head><title>Andere Firma</title></head><body>anders</body></html>" }, served: "/srv/live" });
  assert.deepEqual(Object.values(await runFile(pf(mismatch), fp)).slice(0, 2), ["WAITING_FOR_ACCESS_PROFILE", "webroot_not_verifiable"]);
  const none = world({ files: { [`${HOME_DIR}/mail/x.txt`]: "x" } });
  assert.deepEqual(Object.values(await runFile(pf(none), fp)).slice(0, 2), ["WAITING_FOR_ACCESS_PROFILE", "no_webroot_candidate"]);
  const two = world({ files: { ...SITE, [`${HOME_DIR}/www/index.html`]: INDEX_HTML } });
  const r = await runFile(pf(two), fp);
  assert.deepEqual([r.profile_status, r.reason], ["WAITING_FOR_ACCESS_PROFILE", "multiple_webroot_candidates"]);
  assert.equal(r.profile.remote_root, undefined, "kein Webroot geraten");
  // Symlink-Kandidat (www → public_html, wie bei cPanel) zählt nicht doppelt und wird nie betreten.
  const link = world({ symlinks: { [`${HOME_DIR}/www`]: WEBROOT } });
  assert.equal((await runFile(pf(link), fp)).profile.remote_root, WEBROOT);
  assert.ok(!link.fsm.calls.some((c) => c[0] === "readdir" && c[1] === `${HOME_DIR}/www`));
});

test("Discovery WordPress: wp-config.php + wp-content/ + wp-includes/ + index.php → PROFILE_READY; wp-config.php wird NIE gelesen", async () => {
  const wp = { [`${WEBROOT}/index.php`]: "<?php", [`${WEBROOT}/wp-config.php`]: "<?php define('DB_PASSWORD', 'geheim-db');", [`${WEBROOT}/wp-content/themes/x/style.css`]: "x",
    [`${WEBROOT}/wp-includes/version.php`]: "<?php" };
  const w = world({ files: wp });
  const r = await runFile(pf(w), PAYLOAD({ ssh_host_key_sha256: PRESENTED }));
  assert.deepEqual([r.profile_status, r.profile.remote_root], ["PROFILE_READY", WEBROOT]);
  assert.deepEqual(r.profile.webroot_signals, ["single_candidate", "index_php", "wordpress_structure"]);
  assert.ok(!w.fsm.calls.some((c) => c[0] === "read"), "keine Datei gelesen – nur Existenz");
  assert.ok(!JSON.stringify(r).includes("geheim-db"));
  // Nur index.php ohne WordPress-Struktur (PHP nie gelesen) → nicht belegbar.
  const php = world({ files: { [`${WEBROOT}/index.php`]: "<?php" } });
  assert.equal((await runFile(pf(php), PAYLOAD({ ssh_host_key_sha256: PRESENTED }))).reason, "webroot_not_verifiable");
});

test("Inhaltsabgleich: identisch oder Titel + gleiche lokale Verweise; Titel allein reicht nie", () => {
  assert.equal(contentMatches(INDEX_HTML, INDEX_HTML.replace(/></g, ">\n<")), true);
  assert.equal(contentMatches(INDEX_HTML, '<html><head><title>Muster AG</title></head><body><a href="/kontakt.html">K</a><a href="/team-alt">T</a><script>x</script></body></html>'), true);
  assert.equal(contentMatches(INDEX_HTML, "<html><head><title>Muster AG</title></head><body>anders</body></html>"), false);
  assert.equal(contentMatches("", INDEX_HTML), false);
});

// =====================================================================================================================
// SSH-Host-Key: nie blind vertrauen
// =====================================================================================================================
test("Host-Key-Probe (isolierter lokaler ssh2-Testserver 127.0.0.1): richtiger Fingerprint, KEIN Anmeldeversuch", async () => {
  const ssh2 = (await import("ssh2")).default;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const expected = "SHA256:" + crypto.createHash("sha256").update(ssh2.utils.parseKey(privateKey).getPublicSSH()).digest("base64").replace(/=+$/, "");
  let auth = 0;
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => { client.on("authentication", (ctx) => { auth++; ctx.reject(); }); client.on("error", () => {}); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    assert.equal(await ssh2HostKeyProbe({ host: "127.0.0.1", port: server.address().port, timeoutMs: 5000 }), expected);
    assert.equal(auth, 0, "keine Authentifizierung – Zugangsdaten verlassen den VPS nicht");
  } finally { server.close(); }
});

test("Host-Key: Kunden-Fingerprint ≠ Server → MANUAL_REVIEW_REQUIRED, KEINE Verbindung mit Zugangsdaten; Chris-Profil zählt als Quelle B", async () => {
  const w = world();
  const r = await runFile(pf(w), PAYLOAD({ ssh_host_key_sha256: OTHER_KEY, remote_root: "public_html" }));
  assert.deepEqual([r.profile_status, r.reason, r.profile.host_key_candidate], ["MANUAL_REVIEW_REQUIRED", "host_key_mismatch", PRESENTED]);
  assert.equal(w.connectCalls.length, 0);
  // Quelle B: bekannter Profileintrag von Chris (Fingerprint) – Webroot weiter vom Kunden.
  const ok = await runFile(pf(w, { manualProfileFor: () => ({ host_key_sha256: PRESENTED }) }), PAYLOAD({ remote_root: "public_html" }));
  assert.deepEqual([ok.profile_status, ok.profile.host_key_source], ["PROFILE_READY", "chris_profile"]);
  const conflict = await runFile(pf(w, { manualProfileFor: () => ({ host_key_sha256: OTHER_KEY }) }), PAYLOAD({ ssh_host_key_sha256: PRESENTED }));
  assert.equal(conflict.reason, "host_key_mismatch");
  // root → unsicher, ohne überhaupt zu verbinden.
  const before = w.probeCalls.length;
  assert.deepEqual(Object.values(await runFile(pf(w), PAYLOAD({ username: "root" }))).slice(0, 2), ["BLOCKED_UNSAFE_ACCESS", "root_login"]);
  assert.equal(w.probeCalls.length, before);
});

test("Host-Key First Use E2E: Kandidat nur gespeichert → EINE Service-Mail mit Link → Kunde bestätigt → Preflight → Reparatur", async () => {
  const dir = tmp(), store = createStore(dir), w = world(), c = cloud(), gmail = fakeGmail(), logs = [];
  const id = orderWithAccess(store, dir, { payload: PAYLOAD({ remote_root: "public_html" }) });
  const { engine } = await engineFor(w, { dir, store, gmail, intake: c.client, logs });
  await engine.processAll();
  let o = readOrder(store, id);
  assert.equal(o.state, "HOST_KEY_CONFIRMATION_REQUIRED");
  assert.deepEqual([o.access_profile.profile_status, o.access_profile.host_key_candidate, o.access_profile.host_key_sha256], ["HOST_KEY_CONFIRMATION_REQUIRED", PRESENTED, undefined]);
  assert.equal(w.connectCalls.length + w.adapterConnects.length, 0, "keine Verbindung mit Zugangsdaten vor der Bestätigung");
  assert.equal(effectiveProfile(store, o), null, "unbestätigter Kandidat ist nie ein Profil");
  // Genau EINE Service-Mail (auch nach weiteren Läufen), mit Link, ohne Fingerprint/Host/Benutzer/Pfad.
  await engine.processAll(); await engine.processAll();
  assert.deepEqual(gmail.calls.map((x) => x.op), ["create", "SEND"]);
  const mail = gmail.calls[0];
  assert.equal(mail.messageClass, "CUSTOMER_ACCESS_REQUEST");
  assert.match(mail.subject, /Sicherheitsbestätigung/);
  for (const v of [PRESENTED, SERVER, WEBROOT, "kunde:", id, MARKER]) assert.ok(!mail.body.includes(v), `Mail enthält ${v}`);
  const token = mail.body.match(/access\.html#t=([A-Za-z0-9_-]{43})/)[1];
  o = readOrder(store, id);
  assert.equal(o.host_key_request.token_hash, tokenHash(token));
  assert.ok(!JSON.stringify(o).includes(token), "Klartext-Token nie am Auftrag");
  // Kundenseite: zeigt Fingerprint + Bestätigungstext; ohne Häkchen/mit falschem Fingerprint/falscher Domain → abgelehnt.
  const info = await c.customer({ op: "info", token });
  assert.deepEqual([info.status, info.body.purpose, info.body.host_key_candidate], [200, "host_key_confirmation", PRESENTED]);
  assert.equal(info.body.public_key, undefined);
  assert.equal((await c.customer({ op: "submit", token, purpose: "host_key_confirmation", access_domain: "muster.ch", decision: "confirm", host_key: PRESENTED, consent: false })).status, 400);
  assert.equal((await c.customer({ op: "submit", token, purpose: "host_key_confirmation", access_domain: "muster.ch", decision: "confirm", host_key: OTHER_KEY, consent: true })).status, 400);
  assert.equal((await c.customer({ op: "submit", token, purpose: "host_key_confirmation", access_domain: "andere.ch", decision: "confirm", host_key: PRESENTED, consent: true })).status, 400);
  assert.equal((await c.customer({ op: "submit", token, access_type: "sftp", access_domain: "muster.ch", consent: true })).status, 400, "Zugangsformular passt nicht zu diesem Link");
  assert.equal((await c.customer({ op: "submit", token, purpose: "host_key_confirmation", access_domain: "www.muster.ch", decision: "confirm", host_key: PRESENTED, consent: true })).status, 200);
  assert.equal((await c.customer({ op: "submit", token, purpose: "host_key_confirmation", access_domain: "muster.ch", decision: "confirm", host_key: PRESENTED, consent: true })).status, 404, "einmalig");
  assert.deepEqual(await syncAccessIntake({ store, intake: c.client, now: () => T0 }), { accepted: 1, rejected: 0 });
  assert.equal(c.blobs.dump(), "[]", "Cloud nach Quittung leer");
  o = readOrder(store, id);
  assert.deepEqual([o.access_profile.host_key_sha256, o.access_profile.host_key_source], [PRESENTED, "customer_confirmation"]);
  await engine.processAll();
  o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.deepEqual([o.access_profile.profile_status, o.access_profile.host_key_source, o.access_profile.remote_root], ["PROFILE_READY", "customer_confirmation", WEBROOT]);
  assert.ok(w.connectCalls.every((x) => x.host_key === PRESENTED));
  assert.ok(w.repaired());
  assert.deepEqual(gmail.calls.filter((x) => x.op === "SEND").length, 1);
  assertNoSecret("Logs", logs.join("\n"));
});

test("Host-Key: Kunde meldet Abweichung → MANUAL_REVIEW_REQUIRED; falscher Token/abgelaufen/falscher Zustand → abgelehnt", async () => {
  const dir = tmp(), store = createStore(dir), w = world(), c = cloud(), gmail = fakeGmail();
  const id = orderWithAccess(store, dir, { payload: PAYLOAD({ remote_root: "public_html" }) });
  const { engine } = await engineFor(w, { dir, store, gmail, intake: c.client });
  await engine.processAll();
  const token = gmail.calls[0].body.match(/access\.html#t=([A-Za-z0-9_-]{43})/)[1];
  const o = readOrder(store, id);
  const sub = (over = {}) => ({ order_id: id, token_hash: tokenHash(token), domain: "muster.ch",
    submission: { purpose: "host_key_confirmation", submitted_at: T0.toISOString(), access_domain: "muster.ch", decision: "confirm", host_key: PRESENTED, consent: true,
      confirm_text: `Ich habe den angezeigten Fingerprint mit der Angabe meines Hosting-Anbieters für muster.ch verglichen – er stimmt exakt überein.`, ...over } });
  assert.match(applyHostKeyConfirmation(store, { ...sub(), token_hash: tokenHash("x".repeat(43)) }, { now: T0 }).reason, /Token/);
  assert.match(applyHostKeyConfirmation(store, sub({ submitted_at: new Date(Date.parse(o.host_key_request.expires_at) + 1000).toISOString() }), { now: T0 }).reason, /abgelaufen/);
  assert.match(applyHostKeyConfirmation(store, sub({ host_key: OTHER_KEY }), { now: T0 }).reason, /Fingerprint/);
  assert.match(applyHostKeyConfirmation(store, sub({ consent: false }), { now: T0 }).reason, /Bestätigung/);
  assert.equal(readOrder(store, id).access_profile.host_key_sha256, undefined, "nichts übernommen");
  assert.equal((await c.customer({ op: "submit", token, purpose: "host_key_confirmation", access_domain: "muster.ch", decision: "reject", host_key: PRESENTED })).status, 200);
  await syncAccessIntake({ store, intake: c.client, now: () => T0 });
  await engine.processAll();
  const after = readOrder(store, id);
  assert.equal(after.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(after.alerts.at(-1).kind, "host_key_rejected");
  assert.equal(w.connectCalls.length + w.adapterConnects.length, 0);
});

test("Cloud-Registrierung: Host-Key-Zweck nur mit gültigem Kandidaten; Info zeigt nie Zugangsdaten", async () => {
  const c = cloud();
  const reg = (over) => c.client.register({ order_id: "RF480-20261012-abcdef", domain: "muster.ch", token_hash: tokenHash("a".repeat(43)), expires_at: new Date(+T0 + 3600e3).toISOString(),
    public_key: accessKeys(tmp()).publicKeyPem, ...over });
  await assert.rejects(() => reg({ purpose: "host_key_confirmation" }), /400/);
  await assert.rejects(() => reg({ purpose: "host_key_confirmation", host_key_candidate: "SHA256:kurz" }), /400/);
  await assert.rejects(() => reg({ purpose: "shell" }), /400/);
  await reg({ purpose: "host_key_confirmation", host_key_candidate: PRESENTED });
  const info = await c.customer({ op: "info", token: "a".repeat(43) });
  assert.deepEqual(Object.keys(info.body).sort(), ["confirm_text", "domain", "expires_at", "host_key_candidate", "purpose"]);
});

// =====================================================================================================================
// Warten, Wiederaufnahme, Gates, Dashboard
// =====================================================================================================================
test("WAITING_FOR_ACCESS_PROFILE: mehrdeutiger Webroot → wartet + Chris informiert; Chris ergänzt --root → läuft selbst weiter", async () => {
  const dir = tmp(), store = createStore(dir), w = world({ files: { ...SITE, [`${HOME_DIR}/www/index.html`]: INDEX_HTML } });
  const id = orderWithAccess(store, dir, { payload: PAYLOAD({ ssh_host_key_sha256: PRESENTED }) });
  const { engine } = await engineFor(w, { dir, store });
  await engine.processAll(); await engine.processAll();
  let o = readOrder(store, id);
  assert.deepEqual([o.state, o.access_profile.reason], ["WAITING_FOR_ACCESS_PROFILE", "multiple_webroot_candidates"]);
  assert.equal(o.alerts.filter((a) => a.kind === "access_profile_required").length, 1);
  assert.equal(w.adapterConnects.length, 0);
  assert.equal(repairOrdersStatus(dir).waiting_access_profile, 1);
  setAccessProfile(store, "muster.ch", { remote_root: WEBROOT });
  await engine.processAll();
  o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.deepEqual([o.access_profile.webroot_source, o.access_profile.host_key_source], ["chris_profile", "customer_form"]);
});

test("Gates: Preflight erst nach Zahlung ≥ CHF 240 + Freigabe + Zugang + Domain-Bindung – sonst 0 Probes, 0 Verbindungen", async () => {
  const dir = tmp(), store = createStore(dir), w = world();
  const id = orderWithAccess(store, dir, { payload: PAYLOAD({ ssh_host_key_sha256: PRESENTED }) });
  voidPayment(store, paymentsForOrder(store, id)[0].payment_id, { reason: "Test: Zahlung storniert" });
  const { engine } = await engineFor(w, { dir, store });
  await engine.processAll();
  assert.equal(readOrder(store, id).state, "PAYMENT_REQUIRED");
  assert.equal(w.probeCalls.length + w.connectCalls.length, 0);
  // Domain-Bindung verletzt (Freigabe auf andere Domain) → STOP vor dem Preflight.
  const dir2 = tmp(), store2 = createStore(dir2), w2 = world();
  const id2 = orderWithAccess(store2, dir2, { payload: PAYLOAD({ ssh_host_key_sha256: PRESENTED }) });
  const data = store2.read(REPAIR_ORDERS_FILE, { orders: {} });
  data.orders[id2].authorization.authorized_domain = "andere.ch";
  store2.write(REPAIR_ORDERS_FILE, data);
  await (await engineFor(w2, { dir: dir2, store: store2 })).engine.processAll();
  assert.equal(readOrder(store2, id2).state, "BLOCKED_NO_AUTHORIZATION");
  assert.equal(w2.probeCalls.length + w2.connectCalls.length, 0);
});

test("Server nicht erreichbar: Preflight wiederholt (je Lauf einmal), nach 6 Versuchen MANUAL_REVIEW_REQUIRED + Chris informiert", async () => {
  const dir = tmp(), store = createStore(dir), w = world({ probeFails: true });
  const id = orderWithAccess(store, dir, { payload: PAYLOAD({ ssh_host_key_sha256: PRESENTED }) });
  const { engine } = await engineFor(w, { dir, store });
  for (let i = 0; i < 5; i++) await engine.processAll();
  assert.deepEqual([readOrder(store, id).state, readOrder(store, id).access_profile.attempts], ["ACCESS_PROFILE_PREFLIGHT", 5]);
  await engine.processAll();
  const o = readOrder(store, id);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(o.alerts.at(-1).kind, "preflight_failed");
  assert.equal(w.probeCalls.length, 6);
});

test("Dashboard/Snapshot: nur Profil-Statuswort – nie Host, Benutzer, IP, Webroot/Pfade, Fingerprint oder Zugangsdaten", async () => {
  const dir = tmp(), store = createStore(dir), w = world(), c = cloud(), gmail = fakeGmail();
  orderWithAccess(store, dir, { payload: PAYLOAD({ remote_root: "public_html", passphrase: PASSPHRASE }) });
  await (await engineFor(w, { dir, store, gmail, intake: c.client })).engine.processAll();
  const pub = publicRepairOrders(dir);
  assert.deepEqual([pub.orders[0].phase, pub.orders[0].profile_status, pub.host_key_confirmation], ["HOST_KEY_CONFIRMATION", "HOST_KEY_CONFIRMATION_REQUIRED", 1]);
  const snap = cleanRepair({ ...pub, orders: [{ ...pub.orders[0], host: SERVER, remote_root: WEBROOT, host_key: PRESENTED }] });
  assert.deepEqual([snap.orders[0].profile_status, snap.host_key_confirmation], ["HOST_KEY_CONFIRMATION_REQUIRED", 1]);
  assert.equal(cleanRepair({ ...pub, orders: [{ ...pub.orders[0], profile_status: WEBROOT }] }).orders[0].profile_status, null);
  for (const raw of [JSON.stringify(pub), JSON.stringify(snap)]) for (const v of [SERVER, WEBROOT, HOME_DIR, PRESENTED, "kunde@", MARKER, PASSPHRASE]) assert.ok(!raw.includes(v), v);
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  for (const s of ['id="repProfile"', "HOST KEY CONFIRMATION", "WAITING FOR ACCESS PROFILE", "ACCESS PROFILE PREFLIGHT", "PROFILE READY"]) assert.ok(html.includes(s), s);
  assert.ok(ORDER_STATES.includes("HOST_KEY_CONFIRMATION_REQUIRED") && ORDER_STATES.includes("WAITING_FOR_ACCESS_PROFILE"));
});

test("Profil-Builder: kein Gmail, kein Write-Weg, keine Shell; wp-config.php nur als Name; Docker kopiert repair-adapters", () => {
  const src = fs.readFileSync(path.join(ROOT, "repair-adapters", "profile-builder.js"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  assert.ok(!/gmail|sendDraft|smtp/i.test(code), "kein Mailweg");
  assert.ok(!/\.(writeFile|rename|unlink|chmod|exec)\(/.test(code), "Preflight schreibt/führt nie aus");
  assert.ok(!/readFile\([^)]*wp-config/.test(code));
  const docker = fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile"), "utf8");
  assert.ok(docker.includes("COPY repair-adapters ./repair-adapters"));
});
