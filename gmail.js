// Gmail-Anbindung für Jarvis – ohne Abhängigkeiten, nur Node.js 18+ (natives fetch).
// Regel: Jarvis bearbeitet und sendet AUSSCHLIESSLICH Entwürfe, die er selbst erzeugt hat.
// Eigene Entwürfe tragen das Gmail-Label JARVIS und stehen mit Message-ID und Thread-ID im
// internen Register (.secrets/gmail_jarvis.json). Beides muss stimmen, sonst wird abgelehnt.
//
//   node gmail.js auth                                   einmalige OAuth-Anmeldung im Browser
//   node gmail.js draft --to a@b.de --subject X --body Y  neuen Entwurf anlegen
//   node gmail.js update <draftId> [--to ..] [--subject ..] [--body ..]
//   node gmail.js send <draftId>
//   node gmail.js list
//   node gmail.js thread <threadId>                     eigenen, bereits gesendeten Thread lesen
//   node gmail.js reply <threadId> --body Y              Antwort-Entwurf im eigenen Thread (sendet nie)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
const CREDENTIALS_FILE = path.join(SECRETS, "gmail_credentials.json");
const TOKEN_FILE = path.join(SECRETS, "gmail_token.json");
const REGISTRY_FILE = path.join(SECRETS, "gmail_jarvis.json");
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.labels"];
export const LABEL = "JARVIS";
// TF-025: Cold-Lead-Entwürfe – Jarvis legt sie an, sendet sie aber NIE (weder Worker, VPS, Kampagne noch Cloud-Queue).
// Nur Chris versendet sie selbst in Gmail. Diese Sperre sitzt hier, auf der untersten Ebene vor jedem Send.
export const COLD_DRAFT_MODE = "COLD_LEAD_DRAFT_ONLY";

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function writeSecret(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomar: erst in eine Temp-Datei schreiben, dann umbenennen – ein Absturz hinterlässt nie ein halbes Register.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadClient() {
  const raw = readJson(CREDENTIALS_FILE, null);
  const c = raw?.installed || raw?.web;
  if (!c?.client_id) throw new Error(`OAuth-Zugangsdaten fehlen: ${CREDENTIALS_FILE}`);
  return c;
}

// ---------- OAuth (Desktop-Flow mit Loopback-Adresse und PKCE) ----------

export async function authorize({ openBrowser = true } = {}) {
  const client = loadClient();
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  const { code, redirectUri } = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/") { res.writeHead(404); return res.end(); }
      const err = url.searchParams.get("error");
      const ok = !err && url.searchParams.get("state") === state && url.searchParams.get("code");
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(ok ? "<h2>Jarvis: Gmail verbunden. Dieses Fenster kann geschlossen werden.</h2>" : "<h2>Anmeldung fehlgeschlagen.</h2>");
      server.close();
      ok ? resolve({ code: url.searchParams.get("code"), redirectUri }) : reject(new Error("OAuth abgelehnt: " + (err || "ungültiger state")));
    });
    let redirectUri;
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const authUrl = new URL(client.auth_uri || "https://accounts.google.com/o/oauth2/auth");
      authUrl.search = new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", scope: SCOPES.join(" "),
        access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
      });
      console.log("\nFalls sich kein Browser öffnet, diese Adresse aufrufen:\n" + authUrl + "\n");
      if (openBrowser) {
        const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", String(authUrl)]]
          : process.platform === "darwin" ? ["open", [String(authUrl)]] : ["xdg-open", [String(authUrl)]];
        spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
      }
    });
    setTimeout(() => { server.close(); reject(new Error("OAuth-Zeitlimit (5 min) überschritten.")); }, 300_000).unref();
  });

  const token = await tokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  saveToken(token);
  return token;
}

