// COLD OUTREACH — 2–3 VERIFIED WEBSITE FINDINGS (034): Jede neue Cold-Mail nennt 2–3 unterschiedliche, belegte, für Besucher sichtbare
// Probleme der jeweiligen Website (Severity zuerst, dann Besucherwirkung). 0–1 Befund → kein Entwurf. Nichts wird erfunden.
// Draft-only unverändert. Keine Mail, kein Netzwerk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualifyRepairLead, createColdDraft, ensureColdDraft, selectCustomerVisibleFindings, customerFindings, FULL_CHECK_TEXT, FINDINGS_INTRO,
  MIN_COLD_FINDINGS, MAX_CUSTOMER_FINDINGS, COLD_MODE, COLD_DRAFTS_FILE, CUSTOMER_JARGON_RE } from "../swiss-repair.js";
import { LANDING_PAGE_URL } from "../sales.js";
import { createStore, createWorker } from "../mail-worker.js";

const T0 = new Date("2026-10-11T08:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const HOME = "https://muster.ch/";
const issue = (type, severity, url, extra = {}) => ({ type, url, page: HOME, evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity, detectedAt: T0.toISOString(), ...extra });
const visual = (type, severity, location) => issue(type, severity, "https://muster.ch/", { reproducible: true, location, evidence: `${type} bei 375 px, 2× reproduziert` });
const LINK = (n = "team", sev = "medium") => issue("broken_link", sev, `https://muster.ch/${n}-alt`, { label: n === "team" ? "Unser Team" : `Seite ${n}` });
const IMAGE = issue("broken_image", "medium", "https://muster.ch/img/team.jpg", { evidence: `Bild liefert HTTP 404 (eingebunden auf ${HOME})` });
const BUTTON = visual("button_broken", "medium", "Offerte anfragen");
const FORM = visual("contact_form_broken", "high", "Kontakt");
const CERT = issue("https_certificate", "high", HOME, { evidence: "TLS-Fehler beim Aufruf: CERT_HAS_EXPIRED" });
const lead = (issues, over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: HOME, domain: "muster.ch", uid: "CHE-123.456.789", approved: false, consentBasis: null,
  status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true, title: "Muster AG – Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)",
  contact_source: "impressum", source_url: "https://muster.ch/impressum", collected_at: T0.toISOString(), contact_confidence: "medium", websiteIssues: issues, ...over,
});
const q = (issues) => qualifyRepairLead(lead(issues), { now: T0 });
const draft = (issues) => createColdDraft(lead(issues), { sender: SENDER, now: T0 });
const bullets = (body) => body.split("\n").filter((l) => l.startsWith("• "));

test("Regel: mindestens 2, höchstens 3 Findings", () => {
  assert.deepEqual([MIN_COLD_FINDINGS, MAX_CUSTOMER_FINDINGS], [2, 3]);
});

test("0 Probleme → kein Draft", () => {
  const r = q([]);
  assert.equal(r.draft_creation_eligible, false);
  assert.throws(() => draft([]), /Nur für COLD_LEAD_DRAFT_ONLY/);
});

test("1 Problem → kein Draft (kein zweiter Punkt wird erfunden)", () => {
  const r = q([LINK()]);
  assert.equal(r.customer_findings.length, 1);
  assert.deepEqual([r.draft_creation_eligible, r.contact_basis, r.cold_block_reason, r.stage], [false, "NONE", "TOO_FEW_VISIBLE_ISSUES", "no_visible_issue"]);
  assert.throws(() => draft([LINK()]), /Nur für COLD_LEAD_DRAFT_ONLY/);
  // Ein sichtbarer Befund + nur interne Befunde (Ladezeit, Titel) bleibt EIN Befund.
  const r2 = q([LINK(), issue("slow_response", "high", HOME, { evidence: "LCP 7 s" }), issue("missing_title", "medium", HOME, { evidence: "kein <title>" })]);
  assert.equal(r2.draft_creation_eligible, false);
});

test("2 valide unterschiedliche Probleme → Draft mit exakt 2 Findings", () => {
  const r = draft([LINK(), IMAGE]);
  assert.equal(r.customer_findings.length, 2);
  assert.equal(bullets(r.body).length, 2);
  assert.ok(r.body.includes(`\n\n${FINDINGS_INTRO}\n\n• `));
});

test("3 valide unterschiedliche Probleme → Draft mit exakt 3 Findings", () => {
  const r = draft([LINK(), IMAGE, BUTTON]);
  assert.equal(r.customer_findings.length, 3);
  assert.equal(bullets(r.body).length, 3);
});

