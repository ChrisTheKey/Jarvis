// Prüft die Schutzregel: Jarvis darf nur eigene (registrierte + mit JARVIS gelabelte) Entwürfe ändern/senden.
// Läuft ohne Netzwerk – fetch wird durch eine kleine Gmail-Attrappe ersetzt.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-gmail-"));
process.env.JARVIS_SECRETS_DIR = dir;
const gmail = await import("../gmail.js");

let drafts, sentMsgs, threads, calls, nextId, forceThread;
beforeEach(() => {
  fs.writeFileSync(path.join(dir, "gmail_credentials.json"), JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }));
  fs.writeFileSync(path.join(dir, "gmail_token.json"), JSON.stringify({ access_token: "a", refresh_token: "r", expiry: Date.now() + 3600e3 }));
  fs.rmSync(path.join(dir, "gmail_jarvis.json"), { force: true });
  // Ein fremder Entwurf, den der Nutzer selbst geschrieben hat
  drafts = { foreign: { id: "foreign", message: { id: "mF", threadId: "tF", labelIds: ["DRAFT"] } } };
  sentMsgs = [];
  threads = {};
  forceThread = null;
  calls = [];
  nextId = 1;
});

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const route = u.pathname.replace("/gmail/v1/users/me", "");
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push(`${method} ${route}`);
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  const msgById = (id) => [...Object.values(drafts).map((d) => d.message), ...sentMsgs].find((m) => m.id === id);

  if (route === "/labels" && method === "GET") return reply({ labels: [{ id: "Label_J", name: "JARVIS" }] });
  if (route === "/drafts" && method === "POST") {
    const n = nextId++;
    const raw = Buffer.from(body.message.raw, "base64url").toString();
    drafts["d" + n] = { id: "d" + n, raw, message: { id: "m" + n, threadId: forceThread || body.message.threadId || "t" + n, labelIds: ["DRAFT"] } };
    return reply(drafts["d" + n]);
  }
  let m;
  if (route !== "/drafts/send" && (m = route.match(/^\/drafts\/([^/]+)$/))) {
    const d = drafts[m[1]];
    if (!d) return reply({ error: { message: "not found" } }, 404);
    if (method === "DELETE") { delete drafts[m[1]]; return new Response("", { status: 200 }); }
    if (method === "PUT") { d.message = { id: "m" + nextId++, threadId: d.message.threadId, labelIds: ["DRAFT"] }; }
    return reply(d);
  }
  if ((m = route.match(/^\/messages\/([^/]+)\/modify$/))) {
    const msg = msgById(m[1]) || { id: m[1], threadId: "tS", labelIds: [] };
    msg.labelIds.push(...body.addLabelIds);
    return reply(msg);
  }
  if ((m = route.match(/^\/messages\/([^/]+)$/))) {
    const msg = msgById(m[1]) || { id: m[1], threadId: "tS", labelIds: ["SENT", "Label_J"] };
    return reply({ ...msg, payload: { headers: [{ name: "Message-ID", value: `<${m[1]}@mail.gmail.com>` }] } });
  }
  if ((m = route.match(/^\/threads\/([^/]+)$/))) return threads[m[1]] ? reply(threads[m[1]]) : reply({ error: { message: "not found" } }, 404);
  if (route === "/drafts/send") {
    const d = drafts[body.id];
    delete drafts[body.id];
    sentMsgs.push({ id: "sent-" + d.id, threadId: d.message.threadId, labelIds: ["SENT"] });
    return reply(sentMsgs.at(-1));
  }
  return reply({ error: { message: "unbekannt " + route } }, 400);
};

test("neuer Entwurf wird gelabelt und mit Message-ID und Thread-ID registriert", async () => {
  const r = await gmail.createDraft({ to: "a@b.de", subject: "Grüße", body: "Hallo" });
  assert.equal(r.draftId, "d1");
  assert.ok(drafts.d1.message.labelIds.includes("Label_J"));
  const reg = gmail.listOwned();
  assert.deepEqual([reg.drafts.d1.messageId, reg.drafts.d1.threadId, reg.drafts.d1.rfcMessageId], ["m1", "t1", "<m1@mail.gmail.com>"]);
});

