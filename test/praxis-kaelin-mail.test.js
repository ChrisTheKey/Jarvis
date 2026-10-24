import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addRequest } from "../mail-requests.js";
import { CLOUD_INBOX, createStore, createWorker, inboxAdd } from "../mail-worker.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const REQUEST_ID = "mr-praxis-kaelin-001";
const MAIL = {
  request_id: REQUEST_ID,
  manual_test: true,
  manual_test_lead_id: "praxis-kaelin.netlify.app",
  recipient: "helvetic.webdesign@proton.me",
  subject: "[TEST] Technische Auffälligkeiten auf Ihrer Webseite – Praxis Kälin",
  body: [
    "Grüezi",
    "",
    "Bei unserer technischen Überprüfung Ihrer Webseite praxis-kaelin.netlify.app haben wir 5 technische Fehler festgestellt.",
    "",
    "Dabei handelt es sich unter anderem um:",
    "- Der Kontaktanker #kontakt erreicht den Kontaktbereich nicht.",
    "- Ein JavaScript-Fehler im Footer verhindert die Jahresanzeige.",
    "- Die Notfall-Kacheln werden auf schmalen Mobilansichten abgeschnitten.",
    "",
    "1. Webseiten-Check & Anleitung – CHF 150.–",
    "https://buy.stripe.com/test_dRm3cw5A5fo3caR9ov7Re00",
    "",
    "2. Webseiten-Check & Reparatur – CHF 480.–",
    "https://buy.stripe.com/test_7sY00k5A54JpcaR1W37Re01",
    "",
    "Nach Ihrer Bestellung melden wir uns bezüglich der nächsten Schritte.",
    "",
    "Freundliche Grüsse",
    "",
    "Helvetic Webdesign",
    "Webseiten-Check & Reparatur",
    "",
    "TEST – interner Versand an die eigene Proton-Adresse.",
  ].join("\n"),
};

function fakeGmail({ sendError = null } = {}) {
  const state = { drafts: {}, sent: {}, calls: [], n: 0 };
  const gmail = {
    setSendAs() {},
    listOwned: () => ({ drafts: structuredClone(state.drafts), sent: structuredClone(state.sent), sending: {} }),
    async createDraft({ to, subject, body }) {
      const id = "dr" + ++state.n;
      state.calls.push("create:" + to);
      state.drafts[id] = { threadId: "thread-" + id, to, subject, body, createdAt: NOW.toISOString() };
      return { draftId: id, threadId: "thread-" + id };
    },
    async sendDraft(id) {
      state.calls.push("send:" + id);
      if (sendError) throw new Error(sendError);
      const draft = state.drafts[id];
      if (!draft) throw new Error("Entwurf nicht vorhanden");
      delete state.drafts[id];
      state.sent["sent-" + id] = { ...draft, fromDraft: id, sentAt: NOW.toISOString() };
      return { messageId: "sent-" + id };
    },
  };
  return { gmail, state };
}

function addManualRequest(dir, input = MAIL) {
  const result = addRequest([], input, { now: NOW, requestedBy: "chris" });
  assert.equal(result.status, 201);
  inboxAdd(createStore(dir), [result.request], NOW);
  return result.request;
}

test("Praxis-Kälin-Mail: manueller TEST-Auftrag ist streng gebunden und idempotent", () => {
  const result = addRequest([], MAIL, { now: NOW, requestedBy: "chris" });
  assert.equal(result.status, 201);
  assert.equal(result.request.manual_test, true);
  assert.equal(result.request.manual_test_lead_id, "praxis-kaelin.netlify.app");
  const duplicate = addRequest([], MAIL, { now: NOW, requestedBy: "chris" });
  assert.equal(duplicate.status, 201, "eine neue Liste hat keinen Duplikat-Zustand");
  assert.equal(addRequest([result.request], MAIL, { now: NOW, requestedBy: "chris" }).duplicate, true);
  assert.equal(addRequest([], { ...MAIL, recipient: "andere@example.test" }, { now: NOW, requestedBy: "chris" }).status, 400);
  assert.equal(addRequest([], { ...MAIL, manual_test_lead_id: "andere.example" }, { now: NOW, requestedBy: "chris" }).status, 400);
  assert.equal(addRequest([], { ...MAIL, body: MAIL.body.replace("CHF 480.–", "CHF 4.80") }, { now: NOW, requestedBy: "chris" }).status, 400);
});

test("Praxis-Kälin-Mail: Worker sendet den autorisierten Testauftrag genau einmal ohne KI", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-praxis-mail-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", sender: { name: "Helvetic Webdesign" } }));
  const { gmail, state } = fakeGmail();
  let composed = 0;
  const request = addManualRequest(dir);
  const worker = createWorker({ dir, gmail, now: () => NOW, compose: async () => { composed++; throw new Error("KI darf im Testpfad nicht aufgerufen werden"); } });
  const first = await worker.tick();
  assert.equal(composed, 0);
  assert.equal(state.calls.filter((x) => x.startsWith("create:")).length, 1);
  assert.equal(state.calls.filter((x) => x.startsWith("send:")).length, 1);
  assert.equal(first.sends.length, 1);
  assert.equal(first.sends[0].to, MAIL.recipient);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, CLOUD_INBOX), "utf8"))[request.request_id].status, "sent");
  await worker.tick();
  assert.equal(state.calls.filter((x) => x.startsWith("send:")).length, 1, "zweiter Tick darf nicht nochmals senden");
  assert.equal(Object.keys(state.sent).length, 1);
});

test("Praxis-Kälin-Mail: OAuth/Gmail-Fehler bleibt als FAILED nachweisbar und wird nicht als Versand ausgegeben", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-praxis-mail-failed-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", sender: { name: "Helvetic Webdesign" } }));
  const { gmail, state } = fakeGmail({ sendError: "OAuth unavailable" });
  const request = addManualRequest(dir, { ...MAIL, request_id: "mr-praxis-kaelin-002" });
  const worker = createWorker({ dir, gmail, now: () => NOW, compose: async () => { throw new Error("KI darf im Testpfad nicht aufgerufen werden"); } });
  const result = await worker.tick();
  const inbox = JSON.parse(fs.readFileSync(path.join(dir, CLOUD_INBOX), "utf8"));
  assert.equal(result.sends.length, 0);
  assert.equal(inbox[request.request_id].status, "failed");
  assert.equal(Object.keys(state.sent).length, 0);
});
