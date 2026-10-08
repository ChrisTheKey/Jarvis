// TF-022 Swiss Repair Outreach: nur Schweizer Firmen, brauchbare Website + belegter Reparaturbefund, nur CHF 150/500,
// Versandgrundlagen sauber getrennt, Einzelprüfung mit gebundener Freigabe – ohne Netzwerk, ohne echte Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as swiss from "../swiss-repair.js";
// TF-025: der TF-022-Pfad „Einzelfreigabe → Jarvis sendet“ wurde durch COLD_LEAD_DRAFT_ONLY ersetzt (Tests in swiss-repair-025.test.js).
import { swissSignals, siteCondition, repairEvidence, classifyRepairOffer, contactBasis, qualifyRepairLead, buildColdDraft, createColdDraft, CONTACT_BASIS } from "../swiss-repair.js";
import { OFFERS, OFFER_CLASSES, NONE, loadPipeline, computeMetrics, LANDING_PAGE_URL } from "../sales.js";
import { createWorker, createStore, legalBasis, zurichDay, HARD_LIMIT, WINDOW_LIMIT, SEND_WINDOWS, IMMEDIATE_CLASSES, mailClassOf } from "../mail-worker.js";
import { DAILY_SEND_LIMIT, assertOwnedDraft } from "../gmail.js";
import { sanitizeState, findSensitiveKeys } from "../shared-state.js";
import { runDiscovery } from "../lead-finder.js";
import { createAuditor } from "../site-auditor.js";
// TF-024: vollständig belegte Grundlagen (Empfänger, Quelle, Datum, Umfang, Beleg, vorher eingeholt, aktiv, Vertrauen HIGH).
const OPTIN = { approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular helvetic-webdesign.ch mit Einwilligungs-Checkbox",
  consentScope: "Hinweise und Angebote zu Website-Prüfung und Website-Reparatur von Helvetic Webdesign", consentEvidence: "Double-Opt-in bestätigt am 2026-09-01 (Formular-Eintrag 4711)",
  obtainedBeforeMarketingSend: true, withdrawalStatus: "active", consentConfidence: "HIGH" };
const optIn = (email) => ({ ...OPTIN, consentRecipient: email });
const CUSTOMER = { approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true,
  customerRelationshipEvidence: "Auftrag und Rechnung 2025-118 (Website-Wartung)", relationshipDate: "2025-05-10", previousService: "Website-Wartung",
  advertisedService: "Website-Reparatur", similarityRationale: "Gleiche Website, gleiche Art Leistung (Pflege/Reparatur)", emailSource: "Kundenkorrespondenz zum Auftrag 2025-118",
  sameProvider: true, optOutStatus: "none", customerConfidence: "HIGH" };

const T0 = new Date("2026-10-06T08:00:00Z"); // 10:00 Zürich – im Morgenfenster
const NIGHT = new Date("2026-10-06T20:00:00Z"); // 22:00 Zürich – ausserhalb aller Kampagnenfenster
const DAY = 86_400_000;
const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const issue = (type, severity, evidence = `Beleg für ${type}`, url = "https://muster.ch/") => ({ type, url, evidence, severity, detectedAt: T0.toISOString() });
const BROKEN = issue("broken_link", "medium", "HTTP 404 (verlinkt auf https://muster.ch/)", "https://muster.ch/team");
const lead = (over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: "https://muster.ch/", domain: "muster.ch", uid: "CHE-123.456.789", approved: false, consentBasis: null,
  consentAt: null, consentSource: null, existingCustomer: false, similarService: false, status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true,
  title: "Muster AG – Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)", emailSource: "impressum", contact_source: "impressum",
  source_url: "https://muster.ch/impressum", collected_at: T0.toISOString(), websiteIssues: [BROKEN], ...over,
});

let dir, store, g, clock;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-022-"));
  store = createStore(dir);
  g = fakeGmail();
  clock = T0;
  write("config.json", { dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: SENDER });
});
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const read = (name, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fb; } };

