// Kundenalarm (Telefonat/persönlicher Kontakt) und gemeinsamer Zustand Lokal ↔ Cloud.
// Ohne Netzwerk: Netlify Blobs, Cloud-Endpunkt, Gmail, Toast und Claude-API sind Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { detectHumanContact } from "../human-contact.js";
import { createStateHandler, memoryStore, sanitizeState, mergeNotifications, findSensitiveKeys } from "../shared-state.js";
import { createLocalState, createHumanContactNotifier, syncWithCloud, cloudContextPrefix, showToast } from "../local-state.js";
import { createWorker } from "../mail-worker.js";
import { personaVersion } from "../persona-version.js";
import { render as renderPersona, cloudPersona } from "../scripts/build-persona.mjs";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const T0 = new Date("2026-10-06T08:00:00Z");
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-test-token" };

// ---------- 1–4: Erkennung ----------

test("Telefon-/Kontaktwunsch wird erkannt (Deutsch und Englisch)", () => {
  for (const [t, kind] of [
    ["Können wir telefonieren?", "call"], ["Rufen Sie mich bitte an.", "call"], ["Let's schedule a call.", "call"],
    ["Können Sie mich anrufen?", "call"], ["Ich würde gerne persönlich sprechen.", "person"], ["Können wir einen Termin vereinbaren?", "meeting"],
    ["Können wir kurz sprechen?", "person"], ["Haben Sie Zeit für ein Telefonat?", "call"], ["Ich möchte mit jemandem persönlich sprechen.", "person"],
    ["Kann mich jemand kontaktieren?", "person"], ["Bitte um Rückruf.", "call"], ["Was ist Ihre Telefonnummer?", "call"],
    ["Wann passt Ihnen eine Besprechung?", "meeting"], ["Meeting next week?", "meeting"], ["Can we have a call?", "call"], ["Please call me.", "call"],
    ["I'd like to speak with you.", "person"], ["I want to speak to a person.", "person"], ["Can we book a call?", "call"], ["Callback please.", "call"],
  ]) assert.equal(detectHumanContact(t)?.kind, kind, t);
});

test("harmlose Erwähnungen lösen keinen Alarm aus", () => {
  for (const t of [
    "Die Telefonnummer auf unserer Website ist falsch.", "My phone was broken, sorry for the late reply.", "Kein Anruf nötig, bitte per Mail.",
    "Please don't call me, email is fine.", "Wir hatten gestern eine Besprechung dazu.", "Der Call-to-Action-Button ist zu klein.",
    "Die Mobilansicht auf dem Smartphone ist gut.", "Danke für die Infos, ich melde mich.", "We discussed this in our meeting yesterday.",
  ]) assert.equal(detectHumanContact(t), null, t);
});

// ---------- Worker: Alarm, Eskalation, keine Doppelalarme ----------

