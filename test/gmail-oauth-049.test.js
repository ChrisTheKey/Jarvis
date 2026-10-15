// GMAIL OAUTH RECOVERY + MAIL READINESS HARDENING (TF-049) – hermetisch, nur Fake-Gmail (kein Netz, keine echte Gmail-Aktion):
// read-only Auth-Check gmail.checkAuth (Token-Refresh im Speicher + users.getProfile, sichere Fehlerkategorien), Readiness im
// Mail-Worker (READY nur mit funktionierendem Gmail OAuth + aktivem Outbox-Consumer) und im Repair-Service (Gmail-Status aus dem
// Outbox-Herzschlag – ein registrierter Consumer allein reicht nie), Outbox bei kaputtem OAuth: Aufträge bleiben offen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAuth, AUTH_FAIL_CATEGORIES } from "../gmail.js";
import { readinessReport, formatReport, RELEASE_GATE, RELEASE_GATE_SCRIPT } from "../production-readiness.js";
import { createOutboxMailer, processRepairOutbox, outboxStatus, CONSUMER_FILE } from "../repair-outbox.js";
import { SERVICE_LOCK } from "../repair-service.js";

const made = [];
const tmp = (p = "jarvis-oauth49-") => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const SCOPE = "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.labels";
const REFRESH = "rt-oauth49-test-refresh-value", ACCESS = "at-oauth49-test-access-value", CLIENT_SECRET = "cs-oauth49-test-client-secret";
const disk = () => ({ bavail: 60 * 1024 ** 3 / 4096, bsize: 4096 });
const snapshotDir = (d) => fs.readdirSync(d, { recursive: true }).map(String).sort().map((f) => { const p = path.join(d, f); return fs.statSync(p).isFile() ? `${f}:${fs.readFileSync(p, "utf8")}` : f; }).join("\n");

