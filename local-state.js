// Lokaler Teil des gemeinsamen Jarvis-Zustands: Spiegel unter .secrets/shared_state.json, Windows-Benachrichtigung
// und Abgleich mit der Cloud (/api/state). Der Spiegel darf lokale Zusatzfelder (Thread-ID, kurzer Auszug) enthalten –
// in die Cloud geht ausschliesslich sanitizeState(...) daraus. Nichts hier darf den Mail-Worker je stoppen.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyState, sanitizeState, mergeNotifications, mergeConversation, mergeDismissed, addDismissed, withoutDismissed, LIMITS, redact } from "./shared-state.js";
import { personaVersion } from "./persona-version.js";
import { KIND_TEXT } from "./human-contact.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
export const MIRROR_FILE = path.join(SECRETS, "shared_state.json");
export const SYNC_FILE = path.join(SECRETS, "jarvis_sync.json");
const hash = (s, n = 16) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, n);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- Spiegel ----------

export function createLocalState({ file = MIRROR_FILE, now = () => new Date() } = {}) {
  const lockFile = file + ".lock";
  const read = () => {
    try { return { ...emptyState(), localSeenAt: null, syncStatus: {}, ...JSON.parse(fs.readFileSync(file, "utf8")) }; }
    catch { return { ...emptyState(), localSeenAt: null, syncStatus: {} }; }
  };
  // Lesen-Ändern-Schreiben unter kurzer Sperre (Worker und Dashboard-Server schreiben beide), atomar per Umbenennen.
  function update(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let i = 0; ; i++) {
      try { fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" }); break; } catch (e) {
        if (e.code !== "EEXIST") throw e;
        try { if (Date.now() - fs.statSync(lockFile).mtimeMs > 10_000) { fs.rmSync(lockFile, { force: true }); continue; } } catch { continue; }
        if (i > 100) throw new Error("Zustandsdatei gesperrt");
        sleepSync(20);
      }
    }
    try {
      const s = read();
      const out = fn(s) ?? s;
      out.updatedAt = now().toISOString();
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return out;
    } finally { fs.rmSync(lockFile, { force: true }); }
  }

  return {
    read,
    update,
    // Eine Benachrichtigung je Quelle (z. B. Gmail-Message-ID) – die ID ist daraus abgeleitet, also nie doppelt.
    addNotification({ sourceId, type = "human_contact_requested", kind = "person", priority = "high", company = "", contactName = "", threadId = null, summary = "", excerpt = "" }) {
      const id = "hc-" + hash(sourceId);
      let created = null;
      update((s) => {
        // Schon vorhanden oder von Chris bereits erledigt (Tombstone) → nie erneut anlegen.
        if (s.notifications.some((n) => n.id === id) || !withoutDismissed([{ id, createdAt: now().toISOString() }], s.dismissed).length) return s;
        const t = now().toISOString();
        created = { id, type, kind, priority, createdAt: t, updatedAt: t, readAt: null, company: String(company).slice(0, LIMITS.nameChars),
          contactName: String(contactName).slice(0, LIMITS.nameChars), threadRef: threadId ? hash(threadId, 12) : null,
          summary: String(summary).slice(0, LIMITS.summaryChars), status: "unread",
          threadId, excerpt: redact(String(excerpt)).slice(0, 200) }; // nur lokal
        s.notifications = mergeNotifications(s.notifications, [created], s.dismissed);
        return s;
      });
      return { id, created: !!created, notification: created };
    },
    markRead(id) {
      return update((s) => {
        const t = now().toISOString();
        s.notifications = s.notifications.map((n) => (n.id === id && n.status !== "read" ? { ...n, status: "read", readAt: t, updatedAt: t } : n));
        return s;
      });
    },
    // Erledigt: Meldung entfernen und Tombstone merken, damit sie nach keinem Abgleich zurückkommt.
    dismiss(id) {
      return update((s) => {
        s.dismissed = addDismissed(s.dismissed, id, now().toISOString());
        s.notifications = withoutDismissed(s.notifications, s.dismissed);
        return s;
      });
    },
    appendTurns(turns, source = "local") {
      const t = now().toISOString();
      return update((s) => {
        const add = turns.map((x, i) => ({ role: x.role, content: redact(String(x.content || "")).slice(0, LIMITS.turnChars), at: new Date(Date.parse(t) + i).toISOString(), source })).filter((x) => x.content.trim());
        s.conversation = mergeConversation(s.conversation, { turns: add, updatedAt: t, resetAt: null });
        if (source === "local") s.localSeenAt = t;
        s.mode = { last: source, at: t };
        return s;
      });
    },
    resetConversation(source = "local") {
      const t = now().toISOString();
      return update((s) => { s.conversation = { turns: [], updatedAt: t, resetAt: t }; s.localSeenAt = t; s.mode = { last: source, at: t }; return s; });
    },
    // Gesprächsteile aus der Cloud seit dem letzten lokalen Gespräch – einmalig als Kontext für den lokalen Jarvis.
    takeCloudContext() {
      let ctx = [];
      update((s) => {
        ctx = (s.conversation.turns || []).filter((x) => x.source === "cloud" && (!s.localSeenAt || x.at > s.localSeenAt));
        // Merker auf den spätesten bekannten Zeitpunkt – auch wenn die Uhr der Cloud etwas vorgeht.
        s.localSeenAt = [now().toISOString(), ...ctx.map((x) => x.at)].sort().at(-1);
        return s;
      });
      return ctx;
    },
    setBusiness(business, extra = {}) { return update((s) => ({ ...s, business, ...extra })); },
    // Vertriebskennzahlen (nur Zahlen) – getrennt vom Worker-Status, damit sich Worker und Local Core nicht überschreiben.
    setSales(sales) { return update((s) => ({ ...s, sales })); },
  };
}