let dir, local, toasts, syncs, g;
function fakeGmail(replyBody, messageId = "in-1") {
  const f = { reg: { drafts: {}, sent: { s1: { messageId: "s1", threadId: "t1", to: "anna@muster.ch", subject: "Website", sentAt: new Date(+T0 - 86400e3).toISOString() } } }, calls: [], n: 0 };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async readThread(id) {
      f.calls.push("read " + id);
      if (id !== "t1") throw new Error("nicht von Jarvis begonnen");
      return { threadId: id, messages: [
        { messageId: "s1", from: "Chris <chris@x.ch>", to: "anna@muster.ch", subject: "Website", body: "Hallo", sent: true, draft: false, internalDate: +T0 - 86400e3 },
        { messageId, from: "Anna Muster <anna@muster.ch>", to: "chris@x.ch", subject: "Re: Website", body: replyBody, sent: false, draft: false, internalDate: +T0 - 3600e3 },
      ] };
    },
    async replyToThread(id, { body }) { f.calls.push("reply " + id); const d = "dr" + ++f.n; f.reg.drafts[d] = { threadId: id, to: "anna@muster.ch", body }; return { draftId: d, threadId: id }; },
    async createDraft() { throw new Error("unerwartet"); },
    async updateDraft() { throw new Error("unerwartet"); },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft(id) { f.calls.push("SEND " + id); },
  });
  return f;
}
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const notifier = (extra = {}) => createHumanContactNotifier({ local, toast: async (t) => { toasts.push(t); return { ok: true }; }, sync: async () => { syncs++; return { ok: true }; }, ...extra });
const worker = (notify = notifier(), compose) => createWorker({ dir, gmail: g, now: () => T0, log: () => {}, notify,
  compose: compose || (async () => ({ decision: "draft", body: "Gerne, Chris meldet sich persönlich bei Ihnen." })) });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-shared-"));
  local = createLocalState({ file: path.join(dir, "shared_state.json"), now: () => T0 });
  toasts = []; syncs = 0;
  g = fakeGmail("Danke für die Mail. Können wir nächste Woche telefonieren?");
  write("config.json", { dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" } });
  write("leads.json", [{ email: "anna@muster.ch", company: "Muster AG", approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T00:00:00Z", consentSource: "Formular" }]);
  write("state.json", { compliantThreads: { t1: { to: "anna@muster.ch", basis: "opt_in" } } });
});

test("Telefonwunsch im eigenen Thread: persistente High-Priority-Meldung, Toast, sofortiger Sync, nur Entwurf", async () => {
  let task;
  const r = await worker(undefined, async (t) => { task = t; return { decision: "draft", body: "Gerne, Chris meldet sich persönlich." }; }).tick();
  const n = local.read().notifications;
  assert.equal(n.length, 1);
  assert.deepEqual([n[0].type, n[0].priority, n[0].status, n[0].company, n[0].contactName, n[0].kind], ["human_contact_requested", "high", "unread", "Muster AG", "Anna Muster", "call"]);
  assert.equal(n[0].summary, "Muster AG möchte telefonieren.");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, "Jarvis – Kunde möchte persönlichen Kontakt");
  assert.equal(syncs, 1);
  assert.equal(task.humanContact, "call", "Textgenerator weiss, dass nichts zugesagt werden darf");
  assert.ok(g.calls.includes("review dr1"), "Eskalation: Entwurf zur Prüfung");
  assert.ok(!g.calls.some((c) => c.startsWith("SEND")), "nie automatisch gesendet, obwohl Thread versandberechtigt ist");
  assert.deepEqual(r.humanContacts, [{ threadId: "t1", kind: "call" }]);
});

test("gleiche Message-ID mehrfach und nach Worker-Neustart: nur ein Alarm", async () => {
  await worker().tick();
  fs.rmSync(path.join(dir, "state.json")); // Worker-Zustand verloren (z. B. Absturz) → Nachricht wird erneut gelesen
  write("state.json", { compliantThreads: { t1: { basis: "opt_in" } } });
  local = createLocalState({ file: path.join(dir, "shared_state.json"), now: () => T0 }); // Neustart
  await worker(notifier()).tick();
  await worker(notifier()).tick();
  assert.equal(local.read().notifications.length, 1);
  assert.equal(toasts.length, 1, "kein zweiter Toast");
});

test("Meldung ist persistent und übersteht einen Neustart", async () => {
  await worker().tick();
  const again = createLocalState({ file: path.join(dir, "shared_state.json") });
  assert.equal(again.read().notifications[0].status, "unread");
});

test("Toast-Fehler und Sync-Fehler stoppen den Worker nicht; Meldung bleibt gespeichert", async () => {
  const broken = notifier({ toast: async () => { throw new Error("WinRT fehlt"); }, sync: async () => { throw new Error("offline"); } });
  const r = await worker(broken).tick();
  assert.ok(!r.error);
  assert.equal(local.read().notifications.length, 1);
  const crashing = async () => { throw new Error("kaputt"); };
  const r2 = await worker(crashing).tick();
  assert.ok(!r2.error, "auch ein komplett defekter Notifier stoppt nichts");
  assert.deepEqual(await showToast({ title: "x", body: "y" }, { exe: "gibt-es-nicht-xyz.exe", platform: "win32" }).then((x) => x.ok), false);
});

test("Opt-out hat Vorrang: kein Alarm, Kontakt gesperrt", async () => {
  g = fakeGmail("Bitte nicht mehr kontaktieren. Rufen Sie mich auch nicht an.");
  await worker().tick();
  assert.equal(local.read().notifications.length, 0);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "suppression.json"), "utf8"))["anna@muster.ch"]);
});

