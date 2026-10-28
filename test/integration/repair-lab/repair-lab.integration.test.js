// REPAIR INTEGRATION LAB (TF-044): WordPress-REST-, SFTP- und SSH-Adapter gegen ECHTE Netzwerkprotokolle in einer isolierten
// Docker-Umgebung (lab.mjs): OpenSSH 10 (modern: Ed25519+ECDSA+RSA; legacy: nur ssh-rsa), WordPress + MariaDB hinter Caddy-HTTPS.
// Nur Testdaten, nur zur Laufzeit erzeugte Zugangsdaten/Schlüssel, Gmail ausschliesslich Attrappe, Zahlungen nur im Test-Ledger.
// Läuft NUR über «npm run test:repair-integration» (JARVIS_REPAIR_LAB=1) – in «npm test» übersprungen. Fehlt Docker, schlägt
// der explizite Lauf fehl (Release-Gate), statt still zu überspringen.
import { test as baseTest, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createStore } from "../../../mail-worker.js";
import { recordPayment, voidPayment } from "../../../payments.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, createRepairEngine, completeOrder, publicRepairOrders } from "../../../repair-workflow.js";
import { consentText, tokenHash } from "../../../access-intake-api.js";
import { applyAccessSubmission, accessKeys, sealEnvelope, ACCESS_VAULT_DIR, ACCESS_KEY_FILE } from "../../../access-intake.js";
import { sftpAdapter, ssh2Session, ssh2SftpConnector, resolveSafe, validateRemoteRoot } from "../../../repair-adapters/sftp.js";
import { sshAdapter, ssh2Connector, checkArgv } from "../../../repair-adapters/ssh.js";
import { wordpressAdapter } from "../../../repair-adapters/wordpress.js";
import { createAdapterRegistry, setAccessProfile } from "../../../repair-adapters/router.js";
import { profileHash } from "../../../repair-adapters/profile-builder.js";
import { discoverHostKeys, matchHostKey, fingerprintOf } from "../../../repair-adapters/host-key.js";
import { sha256 } from "../../../repair-adapters/common.js";
import { dockerAvailable, cleanupAll, labResources, startLab, resetSite, resetWp, hostKeysOf, outsideSnapshot, webrootSnapshot, sshdLog, siteFile,
  wpGuardSnapshot, wpContent, labAuditor, labRetester, docker, response, DOMAINS, FIXTURES, LAB_LABEL, SSHD_IMAGE, WP_BROKEN } from "./lab.mjs";

const ENABLED = process.env.JARVIS_REPAIR_LAB === "1";
// Obergrenze je Test: ein Fehler (z. B. eine Mutation, die eine Sitzung öffnet) wird rot statt zu hängen.
const test = (name, opts, fn) => (typeof opts === "function" ? baseTest(name, { timeout: 300_000 }, opts) : baseTest(name, opts, fn));
const require = createRequire(import.meta.url);
const ROOT = "/home/labuser/public_html";
const NEVER_SENT = "n" + crypto.randomBytes(12).toString("hex"); // darf den Legacy-Server nie erreichen
const AUTH_LINE = /Accepted|Failed|Invalid user|Postponed|authenticating user|labuser from/;
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lab44w-")); dirs.push(d); return d; };
const fixture = (rel) => fs.readFileSync(path.join(FIXTURES, rel), "utf8");
let lab, oid = 0;
const nextId = () => `RF480-20261012-${(0xa00000 + ++oid).toString(16)}`;
const order = (domain, over = {}) => ({ order_id: nextId(), domain, website: `https://${domain}/`, customer_authorized_repair: true, authorization: { authorized_domain: domain, source: "customer_order_form" }, ...over });
const sftpCred = (over = {}) => ({ host: lab.ssh.host, port: lab.ssh.port, username: "labuser", password: lab.secrets.labuser_password, remote_root: ROOT,
  host_key_sha256: lab.hostKeys.rsa, host_key_algorithm: "rsa-sha2-512", ...over });
const wpCred = (over = {}) => ({ username: "jarvislab", password: lab.secrets.wp_app_password, api_base: `https://${DOMAINS.wp}/wp-json`, ...over });
const logSince = async (container, mark) => (await sshdLog(lab, container)).slice(mark);
const logMark = async (container) => (await sshdLog(lab, container)).length;
// Echter SFTP-Connector + Protokoll der schreibenden Operationen (Beweis: Temp-Upload → atomarer Rename, nie In-Place-Write).
function spyConnector(ops) {
  const real = ssh2SftpConnector();
  return async (cred) => {
    const c = await real(cred);
    return { ...c, writeFile: (p, ...x) => { ops.push(["write", p]); return c.writeFile(p, ...x); }, rename: (a, b) => { ops.push(["rename", a, b]); return c.rename(a, b); },
      unlink: (p) => { ops.push(["unlink", p]); return c.unlink(p); } };
  };
}
const secretsOf = () => [lab.secrets.labuser_password, lab.secrets.key_passphrase, lab.secrets.wp_app_password, lab.secrets.wp_editor_password, lab.secrets.wp_admin_password,
  lab.privateKey.split(/\r?\n/)[2]].filter(Boolean);
const assertNoSecrets = (label, text) => { for (const v of secretsOf()) assert.ok(!String(text).includes(v), `${label} enthält Test-Zugangsdaten`); };
const filesOf = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
function fakeGmail() { const calls = []; return { calls, createDraft: async (x) => { calls.push({ op: "create", to: x.to }); return { draftId: "dr" + calls.length }; }, sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "m" }; } }; }

