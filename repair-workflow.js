// CHECK & REPARATUR (CHF 480) — Autopilot (TF-035). Persistenter Reparatur-Workflow für BEZAHLTE, vom Kunden ausdrücklich
// freigegebene Aufträge: AUFTRAG → AUTORISIERUNG → ZUGANG → BACKUP → VOLL-AUDIT → PLAN → REPARATUR → VALIDIERUNG → RETEST →
// BEREIT → ERLEDIGT. Jeder Zustand liegt atomar in repair_orders.json und wird nach einem VPS-/Worker-Neustart dort fortgesetzt.
//
// Harte Regeln (fail closed, keine Ausnahme):
//   - Ohne customer_authorized_repair = true UND exakt übereinstimmende Domain wird NIE etwas verändert – nur ein passiver
//     Audit, Status AUTHORIZATION_REQUIRED. Cold-Outreach (Entwurf, Antwort „interessant“) ist NIE eine Reparaturfreigabe.
//   - Änderungen laufen nur über einen Stack-Adapter mit sicherem, bereits konfiguriertem Zugang (Secrets NIE in dieser Datei,
//     NIE im Order-JSON, NIE im Bericht). Kein Adapter/Zugang → BLOCKED_NO_ACCESS; unbekannter Stack → BLOCKED_UNSUPPORTED_STACK.
//   - Vor jeder Änderung: Produktionsstand erfasst + Backup + Rollback-Punkt + Reparatur-Branch repair/<order-id>. Fehlt etwas →
//     MANUAL_REVIEW_REQUIRED, nichts wird angefasst. Nie blind auf main/Production.
//   - MINIMAL SAFE FIX: nur Befunde mit eindeutiger Ursache, innerhalb des CHF-480-Pakets, nie Design/Texte/Branding.
//     Geschützte Inhalte (Impressum, Datenschutz, AGB, Preise, Zahlung, DNS, Kundendaten …) nie automatisch → MANUAL_REVIEW_REQUIRED.
//   - Nach der Reparatur: Validierung + Regression (VORHER gegen NACHHER). Neue relevante Probleme → Rollback, nie „erfolgreich“.
//   - Dieses Modul sendet nie E-Mails; der Abschlussbericht wird nur gespeichert – Versand entscheidet Chris.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore, createLogger, acquireLock, releaseLock } from "./mail-worker.js";
import { OFFERS } from "./sales.js";
import { REPAIR_TYPES, selectCustomerVisibleFindings } from "./swiss-repair.js";
import { createAuditor } from "./site-auditor.js";

export const REPAIR_ORDERS_FILE = "repair_orders.json";
export const REPAIR_OFFER = "REPAIR_FIX_500"; // Kundenbezeichnung „Check & Reparatur“, Preis aus OFFERS (CHF 480). Keine dritte Preisstufe.

// ---------- Zustände ----------
export const ORDER_STATES = Object.freeze(["ORDER_RECEIVED", "AUTHORIZATION_REQUIRED", "ACCESS_CHECK", "BACKUP", "FULL_AUDIT",
  "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED"]);
export const BLOCKED_STATES = Object.freeze(["BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION", "BLOCKED_UNSUPPORTED_STACK",
  "REPAIR_FAILED", "VALIDATION_FAILED", "MANUAL_REVIEW_REQUIRED"]);
const TERMINAL = new Set(["COMPLETED", ...BLOCKED_STATES]);