test("Alarm auch im Dry-Run, ohne Gmail-Änderung", async () => {
  write("config.json", { dryRun: true });
  await worker().tick();
  assert.equal(local.read().notifications.length, 1);
  assert.ok(!g.calls.some((c) => /^(reply|review|SEND)/.test(c)));
});

// ---------- Cloud-Endpunkt /api/state ----------

const req = (method, body, headers = {}) => new Request("https://jarvis.test/api/state", { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
const asLocal = { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }, asSir = { "x-jarvis-key": ENV.JARVIS_PASSWORD };
let clock = T0;
function cloud(initial = null) {
  clock = T0;
  const store = memoryStore(initial);
  const handler = createStateHandler({ getStore: async () => store, env: (k) => ENV[k], now: () => clock });
  return { store, handler };
}
// Lokaler Sync direkt gegen den Handler (statt HTTP)
const viaHandler = (handler) => async (url, opts) => handler(new Request(url, opts));
const cfg = { url: "https://jarvis.test/api/state", token: ENV.JARVIS_SYNC_TOKEN };

test("Authentifizierung: ohne Schlüssel nichts, Browser darf nicht synchronisieren", async () => {
  const { handler } = cloud();
  assert.equal((await handler(req("GET"))).status, 401);
  assert.equal((await handler(req("GET", null, { "x-jarvis-key": "falsch" }))).status, 401);
  assert.equal((await handler(req("POST", { op: "sync", state: {} }, asSir))).status, 403, "Benachrichtigungen erzeugen nur mit Sync-Token");
  assert.equal((await handler(req("GET", null, asSir))).status, 200);
  const off = createStateHandler({ getStore: async () => memoryStore(), env: () => undefined });
  assert.equal((await off(req("GET", null, { "x-jarvis-key": "" }))).status, 401, "ohne konfigurierte Schlüssel kein Zugriff");
});

test("Cloud speichert keine Secret-Felder; unbekannte sensible Felder werden abgelehnt, Geheimnisse geschwärzt", async () => {
  const { handler, store } = cloud();
  for (const bad of [{ op: "sync", state: { gmail_token: "x" } }, { op: "sync", state: { notifications: [{ id: "hc-1234", threadId: "abc" }] } },
    { op: "sync", state: { business: { apiKey: "x" } } }, { op: "sync", state: { leads: [] } }, { op: "conversation", turns: [], refresh_token: "1//0abc" }]) {
    const r = await handler(req("POST", bad, asLocal));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const ok = await handler(req("POST", { op: "sync", state: { evil: { nested: "x" }, profile: { notes: "Passwort: hunter2 und sk-ant-api03-abcdefghijklmnop", updatedAt: T0.toISOString() },
    notifications: [{ id: "hc-aaaa1111", type: "human_contact_requested", priority: "high", createdAt: T0.toISOString(), summary: "Muster AG möchte telefonieren. C:\\Users\\Administrator\\x", status: "unread", excerpt: "ganzer Mailtext" }] } }, asLocal));
  assert.equal(ok.status, 200);
  const saved = JSON.stringify(store.peek());
  for (const s of ["evil", "hunter2", "sk-ant-api03", "Administrator", "excerpt", "ganzer Mailtext"]) assert.ok(!saved.includes(s), s);
  assert.deepEqual(findSensitiveKeys(store.peek()), []);
  assert.equal((await handler(new Request("https://jarvis.test/api/state", { method: "POST", headers: asLocal, body: "x".repeat(70_000) }))).status, 413);
  assert.equal((await handler(req("POST", { op: "rm -rf /" }, asLocal))).status, 400, "nur erwartete Operationen");
});

test("read lokal → read in der Cloud; read in der Cloud → read lokal; read wird nie wieder unread", async () => {
  const { handler, store } = cloud();
  const a = local.addNotification({ sourceId: "msg-1", company: "Muster AG", summary: "Muster AG möchte telefonieren.", threadId: "t1" });
  const b = local.addNotification({ sourceId: "msg-2", company: "Beta GmbH", summary: "Beta GmbH möchte einen Termin.", threadId: "t2" });
  await syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => T0 });
  assert.equal(store.peek().notifications.length, 2);
  assert.ok(!JSON.stringify(store.peek()).includes('"t1"'), "keine Gmail-Thread-ID in der Cloud");

  local.markRead(a.id); // lokal gelesen
  await syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => T0 });
  assert.equal(store.peek().notifications.find((n) => n.id === a.id).status, "read");

  await handler(req("POST", { op: "read", id: b.id }, asSir)); // in der Cloud gelesen
  await syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => T0 });
  const mine = local.read().notifications;
  assert.equal(mine.find((n) => n.id === b.id).status, "read");
  assert.equal(mine.find((n) => n.id === b.id).threadId, "t2", "lokale Zusatzfelder bleiben lokal erhalten");

  // Ein älterer, ungelesener Stand darf „read“ nicht zurücksetzen
  const merged = mergeNotifications([{ id: "x1", status: "read", updatedAt: "2026-10-06T08:00:00Z", createdAt: "2026-10-06T07:00:00Z", readAt: "2026-10-06T08:00:00Z" }],
    [{ id: "x1", status: "unread", updatedAt: "2026-10-06T09:00:00Z", createdAt: "2026-10-06T07:00:00Z", summary: "neuer" }]);
  assert.equal(merged[0].status, "read");
  assert.equal(merged[0].summary, "neuer", "sonst gewinnt der neuere Stand");
});

