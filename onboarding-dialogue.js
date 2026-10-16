// Kunden-Onboarding-Dialog (TF-066) – Mail-Worker-Seite. Der Mail-Worker ist und bleibt die EINZIGE Sender Authority.
//
//   - Bindung: die erste Service-Mail eines Auftrags (FIX: Zugangs-Anfrage mit Inhaltsfrage, CHECK: Startnachricht) eröffnet den
//     Jarvis-eigenen Auftrags-Thread; nach dem Versand wird order_id ↔ Kundenadresse ↔ thread_id ↔ Klasse ↔ Markt ↔ Verkäufer
//     gebunden (onboarding.json). Jede weitere Auftrags-Mail geht NUR in diesen Thread (In-Reply-To/References). Thread verloren
//     oder nicht eindeutig → MANUAL_REVIEW_REQUIRED, nie ein neuer freier Thread.
//   - Gelesen werden ausschliesslich gebundene, Jarvis-eigene Threads (gmail.readThread prüft Register + Gmail). Keine Inbox-Analyse.
//   - Jede neue Kundennachricht: Absender == bestätigte Kundenadresse, Text nur ohne Zitat, Zugangsdaten/Stopp/Storno/Preis-/Rechts-
//     fragen/Injection deterministisch vorab, sonst KI-Extraktion (streng validiert, nur belegte Werte), Zustandsautomat entscheidet,
//     feste Vorlage DE/VI, GENAU EINE Antwort (Claim: creating → drafted → sending → sent; unklar → nie wiederholen, Chris).
//   - KI nicht verfügbar → ONBOARDING_AI_PAUSED, Nachricht bleibt unbearbeitet, später weiter (keine Doppelantwort).
//   - Reminder 24 h / +48 h / +96 h, danach WAITING_CUSTOMER_MANUAL_REVIEW. Abgelaufener Link → Bitte an den Repair-Service.
//   - Nie gespeichert: Rohmails, Zugangsdaten, Links/Token. Gespeichert: nur strukturierter Brief (belegte Werte) + Statuswörter.
//
//   node onboarding-dialogue.js status                         Zähler + Aufträge (nur Status, keine Inhalte)
//   node onboarding-dialogue.js show <order_id>                 Brief + Zustand eines Auftrags (für Chris, ohne Mailtexte)
//   node onboarding-dialogue.js no-content-changes <order_id> --reason TEXT   Chris: «keine Inhaltsänderungen» (z. B. telefonisch geklärt)
//   node onboarding-dialogue.js resume <order_id> --reason TEXT             Chris: manuelle Prüfung erledigt, Dialog fortsetzen
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as C from "./onboarding-core.js";
import { canonicalSellerId } from "./seller-identity.js";
import { readOrdersExport, writeBrief, writeReissueRequest, listReissueRequests, removeReissueRequest, onboardingDirOf } from "./onboarding-store.js";

export const ONBOARDING_FILE = "onboarding.json";
export const COMMANDS_DIR = "onboarding_commands";
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|timeout|aborted/i;
// Fehler, bei denen sicher NICHTS gesendet wurde (Limit/Sperre vor dem Gmail-Aufruf) → später erneut.
const SAFE_RETRY_RE = /nicht gesendet|andere Sendung läuft|Register gesperrt/i;
const BOUNCE_RE = /mailer-daemon|postmaster/i;
const AUTO_SUBJECT_RE = /(automatische antwort|abwesenheit|out of office|automatic reply|auto-?reply|réponse automatique|risposta automatica|trả lời tự động)/i;
const ORDER_ID_RE = /^(CA150|RF480|VNCHECK|VNFIX)-\d{8}-[0-9a-f]{6}$/;
const CREATING_STALE_MS = 10 * 60_000;
const REISSUE_WAIT_MS = 6 * 3600_000;
const DEFER_LIMIT_MS = 30 * 60_000;

const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
function writeAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const normEmail = C.normEmailAddr;
export const loadOnboarding = (dir) => { const s = readJson(path.join(dir, ONBOARDING_FILE), {}) || {}; return { v: 1, cursor: "", ...s, records: s.records || {} }; };

