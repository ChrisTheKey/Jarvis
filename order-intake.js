// Bestätigte VN-Aufträge aus der Cloud übernehmen (TF-064) – läuft im Repair-Dienst (dort liegen check150_orders.json,
// repair_orders.json, sales.json und payments.json). Nur ausgehend: Abholen über /api/sales (x-jarvis-worker), Ergebnis zurückmelden.
//
// Fail closed, idempotent je request_id:
//   - nur market VN, nur VN_REPAIR_CHECK / VN_REPAIR_FIX, Verkäufer Kudoshin (TF-070, vormals lap); Preis/Währung/Schwelle werden HIER erneut aus pricing.js
//     bestimmt – weicht die Anfrage ab, wird nichts angelegt (PRICE_MISMATCH). Domain/E-Mail müssen gültig sein.
//   - bereits angewendete request_id → derselbe Auftrag wird erneut gemeldet (kein Duplikat nach Neustart/Lease-Ablauf)
//   - offener Auftrag derselben Domain (beide Workflows) → DUPLICATE_OPEN_ORDER
//   - Verkauf (sales.json, Quelle vn_sales_confirmed) + Auftrag; VERKAUF != ZAHLUNG: der Auftrag wartet danach auf die Schwelle
//     (495000 bzw. 1950000 VND), die ausschliesslich Chris im Payment-Ledger verbucht.
import { createStore } from "./mail-worker.js";
import { recordSale } from "./sales.js";
import { offerInfo, isVnOfferClass, isCheckOffer } from "./pricing.js";
import { createCheck150Order } from "./check-150-workflow.js";
import { createRepairOrder } from "./repair-workflow.js";
import { VN_SELLER_ID, canonicalSellerId } from "./seller-identity.js";

export const ORDER_INTAKE_FILE = "order_intake.json";
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const REQ_RE = /^[0-9a-f-]{36}$/;
const LEAD_RE = /^[a-z0-9][a-z0-9.@_+-]{2,252}$/;

export function applyOrderRequest(store, r, { now = new Date() } = {}) {
  const fail = (code, error) => ({ ok: false, code, error });
  if (!r || !REQ_RE.test(String(r.request_id || ""))) return fail("BAD_REQUEST", "request_id ungültig");
  const applied = store.read(ORDER_INTAKE_FILE, { schema: 1, applied: {} });
  const prev = applied.applied?.[r.request_id];
  if (prev?.order_id) return { ok: true, order_id: prev.order_id, duplicate: true };
  const info = offerInfo(r.offer_class);
  if (!info || !isVnOfferClass(r.offer_class) || r.market !== "VN") return fail("BAD_MARKET", "nur VN-Angebote");
  if (r.currency !== info.currency || r.price !== info.price) return fail("PRICE_MISMATCH", "Preis/Währung weicht von pricing.js ab");
  // TF-070 Migrationskompatibilität: eine noch vor der Umstellung angelegte Anfrage mit «lap» wird als Kudoshin übernommen – geschrieben wird nur Kudoshin.
  const actorId = canonicalSellerId(r.actor_user_id);
  if (canonicalSellerId(r.seller_id) !== VN_SELLER_ID || ![VN_SELLER_ID, "chris"].includes(actorId)) return fail("BAD_ACTOR", "Verkäufer/Akteur ungültig");
  const domain = String(r.domain || "").toLowerCase().replace(/^www\./, "");
  if (!DOMAIN_RE.test(domain) || !LEAD_RE.test(String(r.lead_id || ""))) return fail("BAD_LEAD", "Domain/Lead ungültig");
  const email = String(r.delivery_email || "").toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("NO_EMAIL", "Kunden-E-Mail fehlt");
  const website = typeof r.website === "string" && /^https?:\/\/[^\s<>"']+$/i.test(r.website) && r.website.length <= 300 ? r.website : `https://${domain}/`;
  const company = typeof r.company === "string" ? r.company.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || null : null;
  const vn = { lead_id: r.lead_id, seller_id: VN_SELLER_ID, confirmed_by: actorId, confirmed_at: typeof r.confirmed_at === "string" ? r.confirmed_at.slice(0, 40) : now.toISOString(), source: "vn_sales_confirmed", request_id: r.request_id };
  let order;
  try {
    const sales = store.read("sales.json", { records: {} });
    // Zuerst den Auftrag (wirft bei offenem Auftrag derselben Domain), dann den Verkauf – nie ein Verkauf ohne Auftrag.
    order = isCheckOffer(r.offer_class)
      ? createCheck150Order(store, { domain, website, company, delivery_email: email, offer_class: r.offer_class, vn, now })
      : createRepairOrder(store, { domain, website, company, lead_id: r.lead_id, delivery_email: email, offer_class: r.offer_class, vn, now });
    const records = recordSale(sales.records || {}, domain, { offer: r.offer_class, date: now.toISOString().slice(0, 10), now,
      extra: { source: "vn_sales_confirmed", lead_id: r.lead_id, seller_id: VN_SELLER_ID, confirmed_by: actorId, order_id: order.order_id } });
    store.write("sales.json", { ...sales, records });
  } catch (e) {
    if (/läuft bereits/.test(e.message)) return fail("DUPLICATE_OPEN_ORDER", "offener Auftrag für diese Domain");
    return fail("CREATE_FAILED", String(e.message).slice(0, 120));
  }
  const cur = store.read(ORDER_INTAKE_FILE, { schema: 1, applied: {} });
  cur.applied = { ...(cur.applied || {}), [r.request_id]: { order_id: order.order_id, at: now.toISOString() } };
  const keys = Object.keys(cur.applied);
  if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete cur.applied[k];
  store.write(ORDER_INTAKE_FILE, cur);
  return { ok: true, order_id: order.order_id };
}

// Cloud-Client (nur HTTPS bzw. localhost für Tests), gleicher Worker-Token wie der Access-Intake.
export function orderIntakeClient({ config, fetchFn = globalThis.fetch } = {}) {
  if (!config?.workerToken || !config?.url) return null;
  const origin = config.url.replace(/\/api\/state$/, "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return null;
  const post = async (body) => {
    const r = await fetchFn(origin + "/api/sales", { method: "POST", headers: { "content-type": "application/json", "x-jarvis-worker": config.workerToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 409) throw new Error(`sales HTTP ${r.status}`); // nie Antwortinhalte loggen
    return j;
  };
  return { pull: async () => (await post({ op: "orders.pull" })).requests || [], result: (x) => post({ op: "orders.result", ...x }) };
}

export async function syncOrderIntake({ dir, client, now = () => new Date(), log = () => {} }) {
  if (!client) return { pulled: 0, created: 0, failed: 0 };
  const store = createStore(dir);
  const list = await client.pull();
  let created = 0, failed = 0;
  for (const r of list) {
    const res = applyOrderRequest(store, r, { now: now() });
    if (res.ok) { created += res.duplicate ? 0 : 1; log("info", "vn_order_created", { order_id: res.order_id, duplicate: !!res.duplicate }); }
    else { failed++; log("warn", "vn_order_rejected", { code: res.code }); }
    await client.result({ request_id: r.request_id, ok: res.ok, ...(res.ok ? { order_id: res.order_id } : { code: res.code, error: res.error }) });
  }
  return { pulled: list.length, created, failed };
}
