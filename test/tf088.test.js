// TF-088 – kontrollierter E2E-Erfüllungstest CHF 150 (Audit → Bericht → Outbox → ECHTER Outbox-Konsument des Mail-Workers → Test-Postfach).
// Standard AUS; nur mit Basisfreigabe + Erfüllungsfreigabe + Allowlist + Freigabe pro Auftrag. Nur Fixtures: Auditor und Gmail sind Attrappen,
// die Outbox- und Engine-Logik sind die echten. 0 echte Mails, 0 Zahlungen, 0 Netz.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { recordPayment, paymentsForOrder, PAYMENTS_FILE } from "../payments.js";
import { recordSale } from "../sales.js";
import {
  createCheck150Order, createCheck150Engine, approveE2eFulfilment, e2eFulfilmentCheck, check150Status, publicCheck150Orders, runCheck150Orders, CHECK150_ORDERS_FILE,
} from "../check-150-workflow.js";
import { createOutboxMailer, processRepairOutbox, outboxStatus } from "../repair-outbox.js";
import { e2eFulfilmentConfig, e2eFulfilmentStatus } from "../e2e-test.js";
import { cleanCheck150 } from "../server-control.js";
import { deriveLedger, ordersFromSnapshot, emptyLedger } from "../commission-ledger.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T0 = new Date("2026-10-19T12:00:00Z");
const RUN = "e2e-0123456789ab";
const BASE = { JARVIS_E2E_TEST_ENABLED: "true", JARVIS_E2E_TEST_DOMAINS: "jarvis-sandbox.ch", JARVIS_E2E_TEST_MAILBOXES: "e2e@helvetic-test.ch" };
const ON = { ...BASE, JARVIS_E2E_FULFILMENT_ENABLED: "true" };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf088-")), dir = path.join(root, "mail_worker"), obox = path.join(root, "outbox");
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, obox, store: createStore(dir), mailer: createOutboxMailer({ dir: obox, now: () => T0 }) };
}
const testOrder = (s, env = ON) => {
  const o = createCheck150Order(s.store, { domain: "jarvis-sandbox.ch", delivery_email: "e2e@helvetic-test.ch", test: { run_id: RUN }, env, now: T0 });
  recordPayment(s.store, { order_id: o.order_id, amount: 150, currency: "CHF", source: "stripe_test_payment_link", reference: "stripe:pi_tf088", provider_mode: "TEST", now: T0 }); // die vorhandene Stripe-TESTzahlung
  return o;
};
function auditor(n = 2) {
  const calls = [];
  return { calls, audit: async (website) => { calls.push(website); return { website, host: "jarvis-sandbox.ch", reachable: true, finalUrl: website, title: "Sandbox", requests: 1, pages: { home: "<html><meta name=viewport content=x></html>" },
    issues: Array.from({ length: n }, (_, i) => ({ type: "broken_link", url: `https://jarvis-sandbox.ch/alt${i}`, page: website, evidence: "HTTP 404", severity: "medium", label: `Seite ${i}`, detectedAt: T0.toISOString() })) }; } };
}
function fakeGmail() { const calls = []; return { calls,
  createDraft: async (x) => { calls.push({ op: "create", to: x.to, subject: x.subject, body: x.body, messageClass: x.messageClass }); return { draftId: "g" + calls.length, threadId: "t" }; },
  sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "m-" + id, threadId: "t" }; } }; }
const engine = (s, aud, env = ON, gmail = s.mailer) => createCheck150Engine({ dir: s.dir, store: s.store, gmail, auditor: aud, now: () => T0, env });
const consume = (s, g, env = ON) => processRepairOutbox({ dir: s.obox, gmail: g, now: () => T0, env });
const rd = (s, id) => s.store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[id];
const files = (s, ext) => (fs.existsSync(s.obox) ? fs.readdirSync(s.obox) : []).filter((f) => f.endsWith(ext));
const bytes = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return null; } };

test("Konfiguration: Erfüllungsfreigabe ist STANDARD AUS und gilt nie ohne Basisfreigabe + Allowlist", () => {
  assert.equal(e2eFulfilmentConfig({}).fulfilmentReady, false);
  assert.equal(e2eFulfilmentConfig(BASE).fulfilmentReady, false, "Basisfreigabe allein genügt nicht");
  assert.equal(e2eFulfilmentConfig({ JARVIS_E2E_FULFILMENT_ENABLED: "true" }).fulfilmentReady, false, "Erfüllungsflag allein genügt nicht");
  assert.equal(e2eFulfilmentConfig({ ...ON, JARVIS_E2E_TEST_DOMAINS: "" }).fulfilmentReady, false);
  assert.equal(e2eFulfilmentConfig({ ...ON, JARVIS_E2E_TEST_MAILBOXES: "" }).fulfilmentReady, false);
  assert.equal(e2eFulfilmentConfig(ON).fulfilmentReady, true);
  assert.deepEqual(e2eFulfilmentStatus(e2eFulfilmentConfig(BASE)), { e2e_fulfilment: "OFF", fulfilment_flag: false });
});

