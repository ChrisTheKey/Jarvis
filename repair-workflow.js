// CHECK & REPARATUR (CHF 480) — Autopilot (TF-035) + ZAHLUNGSSCHWELLE (TF-041). Persistenter Reparatur-Workflow für
// BEZAHLTE, vom Kunden ausdrücklich freigegebene Aufträge: AUFTRAG → AUTORISIERUNG → ZAHLUNG → ZUGANG → BACKUP →
// VOLL-AUDIT → PLAN → REPARATUR → VALIDIERUNG → RETEST → BEREIT → ERLEDIGT. Jeder Zustand liegt atomar in
// repair_orders.json und wird nach einem VPS-/Worker-Neustart dort fortgesetzt.
//
// Harte Regeln (fail closed, keine Ausnahme):
//   - Ohne customer_authorized_repair = true UND exakt übereinstimmende Domain wird NIE etwas verändert – nur ein passiver
//     Audit, Status AUTHORIZATION_REQUIRED. Cold-Outreach (Entwurf, Antwort „interessant“) ist NIE eine Reparaturfreigabe.
//   - VERKAUF != ZAHLUNG (TF-041): erst wenn kumulativ mindestens CHF 240 (erste Hälfte des Festpreises, payments.js,
//     an die ORDER_ID gebunden) tatsächlich als eingegangen verbucht sind, sendet Jarvis GENAU EINE Service-Mail
//     CUSTOMER_ACCESS_REQUEST an die verifizierte Kundenadresse – mit einem auftragsgebundenen One-Time-Link (access-intake.js,
//     72 h, nur sha256(token) gespeichert). Passwörter werden NIE per E-Mail erfragt. Vor CHF 240: KEINE Zugangs-Anfrage,
//     KEIN Login, KEIN Intake, KEINE Website-Änderung, KEINE Reparatur (je Lauf neu geprüft; voided/refunded zählen nicht).
//   - ZAHLUNG IST KEINE FREIGABE: die Reparaturfreigabe kommt separat (authorizeRepair durch Chris oder die Pflicht-Zustimmung
//     im sicheren Formular, source secure_order_access_form). Start der Reparatur nur mit Zahlung ≥ CHF 240 UND Freigabe UND
//     sicherem Zugang UND erfolgreicher Zugangsprüfung UND Backup + Rollback-Punkt; order.domain, authorized_domain und die
//     Domain des Zugangs müssen exakt übereinstimmen. Fällt die Zahlung später unter die Schwelle: vor jeder Änderung →
//     PAYMENT_REQUIRED (wartet); nach einer Änderung → PAYMENT_REVIEW_REQUIRED (nie automatischer Rollback, Chris entscheidet).
//   - Zugangsdaten liegen nur verschlüsselt im Tresor des VPS (access-intake.js), werden nur im Speicher für den Adapter
//     entschlüsselt und nach COMPLETED/CANCELLED zerstört; am Auftrag stehen nur Metadaten.
//   - Änderungen laufen nur über einen Stack-Adapter mit sicherem, bereits konfiguriertem Zugang (Secrets NIE in dieser Datei,
//     NIE im Order-JSON, NIE im Bericht). Kein Adapter/Zugang → BLOCKED_NO_ACCESS; unbekannter Stack → BLOCKED_UNSUPPORTED_STACK.
//   - Vor jeder Änderung: Produktionsstand erfasst + Backup + Rollback-Punkt + Reparatur-Branch repair/<order-id>. Fehlt etwas →
//     MANUAL_REVIEW_REQUIRED, nichts wird angefasst. Nie blind auf main/Production.
//   - MINIMAL SAFE FIX: nur Befunde mit eindeutiger Ursache, innerhalb des CHF-480-Pakets, nie Design/Texte/Branding.
//     Geschützte Inhalte (Impressum, Datenschutz, AGB, Preise, Zahlung, DNS, Kundendaten …) nie automatisch → MANUAL_REVIEW_REQUIRED.
//   - Nach der Reparatur: Validierung + Regression (VORHER gegen NACHHER). Neue relevante Probleme → Rollback, nie „erfolgreich“.
//   - Mails dieses Moduls: die Zugangs-Anfrage und (TF-043) die Host-Key-Bestätigung – beide als Service-Klasse
//     CUSTOMER_ACCESS_REQUEST über das injizierte gmail-Objekt, je genau einmal, nur mit One-Time-Link. Der Abschlussbericht
//     wird nur gespeichert – Versand entscheidet Chris.
//   - AUTOMATISCHES ZUGANGSPROFIL (TF-043): nach erhaltenem Zugang erzeugt der Preflight (repair-adapters/profile-builder.js) das
//     Zugangsprofil selbst – nur lesend, nur bei eindeutigem Ergebnis (PROFILE_READY). Unbekannter SSH-Host-Key → nie vertrauen,
//     Kunde bestätigt über einen sicheren Link (HOST_KEY_CONFIRMATION_REQUIRED); unklarer Webroot → WAITING_FOR_ACCESS_PROFILE
//     (Chris ergänzt das Profil, der Auftrag läuft danach selbst weiter). Nie raten, nie schreiben vor PROFILE_READY.
//   - BROWSER-GATE (TF-045): vor der ersten Änderung entsteht eine Browser-Baseline (Chromium, Desktop 1440×900 + Smartphone
//     390×844) der betroffenen Seiten; nach der Reparatur prüft derselbe echte Browser Laden, Navigation, Bilder, Overflow,
//     JS-/Console-Fehler, Netzwerkfehler und den reparierten Befund (repair-browser-validator.js, nur passiv). Regression MEDIUM/HIGH
//     → Rollback → Browser-Retest → REPAIR_FAILED (bzw. MANUAL_REVIEW_REQUIRED + Chris, wenn der Ausgangszustand nicht bestätigt ist).
//     Nicht eindeutig → MANUAL_REVIEW_REQUIRED. Ohne verfügbaren Browser: fail closed (keine Reparatur bzw. kein Abschluss).
//     COMPLETED nur mit Adapter-Validierung UND HTTP-Retest UND Desktop- UND Mobile-Browser-Gate (completionGate).
//   - KUNDENLIEFERUNG (TF-046): im Produktivbetrieb (runRepairOrders, autoDeliver) geht der Abschlussbericht nach bestandenem
//     Abschluss-Gate GENAU EINMAL als Service-Mail CUSTOMER_ORDER_FULFILLMENT an die verifizierte Kundenadresse (Draft-ID und
//     Sendeversuch vor dem Versand persistiert – ein Neustart sendet nie doppelt, unklarer Ausgang wird nie wiederholt). Erst danach
//     COMPLETED + Tresor zerstört. Bericht zu lang (Anhang nötig), Bericht mit unzulässigem Inhalt oder kein Versandweg → bleibt
//     READY_FOR_DELIVERY für Chris (completeOrder). Nie eine Erfolgsmail nach REPAIR_FAILED/MANUAL_REVIEW/PAYMENT_REVIEW.
//   - ABSCHLUSS MIT MANUELLEN PUNKTEN (TF-055): bleibt nach bestandenem Abschluss-Gate mindestens ein relevanter Befund offen
//     (geschützter Inhalt wie AGB/Datenschutz/Preise/Zahlung/Impressum, bewusst nicht automatisch repariert, Ursache unklar, Schweregrad
//     ≥ medium), endet der Auftrag in COMPLETED_WITH_MANUAL_ITEMS – nie in COMPLETED. Bericht/Liefermail sagen dann: «Die automatisch
//     reparierbaren Probleme wurden behoben. Weitere Punkte erfordern eine manuelle Prüfung.» – nie «vollständig repariert».
//   - CRM-SYNC (TF-055): nach bestandenem Retest schreibt writeRepairFindingsExport den Stand je Domain (behoben = RESOLVED, offen =
//     manuell) als repair_findings.json für das CRM – nur normalisierte Befunde, keine Kundendaten, Referenzen oder Secrets.
//   - KEIN WEBSITE-PAKET (TF-062): die reparierte Website bleibt live beim Kunden; nach bestandenem Abschluss-Gate folgen direkt
//     Abschluss + Bericht (READY_FOR_DELIVERY). Kein ZIP/Webroot-Export. Backup vor der ersten Änderung + Rollback bleiben Pflicht.
//   - BESTÄTIGTER AUFTRAG (TF-046): createConfirmedRepairOrder erfasst Direktverkauf (sales.json) + Auftrag in einem Schritt. Ein
//     stornierter (voided) CHF-480-Verkauf stoppt den Auftrag sofort: keine Zugangs-Anfrage, keine Reparatur, keine Lieferung.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WORKER_DIR, createStore, createLogger, acquireLock, releaseLock } from "./mail-worker.js";
import { OFFERS, isVoidedSale, recordDirectSale } from "./sales.js";
import { paymentGateForOrder, paymentSummary, paymentThresholdChf, gatePaid, gateText, amountText } from "./payments.js";
import { offerInfo, isFixOffer, SELLER_COMMISSION_BPS } from "./pricing.js";
import { isVnOrder, buildVnAccessRequestMail, buildVnHostingQuestionMail, buildVnHostKeyConfirmationMail, buildVnRepairReport, buildVnRepairDeliveryMail, vnReportSubject } from "./vn-customer-texts.js";
import { ACCESS_AUTH_SOURCE, ACCESS_REQUEST_CLASS, accessKeys, accessLink, newIntakeToken, openAccessCredential, destroyAccessSecret,
  markSecretDestroyed, syncAccessIntake, intakeClient } from "./access-intake.js";
import { profileRecord, profileReason, HOST_KEY_CONFIRMED_SOURCES, PROFILE_STATUSES } from "./repair-adapters/profile-builder.js";
import { REPAIR_TYPES, selectCustomerVisibleFindings } from "./swiss-repair.js";
import { createAuditor } from "./site-auditor.js";
import { MAX_AUTO_FIXES_PER_ORDER, hasCapabilities, onlyCapabilities } from "./repair-adapters/common.js";
import { combineDecisions, rollbackMatchesBaseline, safeSnapshot, browserRuntimeStatus } from "./repair-browser-validator.js";
import { REPAIR_FINDINGS_FILE, normalizeIssue, dedupeFindings, rankFindings } from "./site-findings.js";
import { contentQuestionLines, buildReissueMail, MAX_AUTO_REISSUES, localeOf, ONBOARDING_CLASS } from "./onboarding-core.js";
import { readBrief, listReissueRequests } from "./onboarding-store.js";
import { cleanPlatform, cleanStated, resolvePlatform, connectorOf, nameOf, accessGuide, hostingQuestionLines } from "./hosting-detect.js";

export const REPAIR_ORDERS_FILE = "repair_orders.json";
// Gate-Vergleich für Zustandsgründe: CH exakt wie bisher «CHF 240 ≥ 240», VN «1.950.000 ₫ ≥ 1.950.000 ₫».
const geText = (g) => (g.currency === "VND" ? `${amountText(g.paid, "VND")} ≥ ${amountText(g.required, "VND")}` : `CHF ${g.paid_chf} ≥ ${g.required_chf}`);
const samePaid = (stored, gate) => gatePaid(stored) === gatePaid(gate);
export const REPAIR_OFFER = "REPAIR_FIX_500"; // Kundenbezeichnung „Check & Reparatur“, Preis aus OFFERS (CHF 480). Keine dritte Preisstufe.
// Nachrichtenklasse der Liefermail (TF-046): Erfüllung eines bezahlten Kundenauftrags – nie Cold-Outreach/Marketing.
export const FULFILLMENT_CLASS = "CUSTOMER_ORDER_FULFILLMENT";
const MAX_INLINE_DELIVERY = 5200; // wie CHF 150: passt in die 6000-Zeichen-Grenze für Entwürfe – sonst Anhang nötig (Chris)
// Lieferstatus fürs Dashboard – feste Wörter, nie Draft-IDs oder Inhalte.
export const DELIVERY_STATUSES = Object.freeze(["none", "draft_ready", "sent", "attachment_required", "unclear", "report_unsafe", "failed", "manual"]);

// ---------- Zustände ----------
// PAYMENT_REQUIRED (TF-041): die Zahlungsschwelle (CHF 240) ist nicht erfüllt – wartet, je Lauf neu geprüft, kein Zugang/Login/
// Adapter/Intake. ACCESS_REQUESTED: Kunde hat nach erfüllter Schwelle genau EINE Zugangs-Anfrage mit sicherem Link bekommen –
// wartet auf die Einreichung (Zugang + Freigabe) bzw. einen von Chris konfigurierten Adapter-Zugang.
// PAYMENT_REVIEW_REQUIRED: Zahlung fiel unter die Schwelle, nachdem die Website bereits verändert wurde – Chris entscheidet.
// TF-043: ACCESS_PROFILE_PREFLIGHT (Zugangsprofil wird automatisch und nur lesend erzeugt), HOST_KEY_CONFIRMATION_REQUIRED
// (unbekannter SSH-Host-Key – wartet auf die Bestätigung des Kunden bzw. von Chris), WAITING_FOR_ACCESS_PROFILE (Webroot/Angaben
// nicht eindeutig – wartet, bis Chris das Profil ergänzt). Alle drei warten, nichts wird verändert.
// TF-066: WAITING_FOR_CUSTOMER_BRIEF – Zugang geprüft, aber der Kunden-Brief (Inhaltsänderungen) ist weder bestätigt (CONFIRMED) noch
// ausdrücklich leer (NO_CONTENT_CHANGES). Wartet, nichts wird verändert; der Dialog läuft im Mail-Worker.
// TF-071: WAITING_FOR_HOSTING_INFO – Plattform/Hosting öffentlich nicht sicher erkennbar; der Kunde wurde im Auftrags-Thread gefragt
// (ohne Passwörter). Noch KEIN sicherer Link; erst mit der Antwort (Brief, nur feste Wörter) entsteht der passende Zugangsweg.
export const ORDER_STATES = Object.freeze(["ORDER_RECEIVED", "AUTHORIZATION_REQUIRED", "PAYMENT_REQUIRED", "ACCESS_CHECK",
  "ACCESS_REQUESTED", "WAITING_FOR_HOSTING_INFO", "ACCESS_PROFILE_PREFLIGHT", "HOST_KEY_CONFIRMATION_REQUIRED", "WAITING_FOR_ACCESS_PROFILE", "WAITING_FOR_CUSTOMER_BRIEF",
  "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"]);
export const BLOCKED_STATES = Object.freeze(["BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION", "BLOCKED_UNSUPPORTED_STACK",
  "REPAIR_FAILED", "VALIDATION_FAILED", "MANUAL_REVIEW_REQUIRED", "PAYMENT_REVIEW_REQUIRED", "BLOCKED_UNSAFE_ACCESS", "BLOCKED_HOST_KEY_CHANGED"]);
// TF-042: BLOCKED_UNSAFE_ACCESS = Zugang technisch möglich, aber unsicher (root-Login, Systemverzeichnis als Webroot, Symlink-Root).
// TF-044: BLOCKED_HOST_KEY_CHANGED = SSH-Host-Key bzw. Host-Key-Algorithmus weicht vom bestätigten/gepinnten Stand ab – STOP,
// keine Zugangsdaten gesendet, kein Write. Chris prüft (möglicher Angriff oder Server-Neuinstallation).
// Von Chris storniert: terminal, Zugangsdaten werden zerstört, Datensatz bleibt (nie von Hand löschen).
export const REPAIR_CANCELLED = "CANCELLED";
// TF-055: abgeschlossen, aber mindestens ein relevanter Befund bleibt offen (manuell) – terminal, NIE als «vollständig repariert» darstellen.
export const COMPLETED_WITH_MANUAL_ITEMS = "COMPLETED_WITH_MANUAL_ITEMS";
export const COMPLETED_STATES = Object.freeze(["COMPLETED", COMPLETED_WITH_MANUAL_ITEMS]);
const TERMINAL = new Set([...COMPLETED_STATES, REPAIR_CANCELLED, ...BLOCKED_STATES]);
// Ab diesen Zuständen wird mit dem Kundenzugang gearbeitet – fällt die Zahlung unter die Schwelle, stoppt der Auftrag.
const WORK_STATES = new Set(["ACCESS_PROFILE_PREFLIGHT", "HOST_KEY_CONFIRMATION_REQUIRED", "WAITING_FOR_ACCESS_PROFILE", "WAITING_FOR_CUSTOMER_BRIEF",
  "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY"]);
const MAX_PREFLIGHT_ATTEMPTS = 6; // vorübergehende Fehler (Server nicht erreichbar) – danach Chris
const MAX_VALIDATION_FAILURES = 2; // TF-071: ungültige Zugänge je Auftrag mit automatisch neuem Link – danach Chris
// TF-044: Fehlercodes der Host-Key-Prüfung (repair-adapters/host-key.js, sftp.js), die einen Auftrag sofort stoppen.
const HOST_KEY_STOP_CODES = new Set(["HOST_KEY_CHANGED", "HOST_KEY_UNVERIFIED", "HOST_KEY_UNSAFE", "HOST_KEY_AMBIGUOUS"]);
// Zugangsart aus dem sicheren Formular → passender Adapter-Schlüssel (nur wenn ein solcher Adapter konfiguriert ist).
const CONNECTOR_ADAPTER = { github_netlify: "github_netlify", wordpress_cms: "wordpress" };

// ---------- Autorisierung (Pflicht vor jeder Änderung) ----------
// Nur eine ausdrückliche, dokumentierte Kundenhandlung zählt. Deny by default – alles andere wird abgelehnt.
export const AUTHORIZATION_SOURCES = Object.freeze(["customer_reply_email", "customer_order_form", "signed_offer", "written_confirmation", ACCESS_AUTH_SOURCE]);
// Diese Quellen sind NIE eine Freigabe (werden auch bei Tippfehlern von Chris hart abgelehnt).
export const NEVER_AUTHORIZATION = Object.freeze(["cold_outreach", "cold_mail", "cold_draft", "lead_database", "public_website", "audit", "discovery", "voided_sale", "sales_record"]);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// TF-047: OUTBOX_PENDING = Service-Mail liegt in der Repair-Outbox, der Mail-Worker hat noch nicht bestätigt → nächster Lauf, nie «gesendet».
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|OUTBOX_PENDING/i;
export const normDomain = (d = "") => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const issueKey = (i) => { let p = i.url; try { p = new URL(i.url).pathname; } catch {} return `${i.type}|${p}`; };
const RELEVANT = new Set(["medium", "high", "critical"]);

