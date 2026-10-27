// TF-028 – datenbelegte Abschlussartefakte.
// Dieses Modul erzeugt keine Zahlungs- oder Versandfreigabe aus UI-Daten. Es liest
// ausschließlich den persistenten Auftrag, das lokale Provider-Profil und den Ledger.
import crypto from "node:crypto";
import PDFDocument from "pdfkit";
import { offerInfo } from "./pricing.js";
import { paymentAmount, paymentCurrency, paymentSummary, paymentsForOrder, isTestPayment } from "./payments.js";

export const RECEIPT_READY = "READY";
export const MANUAL_REVIEW_REQUIRED = "MANUAL_REVIEW_REQUIRED";
export const PARTIAL_PAYMENT = "PARTIAL_PAYMENT";
export const PAYMENT_REQUIRED = "PAYMENT_REQUIRED";

const RECEIPT_OFFER = "REPAIR_CHECK_150";
const REPAIR_RECEIPT_OFFER = "REPAIR_FIX_500";
const REPAIR_RECEIPT_AMOUNT = 480;
const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const clean = (value, max = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const iso = (value) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

function configuredProviderProfile(store, providerProfile) {
  if (providerProfile && typeof providerProfile === "object") return providerProfile;
  const cfg = store?.read?.("config.json", {}) || {};
  return cfg.business_profile && typeof cfg.business_profile === "object" ? cfg.business_profile : null;
}

function addressOf(profile) {
  const a = profile?.address;
  if (!a || typeof a !== "object") return null;
  const address = {
    street: clean(a.street, 120), postal_code: clean(a.postal_code, 20),
    city: clean(a.city, 80), country: clean(a.country, 60),
  };
  return Object.values(address).every(Boolean) ? address : null;
}

function orderOf(store, orderOrId) {
  if (orderOrId && typeof orderOrId === "object") return orderOrId;
  const id = String(orderOrId || "");
  return store?.read?.("check150_orders.json", { orders: {} })?.orders?.[id] || null;
}

function repairOrderOf(store, orderOrId) {
  if (orderOrId && typeof orderOrId === "object") return orderOrId;
  const id = String(orderOrId || "");
  return store?.read?.("repair_orders.json", { orders: {} })?.orders?.[id] || null;
}

function paymentFacts(store, order) {
  const info = offerInfo(order?.offer_class);
  const summary = paymentSummary(store, order || {});
  const payments = paymentsForOrder(store, order?.order_id).filter((p) => p.status === "RECEIVED");
  const mode = order?.test_order === true ? "TEST" : "LIVE";
  const modePayments = payments.filter((p) => (isTestPayment(p) ? "TEST" : "LIVE") === mode);
  const currencies = modePayments.map(paymentCurrency);
  const currencyOk = !!info && info.currency === "CHF" && currencies.every((c) => c === "CHF");
  const paid = currencyOk ? Number(summary.paid_amount || 0) : 0;
  const paymentDate = modePayments.map((p) => iso(p.received_at)).filter(Boolean).sort().at(-1) || null;
  return { info, summary, mode, modePayments, paid, paymentDate, currencyOk };
}

function readinessFor(store, order, { now = new Date(), providerProfile = null } = {}) {
  const profile = configuredProviderProfile(store, providerProfile);
  const address = addressOf(profile);
  const { info, summary, modePayments, paid, paymentDate, currencyOk } = paymentFacts(store, order);
  const reasons = [];
  if (!order || order.offer_class !== RECEIPT_OFFER || !order.order_id) reasons.push("CHF-150-Auftrag fehlt oder ist ungültig.");
  if (!clean(order?.company) && !clean(order?.contact_name)) reasons.push("Kundenname fehlt.");
  if (!address) reasons.push("Gültige Geschäftsadresse von Helvetic Webdesign fehlt.");
  if (!info || info.currency !== "CHF") reasons.push("Quittung ist nur für das CHF-150-Angebot zulässig.");
  if (!currencyOk) reasons.push("Zahlungswährung oder Zahlungsmodus stimmt nicht mit dem Auftrag überein.");
  if (!paymentDate) reasons.push("Verifiziertes Zahlungsdatum fehlt.");
  if (!modePayments.length) reasons.push("Keine verifizierte Zahlung im passenden Modus vorhanden.");
  const status = reasons.length ? MANUAL_REVIEW_REQUIRED
    : paid >= 150 ? RECEIPT_READY
      : paid > 0 ? PARTIAL_PAYMENT : PAYMENT_REQUIRED;
  return {
    status, reasons, profile, address, now: new Date(now).toISOString(),
    paid_amount_chf: paid, open_amount_chf: Math.max(0, 150 - paid),
    payment_date: paymentDate, payment_ids: modePayments.map((p) => p.payment_id),
    payment_status: summary.payment_status, fully_paid: status === RECEIPT_READY && paid === 150,
  };
}

export function receiptReadiness(store, order, opts = {}) {
  return readinessFor(store, orderOf(store, order), opts);
}

function receiptNumber(order, facts) {
  return `QR-${new Date(facts.payment_date || facts.now).toISOString().slice(0, 10).replace(/-/g, "")}-${sha(`${order.order_id}|${facts.payment_ids.join(",")}|${facts.paid_amount_chf}`).slice(0, 10).toUpperCase()}`;
}

function receiptText(order, facts) {
  const customer = clean(order.company) || clean(order.contact_name);
  const statusLine = facts.fully_paid ? "Zahlungsstatus: Vollständig bezahlt" : "Zahlungsstatus: Zahlungsbestätigung – Teilzahlung";
  return [
    facts.fully_paid ? "ZAHLUNGSQUITTUNG" : "ZAHLUNGSBESTÄTIGUNG",
    "",
    "Leistungserbringer: Helvetic Webdesign",
    "Inhaber: Christoph Kälin",
    `Geschäftsadresse: ${facts.address.street}, ${facts.address.postal_code} ${facts.address.city}, ${facts.address.country}`,
    "",
    `Kunde: ${customer}`,
    `Quittungsnummer: ${facts.receipt_number}`,
    `Ausstellungsdatum: ${facts.issued_at.slice(0, 10)}`,
    `Zahlungsdatum: ${facts.payment_date ? facts.payment_date.slice(0, 10) : "–"}`,
    "",
    "Leistung: Webseiten-Check & Anleitung",
    "",
    "Gesamtbetrag: CHF 150.00",
    "Mehrwertsteuer: Nicht erhoben – Helvetic Webdesign ist nicht mehrwertsteuerpflichtig.",
    "Hinweis: Nicht mehrwertsteuerpflichtig – keine MWST erhoben.",
    `Bezahlter Betrag: CHF ${facts.paid_amount_chf.toFixed(2)}`,
    `Offener Betrag: CHF ${facts.open_amount_chf.toFixed(2)}`,
    statusLine,
    "",
    "Vielen Dank für Ihren Auftrag.",
    "",
    "Helvetic Webdesign",
    "Christoph Kälin",
  ].join("\n");
}

export function buildCheck150Receipt(store, orderId, { now = new Date(), providerProfile = null } = {}) {
  const order = orderOf(store, orderId);
  const ready = readinessFor(store, order, { now, providerProfile });
  const issuedAt = new Date(now).toISOString();
  const base = {
    type: "check150_receipt", status: ready.status, reasons: ready.reasons,
    order_id: order?.order_id || String(orderId || ""), title: ready.fully_paid ? "ZAHLUNGSQUITTUNG" : "ZAHLUNGSBESTÄTIGUNG",
    issued_at: issuedAt, payment_date: ready.payment_date, paid_amount_chf: ready.paid_amount_chf,
    open_amount_chf: ready.open_amount_chf, fully_paid: ready.fully_paid, text: "",
  };
  if (!order || !ready.address) return { ...base, receipt_number: null };
  const facts = { ...ready, issued_at: issuedAt, receipt_number: receiptNumber(order, { ...ready, now: issuedAt }) };
  return { ...base, receipt_number: facts.receipt_number, text: receiptText(order, facts) };
}

function repairPaymentFacts(store, order) {
  const info = offerInfo(order?.offer_class);
  const summary = paymentSummary(store, order || {});
  const mode = order?.test_order === true ? "TEST" : "LIVE";
  const payments = paymentsForOrder(store, order?.order_id).filter((p) => p.status === "RECEIVED");
  const modePayments = payments.filter((p) => (isTestPayment(p) ? "TEST" : "LIVE") === mode);
  const currencies = modePayments.map(paymentCurrency);
  const currencyOk = !!info && info.currency === "CHF" && currencies.length > 0 && currencies.every((c) => c === "CHF");
  const paid = currencyOk ? Number(summary.paid_amount || 0) : 0;
  const paymentDate = modePayments.map((p) => iso(p.received_at)).filter(Boolean).sort().at(-1) || null;
  return { info, summary, mode, modePayments, paid, paymentDate, currencyOk };
}

function repairReceiptReadiness(store, order, { now = new Date(), providerProfile = null } = {}) {
  const profile = configuredProviderProfile(store, providerProfile);
  const address = addressOf(profile);
  const { info, summary, modePayments, paid, paymentDate, currencyOk } = repairPaymentFacts(store, order);
  const reasons = [];
  if (!order || order.offer_class !== REPAIR_RECEIPT_OFFER || !order.order_id) reasons.push("CHF-480-Auftrag fehlt oder ist ungültig.");
  if (!clean(order?.company) && !clean(order?.contact_name)) reasons.push("Kundenname fehlt.");
  if (!address) reasons.push("Gültige Geschäftsadresse von Helvetic Webdesign fehlt.");
  if (!info || info.currency !== "CHF" || info.price !== REPAIR_RECEIPT_AMOUNT) reasons.push("Quittung ist nur für das CHF-480-Angebot zulässig.");
  if (!currencyOk) reasons.push("Zahlungswährung oder Zahlungsmodus stimmt nicht mit dem Auftrag überein.");
  if (!paymentDate) reasons.push("Verifiziertes Zahlungsdatum fehlt.");
  if (!modePayments.length) reasons.push("Keine verifizierte Zahlung im passenden Modus vorhanden.");
  if (!reasons.length && paid > REPAIR_RECEIPT_AMOUNT) reasons.push("Verifizierter Zahlungsbetrag weicht vom CHF-480-Auftrag ab.");
  const status = reasons.length ? MANUAL_REVIEW_REQUIRED
    : paid === REPAIR_RECEIPT_AMOUNT ? RECEIPT_READY
      : paid > 0 ? PARTIAL_PAYMENT : PAYMENT_REQUIRED;
  return {
    status, reasons, profile, address, now: new Date(now).toISOString(), paid_amount_chf: paid,
    open_amount_chf: Math.max(0, REPAIR_RECEIPT_AMOUNT - paid), payment_date: paymentDate,
    payment_ids: modePayments.map((p) => p.payment_id), payment_status: summary.payment_status,
    fully_paid: status === RECEIPT_READY && paid === REPAIR_RECEIPT_AMOUNT,
  };
}

function repairReceiptNumber(order, facts) {
  return `QR480-${new Date(facts.payment_date || facts.now).toISOString().slice(0, 10).replace(/-/g, "")}-${sha(`${order.order_id}|${facts.payment_ids.join(",")}|${facts.paid_amount_chf}`).slice(0, 10).toUpperCase()}`;
}

function repairReceiptText(order, facts) {
  const customer = clean(order.company) || clean(order.contact_name);
  return [
    "ZAHLUNGSQUITTUNG",
    "",
    "Leistungserbringer: Helvetic Webdesign",
    "Inhaber: Christoph Kälin",
    `Geschäftsadresse: ${facts.address.street}, ${facts.address.postal_code} ${facts.address.city}, ${facts.address.country}`,
    "",
    `Kunde: ${customer}`,
    `Quittungsnummer: ${facts.receipt_number}`,
    `Ausstellungsdatum: ${facts.issued_at.slice(0, 10)}`,
    `Zahlungsdatum: ${facts.payment_date.slice(0, 10)}`,
    "",
    "Leistung: Webseiten-Check & Reparatur",
    "",
    "Gesamtbetrag: CHF 480.00",
    "Mehrwertsteuer: Nicht erhoben – Helvetic Webdesign ist nicht mehrwertsteuerpflichtig.",
    "Hinweis: Nicht mehrwertsteuerpflichtig – keine MWST erhoben.",
    `Bezahlter Betrag: CHF ${facts.paid_amount_chf.toFixed(2)}`,
    "Offener Betrag: CHF 0.00",
    "Zahlungsstatus: Vollständig bezahlt",
    "",
    "Vielen Dank für Ihren Auftrag.",
    "",
    "Helvetic Webdesign",
    "Christoph Kälin",
  ].join("\n");
}

function renderReceiptPdf(text) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, info: { Title: "Zahlungsquittung – Webseiten-Check & Reparatur", Author: "Helvetic Webdesign" } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font("Helvetica").fontSize(11).text(text, { width: 495, lineGap: 4 });
    doc.end();
  });
}

