// Jarvis Mail-Worker – läuft unabhängig von server.js im Hintergrund.
// sendMode "drafts": bereitet nur Entwürfe vor. sendMode "compliant_auto": sendet zusätzlich selbst, aber ausschließlich
// an Leads mit dokumentierter Versandgrundlage (opt_in oder Bestandskunde mit ähnlicher Leistung) und in deren Threads.
// Heikle Fälle bleiben immer Entwürfe für Chris.
//
// Alle 5 Minuten: neue Antworten in registrierten Jarvis-Threads, Opt-outs, fällige Follow-ups, freigegebene Leads
// und Cloud-Mailaufträge prüfen und Entwürfe vorbereiten. Gesendet wird automatisch NUR in zwei Versandläufen pro Tag
// (09:30 und 14:30 Europe/Zurich, je höchstens 50, zusammen höchstens 100). Jeder Lauf wird vor dem ersten Send
// persistiert und nie wiederholt. Zustand, Leads und Suppression-Liste liegen in .secrets/mail_worker/.
//
//   node mail-worker.js              Worker-Schleife (Lock gegen Doppelstart)
//   node mail-worker.js --supervise  wie oben, startet den Worker nach einem Absturz neu (für den Autostart)
//   node mail-worker.js --once       genau eine Prüfung
//   node mail-worker.js --plan       Dry-Run: zeigt, was heute vorbereitet/gesendet würde – ändert nichts (Alias --dry-run)
//   node mail-worker.js --healthcheck  Exit 0, wenn der laufende Worker sich in den letzten 5 Minuten gemeldet hat (Docker)
//
// Always-on: Auf dem VPS (JARVIS_WORKER_ROLE=vps, deploy/vps/) ist dieser Worker send_authority und läuft 24/7.
// Gesprächsantworten und manuelle Aufträge von Chris gehen zeitnah raus, Kampagnen nur in den Fenstern. Jeder Send braucht
// ein serverseitiges Lock (/api/mail-requests); der Windows-Worker sendet dann nichts mehr (Standby).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectHumanContact } from "./human-contact.js";
import { COLD_DRAFTS_FILE, COLD_MODE, FREEMAIL_RE, markManualSend, ensureColdDraft, coldDraftAction } from "./swiss-repair.js";
import { publicLeads } from "./cloud-leads.js";
import { loadRegistry, registryBlock, reconcileRegistry, publicRegistry, registryStatus, CRM_UNAVAILABLE } from "./lead-registry.js";
import { evaluateSwissEmailPermission } from "./email-permission.js";
import { paymentOptions } from "./payment-links.js";
import { readOrdersExport } from "./onboarding-store.js";
import { senderProfileFor, VN_SIGNATURE } from "./sender-profiles.js";
import { processContactForms, DEFAULT_CONTACT_FORM_CONFIG, CONTACT_FORM_DRAFT_MODE } from "./contact-form.js";
import { draftRef, SERVER_SEND_USERS } from "./mail-access.js";
import { MANUAL_TEST_MAIL, isManualTestMail } from "./mail-requests.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
export const WORKER_DIR = path.join(SECRETS, "mail_worker");
const WRITER_PROMPT = path.join(ROOT, "mail-writer.md");
const WIN = process.platform === "win32";

export const HARD_LIMIT = 100; // erfolgreiche Sends je Kalendertag (Europe/Zurich)
export const WINDOW_LIMIT = 50; // erfolgreiche Sends je Versandfenster
// Versandläufe: Start und spätester Nachholzeitpunkt (z. B. PC war um 09:30 aus).
export const SEND_WINDOWS = [
  { id: "morning", start: "09:30", until: "12:00", limit: WINDOW_LIMIT },
  { id: "afternoon", start: "14:30", until: "18:00", limit: WINDOW_LIMIT },
];
const DAY_MS = 86_400_000;
const GMAIL_AUTH_CHECK_MS = 5 * 60_000; // TF-049: read-only Gmail-OAuth-Prüfung (Outbox-Herzschlag), Takt
export const DEFAULT_CONFIG = {
  dryRun: true, // Standard: nur anzeigen, was vorbereitet würde
  sendMode: "drafts", // "drafts" = nur Entwürfe, "compliant_auto" = versandberechtigte Mails selbst senden
  dailyLimit: HARD_LIMIT, // wird nie über HARD_LIMIT hinaus beachtet
  replyReserve: 5, // so viele Plätze bleiben täglich für Antworten in laufenden Gesprächen frei
  pollMinutes: 5,
  window: ["08:30", "18:30"], // Follow-ups und Erstkontakte werden nur in diesem Zeitfenster VORBEREITET (Europe/Zurich)
  maxPacedPerTick: 2, // höchstens so viele Follow-ups/Erstkontakte werden pro Durchlauf geschrieben
  followUpDays: [3, 5],
  activeDays: 60, // ältere Threads werden nicht mehr abgefragt
  // TF-037 Gmail-Quota-Budget je Durchlauf (gegen „Units per minute per user“): Reply-Scan liest höchstens so viele
  // Thread-Volltexte (10 Quota-Units je Thread), der Cold-Draft-Sync prüft höchstens so viele Entwürfe (5 Units je Entwurf).
  // Der Rest kommt über den persistenten Round-Robin-Cursor in den nächsten Durchläufen dran – nichts geht verloren.
  maxThreadReadsPerTick: 20,
  maxColdDraftChecksPerTick: 40,
  excludeAddresses: [], // z. B. eigene Adressen von Chris: dafür nie Entwürfe vorbereiten
  sender: { name: "", company: "", email: "", sendAs: "", signature: "" }, // sendAs (TF-081): verifizierter «Senden als»-Alias (z. B. chris@helvetic-webdesign.ch) für Kunden-Service-Mails; echte Identität von Chris – ohne name kein Erstkontakt/Versand
  offer: "", // Angebot von Chris in eigenen Worten – ohne Angebot keine Erstkontakte
  model: "sonnet",
};

// ---------- Hilfen ----------

const zurich = (d, opts) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich", ...opts }).format(d);
export const zurichDay = (d) => zurich(d, { year: "numeric", month: "2-digit", day: "2-digit" });
const zurichMinutes = (d) => { const [h, m] = zurich(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":"); return +h * 60 + +m; };
const hm = (s) => { const [h, m] = s.split(":"); return +h * 60 + +m; };
// Aktuelles Versandfenster (Europe/Zurich, sommerzeitfest über Intl) oder null.
export const sendWindowAt = (d) => SEND_WINDOWS.find((w) => zurichMinutes(d) >= hm(w.start) && zurichMinutes(d) < hm(w.until)) || null;
const threadRef = (threadId) => crypto.createHash("sha256").update(String(threadId)).digest("hex").slice(0, 12);

export const normEmail = (s = "") => (s.match(/<([^>]+)>/)?.[1] || s).trim().toLowerCase();
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

// Nur den neuen Teil einer Antwort betrachten – zitierter Verlauf (auch unsere eigene Mail) zählt nicht.
export function newText(body = "") {
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(On .+wrote:|Am .+schrieb.*:|Le .+a écrit|Il .+ha scritto|-{2,}\s*(Original|Ursprüngliche)|From: |Von: )/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}
export const OPT_OUT_RE = /\b(unsubscribe|abmelden|austragen|stopp?\b|keine (weiteren |weitere )?(e-?mails?|mails|nachrichten|kontaktaufnahme)|nicht (mehr )?(kontaktieren|anschreiben)|kein interesse|not interested|remove me|(mich|uns|adresse|e-?mail)\s+(bitte\s+)?(aus\s+\S+\s+(verteiler|liste|kartei)\s+)?(entfernen|löschen)|entfernen sie (mich|uns|meine|unsere)|aus (ihrem|dem|ihrer) (verteiler|liste|kartei)|nicht relevant|do not (contact|email)|don'?t (contact|email)|désinscri|ne plus me contacter|non contattarmi|disiscriv)/i;
export const ESCALATE_RE = /(vertrag|vertr[aä]ge|contract|agb|haftung|anwalt|lawyer|rechtlich|legal|klage|gericht|rechnung|invoice|zahlung|payment|[uü]berweis|iban|kreditkarte|credit card|rabatt|discount|preisnachlass|skonto|passwort|password|zugangsdaten|credentials|login|beschwerde|complaint|betrug|fraud|bankverbindung|bankdaten|kontonummer|bank account|secret|geheim|preis(?:änderung|aenderung|erhöhung|anpassung)|price (?:change|increase)|garantie|guarantee|\bverbindlich|\bbinding|schadenersatz|damages|kündig|terminat)/i;
// Mailklassen: A/B (Kampagnen) nur in den Versandfenstern, C/D (Gespräch, manuell von Chris) zeitnah rund um die Uhr.
export const MAIL_CLASS = { erstkontakt: "automatic_sales_outreach", antwort: "conversation_reply", "cloud-auftrag": "manual_chris_mail", einzelmail: "individual_approved_mail" };
export const mailClassOf = (a = {}) => (a.messageClass === "SOLICITED_RESPONSE" ? "solicited_response" : null) || MAIL_CLASS[a.kind] || (String(a.kind || "").startsWith("follow-up") ? "sales_followup" : "automatic_sales_outreach");
export const IMMEDIATE_CLASSES = new Set(["conversation_reply", "manual_chris_mail"]);
const ALLOW_ALL = { acquire: async () => ({ ok: true }), done: async () => {} };
const AUTO_SUBJECT_RE = /(automatische antwort|abwesenheit|out of office|automatic reply|auto-?reply|réponse automatique|risposta automatica)/i;
const BOUNCE_RE = /mailer-daemon|postmaster/i;
const AI_RE = /\b(KI|AI|Claude|Jarvis|ChatGPT|künstliche Intelligenz|language model|Sprachmodell)\b/;
// TF-064: + vietnamesische Begriffe (hủy/huỷ đăng ký, không muốn nhận thêm email, không liên hệ) – DE/EN/FR/IT unverändert.
const UNSUB_RE = /abmelden|unsubscribe|désinscri|disiscriv|h[uủ]y đăng ký|huỷ đăng ký|không muốn nhận thêm email|không liên hệ/i;
// Behauptete Website-Mängel – ohne dokumentierte websiteIssues darf eine Erstmail so etwas nicht enthalten.
export const CLAIM_RE = /(fehler|defekt|kaputt|funktioniert nicht|nicht erreichbar|nicht mehr erreichbar|404|zertifikat|veraltet|langsam|unsicher|broken|not working|outdated|slow|certificate|erreur|cass[ée]|errore|non funziona)/i;
const isBoundManualTestDraft = (draft = {}) => isManualTestMail({ manual_test: true, manual_test_lead_id: MANUAL_TEST_MAIL.lead_id,
  recipient: draft.to, subject: draft.subject, body: draft.body });

// Versandgrundlage eines Leads – entscheidet ausschliesslich die TF-024-Permission-Engine (email-permission.js).
// approved (Chris hat den Lead in seine Liste gesetzt) ist zusätzlich nötig, ersetzt aber nie die Grundlage.
//   "opt_in" / "existing_customer"        MARKETING (EXPLICIT_OPT_IN / EXISTING_CUSTOMER_SIMILAR_SERVICE)
//   "requested_contact" / "active_rfp"    SOLICITED_RESPONSE – nur im angefragten Umfang (Website-Reparatur), nie Follow-up-Funnel
export function legalBasis(lead = {}, now = new Date()) {
  if (!lead || lead.approved !== true) return null;
  const m = evaluateSwissEmailPermission(lead, { type: "MARKETING" }, now);
  if (m.allowed) return m.legal_basis === "EXPLICIT_OPT_IN" ? "opt_in" : "existing_customer";
  const s = evaluateSwissEmailPermission(lead, { type: "SOLICITED_RESPONSE", scope: "Website-Reparatur" }, now);
  if (s.allowed) return s.legal_basis === "ACTIVE_RFP_RESPONSE" ? "active_rfp" : "requested_contact";
  return null;
}
export const MARKETING_LEGAL = new Set(["opt_in", "existing_customer"]);
// Automatische Follow-ups nur bei Marketing-Grundlagen. Angefragter Kontakt, Ausschreibung und Cold-/Einzelmails bekommen keinen Funnel.
export const FOLLOWUP_BASES = new Set(["opt_in", "existing_customer"]);
export const INDIVIDUAL_BASIS = "individual_one_to_one";

// Jede werbliche Mail endet mit klarer Absenderidentität und einer kostenlosen Abmeldemöglichkeit per Antwort.
export const UNSUB_LINE = {
  de: "Falls Sie keine weiteren Nachrichten von mir wünschen, antworten Sie einfach mit «Abmelden».",
  en: "If you'd prefer not to hear from me again, simply reply with \"unsubscribe\".",
  fr: "Si vous ne souhaitez plus recevoir de messages de ma part, répondez simplement « désinscrire ».",
  it: "Se non desidera ricevere altri messaggi da parte mia, risponda semplicemente «disiscrivi».",
  vi: "Nếu anh/chị không muốn nhận thêm email từ chúng tôi, chỉ cần trả lời “Hủy đăng ký”.",
};
export function finalizeCommercial(body, sender = {}, lang = "de") {
  let out = String(body || "").trim();
  const signature = sender.signature?.trim() || [sender.name, sender.company, sender.email].filter(Boolean).join("\n");
  if (sender.name && !out.includes(sender.name)) out += "\n\n" + signature;
  if (!UNSUB_RE.test(out)) out += "\n\n" + (UNSUB_LINE[String(lang || "de").slice(0, 2).toLowerCase()] || UNSUB_LINE.de);
  return out;
}
// TF-064: werblicher Entwurf nach Absenderprofil. CH → finalizeCommercial exakt wie bisher (cfg.sender, Sprache des Leads).
// VN (actor Kudoshin – vormals lap – oder market VN) → feste vietnamesische Lap-Signatur + vietnamesische Abmeldezeile, nie Chris' Schweizer Signatur.
// Eine bereits vorhandene Grussformel «Trân trọng, Lap» am Ende wird durch die vollständige Signatur ersetzt (keine Doppelung).
export function finalizeForProfile(body, profile, lang = "de") {
  if (profile?.id !== "vn") return finalizeCommercial(body, profile?.sender || {}, lang);
  let out = String(body || "").normalize("NFC").trim();
  if (!out.includes(profile.signature)) {
    out = out.replace(/\n*\s*Trân trọng,?\s*(\n\s*Lap\s*)?$/u, "").trim();
    out += "\n\n" + profile.signature;
  }
  if (!UNSUB_RE.test(out)) out += "\n\n" + UNSUB_LINE.vi;
  return out;
}
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network/i;

// Atomare JSON-Ablage: Temp-Datei + Umbenennen, ein Absturz hinterlässt nie halbe Dateien.
export function createStore(dir) {
  return {
    dir,
    read(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return structuredClone(fallback); } },
    write(name, data, { compact = false } = {}) { // compact: grosse, selten von Hand gelesene Dateien (discovered.json bei 7500 Websites/Tag)
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name), tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, compact ? 0 : 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

export function createLogger(dir) {
  return (level, event, data = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) + "\n";
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "worker.log");
      if (fs.existsSync(file) && fs.statSync(file).size > 2_000_000) fs.renameSync(file, file + ".1");
      fs.appendFileSync(file, line);
    } catch {}
    if (process.env.JARVIS_WORKER_ECHO) process.stdout.write(line);
  };
}

