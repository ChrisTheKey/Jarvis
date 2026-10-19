// TF-081: Zahlungslinks für die beiden Schweizer Festpreis-Angebote – EINE Quelle, ohne Abhängigkeiten ausser pricing.js.
//
//   REPAIR_CHECK_150  «Check & Anleitung»  CHF 150  → Stripe Payment Link (CHECK)
//   REPAIR_FIX_500    «Check & Reparatur»  CHF 480  → Stripe Payment Link (FIX)
//
// Ein Payment Link ist eine öffentliche Zahlungsadresse (kein Secret). Zugeordnet wird die Zahlung über `client_reference_id=<order_id>`
// (Stripe übernimmt den Parameter in die Checkout Session; payment-monitor.js liest ihn aus checkout.session.completed). Ohne Auftrag
// (z. B. Antwort auf eine Kontaktformular-Anfrage) trägt der Link nur `prefilled_email`: die Zahlung landet dann in der Prüfung
// (PAYMENT_REVIEW_REQUIRED), nie automatisch auf einem Auftrag.
// Nur CH/CHF: für VN gibt es keinen Link (nie ein CHF-Link für einen VND-Auftrag). Preise kommen aus pricing.js, nie hier.
import { offerInfo, formatMoney, ORDER_ID_RE } from "./pricing.js";

export const PAYMENT_LINKS = Object.freeze({
  REPAIR_CHECK_150: "https://buy.stripe.com/dRm3cw5A5fo3caR9ov7Re00",
  REPAIR_FIX_500: "https://buy.stripe.com/7sY00k5A54JpcaR1W37Re01",
});
export const PAYMENT_LINK_RE = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]{10,64}$/;
// Kunden-sichtbare Paketnamen (DE) – wie in den Zahlungs-/Readiness-Texten des Projekts.
export const PACKAGE_NAMES_DE = Object.freeze({ CHECK: "Check & Anleitung", FIX: "Check & Reparatur" });
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,24}$/i;

// Link des Angebots (Klasse) oder null: unbekannte Klasse, VN-Angebot oder kaputt konfigurierter Link → null (fail closed).
export function paymentLinkFor(offerClass, { orderId = null, email = null } = {}) {
  const info = offerInfo(offerClass);
  const base = PAYMENT_LINKS[offerClass];
  if (!info || info.market !== "CH" || info.currency !== "CHF" || !base || !PAYMENT_LINK_RE.test(base)) return null;
  const q = [];
  if (orderId != null) {
    if (!ORDER_ID_RE.test(String(orderId))) return null; // eine ungültige Auftrags-ID wird nie erraten oder weggelassen
    q.push(`client_reference_id=${encodeURIComponent(orderId)}`);
  }
  if (email && EMAIL_RE.test(String(email)) && String(email).length <= 120) q.push(`prefilled_email=${encodeURIComponent(String(email).toLowerCase())}`);
  return q.length ? `${base}?${q.join("&")}` : base;
}

// CHECK|FIX → Angebotsklasse des CH-Markts.
const CLASS_OF = Object.freeze({ CHECK: "REPAIR_CHECK_150", FIX: "REPAIR_FIX_500" });
export const offerClassOfKind = (kind) => CLASS_OF[kind] || null;

// Aus dem Formularfeld «Interesse an» (Auswahl, nie freier Nachrichtentext) das Paket ableiten. Eindeutig → "CHECK" | "FIX",
// sonst null (Kunde bekommt dann beide Pakete zur Auswahl). Nennt das Feld beides, ist es nicht eindeutig.
export function packageOfInterest(interest) {
  const s = String(interest ?? "").normalize("NFC").toLowerCase();
  if (!s.trim()) return null;
  const fix = /reparatur|reparier|repair|behebung|beheb|\b480\b/.test(s);
  const chk = /anleitung|analyse|prüf|pruef|audit|\bcheck\b|\b150\b/.test(s);
  if (fix && /anleitung|\b150\b/.test(s)) return null; // «Anleitung ODER Reparatur» → nicht raten
  if (fix) return "FIX";
  if (chk) return "CHECK";
  return null;
}

// Deutsche Textzeilen mit Paket(en) und Link(s). kind = "CHECK" | "FIX" | null (beide). Leeres Array, wenn kein Link verfügbar ist.
export function paymentLinesDe({ kind = null, orderId = null, email = null } = {}) {
  const kinds = kind ? [kind] : ["CHECK", "FIX"];
  const rows = kinds.map((k) => {
    const cls = offerClassOfKind(k), info = cls && offerInfo(cls), url = cls && paymentLinkFor(cls, { orderId, email });
    return info && url ? { k, price: formatMoney(info.price, info.currency), url } : null;
  }).filter(Boolean);
  if (!rows.length) return [];
  return rows.length === 1
    ? [`${PACKAGE_NAMES_DE[rows[0].k]} (Festpreis ${rows[0].price}) – sicher bezahlen über diesen Link:`, rows[0].url]
    : ["Zur Auswahl stehen zwei Pakete – Sie bezahlen sicher über den jeweiligen Link:", "",
      ...rows.flatMap((r) => [`${PACKAGE_NAMES_DE[r.k]} (Festpreis ${r.price}):`, r.url, ""]).slice(0, -1)];
}

// Für den Mail-Schreiber (reply-Aufgaben): feste Pakete mit Preis und Link, ausschliesslich aus Code. [] wenn kein Link verfügbar.
export function paymentOptions() {
  return ["CHECK", "FIX"].map((k) => {
    const cls = offerClassOfKind(k), info = cls && offerInfo(cls), url = cls && paymentLinkFor(cls);
    return info && url ? { package: PACKAGE_NAMES_DE[k], price: formatMoney(info.price, info.currency), link: url } : null;
  }).filter(Boolean);
}

// TF-084: Stripe-TEST-Payment-Link (Sandbox) + client_reference_id eines TEST-Auftrags. Nur für die CLI `check-150-workflow.js --create-test`;
// bewusst NICHT in PAYMENT_LINKS / paymentLinkFor (Kundenmails bekommen nie einen Testlink).
export const TEST_PAYMENT_LINK_RE = /^https:\/\/buy\.stripe\.com\/test_[A-Za-z0-9]{10,64}$/;
export function testPaymentLinkUrl(link, { orderId, email = null } = {}) {
  const base = String(link || "").trim();
  if (!TEST_PAYMENT_LINK_RE.test(base) || !ORDER_ID_RE.test(String(orderId || ""))) return null;
  const q = [`client_reference_id=${encodeURIComponent(orderId)}`];
  if (email && EMAIL_RE.test(String(email)) && String(email).length <= 120) q.push(`prefilled_email=${encodeURIComponent(String(email).toLowerCase())}`);
  return `${base}?${q.join("&")}`;
}
