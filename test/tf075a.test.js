// TF-075A: Kontaktformular-Anfragen = P0 (höchste Mail-Priorität) + Gmail-ENTWURF (nie Versand).
// Erkennung (Anbieter + Gmail-DKIM/DMARC, nie nur From), FIFO, defekte P0 blockieren nie, Empfänger-Validierung, exakte Zuordnung,
// CH/VN-Vorlagen, genau ein Entwurf je Anfrage, CRM-Abzeichen. Ohne Netz – Gmail ist eine Attrappe. 0 Sends, 0 Anrufe, 0 Zahlungen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, createStore } from "../mail-worker.js";
import {
  classifyInbound, validateCustomerEmail, selectCustomerEmail, matchInquiry, orderMailQueue, priorityOf, inboundQuery, authPassFor,
  CONTACT_FORM_CLASS, CONTACT_FORM_DRAFT_MODE, CONTACT_FORMS_FILE, CONTACT_FORMS_PUBLIC_FILE, STATES, MATCH, MAX_ATTEMPTS, publicContactForms,
} from "../contact-form.js";
import { VN_SIGNATURE } from "../sender-profiles.js";
import { buildCrmLead, cleanCrmLead } from "../lead-crm.js";
import { canSeeLead } from "../sales-scope.js";
import { COLD_DRAFTS_FILE, COLD_MODE } from "../swiss-repair.js";

// gmail.js liest sein Secrets-Verzeichnis beim Import: leeres Test-Verzeichnis, nie die echten Gmail-Zugangsdaten.
process.env.JARVIS_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf075a-sec-"));
const { assertSendable, NEVER_SEND_MODES, searchInbound } = await import("../gmail.js");
const T0 = new Date("2026-10-16T08:00:00Z"); // 10:00 Zürich
let dir, g, clock, orders;

const AUTH = (d) => `mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@${d}; dmarc=pass (p=NONE) header.from=${d}`;
const FAIL = (d) => `mx.google.com; dkim=fail header.i=@${d}; spf=softfail smtp.mailfrom=evil.example; dmarc=fail (p=NONE) header.from=${d}`;
let seq = 0;
const hex = () => (0x1a2b3c4d00 + ++seq).toString(16).padStart(16, "0");
function formMsg({ id = hex(), at = T0, from = "Netlify Forms <formresponses@netlify.com>", replyTo = "Anna Kunde <anna@kunde-firma.ch>", auth = [AUTH("netlify.com")],
  subject = "[Netlify] New form submission from helvetic-webdesign (kontakt)", name = "Anna Kunde", email = "anna@kunde-firma.ch",
  message = "Unsere Website lädt sehr langsam. Können Sie uns helfen?", sub = "5f" + id.slice(0, 20), body = null, rfc = null } = {}) {
  return { messageId: id, rfcMessageId: rfc || `<${id}@netlify.com>`, threadId: "th-" + id, from, replyTo, to: "chris@x.ch", deliveredTo: "chris@x.ch", subject,
    date: at.toUTCString(), internalDate: +at, sent: false, draft: false,
    body: body ?? [`Name: ${name}`, ...(email ? [`Email: ${email}`] : []), `Message: ${message}`, "", `https://app.netlify.com/sites/x/forms/abc/submissions/${sub}`].join("\n"),
    headers: { "authentication-results": auth } };
}

