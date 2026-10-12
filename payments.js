// Jarvis Payment Ledger (TF-041) – VERKAUF != ZAHLUNG. Ein sale / direct-sale / create-confirmed / ORDER_CONFIRMED ist nur
// die Auftragsbestätigung und bedeutet NIE automatisch «Geld eingegangen». Dieses Modul führt das persistente Zahlungsbuch
// (.secrets/mail_worker/payments.json, atomar über createStore, liegt im verschlüsselten Backup) und berechnet je Auftrag
// die kumulativ tatsächlich eingegangene Zahlung. Ein bestätigter Auftrag kann mit paid_chf = 0 existieren und muss warten.
//
// Zahlungsschwelle (erste Hälfte des Festpreises aus OFFERS – keine eigene Preisliste):
//   REPAIR_CHECK_150 → CHF 75    erst ab der Schwelle: bezahlter Check, Anleitung, Kundenbericht, automatische Service-Mail
//   REPAIR_FIX_500   → CHF 240   erst ab der Schwelle: Kunde um sicheren Zugang bitten, danach der CHF-480-Reparaturworkflow
// Die Gates prüfen die Workflows selbst (check-150-workflow.js / repair-workflow.js) über paymentGateForOrder.
//
// Harte Regeln (fail closed):
//   - Jede Zahlung ist primär an eine ORDER_ID gebunden (CA150-… oder RF480-…), nie nur an eine Domain – mehrere Aufträge
//     derselben Firma bleiben sicher getrennt. Unbekannte order_id → Fehler, nichts wird erraten oder angelegt.
//   - Zahlungseinträge werden NIE gelöscht: Korrekturen nur als Status-Markierung (VOIDED/REFUNDED) mit Pflicht-Grund;
//     alle Originaldaten bleiben erhalten. Nur Status RECEIVED zählt zur kumulativen Zahlung.
//   - Nur CHF (keine stillen Fremdwährungs-Umrechnungen); Betrag > 0, auf Rappen gerundet, mit Obergrenze.
//   - Duplikatschutz: dieselbe Zahlungsreferenz (normalisiert: Gross/Klein und Leerzeichen egal) zählt nie doppelt – eine
//     zweite Buchung mit einer Referenz, die schon an einer nicht stornierten Zahlung hängt, wird abgelehnt (Korrektur: void).
//   - Keine Secrets: nur Betrag/Quelle/Referenztext – nie Kontodaten, IBAN-Listen oder Tokens in diesem Modul.
//
// Abgeleiteter Zahlungsstatus je Auftrag (paymentSummary, Preis/Deposit aus OFFERS, nie gespeichert):
//   UNPAID · PARTIAL (unter Deposit) · DEPOSIT_MET (≥ Deposit) · PAID_FULL (≥ Festpreis) · REFUNDED (alles zurückerstattet)
//   · PAYMENT_REVIEW_REQUIRED (Zahlung fiel unter die Schwelle, nachdem die Website schon verändert wurde – Chris entscheidet)
//
//   node payments.js record <order_id> --amount 75 --reference "<ref>" [--currency CHF] [--source manual_bank_confirmation] [--date JJJJ-MM-TT]
//   node payments.js list [order_id]          alle bzw. die Zahlungen eines Auftrags
//   node payments.js show <order_id>          kumulative Zahlung + Zahlungsstatus + Gate des Auftrags (Alias: status)
//   node payments.js void <payment_id> --reason "<grund>"      Fehlbuchung markieren (nie löschen)
//   node payments.js refund <payment_id> --reason "<grund>"    Rückerstattung markieren (nie löschen)
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore } from "./mail-worker.js";
import { OFFERS, isOfferClass } from "./sales.js";

export const PAYMENTS_FILE = "payments.json";
export const PAYMENT_STATUS = Object.freeze(["RECEIVED", "VOIDED", "REFUNDED"]);
export const ORDER_PAYMENT_STATES = Object.freeze(["UNPAID", "PARTIAL", "DEPOSIT_MET", "PAID_FULL", "REFUNDED", "PAYMENT_REVIEW_REQUIRED"]);
// Erste Hälfte des Festpreises – immer aus OFFERS abgeleitet, nie eine dritte Preisquelle.
export const paymentThresholdChf = (offer_class) => (isOfferClass(offer_class) ? OFFERS[offer_class].price / 2 : null);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const ORDER_ID_RE = /^(CA150|RF480)-\d{8}-[0-9a-f]{6}$/;
const MAX_AMOUNT_CHF = 10_000; // weit über beiden Festpreisen – Tippfehler-Schutz, keine Preisstufe
const SOURCE_RE = /^[a-z0-9_-]{2,40}$/;
const normRef = (r) => String(r || "").replace(/\s+/g, " ").trim().toLowerCase();
const round2 = (n) => Math.round(n * 100) / 100;

