// TF-077B – One-Click-Verkäufer-Mail («E-Mail lossenden»), Kontaktformular CONTACT_FORM_P0 (automatische verifizierte Antwort, eigener
// CRM-Abschnitt ganz oben, Rangfolge, Anruf-Gates) und Telefonbuch-Sternchen (Provider-Abstraktion, kein Massenabruf).
// Nur Fixtures: 0 echte E-Mails, 0 Anrufe, 0 Zahlungen, keine Kunden-Website wird angefasst.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JARVIS_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf077b-sec-"));
delete process.env.JARVIS_CRM_DIR;
const gmailMod = await import("../gmail.js");
const { createWorker, createStore } = await import("../mail-worker.js");
const { sanitizeMailRequest } = await import("../mail-requests.js");
const { draftRef, draftRefOf, mailAccessFor, SELLER_SEND_DAILY_LIMIT } = await import("../mail-access.js");
const cf = await import("../contact-form.js");
const { buildCrmLead, buildCrmView, cleanCrmLead, applyCrmAction, normalizeCrmState } = await import("../lead-crm.js");
const { sortLeads, crmStats, contactFormQueue, sellerSendState, crmAdmission, callRecommended } = await import("../public/crm-model.js");
const { eligibility } = await import("../calling-core.js");
const pb = await import("../phonebook-compliance.js");
const { setup, makeReq, PW } = await import("./tf063-helpers.js");
const { actorFor } = await import("../auth-core.js");

const T0 = new Date("2026-10-16T08:00:00Z"); // Fr 10:00 Zürich / 15:00 Hanoi
const COLD = "COLD_LEAD_DRAFT_ONLY";
const HEX = (i) => (0x1f00000000000000n + BigInt(i)).toString(16);
const draftUrlOf = (mid) => `https://mail.google.com/mail/u/0/#drafts?compose=${mid}`;

// ======================================================================================================================================
// 1. Seller-Policy + Cloud-API (/api/crm, /api/mail-requests)
// ======================================================================================================================================
async function sellerSetup() {
  const t = await setup({ ch: 900, vn: 6 });
  // Jeder CH-Lead mit Adresse bekommt einen vorbereiteten Jarvis-Entwurf (wie die echte CRM-Sicht: draft_status DRAFT + draft_url).
  const { state, etag } = await t.stores.view.get();
  state.leads.forEach((l, i) => { if (l.email && !l.do_not_contact) Object.assign(l, { draft_status: "DRAFT", draft_url: draftUrlOf(HEX(i)) }); });
  await t.stores.view.set(state, etag);
  const crm = async (u) => (await t.json(await t.crm(makeReq("/api/crm", { cookie: t.cookies[u] })))).body;
  const send = async (u, body) => t.json(await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies[u], body: { op: "send_lead_draft", ...body } })));
  const queue = () => t.stores.mail.peek()?.requests || [];
  return { t, crm, send, queue };
}

test("Seller-Policy: Giuliano/Mario/Damiano = SERVER_SEND (genau eine Aktion), Kudoshin NOT_CONNECTED, Chris Owner unverändert", () => {
  for (const u of ["giuliano", "mario", "damiano"]) {
    const m = mailAccessFor(actorFor(u));
    assert.deepEqual([m.mode, m.state, m.send_prepared, m.gmail_drafts, m.mailto, m.draft_requests], ["SERVER_SEND", "SEND_PREPARED_LEAD_DRAFT", true, false, false, false], u);
  }
  const k = mailAccessFor(actorFor("Kudoshin"));
  assert.deepEqual([k.mode, k.state, k.mailbox, k.send_prepared, k.gmail_drafts], ["OWN_MAILBOX", "KUDOSHIN_MAILBOX_NOT_CONNECTED", "hathanhlap261096@gmail.com", false, false]);
  const c = mailAccessFor(actorFor("chris"));
  assert.deepEqual([c.mode, c.gmail_drafts, c.mailto], ["OWNER_GMAIL", true, true]);
  // draft_ref: nur offener CH-Entwurf mit Adresse, ohne DNC – stabil je Message-ID, ändert sich mit dem Entwurf.
  const l = { lead_id: "a.ch", email: "info@a.ch", draft_status: "DRAFT", draft_url: draftUrlOf("19a2b3c4d5e6f701") };
  assert.match(draftRefOf(l), /^[a-f0-9]{16}$/);
  assert.equal(draftRefOf(l), draftRef("19a2b3c4d5e6f701"));
  assert.notEqual(draftRefOf(l), draftRef("19a2b3c4d5e6f702"));
  for (const x of [{ ...l, do_not_contact: true }, { ...l, email: null }, { ...l, draft_status: "MANUALLY_SENT" }, { ...l, market: "VN" }, { ...l, draft_url: "https://evil.example/" }]) assert.equal(draftRefOf(x), null);
});

test("API: Verkäufer-Sicht ohne Gmail-URL, nur draft_ref; «E-Mail lossenden» legt GENAU EINEN Auftrag an (Doppelklick = derselbe)", async () => {
  const { t, crm, send, queue } = await sellerSetup();
  for (const u of ["giuliano", "mario", "damiano"]) {
    const b = await crm(u);
    assert.equal(b.mail.mode, "SERVER_SEND");
    assert.ok(!JSON.stringify(b).includes("mail.google.com"), `${u}: keine Gmail-URL in der API`);
    const l = b.leads.find((x) => x.draft_ref);
    assert.ok(l, `${u} hat einen sendbaren Lead`);
    assert.equal(l.draft_url, null);
    const n = queue().length;
    const r = await send(u, { lead_id: l.lead_id, draft_ref: l.draft_ref });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.request.delivery, r.body.request.lead_id, r.body.request.draft_ref], ["send_prepared", l.lead_id, l.draft_ref]);
    const again = await send(u, { lead_id: l.lead_id, draft_ref: l.draft_ref });
    assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.request.request_id, r.body.request.request_id, "Doppelklick = derselbe Auftrag");
    assert.equal(queue().length, n + 1, "genau ein Auftrag");
    const q = queue().at(-1);
    assert.deepEqual([q.recipient, q.delivery, q.subject, q.body, q.requested_by, q.meta.actor_user_id, q.meta.lead_id, q.meta.market], [l.email, "send_prepared", "", "", u, u, l.lead_id, "CH"],
      "Empfänger aus dem CRM, kein Text aus dem Browser");
    assert.ok(!JSON.stringify(r.body).includes("@"), "Antwort verrät keine Adresse");
  }
  t.done?.();
});

test("API: fremder Lead 403, Empfänger-/Text-/Mailbox-/URL-Injektion blockiert, geänderter Entwurf 409, DNC 409, Kudoshin NOT_CONNECTED", async () => {
  const { crm, send, queue } = await sellerSetup();
  const g = (await crm("giuliano")).leads.find((x) => x.draft_ref), m = (await crm("mario")).leads.find((x) => x.draft_ref);
  assert.equal((await send("mario", { lead_id: g.lead_id, draft_ref: g.draft_ref })).status, 403, "Mario → Giulianos Lead");
  assert.equal((await send("damiano", { lead_id: m.lead_id, draft_ref: m.draft_ref })).status, 403, "Damiano → Marios Lead");
  for (const extra of [{ to: "evil@x.ch" }, { recipient: "evil@x.ch" }, { subject: "Hallo" }, { body: "Kaufen Sie jetzt!" }, { mailbox: "chris@x.ch" }, { draft_url: draftUrlOf("19a2b3c4d5e6f701") }, { delivery: "send" }]) {
    const r = await send("giuliano", { lead_id: g.lead_id, draft_ref: g.draft_ref, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra)); assert.equal(r.body.code, "BAD_PARAMS");
  }
  assert.equal((await send("giuliano", { lead_id: g.lead_id, draft_ref: "0".repeat(16) })).body.code, "DRAFT_CHANGED");
  assert.equal((await send("giuliano", { lead_id: g.lead_id, draft_ref: "nicht-hex" })).status, 400);
  assert.equal(queue().length, 0, "nichts in der Warteschlange");
  const k = await send("Kudoshin", { lead_id: g.lead_id, draft_ref: g.draft_ref });
  assert.deepEqual([k.status, k.body.code], [403, "KUDOSHIN_MAILBOX_NOT_CONNECTED"]);
  // Owner: freier Auftrag mit delivery send_prepared ist nicht möglich (nur über send_lead_draft).
  const { t } = await sellerSetup();
  const o = await t.json(await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies.chris, body: { op: "create", recipient: "a@b.ch", delivery: "send_prepared", draft_ref: "a".repeat(16) } })));
  assert.equal(o.status, 400);
});

