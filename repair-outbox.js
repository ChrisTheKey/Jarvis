// Repair-Outbox (TF-047) – minimaler, dateibasierter IPC zwischen dem separaten Repair-Service (jarvis-repair-worker) und dem
// Mail-Worker (einzige Sender Authority). Der Repair-Service sendet NIE selbst und hat keinen Gmail-Zugang: er legt Service-Mails
// (nur CUSTOMER_ACCESS_REQUEST / CUSTOMER_ORDER_FULFILLMENT) als Auftrag in die Outbox, der Mail-Worker sendet sie GENAU EINMAL.
//
// Warum Dateien statt gemeinsamem State: die bestehenden JSON-Dateien werden per read-modify-write geschrieben und die Locks
// (acquireLock) prüfen PIDs – über Container-Grenzen (eigene PID-Namespaces) ist das nicht sicher. Deshalb gilt hier strikt
// EIN Schreiber je Datei, jede Datei atomar (Temp + Umbenennen bzw. exklusives Anlegen):
//   <id>.draft.json    Repair-Service   vorbereitet, wird vom Mail-Worker NIE gelesen (entspricht einem Entwurf)
//   <id>.request.json  Repair-Service   verbindlicher Versandauftrag (atomar aus .draft.json umbenannt), nach Abschluss gelöscht
//   <id>.claim         Mail-Worker      exklusiv angelegt (wx) VOR dem Versand – ein Neustart sendet nie ein zweites Mal
//   <id>.result.json   Mail-Worker      sent | failed | unclear | rejected – ohne Adresse, ohne Inhalt
//   consumer.json      Mail-Worker      Herzschlag: Zustellweg aktiv (nur mit send_authority) + Gmail-OAuth-Status (TF-049, ok/Kategorie)
// Ohne Mail-Worker (offline/Standby) bleibt ein Auftrag offen: sendDraft meldet OUTBOX_PENDING (vorübergehend) – die Engines
// markieren dann NIE «gesendet» und versuchen es im nächsten Lauf erneut (der Auftrag selbst bleibt derselbe, kein Duplikat).
// Inhalte (Kundenadresse, Bericht, One-Time-Link) liegen nur in .draft/.request (Rechte 600) und werden nach dem Ergebnis gelöscht.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// TF-066: + CUSTOMER_ONBOARDING_DIALOGUE (transaktionaler Auftragsdialog, z. B. CHECK-Startnachricht). Trägt ein Auftrag eine
// order_id, sendet der Mail-Worker im gebundenen Auftrags-Thread (bzw. eröffnet ihn mit der ersten Nachricht und bindet ihn).
export const OUTBOX_CLASSES = Object.freeze(["CUSTOMER_ORDER_FULFILLMENT", "CUSTOMER_ACCESS_REQUEST", "CUSTOMER_ONBOARDING_DIALOGUE"]);
export const ONBOARDING_CLASS = "CUSTOMER_ONBOARDING_DIALOGUE";
const ORDER_ID_RE = /^(CA150|RF480|VNCHECK|VNFIX)-\d{8}-[0-9a-f]{6}$/;
// TF-071: hosting_question (Plattform-Frage vor dem Link), revalidate (neuer Link nach ungültigem Zugang).
export const OUTBOX_PURPOSES = Object.freeze(["first", "reissue", "host_key", "check_intro", "hosting_question", "revalidate"]);
export const OUTBOX_PENDING = "OUTBOX_PENDING";
export const OUTBOX_RESULTS = Object.freeze(["sent", "failed", "unclear", "rejected"]);
export const CONSUMER_FILE = "consumer.json";
export const CONSUMER_MAX_AGE_MS = 10 * 60_000;
const ID_RE = /^ob-[0-9a-f]{24}$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network/i;
const MAX_SUBJECT = 300, MAX_BODY = 20_000;
const KEEP_RESULTS_MS = 30 * 86_400_000;

