// PAYMENT GATES + SECURE CUSTOMER ACCESS (TF-041): VERKAUF != ZAHLUNG. Persistenter Payment-Ledger (payments.json),
// Zahlungen primär an die ORDER_ID gebunden (nie nur Domain), nie löschen (VOIDED/REFUNDED nur markieren).
// CHF-150: erst ab kumulativ CHF 75 Check/Anleitung/Bericht + AUTOMATISCHER Versand der Service-Mail; vorher nichts.
// CHF-480: erst ab kumulativ CHF 240 automatische Bitte um SICHEREN Zugang (nie Passwörter per Mail), danach der
// bestehende Reparaturworkflow; vorher kein Zugang, kein Login, keine Website-Änderung. Ohne Netz – alles Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { OFFERS } from "../sales.js";
import { PAYMENTS_FILE, PAYMENT_STATUS, paymentThresholdChf, recordPayment, voidPayment, refundPayment, paidChf,
  paymentsForOrder, paymentGateForOrder, paymentsStatus, findPayableOrder } from "../payments.js";
import { CHECK150_ORDERS_FILE, createCheck150Order, createCheck150Engine, check150Status, publicCheck150Orders } from "../check-150-workflow.js";
import { REPAIR_ORDERS_FILE, createRepairOrder, authorizeRepair, createRepairEngine, buildAccessRequestMail,
  repairOrdersStatus, publicRepairOrders } from "../repair-workflow.js";
import { cleanRepair } from "../server-control.js";
import { createAccessIntakeHandler, memoryIntakeStore } from "../access-intake-api.js";
import { intakeClient } from "../access-intake.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T12:00:00Z");
const HOME = "https://muster.ch/";
let dir, store;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pay-")); store = createStore(dir); });

const sale150 = (domain = "muster.ch") => store.write("sales.json", { records: { [domain]: { status: "customer",
  sale: { selected_offer: "REPAIR_CHECK_150", sale_date: "2026-10-12", sale_value: 150, currency: "CHF", customer_status: "customer", work_status: "open", evidence: [] } } } });
const c150Order = (over = {}) => createCheck150Order(store, { domain: "muster.ch", website: HOME, company: "Muster AG", delivery_email: "auftrag@muster.ch", contact_name: "Frau Muster", now: T0, ...over });
const rfOrder = (over = {}) => createRepairOrder(store, { domain: "muster.ch", website: HOME, company: "Muster AG", delivery_email: "kunde@muster.ch", contact_name: "Frau Muster", now: T0, ...over });
const authorize = (id) => authorizeRepair(store, id, { authorized_domain: "muster.ch", source: "customer_order_form", reference: "Bestellung 2026-10-12", now: T0 });
const rawIssue = { type: "broken_link", url: "https://muster.ch/team-alt", page: HOME, label: "Unser Team", evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity: "medium", detectedAt: T0.toISOString() };

function fakeAuditor(issues = [rawIssue]) {
  const calls = [];
  return { calls, audit: async (website) => { calls.push(website); return { website, host: "muster.ch", reachable: true, finalUrl: website,
    title: "Muster AG", issues, pages: { home: "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" }, requests: 2 }; } };
}
function fakeGmail({ failSend = null } = {}) {
  const calls = [];
  return { calls,
    createDraft: async (x) => { calls.push({ op: "create", to: x.to, subject: x.subject, body: x.body }); return { draftId: "dr" + calls.filter((c) => c.op === "create").length, threadId: "t1", messageId: "m1" }; },
    updateDraft: async (id, x) => { calls.push({ op: "update", id, ...x }); return { draftId: id }; },
    sendDraft: async (id) => { if (failSend) { const e = failSend; failSend = null; throw new Error(e); } calls.push({ op: "SEND", id }); return { messageId: "sent-" + id }; } };
}
function fakeAdapter({ ok = true } = {}) {
  const calls = { checkAccess: 0, backup: 0, locate: 0, applyFix: 0 };
  return { calls,
    checkAccess: async () => { calls.checkAccess++; return { ok, connector: "test-connector" }; },
    backup: async (order, { branch }) => { calls.backup++; return { production_ref: "deploy-42", backup_ref: "backup-1", rollback_point: "deploy-42", branch }; },
    locate: async (issue) => { calls.locate++; return { target: "index.html", cause: `Verweis auf ${issue.url} zeigt ins Leere`, planned_change: "Linkziel korrigieren" }; },
    applyFix: async () => { calls.applyFix++; return { ok: true, change_ref: "commit-abc" }; } };
}
// Cloud-Seite des sicheren Links (access-intake-api.js) in-memory – die Engine spricht über den echten Client mit ihr.
const WT = "w".repeat(43);
function cloudIntake(clock = () => T0) {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined), now: clock });
  const client = intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn: async (url, init) => handler(new Request(url, init)) });
  return { blobs, handler, client };
}
const readC150 = (id) => store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[id];
const readRF = (id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];

