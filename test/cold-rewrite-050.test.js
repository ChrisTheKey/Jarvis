// TF-050 COLD DRAFT QUALITY UPDATE: 1 belegter Befund genügt, höchstens 3 im Mailtext; bestehende Jarvis-eigene Cold-Entwürfe werden
// nur über das Register (nie über Betreff/Empfänger/Text) erkannt, Befunde öffentlich erneut geprüft und der Entwurf IN PLACE
// aktualisiert (pending_update → gmail.updateDraft). Nie senden, nie neu anlegen, fremde/transaktionale Entwürfe nie anfassen.
// Ohne Netzwerk, ohne echte Mail.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createColdDraft, ensureColdDraft, COLD_MODE, COLD_DRAFTS_FILE, draftHash } from "../swiss-repair.js";
import { createStore, createWorker } from "../mail-worker.js";
import { planColdDraftRewrite, applyColdDraftRewrites, createVerifier, candidateIssues, gmailDraftState } from "../cold-draft-rewrite.js";

const T0 = new Date("2026-10-13T08:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const HOME = "https://muster.ch/";
const issue = (type, severity, url, extra = {}) => ({ type, url, page: HOME, evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity, detectedAt: T0.toISOString(), ...extra });
const LINK = (n = "team", sev = "medium") => issue("broken_link", sev, `https://muster.ch/${n}-alt`, { label: n === "team" ? "Unser Team" : `Seite ${n}` });
const IMAGE = issue("broken_image", "medium", "https://muster.ch/img/team.jpg", { evidence: `Bild liefert HTTP 404 (eingebunden auf ${HOME})` });
const CONTACT = issue("contact_page_broken", "high", "https://muster.ch/kontakt", { label: "Kontakt" });
const CERT = issue("https_certificate", "high", HOME, { evidence: "TLS-Fehler beim Aufruf: CERT_HAS_EXPIRED" });
const MAILTO = issue("broken_mailto", "medium", HOME, { evidence: 'Ungültige mailto-Adresse im Link: "info(at)muster.ch"' });
const lead = (issues, over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: HOME, domain: "muster.ch", uid: "CHE-123.456.789", approved: false, consentBasis: null,
  status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true, title: "Muster AG – Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)",
  contact_source: "impressum", source_url: "https://muster.ch/impressum", collected_at: T0.toISOString(), contact_confidence: "medium", websiteIssues: issues, ...over,
});
const bullets = (body) => body.split("\n").filter((l) => l.startsWith("• "));

// Bestehender Entwurf im ALTEN Stil (vor TF-050), im Register als Cold-Entwurf desselben Leads geführt.
function existing(issues = [LINK(), IMAGE], over = {}) {
  const r = createColdDraft(lead(issues), { sender: SENDER, now: T0 });
  const body = r.body.replace(/^Guten Tag/, "Hallo") + "\n(alte Vorlage)";
  const review = { ...r, body, draft_hash: draftHash(r.subject, body), status: "draft_created", gmail_draft_id: "dr1", message_id: "m1", thread_id: "t1", ...over };
  const registry = { labelId: "L1", drafts: { dr1: { messageId: "m1", threadId: "t1", to: review.recipient, subject: review.subject, mode: COLD_MODE, leadId: "muster.ch" } }, sent: {} };
  const gmailState = { exists: true, isDraft: true, jarvisLabel: true, attachments: 0, toMatches: true, contentMatches: true, hasCc: false };
  return { review, registry, gmailState };
}
const plan = (e, ctx = {}) => planColdDraftRewrite("muster.ch", e.review, { registry: e.registry, lead: lead([LINK(), IMAGE]), gmailState: e.gmailState,
  verifiedIssues: [LINK(), IMAGE], sender: SENDER, now: T0, ...ctx });

test("A/B: 0 Findings → kein Draft; 1 Finding → Einzahl-Entwurf mit genau 1 Punkt und „Kurzer Hinweis …“", () => {
  assert.throws(() => createColdDraft(lead([]), { sender: SENDER, now: T0 }), /Nur für COLD_LEAD_DRAFT_ONLY/);
  const r = createColdDraft(lead([LINK()]), { sender: SENDER, now: T0 });
  assert.equal(bullets(r.body).length, 1);
  assert.match(r.body, /ist mir ein konkreter, für Besucher sichtbarer Punkt aufgefallen:/);
  assert.equal(r.subject, "Kurzer Hinweis zu Ihrer Website – muster.ch");
  assert.equal(r.draft_mode, COLD_MODE);
});

