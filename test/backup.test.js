// Disaster Recovery: verschlüsselte State-Backups (lokal + offsite), Restore ohne Überschreiben, neuer PC überschreibt keinen Cloud-State.
// Keine echten Mails, kein Netzwerk, Wegwerf-Schlüssel.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBackup, verifyBackup, decryptBackup, restoreTo, storeLocal, dailyBackup, backupInfo, stateFiles, BACKUP_STATUS_FILE } from "../backup.js";
import { createBackupHandler, backupUploader, OFFSITE_KEEP } from "../backup-api.js";
import { createStateHandler, memoryStore } from "../shared-state.js";
import { zurichDay } from "../mail-worker.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-test-token", JARVIS_MAIL_WORKER_TOKEN: "worker-test-token" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-bak-"));
function secretsDir() {
  const d = tmp();
  fs.mkdirSync(path.join(d, "mail_worker"));
  const w = (f, v) => fs.writeFileSync(path.join(d, f), typeof v === "string" ? v : JSON.stringify(v));
  w("mail_worker/suppression.json", { "optout@kunde.ch": { reason: "opt_out" } });
  w("mail_worker/discovered.json", { leads: { "laden.ch": { status: "audited" } } });
  w("mail_worker/worker.log", "log");
  w("mail_worker/worker.lock", "{}");
  w("gmail_jarvis.json", { drafts: {}, sent: { s1: { to: "a@b.ch" } } });
  w("gmail_token.json", { refresh_token: "GEHEIM-REFRESH-TOKEN-123456" });
  w("gmail_credentials.json", { installed: { client_secret: "GEHEIM-CLIENT-SECRET-123456" } });
  w("vps_worker.env", "JARVIS_MAIL_WORKER_TOKEN=GEHEIM-WORKER-TOKEN-123456");
  w("backup_private.pem", privateKey);
  return d;
}

test("Backup enthält nur Operational State – nie Gmail-Token/Credentials, Worker-Token, Private Key, Logs", () => {
  const d = secretsDir();
  assert.deepEqual(stateFiles(d), ["gmail_jarvis.json", "mail_worker/discovered.json", "mail_worker/suppression.json"]);
  const env = createBackup({ secretsDir: d, publicKeyPem: publicKey });
  const raw = JSON.stringify(env);
  assert.doesNotMatch(raw, /GEHEIM|optout@kunde|laden\.ch|PRIVATE KEY/, "Chiffrat und Metadaten ohne Klartext/Secrets");
  const p = decryptBackup(env, privateKey);
  assert.deepEqual(Object.keys(p.files).sort(), ["gmail_jarvis.json", "mail_worker/discovered.json", "mail_worker/suppression.json"]);
  assert.match(p.files["mail_worker/suppression.json"], /optout@kunde\.ch/, "Opt-outs sind gesichert");
  assert.doesNotMatch(JSON.stringify(p), /GEHEIM/);
});

test("Integrität: ohne Schlüssel prüfbar; manipuliertes Chiffrat/Tag oder falscher Schlüssel → fail closed", () => {
  const env = createBackup({ secretsDir: secretsDir(), publicKeyPem: publicKey });
  assert.deepEqual(verifyBackup(env), { ok: true });
  const bad = { ...env, ciphertext: Buffer.from("x" + env.ciphertext).toString("base64") };
  assert.equal(verifyBackup(bad).ok, false);
  assert.throws(() => decryptBackup(bad, privateKey));
  const t = Buffer.from(env.tag, "base64"); t[0] ^= 1;
  assert.throws(() => decryptBackup({ ...env, tag: t.toString("base64") }, privateKey), "GCM-Tag");
  const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  assert.throws(() => decryptBackup(env, other), "falscher Private Key");
});

test("Restore schreibt nur in ein leeres Verzeichnis, nie über bestehenden Zustand; Pfade aus dem Backup werden geprüft", () => {
  const p = decryptBackup(createBackup({ secretsDir: secretsDir(), publicKeyPem: publicKey }), privateKey);
  const out = path.join(tmp(), "restore");
  assert.equal(restoreTo(p, out).length, 3);
  assert.match(fs.readFileSync(path.join(out, "mail_worker", "suppression.json"), "utf8"), /optout@kunde/);
  assert.throws(() => restoreTo(p, out), /nicht leer/);
  assert.throws(() => restoreTo({ files: { "../evil.json": "{}" } }, path.join(tmp(), "x")), /Unzulässiger Pfad/);
  assert.throws(() => restoreTo({ files: { "gmail_token.json": "{}" } }, path.join(tmp(), "y")), /Unzulässiger Pfad/);
});

