// TF-080 – Stripe Checkout (Swiss CHF) als schmaler Zahlungsanbieter. OHNE Abhängigkeiten ausser node:crypto und pricing.js
// (läuft im Repair-Service, in der Netlify Function /api/payments und in Tests – Tests rufen nie das Netz auf, fetchFn wird injiziert).
//
// Grundsätze (fail closed):
//   - payments.js bleibt das EINZIGE Zahlungsbuch. Stripe liefert nur autoritative externe Ereignisse; verbucht wird ausschliesslich über
//     recordPayment (stripe-webhook.js) – nach Prüfung von Sitzung, Modus, Auftrag, Zweck, Währung CHF und Betrag.
//   - Betrag/Auftrag kommen NIE aus dem Browser: die Checkout-Session wird serverseitig aus dem Jarvis-Auftrag erzeugt (Anzahlung = erste Hälfte
//     des Festpreises aus pricing.js, REPAIR_FIX_500 → CHF 240.00). Stripe-gehostete Checkout-Seite – kein eigenes Kartenformular, keine Kartendaten.
//   - Modi strikt getrennt: LIVE nur mit sk_live_/rk_live_-Schlüssel, TEST nur mit sk_test_/rk_test_-Schlüssel. Ein falsch präfixierter Schlüssel
//     gilt als NICHT konfiguriert (ein TEST-Auftrag kann so nie live belastet werden und umgekehrt).
//   - Secrets nur aus der Umgebung (VPS-Datei /opt/jarvis-payment/stripe.env bzw. Netlify-Env), nie in Git/State/CRM/Logs/Browser. Hier wird kein
//     Schlüsselwert zurückgegeben oder geloggt – Status nur CONFIGURED/NOT_CONFIGURED.
//   - Zahlungsarten bestimmt das Stripe-Konto (dynamische Zahlungsarten: Karte, TWINT, … sofern dort aktiviert) – nichts hart kodiert.
import crypto from "node:crypto";
import { offerInfo, toMinor, ORDER_ID_RE } from "./pricing.js";
import { assertExternalCapability } from "./security-capabilities.js";

export const MODES = Object.freeze(["LIVE", "TEST"]);
export const PURPOSE = "REPAIR_DEPOSIT";
export const DEPOSIT_OFFER = "REPAIR_FIX_500";
export const API = "https://api.stripe.com/v1";
export const SESSION_TTL_S = 23 * 3600; // Stripe erlaubt 30 min – 24 h
const KEY_ENV = Object.freeze({ LIVE: "STRIPE_SECRET_KEY", TEST: "STRIPE_TEST_SECRET_KEY" });
const KEY_RE = Object.freeze({ LIVE: /^(sk|rk)_live_[A-Za-z0-9]{8,}$/, TEST: /^(sk|rk)_test_[A-Za-z0-9]{8,}$/ });
export const WEBHOOK_ENV = Object.freeze({ LIVE: "STRIPE_WEBHOOK_SECRET", TEST: "STRIPE_TEST_WEBHOOK_SECRET" });
const SESSION_RE = Object.freeze({ LIVE: /^cs_live_[A-Za-z0-9]{8,200}$/, TEST: /^cs_test_[A-Za-z0-9]{8,200}$/ });
const ID_RE = /^[a-z]{2,4}_[A-Za-z0-9_]{6,200}$/;
const getter = (env) => (typeof env === "function" ? env : (k) => env?.[k]);
// TF-081 – Checkout-Studio-Einstellungen (Szenario A, siehe STRIPE_INTEGRATION_TODO.md). Nur Parameter, die in JEDER Stripe-API-Version gültig sind –
// Jarvis sendet keinen Stripe-Version-Header (Kontostandard gilt). Bewusst NICHT gesendet (versionsabhängig, sonst lehnt Stripe die Session ab):
//   ui_mode (vor 2026-03-25.dahlia «hosted», ab dahlia «hosted_page» – «hosted» wird dort abgelehnt; Standard ist in beiden die gehostete Seite),
//   origin_context (erst ab 2025-07-30.basil), integration_identifier (erst ab 2026-03-25.dahlia), payment_method_collection (nur subscription).
export const CHECKOUT_STUDIO = Object.freeze({ billing_address_collection: "auto", phone_number_collection: Object.freeze({ enabled: false }),
  automatic_tax: Object.freeze({ enabled: false }), allow_promotion_codes: false, submit_type: "auto" });