export async function buildRepairReceipt(store, orderId, { now = new Date(), providerProfile = null } = {}) {
  const order = repairOrderOf(store, orderId);
  const ready = repairReceiptReadiness(store, order, { now, providerProfile });
  const base = {
    type: "repair480_receipt", offer_class: REPAIR_RECEIPT_OFFER, status: ready.status, reasons: ready.reasons,
    order_id: order?.order_id || String(orderId || ""), title: "ZAHLUNGSQUITTUNG", issued_at: ready.now,
    payment_date: ready.payment_date, paid_amount_chf: ready.paid_amount_chf, open_amount_chf: ready.open_amount_chf,
    fully_paid: ready.fully_paid, receipt_number: null, text: "", pdf: null, attachment: null,
  };
  if (ready.status !== RECEIPT_READY || !order || !ready.address) return base;
  const facts = { ...ready, issued_at: ready.now, receipt_number: repairReceiptNumber(order, ready) };
  const text = repairReceiptText(order, facts);
  const pdf = await renderReceiptPdf(text);
  return {
    ...base, receipt_number: facts.receipt_number, text, pdf,
    attachment: { filename: `quittung-${facts.receipt_number}.pdf`, mimeType: "application/pdf", content: pdf },
  };
}

const findingText = (value) => clean(value, 1200) || "Nicht dokumentiert";
const findingSteps = (value) => Array.isArray(value) ? value.map((s) => clean(s, 1000)).filter(Boolean) : [];

