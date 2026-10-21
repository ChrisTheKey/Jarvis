// TF-JARVIS-024 – Stripe-LIVE-Bereitschaft: CHF 150 / CHF 480, Beträge, Erfolg/Fehlschlag/Abbruch, Webhook-Signatur, Duplikate, unbekannte Aufträge,
// manipulierte Preise, wiederholte Bestätigung, fehlende Variablen, LIVE/TEST-Verwechslung, keine Secrets in Logs/Zustand.
// NUR Attrappen: Fake-Stripe über injiziertes fetchFn (nie api.stripe.com), signierte Fixture-Webhooks, kurze Dummy-Schlüssel (< Secret-Scan-Muster).
// 0 echte Zahlungen, 0 echte Checkout-Sessions, 0 Mails, 0 echte Kunden.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { paymentGateForOrder, paymentsForOrder, recordPayment, PAYMENTS_FILE } from "../payments.js";
import { offerInfo } from "../pricing.js";
import { createContactFormRepairOrder, REPAIR_ORDERS_FILE } from "../repair-workflow.js";
import { memoryStore } from "../shared-state.js";
import { createPaymentsHandler } from "../payments-api.js";
import { signStripePayload, stripeStatus, expectedDeposit, createCheckoutSession, idempotencyKey } from "../stripe-payments.js";
import { syncStripePayments, stripeServiceStatus, paymentsInboxClient, STRIPE_FILE } from "../stripe-webhook.js";
import { paymentLinkFor, PAYMENT_LINKS } from "../payment-links.js";
import { e2eConfig } from "../e2e-test.js";
import { readPaymentLinks } from "../onboarding-store.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T0 = new Date("2026-10-21T09:00:00Z");
const ORIGIN = "https://jarvis.test";
const KEYS = { STRIPE_SECRET_KEY: "sk_live_fixture24", STRIPE_TEST_SECRET_KEY: "sk_test_fixture24" };
const WH = { STRIPE_WEBHOOK_SECRET: "whsec_fixtLive24", STRIPE_TEST_WEBHOOK_SECRET: "whsec_fixtTest24" };
const WT = "w".repeat(43);
const E2E_OFF = e2eConfig({});
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf024-")); made.push(d); return d; };
const json = (status, b) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const sec = (d) => Math.floor(+d / 1000);

// ---------- Fake Stripe: nur POST/GET /v1/checkout/sessions, Idempotenz wie Stripe; tamper() verändert Antworten (Manipulationstests) ----------
function fakeStripe() {
  const sessions = {}, byIdem = {}, calls = [];
  let n = 0, tamper = (s) => s;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {}, method = init.method || "GET";
    const mode = /^Bearer sk_live_/.test(h.authorization || "") ? "live" : /^Bearer sk_test_/.test(h.authorization || "") ? "test" : null;
    calls.push({ method, path: u.pathname, mode, idem: h["idempotency-key"] || null, body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
    if (u.hostname !== "api.stripe.com" || !mode) return json(401, { error: { code: "auth" } });
    if (method === "POST" && u.pathname === "/v1/checkout/sessions") {
      const idem = h["idempotency-key"];
      if (byIdem[idem]) return json(200, tamper(sessions[byIdem[idem]]));
      const p = new URLSearchParams(init.body), id = `cs_${mode}_fixture${String(++n).padStart(4, "0")}`;
      sessions[id] = { id, object: "checkout.session", livemode: mode === "live", status: "open", payment_status: "unpaid", amount_total: Number(p.get("line_items[0][price_data][unit_amount]")),
        currency: p.get("line_items[0][price_data][currency]"), payment_intent: null, expires_at: Number(p.get("expires_at")), url: `https://checkout.stripe.com/c/pay/${id}`,
        metadata: Object.fromEntries(["order_id", "offer_class", "market", "purpose", "environment"].map((k) => [k, p.get(`metadata[${k}]`)])) };
      byIdem[idem] = id;
      return json(200, tamper(sessions[id]));
    }
    const m = u.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[a-z]+_fixture\d+)$/);
    if (method === "GET" && m && sessions[m[1]] && sessions[m[1]].livemode === (mode === "live")) return json(200, sessions[m[1]]);
    return json(404, { error: { code: "resource_missing" } });
  };
  return { sessions, calls, fetchFn, setTamper: (f) => { tamper = f; },
    posts: () => calls.filter((c) => c.method === "POST" && c.path === "/v1/checkout/sessions"),
    pay(id, pi = `pi_${id.slice(3)}`) { Object.assign(sessions[id], { status: "complete", payment_status: "paid", payment_intent: pi }); return sessions[id]; },
    last: () => Object.values(sessions).at(-1) };
}
// Stripe-Ereignis (Checkout-Session als Objekt); over überschreibt Felder des Objekts (Manipulation).
const evt = (type, obj, { id, over = {}, livemode = obj.livemode } = {}) => ({ id: id || `evt_${type.replace(/\W/g, "")}_${obj.id}`, object: "event", type, livemode, created: sec(T0),
  data: { object: { ...structuredClone(obj), ...over } } });
