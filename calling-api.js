import crypto from "node:crypto";

// /api/calling – CRM-Anrufdaten für menschliche Vertriebsmitarbeiter. Autonome
// Autonome Agenten und Calling-Worker sind entfernt; dieser Endpunkt liefert nur
// CRM-Listen, Historie, Status und Rückrufdaten.
//
//   Browser:  Session-Cookie (auth-core.js). Zugang NUR OWNER (Chris) und SALES_AGENT_VN (Kudoshin, nur eigene VN-Leads). Alle anderen 403, ohne Sitzung 401.
//
// Der Browser darf weder Telefonnummer, Caller-ID, Trunk, Room noch Agent-Namen senden (400). Kein «force»: Berechtigung, DNC und
// Marktregeln gelten auch für den OWNER. Speicher (Blobs «jarvis-calling»): control (Kampagnen, aktive Anrufe, Dienststatus, Limits),
// history (abgeschlossene Anrufe, ohne Nummer), consents (Rückrufe, Zustimmungen, Anruf-DNC). Keine Aufnahmen, keine Audiodaten.
import { resolveActor, isOwner, deny, forbidden } from "./auth-core.js";
import { canSeeLead, sellerOf, leadMarket, emptyAssignments } from "./sales-scope.js";
import { LEAD_ID_RE } from "./lead-crm.js";
import { issueLinks, crmActive, issueDetails, DETAIL_WORDS_DE, isTestLead } from "./public/crm-model.js";
import { DETAIL_WORDS_VI, ISSUE_TYPE_TEXT } from "./public/i18n.js";
import { migrateCallingControl, migrateCallingHistory, migrateStoreDoc, migrateOnce } from "./seller-identity.js";
import {
  SCHEMA, MARKETS, MODES, CALL_OUTCOMES, FINAL_OUTCOMES, REACHED_OUTCOMES, NO_ANSWER_OUTCOMES, DEFAULTS, LIMIT_BOUNDS, FORBIDDEN_CLIENT_FIELDS,
  HARD_MAX_CONCURRENCY, eligibility, previewCounts,
  e164Of, maskPhone, zurichDay, isoOrNull,
  CALLING_MARKETS, CONSENT_SOURCES, CONSENT_SCOPE, LEGAL_STATES, phoneHash, callFlag, leadList,
} from "./calling-core.js";

// TF-072: Direktlinks der verifizierten Fehler EINES Leads (betroffene Seite + ggf. Ziel; nur sichere öffentliche http(s)-Adressen aus der
// gescopten CRM-Sicht, unbekannt → null). Nur lesen: der Calling-Flow schreibt nie URLs und ändert nie Website-Inhalte.
// TF-076: zusätzlich je Fehler die verständliche Beschreibung (Fehler, Position, Beleg, Auswirkung) – VN-Lead vietnamesisch, sonst Deutsch.
export const callIssueLinks = (l, max = 10) => {
  const vi = l?.market === "VN";
  const det = issueDetails(l, max, vi ? DETAIL_WORDS_VI : DETAIL_WORDS_DE, (f) => (vi && f.type && ISSUE_TYPE_TEXT["vi-VN"][f.type]) || f.text || "");
  return issueLinks(l, max).map((x, i) => ({ title: x.title, text: x.text, type: x.type, category: x.category, severity: x.severity,
    affected_url: x.affected_url, target_url: x.target_url, short_title: det[i]?.short_title || null, page_location: det[i]?.page_location || null,
    evidence: det[i]?.evidence || null, impact: det[i]?.impact || null, verified_at: det[i]?.verified_at || null }));
};

// TF-068 Rollen: Kudoshin (SALES_AGENT_VN; TF-070, vormals lap) darf Kampagnen/Einzelanrufe STARTEN. Chris (OWNER) überwacht, konfiguriert, sieht Statistik/Audit und
// hat den Notstopp – startet aber KEINE eigenen Kampagnen (403). Alle anderen 403. Nur Markt VN (CH-Calling deaktiviert).
export const canStartCalls = (actor) => actor?.role === "SALES_AGENT_VN";
export const LEAD_LISTS = Object.freeze(["ALL_LEADS", "CALL_ELIGIBLE_LEADS", "CALL_BLOCKED_LEADS", "DO_NOT_CONTACT"]);

export const AGENT_STALE_MS = 3 * 60_000;
export const HISTORY_KEEP = 3000;
export const MAX_BODY = 64_000;
export const CRM_SYSTEM_TTL_MS = 24 * 3_600_000; // Ergebnis-Übernahme ins CRM wartet bis zu 24 h auf den CRM-/VN-Dienst
const AUDIT_KEEP = 500, CAMPAIGN_KEEP = 50, RECENT_CALLS_KEEP = 200;
const ID_RE = /^[0-9a-f-]{36}$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
// The calling dashboard is also the read-only history view for human sellers.
// Keep every role that has CRM read access; autonomous calling never uses this
// predicate because its agent path is removed below.
export const canUseCalling = (actor) => !!actor && ["OWNER", "SALES_MANAGER_CH", "SALES_AGENT_CH", "SALES_AGENT_VN"].includes(actor.role);

