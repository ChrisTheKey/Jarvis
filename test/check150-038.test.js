// CHECK & ANLEITUNG CHF 150 — AUTOMATED FULFILLMENT (038): Start NUR mit bestätigtem Verkauf (sales.json) – Cold-Lead/Draft/
// manuell gesendete Cold-Mail/QUALIFIED starten nie etwas. Vollständiger PASSIVER Audit, ALLE relevanten belegten Findings
// (kein 3er-Deckel), kundenspezifische Anleitung je Befund, Bericht + genau EIN Gmail-Lieferentwurf (nie gesendet),
// 0 Website-Schreiboperationen. Keine Mail, kein Netz – Auditor und Gmail sind Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../mail-worker.js";
import { OFFERS, recordSale } from "../sales.js";
import { selectCustomerVisibleFindings, CUSTOMER_JARGON_RE, MAX_CUSTOMER_FINDINGS } from "../swiss-repair.js";
import {
  CHECK150_STATES, CHECK150_BLOCKED, CHECK150_ORDERS_FILE, createCheck150Order, completeCheck150, confirmedCheck150Sale,
  createCheck150Engine, buildCheck150Findings, buildCheck150Report, buildDeliveryDraft, publicCheck150Orders, check150Status,
} from "../check-150-workflow.js";
import { cleanCheck150 } from "../server-control.js";
import { fullSiteAudit } from "../repair-workflow.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T09:00:00Z");
const HOME = "https://muster.ch/";
let dir, store;

const rawIssue = (type, severity, url, extra = {}) => ({ type, url, page: HOME, evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity, detectedAt: T0.toISOString(), ...extra });
const visual = (type, severity, location) => rawIssue(type, severity, HOME, { reproducible: true, location, evidence: `${type} bei 375 px, 2× reproduziert` });
const LINK = (n = "team", sev = "medium") => rawIssue("broken_link", sev, `https://muster.ch/${n}-alt`, { label: `Unsere ${n}` });
const IMAGE = (n = "team") => rawIssue("broken_image", "medium", `https://muster.ch/img/${n}.jpg`, { evidence: `Bild liefert HTTP 404 (eingebunden auf ${HOME})` });
const BUTTON = visual("button_broken", "medium", "Offerte anfragen");
const FORM = visual("contact_form_broken", "high", "Kontakt");
const CERT = rawIssue("https_certificate", "high", HOME, { evidence: "TLS-Fehler beim Aufruf: CERT_HAS_EXPIRED" });
const CONTACT = rawIssue("contact_page_broken", "high", "https://muster.ch/kontakt");
const MAILTO = rawIssue("broken_mailto", "medium", HOME, { evidence: 'Ungültige mailto-Adresse im Link: "(leer)"' });
const OVERLAP = visual("mobile_text_overlap", "medium", "Angebot");

function fakeAuditor(issues, { html = "<html><head><meta name=viewport content=x></head><body>Seite</body></html>", reachable = true } = {}) {
  const calls = [];
  return { calls, audit: async (website) => { calls.push(website); return { website, host: "muster.ch", reachable, finalUrl: website, title: "Muster AG", issues, pages: { home: html }, requests: 2 }; } };
}
function fakeGmail() {
  const calls = [];
  return {
    calls,
    createDraft: async (x) => { calls.push({ op: "create", to: x.to, subject: x.subject, body: x.body }); return { draftId: "dr" + calls.length, threadId: "t" + calls.length, messageId: "m" + calls.length }; },
    updateDraft: async (id, x) => { calls.push({ op: "update", id, ...x }); return { draftId: id }; },
    sendDraft: async () => { calls.push({ op: "SEND" }); throw new Error("darf nie aufgerufen werden"); },
  };
}
const sale150 = () => store.write("sales.json", { records: { "muster.ch": { status: "customer", sale: { selected_offer: "REPAIR_CHECK_150", sale_date: "2026-10-12", sale_value: 150, currency: "CHF", customer_status: "customer", work_status: "open", evidence: [] } } } });
const sale480 = () => store.write("sales.json", { records: { "muster.ch": { status: "customer", sale: { selected_offer: "REPAIR_FIX_500", sale_date: "2026-10-12", sale_value: 480, currency: "CHF", customer_status: "customer", work_status: "open", evidence: [] } } } });
const newOrder = (over = {}) => createCheck150Order(store, { domain: "muster.ch", website: HOME, company: "Muster AG", delivery_email: "auftrag@muster.ch", contact_name: "Frau Muster", now: T0, ...over });
const readOrder = (id) => store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[id];
const engine = (issues, gmail = fakeGmail(), opts = {}) => { const auditor = fakeAuditor(issues, opts); return { gmail, auditor, eng: createCheck150Engine({ store, gmail, auditor, now: () => T0 }) }; };

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-c150-")); store = createStore(dir); });