// TF-047: Separater Repair-Service (jarvis-repair-worker). JARVIS_REPAIR_STATE_DIR = dessen Zustand (read-only eingebunden) – dann
// laufen CHF-480/CHF-150 NICHT mehr im Mail-Worker, Dashboard-Sichten lesen dort. JARVIS_REPAIR_OUTBOX = Repair-Outbox: der
// Mail-Worker (einzige Sender Authority) sendet die Service-Mails des Repair-Service genau einmal (repair-outbox.js).
export const repairStateDir = (env = process.env) => env.JARVIS_REPAIR_STATE_DIR || null;
export const repairOutboxDir = (env = process.env) => env.JARVIS_REPAIR_OUTBOX || null;
function repairSalesRecords(env = process.env) {
  const d = repairStateDir(env);
  if (!d) return {};
  try { return JSON.parse(fs.readFileSync(path.join(d, "sales.json"), "utf8")).records || {}; } catch { return {}; }
}

// ---------- Lock gegen Doppelstart ----------

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
export function acquireLock(dir, { pid = process.pid, now = Date.now(), staleMs = 15 * 60_000, name = "worker.lock" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid, beat: now }), { flag: "wx" });
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let raw = "", lock = {};
      try { raw = fs.readFileSync(file, "utf8"); lock = JSON.parse(raw); } catch {}
      // Belegt, wenn der Besitzer lebt und sich kürzlich gemeldet hat (schützt auch vor wiederverwendeten PIDs).
      if (lock.pid && lock.pid !== pid && alive(lock.pid) && now - (lock.beat || 0) < staleMs) return false;
      // Nur genau das als verwaist erkannte Lock entfernen – hat ein anderer Start es inzwischen erneuert, gilt es.
      try { if (fs.readFileSync(file, "utf8") !== raw) return false; } catch {}
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}
export const heartbeat = (dir, pid = process.pid, name = "worker.lock") => fs.writeFileSync(path.join(dir, name), JSON.stringify({ pid, beat: Date.now() }));
export function releaseLock(dir, pid = process.pid, name = "worker.lock") {
  const file = path.join(dir, name);
  try { if (JSON.parse(fs.readFileSync(file, "utf8")).pid === pid) fs.rmSync(file); } catch {}
}

// ---------- Worker ----------

const STATE = { actions: {}, handled: {}, threadDrafts: {}, prepared: {}, compliantThreads: {}, cloudDrafts: {}, windows: {}, lastPacedAt: 0, lastSendAt: 0, failures: 0, backoffUntil: 0 };
// Cloud-Mailaufträge (lokale Ablage): request_id -> { request, status, reason, synced }
export const CLOUD_INBOX = "cloud_requests.json";
// KI-Budget-Sperre: { paused, since, checkedAt, deferred: { key: { status: AI_BUDGET_EXHAUSTED, kind, at } } }
export const AI_BUDGET_FILE = "ai_budget.json";

