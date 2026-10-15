// /api/calling – Jarvis Calling Agent (TF-065). Gleiches Muster wie /api/crm: der Browser wählt NIE selbst, sondern legt geprüfte Kampagnen
// (nur lead_id, Markt, Modus, Parallelität) an; der Dienst jarvis-calling auf dem VPS holt ausgehend ab, bekommt erst beim Abholen – nach
// erneuter Berechtigungsprüfung – die Nummer aus dem autoritativen Lead und meldet strukturierte Ergebnisse zurück.
//
//   Browser:  Session-Cookie (auth-core.js). Zugang NUR OWNER (Chris) und SALES_AGENT_VN (Lap, nur eigene VN-Leads). Alle anderen 403, ohne Sitzung 401.
//   Dienst:   x-jarvis-calling = HMAC-SHA256(JARVIS_SERVER_CONTROL_TOKEN, "jarvis-calling-agent-v1") – eigener Schlüssel, nur pull/event.
//
// Der Browser darf weder Telefonnummer, Caller-ID, Trunk, Room noch Agent-Namen senden (400). Kein «force»: Berechtigung, DNC und
// Marktregeln gelten auch für den OWNER. Speicher (Blobs «jarvis-calling»): control (Kampagnen, aktive Anrufe, Dienststatus, Limits),
// history (abgeschlossene Anrufe, ohne Nummer), consents (Rückrufe, Zustimmungen, Anruf-DNC). Keine Aufnahmen, keine Audiodaten.
import crypto from "node:crypto";
import { safeEqual } from "./shared-state.js";
import { resolveActor, isOwner, deny, forbidden } from "./auth-core.js";
import { canSeeLead, sellerOf, leadMarket, emptyAssignments } from "./sales-scope.js";
import { LEAD_ID_RE } from "./lead-crm.js";
import {
  SCHEMA, MARKETS, MODES, CALL_OUTCOMES, FINAL_OUTCOMES, REACHED_OUTCOMES, NO_ANSWER_OUTCOMES, DEFAULTS, LIMIT_BOUNDS, FORBIDDEN_CLIENT_FIELDS,
  AGENT_TOKEN_LABEL, CALL_LEASE_MS, HARD_MAX_CONCURRENCY, eligibility, previewCounts, planClaims, applyOutcomeToItem, effectiveMax, clampConcurrency,
  e164Of, maskPhone, zurichDay, nextWindowStart, crmActionsFor, buildLeadContext, cleanSummary, isoOrNull,
} from "./calling-core.js";

export const AGENT_STALE_MS = 3 * 60_000;
export const HISTORY_KEEP = 3000;
export const MAX_BODY = 64_000;
export const CRM_SYSTEM_TTL_MS = 24 * 3_600_000; // Ergebnis-Übernahme ins CRM wartet bis zu 24 h auf den CRM-/VN-Dienst
const AUDIT_KEEP = 500, CAMPAIGN_KEEP = 50, RECENT_CALLS_KEEP = 200;
const ID_RE = /^[0-9a-f-]{36}$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const callingAgentToken = (control) => { const t = String(control || "").trim(); return t.length >= 32 ? crypto.createHmac("sha256", t).update(AGENT_TOKEN_LABEL).digest("hex") : ""; };
export const canUseCalling = (actor) => !!actor && (actor.role === "OWNER" || actor.role === "SALES_AGENT_VN");
const emptyControl = () => ({ schema: SCHEMA, campaigns: [], calls: {}, commands: [], service: null, config: {}, audit: [] });
const emptyHistory = () => ({ schema: SCHEMA, calls: [] });
const emptyConsents = () => ({ schema: SCHEMA, leads: {}, dnc: {} });