test("API: Opt-out/DNC-Lead → kein Auftrag; nach Fehlschlag sicherer neuer Versuch (begrenzt), gesendet bleibt gesendet", async () => {
  const { t, crm, send, queue } = await sellerSetup();
  const { state, etag } = await t.stores.view.get();
  const g0 = (await crm("giuliano")).leads.find((x) => x.draft_ref);
  const i = state.leads.findIndex((l) => l.lead_id === g0.lead_id);
  state.leads[i] = { ...state.leads[i], do_not_contact: true, dnc_source: "opt_out" };
  await t.stores.view.set(state, etag);
  const d = await send("giuliano", { lead_id: g0.lead_id, draft_ref: g0.draft_ref });
  assert.ok([409, 403].includes(d.status), JSON.stringify(d.body));
  assert.equal(queue().length, 0, "Opt-out: kein Auftrag");
  const g = (await crm("giuliano")).leads.find((x) => x.draft_ref);
  const first = await send("giuliano", { lead_id: g.lead_id, draft_ref: g.draft_ref });
  const mark = async (status) => { const s = await t.stores.mail.get(); s.state.requests.forEach((r) => { if (r.request_id === first.body.request.request_id || r.status === "pending") r.status = status; }); await t.stores.mail.set(s.state, s.etag); };
  await mark("failed");
  const retry = await send("giuliano", { lead_id: g.lead_id, draft_ref: g.draft_ref });
  assert.equal(retry.status, 201, "nach Fehlschlag: neuer Versuch erlaubt");
  assert.notEqual(retry.body.request.request_id, first.body.request.request_id);
  await mark("failed");
  assert.equal((await send("giuliano", { lead_id: g.lead_id, draft_ref: g.draft_ref })).status, 201);
  await mark("failed");
  assert.equal((await send("giuliano", { lead_id: g.lead_id, draft_ref: g.draft_ref })).body.code, "SEND_RETRY_LIMIT", "höchstens 3 Versuche je Entwurf");
  // Verkäufer-Sicht der eigenen Aufträge: ohne Adresse; Zustand für den Knopf.
  const mine = await t.json(await t.mail(makeReq("/api/mail-requests", { cookie: t.cookies.giuliano })));
  assert.ok(mine.body.requests.length >= 3 && !JSON.stringify(mine.body).includes("@"));
  assert.equal(sellerSendState(g, mine.body.requests), "SEND_FAILED", "Fehlschlag wird nie als gesendet angezeigt");
  assert.equal(sellerSendState(g, [...mine.body.requests, { delivery: "send_prepared", lead_id: g.lead_id, draft_ref: g.draft_ref, status: "sent", created_at: "2099-01-01" }]), "SENT");
  assert.equal(sellerSendState(g, []), "DRAFT_READY");
  assert.equal(sellerSendState({ ...g, draft_status: "MANUALLY_SENT", draft_ref: null }, []), "SENT");
  assert.ok(SELLER_SEND_DAILY_LIMIT >= 1);
});

// ======================================================================================================================================
// 2. Mail-Worker: SEND_PREPARED_LEAD_DRAFT genau einmal (Fake-Gmail – nie ein echter Versand)
// ======================================================================================================================================
let dir, g, clock;
const live = (extra = {}) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, offer: "Ich prüfe Websites.",
  sender: { name: "Chris Muster", company: "Helvetic Webdesign", signature: "Chris Muster\nHelvetic Webdesign", email: "chris@x.ch" }, ...extra }));
const readJ = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
function fakeGmail() {
  const f = {
    reg: { labelId: "L", drafts: {}, sent: {}, sending: {} }, inbound: {}, calls: [], n: 0, failSend: null,
    listOwned: () => structuredClone(f.reg),
    async searchInbound() { f.calls.push("search"); return Object.values(f.inbound).sort((a, b) => b.internalDate - a.internalDate).map((m) => m.messageId); },
    async readInbound(id) { if (!f.inbound[id]) throw new Error("not found"); return structuredClone(f.inbound[id]); },
    async readThread() { throw new Error("kein Thread"); },
    async createDraft({ to, subject, body, mode, contactFormKey }) {
      const id = "dr" + ++f.n; f.calls.push(`create ${to} ${mode || "-"}`);
      f.reg.drafts[id] = { threadId: "t" + id, messageId: HEX(9000 + f.n), to, subject, body, mode, contactFormKey, createdAt: clock.toISOString() };
      return { draftId: id, messageId: f.reg.drafts[id].messageId, threadId: "t" + id };
    },
    async markDraftForReview() {},
    // Kontaktformular-Auto-Antwort: nur CONTACT_FORM_AUTO_REPLY ist sendbar; Gmail verbraucht den Entwurf.
    async sendDraft(id) {
      f.calls.push("SEND " + id);
      const d = f.reg.drafts[id];
      if (!d) throw new Error("Gmail GET /drafts: not found");
      gmailMod.assertSendable(id, f.reg);
      if (f.failSend) throw f.failSend;
      delete f.reg.drafts[id];
      f.reg.sent["s" + id] = { fromDraft: id, to: d.to, threadId: d.threadId, mode: d.mode, contactFormKey: d.contactFormKey, sentAt: clock.toISOString() };
      return { messageId: "s" + id, threadId: d.threadId };
    },
    async sendPreparedLeadDraft(id, { leadId, to, draftRef: ref, refOf }) {
      f.calls.push("SELLER_SEND " + id);
      const d = f.reg.drafts[id];
      if (!d) throw new Error("Gmail GET /drafts: not found");
      if (d.mode !== COLD || d.leadId !== leadId || d.to !== to || refOf(d.messageId) !== ref) throw new Error("mismatch");
      if (f.failSend) throw f.failSend;
      delete f.reg.drafts[id];
      f.reg.sent["s" + id] = { fromDraft: id, to, leadId, draftRef: ref, sellerSend: true, mode: COLD, threadId: "t" + id, sentAt: clock.toISOString() };
      return { messageId: "s" + id, threadId: "t" + id };
    },
  };
  return f;
}
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", reason: "", subject: "Re", body: "Danke." }) });
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf077b-")); g = fakeGmail(); clock = T0; live(); });
const coldDraft = (leadId, to, i = 1) => { const id = `cd${i}`; g.reg.drafts[id] = { threadId: "t" + id, messageId: HEX(i), to, subject: "Ihre Website", mode: COLD, leadId, createdAt: T0.toISOString() }; return { id, ref: draftRef(HEX(i)) }; };
function inbox(reqs) {
  const out = {};
  for (const [rid, actor, leadId, to, ref] of reqs) {
    const { request } = sanitizeMailRequest({ request_id: rid, recipient: to, delivery: "send_prepared", draft_ref: ref }, { now: clock, requestedBy: actor, meta: { actor_user_id: actor, market: "CH", locale: "de-CH", lead_id: leadId } });
    assert.ok(request, "gültiger Auftrag");
    out[rid] = { request, status: "pending", reason: null, synced: true, receivedAt: clock.toISOString() };
  }
  const cur = fs.existsSync(path.join(dir, "cloud_requests.json")) ? readJ("cloud_requests.json") : {};
  fs.writeFileSync(path.join(dir, "cloud_requests.json"), JSON.stringify({ ...cur, ...out }));
}
const status = (rid) => readJ("cloud_requests.json")[rid]?.status;
const sellerSends = () => g.calls.filter((c) => c.startsWith("SELLER_SEND"));

