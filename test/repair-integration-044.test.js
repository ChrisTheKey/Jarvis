// REAL ADAPTER INTEGRATION LAB + HOST-KEY TYPE SAFETY (TF-044) – schneller Teil (normale Suite, ohne Docker).
// Echte SSH-Handshakes gegen isolierte In-Process-ssh2-Testserver auf 127.0.0.1 (Host-Keys + Zugangsdaten je Lauf zufällig
// erzeugt, nie gespeichert). Die Docker-Integration gegen echtes OpenSSH/SFTP + WordPress liegt in test/integration/repair-lab/
// (npm run test:repair-integration). Keine Kundensysteme, keine echte Mail, keine echten Zugangsdaten.
import { test as baseTest } from "node:test";
// Jeder Test mit Obergrenze: ein Fehler (z. B. eine Mutation, die eine Sitzung öffnet) wird rot statt zu hängen.
const test = (name, fn) => baseTest(name, { timeout: 60_000 }, fn);
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, createRepairEngine, publicRepairOrders, repairOrdersStatus, BLOCKED_STATES } from "../repair-workflow.js";
import { consentText, tokenHash } from "../access-intake-api.js";
import { applyAccessSubmission, accessKeys, sealEnvelope } from "../access-intake.js";
import { cleanRepair } from "../server-control.js";
import { ssh2Session, sftpAdapter, assertHostKeyPinned } from "../repair-adapters/sftp.js";
import { createAdapterRegistry, setAccessProfile, buildCredentialContext, effectiveProfile, adapterRegistryStatus } from "../repair-adapters/router.js";
import { createProfilePreflight, profileHash, profileRecord, PROFILE_HASH_KEYS, PROFILE_RECORD_KEYS, ssh2HostKeyProbe } from "../repair-adapters/profile-builder.js";
import { safeHostKeyAlgorithms, discoverHostKeys, matchHostKey, ssh2ProbeHostKeyAlgorithm, pinnedHostKeyOptions, fingerprintOf, HostKeyError,
  LEGACY_HOST_KEY_ALGORITHMS, MODERN_HOST_KEY_ALGORITHMS, hostKeyVerifierStatus } from "../repair-adapters/host-key.js";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PW = "PW" + crypto.randomBytes(12).toString("hex");          // künstliches Testpasswort (je Lauf)
const PASSPHRASE = "PP" + crypto.randomBytes(12).toString("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-hk44-"));
const fpOf = (k) => fingerprintOf(utils.parseKey(k.public).getPublicSSH());
// Host-Keys einmal je Lauf erzeugen (RSA dauert).
const ED = utils.generateKeyPairSync("ed25519"), ED2 = utils.generateKeyPairSync("ed25519"), RSA = utils.generateKeyPairSync("rsa", { bits: 2048 });
const CLIENT_KEY = utils.generateKeyPairSync("ed25519", { passphrase: PASSPHRASE, cipher: "aes256-cbc", rounds: 16 });

