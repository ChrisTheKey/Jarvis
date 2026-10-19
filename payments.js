// Jarvis Payment Ledger (TF-041, währungsfähig seit TF-064) – VERKAUF != ZAHLUNG. Ein sale / direct-sale / create-confirmed /
// ORDER_CONFIRMED ist nur die Auftragsbestätigung und bedeutet NIE automatisch «Geld eingegangen». Dieses Modul führt das persistente
// Zahlungsbuch (.secrets/mail_worker/payments.json, atomar über createStore, liegt im verschlüsselten Backup) und berechnet je Auftrag
// die kumulativ tatsächlich eingegangene Zahlung. Ein bestätigter Auftrag kann mit 0 bezahlt existieren und muss warten.
//
// Zahlungsschwelle (erste Hälfte des Festpreises aus pricing.js – keine eigene Preisliste):
//   REPAIR_CHECK_150 → CHF 75         VN_REPAIR_CHECK → 495000 VND     erst ab der Schwelle: bezahlter Check, Anleitung, Bericht, Service-Mail
//   REPAIR_FIX_500   → CHF 240        VN_REPAIR_FIX   → 1950000 VND    erst ab der Schwelle: sicherer Zugang, danach der Reparaturworkflow
// Die Gates prüfen die Workflows selbst (check-150-workflow.js / repair-workflow.js) über paymentGateForOrder.
//
// Harte Regeln (fail closed):
//   - Jede Zahlung ist primär an eine ORDER_ID gebunden (CA150-/RF480-/VNCHECK-/VNFIX-…), nie nur an eine Domain – mehrere Aufträge
//     derselben Firma bleiben sicher getrennt. Unbekannte order_id → Fehler, nichts wird erraten oder angelegt.
//   - TF-064: Zahlung ist an ORDER_ID + AUFTRAGSWÄHRUNG gebunden (CH → CHF, VN → VND). Eine VND-Zahlung wird nie auf einen
//     CHF-Auftrag gebucht und umgekehrt; keine Umrechnung, kein Wechselkurs. VND hat keine Unterteilung (ganze Beträge).
//   - Zahlungseinträge werden NIE gelöscht: Korrekturen nur als Status-Markierung (VOIDED/REFUNDED) mit Pflicht-Grund;
//     alle Originaldaten bleiben erhalten. Nur Status RECEIVED zählt zur kumulativen Zahlung.
//   - Duplikatschutz: dieselbe Zahlungsreferenz (normalisiert: Gross/Klein und Leerzeichen egal) zählt nie doppelt.
//   - Keine Secrets: nur Betrag/Quelle/Referenztext – nie Kontodaten, IBAN-Listen oder Tokens in diesem Modul.
//   - Nur Chris (CLI auf dem VPS) verbucht – es gibt keine Cloud-/Verkäufer-Schnittstelle zum Erfassen, Ändern oder Erstatten.
//     TF-080: zusätzlich der Repair-Service nach einem geprüften Stripe-Checkout-Ereignis (stripe-webhook.js) – gleiche Regeln, gleicher Duplikatschutz.
//   - TF-080 LIVE/TEST: jede Zahlung trägt provider_mode (LIVE | TEST). TEST-Zahlungen (is_test) gibt es NUR für Test-Aufträge (test_order) und
//     umgekehrt; ein Gate zählt nur Zahlungen seines Modus (TEST erfüllt nie ein LIVE-Gate). Summen/Umsatz/Provision kennen nur LIVE.
//     Die CLI verbucht nur LIVE – es gibt keinen Weg, eine Testzahlung von Hand zu «simulieren».
//
// Gespeichertes Format: CHF-Einträge wie bisher mit amount_chf (+ amount/currency), VND-Einträge mit amount + currency "VND".
// Leser verstehen beide Formate (Legacy-Eintrag ohne currency/amount = CHF/amount_chf).
//
// Abgeleiteter Zahlungsstatus je Auftrag (paymentSummary, Preis/Deposit aus pricing.js, nie gespeichert):
//   UNPAID · PARTIAL (unter Deposit) · DEPOSIT_MET (≥ Deposit) · PAID_FULL (≥ Festpreis) · REFUNDED (alles zurückerstattet)
//   · PAYMENT_REVIEW_REQUIRED (Zahlung fiel unter die Schwelle, nachdem die Website schon verändert wurde – Chris entscheidet)
//
//   node payments.js record <order_id> --amount 75 --reference "<ref>" [--currency CHF|VND] [--source manual_bank_confirmation] [--date JJJJ-MM-TT]
//   node payments.js list [order_id]          alle bzw. die Zahlungen eines Auftrags
//   node payments.js show <order_id>          kumulative Zahlung + Zahlungsstatus + Gate des Auftrags (Alias: status)
//   node payments.js void <payment_id> --reason "<grund>"      Fehlbuchung markieren (nie löschen)
//   node payments.js refund <payment_id> --reason "<grund>"    Rückerstattung markieren (nie löschen)
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore } from "./mail-worker.js";
import { ORDER_ID_RE, CURRENCIES, offerInfo, offerOfOrderId, orderMoney, toMinor, fromMinor, formatMoney } from "./pricing.js";

