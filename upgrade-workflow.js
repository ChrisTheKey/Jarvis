// TF-028 – eindeutig gebundenes CHF-330-Upgrade.
// Der Datensatz ist eine serverseitige Klammer zwischen dem CHF-150-Auftrag,
// der Stripe-Checkout-Session und dem späteren CHF-480-Reparaturauftrag.
import crypto from "node:crypto";
import { UPGRADE_AMOUNT_CHF, UPGRADE_OFFER, UPGRADE_PURPOSE, SOURCE_CHECK_OFFER, modeOfOrder, createUpgradeCheckoutSession } from "./stripe-payments.js";
import { paymentSummary } from "./payments.js";
import { createRepairOrder, REPAIR_ORDERS_FILE } from "./repair-workflow.js";

export const UPGRADE_FILE = "repair_upgrades.json";
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const safeText = (value, max = 120) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

const empty = () => ({ schema: 1, upgrades: {} });
const read = (store) => ({ ...empty(), ...store.read(UPGRADE_FILE, empty()) });
const write = (store, data) => { store.write(UPGRADE_FILE, data); return data; };
const sourceOrder = (store, orderId) => store.read("check150_orders.json", { orders: {} }).orders?.[orderId] || null;

function validateCheckout(sourceCheck, checkout) {
  const m = checkout?.metadata || {};
  if (!checkout?.id || !checkout?.url || m.purpose !== UPGRADE_PURPOSE || m.source_order_id !== sourceCheck.order_id
    || m.lead_id !== sourceCheck.lead_id || m.domain !== sourceCheck.domain || m.source_offer !== SOURCE_CHECK_OFFER
    || m.upgrade_offer !== UPGRADE_OFFER || m.upgrade_amount_chf !== String(UPGRADE_AMOUNT_CHF) || m.environment !== modeOfOrder(sourceCheck)
    || checkout.amount_minor !== 33000 || checkout.currency !== "CHF"
    || !/^cs_[A-Za-z0-9_-]{6,100}$/.test(String(checkout.id))
    || !/^https:\/\/checkout\.stripe\.com\/[A-Za-z0-9._/?=&%-]{8,700}$/.test(String(checkout.url))
    || checkout.livemode !== (modeOfOrder(sourceCheck) === "LIVE")) throw new Error("Upgrade-Checkout ist nicht eindeutig an den CHF-150-Auftrag gebunden.");
}

export function createUpgrade(store, { sourceCheckOrderId, lead = null, checkout, now = new Date() } = {}) {
  const sourceCheck = sourceOrder(store, sourceCheckOrderId);
  if (!sourceCheck || sourceCheck.offer_class !== SOURCE_CHECK_OFFER) throw new Error("Ursprünglicher CHF-150-Auftrag unbekannt.");
  if (lead?.lead_id != null && String(lead.lead_id) !== String(sourceCheck.lead_id)) throw new Error("Lead passt nicht zum ursprünglichen Auftrag.");
  const sourcePayment = paymentSummary(store, sourceCheck);
  if (sourcePayment.payment_status !== "PAID_FULL") throw new Error("CHF-150-Auftrag ist noch nicht vollständig bezahlt.");
  validateCheckout(sourceCheck, checkout);
  const data = read(store);
  const existing = Object.values(data.upgrades || {}).find((item) => item.source_check_order_id === sourceCheck.order_id
    && !["CANCELLED", "REJECTED"].includes(item.status));
  if (existing) return existing;
  const upgradeId = `UPG-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${sha(`${sourceCheck.order_id}|${checkout.id}`).slice(0, 10)}`;
  const item = {
    upgrade_id: upgradeId, source_check_order_id: sourceCheck.order_id, lead_id: sourceCheck.lead_id,
    customer_id: lead?.customer_id || sourceCheck.customer_id || null, domain: sourceCheck.domain,
    source_offer: SOURCE_CHECK_OFFER, upgrade_offer: UPGRADE_OFFER, amount_chf: UPGRADE_AMOUNT_CHF, currency: "CHF",
    provider_mode: modeOfOrder(sourceCheck), checkout_session_id: checkout.id, checkout_url: checkout.url,
    status: "OPEN", payment_id: null, payment_intent_id: null, repair_order_id: null,
    created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
  };
  data.upgrades[upgradeId] = item;
  write(store, data);
  return item;
}

export async function getOrCreateUpgradeCheckout({ store, sourceCheck, lead = null, env = process.env, mode = modeOfOrder(sourceCheck), origin,
  fetchFn = globalThis.fetch, now = new Date() } = {}) {
  const existing = upgradeForSourceOrder(store, sourceCheck?.order_id);
  if (existing) return existing;
  const checkout = await createUpgradeCheckoutSession({ env, sourceCheck, lead, mode, origin, fetchFn, now });
  return createUpgrade(store, { sourceCheckOrderId: sourceCheck.order_id, lead, checkout, now });
}