function fakeGmail() {
  const f = {
    reg: { labelId: "L", drafts: {}, sent: {} }, threads: {}, inbound: {}, calls: [], n: 0, failCreate: new Set(),
    listOwned: () => structuredClone(f.reg),
    async searchInbound({ query }) {
      f.calls.push("search");
      assert.match(query, /^from:\(/);
      return Object.values(f.inbound).sort((a, b) => b.internalDate - a.internalDate).map((m) => m.messageId); // Gmail: neueste zuerst
    },
    async readInbound(id) { f.calls.push("readInbound " + id); if (!f.inbound[id]) throw new Error("not found"); return structuredClone(f.inbound[id]); },
    async readThread(threadId) {
      f.calls.push("read " + threadId);
      if (!Object.values(f.reg.sent).some((s) => s.threadId === threadId)) throw new Error("nicht von Jarvis begonnen");
      return { threadId, messages: structuredClone(f.threads[threadId] || []) };
    },
    async replyToThread(threadId, { body }) { f.calls.push("reply " + threadId); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId, to: "x", body, createdAt: clock.toISOString() }; return { draftId: id, threadId }; },
    async createDraft({ to, subject, body, mode, contactFormKey }) {
      if (f.failCreate.has(to)) throw new Error("Ungültiger Empfänger (permanent)");
      f.calls.push(`create ${to} ${mode || "-"}`);
      const id = "dr" + ++f.n;
      f.reg.drafts[id] = { threadId: "t" + id, messageId: "m" + id, to, subject, body, mode, contactFormKey, createdAt: clock.toISOString() };
      return { draftId: id, messageId: "m" + id, threadId: "t" + id };
    },
    async updateDraft(id) { f.calls.push("update " + id); return { draftId: id }; },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft(id) { f.calls.push("SEND " + id); assertSendable(id, f.reg); throw new Error("unerwartet"); },
  };
  return f;
}
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const live = (extra = {}) => write("config.json", { dryRun: false, offer: "Ich prüfe Websites.", sender: { name: "Chris Muster", company: "Helvetic Webdesign", signature: "Chris Muster\nHelvetic Webdesign", email: "chris@x.ch" }, ...extra });
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", reason: "", subject: "Re", body: "Guten Tag, danke." }), contactOrders: () => orders });
const add = (m) => { g.inbound[m.messageId] = m; return m; };
const cfDrafts = () => Object.values(g.reg.drafts).filter((d) => d.mode === CONTACT_FORM_DRAFT_MODE);
const items = () => Object.values(read(CONTACT_FORMS_FILE).items);
const sends = () => g.calls.filter((c) => c.startsWith("SEND"));

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf075a-")); g = fakeGmail(); clock = T0; orders = {}; live(); });

// ---------- 22. Erkennung ----------
test("Erkennung: gültige Netlify-Formular-Benachrichtigung → CONTACT_FORM_INQUIRY / P0", () => {
  const c = classifyInbound(formMsg());
  assert.equal(c.contactForm, true);
  assert.equal(c.item.message_class, CONTACT_FORM_CLASS);
  assert.equal(c.item.priority, "P0");
  assert.equal(c.item.source_provider, "netlify");
  assert.equal(c.item.form_name, "kontakt");
  assert.equal(c.item.state, STATES.NEW);
  assert.equal(c.item.customer_email, "anna@kunde-firma.ch");
  assert.ok(c.item.submission_id, "Submission-ID erkannt");
});

test("Erkennung: anderer bekannter Anbieter (Formspree) und konfigurierter eigener Anbieter → CONTACT_FORM_INQUIRY", () => {
  const fs1 = classifyInbound(formMsg({ from: "Formspree <noreply@formspree.io>", auth: [AUTH("formspree.io")], subject: "New submission from kunde-firma.ch" }));
  assert.equal(fs1.contactForm, true);
  assert.equal(fs1.item.source_provider, "formspree");
  const cfg = { providers: [{ id: "jarvis-landing", from: ["forms@helvetic-webdesign.ch"], dkim: ["helvetic-webdesign.ch"] }] };
  const own = classifyInbound(formMsg({ from: "forms@helvetic-webdesign.ch", auth: [AUTH("helvetic-webdesign.ch")] }), { cfg });
  assert.equal(own.contactForm, true);
  assert.equal(own.item.source_provider, "jarvis-landing");
  assert.match(inboundQuery(cfg), /formresponses@netlify\.com OR noreply@formspree\.io OR forms@helvetic-webdesign\.ch/);
});

test("Erkennung: gewöhnliche Direktmail wird nicht als Kontaktformular eingestuft", () => {
  const c = classifyInbound(formMsg({ from: "Anna Kunde <anna@kunde-firma.ch>", auth: [AUTH("kunde-firma.ch")] }));
  assert.equal(c.contactForm, false);
  assert.equal(c.reason, "not_a_form_provider");
});

test("Erkennung: gefälschter From allein wird nie vertraut (kein DKIM / fremder Auth-Header / DKIM einer anderen Domain)", () => {
  for (const auth of [[], [FAIL("netlify.com")], [FAIL("netlify.com"), AUTH("netlify.com")], [AUTH("evil.example")],
    ["attacker.example; dkim=pass header.i=@netlify.com; dmarc=pass header.from=netlify.com"], [AUTH("netlify.com.evil.example")]]) {
    const c = classifyInbound(formMsg({ auth }));
    assert.equal(c.contactForm, false, JSON.stringify(auth));
    assert.equal(c.reason, "untrusted_sender");
  }
  assert.equal(authPassFor({ "authentication-results": [AUTH("mail.netlify.com")] }, ["netlify.com"]), true, "Subdomain des Anbieters zählt");
});

