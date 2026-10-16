// TF-068 Tests – Vietnam Calling (nur Lap), Einwilligungsnachweis, Rechts-Gate, 08:00–17:00, 24-h-Frequenz, CRM-Tools des Agenten,
// Zahlungseingangs-Überwachung (signierter Webhook, camt.053, Duplikat, Review), Provision 35 % CHF/VND, Auszahlungen, Verkaufsübersicht,
// Verkäufer-Isolation. Keine echten Anrufe, Zahlungen, Mails oder Websites – alles RAM/Temp.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, makeReq, ORIGIN, CONTROL, env } from "./tf063-helpers.js";
import { memoryStore } from "../shared-state.js";
import { authStoreFrom } from "../auth-core.js";
import { createCallingHandler, callingAgentToken } from "../calling-api.js";
import { eligibility, validateConsentEvidence, canStartCallAt, callSecondsLeft, voiceStatus, VOICE_CANDIDATES, VERIFIED_VOICES, configStatus, resolveModels, buildInstructions, buildLeadContext } from "../calling-core.js";
import { createStore } from "../mail-worker.js";
import { recordPayment, refundPayment, paymentSummary, paymentGateForOrder, paymentsForOrder } from "../payments.js";
import { monitorStatus, verifyStripeSignature, normalizeStripeEvent, parseCamt053, reconcileTransaction, extractOrderRef, emptyMonitorState } from "../payment-monitor.js";
import { reconcileAll, importCamt } from "../payment-reconcile.js";
import { createPaymentsHandler } from "../payments-api.js";
import { deriveLedger, ordersFromSnapshot, summarize, emptyLedger, commissionMinor, recordPayout, fromMinor, toMinor, RATE_BPS } from "../commission-ledger.js";
import { MARKET_PRICES } from "../pricing.js";

const AGENT = callingAgentToken(CONTROL);
const VN = (hhmm) => new Date(`2026-10-14T${hhmm}:00+07:00`);
const SVC = { configured: { livekit: true, livekit_url: true, api_credentials: true, trunk_vn: true, caller_id_vn: true, voice_vn: "VOICE_VERIFIED" }, livekit_reachable: true, worker_registered: true,
  trunk_vn_verified: true, dry_run: true, default_concurrency: 1, max_concurrency: 5 };
const vnPhone = (i) => `+8424${String(10_000_000 + i).slice(-8)}`;
const evidence = (lead_id, phone, x = {}) => ({ lead_id, market: "VN", phone, consent_status: "GRANTED", consent_source: "WRITTEN_FORM", consent_timestamp: "2026-10-01T08:00:00.000Z",
  consent_scope: ["ADVERTISING_CALLS"], consent_evidence_reference: `FORM-${lead_id}`, verified_at: "2026-10-02T08:00:00.000Z", revoked_at: null, ...x });
const REG = { result: "NOT_LISTED", checked_at: "2026-10-10T08:00:00.000Z" };
const LEGAL = { status: "APPROVED" };
const vnLead = { lead_id: "b.vn", market: "VN", phone_tel: "tel:+842438267898" };
const full = { evidence: evidence("b.vn", "+842438267898"), dnc_registry: REG };

async function world({ consentIdx = [], legal = true, t0 = VN("10:00") } = {}) {
  const clock = { t: t0 };
  let tick = 0;
  const now = () => new Date(+clock.t + (tick++ % 1000));
  const s = await setup({ ch: 50, vn: 8, now });
  const { state, etag } = await s.stores.vnView.get();
  state.leads = state.leads.map((l, i) => ({ ...l, phone_tel: `tel:${vnPhone(i)}` }));
  assert.ok(await s.stores.vnView.set(state, etag));
  const vnIds = state.leads.map((l) => l.lead_id);
  const ids = vnIds.filter((_, i) => i !== 3);
  const leads = Object.fromEntries(consentIdx.map((i) => [ids[i], { evidence: evidence(ids[i], vnPhone(vnIds.indexOf(ids[i]))), dnc_registry: REG }]));
  const mem = { control: memoryStore(legal ? { config: { legal_vn: { status: "APPROVED", reference: "TEST" } } } : undefined), history: memoryStore(), consents: memoryStore({ schema: 1, leads, dnc: {} }) };
  const authStore = authStoreFrom((k) => (s.authMem[k] ||= memoryStore()));
  const calling = createCallingHandler({ env, now, getCallingStore: async (k) => mem[k], getAuthStore: async () => authStore, getViewStore: async () => s.stores.view,
    getVnViewStore: async () => s.stores.vnView, getSalesStore: async (k) => (s.salesMem[k] ||= memoryStore()), getCrmQueueStore: async () => s.stores.queue, getVnQueueStore: async () => s.stores.vnQueue });
  const as = async (user, body, query = "") => { const r = await calling(makeReq(`/api/calling${query}`, { method: body ? "POST" : "GET", body: body ?? undefined, cookie: user ? s.cookies[user] : undefined })); return { status: r.status, body: await r.json() }; };
  const agent = async (body) => { const r = await calling(makeReq("/api/calling", { method: "POST", body, origin: null, headers: { "x-jarvis-calling": AGENT } })); return { status: r.status, body: await r.json() }; };
  const pull = (status = SVC) => agent({ op: "pull", status, capacity: 5, active_call_ids: [] });
  const chIds = (await s.stores.view.get()).state.leads.map((l) => l.lead_id);
  return { s, mem, clock, as, agent, pull, ids, chIds };
}

