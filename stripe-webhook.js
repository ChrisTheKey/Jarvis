// TF-080 – Stripe-Anzahlung im Repair-Service: Checkout anlegen (genau eine aktive Session je Auftrag), signierte Ereignisse aus der Inbox
// (/api/payments, Netlify prüft die Signatur) bzw. autoritativen Abgleich direkt bei Stripe prüfen und erst dann über payments.js recordPayment verbuchen.
// Danach öffnet das bestehende CHF-240-Gate (repair-workflow.js) den sicheren Zugangslink wie bei jeder Zahlung – unverändert.
//
// Fail closed – verbucht wird NUR, wenn ALLES stimmt: bekannte Session dieses Auftrags · gleicher Modus (LIVE/TEST) · Auftrag existiert und ist
// Test ↔ TEST · metadata.order_id/purpose/environment passen · CHF · Betrag = erwartete Anzahlung · payment_status paid. Sonst Prüfeintrag, nichts verbucht.
// Die Rückkehrseite des Browsers (zahlung.html) ist nie ein Beleg. Rückerstattung/Streitfall → PAYMENT_REVIEW_REQUIRED (nie automatisch erstatten).
// Idempotenz: Ereignis-ID dauerhaft verarbeitet; Zahlungsreferenz stripe:<payment_intent> (Duplikatschutz payments.js) – ein Absturz zwischen Verbuchung
// und Quittung führt beim erneuten Ereignis zu «bereits verbucht», nie zu einer zweiten Buchung. Gespeichert werden nur sichere Metadaten.
//
//   node stripe-webhook.js status    Stripe LIVE/TEST konfiguriert?, Webhook-Inbox erreichbar?, Zähler (nie Werte/Fragmente)
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, WORKER_DIR } from "./mail-worker.js";
import { recordPayment, findPayableOrder, paymentGateForOrder, paymentsForOrder } from "./payments.js";
import { fromMinor, toMinor, offerInfo } from "./pricing.js";
import { REPAIR_ORDERS_FILE, COMPLETED_STATES, BLOCKED_STATES, REPAIR_CANCELLED, holdForPaymentReview, createConfirmedRepairOrder } from "./repair-workflow.js";
import { createCheckoutSession, retrieveCheckoutSession, modeConfigured, modeOfOrder, expectedDeposit, stripeStatus, PURPOSE } from "./stripe-payments.js";
import { writePaymentLinks, readPaymentLinks } from "./onboarding-store.js";
import { e2eConfig, isE2eDomain } from "./e2e-test.js";
import { bundleForIntent, selectOfferIntent } from "./sales-intake-bundle.js";
import { createCheck150Order, CHECK150_OFFER } from "./check-150-workflow.js";
import { recordDirectSale } from "./sales.js";

export const STRIPE_FILE = "stripe_checkouts.json";
export const MAX_SESSIONS = 2;             // erste Session + höchstens EINE Ersatz-Session nach Ablauf (zurückhaltende Erinnerung)
export const RECONCILE_EVERY_MS = 10 * 60_000;
const empty = () => ({ schema: 1, attempts: {}, sessions: {}, events: {}, reviews: [], static: {} });
const load = (store) => ({ ...empty(), ...store.read(STRIPE_FILE, empty()) });
const isoOr = (v, fb = null) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fb);