test("Erkennung: ungültige Benachrichtigung → abgelehnt; unregistriertes Formular → Prüfung", () => {
  const empty = classifyInbound(formMsg({ body: "Hallo, hier ist eine Benachrichtigung ohne Formularfelder." }));
  assert.equal(empty.item.state, STATES.INVALID);
  const noMsg = classifyInbound(formMsg({ body: "Name: Anna\nEmail: anna@kunde-firma.ch" }));
  assert.equal(noMsg.item.state, STATES.INVALID);
  const unknown = classifyInbound(formMsg(), { cfg: { forms: [{ form_name: "offerte" }] } });
  assert.equal(unknown.item.state, STATES.UNKNOWN_FORM);
  const known = classifyInbound(formMsg(), { cfg: { forms: [{ form_name: "Kontakt", market: "VN" }] } });
  assert.equal(known.item.state, STATES.NEW);
  assert.equal(known.item.form_market, "VN");
});

test("Empfangspostfach konfiguriert: Benachrichtigung an ein anderes Postfach ist kein Kontaktformular", () => {
  const c = classifyInbound(formMsg(), { cfg: { receivingMailboxes: ["kontakt@helvetic-webdesign.ch"] } });
  assert.equal(c.contactForm, false);
  assert.equal(classifyInbound({ ...formMsg(), deliveredTo: "kontakt@helvetic-webdesign.ch" }, { cfg: { receivingMailboxes: ["kontakt@helvetic-webdesign.ch"] } }).contactForm, true);
});

// ---------- 23. Priorität ----------
test("Priorität: Cold-Entwurf + gewöhnliche Kundenmail + Kontaktformular → Kontaktformular zuerst verarbeitet", async () => {
  // Cold-Entwurf (P3) in der Queue
  write(COLD_DRAFTS_FILE, { reviews: { "laden.ch": { lead_id: "laden.ch", domain: "laden.ch", company: "Laden AG", recipient: "info@laden.ch", subject: "Ihre Website", body: "Guten Tag",
    draft_mode: COLD_MODE, status: "queued", created_at: "2026-10-15T08:00:00Z" } } });
  // gewöhnliche Kundenantwort (P1/P2) im eigenen Thread
  g.reg.sent["s-t1"] = { messageId: "s-t1", threadId: "t1", to: "kunde@firma.ch", subject: "Ihre Website", sentAt: "2026-10-15T08:00:00Z" };
  g.threads.t1 = [{ messageId: "s-t1", from: "chris@x.ch", to: "kunde@firma.ch", subject: "Ihre Website", body: "Hallo", sent: true, draft: false, internalDate: Date.parse("2026-10-15T08:00:00Z") },
    { messageId: "in-1", from: "kunde@firma.ch", to: "chris@x.ch", subject: "Re: Ihre Website", body: "Gerne, wann?", sent: false, draft: false, internalDate: Date.parse("2026-10-15T09:00:00Z") }];
  add(formMsg({ at: new Date("2026-10-16T07:59:00Z") })); // jüngste Mail – trotzdem zuerst
  const r = await worker().tick();
  const writes = g.calls.filter((c) => /^(create|reply|read )/.test(c));
  assert.match(writes[0], new RegExp(`^create anna@kunde-firma\\.ch ${CONTACT_FORM_DRAFT_MODE}$`), "erster Schritt = Kontaktformular-Entwurf");
  assert.ok(g.calls.indexOf(writes[0]) < g.calls.indexOf("read t1"), "vor gewöhnlicher Kundenmail");
  assert.ok(g.calls.indexOf(writes[0]) < g.calls.findIndex((c) => c.startsWith("create info@laden.ch")), "vor Cold-Entwurf");
  assert.equal(r.contactForms.drafted, 1);
  assert.deepEqual(sends(), []);
  assert.ok(priorityOf({ message_class: CONTACT_FORM_CLASS }) < priorityOf({ message_class: "CUSTOMER_ORDER_MAIL" }));
  assert.deepEqual(orderMailQueue([{ message_class: "COLD_OUTREACH_DRAFT", received_at: "2026-01-01" }, { message_class: "CUSTOMER_MAIL", received_at: "2026-01-01" },
    { message_class: CONTACT_FORM_CLASS, received_at: "2026-12-31" }]).map((x) => x.message_class), [CONTACT_FORM_CLASS, "CUSTOMER_MAIL", "COLD_OUTREACH_DRAFT"]);
});

