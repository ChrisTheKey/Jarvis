// /api/sales – Provision, Lead-Zuweisungen, Vertriebs-Steuerung (TF-063) und bestätigte VN-Aufträge (TF-064). Netlify Function,
// Session-Auth (auth-core.js).
//
//   GET  ?view=commission        Verkäufer: NUR eigene Provision (Ausstehend/Auszahlbar/Storniert) in der eigenen Währung (Kudoshin: VND)
//                                OWNER: alle Verkäufer getrennt + Gesamtsummen JE WÄHRUNG (CHF und VND nie addiert) + nicht zugeordnete Aufträge
//   GET  ?view=summary           eigene Kennzahlen (Leads im Scope, Provision) – Grundlage für den Verkäufer-Chat
//   GET  ?view=assignments       OWNER: Verteilungsbericht (nur Zählwerte/Verteilungen) + Audit
//   GET  ?view=orders[&lead_id]  Kudoshin: eigene VN-Aufträge (Angebot, Preis, bezahlt, offen, Zahlungs-/Arbeitsstatus, erwartete Provision);
//                                OWNER: alle VN-Aufträge. Nie Kunden-E-Mail, Zahlungsreferenzen oder interne Pfade.
//   GET  ?view=onboarding[&lead_id][&filter]  TF-066 Kunden-Onboarding je Auftrag (Zahlungsschwelle, Zugang als Wort, Inhaltsänderungen,
//                                wartet auf, letzte Antworten, offene Punkte, bestätigte Website-Angaben). Serverseitig gescoped:
//                                OWNER alle; Verkäufer nur Aufträge zu Leads im EIGENEN Bereich (gleicher Markt). Nie Zugangsdaten,
//                                Links, Token, Rohmails oder die Kunden-E-Mail. filter: open|waiting_customer|waiting_access|
//                                waiting_confirmation|manual_review|ready
//   POST { op: "order.createConfirmed", lead_id, offer: "CHECK"|"FIX", confirmed: true }
//                                Kudoshin (SALES_AGENT_VN) bzw. OWNER: bewusst bestätigter Kundenauftrag für einen EIGENEN VN-Lead. Der Client
//                                sendet NUR lead_id + Angebot + Bestätigung – Domain, Website, Firma, E-Mail, Markt, Währung und Preis
//                                löst der Server aus dem autorisierten Lead bzw. pricing.js auf (jedes weitere Feld → 400).
//   POST { op: "reassign", lead_id, user_id }                OWNER: CH-Lead bewusst neu zuweisen (auditiert)
//   POST { op: "commission.setSeller", order_id, seller_id } OWNER: Verkäufer vor PAYABLE korrigieren (auditiert)
//   POST { op: "vn.pause" | "vn.resume" }                     OWNER: Vietnam-Discovery anhalten/fortsetzen (Flag, der Dienst liest es)
//   Repair-Dienst (x-jarvis-worker = JARVIS_MAIL_WORKER_TOKEN, nur ausgehend vom VPS):
//   POST { op: "orders.pull" }                               offene bestätigte VN-Auftragsanfragen abholen (Lease, idempotent auf dem VPS)
//   POST { op: "orders.result", request_id, ok, order_id?, code?, error? }   Ergebnis melden
//   POST { op: "identity.status" }                           TF-070: Stand der Kontoumbenennung lap → Kudoshin (nur Zählwerte/Flags)
// Zahlungen erfasst/ändert/erstattet ausschliesslich Chris auf dem VPS (payments.js) – hier gibt es dafür keine Operation.
// Provision wird bei jedem Lesen aus Snapshot (Aufträge/Zahlungen) + Zuständigkeit abgeleitet und als Buch fortgeschrieben (nie gelöscht).
import { resolveActor, can, isOwner, deny, forbidden, SELLER_IDS, publicUser } from "./auth-core.js";
import { sellerOf, reassign, distributionReport, leadMarket, VN_SELLER } from "./sales-scope.js";
import { deriveLedger, ordersFromSnapshot, summarize, totalsByCurrency, overrideSeller, recordPayout, emptyLedger, MARKET_PRICING, RATE_BPS, commissionMinor, fromMinor } from "./commission-ledger.js";
import { offerFor, offerInfo, toMinor, ORDER_ID_RE, SELLER_COMMISSION_BPS, commissionBpsAt, isCommissionBps } from "./pricing.js";
import { safeEqual } from "./shared-state.js";
import { ONBOARDING_FILTERS } from "./onboarding-core.js";
import { migrateLedger, migrateOrderRequests, migrateStoreDoc, migrateOnce, VN_SELLER_ID, LEGACY_VN_SELLER_ID } from "./seller-identity.js";

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const LEAD_RE = /^[a-z0-9][a-z0-9.@_+-]{2,252}$/;
const REQ_ID_RE = /^[0-9a-f-]{36}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
export const ORDER_FIELDS = Object.freeze(["op", "lead_id", "offer", "confirmed"]);
export const ORDER_LEASE_MS = 10 * 60_000;
export const ORDER_RATE = Object.freeze({ windowMs: 60 * 60_000, max: 20 });
// Abgeschlossene/terminale Auftragszustände (beide Workflows) – alles andere gilt als offen (keine Doppelbestellung).
export const CLOSED_ORDER_STATES = Object.freeze(["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS", "CANCELLED", "BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION",
  "BLOCKED_UNSUPPORTED_STACK", "REPAIR_FAILED", "VALIDATION_FAILED", "AUDIT_FAILED", "REPORT_FAILED", "DELIVERY_DRAFT_FAILED", "BLOCKED_UNSAFE_ACCESS", "BLOCKED_HOST_KEY_CHANGED"]);