function findingBlock(finding, number) {
  const steps = findingSteps(finding.steps);
  const checks = findingSteps(finding.verification_steps);
  return [
    `### PROBLEM ${number} – ${findingText(finding.customer_title || finding.title)}`,
    "",
    "**Wo:**",
    findingText(finding.location || finding.page_label || finding.page),
    "",
    "**Was Besucher erleben:**",
    findingText(finding.customer_impact || finding.customer_problem),
    "",
    "**So beheben Sie es:**",
    findingText(finding.fix_summary),
    "",
    "**Aufwand:**",
    findingText(finding.difficulty),
    "",
    "**Schritt-für-Schritt-Anleitung:**",
    "",
    ...(steps.length ? steps.map((step, index) => `${index + 1}. ${step}`) : ["1. Keine dokumentierten Reparaturschritte vorhanden."]),
    "",
    "**Danach prüfen:**",
    "",
    ...(checks.length ? checks.map((step) => `- ${step}`) : ["- Keine dokumentierten Prüfschritte vorhanden."]),
  ].join("\n");
}

export function buildCheck150CompletionReport(order = {}, { now = new Date() } = {}) {
  const findings = Array.isArray(order.findings) ? order.findings : [];
  const count = (severity) => findings.filter((finding) => finding.severity === severity).length;
  const summary = { total: findings.length, critical: count("critical"), high: count("high"), medium: count("medium"), low: count("low") };
  const date = (order.audit_completed_at || now.toISOString()).slice(0, 10);
  const blocks = findings.map((finding, index) => findingBlock(finding, index + 1));
  const text = [
    "# Webseiten-Check & Anleitung",
    "",
    "## Ergebnis Ihres Webseiten-Checks",
    "",
    `**Firma:** ${findingText(order.company || order.contact_name)}`,
    `**Website:** ${findingText(order.domain)}`,
    `**Prüfdatum:** ${date}`,
    "",
    "---",
    "",
    "## 1. Umfang der Prüfung",
    "",
    "Geprüft wurden Ihre Startseite und die von dort verlinkten Unterseiten: Erreichbarkeit, Links, Navigation, Bilder, Kontaktmöglichkeiten sowie sichtbare Darstellungsprobleme – wie ein Besucher im Browser, ohne Eingriff in Ihre Website, das sehen würde.",
    "",
    "---",
    "",
    "## 2. Zusammenfassung",
    "",
    `**Anzahl festgestellter Probleme: ${summary.total}**`,
    "",
    `- Kritische Probleme: ${summary.critical}`,
    `- Probleme mit hoher Priorität: ${summary.high}`,
    `- Probleme mit mittlerer Priorität: ${summary.medium}`,
    `- Probleme mit geringer Priorität: ${summary.low}`,
    "",
    "---",
    "",
    "## 3. Festgestellte Probleme und Reparaturanleitungen",
    "",
    ...(blocks.length ? blocks.flatMap((block) => [block, "", "---", ""]) : ["Beim Webseiten-Check wurden keine relevanten Probleme festgestellt.", ""]),
    "## 4. Abschliessender Hinweis",
    "",
    "Die Anleitung basiert auf den beim Webseiten-Check tatsächlich festgestellten Punkten.",
  ].join("\n");
  return { report: { title: "Webseiten-Check & Anleitung", summary, website: order.domain || null, company: order.company || order.contact_name || null,
    generated_at: new Date(now).toISOString(), findings: findings.map((finding, index) => ({ ...finding, number: index + 1 })) },
  summary, text, text_hash: sha(text), complete: !!order.domain && !!(order.company || order.contact_name) && findings.every((finding) => finding.customer_title || finding.title) };
}