test("4 valide Probleme → die 3 wichtigsten", () => {
  const r = draft([IMAGE, LINK(), FORM, CERT]);
  assert.equal(bullets(r.body).length, 3);
  assert.deepEqual(r.customer_findings.map((f) => f.severity), ["high", "high", "medium"]);
  assert.match(bullets(r.body)[0], /Kontaktformular/);
  assert.match(bullets(r.body)[1], /Warnmeldung/);
  assert.match(bullets(r.body)[2], /Link «Unser Team»/, "Link vor Bild bei gleichem Schweregrad");
  assert.ok(!r.body.includes("Bild nicht angezeigt"), "viertwichtigster Punkt fällt weg");
});

test("10 valide Probleme → maximal 3 im Mailtext", () => {
  const many = [IMAGE, BUTTON, FORM, CERT, ...["a", "b", "c", "d", "e", "f"].map((n) => LINK(n))];
  assert.equal(selectCustomerVisibleFindings(many).length, 3);
  assert.equal(bullets(draft(many).body).length, 3);
});

test("HIGH + MEDIUM → HIGH zuerst (unabhängig von der Reihenfolge im Audit)", () => {
  const f = selectCustomerVisibleFindings([IMAGE, LINK("x", "high")]);
  assert.deepEqual(f.map((x) => x.severity), ["high", "medium"]);
  const c = selectCustomerVisibleFindings([IMAGE, issue("broken_link", "critical", "https://muster.ch/shop", { label: "Shop" })]);
  assert.equal(c[0].severity, "critical", "CRITICAL vor allem anderen");
});

test("3 MEDIUM → alle drei nach Besucherwirkung (Button > Link > Bild)", () => {
  const f = selectCustomerVisibleFindings([IMAGE, LINK(), BUTTON]);
  assert.equal(f.length, 3);
  assert.match(f[0].text, /Button «Offerte anfragen»/);
  assert.match(f[1].text, /Link «Unser Team»/);
  assert.match(f[2].text, /Bild/);
});

test("Duplicate Findings → nur einmal gezählt (kein Draft aus zwei Kopien desselben Fehlers)", () => {
  const dup = [LINK(), { ...LINK(), page: "https://muster.ch/ueber-uns" }, { ...LINK(), url: "https://muster.ch/team-alt/#x" }];
  const f = selectCustomerVisibleFindings(dup);
  assert.equal(f.length, 1);
  assert.equal(f[0].internal_refs.length, 3);
  assert.equal(q(dup).draft_creation_eligible, false);
});

test("2 technische Meldungen desselben sichtbaren Fehlers → ein Customer-Finding", () => {
  // „Navigation überlappt“ + „Menü abgeschnitten“ = derselbe sichtbare Defekt.
  const nav = [visual("mobile_text_overlap", "medium", "Navigation"), visual("mobile_content_cut_off", "medium", "Menü")];
  assert.equal(selectCustomerVisibleFindings(nav).length, 1);
  assert.equal(q(nav).draft_creation_eligible, false);
  // Kaputte Kontaktseite + defekter Link auf genau diese Seite = ein Fehler.
  const contact = [issue("contact_page_broken", "high", "https://muster.ch/kontakt"), issue("broken_link", "medium", "https://muster.ch/kontakt", { label: "Kontakt" })];
  const f = selectCustomerVisibleFindings(contact);
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "high", "höchster Schweregrad der zusammengeführten Meldungen zählt");
});

test("LOW nur, wenn eindeutig sichtbar (reproduzierter Darstellungsfehler mit Bereich)", () => {
  assert.equal(selectCustomerVisibleFindings([LINK("x", "low")]).length, 0, "LOW-Link zählt nicht");
  assert.equal(selectCustomerVisibleFindings([visual("mobile_content_cut_off", "low", "Öffnungszeiten")]).length, 1);
  assert.equal(selectCustomerVisibleFindings([{ ...visual("mobile_content_cut_off", "low", "Öffnungszeiten"), reproducible: false }]).length, 0);
});

test("technische Evidence nicht im Mailtext; keine Fachbegriffe", () => {
  const r = draft([LINK(), IMAGE, CERT]);
  const customer = r.body.split("\nFreundliche Grüsse")[0].replace(LANDING_PAGE_URL, "").replace(/CHF \d+/g, "");
  assert.doesNotMatch(customer, CUSTOMER_JARGON_RE);
  assert.doesNotMatch(r.body, /HTTP|404|CERT_HAS_EXPIRED|team-alt|img\/team\.jpg|375 px/);
  assert.ok(r.issue_evidence.every((e) => e.evidence), "Evidence bleibt intern");
});