// ---------- Stack-Erkennung (nur aus öffentlich sichtbaren Signalen) ----------
export const STACKS = Object.freeze(["github_netlify", "static", "nextjs", "react", "wordpress", "other"]);
export function detectStack({ html = "", headers = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const ev = [];
  if (/x-nf-request-id/.test(Object.keys(h).join(" ")) || /netlify/i.test(h.server || "")) ev.push("netlify_header");
  if (/wp-content|wp-includes|wp-json/i.test(html) || /WordPress/i.test(html.match(/<meta[^>]*generator[^>]*>/i)?.[0] || "")) return { type: "wordpress", evidence: ["wordpress_markup"] };
  if (/__NEXT_DATA__|\/_next\//.test(html)) return { type: "nextjs", evidence: ["next_markup", ...ev] };
  if (/data-reactroot|react(-dom)?(\.production)?(\.min)?\.js/i.test(html)) return { type: "react", evidence: ["react_markup", ...ev] };
  if (ev.includes("netlify_header")) return { type: "github_netlify", evidence: ev };
  if (/<html/i.test(html) && !/<\?php|wp-content/i.test(html)) return { type: "static", evidence: ["plain_html", ...ev] };
  return { type: "other", evidence: ev };
}

// ---------- Geschützte Änderungen (Abschnitt „Nicht blind automatisieren“) ----------
// Seiten mit rechtlichen Texten/Preisen/Konten: dort wird nie automatisch am Inhalt repariert.
export const PROTECTED_PAGE_RE = /impressum|imprint|mentions-l[ée]gales|datenschutz|privacy|agb\b|terms|preis|pricing|tarif|konto|account|login|checkout|warenkorb|cart|zahlung|payment/i;
// Ziele/Änderungen, die nie automatisch angefasst werden (DNS, Registrar, Zahlungen, Kundendaten, Architektur …).
export const PROTECTED_TARGET_RE = /\bdns\b|registrar|domain[- ]?inhaber|nameserver|zahlung|payment|stripe|twint|\bbank|datenbank|database|kundendaten|benutzer|user[- ]?account|passwort|credential|preis|vertrag|impressum|datenschutz|\bagb\b|rechtlich|migration|redesign|architektur|lösch|delete|drop\b/i;
export const isProtectedChange = (item = {}) =>
  PROTECTED_TARGET_RE.test(`${item.target || ""} ${item.planned_change || ""} ${item.cause || ""}`);
const isProtectedIssue = (i = {}) => { let p = ""; try { p = new URL(i.page || i.url).pathname; } catch { p = String(i.page || i.url || ""); } return PROTECTED_PAGE_RE.test(p); };

// ---------- Voll-Audit (gesamte freigegebene Website, passiv; nie erfundene Probleme) ----------
// Stufe 1: Startseite + bis zu maxLinks verlinkte Unterseiten (Links/Bilder/Kontakt/Weiterleitungen/HTTP-Fehler). Der Bericht
// nennt ehrlich, was geprüft wurde. Visuelle Mobile-/Desktop-Befunde kommen zusätzlich über deps.retester (falls konfiguriert).
export async function fullSiteAudit(website, { auditor = null, now = () => new Date() } = {}) {
  const a = auditor || createAuditor({ maxLinks: 80, maxImages: 25, totalMs: 10 * 60_000, now });
  const r = await a.audit(website);
  const issues = {};
  for (const i of r.issues || []) {
    const id = "I" + sha(`${i.type}|${i.url}|${i.detectedAt}`).slice(0, 10);
    issues[id] = {
      issue_id: id, type: i.type, severity: i.severity, page: i.page || i.url, evidence: i.evidence, url: i.url,
      detectedAt: i.detectedAt, ...(i.location ? { location: i.location } : {}), ...(i.label ? { label: i.label } : {}), ...(i.reproducible !== undefined ? { reproducible: i.reproducible } : {}),
      customer_text: selectCustomerVisibleFindings([i])[0]?.text || null,
      repairable: REPAIR_TYPES[i.type] === "fix" && !isProtectedIssue(i),
      protected: isProtectedIssue(i),
      repair_status: "open",
    };
  }
  return { ok: r.reachable !== false, reachable: r.reachable, finalUrl: r.finalUrl || null, title: r.title || null,
    pages_checked: Math.max(1, Object.keys(r.pages || {}).length), requests: r.requests || 0,
    html: r.pages?.home || "", issues, audited_at: (now() instanceof Date ? now() : new Date()).toISOString() };
}

// ---------- Order-Modell ----------
const DELIVERY_EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
// TF-064: offer_class VN_REPAIR_FIX → VN-Auftrag (VNFIX-…, market VN, currency VND, Preis/Schwelle aus pricing.js, vietnamesische
// Kundentexte). Gleicher sicherer Workflow; CH-Aufträge bleiben exakt im bisherigen Format (RF480-…, price_chf, CHF).
export function createRepairOrder(store, { domain, website = null, lead_id = null, company = null, delivery_email = null, contact_name = null, offer_class = REPAIR_OFFER, vn = null, now = new Date() } = {}) {
  const d = normDomain(domain);
  if (!d) throw new Error("Domain erforderlich.");
  const info = offerInfo(offer_class);
  if (!info || !isFixOffer(offer_class)) throw new Error(`Unbekanntes Reparatur-Angebot "${offer_class}".`);
  // Verifizierte Kundenadresse des bestätigten Auftrags (optional): nur an sie darf die automatische Zugangs-Anfrage
  // gehen (TF-041) – NIE automatisch eine alte Cold-Outreach-Adresse. Ohne Adresse gibt es keine automatische Anfrage.
  if (delivery_email != null && !DELIVERY_EMAIL_RE.test(String(delivery_email))) throw new Error("Ungültige Kunden-E-Mail (--email) – weglassen oder gültige Adresse des bestätigten Auftrags angeben.");
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  // Höchstens ein offener Auftrag je Domain – ein zweiter Auftrag entsteht erst, wenn der erste abgeschlossen/blockiert ist.
  const open = Object.values(data.orders || {}).find((o) => normDomain(o.domain) === d && !TERMINAL.has(o.state));
  if (open) throw new Error(`Für ${d} läuft bereits Auftrag ${open.order_id} (${open.state}).`);
  const order_id = `${info.order_prefix}-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${sha(d + now.getTime()).slice(0, 6)}`;
  const money = info.market === "VN"
    ? { offer_class, market: "VN", currency: "VND", price_amount: info.price, locale: "vi-VN", payment: { required: info.deposit, paid: 0, currency: "VND", satisfied: false }, commission_rate_bps: SELLER_COMMISSION_BPS, ...(vn || {}) }
    : { offer_class: REPAIR_OFFER, price_chf: OFFERS[REPAIR_OFFER].price, currency: "CHF", commission_rate_bps: SELLER_COMMISSION_BPS, payment: { required_chf: OFFERS[REPAIR_OFFER].price / 2, paid_chf: 0, satisfied: false } };
  const order = {
    order_id, ...money,
    lead_id: lead_id || d, domain: d, website: website || `https://${d}/`, company,
    delivery_email: delivery_email ? String(delivery_email).toLowerCase() : null, contact_name,
    access_request: null,
    customer_authorized_repair: false, authorization: null,
    state: "ORDER_RECEIVED", state_history: [{ at: now.toISOString(), from: null, to: "ORDER_RECEIVED", reason: "Auftrag erfasst" }],
    stack: null, access: null, backup: null,
    audit_preview: null, audit_before: null, issues: {}, plan: [], manual_review: [],
    validation: null, retest: null, deployment: null, regression: null, report: null,
    blocked_reason: null, created_at: now.toISOString(), updated_at: now.toISOString(),
  };
  data.orders = { ...(data.orders || {}), [order_id]: order };
  store.write(REPAIR_ORDERS_FILE, data);
  return order;
}

// Bestätigter CHF-480-Auftrag (TF-046): der bewusste Aufruf durch Chris ist die betriebliche Bestätigung (wie
// check-150-workflow --create-confirmed). Direktverkauf (sales.js recordDirectSale, Quelle direct_customer) + Auftrag; eine
// Anfrage allein erzeugt NIE einen Auftrag. VERKAUF != ZAHLUNG: der Auftrag wartet danach auf kumulativ CHF 240.
// TF-079: viaCustomerMail = Bestätigung kam als ausdrückliche Kundenmail im Kontaktformular-Verlauf (Beleg statt Chris-CLI).
export function createConfirmedRepairOrder(store, { domain, website = null, company = null, delivery_email, contact_name = null, date = null, viaCustomerMail = false, now = new Date() } = {}) {
  if (!DELIVERY_EMAIL_RE.test(String(delivery_email || ""))) throw new Error("Verifizierte Kundenadresse (--email) des bestätigten Auftrags erforderlich.");
  const sales = store.read("sales.json", { records: {} });
  const records = recordDirectSale(sales.records || {}, { domain, offer: REPAIR_OFFER, delivery_email, company, contact_name, website, date: date || undefined, now }); // validiert, schreibt nicht
  const ds = records[normDomain(domain)]?.direct_sale;
  if (viaCustomerMail && ds) Object.assign(ds, { basis: "customer_email_confirmation", confirmed_by: "customer_contact_form" });
  const order = createRepairOrder(store, { domain, website, company, delivery_email, contact_name, now }); // wirft bei offenem Auftrag
  store.write("sales.json", { ...sales, records });
  const sale = records[normDomain(domain)]?.sale;
  order.confirmed = { source: "sales.json", sale_date: sale?.sale_date || null, confirmed_at: now.toISOString() };
  order.state_history.push({ at: now.toISOString(), from: order.state, to: order.state, reason: `ORDER_CONFIRMED – Direktverkauf ${REPAIR_OFFER} erfasst (CHF ${OFFERS[REPAIR_OFFER].price}); wartet auf Zahlung` });
  return saveOrder(store, order);
}
// TF-079: Kunde hat im Kontaktformular-Thread ausdrücklich «Check & Reparatur» bestätigt (Mail-Worker → onboarding/cf_orders). Gleicher Weg wie
// createConfirmedRepairOrder (Direktverkauf + Auftrag), Bestätigung belegt als Kundenmail statt Chris-CLI. Die Bestätigung des AUFTRAGS ist KEINE
// Reparaturfreigabe: customer_authorized_repair bleibt false, bis der Kunde im sicheren Formular für genau diese Domain zustimmt. VERKAUF != ZAHLUNG.
export function createContactFormRepairOrder(store, { domain, website = null, company = null, delivery_email, contact_name = null, lead_id = null, contact_form_key, confirmed_at, now = new Date() } = {}) {
  if (!/^cf:[0-9a-f]{24}$/.test(String(contact_form_key || ""))) throw new Error("Kontaktformular-Kennung fehlt.");
  const order = createConfirmedRepairOrder(store, { domain, website, company, delivery_email, contact_name, viaCustomerMail: true, now });
  if (lead_id) order.lead_id = lead_id;
  order.confirmed = { ...order.confirmed, source: "contact_form_customer_confirmation", customer_confirmed_at: confirmed_at || now.toISOString() };
  order.contact_form = { key: contact_form_key, confirmed_at: confirmed_at || now.toISOString(), source: "customer_reply_email" };
  order.onboarding_required = true; // Kunden-Dialog (Brief-Gate) läuft im Kontaktformular-Thread weiter
  order.state_history.push({ at: now.toISOString(), from: order.state, to: order.state, reason: "Auftrag vom Kunden im Kontaktformular-Verlauf ausdrücklich bestätigt (keine Reparaturfreigabe) – wartet auf Zahlung" });
  return saveOrder(store, order);
}
// Stornierter (voided) CHF-480-Verkauf für die Domain des Auftrags (TF-040/TF-046) – dann nie Reparatur oder Lieferung.
export function repairSaleVoided(store, order = {}) {
  const sale = store.read("sales.json", { records: {} }).records?.[normDomain(order.domain)]?.sale;
  return !!sale && sale.selected_offer === (order.offer_class || REPAIR_OFFER) && isVoidedSale(sale);
}

function saveOrder(store, order) {
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  data.orders = { ...(data.orders || {}), [order.order_id]: order };
  store.write(REPAIR_ORDERS_FILE, data);
  return order;
}
const transition = (order, to, reason, now) => {
  order.state_history.push({ at: now.toISOString(), from: order.state, to, reason });
  order.state = to;
  order.updated_at = now.toISOString();
  return order;
};

export const authorizationOk = (o = {}) => o.customer_authorized_repair === true
  && !!o.authorization && AUTHORIZATION_SOURCES.includes(o.authorization.source)
  && normDomain(o.authorization.authorized_domain) === normDomain(o.domain);

// Freigabe setzen – nur dokumentierte Kundenhandlung, Domain muss EXAKT dem Auftrag entsprechen. Cold-Outreach zählt nie.
export function authorizeRepair(store, orderId, { authorized_domain, source, reference = null, granted_at = null, now = new Date() } = {}) {
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const order = data.orders?.[orderId];
  if (!order) throw new Error("Auftrag nicht gefunden.");
  if (NEVER_AUTHORIZATION.includes(String(source || "").toLowerCase())) throw new Error("Cold-Outreach/Interesse ist NIE eine Reparaturfreigabe – es braucht eine ausdrückliche Kundenfreigabe.");
  if (!AUTHORIZATION_SOURCES.includes(source)) throw new Error(`Unbekannte Freigabequelle. Erlaubt: ${AUTHORIZATION_SOURCES.join(", ")}.`);
  if (normDomain(authorized_domain) !== normDomain(order.domain)) throw new Error(`Freigegebene Domain "${authorized_domain}" stimmt nicht mit dem Auftrag (${order.domain}) überein.`);
  order.customer_authorized_repair = true;
  order.authorization = { authorized_domain: normDomain(authorized_domain), source, reference, granted_at: granted_at || now.toISOString() };
  order.updated_at = now.toISOString();
  if (order.state === "AUTHORIZATION_REQUIRED" || order.state === "ORDER_RECEIVED")
    transition(order, "ACCESS_CHECK", "Kundenfreigabe dokumentiert", now);
  return saveOrder(store, order);
}

// TF-045/TF-054: Abschluss-Gate. COMPLETED (und vorher READY_FOR_DELIVERY) nur, wenn die technische Adapter-Validierung, der öffentliche
// HTTP-Retest und – sobald für den Auftrag ein Browser-Gate gilt – Desktop- UND Mobile-Browser-Validierung bestanden sind und
// keine Regression offen ist. Ohne Browser-Gate (kein Plan/ältere Aufträge) gelten Desktop- und Smartphone-Retest wie bisher.
export function completionGate(order = {}) {
  const missing = [];
  if ((order.plan || []).length && order.validation?.build_ok !== true) missing.push("adapter_validation");
  if (!order.retest || order.retest.http_ok === false) missing.push("http_retest");
  const g = order.browser_gate;
  if (g?.required) {
    if (g.desktop !== "JA") missing.push("browser_desktop");
    if (g.mobile !== "JA") missing.push("browser_mobile");
    if (g.regression !== "KEINE") missing.push("browser_regression");
  } else {
    if (order.retest?.desktop?.ok !== true) missing.push("desktop_retest");
    if (order.retest?.mobile?.ok !== true) missing.push("mobile_retest");
  }
  // TF-054: Freigabe, Zahlung, Zugang, Profil und Backup erneut (nicht nur über den Zustandsweg) – und jeder geplante Befund muss
  // tatsächlich behoben sein. Teilreparatur (ein geplanter Fix gescheitert/zurückgerollt/weiterhin vorhanden) → nie COMPLETED.
  if (!authorizationOk(order)) missing.push("authorization");
  if (order.payment?.satisfied !== true) missing.push("payment");
  if (order.access?.ok !== true) missing.push("access");
  if (order.access_profile && order.access_profile.profile_status !== "PROFILE_READY") missing.push("access_profile");
  if (!order.backup?.rollback_point) missing.push("backup");
  if ((order.plan || []).some((p) => order.issues?.[p.issue_id]?.repair_status !== "repaired")) missing.push("repair_unresolved");
  // TF-066: Auftrag mit Onboarding-Dialog → Kunden-Brief muss bestätigt oder ausdrücklich ohne Inhaltsänderungen sein.
  if (order.onboarding_required && !BRIEF_GATE_OK.includes(order.customer_brief?.status)) missing.push("customer_brief");
  // TF-071: Plattform/Zugangsweg muss geklärt sein, bevor mit dem Zugang gearbeitet wird.
  if (order.platform_required && !order.platform?.access_type) missing.push("platform");
  return { ok: !missing.length, missing };
}
export const BRIEF_GATE_OK = Object.freeze(["CONFIRMED", "NO_CONTENT_CHANGES"]);
// TF-066 Brief-Gate (§23): ohne Onboarding-Dialog (ältere Aufträge, Zugang von Chris direkt konfiguriert) gilt es nicht.
export function briefGate(order = {}, onboardingDir = null) {
  if (!order.onboarding_required) return { ok: true, status: "NOT_REQUIRED", changes: [] };
  const b = onboardingDir ? readBrief(onboardingDir, order.order_id) : null;
  if (!b) return { ok: false, status: "OPEN", changes: [] };
  if (b.manual) return { ok: false, status: "MANUAL", changes: [] };
  const ok = BRIEF_GATE_OK.includes(b.status);
  return { ok, status: b.status, confirmed_at: b.confirmed_at || null, changes: ok && b.status === "CONFIRMED" ? (b.changes || []).filter((c) => c && c.customer_confirmed === true).slice(0, 10) : [] };
}
// Text für Bericht/Plan: «alt» → «neu» bzw. Art der Angabe (nur die bestätigten Kundenwerte, nie Rohmails).
const changeText = (c, vi = false) => {
  const addr = [c.address?.street, [c.address?.postal_code, c.address?.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const nv = c.kind === "address" ? addr : c.new_text;
  const label = vi ? { phone: "Số điện thoại", email: "Email", address: "Địa chỉ", opening_hours: "Giờ mở cửa", removal: "Xóa nội dung", addition: "Bổ sung nội dung" }[c.kind] || "Nội dung"
    : { phone: "Telefonnummer", email: "E-Mail-Adresse", address: "Adresse", opening_hours: "Öffnungszeiten", removal: "Entfernt", addition: "Ergänzt" }[c.kind] || "Text";
  if (c.kind === "removal") return `${label}: «${c.old_text}»`;
  return c.old_text ? `${label}: «${c.old_text}» → «${nv}»` : `${label}: ${nv}`;
};

// TF-055: offene, relevante Befunde NACH der Reparatur = manuelle Punkte. Relevant: geschützter Inhalt, bewusst nicht automatisch
// repariert/Ursache unklar (needs_review), gescheitert/weiterhin vorhanden/zurückgerollt oder Schweregrad ≥ medium. Reine Hinweise
// (low, z. B. fehlende Meta-Beschreibung) zählen nicht. Im Zweifel ist der Punkt manuell – nie fälschlich «alles behoben».
const MANUAL_STATUSES = new Set(["needs_review", "repair_failed", "still_broken", "rolled_back"]);
export function manualItems(order = {}) {
  return Object.values(order.issues || {}).filter((i) => i && i.repair_status !== "repaired"
    && (i.protected === true || MANUAL_STATUSES.has(i.repair_status) || RELEVANT.has(i.severity)));
}
// Terminaler Erfolgszustand: COMPLETED nur ohne offene manuelle Punkte, sonst COMPLETED_WITH_MANUAL_ITEMS (Abschluss-Gate gilt für beide).
export const completionState = (order) => (manualItems(order).length ? COMPLETED_WITH_MANUAL_ITEMS : "COMPLETED");
const completionReason = (order, base) => (completionState(order) === "COMPLETED" ? base
  : `${base} – automatisch reparierbare Punkte behoben, ${manualItems(order).length} Punkt(e) erfordern eine manuelle Prüfung`);

// Abnahme/Abschluss durch Chris: erst damit wird der Auftrag ERLEDIGT.
export function completeOrder(store, orderId, { now = new Date() } = {}) {
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const order = data.orders?.[orderId];
  if (!order) throw new Error("Auftrag nicht gefunden.");
  if (order.state !== "READY_FOR_DELIVERY") throw new Error(`Nur ein Auftrag in READY_FOR_DELIVERY kann abgeschlossen werden (aktuell ${order.state}).`);
  const gate = completionGate(order);
  if (!gate.ok) throw new Error(`Abschluss-Gate nicht erfüllt (${gate.missing.join(", ")}) – kein COMPLETED.`);
  if (!order.delivery?.sent_at) order.delivery = { ...(order.delivery || {}), status: "manual", completed_by: "chris", completed_at: now.toISOString() }; // Chris liefert selbst
  transition(order, completionState(order), completionReason(order, "Abschluss bestätigt"), now);
  destroyOrderSecret(store, order, now); // Secret-Lebenszyklus (TF-041): nach COMPLETED kein Zugang mehr im Tresor
  return saveOrder(store, order);
}

// Stornieren durch Chris (TF-041): terminal, Zugangsdaten werden zerstört, Datensatz bleibt erhalten. Nie nach COMPLETED.
export function cancelRepairOrder(store, orderId, { reason = null, now = new Date() } = {}) {
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const order = data.orders?.[orderId];
  if (!order) throw new Error("Auftrag nicht gefunden.");
  if (!String(reason || "").trim()) throw new Error('Begründung ist Pflicht: --reason "<grund>".');
  if (COMPLETED_STATES.includes(order.state) || order.state === REPAIR_CANCELLED) throw new Error(`Auftrag ist bereits ${order.state}.`);
  transition(order, REPAIR_CANCELLED, `Von Chris storniert: ${String(reason).replace(/\s+/g, " ").trim().slice(0, 200)}`, now);
  destroyOrderSecret(store, order, now);
  return saveOrder(store, order);
}

// Tresor-Eintrag zerstören und nur Metadaten behalten (connector_type, received_at, destroyed_at, revoked_required).
// TF-043: auch das Auftragsprofil wird auf Status/Quellen reduziert – Webroot und Fingerprint werden nicht mehr gebraucht.
function destroyOrderSecret(store, order, now) {
  if (order.access_profile && !order.access_profile.cleared_at) {
    const { profile_status, interface: iface, host_key_source, host_key_verified, webroot_source, profile_created_at } = order.access_profile;
    order.access_profile = { profile_status, interface: iface, host_key_source, ...(host_key_verified != null ? { host_key_verified: host_key_verified === true } : {}),
      webroot_source, profile_created_at, cleared_at: now.toISOString() };
  }
  if (!order.access_intake || order.access_intake.status === "DESTROYED") return;
  const existed = destroyAccessSecret(store.dir, order.order_id);
  markSecretDestroyed(order, { now, existed });
}

// ---------- Engine ----------
// deps.adapters: je Stack ein Objekt mit sicheren, bereits konfigurierten Reparaturwegen. Secrets bleiben beim Adapter (env/Secret-
// Dateien) – die Engine speichert aus Adapter-Antworten NUR die hier aufgeführten Felder (nie Tokens, nie Header, nie URLs mit Keys).
//   checkAccess(order)                → { ok, connector }            fehlend/false → BLOCKED_NO_ACCESS
//   backup(order, { branch })         → { production_ref, backup_ref, rollback_point, branch? } – unvollständig → MANUAL_REVIEW_REQUIRED
//   locate(issue, order)              → { target, cause, planned_change, risk? } | null (null = Ursache unklar → nie raten)
//   applyFix(planItem, order)         → { ok, change_ref? }
//   validate(order)                   → { build_ok, preview_url? }   (optional; ohne validate gilt build_ok nur für statische Stacks)
//   deployProduction(order)           → { ok, deploy_ref? }          (optional; ohne = Chris deployt selbst über den bestehenden Kanal)
//   rollback(order)                   → { ok }                       (optional; bei Regression Pflichtversuch, wenn vorhanden)
// deps.retester(url) → { ok, method, issues? } (optional, z. B. echter Smartphone-/Desktop-Rendertest).
// TF-045: deps.browserValidator (repair-browser-validator.js) = echtes Browser-Gate (Baseline vor der Änderung, Retest danach,
// Browser-Retest nach Rollback). requireBrowser = true (Produktivbetrieb über runRepairOrders): ohne Validator wird nichts
// repariert/abgeschlossen (fail closed). Ist ein Validator übergeben, gilt das Gate immer.
// TF-042: deps.router (repair-adapters/router.js) wählt bei sicher übermitteltem Zugang den Adapter nach tatsächlichen
// Fähigkeiten (order.route). Contract-Adapter (WordPress/SFTP/SSH) kommen über die Brücke mit identischer Aufrufform und
// direct_live = true (Änderungen sind sofort live → jede fehlgeschlagene Prüfung führt zum Rollback). Allen Adapter-Aufrufen
// wird der Zugangskontext (accessCtx) als letztes Argument mitgegeben; Zugangsdaten werden nur darin zur Laufzeit geöffnet.
// TF-043: deps.preflight (repair-adapters/profile-builder.js, über createAdapterRegistry) erzeugt nach erhaltenem Zugang das
// Zugangsprofil automatisch (ACCESS_PROFILE_PREFLIGHT). Ohne preflight bleibt alles wie in TF-042 (Profil von Chris).
export function createRepairEngine({ dir = WORKER_DIR, store = createStore(dir), adapters = {}, auditor = null, retester = null,
  gmail = null, intake = null, router = null, preflight = null, alert = null, browserValidator = null, requireBrowser = false, autoDeliver = false,
  onboardingDir = null, platformDetector = null, now = () => new Date(), log = () => {} } = {}) {
  // TF-071: platformDetector(order) → Befund aus öffentlichen Signalen (hosting-probe.js). Fehlt er oder ist der Befund unsicher,
  // fragt Jarvis den Kunden (WAITING_FOR_HOSTING_INFO) – nie wird ein Anbieter erraten.
  // TF-066: onboardingDir (gemeinsames Outbox-Unterverzeichnis) aktiviert den Kunden-Onboarding-Dialog: Inhaltsfrage in der ersten
  // Zugangs-Anfrage, Auftrags-ID an jeder Service-Mail (Mail-Worker bindet den Thread), Brief-Gate vor dem Backup, bestätigte
  // Inhaltsänderungen im Plan, automatisch neuer Link nur bei abgelaufenem Link. Ohne onboardingDir: Verhalten exakt wie bisher.

  const adapterOf = (order) => (order.stack ? adapters[order.route?.adapter || order.stack.type] || null : null);
  const block = (order, state, reason) => {
    order.blocked_reason = reason; transition(order, state, reason, now());
    // Credential-Lebenszyklus (TF-042): endgültig gescheiterte Reparatur → Tresor zerstören, nur Metadaten bleiben.
    if (state === "REPAIR_FAILED") destroyOrderSecret(store, order, now());
    return saveOrder(store, order);
  };
  // Chris informieren (Dashboard zeigt MANUAL REVIEW; zusätzlich Log-Ereignis + optionaler Hinweis-Kanal). Nie Zugangsdaten.
  const informChris = async (order, kind, reason) => {
    order.alerts = [...(order.alerts || []), { at: now().toISOString(), kind, reason: String(reason).slice(0, 200) }].slice(-10);
    log("error", "repair_chris_alert", { order_id: order.order_id, kind });
    if (typeof alert === "function") { try { await alert({ order_id: order.order_id, domain: order.domain, kind, reason: String(reason).slice(0, 200) }); } catch {} }
  };
  const canRequestAccess = (order) => !!(order.delivery_email && intake && gmail && typeof gmail.createDraft === "function" && typeof gmail.sendDraft === "function");
  const intakeReceived = (order) => order.access_intake?.status === "RECEIVED";
  // One-Time-Link registrieren + Service-Mail genau EINMAL senden (Zugangs-Anfrage bzw. Host-Key-Bestätigung). Draft-ID und
  // Sendeversuch werden VOR dem Versand persistiert – ein Neustart erzeugt nie eine zweite Mail; unklarer Ausgang → nie wiederholen.
  // Rückgabe: "sent" | "unclear" | "deferred" (vorübergehender Fehler, nächster Lauf) | { error }.
  // TF-071: withLink = false → Service-Mail ohne Link (Plattform-Frage, Klasse CUSTOMER_ONBOARDING_DIALOGUE), gleiche Idempotenz.
  const sendLinkMail = async (order, field, { register = {}, build, extra = {}, events, meta = {}, withLink = true, messageClass = ACCESS_REQUEST_CLASS }) => {
    const t = now();
    if (order[field]?.sent_at) return "sent";
    if (order[field]?.send_attempted_at) {
      if (!order[field].send_unclear) { order[field] = { ...order[field], send_unclear: true }; order.updated_at = t.toISOString(); saveOrder(store, order); log("warn", events.unclear, { order_id: order.order_id }); }
      return "unclear";
    }
    try {
      if (!order[field]?.draft_id) {
        // Neuer One-Time-Link: nur der Hash wird registriert/gespeichert; der Token steht ausschliesslich in der Mail.
        const tk = withLink ? newIntakeToken({ now: t }) : null;
        if (tk) await intake.register({ order_id: order.order_id, domain: order.domain, token_hash: tk.token_hash, expires_at: tk.expires_at, public_key: accessKeys(store.dir).publicKeyPem, ...register,
          ...(isVnOrder(order) ? { locale: "vi-VN" } : {}) }); // TF-064: Formular für VN-Kunden auf Vietnamesisch
        const mail = build(tk ? { link: accessLink(intake.origin, tk.token, isVnOrder(order) ? "vi-VN" : "de-CH"), expires_at: tk.expires_at } : {});
        const d = await gmail.createDraft({ to: order.delivery_email, subject: mail.subject, body: mail.body, messageClass,
          ...(onboardingDir ? { orderId: order.order_id, ...meta } : {}) }); // TF-066: Mail-Worker sendet im Auftrags-Thread
        order[field] = { to: order.delivery_email, draft_id: d.draftId, message_class: messageClass, ...(tk ? { token_hash: tk.token_hash, expires_at: tk.expires_at } : {}), created_at: t.toISOString(), ...extra };
        order.updated_at = t.toISOString();
        saveOrder(store, order); // Draft-ID sofort persistieren – ein Neustart erzeugt nie ein Duplikat
      }
      order[field] = { ...order[field], send_attempted_at: t.toISOString() };
      saveOrder(store, order); // VOR dem Versand – ein Absturz danach führt nie zu einer zweiten Mail
      await gmail.sendDraft(order[field].draft_id);
    } catch (e) {
      if (order[field]?.send_attempted_at) { order[field] = { ...order[field], send_attempted_at: null }; saveOrder(store, order); }
      if (TRANSIENT_RE.test(e.message)) { log("warn", events.deferred, { order_id: order.order_id, error: String(e.message).slice(0, 160) }); return "deferred"; } // nächster Lauf
      return { error: String(e.message).slice(0, 120) };
    }
    order[field] = { ...order[field], sent_at: t.toISOString() };
    order.updated_at = t.toISOString();
    saveOrder(store, order);
    log("info", events.sent, { order_id: order.order_id, message_class: messageClass });
    return "sent";
  };
  // ---------- TF-071: Plattform-/Hosting-Erkennung VOR der ersten Zugangs-Anfrage (nur FIX mit Onboarding-Dialog) ----------
  // 1. Öffentliche Signale auswerten (platformDetector). HIGH für den entscheidenden Bereich → Zugangsweg steht fest → sicherer Link.
  // 2. Sonst HOSTING_UNKNOWN → GENAU EINE kurze Frage im Auftrags-Thread (nie nach Passwörtern) → WAITING_FOR_HOSTING_INFO.
  // Rückgabe: "ready" (Zugangsweg bekannt) | "waiting" (Frage gesendet/aufgeschoben) | false (blockiert).
  const platformStep = async (order, t) => {
    order.platform_required = true;
    order.onboarding_required = true; // Brief-Gate + Dialog gelten ab der ersten Auftrags-Mail (auch wenn das die Plattform-Frage ist)
    if (!order.platform?.detected_at) {
      order.platform = { status: "DETECTING_PLATFORM", updated_at: t.toISOString() }; saveOrder(store, order);
      let d = null;
      try { d = typeof platformDetector === "function" ? await platformDetector(order) : null; } catch { d = null; } // Netz-/DNS-Fehler = nicht erkannt
      const p = cleanPlatform(d) || cleanPlatform({});
      // Automatisch nur mit HIGH für den entscheidenden Bereich (hosting-detect accessRequirement min HIGH) – sonst nie raten.
      const auto = d?.access_type && d.confidence === "HIGH" ? d.access_type : null;
      order.platform = { ...p, access_type: auto, connector_type: auto ? connectorOf(auto) : null, detection_source: "automatic", confidence: p.confidence,
        cms_confidence: d?.cms_confidence || "UNKNOWN", deployment_confidence: d?.deployment_confidence || "UNKNOWN", panel_confidence: d?.panel_confidence || "UNKNOWN",
        hosting_confidence: d?.hosting_confidence || "UNKNOWN", dns_confidence: d?.dns_confidence || "UNKNOWN",
        evidence: Array.isArray(d?.evidence) ? d.evidence.filter((e) => /^[a-z0-9_]{2,40}$/.test(e)).slice(0, 12) : [],
        status: auto ? "IDENTIFIED" : "HOSTING_UNKNOWN", detected_at: t.toISOString(), updated_at: t.toISOString() };
      order.state_history.push({ at: t.toISOString(), from: order.state, to: order.state, reason: auto
        ? `Plattform erkannt (${[nameOf(p.cms_platform), nameOf(p.deployment_platform), nameOf(p.hosting_provider)].filter(Boolean).join(", ") || "?"}, ${p.confidence}) – Zugangsweg ${auto}`
        : `HOSTING_UNKNOWN – Plattform/Hosting öffentlich nicht sicher erkennbar (${p.confidence}); Kunde wird gefragt, noch kein Link` });
      saveOrder(store, order);
      log("info", "repair_platform_detected", { order_id: order.order_id, cms: p.cms_platform, deployment: p.deployment_platform, hosting: p.hosting_provider, confidence: p.confidence, access_type: auto });
    }
    if (order.platform.access_type) return "ready";
    const r = await sendLinkMail(order, "hosting_question", { withLink: false, messageClass: ONBOARDING_CLASS, meta: { purpose: "hosting_question" },
      build: () => buildHostingQuestionMail(order),
      events: { unclear: "repair_hosting_question_unclear", deferred: "repair_hosting_question_deferred", sent: "repair_hosting_question_sent" } });
    if (r === "deferred" || r === "unclear") return "waiting";
    if (r?.error) { await informChris(order, "hosting_question_failed", r.error); block(order, "BLOCKED_NO_ACCESS", `Plattform-Frage an den Kunden fehlgeschlagen: ${r.error}`); return false; }
    order.platform = { ...order.platform, status: "WAITING_FOR_HOSTING_INFO", updated_at: t.toISOString() };
    transition(order, "WAITING_FOR_HOSTING_INFO", "Plattform-Frage im Auftrags-Thread gesendet – wartet auf die Angabe des Kunden (keine Zugangsdaten per E-Mail)", t);
    saveOrder(store, order);
    return "waiting";
  };
  // TF-071 §10: übermittelter Zugang liess sich nicht prüfen → ACCESS_VALIDATION_FAILED. Zugangsdaten sofort zerstört (nie erneut
  // versucht), nur Metadaten bleiben; der Kunde erhält im Auftrags-Thread einen neuen sicheren Link. Nach MAX_VALIDATION_FAILURES → Chris.
  // null = gilt nicht (kein Onboarding-/Plattform-Auftrag) → bisheriges Verhalten.
  const validationFailed = async (order, reason) => {
    if (!onboardingDir || !order.platform_required || !intakeReceived(order)) return null;
    const t = now();
    const failures = (order.access_validation?.failures || 0) + 1;
    const existed = destroyAccessSecret(store.dir, order.order_id);
    order.access_intake_history = [...(order.access_intake_history || []), { connector_type: order.access_intake.connector_type, received_at: order.access_intake.received_at,
      destroyed_at: t.toISOString(), result: "ACCESS_VALIDATION_FAILED", vault_existed: existed }].slice(-5);
    order.access_intake = null; order.access = null; order.route = null; order.access_profile = null;
    order.access_validation = { status: "ACCESS_VALIDATION_FAILED", failures, failed_at: t.toISOString(), reason: String(reason).slice(0, 120) };
    log("warn", "repair_access_validation_failed", { order_id: order.order_id, failures });
    if (failures > MAX_VALIDATION_FAILURES) {
      await informChris(order, "access_validation_failed", `Zugang ${failures}× ungültig`);
      block(order, "BLOCKED_NO_ACCESS", `ACCESS_VALIDATION_FAILED (${failures}×): ${String(reason).slice(0, 80)} – keine weitere automatische Anfrage, Chris klärt mit dem Kunden.`);
      return false;
    }
    order.access_request_history = [...(order.access_request_history || []), { sent_at: order.access_request?.sent_at || null, expires_at: order.access_request?.expires_at || null,
      reissued_at: t.toISOString(), reason: "automatisch (validation_failed)" }];
    order.access_request = null;
    order.access_reissue = { seq: null, reason: "validation_failed", at: t.toISOString() };
    transition(order, "ACCESS_REQUESTED", `ACCESS_VALIDATION_FAILED: ${String(reason).slice(0, 80)} – Zugang zerstört (nie erneut verwendet), neuer sicherer Link im Auftrags-Thread`, t);
    saveOrder(store, order);
    return true;
  };
  // Domain-Bindung (TF-041): Auftrag, Freigabe und – falls vorhanden – der sicher übermittelte Zugang zeigen auf exakt dieselbe Domain.
  const domainBound = (order) => authorizationOk(order) && (!order.access_intake || normDomain(order.access_intake.access_domain) === normDomain(order.domain));
  // Zugangsdaten nur auf Abruf im Speicher entschlüsseln (Adapter) – nie speichern, nie loggen.
  const accessCtx = (order) => (intakeReceived(order) ? { connector_type: order.access_intake.connector_type, credential: () => openAccessCredential(store.dir, order.order_id) } : {});
  // TF-041: Zahlungsschwelle ist an dieser Stelle bereits erfüllt. Fehlt der sichere Zugangsweg, bittet Jarvis den Kunden
  // automatisch über den sicheren Link um Zugang (ACCESS_REQUESTED) – aber NUR mit verifizierter Kundenadresse, Intake und
  // Versandweg; sonst bleibt es beim bisherigen fail closed (BLOCKED_NO_ACCESS, Zugangsdaten werden nie erraten).
  // Wurde bereits ein Zugang übermittelt und er reicht nicht: BLOCKED_NO_ACCESS (keine Schleife, keine zweite Anfrage).
  const requestAccessOrBlock = (order, reason) => {
    if (!intakeReceived(order) && !order.access_request?.sent_at && canRequestAccess(order)) {
      transition(order, "ACCESS_REQUESTED", `${reason} Kunde wird über den sicheren Link um Zugang gebeten.`, now());
      saveOrder(store, order);
      return true; // ACCESS_REQUESTED-Schritt sendet die Anfrage im selben Lauf
    }
    if (!intakeReceived(order) && order.access_request?.sent_at) {
      transition(order, "ACCESS_REQUESTED", `${reason} Zugangs-Anfrage wurde bereits gesendet – wartet auf den sicheren Zugang.`, now());
      saveOrder(store, order);
      return false;
    }
    block(order, "BLOCKED_NO_ACCESS", reason);
    return false;
  };
  const manual = (order, reason) => { order.manual_review.push({ at: now().toISOString(), reason }); return block(order, "MANUAL_REVIEW_REQUIRED", reason); };
  // TF-066 Brief-Gate unmittelbar vor dem Backup (= vor der ersten möglichen Änderung). Bestätigte Änderungen werden hier am Auftrag
  // eingefroren (customer_brief) – spätere Brief-Änderungen wirken nie auf einen laufenden Plan.
  const toBackup = (order, reason, t) => {
    // TF-071 §10: ohne geklärte Plattform/Zugangsweg nie zum Backup (= vor jeder möglichen Änderung).
    if (order.platform_required && !order.platform?.access_type) { manual(order, "Plattform/Zugangsweg nicht geklärt – keine Reparatur."); return false; }
    const g = briefGate(order, onboardingDir);
    if (!g.ok) {
      if (order.state !== "WAITING_FOR_CUSTOMER_BRIEF") { transition(order, "WAITING_FOR_CUSTOMER_BRIEF", `${reason} – wartet auf den Kunden-Brief (Inhaltsänderungen bestätigt oder keine)`, t); saveOrder(store, order); }
      else if (order.customer_brief?.status !== g.status) { order.customer_brief = { status: g.status, changes: [] }; order.updated_at = t.toISOString(); saveOrder(store, order); }
      return false;
    }
    if (g.status !== "NOT_REQUIRED") order.customer_brief = { status: g.status, confirmed_at: g.confirmed_at || null, changes: g.changes, frozen_at: t.toISOString() };
    transition(order, "BACKUP", g.status === "NOT_REQUIRED" ? reason : `${reason}; Kunden-Brief ${g.status}${g.changes.length ? ` (${g.changes.length} bestätigte Inhaltsänderung(en))` : ""}`, t);
    saveOrder(store, order); return true;
  };
  // TF-044: Host-Key-Fehler der SSH/SFTP-Transporte nie als «normaler» Fehler schlucken – bis zum Schritt durchreichen.
  const hostKeyStop = (e) => { if (HOST_KEY_STOP_CODES.has(e?.code)) throw e; return e; };
  const audit = (website) => fullSiteAudit(website, { auditor, now });
  // Wurde an der Website bereits etwas verändert (angewendete Fixes oder Deployment)?
  const changedWebsite = (order) => !!order.deployment || Object.values(order.issues || {}).some((i) => ["repaired", "still_broken"].includes(i.repair_status) || i.change_ref);

  // VORHER gegen NACHHER: neue relevante (≥ medium) Befunde, die es vorher nicht gab → Regression.
  const regression = (before, after) => {
    const had = new Set(Object.values(before?.issues || {}).map(issueKey));
    return Object.values(after?.issues || {}).filter((i) => RELEVANT.has(i.severity) && !had.has(issueKey(i))).map((i) => ({ type: i.type, page: i.page, severity: i.severity, evidence: i.evidence }));
  };
  // ---------- TF-045: Browser-Gate ----------
  const browserRequired = () => requireBrowser === true || !!browserValidator;
  const pathKey = (u) => { try { return new URL(u).pathname || "/"; } catch { return "/"; } };
  const issuePage = (order, item) => pathKey(order.issues?.[item.issue_id]?.page || order.website);
  // Geprüfte Seiten: Startseite + Seiten der geplanten Reparaturen (max. 3), nur als Pfade (gleiche URLs für VORHER/NACHHER/Rollback).
  const browserPages = (order) => [...new Set(["/", ...(order.plan || []).map((p) => issuePage(order, p))])].slice(0, 3);
  const browserFindings = (order, page) => (order.plan || []).filter((p) => issuePage(order, p) === page).map((p) => {
    const i = order.issues?.[p.issue_id] || {};
    const rep = typeof p.fix?.replacement === "string" && p.fix.replacement.startsWith("/") ? p.fix.replacement.split(/[?#]/)[0] : null;
    return { type: i.type, broken_path: ["broken_link", "broken_image", "contact_page_broken"].includes(i.type) ? pathKey(i.url) : null, expected_path: rep };
  });
  // phase: baseline (vor der Änderung) | after (nach der Reparatur, mit VORHER-Vergleich) | rollback (Ausgangszustand bestätigen).
  const runBrowser = async (order, base, phase) => {
    const u = new URL(base);
    const pages = {}, decisions = [];
    for (const p of order.browser_baseline?.pages ? Object.keys(order.browser_baseline.pages) : browserPages(order)) {
      const before = order.browser_baseline?.pages?.[p] || { desktop: null, mobile: null };
      const r = await browserValidator.validate({ url: u.origin + p, expected_domain: u.hostname, findings: browserFindings(order, p), phase,
        before_snapshot: phase === "after" ? before : null, validation_scope: { desktop: true, mobile: true, navigation: true } });
      pages[p] = { desktop: safeSnapshot(r.desktop), mobile: safeSnapshot(r.mobile) };
      if (phase === "after") decisions.push(r.decision);
    }
    return { pages, decision: phase === "after" ? combineDecisions(decisions) : null };
  };
  const navOkOf = (pages) => Object.values(pages).every((p) => ["desktop", "mobile"].every((vp) => (p[vp]?.nav?.links_visible || 0) > 0 && (p[vp]?.nav?.targets_failed || 0) === 0));

  const rollbackThen = async (order, adapter, failReason) => {
    const can = typeof adapter?.rollback === "function";
    const r = can ? await adapter.rollback(order, accessCtx(order)).catch(() => ({ ok: false })) : { ok: false };
    order.regression = { ...(order.regression || {}), rolled_back: r.ok === true };
    if (order.browser_gate) order.browser_gate = { ...order.browser_gate, regression: "ROLLBACK" };
    if (r.ok === true && adapter?.direct_live) {
      // Direkt-live-Adapter: Rollback danach erneut prüfen (Website erreichbar, keine neuen relevanten Befunde gegenüber VORHER).
      const after = await audit(order.website).catch(() => ({ ok: false, issues: {} }));
      const reg = after.ok ? regression(order.audit_before, after) : [{ type: "unreachable" }];
      order.regression.rollback_verified = !reg.length;
      if (reg.length) { await informChris(order, "rollback_unverified", failReason); return manual(order, `${failReason} – Rollback ausgeführt, aber die Prüfung danach ist nicht sauber; Website-Zustand manuell prüfen.`); }
    }
    if (r.ok === true && order.browser_baseline && browserRequired()) {
      // TF-045: Browser neu starten, dieselben URLs prüfen und den ursprünglichen Zustand bestätigen (gegenüber der Baseline).
      const rb = browserValidator ? await runBrowser(order, order.website, "rollback").catch(() => null) : null;
      const same = !!rb && Object.entries(order.browser_baseline.pages).every(([p, base]) => rollbackMatchesBaseline(base, rb.pages[p] || {}));
      order.regression.browser_rollback_verified = same;
      if (!same) { await informChris(order, "rollback_unverified", failReason); return manual(order, `${failReason} – Rollback ausgeführt, aber der Browser-Retest bestätigt den Ausgangszustand nicht; Website-Zustand manuell prüfen.`); }
    }
    if (r.ok === true) {
      // Zurückgerollte Fixes gelten nicht mehr als «repariert» (Dashboard/Bericht behaupten nie eine Reparatur nach Rollback).
      for (const i of Object.values(order.issues || {})) if (i.repair_status === "repaired") i.repair_status = "rolled_back";
      return block(order, "REPAIR_FAILED", `${failReason} – auf den letzten sicheren Stand zurückgerollt.`);
    }
    await informChris(order, "rollback_failed", failReason);
    return manual(order, `${failReason} – Rollback ${can ? "fehlgeschlagen" : "über diesen Kanal nicht verfügbar"}; Website-Zustand manuell prüfen.`);
  };

  // ---------- TF-046: Kundenlieferung (CUSTOMER_ORDER_FULFILLMENT) ----------
  // Nur aus READY_FOR_DELIVERY, nur mit bestandenem Abschluss-Gate, gültigem Bericht, verifizierter Adresse und Versandweg.
  // Genau einmal: Draft-ID und Sendeversuch werden VOR dem Versand persistiert; unklarer Ausgang → nie wiederholen (Chris prüft).
  const canDeliver = (order) => !!(order.delivery_email && gmail && typeof gmail.createDraft === "function" && typeof gmail.sendDraft === "function");
  const handOver = (order, status, reason, t) => {
    order.delivery = { ...(order.delivery || {}), status, handover_reason: String(reason).slice(0, 200), handover_at: t.toISOString() };
    order.updated_at = t.toISOString();
    order.state_history.push({ at: t.toISOString(), from: order.state, to: order.state, reason });
    saveOrder(store, order); log("warn", "repair_delivery_handover", { order_id: order.order_id, status });
    return false;
  };
  const finishDelivered = (order, t) => {
    transition(order, completionState(order), completionReason(order, "Abschlussbericht an den Kunden gesendet (CUSTOMER_ORDER_FULFILLMENT) – Auftrag abgeschlossen"), t);
    destroyOrderSecret(store, order, t); // Credential Cleanup unmittelbar nach dem Abschluss
    saveOrder(store, order); log("info", "repair_delivery_completed", { order_id: order.order_id });
    return false;
  };
  async function deliver(order, t) {
    if (order.delivery?.sent_at) return finishDelivered(order, t); // gesendet, aber Abschluss noch nicht gespeichert (Neustart)
    if (["attachment_required", "unclear", "report_unsafe", "failed"].includes(order.delivery?.status)) return false; // liegt bei Chris
    if (!canDeliver(order)) return false; // kein automatischer Versandweg → Chris liefert selbst (completeOrder)
    const gate = completionGate(order);
    if (!gate.ok || !order.report?.body) return handOver(order, "failed", `Lieferung gestoppt: Abschluss-Gate/Bericht unvollständig (${gate.missing.join(", ") || "Bericht"}).`, t);
    const unsafe = reportUnsafe(order.report.body, order);
    if (unsafe) { await informChris(order, "report_unsafe", unsafe); return handOver(order, "report_unsafe", `Bericht enthält unzulässige Angaben (${unsafe}) – kein automatischer Versand, Chris prüft.`, t); }
    const mail = buildRepairDeliveryMail(order);
    if (!mail.inline) { order.delivery_attachment_required = true; return handOver(order, "attachment_required", "ATTACHMENT_REQUIRED: Bericht zu lang für die Mail – Chris hängt die Berichtsdatei an und sendet selbst.", t); }
    if (order.delivery?.send_attempted_at) { await informChris(order, "delivery_unclear", "Versandstatus unklar"); return handOver(order, "unclear", "Versandstatus unklar (früherer Versuch ohne Bestätigung) – kein erneuter Versand, Chris prüft «Gesendet».", t); }
    try {
      if (!order.delivery?.draft_id) {
        const d = await gmail.createDraft({ to: order.delivery_email, subject: mail.subject, body: mail.body, messageClass: FULFILLMENT_CLASS });
        order.delivery = { ...(order.delivery || {}), status: "draft_ready", draft_id: d.draftId, to: order.delivery_email, message_class: FULFILLMENT_CLASS,
          report_hash: sha(order.report.body), created_at: t.toISOString() };
        saveOrder(store, order); // Draft-ID sofort persistieren – ein Neustart erzeugt nie ein Duplikat
      }
      order.delivery = { ...order.delivery, send_attempted_at: t.toISOString() };
      saveOrder(store, order); // VOR dem Versand – ein Absturz danach führt nie zu einer zweiten Mail
      await gmail.sendDraft(order.delivery.draft_id);
    } catch (e) {
      if (order.delivery?.send_attempted_at) { order.delivery = { ...order.delivery, send_attempted_at: null }; saveOrder(store, order); }
      if (TRANSIENT_RE.test(e.message)) { log("warn", "repair_delivery_deferred", { order_id: order.order_id, error: String(e.message).slice(0, 160) }); return false; }
      return handOver(order, "failed", `Automatischer Versand fehlgeschlagen (${String(e.message).slice(0, 120)}) – Bericht bleibt für Chris.`, t);
    }
    order.delivery = { ...order.delivery, status: "sent", sent_at: t.toISOString() };
    saveOrder(store, order);
    log("info", "repair_delivery_sent", { order_id: order.order_id, message_class: FULFILLMENT_CLASS });
    return finishDelivered(order, t);
  }

  // Genau einen Schritt ausführen. Rückgabe true = es ging weiter (erneut aufrufen), false = wartet/fertig/blockiert.
  async function step(order) {
    const t = now();
    const adapter = adapterOf(order);

    // TF-046: stornierter (voided) Verkauf → nie Zugangs-Anfrage, Reparatur oder Lieferung. Schon verändert → Chris entscheidet.
    if (!TERMINAL.has(order.state) && repairSaleVoided(store, order)) {
      if (changedWebsite(order)) { await informChris(order, "sale_voided", "Verkauf storniert, Website bereits verändert"); manual(order, "Verkauf storniert (voided), Website wurde bereits verändert – kein automatischer Rollback, keine Lieferung; Chris entscheidet."); return false; }
      block(order, "BLOCKED_NO_AUTHORIZATION", "Verkauf storniert (voided) – kein bestätigter Auftrag: keine Zugangs-Anfrage, keine Reparatur, keine Lieferung.");
      destroyOrderSecret(store, order, t); saveOrder(store, order); return false;
    }

    // Zahlung fiel während der Arbeit unter die Schwelle (void/refund): vor jeder Änderung → warten; danach → Chris entscheidet.
    if (WORK_STATES.has(order.state)) {
      const gate = paymentGateForOrder(store, order);
      if (!gate.satisfied) {
        order.payment = gate;
        if (changedWebsite(order)) { block(order, "PAYMENT_REVIEW_REQUIRED", `Zahlung unter die Schwelle gefallen (${gateText(gate)}), Website wurde bereits verändert – kein automatischer Rollback, Chris entscheidet.`); return false; }
        transition(order, "PAYMENT_REQUIRED", `Zahlung unter die Schwelle gefallen (${gateText(gate)}) – noch nichts verändert, wartet.`, t);
        saveOrder(store, order); return false;
      }
    }

    if (order.state === "ORDER_RECEIVED") {
      if (authorizationOk(order)) { transition(order, "ACCESS_CHECK", "Freigabe liegt vor", t); saveOrder(store, order); return true; }
      transition(order, "AUTHORIZATION_REQUIRED", "Keine dokumentierte Kundenfreigabe – nur Audit, keine Änderung", t); saveOrder(store, order); return true;
    }

    if (order.state === "AUTHORIZATION_REQUIRED") {
      // Ohne Freigabe: genau EIN passiver Audit (lesend, wie ein Besucher) als Vorbereitung – sonst nichts.
      if (!order.audit_preview) {
        order.audit_preview = await audit(order.website);
        order.updated_at = t.toISOString();
        saveOrder(store, order);
        log("info", "repair_preview_audit", { order_id: order.order_id, issues: Object.keys(order.audit_preview.issues).length });
      }
      if (authorizationOk(order)) { transition(order, "ACCESS_CHECK", "Freigabe liegt vor", t); saveOrder(store, order); return true; }
      // TF-041: Zahlung ist KEINE Freigabe. Ist die Schwelle erfüllt, bekommt der Kunde den sicheren Link – dort erteilt er
      // Zugang UND (Pflicht) die Reparaturfreigabe. Vorher: keine Anfrage, kein Intake.
      const gate = paymentGateForOrder(store, order);
      if (!samePaid(order.payment, gate)) { order.payment = gate; order.updated_at = t.toISOString(); saveOrder(store, order); }
      if (gate.satisfied && canRequestAccess(order) && !order.access_request?.sent_at) {
        transition(order, "ACCESS_REQUESTED", `Zahlungsschwelle erfüllt (${geText(gate)}) – sicherer Link für Zugang + Freigabe`, t);
        saveOrder(store, order); return true;
      }
      return false; // wartet auf Zahlung bzw. Freigabe
    }

    if (order.state === "PAYMENT_REQUIRED") {
      // ZAHLUNGSSCHWELLE (TF-041): wird je Lauf neu geprüft – vor kumulativ CHF 240 keine Zugangsdaten anfordern,
      // kein Login, keine Website-Änderung, keine Reparatur. Verbucht Chris die Zahlung, läuft der Auftrag automatisch weiter.
      const gate = paymentGateForOrder(store, order);
      if (!gate.satisfied) {
        if (!samePaid(order.payment, gate)) { order.payment = gate; order.updated_at = t.toISOString(); saveOrder(store, order); }
        return false; // wartet auf Zahlung
      }
      order.payment = gate;
      const next = authorizationOk(order) ? "ACCESS_CHECK" : order.access_request?.sent_at ? "ACCESS_REQUESTED" : "AUTHORIZATION_REQUIRED";
      transition(order, next, `Zahlungsschwelle erfüllt (${geText(gate)})`, t); saveOrder(store, order); return true;
    }

    if (order.state === "ACCESS_CHECK") {
      if (!domainBound(order)) { block(order, "BLOCKED_NO_AUTHORIZATION", "Freigabe fehlt oder Domain (Auftrag/Freigabe/Zugang) stimmt nicht überein."); return false; }
      // ZAHLUNGSSCHWELLE (TF-041) VOR jedem Zugang: ohne kumulativ CHF 240 wird hier nichts geprüft und nichts angefragt.
      const gate = paymentGateForOrder(store, order);
      order.payment = gate;
      if (!gate.satisfied) {
        transition(order, "PAYMENT_REQUIRED", `Zahlung ausstehend: ${gateText(gate)} eingegangen (payments.js record ${order.order_id}).`, t);
        saveOrder(store, order); return false;
      }
      if (!order.stack) {
        const probe = order.audit_preview || await audit(order.website);
        if (!order.audit_preview) { order.audit_preview = probe; }
        order.stack = detectStack({ html: probe.html || "" });
        // Eine EXPLIZITE Zuordnung durch Chris (adapter.claims, z. B. Domain→Repo→Netlify-Site) hat Vorrang vor der
        // Markup-Erkennung: eine statische Seite, deren Produktionsworkflow über GitHub+Netlify läuft, gehört zu dem Adapter.
        // claims liest nur die eigene Mapping-Datei – es wird weiterhin nie ein Repository erraten.
        for (const [type, a] of Object.entries(adapters)) {
          if (typeof a?.claims === "function" && await a.claims(order).catch(() => false)) { order.stack = { type, evidence: ["explicit_mapping"] }; break; }
        }
        saveOrder(store, order);
      }
      if (router && intakeReceived(order)) {
        // TF-042: Adapter nach tatsächlichen Fähigkeiten wählen (Zugangsart ≠ Stack) – genau einmal, Ergebnis am Auftrag.
        if (!order.route) {
          const gh = adapters.github_netlify;
          const has_mapping = typeof gh?.claims === "function" ? await gh.claims(order).catch(() => false) : false;
          const r = await Promise.resolve(router.route({ order, access_type: order.access_intake.connector_type, detected_stack: order.stack.type, accessCtx: accessCtx(order), has_mapping }))
            .catch(() => ({ adapter: null, state: "BLOCKED_UNSUPPORTED_STACK", reason: "Routing nicht möglich." }));
          order.route = { adapter: r.adapter || null, label: r.label || null, access_type: order.access_intake.connector_type, detected_stack: order.stack.type, reason: String(r.reason || "").slice(0, 200), routed_at: t.toISOString() };
          saveOrder(store, order);
          if (r.state) { block(order, r.state, r.reason || "Kein unterstützter Reparaturweg."); return false; }
        }
      } else {
        // Sicher übermittelter Zugang mit passender Zugangsart → dazugehöriger Adapter (nur wenn konfiguriert).
        const viaForm = intakeReceived(order) ? CONNECTOR_ADAPTER[order.access_intake.connector_type] : null;
        if (viaForm && adapters[viaForm] && order.stack.type !== viaForm && !adapters[order.stack.type]) { order.stack = { type: viaForm, evidence: ["secure_order_access_form"] }; saveOrder(store, order); }
      }
      // TF-043: Zugangsprofil automatisch vorbereiten (nur lesend), bevor irgendein Adapter mit dem Zugang arbeitet.
      if (preflight && router && intakeReceived(order) && order.route?.adapter && order.access_profile?.profile_status !== "PROFILE_READY") {
        transition(order, "ACCESS_PROFILE_PREFLIGHT", `Zugang erhalten (${order.route.label || order.route.adapter}) – Zugangsprofil wird automatisch und nur lesend vorbereitet`, t);
        saveOrder(store, order); return true;
      }
      if (order.stack.type === "other" && !intakeReceived(order)) { block(order, "BLOCKED_UNSUPPORTED_STACK", "Stack nicht erkannt – kein sicher unterstützter Reparaturweg."); return false; }
      const a = adapterOf(order);
      if (!a || typeof a.checkAccess !== "function") return requestAccessOrBlock(order, intakeReceived(order)
        ? `Zugang (${order.access_intake.connector_type}) erhalten, aber kein automatischer Reparaturweg für Stack "${order.stack.type}" – Chris übernimmt manuell.`
        : `Kein sicherer Zugangsweg für Stack "${order.stack.type}" konfiguriert. Zugangsdaten werden nie erraten.`);
      const acc = await a.checkAccess(order, accessCtx(order)).catch((e) => ({ ok: false, error: hostKeyStop(e).message }));
      // Unsicherer Zugang (root, Systemverzeichnis …) wird nie „repariert“ – eigener Endzustand, keine zweite Anfrage.
      if (acc?.ok !== true && ["BLOCKED_UNSAFE_ACCESS", "BLOCKED_UNSUPPORTED_STACK"].includes(acc?.blocked_state)) { block(order, acc.blocked_state, `Zugang abgelehnt (${String(acc.reason || "unsicher").slice(0, 60)}) – keine automatische Reparatur.`); return false; }
      if (acc?.ok !== true) {
        const why = `Zugangsprüfung fehlgeschlagen${acc?.reason ? ` (${String(acc.reason).slice(0, 60)})` : ""}`;
        const vf = await validationFailed(order, why); // TF-071: ungültiger Kundenzugang → neuer Link, nie erneut versuchen
        if (vf !== null) return vf;
        return requestAccessOrBlock(order, `${why} – keine Änderung ohne sicheren Zugang.`);
      }
      const caps = Array.isArray(acc.capabilities) ? onlyCapabilities(acc.capabilities) : (router?.capabilitiesOf?.(order.route?.adapter || order.stack.type) || null);
      order.access = { connector: acc.connector || order.stack.type, ok: true, checked_at: t.toISOString(), ...(caps ? { capabilities: caps } : {}) }; // nie mehr Felder übernehmen (keine Secrets)
      if (order.platform_required) order.access_validation = { ...(order.access_validation || {}), status: "ACCESS_VALIDATED", validated_at: t.toISOString() };
      if (caps && !hasCapabilities(caps, ["BACKUP", "ROLLBACK"])) { manual(order, "Zugang ohne zuverlässiges Backup/Rollback – keine automatische Reparatur."); return false; }
      return toBackup(order, "Zugang geprüft", t);
    }

    if (order.state === "WAITING_FOR_CUSTOMER_BRIEF") {
      // TF-066: wartet auf den Kunden-Brief (Dialog im Mail-Worker). Je Lauf neu geprüft; nichts wird verändert.
      return toBackup(order, "Zugang geprüft", t);
    }

    if (order.state === "ACCESS_REQUESTED") {
      // Nach erfüllter Zahlungsschwelle wird der Kunde GENAU EINMAL automatisch per Service-Mail (CUSTOMER_ACCESS_REQUEST) um
      // SICHEREN Zugang gebeten – über einen auftragsgebundenen One-Time-Link. Danach wartet der Auftrag auf die Einreichung
      // (Zugang + Pflicht-Freigabe, syncAccessIntake) bzw. einen von Chris konfigurierten Adapter-Zugang. Nie Passwörter per Mail.
      const gate = paymentGateForOrder(store, order);
      order.payment = gate;
      if (!gate.satisfied) { transition(order, "PAYMENT_REQUIRED", `Zahlungsschwelle nicht mehr erfüllt (${gateText(gate)}).`, t); saveOrder(store, order); return false; }
      if (!order.access_request?.sent_at) {
        if (!canRequestAccess(order)) {
          block(order, "BLOCKED_NO_ACCESS", "Keine automatische Zugangs-Anfrage möglich (Kundenadresse, sicherer Link oder Versandweg fehlt) – Zugangsdaten werden nie erraten."); return false;
        }
        // Send-Idempotenz: ein früherer Versuch ohne gesicherten Ausgang wird NIE blind wiederholt (Chris prüft «Gesendet»).
        // TF-066: erste Anfrage = Onboarding-Start (Zugang + Inhaltsfrage); automatische Neu-Ausstellung nur nach abgelaufenem Link.
        const re = order.access_reissue || null;
        // TF-071: vor der ERSTEN Anfrage Plattform/Hosting klären – der Link entsteht erst mit bekanntem Zugangsweg.
        if (onboardingDir && !re && (order.platform_required || !order.access_request_history?.length)) {
          const ps = await platformStep(order, t);
          if (ps !== "ready") return false;
        }
        const kind = order.platform_required ? order.platform?.access_type || null : null;
        const r = await sendLinkMail(order, "access_request", {
          register: kind ? { access_kind: kind } : {}, // Formular zeigt nur die Felder dieses Zugangswegs
          build: (x) => (re ? buildReissueMail(order, { ...x, reason: re.reason }) : (onboardingDir && (order.onboarding_required = true),
            buildAccessRequestMail(order, { ...x, onboarding: !!onboardingDir, access_kind: kind, askContent: !order.hosting_question?.sent_at }))),
          meta: re ? (re.seq ? { purpose: "reissue", seq: re.seq } : { purpose: "revalidate" }) : { purpose: "first" },
          events: { unclear: "repair_access_request_unclear", deferred: "repair_access_request_deferred", sent: "repair_access_requested" } });
        if (r === "deferred") return false;
        if (r?.error) { block(order, "BLOCKED_NO_ACCESS", `Automatische Zugangs-Anfrage fehlgeschlagen: ${r.error}`); return false; }
        if (re && r === "sent") { if (re.seq) order.onboarding_reissues = { ...(order.onboarding_reissues || {}), [re.seq]: "sent" }; order.access_reissue = null; saveOrder(store, order); }
      }
      // Sicherer Zugang + Freigabe über das Formular eingegangen → Zugangsprüfung (Domain-Bindung wird dort erneut geprüft).
      if (intakeReceived(order)) {
        if (!domainBound(order)) { block(order, "BLOCKED_NO_AUTHORIZATION", "Domain des Zugangs/der Freigabe stimmt nicht mit dem Auftrag überein."); return false; }
        transition(order, "ACCESS_CHECK", "Sicherer Zugang und Reparaturfreigabe über das Auftragsformular erhalten", t); saveOrder(store, order); return true;
      }
      // Alternativ: Freigabe liegt vor und Chris hat den sicher erhaltenen Zugang als Adapter konfiguriert.
      const a = adapterOf(order);
      if (authorizationOk(order) && a && typeof a.checkAccess === "function") {
        const acc = await a.checkAccess(order, accessCtx(order)).catch((e) => { hostKeyStop(e); return { ok: false }; });
        if (acc?.ok === true) {
          order.access = { connector: acc.connector || order.stack.type, ok: true, checked_at: t.toISOString() }; // nie Secrets
          return toBackup(order, "Sicherer Zugang erhalten und geprüft", t);
        }
      }
      return false; // wartet auf sicheren Zugang (+ Freigabe)
    }

    if (order.state === "WAITING_FOR_HOSTING_INFO") {
      // TF-071: wartet auf die Plattform-Angabe des Kunden (Mail-Worker parst sie deterministisch in feste Wörter → Brief). Kein Link,
      // kein Zugang, keine Änderung. Mit Angabe: Kundenangabe + automatischer Befund (≥ MEDIUM) → minimaler Zugangsweg → ACCESS_REQUESTED.
      const gate = paymentGateForOrder(store, order);
      if (!gate.satisfied) { order.payment = gate; transition(order, "PAYMENT_REQUIRED", `Zahlungsschwelle nicht mehr erfüllt (${gateText(gate)}).`, t); saveOrder(store, order); return false; }
      const b = onboardingDir ? readBrief(onboardingDir, order.order_id) : null;
      const stated = cleanStated(b?.platform);
      if (!stated || b?.manual) return false;
      const merged = resolvePlatform(order.platform || {}, stated);
      if (!merged.access_type) {
        if (order.platform?.status !== "CUSTOMER_UNCLEAR") {
          order.platform = { ...order.platform, status: "CUSTOMER_UNCLEAR", updated_at: t.toISOString() };
          await informChris(order, "platform_unclear", "Plattform-Angabe des Kunden reicht nicht für einen Zugangsweg"); saveOrder(store, order);
        }
        return false;
      }
      const p = cleanPlatform(merged);
      order.platform = { ...order.platform, ...p, connector_type: connectorOf(merged.access_type), detection_source: "customer", status: "IDENTIFIED",
        cms_confidence: merged.cms_confidence, deployment_confidence: merged.deployment_confidence, hosting_confidence: merged.hosting_confidence, identified_at: t.toISOString(), updated_at: t.toISOString() };
      transition(order, "ACCESS_REQUESTED", `Plattform vom Kunden angegeben (${[nameOf(p.cms_platform), nameOf(p.deployment_platform), nameOf(p.panel), nameOf(p.hosting_provider)].filter(Boolean).join(", ")}) – sicherer Link für Zugangsweg ${p.access_type}`, t);
      saveOrder(store, order); return true;
    }

    if (order.state === "ACCESS_PROFILE_PREFLIGHT") {
      // TF-043: Profil nur lesend erzeugen. Ergebnis NUR bei eindeutigem, sicherem Befund PROFILE_READY – sonst warten/stoppen.
      if (!domainBound(order)) { block(order, "BLOCKED_NO_AUTHORIZATION", "Freigabe fehlt oder Domain (Auftrag/Freigabe/Zugang) stimmt nicht überein."); return false; }
      if (!preflight || !order.route?.adapter) { manual(order, "Automatischer Profil-Preflight nicht verfügbar – Zugangsprofil manuell anlegen."); return false; }
      const prev = order.access_profile || {};
      const r = await preflight.run(order, { adapter: order.route.adapter, accessCtx: accessCtx(order) }).catch(() => ({ profile_status: "PREFLIGHT_RETRY", reason: "connect_failed" }));
      if (r.profile_status === "PREFLIGHT_RETRY") {
        const attempts = (prev.attempts || 0) + 1;
        order.access_profile = { ...prev, attempts, reason: String(r.reason || "").slice(0, 60), updated_at: t.toISOString() };
        if (attempts >= MAX_PREFLIGHT_ATTEMPTS) { await informChris(order, "preflight_failed", profileReason(r.reason)); manual(order, `Zugangsprofil: ${profileReason(r.reason)} (${attempts} Versuche).`); return false; }
        saveOrder(store, order); log("warn", "repair_profile_preflight_retry", { order_id: order.order_id, reason: r.reason }); return false;
      }
      order.access_profile = profileRecord(r, { prev, now: t });
      const why = profileReason(r.reason);
      log("info", "repair_profile_preflight", { order_id: order.order_id, profile_status: order.access_profile.profile_status, reason: order.access_profile.reason });
      switch (order.access_profile.profile_status) {
        case "PROFILE_READY":
          transition(order, "ACCESS_CHECK", `PROFILE_READY – Zugangsprofil automatisch erstellt (${order.access_profile.interface}${order.access_profile.webroot_source ? `, Webroot: ${order.access_profile.webroot_source}` : ""}${order.access_profile.host_key_source ? `, Host-Key: ${order.access_profile.host_key_source}` : ""})`, t);
          saveOrder(store, order); return true;
        case "HOST_KEY_CONFIRMATION_REQUIRED":
          transition(order, "HOST_KEY_CONFIRMATION_REQUIRED", why, t); saveOrder(store, order); return true;
        case "WAITING_FOR_ACCESS_PROFILE":
          order.access_profile.manual_profile_seen = preflight.manualProfileFor?.(order)?.updated_at || null; // Stand des Chris-Profils beim Warten
          transition(order, "WAITING_FOR_ACCESS_PROFILE", `${why} Chris ergänzt das Zugangsprofil (router.js --profile); danach läuft der Auftrag selbst weiter.`, t);
          await informChris(order, "access_profile_required", why); saveOrder(store, order); return false;
        case "BLOCKED_UNSAFE_ACCESS": block(order, "BLOCKED_UNSAFE_ACCESS", `Zugang abgelehnt: ${why}`); return false;
        case "BLOCKED_NO_ACCESS": {
          const vf = await validationFailed(order, `Zugangsprüfung fehlgeschlagen (${String(r.reason || "").slice(0, 40)})`); // TF-071
          if (vf !== null) return vf;
          return requestAccessOrBlock(order, `Zugangsprüfung fehlgeschlagen (${String(r.reason || "").slice(0, 40)}) – keine Änderung ohne sicheren Zugang.`);
        }
        default: await informChris(order, "access_profile_review", why); manual(order, `Zugangsprofil: ${why}`); return false;
      }
    }

    if (order.state === "HOST_KEY_CONFIRMATION_REQUIRED") {
      // Unbekannter SSH-Host-Key wird NIE automatisch vertraut. Weiter erst nach Bestätigung (Kunde über den sicheren Link,
      // Chris per --confirm-host-key) oder wenn Chris den Fingerprint im Profil hinterlegt. Bis dahin keine Verbindung mit Zugangsdaten.
      const ap = order.access_profile || {};
      if (ap.host_key_rejected_at) { await informChris(order, "host_key_rejected", "Kunde meldet abweichenden Fingerprint"); manual(order, "Kunde meldet: Server-Fingerprint stimmt nicht mit der Angabe des Hosters überein – keine Verbindung mit Zugangsdaten, Chris prüft."); return false; }
      const confirmed = HOST_KEY_CONFIRMED_SOURCES.includes(ap.host_key_source) && !!ap.host_key_sha256;
      if (confirmed || preflight?.manualProfileFor?.(order)?.host_key_sha256) {
        transition(order, "ACCESS_PROFILE_PREFLIGHT", confirmed ? `Host-Key bestätigt (${ap.host_key_source})` : "Host-Key von Chris im Zugangsprofil hinterlegt", t); saveOrder(store, order); return true;
      }
      if (!order.host_key_request?.sent_at && !order.host_key_request?.failed_at && canRequestAccess(order) && ap.host_key_candidate) {
        const r = await sendLinkMail(order, "host_key_request", { register: { purpose: "host_key_confirmation", host_key_candidate: ap.host_key_candidate },
          build: (x) => buildHostKeyConfirmationMail(order, x), extra: { host_key_candidate: ap.host_key_candidate }, meta: { purpose: "host_key" },
          events: { unclear: "repair_host_key_request_unclear", deferred: "repair_host_key_request_deferred", sent: "repair_host_key_requested" } });
        if (r?.error) {
          order.host_key_request = { ...(order.host_key_request || {}), failed_at: t.toISOString() };
          await informChris(order, "host_key_request_failed", r.error); saveOrder(store, order);
        }
      }
      return false; // wartet auf Bestätigung
    }

    if (order.state === "WAITING_FOR_ACCESS_PROFILE") {
      // Wartet, bis Chris das Profil ergänzt (oder ändert) – dann genau ein neuer Preflight. Nie raten.
      const mp = preflight?.manualProfileFor?.(order);
      if (mp?.updated_at && mp.updated_at !== (order.access_profile?.manual_profile_seen || null)) {
        transition(order, "ACCESS_PROFILE_PREFLIGHT", "Zugangsprofil von Chris ergänzt – neuer Preflight", t); saveOrder(store, order); return true;
      }
      return false;
    }

    if (order.state === "BACKUP") {
      const branch = `repair/${order.order_id}`;
      const b = await adapter.backup(order, { branch }, accessCtx(order)).catch((e) => ({ error: hostKeyStop(e).message }));
      if (!b || !b.production_ref || !b.backup_ref || !b.rollback_point) { manual(order, "Backup unvollständig (Produktionsstand/Backup/Rollback-Punkt) – ohne Rollback keine Reparatur."); return false; }
      order.backup = { production_ref: String(b.production_ref), backup_ref: String(b.backup_ref), rollback_point: String(b.rollback_point),
        branch: String(b.branch || branch), created_at: t.toISOString() };
      transition(order, "FULL_AUDIT", "Backup + Rollback-Punkt erstellt", t); saveOrder(store, order); return true;
    }

    if (order.state === "FULL_AUDIT") {
      const a = await audit(order.website);
      if (!a.ok) { manual(order, "Website beim Voll-Audit nicht erreichbar – Zustand unklar, nicht experimentieren."); return false; }
      order.audit_before = a;
      order.issues = a.issues;
      transition(order, "REPAIR_PLAN", `Voll-Audit: ${Object.keys(a.issues).length} Befunde`, t); saveOrder(store, order); return true;
    }

    if (order.state === "REPAIR_PLAN") {
      // TF-066: vom Kunden bestätigte Inhaltsänderungen = zusätzliche, ausdrücklich autorisierte Plan-Einträge. Gleiche Sicherheit wie
      // jeder Fix: lokalisieren (nur sichtbarer Text, eindeutig), Backup, Minimaländerung, Validierung, Browser, Regression, Retest,
      // Rollback. Nicht eindeutig/geschützt/nicht unterstützt → manueller Punkt (nie raten, nie global ersetzen).
      for (const [n, c] of (order.customer_brief?.changes || []).entries()) {
        const id = `customer-${n + 1}`;
        if (order.issues[id]) continue;
        order.issues[id] = { issue_id: id, type: "customer_content_change", page: order.website, url: order.website, severity: "low", repairable: true,
          repair_status: "open", customer_change: { kind: c.kind, page: c.page || null, section: c.section || null, old_text: c.old_text || null, new_text: c.new_text || null, address: c.address || null },
          customer_text: `Inhaltsänderung nach Ihrem Wunsch – ${changeText(c)}`, customer_text_vi: `Thay đổi nội dung theo yêu cầu – ${changeText(c, true)}`,
          evidence: "Vom Kunden im Auftragsdialog bestätigt" };
      }
      const repairables = Object.values(order.issues).filter((i) => i.repairable);
      for (const i of Object.values(order.issues)) if (i.protected) order.manual_review.push({ at: t.toISOString(), reason: `Befund ${i.issue_id} liegt auf einer geschützten Seite (${i.page}) – nur mit zusätzlicher expliziter Freigabe.`, issue_id: i.issue_id });
      const plan = [];
      for (const i of repairables) {
        const loc = await adapter.locate(i, order, accessCtx(order)).catch((e) => { hostKeyStop(e); return null; });
        const review = (reason) => { order.issues[i.issue_id].repair_status = "needs_review"; order.manual_review.push({ at: t.toISOString(), reason, issue_id: i.issue_id }); };
        if (!loc || !loc.target || !loc.cause) { review(i.type === "customer_content_change" ? `Bestätigte Inhaltsänderung ${i.issue_id} auf der Website nicht eindeutig auffindbar (oder geschützte Seite/zu viele Stellen) – manuell.`
          : `Ursache für ${i.type} (${i.page}) nicht eindeutig – keine automatische Reparatur.`); continue; } // nie raten
        if (i.type === "customer_content_change" && typeof loc.fix?.page_url === "string" && normDomain(loc.fix.page_url) === normDomain(order.domain)) order.issues[i.issue_id].page = loc.fix.page_url;
        const caps = order.access?.capabilities || null;
        const need = Array.isArray(loc.required_capabilities) ? loc.required_capabilities : [];
        const adapterName = order.route?.adapter || order.stack.type;
        const item = { issue_id: i.issue_id, issue: i.type, adapter: adapterName, capability: need, target: String(loc.target), cause: String(loc.cause),
          before_hash: loc.before_hash || null, planned_change: String(loc.planned_change || "kleinste sinnvolle Korrektur"), risk: loc.risk || "niedrig",
          validation: "Objekt-Hash + öffentliche Seite erneut prüfen, Voll-Audit VORHER/NACHHER, Desktop 1440×900 + Smartphone 390×844",
          test_method: "Befund nach der Änderung erneut prüfen (gleiche Seite, gleicher Ablauf)",
          rollback: adapter.direct_live ? "Originalinhalt aus dem Objekt-Backup atomar wiederherstellen, danach erneut prüfen" : `Branch ${order.backup.branch} verwerfen bzw. Rollback auf ${order.backup.rollback_point}`,
          rollback_method: adapter.direct_live ? "Objekt-Backup (Originalinhalt + Hash)" : `Branch ${order.backup.branch} verwerfen bzw. Rollback auf ${order.backup.rollback_point}`,
          // Deterministische Fix-Details des Adapters (z. B. Datei + Ersetzung) – reine Daten, nie Secrets; überleben einen Neustart.
          fix: loc.fix ? JSON.parse(JSON.stringify(loc.fix)) : null };
        if (isProtectedChange(item)) { review(`Geplante Änderung für ${i.issue_id} berührt einen geschützten Bereich – nur mit zusätzlicher expliziter Freigabe.`); continue; }
        // Capability-Modell (TF-042): nur Fixes, deren benötigte Fähigkeiten der geprüfte Zugang tatsächlich hat.
        if (caps && need.length && !hasCapabilities(caps, need)) { review(`Zugang hat nicht alle nötigen Fähigkeiten (${need.filter((c) => !caps.includes(c)).join(", ")}) – keine automatische Reparatur.`); continue; }
        // Ohne Preview (direkt live): nur Minimal-Fix mit niedrigem Risiko und Backup/Rollback.
        if (adapter.direct_live && (item.risk !== "niedrig" || !caps || !hasCapabilities(caps, ["BACKUP", "ROLLBACK"]))) { review(`Änderung ohne Preview nur bei niedrigem Risiko mit Backup + Rollback – ${i.issue_id} manuell.`); continue; }
        plan.push(item);
      }
      order.plan = plan;
      // Keine automatischen Massenänderungen.
      if (plan.length > MAX_AUTO_FIXES_PER_ORDER) { for (const p of plan) order.issues[p.issue_id].repair_status = "needs_review"; order.plan = []; manual(order, `${plan.length} automatisch behebbare Befunde – mehr als ${MAX_AUTO_FIXES_PER_ORDER} je Auftrag, keine Massenänderung, manuelle Prüfung.`); return false; }
      if (!plan.length && repairables.length) { manual(order, "Kein Befund mit eindeutiger Ursache automatisch reparierbar – manuelle Prüfung nötig."); return false; }
      if (plan.length && browserRequired()) {
        // TF-045: Browser-Baseline der betroffenen Seiten VOR jeder Änderung (Desktop + Smartphone, nur sichere Metadaten).
        // Ohne echten Browser keine automatische CHF-480-Reparatur – fail closed, es wurde nichts verändert.
        if (!browserValidator) { await informChris(order, "browser_unavailable", "Browser-Validierung nicht verfügbar"); manual(order, "Browser-Validierung (Chromium) nicht verfügbar – ohne echten Browser-Retest keine automatische Reparatur (fail closed). Nichts verändert."); return false; }
        const base = await runBrowser(order, order.website, "baseline").catch(() => null);
        if (!base || Object.values(base.pages).some((p) => p.desktop?.load_ok !== true || p.mobile?.load_ok !== true)) { manual(order, "Browser-Baseline nicht erstellbar (Seite lädt im Browser nicht wie erwartet) – Zustand unklar, nichts verändert."); return false; }
        order.browser_baseline = { pages: base.pages, created_at: t.toISOString() };
        order.browser_gate = { required: true, desktop: "WARTET", mobile: "WARTET", navigation: "WARTET", regression: null, level: null };
      }
      transition(order, plan.length ? "REPAIRING" : "VALIDATION", plan.length ? `Plan: ${plan.length} Reparaturen` : "Keine automatisch behebbaren Befunde – nur Prüfung/Bericht", t);
      saveOrder(store, order); return true;
    }

    if (order.state === "REPAIRING") {
      let okCount = 0;
      for (const item of order.plan) {
        if (order.issues[item.issue_id].repair_status === "repaired") { okCount++; continue; } // nach Neustart nie doppelt schreiben
        // Domain-Bindung unmittelbar vor JEDEM Write (der Adapter prüft zusätzlich Zugangs- und Live-Domain).
        if (!domainBound(order)) { if (changedWebsite(order)) { await rollbackThen(order, adapter, "Domain-Bindung vor dem Schreiben verletzt – STOP"); return false; } block(order, "BLOCKED_NO_AUTHORIZATION", "Domain-Bindung vor dem Schreiben verletzt – STOP."); return false; }
        const r = await adapter.applyFix(item, order, accessCtx(order)).catch((e) => ({ ok: false, error: hostKeyStop(e).message }));
        if (r?.domain_mismatch) { order.issues[item.issue_id].repair_status = "repair_failed"; saveOrder(store, order);
          if (changedWebsite(order)) { await rollbackThen(order, adapter, "Weiterleitung/Domain stimmt vor dem Schreiben nicht – STOP"); return false; }
          manual(order, "Weiterleitung/Domain stimmt vor dem Schreiben nicht – STOP, nichts verändert."); return false; }
        order.issues[item.issue_id].repair_status = r?.ok === true ? "repaired" : "repair_failed";
        if (r?.ok === true) { okCount++; if (r.change_ref) order.issues[item.issue_id].change_ref = String(r.change_ref);
          if (r.before_hash) order.issues[item.issue_id].before_hash = String(r.before_hash); if (r.after_hash) order.issues[item.issue_id].after_hash = String(r.after_hash); }
        saveOrder(store, order); // jeder Fix einzeln persistiert – Neustart verliert nichts
      }
      if (!okCount) { block(order, "REPAIR_FAILED", "Keine der geplanten Reparaturen konnte angewendet werden."); return false; }
      transition(order, "VALIDATION", `${okCount}/${order.plan.length} Reparaturen angewendet`, t); saveOrder(store, order); return true;
    }

    if (order.state === "VALIDATION") {
      // Ohne Build-/Prüfschritt des Adapters gilt die Validierung nur bei rein statischen Stacks als möglich – sonst fail closed.
      let v;
      // Direkt-live-Adapter (WordPress/SFTP/SSH, kein Preview): jede fehlgeschlagene Prüfung → sofort Rollback, nie „liegen lassen“.
      const failValidation = async (reason) => { if (adapter.direct_live && changedWebsite(order)) { saveOrder(store, order); await rollbackThen(order, adapter, reason); return false; } block(order, "VALIDATION_FAILED", reason); return false; };
      if (typeof adapter.validate === "function") v = await adapter.validate(order, accessCtx(order)).catch((e) => ({ build_ok: false, error: hostKeyStop(e).message }));
      else if (order.plan.length && !["static", "github_netlify"].includes(order.stack.type)) { manual(order, `Stack "${order.stack.type}" ohne Build-/Prüfschritt – Validierung nicht eindeutig, nicht experimentieren.`); return false; }
      else v = { build_ok: true };
      if (v?.build_ok !== true) return failValidation("Build/Prüfung nach der Reparatur nicht erfolgreich.");
      const target = v.preview_url || order.website;
      const after = await audit(target);
      if (!after.ok) return failValidation("Seite nach der Reparatur nicht ladbar.");
      // Jeder reparierte Befund muss weg sein (gleiche Seite/gleicher Typ) – sonst ist die Reparatur nicht bestanden.
      const remaining = new Set(Object.values(after.issues).map(issueKey));
      const unresolved = Object.values(order.issues).filter((i) => i.repair_status === "repaired" && remaining.has(issueKey(i)));
      if (unresolved.length) {
        for (const i of unresolved) order.issues[i.issue_id].repair_status = "still_broken";
        return failValidation(`${unresolved.length} reparierte(r) Befund(e) weiterhin vorhanden.`);
      }
      const reg = regression(order.audit_before, after);
      order.validation = { build_ok: true, preview_url: v.preview_url || null, target, audited_at: after.audited_at, open_issues: Object.keys(after.issues).length,
        open_keys: [...remaining].slice(0, 500) }; // TF-055: nur Typ|Pfad – für den CRM-Stand nach der Reparatur
      if (reg.length) { order.regression = { found: reg }; saveOrder(store, order); await rollbackThen(order, adapter, `Regression: ${reg.length} neue(r) relevante(r) Befund(e) nach der Reparatur`); return false; }
      order.regression = { found: [] };
      transition(order, "RETEST", "Validierung bestanden, keine Regression", t); saveOrder(store, order); return true;
    }

    if (order.state === "RETEST") {
      const target = order.validation?.preview_url || order.website;
      // Passiver Abruf (Regression-Gate auch im Retest): neue relevante Befunde gegenüber VORHER → nicht bestanden.
      const desktopAudit = await audit(target);
      const passiveOk = desktopAudit.ok && !regression(order.audit_before, desktopAudit).length;
      let desktop, mobile;
      if (order.browser_gate?.required) {
        // TF-045: echter Browser (Chromium) – Desktop + Smartphone, Navigation, reparierter Befund, VORHER/NACHHER-Vergleich.
        const r = browserValidator ? await runBrowser(order, target, "after").catch(() => null) : null;
        if (!r) {
          order.browser_gate = { ...order.browser_gate, desktop: "NEIN", mobile: "NEIN" };
          order.retest = { desktop: { ok: false, method: "Browser-Prüfung nicht verfügbar" }, mobile: { ok: false, method: "Browser-Prüfung nicht verfügbar" }, http_ok: passiveOk, browser: false, tested_at: t.toISOString(), target };
          await informChris(order, "browser_unavailable", "Browser-Retest nicht verfügbar");
          manual(order, "Browser-Retest nicht verfügbar – kein Abschluss ohne Desktop-/Mobile-Browserprüfung (fail closed); Website-Zustand manuell prüfen."); return false;
        }
        const dec = r.decision;
        order.browser_validation = { pages: r.pages, verdict: dec.verdict, level: dec.level, codes: dec.codes, tested_at: t.toISOString() };
        order.browser_gate = { ...order.browser_gate, desktop: dec.desktop_ok ? "JA" : "NEIN", mobile: dec.mobile_ok ? "JA" : "NEIN", navigation: navOkOf(r.pages) ? "JA" : "NEIN",
          level: dec.level, regression: dec.verdict === "PASS" ? "KEINE" : "GEFUNDEN", checked_at: t.toISOString() };
        desktop = { ok: passiveOk && dec.desktop_ok, method: "Browser-Prüfung Desktop 1440×900", problems: dec.codes };
        mobile = { ok: dec.mobile_ok, method: "Browser-Prüfung Smartphone 390×844", problems: dec.codes };
        if (dec.verdict === "ROLLBACK") order.regression = { found: dec.codes.map((c) => ({ type: c })), browser: true, level: dec.level };
        else if (dec.verdict === "MANUAL_REVIEW" && desktop.ok && mobile.ok) {
          order.retest = { desktop, mobile, http_ok: passiveOk, browser: true, tested_at: t.toISOString(), target };
          await informChris(order, "browser_unclear", `Visuelle Bewertung nicht eindeutig (${dec.codes.join(", ").slice(0, 120)})`);
          manual(order, "Visuelle Bewertung im Browser nicht eindeutig – manuelle Prüfung, kein automatischer Abschluss."); return false;
        }
      } else if (typeof retester === "function") {
        // Echter Browser-Rendertest (Playwright): Desktop 1440×900 + Smartphone 390×844, nur lesend.
        const r = await retester(target).catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 160) }));
        desktop = { ok: passiveOk && r?.desktop?.ok === true, method: r?.desktop?.viewport ? `Playwright Rendertest ${r.desktop.viewport}` : r?.method || "Rendertest Desktop",
          problems: (r?.desktop?.problems || []).slice(0, 10) };
        mobile = { ok: r?.mobile?.ok === true, method: r?.mobile?.viewport ? `Playwright Rendertest ${r.mobile.viewport}` : r?.method || "Rendertest Smartphone",
          problems: (r?.mobile?.problems || []).slice(0, 10) };
      } else {
        desktop = { ok: passiveOk, method: "passiver Seitenabruf (Desktop)" };
        const noViewport = Object.values(desktopAudit.issues).some((i) => i.type === "no_mobile_viewport");
        const mobileIssues = Object.values(desktopAudit.issues).filter((i) => /^mobile_/.test(i.type));
        mobile = { ok: !noViewport && !mobileIssues.length, method: "passive Prüfung (Viewport + bekannte Mobile-Befunde); kein echter Geräte-Rendertest" };
      }
      order.retest = { desktop, mobile, http_ok: passiveOk, ...(order.browser_gate?.required ? { browser: true } : {}), tested_at: t.toISOString(), target };
      if (!desktop.ok || !mobile.ok) {
        const why = `Retest nicht bestanden (Desktop ${desktop.ok ? "ok" : "fehlgeschlagen"}, Smartphone ${mobile.ok ? "ok" : "fehlgeschlagen"}).`;
        if (adapter.direct_live && changedWebsite(order)) { saveOrder(store, order); await rollbackThen(order, adapter, why); return false; }
        block(order, "VALIDATION_FAILED", why); return false;
      }

      // Production nur: Freigabe + Tests bestanden + Rollback vorhanden + bereits autorisierter Deployment-Kanal.
      if (order.plan.length && typeof adapter.deployProduction === "function") {
        if (!authorizationOk(order) || !order.backup?.rollback_point) { manual(order, "Deployment-Voraussetzungen unvollständig (Freigabe/Rollback)."); return false; }
        const d = await adapter.deployProduction(order, accessCtx(order)).catch((e) => ({ ok: false, error: e.message }));
        if (d?.ok !== true) { await rollbackThen(order, adapter, "Produktions-Deployment fehlgeschlagen"); return false; }
        order.deployment = { deployed: true, deploy_ref: d.deploy_ref ? String(d.deploy_ref) : null, at: t.toISOString() };
        const live = await audit(order.website);
        const liveReg = live.ok ? regression(order.audit_before, live) : [{ type: "unreachable", severity: "critical", page: order.website, evidence: "Website nach dem Deployment nicht erreichbar" }];
        if (liveReg.length) { order.regression = { found: liveReg, live: true }; saveOrder(store, order); await rollbackThen(order, adapter, "Live-Retest nach Deployment fehlgeschlagen"); return false; }
        if (order.browser_gate?.required && normDomain(target) !== normDomain(order.website)) {
          // Preview bestanden → nach dem Deployment dieselben Browser-Prüfungen auf der Live-Website.
          const lr = browserValidator ? await runBrowser(order, order.website, "after").catch(() => null) : null;
          if (!lr || lr.decision.verdict !== "PASS") {
            order.regression = { found: (lr?.decision.codes || ["browser_unavailable"]).map((c) => ({ type: c })), browser: true, live: true };
            order.browser_gate = { ...order.browser_gate, regression: "GEFUNDEN", desktop: lr?.decision.desktop_ok ? "JA" : "NEIN", mobile: lr?.decision.mobile_ok ? "JA" : "NEIN" };
            saveOrder(store, order); await rollbackThen(order, adapter, "Browser-Retest nach Deployment fehlgeschlagen"); return false;
          }
        }
        order.deployment.live_retest_ok = true;
      } else if (order.plan.length) {
        order.deployment = { deployed: false, note: `Änderungen liegen im Branch ${order.backup.branch} – Produktions-Deployment über den bestehenden Kanal durch Chris.` };
      }
      const gate = completionGate(order);
      if (!gate.ok) { manual(order, `Abschluss-Gate nicht erfüllt (${gate.missing.join(", ")}) – kein Abschluss.`); return false; }
      const open = manualItems(order).length;
      order.completion = { kind: open ? "WITH_MANUAL_ITEMS" : "FULL", manual_items: open, repaired: Object.values(order.issues || {}).filter((i) => i.repair_status === "repaired").length, at: t.toISOString() };
      order.report = buildCustomerReport(order);
      transition(order, "READY_FOR_DELIVERY", "Retest bestanden, Bericht erstellt", t); saveOrder(store, order); return true;
    }

    if (order.state === "READY_FOR_DELIVERY" && autoDeliver) return deliver(order, t);
    return false; // READY_FOR_DELIVERY ohne autoDeliver/terminal: wartet auf completeOrder() bzw. nichts mehr zu tun
  }

  // TF-044: Host-Key weicht vom bestätigten Fingerprint/Algorithmus ab → STOP (Zugangsdaten wurden nicht gesendet). Wurde bereits
  // etwas verändert, ist ein Rollback über diesen (nicht mehr vertrauenswürdigen) Kanal ausgeschlossen → Chris prüft manuell.
  async function hostKeyBlocked(order, e) {
    const changed = changedWebsite(order);
    if (order.access_profile) order.access_profile = { ...order.access_profile, host_key_verified: false, host_key_blocked_at: now().toISOString() };
    await informChris(order, "host_key_changed", `Host-Key-Prüfung: ${e.code}${changed ? " – Website bereits verändert, Rollback über diesen Kanal gesperrt" : ""}`);
    if (e.code === "HOST_KEY_UNSAFE") return block(order, "BLOCKED_UNSAFE_ACCESS", "Server bietet keinen sicheren SSH-Host-Key (nur veraltete Algorithmen) – keine Verbindung mit Zugangsdaten.");
    if (e.code === "HOST_KEY_AMBIGUOUS") return manual(order, "Mehrere Server-Schlüssel passen zum bestätigten Fingerprint – nicht automatisch entschieden.");
    return block(order, "BLOCKED_HOST_KEY_CHANGED", `SSH-Host-Key oder Host-Key-Algorithmus hat sich geändert – STOP, keine Zugangsdaten gesendet, kein Write${changed ? "; Website war bereits verändert – Chris prüft manuell" : ""}.`);
  }

  // TF-066: Bitten des Mail-Workers um einen NEUEN sicheren Link (Reminder, Passwort per Mail, Kundenfrage). Nur nach bestehenden
  // Tokenregeln: nur wartender FIX-Auftrag (ACCESS_REQUESTED, kein Zugang erhalten), nur wenn der bisherige Link ABGELAUFEN ist,
  // Zahlungsschwelle erfüllt, höchstens MAX_AUTO_REISSUES automatisch (danach Chris). Der alte Link wird nie reaktiviert – die
  // Registrierung des neuen Links entwertet ihn (access-intake-api: höchstens ein gültiger Link je Auftrag). Quittung je Anfrage.
  async function processReissues() {
    if (!onboardingDir) return 0;
    const reqs = listReissueRequests(onboardingDir);
    let n = 0;
    for (const rq of reqs) {
      const order = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders?.[rq.order_id];
      if (!order || order.onboarding_reissues?.[rq.seq] || order.access_reissue) continue;
      const t = now();
      const mark = (status, why) => { order.onboarding_reissues = { ...(order.onboarding_reissues || {}), [rq.seq]: status }; order.updated_at = t.toISOString();
        order.state_history.push({ at: t.toISOString(), from: order.state, to: order.state, reason: why }); saveOrder(store, order); };
      const sent = Object.values(order.onboarding_reissues || {}).filter((s) => s === "sent").length;
      const expired = !!order.access_request?.sent_at && Date.parse(order.access_request.expires_at || 0) <= +t;
      if (!order.onboarding_required || order.state !== "ACCESS_REQUESTED" || intakeReceived(order) || !expired) { mark("skipped", "Neuer sicherer Link nicht nötig (Link noch gültig, Zugang erhalten oder Auftrag nicht wartend)."); continue; }
      if (sent >= MAX_AUTO_REISSUES) { mark("skipped", `Automatische Link-Neuausstellung ausgeschöpft (${MAX_AUTO_REISSUES}) – Chris entscheidet.`); await informChris(order, "reissue_limit", "Sicherer Link mehrfach abgelaufen"); saveOrder(store, order); continue; }
      if (!paymentGateForOrder(store, order).satisfied || !canRequestAccess(order)) { mark("skipped", "Neuer Link nicht möglich (Zahlungsschwelle/Versandweg)."); continue; }
      order.access_request_history = [...(order.access_request_history || []), { sent_at: order.access_request?.sent_at || null, expires_at: order.access_request?.expires_at || null,
        reissued_at: t.toISOString(), reason: `automatisch (${rq.reason})` }];
      order.access_request = null;
      order.access_reissue = { seq: rq.seq, reason: rq.reason, at: t.toISOString() };
      order.state_history.push({ at: t.toISOString(), from: order.state, to: order.state, reason: `Neuer sicherer Link (abgelaufen, ${rq.reason}) – alter Link bleibt ungültig` });
      order.updated_at = t.toISOString();
      saveOrder(store, order); n++;
      log("info", "repair_access_reissue", { order_id: order.order_id, seq: rq.seq, reason: rq.reason });
    }
    return n;
  }

  // Alle offenen Aufträge weiterarbeiten – nach Neustart exakt am gespeicherten Zustand. Ein Fehler stoppt nie die anderen.
  async function processAll() {
    try { await processReissues(); } catch (e) { log("error", "repair_access_reissue_failed", { error: String(e.message).slice(0, 160) }); }
    const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
    const open = Object.values(data.orders || {}).filter((o) => !TERMINAL.has(o.state));
    let advanced = 0;
    for (const stored of open) {
      const order = structuredClone(stored);
      try { for (let guard = 0; guard < 20 && await step(order); guard++) advanced++; }
      catch (e) {
        log("error", "repair_order_failed", { order_id: order.order_id, state: order.state, error: e.message, ...(e?.code ? { code: String(e.code).slice(0, 40) } : {}) });
        if (HOST_KEY_STOP_CODES.has(e?.code)) await hostKeyBlocked(order, e);
        else manual(order, `Unerwarteter Fehler im Zustand ${order.state}: ${e.message}`);
      }
    }
    const after = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
    const states = {};
    for (const o of Object.values(after.orders || {})) states[o.state] = (states[o.state] || 0) + 1;
    return { processed: open.length, advanced, states };
  }

  return { step, processAll };
}

// ---------- Zugangs-Anfrage CUSTOMER_ACCESS_REQUEST (TF-041): nur NACH erfüllter Zahlungsschwelle, nur an die verifizierte ----------
// Kundenadresse, genau einmal. SICHERER Zugang: Einladung/temporärer Benutzer mit minimalen Rechten, übermittelt über den
// auftragsgebundenen One-Time-Link – Passwörter werden NIE per E-Mail erfragt oder angenommen. Keine Werbung, keine internen
// IDs, keine Fachbegriffe. Ohne Link gibt es keine Mail (der Workflow sendet nur mit registriertem Link).
export function buildAccessRequestMail(order, { link = null, expires_at = null, onboarding = false, access_kind = null, askContent = true } = {}) {
  if (isVnOrder(order)) return { ...buildVnAccessRequestMail(order, { link, expires_at, onboarding, access_kind, askContent }), message_class: ACCESS_REQUEST_CLASS }; // TF-064: VN vollständig Vietnamesisch
  const until = expires_at ? new Intl.DateTimeFormat("de-CH", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Zurich" }).format(new Date(expires_at)) : null;
  // TF-071: Anleitung passend zum erkannten/angegebenen Zugangsweg (WordPress-Admin, SFTP, Shopify-Mitarbeiter …).
  const guide = access_kind ? accessGuide(access_kind, "de-CH") : null;
  if (onboarding && !askContent) {
    // TF-071: Plattform-Frage + Inhaltsfrage gingen bereits in diesem Thread – jetzt nur noch der passende sichere Link.
    const body = [
      order.contact_name ? `Guten Tag ${order.contact_name}` : "Guten Tag",
      "",
      "vielen Dank für Ihre Angaben.",
      "",
      `Für die Reparatur Ihrer Website ${order.domain} brauche ich jetzt einen temporären, sicheren Zugang über Ihren persönlichen, nur für diesen Auftrag gültigen Link` + (until ? ` (gültig bis ${until}, nur einmal verwendbar):` : " (nur einmal verwendbar):"),
      link || "(Link folgt separat)",
      "",
      ...(guide ? [guide, ""] : []),
      "Bitte senden Sie keine Passwörter oder Zugangsdaten per E-Mail. Verwenden Sie dafür ausschliesslich den sicheren Link.",
      "Im Formular bestätigen Sie ausserdem die vereinbarte Reparatur.",
      "",
      "Vor der ersten Änderung erstelle ich eine vollständige Sicherung Ihrer Website; zum Abschluss erhalten Sie einen verständlichen Bericht.",
      "",
      "Freundliche Grüsse",
      "Chris",
      "Helvetic Webdesign",
    ].join("\n");
    return { subject: `Ihre Website-Reparatur ${order.domain} – sicherer Zugang`, body, message_class: ACCESS_REQUEST_CLASS };
  }
  if (onboarding) {
    // TF-066: Onboarding-Start (§13) – sicherer Zugang (nur über den Link) + Frage nach kundenabhängigen Inhaltsänderungen.
    const [q, ...rest] = contentQuestionLines("de-CH");
    const body = [
      order.contact_name ? `Guten Tag ${order.contact_name}` : "Guten Tag",
      "",
      "vielen Dank – die erste Teilzahlung für Ihren Auftrag «Check & Reparatur» ist eingegangen, die Zahlungsschwelle ist damit erreicht.",
      "",
      `Damit ich die Reparatur Ihrer Website ${order.domain} sauber durchführen kann, brauche ich noch zwei Dinge:`,
      "",
      "1. Einen temporären, sicheren Zugang über Ihren persönlichen, nur für diesen Auftrag gültigen Link" + (until ? ` (gültig bis ${until}, nur einmal verwendbar):` : " (nur einmal verwendbar):"),
      link || "(Link folgt separat)",
      "",
      "Bitte senden Sie keine Passwörter oder Zugangsdaten per E-Mail. Verwenden Sie dafür ausschliesslich den sicheren Link.",
      guide ? `${guide} Im Formular bestätigen Sie ausserdem die vereinbarte Reparatur.`
        : "Am sichersten: eine Einladung als Mitarbeiter oder ein temporärer Benutzer mit nur den nötigen Rechten (kein Haupt-Passwort). Im Formular bestätigen Sie ausserdem die vereinbarte Reparatur.",
      "",
      `2. ${q}`,
      ...rest,
      "",
      "Vor der ersten Änderung erstelle ich eine vollständige Sicherung Ihrer Website; zum Abschluss erhalten Sie einen verständlichen Bericht.",
      "",
      "Freundliche Grüsse",
      "Chris",
      "Helvetic Webdesign",
    ].join("\n");
    return { subject: `Ihre Website-Reparatur ${order.domain} – sicherer Zugang und Ihre Wünsche`, body, message_class: ACCESS_REQUEST_CLASS };
  }
  const body = [
    `Hallo ${order.contact_name || order.company || ""}`.trim(),
    "",
    "vielen Dank – die erste Teilzahlung für Ihren Auftrag «Check & Reparatur» ist bei uns eingegangen.",
    "",
    `Für die vereinbarte Reparatur Ihrer Website ${order.domain} benötige ich einen temporären, sicheren Zugang.`,
    "",
    "Wichtig: Senden Sie mir bitte KEINE Passwörter per E-Mail – auch keine Zugangscodes oder Schlüssel.",
    "",
    "Bitte verwenden Sie dafür ausschliesslich Ihren persönlichen, nur für diesen Auftrag gültigen Link" + (until ? ` (gültig bis ${until}, nur einmal verwendbar):` : " (nur einmal verwendbar):"),
    link || "(Link folgt separat)",
    "",
    "Am sichersten, in dieser Reihenfolge:",
    "- Laden Sie mich bei Ihrem Website-System bzw. Ihrem Hosting-Anbieter als Mitarbeiter ein – dann ist kein Passwort nötig.",
    "- Oder legen Sie einen temporären Benutzer mit nur den nötigen Rechten an (bitte kein Haupt-Passwort).",
    "- Oder bitten Sie Ihren Hosting-Anbieter, mir eine eigene, zeitlich begrenzte Zugriffsberechtigung einzurichten.",
    "",
    "Im Formular bestätigen Sie ausserdem, dass Sie den Zugang bereitstellen dürfen und die vereinbarte Reparatur freigeben.",
    "",
    "Danach erstelle ich zuerst eine vollständige Sicherung Ihrer Website und beginne mit der Reparatur. Zum Abschluss",
    "erhalten Sie einen verständlichen Bericht; den temporären Zugang können Sie danach wieder entfernen.",
    "",
    "Freundliche Grüsse",
    "Chris",
    "Helvetic Webdesign",
  ].join("\n");
  return { subject: `Ihre Website-Reparatur ${order.domain} – sicherer Zugang benötigt`, body, message_class: ACCESS_REQUEST_CLASS };
}

// ---------- TF-071: Plattform-Frage (erste Auftrags-Mail, wenn Hosting/CMS öffentlich nicht sicher erkennbar) ----------
// Klasse CUSTOMER_ONBOARDING_DIALOGUE, eröffnet den Auftrags-Thread. Kein Link, keine Frage nach Benutzername/Passwort –
// ausdrücklich: noch keine Zugangsdaten per E-Mail. Enthält zusätzlich die Inhaltsfrage (TF-066).
export function buildHostingQuestionMail(order) {
  if (isVnOrder(order)) return buildVnHostingQuestionMail(order);
  const [hq, , nopw] = hostingQuestionLines("de-CH");
  const [q, ...rest] = contentQuestionLines("de-CH");
  const body = [
    order.contact_name ? `Guten Tag ${order.contact_name}` : "Guten Tag",
    "",
    "vielen Dank – die erste Teilzahlung für Ihren Auftrag «Check & Reparatur» ist eingegangen, die Zahlungsschwelle ist damit erreicht.",
    "",
    `Damit ich Ihnen für die Reparatur Ihrer Website ${order.domain} den passenden sicheren Zugangsweg senden kann, zuerst zwei kurze Fragen:`,
    "",
    `1. ${hq}`,
    "",
    nopw,
    "Den sicheren Link für den Zugang erhalten Sie anschliessend in einer separaten Nachricht.",
    "",
    `2. ${q}`,
    ...rest,
    "",
    "Freundliche Grüsse",
    "Chris",
    "Helvetic Webdesign",
  ].join("\n");
  return { subject: `Ihre Website-Reparatur ${order.domain} – kurze Frage vorab`, body };
}

// ---------- Host-Key-Bestätigung (TF-043): nur nach erhaltenem Zugang + erfüllter Zahlungsschwelle, nur an die verifizierte ----------
// Kundenadresse, genau einmal, mit One-Time-Link. Der Fingerprint steht nur auf der Link-Seite (nicht geheim, aber unnötig in der
// Mail); keine Hosts, Benutzer, Pfade oder internen IDs. Bis zur Bestätigung verbindet sich Jarvis nicht mit den Zugangsdaten.
export function buildHostKeyConfirmationMail(order, { link = null, expires_at = null } = {}) {
  if (isVnOrder(order)) return { ...buildVnHostKeyConfirmationMail(order, { link, expires_at }), message_class: ACCESS_REQUEST_CLASS };
  const until = expires_at ? new Intl.DateTimeFormat("de-CH", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Zurich" }).format(new Date(expires_at)) : null;
  const body = [
    `Hallo ${order.contact_name || order.company || ""}`.trim(),
    "",
    `vielen Dank für den Zugang zu Ihrer Website ${order.domain}.`,
    "",
    "Bevor ich mich mit Ihrem Server verbinde, prüfe ich dessen digitales Sicherheitsmerkmal (den sogenannten Fingerprint).",
    "So ist sichergestellt, dass ich wirklich mit Ihrem Server spreche und nicht mit einem fremden.",
    "",
    "Bitte öffnen Sie dazu Ihren persönlichen Link" + (until ? ` (gültig bis ${until}, nur einmal verwendbar):` : " (nur einmal verwendbar):"),
    link || "(Link folgt separat)",
    "",
    "Dort sehen Sie das Merkmal. Bitte vergleichen Sie es mit der Angabe Ihres Hosting-Anbieters (oft im Kundenbereich unter",
    "«SSH» bzw. «SFTP» zu finden – der Support Ihres Anbieters nennt es Ihnen auch gerne) und bestätigen Sie, ob es übereinstimmt.",
    "",
    "Bis zu Ihrer Bestätigung verbinde ich mich nicht mit Ihren Zugangsdaten. Bitte senden Sie mir keine Passwörter per E-Mail.",
    "",
    "Freundliche Grüsse",
    "Chris",
    "Helvetic Webdesign",
  ].join("\n");
  return { subject: `Ihre Website-Reparatur ${order.domain} – kurze Sicherheitsbestätigung`, body, message_class: ACCESS_REQUEST_CLASS };
}

// ---------- Kundenbericht (verständlich, ohne Fachjargon; wird nur gespeichert, nie automatisch versendet) ----------
// Für den Kunden: keine internen IDs, keine Git-Referenzen, keine Roh-Evidence, keine internen Pfade, keine Tokens.
export function buildCustomerReport(order, { now = new Date() } = {}) {
  const issues = Object.values(order.issues || {});
  const fixed = issues.filter((i) => i.repair_status === "repaired");
  const openForReview = issues.filter((i) => ["needs_review", "repair_failed", "still_broken"].includes(i.repair_status) || (i.repair_status === "open" && !i.repairable));
  const relevant = issues.filter((i) => i.type !== "customer_content_change" && (RELEVANT.has(i.severity) || i.customer_text));
  const manualOpen = manualItems(order).length;
  const line = (i) => `• ${i.customer_text || "Ein technischer Punkt auf " + (i.page || "Ihrer Website")}`; // TF-066: Inhaltsänderungen mit eigenem Kundentext
  if (isVnOrder(order)) return { subject: vnReportSubject(order), body: buildVnRepairReport(order, { now, fixed, openForReview, relevant: relevant.length, manualOpen }), created_at: new Date().toISOString() };
  const body = [
    `Webseiten-Check – Abschlussbericht «Check & Reparatur» (CHF ${OFFERS[REPAIR_OFFER].price})`,
    "",
    `Website: ${order.domain}`,
    `Datum: ${(order.retest?.tested_at || now.toISOString()).slice(0, 10)}`,
    "",
    "Was geprüft wurde:",
    `Ihre Startseite und die von dort verlinkten Unterseiten – Links, Navigation, Bilder, Kontaktbereich sowie die Darstellung auf Smartphone und Desktop.`,
    "",
    `Gefundene relevante Punkte: ${relevant.length}`,
    "",
    // TF-055: bleibt ein relevanter Punkt offen, steht das klar oben – nie «vollständig repariert».
    ...(manualOpen ? [fixed.length ? "Die automatisch reparierbaren Probleme wurden behoben. Weitere Punkte erfordern eine manuelle Prüfung."
      : "Es gab keine automatisch reparierbaren Probleme. Die gefundenen Punkte erfordern eine manuelle Prüfung.", ""] : []),
    fixed.length ? "Behoben wurden:" : "Behoben wurde nichts – es gab keine im Paket abgedeckten, automatisch behebbaren Fehler.",
    ...fixed.map((i) => `${line(i)} – behoben und erneut geprüft.`),
    "",
    ...(openForReview.length ? ["Nicht automatisch repariert – zur Besprechung (nicht automatisch verändert):", ...openForReview.map(line), ""] : []),
    "Abschlusskontrolle:",
    `Desktop: ${order.retest?.desktop?.ok ? "geprüft, in Ordnung" : "siehe Hinweis"} (${order.retest?.desktop?.method || "–"}).`,
    `Smartphone: ${order.retest?.mobile?.ok ? "geprüft, in Ordnung" : "siehe Hinweis"} (${order.retest?.mobile?.method || "–"}).`,
    // TF-045: nur nach bestandenem Browser-Gate – einfache Sätze, keine Logs, Requests, Screenshots, Pfade oder Debugdaten.
    ...(order.browser_gate?.desktop === "JA" && order.browser_gate?.mobile === "JA" && order.browser_gate?.regression === "KEINE"
      ? ["", "Desktop geprüft: Ja", "Mobile geprüft: Ja", `Navigation geprüft: ${order.browser_gate.navigation === "JA" ? "Ja" : "Nein"}`, "Keine neuen relevanten Darstellungsfehler gefunden."] : []),
    ...(order.retest?.http_ok === true && order.retest?.desktop?.ok && order.retest?.mobile?.ok ? ["Erneute Prüfung nach der Reparatur (Retest): erfolgreich."] : []),
    "",
    order.deployment?.deployed ? "Die Korrekturen sind auf Ihrer Website live und wurden danach erneut geprüft."
      : order.plan?.length ? "Die Korrekturen sind vorbereitet und werden nach Rücksprache aufgeschaltet." : "An Ihrer Website wurde nichts verändert.",
    "",
    ...(order.access_intake ? ["Wichtig: Bitte entfernen Sie jetzt den temporären Zugang, den Sie für diesen Auftrag eingerichtet haben (bzw. ändern Sie das Passwort). Die Zugangsdaten werden bei uns mit dem Abschluss gelöscht.", ""] : []),
    "Bei Fragen genügt eine kurze Antwort auf diese E-Mail.",
  ].join("\n");
  return { subject: `Webseiten-Check ${order.domain} – Abschlussbericht`, body, created_at: new Date().toISOString() };
}

// ---------- Liefermail CUSTOMER_ORDER_FULFILLMENT (TF-046): Abschlussbericht für den bestätigten, bezahlten Kunden ----------
// Keine Werbung, keine internen IDs/Pfade/Referenzen; der Bericht selbst ist bereits kundentauglich (buildCustomerReport).
export function buildRepairDeliveryMail(order) {
  if (isVnOrder(order)) { const m = buildVnRepairDeliveryMail(order, { manualOpen: manualItems(order).length }); return { ...m, inline: m.body.length <= MAX_INLINE_DELIVERY, message_class: FULFILLMENT_CLASS }; }
  const report = order.report?.body || "";
  const body = [
    `Hallo ${order.contact_name || order.company || ""}`.trim(),
    "",
    manualItems(order).length
      ? `Ihr Auftrag «Check & Reparatur» für ${order.domain} ist abgeschlossen. Die automatisch reparierbaren Probleme wurden behoben. Weitere Punkte erfordern eine manuelle Prüfung – Details im Abschlussbericht:`
      : `Ihr Auftrag «Check & Reparatur» für ${order.domain} ist abgeschlossen. Hier ist Ihr Abschlussbericht:`,
    "",
    report,
    "",
    "Freundliche Grüsse",
    "Chris",
    "Helvetic Webdesign",
  ].join("\n");
  return { subject: order.report?.subject || `Webseiten-Check ${order.domain} – Abschlussbericht`, body, inline: body.length <= MAX_INLINE_DELIVERY, message_class: FULFILLMENT_CLASS };
}
// Letzte Sperre vor dem Versand: der Bericht darf nie Zugangsdaten, Tokens, Hosts/IPs, Serverpfade, Backup-IDs, Commit-/Git-
// Referenzen, Auftrags-IDs oder Debugdaten enthalten. Rückgabe: Grund (String) oder null.
const REPORT_FORBIDDEN = [
  ["ip", /\b\d{1,3}(\.\d{1,3}){3}\b/], ["pfad", /(\/home\/|\/var\/|\/opt\/|\/srv\/|\/etc\/|public_html|wp-content\/|[A-Z]:\\)/i],
  ["url", /\b(https?|s?ftp|ssh):\/\//i], ["backup_id", /\bB[0-9a-f]{12}\b|\brepair_backups\b|backup_ref|rollback_point/i],
  ["git", /\b[0-9a-f]{40}\b|\brepair\/(RF480|VNFIX)|\bcommit\b|\bbranch\b/i], ["auftrags_id", /\b(RF480|VNFIX)-\d{8}-[0-9a-f]{6}\b/],
  ["secret", /passwor[td]\s*[:=]|token\s*[:=]|-----BEGIN|api[_-]?key|bearer\s/i], ["debug", /\b(stack|trace|console\.|error:|undefined|null\b|\[object)/i],
];
export function reportUnsafe(text = "", order = {}) {
  for (const [why, re] of REPORT_FORBIDDEN) if (re.test(text)) return why;
  for (const v of [order.access_request?.token_hash, order.delivery?.draft_id, order.backup?.backup_ref, order.backup?.production_ref, order.access_profile?.host_key_sha256])
    if (v && String(v).length >= 8 && text.includes(String(v))) return "interne_referenz";
  return null;
}

// ---------- Status (nur Zähler, keine Secrets/Evidence – sicher für Dashboard/Cloud) ----------
export function repairOrdersStatus(dir = WORKER_DIR) {
  const data = createStore(dir).read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const orders = Object.values(data.orders || {});
  const states = {};
  for (const o of orders) states[o.state] = (states[o.state] || 0) + 1;
  return { total: orders.length, open: orders.filter((o) => !TERMINAL.has(o.state)).length, states,
    waiting_authorization: states.AUTHORIZATION_REQUIRED || 0, waiting_payment: states.PAYMENT_REQUIRED || 0,
    access_requested: states.ACCESS_REQUESTED || 0, payment_review: states.PAYMENT_REVIEW_REQUIRED || 0,
    ready_for_delivery: states.READY_FOR_DELIVERY || 0, cancelled: states[REPAIR_CANCELLED] || 0, completed_with_manual_items: states[COMPLETED_WITH_MANUAL_ITEMS] || 0,
    manual_review: states.MANUAL_REVIEW_REQUIRED || 0, unsafe_access: states.BLOCKED_UNSAFE_ACCESS || 0, host_key_changed: states.BLOCKED_HOST_KEY_CHANGED || 0,
    host_key_confirmation: states.HOST_KEY_CONFIRMATION_REQUIRED || 0, waiting_access_profile: states.WAITING_FOR_ACCESS_PROFILE || 0 };
}

// Kundenphase fürs Dashboard (TF-041) – feste Wörter, aus Zustand + Zahlung + Zugang abgeleitet.
export const REPAIR_PHASES = Object.freeze(["WAITING_FOR_DEPOSIT", "WAITING_FOR_HOSTING_INFO", "WAITING_FOR_ACCESS", "ACCESS_REQUEST_SENT", "ACCESS_RECEIVED",
  "ACCESS_PROFILE_PREFLIGHT", "HOST_KEY_CONFIRMATION", "WAITING_FOR_ACCESS_PROFILE", "WAITING_FOR_CUSTOMER_BRIEF", "BACKUP", "REPAIRING",
  "VALIDATING", "LIVE_RETEST", "READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS", "MANUAL_REVIEW", "PAYMENT_REVIEW_REQUIRED", "CANCELLED", "BLOCKED"]);
export function repairPhase(o, pay) {
  if (o.state === "COMPLETED") return "COMPLETED";
  if (o.state === COMPLETED_WITH_MANUAL_ITEMS) return COMPLETED_WITH_MANUAL_ITEMS;
  if (o.state === REPAIR_CANCELLED) return "CANCELLED";
  if (o.state === "PAYMENT_REVIEW_REQUIRED") return "PAYMENT_REVIEW_REQUIRED";
  if (o.state === "MANUAL_REVIEW_REQUIRED") return "MANUAL_REVIEW";
  if (BLOCKED_STATES.includes(o.state)) return "BLOCKED";
  if (o.state === "READY_FOR_DELIVERY") return "READY_FOR_DELIVERY";
  if (o.state === "VALIDATION") return "VALIDATING";
  if (o.state === "RETEST") return "LIVE_RETEST";
  if (["REPAIRING", "FULL_AUDIT", "REPAIR_PLAN"].includes(o.state)) return "REPAIRING";
  if (o.state === "BACKUP") return "BACKUP";
  if (o.state === "ACCESS_PROFILE_PREFLIGHT") return "ACCESS_PROFILE_PREFLIGHT";
  if (o.state === "HOST_KEY_CONFIRMATION_REQUIRED") return "HOST_KEY_CONFIRMATION";
  if (o.state === "WAITING_FOR_ACCESS_PROFILE") return "WAITING_FOR_ACCESS_PROFILE";
  if (o.state === "WAITING_FOR_CUSTOMER_BRIEF") return "WAITING_FOR_CUSTOMER_BRIEF";
  if (!["DEPOSIT_MET", "PAID_FULL"].includes(pay.payment_status)) return "WAITING_FOR_DEPOSIT";
  if (o.state === "WAITING_FOR_HOSTING_INFO") return "WAITING_FOR_HOSTING_INFO"; // TF-071
  if (o.access_intake?.status === "RECEIVED") return "ACCESS_RECEIVED";
  if (o.access_request?.sent_at && Date.parse(o.access_request.expires_at || 0) > Date.now()) return "ACCESS_REQUEST_SENT";
  return "WAITING_FOR_ACCESS";
}

// Allowlist-Sicht für Dashboard/Cloud/Handy: Zähler + je Auftrag nur die hier aufgezählten, ungefährlichen Felder.
// NIE: Evidence, URLs einzelner Befunde, Branch-/Commit-/Deploy-Referenzen, Preview-URLs, Freigabe-Referenzen, Tokens,
// Token-Hashes, Zahlungsreferenzen, Zugangsdaten oder Kundenadressen, Historie.
export const PUBLIC_REPAIR_FIELDS = Object.freeze(["order_id", "company", "domain", "offer_class", "market", "currency", "price_chf", "price_amount", "paid_amount", "payment_required_amount",
  "rest_to_deposit_amount", "commission_rate_bps", "state", "phase", "findings",
  "repaired", "needs_review", "backup_ok", "desktop_retest", "mobile_retest", "production", "report_available",
  "paid_chf", "payment_required_chf", "rest_to_deposit_chf", "payment_status", "payment_ok", "access_requested", "access_received",
  "access_type", "adapter", "access_ok", "rollback_ok", "auto_fixable", "manual_review", "profile_status", "host_key_verified",
  "browser_desktop", "browser_mobile", "browser_regression", "authorized", "delivery_status", "manual_items_open", "created_at", "updated_at"]);
// TF-045: Browser-Gate fürs Dashboard – nur feste Wörter (nie URLs, Screenshots, Logs, Codes oder Requests).
const gateWord = (v) => (v === "JA" || v === "NEIN" ? v : "WARTET");
const regressionWord = (g) => (["KEINE", "GEFUNDEN", "ROLLBACK"].includes(g.regression) ? g.regression : null);
// Adapter-Anzeige (TF-042): feste Wörter – nie Connector-Strings (enthalten z. B. Repo-Namen), nie Hosts/Pfade.
const ADAPTER_WORDS = { github_netlify: "GITHUB_NETLIFY", wordpress: "WORDPRESS", sftp: "SFTP", ssh: "SSH" };
const adapterWord = (o) => (o.state === "BLOCKED_UNSUPPORTED_STACK" || (o.route && !o.route.adapter) ? "UNSUPPORTED"
  : ADAPTER_WORDS[o.route?.adapter] || (o.access?.ok ? ADAPTER_WORDS[o.stack?.type] : null) || null);
export function publicRepairOrders(dir = WORKER_DIR, { max = 50 } = {}) {
  const store = createStore(dir);
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const orders = Object.values(data.orders || {})
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, max)
    .map((o) => {
      const issues = Object.values(o.issues || {});
      const pay = paymentSummary(store, o);
      return {
        order_id: o.order_id, company: o.company || null, domain: o.domain, offer_class: o.offer_class, price_chf: o.price_chf,
        // TF-064: Markt/Währung/Beträge in Auftragswährung (CH zusätzlich wie bisher *_chf).
        market: pay.market, currency: pay.currency, price_amount: pay.price_amount, paid_amount: pay.paid_amount, payment_required_amount: pay.deposit_amount,
        rest_to_deposit_amount: pay.rest_to_deposit_amount, commission_rate_bps: o.commission_rate_bps ?? null, // TF-072: bei Erstellung gespeicherter Satz
        state: o.state, phase: repairPhase(o, pay), findings: issues.length, repaired: issues.filter((i) => i.repair_status === "repaired").length,
        needs_review: (o.manual_review || []).length,
        backup_ok: !!(o.backup?.rollback_point), desktop_retest: o.retest ? o.retest.desktop?.ok === true : null,
        mobile_retest: o.retest ? o.retest.mobile?.ok === true : null,
        production: o.deployment?.deployed === true ? "DEPLOYED" : o.deployment ? "BRANCH_ONLY" : "UNCHANGED",
        report_available: !!o.report,
        // Zahlungsstand (TF-041): nur Zahlen/Flags/Zustandswort aus dem Ledger – nie Referenzen, nie Zahlungsdetails.
        paid_chf: pay.paid_chf ?? null, payment_required_chf: pay.deposit_chf ?? null, rest_to_deposit_chf: pay.rest_to_deposit_chf ?? null,
        payment_status: pay.payment_status, payment_ok: pay.deposit_amount != null && pay.paid_amount >= pay.deposit_amount,
        // Zugang: nur Ja/Nein + Zugangsart – nie Link, Token(-Hash), Zugangsdaten oder Tresor-Pfad.
        access_requested: !!o.access_request?.sent_at, access_received: o.access_intake?.status === "RECEIVED" || o.access_intake?.status === "DESTROYED",
        access_type: o.access_intake?.connector_type || null,
        // TF-042: Adapter, Zugang geprüft, Rollback möglich, automatisch behebbar, manuelle Prüfung – nur Wörter/Zahlen/Flags.
        adapter: adapterWord(o), access_ok: o.access?.ok === true,
        rollback_ok: !!o.backup?.rollback_point && (!o.access?.capabilities || o.access.capabilities.includes("ROLLBACK")),
        auto_fixable: (o.plan || []).length, manual_review: (o.manual_review || []).length,
        // TF-043: nur das Statuswort des Zugangsprofils – nie Host, Benutzer, IP, Webroot/Pfade oder Fingerprint.
        profile_status: PROFILE_STATUSES.includes(o.access_profile?.profile_status) ? o.access_profile.profile_status : null,
        // TF-044: nur JA/NEIN (SSH/SFTP) – nie Fingerprint, Algorithmus, Host, IP oder Benutzer.
        host_key_verified: ["sftp", "ssh"].includes(o.access_profile?.interface) ? o.access_profile.host_key_verified === true : null,
        // TF-045: JA / NEIN / WARTET bzw. KEINE / GEFUNDEN / ROLLBACK – null, wenn für den Auftrag kein Browser-Gate gilt.
        browser_desktop: o.browser_gate ? gateWord(o.browser_gate.desktop) : null, browser_mobile: o.browser_gate ? gateWord(o.browser_gate.mobile) : null,
        browser_regression: o.browser_gate ? regressionWord(o.browser_gate) : null,
        // TF-046: Freigabe nur JA/NEIN; Lieferung nur als festes Wort – nie Draft-ID, Adresse oder Inhalt.
        authorized: authorizationOk(o), delivery_status: DELIVERY_STATUSES.includes(o.delivery?.status) ? o.delivery.status : "none",
        // TF-055: offene manuelle Punkte (nur Zahl) – sobald der Auftrag den Retest bestanden hat.
        manual_items_open: ["READY_FOR_DELIVERY", ...COMPLETED_STATES].includes(o.state) ? manualItems(o).length : null,
        created_at: o.created_at, updated_at: o.updated_at,
      };
    });
  const status = repairOrdersStatus(dir);
  return { ...status, adapter_registry: registryStatus(), orders };
}
// Adapter-Registry (TF-042) fürs Dashboard: feste Schlüssel + ob die SSH-Bibliothek installiert ist. Nie Profile/Hosts.
let registryCache = null;
function registryStatus() {
  if (!registryCache) {
    let ssh = false; try { createRequire(import.meta.url).resolve("ssh2"); ssh = true; } catch {}
    registryCache = { status: "ACTIVE", adapters: ["github_netlify", "wordpress", "sftp", "ssh"], ssh_library: ssh, host_key_verifier: ssh ? "ACTIVE" : "UNAVAILABLE",
      browser_validator: browserRuntimeStatus().status }; // TF-045: ACTIVE nur mit playwright-core + ausführbarem Chromium
  }
  return registryCache;
}

// Standard-Abhängigkeiten für den Produktivbetrieb: GitHub+Netlify-Adapter (nur mit explizitem Mapping + Env-Tokens wirksam)
// und – falls Playwright installiert ist – der echte Browser-Rendertest. Fehler beim Laden → ohne (fail closed, nur Audit/Blocked).
// TF-042: zusätzlich WordPress REST, SFTP und SSH/SFTP über den Router (repair-adapters/router.js). Ohne Zugangsprofil/Tresor
// bleiben sie wirkungslos (fail closed). Ladefehler eines Adapters → ohne ihn (nie ein Absturz des Workers).
export async function loadDefaultRepairDeps({ dir = WORKER_DIR } = {}) {
  let adapters = {}, router = null, preflight = null;
  try { const m = await import("./repair-adapters/github-netlify.js"); adapters = { github_netlify: m.githubNetlifyAdapter({ dir }) }; } catch {}
  try { const reg = await (await import("./repair-adapters/router.js")).createAdapterRegistry({ dir, legacy: adapters }); adapters = reg.adapters; router = reg.router; preflight = reg.preflight; } catch {}
  let retester = null;
  try { retester = await (await import("./repair-render-test.js")).loadRenderRetester(); } catch {}
  // TF-045: echter Browser-Validator (Chromium). Nicht ladbar → null; der Produktivlauf ist dann fail closed (requireBrowser).
  let browserValidator = null;
  try { browserValidator = await (await import("./repair-browser-validator.js")).loadBrowserValidator(); } catch {}
  // TF-071: Plattform-Erkennung aus öffentlichen Signalen. Nicht ladbar → null (= nie raten, der Kunde wird gefragt).
  let platformDetector = null;
  try { platformDetector = (await import("./hosting-probe.js")).createPlatformDetector(); } catch {}
  return { adapters, retester, router, preflight, browserValidator, platformDetector };
}

// ---------- Worker-Hook (eigenes Lock, nie zwei Läufe; ohne explizite Deps werden die Standard-Deps geladen) ----------
// gmail (optional): nur für die automatische Zugangs-Anfrage nach erfüllter Zahlungsschwelle (TF-041).
// intake (optional, access-intake.js intakeClient): sicherer One-Time-Link; vor dem Engine-Lauf werden eingegangene
// Einreichungen abgeholt (nur wenn ein Auftrag darauf wartet – kein Netzverkehr ohne Grund). Ohne gmail/intake bleibt
// fehlender Zugang wie bisher BLOCKED_NO_ACCESS – es wird nie etwas erraten.
// TF-045: requireBrowser = true – CHF-480-Reparaturen im Produktivbetrieb nur mit echtem Browser-Gate (fail closed).
// TF-046: autoDeliver = true – nach bestandenem Abschluss-Gate geht der Bericht genau einmal an den Kunden (CUSTOMER_ORDER_FULFILLMENT).
// auditor/alert nur für isolierte Tests (Lab-Auditor, Chris-Hinweis-Attrappe); im Produktivbetrieb null = Standard.
export async function runRepairOrders({ dir = WORKER_DIR, adapters = null, retester = null, router = null, preflight = null, browserValidator = null, requireBrowser = true,
  autoDeliver = true, auditor = null, alert = null, gmail = null, intake = null, onboardingDir = null, platformDetector = null, log = createLogger(dir) } = {}) {
  const status = repairOrdersStatus(dir);
  if (!status.open) return { busy: false, processed: 0, advanced: 0, states: status.states };
  if (!acquireLock(dir, { name: "repair.lock" })) return { busy: true };
  try {
    if (!adapters) {
      const defaults = await loadDefaultRepairDeps({ dir });
      adapters = defaults.adapters;
      retester = retester || defaults.retester;
      router = router || defaults.router;
      preflight = preflight || defaults.preflight;
      browserValidator = browserValidator || defaults.browserValidator;
      platformDetector = platformDetector || defaults.platformDetector;
    }
    const store = createStore(dir);
    let access = null;
    const waiting = Object.values(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders || {}).some((o) => (o.state === "ACCESS_REQUESTED" && o.access_request?.sent_at && o.access_intake?.status !== "RECEIVED")
      || (o.state === "HOST_KEY_CONFIRMATION_REQUIRED" && o.host_key_request?.sent_at && !o.host_key_request.received_at));
    if (intake && waiting) access = await syncAccessIntake({ store, intake, log });
    const engine = createRepairEngine({ dir, store, adapters, retester, router, preflight, browserValidator, requireBrowser, autoDeliver, auditor, alert, gmail, intake, onboardingDir, platformDetector, log });
    return { busy: false, ...(await engine.processAll()), ...(access ? { access_intake: access } : {}) };
  } finally { releaseLock(dir, process.pid, "repair.lock"); }
}

// ---------- CRM-Export (TF-055): Stand nach der Reparatur je Domain ----------
// Nur Aufträge nach bestandenem Retest (READY_FOR_DELIVERY/COMPLETED/COMPLETED_WITH_MANUAL_ITEMS). Behobene Befunde = RESOLVED, beim
// Retest nicht mehr vorhandene ebenso; alles andere bleibt OPEN + manual (manuelle Punkte bleiben im CRM sichtbar). Allowlist:
// Domain, Zustand, Zeitpunkt, normalisierte Befunde (Typ/Kategorie/Kurztext/Seite/Ziel/Schweregrad) – nie Kundenadresse, Evidence,
// Branch/Backup/Deploy-Referenzen, Zugangsdaten oder Auftrags-IDs.
export function repairFindingsExport(dir = WORKER_DIR, { now = new Date() } = {}) {
  const data = createStore(dir).read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const out = {};
  for (const o of Object.values(data.orders || {})) {
    if (!["READY_FOR_DELIVERY", ...COMPLETED_STATES].includes(o.state)) continue;
    const at = o.validation?.audited_at || o.retest?.tested_at;
    const d = normDomain(o.domain);
    if (!d || !at) continue;
    const remaining = Array.isArray(o.validation?.open_keys) ? new Set(o.validation.open_keys) : null;
    const findings = rankFindings(dedupeFindings(Object.values(o.issues || {}).filter((i) => i?.type !== "customer_content_change").map((i) => {
      const gone = i.repair_status === "repaired" || (!!remaining && !remaining.has(issueKey(i)));
      return normalizeIssue(i, { verified_at: at, source: "repair", status: gone ? "RESOLVED" : "OPEN", manual: !gone });
    }).filter(Boolean)));
    const entry = { domain: d, state: o.state, completion: o.completion?.kind || (o.state === "COMPLETED" ? "FULL" : o.state === COMPLETED_WITH_MANUAL_ITEMS ? "WITH_MANUAL_ITEMS" : null), audited_at: at, findings };
    if (!out[d] || out[d].audited_at < at) out[d] = entry;
  }
  return { schema: 1, generated_at: now.toISOString(), orders: out };
}
// Atomar schreiben, nur bei inhaltlicher Änderung (generated_at zählt nicht). Fehler hier stoppen nie den Repair-Lauf (Aufrufer fängt).
export function writeRepairFindingsExport({ dir = WORKER_DIR, exportDir, now = new Date() } = {}) {
  if (!exportDir) return { written: false, reason: "no_export_dir" };
  const next = repairFindingsExport(dir, { now });
  const file = path.join(exportDir, REPAIR_FINDINGS_FILE);
  let prev = null; try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (prev && JSON.stringify(prev.orders) === JSON.stringify(next.orders)) return { written: false, domains: Object.keys(next.orders).length };
  fs.mkdirSync(exportDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try { fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
  return { written: true, domains: Object.keys(next.orders).length };
}

// ---------- Kommandozeile ----------
// Zahlung verbuchen (TF-041): node payments.js record <order_id> --amount 240 --reference "<ref>" – erst ab CHF 240 fragt
// Jarvis (einmal, über den sicheren Link) nach Zugang. Zugangsdaten-Tresor: node access-intake.js status|destroy <order_id>.
// node repair-workflow.js --list | --status | --show <order_id> | --create <domain> [--website URL] [--lead ID] [--company NAME]
//                         [--email <kundenadresse>] [--name ANREDE]
//                         | --create-confirmed <domain> --email <kundenadresse> [--company NAME] [--name ANREDE] [--website URL]
//                           (TF-046: bestätigter Direktauftrag = Direktverkauf in sales.json + Auftrag; wartet danach auf CHF 240)
//                         | --authorize <order_id> --domain <domain> --source <quelle> [--reference TEXT]
//                         | --run | --complete <order_id> | --report <order_id> | --cancel <order_id> --reason TEXT
//                         | --reissue-access <order_id> --reason TEXT   (abgelaufener Link: genau EINE neue Anfrage, nur durch Chris)
//                         | --confirm-host-key <order_id> --fingerprint SHA256:…  (TF-043: Chris hat den Fingerprint unabhängig
//                           beim Kunden/Hoster geprüft; muss EXAKT dem vom Server präsentierten Kandidaten entsprechen)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  const run = async () => {
    if (argv.includes("--list") || argv.includes("--status")) { console.log(JSON.stringify(repairOrdersStatus(), null, 2)); return 0; }
    if (flag("show")) {
      const o = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders?.[flag("show")];
      if (!o) throw new Error("Auftrag nicht gefunden.");
      // Token-Hash nicht ausgeben (nicht geheim, aber unnötig); Zugangsdaten stehen ohnehin nie im Auftrag.
      console.log(JSON.stringify({ ...o, access_request: o.access_request ? { ...o.access_request, token_hash: o.access_request.token_hash ? "[gesetzt]" : null } : null }, null, 2)); return 0;
    }
    if (flag("create-confirmed")) {
      const o = createConfirmedRepairOrder(store, { domain: flag("create-confirmed"), website: flag("website"), company: flag("company"), delivery_email: flag("email"), contact_name: flag("name") });
      console.log(`Bestätigter CHF-480-Auftrag: ${o.order_id} (${o.state}) – Direktverkauf erfasst, wartet auf Zahlung (WAITING_FOR_DEPOSIT).`);
      console.log(`Zahlung verbuchen: node payments.js record ${o.order_id} --amount ${paymentThresholdChf(REPAIR_OFFER)} --reference "<Bankreferenz>"`);
      return 0;
    }
    if (flag("create")) {
      const o = createRepairOrder(store, { domain: flag("create"), website: flag("website"), lead_id: flag("lead"), company: flag("company"), delivery_email: flag("email"), contact_name: flag("name") });
      console.log(`Auftrag angelegt: ${o.order_id} (${o.state}).`);
      console.log(`Zahlungsschwelle (TF-041): Zugangs-Anfrage/Reparatur erst ab kumulativ CHF ${paymentThresholdChf(REPAIR_OFFER)} – Zahlung verbuchen: node payments.js record ${o.order_id} --amount ${paymentThresholdChf(REPAIR_OFFER)} --reference "<Bankreferenz>"`);
      console.log(`Freigabe kommt über das sichere Formular (Pflicht-Zustimmung) oder: node repair-workflow.js --authorize ${o.order_id} --domain ${o.domain} --source customer_reply_email --reference "<woher>"`);
      return 0;
    }
    if (flag("authorize")) { const o = authorizeRepair(store, flag("authorize"), { authorized_domain: flag("domain"), source: flag("source"), reference: flag("reference") }); console.log(`Freigabe gesetzt: ${o.order_id} → ${o.state}`); return 0; }
    if (argv.includes("--run")) {
      // TF-047: im separaten Repair-Service (kein Gmail) nur über die Repair-Outbox – der Mail-Worker sendet.
      const gmail = process.env.JARVIS_WORKER_ROLE === "repair" ? (await import("./repair-outbox.js")).createOutboxMailer({ dir: (await import("./repair-service.js")).OUTBOX_DIR })
        : await import("./gmail.js").catch(() => null);
      const { syncConfig } = await import("./local-state.js");
      console.log(JSON.stringify(await runRepairOrders({ gmail, intake: intakeClient({ config: syncConfig() }) }), null, 2)); return 0;
    }
    if (flag("complete")) { const o = completeOrder(store, flag("complete")); console.log(`Abgeschlossen: ${o.order_id} → ${o.state}${o.state === COMPLETED_WITH_MANUAL_ITEMS ? ` (${manualItems(o).length} Punkt(e) manuell offen)` : ""}${o.access_intake ? " – Zugangsdaten zerstört; Kunden bitten, den temporären Zugang zu entfernen." : ""}`); return 0; }
    if (flag("cancel")) { const o = cancelRepairOrder(store, flag("cancel"), { reason: flag("reason") }); console.log(`Storniert: ${o.order_id} → ${o.state}${o.access_intake ? " – Zugangsdaten zerstört." : ""}`); return 0; }
    if (flag("confirm-host-key")) {
      const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
      const o = data.orders?.[flag("confirm-host-key")];
      if (!o) throw new Error("Auftrag nicht gefunden.");
      if (o.state !== "HOST_KEY_CONFIRMATION_REQUIRED") throw new Error(`Nur im Zustand HOST_KEY_CONFIRMATION_REQUIRED (aktuell ${o.state}).`);
      const { normFingerprint } = await import("./repair-adapters/common.js");
      const fp = normFingerprint(flag("fingerprint"));
      if (!fp || fp !== o.access_profile?.host_key_candidate) throw new Error("Fingerprint stimmt nicht exakt mit dem vom Server präsentierten Kandidaten überein – nichts bestätigt.");
      const at = new Date().toISOString();
      o.access_profile = { ...o.access_profile, host_key_sha256: fp, host_key_source: "chris_confirmation", host_key_confirmed_at: at, updated_at: at };
      o.state_history.push({ at, from: o.state, to: o.state, reason: "Host-Key von Chris bestätigt (unabhängig geprüft)" });
      store.write(REPAIR_ORDERS_FILE, data);
      console.log("Host-Key bestätigt. Beim nächsten Worker-Lauf läuft der Preflight weiter.");
      return 0;
    }
    if (flag("reissue-access")) {
      const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
      const o = data.orders?.[flag("reissue-access")];
      if (!o) throw new Error("Auftrag nicht gefunden.");
      if (!String(flag("reason") || "").trim()) throw new Error('Begründung ist Pflicht: --reason "<grund>".');
      if (o.state === "HOST_KEY_CONFIRMATION_REQUIRED") {
        // Abgelaufener Bestätigungslink: genau EIN neuer Link (nur durch Chris), nie solange der alte gilt.
        if (o.host_key_request?.received_at) throw new Error("Bestätigung bereits erhalten.");
        if (o.host_key_request?.sent_at && Date.parse(o.host_key_request.expires_at) > Date.now()) throw new Error("Der bestehende Bestätigungslink ist noch gültig – keine zweite Anfrage.");
        o.host_key_request_history = [...(o.host_key_request_history || []), { sent_at: o.host_key_request?.sent_at || null, expires_at: o.host_key_request?.expires_at || null, reissued_at: new Date().toISOString(), reason: String(flag("reason")).slice(0, 200) }];
        o.host_key_request = null;
        o.state_history.push({ at: new Date().toISOString(), from: o.state, to: o.state, reason: `Neuer Bestätigungslink durch Chris: ${String(flag("reason")).slice(0, 120)}` });
        store.write(REPAIR_ORDERS_FILE, data);
        console.log("Beim nächsten Worker-Lauf geht genau EINE neue Host-Key-Bestätigung mit neuem Link raus.");
        return 0;
      }
      if (o.state !== "ACCESS_REQUESTED" || o.access_intake?.status === "RECEIVED") throw new Error(`Nur ein wartender Auftrag (ACCESS_REQUESTED, ohne erhaltenen Zugang) – aktuell ${o.state}.`);
      if (o.access_request?.sent_at && Date.parse(o.access_request.expires_at) > Date.now()) throw new Error("Der bestehende Link ist noch gültig – keine zweite Anfrage.");
      o.access_request_history = [...(o.access_request_history || []), { sent_at: o.access_request?.sent_at || null, expires_at: o.access_request?.expires_at || null, reissued_at: new Date().toISOString(), reason: String(flag("reason")).slice(0, 200) }];
      o.access_request = null;
      o.state_history.push({ at: new Date().toISOString(), from: o.state, to: o.state, reason: `Neuer sicherer Link durch Chris: ${String(flag("reason")).slice(0, 120)}` });
      store.write(REPAIR_ORDERS_FILE, data);
      console.log("Beim nächsten Worker-Lauf geht genau EINE neue Zugangs-Anfrage mit neuem Link raus.");
      return 0;
    }
    if (flag("report")) { const o = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders?.[flag("report")]; if (!o?.report) throw new Error("Kein Bericht vorhanden."); console.log(`${o.report.subject}\n\n${o.report.body}`); return 0; }
    console.log("Befehle: --list | --show <id> | --create <domain> | --create-confirmed <domain> --email <adresse> | --authorize <id> --domain <d> --source <q> | --run | --complete <id> | --cancel <id> --reason <r> | --reissue-access <id> --reason <r> | --confirm-host-key <id> --fingerprint SHA256:… | --report <id>");
    return 1;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
