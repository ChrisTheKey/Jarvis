// Gmail-Anbindung für Jarvis – ohne Abhängigkeiten, nur Node.js 18+ (natives fetch).
// Regel: Jarvis bearbeitet und sendet AUSSCHLIESSLICH Entwürfe, die er selbst erzeugt hat.
// Eigene Entwürfe tragen das Gmail-Label JARVIS und stehen mit Message-ID und Thread-ID im
// internen Register (.secrets/gmail_jarvis.json). Beides muss stimmen, sonst wird abgelehnt.
//
//   node gmail.js auth                                   einmalige OAuth-Anmeldung im Browser
//   node gmail.js check                                  read-only Auth-Check (MAIL AUTH READY / MAIL AUTH FAIL (Kategorie))
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
// TF-025: Cold-Lead-Entwürfe – Jarvis legt sie an, sendet sie aber NIE von sich aus (weder Worker, VPS, Kampagne noch Cloud-Queue).
// Diese Sperre sitzt hier, auf der untersten Ebene vor jedem Send (sendDraft). Versendet werden sie nur durch einen Menschen: Chris in Gmail
// oder (TF-077B) ein berechtigter Verkäufer per Klick über sendPreparedLeadDraft – je Klick genau ein Lead, genau dieser Entwurf.
export const COLD_DRAFT_MODE = "COLD_LEAD_DRAFT_ONLY";
// TF-075A: Antwort-Entwürfe auf Kontaktformular-Anfragen – Jarvis legt sie an, sendet sie aber NIE (nur Chris manuell in Gmail).
export const CONTACT_FORM_DRAFT_MODE = "CONTACT_FORM_DRAFT_ONLY";
export const NEVER_SEND_MODES = Object.freeze([COLD_DRAFT_MODE, CONTACT_FORM_DRAFT_MODE]);
// TF-077B: automatische Erstantwort auf eine VERIFIZIERTE Kontaktformular-Anfrage (angefragte Antwort, kein Marketing) – genau einmal je
// Formular-Einsendung (contactFormKey), nur über contact-form.js. Unverifizierte Anfragen bleiben CONTACT_FORM_DRAFT_ONLY.
export const CONTACT_FORM_AUTO_REPLY_MODE = "CONTACT_FORM_AUTO_REPLY";
// Einzige automatisch sendbare Service-Klassen für echte, bezahlte Kundenaufträge (TF-041, nach Zahlungsschwelle).
// TF-066: + CUSTOMER_ONBOARDING_DIALOGUE – transaktionaler Dialog zu einem bestätigten, bezahlten Auftrag (nur im Auftrags-Thread).
// TF-081: + CUSTOMER_PAYMENT_REQUEST – Zahlungsanfrage/Erinnerung (mit Stripe-Link) zu einem bestätigten, noch unbezahlten Auftrag (payment-followup.js).
export const SERVICE_MESSAGE_CLASSES = Object.freeze(["CUSTOMER_ORDER_FULFILLMENT", "CUSTOMER_ACCESS_REQUEST", "CUSTOMER_ONBOARDING_DIALOGUE", "CUSTOMER_PAYMENT_REQUEST"]);

