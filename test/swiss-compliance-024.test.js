// TF-024 SWISS STRICT EMAIL COMPLIANCE – zentrale Permission-Engine, integriert mit TF-025 (Cold Leads nur Entwurf).
// Ohne Netzwerk, ohne echte Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateSwissEmailPermission, MESSAGE_CLASSES, LEGAL_BASES } from "../email-permission.js";
import { legalBasis, createWorker, createStore, HARD_LIMIT, WINDOW_LIMIT, SEND_WINDOWS, mailClassOf } from "../mail-worker.js";
import { qualifyRepairLead, ensureColdDraft, coldDraftAction, COLD_DRAFTS_FILE, COLD_MODE } from "../swiss-repair.js";
import { OFFERS, OFFER_CLASSES } from "../sales.js";

const T0 = new Date("2026-10-06T08:00:00Z"); // 10:00 Zürich, Morgenfenster
const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const TO = "anna@muster.ch";
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const OPTIN = { email: TO, approved: true, consentBasis: "opt_in", consentRecipient: TO, consentAt: "2026-09-01T10:00:00Z",
  consentSource: "Kontaktformular helvetic-webdesign.ch mit Einwilligungs-Checkbox", consentScope: "Angebote zu Website-Prüfung und Website-Reparatur",
  consentEvidence: "Double-Opt-in bestätigt am 2026-09-01 (Formular-Eintrag 4711)", obtainedBeforeMarketingSend: true, withdrawalStatus: "active", consentConfidence: "HIGH" };
const CUSTOMER = { email: TO, approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true,
  customerRelationshipEvidence: "Auftrag und Rechnung 2025-118 (Website-Wartung)", relationshipDate: "2025-05-10", previousService: "Website-Wartung",
  advertisedService: "Website-Reparatur", similarityRationale: "Gleiche Website, gleiche Art Leistung", emailSource: "Kundenkorrespondenz zum Auftrag 2025-118",
  sameProvider: true, optOutStatus: "none", customerConfidence: "HIGH" };
const REQUEST = { email: TO, approved: true, consentBasis: "requested_contact", requestSource: "Kontaktformular helvetic-webdesign.ch", requestDate: "2026-10-01T09:00:00Z",
  requestScope: "Offerte für Reparatur der Kontaktseite unserer Website", requestEvidence: "Formular-Eintrag 2026-10-01: «Unser Kontaktformular geht nicht – bitte Offerte»",
  responseScope: "Offerte Website-Reparatur Kontaktseite", recipientOrSubmissionChannel: TO, requestConfidence: "HIGH" };
const RFP = { email: TO, approved: true, consentBasis: "active_rfp", rfpUrl: "https://www.simap.ch/ausschreibung/12345", rfpDate: "2026-10-01",
  rfpScope: "Reparatur und Wartung der bestehenden Gemeinde-Website", submissionChannel: "Einreichung per simap.ch", deadline: "2026-10-31T23:59:00Z",
  exactEvidence: "Ausschreibung 12345: «Gesucht: Behebung defekter Links und Formulare auf www.muster.ch»", serviceMatch: true, stillActive: true, rfpConfidence: "HIGH" };
const PUBLIC = { email: "info@muster.ch", approved: false, consentBasis: null, status: "blocked_no_legal_basis" };
const M = (lead, extra = {}) => evaluateSwissEmailPermission(lead, { type: "MARKETING", ...extra }, T0);
const S = (lead, extra = {}) => evaluateSwissEmailPermission(lead, { type: "SOLICITED_RESPONSE", scope: "Website-Reparatur", ...extra }, T0);
const shape = (r) => {
  assert.deepEqual(Object.keys(r).sort(), ["allowed", "confidence", "evidence", "legal_basis", "message_class", "rationale"]);
  assert.ok(MESSAGE_CLASSES.includes(r.message_class) && LEGAL_BASES.includes(r.legal_basis) && ["HIGH", "MEDIUM", "LOW"].includes(r.confidence));
  assert.ok(Array.isArray(r.evidence) && typeof r.rationale === "string" && r.rationale);
  return r;
};

// ---------- AUTO-SEND TRUE ----------