const file = (dir, id, ext) => path.join(dir, `${id}.${ext}`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writeAtomic(f, data) {
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const rm = (f) => { try { fs.rmSync(f, { force: true }); } catch {} };
const pendingError = () => Object.assign(new Error(`${OUTBOX_PENDING}: Mail-Worker hat den Versand noch nicht bestätigt – nächster Lauf.`), { code: OUTBOX_PENDING });

// ---------- Repair-Service-Seite (Erzeuger) ----------
// Gleiche Aufrufform wie gmail.js für die Engines (createDraft / updateDraft / sendDraft) – die Engines bleiben unverändert.
export function createOutboxMailer({ dir, now = () => new Date() } = {}) {
  if (!dir) throw new Error("Outbox-Verzeichnis fehlt.");
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const check = (id) => { if (!ID_RE.test(String(id || ""))) throw new Error("Outbox: unbekannte Auftrags-ID."); };
  return {
    outbox: dir,
    async createDraft({ to, subject, body, messageClass, orderId = null, purpose = null, seq = null } = {}) {
      if (!OUTBOX_CLASSES.includes(messageClass)) throw new Error("Outbox: nur Service-Mails (CUSTOMER_ACCESS_REQUEST / CUSTOMER_ORDER_FULFILLMENT / CUSTOMER_ONBOARDING_DIALOGUE).");
      if (orderId != null && !ORDER_ID_RE.test(String(orderId))) throw new Error("Outbox: Auftrags-ID ungültig.");
      if (messageClass === ONBOARDING_CLASS && !orderId) throw new Error("Outbox: Onboarding-Nachricht nur zu einem Auftrag.");
      if (purpose != null && !OUTBOX_PURPOSES.includes(purpose)) throw new Error("Outbox: Zweck ungültig.");
      if (!EMAIL_RE.test(String(to || ""))) throw new Error("Outbox: Empfänger ungültig.");
      if (!subject || !body || String(subject).length > MAX_SUBJECT || String(body).length > MAX_BODY) throw new Error("Outbox: Betreff/Text fehlt oder zu lang.");
      ensure();
      const id = "ob-" + crypto.randomBytes(12).toString("hex");
      writeAtomic(file(dir, id, "draft.json"), { v: 1, id, message_class: messageClass, to: String(to), subject: String(subject), body: String(body),
        ...(orderId ? { order_id: String(orderId), purpose: purpose || null, ...(Number.isInteger(seq) ? { seq } : {}) } : {}), created_at: now().toISOString() });
      return { draftId: id, threadId: null };
    },
    async updateDraft(id, { subject, body } = {}) {
      check(id);
      const f = file(dir, id, "draft.json"), d = readJson(f);
      if (!d) throw new Error("Outbox: Auftrag bereits übergeben – nicht mehr änderbar.");
      writeAtomic(f, { ...d, ...(subject ? { subject: String(subject) } : {}), ...(body ? { body: String(body) } : {}), updated_at: now().toISOString() });
      return { draftId: id, threadId: null };
    },
    // Übergibt den Auftrag (einmalig, atomar) und meldet NUR dann Erfolg, wenn der Mail-Worker «sent» bestätigt hat.
    async sendDraft(id) {
      check(id);
      const res = readJson(file(dir, id, "result.json"));
      if (res?.status === "sent") { rm(file(dir, id, "request.json")); rm(file(dir, id, "draft.json")); return { messageId: null, outbox: id }; }
      if (res && OUTBOX_RESULTS.includes(res.status)) {
        rm(file(dir, id, "request.json")); rm(file(dir, id, "draft.json"));
        throw new Error(`Outbox: Zustellung ${res.status === "unclear" ? "unklar" : res.status === "rejected" ? "abgelehnt" : "fehlgeschlagen"} (Mail-Worker)`);
      }
      if (fs.existsSync(file(dir, id, "request.json"))) throw pendingError();
      const draft = file(dir, id, "draft.json");
      if (!fs.existsSync(draft)) throw new Error("Outbox: Auftrag unbekannt.");
      const d = readJson(draft);
      writeAtomic(draft, { ...d, committed_at: now().toISOString() });
      fs.renameSync(draft, file(dir, id, "request.json")); // ab hier verbindlich – der Mail-Worker sendet genau einmal
      throw pendingError();
    },
  };
}

// Zustand der Outbox – nur Zähler und Zeitpunkte (keine Adressen, keine Inhalte).
export function outboxStatus(dir, { now = Date.now() } = {}) {
  const out = { exists: false, writable: false, consumer_online: false, consumer_beat: null, staged: 0, pending: 0, results: Object.fromEntries(OUTBOX_RESULTS.map((s) => [s, 0])) };
  let names = [];
  try { names = fs.readdirSync(dir); out.exists = true; } catch { return out; }
  try { fs.accessSync(dir, fs.constants.W_OK); out.writable = true; } catch {}
  const c = readJson(path.join(dir, CONSUMER_FILE));
  if (c?.beat) { out.consumer_beat = new Date(c.beat).toISOString(); out.consumer_online = now - c.beat < CONSUMER_MAX_AGE_MS; }
  // TF-049: Gmail-OAuth-Status des Mail-Workers (read-only geprüft) – nur ok + sichere Kategorie, frisch nur innerhalb CONSUMER_MAX_AGE_MS.
  const ga = c?.gmail_auth;
  out.gmail_auth = ga && Number.isFinite(ga.at) ? { ok: ga.ok === true, category: ga.ok === true ? null : String(ga.category || "unknown_auth_error").replace(/[^a-z_]/g, "").slice(0, 40),
    fresh: now - ga.at < CONSUMER_MAX_AGE_MS } : null;
  for (const n of names) {
    if (n.endsWith(".draft.json")) out.staged++;
    else if (n.endsWith(".request.json") && !names.includes(n.replace(/\.request\.json$/, ".result.json"))) out.pending++;
    else if (n.endsWith(".result.json")) { const s = readJson(path.join(dir, n))?.status; if (s in out.results) out.results[s]++; }
  }
  return out;
}

// ---------- Mail-Worker-Seite (Verbraucher, nur mit send_authority) ----------
// Sendet jeden verbindlichen Auftrag GENAU EINMAL über gmail.js (Service-Klasse). Claim vor dem Versand; ein Claim ohne Ergebnis
// (Absturz/Neustart mitten im Versand) wird NIE erneut gesendet – Ergebnis «unclear» (bzw. «sent», wenn das Gmail-Register den
// Versand belegt). Gibt nie Adressen/Inhalte in Logs aus.
// gmailAuth (TF-049): Ergebnis von gmail.checkAuth – landet im Herzschlag (nur ok/Kategorie). Ist Gmail OAuth kaputt, bleibt jeder
// Auftrag unangetastet offen (kein Claim, kein «failed») – sonst gingen Service-Mails bei abgelaufenem Token endgültig verloren.
// TF-066 onboarding (optional, Mail-Worker): route(rq) → { threadId } (Antwort im gebundenen Auftrags-Thread) | { newThread } |
// { defer } (Auftragsstand noch nicht aktuell) | { reject } ; onSent(rq, info) bindet Auftrag ↔ Thread nach dem Versand;
// threadLost(rq) → manuelle Prüfung (nie ein neuer freier Thread). Ohne onboarding: Auftrags-Mails wie bisher, Onboarding-Klasse abgelehnt.
export async function processRepairOutbox({ dir, gmail, gmailAuth = null, log = () => {}, now = () => new Date(), max = 10, onboarding = null } = {}) {
  const out = { processed: 0, sent: 0, failed: 0, unclear: 0, rejected: 0, deferred: 0 };
  let names;
  try { names = fs.readdirSync(dir); } catch { return { ...out, missing: true }; }
  const auth = gmailAuth ? { ok: gmailAuth.ok === true, ...(gmailAuth.ok === true ? {} : { category: gmailAuth.category || "unknown_auth_error" }), at: gmailAuth.at ?? +now() } : undefined;
  writeAtomic(path.join(dir, CONSUMER_FILE), { beat: +now(), role: "mail-worker", ...(auth && { gmail_auth: auth }) });
  if (auth && !auth.ok) {
    out.deferred = names.filter((x) => x.endsWith(".request.json") && !names.includes(x.replace(/\.request\.json$/, ".result.json"))).length;
    return { ...out, gmail_auth_failed: true };
  }
  const result = (id, status, extra = {}) => {
    writeAtomic(file(dir, id, "result.json"), { v: 1, id, status, at: now().toISOString(), ...extra });
    out[status]++; out.processed++;
    log(status === "sent" ? "info" : "warn", "repair_outbox_" + status, { id, ...(extra.message_class ? { message_class: extra.message_class } : {}) });
  };
  for (const n of names.filter((x) => x.endsWith(".request.json")).sort()) {
    if (out.processed >= max) break;
    const id = n.slice(0, -".request.json".length);
    if (!ID_RE.test(id) || fs.existsSync(file(dir, id, "result.json"))) continue;
    const claimFile = file(dir, id, "claim");
    if (fs.existsSync(claimFile)) {
      // Früherer Versuch ohne Ergebnis: nie blind wiederholen.
      const claim = readJson(claimFile) || {};
      const reg = typeof gmail?.listOwned === "function" ? gmail.listOwned() : {};
      const done = claim.draft_id && Object.values(reg.sent || {}).some((s) => s.fromDraft === claim.draft_id);
      result(id, done ? "sent" : "unclear", { message_class: claim.message_class || null });
      continue;
    }
    const rq = readJson(file(dir, id, "request.json"));
    const valid = rq && rq.id === id && OUTBOX_CLASSES.includes(rq.message_class) && EMAIL_RE.test(String(rq.to || ""))
      && rq.subject && rq.body && String(rq.subject).length <= MAX_SUBJECT && String(rq.body).length <= MAX_BODY
      && (rq.order_id == null || ORDER_ID_RE.test(String(rq.order_id))) && (rq.message_class !== ONBOARDING_CLASS || (!!rq.order_id && !!onboarding));
    if (!valid) { result(id, "rejected", { message_class: OUTBOX_CLASSES.includes(rq?.message_class) ? rq.message_class : null }); continue; }
    if (!gmail || typeof gmail.createDraft !== "function" || typeof gmail.sendDraft !== "function") { out.deferred++; continue; }
    let route = null;
    if (rq.order_id && onboarding) {
      try { route = onboarding.route(rq); } catch (e) { log("error", "onboarding_route_failed", { id, error: String(e.message).slice(0, 120) }); out.deferred++; continue; }
      if (route?.defer) { out.deferred++; continue; }
      if (route?.reject) { result(id, "rejected", { message_class: rq.message_class, reason: String(route.reject).slice(0, 40) }); continue; }
      if (route?.threadId && typeof gmail.replyDraftInThread !== "function") { out.deferred++; continue; }
    }
    try { fs.writeFileSync(claimFile, JSON.stringify({ at: now().toISOString(), message_class: rq.message_class }), { flag: "wx", mode: 0o600 }); }
    catch (e) { if (e.code === "EEXIST") continue; throw e; }
    let d;
    try {
      d = route?.threadId
        ? await gmail.replyDraftInThread(route.threadId, { to: rq.to, body: rq.body, messageClass: rq.message_class, orderId: rq.order_id })
        : await gmail.createDraft({ to: rq.to, subject: rq.subject, body: rq.body, messageClass: rq.message_class, ...(rq.order_id && onboarding ? { orderId: rq.order_id } : {}) });
    }
    catch (e) {
      // Vor dem Versand: vorübergehender Fehler → Claim zurücknehmen, nächster Durchlauf; sonst endgültig fehlgeschlagen.
      if (TRANSIENT_RE.test(String(e.message))) { rm(claimFile); out.deferred++; log("warn", "repair_outbox_deferred", { id }); break; }
      // TF-066: Auftrags-Thread nicht mehr eindeutig → nie ein neuer freier Thread, manuelle Prüfung.
      if (route?.threadId) { try { onboarding.threadLost(rq); } catch {} }
      result(id, "failed", { message_class: rq.message_class, reason: "draft_failed" }); continue;
    }
    fs.writeFileSync(claimFile, JSON.stringify({ at: now().toISOString(), message_class: rq.message_class, draft_id: d.draftId }), { mode: 0o600 });
    let info = null;
    try { info = await gmail.sendDraft(d.draftId); }
    catch (e) {
      // Während des Versands: Ausgang ungewiss (5xx/Netz) → unklar; eindeutige Ablehnung → fehlgeschlagen. Nie ein zweiter Versuch.
      result(id, TRANSIENT_RE.test(String(e.message)) ? "unclear" : "failed", { message_class: rq.message_class });
      continue;
    }
    result(id, "sent", { message_class: rq.message_class });
    if (rq.order_id && onboarding) {
      try { onboarding.onSent(rq, { threadId: info?.threadId || d.threadId || null, messageId: info?.messageId || null }); }
      catch (e) { log("error", "onboarding_bind_failed", { id, error: String(e.message).slice(0, 120) }); }
    }
  }
  // Aufräumen (nur eigene Dateien): Ergebnis + Claim, deren Auftrag der Repair-Service längst abgeholt hat.
  for (const n of names.filter((x) => x.endsWith(".result.json"))) {
    const id = n.slice(0, -".result.json".length);
    const r = readJson(path.join(dir, n));
    if (r?.at && +now() - Date.parse(r.at) > KEEP_RESULTS_MS && !fs.existsSync(file(dir, id, "request.json"))) { rm(path.join(dir, n)); rm(file(dir, id, "claim")); }
  }
  return out;
}