test("Worker: vorbereiteter Entwurf genau EINMAL gesendet; zweiter Auftrag/Doppelklick → keine zweite Mail; Cold-Register = angeschrieben", async () => {
  const { id, ref } = coldDraft("firma-a.ch", "info@firma-a.ch");
  fs.writeFileSync(path.join(dir, "individual_reviews.json"), JSON.stringify({ reviews: { "firma-a.ch": { lead_id: "firma-a.ch", status: "draft_created", draft_mode: COLD, gmail_draft_id: id, recipient: "info@firma-a.ch" } } }));
  inbox([["mr-seller-send-0001", "giuliano", "firma-a.ch", "info@firma-a.ch", ref]]);
  const r = await worker().tick();
  assert.equal(status("mr-seller-send-0001"), "sent");
  assert.deepEqual(sellerSends(), ["SELLER_SEND cd1"]);
  assert.ok(r.sends.some((s) => s.mailClass === "seller_prepared_send"));
  assert.equal(readJ("individual_reviews.json").reviews["firma-a.ch"].status, "manually_sent");
  assert.equal(readJ("individual_reviews.json").reviews["firma-a.ch"].seller_sent_by, "giuliano");
  inbox([["mr-seller-send-0002", "giuliano", "firma-a.ch", "info@firma-a.ch", ref]]);
  clock = new Date(+clock + 60_000);
  await worker().tick();
  assert.equal(status("mr-seller-send-0002"), "sent", "bereits gesendet → gemeldet, aber nie erneut gesendet");
  assert.deepEqual(sellerSends(), ["SELLER_SEND cd1"], "genau eine Mail");
});

test("Worker: Fehlschlag → nie SENT, Retry sendet genau einmal; unklarer Ausgang (Absturz) → nie wiederholt", async () => {
  const { ref } = coldDraft("firma-b.ch", "info@firma-b.ch", 2);
  g.failSend = new Error("Gmail POST /drafts/send: 400 Invalid");
  inbox([["mr-seller-fail-0001", "mario", "firma-b.ch", "info@firma-b.ch", ref]]);
  await worker().tick();
  assert.equal(status("mr-seller-fail-0001"), "failed");
  assert.equal(readJ("cloud_requests.json")["mr-seller-fail-0001"].reason, "E-Mail konnte nicht gesendet werden.");
  assert.equal(Object.keys(g.reg.sent).length, 0, "nichts gesendet");
  g.failSend = null;
  inbox([["mr-seller-fail-0002", "mario", "firma-b.ch", "info@firma-b.ch", ref]]);
  clock = new Date(+clock + 60_000);
  await worker().tick();
  assert.equal(status("mr-seller-fail-0002"), "sent");
  assert.equal(Object.keys(g.reg.sent).length, 1);
  // Absturz zwischen Gmail und Register (sending-Eintrag) → SEND_UNKNOWN, kein Versuch.
  const c = coldDraft("firma-c.ch", "info@firma-c.ch", 3);
  g.reg.sending[c.id] = { to: "info@firma-c.ch", sentAt: clock.toISOString() };
  inbox([["mr-seller-unkn-0001", "damiano", "firma-c.ch", "info@firma-c.ch", c.ref]]);
  await worker().tick();
  assert.equal(status("mr-seller-unkn-0001"), "failed");
  assert.ok(!sellerSends().includes("SELLER_SEND cd3"), "unklar → nie wiederholt");
});

test("Worker: Opt-out/Suppression, DNC-Lead, fremder Empfänger, geänderter Entwurf, unberechtigter Akteur → blockiert, 0 Sendungen", async () => {
  const a = coldDraft("firma-d.ch", "info@firma-d.ch", 4), b = coldDraft("firma-e.ch", "info@firma-e.ch", 5), c = coldDraft("firma-f.ch", "info@firma-f.ch", 6), d = coldDraft("firma-g.ch", "info@firma-g.ch", 7);
  fs.writeFileSync(path.join(dir, "suppression.json"), JSON.stringify({ "info@firma-d.ch": { reason: "opt-out", at: T0.toISOString() } }));
  fs.writeFileSync(path.join(dir, "lead_registry.json"), JSON.stringify({ schema: 1, leads: { "firma-e.ch": { lead_id: "firma-e.ch", domain: "firma-e.ch", business_email: "info@firma-e.ch", do_not_contact: true } } }));
  inbox([["mr-block-optout-01", "giuliano", "firma-d.ch", "info@firma-d.ch", a.ref], ["mr-block-dnc-0001", "giuliano", "firma-e.ch", "info@firma-e.ch", b.ref],
    ["mr-block-rcpt-0001", "giuliano", "firma-f.ch", "fremd@evil.example", c.ref], ["mr-block-ref-00001", "giuliano", "firma-g.ch", "info@firma-g.ch", "0".repeat(16)],
    ["mr-block-actor-001", "Kudoshin", "firma-g.ch", "info@firma-g.ch", d.ref]]);
  await worker().tick();
  for (const rid of ["mr-block-optout-01", "mr-block-dnc-0001", "mr-block-rcpt-0001", "mr-block-ref-00001", "mr-block-actor-001"]) assert.equal(status(rid), "blocked", rid);
  assert.deepEqual(sellerSends(), []);
  assert.equal(Object.keys(g.reg.sent).length, 0);
});

test("gmail.sendPreparedLeadDraft: nur eigener Cold-Entwurf DIESES Leads, exakter Empfänger, aktuelle Referenz – sonst nie gesendet", async () => {
  const reg = { labelId: "L", sent: {}, sending: {}, drafts: {
    cd1: { messageId: HEX(1), threadId: "t1", to: "info@a.ch", mode: COLD, leadId: "a.ch" }, cf1: { messageId: HEX(2), threadId: "t2", to: "kunde@x.ch", mode: "CONTACT_FORM_DRAFT_ONLY" } } };
  fs.writeFileSync(path.join(process.env.JARVIS_SECRETS_DIR, "gmail_jarvis.json"), JSON.stringify(reg));
  const ok = { leadId: "a.ch", to: "info@a.ch", draftRef: draftRef(HEX(1)), refOf: draftRef };
  await assert.rejects(gmailMod.sendPreparedLeadDraft("cf1", { ...ok, leadId: undefined }), /kein vorbereiteter Jarvis-Lead-Entwurf/);
  await assert.rejects(gmailMod.sendPreparedLeadDraft("cd1", { ...ok, leadId: "b.ch" }), /gehört nicht zu diesem Lead/);
  await assert.rejects(gmailMod.sendPreparedLeadDraft("cd1", { ...ok, to: "evil@x.ch" }), /Empfänger stimmt nicht/);
  await assert.rejects(gmailMod.sendPreparedLeadDraft("cd1", { ...ok, draftRef: draftRef(HEX(9)) }), /geändert/);
  // Alle Prüfungen bestanden → scheitert erst am fehlenden Gmail-Token (kein Netz, kein Versand).
  await assert.rejects(gmailMod.sendPreparedLeadDraft("cd1", ok), /nicht verbunden|OAuth|Zugangsdaten/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.JARVIS_SECRETS_DIR, "gmail_jarvis.json"), "utf8")).sent, {}, "nichts gesendet");
  assert.throws(() => gmailMod.assertSendable("cd1", reg), /COLD_LEAD_DRAFT_ONLY/, "der normale Send-Pfad sendet Cold-Entwürfe weiterhin nie");
  assert.doesNotThrow(() => gmailMod.assertSendable("x", { drafts: { x: { mode: gmailMod.CONTACT_FORM_AUTO_REPLY_MODE } } }));
});

