// Provisionsbuch (TF-063, währungsfähig TF-064) – ohne Abhängigkeiten ausser pricing.js. Provisionen werden NIE frei eingegeben, sondern
// aus autoritativen Quellen abgeleitet:
//   Auftrag (Server-Control-Snapshot: order_id, Domain, Markt, Währung, Preis, Zustand, payment_status/bezahlt aus payments.js)
//   + Lead-Zuständigkeit (sales-scope.js sellerOf) + Aktivierungszeitpunkt (commission_eligible_from = TF-063 live).
//
// Regeln (alle vier Verkäufer 35 % = 3500 bps; Chris keine Provision):
//   PENDING   Auftrag existiert, aber NICHT (abgeschlossen UND voll bezahlt) – Anruf/Interesse/Bestellung/Teilzahlung/Deposit allein reichen nie
//   PAYABLE   Zustand COMPLETED oder COMPLETED_WITH_MANUAL_ITEMS  UND  payment_status PAID_FULL
//             Betrag = 35 % von min(bezahlt, Angebotspreis) – keine Provision auf Überzahlung; kaufmännisch gerundet in Minor Units
//   REVERSED  storniert (CANCELLED/void), zurückerstattet (REFUNDED) oder Deckung nachträglich entfallen – Eintrag bleibt, Historie bleibt
// Einträge werden nie gelöscht; jede Statusänderung landet in history. Nach PAYABLE ist der Verkäufer gesperrt (keine stille Änderung).
// Keine Auszahlung, keine Bankdaten, keine Überweisung.
//
// TF-064 Währungen: Minor Units je Währung (CHF Exponent 2 → CHF 150.00 = 15000; VND Exponent 0 → 990000 VND = 990000).
// Markt/Währung kommen aus dem Auftrag: Legacy-CH ohne Felder → CH/CHF; VN-Aufträge MÜSSEN market VN + currency VND tragen.
// Summen werden je Währung getrennt geführt – CHF und VND werden nie addiert.
import { MARKET_PRICES, ORDER_ID_RE, orderMoney, toMinor as toMinorOf, minorString } from "./pricing.js";

export const RATE_BPS = Object.freeze({ giuliano: 3500, mario: 3500, damiano: 3500, lap: 3500 });
export const SELLERS = Object.freeze(Object.keys(RATE_BPS));
export const STATUSES = Object.freeze(["PENDING", "PAYABLE", "REVERSED"]);
export const DONE_STATES = Object.freeze(["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"]);
export const VOID_STATES = Object.freeze(["CANCELLED"]);
// Konfigurierte Märkte/Währungen – aus der zentralen Preisquelle (CH: CHF, VN: VND, beide konfiguriert).
export const MARKET_PRICING = Object.freeze(Object.fromEntries(Object.values(MARKET_PRICES).map((m) => [m.market, Object.freeze({ currency: m.currency, configured: m.configured === true })])));
export const CURRENCY_OF_SELLER = Object.freeze({ giuliano: "CHF", mario: "CHF", damiano: "CHF", lap: "VND" });

// Legacy-Signaturen (CHF) bleiben: toMinor(150) = 15000, fromMinor(5250) = "52.50". Mit Währung: toMinor(990000, "VND") = 990000.
export const toMinor = (v, currency = "CHF") => toMinorOf(v, currency);
export const fromMinor = (m, currency = "CHF") => minorString(m, currency);
// 35 % in Minor Units, kaufmännisch gerundet: CHF 150 → 5250 (52.50), CHF 480 → 16800 (168.00), VND 990000 → 346500, VND 3900000 → 1365000.
export const commissionMinor = (baseMinor, bps) => Math.round((baseMinor * bps) / 10_000);
export const emptyLedger = () => ({ schema: 1, eligible_from: null, entries: {}, audit: [] });

// Aufträge aus dem Snapshot (repair + check150) vereinheitlichen. Unbekannte/ungültige IDs und VN-Aufträge ohne explizites
// market VN + currency VND fallen weg (fail closed – nie blind CH/CHF).
export function ordersFromSnapshot(snapshot) {
  const list = [...(snapshot?.repair?.orders || []), ...(snapshot?.check150?.orders || [])];
  const out = [];
  for (const o of list) {
    if (!o || !ORDER_ID_RE.test(String(o.order_id || ""))) continue;
    const m = orderMoney(o);
    if (!m) continue;
    const price = Number.isFinite(o.price_amount) ? o.price_amount : Number.isFinite(o.price_chf) && m.currency === "CHF" ? o.price_chf : null;
    const paid = Number.isFinite(o.paid_amount) ? o.paid_amount : Number.isFinite(o.paid_chf) && m.currency === "CHF" ? o.paid_chf : 0;
    out.push({ order_id: o.order_id, domain: o.domain || null, offer_class: o.offer_class || null, price, paid, state: o.state || null,
      payment_status: o.payment_status || null, created_at: o.created_at || null, market: m.market, currency: m.currency });
  }
  return out;
}