async function tokenRequest(client, params) {
  const r = await fetch(client.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...params }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Token-Anfrage fehlgeschlagen: ${body.error_description || body.error || r.status}`);
  return body;
}

function saveToken(t, previous = {}) {
  writeSecret(TOKEN_FILE, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || previous.refresh_token,
    scope: t.scope || previous.scope,
    expiry: Date.now() + (t.expires_in || 3600) * 1000,
  });
}

async function accessToken() {
  const t = readJson(TOKEN_FILE, null);
  if (!t?.refresh_token) throw new Error("Gmail ist nicht verbunden. Erst ausführen: node gmail.js auth");
  if (t.access_token && t.expiry - 60_000 > Date.now()) return t.access_token;
  const fresh = await tokenRequest(loadClient(), { grant_type: "refresh_token", refresh_token: t.refresh_token });
  saveToken(fresh, t);
  return fresh.access_token;
}

async function gmail(method, route, body) {
  const r = await fetch(API + route, {
    method, signal: AbortSignal.timeout(60_000),
    headers: { authorization: `Bearer ${await accessToken()}`, ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(`Gmail ${method} ${route}: ${data.error?.message || r.status}`);
  return data;
}

// ---------- Register & Label ----------

const loadRegistry = () => ({ labelId: null, drafts: {}, sent: {}, sending: {}, ...readJson(REGISTRY_FILE, {}) });
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Register immer frisch lesen, ändern und atomar schreiben – unter kurzer Sperre. So überschreibt kein Prozess
// (Worker, Sprach-Jarvis, CLI) die Einträge eines anderen; insbesondere geht nie ein gesendeter Eintrag verloren.
function updateRegistry(fn) {
  const lock = REGISTRY_FILE + ".lock";
  fs.mkdirSync(SECRETS, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (i > 250) throw new Error("Register gesperrt – bitte gleich erneut versuchen.");
      sleepSync(20);
    }
  }
  try {
    const reg = loadRegistry();
    fn(reg);
    writeSecret(REGISTRY_FILE, reg);
    return reg;
  } finally { fs.rmSync(lock, { force: true }); }
}

async function labelId(reg) {
  const { labels = [] } = await gmail("GET", "/labels");
  let label = labels.find((l) => l.name === LABEL);
  if (!label) label = await gmail("POST", "/labels", { name: LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" });
  if (reg.labelId !== label.id) { reg.labelId = label.id; updateRegistry((r) => { r.labelId = label.id; }); }
  return label.id;
}

// Prüft, dass ein Entwurf wirklich von Jarvis stammt: im Register UND in Gmail mit Label JARVIS
// UND dieselbe Message-ID UND dieselbe Thread-ID. Wirft bei jeder Abweichung – fremde Entwürfe werden nie angefasst.
export async function assertOwnedDraft(draftId, reg = loadRegistry()) {
  const entry = reg.drafts[draftId];
  if (!entry) throw new Error(`Entwurf ${draftId} wurde nicht von Jarvis erstellt – Zugriff verweigert.`);
  const draft = await gmail("GET", `/drafts/${encodeURIComponent(draftId)}?format=minimal`);
  const lid = reg.labelId || (await labelId(reg));
  if (!draft.message?.labelIds?.includes(lid)) throw new Error(`Entwurf ${draftId} trägt nicht das Label ${LABEL} – Zugriff verweigert.`);
  if (draft.message.id !== entry.messageId) throw new Error(`Entwurf ${draftId}: Message-ID stimmt nicht mit dem Register überein – Zugriff verweigert.`);
  if (draft.message.threadId !== entry.threadId) throw new Error(`Entwurf ${draftId}: Thread-ID stimmt nicht mit dem Register überein – Zugriff verweigert.`);
  return { draft, entry };
}

// ---------- Nachrichten ----------

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);
function rawMessage({ to, subject = "", body = "", inReplyTo = "", references = "" }) {
  if (!to) throw new Error("Empfänger (--to) fehlt.");
  if (/[\r\n]/.test(to + subject + inReplyTo + references)) throw new Error("Zeilenumbrüche in Empfänger oder Betreff sind nicht erlaubt.");
  const mime = [
    `To: ${to}`, `Subject: ${encodeHeader(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(body).toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
  return Buffer.from(mime).toString("base64url");
}

async function labelAndDescribe(messageId, lid) {
  await gmail("POST", `/messages/${messageId}/modify`, { addLabelIds: [lid] });
  const msg = await gmail("GET", `/messages/${messageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Message-Id`);
  const header = msg.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id");
  return { messageId, rfcMessageId: header?.value || null, threadId: msg.threadId, labelIds: msg.labelIds || [] };
}

// Landet ein Antwort-Entwurf nicht im Ziel-Thread, wird er nie registriert: der gerade selbst
// angelegte Entwurf wird wieder gelöscht und die Aktion bricht ab.
async function discardMismatch(draftId, threadId) {
  const removed = await gmail("DELETE", `/drafts/${encodeURIComponent(draftId)}`).then(() => true, () => false);
  throw new Error(`Antwort-Entwurf landete nicht im Thread ${threadId} – nicht registriert, Abbruch.` +
    (removed ? " Der Entwurf wurde verworfen." : ` Bitte Entwurf ${draftId} in Gmail von Hand löschen, nicht senden.`));
}

export async function createDraft(fields) {
  const reg = loadRegistry();
  const lid = await labelId(reg);
  const draft = await gmail("POST", "/drafts", { message: { raw: rawMessage(fields), ...(fields.threadId && { threadId: fields.threadId }) } });
  if (fields.threadId && draft.message?.threadId !== fields.threadId) await discardMismatch(draft.id, fields.threadId);
  const info = await labelAndDescribe(draft.message.id, lid);
  if (fields.threadId && info.threadId !== fields.threadId) await discardMismatch(draft.id, fields.threadId);
  const reply = fields.inReplyTo ? { inReplyTo: fields.inReplyTo, references: fields.references } : {};
  const cold = fields.mode === COLD_DRAFT_MODE ? { mode: COLD_DRAFT_MODE, leadId: fields.leadId || null, draftHash: fields.draftHash || null, legalBasis: "NONE" } : {};
  updateRegistry((r) => { r.drafts[draft.id] = { ...info, to: fields.to, subject: fields.subject || "", ...reply, ...cold, createdAt: new Date().toISOString() }; });
  return { draftId: draft.id, ...info };
}

export async function updateDraft(draftId, fields) {
  const reg = loadRegistry();
  const { entry } = await assertOwnedDraft(draftId, reg);
  const merged = { to: fields.to ?? entry.to, subject: fields.subject ?? entry.subject, body: fields.body ?? "", inReplyTo: entry.inReplyTo, references: entry.references };
  const draft = await gmail("PUT", `/drafts/${encodeURIComponent(draftId)}`, { message: { raw: rawMessage(merged), threadId: entry.threadId } });
  const info = await labelAndDescribe(draft.message.id, reg.labelId);
  updateRegistry((r) => { r.drafts[draftId] = { ...entry, ...info, to: merged.to, subject: merged.subject, updatedAt: new Date().toISOString() }; });
  return { draftId, ...info };
}

// Harte Limits für tatsächlich gesendete Jarvis-Mails (Europe/Zurich), gezählt aus dem Register:
// höchstens 100 je Kalendertag und höchstens 50 je Versandfenster (morning 09:30 / afternoon 14:30).
export const DAILY_SEND_LIMIT = 100;
export const WINDOW_SEND_LIMIT = 50;
export const SEND_WINDOW_IDS = ["morning", "afternoon"];
const zurichDay = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(d);
// Unklare Sendungen (Absturz zwischen Gmail und Register) zählen vorsichtig mit; fehlgeschlagene nicht.
// Von Chris manuell in Gmail versendete Cold-Entwürfe sind keine Jarvis-Sends und zählen nicht aufs Limit.
const todays = (reg, now) => [...Object.values(reg.sent || {}), ...Object.values(reg.sending || {})].filter((s) => !s.manual && s.sentAt && zurichDay(new Date(s.sentAt)) === zurichDay(now));
export const sentToday = (reg = loadRegistry(), now = new Date()) => todays(reg, now).length;
export const sentInWindow = (window, reg = loadRegistry(), now = new Date()) => todays(reg, now).filter((s) => s.window === window).length;

// Zählen, Senden und Registrieren laufen unter einer Sperrdatei – auch parallele Prozesse können die Limits nicht überholen.
// Der Halter erneuert die Sperre laufend; als verwaist gilt sie nur, wenn sie zwei Minuten lang nicht erneuert wurde.
async function withSendLock(fn) {
  const lock = path.join(SECRETS, "gmail_send.lock");
  fs.mkdirSync(SECRETS, { recursive: true });
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (i >= 240) throw new Error("Eine andere Sendung läuft noch – bitte gleich erneut versuchen.");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(lock, t, t); } catch {} }, 10_000);
  try { return await fn(); } finally { clearInterval(beat); fs.rmSync(lock, { force: true }); }
}