// ======================================================================================================================================
// 3. Kontaktformular CONTACT_FORM_P0: verifizierte automatische Antwort genau einmal
// ======================================================================================================================================
const AUTH = (d) => `mx.google.com; dkim=pass header.i=@${d} header.s=s1 header.b=abc; spf=pass smtp.mailfrom=bounce@${d}; dmarc=pass (p=NONE) header.from=${d}`;
let seq = 0;
function formMsg({ id = (0x2a2b3c4d00 + ++seq).toString(16).padStart(16, "0"), at = T0, from = "Netlify Forms <formresponses@netlify.com>", replyTo = "Anna Kunde <anna@kunde-firma.ch>",
  auth = [AUTH("netlify.com")], name = "Anna Kunde", email = "anna@kunde-firma.ch", phone = null, message = "Unser Kontaktformular sendet nichts. Können Sie helfen?", sub = "7f" + id.slice(0, 20), deliveredTo = "kontakt@helvetic-webdesign.ch", site = "helvetic-webdesign" } = {}) {
  return { messageId: id, rfcMessageId: `<${id}@netlify.com>`, threadId: "th-" + id, from, replyTo, to: deliveredTo, deliveredTo, subject: `[Netlify] New form submission from ${site} (kontakt)`,
    date: at.toUTCString(), internalDate: +at, sent: false, draft: false,
    body: [`Name: ${name}`, `Email: ${email}`, ...(phone ? [`Telefon: ${phone}`] : []), `Message: ${message}`, "", `https://app.netlify.com/sites/${site}/forms/abc/submissions/${sub}`].join("\n"),
    headers: { "authentication-results": auth } };
}
const VERIFIED = { forms: [{ form_name: "kontakt", site: "helvetic-webdesign", market: "CH" }], receivingMailboxes: ["kontakt@helvetic-webdesign.ch"] };
const store = () => createStore(dir);
const run = (cfg = VERIFIED, extra = {}) => cf.processContactForms({ gmail: g, store: store(), cfg: { ...cf.DEFAULT_CONTACT_FORM_CONFIG, ...cfg }, sender: { name: "Chris Muster", signature: "Chris Muster\nHelvetic Webdesign" },
  vnSignature: "Lap", ownAddresses: ["chris@x.ch"], now: clock, autoReply: true, isTransient: (e) => /503|quota|ECONN/i.test(String(e.message)), ...extra });
const items = () => Object.values(readJ(cf.CONTACT_FORMS_FILE).items);
const sends = () => g.calls.filter((c) => c.startsWith("SEND "));
const add = (m) => { g.inbound[m.messageId] = m; return m; };

test("Kontaktformular: verifizierte Anfrage → CONTACT_FORM_P0, automatische Antwort GENAU EINMAL, CRM-Lead angelegt", async () => {
  add(formMsg({ id: "00000000000000a1", phone: "031 123 45 67", message: "Bitte rufen Sie mich an, unser Shop zeigt Fehler." }));
  const r = await run();
  assert.equal(r.sent, 1);
  const it = items()[0];
  assert.deepEqual([it.state, it.verified, it.verification, it.priority, it.customer_email], [cf.STATES.SENT, true, "CONTACT_FORM_VERIFIED", "P0", "anna@kunde-firma.ch"]);
  assert.deepEqual(g.calls.filter((c) => c.startsWith("create")), ["create anna@kunde-firma.ch CONTACT_FORM_AUTO_REPLY"]);
  assert.equal(sends().length, 1);
  const body = Object.values(g.reg.sent)[0];
  assert.equal(body.to, "anna@kunde-firma.ch");
  const pub = readJ(cf.CONTACT_FORMS_PUBLIC_FILE).leads["kunde-firma.ch"];
  assert.deepEqual([pub.lead_source, pub.priority_class, pub.status, pub.verified, pub.callback_requested, pub.phone_e164], ["CONTACT_FORM", "CONTACT_FORM_P0", "REPLY_SENT", true, true, "+41311234567"]);
  assert.match(pub.callback_evidence, /Bitte rufen Sie mich an/);
  // Nächster Durchlauf / doppelte Zustellung desselben Anbieter-Events (andere Gmail-ID, gleiche Submission) → keine zweite Mail.
  add(formMsg({ id: "00000000000000a2", sub: it.submission_id }));
  clock = new Date(+clock + 5 * 60_000);
  await run();
  await run();
  assert.equal(sends().length, 1, "Duplikat: keine zweite Antwort");
  assert.equal(items().length, 1);
});

test("Kontaktformular: neue zweite Einsendung = neue Interaktion (zweite Antwort); Dedupe nie über Adresse/Betreff/Name", async () => {
  add(formMsg({ id: "00000000000000b1", sub: "11111111111111111111" }));
  await run();
  add(formMsg({ id: "00000000000000b2", sub: "22222222222222222222", at: new Date(+T0 + 3_600_000) }));
  clock = new Date(+T0 + 3_700_000);
  await run();
  assert.equal(items().filter((x) => x.state === cf.STATES.SENT).length, 2);
  assert.equal(sends().length, 2);
  assert.equal(readJ(cf.CONTACT_FORMS_PUBLIC_FILE).leads["kunde-firma.ch"].count, 2, "gleicher Lead, keine Dublette");
});

test("Kontaktformular: unbekanntes/gefälschtes/unverifiziertes Formular → Prüfung, NIE automatisch gesendet", async () => {
  add(formMsg({ id: "00000000000000c1", auth: [], replyTo: "x@y.ch", email: "x@y.ch" }));
  add({ ...formMsg({ id: "00000000000000c2", email: "z@q.ch", replyTo: "z@q.ch" }), subject: "[Netlify] New form submission from helvetic-webdesign (offerte)" });
  await run();
  assert.equal(sends().length, 0);
  assert.deepEqual(items().map((x) => x.state), [cf.STATES.UNKNOWN_FORM], "gefälscht: kein Kontaktformular; unbekanntes Formular: Prüfung");
  // Ohne konfiguriertes Empfangspostfach (= nicht verifiziert): nur Entwurf (CONTACT_FORM_DRAFT_ONLY), REVIEW_REQUIRED.
  g.inbound = {}; add(formMsg({ id: "00000000000000c3", email: "neu@neu-firma.ch", replyTo: "neu@neu-firma.ch" }));
  await run({ forms: VERIFIED.forms });
  const it = items().find((x) => x.customer_email === "neu@neu-firma.ch");
  assert.deepEqual([it.state, it.verification], [cf.STATES.DRAFTED, "CONTACT_FORM_REVIEW_REQUIRED"]);
  assert.ok(it.verify_missing.includes("receiving_mailbox_not_verified"));
  assert.equal(sends().length, 0);
  // Gleichnamiges Formular einer FREMDEN Netlify-Site (z. B. Kunden-Website) → nie «unser» Formular: nur Entwurf, nie Versand.
  g.inbound = {}; add(formMsg({ id: "00000000000000c5", site: "kunden-shop", email: "k@k-firma.ch", replyTo: "k@k-firma.ch" }));
  await run();
  const foreign = items().find((x) => x.customer_email === "k@k-firma.ch");
  assert.deepEqual([foreign.state, foreign.verification, foreign.verify_missing], [cf.STATES.DRAFTED, "CONTACT_FORM_REVIEW_REQUIRED", ["form_site_not_verified"]]);
  assert.equal(sends().length, 0);
  // Empfangspostfach ohne Konfiguration: nur Jarvis' eigenes Absenderpostfach (Delivered-To) gilt als bekannt.
  const own = cf.classifyInbound(formMsg({ deliveredTo: "chris@x.ch" }), { cfg: { forms: VERIFIED.forms }, ownAddresses: ["chris@x.ch"] });
  assert.equal(own.item.verified, true);
  const other = cf.classifyInbound(formMsg({ deliveredTo: "jemand@anders.ch" }), { cfg: { forms: VERIFIED.forms }, ownAddresses: ["chris@x.ch"] });
  assert.deepEqual([other.item.verified, other.item.verify_missing], [false, ["receiving_mailbox_not_verified"]]);
  // autoReply aus → auch verifiziert nur Entwurf.
  g.inbound = {}; add(formMsg({ id: "00000000000000c4", email: "v@v-firma.ch", replyTo: "v@v-firma.ch" }));
  await run(VERIFIED, { autoReply: false });
  assert.equal(items().find((x) => x.customer_email === "v@v-firma.ch").state, cf.STATES.DRAFTED);
  assert.equal(sends().length, 0);
});