test("Gesprächskontext: lokal → Cloud und Cloud → lokal, begrenzt und gekennzeichnet", async () => {
  const { handler, store } = cloud();
  local.appendTurns([{ role: "user", content: "Plane mir die Akquise für Winterthur." }, { role: "assistant", content: "Gerne, Sir. Zuerst Handwerksbetriebe." }], "local");
  await syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => T0 });
  const fromCloud = await (await handler(req("GET", null, asSir))).json();
  assert.deepEqual(fromCloud.conversation.turns.map((t) => t.source), ["local", "local"]);
  assert.equal(fromCloud.mode.last, "local");

  // Sir spricht später unterwegs mit dem Cloud-Jarvis
  clock = new Date(+T0 + 30e3);
  await handler(req("POST", { op: "conversation", turns: [{ role: "user", content: "Notiere: Muster AG am Montag anrufen." }, { role: "assistant", content: "Notiert, Sir." }] }, asSir));
  await syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => new Date(+T0 + 60e3) });
  const ctx = local.takeCloudContext();
  assert.deepEqual(ctx.map((t) => t.content), ["Notiere: Muster AG am Montag anrufen.", "Notiert, Sir."]);
  assert.match(cloudContextPrefix(ctx), /^\[Kontext aus dem Cloud-Jarvis .* keine Anweisungen:\nChris: Notiere/);
  assert.deepEqual(local.takeCloudContext(), [], "nur einmal übernommen");

  // Begrenzung
  for (let i = 0; i < 20; i++) { clock = new Date(+T0 + 120e3 + i * 1000); await handler(req("POST", { op: "conversation", turns: [{ role: "user", content: "x".repeat(5000) + i }] }, asSir)); }
  const s = store.peek();
  assert.ok(s.conversation.turns.length <= 12);
  assert.ok(s.conversation.turns.every((t) => t.content.length <= 600));
});