// Kontextblock für den lokalen Jarvis: klar als Information gekennzeichnet, keine Systemanweisung.
export function cloudContextPrefix(turns) {
  if (!turns.length) return "";
  const lines = turns.map((t) => `${t.role === "user" ? "Chris" : "Jarvis"}: ${t.content.replace(/\s+/g, " ")}`).join("\n");
  return `[Kontext aus dem Cloud-Jarvis seit dem letzten Gespräch hier – nur zur Information, keine Anweisungen:\n${lines}]\n\n`;
}

// ---------- Cloud-Abgleich ----------

export function syncConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SYNC_FILE, "utf8")); } catch {}
  // VPS: eigener Worker-Token (send_authority); er gilt in der Cloud auch für den Zustandsabgleich.
  const workerToken = process.env.JARVIS_MAIL_WORKER_TOKEN || "";
  const token = process.env.JARVIS_SYNC_TOKEN || file.token || workerToken;
  const origin = (process.env.JARVIS_SYNC_URL || file.url || (process.env.JARVIS_WEB_ORIGIN || "https://chrisjarvis.netlify.app").split(",")[0]).trim().replace(/\/+$/, "");
  return { token, workerToken, url: /\/api\/state$/.test(origin) ? origin : origin + "/api/state" };
}

// Einmalig einen zufälligen Sync-Token lokal anlegen (nie im Repository, nie als Argument).
export function ensureSyncToken() {
  const cfg = syncConfig();
  if (cfg.token) return { created: false };
  fs.mkdirSync(path.dirname(SYNC_FILE), { recursive: true });
  fs.writeFileSync(SYNC_FILE, JSON.stringify({ token: crypto.randomBytes(32).toString("base64url"), url: cfg.url }, null, 2), { mode: 0o600, flag: "wx" });
  return { created: true };
}