test("Priorität: 3 Kontaktformulare → ältestes zuerst (FIFO, stabile ID bei Gleichstand)", async () => {
  add(formMsg({ id: "0000000000000c03", at: new Date("2026-10-16T07:30:00Z"), replyTo: "c@drei.ch", email: "c@drei.ch" }));
  add(formMsg({ id: "0000000000000a01", at: new Date("2026-10-16T06:00:00Z"), replyTo: "a@eins.ch", email: "a@eins.ch" }));
  add(formMsg({ id: "0000000000000b02", at: new Date("2026-10-16T07:00:00Z"), replyTo: "b@zwei.ch", email: "b@zwei.ch" }));
  await worker().tick();
  assert.deepEqual(g.calls.filter((c) => c.startsWith("create")).map((c) => c.split(" ")[1]), ["a@eins.ch", "b@zwei.ch", "c@drei.ch"]);
  const tie = orderMailQueue([{ message_class: CONTACT_FORM_CLASS, received_at: "x", message_id: "b" }, { message_class: CONTACT_FORM_CLASS, received_at: "x", message_id: "a" }]);
  assert.deepEqual(tie.map((x) => x.message_id), ["a", "b"]);
});

test("Priorität: defekte P0-Nachricht blockiert die nächste gültige nie und wird nicht endlos wiederholt", async () => {
  add(formMsg({ id: "00000000000000e1", at: new Date("2026-10-16T06:00:00Z"), replyTo: "kaputt@defekt.ch", email: "kaputt@defekt.ch" }));
  add(formMsg({ id: "00000000000000e2", at: new Date("2026-10-16T06:01:00Z"), body: "kein Formular" })); // ungültig
  add(formMsg({ id: "00000000000000e3", at: new Date("2026-10-16T07:00:00Z"), replyTo: "ok@gut.ch", email: "ok@gut.ch" }));
  g.failCreate.add("kaputt@defekt.ch");
  await worker().tick();
  assert.deepEqual(cfDrafts().map((d) => d.to), ["ok@gut.ch"], "gültige P0 im selben Durchlauf verarbeitet");
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { clock = new Date(+clock + 5 * 60_000); await worker().tick(); }
  const st = Object.fromEntries(items().map((x) => [x.message_id, x]));
  assert.equal(st["00000000000000e1"].state, STATES.FAILED);
  assert.equal(st["00000000000000e1"].attempts, MAX_ATTEMPTS, "kein endloses Wiederholen");
  assert.equal(st["00000000000000e2"].state, STATES.INVALID);
  assert.equal(cfDrafts().length, 1);
});

test("Gmail vorübergehend gestört: P0 bleibt offen (Reihenfolge erhalten), nächster Durchlauf erstellt genau einen Entwurf", async () => {
  add(formMsg());
  const orig = g.createDraft;
  g.createDraft = async () => { throw new Error("Gmail POST /drafts: 503"); };
  const r1 = await worker().tick();
  assert.equal(r1.gmail.status, "DEGRADED");
  assert.equal(items()[0].state, STATES.NEW);
  g.createDraft = orig;
  clock = new Date(+clock + 5 * 60_000);
  await worker().tick();
  assert.equal(cfDrafts().length, 1);
  assert.equal(items()[0].state, STATES.DRAFTED);
});

// ---------- 24. Empfänger ----------
test("Empfänger: verifiziertes Reply-To wird verwendet", () => {
  const c = classifyInbound(formMsg({ replyTo: "Anna <anna@kunde-firma.ch>", email: null }));
  assert.equal(c.item.customer_email, "anna@kunde-firma.ch");
  assert.equal(c.item.recipient_source, "reply_to");
});

test("Empfänger: ohne Reply-To → validiertes E-Mail-Feld des Formulars", () => {
  const c = classifyInbound(formMsg({ replyTo: "", email: "Max@Firma-Max.ch" }));
  assert.equal(c.item.customer_email, "max@firma-max.ch");
  assert.equal(c.item.recipient_source, "form_field");
  assert.equal(selectCustomerEmail({ form: { customer_email: "kunde@registriert.ch" } }).source, "registered_form");
});

test("Empfänger: Anbieter-/No-reply-Adresse wird nie als Kunde gewählt", () => {
  const c = classifyInbound(formMsg({ replyTo: "formresponses@netlify.com", email: null }));
  assert.equal(c.item.state, STATES.RECIPIENT_REVIEW);
  assert.equal(c.item.customer_email, undefined);
  for (const a of ["noreply@kunde.ch", "no-reply@kunde.ch", "do-not-reply@kunde.ch", "x@netlify.com", "notifications@formspree.io", "mailer-daemon@kunde.ch"])
    assert.equal(validateCustomerEmail(a).ok, false, a);
  assert.equal(validateCustomerEmail("chris@x.ch", { ownAddresses: ["chris@x.ch"] }).reason, "own_address");
});

test("Empfänger: ungültige Adresse → CONTACT_FORM_RECIPIENT_REVIEW_REQUIRED, kein Entwurf", async () => {
  for (const bad of ["anna@", "anna kunde@x.ch", "anna@x", "@x.ch", "anna@x..ch"]) assert.equal(validateCustomerEmail(bad).ok, false, bad);
  add(formMsg({ replyTo: "", email: "anna(at)kunde-firma.ch" }));
  await worker().tick();
  assert.equal(items()[0].state, STATES.RECIPIENT_REVIEW);
  assert.equal(cfDrafts().length, 0);
  assert.deepEqual(sends(), []);
});