// Erlaubte Felder je Operation (alles andere → 400; verbotene Steuerfelder → 400 CLIENT_FIELD_FORBIDDEN).
const OPS = Object.freeze({
  "campaign.preview": ["market", "priority", "lead_ids"],
  "campaign.start": ["market", "mode", "concurrency", "confirmed", "priority", "lead_ids"],
  "campaign.pause": ["campaign_id"], "campaign.resume": ["campaign_id"], "campaign.stop": ["campaign_id", "end_active"],
  "call.start": ["lead_id", "confirmed"], "call.cancel": ["call_id"],
  "config.set": ["daily_call_cap", "max_campaign_size"],
});
const PRIORITIES = ["HIGH", "MEDIUM", "LOW"];
export function validateUserOp(body) {
  const bad = (code, error) => ({ ok: false, status: 400, code, error });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("BAD_REQUEST", "Ungültige Anfrage.");
  for (const k of Object.keys(body)) if (FORBIDDEN_CLIENT_FIELDS.includes(k.toLowerCase())) return bad("CLIENT_FIELD_FORBIDDEN", `Feld ${k.slice(0, 20)} bestimmt ausschliesslich der Server.`);
  if (typeof body.op !== "string" || !Object.hasOwn(OPS, body.op)) return bad("UNKNOWN_OP", "Unbekannte Operation.");
  for (const k of Object.keys(body)) if (k !== "op" && !OPS[body.op].includes(k)) return bad("UNKNOWN_FIELD", `Feld ${k.slice(0, 20)} ist nicht erlaubt.`);
  const p = { op: body.op };
  if ("market" in body) { if (!MARKETS.includes(body.market)) return bad("BAD_MARKET", "market: CH oder VN."); p.market = body.market; }
  if ("mode" in body) { if (!MODES.includes(body.mode)) return bad("BAD_MODE", "mode: SINGLE, SEQUENTIAL oder PARALLEL."); p.mode = body.mode; }
  if ("concurrency" in body) { if (!Number.isInteger(body.concurrency) || body.concurrency < 1 || body.concurrency > 100) return bad("BAD_CONCURRENCY", "concurrency: ganze Zahl ≥ 1."); p.concurrency = body.concurrency; }
  if ("confirmed" in body) { if (typeof body.confirmed !== "boolean") return bad("BAD_PARAMS", "confirmed: true/false."); p.confirmed = body.confirmed; }
  if ("end_active" in body) { if (typeof body.end_active !== "boolean") return bad("BAD_PARAMS", "end_active: true/false."); p.end_active = body.end_active; }
  if ("priority" in body && body.priority !== null) { if (!PRIORITIES.includes(body.priority)) return bad("BAD_PARAMS", "priority: HIGH, MEDIUM oder LOW."); p.priority = body.priority; }
  if ("lead_ids" in body) {
    if (!Array.isArray(body.lead_ids) || body.lead_ids.length < 1 || body.lead_ids.length > 200 || body.lead_ids.some((x) => typeof x !== "string" || x.length > 253 || !LEAD_ID_RE.test(x))) return bad("BAD_PARAMS", "lead_ids ungültig.");
    p.lead_ids = [...new Set(body.lead_ids)];
  }
  if ("lead_id" in body) { if (typeof body.lead_id !== "string" || body.lead_id.length > 253 || !LEAD_ID_RE.test(body.lead_id)) return bad("BAD_PARAMS", "lead_id ungültig."); p.lead_id = body.lead_id; }
  for (const k of ["campaign_id", "call_id"]) if (k in body) { if (typeof body[k] !== "string" || !ID_RE.test(body[k])) return bad("BAD_PARAMS", `${k} ungültig.`); p[k] = body[k]; }
  for (const k of ["daily_call_cap", "max_campaign_size"]) if (k in body) {
    const [lo, hi] = LIMIT_BOUNDS[k];
    if (!Number.isInteger(body[k]) || body[k] < lo || body[k] > hi) return bad("BAD_PARAMS", `${k}: ${lo}–${hi}.`);
    p[k] = body[k];
  }
  const need = { "campaign.preview": ["market"], "campaign.start": ["market", "mode", "confirmed"], "campaign.pause": ["campaign_id"], "campaign.resume": ["campaign_id"],
    "campaign.stop": ["campaign_id"], "call.start": ["lead_id", "confirmed"], "call.cancel": ["call_id"], "config.set": [] }[p.op];
  for (const k of need) if (!(k in p)) return bad("MISSING_FIELD", `${k} fehlt.`);
  return { ok: true, params: p };
}

// Dienststatus (vom VPS gemeldet) → öffentliche Anzeige. Nie Werte von Secrets, nur Ja/Nein + Modellnamen.
const bool = (v) => v === true;
function cleanServiceStatus(s) {
  const x = s && typeof s === "object" ? s : {};
  const str = (v, n = 80) => (typeof v === "string" ? v.replace(/[^\w .:()\/@+-]/g, "").slice(0, n) : null);
  const models = (m) => (m && typeof m === "object" ? { stt: str(m.stt), tts: str(m.tts), llm: str(m.llm) } : null);
  return { configured: { livekit: bool(x.configured?.livekit), livekit_url: bool(x.configured?.livekit_url), api_credentials: bool(x.configured?.api_credentials), trunk_ch: bool(x.configured?.trunk_ch),
      trunk_vn: bool(x.configured?.trunk_vn), caller_id_ch: bool(x.configured?.caller_id_ch), caller_id_vn: bool(x.configured?.caller_id_vn), transfer_ch: bool(x.configured?.transfer_ch), transfer_vn: bool(x.configured?.transfer_vn) },
    livekit_reachable: bool(x.livekit_reachable), worker_registered: bool(x.worker_registered), trunk_ch_verified: bool(x.trunk_ch_verified), trunk_vn_verified: bool(x.trunk_vn_verified),
    dry_run: x.dry_run !== false, recording: false,
    default_concurrency: Number.isInteger(x.default_concurrency) ? Math.max(1, Math.min(HARD_MAX_CONCURRENCY, x.default_concurrency)) : DEFAULTS.default_concurrency,
    max_concurrency: Number.isInteger(x.max_concurrency) ? Math.max(1, Math.min(HARD_MAX_CONCURRENCY, x.max_concurrency)) : DEFAULTS.max_concurrency,
    provider_limit: Number.isInteger(x.provider_limit) && x.provider_limit > 0 ? Math.min(x.provider_limit, 100) : null,
    models: { CH: models(x.models?.CH), VN: models(x.models?.VN) }, commit: str(x.commit, 40), started_at: isoOrNull(x.started_at), active: Number.isInteger(x.active) ? x.active : 0 };
}
export function serviceView(control, now) {
  const seen = control?.service?.seen_at;
  const online = !!seen && +now - Date.parse(seen) < AGENT_STALE_MS;
  const s = control?.service?.status ? control.service.status : cleanServiceStatus(null);
  const livekit = !online ? "OFFLINE" : !s.configured.livekit ? "NOT_CONFIGURED" : s.livekit_reachable && s.worker_registered ? "ONLINE" : "OFFLINE";
  const sip = (m) => (!online ? "OFFLINE" : !s.configured.livekit || !s.configured[`trunk_${m}`] ? "NOT_CONFIGURED" : s[`trunk_${m}_verified`] ? "READY" : "NOT_VERIFIED");
  return { online, seen_at: seen || null, livekit, sip_ch: sip("ch"), sip_vn: sip("vn"), dry_run: s.dry_run, recording: "OFF", worker_registered: s.worker_registered,
    models: s.models, default_concurrency: s.default_concurrency, max_concurrency: effectiveMax(s), provider_limit: s.provider_limit, commit: s.commit,
    transfer: { CH: s.configured.transfer_ch ? "CONFIGURED" : "TRANSFER_NOT_CONFIGURED", VN: s.configured.transfer_vn ? "CONFIGURED" : "TRANSFER_NOT_CONFIGURED" } };
}
const limitsOf = (control) => ({ daily_call_cap: Number.isInteger(control?.config?.daily_call_cap) ? control.config.daily_call_cap : DEFAULTS.daily_call_cap,
  max_campaign_size: Number.isInteger(control?.config?.max_campaign_size) ? control.config.max_campaign_size : DEFAULTS.max_campaign_size });