function targetStatus(o) {
  if (VOID_STATES.includes(o.state) || o.payment_status === "REFUNDED") return { status: "REVERSED", reason: VOID_STATES.includes(o.state) ? "order_cancelled" : "refunded" };
  if (DONE_STATES.includes(o.state) && o.payment_status === "PAID_FULL") return { status: "PAYABLE", reason: "completed_and_paid_full" };
  return { status: "PENDING", reason: !DONE_STATES.includes(o.state) ? "order_not_completed" : "not_paid_full" };
}

// Leitet das Buch neu ab. ledger = bisheriger Stand (wird nicht verändert), resolveSeller(order) → { seller_id, lead_id, source }.
// Ergebnis { ledger, changed }. eligibleFrom fehlt → wird auf now gesetzt (Produktionsaktivierung, nicht rückwirkend).
export function deriveLedger({ ledger, orders = [], resolveSeller = () => ({ seller_id: null, lead_id: null, source: "none" }), now = new Date() }) {
  const L = ledger && typeof ledger === "object" ? structuredClone(ledger) : emptyLedger();
  L.entries ||= {}; L.audit ||= [];
  const t = now.toISOString();
  let changed = false;
  if (!L.eligible_from) { L.eligible_from = t; changed = true; L.audit.push({ ts: t, actor_user_id: "system:tf063", action: "commission.activate", result: "success" }); }
  const from = Date.parse(L.eligible_from);
  for (const o of orders) {
    if (!o.created_at || Number.isNaN(Date.parse(o.created_at)) || Date.parse(o.created_at) < from) continue; // historisch: nie automatisch gutgeschrieben
    if (!MARKET_PRICING[o.market]?.configured || MARKET_PRICING[o.market].currency !== o.currency) continue;
    const prev = L.entries[o.order_id] || null;
    if (prev && (prev.currency || "CHF") !== o.currency) continue; // Währung eines Eintrags ändert sich nie
    const e = prev ? structuredClone(prev) : { order_id: o.order_id, market: o.market, currency: o.currency, created_at: o.created_at, history: [], seller_locked: false, seller_override: null };
    const s = e.seller_override ? { seller_id: e.seller_override, lead_id: e.lead_id || null, source: "owner" } : resolveSeller(o) || {};
    if (!e.seller_locked) { e.seller_id = SELLERS.includes(s.seller_id) ? s.seller_id : null; e.lead_id = s.lead_id || null; e.seller_source = e.seller_id ? s.source || "default" : "none"; }
    e.rate_bps = e.seller_id ? RATE_BPS[e.seller_id] : 0;
    const priceMinor = toMinor(o.price ?? 0, o.currency), paidMinor = toMinor(o.paid ?? 0, o.currency);
    e.price_minor = priceMinor; e.paid_minor = paidMinor; e.order_state = o.state; e.payment_status = o.payment_status;
    e.base_minor = Math.min(priceMinor, paidMinor);
    e.expected_minor = commissionMinor(priceMinor, e.rate_bps);
    let { status, reason } = targetStatus(o);
    const wasPayable = prev?.status === "PAYABLE" || (prev?.history || []).some((h) => h.status === "PAYABLE");
    // Nie PAYABLE gewesen und storniert → kein Anspruch (REVERSED mit 0). Vorher PAYABLE und Deckung weg → REVERSED (Korrektur sichtbar).
    if (status === "PENDING" && prev?.status === "PAYABLE") { status = "REVERSED"; reason = "coverage_lost"; }
    const amount = status === "PAYABLE" ? commissionMinor(e.base_minor, e.rate_bps) : 0;
    e.reversed_minor = status === "REVERSED" ? (wasPayable ? Math.max(prev?.payable_minor || 0, prev?.reversed_minor || 0) : 0) : 0;
    e.payable_minor = amount;
    if (status === "PAYABLE") e.seller_locked = true;
    if (!prev || prev.status !== status || prev.payable_minor !== amount || prev.seller_id !== e.seller_id) {
      e.history = [...(e.history || []), { at: t, status, amount_minor: amount, reason, seller_id: e.seller_id }].slice(-100);
      changed = true;
    }
    e.status = status;
    if (JSON.stringify(prev) !== JSON.stringify(e)) { changed = true; L.entries[o.order_id] = e; }
  }
  return { ledger: L, changed };
}

