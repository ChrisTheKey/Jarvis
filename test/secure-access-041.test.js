// SECURE CUSTOMER ACCESS (TF-041): CHF-480-Gate + genau EINE CUSTOMER_ACCESS_REQUEST-Mail + auftragsgebundener One-Time-Link.
// Ende-zu-Ende ohne Netz: echter Netlify-Handler (access-intake-api.js, In-Memory-Blobs) ↔ echter VPS-Client (access-intake.js),
// Kundenseite verschlüsselt mit dem echten Browser-Modul (public/access-crypto.js, WebCrypto). Gmail/Auditor/Adapter sind Attrappen.
// Beweist: vor CHF 240 nichts; Zahlung ≠ Freigabe; Zugang nur verschlüsselt; Token nur gehasht; Link einmalig/ablaufend/gebunden;
// Domain-Bindung; Zugangsdaten nie in Logs/JSON/Dashboard/Snapshot/Bericht; Zerstörung nach Abschluss/Storno.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment, voidPayment, refundPayment } from "../payments.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, authorizeRepair, createRepairEngine, completeOrder, cancelRepairOrder,
  publicRepairOrders, runRepairOrders, buildCustomerReport } from "../repair-workflow.js";
import { createAccessIntakeHandler, memoryIntakeStore, consentText, tokenHash, validEnvelope } from "../access-intake-api.js";
import { intakeClient, syncAccessIntake, applyAccessSubmission, accessKeys, sealEnvelope, openAccessCredential, hasAccessSecret,
  ACCESS_VAULT_DIR, ACCESS_KEY_FILE } from "../access-intake.js";
import { sealForVps } from "../public/access-crypto.js";
import { cleanRepair, cleanSnapshot } from "../server-control.js";
import { stateFiles } from "../backup.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T12:00:00Z");
const HOME = "https://muster.ch/";
const WT = "w".repeat(43);
const SECRET = "Temp-Passw0rt-XYZ-9f3c71"; // Attrappe – darf nirgends ausser im Tresor-Chiffrat auftauchen
let dir, store, clock;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-acc-")); store = createStore(dir); clock = T0; });

function cloud() {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined), now: () => clock });
  const client = intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn: async (url, init) => handler(new Request(url, init)) });
  const customer = async (body, headers = {}) => {
    const r = await handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  return { blobs, handler, client, customer };
}
function fakeGmail() {
  const calls = [];
  return { calls,
    createDraft: async (x) => { calls.push({ op: "create", ...x }); return { draftId: "dr" + calls.length, threadId: "t1", messageId: "m1" }; },
    sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "sent-" + id }; } };
}
function fakeAdapter({ ok = true } = {}) {
  const calls = { checkAccess: 0, backup: 0, applyFix: 0, seen: [] };
  return { calls,
    checkAccess: async (order, ctx = {}) => { calls.checkAccess++; if (typeof ctx.credential === "function") calls.seen.push(ctx.credential()); return { ok, connector: "test-connector" }; },
    backup: async (o, { branch }) => { calls.backup++; return { production_ref: "deploy-42", backup_ref: "backup-1", rollback_point: "deploy-42", branch }; },
    locate: async (issue) => ({ target: "index.html", cause: `Verweis auf ${issue.url} zeigt ins Leere`, planned_change: "Linkziel korrigieren" }),
    applyFix: async () => { calls.applyFix++; return { ok: true, change_ref: "commit-abc" }; },
    rollback: async () => ({ ok: true }) };
}
const rawIssue = { type: "broken_link", url: "https://muster.ch/team-alt", page: HOME, label: "Unser Team", evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity: "medium", detectedAt: T0.toISOString() };
const fakeAuditor = (issues = [rawIssue]) => ({ audit: async (website) => ({ website, reachable: true, finalUrl: website, title: "Muster AG", issues,
  pages: { home: "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" }, requests: 1 }) });