test("C/D/E: 2 → 2 Punkte, 3 → 3 Punkte, 4+ → höchstens 3, die wichtigsten zuerst (Kontakt vor Link vor Bild); nie aufgefüllt", () => {
  assert.equal(bullets(createColdDraft(lead([LINK(), IMAGE]), { sender: SENDER, now: T0 }).body).length, 2);
  assert.equal(bullets(createColdDraft(lead([LINK(), IMAGE, MAILTO]), { sender: SENDER, now: T0 }).body).length, 3);
  const many = createColdDraft(lead([IMAGE, MAILTO, LINK("a"), LINK("b"), CONTACT]), { sender: SENDER, now: T0 });
  const b = bullets(many.body);
  assert.equal(b.length, 3);
  assert.match(b[0], /Kontaktseite/);
  assert.match(b[1], /Link «Seite a»/);
  assert.equal(many.subject, "3 konkrete Hinweise zu Ihrer Website – muster.ch");
  // Jeder Punkt genau ein kurzer Satz, keine behauptete Folge, keine Drucksprache.
  for (const l of b) assert.equal((l.match(/\./g) || []).length, 1, l);
  assert.doesNotMatch(many.body, /kritisch|schwerwiegend|gefährlich|Kunden verlieren|verlieren Sie/i);
});

test("F: redundante Meldungen desselben Fehlers zählen einmal", () => {
  const dup = [LINK(), { ...LINK(), page: "https://muster.ch/ueber-uns" }, { ...LINK(), url: "https://muster.ch/team-alt/#x" }];
  assert.equal(bullets(createColdDraft(lead(dup), { sender: SENDER, now: T0 }).body).length, 1);
});

test("G: unverifizierter Befund wird nicht verwendet (Verifier fail closed); 0 bestätigte → Entwurf bleibt unverändert", async () => {
  const html = `<a href="/team-alt">Unser Team</a><a href="/kontakt">Kontakt</a><img src="/img/team.jpg"><a href="mailto:info(at)muster.ch">Mail</a>`;
  const responses = {
    [HOME]: { status: 200, html }, "https://muster.ch/team-alt": { status: 404 }, "https://muster.ch/kontakt": { status: 200 },
    "https://muster.ch/img/team.jpg": { status: 404 }, "https://muster.ch/weg-alt": { status: 404 },
  };
  const fetchFn = async (u) => {
    if (u === "https://muster.ch/netz-alt") throw Object.assign(new Error("x"), { code: "ECONNRESET" });
    const r = responses[u];
    if (!r) throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
    return { status: r.status, url: u, headers: { get: () => (r.html ? "text/html" : "image/jpeg") }, text: async () => r.html || "", body: null };
  };
  const v = createVerifier({ fetchFn, gapMs: 0 });
  assert.deepEqual(await v.verify(LINK()), { verified: true });
  assert.deepEqual(await v.verify(IMAGE), { verified: true });
  assert.deepEqual(await v.verify(MAILTO), { verified: true });
  assert.equal((await v.verify(CONTACT)).reason, "fixed", "Kontaktseite inzwischen erreichbar → nicht mehr verwenden");
  assert.equal((await v.verify(LINK("weg"))).reason, "no_longer_linked", "Link nicht mehr auf der Seite");
  assert.equal((await v.verify(issue("visible_layout_error", "medium", HOME, { reproducible: true, location: "Start" }))).verified, false);
  const tls = createVerifier({ fetchFn: async () => { throw Object.assign(new Error("x"), { cause: { code: "CERT_HAS_EXPIRED" } }); }, gapMs: 0 });
  assert.deepEqual(await tls.verify(CERT), { verified: true });
  const down = createVerifier({ fetchFn: async () => { throw Object.assign(new Error("x"), { code: "ETIMEDOUT" }); }, gapMs: 0 });
  assert.equal((await down.verify(LINK())).verified, false, "Netzfehler ist nie ein Beleg");
  assert.equal((await down.verify(CERT)).verified, false);
  // Nur Rohbefunde, die eine Kundenaussage ergeben können, werden überhaupt geprüft.
  assert.deepEqual(candidateIssues([LINK(), issue("slow_response", "high", HOME), issue("missing_title", "medium", HOME)]).map((i) => i.type), ["broken_link"]);
  // Plan: nur bestätigte Befunde im Text; 0 bestätigte → SKIPPED_NO_VERIFIED_FINDING ohne Patch.
  const one = plan(existing(), { verifiedIssues: [IMAGE] });
  assert.equal(one.outcome, "UPDATE"); assert.equal(one.findings, 1);
  assert.ok(!one.patch.body.includes("Unser Team")); assert.equal(one.patch.subject, "Kurzer Hinweis zu Ihrer Website – muster.ch");
  const none = plan(existing(), { verifiedIssues: [] });
  assert.deepEqual([none.outcome, none.patch], ["SKIPPED_NO_VERIFIED_FINDING", undefined]);
});