function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, threads: {}, calls: [], n: 0 };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async readThread(id) { f.calls.push("read " + id); return { threadId: id, messages: structuredClone(f.threads[id] || []) }; },
    async replyToThread(id, { body }) { f.calls.push("reply " + id); const d = "dr" + ++f.n; f.reg.drafts[d] = { threadId: id, to: Object.values(f.reg.sent).find((s) => s.threadId === id)?.to, body, createdAt: clock.toISOString() }; return { draftId: d, threadId: id }; },
    async createDraft({ to, subject, body }) { f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "new" + id, to, subject, body, createdAt: clock.toISOString() }; return { draftId: id, threadId: "new" + id }; },
    async updateDraft() { throw new Error("unerwartet"); },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft(id, { window = null } = {}) {
      f.calls.push("SEND " + id);
      const d = f.reg.drafts[id];
      if (!d) throw new Error("nicht von Jarvis erstellt");
      if (Object.values(f.reg.sent).filter((s) => zurichDay(new Date(s.sentAt)) === zurichDay(clock)).length >= 100) throw new Error("Tageslimit");
      delete f.reg.drafts[id];
      f.reg.sent["s" + id] = { messageId: "s" + id, threadId: d.threadId, to: d.to, subject: d.subject, body: d.body, fromDraft: id, window, sentAt: clock.toISOString() };
      f.threads[d.threadId] = [{ messageId: "s" + id, from: SENDER.email, to: d.to, subject: d.subject, body: d.body, sent: true, draft: false, internalDate: +clock }];
    },
  });
  return f;
}
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", subject: "Ihre Website", body: "Guten Tag" }) });
const sends = () => g.calls.filter((c) => c.startsWith("SEND"));
const putReview = (r) => write(REVIEWS_FILE, { reviews: { [r.lead_id]: r } });

// ---------- Schweiz-only ----------

test("Swiss company qualifies: belastbare Schweiz-Signale werden dokumentiert", () => {
  const s = swissSignals({ domain: "muster.ch", uid: "CHE-123.456.789", pages: { impressum: "<p>Muster AG<br>Hauptstrasse 1, CH-8400 Winterthur<br>Tel. +41 52 123 45 67</p>" } });
  assert.equal(s.country, "CH");
  assert.equal(s.swiss_confidence, "high");
  assert.deepEqual(s.swiss_evidence.map((e) => e.signal).sort(), ["ch_domain", "swiss_address", "swiss_phone", "swiss_uid"]);
  for (const e of s.swiss_evidence) assert.ok(e.value && e.source, "jedes Signal mit Wert und Quelle");
  assert.equal(swissSignals({ domain: "beispiel.ch" }).country, "CH", ".ch-Domain ist ein zulässiges Signal");
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.equal(q.country, "CH");
  assert.ok(q.swiss_evidence.length >= 1);
});

test("non-Swiss company excluded; unklares Land qualifiziert nicht", () => {
  const de = swissSignals({ domain: "muster.de", pages: { impressum: "<p>Muster GmbH, 80331 München, Deutschland, Tel. +49 89 1234567, HRB 12345 Amtsgericht München</p>" } });
  assert.equal(de.country, null);
  const q = qualifyRepairLead(lead({ domain: "muster.de", website: "https://muster.de/", uid: null, discoverySource: "", email: "info@muster.de" }), { now: T0 });
  assert.equal(q.country, null);
  assert.equal(q.offer.offer_class, NONE);
  assert.equal(q.stage, "audited");
  assert.equal(q.draft_creation_eligible, false);
  const mixed = swissSignals({ domain: "grenz.ch", pages: { impressum: "<p>Grenz GmbH, 79539 Lörrach, Deutschland</p>" } });
  assert.equal(mixed.swiss_confidence, "unclear");
  assert.equal(mixed.country, null, "widersprüchliche Signale → nicht qualifizieren");
});

// ---------- Website-Zustand ----------

