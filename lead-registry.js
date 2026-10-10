// Jarvis Lead-Datenbank (VPS-authoritative): .secrets/mail_worker/lead_registry.json – dauerhaftes Gedächtnis ALLER qualifizierten,
// angeschriebenen, beantworteten, gesperrten und Kunden-Leads. Leads werden nie gelöscht, Sperren nie automatisch aufgehoben.
// Modell/Statusregeln/Allowlist/CSV: lead-db.js. Hier: Datei, Dedupe, Abgleich mit allen Jarvis-Quellen (= Migration), Kommandozeile.
//
// Die Datenbank ist NIE eine Versandgrundlage. Sie verhindert nur Doppelkontakte: bereits angeschriebene, beantwortete, gesperrte
// oder Kunden-Firmen werden nie wieder als neuer Cold Lead behandelt. Cold-Leads bleiben COLD_LEAD_DRAFT_ONLY (legal_basis NONE).
// Keine Secrets, keine OAuth-Tokens, keine API-Keys, keine technische Roh-Evidence (die bleibt in discovered.json / individual_reviews.json).
//
//   node lead-registry.js --migrate                 alle Quellen zusammenführen (idempotent, verliert nichts)
//   node lead-registry.js --report                  Kennzahlen
//   node lead-registry.js --export csv|json [--out datei] [--canton BE] [--status MANUALLY_SENT] [--category Treuhand]
//                         [--offer REPAIR_FIX_500] [--month 2026-10] [--view contacted|no_reply|replied|customers|blocked] [--q text]
//   node lead-registry.js --dnc <lead_id|domain|email>   dauerhaft „nicht kontaktieren“ (wird nie automatisch zurückgenommen)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeLead, buildIndex, findId, matchingLeads, contactBlockReason, publicLead, leadStats, filterLeads, leadsToCsv, FILTER_KEYS,
  normEmail, normDomain, emailDomain, isFreemail } from "./lead-db.js";
import { REVIEWS_FILE, customerFindings, qualifyRepairLead } from "./swiss-repair.js";
import { findMunicipality, categoryLabel } from "./swiss-areas.js";

export const REGISTRY_FILE = "lead_registry.json";
export const REGISTRY_SCHEMA = 1;
// Discovery-Ergebnisse, die in die Datenbank gehören (qualifiziert bzw. bereits in Chris’ Liste); alles andere bleibt im Audit-Index.
export const TRACKED_DISCOVERY = new Set(["blocked_no_legal_basis", "matched_existing_lead", "already_in_lead_list"]);
const REVIEW_TO_DRAFT = { queued: "queued", draft_created: "draft_created", manually_sent: "manually_sent", sent: "manually_sent", discarded: "discarded", blocked: "blocked" };

export function loadRegistry(store) {
  const r = store.read(REGISTRY_FILE, null);
  if (r && r.schema > REGISTRY_SCHEMA) throw new Error(`lead_registry.json hat Schema ${r.schema}, dieser Code kennt nur ${REGISTRY_SCHEMA} – fail closed.`);
  return { schema: REGISTRY_SCHEMA, created_at: null, leads: {}, meta: {}, ...(r || {}) };
}
export const saveRegistry = (store, reg) => store.write(REGISTRY_FILE, reg, { compact: true });

