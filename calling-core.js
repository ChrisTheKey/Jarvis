// Gemeinsamer CRM-Kern für menschliche Vertriebsanrufe.
// Keine Provider-, Worker-, Modell- oder autonome Agentensteuerung.
import { createHash } from "node:crypto";
import { crmActive } from "./public/crm-model.js";

export const SCHEMA = 1;
export const MARKETS = Object.freeze(["CH", "VN"]);
export const CALLING_MARKETS = Object.freeze(["VN"]);
export const FREQUENCY_MS = 24 * 3_600_000;
export const DNC_REGISTRY_MAX_AGE_MS = 30 * 86_400_000;
export const CONSENT_SOURCES = Object.freeze(["WRITTEN_FORM", "EMAIL_REPLY", "WEB_FORM_DOUBLE_OPT_IN", "SMS_REPLY", "CUSTOMER_CONTRACT", "RECORDED_CALLBACK_REQUEST"]);
export const CONSENT_SCOPE = "ADVERTISING_CALLS";
export const CONSENT_FIELDS = Object.freeze(["lead_id", "market", "phone", "consent_status", "consent_source", "consent_timestamp", "consent_scope", "consent_evidence_reference", "verified_at", "revoked_at"]);
export const LEGAL_STATES = Object.freeze(["BLOCKED_PENDING_LEGAL_REVIEW", "APPROVED"]);
export const CALL_OUTCOMES = Object.freeze(["QUEUED", "DIALING", "RINGING", "ANSWERED", "COMPLETED", "NO_ANSWER", "BUSY", "VOICEMAIL", "INTERESTED", "CALLBACK_REQUESTED", "NOT_INTERESTED", "DO_NOT_CALL", "TRANSFERRED", "FAILED", "CANCELLED"]);
export const LIVE_OUTCOMES = Object.freeze(["QUEUED", "DIALING", "RINGING", "ANSWERED"]);
export const FINAL_OUTCOMES = Object.freeze(CALL_OUTCOMES.filter((x) => !LIVE_OUTCOMES.includes(x)));
export const REACHED_OUTCOMES = Object.freeze(["COMPLETED", "INTERESTED", "CALLBACK_REQUESTED", "NOT_INTERESTED", "DO_NOT_CALL", "TRANSFERRED"]);
export const NO_ANSWER_OUTCOMES = Object.freeze(["NO_ANSWER", "BUSY", "VOICEMAIL"]);
export const MODES = Object.freeze(["SINGLE", "SEQUENTIAL", "PARALLEL"]);
export const HARD_MAX_CONCURRENCY = 5;
export const DEFAULTS = Object.freeze({ default_concurrency: 1, max_concurrency: 5, daily_call_cap: 50, max_campaign_size: 50 });
export const LIMIT_BOUNDS = Object.freeze({ daily_call_cap: [0, 500], max_campaign_size: [1, 200] });
export const FORBIDDEN_CLIENT_FIELDS = Object.freeze(["phone", "phone_tel", "number", "to", "caller_id", "from", "from_number", "trunk", "trunk_id", "sip_trunk_id", "room", "room_name", "agent", "agent_name", "transfer_to", "transfer_number", "sip", "uri", "force", "override", "skip_eligibility"]);
export const TZ = Object.freeze({ CH: "Europe/Zurich", VN: "Asia/Ho_Chi_Minh" });
export const WINDOWS = Object.freeze({ VN: { from: 480, to: 1020, days: null }, CH: { from: 480, to: 1080, days: ["Mon", "Tue", "Wed", "Thu", "Fri"] } });

const partsIn = (d, tz) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(d).map((x) => [x.type, x.value]));
export const zurichDay = (d) => { const p = partsIn(d, TZ.CH); return `${p.year}-${p.month}-${p.day}`; };
const validIso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
export const isoOrNull = (v) => validIso(v) ? new Date(v).toISOString() : null;
export const phoneHash = (p) => createHash("sha256").update(String(p || "")).digest("hex").slice(0, 24);
export const e164Of = (lead) => { const m = /^tel:(\+\d{8,15})$/.exec(String(lead?.phone_tel || "")); if (!m) return null; const ok = lead?.market === "VN" ? /^\+84\d{9,10}$/.test(m[1]) : /^\+41\d{9}$/.test(m[1]); return ok ? m[1] : null; };
export const maskPhone = (p) => /^\+\d{8,15}$/.test(String(p || "")) ? `${p.slice(0, 3)}*******${p.slice(-2)}` : "–";
export const callFlag = (e) => e?.bucket === "BLOCKED_DNC" ? "DO_NOT_CONTACT" : e?.decision === "ALLOWED" || e?.decision === "WAITING" ? "CALL_ALLOWED" : "CALL_BLOCKED";
export const leadList = (e) => e?.bucket === "BLOCKED_DNC" ? "DO_NOT_CONTACT" : e?.decision === "ALLOWED" || e?.decision === "WAITING" ? "CALL_ELIGIBLE_LEADS" : "CALL_BLOCKED_LEADS";

