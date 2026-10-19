// TF-077C – Netlify-Benachrichtigung mit benutzerdefiniertem Text (Felder «Ihre Website *», «Name *», «E-Mail *», «Interesse an», «Was funktioniert nicht?»,
// kein Formularname im Betreff, keine Submission-ID, kein Dashboard-Link). Fixture = echte Benachrichtigung vom 18.10.2026 (Formular «anfrage» der
// Landingpage helvetic-webdesign-reperatur.netlify.app). Nur Fixtures: 0 echte E-Mails, 0 Anrufe, 0 Zahlungen, keine Kunden-Website wird angefasst.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JARVIS_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf077c-sec-"));
const gmailMod = await import("../gmail.js");
const { createStore } = await import("../mail-worker.js");
const cf = await import("../contact-form.js");
const { cleanContactForm } = await import("../lead-crm.js");

const T0 = new Date("2026-10-18T10:30:00Z");
const MAILBOX = "chriskaelin98@gmail.com";
const OWN = [MAILBOX];
const AUTH = (d) => `mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@${d}; dmarc=pass (p=NONE) header.from=${d}`;
const SUBJECT_REAL = "Neue Kundenanfrage - Helvetic Webdesign"; // so kommt sie heute an: weder Formularname noch Site
const SUBJECT_FIXED = "Neue Kundenanfrage – submission from helvetic-webdesign-reperatur (anfrage)"; // so wird sie in Netlify eingestellt
const CFG = { forms: [{ form_name: "anfrage", site: "helvetic-webdesign-reperatur", market: "CH" }], receivingMailboxes: [MAILBOX] };

// Textkörper exakt wie die echte Benachrichtigung: nur diese fünf Felder, Pflichtfelder mit « *», Fragezeichen im Feldnamen.
const bodyOf = ({ website = "https://www.muster-garage.ch", name = "Anna Muster", email = "anna@muster-garage.ch", interest = "Reparatur", message = "Das Kontaktformular sendet nichts ab." } = {}) =>
  [`Ihre Website *: ${website}`, `Name *: ${name}`, `E-Mail *: ${email}`, `Interesse an: ${interest}`, `Was funktioniert nicht?: ${message}`].join("\n");
let seq = 0;
function netlifyMail({ id = (0x3a2b3c4d00 + ++seq).toString(16).padStart(16, "0"), rfc = null, subject = SUBJECT_FIXED, auth = [AUTH("netlify.com")], body = bodyOf(), at = T0 } = {}) {
  return { messageId: id, rfcMessageId: rfc === null ? `<${id}.formresponses@netlify.com>` : rfc || null, threadId: "th-" + id, from: "Netlify <formresponses@netlify.com>", replyTo: "",
    to: MAILBOX, deliveredTo: MAILBOX, subject, date: at.toUTCString(), internalDate: +at, body, headers: { "authentication-results": auth } };
}