test("Empfänger: Header-Injection und mehrere Empfänger werden blockiert", () => {
  assert.equal(validateCustomerEmail("anna@x.ch\r\nBcc: evil@y.com").reason, "header_injection");
  assert.equal(validateCustomerEmail("anna@x.ch%0ABcc:evil@y.com").reason, "header_injection");
  assert.equal(validateCustomerEmail("anna@x.ch, evil@y.com").ok, false);
  assert.equal(validateCustomerEmail("anna@x.ch;evil@y.com").ok, false);
  assert.equal(validateCustomerEmail("A <anna@x.ch> <evil@y.com>").ok, false);
  assert.equal(classifyInbound(formMsg({ replyTo: "anna@x.ch\r\nBcc: evil@y.com", email: null })).item.reason, "header_injection");
  assert.equal(classifyInbound(formMsg({ replyTo: "", email: "anna@x.ch%0D%0ABcc:evil@y.com" })).item.state, STATES.RECIPIENT_REVIEW);
  // Zeilenumbruch im Formulartext wird zu einem eigenen Feld – Empfänger bleibt genau die eine Adresse, nie die eingeschleuste.
  const nl = classifyInbound(formMsg({ replyTo: "", email: "anna@x.ch\nBcc: evil@y.com" }));
  assert.equal(nl.item.customer_email, "anna@x.ch");
  assert.ok(!JSON.stringify(nl.item).includes("evil@"));
  assert.equal(selectCustomerEmail({ replyTo: "anna@x.ch", fieldEmail: "andere@y.ch" }).reason, "reply_to_field_mismatch", "Widerspruch → Prüfung statt raten");
});

// ---------- 25. Entwurf ----------
test("Entwurf: gültige Anfrage → genau 1 Gmail-Entwurf (CONTACT_FORM_DRAFT_ONLY), nichts gesendet – auch mit compliant_auto", async () => {
  live({ sendMode: "compliant_auto" });
  add(formMsg());
  const r = await worker().tick();
  assert.equal(cfDrafts().length, 1);
  assert.equal(cfDrafts()[0].to, "anna@kunde-firma.ch");
  assert.equal(items()[0].state, STATES.DRAFTED);
  assert.deepEqual(sends(), []);
  assert.equal(r.sends.length, 0);
  assert.ok(!Object.values(read("state.json").actions).length, "nie in der Send-Queue (state.actions)");
  assert.ok(NEVER_SEND_MODES.includes(CONTACT_FORM_DRAFT_MODE));
  assert.throws(() => assertSendable("dr1", g.reg), /CONTACT_FORM_DRAFT_ONLY/, "gmail.js verweigert jeden Send");
  const stored = fs.readFileSync(path.join(dir, CONTACT_FORMS_FILE), "utf8");
  assert.ok(!stored.includes("lädt sehr langsam"), "Mailtext wird nie gespeichert");
});

test("Entwurf: dieselbe Nachricht zweimal / doppelte Zustellung desselben Anbieter-Events → weiterhin genau 1 Entwurf", async () => {
  const m = add(formMsg({ sub: "abcdef0123456789abcd" }));
  await worker().tick();
  clock = new Date(+clock + 5 * 60_000);
  await worker().tick();
  assert.equal(cfDrafts().length, 1);
  add(formMsg({ sub: "abcdef0123456789abcd", rfc: "<other@netlify.com>" })); // gleiche Submission, andere Gmail-ID
  clock = new Date(+clock + 5 * 60_000);
  const r = await worker().tick();
  assert.equal(cfDrafts().length, 1);
  assert.equal(r.contactForms.duplicates, 1);
  assert.equal(m.messageId, items()[0].message_id);
});