test("modern/maintainable site + repair issue qualifies (ohne erfundenes Website-Alter)", () => {
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.equal(q.site_condition, "modern_maintainable");
  assert.equal(q.offer.offer_class, "REPAIR_FIX_500");
  assert.equal(q.stage, "cold_lead_draft_only");
  assert.doesNotMatch(JSON.stringify(q), /jahre alt|years old|kürzlich erstellt|recently (built|created)/i);
  const rep = qualifyRepairLead(lead({ websiteIssues: [BROKEN, issue("outdated_library", "low")] }), { now: T0 });
  assert.equal(rep.site_condition, "repairable");
  assert.notEqual(rep.offer.offer_class, NONE);
});

test("redesign_likely und unclear werden ausgeschlossen", () => {
  for (const extra of [[issue("outdated_technology", "high")], [issue("no_mobile_viewport", "medium"), issue("outdated_cms", "medium")],
    [issue("outdated_cms", "medium"), issue("outdated_library", "low"), issue("outdated_content", "low")]]) {
    const q = qualifyRepairLead(lead({ websiteIssues: [BROKEN, ...extra] }), { now: T0 });
    assert.equal(q.site_condition, "redesign_likely", extra.map((e) => e.type).join("+"));
    assert.equal(q.offer.offer_class, NONE);
    assert.notEqual(q.stage, "cold_lead_draft_only");
  }
  for (const over of [{ websiteIssues: [BROKEN, issue("no_mobile_viewport", "medium")] }, { title: "Coming soon" }, { reachable: false }, { auditedAt: null }]) {
    const q = qualifyRepairLead(lead(over), { now: T0 });
    assert.equal(q.site_condition, "unclear");
    assert.equal(q.offer.offer_class, NONE);
  }
  assert.ok(swiss.SITE_CONDITIONS.includes("redesign_likely"));
});

// ---------- Evidence ----------

test("no evidence → no repair candidate; kosmetische Hinweise sind kein Reparaturbefund", () => {
  for (const issues of [[], [issue("missing_alt", "low"), issue("missing_meta_description", "low"), issue("missing_lang", "low")],
    [{ type: "broken_link", url: "https://muster.ch/x", severity: "medium", detectedAt: T0.toISOString() }]]) {
    const q = qualifyRepairLead(lead({ websiteIssues: issues }), { now: T0 });
    assert.equal(q.offer.offer_class, NONE);
    assert.deepEqual(q.repair_evidence, []);
    assert.notEqual(q.stage, "cold_lead_draft_only");
    assert.throws(() => buildColdDraft(lead({ websiteIssues: issues }), q, SENDER), /Kein belegter Reparaturbefund/);
  }
});

test("broken link evidence preserved: issue_type, url, evidence, observed_at, reproducible, severity", () => {
  const [e] = repairEvidence([BROKEN]);
  assert.deepEqual(e, { issue_type: "broken_link", url: BROKEN.url, evidence: BROKEN.evidence, observed_at: BROKEN.detectedAt, reproducible: true, severity: "medium" });
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.deepEqual(q.offer.evidence, [e]);
  const r = createColdDraft(lead(), { sender: SENDER, now: T0 });
  assert.deepEqual(r.issue_evidence, [e], "technische Evidence bleibt intern vollständig erhalten");
  // Nach aussen nur die einfache Aussage – keine Ziel-URL, kein Statuscode.
  assert.ok(!r.body.includes(BROKEN.url) && !r.body.includes("HTTP 404"));
  assert.match(r.body, /auf Ihrer Startseite der Link zur Seite «Team» auf eine Fehlerseite führt/);
});