// sendGuard: serverseitiges Send-Lock vor jedem Gmail-Send (VPS/Windows können nie dieselbe Mail senden).
// escalate: Meldung an Chris, wenn eine Antwort nicht automatisch gesendet werden darf.
// aiPaused: Meldung an Chris, wenn das Anthropic-Guthaben aufgebraucht ist (einmal je Pause).
// TF-066: onboardingThreads() → Map threadId → order_id der gebundenen Auftrags-Threads (Dialog läuft in onboarding-dialogue.js,
// hier werden sie weder gelesen noch beantwortet noch mit Follow-ups versehen).
export const SERVICE_THREAD_CLASSES = new Set(["CUSTOMER_ONBOARDING_DIALOGUE", "CUSTOMER_ACCESS_REQUEST", "CUSTOMER_PAYMENT_REQUEST"]);
// TF-075A: contactOrders() → Aufträge (order_id → { customer_email, market, lead_id, … }) für die exakte Zuordnung von Kontaktformular-Anfragen.
export function createWorker({ dir = WORKER_DIR, gmail, compose, now = () => new Date(), log = createLogger(dir), notify = async () => {}, escalate = async () => {}, aiPaused = async () => {}, sendGuard = ALLOW_ALL, onboardingThreads = null, contactOrders = () => ({}), contactJourney = null }) {
  const store = createStore(dir);
  // KI-Budget-Sperre (fail closed, persistiert): nach einem Guthabenfehler keine weiteren KI-Aufrufe. Höchstens ein Prüfversuch
  // je aiRecheckMinutes (von Anthropic abgelehnte Aufrufe kosten nichts); gelingt er, ist die KI wieder frei.
  const aiBudget = () => ({ paused: false, deferred: {}, ...store.read(AI_BUDGET_FILE, {}) });
  const aiRecheckMs = () => Math.max(15, Number(config().aiRecheckMinutes) || 60) * 60_000;
  async function composeGuarded(task) {
    const b = aiBudget();
    if (b.paused && +now() - Date.parse(b.checkedAt || b.since || 0) < aiRecheckMs()) throw new AiBudgetError("pausiert");
    try {
      const r = await compose(task);
      if (b.paused) { store.write(AI_BUDGET_FILE, { paused: false, resumedAt: now().toISOString(), deferred: {} }); log("info", "ai_budget_resumed", { deferred: Object.keys(b.deferred).length }); }
      return r;
    } catch (e) {
      if (!isAiBudgetError(e)) throw e;
      const t = now().toISOString();
      store.write(AI_BUDGET_FILE, { ...b, paused: true, since: b.paused ? b.since : t, checkedAt: t });
      if (!b.paused) {
        log("warn", "ai_budget_exhausted", {});
        try { await aiPaused({ since: t }); } catch (err) { log("error", "notify_failed", { error: err.message }); }
      }
      throw e;
    }
  }
  // Auftrag, der KI braucht, bleibt offen (kein Entwurf, nichts gesendet) und wird nach der Pause erneut verarbeitet.
  const deferAi = (key, kind) => {
    const b = aiBudget();
    b.deferred[key] ||= { status: AI_BUDGET_EXHAUSTED, kind, at: now().toISOString() };
    store.write(AI_BUDGET_FILE, b);
  };
  // Firma zu einer Absenderadresse – nur aus der Lead-Liste von Chris bzw. den gefundenen Leads, nie geraten.
  const companyFor = (email) => {
    const e = normEmail(email), domain = e.split("@")[1] || "";
    const leads = store.read("leads.json", []);
    const hit = (Array.isArray(leads) ? leads : []).find((l) => normEmail(l?.email) === e) || (Array.isArray(leads) ? leads : []).find((l) => l?.email && normEmail(l.email).split("@")[1] === domain);
    return hit?.company || store.read("discovered.json", { leads: {} }).leads?.[domain.replace(/^www\./, "")]?.company || "";
  };
  const displayName = (from = "") => from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim() || "";
  const config = () => {
    const c = { ...DEFAULT_CONFIG, ...store.read("config.json", {}) };
    c.limit = Math.min(Number(c.dailyLimit) || HARD_LIMIT, HARD_LIMIT);
    return c;
  };

  // Heute verbrauchte Plätze: von uns vorbereitete Entwürfe + heute gesendete Jarvis-Mails (Register).
  // Ein vorbereiteter und später gesendeter Entwurf zählt nur einmal.
  function usedToday(reg, state, day) {
    const keys = new Set();
    for (const [draftId, p] of Object.entries(state.prepared)) if (zurichDay(new Date(p.at)) === day) keys.add("d:" + draftId);
    for (const [id, s] of Object.entries(reg.sent || {})) if (s.sentAt && zurichDay(new Date(s.sentAt)) === day) keys.add(s.fromDraft ? "d:" + s.fromDraft : "m:" + id);
    for (const a of Object.values(state.actions)) if (a.status === "creating") keys.add("c:" + a.at); // unklar → vorsichtig mitzählen
    return keys.size;
  }

  async function cycle({ dry, readOnly = false }) {
    const t = now(), day = zurichDay(t), cfg = config();
    try { gmail.setSendAs?.({ address: cfg.sender?.sendAs || "", name: cfg.sender?.name || "" }); } catch (e) { log("error", "send_as_invalid", { error: String(e.message).slice(0, 120) }); gmail.setSendAs?.(null); }
    const state = { ...structuredClone(STATE), ...store.read("state.json", STATE) };
    const supp = store.read("suppression.json", {});
    const exclude = new Set(cfg.excludeAddresses.map(normEmail));
    // TF-037: Gmail-Lesefehler (Quota/429/5xx/Netz) brechen den Durchlauf NICHT mehr ab. Der betroffene Abschnitt stoppt,
    // Cursor und Queues bleiben stehen, der Rest des Durchlaufs (Cloud-Aufträge, Draft-Worker, Statistik, Heartbeat) läuft
    // weiter – Mail ist dann DEGRADED, der Core bleibt ONLINE. Kein Vollscan-Neustart, also kein Quota-Livelock mehr.
    let gmailDegraded = null;
    const degrade = (stage, e) => {
      gmailDegraded ||= { stage, at: t.toISOString(), message: String(e.message || e).slice(0, 160) };
      log("warn", "gmail_degraded", { stage, error: String(e.message || e).slice(0, 200) });
    };
    // 0) TF-075A P0: Kontaktformular-Anfragen VOR allem anderen (vor Cold-Sync, Antworten, Follow-ups, Erstkontakten, Cloud-Aufträgen
    // und Cold-Entwürfen). FIFO, nie state.actions (→ nie Send-Queue), genau eine Antwort je Anfrage. TF-077B: verifizierte Anfragen werden
    // sofort automatisch beantwortet (CONTACT_FORM_REPLY_SENT); unverifizierte bleiben Entwurf (CONTACT_FORM_DRAFT_ONLY, Prüfung).
    let contactForms = null;
    try {
      contactForms = await processContactForms({ gmail, store, cfg: { ...DEFAULT_CONTACT_FORM_CONFIG, ...(cfg.contactForms || {}) }, sender: cfg.sender, vnSignature: VN_SIGNATURE,
        ownAddresses: [cfg.sender?.email, cfg.sender?.sendAs, ...cfg.excludeAddresses].filter(Boolean), leads: () => contactLeads(store), orders: contactOrders, now: t, log, escalate,
        isTransient: (e) => TRANSIENT_RE.test(String(e?.message || e)), readOnly: dry || readOnly,
        // TF-077B: verifizierte Anfragen sofort automatisch beantworten (angefragte Antwort) – abschaltbar über contactForms.autoReply=false.
        autoReply: cfg.contactForms?.autoReply !== false && !!cfg.sender?.name, sendGuard,
        e2e: (await import("./e2e-test.js")).e2eConfig() }); // TF-080: E2E-Testlauf nur mit Server-Freigabe (JARVIS_E2E_TEST_*)
      if (contactForms.degraded) degrade("contact_form", { message: contactForms.degraded });
    } catch (e) { log("error", "contact_form_failed", { error: String(e.message).slice(0, 160) }); }
    // TF-079: Kundenweg «Check & Reparatur» im Thread der automatischen Antwort (Gespräch → bestätigter Auftrag → Übergabe an den Onboarding-Dialog).
    // Nur mit Onboarding (VPS, Repair-Outbox). Fehler stoppen den Durchlauf nie.
    if (typeof contactJourney === "function" && !dry && !readOnly) {
      try { const cj = await contactJourney({ gmail, store, now: t, log, escalate }); if (cj?.degraded) degrade("contact_journey", { message: cj.degraded }); }
      catch (e) { log("error", "contact_journey_failed", { error: String(e.message).slice(0, 160) }); }
    }
    // TF-025: von Chris manuell in Gmail versendete Cold-Entwürfe erkennen (nur eigene, eindeutig zugeordnete Threads).
    // Ergebnis sind nur Fakten (Zeit, IDs) – nie eine Rechtsgrundlage. Danach gelten die normalen sicheren Antwortregeln.
    // TF-037: höchstens maxColdDraftChecksPerTick Entwürfe je Durchlauf (persistenter Round-Robin-Cursor in gmail.js).
    if (!dry && !readOnly && typeof gmail.syncColdDrafts === "function") {
      try {
        const found = await gmail.syncColdDrafts({ max: cfg.maxColdDraftChecksPerTick });
        if (found.length) {
          const cold = store.read(COLD_DRAFTS_FILE, { reviews: {} });
          for (const f of found) {
            const id = Object.keys(cold.reviews || {}).find((k) => cold.reviews[k].gmail_draft_id === f.draftId);
            if (!id) continue;
            cold.reviews[id] = f.status === "manually_sent" ? markManualSend(cold.reviews[id], f)
              : { ...cold.reviews[id], status: "discarded", discarded_in_gmail: true, updated_at: t.toISOString() };
            log("info", "cold_draft_" + f.status, { lead_id: id, threadId: f.threadId || null });
          }
          store.write(COLD_DRAFTS_FILE, cold);
        }
      } catch (e) {
        if (TRANSIENT_RE.test(e.message)) degrade("cold_sync", e); // Cursor steht auf dem letzten fertig geprüften Entwurf
        else log("error", "cold_sync_failed", { error: e.message });
      }
    }
    const reg = gmail.listOwned();
    const plan = [], notes = [], optouts = [], ownThreads = [], sends = [], blockedLeads = [], eligibleLeads = [], humanContacts = [], escalations = [];
    // Echtversand nur im ausdrücklich gesetzten Modus, nie im Dry-Run und nie ohne echte Absenderidentität.
    const wantAuto = cfg.sendMode === "compliant_auto" && !dry;
    const auto = wantAuto && !!cfg.sender?.name;
    if (wantAuto && !auto) notes.push("Echtversand inaktiv: in config.json fehlt sender.name – es entstehen nur Entwürfe.");
    let used = usedToday(reg, state, day);
    const sentToday = Object.values(reg.sent || {}).filter((s) => s.sentAt && zurichDay(new Date(s.sentAt)) === day).length;
    const free = () => cfg.limit - used;
    // Suppression nur ergänzen, nie überschreiben: was inzwischen von außen eingetragen wurde, bleibt erhalten.
    const save = () => { if (!readOnly) { store.write("state.json", state); Object.assign(supp, { ...store.read("suppression.json", {}), ...supp }); store.write("suppression.json", supp); } };
    const suppress = (addrs, reason, threadId) => {
      for (const a of addrs.map(normEmail).filter(Boolean)) if (!supp[a]) {
        supp[a] = { reason, threadId, at: t.toISOString() };
        optouts.push({ address: a, reason, threadId });
        log("info", "suppressed", { address: a, reason, threadId });
      }
    };
    const isPending = (draftId) => !!(draftId && reg.drafts?.[draftId]);

    // Absturz während des Sendens: nie automatisch erneut senden – entweder im Register belegt oder unklar.
    for (const [key, a] of Object.entries(state.actions)) {
      if (a.status !== "sending") continue;
      const done = Object.values(reg.sent || {}).some((x) => x.fromDraft === a.draftId);
      state.actions[key] = { ...a, status: done ? "sent" : "send_unknown" };
      if (!done) log("warn", "send_unknown", { key, draftId: a.draftId });
    }

    // Abgebrochene Vorbereitungen (Absturz zwischen Anlegen und Speichern) einem vorhandenen Entwurf zuordnen.
    for (const [key, a] of Object.entries(state.actions)) {
      if (a.status !== "creating") continue;
      const found = Object.entries(reg.drafts || {}).find(([, d]) => !String(d.mode || "").startsWith("CONTACT_FORM_") && d.createdAt >= a.at && (a.threadId ? d.threadId === a.threadId : normEmail(d.to) === a.to));
      if (found) { state.actions[key] = { ...a, status: "prepared", draftId: found[0] }; state.prepared[found[0]] = { key, at: a.at, kind: a.kind }; }
      else if (t - new Date(a.at) > 10 * 60_000) delete state.actions[key]; // nichts entstanden → darf neu versucht werden
    }

    async function prepare(key, info, make) {
      if (state.actions[key]) return; // schon erledigt oder in Arbeit → keine Doppelentwürfe
      if (dry) { plan.push({ ...info, sourceMessageId: undefined, autoSend: !!info.autoSend && cfg.sendMode === "compliant_auto" && !info.escalate }); used++; return; }
      let result;
      try { result = await composeGuarded(info.task); }
      catch (e) {
        if (!isAiBudgetError(e)) throw e;
        deferAi(key, info.kind);
        log("warn", "ai_budget_deferred", { kind: info.kind, threadId: info.threadId });
        return AI_BUDGET_EXHAUSTED;
      }
      if (info.commercial && result.body) result.body = finalizeCommercial(result.body, cfg.sender, info.lang);
      if (result.decision === "optout") { suppress([info.to], "opt-out (erkannt beim Schreiben)", info.threadId); return "optout"; }
      if (result.decision === "ignore") { state.actions[key] = { status: "ignored", at: t.toISOString(), reason: result.reason }; return "ignore"; }
      let review = result.decision !== "draft";
      if (info.noIssues && CLAIM_RE.test(`${result.subject || ""} ${result.body || ""}`)) review = true; // keine erfundenen Website-Probleme
      if (info.escalate) review = true;
      if (!result.body || result.body.length > 6000 || AI_RE.test(result.body + (result.subject || ""))) review = true;
      if (!result.body) result.body = "(Bitte selbst formulieren – der Entwurf konnte nicht automatisch geschrieben werden.)";
      state.actions[key] = { status: "creating", at: t.toISOString(), kind: info.kind, threadId: info.threadId, to: normEmail(info.to) };
      save();
      const d = await make(result);
      state.actions[key] = { status: "prepared", at: t.toISOString(), kind: info.kind, threadId: d.threadId, draftId: d.draftId, review,
        to: normEmail(info.to), autoSend: !!info.autoSend && !review, paced: !!info.paced, ...(info.messageClass ? { messageClass: info.messageClass } : {}) };
      if (info.basis && d.threadId) state.compliantThreads[d.threadId] = { to: normEmail(info.to), basis: info.basis, lang: info.lang || "de", at: t.toISOString() };
      if (info.paced) state.lastPacedAt = +t;
      if (d.isNew !== false) { state.prepared[d.draftId] = { key, at: t.toISOString(), kind: info.kind }; used++; }
      if (d.threadId) state.threadDrafts[d.threadId] = d.draftId;
      save();
      if (review) await gmail.markDraftForReview(d.draftId);
      // Eingehende Antwort, die nicht automatisch beantwortet werden darf: Entwurf liegt bereit, Chris wird informiert
      // (Telefon-/Terminwunsch meldet notify bereits). Ein Fehler hier stoppt den Worker nie.
      if (review && info.kind === "antwort" && !info.humanContact && info.sourceMessageId) {
        escalations.push({ threadId: info.threadId });
        try { await escalate({ messageId: info.sourceMessageId, threadId: info.threadId, company: info.company || "", contactName: info.contactName || "", reason: info.escalateReason || result.reason || "unklar" }); }
        catch (e) { log("error", "escalate_failed", { threadId: info.threadId, error: e.message }); }
      }
      log("info", "draft_prepared", { kind: info.kind, draftId: d.draftId, threadId: d.threadId, to: info.to, review, reason: result.reason });
      plan.push({ ...info, task: undefined, draftId: d.draftId, review, autoSend: state.actions[key].autoSend });
    }

    // 1) Laufende Gespräche: ausschließlich Threads aus dem Gesendet-Register.
    const threads = new Map();
    for (const s of Object.values(reg.sent || {})) {
      if (!threads.has(s.threadId)) threads.set(s.threadId, []);
      threads.get(s.threadId).push(s);
    }
    const followUps = [];
    // Kandidaten ohne Gmail-Kosten vorfiltern (Ausschlussadressen, inaktive Threads kosten keinen API-Call).
    const scanCandidates = [];
    let onbThreads = new Map();
    try { onbThreads = typeof onboardingThreads === "function" ? onboardingThreads() || new Map() : new Map(); } catch (e) { log("error", "onboarding_threads_failed", { error: e.message }); }
    for (const [threadId, entries] of threads) {
      const recips = [...new Set(entries.map((e) => normEmail(e.to)))];
      if (onbThreads.has(threadId)) { ownThreads.push({ threadId, to: recips.join(", "), skipped: "onboarding" }); continue; }
      if (recips.some((r) => exclude.has(r))) { ownThreads.push({ threadId, to: recips.join(", "), skipped: "excludeAddresses" }); continue; }
      if (t - Math.max(...entries.map((e) => new Date(e.sentAt))) > cfg.activeDays * DAY_MS) { ownThreads.push({ threadId, to: recips.join(", "), skipped: "inaktiv" }); continue; }
      scanCandidates.push({ threadId, entries, recips });
    }
    // TF-037 INKREMENTELL statt Vollscan: Threads mit neuen Nachrichten (Gmail-History-API, 2 Quota-Units) haben Vorrang –
    // neue Kundenantworten werden also zuerst gelesen. Basisabdeckung: Round-Robin ab persistentem Cursor
    // (state.threadScanCursor in state.json, überlebt jeden Neustart). Höchstens maxThreadReadsPerTick Volltext-Reads
    // (10 Units je Thread) pro Durchlauf; der Rest kommt in den nächsten Durchläufen dran, nichts geht verloren.
    // Foreign-Gmail-Schutz unverändert: gelesen wird nur über readThread (eigene Threads aus dem Gesendet-Register).
    let changedSet = new Set(), historyNext = null;
    if (!dry && typeof gmail.changedThreadIds === "function") {
      try {
        const syncState = typeof gmail.loadSyncState === "function" ? gmail.loadSyncState() : {};
        const ch = await gmail.changedThreadIds({ sinceHistoryId: syncState.history_id || null });
        changedSet = new Set(ch.threadIds || []);
        historyNext = ch.historyId || null;
        if (ch.invalid) log("warn", "gmail_history_recovered", { note: "historyId abgelaufen - Round-Robin deckt die Luecke ab, kein Vollscan" });
      } catch (e) {
        if (!TRANSIENT_RE.test(e.message)) throw e;
        degrade("history", e); // ohne History in diesem Durchlauf: nur Round-Robin im Budget
      }
    }
    const scanBudget = Math.max(1, Number(cfg.maxThreadReadsPerTick) || 20);
    const prioThreads = scanCandidates.filter((c) => changedSet.has(c.threadId));
    const restThreads = scanCandidates.filter((c) => !changedSet.has(c.threadId)).sort((a, b) => a.threadId.localeCompare(b.threadId));
    let restStart = restThreads.findIndex((c) => c.threadId > String(state.threadScanCursor || ""));
    if (restStart < 0) restStart = 0;
    const scanOrder = [...prioThreads, ...restThreads.map((_, i) => restThreads[(restStart + i) % restThreads.length])];
    let scanned = 0, scanAborted = false;
    for (const { threadId, entries, recips } of scanOrder) {
      if (scanned >= scanBudget) { ownThreads.push({ threadId, to: recips.join(", "), skipped: "quota_budget" }); continue; }
      try {
        scanned++;
        const { messages } = await gmail.readThread(threadId);
        if (!changedSet.has(threadId)) state.threadScanCursor = threadId; // Round-Robin-Fortschritt, persistent
        const mails = messages.filter((m) => !m.draft);
        const own = mails.filter((m) => m.sent), ext = mails.filter((m) => !m.sent);
        const lastOwnAt = own.at(-1)?.internalDate || 0;
        const seen = { threadId, to: recips.join(", "), sent: own.length, external: ext.length, newReplies: ext.filter((m) => !state.handled[m.messageId]).length };
        ownThreads.push(seen);

        let toAnswer = null;
        for (const m of ext) {
          if (state.handled[m.messageId]) continue;
          const sender = normEmail(m.replyTo || m.from);
          const text = newText(m.body);
          if (BOUNCE_RE.test(m.from)) { suppress(recips, "unzustellbar", threadId); state.handled[m.messageId] = "bounce"; }
          else if (OPT_OUT_RE.test(text)) { suppress([sender, ...recips], "opt-out", threadId); state.handled[m.messageId] = "optout"; }
          else if (AUTO_SUBJECT_RE.test(m.subject)) state.handled[m.messageId] = "auto";
          else if (m.internalDate < lastOwnAt) state.handled[m.messageId] = "already-answered";
          else toAnswer = { m, sender, text, hc: detectHumanContact(text) };
        }
        // TF-066: Auftrags-Thread (Zugangs-Anfrage/Onboarding) ohne eindeutige Bindung → nie automatisch beantworten, Chris prüft.
        if (toAnswer && entries.some((e) => SERVICE_THREAD_CLASSES.has(e.messageClass))) {
          for (const x of ext) state.handled[x.messageId] ||= "service_thread_unbound";
          escalations.push({ threadId });
          try { await escalate({ messageId: toAnswer.m.messageId, threadId, company: companyFor(toAnswer.sender), contactName: displayName(toAnswer.m.from), reason: "Antwort im Auftrags-Thread ohne eindeutige Auftragsbindung" }); }
          catch (e) { log("error", "escalate_failed", { threadId, error: e.message }); }
          continue;
        }
        const blocked = recips.some((r) => supp[r]) || (toAnswer && supp[toAnswer.sender]);
        const pendingDraft = state.threadDrafts[threadId];
        if (blocked) {
          if (isPending(pendingDraft) && !dry && !state.actions["blocked:" + pendingDraft]) {
            await gmail.markDraftForReview(pendingDraft);
            state.actions["blocked:" + pendingDraft] = { status: "marked", at: t.toISOString() };
            log("warn", "pending_draft_for_suppressed_contact", { draftId: pendingDraft, threadId });
          }
          if (toAnswer) state.handled[toAnswer.m.messageId] = "suppressed";
          continue;
        }

        if (toAnswer) {
          const { m, sender, text, hc } = toAnswer;
          // Kunde will telefonieren/persönlich sprechen: sofort Chris benachrichtigen (je Message-ID nur einmal) –
          // auch im Dry-Run und bei erreichtem Tageslimit. Ein Fehler hier stoppt den Worker nie.
          if (hc) {
            humanContacts.push({ threadId, kind: hc.kind });
            try { await notify({ messageId: m.messageId, threadId, company: companyFor(sender), contactName: displayName(m.from), kind: hc.kind, sentence: hc.sentence }); }
            catch (e) { log("error", "notify_failed", { threadId, error: e.message }); }
          }
          if (free() <= 0) { notes.push(`Tageslimit erreicht – Antwort in ${threadId} folgt morgen.`); continue; }
          const key = "reply:" + m.messageId;
          // Eskalation statt Auto-Antwort: heikler Inhalt (Vertrag, Zahlung, Rabatt, Passwort …), Telefon-/Terminwunsch
          // oder unklare Identität (Absender ist nicht der von Jarvis angeschriebene Empfänger).
          const risky = text.match(ESCALATE_RE)?.[0];
          const identityUnclear = !recips.includes(sender);
          const escalateReason = risky ? `heikler Inhalt: ${risky}` : identityUnclear ? "unklare Identität des Absenders" : null;
          const res = await prepare(key, {
            // Wunsch nach Telefonat/Termin ist immer ein Eskalationsfall: nur Entwurf, nie automatisch senden.
            kind: "antwort", threadId, to: sender, subject: m.subject, escalate: !!escalateReason || !!hc, escalateReason, humanContact: !!hc,
            sourceMessageId: m.messageId, company: companyFor(sender), contactName: displayName(m.from),
            autoSend: !!state.compliantThreads[threadId] && !escalateReason && !hc,
            task: { kind: "reply", humanContact: hc?.kind || null, sender: cfg.sender, offer: cfg.offer, paymentOptions: paymentOptions(), thread: mails.map((x) => ({ from: x.from, date: x.date, subject: x.subject, body: (x.sent ? x.body : newText(x.body) || x.body).slice(0, 4000) })) },
          }, async (r) => {
            // Ein noch offener eigener Entwurf in diesem Thread wird aktualisiert statt verdoppelt.
            if (isPending(pendingDraft)) return { ...(await gmail.updateDraft(pendingDraft, { body: r.body })), draftId: pendingDraft, isNew: false };
            return gmail.replyToThread(threadId, { body: r.body });
          });
          // Ohne KI-Budget bleibt die Kundenantwort unbearbeitet und wird nach der Pause beantwortet.
          if (!dry && res !== AI_BUDGET_EXHAUSTED) for (const x of ext) state.handled[x.messageId] ||= res === "optout" ? "optout" : "answered";
          continue;
        }

        // Follow-ups nur, wenn noch nie eine externe Antwort kam und kein eigener Entwurf offen ist.
        // Kein automatischer Follow-up für Einzel-/Cold-Threads (auch nicht nach manuellem Versand durch Chris).
        // TF-066: Service-Threads bezahlter Aufträge (Zugang, Onboarding, Lieferung) bekommen nie einen Follow-up-Funnel.
        const coldThread = entries.some((e) => e.mode === COLD_MODE || e.manual || e.messageClass) || state.compliantThreads[threadId]?.basis === INDIVIDUAL_BASIS;
        if (ext.length === 0 && !isPending(pendingDraft) && !coldThread) {
          const n = own.length;
          const due = n === 1 ? own[0].internalDate + cfg.followUpDays[0] * DAY_MS : n === 2 ? own[1].internalDate + cfg.followUpDays[1] * DAY_MS : null;
          if (due) seen.followUpDue = new Date(due).toISOString();
          if (due && t >= due) followUps.push({ threadId, n, own, to: recips[0] });
        }
      } catch (e) {
        // TF-037: Gmail-Quota/Netz → Scan hier beenden (Cursor bleibt stehen), Rest des Durchlaufs läuft weiter – kein Tick-Abbruch.
        if (TRANSIENT_RE.test(e.message)) { degrade("reply_scan", e); scanAborted = true; break; }
        log("error", "thread_failed", { threadId, error: e.message }); // ein Kontakt stoppt nie den Worker
      }
    }
    // historyId erst vorrücken, wenn alle geänderten Threads wirklich gelesen wurden – sonst liefert der nächste
    // Durchlauf dieselben Änderungen erneut (keine verlorenen Antworten, keine Duplikate dank state.handled).
    if (!dry && !readOnly && historyNext && !scanAborted && prioThreads.length <= scanned && typeof gmail.saveSyncState === "function")
      gmail.saveSyncState({ history_id: historyNext, last_history_sync_at: t.toISOString() });

    // 2) Follow-ups und Erstkontakte vorbereiten: nur im Zeitfenster, wenige pro Durchlauf, Reserve für Antworten bleibt frei.
    // Gesendet wird erst im nächsten Versandfenster (Schritt 4).
    const inWindow = zurichMinutes(t) >= hm(cfg.window[0]) && zurichMinutes(t) < hm(cfg.window[1]);
    let paced = 0;
    const pacedFree = () => free() > cfg.replyReserve && paced < (dry ? Infinity : cfg.maxPacedPerTick);
    if (!inWindow) notes.push(`Follow-ups und Erstkontakte werden nur ${cfg.window[0]}–${cfg.window[1]} vorbereitet (Europe/Zurich).`);
    for (const f of followUps) {
      if (!(inWindow || dry) || !pacedFree()) break;
      try {
        const key = `followup:${f.threadId}:${f.n}`;
        await prepare(key, {
          kind: `follow-up ${f.n}`, threadId: f.threadId, to: f.to, subject: f.own[0].subject, commercial: true, paced: true,
          // Selbst gesendet nur in Threads, die mit gültiger Versandgrundlage begonnen wurden – sonst Entwurf.
          autoSend: FOLLOWUP_BASES.has(state.compliantThreads[f.threadId]?.basis), lang: state.compliantThreads[f.threadId]?.lang,
          task: { kind: "followup", followupNumber: f.n, sender: cfg.sender, offer: cfg.offer, thread: f.own.map((x) => ({ from: x.from, date: x.date, subject: x.subject, body: x.body.slice(0, 4000) })) },
        }, (r) => gmail.replyToThread(f.threadId, { body: r.body }));
        paced++;
      } catch (e) {
        if (TRANSIENT_RE.test(e.message)) { degrade("followup", e); break; } // Gmail gestört: Rest folgt im nächsten Durchlauf
        log("error", "followup_failed", { threadId: f.threadId, error: e.message });
      }
    }

    // Erstkontakte ausschließlich aus der von Chris freigegebenen Lead-Liste.
    // Erstkontakte nur mit gültiger Versandgrundlage – eine öffentliche Adresse oder approved allein genügt nicht.
    const leads = store.read("leads.json", []);
    const canWrite = !!(cfg.offer && cfg.sender.name);
    let leadsChanged = false;
    const contacted = new Set(Object.values(reg.sent || {}).concat(Object.values(reg.drafts || {})).map((x) => normEmail(x.to)));
    const seenLeads = new Set();
    for (const lead of Array.isArray(leads) ? leads : []) {
      const to = normEmail(lead.email);
      if (lead.approved !== true || !EMAIL_RE.test(to) || seenLeads.has(to)) continue;
      seenLeads.add(to);
      const basis = legalBasis(lead, t);
      if (!basis) {
        blockedLeads.push(to);
        if (lead.status !== "blocked_no_legal_basis") { lead.status = "blocked_no_legal_basis"; leadsChanged = true; }
        continue;
      }
      if (lead.status === "blocked_no_legal_basis") { delete lead.status; leadsChanged = true; } // Grundlage wurde nachgetragen
      if (contacted.has(to) || supp[to] || exclude.has(to) || state.actions["outreach:" + to]) continue;
      eligibleLeads.push(to);
      if (!canWrite || !(inWindow || dry) || !pacedFree()) continue;
      try {
        const { name, company, website, language, notes: leadNotes, websiteIssues } = lead;
        await prepare("outreach:" + to, {
          kind: "erstkontakt", to, subject: company || name || to, basis, lang: language, commercial: true, paced: true, autoSend: true, noIssues: !websiteIssues?.length,
          // TF-024: angefragter Kontakt / Ausschreibung ist SOLICITED_RESPONSE (nur im angefragten Umfang), nie Marketing.
          messageClass: MARKETING_LEGAL.has(basis) ? "MARKETING" : "SOLICITED_RESPONSE",
          task: { kind: "outreach", sender: cfg.sender, offer: cfg.offer, ...(MARKETING_LEGAL.has(basis) ? {} : { solicitedScope: String(lead.responseScope || lead.response_scope || lead.rfpScope || lead.rfp_scope || "") }),
            lead: { name, company, website, language, notes: leadNotes, websiteIssues: websiteIssues || [] } },
        }, (r) => gmail.createDraft({ to: name ? `${name.replace(/[<>"\r\n]/g, "")} <${to}>` : to, subject: r.subject || "Kurze Frage", body: r.body }));
        paced++;
      } catch (e) {
        if (TRANSIENT_RE.test(e.message)) { degrade("outreach", e); break; } // Gmail gestört: Rest folgt im nächsten Durchlauf
        log("error", "outreach_failed", { to, error: e.message });
      }
    }
    if (eligibleLeads.length && !canWrite) notes.push("Erstkontakte deaktiviert: in config.json fehlen offer und/oder sender.name.");
    // Nur den Status nachtragen – frisch gelesen, damit gleichzeitige Änderungen von Chris an der Liste erhalten bleiben.
    if (leadsChanged && !readOnly) {
      const status = new Map(leads.filter((l) => l && l.email).map((l) => [normEmail(l.email), l.status]));
      const current = store.read("leads.json", []);
      for (const l of Array.isArray(current) ? current : []) {
        const k = normEmail(l?.email);
        if (!status.has(k) || l.approved !== true) continue;
        if (legalBasis(l, t)) delete l.status; else if (status.get(k) === "blocked_no_legal_basis") l.status = "blocked_no_legal_basis";
      }
      store.write("leads.json", current);
    }

    // 3) Cloud-Mailaufträge (manual_chris_mail): ein Cloud-Auftrag ist keine Freigabe. Es gelten exakt dieselben Regeln wie für
    // Erstkontakte bzw. Antworten im eigenen Thread. Erlaubte Aufträge werden zeitnah gesendet (Schritt 4), nicht erst im Fenster.
    const inbox = store.read(CLOUD_INBOX, {});
    const cloudResults = [];
    const cloudSet = (id, status, reason = null) => {
      const e = inbox[id];
      if (!e || (e.status === status && e.reason === reason)) return;
      Object.assign(e, { status, reason, updatedAt: t.toISOString(), synced: false });
      cloudResults.push({ request_id: id, status, reason });
      log("info", "cloud_request_" + status, { request_id: id, reason });
    };
    const saveInbox = () => { if (!readOnly && cloudResults.length) store.write(CLOUD_INBOX, { ...store.read(CLOUD_INBOX, {}), ...inbox }); };
    // TF-077B SEND_PREPARED_LEAD_DRAFT («E-Mail lossenden» eines Verkäufers): genau DEN vorbereiteten Jarvis-Entwurf dieses Leads senden – sofort,
    // ohne Text aus der Cloud. Erneut geprüft: Recht + Markt aus den serverseitigen Metadaten, Entwurf gehört dem Lead und ist der angezeigte
    // (draft_ref), Empfänger = CRM-Adresse = Entwurfsadresse, Suppression/Opt-out (auch Domain), Lead-Datenbank/CRM-DNC (fail closed), Send-Lock.
    // Idempotent je (Lead, draft_ref): bereits gesendet → nie erneut; unklarer Ausgang (Absturz während Gmail) → nie automatisch wiederholen.
    state.sellerSends ||= {};
    async function sendPrepared(id, rq, to) {
      const m = rq.meta || {}, ref = rq.draft_ref;
      const key = `seller-send:${m.lead_id}:${ref}`, prior = state.sellerSends[key];
      if (!m.lead_id || !ref || m.market !== "CH" || !(SERVER_SEND_USERS.includes(m.actor_user_id) || m.actor_user_id === "chris")) return cloudSet(id, "blocked", "Unzulässiger Sendeauftrag.");
      const regNow = gmail.listOwned();
      const already = Object.values(regNow.sent || {}).find((x) => x.sellerSend && x.leadId === m.lead_id && x.draftRef === ref);
      if (already || prior?.status === "sent") {
        state.sellerSends[key] = { ...prior, status: "sent", at: prior?.at || already?.sentAt || t.toISOString() }; save();
        return cloudSet(id, "sent", "Bereits gesendet – keine zweite Mail.");
      }
      const draft = Object.entries(regNow.drafts || {}).find(([, d]) => d.mode === COLD_MODE && d.leadId === m.lead_id && draftRef(d.messageId) === ref);
      if (!draft) return cloudSet(id, "blocked", "Der vorbereitete Entwurf ist nicht mehr vorhanden oder wurde geändert.");
      if (regNow.sending?.[draft[0]] || prior?.status === "sending") {
        state.sellerSends[key] = { ...prior, status: "send_unknown" }; save();
        log("warn", "seller_send_unknown", { lead_id: m.lead_id, draftId: draft[0] });
        return cloudSet(id, "failed", "Versandstatus unklar – nicht wiederholt, Chris prüft.");
      }
      if (!EMAIL_RE.test(to) || normEmail(draft[1].to) !== to) return cloudSet(id, "blocked", "Empfänger stimmt nicht mit dem vorbereiteten Entwurf überein.");
      const suppNow = { ...store.read("suppression.json", {}), ...supp };
      const dom = to.split("@")[1] || "";
      if (suppNow[to] || exclude.has(to) || (!FREEMAIL_RE.test(to) && Object.keys(suppNow).some((a) => a.split("@")[1] === dom && !FREEMAIL_RE.test(a))))
        return cloudSet(id, "blocked", "Empfänger ist gesperrt (Abmeldung/Suppression).");
      let db = null;
      try { db = loadRegistry(store); } catch (e) { log("error", "lead_registry_read_failed", { error: e.message }); }
      const why = db ? registryBlock(store, { lead_id: m.lead_id, email: to }, db) : CRM_UNAVAILABLE;
      if (why === CRM_UNAVAILABLE) return log("warn", "seller_send_held_crm_unavailable", { lead_id: m.lead_id }); // bleibt offen, nächster Durchlauf
      if (why) return cloudSet(id, "blocked", "Lead gesperrt: " + why);
      const lock = await sendGuard.acquire({ key, request_id: id, messageId: draft[1].messageId || null });
      if (!lock.ok) { if (lock.final) cloudSet(id, "blocked", "Bereits gesendet oder in Arbeit (Send-Lock)."); return; }
      state.sellerSends[key] = { status: "sending", at: t.toISOString(), draftId: draft[0], request_id: id, by: m.actor_user_id };
      save();
      try {
        const info = await gmail.sendPreparedLeadDraft(draft[0], { leadId: m.lead_id, to, draftRef: ref, refOf: draftRef, actor: m.actor_user_id });
        state.sellerSends[key] = { ...state.sellerSends[key], status: "sent", sentAt: t.toISOString(), threadId: info.threadId || null };
        save();
        await sendGuard.done(key, "SENT");
        contacted.add(to);
        sends.push({ kind: "verkaeufer-mail", mailClass: "seller_prepared_send", to, threadId: info.threadId || null, window: null });
        // Cold-Register: der Lead gilt als angeschrieben (wie ein manueller Versand – Rechtsgrundlage bleibt NONE, kein Follow-up-Funnel).
        const cold = store.read(COLD_DRAFTS_FILE, { reviews: {} });
        if (cold.reviews?.[m.lead_id]) { cold.reviews[m.lead_id] = { ...markManualSend(cold.reviews[m.lead_id], { messageId: info.messageId, threadId: info.threadId, sentAt: t.toISOString() }), seller_sent_by: m.actor_user_id }; store.write(COLD_DRAFTS_FILE, cold); }
        log("info", "seller_send_sent", { lead_id: m.lead_id, by: m.actor_user_id, draftId: draft[0], threadId: info.threadId || null });
        cloudSet(id, "sent", "Gesendet.");
      } catch (err) {
        // Nicht gesendet (Gmail hat abgelehnt bzw. der Entwurf existiert nicht mehr) – nie als SENT markieren; ein neuer Klick darf es erneut versuchen.
        state.sellerSends[key] = { ...state.sellerSends[key], status: "failed", error: String(err.message).slice(0, 160) };
        save();
        await sendGuard.done(key, "FAILED");
        log("error", "seller_send_failed", { lead_id: m.lead_id, error: String(err.message).slice(0, 160) });
        cloudSet(id, "failed", "E-Mail konnte nicht gesendet werden.");
      }
    }
    for (const [id, e] of Object.entries(inbox)) {
      if (e.status !== "pending" || dry) continue;
      const rq = e.request || {};
      const to = normEmail(rq.recipient);
      const text = `${rq.subject || ""} ${rq.body || ""}`;
      try {
        if (!rq.expires_at || Date.parse(rq.expires_at) <= +t) { cloudSet(id, "expired", "Abgelaufen, bevor der lokale Worker ihn prüfen konnte."); continue; }
        if (rq.delivery === "send_prepared") { await sendPrepared(id, rq, to); continue; }
        if (!EMAIL_RE.test(to) || !rq.subject || !rq.body) { cloudSet(id, "blocked", "Empfänger, Betreff oder Text ungültig."); continue; }
        const manualTest = rq.manual_test === true;
        if (manualTest && !isManualTestMail(rq)) { cloudSet(id, "blocked", "MANUAL_TEST-Auftrag ist nicht exakt an den autorisierten Praxis-Kälin-Test gebunden."); continue; }
        if (supp[to] || exclude.has(to)) { cloudSet(id, "blocked", "Empfänger ist gesperrt (Abmeldung/Suppression)."); continue; }
        // delivery "draft": nur ein Gmail-Entwurf, nie gesendet (kein state.actions-Eintrag, also nie in der Send-Queue).
        // Neue Mails als COLD_LEAD_DRAFT_ONLY (gmail.js verweigert jeden Jarvis-Send); Chris prüft und sendet selbst in Gmail.
        if (rq.delivery === "draft") {
          const key = "cloud-draft:" + id;
          if (state.cloudDrafts[key]) { cloudSet(id, "drafted", "Entwurf liegt bereits in Gmail."); continue; }
          let threadId = null;
          if (rq.optional_thread_reference) {
            threadId = [...new Set(Object.values(reg.sent || {}).map((x) => x.threadId))].find((tid) => threadRef(tid) === rq.optional_thread_reference) || null;
            if (!threadId) { cloudSet(id, "blocked", "Thread unbekannt oder nicht von Jarvis begonnen."); continue; }
          }
          const lang = (Array.isArray(leads) ? leads : []).find((l) => normEmail(l?.email) === to)?.language || "de";
          // TF-064: Absenderprofil aus den serverseitig gebundenen Metadaten (actor/market) – VN: Lap-Signatur + vi-Abmeldezeile.
          const body = finalizeForProfile(rq.body, senderProfileFor(rq.meta, cfg.sender), lang);
          const d = threadId ? await gmail.replyToThread(threadId, { body, mode: COLD_MODE }) : await gmail.createDraft({ to, subject: rq.subject, body, mode: COLD_MODE });
          state.cloudDrafts[key] = { draftId: d.draftId, threadId: d.threadId, at: t.toISOString() };
          save();
          cloudSet(id, "drafted", "Entwurf liegt in Gmail – senden nur durch Chris.");
          continue;
        }
        // Der einzige bewusst freigegebene Sonderfall für einen internen E2E-Test:
        // weiterhin nur OWNER-Auftrag, gültiger Worker mit compliant_auto und echte Gmail-OAuth.
        // Keine KI, keine CRM-/Marketing-Grundlage und keine anderen Empfänger.
        if (manualTest) {
          if (!auto) { cloudSet(id, "blocked", "MANUAL_TEST benötigt den autorisierten Versandmodus compliant_auto."); continue; }
          const key = "cloud:" + id;
          if (state.actions[key]) continue;
          if (free() <= 0) { notes.push("Tageslimit erreicht – MANUAL_TEST-Auftrag wird im nächsten Durchlauf geprüft."); continue; }
          state.actions[key] = { status: "creating", at: t.toISOString(), kind: "cloud-auftrag", threadId: null, to, manualTest: true, manualTestLeadId: MANUAL_TEST_MAIL.lead_id };
          save();
          const d = await gmail.createDraft({ to, subject: rq.subject, body: rq.body });
          state.actions[key] = { status: "prepared", at: t.toISOString(), kind: "cloud-auftrag", threadId: d.threadId, draftId: d.draftId, review: false, to,
            autoSend: true, paced: false, manualTest: true, manualTestLeadId: MANUAL_TEST_MAIL.lead_id, cloudRequest: id };
          state.prepared[d.draftId] = { key, at: t.toISOString(), kind: "cloud-auftrag" };
          used++;
          cloudSet(id, "accepted_local", "Gebundener interner TEST-Auftrag geprüft – wird jetzt gesendet.");
          save();
          continue;
        }
        // TF-064: VN-/Verkäufer-Aufträge sind immer COLD_LEAD_DRAFT_ONLY – nie ein Versand, keine Versandgrundlage aus Metadaten.
        if (rq.meta) { cloudSet(id, "blocked", "Verkäufer-/VN-Auftrag: nur Entwurf (COLD_LEAD_DRAFT_ONLY), nie Versand."); continue; }
        if (!auto) { cloudSet(id, "blocked", "Automatischer Versand ist lokal nicht aktiv (sendMode/dryRun/sender)."); continue; }
        if (text.length > 6000 || ESCALATE_RE.test(text) || AI_RE.test(text)) {
          cloudSet(id, "blocked", "Inhalt braucht persönliche Prüfung (Vertrag, Zahlung, Preis, KI-Hinweis o. ä.) – bitte lokal schreiben."); continue;
        }
        let threadId = null, basis = null, lang = "de";
        if (rq.optional_thread_reference) {
          threadId = [...new Set(Object.values(reg.sent || {}).map((x) => x.threadId))].find((tid) => threadRef(tid) === rq.optional_thread_reference) || null;
          if (!threadId) { cloudSet(id, "blocked", "Thread unbekannt oder nicht von Jarvis begonnen."); continue; }
          basis = state.compliantThreads[threadId]?.basis || null;
          lang = state.compliantThreads[threadId]?.lang || "de";
          if (!basis) { cloudSet(id, "blocked", "Keine Versandgrundlage für diesen Thread (blocked_no_legal_basis)."); continue; }
          if (isPending(state.threadDrafts[threadId])) { cloudSet(id, "blocked", "In diesem Thread liegt schon ein offener Entwurf."); continue; }
        } else {
          const lead = (Array.isArray(leads) ? leads : []).find((l) => normEmail(l?.email) === to);
          basis = legalBasis(lead, t);
          lang = lead?.language || "de";
          // Eine öffentlich gefundene Adresse allein ist keine Versandgrundlage.
          if (!basis) { cloudSet(id, "blocked", "Keine Versandgrundlage (opt_in oder Bestandskunde nötig) – blocked_no_legal_basis."); continue; }
          if (contacted.has(to) || state.actions["outreach:" + to]) { cloudSet(id, "blocked", "Duplikat: Empfänger wurde bereits angeschrieben – bitte im bestehenden Thread antworten."); continue; }
        }
        if (free() <= 0) { notes.push("Tageslimit erreicht – Cloud-Auftrag wird morgen geprüft."); continue; }
        const key = "cloud:" + id;
        if (state.actions[key]) continue;
        state.actions[key] = { status: "creating", at: t.toISOString(), kind: "cloud-auftrag", threadId, to };
        save();
        const body = finalizeCommercial(rq.body, cfg.sender, lang);
        const d = threadId ? await gmail.replyToThread(threadId, { body }) : await gmail.createDraft({ to, subject: rq.subject, body });
        state.actions[key] = { status: "prepared", at: t.toISOString(), kind: "cloud-auftrag", threadId: d.threadId, draftId: d.draftId, review: false, to, autoSend: true, paced: false,
          cloudRequest: id, ...(threadId ? {} : { basisFrom: "lead" }) };
        state.compliantThreads[d.threadId] ||= { to, basis, lang, at: t.toISOString() };
        state.prepared[d.draftId] = { key, at: t.toISOString(), kind: "cloud-auftrag" };
        if (d.threadId) state.threadDrafts[d.threadId] = d.draftId;
        used++;
        contacted.add(to);
        cloudSet(id, "accepted_local", "Geprüft – wird jetzt gesendet.");
        save();
      } catch (err) {
        if (TRANSIENT_RE.test(err.message)) { saveInbox(); throw err; }
        log("error", "cloud_request_failed", { request_id: id, error: err.message });
        cloudSet(id, "failed", "Entwurf konnte lokal nicht angelegt werden.");
      }
    }

    // 3b) TF-025 Cold-Lead-Entwürfe (COLD_LEAD_DRAFT_ONLY): nur ENTWURF in Gmail anlegen, bearbeiten oder verwerfen – nie senden.
    // Sie kommen nie in state.actions (also nie in die Send-Queue, nie in ein Kampagnenfenster) und zählen nicht als Send.
    const coldData = store.read(COLD_DRAFTS_FILE, { reviews: {} });
    const coldPatch = {};
    const suppAll = { ...store.read("suppression.json", {}), ...supp };
    const domainSuppressed = (d) => Object.keys(suppAll).some((a) => a.split("@")[1] === d && !FREEMAIL_RE.test(a));
    // DRAFT-WORKER (24/7, auch ausserhalb der Versandfenster): KEIN geschäftliches Maximum – jeder queued-Eintrag wird früher oder später
    // zum Gmail-Entwurf. Nur technisches Pacing (config.discovery: draftPaceMs zwischen zwei Entwürfen, draftsPerPass je Durchlauf) und
    // exponentieller Backoff bei 429/5xx/Netzfehlern der Gmail-API (persistiert in draft_worker; verschiebt nur, verwirft nie).
    const dl = { draftPaceMs: 1500, draftsPerPass: 25, ...(store.read("config.json", {}).discovery || {}) };
    const dw = { ...(coldData.draft_worker || {}) };
    const dwBackoff = !!dw.backoffUntil && Date.parse(dw.backoffUntil) > +t;
    if (dwBackoff && !dry && !readOnly) log("info", "draft_worker_backoff_wait", { until: dw.backoffUntil });
    // Kunden werden nie als Cold Lead angeschrieben – frisch gelesen direkt vor dem Gmail-Entwurf.
    // TF-047: Kunden des separaten Repair-Service (eigener Zustand, read-only eingebunden) zählen genauso.
    const salesRecords = { ...repairSalesRecords(), ...(store.read("sales.json", { records: {} }).records || {}) };
    const isCustomer = (domain) => !!salesRecords[domain]?.sale?.selected_offer;
    // Lead-Datenbank (frisch gelesen): bereits angeschrieben / Antwort / Kunde / kein Interesse / Suppression / Opt-out / Do-not-contact → nie ein Cold-Entwurf.
    let leadDb = null;
    try { leadDb = loadRegistry(store); } catch (e) { log("error", "lead_registry_read_failed", { error: e.message }); }
    let createdThisPass = 0, dwChanged = false, crmHeld = 0;
    const queuedInOrder = Object.entries(coldData.reviews || {}).sort(([, a], [, b]) => String(a?.created_at || "").localeCompare(String(b?.created_at || "")));
    for (const [id, rv] of queuedInOrder) {
      if (!rv || rv.draft_mode !== COLD_MODE && rv.status !== "queued") continue;
      const to = normEmail(rv.recipient || "");
      if (dry || readOnly) { if (rv.status === "queued") plan.push({ kind: "cold-entwurf", to, subject: rv.subject, autoSend: false, review: true }); continue; }
      try {
        if (rv.status === "queued") {
          // DEDUPE DIREKT VOR GMAIL: Suppression/Opt-out (auch Domain), Ausschluss, Adresse, bereits kontaktiert/Entwurf vorhanden, Kunde.
          if (suppAll[to] || exclude.has(to) || domainSuppressed(rv.domain)) { coldPatch[id] = { status: "blocked", blocked_reason: "suppression" }; continue; }
          if (!EMAIL_RE.test(to) || FREEMAIL_RE.test(to)) { coldPatch[id] = { status: "blocked", blocked_reason: "keine geschäftliche Adresse" }; continue; }
          if (contacted.has(to)) { coldPatch[id] = { status: "blocked", blocked_reason: "bereits kontaktiert/Entwurf vorhanden" }; continue; }
          if (isCustomer(rv.domain)) { coldPatch[id] = { status: "blocked", blocked_reason: "bestehender Kunde" }; continue; }
          if (!leadDb) continue; // Lead-Datenbank nicht lesbar → fail closed: Eintrag bleibt queued, kein Entwurf ohne Dedupe
          const dbWhy = registryBlock(store, { lead_id: id, domain: rv.domain, email: to, company: rv.company }, leadDb);
          // TF-053 fail-safe: CRM (Do Not Contact) nicht lesbar → Eintrag bleibt queued, kein Entwurf, nichts dauerhaft blockiert
          if (dbWhy === CRM_UNAVAILABLE) { if (!crmHeld++) log("warn", "cold_draft_held_crm_unavailable", {}); continue; }
          if (dbWhy) { coldPatch[id] = { status: "blocked", blocked_reason: "Lead-Datenbank: " + dbWhy }; continue; }
          if (dwBackoff) continue; // Gmail-API im Backoff: Eintrag bleibt queued, nächster Durchlauf
          if (createdThisPass >= dl.draftsPerPass) continue; // technisches Pacing je Durchlauf – Rest bleibt in der Queue
          if (createdThisPass > 0 && dl.draftPaceMs > 0) await sleep(dl.draftPaceMs);
          let d;
          try { d = await gmail.createDraft({ to, subject: rv.subject, body: rv.body, mode: COLD_MODE, leadId: id, draftHash: rv.draft_hash }); }
          catch (e) {
            if (!TRANSIENT_RE.test(e.message)) throw e;
            // 429/5xx/Netz: Backoff 1 → 2 → 4 … max 60 min; Queue bleibt vollständig erhalten.
            const count = (dw.backoffCount || 0) + 1, minutes = Math.min(60, 2 ** (count - 1));
            Object.assign(dw, { backoffCount: count, backoffUntil: new Date(+t + minutes * 60_000).toISOString(), lastError: { at: t.toISOString(), message: String(e.message).slice(0, 160) } });
            dwChanged = true;
            degrade("draft_worker", e); // TF-037: Mail DEGRADED melden – Queue bleibt vollständig erhalten
            log("warn", "draft_worker_backoff", { lead_id: id, minutes, count, error: e.message });
            break;
          }
          contacted.add(to);
          createdThisPass++;
          Object.assign(dw, { backoffCount: 0, backoffUntil: null, lastDraftAt: t.toISOString(), lastError: null });
          dwChanged = true;
          coldPatch[id] = { status: "draft_created", gmail_draft_id: d.draftId, message_id: d.messageId || null, thread_id: d.threadId, draft_created_at: t.toISOString() };
          log("info", "cold_draft_created", { lead_id: id, draftId: d.draftId });
        } else if (rv.status === "draft_created" && rv.discard_requested) {
          await gmail.deleteDraft(rv.gmail_draft_id); // nur eigene Entwürfe (gmail.js prüft Besitz)
          coldPatch[id] = { status: "discarded", discard_requested: false };
        } else if (rv.status === "draft_created" && rv.pending_update) {
          await gmail.updateDraft(rv.gmail_draft_id, { subject: rv.subject, body: rv.body }); // nur eigene Entwürfe
          coldPatch[id] = { pending_update: false };
        } else if (rv.status === "draft_created" && (suppAll[to] || domainSuppressed(rv.domain)) && !rv.suppressed_after_draft) {
          coldPatch[id] = { suppressed_after_draft: true }; // Dashboard warnt: Empfänger hat sich inzwischen abgemeldet
        }
      } catch (e) {
        // TF-037: Gmail gestört (auch bei Verwerfen/Aktualisieren) → Draft-Worker-Backoff statt Tick-Abbruch;
        // die persistente Queue bleibt vollständig erhalten, nichts wird verworfen.
        if (TRANSIENT_RE.test(e.message)) {
          const count = (dw.backoffCount || 0) + 1, minutes = Math.min(60, 2 ** (count - 1));
          Object.assign(dw, { backoffCount: count, backoffUntil: new Date(+t + minutes * 60_000).toISOString(), lastError: { at: t.toISOString(), message: String(e.message).slice(0, 160) } });
          dwChanged = true;
          degrade("draft_worker", e);
          break;
        }
        log("error", "cold_draft_failed", { lead_id: id, error: e.message });
      }
    }
    function writeCold() {
      const fresh = store.read(COLD_DRAFTS_FILE, { reviews: {} });
      for (const [id, patch] of Object.entries(coldPatch)) if (fresh.reviews?.[id]) fresh.reviews[id] = { ...fresh.reviews[id], ...patch, updated_at: t.toISOString() };
      if (dwChanged) fresh.draft_worker = dw; // Backoff/letzter Entwurf persistent – überlebt Neustart
      store.write(COLD_DRAFTS_FILE, fresh);
    }
    if (Object.keys(coldPatch).length || dwChanged) writeCold();

    // 4) Versand. Gesprächsantworten (conversation_reply) und manuelle Aufträge von Chris (manual_chris_mail) gehen zeitnah
    // raus, rund um die Uhr. Kampagnen (automatic_sales_outreach, sales_followup) ausschliesslich in den zwei Versandfenstern,
    // je Fenster genau ein Lauf (persistiert vor dem ersten Send). Direkt vor jedem Send erneut Suppression, Empfänger,
    // Versandgrundlage und Kapazität prüfen – und ein serverseitiges Send-Lock holen (nie zwei Worker für dieselbe Mail).
    const win = sendWindowAt(t);
    state.windows = Object.fromEntries(Object.entries(state.windows || {}).filter(([d]) => d === day)); // nur heute
    const todayWin = (state.windows[day] ||= {});
    const runWindow = !!(auto && win && !todayWin[win.id]);
    if (auto && !win) notes.push("Kampagnen (Erstkontakte, Follow-ups) nur in den Fenstern 09:30 und 14:30 (Europe/Zurich).");
    if (auto && win && todayWin[win.id]) notes.push(`Versandfenster ${win.id} heute bereits ausgeführt.`);
    const queue = auto ? Object.entries(state.actions).filter(([, a]) => a.status === "prepared" && a.autoSend && (IMMEDIATE_CLASSES.has(mailClassOf(a)) || runWindow))
      .sort(([, a], [, b]) => (IMMEDIATE_CLASSES.has(mailClassOf(b)) - IMMEDIATE_CLASSES.has(mailClassOf(a))) || (a.paced - b.paced) || a.at.localeCompare(b.at)) : [];
    if (runWindow) {
      todayWin[win.id] = { executedAt: t.toISOString(), status: "running", sent: 0 };
      save(); // ab hier gilt das Fenster als ausgeführt – auch nach Absturz oder Neustart
    }
    if (queue.length) {
      const fresh = gmail.listOwned();
      const isToday = (x) => x.sentAt && zurichDay(new Date(x.sentAt)) === day;
      const todays = [...Object.values(fresh.sent || {}), ...Object.values(fresh.sending || {})].filter(isToday);
      let sentNow = todays.length, inWin = runWindow ? todays.filter((x) => x.window === win.id).length : 0;
      const freshLeads = store.read("leads.json", []);
      const blockAt = (key, a, status, reason) => {
        Object.assign(a, { status, reason, blockedAt: t.toISOString() });
        log("warn", "send_blocked", { key, status, reason });
        if (a.cloudRequest) cloudSet(a.cloudRequest, "blocked", reason);
      };
      for (const [key, a] of queue) {
        const campaign = !IMMEDIATE_CLASSES.has(mailClassOf(a));
        if (!fresh.drafts?.[a.draftId]) {
          a.status = Object.values(fresh.sent || {}).some((x) => x.fromDraft === a.draftId) ? "sent_by_sir" : "draft_gone";
          if (a.cloudRequest) cloudSet(a.cloudRequest, "failed", "Entwurf wurde in Gmail entfernt oder von Hand gesendet.");
          continue;
        }
        if (sentNow >= cfg.limit) { notes.push(`Tageslimit von ${cfg.limit} erreicht – weiterer Versand erst morgen.`); break; }
        if (campaign && inWin >= win.limit) { notes.push(`Fensterlimit von ${win.limit} erreicht – Rest folgt im nächsten Versandfenster.`); break; }
        const suppNow = { ...store.read("suppression.json", {}), ...supp };
        const to = normEmail(fresh.drafts[a.draftId].to);
        if (suppNow[to] || suppNow[a.to] || exclude.has(to)) { blockAt(key, a, "suppressed", "Empfänger ist gesperrt (Abmeldung/Suppression)."); continue; }
        if (!EMAIL_RE.test(to)) { blockAt(key, a, "blocked", "Empfänger ungültig."); continue; }
        // Cold-Lead-Entwürfe (und Altlasten aus TF-022) sendet Jarvis nie – nur Chris manuell in Gmail. Vor allen anderen Prüfungen.
        if (!a.manualTest && (a.kind === "einzelmail" || fresh.drafts[a.draftId]?.mode === COLD_MODE)) { blockAt(key, a, "cold_draft_never_auto", "COLD_LEAD_DRAFT_ONLY – nur manueller Versand durch Chris."); continue; }
        if (!a.manualTest && fresh.drafts[a.draftId]?.mode === CONTACT_FORM_DRAFT_MODE) { blockAt(key, a, "contact_form_draft_never_auto", "CONTACT_FORM_DRAFT_ONLY – nur manueller Versand durch Chris."); continue; }
        if (a.manualTest && (!isBoundManualTestDraft(fresh.drafts[a.draftId]) || a.manualTestLeadId !== MANUAL_TEST_MAIL.lead_id || a.to !== MANUAL_TEST_MAIL.recipient)) {
          blockAt(key, a, "manual_test_binding_failed", "MANUAL_TEST-Bindung von Empfänger, Betreff oder Text ist ungültig."); continue;
        }
        if (!a.manualTest && !state.compliantThreads[a.threadId]) { blockAt(key, a, "blocked_no_legal_basis", "Keine Versandgrundlage für diesen Thread."); continue; }
        if (!a.manualTest && (a.basisFrom === "lead" || a.kind === "erstkontakt")) {
          const lead = (Array.isArray(freshLeads) ? freshLeads : []).find((l) => normEmail(l?.email) === to);
          if (!legalBasis(lead, t)) { blockAt(key, a, "blocked_no_legal_basis", "Versandgrundlage nicht mehr gültig (blocked_no_legal_basis)."); continue; }
        }
        // Serverseitiges Lock: hält es ein anderer Worker oder ist die Mail schon gesendet → nie senden.
        // Cloud nicht erreichbar → jetzt nicht senden, Mail bleibt vorbereitet (nächster Durchlauf).
        const lock = await sendGuard.acquire({ key, request_id: a.cloudRequest || null, threadId: a.threadId, messageId: key.startsWith("reply:") ? key.slice(6) : a.draftId });
        if (!lock.ok) {
          if (lock.final) blockAt(key, a, "locked_elsewhere", "Send-Lock gehört einem anderen Worker oder Mail wurde bereits gesendet.");
          else notes.push("Send-Lock nicht erreichbar – Versand im nächsten Durchlauf.");
          if (lock.final) continue;
          break;
        }
        a.status = "sending";
        save();
        const w = campaign ? win.id : null;
        try {
          await gmail.sendDraft(a.draftId, { window: w });
          Object.assign(a, { status: "sent", sentAt: t.toISOString(), window: w, mailClass: mailClassOf(a) });
          sentNow++;
          if (campaign) { inWin++; todayWin[win.id].sent++; }
          state.lastSendAt = +t;
          sends.push({ kind: a.kind, mailClass: mailClassOf(a), to, threadId: a.threadId, window: w });
          if (a.cloudRequest) cloudSet(a.cloudRequest, "sent", campaign ? `Gesendet im Fenster ${w}.` : "Gesendet.");
          log("info", "sent", { key, kind: a.kind, mailClass: mailClassOf(a), to, draftId: a.draftId, threadId: a.threadId, window: w });
          await sendGuard.done(key, "SENT");
        } catch (err) {
          Object.assign(a, { status: "send_failed", error: err.message }); // nie automatisch wiederholen; Entwurf bleibt für Chris
          if (a.cloudRequest) cloudSet(a.cloudRequest, "failed", "Gmail hat den Versand abgelehnt.");
          log("error", "send_failed", { key, to, error: err.message });
          save();
          await sendGuard.done(key, "FAILED");
          if (TRANSIENT_RE.test(err.message)) { saveInbox(); throw err; }
        }
        save();
      }
    }
    if (runWindow) todayWin[win.id].status = "done";
    saveInbox();

    // Fensterzähler aus dem Register (zählt nur erfolgreiche bzw. unklare Sends).
    const regEnd = gmail.listOwned();
    const sentEnd = [...Object.values(regEnd.sent || {}), ...Object.values(regEnd.sending || {})].filter((x) => x.sentAt && zurichDay(new Date(x.sentAt)) === day);
    const windows = Object.fromEntries(SEND_WINDOWS.map((w) => [w.id, { sent: sentEnd.filter((x) => x.window === w.id).length, limit: w.limit, executed: !!todayWin[w.id], start: w.start }]));
    // Tageszahlen für Heartbeat und Cloud-HUD (nur Zahlen).
    const today = (iso) => !!iso && zurichDay(new Date(iso)) === day;
    const acts = Object.values(state.actions);
    const stats = {
      sent_today: sentEnd.length, campaign_morning: windows.morning.sent, campaign_afternoon: windows.afternoon.sent, campaign_today: windows.morning.sent + windows.afternoon.sent,
      replies_today: acts.filter((a) => a.status === "sent" && a.kind === "antwort" && today(a.sentAt)).length,
      manual_today: acts.filter((a) => a.status === "sent" && a.kind === "cloud-auftrag" && today(a.sentAt)).length,
      blocked_today: acts.filter((a) => today(a.blockedAt)).length + Object.values(store.read(CLOUD_INBOX, {})).filter((e) => e.status === "blocked" && today(e.updatedAt)).length,
      escalations_today: acts.filter((a) => a.kind === "antwort" && a.review && today(a.at)).length,
      ai_paused: aiBudget().paused ? 1 : 0,
      mail_degraded: gmailDegraded ? 1 : 0, // TF-037: Mail DEGRADED, Core bleibt ONLINE (Heartbeat läuft weiter; nie das Wort „gmail“ in der Cloud)
    };

    save();
    return { day, limit: cfg.limit, sentToday, used, free: free(), dryRun: dry, contactForms, sendMode: cfg.sendMode, autoSendActive: auto, window: win?.id || null, windows, stats, escalations, cloudResults, ownThreads, plan, sends, optouts, humanContacts,
      gmail: gmailDegraded ? { status: "DEGRADED", ...gmailDegraded } : { status: "OK" },
      suppressedTotal: Object.keys(supp).length, eligibleLeads: eligibleLeads.length, blockedLeads: blockedLeads.length, notes };
  }

  // Gesamtbericht inkl. Website-Discovery (lead-finder.js).
  async function report(r) {
    const { discoveryReport } = await import("./lead-finder.js");
    const d = discoveryReport(dir, now());
    return {
      websitesFoundToday: d.websitesFoundToday, websitesAuditedToday: d.websitesAuditedToday, websitesWithIssuesToday: d.websitesWithIssuesToday,
      qualifiedLeads: d.qualifiedLeads, leadsWithoutContact: d.leadsWithoutContact,
      leadsWithoutLegalBasis: d.leadsWithoutLegalBasis + r.blockedLeads, eligibleLeads: r.eligibleLeads,
      sentToday: r.sentToday + r.sends.length, freeToday: Math.max(0, r.limit - r.sentToday - r.sends.length),
      optOutsTotal: r.suppressedTotal, optOutsThisCycle: r.optouts.length, discoveryErrorsToday: d.errorsToday, lastDiscoveryAt: d.lastRunAt,
    };
  }

  return {
    config,
    aiStatus: () => { const b = aiBudget(); return { paused: b.paused, since: b.since || null, deferred: Object.keys(b.deferred).length }; },
    plan: async () => { const r = await cycle({ dry: true, readOnly: true }); r.report = await report(r); return r; },
    async tick() {
      const state = { ...STATE, ...store.read("state.json", STATE) };
      if (Date.now() < state.backoffUntil) return { skipped: "backoff" };
      const dry = config().dryRun !== false;
      try {
        const r = await cycle({ dry });
        r.report = await report(r);
        const s = store.read("state.json", STATE);
        if (s.failures) store.write("state.json", { ...s, failures: 0, backoffUntil: 0 });
        log("info", "tick", { report: r.report, dryRun: dry, gmail: r.gmail?.status || "OK", sentToday: r.sentToday, used: r.used, free: r.free, threads: r.ownThreads.length, autoSend: r.autoSendActive, sends: r.sends, eligibleLeads: r.eligibleLeads, blockedLeads: r.blockedLeads, plan: r.plan.map(({ task, ...p }) => p), optouts: r.optouts, notes: r.notes });
        return r;
      } catch (e) {
        const s = { ...STATE, ...store.read("state.json", STATE) };
        s.failures = (s.failures || 0) + 1;
        s.backoffUntil = Date.now() + Math.min(60, 5 * 2 ** (s.failures - 1)) * 60_000;
        store.write("state.json", s);
        log("error", "tick_failed", { error: e.message, failures: s.failures, backoffUntil: new Date(s.backoffUntil).toISOString() });
        return { error: e.message };
      }
    },
  };
}

