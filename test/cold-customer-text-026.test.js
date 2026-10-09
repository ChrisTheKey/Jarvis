// Cold-Outreach in einfacher Kundensprache: Der Gmail-Entwurf nennt höchstens zwei für Besucher sichtbare, belegte Probleme in
// Alltagssprache. Technische Evidence bleibt intern. Kein Befund wird erfunden; Cold Leads bleiben COLD_LEAD_DRAFT_ONLY (nie gesendet).
// Ohne Netzwerk, ohne echte Mail.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { qualifyRepairLead, createColdDraft, buildColdDraft, customerFindings, ensureColdDraft, COLD_MODE, COLD_FOOTER, MAX_CUSTOMER_FINDINGS,
  CUSTOMER_JARGON_RE, CUSTOMER_PRESSURE_RE } from "../swiss-repair.js";
import { OFFERS, LANDING_PAGE_URL } from "../sales.js";
import { createStore } from "../mail-worker.js";

const T0 = new Date("2026-10-06T08:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const issue = (type, severity, evidence, url = "https://muster.ch/", extra = {}) => ({ type, url, evidence: evidence || `Beleg für ${type}`, severity, detectedAt: T0.toISOString(), ...extra });
const BROKEN_LINK = issue("broken_link", "medium", "HTTP 404 (verlinkt auf https://muster.ch/)", "https://muster.ch/angebot", { page: "https://muster.ch/", label: "Unser Angebot" });
const BROKEN_IMG = (n) => issue("broken_image", "medium", `Bild liefert HTTP 404 (eingebunden auf https://muster.ch/ueber-uns)`, `https://muster.ch/img/team-${n}.jpg`, { page: "https://muster.ch/ueber-uns" });
const OVERLAP = issue("mobile_text_overlap", "medium", "Bei 375 px Breite überlappt h2.hero-title das Bild (DOM-Overlap 48 px, 2× reproduziert)", "https://muster.ch/ueber-uns",
  { reproducible: true, location: "Über uns" });
const lead = (issues, over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: "https://muster.ch/", domain: "muster.ch", uid: "CHE-123.456.789", approved: false, consentBasis: null,
  consentAt: null, consentSource: null, existingCustomer: false, similarService: false, status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true,
  title: "Muster AG – Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)", contact_source: "impressum", source_url: "https://muster.ch/impressum",
  collected_at: T0.toISOString(), contact_confidence: "medium", websiteIssues: issues, ...over,
});
const draft = (issues, over) => createColdDraft(lead(issues, over), { sender: SENDER, now: T0 });
// Kundentext ohne die erlaubte Landingpage, Absenderblock und Firmenname.
const customerPart = (body) => body.split("\nFreundliche Grüsse")[0].replace(LANDING_PAGE_URL, "");

test("Cold Lead bleibt Entwurf: COLD_LEAD_DRAFT_ONLY, keine Versandgrundlage, nie automatisch sendbar", () => {
  const r = draft([BROKEN_LINK]);
  assert.deepEqual([r.draft_mode, r.message_class, r.automatic_send_allowed, r.legal_basis, r.manual_send_decision_required, r.legal_status],
    [COLD_MODE, "DRAFT_ONLY", false, "NONE", true, "NO_AUTOMATIC_SEND_BASIS"]);
  const q = qualifyRepairLead(lead([BROKEN_LINK]), { now: T0 });
  assert.deepEqual([q.contact_basis, q.automatic_send_eligible, q.automatic_marketing_send_eligible], [COLD_MODE, false, false]);
});