test("documented explicit opt-in → MARKETING erlaubt (HIGH, mit Evidence)", () => {
  const r = shape(M(OPTIN));
  assert.deepEqual([r.allowed, r.message_class, r.legal_basis, r.confidence], [true, "MARKETING", "EXPLICIT_OPT_IN", "HIGH"]);
  assert.equal(r.evidence[0].consent_source, OPTIN.consentSource);
  assert.equal(legalBasis(OPTIN, T0), "opt_in");
  // auch als Unterobjekt mit snake_case
  const nested = { email: TO, approved: true, consent: { basis: "EXPLICIT_OPT_IN", recipient: TO, source: OPTIN.consentSource, date: OPTIN.consentAt, scope: OPTIN.consentScope,
    evidence: OPTIN.consentEvidence, obtained_before_marketing_send: true, withdrawal_status: "active", confidence: "HIGH" } };
  assert.equal(M(nested).allowed, true);
});

test("existing customer similar service → MARKETING erlaubt", () => {
  const r = shape(M(CUSTOMER));
  assert.deepEqual([r.allowed, r.message_class, r.legal_basis], [true, "MARKETING", "EXISTING_CUSTOMER_SIMILAR_SERVICE"]);
  assert.equal(legalBasis(CUSTOMER, T0), "existing_customer");
});

// ---------- SOLICITED RESPONSE TRUE ----------

test("concrete repair request → SOLICITED_RESPONSE, nie MARKETING, kein Follow-up-Funnel", () => {
  const r = shape(S(REQUEST));
  assert.deepEqual([r.allowed, r.message_class, r.legal_basis], [true, "SOLICITED_RESPONSE", "REQUESTED_CONTACT"]);
  assert.equal(M(REQUEST).allowed, false, "Requested Contact ist keine Marketing-Grundlage");
  assert.equal(legalBasis(REQUEST, T0), "requested_contact");
  const q = qualifyRepairLead({ ...REQUEST, domain: "muster.ch", auditedAt: T0.toISOString(), reachable: true, websiteIssues: [] }, { now: T0 });
  assert.deepEqual([q.message_class, q.automatic_marketing_send_eligible, q.legal_basis], ["SOLICITED_RESPONSE", false, "REQUESTED_CONTACT"]);
  assert.equal(mailClassOf({ kind: "erstkontakt", messageClass: "SOLICITED_RESPONSE" }), "solicited_response");
});

test("concrete active matching RFP → SOLICITED_RESPONSE (ACTIVE_RFP_RESPONSE), keine allgemeine Marketing-Berechtigung", () => {
  const r = shape(S(RFP));
  assert.deepEqual([r.allowed, r.message_class, r.legal_basis], [true, "SOLICITED_RESPONSE", "ACTIVE_RFP_RESPONSE"]);
  assert.equal(M(RFP).allowed, false);
  assert.equal(legalBasis(RFP, T0), "active_rfp");
});

// ---------- AUTO-SEND FALSE ----------

test("öffentliche Fundstellen sind nie eine Grundlage: public email, info@, Kontaktseite, Impressum, .ch, Maps, Verzeichnis, LinkedIn, Register, Whois", () => {
  const sources = ["öffentlich gefundene Adresse auf der Website", "info@ im Impressum", "Kontaktseite der Firma", "Impressum", ".ch-Domain", "Google Maps Eintrag",
    "Branchenverzeichnis local.ch", "LinkedIn-Profil", "Handelsregister/Zefix", "Whois-Eintrag", "Firmenregister moneyhouse"];
  const leadPublic = { ...PUBLIC };
  for (const r of [M(leadPublic), S(leadPublic)]) assert.deepEqual([r.allowed, r.legal_basis, r.message_class], [false, "NONE", "BLOCKED"]);
  for (const src of sources) {
    for (const lead of [{ ...OPTIN, consentSource: src }, { ...OPTIN, consentEvidence: src }]) assert.equal(M(lead).allowed, false, src);
    assert.equal(M({ ...CUSTOMER, emailSource: src }).allowed, false, src);
    assert.equal(S({ ...REQUEST, requestSource: src, requestEvidence: src }).allowed, false, src);
  }
  assert.equal(legalBasis({ ...PUBLIC, approved: true }, T0), null);
});

