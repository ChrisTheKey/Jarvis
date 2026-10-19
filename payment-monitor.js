// Zahlungseingangs-Überwachung (TF-068) – Provider-Adapter + Abgleich, OHNE Abhängigkeiten ausser node:crypto und pricing.js
// (läuft in der Netlify Function /api/payments, im VPS-CLI payment-reconcile.js und in Tests).
//
// Grundsatz: Eine Zahlung wird NUR verbucht, wenn sie aus einer vertrauenswürdigen Quelle stammt –
//   - signierter Webhook eines tatsächlich konfigurierten Zahlungsanbieters (Signatur geprüft, Zeitstempel-Toleranz)
//   - read-only Banktransaktions-API (Adapter-Schnittstelle; derzeit KEIN Adapter angebunden)
//   - von Chris auf dem VPS importierter Kontoauszug im ISO-20022-Format camt.053 (Datei aus dem E-Banking heruntergeladen)
// Nie: Kunden-E-Mails/Behauptungen, Browser-Automatisierung, Screen Scraping, Bank-Zugangsdaten.
//
// Pflicht für die automatische Verbuchung: eindeutige Transaktions-ID, Betrag, Währung (CHF|VND), Zeitpunkt, Status tatsächlich
// eingegangen (gebucht/settled), GENAU EINE Auftrags-ID (CA150-/RF480-/VNCHECK-/VNFIX-…) in Metadaten oder Verwendungszweck,
// Auftrag existiert, Währung = Auftragswährung. Sonst PAYMENT_REVIEW_REQUIRED (Chris entscheidet). Keine Zuordnung über Namen.
// Duplikatschutz: provider:transaction_id wird genau einmal verarbeitet; zusätzlich Referenz-Duplikatschutz in payments.js.
// Rückerstattungen werden nie automatisch verbucht (Review) – Chris markiert sie mit payments.js refund (Provision → REVERSED).
import crypto from "node:crypto";
import { CURRENCIES } from "./pricing.js";

export const MONITOR_FILE = "payment_monitor.json";
export const PROVIDERS = Object.freeze({
  stripe: Object.freeze({ kind: "signed_webhook", secret_env: "STRIPE_WEBHOOK_SECRET" }),
  camt053: Object.freeze({ kind: "statement_import", secret_env: null }),
  bank_api: Object.freeze({ kind: "read_only_api", secret_env: null, adapter: null }), // kein Bank-Adapter angebunden → nie «konfiguriert»
});
export const RESULTS = Object.freeze(["BOOKED", "DUPLICATE", "PAYMENT_REVIEW_REQUIRED", "IGNORED"]);
export const SIGNATURE_TOLERANCE_S = 300;
const ORDER_REF_RE = /(CA150|RF480|VNCHECK|VNFIX)-(\d{8})-([0-9a-f]{6})/gi;

// Status der Überwachung – nur Namen/Ja-Nein, nie Werte.
// TF-080: Stripe gilt auch ohne PAYMENT_MONITOR_PROVIDER als gewählt, sobald ein Stripe-Webhook-Secret (LIVE oder TEST) gesetzt ist.
const STRIPE_SECRETS = ["STRIPE_WEBHOOK_SECRET", "STRIPE_TEST_WEBHOOK_SECRET"];
export function monitorStatus(env = () => undefined) {
  const has = (k) => !!String(env(k) || "").trim();
  const provider = String(env("PAYMENT_MONITOR_PROVIDER") || "").trim().toLowerCase() || (STRIPE_SECRETS.some(has) ? "stripe" : "");
  const p = PROVIDERS[provider];
  if (!p) return { status: "PAYMENT_MONITOR_NOT_CONFIGURED", provider: null, kind: null, missing: ["PAYMENT_MONITOR_PROVIDER"] };
  if (p.kind === "read_only_api" && !p.adapter) return { status: "PAYMENT_MONITOR_NOT_CONFIGURED", provider, kind: p.kind, missing: ["BANK_API_ADAPTER"] };
  if (provider === "stripe") return STRIPE_SECRETS.some(has) ? { status: "CONFIGURED", provider, kind: p.kind, missing: [] } : { status: "PAYMENT_MONITOR_NOT_CONFIGURED", provider, kind: p.kind, missing: STRIPE_SECRETS };
  if (p.secret_env && !String(env(p.secret_env) || "").trim()) return { status: "PAYMENT_MONITOR_NOT_CONFIGURED", provider, kind: p.kind, missing: [p.secret_env] };
  return { status: "CONFIGURED", provider, kind: p.kind, missing: [] };
}