// OWNER: Verkäufer eines Auftrags vor Abschluss korrigieren (auditiert). Nach PAYABLE gesperrt. Markt muss zum Verkäufer passen.
export function overrideSeller(ledger, { order_id, seller_id, actor_user_id, now = new Date() }) {
  const L = structuredClone(ledger || emptyLedger());
  const e = L.entries?.[order_id];
  if (!e) throw Object.assign(new Error("Unbekannter Auftrag im Provisionsbuch."), { code: "UNKNOWN_ORDER" });
  if (e.seller_locked || e.status === "PAYABLE") throw Object.assign(new Error("Provision bereits auszahlbar – Verkäufer gesperrt."), { code: "LOCKED" });
  if (seller_id !== null && !SELLERS.includes(seller_id)) throw Object.assign(new Error("Unbekannter Verkäufer."), { code: "BAD_SELLER" });
  if (seller_id !== null && CURRENCY_OF_SELLER[seller_id] !== (e.currency || "CHF")) throw Object.assign(new Error("Verkäufer passt nicht zum Markt/zur Währung des Auftrags."), { code: "BAD_SELLER" });
  const t = now.toISOString();
  L.audit = [...(L.audit || []), { ts: t, actor_user_id, action: "commission.set_seller", order_id, from: e.seller_id || null, to: seller_id, result: "success" }].slice(-2000);
  e.seller_override = seller_id; e.seller_id = seller_id; e.seller_source = seller_id ? "owner" : "none"; e.rate_bps = seller_id ? RATE_BPS[seller_id] : 0;
  e.history = [...(e.history || []), { at: t, status: e.status, amount_minor: e.payable_minor || 0, reason: "owner_seller_override", seller_id }];
  return L;
}

// Summen einer Eintragsliste in EINER Währung (Minor Units).
function sums(list) {
  const sum = (st, f) => list.filter((e) => e.status === st).reduce((a, e) => a + (e[f] || 0), 0);
  return { pending: sum("PENDING", "expected_minor"), payable: sum("PAYABLE", "payable_minor"), reversed: sum("REVERSED", "reversed_minor"),
    paid_completed_orders: list.filter((e) => e.status === "PAYABLE").length };
}
const fmtSums = (x, cur) => ({ currency: cur, pending: fromMinor(x.pending, cur), payable: fromMinor(x.payable, cur), reversed: fromMinor(x.reversed, cur), paid_completed_orders: x.paid_completed_orders });
const entryCurrency = (e) => e.currency || "CHF";

// Zusammenfassung je Verkäufer: Hauptwährung des Verkäufers (Lap VND, sonst CHF) oben, alle Währungen getrennt in by_currency.
// Beträge als Strings in natürlicher Genauigkeit ("52.50" bzw. "346500").
export function summarize(ledger, sellerIds = SELLERS) {
  const entries = Object.values(ledger?.entries || {});
  const one = (id) => {
    const mine = entries.filter((e) => e.seller_id === id);
    const home = CURRENCY_OF_SELLER[id] || "CHF";
    const curs = [...new Set([home, ...mine.map(entryCurrency)])];
    const by = Object.fromEntries(curs.map((c) => [c, fmtSums(sums(mine.filter((e) => entryCurrency(e) === c)), c)]));
    return { seller_id: id, rate_bps: RATE_BPS[id] ?? 0, ...by[home], by_currency: by,
      orders: mine.map((e) => { const c = entryCurrency(e); return { order_id: e.order_id, market: e.market || "CH", status: e.status, order_state: e.order_state, payment_status: e.payment_status,
        price: fromMinor(e.price_minor || 0, c), commission: fromMinor(e.status === "PAYABLE" ? e.payable_minor : e.status === "REVERSED" ? e.reversed_minor : e.expected_minor, c),
        commission_minor: e.status === "PAYABLE" ? e.payable_minor : e.status === "REVERSED" ? e.reversed_minor : e.expected_minor, currency: c, created_at: e.created_at }; }) };
  };
  return sellerIds.map(one);
}
// Gesamtsummen je Währung (OWNER) – nie eine gemischte Gesamtsumme.
export function totalsByCurrency(ledger, sellerIds = SELLERS) {
  const entries = Object.values(ledger?.entries || {}).filter((e) => sellerIds.includes(e.seller_id));
  const out = {};
  for (const c of ["CHF", "VND"]) out[c] = fmtSums(sums(entries.filter((e) => entryCurrency(e) === c)), c);
  return out;
}
