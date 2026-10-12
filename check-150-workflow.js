// CHECK & ANLEITUNG (CHF 150) — automatische Erfüllung (TF-038) + ZAHLUNGSSCHWELLE (TF-041). Vollständiger PASSIVER
// Webseiten-Check plus verständliche, kundenspezifische Schritt-für-Schritt-Anleitung zu den tatsächlich gefundenen,
// belegten Problemen. Ab erfüllter Zahlungsschwelle wird die Service-E-Mail AUTOMATISCH an den bestätigten Kunden
// gesendet (vorher bleibt alles stehen). Der CHF-480-Reparaturworkflow (repair-workflow.js) bleibt unberührt.
//
// Harte Regeln (fail closed):
//   - Start NUR mit tatsächlich bestätigtem CHF-150-Auftrag = erfasster Verkauf in sales.json (recordSale, bestehende
//     Order-Logik). Cold-Lead, Cold-Draft, manuell gesendete Cold-Mail, QUALIFIED, Interesse: NIE ein Start.
//     Ein REPAIR_FIX_500-Verkauf startet diesen Workflow ebenfalls nicht. Ohne Auftrag: BLOCKED_ORDER_NOT_CONFIRMED
//     (wird bei jedem Lauf erneut geprüft – erfasst Chris den Verkauf später, läuft der Auftrag automatisch weiter).
//   - VERKAUF != ZAHLUNG (TF-041): ein bestätigter Auftrag kann mit paid_chf = 0 existieren und MUSS dann warten.
//     Erst wenn kumulativ mindestens CHF 75 (erste Hälfte des Festpreises, payments.js) tatsächlich als eingegangen
//     verbucht sind: bezahlter Check, Anleitung, Kundenbericht und automatischer Versand der Service-E-Mail an den
//     bestätigten Kunden. Vorher: KEIN Audit für die bezahlte Leistung, KEIN Bericht, KEINE Anleitung, KEINE Liefermail
//     (BLOCKED_PAYMENT_NOT_RECEIVED, wird je Lauf neu geprüft). Unmittelbar vor dem Versand wird die Schwelle erneut
//     geprüft (voided/refunded Zahlungen zählen nicht mehr); scheitert der automatische Versand dauerhaft, bleibt der
//     Entwurf fail safe in READY_FOR_DELIVERY für Chris liegen.
//   - NIE eine Website-Änderung: dieses Modul kennt keine Adapter und keinerlei Fix-, Deploy- oder Rollback-Funktionen,
//     keine Schreiboperation an fremden Systemen. Nur lesender Audit (bestehender site-auditor) + Bericht + Gmail-Entwurf.
//   - Nur belegte Probleme (bestehendes Evidence-/Jargon-Gate aus swiss-repair.js), ALLE relevanten (kein 3er-Deckel),
//     Duplikate zusammengeführt, interne Rohsignale ohne Kundenwirkung erscheinen nicht. Nichts wird erfunden.
//   - Unbekannter Stack → anbieterneutrale Anleitung, keine erfundenen Menüs; komplexe/riskante Punkte → Fachperson
//     empfohlen + sachlicher Hinweis auf «Check & Reparatur» (CHF 480), kein aggressives Upselling.
//   - Jeder Zustand persistent in check150_orders.json – nach VPS-/Worker-Neustart geht es exakt dort weiter.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore, createLogger, acquireLock, releaseLock } from "./mail-worker.js";
import { OFFERS, isVoidedSale } from "./sales.js";
import { paymentGateForOrder, paymentThresholdChf, paymentSummary } from "./payments.js";
import { selectCustomerVisibleFindings } from "./swiss-repair.js";
import { fullSiteAudit, detectStack, normDomain } from "./repair-workflow.js";

export const CHECK150_ORDERS_FILE = "check150_orders.json";
export const CHECK150_OFFER = "REPAIR_CHECK_150"; // Kundenbezeichnung «Check & Anleitung», Preis aus OFFERS (CHF 150)
export const CHECK150_STATES = Object.freeze(["ORDER_RECEIVED", "ORDER_CONFIRMED", "FULL_AUDIT", "FINDINGS_ANALYSIS",
  "INSTRUCTIONS_GENERATION", "CUSTOMER_REPORT_READY", "DELIVERY_DRAFT_CREATED", "DELIVERY_SENDING", "READY_FOR_DELIVERY", "COMPLETED"]);
export const CHECK150_BLOCKED = Object.freeze(["BLOCKED_ORDER_NOT_CONFIRMED", "BLOCKED_PAYMENT_NOT_RECEIVED", "AUDIT_FAILED",
  "REPORT_FAILED", "DELIVERY_DRAFT_FAILED", "MANUAL_REVIEW_REQUIRED"]);
// Von Chris storniert (z. B. versehentlich angelegter Testauftrag): terminal, KEIN Fehler, zählt nie als offen.
// Der Datensatz bleibt aus Nachvollziehbarkeit gespeichert (nie JSON von Hand löschen); Audit/Bericht/Entwurf stoppen,
// es folgt keine Gmail- und keine Website-Aktion.
export const CHECK150_CANCELLED = "CANCELLED";
// BLOCKED_ORDER_NOT_CONFIRMED und BLOCKED_PAYMENT_NOT_RECEIVED sind NICHT terminal – sie werden je Lauf neu geprüft
// (verbucht Chris den Verkauf bzw. die Zahlung später, läuft der Auftrag automatisch weiter).
const RECHECKED = new Set(["BLOCKED_ORDER_NOT_CONFIRMED", "BLOCKED_PAYMENT_NOT_RECEIVED"]);
const TERMINAL = new Set(["COMPLETED", CHECK150_CANCELLED, ...CHECK150_BLOCKED.filter((s) => !RECHECKED.has(s))]);
const WAITING = new Set(["READY_FOR_DELIVERY"]);
// Nachrichtenklasse der Liefermail: Erfüllung eines bezahlten Kundenauftrags – NIE Cold-Outreach/Marketing (TF-041).
export const FULFILLMENT_CLASS = "CUSTOMER_ORDER_FULFILLMENT";
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// ---------- Bestätigter Auftrag (bestehende Order-Logik: sales.json / recordSale) ----------
export function confirmedCheck150Sale(store, domain) {
  const rec = store.read("sales.json", { records: {} }).records?.[normDomain(domain)];
  const sale = rec?.sale;
  // Ein stornierter (voided) Verkauf ist NIE eine Auftragsbestätigung (TF-040) – der Auftrag bleibt BLOCKED_ORDER_NOT_CONFIRMED.
  if (!sale || isVoidedSale(sale) || sale.selected_offer !== CHECK150_OFFER || sale.sale_value !== OFFERS[CHECK150_OFFER].price) return null;
  return { sale_date: sale.sale_date, work_status: sale.work_status || "open", source: "sales.json" };
}

