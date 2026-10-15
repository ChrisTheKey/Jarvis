// Lead-Scope + Lead-Zuweisung (TF-063) – ohne Abhängigkeiten (Netlify Functions, Edge, VPS, Tests). Reine Funktionen.
//
// Markt: lead.market "VN" (Vietnam-Discovery) – alles andere ist "CH" (bestehende Schweizer Discovery).
// Zuständigkeit (sellerOf):
//   VN-Lead                                   → lap
//   CH-Lead mit gesperrter Zuweisung mario    → mario
//   CH-Lead mit gesperrter Zuweisung damiano  → damiano
//   jeder andere CH-Lead (auch neue)          → giuliano
// Sichtbarkeit: OWNER alles; jeder Verkäufer genau die Leads, für die er zuständig ist (Lap nur VN, die anderen nur CH).
// Zuweisungen liegen NICHT in lead_registry.json (Discovery/Dedupe unberührt), sondern im eigenen Blob "jarvis-sales/assignments".

export const MARKETS = Object.freeze(["CH", "VN"]);
export const PORTFOLIO_SELLERS = Object.freeze(["mario", "damiano"]);
export const PORTFOLIO_SIZE = 200;
export const CH_DEFAULT_SELLER = "giuliano";
export const VN_SELLER = "lap";
export const ASSIGNABLE = Object.freeze(["giuliano", "mario", "damiano"]);
export const ASSIGNMENT_SOURCES = Object.freeze(["tf063_fair_distribution", "owner_reassign"]);

export const leadMarket = (l) => (l?.market === "VN" ? "VN" : "CH");
export const emptyAssignments = () => ({ schema: 1, created_at: null, distribution: null, assignments: {}, audit: [] });
const asgOf = (doc) => (doc && typeof doc === "object" && doc.assignments && typeof doc.assignments === "object" ? doc.assignments : {});

export function sellerOf(lead, doc) {
  if (!lead) return null;
  if (leadMarket(lead) === "VN") return VN_SELLER;
  const a = asgOf(doc)[lead.lead_id];
  return a && a.market !== "VN" && ASSIGNABLE.includes(a.assigned_user_id) ? a.assigned_user_id : CH_DEFAULT_SELLER;
}
export function canSeeLead(actor, lead, doc) {
  if (!actor || !lead) return false;
  if (actor.role === "OWNER") return true;
  const m = leadMarket(lead);
  if (actor.role === "SALES_AGENT_VN") return m === "VN" && sellerOf(lead, doc) === actor.user_id;
  if (actor.role === "SALES_MANAGER_CH" || actor.role === "SALES_AGENT_CH") return m === "CH" && sellerOf(lead, doc) === actor.user_id;
  return false;
}
// Serverseitiger Filter – Verkäufer bekommen NUR ihre Leads (kein Ausblenden im Browser). OWNER: + seller-Feld zur Übersicht.
export function scopeLeads(actor, leads = [], doc) {
  const out = [];
  for (const l of Array.isArray(leads) ? leads : []) {
    if (!canSeeLead(actor, l, doc)) continue;
    out.push(actor.role === "OWNER" ? { ...l, market: leadMarket(l), seller: sellerOf(l, doc) } : { ...l, market: leadMarket(l) });
  }
  return out;
}

