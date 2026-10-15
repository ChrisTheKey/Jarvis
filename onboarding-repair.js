// Kunden-Onboarding (TF-066) – Repair-Service-Seite: Auftragsfakten für den Dialog im Mail-Worker (onboarding/orders.json).
// Allowlist je Auftrag: Art (CHECK/FIX), Markt/Sprache, Verkäufer (nur VN-Aufträge kennen ihn hier), bestätigte Kundenadresse,
// bestätigt?, Zahlungsschwelle erfüllt?, Zugangsstatus als festes Wort (+ Ablauf des sicheren Links), Quittungen der Link-Anfragen.
// NIE: Zugangsdaten, Tresor, Token(-Hash), Links, Zahlungsreferenzen/Beträge, Berichte, Evidence, Hosts/Pfade.
import { createStore, WORKER_DIR } from "./mail-worker.js";
import { REPAIR_ORDERS_FILE, COMPLETED_STATES, BLOCKED_STATES, REPAIR_CANCELLED, repairSaleVoided } from "./repair-workflow.js";
import { CHECK150_ORDERS_FILE, CHECK150_CANCELLED, CHECK150_BLOCKED, confirmedCheck150Sale } from "./check-150-workflow.js";
import { paymentGateForOrder } from "./payments.js";
import { orderKind, localeOf } from "./onboarding-core.js";
import { writeOrdersExport } from "./onboarding-store.js";

const KEEP_TERMINAL_MS = 30 * 86_400_000;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

// Zugangsstatus (§33) – mehr erfährt der Dialog nie.
export function accessStatusOf(o, now = new Date()) {
  if (orderKind(o.offer_class) !== "FIX") return "NOT_REQUIRED";
  if (o.access?.ok === true || o.access_profile?.profile_status === "PROFILE_READY") return "ACCESS_PROFILE_READY";
  if (["RECEIVED", "DESTROYED"].includes(o.access_intake?.status)) return "ACCESS_RECEIVED";
  if (o.access_request?.sent_at) return Date.parse(o.access_request.expires_at || 0) > +now ? "ACCESS_LINK_SENT" : "ACCESS_LINK_EXPIRED";
  return "ACCESS_MISSING";
}

export function onboardingOrderEntry(store, o, { now = new Date(), kind }) {
  const cancelled = o.state === REPAIR_CANCELLED || o.state === CHECK150_CANCELLED;
  const completed = COMPLETED_STATES.includes(o.state);
  const terminal = cancelled || completed || (kind === "FIX" ? BLOCKED_STATES.includes(o.state) : CHECK150_BLOCKED.filter((s) => !/^BLOCKED_(ORDER|PAYMENT)/.test(s)).includes(o.state));
  const confirmed = kind === "CHECK" ? !!confirmedCheck150Sale(store, o.domain, o.offer_class) : !repairSaleVoided(store, o) && !!(o.confirmed || o.vn?.confirmed_at || o.payment);
  let gate = false;
  try { gate = paymentGateForOrder(store, o).satisfied === true; } catch {}
  return {
    order_id: o.order_id, kind, offer_class: o.offer_class, market: o.market === "VN" ? "VN" : "CH", locale: localeOf(o),
    seller_id: o.vn?.seller_id || null, lead_id: o.vn?.lead_id || o.lead_id || null,
    domain: o.domain, company: o.company || null, contact_name: o.contact_name || null,
    customer_email: EMAIL_RE.test(String(o.delivery_email || "")) ? String(o.delivery_email).toLowerCase() : null,
    order_confirmed: confirmed, payment_gate_met: gate, order_state: o.state, terminal, completed, cancelled,
    onboarding_required: kind === "FIX" ? o.onboarding_required === true : !!o.onboarding_intro,
    access_status: accessStatusOf(o, now), access_link_expires_at: kind === "FIX" && o.access_request?.sent_at ? o.access_request.expires_at || null : null,
    reissues: kind === "FIX" ? { ...(o.onboarding_reissues || {}) } : {},
    brief_gate: o.state === "WAITING_FOR_CUSTOMER_BRIEF" ? "WAITING" : o.customer_brief?.status || null,
  };
}

export function buildOnboardingOrders(dir = WORKER_DIR, { now = new Date() } = {}) {
  const store = createStore(dir);
  const out = {};
  const add = (orders, kind) => {
    for (const o of Object.values(orders || {})) {
      if (!o?.order_id) continue;
      const e = onboardingOrderEntry(store, o, { now, kind });
      if (e.terminal && +now - Date.parse(o.updated_at || 0) > KEEP_TERMINAL_MS) continue;
      out[o.order_id] = e;
    }
  };
  add(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders, "FIX");
  add(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders, "CHECK");
  return out;
}

export function writeOnboardingOrders({ dir = WORKER_DIR, onboardingDir, now = new Date() } = {}) {
  if (!onboardingDir) return { written: false, reason: "no_onboarding_dir" };
  return writeOrdersExport(onboardingDir, buildOnboardingOrders(dir, { now }), { now });
}