test("Entwurf: Absturz während des Entwurfs → nie ein zweiter Entwurf (Register-Abgleich bzw. Prüfung)", async () => {
  add(formMsg());
  const orig = g.createDraft;
  g.createDraft = async (x) => { await orig(x); throw new Error("Prozess abgestürzt"); }; // Entwurf entstand, Speichern nicht
  // Zustand „drafting“ simulieren: erster Lauf schreibt drafting, dann Fehler → NEW (attempt 1). Danach Registerabgleich.
  const st = { v: 1, items: {}, seen: {} };
  const c = classifyInbound(formMsg());
  st.items[c.item.key] = { ...c.item, state: STATES.DRAFTING, drafting_at: T0.toISOString(), attempts: 0 };
  g.reg.drafts.drX = { to: "anna@kunde-firma.ch", mode: CONTACT_FORM_DRAFT_MODE, contactFormKey: c.item.key, messageId: "mX", createdAt: T0.toISOString() };
  write(CONTACT_FORMS_FILE, st);
  g.inbound = {};
  g.createDraft = orig;
  await worker().tick();
  assert.equal(items()[0].state, STATES.DRAFTED);
  assert.equal(items()[0].draft_id, "drX");
  assert.equal(cfDrafts().length, 1);
  // ohne Registereintrag und abgelaufen → unklar, nie wiederholt
  write(CONTACT_FORMS_FILE, { v: 1, items: { [c.item.key]: { ...c.item, state: STATES.DRAFTING, drafting_at: T0.toISOString(), attempts: 0 } }, seen: {} });
  delete g.reg.drafts.drX;
  clock = new Date(+T0 + 11 * 60_000);
  await worker().tick();
  assert.equal(items()[0].state, STATES.DRAFT_UNKNOWN);
  assert.equal(cfDrafts().length, 0);
});

test("Entwurf: zweite, wirklich neue Anfrage desselben Kunden → neuer P0-Entwurf", async () => {
  add(formMsg({ at: new Date("2026-10-16T06:00:00Z") }));
  await worker().tick();
  add(formMsg({ at: new Date("2026-10-16T09:00:00Z"), message: "Noch eine Frage zur Offerte." }));
  clock = new Date("2026-10-16T09:05:00Z");
  await worker().tick();
  assert.equal(cfDrafts().length, 2);
  assert.ok(cfDrafts().every((d) => d.to === "anna@kunde-firma.ch"));
});

test("Entwurf CH: Deutsch, Anfrage-Kontext, bestehende Signatur, keine Abmeldezeile/kein KI-Hinweis", async () => {
  add(formMsg());
  await worker().tick();
  const d = cfDrafts()[0];
  assert.equal(d.subject, "Ihre Anfrage über unser Kontaktformular");
  assert.match(d.body, /^Guten Tag Anna Kunde/);
  assert.match(d.body, /Vielen Dank für Ihre Nachricht über unser Kontaktformular/);
  assert.match(d.body, /> Unsere Website lädt sehr langsam/);
  assert.match(d.body, /Freundliche Grüsse\n\nChris Muster\nHelvetic Webdesign$/);
  assert.doesNotMatch(d.body, /Abmelden|Jarvis|KI|Claude/);
  assert.equal(items()[0].language, "de");
  assert.equal(items()[0].market, "CH");
});

test("Entwurf VN: Vietnamesisch mit VN-Signatur (VN-Auftrag bzw. registriertes VN-Formular)", async () => {
  orders = { "VNFIX-20261015-a1b2c3": { order_id: "VNFIX-20261015-a1b2c3", customer_email: "lan@quan-pho.vn", market: "VN", lead_id: "quan-pho.vn", company: "Quán Phở", terminal: false } };
  add(formMsg({ replyTo: "lan@quan-pho.vn", email: "lan@quan-pho.vn", name: "Lan", message: "Xin chào, website của tôi bị lỗi." }));
  await worker().tick();
  const d = cfDrafts()[0];
  assert.match(d.body, /^Kính gửi Lan,/);
  assert.match(d.body, /Cảm ơn anh\/chị đã liên hệ/);
  assert.ok(d.body.endsWith(VN_SIGNATURE));
  assert.doesNotMatch(d.body, /Guten Tag|Freundliche/);
  assert.equal(items()[0].language, "vi");
  assert.equal(items()[0].match_state, MATCH.ORDER);
  const c = classifyInbound(formMsg(), { cfg: { forms: [{ form_name: "kontakt", market: "VN" }] } });
  assert.equal(c.item.form_market, "VN");
});

// ---------- 26. Zuordnung ----------
const LEADS = [{ lead_id: "kunde-firma.ch", domain: "kunde-firma.ch", emails: ["info@kunde-firma.ch"], market: "CH", company: "Kunde Firma AG" },
  { lead_id: "andere.ch", domain: "andere.ch", emails: ["anna@kunde-firma.ch.example"], market: "CH", company: "Anna Kunde GmbH" }];
const item = (email, extra = {}) => ({ customer_email: email, form_market: null, ...extra });

