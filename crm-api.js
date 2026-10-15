// /api/crm – Jarvis Lead-CRM in der Cloud (TF-053, Multi-User TF-063). Gleiches Muster wie /api/server-control: der Browser schreibt NIE
// direkt auf den VPS, sondern legt einen geprüften Auftrag (nur crm.*-Allowlist, genau ein Lead) in eine Warteschlange; der zuständige
// Dienst auf dem VPS holt ihn ausgehend ab, prüft erneut, speichert atomar und meldet das Ergebnis. Lesen kommt aus der zuletzt gemeldeten Sicht.
//
//   Browser:      Session-Cookie (auth-core.js resolveActor) – Legacy x-jarvis-key = JARVIS_PASSWORD nur für Chris (OWNER)
//   CH-Dienst:    x-jarvis-crm = HMAC-SHA256(JARVIS_SERVER_CONTROL_TOKEN, "jarvis-crm-agent-v1")
//   VN-Dienst:    x-jarvis-vn  = HMAC-SHA256(JARVIS_SERVER_CONTROL_TOKEN, "jarvis-vn-agent-v1") – eigener Schlüssel, nur VN-Sicht/-Queue
//
// TF-063 Scope (serverseitig, sales-scope.js): OWNER alle Leads (CH + VN); Giuliano CH ohne Mario-/Damiano-Portfolio; Mario/Damiano nur
// ihr Portfolio; Lap nur VN. Liste, Detail, Auftragsstatus, CSV und JEDE Schreibaktion werden gegen diesen Scope geprüft – ausserhalb → 403.
// Keine Shell, keine Pfade, keine Dateien vom Client, kein Senden, kein Anruf. Unbekannte Aktionen → 400.
import crypto from "node:crypto";
import { safeEqual } from "./shared-state.js";
import { validateCrmAction, cleanCrmLead, CRM_ACTIONS, LEAD_ID_RE } from "./lead-crm.js";
import { crmToCsv, filterLeads, sortLeads, crmStats, FILTER_KEYS } from "./public/crm-model.js";
import { verifyBackup, BACKUP_FORMAT } from "./backup.js";
import { resolveActor, can, isOwner, deny, forbidden } from "./auth-core.js";
import { scopeLeads, canSeeLead, leadMarket, fairDistribution, applyDistribution, distributionReport, emptyAssignments } from "./sales-scope.js";
import { csvLabelsFor } from "./public/i18n.js";

export const REQUEST_TTL_MS = 3 * 60_000;
export const LEASE_MS = 2 * 60_000;
export const WATCH_MS = 90_000;
export const AGENT_STALE_MS = 3 * 60_000;
export const RATE = { windowMs: 10 * 60_000, writes: 120 };
export const MAX_VIEW_LEADS = 20_000;
export const MAX_AGENT_BYTES = 6_000_000;
export const MAX_USER_BYTES = 32_000;
const AUDIT_KEEP = 500, REQUEST_KEEP = 100, BACKUP_KEEP = 30;
const ID_RE = /^[0-9a-f-]{36}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const iso = (v) => (typeof v === "string" && ISO_RE.test(v) ? v : null);
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const agentKey = (controlToken, label) => { const t = String(controlToken || "").trim(); return t.length >= 32 ? crypto.createHmac("sha256", t).update(label).digest("hex") : ""; };
export const crmAgentToken = (controlToken) => agentKey(controlToken, "jarvis-crm-agent-v1");
export const vnAgentToken = (controlToken) => agentKey(controlToken, "jarvis-vn-agent-v1");

const publicRequest = (r) => ({ request_id: r.request_id, action: r.action, lead_id: r.params?.lead_id || null, status: r.status, created_at: r.created_at,
  finished_at: r.finished_at || null, error: r.error || null, code: r.code || null, actor_user_id: r.actor_user_id || null });
const auditEntry = (t, x) => ({ ts: t.toISOString(), request_id: x.request_id || null, actor_user_id: x.actor_user_id || null,
  action: typeof x.action === "string" && Object.hasOwn(CRM_ACTIONS, x.action) ? x.action : "invalid",
  lead_id: typeof x.lead_id === "string" && LEAD_ID_RE.test(x.lead_id) ? x.lead_id : null, outcome: x.outcome, code: x.code || null });
