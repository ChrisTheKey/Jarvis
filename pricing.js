// Zentrale Preisquelle (TF-064) – ohne Abhängigkeiten (VPS-Workflows, Payment-Ledger, Provision, Netlify Functions, Browser-Tests).
// Genau ZWEI Angebote je Markt, feste Marktpreise, KEINE Umrechnung zwischen Währungen, KEIN Wechselkurs, keine dritte Preisstufe.
//
//   CH  CHECK  REPAIR_CHECK_150  CHF 150      Auftrags-ID CA150-…   (Klassen-/Präfix-Namen bleiben wegen gespeicherter Daten)
//   CH  FIX    REPAIR_FIX_500    CHF 480      Auftrags-ID RF480-…
//   VN  CHECK  VN_REPAIR_CHECK   990000 VND   Auftrags-ID VNCHECK-…
//   VN  FIX    VN_REPAIR_FIX     3900000 VND  Auftrags-ID VNFIX-…
//
// Zahlungsschwelle je Angebot = erste Hälfte des Festpreises (CHF 75 / 240, VND 495000 / 1950000).
// Beträge intern in Minor Units je Währung: CHF Exponent 2 (Rappen), VND Exponent 0 (kein Unterteiler) – 990000 VND = 990000 minor.

export const CURRENCIES = Object.freeze({
  CHF: Object.freeze({ code: "CHF", exponent: 2, max: 10_000 }),
  VND: Object.freeze({ code: "VND", exponent: 0, max: 100_000_000 }),
});
export const OFFER_KINDS = Object.freeze(["CHECK", "FIX"]);

const offer = (o) => Object.freeze(o);
export const MARKET_PRICES = Object.freeze({
  CH: Object.freeze({ market: "CH", currency: "CHF", configured: true, offers: Object.freeze({
    CHECK: offer({ kind: "CHECK", offer_class: "REPAIR_CHECK_150", price: 150, order_prefix: "CA150", orders_file: "check150_orders.json" }),
    FIX: offer({ kind: "FIX", offer_class: "REPAIR_FIX_500", price: 480, order_prefix: "RF480", orders_file: "repair_orders.json" }),
  }) }),
  VN: Object.freeze({ market: "VN", currency: "VND", configured: true, offers: Object.freeze({
    CHECK: offer({ kind: "CHECK", offer_class: "VN_REPAIR_CHECK", price: 990_000, order_prefix: "VNCHECK", orders_file: "check150_orders.json",
      name_vi: "Kiểm tra website & hướng dẫn sửa lỗi",
      description_vi: "Kiểm tra website để tìm các lỗi thực tế, giải thích rõ từng vấn đề và cung cấp hướng dẫn từng bước để khách hàng có thể tự sửa." }),
    FIX: offer({ kind: "FIX", offer_class: "VN_REPAIR_FIX", price: 3_900_000, order_prefix: "VNFIX", orders_file: "repair_orders.json",
      name_vi: "Kiểm tra & sửa lỗi website",
      description_vi: "Kiểm tra toàn bộ website, sửa các lỗi đã xác minh và kiểm tra lại trên máy tính và điện thoại." }),
  }) }),
});
export const MARKET_CODES = Object.freeze(Object.keys(MARKET_PRICES));

// ---------- Verkäufer-Provision (TF-063 35 %, TF-072 60 %) ----------
// Ein Satz in Basispunkten für alle Verkäufer (Chris: keine Provision). Nie rückwirkend: jeder neue Auftrag speichert den Satz bei der
// Erstellung (commission_rate_bps), ein bestehender Provisionseintrag behält seinen Satz. Aufträge ohne gespeicherten Satz → Satz, der
// zum Auftragszeitpunkt galt. Betrag = Preis × bps / 10000 in Minor Units (kaufmännisch gerundet, commission-ledger.js).
export const COMMISSION_BPS_SCHEDULE = Object.freeze([
  Object.freeze({ from: null, bps: 3500 }), // TF-063 … TF-071
  Object.freeze({ from: "2026-10-16T15:00:00.000Z", bps: 6000 }), // TF-072: neue Verkäufe
]);
export const SELLER_COMMISSION_BPS = COMMISSION_BPS_SCHEDULE.at(-1).bps;
export const isCommissionBps = (v) => Number.isInteger(v) && v > 0 && v <= 10_000;
export function commissionBpsAt(at) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return SELLER_COMMISSION_BPS;
  return COMMISSION_BPS_SCHEDULE.filter((r) => r.from == null || Date.parse(r.from) <= t).at(-1).bps;
}