// ---------- Auftrag ----------
export function createCheck150Order(store, { domain, website = null, company = null, delivery_email, contact_name = null, now = new Date() } = {}) {
  const d = normDomain(domain);
  if (!d) throw new Error("Domain erforderlich.");
  // Lieferadresse ist Pflicht und kommt vom bestätigten Auftrag – NIE automatisch eine alte Cold-Outreach-Adresse übernehmen.
  if (!EMAIL_RE.test(delivery_email || "")) throw new Error("Verifizierte Lieferadresse (--email) des bestätigten Auftrags erforderlich.");
  const data = store.read(CHECK150_ORDERS_FILE, { schema: 1, orders: {} });
  const open = Object.values(data.orders || {}).find((o) => normDomain(o.domain) === d && !TERMINAL.has(o.state));
  if (open) throw new Error(`Für ${d} läuft bereits Auftrag ${open.order_id} (${open.state}).`);
  const order_id = `CA150-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${sha(d + now.getTime()).slice(0, 6)}`;
  const order = {
    order_id, offer_class: CHECK150_OFFER, price_chf: OFFERS[CHECK150_OFFER].price, currency: "CHF",
    domain: d, website: website || `https://${d}/`, company, delivery_email: delivery_email.toLowerCase(), contact_name,
    delivery: "draft", automatic_send_allowed: false, // wird erst true, wenn die Zahlungsschwelle erfüllt ist (TF-041)
    payment: { required_chf: OFFERS[CHECK150_OFFER].price / 2, paid_chf: 0, satisfied: false },
    confirmed: null, state: "ORDER_RECEIVED",
    state_history: [{ at: now.toISOString(), from: null, to: "ORDER_RECEIVED", reason: "Auftrag erfasst" }],
    stack: null, audit: null, findings: [], report: null, report_text_file: null, delivery_draft: null,
    audit_completed_at: null, report_generated_at: null, report_findings_count: null, delivery_status: "none",
    blocked_reason: null, created_at: now.toISOString(), updated_at: now.toISOString(),
  };
  data.orders = { ...(data.orders || {}), [order_id]: order };
  store.write(CHECK150_ORDERS_FILE, data);
  return order;
}
function saveOrder(store, order) {
  const data = store.read(CHECK150_ORDERS_FILE, { schema: 1, orders: {} });
  data.orders = { ...(data.orders || {}), [order.order_id]: order };
  store.write(CHECK150_ORDERS_FILE, data);
  return order;
}
const transition = (order, to, reason, now) => {
  order.state_history.push({ at: now.toISOString(), from: order.state, to, reason });
  order.state = to;
  order.updated_at = now.toISOString();
  return order;
};
export function completeCheck150(store, orderId, { now = new Date() } = {}) {
  const order = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders?.[orderId];
  if (!order) throw new Error("Auftrag nicht gefunden.");
  if (order.state !== "READY_FOR_DELIVERY") throw new Error(`Nur READY_FOR_DELIVERY kann abgeschlossen werden (aktuell ${order.state}).`);
  order.delivery_status = "delivered";
  transition(order, "COMPLETED", "Abschluss bestätigt", now);
  return saveOrder(store, order);
}
// Stornierung nur durch Chris (CLI). Nur nicht abgeschlossene Aufträge; Grund optional dokumentiert; der Auftrag bleibt
// gespeichert (Nachvollziehbarkeit). Danach: kein Audit, kein Bericht, kein Entwurf mehr (terminal), keine Gmail-/Website-Aktion.
export function cancelCheck150Order(store, orderId, { reason = null, now = new Date() } = {}) {
  const order = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders?.[orderId];
  if (!order) throw new Error("Auftrag nicht gefunden.");
  if (order.state === "COMPLETED") throw new Error("Abgeschlossene Aufträge können nicht storniert werden.");
  if (order.state === CHECK150_CANCELLED) throw new Error("Auftrag ist bereits storniert.");
  order.cancel_reason = reason ? String(reason).replace(/\s+/g, " ").trim().slice(0, 200) || null : null;
  order.cancelled_at = now.toISOString();
  order.blocked_reason = null;
  transition(order, CHECK150_CANCELLED, order.cancel_reason ? `Von Chris storniert: ${order.cancel_reason}` : "Von Chris storniert", now);
  return saveOrder(store, order);
}

// ---------- Kundenspezifische Anleitung je Befund ----------
// Grundsatz: zum tatsächlichen Befund passend, anbieterneutral formuliert; nur bei SICHER erkanntem Stack etwas konkreter
// (WordPress-Adminbereich, HTML-Datei). NIE erfundene Menüs, Plugins oder Baukasten-Namen. Komplexe/riskante Punkte
// (Sicherheitszertifikat, Weiterleitungsschleife) → Fachperson empfohlen, trotzdem erklärt (was/wo/Änderung/Test).
const DIFFICULTY = Object.freeze(["Einfach", "Mittel", "Fachperson empfohlen"]);
const EXPERT_TYPES = new Set(["https_certificate", "redirect_loop"]);
const pageLabel = (u) => {
  let p; try { p = new URL(u).pathname; } catch { return "der betreffenden Seite"; }
  const seg = p.split("/").filter(Boolean).pop() || "";
  const name = decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ").trim();
  return name ? `der Seite «${name.charAt(0).toUpperCase() + name.slice(1)}»` : "der Startseite";
};
// Erster Schritt je sicher erkanntem Stack; alles andere bleibt anbieterneutral.
const openStep = (stackType, page) => stackType === "wordpress"
  ? `Melden Sie sich im WordPress-Adminbereich Ihrer Website an und öffnen Sie ${page} zur Bearbeitung.`
  : stackType === "static" || stackType === "github_netlify"
    ? `Öffnen Sie die zu ${page} gehörende HTML-Datei Ihrer Website in Ihrem gewohnten Bearbeitungsprogramm.`
    : `Öffnen Sie in Ihrem Website-System die Bearbeitung von ${page}.`;