test("fremder Entwurf kann weder geändert noch gesendet werden", async () => {
  await assert.rejects(gmail.updateDraft("foreign", { body: "x" }), /nicht von Jarvis/);
  await assert.rejects(gmail.sendDraft("foreign"), /nicht von Jarvis/);
  assert.ok(!calls.some((c) => c.startsWith("PUT") || c.includes("/drafts/send")), "keine schreibende Anfrage");
  assert.ok(drafts.foreign);
});

test("registrierter Entwurf ohne JARVIS-Label wird abgelehnt", async () => {
  await gmail.createDraft({ to: "a@b.de", subject: "x", body: "y" });
  drafts.d1.message.labelIds = ["DRAFT"]; // Label wurde in Gmail entfernt
  await assert.rejects(gmail.sendDraft("d1"), /Label JARVIS/);
  assert.ok(drafts.d1);
});

test("abweichende Thread-ID wird abgelehnt", async () => {
  await gmail.createDraft({ to: "a@b.de", subject: "x", body: "y" });
  drafts.d1.message.threadId = "fremd";
  await assert.rejects(gmail.updateDraft("d1", { body: "z" }), /Thread-ID/);
});

test("eigener Entwurf: bearbeiten hält Label und Register aktuell, senden verschiebt ins Gesendet-Register", async () => {
  await gmail.createDraft({ to: "a@b.de", subject: "x", body: "y" });
  const u = await gmail.updateDraft("d1", { body: "neu" });
  assert.notEqual(u.messageId, "m1");
  assert.equal(gmail.listOwned().drafts.d1.messageId, u.messageId);
  assert.ok(drafts.d1.message.labelIds.includes("Label_J"));
  const s = await gmail.sendDraft("d1");
  const reg = gmail.listOwned();
  assert.equal(reg.drafts.d1, undefined);
  assert.equal(reg.sent[s.messageId].threadId, "t1");
});

test("Zeilenumbrüche im Header werden abgewiesen (Header-Injection)", async () => {
  await assert.rejects(gmail.createDraft({ to: "a@b.de\r\nBcc: x@y.de", subject: "x", body: "y" }), /Zeilenumbrüche/);
});

// ---------- Laufende Gespräche: thread / reply ----------

const b64 = (s) => Buffer.from(s).toString("base64url");
const mail = ({ id, threadId, labels, from, to, subject, body, t, ref = "" }) => ({
  id, threadId, labelIds: labels, internalDate: String(t),
  payload: {
    mimeType: "multipart/alternative",
    headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject },
      { name: "Date", value: `Mon, 5 Oct 2026 10:0${t}:00 +0200` }, { name: "Message-ID", value: `<${id}@x>` },
      ...(ref ? [{ name: "References", value: ref }] : [])],
    parts: [{ mimeType: "text/html", body: { data: b64("<p>html</p>") } }, { mimeType: "text/plain", body: { data: b64(body) } }],
  },
});

// Jarvis sendet eine Mail (Thread t1), der Kunde antwortet. Daneben ein fremder Thread tF.
async function eigenesGespraech() {
  await gmail.createDraft({ to: "kunde@firma.ch", subject: "Angebot Website", body: "Hallo" });
  const s = await gmail.sendDraft("d1");
  threads.t1 = { id: "t1", messages: [
    mail({ id: "ext1", threadId: "t1", labels: ["INBOX"], from: "Anna Muster <anna@firma.ch>", to: "chris@x.ch", subject: "Re: Angebot Website", body: "Danke, klingt gut.", t: 2, ref: `<${s.messageId}@x>` }),
    mail({ id: s.messageId, threadId: "t1", labels: ["SENT", "Label_J"], from: "chris@x.ch", to: "kunde@firma.ch", subject: "Angebot Website", body: "Hallo", t: 1 }),
  ] };
  threads.tF = { id: "tF", messages: [mail({ id: "mF2", threadId: "tF", labels: ["INBOX"], from: "fremd@y.de", to: "chris@x.ch", subject: "Privat", body: "geheim", t: 1 })] };
  calls.length = 0;
  return s;
}