function checkoutLinkOf(value) {
  const link = typeof value === "string" ? value : value?.url;
  return /^https:\/\/checkout\.stripe\.com\/[A-Za-z0-9._/?=&%-]{8,700}$/.test(String(link || "")) ? String(link) : null;
}

export function buildCheck150CompletionMail(store, order, { now = new Date(), report = null, receipt = null, upgradeLink = null, upgrade = null, providerProfile = null } = {}) {
  const actualOrder = orderOf(store, order);
  const actualReceipt = receipt || (actualOrder ? buildCheck150Receipt(store, actualOrder.order_id, { now, providerProfile }) : null);
  const actualReport = report || buildCheck150CompletionReport(actualOrder || {}, { now });
  const link = checkoutLinkOf(upgradeLink || upgrade);
  const reasons = [
    ...(actualReceipt?.status !== RECEIPT_READY || !actualReceipt?.fully_paid ? ["Vollständige CHF-150-Quittung fehlt."] : []),
    ...(actualReport?.complete !== true ? ["Prüfbericht ist unvollständig."] : []),
    ...(!link ? ["Persönlich zugeordneter CHF-330-Upgrade-Link fehlt."] : []),
  ];
  if (reasons.length) return { status: MANUAL_REVIEW_REQUIRED, reasons, receipt: actualReceipt, report: actualReport, subject: null, body: "" };
  const f = actualReport.summary;
  const body = [
    actualReport.text,
    "",
    "## 5. Optionales Reparaturangebot",
    "",
    "Möchten Sie die Reparaturen nicht selbst durchführen, übernehmen wir gerne die im Paket «Check & Reparatur» enthaltenen Arbeiten für einen Aufpreis von **CHF 330** auf Ihr bereits erworbenes Paket.",
    "",
    `Zahlungslink: ${link}`,
    "",
    "## 6. Quittung",
    "",
    actualReceipt.text,
    "",
    "---",
    "",
    "Hiermit verabschiede ich mich und wünsche Ihnen noch einen schönen Tag und viel Erfolg!",
    "",
    "**Helvetic Webdesign**",
    "Webseiten-Service",
    "",
    "Christoph Kälin",
  ].join("\n");
  return { status: RECEIPT_READY, reasons: [], receipt: actualReceipt, report: actualReport,
    summary: f, subject: `Ihr Webseiten-Check & Ihre Anleitung – ${actualOrder.domain}`, body, upgrade_link: link };
}