// ---------- Gmail-Attrappe (nur CONTACT_FORM_AUTO_REPLY ist sendbar, Gmail verbraucht den Entwurf) ----------
let dir, g, clock;
function fakeGmail() {
  const f = {
    reg: { labelId: "L", drafts: {}, sent: {}, sending: {} }, inbound: {}, calls: [], n: 0,
    listOwned: () => structuredClone(f.reg),
    async searchInbound() { f.calls.push("search"); return Object.values(f.inbound).sort((a, b) => b.internalDate - a.internalDate).map((m) => m.messageId); },
    async readInbound(id) { if (!f.inbound[id]) throw new Error("not found"); return structuredClone(f.inbound[id]); },
    async createDraft({ to, mode, contactFormKey, subject, body }) {
      const id = "dr" + ++f.n; f.calls.push(`create ${to} ${mode || "-"}`);
      f.reg.drafts[id] = { threadId: "t" + id, messageId: "m" + f.n, to, subject, body, mode, contactFormKey, createdAt: clock.toISOString() };
      return { draftId: id, messageId: f.reg.drafts[id].messageId, threadId: "t" + id };
    },
    async sendDraft(id) {
      f.calls.push("SEND " + id);
      const d = f.reg.drafts[id];
      if (!d) throw new Error("Gmail GET /drafts: not found");
      gmailMod.assertSendable(id, f.reg);
      delete f.reg.drafts[id];
      f.reg.sent["s" + id] = { fromDraft: id, to: d.to, threadId: d.threadId, mode: d.mode, contactFormKey: d.contactFormKey, sentAt: clock.toISOString() };
      return { messageId: "s" + id, threadId: d.threadId };
    },
  };
  return f;
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf077c-")); g = fakeGmail(); clock = T0; });
const readJ = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const store = () => createStore(dir);
const run = (cfg = CFG, extra = {}) => cf.processContactForms({ gmail: g, store: store(), cfg: { ...cf.DEFAULT_CONTACT_FORM_CONFIG, ...cfg }, sender: { name: "Chris Kälin", signature: "Chris Kälin\nHelvetic Webdesign" },
  vnSignature: "Lap", ownAddresses: OWN, now: clock, autoReply: true, isTransient: (e) => /503|quota|ECONN/i.test(String(e.message)), ...extra });
const items = () => Object.values(readJ(cf.CONTACT_FORMS_FILE).items);
const sends = () => g.calls.filter((c) => c.startsWith("SEND "));
const add = (m) => { g.inbound[m.messageId] = m; return m; };
const classify = (msg, cfg = CFG) => cf.classifyInbound(msg, { cfg: { ...cf.DEFAULT_CONTACT_FORM_CONFIG, ...cfg }, ownAddresses: OWN });

// ======================================================================================================================================
// 1. Feld-Erkennung
// ======================================================================================================================================
test("parseFormFields: Sternchen, Fragezeichen, Umlaute und Leerzeichen im Feldnamen werden normalisiert", () => {
  const f = cf.parseFormFields(bodyOf());
  assert.deepEqual(Object.keys(f), ["ihre_website", "name", "e_mail", "interesse_an", "was_funktioniert_nicht"]);
  assert.equal(f.was_funktioniert_nicht, "Das Kontaktformular sendet nichts ab.");
  assert.equal(f.e_mail, "anna@muster-garage.ch");
  // Mehrzeilige Nachricht (auch mit Leerzeile) bleibt bei «Was funktioniert nicht?»; Anbieter-Link ist kein Kundentext.
  const multi = cf.parseFormFields("Name *: A\nWas funktioniert nicht?: Zeile 1\n\nZeile 2\nhttps://app.netlify.com/sites/x/forms/y/submissions/5f0123456789abcdef01");
  assert.equal(multi.was_funktioniert_nicht, "Zeile 1\nZeile 2");
  assert.equal(cf.normalizeFieldKey("  Rückruf erwünscht ? * "), "rückruf_erwünscht");
  // Bestehende Formate bleiben unverändert.
  assert.deepEqual(cf.parseFormFields("Name: Ba\nE-Mail: b@c.ch\nNachricht: Hallo"), { name: "Ba", e_mail: "b@c.ch", nachricht: "Hallo" });
});

test("echte Netlify-Mail (Betreff ohne Formular/Site): Felder erkannt, kein no_form_fields mehr – aber nie VERIFIED", () => {
  const msg = netlifyMail({ subject: SUBJECT_REAL });
  // Ohne Registrierung: erkannt, Empfänger aus dem Feld «E-Mail *», nur Entwurf (Prüfung), Site nicht verifizierbar.
  const noReg = classify(msg, { receivingMailboxes: [MAILBOX] });
  assert.equal(noReg.contactForm, true);
  const a = noReg.item;
  assert.deepEqual([a.state, a.customer_email, a.recipient_source, a.name, a.verified], [cf.STATES.NEW, "anna@muster-garage.ch", "form_field", "Anna Muster", false]);
  assert.deepEqual(a.verify_missing, ["form_not_registered", "form_site_not_verified", "no_submission_id"]);
  assert.equal(noReg.inquiry.message, "Das Kontaktformular sendet nichts ab.");
  assert.deepEqual([a.customer_website, a.interest], ["https://www.muster-garage.ch/", "Reparatur"]);
  // Mit Registrierung, aber unverändertem Betreff: Formularname nicht erkennbar → Prüfung statt Versand (keine Code-Lockerung).
  const reg = classify(msg).item;
  assert.deepEqual([reg.state, reg.reason], [cf.STATES.UNKNOWN_FORM, "form_not_registered"]);
  // Nur Formularname im Betreff, aber keine Site: registriert, aber Site nicht verifiziert → keine Ersatz-ID, nur Entwurf.
  const half = classify(netlifyMail({ subject: "Neue Kundenanfrage (anfrage)" })).item;
  assert.deepEqual([half.state, half.form_registered, half.site_verified, half.submission_id, half.verified, half.verify_missing], [cf.STATES.NEW, true, false, null, false, ["form_site_not_verified", "no_submission_id"]]);
});

test("Betreff «… – submission from helvetic-webdesign-reperatur (anfrage)» → Formular «anfrage», Site verifiziert, VERIFIED mit RFC-Message-ID", () => {
  const msg = netlifyMail({ rfc: "<abc123.formresponses@netlify.com>" });
  const { item } = classify(msg);
  assert.deepEqual([item.form_name, item.form_registered, item.site_verified, item.mailbox_verified], ["anfrage", true, true, true]);
  assert.deepEqual([item.submission_id, item.submission_id_source], ["<abc123.formresponses@netlify.com>", "rfc_message_id"]);
  assert.deepEqual([item.verified, item.verification, item.verify_missing], [true, "CONTACT_FORM_VERIFIED", []]);
  // Fehlt der RFC-Header, gilt die Gmail-ID (eigene Kennzeichnung).
  const gm = classify(netlifyMail({ rfc: "" })).item;
  assert.deepEqual([gm.submission_id, gm.submission_id_source, gm.verified], [gm.message_id, "gmail_message_id", true]);
  // Eine echte Anbieter-ID hat Vorrang und bleibt «provider».
  const withId = classify(netlifyMail({ body: bodyOf() + "\nhttps://app.netlify.com/sites/helvetic-webdesign-reperatur/forms/anfrage/submissions/5f0123456789abcdef01" })).item;
  assert.deepEqual([withId.submission_id, withId.submission_id_source], ["5f0123456789abcdef01", "provider"]);
  // Fremde Site im Betreff → Ersatz-ID greift NICHT.
  const foreign = classify(netlifyMail({ subject: "Neue Kundenanfrage – submission from kunden-shop (anfrage)" })).item;
  assert.deepEqual([foreign.site_verified, foreign.submission_id, foreign.verified, foreign.verify_missing], [false, null, false, ["form_site_not_verified", "no_submission_id"]]);
  // Ohne bekanntes Postfach (nicht Delivered-To/receivingMailboxes) → ebenfalls keine Ersatz-ID.
  const nobox = cf.classifyInbound({ ...msg, to: "x@y.ch", deliveredTo: "x@y.ch" }, { cfg: { ...cf.DEFAULT_CONTACT_FORM_CONFIG, forms: CFG.forms }, ownAddresses: OWN }).item;
  assert.deepEqual([nobox.mailbox_verified, nobox.submission_id, nobox.verified], [false, null, false]);
  // Gefälschter Absender (kein DKIM/DMARC-Pass) → gar kein Kontaktformular.
  assert.deepEqual(classify(netlifyMail({ auth: [] })), { contactForm: false, reason: "untrusted_sender", provider: "netlify" });
});

test("Kundenfelder beeinflussen weder Empfänger noch Verifikation; Website nur URL-validiert, Interesse ≤ 80 Zeichen", () => {
  const ok = (website) => classify(netlifyMail({ body: bodyOf({ website }) })).item;
  assert.equal(ok("www.muster-garage.ch").customer_website, "https://www.muster-garage.ch/");
  assert.equal(ok("http://muster-garage.ch/pfad/seite?x=1#y").customer_website, "http://muster-garage.ch/pfad/seite");
  for (const bad of ["javascript:alert(1)", "https://user:pw@evil.ch/", "ftp://muster-garage.ch", "localhost", "http://10.0.0.1/", "https://muster-garage.ch:8443/", "kein url", "https://a.ch/<script>"]) {
    const it = ok(bad);
    assert.equal(it.customer_website, null, bad);
    assert.deepEqual([it.verified, it.customer_email, it.recipient_source], [true, "anna@muster-garage.ch", "form_field"], `${bad}: Empfänger/Verifikation unverändert`);
  }
  const long = classify(netlifyMail({ body: bodyOf({ interest: "Reparatur\tund  mehr " + "x".repeat(200) }) })).item;
  assert.ok(long.interest.length <= 80 && !/[\t\n]/.test(long.interest));
  // Eine Adresse im Website-/Interessenfeld wird nie Empfänger.
  const sneaky = classify(netlifyMail({ body: bodyOf({ website: "https://boese.example/?to=opfer@x.ch", interest: "opfer@x.ch" }) })).item;
  assert.equal(sneaky.customer_email, "anna@muster-garage.ch");
  // CRM-Sicht: nur validierte URL / ≤ 80 Zeichen.
  const clean = cleanContactForm({ status: "NEW", lead_source: "CONTACT_FORM", customer_website: "javascript:alert(1)", interest: "ok" });
  assert.deepEqual([clean.customer_website, clean.interest], [null, "ok"]);
  assert.equal(cleanContactForm({ status: "NEW", lead_source: "CONTACT_FORM", customer_website: "https://muster-garage.ch/" }).customer_website, "https://muster-garage.ch/");
});

// ======================================================================================================================================
// 2. Verarbeitung: genau eine Antwort / nur Entwurf / Idempotenz / Test-Einsendung
// ======================================================================================================================================
test("mit Konfiguration: VERIFIED und GENAU EINE automatische Antwort; CRM-Lead mit Website/Interesse", async () => {
  add(netlifyMail({ id: "00000000000000a1" }));
  const r = await run();
  assert.equal(r.sent, 1);
  const it = items()[0];
  assert.deepEqual([it.state, it.verified, it.submission_id_source, it.is_test, it.customer_email], [cf.STATES.SENT, true, "rfc_message_id", false, "anna@muster-garage.ch"]);
  assert.deepEqual(g.calls.filter((c) => c.startsWith("create")), ["create anna@muster-garage.ch CONTACT_FORM_AUTO_REPLY"]);
  assert.equal(sends().length, 1);
  const lead = readJ(cf.CONTACT_FORMS_PUBLIC_FILE).leads["muster-garage.ch"];
  assert.deepEqual([lead.status, lead.verified, lead.customer_website, lead.interest], ["REPLY_SENT", true, "https://www.muster-garage.ch/", "Reparatur"]);
  assert.equal(lead.website, "https://muster-garage.ch/", "Audit-/CRM-Website bleibt aus der Geschäftsadresse – nie aus dem Kundenfeld");
});

test("doppelte Zustellung (gleiche RFC-Message-ID, andere Gmail-ID) und weitere Durchläufe → genau eine Antwort", async () => {
  const rfc = "<dup-1@netlify.com>";
  add(netlifyMail({ id: "00000000000000b1", rfc }));
  await run();
  add(netlifyMail({ id: "00000000000000b2", rfc }));
  clock = new Date(+clock + 5 * 60_000);
  await run();
  await run();
  assert.equal(sends().length, 1, "keine zweite Antwort");
  assert.equal(items().length, 1);
  // Eine echte zweite Einsendung (neue Message-ID) ist eine neue Interaktion.
  add(netlifyMail({ id: "00000000000000b3", at: new Date(+T0 + 3_600_000) }));
  clock = new Date(+T0 + 3_700_000);
  await run();
  assert.equal(sends().length, 2);
});

test("ohne Registrierung oder ohne Site-Verifikation: nur Entwurf, nie Versand", async () => {
  add(netlifyMail({ id: "00000000000000c1", subject: SUBJECT_REAL }));
  await run({ receivingMailboxes: [MAILBOX] }); // keine Registrierung
  let it = items()[0];
  assert.deepEqual([it.state, it.verification, it.verify_missing.includes("no_submission_id")], [cf.STATES.DRAFTED, "CONTACT_FORM_REVIEW_REQUIRED", true]);
  assert.equal(sends().length, 0);
  assert.deepEqual(g.calls.filter((c) => c.startsWith("create")), ["create anna@muster-garage.ch CONTACT_FORM_DRAFT_ONLY"]);
  // Registriert, aber Betreff ohne Site (nur Formularname): ebenfalls nur Entwurf.
  fs.rmSync(dir, { recursive: true }); fs.mkdirSync(dir); g = fakeGmail();
  add(netlifyMail({ id: "00000000000000c2", subject: "Neue Kundenanfrage (anfrage)" }));
  await run();
  it = items()[0];
  assert.deepEqual([it.state, it.verified, it.submission_id], [cf.STATES.DRAFTED, false, null]);
  assert.equal(sends().length, 0);
});

test("Test-Einsendung (Eigentümername oder «testrun/testlauf/ohne echtgeld»): Antwort wie gewohnt, TF-080: CRM-Eintrag nur als TEST (eigene Identität), is_test im Status", async () => {
  assert.equal(cf.isTestSubmission({ name: "Chris Kälin", ownAddresses: [MAILBOX] }), true, "Umlaut-tolerant: Kälin ↔ kaelin");
  assert.equal(cf.isTestSubmission({ name: "Kaelin Chris", ownAddresses: [MAILBOX] }), true, "Reihenfolge egal");
  assert.equal(cf.isTestSubmission({ name: "Chris Meier", ownAddresses: [MAILBOX] }), false);
  assert.equal(cf.isTestSubmission({ name: "Chris", ownAddresses: [MAILBOX] }), false, "Vorname allein ist kein Eigentümer");
  assert.equal(cf.isTestSubmission({ name: "Anna Muster", ownAddresses: [MAILBOX], message: "Das ist ein TESTLAUF ohne Echtgeld." }), true);
  assert.equal(cf.isTestSubmission({ name: "Anna Muster", ownAddresses: [MAILBOX], message: "Mein Testament ist offen." }), false);
  assert.equal(cf.isTestSubmission({ name: "Max Info", ownAddresses: ["info@x.ch"] }), false, "zu kurzer Local-Part zählt nicht");
  add(netlifyMail({ id: "00000000000000d1", body: bodyOf({ name: "Chris Kälin", email: "chris.test@kaelin-test.ch" }) }));
  add(netlifyMail({ id: "00000000000000d2", body: bodyOf({ name: "Anna Muster", email: "anna@echt-firma.ch", message: "testrun: Formular prüfen, ohne Echtgeld" }) }));
  add(netlifyMail({ id: "00000000000000d3", body: bodyOf({ name: "Bea Echt", email: "bea@echt-firma2.ch", message: "Unsere Seite lädt nicht." }) }));
  const r = await run();
  assert.equal(r.sent, 3, "alle drei werden beantwortet");
  const byMail = Object.fromEntries(items().map((x) => [x.customer_email, x]));
  assert.deepEqual([byMail["chris.test@kaelin-test.ch"].is_test, byMail["anna@echt-firma.ch"].is_test, byMail["bea@echt-firma2.ch"].is_test], [true, true, false]);
  assert.deepEqual([byMail["chris.test@kaelin-test.ch"].state, byMail["anna@echt-firma.ch"].state], [cf.STATES.SENT, cf.STATES.SENT]);
  // TF-080 (ersetzt TF-077C «kein CRM-Lead»): Tests erscheinen als TEST-Einträge test-cf-<hash>, nie unter der echten Domain/Adresse.
  const pub = readJ(cf.CONTACT_FORMS_PUBLIC_FILE).leads;
  const real = Object.keys(pub).filter((k) => !k.startsWith("test-cf-")), tests = Object.values(pub).filter((x) => x.is_test === true);
  assert.deepEqual(real, ["echt-firma2.ch"], "nur die echte Anfrage erzeugt einen echten CRM-Lead");
  assert.equal(tests.length, 2);
  for (const x of tests) assert.deepEqual([x.environment, /^e2e-[0-9a-f]{12}$/.test(x.test_run_id), x.e2e_run, x.test_historical], ["TEST", true, false, false], "TEST, ohne E2E-Freigabe kein aktiver Lauf");
  assert.ok(!Object.keys(pub).includes("echt-firma.ch") && !Object.keys(pub).includes("kaelin-test.ch"), "nie unter der Domain eines echten Leads");
});