// Upsert über den Dedupe-Index: gleiche Domain / Adresse / Firma = derselbe Lead (kein neuer Datensatz, keine Information verloren).
export function createUpserter(reg, now = new Date()) {
  reg.created_at ||= now.toISOString();
  const idx = buildIndex(reg.leads);
  idx.ids = new Set(Object.keys(reg.leads));
  let created = 0, updated = 0;
  const put = (inc, { source = null, authoritative = [], create = true } = {}) => {
    const id = findId(idx, { lead_id: inc.lead_id, domain: inc.domain, email: inc.business_email, company: inc.company });
    if (!id && !create) return null;
    const leadId = id || String(inc.lead_id || inc.domain || normEmail(inc.business_email || "")).toLowerCase();
    if (!leadId) return null;
    const before = reg.leads[leadId];
    const next = mergeLead(before, { ...inc, lead_id: leadId }, { now, source, authoritative });
    if (!before) { created++; idx.ids.add(leadId); }
    else if (next.last_updated_at !== before.last_updated_at) updated++;
    reg.leads[leadId] = next;
    // Index nachführen (neue Domain/Adresse/Firma sofort für die nächsten Einträge bekannt)
    for (const d of [next.domain, ...(next.alt_domains || [])].filter(Boolean)) if (!idx.byDomain.has(d)) idx.byDomain.set(d, leadId);
    for (const e of [next.business_email, ...(next.alt_emails || [])].filter(Boolean)) { if (!idx.byEmail.has(e)) idx.byEmail.set(e, leadId); if (!isFreemail(e) && !idx.byDomain.has(emailDomain(e))) idx.byDomain.set(emailDomain(e), leadId); }
    return next;
  };
  return { put, stats: () => ({ created, updated, total: Object.keys(reg.leads).length }) };
}

// Ein Lead (z. B. aus der Discovery) direkt festhalten: frisch lesen → zusammenführen → schreiben, ohne await dazwischen (kein Lost Update).
export function recordLead(store, inc, { now = new Date(), source = null, authoritative = [] } = {}) {
  const reg = loadRegistry(store);
  const lead = createUpserter(reg, now).put(inc, { source, authoritative });
  saveRegistry(store, reg);
  return lead;
}

// Dedupe-Wissen für die Discovery: alle bekannten Domains / Adressen / Firmen (werden nie erneut als neuer Lead geprüft).
export function knownKeys(store) {
  const reg = loadRegistry(store);
  const idx = buildIndex(reg.leads);
  return { domains: [...idx.byDomain.keys()], emails: [...idx.byEmail.keys()], companies: [...idx.byCompany.keys()], total: Object.keys(reg.leads).length };
}

// Darf für diese Firma ein NEUER Cold-Entwurf entstehen? Grund (blockiert) oder null. Prüft jeden Datensatz derselben Firma
// (Domain, Adresse, Firmenname): angeschrieben, Antwort, Kunde, kein Interesse, Suppression, Opt-out, Do-not-contact.
export function registryBlock(store, q = {}, reg = loadRegistry(store)) {
  for (const l of matchingLeads(reg.leads, q)) { const why = contactBlockReason(l); if (why) return why; }
  return null;
}

// Herkunft „OpenStreetMap node/1 (Köniz, office=accountant)“ → Gemeinde/Kanton/Branche (für Leads ohne gespeicherte Gebietsangabe).
export function geoFromSource(src = "") {
  const m = String(src).match(/\(([^,()]+(?:\([A-Z]{2}\))?)\s*,\s*([a-z_]+(?:=[a-z_]+)?)\)\s*$/i);
  if (!m) return {};
  const muni = findMunicipality(m[1]);
  return { ...(muni ? { canton: muni.canton, municipality: muni.name, municipality_bfs: muni.bfs, language: muni.language } : {}), category: m[2], category_label: categoryLabel(m[2]) };
}
const keyOf = (l = {}) => l.domain || (l.website ? normDomain(l.website) : "") || (normEmail(l.email || "") && !isFreemail(l.email) ? emailDomain(l.email) : normEmail(l.email || ""));

const offerOf = (l) => { try { return qualifyRepairLead(l).offer?.offer_class || null; } catch { return null; } };
// Discovery-Lead (lead-finder.js) → Datenbank-Eintrag (nur kundentaugliche Befunde, keine Roh-Evidence).
export function fromDiscovered(l = {}, extra = {}) {
  const findings = customerFindings(l.websiteIssues || []).map((f) => f.text).filter(Boolean);
  const geo = l.canton ? {} : geoFromSource(l.discoverySource);
  return {
    lead_id: keyOf(l), company: l.company || null, domain: l.domain || keyOf(l), website: l.website || null,
    business_email: l.business_email || l.email || null, contact_name: l.contact_name || l.name || null, contact_role: l.contact_role || null,
    canton: l.canton || null, municipality: l.municipality || null, municipality_bfs: l.municipality_bfs || null, language: l.language || null,
    category: l.category || null, category_label: l.category ? categoryLabel(l.category) : null, ...geo,
    discovery_source: l.discoverySource || null, first_discovered_at: l.discoveredAt || null, last_audited_at: l.auditedAt || null,
    customer_visible_findings: findings, repair_fit_score: Number.isFinite(l.repair_fit_score) ? l.repair_fit_score : null,
    offer_class: l.repair_offer_class || offerOf(l), audited: !!l.auditedAt, qualified: TRACKED_DISCOVERY.has(l.status),
    suppressed: l.status === "suppressed", draft_blocked_reason: l.draft_blocked_reason || null, ...extra,
  };
}