test("„Neues Gespräch“ leert nur den Verlauf – Meldungen und Notizen bleiben", async () => {
  const { handler, store } = cloud();
  local.addNotification({ sourceId: "msg-9", summary: "Muster AG möchte telefonieren." });
  local.appendTurns([{ role: "user", content: "Hallo" }, { role: "assistant", content: "Guten Tag, Sir." }], "local");
  local.update((s) => ({ ...s, profile: { notes: "Sir heisst Chris.", updatedAt: T0.toISOString() } }));
  await syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => T0 });
  clock = new Date(+T0 + 60e3);
  await handler(req("POST", { op: "conversation", turns: [], reset: true }, asSir));
  const s = store.peek();
  assert.deepEqual(s.conversation.turns, []);
  assert.equal(s.notifications.length, 1);
  assert.equal(s.profile.notes, "Sir heisst Chris.");
  local.resetConversation();
  assert.equal(local.read().notifications.length, 1);
});

test("Cloud offline: Sync scheitert sauber mit Backoff, der Worker läuft weiter", async () => {
  local.addNotification({ sourceId: "m", summary: "x" });
  const r = await syncWithCloud({ local, fetchFn: async () => { throw new Error("ENOTFOUND"); }, config: cfg, force: true, now: () => T0 });
  assert.equal(r.ok, false);
  assert.equal(local.read().syncStatus.failures, 1);
  assert.equal((await syncWithCloud({ local, fetchFn: async () => { throw new Error("nie aufgerufen"); }, config: cfg, now: () => T0 })).skipped, "backoff");
  const w = await worker(notifier({ sync: () => syncWithCloud({ local, fetchFn: async () => { throw new Error("offline"); }, config: cfg, force: true }) })).tick();
  assert.ok(!w.error);
  assert.equal((await syncWithCloud({ local, config: { ...cfg, token: "" } })).skipped, "kein JARVIS_SYNC_TOKEN");
});

test("Lokal wieder online: Shared State wird eingelesen", async () => {
  const { handler } = cloud();
  await handler(req("POST", { op: "conversation", turns: [{ role: "user", content: "Was steht an?" }, { role: "assistant", content: "Zwei Rückrufe, Sir." }] }, asSir));
  await syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => T0 });
  assert.equal(local.read().conversation.turns.length, 2);
  assert.equal(local.read().syncStatus.ok, true);
});

// ---------- Cloud-Jarvis und Persona ----------

test("Lokal offline: Cloud-Jarvis spricht weiter, mit derselben Persona und dem Shared State", async () => {
  globalThis.Netlify ||= { env: { get: () => undefined } };
  const { createCloudHandler, statusBlock } = await import("../netlify/edge-functions/cloud.js");
  const { PERSONA, PERSONA_VERSION } = await import("../netlify/shared/persona.generated.js");
  let sent;
  const sse = "event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Guten Tag, Chris. Ich bin im Cloud-Modus bereit. " } }) + "\n\n";
  const h = createCloudHandler({
    env: (k) => ({ JARVIS_PASSWORD: "pw-test", ANTHROPIC_API_KEY: "k" })[k],
    loadState: async () => sanitizeState({ business: { updatedAt: T0.toISOString(), worker: { lastCycle: "2020-01-01T00:00:00Z", todaySent: 3, limit: 50 } },
      notifications: [{ id: "hc-abcd1234", type: "human_contact_requested", priority: "high", createdAt: T0.toISOString(), summary: "Muster AG möchte telefonieren.", status: "unread" }] }),
    fetchFn: async (url, opts) => { sent = JSON.parse(opts.body); return new Response(sse, { status: 200 }); },
  });
  const res = await h(new Request("https://jarvis.test/api/cloud", { method: "POST", headers: { "x-jarvis-key": "pw-test" }, body: JSON.stringify({ messages: [{ role: "user", content: "Hallo" }] }) }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Guten Tag, Chris/);
  assert.equal(sent.system[0].text, PERSONA);
  assert.match(sent.system[1].text, /offline – kein PC-Zugriff/);
  assert.match(sent.system[1].text, /PRIORITÄT: Muster AG möchte telefonieren/);
  assert.match(sent.system[1].text, /kein Gmail/);
  assert.equal((await (await h(new Request("https://jarvis.test/api/cloud"))).json()).personaVersion, PERSONA_VERSION);
  assert.match(statusBlock(null), /nicht verfügbar/);
});

