// Gmail-Send-Layer: 100 erfolgreiche Sends pro Tag, 50 je Versandfenster – auch bei parallelen Sendungen nie mehr.
// Ohne Netzwerk: fetch ist eine Gmail-Attrappe mit künstlicher Latenz, damit sich parallele Sendungen überlappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-gmail-limits-"));
process.env.JARVIS_SECRETS_DIR = dir;
const gmail = await import("../gmail.js");
const REG = path.join(dir, "gmail_jarvis.json");
let sentCalls, failSend;

globalThis.fetch = async (url, opts = {}) => {
  const route = new URL(url).pathname.replace("/gmail/v1/users/me", "");
  const method = opts.method || "GET";
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  let m;
  if (route === "/labels") return reply({ labels: [{ id: "Label_J", name: "JARVIS" }] });
  if (route === "/drafts/send") {
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
    if (failSend) return reply({ error: { message: failSend } }, 400);
    const id = JSON.parse(opts.body).id;
    sentCalls.push(id);
    return reply({ id: "s-" + id, threadId: "t-" + id, labelIds: ["SENT"] });
  }
  if ((m = route.match(/^\/drafts\/([^/]+)$/))) return reply({ id: m[1], message: { id: "m-" + m[1], threadId: "t-" + m[1], labelIds: ["DRAFT", "Label_J"] } });
  if ((m = route.match(/^\/messages\/([^/]+)\/modify$/))) return reply({ id: m[1] });
  if ((m = route.match(/^\/messages\/([^/]+)$/))) return reply({ id: m[1], threadId: "t-x", labelIds: ["SENT", "Label_J"], payload: { headers: [{ name: "Message-ID", value: `<${m[1]}@x>` }] } });
  return reply({ error: { message: "unbekannt " + route } }, 400);
};

// Register mit `drafts` eigenen Entwürfen und `already` heute gesendeten Mails (optional einem Fenster zugeordnet).
function setup({ drafts = 10, already = 0, window = null } = {}) {
  const reg = { labelId: "Label_J", drafts: {}, sent: {}, sending: {} };
  for (let i = 0; i < drafts; i++) reg.drafts["d" + i] = { messageId: "m-d" + i, threadId: "t-d" + i, to: `k${i}@x.ch`, subject: "S" };
  const now = new Date().toISOString();
  for (let i = 0; i < already; i++) reg.sent["old" + i] = { threadId: "o" + i, to: "x@y.ch", sentAt: now, ...(window && { window }) };
  fs.writeFileSync(REG, JSON.stringify(reg));
}
beforeEach(() => {
  fs.writeFileSync(path.join(dir, "gmail_credentials.json"), JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }));
  fs.writeFileSync(path.join(dir, "gmail_token.json"), JSON.stringify({ access_token: "a", refresh_token: "r", expiry: Date.now() + 3600e3 }));
  sentCalls = [];
  failSend = null;
});

test("Limits im Send-Layer: 100 pro Tag, 50 pro Fenster", () => {
  assert.equal(gmail.DAILY_SEND_LIMIT, 100);
  assert.equal(gmail.WINDOW_SEND_LIMIT, 50);
  assert.deepEqual(gmail.SEND_WINDOW_IDS, ["morning", "afternoon"]);
});

test("parallele Sendungen können das Tageslimit nicht überschreiten (101. Send hart blockiert)", async () => {
  setup({ drafts: 8, already: 97 });
  const results = await Promise.allSettled([...Array(8)].map((_, i) => gmail.sendDraft("d" + i)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(sentCalls.length, 3, "Gmail wurde genau dreimal zum Senden aufgerufen");
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => /Tageslimit von 100/.test(r.reason.message)));
  assert.equal(gmail.sentToday(), 100);
  assert.equal(Object.keys(gmail.listOwned().sent).length, 100, "kein gesendeter Eintrag ging verloren");
  assert.equal(Object.keys(gmail.listOwned().drafts).length, 5, "blockierte Entwürfe bleiben erhalten");
});

test("parallele Sendungen im selben Fenster: höchstens 50", async () => {
  setup({ drafts: 6, already: 48, window: "morning" });
  const results = await Promise.allSettled([...Array(6)].map((_, i) => gmail.sendDraft("d" + i, { window: "morning" })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => /Fensterlimit von 50/.test(r.reason.message)));
  assert.equal(gmail.sentInWindow("morning"), 50);
  // Das Nachmittagsfenster hat eigene 50 – das Tageslimit bleibt 100.
  await gmail.sendDraft("d5", { window: "afternoon" });
  assert.equal(gmail.sentInWindow("afternoon"), 1);
  await assert.rejects(gmail.sendDraft("d4", { window: "abends" }), /Unbekanntes Versandfenster/);
});

test("fehlgeschlagener Send zählt nicht; ein unklarer (Absturz) zählt vorsichtig mit", async () => {
  setup({ drafts: 2, already: 0 });
  failSend = "invalid recipient";
  await assert.rejects(gmail.sendDraft("d0"), /invalid recipient/);
  assert.equal(gmail.sentToday(), 0, "Fehlschlag zählt nicht");
  assert.deepEqual(gmail.listOwned().sending, {});
  const reg = JSON.parse(fs.readFileSync(REG, "utf8"));
  reg.sending.dX = { to: "a@b.ch", window: "morning", sentAt: new Date().toISOString() }; // Absturz zwischen Gmail und Register
  fs.writeFileSync(REG, JSON.stringify(reg));
  assert.equal(gmail.sentToday(), 1);
  assert.equal(gmail.sentInWindow("morning"), 1);
});
