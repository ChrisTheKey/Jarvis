// TF-JARVIS-025 – Ausgangsprüfung für Stripe-Zahlungslinks: nur exakt freigegebene Links (PAYMENT_LINKS bzw. deklarierte Checkout-Session) verlassen
// Jarvis automatisch. Unbekannt/verändert → Versand gesperrt, Entwurf JARVIS-PRUEFEN. Läuft ohne Netzwerk – fetch ist eine Gmail-Attrappe.
// 0 echte Zahlungen, 0 Aufrufe an Stripe, 0 Mails.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf025-"));
process.env.JARVIS_SECRETS_DIR = dir;
const gmail = await import("../gmail.js");
const { PAYMENT_LINKS, paymentLinkFor, paymentLinesDe, paymentOptions, paymentLinkViolations } = await import("../payment-links.js");
const { composeReply } = await import("../contact-form.js");
const { renderJourneyReply } = await import("../contact-form-journey.js");

const L150 = PAYMENT_LINKS.REPAIR_CHECK_150, L480 = PAYMENT_LINKS.REPAIR_FIX_500;
const OID = "RF480-20261021-abc025", CID = "CA150-20261021-abc025";
const SESSION = "https://checkout.stripe.com/c/pay/cs_live_fixture0025#fidkdWxOYHwnPyd1blpxYHZxWjA0";
const codes = (t, o) => paymentLinkViolations(t, o).map((v) => v.reason);
// Fehlerklassen der Aufrufer (contact-form-journey/onboarding-dialogue/payment-followup/mail-worker): eine Sperre darf nie als «erneut versuchen» gelten.
const SAFE_RETRY_RE = /nicht gesendet|andere Sendung läuft|Register gesperrt|Tageslimit/i;
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|timeout|aborted|OUTBOX_PENDING/i;

// ---------- Prüfmodul ----------
test("gültig: exakt freigegebene Links (ohne/mit Auftrags-ID und E-Mail), Texte der Vorlagen, Mails ohne Zahlungslink", () => {
  for (const t of [L150, L480, paymentLinkFor("REPAIR_FIX_500", { orderId: OID }), paymentLinkFor("REPAIR_CHECK_150", { orderId: CID, email: "Anna@Muster.ch" }),
    `Bitte hier bezahlen: ${L480}.`, `(${L150})`, `<${L480}>`, paymentLinesDe({}).join("\n"), paymentLinesDe({ kind: "FIX", orderId: OID, email: "a@b.ch" }).join("\n"),
    paymentOptions().map((o) => o.link).join("\n"),
    "Guten Tag\n\nVielen Dank für Ihre Nachricht. Bezahlung sicher über Stripe. Freundliche Grüsse", "", null, undefined])
    assert.deepEqual(codes(t), [], String(t));
  const reply = composeReply({ inquiry: { name: "Anna", message: "Hallo" }, sender: { name: "Chris" }, context: { payment: { kind: null, orderId: null, email: "a@b.ch" } } });
  assert.match(reply.body, /buy\.stripe\.com/); assert.deepEqual(codes(reply.body), []);
});

test("manipuliert: Pfad, Zusatzparameter, doppelte Parameter, Fragment, http, ohne Schema, Grossschreibung, ungültige Auftrags-ID, Testlink", () => {
  const cases = [
    [`${L480}x`, "UNKNOWN_PAYMENT_LINK"],
    [`${L480.slice(0, -1)}Z`, "UNKNOWN_PAYMENT_LINK"], // ein Zeichen anders
    [`${L480}/extra`, "UNKNOWN_PAYMENT_LINK"],
    [`${L480}?client_reference_id=${OID}&amount=1`, "MODIFIED_PAYMENT_LINK"],
    [`${L480}?utm_source=mail`, "MODIFIED_PAYMENT_LINK"],
    [`${L480}?client_reference_id=${OID}&client_reference_id=${CID}`, "MODIFIED_PAYMENT_LINK"],
    [`${L480}#rabatt`, "MODIFIED_PAYMENT_LINK"],
    [`${L480}?client_reference_id=RF480-1;drop`, "MODIFIED_PAYMENT_LINK"],
    [`${L480}?prefilled_email=a%40b.ch&client_reference_id=${OID}`, "MODIFIED_PAYMENT_LINK"], // andere Reihenfolge = nicht exakt
    [L480.replace("https://", "http://"), "NOT_HTTPS"],
    [L480.replace("https://", ""), "NOT_HTTPS"],
    [L480.replace("buy.stripe.com", "BUY.STRIPE.COM"), "MODIFIED_PAYMENT_LINK"],
    ["https://buy.stripe.com/test_" + L480.split("/").pop(), "UNKNOWN_PAYMENT_LINK"],
  ];
  for (const [t, code] of cases) assert.deepEqual(codes(`Zahlung: ${t}`), [code], t);
});