test("Lokale Rotation: höchstens 14 Generationen, neueste bleiben", () => {
  const d = secretsDir(), dir = path.join(tmp(), "backups");
  let last;
  for (let i = 0; i < 16; i++) last = storeLocal(createBackup({ secretsDir: d, publicKeyPem: publicKey, now: new Date(Date.UTC(2026, 9, 1 + i, 4)) }), dir);
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 14);
  assert.equal(last.generations, 14);
  assert.match(files[0], /^state-20261003/, "zwei älteste entfernt");
});

test("Tägliches Backup: einmal je Zürcher Tag ab 03:00; Offsite-Fehler → Status ok=false, lokales Backup bleibt", async () => {
  const d = secretsDir(), wd = path.join(d, "mail_worker");
  const night = new Date("2026-10-07T00:30:00Z"); // 02:30 Zürich
  assert.equal((await dailyBackup({ secretsDir: d, workerDir: wd, publicKeyPem: publicKey, now: night, zurichDay })).skipped, true);
  const morning = new Date("2026-10-07T02:10:00Z"); // 04:10 Zürich
  let uploads = 0;
  const r1 = await dailyBackup({ secretsDir: d, workerDir: wd, publicKeyPem: publicKey, now: morning, zurichDay, upload: async () => { uploads++; return { ok: false, error: "HTTP 500" }; } });
  assert.equal(r1.skipped, false);
  assert.deepEqual([r1.status.ok, r1.status.generations], [false, 1]);
  assert.equal((await dailyBackup({ secretsDir: d, workerDir: wd, publicKeyPem: publicKey, now: new Date("2026-10-07T02:40:00Z"), zurichDay, upload: async () => { uploads++; return { ok: true }; } })).skipped, true, "nur einmal pro Tag, Nachversuch erst nach 1 h");
  assert.equal(uploads, 1);
  // Nachversuch: frühestens nach einer Stunde, mit demselben lokalen Backup.
  const later = new Date("2026-10-07T03:20:00Z");
  const r2 = await dailyBackup({ secretsDir: d, workerDir: wd, publicKeyPem: publicKey, now: later, zurichDay, upload: async (e) => { uploads++; assert.equal(e.created_at, r1.status.last_at); return { ok: true }; } });
  assert.deepEqual([r2.retried, r2.status.ok, r2.status.generations], [true, true, 1]);
  assert.equal((await dailyBackup({ secretsDir: d, workerDir: wd, publicKeyPem: publicKey, now: new Date("2026-10-07T05:00:00Z"), zurichDay, upload: async () => { uploads++; return { ok: true }; } })).skipped, true);
  assert.equal(uploads, 2);
  assert.deepEqual(Object.keys(backupInfo(wd)).sort(), ["generations", "last_at", "ok"]);
  assert.equal(fs.statSync(path.join(wd, BACKUP_STATUS_FILE)).isFile(), true);
});