// Convert the authoritative CRM call_history into the dashboard's read model.
// Human employees record calls through crm.addCall; no provider or dialer is
// involved, and the source remains synthetic/CRM data only.
export function manualCallsFromLeads(leads = []) {
  return (Array.isArray(leads) ? leads : []).flatMap((lead) => (Array.isArray(lead?.call_history) ? lead.call_history : []).map((call) => ({
    lead_id: lead.lead_id, company: lead.company || null, market: lead.market || "CH", call_id: call.id || null,
    started_at: call.at || null, status: "COMPLETED", outcome: call.result || null, summary: call.note || null,
    callback_at: call.follow_up_at || null, dry_run: false,
  })));
}
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
  // TF-068 (nur OWNER, auditiert): Notstopp, Rechtsprüfung, Einwilligungsnachweise, Abgleich nationales DNC-Register.
  "emergency.stop": ["reason"], "emergency.release": ["reason"],
  "legal.set": ["status", "reference"],
  "consent.record": ["lead_id", "consent_status", "consent_source", "consent_timestamp", "consent_scope", "consent_evidence_reference"],
  "consent.revoke": ["lead_id", "reason"],
  "dnc_registry.record": ["lead_id", "registry_result", "reference"],
});
const OWNER_OPS = new Set(["config.set", "emergency.stop", "emergency.release", "legal.set", "consent.record", "dnc_registry.record"]);
const TEXT_RE = /^[^\u0000-\u001f<>{}`]{3,200}$/;
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
  for (const k of ["reason", "reference", "consent_evidence_reference"]) if (k in body) { if (typeof body[k] !== "string" || !TEXT_RE.test(body[k].trim())) return bad("BAD_PARAMS", `${k}: 3–200 Zeichen Text.`); p[k] = body[k].trim(); }
  if ("status" in body) { if (!LEGAL_STATES.includes(body.status)) return bad("BAD_PARAMS", `status: ${LEGAL_STATES.join(" | ")}.`); p.status = body.status; }
  if ("consent_status" in body) { if (body.consent_status !== "GRANTED") return bad("BAD_PARAMS", "consent_status: GRANTED (Widerruf über consent.revoke)."); p.consent_status = body.consent_status; }
  if ("consent_source" in body) { if (!CONSENT_SOURCES.includes(body.consent_source)) return bad("CONSENT_SOURCE_NOT_VERIFIABLE", `consent_source: ${CONSENT_SOURCES.join(" | ")} – Telefonbuch/Website sind keine Einwilligung.`); p.consent_source = body.consent_source; }
  if ("consent_scope" in body) { const s = Array.isArray(body.consent_scope) ? body.consent_scope : [body.consent_scope]; if (!s.includes(CONSENT_SCOPE) || s.some((x) => typeof x !== "string" || !/^[A-Z_]{3,40}$/.test(x))) return bad("BAD_PARAMS", `consent_scope muss ${CONSENT_SCOPE} enthalten.`); p.consent_scope = [...new Set(s)]; }
  if ("consent_timestamp" in body) { const v = isoOrNull(body.consent_timestamp); if (!v) return bad("BAD_PARAMS", "consent_timestamp: ISO-Zeitpunkt."); p.consent_timestamp = v; }
  if ("registry_result" in body) { if (!["NOT_LISTED", "LISTED"].includes(body.registry_result)) return bad("BAD_PARAMS", "registry_result: NOT_LISTED | LISTED."); p.registry_result = body.registry_result; }
  const need = { "campaign.preview": ["market"], "campaign.start": ["market", "mode", "confirmed"], "campaign.pause": ["campaign_id"], "campaign.resume": ["campaign_id"],
    "campaign.stop": ["campaign_id"], "call.start": ["lead_id", "confirmed"], "call.cancel": ["call_id"], "config.set": [], "emergency.stop": ["reason"], "emergency.release": ["reason"],
    "legal.set": ["status", "reference"], "consent.record": ["lead_id", "consent_status", "consent_source", "consent_timestamp", "consent_scope", "consent_evidence_reference"],
    "consent.revoke": ["lead_id", "reason"], "dnc_registry.record": ["lead_id", "registry_result", "reference"] }[p.op];
  for (const k of need) if (!(k in p)) return bad("MISSING_FIELD", `${k} fehlt.`);
  return { ok: true, params: p };
}

// Der frühere Provider-/Worker-Status ist absichtlich nicht mehr vorhanden.
export function serviceView(control, now) {
  return { online: false, removed: true, code: "AUTONOMOUS_CALLING_REMOVED", seen_at: null, dry_run: true,
    recording: "OFF", worker_registered: false, default_concurrency: DEFAULTS.default_concurrency,
    max_concurrency: DEFAULTS.max_concurrency, provider_limit: null, active: 0 };
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
  // TF-070: Kampagnen/Anrufe des Kontos «lap» gehören Kudoshin – einmal je Instanz, idempotent (Audit bleibt unverändert).
  const migrateIdentity = migrateOnce(async () => {
    await migrateStoreDoc(await getCallingStore("control"), migrateCallingControl);
    await migrateStoreDoc(await getCallingStore("history"), migrateCallingHistory);
  });
  const read = async (key, empty) => { const s = (await (await getCallingStore(key)).get()).state; return s && typeof s === "object" ? { ...empty(), ...s } : empty(); };
  const readAssignments = async () => (getSalesStore ? (await (await getSalesStore("assignments")).get()).state : null) || emptyAssignments();
  async function allLeads() {
    const [v, vn] = await Promise.all([(await getViewStore()).get(), getVnViewStore ? (await getVnViewStore()).get() : { state: null }]);
    // TF-076: nur aktive CRM-Leads (≥ 1 verifizierter Website-Fehler) – ein Lead ohne Fehler kommt nie in eine Anrufliste.
    // TF-077B: Kontaktformular-Leads (CONTACT_FORM_INBOUND) zählen als aktiv; VN-Inbound aus dem CH-CRM bleibt Markt VN. Höchste Anrufpriorität
    // über priority.score (P0) – alle Rechts-/Einwilligungs-/DNC-/Telefonbuch-Sperren in eligibility() bleiben unverändert wirksam.
    const chMarket = (l) => (l.market === "VN" && l.contact_form?.lead_source === "CONTACT_FORM" && l.contact_form.inbound === true ? "VN" : "CH");
    // TF-080: E2E-Testleads kommen nie in eine Anrufliste/Statistik (eligibility sperrt zusätzlich mit TEST_BLOCKED).
    return [...(v.state?.leads || []).map((l) => ({ ...l, market: chMarket(l) })), ...(vn.state?.leads || []).map((l) => ({ ...l, market: "VN" }))].filter(crmActive).filter((l) => !isTestLead(l));
  }
  const audit = (cur, t, x) => { cur.audit = [...(cur.audit || []), { ts: t.toISOString(), ...x }].slice(-AUDIT_KEEP); };
  // TF-068: Rechtsprüfung (Owner) – ohne dokumentierte Freigabe gilt BLOCKED_PENDING_LEGAL_REVIEW.
  const legalOf = (ctl) => (ctl?.config?.legal_vn?.status === "APPROVED" ? { status: "APPROVED" } : { status: "BLOCKED_PENDING_LEGAL_REVIEW" });
  // Letzter Werbeanruf je Nummer (Hash) aus Verlauf + laufenden Anrufen; Provider-Ablehnung vor dem Wählen (retry_later) zählt nicht.
  const lastCallIndex = (ctl, history) => {
    const m = new Map();
    for (const c of [...(history?.calls || []), ...Object.values(ctl?.calls || {})]) {
      if (!c.phone_hash || c.retry_later || !c.started_at) continue;
      const ts = Date.parse(c.started_at);
      if (!(m.get(c.phone_hash) >= ts)) m.set(c.phone_hash, ts);
    }
    return m;
  };
  const ctxFor = (l, { consents, dncSet, t, legal, lastIdx }) => ({ consent: consents.leads?.[l.lead_id] || null, dncSet, now: t, legal, lastCallAt: lastIdx.get(phoneHash(e164Of(l))) ?? null });
  // Echte Anrufe zusätzlich nur mit verifizierter VN-Stimme und autorisierter Caller-ID (Decree 91: Anrufer nicht verbergen).
  const realBlockOf = (status) => (status.dry_run ? null : !status.configured.caller_id_vn ? "CALLER_ID_NOT_CONFIGURED" : status.voice_vn !== "VOICE_VERIFIED" ? "VOICE_NOT_VERIFIED" : null);
  /* Autonomous agent pull/event/tool handlers were removed. Human CRM
     calling data remains below: eligibility, history, callbacks, DNC and
     employee-visible status are still read from the calling stores. */
  /*
    const t = now();
    const status = cleanServiceStatus(body.status);
    const known = new Set(Array.isArray(body.active_call_ids) ? body.active_call_ids.filter((x) => typeof x === "string" && ID_RE.test(x)) : []);
    const capacity = Number.isInteger(body.capacity) ? Math.max(0, Math.min(HARD_MAX_CONCURRENCY, body.capacity)) : 0;
    const [leads, asg, history, consents] = await Promise.all([allLeads(), readAssignments(), read("history", emptyHistory), read("consents", emptyConsents)]);
    const byId = new Map(leads.map((l) => [l.lead_id, l]));
    const dncSet = new Set(Object.keys(consents.dnc || {}));
    const reviewed = [];
    const r = await mutate("control", emptyControl, (cur) => {
      cur.service = { seen_at: t.toISOString(), status };
      const cx = { consents, dncSet, t, legal: legalOf(cur), lastIdx: lastCallIndex(cur, history) };
      const elig = (id) => { const l = byId.get(id); return l ? eligibility(l, ctxFor(l, cx)) : eligibility(null); };
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
      // Notstopp: keine neuen Anrufe, bis der Owner ihn aufhebt.
      const halted = cur.config?.halted === true;
      const planned = halted ? { picks: [], waits: [] } : planClaims(cur, { now: t, limits: svc, eligibleNow: (id) => elig(id), phoneOf });
      const realBlock = realBlockOf(status);
      const picks = [], waits = planned.waits;
      for (const p of planned.picks) {
        const camp = cur.campaigns.find((x) => x.campaign_id === p.campaign_id);
        if (!CALLING_MARKETS.includes(camp.market)) { waits.push({ ...p, code: "CH_CALLING_DISABLED", skip: true }); continue; }
        if (realBlock && camp.dry_run !== true) { const it = camp.items.find((x) => x.lead_id === p.lead_id); it.last_code = realBlock; it.next_at = new Date(+t + 15 * 60_000).toISOString(); continue; }
        picks.push(p);
      }
      for (const w of waits) {
        const camp = cur.campaigns.find((x) => x.campaign_id === w.campaign_id);
        const it = camp?.items.find((x) => x.lead_id === w.lead_id);
        if (!it) continue;
        if (w.skip) { it.state = "SKIPPED"; it.last_code = w.code; continue; }
        if (w.code === "DAILY_CAP") { it.last_code = "DAILY_CAP"; it.next_at = new Date(+t + 30 * 60_000).toISOString(); continue; }
        const cb = consents.leads?.[w.lead_id]?.requested_callback?.callback_at;
        it.state = "QUEUE_WAITING_FOR_WINDOW"; it.last_code = w.code;
        const lastAt = w.code === "FREQUENCY_LIMIT_24H" ? cx.lastIdx.get(phoneHash(phoneOf(w.lead_id))) : null;
        const nxt = w.code === "CALLBACK_NOT_DUE" && cb ? new Date(cb)
          : nextWindowStart(camp.market, lastAt ? new Date(lastAt + FREQUENCY_MS) : t, consents.leads?.[w.lead_id]?.window_agreement || null);
        it.next_at = (nxt || new Date(+t + 3_600_000)).toISOString();
      }
      const jobs = [];
      for (const p of picks) {
        const camp = cur.campaigns.find((x) => x.campaign_id === p.campaign_id);
        const it = camp.items.find((x) => x.lead_id === p.lead_id);
        const lead = byId.get(p.lead_id);
        const call_id = newId();
        it.state = "ACTIVE"; it.call_id = call_id; it.attempts = (it.attempts || 0) + 1; it.next_at = null; it.phone_key = p.phone_key;
        const cs = consents.leads?.[p.lead_id] || {};
        const seller = sellerOf(lead, asg);
        const call = { call_id, campaign_id: camp.campaign_id, lead_id: p.lead_id, market: camp.market, seller, seller_id: seller, actor_user_id: camp.owner_user_id,
          dry_run: camp.dry_run === true || status.dry_run, phone_masked: maskPhone(p.phone_key), phone_hash: phoneHash(p.phone_key), status: "QUEUED", started_at: t.toISOString(), last_event_at: t.toISOString(),
          answered_at: null, ended_at: null, duration_s: null, outcome: null, attempt: it.attempts, recording: false,
          consent_evidence_reference: cs.evidence?.consent_evidence_reference || (cs.requested_callback?.call_id ? `callback:${cs.requested_callback.call_id}` : null), tool: {} };
        cur.calls[call_id] = call;
        cx.lastIdx.set(call.phone_hash, +t);
        jobs.push({ call_id, campaign_id: camp.campaign_id, lead_id: p.lead_id, market: camp.market, phone_e164: p.phone_key, dry_run: call.dry_run, attempt: it.attempts,
          max_call_seconds: callSecondsLeft(camp.market, t, cs.window_agreement || null), context: buildLeadContext(lead, history.calls) });
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
      // TF-068: über die CRM-Tools (op tool) serverseitig festgehaltene Ergebnisse haben Vorrang vor einem generischen COMPLETED; DNC schlägt alles.
      const tl = c.tool || {};
      let status = body.retry === true ? "FAILED" : body.status;
      if (tl.dnc) status = "DO_NOT_CALL";
      else if (tl.outcome && ["COMPLETED", "ANSWERED"].includes(status)) status = tl.outcome;
      c.status = status;
      c.outcome = status;
      c.reason = typeof body.reason === "string" && /^[A-Z0-9_]{2,40}$/.test(body.reason) ? body.reason : null;
      c.answered_at = c.answered_at || isoOrNull(body.answered_at);
      c.ended_at = isoOrNull(body.ended_at) || t.toISOString();
      c.duration_s = Number.isInteger(body.duration_s) && body.duration_s >= 0 ? Math.min(body.duration_s, 7200) : c.answered_at ? Math.max(0, Math.round((Date.parse(c.ended_at) - Date.parse(c.answered_at)) / 1000)) : 0;
      c.summary = cleanSummary(body.summary) || tl.summary || null;
      c.short_summary = c.summary;
      c.callback_at = status === "CALLBACK_REQUESTED" ? isoOrNull(body.callback_at) || tl.callback_at || null : null;
      // Kosten nur, wenn der Provider sie liefert (sonst null – nie geschätzt).
      c.cost = body.cost && Number.isFinite(body.cost.amount) && body.cost.amount >= 0 && /^[A-Z]{3}$/.test(String(body.cost.currency || "")) ? { amount: body.cost.amount, currency: body.cost.currency } : null;
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
    if (done.outcome === "DO_NOT_CALL" && !done.tool?.dnc) await applyDnc(done.lead_id, campaignMarket || done.market, done.call_id, t, true); // CRM-DNC folgt unten über crmActionsFor
    if (done.outcome === "CALLBACK_REQUESTED" && done.callback_at && !done.dry_run) {
      await mutate("consents", emptyConsents, (s) => {
        s.leads ||= {};
        s.leads[done.lead_id] = { ...(s.leads[done.lead_id] || {}), requested_callback: { at: t.toISOString(), callback_at: done.callback_at, call_id: done.call_id } };
        return { status: 200 };
      });
    }
    // Simulierte Anrufe (Dry Run) ändern nie das CRM. DNC über das Tool ist bereits sofort ins CRM gegangen.
    const acts = crmActionsFor(done).filter((a) => !(a.action === "crm.setDoNotContact" && done.tool?.dnc));
    done.crm_requests = acts.length ? await enqueueCrm(campaignMarket || done.market, acts, t) : [];
    done.crm_action = acts.map((a) => a.action).join(",") || null;
    await archiveCalls([done]);
    return reply(200, { ok: true, crm_requests: done.crm_requests.length });
  }

  // ----- Dienst/Agent: CRM-Tools (TF-068) – nur aktueller Lead eines AKTIVEN Anrufs, idempotent je idempotency_key, auditiert -----
  async function agentTool(body) {
    const t = now();
    if (typeof body.call_id !== "string" || !ID_RE.test(body.call_id)) return reply(400, { error: "call_id ungültig.", code: "BAD_CALL_ID" });
    const v = validateToolCall(body, { now: t });
    if (!v.ok) return reply(v.status, { error: v.code, code: v.code });
    const p = v.params;
    const [leads, history] = body.tool === "get_current_lead" ? await Promise.all([allLeads(), read("history", emptyHistory)]) : [null, null];
    let dnc = null;
    const actorId = "system:calling-agent";
    const r = await mutate("control", emptyControl, (cur) => {
      const c = cur.calls[body.call_id];
      if (!c) return { status: 404, body: { error: "Kein aktiver Anruf.", code: "CALL_NOT_ACTIVE" }, readOnly: true };
      if (c.lead_id !== body.lead_id) {
        audit(cur, t, { actor_user_id: actorId, action: `tool.${body.tool}`, call_id: c.call_id, lead_id: body.lead_id, result: "denied", code: "CROSS_LEAD" });
        return { status: 403, body: { error: "Nur der Lead dieses Anrufs.", code: "CROSS_LEAD" } };
      }
      c.tool ||= {}; c.tool.log ||= {};
      const prev = c.tool.log[body.idempotency_key];
      if (prev) return prev.tool === body.tool ? { status: 200, body: { ok: true, idempotent: true, outcome: c.tool.outcome || null }, readOnly: true } : { status: 409, body: { error: "idempotency_key bereits verwendet.", code: "IDEMPOTENCY_CONFLICT" }, readOnly: true };
      if (body.tool === "get_current_lead") {
        const l = leads.find((x) => x.lead_id === c.lead_id);
        return { status: 200, body: { ok: true, lead: l ? { ...buildLeadContext(l, history.calls), issue_links: callIssueLinks(l, 5) } : null }, readOnly: true };
      }
      const tl = c.tool;
      const setOutcome = (o) => { if (!tl.dnc) tl.outcome = o; };
      if (p.summary) tl.summary = p.summary;
      if (body.tool === "record_call_outcome") { if (p.outcome === "DO_NOT_CALL") tl.dnc = true; setOutcome(p.outcome); }
      if (body.tool === "mark_interested") setOutcome("INTERESTED");
      if (body.tool === "mark_not_interested") setOutcome("NOT_INTERESTED");
      if (body.tool === "request_callback") { setOutcome("CALLBACK_REQUESTED"); if (!tl.dnc) tl.callback_at = p.callback_at; }
      if (body.tool === "mark_do_not_call") { tl.dnc = true; tl.outcome = "DO_NOT_CALL"; }
      if (tl.dnc && !tl.dnc_applied) { tl.dnc_applied = t.toISOString(); tl.outcome = "DO_NOT_CALL"; dnc = { lead_id: c.lead_id, market: c.market, call_id: c.call_id, dry: !!c.dry_run }; }
      const keys = Object.keys(tl.log);
      if (keys.length >= 50) delete tl.log[keys[0]];
      tl.log[body.idempotency_key] = { tool: body.tool, at: t.toISOString() };
      audit(cur, t, { actor_user_id: actorId, action: `tool.${body.tool}`, call_id: c.call_id, lead_id: c.lead_id, result: "success", outcome: tl.outcome || null });
      return { status: 200, body: { ok: true, outcome: tl.outcome || null } };
    });
    if (r.status === 200 && dnc) await applyDnc(dnc.lead_id, dnc.market, dnc.call_id, t, dnc.dry);
    return reply(r.status, r.body);
  }
  */

  return async (req) => {
    await migrateIdentity();
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.has("probe")) return reply(410, { error: "Autonome Telefonie ist entfernt.", code: "AUTONOMOUS_CALLING_REMOVED" });
    const isAgent = false;
    let actor = null;
    if (!isAgent) {
      const r = await resolveActor(req, { env, getAuthStore, now });
      if (!r.actor) return deny(r);
      actor = r.actor;
      if (!canUseCalling(actor)) return forbidden("Kein Zugang zu den CRM-Anrufdaten.");
    }
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    const limit = MAX_BODY;
    if (Number(req.headers.get("content-length") || 0) > limit) return reply(413, { error: "Zu gross." });
    let body = {};
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > limit) return reply(413, { error: "Zu gross." });
      try { body = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Ungültige Anfrage." });
    }


    // ----- Browser (Chris / Kudoshin) -----
    const owner = isOwner(actor);
    const t = now();
    const [ctl, history, consents, leads, asg] = await Promise.all([read("control", emptyControl), read("history", emptyHistory), read("consents", emptyConsents), allLeads(), readAssignments()]);
    const byId = new Map(leads.map((l) => [l.lead_id, l]));
    // Human calling follows the existing CRM assignment scope in both markets.
    // The old VN-only restriction belonged to the removed autonomous agent.
    const inScope = (l) => !!l && canSeeLead(actor, l, asg);
    const marketsOf = actor.role === "OWNER" ? ["CH", "VN"] : [...(actor.markets || [])];
    const visibleCall = (c) => marketsOf.includes(c.market) && (owner || inScope(byId.get(c.lead_id)));
    const manualCalls = manualCallsFromLeads(leads.filter(inScope));
    const visibleManualCalls = manualCalls.filter((c) => visibleCall(c));
    const svc = serviceView(ctl, t);
    const lim = limitsOf(ctl);
    const today = callsToday(ctl, history, t);
    const legal = legalOf(ctl);
    const halted = ctl.config?.halted === true;
    const dncSet = new Set(Object.keys(consents.dnc || {}));
    const cx = { consents, dncSet, t, legal, lastIdx: lastCallIndex(ctl, history) };
    const ctxOf = (l) => ctxFor(l, cx);
    const pubCall = (c) => ({ call_id: c.call_id, campaign_id: c.campaign_id, lead_id: c.lead_id, company: byId.get(c.lead_id)?.company || null, market: c.market,
      seller: c.seller || null, seller_id: c.seller_id || c.seller || null, phone: c.phone_masked, status: c.status, outcome: c.outcome || null, started_at: c.started_at, answered_at: c.answered_at || null,
      ended_at: c.ended_at || null, duration_s: c.duration_s ?? null, callback_at: c.callback_at || null, summary: c.summary || null, short_summary: c.summary || null, dry_run: !!c.dry_run,
      review_required: !!c.review_required, transfer: c.transfer || null, attempt: c.attempt || 1, consent_evidence_reference: c.consent_evidence_reference || null, cost: c.cost || null });
    const canStart = () => ({ ok: false, code: "AUTONOMOUS_CALLING_REMOVED" });

    if (req.method === "GET") {
      const leadId = url.searchParams.get("lead");
      if (leadId) {
        if (!LEAD_ID_RE.test(leadId)) return reply(400, { error: "lead ungültig." });
        const l = byId.get(leadId);
        if (!l) return reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" });
        if (!inScope(l)) return reply(403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: "OUT_OF_SCOPE" });
        const calls = [...history.calls, ...Object.values(ctl.calls), ...visibleManualCalls].filter((c) => c.lead_id === leadId).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
        const last = calls.at(-1) || null;
        const cs = consents.leads?.[leadId] || {};
        const e = eligibility(l, ctxOf(l));
        return reply(200, { lead_id: leadId, market: leadMarket(l), eligibility: { decision: e.decision, bucket: e.bucket, code: e.code, basis: e.basis }, call_flag: callFlag(e), list: leadList(e),
          consent: cs.evidence ? { consent_status: cs.evidence.revoked_at ? "REVOKED" : cs.evidence.consent_status, consent_source: cs.evidence.consent_source, consent_timestamp: cs.evidence.consent_timestamp,
            consent_scope: cs.evidence.consent_scope, consent_evidence_reference: cs.evidence.consent_evidence_reference, verified_at: cs.evidence.verified_at, revoked_at: cs.evidence.revoked_at || null } : null,
          dnc_registry: cs.dnc_registry ? { result: cs.dnc_registry.result, checked_at: cs.dnc_registry.checked_at } : null,
          last_call: last ? pubCall(last) : null, attempts: calls.filter((c) => !c.dry_run).length, next_callback: cs.requested_callback?.callback_at || null,
          dnc: !!(consents.dnc?.[leadId]), calls: calls.slice(-10).reverse().map(pubCall), recording: "OFF", can_start_calls: canStartCalls(actor),
          website: l.website || null, domain: l.domain || null, issues: callIssueLinks(l) });
      }
      // Leadlisten (TF-068): ALL_LEADS · CALL_ELIGIBLE_LEADS · CALL_BLOCKED_LEADS · DO_NOT_CONTACT – nur im eigenen Scope, nur VN.
      if (url.searchParams.get("view") === "lists") {
        const want = url.searchParams.get("list") || "ALL_LEADS";
        if (!LEAD_LISTS.includes(want)) return reply(400, { error: "list ungültig." });
        const rows = leads.filter(inScope).map((l) => { const e = eligibility(l, ctxOf(l)); return { lead_id: l.lead_id, company: l.company || null, list: leadList(e), call_flag: callFlag(e), code: e.code }; });
        const counts = Object.fromEntries(LEAD_LISTS.map((k) => [k, k === "ALL_LEADS" ? rows.length : rows.filter((x) => x.list === k).length]));
        return reply(200, { list: want, counts, leads: (want === "ALL_LEADS" ? rows : rows.filter((x) => x.list === want)).slice(0, 500) });
      }
      // Rückrufe im eigenen Scope (Kudoshin: eigene; Owner: alle VN).
      if (url.searchParams.get("view") === "callbacks") {
        const manualCallbacks = visibleManualCalls.filter((c) => c.outcome === "CALLBACK_REQUESTED" && c.callback_at && !consents.dnc?.[c.lead_id])
          .map((c) => ({ lead_id: c.lead_id, company: c.company, callback_at: c.callback_at, call_id: c.call_id }));
        const list = Object.entries(consents.leads || {}).filter(([id, x]) => x?.requested_callback?.callback_at && !consents.dnc?.[id] && inScope(byId.get(id)))
          .map(([id, x]) => ({ lead_id: id, company: byId.get(id)?.company || null, callback_at: x.requested_callback.callback_at, call_id: x.requested_callback.call_id || null }))
          .concat(manualCallbacks).sort((a, b) => a.callback_at.localeCompare(b.callback_at));
        return reply(200, { callbacks: list.slice(0, 200) });
      }
      const campaigns = ctl.campaigns.filter((c) => marketsOf.includes(c.market) && (owner || c.owner_user_id === actor.user_id))
        .slice(-20).reverse().map((c) => ({ campaign_id: c.campaign_id, market: c.market, mode: c.mode, concurrency: c.concurrency, status: c.status, dry_run: !!c.dry_run,
          owner_user_id: c.owner_user_id, created_at: c.created_at, planned: c.items.length,
          counts: Object.fromEntries(["QUEUED", "ACTIVE", "DONE", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW", "CALL_STATE_REVIEW_REQUIRED", "SKIPPED", "CANCELLED"].map((s) => [s, c.items.filter((i) => i.state === s).length])) }));
      const d = zurichDay(t);
      const todays = [...history.calls, ...visibleManualCalls].filter((c) => visibleCall(c) && c.started_at && zurichDay(new Date(c.started_at)) === d);
      const n = (f) => todays.filter(f).length;
      const queue = ctl.campaigns.filter((c) => marketsOf.includes(c.market) && ["RUNNING", "PAUSED"].includes(c.status))
        .reduce((s, c) => s + c.items.filter((i) => ["QUEUED", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW"].includes(i.state)).length, 0);
      const active = Object.values(ctl.calls).filter(visibleCall);
      // Kosten nur aus Provider-Daten, je Währung getrennt; ohne Daten → NO_PROVIDER_DATA (nie geschätzt).
      const costs = {};
      for (const c of todays) if (c.cost) costs[c.cost.currency] = Math.round(((costs[c.cost.currency] || 0) + c.cost.amount) * 10_000) / 10_000;
      const svcOut = { ...svc };
      return reply(200, { actor: { user_id: actor.user_id, role: actor.role, locale: actor.locale, markets: marketsOf, can_start_calls: canStartCalls(actor) }, service: svcOut,
        legal: { VN: legal.status, ...(owner ? { reference: ctl.config?.legal_vn?.reference || null, at: ctl.config?.legal_vn?.at || null } : {}) },
        emergency_stop: { active: halted, ...(owner ? { at: ctl.config?.halted_at || null, reason: ctl.config?.halted_reason || null } : {}) },
        limits: { default_concurrency: svc.default_concurrency, max_concurrency: svc.max_concurrency, daily_call_cap: lim.daily_call_cap, max_campaign_size: lim.max_campaign_size,
          calls_today: today, remaining_today: Math.max(0, lim.daily_call_cap - today), owner_can_configure: owner },
        can_start: Object.fromEntries(marketsOf.map((m) => [m, canStartCalls(actor) ? canStart(m) : { ok: false, code: "OWNER_MONITOR_ONLY" }])),
        stats_today: { active: active.length, queued: queue, called: todays.length, reached: n((c) => REACHED_OUTCOMES.includes(c.outcome)), no_answer: n((c) => NO_ANSWER_OUTCOMES.includes(c.outcome)),
          interested: n((c) => c.outcome === "INTERESTED"), callbacks: n((c) => c.outcome === "CALLBACK_REQUESTED"), dnc: n((c) => c.outcome === "DO_NOT_CALL"), errors: n((c) => c.outcome === "FAILED"),
          review_required: n((c) => c.review_required), costs: Object.keys(costs).length ? costs : "NO_PROVIDER_DATA" },
        active_calls: active.map(pubCall), recent_calls: [...history.calls, ...visibleManualCalls].filter(visibleCall).slice(-20).reverse().map(pubCall), campaigns,
        ...(owner ? { audit: (ctl.audit || []).slice(-30).reverse() } : {}) });
    }

    const v = validateUserOp(body);
    if (!v.ok) return reply(v.status, { error: v.error, code: v.code });
    const p = v.params;
    if (OWNER_OPS.has(p.op) && !owner) return forbidden("Nur der Owner darf das ändern.");
    if (p.op === "config.set") {
      const r = await mutate("control", emptyControl, (cur) => {
        cur.config = { ...(cur.config || {}), ...(p.daily_call_cap !== undefined ? { daily_call_cap: p.daily_call_cap } : {}), ...(p.max_campaign_size !== undefined ? { max_campaign_size: p.max_campaign_size } : {}),
          updated_at: t.toISOString(), updated_by: actor.user_id };
        audit(cur, t, { actor_user_id: actor.user_id, action: "config.set", daily_call_cap: cur.config.daily_call_cap ?? null, max_campaign_size: cur.config.max_campaign_size ?? null, result: "success" });
        return { status: 200, body: { limits: limitsOf(cur) } };
      });
      return reply(r.status, r.body);
    }
    // Notstopp (Owner): alle laufenden Kampagnen stoppen, aktive Gespräche beenden, neue Anrufe sperren bis zur Aufhebung.
    if (p.op === "emergency.stop" || p.op === "emergency.release") {
      const r = await mutate("control", emptyControl, (cur) => {
        cur.config ||= {};
        if (p.op === "emergency.stop") {
          cur.config.halted = true; cur.config.halted_at = t.toISOString(); cur.config.halted_reason = p.reason;
          for (const c of cur.campaigns) if (["RUNNING", "PAUSED"].includes(c.status)) {
            c.status = "STOPPED"; c.stopped_at = t.toISOString();
            for (const it of c.items) if (["QUEUED", "RETRY_LATER", "QUEUE_WAITING_FOR_WINDOW"].includes(it.state)) { it.state = "CANCELLED"; it.last_code = "EMERGENCY_STOP"; }
          }
          for (const id of Object.keys(cur.calls)) cur.commands.push({ type: "hangup", call_id: id, at: t.toISOString() });
        } else { cur.config.halted = false; cur.config.released_at = t.toISOString(); }
        audit(cur, t, { actor_user_id: actor.user_id, action: p.op, reason: p.reason, result: "success" });
        return { status: 200, body: { emergency_stop: cur.config.halted, hangups: p.op === "emergency.stop" ? Object.keys(cur.calls).length : 0 } };
      });
      return reply(r.status, r.body);
    }
    if (p.op === "legal.set") {
      const r = await mutate("control", emptyControl, (cur) => {
        cur.config = { ...(cur.config || {}), legal_vn: { status: p.status, reference: p.reference, at: t.toISOString(), by: actor.user_id } };
        audit(cur, t, { actor_user_id: actor.user_id, action: "legal.set", status: p.status, reference: p.reference, result: "success" });
        return { status: 200, body: { legal: { VN: p.status } } };
      });
      return reply(r.status, r.body);
    }
    // Einwilligungsnachweis / Widerruf / DNC-Register: nur VN-Leads im Scope; Telefonnummer setzt der Server aus dem Lead.
    if (["consent.record", "consent.revoke", "dnc_registry.record"].includes(p.op)) {
      const l = byId.get(p.lead_id);
      if (!l) return reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" });
      if (!inScope(l)) return reply(403, { error: "Dieser Lead gehört nicht zu Ihrem Bereich.", code: "OUT_OF_SCOPE" });
      const phone = e164Of(l);
      if (p.op === "consent.record" && !phone) return reply(409, { error: "Lead ohne gültige VN-Telefonnummer.", code: "NO_PHONE" });
      if (p.op === "consent.record" && Date.parse(p.consent_timestamp) > +t) return reply(400, { error: "consent_timestamp liegt in der Zukunft.", code: "CONSENT_TIMESTAMP_INVALID" });
      const r = await mutate("consents", emptyConsents, (s) => {
        s.leads ||= {}; s.audit ||= [];
        const x = s.leads[p.lead_id] || {};
        if (p.op === "consent.record") {
          if (x.evidence && !x.evidence.revoked_at && x.evidence.consent_evidence_reference === p.consent_evidence_reference) return { status: 200, body: { ok: true, idempotent: true }, readOnly: true };
          x.evidence = { lead_id: p.lead_id, market: "VN", phone, consent_status: p.consent_status, consent_source: p.consent_source, consent_timestamp: p.consent_timestamp,
            consent_scope: p.consent_scope, consent_evidence_reference: p.consent_evidence_reference, verified_at: t.toISOString(), verified_by: actor.user_id, revoked_at: null };
        } else if (p.op === "consent.revoke") {
          if (!x.evidence || x.evidence.revoked_at) return { status: 404, body: { error: "Keine aktive Einwilligung.", code: "NO_ACTIVE_CONSENT" }, readOnly: true };
          x.evidence = { ...x.evidence, revoked_at: t.toISOString(), revoked_by: actor.user_id, revoke_reason: p.reason };
        } else x.dnc_registry = { result: p.registry_result, checked_at: t.toISOString(), reference: p.reference, by: actor.user_id };
        s.leads[p.lead_id] = x;
        s.audit = [...s.audit, { ts: t.toISOString(), actor_user_id: actor.user_id, action: p.op, lead_id: p.lead_id, result: "success" }].slice(-AUDIT_KEEP);
        return { status: 200, body: { ok: true } };
      });
      if (r.status === 200 && p.op === "consent.revoke") {
        // Widerruf wirkt sofort: offene Positionen dieses Leads entfernen.
        await mutate("control", emptyControl, (cur) => { for (const k of cur.campaigns) for (const it of k.items) if (it.lead_id === p.lead_id && !["ACTIVE", "DONE", "CANCELLED"].includes(it.state)) { it.state = "CANCELLED"; it.last_code = "CONSENT_REVOKED"; } return { status: 200 }; });
      }
      return reply(r.status, r.body);
    }
    if (p.market && !marketsOf.includes(p.market)) return reply(403, { error: p.market === "CH" ? "CH-Calling ist deaktiviert." : "Markt nicht in Ihrem Bereich.", code: p.market === "CH" ? "CH_CALLING_DISABLED" : "OUT_OF_SCOPE" });
    // Start nur durch Kudoshin. Chris (OWNER) überwacht nur – keine eigenen Anrufkampagnen.
    if ((p.op === "campaign.start" || p.op === "call.start") && !canStartCalls(actor)) return forbidden("Der Owner überwacht nur – Kampagnen startet ausschliesslich Kudoshin.");

    // Kandidaten: Leads im Scope + Markt (+ optional Priorität / ausgewählte Leads), nach Priorität.
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
      const { counts, eligible } = previewCounts(sel, ctxOf);
      const free = eligible.filter((id) => !busyLeads.has(id));
      const dry = svc.dry_run;
      const remaining = dry ? Infinity : Math.max(0, lim.daily_call_cap - today);
      const planned = Math.min(free.length, lim.max_campaign_size, remaining);
      return { counts, planned, ids: free.slice(0, planned), already_queued: eligible.length - free.length, dry_run: dry };
    };

    if (p.op === "campaign.preview") {
      const s = pickLeads(p.market, p);
      if (s.error) return s.error;
      const pl = planFor(p.market, s.leads);
      return reply(200, { market: p.market, ...pl.counts, planned_max_calls: pl.planned, already_queued: pl.already_queued, dry_run: pl.dry_run,
        daily_call_cap: lim.daily_call_cap, calls_today: today, max_campaign_size: lim.max_campaign_size, max_concurrency: svc.max_concurrency, can_start: canStart(p.market) });
    }
    if (p.op === "campaign.start" || p.op === "call.start") {
      // call.start ist nur noch ein historischer API-Name. Es gibt keinen
      // Worker/Provider-Konsumenten mehr; daher wird kein Anruf eingeplant.
      return reply(410, { error: "Autonome Telefonie ist entfernt.", code: "AUTONOMOUS_CALLING_REMOVED" });
      /* const market = p.op === "call.start" ? leadMarket(byId.get(p.lead_id) || {}) : p.market;
      if (p.op === "call.start" && !byId.get(p.lead_id)) return reply(404, { error: "Unbekannter Lead.", code: "UNKNOWN_LEAD" });
      if (!marketsOf.includes(market)) return reply(403, { error: "Markt nicht in Ihrem Bereich.", code: "OUT_OF_SCOPE" });
      const s = pickLeads(market, p);
      if (s.error) return s.error;
      if (p.confirmed !== true) return reply(400, { error: "Ausdrückliche Bestätigung fehlt.", code: "CONFIRMATION_REQUIRED" });
      const cs = canStart(market);
      if (!cs.ok) return reply(409, { error: "Autonome Telefonie ist entfernt.", code: cs.code });
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
      return reply(r.status, r.body); */
    }
    // pause / resume / stop / cancel – nur eigene Kampagnen (Kudoshin) bzw. alle (Owner); Markt im Scope.
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
