// Jarvis Mail-Worker – läuft unabhängig von server.js im Hintergrund.
// sendMode "drafts": bereitet nur Entwürfe vor. sendMode "compliant_auto": sendet zusätzlich selbst, aber ausschließlich
// an Leads mit dokumentierter Versandgrundlage (opt_in oder Bestandskunde mit ähnlicher Leistung) und in deren Threads.
// Heikle Fälle bleiben immer Entwürfe für Sir.
//
// Alle 5 Minuten: neue Antworten in registrierten Jarvis-Threads, Opt-outs, fällige Follow-ups und
// freigegebene Leads prüfen. Zustand, Leads und Suppression-Liste liegen in .secrets/mail_worker/.
//
//   node mail-worker.js              Worker-Schleife (Lock gegen Doppelstart)
//   node mail-worker.js --supervise  wie oben, startet den Worker nach einem Absturz neu (für den Autostart)
//   node mail-worker.js --once       genau eine Prüfung
//   node mail-worker.js --plan       Dry-Run: zeigt, was heute vorbereitet/gesendet würde – ändert nichts (Alias --dry-run)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
export const WORKER_DIR = path.join(SECRETS, "mail_worker");
const WRITER_PROMPT = path.join(ROOT, "mail-writer.md");
const WIN = process.platform === "win32";

export const HARD_LIMIT = 50;
const DAY_MS = 86_400_000;
export const DEFAULT_CONFIG = {
  dryRun: true, // Standard: nur anzeigen, was vorbereitet würde
  sendMode: "drafts", // "drafts" = nur Entwürfe, "compliant_auto" = versandberechtigte Mails selbst senden
  dailyLimit: HARD_LIMIT, // wird nie über HARD_LIMIT hinaus beachtet
  replyReserve: 5, // so viele Plätze bleiben täglich für Antworten in laufenden Gesprächen frei
  pollMinutes: 5,
  window: ["08:30", "18:30"], // Follow-ups und Erstkontakte nur in diesem Zeitfenster (Europe/Zurich)
  maxPacedPerTick: 2, // keine Bursts: höchstens so viele Follow-ups/Erstkontakte pro Durchlauf
  followUpDays: [3, 5],
  activeDays: 60, // ältere Threads werden nicht mehr abgefragt
  excludeAddresses: [], // z. B. Sirs eigene Adressen: dafür nie Entwürfe vorbereiten
  sender: { name: "", company: "", email: "", signature: "" }, // echte Identität von Sir – ohne name kein Erstkontakt/Versand
  offer: "", // Sirs Angebot in eigenen Worten – ohne Angebot keine Erstkontakte
  model: "sonnet",
};

// ---------- Hilfen ----------