test("keine erfundenen Findings: jeder Punkt geht auf einen beobachteten Rohbefund zurück", () => {
  const issues = [LINK(), IMAGE, BUTTON];
  const r = draft(issues);
  assert.equal(bullets(r.body).length, r.customer_findings.length);
  for (const f of r.customer_findings) {
    assert.ok(f.internal_refs.length >= 1);
    for (const ref of f.internal_refs) assert.ok(issues.some((i) => i.type === ref.issue_type && i.url === ref.url));
    assert.ok(bullets(r.body).some((b) => b.startsWith(`• ${f.text}.`)));
  }
});

test("CHF 150 genau einmal, CHF 480 genau einmal, FULL_CHECK_TEXT vorhanden, keine Druck-/Schadensbehauptungen", () => {
  const { body } = draft([LINK(), IMAGE, BUTTON]);
  assert.equal((body.match(/CHF 150\b/g) || []).length, 1);
  assert.equal((body.match(/CHF 480\b/g) || []).length, 1);
  assert.equal((body.match(/CHF \d+/g) || []).length, 2);
  assert.ok(body.includes(`\n\n${FULL_CHECK_TEXT}\n\n`));
  assert.ok(body.indexOf("• ") < body.indexOf(FULL_CHECK_TEXT) && body.indexOf(FULL_CHECK_TEXT) < body.indexOf("CHF 150"));
  assert.doesNotMatch(body, /Kunden verlieren|verlieren|Umsatz|Conversion|Google straft|gefährlich|sofort handeln|jeden Tag Geld|dringend/i);
});

test("Cold-Draft niemals automatisch sendbar; Lead-Datenbank erhält genau die gezeigten Findings", () => {
  const r = draft([LINK(), IMAGE, BUTTON, FORM]);
  assert.deepEqual([r.draft_mode, r.legal_basis, r.automatic_send_allowed, r.message_class, r.manual_send_decision_required], [COLD_MODE, "NONE", false, "DRAFT_ONLY", true]);
  const qq = q([LINK(), IMAGE]);
  assert.deepEqual([qq.contact_basis, qq.automatic_send_eligible, qq.automatic_marketing_send_eligible, qq.automatic_send_allowed], [COLD_MODE, false, false, false]);
  // Gespeichert werden nur Kundentext + interne Referenzen (keine Roh-Evidence) – das, was im Mailtext steht.
  assert.deepEqual(r.customer_findings.map((f) => Object.keys(f).sort()), r.customer_findings.map(() => ["internal_refs", "key", "severity", "text"]));
  assert.deepEqual(r.customer_findings.map((f) => `• ${f.text}.`), bullets(r.body).map((b) => b.slice(0, b.indexOf(".") + 1)));
  assert.equal(customerFindings, selectCustomerVisibleFindings, "bisheriger Name zeigt auf dieselbe Auswahl");
});

test("Auto-Send-Events = 0: Worker legt Gmail-Entwurf an, sendet nie; Lead mit 1 Befund bekommt gar keinen Entwurf", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-034-"));
  const store = createStore(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: SENDER }));
  fs.writeFileSync(path.join(dir, "suppression.json"), "{}");
  const g = { reg: { drafts: {}, sent: {} }, calls: [], n: 0 };
  Object.assign(g, {
    listOwned: () => structuredClone(g.reg),
    async createDraft({ to, subject, body, mode }) { g.calls.push("create " + to); const id = "dr" + ++g.n; g.reg.drafts[id] = { threadId: "t" + id, to, subject, body, mode, createdAt: T0.toISOString() }; return { draftId: id, messageId: "m" + id, threadId: "t" + id }; },
    async sendDraft(id) { g.calls.push("SEND " + id); throw new Error("nie senden"); },
    async readThread() { return { messages: [] }; }, async markDraftForReview() {}, async syncColdDrafts() { return []; },
  });
  assert.throws(() => ensureColdDraft(store, lead([LINK()], { domain: "single.ch", email: "info@single.ch", website: "https://single.ch/" }), { sender: SENDER, now: T0 }));
  assert.equal(ensureColdDraft(store, lead([LINK(), IMAGE, BUTTON]), { sender: SENDER, now: T0 }).status, "queued");
  const r = await createWorker({ dir, gmail: g, now: () => T0, log: () => {}, compose: async () => ({ decision: "draft", body: "x" }) }).tick();
  assert.deepEqual(g.calls, ["create info@muster.ch"]);
  assert.deepEqual(r.sends, []);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, COLD_DRAFTS_FILE), "utf8")).reviews;
  assert.deepEqual(Object.keys(saved), ["muster.ch"]);
  assert.equal(bullets(saved["muster.ch"].body).length, 3);
});