// window: "morning" | "afternoon" für automatische Läufe des Mail-Workers; ohne Fenster (z. B. manuell) gilt nur das Tageslimit.
export const assertSendable = (draftId, reg = loadRegistry()) => {
  if (reg.drafts?.[draftId]?.mode === COLD_DRAFT_MODE) throw new Error(`Entwurf ${draftId} ist ein Cold-Lead-Entwurf (COLD_LEAD_DRAFT_ONLY) – Jarvis sendet ihn nie. Nur Chris entscheidet manuell in Gmail.`);
};
export const sendDraft = async (draftId, { window = null } = {}) => { assertSendable(draftId); return withSendLock(async () => {
  assertSendable(draftId);
  if (window !== null && !SEND_WINDOW_IDS.includes(window)) throw new Error(`Unbekanntes Versandfenster ${window} – nicht gesendet.`);
  const reg = loadRegistry();
  const { entry } = await assertOwnedDraft(draftId, reg);
  const now = new Date();
  if (sentToday(loadRegistry(), now) >= DAILY_SEND_LIMIT) throw new Error(`Tageslimit von ${DAILY_SEND_LIMIT} Jarvis-Mails (Europe/Zurich) erreicht – nicht gesendet.`);
  if (window && sentInWindow(window, loadRegistry(), now) >= WINDOW_SEND_LIMIT) throw new Error(`Fensterlimit von ${WINDOW_SEND_LIMIT} Jarvis-Mails (${window}) erreicht – nicht gesendet.`);
  // Vor dem eigentlichen Senden vormerken: stürzt der Prozess danach ab, zählt die Sendung trotzdem.
  updateRegistry((r) => { r.sending[draftId] = { to: entry.to, window, sentAt: now.toISOString() }; });
  let sent;
  try { sent = await gmail("POST", "/drafts/send", { id: draftId }); }
  catch (e) { updateRegistry((r) => { delete r.sending[draftId]; }); throw e; } // fehlgeschlagen → zählt nicht
  const info = await labelAndDescribe(sent.id, reg.labelId).catch(() => ({ messageId: sent.id, rfcMessageId: null, threadId: sent.threadId, labelIds: sent.labelIds || [] }));
  updateRegistry((r) => {
    delete r.drafts[draftId];
    delete r.sending[draftId];
    r.sent[sent.id] = { ...info, to: entry.to, subject: entry.subject, fromDraft: draftId, ...(window && { window }), sentAt: new Date().toISOString() };
  });
  return info;
}); };