test("Standard (TF-084 unverändert): ohne Erfüllungsfreigabe bleibt der Testauftrag unberührt – kein Audit, keine Outbox, kein Verkauf", async () => {
  const s = setup(), o = testOrder(s), a = auditor();
  assert.throws(() => approveE2eFulfilment(s.store, o.order_id, { env: BASE }), /E2E_BLOCKED/);
  const before = bytes(s.dir, CHECK150_ORDERS_FILE);
  assert.equal(check150Status(s.dir).e2e_runnable, 0);
  assert.deepEqual(await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: a, env: ON, log: () => {} }), { busy: false, processed: 0, advanced: 0, states: {} });
  await engine(s, a, ON).step(structuredClone(rd(s, o.order_id))); // selbst ein direkter step() ohne Freigabe tut nichts
  assert.equal(a.calls.length, 0); assert.equal(files(s, ".json").length, 0); assert.equal(bytes(s.dir, CHECK150_ORDERS_FILE), before);
  assert.equal(rd(s, o.order_id).state, "ORDER_CONFIRMED"); assert.equal(bytes(s.dir, "sales.json"), null);
});

test("Freigabe pro Auftrag: nur CH-CHF-150-Testauftrag, nur mit Allowlist, nur mit bereits erfüllter TEST-Zahlung (keine neue Zahlung), nur einmal", () => {
  const s = setup(), o = testOrder(s);
  assert.throws(() => approveE2eFulfilment(s.store, o.order_id, { env: { ...ON, JARVIS_E2E_TEST_MAILBOXES: "andere@helvetic-test.ch" } }), /Lieferadresse nicht in der E2E-Allowlist/);
  assert.throws(() => approveE2eFulfilment(s.store, o.order_id, { env: { ...ON, JARVIS_E2E_TEST_DOMAINS: "andere-sandbox.ch" } }), /Domain nicht in der E2E-Allowlist/);
  const unpaid = createCheck150Order(s.store, { domain: "sandbox-zwei.ch", delivery_email: "e2e@helvetic-test.ch", test: { run_id: "e2e-aaaaaaaaaaaa" }, env: { ...ON, JARVIS_E2E_TEST_DOMAINS: "jarvis-sandbox.ch,sandbox-zwei.ch" }, now: new Date(+T0 + 1000) });
  assert.throws(() => approveE2eFulfilment(s.store, unpaid.order_id, { env: { ...ON, JARVIS_E2E_TEST_DOMAINS: "jarvis-sandbox.ch,sandbox-zwei.ch" } }), /Zahlungsschwelle nicht erfüllt.*KEINE neue Zahlung/);
  const live = createCheck150Order(s.store, { domain: "kunde.ch", delivery_email: "info@kunde.ch", now: T0 });
  assert.throws(() => approveE2eFulfilment(s.store, live.order_id, { env: ON }), /kein Testauftrag/);
  const ok = approveE2eFulfilment(s.store, o.order_id, { env: ON, now: T0 });
  assert.equal(ok.e2e_fulfilment.approved_at, T0.toISOString()); assert.equal(ok.test_order, true); assert.equal(ok.commission_rate_bps, 0);
  assert.throws(() => approveE2eFulfilment(s.store, o.order_id, { env: ON }), /bereits freigegeben/);
  assert.equal(rd(s, live.order_id).e2e_fulfilment, undefined, "Live-Auftrag trägt nie ein E2E-Flag");
});