test("Zuordnung: exakter bekannter Lead → MATCHED_LEAD (Adresse bzw. exakte geschäftliche Domain)", async () => {
  assert.equal(matchInquiry({ item: item("info@kunde-firma.ch"), leads: LEADS }).match_state, MATCH.LEAD);
  const m = matchInquiry({ item: item("anna@kunde-firma.ch"), leads: LEADS });
  assert.equal(m.match_state, MATCH.LEAD);
  assert.equal(m.lead_id, "kunde-firma.ch");
  // im Worker: aus der Lead-Datenbank
  write("lead_registry.json", { schema: 1, leads: { "kunde-firma.ch": { lead_id: "kunde-firma.ch", domain: "kunde-firma.ch", business_email: "info@kunde-firma.ch", company: "Kunde Firma AG" } } });
  add(formMsg());
  await worker().tick();
  assert.equal(items()[0].match_state, MATCH.LEAD);
  assert.equal(items()[0].lead_id, "kunde-firma.ch");
  assert.deepEqual(read(CONTACT_FORMS_PUBLIC_FILE).leads["kunde-firma.ch"].status, "DRAFT_CREATED");
});

test("Zuordnung: exakter Auftrag → MATCHED_ORDER; Auftragsnummer mit fremder Adresse → Prüfung ohne fremden Kontext", () => {
  const ORD = { "CA150-20261010-abcdef": { order_id: "CA150-20261010-abcdef", customer_email: "anna@kunde-firma.ch", market: "CH", lead_id: "kunde-firma.ch", company: "Kunde Firma AG" } };
  const m = matchInquiry({ item: item("anna@kunde-firma.ch"), orders: ORD, leads: LEADS });
  assert.deepEqual([m.match_state, m.order_id, m.lead_id], [MATCH.ORDER, "CA150-20261010-abcdef", "kunde-firma.ch"]);
  const r = matchInquiry({ item: item("fremd@gmail.com"), text: "Betrifft Auftrag CA150-20261010-abcdef", orders: ORD, leads: LEADS });
  assert.deepEqual([r.match_state, r.order_id, r.lead_id, r.company], [MATCH.REVIEW, null, null, null]);
});

test("Zuordnung: unbekannte legitime Anfrage → UNMATCHED, Entwurf ohne fremden Kontext", async () => {
  write("lead_registry.json", { schema: 1, leads: { "kunde-firma.ch": { lead_id: "kunde-firma.ch", domain: "kunde-firma.ch", business_email: "info@kunde-firma.ch", company: "Kunde Firma AG" } } });
  add(formMsg({ replyTo: "neu@unbekannt-gmbh.ch", email: "neu@unbekannt-gmbh.ch", name: "Neu" }));
  await worker().tick();
  const it = items()[0];
  assert.deepEqual([it.match_state, it.lead_id, it.order_id, it.company], [MATCH.UNMATCHED, null, null, null]);
  assert.equal(cfDrafts().length, 1);
  assert.doesNotMatch(cfDrafts()[0].body, /Kunde Firma/);
  assert.deepEqual(read(CONTACT_FORMS_PUBLIC_FILE).leads, {}, "ohne Zuordnung kein CRM-Abzeichen");
});

test("Zuordnung: nur ähnlicher Kundenname → nie verknüpft", () => {
  const m = matchInquiry({ item: item("anna.kunde@gmail.com"), text: "Ich bin Anna Kunde von der Kunde Firma AG", leads: LEADS });
  assert.equal(m.match_state, MATCH.UNMATCHED);
  assert.equal(m.lead_id, null);
  const twoDomains = [{ lead_id: "a", domain: "x.ch", emails: [] }, { lead_id: "b", domain: "x.ch", emails: [] }];
  assert.equal(matchInquiry({ item: item("k@x.ch"), leads: twoDomains }).match_state, MATCH.REVIEW, "mehrdeutig → Prüfung");
});