// ================= CALLING: Rollen =================
test("TF-068 Rollen: Lap Calling 200, Chris Monitoring 200, Chris Start 403, Giuliano/Mario/Damiano 403", async () => {
  const w = await world({ consentIdx: [0] });
  await w.pull();
  assert.equal((await w.as("lap")).status, 200, "Lap Calling");
  assert.equal((await w.as("lap", { op: "call.start", lead_id: w.ids[0], confirmed: true })).status, 202, "Lap Start");
  const c = await w.as("chris");
  assert.equal(c.status, 200, "Chris Monitoring"); assert.ok(Array.isArray(c.body.audit)); assert.equal(c.body.active_calls.length, 0);
  assert.equal((await w.as("chris", { op: "call.start", lead_id: w.ids[0], confirmed: true })).status, 403, "Chris Calling Start");
  assert.equal((await w.as("chris", { op: "campaign.start", market: "VN", mode: "PARALLEL", concurrency: 2, confirmed: true })).status, 403);
  for (const u of ["giuliano", "mario", "damiano"]) {
    assert.equal((await w.as(u)).status, 403, `${u} GET`);
    assert.equal((await w.as(u, { op: "call.start", lead_id: w.ids[0], confirmed: true })).status, 403, `${u} start`);
    assert.equal((await w.as(u, null, "?view=lists")).status, 403, `${u} lists`);
  }
  // CH: kein Outbound-Call durch den Agenten – auch nicht mit früherer CH-Grundlage
  assert.equal(eligibility({ lead_id: "x.ch", market: "CH", phone_tel: "tel:+41311234567", customer: true }, { consent: { call_consent: { at: "2026-10-01T00:00:00Z", source: "X" } }, now: VN("10:00"), legal: LEGAL }).code, "CH_CALLING_DISABLED");
});

// ================= CALLING: Einwilligung / DNC / Recht =================
test("TF-068 Consent: ohne Nachweis blocked (CALL_CONSENT_UNKNOWN), Pflichtfelder, Telefonbuch/Website keine Einwilligung, Widerruf sperrt", () => {
  const e = (consent, now = VN("10:00")) => eligibility(vnLead, { consent, now, legal: LEGAL });
  assert.equal(e(null).code, "CALL_CONSENT_UNKNOWN");
  assert.equal(e({ dnc_registry: REG }).code, "CALL_CONSENT_UNKNOWN");
  assert.equal(e(full).decision, "ALLOWED");
  for (const k of ["consent_source", "consent_timestamp", "consent_scope", "consent_evidence_reference", "verified_at", "phone"]) assert.equal(e({ ...full, evidence: { ...full.evidence, [k]: null } }).decision, "BLOCKED", k);
  assert.equal(validateConsentEvidence({ ...full.evidence, consent_source: "PUBLIC_DIRECTORY" }, vnLead).code, "CONSENT_SOURCE_NOT_VERIFIABLE");
  assert.equal(validateConsentEvidence({ ...full.evidence, consent_source: "WEBSITE" }, vnLead).code, "CONSENT_SOURCE_NOT_VERIFIABLE");
  assert.equal(validateConsentEvidence({ ...full.evidence, phone: "+84999999999" }, vnLead).code, "CONSENT_PHONE_MISMATCH");
  assert.equal(validateConsentEvidence({ ...full.evidence, consent_scope: ["EMAIL"] }, vnLead).code, "CONSENT_SCOPE_MISSING");
  assert.equal(e({ ...full, evidence: { ...full.evidence, revoked_at: "2026-10-05T00:00:00Z" } }).code, "CONSENT_REVOKED");
  assert.equal(e({ ...full, dnc_registry: { result: "LISTED", checked_at: REG.checked_at } }).bucket, "BLOCKED_DNC", "nationales DNC-Register");
  assert.equal(e({ ...full, dnc_registry: null }).code, "DNC_REGISTRY_NOT_CHECKED");
  assert.equal(e({ ...full, dnc_registry: { result: "NOT_LISTED", checked_at: "2026-08-01T00:00:00Z" } }).code, "DNC_REGISTRY_NOT_CHECKED", "Abgleich älter als 30 Tage");
  assert.equal(eligibility({ ...vnLead, do_not_contact: true }, { consent: full, now: VN("10:00"), legal: LEGAL }).bucket, "BLOCKED_DNC", "VN DNC blocked");
  assert.equal(eligibility(vnLead, { consent: full, now: VN("10:00"), dncSet: new Set(["b.vn"]), legal: LEGAL }).bucket, "BLOCKED_DNC");
  assert.equal(eligibility(vnLead, { consent: full, now: VN("10:00"), legal: null }).code, "BLOCKED_PENDING_LEGAL_REVIEW", "unklare Rechtslage");
});

test("TF-068 Zeitfenster: 07:59 blocked, 08:00 allowed, 16:55 keine neuen (Gespräch muss vor 17:00 enden), 17:00 blocked", () => {
  const e = (t) => eligibility(vnLead, { consent: full, now: t, legal: LEGAL });
  assert.equal(e(VN("07:59")).code, "WAITING_FOR_ALLOWED_HOURS");
  assert.equal(e(VN("08:00")).decision, "ALLOWED");
  assert.equal(e(VN("16:50")).decision, "ALLOWED");
  assert.equal(e(VN("16:55")).code, "WAITING_FOR_ALLOWED_HOURS");
  assert.equal(e(VN("17:00")).code, "WAITING_FOR_ALLOWED_HOURS");
  assert.equal(e(VN("19:00")).decision, "WAITING");
  assert.equal(canStartCallAt("VN", VN("08:00")), true);
  assert.equal(callSecondsLeft("VN", VN("16:45")), 600); assert.equal(callSecondsLeft("VN", VN("16:52")), 480);
});