const publishStep = (stackType) => stackType === "static" || stackType === "github_netlify"
  ? "Speichern Sie die Datei und laden Sie die Website wie gewohnt hoch bzw. veröffentlichen Sie die Änderung."
  : "Speichern und veröffentlichen Sie die Änderung.";
const VERIFY_BOTH = (what) => [`Öffnen Sie Ihre Website neu und laden Sie die Seite einmal frisch.`, `${what} – einmal am Computer und einmal auf dem Smartphone.`];

function instructionsFor(finding, stackType, order) {
  const t = finding.primary_type;
  const page = finding.page_label;
  const area = finding.area ? `«${finding.area}»` : null;
  const mk = (fix_summary, steps, verify, difficulty) => ({ fix_summary, steps, verification_steps: verify, difficulty, expert_recommended: difficulty === "Fachperson empfohlen" });
  switch (t) {
    case "broken_link":
    case "contact_page_broken":
      return mk(
        t === "contact_page_broken" ? "Der Verweis auf Ihre Kontaktseite zeigt auf ein Ziel, das nicht mehr vorhanden ist – er muss auf die richtige Kontaktseite zeigen."
          : "Der Link zeigt auf ein Ziel, das nicht mehr vorhanden ist – er muss auf die richtige, vorhandene Seite zeigen.",
        [openStep(stackType, page),
          finding.label ? `Suchen Sie den Link «${finding.label}».` : "Suchen Sie den betroffenen Link (er führt derzeit auf eine Fehlerseite).",
          "Prüfen Sie das hinterlegte Linkziel.",
          t === "contact_page_broken" ? "Tragen Sie als Ziel Ihre tatsächliche Kontaktseite ein." : "Tragen Sie als Ziel die richtige, vorhandene Seite ein.",
          publishStep(stackType)],
        VERIFY_BOTH("Klicken Sie den Link an und prüfen Sie, ob die richtige Seite erscheint"), "Einfach");
    case "broken_image":
      return mk("Die hinterlegte Bilddatei ist am angegebenen Ort nicht mehr vorhanden – das Bild muss neu zugewiesen oder hochgeladen werden.",
        [openStep(stackType, page), "Suchen Sie die Stelle mit dem fehlenden Bild (dort erscheint aktuell eine leere Fläche).",
          "Laden Sie das gewünschte Bild neu hoch bzw. wählen Sie es aus Ihrer Mediensammlung erneut aus.", publishStep(stackType)],
        VERIFY_BOTH("Prüfen Sie, ob das Bild an dieser Stelle wieder angezeigt wird"), "Einfach");
    case "broken_mailto":
      return mk("Hinter dem E-Mail-Link ist eine unvollständige oder falsche Adresse hinterlegt – sie muss korrigiert werden.",
        [openStep(stackType, page), "Suchen Sie den E-Mail-Link (z. B. auf Ihrer E-Mail-Adresse im Kontaktbereich).",
          "Prüfen Sie die hinterlegte Adresse und korrigieren Sie sie auf Ihre richtige, vollständige E-Mail-Adresse.", publishStep(stackType)],
        VERIFY_BOTH("Klicken Sie den E-Mail-Link an und prüfen Sie, ob sich eine neue Nachricht an die richtige Adresse öffnet"), "Einfach");
    case "contact_form_broken":
      return mk("Das Kontaktformular nimmt Nachrichten derzeit nicht an – meist liegt es an der hinterlegten Empfängeradresse oder den Formular-Einstellungen.",
        [openStep(stackType, page), "Öffnen Sie die Einstellungen des Kontaktformulars.",
          "Prüfen Sie die hinterlegte Empfängeradresse und die Pflichtfelder.", "Korrigieren Sie fehlerhafte Einstellungen.", publishStep(stackType),
          "Senden Sie sich selbst eine Testnachricht über das Formular."],
        ["Füllen Sie das Formular einmal selbst aus und senden Sie es ab.", "Prüfen Sie, ob die Testnachricht in Ihrem Postfach ankommt – am Computer und auf dem Smartphone."], "Mittel");
    case "button_broken":
      return mk(`Der Button ${area || ""} ist derzeit ohne funktionierende Verknüpfung – das hinterlegte Ziel muss korrigiert werden.`.replace("  ", " "),
        [openStep(stackType, page), area ? `Wählen Sie den Button ${area} aus.` : "Wählen Sie den betroffenen Button aus.",
          "Prüfen Sie die hinterlegte Verknüpfung (Zieladresse bzw. Aktion).", "Tragen Sie das richtige Ziel ein.", publishStep(stackType)],
        VERIFY_BOTH("Klicken Sie den Button an und prüfen Sie, ob die vorgesehene Aktion ausgeführt wird"), "Einfach");
    case "mobile_text_overlap":
    case "mobile_content_cut_off":
    case "visible_layout_error":
      return mk(`Die Darstellung im Bereich ${area || "des betroffenen Abschnitts"} stimmt nicht – Abstände bzw. Grössen dieses Bereichs müssen für die schmale Ansicht angepasst werden.`,
        [openStep(stackType, page), area ? `Wählen Sie den Bereich ${area} aus.` : "Wählen Sie den betroffenen Bereich aus.",
          "Öffnen Sie, falls vorhanden, die Vorschau für Mobilgeräte bzw. verkleinern Sie das Browserfenster, um den Fehler zu sehen.",
          "Passen Sie Abstände, Schriftgrösse oder Breite des Bereichs an, bis der Inhalt vollständig und ohne Überlagerung sichtbar ist.",
          publishStep(stackType)],
        ["Öffnen Sie die Seite auf einem Smartphone und prüfen Sie den Bereich.", "Prüfen Sie zusätzlich am Computer mit verkleinertem Fenster, ob alles vollständig sichtbar ist."], "Mittel");
    case "https_certificate":
      return mk("Die Sicherheitsüberprüfung der Verbindung schlägt fehl – das Sicherheitszertifikat Ihrer Website muss beim Hosting-Anbieter erneuert werden.",
        ["Kontaktieren Sie Ihren Hosting-Anbieter (dort, wo Ihre Website gespeichert ist).",
          "Bitten Sie darum, das Sicherheitszertifikat der Website zu erneuern und die automatische Erneuerung zu aktivieren.",
          "Lassen Sie sich bestätigen, dass die Website danach ohne Warnmeldung erreichbar ist."],
        ["Öffnen Sie Ihre Website in einem frischen Browserfenster.", "Prüfen Sie, ob sie ohne Warnmeldung lädt – am Computer und auf dem Smartphone."], "Fachperson empfohlen");
    case "redirect_loop":
      return mk("Die Website leitet Besucher im Kreis weiter und lädt deshalb nicht – die Weiterleitungs-Einstellungen müssen beim Hosting bzw. in der Website-Konfiguration korrigiert werden.",
        ["Kontaktieren Sie Ihren Hosting-Anbieter oder Ihre Website-Betreuung.",
          "Schildern Sie, dass die Website beim Aufruf nicht lädt und der Browser eine Fehlermeldung wegen zu vieler Weiterleitungen zeigt.",
          "Lassen Sie die Weiterleitungs-Einstellungen prüfen und korrigieren."],
        ["Öffnen Sie Ihre Website in einem frischen Browserfenster.", "Prüfen Sie, ob die Startseite normal lädt – am Computer und auf dem Smartphone."], "Fachperson empfohlen");
    default:
      // Kein passendes Anleitungs-Muster: nichts erfinden – erklären und Fachperson empfehlen (was/wo/Test bleiben konkret).
      return mk("Für diesen Punkt empfehlen wir die Umsetzung durch eine Fachperson – er lässt sich nicht zuverlässig in allgemeinen Schritten beschreiben.",
        [`Zeigen Sie einer Fachperson diesen Punkt auf ${page}.`, "Lassen Sie die Ursache prüfen und die kleinstmögliche Korrektur umsetzen."],
        VERIFY_BOTH("Prüfen Sie die betroffene Stelle erneut"), "Fachperson empfohlen");
  }
}