test("H/J: fremde, transaktionale oder nicht eindeutig zugeordnete Entwürfe werden nie verändert", () => {
  const e = existing();
  assert.equal(plan({ ...e, registry: { ...e.registry, drafts: {} } }).outcome, "SKIPPED_AMBIGUOUS_OWNERSHIP", "nicht im Register = fremd");
  assert.equal(plan({ ...e, registry: { ...e.registry, drafts: { dr1: { ...e.registry.drafts.dr1, mode: undefined } } } }).outcome, "SKIPPED_AMBIGUOUS_OWNERSHIP");
  assert.equal(plan({ ...e, registry: { ...e.registry, drafts: { dr1: { ...e.registry.drafts.dr1, leadId: "andere.ch" } } } }).outcome, "SKIPPED_AMBIGUOUS_OWNERSHIP", "anderer Lead");
  assert.equal(plan({ ...e, registry: { ...e.registry, drafts: { dr1: { ...e.registry.drafts.dr1, messageClass: "CUSTOMER_ORDER_FULFILLMENT" } } } }).outcome, "SKIPPED_AMBIGUOUS_OWNERSHIP", "Kundenauftrag");
  assert.equal(plan({ ...e, review: { ...e.review, draft_mode: undefined } }).outcome, "SKIPPED_AMBIGUOUS_OWNERSHIP", "kein Cold-Eintrag");
  assert.equal(plan({ ...e, gmailState: { ...e.gmailState, toMatches: false } }).outcome, "SKIPPED_AMBIGUOUS_OWNERSHIP", "Empfänger in Gmail abweichend");
  assert.equal(plan({ ...e, gmailState: { ...e.gmailState, jarvisLabel: false } }).outcome, "SKIPPED_NOT_A_DRAFT");
  assert.equal(plan({ ...e, gmailState: { ...e.gmailState, attachments: 1 } }).outcome, "SKIPPED_ATTACHMENT");
  assert.equal(plan({ ...e, gmailState: { ...e.gmailState, contentMatches: false } }).outcome, "SKIPPED_EDITED", "von Chris in Gmail bearbeitet → nie überschreiben");
  assert.equal(plan(e, { blockReason: "Antwort erhalten" }).outcome, "SKIPPED_BLOCKED");
  assert.equal(plan({ ...e, review: { ...e.review, pending_update: true } }).outcome, "SKIPPED_EDITED");
});

test("I: manuell bereits gesendeter Lead wird nie neu gecoldet oder verändert", () => {
  const e = existing();
  assert.equal(plan({ ...e, review: { ...e.review, status: "manually_sent", manual_send_detected: true } }).outcome, "SKIPPED_ALREADY_MANUALLY_SENT");
  assert.equal(plan({ ...e, registry: { ...e.registry, sent: { m9: { fromDraft: "dr1", manual: true, leadId: "muster.ch" } } } }).outcome, "SKIPPED_ALREADY_MANUALLY_SENT");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-050i-"));
  const store = createStore(dir);
  fs.writeFileSync(path.join(dir, "suppression.json"), "{}");
  store.write(COLD_DRAFTS_FILE, { reviews: { "muster.ch": { ...e.review, status: "manually_sent", manual_send_detected: true } } });
  assert.equal(ensureColdDraft(store, lead([LINK()]), { sender: SENDER, now: T0 }).blocked, "bereits kontaktiert");
});

test("gmailDraftState: Text-Entwurf erkannt, Anhang/HTML/abweichender Text gemeldet – ohne Inhalt nach aussen", () => {
  const { review } = existing();
  const enc = (s) => Buffer.from(s).toString("base64url");
  const msg = (payload, labelIds = ["DRAFT", "L1"]) => ({ message: { labelIds, payload } });
  const headers = [{ name: "To", value: review.recipient }, { name: "Subject", value: `=?UTF-8?B?${Buffer.from(review.subject).toString("base64")}?=` }];
  const ok = gmailDraftState(msg({ mimeType: "text/plain", headers, body: { data: enc(review.body.replace(/\n/g, "\r\n")) } }), { review, labelId: "L1" });
  assert.deepEqual(ok, { exists: true, isDraft: true, jarvisLabel: true, attachments: 0, toMatches: true, contentMatches: true, hasCc: false });
  const att = gmailDraftState(msg({ mimeType: "multipart/mixed", headers, parts: [{ mimeType: "text/plain", body: { data: enc(review.body) } }, { mimeType: "application/pdf", filename: "x.pdf", body: { attachmentId: "a" } }] }), { review, labelId: "L1" });
  assert.equal(att.attachments, 1);
  const edited = gmailDraftState(msg({ mimeType: "multipart/alternative", headers, parts: [{ mimeType: "text/plain", body: { data: enc(review.body + " geändert") } }, { mimeType: "text/html", body: { data: enc("<p>x</p>") } }] }), { review, labelId: "L1" });
  assert.equal(edited.contentMatches, false);
  assert.equal(gmailDraftState(null).exists, false);
});