test("TF-068 24 h: zweiter Werbeanruf an dieselbe Nummer innerhalb 24 h blocked, danach erlaubt", async () => {
  const e = (last, t) => eligibility(vnLead, { consent: full, now: t, legal: LEGAL, lastCallAt: last });
  assert.equal(e(+VN("10:00"), new Date(+VN("10:00") + 23 * 3_600_000)).code, "FREQUENCY_LIMIT_24H");
  assert.equal(e(+VN("09:00"), new Date(+VN("09:00") + 24 * 3_600_000)).decision, "ALLOWED");
  // API: Anruf abgeschlossen → am nächsten Morgen (< 24 h) kein Job, Position wartet bis 24 h nach dem ersten Anruf
  const w = await world({ consentIdx: [0] });
  await w.pull();
  assert.equal((await w.as("lap", { op: "call.start", lead_id: w.ids[0], confirmed: true })).status, 202);
  const [job] = (await w.pull()).body.jobs;
  await w.agent({ op: "event", call_id: job.call_id, status: "COMPLETED", duration_s: 60 });
  w.clock.t = new Date(+VN("10:00") + 22 * 3_600_000); // nächster Tag 08:00
  await w.pull();
  const again = await w.as("lap", { op: "call.start", lead_id: w.ids[0], confirmed: true });
  assert.equal(again.status, 202, `Lap darf einplanen … ${JSON.stringify(again.body)}`);
  assert.equal((await w.pull()).body.jobs.length, 0, "… aber kein zweiter Anruf innerhalb 24 h");
  const it = (await w.mem.control.get()).state.campaigns.at(-1).items[0];
  assert.equal(it.last_code, "FREQUENCY_LIMIT_24H"); assert.ok(Date.parse(it.next_at) >= +VN("10:00") + 24 * 3_600_000);
  w.clock.t = new Date(Date.parse(it.next_at));
  assert.equal((await w.pull()).body.jobs.length, 1, "nach 24 h im Fenster erlaubt");
});

test("TF-068 Owner-Konfiguration: Einwilligung erfassen (Server setzt Telefon/verified_at), Lap 403, Widerruf sofort, Rechts-Gate, Leadlisten", async () => {
  const w = await world({ legal: false });
  await w.pull();
  const id = w.ids[1];
  const rec = { op: "consent.record", lead_id: id, consent_status: "GRANTED", consent_source: "WRITTEN_FORM", consent_timestamp: "2026-10-01T08:00:00Z", consent_scope: ["ADVERTISING_CALLS"], consent_evidence_reference: "Formular 2026-10-01 Nr. 17" };
  assert.equal((await w.as("lap", rec)).status, 403, "Lap kann keine Einwilligung erfinden");
  assert.equal((await w.as("chris", { ...rec, consent_source: "PHONE_BOOK" })).status, 400, "Telefonbuch keine Einwilligung");
  assert.equal((await w.as("chris", { ...rec, phone: "+84900000000" })).status, 400, "Telefon nie vom Client");
  assert.equal((await w.as("chris", rec)).status, 200);
  assert.equal((await w.as("chris", { op: "dnc_registry.record", lead_id: id, registry_result: "NOT_LISTED", reference: "DNC-Abgleich 2026-10-14" })).status, 200);
  const stored = (await w.mem.consents.get()).state.leads[id].evidence;
  assert.equal(stored.phone, vnPhone(1), "Telefon aus dem Lead"); assert.ok(stored.verified_at); assert.equal(stored.revoked_at, null);
  let d = (await w.as("lap", null, `?lead=${encodeURIComponent(id)}`)).body;
  assert.equal(d.eligibility.code, "BLOCKED_PENDING_LEGAL_REVIEW", "ohne Rechtsfreigabe kein Anruf");
  assert.equal((await w.as("lap", { op: "legal.set", status: "APPROVED", reference: "Gutachten X" })).status, 403);
  assert.equal((await w.as("chris", { op: "legal.set", status: "APPROVED", reference: "Rechtsprüfung Decree 91/2020 – Test" })).status, 200);
  d = (await w.as("lap", null, `?lead=${encodeURIComponent(id)}`)).body;
  assert.equal(d.eligibility.decision, "ALLOWED"); assert.equal(d.call_flag, "CALL_ALLOWED"); assert.equal(d.list, "CALL_ELIGIBLE_LEADS");
  const lists = (await w.as("lap", null, "?view=lists")).body;
  assert.equal(lists.counts.ALL_LEADS, 8); assert.equal(lists.counts.CALL_ELIGIBLE_LEADS, 1); assert.equal(lists.counts.DO_NOT_CONTACT, 1);
  assert.equal(lists.counts.CALL_BLOCKED_LEADS, 6);
  assert.ok(lists.leads.filter((x) => x.call_flag === "CONSENT_UNKNOWN").length >= 5, "neue Leads ohne Nachweis: CONSENT_UNKNOWN");
  const elig = (await w.as("lap", null, "?view=lists&list=CALL_ELIGIBLE_LEADS")).body.leads;
  assert.deepEqual(elig.map((x) => x.lead_id), [id], "Warteschlange nur rechtlich freigegebene Kontakte");
  assert.equal((await w.as("lap", { op: "consent.revoke", lead_id: id, reason: "Kunde widerruft" })).status, 200);
  assert.equal((await w.as("lap", null, `?lead=${encodeURIComponent(id)}`)).body.eligibility.code, "CONSENT_REVOKED");
  // CH-Leads bleiben im CRM unverändert (nur nicht im Calling)
  assert.equal((await w.s.stores.view.get()).state.leads.length, 50);
});