const BLOCKED_STAGES = new Set(["DO_NOT_CONTACT", "NOT_INTERESTED", "CLOSED"]);
const emptyOrders = () => ({ schema: 1, requests: [], audit: [] });
const normDom = (d) => String(d || "").toLowerCase().replace(/^www\./, "");

export function createSalesHandler({ env, data, getSalesStore, getAuthStore = null, now = () => new Date(), newId = () => globalThis.crypto.randomUUID() }) {
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
    const [snapshot, leads, asg] = await Promise.all([d.snapshot(), d.allLeads ? d.allLeads() : d.leads(), d.assignments()]);
    const byDomain = new Map(leads.filter((l) => l.domain).map((l) => [l.domain, l]));
    const resolveSeller = (o) => {
      const l = o.domain ? byDomain.get(normDom(o.domain)) : null;
      if (!l) return { seller_id: null, lead_id: null, source: "none" }; // kein CRM-Lead (z. B. Direktkunde) → Chris ordnet bei Bedarf zu
      if (leadMarket(l) !== o.market) return { seller_id: null, lead_id: null, source: "none" }; // Markt des Auftrags = Markt des Leads
      return { seller_id: sellerOf(l, asg), lead_id: l.lead_id, source: leadMarket(l) === "VN" ? "vn_default" : asg.assignments?.[l.lead_id] ? "assignment" : "ch_default" };
    };
    const store = await getSalesStore("commissions");
    for (let i = 0; i < 4; i++) {
      const { state, etag } = await store.get();
      // TF-070: Verkäufer-Identität «lap» → «Kudoshin» im selben bedingten Schreibvorgang (keine neuen Einträge, Beträge unverändert).
      const mig = migrateLedger(state || emptyLedger());
      const { ledger: L, changed: derived } = deriveLedger({ ledger: mig.doc, orders: ordersFromSnapshot(snapshot), resolveSeller, now: now() });
      const changed = derived || mig.changed;
      if (!changed || (await store.set(L, etag))) return { L, snapshot };
    }
    return { L: migrateLedger((await store.get()).state || emptyLedger()).doc, snapshot };
  }
  const snapshotOrders = (snapshot) => [...(snapshot?.check150?.orders || []), ...(snapshot?.repair?.orders || [])].filter((o) => o && ORDER_ID_RE.test(String(o.order_id || "")));
  const isOpenState = (s) => !CLOSED_ORDER_STATES.includes(s);

  // ---------- VN-Auftragssicht (Kudoshin/OWNER): Anfrage + Auftragsstand aus dem Snapshot + erwartete Provision ----------
  function orderView(r, snap, L) {
    const o = r.order_id ? snap.find((x) => x.order_id === r.order_id) : null;
    const info = offerInfo(r.offer_class);
    const cur = info?.currency || r.currency;
    const price = info?.price ?? r.price;
    const paid = Number.isFinite(o?.paid_amount) ? o.paid_amount : 0;
    const e = r.order_id ? L?.entries?.[r.order_id] : null;
    // TF-072: Satz der Anfrage (bei Bestätigung gespeichert) bzw. Satz zum Bestätigungszeitpunkt – nie der spätere aktuelle Satz.
    const rate = !r.seller_id ? 0 : e ? e.rate_bps ?? 0 : isCommissionBps(r.commission_rate_bps) ? r.commission_rate_bps : commissionBpsAt(r.created_at);
    const expected = commissionMinor(toMinor(price, cur), rate);
    return { request_id: r.request_id, request_status: r.status, code: r.code || null, order_id: r.order_id || null, lead_id: r.lead_id, company: r.company || null, domain: r.domain,
      offer: r.offer_kind, offer_class: r.offer_class, offer_name: info?.name_vi || null, market: r.market, currency: cur, price, deposit: info?.deposit ?? null,
      paid, remaining: Math.max(0, price - paid), payment_status: o?.payment_status || "UNPAID", state: o?.state || null, phase: o?.phase || null,
      commission_expected: fromMinor(expected, cur), commission_rate_bps: rate, commission_status: e?.status || "PENDING",
      commission: e ? fromMinor(e.status === "PAYABLE" ? e.payable_minor : e.status === "REVERSED" ? e.reversed_minor : e.expected_minor, cur) : fromMinor(expected, cur),
      created_at: r.created_at, seller_id: r.seller_id };
  }

  // ---------- Repair-Dienst (VPS): bestätigte VN-Anfragen abholen / Ergebnis melden ----------
  async function agent(req) {
    let body;
    try { body = JSON.parse((await req.text()).slice(0, 8000) || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    const t = now();
    if (body.op === "orders.pull") {
      let due = [];
      await casUpdate("orders", emptyOrders, (doc) => {
        due = [];
        for (const r of doc.requests || []) {
          const stale = r.status === "processing" && +t - Date.parse(r.claimed_at || 0) > ORDER_LEASE_MS;
          if (r.status === "pending" || stale) { r.status = "processing"; r.claimed_at = t.toISOString(); due.push(r); }
        }
        return doc;
      });
      return reply(200, { requests: due.map((r) => ({ request_id: r.request_id, lead_id: r.lead_id, offer_class: r.offer_class, market: r.market, currency: r.currency, price: r.price,
        domain: r.domain, website: r.website, company: r.company, delivery_email: r.delivery_email, actor_user_id: r.actor_user_id, seller_id: r.seller_id, confirmed_at: r.created_at,
        commission_rate_bps: isCommissionBps(r.commission_rate_bps) ? r.commission_rate_bps : commissionBpsAt(r.created_at) })) });
    }
    if (body.op === "orders.result") {
      if (!REQ_ID_RE.test(String(body.request_id || ""))) return reply(400, { error: "request_id ungültig." });
      if (body.ok === true && !/^(VNCHECK|VNFIX)-\d{8}-[0-9a-f]{6}$/.test(String(body.order_id || ""))) return reply(400, { error: "order_id ungültig." });
      let status = 404;
      await casUpdate("orders", emptyOrders, (doc) => {
        const r = (doc.requests || []).find((x) => x.request_id === body.request_id);
        if (!r) { status = 404; return doc; }
        if (r.status !== "processing") { status = r.status === "done" && r.order_id === body.order_id ? 200 : 409; return doc; }
        status = 200;
        r.status = body.ok === true ? "done" : "failed";
        r.finished_at = t.toISOString();
        if (body.ok === true) r.order_id = body.order_id;
        else { r.code = typeof body.code === "string" && /^[A-Z_]{2,40}$/.test(body.code) ? body.code : "FAILED"; r.error = String(body.error || "").replace(/[^\p{L}\p{N} .,:;()–\/'’-]/gu, "").slice(0, 200) || null; }
        doc.audit = [...(doc.audit || []), { ts: t.toISOString(), actor_user_id: "system:repair", action: "order.result", request_id: r.request_id, lead_id: r.lead_id, result: r.status, order_id: r.order_id || null, code: r.code || null }].slice(-2000);
        return doc;
      });
      return reply(status, status === 200 ? { ok: true } : { error: status === 404 ? "Unbekannte Anfrage." : "Anfrage ist bereits abgeschlossen." });
    }
    if (body.op === "identity.status") {
      // TF-070: nur Zählwerte und Flags – keine Lead-IDs, Namen, Kontaktdaten, Hashes oder Beträge.
      const d = await data();
      const authDocs = getAuthStore ? await (async () => { const s = await getAuthStore(); return { users: (await s.users.get()).state || {}, sessions: (await s.sessions.get()).state || {} }; })() : null;
      const [all, asg, L, od] = await Promise.all([d.leads(), d.assignments(), (async () => (await (await getSalesStore("commissions")).get()).state || emptyLedger())(),
        (async () => (await (await getSalesStore("orders")).get()).state || emptyOrders())()]);
      const users = authDocs?.users?.users || {};
      const by = (list, f, v) => list.filter((x) => x?.[f] === v).length;
      const entries = Object.values(L.entries || {}), payouts = L.payouts || [], reqs = doc0(od);
      const seller = (l) => sellerOf(l, asg);
      const vn = all.filter((l) => leadMarket(l) === "VN"), ch = all.filter((l) => leadMarket(l) === "CH");
      const mig = authDocs?.users?.identity_migrations?.["TF-070"] || null;
      return reply(200, { canonical_seller_id: VN_SELLER_ID, sellers: SELLER_IDS, vn_seller: VN_SELLER,
        auth: authDocs ? { canonical_record: Object.hasOwn(users, VN_SELLER_ID), canonical_password_set: !!users[VN_SELLER_ID]?.password, canonical_active: users[VN_SELLER_ID] ? users[VN_SELLER_ID].active !== false : null,
          legacy_record: Object.hasOwn(users, LEGACY_VN_SELLER_ID), legacy_sessions: Object.values(authDocs.sessions?.sessions || {}).filter((s) => s?.user_id === LEGACY_VN_SELLER_ID).length,
          migration: mig ? { at: mig.at, password_transferred: mig.password_transferred === true } : null } : null,
        leads: { vn_total: vn.length, vn_canonical: vn.filter((l) => seller(l) === VN_SELLER_ID).length, ch_canonical: ch.filter((l) => seller(l) === VN_SELLER_ID).length,
          legacy: all.filter((l) => seller(l) === LEGACY_VN_SELLER_ID).length, ch_by_seller: Object.fromEntries(["giuliano", "mario", "damiano"].map((s) => [s, ch.filter((l) => seller(l) === s).length])) },
        commissions: { entries: entries.length, canonical: by(entries, "seller_id", VN_SELLER_ID), legacy: by(entries, "seller_id", LEGACY_VN_SELLER_ID) + by(entries, "seller_override", LEGACY_VN_SELLER_ID),
          payouts: payouts.length, payouts_canonical: by(payouts, "seller_id", VN_SELLER_ID), payouts_legacy: by(payouts, "seller_id", LEGACY_VN_SELLER_ID) },
        orders: { requests: reqs.length, canonical: by(reqs, "seller_id", VN_SELLER_ID), legacy: by(reqs, "seller_id", LEGACY_VN_SELLER_ID) + by(reqs, "actor_user_id", LEGACY_VN_SELLER_ID) } });
    }
    return reply(400, { error: "Unbekannte Operation." });
  }
  const doc0 = (od) => (Array.isArray(od?.requests) ? od.requests : []);

  // ---------- order.createConfirmed (Kudoshin/OWNER, nur eigener VN-Lead) ----------
  async function createConfirmed(actor, body) {
    const owner = isOwner(actor);
    if (!owner && actor.role !== "SALES_AGENT_VN") return reply(403, { error: "Keine Berechtigung für Vietnam-Aufträge.", code: "FORBIDDEN" });
    if (Object.keys(body).some((k) => !ORDER_FIELDS.includes(k))) return reply(400, { error: "Nur lead_id, offer und confirmed sind erlaubt – Preis, Währung, Markt und Kundendaten bestimmt der Server.", code: "BAD_PARAMS" });
    if (!["CHECK", "FIX"].includes(body.offer)) return reply(400, { error: "Unbekanntes Angebot.", code: "BAD_PARAMS" });
    if (body.confirmed !== true) return reply(400, { error: "Kundenbestätigung fehlt.", code: "NOT_CONFIRMED" });
    if (!LEAD_RE.test(String(body.lead_id || ""))) return reply(400, { error: "lead_id ungültig.", code: "BAD_PARAMS" });
    const d = await data();
    const found = await d.resolveLead(actor, body.lead_id);
    if (!found?.lead) return reply(found?.status === 404 && owner ? 404 : 403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: found?.code || "OUT_OF_SCOPE" });
    const lead = found.lead, asg = await d.assignments();
    if (leadMarket(lead) !== "VN") return reply(403, { error: "Aufträge über diesen Weg nur für Vietnam-Leads.", code: "OUT_OF_SCOPE" });
    if (sellerOf(lead, asg) !== VN_SELLER) return reply(403, { error: "Lead ist keinem VN-Verkäufer zugeordnet.", code: "OUT_OF_SCOPE" });
    if (lead.do_not_contact) return reply(409, { error: "Do Not Contact – kein Auftrag.", code: "DO_NOT_CONTACT" });
    if (lead.archived || BLOCKED_STAGES.has(lead.sales_stage)) return reply(409, { error: "Lead-Status erlaubt keinen Auftrag.", code: "BAD_STATUS" });
    const domain = normDom(lead.domain);
    if (!domain || !/^[a-z0-9.-]{3,253}$/.test(domain)) return reply(409, { error: "Lead ohne gültige Domain.", code: "BAD_STATUS" });
    const email = String(lead.email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return reply(409, { error: "Für diesen Lead ist keine E-Mail-Adresse bekannt.", code: "NO_EMAIL" });
    const info = offerFor("VN", body.offer);
    const snap = snapshotOrders(await d.snapshot());
    const t = now();
    let res = null;
    await casUpdate("orders", emptyOrders, (doc) => {
      doc.requests ||= []; doc.audit ||= [];
      const audit = (result, code = null, extra = {}) => { doc.audit = [...doc.audit, { ts: t.toISOString(), actor_user_id: actor.user_id, action: "order.createConfirmed", lead_id: lead.lead_id, offer: body.offer, result, code, ...extra }].slice(-2000); };
      // Doppelbestellung: offene Anfrage, erledigte Anfrage mit noch offenem (oder noch nicht gemeldetem) Auftrag, oder offener Auftrag derselben Domain.
      const openReq = doc.requests.find((r) => (r.lead_id === lead.lead_id || r.domain === domain) && (["pending", "processing"].includes(r.status)
        || (r.status === "done" && (() => { const o = snap.find((x) => x.order_id === r.order_id); return !o || isOpenState(o.state); })())));
      const openOrder = snap.find((o) => normDom(o.domain) === domain && isOpenState(o.state));
      if (openReq || openOrder) { audit("denied", "DUPLICATE_OPEN_ORDER"); res = reply(409, { error: "Für diesen Lead besteht bereits ein offener Auftrag.", code: "DUPLICATE_OPEN_ORDER" }); return doc; }
      const recent = doc.requests.filter((r) => r.actor_user_id === actor.user_id && +t - Date.parse(r.created_at) < ORDER_RATE.windowMs).length;
      if (recent >= ORDER_RATE.max) { audit("denied", "RATE_LIMIT"); res = reply(429, { error: "Zu viele Aufträge – bitte später erneut.", code: "RATE_LIMIT" }); return doc; }
      const r = { request_id: newId(), lead_id: lead.lead_id, offer_kind: body.offer, offer_class: info.offer_class, market: "VN", currency: info.currency, price: info.price,
        deposit: info.deposit, domain, website: lead.website || `https://${domain}/`, company: lead.company || null, delivery_email: email,
        actor_user_id: actor.user_id, seller_id: VN_SELLER, commission_rate_bps: SELLER_COMMISSION_BPS, customer_confirmed: true, status: "pending", created_at: t.toISOString() };
      doc.requests = [...doc.requests, r].slice(-500);
      audit("queued", null, { request_id: r.request_id });
      res = reply(202, { order: orderView(r, snap, null) });
      return doc;
    });
    return res;
  }

  // TF-070: Provisionsbuch + VN-Auftragsanfragen von «lap» auf «Kudoshin» – einmal je Instanz, idempotent, vor jedem Abholen durch den VPS.
  const migrateIdentity = migrateOnce(async () => {
    await migrateStoreDoc(await getSalesStore("commissions"), migrateLedger);
    await migrateStoreDoc(await getSalesStore("orders"), migrateOrderRequests);
  });

  return async (req) => {
    await migrateIdentity();
    const workerToken = env("JARVIS_MAIL_WORKER_TOKEN");
    if (req.method === "POST" && req.headers.get("x-jarvis-worker") != null) {
      if (!workerToken || !safeEqual(req.headers.get("x-jarvis-worker"), workerToken)) return reply(401, { error: "Nicht berechtigt." });
      return agent(req);
    }
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
        const byCur = totalsByCurrency(L, SELLER_IDS);
        const unassigned = Object.values(L.entries || {}).filter((e) => !e.seller_id).map((e) => ({ order_id: e.order_id, market: e.market || "CH", currency: e.currency || "CHF", status: e.status, order_state: e.order_state, payment_status: e.payment_status }));
        // totals = CHF (Legacy-Feld, nur CHF-Einträge); totals_by_currency = CHF und VND getrennt – nie eine gemischte Summe.
        return reply(200, { sellers: per, totals: byCur.CHF, totals_by_currency: byCur, unassigned, eligible_from: L.eligible_from, pricing, audit: (L.audit || []).slice(-30) });
      }
      // TF-068 VERKÄUFE & PROVISIONEN (nur OWNER): je Verkäufer und je Auftrag, CHF und VND strikt getrennt.
      if (view === "sales_overview") {
        if (!owner) return forbidden();
        const { L, snapshot } = await ledger();
        const raw = new Map(snapshotOrders(snapshot).map((o) => [o.order_id, o]));
        const orders = ordersFromSnapshot(snapshot).map((o) => {
          const e = L.entries?.[o.order_id] || null, r = raw.get(o.order_id) || {}, cur = o.currency;
          const commission_minor = !e ? 0 : e.status === "PAYABLE" ? e.payable_minor : e.status === "REVERSED" ? e.reversed_minor : e.expected_minor;
          return { order_id: o.order_id, customer: r.company || o.domain || null, domain: o.domain, lead_id: e?.lead_id || null, seller_id: e?.seller_id || null,
            seller_source: e?.seller_source || "none", market: o.market, offer: offerInfo(o.offer_class)?.kind || null, offer_class: o.offer_class, price: o.price, paid: o.paid, currency: cur,
            confirmed_at: o.created_at, payment_status: o.payment_status || "UNPAID", fulfillment_status: o.state, commission_status: e?.status || (e ? "PENDING" : "NOT_ELIGIBLE"),
            commission_rate_bps: e?.rate_bps ?? 0,
            commission: fromMinor(commission_minor || 0, cur) };
        }).sort((a, b) => String(b.confirmed_at).localeCompare(String(a.confirmed_at)));
        const DONE = ["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"];
        const sellers = [...SELLER_IDS, null].map((sid) => {
          const mine = orders.filter((o) => o.seller_id === sid);
          const s = sid ? summarize(L, [sid])[0] : null;
          const by = Object.fromEntries(["CHF", "VND"].map((c) => {
            const xs = mine.filter((o) => o.currency === c);
            const revenueMinor = xs.reduce((a, o) => a + toMinor(o.paid || 0, c), 0);
            const cs = s?.by_currency?.[c];
            return [c, { orders: xs.length, completed: xs.filter((o) => DONE.includes(o.fulfillment_status)).length, payments_received: xs.filter((o) => (o.paid || 0) > 0).length,
              revenue: fromMinor(revenueMinor, c), commission_pending: cs?.pending ?? fromMinor(0, c), commission_payable: cs?.payable ?? fromMinor(0, c),
              commission_reversed: cs?.reversed ?? fromMinor(0, c), commission_paid_out: cs?.paid_out ?? fromMinor(0, c), commission_outstanding: cs?.outstanding ?? fromMinor(0, c) }];
          }));
          return { seller_id: sid || "direct", label: sid || "Direktkunde (Chris)", rate_bps: sid ? RATE_BPS[sid] : 0, by_currency: by };
        });
        return reply(200, { sellers, orders: orders.slice(0, 300), totals_by_currency: totalsByCurrency(L, SELLER_IDS), payouts: (L.payouts || []).slice(-100).reverse(),
          rule: `PAYABLE nur bei COMPLETED|COMPLETED_WITH_MANUAL_ITEMS + PAID_FULL · aktueller Satz ${SELLER_COMMISSION_BPS / 100} % (${SELLER_COMMISSION_BPS} bps) für neue Verkäufe, bestehende Einträge behalten ihren Satz · keine automatische Auszahlung`,
          rate_bps: SELLER_COMMISSION_BPS, eligible_from: L.eligible_from });
      }
      if (view === "orders") {
        if (!owner && actor.role !== "SALES_AGENT_VN") return forbidden();
        const leadFilter = url.searchParams.get("lead_id");
        if (leadFilter && !LEAD_RE.test(leadFilter)) return reply(400, { error: "lead_id ungültig." });
        const d = await data();
        const [{ L, snapshot }, doc, scoped] = await Promise.all([ledger(), (async () => (await (await getSalesStore("orders")).get()).state || emptyOrders())(), d.scoped(actor)]);
        const ids = new Set(scoped.filter((l) => leadMarket(l) === "VN").map((l) => l.lead_id));
        const snap = snapshotOrders(snapshot);
        const list = (doc.requests || []).filter((r) => (owner || (ids.has(r.lead_id) && r.seller_id === actor.user_id)) && (!leadFilter || r.lead_id === leadFilter))
          .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, 100).map((r) => orderView(r, snap, L));
        return reply(200, { orders: list, rate_bps: RATE_BPS[VN_SELLER], offers: ["CHECK", "FIX"].map((k) => { const o = offerFor("VN", k); return { offer: k, offer_class: o.offer_class, name: o.name_vi, price: o.price, deposit: o.deposit, currency: o.currency }; }) });
      }
      if (view === "onboarding") {
        // TF-066: jeder angemeldete Benutzer, aber nur im eigenen Bereich (sales-scope über d.scoped) – fremde Kunden nie.
        const leadFilter = url.searchParams.get("lead_id"), filter = url.searchParams.get("filter");
        if (leadFilter && !LEAD_RE.test(leadFilter)) return reply(400, { error: "lead_id ungültig." });
        if (filter && !Object.hasOwn(ONBOARDING_FILTERS, filter)) return reply(400, { error: "Filter ungültig." });
        const d = await data();
        const [snapshot, scoped] = await Promise.all([d.snapshot(), d.scoped(actor)]);
        const byDomain = new Map(scoped.filter((l) => l.domain).map((l) => [normDom(l.domain), l]));
        const all = snapshotOrders(snapshot).filter((o) => o.onboarding && typeof o.onboarding === "object").map((o) => {
          const l = o.domain ? byDomain.get(normDom(o.domain)) : null;
          return { o, l };
        }).filter(({ o, l }) => (owner ? true : !!l && leadMarket(l) === (o.market === "VN" ? "VN" : "CH") && (actor.role !== "SALES_AGENT_VN" || leadMarket(l) === "VN")))
          .filter(({ l }) => !leadFilter || l?.lead_id === leadFilter)
          .map(({ o, l }) => ({ order_id: o.order_id, lead_id: l?.lead_id || null, company: o.company || null, domain: o.domain || null, offer_class: o.offer_class || null,
            market: o.market === "VN" ? "VN" : "CH", state: o.state || null, phase: o.phase || null, onboarding: o.onboarding }));
        const counts = Object.fromEntries(Object.entries(ONBOARDING_FILTERS).map(([k, f]) => [k, all.filter((x) => f(x.onboarding)).length]));
        const list = (filter ? all.filter((x) => ONBOARDING_FILTERS[filter](x.onboarding)) : all).slice(0, 100);
        return reply(200, { orders: list, counts, total: all.length });
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
    let body;
    try { body = JSON.parse((await req.text()).slice(0, 8000) || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Ungültige Anfrage." });
    if (body.op === "order.createConfirmed") return createConfirmed(actor, body);
    if (!owner) return forbidden("Nur der Owner darf Zuweisungen, Provisionen oder Discovery ändern.");
    try {
      if (body.op === "reassign") {
        if (!LEAD_RE.test(String(body.lead_id || ""))) return reply(400, { error: "lead_id ungültig." });
        const d = await data();
        const lead = (await d.leads()).find((l) => l.lead_id === body.lead_id);
        if (!lead) return reply(404, { error: "Unbekannter Lead." });
        if (leadMarket(lead) !== "CH") return reply(400, { error: "Nur Schweizer Leads sind zuweisbar (VN gehört Kudoshin)." });
        await casUpdate("assignments", () => ({ schema: 1, assignments: {}, audit: [] }), (doc) => reassign(doc, { lead_id: body.lead_id, user_id: body.user_id, actor_user_id: actor.user_id, now: now() }));
        return reply(200, { ok: true });
      }
      if (body.op === "commission.setSeller") {
        await ledger();
        const reason = typeof body.reason === "string" ? body.reason.replace(/\s+/g, " ").trim().slice(0, 200) : null;
        await casUpdate("commissions", emptyLedger, (L) => {
          const next = overrideSeller(L, { order_id: body.order_id, seller_id: body.seller_id ?? null, actor_user_id: actor.user_id, now: now() });
          if (reason) next.audit[next.audit.length - 1].reason = reason;
          return next;
        });
        return reply(200, { ok: true });
      }
      // TF-068: Auszahlung NUR markieren (nach tatsächlich erfolgter Überweisung durch Chris) – Jarvis überweist nie.
      if (body.op === "commission.payout") {
        if (Object.keys(body).some((k) => !["op", "seller_id", "amount", "currency", "paid_at", "reference"].includes(k))) return reply(400, { error: "Nur seller_id, amount, currency, paid_at, reference.", code: "BAD_PARAMS" });
        await ledger();
        let payout = null;
        await casUpdate("commissions", emptyLedger, (L) => { const r = recordPayout(L, { ...body, actor_user_id: actor.user_id, now: now() }); payout = r.payout; return r.ledger; });
        return reply(200, { ok: true, payout });
      }
      if (body.op === "vn.pause" || body.op === "vn.resume") {
        await casUpdate("config", () => ({}), (c) => ({ ...c, vn_paused: body.op === "vn.pause", vn_paused_at: now().toISOString(), vn_paused_by: actor.user_id }));
        return reply(200, { ok: true, paused: body.op === "vn.pause" });
      }
    } catch (e) { return reply(e.code ? 409 : 500, { error: e.message, code: e.code || null }); }
    return reply(400, { error: "Unbekannte Operation." });
  };
}
