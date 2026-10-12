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
//   - Einzige Mail dieses Moduls: die Zugangs-Anfrage (CUSTOMER_ACCESS_REQUEST, über das injizierte gmail-Objekt). Der
//     Abschlussbericht wird nur gespeichert – Versand entscheidet Chris.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WORKER_DIR, createStore, createLogger, acquireLock, releaseLock } from "./mail-worker.js";
import { OFFERS } from "./sales.js";
import { paymentGateForOrder, paymentSummary, paymentThresholdChf } from "./payments.js";
import { ACCESS_AUTH_SOURCE, ACCESS_REQUEST_CLASS, accessKeys, accessLink, newIntakeToken, openAccessCredential, destroyAccessSecret,
  markSecretDestroyed, syncAccessIntake, intakeClient } from "./access-intake.js";
import { REPAIR_TYPES, selectCustomerVisibleFindings } from "./swiss-repair.js";
import { createAuditor } from "./site-auditor.js";
import { MAX_AUTO_FIXES_PER_ORDER, hasCapabilities, onlyCapabilities } from "./repair-adapters/common.js";

export const REPAIR_ORDERS_FILE = "repair_orders.json";
export const REPAIR_OFFER = "REPAIR_FIX_500"; // Kundenbezeichnung „Check & Reparatur“, Preis aus OFFERS (CHF 480). Keine dritte Preisstufe.

// ---------- Zustände ----------
// PAYMENT_REQUIRED (TF-041): die Zahlungsschwelle (CHF 240) ist nicht erfüllt – wartet, je Lauf neu geprüft, kein Zugang/Login/
// Adapter/Intake. ACCESS_REQUESTED: Kunde hat nach erfüllter Schwelle genau EINE Zugangs-Anfrage mit sicherem Link bekommen –
// wartet auf die Einreichung (Zugang + Freigabe) bzw. einen von Chris konfigurierten Adapter-Zugang.
// PAYMENT_REVIEW_REQUIRED: Zahlung fiel unter die Schwelle, nachdem die Website bereits verändert wurde – Chris entscheidet.
export const ORDER_STATES = Object.freeze(["ORDER_RECEIVED", "AUTHORIZATION_REQUIRED", "PAYMENT_REQUIRED", "ACCESS_CHECK",
  "ACCESS_REQUESTED", "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED"]);
export const BLOCKED_STATES = Object.freeze(["BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION", "BLOCKED_UNSUPPORTED_STACK",
  "REPAIR_FAILED", "VALIDATION_FAILED", "MANUAL_REVIEW_REQUIRED", "PAYMENT_REVIEW_REQUIRED", "BLOCKED_UNSAFE_ACCESS"]);
// TF-042: BLOCKED_UNSAFE_ACCESS = Zugang technisch möglich, aber unsicher (root-Login, Systemverzeichnis als Webroot, Symlink-Root).
// Von Chris storniert: terminal, Zugangsdaten werden zerstört, Datensatz bleibt (nie von Hand löschen).
export const REPAIR_CANCELLED = "CANCELLED";
const TERMINAL = new Set(["COMPLETED", REPAIR_CANCELLED, ...BLOCKED_STATES]);
// Ab diesen Zuständen wird mit dem Kundenzugang gearbeitet – fällt die Zahlung unter die Schwelle, stoppt der Auftrag.
const WORK_STATES = new Set(["BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY"]);
// Zugangsart aus dem sicheren Formular → passender Adapter-Schlüssel (nur wenn ein solcher Adapter konfiguriert ist).
const CONNECTOR_ADAPTER = { github_netlify: "github_netlify", wordpress_cms: "wordpress" };