test("unbekannt: fremde Stripe-Adressen, Doppelgänger-Domains, nicht deklarierte Checkout-Session, Unicode-Tricks", () => {
  const cases = [
    ["https://buy.stripe.com/aaaaaaaaaaaaaaaa", "UNKNOWN_PAYMENT_LINK"],
    [`https://buy.stripe.com.evil.ch/${L480.split("/").pop()}`, "UNKNOWN_PAYMENT_LINK"],
    ["https://pay.stripe.com/invoice/x", "UNKNOWN_PAYMENT_HOST"],
    ["https://stripe-zahlung.ch/pay/480", "UNKNOWN_PAYMENT_HOST"],
    ["https://mystripe.com/checkout", "UNKNOWN_PAYMENT_HOST"],
    [SESSION, "UNDECLARED_CHECKOUT_LINK"],
    ["https://ｂｕｙ.ｓｔｒｉｐｅ.ｃｏｍ/aaaaaaaaaaaaaaaa", "UNKNOWN_PAYMENT_LINK"],
  ];
  for (const [t, code] of cases) assert.deepEqual(codes(t), [code], t);
  // deklarierte Session: nur genau diese
  assert.deepEqual(codes(`Link: ${SESSION}`, { allowedCheckoutUrls: [SESSION] }), []);
  assert.deepEqual(codes(SESSION.replace("0025", "0026"), { allowedCheckoutUrls: [SESSION] }), ["UNDECLARED_CHECKOUT_LINK"]);
  // mehrere Links: jeder einzeln geprüft
  assert.deepEqual(codes(`${L150}\n${L480}\nhttps://buy.stripe.com/aaaaaaaaaaaaaaaa`), ["UNKNOWN_PAYMENT_LINK"]);
  // Grundcodes, nie die URL (Auftrags-ID/E-Mail) in der Ausgabe
  assert.ok(!JSON.stringify(paymentLinkViolations(`${L480}?client_reference_id=${OID}&x=1`)).includes(OID));
});

test("Anzahlungs-Vorlage (TF-080): Checkout-Session nur zusammen mit ihrer Deklaration zulässig", () => {
  const body = renderJourneyReply("ORDER_CONFIRMED", { it: { name: "Anna" }, j: { domain: "kunde.ch", order_id: OID }, order: null, pay: { url: SESSION, seq: 1 } });
  assert.ok(body.includes(SESSION));
  assert.deepEqual(codes(body), ["UNDECLARED_CHECKOUT_LINK"]);
  assert.deepEqual(codes(body, { allowedCheckoutUrls: [SESSION] }), []);
});

