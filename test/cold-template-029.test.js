// STANDARDVORLAGE COLD-OUTREACH (029): belegter Befund = „erster Blick“, Angebot = VOLLSTÄNDIGER Webseiten-Check,
// genau zwei Angebote (CHF 150 Check & Anleitung, CHF 480 Check & Reparatur). Keine Mail, keine Netzwerkzugriffe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildColdDraft, createColdDraft, qualifyRepairLead, ensureColdDraft, customerFindings, FULL_CHECK_TEXT, offer150Text, offer480Text, COLD_FOOTER, COLD_MODE, MAX_CUSTOMER_FINDINGS, CUSTOMER_JARGON_RE } from "../swiss-repair.js";
import { OFFERS, OFFER_CLASSES, LANDING_PAGE_URL } from "../sales.js";
import { createStore } from "../mail-worker.js";

const T0 = new Date("2026-10-09T08:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const issue = (type, severity, url, page, extra = {}) => ({ type, url, page, evidence: `HTTP 404 (verlinkt auf ${page})`, severity, detectedAt: T0.toISOString(), ...extra });
const BROKEN = issue("broken_link", "medium", "https://muster.ch/team-alt", "https://muster.ch/", { label: "Unser Team" });
const IMAGE = issue("broken_image", "medium", "https://muster.ch/img/x.jpg", "https://muster.ch/angebot/");
const MAILTO = issue("broken_mailto", "medium", "mailto:kontakt@", "https://muster.ch/kontakt/");
const lead = (over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: "https://muster.ch/", domain: "muster.ch", uid: "CHE-123.456.789", approved: false, consentBasis: null,
  status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true, title: "Muster AG – Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)",
  contact_source: "impressum", source_url: "https://muster.ch/impressum", collected_at: T0.toISOString(), contact_confidence: "medium", websiteIssues: [BROKEN], ...over,
});
const draft = (issues, over = {}) => buildColdDraft(lead({ websiteIssues: issues, ...over }), qualifyRepairLead(lead({ websiteIssues: issues, ...over }), { now: T0 }), SENDER);
const customerPart = (body) => body.split("\nFreundliche Grüsse")[0].replace(LANDING_PAGE_URL, "");

test("Neue Standardvorlage: erster konkreter Fehler → vollständiger Webseiten-Check → CHF 150 / CHF 480 → kurze Antwort → Signatur → Abmeldesatz", () => {
  const { subject, body } = draft([BROKEN], { contact_name: "Anna Muster" });
  const lines = body.split("\n");
  assert.equal(lines[0], "Hallo Anna Muster,");
  assert.match(lines[2], /^ich habe mir Ihre Website kurz angesehen und dabei ist mir aufgefallen, dass auf Ihrer Startseite der Link «Unser Team» auf eine Fehlerseite führt\. /, "erster konkreter Fehler bleibt der Einstieg");
  const i = lines.indexOf(FULL_CHECK_TEXT);
  assert.ok(i > 2, "vollständiger Webseiten-Check direkt nach dem Befund");
  assert.equal(lines[i + 2], offer150Text());
  assert.equal(lines[i + 4], offer480Text());
  assert.equal(lines[i + 6], `Wenn das für Sie interessant ist, genügt eine kurze Antwort. Details: ${LANDING_PAGE_URL}`);
  assert.equal(lines[i + 8], "Freundliche Grüsse");
  assert.match(lines[i + 9], /Chris Kälin/);
  assert.equal(lines.at(-1), COLD_FOOTER);
  assert.equal(subject, "Kurzer Hinweis zu Ihrer Website muster.ch");
});

test("Vollständiger Webseiten-Check wird genannt: gesamte Website, sichtbare Fehler, defekte Links, Smartphone, Desktop, verständliche Zusammenfassung", () => {
  const { body } = draft([BROKEN]);
  assert.match(body, /vollständigen Webseiten-Check/);
  for (const re of [/gesamte Website/, /sichtbare Fehler/, /defekte Links/, /Smartphone/, /Desktop/, /verständlich/]) assert.match(body, re, String(re));
  // Der Check ist der eigentliche Nutzen – er steht vor den Preisen und vor dem Link.
  assert.ok(body.indexOf("vollständigen Webseiten-Check") < body.indexOf("CHF 150") && body.indexOf("CHF 150") < body.indexOf("CHF 480") && body.indexOf("CHF 480") < body.indexOf(LANDING_PAGE_URL));
});