const linkEvt = ({ ref, amount, mode = "live", pi, id }) => ({ id, object: "event", type: "checkout.session.completed", livemode: mode === "live", created: sec(T0),
  data: { object: { id: `cs_${mode}_link${id.slice(-6)}`, object: "checkout.session", livemode: mode === "live", status: "complete", payment_status: "paid", amount_total: amount, currency: "chf",
    payment_intent: pi, client_reference_id: ref, payment_link: "plink_1Fixture0024", metadata: {} } } });

function world({ env = KEYS, whEnv = WH } = {}) {
  const dir = tmp(), od = tmp(), store = createStore(dir), mem = {}, logs = [], stripe = fakeStripe();
  const cloudEnv = (k) => ({ ...whEnv, JARVIS_MAIL_WORKER_TOKEN: WT })[k];
  const handler = createPaymentsHandler({ env: cloudEnv, getStore: async (k) => (mem[k] ||= memoryStore()), now: () => w.clock });
  const req = (body, headers) => new Request(`${ORIGIN}/api/payments`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const inbox = { pull: async () => (await (await handler(req(JSON.stringify({ op: "inbox.pull" }), { "x-jarvis-worker": WT }))).json()).events,
    ack: async (keys) => handler(req(JSON.stringify({ op: "inbox.ack", keys }), { "x-jarvis-worker": WT })) };
  const w = { dir, od, store, stripe, logs, handler, inbox, clock: T0,
    async hook(e, { secret = e.livemode ? WH.STRIPE_WEBHOOK_SECRET : WH.STRIPE_TEST_WEBHOOK_SECRET, raw = JSON.stringify(e), sigBody = raw, t = sec(w.clock), header } = {}) {
      const r = await handler(req(raw, { "stripe-signature": header ?? signStripePayload(sigBody, secret, t) }));
      return { status: r.status, body: await r.json() };
    },
    sync: (o = {}) => syncStripePayments({ dir, onboardingDir: od, env, inbox, origin: ORIGIN, fetchFn: stripe.fetchFn, e2e: E2E_OFF, now: w.clock, log: (...a) => logs.push(JSON.stringify(a)), ...o }),
    st: () => store.read(STRIPE_FILE, {}),
    reviews: () => (store.read(STRIPE_FILE, {}).reviews || []).map((r) => r.code),
    attempt: (id) => store.read(STRIPE_FILE, {}).attempts?.[id],
    pending: async () => (await inbox.pull()).length };
  return w;
}
let seq = 0;
const liveOrder = (w) => createContactFormRepairOrder(w.store, { domain: `kunde-${++seq}.ch`, delivery_email: `kunde${seq}@kunde-${seq}.ch`, contact_name: "Anna Muster",
  contact_form_key: "cf:" + String(seq).padStart(24, "a"), confirmed_at: T0.toISOString(), now: T0 });
const checkOrder = (w, id = "CA150-20261021-abc024") => {
  w.store.write("check150_orders.json", { schema: 1, orders: { [id]: { order_id: id, offer_class: "REPAIR_CHECK_150", state: "BLOCKED_PAYMENT_NOT_RECEIVED", market: "CH", domain: "kunde-check.ch", delivery_email: "k@kunde-check.ch" } } });
  return id;
};
const gate = (w, o) => paymentGateForOrder(w.store, o).satisfied;
// Bestellung mit offener LIVE-Anzahlungs-Session (Attrappe).
async function openSession(w) {
  const o = liveOrder(w);
  await w.sync();
  const a = w.attempt(o.order_id);
  assert.equal(a.status, "OPEN"); assert.equal(a.provider_mode, "LIVE");
  return { o, sid: a.checkout_session_id };
}

test("Beträge: CHF 150 / CHF 480 aus pricing.js, Anzahlung CHF 240.00 = 24000 Rappen, nur CHF/CH", () => {
  assert.deepEqual([offerInfo("REPAIR_CHECK_150").price, offerInfo("REPAIR_FIX_500").price, offerInfo("REPAIR_FIX_500").currency], [150, 480, "CHF"]);
  assert.deepEqual(expectedDeposit({ offer_class: "REPAIR_FIX_500", market: "CH" }), { amount: 240, amount_minor: 24000, currency: "CHF" });
  assert.equal(expectedDeposit({ offer_class: "REPAIR_CHECK_150" }), null, "CHF 150 läuft über den Payment Link, nie über eine Anzahlungs-Session");
  assert.equal(expectedDeposit({ offer_class: "VN_REPAIR_FIX", market: "VN" }), null);
  assert.equal(expectedDeposit({ offer_class: "REPAIR_FIX_500", market: "VN" }), null);
  // Payment Links (CHF 150 / 480): öffentliche LIVE-Links, Auftrag nur über client_reference_id, nie ein Testlink für Kunden
  for (const c of ["REPAIR_CHECK_150", "REPAIR_FIX_500"]) {
    assert.match(PAYMENT_LINKS[c], /^https:\/\/buy\.stripe\.com\/(?!test_)[A-Za-z0-9]+$/);
    assert.equal(paymentLinkFor(c, { orderId: "RF480-20261021-abc024" }), `${PAYMENT_LINKS[c]}?client_reference_id=RF480-20261021-abc024`);
  }
  assert.equal(paymentLinkFor("REPAIR_FIX_500", { orderId: "RF480-1; drop" }), null);
  assert.equal(paymentLinkFor("VN_REPAIR_FIX", { orderId: "VNFIX-20261021-abc024" }), null);
});

test("CHF 480 Checkout LIVE: serverseitig 24000 CHF, Metadaten/Idempotenz, genau eine Session, manipulierte Auftragsfelder ändern den Betrag nie", async () => {
  const w = world(), o = liveOrder(w);
  // Manipulation im gespeicherten Auftrag (Preis/Betragsfelder) – Betrag kommt ausschliesslich aus pricing.js
  const all = w.store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(all.orders[o.order_id], { price_chf: 1, amount: 1, deposit: 1, unit_amount: 1 });
  w.store.write(REPAIR_ORDERS_FILE, all);
  const out = await w.sync();
  assert.equal(out.created, 1);
  const [c] = w.stripe.posts();
  assert.equal(c.mode, "live");
  assert.deepEqual([c.body["line_items[0][price_data][unit_amount]"], c.body["line_items[0][price_data][currency]"], c.body["line_items[0][quantity]"], c.body.mode],
    ["24000", "chf", "1", "payment"]);
  assert.deepEqual([c.body.client_reference_id, c.body["metadata[order_id]"], c.body["metadata[purpose]"], c.body["metadata[environment]"], c.body["metadata[market]"]],
    [o.order_id, o.order_id, "REPAIR_DEPOSIT", "LIVE", "CH"]);
  assert.equal(c.idem, idempotencyKey(o.order_id, "LIVE"));
  assert.equal(c.body.success_url, `${ORIGIN}/zahlung.html?s=ok`);
  assert.ok(!Object.keys(c.body).some((k) => /price\]$|^payment_method_types/.test(k)), "keine Preis-IDs/hart kodierten Zahlungsarten");
  assert.match(readPaymentLinks(w.od).links[o.order_id].url, /^https:\/\/checkout\.stripe\.com\//);
  w.clock = new Date(+T0 + 60_000); await w.sync(); await w.sync();
  assert.equal(w.stripe.posts().length, 1, "genau eine aktive Session je Auftrag");
  assert.ok(w.stripe.calls.every((x) => !x.mode || x.mode === "live"), "LIVE-Auftrag nie mit TEST-Schlüssel");
});

test("Erfolgreiche Zahlung: signierter LIVE-Webhook → genau eine Buchung CHF 240, Gate offen, Versuch PAID", async () => {
  const w = world(), { o, sid } = await openSession(w);
  assert.equal(gate(w, o), false);
  const r = await w.hook(evt("checkout.session.completed", w.stripe.pay(sid)));
  assert.equal(r.status, 200); assert.equal(r.body.duplicate, false);
  const out = await w.sync();
  assert.equal(out.booked, 1); assert.equal(out.reviews, 0);
  const ps = paymentsForOrder(w.store, o.order_id);
  assert.equal(ps.length, 1);
  assert.deepEqual([ps[0].amount, ps[0].currency, ps[0].provider_mode, ps[0].source, ps[0].status], [240, "CHF", "LIVE", "stripe_checkout", "RECEIVED"]);
  assert.equal(gate(w, o), true);
  assert.equal(w.attempt(o.order_id).status, "PAID");
});

test("CHF 150 über Payment Link LIVE → genau dem CHECK-Auftrag zugeordnet (150.00 CHF), Gate CHF 75 erfüllt", async () => {
  const w = world(), id = checkOrder(w);
  assert.equal((await w.hook(linkEvt({ ref: id, amount: 15000, pi: "pi_fixture150001", id: "evt_link_150001" }))).status, 200);
  const out = await w.sync({ eventsOnly: true });
  assert.equal(out.booked, 1);
  const [p] = paymentsForOrder(w.store, id);
  assert.deepEqual([p.amount, p.currency, p.provider_mode, p.source], [150, "CHF", "LIVE", "stripe_payment_link"]);
  assert.equal(paymentGateForOrder(w.store, { order_id: id, offer_class: "REPAIR_CHECK_150" }).satisfied, true);
});

test("Doppelte Zustellung + wiederholte Bestätigung (gleiches Ereignis, neue Ereignis-ID, async_payment_succeeded, Abgleich) → nie eine zweite Buchung", async () => {
  const w = world(), { o, sid } = await openSession(w);
  const paid = w.stripe.pay(sid), e = evt("checkout.session.completed", paid);
  assert.equal((await w.hook(e)).body.duplicate, false);
  assert.equal((await w.hook(e)).body.duplicate, true, "Netlify-Inbox idempotent je Ereignis-ID");
  assert.equal((await w.sync()).booked, 1);
  await w.hook(evt("checkout.session.completed", paid, { id: "evt_replay_newid0001" }));            // Stripe-Wiederholung mit neuer ID
  await w.hook(evt("checkout.session.async_payment_succeeded", paid));                             // zweites Bestätigungssignal
  w.clock = new Date(+T0 + 30 * 60_000);
  const out = await w.sync();
  assert.equal(out.booked, 0); assert.equal(out.reviews, 0);
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 1);
  // gleiche Ereignis-ID erneut aus der Inbox (z. B. Absturz vor der Quittung) → DUPLICATE_EVENT
  const { processCheckoutEvent } = await import("../stripe-webhook.js");
  const st = w.st(), again = processCheckoutEvent(w.store, st, { event_id: e.id, kind: "CHECKOUT_PAID" });
  assert.equal(again.result, "DUPLICATE_EVENT");
});