test("E2E Ende-zu-Ende: Audit der Sandbox-Domain → Bericht → Outbox → ECHTER Konsument → Test-Postfach → COMPLETED; Ledger/Verkauf/Provision unberührt", async () => {
  const s = setup(), o = testOrder(s), a = auditor(2), g = fakeGmail();
  approveE2eFulfilment(s.store, o.order_id, { env: ON, now: T0 });
  const ledger = bytes(s.dir, PAYMENTS_FILE);
  assert.equal(check150Status(s.dir).e2e_runnable, 1); assert.equal(check150Status(s.dir).open, 0, "zählt nie als offen");
  await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: a, env: ON, log: () => {} });
  let r = rd(s, o.order_id);
  assert.deepEqual(a.calls, ["https://jarvis-sandbox.ch/"], "genau ein Audit, nur die Sandbox-Domain");
  assert.equal(r.state, "DELIVERY_SENDING"); assert.equal(r.report_findings_count, 2); assert.ok(r.report?.findings.length === 2); assert.equal(r.delivery_draft.inline, true);
  assert.equal(files(s, ".request.json").length, 1, "genau EIN verbindlicher Versandauftrag in der Outbox"); assert.equal(g.calls.length, 0, "noch nichts gesendet – der Mail-Worker ist die Sender Authority");
  const req = JSON.parse(fs.readFileSync(path.join(s.obox, files(s, ".request.json")[0]), "utf8"));
  assert.equal(req.to, "e2e@helvetic-test.ch"); assert.equal(req.e2e_run_id, RUN); assert.equal(req.message_class, "CUSTOMER_ORDER_FULFILLMENT");
  assert.ok(req.subject.startsWith("[E2E-TEST] ")); assert.match(req.body, /E2E-TESTLAUF/); assert.match(req.body, /PROBLEM 1/);
  // ECHTER Konsument (Mail-Worker) sendet genau einmal an das Test-Postfach
  const c = await consume(s, g);
  assert.equal(c.sent, 1); assert.equal(c.rejected, 0);
  assert.deepEqual(g.calls.map((x) => x.op), ["create", "SEND"]); assert.equal(g.calls[0].to, "e2e@helvetic-test.ch"); assert.equal(g.calls[0].messageClass, "CUSTOMER_ORDER_FULFILLMENT");
  await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: a, env: ON, log: () => {} });
  r = rd(s, o.order_id);
  assert.equal(r.state, "COMPLETED"); assert.equal(r.delivery_status, "sent"); assert.ok(r.delivery_sent_at); assert.ok(r.e2e_fulfilment.delivered_at);
  // Isolation: keine Zahlung, kein Verkauf, keine Reparatur, keine Provision, kein Umsatz
  assert.equal(bytes(s.dir, PAYMENTS_FILE), ledger, "Zahlungsbuch unverändert (keine neue Zahlung)");
  assert.equal(paymentsForOrder(s.store, o.order_id).length, 1);
  assert.equal(bytes(s.dir, "sales.json"), null); assert.equal(bytes(s.dir, "repair_orders.json"), null);
  const snap = { check150: cleanCheck150(publicCheck150Orders(s.dir)), repair: { orders: [] } };
  const sn = snap.check150.orders.find((x) => x.order_id === o.order_id);
  assert.equal(sn.test_order, true); assert.equal(sn.environment, "TEST"); assert.equal(sn.commission_rate_bps, 0); assert.equal(sn.paid_chf, 150); assert.equal(sn.payment_status, "PAID_FULL");
  assert.equal(snap.check150.open, 0); assert.equal(snap.check150.total, 0);
  const { ledger: L } = deriveLedger({ ledger: { ...emptyLedger(), eligible_from: new Date(+T0 - 86_400_000).toISOString() }, orders: ordersFromSnapshot(snap), resolveSeller: () => ({ seller_id: "x", lead_id: "y", source: "assignment" }), now: new Date(+T0 + 3_600_000) });
  assert.deepEqual(Object.keys(L.entries), [], "keine Provision für den Testlauf");
});

test("Doppelschutz: wiederholte Läufe, wiederholter Konsument und erneute Freigabe erzeugen weder zweiten Auftrag, Entwurf noch Versand", async () => {
  const s = setup(), o = testOrder(s), a = auditor(2), g = fakeGmail();
  approveE2eFulfilment(s.store, o.order_id, { env: ON, now: T0 });
  for (let i = 0; i < 3; i++) await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: a, env: ON, log: () => {} }); // Konsument noch offline
  assert.equal(files(s, ".request.json").length, 1); assert.equal(files(s, ".draft.json").length, 0); assert.equal(a.calls.length, 1, "Audit nur einmal");
  await consume(s, g); await consume(s, g);
  assert.equal(g.calls.filter((x) => x.op === "SEND").length, 1);
  for (let i = 0; i < 3; i++) await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: a, env: ON, log: () => {} });
  await consume(s, g);
  assert.equal(g.calls.filter((x) => x.op === "SEND").length, 1, "weiterhin genau eine Mail"); assert.equal(g.calls.filter((x) => x.op === "create").length, 1);
  assert.equal(rd(s, o.order_id).state, "COMPLETED"); assert.equal(a.calls.length, 1);
  assert.throws(() => approveE2eFulfilment(s.store, o.order_id, { env: ON }), /E2E_BLOCKED/, "abgeschlossener Auftrag nie ein zweites Mal");
  assert.equal(outboxStatus(s.obox).pending, 0);
});