const HOSTED_UI = [undefined, null, "hosted", "hosted_page"]; // Antwort muss die gehostete Seite sein (beide Versions-Schreibweisen)

// Schlüssel je Modus – nur intern (nie zurückgeben/loggen).
const keyOf = (env, mode) => { const v = String(getter(env)(KEY_ENV[mode]) || "").trim(); return KEY_RE[mode]?.test(v) ? v : null; };
export const modeConfigured = (env, mode) => !!keyOf(env, mode);
// Owner-Status: nur Wörter, nie Werte/Fragmente.
export function stripeStatus(env = process.env) {
  const g = getter(env);
  const wh = (m) => !!String(g(WEBHOOK_ENV[m]) || "").trim();
  return { provider: "stripe", live: modeConfigured(env, "LIVE") ? "CONFIGURED" : "NOT_CONFIGURED", test: modeConfigured(env, "TEST") ? "CONFIGURED" : "NOT_CONFIGURED",
    webhook_live: wh("LIVE") ? "READY" : "NOT_READY", webhook_test: wh("TEST") ? "READY" : "NOT_READY" };
}
export const modeOfOrder = (order) => (order?.test_order === true ? "TEST" : "LIVE");
export const idempotencyKey = (orderId, mode, seq = 1) => `jarvis:${orderId}:deposit:v1:${mode.toLowerCase()}${seq > 1 ? `:r${seq}` : ""}`;
// Erwartete Anzahlung in Minor Units (nur CH-«Check & Reparatur», nur CHF) – sonst null (keine Checkout-Session).
export function expectedDeposit(order = {}) {
  const info = offerInfo(order.offer_class);
  if (order.offer_class !== DEPOSIT_OFFER || !info || info.currency !== "CHF" || order.market === "VN") return null;
  return { amount: info.deposit, amount_minor: toMinor(info.deposit, "CHF"), currency: "CHF" };
}