test("Gate bereits durch eine andere Zahlung erfüllt → Anzahlungs-Session wird nicht still zusätzlich verbucht (DUPLICATE_PAYMENT, Prüfung)", async () => {
  // a) zuerst Payment Link CHF 480, danach zahlt der Kunde zusätzlich die offene Anzahlungs-Session
  const w = world(), { o, sid } = await openSession(w);
  await w.hook(linkEvt({ ref: o.order_id, amount: 48000, pi: "pi_fixture480001", id: "evt_link_480001" }));
  assert.equal((await w.sync({ eventsOnly: true })).booked, 1);
  await w.hook(evt("checkout.session.completed", w.stripe.pay(sid)));
  const out = await w.sync({ eventsOnly: true });
  assert.equal(out.booked, 0); assert.equal(out.reviews, 1);
  assert.equal(w.reviews().at(-1), "DUPLICATE_PAYMENT");
  assert.deepEqual(paymentsForOrder(w.store, o.order_id).map((p) => p.amount), [480]);
  // b) Banküberweisung von Chris verbucht, danach Stripe-Anzahlung
  const w2 = world(), s2 = await openSession(w2);
  recordPayment(w2.store, { order_id: s2.o.order_id, amount: 240, currency: "CHF", source: "bank_transfer", reference: "bank-ref-024", now: T0 });
  await w2.hook(evt("checkout.session.completed", w2.stripe.pay(s2.sid)));
  await w2.sync({ eventsOnly: true });
  assert.equal(w2.reviews().at(-1), "DUPLICATE_PAYMENT");
  assert.equal(paymentsForOrder(w2.store, s2.o.order_id).length, 1);
});

