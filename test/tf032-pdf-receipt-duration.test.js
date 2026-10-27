// TF-032 – synthetische PDF-Quittung, Mailanlage und Bearbeitungsdauer.
// Keine echten Empfänger, Zahlungen, Websites oder externen Provider-Aufrufe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import * as artifacts from "../completion-artifacts.js";
import { buildCheckIntroMail } from "../onboarding-core.js";
import { buildAccessRequestMail } from "../repair-workflow.js";
import { createOutboxMailer, processRepairOutbox } from "../repair-outbox.js";
import { rawMessage } from "../gmail.js";

const feature = (name) => {
  const fn = artifacts[name];
  assert.equal(typeof fn, "function", `TF-032-Schnittstelle fehlt: ${name}`);
  return fn;
};
const { MANUAL_REVIEW_REQUIRED, RECEIPT_READY } = artifacts;

const NOW = new Date("2026-10-27T10:00:00.000Z");

function fixture({ address = true, amount = 480, currency = "CHF", provider_mode = "TEST" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf032-"));
  const store = createStore(dir);
  if (address) store.write("config.json", { business_profile: { address: {
    street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH",
  } } });
  const order = {
    order_id: "RF480-20261027-abcdef", offer_class: "REPAIR_FIX_500", market: "CH", currency: "CHF", price_chf: 480,
    test_order: true, environment: "TEST", test_run_id: "e2e-abcdef123456", domain: "synthetic.example",
    website: "https://synthetic.example/", company: "Synthetic AG", contact_name: "Frau Test", delivery_email: "test@synthetic.example",
    state: "COMPLETED", completion: { kind: "FULL" }, validation: { build_ok: true }, retest: { http_ok: true },
    browser_gate: { required: false }, issues: { one: { customer_text: "Der Kontaktlink war nicht erreichbar.", repair_status: "repaired", solution_summary: "Der Kontaktlink wurde korrigiert." } },
  };
  store.write("repair_orders.json", { schema: 1, orders: { [order.order_id]: order } });
  recordPayment(store, { order_id: order.order_id, amount, currency: "CHF", provider_mode: "TEST", source: "stripe_test_fixture", reference: `tf032-${amount}-${currency}`, received_at: NOW, now: NOW });
  if (currency !== "CHF" || provider_mode !== "TEST") {
    const ledger = store.read("payments.json", { payments: {} });
    const payment = Object.values(ledger.payments)[0];
    if (currency !== "CHF") payment.currency = currency;
    if (provider_mode !== "TEST") { payment.provider_mode = provider_mode; delete payment.is_test; }
    store.write("payments.json", ledger);
  }
  return { dir, store, order };
}

function cleanUp(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test("TF-032: berechtigte CHF-480-Zahlung erzeugt eine deterministische PDF-Quittung", async () => {
  const { dir, store, order } = fixture();
  try {
    const buildRepairReceipt = feature("buildRepairReceipt");
    const receipt = await buildRepairReceipt(store, order.order_id, { now: NOW });
    assert.equal(receipt.status, RECEIPT_READY);
    assert.equal(receipt.paid_amount_chf, 480);
    assert.equal(receipt.fully_paid, true);
    assert.match(receipt.text, /Helvetic Webdesign/);
    assert.match(receipt.text, /Christoph Kälin/);
    assert.match(receipt.text, /CHF 480\.00/);
    assert.match(receipt.text, /Nicht mehrwertsteuerpflichtig/);
    assert.equal(receipt.pdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal(receipt.attachment.mimeType, "application/pdf");
    assert.equal(receipt.attachment.filename, `quittung-${receipt.receipt_number}.pdf`);
    assert.equal((await buildRepairReceipt(store, order.order_id, { now: NOW })).receipt_number, receipt.receipt_number);
  } finally { cleanUp(dir); }
});

test("TF-032: fehlende Pflichtdaten oder falsche Ledgerdaten blockieren PDF und Abschlussmail", async () => {
  const buildRepairReceipt = feature("buildRepairReceipt");
  const buildRepairCompletionMail = feature("buildRepairCompletionMail");
  for (const options of [{ address: false }, { amount: 479 }, { amount: 481 }, { currency: "EUR" }, { provider_mode: "LIVE" }]) {
    const { dir, store, order } = fixture(options);
    try {
      const receipt = await buildRepairReceipt(store, order.order_id, { now: NOW });
      if (options.amount === 479) assert.equal(receipt.status, artifacts.PARTIAL_PAYMENT, JSON.stringify(options));
      else assert.equal(receipt.status, MANUAL_REVIEW_REQUIRED, JSON.stringify(options));
      assert.equal(receipt.pdf, null, JSON.stringify(options));
      const mail = buildRepairCompletionMail(order, { receipt });
      assert.equal(mail.status, MANUAL_REVIEW_REQUIRED, JSON.stringify(options));
      assert.equal(mail.attachments?.length || 0, 0, JSON.stringify(options));
    } finally { cleanUp(dir); }
  }
});

test("TF-032: CHF-480-Abschlussmail enthält genau die verifizierte PDF-Anlage und keine offene Lieferprognose", async () => {
  const { dir, store, order } = fixture();
  try {
    const buildRepairReceipt = feature("buildRepairReceipt");
    const buildRepairCompletionMail = feature("buildRepairCompletionMail");
    const receipt = await buildRepairReceipt(store, order.order_id, { now: NOW });
    const mail = buildRepairCompletionMail(order, { receipt });
    assert.equal(mail.status, RECEIPT_READY);
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].filename, `quittung-${receipt.receipt_number}.pdf`);
    assert.equal(mail.attachments[0].content, receipt.pdf);
    assert.doesNotMatch(mail.body, /voraussichtliche Bearbeitungsdauer/i);
  } finally { cleanUp(dir); }
});

test("TF-032: Bearbeitungsdauer zeigt vier unverbindliche, statusabhängige Phasen", () => {
  const buildProcessingDurationEstimate = feature("buildProcessingDurationEstimate");
  const waiting = buildProcessingDurationEstimate({ offer_class: "REPAIR_FIX_500", state: "ORDER_RECEIVED", access_request: null }, { now: NOW });
  assert.deepEqual(Object.keys(waiting.phases), ["customer_access", "technical_work", "quality_control", "completion_delivery"]);
  assert.match(waiting.text, /unverbindlich/i);
  assert.match(waiting.phases.customer_access, /offen|entfällt/i);
  const complete = buildProcessingDurationEstimate({ state: "COMPLETED", delivery: { sent_at: NOW.toISOString() }, access_intake: { status: "RECEIVED" } }, { now: NOW });
  assert.match(complete.phases.technical_work, /abgeschlossen/i);
  assert.match(complete.phases.quality_control, /abgeschlossen/i);
  assert.match(complete.phases.completion_delivery, /abgeschlossen/i);
  assert.match(buildCheckIntroMail({ domain: "synthetic.example", state: "ORDER_RECEIVED" }).body, /Bearbeitungsdauer/i);
  assert.match(buildAccessRequestMail({ offer_class: "REPAIR_FIX_500", state: "ORDER_RECEIVED", domain: "synthetic.example" }, { link: "https://jarvis.test/access.html#t=tf032" }).body, /Bearbeitungsdauer/i);
});

test("TF-032: PDF-Anlage bleibt in der isolierten Repair-Outbox erhalten und wird an den Worker gereicht", async () => {
  const { dir, store, order } = fixture();
  const outboxDir = path.join(dir, "outbox");
  try {
    const buildRepairReceipt = feature("buildRepairReceipt");
    const receipt = await buildRepairReceipt(store, order.order_id, { now: NOW });
    const mailer = createOutboxMailer({ dir: outboxDir, now: () => NOW });
    const draft = await mailer.createDraft({ to: order.delivery_email, subject: "Test", body: "Body", messageClass: "CUSTOMER_ORDER_FULFILLMENT", orderId: order.order_id,
      attachments: [receipt.attachment] });
    await assert.rejects(mailer.sendDraft(draft.draftId), /OUTBOX_PENDING/);
    const calls = [];
    const result = await processRepairOutbox({ dir: outboxDir, gmail: {
      async createDraft(fields) { calls.push(fields); return { draftId: "draft-tf032" }; },
      async sendDraft() { return { messageId: "message-tf032" }; },
    }, gmailAuth: { ok: true, at: +NOW }, now: () => NOW });
    assert.equal(result.sent, 1, JSON.stringify(result));
    assert.equal(calls[0].attachments.length, 1);
    assert.equal(calls[0].attachments[0].filename, receipt.attachment.filename);
    assert.equal(Buffer.from(calls[0].attachments[0].content).toString("latin1", 0, 5), "%PDF-");
  } finally { cleanUp(dir); }
});

test("TF-032: PDF-Anlage bleibt auch im gebundenen Auftrags-Thread erhalten", async () => {
  const { dir, store, order } = fixture();
  const outboxDir = path.join(dir, "outbox-thread");
  try {
    const buildRepairReceipt = feature("buildRepairReceipt");
    const receipt = await buildRepairReceipt(store, order.order_id, { now: NOW });
    const mailer = createOutboxMailer({ dir: outboxDir, now: () => NOW });
    const draft = await mailer.createDraft({ to: order.delivery_email, subject: "Test", body: "Body", messageClass: "CUSTOMER_ORDER_FULFILLMENT", orderId: order.order_id,
      attachments: [receipt.attachment] });
    await assert.rejects(mailer.sendDraft(draft.draftId), /OUTBOX_PENDING/);
    const calls = [], sent = [];
    const result = await processRepairOutbox({ dir: outboxDir, gmail: {
      async createDraft() { throw new Error("Der gebundene Thread muss replyDraftInThread verwenden."); },
      async replyDraftInThread(threadId, fields) { calls.push({ threadId, ...fields }); return { draftId: "draft-thread", threadId }; },
      async sendDraft(id) { sent.push(id); return { messageId: "message-thread", threadId: "thread-tf032" }; },
    }, onboarding: {
      route() { return { threadId: "thread-tf032" }; },
      onSent() {},
      threadLost() {},
    }, gmailAuth: { ok: true, at: +NOW }, now: () => NOW });
    assert.equal(result.sent, 1, JSON.stringify(result));
    assert.deepEqual(sent, ["draft-thread"]);
    assert.equal(calls[0].threadId, "thread-tf032");
    assert.equal(calls[0].attachments.length, 1);
    assert.equal(Buffer.from(calls[0].attachments[0].content).toString("latin1", 0, 5), "%PDF-");
  } finally { cleanUp(dir); }
});

test("TF-032: Gmail-MIME bleibt ohne Anlage unverändert und unterstützt PDF multipart/mixed", () => {
  const pdf = Buffer.from("%PDF-tf032", "latin1");
  const plain = Buffer.from(rawMessage({ to: "test@synthetic.example", subject: "S", body: "B" }), "base64url").toString("utf8");
  assert.match(plain, /Content-Type: text\/plain; charset=UTF-8/);
  const mixed = Buffer.from(rawMessage({ to: "test@synthetic.example", subject: "S", body: "B", attachments: [{ filename: "quittung.pdf", mimeType: "application/pdf", content: pdf }] }), "base64url").toString("utf8");
  assert.match(mixed, /Content-Type: multipart\/mixed; boundary=/);
  assert.match(mixed, /filename="quittung\.pdf"/);
  assert.match(mixed, /application\/pdf/);
  assert.match(mixed, /JVBERi1 0ZjAzMg==|JVBERi10ZjAzMg==/);
});