// ---------- Autorisierung (Pflicht vor jeder Änderung) ----------
// Nur eine ausdrückliche, dokumentierte Kundenhandlung zählt. Deny by default – alles andere wird abgelehnt.
export const AUTHORIZATION_SOURCES = Object.freeze(["customer_reply_email", "customer_order_form", "signed_offer", "written_confirmation", ACCESS_AUTH_SOURCE]);
// Diese Quellen sind NIE eine Freigabe (werden auch bei Tippfehlern von Chris hart abgelehnt).
export const NEVER_AUTHORIZATION = Object.freeze(["cold_outreach", "cold_mail", "cold_draft", "lead_database", "public_website", "audit", "discovery", "voided_sale", "sales_record"]);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const TRANSIENT_RE = /\b(429|5\d\d)\b|rate|quota|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network/i;
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
export function createRepairOrder(store, { domain, website = null, lead_id = null, company = null, delivery_email = null, contact_name = null, now = new Date() } = {}) {
  const d = normDomain(domain);
  if (!d) throw new Error("Domain erforderlich.");
  // Verifizierte Kundenadresse des bestätigten Auftrags (optional): nur an sie darf die automatische Zugangs-Anfrage
  // gehen (TF-041) – NIE automatisch eine alte Cold-Outreach-Adresse. Ohne Adresse gibt es keine automatische Anfrage.
  if (delivery_email != null && !DELIVERY_EMAIL_RE.test(String(delivery_email))) throw new Error("Ungültige Kunden-E-Mail (--email) – weglassen oder gültige Adresse des bestätigten Auftrags angeben.");
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  // Höchstens ein offener Auftrag je Domain – ein zweiter Auftrag entsteht erst, wenn der erste abgeschlossen/blockiert ist.
  const open = Object.values(data.orders || {}).find((o) => normDomain(o.domain) === d && !TERMINAL.has(o.state));
  if (open) throw new Error(`Für ${d} läuft bereits Auftrag ${open.order_id} (${open.state}).`);
  const order_id = `RF480-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${sha(d + now.getTime()).slice(0, 6)}`;
  const order = {
    order_id, offer_class: REPAIR_OFFER, price_chf: OFFERS[REPAIR_OFFER].price, currency: "CHF",
    lead_id: lead_id || d, domain: d, website: website || `https://${d}/`, company,
    delivery_email: delivery_email ? String(delivery_email).toLowerCase() : null, contact_name,
    payment: { required_chf: OFFERS[REPAIR_OFFER].price / 2, paid_chf: 0, satisfied: false }, access_request: null,
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

// Abnahme/Abschluss durch Chris: erst damit wird der Auftrag ERLEDIGT.
export function completeOrder(store, orderId, { now = new Date() } = {}) {
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const order = data.orders?.[orderId];
  if (!order) throw new Error("Auftrag nicht gefunden.");
  if (order.state !== "READY_FOR_DELIVERY") throw new Error(`Nur ein Auftrag in READY_FOR_DELIVERY kann abgeschlossen werden (aktuell ${order.state}).`);
  transition(order, "COMPLETED", "Abschluss bestätigt", now);
  destroyOrderSecret(store, order, now); // Secret-Lebenszyklus (TF-041): nach COMPLETED kein Zugang mehr im Tresor
  return saveOrder(store, order);
}

// Stornieren durch Chris (TF-041): terminal, Zugangsdaten werden zerstört, Datensatz bleibt erhalten. Nie nach COMPLETED.
export function cancelRepairOrder(store, orderId, { reason = null, now = new Date() } = {}) {
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const order = data.orders?.[orderId];
  if (!order) throw new Error("Auftrag nicht gefunden.");
  if (!String(reason || "").trim()) throw new Error('Begründung ist Pflicht: --reason "<grund>".');
  if (order.state === "COMPLETED" || order.state === REPAIR_CANCELLED) throw new Error(`Auftrag ist bereits ${order.state}.`);
  transition(order, REPAIR_CANCELLED, `Von Chris storniert: ${String(reason).replace(/\s+/g, " ").trim().slice(0, 200)}`, now);
  destroyOrderSecret(store, order, now);
  return saveOrder(store, order);
}

// Tresor-Eintrag zerstören und nur Metadaten behalten (connector_type, received_at, destroyed_at, revoked_required).
function destroyOrderSecret(store, order, now) {
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
// TF-042: deps.router (repair-adapters/router.js) wählt bei sicher übermitteltem Zugang den Adapter nach tatsächlichen
// Fähigkeiten (order.route). Contract-Adapter (WordPress/SFTP/SSH) kommen über die Brücke mit identischer Aufrufform und
// direct_live = true (Änderungen sind sofort live → jede fehlgeschlagene Prüfung führt zum Rollback). Allen Adapter-Aufrufen
// wird der Zugangskontext (accessCtx) als letztes Argument mitgegeben; Zugangsdaten werden nur darin zur Laufzeit geöffnet.
export function createRepairEngine({ dir = WORKER_DIR, store = createStore(dir), adapters = {}, auditor = null, retester = null,
  gmail = null, intake = null, router = null, alert = null, now = () => new Date(), log = () => {} } = {}) {

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
  const audit = (website) => fullSiteAudit(website, { auditor, now });
  // Wurde an der Website bereits etwas verändert (angewendete Fixes oder Deployment)?
  const changedWebsite = (order) => !!order.deployment || Object.values(order.issues || {}).some((i) => ["repaired", "still_broken"].includes(i.repair_status) || i.change_ref);

  // VORHER gegen NACHHER: neue relevante (≥ medium) Befunde, die es vorher nicht gab → Regression.
  const regression = (before, after) => {
    const had = new Set(Object.values(before?.issues || {}).map(issueKey));
    return Object.values(after?.issues || {}).filter((i) => RELEVANT.has(i.severity) && !had.has(issueKey(i))).map((i) => ({ type: i.type, page: i.page, severity: i.severity, evidence: i.evidence }));
  };
  const rollbackThen = async (order, adapter, failReason) => {
    const can = typeof adapter?.rollback === "function";
    const r = can ? await adapter.rollback(order, accessCtx(order)).catch(() => ({ ok: false })) : { ok: false };
    order.regression = { ...(order.regression || {}), rolled_back: r.ok === true };
    if (r.ok === true && adapter?.direct_live) {
      // Direkt-live-Adapter: Rollback danach erneut prüfen (Website erreichbar, keine neuen relevanten Befunde gegenüber VORHER).
      const after = await audit(order.website).catch(() => ({ ok: false, issues: {} }));
      const reg = after.ok ? regression(order.audit_before, after) : [{ type: "unreachable" }];
      order.regression.rollback_verified = !reg.length;
      if (reg.length) { await informChris(order, "rollback_unverified", failReason); return manual(order, `${failReason} – Rollback ausgeführt, aber die Prüfung danach ist nicht sauber; Website-Zustand manuell prüfen.`); }
    }
    if (r.ok === true) return block(order, "REPAIR_FAILED", `${failReason} – auf den letzten sicheren Stand zurückgerollt.`);
    await informChris(order, "rollback_failed", failReason);
    return manual(order, `${failReason} – Rollback ${can ? "fehlgeschlagen" : "über diesen Kanal nicht verfügbar"}; Website-Zustand manuell prüfen.`);
  };

  // Genau einen Schritt ausführen. Rückgabe true = es ging weiter (erneut aufrufen), false = wartet/fertig/blockiert.
  async function step(order) {
    const t = now();
    const adapter = adapterOf(order);

    // Zahlung fiel während der Arbeit unter die Schwelle (void/refund): vor jeder Änderung → warten; danach → Chris entscheidet.
    if (WORK_STATES.has(order.state)) {
      const gate = paymentGateForOrder(store, order);
      if (!gate.satisfied) {
        order.payment = gate;
        if (changedWebsite(order)) { block(order, "PAYMENT_REVIEW_REQUIRED", `Zahlung unter die Schwelle gefallen (CHF ${gate.paid_chf} von mind. CHF ${gate.required_chf}), Website wurde bereits verändert – kein automatischer Rollback, Chris entscheidet.`); return false; }
        transition(order, "PAYMENT_REQUIRED", `Zahlung unter die Schwelle gefallen (CHF ${gate.paid_chf} von mind. CHF ${gate.required_chf}) – noch nichts verändert, wartet.`, t);
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
      if (order.payment?.paid_chf !== gate.paid_chf) { order.payment = gate; order.updated_at = t.toISOString(); saveOrder(store, order); }
      if (gate.satisfied && canRequestAccess(order) && !order.access_request?.sent_at) {
        transition(order, "ACCESS_REQUESTED", `Zahlungsschwelle erfüllt (CHF ${gate.paid_chf} ≥ ${gate.required_chf}) – sicherer Link für Zugang + Freigabe`, t);
        saveOrder(store, order); return true;
      }
      return false; // wartet auf Zahlung bzw. Freigabe
    }

    if (order.state === "PAYMENT_REQUIRED") {
      // ZAHLUNGSSCHWELLE (TF-041): wird je Lauf neu geprüft – vor kumulativ CHF 240 keine Zugangsdaten anfordern,
      // kein Login, keine Website-Änderung, keine Reparatur. Verbucht Chris die Zahlung, läuft der Auftrag automatisch weiter.
      const gate = paymentGateForOrder(store, order);
      if (!gate.satisfied) {
        if (order.payment?.paid_chf !== gate.paid_chf) { order.payment = gate; order.updated_at = t.toISOString(); saveOrder(store, order); }
        return false; // wartet auf Zahlung
      }
      order.payment = gate;
      const next = authorizationOk(order) ? "ACCESS_CHECK" : order.access_request?.sent_at ? "ACCESS_REQUESTED" : "AUTHORIZATION_REQUIRED";
      transition(order, next, `Zahlungsschwelle erfüllt (CHF ${gate.paid_chf} ≥ ${gate.required_chf})`, t); saveOrder(store, order); return true;
    }

    if (order.state === "ACCESS_CHECK") {
      if (!domainBound(order)) { block(order, "BLOCKED_NO_AUTHORIZATION", "Freigabe fehlt oder Domain (Auftrag/Freigabe/Zugang) stimmt nicht überein."); return false; }
      // ZAHLUNGSSCHWELLE (TF-041) VOR jedem Zugang: ohne kumulativ CHF 240 wird hier nichts geprüft und nichts angefragt.
      const gate = paymentGateForOrder(store, order);
      order.payment = gate;
      if (!gate.satisfied) {
        transition(order, "PAYMENT_REQUIRED", `Zahlung ausstehend: CHF ${gate.paid_chf} von mind. CHF ${gate.required_chf} eingegangen (payments.js record ${order.order_id}).`, t);
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
      if (order.stack.type === "other" && !intakeReceived(order)) { block(order, "BLOCKED_UNSUPPORTED_STACK", "Stack nicht erkannt – kein sicher unterstützter Reparaturweg."); return false; }
      const a = adapterOf(order);
      if (!a || typeof a.checkAccess !== "function") return requestAccessOrBlock(order, intakeReceived(order)
        ? `Zugang (${order.access_intake.connector_type}) erhalten, aber kein automatischer Reparaturweg für Stack "${order.stack.type}" – Chris übernimmt manuell.`
        : `Kein sicherer Zugangsweg für Stack "${order.stack.type}" konfiguriert. Zugangsdaten werden nie erraten.`);
      const acc = await a.checkAccess(order, accessCtx(order)).catch((e) => ({ ok: false, error: e.message }));
      // Unsicherer Zugang (root, Systemverzeichnis …) wird nie „repariert“ – eigener Endzustand, keine zweite Anfrage.
      if (acc?.ok !== true && ["BLOCKED_UNSAFE_ACCESS", "BLOCKED_UNSUPPORTED_STACK"].includes(acc?.blocked_state)) { block(order, acc.blocked_state, `Zugang abgelehnt (${String(acc.reason || "unsicher").slice(0, 60)}) – keine automatische Reparatur.`); return false; }
      if (acc?.ok !== true) return requestAccessOrBlock(order, `Zugangsprüfung fehlgeschlagen${acc?.reason ? ` (${String(acc.reason).slice(0, 60)})` : ""} – keine Änderung ohne sicheren Zugang.`);
      const caps = Array.isArray(acc.capabilities) ? onlyCapabilities(acc.capabilities) : (router?.capabilitiesOf?.(order.route?.adapter || order.stack.type) || null);
      order.access = { connector: acc.connector || order.stack.type, ok: true, checked_at: t.toISOString(), ...(caps ? { capabilities: caps } : {}) }; // nie mehr Felder übernehmen (keine Secrets)
      if (caps && !hasCapabilities(caps, ["BACKUP", "ROLLBACK"])) { manual(order, "Zugang ohne zuverlässiges Backup/Rollback – keine automatische Reparatur."); return false; }
      transition(order, "BACKUP", "Zugang geprüft", t); saveOrder(store, order); return true;
    }

    if (order.state === "ACCESS_REQUESTED") {
      // Nach erfüllter Zahlungsschwelle wird der Kunde GENAU EINMAL automatisch per Service-Mail (CUSTOMER_ACCESS_REQUEST) um
      // SICHEREN Zugang gebeten – über einen auftragsgebundenen One-Time-Link. Danach wartet der Auftrag auf die Einreichung
      // (Zugang + Pflicht-Freigabe, syncAccessIntake) bzw. einen von Chris konfigurierten Adapter-Zugang. Nie Passwörter per Mail.
      const gate = paymentGateForOrder(store, order);
      order.payment = gate;
      if (!gate.satisfied) { transition(order, "PAYMENT_REQUIRED", `Zahlungsschwelle nicht mehr erfüllt (CHF ${gate.paid_chf} von mind. CHF ${gate.required_chf}).`, t); saveOrder(store, order); return false; }
      if (!order.access_request?.sent_at) {
        if (!canRequestAccess(order)) {
          block(order, "BLOCKED_NO_ACCESS", "Keine automatische Zugangs-Anfrage möglich (Kundenadresse, sicherer Link oder Versandweg fehlt) – Zugangsdaten werden nie erraten."); return false;
        }
        // Send-Idempotenz: ein früherer Versuch ohne gesicherten Ausgang wird NIE blind wiederholt (Chris prüft «Gesendet»).
        if (order.access_request?.send_attempted_at) {
          if (!order.access_request.send_unclear) { order.access_request = { ...order.access_request, send_unclear: true }; order.updated_at = t.toISOString(); saveOrder(store, order); log("warn", "repair_access_request_unclear", { order_id: order.order_id }); }
        } else {
          try {
            if (!order.access_request?.draft_id) {
              // Neuer One-Time-Link: nur der Hash wird registriert/gespeichert; der Token steht ausschliesslich in der Mail.
              const tk = newIntakeToken({ now: t });
              await intake.register({ order_id: order.order_id, domain: order.domain, token_hash: tk.token_hash, expires_at: tk.expires_at, public_key: accessKeys(store.dir).publicKeyPem });
              const mail = buildAccessRequestMail(order, { link: accessLink(intake.origin, tk.token), expires_at: tk.expires_at });
              const d = await gmail.createDraft({ to: order.delivery_email, subject: mail.subject, body: mail.body, messageClass: ACCESS_REQUEST_CLASS });
              order.access_request = { to: order.delivery_email, draft_id: d.draftId, message_class: ACCESS_REQUEST_CLASS, token_hash: tk.token_hash, expires_at: tk.expires_at, created_at: t.toISOString() };
              order.updated_at = t.toISOString();
              saveOrder(store, order); // Draft-ID sofort persistieren – ein Neustart erzeugt nie ein Duplikat
            }
            order.access_request = { ...order.access_request, send_attempted_at: t.toISOString() };
            saveOrder(store, order); // VOR dem Versand – ein Absturz danach führt nie zu einer zweiten Mail
            await gmail.sendDraft(order.access_request.draft_id);
          } catch (e) {
            if (order.access_request?.send_attempted_at) { order.access_request = { ...order.access_request, send_attempted_at: null }; saveOrder(store, order); }
            if (TRANSIENT_RE.test(e.message)) { log("warn", "repair_access_request_deferred", { order_id: order.order_id, error: String(e.message).slice(0, 160) }); return false; } // nächster Lauf
            block(order, "BLOCKED_NO_ACCESS", `Automatische Zugangs-Anfrage fehlgeschlagen: ${String(e.message).slice(0, 120)}`); return false;
          }
          order.access_request = { ...order.access_request, sent_at: t.toISOString() };
          order.updated_at = t.toISOString();
          saveOrder(store, order);
          log("info", "repair_access_requested", { order_id: order.order_id, message_class: ACCESS_REQUEST_CLASS });
        }
      }
      // Sicherer Zugang + Freigabe über das Formular eingegangen → Zugangsprüfung (Domain-Bindung wird dort erneut geprüft).
      if (intakeReceived(order)) {
        if (!domainBound(order)) { block(order, "BLOCKED_NO_AUTHORIZATION", "Domain des Zugangs/der Freigabe stimmt nicht mit dem Auftrag überein."); return false; }
        transition(order, "ACCESS_CHECK", "Sicherer Zugang und Reparaturfreigabe über das Auftragsformular erhalten", t); saveOrder(store, order); return true;
      }
      // Alternativ: Freigabe liegt vor und Chris hat den sicher erhaltenen Zugang als Adapter konfiguriert.
      const a = adapterOf(order);
      if (authorizationOk(order) && a && typeof a.checkAccess === "function") {
        const acc = await a.checkAccess(order, accessCtx(order)).catch(() => ({ ok: false }));
        if (acc?.ok === true) {
          order.access = { connector: acc.connector || order.stack.type, ok: true, checked_at: t.toISOString() }; // nie Secrets
          transition(order, "BACKUP", "Sicherer Zugang erhalten und geprüft", t); saveOrder(store, order); return true;
        }
      }
      return false; // wartet auf sicheren Zugang (+ Freigabe)
    }

    if (order.state === "BACKUP") {
      const branch = `repair/${order.order_id}`;
      const b = await adapter.backup(order, { branch }, accessCtx(order)).catch((e) => ({ error: e.message }));
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
      const repairables = Object.values(order.issues).filter((i) => i.repairable);
      for (const i of Object.values(order.issues)) if (i.protected) order.manual_review.push({ at: t.toISOString(), reason: `Befund ${i.issue_id} liegt auf einer geschützten Seite (${i.page}) – nur mit zusätzlicher expliziter Freigabe.`, issue_id: i.issue_id });
      const plan = [];
      for (const i of repairables) {
        const loc = await adapter.locate(i, order, accessCtx(order)).catch(() => null);
        const review = (reason) => { order.issues[i.issue_id].repair_status = "needs_review"; order.manual_review.push({ at: t.toISOString(), reason, issue_id: i.issue_id }); };
        if (!loc || !loc.target || !loc.cause) { review(`Ursache für ${i.type} (${i.page}) nicht eindeutig – keine automatische Reparatur.`); continue; } // nie raten
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
      transition(order, plan.length ? "REPAIRING" : "VALIDATION", plan.length ? `Plan: ${plan.length} Reparaturen` : "Keine automatisch behebbaren Befunde – nur Prüfung/Bericht", t);
      saveOrder(store, order); return true;
    }

    if (order.state === "REPAIRING") {
      let okCount = 0;
      for (const item of order.plan) {
        if (order.issues[item.issue_id].repair_status === "repaired") { okCount++; continue; } // nach Neustart nie doppelt schreiben
        // Domain-Bindung unmittelbar vor JEDEM Write (der Adapter prüft zusätzlich Zugangs- und Live-Domain).
        if (!domainBound(order)) { if (changedWebsite(order)) { await rollbackThen(order, adapter, "Domain-Bindung vor dem Schreiben verletzt – STOP"); return false; } block(order, "BLOCKED_NO_AUTHORIZATION", "Domain-Bindung vor dem Schreiben verletzt – STOP."); return false; }
        const r = await adapter.applyFix(item, order, accessCtx(order)).catch((e) => ({ ok: false, error: e.message }));
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
      if (typeof adapter.validate === "function") v = await adapter.validate(order, accessCtx(order)).catch((e) => ({ build_ok: false, error: e.message }));
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
      order.validation = { build_ok: true, preview_url: v.preview_url || null, target, audited_at: after.audited_at, open_issues: Object.keys(after.issues).length };
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
      if (typeof retester === "function") {
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
      order.retest = { desktop, mobile, tested_at: t.toISOString(), target };
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
        order.deployment.live_retest_ok = true;
      } else if (order.plan.length) {
        order.deployment = { deployed: false, note: `Änderungen liegen im Branch ${order.backup.branch} – Produktions-Deployment über den bestehenden Kanal durch Chris.` };
      }
      order.report = buildCustomerReport(order);
      transition(order, "READY_FOR_DELIVERY", "Retest bestanden, Bericht erstellt", t); saveOrder(store, order); return true;
    }

    return false; // READY_FOR_DELIVERY/terminal: wartet auf completeOrder() bzw. nichts mehr zu tun
  }

  // Alle offenen Aufträge weiterarbeiten – nach Neustart exakt am gespeicherten Zustand. Ein Fehler stoppt nie die anderen.
  async function processAll() {
    const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
    const open = Object.values(data.orders || {}).filter((o) => !TERMINAL.has(o.state));
    let advanced = 0;
    for (const stored of open) {
      const order = structuredClone(stored);
      try { for (let guard = 0; guard < 20 && await step(order); guard++) advanced++; }
      catch (e) { log("error", "repair_order_failed", { order_id: order.order_id, state: order.state, error: e.message }); manual(order, `Unerwarteter Fehler im Zustand ${order.state}: ${e.message}`); }
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
export function buildAccessRequestMail(order, { link = null, expires_at = null } = {}) {
  const until = expires_at ? new Intl.DateTimeFormat("de-CH", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Zurich" }).format(new Date(expires_at)) : null;
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

// ---------- Kundenbericht (verständlich, ohne Fachjargon; wird nur gespeichert, nie automatisch versendet) ----------
// Für den Kunden: keine internen IDs, keine Git-Referenzen, keine Roh-Evidence, keine internen Pfade, keine Tokens.
export function buildCustomerReport(order, { now = new Date() } = {}) {
  const issues = Object.values(order.issues || {});
  const fixed = issues.filter((i) => i.repair_status === "repaired");
  const openForReview = issues.filter((i) => ["needs_review", "repair_failed", "still_broken"].includes(i.repair_status) || (i.repair_status === "open" && !i.repairable));
  const relevant = issues.filter((i) => RELEVANT.has(i.severity) || i.customer_text);
  const line = (i) => `• ${i.customer_text || "Ein technischer Punkt auf " + (i.page || "Ihrer Website")}`;
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
    fixed.length ? "Behoben wurden:" : "Behoben wurde nichts – es gab keine im Paket abgedeckten, automatisch behebbaren Fehler.",
    ...fixed.map((i) => `${line(i)} – behoben und erneut geprüft.`),
    "",
    ...(openForReview.length ? ["Nicht automatisch repariert – zur Besprechung (nicht automatisch verändert):", ...openForReview.map(line), ""] : []),
    "Abschlusskontrolle:",
    `Desktop: ${order.retest?.desktop?.ok ? "geprüft, in Ordnung" : "siehe Hinweis"} (${order.retest?.desktop?.method || "–"}).`,
    `Smartphone: ${order.retest?.mobile?.ok ? "geprüft, in Ordnung" : "siehe Hinweis"} (${order.retest?.mobile?.method || "–"}).`,
    "",
    order.deployment?.deployed ? "Die Korrekturen sind auf Ihrer Website live und wurden danach erneut geprüft."
      : order.plan?.length ? "Die Korrekturen sind vorbereitet und werden nach Rücksprache aufgeschaltet." : "An Ihrer Website wurde nichts verändert.",
    "",
    ...(order.access_intake ? ["Wichtig: Bitte entfernen Sie jetzt den temporären Zugang, den Sie für diesen Auftrag eingerichtet haben (bzw. ändern Sie das Passwort). Die Zugangsdaten werden bei uns mit dem Abschluss gelöscht.", ""] : []),
    "Bei Fragen genügt eine kurze Antwort auf diese E-Mail.",
  ].join("\n");
  return { subject: `Webseiten-Check ${order.domain} – Abschlussbericht`, body, created_at: new Date().toISOString() };
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
    ready_for_delivery: states.READY_FOR_DELIVERY || 0, cancelled: states[REPAIR_CANCELLED] || 0,
    manual_review: states.MANUAL_REVIEW_REQUIRED || 0, unsafe_access: states.BLOCKED_UNSAFE_ACCESS || 0 };
}

// Kundenphase fürs Dashboard (TF-041) – feste Wörter, aus Zustand + Zahlung + Zugang abgeleitet.
export const REPAIR_PHASES = Object.freeze(["WAITING_FOR_DEPOSIT", "WAITING_FOR_ACCESS", "ACCESS_REQUEST_SENT", "ACCESS_RECEIVED", "BACKUP", "REPAIRING",
  "VALIDATING", "LIVE_RETEST", "READY_FOR_DELIVERY", "COMPLETED", "MANUAL_REVIEW", "PAYMENT_REVIEW_REQUIRED", "CANCELLED", "BLOCKED"]);
export function repairPhase(o, pay) {
  if (o.state === "COMPLETED") return "COMPLETED";
  if (o.state === REPAIR_CANCELLED) return "CANCELLED";
  if (o.state === "PAYMENT_REVIEW_REQUIRED") return "PAYMENT_REVIEW_REQUIRED";
  if (o.state === "MANUAL_REVIEW_REQUIRED") return "MANUAL_REVIEW";
  if (BLOCKED_STATES.includes(o.state)) return "BLOCKED";
  if (o.state === "READY_FOR_DELIVERY") return "READY_FOR_DELIVERY";
  if (o.state === "VALIDATION") return "VALIDATING";
  if (o.state === "RETEST") return "LIVE_RETEST";
  if (["REPAIRING", "FULL_AUDIT", "REPAIR_PLAN"].includes(o.state)) return "REPAIRING";
  if (o.state === "BACKUP") return "BACKUP";
  if (!["DEPOSIT_MET", "PAID_FULL"].includes(pay.payment_status)) return "WAITING_FOR_DEPOSIT";
  if (o.access_intake?.status === "RECEIVED") return "ACCESS_RECEIVED";
  if (o.access_request?.sent_at && Date.parse(o.access_request.expires_at || 0) > Date.now()) return "ACCESS_REQUEST_SENT";
  return "WAITING_FOR_ACCESS";
}

// Allowlist-Sicht für Dashboard/Cloud/Handy: Zähler + je Auftrag nur die hier aufgezählten, ungefährlichen Felder.
// NIE: Evidence, URLs einzelner Befunde, Branch-/Commit-/Deploy-Referenzen, Preview-URLs, Freigabe-Referenzen, Tokens,
// Token-Hashes, Zahlungsreferenzen, Zugangsdaten oder Kundenadressen, Historie.
export const PUBLIC_REPAIR_FIELDS = Object.freeze(["order_id", "company", "domain", "offer_class", "price_chf", "state", "phase", "findings",
  "repaired", "needs_review", "backup_ok", "desktop_retest", "mobile_retest", "production", "report_available",
  "paid_chf", "payment_required_chf", "rest_to_deposit_chf", "payment_status", "payment_ok", "access_requested", "access_received",
  "access_type", "adapter", "access_ok", "rollback_ok", "auto_fixable", "manual_review", "created_at", "updated_at"]);
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
        state: o.state, phase: repairPhase(o, pay), findings: issues.length, repaired: issues.filter((i) => i.repair_status === "repaired").length,
        needs_review: (o.manual_review || []).length,
        backup_ok: !!(o.backup?.rollback_point), desktop_retest: o.retest ? o.retest.desktop?.ok === true : null,
        mobile_retest: o.retest ? o.retest.mobile?.ok === true : null,
        production: o.deployment?.deployed === true ? "DEPLOYED" : o.deployment ? "BRANCH_ONLY" : "UNCHANGED",
        report_available: !!o.report,
        // Zahlungsstand (TF-041): nur Zahlen/Flags/Zustandswort aus dem Ledger – nie Referenzen, nie Zahlungsdetails.
        paid_chf: pay.paid_chf, payment_required_chf: pay.deposit_chf, rest_to_deposit_chf: pay.rest_to_deposit_chf,
        payment_status: pay.payment_status, payment_ok: pay.deposit_chf != null && pay.paid_chf >= pay.deposit_chf,
        // Zugang: nur Ja/Nein + Zugangsart – nie Link, Token(-Hash), Zugangsdaten oder Tresor-Pfad.
        access_requested: !!o.access_request?.sent_at, access_received: o.access_intake?.status === "RECEIVED" || o.access_intake?.status === "DESTROYED",
        access_type: o.access_intake?.connector_type || null,
        // TF-042: Adapter, Zugang geprüft, Rollback möglich, automatisch behebbar, manuelle Prüfung – nur Wörter/Zahlen/Flags.
        adapter: adapterWord(o), access_ok: o.access?.ok === true,
        rollback_ok: !!o.backup?.rollback_point && (!o.access?.capabilities || o.access.capabilities.includes("ROLLBACK")),
        auto_fixable: (o.plan || []).length, manual_review: (o.manual_review || []).length,
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
    registryCache = { status: "ACTIVE", adapters: ["github_netlify", "wordpress", "sftp", "ssh"], ssh_library: ssh };
  }
  return registryCache;
}

// Standard-Abhängigkeiten für den Produktivbetrieb: GitHub+Netlify-Adapter (nur mit explizitem Mapping + Env-Tokens wirksam)
// und – falls Playwright installiert ist – der echte Browser-Rendertest. Fehler beim Laden → ohne (fail closed, nur Audit/Blocked).
// TF-042: zusätzlich WordPress REST, SFTP und SSH/SFTP über den Router (repair-adapters/router.js). Ohne Zugangsprofil/Tresor
// bleiben sie wirkungslos (fail closed). Ladefehler eines Adapters → ohne ihn (nie ein Absturz des Workers).
export async function loadDefaultRepairDeps({ dir = WORKER_DIR } = {}) {
  let adapters = {}, router = null;
  try { const m = await import("./repair-adapters/github-netlify.js"); adapters = { github_netlify: m.githubNetlifyAdapter({ dir }) }; } catch {}
  try { const reg = await (await import("./repair-adapters/router.js")).createAdapterRegistry({ dir, legacy: adapters }); adapters = reg.adapters; router = reg.router; } catch {}
  let retester = null;
  try { retester = await (await import("./repair-render-test.js")).loadRenderRetester(); } catch {}
  return { adapters, retester, router };
}

// ---------- Worker-Hook (eigenes Lock, nie zwei Läufe; ohne explizite Deps werden die Standard-Deps geladen) ----------
// gmail (optional): nur für die automatische Zugangs-Anfrage nach erfüllter Zahlungsschwelle (TF-041).
// intake (optional, access-intake.js intakeClient): sicherer One-Time-Link; vor dem Engine-Lauf werden eingegangene
// Einreichungen abgeholt (nur wenn ein Auftrag darauf wartet – kein Netzverkehr ohne Grund). Ohne gmail/intake bleibt
// fehlender Zugang wie bisher BLOCKED_NO_ACCESS – es wird nie etwas erraten.
export async function runRepairOrders({ dir = WORKER_DIR, adapters = null, retester = null, router = null, gmail = null, intake = null, log = createLogger(dir) } = {}) {
  const status = repairOrdersStatus(dir);
  if (!status.open) return { busy: false, processed: 0, advanced: 0, states: status.states };
  if (!acquireLock(dir, { name: "repair.lock" })) return { busy: true };
  try {
    if (!adapters) {
      const defaults = await loadDefaultRepairDeps({ dir });
      adapters = defaults.adapters;
      retester = retester || defaults.retester;
      router = router || defaults.router;
    }
    const store = createStore(dir);
    let access = null;
    const waiting = Object.values(store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders || {}).some((o) => o.state === "ACCESS_REQUESTED" && o.access_request?.sent_at && o.access_intake?.status !== "RECEIVED");
    if (intake && waiting) access = await syncAccessIntake({ store, intake, log });
    const engine = createRepairEngine({ dir, store, adapters, retester, router, gmail, intake, log });
    return { busy: false, ...(await engine.processAll()), ...(access ? { access_intake: access } : {}) };
  } finally { releaseLock(dir, process.pid, "repair.lock"); }
}

// ---------- Kommandozeile ----------
// Zahlung verbuchen (TF-041): node payments.js record <order_id> --amount 240 --reference "<ref>" – erst ab CHF 240 fragt
// Jarvis (einmal, über den sicheren Link) nach Zugang. Zugangsdaten-Tresor: node access-intake.js status|destroy <order_id>.
// node repair-workflow.js --list | --status | --show <order_id> | --create <domain> [--website URL] [--lead ID] [--company NAME]
//                         [--email <kundenadresse>] [--name ANREDE]
//                         | --authorize <order_id> --domain <domain> --source <quelle> [--reference TEXT]
//                         | --run | --complete <order_id> | --report <order_id> | --cancel <order_id> --reason TEXT
//                         | --reissue-access <order_id> --reason TEXT   (abgelaufener Link: genau EINE neue Anfrage, nur durch Chris)
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
    if (flag("create")) {
      const o = createRepairOrder(store, { domain: flag("create"), website: flag("website"), lead_id: flag("lead"), company: flag("company"), delivery_email: flag("email"), contact_name: flag("name") });
      console.log(`Auftrag angelegt: ${o.order_id} (${o.state}).`);
      console.log(`Zahlungsschwelle (TF-041): Zugangs-Anfrage/Reparatur erst ab kumulativ CHF ${paymentThresholdChf(REPAIR_OFFER)} – Zahlung verbuchen: node payments.js record ${o.order_id} --amount ${paymentThresholdChf(REPAIR_OFFER)} --reference "<Bankreferenz>"`);
      console.log(`Freigabe kommt über das sichere Formular (Pflicht-Zustimmung) oder: node repair-workflow.js --authorize ${o.order_id} --domain ${o.domain} --source customer_reply_email --reference "<woher>"`);
      return 0;
    }
    if (flag("authorize")) { const o = authorizeRepair(store, flag("authorize"), { authorized_domain: flag("domain"), source: flag("source"), reference: flag("reference") }); console.log(`Freigabe gesetzt: ${o.order_id} → ${o.state}`); return 0; }
    if (argv.includes("--run")) {
      const gmail = await import("./gmail.js").catch(() => null);
      const { syncConfig } = await import("./local-state.js");
      console.log(JSON.stringify(await runRepairOrders({ gmail, intake: intakeClient({ config: syncConfig() }) }), null, 2)); return 0;
    }
    if (flag("complete")) { const o = completeOrder(store, flag("complete")); console.log(`Abgeschlossen: ${o.order_id} → ${o.state}${o.access_intake ? " – Zugangsdaten zerstört; Kunden bitten, den temporären Zugang zu entfernen." : ""}`); return 0; }
    if (flag("cancel")) { const o = cancelRepairOrder(store, flag("cancel"), { reason: flag("reason") }); console.log(`Storniert: ${o.order_id} → ${o.state}${o.access_intake ? " – Zugangsdaten zerstört." : ""}`); return 0; }
    if (flag("reissue-access")) {
      const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
      const o = data.orders?.[flag("reissue-access")];
      if (!o) throw new Error("Auftrag nicht gefunden.");
      if (!String(flag("reason") || "").trim()) throw new Error('Begründung ist Pflicht: --reason "<grund>".');
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
    console.log("Befehle: --list | --show <id> | --create <domain> | --authorize <id> --domain <d> --source <q> | --run | --complete <id> | --cancel <id> --reason <r> | --reissue-access <id> --reason <r> | --report <id>");
    return 1;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