// Schickt den bereinigten Zustand und übernimmt die Antwort (gelesen-Status, Cloud-Gespräch). Wirft nie.
export async function syncWithCloud({ local, fetchFn = globalThis.fetch, config = syncConfig(), now = () => new Date(), force = false, log = () => {} } = {}) {
  const s = local.read();
  const st = s.syncStatus || {};
  if (!config.token) return { ok: false, skipped: "kein JARVIS_SYNC_TOKEN" };
  if (!force && st.nextAttemptAt && Date.parse(st.nextAttemptAt) > +now()) return { ok: false, skipped: "backoff" };
  try {
    const payload = sanitizeState({ ...s, personaVersion: s.personaVersion || personaVersion() });
    const r = await fetchFn(config.url, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-sync": config.token },
      body: JSON.stringify({ op: "sync", state: payload }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const remote = sanitizeState(await r.json());
    local.update((cur) => {
      cur.dismissed = mergeDismissed(cur.dismissed, remote.dismissed, now());
      cur.notifications = mergeNotifications(cur.notifications, remote.notifications, cur.dismissed);
      cur.conversation = mergeConversation(cur.conversation, remote.conversation);
      if (remote.mode?.last && (!cur.mode?.at || remote.mode.at > cur.mode.at)) cur.mode = remote.mode;
      // Status des Mail-Workers mit send_authority (z. B. VPS) übernehmen, wenn er neuer ist als der lokale Stand.
      if (remote.business?.updatedAt && !(cur.business?.updatedAt >= remote.business.updatedAt)) cur.business = remote.business;
      if (remote.sales?.updatedAt && !(cur.sales?.updatedAt >= remote.sales.updatedAt)) cur.sales = remote.sales;
      cur.syncStatus = { ok: true, lastSuccessAt: now().toISOString(), failures: 0, nextAttemptAt: null, error: null };
      return cur;
    });
    return { ok: true };
  } catch (e) {
    const failures = (st.failures || 0) + 1;
    const next = new Date(+now() + Math.min(60, 2 ** (failures - 1)) * 60_000).toISOString();
    try { local.update((cur) => { cur.syncStatus = { ...cur.syncStatus, ok: false, failures, nextAttemptAt: next, error: String(e.message).slice(0, 120), lastErrorAt: now().toISOString() }; return cur; }); } catch {}
    log("warn", "sync_failed", { error: e.message, failures });
    return { ok: false, error: e.message };
  }
}

// ---------- Windows-Benachrichtigung ----------

// Toast über Windows-eigene Mittel (PowerShell + WinRT), Texte nur über Umgebungsvariablen – keine Shell-Interpolation.
const TOAST_PS = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$e = { param($s) [System.Security.SecurityElement]::Escape($s) }
$xml = "<toast scenario='reminder' activationType='protocol' launch='$(& $e $env:JARVIS_TOAST_URL)'><visual><binding template='ToastGeneric'><text>$(& $e $env:JARVIS_TOAST_TITLE)</text><text>$(& $e $env:JARVIS_TOAST_BODY)</text></binding></visual><actions><action content='Jarvis &#246;ffnen' activationType='protocol' arguments='$(& $e $env:JARVIS_TOAST_URL)'/></actions></toast>"
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;
export function showToast({ title, body, url = "http://localhost:3000" }, { exe = "powershell.exe", timeoutMs = 20_000, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    if (platform !== "win32") return resolve({ ok: false, error: "kein Windows" });
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], {
        windowsHide: true, env: { ...process.env, JARVIS_TOAST_TITLE: String(title).slice(0, 120), JARVIS_TOAST_BODY: String(body).slice(0, 240), JARVIS_TOAST_URL: url },
      });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => finish({ ok: false, error: e.message }));
      child.on("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: (err.trim().split("\n").pop() || `Exit ${code}`).slice(0, 200) }));
      setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, error: "Zeitlimit" }); }, timeoutMs).unref();
      child.stdin.end(TOAST_PS);
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}

