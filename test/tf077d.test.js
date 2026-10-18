// TF-077D – Mehr-Anbieter-Allowlist in gmail.searchInbound: toLowerCase() vor split(" OR ") machte aus «a OR b» einen einzigen String,
// readInbound lehnte danach JEDEN echten Absender ab (contact_form_read_failed). Getestet wird das ECHTE gmail.js gegen eine Gmail-API-Attrappe
// (fetch-Stub, Test-Token in einem leeren Secrets-Verzeichnis) und die volle Kontaktformular-Pipeline. 0 echte E-Mails, 0 Netz.
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SEC = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf077d-sec-"));
process.env.JARVIS_SECRETS_DIR = SEC;
process.env.JARVIS_GMAIL_MIN_GAP_MS = "0";
fs.writeFileSync(path.join(SEC, "gmail_token.json"), JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh", expiry: Date.now() + 86_400_000 }));
const gmailMod = await import("../gmail.js");
const { createStore } = await import("../mail-worker.js");
const cf = await import("../contact-form.js");

const T0 = new Date("2026-10-18T10:30:00Z");
const MAILBOX = "chriskaelin98@gmail.com";
const NETLIFY_FROM = '"helvetic-webdesign-reperatur.netlify.app" <formresponses@netlify.com>';
const SUBJECT = "Neue Kundenanfrage – submission from helvetic-webdesign-reperatur (anfrage)";
const AUTH = "mx.google.com; dkim=pass header.i=@netlify.com header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@netlify.com; dmarc=pass (p=NONE) header.from=netlify.com";
const CFG = { forms: [{ form_name: "anfrage", site: "helvetic-webdesign-reperatur", market: "CH" }], receivingMailboxes: [MAILBOX] };
const BODY = ["Ihre Website *: https://www.muster-garage.ch", "Name *: Anna Muster", "E-Mail *: anna@muster-garage.ch", "Interesse an: Reparatur",
  "Was funktioniert nicht?: Das Kontaktformular sendet nichts ab."].join("\n");

// Gmail-API-Nachricht im echten Format (users.messages.get?format=full).
function apiMsg({ id, from = NETLIFY_FROM, subject = SUBJECT, replyTo = "Anna Muster <anna@muster-garage.ch>", auth = AUTH, body = BODY, at = T0 }) {
  const headers = [["From", from], ["Reply-To", replyTo], ["To", MAILBOX], ["Delivered-To", MAILBOX], ["Subject", subject], ["Date", at.toUTCString()],
    ["Message-ID", `<${id}.formresponses@netlify.com>`], ["Authentication-Results", auth]].map(([name, value]) => ({ name, value }));
  return { id, threadId: "th-" + id, labelIds: ["INBOX", "UNREAD"], internalDate: String(+at),
    payload: { mimeType: "text/plain", headers, body: { data: Buffer.from(body).toString("base64url") } } };
}

let api, queries;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  assert.equal(u.host, "gmail.googleapis.com", "nur die Gmail-Attrappe");
  let data, status = 200;
  const id = u.pathname.match(/\/messages\/([^/]+)$/)?.[1];
  if (u.pathname.endsWith("/messages")) { queries.push(u.searchParams.get("q")); data = { messages: Object.keys(api).map((x) => ({ id: x })) }; }
  else if (id && api[id]) data = api[id];
  else { status = 404; data = { error: { message: "not found" } }; }
  return { ok: status === 200, status, text: async () => JSON.stringify(data), headers: { get: () => null } };
};
after(() => { globalThis.fetch = realFetch; });

const TAIL = "-in:sent -in:drafts -in:spam -in:trash newer_than:14d";
const Q_BOTH = cf.inboundQuery({});
beforeEach(() => { api = {}; queries = []; });

// ======================================================================================================================================
// 1. Allowlist-Parsing in gmail.searchInbound / readInbound
// ======================================================================================================================================
test("Standard-Anfrage enthält Netlify UND Formspree", () => {
  assert.match(Q_BOTH, /formresponses@netlify\.com OR noreply@formspree\.io/);
});

test("Mehr-Anbieter-Anfrage: Netlify-Absender mit Anführungszeichen-Anzeigename besteht die readInbound-Prüfung", async () => {
  api["1a14ef91343f08be"] = apiMsg({ id: "1a14ef91343f08be" });
  assert.deepEqual(await gmailMod.searchInbound({ query: Q_BOTH }), ["1a14ef91343f08be"]);
  const m = await gmailMod.readInbound("1a14ef91343f08be");
  assert.equal(m.from, NETLIFY_FROM);
  assert.equal(m.deliveredTo, MAILBOX);
  assert.deepEqual(m.headers["authentication-results"], [AUTH]);
});

test("Formspree-Absender besteht, unbekannter Absender wird abgelehnt", async () => {
  api["00000000000000f1"] = apiMsg({ id: "00000000000000f1", from: "Formspree <noreply@formspree.io>" });
  api["00000000000000f2"] = apiMsg({ id: "00000000000000f2", from: '"formresponses@netlify.com" <evil@attacker.example>' });
  api["00000000000000f3"] = apiMsg({ id: "00000000000000f3", from: "formresponses@netlify.com.attacker.example" });
  await gmailMod.searchInbound({ query: Q_BOTH });
  assert.equal((await gmailMod.readInbound("00000000000000f1")).from, "Formspree <noreply@formspree.io>");
  await assert.rejects(gmailMod.readInbound("00000000000000f2"), /Allowlist/, "Anzeigename zählt nie – nur die Adresse in <>");
  await assert.rejects(gmailMod.readInbound("00000000000000f3"), /Allowlist/);
});