test("generische Lieferanten-/Partnerseite und allgemeine Einladungen → keine Solicited Response", () => {
  for (const ev of ["Supplier proposals welcome", "Partner werden – kontaktieren Sie uns", "Offerten willkommen", "Wir freuen uns über Angebote", "Lieferantenportal"]) {
    assert.equal(S({ ...REQUEST, requestEvidence: ev }).allowed, false, ev);
    assert.equal(S({ ...RFP, exactEvidence: ev }).allowed, false, ev);
  }
});

test("personalisierte Cold-Mail, Repair-Befund allein, Chris-Freigabe/Override → nie Auto-Send", () => {
  const cold = { ...PUBLIC, company: "Muster AG", contact_name: "Anna Muster", websiteIssues: [{ type: "broken_link", url: "https://muster.ch/x", evidence: "HTTP 404", severity: "high", detectedAt: T0.toISOString() }], repair_fit_score: 99 };
  for (const extra of [{}, { approved_by_chris: true }, { force: true }, { override: true }, { admin_bypass: true }, { human_approved: true, legal_override: "EXPLICIT_OPT_IN" }]) {
    const r = M(cold, extra);
    assert.deepEqual([r.allowed, r.legal_basis], [false, "NONE"], JSON.stringify(extra));
  }
  assert.equal(legalBasis({ ...cold, approved: true, human_approved: true, legal_override: true, consentBasis: "chris_approval" }, T0), null);
  assert.equal(M({ ...OPTIN, consentSource: "Chris hat freigegeben" }).allowed, false, "Chris-Freigabe ist keine Einwilligung");
});

test("fehlende Evidence → BLOCK (jedes Pflichtfeld einzeln)", () => {
  for (const k of ["consentRecipient", "consentSource", "consentAt", "consentScope", "consentEvidence", "obtainedBeforeMarketingSend", "withdrawalStatus", "consentConfidence"])
    assert.equal(M({ ...OPTIN, [k]: undefined }).allowed, false, k);
  for (const k of ["customerRelationshipEvidence", "relationshipDate", "previousService", "advertisedService", "similarityRationale", "emailSource", "optOutStatus", "sameProvider", "existingCustomer", "similarService"])
    assert.equal(M({ ...CUSTOMER, [k]: undefined }).allowed, false, k);
  for (const k of ["requestSource", "requestDate", "requestScope", "requestEvidence", "responseScope", "recipientOrSubmissionChannel"])
    assert.equal(S({ ...REQUEST, [k]: undefined }).allowed, false, k);
  for (const k of ["rfpUrl", "rfpDate", "rfpScope", "submissionChannel", "deadline", "exactEvidence", "serviceMatch", "stillActive"])
    assert.equal(S({ ...RFP, [k]: undefined }).allowed, false, k);
  assert.equal(M({ ...OPTIN, consentRecipient: "andere@muster.ch" }).allowed, false, "Einwilligung gilt für einen anderen Empfänger");
  assert.equal(M({ ...OPTIN, obtainedBeforeMarketingSend: false }).allowed, false, "nachträglich eingeholt");
});

test("MEDIUM und LOW confidence → BLOCK", () => {
  for (const c of ["MEDIUM", "LOW", "medium", "", null]) {
    const r = M({ ...OPTIN, consentConfidence: c });
    assert.equal(r.allowed, false, String(c));
    assert.notEqual(r.confidence, "HIGH");
    assert.equal(M({ ...CUSTOMER, customerConfidence: c }).allowed, false);
    assert.equal(S({ ...REQUEST, requestConfidence: c }).allowed, false);
    assert.equal(S({ ...RFP, rfpConfidence: c }).allowed, false);
  }
});