test("Kontaktformular: Gmail gestört → bleibt SENDING, nächster Durchlauf sendet genau einmal; Absturz während Versand → SEND_UNKNOWN", async () => {
  add(formMsg({ id: "00000000000000d1" }));
  g.failSend = new Error("Gmail POST /drafts/send: 503");
  await run();
  assert.equal(items()[0].state, cf.STATES.SENDING);
  assert.equal(Object.keys(g.reg.sent).length, 0, "nie fälschlich gesendet");
  g.failSend = null;
  clock = new Date(+clock + 5 * 60_000);
  await run();
  assert.equal(items()[0].state, cf.STATES.SENT);
  assert.equal(Object.keys(g.reg.sent).length, 1);
  await run();
  assert.equal(Object.keys(g.reg.sent).length, 1);
  // Absturz: sending-Eintrag im Register → unklar → nie wiederholen.
  g.inbound = {}; add(formMsg({ id: "00000000000000d2", sub: "33333333333333333333", email: "b@b-firma.ch", replyTo: "b@b-firma.ch" }));
  g.failSend = new Error("Gmail POST /drafts/send: 503");
  await run();
  const it = items().find((x) => x.customer_email === "b@b-firma.ch");
  g.reg.sending[it.draft_id] = { to: "b@b-firma.ch", sentAt: clock.toISOString() };
  g.failSend = null;
  await run();
  assert.equal(items().find((x) => x.customer_email === "b@b-firma.ch").state, cf.STATES.SEND_UNKNOWN);
  assert.equal(Object.keys(g.reg.sent).length, 1);
});

test("Kontaktformular über den Mail-Worker: P0 vor allem anderen, automatische Antwort (sender vorhanden), VN-Sprache + Lap-Signatur", async () => {
  live({ contactForms: { ...VERIFIED, forms: [{ form_name: "kontakt", site: "helvetic-webdesign.netlify.app", market: "VN" }] } });
  add(formMsg({ id: "00000000000000e1", name: "Nguyễn Văn A", email: "a@congty-a.vn", replyTo: "a@congty-a.vn", message: "Xin chào, website của chúng tôi bị lỗi. Vui lòng gọi lại cho tôi.", phone: "0912 345 678" }));
  const r = await worker().tick();
  assert.equal(r.contactForms.sent, 1);
  const d = Object.values(g.reg.sent)[0];
  assert.equal(d.to, "a@congty-a.vn");
  const pub = readJ(cf.CONTACT_FORMS_PUBLIC_FILE).leads["congty-a.vn"];
  assert.deepEqual([pub.market, pub.phone_e164, pub.callback_requested], ["VN", "+84912345678", true]);
  const c = cf.composeReply({ lang: "vi", inquiry: { name: "A", message: "x" }, vnSignature: "Lap", context: { callback: true, order_id: "VNFIX-20261010-abcdef" } });
  assert.match(c.body, /Kính gửi A/); assert.match(c.body, /VNFIX-20261010-abcdef/); assert.match(c.body, /Lap$/);
  const de = cf.composeReply({ lang: "de", inquiry: { name: "Anna", message: "Hilfe" }, sender: { signature: "Chris Muster" } });
  assert.doesNotMatch(de.body, /CHF|Preis|garantier|kostenlos|Rabatt/i, "keine erfundenen Versprechen/Verkaufsbehauptungen");
});

test("Rückrufwunsch: nur ausdrücklich (Text oder angekreuztes Feld) – Telefon allein / Verneinung → kein Rückruf", () => {
  assert.ok(cf.callbackRequest({}, "Bitte rufen Sie mich an."));
  assert.ok(cf.callbackRequest({}, "Ich bitte um Rückruf morgen."));
  assert.ok(cf.callbackRequest({ rueckruf: "ja" }, "Website kaputt"));
  assert.ok(cf.callbackRequest({}, "Vui lòng gọi lại cho tôi"));
  assert.equal(cf.callbackRequest({}, "Unsere Nummer steht unten."), null);
  assert.equal(cf.callbackRequest({}, "Bitte nicht anrufen, nur per E-Mail."), null);
  assert.equal(cf.callbackRequest({ rueckruf: "nein" }, ""), null);
  const c = cf.classifyInbound(formMsg({ phone: "031 123 45 67", message: "Unser Shop hat Fehler." }), { cfg: VERIFIED });
  assert.deepEqual([c.item.phone_e164, c.item.callback_requested], ["+41311234567", false], "Telefon allein ≠ Rückruf/Einwilligung");
  assert.equal(cf.normalizePhone("+41 31 12"), null);
});

// ======================================================================================================================================
// 4. CRM: Pools, Promotion, Abschnitt-Reihenfolge, Erledigung, Zähler, Scope
// ======================================================================================================================================
const FULL0 = (d) => ({ full: { complete: true, audited_at: "2026-10-15T08:00:00.000Z", findings: [] } });
const pubFrom = (list) => cf.publicContactForms({ items: Object.fromEntries(list.map((x, i) => [x.key || `k${i}`, { key: x.key || `cf:${String(i).padStart(24, "0")}`, created_at: x.received_at, ...x }])) });
const SUB = (over = {}) => ({ state: cf.STATES.SENT, verified: true, received_at: "2026-10-16T08:00:00.000Z", sent_at: "2026-10-16T08:01:00.000Z", match_state: cf.MATCH.UNMATCHED, summary: "Formular kaputt", ...over });

test("CRM-Pools: gescrapte Website ohne Fehler bleibt ausgeschlossen (TF-076); Inbound-Kontaktformular ohne Fehler → CONTACT_FORM_INBOUND, nicht als Fehler-Lead gezählt", () => {
  const src = {
    registry: { leads: { "sauber.ch": { lead_id: "sauber.ch", domain: "sauber.ch", status: "QUALIFIED", qualified: true, company: "Sauber AG", customer_visible_findings: ["x"] } } },
    siteFindings: { domains: { "sauber.ch": FULL0(), "neu-kunde.ch": FULL0() } },
    contactForms: pubFrom([SUB({ customer_email: "info@neu-kunde.ch", name: "Neu Kunde", phone: "044 111 22 33", phone_e164: "+41441112233" })]),
  };
  const v = buildCrmView(src, T0);
  const ids = v.leads.map((l) => l.lead_id);
  assert.ok(!ids.includes("sauber.ch"), "0 verifizierte Fehler → weiterhin ausgeschlossen");
  const inbound = v.leads.find((l) => l.lead_id === "neu-kunde.ch");
  assert.ok(inbound, "Inbound-Anfrage wird nie verworfen");
  assert.deepEqual([inbound.admission, inbound.contact_form.inbound, inbound.contact_form.priority_class, inbound.email, inbound.phone_tel, inbound.company],
    ["CONTACT_FORM_INBOUND", true, "CONTACT_FORM_P0", "info@neu-kunde.ch", "tel:+41441112233", "Neu Kunde"]);
  const st = crmStats(v.leads.map(cleanCrmLead), T0);
  assert.deepEqual([st.verified_error_leads, st.contact_form_hot, st.contact_form_inbound], [0, 1, 1], "getrennte Zähler – kein Aufblähen der Fehler-Leads");
  assert.equal(crmAdmission({ errors: { audit: "FULL", count: 0, items: [] } }).state, "NO_VERIFIED_ERRORS");
});