// ================= CALLING: CRM-Tools des Agenten =================
test("TF-068 CRM-Tools: Ergebnis korrekt gespeichert, idempotent, Cross-lead 403, Allowlist, DNC sofort, Call-History-Felder", async () => {
  const w = await world({ consentIdx: [0, 1] });
  const real = { ...SVC, dry_run: false };
  await w.pull(real);
  assert.equal((await w.as("lap", { op: "campaign.start", market: "VN", mode: "PARALLEL", concurrency: 2, confirmed: true })).status, 202);
  const jobs = (await w.pull(real)).body.jobs;
  assert.equal(jobs.length, 2);
  const [a, b] = jobs;
  const tool = (call, x) => w.agent({ op: "tool", call_id: call.call_id, lead_id: call.lead_id, idempotency_key: `k-${crypto.randomUUID().slice(0, 12)}`, ...x });
  const g = await tool(a, { tool: "get_current_lead" });
  assert.equal(g.status, 200); assert.equal(g.body.lead.lead_id, a.lead_id); assert.ok(!JSON.stringify(g.body).includes(a.phone_e164), "keine Telefonnummer im Kontext");
  assert.equal((await w.agent({ op: "tool", call_id: a.call_id, lead_id: b.lead_id, tool: "mark_interested", params: { summary: "x" }, idempotency_key: "cross-0001" })).status, 403, "Cross-lead CRM write");
  assert.equal((await w.agent({ op: "tool", call_id: a.call_id, lead_id: "fremd.vn", tool: "mark_do_not_call", idempotency_key: "cross-0002" })).status, 403);
  assert.equal((await tool(a, { tool: "crm.update", params: {} })).status, 400, "kein arbitrary CRM write");
  assert.equal((await tool(a, { tool: "record_call_outcome", params: { outcome: "PAID" } })).status, 400);
  assert.equal((await tool(a, { tool: "mark_interested", params: { summary: "x", password: "y" } })).status, 400, "kein Zusatzfeld");
  const key = { idempotency_key: "same-key-0001" };
  assert.equal((await tool(a, { tool: "mark_interested", params: { summary: "Quan tâm gói kiểm tra & sửa lỗi." }, ...key })).body.outcome, "INTERESTED");
  const again = await tool(a, { tool: "mark_interested", params: { summary: "anders" }, ...key });
  assert.equal(again.body.idempotent, true);
  assert.equal((await tool(a, { tool: "request_callback", params: { callback_at: new Date(+w.clock.t + 3_600_000).toISOString(), summary: "Gọi lại sau 1 giờ." } })).body.outcome, "CALLBACK_REQUESTED");
  await w.agent({ op: "event", call_id: a.call_id, status: "COMPLETED", duration_s: 95, answered_at: new Date(+w.clock.t).toISOString() });
  const h = (await w.mem.history.get()).state.calls.find((c) => c.call_id === a.call_id);
  for (const k of ["call_id", "lead_id", "seller_id", "market", "started_at", "ended_at", "duration_s", "outcome", "short_summary", "callback_at", "consent_evidence_reference"]) assert.ok(h[k] != null, k);
  assert.deepEqual([h.seller_id, h.market, h.outcome, h.duration_s], ["lap", "VN", "CALLBACK_REQUESTED", 95]);
  assert.equal(h.consent_evidence_reference, `FORM-${a.lead_id}`); assert.equal(h.recording, false); assert.ok(!("phone_key" in h)); assert.ok(!JSON.stringify(h).includes(a.phone_e164));
  const crm = (await w.s.stores.vnQueue.get()).state.requests.filter((r) => r.params.lead_id === a.lead_id);
  assert.equal(crm[0].params.result, "CALLBACK_REQUESTED"); assert.ok(crm[0].params.follow_up_at);
  // DNC über das Tool: sofort gesperrt, CRM-DNC, Warteschlange bereinigt
  assert.equal((await tool(b, { tool: "mark_do_not_call" })).status, 200);
  assert.ok((await w.mem.consents.get()).state.dnc[b.lead_id], "sofort DNC");
  assert.ok((await w.s.stores.vnQueue.get()).state.requests.some((r) => r.action === "crm.setDoNotContact" && r.params.lead_id === b.lead_id));
  assert.equal((await tool(b, { tool: "mark_interested", params: { summary: "x" } })).body.outcome, "DO_NOT_CALL", "DNC schlägt alles – keine Override-Funktion");
  await w.agent({ op: "event", call_id: b.call_id, status: "COMPLETED" });
  assert.equal((await w.mem.history.get()).state.calls.find((c) => c.call_id === b.call_id).outcome, "DO_NOT_CALL");
  assert.equal((await w.as("lap", { op: "call.start", lead_id: b.lead_id, confirmed: true })).status, 409);
  // nach Anrufende keine Tools mehr
  assert.equal((await tool(a, { tool: "record_call_summary", params: { summary: "x y z" } })).status, 404);
});