// ---------- Ledger ----------

test("LEDGER: Schwellen aus OFFERS (75/240); Zahlung nur gegen echte order_id; Betrag/Währung/Quelle fail closed", () => {
  assert.equal(paymentThresholdChf("REPAIR_CHECK_150"), OFFERS.REPAIR_CHECK_150.price / 2);
  assert.equal(paymentThresholdChf("REPAIR_CHECK_150"), 75);
  assert.equal(paymentThresholdChf("REPAIR_FIX_500"), 240);
  assert.equal(paymentThresholdChf("REDESIGN_2490"), null, "unbekanntes Angebot hat nie eine Schwelle");
  // Keine Zahlung ohne existierenden Auftrag – nichts wird erraten oder angelegt.
  for (const bad of ["CA150-20261012-ffffff", "muster.ch", "", undefined, "RF480-xx"])
    assert.throws(() => recordPayment(store, { order_id: bad, amount_chf: 75, now: T0 }), /order_id/);
  const o = c150Order();
  assert.deepEqual(findPayableOrder(store, o.order_id)?.offer_class, "REPAIR_CHECK_150");
  for (const bad of [0, -5, "abc", NaN, 99_999, undefined]) assert.throws(() => recordPayment(store, { order_id: o.order_id, amount_chf: bad, now: T0 }), /Betrag/);
  assert.throws(() => recordPayment(store, { order_id: o.order_id, amount_chf: 75, currency: "EUR", now: T0 }), /Nur CHF/);
  assert.throws(() => recordPayment(store, { order_id: o.order_id, amount_chf: 75, source: "Bank Überweisung!", now: T0 }), /Quelle/);
  assert.equal(Object.keys(store.read(PAYMENTS_FILE, { payments: {} }).payments).length, 0, "fehlgeschlagene Buchungen hinterlassen nichts");
  // Erfolgreiche Buchung: alle Pflichtfelder, an Auftrag UND Domain nachvollziehbar gebunden.
  const p = recordPayment(store, { order_id: o.order_id, amount_chf: 50, reference: "Bank", now: T0 });
  assert.deepEqual([p.order_id, p.domain, p.offer_class, p.amount_chf, p.currency, p.status, p.source, p.reference],
    [o.order_id, "muster.ch", "REPAIR_CHECK_150", 50, "CHF", "RECEIVED", "bank_transfer", "Bank"]);
  assert.ok(p.payment_id.startsWith("PAY-") && p.received_at && p.created_at);
  assert.deepEqual(PAYMENT_STATUS, ["RECEIVED", "VOIDED", "REFUNDED"]);
});

test("LEDGER: kumulativ je ORDER_ID (nie nur Domain); void/refund markieren nur (nie löschen) und zählen nicht mehr", () => {
  sale150();
  const o1 = c150Order();
  // Zweiter Auftrag derselben Firma (anderer Workflow) – Zahlungen bleiben sicher getrennt.
  const o2 = createRepairOrder(store, { domain: "muster.ch", website: HOME, now: T0 });
  recordPayment(store, { order_id: o1.order_id, amount_chf: 40, now: T0 });
  const p2 = recordPayment(store, { order_id: o1.order_id, amount_chf: 35, now: T0 });
  recordPayment(store, { order_id: o2.order_id, amount_chf: 240, now: T0 });
  assert.equal(paidChf(store, o1.order_id), 75);
  assert.equal(paidChf(store, o2.order_id), 240);
  assert.equal(paymentsForOrder(store, o1.order_id).length, 2);
  assert.equal(paymentGateForOrder(store, o1).satisfied, true);
  // Void: Pflicht-Grund, nur RECEIVED, Original bleibt vollständig erhalten – zählt aber nirgends mehr.
  assert.throws(() => voidPayment(store, p2.payment_id, { now: T0 }), /--reason/);
  assert.throws(() => voidPayment(store, "PAY-99999999-ffffffff", { reason: "x", now: T0 }), /Keine Zahlung/);
  const v = voidPayment(store, p2.payment_id, { reason: "Fehlbuchung Testlauf", now: T0 });
  assert.deepEqual([v.status, v.amount_chf, v.order_id, !!v.voided_at, v.voided_reason], ["VOIDED", 35, o1.order_id, true, "Fehlbuchung Testlauf"]);
  assert.throws(() => voidPayment(store, p2.payment_id, { reason: "nochmal", now: T0 }), /bereits VOIDED/);
  assert.throws(() => refundPayment(store, p2.payment_id, { reason: "auch nicht", now: T0 }), /bereits VOIDED/);
  assert.equal(paidChf(store, o1.order_id), 40, "voided zählt nicht mehr");
  assert.equal(paymentGateForOrder(store, o1).satisfied, false);
  assert.equal(Object.keys(store.read(PAYMENTS_FILE, { payments: {} }).payments).length, 3, "nie ein Eintrag gelöscht");
  const s = paymentsStatus(dir);
  assert.deepEqual([s.total, s.received, s.voided, s.refunded, s.received_chf], [3, 2, 1, 0, 280]);
});

