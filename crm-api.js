// /api/crm – Jarvis Lead-CRM in der Cloud (TF-053). Gleiches Muster wie /api/server-control: der Browser schreibt NIE direkt auf
// den VPS, sondern legt einen geprüften Auftrag (nur crm.*-Allowlist, genau ein Lead) in eine Warteschlange; der CRM-Dienst auf dem
// VPS holt ihn ausgehend ab, prüft erneut, speichert atomar und meldet das Ergebnis. Lesen kommt aus der zuletzt gemeldeten Sicht.
//
//   Browser:  x-jarvis-key = JARVIS_PASSWORD
//   VPS-Dienst: x-jarvis-crm = HMAC-SHA256(JARVIS_SERVER_CONTROL_TOKEN, "jarvis-crm-agent-v1") – eigener, abgeleiteter Schlüssel nur für
//   /api/crm (kein Zugriff auf Server Control, Mail-Queue oder Backups des Mail-Workers). Keine neue Netlify-Variable nötig.
//
// Keine Shell, keine Pfade, keine Dateien vom Client, kein Senden, kein Anruf. Unbekannte Leads → 404, unbekannte Aktionen → 400.
import crypto from "node:crypto";
import { safeEqual } from "./shared-state.js";
import { validateCrmAction, cleanCrmLead, CRM_ACTIONS, LEAD_ID_RE } from "./lead-crm.js";
import { crmToCsv, filterLeads, sortLeads, crmStats, FILTER_KEYS } from "./public/crm-model.js";
import { verifyBackup, BACKUP_FORMAT } from "./backup.js";

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

export function crmAgentToken(controlToken) {
  const t = String(controlToken || "").trim();
  return t.length >= 32 ? crypto.createHmac("sha256", t).update("jarvis-crm-agent-v1").digest("hex") : "";
}
const publicRequest = (r) => ({ request_id: r.request_id, action: r.action, lead_id: r.params?.lead_id || null, status: r.status, created_at: r.created_at,
  finished_at: r.finished_at || null, error: r.error || null, code: r.code || null });