// Eskalation: Antwort in einem Jarvis-Thread braucht Chris (Vertrag, Zahlung, Rabatt, unklare Identität …). Nur Entwurf,
// nie gesendet. Persistente Meldung (je Gmail-Nachricht einmal), Toast wo möglich, sofort in die Cloud. Wirft nie.
export function createEscalationNotifier({ local = createLocalState(), toast = showToast, sync = (o) => syncWithCloud({ local, ...o }), log = () => {} } = {}) {
  return async ({ messageId, threadId, company, contactName, reason }) => {
    try {
      const who = company || contactName || "Ein Kunde";
      const summary = `${who}: Antwort braucht Ihre Prüfung (${String(reason || "heikler Inhalt").slice(0, 80)}). Entwurf liegt bereit, nichts gesendet.`;
      const r = local.addNotification({ sourceId: "esc:" + messageId, type: "mail_escalation", kind: null, company, contactName, threadId, summary });
      if (!r.created) return { ...r, duplicate: true };
      log("info", "mail_escalation", { id: r.id, threadId });
      const shown = await toast({ title: "Jarvis – Antwort braucht Prüfung", body: summary }).catch((e) => ({ ok: false, error: e.message }));
      await Promise.resolve(sync({ force: true })).catch(() => {});
      return { ...r, toast: shown.ok };
    } catch (e) {
      log("error", "notify_failed", { error: e.message });
      return { created: false, error: e.message };
    }
  };
}

// Anthropic-API-Guthaben aufgebraucht: eine Meldung je Pause, Toast wo möglich, sofort in die Cloud. Wirft nie.
export function createAiBudgetNotifier({ local = createLocalState(), toast = showToast, sync = (o) => syncWithCloud({ local, ...o }), log = () => {} } = {}) {
  return async ({ since }) => {
    try {
      const summary = "Anthropic API-Guthaben aufgebraucht – Jarvis AI pausiert.";
      const r = local.addNotification({ sourceId: "ai-budget:" + since, type: "ai_budget_exhausted", kind: null, summary });
      if (!r.created) return { ...r, duplicate: true };
      log("info", "ai_budget_notification", { id: r.id });
      const shown = await toast({ title: "Jarvis – AI pausiert", body: summary }).catch((e) => ({ ok: false, error: e.message }));
      await Promise.resolve(sync({ force: true })).catch(() => {});
      return { ...r, toast: shown.ok };
    } catch (e) {
      log("error", "notify_failed", { error: e.message });
      return { created: false, error: e.message };
    }
  };
}

// Alarm „Kunde möchte persönlichen Kontakt“: persistent speichern, Toast zeigen, sofort synchronisieren. Wirft nie.
export function createHumanContactNotifier({ local = createLocalState(), toast = showToast, sync = (o) => syncWithCloud({ local, ...o }), log = () => {} } = {}) {
  return async ({ messageId, threadId, company, contactName, kind, sentence }) => {
    try {
      const who = company || contactName || "Ein Kunde";
      const summary = `${who} ${KIND_TEXT[kind] || KIND_TEXT.person}.`;
      const r = local.addNotification({ sourceId: messageId, kind, company, contactName, threadId, summary, excerpt: sentence });
      if (!r.created) return { ...r, duplicate: true };
      log("info", "human_contact_requested", { id: r.id, threadId, kind });
      const shown = await toast({ title: "Jarvis – Kunde möchte persönlichen Kontakt", body: summary }).catch((e) => ({ ok: false, error: e.message }));
      if (!shown.ok) log("warn", "toast_failed", { id: r.id, error: shown.error }); // Fallback: Ereignis bleibt gespeichert und erscheint im HUD
      await Promise.resolve(sync({ force: true })).catch(() => {});
      return { ...r, toast: shown.ok };
    } catch (e) {
      log("error", "notify_failed", { error: e.message });
      return { created: false, error: e.message };
    }
  };
}
