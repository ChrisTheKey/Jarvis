// TF-022 Swiss Repair Outreach: nur Schweizer Firmen, brauchbare Website + belegter Reparaturbefund, nur CHF 150/500,
// Versandgrundlagen sauber getrennt, Einzelprüfung mit gebundener Freigabe – ohne Netzwerk, ohne echte Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as swiss from "../swiss-repair.js";
import { swissSignals, siteCondition, repairEvidence, classifyRepairOffer, contactBasis, qualifyRepairLead, buildIndividualDraft, createReview, approveReview,
  editReview, rejectReview, approvalValid, reviewAction, ensureReview, REVIEWS_FILE, CONTACT_BASIS } from "../swiss-repair.js";
import { OFFERS, OFFER_CLASSES, NONE, loadPipeline, computeMetrics } from "../sales.js";
import { createWorker, createStore, legalBasis, zurichDay, HARD_LIMIT, WINDOW_LIMIT, SEND_WINDOWS, IMMEDIATE_CLASSES, mailClassOf } from "../mail-worker.js";
import { DAILY_SEND_LIMIT, assertOwnedDraft } from "../gmail.js";
import { sanitizeState, findSensitiveKeys } from "../shared-state.js";
import { runDiscovery } from "../lead-finder.js";
import { createAuditor } from "../site-auditor.js";

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
  assert.equal(q.individual_review_required, false);
  const mixed = swissSignals({ domain: "grenz.ch", pages: { impressum: "<p>Grenz GmbH, 79539 Lörrach, Deutschland</p>" } });
  assert.equal(mixed.swiss_confidence, "unclear");
  assert.equal(mixed.country, null, "widersprüchliche Signale → nicht qualifizieren");
});

// ---------- Website-Zustand ----------

test("modern/maintainable site + repair issue qualifies (ohne erfundenes Website-Alter)", () => {
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.equal(q.site_condition, "modern_maintainable");
  assert.equal(q.offer.offer_class, "REPAIR_FIX_500");
  assert.equal(q.stage, "individual_review_required");
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
    assert.notEqual(q.stage, "individual_review_required");
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
    assert.notEqual(q.stage, "individual_review_required");
    assert.throws(() => buildIndividualDraft(lead({ websiteIssues: issues }), q, SENDER), /Kein belegter Reparaturbefund/);
  }
});

test("broken link evidence preserved: issue_type, url, evidence, observed_at, reproducible, severity", () => {
  const [e] = repairEvidence([BROKEN]);
  assert.deepEqual(e, { issue_type: "broken_link", url: BROKEN.url, evidence: BROKEN.evidence, observed_at: BROKEN.detectedAt, reproducible: true, severity: "medium" });
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.deepEqual(q.offer.evidence, [e]);
  const r = createReview(lead(), { sender: SENDER, now: T0 });
  assert.deepEqual(r.issue_evidence, [e]);
  assert.ok(r.body.includes(BROKEN.url) && r.body.includes("HTTP 404"));
});

test("no invented issue: Entwurf nennt nur beobachtete Befunde, keine Abwertung, kein Neubau", () => {
  const { subject, body } = buildIndividualDraft(lead(), qualifyRepairLead(lead(), { now: T0 }), SENDER);
  const urls = body.match(/https?:\/\/[^\s)]+/g) || [];
  assert.deepEqual([...new Set(urls)], [BROKEN.url, "https://muster.ch/"].filter((u) => body.includes(u)));
  assert.doesNotMatch(subject + body, /veraltet|neue website|neubau anbieten|redesign|jahre alt|outdated/i);
  assert.match(body, /nicht um einen Neubau, sondern um eine gezielte Reparatur/);
  assert.match(body, /Reparatur CHF 500/);
  assert.match(body, /Chris Kälin/, "klare Absenderidentität");
  assert.match(body, /Abmelden/, "kostenlose Ablehnungsmöglichkeit");
  assert.doesNotMatch(body, /CHF (?!150|500)\d/);
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
  assert.equal(c.price_chf, 500);
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
  assert.equal(c.contact_basis, CONTACT_BASIS.INDIVIDUAL_ONE_TO_ONE_REVIEW);
  assert.equal(legalBasis(lead({ approved: true }), T0), null, "approved ohne Grundlage genügt nicht");
  assert.equal(contactBasis(lead(), { candidate: false, now: T0 }).contact_basis, "NONE");
  assert.equal(qualifyRepairLead(lead({ email: null }), { now: T0 }).stage, "blocked_no_contact_basis");
});