// ---------- 17/18. CRM-Sichtbarkeit + RBAC ----------
test("CRM: CONTACT-FORM-Abzeichen nur mit Status-Wörtern, RBAC unverändert", () => {
  const pub = publicContactForms({ items: {
    a: { lead_id: "kunde-firma.ch", match_state: MATCH.LEAD, state: STATES.DRAFTED, received_at: "2026-10-16T08:00:00.000Z", customer_email: "anna@kunde-firma.ch" },
    b: { lead_id: null, match_state: MATCH.UNMATCHED, state: STATES.NEW, received_at: "2026-10-16T08:00:00.000Z", customer_email: "x@y.ch" } } });
  assert.deepEqual(Object.keys(pub.leads), ["kunde-firma.ch"]);
  assert.ok(!JSON.stringify(pub).includes("@"), "keine Adressen in der öffentlichen Sicht");
  const src = { registry: { leads: { "kunde-firma.ch": { lead_id: "kunde-firma.ch", domain: "kunde-firma.ch", status: "MANUALLY_SENT", company: "Kunde Firma AG" } } }, contactForms: pub };
  const lead = cleanCrmLead(buildCrmLead("kunde-firma.ch", src, T0));
  assert.deepEqual(lead.contact_form, { status: "DRAFT_CREATED", matched: true, received_at: "2026-10-16T08:00:00.000Z", count: 1 });
  assert.equal(cleanCrmLead({ ...lead, contact_form: { status: "<script>", matched: true } }).contact_form, undefined);
  assert.equal("contact_form" in buildCrmLead("kunde-firma.ch", { ...src, contactForms: { leads: {} } }, T0), false, "ohne Anfrage kein Feld (Sichtgrösse)");
  const doc = { assignments: { "kunde-firma.ch": { assigned_user_id: "mario", market: "CH" } } };
  assert.equal(canSeeLead({ role: "SALES_AGENT_CH", user_id: "mario" }, lead, doc), true);
  assert.equal(canSeeLead({ role: "SALES_AGENT_CH", user_id: "damiano" }, lead, doc), false, "kein Cross-Seller-Zugriff");
  assert.equal(canSeeLead({ role: "SALES_AGENT_VN", user_id: "kudoshin" }, lead, doc), false);
  assert.equal(canSeeLead({ role: "OWNER", user_id: "chris" }, lead, doc), true);
});

test("CRM-Agent: Sicht zu gross (413) → Aufträge trotzdem abgeholt, Sicht-Versand mit Backoff, Zustand sichtbar", async () => {
  const { createCrmAgent } = await import("../crm-service.js");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf075a-crm-"));
  let t = T0;
  const posts = [];
  const fetchFn = async (url, init) => {
    const b = JSON.parse(init.body);
    posts.push({ op: b.op, view: !!b.view });
    if (b.op === "pull" && b.view) return new Response(JSON.stringify({ error: "Zu gross." }), { status: 413 });
    return new Response(JSON.stringify({ ok: true, requests: [] }), { status: 200 });
  };
  const sources = () => ({ registry: { leads: { "kunde-firma.ch": { lead_id: "kunde-firma.ch", domain: "kunde-firma.ch", status: "MANUALLY_SENT", company: "Kunde Firma AG" } } }, reviews: {}, directory: { leads: {} } });
  const agent = createCrmAgent({ dataDir: data, sources, url: "https://jarvis.test", token: "x".repeat(40), fetchFn, now: () => t, log: () => {} });
  const r1 = await agent.pollOnce();
  assert.equal(r1.status, 200, "Pull ohne Sicht gelingt → Aufträge fliessen weiter");
  assert.deepEqual(posts.map((p) => [p.op, p.view]), [["pull", true], ["pull", false]]);
  assert.equal(agent.viewTooLarge(), true);
  t = new Date(+T0 + 60_000);
  await agent.pollOnce();
  assert.deepEqual(posts.slice(2).map((p) => p.view), [false], "Backoff: nicht bei jedem Takt erneut die ganze Sicht");
  t = new Date(+T0 + 31 * 60_000);
  await agent.pollOnce();
  assert.equal(posts.slice(3)[0].view, true, "nach VIEW_RESEND_MS erneuter Versuch");
});

test("Dry-Run/Plan: liest keine Inbox, legt keinen Entwurf an", async () => {
  write("config.json", { dryRun: true, sender: { name: "Chris" } });
  add(formMsg());
  await worker().tick();
  assert.ok(!g.calls.includes("search"));
  assert.equal(cfDrafts().length, 0);
});

test("gmail.searchInbound: echte Allowlist-Anfrage wird akzeptiert, freie Anfragen abgelehnt (ohne Netz)", async () => {
  for (const cfg of [{}, { providers: [{ id: "x", from: ["forms@helvetic-webdesign.ch"], dkim: ["helvetic-webdesign.ch"] }], newerThanDays: 7 }]) {
    // Allowlist-Prüfung bestanden → scheitert erst am fehlenden Gmail-Token (kein Netzaufruf), nie an der Allowlist.
    await assert.rejects(searchInbound({ query: inboundQuery(cfg) }), (e) => !/Allowlist/.test(e.message));
  }
  for (const q of ["in:inbox", "from:(a@b.ch) OR subject:rechnung", "from:(a@b.ch) -in:sent -in:drafts -in:spam -in:trash newer_than:14d label:INBOX", ""])
    await assert.rejects(searchInbound({ query: q }), /Allowlist/, q);
});

test("Store-Helfer: createStore schreibt contact_forms.json atomar (Regression Store-API)", () => {
  const s = createStore(dir);
  s.write(CONTACT_FORMS_FILE, { v: 1, items: {}, seen: {} });
  assert.deepEqual(s.read(CONTACT_FORMS_FILE, null), { v: 1, items: {}, seen: {} });
});