// TF-075A: Leads für die exakte Kontaktformular-Zuordnung (Adresse/Domain) aus der Lead-Datenbank. VN-Kunden werden über ihre Aufträge
// (contactOrders) zugeordnet – die VN-Lead-Daten liegen nicht im Mail-Worker.
export function contactLeads(store) {
  const out = [];
  for (const l of Object.values(loadRegistry(store).leads || {})) {
    if (!l?.lead_id) continue;
    out.push({ lead_id: l.lead_id, domain: l.domain || null, emails: [l.business_email, ...(l.alt_emails || [])].filter(Boolean).map(normEmail), market: l.market === "VN" ? "VN" : "CH",
      language: l.language || null, company: l.company || null });
  }
  return out;
}

// ---------- Texte schreiben lassen (Claude Code ohne Werkzeuge – liefert nur JSON) ----------

export function claudeCompose({ model = "sonnet" } = {}) {
  return (task) => new Promise((resolve, reject) => {
    const args = ["-p", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--model", model, "--output-format", "json", "--system-prompt-file", WRITER_PROMPT];
    const child = spawn("claude", WIN ? args.map((a) => (a === "" ? '""' : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args, { cwd: os.tmpdir(), shell: WIN, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Textgenerator: Zeitlimit")); }, 180_000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const text = JSON.parse(out).result || "";
        const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
        resolve({ decision: "escalate", reason: "", ...json });
      } catch {
        // Unlesbare Ausgabe → nie raten: Entwurf zur Prüfung markieren.
        if (code === 0) resolve({ decision: "escalate", reason: "Antwort des Textgenerators unlesbar", body: "" });
        else reject(new Error(`Textgenerator fehlgeschlagen (${code}): ${err.slice(0, 200)}`));
      }
    });
    child.stdin.end(JSON.stringify(task));
  });
}

// Anthropic-API-Guthaben aufgebraucht (Credit/Billing/Spend-Limit): fail closed. Kein Retry, kein anderer Schlüssel,
// kein anderes Modell oder Anbieter – die KI-Verarbeitung pausiert, bis wieder Guthaben da ist. Jarvis kauft nie Guthaben.
// Die Meldung enthält bewusst keine Wörter aus TRANSIENT_RE (sonst würde der ganze Durchlauf als Netzstörung wiederholt).
export const AI_BUDGET_EXHAUSTED = "AI_BUDGET_EXHAUSTED";
export class AiBudgetError extends Error {
  constructor(detail = "") { super(`${AI_BUDGET_EXHAUSTED}: Anthropic API-Guthaben aufgebraucht${detail ? ` (${detail})` : ""}`); this.code = AI_BUDGET_EXHAUSTED; }
}
export const isAiBudgetError = (e) => e?.code === AI_BUDGET_EXHAUSTED;
const BILLING_RE = /credit balance|insufficient (credit|funds|balance)|billing|payment required|purchase credits|credits? (exhausted|depleted)|out of credits|spend(ing)? limit|usage limits?/i;
// 402 ist immer Billing; 400/403 nur mit eindeutiger Billing-Meldung. 429 (Rate-Limit) und 5xx sind keine Guthabenfrage.
export const isBillingFailure = (status, message = "") => status === 402 || ((status === 400 || status === 403) && BILLING_RE.test(message));

// Dieselbe Schreibanweisung (mail-writer.md) über die Anthropic-API – für den VPS, wo kein Claude Code angemeldet ist.
// Der Schlüssel kommt nur aus der Umgebung (ANTHROPIC_API_KEY) und wird nie geloggt. Genau ein Versuch je Aufruf.
export function apiCompose({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.JARVIS_MAIL_MODEL || "claude-sonnet-5-5", fetchFn = globalThis.fetch, system = null } = {}) {
  return async (task) => {
    if (!apiKey) throw new Error("Textgenerator: ANTHROPIC_API_KEY fehlt");
    const r = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 2000, system: system ?? fs.readFileSync(WRITER_PROMPT, "utf8"), messages: [{ role: "user", content: JSON.stringify(task) }] }),
    });
    if (!r.ok) {
      let message = "";
      try { const j = await r.json(); message = String(j?.error?.message || j?.error?.type || ""); } catch {}
      if (isBillingFailure(r.status, message)) throw new AiBudgetError(`HTTP ${r.status}`);
      throw new Error(`Textgenerator: HTTP ${r.status}`);
    }
    const text = ((await r.json()).content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    // Unlesbare Ausgabe → nie raten: Entwurf zur Prüfung markieren.
    try { return { decision: "escalate", reason: "", ...JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) }; }
    catch { return { decision: "escalate", reason: "Antwort des Textgenerators unlesbar", body: "" }; }
  };
}