// Auftrag mit sicher übermitteltem Zugang (echter Tresor, echte Prüfung von access-intake.js) + Test-Ledger-Zahlung.
function orderWithAccess(store, dir, { domain, access_type, payload, paid = 480 }) {
  const now = new Date();
  const o = createRepairOrder(store, { domain, website: `https://${domain}/`, company: "Lab Test AG", delivery_email: `kunde@${domain}`, contact_name: "Lab Kunde", now });
  if (paid) recordPayment(store, { order_id: o.order_id, amount_chf: paid, reference: `Lab-${o.order_id}`, now });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const token = crypto.randomBytes(32).toString("base64url");
  Object.assign(data.orders[o.order_id], { state: "ACCESS_REQUESTED", access_request: { token_hash: tokenHash(token), expires_at: new Date(+now + 72 * 3600e3).toISOString(), sent_at: now.toISOString(), draft_id: "d1" } });
  store.write(REPAIR_ORDERS_FILE, data);
  const envelope = sealEnvelope({ access_type, ...payload }, accessKeys(dir).publicKeyPem);
  const r = applyAccessSubmission(store, { order_id: o.order_id, token_hash: tokenHash(token), domain,
    submission: { submitted_at: now.toISOString(), access_domain: domain, consent: true, consent_text: consentText(domain), access_type, envelope } }, { now });
  assert.ok(r.ok, r.reason);
  return o.order_id;
}
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
async function engineFor(dir, store, { gmail = fakeGmail(), logs = [] } = {}) {
  const reg = await createAdapterRegistry({ dir, store, fetchFn: lab.fetch, legacy: {} }); // echte Adapter + echte Transporte (ssh2, HTTPS)
  const engine = createRepairEngine({ store, adapters: reg.adapters, router: reg.router, preflight: reg.preflight, auditor: labAuditor(lab.fetch), retester: labRetester(lab.fetch),
    gmail, log: (level, event, data) => logs.push(JSON.stringify({ level, event, data })) });
  return { engine, reg, gmail, logs };
}
const pathOf = (o) => o.state_history.map((h) => h.to);
const inOrder = (p, states) => states.every((s, i) => p.lastIndexOf(s) >= 0 && (i === 0 || p.lastIndexOf(states[i - 1]) < p.lastIndexOf(s)));