// ---------- Faire, reproduzierbare Verteilung (Mario/Damiano je 200) ----------
const fnv = (s) => { let h = 0x811c9dc5; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
const CLOSED = new Set(["CUSTOMER", "CLOSED", "NOT_INTERESTED", "DO_NOT_CONTACT"]);
const LEVEL_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };
// Geeignet: offener, aktueller Schweizer Vertriebslead mit brauchbarem Geschäftskontakt – nie DNC/Opt-out/Suppression/Kunde/abgeschlossen.
export function eligibleForPortfolio(l) {
  if (!l || leadMarket(l) !== "CH") return false;
  if (l.do_not_contact || l.dnc_source || l.customer || l.archived) return false;
  if (CLOSED.has(l.sales_stage) || l.call_status === "DO_NOT_CALL" || l.call_status === "NOT_INTERESTED") return false;
  if (l.history_badge === "HISTORICAL") return false; // nur aktuelle Leads (erneut verifizierte historische Funde zählen)
  if (!l.company || !l.domain || !/^[A-Z]{2}$/.test(String(l.canton || ""))) return false; // Firma in der Schweiz (Kanton belegt)
  return !!(l.phone || l.email);
}
const workScore = (l) => (l.phone ? 4 : 0) + (l.email ? 2 : 0) + (l.priority?.score ?? 0) + (l.first_name && l.last_name ? 1 : 0);
// leads: CRM-Sicht. exclude: bereits zugewiesene/gesperrte Lead-IDs. Ergebnis: { mario: [ids], damiano: [ids], candidates, selected }.
export function fairDistribution(leads = [], { size = PORTFOLIO_SIZE, sellers = PORTFOLIO_SELLERS, exclude = new Set() } = {}) {
  const pool = (Array.isArray(leads) ? leads : []).filter((l) => eligibleForPortfolio(l) && !exclude.has(l.lead_id));
  const need = size * sellers.length;
  // 1) Bearbeitbarste Leads zuerst (Telefon, E-Mail, Priorität), deterministischer Tie-Break über Hash der Lead-ID.
  const chosen = [...pool].sort((a, b) => workScore(b) - workScore(a) || fnv(a.lead_id).localeCompare(fnv(b.lead_id)) || a.lead_id.localeCompare(b.lead_id)).slice(0, need);
  // 2) Fairness-Buckets: Priorität → Telefon → E-Mail → Kanton → Branche → Score → Hash; dann Schlangen-Reihenfolge (A B B A …),
  //    damit innerhalb jedes Buckets keiner systematisch den jeweils besseren Lead bekommt.
  const strat = [...chosen].sort((a, b) => (LEVEL_RANK[a.priority?.level] ?? 3) - (LEVEL_RANK[b.priority?.level] ?? 3)
    || (b.phone ? 1 : 0) - (a.phone ? 1 : 0) || (b.email ? 1 : 0) - (a.email ? 1 : 0)
    || String(a.canton).localeCompare(String(b.canton)) || String(a.category || "").localeCompare(String(b.category || ""))
    || (b.priority?.score ?? 0) - (a.priority?.score ?? 0) || fnv(a.lead_id).localeCompare(fnv(b.lead_id)) || a.lead_id.localeCompare(b.lead_id));
  const out = Object.fromEntries(sellers.map((s) => [s, []]));
  const n = sellers.length;
  strat.forEach((l, i) => {
    const round = Math.floor(i / n), pos = i % n;
    const s = sellers[round % 2 === 0 ? pos : n - 1 - pos];
    if (out[s].length < size) out[s].push(l.lead_id);
    else { const other = sellers.find((x) => out[x].length < size); if (other) out[other].push(l.lead_id); }
  });
  return { ...out, candidates: pool.length, selected: chosen.length, complete: chosen.length === need };
}
// Vergleichsbericht (nur Zählwerte/Verteilungen – keine Namen, Domains oder Kontaktdaten).
export function distributionReport(leads = [], doc) {
  const byId = new Map((Array.isArray(leads) ? leads : []).map((l) => [l.lead_id, l]));
  const group = (seller) => Object.entries(asgOf(doc)).filter(([, a]) => a.assigned_user_id === seller).map(([id]) => byId.get(id)).filter(Boolean);
  const stat = (list) => {
    const cnt = (f) => { const m = {}; for (const l of list) { const k = f(l) || "–"; m[k] = (m[k] || 0) + 1; } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))); };
    const avg = list.length ? Math.round((list.reduce((s, l) => s + (l.priority?.score ?? 0), 0) / list.length) * 100) / 100 : 0;
    return { count: list.length, HIGH: list.filter((l) => l.priority?.level === "HIGH").length, MEDIUM: list.filter((l) => l.priority?.level === "MEDIUM").length,
      LOW: list.filter((l) => !["HIGH", "MEDIUM"].includes(l.priority?.level)).length, with_phone: list.filter((l) => l.phone).length, with_email: list.filter((l) => l.email).length,
      avg_priority: avg, cantons: cnt((l) => l.canton), categories: cnt((l) => l.category) };
  };
  const ids = (s) => new Set(Object.entries(asgOf(doc)).filter(([, a]) => a.assigned_user_id === s).map(([id]) => id));
  const m = ids("mario"), d = ids("damiano");
  const ch = (Array.isArray(leads) ? leads : []).filter((l) => leadMarket(l) === "CH");
  return { mario: stat(group("mario")), damiano: stat(group("damiano")), overlap: [...m].filter((x) => d.has(x)).length,
    assigned_total: m.size + d.size, missing_in_view: [...m, ...d].filter((x) => !byId.has(x)).length,
    ch_total: ch.length, giuliano_visible_ch: ch.filter((l) => sellerOf(l, doc) === CH_DEFAULT_SELLER).length,
    giuliano_excluded: ch.filter((l) => PORTFOLIO_SELLERS.includes(sellerOf(l, doc))).length };
}
// Zuweisung anwenden (nur wenn noch keine Portfolio-Zuweisung existiert – nie still neu verteilen). Gibt das neue Dokument zurück.
export function applyDistribution(doc, dist, { now = new Date(), market = "CH" } = {}) {
  const cur = doc && typeof doc === "object" ? structuredClone(doc) : emptyAssignments();
  cur.assignments ||= {}; cur.audit ||= [];
  if (Object.values(cur.assignments).some((a) => PORTFOLIO_SELLERS.includes(a.assigned_user_id))) throw Object.assign(new Error("Portfolio-Zuweisung existiert bereits – keine stille Neuverteilung."), { code: "ALREADY_ASSIGNED" });
  const t = now.toISOString();
  for (const s of PORTFOLIO_SELLERS) for (const id of dist[s] || []) {
    if (cur.assignments[id]) throw Object.assign(new Error("Überschneidung in der Zuweisung."), { code: "OVERLAP" });
    cur.assignments[id] = { lead_id: id, market, assigned_user_id: s, assigned_at: t, assignment_source: "tf063_fair_distribution", locked: true };
  }
  cur.created_at ||= t;
  cur.distribution = { at: t, method: "workability-top-N → strata(level,phone,email,canton,category,score,hash) → snake ABBA", sizes: Object.fromEntries(PORTFOLIO_SELLERS.map((s) => [s, (dist[s] || []).length])) };
  cur.audit.push({ ts: t, actor_user_id: "system:tf063", action: "assignments.init", result: "success", counts: cur.distribution.sizes });
  return cur;
}
// OWNER: bewusste Neuzuweisung eines CH-Leads (auditiert). "giuliano" = zurück in den Standard-Scope.
export function reassign(doc, { lead_id, user_id, actor_user_id, now = new Date() }) {
  if (!ASSIGNABLE.includes(user_id)) throw Object.assign(new Error("Ziel muss giuliano, mario oder damiano sein."), { code: "BAD_USER" });
  const cur = doc && typeof doc === "object" ? structuredClone(doc) : emptyAssignments();
  cur.assignments ||= {}; cur.audit ||= [];
  const prev = cur.assignments[lead_id]?.assigned_user_id || CH_DEFAULT_SELLER;
  const t = now.toISOString();
  if (user_id === CH_DEFAULT_SELLER) delete cur.assignments[lead_id];
  else cur.assignments[lead_id] = { lead_id, market: "CH", assigned_user_id: user_id, assigned_at: t, assignment_source: "owner_reassign", locked: true };
  cur.audit = [...cur.audit, { ts: t, actor_user_id, action: "assignments.reassign", lead_id, from: prev, to: user_id, result: "success" }].slice(-2000);
  return cur;
}
