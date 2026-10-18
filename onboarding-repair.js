// Kunden-Onboarding (TF-066) – Repair-Service-Seite: Auftragsfakten für den Dialog im Mail-Worker (onboarding/orders.json).
// Allowlist je Auftrag: Art (CHECK/FIX), Markt/Sprache, Verkäufer (nur VN-Aufträge kennen ihn hier), bestätigte Kundenadresse,
// bestätigt?, Zahlungsschwelle erfüllt?, Zugangsstatus als festes Wort (+ Ablauf des sicheren Links), Quittungen der Link-Anfragen.
// NIE: Zugangsdaten, Tresor, Token(-Hash), Links, Zahlungsreferenzen/Beträge, Berichte, Evidence, Hosts/Pfade.
import { createStore, WORKER_DIR } from "./mail-worker.js";
import { REPAIR_ORDERS_FILE, COMPLETED_STATES, BLOCKED_STATES, REPAIR_CANCELLED, REPAIR_OFFER, repairSaleVoided, createContactFormRepairOrder } from "./repair-workflow.js";
import { CHECK150_ORDERS_FILE, CHECK150_CANCELLED, CHECK150_BLOCKED, confirmedCheck150Sale } from "./check-150-workflow.js";
import { paymentGateForOrder } from "./payments.js";
import { orderKind, localeOf } from "./onboarding-core.js";
import { writeOrdersExport, listContactOrderRequests, readContactOrderResults, writeContactOrderResults, CF_KEY_RE } from "./onboarding-store.js";
import { canonicalSellerId } from "./seller-identity.js";
import { cleanPlatform } from "./hosting-detect.js";

const KEEP_TERMINAL_MS = 30 * 86_400_000;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

// Zugangsstatus (§33) – mehr erfährt der Dialog nie.
export function accessStatusOf(o, now = new Date()) {
  if (orderKind(o.offer_class) !== "FIX") return "NOT_REQUIRED";
  if (o.access?.ok === true || o.access_profile?.profile_status === "PROFILE_READY") return "ACCESS_PROFILE_READY";
  if (["RECEIVED", "DESTROYED"].includes(o.access_intake?.status)) return "ACCESS_RECEIVED";
  if (o.access_request?.sent_at) return Date.parse(o.access_request.expires_at || 0) > +now ? "ACCESS_LINK_SENT" : "ACCESS_LINK_EXPIRED";
  // TF-071: Plattform/Hosting noch nicht geklärt → noch kein Link (Jarvis fragt zuerst nach der Plattform).
  if (o.platform_required && !o.platform?.access_type) return "HOSTING_INFO_MISSING";
  return "ACCESS_MISSING";
}

// TF-071 Zugangsstatus fürs CRM/Dashboard (§11) – nur für FIX-Aufträge mit Plattform-Erkennung, feste Wörter.
const READY_STATES = new Set(["BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY"]);
export function accessFlowStatus(o) {
  if (orderKind(o.offer_class) !== "FIX" || !o.platform_required) return null;
  if (READY_STATES.has(o.state)) return "READY_FOR_REPAIR";
  if (o.access?.ok === true) return "ACCESS_VALIDATED";
  if (o.access_intake?.status === "RECEIVED") return "ACCESS_RECEIVED";
  if (o.access_validation?.status === "ACCESS_VALIDATION_FAILED") return "ACCESS_VALIDATION_FAILED";
  if (o.access_request?.sent_at || o.platform?.access_type) return "WAITING_FOR_SECURE_ACCESS";
  if (o.state === "WAITING_FOR_HOSTING_INFO") return "WAITING_FOR_HOSTING_INFO";
  if (o.platform?.status === "HOSTING_UNKNOWN") return "HOSTING_UNKNOWN";
  return "DETECTING_PLATFORM";
}
export const platformExport = (o) => (orderKind(o.offer_class) === "FIX" && o.platform_required ? cleanPlatform({ ...(o.platform || {}), access_flow: accessFlowStatus(o) }) : null);

