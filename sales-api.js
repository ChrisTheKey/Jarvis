// /api/sales – Provision, Lead-Zuweisungen und Vertriebs-Steuerung (TF-063). Netlify Function, Session-Auth (auth-core.js).
//
//   GET  ?view=commission        Verkäufer: NUR eigene Provision (Ausstehend/Auszahlbar/Storniert, abgeschlossene bezahlte Aufträge)
//                                OWNER: alle Verkäufer getrennt + Gesamtsummen + nicht zugeordnete Aufträge
//   GET  ?view=summary           eigene Kennzahlen (Leads im Scope, Provision) – Grundlage für den Verkäufer-Chat
//   GET  ?view=assignments       OWNER: Verteilungsbericht (nur Zählwerte/Verteilungen) + Audit
//   POST { op: "reassign", lead_id, user_id }                OWNER: CH-Lead bewusst neu zuweisen (auditiert)
//   POST { op: "commission.setSeller", order_id, seller_id } OWNER: Verkäufer vor PAYABLE korrigieren (auditiert)
//   POST { op: "vn.pause" | "vn.resume" }                     OWNER: Vietnam-Discovery anhalten/fortsetzen (Flag, der Dienst liest es)
// Provision wird bei jedem Lesen aus Snapshot (Aufträge/Zahlungen) + Zuständigkeit abgeleitet und als Buch fortgeschrieben (nie gelöscht).
import { resolveActor, can, isOwner, deny, forbidden, SELLER_IDS, publicUser } from "./auth-core.js";
import { sellerOf, reassign, distributionReport, leadMarket } from "./sales-scope.js";
import { deriveLedger, ordersFromSnapshot, summarize, overrideSeller, emptyLedger, fromMinor, MARKET_PRICING } from "./commission-ledger.js";

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const LEAD_RE = /^[a-z0-9][a-z0-9.@_+-]{2,252}$/;

