// TF-079 – Stripe-Zahlungslinks (CHF 150 / 480) per Mail + Nachfassen über den Alias chris@helvetic-webdesign.ch bis zur Zahlung.
// Nur Fixtures: 0 echte Mails, 0 Zahlungen, 0 Kundenkontakte.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.JARVIS_SECRETS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf079-sec-"));
const pl = await import("../payment-links.js");
const pf = await import("../payment-followup.js");
const gm = await import("../gmail.js");
const cf = await import("../contact-form.js");
const mon = await import("../payment-monitor.js");
const store = await import("../onboarding-store.js");

const L150 = "https://buy.stripe.com/dRm3cw5A5fo3caR9ov7Re00", L480 = "https://buy.stripe.com/7sY00k5A54JpcaR1W37Re01";
const OID = "CA150-20261019-a1b2c3", OID2 = "RF480-20261019-d4e5f6";

test("Links: exakte URLs, Auftrags-ID + E-Mail als Parameter, VN/ungültig → null", () => {
  assert.equal(pl.paymentLinkFor("REPAIR_CHECK_150"), L150);
  assert.equal(pl.paymentLinkFor("REPAIR_FIX_500"), L480);
  assert.equal(pl.paymentLinkFor("REPAIR_CHECK_150", { orderId: OID, email: "A@b.ch" }), `${L150}?client_reference_id=${OID}&prefilled_email=a%40b.ch`);
  assert.equal(pl.paymentLinkFor("REPAIR_CHECK_150", { orderId: "x; drop" }), null);
  assert.equal(pl.paymentLinkFor("VN_CHECK"), null);
  assert.equal(pl.paymentLinkFor("NOPE"), null);
  assert.equal(pl.paymentOptions().length, 2);
});

test("«Interesse an» → Paket; mehrdeutig → beide", () => {
  assert.equal(pl.packageOfInterest("Reparatur"), "FIX");
  assert.equal(pl.packageOfInterest("Check & Anleitung"), "CHECK");
  assert.equal(pl.packageOfInterest("Anleitung oder Reparatur"), null);
  assert.equal(pl.packageOfInterest(""), null);
  assert.equal(pl.paymentLinesDe({ kind: null }).filter((l) => l.startsWith("https://")).length, 2);
  assert.equal(pl.paymentLinesDe({ kind: "FIX" }).filter((l) => l.startsWith("https://")).join(), L480);
});