function expire(requests, t) {
  return requests.map((r) => r.status === "pending" && +t > Date.parse(r.expires_at) ? { ...r, status: "expired", finished_at: t.toISOString(), error: "VPS hat den Auftrag nicht abgeholt – nicht gespeichert." }
    : r.status === "running" && +t > Date.parse(r.lease_until) ? { ...r, status: "failed", finished_at: t.toISOString(), error: "Kein Ergebnis vom VPS – Stand bitte prüfen." } : r);
}
// Filter aus der URL (Export): nur bekannte Schlüssel, kurze Werte.
export function crmFilters(params) {
  const f = {};
  for (const k of FILTER_KEYS) { const v = params.get(k); if (typeof v === "string" && v.trim() && v.length <= 80) f[k] = v.trim(); }
  return f;
}
// VN-Sicht: Allowlist + Markt erzwingen; Domains, die schon als Schweizer CRM-Lead existieren, nie doppelt (globale Domain-Dedupe).
export function cleanVnLeads(list, chLeads = []) {
  const chDomains = new Set((chLeads || []).map((l) => l?.domain).filter(Boolean));
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const l = cleanCrmLead({ ...raw, market: "VN" });
    if (!l || l.market !== "VN" || (l.domain && (chDomains.has(l.domain) || seen.has(l.domain)))) continue;
    if (l.domain) seen.add(l.domain);
    out.push(l);
  }
  return out;
}

