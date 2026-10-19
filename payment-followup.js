// TF-079: Zahlungsanfrage + Erinnerungen für bestätigte, noch UNBEZAHLTE Schweizer Aufträge – Mail-Worker-Seite (einzige Sender Authority).
//
//   Ablauf je Auftrag (Auftragsfakten aus onboarding/orders.json des Repair-Service, nur lesen):
//     1. Auftrag bestätigt + Zahlungsschwelle NICHT erfüllt + CH + gültige Kundenadresse → GENAU EINE Zahlungsanfrage mit dem Stripe-Link des Pakets
//        (payment-links.js, mit client_reference_id = order_id, damit der Webhook die Zahlung dem Auftrag zuordnet) als neuer Auftrags-Thread.
//     2. Keine Zahlung → höchstens DREI Erinnerungen im selben Thread (48 h, +72 h, +7 d nach der jeweils letzten Mail; nur 08–19 Uhr Zürich, nie sonntags).
//        Danach Ende (EXHAUSTED) + Meldung an Chris – nie ein vierter Reminder.
//     3. Zahlungsschwelle erfüllt → PAID: dieses Modul schweigt, das Onboarding (onboarding-dialogue.js) führt den Auftrag bis zum Abschluss weiter.
//   Antwortet der Kunde im Thread: Stopp/Storno → STOPPED (Chris informiert). «Link bitte»/einfache Preisfrage → derselbe Link erneut (höchstens 3×).
//   Alles andere (Rabatt, Rechnung, IBAN, Vertrag, «ich habe bezahlt», Zugangsdaten, unklar) → MANUAL: keine automatische Mail mehr, Chris antwortet.
//
//   Sicherheit: Standardmässig AUS (config.json paymentFollowup.enabled). Beim ersten Lauf werden alle bereits offenen Aufträge als LEGACY markiert und nie
//   nachträglich angeschrieben. Jede Mail: Claim (pending) VOR Gmail, Entwurf → Send-Lock → sendDraft, unklarer Ausgang → nie wiederholen (MANUAL).
//   Nie gespeichert: Mailtexte, Links. Gespeichert: Statuswörter, Zähler, Zeitpunkte, Thread-/Entwurfs-IDs.
//
//   node payment-followup.js status        Zähler + Aufträge (nur Status)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newCustomerText, preclassify, normEmailAddr, validEmail } from "./onboarding-core.js";
import { readOrdersExport } from "./onboarding-store.js";
import { offerInfo, formatMoney, ORDER_ID_RE } from "./pricing.js";
import { paymentLinkFor, PACKAGE_NAMES_DE } from "./payment-links.js";

export const PAYMENT_FOLLOWUP_FILE = "payment_followups.json";
export const PAYMENT_CLASS = "CUSTOMER_PAYMENT_REQUEST";
export const DEFAULT_REMINDER_HOURS = Object.freeze([48, 72, 168]);
export const EXHAUST_AFTER_HOURS = 168;
export const MAX_RESENDS = 3;
export const ACTIVE_STATES = Object.freeze(["REQUEST_DUE", "WAITING_PAYMENT"]);
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|timeout|aborted/i;
const SAFE_RETRY_RE = /nicht gesendet|andere Sendung läuft|Register gesperrt|Tageslimit/i;
const BOUNCE_RE = /mailer-daemon|postmaster/i;
const AUTO_SUBJECT_RE = /(automatische antwort|abwesenheit|out of office|automatic reply|auto-?reply|réponse automatique|risposta automatica)/i;
const CREATING_STALE_MS = 10 * 60_000;
const PAID_CLAIM_RE = /\b(?:bereits|schon|habe|hab|ist|wurde|sind)\b[^.\n]{0,30}\b(?:bezahlt|überwiesen|gezahlt|beglichen|angewiesen)\b|\b(?:zahlung|überweisung)\b[^.\n]{0,30}\b(?:erfolgt|gemacht|getätigt|ausgelöst|unterwegs)\b/i;
const PAY_HELP_RE = /\b(?:zahlungs-?link|bezahl-?link|payment[- ]?link|link (?:zum|zur|für die) (?:bezahl|zahl)\w*|link (?:bitte|nochmals|nochmal|erneut)|(?:nochmals|nochmal|erneut) (?:den )?link|wie (?:kann|muss|soll) (?:ich|man) (?:das |dies )?(?:bezahlen|zahlen)|wo (?:kann|muss) ich (?:bezahlen|zahlen))\b/i;
const NO_GUARD = Object.freeze({ acquire: async () => ({ ok: true }), done: async () => {} });