export const PAYMENTS_FILE = "payments.json";
export const PAYMENT_STATUS = Object.freeze(["RECEIVED", "VOIDED", "REFUNDED"]);
export const ORDER_PAYMENT_STATES = Object.freeze(["UNPAID", "PARTIAL", "DEPOSIT_MET", "PAID_FULL", "REFUNDED", "PAYMENT_REVIEW_REQUIRED"]);
// Erste Hälfte des Festpreises – immer aus der zentralen Preisquelle, nie eine dritte Preisquelle.
// paymentThreshold: in der Währung des Angebots; paymentThresholdChf bleibt für Schweizer Angebote (CHF 75 / 240).
export const paymentThreshold = (offer_class) => offerInfo(offer_class)?.deposit ?? null;
export const paymentThresholdChf = (offer_class) => (offerInfo(offer_class)?.currency === "CHF" ? offerInfo(offer_class).deposit : null);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const SOURCE_RE = /^[a-z0-9_-]{2,40}$/;
const normRef = (r) => String(r || "").replace(/\s+/g, " ").trim().toLowerCase();
const roundTo = (n, currency) => fromMinor(toMinor(n, currency), currency);
// Gespeicherte Zahlung lesen – beide Formate (Legacy CHF: amount_chf ohne currency).
export const paymentCurrency = (p) => (p?.currency === "VND" ? "VND" : "CHF");
export const paymentAmount = (p) => (Number.isFinite(p?.amount) ? p.amount : Number.isFinite(p?.amount_chf) ? p.amount_chf : 0);
// Betrag kurz für Texte: CHF wie bisher «CHF 75», VND «495.000 ₫».
export const amountText = (v, currency = "CHF") => (currency === "VND" ? formatMoney(v, "VND") : `CHF ${v}`);

// Auftrag zu einer order_id – Dateinamen bewusst lokal (wie collectDomainOrders in sales.js), damit kein Import-Zyklus
// entsteht (check-150-workflow.js und repair-workflow.js importieren beide aus payments.js). Exakter Treffer oder null.
export function findPayableOrder(store, orderId) {
  const id = String(orderId || "").trim();
  if (!ORDER_ID_RE.test(id)) return null;
  const file = offerOfOrderId(id).orders_file;
  const o = store.read(file, { orders: {} }).orders?.[id];
  if (!o) return null;
  const money = orderMoney(o);
  return { order_id: o.order_id, domain: o.domain || null, offer_class: o.offer_class, state: o.state, file,
    market: money?.market || null, currency: money?.currency || null, test_order: o.test_order === true };
}

function readLedger(store) { return store.read(PAYMENTS_FILE, { schema: 1, payments: {} }); }
function writeLedger(store, data) { store.write(PAYMENTS_FILE, data); }