// ---------- KI-Extraktion über die Anthropic-API (VPS) ----------
// Nur strukturierte Fakten; die Kundenmail ist im Auftrag als UNTRUSTED DATA markiert (EXTRACTION_SYSTEM). Fehler → Exception
// (der Dialog pausiert), unlesbare Ausgabe → Objekt, das die Schema-Validierung sicher ablehnt (→ manuelle Prüfung).
export function apiExtract({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.JARVIS_ONBOARDING_MODEL || process.env.JARVIS_MAIL_MODEL || "claude-sonnet-5-5", fetchFn = globalThis.fetch } = {}) {
  return async (task) => {
    if (!apiKey) throw new Error("KI nicht konfiguriert");
    const r = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(90_000),
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1500, system: C.EXTRACTION_SYSTEM, messages: [{ role: "user", content: JSON.stringify(task) }] }),
    });
    if (!r.ok) { const e = new Error(`KI nicht verfügbar (HTTP ${r.status})`); e.code = r.status === 402 ? "AI_BUDGET_EXHAUSTED" : "AI_UNAVAILABLE"; throw e; }
    const text = ((await r.json()).content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    try { return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { return { unparseable: true }; }
  };
}

export function createOnboarding({ dir, onboardingDir, gmail, extract = null, now = () => new Date(), log = () => {}, notify = async () => {}, maxReads = 10 } = {}) {
  if (!dir || !onboardingDir) throw new Error("Onboarding: Verzeichnisse fehlen.");
  const file = path.join(dir, ONBOARDING_FILE);
  let st = null;
  const load = () => (st = loadOnboarding(dir));
  const persist = () => writeAtomic(file, st);
  const orders = () => readOrdersExport(onboardingDir);
  const iso = () => now().toISOString();
  const inform = async (rec, reason) => {
    log("warn", "onboarding_chris", { order_id: rec.order_id, reason: String(reason).slice(0, 120) });
    try { await notify({ order_id: rec.order_id, company: rec.company || rec.domain || "", threadId: rec.thread_id || null, reason: String(reason).slice(0, 120) }); }
    catch (e) { log("error", "onboarding_notify_failed", { error: String(e.message).slice(0, 120) }); }
  };
  const halt = (rec, state, reason) => { rec.state = state; rec.manual_reason = String(reason).slice(0, 200); rec.updated_at = iso(); };

  function newRecord(o, rq, info) {
    const t = iso();
    const kind = o?.kind || (/^(CA150|VNCHECK)-/.test(rq.order_id) ? "CHECK" : "FIX");
    const market = o?.market || (/^VN/.test(rq.order_id) ? "VN" : "CH");
    const base = { order_id: rq.order_id, kind, market, locale: market === "VN" ? "vi-VN" : "de-CH" };
    return { ...base, offer_class: o?.offer_class || null, seller_id: canonicalSellerId(o?.seller_id || null), lead_id: o?.lead_id || null, domain: o?.domain || null,
      company: o?.company || null, contact_name: o?.contact_name || null, customer_email: normEmail(rq.to), thread_id: info.threadId,
      message_class: rq.message_class, bound_at: t, state: "WAITING_FOR_CUSTOMER_INFO", brief: { ...C.emptyBrief(base), last_jarvis_reply_at: t },
      processed: {}, reminders: { count: 0, last_at: null }, reissues: 0, reissue_seq: 0, access_status: o?.access_status || null, updated_at: t };
  }
  const boundThreads = () => { const m = new Map(); for (const r of Object.values(load().records)) if (r.thread_id && r.state !== "COMPLETED") m.set(r.thread_id, r.order_id); return m; };

  // ---------- Outbox-Hooks (Mail-Worker) ----------
  function route(rq) {
    const ex = orders(), o = ex.orders?.[rq.order_id];
    const committed = Date.parse(rq.committed_at || rq.created_at || 0) || 0;
    if (!o || (Date.parse(ex.at || 0) || 0) < committed) return +now() - committed > DEFER_LIMIT_MS ? { reject: "order_unknown" } : { defer: true };
    if (!o.customer_email || normEmail(rq.to) !== o.customer_email) return { reject: "recipient_mismatch" };
    if (o.cancelled) return { reject: "order_cancelled" };
    if (rq.message_class === C.ONBOARDING_CLASS && (o.payment_gate_met !== true || o.order_confirmed !== true)) return { reject: "gate_not_met" };
    const rec = load().records[rq.order_id];
    if (rec && ["CUSTOMER_STOP_REQUESTED", "CANCELLATION_REVIEW_REQUIRED"].includes(rec.state)) return { reject: "customer_stop" };
    if (rec?.thread_id) {
      if (rec.customer_email !== o.customer_email) return { reject: "binding_mismatch" };
      return { threadId: rec.thread_id };
    }
    return { newThread: true };
  }
  function onSent(rq, info) {
    load();
    const o = orders().orders?.[rq.order_id];
    let rec = st.records[rq.order_id];
    const t = iso();
    if (!rec) {
      if (!info?.threadId) return;
      rec = st.records[rq.order_id] = newRecord(o, rq, info);
      log("info", "onboarding_bound", { order_id: rq.order_id, kind: rec.kind, market: rec.market, message_class: rq.message_class });
    } else if (info?.threadId && rec.thread_id && info.threadId !== rec.thread_id) {
      halt(rec, "MANUAL_REVIEW_REQUIRED", "Auftrags-Mail landete in einem anderen Thread – Zuordnung nicht eindeutig.");
    }
    rec.brief.last_jarvis_reply_at = t;
    if (rq.purpose === "reissue") {
      rec.reissues = (rec.reissues || 0) + 1;
      if (rec.reissue_pending?.seq === rq.seq) {
        if (rec.reissue_pending.reason === "reminder") rec.reminders = { count: (rec.reminders?.count || 0) + 1, last_at: t };
        rec.reissue_pending = null;
      }
    }
    rec.updated_at = t;
    persist();
  }
  function threadLost(rq) {
    load();
    const rec = st.records[rq.order_id];
    if (!rec) return;
    halt(rec, "MANUAL_REVIEW_REQUIRED", "Auftrags-Thread nicht mehr eindeutig lesbar – keine Mail in einem neuen Thread.");
    persist(); inform(rec, rec.manual_reason);
  }

  // ---------- Versand im Auftrags-Thread (genau einmal) ----------
  function finishPending(id, info) {
    const rec = st.records[id], p = rec.pending, t = iso();
    const next = p.next;
    next.pending = null;
    next.brief.last_jarvis_reply_at = t;
    if (p.msg_id) next.processed[p.msg_id] = { at: t, result: p.result, replied: true };
    if (p.reminder_n) next.reminders = { count: p.reminder_n, last_at: t };
    next.last_jarvis_message_id = info?.messageId || null;
    next.updated_at = t;
    st.records[id] = next;
    persist();
    log("info", "onboarding_reply_sent", { order_id: id, kind: p.reply_kind, message_class: C.ONBOARDING_CLASS });
    return "done";
  }
  function sendUnclear(id, why) {
    const rec = st.records[id], p = rec.pending;
    if (p.msg_id) rec.processed[p.msg_id] = { at: iso(), result: "send_unclear" };
    rec.pending = null;
    halt(rec, "MANUAL_REVIEW_REQUIRED", why);
    persist(); inform(rec, why);
    return "stop";
  }
  async function sendPending(id) {
    const rec = st.records[id], p = rec.pending;
    p.status = "sending"; p.send_at = iso(); persist(); // VOR dem Versand – ein Neustart sendet nie ein zweites Mal
    let info;
    try { info = await gmail.sendDraft(p.draft_id); }
    catch (e) {
      if (SAFE_RETRY_RE.test(String(e.message))) { p.status = "drafted"; persist(); log("warn", "onboarding_send_deferred", { order_id: id }); return "stop"; }
      return sendUnclear(id, TRANSIENT_RE.test(String(e.message)) ? "Versandstatus unklar – kein erneuter Versand, Chris prüft «Gesendet»." : "Versand fehlgeschlagen – Chris prüft.");
    }
    return finishPending(id, info);
  }
  async function sendInThread(id, { key, msgId = null, body, next, result, replyKind, reminderN = null }) {
    const rec = st.records[id];
    const { pending: _p, ...clean } = next;
    rec.pending = { key, msg_id: msgId, status: "creating", at: iso(), next: clean, result, reply_kind: replyKind, ...(reminderN ? { reminder_n: reminderN } : {}) };
    persist();
    let d;
    try { d = await gmail.replyDraftInThread(rec.thread_id, { to: rec.customer_email, body, messageClass: C.ONBOARDING_CLASS, orderId: id }); }
    catch (e) {
      if (TRANSIENT_RE.test(String(e.message))) { log("warn", "onboarding_draft_deferred", { order_id: id }); return "stop"; } // Recovery prüft Entwürfe
      rec.pending = null;
      if (msgId) rec.processed[msgId] = { at: iso(), result: "thread_lost" };
      halt(rec, "MANUAL_REVIEW_REQUIRED", "Antwort im Auftrags-Thread nicht möglich (Thread nicht eindeutig) – kein neuer Thread.");
      persist(); await inform(rec, rec.manual_reason); return "stop";
    }
    rec.pending = { ...rec.pending, status: "drafted", draft_id: d.draftId };
    persist();
    return sendPending(id);
  }
  // Nach Neustart: offene Sendung exakt abschliessen – nie doppelt.
  async function resolvePending(id) {
    const rec = st.records[id], p = rec.pending;
    const reg = typeof gmail.listOwned === "function" ? gmail.listOwned() : { drafts: {}, sent: {} };
    if (p.status === "creating") {
      const found = Object.entries(reg.drafts || {}).find(([, d]) => d.threadId === rec.thread_id && d.messageClass === C.ONBOARDING_CLASS && String(d.createdAt || "") >= p.at);
      if (found) { p.status = "drafted"; p.draft_id = found[0]; persist(); return sendPending(id); }
      if (+now() - Date.parse(p.at) > CREATING_STALE_MS) { rec.pending = null; persist(); return "done"; } // nichts entstanden → neu entscheiden
      return "stop";
    }
    if (p.status === "drafted") return sendPending(id);
    const sent = Object.values(reg.sent || {}).find((s) => s.fromDraft === p.draft_id);
    if (sent) return finishPending(id, sent);
    return sendUnclear(id, "Versandstatus unklar (Neustart während des Versands) – kein erneuter Versand, Chris prüft «Gesendet».");
  }

  function requestReissue(rec, reason) {
    const seq = (rec.reissue_seq || 0) + 1;
    writeReissueRequest(onboardingDir, { order_id: rec.order_id, seq, reason, now: now() });
    rec.reissue_seq = seq; rec.reissue_pending = { seq, reason, at: iso() };
    log("info", "onboarding_reissue_requested", { order_id: rec.order_id, seq, reason });
  }

  // ---------- eine neue Kundennachricht ----------
  async function handleMessage(id, o, m) {
    let rec = st.records[id];
    const t = iso();
    const mark = (result) => { rec.processed[m.messageId] = { at: t, result }; rec.updated_at = t; persist(); };
    const from = normEmail(m.from), rt = m.replyTo ? normEmail(m.replyTo) : null;
    if (BOUNCE_RE.test(m.from)) { mark("bounce"); await inform(rec, "Zustellproblem an die Kundenadresse"); return "next"; }
    if (AUTO_SUBJECT_RE.test(m.subject || "")) { mark("auto_reply"); return "next"; }
    // Nur der bestätigte Kunde – fremde/abweichende Absender werden nie beantwortet (§54).
    if (from !== rec.customer_email || (rt && rt !== rec.customer_email)) { mark("foreign_sender_blocked"); await inform(rec, "Nachricht von einer anderen Adresse im Auftrags-Thread – nicht beantwortet"); return "next"; }
    if (C.HALT_STATES.includes(rec.state)) { mark("halted"); await inform(rec, "Neue Kundennachricht – Dialog wartet auf Chris"); return "next"; }
    const text = C.newCustomerText(m.body || "");
    const stateForPre = rec.brief?.status === "WAITING_FOR_CONFIRMATION" ? "WAITING_FOR_CONFIRMATION" : rec.state;
    const pre = C.preclassify(text, { state: stateForPre });
    let res = C.decide({ rec, order: o, text, pre, now: now() });
    if (res.result === "needs_extraction") {
      if (typeof extract !== "function") {
        if (!rec.ai_paused_since) { rec.ai_paused_since = t; persist(); await inform(rec, "KI-Extraktion nicht verfügbar – Kundenantwort wartet"); }
        return "stop";
      }
      let x;
      try { x = await extract(C.extractionTask({ locale: rec.locale, state: stateForPre, open_items: C.openItems(rec.brief), customer_message: text })); }
      catch (e) {
        // KI/API nicht verfügbar: keine schlechte automatische Antwort – Nachricht bleibt unbearbeitet (ONBOARDING_AI_PAUSED).
        const first = !rec.ai_paused_since;
        rec.ai_paused_since ||= t; rec.updated_at = t; persist();
        log("warn", "onboarding_ai_paused", { order_id: id, code: String(e?.code || "AI_UNAVAILABLE").slice(0, 40) });
        if (first) await inform(rec, "KI nicht verfügbar – Onboarding pausiert, Kundenantwort wird später beantwortet");
        return "stop";
      }
      if (rec.ai_paused_since) { delete rec.ai_paused_since; log("info", "onboarding_ai_resumed", { order_id: id }); }
      const v = C.validateExtraction(x);
      res = v.ok ? C.decide({ rec, order: o, text, pre, extraction: x, now: now() })
        : { rec: { ...structuredClone(rec), state: "MANUAL_REVIEW_REQUIRED", manual_reason: `KI-Antwort ungültig (${v.reason}) – nichts gesendet, Chris prüft.` }, reply: null, escalate: `KI-Antwort ungültig (${v.reason})`, reissue: null, result: "invalid_ai_output" };
      if (res.result === "needs_extraction") res = { rec: { ...structuredClone(rec), state: "MANUAL_REVIEW_REQUIRED", manual_reason: "Kundenantwort nicht eindeutig – Chris prüft." }, reply: null, escalate: "Kundenantwort nicht eindeutig", reissue: null, result: "unclear_review" };
    }
    const next = res.rec;
    if (res.reissue) requestReissue(next, res.reissue);
    if (res.escalate) await inform(next, res.escalate);
    log("info", "onboarding_message", { order_id: id, result: res.result, reply: res.reply?.kind || null }); // nie Inhalte
    if (res.reply) {
      const body = C.renderReply(res.reply, { order: o, rec: next });
      return (await sendInThread(id, { key: `reply:${m.messageId}`, msgId: m.messageId, body, next, result: res.result, replyKind: res.reply.kind })) === "done" ? "next" : "stop";
    }
    next.processed[m.messageId] = { at: t, result: res.result };
    next.updated_at = t;
    st.records[id] = next; persist();
    return "next";
  }

  async function maybeReminder(id, o) {
    const rec = st.records[id];
    if (rec.reissue_pending) {
      if (+now() - Date.parse(rec.reissue_pending.at) < REISSUE_WAIT_MS) return;
      rec.reissue_pending = null; persist();
    }
    const due = C.reminderDue(rec, o, now());
    if (!due) return;
    const t = iso();
    const accessMissing = rec.kind === "FIX" && ["ACCESS_MISSING", "ACCESS_LINK_SENT", "ACCESS_LINK_EXPIRED"].includes(o.access_status);
    if (due.exhausted || (o.access_status === "ACCESS_LINK_EXPIRED" && (rec.reissues || 0) >= C.MAX_AUTO_REISSUES)) {
      rec.reminders_exhausted_at = t; rec.updated_at = t; persist();
      await inform(rec, due.exhausted ? "Keine Kundenantwort nach drei Erinnerungen – keine weiteren automatischen Reminder" : "Sicherer Link mehrfach abgelaufen – Chris klärt mit dem Kunden");
      return;
    }
    // Abgelaufener Link: der neue Link (Repair-Service, bestehende Tokenregeln) IST die Erinnerung.
    if (o.access_status === "ACCESS_LINK_EXPIRED") { requestReissue(rec, "reminder"); persist(); return; }
    const b = rec.brief;
    const need = b.status === "WAITING_FOR_CONFIRMATION" ? "confirmation" : C.openItems(b).length ? "items" : b.status === "OPEN" ? "content_answer" : null;
    if (!need && !accessMissing) return;
    const reply = { kind: "REMINDER", need, items: need === "items" ? C.openItems(b) : [], summary: need === "confirmation" ? b.items : [], access_missing: accessMissing, expires_at: o.access_link_expires_at || null };
    const next = structuredClone(rec);
    await sendInThread(id, { key: `reminder:${due.n}`, body: C.renderReply(reply, { order: o, rec }), next, result: `reminder_${due.n}`, replyKind: "REMINDER", reminderN: due.n });
  }

  async function processRecord(id, o) {
    const rec = st.records[id];
    if (!o) {
      if (!C.HALT_STATES.includes(rec.state)) { halt(rec, "MANUAL_REVIEW_REQUIRED", "Auftrag nicht mehr eindeutig zuordenbar (fehlt im Auftragsstand)."); persist(); await inform(rec, rec.manual_reason); }
      return;
    }
    rec.access_status = o.access_status;
    if (o.terminal) { rec.state = "COMPLETED"; rec.completed_at = iso(); if (["CONFIRMED", "NO_CONTENT_CHANGES"].includes(rec.brief?.status)) rec.brief.completed = true; rec.updated_at = iso(); persist(); return; }
    if (rec.pending && (await resolvePending(id)) !== "done") return;
    let thread;
    try { thread = await gmail.readThread(rec.thread_id); }
    catch (e) {
      if (TRANSIENT_RE.test(String(e.message))) throw e;
      if (!C.HALT_STATES.includes(rec.state)) { halt(st.records[id], "MANUAL_REVIEW_REQUIRED", "Auftrags-Thread nicht mehr eindeutig lesbar – kein neuer Thread."); persist(); await inform(st.records[id], st.records[id].manual_reason); }
      return;
    }
    const cur = st.records[id];
    const bound = Date.parse(cur.bound_at) - 120_000;
    const msgs = (thread.messages || []).filter((m) => !m.draft && !m.sent).sort((a, b) => a.internalDate - b.internalDate);
    let changed = false;
    for (const m of msgs) if (!cur.processed[m.messageId] && m.internalDate < bound) { cur.processed[m.messageId] = { at: iso(), result: "pre_binding" }; changed = true; }
    if (changed) persist();
    const fresh = msgs.filter((m) => !st.records[id].processed[m.messageId]);
    for (const m of fresh) if ((await handleMessage(id, o, m)) === "stop") return;
    if (!fresh.length) await maybeReminder(id, o);
  }

  // Befehle von Chris (CLI schreibt Dateien, der Worker wendet sie an – ein Schreiber für onboarding.json).
  function applyCommands() {
    const cdir = path.join(dir, COMMANDS_DIR);
    let names = [];
    try { names = fs.readdirSync(cdir).filter((n) => n.endsWith(".json")).sort(); } catch { return; }
    for (const n of names) {
      const c = readJson(path.join(cdir, n), null);
      try { fs.rmSync(path.join(cdir, n), { force: true }); } catch {}
      const rec = c && st.records[c.order_id];
      if (!rec) continue;
      const t = iso();
      if (c.op === "no_content_changes") { rec.brief.status = "NO_CONTENT_CHANGES"; rec.brief.customer_requested_content_changes = false; rec.brief.items = []; }
      if (["no_content_changes", "resume"].includes(c.op)) {
        if (["MANUAL_REVIEW_REQUIRED", "WAITING_CUSTOMER_MANUAL_REVIEW"].includes(rec.state) || rec.reminders_exhausted_at) rec.state = "WAITING_FOR_CUSTOMER_INFO";
        delete rec.reminders_exhausted_at; delete rec.ai_paused_since; rec.manual_reason = null; rec.reminders = { count: 0, last_at: t };
        rec.chris_actions = [...(rec.chris_actions || []), { at: t, op: c.op, reason: String(c.reason || "").slice(0, 200) }].slice(-20);
        rec.updated_at = t;
        log("info", "onboarding_chris_command", { order_id: rec.order_id, op: c.op });
      }
    }
  }

  async function process() {
    load();
    const ex = orders();
    applyCommands();
    // Beantwortete Link-Anfragen aufräumen (der Repair-Service quittiert in orders.json).
    for (const r of listReissueRequests(onboardingDir)) {
      const done = ex.orders?.[r.order_id]?.reissues?.[r.seq];
      if (!done) continue;
      removeReissueRequest(onboardingDir, r);
      const rec = st.records[r.order_id];
      if (rec?.reissue_pending?.seq === r.seq && done !== "sent") rec.reissue_pending = null;
    }
    persist();
    const ids = Object.keys(st.records).filter((id) => st.records[id].state !== "COMPLETED").sort();
    let start = ids.findIndex((id) => id > String(st.cursor || ""));
    if (start < 0) start = 0;
    const batch = ids.length ? Array.from({ length: Math.min(maxReads, ids.length) }, (_, i) => ids[(start + i) % ids.length]) : [];
    const out = { records: ids.length, processed: 0, degraded: false };
    for (const id of batch) {
      try { await processRecord(id, ex.orders?.[id]); out.processed++; }
      catch (e) {
        if (TRANSIENT_RE.test(String(e.message))) { out.degraded = true; log("warn", "onboarding_gmail_degraded", { order_id: id }); break; }
        log("error", "onboarding_record_failed", { order_id: id, error: String(e.message).slice(0, 160) });
      }
      st.cursor = id; persist();
    }
    for (const rec of Object.values(st.records)) { rec.state = C.HALT_STATES.includes(rec.state) ? rec.state : C.deriveState(rec, ex.orders?.[rec.order_id]); writeBrief(onboardingDir, C.briefExport(rec)); }
    persist();
    return out;
  }

  // Öffentliche Sicht je Auftrag fürs Dashboard/CRM (Allowlist in onboarding-core.publicOnboarding).
  function publicByOrder() {
    const ex = orders(), out = {};
    for (const rec of Object.values(load().records)) out[rec.order_id] = C.publicOnboarding(rec, ex.orders?.[rec.order_id] || null);
    return out;
  }
  function status() {
    const recs = Object.values(load().records), ex = orders(), by = {};
    for (const r of recs) { const s = C.HALT_STATES.includes(r.state) ? r.state : C.deriveState(r, ex.orders?.[r.order_id]); by[s] = (by[s] || 0) + 1; }
    return { records: recs.length, states: by, pending_sends: recs.filter((r) => r.pending).length };
  }
  return { route, onSent, threadLost, process, isBoundThread: (threadId) => boundThreads().get(threadId) || null, boundThreads, publicByOrder, status };
}