test("widerrufene Einwilligung, Bestandskunde mit fremder Leistung/Opt-out, abgelaufene RFP, Scope-Mismatch → BLOCK", () => {
  for (const w of ["withdrawn", "revoked", "unknown"]) assert.equal(M({ ...OPTIN, withdrawalStatus: w }).allowed, false, w);
  assert.equal(M({ ...CUSTOMER, previousService: "Buchhaltung" }).allowed, false, "frühere Leistung nicht ähnlich");
  assert.equal(M({ ...CUSTOMER, advertisedService: "Social-Media-Kampagne" }).allowed, false);
  assert.equal(M({ ...CUSTOMER, sameProvider: false }).allowed, false, "Leistung eines anderen Unternehmens");
  assert.equal(M({ ...CUSTOMER, optOutStatus: "opted_out" }).allowed, false);
  assert.equal(S({ ...RFP, deadline: "2026-10-01T00:00:00Z" }).allowed, false, "abgelaufen");
  assert.equal(S({ ...RFP, stillActive: false }).allowed, false);
  assert.equal(S({ ...RFP, rfpScope: "Lieferung von Büromaterial", serviceMatch: false }).allowed, false);
  assert.equal(S({ ...REQUEST, requestScope: "Offerte für Fotografie" }).allowed, false, "Anfrage betrifft andere Leistung");
  assert.equal(S({ ...REQUEST, responseScope: "Newsletter-Abo" }).allowed, false, "Antwort ausserhalb der Anfrage");
  assert.equal(S(REQUEST, { scope: "Allgemeine Unternehmenspräsentation" }).allowed, false);
  assert.equal(M({ ...OPTIN, consentScope: "Newsletter Gartenbau" }).allowed, false);
});

test("Opt-out/Suppression schlägt jede Grundlage", () => {
  for (const lead of [OPTIN, CUSTOMER, REQUEST, RFP]) {
    for (const over of [{ status: "suppressed" }, { status: "do_not_contact" }, { do_not_contact: true }, { suppressed: true }]) {
      assert.equal(evaluateSwissEmailPermission({ ...lead, ...over }, { type: "MARKETING" }, T0).allowed, false);
      assert.equal(evaluateSwissEmailPermission({ ...lead, ...over }, { type: "SOLICITED_RESPONSE", scope: "Website" }, T0).allowed, false);
    }
  }
});

// ---------- TF-025 integriert ----------

test("TF-025: Cold Lead → DRAFT_ONLY, legal_basis NONE; Engine erlaubt keinen Versand", () => {
  const r = shape(evaluateSwissEmailPermission(PUBLIC, { type: "COLD_DRAFT" }, T0));
  assert.deepEqual([r.allowed, r.message_class, r.legal_basis], [false, "DRAFT_ONLY", "NONE"]);
  const lead = { ...PUBLIC, domain: "muster.ch", company: "Muster AG", uid: "CHE-123.456.789", discoverySource: "OpenStreetMap node/1", auditedAt: T0.toISOString(), reachable: true, title: "Muster AG",
    contact_source: "impressum", websiteIssues: [{ type: "broken_link", url: "https://muster.ch/x", evidence: "HTTP 404 (verlinkt auf https://muster.ch/)", severity: "medium", detectedAt: T0.toISOString() }] };
  const q = qualifyRepairLead(lead, { now: T0 });
  assert.deepEqual([q.draft_creation_eligible, q.automatic_marketing_send_eligible, q.message_class, q.legal_basis, q.contact_basis], [true, false, "DRAFT_ONLY", "NONE", COLD_MODE]);
  assert.match(q.permission, /COLD_LEAD_DRAFT_ONLY/);
});