test("CHF 150 = Check + Anleitung, CHF 480 = Check + Reparatur + erneuter Test; Preise nur aus OFFERS, nichts erfunden", () => {
  const { body } = draft([BROKEN]);
  assert.match(body, /«Check & Anleitung» kostet CHF 150: vollständiger Webseiten-Check plus verständliche Schritt-für-Schritt-Anleitung\./);
  assert.match(body, /«Check & Reparatur» kostet CHF 480: vollständiger Webseiten-Check, Reparatur der im Rahmen des Angebots behebbaren gefundenen Fehler und anschliessender Test auf Smartphone und Desktop\./);
  assert.equal(OFFERS.REPAIR_CHECK_150.price, 150); assert.equal(OFFERS.REPAIR_FIX_500.price, 480);
  assert.deepEqual(OFFER_CLASSES, ["REPAIR_CHECK_150", "REPAIR_FIX_500"], "genau zwei Angebote");
  assert.equal((body.match(/CHF \d+/g) || []).length, 2, "genau zwei Preisnennungen");
  assert.doesNotMatch(body, /CHF (?!(?:150|480)\b)\d|2['’]?490|Redesign|Neubau|Abo|monatlich|Rabatt|Aktion/i);
  // Texte sind aus OFFERS abgeleitet – eine Preisänderung dort ändert die Vorlage mit.
  assert.ok(offer150Text().includes(String(OFFERS.REPAIR_CHECK_150.price)) && offer480Text().includes(String(OFFERS.REPAIR_FIX_500.price)));
});

test("Keine falsche Behauptung: erster Blick ≠ vollständige Prüfung; nie „bereits komplett geprüft“", () => {
  for (const issues of [[BROKEN], [BROKEN, IMAGE]]) {
    const { body } = draft(issues);
    assert.match(body, /beim ersten Blick direkt aufgefallen/);
    assert.doesNotMatch(body, /komplette Website (bereits )?geprüft|gesamte Website (bereits |schon )?geprüft|vollständig geprüft|habe Ihre (gesamte|ganze|komplette) Website/i);
    assert.match(body, /Mein Angebot umfasst einen vollständigen Webseiten-Check: Ich prüfe/, "Check ist Angebot (Zukunft), keine Vergangenheitsform");
  }
  // Mit zwei Befunden: „nur das, was … aufgefallen ist“ (Plural-tauglich), mit einem: „nur der Punkt“.
  assert.match(draft([BROKEN]).body, /Das ist nur der Punkt, der mir beim ersten Blick/);
  assert.match(draft([BROKEN, IMAGE]).body, /Das ist nur das, was mir beim ersten Blick/);
});

test("Max. 2 Findings, nur belegte sichtbare Fehler, kein Jargon nach aussen, Evidence intern; ohne sichtbaren Fehler kein Entwurf", () => {
  const { body } = draft([BROKEN, IMAGE, MAILTO]);
  assert.equal((body.match(/aufgefallen, dass/g) || []).length, MAX_CUSTOMER_FINDINGS);
  assert.equal(MAX_CUSTOMER_FINDINGS, 2);
  assert.doesNotMatch(customerPart(body).replace(/CHF \d+/g, ""), CUSTOMER_JARGON_RE, "kein technischer Jargon (Preise sind keine Statuscodes)");
  assert.doesNotMatch(body, /HTTP \d|\b404\b|\bDOM\b|\bCLS\b|\bLCP\b|Lighthouse|Meta-Tag|Zertifikat|Framework|\bSEO\b|team-alt|img\/x\.jpg|mailto:/i);
  const urls = body.match(/https?:\/\/[^\s)]+/g) || [];
  assert.deepEqual([...new Set(urls)], [LANDING_PAGE_URL], "einzige URL = Landingpage");
  const r = createColdDraft(lead({ websiteIssues: [BROKEN, IMAGE, MAILTO] }), { sender: SENDER, now: T0 });
  assert.ok(r.issue_evidence.length >= 1 && r.issue_evidence.every((e) => e.url && e.evidence), "technische Evidence bleibt intern");
  assert.equal(r.customer_findings.length, 2);
  // Nichts erfinden: nur Ladezeit/Titel → keine Kundenaussage → kein Entwurf.
  assert.deepEqual(customerFindings([issue("slow_response", "medium", "https://muster.ch/", "https://muster.ch/"), issue("missing_title", "low", "https://muster.ch/", "https://muster.ch/")]), []);
  assert.throws(() => createColdDraft(lead({ websiteIssues: [issue("slow_response", "medium", "https://muster.ch/", "https://muster.ch/")] }), { sender: SENDER, now: T0 }));
});

test("Vorlage ändert nichts an der Rechtslage: Cold Draft bleibt COLD_LEAD_DRAFT_ONLY, legal_basis NONE, kein Auto-Send; Worker-/Gmail-Sperren unverändert", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-029-"));
  const store = createStore(dir);
  fs.writeFileSync(path.join(dir, "suppression.json"), "{}");
  const r = ensureColdDraft(store, lead(), { sender: SENDER, now: T0, contacted: new Set() });
  assert.equal(r.status, "queued"); assert.equal(r.draft_mode, COLD_MODE); assert.equal(r.legal_basis, "NONE");
  assert.equal(r.message_class, "DRAFT_ONLY"); assert.equal(r.automatic_send_allowed, false); assert.equal(r.manual_send_decision_required, true);
  assert.match(r.body, /vollständigen Webseiten-Check/);
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.equal(q.automatic_send_eligible, false); assert.equal(q.automatic_marketing_send_eligible, false); assert.equal(q.draft_creation_eligible, true);
  const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
  const mw = fs.readFileSync(path.join(ROOT, "mail-worker.js"), "utf8");
  assert.match(mw, /cold_draft_never_auto/); assert.match(fs.readFileSync(path.join(ROOT, "gmail.js"), "utf8"), /COLD_LEAD_DRAFT_ONLY/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "swiss-repair.js"), "utf8"), /send[ _-]?anyway|force[ _-]?send|legal[ _-]?override|auto[ _-]?send[ _-]?cold/i);
});