test("K/L: Update nur in place über pending_update → gmail.updateDraft (Empfänger/Thread bleiben), keine Send-Aktion, zweiter Lauf idempotent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-050-"));
  const store = createStore(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: SENDER }));
  fs.writeFileSync(path.join(dir, "suppression.json"), "{}");
  const e = existing([LINK(), IMAGE, MAILTO, CONTACT]);
  store.write(COLD_DRAFTS_FILE, { reviews: { "muster.ch": e.review } });
  const g = { reg: structuredClone(e.registry), calls: [] };
  Object.assign(g, {
    listOwned: () => structuredClone(g.reg),
    async createDraft({ to }) { g.calls.push("CREATE " + to); throw new Error("nie neu anlegen"); },
    async updateDraft(id, { subject, body, to }) { g.calls.push(`update ${id} to=${to ?? "unverändert"}`); g.reg.drafts[id] = { ...g.reg.drafts[id], subject }; g.body = body; return { draftId: id, threadId: "t1" }; },
    async sendDraft(id) { g.calls.push("SEND " + id); throw new Error("nie senden"); },
    async deleteDraft(id) { g.calls.push("DELETE " + id); },
    async readThread() { return { messages: [] }; }, async markDraftForReview() {}, async syncColdDrafts() { return []; },
  });
  const worker = createWorker({ dir, gmail: g, now: () => T0, log: () => {}, compose: async () => ({ decision: "draft", body: "x" }) });
  const ctx = { lead: lead([LINK(), IMAGE, MAILTO, CONTACT]), verifiedIssues: [LINK(), IMAGE, MAILTO, CONTACT] };
  const p1 = planColdDraftRewrite("muster.ch", store.read(COLD_DRAFTS_FILE, {}).reviews["muster.ch"], { registry: g.reg, gmailState: e.gmailState, sender: SENDER, now: T0, ...ctx });
  assert.equal(p1.outcome, "UPDATE"); assert.equal(p1.findings, 3, "4 Befunde → höchstens 3 im Mail");
  assert.deepEqual(applyColdDraftRewrites(store, [p1], T0), { applied: ["muster.ch"], stale: [] });
  assert.deepEqual(applyColdDraftRewrites(store, [p1], T0), { applied: [], stale: ["muster.ch"] }, "zweites Anwenden derselben Planung ist wirkungslos");
  const r1 = await worker.tick();
  assert.deepEqual(g.calls, ["update dr1 to=unverändert"], "genau ein In-place-Update, kein Create/Send/Delete");
  assert.deepEqual(r1.sends, []);
  const after = store.read(COLD_DRAFTS_FILE, {}).reviews["muster.ch"];
  assert.deepEqual([after.status, after.pending_update, after.gmail_draft_id, after.recipient, after.thread_id, after.draft_mode, after.legal_basis, after.automatic_send_allowed],
    ["draft_created", false, "dr1", e.review.recipient, "t1", COLD_MODE, "NONE", false]);
  assert.equal(g.body, after.body);
  assert.equal(bullets(after.body).length, 3);
  // Zweiter Lauf: Gmail zeigt jetzt die neue Fassung → UNCHANGED, kein weiteres Update, kein zweiter Entwurf.
  const p2 = planColdDraftRewrite("muster.ch", after, { registry: g.reg, gmailState: e.gmailState, sender: SENDER, now: T0, ...ctx });
  assert.equal(p2.outcome, "UNCHANGED");
  assert.deepEqual(applyColdDraftRewrites(store, [p2], T0).applied, []);
  await worker.tick();
  assert.deepEqual(g.calls, ["update dr1 to=unverändert"]);
  assert.equal(Object.keys(store.read(COLD_DRAFTS_FILE, {}).reviews).length, 1);
  assert.equal(ensureColdDraft(store, lead([LINK()]), { sender: SENDER, now: T0 }).blocked, "offener Entwurf vorhanden", "kein zweiter Entwurf für denselben Lead");
});

test("Modul kennt keinen Sendepfad und kein Gmail-Schreiben", () => {
  const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  const src = fs.readFileSync(path.join(ROOT, "cold-draft-rewrite.js"), "utf8").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /sendDraft|sendEmail|drafts\/send|createDraft|deleteDraft|force[ _-]?send|auto[ _-]?send|method:\s*"(POST|PUT|DELETE)"/i);
});