const zurich = (d, opts) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich", ...opts }).format(d);
export const zurichDay = (d) => zurich(d, { year: "numeric", month: "2-digit", day: "2-digit" });
const zurichMinutes = (d) => { const [h, m] = zurich(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":"); return +h * 60 + +m; };
const hm = (s) => { const [h, m] = s.split(":"); return +h * 60 + +m; };

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
export const OPT_OUT_RE = /\b(unsubscribe|abmelden|austragen|stopp?\b|keine (weiteren |weitere )?(e-?mails?|mails|nachrichten|kontaktaufnahme)|nicht (mehr )?(kontaktieren|anschreiben)|kein interesse|not interested|remove me|do not (contact|email)|don'?t (contact|email)|désinscri|ne plus me contacter|non contattarmi|disiscriv)/i;
export const ESCALATE_RE = /(vertrag|vertr[aä]ge|contract|agb|haftung|anwalt|lawyer|rechtlich|legal|klage|gericht|rechnung|invoice|zahlung|payment|[uü]berweis|iban|kreditkarte|credit card|rabatt|discount|preisnachlass|skonto|passwort|password|zugangsdaten|credentials|login|beschwerde|complaint|betrug|fraud)/i;
const AUTO_SUBJECT_RE = /(automatische antwort|abwesenheit|out of office|automatic reply|auto-?reply|réponse automatique|risposta automatica)/i;
const BOUNCE_RE = /mailer-daemon|postmaster/i;
const AI_RE = /\b(KI|AI|Claude|Jarvis|ChatGPT|künstliche Intelligenz|language model|Sprachmodell)\b/;
const UNSUB_RE = /abmelden|unsubscribe|désinscri|disiscriv/i;

// Versandgrundlage eines Leads. approved allein genügt nie; nichts wird angenommen oder ergänzt.
export function legalBasis(lead = {}, now = new Date()) {
  if (lead.approved !== true) return null;
  if (lead.consentBasis === "opt_in") {
    const at = Date.parse(lead.consentAt);
    const source = typeof lead.consentSource === "string" && lead.consentSource.trim();
    return Number.isFinite(at) && at <= +now && source ? "opt_in" : null;
  }
  if (lead.consentBasis === "existing_customer") return lead.existingCustomer === true && lead.similarService === true ? "existing_customer" : null;
  return null;
}

// Jede werbliche Mail endet mit klarer Absenderidentität und einer kostenlosen Abmeldemöglichkeit per Antwort.
export const UNSUB_LINE = {
  de: "Falls Sie keine weiteren Nachrichten von mir wünschen, antworten Sie einfach mit «Abmelden».",
  en: "If you'd prefer not to hear from me again, simply reply with \"unsubscribe\".",
  fr: "Si vous ne souhaitez plus recevoir de messages de ma part, répondez simplement « désinscrire ».",
  it: "Se non desidera ricevere altri messaggi da parte mia, risponda semplicemente «disiscrivi».",
};
export function finalizeCommercial(body, sender = {}, lang = "de") {
  let out = String(body || "").trim();
  const signature = sender.signature?.trim() || [sender.name, sender.company, sender.email].filter(Boolean).join("\n");
  if (sender.name && !out.includes(sender.name)) out += "\n\n" + signature;
  if (!UNSUB_RE.test(out)) out += "\n\n" + (UNSUB_LINE[String(lang || "de").slice(0, 2).toLowerCase()] || UNSUB_LINE.de);
  return out;
}
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network/i;

// Atomare JSON-Ablage: Temp-Datei + Umbenennen, ein Absturz hinterlässt nie halbe Dateien.
export function createStore(dir) {
  return {
    dir,
    read(name, fallback) { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return structuredClone(fallback); } },
    write(name, data) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name), tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
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

// ---------- Lock gegen Doppelstart ----------

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
export function acquireLock(dir, { pid = process.pid, now = Date.now(), staleMs = 15 * 60_000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "worker.lock");
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
export const heartbeat = (dir, pid = process.pid) => fs.writeFileSync(path.join(dir, "worker.lock"), JSON.stringify({ pid, beat: Date.now() }));
export function releaseLock(dir, pid = process.pid) {
  const file = path.join(dir, "worker.lock");
  try { if (JSON.parse(fs.readFileSync(file, "utf8")).pid === pid) fs.rmSync(file); } catch {}
}

// ---------- Worker ----------

const STATE = { actions: {}, handled: {}, threadDrafts: {}, prepared: {}, compliantThreads: {}, lastPacedAt: 0, lastSendAt: 0, failures: 0, backoffUntil: 0 };

export function createWorker({ dir = WORKER_DIR, gmail, compose, now = () => new Date(), log = createLogger(dir) }) {
  const store = createStore(dir);
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
    const state = { ...structuredClone(STATE), ...store.read("state.json", STATE) };
    const supp = store.read("suppression.json", {});
    const exclude = new Set(cfg.excludeAddresses.map(normEmail));
    const reg = gmail.listOwned();
    const plan = [], notes = [], optouts = [], ownThreads = [], sends = [], blockedLeads = [], eligibleLeads = [];
    // Echtversand nur im ausdrücklich gesetzten Modus, nie im Dry-Run und nie ohne echte Absenderidentität.
    const wantAuto = cfg.sendMode === "compliant_auto" && !dry;
    const auto = wantAuto && !!cfg.sender?.name;
    if (wantAuto && !auto) notes.push("Echtversand inaktiv: in config.json fehlt sender.name – es entstehen nur Entwürfe.");
    const gapMs = Math.ceil((hm(cfg.window[1]) - hm(cfg.window[0])) / cfg.limit) * 60_000; // Versand über den Arbeitstag verteilen
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
      const found = Object.entries(reg.drafts || {}).find(([, d]) => d.createdAt >= a.at && (a.threadId ? d.threadId === a.threadId : normEmail(d.to) === a.to));
      if (found) { state.actions[key] = { ...a, status: "prepared", draftId: found[0] }; state.prepared[found[0]] = { key, at: a.at, kind: a.kind }; }
      else if (t - new Date(a.at) > 10 * 60_000) delete state.actions[key]; // nichts entstanden → darf neu versucht werden
    }

    async function prepare(key, info, make) {
      if (state.actions[key]) return; // schon erledigt oder in Arbeit → keine Doppelentwürfe
      if (dry) { plan.push({ ...info, autoSend: !!info.autoSend && cfg.sendMode === "compliant_auto" && !info.escalate }); used++; return; }
      const result = await compose(info.task);
      if (info.commercial && result.body) result.body = finalizeCommercial(result.body, cfg.sender, info.lang);
      if (result.decision === "optout") { suppress([info.to], "opt-out (erkannt beim Schreiben)", info.threadId); return "optout"; }
      if (result.decision === "ignore") { state.actions[key] = { status: "ignored", at: t.toISOString(), reason: result.reason }; return "ignore"; }
      let review = result.decision !== "draft";
      if (info.escalate) review = true;
      if (!result.body || result.body.length > 6000 || AI_RE.test(result.body + (result.subject || ""))) review = true;
      if (!result.body) result.body = "(Bitte selbst formulieren – der Entwurf konnte nicht automatisch geschrieben werden.)";
      state.actions[key] = { status: "creating", at: t.toISOString(), kind: info.kind, threadId: info.threadId, to: normEmail(info.to) };
      save();
      const d = await make(result);
      state.actions[key] = { status: "prepared", at: t.toISOString(), kind: info.kind, threadId: d.threadId, draftId: d.draftId, review,
        to: normEmail(info.to), autoSend: !!info.autoSend && !review, paced: !!info.paced };
      if (info.basis && d.threadId) state.compliantThreads[d.threadId] = { to: normEmail(info.to), basis: info.basis, lang: info.lang || "de", at: t.toISOString() };
      if (info.paced) state.lastPacedAt = +t;
      if (d.isNew !== false) { state.prepared[d.draftId] = { key, at: t.toISOString(), kind: info.kind }; used++; }
      if (d.threadId) state.threadDrafts[d.threadId] = d.draftId;
      save();
      if (review) await gmail.markDraftForReview(d.draftId);
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
    for (const [threadId, entries] of threads) {
      try {
        const recips = [...new Set(entries.map((e) => normEmail(e.to)))];
        if (recips.some((r) => exclude.has(r))) { ownThreads.push({ threadId, to: recips.join(", "), skipped: "excludeAddresses" }); continue; }
        if (t - Math.max(...entries.map((e) => new Date(e.sentAt))) > cfg.activeDays * DAY_MS) { ownThreads.push({ threadId, to: recips.join(", "), skipped: "inaktiv" }); continue; }
        const { messages } = await gmail.readThread(threadId);
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
          else toAnswer = { m, sender, text };
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
          if (free() <= 0) { notes.push(`Tageslimit erreicht – Antwort in ${threadId} folgt morgen.`); continue; }
          const { m, sender, text } = toAnswer;
          const key = "reply:" + m.messageId;
          const res = await prepare(key, {
            kind: "antwort", threadId, to: sender, subject: m.subject, escalate: ESCALATE_RE.test(text),
            autoSend: !!state.compliantThreads[threadId] && !ESCALATE_RE.test(text),
            task: { kind: "reply", sender: cfg.sender, offer: cfg.offer, thread: mails.map((x) => ({ from: x.from, date: x.date, subject: x.subject, body: (x.sent ? x.body : newText(x.body) || x.body).slice(0, 4000) })) },
          }, async (r) => {
            // Ein noch offener eigener Entwurf in diesem Thread wird aktualisiert statt verdoppelt.
            if (isPending(pendingDraft)) return { ...(await gmail.updateDraft(pendingDraft, { body: r.body })), draftId: pendingDraft, isNew: false };
            return gmail.replyToThread(threadId, { body: r.body });
          });
          if (!dry) for (const x of ext) state.handled[x.messageId] ||= res === "optout" ? "optout" : "answered";
          continue;
        }

        // Follow-ups nur, wenn noch nie eine externe Antwort kam und kein eigener Entwurf offen ist.
        if (ext.length === 0 && !isPending(pendingDraft)) {
          const n = own.length;
          const due = n === 1 ? own[0].internalDate + cfg.followUpDays[0] * DAY_MS : n === 2 ? own[1].internalDate + cfg.followUpDays[1] * DAY_MS : null;
          if (due) seen.followUpDue = new Date(due).toISOString();
          if (due && t >= due) followUps.push({ threadId, n, own, to: recips[0] });
        }
      } catch (e) {
        if (TRANSIENT_RE.test(e.message)) throw e; // Gmail/Netz gestört → ganzer Durchlauf mit Backoff
        log("error", "thread_failed", { threadId, error: e.message }); // ein Kontakt stoppt nie den Worker
      }
    }

    // 2) Follow-ups und Erstkontakte: nur im Zeitfenster, wenige pro Durchlauf, Reserve für Antworten bleibt frei.
    const inWindow = zurichMinutes(t) >= hm(cfg.window[0]) && zurichMinutes(t) < hm(cfg.window[1]);
    let paced = 0;
    const pacedFree = () => free() > cfg.replyReserve && paced < (dry ? Infinity : cfg.maxPacedPerTick) && (!auto || +t - (state.lastPacedAt || 0) >= gapMs);
    if (!inWindow) notes.push(`Follow-ups und Erstkontakte nur ${cfg.window[0]}–${cfg.window[1]} (Europe/Zurich).`);
    for (const f of followUps) {
      if (!(inWindow || dry) || !pacedFree()) break;
      try {
        const key = `followup:${f.threadId}:${f.n}`;
        await prepare(key, {
          kind: `follow-up ${f.n}`, threadId: f.threadId, to: f.to, subject: f.own[0].subject, commercial: true, paced: true,
          // Selbst gesendet nur in Threads, die mit gültiger Versandgrundlage begonnen wurden – sonst Entwurf.
          autoSend: !!state.compliantThreads[f.threadId], lang: state.compliantThreads[f.threadId]?.lang,
          task: { kind: "followup", followupNumber: f.n, sender: cfg.sender, offer: cfg.offer, thread: f.own.map((x) => ({ from: x.from, date: x.date, subject: x.subject, body: x.body.slice(0, 4000) })) },
        }, (r) => gmail.replyToThread(f.threadId, { body: r.body }));
        paced++;
      } catch (e) {
        if (TRANSIENT_RE.test(e.message)) throw e;
        log("error", "followup_failed", { threadId: f.threadId, error: e.message });
      }
    }

    // Erstkontakte ausschließlich aus der von Sir freigegebenen Lead-Liste.
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
          kind: "erstkontakt", to, subject: company || name || to, basis, lang: language, commercial: true, paced: true, autoSend: true,
          task: { kind: "outreach", sender: cfg.sender, offer: cfg.offer, lead: { name, company, website, language, notes: leadNotes, websiteIssues: websiteIssues || [] } },
        }, (r) => gmail.createDraft({ to: name ? `${name.replace(/[<>"\r\n]/g, "")} <${to}>` : to, subject: r.subject || "Kurze Frage", body: r.body }));
        paced++;
      } catch (e) {
        if (TRANSIENT_RE.test(e.message)) throw e;
        log("error", "outreach_failed", { to, error: e.message });
      }
    }
    if (eligibleLeads.length && !canWrite) notes.push("Erstkontakte deaktiviert: in config.json fehlen offer und/oder sender.name.");
    // Nur den Status nachtragen – frisch gelesen, damit Sirs gleichzeitige Änderungen an der Liste erhalten bleiben.
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

    // 3) Versand: nur freigegebene Entwürfe, Antworten zuerst, im Zeitfenster, verteilt, Suppression direkt vor jedem Send.
    if (auto) {
      const fresh = gmail.listOwned();
      const isToday = (x) => x.sentAt && zurichDay(new Date(x.sentAt)) === day;
      let sentNow = Object.values(fresh.sent || {}).filter(isToday).length;
      const queue = Object.entries(state.actions).filter(([, a]) => a.status === "prepared" && a.autoSend)
        .sort(([, a], [, b]) => (a.paced - b.paced) || a.at.localeCompare(b.at));
      for (const [key, a] of queue) {
        if (!fresh.drafts?.[a.draftId]) {
          a.status = Object.values(fresh.sent || {}).some((x) => x.fromDraft === a.draftId) ? "sent_by_sir" : "draft_gone";
          continue;
        }
        if (!inWindow) break;
        if (a.paced && +t - (state.lastSendAt || 0) < gapMs) continue;
        const suppNow = { ...store.read("suppression.json", {}), ...supp };
        const to = normEmail(fresh.drafts[a.draftId].to);
        if (suppNow[to] || suppNow[a.to] || exclude.has(to)) { a.status = "suppressed"; log("warn", "send_blocked_suppressed", { key, to }); continue; }
        if (sentNow >= cfg.limit) { notes.push("Tageslimit erreicht – weiterer Versand erst morgen."); break; }
        a.status = "sending";
        save();
        try {
          await gmail.sendDraft(a.draftId);
          Object.assign(a, { status: "sent", sentAt: t.toISOString() });
          sentNow++;
          if (a.paced) state.lastSendAt = +t;
          sends.push({ kind: a.kind, to, threadId: a.threadId });
          log("info", "sent", { key, kind: a.kind, to, draftId: a.draftId, threadId: a.threadId });
        } catch (e) {
          Object.assign(a, { status: "send_failed", error: e.message }); // nie automatisch wiederholen; Entwurf bleibt für Sir
          log("error", "send_failed", { key, to, error: e.message });
          save();
          if (TRANSIENT_RE.test(e.message)) throw e;
        }
        save();
      }
    }

    save();
    return { day, limit: cfg.limit, sentToday, used, free: free(), dryRun: dry, sendMode: cfg.sendMode, autoSendActive: auto, ownThreads, plan, sends, optouts,
      suppressedTotal: Object.keys(supp).length, eligibleLeads: eligibleLeads.length, blockedLeads: blockedLeads.length, notes };
  }

  return {
    config,
    plan: () => cycle({ dry: true, readOnly: true }),
    async tick() {
      const state = { ...STATE, ...store.read("state.json", STATE) };
      if (Date.now() < state.backoffUntil) return { skipped: "backoff" };
      const dry = config().dryRun !== false;
      try {
        const r = await cycle({ dry });
        const s = store.read("state.json", STATE);
        if (s.failures) store.write("state.json", { ...s, failures: 0, backoffUntil: 0 });
        log("info", "tick", { dryRun: dry, sentToday: r.sentToday, used: r.used, free: r.free, threads: r.ownThreads.length, autoSend: r.autoSendActive, sends: r.sends, eligibleLeads: r.eligibleLeads, blockedLeads: r.blockedLeads, plan: r.plan.map(({ task, ...p }) => p), optouts: r.optouts, notes: r.notes });
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

// ---------- Kommandozeile ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUSY = 3; // Exit-Code „Lock belegt“ – z. B. während eines manuellen --once

async function loop() {
  const gmail = await import("./gmail.js");
  const log = createLogger(WORKER_DIR);
  if (!acquireLock(WORKER_DIR)) { log("info", "already_running"); console.log("Mail-Worker läuft bereits."); return BUSY; }
  const release = () => releaseLock(WORKER_DIR);
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
  const worker = createWorker({ gmail, compose: (task) => claudeCompose({ model: worker.config().model })(task), log });
  log("info", "worker_started", { pid: process.pid, dryRun: worker.config().dryRun !== false });
  // Herzschlag auch während langer Durchläufe, damit kein zweiter Worker das Lock für verwaist hält.
  setInterval(() => heartbeat(WORKER_DIR), 60_000);
  for (;;) {
    heartbeat(WORKER_DIR);
    await worker.tick();
    await sleep(worker.config().pollMinutes * 60_000);
  }
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