test("Fehlgeschlagene Zahlung → nichts verbucht; genau EINE Ersatz-Session; zweiter Fehlschlag → EXPIRED_FINAL (keine dritte Session)", async () => {
  const w = world(), { o, sid } = await openSession(w);
  await w.hook(evt("checkout.session.async_payment_failed", { ...w.stripe.sessions[sid], status: "complete", payment_status: "unpaid" }));
  await w.sync();
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 0);
  assert.equal(w.attempt(o.order_id).status, "OPEN");
  assert.equal(w.attempt(o.order_id).seq, 2);
  const sid2 = w.attempt(o.order_id).checkout_session_id;
  assert.notEqual(sid2, sid);
  assert.equal(w.stripe.posts()[1].idem, idempotencyKey(o.order_id, "LIVE", 2));
  await w.hook(evt("checkout.session.async_payment_failed", { ...w.stripe.sessions[sid2], status: "complete", payment_status: "unpaid" }));
  await w.sync(); await w.sync();
  assert.equal(w.attempt(o.order_id).status, "EXPIRED_FINAL");
  assert.equal(w.stripe.posts().length, 2);
  assert.equal(gate(w, o), false);
});

test("Abgebrochener Checkout: Rückkehrseite ist nie ein Beleg (kein Skript), ohne Ereignis keine Buchung; checkout.session.expired → EXPIRED", async () => {
  const w = world(), { o, sid } = await openSession(w);
  const page = fs.readFileSync(path.join(ROOT, "public", "zahlung.html"), "utf8");
  assert.doesNotMatch(page, /<script/i, "Rückkehrseite ohne Skript");
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8").split('for = "/zahlung*"')[1].split("[[headers]]")[0], /script-src/);
  w.clock = new Date(+T0 + 5 * 60_000); await w.sync();                          // Kunde bricht ab: kein Ereignis
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 0);
  assert.equal(w.attempt(o.order_id).status, "OPEN");
  await w.hook(evt("checkout.session.expired", { ...w.stripe.sessions[sid], status: "expired" }));
  await w.sync({ eventsOnly: true });
  assert.equal(w.attempt(o.order_id).status, "EXPIRED");
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 0);
});