const REPAIR_READY_STATES = new Set(["READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"]);
const REPAIR_WORK_STATES = new Set(["BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST"]);

const durationValue = (value, fallback) => clean(value, 120) || fallback;

export function buildProcessingDurationEstimate(order = {}, { estimates = {} } = {}) {
  const complete = REPAIR_READY_STATES.has(order.state) || order.completion?.kind === "FULL";
  const accessReceived = order.offer_class === REPAIR_RECEIPT_OFFER
    ? order.access_intake?.status === "RECEIVED" || order.access?.status === "RECEIVED" || order.access?.ok === true
    : true;
  const configured = { ...(order.processing_estimate || {}), ...(estimates || {}) };
  const phases = {
    customer_access: complete || accessReceived ? "abgeschlossen – notwendiger Zugang liegt vor." : order.offer_class === RECEIPT_OFFER
      ? "entfällt – für den Webseiten-Check ist kein Kundenzugang erforderlich."
      : "offen – abhängig vom Eingang und der Prüfung des sicheren Kundenzugangs.",
    technical_work: complete ? "abgeschlossen." : REPAIR_WORK_STATES.has(order.state)
      ? "läuft – Abschluss nach erfolgreicher technischer Prüfung."
      : `voraussichtlich ${durationValue(configured.technical_work, "1–3 Werktage")} nach erfülltem Zugang/Start (unverbindlich).`,
    quality_control: complete ? "abgeschlossen – technische Verifikation und Qualitätskontrolle liegen vor." : `anschliessend ${durationValue(configured.quality_control, "0–1 Werktag")} (unverbindlich).`,
    completion_delivery: complete || order.delivery?.sent_at || order.delivery_sent_at ? "abgeschlossen – Abschluss und Zustellung erfolgt." : `danach ${durationValue(configured.completion_delivery, "innerhalb 1 Werktags")} (unverbindlich).`,
  };
  return { phases, text: ["Voraussichtliche Bearbeitungsdauer (unverbindlich):", `- Wartezeit auf notwendige Kundenzugänge: ${phases.customer_access}`, `- Technische Bearbeitung: ${phases.technical_work}`, `- Qualitätskontrolle: ${phases.quality_control}`, `- Abschluss und Zustellung: ${phases.completion_delivery}`].join("\n") };
}