export function onboardingOrderEntry(store, o, { now = new Date(), kind }) {
  const cancelled = o.state === REPAIR_CANCELLED || o.state === CHECK150_CANCELLED;
  const completed = COMPLETED_STATES.includes(o.state);
  const terminal = cancelled || completed || (kind === "FIX" ? BLOCKED_STATES.includes(o.state) : CHECK150_BLOCKED.filter((s) => !/^BLOCKED_(ORDER|PAYMENT)/.test(s)).includes(o.state));
  const confirmed = kind === "CHECK" ? !!confirmedCheck150Sale(store, o.domain, o.offer_class) : !repairSaleVoided(store, o) && !!(o.confirmed || o.vn?.confirmed_at || o.payment);
  let gate = false;
  try { gate = paymentGateForOrder(store, o).satisfied === true; } catch {}
  return {
    order_id: o.order_id, kind, offer_class: o.offer_class, market: o.market === "VN" ? "VN" : "CH", locale: localeOf(o),
    seller_id: canonicalSellerId(o.vn?.seller_id || null), lead_id: o.vn?.lead_id || o.lead_id || null,
    domain: o.domain, company: o.company || null, contact_name: o.contact_name || null,
    customer_email: EMAIL_RE.test(String(o.delivery_email || "")) ? String(o.delivery_email).toLowerCase() : null,
    order_confirmed: confirmed, payment_gate_met: gate, order_state: o.state, terminal, completed, cancelled,
    onboarding_required: kind === "FIX" ? o.onboarding_required === true : !!o.onboarding_intro,
    access_status: accessStatusOf(o, now), access_link_expires_at: kind === "FIX" && o.access_request?.sent_at ? o.access_request.expires_at || null : null,
    reissues: kind === "FIX" ? { ...(o.onboarding_reissues || {}) } : {},
    brief_gate: o.state === "WAITING_FOR_CUSTOMER_BRIEF" ? "WAITING" : o.customer_brief?.status || null,
    platform: kind === "FIX" ? platformExport(o) : null, // TF-071: nur feste Wörter (Hosting/CMS/Zugangsweg/Konfidenz/Status)
    contact_form_keys: kind === "FIX" ? [o.contact_form?.key, ...(o.contact_form_keys || [])].filter((k) => CF_KEY_RE.test(String(k || ""))).slice(0, 10) : [], // TF-079: Hash, kein Inhalt
  };
}

// ---------- TF-079: Auftragsbitten aus dem Kontaktformular-Thread (onboarding/cf_orders) ----------
// Fail closed, idempotent je Einsendungs-Kennung: nur CH «Check & Reparatur», gültige Domain/Adresse, ausdrückliche Kundenbestätigung. Offener
// FIX-Auftrag derselben Domain mit DERSELBEN Kundenadresse → daran binden (nie ein zweiter Auftrag); fremde Adresse → Prüfung (DUPLICATE_OPEN_ORDER).
export const CF_APPLIED_FILE = "contact_form_orders.json";
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
export function applyContactFormOrders({ dir = WORKER_DIR, onboardingDir, now = new Date(), log = () => {} } = {}) {
  if (!onboardingDir) return { requests: 0 };
  const store = createStore(dir);
  const applied = store.read(CF_APPLIED_FILE, { schema: 1, applied: {} });
  const results = { ...(readContactOrderResults(onboardingDir).results || {}) };
  let created = 0, bound = 0, failed = 0, changed = false;
  for (const r of listContactOrderRequests(onboardingDir)) {
    const done = applied.applied?.[r.key];
    if (done) { if (!results[r.key]) results[r.key] = done; continue; }
    const fail = (code) => { const x = { ok: false, code, at: now.toISOString() }; applied.applied[r.key] = x; results[r.key] = x; changed = true; failed++; log("warn", "contact_form_order_rejected", { code }); };
    const domain = String(r.domain || "").toLowerCase().replace(/^www\./, "");
    const email = String(r.delivery_email || "").toLowerCase();
    if (r.offer_class !== REPAIR_OFFER || r.market !== "CH" || r.source !== "customer_reply_email" || !Date.parse(r.confirmed_at || "")) { fail("BAD_REQUEST"); continue; }
    if (!DOMAIN_RE.test(domain) || !EMAIL_RE.test(email)) { fail("BAD_LEAD"); continue; }
    const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
    const open = Object.values(data.orders || {}).find((o) => String(o.domain) === domain && !COMPLETED_STATES.includes(o.state) && o.state !== REPAIR_CANCELLED && !BLOCKED_STATES.includes(o.state));
    let order_id;
    if (open) {
      if (String(open.delivery_email || "").toLowerCase() !== email) { fail("DUPLICATE_OPEN_ORDER"); continue; }
      open.contact_form_keys = [...new Set([...(open.contact_form_keys || []), r.key])].slice(-10);
      open.updated_at = now.toISOString();
      data.orders[open.order_id] = open; store.write(REPAIR_ORDERS_FILE, data);
      order_id = open.order_id; bound++;
    } else {
      try {
        order_id = createContactFormRepairOrder(store, { domain, website: typeof r.website === "string" && /^https:\/\/[^\s<>"']{4,200}$/.test(r.website) ? r.website : null,
          company: typeof r.company === "string" ? r.company.slice(0, 120) : null, delivery_email: email, contact_name: typeof r.contact_name === "string" ? r.contact_name.replace(/[\r\n<>]/g, " ").slice(0, 80) : null,
          lead_id: typeof r.lead_id === "string" && /^[a-z0-9][a-z0-9.@_+-]{2,252}$/.test(r.lead_id) ? r.lead_id : null, contact_form_key: r.key, confirmed_at: r.confirmed_at, now }).order_id;
        created++;
      } catch (e) { log("error", "contact_form_order_failed", { error: String(e.message).slice(0, 120) }); fail("CREATE_FAILED"); continue; }
    }
    const x = { ok: true, order_id, at: now.toISOString() };
    applied.applied[r.key] = x; results[r.key] = x; changed = true;
    log("info", "contact_form_order_bound", { order_id, created: !open });
  }
  if (changed) store.write(CF_APPLIED_FILE, applied);
  writeContactOrderResults(onboardingDir, results, { now });
  return { created, bound, failed };
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