// TF-081: Absenderadresse für KUNDEN-Mails (Service-Klassen, Kontaktformular-Antworten): From + Reply-To = z. B. chris@helvetic-webdesign.ch.
// Voraussetzung in Gmail: die Adresse ist als «Senden als»-Alias des Jarvis-Kontos eingerichtet und bestätigt – sonst ersetzt Gmail das From
// durch die Kontoadresse (kein Fehler, kein Fehlversand); Reply-To bleibt, Kundenantworten gehen also trotzdem an die Alias-Adresse und müssen
// dort im Jarvis-Postfach ankommen (Weiterleitung/Alias). Cold-Entwürfe und Antworten in Cold-Threads bleiben unverändert.
const SEND_AS_EMAIL_RE = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
let sendAs = null;
export function setSendAs(cfg) {
  const address = String(cfg?.address ?? cfg?.sendAs ?? "").trim().toLowerCase();
  const name = String(cfg?.name ?? "").replace(/[\r\n"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  sendAs = address && SEND_AS_EMAIL_RE.test(address) ? { address, name } : null;
  return sendAs;
}
export const getSendAs = () => sendAs;
const ORDER_ID_RE = /^(CA150|RF480|VNCHECK|VNFIX)-\d{8}-[0-9a-f]{6}$/;

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

// ---------- Read-only Auth-Check (TF-049) ----------
// Prüft, ob Gmail OAuth wirklich funktioniert: Refresh am Token-Endpunkt (nur im Speicher, die Token-Datei bleibt unverändert)
// und genau EIN read-only Aufruf users.getProfile. Nie Senden/Entwurf/Label/Nachricht, nie Inbox-Inhalte. Ergebnis ohne
// Token und ohne Mailadresse: { ok: true } oder { ok: false, category } mit category aus AUTH_FAIL_CATEGORIES.
export const AUTH_FAIL_CATEGORIES = Object.freeze(["expired_or_revoked", "missing_token", "missing_credentials", "scope_error", "network_error", "unknown_auth_error"]);
export async function checkAuth({ secretsDir = SECRETS, fetchFn = (...a) => fetch(...a), timeoutMs = 20_000 } = {}) {
  const fail = (category) => ({ ok: false, category });
  const raw = readJson(path.join(secretsDir, "gmail_credentials.json"), null);
  const client = raw?.installed || raw?.web;
  if (!client?.client_id) return fail("missing_credentials");
  const t = readJson(path.join(secretsDir, "gmail_token.json"), null);
  if (!t?.refresh_token) return fail("missing_token");
  if (t.scope && !SCOPES.every((s) => String(t.scope).split(/\s+/).includes(s))) return fail("scope_error");
  let r, body;
  try {
    r = await fetchFn(client.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST", signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret || "", grant_type: "refresh_token", refresh_token: t.refresh_token }),
    });
    body = await r.json().catch(() => ({}));
  } catch { return fail("network_error"); }
  if (!r.ok) {
    const e = String(body?.error || "");
    if (e === "invalid_grant") return fail("expired_or_revoked");
    if (e === "invalid_client" || e === "unauthorized_client") return fail("missing_credentials");
    if (e === "invalid_scope") return fail("scope_error");
    return fail(r.status === 429 || r.status >= 500 ? "network_error" : "unknown_auth_error");
  }
  if (!body?.access_token) return fail("unknown_auth_error");
  if (body.scope && !SCOPES.every((s) => String(body.scope).split(/\s+/).includes(s))) return fail("scope_error");
  try {
    r = await fetchFn(API + "/profile", { method: "GET", signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${body.access_token}` } });
    body = await r.json().catch(() => ({}));
  } catch { return fail("network_error"); }
  if (r.ok) return body?.historyId || body?.emailAddress ? { ok: true } : fail("unknown_auth_error");
  if (r.status === 401) return fail("expired_or_revoked");
  if (r.status === 403) return fail(/scope|insufficient/i.test(String(body?.error?.message || "")) ? "scope_error" : "unknown_auth_error");
  return fail(r.status === 429 || r.status >= 500 ? "network_error" : "unknown_auth_error");
}

// Quota-Schutz (TF-037): Gmail zählt „Total Query Cost / Units per minute per user“ – eine ununterbrochene Call-Salve
// (z. B. hunderte drafts.get) reisst das Limit. Deshalb zentral für JEDEN Gmail-Call: Mindestabstand zwischen zwei Calls
// (Default 150 ms ≈ max. 6–7 Calls/s) und bei 429/Quota-Fehlern Retry-After respektieren (begrenzt, nie enge Schleife).
export const GMAIL_QUOTA_RE = /quota|rate ?limit|\b429\b/i;
export const isGmailQuotaError = (e) => e?.gmailQuota === true || GMAIL_QUOTA_RE.test(String(e?.message || ""));
const GMAIL_MIN_GAP_MS = Math.max(0, Number(process.env.JARVIS_GMAIL_MIN_GAP_MS ?? 150));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastGmailCallAt = 0;

async function gmail(method, route, body) {
  for (let attempt = 0; ; attempt++) {
    const wait = lastGmailCallAt + GMAIL_MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastGmailCallAt = Date.now();
    const r = await fetch(API + route, {
      method, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${await accessToken()}`, ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : {};
    if (r.ok) return data;
    const msg = data.error?.message || r.status;
    const quota = r.status === 429 || GMAIL_QUOTA_RE.test(String(msg));
    // Quota/429: höchstens 2 Wiederholungen, Wartezeit aus Retry-After (sonst 2 s · 2^n), nie länger als 30 s –
    // danach Fehler mit Quota-Kennung, damit der Aufrufer in den Backoff geht statt weiterzuhämmern.
    if (quota && attempt < 2) {
      const ra = Number(r.headers.get("retry-after"));
      await sleep(Math.min(30_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt));
      continue;
    }
    const err = new Error(`Gmail ${method} ${route}: ${msg}`);
    err.status = r.status;
    if (quota) err.gmailQuota = true;
    throw err;
  }
}

// ---------- Persistenter Gmail-Sync-State (TF-037, nie Tokens) ----------
// .secrets/gmail_sync_state.json: { history_id, cold_cursor, last_cold_sync_at, last_history_sync_at, history_recovered_at }
// Nach einem VPS-Neustart geht der inkrementelle Sync exakt dort weiter; Verlust der Datei ist harmlos (Neuaufbau).
const SYNC_STATE_FILE = path.join(SECRETS, "gmail_sync_state.json");
export const loadSyncState = () => readJson(SYNC_STATE_FILE, {});
export const saveSyncState = (patch) => { const next = { ...loadSyncState(), ...patch }; writeSecret(SYNC_STATE_FILE, next); return next; };

// Inkrementeller Sync über die Gmail-History-API (2 Quota-Units je Seite statt Vollscan): liefert NUR Thread-IDs mit neuen
// Nachrichten seit sinceHistoryId. Gelesen wird weiterhin ausschliesslich über readThread (eigene Threads, Register-Prüfung) –
// fremde Threads werden hier nie geöffnet. Ungültige/abgelaufene historyId → { invalid: true, historyId: <frisch> } (Recovery:
// der begrenzte Round-Robin-Scan deckt die Lücke ab, KEIN Vollscan).
export async function changedThreadIds({ sinceHistoryId = null, maxPages = 3 } = {}) {
  if (!sinceHistoryId) { const p = await gmail("GET", "/profile"); return { threadIds: [], historyId: String(p.historyId), initial: true }; }
  const ids = new Set();
  let pageToken = null, newest = String(sinceHistoryId);
  try {
    for (let i = 0; i < maxPages; i++) {
      const q = new URLSearchParams({ startHistoryId: String(sinceHistoryId), historyTypes: "messageAdded", maxResults: "100", ...(pageToken ? { pageToken } : {}) });
      const r = await gmail("GET", `/history?${q}`);
      for (const h of r.history || []) for (const m of h.messagesAdded || []) if (m.message?.threadId) ids.add(m.message.threadId);
      if (r.historyId) newest = String(r.historyId);
      pageToken = r.nextPageToken || null;
      if (!pageToken) break;
    }
  } catch (e) {
    // Abgelaufene/ungültige startHistoryId meldet Gmail als 404 – Quota-/Netzfehler (429/5xx) werden hier NICHT verschluckt.
    if (e.status === 404) { const p = await gmail("GET", "/profile"); return { threadIds: [], historyId: String(p.historyId), invalid: true }; }
    throw e;
  }
  return { threadIds: [...ids], historyId: newest, truncated: !!pageToken };
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
export function rawMessage({ to, subject = "", body = "", inReplyTo = "", references = "", from = null }) {
  if (!to) throw new Error("Empfänger (--to) fehlt.");
  if (/[\r\n]/.test(to + subject + inReplyTo + references)) throw new Error("Zeilenumbrüche in Empfänger oder Betreff sind nicht erlaubt.");
  const mime = [
    ...(from ? [`From: ${from.name ? `${encodeHeader(from.name)} <${from.address}>` : from.address}`, `Reply-To: ${from.address}`] : []),
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
  // TF-081: Absender-Alias nur für Kundenmails (Kontaktformular-Antworten, Service-Klassen) – nie für Cold-Entwürfe.
  const customerFacing = [CONTACT_FORM_DRAFT_MODE, CONTACT_FORM_AUTO_REPLY_MODE].includes(fields.mode) || SERVICE_MESSAGE_CLASSES.includes(fields.messageClass);
  const draft = await gmail("POST", "/drafts", { message: { raw: rawMessage({ ...fields, from: customerFacing ? sendAs : null }), ...(fields.threadId && { threadId: fields.threadId }) } });
  if (fields.threadId && draft.message?.threadId !== fields.threadId) await discardMismatch(draft.id, fields.threadId);
  const info = await labelAndDescribe(draft.message.id, lid);
  if (fields.threadId && info.threadId !== fields.threadId) await discardMismatch(draft.id, fields.threadId);
  const reply = fields.inReplyTo ? { inReplyTo: fields.inReplyTo, references: fields.references } : {};
  const cold = fields.mode === COLD_DRAFT_MODE ? { mode: COLD_DRAFT_MODE, leadId: fields.leadId || null, draftHash: fields.draftHash || null, legalBasis: "NONE" }
    : [CONTACT_FORM_DRAFT_MODE, CONTACT_FORM_AUTO_REPLY_MODE].includes(fields.mode) ? { mode: fields.mode, contactFormKey: String(fields.contactFormKey || "").slice(0, 40) || null, messageClass: "CONTACT_FORM_INQUIRY" } : {};
  // Service-Mails bezahlter Kundenaufträge (TF-041) tragen ihre Nachrichtenklasse – nie zusammen mit einem Cold-Entwurf.
  const service = !cold.mode && SERVICE_MESSAGE_CLASSES.includes(fields.messageClass) ? { messageClass: fields.messageClass,
    ...(ORDER_ID_RE.test(String(fields.orderId || "")) ? { orderId: fields.orderId } : {}) } : {}; // TF-066: Auftrag des Service-Threads
  updateRegistry((r) => { r.drafts[draft.id] = { ...info, to: fields.to, subject: fields.subject || "", ...reply, ...cold, ...service, createdAt: new Date().toISOString() }; });
  return { draftId: draft.id, ...info };
}

export async function updateDraft(draftId, fields) {
  const reg = loadRegistry();
  const { entry } = await assertOwnedDraft(draftId, reg);
  const merged = { to: fields.to ?? entry.to, subject: fields.subject ?? entry.subject, body: fields.body ?? "", inReplyTo: entry.inReplyTo, references: entry.references };
  const customerFacing = [CONTACT_FORM_DRAFT_MODE, CONTACT_FORM_AUTO_REPLY_MODE].includes(entry.mode) || SERVICE_MESSAGE_CLASSES.includes(entry.messageClass);
  const draft = await gmail("PUT", `/drafts/${encodeURIComponent(draftId)}`, { message: { raw: rawMessage({ ...merged, from: customerFacing ? sendAs : null }), threadId: entry.threadId } });
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
  if (reg.drafts?.[draftId]?.mode === CONTACT_FORM_DRAFT_MODE) throw new Error(`Entwurf ${draftId} ist eine Kontaktformular-Antwort (CONTACT_FORM_DRAFT_ONLY) – Jarvis sendet sie nie. Nur Chris sendet manuell in Gmail.`);
};
export const sendDraft = async (draftId, { window = null } = {}) => { assertSendable(draftId); return withSendLock(() => { assertSendable(draftId); return sendOwned(draftId, { window }); }); };

// TF-077B SEND_PREPARED_LEAD_DRAFT: der EINZIGE Weg, auf dem Jarvis einen Cold-Lead-Entwurf sendet – nur auf ausdrücklichen Klick eines
// berechtigten Verkäufers («E-Mail lossenden», je Klick genau ein Lead; Mail-Worker hat Bereich, Suppression, DNC und Send-Lock geprüft).
// Hier zusätzlich: Entwurf von Jarvis (Register + Label + IDs), Modus COLD_LEAD_DRAFT_ONLY, gehört genau diesem Lead, Empfänger = CRM-Adresse,
// Referenz = aktuelle Message-ID (ein geänderter Entwurf wird nie mit einer alten Referenz gesendet). Gmail verbraucht den Entwurf beim
// Senden – ein zweiter Aufruf scheitert an assertOwnedDraft, es entsteht nie eine zweite Mail.
export const sendPreparedLeadDraft = (draftId, { leadId, to, draftRef: ref, refOf, actor = null } = {}) => withSendLock(async () => {
  const entry = loadRegistry().drafts?.[draftId];
  const norm = (s) => (String(s || "").match(/<([^>]+)>/)?.[1] || String(s || "")).trim().toLowerCase();
  if (!entry || entry.mode !== COLD_DRAFT_MODE) throw new Error(`Entwurf ${draftId} ist kein vorbereiteter Jarvis-Lead-Entwurf – nicht gesendet.`);
  if (!leadId || entry.leadId !== leadId) throw new Error(`Entwurf ${draftId} gehört nicht zu diesem Lead – nicht gesendet.`);
  if (!to || norm(entry.to) !== norm(to)) throw new Error(`Entwurf ${draftId}: Empfänger stimmt nicht mit dem CRM überein – nicht gesendet.`);
  if (typeof refOf !== "function" || !ref || refOf(entry.messageId) !== ref) throw new Error(`Entwurf ${draftId} wurde geändert – nicht gesendet.`);
  return sendOwned(draftId, { extra: { mode: COLD_DRAFT_MODE, leadId, draftRef: ref, sellerSend: true, ...(actor ? { sentBy: String(actor).slice(0, 20) } : {}), legalBasis: "NONE" } });
});

async function sendOwned(draftId, { window = null, extra = {} } = {}) {
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
    r.sent[sent.id] = { ...info, to: entry.to, subject: entry.subject, fromDraft: draftId, ...(window && { window }),
      ...(entry.messageClass ? { messageClass: entry.messageClass } : {}), ...(entry.orderId ? { orderId: entry.orderId } : {}),
      ...(entry.mode === CONTACT_FORM_AUTO_REPLY_MODE ? { mode: entry.mode, contactFormKey: entry.contactFormKey || null } : {}), ...extra, sentAt: new Date().toISOString() };
  });
  return info;
}

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
// TF-037: NICHT mehr alle Cold-Entwürfe je Durchlauf prüfen (bei hunderten Entwürfen war das eine Quota-Salve), sondern
// höchstens `max` je Aufruf über einen persistenten Round-Robin-Cursor (gmail_sync_state.json). Jeder Entwurf kommt
// spätestens nach ceil(n/max) Durchläufen wieder dran; ein manueller Versand wird also weiterhin erkannt, nur etwas später.
// Bricht ein Quota-Fehler die Runde ab, bleibt der Cursor auf dem letzten fertig geprüften Entwurf stehen – kein Neubeginn.
export async function syncColdDrafts({ max = 40 } = {}) {
  const all = Object.entries(loadRegistry().drafts || {}).filter(([, e]) => e.mode === COLD_DRAFT_MODE).sort(([a], [b]) => a.localeCompare(b));
  if (!all.length) return [];
  const st = loadSyncState();
  let start = all.findIndex(([id]) => id > String(st.cold_cursor || ""));
  if (start < 0) start = 0; // Cursor hinter dem letzten Eintrag → wieder vorne beginnen
  const batch = [];
  for (let i = 0; i < Math.min(Math.max(1, max), all.length); i++) batch.push(all[(start + i) % all.length]);
  const out = [];
  let cursor = st.cold_cursor || "";
  try {
    for (const [draftId, e] of batch) {
      await syncOneColdDraft(draftId, e, out);
      cursor = draftId;
    }
  } finally {
    saveSyncState({ cold_cursor: cursor, last_cold_sync_at: new Date().toISOString() });
  }
  return out;
}
async function syncOneColdDraft(draftId, e, out) {
  {
    const exists = await gmail("GET", `/drafts/${encodeURIComponent(draftId)}?format=minimal`).then(() => true, (err) => {
      if (/not found|404/i.test(err.message)) return false;
      throw err;
    });
    if (exists) return;
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
export async function replyToThread(threadId, { body, mode } = {}) {
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
    to, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, body, threadId, ...(mode ? { mode } : {}),
    inReplyTo: last?.rfcMessageId || "", references: [last?.references, last?.rfcMessageId].filter(Boolean).join(" "),
  });
  return { ...draft, to };
}

// TF-066: Antwort-Entwurf einer Service-Klasse im EIGENEN Auftrags-Thread. Anders als replyToThread wird der Empfänger NICHT aus
// dem Thread abgeleitet, sondern ist fest vorgegeben (bestätigte Kundenadresse des Auftrags). Thread-Besitz wird wie bei readThread
// geprüft (Register + Gmail); landet der Entwurf nicht im Thread, wird er verworfen. Gesendet wird nur über sendDraft.
export async function replyDraftInThread(threadId, { to, body, messageClass, orderId = null } = {}) {
  if (!SERVICE_MESSAGE_CLASSES.includes(messageClass)) throw new Error("Nur Service-Nachrichten im Auftrags-Thread.");
  if (!to || !body) throw new Error("Empfänger oder Text fehlt.");
  const { own, messages } = await fetchOwnedThread(threadId, loadRegistry());
  const mails = messages.filter((m) => !m.draft);
  const last = mails.at(-1);
  const subject = own[0]?.subject || last?.subject || "";
  return createDraft({ to, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, body, threadId, messageClass, orderId,
    inReplyTo: last?.rfcMessageId || "", references: [last?.references, last?.rfcMessageId].filter(Boolean).join(" ") });
}

// ---------- TF-075A: Kontaktformular-Benachrichtigungen (nur Allowlist-Anbieter) ----------
// Einzige Ausnahme von „nur eigene Threads lesen“: Benachrichtigungen bekannter Formular-Anbieter. Die Suchanfrage baut
// contact-form.js ausschliesslich aus der Anbieter-Allowlist (from:(…) newer_than:…); hier wird sie zusätzlich geprüft.
// Gelesen wird nur, was die Suche liefert und dessen From exakt in der Anfrage steht. Nie Label/Ändern/Löschen fremder Mails.
const INBOUND_QUERY_RE = /^from:\(([a-z0-9.!#$%&'*+/=?^_`{|}~@-]+(?: OR [a-z0-9.!#$%&'*+/=?^_`{|}~@-]+)*)\) -in:sent -in:drafts -in:spam -in:trash newer_than:\d{1,2}d$/i;
let inboundAllow = new Set();
export async function searchInbound({ query, max = 20 } = {}) {
  const m = String(query || "").match(INBOUND_QUERY_RE);
  if (!m) throw new Error("Kontaktformular-Suche nur mit Allowlist-Anfrage.");
  // TF-077D: erst (case-insensitiv) splitten, dann normalisieren – toLowerCase() vor split(" OR ") liess Mehr-Anbieter-Anfragen
  // als einen einzigen String stehen, sodass kein Absender mehr exakt passte.
  inboundAllow = new Set(m[1].split(/\s+OR\s+/i).map((x) => x.trim().toLowerCase()).filter(Boolean));
  const q = new URLSearchParams({ q: query, maxResults: String(Math.max(1, Math.min(100, Number(max) || 20))) });
  const r = await gmail("GET", `/messages?${q}`);
  return (r.messages || []).map((x) => x.id).filter(Boolean);
}
const INBOUND_HEADERS = new Set(["from", "reply-to", "to", "delivered-to", "subject", "date", "message-id", "authentication-results"]);
export async function readInbound(messageId) {
  if (!/^[0-9a-f]{8,32}$/i.test(String(messageId || ""))) throw new Error("Message-ID ungültig.");
  const m = await gmail("GET", `/messages/${encodeURIComponent(messageId)}?format=full`);
  const d = describeMessage(m);
  const from = (d.from.match(/<([^>]+)>/)?.[1] || d.from).trim().toLowerCase();
  if (!inboundAllow.has(from)) throw new Error("Nachricht stammt nicht von einem Allowlist-Formular-Anbieter – nicht gelesen.");
  if (d.sent || d.draft) throw new Error("Keine eingehende Nachricht.");
  const headers = {};
  for (const h of m.payload?.headers || []) {
    const k = h.name.toLowerCase();
    if (!INBOUND_HEADERS.has(k)) continue;
    if (k === "authentication-results") (headers[k] ||= []).push(h.value); else headers[k] ??= h.value; // Reihenfolge erhalten: oberster = Gmail
  }
  return { ...d, threadId: m.threadId, deliveredTo: headers["delivered-to"] || "", headers };
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
    // TF-049: read-only (Refresh im Speicher + users.getProfile) – gibt nur den Status aus, nie Token oder Mailadresse.
    check: async () => { const r = await checkAuth(); if (!r.ok) process.exitCode = 1; return r.ok ? "MAIL AUTH READY" : `MAIL AUTH FAIL (${r.category})`; },
    draft: () => createDraft({ to: f.to, subject: f.subject, body: f.body }),
    update: () => updateDraft(f._[0], { to: f.to, subject: f.subject, body: f.body }),
    send: () => sendDraft(f._[0]),
    list: listOwned,
    thread: () => readThread(f._[0]),
    reply: () => replyToThread(f._[0], { body: f.body }),
  }[cmd];
  if (!run) {
    console.log("Befehle: auth | check | draft --to --subject --body | update <draftId> [...] | send <draftId> | list | thread <threadId> | reply <threadId> --body");
    process.exit(1);
  }
  Promise.resolve(run()).then(
    (r) => console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2)),
    (e) => { console.error("Fehler: " + e.message); process.exit(1); },
  );
}