// ---------- CHF-150-Gate ----------

test("CHF-150: bestätigter Auftrag ohne/mit zu wenig Zahlung → BLOCKED_PAYMENT_NOT_RECEIVED, 0 Audit, 0 Gmail; ab CHF 75 automatisch bis zum Versand", async () => {
  sale150();
  const o = c150Order();
  const gmail = fakeGmail(), auditor = fakeAuditor();
  const eng = createCheck150Engine({ store, gmail, auditor, now: () => T0 });
  await eng.processAll();
  assert.equal(readC150(o.order_id).state, "BLOCKED_PAYMENT_NOT_RECEIVED");
  assert.deepEqual([auditor.calls.length, gmail.calls.length], [0, 0], "vor der Schwelle keine bezahlte Leistung");
  // Teilzahlung unter der Schwelle genügt nicht – der Zahlungsstand wird am Auftrag nachgeführt.
  recordPayment(store, { order_id: o.order_id, amount_chf: 50, now: T0 });
  await eng.processAll();
  assert.equal(readC150(o.order_id).state, "BLOCKED_PAYMENT_NOT_RECEIVED");
  assert.deepEqual(readC150(o.order_id).payment, { order_id: o.order_id, offer_class: "REPAIR_CHECK_150", required_chf: 75, paid_chf: 50, satisfied: false });
  assert.equal(check150Status(dir).waiting_payment, 1);
  assert.equal(auditor.calls.length, 0);
  // Restzahlung → kumulativ 75 → Check, Bericht, Entwurf und automatischer Versand an den bestätigten Kunden.
  recordPayment(store, { order_id: o.order_id, amount_chf: 25, now: T0 });
  await eng.processAll();
  const saved = readC150(o.order_id);
  assert.deepEqual([saved.state, saved.delivery_status, saved.automatic_send_allowed], ["COMPLETED", "sent", true]);
  assert.equal(auditor.calls.length, 1);
  assert.deepEqual(gmail.calls.map((c) => c.op), ["create", "SEND"]);
  assert.equal(gmail.calls[0].to, "auftrag@muster.ch");
  assert.deepEqual([publicCheck150Orders(dir).orders[0].paid_chf, publicCheck150Orders(dir).orders[0].payment_ok], [75, true]);
});

test("CHF-150: Re-Check unmittelbar vor dem Versand – voided Zahlung stoppt den Versand; Send-Fehler → Entwurf bleibt fail safe für Chris", async () => {
  // a) Zahlung wird nach dem Bericht, aber vor dem Versand storniert → kein Send, zurück zu BLOCKED_PAYMENT_NOT_RECEIVED.
  sale150();
  const o = c150Order();
  const p = recordPayment(store, { order_id: o.order_id, amount_chf: 75, now: T0 });
  const gmail = fakeGmail();
  const eng = createCheck150Engine({ store, gmail, auditor: fakeAuditor(), now: () => T0 });
  // bis zum Entwurf laufen lassen, dann Zahlung voiden: der DELIVERY_SENDING-Schritt muss den Versand verweigern.
  const sendOps = () => gmail.calls.filter((c) => c.op === "SEND").length;
  const origSend = gmail.sendDraft;
  gmail.sendDraft = async (id) => { throw new Error("Gmail POST /drafts/send: 429 rateLimitExceeded"); }; // 1. Lauf: transient
  await eng.processAll();
  assert.equal(readC150(o.order_id).state, "DELIVERY_SENDING", "transienter Fehler → Zustand bleibt, Retry im nächsten Lauf");
  voidPayment(store, p.payment_id, { reason: "Rückbuchung", now: T0 });
  gmail.sendDraft = origSend;
  await eng.processAll();
  assert.equal(readC150(o.order_id).state, "BLOCKED_PAYMENT_NOT_RECEIVED", "voided Zahlung → kein Versand");
  assert.equal(sendOps(), 0, "Service-Mail wurde nie gesendet");
  // b) dauerhafter Send-Fehler → READY_FOR_DELIVERY, Entwurf bleibt für Chris (kein Datenverlust, kein Blind-Retry).
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pay-b-"));
  const store2 = createStore(dir2);
  store2.write("sales.json", store.read("sales.json", {}));
  const o2 = createCheck150Order(store2, { domain: "muster.ch", website: HOME, delivery_email: "auftrag@muster.ch", now: T0 });
  recordPayment(store2, { order_id: o2.order_id, amount_chf: 80, now: T0 });
  const g2 = fakeGmail({ failSend: "Invalid to header" });
  await createCheck150Engine({ store: store2, gmail: g2, auditor: fakeAuditor(), now: () => T0 }).processAll();
  const s2 = store2.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o2.order_id];
  assert.deepEqual([s2.state, s2.delivery_status, !!s2.delivery_draft?.draft_id], ["READY_FOR_DELIVERY", "draft_ready", true]);
});