// Auftrag zu einer order_id – Dateinamen bewusst lokal (wie collectDomainOrders in sales.js), damit kein Import-Zyklus
// entsteht (check-150-workflow.js und repair-workflow.js importieren beide aus payments.js). Exakter Treffer oder null.
export function findPayableOrder(store, orderId) {
  const id = String(orderId || "").trim();
  if (!ORDER_ID_RE.test(id)) return null;
  const file = id.startsWith("CA150-") ? "check150_orders.json" : "repair_orders.json";
  const o = store.read(file, { orders: {} }).orders?.[id];
  if (!o) return null;
  return { order_id: o.order_id, domain: o.domain || null, offer_class: o.offer_class, state: o.state, file };
}

function readLedger(store) { return store.read(PAYMENTS_FILE, { schema: 1, payments: {} }); }
function writeLedger(store, data) { store.write(PAYMENTS_FILE, data); }

// Zahlung als eingegangen verbuchen – nur gegen einen existierenden Auftrag (fail closed), nie löschen, nie überschreiben.
export function recordPayment(store, { order_id, amount_chf, currency = "CHF", source = "bank_transfer", reference = null, received_at = null, now = new Date() } = {}) {
  const order = findPayableOrder(store, order_id);
  if (!order) throw new Error(`Kein Auftrag mit order_id "${order_id}" vorhanden (CA150-…/RF480-…) – Zahlungen werden nur gegen echte Aufträge verbucht.`);
  const amount = round2(Number(amount_chf));
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT_CHF) throw new Error(`Ungültiger Betrag "${amount_chf}" – erlaubt sind 0.01 bis ${MAX_AMOUNT_CHF} CHF.`);
  if (String(currency).toUpperCase() !== "CHF") throw new Error("Nur CHF wird verbucht – keine stillen Fremdwährungs-Umrechnungen.");
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
  do { payment_id = `PAY-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${sha(order.order_id + amount + at + crypto.randomUUID()).slice(0, 8)}`; }
  while (data.payments[payment_id]);
  const entry = {
    payment_id, order_id: order.order_id, domain: order.domain, offer_class: order.offer_class,
    amount_chf: amount, currency: "CHF", received_at: new Date(at).toISOString(),
    source: src, reference: reference ? String(reference).replace(/\s+/g, " ").trim().slice(0, 200) : null,
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
// Kumulativ tatsächlich eingegangen (nur RECEIVED, nur CHF) – primär an die ORDER_ID gebunden, nie an die Domain.
export function paidChf(store, orderId) {
  const sum = paymentsForOrder(store, orderId).filter((p) => p.status === "RECEIVED" && p.currency === "CHF")
    .reduce((a, p) => a + (Number.isFinite(p.amount_chf) ? p.amount_chf : 0), 0);
  return round2(sum);
}

// Zahlungs-Gate eines Auftrags: erfüllt erst, wenn kumulativ mindestens die erste Hälfte des Festpreises eingegangen ist.
// Unbekanntes Angebot → nie erfüllt (fail closed).
export function paymentGateForOrder(store, order = {}) {
  const required = paymentThresholdChf(order.offer_class);
  const paid = order.order_id ? paidChf(store, order.order_id) : 0;
  return { order_id: order.order_id || null, offer_class: order.offer_class || null,
    required_chf: required, paid_chf: paid, satisfied: required != null && paid >= required };
}

// Zahlungsstatus eines Auftrags (Dashboard/CLI): nur Zahlen + festes Zustandswort – nie Referenzen oder payment_ids.
export function paymentSummary(store, order = {}) {
  const price = isOfferClass(order.offer_class) ? OFFERS[order.offer_class].price : null;
  const deposit = paymentThresholdChf(order.offer_class);
  const list = order.order_id ? paymentsForOrder(store, order.order_id) : [];
  const paid = order.order_id ? paidChf(store, order.order_id) : 0;
  let status = "UNPAID";
  if (order.state === "PAYMENT_REVIEW_REQUIRED") status = "PAYMENT_REVIEW_REQUIRED";
  else if (price != null && paid >= price) status = "PAID_FULL";
  else if (deposit != null && paid >= deposit) status = "DEPOSIT_MET";
  else if (paid > 0) status = "PARTIAL";
  else if (list.some((p) => p.status === "REFUNDED")) status = "REFUNDED";
  return { price_chf: price, deposit_chf: deposit, paid_chf: paid,
    rest_to_deposit_chf: deposit == null ? null : round2(Math.max(0, deposit - paid)), payment_status: status };
}

// Zähler/Summen fürs Dashboard – keine Referenzen, keine Einzelbeträge fremder Sicht nötig; sicher für Cloud/HUD.
export function paymentsStatus(dir = WORKER_DIR) {
  const list = Object.values(createStore(dir).read(PAYMENTS_FILE, { payments: {} }).payments || {});
  const by = (s) => list.filter((p) => p.status === s);
  const sum = (xs) => round2(xs.reduce((a, p) => a + (Number.isFinite(p.amount_chf) ? p.amount_chf : 0), 0));
  return { total: list.length, received: by("RECEIVED").length, voided: by("VOIDED").length, refunded: by("REFUNDED").length,
    received_chf: sum(by("RECEIVED")), refunded_chf: sum(by("REFUNDED")) };
}

// ---------- Kommandozeile ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, key] = process.argv.slice(2);
  const opt = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  const gateLine = (o) => {
    const g = paymentGateForOrder(store, o), s = paymentSummary(store, o);
    return `${g.order_id}: CHF ${g.paid_chf} von mind. CHF ${g.required_chf} eingegangen (Festpreis CHF ${s.price_chf}, Status ${s.payment_status}) → ${g.satisfied ? "SCHWELLE ERFÜLLT" : `WARTET AUF ZAHLUNG (noch CHF ${s.rest_to_deposit_chf})`}`;
  };
  try {
    if (cmd === "record") {
      if (!opt("reference")) throw new Error('Referenz ist Pflicht: --reference "<Bank-/Zahlungsreferenz>" (Duplikatschutz).');
      const p = recordPayment(store, { order_id: key, amount_chf: opt("amount"), currency: opt("currency") || "CHF", source: opt("source") || "bank_transfer", reference: opt("reference"), received_at: opt("date") });
      console.log(`Zahlung verbucht: ${p.payment_id} → ${p.order_id} (${p.domain}) CHF ${p.amount_chf} [${p.source}]`);
      console.log(gateLine(findPayableOrder(store, p.order_id)));
    } else if (cmd === "list") {
      const list = key ? paymentsForOrder(store, key) : Object.values(store.read(PAYMENTS_FILE, { payments: {} }).payments || {});
      console.log(JSON.stringify(list, null, 2));
    } else if (cmd === "show" || cmd === "status") {
      const o = findPayableOrder(store, key);
      if (!o) throw new Error(`Kein Auftrag mit order_id "${key}".`);
      console.log(gateLine(o));
      console.log(JSON.stringify(paymentsForOrder(store, key).map(({ payment_id, amount_chf, status, received_at, source }) => ({ payment_id, amount_chf, status, received_at, source })), null, 2));
    } else if (cmd === "void" || cmd === "refund") {
      const p = (cmd === "void" ? voidPayment : refundPayment)(store, key, { reason: opt("reason") });
      console.log(`Zahlung ${p.payment_id} → ${p.status}. Eintrag bleibt gespeichert (nie löschen). ${gateLine(findPayableOrder(store, p.order_id) || { order_id: p.order_id, offer_class: p.offer_class })}`);
    } else {
      console.log('Befehle: record <order_id> --amount <chf> --reference "<ref>" [--currency CHF] [--source manual_bank_confirmation] [--date JJJJ-MM-TT] | list [order_id] | show <order_id> | void <payment_id> --reason "<grund>" | refund <payment_id> --reason "<grund>"');
      process.exit(1);
    }
  } catch (e) { console.error("Fehler: " + e.message); process.exit(1); }
}