test("Kontaktformular-Antwort: Link nur wenn Angebot/Auftrag, nie VN, nie bezahlt", () => {
  const it = { offer_links: true, interest: "Reparatur", customer_email: "a@b.ch" };
  assert.deepEqual(cf.paymentContextOf(it, {}), { kind: "FIX", orderId: null, email: "a@b.ch" });
  assert.equal(cf.paymentContextOf({ ...it, offer_links: false }, {}), null);
  assert.equal(cf.paymentContextOf({ ...it, language: "vi" }, {}), null);
  const orders = { [OID]: { order_id: OID, payment_gate_met: false } };
  assert.equal(cf.paymentContextOf({ order_id: OID, customer_email: "a@b.ch" }, orders).orderId, OID);
  assert.equal(cf.paymentContextOf({ order_id: OID }, { [OID]: { order_id: OID, payment_gate_met: true } }), null);
  const r = cf.composeReply({ inquiry: { name: "Anna", message: "Hallo" }, sender: { name: "Chris" }, context: { payment: cf.paymentContextOf(it, {}) } });
  assert.match(r.body, new RegExp(L480.replace(/\//g, "\\/")));
  assert.doesNotMatch(r.body, new RegExp(L150.replace(/\//g, "\\/")));
});

test("Webhook: client_reference_id aus checkout.session.completed → Auftrag; payment_intent unverändert", () => {
  const n = mon.normalizeStripeEvent({ type: "checkout.session.completed", data: { object: { id: "cs_1", payment_intent: "pi_1", amount_total: 15000, currency: "chf", created: 1760000000, payment_status: "paid", status: "complete", client_reference_id: OID } } });
  assert.equal(n?.order_ref, OID);
  const m = mon.normalizeStripeEvent({ type: "checkout.session.completed", data: { object: { id: "cs_2", payment_intent: "pi_2", amount_total: 15000, currency: "chf", created: 1760000000, payment_status: "paid", status: "complete", client_reference_id: "x".repeat(80) } } });
  assert.equal(m?.order_ref ?? null, null);
});

test("Alias: From + Reply-To nur mit gültigem sendAs, sonst keine Header", () => {
  gm.setSendAs({ address: "Chris@Helvetic-Webdesign.ch", name: "Chris Kälin" });
  const dec = (raw) => Buffer.from(raw, "base64url").toString();
  const withFrom = dec(gm.rawMessage({ to: "a@b.ch", subject: "S", body: "x", from: gm.getSendAs() }));
  assert.match(withFrom, /^From: .*<chris@helvetic-webdesign\.ch>/m);
  assert.match(withFrom, /^Reply-To: chris@helvetic-webdesign\.ch$/m);
  assert.doesNotMatch(dec(gm.rawMessage({ to: "a@b.ch", subject: "S", body: "x" })), /^From:/m);
  gm.setSendAs({ address: "kein-mail", name: "x" });
  assert.equal(gm.getSendAs(), null);
  gm.setSendAs(null);
});

// ---------- Nachfassen ----------
let dir, od, g, clock, sent, notes;
const order = (o = {}) => ({ order_id: OID, market: "CH", offer_class: "REPAIR_CHECK_150", order_confirmed: true, payment_gate_met: false, cancelled: false, terminal: false, customer_email: "kunde@muster.ch", contact_name: "Anna Muster", company: "Muster GmbH", ...o });
const setOrders = (list) => store.writeOrdersExport(od, Object.fromEntries(list.map((o) => [o.order_id, o])));
function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, threads: {}, n: 0, failSend: null, calls: [] };
  const draft = (kind, threadId, p) => {
    const id = "d" + ++f.n, t = threadId || "T" + f.n;
    f.reg.drafts[id] = { messageClass: p.messageClass, orderId: p.orderId, threadId: t, to: p.to, createdAt: clock().toISOString() };
    f.threads[t] ||= [];
    f.threads[t].push({ messageId: "m" + f.n, draft: true, draftId: id, from: "me", body: p.body, subject: p.subject || "Re", internalDate: +clock() });
    return { draftId: id, threadId: t };
  };
  return Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    createDraft: async (p) => { f.calls.push("create"); return draft("new", null, p); },
    replyDraftInThread: async (t, p) => { f.calls.push("reply"); if (!f.threads[t]) throw new Error("Thread unbekannt"); return draft("reply", t, p); },
    readThread: async (t) => ({ threadId: t, messages: structuredClone((f.threads[t] || []).filter((m) => !m.draft)) }),
    sendDraft: async (id) => {
      if (f.failSend) throw new Error(f.failSend);
      const d = f.reg.drafts[id]; delete f.reg.drafts[id];
      const m = f.threads[d.threadId].find((x) => x.draftId === id); delete m.draft; m.sent = true; m.internalDate = +clock();
      f.reg.sent["s" + id] = { fromDraft: id, threadId: d.threadId, sentAt: clock().toISOString() };
      sent.push({ to: d.to, body: m.body, subject: m.subject, thread: d.threadId });
      return { messageId: m.messageId, threadId: d.threadId };
    },
    inbound(t, body, { from = "Anna <kunde@muster.ch>", subject = "Re: Ihr Auftrag" } = {}) { f.threads[t].push({ messageId: "in" + ++f.n, from, replyTo: null, subject, body, internalDate: +clock() }); },
  });
}
const mk = (extra = {}) => pf.createPaymentFollowup({ dir, onboardingDir: od, gmail: g, sender: () => ({ name: "Chris", company: "Helvetic Webdesign" }), settings: () => ({ enabled: true, ...extra }),
  now: () => clock(), notify: async (n) => { notes.push(n); } });
const H = 3600_000;
const at = (iso) => { clock = () => new Date(iso); };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf079-w-")); od = fs.mkdtempSync(path.join(os.tmpdir(), "tf079-o-"));
  at("2026-10-19T10:00:00+02:00"); g = fakeGmail(); sent = []; notes = [];
});
const advance = (h) => { const t = +clock() + h * H; clock = () => new Date(t); };

test("Standard AUS: keine Mail", async () => {
  setOrders([order()]);
  const f = pf.createPaymentFollowup({ dir, onboardingDir: od, gmail: g, settings: () => ({}), now: () => clock() });
  assert.equal((await f.process()).enabled, false); assert.equal(sent.length, 0);
});

test("Aktivierung: bereits offene Aufträge = LEGACY, nie angeschrieben; neuer Auftrag danach → genau eine Anfrage mit Link", async () => {
  setOrders([order()]);
  const f = mk();
  assert.equal((await f.process()).activated, true);
  await f.process(); assert.equal(sent.length, 0);
  setOrders([order(), order({ order_id: OID2, offer_class: "REPAIR_FIX_500", customer_email: "b@firma.ch" })]);
  await f.process(); await f.process(); await f.process();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "b@firma.ch");
  assert.ok(sent[0].body.includes(`${L480}?client_reference_id=${OID2}`));
  assert.match(sent[0].body, /CHF 480/);
  assert.doesNotMatch(sent[0].body, new RegExp(OID + "\\b"));
});