test("Mail-Worker prüft UNABHÄNGIG: ohne eigene Erfüllungsfreigabe oder mit fremdem Postfach wird abgelehnt, nie gesendet", async () => {
  // (a) Mail-Worker ohne Erfüllungsflag
  let s = setup(), o = testOrder(s), g = fakeGmail();
  approveE2eFulfilment(s.store, o.order_id, { env: ON, now: T0 });
  await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: auditor(), env: ON, log: () => {} });
  let c = await consume(s, g, BASE);
  assert.equal(c.rejected, 1); assert.equal(c.sent, 0); assert.equal(g.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.obox, files(s, ".result.json")[0]), "utf8")).reason, "e2e_blocked");
  await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: auditor(), env: ON, log: () => {} });
  assert.equal(rd(s, o.order_id).state, "READY_FOR_DELIVERY", "abgelehnt → Übergabe an Chris, nie COMPLETED"); assert.equal(rd(s, o.order_id).delivery_sent_at, undefined);
  // (b) manipulierter Auftrag: Testmail an eine fremde Adresse
  s = setup(); g = fakeGmail();
  const d = await s.mailer.createDraft({ to: "kunde@fremd.ch", subject: "[E2E-TEST] x", body: "b", messageClass: "CUSTOMER_ORDER_FULFILLMENT", e2eRunId: RUN });
  await assert.rejects(s.mailer.sendDraft(d.draftId), /OUTBOX_PENDING/);
  c = await consume(s, g); assert.equal(c.rejected, 1); assert.equal(g.calls.length, 0);
  // (c) Betreff [E2E-TEST] ohne Kennung ist ebenfalls gesperrt; (d) Kennung ohne Betreffmarke kann gar nicht erst angelegt werden
  s = setup(); g = fakeGmail();
  const d2 = await s.mailer.createDraft({ to: "e2e@helvetic-test.ch", subject: "[E2E-TEST] y", body: "b", messageClass: "CUSTOMER_ORDER_FULFILLMENT" });
  await assert.rejects(s.mailer.sendDraft(d2.draftId), /OUTBOX_PENDING/);
  c = await consume(s, g); assert.equal(c.rejected, 1); assert.equal(g.calls.length, 0);
  await assert.rejects(s.mailer.createDraft({ to: "e2e@helvetic-test.ch", subject: "Hallo", body: "b", messageClass: "CUSTOMER_ORDER_FULFILLMENT", e2eRunId: RUN }), /E2E-Testmail ungültig/);
  await assert.rejects(s.mailer.createDraft({ to: "e2e@helvetic-test.ch", subject: "[E2E-TEST] z", body: "b", messageClass: "CUSTOMER_ACCESS_REQUEST", e2eRunId: RUN }), /E2E-Testmail ungültig/);
});

test("Laufzeit-Prüfung vor jedem Schritt: Allowlist entfällt oder kein Outbox-Weg → MANUAL_REVIEW (E2E_BLOCKED), nichts auditiert, nichts gesendet", async () => {
  let s = setup(), o = testOrder(s), a = auditor();
  approveE2eFulfilment(s.store, o.order_id, { env: ON, now: T0 });
  await engine(s, a, { ...ON, JARVIS_E2E_TEST_MAILBOXES: "wer-anders@helvetic-test.ch" }).processAll();
  assert.equal(rd(s, o.order_id).state, "MANUAL_REVIEW_REQUIRED"); assert.match(rd(s, o.order_id).blocked_reason, /E2E_BLOCKED/);
  assert.equal(a.calls.length, 0); assert.equal(files(s, ".json").length, 0);
  // direkter Gmail-Weg (kein Outbox-Konsument mit Prüfung) ist für Testaufträge gesperrt
  s = setup(); o = testOrder(s); a = auditor(); const g = fakeGmail();
  approveE2eFulfilment(s.store, o.order_id, { env: ON, now: T0 });
  await engine(s, a, ON, g).processAll();
  assert.equal(rd(s, o.order_id).state, "MANUAL_REVIEW_REQUIRED"); assert.equal(g.calls.length, 0); assert.equal(a.calls.length, 0);
  // Website weicht von der Sandbox-Domain ab
  const bad = { ...rd(s, o.order_id), website: "https://kunde.ch/" };
  assert.equal(e2eFulfilmentCheck(bad, ON).ok, false);
  assert.equal(e2eFulfilmentCheck({ ...bad, website: "https://jarvis-sandbox.ch/" }, ON).ok, true);
  assert.equal(e2eFulfilmentCheck({ ...bad, website: "https://jarvis-sandbox.ch/", offer_class: "REPAIR_CHECK_150", market: "VN" }, ON).ok, false);
});