test("CRM-Promotion: bestehender Lead wird befördert, nie dupliziert (auch bei nicht zugeordneter Anfrage über Adresse); Erledigung beendet P0, neue Einsendung öffnet wieder", () => {
  const src = {
    registry: { leads: { "bestand.ch": { lead_id: "bestand.ch", domain: "bestand.ch", business_email: "info@bestand.ch", status: "DRAFT_CREATED", company: "Bestand AG", customer_visible_findings: ["x"] } } },
    reviews: { "bestand.ch": { lead_id: "bestand.ch", domain: "bestand.ch", draft_mode: COLD, gmail_draft_id: "d1", status: "draft_created", customer_findings: [{ key: "k", text: "Ein Link führt auf eine Fehlerseite", internal_refs: [{ issue_type: "broken_link", url: "https://bestand.ch/x" }] }],
      issue_evidence: [{ issue_type: "broken_link", url: "https://bestand.ch/x", evidence: "HTTP 404 (verlinkt auf https://bestand.ch/)", reproducible: true, severity: "medium", observed_at: "2026-10-15T08:00:00.000Z" }], updated_at: "2026-10-15T08:00:00.000Z" } },
    contactForms: pubFrom([SUB({ customer_email: "chefin@bestand.ch", key: "cf:aaaaaaaaaaaaaaaaaaaaaaaa" })]),
  };
  const v = buildCrmView(src, T0);
  assert.equal(v.leads.filter((l) => l.domain === "bestand.ch").length, 1, "keine Dublette");
  const l = v.leads.find((x) => x.lead_id === "bestand.ch");
  assert.deepEqual([l.contact_form.open, l.contact_form.inbound, l.admission], [true, false, "VERIFIED_ERRORS"]);
  // Erledigt (crm.resolveContactForm) → nicht mehr P0, Historie bleibt.
  const st = normalizeCrmState(null, T0);
  const res = applyCrmAction(st, { request_id: "11111111-1111-4111-8111-111111111111", action: "crm.resolveContactForm", params: { lead_id: "bestand.ch" } }, { now: new Date(+T0 + 3_600_000), lookup: () => l });
  assert.equal(res.ok, true);
  const after = buildCrmLead("bestand.ch", { ...src, crm: st }, T0);
  assert.deepEqual([after.contact_form.open, after.contact_form.resolution], [false, "CONTACT_FORM_HANDLED"]);
  assert.equal(after.contact_form.count, 1, "Historie bleibt");
  // Neue Einsendung nach der Erledigung → wieder offen.
  const src2 = { ...src, crm: st, contactForms: pubFrom([SUB({ customer_email: "chefin@bestand.ch", key: "cf:aaaaaaaaaaaaaaaaaaaaaaaa" }), SUB({ customer_email: "chefin@bestand.ch", key: "cf:bbbbbbbbbbbbbbbbbbbbbbbb", received_at: "2026-10-17T08:00:00.000Z" })]) };
  assert.equal(buildCrmLead("bestand.ch", src2, T0).contact_form.open, true);
  // Andere Endzustände: DNC / Kunde / Kein Interesse / erreicht / Rückruf vereinbart.
  assert.equal(buildCrmLead("bestand.ch", { ...src, crm: { leads: { "bestand.ch": { do_not_contact: true } } } }, T0).contact_form.resolution, "DNC");
  const call = (result, extra = {}) => ({ leads: { "bestand.ch": { call_history: [{ id: "c1", at: "2026-10-16T09:00:00.000Z", result, ...extra }] } } });
  assert.equal(buildCrmLead("bestand.ch", { ...src, crm: call("SPOKE_TO_DECISION_MAKER") }, T0).contact_form.resolution, "CUSTOMER_REACHED");
  assert.equal(buildCrmLead("bestand.ch", { ...src, crm: call("CALLBACK_REQUESTED") }, T0).contact_form.resolution, "CALLBACK_SCHEDULED");
  assert.equal(buildCrmLead("bestand.ch", { ...src, crm: call("NO_ANSWER") }, T0).contact_form.open, true, "nicht erreicht → bleibt P0");
  assert.equal(applyCrmAction(normalizeCrmState(null, T0), { action: "crm.resolveContactForm", params: { lead_id: "x.ch" } }, { lookup: () => ({ lead_id: "x.ch" }) }).code, "NO_CONTACT_FORM");
});

test("Priorität: Kontaktformular vor Rückruf/heiss vor Cold/normal – in jeder Sortierung zuoberst, älteste unbeantwortete zuerst", () => {
  const base = { errors: { audit: "FULL", count: 1, items: [{ key: "a", text: "x" }] }, sales_stage: "NEW", call_status: "NOT_CALLED", contact_status: "NOT_CONTACTED", notes: [], call_history: [] };
  const mk = (id, extra) => cleanCrmLead({ lead_id: id, company: id, ...base, ...extra });
  const cfl = (id, at) => mk(id, { contact_form: { status: "REPLY_SENT", lead_source: "CONTACT_FORM", received_at: at, open: true, open_since: at, submission_id: "cf:" + "c".repeat(24) }, priority: { score: 0, level: "LOW", reasons: [] } });
  const list = [mk("cold.ch", { priority: { score: 9, level: "HIGH", reasons: [] }, draft_status: "DRAFT" }), mk("normal.ch", { priority: { score: 4, level: "MEDIUM", reasons: [] } }),
    mk("rueckruf.ch", { call_status: "CALLBACK_REQUESTED", priority: { score: 1, level: "LOW", reasons: [] } }), cfl("kf-neu.ch", "2026-10-16T09:00:00.000Z"), cfl("kf-alt.ch", "2026-10-16T07:00:00.000Z")];
  assert.deepEqual(sortLeads(list, "priority", T0).map((l) => l.lead_id), ["kf-alt.ch", "kf-neu.ch", "rueckruf.ch", "cold.ch", "normal.ch"]);
  assert.deepEqual(sortLeads(list, "company", T0).slice(0, 2).map((l) => l.lead_id), ["kf-alt.ch", "kf-neu.ch"], "auch nach Firma sortiert zuoberst");
  assert.deepEqual(contactFormQueue(list).map((l) => l.lead_id), ["kf-alt.ch", "kf-neu.ch"]);
  assert.ok(cleanCrmLead({ ...list[3] }).contact_form.open, "Allowlist behält P0-Status");
});

test("Seller-Scope: Kontaktformular-Hot-Leads nur im eigenen Bereich (Giuliano/Mario/Damiano CH, Kudoshin VN, Chris alle)", async () => {
  const t = await setup({ ch: 900, vn: 4 });
  const ids = async (u) => (await t.json(await t.crm(makeReq("/api/crm", { cookie: t.cookies[u] })))).body.leads.map((l) => l.lead_id);
  const [gi, ma, da] = [await ids("giuliano"), await ids("mario"), await ids("damiano")];
  const pick = { giuliano: gi[0], mario: ma[0], damiano: da[0] };
  const cfOf = (at) => ({ status: "REPLY_SENT", lead_source: "CONTACT_FORM", received_at: at, open: true, open_since: at, verified: true, submission_id: "cf:" + "d".repeat(24) });
  const { state, etag } = await t.stores.view.get();
  for (const [u, id] of Object.entries(pick)) { const i = state.leads.findIndex((l) => l.lead_id === id); state.leads[i] = cleanCrmLead({ ...state.leads[i], contact_form: cfOf("2026-10-16T07:00:00.000Z") }); assert.ok(id, u); }
  state.leads.push(cleanCrmLead({ lead_id: "khach@congty-moi.vn", company: "Công ty mới", email: "khach@congty-moi.vn", market: "VN", errors: { audit: "NONE" }, contact_form: { ...cfOf("2026-10-16T06:00:00.000Z"), inbound: true } }));
  await t.stores.view.set(state, etag);
  const view = async (u) => (await t.json(await t.crm(makeReq("/api/crm", { cookie: t.cookies[u] })))).body;
  for (const u of ["giuliano", "mario", "damiano"]) {
    const b = await view(u);
    const hot = contactFormQueue(b.leads).map((l) => l.lead_id);
    assert.deepEqual(hot, [pick[u]], `${u}: nur eigener Kontaktformular-Lead`);
    assert.equal(b.stats.contact_form_hot, 1);
  }
  const k = await view("Kudoshin");
  assert.deepEqual(contactFormQueue(k.leads).map((l) => l.lead_id), ["khach@congty-moi.vn"], "VN-Inbound → Kudoshin");
  assert.equal(k.leads.find((l) => l.lead_id === "khach@congty-moi.vn").market, "VN");
  const c = await view("chris");
  assert.equal(c.stats.contact_form_hot, 4);
  assert.deepEqual(contactFormQueue(c.leads)[0].lead_id, "khach@congty-moi.vn", "älteste zuerst");
  // Schreiben (Erledigen) eines VN-Inbound-Leads läuft über den CH-Dienst (dort liegt die Anfrage) – nie über eine fremde Queue.
  const sc = await t.json(await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies.giuliano, body: { action: "crm.resolveContactForm", params: { lead_id: "khach@congty-moi.vn" } } })));
  assert.equal(sc.status, 403, "Giuliano: VN-Lead ausserhalb des Bereichs");
});

