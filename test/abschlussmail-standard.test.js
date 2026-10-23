// Verbindlicher Abschlussmail-Standard «Check & Reparatur» (docs/ABSCHLUSSMAIL-STANDARD.md): Gesamtzahl = behoben + nicht behoben,
// jeder Punkt einzeln mit konkreter Beschreibung, Prüfangaben nur aus dem Auftrag, TESTAUFTRAG nur bei internen Testaufträgen,
// «live» nur nach bestätigtem Deployment. Praxis-Kälin-Fall = echte Daten des internen Testauftrags RF480-20261022-7371d9.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCustomerReport, buildRepairDeliveryMail, reportUnsafe, INTERNAL_TEST_KIND } from "../repair-workflow.js";

const SRC = "https://6ad2726a498d2003e5257f8f--praxis-kaelin.netlify.app/";
const praxis = () => ({
  order_id: "RF480-20261022-7371d9", domain: "praxis-kaelin.netlify.app", company: "Praxis Kaelin (intern)", contact_name: null,
  test_order: true, environment: "TEST", test_kind: INTERNAL_TEST_KIND, plan: [{}, {}, {}],
  issues: {
    m: { type: "missing_meta_description", severity: "low", repair_status: "open", repairable: false, page: SRC, customer_text: null },
    a: { type: "broken_anchor", severity: "high", repair_status: "repaired", page: SRC, customer_text: "Der Link «Termin vereinbaren» springt nicht zum vorgesehenen Bereich der Seite" },
    c: { type: "content_clipped", severity: "high", repair_status: "repaired", page: SRC, customer_text: "Im Bereich «Notfall- und Krisenhilfe» sind Inhalte abgeschnitten und nicht sichtbar" },
    j: { type: "js_runtime_error", severity: "medium", repair_status: "repaired", page: SRC, customer_text: "Beim Laden der Seite tritt ein Programmfehler auf, dadurch wird ein Teil der Seite nicht vollständig angezeigt" },
  },
  retest: { desktop: { ok: true, method: "Browser-Prüfung Desktop 1440×900" }, mobile: { ok: true, method: "Browser-Prüfung Smartphone 390×844" }, http_ok: true, browser: true, tested_at: "2026-10-22T21:48:34.663Z" },
  browser_gate: { required: true, desktop: "JA", mobile: "JA", navigation: "NEIN", regression: "KEINE" },
  deployment: { deployed: true, live_retest_ok: true },
});
const mailOf = (o) => { o.report = buildCustomerReport(o); return buildRepairDeliveryMail(o); };

test("Praxis Kälin: vollständige Abschlussmail exakt im verbindlichen Format", () => {
  const o = praxis();
  const m = mailOf(o);
  assert.equal(m.subject, "[E2E-TEST] Webseiten-Check praxis-kaelin.netlify.app – Abschlussbericht");
  assert.equal(m.body, `TESTAUFTRAG (intern) – keine Zahlung, keine Rechnung. Diese Nachricht ging nur an das Test-Postfach.

Hallo Praxis Kaelin (intern)

Hier ist Ihr Abschlussbericht:

Webseiten-Check – Abschlussbericht «Check & Reparatur» (CHF 480)

Website: praxis-kaelin.netlify.app
Datum: 2026-10-22

Was geprüft wurde:
Ihre Startseite und die von dort verlinkten Unterseiten – Links, Navigation, Bilder, Kontaktbereich sowie die Darstellung auf Smartphone und Desktop.

Gefundene Punkte: 4

Behoben wurden:
• Der Link «Termin vereinbaren» springt nicht zum vorgesehenen Bereich der Seite – behoben und erneut geprüft.
• Im Bereich «Notfall- und Krisenhilfe» sind Inhalte abgeschnitten und nicht sichtbar – behoben und erneut geprüft.
• Beim Laden der Seite tritt ein Programmfehler auf, dadurch wird ein Teil der Seite nicht vollständig angezeigt – behoben und erneut geprüft.

Nicht behoben (bitte kontaktieren Sie mich):
• Auf Ihrer Startseite fehlt die Kurzbeschreibung für Suchmaschinen (Meta-Beschreibung)

Abschlusskontrolle:
Desktop: in Ordnung (Browser-Prüfung Desktop 1440×900)
Smartphone: in Ordnung (Browser-Prüfung Smartphone 390×844)

Desktop geprüft: Ja
Mobile geprüft: Ja
Erneute Prüfung nach der Reparatur (Retest): Abgeschlossen

Bei der Abschlussprüfung im Browser wurden keine neuen Darstellungsfehler gefunden.

Die Korrekturen sind auf Ihrer Website live und wurden danach erneut geprüft.

Bei Fragen genügt eine kurze Antwort auf diese E-Mail.

Freundliche Grüsse
Chris
Helvetic Webdesign`);
  assert.equal(reportUnsafe(o.report.body, o), null);
  assert.equal(m.inline, true);
});