test("andere Gross-/Kleinschreibung in der Anfrage (auch «or») bricht das Parsing nicht", async () => {
  api["00000000000000e1"] = apiMsg({ id: "00000000000000e1" });
  api["00000000000000e2"] = apiMsg({ id: "00000000000000e2", from: "NoReply@FormSpree.io" });
  for (const q of [`from:(FormResponses@Netlify.com OR NOREPLY@formspree.io) ${TAIL}`, `from:(formresponses@netlify.com or noreply@formspree.io) ${TAIL}`]) {
    await gmailMod.searchInbound({ query: q });
    assert.ok(await gmailMod.readInbound("00000000000000e1"), q);
    assert.ok(await gmailMod.readInbound("00000000000000e2"), q);
  }
});

test("Ein-Anbieter-Anfrage: nur dieser Anbieter, der andere wird abgelehnt (Allowlist bleibt exakt)", async () => {
  api["00000000000000d1"] = apiMsg({ id: "00000000000000d1" });
  api["00000000000000d2"] = apiMsg({ id: "00000000000000d2", from: "noreply@formspree.io" });
  await gmailMod.searchInbound({ query: `from:(formresponses@netlify.com) ${TAIL}` });
  assert.ok(await gmailMod.readInbound("00000000000000d1"));
  await assert.rejects(gmailMod.readInbound("00000000000000d2"), /Allowlist/);
  // Freie Anfragen bleiben verboten.
  await assert.rejects(gmailMod.searchInbound({ query: "in:inbox" }), /Allowlist/);
});

// ======================================================================================================================================
// 2. Volle Pipeline mit echtem gmail.searchInbound/readInbound (Netlify-Form wie in Produktion)
// ======================================================================================================================================
let dir, reg, calls;
const fakeSend = () => ({
  searchInbound: gmailMod.searchInbound, readInbound: gmailMod.readInbound,
  listOwned: () => structuredClone(reg),
  async createDraft({ to, mode, contactFormKey, subject, body }) {
    const id = "dr" + (Object.keys(reg.drafts).length + 1); calls.push(`create ${to} ${mode}`);
    reg.drafts[id] = { threadId: "t" + id, messageId: "m" + id, to, subject, body, mode, contactFormKey, createdAt: T0.toISOString() };
    return { draftId: id, messageId: "m" + id, threadId: "t" + id };
  },
  async sendDraft(id) {
    calls.push("SEND " + id);
    gmailMod.assertSendable(id, reg);
    const d = reg.drafts[id]; delete reg.drafts[id];
    reg.sent["s" + id] = { fromDraft: id, to: d.to, threadId: d.threadId, mode: d.mode, contactFormKey: d.contactFormKey, sentAt: T0.toISOString() };
    return { messageId: "s" + id, threadId: d.threadId };
  },
});
const run = (logs = []) => cf.processContactForms({ gmail: fakeSend(), store: createStore(dir), cfg: { ...cf.DEFAULT_CONTACT_FORM_CONFIG, ...CFG },
  sender: { name: "Chris Kälin", signature: "Chris Kälin\nHelvetic Webdesign" }, ownAddresses: [MAILBOX], now: T0, autoReply: true,
  log: (lvl, ev, data) => logs.push({ ev, ...data }) });
const readJ = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));

test("Pipeline: echte Netlify-Form wird gelesen, verifiziert, CONTACT_FORM_P0 und genau eine automatische Antwort", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf077d-")); reg = { labelId: "L", drafts: {}, sent: {}, sending: {} }; calls = [];
  api["1a14f024cbaa1af4"] = apiMsg({ id: "1a14f024cbaa1af4" });
  const logs = [];
  const r = await run(logs);
  assert.ok(!logs.some((l) => l.ev === "contact_form_read_failed"), "kein read_failed mehr");
  assert.deepEqual([r.fetched, r.new, r.drafted, r.sent], [1, 1, 1, 1]);
  const st = readJ(cf.CONTACT_FORMS_FILE);
  assert.equal(st.seen["1a14f024cbaa1af4"].result, "contact_form");
  const it = Object.values(st.items)[0];
  assert.deepEqual([it.source_provider, it.form_name, it.form_registered, it.site_verified, it.mailbox_verified, it.verified],
    ["netlify", "anfrage", true, true, true, true]);
  assert.equal(it.customer_email, "anna@muster-garage.ch");
  assert.deepEqual([it.message_class, it.priority, it.verification], [cf.CONTACT_FORM_CLASS, "P0", "CONTACT_FORM_VERIFIED"]);
  assert.equal(readJ(cf.CONTACT_FORMS_PUBLIC_FILE).leads["muster-garage.ch"].priority_class, cf.PRIORITY_CLASS);
  assert.equal(it.state, cf.STATES.SENT);
  assert.deepEqual(calls, ["create anna@muster-garage.ch CONTACT_FORM_AUTO_REPLY", "SEND dr1"]);
  assert.ok(logs.some((l) => l.ev === "contact_form_drafted") && logs.some((l) => l.ev === "contact_form_reply_sent"));
  // Zweiter Durchlauf: nichts Neues, keine zweite Antwort.
  await run();
  assert.equal(calls.filter((c) => c.startsWith("SEND")).length, 1);
});

test("Pipeline: unbekannter Absender bleibt read_failed (keine Lockerung)", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf077d-")); reg = { labelId: "L", drafts: {}, sent: {}, sending: {} }; calls = [];
  api["00000000000000c1"] = apiMsg({ id: "00000000000000c1", from: '"helvetic-webdesign-reperatur.netlify.app" <forms@evil.example>' });
  const logs = [];
  await run(logs);
  assert.equal(readJ(cf.CONTACT_FORMS_FILE).seen["00000000000000c1"].result, "read_failed");
  assert.deepEqual(calls, []);
});