function secrets({ creds = true, token = true, scope = SCOPE } = {}) {
  const dir = tmp();
  if (creds) fs.writeFileSync(path.join(dir, "gmail_credentials.json"), JSON.stringify({ installed: { client_id: "cid.apps.test", client_secret: CLIENT_SECRET } }));
  if (token) fs.writeFileSync(path.join(dir, "gmail_token.json"), JSON.stringify({ access_token: "old", refresh_token: REFRESH, scope, expiry: Date.now() - 1000 }));
  return dir;
}
// Fake-Gmail: Token-Endpunkt + users.getProfile; jeder Aufruf wird protokolliert (Methode + Pfad).
function fakeGoogle({ token = { status: 200, body: { access_token: ACCESS, scope: SCOPE, expires_in: 3599 } }, profile = { status: 200, body: { emailAddress: "chris@example.test", historyId: "123" } }, throwOn = null } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const u = new URL(url), method = opts.method || "GET";
    calls.push(`${method} ${u.host}${u.pathname}`);
    if (throwOn && u.pathname.includes(throwOn)) throw new TypeError("fetch failed");
    const r = u.host === "oauth2.googleapis.com" ? token : u.pathname.endsWith("/users/me/profile") ? profile : { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { calls, fetchFn };
}
const READ_ONLY_CALLS = new Set(["POST oauth2.googleapis.com/token", "GET gmail.googleapis.com/gmail/v1/users/me/profile"]);

// ---------------------------------------------------------------------------------------------------------------------
// gmail.checkAuth
// ---------------------------------------------------------------------------------------------------------------------
test("A: gültiges OAuth → { ok: true }; genau Refresh + users.getProfile; Token-Datei unverändert; Ergebnis ohne Token/Mailadresse", async () => {
  const dir = secrets(), g = fakeGoogle(), before = snapshotDir(dir);
  const r = await checkAuth({ secretsDir: dir, fetchFn: g.fetchFn });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(g.calls, [...READ_ONLY_CALLS]);
  assert.equal(snapshotDir(dir), before, "Refresh nur im Speicher");
});

test("B–E: Fehler → nur sichere Kategorie (expired_or_revoked, missing_token, missing_credentials, scope_error, network_error, unknown_auth_error)", async () => {
  const cases = [
    ["invalid_grant", secrets(), fakeGoogle({ token: { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } }), "expired_or_revoked"],
    ["kein Token", secrets({ token: false }), fakeGoogle(), "missing_token"],
    ["keine Credentials", secrets({ creds: false }), fakeGoogle(), "missing_credentials"],
    ["invalid_client", secrets(), fakeGoogle({ token: { status: 401, body: { error: "invalid_client" } } }), "missing_credentials"],
    ["Scope fehlt (Datei)", secrets({ scope: "https://www.googleapis.com/auth/gmail.readonly" }), fakeGoogle(), "scope_error"],
    ["getProfile 403 Scope", secrets(), fakeGoogle({ profile: { status: 403, body: { error: { message: "Request had insufficient authentication scopes." } } } }), "scope_error"],
    ["getProfile 401", secrets(), fakeGoogle({ profile: { status: 401, body: { error: { message: "Invalid Credentials" } } } }), "expired_or_revoked"],
    ["getProfile 500", secrets(), fakeGoogle({ profile: { status: 500, body: {} } }), "network_error"],
    ["Netz weg (Token)", secrets(), fakeGoogle({ throwOn: "/token" }), "network_error"],
    ["Netz weg (Profil)", secrets(), fakeGoogle({ throwOn: "/profile" }), "network_error"],
    ["getProfile 400", secrets(), fakeGoogle({ profile: { status: 400, body: {} } }), "unknown_auth_error"],
  ];
  for (const [name, dir, g, cat] of cases) {
    const r = await checkAuth({ secretsDir: dir, fetchFn: g.fetchFn });
    assert.deepEqual(r, { ok: false, category: cat }, name);
    assert.ok(AUTH_FAIL_CATEGORIES.includes(r.category), name);
    assert.ok(g.calls.every((c) => READ_ONLY_CALLS.has(c)), `${name}: nur read-only Aufrufe`);
    assert.ok(!JSON.stringify(r).match(/oauth49-test|chris@/), `${name}: keine Secrets/Adresse`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Readiness: Mail-Worker
// ---------------------------------------------------------------------------------------------------------------------
function mailEnv({ consumer = true } = {}) {
  const secretsDir = secrets(), workerDir = path.join(secretsDir, "mail_worker"), outboxDir = path.join(secretsDir, "repair_outbox");
  fs.mkdirSync(workerDir, { recursive: true }); fs.mkdirSync(outboxDir);
  fs.writeFileSync(path.join(workerDir, "worker.lock"), JSON.stringify({ pid: 1, beat: Date.now() }));
  fs.writeFileSync(path.join(workerDir, "authority.json"), JSON.stringify({ holder: "vps", self: true }));
  fs.writeFileSync(path.join(workerDir, "backup_status.json"), JSON.stringify({ last_at: new Date(Date.now() - 3600e3).toISOString(), ok: true, generations: 3 }));
  if (consumer) fs.writeFileSync(path.join(outboxDir, CONSUMER_FILE), JSON.stringify({ beat: Date.now(), role: "mail-worker" }));
  const env = { JARVIS_WORKER_ROLE: "vps", JARVIS_MAIL_WORKER_TOKEN: "rdy-worker-token-oauth49-0123456789", ANTHROPIC_API_KEY: "sk-ant-oauth49-test" };
  return { env, secretsDir, workerDir, outboxDir, statfs: disk, launchChromium: false };
}
const status = (r) => Object.fromEntries(r.checks.filter((c) => ["Core", "Authority", "Mail", "Delivery"].includes(c.name)).map((c) => [c.name, c.status]));

test("A (Readiness): Mail-Worker gesund + Authority VPS + Outbox-Consumer + Gmail OAuth OK → Mail OK, READY; nur read-only Gmail-Aufrufe, Zustand unverändert", async () => {
  const e = mailEnv(), g = fakeGoogle(), before = snapshotDir(e.secretsDir);
  const r = await readinessReport({ ...e, gmailCheck: (o) => checkAuth({ ...o, fetchFn: g.fetchFn }) });
  assert.deepEqual(status(r), { Core: "OK", Authority: "OK", Mail: "OK", Delivery: "OK" });
  assert.equal(r.ready, true, r.reasons.join(" | "));
  assert.match(formatReport(r), /READY FOR FIRST CUSTOMER/);
  assert.deepEqual(g.calls, [...READ_ONLY_CALLS]);
  assert.equal(snapshotDir(e.secretsDir), before);
  assert.ok(!JSON.stringify(r).match(/oauth49-test|chris@/));
});

test("B–E (Readiness): expired_or_revoked / missing_token / missing_credentials / getProfile-Fehler → Mail FAIL, Delivery FAIL, NOT READY", async () => {
  for (const [name, prep, g, cat] of [
    ["expired", () => {}, fakeGoogle({ token: { status: 400, body: { error: "invalid_grant" } } }), "expired_or_revoked"],
    ["missing token", (e) => fs.rmSync(path.join(e.secretsDir, "gmail_token.json")), fakeGoogle(), null],
    ["missing credentials", (e) => fs.rmSync(path.join(e.secretsDir, "gmail_credentials.json")), fakeGoogle(), null],
    ["getProfile error", () => {}, fakeGoogle({ profile: { status: 500, body: {} } }), "network_error"],
  ]) {
    const e = mailEnv(); prep(e);
    const r = await readinessReport({ ...e, gmailCheck: (o) => checkAuth({ ...o, fetchFn: g.fetchFn }) });
    const out = formatReport(r);
    assert.equal(r.ready, false, name);
    assert.match(out, /NOT READY/);
    assert.equal(status(r).Mail, "FAIL", name);
    assert.equal(status(r).Delivery, "FAIL", name);
    if (cat) assert.ok(r.reasons.includes(`Mail: Gmail OAuth FAIL (${cat})`), `${name}: ${r.reasons.join(" | ")}`);
    else assert.ok(r.reasons.some((x) => /^Mail: Gmail-Zugang fehlt/.test(x)) && g.calls.length === 0, name);
  }
  // Wirft der Check selbst, gilt das als FAIL – nie als OK.
  const r = await readinessReport({ ...mailEnv(), gmailCheck: async () => { throw new Error("boom"); } });
  assert.ok(r.reasons.includes("Mail: Gmail OAuth FAIL (unknown_auth_error)"));
  // Unbekannte Kategorie aus dem Check wird nie ungefiltert ausgegeben.
  const r2 = await readinessReport({ ...mailEnv(), gmailCheck: async () => ({ ok: false, category: "token=geheim" }) });
  assert.ok(r2.reasons.includes("Mail: Gmail OAuth FAIL (unknown_auth_error)") && !JSON.stringify(r2).includes("geheim"));
});

test("F (Mail-Worker): Gmail OK, aber Outbox-Consumer nicht aktiv → Delivery FAIL, NOT READY", async () => {
  const r = await readinessReport({ ...mailEnv({ consumer: false }), gmailCheck: async () => ({ ok: true }) });
  assert.equal(status(r).Mail, "OK");
  assert.equal(status(r).Delivery, "FAIL");
  assert.equal(r.ready, false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Readiness: Repair-Service (Gmail-Status nur aus dem Outbox-Herzschlag)
// ---------------------------------------------------------------------------------------------------------------------
function repairEnv(consumer) {
  const secretsDir = tmp(), workerDir = path.join(secretsDir, "mail_worker"), outboxDir = path.join(secretsDir, "repair_outbox");
  fs.mkdirSync(workerDir, { recursive: true }); fs.mkdirSync(outboxDir);
  fs.writeFileSync(path.join(workerDir, SERVICE_LOCK), JSON.stringify({ pid: 1, beat: Date.now() }));
  fs.writeFileSync(path.join(workerDir, "backup_status.json"), JSON.stringify({ last_at: new Date().toISOString(), ok: true, generations: 1 }));
  if (consumer) fs.writeFileSync(path.join(outboxDir, CONSUMER_FILE), JSON.stringify(consumer));
  const env = { JARVIS_WORKER_ROLE: "repair", JARVIS_MAIL_WORKER_TOKEN: "t".repeat(43), JARVIS_SYNC_URL: "https://jarvis.test" };
  return { env, secretsDir, workerDir, outboxDir, statfs: disk, launchChromium: false };
}

test("F (Repair-Service): Repair Outbox healthy + Gmail dead → Mail FAIL, Delivery FAIL, NOT READY; alter Herzschlag ohne Gmail-Status → FAIL; nur mit Gmail OK → READY", async () => {
  const now = Date.now();
  const dead = await readinessReport(repairEnv({ beat: now, role: "mail-worker", gmail_auth: { ok: false, category: "expired_or_revoked", at: now } }));
  assert.deepEqual([status(dead).Mail, status(dead).Delivery, dead.ready], ["FAIL", "FAIL", false]);
  assert.ok(dead.reasons.includes("Mail: Gmail OAuth FAIL (expired_or_revoked)"), dead.reasons.join(" | "));
  const legacy = await readinessReport(repairEnv({ beat: now, role: "mail-worker" }));
  assert.deepEqual([status(legacy).Mail, status(legacy).Delivery, legacy.ready], ["FAIL", "FAIL", false], "registrierter Consumer allein reicht nie");
  const stale = await readinessReport(repairEnv({ beat: now, role: "mail-worker", gmail_auth: { ok: true, at: now - 11 * 60_000 } }));
  assert.deepEqual([status(stale).Mail, stale.ready], ["FAIL", false]);
  const good = await readinessReport(repairEnv({ beat: now, role: "mail-worker", gmail_auth: { ok: true, at: now } }));
  assert.deepEqual([status(good).Mail, status(good).Delivery], ["OK", "OK"]);
  assert.equal(good.ready, true, good.reasons.join(" | "));
  assert.ok(!good.checks.some((c) => c.name === "Authority"), "Repair-Service ist nie Sender Authority");
});

// ---------------------------------------------------------------------------------------------------------------------
// G: keine Gmail-Write-Operation – weder in der Readiness noch in der Outbox bei kaputtem OAuth
// ---------------------------------------------------------------------------------------------------------------------
test("G: Outbox bei Gmail OAuth FAIL → Herzschlag mit Kategorie, KEIN createDraft/sendDraft, kein Claim/Ergebnis, Auftrag bleibt offen; danach OK → genau 1 Versand", async () => {
  const ob = tmp(), m = createOutboxMailer({ dir: ob });
  const d = await m.createDraft({ to: "kunde@oauth49.test", subject: "Zugang", body: "Link", messageClass: "CUSTOMER_ACCESS_REQUEST" });
  await assert.rejects(m.sendDraft(d.draftId), /OUTBOX_PENDING/);
  const calls = [];
  const gmail = { listOwned: () => ({ sent: {} }), createDraft: async (x) => { calls.push("create"); return { draftId: "dr1" }; }, sendDraft: async () => { calls.push("SEND"); return {}; } };
  const r = await processRepairOutbox({ dir: ob, gmail, gmailAuth: { ok: false, category: "expired_or_revoked", at: Date.now() } });
  assert.equal(r.gmail_auth_failed, true);
  assert.equal(r.deferred, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(ob).filter((f) => !f.startsWith(CONSUMER_FILE)).sort(), [`${d.draftId}.request.json`]);
  const st = outboxStatus(ob);
  assert.deepEqual([st.consumer_online, st.gmail_auth.ok, st.gmail_auth.category, st.gmail_auth.fresh, st.pending], [true, false, "expired_or_revoked", true, 1]);
  const ok = await processRepairOutbox({ dir: ob, gmail, gmailAuth: { ok: true, at: Date.now() } });
  assert.deepEqual([ok.sent, calls], [1, ["create", "SEND"]]);
  assert.equal(outboxStatus(ob).gmail_auth.ok, true);
});

test("G: Readiness-Quelltext enthält keine Gmail-Write-Operation; checkAuth ruft nur Token-Endpunkt + users.getProfile; Release-Gate 049", async () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const src = read("production-readiness.js");
  assert.ok(!/sendDraft|createDraft|updateDraft|deleteDraft|markDraftForReview|\/modify|\/labels|globalThis\.fetch\(/.test(src));
  const gm = read("gmail.js");
  const body = gm.slice(gm.indexOf("export async function checkAuth"), gm.indexOf("// Quota-Schutz (TF-037)"));
  assert.ok(!/gmail\(|saveToken|writeSecret|\/drafts|\/messages|\/labels|\/threads|\/send/.test(body), "checkAuth: keine Schreib-/Inhaltsaufrufe, kein Token schreiben");
  assert.equal(RELEASE_GATE, "TF-049");
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts[RELEASE_GATE_SCRIPT], "npm test && npm run test:repair-integration && npm run test:browser-integration && npm run test:full-order-integration && npm run test:separation-integration && node scripts/secret-scan.mjs && node scripts/lab-cleanup.mjs");
  const mw = read("mail-worker.js");
  // TF-066: zusätzlich der Onboarding-Hook (Thread-Bindung) – Gmail-Auth-Weitergabe unverändert.
  assert.match(mw, /processRepairOutbox\(\{ dir: outboxDir, gmail, gmailAuth, log(, onboarding)? \}\)/);
  assert.match(mw, /gmail\.checkAuth\(\)/);
});