const form = (obj, prefix = "", out = []) => {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
};
async function call(env, mode, { method = "GET", path, body = null, idem = null, fetchFn = globalThis.fetch }) {
  const synthetic = fetchFn !== globalThis.fetch;
  assertExternalCapability("paid_api", { env: synthetic ? { ...env, JARVIS_CAPABILITY_MODE: "synthetic" } : env, synthetic });
  const key = keyOf(env, mode);
  if (!key) { const e = new Error("STRIPE_NOT_CONFIGURED"); e.code = "NOT_CONFIGURED"; throw e; }
  const r = await fetchFn(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(idem ? { "idempotency-key": idem } : {}) },
    body: body ? form(body).join("&") : undefined, signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`stripe HTTP ${r.status}${j?.error?.code ? ` ${String(j.error.code).slice(0, 40)}` : ""}`); e.code = r.status >= 500 || r.status === 429 ? "TRANSIENT" : "REJECTED"; throw e; }
  return j;
}
// Nur sichere Felder einer Checkout-Session übernehmen (nie Kunden-/Zahlungsmitteldaten).
export function safeSession(s, mode) {
  if (!s || typeof s !== "object" || !SESSION_RE[mode]?.test(String(s.id || ""))) return null;
  const meta = cleanMeta(s.metadata);
  return { id: s.id, livemode: s.livemode === true, status: ["open", "complete", "expired"].includes(s.status) ? s.status : null,
    payment_status: ["paid", "unpaid", "no_payment_required"].includes(s.payment_status) ? s.payment_status : null,
    amount_minor: Number.isInteger(s.amount_total) ? s.amount_total : null, currency: String(s.currency || "").toUpperCase() || null,
    payment_intent: typeof s.payment_intent === "string" && ID_RE.test(s.payment_intent) ? s.payment_intent : null,
    expires_at: Number.isInteger(s.expires_at) ? new Date(s.expires_at * 1000).toISOString() : null,
    // TF-081: statischer Payment Link (buy.stripe.com) – Session trägt client_reference_id (aus dem Link) und die Payment-Link-ID. Nur als Format geprüft;
    // die Zuordnung zum Auftrag entscheidet stripe-webhook.js (bookStaticLink) strikt.
    client_reference_id: typeof s.client_reference_id === "string" && ORDER_ID_RE.test(s.client_reference_id) ? s.client_reference_id : null,
    payment_link: typeof s.payment_link === "string" && /^plink_[A-Za-z0-9]{6,100}$/.test(s.payment_link) ? s.payment_link : null,
    url: typeof s.url === "string" && /^https:\/\/checkout\.stripe\.com\/[^\s<>"']{4,600}$/.test(s.url) ? s.url : null, metadata: meta };
}
const META_KEYS = ["order_id", "offer_class", "market", "purpose", "environment"];
const cleanMeta = (m) => Object.fromEntries(META_KEYS.map((k) => [k, typeof m?.[k] === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(m[k]) ? m[k] : null]));

// Checkout-Session serverseitig erzeugen. Idempotenz-Schlüssel aus stabilen Jarvis-Daten: ein Neustart/zweiter Durchlauf liefert dieselbe Session.
export async function createCheckoutSession({ env, order, mode = modeOfOrder(order), seq = 1, origin, now = new Date(), fetchFn = globalThis.fetch }) {
  const exp = expectedDeposit(order);
  if (!exp) throw Object.assign(new Error("Kein Stripe-Checkout für dieses Angebot."), { code: "UNSUPPORTED_OFFER" });
  if (mode !== modeOfOrder(order)) throw Object.assign(new Error("Modus passt nicht zum Auftrag."), { code: "MODE_MISMATCH" });
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(String(origin || "")) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(origin || ""))) throw Object.assign(new Error("Keine sichere Rückkehr-Adresse."), { code: "NO_ORIGIN" });
  const meta = { order_id: order.order_id, offer_class: order.offer_class, market: "CH", purpose: PURPOSE, environment: mode };
  const back = (s) => `${origin}/zahlung.html?s=${s}${mode === "TEST" ? "&m=test" : ""}`; // Rückkehrseite ist NIE ein Zahlungsbeleg
  const s = await call(env, mode, { method: "POST", path: "/checkout/sessions", idem: idempotencyKey(order.order_id, mode, seq), fetchFn, body: {
    mode: "payment", ...CHECKOUT_STUDIO, client_reference_id: order.order_id, locale: "de", success_url: back("ok"), cancel_url: back("abbruch"),
    expires_at: Math.floor(+now / 1000) + SESSION_TTL_S,
    ...(order.delivery_email ? { customer_email: order.delivery_email } : {}),
    line_items: { 0: { quantity: 1, price_data: { currency: "chf", unit_amount: exp.amount_minor,
      product_data: { name: `${mode === "TEST" ? "TESTZAHLUNG – " : ""}Check & Reparatur – Anzahlung (erste Hälfte) – Auftrag ${order.order_id}` } } } },
    metadata: meta, payment_intent_data: { metadata: meta, description: `Anzahlung ${order.order_id}` },
  } });
  const safe = safeSession(s, mode);
  // Antwort prüfen (nie blind übernehmen): gehostete Seite, Modus, Betrag, Währung, Bindung an den Auftrag.
  if (!safe || !HOSTED_UI.includes(s.ui_mode) || safe.livemode !== (mode === "LIVE") || safe.amount_minor !== exp.amount_minor || safe.currency !== "CHF" || safe.metadata.order_id !== order.order_id || !safe.url)
    throw Object.assign(new Error("Unerwartete Checkout-Antwort."), { code: "BAD_RESPONSE" });
  return safe;
}
export async function retrieveCheckoutSession({ env, mode, id, fetchFn = globalThis.fetch }) {
  if (!SESSION_RE[mode]?.test(String(id || ""))) throw Object.assign(new Error("Ungültige Session-ID."), { code: "BAD_SESSION" });
  return safeSession(await call(env, mode, { path: `/checkout/sessions/${encodeURIComponent(id)}`, fetchFn }), mode);
}