test("TF-025: Cold-Entwurf entsteht, Worker sendet nie; 0 Auto-Send-Berechtigte → 0 Sends; Entwürfe zählen nicht als Send", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-024-"));
  const store = createStore(dir);
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: SENDER }));
  const g = { reg: { drafts: {}, sent: {} }, calls: [], n: 0 };
  Object.assign(g, {
    listOwned: () => structuredClone(g.reg),
    async createDraft({ to, subject, body, mode }) { g.calls.push("create " + to); const id = "dr" + ++g.n; g.reg.drafts[id] = { threadId: "t" + id, to, subject, body, mode, createdAt: T0.toISOString() }; return { draftId: id, messageId: "m" + id, threadId: "t" + id }; },
    async sendDraft(id) { g.calls.push("SEND " + id); if (g.reg.drafts[id]?.mode === COLD_MODE) throw new Error("Cold-Lead-Entwurf"); },
    async readThread() { return { messages: [] }; }, async markDraftForReview() {}, async syncColdDrafts() { return []; },
  });
  const lead = { ...PUBLIC, domain: "muster.ch", company: "Muster AG", uid: "CHE-123.456.789", auditedAt: T0.toISOString(), reachable: true, title: "Muster AG", contact_source: "impressum",
    websiteIssues: [{ type: "broken_link", url: "https://muster.ch/x", evidence: "HTTP 404 (verlinkt auf https://muster.ch/)", severity: "medium", detectedAt: T0.toISOString() }] };
  assert.equal(ensureColdDraft(store, lead, { sender: SENDER, now: T0 }).status, "queued");
  fs.writeFileSync(path.join(dir, "leads.json"), JSON.stringify([{ ...PUBLIC, approved: true }])); // öffentliche Adresse, von Chris eingetragen
  const r = await createWorker({ dir, gmail: g, now: () => T0, log: () => {}, compose: async () => ({ decision: "draft", body: "x" }) }).tick();
  assert.equal(r.window, "morning");
  assert.deepEqual(g.calls, ["create info@muster.ch"]);
  assert.deepEqual(r.sends, []);
  assert.equal(r.eligibleLeads, 0, "0 Auto-Send-Berechtigte");
  assert.equal(r.used, 0, "Cold-Entwurf belegt keine Sendekapazität");
  const d = JSON.parse(fs.readFileSync(path.join(dir, COLD_DRAFTS_FILE), "utf8")).reviews["muster.ch"];
  assert.deepEqual([d.status, d.legal_basis, d.automatic_send_allowed, d.manual_send_decision_required], ["draft_created", "NONE", false, true]);
  // Manuell markiert: Rechtsgrundlage bleibt NONE; kein Override per Payload.
  const m = coldDraftAction(store, "mark-manual-sent", { lead_id: "muster.ch", legal_basis: "EXPLICIT_OPT_IN" }, T0);
  assert.deepEqual([m.status, m.legal_basis], ["manually_sent", "NONE"]);
  for (const op of ["force-send", "approve-anyway", "legal-override", "admin-bypass", "batch-approve"]) assert.throws(() => coldDraftAction(store, op, { lead_id: "muster.ch" }, T0));
});

test("Keine Bypass-Pfade im Code: kein Force Send / Approve Anyway / Legal Override / Admin Bypass / Batch Approval", () => {
  const src = ["server.js", "public/index.html", "swiss-repair.js", "email-permission.js", "mail-worker.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  assert.doesNotMatch(src.replace(/approved_by_chris, force, override oder admin_bypass/g, ""), /force[ _-]?send|approve[ _-]?anyway|legal[ _-]?override\s*[:(]|admin[ _-]?bypass\s*[:(]|batch[ _-]?approv|approve[ _-]?all|\bsend[ _-]?all\b/i);
  // legalBasis entscheidet ausschliesslich über die Engine
  const worker = fs.readFileSync(path.join(ROOT, "mail-worker.js"), "utf8");
  const body = worker.slice(worker.indexOf("export function legalBasis"), worker.indexOf("export const MARKETING_LEGAL"));
  assert.match(body, /evaluateSwissEmailPermission/);
  assert.doesNotMatch(body, /consentAt|consentSource|existingCustomer|request_source/, "keine zweite, schwächere Prüfung");
});

// ---------- Angebote / Limits ----------

test("Angebote: genau CHF 150 und CHF 480, kein drittes, kein Redesign/Neubau", () => {
  assert.deepEqual(OFFER_CLASSES, ["REPAIR_CHECK_150", "REPAIR_FIX_500"]);
  assert.equal(OFFERS.REPAIR_CHECK_150.price, 150);
  assert.equal(OFFERS.REPAIR_FIX_500.price, 480, "interne ID REPAIR_FIX_500 bleibt, Preis CHF 480");
  for (const o of Object.values(OFFERS)) assert.doesNotMatch(`${o.label} ${o.scope}`, /redesign|neubau|neue website|2['’]?490/i);
  const src = ["sales.js", "swiss-repair.js", "email-permission.js", "public/index.html"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  assert.doesNotMatch(src, /2['’]?490|REPAIR_[A-Z]+_(?!150|500)\d+|REDESIGN_|NEUBAU_/);
});

test("Versandlimits bleiben technisches Maximum: 09:30 max 50, 14:30 max 50, 100/Tag", () => {
  assert.equal(HARD_LIMIT, 100);
  assert.equal(WINDOW_LIMIT, 50);
  assert.deepEqual(SEND_WINDOWS.map((w) => [w.start, w.limit]), [["09:30", 50], ["14:30", 50]]);
});