const newOrder = (over = {}) => createRepairOrder(store, { domain: "muster.ch", website: HOME, company: "Muster AG", delivery_email: "kunde@muster.ch", contact_name: "Frau Muster", now: T0, ...over });
const pay = (id, chf, ref = null) => recordPayment(store, { order_id: id, amount_chf: chf, reference: ref, now: T0 });
const readRF = (id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
const tokenFrom = (gmail) => gmail.calls.find((c) => c.op === "create")?.body.match(/access\.html#t=([A-Za-z0-9_-]{43})/)?.[1];
const engine = (c, gmail, adapters = {}, logs = [], auditor = fakeAuditor()) => createRepairEngine({ store, adapters, auditor, gmail, intake: c.client, now: () => clock,
  log: (level, event, data) => logs.push(JSON.stringify({ level, event, data })) });
// Alle Dateien im Worker-Verzeichnis ausser Tresor + Private Key (die dürfen Chiffrat bzw. Schlüssel enthalten).
const plainFiles = () => fs.readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => !f.startsWith(ACCESS_VAULT_DIR) && f !== ACCESS_KEY_FILE && fs.statSync(path.join(dir, f)).isFile())
  .map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);

test("CHF-480 E2E: 239 → nichts; 240 → genau EINE CUSTOMER_ACCESS_REQUEST; Zugang+Freigabe über den Link → bestehender Repair-Workflow startet", async () => {
  const c = cloud(), gmail = fakeGmail(), adapter = fakeAdapter(), logs = [];
  const o = newOrder();
  pay(o.order_id, 239, "Bank 1");
  const eng = engine(c, gmail, { static: adapter }, logs);
  await eng.processAll(); await eng.processAll();
  assert.equal(readRF(o.order_id).state, "AUTHORIZATION_REQUIRED");
  assert.deepEqual([gmail.calls.length, adapter.calls.checkAccess, adapter.calls.backup, adapter.calls.applyFix, (await c.blobs.list("t/")).length], [0, 0, 0, 0, 0],
    "vor CHF 240: keine Anfrage, kein Login, kein Intake, keine Reparatur");
  pay(o.order_id, 1, "Bank 2"); // kumulativ 240
  await eng.processAll();
  let saved = readRF(o.order_id);
  assert.equal(saved.state, "ACCESS_REQUESTED");
  assert.deepEqual(gmail.calls.map((x) => x.op), ["create", "SEND"]);
  const mail = gmail.calls[0];
  assert.deepEqual([mail.to, mail.messageClass, saved.access_request.message_class], ["kunde@muster.ch", "CUSTOMER_ACCESS_REQUEST", "CUSTOMER_ACCESS_REQUEST"]);
  const token = tokenFrom(gmail);
  assert.ok(token && mail.body.includes("https://jarvis.test/access.html#t="), "orderspezifischer HTTPS-Link im Fragment");
  assert.ok(!mail.body.includes(o.order_id), "keine interne Auftrags-ID in der Kundenmail");
  assert.equal(saved.access_request.token_hash, tokenHash(token));
  assert.ok(!fs.readFileSync(path.join(dir, REPAIR_ORDERS_FILE), "utf8").includes(token), "Klartext-Token nie gespeichert");
  assert.ok(!c.blobs.dump().includes(token), "Cloud kennt nur den Hash");
  assert.equal(Date.parse(saved.access_request.expires_at) - +T0, 72 * 3600_000, "Ablauf 72 h");
  // Weitere Läufe/«Neustart»: keine zweite Mail; ohne Freigabe kein Login, keine Reparatur.
  await eng.processAll(); await engine(c, gmail, { static: adapter }).processAll();
  assert.equal(gmail.calls.filter((x) => x.op === "SEND").length, 1, "genau EINE Zugangs-Anfrage");
  assert.deepEqual([adapter.calls.checkAccess, adapter.calls.backup, adapter.calls.applyFix], [0, 0, 0], "Zahlung allein ist keine Freigabe");
  const realNow = Date.now; Date.now = () => +clock; // deterministische Uhr (Fixture-Ablauf T0 + 72 h), nur für diese Prüfung
  try { assert.equal(publicRepairOrders(dir).orders[0].phase, "ACCESS_REQUEST_SENT"); } finally { Date.now = realNow; }

  // Kunde öffnet den Link: nur Domain/Ablauf/Public Key/Freigabetext – keine Interna.
  const info = await c.customer({ op: "info", token });
  assert.equal(info.status, 200);
  assert.deepEqual([info.body.domain, info.body.consent_text], ["muster.ch", consentText("muster.ch")]);
  assert.ok(info.body.public_key.includes("BEGIN PUBLIC KEY") && !JSON.stringify(info.body).includes("PRIVATE"));
  assert.ok(!("order_id" in info.body) && !("token_hash" in info.body));
  // Browser verschlüsselt (echtes access-crypto.js über WebCrypto).
  const envelope = await sealForVps(info.body.public_key, { access_type: "wordpress_cms", host: "https://muster.ch/wp-admin", username: "jarvis-temp", secret: SECRET, notes: null });
  assert.ok(validEnvelope(envelope) && !JSON.stringify(envelope).includes(SECRET));
  // Pflichtprüfungen der Cloud: Domain, Freigabe, nur Chiffrat.
  assert.equal((await c.customer({ op: "submit", token, access_type: "wordpress_cms", access_domain: "andere.ch", consent: true, envelope })).status, 400, "Domain-Abweichung");
  assert.equal((await c.customer({ op: "submit", token, access_type: "wordpress_cms", access_domain: "muster.ch", consent: false, envelope })).status, 400, "Freigabe Pflicht");
  assert.equal((await c.customer({ op: "submit", token, access_type: "wordpress_cms", access_domain: "muster.ch", consent: true, envelope: { password: SECRET } })).status, 400, "nie Klartext");
  const ok = await c.customer({ op: "submit", token, access_type: "wordpress_cms", access_domain: "www.muster.ch", consent: true, envelope });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }], "Antwort enthält nie Zugangsdaten");
  assert.equal((await c.customer({ op: "submit", token, access_type: "wordpress_cms", access_domain: "muster.ch", consent: true, envelope })).status, 404, "One-Time: zweite Einreichung ungültig");
  assert.equal((await c.customer({ op: "info", token })).status, 404, "nach Nutzung ungültig");
  assert.ok(!c.blobs.dump().includes(SECRET));

  // VPS holt ab (nur weil ein Auftrag wartet), prüft fail closed, legt nur Chiffrat ab, quittiert → Cloud leer.
  const r = await syncAccessIntake({ store, intake: c.client, now: () => clock, log: (l, e, d) => logs.push(JSON.stringify({ l, e, d })) });
  assert.deepEqual(r, { accepted: 1, rejected: 0 });
  assert.equal((await c.blobs.list("t/")).length, 0, "Chiffrat + Registrierung in der Cloud gelöscht");
  saved = readRF(o.order_id);
  assert.deepEqual([saved.customer_authorized_repair, saved.authorization_source, saved.authorized_domain, saved.authorization.source, !!saved.authorization_at, !!saved.scope],
    [true, "secure_order_access_form", "muster.ch", "secure_order_access_form", true, true]);
  assert.deepEqual([saved.access_intake.status, saved.access_intake.connector_type, saved.access_intake.access_domain], ["RECEIVED", "wordpress_cms", "muster.ch"]);
  assert.ok(hasAccessSecret(dir, o.order_id));
  assert.ok(!fs.readFileSync(path.join(dir, ACCESS_VAULT_DIR, `${o.order_id}.json`), "utf8").includes(SECRET), "Tresor enthält nur Chiffrat");
  assert.equal(openAccessCredential(dir, o.order_id).secret, SECRET, "nur der VPS-Private-Key kann entschlüsseln");

  // Zahlung + Freigabe + Zugang → bestehender Workflow (Zugangsprüfung → Backup → … ). Adapter bekommt den Zugang nur im Speicher.
  // Nach der (Attrappen-)Reparatur ist der Befund weg → Validierung/Retest bestehen, Bericht entsteht.
  const healing = { audit: async (website) => (await fakeAuditor(adapter.calls.applyFix ? [] : [rawIssue]).audit(website)) };
  await engine(c, gmail, { static: adapter }, logs, healing).processAll();
  saved = readRF(o.order_id);
  assert.equal(saved.state, "READY_FOR_DELIVERY", "kompletter Bestandsworkflow bis zur Übergabe");
  assert.ok(saved.state_history.some((h) => h.to === "ACCESS_CHECK" && /Auftragsformular/.test(h.reason)));
  assert.ok(adapter.calls.backup >= 1 && adapter.calls.applyFix >= 1, "Repair-Workflow beginnt (Backup zuerst)");
  assert.equal(adapter.calls.seen[0]?.secret, SECRET);
  assert.ok(["READY_FOR_DELIVERY", "RETEST", "VALIDATION"].includes(saved.state) || saved.state_history.some((h) => h.to === "BACKUP"));

  // Zugangsdaten NIE in: Logs, Order-JSON/allen Worker-Dateien, Dashboard, Cloud-Snapshot, Kundenbericht.
  for (const [f, text] of plainFiles()) assert.ok(!text.includes(SECRET) && !text.includes(token), `${f} enthält Zugangsdaten/Token`);
  assert.ok(!logs.join("\n").includes(SECRET) && !logs.join("\n").includes(token), "Logs ohne Zugangsdaten/Token");
  const pub = publicRepairOrders(dir);
  const snap = cleanSnapshot({ repair: pub });
  for (const blob of [JSON.stringify(pub), JSON.stringify(cleanRepair(pub)), JSON.stringify(snap), JSON.stringify(buildCustomerReport(saved))]) {
    for (const v of [SECRET, token, tokenHash(token), "jarvis-temp", "wp-admin", "kunde@muster.ch", "Bank 1"]) assert.ok(!blob.includes(v), `Sicht enthält "${v}"`);
  }
  assert.deepEqual([pub.orders[0].access_received, pub.orders[0].access_type, pub.orders[0].payment_status, pub.orders[0].rest_to_deposit_chf], [true, "wordpress_cms", "DEPOSIT_MET", 0]);
  // State-Backup erfasst weder Tresor noch Private Key.
  const sec = path.dirname(dir); // stateFiles erwartet <secrets>/mail_worker – hier direkt prüfen, dass nur *.json direkt im Worker zählen
  assert.ok(!stateFiles(sec).some((f) => f.includes(ACCESS_VAULT_DIR) || f.endsWith(".pem")));
  // Secret-Lebenszyklus: Abschluss zerstört den Tresor-Eintrag, nur Metadaten bleiben.
  {
    const done = completeOrder(store, o.order_id, { now: T0 });
    assert.deepEqual([done.access_intake.status, !!done.access_intake.destroyed_at, done.access_intake.revoked_required, done.access_intake.connector_type], ["DESTROYED", true, true, "wordpress_cms"]);
    assert.ok(!hasAccessSecret(dir, o.order_id));
  }
});