// Zahlung als eingegangen verbuchen – nur gegen einen existierenden Auftrag (fail closed), nur in dessen Währung, nie löschen, nie überschreiben.
// amount (neu) oder amount_chf (Legacy-Aufrufe) – beide meinen den Betrag in der angegebenen Währung.
export const PROVIDER_MODES = Object.freeze(["LIVE", "TEST"]);
export const isTestPayment = (p) => p?.is_test === true || p?.provider_mode === "TEST";
export function recordPayment(store, { order_id, amount = undefined, amount_chf = undefined, currency = undefined, source = "bank_transfer", reference = null, received_at = null, provider_mode = "LIVE", now = new Date() } = {}) {
  const order = findPayableOrder(store, order_id);
  if (!order) throw new Error(`Kein Auftrag mit order_id "${order_id}" vorhanden (CA150-…/RF480-…/VNCHECK-…/VNFIX-…) – Zahlungen werden nur gegen echte Aufträge verbucht.`);
  if (!PROVIDER_MODES.includes(provider_mode)) throw new Error("Ungültiger Zahlungsmodus (LIVE | TEST).");
  // TF-080: Test-Auftrag ↔ Testzahlung strikt (beide Richtungen) – nie echtes Geld auf einen Test, nie ein Test auf einen echten Auftrag.
  if (order.test_order && provider_mode !== "TEST") throw new Error(`Auftrag ${order.order_id} ist ein E2E-Test – nur Stripe-TESTzahlungen, nichts verbucht.`);
  if (!order.test_order && provider_mode !== "LIVE") throw new Error(`Auftrag ${order.order_id} ist echt – eine TESTzahlung wird nie verbucht.`);
  if (!order.currency) throw new Error(`Auftrag ${order.order_id} hat keinen gültigen Markt/keine gültige Währung – nichts verbucht.`);
  const cur = String(currency || order.currency).toUpperCase();
  if (cur !== order.currency) throw new Error(`Nur ${order.currency} wird für diesen Auftrag verbucht (Auftragswährung) – keine stillen Fremdwährungs-Umrechnungen.`);
  const raw = amount !== undefined ? amount : amount_chf;
  const max = CURRENCIES[cur].max, step = fromMinor(1, cur);
  const value = roundTo(Number(raw), cur);
  if (!Number.isFinite(Number(raw)) || !Number.isFinite(value) || value <= 0 || value > max
    || (cur === "VND" && !Number.isInteger(Number(raw)))) throw new Error(`Ungültiger Betrag "${raw}" – erlaubt sind ${step} bis ${max} ${cur}${cur === "VND" ? " (ganze Dong)" : ""}.`);
  const src = String(source || "").trim().toLowerCase();
  if (!SOURCE_RE.test(src)) throw new Error("Ungültige Quelle (--source): Kleinbuchstaben/Ziffern/_- wie bank_transfer, manual_bank_confirmation, twint, cash.");
  const at = received_at || now.toISOString();
  if (Number.isNaN(Date.parse(at))) throw new Error("received_at/--date muss ein gültiges Datum sein.");
  const data = readLedger(store);
  // Duplikatschutz: dieselbe Referenz zählt nie doppelt (nur stornierte Einträge geben die Referenz wieder frei).
  const ref = normRef(reference);
  if (ref) {
    const dup = Object.values(data.payments || {}).find((p) => p && p.status !== "VOIDED" && normRef(p.reference) === ref);
    if (dup) throw new Error(`Doppelte Zahlungsreferenz – bereits verbucht als ${dup.payment_id} (${dup.order_id}). Nichts verbucht.`);
  }
  let payment_id;
  do { payment_id = `PAY-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${sha(order.order_id + value + at + crypto.randomUUID()).slice(0, 8)}`; }
  while (data.payments[payment_id]);
  const entry = {
    payment_id, order_id: order.order_id, domain: order.domain, offer_class: order.offer_class,
    ...(cur === "CHF" ? { amount_chf: value } : {}), amount: value, currency: cur, market: order.market, received_at: new Date(at).toISOString(),
    source: src, reference: reference ? String(reference).replace(/\s+/g, " ").trim().slice(0, 200) : null,
    provider_mode, ...(provider_mode === "TEST" ? { is_test: true } : {}),
    status: "RECEIVED", created_at: now.toISOString(),
  };
  data.payments = { ...(data.payments || {}), [payment_id]: entry };
  writeLedger(store, data);
  return entry;
}

// Fehlbuchung/Rückerstattung: NIE löschen, nur markieren (Status + Zeitpunkt + Pflicht-Grund); Original bleibt erhalten.
function markPayment(store, paymentId, status, { reason, now = new Date() } = {}) {
  const r = String(reason || "").replace(/\s+/g, " ").trim();
  if (!r) throw new Error('Begründung ist Pflicht: --reason "<grund>".');
  const data = readLedger(store);
  const p = data.payments?.[paymentId]; // nur exakter Treffer – nie ein «ähnlicher» Eintrag
  if (!p) throw new Error(`Keine Zahlung "${paymentId}" vorhanden.`);
  if (p.status !== "RECEIVED") throw new Error(`Zahlung ${paymentId} ist bereits ${p.status} – keine weitere Änderung.`);
  const next = { ...p, status, [`${status.toLowerCase()}_at`]: now.toISOString(), [`${status.toLowerCase()}_reason`]: r.slice(0, 300) };
  data.payments = { ...data.payments, [paymentId]: next };
  writeLedger(store, data);
  return next;
}
export const voidPayment = (store, paymentId, opts) => markPayment(store, paymentId, "VOIDED", opts);
export const refundPayment = (store, paymentId, opts) => markPayment(store, paymentId, "REFUNDED", opts);