test("eigenen gesendeten Thread lesen: erlaubt, chronologisch, mit allen Feldern", async () => {
  await eigenesGespraech();
  const { messages } = await gmail.readThread("t1");
  assert.deepEqual(messages.map((m) => m.body), ["Hallo", "Danke, klingt gut."]);
  const a = messages[1];
  assert.deepEqual([a.from, a.to, a.subject], ["Anna Muster <anna@firma.ch>", "chris@x.ch", "Re: Angebot Website"]);
  assert.ok(a.date);
});

test("fremden Thread lesen: verweigert, Gmail wird gar nicht gefragt", async () => {
  await eigenesGespraech();
  await assert.rejects(gmail.readThread("tF"), /nicht von Jarvis begonnen/);
  await assert.rejects(gmail.readThread(undefined), /nicht von Jarvis begonnen/);
  assert.ok(!calls.some((c) => c.includes("/threads/")), "kein Lesezugriff auf Gmail");
});

test("Thread ohne registrierte gesendete Nachricht darin gilt als nicht eindeutig", async () => {
  await eigenesGespraech();
  threads.t1.messages = threads.t1.messages.filter((m) => m.id === "ext1");
  await assert.rejects(gmail.readThread("t1"), /nicht eindeutig/);
  await assert.rejects(gmail.replyToThread("t1", { body: "x" }), /nicht eindeutig/);
  assert.ok(!calls.some((c) => c === "POST /drafts"));
});

test("Antwort auf eigenen Thread: Entwurf im selben Thread, gelabelt, registriert, nicht gesendet", async () => {
  await eigenesGespraech();
  const r = await gmail.replyToThread("t1", { body: "Freut mich, Anna." });
  const d = drafts[r.draftId];
  assert.equal(d.message.threadId, "t1");
  assert.match(d.raw, /^To: Anna Muster <anna@firma\.ch>\r$/m);
  assert.match(d.raw, /^Subject: Re: Angebot Website\r$/m);
  assert.match(d.raw, /^In-Reply-To: <ext1@x>\r$/m);
  assert.match(d.raw, /^References: <sent-d1@x> <ext1@x>\r$/m);
  assert.ok(d.message.labelIds.includes("Label_J"), "JARVIS-Label");
  const reg = gmail.listOwned();
  assert.deepEqual([reg.drafts[r.draftId].messageId, reg.drafts[r.draftId].threadId], [d.message.id, "t1"]);
  assert.ok(!calls.some((c) => c.includes("/drafts/send") || c.includes("/messages/send")), "nichts gesendet");
  assert.equal(Object.keys(reg.sent).length, 1);
  await gmail.assertOwnedDraft(r.draftId); // besteht die normale Schutzprüfung
});

test("Antwort auf fremden Thread: verweigert, kein Entwurf", async () => {
  await eigenesGespraech();
  await assert.rejects(gmail.replyToThread("tF", { body: "x" }), /nicht von Jarvis begonnen/);
  assert.ok(!calls.some((c) => c === "POST /drafts" || c.includes("/threads/")));
  assert.deepEqual(Object.keys(gmail.listOwned().drafts), []);
});