test("CHF-150: Send-Idempotenz + Pflichtbedingungen – unklarer Vorversuch, abweichende Adresse, fehlender Bericht-Hash → nie Auto-Send", async () => {
  sale150();
  const o = c150Order();
  recordPayment(store, { order_id: o.order_id, amount_chf: 75, now: T0 });
  const gmail = fakeGmail();
  const eng = createCheck150Engine({ store, gmail, auditor: fakeAuditor(), now: () => T0 });
  // Bis DELIVERY_SENDING laufen lassen (transienter Send-Fehler hält den Zustand), Marker wird dabei wieder freigegeben.
  const origSend = gmail.sendDraft;
  gmail.sendDraft = async () => { throw new Error("Gmail POST /drafts/send: 503 backendError"); };
  await eng.processAll();
  let s = readC150(o.order_id);
  assert.deepEqual([s.state, s.delivery_send_attempted_at ?? null], ["DELIVERY_SENDING", null]);
  assert.equal(s.delivery_draft.message_class, "CUSTOMER_ORDER_FULFILLMENT");
  // a) Absturz mitten im Versand simuliert (Marker gesetzt, kein Ergebnis) → kein zweiter Versand, Übergabe an Chris.
  const data = store.read(CHECK150_ORDERS_FILE, { orders: {} });
  data.orders[o.order_id].delivery_send_attempted_at = T0.toISOString();
  store.write(CHECK150_ORDERS_FILE, data);
  gmail.sendDraft = origSend;
  await eng.processAll();
  s = readC150(o.order_id);
  assert.deepEqual([s.state, s.delivery_status], ["READY_FOR_DELIVERY", "draft_ready"]);
  assert.ok(/Versandstatus unklar/.test(s.state_history.at(-1).reason));
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 0);
  // b) Lieferadresse weicht vom Entwurf ab bzw. Berichts-Hash fehlt → Übergabe an Chris, kein Versand.
  for (const patch of [{ delivery_email: "andere@muster.ch" }, { report_text_hash: null }]) {
    const d2 = store.read(CHECK150_ORDERS_FILE, { orders: {} });
    Object.assign(d2.orders[o.order_id], { state: "DELIVERY_SENDING", delivery_send_attempted_at: null }, patch);
    store.write(CHECK150_ORDERS_FILE, d2);
    await eng.processAll();
    assert.equal(readC150(o.order_id).state, "READY_FOR_DELIVERY");
    const d3 = store.read(CHECK150_ORDERS_FILE, { orders: {} });
    Object.assign(d3.orders[o.order_id], { delivery_email: "auftrag@muster.ch", report_text_hash: s.report_text_hash });
    store.write(CHECK150_ORDERS_FILE, d3);
  }
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 0, "keine einzige automatische Mail bei unvollständigen Bedingungen");
  // c) Alles erfüllt → genau EIN Versand mit Nachrichtenklasse CUSTOMER_ORDER_FULFILLMENT.
  const d4 = store.read(CHECK150_ORDERS_FILE, { orders: {} });
  Object.assign(d4.orders[o.order_id], { state: "DELIVERY_SENDING", delivery_send_attempted_at: null });
  store.write(CHECK150_ORDERS_FILE, d4);
  await eng.processAll();
  await eng.processAll();
  s = readC150(o.order_id);
  assert.deepEqual([s.state, s.delivery_status, s.delivery_message_class], ["COMPLETED", "sent", "CUSTOMER_ORDER_FULFILLMENT"]);
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 1);
});

test("CHF-150: storniert (CANCELLED) oder voided Verkauf → auch mit CHF 75 kein Audit, keine Mail", async () => {
  const { cancelCheck150Order } = await import("../check-150-workflow.js");
  sale150();
  const o = c150Order();
  recordPayment(store, { order_id: o.order_id, amount_chf: 150, now: T0 });
  cancelCheck150Order(store, o.order_id, { reason: "Testauftrag", now: T0 });
  const gmail = fakeGmail(), auditor = fakeAuditor();
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll();
  assert.equal(readC150(o.order_id).state, "CANCELLED");
  assert.deepEqual([auditor.calls.length, gmail.calls.length], [0, 0]);
});

// ---------- CHF-480-Gate + sichere Zugangs-Anfrage ----------