test("Ungültige Webhook-Signatur (verändert, fehlend, falsches Secret, abgelaufen, LIVE-Ereignis mit TEST-Secret) → 400, nichts gespeichert/verbucht", async () => {
  const w = world(), { o, sid } = await openSession(w);
  const e = evt("checkout.session.completed", w.stripe.pay(sid)), raw = JSON.stringify(e);
  const forged = JSON.stringify({ ...e, data: { object: { ...e.data.object, amount_total: 1 } } });
  const cases = [
    [{ raw: forged, sigBody: raw }, "INVALID_SIGNATURE"],
    [{ header: "" }, "INVALID_SIGNATURE"],
    [{ header: "t=123,v1=nothex" }, "INVALID_SIGNATURE"],
    [{ secret: "whsec_fremd0024" }, "INVALID_SIGNATURE"],
    [{ t: sec(T0) - 3600 }, "SIGNATURE_EXPIRED"],
    [{ secret: WH.STRIPE_TEST_WEBHOOK_SECRET }, "MODE_MISMATCH"],
  ];
  for (const [opt, code] of cases) { const r = await w.hook(e, opt); assert.equal(r.status, 400, code); assert.equal(r.body.code, code); }
  assert.equal(await w.pending(), 0, "nichts in der Inbox");
  await w.sync();
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 0);
});

test("Unbekannte Bestellnummer / unbekannte Session → PAYMENT_REVIEW_REQUIRED, nie verbucht, nie erraten", async () => {
  const w = world(), { o } = await openSession(w);
  const foreign = { id: "cs_live_fremd00000001", object: "checkout.session", livemode: true, status: "complete", payment_status: "paid", amount_total: 24000, currency: "chf",
    payment_intent: "pi_fremd0000001", metadata: { order_id: o.order_id, offer_class: "REPAIR_FIX_500", market: "CH", purpose: "REPAIR_DEPOSIT", environment: "LIVE" } };
  await w.hook(evt("checkout.session.completed", foreign));
  await w.hook(linkEvt({ ref: "RF480-20261021-ffffff", amount: 48000, pi: "pi_fixture999024", id: "evt_link_unknown" }));
  await w.hook(linkEvt({ ref: null, amount: 48000, pi: "pi_fixture999025", id: "evt_link_noref01" }));
  const out = await w.sync({ eventsOnly: true });
  assert.equal(out.booked, 0); assert.equal(out.reviews, 3);
  assert.deepEqual(w.reviews(), ["UNKNOWN_SESSION", "UNKNOWN_ORDER", "PAYMENT_LINK_NO_REFERENCE"]);
  assert.equal(Object.keys(w.store.read(PAYMENTS_FILE, { payments: {} }).payments).length, 0);
});