test("no invented issue: Entwurf nennt nur beobachtete Befunde, keine Abwertung, kein Neubau", () => {
  const { subject, body } = buildColdDraft(lead(), qualifyRepairLead(lead(), { now: T0 }), SENDER);
  const urls = body.match(/https?:\/\/[^\s)]+/g) || [];
  // Nur die Landingpage von Chris – keine technischen URLs im Kundentext.
  assert.deepEqual([...new Set(urls)], [LANDING_PAGE_URL]);
  assert.doesNotMatch(subject + body, /veraltet|neue website|neubau anbieten|redesign|jahre alt|outdated/i);
  assert.match(body, /Ich behebe solche kleineren Website-Probleme für Schweizer Unternehmen\./);
  assert.doesNotMatch(body, /CHF/, "der Entwurf verkauft nicht über den Preis");
  assert.ok(body.includes(LANDING_PAGE_URL), "Landingpage verlinkt");
  assert.match(body, /Chris Kälin/, "klare Absenderidentität");
  assert.match(body, /nicht relevant sind, genügt eine kurze Antwort/, "einfache Ablehnungsmöglichkeit");
  assert.doesNotMatch(body, /CHF (?!150|480)\d/);
});

// ---------- Angebote ----------

test("REPAIR_CHECK_150: nur Analyse/Dokumentation", () => {
  const c = classifyRepairOffer(lead({ websiteIssues: [issue("slow_response", "medium", "Ladezeit der Startseite 7.2 s")] }));
  assert.equal(c.offer_class, "REPAIR_CHECK_150");
  assert.equal(c.price_chf, 150);
  for (const k of ["offer_class", "confidence", "evidence", "rationale", "recommended_next_step"]) assert.ok(k in c, k);
});

test("REPAIR_FIX_500: konkrete Reparatur auf weiterverwendbarer Website", () => {
  const c = classifyRepairOffer(lead({ websiteIssues: [BROKEN, issue("contact_page_broken", "high", "HTTP 404", "https://muster.ch/kontakt")] }));
  assert.equal(c.offer_class, "REPAIR_FIX_500");
  assert.equal(c.price_chf, 480);
  assert.equal(c.confidence, "high");
  assert.equal(classifyRepairOffer(lead({ websiteIssues: [issue("broken_mailto", "medium", 'Ungültige mailto-Adresse im Link: "info(at)muster.ch"')] })).offer_class, "REPAIR_FIX_500");
});