const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
function writeAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
export const loadFollowups = (dir) => { const s = readJson(path.join(dir, PAYMENT_FOLLOWUP_FILE), {}) || {}; return { v: 1, activated_at: null, cursor: "", ...s, records: s.records || {} }; };

// Auftrag kommt für eine Zahlungsanfrage in Frage? null = ja, sonst das Wort des Grundes.
export function ineligibleReason(o) {
  if (!o || !ORDER_ID_RE.test(String(o.order_id || ""))) return "invalid";
  if (o.market !== "CH" || offerInfo(o.offer_class)?.market !== "CH") return "not_ch";
  if (!paymentLinkFor(o.offer_class, { orderId: o.order_id })) return "no_link";
  if (o.cancelled) return "cancelled";
  if (o.terminal) return "terminal";
  if (o.payment_gate_met === true) return "paid";
  if (o.order_confirmed !== true) return "not_confirmed";
  if (!validEmail(o.customer_email)) return "no_email";
  return null;
}

// Versandzeit der Erinnerungen: 08:00–18:59 Europe/Zurich, nie sonntags.
export function inReminderWindow(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", weekday: "short", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  return p.weekday !== "Sun" && h >= 8 && h < 19;
}

// ---------- Texte (feste Vorlage, nur Fakten aus pricing.js / payment-links.js) ----------
const cleanName = (s) => String(s || "").replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
export function composePaymentMail({ kind, stage = 0, orderId, offerClass, name = "", email = null, signature = "" }) {
  const info = offerInfo(offerClass), link = paymentLinkFor(offerClass, { orderId, email });
  if (!info || !link) throw new Error("Kein Zahlungslink für dieses Angebot.");
  const pkg = PACKAGE_NAMES_DE[info.kind], price = formatMoney(info.price, info.currency), n = cleanName(name);
  const hello = n ? `Guten Tag ${n}` : "Guten Tag";
  const linkBlock = [`${pkg} (Festpreis ${price}) – sicher bezahlen über diesen Link:`, link];
  let lines;
  if (kind === "request") lines = [`vielen Dank für Ihren Auftrag ${orderId}.`, "", ...linkBlock, "", "Sobald die Zahlung bei uns eingegangen ist, melde ich mich mit den nächsten Schritten. Bei Fragen antworten Sie einfach auf diese E-Mail."];
  else if (kind === "resend") lines = ["gerne – hier nochmals der Link zur Zahlung Ihres Auftrags " + orderId + ":", "", ...linkBlock, "", "Sobald die Zahlung bei uns eingegangen ist, melde ich mich mit den nächsten Schritten."];
  else if (stage === 1) lines = [`ich wollte kurz nachfragen, ob bei der Zahlung für Ihren Auftrag ${orderId} alles geklappt hat. Hier nochmals der Link:`, "", ...linkBlock, "", "Falls etwas unklar ist, antworten Sie einfach auf diese E-Mail."];
  else if (stage === 2) lines = [`Ihr Auftrag ${orderId} ist noch nicht bezahlt – ohne Zahlungseingang kann ich nicht starten. Der Link:`, "", ...linkBlock, "", "Falls Sie Fragen haben, antworten Sie einfach auf diese E-Mail."];
  else lines = [`dies ist meine letzte Erinnerung zu Ihrem Auftrag ${orderId}. Wenn Sie ihn nicht mehr wünschen, genügt eine kurze Antwort – dann vermerke ich das. Andernfalls geht es hier zur Zahlung:`, "", ...linkBlock];
  const body = [hello, "", ...lines, "", "Freundliche Grüsse", ...(signature ? ["", signature] : [])].join("\n");
  return { subject: `Ihr Auftrag ${orderId} – Zahlung`, body };
}