// ---------- Befunde: alle relevanten, belegten Kundenprobleme (Dedupe + Jargon-Gate aus swiss-repair, OHNE 3er-Deckel) ----------
export function buildCheck150Findings(auditIssues = {}, { stackType = "other" } = {}) {
  const raw = Object.values(auditIssues);
  const visible = selectCustomerVisibleFindings(raw, { max: Infinity });
  return visible.map((v, i) => {
    const ref = v.internal_refs?.[0] || {};
    const src = raw.find((x) => x.type === ref.issue_type && x.url === ref.url) || {};
    const finding = {
      finding_id: `F${i + 1}`, key: v.key, severity: v.severity, primary_type: ref.issue_type || null,
      issue_ids: (v.internal_refs || []).map((r) => raw.find((x) => x.type === r.issue_type && x.url === r.url)?.issue_id).filter(Boolean),
      page: src.page || src.url || null, page_label: pageLabel(src.page || src.url || ""), area: src.location || null, label: src.label || null,
      customer_title: v.text, customer_problem: v.text + ".", customer_impact: v.impact,
      location: src.location ? `${pageLabel(src.page || src.url || "")} → Bereich «${src.location}»` : pageLabel(src.page || src.url || ""),
    };
    return { ...finding, ...instructionsFor(finding, stackType) };
  }).sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 }[a.severity] - { critical: 0, high: 1, medium: 2, low: 3 }[b.severity]));
}

// ---------- Kundenbericht (verständlich; Evidence bleibt intern; keine internen IDs/Pfade/Referenzen) ----------
export function buildCheck150Report(order, { now = new Date() } = {}) {
  const f = order.findings || [];
  const count = (s) => f.filter((x) => x.severity === s).length;
  const summary = { total: f.length, critical: count("critical"), high: count("high"), medium: count("medium"), low: count("low") };
  const expert = f.some((x) => x.expert_recommended);
  const lines = [
    "Webseiten-Check & Anleitung",
    "Ergebnis Ihres Webseiten-Checks",
    "",
    ...(order.company ? [`Firma: ${order.company}`] : []),
    `Website: ${order.domain}`,
    `Prüfdatum: ${(order.audit_completed_at || now.toISOString()).slice(0, 10)}`,
    "",
    "Geprüft wurden Ihre Startseite und die von dort verlinkten Unterseiten: Erreichbarkeit, Links, Navigation, Bilder,",
    "Kontaktmöglichkeiten sowie sichtbare Darstellungsfehler – wie ein Besucher mit dem Browser, ohne Eingriff in Ihre Website.",
    "",
    f.length ? `Zusammenfassung: ${summary.total} relevante${summary.total === 1 ? "r Punkt" : " Punkte"} (kritisch ${summary.critical}, hoch ${summary.high}, mittel ${summary.medium}, gering ${summary.low}).`
      : "Zusammenfassung: Beim Check wurden keine relevanten, für Besucher sichtbaren Probleme festgestellt.",
    "",
    ...f.flatMap((x, i) => [
      `PROBLEM ${i + 1} — ${x.customer_title}`,
      `Wo: ${x.location}`,
      `Was Besucher erleben: ${x.customer_impact}`,
      `So beheben Sie es: ${x.fix_summary}`,
      `Aufwand: ${x.difficulty}`,
      "Schritte:",
      ...x.steps.map((s, n) => `${n + 1}. ${s}`),
      "Danach prüfen:",
      ...x.verification_steps.map((s) => `• ${s}`),
      "",
    ]),
    "Die Anleitung basiert auf den beim Webseiten-Check tatsächlich festgestellten Punkten.",
    ...(expert ? ["", `Wenn Sie die Reparaturen nicht selbst durchführen möchten, können wir die im Paket abgedeckten Arbeiten mit «Check & Reparatur» für CHF ${OFFERS.REPAIR_FIX_500.price} übernehmen.`] : []),
  ];
  const text = lines.join("\n");
  return {
    report: { title: "Webseiten-Check & Anleitung", summary, website: order.domain, company: order.company || null,
      generated_at: now.toISOString(), audit_reference: order.order_id,
      findings: f.map(({ finding_id, severity, customer_title, customer_problem, customer_impact, location, fix_summary, steps, verification_steps, difficulty, expert_recommended }) =>
        ({ finding_id, severity, customer_title, customer_problem, customer_impact, location, fix_summary, steps, verification_steps, difficulty, expert_recommended })) },
    text, text_hash: sha(text),
  };
}

