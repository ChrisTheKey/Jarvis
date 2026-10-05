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

let drafts, sentMsgs, calls, nextId;
beforeEach(() => {
  fs.writeFileSync(path.join(dir, "gmail_credentials.json"), JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }));
  fs.writeFileSync(path.join(dir, "gmail_token.json"), JSON.stringify({ access_token: "a", refresh_token: "r", expiry: Date.now() + 3600e3 }));
  fs.rmSync(path.join(dir, "gmail_jarvis.json"), { force: true });
  // Ein fremder Entwurf, den der Nutzer selbst geschrieben hat
  drafts = { foreign: { id: "foreign", message: { id: "mF", threadId: "tF", labelIds: ["DRAFT"] } } };
  sentMsgs = [];
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
    drafts["d" + n] = { id: "d" + n, message: { id: "m" + n, threadId: "t" + n, labelIds: ["DRAFT"] } };
    return reply(drafts["d" + n]);
  }
  let m;
  if (route !== "/drafts/send" && (m = route.match(/^\/drafts\/([^/]+)$/))) {
    const d = drafts[m[1]];
    if (!d) return reply({ error: { message: "not found" } }, 404);
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