// ---------- Stripe (signierter Webhook, Schema «Stripe-Signature: t=…,v1=…», HMAC-SHA256 über "<t>.<rohbody>") ----------
export function verifyStripeSignature(rawBody, header, secret, { now = new Date(), toleranceS = SIGNATURE_TOLERANCE_S } = {}) {
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
const STRIPE_ZERO_DECIMAL = new Set(["VND"]);
const fromStripeMinor = (n, cur) => (STRIPE_ZERO_DECIMAL.has(cur) ? n : n / 10 ** (CURRENCIES[cur]?.exponent ?? 2));
// Nur eindeutig eingegangene Zahlungen/Rückerstattungen; alles andere → null (ignoriert).
export function normalizeStripeEvent(evt) {
  const o = evt?.data?.object;
  if (!o || typeof o !== "object") return null;
  const cur = String(o.currency || "").toUpperCase();
  const at = Number.isInteger(o.created) ? new Date(o.created * 1000).toISOString() : null;
  // TF-081: Payment Links tragen die Auftrags-ID als client_reference_id (nur checkout.session.completed); Metadaten haben Vorrang.
  const ref = (m) => (m && typeof m.order_id === "string" ? m.order_id : null);
  const sessionRef = (x) => ref(x.metadata) || (typeof x.client_reference_id === "string" && x.client_reference_id.length <= 64 ? x.client_reference_id : null);
  if (evt.type === "payment_intent.succeeded" && o.status === "succeeded" && Number.isInteger(o.amount_received))
    return { provider: "stripe", transaction_id: o.id, kind: "PAYMENT", amount: fromStripeMinor(o.amount_received, cur), currency: cur, received_at: at, settled: true, order_ref: ref(o.metadata), remittance: o.description || null, verified: true };
  if (evt.type === "checkout.session.completed" && o.payment_status === "paid" && Number.isInteger(o.amount_total))
    return { provider: "stripe", transaction_id: typeof o.payment_intent === "string" ? o.payment_intent : o.id, kind: "PAYMENT", amount: fromStripeMinor(o.amount_total, cur), currency: cur, received_at: at, settled: true, order_ref: sessionRef(o), remittance: null, verified: true };
  if (evt.type === "charge.refunded" && Number.isInteger(o.amount_refunded))
    return { provider: "stripe", transaction_id: `refund:${o.id}`, kind: "REFUND", amount: fromStripeMinor(o.amount_refunded, cur), currency: cur, received_at: at, settled: true, order_ref: ref(o.metadata), remittance: null, verified: true };
  return null;
}

// ---------- camt.053 (ISO 20022 Kontoauszug) – nur gebuchte Gutschriften ----------
const tag = (xml, name) => { const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml); return m ? m[1] : null; };
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g"))].map((m) => m[1]);
const txt = (s) => (s == null ? null : s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() || null);
export function parseCamt053(xml) {
  const src = String(xml || "");
  if (!/camt\.053/.test(src) || !/<(?:\w+:)?Stmt[\s>]/.test(src)) throw new Error("Keine camt.053-Datei (BkToCstmrStmt/Stmt fehlt).");
  const out = [];
  for (const stmt of tags(src, "Stmt")) {
    const stmtId = txt(tag(stmt, "Id"));
    for (const e of tags(stmt, "Ntry")) {
      const amtM = /<(?:\w+:)?Amt\s+Ccy="([A-Z]{3})"\s*>([0-9.]+)</.exec(e);
      const sts = txt(tag(tag(e, "Sts") || "", "Cd")) || txt(tag(e, "Sts"));
      const ind = txt(tag(e, "CdtDbtInd"));
      const bookDt = tag(e, "BookgDt");
      const when = txt(tag(bookDt || "", "DtTm")) || txt(tag(bookDt || "", "Dt"));
      const id = txt(tag(e, "AcctSvcrRef")) || txt(tag(e, "NtryRef"));
      const rmt = [...tags(e, "Ustrd").map(txt), ...tags(tag(e, "CdtrRefInf") || "", "Ref").map(txt)].filter(Boolean).join(" ") || null;
      if (ind !== "CRDT") continue; // Belastungen ignorieren
      out.push({ provider: "camt053", transaction_id: id ? `${stmtId || "stmt"}:${id}` : null, kind: "PAYMENT", amount: amtM ? Number(amtM[2]) : NaN, currency: amtM ? amtM[1] : null,
        received_at: when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : null, settled: sts === "BOOK", order_ref: null, remittance: rmt, verified: true });
    }
  }
  return out;
}