// Verwirft einen EIGENEN Entwurf (z. B. DISCARD DRAFT im Dashboard). Fremde Entwürfe: assertOwnedDraft lehnt ab, bevor Gmail gefragt wird.
export async function deleteDraft(draftId) {
  const reg = loadRegistry();
  await assertOwnedDraft(draftId, reg);
  await gmail("DELETE", `/drafts/${encodeURIComponent(draftId)}`);
  updateRegistry((r) => { delete r.drafts[draftId]; });
  return { draftId, deleted: true };
}

// Erkennt, ob Chris einen Cold-Entwurf in Gmail manuell versendet (oder dort gelöscht) hat. Geprüft werden nur registrierte
// Cold-Entwürfe und nur der Thread, den dieser Entwurf selbst eröffnet hat. Als Jarvis-Thread registriert wird er nur, wenn die
// Zuordnung eindeutig ist: Thread-ID gleich, erste Nachricht ist eine gesendete Nachricht an denselben Empfänger mit demselben
// Betreff, nicht älter als der Entwurf. Die Rechtsgrundlage bleibt NONE; ein Fenster/Limit wird nicht belastet.
export async function syncColdDrafts() {
  const out = [];
  for (const [draftId, e] of Object.entries(loadRegistry().drafts || {})) {
    if (e.mode !== COLD_DRAFT_MODE) continue;
    const exists = await gmail("GET", `/drafts/${encodeURIComponent(draftId)}?format=minimal`).then(() => true, (err) => {
      if (/not found|404/i.test(err.message)) return false;
      throw err;
    });
    if (exists) continue;
    const thread = await gmail("GET", `/threads/${encodeURIComponent(e.threadId)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`).catch((err) => {
      if (/not found|404/i.test(err.message)) return null;
      throw err;
    });
    const msgs = (thread?.messages || []).slice().sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
    const first = msgs[0];
    const hdr = (m, n) => m?.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value || "";
    const sameTo = first && hdr(first, "to").toLowerCase().includes(String(e.to).toLowerCase().replace(/^.*<|>.*$/g, ""));
    const unique = thread && thread.id === e.threadId && first && msgs.every((m) => m.threadId === e.threadId)
      && (first.labelIds || []).includes("SENT") && !(first.labelIds || []).includes("DRAFT") && sameTo
      && hdr(first, "subject") === (e.subject || "") && Number(first.internalDate) >= Date.parse(e.createdAt) - 60_000;
    if (unique) {
      const sentAt = new Date(Number(first.internalDate)).toISOString();
      updateRegistry((r) => {
        delete r.drafts[draftId];
        r.sent[first.id] = { messageId: first.id, threadId: e.threadId, to: e.to, subject: e.subject, fromDraft: draftId, sentAt, manual: true, mode: COLD_DRAFT_MODE, leadId: e.leadId, legalBasis: "NONE" };
      });
      out.push({ draftId, leadId: e.leadId, status: "manually_sent", messageId: first.id, threadId: e.threadId, sentAt });
    } else {
      // Gelöscht oder nicht eindeutig zuzuordnen: nicht als Jarvis-Thread registrieren.
      updateRegistry((r) => { delete r.drafts[draftId]; });
      out.push({ draftId, leadId: e.leadId, status: thread ? "unclear" : "gone" });
    }
  }
  return out;
}