// Echte (nicht simulierte) Anrufe heute (Zürcher Kalendertag) – aus Verlauf + laufenden Anrufen.
export function callsToday(control, history, now) {
  const d = zurichDay(now);
  const real = (c) => !c.dry_run && c.started_at && zurichDay(new Date(c.started_at)) === d;
  return (history?.calls || []).filter(real).length + Object.values(control?.calls || {}).filter(real).length;
}

export function createCallingHandler({ env, getCallingStore, getAuthStore = null, getViewStore, getVnViewStore = null, getSalesStore = null,
  getCrmQueueStore = null, getVnQueueStore = null, now = () => new Date(), newId = () => crypto.randomUUID() }) {
  async function mutate(key, empty, fn) {
    const store = await getCallingStore(key);
    for (let i = 0; i < 8; i++) {
      const { state, etag } = await store.get();
      const cur = state && typeof state === "object" ? { ...empty(), ...state } : empty();
      const res = await fn(cur);
      if (res?.readOnly) return res;
      if (await store.set(cur, etag)) return res;
    }
    return { status: 409, body: { error: "Gleichzeitige Änderung – bitte erneut versuchen.", code: "CONFLICT" } };
  }
  const read = async (key, empty) => { const s = (await (await getCallingStore(key)).get()).state; return s && typeof s === "object" ? { ...empty(), ...s } : empty(); };
  const readAssignments = async () => (getSalesStore ? (await (await getSalesStore("assignments")).get()).state : null) || emptyAssignments();
  async function allLeads() {
    const [v, vn] = await Promise.all([(await getViewStore()).get(), getVnViewStore ? (await getVnViewStore()).get() : { state: null }]);
    return [...(v.state?.leads || []).map((l) => ({ ...l, market: "CH" })), ...(vn.state?.leads || []).map((l) => ({ ...l, market: "VN" }))];
  }
  // System-Aufträge in die bestehende CRM-/VN-Warteschlange (gleiche crm.*-Allowlist, Akteur system:calling). Der jeweilige Dienst übernimmt sie.
  async function enqueueCrm(market, actions, t) {
    const getStore = market === "VN" ? getVnQueueStore : getCrmQueueStore;
    if (!getStore || !actions.length) return [];
    const store = await getStore();
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const cur = { requests: [], audit: [], rate: [], agent_seen_at: null, watch_at: null, ...(state || {}) };
      const ids = [];
      for (const a of actions) {
        const rid = newId(); ids.push(rid);
        cur.requests.push({ request_id: rid, action: a.action, params: a.params, status: "pending", created_at: t.toISOString(), expires_at: new Date(+t + CRM_SYSTEM_TTL_MS).toISOString(), actor_user_id: "system:calling" });
        cur.audit.push({ ts: t.toISOString(), request_id: rid, actor_user_id: "system:calling", action: a.action, lead_id: a.params.lead_id, outcome: "queued", code: null });
      }
      cur.requests = cur.requests.slice(-100); cur.audit = cur.audit.slice(-500);
      if (await store.set(cur, etag)) return ids;
    }
    return [];
  }
  const audit = (cur, t, x) => { cur.audit = [...(cur.audit || []), { ts: t.toISOString(), ...x }].slice(-AUDIT_KEEP); };

  // ----- Dienst: Abholen (Status melden, freie Slots füllen) -----
  async function agentPull(body) {
    const t = now();
    const status = cleanServiceStatus(body.status);
    const known = new Set(Array.isArray(body.active_call_ids) ? body.active_call_ids.filter((x) => typeof x === "string" && ID_RE.test(x)) : []);
    const capacity = Number.isInteger(body.capacity) ? Math.max(0, Math.min(HARD_MAX_CONCURRENCY, body.capacity)) : 0;
    const [leads, asg, history, consents] = await Promise.all([allLeads(), readAssignments(), read("history", emptyHistory), read("consents", emptyConsents)]);
    const byId = new Map(leads.map((l) => [l.lead_id, l]));
    const dncSet = new Set(Object.keys(consents.dnc || {}));
    const elig = (id) => eligibility(byId.get(id), { consent: consents.leads?.[id] || null, dncSet, now: t });
    const reviewed = [];
    const r = await mutate("control", emptyControl, (cur) => {
      cur.service = { seen_at: t.toISOString(), status };
      // Anrufe ohne Lebenszeichen (Dienst kennt sie nicht mehr / Lease abgelaufen) → nie blind neu wählen, sondern prüfen lassen.
      for (const [id, c] of Object.entries(cur.calls)) {
        const stale = +t - Date.parse(c.last_event_at || c.started_at) > CALL_LEASE_MS;
        const lost = !known.has(id) && +t - Date.parse(c.started_at) > 2 * 60_000 && body.recovered === true;
        if (stale || lost) {
          c.status = "FAILED"; c.outcome = "FAILED"; c.review_required = true; c.reason = "CALL_STATE_REVIEW_REQUIRED"; c.ended_at = t.toISOString();
          const camp = cur.campaigns.find((x) => x.campaign_id === c.campaign_id);
          const it = camp?.items.find((x) => x.call_id === id);
          if (it) applyOutcomeToItem(it, "FAILED", { now: t, review: true });
          reviewed.push(c); delete cur.calls[id];
        }
      }
      const svc = { ...status, capacity, daily_call_cap: limitsOf(cur).daily_call_cap, calls_today: callsToday(cur, history, t) };
      const phoneOf = (id) => e164Of(byId.get(id));
      const { picks, waits } = planClaims(cur, { now: t, limits: svc, eligibleNow: (id) => elig(id), phoneOf });
      for (const w of waits) {
        const camp = cur.campaigns.find((x) => x.campaign_id === w.campaign_id);
        const it = camp?.items.find((x) => x.lead_id === w.lead_id);
        if (!it) continue;
        if (w.skip) { it.state = "SKIPPED"; it.last_code = w.code; continue; }
        if (w.code === "DAILY_CAP") { it.last_code = "DAILY_CAP"; it.next_at = new Date(+t + 30 * 60_000).toISOString(); continue; }
        const cb = consents.leads?.[w.lead_id]?.requested_callback?.callback_at;
        it.state = "QUEUE_WAITING_FOR_WINDOW"; it.last_code = w.code;
        const nxt = w.code === "CALLBACK_NOT_DUE" && cb ? new Date(cb) : nextWindowStart(camp.market, t, consents.leads?.[w.lead_id]?.window_agreement || null);
        it.next_at = (nxt || new Date(+t + 3_600_000)).toISOString();
      }
      const jobs = [];
      for (const p of picks) {
        const camp = cur.campaigns.find((x) => x.campaign_id === p.campaign_id);
        const it = camp.items.find((x) => x.lead_id === p.lead_id);
        const lead = byId.get(p.lead_id);
        const call_id = newId();
        it.state = "ACTIVE"; it.call_id = call_id; it.attempts = (it.attempts || 0) + 1; it.next_at = null; it.phone_key = p.phone_key;
        const call = { call_id, campaign_id: camp.campaign_id, lead_id: p.lead_id, market: camp.market, seller: sellerOf(lead, asg), actor_user_id: camp.owner_user_id,
          dry_run: camp.dry_run === true || status.dry_run, phone_masked: maskPhone(p.phone_key), status: "QUEUED", started_at: t.toISOString(), last_event_at: t.toISOString(),
          answered_at: null, ended_at: null, duration_s: null, outcome: null, attempt: it.attempts, recording: false };
        cur.calls[call_id] = call;
        jobs.push({ call_id, campaign_id: camp.campaign_id, lead_id: p.lead_id, market: camp.market, phone_e164: p.phone_key, dry_run: call.dry_run, attempt: it.attempts,
          context: buildLeadContext(lead, history.calls) });
      }
      for (const c of cur.campaigns) {
        if (c.status === "RUNNING" && !c.items.some((it) => ["QUEUED", "ACTIVE", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW"].includes(it.state))) { c.status = "FINISHED"; c.finished_at = t.toISOString(); }
        if (c.status === "STOPPED" && c.items.every((it) => it.state !== "ACTIVE")) c.closed = true;
      }
      const commands = cur.commands.filter((x) => x.type === "hangup");
      cur.commands = [];
      const hot = jobs.length > 0 || Object.keys(cur.calls).length > 0 || cur.campaigns.some((c) => c.status === "RUNNING");
      return { status: 200, body: { jobs, commands, hot, limits: { max_concurrency: effectiveMax(status), daily_call_cap: svc.daily_call_cap, calls_today: svc.calls_today + jobs.filter((j) => !j.dry_run).length } } };
    });
    if (reviewed.length) await archiveCalls(reviewed);
    return reply(r.status, r.body);
  }
  async function archiveCalls(calls) {
    await mutate("history", emptyHistory, (h) => { h.calls = [...h.calls, ...calls.map((c) => { const { phone_key, ...rest } = c; return rest; })].slice(-HISTORY_KEEP); return { status: 200 }; });
  }

  // ----- Dienst: Ereignis / Ergebnis eines Anrufs -----
  async function agentEvent(body) {
    if (typeof body.call_id !== "string" || !ID_RE.test(body.call_id)) return reply(400, { error: "call_id ungültig." });
    if (!CALL_OUTCOMES.includes(body.status)) return reply(400, { error: "status nicht in der Allowlist.", code: "BAD_STATUS" });
    const t = now();
    const final = FINAL_OUTCOMES.includes(body.status) || body.retry === true || body.review_required === true;
    let done = null, campaignMarket = null;
    const r = await mutate("control", emptyControl, (cur) => {
      const c = cur.calls[body.call_id];
      if (!c) return { status: 404, body: { error: "Unbekannter Anruf." }, readOnly: true };
      c.last_event_at = t.toISOString();
      if (!final) {
        c.status = body.status;
        if (body.status === "ANSWERED" && !c.answered_at) c.answered_at = isoOrNull(body.answered_at) || t.toISOString();
        return { status: 200, body: { ok: true } };
      }
      c.status = body.retry === true ? "FAILED" : body.status;
      c.outcome = body.retry === true ? "FAILED" : body.status;
      c.reason = typeof body.reason === "string" && /^[A-Z0-9_]{2,40}$/.test(body.reason) ? body.reason : null;
      c.answered_at = c.answered_at || isoOrNull(body.answered_at);
      c.ended_at = isoOrNull(body.ended_at) || t.toISOString();
      c.duration_s = Number.isInteger(body.duration_s) && body.duration_s >= 0 ? Math.min(body.duration_s, 7200) : c.answered_at ? Math.max(0, Math.round((Date.parse(c.ended_at) - Date.parse(c.answered_at)) / 1000)) : 0;
      c.summary = cleanSummary(body.summary) || null;
      c.callback_at = body.status === "CALLBACK_REQUESTED" ? isoOrNull(body.callback_at) : null;
      c.transfer = ["TRANSFERRED", "TRANSFER_NOT_CONFIGURED", "TRANSFER_FAILED"].includes(body.transfer) ? body.transfer : null;
      c.review_required = body.review_required === true;
      c.retry_later = body.retry === true;
      const camp = cur.campaigns.find((x) => x.campaign_id === c.campaign_id);
      campaignMarket = camp?.market || c.market;
      const it = camp?.items.find((x) => x.call_id === c.call_id);
      if (it) applyOutcomeToItem(it, c.outcome, { now: t, retry: body.retry === true, review: c.review_required, market: campaignMarket });
      if (camp) camp.last_finished_at = t.toISOString();
      // DNC: sofort alle offenen Positionen dieses Leads (auch anderer Kampagnen) entfernen.
      if (c.outcome === "DO_NOT_CALL") for (const k of cur.campaigns) for (const x of k.items) if (x.lead_id === c.lead_id && x.state !== "ACTIVE" && x.state !== "DONE") { x.state = "CANCELLED"; x.last_code = "DNC"; }
      // Erbetener Rückruf: dieselbe Lead-Position nicht doppelt – ein späterer Anruf entsteht nur über den gespeicherten Rückruf.
      if (c.outcome === "CALLBACK_REQUESTED" && it) it.state = "DONE";
      delete cur.calls[c.call_id];
      done = c;
      return { status: 200, body: { ok: true } };
    });
    if (r.status !== 200 || !done) return reply(r.status, r.body);
    // Folgen ausserhalb des Kontroll-Dokuments: Verlauf, Rückruf/DNC, CRM.
    if (done.outcome === "DO_NOT_CALL" || (done.outcome === "CALLBACK_REQUESTED" && done.callback_at)) {
      await mutate("consents", emptyConsents, (s) => {
        s.leads ||= {}; s.dnc ||= {};
        if (done.outcome === "DO_NOT_CALL") { s.dnc[done.lead_id] = { at: t.toISOString(), source: "call", call_id: done.call_id }; const x = s.leads[done.lead_id] || {}; delete x.requested_callback; s.leads[done.lead_id] = { ...x, dnc: true }; }
        else if (!done.dry_run) s.leads[done.lead_id] = { ...(s.leads[done.lead_id] || {}), requested_callback: { at: t.toISOString(), callback_at: done.callback_at, call_id: done.call_id } };
        return { status: 200 };
      });
    }
    // Simulierte Anrufe (Dry Run) ändern nie das CRM.
    const acts = crmActionsFor(done);
    done.crm_requests = acts.length ? await enqueueCrm(campaignMarket || done.market, acts, t) : [];
    done.crm_action = acts.map((a) => a.action).join(",") || null;
    await archiveCalls([done]);
    return reply(200, { ok: true, crm_requests: done.crm_requests.length });
  }

  return async (req) => {
    const url = new URL(req.url);
    const control = env("JARVIS_SERVER_CONTROL_TOKEN");
    const agentToken = callingAgentToken(control);
    if (req.method === "GET" && url.searchParams.has("probe")) return reply(200, { configured: !!agentToken });
    const isAgent = !!agentToken && safeEqual(req.headers.get("x-jarvis-calling"), agentToken);
    let actor = null;
    if (!isAgent) {
      const r = await resolveActor(req, { env, getAuthStore, now });
      if (!r.actor) return deny(r);
      actor = r.actor;
      if (!canUseCalling(actor)) return forbidden("Kein Zugang zum Calling Agent.");
    }
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    const limit = isAgent ? 2_000_000 : MAX_BODY;
    if (Number(req.headers.get("content-length") || 0) > limit) return reply(413, { error: "Zu gross." });
    let body = {};
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > limit) return reply(413, { error: "Zu gross." });
      try { body = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Ungültige Anfrage." });
    }

    if (isAgent) {
      if (req.method !== "POST") return reply(405, { error: "Dienst: nur POST." });
      if (body.op === "pull") return agentPull(body);
      if (body.op === "event") return agentEvent(body);
      return reply(400, { error: "Unbekannte Operation." });
    }

    // ----- Browser (Chris / Lap) -----
    const owner = isOwner(actor);
    const t = now();
    const [ctl, history, consents, leads, asg] = await Promise.all([read("control", emptyControl), read("history", emptyHistory), read("consents", emptyConsents), allLeads(), readAssignments()]);
    const byId = new Map(leads.map((l) => [l.lead_id, l]));
    const inScope = (l) => !!l && canSeeLead(actor, l, asg) && (owner || leadMarket(l) === "VN");
    const marketsOf = owner ? ["CH", "VN"] : ["VN"];
    const visibleCall = (c) => marketsOf.includes(c.market) && (owner || inScope(byId.get(c.lead_id)));
    const svc = serviceView(ctl, t);
    const lim = limitsOf(ctl);
    const today = callsToday(ctl, history, t);
    const pubCall = (c) => ({ call_id: c.call_id, campaign_id: c.campaign_id, lead_id: c.lead_id, company: byId.get(c.lead_id)?.company || null, market: c.market,
      seller: c.seller || null, phone: c.phone_masked, status: c.status, outcome: c.outcome || null, started_at: c.started_at, answered_at: c.answered_at || null,
      ended_at: c.ended_at || null, duration_s: c.duration_s ?? null, callback_at: c.callback_at || null, summary: c.summary || null, dry_run: !!c.dry_run,
      review_required: !!c.review_required, transfer: c.transfer || null, attempt: c.attempt || 1 });
    const canStart = (m) => {
      if (!svc.online) return { ok: false, code: "SERVICE_OFFLINE" };
      if (svc.livekit === "NOT_CONFIGURED") return { ok: false, code: "NOT_CONFIGURED" };
      if (svc.livekit !== "ONLINE") return { ok: false, code: "LIVEKIT_OFFLINE" };
      if (svc[`sip_${m.toLowerCase()}`] !== "READY") return { ok: false, code: "SIP_NOT_CONFIGURED" };
      return { ok: true, code: null };
    };

    if (req.method === "GET") {
      const leadId = url.searchParams.get("lead");
      if (leadId) {
        if (!LEAD_ID_RE.test(leadId)) return reply(400, { error: "lead ungültig." });
        const l = byId.get(leadId);
        if (!l) return reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" });
        if (!inScope(l)) return reply(403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: "OUT_OF_SCOPE" });
        const calls = [...history.calls, ...Object.values(ctl.calls)].filter((c) => c.lead_id === leadId).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
        const last = calls.at(-1) || null;
        const cs = consents.leads?.[leadId] || {};
        const e = eligibility(l, { consent: cs, dncSet: new Set(Object.keys(consents.dnc || {})), now: t });
        return reply(200, { lead_id: leadId, market: leadMarket(l), eligibility: { decision: e.decision, bucket: e.bucket, code: e.code, basis: e.basis },
          last_call: last ? pubCall(last) : null, attempts: calls.filter((c) => !c.dry_run).length, next_callback: cs.requested_callback?.callback_at || null,
          dnc: !!(consents.dnc?.[leadId]), calls: calls.slice(-10).reverse().map(pubCall), recording: "OFF" });
      }
      const campaigns = ctl.campaigns.filter((c) => marketsOf.includes(c.market) && (owner || c.owner_user_id === actor.user_id || c.market === "VN"))
        .slice(-20).reverse().map((c) => ({ campaign_id: c.campaign_id, market: c.market, mode: c.mode, concurrency: c.concurrency, status: c.status, dry_run: !!c.dry_run,
          owner_user_id: c.owner_user_id, created_at: c.created_at, planned: c.items.length,
          counts: Object.fromEntries(["QUEUED", "ACTIVE", "DONE", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW", "CALL_STATE_REVIEW_REQUIRED", "SKIPPED", "CANCELLED"].map((s) => [s, c.items.filter((i) => i.state === s).length])) }));
      const d = zurichDay(t);
      const todays = history.calls.filter((c) => visibleCall(c) && c.started_at && zurichDay(new Date(c.started_at)) === d);
      const n = (f) => todays.filter(f).length;
      const queue = ctl.campaigns.filter((c) => marketsOf.includes(c.market) && ["RUNNING", "PAUSED"].includes(c.status))
        .reduce((s, c) => s + c.items.filter((i) => ["QUEUED", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW"].includes(i.state)).length, 0);
      const active = Object.values(ctl.calls).filter(visibleCall);
      const svcOut = owner ? svc : { ...svc, sip_ch: undefined, models: { VN: svc.models?.VN || null }, transfer: { VN: svc.transfer.VN } };
      return reply(200, { actor: { user_id: actor.user_id, role: actor.role, locale: actor.locale, markets: marketsOf }, service: svcOut,
        limits: { default_concurrency: svc.default_concurrency, max_concurrency: svc.max_concurrency, daily_call_cap: lim.daily_call_cap, max_campaign_size: lim.max_campaign_size,
          calls_today: today, remaining_today: Math.max(0, lim.daily_call_cap - today), owner_can_configure: owner },
        can_start: Object.fromEntries(marketsOf.map((m) => [m, canStart(m)])),
        stats_today: { active: active.length, queued: queue, called: todays.length, reached: n((c) => REACHED_OUTCOMES.includes(c.outcome)), no_answer: n((c) => NO_ANSWER_OUTCOMES.includes(c.outcome)),
          interested: n((c) => c.outcome === "INTERESTED"), callbacks: n((c) => c.outcome === "CALLBACK_REQUESTED"), dnc: n((c) => c.outcome === "DO_NOT_CALL"), errors: n((c) => c.outcome === "FAILED"),
          review_required: n((c) => c.review_required) },
        active_calls: active.map(pubCall), recent_calls: history.calls.filter(visibleCall).slice(-20).reverse().map(pubCall), campaigns });
    }

    const v = validateUserOp(body);
    if (!v.ok) return reply(v.status, { error: v.error, code: v.code });
    const p = v.params;
    if (p.op === "config.set") {
      if (!owner) return forbidden("Nur der Owner darf Limits ändern.");
      const r = await mutate("control", emptyControl, (cur) => {
        cur.config = { ...(cur.config || {}), ...(p.daily_call_cap !== undefined ? { daily_call_cap: p.daily_call_cap } : {}), ...(p.max_campaign_size !== undefined ? { max_campaign_size: p.max_campaign_size } : {}),
          updated_at: t.toISOString(), updated_by: actor.user_id };
        audit(cur, t, { actor_user_id: actor.user_id, action: "config.set", result: "success" });
        return { status: 200, body: { limits: limitsOf(cur) } };
      });
      return reply(r.status, r.body);
    }
    if (p.market && !marketsOf.includes(p.market)) return reply(403, { error: "Markt nicht in Ihrem Bereich.", code: "OUT_OF_SCOPE" });

    // Kandidaten: Leads im Scope + Markt (+ optional Priorität / ausgewählte Leads), nach Priorität.
    const dncSet = new Set(Object.keys(consents.dnc || {}));
    const ctxOf = (l) => ({ consent: consents.leads?.[l.lead_id] || null, dncSet, now: t });
    const pickLeads = (market, { priority, lead_ids, lead_id } = {}) => {
      const ids = lead_id ? [lead_id] : lead_ids || null;
      if (ids) {
        const out = [];
        for (const id of ids) {
          const l = byId.get(id);
          if (!l) return { error: reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" }) };
          if (!inScope(l)) return { error: reply(403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: "OUT_OF_SCOPE" }) };
          if (market && leadMarket(l) !== market) return { error: reply(400, { error: "Lead gehört nicht zu diesem Markt.", code: "MARKET_MISMATCH" }) };
          out.push(l);
        }
        return { leads: out };
      }
      return { leads: leads.filter((l) => leadMarket(l) === market && inScope(l) && !l.archived && (!priority || l.priority?.level === priority))
        .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0) || a.lead_id.localeCompare(b.lead_id)) };
    };
    const busyLeads = new Set(ctl.campaigns.filter((c) => ["RUNNING", "PAUSED"].includes(c.status)).flatMap((c) => c.items.filter((i) => ["QUEUED", "ACTIVE", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW"].includes(i.state)).map((i) => i.lead_id)));
    const planFor = (market, sel) => {
      const { counts, allowed } = previewCounts(sel, ctxOf);
      const free = allowed.filter((id) => !busyLeads.has(id));
      const dry = svc.dry_run;
      const remaining = dry ? Infinity : Math.max(0, lim.daily_call_cap - today);
      const planned = Math.min(free.length, lim.max_campaign_size, remaining);
      return { counts, planned, ids: free.slice(0, planned), already_queued: allowed.length - free.length, dry_run: dry };
    };

    if (p.op === "campaign.preview") {
      const s = pickLeads(p.market, p);
      if (s.error) return s.error;
      const pl = planFor(p.market, s.leads);
      return reply(200, { market: p.market, ...pl.counts, planned_max_calls: pl.planned, already_queued: pl.already_queued, dry_run: pl.dry_run,
        daily_call_cap: lim.daily_call_cap, calls_today: today, max_campaign_size: lim.max_campaign_size, max_concurrency: svc.max_concurrency, can_start: canStart(p.market) });
    }
    if (p.op === "campaign.start" || p.op === "call.start") {
      const market = p.op === "call.start" ? leadMarket(byId.get(p.lead_id) || {}) : p.market;
      if (p.op === "call.start" && !byId.get(p.lead_id)) return reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" });
      if (!marketsOf.includes(market)) return reply(403, { error: "Markt nicht in Ihrem Bereich.", code: "OUT_OF_SCOPE" });
      const s = pickLeads(market, p);
      if (s.error) return s.error;
      if (p.confirmed !== true) return reply(400, { error: "Ausdrückliche Bestätigung fehlt.", code: "CONFIRMATION_REQUIRED" });
      const cs = canStart(market);
      if (!cs.ok) return reply(409, { error: market === "VN" ? "LiveKit/SIP chưa được cấu hình" : "LiveKit/SIP noch nicht eingerichtet", code: cs.code });
      const mode = p.op === "call.start" ? "SINGLE" : p.mode;
      const pl = planFor(market, s.leads);
      if (mode === "SINGLE" && s.leads.length !== 1) return reply(400, { error: "EINZELN: genau ein Lead.", code: "SINGLE_NEEDS_ONE" });
      if (!pl.ids.length) return reply(409, { error: "Keine zulässigen Leads (Berechtigung, DNC, Zeitfenster oder Tageslimit).", code: "NOTHING_ALLOWED", ...pl.counts, planned_max_calls: 0 });
      const concurrency = mode === "PARALLEL" ? clampConcurrency(p.concurrency ?? svc.default_concurrency, { max_concurrency: svc.max_concurrency, provider_limit: svc.provider_limit }) : 1;
      const campaign_id = newId();
      const r = await mutate("control", emptyControl, (cur) => {
        const live = new Set(cur.campaigns.filter((c) => ["RUNNING", "PAUSED"].includes(c.status)).flatMap((c) => c.items.filter((i) => ["QUEUED", "ACTIVE", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW"].includes(i.state)).map((i) => i.lead_id)));
        const ids = pl.ids.filter((id) => !live.has(id));
        if (!ids.length) return { status: 409, body: { error: "Diese Leads sind bereits eingeplant.", code: "ALREADY_QUEUED" }, readOnly: true };
        cur.campaigns = [...cur.campaigns, { campaign_id, market, mode, concurrency, status: "RUNNING", owner_user_id: actor.user_id, dry_run: pl.dry_run, created_at: t.toISOString(),
          items: ids.map((lead_id) => ({ lead_id, state: "QUEUED", attempts: 0, next_at: null, call_id: null, last_outcome: null })) }]
          .filter((c, i, a) => i >= a.length - CAMPAIGN_KEEP || ["RUNNING", "PAUSED"].includes(c.status) || c.items.some((x) => x.state === "ACTIVE"));
        audit(cur, t, { actor_user_id: actor.user_id, action: p.op, campaign_id, market, mode, concurrency, planned: ids.length, dry_run: pl.dry_run, result: "queued" });
        return { status: 202, body: { campaign_id, market, mode, concurrency, planned: ids.length, dry_run: pl.dry_run } };
      });
      return reply(r.status, r.body);
    }
    // pause / resume / stop / cancel – nur eigene Kampagnen (Lap) bzw. alle (Owner); Markt im Scope.
    const r = await mutate("control", emptyControl, (cur) => {
      if (p.op === "call.cancel") {
        const c = cur.calls[p.call_id];
        const camp = c ? cur.campaigns.find((x) => x.campaign_id === c.campaign_id) : cur.campaigns.find((x) => x.items.some((i) => i.call_id === p.call_id));
        if (!camp || !marketsOf.includes(camp.market) || (!owner && camp.owner_user_id !== actor.user_id)) return { status: 404, body: { error: "Unbekannter Anruf." }, readOnly: true };
        if (c) cur.commands.push({ type: "hangup", call_id: p.call_id, at: t.toISOString() });
        audit(cur, t, { actor_user_id: actor.user_id, action: p.op, call_id: p.call_id, result: "requested" });
        return { status: 202, body: { ok: true, hangup: !!c } };
      }
      const camp = cur.campaigns.find((x) => x.campaign_id === p.campaign_id);
      if (!camp || !marketsOf.includes(camp.market) || (!owner && camp.owner_user_id !== actor.user_id)) return { status: 404, body: { error: "Unbekannte Kampagne." }, readOnly: true };
      if (["STOPPED", "FINISHED"].includes(camp.status)) return { status: 409, body: { error: `Kampagne ist ${camp.status}.`, code: camp.status }, readOnly: true };
      if (p.op === "campaign.pause") camp.status = "PAUSED";
      if (p.op === "campaign.resume") camp.status = "RUNNING";
      if (p.op === "campaign.stop") {
        camp.status = "STOPPED"; camp.stopped_at = t.toISOString();
        for (const it of camp.items) if (["QUEUED", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW"].includes(it.state)) it.state = "CANCELLED";
        // Aktive Gespräche laufen normal zu Ende – ausser «AKTIVE ANRUFE BEENDEN» wurde ausdrücklich gewählt.
        if (p.end_active === true) for (const it of camp.items) if (it.state === "ACTIVE" && it.call_id) cur.commands.push({ type: "hangup", call_id: it.call_id, at: t.toISOString() });
      }
      audit(cur, t, { actor_user_id: actor.user_id, action: p.op, campaign_id: camp.campaign_id, end_active: p.end_active === true, result: "success" });
      return { status: 200, body: { campaign_id: camp.campaign_id, status: camp.status } };
    });
    return reply(r.status, r.body);
  };
}
