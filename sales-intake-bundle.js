// TF-JARVIS-024 Phase 3: persistenter Offer-Intent-Bundle für genau eine Erstmail.
// Diese Datei enthält nur die Bindung/Idempotenz der Angebote. Zahlungs-, Auftrags- und Tresor-Gates bleiben in den bestehenden Modulen.
import crypto from "node:crypto";

export const SALES_BUNDLES_FILE = "sales_intake_bundles.json";
export const SALES_BUNDLE_SCHEMA = 1;
const OFFER150 = "REPAIR_CHECK_150";
const OFFER480 = "REPAIR_FIX_500";
const ID_RE = /^(?:CA150|RF480)-\d{8}-[0-9a-f]{6}$/;
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function readState(store) {
  return store.read(SALES_BUNDLES_FILE, { schema: SALES_BUNDLE_SCHEMA, bundles: {} });
}
function saveState(store, state) {
  store.write(SALES_BUNDLES_FILE, { schema: SALES_BUNDLE_SCHEMA, bundles: state.bundles || {} });
}
function validId(value, label) {
  if (!ID_RE.test(String(value || ""))) throw new Error(`${label} ungültig.`);
  return String(value);
}
function findBundle(state, intentId) {
  return Object.values(state.bundles || {}).find((b) => b.offers?.[OFFER150]?.intent_id === intentId || b.offers?.[OFFER480]?.intent_id === intentId) || null;
}

export function bundleForIntent(store, intentId) {
  const id = String(intentId || "");
  return findBundle(readState(store), id);
}

export function createOfferIntentBundle(store, { bundle_id, lead_id, domain, email, website = null, company = null, contact_name = null, order150_id, order480_id, vaultToken = null, vaultExpiresAt = null, now = new Date() } = {}) {
  const bid = String(bundle_id || "").trim();
  if (!/^SIB-[0-9]{8}-[0-9a-f]{6}$/.test(bid)) throw new Error("Bundle-ID ungültig.");
  const i150 = validId(order150_id, "CHF-150-Intent");
  const i480 = validId(order480_id, "CHF-480-Intent");
  if (!i150.startsWith("CA150-") || !i480.startsWith("RF480-")) throw new Error("Offer-Intent-Zuordnung ungültig.");
  const state = readState(store);
  const existing = state.bundles?.[bid];
  if (existing) {
    if (existing.lead_id !== lead_id || existing.offers?.[OFFER150]?.intent_id !== i150 || existing.offers?.[OFFER480]?.intent_id !== i480) throw new Error("Bundle-ID bereits mit anderer Zuordnung vorhanden.");
    return existing;
  }
  const conflict = [i150, i480].map((id) => findBundle(state, id)).find(Boolean);
  if (conflict) throw new Error("Offer-Intent ist bereits einem Bundle zugeordnet.");
  if (!lead_id || !domain || !email) throw new Error("Lead-, Domain- und E-Mail-Zuordnung erforderlich.");
  if (vaultToken && !vaultExpiresAt) throw new Error("Vault-Ablaufzeit fehlt.");
  const at = now.toISOString();
  const bundle = {
    bundle_id: bid, lead_id: String(lead_id), domain: String(domain).toLowerCase(), website: website || `https://${String(domain).toLowerCase()}/`, company: company || null, contact_name: contact_name || null, email: String(email).toLowerCase(),
    status: "PENDING_SELECTION", selected_offer: null, selected_order_id: null, created_at: at, updated_at: at,
    vault: vaultToken ? { token_hash: sha(vaultToken), expires_at: vaultExpiresAt, status: "PENDING" } : null,
    offers: {
      [OFFER150]: { intent_id: i150, status: "OPEN", created_at: at },
      [OFFER480]: { intent_id: i480, status: "OPEN", created_at: at },
    },
  };
  state.bundles = { ...(state.bundles || {}), [bid]: bundle };
  saveState(store, state);
  return bundle;
}

export function selectOfferIntent(store, intentId, { now = new Date() } = {}) {
  const state = readState(store);
  const bundle = findBundle(state, String(intentId || ""));
  if (!bundle) return { result: "UNKNOWN_INTENT" };
  const offer = Object.entries(bundle.offers).find(([, value]) => value.intent_id === String(intentId))[0];
  const selected = bundle.selected_offer;
  if (selected === offer) return { result: "ALREADY_SELECTED", bundle, offer };
  if (selected && selected !== offer) return { result: "OFFER_CLOSED", bundle, offer };
  bundle.selected_offer = offer;
  bundle.selected_order_id = String(intentId);
  bundle.status = "SELECTED";
  bundle.offers[offer].status = "SELECTED";
  for (const [name, entry] of Object.entries(bundle.offers)) if (name !== offer) { entry.status = "CLOSED"; entry.closed_at = now.toISOString(); }
  bundle.updated_at = now.toISOString();
  saveState(store, state);
  return { result: "SELECTED", bundle, offer };
}

export function closeOfferIntentBundle(store, bundleId, { reason = "Erstmail nicht zugestellt", now = new Date() } = {}) {
  const state = readState(store);
  const bundle = state.bundles?.[String(bundleId)];
  if (!bundle || bundle.status === "CLOSED") return bundle || null;
  if (bundle.status === "SELECTED") return bundle;
  bundle.status = "CLOSED";
  bundle.close_reason = String(reason).slice(0, 200);
  bundle.closed_at = now.toISOString();
  bundle.updated_at = bundle.closed_at;
  for (const entry of Object.values(bundle.offers || {})) if (entry.status === "OPEN") { entry.status = "CLOSED"; entry.closed_at = bundle.closed_at; }
  saveState(store, state);
  return bundle;
}

export function salesBundleId(previewRef) {
  const ref = String(previewRef || "").toLowerCase();
  return `SIB-${ref.slice(0, 8)}-${sha(ref).slice(0, 6)}`;
}