test("Zustandsmodell wie vorgegeben; Auftrag draft-only mit Pflicht-Lieferadresse; CHF 150 aus OFFERS", () => {
  assert.deepEqual(CHECK150_STATES, ["ORDER_RECEIVED", "ORDER_CONFIRMED", "FULL_AUDIT", "FINDINGS_ANALYSIS", "INSTRUCTIONS_GENERATION", "CUSTOMER_REPORT_READY", "DELIVERY_DRAFT_CREATED", "READY_FOR_DELIVERY", "COMPLETED"]);
  assert.deepEqual(CHECK150_BLOCKED, ["BLOCKED_ORDER_NOT_CONFIRMED", "AUDIT_FAILED", "REPORT_FAILED", "DELIVERY_DRAFT_FAILED", "MANUAL_REVIEW_REQUIRED"]);
  const o = newOrder();
  assert.deepEqual([o.offer_class, o.price_chf, o.delivery, o.automatic_send_allowed], ["REPAIR_CHECK_150", OFFERS.REPAIR_CHECK_150.price, "draft", false]);
  assert.equal(o.price_chf, 150);
  assert.throws(() => createCheck150Order(store, { domain: "muster.ch", delivery_email: "" }), /Lieferadresse/);
  assert.throws(() => newOrder(), /läuft bereits/);
});

test("ORDER GATE: Cold-Lead/Draft/manuell gesendet/QUALIFIED starten NIE; nur erfasster CHF-150-Verkauf; CHF 480 zählt nicht", async () => {
  // Cold-Welt-Fixtures: Lead-DB QUALIFIED, offener Cold-Draft, manuell gesendete Cold-Mail – alles OHNE Verkauf.
  store.write("lead_registry.json", { schema: 1, leads: { "muster.ch": { lead_id: "muster.ch", status: "QUALIFIED" } } });
  store.write("individual_reviews.json", { reviews: { "muster.ch": { status: "manually_sent", draft_mode: "COLD_LEAD_DRAFT_ONLY", recipient: "info@muster.ch", manual_send_detected: true } } });
  const o = newOrder();
  const { eng, gmail, auditor } = engine([LINK()]);
  await eng.processAll();
  assert.equal(readOrder(o.order_id).state, "BLOCKED_ORDER_NOT_CONFIRMED");
  assert.equal(auditor.calls.length, 0, "ohne bestätigten Auftrag wird nicht einmal auditiert");
  assert.equal(gmail.calls.length, 0, "kein Entwurf ohne bestätigten Auftrag");
  // Ein CHF-480-Verkauf ist KEIN CHF-150-Auftrag.
  sale480();
  await eng.processAll();
  assert.equal(readOrder(o.order_id).state, "BLOCKED_ORDER_NOT_CONFIRMED");
  assert.equal(confirmedCheck150Sale(store, "muster.ch"), null);
  // Erfasster CHF-150-Verkauf (bestehende Order-Logik) → Auftrag läuft automatisch weiter (Fortsetzung = Re-Check je Lauf).
  sale150();
  await eng.processAll();
  assert.equal(readOrder(o.order_id).state, "READY_FOR_DELIVERY");
});

test("recordSale aus sales.js ist die bestehende Bestätigungslogik", () => {
  const records = recordSale({}, "muster.ch", { offer: "REPAIR_CHECK_150", lead: {}, now: T0 });
  store.write("sales.json", { records });
  assert.equal(confirmedCheck150Sale(store, "muster.ch")?.sale_date, T0.toISOString().slice(0, 10));
});

test("AUDIT: 2 Probleme → 2 im Bericht; 8 unterschiedliche → alle 8 (kein 3er-Deckel); Cold-Pfad bleibt bei 3", () => {
  const two = buildCheck150Findings(Object.fromEntries([LINK(), IMAGE()].map((i, n) => ["I" + n, { ...i, issue_id: "I" + n }])));
  assert.equal(two.length, 2);
  const eight = [LINK("team"), LINK("preise"), IMAGE("logo"), BUTTON, FORM, CERT, MAILTO, OVERLAP];
  const f8 = buildCheck150Findings(Object.fromEntries(eight.map((i, n) => ["I" + n, { ...i, issue_id: "I" + n }])));
  assert.equal(f8.length, 8, "alle relevanten Punkte im bezahlten Bericht");
  assert.equal(selectCustomerVisibleFindings(eight).length, MAX_CUSTOMER_FINDINGS, "Cold-Outreach-Auswahl bleibt bei 3");
  // Sortierung critical/high vor medium.
  assert.ok(["high", "critical"].includes(f8[0].severity));
  assert.equal(f8.at(-1).severity, "medium");
});