if (!ENABLED) {
  test("Repair Integration Lab (Docker) – nur über «npm run test:repair-integration»", { skip: "JARVIS_REPAIR_LAB=1 nicht gesetzt (eigene Docker-Suite)" }, () => {});
} else {
  before(async () => {
    assert.ok(await dockerAvailable(), "Docker nicht verfügbar – das TF-044-Release-Gate verlangt die echte Integration.");
    await cleanupAll();
    lab = await startLab({ log: (m) => console.log(`# ${m}`) });
  }, { timeout: 900_000 });

  after(async () => {
    if (lab) await lab.stop();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    const left = await labResources();
    console.log(`# Lab-Cleanup: ${JSON.stringify(left)}`);
    assert.deepEqual(left, { containers: 0, volumes: 0, networks: 0 }, "Lab vollständig entfernt");
  }, { timeout: 300_000 });

  // ===================================================================================================================
  // HOST KEY gegen echtes OpenSSH
  // ===================================================================================================================
  test("Host-Key Discovery (echtes OpenSSH 10): Ed25519, ECDSA, RSA-SHA2 einzeln ohne Login – Fingerprints = ssh-keygen -lf", async () => {
    const mark = await logMark(lab.names.sshd);
    const d = await discoverHostKeys(lab.ssh);
    assert.equal(d.ok, true);
    const by = Object.fromEntries(d.keys.map((k) => [k.algorithm, k.fingerprint]));
    assert.deepEqual(by, { "ssh-ed25519": lab.hostKeys.ed25519, "ecdsa-sha2-nistp256": lab.hostKeys.ecdsa, "rsa-sha2-512": lab.hostKeys.rsa });
    const log = await logSince(lab.names.sshd, mark);
    assert.equal((log.match(/Connection from/g) || []).length, 5, "eine Verbindung je Schlüsseltyp-Kandidat (max. 5)");
    assert.ok(!AUTH_LINE.test(log), `kein Anmeldeversuch: ${log.split("\n").filter((l) => AUTH_LINE.test(l)).join(" | ")}`);
  });

  test("Ed25519 bestätigt → ssh-ed25519 gepinnt → Login (Passwort erst nach Verifikation); RSA bestätigt → rsa-sha2-512 → Login", async () => {
    const keys = (await discoverHostKeys(lab.ssh)).keys;
    for (const [fp, alg] of [[lab.hostKeys.ed25519, "ssh-ed25519"], [lab.hostKeys.rsa, "rsa-sha2-512"], [lab.hostKeys.ecdsa, "ecdsa-sha2-nistp256"]]) {
      const m = matchHostKey(keys, fp);
      assert.deepEqual([m.ok, m.algorithm], [true, alg]);
      const mark = await logMark(lab.names.sshd);
      const s = await ssh2Session(sftpCred({ host_key_sha256: fp, host_key_algorithm: m.algorithm }));
      assert.deepEqual({ ...s.host_key }, { sha256: fp, algorithm: alg });
      assert.equal(await s.client.realpath("."), "/home/labuser");
      s.close();
      assert.match(await logSince(lab.names.sshd, mark), /Accepted password for labuser/);
    }
    // Ohne gespeicherten Algorithmus (z. B. Profil von Chris): Discovery ohne Login → RSA statt des ausgehandelten Ed25519.
    const s = await ssh2Session(sftpCred({ host_key_algorithm: undefined }));
    assert.equal(s.host_key.algorithm, "rsa-sha2-512");
    s.close();
  });

  test("Falscher Fingerprint / Host-Key-Wechsel / Algorithmus-Wechsel: 0 Login, 0 Credential Send (sshd-Log), Fehler ohne Passwort", async () => {
    const wrong = fingerprintOf(crypto.randomBytes(51));
    const mark = await logMark(lab.names.sshd);
    assert.deepEqual(matchHostKey((await discoverHostKeys(lab.ssh)).keys, wrong).reason, "host_key_no_match");
    for (const over of [{ host_key_sha256: wrong, host_key_algorithm: undefined }, { host_key_sha256: wrong }, { host_key_sha256: lab.hostKeys.rsa, host_key_algorithm: "ssh-ed25519" },
      { host_key_sha256: lab.hostKeys.ed25519, host_key_algorithm: "rsa-sha2-512" }, { private_key: lab.privateKey, passphrase: lab.secrets.key_passphrase, password: null, host_key_sha256: wrong }]) {
      const e = await ssh2Session(sftpCred(over)).then((x) => { x.close(); return null; }, (x) => x);
      assert.equal(e?.code, "HOST_KEY_CHANGED", JSON.stringify(Object.keys(over)));
      assertNoSecrets("Fehlermeldung", e.message);
    }
    const log = await logSince(lab.names.sshd, mark);
    assert.ok(!AUTH_LINE.test(log), `Zugangsdaten erreichten den Server: ${log.split("\n").filter((l) => AUTH_LINE.test(l)).join(" | ")}`);
    assertNoSecrets("sshd-Log", await sshdLog(lab));
  });

  test("Legacy-Server (nur ssh-rsa/SHA-1): Jarvis aktiviert keine alten Algorithmen → host_key_legacy_only / HOST_KEY_UNSAFE, 0 Login", async () => {
    // Laborbeweis (nur hier, bewusst): der Server bietet tatsächlich ausschliesslich ssh-rsa an.
    const offered = await new Promise((resolve) => { let fp = null; const c = new (require("ssh2").Client)(); c.on("error", () => {}); c.on("close", () => resolve(fp));
      c.connect({ ...lab.legacySsh, username: "probe", algorithms: { serverHostKey: ["ssh-rsa"] }, hostVerifier: (k) => { fp = fingerprintOf(k); return false; } }); });
    assert.equal(offered, lab.legacyHostKeys.rsa);
    const mark = await logMark(lab.names.legacy);
    const d = await discoverHostKeys(lab.legacySsh);
    assert.deepEqual([d.ok, d.reason], [false, "host_key_legacy_only"]);
    const e = await ssh2Session({ ...lab.legacySsh, username: "labuser", password: NEVER_SENT, host_key_sha256: lab.legacyHostKeys.rsa }).catch((x) => x);
    assert.equal(e.code, "HOST_KEY_UNSAFE");
    const e2 = await ssh2Session({ ...lab.legacySsh, username: "labuser", password: NEVER_SENT, host_key_sha256: lab.legacyHostKeys.rsa, host_key_algorithm: "ssh-rsa" }).catch((x) => x);
    assert.equal(e2.code, "HOST_KEY_UNSAFE");
    const log = await logSince(lab.names.legacy, mark);
    assert.match(log, /no matching host key type found|Unable to negotiate/i, "Server sah nur moderne Angebote von Jarvis");
    assert.ok(!AUTH_LINE.test(log));
  });

  test("Private-Key-Auth (Ed25519 + Passphrase): erst nach Host-Key-Verifikation, Login per publickey", async () => {
    const mark = await logMark(lab.names.sshd);
    const s = await ssh2Session(sftpCred({ password: null, private_key: lab.privateKey, passphrase: lab.secrets.key_passphrase }));
    assert.equal(s.host_key.algorithm, "rsa-sha2-512");
    s.close();
    const log = await logSince(lab.names.sshd, mark);
    assert.match(log, /Accepted publickey for labuser/);
    assert.ok(!/Accepted password/.test(log));
  });

  // ===================================================================================================================
  // SFTP gegen echten OpenSSH/SFTP-Server
  // ===================================================================================================================
  test("SFTP-Sandbox (echter Server): ../, /etc, /root, .ssh, .env, Symlinks nach aussen blockiert – 0 Write ausserhalb des Webroots", async () => {
    await resetSite(lab);
    const outBefore = await outsideSnapshot(lab), webBefore = await webrootSnapshot(lab);
    const a = sftpAdapter({ dir: tmp(), fetchFn: lab.fetch });
    const c = await ssh2SftpConnector()(sftpCred());
    try {
      const { atomicWrite, readText } = a._internals;
      for (const rel of ["../notes.html", "/etc/passwd", "/root/x.html", "../.ssh/authorized_keys", ".ssh/authorized_keys", ".env", "../.env", "etc-link/passwd",
        "etc-link/hostname.html", "outside.html", "/home/labuser/notes.html", "css/../../notes.html", "wp-config.php", "x.php"]) {
        await assert.rejects(atomicWrite(c, ROOT, rel, "<html>pwned</html>", 0o644), (e) => /SANDBOX|Pfad|verweigert|Symlink|Dateityp|existiert/i.test(`${e.code} ${e.message}`), `Write ${rel}`);
        if (/\.html?$|passwd$/.test(rel)) await assert.rejects(readText(c, ROOT, rel), undefined, `Read ${rel}`);
      }
      await assert.rejects(resolveSafe(c, ROOT, "etc-link/passwd"), /Symlink|Escape/);
      for (const r of ["/etc", "/root", "/home/labuser", "/", "/home", "/srv"]) assert.equal(validateRemoteRoot(r).ok, false, r);
    } finally { c.close(); }
    for (const [cred, reason] of [[sftpCred({ remote_root: "/etc" }), "remote_root_system_dir"], [sftpCred({ username: "root" }), "root_login"], [sftpCred({ remote_root: "/home/labuser" }), "remote_root_too_broad"]]) {
      const r = await a.checkAccess(order(DOMAINS.site), cred);
      assert.deepEqual([r.ok, r.reason, r.blocked_state], [false, reason, "BLOCKED_UNSAFE_ACCESS"]);
    }
    assert.equal(await outsideSnapshot(lab), outBefore, "0 Write ausserhalb des Test-Webroots");
    assert.equal(await webrootSnapshot(lab), webBefore, "Webroot unverändert");
  });

  test("SFTP real: connect → read → hash → backup → temp upload → atomic rename → re-read → validate (Link, Bild, CSS) = erwartete Reparatur", async () => {
    await resetSite(lab);
    const ops = [];
    const dir = tmp(), a = sftpAdapter({ dir, fetchFn: lab.fetch, connect: spyConnector(ops) }), o = order(DOMAINS.site), c = sftpCred();
    const outBefore = await outsideSnapshot(lab);
    const acc = await a.checkAccess(o, c);
    assert.equal(acc.ok, true, acc.reason);
    for (const cap of ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"]) assert.ok(acc.capabilities.includes(cap), cap);
    assert.ok((await a.backup(o, c)).production_ref.startsWith("sftp:"));
    const issues = [
      { type: "broken_link", url: `https://${DOMAINS.site}/team-alt.html`, page: `https://${DOMAINS.site}/` },
      { type: "broken_image", url: `https://${DOMAINS.site}/assets/lab-logo.svg`, page: `https://${DOMAINS.site}/` },
      { type: "mobile_overflow", page: `https://${DOMAINS.site}/`, css_fix: { file: "css/site.css", from: ".hero { width: 1400px; }", to: ".hero { max-width: 100%; }" } },
    ];
    for (const issue of issues) {
      const loc = await a.locate(issue, o, c);
      assert.ok(loc, issue.type);
      const before = sha256(await siteFile(lab, loc.files[0].path));
      assert.equal(loc.files[0].before_hash, before, "Hash vor dem Write");
      const r = await a.applyFix(issue, loc, o, c);
      assert.equal(r.ok, true);
      assert.equal(r.after_hash, sha256(await siteFile(lab, loc.files[0].path)), "Re-Read = geschriebener Stand");
      assert.equal((await a.validate({ ...issue, location: loc }, o, c)).build_ok, true, `validate ${issue.type}`);
    }
    assert.equal(await siteFile(lab, "index.html"), fixture("static-repaired/index.html"));
    assert.equal(await siteFile(lab, "css/site.css"), fixture("static-repaired/css/site.css"));
    const live = await (await lab.fetch(`https://${DOMAINS.site}/`)).text();
    assert.ok(live.includes('href="/team.html"') && live.includes('src="/assets/img/lab-logo.svg"') && !live.includes("team-alt"));
    // Backup: Originalinhalt + Hash je Datei lokal (nie Zugangsdaten).
    const bk = JSON.parse(fs.readFileSync(path.join(dir, "repair_backups", `${o.order_id}.json`), "utf8"));
    assert.deepEqual(bk.entries.map((e) => [e.object_id, e.status]), [["index.html", "applied"], ["index.html", "applied"], ["css/site.css", "applied"]]);
    assert.equal(sha256(Buffer.from(bk.entries[0].original_content, "base64").toString("utf8")), sha256(fixture("static-broken/index.html")));
    assertNoSecrets("Backup", JSON.stringify(bk));
    // Atomarer Austausch: jedes Schreiben trifft nur eine Temp-Datei im selben Verzeichnis, danach posix-rename auf das Ziel.
    const writes = ops.filter((x) => x[0] === "write").map((x) => x[1]);
    assert.ok(writes.length && writes.every((p) => /\/\.[^/]+\.tmp$/.test(p)), `nur Temp-Dateien beschrieben: ${writes.join(", ")}`);
    const renames = ops.filter((x) => x[0] === "rename" && !/jarvis-probe/.test(x[1]));
    assert.deepEqual(renames.map((x) => x[2]), [`${ROOT}/index.html`, `${ROOT}/index.html`, `${ROOT}/css/site.css`]);
    assert.ok(renames.every((x) => /\.jarvis-[0-9a-f]+\.tmp$/.test(x[1]) && path.posix.dirname(x[1]) === path.posix.dirname(x[2])), "Temp im selben Verzeichnis → atomarer Rename");
    assert.ok(!/\.jarvis-[0-9a-f]+\.tmp/.test(await webrootSnapshot(lab)), "keine Temp-Dateien");
    assert.equal(await outsideSnapshot(lab), outBefore);
  });

  test("SFTP Rollback real: Regression festgestellt → Rollback über echtes SFTP → before_hash == restored_hash, öffentliche Seite = Original", async () => {
    await resetSite(lab);
    const webBefore = await webrootSnapshot(lab);
    const a = sftpAdapter({ dir: tmp(), fetchFn: lab.fetch }), o = order(DOMAINS.site), c = sftpCred();
    const issue = { type: "broken_link", url: `https://${DOMAINS.site}/team-alt.html`, page: `https://${DOMAINS.site}/` };
    const loc = await a.locate(issue, o, c);
    const css = { type: "mobile_overflow", css_fix: { file: "css/site.css", from: ".hero { width: 1400px; }", to: ".hero { max-width: 100%; }" } };
    const cssLoc = await a.locate(css, o, c);
    assert.equal((await a.applyFix(issue, loc, o, c)).ok, true);
    assert.equal((await a.applyFix(css, cssLoc, o, c)).ok, true);
    assert.notEqual(await webrootSnapshot(lab), webBefore);
    // Simulierte Regression: öffentlicher Retest liefert HTTP 500 → Validierung schlägt fehl.
    lab.fetch.setFault(async (url) => (url === `https://${DOMAINS.site}/` ? response(500, "Regression (Lab)", url) : null));
    try { assert.equal((await a.validate({ ...issue, location: loc }, o, c)).build_ok, false); } finally { lab.fetch.setFault(null); }
    assert.equal((await a.rollback(o, null, c)).ok, true);
    assert.equal(sha256(await siteFile(lab, "index.html")), loc.files[0].before_hash, "before_hash == restored_hash (index.html)");
    assert.equal(sha256(await siteFile(lab, "css/site.css")), cssLoc.files[0].before_hash, "before_hash == restored_hash (site.css)");
    assert.equal(await webrootSnapshot(lab), webBefore, "Webroot exakt im Originalzustand");
    assert.equal(await (await lab.fetch(`https://${DOMAINS.site}/`)).text(), fixture("static-broken/index.html"), "öffentliche Seite = Original");
  });

  test("Domain-Bindung (SFTP): falsche authorized_domain, fehlende Freigabe, Weiterleitung auf fremde Domain → 0 Write", async () => {
    await resetSite(lab);
    const webBefore = await webrootSnapshot(lab);
    const a = sftpAdapter({ dir: tmp(), fetchFn: lab.fetch }), c = sftpCred();
    const issue = { type: "broken_link", url: `https://${DOMAINS.site}/team-alt.html`, page: `https://${DOMAINS.site}/` };
    const loc = await a.locate(issue, order(DOMAINS.site), c);
    for (const o of [order(DOMAINS.site, { authorization: { authorized_domain: "andere-domain.test" } }), order(DOMAINS.site, { customer_authorized_repair: false }),
      order(DOMAINS.sshRedirect)]) {
      const r = await a.applyFix(issue, loc, o, c);
      assert.deepEqual([r.ok, r.domain_mismatch], [false, true]);
    }
    assert.equal(await webrootSnapshot(lab), webBefore, "0 Write");
  });

  // ===================================================================================================================
  // SSH (nur allowlisted Checks, keine freie Shell)
  // ===================================================================================================================
  test("SSH real: Host-Key verifiziert, nur allowlisted Build/Health-Check (php -l), keine freie Shell, keine Modell-Befehle", async () => {
    await resetSite(lab);
    const checks = { build: { php_lint: { binary: "php", args: ["-l", "lab-check.php"] } }, health: { php_health: { binary: "php", args: ["-l", "lab-check.php"] } } };
    const c = sftpCred({ checks, host_key_sha256: lab.hostKeys.ed25519, host_key_algorithm: "ssh-ed25519" });
    const a = sshAdapter({ dir: tmp(), fetchFn: lab.fetch });
    const mark = await logMark(lab.names.sshd);
    const session = await ssh2Connector()(c);
    try {
      assert.deepEqual({ ...session.host_key }, { sha256: lab.hostKeys.ed25519, algorithm: "ssh-ed25519" });
      const ops = a.typedOps(session, c);
      assert.ok(Object.isFrozen(ops) && !("exec" in ops) && !("shell" in ops), "keine freie Shell");
      assert.deepEqual(await ops.runConfiguredBuildCheck("php_lint"), { ok: true, exit_code: 0 });
      assert.deepEqual(await ops.runConfiguredHealthCheck("php_health"), { ok: true, exit_code: 0 });
      await assert.rejects(ops.runConfiguredHealthCheck("rm -rf /"), /nicht konfiguriert/);
      await assert.rejects(session.exec(["sh", "-c", "touch /tmp/jarvis-pwn"]), /unzulässig|nicht erlaubt/);
      await assert.rejects(session.exec(["php", "-r", "touch('/tmp/jarvis-pwn');"]), /unzulässig/);
      for (const bad of [{ binary: "php", args: ["-r", "x"] }, { binary: "bash", args: ["-c", "id"] }, { binary: "node", args: ["-e", "1"] }, { binary: "php", args: ["-l", "../../../etc/passwd.php"] }])
        assert.throws(() => checkArgv(bad, ROOT), /nur|nicht|Traversal|unzulässig/);
      assert.equal(await ops.hashFile("index.html"), sha256(fixture("static-broken/index.html")));
    } finally { await session.close(); }
    const r = await a.checkAccess(order(DOMAINS.site), c);
    assert.ok(r.ok && r.capabilities.includes("BUILD_TEST"), r.reason);
    const log = await logSince(lab.names.sshd, mark);
    assert.ok((log.match(/Starting session: command for labuser/g) || []).length >= 2, "nur die zwei allowlisted Checks liefen als Befehl");
    assert.ok(!/Starting session: shell/.test(log), "nie eine Shell");
    assert.equal((await docker(["exec", lab.names.sshd, "test", "-e", "/tmp/jarvis-pwn"], { allowFail: true })).code !== 0, true, "kein eingeschleuster Befehl lief");
  });

  // ===================================================================================================================
  // WordPress REST gegen echte WordPress-Instanz (HTTPS)
  // ===================================================================================================================
  test("WordPress real: Regression → Validation schlägt fehl → Rollback → Originalzustand (Hash), Plugins/Themes/User/Settings unverändert", async () => {
    await resetWp(lab);
    const guard = await wpGuardSnapshot(lab);
    const a = wordpressAdapter({ dir: tmp(), fetchFn: lab.fetch }), o = order(DOMAINS.wp), c = wpCred();
    assert.equal((await a.checkAccess(o, c)).ok, true);
    const issue = { type: "broken_link", url: `https://${DOMAINS.wp}/team-alt/`, page: `https://${DOMAINS.wp}/` };
    const loc = await a.locate(issue, o, c);
    assert.deepEqual(loc.objects.map((x) => [x.object_type, x.object_id]), [["pages", lab.wp.start]]);
    const r = await a.applyFix(issue, loc, o, c);
    assert.equal(r.ok, true);
    assert.equal(await wpContent(lab, lab.wp.start), WP_BROKEN.start.replace("/team-alt/", "/team/"));
    lab.fetch.setFault(async (url) => (url === `https://${DOMAINS.wp}/` ? response(500, "Regression (Lab)", url) : null));
    try { assert.equal((await a.validate({ ...issue, location: loc }, o, c)).build_ok, false, "Validierung erkennt die Regression"); } finally { lab.fetch.setFault(null); }
    assert.equal((await a.rollback(o, null, c)).ok, true);
    assert.equal(sha256(await wpContent(lab, lab.wp.start)), loc.objects[0].before_hash, "before_hash == restored_hash");
    assert.equal(await wpContent(lab, lab.wp.start), WP_BROKEN.start);
    assert.ok((await (await lab.fetch(`https://${DOMAINS.wp}/`)).text()).includes('href="/team-alt/"'), "öffentliche Seite wieder im Original");
    assert.equal(await wpGuardSnapshot(lab), guard, "kein Plugin/Theme/User/Setting geändert");
  });

  test("WordPress real: Access → Capability → Backup → locate → minimaler Fix → REST-Write → Validation → öffentlicher Retest (Link + Bild)", async () => {
    await resetWp(lab);
    const guard = await wpGuardSnapshot(lab);
    const a = wordpressAdapter({ dir: tmp(), fetchFn: lab.fetch }), o = order(DOMAINS.wp), c = wpCred();
    const acc = await a.checkAccess(o, c);
    assert.deepEqual([acc.ok, acc.connector], [true, "wordpress_rest"]);
    for (const cap of ["REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK"]) assert.ok(acc.capabilities.includes(cap), cap);
    assert.ok((await a.backup(o, c)).production_ref.startsWith("wp:"));
    const link = { type: "broken_link", url: `https://${DOMAINS.wp}/team-alt/`, page: `https://${DOMAINS.wp}/` };
    const img = { type: "broken_image", url: `https://${DOMAINS.wp}/wp-content/uploads/2020/01/lab-logo.png`, page: `https://${DOMAINS.wp}/lab-news/` };
    const imgLoc = await a.locate(img, o, c);
    assert.match(imgLoc.replacement, /^\/wp-content\/uploads\/\d{4}\/\d{2}\/lab-logo\.png$/);
    assert.deepEqual(imgLoc.objects.map((x) => [x.object_type, x.object_id]), [["posts", lab.wp.post]]);
    for (const [issue, loc] of [[link, await a.locate(link, o, c)], [img, imgLoc]]) {
      const r = await a.applyFix(issue, loc, o, c);
      assert.equal(r.ok, true);
      assert.equal((await a.validate({ ...issue, location: loc }, o, c)).build_ok, true);
    }
    assert.equal(await wpContent(lab, lab.wp.start), WP_BROKEN.start.replace("/team-alt/", "/team/"), "nur dieser Verweis geändert");
    assert.equal(await wpContent(lab, lab.wp.post), WP_BROKEN.post.replace("/wp-content/uploads/2020/01/lab-logo.png", imgLoc.replacement));
    const retest = await labAuditor(lab.fetch).audit(`https://${DOMAINS.wp}/`);
    assert.deepEqual(retest.issues, [], "öffentlicher Retest ohne Befund");
    assert.equal(await wpGuardSnapshot(lab), guard, "kein Plugin/Theme/User/Setting geändert");
    // Nie ausserhalb der Allowlist schreiben (Plugins/Themes/Benutzer/Einstellungen) – vor jedem Request verweigert.
    const n = lab.fetch.calls.length;
    for (const p of ["/wp/v2/settings", "/wp/v2/users/1", "/wp/v2/plugins/akismet/akismet", "/wp/v2/themes"]) {
      const bad = { family: "content", fix_type: "replace_href", attr: "href", brokenPath: "/x", replacement: "/team/", objects: [{ object_type: p, object_id: 1, before_hash: "x" }] };
      await assert.rejects(a.applyFix(link, bad, o, c), /nicht erlaubt/);
    }
    assert.ok(!lab.fetch.calls.slice(n).some((x) => x.method !== "GET"), "kein Write-Request ausserhalb der Allowlist");
  });

  test("WordPress HTTP-Sicherheit + Domain-Bindung: kein HTTP-Downgrade, keine Credentials an fremde Domain/Redirect, falsche Freigabe → 0 Write", async () => {
    await resetWp(lab);
    const a = wordpressAdapter({ dir: tmp(), fetchFn: lab.fetch });
    const before = await wpContent(lab, lab.wp.start);
    const n = lab.fetch.calls.length;
    assert.equal((await a.checkAccess(order(DOMAINS.wp), wpCred({ api_base: `http://${DOMAINS.wp}/wp-json` }))).reason, "https_required");
    assert.equal((await a.checkAccess(order(DOMAINS.wp), wpCred({ api_base: `https://${DOMAINS.evil}/wp-json` }))).reason, "domain_mismatch");
    await assert.rejects(a.checkAccess(order(DOMAINS.redirect), wpCred({ api_base: `https://${DOMAINS.redirect}/wp-json` })), /Weiterleitung/);
    const calls = lab.fetch.calls.slice(n);
    assert.ok(!calls.some((x) => x.host === DOMAINS.evil && x.authorization), "nie Zugangsdaten an eine fremde Domain");
    assert.ok(!calls.some((x) => x.host === DOMAINS.evil), "Redirect mit Zugangsdaten wird nie verfolgt");
    const issue = { type: "broken_link", url: `https://${DOMAINS.wp}/team-alt/`, page: `https://${DOMAINS.wp}/` };
    const loc = await a.locate(issue, order(DOMAINS.wp), wpCred());
    for (const o of [order(DOMAINS.wp, { authorization: { authorized_domain: "andere-domain.test" } }), order(DOMAINS.wp, { customer_authorized_repair: false })]) {
      const r = await a.applyFix(issue, loc, o, wpCred());
      assert.deepEqual([r.ok, r.domain_mismatch], [false, true]);
    }
    assert.equal(await wpContent(lab, lab.wp.start), before, "0 Write");
  });

  // ===================================================================================================================
  // Vollständige CHF-480-Aufträge (Engine) gegen die echten Testsysteme
  // ===================================================================================================================
  test("FULL WORDPRESS ORDER E2E: CHF480 → Secure Access → Authorization → Profil → Access → Backup → Audit → Plan → Fix → Validation → Retest → COMPLETED", async () => {
    await resetWp(lab);
    const guard = await wpGuardSnapshot(lab);
    const dir = tmp(), store = createStore(dir);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.wp, access_type: "wordpress_cms", payload: { host: `https://${DOMAINS.wp}`, username: "jarvislab", secret: lab.secrets.wp_app_password } });
    const { engine, gmail, logs } = await engineFor(dir, store);
    await engine.processAll();
    let o = readOrder(store, id);
    assert.equal(o.state, "READY_FOR_DELIVERY", `${o.blocked_reason} ${JSON.stringify(o.manual_review)} ${JSON.stringify(o.retest)} ${JSON.stringify(o.regression)}`);
    assert.ok(inOrder(pathOf(o), ["ACCESS_PROFILE_PREFLIGHT", "ACCESS_CHECK", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY"]), pathOf(o).join(" → "));
    assert.deepEqual([o.route.adapter, o.access_profile.profile_status, o.access_profile.interface], ["wordpress", "PROFILE_READY", "wordpress_rest"]);
    assert.equal(Object.values(o.issues).filter((i) => i.repair_status === "repaired").length, 2);
    assert.equal(o.deployment.live_retest_ok, true);
    assert.ok(o.retest.desktop.ok && o.retest.mobile.ok);
    assert.equal(await wpContent(lab, lab.wp.start), WP_BROKEN.start.replace("/team-alt/", "/team/"));
    completeOrder(store, id);
    o = readOrder(store, id);
    assert.equal(o.state, "COMPLETED");
    assert.equal(fs.existsSync(path.join(dir, ACCESS_VAULT_DIR, `${id}.json`)), false, "Tresor-Eintrag entfernt");
    assert.deepEqual(["connector_type", "received_at", "destroyed_at", "revoked_required"].map((k) => o.access_intake[k] != null), [true, true, true, true]);
    assert.equal(o.access_intake.revoked_required, true);
    assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 0, "keine echte Mail");
    for (const [f, text] of filesOf(dir)) assertNoSecrets(f, text);
    assertNoSecrets("Logs", logs.join("\n"));
    assert.equal(await wpGuardSnapshot(lab), guard, "kein Plugin/Theme/User/Setting geändert");
  });

  test("FULL SFTP ORDER E2E: CHF480 → Access → Authorization → Host-Key (RSA, Server bevorzugt Ed25519) → Profil → Login → … → Atomic Replace → COMPLETED", async () => {
    await resetSite(lab);
    const outBefore = await outsideSnapshot(lab);
    const dir = tmp(), store = createStore(dir);
    const mark = await logMark(lab.names.sshd);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "sftp",
      payload: { host: `sftp://${lab.ssh.host}:${lab.ssh.port}`, username: "labuser", secret: lab.secrets.labuser_password, remote_root: "public_html", ssh_host_key_sha256: lab.hostKeys.rsa } });
    const { engine, gmail, logs } = await engineFor(dir, store);
    await engine.processAll();
    let o = readOrder(store, id);
    assert.equal(o.state, "READY_FOR_DELIVERY", `${o.blocked_reason} ${JSON.stringify(o.manual_review)} ${JSON.stringify(o.retest)} ${JSON.stringify(o.regression)}`);
    assert.ok(inOrder(pathOf(o), ["ACCESS_PROFILE_PREFLIGHT", "ACCESS_CHECK", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY"]), pathOf(o).join(" → "));
    const ap = o.access_profile;
    assert.deepEqual([ap.profile_status, ap.host_key_sha256, ap.host_key_algorithm, ap.host_key_verified, ap.host_key_source, ap.remote_root, ap.webroot_source],
      ["PROFILE_READY", lab.hostKeys.rsa, "rsa-sha2-512", true, "customer_form", ROOT, "customer_form"]);
    assert.equal(ap.profile_hash, profileHash(ap), "Profil-Hash über interface/port/remote_root/host_key_sha256/host_key_algorithm/capabilities");
    assert.equal(Object.values(o.issues).filter((i) => i.repair_status === "repaired").length, 2);
    assert.equal(await siteFile(lab, "index.html"), fixture("static-repaired/index.html"));
    const log = await logSince(lab.names.sshd, mark);
    assert.match(log, /Accepted password for labuser/);
    const bk = JSON.parse(fs.readFileSync(path.join(dir, "repair_backups", `${id}.json`), "utf8"));
    assert.ok(bk.entries.length === 2 && bk.entries.every((e) => e.status === "applied"), "je Fix ein Backup-Eintrag (Original + Hash)");
    assert.equal(bk.entries.at(-1).after_hash, sha256(await siteFile(lab, "index.html")), "Re-Read = letzter atomar geschriebener Stand");
    assert.ok(!/\.jarvis-[0-9a-f]+\.tmp/.test(await webrootSnapshot(lab)), "keine Temp-Dateien übrig");
    const pub = publicRepairOrders(dir).orders.find((x) => x.order_id === id);
    assert.equal(pub.host_key_verified, true);
    for (const v of [lab.hostKeys.rsa, "rsa-sha2-512", "127.0.0.1", "labuser", ROOT]) assert.ok(!JSON.stringify(pub).includes(v), `Dashboard ohne ${v}`);
    completeOrder(store, id);
    o = readOrder(store, id);
    assert.equal(o.state, "COMPLETED");
    assert.equal(fs.existsSync(path.join(dir, ACCESS_VAULT_DIR, `${id}.json`)), false);
    assert.equal(o.access_profile.host_key_sha256, undefined);
    assert.equal(o.access_profile.host_key_verified, true);
    assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 0);
    for (const [f, text] of filesOf(dir)) assertNoSecrets(f, text);
    assertNoSecrets("Logs", logs.join("\n"));
    assert.equal(await outsideSnapshot(lab), outBefore, "0 Write ausserhalb des Webroots");
  });

  test("FULL SSH/SFTP ORDER E2E: Host-Key Ed25519 verifiziert → SSH (Private Key) → SFTP-Fix → allowlisted Health Check → Validation → COMPLETED", async () => {
    await resetSite(lab);
    const dir = tmp(), store = createStore(dir);
    setAccessProfile(store, DOMAINS.site, { interface: "ssh", remote_root: ROOT,
      checks: { build: { php_lint: { binary: "php", args: ["-l", "lab-check.php"] } }, health: { php_health: { binary: "php", args: ["-l", "lab-check.php"] } } } });
    const mark = await logMark(lab.names.sshd);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "ssh",
      payload: { host: `ssh://${lab.ssh.host}:${lab.ssh.port}`, username: "labuser", secret: lab.privateKey, passphrase: lab.secrets.key_passphrase, ssh_host_key_sha256: lab.hostKeys.ed25519 } });
    const { engine, logs } = await engineFor(dir, store);
    await engine.processAll();
    let o = readOrder(store, id);
    assert.equal(o.state, "READY_FOR_DELIVERY", `${o.blocked_reason} ${JSON.stringify(o.manual_review)} ${JSON.stringify(o.retest)} ${JSON.stringify(o.regression)}`);
    assert.deepEqual([o.route.adapter, o.access_profile.host_key_algorithm, o.access_profile.host_key_verified, o.access_profile.webroot_source], ["ssh", "ssh-ed25519", true, "chris_profile"]);
    assert.ok(o.access.capabilities.includes("BUILD_TEST"));
    assert.equal(o.deployment.deploy_ref, "live:ssh+sftp");
    assert.equal(await siteFile(lab, "index.html"), fixture("static-repaired/index.html"));
    const log = await logSince(lab.names.sshd, mark);
    assert.match(log, /Accepted publickey for labuser/);
    assert.ok(!/Accepted password/.test(log));
    assert.ok((log.match(/Starting session: command for labuser/g) || []).length >= 2, "Build- + Health-Check liefen");
    assert.ok(!/Starting session: shell/.test(log), "keine freie Shell");
    completeOrder(store, id);
    o = readOrder(store, id);
    assert.equal(o.state, "COMPLETED");
    assert.equal(fs.existsSync(path.join(dir, ACCESS_VAULT_DIR, `${id}.json`)), false, "Private Key aus dem Tresor entfernt");
    // Einziger Schlüssel im Worker-Verzeichnis: der eigene Tresor-Schlüssel von Jarvis (access_intake_private.pem) – nie der Kundenschlüssel.
    for (const [f, text] of filesOf(dir)) { assertNoSecrets(f, text); if (f !== ACCESS_KEY_FILE) assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${f}: Schlüssel persistiert`); }
    assertNoSecrets("Logs", logs.join("\n"));
  });

  test("Host-Key-Wechsel im laufenden Auftrag (echter OpenSSH, Schlüssel rotiert nach PROFILE_READY) → BLOCKED_HOST_KEY_CHANGED, 0 Login, 0 Write", async () => {
    await resetSite(lab);
    const rot = `${lab.names.sshd}-rot`;
    await docker(["run", "-d", "--name", rot, "--label", LAB_LABEL, "--label", `jarvis.lab.run=${lab.rid}`, "--network", lab.names.edge, "-p", "127.0.0.1::22", "-v", `${lab.names.site}:/home/labuser/public_html`, SSHD_IMAGE]);
    const port = Number((await docker(["port", rot, "22/tcp"])).stdout.split(/\r?\n/)[0].split(":").pop());
    for (let i = 0; i < 60 && !/Server listening/.test(await sshdLog(lab, rot)); i++) await new Promise((r) => setTimeout(r, 500));
    await docker(["exec", "-i", rot, "chpasswd"], { input: `labuser:${lab.secrets.labuser_password}\n` });
    const keys = await hostKeysOf(rot);
    const webBefore = await webrootSnapshot(lab);
    const dir = tmp(), store = createStore(dir);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "sftp",
      payload: { host: `sftp://127.0.0.1:${port}`, username: "labuser", secret: lab.secrets.labuser_password, remote_root: "public_html", ssh_host_key_sha256: keys.rsa } });
    const { engine } = await engineFor(dir, store);
    for (let i = 0; i < 20; i++) {
      const o = readOrder(store, id);
      if (o.state === "ACCESS_CHECK" && o.access_profile?.profile_status === "PROFILE_READY") break;
      if (!(await engine.step(o))) break;
    }
    assert.deepEqual([readOrder(store, id).access_profile.profile_status, readOrder(store, id).access_profile.host_key_algorithm], ["PROFILE_READY", "rsa-sha2-512"]);
    // Server-Schlüssel rotieren (Neuinstallation/Angriff simuliert): neue Host-Keys, sshd lädt neu.
    await docker(["exec", rot, "sh", "-c", "rm -f /etc/ssh/lab/ssh_host_rsa_key* && ssh-keygen -q -t rsa -b 3072 -N '' -f /etc/ssh/lab/ssh_host_rsa_key && kill -HUP 1"]);
    for (let i = 0; i < 60 && (await hostKeysOf(rot)).rsa === keys.rsa; i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1500));
    const mark = (await sshdLog(lab, rot)).length;
    await engine.processAll();
    const o = readOrder(store, id);
    assert.equal(o.state, "BLOCKED_HOST_KEY_CHANGED", o.blocked_reason);
    assert.ok(o.alerts.some((x) => x.kind === "host_key_changed"));
    const log = (await sshdLog(lab, rot)).slice(mark);
    assert.ok(/Connection from/.test(log), "Jarvis hat den Server erreicht");
    assert.ok(!AUTH_LINE.test(log), `nach dem Wechsel keine Zugangsdaten gesendet: ${log.split("\n").filter((l) => AUTH_LINE.test(l)).join(" | ")}`);
    assert.equal(await webrootSnapshot(lab), webBefore, "0 Write");
    await docker(["rm", "-f", "-v", rot], { allowFail: true });
  });

  test("Payment-/Authorization-Gate (echte Testsysteme): CHF239/240/479 → blockiert; CHF480 + Freigabe → Preflight; Freigabe=false → 0 Write", async () => {
    await resetSite(lab);
    const webBefore = await webrootSnapshot(lab);
    const payload = { host: `sftp://${lab.ssh.host}:${lab.ssh.port}`, username: "labuser", secret: lab.secrets.labuser_password, remote_root: "public_html", ssh_host_key_sha256: lab.hostKeys.ed25519 };
    // CHF 239: keine einzige Verbindung (auch keine Host-Key-Probe), keine HTTPS-Abfrage mit Zugangsdaten. (Der Zugang selbst wird
    // Erst ab CHF 480 angenommen – hier fällt die Zahlung danach per Storno + Neubuchung auf CHF 239.)
    const dir = tmp(), store = createStore(dir);
    const id = orderWithAccess(store, dir, { domain: DOMAINS.site, access_type: "sftp", payload });
    const ledger = store.read("payments.json", { payments: {} });
    const first = Object.values(ledger.payments || {}).find((p) => p.order_id === id);
    assert.ok(first, "Test-Ledger-Eintrag");
    voidPayment(store, first.payment_id, { reason: "Lab: Betrag korrigiert" });
    recordPayment(store, { order_id: id, amount_chf: 239, reference: `Lab-${id}-239` });
    const { engine } = await engineFor(dir, store);
    let mark = await logMark(lab.names.sshd);
    const n = lab.fetch.calls.length;
    await engine.processAll();
    assert.equal(readOrder(store, id).state, "PAYMENT_REQUIRED");
    assert.ok(!/Connection from/.test(await logSince(lab.names.sshd, mark)), "0 Adapter-Verbindung bei CHF 239");
    assert.ok(!lab.fetch.calls.slice(n).some((x) => x.authorization));
    // +CHF 1 → CHF 240 bleibt blockiert; auch CHF 479 darf keinen Preflight starten.
    recordPayment(store, { order_id: id, amount_chf: 1, reference: `Lab-${id}-240` });
    mark = await logMark(lab.names.sshd);
    await engine.processAll();
    let o = readOrder(store, id);
    assert.equal(o.state, "PAYMENT_REQUIRED");
    assert.ok(!/Connection from/.test(await logSince(lab.names.sshd, mark)), "0 Adapter-Verbindung bei CHF 240");
    recordPayment(store, { order_id: id, amount_chf: 239, reference: `Lab-${id}-479` });
    mark = await logMark(lab.names.sshd);
    await engine.processAll();
    o = readOrder(store, id);
    assert.equal(o.state, "PAYMENT_REQUIRED");
    assert.ok(!/Connection from/.test(await logSince(lab.names.sshd, mark)), "0 Adapter-Verbindung bei CHF 479");
    // +CHF 1 → CHF 480: Vollzahlungs-Gate erlaubt Preflight (Host-Key ohne Login, dann gepinnter Login).
    recordPayment(store, { order_id: id, amount_chf: 1, reference: `Lab-${id}-480` });
    mark = await logMark(lab.names.sshd);
    await engine.processAll();
    o = readOrder(store, id);
    assert.ok(pathOf(o).includes("ACCESS_PROFILE_PREFLIGHT"), pathOf(o).join(" → "));
    assert.equal(o.access_profile.profile_status, "PROFILE_READY");
    assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
    assert.match(await logSince(lab.names.sshd, mark), /Accepted password for labuser/);
    // CHF 480 + Zugang, aber customer_authorized_repair=false → 0 Write, 0 Login.
    await resetSite(lab);
    const dir2 = tmp(), store2 = createStore(dir2);
    const id2 = orderWithAccess(store2, dir2, { domain: DOMAINS.site, access_type: "sftp", payload });
    const data = store2.read(REPAIR_ORDERS_FILE, { orders: {} });
    data.orders[id2].customer_authorized_repair = false;
    store2.write(REPAIR_ORDERS_FILE, data);
    mark = await logMark(lab.names.sshd);
    await (await engineFor(dir2, store2)).engine.processAll();
    assert.equal(readOrder(store2, id2).state, "BLOCKED_NO_AUTHORIZATION");
    assert.ok(!AUTH_LINE.test(await logSince(lab.names.sshd, mark)), "0 Login ohne Freigabe");
    assert.equal(await webrootSnapshot(lab), webBefore, "0 Write ohne Freigabe");
  });
}