// ---------- Versandsperre in gmail.js (letzte Instanz vor jedem Versand) ----------
let drafts, sent, calls, n, labels;
beforeEach(() => {
  fs.writeFileSync(path.join(dir, "gmail_credentials.json"), JSON.stringify({ installed: { client_id: "id", client_secret: "s" } }));
  fs.writeFileSync(path.join(dir, "gmail_token.json"), JSON.stringify({ access_token: "a", refresh_token: "r", expiry: Date.now() + 3600e3 }));
  fs.rmSync(path.join(dir, "gmail_jarvis.json"), { force: true });
  drafts = {}; sent = []; calls = []; n = 1; labels = [{ id: "Label_J", name: "JARVIS" }];
});
const mimeText = (raw) => { const [head, ...rest] = raw.split("\r\n\r\n"); return { subject: head.match(/^Subject: (.*)$/m)?.[1] || "", body: Buffer.from(rest.join("").replace(/\r\n/g, ""), "base64").toString("utf8") }; };
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url), route = u.pathname.replace("/gmail/v1/users/me", ""), method = opts.method || "GET", body = opts.body ? JSON.parse(opts.body) : null;
  calls.push(`${method} ${route}${u.search}`);
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
  if (u.hostname !== "gmail.googleapis.com") return reply({ error: { message: "kein Netz im Test" } }, 400);
  if (route === "/labels" && method === "GET") return reply({ labels });
  if (route === "/labels" && method === "POST") { const l = { id: "Label_R", name: body.name }; labels.push(l); return reply(l); }
  if (route === "/drafts" && method === "POST") {
    const id = "d" + n++, raw = Buffer.from(body.message.raw, "base64url").toString();
    drafts[id] = { id, raw, message: { id: "m" + id, threadId: body.message.threadId || "t" + id, labelIds: ["DRAFT"] } };
    return reply(drafts[id]);
  }
  let m;
  if (route !== "/drafts/send" && (m = route.match(/^\/drafts\/([^/]+)$/))) {
    const d = drafts[m[1]];
    if (!d) return reply({ error: { message: "not found" } }, 404);
    if (method === "PUT") { d.raw = Buffer.from(body.message.raw, "base64url").toString(); d.message = { ...d.message, id: "m" + d.id + "-" + n++ }; }
    if (u.searchParams.get("format") === "full" && !d.noPayload) { const x = mimeText(d.raw);
      return reply({ ...d, message: { ...d.message, payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: x.subject }], body: { data: Buffer.from(x.body).toString("base64url") } } } }); }
    return reply(d);
  }
  if ((m = route.match(/^\/messages\/([^/]+)\/modify$/))) {
    const d = Object.values(drafts).find((x) => x.message.id === m[1]);
    const msg = d ? d.message : { id: m[1], threadId: "tS", labelIds: [] };
    msg.labelIds.push(...body.addLabelIds); return reply(msg);
  }
  if ((m = route.match(/^\/messages\/([^/]+)$/))) {
    const d = Object.values(drafts).find((x) => x.message.id === m[1]);
    return reply({ ...(d?.message || { id: m[1], threadId: "tS", labelIds: ["SENT", "Label_J"] }), payload: { headers: [{ name: "Message-ID", value: `<${m[1]}@mail.gmail.com>` }] } });
  }
  if (route === "/drafts/send") { const d = drafts[body.id]; delete drafts[body.id]; sent.push({ id: "sent-" + d.id, threadId: d.message.threadId, labelIds: ["SENT"], raw: d.raw }); return reply(sent.at(-1)); }
  return reply({ error: { message: "unbekannt " + route } }, 400);
};
const draft = (body, extra = {}) => gmail.createDraft({ to: "kunde@muster.ch", subject: "Ihre Anfrage", body, ...extra });
const sendsTried = () => calls.filter((c) => c.startsWith("POST /drafts/send")).length;

test("Versand: Mail ohne Zahlungslink und Mail mit exakt freigegebenem Link werden gesendet (keine Zusatzabfrage)", async () => {
  for (const body of ["Guten Tag\n\nVielen Dank für Ihre Nachricht.", `Guten Tag\n\n${paymentLinkFor("REPAIR_FIX_500", { orderId: OID, email: "a@b.ch" })}\n`, paymentLinesDe({}).join("\n")]) {
    const d = await draft(body);
    assert.deepEqual(gmail.listOwned().drafts[d.draftId].paymentLinkCheck, { ok: true, reasons: [] });
    await gmail.sendDraft(d.draftId);
  }
  assert.equal(sent.length, 3);
  assert.ok(!calls.some((c) => c.includes("format=full")), "geprüft wird der selbst geschriebene Inhalt – kein zusätzlicher Abruf");
});