// ---------- Kommandozeile ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Rolle dieses Prozesses: "vps" (always-on, send_authority) oder "local" (Windows).
export const workerRole = (env = process.env) => (env.JARVIS_WORKER_ROLE === "vps" ? "vps" : "local");
export const AUTHORITY_FILE = "authority.json";
// send_authority für den lokalen Worker entscheiden. Einmal gesehene VPS-Authority bleibt gespeichert (auch über Neustarts
// und Cloud-Ausfälle) und wird nur aufgehoben, wenn die Cloud ausdrücklich meldet, dass kein VPS-Worker eingerichtet ist.
// Der VPS-Worker startet ohne Bestätigung im Standby (defaultSelf=false) – erst wenn die Cloud seinen Token als
// send_authority anerkennt, liest und sendet er. So laufen vor der Umstellung nie zwei Worker auf denselben Threads.
export function resolveAuthority(store, remote, now = new Date(), defaultSelf = true) {
  const saved = store.read(AUTHORITY_FILE, null);
  if (remote && typeof remote.dedicated === "boolean") {
    const next = { holder: remote.dedicated ? "vps" : "local", self: !!remote.self, checkedAt: now.toISOString() };
    if (saved?.holder !== next.holder || saved?.self !== next.self) store.write(AUTHORITY_FILE, next);
    return next;
  }
  return saved || { holder: defaultSelf ? "local" : "unknown", self: defaultSelf, checkedAt: null };
}