export function paymentsForOrder(store, orderId) {
  return Object.values(readLedger(store).payments || {})
    .filter((p) => p && p.order_id === orderId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}
// Kumulativ tatsächlich eingegangen in einer Währung (nur RECEIVED) – primär an die ORDER_ID gebunden, nie an die Domain.
// TF-080: test = Modus des Auftrags (Gate eines Test-Auftrags zählt nur Testzahlungen, jedes andere nur LIVE).
export function paidAmount(store, orderId, currency = "CHF", { test = false } = {}) {
  const minor = paymentsForOrder(store, orderId).filter((p) => p.status === "RECEIVED" && paymentCurrency(p) === currency && isTestPayment(p) === (test === true))
    .reduce((a, p) => a + toMinor(paymentAmount(p), currency), 0);
  return fromMinor(minor, currency);
}
export const paidChf = (store, orderId) => paidAmount(store, orderId, "CHF");

// Zahlungs-Gate eines Auftrags: erfüllt erst, wenn kumulativ mindestens die erste Hälfte des Festpreises in der
// Auftragswährung eingegangen ist. Unbekanntes Angebot/fehlende VN-Währung → nie erfüllt (fail closed).
export function paymentGateForOrder(store, order = {}) {
  const m = orderMoney(order);
  const currency = m?.currency || null;
  const required = m ? m.deposit : null;
  const paid = order.order_id && currency ? paidAmount(store, order.order_id, currency, { test: order.test_order === true }) : 0;
  // CH: exakt das bisherige Format (required_chf/paid_chf). VN: currency + required/paid in VND (nie *_chf).
  if (currency === "VND") return { order_id: order.order_id || null, offer_class: order.offer_class || null, currency, required, paid, satisfied: required != null && paid >= required };
  return { order_id: order.order_id || null, offer_class: order.offer_class || null, required_chf: required, paid_chf: paid, satisfied: required != null && paid >= required };
}
// Gate-Stand lesen (CH: paid_chf/required_chf, VN: paid/required + currency).
export const gatePaid = (g) => (Number.isFinite(g?.paid) ? g.paid : Number.isFinite(g?.paid_chf) ? g.paid_chf : null);
export const gateRequired = (g) => (Number.isFinite(g?.required) ? g.required : Number.isFinite(g?.required_chf) ? g.required_chf : null);
export const gateText = (g) => `${amountText(gatePaid(g), g.currency || "CHF")} von mind. ${amountText(gateRequired(g), g.currency || "CHF")}`;

// Zahlungsstatus eines Auftrags (Dashboard/CLI): nur Zahlen + festes Zustandswort – nie Referenzen oder payment_ids.
// Felder *_chf nur für CHF-Aufträge (Legacy-Dashboard); market/currency/*_amount für alle.
export function paymentSummary(store, order = {}) {
  const m = orderMoney(order);
  const currency = m?.currency || null;
  const price = m ? m.price : null, deposit = m ? m.deposit : null;
  const list = order.order_id ? paymentsForOrder(store, order.order_id).filter((p) => isTestPayment(p) === (order.test_order === true)) : [];
  const paid = order.order_id && currency ? paidAmount(store, order.order_id, currency, { test: order.test_order === true }) : 0;
  let status = "UNPAID";
  if (order.state === "PAYMENT_REVIEW_REQUIRED") status = "PAYMENT_REVIEW_REQUIRED";
  else if (price != null && paid >= price) status = "PAID_FULL";
  else if (deposit != null && paid >= deposit) status = "DEPOSIT_MET";
  else if (paid > 0) status = "PARTIAL";
  else if (list.some((p) => p.status === "REFUNDED")) status = "REFUNDED";
  const rest = deposit == null ? null : fromMinor(Math.max(0, toMinor(deposit, currency) - toMinor(paid, currency)), currency);
  const restTotal = price == null ? null : fromMinor(Math.max(0, toMinor(price, currency) - toMinor(paid, currency)), currency);
  return { market: m?.market || null, currency, price_amount: price, deposit_amount: deposit, paid_amount: paid, rest_to_deposit_amount: rest, rest_amount: restTotal,
    ...(currency === "CHF" || !currency ? { price_chf: price, deposit_chf: deposit, paid_chf: paid, rest_to_deposit_chf: rest } : {}), payment_status: status };
}

// TF-085: Anzeige-Sicht eines Auftrags (CLI `--show`): Zahlungsstand IMMER frisch aus dem Ledger berechnet, nie aus dem gespeicherten
// Schnappschuss `order.payment` (den nur der Erfüllungs-Workflow nachzieht – Testaufträge CHF 150 laufen dort bewusst nicht durch).
// Reine Leseansicht: schreibt nichts, bucht nichts, ändert weder Ledger noch Auftrag. TEST/LIVE getrennt wie überall (order.test_order).
export function withLivePayment(store, order) {
  if (!order || typeof order !== "object" || !order.order_id) return order;
  const gate = paymentGateForOrder(store, order);
  return { ...order, payment: gate, payment_status: paymentSummary(store, order).payment_status, payment_source: "ledger",
    ...(order.payment !== undefined ? { payment_snapshot_stored: order.payment } : {}) };
}

// Zähler/Summen fürs Dashboard – keine Referenzen; Summen je Währung getrennt (nie CHF und VND addieren).
// TF-080: nur LIVE-Zahlungen zählen (Umsatz/Summen); Testzahlungen nur als eigene Anzahl.
export function paymentsStatus(dir = WORKER_DIR) {
  const raw = Object.values(createStore(dir).read(PAYMENTS_FILE, { payments: {} }).payments || {});
  const list = raw.filter((p) => !isTestPayment(p));
  const by = (s, cur) => list.filter((p) => p.status === s && paymentCurrency(p) === cur);
  const sum = (xs, cur) => fromMinor(xs.reduce((a, p) => a + toMinor(paymentAmount(p), cur), 0), cur);
  const all = (s) => list.filter((p) => p.status === s);
  return { total: list.length, received: all("RECEIVED").length, voided: all("VOIDED").length, refunded: all("REFUNDED").length,
    received_chf: sum(by("RECEIVED", "CHF"), "CHF"), refunded_chf: sum(by("REFUNDED", "CHF"), "CHF"),
    received_vnd: sum(by("RECEIVED", "VND"), "VND"), refunded_vnd: sum(by("REFUNDED", "VND"), "VND"), test_payments: raw.length - list.length };
}

// ---------- Kommandozeile ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, key] = process.argv.slice(2);
  const opt = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  const gateLine = (o) => {
    const g = paymentGateForOrder(store, o), s = paymentSummary(store, o), c = g.currency || "CHF";
    return `${g.order_id}: ${amountText(gatePaid(g), c)} von mind. ${amountText(gateRequired(g), c)} eingegangen (Festpreis ${amountText(s.price_amount, c)}, Status ${s.payment_status}) → ${g.satisfied ? "SCHWELLE ERFÜLLT" : `WARTET AUF ZAHLUNG (noch ${amountText(s.rest_to_deposit_amount, c)})`}`;
  };
  try {
    if (cmd === "record") {
      if (!opt("reference")) throw new Error('Referenz ist Pflicht: --reference "<Bank-/Zahlungsreferenz>" (Duplikatschutz).');
      const p = recordPayment(store, { order_id: key, amount: opt("amount"), currency: opt("currency"), source: opt("source") || "bank_transfer", reference: opt("reference"), received_at: opt("date") });
      console.log(`Zahlung verbucht: ${p.payment_id} → ${p.order_id} (${p.domain}) ${amountText(p.amount, p.currency)} [${p.source}]`);
      console.log(gateLine(findPayableOrder(store, p.order_id)));
    } else if (cmd === "list") {
      const list = key ? paymentsForOrder(store, key) : Object.values(store.read(PAYMENTS_FILE, { payments: {} }).payments || {});
      console.log(JSON.stringify(list, null, 2));
    } else if (cmd === "show" || cmd === "status") {
      const o = findPayableOrder(store, key);
      if (!o) throw new Error(`Kein Auftrag mit order_id "${key}".`);
      console.log(gateLine(o));
      console.log(JSON.stringify(paymentsForOrder(store, key).map((p) => ({ payment_id: p.payment_id, amount: paymentAmount(p), currency: paymentCurrency(p), status: p.status, received_at: p.received_at, source: p.source })), null, 2));
    } else if (cmd === "void" || cmd === "refund") {
      const p = (cmd === "void" ? voidPayment : refundPayment)(store, key, { reason: opt("reason") });
      console.log(`Zahlung ${p.payment_id} → ${p.status}. Eintrag bleibt gespeichert (nie löschen). ${gateLine(findPayableOrder(store, p.order_id) || { order_id: p.order_id, offer_class: p.offer_class })}`);
    } else {
      console.log('Befehle: record <order_id> --amount <betrag> --reference "<ref>" [--currency CHF|VND] [--source manual_bank_confirmation] [--date JJJJ-MM-TT] | list [order_id] | show <order_id> | void <payment_id> --reason "<grund>" | refund <payment_id> --reason "<grund>"');
      process.exit(1);
    }
  } catch (e) { console.error("Fehler: " + e.message); process.exit(1); }
}