test("AUDIT: Duplikate zusammengeführt; interne Rohsignale ohne Kundenwirkung erscheinen nicht; keine Befunde → ehrlicher Bericht", () => {
  // 3 Bilder derselben Seite + Kontaktseite kaputt + Link auf genau diese Kontaktseite = 2 Kundenprobleme.
  const dup = [IMAGE("a"), IMAGE("b"), IMAGE("c"), CONTACT, rawIssue("broken_link", "medium", "https://muster.ch/kontakt", { label: "Kontakt" })];
  const f = buildCheck150Findings(Object.fromEntries(dup.map((i, n) => ["I" + n, { ...i, issue_id: "I" + n }])));
  assert.equal(f.length, 2);
  // Interne Signale (Titel, Ladezeit, fehlende Weiterleitung, Barrierefreiheits-Detail) sind KEIN Kundenproblem.
  const internal = [rawIssue("missing_title", "medium", HOME, { evidence: "kein <title>" }), rawIssue("slow_response", "medium", HOME, { evidence: "Ladezeit 7 s" }),
    rawIssue("no_https_redirect", "low", HOME, { evidence: "kein Redirect" }), rawIssue("missing_alt", "low", HOME, { evidence: "3 Bilder ohne alt" })];
  assert.equal(buildCheck150Findings(Object.fromEntries(internal.map((i, n) => ["I" + n, { ...i, issue_id: "I" + n }]))).length, 0);
  const empty = buildCheck150Report({ domain: "muster.ch", company: "Muster AG", findings: [], audit_completed_at: T0.toISOString(), order_id: "CA150-x" }, { now: T0 });
  assert.ok(empty.text.includes("keine relevanten, für Besucher sichtbaren Probleme festgestellt"));
});

test("ANLEITUNG: jede Position vollständig (Problem/Ort/Auswirkung/Lösung/Schritte/Retest), Titel/Impact jargonfrei, Aufwand gesetzt", () => {
  const all = [LINK(), IMAGE(), BUTTON, FORM, CERT, CONTACT, MAILTO, OVERLAP];
  const f = buildCheck150Findings(Object.fromEntries(all.map((i, n) => ["I" + n, { ...i, issue_id: "I" + n }])));
  for (const x of f) {
    assert.ok(x.customer_title && x.customer_problem && x.customer_impact && x.location && x.fix_summary, x.finding_id);
    assert.ok(Array.isArray(x.steps) && x.steps.length >= 2 && x.steps.every((s) => s.trim().length > 10), `${x.finding_id}: keine leeren Schritte`);
    assert.ok(Array.isArray(x.verification_steps) && x.verification_steps.length >= 1, `${x.finding_id}: Retest fehlt`);
    assert.ok(["Einfach", "Mittel", "Fachperson empfohlen"].includes(x.difficulty));
    assert.ok(!CUSTOMER_JARGON_RE.test(x.customer_title) && !CUSTOMER_JARGON_RE.test(x.customer_impact), `${x.finding_id}: Jargon im Kundentext`);
  }
});

test("ANLEITUNG: unbekannter Stack → keine erfundenen CMS-Menüs; WordPress sicher erkannt → WordPress-Schritt erlaubt; komplexe Punkte → Fachperson + sachlicher CHF-480-Hinweis", () => {
  const issues = Object.fromEntries([LINK(), CERT].map((i, n) => ["I" + n, { ...i, issue_id: "I" + n }]));
  const neutral = buildCheck150Findings(issues, { stackType: "other" });
  const allSteps = (f) => f.flatMap((x) => x.steps).join(" ");
  for (const verboten of ["WordPress", "Elementor", "Wix", "Jimdo", "Squarespace", "Webflow"]) assert.ok(!allSteps(neutral).includes(verboten), `erfunden: ${verboten}`);
  assert.ok(allSteps(neutral).includes("Ihrem Website-System"));
  const wp = buildCheck150Findings(issues, { stackType: "wordpress" });
  assert.ok(allSteps(wp).includes("WordPress-Adminbereich"));
  assert.ok(!allSteps(wp).includes("Elementor"), "keine erfundenen Plugin-Menüs");
  const cert = neutral.find((x) => x.primary_type === "https_certificate");
  assert.equal(cert.difficulty, "Fachperson empfohlen");
  assert.equal(cert.expert_recommended, true);
  assert.ok(cert.steps.join(" ").includes("Hosting-Anbieter"));
  const report = buildCheck150Report({ domain: "muster.ch", findings: neutral, audit_completed_at: T0.toISOString(), order_id: "x" }, { now: T0 });
  assert.ok(report.text.includes("«Check & Reparatur» für CHF 480"), "sachlicher Hinweis bei Fachperson-Punkten");
  const simpleOnly = buildCheck150Findings(Object.fromEntries([LINK()].map((i, n) => ["I" + n, { ...i, issue_id: "I" + n }])));
  const r2 = buildCheck150Report({ domain: "muster.ch", findings: simpleOnly, audit_completed_at: T0.toISOString(), order_id: "x" }, { now: T0 });
  assert.ok(!r2.text.includes("CHF 480"), "kein Upselling ohne Fachperson-Punkte");
});