// ---------- Gmail-Lieferentwurf (Versand automatisch NACH erfüllter Zahlungsschwelle; sonst bleibt er für Chris) ----------
const MAX_INLINE_REPORT = 5200; // passt in die bestehende 6000-Zeichen-Grenze für Entwürfe
export function buildDeliveryDraft(order, reportText) {
  const f = order.findings || [];
  const top = f.slice(0, 3).map((x) => `• ${x.customer_title}`);
  const inline = reportText.length <= MAX_INLINE_REPORT;
  const body = [
    `Hallo ${order.contact_name || order.company || ""}`.trim(),
    "",
    "vielen Dank für Ihren Auftrag.",
    "",
    `Ich habe Ihre Website ${order.domain} vollständig geprüft.`,
    f.length ? `Dabei habe ich ${f.length} relevante${f.length === 1 ? "n Punkt" : " Punkte"} gefunden.` : "Dabei habe ich keine relevanten, für Besucher sichtbaren Probleme gefunden.",
    ...(top.length ? ["", "Die wichtigsten Punkte sind:", "", ...top] : []),
    "",
    "Im vollständigen Webseiten-Check finden Sie zu jedem Punkt:",
    "- wo das Problem liegt",
    "- was es bewirkt",
    "- wie Sie es beheben können",
    "- eine Schritt-für-Schritt-Anleitung",
    "- wie Sie die Änderung danach prüfen",
    "",
    inline ? reportText : "Den vollständigen Bericht mit allen Anleitungen erhalten Sie im Anhang dieser E-Mail.",
    "",
    "Freundliche Grüsse",
    "Chris",
    "Helvetic Webdesign",
  ].join("\n");
  return { subject: `Ihr Webseiten-Check & Ihre Anleitung – ${order.domain}`, body, inline };
}