// ---------- Minor Units / Formatierung ----------
export const exponentOf = (currency) => CURRENCIES[currency]?.exponent ?? null;
export function toMinor(amount, currency = "CHF") {
  const e = exponentOf(currency);
  return e == null || !Number.isFinite(amount) ? 0 : Math.round(amount * 10 ** e);
}
export function fromMinor(minor, currency = "CHF") {
  const e = exponentOf(currency) ?? 2;
  return Math.round(minor) / 10 ** e;
}
// Betrag als Zahl-String in der natürlichen Genauigkeit: CHF "52.50", VND "346500" (nie "990000.00").
export function minorString(minor, currency = "CHF") {
  const e = exponentOf(currency) ?? 2;
  return (Math.round(minor) / 10 ** e).toFixed(e);
}
const group = (digits, sep) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
// Anzeige: CHF 150.00 bzw. 990.000 ₫ (vi-VN, Tausenderpunkt, keine Nachkommastellen) – deterministisch, ohne Intl-Abhängigkeit.
export function formatMoney(amount, currency = "CHF") {
  if (!Number.isFinite(amount)) return "–";
  if (currency === "VND") { const n = Math.round(amount); return `${n < 0 ? "-" : ""}${group(String(Math.abs(n)), ".")} ₫`; }
  return `${currency} ${amount.toFixed(exponentOf(currency) ?? 2)}`;
}
export const formatMinor = (minor, currency = "CHF") => formatMoney(fromMinor(minor, currency), currency);

// ---------- Angebote ----------
const ALL = Object.values(MARKET_PRICES).flatMap((m) => Object.values(m.offers).map((o) => Object.freeze({ ...o, market: m.market, currency: m.currency })));
export const OFFER_CLASS_IDS = Object.freeze(ALL.map((o) => o.offer_class));
// Vollständige Angaben eines Angebots (Markt, Art, Preis, Währung, Schwelle) oder null.
export function offerInfo(offer_class) {
  const o = ALL.find((x) => x.offer_class === offer_class);
  return o ? { ...o, deposit: depositOf(o.price, o.currency) } : null;
}
export const offerFor = (market, kind) => { const o = MARKET_PRICES[market]?.offers?.[kind]; return o ? offerInfo(o.offer_class) : null; };
export const isKnownOfferClass = (c) => OFFER_CLASS_IDS.includes(c);
export const isVnOfferClass = (c) => offerInfo(c)?.market === "VN";
export const isCheckOffer = (c) => offerInfo(c)?.kind === "CHECK";
export const isFixOffer = (c) => offerInfo(c)?.kind === "FIX";
// Erste Hälfte des Festpreises, exakt in Minor Units (CHF 150 → 75, VND 3 900 000 → 1 950 000).
export function depositOf(price, currency) { return fromMinor(Math.round(toMinor(price, currency) / 2), currency); }

// ---------- Auftrags-IDs ----------
export const ORDER_PREFIXES = Object.freeze(ALL.map((o) => o.order_prefix));
export const ORDER_ID_RE = /^(CA150|RF480|VNCHECK|VNFIX)-\d{8}-[0-9a-f]{6}$/;
export const CHECK_ORDER_ID_RE = /^(CA150|VNCHECK)-\d{8}-[0-9a-f]{6}$/;
export const FIX_ORDER_ID_RE = /^(RF480|VNFIX)-\d{8}-[0-9a-f]{6}$/;
export const orderPrefixOf = (id) => (ORDER_ID_RE.test(String(id || "")) ? String(id).split("-")[0] : null);
// Angebot zu einer Auftrags-ID (über das Präfix) oder null.
export function offerOfOrderId(id) {
  const p = orderPrefixOf(id);
  const o = p ? ALL.find((x) => x.order_prefix === p) : null;
  return o ? offerInfo(o.offer_class) : null;
}
export const newOrderId = (offer_class, now, hex6) => `${offerInfo(offer_class).order_prefix}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${hex6}`;

// Markt/Währung/Preis eines (auch alten) Auftrags. Legacy-CH ohne Felder → CH / CHF / price_chf. VN-Aufträge MÜSSEN
// market VN + currency VND explizit tragen – sonst null (fail closed, kein stilles CHF).
export function orderMoney(o = {}) {
  const info = offerInfo(o.offer_class) || offerOfOrderId(o.order_id);
  if (!info) return null;
  if (info.market === "VN") {
    if (o.market !== "VN" || o.currency !== "VND") return null;
  } else if ((o.market && o.market !== "CH") || (o.currency && o.currency !== "CHF")) return null;
  return { market: info.market, currency: info.currency, offer_class: info.offer_class, kind: info.kind, price: info.price, deposit: info.deposit };
}
