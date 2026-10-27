// TF-028 – synthetische Completion-Artefakte und Upgrade-Kette.
// Keine echten Empfänger, Websites, Zahlungen oder externen Provider-Aufrufe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../mail-worker.js";
import { createCheck150Order, createCheck150Engine, CHECK150_ORDERS_FILE } from "../check-150-workflow.js";
import { createRepairOrder, REPAIR_ORDERS_FILE, runRepairOrders } from "../repair-workflow.js";
import { recordPayment, paymentSummary, paymentGateForOrder } from "../payments.js";
import { buildCheck150Receipt, receiptReadiness, buildCheck150CompletionReport, buildCheck150CompletionMail, buildRepairCompletionMail, MANUAL_REVIEW_REQUIRED } from "../completion-artifacts.js";
import { createUpgradeCheckoutSession, UPGRADE_PURPOSE, UPGRADE_AMOUNT_CHF, normalizeCheckoutEvent, signStripePayload, verifyStripeWebhook } from "../stripe-payments.js";
import { createUpgrade, upgradeForSession, upgradeStatus } from "../upgrade-workflow.js";
import { bookCheckout, processCheckoutEvent } from "../stripe-webhook.js";
import { buildCrmLead, cleanCrmLead } from "../lead-crm.js";
import { createSourceReader } from "../crm-service.js";
import { createAccessIntakeHandler, memoryIntakeStore, consentText } from "../access-intake-api.js";
import { intakeClient, sealEnvelope, ACCESS_VAULT_DIR } from "../access-intake.js";
import { e2eConfig } from "../e2e-test.js";
import { gateDecision } from "../repair-browser-validator.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const E2E_ENV = Object.freeze({
  JARVIS_E2E_TEST_ENABLED: "true",
  JARVIS_E2E_TEST_DOMAINS: "synthetic.example",
  JARVIS_E2E_TEST_MAILBOXES: "test@synthetic.example",
});

function fixture({ address = true, amount = 150 } = {}) {
  const dir = fs.mkdtempSync(os.tmpdir() + "/jarvis-tf028-");
  const store = createStore(dir);
  if (address) store.write("config.json", { business_profile: { address: {
    street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH",
  } } });
  const order = createCheck150Order(store, {
    domain: "synthetic.example", website: "https://synthetic.example/", company: "Synthetic AG",
    delivery_email: "test@synthetic.example", contact_name: "Frau Test", lead_id: "synthetic-lead-028",
    test: { run_id: "e2e-abcdef123456" }, env: E2E_ENV, now: NOW,
  });
  recordPayment(store, { order_id: order.order_id, amount, currency: "CHF", provider_mode: "TEST",
    source: "stripe_test_fixture", reference: `tf028-receipt-${amount}`, received_at: NOW, now: NOW });
  return { dir, store, order };
}

function finding(severity, number) {
  return {
    finding_id: `I${number}`, severity, customer_title: `Problem ${number}`,
    customer_problem: `Problem ${number} ist dokumentiert.`, customer_impact: `Besucher erleben Problem ${number}.`,
    location: `Seite ${number}`, fix_summary: `Problem ${number} wird mit der dokumentierten Änderung behoben.`,
    difficulty: "Mittel", steps: [`Schritt ${number} eins.`, `Schritt ${number} zwei.`],
    verification_steps: [`Prüfung ${number} durchführen.`], expert_recommended: false,
  };
}