export function buildRepairCompletionMail(order = {}, { receipt = null, allowInternalTestWithoutReceipt = false } = {}) {
  const issues = Object.values(order.issues || {}).filter((issue) => issue && typeof issue === "object");
  const plan = new Map((order.plan || []).filter((item) => item?.issue_id).map((item) => [item.issue_id, item]));
  const reasons = [];
  const internalTest = allowInternalTestWithoutReceipt === true
    && order?.test_kind === "INTERNAL_ADMIN_TEST"
    && order?.payment_waiver?.reason === "INTERNAL_ADMIN_TEST";
  if (!internalTest && (!receipt || receipt.status !== RECEIPT_READY || receipt.fully_paid !== true || receipt.paid_amount_chf !== REPAIR_RECEIPT_AMOUNT
    || !receipt.pdf || !receipt.attachment || receipt.attachment.mimeType !== "application/pdf" || receipt.attachment.content !== receipt.pdf
    || receipt.order_id !== order.order_id || receipt.offer_class !== REPAIR_RECEIPT_OFFER))
    reasons.push("Verifizierte CHF-480-PDF-Quittung fehlt.");
  if (!REPAIR_READY_STATES.has(order.state) && order.completion?.kind !== "FULL") reasons.push("Reparatur ist noch nicht im verifizierten Abschlusszustand.");
  if (order.completion?.kind === "WITH_MANUAL_ITEMS" || issues.some((issue) => issue.repair_status !== "repaired")) reasons.push("Mindestens ein dokumentiertes Problem ist nicht vollständig repariert und verifiziert.");
  const rows = issues.map((issue, index) => {
    const problem = clean(issue.customer_text || issue.customer_title || issue.customer_problem, 1200);
    const solution = clean(issue.solution_summary || issue.solution || plan.get(issue.issue_id)?.planned_change, 1200);
    if (!problem) reasons.push(`Problem ${index + 1} ist nicht kundenverständlich dokumentiert.`);
    if (!solution) reasons.push(`Lösung zu Problem ${index + 1} ist nicht als tatsächlich ausgeführt dokumentiert.`);
    return { problem: problem || "Nicht dokumentiert", solution: solution || "Nicht dokumentiert" };
  });
  if (!clean(order.contact_name || order.company)) reasons.push("Kundenname fehlt.");
  if (!clean(order.website || order.domain)) reasons.push("Website fehlt.");
  if (reasons.length) return { status: MANUAL_REVIEW_REQUIRED, reasons, subject: null, body: "", inline: false };
  const customer = clean(order.contact_name || order.company);
  const website = clean(order.domain || order.website);
  const body = [
    `Guten Tag ${customer}`,
    "",
    "vielen Dank für Ihren Auftrag.",
    "",
    `Ich habe Ihre Website ${website} vollständig geprüft.`,
    "",
    `Dabei habe ich ${rows.length} relevante${rows.length === 1 ? "n Punkt" : " Punkte"} gefunden.`,
    "",
    "Folgende Probleme konnten eruiert werden:",
    "",
    ...(rows.length ? rows.map((row) => `• ${row.problem}`) : ["• Keine relevanten Probleme dokumentiert."]),
    "",
    "________________________________________________________________________________",
    "",
    "So haben wir die zuvor präsenten Probleme gelöst:",
    "",
    ...(rows.length ? rows.map((row) => `• ${row.solution}`) : ["• Es waren keine Reparaturen erforderlich."]),
    "",
    "Freundliche Grüsse",
    "",
    "Christoph Kälin",
    "Helvetic Webdesign",
  ].join("\n");
  return { status: RECEIPT_READY, reasons: [], subject: `Ihre Website-Reparatur ${order.domain} – Abschlussbericht`, body,
    inline: body.length <= 5800, problem_count: rows.length, problems: rows.map((row) => row.problem), solutions: rows.map((row) => row.solution), receipt,
    attachments: receipt?.attachment ? [receipt.attachment] : [] };
}