test("only two offers: keine dritte Angebotsstufe, kein Redesign/Neubau-Preis", () => {
  assert.deepEqual(OFFER_CLASSES, ["REPAIR_CHECK_150", "REPAIR_FIX_500"]);
  const seen = new Set();
  const all = ["broken_link", "contact_page_broken", "broken_image", "broken_mailto", "https_certificate", "redirect_loop", "missing_title", "no_https", "mixed_content",
    "slow_response", "no_https_redirect", "outdated_technology", "outdated_cms", "no_mobile_viewport", "missing_alt", "unreachable", "http_error"];
  for (const t of all) for (const sev of ["low", "medium", "high"]) seen.add(classifyRepairOffer(lead({ websiteIssues: [issue(t, sev)] })).offer_class);
  for (const c of seen) assert.ok([...OFFER_CLASSES, NONE].includes(c), c);
  const src = fs.readFileSync(path.join(ROOT, "swiss-repair.js"), "utf8");
  assert.doesNotMatch(src, /2['’]?490|REPAIR_[A-Z]+_(?!150|500)\d+/);
});

// ---------- Versandgrundlagen ----------

test("public email alone != automatic send eligibility", () => {
  const c = contactBasis(lead(), { candidate: true, now: T0 });
  assert.equal(c.public_email_only, true);
  assert.equal(c.automatic_send_eligible, false);
  assert.equal(c.contact_basis, CONTACT_BASIS.COLD_LEAD_DRAFT_ONLY);
  assert.equal(legalBasis(lead({ approved: true }), T0), null, "approved ohne Grundlage genügt nicht");
  assert.equal(contactBasis(lead(), { candidate: false, now: T0 }).contact_basis, "NONE");
  assert.equal(qualifyRepairLead(lead({ email: null }), { now: T0 }).stage, "blocked_no_contact_basis");
});

test("opt_in → automatic eligible", () => {
  const q = qualifyRepairLead(lead({ ...optIn("info@muster.ch") }), { now: T0 });
  assert.equal(q.contact_basis, "EXPLICIT_OPT_IN");
  assert.equal(q.automatic_marketing_send_eligible, true);
  assert.equal(q.message_class, "MARKETING");
  assert.equal(q.automatic_send_eligible, true);
  assert.equal(q.draft_creation_eligible, false);
  assert.equal(q.stage, "repair_candidate");
});

test("existing customer similar service → eligible", () => {
  const q = qualifyRepairLead(lead({ ...CUSTOMER }), { now: T0 });
  assert.equal(q.contact_basis, "EXISTING_CUSTOMER_SIMILAR_SERVICE");
  assert.equal(q.automatic_send_eligible, true);
  assert.equal(legalBasis(lead({ approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: false }), T0), null);
});

test("requested contact → eligible nur innerhalb des angefragten Umfangs", () => {
  // TF-024: angefragter Kontakt ist SOLICITED_RESPONSE (keine Marketing-Grundlage) und braucht vollständige Belege.
  const req = { approved: true, consentBasis: "requested_contact", request_source: "Anfrage per Kontaktformular 2026-09-20", request_date: "2026-09-20T09:00:00Z",
    request_evidence: "Formular-Eintrag 2026-09-20: «Bitte Offerte für Reparatur unserer Website»", response_scope: "Offerte Website-Reparatur",
    recipient_or_submission_channel: "info@muster.ch", requestConfidence: "HIGH" };
  assert.equal(legalBasis(lead({ ...req, request_scope: "Offerte Website-Reparatur" }), T0), "requested_contact");
  const sq = qualifyRepairLead(lead({ ...req, request_scope: ["website_repair"] }), { now: T0 });
  assert.deepEqual([sq.contact_basis, sq.message_class, sq.automatic_marketing_send_eligible], ["REQUESTED_CONTACT", "SOLICITED_RESPONSE", false]);
  assert.equal(legalBasis(lead({ ...req, request_scope: "Offerte Fotografie" }), T0), null, "anderer Zusammenhang");
  assert.equal(legalBasis(lead({ ...req, request_scope: "Website", request_source: "" }), T0), null, "Quelle fehlt");
  assert.equal(legalBasis(lead({ ...req, request_scope: "Website", request_date: "2027-01-01" }), T0), null, "Datum in der Zukunft");
  const out = qualifyRepairLead(lead({ ...req, request_scope: "Offerte Fotografie" }), { now: T0 });
  assert.equal(out.automatic_send_eligible, false);
  assert.equal(out.contact_basis, CONTACT_BASIS.COLD_LEAD_DRAFT_ONLY);
});

test("foreign Gmail protection unchanged", async () => {
  await assert.rejects(assertOwnedDraft("fremder-entwurf", { drafts: {}, sent: {} }), /nicht von Jarvis erstellt/);
  for (const f of ["swiss-repair.js", "sales.js", "server.js"]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /sendDraft|createDraft|updateDraft|replyToThread/, f);
});

test("Auditor: fehlerhafter mailto-Link wird passiv belegt", async () => {
  const fetchFn = async (url) => new URL(url).protocol === "http:" ? new Response("", { status: 301, headers: { location: "https://x.ch/" } })
    : new Response(new URL(url).pathname === "/" ? '<html lang="de"><head><title>X</title><meta name="viewport" content="w"></head><body><a href="mailto:info(at)x.ch">Mail</a><a href="mailto:ok@x.ch">ok</a></body></html>' : "", { status: 200, headers: { "content-type": "text/html" } });
  const a = await createAuditor({ fetchFn, delayMs: 0, now: () => T0 }).audit("https://x.ch");
  const m = a.issues.filter((i) => i.type === "broken_mailto");
  assert.equal(m.length, 1);
  assert.match(m[0].evidence, /info\(at\)x\.ch/);
  assert.doesNotMatch(m[0].evidence, /ok@x\.ch/);
});