// ---------- Engine ----------
export function createCheck150Engine({ dir = WORKER_DIR, store = createStore(dir), gmail = null, auditor = null,
  now = () => new Date(), log = () => {} } = {}) {
  const block = (order, state, reason) => { order.blocked_reason = reason; transition(order, state, reason, now()); return saveOrder(store, order); };

  async function step(order) {
    const t = now();

    if (order.state === "ORDER_RECEIVED" || order.state === "BLOCKED_ORDER_NOT_CONFIRMED") {
      const sale = confirmedCheck150Sale(store, order.domain);
      if (!sale) {
        if (order.state !== "BLOCKED_ORDER_NOT_CONFIRMED") block(order, "BLOCKED_ORDER_NOT_CONFIRMED", "Kein bestätigter CHF-150-Auftrag in sales.json – Cold-Outreach/Interesse genügt nie.");
        return false; // wird bei jedem Lauf erneut geprüft
      }
      order.confirmed = { ...sale, confirmed_at: t.toISOString() };
      order.blocked_reason = null;
      transition(order, "ORDER_CONFIRMED", `Verkauf erfasst (${sale.sale_date})`, t); saveOrder(store, order); return true;
    }

    if (order.state === "ORDER_CONFIRMED" || order.state === "BLOCKED_PAYMENT_NOT_RECEIVED") {
      // ZAHLUNGSSCHWELLE (TF-041): Verkauf != Zahlung. Erst wenn kumulativ mindestens CHF 75 (erste Hälfte, payments.js)
      // tatsächlich als eingegangen verbucht sind, beginnt die bezahlte Leistung. Vorher: kein Audit, kein Bericht,
      // keine Anleitung, keine Liefermail. Wird je Lauf neu geprüft; voided/refunded Zahlungen zählen nicht.
      const sale = confirmedCheck150Sale(store, order.domain);
      if (!sale) { block(order, "BLOCKED_ORDER_NOT_CONFIRMED", "Verkauf nicht mehr bestätigt (z. B. storniert) – Auftrag wartet."); return false; }
      const gate = paymentGateForOrder(store, order);
      if (!gate.satisfied) {
        if (order.state !== "BLOCKED_PAYMENT_NOT_RECEIVED") {
          order.payment = gate;
          block(order, "BLOCKED_PAYMENT_NOT_RECEIVED", `Zahlung ausstehend: CHF ${gate.paid_chf} von mind. CHF ${gate.required_chf} eingegangen (payments.js record ${order.order_id}).`);
        } else if (order.payment?.paid_chf !== gate.paid_chf) { order.payment = gate; order.updated_at = t.toISOString(); saveOrder(store, order); }
        return false; // wird bei jedem Lauf erneut geprüft
      }
      order.payment = gate;
      order.automatic_send_allowed = true; // Schwelle erfüllt → die Service-Mail darf automatisch an den bestätigten Kunden
      order.blocked_reason = null;
      transition(order, "FULL_AUDIT", `Zahlungsschwelle erfüllt (CHF ${gate.paid_chf} ≥ ${gate.required_chf}) – Start vollständiger passiver Check`, t);
      saveOrder(store, order); return true;
    }

    if (order.state === "FULL_AUDIT") {
      const a = await fullSiteAudit(order.website, { auditor, now });
      if (!a.ok) { block(order, "AUDIT_FAILED", "Website beim Check nicht erreichbar."); return false; }
      order.stack = detectStack({ html: a.html || "" });
      const { html, ...slim } = a; // HTML nicht persistieren (Grösse); Stack ist bereits abgeleitet
      order.audit = slim;
      order.audit_completed_at = t.toISOString();
      transition(order, "FINDINGS_ANALYSIS", `Check abgeschlossen: ${Object.keys(a.issues).length} Rohbefunde`, t); saveOrder(store, order); return true;
    }

    if (order.state === "FINDINGS_ANALYSIS") {
      order.findings = buildCheck150Findings(order.audit?.issues || {}, { stackType: order.stack?.type || "other" });
      order.report_findings_count = order.findings.length;
      transition(order, "INSTRUCTIONS_GENERATION", `${order.findings.length} relevante Kundenprobleme`, t); saveOrder(store, order); return true;
    }

    if (order.state === "INSTRUCTIONS_GENERATION") {
      const bad = order.findings.find((f) => !f.fix_summary || !f.steps?.length || !f.verification_steps?.length || !f.customer_impact || !f.location);
      if (bad) { block(order, "REPORT_FAILED", `Anleitung unvollständig (${bad.finding_id}) – nichts wird erfunden.`); return false; }
      transition(order, "CUSTOMER_REPORT_READY", "Anleitungen vollständig", t); saveOrder(store, order); return true;
    }

    if (order.state === "CUSTOMER_REPORT_READY") {
      const built = buildCheck150Report(order, { now: t });
      order.report = built.report;
      order.report_generated_at = t.toISOString();
      // Menschenlesbare Version als Datei im Worker-Verzeichnis (liegt im verschlüsselten Backup; kein externer Dienst).
      try {
        const repDir = path.join(store.dir, "reports");
        fs.mkdirSync(repDir, { recursive: true });
        const file = path.join(repDir, `check150-${order.order_id}.txt`);
        fs.writeFileSync(file, built.text, { mode: 0o600 });
        order.report_text_file = file;
      } catch (e) { log("warn", "check150_report_file_failed", { order_id: order.order_id, error: e.message }); }
      order.report_text_hash = built.text_hash;
      transition(order, "DELIVERY_DRAFT_CREATED", "Bericht erstellt", t); saveOrder(store, order); return true;
    }

    if (order.state === "DELIVERY_DRAFT_CREATED") {
      if (!gmail || typeof gmail.createDraft !== "function") { block(order, "DELIVERY_DRAFT_FAILED", "Gmail nicht verfügbar – Entwurf kann nicht angelegt werden."); return false; }
      // Pro Auftrag höchstens EIN aktiver Lieferentwurf; bei neuem Bericht wird der bestehende aktualisiert, nie verdoppelt.
      if (order.delivery_draft?.draft_id && order.delivery_draft.report_hash === order.report_text_hash) {
        order.delivery_status = "draft_ready";
        transition(order, "DELIVERY_SENDING", "Lieferentwurf bereits vorhanden (gleiche Berichtsversion)", t); saveOrder(store, order); return true;
      }
      const text = order.report_text_file && fs.existsSync(order.report_text_file) ? fs.readFileSync(order.report_text_file, "utf8") : buildCheck150Report(order, { now: t }).text;
      const { subject, body, inline } = buildDeliveryDraft(order, text);
      try {
        if (order.delivery_draft?.draft_id && typeof gmail.updateDraft === "function") {
          await gmail.updateDraft(order.delivery_draft.draft_id, { subject, body });
          order.delivery_draft = { ...order.delivery_draft, report_hash: order.report_text_hash, inline, updated_at: t.toISOString() };
        } else {
          const d = await gmail.createDraft({ to: order.delivery_email, subject, body, messageClass: FULFILLMENT_CLASS });
          order.delivery_draft = { draft_id: d.draftId, to: order.delivery_email, message_class: FULFILLMENT_CLASS,
            report_hash: order.report_text_hash, inline, created_at: t.toISOString() };
          order.delivery_draft_created_at = t.toISOString();
        }
      } catch (e) {
        if (TRANSIENT_RE.test(e.message)) { log("warn", "check150_draft_deferred", { order_id: order.order_id, error: String(e.message).slice(0, 160) }); return false; } // Gmail gestört → nächster Lauf
        block(order, "DELIVERY_DRAFT_FAILED", `Entwurf fehlgeschlagen: ${String(e.message).slice(0, 160)}`); return false;
      }
      order.delivery_status = "draft_ready";
      if (!order.delivery_draft.inline) log("info", "check150_attachment_needed", { order_id: order.order_id, note: "Bericht zu lang für die Mail – Chris hängt die Berichtsdatei beim Senden an." });
      transition(order, "DELIVERY_SENDING", "Gmail-Lieferentwurf bereit – automatischer Versand folgt (Zahlungsschwelle erfüllt)", t); saveOrder(store, order); return true;
    }

    if (order.state === "DELIVERY_SENDING") {
      // Automatischer Versand der Service-E-Mail an den BESTÄTIGTEN Kunden (TF-041) – unmittelbar davor wird fail closed
      // erneut geprüft: Verkauf weiterhin bestätigt (nicht voided) UND Zahlungsschwelle weiterhin erfüllt.
      if (!confirmedCheck150Sale(store, order.domain)) { order.delivery_status = "draft_ready"; block(order, "BLOCKED_ORDER_NOT_CONFIRMED", "Verkauf nicht mehr bestätigt (z. B. storniert) – kein Versand."); return false; }
      const gate = paymentGateForOrder(store, order);
      order.payment = gate;
      if (!gate.satisfied) { order.delivery_status = "draft_ready"; block(order, "BLOCKED_PAYMENT_NOT_RECEIVED", `Zahlungsschwelle nicht mehr erfüllt (CHF ${gate.paid_chf} von mind. CHF ${gate.required_chf}) – kein Versand.`); return false; }
      // Weitere Pflichtbedingungen (fail closed) – jede fehlende Bedingung übergibt den Entwurf an Chris statt zu senden:
      const handOver = (reason) => { order.delivery_status = "draft_ready"; transition(order, "READY_FOR_DELIVERY", reason, t); saveOrder(store, order); return false; };
      if (order.delivery_sent_at) return handOver("Service-Mail wurde bereits gesendet – nie ein zweiter Versand");
      // Send-Idempotenz: ein früherer Versuch ohne gesicherten Ausgang (z. B. Neustart mitten im Versand) wird NIE
      // blind wiederholt – Chris prüft im Gesendet-Ordner, ob die Mail raus ist.
      if (order.delivery_send_attempted_at) return handOver("Versandstatus unklar (früherer Versuch ohne Bestätigung) – kein erneuter Versand, Chris prüft «Gesendet»");
      if (order.offer_class !== CHECK150_OFFER) return handOver("Kein CHF-150-Auftrag – kein automatischer Versand");
      if (!EMAIL_RE.test(String(order.delivery_email || "")) || (order.delivery_draft?.to && order.delivery_draft.to !== order.delivery_email))
        return handOver("Lieferadresse fehlt oder weicht vom Entwurf ab – kein automatischer Versand");
      if (!order.report || !order.report_text_hash || !order.delivery_draft?.draft_id || order.delivery_draft.report_hash !== order.report_text_hash)
        return handOver("Bericht/Berichts-Hash/Entwurf unvollständig – kein automatischer Versand");
      // Bericht zu lang für die Mail → Anhang nötig, den die Gmail-Schicht nicht sicher automatisch anhängen kann:
      // nie eine Mail senden, die einen fehlenden Anhang voraussetzt – fail safe als Entwurf für Chris (ATTACHMENT_REQUIRED).
      if (order.delivery_draft.inline !== true) {
        order.delivery_attachment_required = true;
        return handOver("ATTACHMENT_REQUIRED: Bericht braucht einen Anhang – Chris hängt die Berichtsdatei an und sendet den Entwurf");
      }
      if (!gmail || typeof gmail.sendDraft !== "function") return handOver("Kein automatischer Versandweg verfügbar – Entwurf bleibt für Chris");
      order.delivery_send_attempted_at = t.toISOString();
      saveOrder(store, order); // VOR dem Versand persistieren – ein Absturz danach führt nie zu einem Doppel-Versand
      try { await gmail.sendDraft(order.delivery_draft.draft_id); }
      catch (e) {
        if (TRANSIENT_RE.test(e.message)) { // nächster Lauf
          order.delivery_send_attempted_at = null; saveOrder(store, order);
          log("warn", "check150_send_deferred", { order_id: order.order_id, error: String(e.message).slice(0, 160) }); return false;
        }
        // Dauerhafter Fehler: NIE blind weiterversuchen – Entwurf bleibt fail safe für Chris liegen.
        order.delivery_status = "draft_ready";
        transition(order, "READY_FOR_DELIVERY", `Automatischer Versand fehlgeschlagen (${String(e.message).slice(0, 120)}) – Entwurf bleibt für Chris`, t);
        saveOrder(store, order); return false;
      }
      order.delivery_status = "sent";
      order.delivery_sent_at = t.toISOString();
      order.delivery_message_class = FULFILLMENT_CLASS; // Service-Mail eines bezahlten Auftrags – nie Cold-Outreach
      log("info", "check150_delivery_sent", { order_id: order.order_id });
      transition(order, "COMPLETED", "Service-E-Mail automatisch an den bestätigten Kunden gesendet (Zahlungsschwelle erfüllt)", t);
      saveOrder(store, order); return false;
    }

    return false; // READY_FOR_DELIVERY/terminal: wartet auf completeCheck150()
  }

  async function processAll() {
    const data = store.read(CHECK150_ORDERS_FILE, { schema: 1, orders: {} });
    const open = Object.values(data.orders || {}).filter((o) => !TERMINAL.has(o.state) && !WAITING.has(o.state));
    let advanced = 0;
    for (const stored of open) {
      const order = structuredClone(stored);
      try { for (let guard = 0; guard < 15 && await step(order); guard++) advanced++; }
      catch (e) { log("error", "check150_order_failed", { order_id: order.order_id, state: order.state, error: e.message }); block(order, "MANUAL_REVIEW_REQUIRED", `Unerwarteter Fehler im Zustand ${order.state}: ${e.message}`); }
    }
    const after = store.read(CHECK150_ORDERS_FILE, { schema: 1, orders: {} });
    const states = {};
    for (const o of Object.values(after.orders || {})) states[o.state] = (states[o.state] || 0) + 1;
    return { processed: open.length, advanced, states };
  }
  return { step, processAll };
}

