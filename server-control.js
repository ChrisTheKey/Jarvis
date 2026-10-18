// Jarvis Server Control – Cloud-Seite (Netlify /api/server-control) und gemeinsame Regeln für den VPS-Agenten (server-agent.js).
//
//   Browser (x-jarvis-key = JARVIS_PASSWORD)  →  /api/server-control (Netlify Blobs "jarvis-server-control")
//   VPS-Agent (x-jarvis-control = JARVIS_SERVER_CONTROL_TOKEN, nur ausgehend) holt Aufträge ab und meldet Ergebnis + Status.
//
// Es gibt KEINE Shell, keine Befehle, keine Pfade und keine Docker-Argumente vom Client: nur feste Action-IDs aus ACTIONS,
// Parameter nur, wo sie hier als Enum/Zahl definiert sind. Alles andere → DENY (deny by default, fail closed).
// Eigenes Secret: JARVIS_SERVER_CONTROL_TOKEN (nie Worker-/Sync-Token, Anthropic-Key oder Gmail-Token wiederverwenden).
// Der Token liegt nur in Netlify (Server-Funktion) und in /opt/jarvis-mail/.env – nie im Browser, in Git, Logs oder PROJECT_STATE.
import { safeEqual } from "./shared-state.js";
import { LEAD_ID_RE, cleanLeads } from "./cloud-leads.js";
import { cleanLead as cleanDbLead, filterLeads, leadStats, leadsToCsv, FILTER_KEYS, CANTON_CODES } from "./lead-db.js";
import { ONBOARDING_STATES, BRIEF_STATUSES, CHANGE_KINDS, CHANGE_GROUPS, AWAITING, detectSensitive } from "./onboarding-core.js";
import { cleanPlatform } from "./hosting-detect.js";

export const TIERS = ["read", "control", "dangerous"];
export const LOG_SOURCES = ["core", "mail", "scheduler", "backup", "deploy"];
export const MAX_LOG_LINES = 100;

// Einzige Quelle aller ausführbaren Aktionen. snapshot = Antwort direkt aus dem letzten Status des VPS (kein Auftrag nötig).
// cooldownMs = Mindestabstand zwischen zwei Ausführungen (zusätzlich zum Rate Limit).
export const ACTIONS = {
  "system.health":           { tier: "read", snapshot: "system", label: "System-Gesundheit" },
  "system.uptime":           { tier: "read", snapshot: "system", label: "Host-Laufzeit" },
  "system.resources":        { tier: "read", snapshot: "system", label: "CPU / RAM / Disk" },
  "docker.status":           { tier: "read", snapshot: "docker", label: "Docker" },
  "jarvis.status":           { tier: "read", snapshot: "jarvis", label: "Jarvis Core" },
  "mail.status":             { tier: "read", snapshot: "mail", label: "Mail-Worker" },
  "scheduler.status":        { tier: "read", snapshot: "scheduler", label: "Scheduler" },
  "queue.status":            { tier: "read", snapshot: "queue", label: "Warteschlange" },
  "backup.status":           { tier: "read", snapshot: "backup", label: "Backup" },
  "deploy.status":           { tier: "read", snapshot: "deploy", label: "Deploy" },
  "service.logs":            { tier: "read", label: "Logs (gekürzt, bereinigt)", params: { source: LOG_SOURCES, lines: [1, MAX_LOG_LINES] } },
  "jarvis.runHealthCheck":   { tier: "control", label: "Health Check", cooldownMs: 30_000 },
  "jarvis.runSafeDiagnostics": { tier: "control", label: "Diagnose", cooldownMs: 60_000 },
  "jarvis.runBackup":        { tier: "control", label: "Backup jetzt", cooldownMs: 30 * 60_000 },
  "jarvis.restartScheduler": { tier: "control", label: "Scheduler neu starten", cooldownMs: 2 * 60_000 },
  "jarvis.restartMailWorker": { tier: "control", label: "Mail-Worker neu starten", cooldownMs: 5 * 60_000 },
  "jarvis.restartCore":      { tier: "control", label: "Jarvis Core neu starten", cooldownMs: 10 * 60_000 },
  // Cold-Lead-Entwürfe vom Handy: nur ENTWURF in Gmail (COLD_LEAD_DRAFT_ONLY, legal_basis NONE) bzw. Verwerfen – es gibt keine Send-Aktion.
  "leads.createDraft":       { tier: "control", label: "Gmail-Entwurf erstellen (Cold Lead, nie senden)", params: { lead_id: LEAD_ID_RE } },
  "leads.discardDraft":      { tier: "control", label: "Cold-Entwurf verwerfen", params: { lead_id: LEAD_ID_RE } },
  // 24/7-Discovery vom Handy pausieren/fortsetzen: nur ein Flag auf dem VPS, keine Scheduler-Befehle, nichts wird gelöscht.
  "discovery.pause":         { tier: "control", label: "24/7-Discovery pausieren", cooldownMs: 10_000 },
  "discovery.resume":        { tier: "control", label: "24/7-Discovery fortsetzen", cooldownMs: 10_000 },
};
// DANGEROUS: bekannt, aber aus der Cloud-UI immer gesperrt (Reboot, Pakete, Firewall, SSH, Löschen, Secret-Rotation).
export const DANGEROUS = ["system.reboot", "system.shutdown", "system.upgrade", "system.packages", "firewall.change", "ssh.change",
  "state.delete", "backup.delete", "secrets.rotate", "docker.prune", "docker.exec", "shell.exec"];