test("Cloud-Werkzeug: fehlendes delivery → nur Entwurf (nie stillschweigend Versand)", async () => {
  process.env.ANTHROPIC_API_KEY ||= "";
  const { createCloudHandler, MAIL_TOOL } = await import("../netlify/edge-functions/cloud.js");
  assert.ok(MAIL_TOOL.input_schema.required.includes("delivery"));
  const input = { recipient: "info@muster.ch", subject: "Hinweis", body: "Hallo" };
  const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
  const sse = ev({ type: "content_block_start", content_block: { type: "tool_use", name: "mail_request", id: "tu1" } }) +
    ev({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) + ev({ type: "content_block_stop" });
  const queued = [];
  const h = createCloudHandler({ env: (k) => ({ JARVIS_PASSWORD: "pw", ANTHROPIC_API_KEY: "k" })[k], loadState: async () => null, fetchFn: async () => new Response(sse),
    enqueue: async (x) => { queued.push(x); return { status: 201, request: { request_id: "mr-x-00000001", recipient: x.recipient, subject: x.subject, status: "pending", delivery: x.delivery } }; } });
  await (await h(new Request("https://jarvis.test/api/cloud", { method: "POST", headers: { "x-jarvis-key": "pw" }, body: JSON.stringify({ messages: [{ role: "user", content: "Schreib eine Mail" }] }) }))).text();
  assert.equal(queued[0].delivery, "draft");
});

test("offensichtlicher kaputter Link → einfache, prüfbare Aussage", () => {
  const { body } = draft([BROKEN_LINK]);
  assert.match(body, /aufgefallen, dass auf Ihrer Startseite der Link «Unser Angebot» auf eine Fehlerseite führt\. Besucher landen dadurch auf einer Fehlerseite statt beim gewünschten Inhalt\./);
});

test("mobiles Text-Overlap → einfache Aussage mit Bereich", () => {
  const { body } = draft([OVERLAP]);
  assert.match(body, /dass auf dem Handy im Bereich «Über uns» Text teilweise übereinander liegt\. Der Text ist dadurch schwer lesbar\./);
});

test("kaputtes Bild → einfache Aussage mit Seite", () => {
  const { body } = draft([BROKEN_IMG(1)]);
  assert.match(body, /dass auf der Seite «Ueber uns» ein Bild nicht angezeigt wird\. An dieser Stelle sehen Besucher nur eine leere Fläche\./);
});

test("kein technischer Jargon, kein Statuscode, keine Messwerte im Kundentext", () => {
  const issues = [BROKEN_LINK, OVERLAP, BROKEN_IMG(1), issue("slow_response", "medium", "Ladezeit der Startseite 7.2 s (LCP 6.1 s, CLS 0.4, Lighthouse 41)"),
    issue("mixed_content", "medium", "Unverschlüsselt eingebunden auf HTTPS-Seite: http://cdn.x/a.js"), issue("missing_title", "medium", "Kein oder leerer <title> im HTML")];
  const { subject, body } = draft(issues);
  // Preise der zwei Angebote (CHF 150/480) sind keine Statuscodes – vor der Jargon-Prüfung entfernen.
  const text = customerPart(subject + "\n" + body).replace(/CHF \d+/g, "");
  assert.doesNotMatch(text, CUSTOMER_JARGON_RE);
  assert.doesNotMatch(text, /\b404\b|HTTP|CLS|LCP|FCP|Lighthouse|DOM|px|<title>|Ladezeit|unverschlüsselt|https?:\/\//i);
  assert.ok(!text.includes("https://muster.ch/angebot"), "keine technische Ziel-URL");
});

test("Lighthouse/CLS/LCP, Performance, Titel, HTTPS-Details allein → kein Cold-Entwurf", () => {
  for (const i of [issue("slow_response", "medium", "LCP 6.1 s, CLS 0.4, Lighthouse 41"), issue("missing_title", "medium", "Kein <title>"),
    issue("no_https", "medium", "HTTPS nicht erreichbar"), issue("no_https_redirect", "medium", "keine Weiterleitung"), issue("mixed_content", "medium", "http-Script")]) {
    const q = qualifyRepairLead(lead([i]), { now: T0 });
    assert.equal(q.draft_creation_eligible, false, i.type);
    assert.equal(q.stage, "no_visible_issue", i.type);
    assert.deepEqual(q.customer_findings, []);
    assert.throws(() => draft([i]), /Nur für COLD_LEAD_DRAFT_ONLY/);
  }
});

test("subjektives „altes Design“ / schlechte UX / Conversion reicht nicht als Befund", () => {
  for (const t of ["outdated_design", "bad_ux", "low_conversion", "outdated_technology", "outdated_cms", "missing_alt", "no_mobile_viewport"]) {
    const q = qualifyRepairLead(lead([issue(t, "high", "Design wirkt alt")]), { now: T0 });
    assert.equal(q.draft_creation_eligible, false, t);
    assert.deepEqual(q.customer_findings, [], t);
  }
});

test("nicht belegbares Problem wird verworfen: sichtbarer Fehler ohne Reproduktion oder ohne Bereich, Link ohne Seite", () => {
  const unproven = [
    issue("mobile_text_overlap", "high", "vermutlich Überlappung", "https://muster.ch/", { location: "Start" }),          // nicht reproduziert
    issue("button_broken", "high", "Button reagiert nicht", "https://muster.ch/", { reproducible: true }),               // kein Bereich
    issue("contact_form_broken", "high", "Formular", "https://muster.ch/kontakt", { reproducible: false, location: "Kontakt" }),
    issue("broken_link", "medium", "HTTP 404", "https://muster.ch/x"),                                                    // Seite unbekannt
    issue("broken_link", "medium", "   ", "https://muster.ch/y", { page: "https://muster.ch/" }),                          // keine Evidence
    issue("broken_link", "medium", "HTTP 404", "https://muster.ch/z", { page: "https://muster.ch/", detectedAt: "kein Datum" }),
  ];
  assert.deepEqual(customerFindings(unproven), []);
  assert.equal(qualifyRepairLead(lead(unproven), { now: T0 }).draft_creation_eligible, false);
});

test("mehrere technische Befunde derselben sichtbaren Ursache → eine einfache Aussage", () => {
  const imgs = [BROKEN_IMG(1), BROKEN_IMG(2), BROKEN_IMG(3)];
  const f = customerFindings(imgs);
  assert.equal(f.length, 1);
  assert.equal(f[0].internal_refs.length, 3, "intern bleiben alle drei Befunde referenziert");
  const { body } = draft(imgs);
  assert.equal((body.match(/Bild nicht angezeigt/g) || []).length, 1);
  // Kontaktseite kaputt + Kontaktformular kaputt = dieselbe sichtbare Folge (Kontakt nicht möglich) → eine Aussage.
  const contact = [issue("contact_page_broken", "high", "HTTP 404 (verlinkt auf https://muster.ch/)", "https://muster.ch/kontakt", { page: "https://muster.ch/" }),
    issue("contact_form_broken", "high", "POST /kontakt → 500, 2× reproduziert", "https://muster.ch/kontakt", { reproducible: true, location: "Kontakt" })];
  assert.equal(customerFindings(contact).length, 1);
});

test("höchstens zwei Probleme pro Cold-Mail", () => {
  const many = [BROKEN_LINK, OVERLAP, BROKEN_IMG(1), issue("broken_mailto", "medium", 'Ungültige mailto-Adresse im Link: "info(at)muster.ch"', "https://muster.ch/impressum", { page: "https://muster.ch/impressum" }),
    issue("https_certificate", "high", "TLS-Fehler beim Aufruf: CERT_HAS_EXPIRED", "https://muster.ch/")];
  assert.equal(MAX_CUSTOMER_FINDINGS, 2);
  assert.equal(customerFindings(many).length, 2);
  const { body } = draft(many);
  assert.equal((body.match(/aufgefallen, dass/g) || []).length, 2);
});

test("keine erfundenen Probleme: jede Aussage geht auf einen beobachteten Befund zurück", () => {
  const issues = [BROKEN_LINK, OVERLAP];
  const r = draft(issues);
  for (const f of r.customer_findings) for (const ref of f.internal_refs) assert.ok(issues.some((i) => i.type === ref.issue_type && i.url === ref.url));
  assert.equal((r.body.match(/aufgefallen, dass/g) || []).length, r.customer_findings.length);
  assert.throws(() => buildColdDraft(lead([]), qualifyRepairLead(lead([]), { now: T0 }), SENDER), /Kein belegter Reparaturbefund/);
});

test("keine Angst-/Druck-Verkaufssprache, kein Preisverkauf, Struktur wie vorgegeben", () => {
  const { subject, body } = draft([BROKEN_LINK, OVERLAP], { contact_name: "Anna Muster" });
  assert.doesNotMatch(customerPart(subject + body), CUSTOMER_PRESSURE_RE);
  assert.doesNotMatch(body, /kaputt|verlieren|Umsatz|veraltet|unsicher|schlecht|dringend|Redesign|neue Website/i);
  assert.match(body, /^Hallo Anna Muster,\n\nich habe mir Ihre Website kurz angesehen und dabei ist mir aufgefallen, dass /);
  // Standardvorlage: erster Blick → vollständiger Webseiten-Check → genau zwei Angebote (Preise nur aus OFFERS) → kurze Antwort genügt.
  assert.match(body, /\n\nDas ist nur das, was mir beim ersten Blick direkt aufgefallen ist\. Mein Angebot umfasst einen vollständigen Webseiten-Check: /);
  assert.match(body, /\n\n«Check & Anleitung» kostet CHF 150: [^\n]*\n\n«Check & Reparatur» kostet CHF 480: /);
  assert.doesNotMatch(body, /CHF (?!(?:150|480)\b)\d/, "keine anderen Preise");
  assert.match(body, /Freundliche Grüsse\nChris Kälin/);
  assert.ok(body.includes(COLD_FOOTER), "Abmeldemöglichkeit bleibt");
  assert.ok(body.split(/\s+/).length < 240, "kurz");
  assert.equal(subject, "Kurzer Hinweis zu Ihrer Website muster.ch");
});

test("technische Evidence bleibt intern vollständig erhalten; Angebot unverändert", () => {
  const r = draft([BROKEN_LINK]);
  assert.deepEqual(r.issue_evidence, [{ issue_type: "broken_link", url: "https://muster.ch/angebot", evidence: "HTTP 404 (verlinkt auf https://muster.ch/)", observed_at: T0.toISOString(), reproducible: true, severity: "medium" }]);
  assert.ok(r.evidence_hash && r.draft_hash);
  assert.equal(r.offer_class, "REPAIR_FIX_500");
  assert.deepEqual([OFFERS.REPAIR_CHECK_150.price, OFFERS.REPAIR_FIX_500.price], [150, 480]);
  assert.ok(!r.body.includes(r.issue_evidence[0].evidence));
});

test("Bereichsname mit Fachbegriff wird nicht übernommen (fail closed)", () => {
  const f = customerFindings([issue("visible_layout_error", "high", "x", "https://muster.ch/", { reproducible: true, location: "CTA-Header DOM" })]);
  assert.deepEqual(f, []);
});

test("Suppression/Opt-out: gesperrte Adresse bekommt auch mit sichtbarem Befund keinen Entwurf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-026-"));
  const store = createStore(dir);
  const r = ensureColdDraft(store, lead([BROKEN_LINK]), { sender: SENDER, now: T0, suppression: { "info@muster.ch": { reason: "opt-out" } } });
  assert.deepEqual(r, { blocked: "suppression" });
  const saved = store.read("individual_reviews.json", { reviews: {} });
  assert.deepEqual(Object.keys(saved.reviews || {}), []);
});