export function inCallWindow(market, now) {
  const w = WINDOWS[market]; if (!w) return false;
  const p = partsIn(now, TZ[market]);
  return (!w.days || w.days.includes(p.weekday)) && Number(p.hour) * 60 + Number(p.minute) >= w.from && Number(p.hour) * 60 + Number(p.minute) < w.to;
}
export const canStartCallAt = (market, now) => inCallWindow(market, now);

export function isDnc(lead, consent, dncSet) { return !!(lead?.do_not_contact || lead?.dnc_source || lead?.call_status === "DO_NOT_CALL" || lead?.sales_stage === "DO_NOT_CONTACT" || consent?.blocked || consent?.dnc || dncSet?.has?.(lead?.lead_id)); }
export function validateConsentEvidence(ev, lead, now = new Date()) {
  if (!ev || ev.revoked_at || ev.lead_id !== lead?.lead_id || ev.market !== "VN" || ev.phone !== e164Of(lead) || ev.consent_status !== "GRANTED") return { ok: false, code: "CALL_CONSENT_UNKNOWN" };
  if (CONSENT_FIELDS.some((k) => k !== "revoked_at" && (ev[k] == null || ev[k] === "")) || !CONSENT_SOURCES.includes(ev.consent_source) || !(Array.isArray(ev.consent_scope) ? ev.consent_scope : [ev.consent_scope]).includes(CONSENT_SCOPE) || !validIso(ev.consent_timestamp) || !validIso(ev.verified_at) || Date.parse(ev.consent_timestamp) > +now) return { ok: false, code: "CONSENT_EVIDENCE_INCOMPLETE" };
  return { ok: true, code: "CONSENT_VERIFIED" };
}
export function eligibility(lead, { consent = null, dncSet = null, now = new Date(), legal = null, lastCallAt = null } = {}) {
  const result = (decision, bucket, code, basis = null) => ({ decision, bucket, code, basis });
  if (!lead) return result("BLOCKED", "BLOCKED_OTHER", "UNKNOWN_LEAD");
  if (lead.is_test || lead.contact_form?.is_test || /^test-cf-/.test(String(lead.lead_id || ""))) return result("BLOCKED", "BLOCKED_OTHER", "TEST_BLOCKED");
  if (isDnc(lead, consent, dncSet)) return result("BLOCKED", "BLOCKED_DNC", "DNC");
  if (!crmActive(lead)) return result("BLOCKED", "BLOCKED_OTHER", "NO_VERIFIED_ERRORS");
  if (!CALLING_MARKETS.includes(lead.market)) return result("BLOCKED", "BLOCKED_OTHER", "CH_CALLING_DISABLED");
  if (!e164Of(lead)) return result("BLOCKED", "BLOCKED_OTHER", "NO_PHONE");
  const evidence = validateConsentEvidence(consent?.evidence, lead, now);
  const callback = consent?.requested_callback?.call_id ? consent.requested_callback : null;
  const basis = evidence.ok ? "CONSENT" : callback ? "REQUESTED_CALLBACK" : null;
  if (!basis) return result("BLOCKED", "BLOCKED_CONSENT", "CALL_CONSENT_UNKNOWN");
  if (consent?.dnc_registry?.result !== "NOT_LISTED" || !validIso(consent?.dnc_registry?.checked_at) || +now - Date.parse(consent.dnc_registry.checked_at) > DNC_REGISTRY_MAX_AGE_MS) return result("BLOCKED", "BLOCKED_DNC", "DNC_REGISTRY_NOT_CHECKED", basis);
  if (legal?.status !== "APPROVED") return result("BLOCKED", "BLOCKED_LEGAL", "BLOCKED_PENDING_LEGAL_REVIEW", basis);
  if (Number.isFinite(lastCallAt) && +now - lastCallAt < FREQUENCY_MS) return result("WAITING", "BLOCKED_FREQUENCY", "FREQUENCY_LIMIT_24H", basis);
  return inCallWindow(lead.market, now) ? result("ALLOWED", "CALL_ALLOWED", "CALL_ALLOWED", basis) : result("WAITING", "BLOCKED_TIME_WINDOW", "WAITING_FOR_ALLOWED_HOURS", basis);
}
export function previewCounts(leads, ctxOf) { const counts = { leads_in_filter: 0, phone_present: 0, CALL_ALLOWED: 0, BLOCKED_CONSENT: 0, BLOCKED_DNC: 0, BLOCKED_TIME_WINDOW: 0, BLOCKED_FREQUENCY: 0, BLOCKED_LEGAL: 0, BLOCKED_DIRECTORY: 0, BLOCKED_OTHER: 0, review_required: 0 }; const eligible = []; for (const lead of leads) { counts.leads_in_filter++; if (e164Of(lead)) counts.phone_present++; const e = eligibility(lead, ctxOf(lead)); counts[e.bucket]++; if (e.decision === "ALLOWED" || e.decision === "WAITING") eligible.push(lead.lead_id); } return { counts, allowed: eligible, eligible }; }