// ======================================================================================================================================
// 5. Anruf-Gates (calling-core eligibility) + Telefonbuch-Sternchen
// ======================================================================================================================================
const NOW_VN = new Date("2026-10-16T03:00:00Z"); // Fr 10:00 Hanoi
const vnLead = (cfx = {}, extra = {}) => ({ lead_id: "khach@congty.vn", market: "VN", phone_tel: "tel:+84912345678", errors: { audit: "NONE" }, sales_stage: "NEW", call_status: "NOT_CALLED",
  contact_form: { status: "REPLY_SENT", lead_source: "CONTACT_FORM", received_at: "2026-10-16T02:00:00.000Z", open: true, verified: true, submission_id: "cf:" + "e".repeat(24),
    callback_requested: true, callback_evidence: "FORM_MESSAGE: Vui lòng gọi lại cho tôi", callback_phone_match: true, ...cfx }, ...extra });
const okCtx = { consent: { dnc_registry: { result: "NOT_LISTED", checked_at: "2026-10-10T00:00:00.000Z" }, requested_callback: { call_id: "synthetic-callback-077b", callback_at: "2026-10-16T10:00:00.000Z" } }, legal: { status: "APPROVED" }, now: NOW_VN };

test("Anruf: Kontaktformular + ausdrücklicher, verifizierter Rückrufwunsch → erlaubt NUR mit allen bestehenden Gates (DNC-Register, Rechtsprüfung, Zeitfenster)", () => {
  const e = eligibility(vnLead(), okCtx);
  assert.deepEqual([e.decision, e.basis], ["ALLOWED", "REQUESTED_CALLBACK"]);
  assert.equal(eligibility(vnLead(), { ...okCtx, legal: null }).code, "BLOCKED_PENDING_LEGAL_REVIEW", "Rechtsprüfung bleibt");
  assert.equal(eligibility(vnLead(), { ...okCtx, consent: { requested_callback: okCtx.consent.requested_callback } }).code, "DNC_REGISTRY_NOT_CHECKED", "DNC-Register bleibt");
  assert.equal(eligibility(vnLead(), { ...okCtx, now: new Date("2026-10-16T12:00:00Z") }).code, "WAITING_FOR_ALLOWED_HOURS");
  assert.equal(eligibility({ ...vnLead(), market: "CH", phone_tel: "tel:+41311234567" }, okCtx).code, "CH_CALLING_DISABLED", "CH-Agent bleibt aus");
});

test("Anruf: nur Telefon (kein Rückrufwunsch) / unverifiziert / andere Nummer → keine Einwilligung erfunden; Sternchen + DNC blockieren", () => {
  const noCallback = { ...okCtx, consent: { dnc_registry: okCtx.consent.dnc_registry } };
  assert.equal(eligibility(vnLead({ callback_requested: false, callback_evidence: null }), noCallback).bucket, "BLOCKED_CONSENT");
  assert.equal(eligibility(vnLead({ verified: false }), noCallback).bucket, "BLOCKED_CONSENT");
  assert.equal(eligibility(vnLead({ callback_phone_match: false }), noCallback).bucket, "BLOCKED_CONSENT");
  // Telefonbuch-/Stern-Gates gehören nur zum entfernten autonomen Dialer; menschliche Anrufe nutzen die aktuellen Consent-Gates.
  assert.equal(eligibility(vnLead({}, { phonebook: { status: "PHONEBOOK_STAR_PRESENT" } }), noCallback).code, "CALL_CONSENT_UNKNOWN");
  assert.equal(eligibility(vnLead(), { ...noCallback, consent: { ...noCallback.consent, directory: { status: "STAR" } } }).code, "CALL_CONSENT_UNKNOWN");
  assert.equal(eligibility(vnLead({}, { do_not_contact: true }), noCallback).bucket, "BLOCKED_DNC");
  assert.equal(eligibility(vnLead({}, { call_status: "DO_NOT_CALL" }), noCallback).bucket, "BLOCKED_DNC");
  // CRM-Kennzeichen: Telefon allein → NICHT ANRUFBAR.
  const src = { contactForms: pubFrom([SUB({ customer_email: "info@tel-only.ch", phone: "031 123 45 67", phone_e164: "+41311234567", callback_requested: false })]) };
  assert.equal(buildCrmLead("tel-only.ch", src, T0).contact_form.call_eligibility, "CALL_NOT_CURRENTLY_ELIGIBLE");
  const src2 = { contactForms: pubFrom([SUB({ customer_email: "info@rr.ch", phone: "031 123 45 67", phone_e164: "+41311234567", callback_requested: true, callback_evidence: "FORM_MESSAGE: Bitte rufen Sie mich an" })]) };
  const l2 = buildCrmLead("rr.ch", src2, T0);
  assert.deepEqual([l2.contact_form.call_eligibility, l2.contact_form.callback_phone_match], ["CALLBACK_REQUESTED", true]);
});

test("Telefonbuch: Provider-Abstraktion ohne Abfrage, nur ausdrücklicher tel:nopromo-Beleg = Sternchen, UNKNOWN nie CLEAR", async () => {
  const p = pb.createPhonebookProvider();
  assert.deepEqual([p.configured, p.state], [false, "PHONEBOOK_PROVIDER_NOT_CONFIGURED"]);
  assert.deepEqual(await p.lookup("+41311234567"), { status: "PHONEBOOK_STAR_UNKNOWN", reason: "PHONEBOOK_PROVIDER_NOT_CONFIGURED" }, "kein Massen-/Einzelabruf");
  assert.equal(pb.createPhonebookProvider({ lookup: async () => ({ status: "PHONEBOOK_STAR_CLEAR" }) }).configured, false, "ohne ausdrückliche Erlaubnis kein Anbieter");
  assert.equal(pb.phonebookFromRecord({ phonebook: { "tel:nopromo": "*", source: "search.ch", checked_at: "2026-10-01T00:00:00Z" } }).status, "PHONEBOOK_STAR_PRESENT");
  assert.equal(pb.phonebookFromRecord({ phonebook: { nopromo: true } }).status, "PHONEBOOK_STAR_PRESENT");
  assert.equal(pb.phonebookFromRecord({ phone: "*031 123 45 67" }).status, "PHONEBOOK_STAR_UNKNOWN", "nie aus dem Telefon-Text abgeleitet");
  assert.equal(pb.phonebookFromRecord({ phonebook: { nopromo: false } }).status, "PHONEBOOK_STAR_UNKNOWN", "CLEAR nur mit Quelle + Zeitpunkt");
  assert.equal(pb.phonebookFromRecord({ phonebook: { nopromo: false, source: "search.ch", checked_at: "2026-10-01T00:00:00Z" } }).status, "PHONEBOOK_STAR_CLEAR");
  assert.equal(pb.phonebookFromRecord({ phonebook: { "tel:nopromo": "*", phone: "+41319999999" } }, "+41311234567").status, "PHONEBOOK_STAR_UNKNOWN", "Beleg einer anderen Nummer gilt nicht");
  assert.equal(pb.phonebookFromSearchChEntry({ "tel:nopromo": "*" }).status, "PHONEBOOK_STAR_PRESENT");
  assert.deepEqual(pb.phonebookAdmission({ status: "PHONEBOOK_STAR_UNKNOWN" }), { ok: true, callable: false, state: "PHONEBOOK_PROVIDER_NOT_CONFIGURED" });
  assert.equal(pb.phonebookAdmission({ status: "PHONEBOOK_STAR_UNKNOWN" }, { providerConfigured: true }).ok, false, "künftig: ohne CLEAR keine Aufnahme");
  // CRM: Sternchen → Nummer nicht anrufbar (Text bleibt, kein Entfernen des Sternchens), keine Anruf-Empfehlung. Ohne Beleg: kein Feld (UI «NICHT GEPRÜFT»).
  const dirLead = (phonebook) => ({ directory: { leads: { "stern.ch": { lead_id: "stern.ch", domain: "stern.ch", company_name: "Stern AG", phone: "+41 31 123 45 67", phone_normalized: "+41311234567", ...(phonebook ? { phonebook } : {}) } } } });
  const star = cleanCrmLead(buildCrmLead("stern.ch", dirLead({ "tel:nopromo": "*", source: "search.ch", checked_at: "2026-10-01T00:00:00Z" }), T0));
  assert.deepEqual([star.phone, star.phone_tel, star.phonebook.status, star.call_recommended, callRecommended(star)], ["+41 31 123 45 67", null, "PHONEBOOK_STAR_PRESENT", false, false]);
  const unknown = cleanCrmLead(buildCrmLead("stern.ch", dirLead(null), T0));
  assert.deepEqual([unknown.phone_tel, "phonebook" in unknown], ["tel:+41311234567", false], "bestehende Leads bleiben sichtbar, nie als CLEAR markiert");
});