const auditEntry = (t, x) => ({ ts: t.toISOString(), request_id: x.request_id || null, action: typeof x.action === "string" && Object.hasOwn(CRM_ACTIONS, x.action) ? x.action : "invalid",
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

export function createCrmHandler({ getQueueStore, getViewStore, getBackupStore = null, env, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  async function mutate(fn) {
    const store = await getQueueStore();
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
  async function patchView(fn) {
    const store = await getViewStore();
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const next = fn(state);
      if (!next) return true;
      if (await store.set(next, etag)) return true;
    }
    return false;
  }
  const online = (cur, t) => !!cur.agent_seen_at && +t - Date.parse(cur.agent_seen_at) < AGENT_STALE_MS;

  return async (req) => {
    const url = new URL(req.url);
    const agentToken = crmAgentToken(env("JARVIS_SERVER_CONTROL_TOKEN")), password = env("JARVIS_PASSWORD");
    if (req.method === "GET" && url.searchParams.has("probe")) return reply(200, { configured: !!agentToken && !!password });
    const isAgent = !!agentToken && safeEqual(req.headers.get("x-jarvis-crm"), agentToken);
    const isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    if (!isAgent && !isUser) return reply(401, { error: "Nicht berechtigt." });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    const limit = isAgent && !isUser ? MAX_AGENT_BYTES : MAX_USER_BYTES;
    if (Number(req.headers.get("content-length") || 0) > limit) return reply(413, { error: "Zu gross." });
    let body = {};
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > limit) return reply(413, { error: "Zu gross." });
      try { body = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Ungültige Anfrage." });
    }

    // ----- CRM-Dienst auf dem VPS -----
    if (isAgent && !isUser) {
      if (req.method !== "POST") return reply(405, { error: "Agent: nur POST." });
      if (body.op === "pull") {
        let stored = null;
        if (body.view !== undefined) {
          const v = body.view;
          if (!v || typeof v !== "object" || !Array.isArray(v.leads) || v.leads.length > MAX_VIEW_LEADS) return reply(400, { error: "view ungültig." });
          const leads = v.leads.map(cleanCrmLead).filter(Boolean);
          const t = now();
          const b = v.backup && typeof v.backup === "object" ? { last_at: iso(v.backup.last_at), offsite_ok: v.backup.offsite_ok === true, generations: Number.isInteger(v.backup.generations) ? Math.min(v.backup.generations, 1000) : 0 } : null;
          const ok = await patchView(() => ({ leads, total: leads.length, generated_at: iso(v.generated_at) || t.toISOString(), received_at: t.toISOString(), backup: b }));
          if (!ok) return reply(409, { error: "Gleichzeitige Änderung – bitte erneut versuchen." });
          stored = leads.length;
        }
        const r = await mutate((cur, t) => {
          cur.agent_seen_at = t.toISOString();
          const due = cur.requests.filter((x) => x.status === "pending");
          for (const x of due) { x.status = "running"; x.claimed_at = t.toISOString(); x.lease_until = new Date(+t + LEASE_MS).toISOString(); }
          const hot = due.length > 0 || (!!cur.watch_at && +t - Date.parse(cur.watch_at) < WATCH_MS) || cur.requests.some((x) => x.status === "running");
          return { status: 200, body: { requests: due.map((x) => ({ request_id: x.request_id, action: x.action, params: x.params, created_at: x.created_at })), hot, stored } };
        });
        return reply(r.status, r.body);
      }
      if (body.op === "result") {
        if (typeof body.request_id !== "string" || !ID_RE.test(body.request_id)) return reply(400, { error: "request_id ungültig." });
        let leadId = null;
        const r = await mutate((cur, t) => {
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
        if (r.status === 200 && lead && lead.lead_id === leadId) {
          await patchView((v) => { if (!v || !Array.isArray(v.leads)) return null; const i = v.leads.findIndex((l) => l.lead_id === lead.lead_id); if (i < 0) return null; v.leads[i] = lead; return v; });
        }
        return reply(r.status, r.body);
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

    // ----- Chris im Browser -----
    const readView = async () => (await (await getViewStore()).get()).state;
    if (req.method === "GET") {
      const q = url.searchParams;
      const rid = q.get("request");
      if (rid) {
        if (!ID_RE.test(rid)) return reply(400, { error: "request ungültig." });
        const r = await mutate((cur, t) => {
          if (q.get("watch") === "1") cur.watch_at = t.toISOString();
          const x = cur.requests.find((y) => y.request_id === rid);
          return { status: x ? 200 : 404, body: x ? { request: publicRequest(x), online: online(cur, t) } : { error: "Unbekannter Auftrag." }, readOnly: q.get("watch") !== "1" };
        });
        if (r.status === 200 && r.body.request.status === "done" && r.body.request.lead_id) {
          const v = await readView();
          r.body.lead = (v?.leads || []).find((l) => l.lead_id === r.body.request.lead_id) || null;
        }
        return reply(r.status, r.body);
      }
      if (q.get("export") === "csv") {
        const v = await readView();
        const list = sortLeads(filterLeads(v?.leads || [], crmFilters(q), now()), q.get("sort") || "company");
        await mutate((cur, t) => { cur.audit.push(auditEntry(t, { action: "crm.listLeads", outcome: `export_csv_${list.length}` })); return { status: 200, body: {} }; });
        return new Response(crmToCsv(list), { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store",
          "content-disposition": `attachment; filename="jarvis-crm-${now().toISOString().slice(0, 10)}.csv"` } });
      }
      // crm.listLeads: ganze Sicht (Filter/Sortierung im Browser) + Warteschlange + Audit.
      const watch = q.get("watch") === "1";
      const r = await mutate((cur, t) => {
        if (watch) cur.watch_at = t.toISOString();
        return { status: 200, body: { online: online(cur, t), agent_seen_at: cur.agent_seen_at, requests: cur.requests.slice(-20).map(publicRequest), audit: cur.audit.slice(-30) }, readOnly: !watch };
      });
      const v = await readView();
      const leads = v?.leads || [];
      return reply(200, { configured: true, empty: !v, generated_at: v?.generated_at || null, received_at: v?.received_at || null, total: leads.length,
        stats: crmStats(leads, now()), backup: v?.backup || null, leads, ...r.body });
    }

    const val = validateCrmAction(body, { now: now() });
    if (!val.ok) {
      await mutate((cur, t) => { cur.audit.push(auditEntry(t, { request_id: newId(), action: body?.action, outcome: "denied", code: val.code })); return { status: 200, body: {} }; });
      return reply(val.status, { error: val.error, code: val.code });
    }
    const v = await readView();
    const leads = v?.leads || [];
    if (val.action === "crm.listLeads") return reply(200, { generated_at: v?.generated_at || null, total: leads.length, leads });
    const lead = leads.find((l) => l.lead_id === val.params.lead_id) || null;
    if (val.action === "crm.getLead") return lead ? reply(200, { lead }) : reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" });
    // Schreiben: nur bekannte Leads, nur mit erreichbarem VPS-Dienst, Rate Limit, Audit.
    const r = await mutate((cur, t) => {
      const rid = newId();
      if (!lead) { cur.audit.push(auditEntry(t, { request_id: rid, action: val.action, lead_id: val.params.lead_id, outcome: "denied", code: "UNKNOWN_LEAD" }));
        return { status: 404, body: { error: "Unbekannter Lead – nur bestehende Jarvis-Leads können bearbeitet werden.", code: "UNKNOWN_LEAD" } }; }
      if (!online(cur, t)) { cur.audit.push(auditEntry(t, { request_id: rid, action: val.action, lead_id: lead.lead_id, outcome: "denied", code: "SERVER_OFFLINE" }));
        return { status: 503, body: { error: "CRM-Dienst auf dem VPS meldet sich nicht – nichts gespeichert.", code: "SERVER_OFFLINE" } }; }
      if (cur.rate.length >= RATE.writes) { cur.audit.push(auditEntry(t, { request_id: rid, action: val.action, lead_id: lead.lead_id, outcome: "denied", code: "RATE_LIMIT" }));
        return { status: 429, body: { error: "Zu viele Änderungen – bitte kurz warten.", code: "RATE_LIMIT" } }; }
      cur.rate.push({ at: t.toISOString() });
      const x = { request_id: rid, action: val.action, params: val.params, status: "pending", created_at: t.toISOString(), expires_at: new Date(+t + REQUEST_TTL_MS).toISOString() };
      cur.requests.push(x);
      cur.watch_at = t.toISOString();
      cur.audit.push(auditEntry(t, { ...x, lead_id: lead.lead_id, outcome: "queued" }));
      return { status: 202, body: { request: publicRequest(x) } };
    });
    return reply(r.status, r.body);
  };
}