test("Abgelaufener Link → ungültig; falsche Order / falscher Token → blockiert; Domain-Mismatch und fehlende Freigabe am VPS → blockiert", async () => {
  const c = cloud(), gmail = fakeGmail();
  const a = newOrder();
  pay(a.order_id, 240);
  await engine(c, gmail).processAll();
  const token = tokenFrom(gmail);
  // Ablauf: 72 h + 1 s später ist der Link tot (Cloud).
  clock = new Date(+T0 + 72 * 3600_000 + 1000);
  assert.equal((await c.customer({ op: "info", token })).status, 404);
  clock = T0;
  assert.equal((await c.customer({ op: "info", token: "x".repeat(43) })).status, 404, "unbekannter Token");
  // Worker-Operationen nur mit Worker-Token.
  assert.equal((await c.customer({ op: "pull" })).status, 401);
  assert.equal((await c.customer({ op: "register", order_id: a.order_id }, { "x-jarvis-worker": "falsch" })).status, 401);

  // VPS-seitig (auch wenn die Cloud manipuliert wäre): jede Abweichung wird abgelehnt, nichts gespeichert.
  const pk = accessKeys(dir).publicKeyPem;
  const env = sealEnvelope({ access_type: "sftp", secret: SECRET }, pk);
  const sub = (over = {}, subOver = {}) => ({ order_id: a.order_id, domain: "muster.ch", token_hash: readRF(a.order_id).access_request.token_hash,
    ...over, submission: { submitted_at: T0.toISOString(), access_type: "sftp", access_domain: "muster.ch", consent: true, consent_text: consentText("muster.ch"), envelope: env, ...subOver } });
  // Zweiter Auftrag einer anderen Firma: Token von A darf nie B freischalten.
  const b = createRepairOrder(store, { domain: "andere.ch", website: "https://andere.ch/", delivery_email: "x@andere.ch", now: T0 });
  pay(b.order_id, 240);
  await engine(c, fakeGmail()).processAll();
  const cases = [
    [sub({ order_id: b.order_id, domain: "andere.ch" }, { access_domain: "andere.ch", consent_text: consentText("andere.ch") }), /Token passt nicht/],
    [sub({ token_hash: "f".repeat(64) }), /Token passt nicht/],
    [sub({}, { access_domain: "evil.ch" }), /Domain/],
    [sub({ domain: "evil.ch" }), /Domain/],
    [sub({}, { consent: false }), /freigabe/i],
    [sub({}, { consent_text: "ok" }), /freigabe/i],
    [sub({}, { submitted_at: new Date(+T0 + 73 * 3600_000).toISOString() }), /abgelaufen/],
    [sub({}, { access_type: "root_password" }), /Zugangsart/],
    [sub({}, { envelope: sealEnvelope({ secret: SECRET }, accessKeys(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-acc-x-"))).publicKeyPem) }), /entschlüsselbar/],
  ];
  for (const [s, re] of cases) {
    const r = applyAccessSubmission(store, s, { now: T0 });
    assert.equal(r.ok, false); assert.match(r.reason, re);
  }
  assert.ok(!hasAccessSecret(dir, a.order_id) && !hasAccessSecret(dir, b.order_id), "nichts im Tresor");
  assert.equal(readRF(a.order_id).customer_authorized_repair, false, "keine Freigabe aus abgelehnten Einreichungen");
  assert.ok(readRF(a.order_id).access_intake_rejections.length >= 1);
  // Zahlung unter die Schwelle (refund) → auch eine sonst gültige Einreichung wird abgelehnt.
  const p = store.read("payments.json", { payments: {} });
  refundPayment(store, Object.values(p.payments).find((x) => x.order_id === a.order_id).payment_id, { reason: "Rückerstattung", now: T0 });
  // Order zurück in ACCESS_REQUESTED setzen (Engine würde sie nach PAYMENT_REQUIRED schieben) – die Prüfung greift trotzdem.
  assert.match(applyAccessSubmission(store, sub(), { now: T0 }).reason, /Zahlungsschwelle/);
});

test("Freigabe ohne Zugang → 0 Reparatur; Zugang ohne Freigabe → 0 Reparatur", async () => {
  // a) Freigabe (Chris, CLI) + Zahlung, aber Zugangsprüfung scheitert → Anfrage, keine Reparatur.
  const c = cloud(), gmail = fakeGmail(), adapter = fakeAdapter({ ok: false });
  const o = newOrder();
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_order_form", now: T0 });
  pay(o.order_id, 240);
  await engine(c, gmail, { static: adapter }).processAll();
  assert.equal(readRF(o.order_id).state, "ACCESS_REQUESTED");
  assert.deepEqual([adapter.calls.backup, adapter.calls.applyFix], [0, 0]);
  // b) Zugang konfiguriert (Adapter ok), Zahlung da, aber KEINE Freigabe → nie Backup/Reparatur.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-acc-b-")); const s2 = createStore(dir2);
  const o2 = createRepairOrder(s2, { domain: "muster.ch", website: HOME, delivery_email: "kunde@muster.ch", now: T0 });
  recordPayment(s2, { order_id: o2.order_id, amount_chf: 480, now: T0 });
  const ad2 = fakeAdapter({ ok: true }), g2 = fakeGmail();
  const e2 = createRepairEngine({ store: s2, adapters: { static: ad2 }, auditor: fakeAuditor(), gmail: g2, intake: cloud().client, now: () => T0 });
  await e2.processAll(); await e2.processAll();
  assert.equal(s2.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o2.order_id].state, "ACCESS_REQUESTED");
  assert.deepEqual([ad2.calls.checkAccess, ad2.calls.backup, ad2.calls.applyFix], [0, 0, 0], "ohne Freigabe kein Login, keine Änderung");
});

test("Zahlung fällt nach Start: vor Änderung → PAYMENT_REQUIRED (wartet); nach Änderung → PAYMENT_REVIEW_REQUIRED, KEIN automatischer Rollback", async () => {
  const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-acc-p-")); const s = createStore(d);
    const o = createRepairOrder(s, { domain: "muster.ch", website: HOME, delivery_email: "kunde@muster.ch", now: T0 });
    authorizeRepair(s, o.order_id, { authorized_domain: "muster.ch", source: "customer_order_form", now: T0 });
    const p = recordPayment(s, { order_id: o.order_id, amount_chf: 240, now: T0 });
    return { s, o, p }; };
  // a) Backup erstellt, noch nichts verändert.
  let { s, o, p } = mk();
  const set = (st, patch) => { const d = s.read(REPAIR_ORDERS_FILE, { orders: {} }); Object.assign(d.orders[o.order_id], { state: st, stack: { type: "static" } }, patch); s.write(REPAIR_ORDERS_FILE, d); };
  set("FULL_AUDIT", { backup: { rollback_point: "deploy-42", branch: "repair/x" } });
  voidPayment(s, p.payment_id, { reason: "Fehlbuchung", now: T0 });
  const ad = fakeAdapter(); let rolled = 0; ad.rollback = async () => { rolled++; return { ok: true }; };
  await createRepairEngine({ store: s, adapters: { static: ad }, auditor: fakeAuditor(), now: () => T0 }).processAll();
  assert.equal(s.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id].state, "PAYMENT_REQUIRED");
  // b) Reparatur bereits angewendet.
  ({ s, o, p } = mk());
  set("VALIDATION", { backup: { rollback_point: "deploy-42", branch: "repair/x" }, plan: [{ issue_id: "I1" }], issues: { I1: { issue_id: "I1", repair_status: "repaired", change_ref: "commit-abc" } } });
  refundPayment(s, p.payment_id, { reason: "Kunde storniert", now: T0 });
  await createRepairEngine({ store: s, adapters: { static: ad }, auditor: fakeAuditor(), now: () => T0 }).processAll();
  const saved = s.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(saved.state, "PAYMENT_REVIEW_REQUIRED");
  assert.equal(rolled, 0, "nie automatischer Rollback – Chris entscheidet");
  assert.equal(publicRepairOrders(s.dir).orders[0].payment_status, "PAYMENT_REVIEW_REQUIRED");
});

test("Send-Idempotenz Zugangs-Anfrage + Storno zerstört Zugangsdaten; Worker holt nur bei wartenden Aufträgen ab", async () => {
  const c = cloud(), gmail = fakeGmail();
  const o = newOrder();
  pay(o.order_id, 240);
  // Absturz mitten im Versand simulieren: Versuch markiert, kein sent_at → nie eine zweite Mail.
  const crash = { ...gmail, sendDraft: async () => { throw new Error("Prozess beendet"); } };
  const d = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  await engine(c, { ...gmail, sendDraft: async (id) => { const x = store.read(REPAIR_ORDERS_FILE, { orders: {} }); assert.ok(x.orders[o.order_id].access_request.send_attempted_at, "Versuch vor dem Send persistiert"); return gmail.sendDraft(id); } }).processAll();
  assert.equal(gmail.calls.filter((x) => x.op === "SEND").length, 1);
  const x = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  x.orders[o.order_id].access_request.sent_at = null; // «Absturz nach Gmail, vor dem Speichern»
  store.write(REPAIR_ORDERS_FILE, x);
  await engine(c, crash).processAll(); await engine(c, gmail).processAll();
  assert.equal(gmail.calls.filter((y) => y.op === "SEND").length, 1, "kein blindes Doppelsenden");
  assert.equal(readRF(o.order_id).access_request.send_unclear, true);
  void d;
  // Zugang übermitteln, abholen, dann stornieren → Tresor weg, Metadaten bleiben.
  const fix = store.read(REPAIR_ORDERS_FILE, { orders: {} }); fix.orders[o.order_id].access_request.sent_at = T0.toISOString(); store.write(REPAIR_ORDERS_FILE, fix);
  const token = tokenFrom(gmail);
  const info = await c.customer({ op: "info", token });
  await c.customer({ op: "submit", token, access_type: "sftp", access_domain: "muster.ch", consent: true, envelope: await sealForVps(info.body.public_key, { access_type: "sftp", secret: SECRET }) });
  let pulls = 0; const counting = { ...c.client, pull: async () => { pulls++; return c.client.pull(); } };
  await runRepairOrders({ dir, adapters: {}, gmail, intake: counting, log: () => {} });
  assert.equal(pulls, 1);
  assert.ok(hasAccessSecret(dir, o.order_id));
  const cancelled = cancelRepairOrder(store, o.order_id, { reason: "Testauftrag", now: T0 });
  assert.deepEqual([cancelled.state, cancelled.access_intake.status, !!cancelled.access_intake.destroyed_at], ["CANCELLED", "DESTROYED", true]);
  assert.ok(!hasAccessSecret(dir, o.order_id));
  assert.equal(JSON.stringify(readRF(o.order_id)).includes(SECRET), false);
  // Keine wartenden Aufträge mehr → kein Abholen (kein Busy-Loop, kein Netzverkehr).
  await runRepairOrders({ dir, adapters: {}, gmail, intake: counting, log: () => {} });
  assert.equal(pulls, 1);
});

test("Kundenseite + Netlify + Container: strikte CSP, Token nur im Fragment, keine Secrets im Frontend; Dockerfile/Worker verdrahtet", () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "access.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "public", "access.js"), "utf8");
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  assert.ok(!/<script>(?!<\/script>)/.test(html) && html.includes('<script type="module" src="access.js">'), "kein Inline-Skript");
  assert.ok(toml.includes('for = "/access*"') && /script-src 'self'/.test(toml) && /Cache-Control = "no-store"/.test(toml));
  assert.ok(js.includes("location.hash") && js.includes("history.replaceState") && !/localStorage|sessionStorage|console\.log/.test(js), "Token/Zugang nie im Browser gespeichert oder geloggt");
  for (const f of ["access.html", "access.js", "access-crypto.js", "access.css"]) {
    const src = fs.readFileSync(path.join(ROOT, "public", f), "utf8");
    assert.ok(!/PRIVATE KEY|JARVIS_MAIL_WORKER_TOKEN|x-jarvis-worker/.test(src), `${f} enthält Secrets/Worker-Zugang`);
  }
  assert.ok(html.includes("temporären Benutzer") || html.includes("temporären SFTP/SSH-Benutzer"));
  const fn = fs.readFileSync(path.join(ROOT, "netlify", "functions", "access-intake.mjs"), "utf8");
  assert.ok(fn.includes('path: "/api/access-intake"') && !/PRIVATE|privateDecrypt/.test(fn));
  const docker = fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile"), "utf8");
  assert.ok(docker.includes("access-intake.js") && docker.includes("access-intake-api.js") && docker.includes("payments.js"));
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.ok(/\.secrets/.test(gi), "Tresor/Private Key liegen unter .secrets (gitignored)");
});