// Nur Zahlen und Zeitpunkte – keine Adressen, IDs oder Inhalte.
export function businessSnapshot(r, d = {}, t = new Date().toISOString()) {
  return {
    updatedAt: t,
    worker: { online: true, lastCycle: t, todaySent: r.report.sentToday, limit: r.limit, capacity: r.report.freeToday, autoSend: !!r.autoSendActive, eligibleLeads: r.eligibleLeads, optOuts: r.suppressedTotal,
      // Feldname „count“ statt „sent“: „sent“ ist im Shared State als Gmail-Register-Feld gesperrt.
      windows: Object.fromEntries(Object.entries(r.windows || {}).map(([id, w]) => [id, { count: w.sent, limit: w.limit, executed: !!w.executed }])) },
    discovery: { lastRunAt: d.lastRunAt || null, websitesFoundToday: d.websitesFoundToday || 0, websitesWithIssuesToday: d.websitesWithIssuesToday || 0,
      qualifiedLeads: d.qualifiedLeads || 0, leadsWithoutLegalBasis: d.leadsWithoutLegalBasis || 0, errorsToday: d.errorsToday || 0 },
  };
}
// Langfristige, von Chris gewollte Notizen (workspace/memory/chris.md) für den Cloud-Jarvis.
function profileNotes() {
  const file = path.join(ROOT, "workspace", "memory", "chris.md");
  try { return { notes: fs.readFileSync(file, "utf8").slice(0, 2000), updatedAt: fs.statSync(file).mtime.toISOString() }; }
  catch { return { notes: "", updatedAt: null }; }
}
// Neue Cloud-Aufträge in die lokale Ablage übernehmen – bekannte request_ids nie überschreiben (Idempotenz).
export function inboxAdd(store, requests = [], now = new Date()) {
  const inbox = store.read(CLOUD_INBOX, {});
  let added = 0;
  for (const rq of requests) if (rq?.request_id && !inbox[rq.request_id]) { inbox[rq.request_id] = { request: rq, status: "pending", reason: null, synced: true, receivedAt: now.toISOString() }; added++; }
  // Begrenzen: gemeldete, abgeschlossene Einträge älter als 14 Tage entfallen.
  const horizon = +now - 14 * DAY_MS;
  for (const [id, e] of Object.entries(inbox)) if (e.synced && !["pending", "accepted_local"].includes(e.status) && Date.parse(e.updatedAt || e.receivedAt || 0) < horizon) { delete inbox[id]; added++; }
  if (added) store.write(CLOUD_INBOX, inbox);
  return added;
}
// Noch nicht gemeldete Ergebnisse an die Cloud melden.
export async function pushInbox(store, push) {
  const inbox = store.read(CLOUD_INBOX, {});
  const done = [];
  for (const [id, e] of Object.entries(inbox)) {
    if (e.synced || e.status === "pending") continue;
    if ((await push({ request_id: id, status: e.status, reason: e.reason })).ok) done.push([id, e.status]);
  }
  if (!done.length) return 0;
  const cur = store.read(CLOUD_INBOX, {});
  for (const [id, status] of done) if (cur[id]?.status === status) cur[id].synced = true;
  store.write(CLOUD_INBOX, cur);
  return done.length;
}
const BUSY = 3; // Exit-Code „Lock belegt“ – z. B. während eines manuellen --once