// ---------- Webhook (offizielles Stripe-Schema «Stripe-Signature: t=…,v1=…», HMAC-SHA256 über "<t>.<rohbody>", Zeittoleranz) ----------
// Liefert den Modus des passenden Secrets. LIVE-Secret UND livemode=true bzw. TEST-Secret UND livemode=false – sonst abgelehnt.
export function verifyStripeWebhook(rawBody, header, env, { now = new Date(), toleranceS = 300 } = {}) {
  const g = getter(env);
  let expired = false;
  for (const mode of MODES) {
    const secret = String(g(WEBHOOK_ENV[mode]) || "").trim();
    if (!secret) continue;
    const v = verifySignature(rawBody, header, secret, { now, toleranceS });
    if (v.ok) {
      let evt; try { evt = JSON.parse(rawBody); } catch { return { ok: false, code: "INVALID_JSON" }; }
      if (typeof evt?.livemode !== "boolean" || evt.livemode !== (mode === "LIVE")) return { ok: false, code: "MODE_MISMATCH" };
      return { ok: true, mode, evt };
    }
    if (v.code === "SIGNATURE_EXPIRED") expired = true;
  }
  return { ok: false, code: expired ? "SIGNATURE_EXPIRED" : MODES.some((m) => String(g(WEBHOOK_ENV[m]) || "").trim()) ? "INVALID_SIGNATURE" : "NOT_CONFIGURED" };
}
export function verifySignature(rawBody, header, secret, { now = new Date(), toleranceS = 300 } = {}) {
  if (!secret) return { ok: false, code: "NOT_CONFIGURED" };
  const parts = String(header || "").split(",").map((x) => x.trim().split("=")).filter((x) => x.length === 2);
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v).filter((v) => /^[0-9a-f]{64}$/.test(v));
  if (!Number.isInteger(t) || !sigs.length) return { ok: false, code: "INVALID_SIGNATURE" };
  if (Math.abs(Math.floor(+now / 1000) - t) > toleranceS) return { ok: false, code: "SIGNATURE_EXPIRED" };
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const match = sigs.some((s) => { const b = Buffer.from(s, "hex"); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  return match ? { ok: true, code: null } : { ok: false, code: "INVALID_SIGNATURE" };
}
// Test-Hilfe (nur Fixtures): Signatur-Header wie Stripe ihn sendet.
export const signStripePayload = (raw, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

// Ereignis → schmales, sicheres Format (nie Kunden-/Kartendaten). null = kein Checkout-Ereignis (Altpfad TF-068).
export const CHECKOUT_KINDS = Object.freeze(["CHECKOUT_PAID", "CHECKOUT_PENDING", "CHECKOUT_FAILED", "CHECKOUT_EXPIRED", "REFUND", "DISPUTE", "IGNORED"]);
export function normalizeCheckoutEvent(evt, mode) {
  const o = evt?.data?.object;
  if (!evt || typeof evt.id !== "string" || !/^evt_[A-Za-z0-9_]{6,200}$/.test(evt.id) || !o || typeof o !== "object" || !MODES.includes(mode)) return null;
  const base = { provider: "stripe", source: "webhook", event_id: evt.id, event_type: String(evt.type || "").slice(0, 60), provider_mode: mode, livemode: evt.livemode === true,
    created_at: Number.isInteger(evt.created) ? new Date(evt.created * 1000).toISOString() : null };
  const meta = cleanMeta(o.metadata);
  const pi = typeof o.payment_intent === "string" && ID_RE.test(o.payment_intent) ? o.payment_intent : null;
  if (/^checkout\.session\./.test(evt.type)) {
    const s = safeSession(o, mode);
    if (!s) return null;
    const kind = evt.type === "checkout.session.expired" ? "CHECKOUT_EXPIRED" : evt.type === "checkout.session.async_payment_failed" ? "CHECKOUT_FAILED"
      : ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(evt.type) ? (s.payment_status === "paid" ? "CHECKOUT_PAID" : "CHECKOUT_PENDING") : null;
    if (!kind) return null;
    const { url: _u, ...rest } = s;
    return { ...base, kind, session_id: s.id, ...rest };
  }
  // Signale ausserhalb der Session: Rückerstattung/Streitfall (nie automatisch verbucht → PAYMENT_REVIEW_REQUIRED).
  if (evt.type === "charge.refunded" && Number.isInteger(o.amount_refunded))
    return { ...base, kind: "REFUND", charge_id: ID_RE.test(String(o.id)) ? o.id : null, payment_intent: pi, amount_minor: o.amount_refunded, currency: String(o.currency || "").toUpperCase(), metadata: meta };
  if (evt.type === "charge.dispute.created" && Number.isInteger(o.amount))
    return { ...base, kind: "DISPUTE", charge_id: typeof o.charge === "string" && ID_RE.test(o.charge) ? o.charge : null, payment_intent: pi, amount_minor: o.amount, currency: String(o.currency || "").toUpperCase(), metadata: meta };
  // Für eine Checkout-Anzahlung ist checkout.session.completed das autoritative Ereignis – das parallele PaymentIntent-Signal wird nie zusätzlich verbucht.
  if (/^payment_intent\./.test(evt.type) && meta.purpose === PURPOSE) return { ...base, kind: "IGNORED", payment_intent: ID_RE.test(String(o.id)) ? o.id : null, metadata: meta };
  return null;
}
export const checkoutEventKey = (n) => `stripe-evt:${n.event_id}`;