// ======================================================================================================================================
// 6. Browser (echter Chromium): Giuliano – genau ein Mail-Knopf, kein Gmail im DOM, Abschnitt ganz oben, Liste beginnt mit P0
// ======================================================================================================================================
const { startServer, exe, loginAs } = await import("./crm-browser-harness.js");
test("Browser: «E-Mail lossenden» als einziger Mail-Knopf, Klick sendet nur lead_id+draft_ref, gesendet/fehlgeschlagen korrekt; KONTAKTFORMULAR ganz oben",
  { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    const now = new Date().toISOString(), older = new Date(Date.now() - 3_600_000).toISOString();
    const srv = await startServer({ n: 40, sellers: { giuliano: PW.giuliano }, prepare: ({ mail }) => {
      fs.writeFileSync(path.join(mail, "mail_worker", "contact_forms_public.json"), JSON.stringify(cf.publicContactForms({ items: {
        a: { key: "cf:" + "a".repeat(24), state: cf.STATES.SENT, verified: true, received_at: now, created_at: now, sent_at: now, match_state: cf.MATCH.LEAD, lead_id: "firma-020.ch", customer_email: "chef@firma-020.ch", summary: "Bitte Offerte für Reparatur" },
        b: { key: "cf:" + "b".repeat(24), state: cf.STATES.SENT, verified: true, received_at: older, created_at: older, sent_at: older, match_state: cf.MATCH.UNMATCHED, customer_email: "info@neu-kunde.ch", name: "Neu Kunde GmbH", summary: "Unser Formular geht nicht" } } })));
    } });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await loginAs(ctx, srv, "giuliano", PW.giuliano);
      const page = await ctx.newPage(), errors = [], posts = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      let fake = null; // Ergebnis des Mail-Workers (simuliert, kein Versand)
      await page.route("**/*", async (r) => {
        const u = r.request().url();
        if (!u.startsWith(srv.url)) return r.abort();
        if (u.endsWith("/api/mail-requests") && r.request().method() === "POST") posts.push(JSON.parse(r.request().postData()));
        if (u.endsWith("/api/mail-requests") && r.request().method() === "GET" && fake) return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: fake() }) });
        return r.continue();
      });
      await page.goto(srv.url + "/sales.html");
      await page.waitForFunction(() => !document.getElementById("app").hidden);
      await page.click("#crmBtn");
      await page.waitForFunction(() => document.querySelectorAll("#crmMain [data-id]").length > 0 && document.querySelectorAll("#crmHot .crm-hot-item").length === 2, null, { timeout: 120_000 });
      // Abschnitt ganz oben (vor Karten und Liste), älteste offene Anfrage zuerst; normale Liste beginnt mit den P0-Leads.
      const order = await page.evaluate(() => { const c = [...document.getElementById("crm").children].map((x) => x.id || x.className); return { hot: c.indexOf("crmHot"), cards: c.indexOf("crmPipeCards"), main: c.indexOf("crmMain") }; });
      assert.ok(order.hot >= 0 && order.hot < order.cards && order.hot < order.main, JSON.stringify(order));
      assert.match(await page.locator("#crmHot h3").innerText(), /KONTAKTFORMULAR – SOFORT BEARBEITEN/);
      assert.deepEqual(await page.$$eval("#crmHot .crm-hot-item", (xs) => xs.map((x) => x.dataset.id)), ["neu-kunde.ch", "firma-020.ch"]);
      assert.deepEqual(await page.$$eval("#crmMain [data-id]", (xs) => xs.slice(0, 2).map((x) => x.dataset.id)), ["neu-kunde.ch", "firma-020.ch"]);
      assert.match(await page.locator("#crmHot").innerText(), /ANTWORT GESENDET/);
      // Lead mit vorbereitetem Entwurf öffnen: Verkaufsaktion plus bestehender «E-Mail lossenden»-Pfad, kein Gmail/mailto im DOM.
      const id = await page.evaluate(() => [...document.querySelectorAll("#crmMain [data-id]")].map((x) => x.dataset.id).find((x) => /^firma-0[2-3]\d\.ch$/.test(x) && x !== "firma-020.ch"));
      await page.click(`#crmMain [data-id="${id}"]`);
      await page.waitForFunction(() => !document.getElementById("crmDrawer").hidden);
      const mailButtons = await page.$$eval("#crmDrawer a, #crmDrawer button", (xs) => xs.map((x) => x.textContent.trim()).filter((s) => /mail|gmail|entwurf/i.test(s)));
      assert.deepEqual(mailButtons, ["Mail senden", "E-Mail lossenden"], mailButtons.join("|"));
      assert.equal((await page.content()).includes("mail.google.com"), false, "keine Gmail-URL im DOM");
      assert.equal(await page.locator("#crmDrawer a[href^='mailto:']").count(), 0);
      assert.match(await page.locator("#crmDrawer").innerText(), /Telefonbuch\s*Nicht geprüft/);
      // Klick → genau ein POST mit nur op/lead_id/draft_ref; Knopf sofort gesperrt («wird gesendet»).
      let reqs = [];
      fake = () => reqs;
      await page.click("#crmDrawer .crm-send");
      await page.waitForFunction(() => document.querySelector("#crmDrawer .crm-send")?.dataset.state === "SEND_IN_PROGRESS");
      await page.click("#crmDrawer .crm-send", { force: true, trial: false }).catch(() => {});
      assert.equal(posts.length, 1, "Doppelklick: ein einziger Auftrag");
      assert.deepEqual(Object.keys(posts[0]).sort(), ["draft_ref", "lead_id", "op"]);
      assert.deepEqual([posts[0].op, posts[0].lead_id], ["send_lead_draft", id]);
      assert.match(posts[0].draft_ref, /^[a-f0-9]{16}$/);
      // Fehlschlag → nie «gesendet»; Meldung + sicherer neuer Versuch möglich.
      reqs = [{ request_id: "mr-x", delivery: "send_prepared", lead_id: id, draft_ref: posts[0].draft_ref, status: "failed", created_at: now }];
      await page.waitForFunction(() => document.querySelector("#crmDrawer .crm-send")?.dataset.state === "SEND_FAILED", null, { timeout: 30_000 });
      assert.match(await page.locator("#crmDrawer .crm-sendbox").innerText(), /E-Mail konnte nicht gesendet werden/);
      assert.equal(await page.locator("#crmDrawer .crm-send").isEnabled(), true);
      // Erfolg (Worker meldet sent) → «E-Mail gesendet», gesperrt.
      await page.click("#crmDrawer .crm-send");
      reqs = [...reqs, { request_id: "mr-y", delivery: "send_prepared", lead_id: id, draft_ref: posts[0].draft_ref, status: "sent", created_at: new Date().toISOString() }];
      await page.waitForFunction(() => document.querySelector("#crmDrawer .crm-send")?.dataset.state === "SENT", null, { timeout: 30_000 });
      assert.equal(await page.locator("#crmDrawer .crm-send").innerText(), "E-Mail gesendet");
      assert.equal(await page.locator("#crmDrawer .crm-send").isDisabled(), true);
      assert.deepEqual(errors, []);
      await ctx.close();
    } finally { await browser.close(); srv.close(); }
  });