test("fremde Mails werden nie verändert", async () => {
  await eigenesGespraech();
  await gmail.readThread("t1");
  await gmail.replyToThread("t1", { body: "x" });
  await assert.rejects(gmail.replyToThread("tF", { body: "x" }));
  assert.ok(!calls.some((c) => /\/messages\/(ext1|mF2|mF)\//.test(c)), "keine Änderung an fremden Nachrichten");
  assert.deepEqual(threads.t1.messages.find((m) => m.id === "ext1").labelIds, ["INBOX"]);
  assert.deepEqual(threads.tF.messages[0].labelIds, ["INBOX"]);
  assert.deepEqual(drafts.foreign.message.labelIds, ["DRAFT"]);
});

test("Follow-up ohne eingegangene Antwort: Entwurf an den zuletzt angeschriebenen Empfänger im selben Thread", async () => {
  const s = await eigenesGespraech();
  threads.t1.messages = threads.t1.messages.filter((m) => m.id === s.messageId); // noch keine Antwort
  const r = await gmail.replyToThread("t1", { body: "Kurze Nachfrage." });
  const d = drafts[r.draftId];
  assert.equal(d.message.threadId, "t1");
  assert.match(d.raw, /^To: kunde@firma\.ch\r$/m);
  assert.match(d.raw, /^In-Reply-To: <sent-d1@x>\r$/m);
  assert.ok(d.message.labelIds.includes("Label_J"));
  assert.ok(!calls.some((c) => c.includes("/send")), "nichts gesendet");
});

test("Thread-Mismatch: Entwurf wird verworfen, nicht registriert, nicht gelabelt", async () => {
  await eigenesGespraech();
  forceThread = "tAnders";
  await assert.rejects(gmail.replyToThread("t1", { body: "x" }), /nicht im Thread t1 – nicht registriert/);
  assert.deepEqual(Object.keys(gmail.listOwned().drafts), []);
  assert.deepEqual(Object.keys(drafts), ["foreign"], "verworfen, fremder Entwurf unberührt");
  assert.ok(!calls.some((c) => c.includes("/modify") || c.includes("/send")), "weder gelabelt noch gesendet");
});

test("Sprach-Jarvis: thread/reply eng freigegeben, kein allgemeiner node-Zugriff, Befehle dokumentiert", () => {
  const ws = new URL("../workspace/", import.meta.url);
  const allow = JSON.parse(fs.readFileSync(new URL(".claude/settings.json", ws), "utf8")).permissions.allow;
  for (const cmd of ["draft", "update", "send", "list", "thread", "reply"]) assert.ok(allow.includes(`Bash(node ../gmail.js ${cmd}:*)`), cmd);
  assert.deepEqual(allow.filter((r) => /node/.test(r) && !/^Bash\(node \.\.\/gmail\.js (draft|update|send|list|thread|reply):\*\)$/.test(r)), []);
  const md = fs.readFileSync(new URL("CLAUDE.md", ws), "utf8");
  assert.match(md, /node \.\.\/gmail\.js thread <threadId>/);
  assert.match(md, /node \.\.\/gmail\.js reply <threadId> --body/);
});

test("Tageslimit: bei 100 heute gesendeten Jarvis-Mails wird nicht mehr gesendet", async () => {
  await gmail.createDraft({ to: "a@b.de", subject: "x", body: "y" });
  const file = path.join(dir, "gmail_jarvis.json");
  const reg = JSON.parse(fs.readFileSync(file, "utf8"));
  const now = new Date().toISOString();
  for (let i = 0; i < 99; i++) reg.sent["h" + i] = { threadId: "th" + i, to: "x@y.ch", sentAt: now };
  reg.sent.alt = { threadId: "alt", to: "x@y.ch", sentAt: "2020-01-01T10:00:00Z" }; // anderer Tag zählt nicht
  fs.writeFileSync(file, JSON.stringify(reg));
  assert.equal(gmail.sentToday(), 99);
  await gmail.sendDraft("d1"); // Nr. 100 ist erlaubt
  assert.equal(gmail.sentToday(), 100);
  await gmail.createDraft({ to: "a@b.de", subject: "x", body: "y" });
  calls.length = 0;
  await assert.rejects(gmail.sendDraft("d2"), /Tageslimit von 100/); // der 101. Send wird hart blockiert
  assert.ok(!calls.some((c) => c.includes("/drafts/send")), "nicht gesendet");
  assert.ok(gmail.listOwned().drafts.d2, "Entwurf bleibt erhalten");
});