test("CHF-480: mit Freigabe aber ohne CHF 480 → PAYMENT_REQUIRED – kein Adapter-Aufruf, keine Zugangs-Anfrage, keine Änderung", async () => {
  const o = rfOrder();
  authorize(o.order_id);
  const adapter = fakeAdapter();
  const gmail = fakeGmail();
  const eng = createRepairEngine({ store, adapters: { static: adapter }, auditor: fakeAuditor(), gmail, onboardingDir: dir, now: () => T0 });
  await eng.processAll();
  assert.equal(readRF(o.order_id).state, "PAYMENT_REQUIRED");
  assert.deepEqual(readRF(o.order_id).payment, { order_id: o.order_id, offer_class: "REPAIR_FIX_500", required_chf: 480, paid_chf: 0, satisfied: false });
  assert.deepEqual([adapter.calls.checkAccess, adapter.calls.backup, adapter.calls.applyFix, gmail.calls.length], [0, 0, 0, 0],
    "vor CHF 480: kein Zugang, kein Login, keine Anfrage, keine Reparatur");
  // Eine Anzahlung genügt nicht; erst kumulativ CHF 480 startet den Erfüllungsworkflow.
  recordPayment(store, { order_id: o.order_id, amount_chf: 200, now: T0 });
  await eng.processAll();
  assert.equal(readRF(o.order_id).state, "PAYMENT_REQUIRED");
  assert.equal(repairOrdersStatus(dir).waiting_payment, 1);
  recordPayment(store, { order_id: o.order_id, amount_chf: 280, now: T0 });
  await eng.processAll();
  const saved = readRF(o.order_id);
  assert.ok(!["PAYMENT_REQUIRED", "ORDER_RECEIVED", "AUTHORIZATION_REQUIRED"].includes(saved.state), "nach der Schwelle läuft der Bestandsworkflow");
  assert.ok(adapter.calls.checkAccess >= 1);
  assert.ok(saved.state_history.some((h) => h.to === "ACCESS_CHECK" && /Zahlungsschwelle erfüllt/.test(h.reason)));
});

test("CHF-480: nach Vollzahlung ohne konfigurierten Zugang → genau EINE automatische Bitte um SICHEREN Zugang; Zugang konfiguriert → läuft weiter", async () => {
  const o = rfOrder();
  authorize(o.order_id);
  recordPayment(store, { order_id: o.order_id, amount_chf: 480, now: T0 });
  const gmail = fakeGmail();
  // Zugangsweg vorhanden, aber Zugangsprüfung schlägt fehl (ok:false) – entspricht «noch kein sicherer Zugang erhalten».
  const { client, blobs } = cloudIntake();
  const eng = createRepairEngine({ store, adapters: { static: fakeAdapter({ ok: false }) }, auditor: fakeAuditor(), gmail, intake: client, now: () => T0 });
  await eng.processAll();
  let saved = readRF(o.order_id);
  assert.equal(saved.state, "ACCESS_REQUESTED");
  assert.equal(saved.access_request.message_class, "CUSTOMER_ACCESS_REQUEST");
  assert.ok(/^[0-9a-f]{64}$/.test(saved.access_request.token_hash) && saved.access_request.expires_at, "nur der Token-HASH wird gespeichert");
  assert.equal((await blobs.list("t/")).length, 1, "genau EIN sicherer Link registriert");
  assert.deepEqual([saved.access_request.to, !!saved.access_request.sent_at], ["kunde@muster.ch", true]);
  const creates = gmail.calls.filter((c) => c.op === "create");
  assert.equal(creates.length, 1, "genau EINE Zugangs-Anfrage");
  assert.equal(creates[0].to, "kunde@muster.ch");
  assert.ok(creates[0].subject.includes("muster.ch") && /sicherer Zugang/i.test(creates[0].subject));
  assert.ok(creates[0].body.includes("KEINE Passwörter per E-Mail"), "Passwörter werden nie per Mail erfragt");
  assert.ok(/Hosting-Anbieter/.test(creates[0].body) && /einladen|Zugriffsberechtigung/i.test(creates[0].body), "sichere Freigabewege erklärt");
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 1);
  // Weitere Läufe: KEINE zweite Anfrage (kein Spam), Auftrag wartet.
  await eng.processAll();
  await eng.processAll();
  assert.equal(gmail.calls.filter((c) => c.op === "create").length, 1);
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 1);
  assert.equal(repairOrdersStatus(dir).access_requested, 1);
  // Chris konfiguriert den sicher erhaltenen Zugang → Auftrag läuft automatisch weiter (Backup zuerst).
  const adapter = fakeAdapter();
  const eng2 = createRepairEngine({ store, adapters: { static: adapter }, auditor: fakeAuditor(), gmail, intake: client, now: () => T0 });
  await eng2.processAll();
  saved = readRF(o.order_id);
  assert.ok(saved.state_history.some((h) => h.to === "BACKUP" && /Sicherer Zugang erhalten/.test(h.reason)));
  assert.ok(adapter.calls.backup >= 1, "nach sicherem Zugang beginnt der Bestandsworkflow mit dem Backup");
  // Ohne Kundenadresse (oder ohne gmail) bleibt das Bestandsverhalten: fail closed BLOCKED_NO_ACCESS.
  const o2 = createRepairOrder(store, { domain: "andere.ch", website: "https://andere.ch/", now: T0 });
  authorizeRepair(store, o2.order_id, { authorized_domain: "andere.ch", source: "customer_order_form", now: T0 });
  recordPayment(store, { order_id: o2.order_id, amount_chf: 480, now: T0 });
  await createRepairEngine({ store, adapters: {}, auditor: fakeAuditor(), gmail: null, now: () => T0 }).processAll();
  assert.equal(readRF(o2.order_id).state, "BLOCKED_NO_ACCESS");
});