test("Manipulierte Preise/Daten: Betrag, Währung, Metadaten im Ereignis; falsche Stripe-Antwort bei der Erstellung → nie verbucht bzw. kein Link", async () => {
  const w = world(), { o, sid } = await openSession(w);
  const paid = w.stripe.pay(sid);
  const cases = [
    [{ amount_total: 100 }, "AMOUNT_MISMATCH"],
    [{ amount_total: 23999 }, "AMOUNT_MISMATCH"],
    [{ currency: "eur" }, "CURRENCY_MISMATCH"],
    [{ metadata: { ...paid.metadata, order_id: "RF480-20261021-ffffff" } }, "METADATA_MISMATCH"],
    [{ metadata: { ...paid.metadata, purpose: "OTHER" } }, "METADATA_MISMATCH"],
    [{ metadata: { ...paid.metadata, environment: "TEST" } }, "METADATA_MISMATCH"],
  ];
  for (const [i, [over]] of cases.entries()) await w.hook(evt("checkout.session.completed", paid, { id: `evt_manip_${i}_0000`, over }));
  await w.sync({ eventsOnly: true });
  assert.deepEqual(w.reviews(), cases.map((c) => c[1]));
  assert.equal(paymentsForOrder(w.store, o.order_id).length, 0);
  // Payment Link mit falschem Betrag (z. B. Rabatt/Anpassung im Dashboard)
  const w2 = world(), id = checkOrder(w2);
  await w2.hook(linkEvt({ ref: id, amount: 7500, pi: "pi_fixture075001", id: "evt_link_075001" }));
  await w2.sync({ eventsOnly: true });
  assert.deepEqual(w2.reviews(), ["AMOUNT_MISMATCH"]);
  // Stripe-Antwort weicht bei der Erstellung ab → BAD_RESPONSE, FAILED_CREATE, kein Zahlungslink an den Kunden
  for (const bad of [(s) => ({ ...s, amount_total: 100 }), (s) => ({ ...s, currency: "eur" }), (s) => ({ ...s, livemode: false }), (s) => ({ ...s, url: "https://evil.example/pay" })]) {
    const w3 = world(); w3.stripe.setTamper(bad);
    const o3 = liveOrder(w3); await w3.sync();
    assert.equal(w3.attempt(o3.order_id).status, "FAILED_CREATE");
    assert.equal(w3.attempt(o3.order_id).error_code, "BAD_RESPONSE");
    assert.equal(readPaymentLinks(w3.od).links[o3.order_id].url, undefined);
  }
});

test("Fehlende Umgebungsvariablen → NOT_CONFIGURED: kein Stripe-Aufruf, kein Link, Webhook 503, Status ohne Werte", async () => {
  const w = world({ env: {} }), o = liveOrder(w);
  await w.sync();
  assert.equal(w.stripe.calls.length, 0);
  assert.equal(w.attempt(o.order_id).status, "NOT_CONFIGURED");
  assert.equal(readPaymentLinks(w.od).links[o.order_id].status, "NOT_CONFIGURED");
  assert.deepEqual(stripeStatus({}), { provider: "stripe", live: "NOT_CONFIGURED", test: "NOT_CONFIGURED", webhook_live: "NOT_READY", webhook_test: "NOT_READY" });
  const nw = world({ whEnv: {} }), r = await nw.hook(evt("checkout.session.completed", { id: "cs_live_fixture9999", livemode: true }));
  assert.equal(r.status, 503); assert.equal(r.body.code, "PAYMENT_MONITOR_NOT_CONFIGURED");
  assert.equal(paymentsInboxClient({ config: { url: `${ORIGIN}/api/state` } }), null, "ohne Worker-Token keine Inbox");
  // nur LIVE-Webhook-Secret: TEST-Ereignisse werden abgelehnt (nie mit dem LIVE-Secret «akzeptiert»)
  const lw = world({ whEnv: { STRIPE_WEBHOOK_SECRET: WH.STRIPE_WEBHOOK_SECRET } });
  const t = await lw.hook(evt("checkout.session.completed", { id: "cs_test_fixture9999", livemode: false }), { secret: WH.STRIPE_TEST_WEBHOOK_SECRET });
  assert.equal(t.status, 400);
});