test("Versand gesperrt: veränderter/unbekannter Link → kein Versand, Label JARVIS-PRUEFEN, Register markiert, bleibt gesperrt, nie «erneut versuchen»", async () => {
  for (const [i, body] of [`${L480}?client_reference_id=${OID}&amount=1`, "https://buy.stripe.com/aaaaaaaaaaaaaaaa", "https://stripe-zahlung.ch/pay", SESSION].entries()) {
    const d = await draft(`Guten Tag\n\n${body}\n`);
    assert.equal(gmail.listOwned().drafts[d.draftId].paymentLinkCheck.ok, false);
    const err = await gmail.sendDraft(d.draftId).catch((e) => e);
    assert.equal(err.code, gmail.PAYMENT_LINK_BLOCKED, body);
    assert.match(err.message, /PAYMENT_LINK_BLOCKED/);
    assert.doesNotMatch(err.message, SAFE_RETRY_RE); assert.doesNotMatch(err.message, TRANSIENT_RE);
    assert.ok(!err.message.includes(OID), "keine Auftrags-ID/URL in der Meldung");
    assert.ok(drafts[d.draftId].message.labelIds.includes("Label_R"), "Entwurf zur Prüfung markiert");
    assert.ok(gmail.listOwned().drafts[d.draftId].paymentLinkBlocked.reasons.length >= 1);
    await assert.rejects(gmail.sendDraft(d.draftId), (e) => e.code === gmail.PAYMENT_LINK_BLOCKED);
    assert.equal(sendsTried(), 0, `Versuch ${i}`);
  }
  assert.equal(sent.length, 0);
  assert.ok(labels.some((l) => l.name === gmail.REVIEW_LABEL));
});

test("Checkout-Session: nur mit Deklaration des Vorlagen-Codes; KI/fremder Text kann keine Session «freischalten»", async () => {
  const ok = await draft(`Zahlungslink:\n${SESSION}\n`, { paymentUrls: [SESSION] });
  await gmail.sendDraft(ok.draftId);
  const other = await draft(`Zahlungslink:\n${SESSION.replace("0025", "0026")}\n`, { paymentUrls: [SESSION] });
  await assert.rejects(gmail.sendDraft(other.draftId), (e) => e.code === gmail.PAYMENT_LINK_BLOCKED);
  const bogus = await draft("Zahlungslink:\nhttps://stripe-zahlung.ch/pay\n", { paymentUrls: ["https://stripe-zahlung.ch/pay"] }); // keine checkout.stripe.com-Adresse → verworfen
  assert.equal(gmail.listOwned().drafts[bogus.draftId].paymentUrls, undefined);
  await assert.rejects(gmail.sendDraft(bogus.draftId), (e) => e.code === gmail.PAYMENT_LINK_BLOCKED);
  assert.equal(sent.length, 1);
});

test("updateDraft prüft neu: sauber → manipuliert gesperrt; manipuliert → sauber wieder sendbar (solange nie gesperrt)", async () => {
  const a = await draft("Guten Tag");
  await gmail.updateDraft(a.draftId, { body: `Neu: ${L480}?amount=1` });
  await assert.rejects(gmail.sendDraft(a.draftId), (e) => e.code === gmail.PAYMENT_LINK_BLOCKED);
  const b = await draft(`Alt: ${L480}?amount=1`);
  await gmail.updateDraft(b.draftId, { body: `Neu: ${L480}` });
  await gmail.sendDraft(b.draftId);
  assert.equal(sent.length, 1);
  assert.match(mimeText(sent[0].raw).body, new RegExp(L480.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
});

test("Altentwurf ohne Prüfergebnis (vor dem Update angelegt): Inhalt wird geladen und geprüft; nicht lesbar → gesperrt (fail closed)", async () => {
  const strip = (id) => { const p = path.join(dir, "gmail_jarvis.json"), r = JSON.parse(fs.readFileSync(p, "utf8")); delete r.drafts[id].paymentLinkCheck; fs.writeFileSync(p, JSON.stringify(r)); };
  const clean = await draft(`Guten Tag\n${L150}`); strip(clean.draftId);
  await gmail.sendDraft(clean.draftId);
  assert.ok(calls.some((c) => c.includes(`/drafts/${clean.draftId}?format=full`)));
  const bad = await draft("Guten Tag\nhttps://buy.stripe.com/aaaaaaaaaaaaaaaa"); strip(bad.draftId);
  await assert.rejects(gmail.sendDraft(bad.draftId), (e) => e.code === gmail.PAYMENT_LINK_BLOCKED);
  const blind = await draft("Guten Tag"); strip(blind.draftId); drafts[blind.draftId].noPayload = true;
  await assert.rejects(gmail.sendDraft(blind.draftId), (e) => e.code === gmail.PAYMENT_LINK_BLOCKED && /CONTENT_UNREADABLE/.test(e.message));
  assert.equal(sent.length, 1);
});

test("cleanup", () => { fs.rmSync(dir, { recursive: true, force: true }); });