// Ein Durchlauf der Worker-Schleife (ohne Discovery/Shared State): Cloud-Aufträge mit Lease übernehmen, send_authority
// prüfen, Gmail-Durchlauf, Ergebnisse zurückmelden, Heartbeat. Wirft nie wegen der Cloud.
export async function workerIteration({ role, store, worker, config, mailRequests, fetchFn = globalThis.fetch, startedAt = null, log = () => {}, core = null }) {
  let claim = { ok: false, requests: [] };
  try { claim = await mailRequests.claimMailRequests({ config, fetchFn }); inboxAdd(store, claim.requests); }
  catch (e) { log("error", "cloud_requests_pull_failed", { error: e.message }); }
  // Genau ein Sender. Windows nach der Migration: Standby – sendet nichts, liest kein Gmail, alles macht der VPS.
  // VPS, dessen Token die Cloud nicht kennt (401): ebenfalls Standby, bis JARVIS_MAIL_WORKER_TOKEN in Netlify gesetzt ist.
  const remote = claim.ok ? claim.authority : role === "vps" && claim.status === 401 ? { dedicated: false, self: false } : null;
  const authority = resolveAuthority(store, remote, new Date(), role !== "vps");
  if (!authority.self) return { standby: true, authority };
  const result = await worker.tick();
  try { await pushInbox(store, (x) => mailRequests.pushMailResult({ config, fetchFn, ...x })); }
  catch (e) { log("error", "cloud_requests_push_failed", { error: e.message }); }
  // Heartbeat an die Cloud: MAIL SERVICE ONLINE und Tageszahlen (nur Zahlen, keine Adressen oder IDs).
  const hb = result?.stats ? await mailRequests.sendHeartbeat({ config, fetchFn, stats: result.stats, started_at: startedAt, core: typeof core === "function" ? core() : core }) : { ok: false };
  return { standby: false, authority, result, heartbeat: hb.ok };
}

// Abfrageintervall: VPS standardmässig 2 Minuten (JARVIS_POLL_MINUTES), nie unter 1 Minute – keine aggressive API-Schleife.
// Public Key für die Backups (im Image neben mail-worker.js, im Repo unter deploy/vps/). Kein Key → kein Backup.
export function backupPublicKey() {
  for (const p of [path.join(ROOT, "backup-public.pem"), path.join(ROOT, "deploy", "vps", "backup-public.pem")]) { try { return fs.readFileSync(p, "utf8"); } catch {} }
  return null;
}
export const pollMs = (cfg, env = process.env) => Math.max(1, Number(env.JARVIS_POLL_MINUTES) || Number(cfg.pollMinutes) || 5) * 60_000;