// ---------- Status/Allowlist für Dashboard/Cloud (nie Evidence, nie Draft-Inhalte, nie Pfade) ----------
export function check150Status(dir = WORKER_DIR) {
  const orders = Object.values(createStore(dir).read(CHECK150_ORDERS_FILE, { orders: {} }).orders || {});
  const states = {};
  for (const o of orders) states[o.state] = (states[o.state] || 0) + 1;
  return { total: orders.length, open: orders.filter((o) => !TERMINAL.has(o.state)).length, states,
    ready_for_delivery: states.READY_FOR_DELIVERY || 0, waiting_confirmation: states.BLOCKED_ORDER_NOT_CONFIRMED || 0,
    waiting_payment: states.BLOCKED_PAYMENT_NOT_RECEIVED || 0, cancelled: states[CHECK150_CANCELLED] || 0 };
}
// Kundenphase fürs Dashboard (TF-041) – feste Wörter aus Zustand + Zahlung.
export const CHECK150_PHASES = Object.freeze(["WAITING_FOR_CONFIRMATION", "WAITING_FOR_DEPOSIT", "DEPOSIT_RECEIVED", "AUDITING", "REPORT",
  "READY_FOR_DELIVERY", "SENT", "COMPLETED", "CANCELLED", "BLOCKED"]);
export function check150Phase(o, pay) {
  if (o.state === CHECK150_CANCELLED) return "CANCELLED";
  if (o.state === "COMPLETED") return o.delivery_status === "sent" ? "SENT" : "COMPLETED";
  if (o.state === "READY_FOR_DELIVERY") return "READY_FOR_DELIVERY";
  if (o.state === "BLOCKED_ORDER_NOT_CONFIRMED" || o.state === "ORDER_RECEIVED") return "WAITING_FOR_CONFIRMATION";
  if (o.state === "BLOCKED_PAYMENT_NOT_RECEIVED" || !["DEPOSIT_MET", "PAID_FULL"].includes(pay.payment_status)) return TERMINAL.has(o.state) ? "BLOCKED" : "WAITING_FOR_DEPOSIT";
  if (o.state === "ORDER_CONFIRMED") return "DEPOSIT_RECEIVED";
  if (["FULL_AUDIT", "FINDINGS_ANALYSIS"].includes(o.state)) return "AUDITING";
  if (["INSTRUCTIONS_GENERATION", "CUSTOMER_REPORT_READY", "DELIVERY_DRAFT_CREATED", "DELIVERY_SENDING"].includes(o.state)) return "REPORT";
  return "BLOCKED";
}
export function publicCheck150Orders(dir = WORKER_DIR, { max = 50 } = {}) {
  const store = createStore(dir);
  // Quelle nur als Wort (Direktkunde / Jarvis Lead) – keine technischen internen Daten im Dashboard.
  const records = store.read("sales.json", { records: {} }).records || {};
  const orders = Object.values(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders || {})
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, max)
    .map((o) => {
      const s = o.report?.summary || {};
      const pay = paymentSummary(store, o);
      return { order_id: o.order_id, company: o.company || null, domain: o.domain, offer_class: o.offer_class, price_chf: o.price_chf,
        state: o.state, findings: o.report_findings_count ?? null, critical: s.critical ?? null, high: s.high ?? null, medium: s.medium ?? null, low: s.low ?? null,
        report_available: !!o.report, draft_available: !!o.delivery_draft?.draft_id, delivery_status: o.delivery_status || "none",
        // Zahlungsstand (TF-041): nur Zahlen/Flag/Zustandswort aus dem Ledger – nie Referenzen oder Zahlungsdetails im Dashboard.
        paid_chf: pay.paid_chf, payment_required_chf: pay.deposit_chf, rest_to_deposit_chf: pay.rest_to_deposit_chf,
        payment_status: pay.payment_status, payment_ok: pay.deposit_chf != null && pay.paid_chf >= pay.deposit_chf,
        phase: check150Phase(o, pay),
        source: records[normDomain(o.domain)]?.direct_sale?.source === "direct_customer" ? "direct_customer" : "jarvis_lead",
        created_at: o.created_at, updated_at: o.updated_at };
    });
  return { ...check150Status(dir), orders };
}