test("E2E Muster AG (Spec 28): 4 Probleme → 4 Anleitungen → Bericht → genau 1 Gmail-Draft → 0 Sends → 0 Website-Writes; Duplikatschutz; Neustart", async () => {
  sale150();
  const o = newOrder();
  const issues = [LINK(), IMAGE(), BUTTON, FORM];
  const { eng, gmail, auditor } = engine(issues);
  await eng.processAll();
  const saved = readOrder(o.order_id);
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.equal(saved.report_findings_count, 4);
  assert.equal(saved.report.summary.total, 4);
  assert.equal(saved.report.findings.length, 4);
  assert.ok(saved.audit_completed_at && saved.report_generated_at && saved.delivery_draft_created_at);
  assert.equal(saved.delivery_status, "draft_ready");
  // Genau EIN Draft an die Lieferadresse des Auftrags (nicht an eine Cold-Adresse).
  const creates = gmail.calls.filter((c) => c.op === "create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0].to, "auftrag@muster.ch");
  assert.ok(creates[0].subject.includes("muster.ch"));
  const body = creates[0].body;
  assert.ok(body.includes("Frau Muster") && body.includes("muster.ch") && body.includes("4 relevante"));
  assert.ok(body.includes("Schritt-für-Schritt"));
  assert.ok(body.includes("PROBLEM 1"), "vollständiger Bericht inline");
  for (const verboten of ["HTTP 404", "evidence", o.order_id, "I0", "git:", "C:\\", "/data/secrets", "reproduziert"]) assert.ok(!body.includes(verboten), `Draft enthält "${verboten}"`);
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 0, "0 Auto-Send-Events");
  // Duplikatschutz: weitere Läufe erzeugen keinen zweiten Draft (READY wartet auf Chris).
  await eng.processAll();
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll(); // „Neustart“: neue Engine, gleicher Store
  assert.equal(gmail.calls.filter((c) => c.op === "create").length, 1, "kein Draft-Duplikat");
  assert.equal(auditor.calls.length, 1, "kein erneuter Audit nach Abschluss der Prüfung");
  // Abschluss nur explizit; Historie lückenlos persistiert.
  assert.equal(completeCheck150(store, o.order_id, { now: T0 }).state, "COMPLETED");
  assert.ok(readOrder(o.order_id).state_history.some((h) => h.to === "FULL_AUDIT"));
});

test("KEINE REPARATUR: Modul kennt keinerlei Schreibpfade an Kundenwebsites (Quelle + Laufzeit)", async () => {
  const src = fs.readFileSync(path.join(ROOT, "check-150-workflow.js"), "utf8");
  for (const verboten of ["applyFix", "deployProduction", "rollback", "repair-adapters", "checkAccess", "/merges", "netlify.com", "api.github.com"])
    assert.ok(!src.includes(verboten), `check-150-workflow.js enthält "${verboten}"`);
  // Laufzeit: ausser Gmail-Draft-Aufrufen passiert nichts nach aussen (Auditor ist lesend, wie ein Besucher).
  sale150();
  const o = newOrder();
  const { eng, gmail } = engine([LINK()]);
  await eng.processAll();
  assert.ok(gmail.calls.every((c) => ["create", "update"].includes(c.op)));
  assert.equal(readOrder(o.order_id).state, "READY_FOR_DELIVERY");
});