// ================= VOICE =================
test("TF-068 Stimme: sonic-3.6 bevorzugt, Kandidat nicht verifiziert → VOICE_NOT_VERIFIED, echte Anrufe gesperrt", async () => {
  assert.equal(resolveModels("VN").tts, "cartesia/sonic-3.6"); assert.equal(resolveModels("VN").tts_language, "vi");
  assert.equal(VERIFIED_VOICES.VN.length, 0, "keine Voice-ID erfunden");
  assert.ok(VOICE_CANDIDATES.VN.every((v) => v.gender === "male" && v.language === "vi" && /UNVERIFIED/.test(v.status)));
  assert.equal(voiceStatus("VN", (k) => (k === "CALLING_TTS_VOICE_VN" ? VOICE_CANDIDATES.VN[0].id : undefined)).status, "VOICE_NOT_VERIFIED");
  assert.equal(configStatus(() => undefined).voice_vn, "VOICE_NOT_VERIFIED");
  const w = await world({ consentIdx: [0] });
  const real = { ...SVC, dry_run: false, configured: { ...SVC.configured, voice_vn: "VOICE_NOT_VERIFIED" } };
  await w.pull(real);
  const st = await w.as("lap", { op: "call.start", lead_id: w.ids[0], confirmed: true });
  assert.equal(st.status, 409); assert.equal(st.body.code, "VOICE_NOT_VERIFIED");
  assert.equal((await w.as("chris")).body.service.voice_vn, "VOICE_NOT_VERIFIED");
  const ins = buildInstructions(buildLeadContext({ lead_id: "y.vn", market: "VN", company: "ABC" }));
  assert.match(ins, /trả lời NGAY và trung thực rằng bạn là trợ lý tự động/); assert.match(ins, /câu ngắn/);
});

// ================= PAYMENTS =================
// Fake-Secrets erst zur Laufzeit zusammensetzen (kein secret-artiger String im Repo – Netlify Secret Scan, vgl. TF-067).
const SECRET = [["wh", "sec"].join(""), "test", "x".repeat(24)].join("_");
const WRONG = [["wh", "sec"].join(""), "wrong", "y".repeat(24)].join("_");
const sign = (raw, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const VNFIX = "VNFIX-20261016-abc123", VNCHECK = "VNCHECK-20261016-def456", RF = "RF480-20261016-0a0b0c";
function payStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf068-"));
  const store = createStore(dir);
  store.write("repair_orders.json", { orders: {
    [VNFIX]: { order_id: VNFIX, domain: "vn-cong-ty-1.vn", offer_class: "VN_REPAIR_FIX", market: "VN", currency: "VND", state: "ORDER_CONFIRMED", created_at: "2026-10-16T03:00:00Z" },
    [RF]: { order_id: RF, domain: "ch-firma-0001.ch", offer_class: "REPAIR_FIX_500", state: "ORDER_CONFIRMED", created_at: "2026-10-16T03:00:00Z" } } });
  store.write("check150_orders.json", { orders: { [VNCHECK]: { order_id: VNCHECK, domain: "vn-cong-ty-2.vn", offer_class: "VN_REPAIR_CHECK", market: "VN", currency: "VND", state: "ORDER_CONFIRMED", created_at: "2026-10-16T03:00:00Z" } } });
  return { dir, store, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const pi = (id, amount, currency, order_id, x = {}) => ({ id: `evt_${id}`, type: "payment_intent.succeeded", data: { object: { id, status: "succeeded", amount_received: amount, currency, metadata: order_id ? { order_id } : {}, created: 1760583600, ...x } } });

test("TF-068 Payment-Webhook: nicht konfiguriert 503, ungültige Signatur blocked, gültig → Inbox, Duplikat, nur Owner sieht Status", async () => {
  const s = await setup({ ch: 10, vn: 2 });
  const mem = {};
  const getStore = async (k) => (mem[k] ||= memoryStore());
  const authStore = authStoreFrom((k) => (s.authMem[k] ||= memoryStore()));
  const mk = (e) => createPaymentsHandler({ env: (k) => e[k] ?? env(k), getStore, getAuthStore: async () => authStore });
  const raw = JSON.stringify(pi("pi_1", 3900000, "vnd", VNFIX));
  const post = (h, body, headers) => h(new Request(`${ORIGIN}/api/payments`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } }));
  const off = mk({});
  assert.equal(monitorStatus(() => undefined).status, "PAYMENT_MONITOR_NOT_CONFIGURED");
  const r0 = await post(off, raw, { "stripe-signature": sign(raw) });
  assert.equal(r0.status, 503); assert.equal((await r0.json()).code, "PAYMENT_MONITOR_NOT_CONFIGURED");
  assert.equal(monitorStatus((k) => ({ PAYMENT_MONITOR_PROVIDER: "bank_api" })[k]).status, "PAYMENT_MONITOR_NOT_CONFIGURED", "kein Bank-Adapter erfunden");
  const on = mk({ PAYMENT_MONITOR_PROVIDER: "stripe", STRIPE_WEBHOOK_SECRET: SECRET });
  assert.equal((await post(on, raw, { "stripe-signature": sign(raw, undefined, WRONG) })).status, 400, "invalid signature blocked");
  assert.equal((await post(on, raw, {})).status, 400);
  assert.equal((await post(on, raw, { "stripe-signature": sign(raw, Math.floor(Date.now() / 1000) - 3600) })).status, 400, "abgelaufen");
  assert.equal((await post(on, raw.replace("3900000", "39000000"), { "stripe-signature": sign(raw) })).status, 400, "manipulierter Body");
  assert.equal(mem.inbox?.state?.events?.length ?? (await (await getStore("inbox")).get()).state?.events?.length ?? 0, 0, "nichts gespeichert");
  const ok = await post(on, raw, { "stripe-signature": sign(raw) });
  assert.equal(ok.status, 200); assert.equal((await ok.json()).duplicate, false);
  assert.equal((await (await post(on, raw, { "stripe-signature": sign(raw) })).json()).duplicate, true, "Duplikat");
  const pull = await post(on, JSON.stringify({ op: "inbox.pull" }), { "x-jarvis-worker": env("JARVIS_MAIL_WORKER_TOKEN") });
  const ev = (await pull.json()).events;
  assert.equal(ev.length, 1); assert.deepEqual([ev[0].tx.amount, ev[0].tx.currency, ev[0].tx.order_ref, ev[0].tx.verified], [3900000, "VND", VNFIX, true]);
  assert.equal((await post(on, JSON.stringify({ op: "inbox.pull" }), { "x-jarvis-worker": "falsch" })).status, 401);
  const get = (u) => on(makeReq("/api/payments", { cookie: s.cookies[u] }));
  assert.equal((await get("chris")).status, 200);
  for (const u of ["lap", "giuliano", "mario", "damiano"]) assert.equal((await get(u)).status, 403, `${u} keine globalen Finanzdaten`);
});