test("CHF-480: buildAccessRequestMail ohne interne IDs/Secrets; Dashboard zeigt Zahlungsstand als Zahlen (cleanRepair-Whitelist)", async () => {
  const o = rfOrder();
  const link = "https://jarvis.test/access.html#t=" + "A".repeat(43);
  const mail = buildAccessRequestMail(o, { link, expires_at: "2026-10-15T12:00:00.000Z" });
  assert.ok(mail.subject.includes("muster.ch"));
  assert.equal(mail.message_class, "CUSTOMER_ACCESS_REQUEST");
  for (const verboten of [o.order_id, "Token", "Adapter", "github", "Passwort senden", "Angebot", "Rabatt", "jetzt bestellen"]) assert.ok(!mail.body.includes(verboten), `Zugangs-Anfrage enthält "${verboten}"`);
  // Pflichtinhalte: erste Teilzahlung eingegangen, temporärer sicherer Zugang, keine Passwörter per Mail, orderspezifischer Link,
  // temporärer Benutzer mit minimalen Rechten.
  for (const pflicht of ["vollständige Zahlung von CHF 480", "temporären, sicheren Zugang", "KEINE Passwörter per E-Mail", link, "nur einmal verwendbar", "temporären Benutzer mit nur den nötigen Rechten"])
    assert.ok(mail.body.includes(pflicht), `Zugangs-Anfrage ohne "${pflicht}"`);
  authorize(o.order_id);
  recordPayment(store, { order_id: o.order_id, amount_chf: 100, reference: "Bank Teilzahlung", now: T0 });
  await createRepairEngine({ store, adapters: {}, auditor: fakeAuditor(), now: () => T0 }).processAll();
  const pub = publicRepairOrders(dir);
  assert.deepEqual([pub.orders[0].state, pub.orders[0].paid_chf, pub.orders[0].payment_required_chf, pub.orders[0].payment_ok, pub.orders[0].access_requested],
    ["PAYMENT_REQUIRED", 100, 240, false, false]);
  const raw = JSON.stringify(pub);
  for (const verboten of ["Teilzahlung", "payment_id", "kunde@muster.ch", "reference"]) assert.ok(!raw.includes(verboten), `Dashboard-Sicht enthält "${verboten}"`);
  const cleaned = cleanRepair({ ...pub, orders: [{ ...pub.orders[0], token: "geheim" }] });
  assert.deepEqual([cleaned.orders[0].state, cleaned.orders[0].paid_chf, cleaned.orders[0].payment_ok], ["PAYMENT_REQUIRED", 100, false]);
  assert.equal(cleaned.waiting_payment, 1);
  assert.ok(!JSON.stringify(cleaned).includes("geheim"));
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.ok(html.includes('id="repUnpaid"') && html.includes("ZUGANG BEIM KUNDEN ANGEFRAGT"), "HUD kennt Zahlungs-/Zugangszustände");
});

// ---------- CLI ----------