test("Audit nicht erreichbar → AUDIT_FAILED; Gmail 429 beim Draft → bleibt im Zustand (Retry), kein Datenverlust", async () => {
  sale150();
  const o = newOrder();
  await engine([], undefined, { reachable: false }).eng.processAll();
  assert.equal(readOrder(o.order_id).state, "AUDIT_FAILED");
  // Transienter Gmail-Fehler: Zustand DELIVERY_DRAFT_CREATED bleibt, nächster Lauf legt den Entwurf an.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-c150b-"));
  const store2 = createStore(dir2);
  store2.write("sales.json", store.read("sales.json", {}));
  const o2 = createCheck150Order(store2, { domain: "muster.ch", website: HOME, company: "Muster AG", delivery_email: "auftrag@muster.ch", now: T0 });
  const flaky = fakeGmail();
  let fail = true;
  const orig = flaky.createDraft;
  flaky.createDraft = async (x) => { if (fail) { fail = false; throw new Error("Gmail POST /drafts: 429 rateLimitExceeded"); } return orig(x); };
  const e2 = createCheck150Engine({ store: store2, gmail: flaky, auditor: fakeAuditor([LINK()]), now: () => T0 });
  await e2.processAll();
  assert.equal(store2.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o2.order_id].state, "DELIVERY_DRAFT_CREATED");
  await e2.processAll();
  assert.equal(store2.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o2.order_id].state, "READY_FOR_DELIVERY");
});

test("DASHBOARD: Allowlist ohne Lieferadresse/Bericht/Pfade; cleanCheck150 strippt Fremdfelder; HUD-Kachel reine Anzeige; Worker/Dockerfile verdrahtet", async () => {
  sale150();
  const o = newOrder();
  await engine([LINK(), CERT]).eng.processAll();
  const pub = publicCheck150Orders(dir);
  assert.equal(pub.orders.length, 1);
  assert.deepEqual([pub.orders[0].state, pub.orders[0].findings, pub.orders[0].report_available, pub.orders[0].draft_available, pub.orders[0].delivery_status],
    ["READY_FOR_DELIVERY", 2, true, true, "draft_ready"]);
  const raw = JSON.stringify(pub);
  for (const verboten of ["auftrag@muster.ch", "steps", "evidence", "report_text_file", "reports", "Schritt"]) assert.ok(!raw.includes(verboten), `Dashboard-Sicht enthält "${verboten}"`);
  const cleaned = cleanCheck150({ ...pub, secret: "x", orders: [{ ...pub.orders[0], delivery_email: "geheim@x.ch", report_text_file: "/data/x" }] });
  const craw = JSON.stringify(cleaned);
  assert.ok(!craw.includes("geheim") && !craw.includes("report_text_file") && !craw.includes("secret"));
  assert.equal(cleaned.orders[0].state, "READY_FOR_DELIVERY");
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.ok(html.includes('id="check150Panel"') && html.includes("renderCheck150"));
  const panel = html.slice(html.indexOf('id="check150Panel"'), html.indexOf("</section>", html.indexOf('id="check150Panel"')));
  assert.ok(!/data-action/.test(panel), "keine Server-Control-Aktionen im CHF-150-Panel");
  assert.ok(fs.readFileSync(path.join(ROOT, "mail-worker.js"), "utf8").includes("runCheck150Orders"));
  assert.ok(fs.readFileSync(path.join(ROOT, "server-agent.js"), "utf8").includes("o.check150"));
  assert.ok(fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile"), "utf8").includes("check-150-workflow.js"));
  assert.equal(check150Status(dir).ready_for_delivery, 1);
});

test("Langer Bericht → Zusammenfassung in der Mail + Berichtsdatei (kein neuer Dateidienst), fullSiteAudit bleibt die gemeinsame Audit-Basis", async () => {
  sale150();
  const o = newOrder();
  const many = [];
  for (let i = 0; i < 14; i++) many.push(LINK("seite" + i));
  many.push(IMAGE()); // mehrere fehlende Bilder derselben Seite wären korrekt EIN Finding (Dedupe)
  const { eng, gmail } = engine(many);
  await eng.processAll();
  const saved = readOrder(o.order_id);
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.equal(saved.report_findings_count, 15);
  const body = gmail.calls.find((c) => c.op === "create").body;
  assert.ok(body.length <= 6000, "Mail bleibt unter der Entwurfsgrenze");
  assert.ok(body.includes("im Anhang"), "Hinweis auf den vollständigen Bericht");
  assert.ok(saved.report_text_file && fs.existsSync(saved.report_text_file), "Berichtsdatei liegt lokal im Worker-Verzeichnis");
  assert.ok(fs.readFileSync(saved.report_text_file, "utf8").includes("PROBLEM 15"));
  const a = await fullSiteAudit(HOME, { auditor: fakeAuditor([LINK()]), now: () => T0 });
  assert.equal(Object.values(a.issues)[0].type, "broken_link");
});