// Isolierter ssh2-Testserver: protokolliert jede Anmeldung (Methode, ob das Passwort stimmte – nie den Wert).
async function sshServer({ keys = [ED, RSA], serverHostKey = null, clientKey = null } = {}) {
  const ev = { conns: 0, auth: [] }, clients = [];
  const pub = clientKey ? utils.parseKey(clientKey.public) : null;
  const srv = new Server({ hostKeys: keys.map((k) => k.private), ...(serverHostKey ? { algorithms: { serverHostKey } } : {}) }, (client) => {
    ev.conns++; clients.push(client);
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      ev.auth.push({ method: ctx.method, user: ctx.username, password_ok: ctx.method === "password" ? ctx.password === PW : undefined });
      if (ctx.method === "password" && ctx.password === PW) return ctx.accept();
      if (ctx.method === "publickey" && pub && ctx.key.algo === pub.type && Buffer.compare(ctx.key.data, pub.getPublicSSH()) === 0) {
        if (!ctx.signature) return ctx.accept();
        if (pub.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      ctx.reject();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  // Beim Schliessen alle Verbindungen trennen – eine (fälschlich) aufgebaute Sitzung darf den Test nie hängen lassen.
  return { ev, port: srv.address().port, close: () => new Promise((r) => { for (const c of clients) { try { c.end(); } catch {} } srv.close(() => r()); }) };
}
const cred = (port, over = {}) => ({ host: "127.0.0.1", port, username: "labuser", password: PW, ...over });
const noCredential = (ev) => ev.auth.every((a) => a.method === "none") && !ev.auth.some((a) => a.password_ok !== undefined);

// =====================================================================================================================
test("Algorithmen: nur moderne Host-Keys (Ed25519, ECDSA, RSA-SHA2) – ssh-rsa (SHA-1) und ssh-dss nie, auch nicht als Rückfall", () => {
  const safe = safeHostKeyAlgorithms();
  assert.deepEqual(safe, ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256"]);
  for (const legacy of LEGACY_HOST_KEY_ALGORITHMS) assert.ok(!safe.includes(legacy) && !MODERN_HOST_KEY_ALGORITHMS.includes(legacy), legacy);
  assert.throws(() => pinnedHostKeyOptions({ fingerprint: fpOf(RSA), algorithm: "ssh-rsa" }), (e) => e.code === "HOST_KEY_ALGORITHM_UNSAFE");
  assert.throws(() => pinnedHostKeyOptions({ fingerprint: fpOf(RSA), algorithm: "ssh-dss" }), (e) => e.code === "HOST_KEY_ALGORITHM_UNSAFE");
  assert.deepEqual(hostKeyVerifierStatus(), { status: "ACTIVE", algorithms: safe, legacy_allowed: false });
  assert.equal(adapterRegistryStatus().host_key_verifier.status, "ACTIVE");
});

test("Discovery ohne Login: je Algorithmus eigene Probe (max. 5 – OpenSSH PerSourcePenalties), Ed25519 + RSA erkannt, 0 Zugangsdaten", async () => {
  const s = await sshServer();
  try {
    const d = await discoverHostKeys({ host: "127.0.0.1", port: s.port });
    assert.equal(d.ok, true);
    assert.deepEqual(d.keys.map((k) => [k.algorithm, k.fingerprint, k.key_type]), [["ssh-ed25519", fpOf(ED), "ssh-ed25519"], ["rsa-sha2-512", fpOf(RSA), "ssh-rsa"]]);
    assert.deepEqual(matchHostKey(d.keys, fpOf(RSA)), { ok: true, fingerprint: fpOf(RSA), algorithm: "rsa-sha2-512", key_type: "ssh-rsa" }, "ein RSA-Schlüssel, bevorzugt SHA-512");
    assert.equal(s.ev.auth.length, 0, "keine einzige Anmeldung (auch nicht 'none')");
    assert.equal(s.ev.conns, 5, "eine Verbindung je Schlüsseltyp-Kandidat, rsa-sha2-256 nur als Rückfall (gleicher Schlüssel)");
  } finally { await s.close(); }
  // Server ohne rsa-sha2-512: RSA-SHA2-256 wird als Rückfall geprüft und gepinnt (nie ssh-rsa/SHA-1).
  const s256 = await sshServer({ keys: [RSA], serverHostKey: ["rsa-sha2-256"] });
  try {
    const d = await discoverHostKeys({ host: "127.0.0.1", port: s256.port });
    assert.deepEqual(d.keys.map((k) => k.algorithm), ["rsa-sha2-256"]);
    const sess = await ssh2Session(cred(s256.port, { host_key_sha256: fpOf(RSA) }), { withSftp: false });
    assert.equal(sess.host_key.algorithm, "rsa-sha2-256");
    sess.close();
  } finally { await s256.close(); }
});

test("Login ohne gespeicherten Algorithmus: Discovery nur EINMAL je Server+Fingerprint (Cache), danach nur gepinnte Logins", async () => {
  const s = await sshServer();
  try {
    const c = cred(s.port, { host_key_sha256: fpOf(RSA) });
    for (let i = 0; i < 3; i++) { const sess = await ssh2Session(c, { withSftp: false }); assert.equal(sess.host_key.algorithm, "rsa-sha2-512"); sess.close(); }
    assert.equal(s.ev.conns, 5 + 3, "5 Pre-Auth-Probes einmalig + 3 gepinnte Logins");
    assert.equal(s.ev.auth.filter((a) => a.password_ok === true).length, 3);
  } finally { await s.close(); }
});

test("Ed25519 bestätigt: findet Ed25519 → verifiziert → pinnt ssh-ed25519 → Login (Passwort erst NACH der Prüfung)", async () => {
  const s = await sshServer();
  try {
    const m = matchHostKey((await discoverHostKeys({ host: "127.0.0.1", port: s.port })).keys, fpOf(ED));
    assert.deepEqual([m.ok, m.algorithm], [true, "ssh-ed25519"]);
    assert.equal(s.ev.auth.length, 0);
    const sess = await ssh2Session(cred(s.port, { host_key_sha256: fpOf(ED), host_key_algorithm: m.algorithm }), { withSftp: false });
    assert.deepEqual({ ...sess.host_key }, { sha256: fpOf(ED), algorithm: "ssh-ed25519" });
    sess.close();
    assert.ok(s.ev.auth.some((a) => a.method === "password" && a.password_ok === true), "Login erlaubt");
  } finally { await s.close(); }
});

test("RSA-SHA2 bestätigt, Server bevorzugt Ed25519: TF-043-Einschränkung behoben – RSA erkannt, rsa-sha2-512 gepinnt, Login über RSA", async () => {
  const s = await sshServer({ keys: [ED, RSA] });
  try {
    // Vorher (TF-043): freie Aushandlung liefert nur den bevorzugten Ed25519-Schlüssel → RSA-Fingerprint «passt nicht».
    assert.equal(await ssh2HostKeyProbe({ host: "127.0.0.1", port: s.port, timeoutMs: 5000 }), fpOf(ED));
    // Jetzt: Login ohne vorgegebenen Algorithmus → Discovery ohne Zugangsdaten → RSA-Treffer → gepinnt.
    const sess = await ssh2Session(cred(s.port, { host_key_sha256: fpOf(RSA) }), { withSftp: false });
    assert.deepEqual({ ...sess.host_key }, { sha256: fpOf(RSA), algorithm: "rsa-sha2-512" });
    sess.close();
    const firstAuth = s.ev.auth.findIndex((a) => a.method === "password");
    assert.ok(firstAuth >= 0 && s.ev.auth[firstAuth].password_ok === true);
    // Mit gepinntem Algorithmus direkt (Profil) ebenfalls nur RSA.
    const s2 = await ssh2Session(cred(s.port, { host_key_sha256: fpOf(RSA), host_key_algorithm: "rsa-sha2-256" }), { withSftp: false });
    assert.equal(s2.host_key.algorithm, "rsa-sha2-256");
    s2.close();
  } finally { await s.close(); }
});

test("Falscher Fingerprint: MANUAL_REVIEW bzw. HOST_KEY_CHANGED – 0 Login, 0 Credential Send, nie Passwort in Fehlern", async () => {
  const s = await sshServer();
  try {
    const wrong = fpOf(ED2);
    assert.deepEqual(matchHostKey((await discoverHostKeys({ host: "127.0.0.1", port: s.port })).keys, wrong), { ok: false, reason: "host_key_no_match" });
    for (const over of [{}, { host_key_algorithm: "ssh-ed25519" }, { host_key_algorithm: "rsa-sha2-512" }]) {
      const err = await ssh2Session(cred(s.port, { host_key_sha256: wrong, ...over }), { withSftp: false }).then((x) => { x.close(); return null; }, (e) => e);
      assert.equal(err?.code, "HOST_KEY_CHANGED", JSON.stringify(over));
      assert.ok(!String(err.message).includes(PW));
    }
    // Private Key ebenfalls nie vor der Prüfung.
    const err = await ssh2Session({ host: "127.0.0.1", port: s.port, username: "labuser", private_key: CLIENT_KEY.private, passphrase: PASSPHRASE, host_key_sha256: wrong, host_key_algorithm: "ssh-ed25519" }, { withSftp: false }).then((x) => { x.close(); return null; }, (e) => e);
    assert.equal(err?.code, "HOST_KEY_CHANGED");
    assert.ok(noCredential(s.ev), `keine Zugangsdaten am Server: ${JSON.stringify(s.ev.auth)}`);
    assert.ok(!s.ev.auth.some((a) => a.method === "password" || a.method === "publickey"));
  } finally { await s.close(); }
});

test("Host-Key-Wechsel: bestätigt Fingerprint A + Algorithmus A, Server zeigt B bzw. anderen Algorithmus → HOST_KEY_CHANGED, 0 Login", async () => {
  const before = await sshServer({ keys: [ED, RSA] });
  const pinned = { host_key_sha256: fpOf(ED), host_key_algorithm: "ssh-ed25519" };
  try { const ok = await ssh2Session(cred(before.port, pinned), { withSftp: false }); ok.close(); } finally { await before.close(); }
  // Server neu aufgesetzt: anderer Ed25519-Schlüssel.
  const after = await sshServer({ keys: [ED2, RSA] });
  try {
    assert.equal((await ssh2Session(cred(after.port, pinned), { withSftp: false }).then((x) => { x.close(); return x; }, (e) => e)).code, "HOST_KEY_CHANGED");
    // Fingerprint gleich, aber anderer Algorithmus gepinnt (RSA-Fingerprint mit Ed25519-Algorithmus) → ebenfalls STOP.
    assert.equal((await ssh2Session(cred(after.port, { host_key_sha256: fpOf(RSA), host_key_algorithm: "ssh-ed25519" }), { withSftp: false }).then((x) => { x.close(); return x; }, (e) => e)).code, "HOST_KEY_CHANGED");
    assert.ok(noCredential(after.ev), JSON.stringify(after.ev.auth));
  } finally { await after.close(); }
  // Server bietet den gepinnten Algorithmus nicht mehr an → STOP (kein Rückfall auf einen anderen Typ).
  const onlyRsa = await sshServer({ keys: [RSA] });
  try {
    assert.equal((await ssh2Session(cred(onlyRsa.port, pinned), { withSftp: false }).then((x) => { x.close(); return x; }, (e) => e)).code, "HOST_KEY_CHANGED");
    assert.ok(noCredential(onlyRsa.ev));
  } finally { await onlyRsa.close(); }
});

test("Legacy-Server (nur ssh-rsa/SHA-1): keine Aktivierung alter Algorithmen → host_key_legacy_only / HOST_KEY_UNSAFE, 0 Login", async () => {
  const s = await sshServer({ keys: [RSA], serverHostKey: ["ssh-rsa"] });
  try {
    // Laborbeweis: der Server bietet tatsächlich nur ssh-rsa an (bewusst NUR hier im Test aktiviert).
    const legacy = await new Promise((resolve) => {
      const c = new (require("ssh2").Client)();
      c.on("error", () => {}); c.on("close", () => resolve(seen));
      let seen = null;
      c.connect({ host: "127.0.0.1", port: s.port, username: "x", algorithms: { serverHostKey: ["ssh-rsa"] }, hostVerifier: (k) => { seen = fingerprintOf(k); return false; } });
    });
    assert.equal(legacy, fpOf(RSA));
    const before = s.ev.conns;
    const d = await discoverHostKeys({ host: "127.0.0.1", port: s.port });
    assert.deepEqual([d.ok, d.reason, d.keys.length], [false, "host_key_legacy_only", 0]);
    assert.ok(s.ev.conns > before);
    const e1 = await ssh2Session(cred(s.port, { host_key_sha256: fpOf(RSA) }), { withSftp: false }).then((x) => { x.close(); return x; }, (e) => e);
    assert.equal(e1.code, "HOST_KEY_UNSAFE");
    const e2 = await ssh2Session(cred(s.port, { host_key_sha256: fpOf(RSA), host_key_algorithm: "ssh-rsa" }), { withSftp: false }).then((x) => { x.close(); return x; }, (e) => e);
    assert.equal(e2.code, "HOST_KEY_UNSAFE");
    assert.ok(noCredential(s.ev), JSON.stringify(s.ev.auth));
  } finally { await s.close(); }
});

test("Mehrere Treffer (verschiedene Schlüsseltypen mit demselben Fingerprint): fail closed – MANUAL_REVIEW_REQUIRED, keine Auswahl", async () => {
  const fp = fpOf(ED);
  assert.equal(matchHostKey([{ algorithm: "ssh-ed25519", fingerprint: fp, key_type: "ssh-ed25519" }, { algorithm: "ecdsa-sha2-nistp256", fingerprint: fp, key_type: "ecdsa-sha2-nistp256" }], fp).reason, "host_key_multiple_matches");
  const fake = async ({ algorithm }) => {
    if (algorithm === "ssh-ed25519") return { algorithm, fingerprint: fp, key_type: "ssh-ed25519" };
    if (algorithm === "ecdsa-sha2-nistp256") return { algorithm, fingerprint: fp, key_type: "ecdsa-sha2-nistp256" };
    throw new HostKeyError("ALG_NOT_OFFERED");
  };
  fake.algorithmAware = true;
  const connects = [];
  const p = createProfilePreflight({ probeHostKey: fake, connect: async (c) => { connects.push(c); throw new Error("nie"); } });
  const r = await p.run({ order_id: "RF480-20261012-abcdef", domain: "muster.ch" }, { adapter: "sftp", accessCtx: { credential: () => ({ access_type: "sftp", host: "sftp://files.lab.test", username: "kunde", secret: PW, ssh_host_key_sha256: fp }) } });
  assert.deepEqual([r.profile_status, r.reason, r.profile.host_key_verified], ["MANUAL_REVIEW_REQUIRED", "host_key_multiple_matches", false]);
  assert.equal(connects.length, 0, "keine Verbindung mit Zugangsdaten");
});

test("Private-Key-Auth: Schlüssel (mit Passphrase) erst nach Host-Key-Verifikation verwendet; nie im Fehler, nie persistiert", async () => {
  const s = await sshServer({ clientKey: CLIENT_KEY });
  try {
    const c = { host: "127.0.0.1", port: s.port, username: "labuser", private_key: CLIENT_KEY.private, passphrase: PASSPHRASE, host_key_sha256: fpOf(RSA) };
    const sess = await ssh2Session(c, { withSftp: false });
    assert.equal(sess.host_key.algorithm, "rsa-sha2-512");
    sess.close();
    assert.ok(s.ev.auth.some((a) => a.method === "publickey"), "Login per Schlüssel");
    assert.ok(!s.ev.auth.some((a) => a.method === "password"));
    // Falscher Schlüssel-Pin → kein publickey-Versuch.
    const n = s.ev.auth.length;
    const e = await ssh2Session({ ...c, host_key_sha256: fpOf(ED2) }, { withSftp: false }).then((x) => { x.close(); return x; }, (e) => e);
    assert.equal(e.code, "HOST_KEY_CHANGED");
    assert.equal(s.ev.auth.length, n, "kein weiterer Anmeldeversuch");
    for (const v of [PASSPHRASE, CLIENT_KEY.private.split("\n")[1]]) assert.ok(!String(e.message).includes(v));
  } finally { await s.close(); }
});

// Minimaler, nur lesender SFTP-Client für den Preflight (Login-Root /home/kunde, Webroot public_html mit index.html).
function readOnlyClient(log) {
  const dirs = new Set(["/home/kunde", "/home/kunde/public_html"]);
  return {
    realpath: async (p) => (p === "." ? "/home/kunde" : p),
    lstat: async (p) => { if (dirs.has(p)) return { isDir: true, isFile: false, isSymlink: false }; throw new Error("nope"); },
    readdir: async (p) => (p === "/home/kunde/public_html" ? [{ filename: "index.html", attrs: { isFile: true } }] : [{ filename: "public_html", attrs: { isDir: true } }]),
    writeFile: async () => { log.push("WRITE"); throw new Error("read-only"); },
    close: async () => {},
  };
}
test("Preflight (echter Handshake): Kunden-RSA-Fingerprint → PROFILE_READY mit host_key_algorithm + Profil-Hash; Login nur gepinnt", async () => {
  const s = await sshServer({ keys: [ED, RSA] });
  try {
    const connects = [], writes = [];
    const p = createProfilePreflight({ connect: async (c) => { connects.push({ fp: c.host_key_sha256, alg: c.host_key_algorithm, has_secret: !!c.password, auth_before: s.ev.auth.length }); return readOnlyClient(writes); },
      capabilitiesOf: () => ["READ_FILES", "WRITE_FILES"] });
    const order = { order_id: "RF480-20261012-abcdef", domain: "muster.ch" };
    const run = (over) => p.run(order, { adapter: "sftp", accessCtx: { credential: () => ({ access_type: "sftp", host: `sftp://127.0.0.1:${s.port}`, username: "kunde", secret: PW, remote_root: "public_html", ...over }) } });
    const r = await run({ ssh_host_key_sha256: fpOf(RSA) });
    assert.equal(r.profile_status, "PROFILE_READY", r.reason);
    assert.deepEqual([r.profile.host_key_sha256, r.profile.host_key_algorithm, r.profile.host_key_verified, r.profile.host_key_source], [fpOf(RSA), "rsa-sha2-512", true, "customer_form"]);
    assert.equal(r.profile.profile_hash, profileHash(r.profile));
    assert.deepEqual(connects, [{ fp: fpOf(RSA), alg: "rsa-sha2-512", has_secret: true, auth_before: 0 }], "Zugangsdaten erst nach der Host-Key-Prüfung, gepinnt");
    assert.equal(s.ev.auth.length, 0, "Discovery meldet sich nie an");
    // Kein Treffer → MANUAL_REVIEW_REQUIRED, keine Verbindung mit Zugangsdaten.
    const wrong = await run({ ssh_host_key_sha256: fpOf(ED2) });
    assert.deepEqual([wrong.profile_status, wrong.reason, wrong.profile.host_key_verified], ["MANUAL_REVIEW_REQUIRED", "host_key_mismatch", false]);
    // Keine Quelle → Kandidat = bevorzugter sicherer Schlüssel (Ed25519) zur Bestätigung.
    const unconfirmed = await run({});
    assert.deepEqual([unconfirmed.profile_status, unconfirmed.profile.host_key_candidate], ["HOST_KEY_CONFIRMATION_REQUIRED", fpOf(ED)]);
    assert.equal(connects.length, 1, "nur der verifizierte Lauf hat sich angemeldet");
    assert.equal(writes.length, 0);
    assert.ok(!JSON.stringify([r, wrong, unconfirmed]).includes(PW));
  } finally { await s.close(); }
  // Legacy-Server → BLOCKED_UNSAFE_ACCESS (kein Login).
  const legacy = await sshServer({ keys: [RSA], serverHostKey: ["ssh-rsa"] });
  try {
    const p = createProfilePreflight({ connect: async () => { throw new Error("nie"); } });
    const r = await p.run({ order_id: "RF480-20261012-abcdef", domain: "muster.ch" }, { adapter: "sftp", accessCtx: { credential: () => ({ access_type: "sftp", host: `sftp://127.0.0.1:${legacy.port}`, username: "kunde", secret: PW, ssh_host_key_sha256: fpOf(RSA) }) } });
    assert.deepEqual([r.profile_status, r.reason], ["BLOCKED_UNSAFE_ACCESS", "host_key_legacy_only"]);
    assert.ok(noCredential(legacy.ev));
  } finally { await legacy.close(); }
});

test("Profil-Hash + Profil-Metadaten: nur interface/port/remote_root/host_key_sha256/host_key_algorithm/capabilities – nie Secrets/Host", () => {
  assert.deepEqual(PROFILE_HASH_KEYS, ["interface", "port", "remote_root", "host_key_sha256", "host_key_algorithm", "capabilities"]);
  const base = { interface: "sftp", port: 22, remote_root: "/home/kunde/public_html", host_key_sha256: fpOf(RSA), host_key_algorithm: "rsa-sha2-512", capabilities: ["READ_FILES", "WRITE_FILES"] };
  assert.equal(profileHash({ ...base, password: PW, private_key: "x", passphrase: PASSPHRASE, token: "t", host: "files.lab.test", username: "kunde" }), profileHash(base), "Secrets/Host fliessen nie ein");
  assert.notEqual(profileHash({ ...base, host_key_algorithm: "rsa-sha2-256" }), profileHash(base), "Algorithmus ist Teil des Hashes");
  const rec = profileRecord({ profile_status: "PROFILE_READY", reason: "x", profile: { ...base, host_key_verified: true, profile_hash: profileHash(base), password: PW, host: "files.lab.test", username: "kunde" } });
  assert.deepEqual([rec.host_key_algorithm, rec.host_key_verified, rec.profile_hash], ["rsa-sha2-512", true, profileHash(base)]);
  for (const k of ["password", "host", "username", "private_key", "passphrase"]) { assert.ok(!(k in rec), k); assert.ok(!PROFILE_RECORD_KEYS.includes(k), k); }
  assert.equal(profileRecord({ profile_status: "PROFILE_READY", profile: { host_key_algorithm: "ssh-rsa" } }).host_key_algorithm, undefined, "Legacy nie übernommen");
});

test("Router: Profil-Algorithmus nur sicher + nur mit Fingerprint; Credential-Kontext trägt Fingerprint + Algorithmus (Pinning)", () => {
  const dir = tmp(), store = createStore(dir);
  assert.throws(() => setAccessProfile(store, "muster.ch", { remote_root: "/home/k/public_html", host_key_sha256: fpOf(RSA), host_key_algorithm: "ssh-rsa" }), /Algorithmus/);
  assert.throws(() => setAccessProfile(store, "muster.ch", { remote_root: "/home/k/public_html", host_key_algorithm: "ssh-ed25519" }), /Algorithmus/);
  setAccessProfile(store, "muster.ch", { remote_root: "/home/k/public_html", host_key_sha256: fpOf(RSA), host_key_algorithm: "rsa-sha2-512" });
  const order = { domain: "muster.ch", access_profile: { profile_status: "PROFILE_READY", host_key_sha256: fpOf(ED), host_key_algorithm: "ssh-ed25519" } };
  const prof = effectiveProfile(store, order);
  assert.deepEqual([prof.host_key_sha256, prof.host_key_algorithm], [fpOf(RSA), "rsa-sha2-512"], "Profil von Chris hat Vorrang (gemeinsam)");
  const ctx = buildCredentialContext(order, { credential: () => ({ host: "sftp://files.lab.test", username: "kunde", secret: PW }) }, prof);
  assert.deepEqual([ctx.host_key_sha256, ctx.host_key_algorithm], [fpOf(RSA), "rsa-sha2-512"]);
  assert.equal(buildCredentialContext(order, { credential: () => ({ host: "x.lab.test", username: "k", secret: PW }) }, { host_key_sha256: fpOf(RSA), host_key_algorithm: "ssh-dss" }).host_key_algorithm, null);
});

test("Pre-Write-Check: Sitzung mit abweichendem Fingerprint/Algorithmus → STOP vor jedem Write (0 Write)", async () => {
  const writes = [];
  const client = (host_key) => ({ host_key, realpath: async (p) => p, lstat: async () => ({ isFile: true }), stat: async () => ({ mode: 0o100644 }), readFile: async () => Buffer.from("<a href=\"/x\">"),
    writeFile: async (p) => { writes.push(p); }, rename: async (a) => { writes.push(a); }, unlink: async () => {}, readdir: async () => [], close: async () => {} });
  const c = { host_key_sha256: fpOf(RSA), host_key_algorithm: "rsa-sha2-512", remote_root: "/home/k/public_html" };
  assert.equal(assertHostKeyPinned(client({ sha256: fpOf(RSA), algorithm: "rsa-sha2-512" }), c), true);
  assert.throws(() => assertHostKeyPinned(client({ sha256: fpOf(ED), algorithm: "rsa-sha2-512" }), c), (e) => e.code === "HOST_KEY_CHANGED");
  assert.throws(() => assertHostKeyPinned(client({ sha256: fpOf(RSA), algorithm: "rsa-sha2-256" }), c), (e) => e.code === "HOST_KEY_CHANGED");
  assert.throws(() => assertHostKeyPinned(client(undefined), c), (e) => e.code === "HOST_KEY_UNVERIFIED");
  const a = sftpAdapter({ dir: tmp(), connect: async () => client({ sha256: fpOf(ED), algorithm: "ssh-ed25519" }), fetchFn: async (u) => ({ status: 200, url: u, text: async () => "" }) });
  const order = { order_id: "RF480-20261012-abcdef", domain: "muster.ch", website: "https://muster.ch/", customer_authorized_repair: true, authorization: { authorized_domain: "muster.ch" } };
  const loc = { family: "files", fix_type: "replace_href", attr: "href", brokenPath: "/x", replacement: "/y", files: [{ path: "index.html", before_hash: "h" }] };
  const err = await a.applyFix({ type: "broken_link" }, loc, order, c).catch((e) => e);
  assert.equal(err.code, "HOST_KEY_CHANGED");
  assert.equal((await a.rollback(order, null, c)).ok, true, "nichts angewendet → nichts zurückzurollen");
  assert.deepEqual(writes, [], "0 Write");
});

// ---------- Workflow: BLOCKED_HOST_KEY_CHANGED ----------
function orderWithAccess(store, dir, payload) {
  const T0 = new Date();
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "kunde@muster.ch", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: `Test-${o.order_id}`, now: T0 });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const token = "t".repeat(43);
  Object.assign(data.orders[o.order_id], { state: "ACCESS_REQUESTED", access_request: { token_hash: tokenHash(token), expires_at: new Date(+T0 + 72 * 3600e3).toISOString(), sent_at: T0.toISOString(), draft_id: "d1" } });
  store.write(REPAIR_ORDERS_FILE, data);
  const envelope = sealEnvelope({ access_type: "sftp", ...payload }, accessKeys(dir).publicKeyPem);
  const r = applyAccessSubmission(store, { order_id: o.order_id, token_hash: tokenHash(token), domain: "muster.ch",
    submission: { submitted_at: T0.toISOString(), access_domain: "muster.ch", consent: true, consent_text: consentText("muster.ch"), access_type: "sftp", envelope } }, { now: T0 });
  assert.ok(r.ok, r.reason);
  return o.order_id;
}
test("Workflow: Host-Key ändert sich nach PROFILE_READY → BLOCKED_HOST_KEY_CHANGED, Chris informiert, 0 Write; Dashboard nur JA/NEIN", async () => {
  const dir = tmp(), store = createStore(dir);
  const id = orderWithAccess(store, dir, { host: "sftp://files.lab.test", username: "kunde", secret: PW, remote_root: "public_html", ssh_host_key_sha256: fpOf(RSA) });
  const writes = [], logs = [];
  const fake = async ({ algorithm }) => { if (algorithm === "rsa-sha2-512" || algorithm === "rsa-sha2-256") return { algorithm, fingerprint: fpOf(RSA), key_type: "ssh-rsa" }; throw new HostKeyError("ALG_NOT_OFFERED"); };
  fake.algorithmAware = true;
  const stub = { detectCapabilities: () => ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"],
    checkAccess: async (_o, c) => { assert.equal(c.host_key_algorithm, "rsa-sha2-512"); throw new HostKeyError("HOST_KEY_CHANGED", "Host-Key oder Host-Key-Algorithmus hat sich geändert – STOP."); },
    backup: async () => { writes.push("backup"); }, locate: async () => null, applyFix: async () => { writes.push("fix"); }, validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true }), rollback: async () => { writes.push("rollback"); return { ok: true }; }, cleanup: async () => ({ ok: true }) };
  const reg = await createAdapterRegistry({ dir, store, legacy: {}, contracts: { sftp: stub }, profileDeps: { probeHostKey: fake, connect: async () => readOnlyClient(writes) } });
  const auditor = { audit: async (website) => ({ website, reachable: true, finalUrl: website, issues: [], requests: 1, pages: { home: "<html>statisch</html>" } }) };
  await createRepairEngine({ store, adapters: reg.adapters, router: reg.router, preflight: reg.preflight, auditor, log: (l, e, d) => logs.push(JSON.stringify({ l, e, d })) }).processAll();
  const o = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
  assert.equal(o.state, "BLOCKED_HOST_KEY_CHANGED", o.blocked_reason);
  assert.ok(o.state_history.some((h) => /^PROFILE_READY/.test(h.reason)));
  assert.ok(o.alerts.some((a) => a.kind === "host_key_changed"));
  assert.equal(o.access_profile.host_key_verified, false);
  assert.deepEqual(writes, [], "0 Write");
  assert.ok(BLOCKED_STATES.includes("BLOCKED_HOST_KEY_CHANGED"));
  assert.equal(repairOrdersStatus(dir).host_key_changed, 1);
  const pub = publicRepairOrders(dir);
  const po = pub.orders.find((x) => x.order_id === id);
  assert.equal(po.host_key_verified, false);
  const raw = JSON.stringify(pub) + JSON.stringify(cleanRepair(pub));
  for (const v of [fpOf(RSA), "rsa-sha2-512", "files.lab.test", "kunde\"", "/home/kunde", PW]) assert.ok(!raw.includes(v), v);
  assert.equal(cleanRepair(pub).orders[0].state, "BLOCKED_HOST_KEY_CHANGED");
  assert.equal(cleanRepair(pub).orders[0].host_key_verified, false);
  assert.ok(!logs.join("\n").includes(PW));
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.ok(html.includes('BLOCKED_HOST_KEY_CHANGED: "HOST-KEY GEÄNDERT"') && html.includes("HOST KEY VERIFIED"));
});

test("Lab + Gate: Docker-Integration getrennt (npm run test:repair-integration), Release-Gate führt sie explizit aus; Lab nie im Produktions-Image", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:repair-integration"], /test-repair-integration/);
  assert.match(pkg.scripts["test:release-044"], /npm test/);
  assert.match(pkg.scripts["test:release-044"], /test:repair-integration/);
  const docker = fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile"), "utf8");
  assert.ok(!/test\/|integration|repair-lab/.test(docker), "Produktions-Image ohne Testservices");
  const lab = fs.readFileSync(path.join(ROOT, "test", "integration", "repair-lab", "lab.mjs"), "utf8");
  assert.ok(!/\/\.secrets|jarvis-mail\/|\/opt\//.test(lab.replace(/\/\/.*$/gm, "")), "keine Production-Secrets im Lab");
  assert.ok(/--internal/.test(lab) && /127\.0\.0\.1::/.test(lab), "internes Netz, Ports nur auf localhost");
  // Keine Test-Schlüssel im Repo: Host-Keys/Client-Keys entstehen zur Laufzeit.
  for (const f of fs.readdirSync(path.join(ROOT, "test", "integration", "repair-lab"), { recursive: true }).map(String)) {
    const p = path.join(ROOT, "test", "integration", "repair-lab", f);
    if (fs.statSync(p).isFile()) assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(fs.readFileSync(p, "utf8").replace(/\/-----BEGIN \[A-Z \]\*PRIVATE KEY-----\//g, "")), f);
  }
});

test("Mehrere Befunde in DERSELBEN Datei (Lab-Fund): zweiter Fix auf eigenem Stand erlaubt, fremde Änderung → kein Write; Rollback = Original", async () => {
  const R = "/home/k/public_html";
  const ORIGINAL = '<html><body><main><a href="/team-alt.html">Team</a><img src="/assets/logo.svg" alt="L"></main></body></html>';
  const mk = () => {
    const F = new Map([[`${R}/index.html`, ORIGINAL], [`${R}/team.html`, "<html>T</html>"], [`${R}/assets/img/logo.svg`, "<svg/>"]]);
    const writes = [];
    const isDir = (p) => [...F.keys()].some((k) => k.startsWith(p + "/"));
    const st = (p) => { if (F.has(p)) return { isFile: true, isDir: false, isSymlink: false, mode: 0o100644, size: F.get(p).length }; if (isDir(p)) return { isFile: false, isDir: true, isSymlink: false }; throw new Error("ENOENT"); };
    return { F, writes, realpath: async (p) => p, lstat: async (p) => st(p), stat: async (p) => st(p),
      readFile: async (p) => { if (!F.has(p)) throw new Error("ENOENT"); return Buffer.from(F.get(p)); },
      writeFile: async (p, d) => { writes.push(p); F.set(p, Buffer.from(d).toString()); }, rename: async (a, b) => { F.set(b, F.get(a)); F.delete(a); },
      unlink: async (p) => { F.delete(p); }, chmod: async () => {}, close: async () => {},
      readdir: async (p) => [...new Set([...F.keys()].filter((k) => k.startsWith(p + "/")).map((k) => k.slice(p.length + 1).split("/")[0]))].map((n) => ({ filename: n, attrs: st(`${p}/${n}`) })) };
  };
  const run = async (foreign) => {
    const fsm = mk();
    const fetchFn = async (u) => { const p = new URL(u).pathname; const f = fsm.F.get(R + (p === "/" ? "/index.html" : p)); return { status: f ? 200 : 404, url: u, text: async () => f || "" }; };
    const a = sftpAdapter({ dir: tmp(), connect: async () => fsm, fetchFn });
    const order = { order_id: "RF480-20261012-abcdef", domain: "muster.ch", website: "https://muster.ch/", customer_authorized_repair: true, authorization: { authorized_domain: "muster.ch" } };
    const c = { remote_root: R, host_key_sha256: fpOf(RSA) };
    const link = { type: "broken_link", url: "https://muster.ch/team-alt.html", page: "https://muster.ch/" };
    const img = { type: "broken_image", url: "https://muster.ch/assets/logo.svg", page: "https://muster.ch/" };
    const l1 = await a.locate(link, order, c), l2 = await a.locate(img, order, c);
    assert.equal(l1.files[0].before_hash, l2.files[0].before_hash, "beide im Plan gegen denselben Ausgangsstand");
    assert.equal((await a.applyFix(link, l1, order, c)).ok, true);
    if (foreign) fsm.F.set(`${R}/index.html`, fsm.F.get(`${R}/index.html`) + "<!-- fremd -->");
    const r2 = await a.applyFix(img, l2, order, c).catch((e) => e);
    return { fsm, a, order, c, link, img, l1, l2, r2 };
  };
  const ok = await run(false);
  assert.equal(ok.r2.ok, true, String(ok.r2?.message));
  assert.equal(ok.fsm.F.get(`${R}/index.html`), ORIGINAL.replace("/team-alt.html", "/team.html").replace("/assets/logo.svg", "/assets/img/logo.svg"));
  assert.equal((await ok.a.validate({ ...ok.link, location: ok.l1 }, ok.order, ok.c)).build_ok, true);
  assert.equal((await ok.a.validate({ ...ok.img, location: ok.l2 }, ok.order, ok.c)).build_ok, true);
  assert.equal((await ok.a.rollback(ok.order, null, ok.c)).ok, true);
  assert.equal(ok.fsm.F.get(`${R}/index.html`), ORIGINAL, "Rollback rückwärts bis zum Original");
  const bad = await run(true);
  assert.match(String(bad.r2?.message), /seit dem Plan verändert/, "fremde Änderung → kein Write");
  assert.equal(bad.fsm.writes.filter((p) => p.includes("index.html")).length, 1, "nur der erste Fix wurde geschrieben");
});