export const listOwned = () => loadRegistry();

// Markiert einen EIGENEN Entwurf zusätzlich mit REVIEW_LABEL, damit Chris ihn vor dem Senden prüft.
export const REVIEW_LABEL = "JARVIS-PRUEFEN";
export async function markDraftForReview(draftId) {
  const reg = loadRegistry();
  const { draft } = await assertOwnedDraft(draftId, reg);
  const { labels = [] } = await gmail("GET", "/labels");
  const label = labels.find((l) => l.name === REVIEW_LABEL)
    || (await gmail("POST", "/labels", { name: REVIEW_LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" }));
  await gmail("POST", `/messages/${draft.message.id}/modify`, { addLabelIds: [label.id] });
}

// ---------- Laufende Gespräche (nur eigene, bereits gesendete Threads) ----------

// Ein Thread gilt nur als Jarvis-eigen, wenn seine Thread-ID im Gesendet-Register steht.
// Diese Prüfung läuft lokal, BEVOR Gmail gefragt wird – fremde Threads werden nie geöffnet.
function assertOwnedThread(threadId, reg) {
  const own = Object.values(reg.sent).filter((s) => s.threadId === threadId);
  if (!threadId || !own.length) throw new Error(`Thread ${threadId} wurde nicht von Jarvis begonnen – Zugriff verweigert.`);
  return own;
}

const decode = (data) => Buffer.from(data, "base64url").toString("utf8");
const findPart = (p, type) => (!p ? null : p.mimeType === type && p.body?.data ? p : (p.parts || []).reduce((f, c) => f || findPart(c, type), null));
function bodyText(payload) {
  const plain = findPart(payload, "text/plain");
  if (plain) return decode(plain.body.data);
  const html = findPart(payload, "text/html");
  return html ? decode(html.body.data).replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").trim() : "";
}

function describeMessage(m) {
  const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
  const labels = m.labelIds || [];
  return {
    messageId: m.id, rfcMessageId: h["message-id"] || null, references: h.references || "",
    from: h.from || "", replyTo: h["reply-to"] || "", to: h.to || "", cc: h.cc || "",
    date: h.date || "", subject: h.subject || "", body: bodyText(m.payload),
    sent: labels.includes("SENT"), draft: labels.includes("DRAFT"), internalDate: Number(m.internalDate || 0),
  };
}

// Liest einen eigenen Thread. Zusätzlich muss mindestens eine registrierte gesendete Nachricht
// wirklich in diesem Gmail-Thread liegen – sonst ist die Zuordnung nicht eindeutig.
async function fetchOwnedThread(threadId, reg) {
  const own = assertOwnedThread(threadId, reg);
  const thread = await gmail("GET", `/threads/${encodeURIComponent(threadId)}?format=full`);
  const msgs = thread.messages || [];
  const ids = new Set(msgs.map((m) => m.id));
  if (thread.id !== threadId || msgs.some((m) => m.threadId !== threadId) || !own.some((s) => ids.has(s.messageId)))
    throw new Error(`Thread ${threadId}: Zuordnung zum Gesendet-Register nicht eindeutig – Zugriff verweigert.`);
  return { own, messages: msgs.map(describeMessage).sort((a, b) => a.internalDate - b.internalDate) };
}

export async function readThread(threadId) {
  const { messages } = await fetchOwnedThread(threadId, loadRegistry());
  return { threadId, messages };
}

// Legt nur einen Antwort-ENTWURF im selben Thread an – gesendet wird ausschließlich über sendDraft.
export async function replyToThread(threadId, { body } = {}) {
  if (!body) throw new Error("Antworttext (--body) fehlt.");
  const { own, messages } = await fetchOwnedThread(threadId, loadRegistry());
  const mails = messages.filter((m) => !m.draft);
  const last = mails.at(-1);
  const external = mails.filter((m) => !m.sent).at(-1);
  // Empfänger: Absender der letzten externen Nachricht; ohne Antwort bisher (Follow-up) der zuletzt
  // von Jarvis in diesem Thread angeschriebene Empfänger.
  const to = external ? external.replyTo || external.from : own.at(-1).to;
  const subject = last?.subject || own.at(-1).subject || "";
  const draft = await createDraft({
    to, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, body, threadId,
    inReplyTo: last?.rfcMessageId || "", references: [last?.references, last?.rfcMessageId].filter(Boolean).join(" "),
  });
  return { ...draft, to };
}

// ---------- Kommandozeile ----------

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) out[args[i].slice(2)] = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = parseFlags(rest);
  const run = {
    auth: async () => { await authorize(); const p = await gmail("GET", "/profile"); return `Gmail verbunden: ${p.emailAddress}`; },
    draft: () => createDraft({ to: f.to, subject: f.subject, body: f.body }),
    update: () => updateDraft(f._[0], { to: f.to, subject: f.subject, body: f.body }),
    send: () => sendDraft(f._[0]),
    list: listOwned,
    thread: () => readThread(f._[0]),
    reply: () => replyToThread(f._[0], { body: f.body }),
  }[cmd];
  if (!run) {
    console.log("Befehle: auth | draft --to --subject --body | update <draftId> [...] | send <draftId> | list | thread <threadId> | reply <threadId> --body");
    process.exit(1);
  }
  Promise.resolve(run()).then(
    (r) => console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2)),
    (e) => { console.error("Fehler: " + e.message); process.exit(1); },
  );
}