test("opt_in → automatic eligible", () => {
  const q = qualifyRepairLead(lead({ approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular" }), { now: T0 });
  assert.equal(q.contact_basis, "OPT_IN");
  assert.equal(q.automatic_send_eligible, true);
  assert.equal(q.individual_review_required, false);
  assert.equal(q.stage, "repair_candidate");
});

test("existing customer similar service → eligible", () => {
  const q = qualifyRepairLead(lead({ approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true }), { now: T0 });
  assert.equal(q.contact_basis, "EXISTING_CUSTOMER_SIMILAR_SERVICE");
  assert.equal(q.automatic_send_eligible, true);
  assert.equal(legalBasis(lead({ approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: false }), T0), null);
});

test("requested contact → eligible nur innerhalb des angefragten Umfangs", () => {
  const req = { approved: true, consentBasis: "requested_contact", request_source: "Anfrage per Kontaktformular 2026-09-20", request_date: "2026-09-20T09:00:00Z" };
  assert.equal(legalBasis(lead({ ...req, request_scope: "Offerte Website-Reparatur" }), T0), "requested_contact");
  assert.equal(qualifyRepairLead(lead({ ...req, request_scope: ["website_repair"] }), { now: T0 }).contact_basis, "REQUESTED_CONTACT");
  assert.equal(legalBasis(lead({ ...req, request_scope: "Offerte Fotografie" }), T0), null, "anderer Zusammenhang");
  assert.equal(legalBasis(lead({ ...req, request_scope: "Website", request_source: "" }), T0), null, "Quelle fehlt");
  assert.equal(legalBasis(lead({ ...req, request_scope: "Website", request_date: "2027-01-01" }), T0), null, "Datum in der Zukunft");
  const out = qualifyRepairLead(lead({ ...req, request_scope: "Offerte Fotografie" }), { now: T0 });
  assert.equal(out.automatic_send_eligible, false);
  assert.equal(out.contact_basis, CONTACT_BASIS.INDIVIDUAL_ONE_TO_ONE_REVIEW);
});

test("individual new prospect → individual_review_required", () => {
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.equal(q.contact_basis, "INDIVIDUAL_ONE_TO_ONE_REVIEW");
  assert.equal(q.individual_review_required, true);
  assert.equal(q.automatic_send_eligible, false);
  assert.equal(q.stage, "individual_review_required");
  assert.ok(q.repair_fit_score > 0);
  for (const k of ["swiss_confidence", "site_maintainability", "repair_issue_confidence", "repair_issue_value", "contact_quality"]) assert.ok(k in q.components, k);
});

// ---------- Einzelprüfung / Worker ----------

test("individual_review cannot enter campaign batch: im Fenster weder Entwurf noch Versand", async () => {
  write("discovered.json", { leads: { "muster.ch": lead() } });
  putReview(createReview(lead(), { sender: SENDER, now: T0 }));
  // Selbst wenn jemand die Firma mit approved=true in die Kampagnenliste setzt: ohne Versandgrundlage blockiert.
  write("leads.json", [{ ...lead(), approved: true, consentBasis: "individual_one_to_one" }]);
  const r = await worker().tick();
  assert.equal(r.window, "morning");
  assert.deepEqual(sends(), []);
  assert.ok(!g.calls.some((c) => c.startsWith("create")));
  assert.equal(r.eligibleLeads, 0);
  assert.equal(read("leads.json")[0].status, "blocked_no_legal_basis");
});

test("individual_review requires human approval; danach genau eine Mail, ausserhalb der Kampagnenfenster, ohne Follow-up", async () => {
  clock = NIGHT;
  const r0 = createReview(lead(), { sender: SENDER, now: T0 });
  putReview(r0);
  await worker().tick();
  assert.deepEqual(g.calls.filter((c) => /^(create|SEND)/.test(c)), [], "pending_review: nichts");
  putReview(approveReview(r0, { draft_hash: r0.draft_hash, recipient: r0.recipient, now: T0 }));
  const r = await worker().tick();
  assert.equal(r.window, null);
  assert.deepEqual(r.sends.map((s) => [s.kind, s.mailClass, s.to, s.window]), [["einzelmail", "individual_approved_mail", "info@muster.ch", null]]);
  const sentMail = Object.values(g.reg.sent)[0];
  assert.equal(sentMail.body, r0.body, "exakt der freigegebene Text");
  assert.equal(read(REVIEWS_FILE).reviews["muster.ch"].status, "sent");
  assert.ok(IMMEDIATE_CLASSES.has(mailClassOf({ kind: "einzelmail" })), "nie Teil der Kampagnenfenster");
  await worker().tick();
  assert.equal(sends().length, 1, "keine zweite Mail");
  clock = new Date(+NIGHT + 10 * DAY); // Follow-up wäre längst fällig
  const later = await worker().tick();
  assert.ok(!later.plan.some((p) => String(p.kind).startsWith("follow-up")), "kein automatischer Follow-up-Funnel");
  assert.equal(sends().length, 1);
});

test("no approve-all: keine Sammelfreigabe in Modul, Server oder Dashboard", () => {
  putReview(createReview(lead(), { sender: SENDER, now: T0 }));
  for (const p of [[{ lead_id: "muster.ch" }], { lead_ids: ["muster.ch"] }, { lead_id: ["muster.ch"] }, { all: true }]) assert.throws(() => reviewAction(store, "approve", p, T0), /Sammelfreigabe|Genau eine/);
  assert.ok(!Object.keys(swiss).some((k) => /all|batch|bulk/i.test(k)), "kein Export für Sammelfreigaben");
  const src = ["server.js", "public/index.html", "swiss-repair.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  assert.doesNotMatch(src, /approve[ -_]?all|approve[ -_]?batch|send[ -_]?all|approveAll|reviews\/(bulk|batch|all)/i);
});

test("approval bound to recipient + draft + evidence", () => {
  const r = createReview(lead(), { sender: SENDER, now: T0 });
  assert.throws(() => approveReview(r, { draft_hash: "falsch", recipient: r.recipient }), /Entwurf hat sich geändert/);
  assert.throws(() => approveReview(r, { draft_hash: r.draft_hash, recipient: "andere@muster.ch" }), /Empfänger/);
  const a = approveReview(r, { draft_hash: r.draft_hash, recipient: r.recipient, now: T0 });
  assert.equal(approvalValid(a), true);
  assert.deepEqual([a.human_reviewed, a.human_approved], [true, true]);
  assert.equal(approvalValid({ ...a, recipient: "andere@muster.ch" }), false, "anderer Empfänger");
  assert.equal(approvalValid({ ...a, body: a.body + " PS" }), false, "anderer Text");
  assert.equal(approvalValid({ ...a, issue_evidence: [{ ...a.issue_evidence[0], url: "https://muster.ch/anders" }] }), false, "anderer Befund");
  assert.equal(approvalValid({ ...a, lead_id: "fremd.ch" }), false, "anderer Lead");
  assert.equal(approvalValid({ ...r, human_reviewed: true, human_approved: true }), false, "ohne Freigabe-Bindung nie gültig");
});

test("changed draft invalidates approval – auch zwischen Vorbereitung und Versand", async () => {
  const r = createReview(lead(), { sender: SENDER, now: T0 });
  const a = approveReview(r, { draft_hash: r.draft_hash, recipient: r.recipient, now: T0 });
  const e = editReview(a, { body: a.body.replace("Guten Tag", "Grüezi") });
  assert.deepEqual([e.status, e.human_approved, e.approval], ["pending_review", false, null]);
  assert.equal(editReview(a, { recipient: "chef@muster.ch" }).approval, null, "Empfängerwechsel hebt Freigabe auf");
  assert.equal(editReview(a, {}).status, "approved", "ohne Änderung bleibt die Freigabe");
  assert.equal(rejectReview(a).status, "rejected");
  // Worker: Entwurf vorbereitet (drafts-Modus), dann ändert Chris den Text → Versand wird blockiert.
  clock = NIGHT;
  write("config.json", { dryRun: false, sendMode: "drafts", offer: "x", sender: SENDER });
  putReview(a);
  await worker().tick();
  assert.equal(g.calls.filter((c) => c.startsWith("create")).length, 1);
  assert.deepEqual(sends(), []);
  reviewAction(store, "edit", { lead_id: "muster.ch", body: a.body + "\nPS" }, T0);
  write("config.json", { dryRun: false, sendMode: "compliant_auto", offer: "x", sender: SENDER });
  await worker().tick();
  assert.deepEqual(sends(), []);
  assert.equal(read("state.json").actions["individual:muster.ch"].status, "approval_invalid");
});

test("opt-out und suppression blockieren – auch eine freigegebene Einzelmail", async () => {
  clock = NIGHT;
  const r = createReview(lead(), { sender: SENDER, now: T0 });
  putReview(approveReview(r, { draft_hash: r.draft_hash, recipient: r.recipient, now: T0 }));
  write("suppression.json", { "info@muster.ch": { reason: "opt-out", at: T0.toISOString() } });
  await worker().tick();
  assert.deepEqual(g.calls.filter((c) => /^(create|SEND)/.test(c)), []);
  write("discovered.json", { leads: { "muster.ch": lead() } });
  const { leads } = loadPipeline({ dir, now: T0 });
  assert.equal(leads[0].repair.stage, "do_not_contact");
  assert.equal(leads[0].suppressed, true);
  assert.equal(leads[0].optedOut, true);
});

test("suppression blocks: gesperrte Domain/Adresse wird nie Einzelprüfung", () => {
  write("discovered.json", { leads: { "muster.ch": lead({ status: "suppressed" }) } });
  const { leads } = loadPipeline({ dir, now: T0 });
  assert.equal(leads[0].repair.stage, "do_not_contact");
  assert.equal(computeMetrics(leads, T0).individual_review_required, 0);
});

test("automatic campaign remains 50 + 50 / 100", () => {
  assert.equal(HARD_LIMIT, 100);
  assert.equal(DAILY_SEND_LIMIT, 100);
  assert.equal(WINDOW_LIMIT, 50);
  assert.deepEqual(SEND_WINDOWS.map((w) => [w.id, w.start, w.limit]), [["morning", "09:30", 50], ["afternoon", "14:30", 50]]);
});

test("zero eligible leads → zero sends (keine künstliche Auffüllung)", async () => {
  write("discovered.json", { leads: Object.fromEntries(["a.ch", "b.ch", "c.ch"].map((d) => [d, lead({ domain: d, email: `info@${d}` })])) });
  for (const d of ["a.ch", "b.ch", "c.ch"]) ensureReview(store, lead({ domain: d, email: `info@${d}` }), { sender: SENDER, now: T0 });
  const r = await worker().tick();
  assert.equal(r.window, "morning");
  assert.deepEqual(r.sends, []);
  assert.deepEqual(sends(), []);
  const m = computeMetrics(loadPipeline({ dir, now: T0 }).leads, T0);
  assert.equal(m.auto_send_eligible, 0);
  assert.equal(m.individual_review_required, 3);
});

test("Dashboard-Kennzahlen: Swiss-Repair-Zähler, nur Zahlen im gemeinsamen Zustand (Secrets-Schutz)", () => {
  write("discovered.json", { leads: {
    "muster.ch": lead(),
    "opt.ch": lead({ domain: "opt.ch", email: "info@opt.ch", approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Formular" }),
    "check.ch": lead({ domain: "check.ch", email: "info@check.ch", websiteIssues: [issue("slow_response", "medium")] }),
    "alt.ch": lead({ domain: "alt.ch", email: "info@alt.ch", websiteIssues: [BROKEN, issue("outdated_technology", "high")] }),
    "muster.de": lead({ domain: "muster.de", uid: null, discoverySource: "", email: "info@muster.de" }),
  } });
  const m = computeMetrics(loadPipeline({ dir, now: T0 }).leads, T0);
  assert.deepEqual([m.swiss_verified, m.modern_repair_fit, m.repair_candidates, m.repair_150_candidates, m.repair_500_candidates, m.auto_send_eligible, m.individual_review_required],
    [4, 3, 3, 1, 2, 1, 2]);
  const shared = sanitizeState({ sales: { ...m, email: "info@muster.ch", swiss_evidence: ["x"] } });
  assert.equal(shared.sales.individual_review_required, 2);
  assert.ok(!JSON.stringify(shared).includes("muster"));
  assert.deepEqual(findSensitiveKeys(shared), []);
  execFileSync("git", ["check-ignore", "-q", ".secrets/mail_worker/" + REVIEWS_FILE], { cwd: ROOT });
});

test("foreign Gmail protection unchanged", async () => {
  await assert.rejects(assertOwnedDraft("fremder-entwurf", { drafts: {}, sent: {} }), /nicht von Jarvis erstellt/);
  for (const f of ["swiss-repair.js", "sales.js", "server.js"]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), /sendDraft|createDraft|updateDraft|replyToThread/, f);
});

test("Discovery: Schweizer Firma mit kaputtem Link → Felder dokumentiert, genau ein Einzelentwurf, nichts gesendet", async () => {
  const host = "muster.ch", web = {
    [`https://${host}/`]: `<!doctype html><html lang="de"><head><title>Muster Schreinerei AG</title><meta name="description" content="x"><meta name="viewport" content="width=device-width"></head><body><a href="/kontakt">Kontakt</a> <a href="/impressum">Impressum</a> <a href="/team">Team</a><footer>© 2026</footer></body></html>`,
    [`https://${host}/kontakt`]: "<html><body>Kontakt</body></html>",
    [`https://${host}/impressum`]: "<html><body><p>Muster Schreinerei AG<br>Hauptstrasse 1, CH-8400 Winterthur<br>Tel. 052 123 45 67<br><a href=\"mailto:info@muster.ch\">info@muster.ch</a><br>UID: CHE-123.456.789</p></body></html>",
    [`https://${host}/robots.txt`]: "",
  };
  const fetchFn = async (url) => {
    const u = new URL(url), key = `${u.protocol}//${u.host}${u.pathname}`;
    if (u.protocol === "http:") return new Response("", { status: 301, headers: { location: `https://${host}/` } });
    return key in web ? new Response(web[key], { status: 200, headers: { "content-type": "text/html" } }) : new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
  };
  const r = await runDiscovery({ dir, gmail: g, search: async () => [{ company: "Muster Schreinerei AG", website: `https://${host}`, email: "", chain: false, source: "OpenStreetMap node/1 (Winterthur, craft)" }],
    auditor: createAuditor({ fetchFn, delayMs: 0, now: () => T0 }), now: () => T0, log: () => {}, force: true });
  const l = r.found[0];
  assert.equal(l.country, "CH");
  assert.ok(l.swiss_evidence.some((e) => e.signal === "swiss_uid") && l.swiss_evidence.some((e) => e.signal === "swiss_address"));
  assert.equal(l.site_condition, "modern_maintainable");
  assert.equal(l.repair_stage, "individual_review_required");
  assert.equal(l.contact_basis, "INDIVIDUAL_ONE_TO_ONE_REVIEW");
  assert.deepEqual([l.contact_source, l.source_url, l.collected_at], ["impressum", "https://muster.ch/impressum", T0.toISOString()]);
  assert.deepEqual([l.approved, l.consentBasis], [false, null], "keine Fake-Einwilligung");
  const rv = read(REVIEWS_FILE).reviews[host];
  assert.equal(rv.status, "pending_review");
  assert.equal(rv.offer_class, "REPAIR_FIX_500");
  assert.ok(rv.body.includes("https://muster.ch/team"));
  assert.deepEqual(g.calls, [], "Discovery fasst Gmail nie an");
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