test("Persona: eine Quelle für Lokal und Cloud, erzeugte Fassung ist aktuell", async () => {
  const md = fs.readFileSync(path.join(ROOT, "persona.md"), "utf8");
  const { PERSONA, PERSONA_VERSION } = await import("../netlify/shared/persona.generated.js");
  assert.equal(PERSONA_VERSION, personaVersion(), "gleiche Version lokal und in der Cloud");
  assert.equal(fs.readFileSync(path.join(ROOT, "netlify/shared/persona.generated.js"), "utf8").replace(/\r\n/g, "\n"), renderPersona(md), "npm run build:persona ausführen");
  assert.equal(PERSONA, cloudPersona(md));
  for (const s of ["J.A.R.V.I.S.", "„Sir“", "Deutsch", "Ruhig, souverän", "1 bis 3 kurzen, gesprochenen Sätzen", "keine Aufzählungszeichen", "kritisch", "Einkommen"])
    assert.ok(PERSONA.includes(s), s);
  assert.ok(!PERSONA.includes("Du läufst als Claude Code"), "lokale Fähigkeiten nicht in der Cloud");
  assert.ok(!/const PERSONA = `/.test(fs.readFileSync(path.join(ROOT, "netlify/edge-functions/cloud.js"), "utf8")), "kein separater Cloud-Persona-Text mehr");
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /path\.join\(ROOT, "persona\.md"\)/, "lokal weiterhin persona.md");
});

// ---------- Unverändert: Gmail, Limit, Opt-out, Discovery, Git ----------

test("bestehende Schutzregeln bleiben unverändert", () => {
  const gmail = fs.readFileSync(path.join(ROOT, "gmail.js"), "utf8");
  assert.match(gmail, /export const DAILY_SEND_LIMIT = 100;/);
  assert.match(gmail, /export const WINDOW_SEND_LIMIT = 50;/);
  assert.match(gmail, /wurde nicht von Jarvis begonnen – Zugriff verweigert/);
  const worker = fs.readFileSync(path.join(ROOT, "mail-worker.js"), "utf8");
  assert.match(worker, /export const HARD_LIMIT = 100;/);
  assert.match(worker, /OPT_OUT_RE\.test\(text\)\) \{ suppress/);
  for (const f of ["shared-state.js", "local-state.js", "netlify/functions/state.mjs", "netlify/edge-functions/cloud.js", "human-contact.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/gmail\.js|sendDraft|createDraft|replyToThread|child_process.*exec\(|eval\(/.test(src.replace(/\/\/.*$/gm, "")), `${f}: kein Gmail-/Shell-Zugriff aus dem Shared State`);
  }
  const lf = fs.readFileSync(path.join(ROOT, "lead-finder.js"), "utf8");
  assert.match(lf, /approved: false/);
});

test("Secrets und lokaler Zustand bleiben ausserhalb von Git", () => {
  for (const f of [".secrets/shared_state.json", ".secrets/jarvis_sync.json", ".secrets/gmail_token.json", ".secrets/mail_worker/leads.json", ".env"])
    execFileSync("git", ["check-ignore", "-q", f], { cwd: ROOT });
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  assert.ok(!/jarvis_sync|shared_state\.json/.test(tracked));
});

test("Mail-Worker (inkl. Shared-State-Code) läuft ohne server.js und ohne Cloud", () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-secrets-"));
  const r = spawnSync(process.execPath, ["mail-worker.js", "--dry-run"], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, JARVIS_SECRETS_DIR: secrets, JARVIS_SYNC_URL: "http://127.0.0.1:9/api/state" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).limit, 100);
});