test("Offsite /api/backup: nur Cloud Core lädt hoch, nur Chiffrat wird angenommen, 30 Generationen, Chris kann auflisten/laden", async () => {
  const blobs = new Map();
  const store = { async get(k) { return blobs.has(k) ? JSON.parse(blobs.get(k)) : null; }, async set(k, v) { blobs.set(k, v); }, async list({ prefix }) { return { blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; }, async delete(k) { blobs.delete(k); } };
  const h = createBackupHandler({ getStore: async () => store, env: (k) => ENV[k] });
  const call = (method, body, headers, q = "") => h(new Request(`https://jarvis.test/api/backup${q}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const env = createBackup({ secretsDir: secretsDir(), publicKeyPem: publicKey, now: new Date("2026-10-07T02:00:00Z") });
  assert.equal((await call("POST", env, { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN })).status, 401, "Windows-Client: kein Zugriff");
  assert.equal((await call("POST", env, { "x-jarvis-key": ENV.JARVIS_PASSWORD })).status, 403, "Browser lädt nicht hoch");
  assert.equal((await call("POST", { format: "jarvis-state-backup", v: 1, files: { a: "klartext" } }, { "x-jarvis-worker": ENV.JARVIS_MAIL_WORKER_TOKEN })).status, 400, "Klartext abgelehnt");
  assert.equal((await call("POST", { ...env, ciphertext_sha256: "0" }, { "x-jarvis-worker": ENV.JARVIS_MAIL_WORKER_TOKEN })).status, 400, "manipuliert abgelehnt");
  const up = backupUploader({ config: { workerToken: ENV.JARVIS_MAIL_WORKER_TOKEN, url: "https://jarvis.test/api/state" }, fetchFn: async (u, o) => h(new Request(u, o)) });
  assert.deepEqual(await up(env), { ok: true, key: "daily/2026-10-07" });
  for (let i = 1; i <= OFFSITE_KEEP + 2; i++) await up({ ...env, created_at: new Date(Date.UTC(2026, 10, i)).toISOString() });
  const list = (await (await call("GET", null, { "x-jarvis-key": ENV.JARVIS_PASSWORD })).json()).backups;
  assert.equal(list.length, OFFSITE_KEEP);
  assert.equal(list.includes("daily/2026-10-07"), false, "älteste rotiert");
  const got = await (await call("GET", null, { "x-jarvis-key": ENV.JARVIS_PASSWORD }, `?key=${list.at(-1)}`)).json();
  assert.equal(decryptBackup(got, privateKey).format, "jarvis-state-backup");
  assert.equal((await call("GET", null, { "x-jarvis-key": ENV.JARVIS_PASSWORD }, "?key=../x")).status, 400);
  assert.equal(backupUploader({ config: { token: "sync", url: "x" } }), null, "ohne Worker-Token kein Upload");
});

test("Szenario C: neuer PC (leerer lokaler Stand) verbindet sich – Cloud-State wird nicht überschrieben", async () => {
  const blob = memoryStore();
  let now = new Date("2026-10-07T18:00:00Z");
  const h = createStateHandler({ getStore: async () => blob, env: (k) => ENV[k], now: () => now });
  const sreq = (body, token) => new Request("https://jarvis.test/api/state", { method: "POST", headers: { "content-type": "application/json", "x-jarvis-sync": token }, body: JSON.stringify(body) });
  // Bestehender Cloud-Jarvis: Core hat Sales/Business, es gibt eine Meldung und Gesprächsverlauf.
  await h(sreq({ op: "sync", state: { sales: { updatedAt: now.toISOString(), contacted: 5 }, business: { updatedAt: now.toISOString() },
    notifications: [{ id: "n1", type: "mail_escalation", summary: "Antwort prüfen", status: "unread", priority: "high", createdAt: now.toISOString() }],
    conversation: { turns: [{ role: "user", content: "Hallo", at: now.toISOString(), source: "cloud" }], updatedAt: now.toISOString() } } }, ENV.JARVIS_MAIL_WORKER_TOKEN));
  const before = blob.peek();
  // Neuer PC: leerer Zustand, später Zeitstempel.
  now = new Date("2026-10-08T09:00:00Z");
  assert.equal((await h(sreq({ op: "sync", state: { sales: { updatedAt: now.toISOString(), contacted: 0 }, notifications: [], conversation: { turns: [] } } }, ENV.JARVIS_SYNC_TOKEN))).status, 200);
  const after = blob.peek();
  assert.equal(after.sales.contacted, 5);
  assert.deepEqual(after.notifications.map((n) => n.id), before.notifications.map((n) => n.id));
  assert.equal(after.conversation.turns.length, before.conversation.turns.length);
  assert.equal(after.sync.lastClientPushAt, now.toISOString(), "Client ist wieder verbunden");
});

test("Bootstrap/DR-Artefakte: keine Secrets, keine Token-Erzeugung, kein Überschreiben", () => {
  const ps = fs.readFileSync(path.join(ROOT, "scripts", "bootstrap-windows.ps1"), "utf8");
  assert.doesNotMatch(ps, /setup-sync|merge-state|deploy\.sh|--with-secrets|Get-Content[^\n]*\.secrets/, "erzeugt keine Tokens, migriert/deployt nichts, liest keine Secrets");
  assert.match(ps, /git check-ignore -q \.secrets/);
  const pub = fs.readFileSync(path.join(ROOT, "deploy", "vps", "backup-public.pem"), "utf8");
  assert.match(pub, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(pub, /PRIVATE/);
  const docker = fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile"), "utf8");
  assert.match(docker, /COPY deploy\/vps\/backup-public\.pem \.\/backup-public\.pem/);
  assert.match(fs.readFileSync(path.join(ROOT, "docs", "DISASTER_RECOVERY.md"), "utf8"), /Secret-Recovery/);
});

test("DR-Probe ist nur lesend und nutzt keine PC-Credential (Windows darf aus sein)", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "dr-probe.mjs"), "utf8");
  assert.doesNotMatch(src, /method:\s*"POST"|jarvis_sync\.json|127\.0\.0\.1|localhost/);
  assert.match(src, /x-jarvis-worker/);
  assert.doesNotMatch(src, /console\.log\([^)]*token\b/);
});