test("Verwechslung LIVE/TEST-Schlüssel → gilt als NICHT konfiguriert; Testauftrag nie LIVE; LIVE-Anfrage mit Test-Antwort abgelehnt", async () => {
  for (const env of [{ STRIPE_SECRET_KEY: "sk_test_fixture24" }, { STRIPE_SECRET_KEY: "pk_live_fixture24" }, { STRIPE_SECRET_KEY: "whsec_fixtLive24" }, { STRIPE_SECRET_KEY: " sk_live_ab" },
    { STRIPE_TEST_SECRET_KEY: "sk_live_fixture24" }]) {
    const w = world({ env }), o = liveOrder(w);
    await w.sync();
    assert.equal(w.stripe.calls.length, 0, JSON.stringify(Object.keys(env)));
    assert.equal(w.attempt(o.order_id).status, "NOT_CONFIGURED");
  }
  assert.equal(stripeStatus({ STRIPE_SECRET_KEY: "sk_test_fixture24", STRIPE_TEST_SECRET_KEY: "sk_live_fixture24" }).live, "NOT_CONFIGURED");
  assert.equal(stripeStatus({ STRIPE_SECRET_KEY: "rk_live_fixture24" }).live, "CONFIGURED", "eingeschränkter LIVE-Schlüssel (rk_live_) wird unterstützt");
  const f = fakeStripe(), order = { order_id: "RF480-20261021-abc024", offer_class: "REPAIR_FIX_500", market: "CH" };
  await assert.rejects(createCheckoutSession({ env: KEYS, order, mode: "TEST", origin: ORIGIN, now: T0, fetchFn: f.fetchFn }), (e) => e.code === "MODE_MISMATCH");
  await assert.rejects(createCheckoutSession({ env: KEYS, order: { ...order, test_order: true }, mode: "LIVE", origin: ORIGIN, now: T0, fetchFn: f.fetchFn }), (e) => e.code === "MODE_MISMATCH");
  assert.equal(f.calls.length, 0);
  f.setTamper((s) => ({ ...s, livemode: false }));
  await assert.rejects(createCheckoutSession({ env: KEYS, order, origin: ORIGIN, now: T0, fetchFn: f.fetchFn }), (e) => e.code === "BAD_RESPONSE");
});

test("Keine Secrets in Logs, Zustand, Zahlungsbuch, Übergabedatei, Status oder Fehlermeldungen", async () => {
  const w = world(), { sid } = await openSession(w);
  await w.hook(evt("checkout.session.completed", w.stripe.pay(sid))); await w.sync();
  const rejected = await createCheckoutSession({ env: KEYS, order: { order_id: "RF480-20261021-abc099", offer_class: "REPAIR_FIX_500", market: "CH" }, origin: ORIGIN, now: T0,
    fetchFn: async () => json(400, { error: { code: "parameter_invalid", message: `bad key ${KEYS.STRIPE_SECRET_KEY}` } }) }).catch((e) => e);
  const hay = [w.logs.join("\n"), JSON.stringify(w.st()), JSON.stringify(w.store.read(PAYMENTS_FILE, {})), fs.readFileSync(path.join(w.od, fs.readdirSync(w.od).find((x) => /payment/.test(x))), "utf8"),
    JSON.stringify(stripeServiceStatus({ dir: w.dir, env: { ...KEYS, ...WH } })), JSON.stringify(stripeStatus({ ...KEYS, ...WH })), String(rejected.message)].join("\n");
  for (const s of [...Object.values(KEYS), ...Object.values(WH), WT]) assert.ok(!hay.includes(s), "Secret darf nirgends auftauchen");
  assert.equal(rejected.code, "REJECTED");
});

