// TF-079 – Kontaktformular → Gespräch → bestätigter «Check & Reparatur»-Auftrag (Mail-Worker-Seite, Mail-Worker bleibt EINZIGE Sender Authority).
//
// Verbindet bestehende Bausteine, ersetzt keinen:
//   contact-form.js      erste automatische Antwort (TF-077B/D, genau einmal) – bei «Interesse an: Check & Reparatur» mit den nächsten Schritten
//   DIESES MODUL         Gespräch im Thread dieser Antwort BIS ein Auftrag existiert und der Onboarding-Dialog den Thread übernimmt:
//                        Routinefragen (Zugang, Zahlung, nächste Schritte), ausdrückliche Auftragsbestätigung → Auftragsbitte an den Repair-Service
//                        (onboarding/cf_orders), Bestätigungsmail genau einmal, Statuswort fürs CRM.
//   repair-service.js    legt den Auftrag GENAU EINMAL an (onboarding-repair.applyContactFormOrders) – Zahlungsschwelle CHF 240, sicherer Link,
//                        Zugangsprüfung, Backup, Reparatur, Validierung, Retest, Lieferung und Tresor-Zerstörung laufen unverändert (repair-workflow.js).
//   onboarding-dialogue  route() legt die erste Auftrags-Mail (Plattform-Frage bzw. sicherer Link) in DIESEN Thread (contactThreadFor) und führt ab
//                        dann den Dialog (Inhaltsänderungen, Passwort-per-Mail, Stopp …). Dieses Modul liest den Thread danach nicht mehr (HANDED_OFF).
//
// Fail closed:
//   - nur verifizierte, echte (keine Test-)Einsendungen mit eindeutigem «Interesse an» (journeyEligible) und Website-Domain.
//   - Interesse ≠ Auftrag ≠ Freigabe: der Auftrag entsteht nur aus einer AUSDRÜCKLICHEN Bestätigung des Kunden (Absender == Kundenadresse, eigener
//     Thread); die Reparaturfreigabe gibt der Kunde weiterhin nur im sicheren Formular für genau diese Domain.
//   - nie ein Link/Token/Zugangsdatum in diesen Mails; Passwort per Mail → Hinweis ohne Wiederholung, nichts gespeichert.
//   - Preis-/Rabatt-/Rechts-/Bankfragen, Storno, Injection, unklare Antworten → Chris (nie geraten). Stopp → kein weiterer automatischer Kontakt.
//   - genau eine Mail je Ereignis (pending: creating → drafted → sending → sent; unklar → nie wiederholen, Chris). Höchstens MAX_AUTO_REPLIES.
//   - Gespeichert (contact_forms.json, item.journey): nur Zustände, IDs, Zeitpunkte, Ergebniswörter – nie Mailtexte.
import * as C from "./onboarding-core.js";
import { offerInfo } from "./pricing.js";
import { CONTACT_FORMS_FILE, CONTACT_FORMS_PUBLIC_FILE, loadContactForms, publicContactForms, journeyEligible, websiteDomain, STATES, SECURE_ACCESS_DE,
  NO_PASSWORD_MAIL_DE, ORDER_CONFIRM_PHRASE_DE, E2E_TEST_LINE_DE } from "./contact-form.js";
import { readOrdersExport, writeContactOrderRequest, readContactOrderResults, readPaymentLinks } from "./onboarding-store.js";
import { isE2eDomain, isE2eMailbox } from "./e2e-test.js";

export const JOURNEY_STATES = Object.freeze(["WAITING_FOR_CONFIRMATION", "ORDER_REQUESTED", "ORDER_BOUND", "HANDED_OFF", "MANUAL_REVIEW_REQUIRED",
  "CUSTOMER_STOP_REQUESTED", "CANCELLATION_REVIEW_REQUIRED"]);
const READING = new Set(["WAITING_FOR_CONFIRMATION", "ORDER_REQUESTED", "ORDER_BOUND"]);
export const MAX_AUTO_REPLIES = 6;
const CREATING_STALE_MS = 10 * 60_000;
const BIND_GRACE_MS = 120_000;
const FIX_OFFER = "REPAIR_FIX_500";
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|timeout|aborted/i;
const SAFE_RETRY_RE = /nicht gesendet|andere Sendung läuft|Register gesperrt/i;
const BOUNCE_RE = /mailer-daemon|postmaster/i;
const AUTO_SUBJECT_RE = /(automatische antwort|abwesenheit|out of office|automatic reply|auto-?reply)/i;
const REPAIR_RUNNING = new Set(["BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY"]);
const SIG_DE = "Freundliche Grüsse\nChris\nHelvetic Webdesign";
const lc = (s) => String(s ?? "").trim().toLowerCase();