test("CLI: payments.js record/status/void Ende-zu-Ende; Worker übergibt gmail an beide Workflows", () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pay-sec-"));
  const wdir = path.join(secrets, "mail_worker");
  fs.mkdirSync(wdir, { recursive: true });
  const wstore = createStore(wdir);
  const o = createCheck150Order(wstore, { domain: "muster.ch", website: HOME, delivery_email: "auftrag@muster.ch", now: T0 });
  const env = { ...process.env, JARVIS_SECRETS_DIR: secrets };
  const run = (...args) => execFileSync(process.execPath, ["payments.js", ...args], { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" });
  // Unbekannte order_id → Fehler, nichts verbucht.
  assert.throws(() => run("record", "CA150-20261012-ffffff", "--amount", "75"));
  const out = run("record", o.order_id, "--amount", "75", "--currency", "CHF", "--reference", "Bank");
  assert.ok(out.includes("Zahlung verbucht") && out.includes("SCHWELLE ERFÜLLT"));
  assert.ok(run("status", o.order_id).includes("CHF 75 von mind. CHF 75"));
  const pid = Object.keys(wstore.read(PAYMENTS_FILE, { payments: {} }).payments)[0];
  assert.throws(() => run("void", pid), /./); // Grund ist Pflicht
  assert.ok(run("void", pid, "--reason", "Testbuchung").includes("VOIDED"));
  assert.ok(run("status", o.order_id).includes("WARTET AUF ZAHLUNG"));
  assert.equal(Object.keys(wstore.read(PAYMENTS_FILE, { payments: {} }).payments).length, 1, "nie gelöscht");
  // Verdrahtung: der Worker gibt gmail an beide Workflows weiter (Zugangs-Anfrage + automatischer Service-Mail-Versand).
  const mw = fs.readFileSync(path.join(ROOT, "mail-worker.js"), "utf8");
  assert.ok(mw.includes("runRepairOrders({ gmail, intake: accessMod.intakeClient({ config: shared.syncConfig() }), log })") && mw.includes("runCheck150Orders({ gmail, log })"));
});

// ---------- Zahlungsstatus-Matrix (Abschnitt 19) ----------

test("PAYMENT STATES: CHF 150 (0/74/75/150, 25+25+25) und CHF 480 (0/239/240/480, 100+140); Preis/Deposit aus OFFERS; Duplikat-Referenz zählt einmal", async () => {
  const { paymentSummary } = await import("../payments.js");
  const states = (o, steps) => steps.map((chf, i) => { if (chf) recordPayment(store, { order_id: o.order_id, amount_chf: chf, reference: `${o.order_id}-${i}`, now: T0 });
    const s = paymentSummary(store, o); return [s.paid_chf, s.payment_status, paymentGateForOrder(store, o).satisfied]; });
  const a = c150Order();
  assert.deepEqual(states(a, [0, 74, 1, 75]), [[0, "UNPAID", false], [74, "PARTIAL", false], [75, "DEPOSIT_MET", true], [150, "PAID_FULL", true]]);
  const s150 = paymentSummary(store, a);
  assert.deepEqual([s150.price_chf, s150.deposit_chf, s150.rest_to_deposit_chf], [OFFERS.REPAIR_CHECK_150.price, 75, 0]);
  const b = createCheck150Order(store, { domain: "zweite.ch", website: "https://zweite.ch/", delivery_email: "a@zweite.ch", now: T0 });
  assert.deepEqual(states(b, [25, 25, 25]).map((x) => x[1]), ["PARTIAL", "PARTIAL", "DEPOSIT_MET"]);
  const r = rfOrder();
  assert.deepEqual(states(r, [0, 239, 1, 240]), [[0, "UNPAID", false], [239, "PARTIAL", false], [240, "DEPOSIT_MET", true], [480, "PAID_FULL", true]]);
  assert.deepEqual([paymentSummary(store, r).price_chf, paymentSummary(store, r).deposit_chf], [480, 240], "kein CHF-500-Preis");
  const r2 = createRepairOrder(store, { domain: "dritte.ch", website: "https://dritte.ch/", now: T0 });
  assert.equal(states(r2, [100, 140]).at(-1)[1], "DEPOSIT_MET");
  assert.equal(paymentSummary(store, r2).rest_to_deposit_chf, 0);
  // Duplikatschutz: gleiche Referenz (auch anders geschrieben) zählt nie doppelt – nach void wieder frei.
  const d = createCheck150Order(store, { domain: "vierte.ch", website: "https://vierte.ch/", delivery_email: "a@vierte.ch", now: T0 });
  const p1 = recordPayment(store, { order_id: d.order_id, amount_chf: 75, reference: "ZKB 2026-10-12 #77", now: T0 });
  assert.throws(() => recordPayment(store, { order_id: d.order_id, amount_chf: 75, reference: "  zkb 2026-10-12   #77 ", now: T0 }), /Doppelte Zahlungsreferenz/);
  assert.throws(() => recordPayment(store, { order_id: r.order_id, amount_chf: 75, reference: "ZKB 2026-10-12 #77", now: T0 }), /Doppelte/, "auch auftragsübergreifend");
  assert.equal(paidChf(store, d.order_id), 75);
  voidPayment(store, p1.payment_id, { reason: "falscher Auftrag", now: T0 });
  assert.ok(recordPayment(store, { order_id: d.order_id, amount_chf: 75, reference: "ZKB 2026-10-12 #77", now: T0 }));
  // REFUNDED: vollständig zurückerstattet.
  const e = createCheck150Order(store, { domain: "fuenfte.ch", website: "https://fuenfte.ch/", delivery_email: "a@fuenfte.ch", now: T0 });
  const pe = recordPayment(store, { order_id: e.order_id, amount_chf: 75, now: T0 });
  refundPayment(store, pe.payment_id, { reason: "Kunde storniert", now: T0 });
  assert.equal(paymentSummary(store, e).payment_status, "REFUNDED");
});

// ---------- CHF-150 E2E (Abschnitt 20) ----------

test("CHF-150 E2E: confirmed+74 → 0 Audit/0 Send; +1 → genau 1 CUSTOMER_ORDER_FULFILLMENT; Neustart → weiterhin 1; voided Sale und Refund unter 75 → 0 Send", async () => {
  sale150();
  const o = c150Order();
  recordPayment(store, { order_id: o.order_id, amount_chf: 74, now: T0 });
  const gmail = fakeGmail(), auditor = fakeAuditor();
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll();
  assert.deepEqual([readC150(o.order_id).state, auditor.calls.length, gmail.calls.length], ["BLOCKED_PAYMENT_NOT_RECEIVED", 0, 0]);
  assert.equal(publicCheck150Orders(dir).orders[0].phase, "WAITING_FOR_DEPOSIT");
  assert.equal(publicCheck150Orders(dir).orders[0].rest_to_deposit_chf, 1);
  recordPayment(store, { order_id: o.order_id, amount_chf: 1, now: T0 });
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll();
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll(); // «Worker-Neustart»
  const saved = readC150(o.order_id);
  assert.deepEqual([saved.state, saved.delivery_message_class, saved.delivery_draft.message_class], ["COMPLETED", "CUSTOMER_ORDER_FULFILLMENT", "CUSTOMER_ORDER_FULFILLMENT"]);
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 1, "exakt 1 Send auch nach Neustart");
  assert.equal(auditor.calls.length, 1);
  assert.equal(publicCheck150Orders(dir).orders[0].phase, "SENT");
  // Voided Sale (TF-040) → auch mit CHF 150 kein Audit, kein Send.
  const dv = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pay-v-")); const sv = createStore(dv);
  sv.write("sales.json", { records: { "muster.ch": { status: "customer", sale: { selected_offer: "REPAIR_CHECK_150", sale_value: 150, sale_date: "2026-10-12", sale_status: "voided", voided: true } } } });
  const ov = createCheck150Order(sv, { domain: "muster.ch", website: HOME, delivery_email: "auftrag@muster.ch", now: T0 });
  recordPayment(sv, { order_id: ov.order_id, amount_chf: 150, now: T0 });
  const gv = fakeGmail(), av = fakeAuditor();
  await createCheck150Engine({ store: sv, gmail: gv, auditor: av, now: () => T0 }).processAll();
  assert.deepEqual([sv.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[ov.order_id].state, av.calls.length, gv.calls.length], ["BLOCKED_ORDER_NOT_CONFIRMED", 0, 0]);
  // Refund unter 75 vor der Verarbeitung → 0 Audit, 0 Send.
  const dr = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pay-r-")); const sr = createStore(dr);
  sr.write("sales.json", store.read("sales.json", {}));
  const or = createCheck150Order(sr, { domain: "muster.ch", website: HOME, delivery_email: "auftrag@muster.ch", now: T0 });
  const pr = recordPayment(sr, { order_id: or.order_id, amount_chf: 75, now: T0 });
  refundPayment(sr, pr.payment_id, { reason: "Rückerstattung", now: T0 });
  const gr = fakeGmail(), ar = fakeAuditor();
  await createCheck150Engine({ store: sr, gmail: gr, auditor: ar, now: () => T0 }).processAll();
  assert.deepEqual([sr.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[or.order_id].state, ar.calls.length, gr.calls.length], ["BLOCKED_PAYMENT_NOT_RECEIVED", 0, 0]);
});