function liveCheckFixture({ address = true } = {}) {
  const dir = fs.mkdtempSync(os.tmpdir() + "/jarvis-tf028-live-");
  const store = createStore(dir);
  if (address) store.write("config.json", { business_profile: { address: { street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH" } } });
  store.write("sales.json", { records: { "synthetic.example": { status: "customer", sale: {
    selected_offer: "REPAIR_CHECK_150", sale_date: "2026-10-26", sale_value: 150, currency: "CHF", customer_status: "customer", work_status: "open",
  } } } });
  const order = createCheck150Order(store, { domain: "synthetic.example", website: "https://synthetic.example/", company: "Synthetic AG",
    delivery_email: "test@synthetic.example", contact_name: "Frau Test", lead_id: "synthetic-lead-028", now: NOW });
  recordPayment(store, { order_id: order.order_id, amount: 150, currency: "CHF", provider_mode: "LIVE", source: "synthetic_full_payment",
    reference: "tf028-live-check", received_at: NOW, now: NOW });
  const calls = [];
  const gmail = { calls, createDraft: async (data) => { calls.push({ op: "create", ...data }); return { draftId: "draft-tf028" }; },
    sendDraft: async (id) => { calls.push({ op: "send", id }); return { messageId: "message-tf028" }; }, updateDraft: async () => ({ draftId: "draft-tf028" }) };
  const auditor = { audit: async (website) => ({ website, host: "synthetic.example", reachable: true, finalUrl: website, title: "Synthetic AG",
    issues: [{ type: "broken_link", url: "https://synthetic.example/kontakt", page: website, evidence: "HTTP 404", severity: "high", label: "Kontakt", detectedAt: NOW.toISOString() }],
    pages: { home: "<html><head><meta name=viewport content=x></head><body>Synthetic</body></html>" }, requests: 1 }) };
  const upgradeCheckout = async () => ({ id: "cs_live_tf028upgrade01", status: "OPEN", url: "https://checkout.stripe.com/c/pay/cs_live_tf028upgrade01" });
  return { dir, store, order, gmail, auditor, upgradeCheckout, calls };
}

test("TF-028: vollständige CHF-150-Quittung ist nicht MWST-pflichtig", () => {
  const { store, order } = fixture();
  const receipt = buildCheck150Receipt(store, order.order_id, { now: NOW });
  assert.equal(receipt.status, "READY");
  assert.equal(receipt.title, "ZAHLUNGSQUITTUNG");
  assert.equal(receipt.paid_amount_chf, 150);
  assert.equal(receipt.open_amount_chf, 0);
  assert.match(receipt.text, /Helvetic Webdesign/);
  assert.match(receipt.text, /CHF 150\.00/);
  assert.match(receipt.text, /Mehrwertsteuer: Nicht erhoben/);
  assert.match(receipt.text, /Nicht mehrwertsteuerpflichtig – keine MWST erhoben/);
  assert.doesNotMatch(receipt.text, /8,1\s*%|MWST-Nummer|Mehrwertsteuer:.*CHF/i);
});

test("TF-028: fehlende Geschäftsadresse bleibt MANUAL_REVIEW_REQUIRED", () => {
  const { store, order } = fixture({ address: false });
  const readiness = receiptReadiness(store, order, { now: NOW });
  assert.equal(readiness.status, MANUAL_REVIEW_REQUIRED);
  assert.ok(readiness.reasons.some((reason) => /Geschäftsadresse/i.test(reason)));
  const receipt = buildCheck150Receipt(store, order.order_id, { now: NOW });
  assert.equal(receipt.status, MANUAL_REVIEW_REQUIRED);
  assert.ok(receipt.reasons.some((reason) => /Geschäftsadresse/i.test(reason)));
});

test("TF-028: Teilzahlung erzeugt nur eine Zahlungsbestätigung", () => {
  const { store, order } = fixture({ amount: 75 });
  const receipt = buildCheck150Receipt(store, order.order_id, { now: NOW });
  assert.equal(receipt.title, "ZAHLUNGSBESTÄTIGUNG");
  assert.equal(receipt.paid_amount_chf, 75);
  assert.equal(receipt.open_amount_chf, 75);
  assert.notEqual(receipt.status, "READY");
  assert.match(receipt.text, /Offener Betrag:\s*CHF 75\.00/);
  assert.doesNotMatch(receipt.text, /Zahlungsstatus:\s*Vollständig bezahlt/);
});

test("TF-028: CHF-150-Abschlussmail verwendet die freigegebene Vorlage", () => {
  const { store, order } = fixture();
  order.findings = [finding("critical", 1), finding("high", 2), finding("medium", 3), finding("low", 4)];
  order.audit_completed_at = NOW.toISOString();
  const report = buildCheck150CompletionReport(order, { now: NOW });
  const mail = buildCheck150CompletionMail(store, order, {
    now: NOW, report, upgradeLink: "https://checkout.stripe.com/c/pay/cs_test_tf028upgrade",
  });
  assert.equal(mail.status, "READY");
  for (const heading of ["# Webseiten-Check & Anleitung", "## 1. Umfang der Prüfung", "## 2. Zusammenfassung",
    "## 3. Festgestellte Probleme und Reparaturanleitungen", "## 4. Abschliessender Hinweis", "## 5. Optionales Reparaturangebot", "## 6. Quittung"]) {
    assert.ok(mail.body.includes(heading), heading);
  }
  assert.match(mail.body, /Anzahl festgestellter Probleme: 4/);
  assert.match(mail.body, /Kritische Probleme: 1/);
  assert.match(mail.body, /PROBLEM 1 – Problem 1/);
  assert.match(mail.body, /Schritt-für-Schritt-Anleitung:/);
  assert.match(mail.body, /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_tf028upgrade/);
  assert.match(mail.body, /ZAHLUNGSQUITTUNG/);
  assert.match(mail.body, /\*\*Helvetic Webdesign\*\*\nWebseiten-Service\n\nChristoph Kälin/);
  assert.doesNotMatch(mail.body, /PERSONALISIERTER STRIPE-CHECKOUT-LINK|Stripe-Testlink/);
});

test("TF-028: CHF-330-Checkout wird serverseitig an den CHF-150-Auftrag gebunden", async () => {
  const { order } = fixture();
  const seen = [];
  const env = { STRIPE_TEST_SECRET_KEY: "sk_test_tf02812345678" };
  const fetchFn = async (_url, options) => {
    seen.push(options);
    return { ok: true, json: async () => ({
      id: "cs_test_tf028upgrade01", livemode: false, status: "open", payment_status: "unpaid",
      amount_total: 33000, currency: "chf", payment_intent: null, expires_at: 1793000000,
      url: "https://checkout.stripe.com/c/pay/cs_test_tf028upgrade01",
      metadata: Object.fromEntries([...new URLSearchParams(options.body)].filter(([key]) => key.startsWith("metadata["))
        .map(([key, value]) => [key.slice(9, -1), value])),
    }) };
  };
  const session = await createUpgradeCheckoutSession({ env, sourceCheck: order, lead: { lead_id: order.lead_id, customer_id: "customer-028" },
    mode: "TEST", origin: "https://synthetic.example", fetchFn, now: NOW });
  assert.equal(session.metadata.purpose, UPGRADE_PURPOSE);
  assert.equal(session.metadata.source_order_id, order.order_id);
  assert.equal(session.metadata.lead_id, order.lead_id);
  assert.equal(session.metadata.customer_id, "customer-028");
  assert.equal(session.metadata.domain, order.domain);
  assert.equal(session.metadata.upgrade_amount_chf, String(UPGRADE_AMOUNT_CHF));
  assert.equal(session.amount_minor, 33000);
  assert.equal(session.currency, "CHF");
  assert.match(seen[0].headers["idempotency-key"], new RegExp(`${order.order_id}.*test`));
});

test("TF-028: Upgrade-Datensatz ist pro Quellauftrag und Checkout-Session idempotent", () => {
  const { store, order } = fixture();
  const checkout = {
    id: "cs_test_tf028upgrade01", url: "https://checkout.stripe.com/c/pay/cs_test_tf028upgrade01",
    amount_minor: 33000, currency: "CHF", payment_status: "unpaid", status: "open", livemode: false,
    metadata: { purpose: UPGRADE_PURPOSE, source_order_id: order.order_id, lead_id: order.lead_id, domain: order.domain,
      source_offer: "REPAIR_CHECK_150", upgrade_offer: "REPAIR_FIX_500", upgrade_amount_chf: "330", environment: "TEST" },
  };
  const first = createUpgrade(store, { sourceCheckOrderId: order.order_id, lead: { lead_id: order.lead_id, customer_id: "customer-028" }, checkout, now: NOW });
  const second = createUpgrade(store, { sourceCheckOrderId: order.order_id, lead: { lead_id: order.lead_id, customer_id: "customer-028" }, checkout, now: NOW });
  assert.equal(second.upgrade_id, first.upgrade_id);
  assert.equal(upgradeForSession(store, checkout.id).upgrade_id, first.upgrade_id);
  assert.equal(upgradeStatus(store, order.order_id).status, "OPEN");
});

test("TF-028: Reparaturzahlung erhält nur die live berechnete CHF-150-Gutschrift", () => {
  const { store, order } = fixture();
  const repair = createRepairOrder(store, { order_id: "RF480-20261026-abcdef", domain: order.domain, website: order.website,
    lead_id: order.lead_id, company: order.company, delivery_email: order.delivery_email, contact_name: order.contact_name, now: NOW });
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  data.orders[repair.order_id] = { ...data.orders[repair.order_id], test_order: true, environment: "TEST", source_check_order_id: order.order_id };
  store.write(REPAIR_ORDERS_FILE, data);
  recordPayment(store, { order_id: repair.order_id, amount: 330, currency: "CHF", provider_mode: "TEST",
    source: "stripe_test_upgrade", reference: "tf028-upgrade-payment", received_at: NOW, now: NOW });
  const saved = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[repair.order_id];
  assert.equal(paymentSummary(store, saved).paid_amount, 480);
  assert.equal(paymentSummary(store, saved).payment_status, "PAID_FULL");
  assert.equal(paymentGateForOrder(store, saved).satisfied, true);
});

test("TF-028: bestätigtes Upgrade-Webhook materialisiert genau einen gebundenen Repair-Auftrag", () => {
  const { store, order } = fixture();
  const checkout = {
    id: "cs_test_tf028webhook01", url: "https://checkout.stripe.com/c/pay/cs_test_tf028webhook01", amount_minor: 33000,
    currency: "CHF", payment_status: "unpaid", status: "open", livemode: false,
    metadata: { purpose: UPGRADE_PURPOSE, source_order_id: order.order_id, lead_id: order.lead_id, domain: order.domain,
      source_offer: "REPAIR_CHECK_150", upgrade_offer: "REPAIR_FIX_500", upgrade_amount_chf: "330", environment: "TEST" },
  };
  createUpgrade(store, { sourceCheckOrderId: order.order_id, lead: { lead_id: order.lead_id, customer_id: "customer-028" }, checkout, now: NOW });
  const session = { ...checkout, session_id: checkout.id, payment_status: "paid", payment_intent: "pi_tf028upgrade01",
    provider_mode: "TEST", created_at: NOW.toISOString() };
  const state = { attempts: {}, sessions: {}, events: {}, reviews: [], static: {} };
  const first = bookCheckout(store, state, session, { now: NOW });
  assert.equal(first.result, "BOOKED");
  assert.ok(first.order_id?.startsWith("RF480-"));
  const repair = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[first.order_id];
  assert.equal(repair.source_check_order_id, order.order_id);
  assert.equal(repair.customer_authorized_repair, false);
  assert.equal(paymentSummary(store, repair).paid_amount, 480);
  assert.equal(upgradeStatus(store, order.order_id).status, "PAID");
  const second = bookCheckout(store, state, session, { now: NOW });
  assert.equal(second.result, "ALREADY_RECORDED");
  assert.equal(Object.keys(store.read("payments.json", { payments: {} }).payments).length, 2);
});

test("TF-028: Upgrade-Webhook verarbeitet nur signierte, normalisierte und idempotente TEST-Ereignisse", () => {
  const { store, order } = fixture();
  const checkout = {
    id: "cs_test_tf028signed01", url: "https://checkout.stripe.com/c/pay/cs_test_tf028signed01", amount_minor: 33000, currency: "CHF", livemode: false,
    metadata: { purpose: UPGRADE_PURPOSE, source_order_id: order.order_id, lead_id: order.lead_id, domain: order.domain,
      source_offer: "REPAIR_CHECK_150", upgrade_offer: "REPAIR_FIX_500", upgrade_amount_chf: "330", environment: "TEST", secret: "must-drop" },
  };
  createUpgrade(store, { sourceCheckOrderId: order.order_id, checkout, now: NOW });
  const raw = JSON.stringify({ id: "evt_tf028signed01", type: "checkout.session.completed", livemode: false, created: Math.floor(+NOW / 1000), data: { object: {
    id: checkout.id, livemode: false, status: "complete", payment_status: "paid", amount_total: 33000, currency: "chf", payment_intent: "pi_tf028signed01",
    url: checkout.url, metadata: checkout.metadata,
  } } });
  const secret = "whsec_tf028_synthetic_secret";
  const header = signStripePayload(raw, secret, Math.floor(+NOW / 1000));
  const verified = verifyStripeWebhook(raw, header, { STRIPE_TEST_WEBHOOK_SECRET: secret }, { now: NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.mode, "TEST");
  const normalized = normalizeCheckoutEvent(verified.evt, verified.mode);
  assert.equal(normalized.kind, "CHECKOUT_PAID");
  assert.equal(Object.hasOwn(normalized.metadata, "secret"), false);
  const state = { attempts: {}, sessions: {}, events: {}, reviews: [], static: {} };
  const first = processCheckoutEvent(store, state, normalized, { now: NOW });
  assert.equal(first.result, "BOOKED");
  const second = processCheckoutEvent(store, state, normalized, { now: NOW });
  assert.equal(second.result, "DUPLICATE_EVENT");
  assert.equal(Object.keys(store.read("payments.json", { payments: {} }).payments).length, 2);
  const bad = verifyStripeWebhook(raw, "t=1761472800,v1=00".padEnd(69, "0"), { STRIPE_TEST_WEBHOOK_SECRET: secret }, { now: NOW });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "INVALID_SIGNATURE");
});

test("TF-028: falsche Upgrade-Zahlungen bleiben ohne Reparaturauftrag und Ledgerbuchung", () => {
  const variants = [
    ["AMOUNT_MISMATCH", { amount_minor: 32900 }],
    ["CURRENCY_MISMATCH", { currency: "EUR" }],
    ["NOT_PAID", { payment_status: "unpaid" }],
    ["METADATA_MISMATCH", { metadata: { lead_id: "other-lead-028" } }],
  ];
  for (const [code, change] of variants) {
    const { store, order } = fixture();
    const checkout = { id: `cs_test_tf028bad${code.slice(0, 4)}`, url: "https://checkout.stripe.com/c/pay/cs_test_tf028bad", amount_minor: 33000, currency: "CHF",
      payment_status: "unpaid", status: "open", livemode: false,
      metadata: { purpose: UPGRADE_PURPOSE, source_order_id: order.order_id, lead_id: order.lead_id, domain: order.domain,
        source_offer: "REPAIR_CHECK_150", upgrade_offer: "REPAIR_FIX_500", upgrade_amount_chf: "330", environment: "TEST" } };
    createUpgrade(store, { sourceCheckOrderId: order.order_id, checkout, now: NOW });
    const state = { attempts: {}, sessions: {}, events: {}, reviews: [], static: {} };
    const result = bookCheckout(store, state, { ...checkout, session_id: checkout.id, payment_status: "paid", provider_mode: "TEST", payment_intent: `pi_tf028bad${code.slice(0, 4)}`, ...change, metadata: { ...checkout.metadata, ...(change.metadata || {}) } }, { now: NOW });
    assert.equal(result.result, "PAYMENT_REVIEW_REQUIRED", code);
    assert.equal(state.reviews.at(-1).code, code);
    assert.equal(Object.keys(store.read("payments.json", { payments: {} }).payments).length, 1, code);
    assert.equal(Object.keys(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders).length, 0, code);
  }
  const { store, order } = fixture();
  const unknown = { id: "cs_test_tf028unknown01", session_id: "cs_test_tf028unknown01", provider_mode: "TEST", amount_minor: 33000, currency: "CHF", payment_status: "paid",
    payment_intent: "pi_tf028unknown01", metadata: { purpose: UPGRADE_PURPOSE, source_order_id: order.order_id, lead_id: order.lead_id, domain: order.domain,
      source_offer: "REPAIR_CHECK_150", upgrade_offer: "REPAIR_FIX_500", upgrade_amount_chf: "330", environment: "TEST" } };
  const unknownResult = bookCheckout(store, { attempts: {}, sessions: {}, events: {}, reviews: [], static: {} }, unknown, { now: NOW });
  assert.equal(unknownResult.result, "PAYMENT_REVIEW_REQUIRED");
  assert.equal(unknownResult.code, "UNKNOWN_UPGRADE_SESSION");
});

test("TF-028: CHF-150-Versand bleibt bei fehlender Geschäftsadresse gesperrt und nimmt danach wieder auf", async () => {
  const blocked = liveCheckFixture({ address: false });
  const engine = createCheck150Engine({ store: blocked.store, gmail: blocked.gmail, auditor: blocked.auditor, upgradeCheckout: blocked.upgradeCheckout, now: () => NOW });
  await engine.processAll();
  let saved = blocked.store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[blocked.order.order_id];
  assert.equal(saved.state, MANUAL_REVIEW_REQUIRED);
  assert.match(saved.blocked_reason, /Geschäftsadresse/);
  assert.equal(blocked.calls.filter((call) => call.op === "create").length, 0);
  blocked.store.write("config.json", { business_profile: { address: { street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH" } } });
  await engine.processAll();
  saved = blocked.store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[blocked.order.order_id];
  assert.equal(saved.state, "COMPLETED");
  assert.equal(saved.delivery_status, "sent");
  assert.equal(blocked.calls.filter((call) => call.op === "create").length, 1);
  assert.match(blocked.calls.find((call) => call.op === "create").body, /## 6\. Quittung/);
});

test("TF-028: CHF-480-Abschlussmail ist erst nach verifizierter Reparatur bereit", () => {
  const order = { offer_class: "REPAIR_FIX_500", contact_name: "Frau Test", website: "https://synthetic.example/", domain: "synthetic.example",
    issues: {
      one: { customer_text: "Der Kontaktlink war nicht erreichbar.", repair_status: "repaired", solution_summary: "Der Kontaktlink wurde auf die vorhandene Kontaktseite korrigiert." },
      two: { customer_text: "Ein Bild wurde nicht angezeigt.", repair_status: "repaired", solution_summary: "Das fehlende Bild wurde wieder korrekt eingebunden." },
    }, completion: { kind: "FULL" }, validation: { build_ok: true }, retest: { http_ok: true }, browser_gate: { required: false },
  };
  const mail = buildRepairCompletionMail(order);
  assert.equal(mail.status, MANUAL_REVIEW_REQUIRED);
  assert.match(mail.reasons.join(" "), /PDF-Quittung/);
  assert.equal(mail.body, "");
  assert.equal(mail.attachments?.length || 0, 0);
  assert.equal(mail.reasons.length > 0, true);
  const blocked = buildRepairCompletionMail({ ...order, issues: { ...order.issues, two: { ...order.issues.two, repair_status: "still_broken" } } });
  assert.equal(blocked.status, MANUAL_REVIEW_REQUIRED);
});

test("TF-028: CRM zeigt sichere Abschlussstatus und offenen Geschäftsadresspunkt", () => {
  const source = {
    registry: { leads: { "synthetic.example": { domain: "synthetic.example", company: "Synthetic AG", customer_status: "customer" } } },
    directory: { leads: { "synthetic.example": { domain: "synthetic.example", company_name: "Synthetic AG", email: "test@synthetic.example" } } },
    siteFindings: { domains: { "synthetic.example": { full: { complete: true, audited_at: NOW.toISOString(), findings: [{ key: "broken", text: "Ein Link führt auf eine Fehlerseite", severity: "high" }] } } } },
    repairFindings: { orders: {} },
    check150Orders: { orders: { "CA150-20261026-status": { order_id: "CA150-20261026-status", lead_id: "synthetic.example", state: MANUAL_REVIEW_REQUIRED,
      receipt_status: MANUAL_REVIEW_REQUIRED, receipt_open_items: ["Geschäftsadresse fehlt"], completion_mail_status: MANUAL_REVIEW_REQUIRED } } },
    upgrades: { upgrades: {} }, repairOrders: { orders: {} },
  };
  const blocked = cleanCrmLead(buildCrmLead("synthetic.example", source, NOW));
  assert.equal(blocked.service_status.receipt_status, MANUAL_REVIEW_REQUIRED);
  assert.deepEqual(blocked.service_status.open_items, ["Geschäftsadresse fehlt"]);
  assert.equal(blocked.service_status.completion_mail_status, MANUAL_REVIEW_REQUIRED);

  source.check150Orders.orders["CA150-20261026-status"] = { ...source.check150Orders.orders["CA150-20261026-status"], state: "COMPLETED",
    receipt_status: "READY", receipt_open_items: [], completion_mail_status: "SENT" };
  source.upgrades.upgrades.UPG_STATUS = { upgrade_id: "UPG_STATUS", source_check_order_id: "CA150-20261026-status", lead_id: "synthetic.example",
    status: "PAID", provider_mode: "TEST", repair_order_id: "RF480-20261026-status", checkout_url: "https://checkout.stripe.com/c/pay/secret" };
  source.repairOrders.orders["RF480-20261026-status"] = { order_id: "RF480-20261026-status", lead_id: "synthetic.example", state: "READY_FOR_DELIVERY" };
  const ready = cleanCrmLead(buildCrmLead("synthetic.example", source, NOW));
  assert.equal(ready.service_status.receipt_status, "READY");
  assert.equal(ready.service_status.upgrade_status, "PAID");
  assert.equal(ready.service_status.repair_status, "READY_FOR_DELIVERY");
  assert.equal(ready.service_status.completion_mail_status, "SENT");
  assert.equal(ready.service_status.repair_order_id, "RF480-20261026-status");
  assert.deepEqual(ready.service_status.open_items, []);
  assert.doesNotMatch(JSON.stringify(ready), /checkout\.stripe\.com|secret|payment_intent|access_token/i);
});

function browserSnapshot() {
  return {
    load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false,
    metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
    overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
    critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
    nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 3, targets_ok: 3, targets_failed: 0 },
    images: { visible: 3, broken: 0, broken_paths: [] },
    console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 },
    network: { failed_same_site: 0, failed_cross_site: 0, entries: [] },
    fingerprints: { header: "a", nav: "b", main: "c", footer: "d" },
    findings: [],
  };
}

function syntheticRepairWorld() {
  const state = { fixed: false, writes: 0, backups: 0, browser: [], mail: [] };
  const secret = "synthetic-tf028-secret";
  const gmail = {
    createDraft: async (message) => { state.mail.push({ op: "create", ...message }); return { draftId: `draft-${state.mail.length}` }; },
    sendDraft: async (draftId) => { state.mail.push({ op: "send", draftId }); return { messageId: `message-${draftId}` }; },
  };
  const auditor = { audit: async (website) => ({ website, reachable: true, finalUrl: website, title: "Synthetic AG", requests: 1,
    pages: { home: "<html><body>Synthetic</body></html>" }, issues: state.fixed ? [] : [{
      type: "broken_link", url: `${website}team-alt`, page: website, label: "Team", evidence: "HTTP 404", severity: "medium", detectedAt: NOW.toISOString(), reproducible: true,
    }] }) };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    state.browser.push(phase);
    const out = { url, phase, desktop: browserSnapshot(), mobile: browserSnapshot() };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  const adapter = {
    direct_live: true,
    checkAccess: async (_order, ctx) => ctx?.credential?.()?.secret === secret
      ? { ok: true, connector: "synthetic", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] }
      : { ok: false, reason: "synthetischer Zugang fehlt" },
    backup: async () => { state.backups++; return { production_ref: "synthetic-production", backup_ref: "synthetic-backup", rollback_point: "synthetic-rollback" }; },
    locate: async (issue) => ({ target: "index.html", cause: `Link auf ${new URL(issue.url).pathname} (404)`, planned_change: "href ersetzen", risk: "niedrig", before_hash: "before", fix: { replacement: "/team.html" } }),
    applyFix: async () => { state.fixed = true; state.writes++; return { ok: true, change_ref: "synthetic-change", before_hash: "before", after_hash: "after", solution_summary: "Der defekte Link wurde auf die vorhandene Teamseite korrigiert." }; },
    validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true, deploy_ref: "synthetic-deploy" }),
  };
  const router = { route: async () => ({ adapter: "synthetic", label: "Synthetic" }) };
  const preflight = { run: async (_order, { accessCtx }) => accessCtx?.credential?.()?.secret === secret
    ? { profile_status: "PROFILE_READY", reason: "synthetic_access_verified", profile: { interface: "synthetic", capabilities: ["READ_FILES", "WRITE_FILES"] } }
    : { profile_status: "MANUAL_REVIEW_REQUIRED", reason: "synthetic_access_missing" } };
  return { state, secret, gmail, auditor, browserValidator, adapter, router, preflight };
}

function syntheticCloud() {
  const blobs = memoryIntakeStore();
  const workerToken = "w".repeat(43);
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (key) => key === "JARVIS_MAIL_WORKER_TOKEN" ? workerToken : undefined, now: () => NOW });
  const fetchFn = async (url, init) => handler(new Request(url, init));
  const client = intakeClient({ config: { url: "https://synthetic.example/api/state", workerToken }, fetchFn });
  return { blobs, handler, client };
}

async function submitSyntheticAccess(cloud, link, secret) {
  const token = decodeURIComponent(link.split("#t=")[1]);
  const call = async (body) => {
    const response = await cloud.handler(new Request("https://synthetic.example/api/access-intake", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  };
  const info = await call({ op: "info", token });
  assert.equal(info.status, 200, JSON.stringify(info.body));
  const envelope = sealEnvelope({ access_type: "other", host: "https://synthetic.example/", username: "jarvis-temp", secret, notes: consentText() }, info.body.public_key);
  return call({ op: "submit", token, access_type: "other", access_domain: "synthetic.example", consent: true, envelope });
}

test("TF-028: bestÃ¤tigtes Upgrade durchlÃ¤uft die bestehenden Reparatur-Gates ohne implizite Freigabe", async () => {
  const { store, order } = fixture();
  const checkout = { id: "cs_test_tf028gate01", url: "https://checkout.stripe.com/c/pay/cs_test_tf028gate01", amount_minor: 33000, currency: "CHF", payment_status: "unpaid", status: "open", livemode: false,
    metadata: { purpose: UPGRADE_PURPOSE, source_order_id: order.order_id, lead_id: order.lead_id, domain: order.domain, source_offer: "REPAIR_CHECK_150", upgrade_offer: "REPAIR_FIX_500", upgrade_amount_chf: "330", environment: "TEST" } };
  createUpgrade(store, { sourceCheckOrderId: order.order_id, checkout, now: NOW });
  const booked = bookCheckout(store, { attempts: {}, sessions: {}, events: {}, reviews: [], static: {} }, { ...checkout, session_id: checkout.id, payment_status: "paid", provider_mode: "TEST", payment_intent: "pi_tf028gate01" }, { now: NOW });
  assert.equal(booked.result, "BOOKED");
  const repair = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[booked.order_id];
  assert.equal(repair.customer_authorized_repair, false);
  assert.equal(repair.state, "ORDER_RECEIVED");
  assert.equal(upgradeStatus(store, order.order_id).status, "PAID");
});

test("TF-028: synthetischer CHF-150â†’CHF-330â†’CHF-480-Lauf endet mit verifizierter Reparatur und genau einer Abschlussmail", async () => {
  const { dir, store, order } = fixture();
  const checkout = { id: "cs_test_tf028e2e01", url: "https://checkout.stripe.com/c/pay/cs_test_tf028e2e01", amount_minor: 33000, currency: "CHF", payment_status: "unpaid", status: "open", livemode: false,
    metadata: { purpose: UPGRADE_PURPOSE, source_order_id: order.order_id, lead_id: order.lead_id, domain: order.domain, source_offer: "REPAIR_CHECK_150", upgrade_offer: "REPAIR_FIX_500", upgrade_amount_chf: "330", environment: "TEST" } };
  const checkData = store.read(CHECK150_ORDERS_FILE, { orders: {} });
  checkData.orders[order.order_id].e2e_fulfilment = { approved_at: NOW.toISOString(), approved_by: "synthetic-test", run_id: order.test_run_id };
  store.write(CHECK150_ORDERS_FILE, checkData);
  const checkMail = [];
  const checkEngine = createCheck150Engine({
    store, env: { ...E2E_ENV, JARVIS_E2E_FULFILMENT_ENABLED: "true" },
    auditor: { audit: async (website) => ({ website, reachable: true, finalUrl: website, title: "Synthetic AG", requests: 1,
      pages: { home: "<html><body>Synthetic</body></html>" }, issues: [{ type: "broken_link", url: `${website}team-alt`, page: website,
        label: "Team", evidence: "HTTP 404", severity: "medium", detectedAt: NOW.toISOString(), reproducible: true }] }) },
    gmail: { outbox: path.join(dir, "synthetic-outbox"), createDraft: async (message) => { checkMail.push({ op: "create", ...message }); return { draftId: "check-draft" }; },
      sendDraft: async (draftId) => { checkMail.push({ op: "send", draftId }); return { messageId: "check-message" }; } },
    upgradeCheckout: async () => checkout, now: () => NOW, log: () => {},
  });
  await checkEngine.processAll();
  const checked = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[order.order_id];
  assert.equal(checked.state, "COMPLETED");
  assert.equal(checked.completion_mail_status, "SENT");
  assert.equal(checkMail.filter((item) => item.op === "create").length, 1);
  assert.match(checkMail.find((item) => item.op === "create").body, /## 6\. Quittung/);
  createUpgrade(store, { sourceCheckOrderId: order.order_id, lead: { lead_id: order.lead_id }, checkout, now: NOW });
  const booked = bookCheckout(store, { attempts: {}, sessions: {}, events: {}, reviews: [], static: {} }, { ...checkout, session_id: checkout.id, payment_status: "paid", provider_mode: "TEST", payment_intent: "pi_tf028e2e01" }, { now: NOW });
  assert.equal(booked.result, "BOOKED");
  const repairWorld = syntheticRepairWorld();
  const cloud = syntheticCloud();
  const run = () => runRepairOrders({ dir, adapters: { synthetic: repairWorld.adapter }, router: repairWorld.router, preflight: repairWorld.preflight,
    browserValidator: repairWorld.browserValidator, auditor: repairWorld.auditor, gmail: repairWorld.gmail, intake: cloud.client,
    e2e: e2eConfig(E2E_ENV), requireBrowser: true, autoDeliver: true, log: () => {} });
  await run();
  const afterRequest = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[booked.order_id];
  assert.equal(afterRequest.state, "ACCESS_REQUESTED");
  const accessMail = repairWorld.state.mail.find((item) => item.messageClass === "CUSTOMER_ACCESS_REQUEST");
  assert.ok(accessMail?.body);
  const link = accessMail.body.match(/https:\/\/synthetic\.example\/access\.html#t=[A-Za-z0-9_%-]+/)?.[0];
  assert.ok(link, "synthetischer One-Time-Zugang-Link fehlt");
  assert.equal((await submitSyntheticAccess(cloud, link, repairWorld.secret)).status, 200);
  await run();
  let repaired = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[booked.order_id];
  assert.equal(repaired.state, "COMPLETED");
  assert.equal(repaired.customer_authorized_repair, true);
  assert.deepEqual([repaired.browser_gate.desktop, repaired.browser_gate.mobile, repaired.browser_gate.regression], ["JA", "JA", "KEINE"]);
  assert.equal(repairWorld.state.writes, 1);
  assert.equal(repairWorld.state.backups, 1);
  const fulfillment = repairWorld.state.mail.filter((item) => item.messageClass === "CUSTOMER_ORDER_FULFILLMENT");
  assert.equal(fulfillment.length, 1);
  assert.match(fulfillment[0].body, /So haben wir die zuvor pr\u00e4senten Probleme gel\u00f6st:/);
  assert.match(fulfillment[0].body, /Der defekte Link wurde auf die vorhandene Teamseite korrigiert/);
  const mailCount = repairWorld.state.mail.length;
  await run();
  repaired = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[booked.order_id];
  assert.equal(repaired.state, "COMPLETED");
  assert.equal(repairWorld.state.mail.length, mailCount, "Neustart darf keine zweite Abschlussmail erzeugen");
  assert.equal(upgradeStatus(store, order.order_id).status, "PAID");
  assert.equal(repairWorld.state.browser.filter((phase) => phase === "after").length, 1);
  assert.equal(fs.existsSync(path.join(dir, ACCESS_VAULT_DIR, `${booked.order_id}.json`)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("TF-028: CRM-Quellenleser liefert den Dienststatus nur aus den bestehenden Worker-Dateien", () => {
  const root = fs.mkdtempSync(os.tmpdir() + "/jarvis-tf028-crm-source-");
  const dataDir = path.join(root, "crm");
  const mailDir = path.join(root, "mail");
  fs.mkdirSync(path.join(mailDir, "mail_worker"), { recursive: true });
  fs.writeFileSync(path.join(mailDir, "mail_worker", "check150_orders.json"), JSON.stringify({ orders: {
    "CA150-20261026-reader": { order_id: "CA150-20261026-reader", lead_id: "synthetic.example", state: MANUAL_REVIEW_REQUIRED,
      receipt_status: MANUAL_REVIEW_REQUIRED, receipt_open_items: ["BUSINESS_ADDRESS_MISSING"], completion_mail_status: MANUAL_REVIEW_REQUIRED },
  } }));
  fs.writeFileSync(path.join(mailDir, "mail_worker", "repair_orders.json"), JSON.stringify({ orders: {} }));
  fs.writeFileSync(path.join(mailDir, "mail_worker", "repair_upgrades.json"), JSON.stringify({ upgrades: {} }));
  const source = createSourceReader({ dataDir, mailDir })();
  source.registry = { leads: { "synthetic.example": { domain: "synthetic.example", customer_status: "customer" } } };
  source.directory = { leads: { "synthetic.example": { domain: "synthetic.example", company_name: "Synthetic AG", email: "test@synthetic.example" } } };
  const lead = cleanCrmLead(buildCrmLead("synthetic.example", source, NOW));
  assert.equal(lead.service_status.receipt_status, MANUAL_REVIEW_REQUIRED);
  assert.deepEqual(lead.service_status.open_items, ["Gesch\u00e4ftsadresse fehlt"]);
  assert.doesNotMatch(JSON.stringify(lead), /checkout|payment_intent|access_token/i);
  fs.rmSync(root, { recursive: true, force: true });
});