const ACTION_RE = /^[a-z]+\.[A-Za-z]+$/;
// Prüft eine Anfrage. Ergebnis: { ok, action, tier, params } oder { ok:false, status, code, error }. Kein Fallback, keine Umdeutung.
export function validateAction(input) {
  const deny = (status, code, error) => ({ ok: false, status, code, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return deny(400, "BAD_REQUEST", "Ungültige Anfrage.");
  const extra = Object.keys(input).filter((k) => !["action", "params"].includes(k));
  if (extra.length) return deny(400, "UNKNOWN_FIELD", "Nur action und params sind erlaubt.");
  const { action } = input;
  if (typeof action !== "string" || action.length > 64 || !ACTION_RE.test(action)) return deny(400, "UNKNOWN_ACTION", "Unbekannte Aktion.");
  if (DANGEROUS.includes(action)) return deny(403, "DANGEROUS_BLOCKED", "Gefährliche Aktion – aus der Cloud gesperrt.");
  if (!Object.hasOwn(ACTIONS, action)) return deny(400, "UNKNOWN_ACTION", "Unbekannte Aktion.");
  const def = ACTIONS[action];
  const raw = input.params ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return deny(400, "BAD_PARAMS", "params muss ein Objekt sein.");
  const spec = def.params || {};
  const params = {};
  for (const [k, v] of Object.entries(raw)) {
    const rule = spec[k];
    if (!rule) return deny(400, "BAD_PARAMS", `Parameter ${String(k).slice(0, 20)} ist nicht erlaubt.`);
    if (rule instanceof RegExp) { if (typeof v !== "string" || v.length > 253 || !rule.test(v)) return deny(400, "BAD_PARAMS", `${k}: ungültig.`); params[k] = v; }
    else if (typeof rule[0] === "string") { if (!rule.includes(v)) return deny(400, "BAD_PARAMS", `${k}: nur ${rule.join(", ")}.`); params[k] = v; }
    else { if (!Number.isInteger(v) || v < rule[0] || v > rule[1]) return deny(400, "BAD_PARAMS", `${k}: ganze Zahl ${rule[0]}–${rule[1]}.`); params[k] = v; }
  }
  if (action === "service.logs" && !params.source) return deny(400, "BAD_PARAMS", "source fehlt.");
  if (action.startsWith("leads.") && !params.lead_id) return deny(400, "BAD_PARAMS", "lead_id fehlt (genau ein Lead, keine Sammelaktion).");
  return { ok: true, action, tier: def.tier, params };
}

// ---------- Redaction: nichts, was wie ein Secret, eine Adresse oder ein fremder Pfad aussieht, verlässt den Server ----------
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private-key]"],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, "[api-key]"],
  [/\bya29\.[A-Za-z0-9._-]+/g, "[oauth-token]"],
  [/\b1\/\/[A-Za-z0-9._-]{10,}/g, "[oauth-token]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CLIENT_SECRET|AUTH)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]"],
  [/"(access_token|refresh_token|client_secret|token|password|api_key|private_key)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"'],
  [/[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/gi, "[email]"],
  [/(\/opt\/fiverr|\/root|\/home\/[^\s/]+\/\.ssh|\/etc\/(shadow|passwd|ssh))[^\s"']*/gi, "[blocked-path]"],
  [/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[redacted]"],
];
export function redact(s, max = 300) {
  let out = String(s ?? "");
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out.length > max ? out.slice(0, max) + "…" : out;
}
const SECRET_KEY_RE = /token|secret|password|passwd|credential|api_?key|private|authorization|cookie/i;
// Ergebnis eines Auftrags: nur einfache Werte, Strings bereinigt, keine verdächtigen Schlüssel, Grösse begrenzt.
export function cleanResult(v, depth = 0) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return redact(v, 400);
  if (depth > 5) return null;
  if (Array.isArray(v)) return v.slice(0, MAX_LOG_LINES).map((x) => cleanResult(x, depth + 1));
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 60)) if (!SECRET_KEY_RE.test(k) && /^[A-Za-z0-9_.-]{1,40}$/.test(k)) o[k] = cleanResult(x, depth + 1);
    return o;
  }
  return null;
}
const capResult = (v) => { const c = cleanResult(v); return JSON.stringify(c ?? null).length > 24_000 ? { truncated: true } : c; };

// Status des VPS (Snapshot) – Whitelist wie cleanCore: Zahlen, Zeitpunkte, feste Zustandswörter.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
const iso = (v) => (typeof v === "string" && ISO_RE.test(v) ? v : null);
const num = (v, max = 1e15) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * 100) / 100)) : null);
const word = (v, allowed) => (allowed.includes(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
export function cleanSnapshot(s) {
  if (!s || typeof s !== "object") return null;
  const sys = s.system || {}, d = s.docker || {}, j = s.jarvis || {}, m = s.mail || {}, sc = s.scheduler || {}, q = s.queue || {}, b = s.backup || {}, dp = s.deploy || {};
  const win = (w) => (w && typeof w === "object" ? { start: /^\d{2}:\d{2}$/.test(w.start) ? w.start : null, limit: num(w.limit, 1000), executed: w.executed === true } : null);
  return {
    at: iso(s.at),
    system: { status: word(sys.status, ["ONLINE", "DEGRADED"]), uptime_s: num(sys.uptime_s), cpus: num(sys.cpus, 1024), load1: num(sys.load1, 1e4), cpu_pct: num(sys.cpu_pct, 100),
      mem_total: num(sys.mem_total), mem_available: num(sys.mem_available), mem_pct: num(sys.mem_pct, 100),
      disk_total: num(sys.disk_total), disk_free: num(sys.disk_free), disk_pct: num(sys.disk_pct, 100) },
    docker: { status: word(d.status, ["ONLINE"]), container: word(d.container, ["HEALTHY", "UNHEALTHY"]), container_uptime_s: num(d.container_uptime_s), in_container: bool(d.in_container) },
    jarvis: { core: word(j.core, ["HEALTHY", "UNHEALTHY"]), role: word(j.role, ["vps", "local"]), started_at: iso(j.started_at), schema_version: num(j.schema_version, 10_000), node: typeof j.node === "string" && /^v\d+\.\d+\.\d+$/.test(j.node) ? j.node : null },
    mail: { worker: word(m.worker, ["VPS ACTIVE", "STANDBY", "UNKNOWN"]), authority: word(m.authority, ["VPS", "WINDOWS", "NONE", "UNKNOWN"]), self: bool(m.self), last_iteration_at: iso(m.last_iteration_at) },
    scheduler: { status: word(sc.status, ["ONLINE", "STALE"]), tz: "Europe/Zurich", morning: win(sc.morning), afternoon: win(sc.afternoon), discovery_last_run: iso(sc.discovery_last_run) },
    queue: { pending: num(q.pending, 1e6), processing: num(q.processing, 1e6) },
    backup: { status: word(b.status, ["OK", "FAILED", "NONE"]), last_at: iso(b.last_at), generations: num(b.generations, 1000), offsite_ok: bool(b.offsite_ok) },
    deploy: { commit: typeof dp.commit === "string" && /^[0-9a-f]{7,40}$/.test(dp.commit) ? dp.commit : null, deployed_at: iso(dp.deployed_at), container_started_at: iso(dp.container_started_at) },
    discovery: cleanDiscovery(s.discovery),
    repair: cleanRepair(s.repair),
    check150: cleanCheck150(s.check150),
    payments: cleanPayments(s.payments),
  };
}
// Check & Anleitung CHF 150 (TF-038): gleiche Whitelist-Disziplin wie cleanRepair – nur Zähler, feste Zustandswörter,
// ungefährliche Auftragsfelder. Nie Berichte, Draft-Inhalte, Adressen, Evidence, Pfade oder Tokens.
const CHECK150_STATE_WORDS = ["ORDER_RECEIVED", "ORDER_CONFIRMED", "FULL_AUDIT", "FINDINGS_ANALYSIS", "INSTRUCTIONS_GENERATION",
  "CUSTOMER_REPORT_READY", "DELIVERY_DRAFT_CREATED", "DELIVERY_SENDING", "READY_FOR_DELIVERY", "COMPLETED", "CANCELLED",
  "BLOCKED_ORDER_NOT_CONFIRMED", "BLOCKED_PAYMENT_NOT_RECEIVED", "AUDIT_FAILED", "REPORT_FAILED", "DELIVERY_DRAFT_FAILED", "MANUAL_REVIEW_REQUIRED"];
// Zahlungs-/Phasen-Wörter (TF-041) – bewusst hier dupliziert (kein Import von payments.js in die Netlify-Funktion).
const PAYMENT_STATE_WORDS = ["UNPAID", "PARTIAL", "DEPOSIT_MET", "PAID_FULL", "REFUNDED", "PAYMENT_REVIEW_REQUIRED"];
const CHECK150_PHASE_WORDS = ["WAITING_FOR_CONFIRMATION", "WAITING_FOR_DEPOSIT", "DEPOSIT_RECEIVED", "AUDITING", "REPORT", "READY_FOR_DELIVERY", "SENT", "COMPLETED", "CANCELLED", "BLOCKED"];
const REPAIR_PHASE_WORDS = ["WAITING_FOR_DEPOSIT", "WAITING_FOR_HOSTING_INFO", "WAITING_FOR_ACCESS", "ACCESS_REQUEST_SENT", "ACCESS_RECEIVED", "ACCESS_PROFILE_PREFLIGHT", "HOST_KEY_CONFIRMATION", "WAITING_FOR_ACCESS_PROFILE", "WAITING_FOR_CUSTOMER_BRIEF", "BACKUP", "REPAIRING", "VALIDATING", "LIVE_RETEST", "READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS", "MANUAL_REVIEW", "PAYMENT_REVIEW_REQUIRED", "CANCELLED", "BLOCKED"];
// Adapter-Wörter (TF-042) – nie Connector-Strings, Hosts oder Pfade.
const REPAIR_ADAPTER_WORDS = ["GITHUB_NETLIFY", "WORDPRESS", "SFTP", "SSH", "UNSUPPORTED"];
const REGISTRY_ADAPTERS = ["github_netlify", "wordpress", "sftp", "ssh"];
const ACCESS_TYPE_WORDS = ["github_netlify", "wordpress_cms", "sftp", "ssh", "hosting", "other"];
// Zugangsprofil-Status (TF-043) – nur das Wort, nie Host, Benutzer, IP, Webroot/Pfade oder Fingerprint.
const BROWSER_GATE_WORDS = ["JA", "NEIN", "WARTET"]; // TF-045
const BROWSER_REGRESSION_WORDS = ["KEINE", "GEFUNDEN", "ROLLBACK"];
const REPAIR_DELIVERY_WORDS = ["none", "draft_ready", "sent", "attachment_required", "unclear", "report_unsafe", "failed", "manual"]; // TF-046
// TF-066: Kunden-Onboarding je Auftrag – nur Statuswörter, Zeitpunkte, Zahlen und die BESTÄTIGTEN/strukturierten Website-Angaben
// (Telefon/Adresse/Texte, die auf die Website sollen). Nie Zugangsdaten, Links, Token, Rohmails, Mailadressen des Kunden.
const ONB_ACCESS_WORDS = ["not_required", "hosting_missing", "missing", "link_sent", "link_expired", "received", "checked"];
const ONB_CONTENT_WORDS = ["none", "open", "confirmed", "unknown"];
const onbText = (v, max = 300) => (typeof v === "string" && !detectSensitive(v) ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : null);
export function cleanOnboarding(x) {
  if (!x || typeof x !== "object") return null;
  const item = (i) => (i && typeof i === "object" ? { id: onbText(i.id, 40), kind: word(i.kind, CHANGE_KINDS), page: onbText(i.page, 80), section: onbText(i.section, 80),
    old_text: onbText(i.old_text), new_text: onbText(i.new_text),
    address: i.address && typeof i.address === "object" ? { street: onbText(i.address.street, 120), postal_code: onbText(i.address.postal_code, 20), city: onbText(i.address.city, 80), country: onbText(i.address.country, 60) } : null,
    customer_confirmed: bool(i.customer_confirmed), complete: bool(i.complete) } : null);
  const changes = {};
  for (const g of Object.values(CHANGE_GROUPS)) changes[g] = (Array.isArray(x.changes?.[g]) ? x.changes[g] : []).slice(0, 20).map(item).filter((i) => i && i.kind);
  return { kind: word(x.kind, ["CHECK", "FIX"]), market: word(x.market, ["CH", "VN"]), locale: word(x.locale, ["de-CH", "vi-VN"]), state: word(x.state, ONBOARDING_STATES),
    awaiting: word(x.awaiting, AWAITING), payment_gate: word(x.payment_gate, ["met", "open"]), access: word(x.access, ONB_ACCESS_WORDS), content: word(x.content, ONB_CONTENT_WORDS),
    brief_status: word(x.brief_status, BRIEF_STATUSES), open_items: num(x.open_items, 100), reminders: num(x.reminders, 10),
    last_customer_reply_at: iso(x.last_customer_reply_at), last_jarvis_reply_at: iso(x.last_jarvis_reply_at), manual_reason: onbText(x.manual_reason, 160), changes,
    platform: cleanPlatform(x.platform) }; // TF-071: nur feste Wörter (Hosting/CMS/Zugangsweg/Konfidenz/Zugangsstatus)
}
const PROFILE_STATUS_WORDS = ["PROFILE_READY", "HOST_KEY_CONFIRMATION_REQUIRED", "WAITING_FOR_ACCESS_PROFILE", "MANUAL_REVIEW_REQUIRED", "BLOCKED_UNSAFE_ACCESS", "BLOCKED_NO_ACCESS", "PREFLIGHT_RETRY"];
// TF-064: Markt/Währung/Beträge in Auftragswährung (VND bis 1e9, ganze Zahlen) – zusätzlich zu den Legacy-*_chf-Feldern.
const MARKET_WORDS = ["CH", "VN"], CURRENCY_WORDS = ["CHF", "VND"];
const moneyFields = (o, n) => ({ market: word(o.market, MARKET_WORDS), currency: word(o.currency, CURRENCY_WORDS),
  price_amount: o.price_amount == null ? null : n(o.price_amount, 1e9), paid_amount: o.paid_amount == null ? null : n(o.paid_amount, 1e9),
  payment_required_amount: o.payment_required_amount == null ? null : n(o.payment_required_amount, 1e9),
  rest_to_deposit_amount: o.rest_to_deposit_amount == null ? null : n(o.rest_to_deposit_amount, 1e9),
  // TF-072: bei Auftragserstellung gespeicherter Provisionssatz (Basispunkte, 1–10000) – sonst null.
  commission_rate_bps: Number.isInteger(o.commission_rate_bps) && o.commission_rate_bps > 0 && o.commission_rate_bps <= 10_000 ? o.commission_rate_bps : null });
const payFields = (o, n) => ({ paid_chf: o.paid_chf == null ? null : n(o.paid_chf, 10_000), payment_required_chf: o.payment_required_chf == null ? null : n(o.payment_required_chf, 10_000),
  rest_to_deposit_chf: o.rest_to_deposit_chf == null ? null : n(o.rest_to_deposit_chf, 10_000), payment_status: word(o.payment_status, PAYMENT_STATE_WORDS), payment_ok: bool(o.payment_ok) });
export function cleanCheck150(r) {
  if (!r || typeof r !== "object") return null;
  const n = (v, max = 1e6) => num(v, max);
  const states = {};
  for (const [k, v] of Object.entries(r.states || {})) if (CHECK150_STATE_WORDS.includes(k)) states[k] = n(v, 10_000);
  const orders = (Array.isArray(r.orders) ? r.orders : []).slice(0, 50).map((o) => (o && typeof o === "object" ? {
    order_id: typeof o.order_id === "string" && /^(CA150|VNCHECK)-\d{8}-[0-9a-f]{6}$/.test(o.order_id) ? o.order_id : null,
    company: typeof o.company === "string" && NAME_RE.test(o.company) ? o.company : null,
    domain: typeof o.domain === "string" && DOMAIN_RE.test(o.domain) ? o.domain : null,
    offer_class: word(o.offer_class, ["REPAIR_CHECK_150", "VN_REPAIR_CHECK"]), price_chf: o.price_chf == null ? null : n(o.price_chf, 10_000), ...moneyFields(o, n),
    state: word(o.state, CHECK150_STATE_WORDS), findings: o.findings == null ? null : n(o.findings, 10_000),
    critical: o.critical == null ? null : n(o.critical, 10_000), high: o.high == null ? null : n(o.high, 10_000),
    medium: o.medium == null ? null : n(o.medium, 10_000), low: o.low == null ? null : n(o.low, 10_000),
    report_available: bool(o.report_available), draft_available: bool(o.draft_available),
    delivery_status: word(o.delivery_status, ["none", "draft_ready", "sent", "delivered"]),
    // Zahlungsstand (TF-041): nur Zahlen/Flag/Zustandswort – nie Referenzen oder Zahlungsdetails.
    ...payFields(o, n), phase: word(o.phase, CHECK150_PHASE_WORDS),
    source: word(o.source, ["direct_customer", "jarvis_lead"]),
    onboarding: cleanOnboarding(o.onboarding), // TF-066
    created_at: iso(o.created_at), updated_at: iso(o.updated_at),
  } : null)).filter(Boolean);
  return { total: n(r.total, 100_000), open: n(r.open, 100_000), ready_for_delivery: n(r.ready_for_delivery, 100_000),
    waiting_confirmation: n(r.waiting_confirmation, 100_000), waiting_payment: n(r.waiting_payment, 100_000),
    cancelled: n(r.cancelled, 100_000), states, orders };
}
// Reparaturaufträge (TF-036): nur Zähler, feste Zustandswörter und ungefährliche Auftragsfelder – nie Evidence, Branches,
// Commits, Preview-URLs, Freigabe-Referenzen oder Tokens. Die Cloud erzwingt die Whitelist erneut (wie bei den Leads).
const REPAIR_STATES = ["ORDER_RECEIVED", "AUTHORIZATION_REQUIRED", "PAYMENT_REQUIRED", "ACCESS_CHECK", "ACCESS_REQUESTED", "WAITING_FOR_HOSTING_INFO", "ACCESS_PROFILE_PREFLIGHT",
  "HOST_KEY_CONFIRMATION_REQUIRED", "WAITING_FOR_ACCESS_PROFILE", "WAITING_FOR_CUSTOMER_BRIEF", "BACKUP",
  "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS", "BLOCKED_NO_ACCESS",
  "BLOCKED_NO_AUTHORIZATION", "BLOCKED_UNSUPPORTED_STACK", "REPAIR_FAILED", "VALIDATION_FAILED", "MANUAL_REVIEW_REQUIRED", "PAYMENT_REVIEW_REQUIRED", "CANCELLED", "BLOCKED_UNSAFE_ACCESS",
  "BLOCKED_HOST_KEY_CHANGED"];
const NAME_RE = /^[\p{L}\p{N} .,&'’()\/+-]{1,80}$/u;
const DOMAIN_RE = /^[a-z0-9.-]{3,253}$/;
export function cleanRepair(r) {
  if (!r || typeof r !== "object") return null;
  const n = (v, max = 1e6) => num(v, max);
  const states = {};
  for (const [k, v] of Object.entries(r.states || {})) if (REPAIR_STATES.includes(k)) states[k] = n(v, 10_000);
  const orders = (Array.isArray(r.orders) ? r.orders : []).slice(0, 50).map((o) => (o && typeof o === "object" ? {
    order_id: typeof o.order_id === "string" && /^(RF480|VNFIX)-\d{8}-[0-9a-f]{6}$/.test(o.order_id) ? o.order_id : null,
    company: typeof o.company === "string" && NAME_RE.test(o.company) ? o.company : null,
    domain: typeof o.domain === "string" && DOMAIN_RE.test(o.domain) ? o.domain : null,
    offer_class: word(o.offer_class, ["REPAIR_FIX_500", "VN_REPAIR_FIX"]), price_chf: o.price_chf == null ? null : n(o.price_chf, 10_000), ...moneyFields(o, n),
    state: word(o.state, REPAIR_STATES), findings: n(o.findings, 10_000), repaired: n(o.repaired, 10_000), needs_review: n(o.needs_review, 10_000),
    backup_ok: bool(o.backup_ok), desktop_retest: bool(o.desktop_retest), mobile_retest: bool(o.mobile_retest),
    production: word(o.production, ["DEPLOYED", "BRANCH_ONLY", "UNCHANGED"]), report_available: bool(o.report_available),
    // Zahlungsstand + Zugang (TF-041): nur Zahlen/Flags/Zustandswörter – nie Referenzen, Links, Tokens oder Zugangsdaten.
    ...payFields(o, n), phase: word(o.phase, REPAIR_PHASE_WORDS),
    access_requested: bool(o.access_requested), access_received: bool(o.access_received), access_type: word(o.access_type, ACCESS_TYPE_WORDS),
    adapter: word(o.adapter, REPAIR_ADAPTER_WORDS), access_ok: bool(o.access_ok), rollback_ok: bool(o.rollback_ok),
    auto_fixable: o.auto_fixable == null ? null : n(o.auto_fixable, 10_000), manual_review: o.manual_review == null ? null : n(o.manual_review, 10_000),
    profile_status: word(o.profile_status, PROFILE_STATUS_WORDS),
    host_key_verified: bool(o.host_key_verified), // TF-044: nur JA/NEIN
    // TF-045: Browser-Gate nur als feste Wörter – nie URLs, Screenshots, Logs, Codes oder Requests.
    browser_desktop: word(o.browser_desktop, BROWSER_GATE_WORDS), browser_mobile: word(o.browser_mobile, BROWSER_GATE_WORDS),
    browser_regression: word(o.browser_regression, BROWSER_REGRESSION_WORDS),
    // TF-046: Freigabe nur JA/NEIN, Lieferung nur als festes Wort – nie Draft-ID, Adresse oder Inhalt.
    authorized: bool(o.authorized), delivery_status: word(o.delivery_status, REPAIR_DELIVERY_WORDS),
    // TF-055: offene manuelle Punkte nach dem Retest – nur eine Zahl.
    manual_items_open: o.manual_items_open == null ? null : n(o.manual_items_open, 10_000),
    onboarding: cleanOnboarding(o.onboarding), // TF-066
    created_at: iso(o.created_at), updated_at: iso(o.updated_at),
    // TF-080: Test-Kennzeichen MUSS die Whitelist passieren – Provision/Umsatz/Verkäufer-Sichten in der Cloud lassen Test-Aufträge sonst nicht weg.
    test_order: o.test_order === true || o.environment === "TEST", environment: o.test_order === true || o.environment === "TEST" ? "TEST" : "LIVE",
  } : null)).filter(Boolean);
  return { total: n(r.total, 100_000), open: n(r.open, 100_000), test_orders: n(r.test_orders, 100_000), completed_with_manual_items: n(r.completed_with_manual_items, 100_000), waiting_authorization: n(r.waiting_authorization, 100_000),
    waiting_payment: n(r.waiting_payment, 100_000), access_requested: n(r.access_requested, 100_000),
    payment_review: n(r.payment_review, 100_000), cancelled: n(r.cancelled, 100_000),
    ready_for_delivery: n(r.ready_for_delivery, 100_000), manual_review: n(r.manual_review, 100_000), unsafe_access: n(r.unsafe_access, 100_000),
    host_key_confirmation: n(r.host_key_confirmation, 100_000), waiting_access_profile: n(r.waiting_access_profile, 100_000),
    adapter_registry: r.adapter_registry && typeof r.adapter_registry === "object" ? { status: word(r.adapter_registry.status, ["ACTIVE"]),
      adapters: (Array.isArray(r.adapter_registry.adapters) ? r.adapter_registry.adapters : []).filter((a) => REGISTRY_ADAPTERS.includes(a)),
      ssh_library: bool(r.adapter_registry.ssh_library), host_key_verifier: word(r.adapter_registry.host_key_verifier, ["ACTIVE", "UNAVAILABLE"]),
      browser_validator: word(r.adapter_registry.browser_validator, ["ACTIVE", "UNAVAILABLE"]) } : null,
    states, orders };
}
// Payment Worker (TF-041): nur Zähler und CHF-Summen aus dem Ledger – nie payment_ids, Referenzen, Quellen oder Domains.
export function cleanPayments(p) {
  if (!p || typeof p !== "object") return null;
  const n = (v) => num(v, 1e7);
  return { status: word(p.status, ["ACTIVE"]), total: n(p.total), received: n(p.received), voided: n(p.voided), refunded: n(p.refunded),
    received_chf: n(p.received_chf), refunded_chf: n(p.refunded_chf), received_vnd: num(p.received_vnd, 1e12), refunded_vnd: num(p.refunded_vnd, 1e12), waiting_deposit: n(p.waiting_deposit), payment_review: n(p.payment_review), test_payments: n(p.test_payments) };
}
// 24/7-Discovery (VPS): nur Zähler, Zeitpunkte, feste Wörter; Fehlertext bereinigt und gekürzt.
export function cleanDiscovery(d) {
  if (!d || typeof d !== "object") return null;
  const n = (v, max = 1e6) => num(v, max);
  const lim = d.limits || {};
  return {
    status: word(d.status, ["ACTIVE", "PAUSED", "BACKOFF", "DISABLED"]), paused: bool(d.paused), paused_at: iso(d.paused_at),
    audited_today: n(d.audited_today), new_leads_today: n(d.new_leads_today), qualified_today: n(d.qualified_today), drafts_today: n(d.drafts_today), drafts_hour: n(d.drafts_hour),
    blocked_today: n(d.blocked_today), errors_today: n(d.errors_today), audited_hour: n(d.audited_hour), queue: n(d.queue),
    // 7500/Tag-Discovery + unbegrenzte Draft-Queue: Websites gegen Tagesdeckel, qualifizierte Leads, wartend, heute erstellt, offen gesamt.
    websites_limit: n(d.websites_limit, 100_000), websites_hour_limit: n(d.websites_hour_limit, 10_000), last_run_audited: d.last_run_audited == null ? null : n(d.last_run_audited, 100_000),
    last_run_duration_s: d.last_run_duration_s == null ? null : n(d.last_run_duration_s, 86_400), discovery_rate_per_hour: n(d.discovery_rate_per_hour, 10_000), max_concurrency: n(d.max_concurrency, 64), pool_exhausted: bool(d.pool_exhausted), qualified_total: n(d.qualified_total), waiting_for_draft: n(d.waiting_for_draft), gmail_drafts_today: n(d.gmail_drafts_today), open_drafts_total: n(d.open_drafts_total),
    draft_worker: d.draft_worker && typeof d.draft_worker === "object" ? { status: word(d.draft_worker.status, ["ACTIVE", "BACKOFF"]), backoff_until: iso(d.draft_worker.backoff_until), backoff_count: n(d.draft_worker.backoff_count, 1000),
      last_draft_at: iso(d.draft_worker.last_draft_at), last_error: d.draft_worker.last_error && typeof d.draft_worker.last_error === "object" ? { at: iso(d.draft_worker.last_error.at), message: redact(String(d.draft_worker.last_error.message || ""), 160) } : null } : null,
    last_run_at: iso(d.last_run_at), next_run_at: iso(d.next_run_at), backoff_until: iso(d.backoff_until), backoff_count: n(d.backoff_count, 1000),
    last_error: d.last_error && typeof d.last_error === "object" ? { at: iso(d.last_error.at), stage: word(d.last_error.stage, ["search", "audit", "draft"]), message: redact(String(d.last_error.message || ""), 160) } : null,
    // max_drafts_per_*: null = kein Business-Cap (nur technisches Pacing).
    coverage: cleanCoverage(d.coverage), lead_db: cleanLeadDbStatus(d.lead_db),
    limits: { interval_minutes: n(lim.interval_minutes, 1440), sites_per_run: n(lim.sites_per_run, 1000), max_sites_per_hour: n(lim.max_sites_per_hour, 10_000), max_sites_per_day: n(lim.max_sites_per_day, 100_000),
      max_drafts_per_hour: null, max_drafts_per_day: null, draft_pace_ms: n(lim.draft_pace_ms, 600_000), drafts_per_pass: n(lim.drafts_per_pass, 10_000), max_concurrency: n(lim.max_concurrency, 64) },
  };
}

// Schweiz-Abdeckung der Discovery: Zahlen, Kantonskürzel, ein Gemeindename (Zeichen eines Ortsnamens).
const PLACE_RE = /^[\p{L}\p{N} .'’()\/-]{1,60}$/u;
export function cleanCoverage(c) {
  if (!c || typeof c !== "object") return null;
  const n = (v, max = 1e6) => num(v, max);
  return { mode: word(c.mode, ["FULL", "AREAS"]), dataset: typeof c.dataset === "string" && /^bfs-\d{4}-\d{2}-\d{2}$/.test(c.dataset) ? c.dataset : null,
    cantons_total: n(c.cantons_total, 26), municipalities_total: n(c.municipalities_total, 5000), areas: n(c.areas, 10_000), cycle: n(c.cycle, 1e6), cycle_visited: n(c.cycle_visited, 5000),
    cycle_progress_pct: n(c.cycle_progress_pct, 100), cantons_covered_cycle: n(c.cantons_covered_cycle, 26), cycles_completed: n(c.cycles_completed, 1e6),
    last_cycle_completed_at: iso(c.last_cycle_completed_at), current_canton: word(c.current_canton, CANTON_CODES),
    current_municipality: typeof c.current_municipality === "string" && PLACE_RE.test(c.current_municipality) ? c.current_municipality : null, queue: n(c.queue, 10_000) };
}
// Lead-Datenbank im Status: nur Zähler.
export function cleanLeadDbStatus(s) {
  if (!s || typeof s !== "object") return null;
  const n = (v) => num(v, 1e7);
  return { status: word(s.status, ["ACTIVE"]), total: n(s.total), new_today: n(s.new_today), qualified: n(s.qualified), drafts: n(s.drafts), waiting_for_draft: n(s.waiting_for_draft),
    contacted: n(s.contacted), replies: n(s.replies), customers: n(s.customers), suppressed: n(s.suppressed), opt_out: n(s.opt_out), do_not_contact: n(s.do_not_contact),
    cantons_with_leads: n(s.cantons_with_leads), reconciled_at: iso(s.reconciled_at), migrated_at: iso(s.migrated_at) };
}

// ---------- Lead-Datenbank in der Cloud (eigener Blob „leaddb“): Suche, Filter, Seiten, CSV-/JSON-Export ----------
export const LEADDB_MAX_LEADS = 25_000;
export const LEADDB_PAGE_MAX = 200;
// Filter aus der URL: nur bekannte Schlüssel, kurze Werte.
export function leadDbFilters(params) {
  const f = {};
  for (const k of FILTER_KEYS) { const v = params.get(k); if (typeof v === "string" && v.trim() && v.length <= 80) f[k] = v.trim(); }
  return f;
}
export function leadDbView(db, params, now = new Date()) {
  const all = Array.isArray(db?.leads) ? db.leads : [];
  const f = leadDbFilters(params);
  const hit = filterLeads(all, f);
  const size = Math.max(0, Math.min(LEADDB_PAGE_MAX, Number.parseInt(params.get("page_size") ?? "50", 10) || 0));
  const page = Math.max(0, Number.parseInt(params.get("page") || "0", 10) || 0);
  const count = (key) => { const m = {}; for (const l of all) if (l[key]) m[l[key]] = (m[l[key]] || 0) + 1; return m; };
  const months = {}; for (const l of all) { const m = String(l.first_discovered_at || "").slice(0, 7); if (m) months[m] = (months[m] || 0) + 1; }
  return {
    configured: true, generated_at: db?.generated_at || null, received_at: db?.received_at || null, truncated: db?.truncated === true, total_on_vps: db?.total ?? all.length,
    stats: leadStats(all, now), filters: f, count: hit.length, page, page_size: size, leads: size ? hit.slice(page * size, page * size + size) : [],
    facets: { cantons: count("canton"), statuses: count("status"), categories: count("category"), months },
  };
}

// ---------- Netlify-Seite: Auftrags-Warteschlange, Status, Audit ----------
export const REQUEST_TTL_MS = 3 * 60_000;    // nicht abgeholt → expired (kein später Überraschungs-Restart)
export const LEASE_MS = 2 * 60_000;           // abgeholt, aber kein Ergebnis → failed
export const WATCH_MS = 90_000;               // UI-Panel offen → Agent fragt häufiger nach
export const SNAPSHOT_STALE_MS = 3 * 60_000;  // älterer Status → SERVER OFFLINE
export const RATE = { windowMs: 10 * 60_000, total: 40, control: 6 };
const AUDIT_KEEP = 300, REQUEST_KEEP = 50;
const ID_RE = /^[0-9a-f-]{36}$/;

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const auditEntry = (now, x) => ({ ts: now.toISOString(), request_id: x.request_id || null, action: typeof x.action === "string" && ACTION_RE.test(x.action) ? x.action : "invalid",
  tier: x.tier || null, source: x.source || "cloud-ui", outcome: x.outcome, reason: x.reason ? redact(x.reason, 160) : null });
export const publicRequest = (r) => ({ request_id: r.request_id, action: r.action, tier: r.tier, params: r.params, status: r.status, created_at: r.created_at,
  finished_at: r.finished_at || null, result: r.result ?? null, error: r.error || null });

function expire(requests, now) {
  const t = +now, out = [];
  for (const r of requests) {
    if (r.status === "pending" && t > Date.parse(r.expires_at)) out.push({ ...r, status: "expired", finished_at: now.toISOString(), error: "VPS hat den Auftrag nicht abgeholt." });
    else if (r.status === "running" && t > Date.parse(r.lease_until)) out.push({ ...r, status: "failed", finished_at: now.toISOString(), error: "Kein Ergebnis vom VPS (Lease abgelaufen)." });
    else out.push(r);
  }
  return out;
}

// TF-063: resolveActor (auth-core.js) – Server Control ist OWNER ONLY. Verkäufer: GET und POST → 403 (Backend, nicht nur Button).
export function createServerControlHandler({ getStore, getLeadDbStore = null, env, now = () => new Date(), newId = () => crypto.randomUUID(), resolveActor = null }) {
  async function mutate(fn) {
    const store = await getStore();
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const t = now();
      const cur = { requests: [], audit: [], rate: [], snapshot: null, snapshot_at: null, watch_at: null, leads: null, leads_at: null, ...(state || {}) };
      const before = cur.requests.filter((r) => ["pending", "running"].includes(r.status)).map((r) => r.request_id);
      cur.requests = expire(cur.requests, t);
      // Abgelaufene Aufträge ebenfalls ins Audit.
      let expired = 0;
      for (const r of cur.requests) if (before.includes(r.request_id) && ["expired", "failed"].includes(r.status)) { expired++; cur.audit.push(auditEntry(t, { ...r, source: "cloud-core", outcome: r.status, reason: r.error })); }
      const res = fn(cur, t);
      cur.requests = cur.requests.slice(-REQUEST_KEEP);
      cur.audit = cur.audit.slice(-AUDIT_KEEP);
      cur.rate = cur.rate.filter((x) => +t - Date.parse(x.at) < RATE.windowMs);
      if (res.readOnly && !expired) return res;
      if (await store.set(cur, etag)) return res;
    }
    return { status: 409, body: { error: "Gleichzeitige Änderung – bitte erneut versuchen." } };
  }
  const view = (cur, t, { leads = false } = {}) => ({
    configured: true,
    snapshot: cur.snapshot, snapshot_at: cur.snapshot_at, online: !!cur.snapshot_at && +t - Date.parse(cur.snapshot_at) < SNAPSHOT_STALE_MS,
    requests: cur.requests.slice(-15).map(publicRequest),
    audit: cur.audit.slice(-30),
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([id, a]) => [id, { tier: a.tier, label: a.label }])),
    // Lead-Liste (nur auf Anfrage ?leads=1): bereits beim Empfang auf die Allowlist gebracht (cleanLeads), hier nur ausgeliefert.
    ...(leads ? { leads: cur.leads || [], leads_at: cur.leads_at || null } : {}),
  });

  return async (req) => {
    // Einfügefehler (Leerzeichen/Zeilenumbruch am Rand) in der Netlify-Variable tolerieren – der Vergleich selbst bleibt exakt.
    const controlToken = String(env("JARVIS_SERVER_CONTROL_TOKEN") || "").trim(), password = env("JARVIS_PASSWORD");
    // Diagnose ohne Auth: nur ob konfiguriert und wie lang – nie der Wert, kein Fingerabdruck.
    if (req.method === "GET" && new URL(req.url).searchParams.has("probe")) return reply(200, { configured: controlToken.length >= 32, length: controlToken.length });
    // Getrennte Credentials: Worker-/Sync-Token gelten hier nicht. Fehlt der eigene Token in Netlify → alles gesperrt.
    const isAgent = !!controlToken && controlToken.length >= 32 && safeEqual(req.headers.get("x-jarvis-control"), controlToken);
    let isUser = false;
    if (!isAgent) {
      if (resolveActor) {
        const a = await resolveActor(req);
        if (!a.actor) return reply(a.status || 401, { error: a.error || "Nicht berechtigt.", ...(a.code ? { code: a.code } : {}) });
        if (a.actor.role !== "OWNER") return reply(403, { error: "Server Control ist nur für den Owner.", code: "FORBIDDEN" });
        isUser = true;
      } else isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    }
    if (!isAgent && !isUser) return reply(401, { error: "Nicht berechtigt." });
    if (!controlToken || controlToken.length < 32) return reply(503, { configured: false, error: "Server Control nicht konfiguriert (JARVIS_SERVER_CONTROL_TOKEN fehlt in Netlify)." });
    if (!["GET", "POST"].includes(req.method)) return reply(405, { error: "Nur GET oder POST." });
    // Der VPS-Agent darf die Lead-Datenbank schicken (eigene Operation, bis ~6 MB); Browser-Anfragen bleiben klein.
    if (Number(req.headers.get("content-length") || 0) > (isAgent && !isUser ? 6_000_000 : 64_000)) return reply(413, { error: "Zu gross." });
    let body = {};
    if (req.method === "POST") { try { body = JSON.parse((await req.text()) || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); } }

    // ----- VPS-Agent -----
    if (isAgent && !isUser) {
      if (req.method !== "POST") return reply(405, { error: "Agent: nur POST." });
      if (body.op === "pull") {
        const r = await mutate((cur, t) => {
          if (body.snapshot) { cur.snapshot = cleanSnapshot(body.snapshot); cur.snapshot_at = t.toISOString(); }
          // Lead-Liste vom VPS (nur bei Änderung mitgeschickt): Allowlist erzwingen, nie Rohdaten speichern.
          if (Array.isArray(body.leads)) { cur.leads = cleanLeads(body.leads); cur.leads_at = t.toISOString(); }
          const due = cur.requests.filter((x) => x.status === "pending");
          for (const x of due) { x.status = "running"; x.claimed_at = t.toISOString(); x.lease_until = new Date(+t + LEASE_MS).toISOString(); }
          const hot = due.length > 0 || (!!cur.watch_at && +t - Date.parse(cur.watch_at) < WATCH_MS) || cur.requests.some((x) => x.status === "running");
          return { status: 200, body: { requests: due.map((x) => ({ request_id: x.request_id, action: x.action, params: x.params, created_at: x.created_at })), hot } };
        });
        return reply(r.status, r.body);
      }
      if (body.op === "leaddb") {
        // Lead-Datenbank vom VPS: Allowlist erzwingen (cleanLead), nie Rohdaten oder Gmail-IDs speichern. Eigener Blob, eigener Schlüssel.
        if (!getLeadDbStore) return reply(503, { error: "Lead-Datenbank-Speicher nicht konfiguriert." });
        if (!Array.isArray(body.leads) || body.leads.length > LEADDB_MAX_LEADS) return reply(400, { error: "leads ungültig." });
        const leads = body.leads.map(cleanDbLead).filter(Boolean);
        const t = now();
        const doc = { leads, total: Number.isFinite(body.total) ? Math.min(body.total, 1e7) : leads.length, truncated: body.truncated === true,
          generated_at: iso(body.generated_at) || t.toISOString(), received_at: t.toISOString() };
        const st = await getLeadDbStore();
        for (let i = 0; i < 4; i++) { const { etag } = await st.get(); if (await st.set(doc, etag)) return reply(200, { ok: true, stored: leads.length }); }
        return reply(409, { error: "Gleichzeitige Änderung – bitte erneut versuchen." });
      }
      if (body.op === "result") {
        if (typeof body.request_id !== "string" || !ID_RE.test(body.request_id)) return reply(400, { error: "request_id ungültig." });
        const r = await mutate((cur, t) => {
          const x = cur.requests.find((q) => q.request_id === body.request_id);
          if (!x) return { status: 404, body: { error: "Unbekannter Auftrag." } };
          if (x.status !== "running") return { status: 409, body: { error: `Auftrag ist ${x.status}.` } };
          x.status = body.ok === true ? "done" : "failed";
          x.finished_at = t.toISOString();
          x.result = capResult(body.result ?? null);
          x.error = body.ok === true ? null : redact(body.error || "Fehlgeschlagen", 200);
          cur.audit.push(auditEntry(t, { ...x, source: "cloud-core", outcome: body.ok === true ? "success" : "failure", reason: x.error }));
          return { status: 200, body: { ok: true } };
        });
        return reply(r.status, r.body);
      }
      return reply(400, { error: "Unbekannte Operation." });
    }

    // ----- Chris im Browser -----
    const ldb = req.method === "GET" ? new URL(req.url).searchParams.get("leaddb") : null;
    if (ldb) {
      // Lead-Datenbank lesen: ?leaddb=1 (Seite + Kennzahlen + Facetten) · ?leaddb=csv · ?leaddb=json (Export, gefiltert, auditiert).
      if (!getLeadDbStore) return reply(503, { configured: false, error: "Lead-Datenbank-Speicher nicht konfiguriert." });
      const params = new URL(req.url).searchParams;
      const { state: db } = await (await getLeadDbStore()).get();
      if (!db) return reply(200, { configured: true, empty: true, stats: leadStats([], now()), count: 0, leads: [], facets: {} });
      if (ldb === "csv" || ldb === "json") {
        const list = filterLeads(db.leads || [], leadDbFilters(params));
        await mutate((cur, t) => { cur.audit.push(auditEntry(t, { action: "leaddb.export", tier: "read", outcome: "success", reason: `${ldb.toUpperCase()} ${list.length}` })); return { status: 200, body: {} }; });
        const day = now().toISOString().slice(0, 10);
        if (ldb === "csv") return new Response(leadsToCsv(list), { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="jarvis-leads-${day}.csv"`, "cache-control": "no-store" } });
        return new Response(JSON.stringify({ exported_at: now().toISOString(), generated_at: db.generated_at || null, filters: leadDbFilters(params), count: list.length, leads: list }, null, 2),
          { status: 200, headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="jarvis-leads-${day}.json"`, "cache-control": "no-store" } });
      }
      return reply(200, leadDbView(db, params, now()));
    }
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams, watch = q.get("watch") === "1", leads = q.get("leads") === "1";
      const r = await mutate((cur, t) => { if (watch) cur.watch_at = t.toISOString(); return { status: 200, body: view(cur, t, { leads }), readOnly: !watch }; });
      return reply(r.status, r.body);
    }
    const v = validateAction(body);
    const r = await mutate((cur, t) => {
      const rid = newId();
      const recent = cur.rate.filter((x) => +t - Date.parse(x.at) < RATE.windowMs);
      if (!v.ok) {
        cur.audit.push(auditEntry(t, { request_id: rid, action: body?.action, tier: DANGEROUS.includes(body?.action) ? "dangerous" : null, outcome: "denied", reason: v.code }));
        return { status: v.status, body: { error: v.error, code: v.code, request_id: rid } };
      }
      if (recent.length >= RATE.total || (v.tier === "control" && recent.filter((x) => x.tier === "control").length >= RATE.control)) {
        cur.audit.push(auditEntry(t, { request_id: rid, ...v, outcome: "denied", reason: "RATE_LIMIT" }));
        return { status: 429, body: { error: "Zu viele Aktionen – bitte kurz warten.", code: "RATE_LIMIT", request_id: rid } };
      }
      const cd = ACTIONS[v.action].cooldownMs || 0;
      const last = [...cur.requests].reverse().find((x) => x.action === v.action && ["pending", "running", "done"].includes(x.status));
      if (cd && last && +t - Date.parse(last.created_at) < cd) {
        cur.audit.push(auditEntry(t, { request_id: rid, ...v, outcome: "denied", reason: "COOLDOWN" }));
        return { status: 429, body: { error: `${ACTIONS[v.action].label}: Abkühlzeit läuft noch.`, code: "COOLDOWN", request_id: rid } };
      }
      cur.rate.push({ at: t.toISOString(), tier: v.tier });
      const def = ACTIONS[v.action];
      // READ aus dem letzten VPS-Status: sofort, ohne Auftrag. Ist der Status veraltet → kein Raten, sondern 503.
      if (def.snapshot) {
        const fresh = !!cur.snapshot_at && +t - Date.parse(cur.snapshot_at) < SNAPSHOT_STALE_MS;
        // Auch READ wird auditiert (ohne Inhalt – nur Aktion, Ergebnis, request_id).
        cur.audit.push(auditEntry(t, { request_id: rid, ...v, outcome: fresh ? "success" : "failure", reason: fresh ? null : "SERVER_OFFLINE" }));
        if (!fresh) return { status: 503, body: { error: "VPS meldet sich nicht – Status unbekannt.", code: "SERVER_OFFLINE", request_id: rid } };
        return { status: 200, body: { request_id: rid, action: v.action, tier: v.tier, status: "done", snapshot_at: cur.snapshot_at, result: cur.snapshot?.[def.snapshot] ?? null } };
      }
      const x = { request_id: rid, action: v.action, tier: v.tier, params: v.params, source: "cloud-ui", status: "pending", created_at: t.toISOString(), expires_at: new Date(+t + REQUEST_TTL_MS).toISOString() };
      cur.requests.push(x);
      cur.watch_at = t.toISOString();
      cur.audit.push(auditEntry(t, { ...x, outcome: "queued" }));
      return { status: 202, body: { request: publicRequest(x) } };
    });
    return reply(r.status, r.body);
  };
}