export function createSalesHandler({ env, data, getSalesStore, getAuthStore = null, now = () => new Date() }) {
  async function casUpdate(key, empty, fn) {
    const store = await getSalesStore(key);
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const next = fn(state || empty());
      if (await store.set(next, etag)) return next;
    }
    throw new Error("Gleichzeitige Änderung – bitte erneut versuchen.");
  }
  // Provisionsbuch ableiten und (nur bei Änderung) speichern.
  async function ledger() {
    const d = await data();
    const [snapshot, leads, asg] = await Promise.all([d.snapshot(), d.leads(), d.assignments()]);
    const byDomain = new Map(leads.filter((l) => l.domain).map((l) => [l.domain, l]));
    const resolveSeller = (o) => {
      const l = o.domain ? byDomain.get(String(o.domain).toLowerCase().replace(/^www\./, "")) : null;
      if (!l) return { seller_id: null, lead_id: null, source: "none" }; // kein CRM-Lead (z. B. Direktkunde) → Chris ordnet bei Bedarf zu
      return { seller_id: sellerOf(l, asg), lead_id: l.lead_id, source: leadMarket(l) === "VN" ? "vn_default" : asg.assignments?.[l.lead_id] ? "assignment" : "ch_default" };
    };
    const store = await getSalesStore("commissions");
    for (let i = 0; i < 4; i++) {
      const { state, etag } = await store.get();
      const { ledger: L, changed } = deriveLedger({ ledger: state || emptyLedger(), orders: ordersFromSnapshot(snapshot), resolveSeller, now: now() });
      if (!changed || (await store.set(L, etag))) return { L, snapshot };
    }
    return { L: (await store.get()).state || emptyLedger(), snapshot };
  }

  return async (req) => {
    const a = await resolveActor(req, { env, getAuthStore, now });
    if (!a.actor) return deny(a);
    const actor = a.actor, owner = isOwner(actor);
    const url = new URL(req.url);
    if (req.method === "GET") {
      const view = url.searchParams.get("view") || "commission";
      if (view === "commission" || view === "summary") {
        if (!owner && !can(actor, "commission.own")) return forbidden();
        const { L } = await ledger();
        const pricing = { CH: MARKET_PRICING.CH.configured ? "CONFIGURED" : "NOT_CONFIGURED", VN: MARKET_PRICING.VN.configured ? "CONFIGURED" : "NOT_CONFIGURED" };
        if (!owner) {
          const mine = summarize(L, [actor.user_id])[0];
          const out = { user: publicUser(actor.user_id), commission: mine, eligible_from: L.eligible_from, rule: "COMPLETED|COMPLETED_WITH_MANUAL_ITEMS + PAID_FULL" };
          if (view === "summary") { const d = await data(); const leads = await d.scoped(actor); out.leads = { total: leads.length, with_phone: leads.filter((l) => l.phone).length, with_email: leads.filter((l) => l.email).length }; }
          return reply(200, out);
        }
        const per = summarize(L, SELLER_IDS);
        const sum = (f) => fromMinor(per.reduce((s, x) => s + Math.round(Number(x[f]) * 100), 0));
        const unassigned = Object.values(L.entries || {}).filter((e) => !e.seller_id).map((e) => ({ order_id: e.order_id, status: e.status, order_state: e.order_state, payment_status: e.payment_status }));
        return reply(200, { sellers: per, totals: { pending: sum("pending"), payable: sum("payable"), reversed: sum("reversed"), paid_completed_orders: per.reduce((s, x) => s + x.paid_completed_orders, 0) },
          unassigned, eligible_from: L.eligible_from, pricing, audit: (L.audit || []).slice(-30) });
      }
      if (view === "assignments") {
        if (!owner) return forbidden();
        const d = await data();
        const [leads, asg] = await Promise.all([d.leads(), d.assignments()]);
        const cfg = (await (await getSalesStore("config")).get()).state || {};
        const vn = await d.vnView();
        return reply(200, { report: distributionReport(leads, asg), created_at: asg.created_at, distribution: asg.distribution, audit: (asg.audit || []).slice(-30),
          vn: { status: vn?.status || null, leads: vn?.leads?.length || 0, paused: cfg.vn_paused === true } });
      }
      return reply(400, { error: "Unbekannte Ansicht." });
    }
    if (req.method !== "POST") return reply(405, { error: "Nur GET oder POST." });
    if (!owner) return forbidden("Nur der Owner darf Zuweisungen, Provisionen oder Discovery ändern.");
    let body;
    try { body = JSON.parse((await req.text()).slice(0, 8000) || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    try {
      if (body.op === "reassign") {
        if (!LEAD_RE.test(String(body.lead_id || ""))) return reply(400, { error: "lead_id ungültig." });
        const d = await data();
        const lead = (await d.leads()).find((l) => l.lead_id === body.lead_id);
        if (!lead) return reply(404, { error: "Unbekannter Lead." });
        if (leadMarket(lead) !== "CH") return reply(400, { error: "Nur Schweizer Leads sind zuweisbar (VN gehört Lap)." });
        await casUpdate("assignments", () => ({ schema: 1, assignments: {}, audit: [] }), (doc) => reassign(doc, { lead_id: body.lead_id, user_id: body.user_id, actor_user_id: actor.user_id, now: now() }));
        return reply(200, { ok: true });
      }
      if (body.op === "commission.setSeller") {
        await ledger();
        await casUpdate("commissions", emptyLedger, (L) => overrideSeller(L, { order_id: body.order_id, seller_id: body.seller_id ?? null, actor_user_id: actor.user_id, now: now() }));
        return reply(200, { ok: true });
      }
      if (body.op === "vn.pause" || body.op === "vn.resume") {
        await casUpdate("config", () => ({}), (c) => ({ ...c, vn_paused: body.op === "vn.pause", vn_paused_at: now().toISOString(), vn_paused_by: actor.user_id }));
        return reply(200, { ok: true, paused: body.op === "vn.pause" });
      }
    } catch (e) { return reply(e.code ? 409 : 500, { error: e.message, code: e.code || null }); }
    return reply(400, { error: "Unbekannte Operation." });
  };
}