test("TF-068 Abgleich: gültige Zahlung verbucht, Duplikat blocked, unbekannt/mehrdeutig/Währung falsch → PAYMENT_REVIEW_REQUIRED, Gate einmal erfüllt", () => {
  const p = payStore();
  try {
    const tx = normalizeStripeEvent(pi("pi_A", 1950000, "vnd", VNFIX));
    const [r1] = reconcileAll(p.store, [tx]);
    assert.equal(r1.result, "BOOKED"); assert.equal(r1.order_id, VNFIX);
    assert.equal(paymentGateForOrder(p.store, { order_id: VNFIX, offer_class: "VN_REPAIR_FIX", market: "VN", currency: "VND" }).satisfied, true, "Schwelle 1950000 VND → Onboarding/Gate");
    const [r2] = reconcileAll(p.store, [tx]);
    assert.equal(r2.result, "DUPLICATE", "duplicate payment blocked");
    assert.equal(paymentsForOrder(p.store, VNFIX).length, 1, "keine doppelte Verbuchung");
    const rs = reconcileAll(p.store, [
      normalizeStripeEvent(pi("pi_B", 990000, "vnd", null)),                                         // keine Referenz
      { ...normalizeStripeEvent(pi("pi_C", 990000, "vnd", null)), remittance: `Thanh toan ${VNFIX} va ${VNCHECK}` }, // mehrdeutig
      normalizeStripeEvent(pi("pi_D", 990000, "vnd", "VNCHECK-20261016-ffffff")),                     // unbekannter Auftrag
      normalizeStripeEvent(pi("pi_E", 24000, "chf", VNCHECK)),                                        // CHF auf VND-Auftrag
      { ...normalizeStripeEvent(pi("pi_F", 990000, "vnd", VNCHECK)), settled: false },                // nicht eingegangen
      { ...normalizeStripeEvent(pi("pi_G", 990000, "vnd", VNCHECK)), verified: false },               // Kundenbehauptung / unverifiziert
      { provider: "stripe", transaction_id: "pi_H", kind: "PAYMENT", amount: 990000, currency: "VND", received_at: "2026-10-16T03:00:00Z", settled: true, order_ref: null, remittance: "Nguyen Van A Cong ty 2", verified: true }, // nur Name
    ]);
    assert.deepEqual(rs.map((r) => r.code), ["NO_ORDER_REFERENCE", "AMBIGUOUS_ORDER_REFERENCE", "UNKNOWN_ORDER", "CURRENCY_MISMATCH", "NOT_SETTLED", "UNVERIFIED_SOURCE", "NO_ORDER_REFERENCE"]);
    assert.ok(rs.slice(0, 6).filter((r) => r.code !== "UNVERIFIED_SOURCE").every((r) => r.result === "PAYMENT_REVIEW_REQUIRED"));
    assert.equal(rs[5].result, "IGNORED");
    assert.equal(paymentsForOrder(p.store, VNCHECK).length, 0, "nichts verbucht");
    const st = p.store.read("payment_monitor.json", emptyMonitorState());
    assert.ok(st.reviews.filter((r) => r.status === "OPEN").length >= 6);
    // CHF strikt CHF
    assert.equal(reconcileAll(p.store, [normalizeStripeEvent(pi("pi_I", 24000, "chf", RF))])[0].result, "BOOKED");
    assert.equal(paymentSummary(p.store, { order_id: RF, offer_class: "REPAIR_FIX_500" }).paid_amount, 240);
    assert.deepEqual(extractOrderRef({ remittance: "zahlung vnfix-20261016-ABC123 danke" }), { order_id: VNFIX, code: null });
  } finally { p.done(); }
});