// ---------- Autorisierung (Pflicht vor jeder Änderung) ----------
// Nur eine ausdrückliche, dokumentierte Kundenhandlung zählt. Deny by default – alles andere wird abgelehnt.
export const AUTHORIZATION_SOURCES = Object.freeze(["customer_reply_email", "customer_order_form", "signed_offer", "written_confirmation"]);
// Diese Quellen sind NIE eine Freigabe (werden auch bei Tippfehlern von Chris hart abgelehnt).
export const NEVER_AUTHORIZATION = Object.freeze(["cold_outreach", "cold_mail", "cold_draft", "lead_database", "public_website", "audit", "discovery"]);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
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
export function createRepairOrder(store, { domain, website = null, lead_id = null, company = null, now = new Date() } = {}) {
  const d = normDomain(domain);
  if (!d) throw new Error("Domain erforderlich.");
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  // Höchstens ein offener Auftrag je Domain – ein zweiter Auftrag entsteht erst, wenn der erste abgeschlossen/blockiert ist.
  const open = Object.values(data.orders || {}).find((o) => normDomain(o.domain) === d && !TERMINAL.has(o.state));
  if (open) throw new Error(`Für ${d} läuft bereits Auftrag ${open.order_id} (${open.state}).`);
  const order_id = `RF480-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${sha(d + now.getTime()).slice(0, 6)}`;
  const order = {
    order_id, offer_class: REPAIR_OFFER, price_chf: OFFERS[REPAIR_OFFER].price, currency: "CHF",
    lead_id: lead_id || d, domain: d, website: website || `https://${d}/`, company,
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
  return saveOrder(store, order);
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
export function createRepairEngine({ dir = WORKER_DIR, store = createStore(dir), adapters = {}, auditor = null, retester = null,
  now = () => new Date(), log = () => {} } = {}) {

  const block = (order, state, reason) => { order.blocked_reason = reason; transition(order, state, reason, now()); return saveOrder(store, order); };
  const manual = (order, reason) => { order.manual_review.push({ at: now().toISOString(), reason }); return block(order, "MANUAL_REVIEW_REQUIRED", reason); };
  const audit = (website) => fullSiteAudit(website, { auditor, now });

  // VORHER gegen NACHHER: neue relevante (≥ medium) Befunde, die es vorher nicht gab → Regression.
  const regression = (before, after) => {
    const had = new Set(Object.values(before?.issues || {}).map(issueKey));
    return Object.values(after?.issues || {}).filter((i) => RELEVANT.has(i.severity) && !had.has(issueKey(i))).map((i) => ({ type: i.type, page: i.page, severity: i.severity, evidence: i.evidence }));
  };
  const rollbackThen = async (order, adapter, failReason) => {
    const can = typeof adapter?.rollback === "function";
    const r = can ? await adapter.rollback(order).catch(() => ({ ok: false })) : { ok: false };
    order.regression = { ...(order.regression || {}), rolled_back: r.ok === true };
    if (r.ok === true) return block(order, "REPAIR_FAILED", `${failReason} – auf den letzten sicheren Stand zurückgerollt.`);
    return manual(order, `${failReason} – Rollback ${can ? "fehlgeschlagen" : "über diesen Kanal nicht verfügbar"}; Website-Zustand manuell prüfen.`);
  };

  // Genau einen Schritt ausführen. Rückgabe true = es ging weiter (erneut aufrufen), false = wartet/fertig/blockiert.
  async function step(order) {
    const t = now();
    const adapter = order.stack ? adapters[order.stack.type] : null;

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
      if (!authorizationOk(order)) return false; // wartet auf authorizeRepair()
      transition(order, "ACCESS_CHECK", "Freigabe liegt vor", t); saveOrder(store, order); return true;
    }

    if (order.state === "ACCESS_CHECK") {
      if (!authorizationOk(order)) { block(order, "BLOCKED_NO_AUTHORIZATION", "Freigabe fehlt oder Domain stimmt nicht überein."); return false; }
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
      if (order.stack.type === "other") { block(order, "BLOCKED_UNSUPPORTED_STACK", "Stack nicht erkannt – kein sicher unterstützter Reparaturweg."); return false; }
      const a = adapters[order.stack.type];
      if (!a || typeof a.checkAccess !== "function") { block(order, "BLOCKED_NO_ACCESS", `Kein sicherer Zugangsweg für Stack "${order.stack.type}" konfiguriert. Zugangsdaten werden nie erraten.`); return false; }
      const acc = await a.checkAccess(order).catch((e) => ({ ok: false, error: e.message }));
      if (acc?.ok !== true) { block(order, "BLOCKED_NO_ACCESS", "Zugangsprüfung fehlgeschlagen – keine Änderung ohne sicheren Zugang."); return false; }
      order.access = { connector: acc.connector || order.stack.type, ok: true, checked_at: t.toISOString() }; // nie mehr Felder übernehmen (keine Secrets)
      transition(order, "BACKUP", "Zugang geprüft", t); saveOrder(store, order); return true;
    }

    if (order.state === "BACKUP") {
      const branch = `repair/${order.order_id}`;
      const b = await adapter.backup(order, { branch }).catch((e) => ({ error: e.message }));
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
        const loc = await adapter.locate(i, order).catch(() => null);
        if (!loc || !loc.target || !loc.cause) { // Ursache unklar → nie raten
          order.issues[i.issue_id].repair_status = "needs_review";
          order.manual_review.push({ at: t.toISOString(), reason: `Ursache für ${i.type} (${i.page}) nicht eindeutig – keine automatische Reparatur.`, issue_id: i.issue_id });
          continue;
        }
        const item = { issue_id: i.issue_id, target: String(loc.target), cause: String(loc.cause), planned_change: String(loc.planned_change || "kleinste sinnvolle Korrektur"),
          risk: loc.risk || "niedrig", test_method: "Befund nach der Änderung erneut prüfen (gleiche Seite, gleicher Ablauf)", rollback_method: `Branch ${order.backup.branch} verwerfen bzw. Rollback auf ${order.backup.rollback_point}`,
          // Deterministische Fix-Details des Adapters (z. B. Datei + Ersetzung) – reine Daten, nie Secrets; überleben einen Neustart.
          fix: loc.fix ? JSON.parse(JSON.stringify(loc.fix)) : null };
        if (isProtectedChange(item)) {
          order.issues[i.issue_id].repair_status = "needs_review";
          order.manual_review.push({ at: t.toISOString(), reason: `Geplante Änderung für ${i.issue_id} berührt einen geschützten Bereich – nur mit zusätzlicher expliziter Freigabe.`, issue_id: i.issue_id });
          continue;
        }
        plan.push(item);
      }
      order.plan = plan;
      if (!plan.length && repairables.length) { manual(order, "Kein Befund mit eindeutiger Ursache automatisch reparierbar – manuelle Prüfung nötig."); return false; }
      transition(order, plan.length ? "REPAIRING" : "VALIDATION", plan.length ? `Plan: ${plan.length} Reparaturen` : "Keine automatisch behebbaren Befunde – nur Prüfung/Bericht", t);
      saveOrder(store, order); return true;
    }

    if (order.state === "REPAIRING") {
      let okCount = 0;
      for (const item of order.plan) {
        const r = await adapter.applyFix(item, order).catch((e) => ({ ok: false, error: e.message }));
        order.issues[item.issue_id].repair_status = r?.ok === true ? "repaired" : "repair_failed";
        if (r?.ok === true) { okCount++; if (r.change_ref) order.issues[item.issue_id].change_ref = String(r.change_ref); }
        saveOrder(store, order); // jeder Fix einzeln persistiert – Neustart verliert nichts
      }
      if (!okCount) { block(order, "REPAIR_FAILED", "Keine der geplanten Reparaturen konnte angewendet werden."); return false; }
      transition(order, "VALIDATION", `${okCount}/${order.plan.length} Reparaturen angewendet`, t); saveOrder(store, order); return true;
    }

    if (order.state === "VALIDATION") {
      // Ohne Build-/Prüfschritt des Adapters gilt die Validierung nur bei rein statischen Stacks als möglich – sonst fail closed.
      let v;
      if (typeof adapter.validate === "function") v = await adapter.validate(order).catch((e) => ({ build_ok: false, error: e.message }));
      else if (order.plan.length && !["static", "github_netlify"].includes(order.stack.type)) { manual(order, `Stack "${order.stack.type}" ohne Build-/Prüfschritt – Validierung nicht eindeutig, nicht experimentieren.`); return false; }
      else v = { build_ok: true };
      if (v?.build_ok !== true) { block(order, "VALIDATION_FAILED", "Build/Prüfung nach der Reparatur nicht erfolgreich."); return false; }
      const target = v.preview_url || order.website;
      const after = await audit(target);
      if (!after.ok) { block(order, "VALIDATION_FAILED", "Seite nach der Reparatur nicht ladbar."); return false; }
      // Jeder reparierte Befund muss weg sein (gleiche Seite/gleicher Typ) – sonst ist die Reparatur nicht bestanden.
      const remaining = new Set(Object.values(after.issues).map(issueKey));
      const unresolved = Object.values(order.issues).filter((i) => i.repair_status === "repaired" && remaining.has(issueKey(i)));
      if (unresolved.length) {
        for (const i of unresolved) order.issues[i.issue_id].repair_status = "still_broken";
        block(order, "VALIDATION_FAILED", `${unresolved.length} reparierte(r) Befund(e) weiterhin vorhanden.`); return false;
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
      if (!desktop.ok || !mobile.ok) { block(order, "VALIDATION_FAILED", `Retest nicht bestanden (Desktop ${desktop.ok ? "ok" : "fehlgeschlagen"}, Smartphone ${mobile.ok ? "ok" : "fehlgeschlagen"}).`); return false; }

      // Production nur: Freigabe + Tests bestanden + Rollback vorhanden + bereits autorisierter Deployment-Kanal.
      if (order.plan.length && typeof adapter.deployProduction === "function") {
        if (!authorizationOk(order) || !order.backup?.rollback_point) { manual(order, "Deployment-Voraussetzungen unvollständig (Freigabe/Rollback)."); return false; }
        const d = await adapter.deployProduction(order).catch((e) => ({ ok: false, error: e.message }));
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
    ...(openForReview.length ? ["Zur Besprechung (nicht automatisch verändert):", ...openForReview.map(line), ""] : []),
    "Abschlusskontrolle:",
    `Desktop: ${order.retest?.desktop?.ok ? "geprüft, in Ordnung" : "siehe Hinweis"} (${order.retest?.desktop?.method || "–"}).`,
    `Smartphone: ${order.retest?.mobile?.ok ? "geprüft, in Ordnung" : "siehe Hinweis"} (${order.retest?.mobile?.method || "–"}).`,
    "",
    order.deployment?.deployed ? "Die Korrekturen sind auf Ihrer Website live und wurden danach erneut geprüft."
      : order.plan?.length ? "Die Korrekturen sind vorbereitet und werden nach Rücksprache aufgeschaltet." : "An Ihrer Website wurde nichts verändert.",
    "",
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
    waiting_authorization: states.AUTHORIZATION_REQUIRED || 0, ready_for_delivery: states.READY_FOR_DELIVERY || 0 };
}

// Allowlist-Sicht für Dashboard/Cloud/Handy: Zähler + je Auftrag nur die hier aufgezählten, ungefährlichen Felder.
// NIE: Evidence, URLs einzelner Befunde, Branch-/Commit-/Deploy-Referenzen, Preview-URLs, Freigabe-Referenzen, Tokens, Historie.
export const PUBLIC_REPAIR_FIELDS = Object.freeze(["order_id", "company", "domain", "offer_class", "price_chf", "state", "findings",
  "repaired", "needs_review", "backup_ok", "desktop_retest", "mobile_retest", "production", "report_available", "created_at", "updated_at"]);
export function publicRepairOrders(dir = WORKER_DIR, { max = 50 } = {}) {
  const data = createStore(dir).read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const orders = Object.values(data.orders || {})
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, max)
    .map((o) => {
      const issues = Object.values(o.issues || {});
      return {
        order_id: o.order_id, company: o.company || null, domain: o.domain, offer_class: o.offer_class, price_chf: o.price_chf,
        state: o.state, findings: issues.length, repaired: issues.filter((i) => i.repair_status === "repaired").length,
        needs_review: (o.manual_review || []).length,
        backup_ok: !!(o.backup?.rollback_point), desktop_retest: o.retest ? o.retest.desktop?.ok === true : null,
        mobile_retest: o.retest ? o.retest.mobile?.ok === true : null,
        production: o.deployment?.deployed === true ? "DEPLOYED" : o.deployment ? "BRANCH_ONLY" : "UNCHANGED",
        report_available: !!o.report, created_at: o.created_at, updated_at: o.updated_at,
      };
    });
  const status = repairOrdersStatus(dir);
  return { ...status, orders };
}

// Standard-Abhängigkeiten für den Produktivbetrieb: GitHub+Netlify-Adapter (nur mit explizitem Mapping + Env-Tokens wirksam)
// und – falls Playwright installiert ist – der echte Browser-Rendertest. Fehler beim Laden → ohne (fail closed, nur Audit/Blocked).
export async function loadDefaultRepairDeps({ dir = WORKER_DIR } = {}) {
  let adapters = {};
  try { const m = await import("./repair-adapters/github-netlify.js"); adapters = { github_netlify: m.githubNetlifyAdapter({ dir }) }; } catch {}
  let retester = null;
  try { retester = await (await import("./repair-render-test.js")).loadRenderRetester(); } catch {}
  return { adapters, retester };
}

// ---------- Worker-Hook (eigenes Lock, nie zwei Läufe; ohne explizite Deps werden die Standard-Deps geladen) ----------
export async function runRepairOrders({ dir = WORKER_DIR, adapters = null, retester = null, log = createLogger(dir) } = {}) {
  const status = repairOrdersStatus(dir);
  if (!status.open) return { busy: false, processed: 0, advanced: 0, states: status.states };
  if (!acquireLock(dir, { name: "repair.lock" })) return { busy: true };
  try {
    if (!adapters) {
      const defaults = await loadDefaultRepairDeps({ dir });
      adapters = defaults.adapters;
      retester = retester || defaults.retester;
    }
    const engine = createRepairEngine({ dir, adapters, retester, log });
    return { busy: false, ...(await engine.processAll()) };
  } finally { releaseLock(dir, process.pid, "repair.lock"); }
}

// ---------- Kommandozeile ----------
// node repair-workflow.js --list | --status | --show <order_id> | --create <domain> [--website URL] [--lead ID] [--company NAME]
//                         | --authorize <order_id> --domain <domain> --source <quelle> [--reference TEXT]
//                         | --run | --complete <order_id> | --report <order_id>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  const run = async () => {
    if (argv.includes("--list") || argv.includes("--status")) { console.log(JSON.stringify(repairOrdersStatus(), null, 2)); return 0; }
    if (flag("show")) { const o = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders?.[flag("show")]; if (!o) throw new Error("Auftrag nicht gefunden."); console.log(JSON.stringify(o, null, 2)); return 0; }
    if (flag("create")) { const o = createRepairOrder(store, { domain: flag("create"), website: flag("website"), lead_id: flag("lead"), company: flag("company") }); console.log(`Auftrag angelegt: ${o.order_id} (${o.state}). Freigabe: node repair-workflow.js --authorize ${o.order_id} --domain ${o.domain} --source customer_reply_email --reference "<woher>"`); return 0; }
    if (flag("authorize")) { const o = authorizeRepair(store, flag("authorize"), { authorized_domain: flag("domain"), source: flag("source"), reference: flag("reference") }); console.log(`Freigabe gesetzt: ${o.order_id} → ${o.state}`); return 0; }
    if (argv.includes("--run")) { console.log(JSON.stringify(await runRepairOrders({}), null, 2)); return 0; }
    if (flag("complete")) { const o = completeOrder(store, flag("complete")); console.log(`Abgeschlossen: ${o.order_id} → ${o.state}`); return 0; }
    if (flag("report")) { const o = store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders?.[flag("report")]; if (!o?.report) throw new Error("Kein Bericht vorhanden."); console.log(`${o.report.subject}\n\n${o.report.body}`); return 0; }
    console.log("Befehle: --list | --show <id> | --create <domain> | --authorize <id> --domain <d> --source <q> | --run | --complete <id> | --report <id>");
    return 1;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