test("Produktion unverändert: echte CHF-150-Aufträge laufen wie zuvor (ohne E2E-Kennung, ohne Betrugsmarke); ein nicht freigegebener Testauftrag daneben bleibt unberührt", async () => {
  const s = setup(), t = testOrder(s), a = auditor(2), g = fakeGmail();
  s.store.write("sales.json", { records: recordSale({}, "kunde.ch", { offer: "REPAIR_CHECK_150", date: "2026-10-19", now: T0 }) });
  const live = createCheck150Order(s.store, { domain: "kunde.ch", website: "https://kunde.ch/", company: "Kunde AG", delivery_email: "info@kunde.ch", now: T0 });
  recordPayment(s.store, { order_id: live.order_id, amount: 150, currency: "CHF", source: "stripe_payment_link", reference: "stripe:pi_live1", provider_mode: "LIVE", now: T0 });
  // Mail-Worker OHNE jede E2E-Konfiguration (Produktionsfall)
  await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: a, env: {}, log: () => {} });
  const req = JSON.parse(fs.readFileSync(path.join(s.obox, files(s, ".request.json")[0]), "utf8"));
  assert.equal(req.e2e_run_id, undefined); assert.ok(!req.subject.startsWith("[E2E-TEST]")); assert.equal(req.to, "info@kunde.ch");
  assert.equal((await consume(s, g, {})).sent, 1, "normale Kundenmail geht auch ohne E2E-Konfiguration raus");
  await runCheck150Orders({ dir: s.dir, gmail: s.mailer, auditor: a, env: {}, log: () => {} });
  assert.equal(rd(s, live.order_id).state, "COMPLETED"); assert.equal(rd(s, live.order_id).e2e_fulfilment, undefined);
  assert.equal(rd(s, t.order_id).state, "ORDER_CONFIRMED", "nicht freigegebener Testauftrag blieb liegen"); assert.deepEqual(a.calls, ["https://kunde.ch/"]);
  assert.equal(g.calls.filter((x) => x.op === "SEND").length, 1);
});

test("CLI `--approve-e2e-fulfilment` (echter Prozess): ohne Server-Freigabe abgelehnt (Exit 1), mit Freigabe nur das Flag gesetzt – kein Lauf, keine Mail", () => {
  const s = setup(), o = testOrder(s);
  const run = (env) => spawnSync(process.execPath, [path.join(ROOT, "check-150-workflow.js"), "--approve-e2e-fulfilment", o.order_id],
    { env: { PATH: process.env.PATH, JARVIS_SECRETS_DIR: s.root, ...env }, encoding: "utf8" });
  let r = run(BASE); assert.equal(r.status, 1); assert.match(r.stderr, /E2E_BLOCKED/); assert.equal(rd(s, o.order_id).e2e_fulfilment, undefined);
  r = run(ON); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /freigegeben/);
  assert.ok(rd(s, o.order_id).e2e_fulfilment.approved_at); assert.equal(rd(s, o.order_id).state, "ORDER_CONFIRMED"); assert.equal(files(s, ".json").length, 0);
});

test("Betrieb: Installationsskript kennt den separaten Schalter (kein Standardwert), e2e.env erreicht Mail-Worker UND Repair-Service", () => {
  const sh = fs.readFileSync(path.join(ROOT, "deploy", "vps", "install-stripe-keys.sh"), "utf8");
  assert.match(sh, /JARVIS_E2E_FULFILMENT_ENABLED/); assert.match(sh, /fulfilment\)/); assert.doesNotMatch(sh, /JARVIS_E2E_FULFILMENT_ENABLED=true/);
  const compose = fs.readFileSync(path.join(ROOT, "deploy", "vps", "docker-compose.yml"), "utf8");
  assert.match(compose, /\/opt\/jarvis-payment\/e2e\.env/);
  assert.match(fs.readFileSync(path.join(ROOT, "deploy", "vps", "repair", "docker-compose.yml"), "utf8"), /\$\{JARVIS_PAYMENT_DIR:-\/opt\/jarvis-payment\}\/e2e\.env/, "auch der Repair-Service liest e2e.env (Standard /opt/jarvis-payment)");
});