// Inbox-Client (gleicher Worker-Token wie access-intake) – nur pull/ack, nie Inhalte loggen.
export function paymentsInboxClient({ config, fetchFn = globalThis.fetch } = {}) {
  if (!config?.workerToken || !config?.url) return null;
  const origin = config.url.replace(/\/api\/state$/, "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return null;
  const post = async (body) => {
    const r = await fetchFn(origin + "/api/payments", { method: "POST", headers: { "content-type": "application/json", "x-jarvis-worker": config.workerToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`payments HTTP ${r.status}`);
    return r.json();
  };
  return { origin, pull: async () => (await post({ op: "inbox.pull" })).events || [], ack: (keys) => post({ op: "inbox.ack", keys }) };
}

// Anzahlungs-fähiger Auftrag: CH-«Check & Reparatur» aus dem Kontaktformular-Weg, bestätigt, nicht abgeschlossen/blockiert/storniert.
const payableOrder = (o) => !!o?.order_id && !!o.contact_form?.key && !!expectedDeposit(o) && !!o.confirmed && !COMPLETED_STATES.includes(o.state)
  && o.state !== REPAIR_CANCELLED && !BLOCKED_STATES.includes(o.state);

// ---------- Prüfung + Verbuchung ----------
// sess: sichere Session-Felder (Webhook-Ereignis oder Abgleich): session_id/id, provider_mode, amount_minor, currency, payment_status, payment_intent, metadata.
export function bookCheckout(store, st, sess, { source = "webhook", now = new Date(), log = () => {} } = {}) {
  const sid = sess.session_id || sess.id;
  const orderId = st.sessions[sid];
  const a = orderId ? st.attempts[orderId] : null;
  const review = (code, order_id = orderId || null) => {
    st.reviews = [...(st.reviews || []), { at: now.toISOString(), code, order_id, session_id: sid || null, event_id: sess.event_id || null, provider_mode: sess.provider_mode || null, status: "OPEN" }].slice(-500);
    log("warn", "stripe_payment_review", { code, order_id, event_id: sess.event_id || null });
    return { result: "PAYMENT_REVIEW_REQUIRED", code, order_id };
  };
  if (!orderId && sess.payment_link) return bookStaticLink(store, st, sess, { source, now, log }, review); // TF-081: statischer Payment Link
  if (!a || !(a.history || []).some((h) => h.checkout_session_id === sid)) return review("UNKNOWN_SESSION", null);
  if (sess.provider_mode !== a.provider_mode) return review("MODE_MISMATCH");
  const order = findPayableOrder(store, a.order_id);
  if (!order) return review("UNKNOWN_ORDER");
  if ((order.test_order === true) !== (a.provider_mode === "TEST")) return review("MODE_MISMATCH");
  const m = sess.metadata || {};
  if (m.order_id !== a.order_id || m.purpose !== PURPOSE || m.environment !== a.provider_mode) return review("METADATA_MISMATCH");
  const full = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders?.[a.order_id];
  const exp = expectedDeposit(full || order);
  if (!exp || sess.currency !== exp.currency || order.currency !== exp.currency) return review("CURRENCY_MISMATCH");
  if (sess.amount_minor !== exp.amount_minor) return review("AMOUNT_MISMATCH");
  if (sess.payment_status !== "paid") return review("NOT_PAID");
  const reference = `stripe:${sess.payment_intent || sid}`;
  let payment_id = null, dup = false;
  try {
    payment_id = recordPayment(store, { order_id: a.order_id, amount: fromMinor(sess.amount_minor, "CHF"), currency: "CHF", source: a.provider_mode === "TEST" ? "stripe_test_checkout" : "stripe_checkout",
      reference, received_at: isoOr(sess.created_at, now.toISOString()), provider_mode: a.provider_mode, now }).payment_id;
  } catch (e) {
    if (!/Doppelte Zahlungsreferenz/.test(e.message)) return review("BOOKING_FAILED");
    dup = true; // bereits verbucht (Wiederholung/Absturz vor der Quittung) – nie ein zweiter Eintrag
    payment_id = paymentsForOrder(store, a.order_id).find((p) => String(p.reference || "").toLowerCase() === reference.toLowerCase())?.payment_id || null;
  }
  const h = a.history.find((x) => x.checkout_session_id === sid);
  Object.assign(h, { status: "PAID", closed_at: h.closed_at || now.toISOString() });
  Object.assign(a, { status: "PAID", paid_at: a.paid_at || now.toISOString(), payment_id, payment_intent_id: sess.payment_intent || null, paid_session_id: sid, updated_at: now.toISOString() });
  log("info", "stripe_payment_booked", { order_id: a.order_id, provider_mode: a.provider_mode, source, duplicate: dup });
  return { result: dup ? "ALREADY_RECORDED" : "BOOKED", order_id: a.order_id, payment_id };
}

// TF-081 – Zahlung über einen STATISCHEN Stripe Payment Link (CHF 150 / 480). Der Link trägt `client_reference_id=<order_id>`. Fail closed: verbucht wird NUR,
// wenn die ID exakt einen echten Auftrag trifft · Modus (LIVE/TEST) zum Auftrag passt · CHF · Betrag = voller Festpreis des Auftrags (aus pricing.js) · paid ·
// Auftrag weder abgeschlossen/storniert/blockiert · das Zahlungs-Gate noch NICHT erfüllt (sonst DUPLICATE_PAYMENT → Prüfung, nie eine zweite Buchung).
// Alles andere (keine/ungültige Referenz, anderer Betrag, Fremdwährung, unbekannter Auftrag) → PAYMENT_REVIEW_REQUIRED, nichts verbucht.
// Idempotenz: Ereignis-ID (processCheckoutEvent) + Referenz stripe:<payment_intent> (payments.js). Rückerstattung/Streitfall findet die Zahlung über st.static.
function materializeBundleOrder(store, intentId, bundle, offer, now) {
  const args = { domain: bundle.domain, website: bundle.website, company: bundle.company, delivery_email: bundle.email, contact_name: bundle.contact_name, lead_id: bundle.lead_id, order_id: intentId, now };
  if (offer === CHECK150_OFFER) {
    const sales = store.read("sales.json", { records: {} });
    const records = recordDirectSale(sales.records || {}, { domain: bundle.domain, offer: CHECK150_OFFER, delivery_email: bundle.email, company: bundle.company, contact_name: bundle.contact_name, website: bundle.website, lead: { lead_id: bundle.lead_id }, now });
    const order = createCheck150Order(store, { ...args, offer_class: CHECK150_OFFER });
    store.write("sales.json", { ...sales, records });
    return order;
  }
  const order = createConfirmedRepairOrder(store, args);
  if (bundle.vault?.token_hash && bundle.vault.expires_at) {
    const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
    data.orders[order.order_id] = { ...data.orders[order.order_id], prebound_access: { token_hash: bundle.vault.token_hash, expires_at: bundle.vault.expires_at, source: "sales_intake_bundle" } };
    store.write(REPAIR_ORDERS_FILE, data);
    return data.orders[order.order_id];
  }
  return order;
}

function bookStaticLink(store, st, sess, { source, now, log }, review) {
  const sid = sess.session_id || sess.id, oid = sess.client_reference_id;
  if (!oid) return review("PAYMENT_LINK_NO_REFERENCE", null);
  let order = findPayableOrder(store, oid);
  const bundle = bundleForIntent(store, oid);
  if (!order && bundle) {
    const intent = Object.entries(bundle.offers || {}).find(([, entry]) => entry.intent_id === oid);
    const info = intent ? offerInfo(intent[0]) : null;
    if (!info || info.market !== "CH" || info.currency !== "CHF" || sess.currency !== "CHF") return review("CURRENCY_MISMATCH", oid);
    if (sess.amount_minor !== toMinor(info.price, "CHF")) return review("AMOUNT_MISMATCH", oid);
    if (sess.payment_status !== "paid") return review("NOT_PAID", oid);
    const selected = selectOfferIntent(store, oid, { now });
    if (selected.result === "OFFER_CLOSED") return review("OFFER_CLOSED", oid);
    if (!["SELECTED", "ALREADY_SELECTED"].includes(selected.result)) return review("UNKNOWN_ORDER", oid);
    try { order = materializeBundleOrder(store, oid, bundle, intent[0], now); }
    catch (e) { log("error", "sales_bundle_materialization_failed", { order_id: oid, error: String(e.message).slice(0, 160) }); return review("ORDER_MATERIALIZATION_FAILED", oid); }
  }
  if (!order) return review("UNKNOWN_ORDER", null);
  if (sess.provider_mode !== modeOfOrder(order)) return review("MODE_MISMATCH", oid);
  const full = store.read(order.file, { orders: {} }).orders?.[oid] || {};
  if (COMPLETED_STATES.includes(order.state) || order.state === REPAIR_CANCELLED || (/^RF480-/.test(oid) && BLOCKED_STATES.includes(order.state))) return review("ORDER_NOT_PAYABLE", oid);
  const info = offerInfo(order.offer_class);
  if (!info || info.market !== "CH" || info.currency !== "CHF" || sess.currency !== "CHF" || order.currency !== "CHF") return review("CURRENCY_MISMATCH", oid);
  if (sess.amount_minor !== toMinor(info.price, "CHF")) return review("AMOUNT_MISMATCH", oid);
  if (sess.payment_status !== "paid") return review("NOT_PAID", oid);
  const reference = `stripe:${sess.payment_intent || sid}`;
  const already = paymentsForOrder(store, oid).find((p) => String(p.reference || "").toLowerCase() === reference.toLowerCase());
  if (already) return { result: "ALREADY_RECORDED", order_id: oid, payment_id: already.payment_id };
  if (paymentGateForOrder(store, { ...full, ...order }).satisfied) return review("DUPLICATE_PAYMENT", oid);
  let payment_id;
  try {
    payment_id = recordPayment(store, { order_id: oid, amount: fromMinor(sess.amount_minor, "CHF"), currency: "CHF", source: sess.provider_mode === "TEST" ? "stripe_test_payment_link" : "stripe_payment_link",
      reference, received_at: isoOr(sess.created_at, now.toISOString()), provider_mode: sess.provider_mode, now }).payment_id;
  } catch (e) {
    if (/Doppelte Zahlungsreferenz/.test(e.message)) return { result: "ALREADY_RECORDED", order_id: oid, payment_id: null };
    return review("BOOKING_FAILED", oid);
  }
  st.static = { ...(st.static || {}), [oid]: { session_id: sid, payment_intent: sess.payment_intent || null, provider_mode: sess.provider_mode, payment_id, at: now.toISOString() } };
  log("info", "stripe_payment_booked", { order_id: oid, provider_mode: sess.provider_mode, source, via: "payment_link" });
  return { result: "BOOKED", order_id: oid, payment_id };
}

// Ein normalisiertes Ereignis (stripe-payments.normalizeCheckoutEvent) – idempotent je Ereignis-ID.
export function processCheckoutEvent(store, st, ev, { now = new Date(), log = () => {} } = {}) {
  if (!ev?.event_id) return { result: "IGNORED", code: "NO_EVENT_ID" };
  if (st.events[ev.event_id]) return { ...st.events[ev.event_id], result: "DUPLICATE_EVENT" };
  let r;
  if (ev.kind === "CHECKOUT_PAID") r = bookCheckout(store, st, ev, { source: "webhook", now, log });
  else if (ev.kind === "CHECKOUT_EXPIRED" || ev.kind === "CHECKOUT_FAILED") r = closeSession(st, ev.session_id, ev.kind === "CHECKOUT_EXPIRED" ? "EXPIRED" : "FAILED", ev.provider_mode, now);
  else if (ev.kind === "REFUND" || ev.kind === "DISPUTE") r = reversal(store, st, ev, { now, log });
  else r = { result: "IGNORED", code: ev.kind || "UNKNOWN" };
  st.events[ev.event_id] = { at: now.toISOString(), result: r.result, code: r.code || null, order_id: r.order_id || null };
  return r;
}
function closeSession(st, sid, status, mode, now) {
  const orderId = st.sessions[sid];
  const a = orderId ? st.attempts[orderId] : null;
  if (!a || (mode && a.provider_mode !== mode)) return { result: "IGNORED", code: "UNKNOWN_SESSION" };
  const h = (a.history || []).find((x) => x.checkout_session_id === sid);
  if (!h || h.status !== "OPEN") return { result: "IGNORED", code: "NOT_OPEN", order_id: orderId };
  Object.assign(h, { status, closed_at: now.toISOString() });
  if (a.checkout_session_id === sid && a.status === "OPEN") Object.assign(a, { status, updated_at: now.toISOString() });
  return { result: status, order_id: orderId };
}
// Rückerstattung/Streitfall: nie automatisch verbucht/erstattet. Zuordnung nur über die eigene PaymentIntent-ID → Auftrag anhalten (Chris).
function reversal(store, st, ev, { now, log }) {
  const a = Object.values(st.attempts).find((x) => x.payment_intent_id && x.payment_intent_id === ev.payment_intent && x.provider_mode === ev.provider_mode);
  const sp = !a && ev.payment_intent ? Object.entries(st.static || {}).find(([, x]) => x.payment_intent && x.payment_intent === ev.payment_intent && x.provider_mode === ev.provider_mode) : null; // TF-081
  if (sp) { const h = holdForPaymentReview(store, sp[0], { reason: `Stripe ${ev.kind === "REFUND" ? "Rückerstattung" : "Streitfall (Dispute)"} zur Zahlung über Payment Link gemeldet`, now });
    st.reviews = [...(st.reviews || []), { at: now.toISOString(), code: ev.kind === "REFUND" ? "REFUND_REVIEW_REQUIRED" : "DISPUTE_REVIEW_REQUIRED", order_id: sp[0], event_id: ev.event_id, provider_mode: ev.provider_mode, status: "OPEN" }].slice(-500);
    log("warn", "stripe_reversal", { order_id: sp[0], kind: ev.kind, held: h.held }); return { result: "PAYMENT_REVIEW_REQUIRED", code: ev.kind, order_id: sp[0] }; }
  st.reviews = [...(st.reviews || []), { at: now.toISOString(), code: ev.kind === "REFUND" ? "REFUND_REVIEW_REQUIRED" : "DISPUTE_REVIEW_REQUIRED", order_id: a?.order_id || null,
    event_id: ev.event_id, provider_mode: ev.provider_mode, status: "OPEN" }].slice(-500);
  if (!a) { log("warn", "stripe_reversal_unmatched", { event_id: ev.event_id }); return { result: "PAYMENT_REVIEW_REQUIRED", code: "UNMATCHED_REVERSAL" }; }
  const h = holdForPaymentReview(store, a.order_id, { reason: `Stripe ${ev.kind === "REFUND" ? "Rückerstattung" : "Streitfall (Dispute)"} zur Anzahlung gemeldet`, now });
  a.reversal = { kind: ev.kind, at: now.toISOString() };
  log("warn", "stripe_reversal", { order_id: a.order_id, kind: ev.kind, held: h.held });
  return { result: "PAYMENT_REVIEW_REQUIRED", code: ev.kind, order_id: a.order_id };
}

// ---------- Ein Durchlauf (Repair-Service) ----------
// env: Stripe-Schlüssel (nur hier gelesen), inbox: paymentsInboxClient, origin: Rückkehr-Adresse (Netlify-Site), fetchFn: Stripe-API (Tests: Attrappe).
export async function syncStripePayments({ dir = WORKER_DIR, onboardingDir = null, env = process.env, inbox = null, origin = null, fetchFn = globalThis.fetch,
  e2e = e2eConfig(env), eventsOnly = false, now = new Date(), log = () => {} } = {}) {
  const store = createStore(dir);
  const st = load(store);
  const out = { events: 0, booked: 0, reviews: 0, created: 0, reconciled: 0, degraded: null };
  const save = () => store.write(STRIPE_FILE, st);
  const fresh = {}; // Checkout-Links nur im Speicher dieses Laufs → Übergabedatei (nie im Repair-Zustand gespeichert)
  // 1) Signierte Ereignisse (Netlify-Inbox) – nur Checkout-Ereignisse; TF-068-Altereignisse bleiben für payment-reconcile.js liegen.
  if (inbox) {
    try {
      const evs = (await inbox.pull()).filter((e) => typeof e?.key === "string" && e.key.startsWith("stripe-evt:") && e.tx?.event_id);
      const done = [];
      for (const e of evs) {
        const r = processCheckoutEvent(store, st, e.tx, { now, log });
        save(); // nach JEDEM Ereignis (Absturz → erneutes Ereignis ist DUPLICATE_EVENT bzw. ALREADY_RECORDED)
        done.push(e.key); out.events++;
        if (r.result === "BOOKED") out.booked++;
        if (r.result === "PAYMENT_REVIEW_REQUIRED") out.reviews++;
      }
      if (done.length) await inbox.ack(done);
    } catch (e) { out.degraded = String(e.message).slice(0, 120); log("warn", "stripe_inbox_degraded", { error: out.degraded }); }
  }
  if (eventsOnly) return out;
  // 2) Checkout je Auftrag (genau eine aktive Session) + autoritativer Abgleich offener Sessions direkt bei Stripe.
  const orders = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders || {};
  for (const o of Object.values(orders)) {
    if (!payableOrder(o)) continue;
    const mode = modeOfOrder(o);
    let a = st.attempts[o.order_id];
    const gate = paymentGateForOrder(store, o);
    if (gate.satisfied) { if (a && a.status !== "PAID") { a.status = "PAID"; a.paid_at ||= now.toISOString(); a.updated_at = now.toISOString(); save(); } continue; } // z. B. Banküberweisung von Chris
    if (a?.status === "PAID") continue; // Zahlung verbucht, Gate noch nicht (z. B. Rückerstattung markiert) → nie eine neue Session
    if (!a) { a = st.attempts[o.order_id] = { order_id: o.order_id, provider: "stripe", provider_mode: mode, purpose: PURPOSE, seq: 0, status: "PENDING", history: [], created_at: now.toISOString() }; save(); }
    if (a.provider_mode !== mode) { a.status = "REVIEW"; a.error_code = "MODE_CHANGED"; save(); continue; } // nie umschalten
    if (mode === "TEST" && !isE2eDomain(e2e, o.domain)) { if (a.status !== "TEST_BLOCKED") { a.status = "TEST_BLOCKED"; a.updated_at = now.toISOString(); save(); } continue; }
    // Offene Session: periodisch bzw. nach Ablauf bei Stripe abgleichen (Abgleich gilt wie ein Ereignis – nie die Browser-Rückkehr).
    if (a.status === "OPEN") {
      const due = +now - Date.parse(a.checked_at || a.created_at || 0) >= RECONCILE_EVERY_MS || Date.parse(a.expires_at || 0) <= +now;
      if (due && modeConfigured(env, mode)) {
        try {
          const s = await retrieveCheckoutSession({ env, mode, id: a.checkout_session_id, fetchFn });
          a.checked_at = now.toISOString(); out.reconciled++;
          if (s?.status === "complete" && s.payment_status === "paid") {
            const r = bookCheckout(store, st, { ...s, session_id: s.id, provider_mode: s.livemode ? "LIVE" : "TEST", created_at: now.toISOString() }, { source: "reconcile", now, log });
            if (r.result === "BOOKED") out.booked++; if (r.result === "PAYMENT_REVIEW_REQUIRED") out.reviews++;
          } else if (s?.status === "expired") closeSession(st, a.checkout_session_id, "EXPIRED", mode, now);
          else if (s?.url) fresh[a.checkout_session_id] = s.url;
          save();
        } catch (e) { if (e.code === "TRANSIENT") out.degraded ||= "stripe_unreachable"; a.checked_at = now.toISOString(); save(); }
      }
      if (a.status === "OPEN" || a.status === "PAID") continue;
    }
    if (a.status === "EXPIRED" || a.status === "FAILED") { if (a.seq >= MAX_SESSIONS) { a.status = "EXPIRED_FINAL"; a.updated_at = now.toISOString(); save(); } }
    if (["EXPIRED_FINAL", "REVIEW", "FAILED_CREATE"].includes(a.status)) continue; // keine weitere Session – Chris klärt (Hinweis über den Kundenweg)
    if (!modeConfigured(env, mode)) { if (a.status !== "NOT_CONFIGURED") { a.status = "NOT_CONFIGURED"; a.updated_at = now.toISOString(); save(); log("info", "stripe_not_configured", { order_id: o.order_id, provider_mode: mode }); } continue; }
    // Neue Session (erste bzw. EINE Ersatz-Session). CREATING vor dem Aufruf persistiert; derselbe Idempotenz-Schlüssel liefert nach einem Absturz dieselbe Session.
    if (a.status !== "CREATING") { a.seq = (a.seq || 0) + 1; a.status = "CREATING"; a.creating_at = now.toISOString(); save(); }
    else if (+now - Date.parse(a.creating_at || 0) > 24 * 3600_000) { a.status = "REVIEW"; a.error_code = "CREATE_STALE"; save(); continue; }
    try {
      const s = await createCheckoutSession({ env, order: o, mode, seq: a.seq, origin, now, fetchFn });
      if (st.sessions[s.id] && st.sessions[s.id] !== o.order_id) throw Object.assign(new Error("Session gehört einem anderen Auftrag."), { code: "BAD_RESPONSE" });
      st.sessions[s.id] = o.order_id;
      a.history = [...(a.history || []).filter((h) => h.checkout_session_id !== s.id), { seq: a.seq, checkout_session_id: s.id, status: "OPEN", created_at: now.toISOString(), expires_at: s.expires_at }];
      Object.assign(a, { status: "OPEN", checkout_session_id: s.id, expires_at: s.expires_at, created_at: a.created_at, checked_at: now.toISOString(), error_code: null, updated_at: now.toISOString() });
      fresh[s.id] = s.url; save(); out.created++;
      log("info", "stripe_checkout_created", { order_id: o.order_id, provider_mode: mode, seq: a.seq });
    } catch (e) {
      if (e.code === "TRANSIENT" || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|aborted|timeout/i.test(String(e.message))) { out.degraded ||= "stripe_unreachable"; continue; } // CREATING bleibt → gleicher Schlüssel
      a.status = "FAILED_CREATE"; a.error_code = String(e.code || "REJECTED").slice(0, 30); a.updated_at = now.toISOString(); save();
      log("error", "stripe_checkout_failed", { order_id: o.order_id, provider_mode: mode, code: a.error_code });
    }
  }
  // 3) Übergabe an den Mail-Worker (Zahlungs-Mail im Kontaktformular-Verlauf). Link nur solange offen; Statuswort sonst.
  if (onboardingDir) writePaymentLinks(onboardingDir, paymentLinksOf(st, orders, { prev: readPaymentLinks(onboardingDir).links || {}, fresh }), { now });
  return out;
}
const LINK_STATUS = { PENDING: "PENDING", CREATING: "PENDING", OPEN: "OPEN", PAID: "PAID", EXPIRED: "EXPIRED", FAILED: "EXPIRED", EXPIRED_FINAL: "EXPIRED_FINAL",
  NOT_CONFIGURED: "NOT_CONFIGURED", FAILED_CREATE: "FAILED", TEST_BLOCKED: "TEST_BLOCKED", REVIEW: "REVIEW" };
export function paymentLinksOf(st, orders = {}, { prev = {}, fresh = {} } = {}) {
  const links = {};
  for (const a of Object.values(st.attempts || {})) {
    if (!orders[a.order_id]) continue;
    const status = LINK_STATUS[a.status] || "REVIEW";
    links[a.order_id] = { status, provider_mode: a.provider_mode, seq: a.seq || 0, expires_at: status === "OPEN" ? a.expires_at || null : null,
      checkout_session_id: status === "OPEN" ? a.checkout_session_id : null };
    const url = status === "OPEN" ? fresh[a.checkout_session_id] || (prev[a.order_id]?.checkout_session_id === a.checkout_session_id ? prev[a.order_id]?.url : null) : null;
    if (typeof url === "string" && /^https:\/\/checkout\.stripe\.com\//.test(url)) links[a.order_id].url = url;
  }
  return links;
}

// Owner-Status (nur Wörter/Zähler).
export function stripeServiceStatus({ dir = WORKER_DIR, env = process.env } = {}) {
  const st = load(createStore(dir));
  const by = {}; for (const a of Object.values(st.attempts)) by[a.status] = (by[a.status] || 0) + 1;
  return { ...stripeStatus(env), webhook_inbox: env.JARVIS_MAIL_WORKER_TOKEN ? "READY" : "NOT_READY", // Abholung der signierten Ereignisse aus /api/payments (Worker-Token)
    attempts: by, events_processed: Object.keys(st.events).length, open_reviews: (st.reviews || []).filter((r) => r.status === "OPEN").length };
}
export { readPaymentLinks };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "status") console.log(JSON.stringify(stripeServiceStatus(), null, 2));
  else { console.log("Befehle: status"); process.exit(1); }
}