async function started() {
  const f = mk(); setOrders([]); await f.process(); setOrders([order()]); await f.process(); return f;
}

test("Erinnerungen: 48 h, +72 h, +7 d; nur 08–19 Uhr, nie sonntags; danach Schluss + Meldung; nie ein vierter", async () => {
  const f = await started(); assert.equal(sent.length, 1);
  advance(24); await f.process(); assert.equal(sent.length, 1);        // zu früh
  advance(25); await f.process(); assert.equal(sent.length, 2);        // 49 h, Mittwoch 11:00
  assert.equal(sent[1].thread, sent[0].thread);                         // selber Thread
  advance(72); await f.process(); assert.equal(sent.length, 3);
  advance(168); await f.process(); assert.equal(sent.length, 4);
  advance(168); await f.process(); assert.equal(sent.length, 4);
  assert.equal(f.status().states.EXHAUSTED, 1); assert.equal(notes.length, 1);
  advance(500); await f.process(); assert.equal(sent.length, 4);
});

test("Erinnerung ausserhalb des Zeitfensters wartet", async () => {
  const f = await started();
  at("2026-10-21T21:00:00+02:00"); await f.process(); assert.equal(sent.length, 1); // >48 h, aber 21 Uhr
  at("2026-10-25T11:00:00+01:00"); await f.process(); assert.equal(sent.length, 1); // Sonntag
  at("2026-10-26T09:00:00+01:00"); await f.process(); assert.equal(sent.length, 2);
});

test("Zahlung eingegangen → PAID, nie wieder Mail", async () => {
  const f = await started();
  setOrders([order({ payment_gate_met: true })]);
  advance(100); await f.process(); await f.process();
  assert.equal(sent.length, 1); assert.equal(f.status().states.PAID, 1);
});

test("Storno → STOPPED", async () => {
  const f = await started(); setOrders([order({ cancelled: true })]);
  advance(100); await f.process(); assert.equal(sent.length, 1); assert.equal(f.status().states.STOPPED, 1);
});

test("Kunde fragt nach dem Link → Link erneut im Thread; «bereits bezahlt» / Rabatt → MANUAL ohne Mail", async () => {
  let f = await started(); const t = sent[0].thread;
  g.inbound(t, "Können Sie mir den Zahlungslink nochmals schicken?"); advance(1); await f.process();
  assert.equal(sent.length, 2); assert.ok(sent[1].body.includes(L150));
  g.inbound(t, "Ich habe bereits bezahlt, bitte starten."); advance(1); await f.process();
  assert.equal(sent.length, 2); assert.equal(f.status().states.MANUAL, 1); assert.equal(notes.length, 1);
  advance(200); await f.process(); assert.equal(sent.length, 2);
});

test("Kunde will keine Mails mehr → STOPPED; fremder Absender im Thread wird nie beantwortet", async () => {
  let f = await started(); const t = sent[0].thread;
  g.inbound(t, "Bitte keine weiteren Mails, ich storniere.", {}); advance(1); await f.process();
  assert.equal(sent.length, 1); assert.equal(f.status().states.STOPPED, 1);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf079-w2-")); g = fakeGmail(); sent = []; notes = [];
  f = await started(); const t2 = sent[0].thread;
  g.inbound(t2, "Link bitte", { from: "Fremd <x@evil.com>" }); advance(1); await f.process();
  assert.equal(sent.length, 1);
});

test("Exactly-once: Versandstatus unklar → keine zweite Mail, MANUAL", async () => {
  const f = mk(); setOrders([]); await f.process(); setOrders([order()]);
  g.failSend = "fetch failed"; await f.process();
  assert.equal(sent.length, 0); assert.equal(f.status().states.MANUAL, 1);
  g.failSend = null; advance(100); await f.process(); await f.process();
  assert.equal(sent.length, 0);
});

test("VN-Auftrag und unbestätigter Auftrag bekommen nie eine Zahlungsanfrage", async () => {
  const f = mk(); setOrders([]); await f.process();
  setOrders([order({ market: "VN", offer_class: "VN_CHECK" }), order({ order_id: OID2, offer_class: "REPAIR_FIX_500", order_confirmed: false })]);
  await f.process(); assert.equal(sent.length, 0);
  assert.equal(pf.ineligibleReason(order({ customer_email: "kaputt" })), "no_email");
});