export function upgradeForSession(store, sessionId) {
  return Object.values(read(store).upgrades || {}).find((item) => item.checkout_session_id === sessionId) || null;
}

export function upgradeForSourceOrder(store, sourceCheckOrderId) {
  return Object.values(read(store).upgrades || {}).find((item) => item.source_check_order_id === sourceCheckOrderId) || null;
}

export function upgradeStatus(store, sourceCheckOrderId) {
  const item = upgradeForSourceOrder(store, sourceCheckOrderId);
  if (!item) return { status: "NOT_CREATED", source_check_order_id: sourceCheckOrderId, repair_order_id: null };
  return { status: item.status, source_check_order_id: item.source_check_order_id, repair_order_id: item.repair_order_id || null,
    provider_mode: item.provider_mode, amount_chf: item.amount_chf, updated_at: item.updated_at };
}

export function updateUpgrade(store, upgradeId, patch = {}, { now = new Date() } = {}) {
  const data = read(store);
  const item = data.upgrades?.[upgradeId];
  if (!item) throw new Error("Upgrade nicht gefunden.");
  data.upgrades[upgradeId] = { ...item, ...patch, upgrade_id: item.upgrade_id, source_check_order_id: item.source_check_order_id, updated_at: new Date(now).toISOString() };
  write(store, data);
  return data.upgrades[upgradeId];
}

export function materializeUpgradeRepairOrder(store, upgradeId, { now = new Date() } = {}) {
  const upgrade = read(store).upgrades?.[upgradeId];
  if (!upgrade) throw new Error("Upgrade nicht gefunden.");
  const source = sourceOrder(store, upgrade.source_check_order_id);
  if (!source || source.offer_class !== SOURCE_CHECK_OFFER) throw new Error("CHF-150-Quellauftrag fehlt.");
  const existingData = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const existing = Object.values(existingData.orders || {}).find((item) => item.upgrade_id === upgrade.upgrade_id || item.source_check_order_id === source.order_id);
  if (existing) {
    if (!upgrade.repair_order_id) updateUpgrade(store, upgrade.upgrade_id, { repair_order_id: existing.order_id, status: "PAYMENT_PROCESSING" }, { now });
    return existing;
  }
  const date = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const orderId = `RF480-${date}-${sha(`${upgrade.upgrade_id}|${source.order_id}`).slice(0, 6)}`;
  const order = createRepairOrder(store, { order_id: orderId, domain: source.domain, website: source.website, lead_id: source.lead_id,
    company: source.company, delivery_email: source.delivery_email, contact_name: source.contact_name, now });
  const repairData = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  const findings = Object.fromEntries((source.findings || []).map((finding, index) => [finding.finding_id || `I${index + 1}`, {
    ...finding, repair_status: "open", source_check_order_id: source.order_id,
  }]));
  const materialized = { ...repairData.orders[order.order_id], source_check_order_id: source.order_id, upgrade_id: upgrade.upgrade_id,
    source_offer: SOURCE_CHECK_OFFER, upgrade_offer: UPGRADE_OFFER, upgrade_amount_chf: UPGRADE_AMOUNT_CHF,
    customer_authorized_repair: false, authorization: null, issues: findings, source_report: source.report || null,
    confirmed: { source: "stripe_upgrade_webhook", source_check_order_id: source.order_id, confirmed_at: new Date(now).toISOString() },
    state_history: [...(repairData.orders[order.order_id].state_history || []), { at: new Date(now).toISOString(), from: "ORDER_RECEIVED", to: "ORDER_RECEIVED",
      reason: `CHF-330-Upgrade bestätigt – Quelle ${source.order_id}; bestehende Reparatur-Gates bleiben erforderlich.` }],
  };
  if (source.test_order === true) Object.assign(materialized, { test_order: true, environment: "TEST", test_run_id: source.test_run_id || null, commission_rate_bps: 0 });
  repairData.orders[order.order_id] = materialized;
  store.write(REPAIR_ORDERS_FILE, repairData);
  updateUpgrade(store, upgrade.upgrade_id, { repair_order_id: order.order_id, status: "PAYMENT_PROCESSING" }, { now });
  return materialized;
}

export function publicUpgrade(item = {}) {
  return { upgrade_id: safeText(item.upgrade_id), source_check_order_id: safeText(item.source_check_order_id), lead_id: safeText(item.lead_id),
    status: safeText(item.status), provider_mode: item.provider_mode === "TEST" ? "TEST" : item.provider_mode === "LIVE" ? "LIVE" : "REVIEW",
    amount_chf: item.amount_chf === 330 ? 330 : null, repair_order_id: item.repair_order_id || null, updated_at: item.updated_at || null };
}