// ---------- Worker-Hook (eigenes Lock, No-op ohne offene Aufträge; blockiert weder Mail noch Discovery noch CHF-480) ----------
export async function runCheck150Orders({ dir = WORKER_DIR, gmail = null, log = createLogger(dir) } = {}) {
  const status = check150Status(dir);
  if (!status.open) return { busy: false, processed: 0, advanced: 0, states: status.states };
  if (!acquireLock(dir, { name: "check150.lock" })) return { busy: true };
  try { return { busy: false, ...(await createCheck150Engine({ dir, gmail, log }).processAll()) }; }
  finally { releaseLock(dir, process.pid, "check150.lock"); }
}

// ---------- Kommandozeile ----------
// Zahlung verbuchen (TF-041): node payments.js record <order_id> --amount 75 – erst ab CHF 75 läuft der Auftrag.
// node check-150-workflow.js --list | --show <id> | --create <domain> --email <lieferadresse> [--website URL] [--company NAME]
//                            [--name ANREDE] | --create-confirmed <domain> --email <adresse> [--company] [--name] [--website]
//                            | --cancel <id> [--reason TEXT] | --run | --report <id> | --complete <id>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  const run = async () => {
    if (argv.includes("--list")) { console.log(JSON.stringify(check150Status(), null, 2)); return 0; }
    if (flag("show")) { const o = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders?.[flag("show")]; if (!o) throw new Error("Auftrag nicht gefunden."); console.log(JSON.stringify(o, null, 2)); return 0; }
    if (flag("create-confirmed")) {
      // Direktkunde mit TATSÄCHLICH bestätigtem CHF-150-Auftrag: der bewusste CLI-Aufruf durch Chris ist die betriebliche
      // Bestätigung. Erzeugt intern den Direktverkauf (sales.js recordDirectSale, Quelle direct_customer) und den Auftrag –
      // der Worker bestätigt ihn beim nächsten Lauf über die bestehende Order-Logik (confirmedCheck150Sale).
      const { recordDirectSale, persistMetrics } = await import("./sales.js");
      const domain = flag("create-confirmed");
      const data = store.read("sales.json", { records: {} });
      store.write("sales.json", { records: recordDirectSale(data.records, { domain, offer: CHECK150_OFFER, delivery_email: flag("email"), company: flag("company"), contact_name: flag("name"), website: flag("website"), date: flag("date") }) });
      console.log(`Bestätigter CHF-150-Direktverkauf erfasst: ${normDomain(domain)} (CHF ${OFFERS[CHECK150_OFFER].price}, Quelle: Direktkunde).`);
      try {
        const o = createCheck150Order(store, { domain, website: flag("website"), company: flag("company"), delivery_email: flag("email"), contact_name: flag("name") });
        console.log(`Auftrag angelegt: ${o.order_id} (${o.state}) – der Worker bestätigt ihn automatisch über den erfassten Verkauf.`);
        console.log(`Zahlungsschwelle (TF-041): Start erst ab kumulativ CHF ${paymentThresholdChf(CHECK150_OFFER)} – Zahlung verbuchen: node payments.js record ${o.order_id} --amount ${paymentThresholdChf(CHECK150_OFFER)} --reference Bank`);
      } catch (e) {
        if (!/läuft bereits/.test(e.message)) throw e;
        console.log(`Kein neuer Auftrag: ${e.message} Der erfasste Verkauf bestätigt den bestehenden Auftrag beim nächsten Lauf.`);
      }
      const registry = await import("./gmail.js").then((g) => g.listOwned(), () => ({ sent: {}, drafts: {} }));
      persistMetrics({ registry });
      try { const { reconcileRegistry } = await import("./lead-registry.js"); reconcileRegistry(store, { gmailRegistry: registry, force: true }); } catch {}
      return 0;
    }
    if (flag("cancel")) {
      const o = cancelCheck150Order(store, flag("cancel"), { reason: flag("reason") });
      console.log(`Storniert: ${o.order_id} → ${o.state}${o.cancel_reason ? ` (${o.cancel_reason})` : ""}. Auftrag bleibt gespeichert; keine Gmail-/Website-Aktion.`);
      return 0;
    }
    if (flag("create")) {
      const o = createCheck150Order(store, { domain: flag("create"), website: flag("website"), company: flag("company"), delivery_email: flag("email"), contact_name: flag("name") });
      console.log(`Auftrag angelegt: ${o.order_id} (${o.state}). Bestätigung = erfasster Verkauf: node sales.js sale ${o.domain} REPAIR_CHECK_150`);
      console.log(`Zahlungsschwelle (TF-041): Start erst ab kumulativ CHF ${paymentThresholdChf(CHECK150_OFFER)} – Zahlung verbuchen: node payments.js record ${o.order_id} --amount ${paymentThresholdChf(CHECK150_OFFER)} --reference Bank`);
      return 0;
    }
    if (argv.includes("--run")) { const gmail = await import("./gmail.js"); console.log(JSON.stringify(await runCheck150Orders({ gmail }), null, 2)); return 0; }
    if (flag("report")) { const o = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders?.[flag("report")]; if (!o?.report_text_file || !fs.existsSync(o.report_text_file)) throw new Error("Kein Bericht vorhanden."); console.log(fs.readFileSync(o.report_text_file, "utf8")); return 0; }
    if (flag("complete")) { const o = completeCheck150(store, flag("complete")); console.log(`Abgeschlossen: ${o.order_id} → ${o.state}`); return 0; }
    console.log("Befehle: --list | --show <id> | --create <domain> --email <adresse> | --create-confirmed <domain> --email <adresse> | --cancel <id> [--reason TEXT] | --run | --report <id> | --complete <id>");
    return 1;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