async function loop() {
  const gmail = await import("./gmail.js");
  const log = createLogger(WORKER_DIR);
  if (!acquireLock(WORKER_DIR)) { log("info", "already_running"); console.log("Mail-Worker läuft bereits."); return BUSY; }
  // Operational State auf die Schema-Version dieses Codes bringen; neuerer Stand → Abbruch (fail closed, nichts wird gesendet).
  const cloudCore = await import("./cloud-core.js");
  const backup = await import("./backup.js");
  try { const m = cloudCore.migrateStateDir(WORKER_DIR); if (m.applied.length) log("info", "state_migrated", m); }
  catch (e) { log("error", "state_schema_refused", { error: e.message }); releaseLock(WORKER_DIR); throw e; }
  // Lead-Datenbank: beim Start ALLE Quellen zusammenführen (= Migration; idempotent, additiv, löscht nie). Fehler stoppen den Worker nie.
  try { log("info", "lead_registry_migrated", reconcileRegistry(createStore(WORKER_DIR), { gmailRegistry: gmail.listOwned(), full: true })); }
  catch (e) { log("error", "lead_registry_migration_failed", { error: e.message }); }
  const release = () => releaseLock(WORKER_DIR);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
  const role = workerRole();
  // Gemeinsamer Zustand (lokaler Spiegel + Cloud-Abgleich), Sofort-Alarm bei Telefonwunsch und Eskalationsmeldungen.
  const shared = await import("./local-state.js");
  const mailRequests = await import("./mail-requests.js");
  const local = shared.createLocalState();
  const notify = shared.createHumanContactNotifier({ local, log });
  const escalate = shared.createEscalationNotifier({ local, log });
  const aiPaused = shared.createAiBudgetNotifier({ local, log });
  // Ohne Cloud-Zugang (kein Token) gibt es keinen zweiten Sender – dann genügt das lokale Lock.
  const sendGuard = shared.syncConfig().token || shared.syncConfig().workerToken ? mailRequests.cloudSendGuard({ config: shared.syncConfig() }) : undefined;
  // VPS: Anthropic-API (kein Claude Code angemeldet); Windows: wie bisher Claude Code.
  const compose = role === "vps" || process.env.JARVIS_COMPOSE === "api" ? apiCompose() : (task) => claudeCompose({ model: worker.config().model })(task);
  // TF-066: Kunden-Onboarding-Dialog (nur mit Repair-Outbox, d. h. auf dem VPS neben dem Repair-Service; Notschalter JARVIS_ONBOARDING=off).
  const onbMod = await import("./onboarding-dialogue.js");
  const onbDir = repairOutboxDir() && process.env.JARVIS_ONBOARDING !== "off" ? (await import("./onboarding-store.js")).onboardingDirOf(repairOutboxDir()) : null;
  // TF-079: Kontaktformular-Kundenweg (contact-form-journey.js) – erste Auftrags-Mail im Thread der automatischen Antwort, eigene Threads nie doppelt beantwortet.
  const journeyMod = await import("./contact-form-journey.js");
  const e2eMod = await import("./e2e-test.js"); // TF-080
  const onboarding = onbDir ? onbMod.createOnboarding({ dir: WORKER_DIR, onboardingDir: onbDir, gmail, extract: role === "vps" || process.env.JARVIS_COMPOSE === "api" ? onbMod.apiExtract() : null,
    log, notify: shared.createOnboardingNotifier({ local, log }), contactThreadFor: (id, email) => journeyMod.contactThreadFor(createStore(WORKER_DIR), id, email) }) : null;
  // TF-081: Zahlungsanfrage/Erinnerungen für bestätigte, unbezahlte CH-Aufträge (Standard AUS: config.json paymentFollowup.enabled).
  const payFollowMod = await import("./payment-followup.js");
  const paymentFollowup = onbDir ? payFollowMod.createPaymentFollowup({ dir: WORKER_DIR, onboardingDir: onbDir, gmail, log, sendGuard,
    sender: () => worker.config().sender, settings: () => worker.config().paymentFollowup || {},
    notify: shared.createOnboardingNotifier({ local, log }) }) : null;
  const onboardingThreads = onboarding ? () => new Map([...journeyMod.journeyThreads(createStore(WORKER_DIR)), ...(paymentFollowup ? paymentFollowup.boundThreads() : []), ...onboarding.boundThreads()]) : null;
  const contactJourney = onboarding ? (x) => journeyMod.processContactJourneys({ ...x, onboardingDir: onbDir, boundOrders: () => new Set(onboarding.boundThreads().values()), e2e: e2eMod.e2eConfig() }) : null;
  // TF-075A: Aufträge für die exakte Zuordnung von Kontaktformular-Anfragen (Export des Repair-Service, nur lesen).
  const contactOrders = () => (onbDir ? readOrdersExport(onbDir).orders || {} : {});
  let worker = createWorker({ gmail, compose, log, notify, escalate, aiPaused, sendGuard, onboardingThreads, contactOrders, contactJourney });
  const startedAt = new Date().toISOString();
  // Server Control (nur VPS): Pause zwischen Durchläufen ist weckbar; Neustart des Cores = sauberes Ende nach dem Durchlauf,
  // Docker (restart: unless-stopped) startet den Container-Prozess neu. Nie mitten in einem Gmail-Durchlauf.
  let wake = () => {}, restartRequested = false, lastIt = null, standbyLogged = false, discoveryRunning = null, repairRunning = null, check150Running = null, gmailAuth = null;
  const nap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  const core = () => cloudCore.coreStatus({ dir: WORKER_DIR, role, startedAt, windows: SEND_WINDOWS, zurichDay, backup: backup.backupInfo(WORKER_DIR) });
  const salesMod = await import("./sales.js");
  const finderMod = await import("./lead-finder.js");
  const repairMod = await import("./repair-workflow.js");
  const check150Mod = await import("./check-150-workflow.js");
  const paymentsMod = await import("./payments.js");
  const accessMod = await import("./access-intake.js");
  const outboxMod = await import("./repair-outbox.js");
  // TF-047: Aufträge laufen im separaten Repair-Service; hier nur noch lesen (Dashboard) und die Outbox zustellen.
  const repairDir = repairStateDir() || WORKER_DIR, repairExternal = !!repairStateDir(), outboxDir = repairOutboxDir();
  if (role === "vps") (await import("./server-agent.js")).startServerControl({
    dir: WORKER_DIR, secretsDir: SECRETS, startedAt, log, core, zurichDay, backupPublicKey, healthy: () => healthy(WORKER_DIR),
    syncConfig: shared.syncConfig, pollMs: () => pollMs(worker.config()), lastIteration: () => lastIt,
    queue: () => { const inbox = createStore(WORKER_DIR).read(CLOUD_INBOX, {}); const st = Object.values(inbox).map((e) => e.status); return { pending: st.filter((x) => x === "pending").length, processing: st.filter((x) => x === "accepted_local").length }; },
    restartCore: () => { restartRequested = true; wake(); },
    restartMailWorker: () => { worker = createWorker({ gmail, compose, log, notify, escalate, aiPaused, sendGuard, onboardingThreads, contactOrders, contactJourney }); standbyLogged = false; wake(); },
    restartScheduler: () => wake(),
    // Cloud/Handy: Lead-Liste (Allowlist) und Cold-Entwurf je genau einem Lead – nur Entwurf, nie Versand.
    leads: () => publicLeads(salesMod.loadPipeline({ dir: WORKER_DIR, registry: gmail.listOwned() }).leads),
    coldDraft: (op, leadId) => coldDraftFromCloud({ op, leadId, gmail, dir: WORKER_DIR, wake: () => wake() }),
    // 24/7-Discovery: Status fürs Dashboard und Pause/Fortsetzen (nur ein Flag in discovered.json, nichts wird gelöscht).
    discovery: () => ({ ...finderMod.discoveryStatus(WORKER_DIR), lead_db: registryStatus(createStore(WORKER_DIR)) }),
    // Lead-Datenbank (Allowlist, lead-db.js) für Cloud/Handy: Suche, Filter, Detail, CSV-/JSON-Export – nie Gmail-IDs oder Roh-Evidence.
    leadDb: () => publicRegistry(createStore(WORKER_DIR)),
    // Reparaturaufträge (TF-036): Allowlist-Sicht (Zähler + ungefährliche Felder) fürs Dashboard – keine Aktionen aus der Cloud.
    // TF-066: je Auftrag zusätzlich die Onboarding-Sicht (Allowlist: Status, Zugang als Wort, bestätigte Website-Angaben – nie Secrets).
    repair: () => onbMod.attachOnboarding(repairMod.publicRepairOrders(repairDir), onboarding ? onboarding.publicByOrder() : {}),
    // Check & Anleitung CHF 150 (TF-038): Allowlist-Sicht fürs Dashboard – reine Anzeige, keine Aktionen aus der Cloud.
    check150: () => onbMod.attachOnboarding(check150Mod.publicCheck150Orders(repairDir), onboarding ? onboarding.publicByOrder() : {}),
    // Payment Worker (TF-041): Ledger-Zähler + offene Zahlungsschwellen beider Workflows – nie Referenzen/payment_ids.
    payments: () => {
      const c = check150Mod.check150Status(repairDir), r = repairMod.repairOrdersStatus(repairDir);
      return { status: "ACTIVE", ...paymentsMod.paymentsStatus(repairDir), waiting_deposit: (c.waiting_payment || 0) + (r.waiting_payment || 0), payment_review: r.payment_review || 0 };
    },
    setDiscovery: (op) => { const r = finderMod.setDiscoveryPaused(WORKER_DIR, op === "pause"); wake(); return { ok: true, ...r, status: r.paused ? "PAUSED" : "ACTIVE" }; },
  });
  log("info", "worker_started", { pid: process.pid, role, dryRun: worker.config().dryRun !== false });
  // Herzschlag auch während langer Durchläufe, damit kein zweiter Worker das Lock für verwaist hält.
  setInterval(() => heartbeat(WORKER_DIR), 60_000);
  const finder = await import("./lead-finder.js");
  await shared.syncWithCloud({ local, log, force: true }); // beim Start: neuesten Cloud-Stand übernehmen
  for (;;) {
    if (restartRequested) { log("info", "core_restart_requested", { source: "server_control" }); return 0; }
    heartbeat(WORKER_DIR);
    const it = await workerIteration({ role, store: createStore(WORKER_DIR), worker, config: shared.syncConfig(), mailRequests, startedAt, log, core });
    lastIt = { at: new Date().toISOString(), standby: !!it.standby, holder: it.authority?.holder || null, self: it.authority?.self === true };
    if (it.standby) {
      if (!standbyLogged) { log("info", "standby_no_send_authority", { holder: it.authority.holder }); standbyLogged = true; }
      try { await shared.syncWithCloud({ local, log }); } catch (e) { log("error", "shared_state_failed", { error: e.message }); }
      await nap(pollMs(worker.config()));
      continue;
    }
    standbyLogged = false;
    const r = it.result;
    // Lead-Datenbank nachführen: Entwürfe, manuell versendete Cold-Entwürfe, Antworten, Kunden, Suppression/Opt-out (nur bei geänderten Quellen).
    try { const lr = reconcileRegistry(createStore(WORKER_DIR), { gmailRegistry: gmail.listOwned() }); if (!lr.skipped && (lr.created || lr.updated)) log("info", "lead_registry_updated", lr); }
    catch (e) { log("error", "lead_registry_failed", { error: e.message }); }
    // Danach (Antworten haben Vorrang): neue Websites suchen und prüfen, wenn fällig. Sendet nie.
    // Entkoppelt: DISCOVERY QUEUE (Websites prüfen, bis 7500/Tag) läuft im Hintergrund und blockiert weder den Mail-Takt noch den
    // DRAFT-Worker (Gmail-Entwürfe aus individual_reviews.json, siehe 3b). Nie zwei Discovery-Läufe gleichzeitig (eigenes Lock + Promise).
    if (!discoveryRunning) {
      discoveryRunning = finder.runDiscovery({ gmail, log })
        .then((d) => { if (d.busy) log("info", "discovery_busy"); }, (e) => log("error", "discovery_failed", { error: e.message }))
        .finally(() => { discoveryRunning = null; });
    }
    // CHF-480-Reparaturaufträge (TF-035, repair-workflow.js): persistente Orders im Hintergrund weiterarbeiten – eigenes Lock,
    // nie zwei Läufe, blockiert weder Mail-Takt noch Discovery. Ohne offene Aufträge ist der Aufruf ein No-op.
    // Ohne konfigurierte Stack-Adapter bleibt es beim passiven Audit bzw. BLOCKED_NO_ACCESS – es wird nie etwas verändert.
    // gmail + intake nur für die automatische Zugangs-Anfrage NACH erfüllter CHF-240-Zahlungsschwelle (TF-041, payments.js):
    // genau eine CUSTOMER_ACCESS_REQUEST-Mail mit sicherem One-Time-Link (access-intake.js); intake nur mit Worker-Token (VPS).
    if (!repairRunning && !repairExternal) {
      repairRunning = repairMod.runRepairOrders({ gmail, intake: accessMod.intakeClient({ config: shared.syncConfig() }), log })
        .then((r) => { if (r && !r.busy && r.advanced) log("info", "repair_orders_processed", r); }, (e) => log("error", "repair_orders_failed", { error: e.message }))
        .finally(() => { repairRunning = null; });
    }
    // Check & Anleitung CHF 150 (TF-038 + TF-041, check-150-workflow.js): bezahlte Aufträge im Hintergrund erfüllen –
    // rein passiver Audit + Bericht + Gmail-Lieferentwurf; die Service-Mail geht erst NACH erfüllter CHF-75-Zahlungsschwelle
    // (payments.js) automatisch an den bestätigten Kunden raus (nie Website-Änderung). Eigenes Lock, No-op ohne offene
    // Aufträge, blockiert weder Mail-Takt noch Discovery noch den CHF-480-Workflow. Fehler stoppen den Worker nie.
    if (!check150Running && !repairExternal) {
      check150Running = check150Mod.runCheck150Orders({ gmail, log })
        .then((r) => { if (r && !r.busy && r.advanced) log("info", "check150_orders_processed", r); }, (e) => log("error", "check150_orders_failed", { error: e.message }))
        .finally(() => { check150Running = null; });
    }
    // TF-047: Service-Mails des Repair-Service zustellen (nur hier, nur mit send_authority, genau einmal). Fehler stoppen den Worker nie.
    // TF-049: Gmail OAuth höchstens alle 5 Minuten read-only prüfen (Refresh im Speicher + users.getProfile); Status geht in den
    // Outbox-Herzschlag (Readiness des Repair-Service), bei FAIL bleiben Outbox-Aufträge offen statt endgültig zu scheitern.
    if (outboxDir && Date.now() - (gmailAuth?.at || 0) >= GMAIL_AUTH_CHECK_MS) {
      const prev = gmailAuth;
      gmailAuth = { ...(await gmail.checkAuth().catch(() => ({ ok: false, category: "unknown_auth_error" }))), at: Date.now() };
      if (!gmailAuth.ok && (prev?.ok !== false || prev.category !== gmailAuth.category)) log("error", "gmail_auth_failed", { category: gmailAuth.category });
      else if (gmailAuth.ok && prev?.ok === false) log("info", "gmail_auth_recovered");
    }
    if (outboxDir) {
      try { const ob = await outboxMod.processRepairOutbox({ dir: outboxDir, gmail, gmailAuth, log, onboarding }); if (ob.processed) log("info", "repair_outbox_processed", ob); }
      catch (e) { log("error", "repair_outbox_failed", { error: e.message }); }
    }
    // TF-066: Onboarding-Dialog (gebundene Auftrags-Threads, Reminder, Brief-Export) – nur mit funktionierendem Gmail-OAuth.
    if (onboarding && gmailAuth?.ok !== false) {
      try { const ob = await onboarding.process(); if (ob.processed) log("info", "onboarding_processed", ob); }
      catch (e) { log("error", "onboarding_failed", { error: String(e.message).slice(0, 160) }); }
    }
    if (paymentFollowup && gmailAuth?.ok !== false) {
      try { const pf = await paymentFollowup.process(); if (pf.processed || pf.activated) log("info", "payment_followup_processed", pf); }
      catch (e) { log("error", "payment_followup_failed", { error: String(e.message).slice(0, 160) }); }
    }
    // Bereinigten Status in den gemeinsamen Zustand schreiben und abgleichen – Fehler stoppen den Worker nie.
    try {
      // Vertriebskennzahlen (nur Zähler/CHF-Summen der zwei Angebote) lokal festhalten und mitsynchronisieren.
      try { local.setSales((await import("./sales.js")).persistMetrics({ registry: gmail.listOwned() })); } catch (e) { log("error", "metrics_failed", { error: e.message }); }
      if (r?.report) local.setBusiness(businessSnapshot(r, finder.discoveryReport()), { personaVersion: (await import("./persona-version.js")).personaVersion(), ...(role === "vps" ? {} : { profile: profileNotes() }) });
      await shared.syncWithCloud({ local, log });
    } catch (e) { log("error", "shared_state_failed", { error: e.message }); }
    // Cloud Core (VPS): tägliches verschlüsseltes State-Backup (lokal rotierend + offsite). Fehler stoppen den Worker nie.
    if (role === "vps") {
      try {
        const pem = backupPublicKey();
        if (pem) await backup.dailyBackup({ secretsDir: SECRETS, workerDir: WORKER_DIR, publicKeyPem: pem, zurichDay, log,
          upload: (await import("./backup-api.js")).backupUploader({ config: shared.syncConfig() }) });
      } catch (e) { log("error", "state_backup_failed", { error: e.message }); }
    }
    await nap(pollMs(worker.config()));
  }
}

// Cold-Lead-Entwurf auf Anweisung aus der Cloud (Server Control, genau EIN Lead): legt nur den lokalen Entwurf an (queued, COLD_LEAD_DRAFT_ONLY,
// legal_basis NONE) bzw. verwirft ihn – der Gmail-Entwurf entsteht im nächsten Worker-Durchlauf wie bei der Discovery. Es gibt hier keinen
// Sendepfad: kein state.actions-Eintrag, keine Send-Queue; gmail.sendDraft verweigert COLD_LEAD_DRAFT_ONLY ohnehin. Suppression/Opt-out blockieren.
export async function coldDraftFromCloud({ op, leadId, gmail, dir = WORKER_DIR, wake = () => {}, now = new Date() }) {
  const store = createStore(dir);
  const id = String(leadId || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{2,252}$/.test(id)) return { ok: false, error: "lead_id ungültig." };
  const summary = (r) => ({ lead_id: r.lead_id, status: r.status, draft_mode: r.draft_mode, legal_basis: r.legal_basis, message_class: r.message_class,
    automatic_send_allowed: r.automatic_send_allowed === true, manual_send_decision_required: r.manual_send_decision_required === true });
  if (op === "discard") {
    try { return { ok: true, review: summary(coldDraftAction(store, "discard", { lead_id: id }, now)) }; } catch (e) { return { ok: false, error: e.message }; }
  }
  if (op !== "create") return { ok: false, error: "Unbekannte Aktion." };
  const { findRawLead } = await import("./sales.js");
  const lead = findRawLead(dir, id);
  if (!lead) return { ok: false, error: "Lead unbekannt." };
  const supp = store.read("suppression.json", {});
  const to = normEmail(lead.email || "");
  if (!to) return { ok: false, error: "Keine geschäftliche Adresse." };
  if (supp[to]) return { ok: false, error: /opt-?out/i.test(supp[to]?.reason || "") ? "Empfänger hat sich abgemeldet (Opt-out)." : "Empfänger ist gesperrt (Suppression)." };
  const domainSuppressed = Object.keys(supp).some((a) => a.split("@")[1] === lead.domain && !FREEMAIL_RE.test(a));
  if (domainSuppressed) return { ok: false, error: "Firma ist gesperrt (Suppression auf der Domain)." };
  const sender = store.read("config.json", {}).sender;
  if (!sender?.name) return { ok: false, error: "Absender nicht konfiguriert." };
  const reg = gmail?.listOwned ? gmail.listOwned() : { sent: {}, drafts: {} };
  const contacted = new Set([...Object.values(reg.sent || {}), ...Object.values(reg.drafts || {})].map((s) => normEmail(s.to || "")).filter(Boolean));
  // Lead-Datenbank: bereits angeschriebene, beantwortete, gesperrte Firmen und Kunden bekommen nie einen neuen Cold-Entwurf.
  const dbWhy = registryBlock(store, { domain: lead.domain, email: to, company: lead.company });
  if (dbWhy) return { ok: false, error: "Blockiert (Lead-Datenbank): " + dbWhy };
  try {
    const r = ensureColdDraft(store, lead, { sender, now, contacted, suppression: supp });
    if (r.blocked) return { ok: false, error: "Blockiert: " + r.blocked, review: r.existing ? summary(r.existing) : null };
    wake();
    return { ok: true, review: summary(r), note: "Lokaler Entwurf angelegt – der Gmail-Entwurf entsteht im nächsten Durchlauf. Jarvis sendet ihn nie." };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Docker-Healthcheck: gesund, solange der Worker-Prozess sein Lock in den letzten 5 Minuten erneuert hat.
export function healthy(dir = WORKER_DIR, now = Date.now(), maxAgeMs = 5 * 60_000) {
  try { const l = JSON.parse(fs.readFileSync(path.join(dir, "worker.lock"), "utf8")); return now - (l.beat || 0) < maxAgeMs; } catch { return false; }
}

// Startet den Worker als Kindprozess neu, wenn er abstürzt (der Task Scheduler sieht hinter conhost keinen Exit-Code).
async function supervise() {
  const log = createLogger(WORKER_DIR);
  for (let delay = 10_000; ; delay = Math.min(delay * 2, 300_000)) {
    const started = Date.now();
    const code = await new Promise((r) => spawn(process.execPath, [fileURLToPath(import.meta.url)], { stdio: "ignore", cwd: ROOT }).on("exit", r));
    if (code === 0) return 0; // regulär beendet
    // Lock belegt (manueller Lauf oder zweiter Worker): nicht aufgeben, sondern nach einer Prüfperiode erneut versuchen.
    if (code === BUSY) { await sleep(5 * 60_000); delay = 5_000; continue; }
    if (Date.now() - started > 600_000) delay = 10_000;
    log("error", "worker_crashed", { code, restartInMs: delay });
    await sleep(delay);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  process.on("uncaughtException", (e) => { createLogger(WORKER_DIR)("error", "crash", { error: e.stack || e.message }); process.exit(1); });
  process.on("unhandledRejection", (e) => { createLogger(WORKER_DIR)("error", "crash", { error: String(e?.stack || e) }); process.exit(1); });
  // Dry-Run: immer nur lesen, unabhängig von dryRun/sendMode in config.json.
  const dryRun = async () => {
    const r = await createWorker({ gmail: await import("./gmail.js"), compose: null }).plan();
    console.log(JSON.stringify({ ...r, plan: r.plan.map(({ task, ...p }) => p) }, null, 2));
    return 0;
  };
  const run = {
    "--supervise": supervise,
    "--healthcheck": async () => (healthy() ? 0 : 1),
    "--plan": dryRun,
    "--dry-run": dryRun,
    "--once": async () => {
      const gmail = await import("./gmail.js");
      if (!acquireLock(WORKER_DIR)) { console.log("Mail-Worker läuft bereits."); return 0; }
      const hb = setInterval(() => heartbeat(WORKER_DIR), 60_000);
      try {
        const w = createWorker({ gmail, compose: (task) => claudeCompose({ model: w.config().model })(task) });
        const r = await w.tick();
        console.log(JSON.stringify(r.plan ? { ...r, plan: r.plan.map(({ task, ...p }) => p) } : r, null, 2));
      } finally { clearInterval(hb); releaseLock(WORKER_DIR); }
      return 0;
    },
  }[arg] || loop;
  run().then((code) => process.exit(code ?? 0));
}