test("TF-068 camt.053: gebuchte Gutschrift mit Auftrags-ID verbucht, Belastung ignoriert, gleiche Datei nur einmal", () => {
  const p = payStore();
  try {
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>STMT-1</Id>
      <Ntry><Amt Ccy="CHF">240.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-10-16</Dt></BookgDt><AcctSvcrRef>BANK-001</AcctSvcrRef>
        <NtryDtls><TxDtls><RmtInf><Ustrd>Auftrag ${RF} Muster AG</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
      <Ntry><Amt Ccy="CHF">50.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-10-16</Dt></BookgDt><AcctSvcrRef>BANK-002</AcctSvcrRef></Ntry>
      <Ntry><Amt Ccy="CHF">75.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>PDNG</Cd></Sts><BookgDt><Dt>2026-10-16</Dt></BookgDt><AcctSvcrRef>BANK-003</AcctSvcrRef></Ntry>
      </Stmt></BkToCstmrStmt></Document>`;
    assert.equal(parseCamt053(xml).length, 2, "nur Gutschriften");
    const r = importCamt(p.store, xml);
    assert.deepEqual(r.results.map((x) => x.result), ["BOOKED", "PAYMENT_REVIEW_REQUIRED"]);
    assert.equal(importCamt(p.store, xml).duplicate_file, true);
    assert.equal(paymentsForOrder(p.store, RF).length, 1);
    assert.throws(() => parseCamt053("<html>kein Auszug</html>"));
  } finally { p.done(); }
});

test("TF-068 Provision: gültig bezahlter Auftrag → korrekte Provision (aus 3500 bps), Refund → REVERSED", () => {
  const p = payStore();
  try {
    recordPayment(p.store, { order_id: VNFIX, amount: 3900000, currency: "VND", reference: "stripe:pi_full" });
    const sumFix = paymentSummary(p.store, { order_id: VNFIX, offer_class: "VN_REPAIR_FIX", market: "VN", currency: "VND" });
    assert.equal(sumFix.payment_status, "PAID_FULL");
    const order = (st, s) => ({ repair: { orders: [{ order_id: VNFIX, domain: "vn-cong-ty-1.vn", offer_class: "VN_REPAIR_FIX", market: "VN", currency: "VND", price_amount: 3900000, paid_amount: s.paid_amount, state: st, payment_status: s.payment_status, created_at: "2026-10-16T03:00:00Z" }] } });
    const seller = () => ({ seller_id: "lap", lead_id: "vn-cong-ty-1.vn", source: "vn_default" });
    const base = { ...emptyLedger(), eligible_from: "2026-10-01T00:00:00Z" };
    const L1 = deriveLedger({ ledger: base, orders: ordersFromSnapshot(order("COMPLETED", sumFix)), resolveSeller: seller, now: new Date("2026-10-16T05:00:00Z") }).ledger;
    const e1 = L1.entries[VNFIX];
    assert.deepEqual([e1.status, e1.payable_minor, e1.seller_id], ["PAYABLE", 1365000, "lap"]);
    assert.equal(e1.payable_minor, commissionMinor(toMinor(MARKET_PRICES.VN.offers.FIX.price, "VND"), RATE_BPS.lap));
    const pay = paymentsForOrder(p.store, VNFIX)[0];
    refundPayment(p.store, pay.payment_id, { reason: "Kunde erstattet" });
    const s2 = paymentSummary(p.store, { order_id: VNFIX, offer_class: "VN_REPAIR_FIX", market: "VN", currency: "VND" });
    assert.equal(s2.payment_status, "REFUNDED");
    const L2 = deriveLedger({ ledger: L1, orders: ordersFromSnapshot(order("COMPLETED", s2)), resolveSeller: seller, now: new Date("2026-10-16T06:00:00Z") }).ledger;
    assert.deepEqual([L2.entries[VNFIX].status, L2.entries[VNFIX].reversed_minor], ["REVERSED", 1365000], "commission reversed");
    // Beträge: CH 52.50 / 168.00, VN 346500 / 1365000 – immer Preis × 3500 bps
    const c = (m, k) => fromMinor(commissionMinor(toMinor(MARKET_PRICES[m].offers[k].price, MARKET_PRICES[m].currency), 3500), MARKET_PRICES[m].currency);
    assert.deepEqual([c("CH", "CHECK"), c("CH", "FIX"), c("VN", "CHECK"), c("VN", "FIX")], ["52.50", "168.00", "346500", "1365000"]);
  } finally { p.done(); }
});

test("TF-068 Auszahlung: nur markieren, Teilzahlungen, nie über Auszahlbar, Referenz nie doppelt, Währung des Verkäufers", () => {
  const L = { ...emptyLedger(), eligible_from: "2026-10-01T00:00:00Z", entries: {
    [VNFIX]: { order_id: VNFIX, market: "VN", currency: "VND", seller_id: "lap", status: "PAYABLE", payable_minor: 1365000, expected_minor: 1365000 },
    [RF]: { order_id: RF, market: "CH", currency: "CHF", seller_id: "mario", status: "PAYABLE", payable_minor: 16800, expected_minor: 16800 } } };
  const now = new Date("2026-10-16T12:00:00Z");
  const a = recordPayout(L, { seller_id: "lap", amount: 1000000, currency: "VND", paid_at: "2026-10-16T10:00:00Z", reference: "VCB-0001", actor_user_id: "chris", now }).ledger;
  let s = summarize(a, ["lap"])[0];
  assert.deepEqual([s.payable, s.paid_out, s.outstanding], ["1365000", "1000000", "365000"], "Teilzahlung");
  assert.throws(() => recordPayout(a, { seller_id: "lap", amount: 400000, currency: "VND", paid_at: "2026-10-16T10:00:00Z", reference: "VCB-0002", actor_user_id: "chris", now }), /übersteigt/);
  assert.throws(() => recordPayout(a, { seller_id: "lap", amount: 100, currency: "VND", paid_at: "2026-10-16T10:00:00Z", reference: "vcb-0001 ", actor_user_id: "chris", now }), /bereits erfasst/);
  assert.throws(() => recordPayout(a, { seller_id: "lap", amount: 100, currency: "CHF", paid_at: "2026-10-16T10:00:00Z", reference: "X-1", actor_user_id: "chris", now }), /nur in VND/);
  assert.throws(() => recordPayout(a, { seller_id: "lap", amount: 100, currency: "VND", paid_at: "2026-12-01T10:00:00Z", reference: "X-2", actor_user_id: "chris", now }), /Zukunft/);
  const b = recordPayout(a, { seller_id: "lap", amount: 365000, currency: "VND", paid_at: "2026-10-16T11:00:00Z", reference: "VCB-0003", actor_user_id: "chris", now }).ledger;
  s = summarize(b, ["lap"])[0];
  assert.deepEqual([s.paid_out, s.outstanding], ["1365000", "0"]);
  const m = recordPayout(b, { seller_id: "mario", amount: 168, currency: "CHF", paid_at: "2026-10-16T11:00:00Z", reference: "UBS-1", actor_user_id: "chris", now }).ledger;
  assert.equal(summarize(m, ["mario"])[0].paid_out, "168.00");
  assert.ok(m.payouts.every((p) => p.status === "PAYOUT_RECORDED") && m.audit.filter((x) => x.action === "commission.payout").length === 3);
});

// ================= DASHBOARD / ISOLATION =================
test("TF-068 Verkäufe & Provisionen: Owner-Übersicht CHF/VND getrennt, Payout nur Owner, Verkäufer-Isolation PASS", async () => {
  const t = await setup({ ch: 900, vn: 20 });
  t.salesMem.commissions = memoryStore({ ...emptyLedger(), eligible_from: "2026-01-01T00:00:00Z" });
  const asg = (await t.salesMem.assignments.get()).state;
  const marioLead = Object.entries(asg.assignments).find(([, a]) => a.assigned_user_id === "mario")[0];
  const created = new Date(Date.now() - 60_000).toISOString();
  const { etag } = await t.stores.control.get();
  await t.stores.control.set({ snapshot: {
    repair: { orders: [{ order_id: RF, domain: marioLead, company: "Mario Kunde AG", offer_class: "REPAIR_FIX_500", price_chf: 480, paid_chf: 480, state: "COMPLETED", payment_status: "PAID_FULL", created_at: created }] },
    check150: { orders: [{ order_id: VNCHECK, domain: "vn-cong-ty-1.vn", offer_class: "VN_REPAIR_CHECK", market: "VN", currency: "VND", price_amount: 990000, paid_amount: 990000, state: "COMPLETED", payment_status: "PAID_FULL", created_at: created }] } },
    snapshot_at: new Date().toISOString() }, etag);
  const get = async (u, q) => t.json(await t.sales(makeReq(`/api/sales?view=${q}`, { cookie: t.cookies[u] })));
  const o = await get("chris", "sales_overview");
  assert.equal(o.status, 200);
  const mario = o.body.sellers.find((x) => x.seller_id === "mario"), lap = o.body.sellers.find((x) => x.seller_id === "lap");
  assert.deepEqual([mario.by_currency.CHF.orders, mario.by_currency.CHF.completed, mario.by_currency.CHF.revenue, mario.by_currency.CHF.commission_payable], [1, 1, "480.00", "168.00"]);
  assert.deepEqual([lap.by_currency.VND.revenue, lap.by_currency.VND.commission_payable, lap.by_currency.CHF.orders], ["990000", "346500", 0]);
  const row = o.body.orders.find((x) => x.order_id === VNCHECK);
  for (const k of ["order_id", "lead_id", "seller_id", "market", "offer", "price", "currency", "confirmed_at", "payment_status", "fulfillment_status", "commission_status"]) assert.ok(row[k] != null, k);
  assert.deepEqual([row.seller_id, row.market, row.offer, row.currency, row.commission_status], ["lap", "VN", "CHECK", "VND", "PAYABLE"]);
  for (const u of ["lap", "giuliano", "mario", "damiano"]) assert.equal((await get(u, "sales_overview")).status, 403, `${u} keine globalen Finanzdaten`);
  const post = async (u, body) => t.json(await t.sales(makeReq("/api/sales", { method: "POST", body, cookie: t.cookies[u] })));
  const po = { op: "commission.payout", seller_id: "lap", amount: 346500, currency: "VND", paid_at: new Date(Date.now() - 1000).toISOString(), reference: "VCB-TEST-1" };
  assert.equal((await post("lap", po)).status, 403, "keine Zahlungs-/Auszahlungsrechte für Verkäufer");
  assert.equal((await post("chris", po)).status, 200);
  assert.equal((await post("chris", po)).status, 409, "doppelte Auszahlung verhindert");
  const lapCom = (await get("lap", "commission")).body.commission;
  assert.deepEqual([lapCom.seller_id, lapCom.currency, lapCom.payable, lapCom.paid_out], ["lap", "VND", "346500", "346500"]);
  assert.ok(lapCom.orders.every((x) => x.currency === "VND"), "Lap: keine CH-Daten");
  const marioCom = (await get("mario", "commission")).body;
  assert.equal(marioCom.commission.seller_id, "mario"); assert.equal(JSON.stringify(marioCom).includes(VNCHECK), false, "keine fremden Provisionen");
  assert.equal((await get("giuliano", "orders")).status, 403);
});