// ---------- Auftrags-Referenz ----------
// Genau eine Auftrags-ID (Metadaten haben Vorrang, sonst Verwendungszweck). Mehrere verschiedene → mehrdeutig. Nie Namensähnlichkeit.
export function extractOrderRef(tx) {
  const canon = (p, d, h) => `${p.toUpperCase()}-${d}-${h.toLowerCase()}`;
  const from = (s) => [...new Set([...String(s || "").matchAll(ORDER_REF_RE)].map((m) => canon(m[1], m[2], m[3])))];
  const meta = from(tx?.order_ref);
  if (meta.length === 1) return { order_id: meta[0], code: null };
  if (meta.length > 1) return { order_id: null, code: "AMBIGUOUS_ORDER_REFERENCE" };
  const rm = from(tx?.remittance);
  if (rm.length === 1) return { order_id: rm[0], code: null };
  return { order_id: null, code: rm.length > 1 ? "AMBIGUOUS_ORDER_REFERENCE" : "NO_ORDER_REFERENCE" };
}

export const emptyMonitorState = () => ({ schema: 1, processed: {}, reviews: [], imports: {} });
export const txKey = (tx) => (tx?.provider && tx?.transaction_id ? `${tx.provider}:${tx.transaction_id}` : null);

// Eine verifizierte Transaktion abgleichen. deps: findOrder(order_id) → { order_id, currency } | null,
// record({ order_id, amount, currency, source, reference, received_at }) → { payment_id } (wirft bei Duplikat/Fehler).
// state wird verändert (processed/reviews). Ergebnis { result, code, order_id, payment_id }.
export function reconcileTransaction(state, tx, { findOrder, record, now = new Date() }) {
  const t = now.toISOString();
  const key = txKey(tx);
  const review = (code, order_id = null) => {
    const r = { result: "PAYMENT_REVIEW_REQUIRED", code, order_id, payment_id: null };
    state.reviews = [...(state.reviews || []), { at: t, key, provider: tx?.provider || null, transaction_id: tx?.transaction_id || null, amount: Number.isFinite(tx?.amount) ? tx.amount : null,
      currency: tx?.currency || null, received_at: tx?.received_at || null, order_id, code, status: "OPEN" }].slice(-1000);
    if (key) state.processed[key] = { at: t, result: r.result, code, order_id };
    return r;
  };
  if (!tx || tx.verified !== true) return { result: "IGNORED", code: "UNVERIFIED_SOURCE", order_id: null, payment_id: null }; // nie verbuchen, nie speichern
  if (!key) return review("NO_TRANSACTION_ID");
  if (state.processed?.[key]) return { result: "DUPLICATE", code: "DUPLICATE_TRANSACTION", order_id: state.processed[key].order_id || null, payment_id: state.processed[key].payment_id || null };
  if (tx.kind === "REFUND") return review("REFUND_REVIEW_REQUIRED", extractOrderRef(tx).order_id);
  if (tx.settled !== true) return review("NOT_SETTLED");
  if (!["CHF", "VND"].includes(tx.currency)) return review("UNSUPPORTED_CURRENCY");
  if (!Number.isFinite(tx.amount) || tx.amount <= 0 || (tx.currency === "VND" && !Number.isInteger(tx.amount))) return review("INVALID_AMOUNT");
  if (!tx.received_at || Number.isNaN(Date.parse(tx.received_at))) return review("NO_TIMESTAMP");
  const ref = extractOrderRef(tx);
  if (!ref.order_id) return review(ref.code);
  const order = findOrder(ref.order_id);
  if (!order) return review("UNKNOWN_ORDER", ref.order_id);
  if (order.currency !== tx.currency) return review("CURRENCY_MISMATCH", ref.order_id); // CHF und VND strikt getrennt
  let p;
  try { p = record({ order_id: order.order_id, amount: tx.amount, currency: tx.currency, source: `monitor_${tx.provider}`, reference: key, received_at: tx.received_at }); }
  catch (e) { return /Doppelte Zahlungsreferenz/.test(e.message) ? (state.processed[key] = { at: t, result: "DUPLICATE", order_id: order.order_id }, { result: "DUPLICATE", code: "DUPLICATE_REFERENCE", order_id: order.order_id, payment_id: null }) : review("BOOKING_FAILED", order.order_id); }
  state.processed[key] = { at: t, result: "BOOKED", order_id: order.order_id, payment_id: p.payment_id };
  return { result: "BOOKED", code: null, order_id: order.order_id, payment_id: p.payment_id };
}