export function createPaymentFollowup({ dir, onboardingDir, gmail, sender = () => ({}), settings = () => ({}), now = () => new Date(), log = () => {}, notify = async () => {}, sendGuard = NO_GUARD } = {}) {
  if (!dir || !onboardingDir || !gmail) throw new Error("Zahlungsnachfassung: Verzeichnisse/Gmail fehlen.");
  const file = path.join(dir, PAYMENT_FOLLOWUP_FILE);
  let st = null;
  const load = () => (st = loadFollowups(dir));
  const persist = () => writeAtomic(file, st);
  const iso = () => now().toISOString();
  const orders = () => readOrdersExport(onboardingDir).orders || {};
  const inform = async (rec, reason) => {
    log("warn", "payment_followup_chris", { order_id: rec.order_id, reason: String(reason).slice(0, 120) });
    try { await notify({ order_id: rec.order_id, company: rec.company || "", threadId: rec.thread_id || null, reason: `Zahlung: ${String(reason).slice(0, 110)}` }); }
    catch (e) { log("error", "payment_followup_notify_failed", { error: String(e.message).slice(0, 120) }); }
  };
  const setState = (rec, state, reason = null) => { rec.state = state; rec.reason = reason ? String(reason).slice(0, 200) : null; rec.updated_at = iso(); };
  const signatureOf = () => { const s = sender() || {}; return s.signature?.trim() || [s.name, s.company, s.email].filter(Boolean).join("\n"); };
  const reminderHours = () => { const h = settings()?.reminderHours; return Array.isArray(h) && h.length && h.every((x) => Number.isFinite(x) && x >= 1) ? h.slice(0, 3) : DEFAULT_REMINDER_HOURS; };

  const newRecord = (o) => ({ order_id: o.order_id, customer_email: normEmailAddr(o.customer_email), offer_class: o.offer_class, contact_name: cleanName(o.contact_name) || null,
    company: o.company || null, state: "REQUEST_DUE", thread_id: null, stage: 0, resends: 0, requested_at: null, last_sent_at: null, processed: {}, pending: null, reason: null,
    created_at: iso(), updated_at: iso() });
  const legacyRecord = (o) => ({ order_id: o.order_id, state: "LEGACY", reason: "bei Aktivierung bereits offen – nie angeschrieben", processed: {}, created_at: iso(), updated_at: iso() });

  // ---------- Versand (genau einmal) ----------
  function finish(id, info) {
    const rec = st.records[id], p = rec.pending, t = iso();
    if (p.kind === "request") { rec.thread_id = info?.threadId || p.thread_id || null; rec.state = "WAITING_PAYMENT"; rec.stage = 0; rec.requested_at = t; }
    else if (p.kind === "reminder") rec.stage = (rec.stage || 0) + 1;
    else if (p.kind === "resend") rec.resends = (rec.resends || 0) + 1;
    if (p.msg_id) rec.processed[p.msg_id] = { at: t, result: p.kind === "resend" ? "resent" : "answered" };
    rec.last_sent_at = t; rec.pending = null; rec.updated_at = t;
    persist();
    log("info", "payment_followup_sent", { order_id: id, kind: p.kind, stage: rec.stage });
    return "done";
  }
  async function unclear(id, why) {
    const rec = st.records[id], p = rec.pending;
    if (p?.msg_id) rec.processed[p.msg_id] = { at: iso(), result: "send_unclear" };
    rec.pending = null; setState(rec, "MANUAL", why); persist();
    await inform(rec, why);
    return "stop";
  }
  async function sendPending(id) {
    const rec = st.records[id], p = rec.pending, lockKey = `pay-send:${id}:${p.key}`;
    p.status = "sending"; p.send_at = iso(); persist(); // VOR dem Versand – ein Neustart sendet nie ein zweites Mal
    let lock;
    try { lock = await sendGuard.acquire({ key: lockKey, threadId: p.thread_id || rec.thread_id || null, messageId: null }); }
    catch (e) { p.status = "drafted"; persist(); log("warn", "payment_followup_lock_unreachable", { order_id: id }); return "stop"; }
    if (!lock.ok) {
      if (lock.final) return unclear(id, "Send-Lock gehalten bzw. bereits gesendet – nicht wiederholt, Chris prüft «Gesendet».");
      p.status = "drafted"; persist(); return "stop";
    }
    let info;
    try { info = await gmail.sendDraft(p.draft_id); }
    catch (e) {
      try { await sendGuard.done(lockKey, "FAILED"); } catch {}
      if (SAFE_RETRY_RE.test(String(e.message))) { p.status = "drafted"; persist(); log("warn", "payment_followup_send_deferred", { order_id: id }); return "stop"; }
      return unclear(id, TRANSIENT_RE.test(String(e.message)) ? "Versandstatus unklar – kein erneuter Versand, Chris prüft «Gesendet»." : "Versand fehlgeschlagen – Chris prüft.");
    }
    try { await sendGuard.done(lockKey, "SENT"); } catch {}
    return finish(id, info);
  }
  async function deliver(id, { key, kind, msgId = null, mail }) {
    const rec = st.records[id];
    rec.pending = { key, kind, msg_id: msgId, status: "creating", at: iso() };
    persist();
    let d;
    try {
      d = kind === "request"
        ? await gmail.createDraft({ to: rec.customer_email, subject: mail.subject, body: mail.body, messageClass: PAYMENT_CLASS, orderId: id })
        : await gmail.replyDraftInThread(rec.thread_id, { to: rec.customer_email, body: mail.body, messageClass: PAYMENT_CLASS, orderId: id });
    } catch (e) {
      if (TRANSIENT_RE.test(String(e.message))) { log("warn", "payment_followup_draft_deferred", { order_id: id }); return "stop"; } // pending bleibt: Recovery prüft Entwürfe
      rec.pending = null;
      if (msgId) rec.processed[msgId] = { at: iso(), result: "draft_failed" };
      setState(rec, "MANUAL", kind === "request" ? "Zahlungsanfrage konnte nicht erstellt werden" : "Antwort im Zahlungs-Thread nicht möglich (Thread nicht eindeutig) – kein neuer Thread");
      persist(); await inform(rec, rec.reason); return "stop";
    }
    rec.pending = { ...rec.pending, status: "drafted", draft_id: d.draftId, thread_id: d.threadId || null };
    persist();
    return sendPending(id);
  }
  // Nach Neustart: offene Sendung exakt abschliessen – nie doppelt.
  async function resolvePending(id) {
    const rec = st.records[id], p = rec.pending;
    const reg = typeof gmail.listOwned === "function" ? gmail.listOwned() : { drafts: {}, sent: {} };
    if (p.status === "creating") {
      const found = Object.entries(reg.drafts || {}).find(([, d]) => d.messageClass === PAYMENT_CLASS && d.orderId === id && String(d.createdAt || "") >= p.at);
      if (found) { p.status = "drafted"; p.draft_id = found[0]; p.thread_id = found[1].threadId || null; persist(); return sendPending(id); }
      if (+now() - Date.parse(p.at) > CREATING_STALE_MS) { rec.pending = null; persist(); return "done"; } // nichts entstanden → neu entscheiden
      return "stop";
    }
    if (p.status === "drafted") return sendPending(id);
    const sent = Object.values(reg.sent || {}).find((s) => s.fromDraft === p.draft_id);
    if (sent) return finish(id, sent);
    return unclear(id, "Versandstatus unklar (Neustart während des Versands) – kein erneuter Versand, Chris prüft «Gesendet».");
  }

  // ---------- Kundenantworten ----------
  async function handleMessage(id, o, m) {
    const rec = st.records[id], t = iso();
    const mark = (result) => { rec.processed[m.messageId] = { at: t, result }; rec.updated_at = t; persist(); };
    const from = normEmailAddr(m.from), rt = m.replyTo ? normEmailAddr(m.replyTo) : null;
    if (BOUNCE_RE.test(m.from)) { mark("bounce"); await inform(rec, "Zustellproblem an die Kundenadresse"); return "next"; }
    if (AUTO_SUBJECT_RE.test(m.subject || "")) { mark("auto_reply"); return "next"; }
    if (from !== rec.customer_email || (rt && rt !== rec.customer_email)) { mark("foreign_sender_blocked"); await inform(rec, "Nachricht von einer anderen Adresse im Zahlungs-Thread – nicht beantwortet"); return "next"; }
    const text = newCustomerText(m.body || "");
    const pre = preclassify(text);
    if (["STOP", "CANCELLATION_REQUEST"].includes(pre.cls)) { mark("stop"); setState(rec, "STOPPED", "Kunde möchte keine weiteren Nachrichten bzw. storniert"); persist(); await inform(rec, rec.reason); return "stop"; }
    const manual = (why, result) => { mark(result); setState(rec, "MANUAL", why); persist(); return inform(rec, why).then(() => "stop"); };
    if (["SENSITIVE_CREDENTIAL_SENT", "INJECTION", "LEGAL_QUESTION"].includes(pre.cls) || (pre.cls === "PAYMENT_QUESTION" && pre.manual)) return manual("Kundenantwort zu Preis/Recht/Zugang – Chris antwortet persönlich", "manual");
    if (PAID_CLAIM_RE.test(text)) return manual("Kunde meldet eine Zahlung – Zahlungseingang prüfen (payments.js / payment-reconcile.js)", "customer_says_paid");
    if ((pre.cls === "PAYMENT_QUESTION" || PAY_HELP_RE.test(text)) && (rec.resends || 0) < MAX_RESENDS) {
      const mail = composePaymentMail({ kind: "resend", orderId: id, offerClass: rec.offer_class, name: rec.contact_name || o.contact_name, email: rec.customer_email, signature: signatureOf() });
      return (await deliver(id, { key: `resend:${m.messageId}`, kind: "resend", msgId: m.messageId, mail })) === "done" ? "next" : "stop";
    }
    return manual("Kundenantwort im Zahlungs-Thread – Chris antwortet persönlich", "manual");
  }

  async function maybeReminder(id, o) {
    const rec = st.records[id], hours = reminderHours(), stage = rec.stage || 0;
    const since = +now() - Date.parse(rec.last_sent_at || rec.requested_at || 0);
    if (stage >= hours.length) {
      if (since >= EXHAUST_AFTER_HOURS * 3600_000) { setState(rec, "EXHAUSTED", "Keine Zahlung nach drei Erinnerungen – keine weiteren automatischen Mails"); persist(); await inform(rec, rec.reason); }
      return "next";
    }
    if (since < hours[stage] * 3600_000 || !inReminderWindow(now())) return "next";
    const mail = composePaymentMail({ kind: "reminder", stage: stage + 1, orderId: id, offerClass: rec.offer_class, name: rec.contact_name || o.contact_name, email: rec.customer_email, signature: signatureOf() });
    return (await deliver(id, { key: `reminder:${stage + 1}`, kind: "reminder", mail })) === "done" ? "next" : "stop";
  }

  async function processRecord(id, o) {
    const rec = st.records[id];
    if (rec.pending && (await resolvePending(id)) !== "done") return;
    if (rec.state === "REQUEST_DUE") {
      const mail = composePaymentMail({ kind: "request", orderId: id, offerClass: rec.offer_class, name: rec.contact_name || o.contact_name, email: rec.customer_email, signature: signatureOf() });
      await deliver(id, { key: "request", kind: "request", mail });
      return;
    }
    if (rec.state !== "WAITING_PAYMENT") return;
    let thread;
    try { thread = await gmail.readThread(rec.thread_id); }
    catch (e) {
      if (TRANSIENT_RE.test(String(e.message))) throw e;
      setState(rec, "MANUAL", "Zahlungs-Thread nicht mehr eindeutig lesbar – kein neuer Thread"); persist(); await inform(rec, rec.reason); return;
    }
    const bound = Date.parse(rec.requested_at || rec.created_at) - 120_000;
    const msgs = (thread.messages || []).filter((m) => !m.draft && !m.sent).sort((a, b) => a.internalDate - b.internalDate);
    for (const m of msgs) if (!rec.processed[m.messageId] && m.internalDate < bound) rec.processed[m.messageId] = { at: iso(), result: "pre_binding" };
    const fresh = msgs.filter((m) => !rec.processed[m.messageId]);
    for (const m of fresh) { if ((await handleMessage(id, o, m)) === "stop") return; if (st.records[id].state !== "WAITING_PAYMENT") return; }
    if (!fresh.length) await maybeReminder(id, o);
  }

  // ---------- Durchlauf ----------
  async function process() {
    const cfg = settings() || {};
    if (cfg.enabled !== true) return { enabled: false, processed: 0 };
    load();
    const all = orders(), t = iso();
    if (!st.activated_at) {
      // Aktivierung: bereits offene Aufträge nie nachträglich anschreiben.
      st.activated_at = t;
      for (const o of Object.values(all)) if (!ineligibleReason(o)) st.records[o.order_id] = legacyRecord(o);
      persist();
      log("info", "payment_followup_activated", { legacy: Object.keys(st.records).length });
      return { enabled: true, activated: true, legacy: Object.keys(st.records).length, processed: 0 };
    }
    for (const o of Object.values(all)) {
      const why = ineligibleReason(o), rec = st.records[o.order_id];
      if (!rec) { if (!why) st.records[o.order_id] = newRecord(o); continue; }
      if (["LEGACY", "PAID"].includes(rec.state)) continue;
      if (why === "paid" && rec.state !== "PAID") { setState(rec, "PAID"); rec.reason = null; continue; }
      if (["cancelled", "terminal"].includes(why) && rec.state !== "STOPPED") { setState(rec, "STOPPED", "Auftrag storniert bzw. abgeschlossen"); continue; }
      if (ACTIVE_STATES.includes(rec.state) && o.customer_email && normEmailAddr(o.customer_email) !== rec.customer_email) { setState(rec, "MANUAL", "Kundenadresse des Auftrags hat sich geändert – Chris prüft"); }
    }
    persist();
    const ids = Object.keys(st.records).filter((id) => ACTIVE_STATES.includes(st.records[id].state) || st.records[id].pending).sort();
    let start = ids.findIndex((id) => id > String(st.cursor || ""));
    if (start < 0) start = 0;
    const max = Math.max(1, Math.min(20, Number(cfg.maxPerTick) || 5));
    const batch = ids.length ? Array.from({ length: Math.min(max, ids.length) }, (_, i) => ids[(start + i) % ids.length]) : [];
    const out = { enabled: true, records: ids.length, processed: 0, degraded: false };
    for (const id of batch) {
      const o = all[id];
      try { if (o) await processRecord(id, o); out.processed++; }
      catch (e) {
        if (TRANSIENT_RE.test(String(e.message))) { out.degraded = true; log("warn", "payment_followup_gmail_degraded", { order_id: id }); break; }
        log("error", "payment_followup_record_failed", { order_id: id, error: String(e.message).slice(0, 160) });
      }
      st.cursor = id; persist();
    }
    return out;
  }

  const boundThreads = () => { const m = new Map(); for (const r of Object.values(load().records)) if (r.thread_id && !["LEGACY"].includes(r.state)) m.set(r.thread_id, r.order_id); return m; };
  function status() {
    const recs = Object.values(load().records), by = {};
    for (const r of recs) by[r.state] = (by[r.state] || 0) + 1;
    return { activated_at: st.activated_at, records: recs.length, states: by, pending_sends: recs.filter((r) => r.pending).length };
  }
  return { process, boundThreads, status };
}

// ---------- Kommandozeile (im Mail-Worker-Container) ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.dirname(fileURLToPath(import.meta.url));
  const DIR = path.join(process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets"), "mail_worker");
  if (process.argv[2] === "status") {
    const s = loadFollowups(DIR);
    const rows = Object.values(s.records).map((r) => ({ order_id: r.order_id, state: r.state, stage: r.stage ?? null, resends: r.resends ?? null, last_sent_at: r.last_sent_at || null, reason: r.reason || null }));
    console.log(JSON.stringify({ activated_at: s.activated_at, records: rows.length, orders: rows }, null, 2));
  } else { console.error("Befehle: status"); process.exit(1); }
}