test("Echter Kundenauftrag: keine Test-Kennzeichnung, Name/Domain/Datum aus dem Auftrag", () => {
  const o = { ...praxis(), test_order: false, environment: "LIVE", test_kind: undefined, contact_name: "Frau Muster", domain: "muster.ch",
    retest: { ...praxis().retest, tested_at: "2026-11-03T08:00:00.000Z" } };
  const m = mailOf(o);
  assert.doesNotMatch(m.body, /TESTAUFTRAG|intern|Test-Postfach/);
  assert.doesNotMatch(m.subject, /E2E-TEST/);
  assert.match(m.body, /^Hallo Frau Muster\n\nHier ist Ihr Abschlussbericht:\n/);
  assert.match(m.body, /Website: muster\.ch\nDatum: 2026-11-03\n/);
  // Ein E2E-Testauftrag, der kein interner Admin-Testauftrag ist, trägt die interne Kennzeichnung ebenfalls nicht.
  assert.doesNotMatch(mailOf({ ...o, test_order: true }).body, /TESTAUFTRAG \(intern\)/);
});

test("Nicht behobene Fehler: jeder einzeln, Gesamtzahl = behoben + nicht behoben, nie «behoben» ohne Reparatur", () => {
  const o = praxis();
  Object.assign(o.issues, {
    r: { type: "broken_link", severity: "medium", repair_status: "rolled_back", customer_text: "Link «Team» führt auf eine Fehlerseite" },
    f: { type: "broken_image", severity: "medium", repair_status: "repair_failed", customer_text: "Bild auf der Startseite wird nicht angezeigt" },
    u: { type: "unbekannter_typ", severity: "medium", repair_status: "needs_review", page: SRC },
    k: { type: "customer_content_change", repair_status: "repaired", customer_text: "Inhaltsänderung nach Ihrem Wunsch – Telefonnummer: 044 000 00 00" },
  });
  const body = buildCustomerReport(o).body;
  assert.match(body, /Gefundene Punkte: 7\n/, "4 + 3 neue Fehler; der Inhaltswunsch ist kein gefundener Fehler");
  const open = body.split("Nicht behoben (bitte kontaktieren Sie mich):\n")[1].split("\n\n")[0].split("\n");
  assert.deepEqual(open, ["• Auf Ihrer Startseite fehlt die Kurzbeschreibung für Suchmaschinen (Meta-Beschreibung)", "• Link «Team» führt auf eine Fehlerseite",
    "• Bild auf der Startseite wird nicht angezeigt", "• Ein technischer Punkt auf Ihrer Startseite"]);
  const fixedBlock = body.split("Behoben wurden:\n")[1].split("\n\n")[0];
  assert.doesNotMatch(fixedBlock, /Team|Bild|Meta/, "zurückgerollt/gescheitert/offen nie als behoben");
  assert.match(fixedBlock, /Inhaltsänderung nach Ihrem Wunsch/);
  assert.equal(reportUnsafe(body, o), null);
});

test("Keine falschen Prüf- und Live-Angaben: Retest unvollständig, kein Browser, nicht deployt", () => {
  const o = { ...praxis(), deployment: { deployed: false }, browser_gate: {},
    retest: { desktop: { ok: true, method: "passiver Seitenabruf (Desktop)" }, mobile: { ok: false, method: "passive Prüfung (Viewport + bekannte Mobile-Befunde); kein echter Geräte-Rendertest" }, http_ok: false, tested_at: "2026-10-22T10:00:00Z" } };
  const body = buildCustomerReport(o).body;
  assert.match(body, /Desktop: in Ordnung \(passiver Seitenabruf \(Desktop\)\)\nSmartphone: nicht in Ordnung \(passive Prüfung/);
  assert.match(body, /Desktop geprüft: Ja\nMobile geprüft: Nein\nErneute Prüfung nach der Reparatur \(Retest\): Nicht abgeschlossen/);
  assert.match(body, /Eine Prüfung auf neue Darstellungsfehler wurde nicht abgeschlossen\./);
  assert.doesNotMatch(body, /live/);
  assert.match(body, /Die Korrekturen sind vorbereitet und werden nach Rücksprache aufgeschaltet\./);
  // Browser-Gate gefordert, aber nicht bestanden → nie «geprüft: Ja».
  const g = buildCustomerReport({ ...praxis(), browser_gate: { required: true, desktop: "NEIN", mobile: "JA", regression: "GEFUNDEN" } }).body;
  assert.match(g, /Desktop geprüft: Nein\nMobile geprüft: Ja/);
  assert.match(g, /neue Darstellungsfehler gefunden\./);
  // Ohne Retest: nichts erfunden.
  assert.match(buildCustomerReport({ ...praxis(), retest: undefined }).body, /Desktop: nicht geprüft\nSmartphone: nicht geprüft\n\nDesktop geprüft: Nein\nMobile geprüft: Nein\nErneute Prüfung nach der Reparatur \(Retest\): Nicht abgeschlossen/);
});