// Signatur der Quellen (Grösse + Änderungszeit): unverändert → kein Abgleich nötig (der Worker ruft alle 2 Minuten).
function sourceSig(store, files, gmailRegistry) {
  const parts = files.map((f) => { try { const s = fs.statSync(path.join(store.dir, f)); return `${f}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { return `${f}:-`; } });
  const sent = Object.values(gmailRegistry?.sent || {});
  parts.push(`gmail:${sent.length}:${Object.keys(gmailRegistry?.drafts || {}).length}:${sent.map((s) => s.sentAt || "").sort().at(-1) || ""}`);
  return parts.join("|");
}

// Abgleich ALLER Quellen = Migration (idempotent, additiv, nie löschend):
//   leads.json (Chris’ Liste) · discovered.json (nur full) · individual_reviews.json (Entwürfe, manueller Versand) · Gmail-/Jarvis-Register (gesendet)
//   · state.json (Antworten) · sales.json (Kunde/kein Interesse/Antwort) · suppression.json (Sperre/Opt-out, auch Domain).
// Ergebnis: { skipped } oder { created, updated, total }.
export function reconcileRegistry(store, { gmailRegistry = { sent: {}, drafts: {} }, now = new Date(), full = false, force = false } = {}) {
  const files = ["leads.json", REVIEWS_FILE, "state.json", "sales.json", "suppression.json", "config.json", ...(full ? ["discovered.json"] : [])];
  const reg = loadRegistry(store);
  const sig = sourceSig(store, files, gmailRegistry);
  if (!force && !full && reg.meta?.sig === sig && fs.existsSync(path.join(store.dir, REGISTRY_FILE))) return { skipped: "unchanged", total: Object.keys(reg.leads).length };
  const up = createUpserter(reg, now);
  const cfg = store.read("config.json", {});
  // Eigene Adressen von Chris (inkl. Plus-Aliasse) sind nie ein Lead.
  const own = new Set([...(cfg.excludeAddresses || []), cfg.sender?.email].filter(Boolean).map((a) => normEmail(a).replace(/\+[^@]*@/, "@")));
  const isOwn = (a) => own.has(normEmail(a).replace(/\+[^@]*@/, "@"));
  const listed = store.read("leads.json", []);
  const discovered = full ? Object.values(store.read("discovered.json", { leads: {} }).leads || {}) : [];
  const companyFor = (email) => {
    const e = normEmail(email), d = emailDomain(e);
    return (Array.isArray(listed) ? listed : []).find((l) => normEmail(l?.email) === e)?.company || discovered.find((l) => l.domain === d)?.company || null;
  };

  // 1) Chris’ Lead-Liste
  for (const l of Array.isArray(listed) ? listed : []) {
    if (!l || !(l.email || l.website) || isOwn(l.email || "")) continue;
    up.put({ lead_id: keyOf(l), company: l.company || null, domain: keyOf(l).includes("@") ? null : keyOf(l), website: l.website || null, business_email: l.email || null,
      contact_name: l.name || null, discovery_source: "leads.json", first_discovered_at: l.addedAt || l.createdAt || l.discoveredAt || null, last_audited_at: l.auditedAt || null,
      audited: Array.isArray(l.websiteIssues) && l.websiteIssues.length > 0, do_not_contact: l.status === "do_not_contact" || l.doNotContact === true, ...geoFromSource(l.discoverySource) }, { source: "leads.json" });
  }
  // 2) Discovery (nur bei Migration/Start: discovered.json ist gross; laufend schreibt lead-finder.js selbst)
  for (const l of discovered) if (TRACKED_DISCOVERY.has(l.status) || (l.status === "suppressed" && l.email)) up.put(fromDiscovered(l), { source: "discovery" });
  // 3) Cold-Entwürfe (verbindlich für den Entwurfsstatus) inkl. manuell versendeter
  for (const r of Object.values(store.read(REVIEWS_FILE, { reviews: {} }).reviews || {})) {
    if (!r?.lead_id || isOwn(r.recipient || "")) continue;
    const sent = r.status === "manually_sent" || r.status === "sent" || r.manual_send_detected === true;
    up.put({ lead_id: r.lead_id, company: r.company || null, domain: r.domain || null, business_email: r.recipient || r.business_email || null,
      contact_name: r.contact_name || null, contact_role: r.contact_role || null, offer_class: r.offer_class || null, repair_fit_score: Number.isFinite(r.repair_fit_score) ? r.repair_fit_score : null,
      customer_visible_findings: (r.customer_findings || []).map((f) => f?.text).filter(Boolean), qualified: true, audited: true, first_discovered_at: r.created_at || null,
      gmail_draft_status: REVIEW_TO_DRAFT[r.status] || "none", draft_created_at: r.draft_created_at || null, manual_send_detected: sent,
      first_contacted_at: sent ? r.manual_send_at || r.updated_at || null : null, draft_blocked_reason: r.status === "blocked" ? r.blocked_reason || null : null,
      refs: { gmail_thread_id: r.thread_id || null, gmail_message_id: r.gmail_message_id || null } }, { source: "individual_reviews", authoritative: ["gmail_draft_status"] });
  }
  // 4) Gmail-/Jarvis-Register: jede gesendete Jarvis-Mail und jeder manuell versendete Cold-Entwurf = Kontakt (nie vergessen)
  for (const s of Object.values(gmailRegistry?.sent || {})) {
    const to = normEmail(s?.to || "");
    if (!to || isOwn(to) || !s.sentAt) continue;
    up.put({ lead_id: s.leadId || (isFreemail(to) ? to : emailDomain(to)), domain: s.leadId && !s.leadId.includes("@") ? s.leadId : isFreemail(to) ? null : emailDomain(to),
      business_email: to, company: companyFor(to), first_contacted_at: s.sentAt, last_contacted_at: s.sentAt, manual_send_detected: s.manual === true,
      discovery_source: "gmail", refs: s.manual ? { gmail_thread_id: s.threadId || null, gmail_message_id: s.messageId || null } : undefined }, { source: "gmail_registry" });
  }
  // 5) Antworten in Jarvis-Threads (Worker-Zustand) – nur zu bekannten Leads
  for (const [k, a] of Object.entries(store.read("state.json", { actions: {} }).actions || {})) {
    if (!k.startsWith("reply:") || !a?.to || isOwn(a.to)) continue;
    up.put({ business_email: a.to, reply_status: "replied", reply_at: a.at || null }, { source: "replies", create: false });
  }
  // 6) Vertrieb: Kunde / kein Interesse / Antwort (sales.json)
  for (const [domain, rec] of Object.entries(store.read("sales.json", { records: {} }).records || {})) {
    if (!rec) continue;
    const customer = !!rec.sale?.selected_offer;
    up.put({ lead_id: domain, domain: domain.includes("@") ? null : domain, customer_status: customer ? "customer" : rec.status === "not_interested" ? "not_interested" : "none",
      reply_status: rec.status === "replied" || customer ? "replied" : undefined, reply_at: rec.status === "replied" ? rec.statusAt || null : undefined,
      offer_class: customer ? rec.sale.selected_offer : undefined }, { source: "sales" });
  }
  // 7) Suppression / Opt-out (Adresse und Firmen-Domain) – haben immer Vorrang
  for (const [addr, s] of Object.entries(store.read("suppression.json", {}))) {
    const a = normEmail(addr), optOut = /opt-?out/i.test(s?.reason || "");
    up.put({ business_email: a, suppressed: true, opt_out: optOut }, { source: "suppression", create: false });
    if (!isFreemail(a)) for (const l of Object.values(reg.leads)) if (l.domain === emailDomain(a) && !l.suppressed) up.put({ lead_id: l.lead_id, suppressed: true }, { source: "suppression" });
  }
  reg.meta = { ...(reg.meta || {}), sig: sourceSig(store, files, gmailRegistry), reconciled_at: now.toISOString(), ...(full ? { migrated_at: now.toISOString() } : {}) };
  saveRegistry(store, reg);
  return up.stats();
}

// Öffentliche Sicht (Allowlist) – Grundlage für Cloud, Handy und Export.
// Gecacht nach Grösse + Änderungszeit der Datei: der Server-Control-Agent fragt alle 5–60 s, die Datei wird nur bei Änderung neu gelesen.
let viewCache = { key: null, list: null, meta: null };
function publicView(store) {
  let key = null;
  try { const s = fs.statSync(path.join(store.dir, REGISTRY_FILE)); key = `${store.dir}|${s.size}|${s.mtimeMs}`; } catch {}
  if (!key || key !== viewCache.key) {
    const reg = loadRegistry(store);
    const list = Object.values(reg.leads).map(publicLead).filter(Boolean).sort((a, b) => String(b.last_updated_at || "").localeCompare(String(a.last_updated_at || "")));
    viewCache = { key, list, meta: reg.meta || {} };
  }
  return viewCache;
}
export const publicRegistry = (store) => publicView(store).list;
export function registryStatus(store, now = new Date()) {
  const v = publicView(store);
  return { status: "ACTIVE", ...leadStats(v.list, now), reconciled_at: v.meta?.reconciled_at || null, migrated_at: v.meta?.migrated_at || null };
}
// Dauerhaft „nicht kontaktieren“ – nur Chris (Kommandozeile). Wird nie automatisch zurückgenommen.
export function markDoNotContact(store, key, { now = new Date() } = {}) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) throw new Error("lead_id, Domain oder Adresse angeben.");
  const reg = loadRegistry(store);
  const up = createUpserter(reg, now);
  const hit = matchingLeads(reg.leads, { lead_id: k, domain: k.includes("@") ? null : k, email: k.includes("@") ? k : null });
  const lead = hit.length ? up.put({ lead_id: hit[0].lead_id, do_not_contact: true }, { source: "chris_dnc" })
    : up.put({ lead_id: k, domain: k.includes("@") ? null : k, business_email: k.includes("@") ? k : null, do_not_contact: true }, { source: "chris_dnc" });
  saveRegistry(store, reg);
  return lead;
}

// ---------- Kommandozeile ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
  const run = async () => {
    const { createStore, WORKER_DIR } = await import("./mail-worker.js");
    const store = createStore(WORKER_DIR);
    const gmailRegistry = await import("./gmail.js").then((g) => g.listOwned(), () => ({ sent: {}, drafts: {} }));
    if (args.includes("--migrate")) { console.log(JSON.stringify(reconcileRegistry(store, { gmailRegistry, full: true }), null, 2)); return 0; }
    if (args.includes("--report")) { console.log(JSON.stringify(registryStatus(store), null, 2)); return 0; }
    if (args.includes("--dnc")) { const l = markDoNotContact(store, opt("dnc")); console.log(`do_not_contact gesetzt: ${l.lead_id} (Status ${l.status})`); return 0; }
    if (args.includes("--export")) {
      const fmt = opt("export") === "json" ? "json" : "csv";
      const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, opt(k)]).filter(([, v]) => v));
      const list = filterLeads(publicRegistry(store), filters);
      const text = fmt === "csv" ? leadsToCsv(list) : JSON.stringify({ exported_at: new Date().toISOString(), filters, count: list.length, leads: list }, null, 2);
      if (opt("out")) { fs.writeFileSync(opt("out"), text, { mode: 0o600 }); console.log(`${list.length} Leads → ${opt("out")}`); } else process.stdout.write(text);
      return 0;
    }
    console.log("Befehle: --migrate | --report | --export csv|json [--out datei] [Filter] | --dnc <lead_id|domain|email>");
    return 1;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
