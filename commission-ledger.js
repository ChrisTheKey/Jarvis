// Provisionsbuch (TF-063) – ohne Abhängigkeiten. Provisionen werden NIE frei eingegeben, sondern aus autoritativen Quellen abgeleitet:
//   Auftrag (Server-Control-Snapshot: order_id, Domain, Preis, Zustand, payment_status/paid_chf aus payments.js)
//   + Lead-Zuständigkeit (sales-scope.js sellerOf) + Aktivierungszeitpunkt (commission_eligible_from = TF-063 live).
//
// Regeln (alle vier Verkäufer 35 % = 3500 bps; Chris keine Provision):
//   PENDING   Auftrag existiert, aber NICHT (abgeschlossen UND voll bezahlt) – Anruf/Interesse/Bestellung/Teilzahlung/Deposit allein reichen nie
//   PAYABLE   Zustand COMPLETED oder COMPLETED_WITH_MANUAL_ITEMS  UND  payment_status PAID_FULL
//             Betrag = 35 % von min(bezahlt, Angebotspreis) – keine Provision auf Überzahlung; auf Rappen gerundet
//   REVERSED  storniert (CANCELLED/void), zurückerstattet (REFUNDED) oder Deckung nachträglich entfallen – Eintrag bleibt, Historie bleibt
// Einträge werden nie gelöscht; jede Statusänderung landet in history. Nach PAYABLE ist der Verkäufer gesperrt (keine stille Änderung).
// Keine Auszahlung, keine Bankdaten, keine Überweisung. Markt-/währungsfähig: currency aus dem Auftrag (heute nur CHF, VN-Preise fehlen).

export const RATE_BPS = Object.freeze({ giuliano: 3500, mario: 3500, damiano: 3500, lap: 3500 });
export const SELLERS = Object.freeze(Object.keys(RATE_BPS));
export const STATUSES = Object.freeze(["PENDING", "PAYABLE", "REVERSED"]);
export const DONE_STATES = Object.freeze(["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"]);
export const VOID_STATES = Object.freeze(["CANCELLED"]);
// Konfigurierte Märkte/Währungen. VN: noch KEINE echten Preise → keine VN-Aufträge, keine erfundenen VND-Beträge.
export const MARKET_PRICING = Object.freeze({ CH: { currency: "CHF", configured: true }, VN: { currency: null, configured: false } });
const ORDER_RE = /^(CA150|RF480)-\d{8}-[0-9a-f]{6}$/;

export const toMinor = (v) => (Number.isFinite(v) ? Math.round(v * 100) : 0);
export const fromMinor = (m) => (Math.round(m) / 100).toFixed(2);
// 35 % in Rappen, kaufmännisch gerundet: CHF 150 → 5250 (52.50), CHF 480 → 16800 (168.00).
export const commissionMinor = (baseMinor, bps) => Math.round((baseMinor * bps) / 10_000);
export const emptyLedger = () => ({ schema: 1, eligible_from: null, entries: {}, audit: [] });

// Aufträge aus dem Snapshot (repair + check150) vereinheitlichen. Unbekannte/ungültige IDs fallen weg.
export function ordersFromSnapshot(snapshot) {
  const list = [...(snapshot?.repair?.orders || []), ...(snapshot?.check150?.orders || [])];
  return list.filter((o) => o && ORDER_RE.test(String(o.order_id || ""))).map((o) => ({ order_id: o.order_id, domain: o.domain || null, offer_class: o.offer_class || null,
    price: Number.isFinite(o.price_chf) ? o.price_chf : null, paid: Number.isFinite(o.paid_chf) ? o.paid_chf : 0, state: o.state || null, payment_status: o.payment_status || null,
    created_at: o.created_at || null, market: "CH", currency: "CHF" }));
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
    if (!MARKET_PRICING[o.market]?.configured) continue;
    const prev = L.entries[o.order_id] || null;
    const e = prev ? structuredClone(prev) : { order_id: o.order_id, market: o.market, currency: o.currency, created_at: o.created_at, history: [], seller_locked: false, seller_override: null };
    const s = e.seller_override ? { seller_id: e.seller_override, lead_id: e.lead_id || null, source: "owner" } : resolveSeller(o) || {};
    if (!e.seller_locked) { e.seller_id = SELLERS.includes(s.seller_id) ? s.seller_id : null; e.lead_id = s.lead_id || null; e.seller_source = e.seller_id ? s.source || "default" : "none"; }
    e.rate_bps = e.seller_id ? RATE_BPS[e.seller_id] : 0;
    const priceMinor = toMinor(o.price ?? 0), paidMinor = toMinor(o.paid ?? 0);
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

// OWNER: Verkäufer eines Auftrags vor Abschluss korrigieren (auditiert). Nach PAYABLE gesperrt.
export function overrideSeller(ledger, { order_id, seller_id, actor_user_id, now = new Date() }) {
  const L = structuredClone(ledger || emptyLedger());
  const e = L.entries?.[order_id];
  if (!e) throw Object.assign(new Error("Unbekannter Auftrag im Provisionsbuch."), { code: "UNKNOWN_ORDER" });
  if (e.seller_locked || e.status === "PAYABLE") throw Object.assign(new Error("Provision bereits auszahlbar – Verkäufer gesperrt."), { code: "LOCKED" });
  if (seller_id !== null && !SELLERS.includes(seller_id)) throw Object.assign(new Error("Unbekannter Verkäufer."), { code: "BAD_SELLER" });
  const t = now.toISOString();
  L.audit = [...(L.audit || []), { ts: t, actor_user_id, action: "commission.set_seller", order_id, from: e.seller_id || null, to: seller_id, result: "success" }].slice(-2000);
  e.seller_override = seller_id; e.seller_id = seller_id; e.seller_source = seller_id ? "owner" : "none"; e.rate_bps = seller_id ? RATE_BPS[seller_id] : 0;
  e.history = [...(e.history || []), { at: t, status: e.status, amount_minor: e.payable_minor || 0, reason: "owner_seller_override", seller_id }];
  return L;
}

// Zusammenfassung je Verkäufer (Beträge als "52.50"-Strings, Währung je Eintrag).
export function summarize(ledger, sellerIds = SELLERS) {
  const entries = Object.values(ledger?.entries || {});
  const one = (id) => {
    const mine = entries.filter((e) => e.seller_id === id);
    const sum = (st, f) => mine.filter((e) => e.status === st).reduce((a, e) => a + (e[f] || 0), 0);
    return { seller_id: id, rate_bps: RATE_BPS[id] ?? 0, currency: "CHF", pending: fromMinor(sum("PENDING", "expected_minor")), payable: fromMinor(sum("PAYABLE", "payable_minor")),
      reversed: fromMinor(sum("REVERSED", "reversed_minor")), paid_completed_orders: mine.filter((e) => e.status === "PAYABLE").length,
      orders: mine.map((e) => ({ order_id: e.order_id, status: e.status, order_state: e.order_state, payment_status: e.payment_status, price: fromMinor(e.price_minor || 0),
        commission: fromMinor(e.status === "PAYABLE" ? e.payable_minor : e.status === "REVERSED" ? e.reversed_minor : e.expected_minor), currency: e.currency, created_at: e.created_at })) };
  };
  return sellerIds.map(one);
}