// ---------- Cold Outreach unverändert (Abschnitt 23) ----------

test("COLD OUTREACH unverändert: COLD_LEAD_DRAFT_ONLY bleibt unsendbar; automatisch sendbar sind nur die zwei Service-Klassen", async () => {
  const g = await import("../gmail.js");
  // TF-066: dritte transaktionale Klasse für den Auftragsdialog (nur im gebundenen Auftrags-Thread, nie Cold/Marketing).
  assert.deepEqual(g.SERVICE_MESSAGE_CLASSES, ["CUSTOMER_ORDER_FULFILLMENT", "CUSTOMER_ACCESS_REQUEST", "CUSTOMER_ONBOARDING_DIALOGUE", "CUSTOMER_PAYMENT_REQUEST"]);
  assert.equal(g.COLD_DRAFT_MODE, "COLD_LEAD_DRAFT_ONLY");
  assert.throws(() => g.assertSendable("d1", { drafts: { d1: { mode: "COLD_LEAD_DRAFT_ONLY" } } }), /nie/);
  const src = fs.readFileSync(path.join(ROOT, "gmail.js"), "utf8");
  assert.ok(src.includes("!cold.mode && SERVICE_MESSAGE_CLASSES.includes(fields.messageClass)"), "Service-Klasse nie an einem Cold-Entwurf");
  const sr = await import("../swiss-repair.js");
  const cold = sr.COLD_MODE;
  assert.equal(cold, "COLD_LEAD_DRAFT_ONLY");
});