export function createCrmHandler({ getQueueStore, getViewStore, getVnViewStore = null, getVnQueueStore = null, getSalesStore = null, getAuthStore = null,
  getBackupStore = null, env, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  async function mutateOn(getStore, fn) {
    const store = await getStore();
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const t = now();
      const cur = { requests: [], audit: [], rate: [], agent_seen_at: null, watch_at: null, ...(state || {}) };
      const before = new Set(cur.requests.filter((r) => ["pending", "running"].includes(r.status)).map((r) => r.request_id));
      cur.requests = expire(cur.requests, t);
      let expired = 0;
      for (const r of cur.requests) if (before.has(r.request_id) && ["expired", "failed"].includes(r.status)) { expired++; cur.audit.push(auditEntry(t, { ...r, lead_id: r.params?.lead_id, outcome: r.status })); }
      const res = await fn(cur, t);
      cur.requests = cur.requests.slice(-REQUEST_KEEP);
      cur.audit = cur.audit.slice(-AUDIT_KEEP);
      cur.rate = cur.rate.filter((x) => +t - Date.parse(x.at) < RATE.windowMs);
      if (res.readOnly && !expired) return res;
      if (await store.set(cur, etag)) return res;
    }
    return { status: 409, body: { error: "Gleichzeitige Änderung – bitte erneut versuchen." } };
  }
  const mutate = (fn) => mutateOn(getQueueStore, fn);
  const mutateVn = (fn) => (getVnQueueStore ? mutateOn(getVnQueueStore, fn) : Promise.resolve({ status: 503, body: { error: "VN-CRM nicht konfiguriert." } }));
  async function patchStore(getStore, fn) {
    const store = await getStore();
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const next = fn(state);
      if (!next) return true;
      if (await store.set(next, etag)) return true;
    }
    return false;
  }
  const patchView = (fn) => patchStore(getViewStore, fn);
  const online = (cur, t) => !!cur.agent_seen_at && +t - Date.parse(cur.agent_seen_at) < AGENT_STALE_MS;
  const readView = async () => (await (await getViewStore()).get()).state;
  const readVnView = async () => (getVnViewStore ? (await (await getVnViewStore()).get()).state : null);
  const readAssignments = async () => (getSalesStore ? (await (await getSalesStore("assignments")).get()).state : null) || emptyAssignments();
  const readSalesConfig = async () => (getSalesStore ? (await (await getSalesStore("config")).get()).state : null) || {};
  const chLeadsOf = (v) => (v?.leads || []).map((l) => ({ ...l, market: "CH" }));
  async function allLeads() {
    const [v, vn] = await Promise.all([readView(), readVnView()]);
    return { v, vn, leads: [...chLeadsOf(v), ...(vn?.leads || [])] };
  }
  // Agent-Pull/Result für eine Warteschlange (CH- oder VN-Dienst).
  async function agentPull(mut, body, storeView) {
    let stored = null;
    if (body.view !== undefined) {
      const v = body.view;
      if (!v || typeof v !== "object" || !Array.isArray(v.leads) || v.leads.length > MAX_VIEW_LEADS) return reply(400, { error: "view ungültig." });
      stored = await storeView(v);
      if (stored === false) return reply(409, { error: "Gleichzeitige Änderung – bitte erneut versuchen." });
    }
    const r = await mut((cur, t) => {
      cur.agent_seen_at = t.toISOString();
      const due = cur.requests.filter((x) => x.status === "pending");
      for (const x of due) { x.status = "running"; x.claimed_at = t.toISOString(); x.lease_until = new Date(+t + LEASE_MS).toISOString(); }
      const hot = due.length > 0 || (!!cur.watch_at && +t - Date.parse(cur.watch_at) < WATCH_MS) || cur.requests.some((x) => x.status === "running");
      return { status: 200, body: { requests: due.map((x) => ({ request_id: x.request_id, action: x.action, params: x.params, created_at: x.created_at })), hot, stored } };
    });
    return r;
  }
  async function agentResult(mut, body, patch) {
    if (typeof body.request_id !== "string" || !ID_RE.test(body.request_id)) return reply(400, { error: "request_id ungültig." });
    let leadId = null;
    const r = await mut((cur, t) => {
      const x = cur.requests.find((q) => q.request_id === body.request_id);
      if (!x) return { status: 404, body: { error: "Unbekannter Auftrag." } };
      if (x.status !== "running") return { status: 409, body: { error: `Auftrag ist ${x.status}.` } };
      x.status = body.ok === true ? "done" : "failed";
      x.finished_at = t.toISOString();
      x.code = body.ok === true ? null : typeof body.code === "string" && /^[A-Z_]{2,30}$/.test(body.code) ? body.code : "FAILED";
      x.error = body.ok === true ? null : String(body.error || "Fehlgeschlagen").replace(/[^\p{L}\p{N} .,:;()–\/'’-]/gu, "").slice(0, 200);
      leadId = x.params?.lead_id || null;
      cur.audit.push(auditEntry(t, { ...x, lead_id: leadId, outcome: body.ok === true ? "success" : "failure" }));
      return { status: 200, body: { ok: true } };
    });
    // Geänderten Lead sofort in die Sicht übernehmen (die vollständige Sicht folgt mit dem nächsten Abholen).
    const lead = body.ok === true ? cleanCrmLead(body.lead) : null;
    if (r.status === 200 && lead && lead.lead_id === leadId) await patch(lead);
    return reply(r.status, r.body);
  }
  const patchLeadIn = (getStore, market) => (lead) => patchStore(getStore, (v) => { if (!v || !Array.isArray(v.leads)) return null; const i = v.leads.findIndex((l) => l.lead_id === lead.lead_id); if (i < 0) return null; v.leads[i] = { ...lead, market }; return v; });

  return async (req) => {
    const url = new URL(req.url);
    const control = env("JARVIS_SERVER_CONTROL_TOKEN");
    const agentToken = crmAgentToken(control), vnToken = vnAgentToken(control), password = env("JARVIS_PASSWORD");
    if (req.method === "GET" && url.searchParams.has("probe")) return reply(200, { configured: !!agentToken && (!!password || !!getAuthStore) });
    const isAgent = !!agentToken && safeEqual(req.headers.get("x-jarvis-crm"), agentToken);
    const isVn = !!vnToken && safeEqual(req.headers.get("x-jarvis-vn"), vnToken);
    let actor = null;
    if (!isAgent && !isVn) {
      const r = await resolveActor(req, { env, getAuthStore, now });
      if (!r.actor) return deny(r);
      actor = r.actor;
      if (!can(actor, "crm.read")) return forbidden();
    }
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    const limit = actor ? MAX_USER_BYTES : MAX_AGENT_BYTES;
    if (Number(req.headers.get("content-length") || 0) > limit) return reply(413, { error: "Zu gross." });
    let body = {};
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > limit) return reply(413, { error: "Zu gross." });
      try { body = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Ungültige Anfrage." });
    }

    // ----- VN-Discovery-Dienst auf dem VPS (nur VN-Sicht + VN-Queue) -----
    if (isVn) {
      if (req.method !== "POST") return reply(405, { error: "Agent: nur POST." });
      if (!getVnViewStore || !getVnQueueStore) return reply(503, { error: "VN-CRM nicht konfiguriert." });
      if (body.op === "vn_pull") {
        const ch = await readView();
        const r = await agentPull(mutateVn, body, async (v) => {
          const leads = cleanVnLeads(v.leads, ch?.leads);
          const t = now();
          const st = v.status && typeof v.status === "object" ? v.status : null;
          const ok = await patchStore(getVnViewStore, () => ({ leads, total: leads.length, generated_at: iso(v.generated_at) || t.toISOString(), received_at: t.toISOString(),
            status: st ? { audited_today: Number.isInteger(st.audited_today) ? st.audited_today : 0, daily_limit: Number.isInteger(st.daily_limit) ? st.daily_limit : 0,
              day: typeof st.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(st.day) ? st.day : null, units_total: Number.isInteger(st.units_total) ? st.units_total : 0,
              cursor_unit: typeof st.cursor_unit === "string" ? st.cursor_unit.slice(0, 60) : null, cycle: Number.isInteger(st.cycle) ? st.cycle : 0,
              indexed_domains: Number.isInteger(st.indexed_domains) ? st.indexed_domains : 0, last_audit_at: iso(st.last_audit_at), paused: st.paused === true } : null }));
          return ok ? leads.length : false;
        });
        if (r instanceof Response) return r;
        const cfg = await readSalesConfig();
        return reply(r.status, { ...r.body, paused: cfg.vn_paused === true });
      }
      if (body.op === "vn_result") return agentResult(mutateVn, body, patchLeadIn(getVnViewStore, "VN"));
      return reply(400, { error: "Unbekannte Operation." });
    }

    // ----- CRM-Dienst (CH) auf dem VPS -----
    if (isAgent) {
      if (req.method !== "POST") return reply(405, { error: "Agent: nur POST." });
      if (body.op === "pull") {
        const r = await agentPull(mutate, body, async (v) => {
          const leads = v.leads.map((l) => cleanCrmLead({ ...l, market: "CH" })).filter(Boolean);
          const t = now();
          const b = v.backup && typeof v.backup === "object" ? { last_at: iso(v.backup.last_at), offsite_ok: v.backup.offsite_ok === true, generations: Number.isInteger(v.backup.generations) ? Math.min(v.backup.generations, 1000) : 0 } : null;
          const ok = await patchView(() => ({ leads, total: leads.length, generated_at: iso(v.generated_at) || t.toISOString(), received_at: t.toISOString(), backup: b }));
          return ok ? leads.length : false;
        });
        if (r instanceof Response) return r;
        return reply(r.status, r.body);
      }
      if (body.op === "result") return agentResult(mutate, body, patchLeadIn(getViewStore, "CH"));
      if (body.op === "assign_init") {
        // TF-063: einmalige, faire Portfolio-Verteilung (Mario/Damiano je 200) aus der aktuellen CRM-Sicht. dry_run → nur Zählwerte.
        // Schreibt nur, wenn noch KEINE Portfolio-Zuweisung existiert (nie still neu verteilen). Antwort ohne personenbezogene Daten.
        if (!getSalesStore) return reply(503, { error: "Sales-Speicher nicht konfiguriert." });
        const v = await readView();
        const leads = chLeadsOf(v);
        const store = await getSalesStore("assignments");
        const { state, etag } = await store.get();
        const cur = state || emptyAssignments();
        const dist = fairDistribution(leads);
        let doc;
        try { doc = applyDistribution(cur, dist, { now: now() }); }
        catch (e) { return reply(409, { error: e.message, code: e.code || "CONFLICT", report: distributionReport(leads, cur) }); }
        if (!dist.complete) return reply(409, { error: "Zu wenige geeignete Leads für 2 × 200.", code: "NOT_ENOUGH", candidates: dist.candidates, selected: dist.selected });
        const report = { candidates: dist.candidates, selected: dist.selected, ...distributionReport(leads, doc) };
        if (body.dry_run !== false) return reply(200, { dry_run: true, report });
        if (!(await store.set(doc, etag))) return reply(409, { error: "Gleichzeitige Änderung – nichts gespeichert." });
        return reply(200, { dry_run: false, stored: true, report });
      }
      if (body.op === "backup") {
        // Nur verschlüsselte Backups im bekannten Format (wie /api/backup) – nie Klartext. Ablage crm/<Tag>, 30 Generationen.
        if (!getBackupStore) return reply(503, { error: "Backup-Speicher nicht konfiguriert." });
        const bak = body.backup;
        const v = verifyBackup(bak);
        if (bak?.format !== BACKUP_FORMAT || !v.ok || typeof bak.wrapped_key !== "string") return reply(400, { error: `Kein gültiges verschlüsseltes Backup: ${v.error || "Format"}` });
        const key = `crm/${String(bak.created_at).slice(0, 10)}`;
        if (!/^crm\/\d{4}-\d{2}-\d{2}$/.test(key)) return reply(400, { error: "created_at fehlt." });
        const store = await getBackupStore();
        await store.set(key, JSON.stringify(bak));
        const { blobs } = await store.list({ prefix: "crm/" });
        const all = blobs.map((b) => b.key).filter((k) => /^crm\/\d{4}-\d{2}-\d{2}$/.test(k)).sort();
        for (const old of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) await store.delete(old);
        return reply(200, { ok: true, key, generations: Math.min(all.length, BACKUP_KEEP) });
      }
      return reply(400, { error: "Unbekannte Operation." });
    }

    // ----- Benutzer im Browser (scoped) -----
    const owner = isOwner(actor);
    const asg = await readAssignments();
    const { v, vn, leads: everything } = await allLeads();
    const leads = scopeLeads(actor, everything, asg);
    const mine = (r) => owner || r.actor_user_id === actor.user_id;
    if (req.method === "GET") {
      const q = url.searchParams;
      const rid = q.get("request");
      if (rid) {
        if (!ID_RE.test(rid)) return reply(400, { error: "request ungültig." });
        const look = async (mut) => mut((cur, t) => {
          if (q.get("watch") === "1") cur.watch_at = t.toISOString();
          const x = cur.requests.find((y) => y.request_id === rid && mine(y));
          return { status: x ? 200 : 404, body: x ? { request: publicRequest(x), online: online(cur, t) } : { error: "Unbekannter Auftrag." }, readOnly: q.get("watch") !== "1" };
        });
        let r = await look(mutate);
        if (r.status === 404 && getVnQueueStore) r = await look(mutateVn);
        if (r.status === 200 && r.body.request.status === "done" && r.body.request.lead_id) r.body.lead = leads.find((l) => l.lead_id === r.body.request.lead_id) || null;
        return reply(r.status, r.body);
      }
      if (q.get("export") === "csv") {
        const list = sortLeads(filterLeads(leads, crmFilters(q), now()), q.get("sort") || "company");
        await mutate((cur, t) => { cur.audit.push(auditEntry(t, { action: "crm.listLeads", actor_user_id: actor.user_id, outcome: `export_csv_${list.length}` })); return { status: 200, body: {} }; });
        return new Response(crmToCsv(list, csvLabelsFor(actor.locale)), { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
          "content-disposition": `attachment; filename="jarvis-crm-${now().toISOString().slice(0, 10)}.csv"` } });
      }
      // crm.listLeads: Sicht im Scope (Filter/Sortierung im Browser) + eigene Aufträge + (nur OWNER) Audit.
      const watch = q.get("watch") === "1";
      const r = await mutate((cur, t) => {
        if (watch) cur.watch_at = t.toISOString();
        return { status: 200, body: { online: online(cur, t), agent_seen_at: owner ? cur.agent_seen_at : null, requests: cur.requests.filter(mine).slice(-20).map(publicRequest),
          audit: owner ? cur.audit.slice(-30) : cur.audit.filter((a) => a.actor_user_id === actor.user_id).slice(-30) }, readOnly: !watch };
      });
      let vnOnline = false;
      if (getVnQueueStore && (owner || actor.markets.includes("VN"))) {
        const rv = await mutateVn((cur, t) => { if (watch) cur.watch_at = t.toISOString(); return { status: 200, body: { online: online(cur, t), requests: cur.requests.filter(mine).slice(-20).map(publicRequest) }, readOnly: !watch }; });
        vnOnline = !!rv.body?.online;
        r.body.requests = [...(r.body.requests || []), ...(rv.body?.requests || [])];
      }
      const markets = owner ? ["CH", "VN"] : actor.markets;
      return reply(200, { configured: true, empty: !v && !vn, actor: { user_id: actor.user_id, role: actor.role, locale: actor.locale, markets },
        generated_at: markets.includes("CH") ? v?.generated_at || null : vn?.generated_at || null, received_at: markets.includes("CH") ? v?.received_at || null : vn?.received_at || null,
        total: leads.length, stats: crmStats(leads, now()), backup: owner ? v?.backup || null : null, leads, ...r.body,
        online: markets.includes("CH") ? r.body.online : vnOnline, online_vn: vnOnline,
        ...(owner ? { vn_status: vn?.status || null, vn_total: vn?.leads?.length || 0 } : {}) });
    }

    const val = validateCrmAction(body, { now: now() });
    if (!val.ok) {
      await mutate((cur, t) => { cur.audit.push(auditEntry(t, { request_id: newId(), actor_user_id: actor.user_id, action: body?.action, outcome: "denied", code: val.code })); return { status: 200, body: {} }; });
      return reply(val.status, { error: val.error, code: val.code });
    }
    if (val.action === "crm.listLeads") return reply(200, { generated_at: v?.generated_at || null, total: leads.length, leads });
    const known = everything.find((l) => l.lead_id === val.params.lead_id) || null;
    const lead = known && canSeeLead(actor, known, asg) ? leads.find((l) => l.lead_id === known.lead_id) : null;
    if (!lead && known && !owner) {
      // Lead existiert, liegt aber nicht im Scope des Akteurs → 403 (auch bei direktem API-Aufruf), auditiert.
      await mutate((cur, t) => { cur.audit.push(auditEntry(t, { request_id: newId(), actor_user_id: actor.user_id, action: val.action, lead_id: val.params.lead_id, outcome: "denied", code: "OUT_OF_SCOPE" })); return { status: 200, body: {} }; });
      return reply(403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: "OUT_OF_SCOPE" });
    }
    if (!lead && !owner) return reply(403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: "OUT_OF_SCOPE" });
    if (val.action === "crm.getLead") return lead ? reply(200, { lead }) : reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" });
    if (!can(actor, "crm.write")) return forbidden();
    // Schreiben: nur bekannte Leads im Scope, nur mit erreichbarem Dienst des Markts, Rate Limit, Audit (mit Akteur).
    const mut = lead && leadMarket(lead) === "VN" ? mutateVn : mutate;
    const r = await mut((cur, t) => {
      const rid = newId();
      if (!lead) { cur.audit.push(auditEntry(t, { request_id: rid, actor_user_id: actor.user_id, action: val.action, lead_id: val.params.lead_id, outcome: "denied", code: "UNKNOWN_LEAD" }));
        return { status: 404, body: { error: "Unbekannter Lead – nur bestehende Jarvis-Leads können bearbeitet werden.", code: "UNKNOWN_LEAD" } }; }
      if (!online(cur, t)) { cur.audit.push(auditEntry(t, { request_id: rid, actor_user_id: actor.user_id, action: val.action, lead_id: lead.lead_id, outcome: "denied", code: "SERVER_OFFLINE" }));
        return { status: 503, body: { error: "CRM-Dienst auf dem VPS meldet sich nicht – nichts gespeichert.", code: "SERVER_OFFLINE" } }; }
      if (cur.rate.length >= RATE.writes) { cur.audit.push(auditEntry(t, { request_id: rid, actor_user_id: actor.user_id, action: val.action, lead_id: lead.lead_id, outcome: "denied", code: "RATE_LIMIT" }));
        return { status: 429, body: { error: "Zu viele Änderungen – bitte kurz warten.", code: "RATE_LIMIT" } }; }
      cur.rate.push({ at: t.toISOString() });
      const x = { request_id: rid, action: val.action, params: val.params, status: "pending", created_at: t.toISOString(), expires_at: new Date(+t + REQUEST_TTL_MS).toISOString(), actor_user_id: actor.user_id };
      cur.requests.push(x);
      cur.watch_at = t.toISOString();
      cur.audit.push(auditEntry(t, { ...x, lead_id: lead.lead_id, outcome: "queued" }));
      return { status: 202, body: { request: publicRequest(x) } };
    });
    return reply(r.status, r.body);
  };
}