// Snapshot-Erweiterung (server-agent): je Auftrag die öffentliche Onboarding-Sicht anhängen (nur Allowlist).
export function attachOnboarding(view, byOrder = {}) {
  if (!view || !Array.isArray(view.orders)) return view;
  return { ...view, orders: view.orders.map((o) => (byOrder[o.order_id] ? { ...o, onboarding: byOrder[o.order_id] } : o)) };
}

// ---------- Kommandozeile (im Mail-Worker-Container) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const DIR = path.join(process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets"), "mail_worker");
  const [cmd, id] = process.argv.slice(2);
  const flag = (n) => { const a = process.argv.slice(2), i = a.indexOf("--" + n); return i >= 0 ? a[i + 1] : undefined; };
  const st = loadOnboarding(DIR);
  const ex = readOrdersExport(onboardingDirOf(process.env.JARVIS_REPAIR_OUTBOX || null));
  const run = () => {
    if (cmd === "status") {
      const rows = Object.values(st.records).map((r) => ({ order_id: r.order_id, kind: r.kind, market: r.market, state: C.HALT_STATES.includes(r.state) ? r.state : C.deriveState(r, ex.orders?.[r.order_id]),
        brief: r.brief?.status, open_items: C.openItems(r.brief).length, reminders: r.reminders?.count || 0, pending: !!r.pending }));
      return { records: rows.length, orders: rows };
    }
    if (!ORDER_ID_RE.test(String(id || ""))) throw new Error("Auftrags-ID fehlt/ungültig.");
    const rec = st.records[id];
    if (!rec) throw new Error("Kein Onboarding für diesen Auftrag.");
    if (cmd === "show") return C.publicOnboarding(rec, ex.orders?.[id] || null);
    if (["no-content-changes", "resume"].includes(cmd)) {
      if (!String(flag("reason") || "").trim()) throw new Error('Begründung ist Pflicht: --reason "<grund>".');
      writeAtomic(path.join(DIR, COMMANDS_DIR, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`), { op: cmd === "resume" ? "resume" : "no_content_changes", order_id: id, reason: String(flag("reason")).slice(0, 200), at: new Date().toISOString() });
      return `Befehl vorgemerkt – der Mail-Worker übernimmt ihn im nächsten Durchlauf (${cmd}).`;
    }
    throw new Error("Befehle: status | show <id> | no-content-changes <id> --reason TEXT | resume <id> --reason TEXT");
  };
  try { const r = run(); console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2)); }
  catch (e) { console.error("Fehler: " + e.message); process.exit(1); }
}