test("payment-reconcile.js pull: Checkout-Ereignisse bleiben für den Repair-Service liegen (nie im falschen Zustand quittiert), Altereignisse werden abgeglichen", async () => {
  const w = world(), id = checkOrder(w);
  await w.hook(linkEvt({ ref: id, amount: 15000, pi: "pi_fixture150777", id: "evt_link_150777" }));                              // Checkout → stripe-evt:…
  const legacy = { id: "evt_legacy_pi0001", object: "event", type: "payment_intent.succeeded", livemode: true, created: sec(T0),
    data: { object: { id: "pi_legacy000001", object: "payment_intent", status: "succeeded", amount_received: 5000, currency: "chf", created: sec(T0), metadata: {} } } };
  await w.hook(legacy);                                                                                                         // Altpfad TF-068
  assert.equal(await w.pending(), 2);
  const srv = http.createServer(async (req, res) => {
    let b = ""; for await (const c of req) b += c;
    const r = await w.handler(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: { "content-type": "application/json", ...(req.headers["x-jarvis-worker"] ? { "x-jarvis-worker": req.headers["x-jarvis-worker"] } : {}) }, body: req.method === "POST" ? b : undefined }));
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text());
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const secrets = tmp();
  try {
    const out = await new Promise((resolve) => execFile(process.execPath, [path.join(ROOT, "payment-reconcile.js"), "pull"], { cwd: ROOT, timeout: 30_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, JARVIS_SECRETS_DIR: secrets, JARVIS_CLOUD_URL: `http://127.0.0.1:${srv.address().port}`, JARVIS_MAIL_WORKER_TOKEN: WT,
        STRIPE_WEBHOOK_SECRET: WH.STRIPE_WEBHOOK_SECRET } }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    assert.equal(out.err, null, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim().split("\n").at(-1)), { events: 1, checkout_events_left_for_repair_service: 1, BOOKED: 0, DUPLICATE: 0, PAYMENT_REVIEW_REQUIRED: 1, IGNORED: 0 });
  } finally { srv.close(); }
  const left = await w.inbox.pull();
  assert.deepEqual(left.map((e) => e.key), ["stripe-evt:evt_link_150777"], "nur das Checkout-Ereignis bleibt offen");
  assert.equal(fs.existsSync(path.join(secrets, "mail_worker", STRIPE_FILE)), false, "CLI legt keinen fremden Stripe-Zustand an");
  // …und der Repair-Service verbucht es danach regulär
  assert.equal((await w.sync({ eventsOnly: true })).booked, 1);
  assert.equal(paymentsForOrder(w.store, id)[0].amount, 150);
});

test("Installationsskript: LIVE nur nach lesender Vorprüfung + getippter Freigabe, Rollback live-off, nie Werte ausgeben", () => {
  const sh = fs.readFileSync(path.join(ROOT, "deploy", "vps", "install-stripe-keys.sh"), "utf8");
  const live = sh.split("\n").find((l) => /^\s*live\)/.test(l));
  assert.ok(live.indexOf("preflight_live") < live.indexOf("confirm_live") && live.indexOf("confirm_live") < live.indexOf("set_secret"), "Reihenfolge Vorprüfung → Freigabe → Eingabe");
  assert.match(sh, /\[ "\$c" = "LIVE AKTIVIEREN" \] \|\| \{ echo "Nicht bestätigt – nichts geändert."; exit 1; \}/);
  assert.match(sh, /^\s*live-off\)/m);
  assert.match(sh, /nicht gesetzt – nichts geändert."; exit 3;/); assert.match(sh, /if \[ "\$rc" -eq 0 \]; then restart_repair; elif \[ "\$rc" -eq 3 \]/, "live-off startet nur nach echter Entfernung neu");
  assert.match(sh, /case "\$K" in STRIPE_SECRET_KEY\|STRIPE_TEST_SECRET_KEY\) ;;/, "Rollback nur für Stripe-Schlüssel");
  assert.match(sh, /read -rs -p/, "verdeckte Eingabe");
  assert.match(sh, /"\$SSH" -n "\$HOST" "sudo docker exec jarvis-repair-worker node stripe-webhook\.js status"/, "Vorprüfung liest nie die folgenden Eingaben (Bestätigung/Schlüssel) mit");
  assert.doesNotMatch(sh, /echo "\$v"|echo "\$V"|set -x/, "nie Werte ausgeben");
  assert.match(sh, /\^\(sk\|rk\)_live_/); assert.match(sh, /\^\(sk\|rk\)_test_/);
  // Syntaxprüfung nur unter Linux/macOS (CI) – «bash» ist unter Windows oft WSL.
  if (process.platform !== "win32") { const bash = spawnSync("bash", ["-n", path.join(ROOT, "deploy", "vps", "install-stripe-keys.sh")], { encoding: "utf8" }); if (!bash.error) assert.equal(bash.status, 0, bash.stderr); }
});

test("cleanup", () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