// ---------- ausdrückliche Auftragsbestätigung (deterministisch, keine KI) ----------
// Gilt nur als Antwort auf unsere ausdrückliche Frage (Zustand WAITING_FOR_CONFIRMATION). Verneinung/Zögern hebt sie immer auf.
const HESITATE_RE = /\b(nicht|kein|keine|noch nicht|später|vielleicht|eventuell|überleg\w*|unsicher|zuerst|vorher|erst wenn|falls)\b/i;
const ORDER_CONFIRM_RE = /\b(ich|wir)\s+(bestätige|bestätigen|erteile|erteilen)\s+(hiermit\s+)?(ihnen\s+)?(den|die|einen)?\s*(auftrag|bestellung|reparatur)\b|\bauftrag\s+(ist\s+)?(hiermit\s+)?(bestätigt|erteilt)\b|\b(ich|wir)\s+(möchte|möchten|will|wollen)\s+(gerne\s+)?(den|die|einen)?\s*(auftrag|check\s*(?:&|und)\s*reparatur|reparatur)\s+(erteilen|bestellen|buchen|beauftragen|in auftrag geben)\b/i;
const BARE_YES = new Set(["ja", "ja bitte", "ja gerne", "gerne", "ja einverstanden", "einverstanden", "ja ich bestätige", "ich bestätige", "bestätigt", "ja bestätigt"]);
export function isOrderConfirmation(text = "") {
  const core = C.coreText(C.newCustomerText(text)).normalize("NFC");
  if (!core || core.length > 400 || HESITATE_RE.test(core)) return false;
  if (ORDER_CONFIRM_RE.test(core)) return true;
  const s = C.normSpace(core).toLowerCase().replace(/[.!,;:"'«»“”()]/g, " ").replace(/\s+/g, " ").replace(/\s*(danke|vielen dank|merci)$/, "").trim();
  return BARE_YES.has(s);
}

// ---------- eine Kundennachricht → Entscheidung (rein) ----------
// Ergebnis: { result, reply?: kind, state?, escalate?, requestOrder?: true }
export function decideJourney({ j, text, order = null }) {
  const pre = C.preclassify(text);
  switch (pre.cls) {
    case "SENSITIVE_CREDENTIAL_SENT": return { result: "sensitive_blocked", reply: "SENSITIVE", sensitive: true };
    case "CANCELLATION_REQUEST": return j.order_id ? { result: "cancellation_review", state: "CANCELLATION_REVIEW_REQUIRED", escalate: "Kunde möchte den Auftrag abbrechen – Chris entscheidet." }
      : { result: "customer_declined", state: "CUSTOMER_STOP_REQUESTED", escalate: "Kunde möchte keinen Auftrag – kein weiterer automatischer Kontakt." };
    case "STOP": return { result: "stop_requested", state: "CUSTOMER_STOP_REQUESTED", escalate: "Kunde wünscht keine weiteren Nachrichten – automatischer Dialog beendet." };
    case "INJECTION": return { result: "injection_blocked", state: "MANUAL_REVIEW_REQUIRED", escalate: "Nachricht enthält Anweisungen an das System bzw. Fragen nach fremden Daten – Chris prüft." };
    case "LEGAL_QUESTION": return { result: "legal_review", state: "MANUAL_REVIEW_REQUIRED", escalate: "Rechtliche Frage – keine Rechtsberatung, Chris prüft." };
    case "EMPTY": return { result: "empty_ignored" };
  }
  if (pre.cls === "PAYMENT_QUESTION" && pre.manual) return { result: "payment_review", state: "MANUAL_REVIEW_REQUIRED", escalate: "Preis-/Zahlungsthema (Rabatt, Refund, Bank, Rechnung, Vertrag) – Chris prüft." };
  if (j.state === "WAITING_FOR_CONFIRMATION" && isOrderConfirmation(text)) return { result: "order_confirmed", requestOrder: true, state: "ORDER_REQUESTED" };
  if (j.state !== "WAITING_FOR_CONFIRMATION" && isOrderConfirmation(text)) return { result: "confirmation_duplicate" }; // Auftrag existiert/entsteht bereits – nie ein zweiter
  if (pre.cls === "PAYMENT_QUESTION") return { result: "price_explained", reply: "PAYMENT_INFO" };
  if (pre.cls === "ACCESS_QUESTION") return { result: "access_explained", reply: "ACCESS_INFO" };
  // Alles andere (Inhaltswünsche vor dem Auftrag, unklare Antworten, Detailfragen) → Chris; der Weg bleibt offen, nichts wird geraten.
  return { result: "unclear_review", escalate: order ? "Kundenantwort im Auftragsverlauf – bitte prüfen" : "Kundenantwort auf «Check & Reparatur» nicht eindeutig – bitte prüfen" };
}

// ---------- Texte (feste Vorlagen DE, keine erfundenen Fakten, nie Zugangslinks/Token) ----------
// TF-080: einzige Ausnahme ist der Stripe-gehostete Zahlungslink (checkout.stripe.com) der Anzahlung – serverseitig erzeugt, nie Bank-/Kartendaten per Mail.
const greet = (it) => { const n = String(it.name || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 80); return n ? `Guten Tag ${n}` : "Guten Tag"; };
const PAY_URL_RE = /^https:\/\/checkout\.stripe\.com\/[^\s<>"']{4,600}$/;
export const NO_CARD_MAIL_DE = "Bitte senden Sie keine Bank- oder Kartendaten per E-Mail.";
export const TEST_PAYMENT_DE = "TESTZAHLUNG – es wird kein echtes Geld belastet.";
const payLines = (fix, pay) => [`Damit wir mit der Reparatur beginnen können, ist zunächst die erste Hälfte des Festpreises (CHF ${fix.deposit}) fällig.`, "",
  ...(pay.test ? [TEST_PAYMENT_DE, ""] : []), "Sie können die Zahlung sicher über folgenden Zahlungslink abschliessen:", "", pay.url, "",
  "Sobald die Zahlung bestätigt ist, erhalten Sie automatisch den sicheren Zugangslink für Ihre Website.", NO_CARD_MAIL_DE];
export function renderJourneyReply(kind, { it, j, order = null, pay = null }) {
  const fix = offerInfo(FIX_OFFER) || { price: 480, deposit: 240 };
  const dom = j.domain;
  const paid = order?.payment_gate_met === true;
  const id = j.order_id ? ` (Auftragsnummer ${j.order_id})` : "";
  const link = pay && PAY_URL_RE.test(String(pay.url || "")) ? pay : null;
  const lines = [greet(it), "", ...(j.test ? [E2E_TEST_LINE_DE, ""] : [])];
  if (kind === "ORDER_CONFIRMED") {
    lines.push(`vielen Dank für Ihre Bestätigung. Ihr Auftrag «Check & Reparatur» (Festpreis CHF ${fix.price}) für ${dom} ist bestätigt${id}.`, "",
      ...(paid ? ["Die erste Teilzahlung ist bereits eingegangen. Den sicheren, einmaligen Zugangslink erhalten Sie in Kürze in diesem E-Mail-Verlauf."]
        : link ? payLines(fix, link)
        : [`Nächster Schritt: Wir beginnen nach Eingang der ersten Hälfte des Festpreises (CHF ${fix.deposit}). Die Zahlungsangaben erhalten Sie separat von uns.`, "",
          "Sobald die Zahlung eingegangen ist, erhalten Sie in diesem E-Mail-Verlauf automatisch Ihren sicheren, einmaligen Zugangslink."]), "",
      "Für die Reparatur benötigen wir einen sicheren Zugang. Bitte verwenden Sie dafür ausschliesslich diesen einmaligen Zugangslink. Im Formular bestätigen Sie ausserdem die Reparatur für Ihre Website.",
      NO_PASSWORD_MAIL_DE, "", "Vor der ersten Änderung sichern wir Ihre Website vollständig; zum Abschluss erhalten Sie einen verständlichen Bericht.");
  } else if (kind === "PAYMENT_LINK" || kind === "PAYMENT_REMINDER") {
    // TF-080: Zahlungslink nachgereicht (Stripe war bei der Bestätigung noch nicht bereit) bzw. EINE zurückhaltende Erinnerung mit Ersatz-Link.
    if (!link) throw new Error("Kein Zahlungslink.");
    lines.push(kind === "PAYMENT_REMINDER" ? `der bisherige Zahlungslink für Ihren Auftrag${id} ist abgelaufen. Hier erhalten Sie einmalig einen neuen Link.`
      : `für Ihren Auftrag «Check & Reparatur»${id} für ${dom} erhalten Sie hier den sicheren Zahlungslink.`, "", ...payLines(fix, link));
  } else if (kind === "PAYMENT_INFO") {
    lines.push(`«Check & Reparatur» kostet CHF ${fix.price} (Festpreis). Mit der Arbeit beginnen wir nach Eingang der ersten Hälfte (CHF ${fix.deposit}).`, "",
      !j.order_id ? `Wenn Sie den Auftrag erteilen möchten, antworten Sie einfach mit «${ORDER_CONFIRM_PHRASE_DE}». Die Zahlungsangaben erhalten Sie danach.`
        : paid ? `Für Ihren Auftrag${id} ist die erste Teilzahlung eingegangen.`
        : j.payment_link_seq ? `Für Ihren Auftrag${id} ist die erste Teilzahlung noch ausstehend; den sicheren Zahlungslink finden Sie in diesem E-Mail-Verlauf.`
        : `Für Ihren Auftrag${id} ist die erste Teilzahlung noch ausstehend; die Zahlungsangaben erhalten Sie separat von uns.`);
  } else if (kind === "ACCESS_INFO") {
    const when = !j.order_id ? `sobald Sie den Auftrag bestätigt haben und die erste Hälfte des Festpreises (CHF ${fix.deposit}) eingegangen ist`
      : paid ? "in Kürze" : `sobald die erste Hälfte des Festpreises (CHF ${fix.deposit}) eingegangen ist`;
    lines.push(SECURE_ACCESS_DE, "",
      `So funktioniert es: Den Link erhalten Sie in diesem E-Mail-Verlauf, ${when}. Im Formular wählen Sie die passende Zugangsart (zum Beispiel WordPress-Administrator, Hosting-Panel oder SFTP), geben den Zugang ein – er wird bereits in Ihrem Browser verschlüsselt – und bestätigen die Reparatur für ${dom}.`,
      "Der Link gilt nur für Ihren Auftrag, ist nur einmal verwendbar und läuft automatisch ab. Am sichersten ist ein temporärer Benutzer mit nur den nötigen Rechten.", "",
      NO_PASSWORD_MAIL_DE);
  } else if (kind === "SENSITIVE") {
    lines.push(C.SENSITIVE_NOLINK_DE, "", SECURE_ACCESS_DE, "", "Da die Angaben per E-Mail übermittelt wurden, empfehlen wir Ihnen, das betroffene Passwort zu ändern.");
  } else throw new Error(`Unbekannte Antwortart ${kind}`);
  return [...lines, "", SIG_DE].join("\n");
}

// ---------- CRM-Statuswort ----------
export function journeyWorkflow(j = {}, o = null) {
  if (j.state === "MANUAL_REVIEW_REQUIRED" || j.state === "CANCELLATION_REVIEW_REQUIRED") return "MANUAL_REVIEW";
  if (j.state === "CUSTOMER_STOP_REQUESTED") return j.order_id ? "MANUAL_REVIEW" : "CANCELLED";
  if (!j.order_id) return "WAITING_FOR_CONFIRMATION";
  if (!o) return "WAITING_FOR_PAYMENT";
  if (o.cancelled) return "CANCELLED";
  if (o.completed) return "COMPLETED";
  if (o.terminal || o.order_state === "WAITING_FOR_ACCESS_PROFILE") return "MANUAL_REVIEW";
  if (o.payment_gate_met !== true) return "WAITING_FOR_PAYMENT";
  if (VALIDATING.has(o.order_state)) return "VALIDATION";
  if (REPAIR_RUNNING.has(o.order_state)) return "REPAIR_RUNNING";
  if (["ACCESS_RECEIVED", "ACCESS_PROFILE_READY"].includes(o.access_status)) return "ACCESS_RECEIVED";
  if (["ACCESS_MISSING", "HOSTING_INFO_MISSING"].includes(o.access_status) && !["ACCESS_REQUESTED", "WAITING_FOR_HOSTING_INFO"].includes(o.order_state)) return "PAYMENT_CONFIRMED";
  return "ACCESS_REQUESTED";
}
const VALIDATING = new Set(["VALIDATION", "RETEST", "READY_FOR_DELIVERY"]);
// TF-080: Zahlungsstand fürs CRM (feste Wörter).
function paymentState(j, o, pl) {
  if (!j.order_id) return "NONE";
  if (o?.payment_gate_met === true) return "PAID";
  if (!pl) return "MANUAL";
  if (pl.status === "OPEN") return j.payment_link_seq === pl.seq ? "LINK_SENT" : "LINK_PENDING";
  return { PENDING: "LINK_PENDING", PAID: "PAID", EXPIRED: "EXPIRED", EXPIRED_FINAL: "EXPIRED", NOT_CONFIGURED: "NOT_CONFIGURED", FAILED: "MANUAL", TEST_BLOCKED: "REVIEW", REVIEW: "REVIEW" }[pl.status] || "REVIEW";
}

// Thread der Kontaktformular-Antwort für die erste Auftrags-Mail (onboarding-dialogue route): nur ein eindeutig gebundener Verlauf derselben Adresse.
export function contactThreadFor(store, orderId, email) {
  const threads = new Set(Object.values(loadContactForms(store).items).filter((it) => it.journey?.order_id === orderId && lc(it.customer_email) === lc(email) && it.sent_thread_id)
    .map((it) => it.sent_thread_id));
  return threads.size === 1 ? [...threads][0] : null;
}
// Threads, die dieses Modul führt (vom allgemeinen Antwort-Scan des Mail-Workers ausgenommen – nie zwei Antwortende).
export function journeyThreads(store) {
  const m = new Map();
  for (const it of Object.values(loadContactForms(store).items)) if (it.journey && it.journey.state !== "HANDED_OFF" && it.sent_thread_id) m.set(it.sent_thread_id, it.journey.order_id || it.key);
  return m;
}

// ---------- ein Durchlauf ----------
// gmail: readThread, replyDraftInThread, sendDraft, listOwned. boundOrders(): Set der order_ids mit Onboarding-Thread (Dialog hat übernommen).
// TF-080: e2e (e2e-test.js e2eConfig) – Test-Einsendungen laufen nur mit aktivem E2E-Modus, Test-Postfach und Sandbox-Domain weiter. Zahlungslinks
// (Stripe Checkout) kommen vom Repair-Service (payment_links.json) und werden im Kontaktformular-Verlauf genau einmal je Session gesendet.
export const PAYMENT_LINK_WAIT_MS = 15 * 60_000;
export async function processContactJourneys({ gmail, store, onboardingDir, boundOrders = () => new Set(), now = new Date(), log = () => {}, escalate = async () => {}, readOnly = false, maxReads = 10, e2e = null } = {}) {
  const res = { journeys: 0, started: 0, replies: 0, order_requests: 0, bound: 0, handed_off: 0, review: 0, degraded: null };
  if (readOnly || !onboardingDir || !gmail || typeof gmail.readThread !== "function" || typeof gmail.replyDraftInThread !== "function" || typeof gmail.sendDraft !== "function") return res;
  const st = loadContactForms(store);
  const t = now.toISOString();
  const persist = () => { store.write(CONTACT_FORMS_FILE, st); store.write(CONTACT_FORMS_PUBLIC_FILE, publicContactForms(st)); };
  const orders = readOrdersExport(onboardingDir).orders || {};
  const results = readContactOrderResults(onboardingDir).results || {};
  const links = readPaymentLinks(onboardingDir).links || {};
  // Zahlungslink nur für den Auftrag DIESES Wegs und im passenden Modus (TEST-Weg ↔ TEST-Session, echter Weg ↔ LIVE-Session).
  const linkOf = (j) => { const pl = j.order_id ? links[j.order_id] : null; return pl && pl.provider_mode === (j.test ? "TEST" : "LIVE") ? pl : pl ? { ...pl, status: "REVIEW", url: null } : null; };
  let bound;
  try { bound = boundOrders() || new Set(); } catch { bound = new Set(); }
  const inform = async (it, reason, { review = true } = {}) => {
    if (review) res.review++;
    log("warn", "contact_journey_chris", { key: it.key, reason: String(reason).slice(0, 120) });
    try { await escalate({ messageId: it.message_id, threadId: it.sent_thread_id, company: it.company || "", contactName: "", reason: `Kontaktformular «Check & Reparatur»: ${String(reason).slice(0, 120)}` }); }
    catch (e) { log("error", "escalate_failed", { key: it.key, error: String(e.message).slice(0, 120) }); }
  };
  const halt = async (it, state, reason) => { it.journey.state = state; it.journey.manual_reason = String(reason).slice(0, 200); it.journey.updated_at = t; persist(); await inform(it, reason); };

  // Genau einmal senden (wie onboarding-dialogue): pending VOR jedem Gmail-Aufruf persistiert; unklar → nie wiederholen.
  async function send(it, key, kind, msgId = null, pay = null) {
    const j = it.journey;
    if (j.mails[key]) return "done";
    if ((j.auto_replies || 0) >= MAX_AUTO_REPLIES) { await halt(it, "MANUAL_REVIEW_REQUIRED", "Zu viele automatische Antworten – Chris übernimmt."); return "stop"; }
    const body = renderJourneyReply(kind, { it, j, order: j.order_id ? orders[j.order_id] || null : null, pay });
    j.pending = { key, kind, msg_id: msgId, status: "creating", at: t, ...(pay?.url ? { pay_seq: pay.seq } : {}) };
    persist();
    let d;
    try { d = await gmail.replyDraftInThread(it.sent_thread_id, { to: it.customer_email, body, messageClass: C.ONBOARDING_CLASS, ...(j.order_id ? { orderId: j.order_id } : {}) }); }
    catch (e) {
      if (TRANSIENT_RE.test(String(e.message))) { res.degraded ||= String(e.message).slice(0, 120); return "stop"; } // Recovery prüft Entwürfe
      j.pending = null; await halt(it, "MANUAL_REVIEW_REQUIRED", "Antwort im Kontaktformular-Verlauf nicht möglich (Thread nicht eindeutig)."); return "stop";
    }
    j.pending = { ...j.pending, status: "drafted", draft_id: d.draftId };
    persist();
    return sendPending(it);
  }
  async function sendPending(it) {
    const j = it.journey, p = j.pending;
    p.status = "sending"; p.send_at = t; persist();
    let info;
    try { info = await gmail.sendDraft(p.draft_id); }
    catch (e) {
      if (SAFE_RETRY_RE.test(String(e.message))) { p.status = "drafted"; persist(); return "stop"; }
      j.pending = null; if (p.msg_id) j.processed[p.msg_id] = { at: t, result: "send_unclear" };
      await halt(it, "MANUAL_REVIEW_REQUIRED", TRANSIENT_RE.test(String(e.message)) ? "Versandstatus unklar – kein erneuter Versand, Chris prüft «Gesendet»." : "Versand fehlgeschlagen – Chris prüft.");
      return "stop";
    }
    return finish(it, info);
  }
  function finish(it, info) {
    const j = it.journey, p = j.pending;
    j.mails[p.key] = { at: t, kind: p.kind, message_id: info?.messageId || null };
    if (p.pay_seq) j.payment_link_seq = Math.max(j.payment_link_seq || 0, p.pay_seq); // Zahlungslink dieser Session gesendet (genau einmal)
    if (p.msg_id) j.processed[p.msg_id] = { at: t, result: j.processed[p.msg_id]?.result || p.kind, replied: true };
    j.auto_replies = (j.auto_replies || 0) + 1;
    j.pending = null; j.updated_at = t;
    persist(); res.replies++;
    log("info", "contact_journey_reply_sent", { key: it.key, kind: p.kind, order_id: j.order_id || null });
    return "done";
  }
  async function resolvePending(it) {
    const j = it.journey, p = j.pending;
    const reg = typeof gmail.listOwned === "function" ? gmail.listOwned() : { drafts: {}, sent: {} };
    if (p.status === "creating") {
      const found = Object.entries(reg.drafts || {}).find(([, d]) => d.threadId === it.sent_thread_id && d.messageClass === C.ONBOARDING_CLASS && String(d.createdAt || "") >= p.at);
      if (found) { p.status = "drafted"; p.draft_id = found[0]; persist(); return sendPending(it); }
      if (+now - Date.parse(p.at) > CREATING_STALE_MS) { j.pending = null; persist(); return "done"; } // nichts entstanden → neu entscheiden
      return "stop";
    }
    if (p.status === "drafted") return sendPending(it);
    const sent = Object.entries(reg.sent || {}).find(([, s]) => s.fromDraft === p.draft_id);
    if (sent) return finish(it, { messageId: sent[0] });
    j.pending = null; if (p.msg_id) j.processed[p.msg_id] = { at: t, result: "send_unclear" };
    await halt(it, "MANUAL_REVIEW_REQUIRED", "Versandstatus unklar (Neustart während des Versands) – kein erneuter Versand.");
    return "stop";
  }

  const eligible = Object.values(st.items).filter((it) => it.journey || (it.state === STATES.SENT && journeyEligible(it) && it.sent_thread_id))
    .sort((a, b) => String(a.received_at).localeCompare(String(b.received_at)) || String(a.key).localeCompare(String(b.key)));
  let reads = 0;
  for (const it of eligible) {
    res.journeys++;
    // Start: genau ein Kundenweg je Einsendung. Bereits bestätigter + bezahlter Auftrag (erste Antwort nannte den sicheren Link) → sofort gebunden.
    if (!it.journey) {
      const ready = it.repair_ready_order_id && orders[it.repair_ready_order_id] ? it.repair_ready_order_id : null;
      const test = it.is_test === true;
      it.journey = { state: ready && !test ? "ORDER_BOUND" : "WAITING_FOR_CONFIRMATION", domain: websiteDomain(it.customer_website), order_id: test ? null : ready, started_at: t, updated_at: t,
        processed: {}, mails: ready && !test ? { order_confirmed: { at: it.sent_at || t, kind: "FIRST_REPLY" } } : {}, auto_replies: 0, pending: null,
        ...(test ? { test: true, test_run_id: it.test_run_id || null } : {}) };
      res.started++; persist();
      log("info", "contact_journey_started", { key: it.key, state: it.journey.state });
    }
    const j = it.journey;
    j.processed ||= {}; j.mails ||= {};
    try {
      if (j.pending && (await resolvePending(it)) !== "done") { if (res.degraded) break; continue; }
      // Auftragsbitte → Ergebnis des Repair-Service (einmal, Hash-Schlüssel) bzw. Auftrag mit diesem Schlüssel im Export.
      if (j.state === "ORDER_REQUESTED") {
        const r = results[it.key];
        const byExport = Object.values(orders).find((o) => (o.contact_form_keys || []).includes(it.key));
        if (r?.ok || byExport) { j.order_id = r?.order_id || byExport.order_id; j.state = "ORDER_BOUND"; j.bound_at = t; j.updated_at = t; persist(); res.bound++; log("info", "contact_journey_order_bound", { key: it.key, order_id: j.order_id }); }
        else if (r && !r.ok) { await halt(it, "MANUAL_REVIEW_REQUIRED", `Auftrag konnte nicht automatisch angelegt werden (${r.code}).`); continue; }
      }
      // TF-080: ein Test-Weg, dessen Auftrag kein Test-Auftrag ist (oder umgekehrt), läuft nie weiter.
      if (j.order_id && orders[j.order_id] && (orders[j.order_id].test_order === true) !== (j.test === true) && READING.has(j.state)) { await halt(it, "MANUAL_REVIEW_REQUIRED", "TEST/LIVE-Kennzeichen von Weg und Auftrag widersprechen sich."); continue; }
      const pl = linkOf(j);
      const payOpen = pl?.status === "OPEN" && pl.url ? { url: pl.url, seq: pl.seq, test: pl.provider_mode === "TEST" } : null;
      if (j.state === "ORDER_BOUND" && !j.mails.order_confirmed) {
        // Mit Stripe: auf die Checkout-Session warten (PENDING, höchstens PAYMENT_LINK_WAIT_MS), dann Bestätigung MIT Zahlungslink. Ohne Stripe
        // (kein Eintrag / NOT_CONFIGURED / Fehler) wie bisher: Bestätigung + Hinweis an Chris («Zahlungsangaben senden»).
        const waitLink = pl && (pl.status === "PENDING" || (pl.status === "OPEN" && !pl.url)) && +now - Date.parse(j.bound_at || t) < PAYMENT_LINK_WAIT_MS;
        if (!waitLink && (orders[j.order_id] || +now - Date.parse(j.bound_at || t) > 10 * 60_000)) {
          if ((await send(it, "order_confirmed", "ORDER_CONFIRMED", null, payOpen)) !== "done") { if (res.degraded) break; continue; }
          if (orders[j.order_id]?.payment_gate_met !== true && !payOpen) await inform(it, `Neuer bestätigter Auftrag ${j.order_id}${pl ? ` (Stripe ${pl.status})` : ""} – Zahlungsangaben an den Kunden senden (CHF 240).`, { review: false });
        }
      }
      // Zahlungslink nachreichen bzw. EINE Erinnerung mit Ersatz-Link (je Session genau eine Mail, nie nach der Zahlung, nur solange der Weg den Thread führt).
      if (j.state === "ORDER_BOUND" && j.mails.order_confirmed && payOpen && payOpen.seq > (j.payment_link_seq || 0) && orders[j.order_id]?.payment_gate_met !== true) {
        if ((await send(it, `payment_link:${payOpen.seq}`, payOpen.seq > 1 ? "PAYMENT_REMINDER" : "PAYMENT_LINK", null, payOpen)) !== "done") { if (res.degraded) break; continue; }
      }
      if (j.state === "ORDER_BOUND" && pl?.status === "EXPIRED_FINAL" && !j.payment_final_informed) {
        j.payment_final_informed = t; persist();
        await inform(it, `Zahlungslink für ${j.order_id} zweimal abgelaufen – keine weitere automatische Erinnerung, Chris klärt.`);
      }
      // Übergabe: der Onboarding-Dialog hat den Auftrag gebunden (erste Auftrags-Mail gesendet) → dieser Thread gehört ihm.
      if (j.order_id && bound.has(j.order_id) && j.state === "ORDER_BOUND") { j.state = "HANDED_OFF"; j.handed_off_at = t; j.updated_at = t; persist(); res.handed_off++; log("info", "contact_journey_handed_off", { key: it.key, order_id: j.order_id }); }
      // Kundennachrichten im eigenen Thread (nur solange dieses Modul den Thread führt).
      if (READING.has(j.state) && reads < maxReads) {
        reads++;
        let thread;
        try { thread = await gmail.readThread(it.sent_thread_id); }
        catch (e) { if (TRANSIENT_RE.test(String(e.message))) { res.degraded = String(e.message).slice(0, 120); break; } await halt(it, "MANUAL_REVIEW_REQUIRED", "Kontaktformular-Verlauf nicht mehr eindeutig lesbar."); continue; }
        const since = Date.parse(it.sent_at || j.started_at) - BIND_GRACE_MS;
        const msgs = (thread.messages || []).filter((m) => !m.draft && !m.sent && !j.processed[m.messageId]).sort((a, b) => a.internalDate - b.internalDate);
        for (const m of msgs) {
          const mark = (result) => { j.processed[m.messageId] = { at: t, result }; j.updated_at = t; persist(); };
          if (m.internalDate < since) { mark("before_reply"); continue; }
          if (BOUNCE_RE.test(m.from || "")) { mark("bounce"); await inform(it, "Zustellproblem an die Kundenadresse"); continue; }
          if (AUTO_SUBJECT_RE.test(m.subject || "")) { mark("auto_reply"); continue; }
          const from = C.normEmailAddr(m.from || ""), rt = m.replyTo ? C.normEmailAddr(m.replyTo) : null;
          if (from !== lc(it.customer_email) || (rt && rt !== lc(it.customer_email))) { mark("foreign_sender_blocked"); await inform(it, "Nachricht von einer anderen Adresse im Kontaktformular-Verlauf – nicht beantwortet"); continue; }
          if (!READING.has(j.state)) { mark("halted"); continue; }
          const text = C.newCustomerText(m.body || "");
          const d = decideJourney({ j, text, order: j.order_id ? orders[j.order_id] || null : null });
          log("info", "contact_journey_message", { key: it.key, result: d.result, reply: d.reply || null }); // nie Inhalte
          if (d.sensitive) j.sensitive_received = (j.sensitive_received || 0) + 1; // nichts aus der Mail gespeichert, nichts wiederholt
          if (d.requestOrder && j.test && !(isE2eDomain(e2e, j.domain) && isE2eMailbox(e2e, it.customer_email))) {
            mark("test_blocked"); await halt(it, "MANUAL_REVIEW_REQUIRED", "E2E-Test: Modus aus bzw. Postfach/Domain nicht freigegeben – kein Test-Auftrag."); break;
          }
          if (d.requestOrder) {
            const req = { key: it.key, offer_class: FIX_OFFER, market: "CH", source: "customer_reply_email", confirmed_at: new Date(m.internalDate || +now).toISOString(),
              domain: j.domain, website: /^https:\/\//.test(it.customer_website || "") ? `https://${new URL(it.customer_website).hostname}/` : null, delivery_email: lc(it.customer_email),
              contact_name: it.name || null, company: j.test ? null : it.company || null, lead_id: j.test ? null : it.lead_id || null,
              ...(j.test ? { test: true, test_run_id: it.test_run_id || null } : {}) };
            writeContactOrderRequest(onboardingDir, req);
            j.order_requested_at = t; res.order_requests++;
            log("info", "contact_journey_order_requested", { key: it.key });
          }
          if (d.state) { j.state = d.state; if (d.state !== "ORDER_REQUESTED") j.manual_reason = d.escalate || null; }
          if (d.escalate) await inform(it, d.escalate);
          if (d.reply) {
            // «processed» setzt erst finish() – ein vor dem Entwurf abgebrochener Versuch wird im nächsten Durchlauf neu entschieden (nie doppelt gesendet).
            if ((await send(it, `reply:${m.messageId}`, d.reply, m.messageId)) !== "done") break;
            continue;
          }
          mark(d.result);
        }
        if (res.degraded) break;
      }
    } catch (e) {
      if (TRANSIENT_RE.test(String(e.message))) { res.degraded = String(e.message).slice(0, 120); break; }
      log("error", "contact_journey_failed", { key: it.key, error: String(e.message).slice(0, 160) });
    }
    const o = j.order_id ? orders[j.order_id] || null : null;
    const w = journeyWorkflow(j, o);
    // TF-080: Stufen-Zustände fürs CRM-Detail (feste Wörter aus dem Auftrags-Export – nie Links/Beträge/Zugangsdaten).
    const view = { payment_mode: j.test ? "TEST" : j.order_id ? "LIVE" : null, payment_state: paymentState(j, o, linkOf(j)),
      access_state: o?.access_status || null, repair_state: o?.order_state || null };
    if (j.workflow !== w || JSON.stringify(j.view || null) !== JSON.stringify(view)) { j.workflow = w; j.view = view; j.updated_at = t; persist(); }
  }
  return res;
}
