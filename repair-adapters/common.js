// Gemeinsamer, sicherer Adapter-Contract für CHECK & REPARATUR CHF 480 (TF-042): Capabilities, Issue→Fix-Matrix,
// Minimal-Patch für href/src, Domain-Bindung vor jedem Write, lokales Objekt-Backup und Fehlerbereinigung.
//
// Contract (jeder Adapter: repair-adapters/wordpress.js, sftp.js, ssh.js; GitHub+Netlify über die Brücke in router.js):
//   detectCapabilities()                              → Capabilities, die der Adapter grundsätzlich anbieten kann
//   checkAccess(order, cred)                          → { ok, connector, capabilities, reason?, blocked_state? }
//   backup(order, cred)                               → { production_ref, backup_ref, rollback_point }
//   locate(issue, order, cred)                        → Location (exaktes Objekt + exakte Stelle + exaktes Ziel) | null
//   applyFix(issue, location, order, cred)            → { ok, change_ref, before_hash, after_hash }
//   validate(issue, order, cred)                      → { build_ok }
//   deployProduction(order, cred)                     → { ok, deploy_ref }
//   rollback(order, backup, cred)                     → { ok }
//   cleanup(order, cred)                              → { ok, revoked_required }
// cred ist der Credential-Kontext NUR zur Laufzeit (router.js baut ihn aus dem Tresor + dem Zugangsprofil und verwirft ihn
// nach dem Aufruf). Persistiert werden ausschliesslich Metadaten (PERSISTABLE_KEYS) – nie Zugangsdaten.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normDomain } from "../access-intake-api.js";

export { normDomain };
export const CAPABILITIES = Object.freeze(["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "REST_CONTENT_READ", "REST_CONTENT_WRITE",
  "BACKUP", "ROLLBACK", "BUILD_TEST", "HEALTH_CHECK"]);
export const CONTRACT_METHODS = Object.freeze(["checkAccess", "backup", "locate", "applyFix", "validate", "deployProduction", "rollback", "cleanup"]);
// Felder, die aus Adapter-Antworten überhaupt übernommen werden dürfen (Allowlist – alles andere fällt weg).
export const PERSISTABLE_KEYS = Object.freeze(["ok", "connector", "capabilities", "checked_at", "backup_ref", "rollback_ref", "production_ref",
  "rollback_point", "change_ref", "deploy_ref", "before_hash", "after_hash", "build_ok", "reason", "blocked_state", "revoked_required", "domain_mismatch"]);
export const MAX_AUTO_FIXES_PER_ORDER = 10;
export const MAX_FILES_PER_FIX = 3;
export const MAX_OCCURRENCES_PER_OBJECT = 3;

export const sha256 = (s) => crypto.createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest("hex");
export const hasCapabilities = (have = [], need = []) => need.every((c) => have.includes(c));
export const onlyCapabilities = (list) => [...new Set((Array.isArray(list) ? list : []).filter((c) => CAPABILITIES.includes(c)))];

// ---------- Issue → Fix-Matrix (zentrale Allowlist) ----------
// family "content": Objekt über eine Inhalts-Schnittstelle (WordPress REST); "files": Datei über SFTP.
// Alles, was nicht hier steht, wird NIE automatisch repariert (→ MANUAL_REVIEW_REQUIRED).
const REST_CAPS = Object.freeze(["REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK"]);
const FILE_CAPS = Object.freeze(["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"]);
export const ISSUE_FIX_MATRIX = Object.freeze({
  broken_link: Object.freeze({ fix: "replace_href", attr: "href", families: ["content", "files"] }),
  contact_page_broken: Object.freeze({ fix: "replace_href", attr: "href", families: ["content", "files"] }),
  navigation_broken: Object.freeze({ fix: "replace_href", attr: "href", families: ["content", "files"] }),
  broken_image: Object.freeze({ fix: "replace_src", attr: "src", families: ["content", "files"] }),
  missing_asset: Object.freeze({ fix: "replace_src", attr: "src", families: ["content", "files"] }),
  // Nur mit exakt belegter CSS-Ursache (Datei + exakter Ausschnitt + exakte Korrektur) und nur über Dateien.
  mobile_overflow: Object.freeze({ fix: "css_exact", attr: null, families: ["files"] }),
});
// Ausdrücklich NIE automatisch (auch wenn ein anderes Modul sie als „fix“ einstuft).
export const NEVER_AUTO_FIX = Object.freeze(["https_certificate", "certificate_error", "no_https", "no_https_redirect", "redirect_loop", "mixed_content",
  "dns", "dns_error", "server_security", "security_headers", "authentication", "auth", "login", "missing_title", "slow_response",
  "contact_form_broken", "button_broken", "broken_mailto"]);
export function fixSpecFor(type) {
  if (NEVER_AUTO_FIX.includes(type)) return null;
  return ISSUE_FIX_MATRIX[type] || null;
}
export const requiredCapabilities = (family) => (family === "content" ? [...REST_CAPS] : [...FILE_CAPS]);

// ---------- Geschützte Bereiche (nie automatisch) ----------
export const PROTECTED_RE = /impressum|imprint|mentions-l[ée]gales|datenschutz|privacy|agb\b|terms|preis|pricing|tarif|checkout|warenkorb|cart|kasse|zahlung|payment|bank|iban|vertrag|contract|konto|account|login|anmelden|register|kundendaten|benutzer|user|passwort|password|2fa|two-factor|dns|registrar|e-?mail-konfiguration|mx\b|security|sicherheit|woocommerce|shop\/|wp-admin|wp-login/i;
export const isProtectedText = (...parts) => PROTECTED_RE.test(parts.filter(Boolean).join(" "));

// ---------- Minimal-Patch: exakt den kaputten Verweis in genau diesem Attribut ersetzen ----------
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Freistehende Vorkommen (nicht Teil eines längeren Pfads/URLs): /team darf /team.html oder /team-alt nicht treffen.
const standalone = (v) => new RegExp(`(?<![\\w./~-])${esc(v)}(?![\\w./~-])`, "g");
const attrPatterns = (attr, v, blockJson) => [
  new RegExp(`(\\b${attr}\\s*=\\s*")${esc(v)}(")`, "g"),
  new RegExp(`(\\b${attr}\\s*=\\s*')${esc(v)}(')`, "g"),
  ...(blockJson ? [new RegExp(`("(?:url|href|src)"\\s*:\\s*")${esc(v)}(")`, "g")] : []),
];
const countRe = (text, re) => (text.match(re) || []).length;

// Formen des kaputten Verweises: Pfad und absolute URL (mit/ohne www, http/https) derselben Auftrags-Domain.
export function refForms({ brokenPath, fullUrl, domain }) {
  const forms = new Set([brokenPath]);
  const d = normDomain(domain);
  for (const proto of ["https", "http"]) for (const host of [d, `www.${d}`]) forms.add(`${proto}://${host}${brokenPath}`);
  if (fullUrl) { try { const u = new URL(fullUrl); if (normDomain(u.hostname) === d) forms.add(u.origin + u.pathname + u.search); } catch {} }
  return [...forms].filter(Boolean);
}

// Ersetzt NUR Attribut-Vorkommen (href/src bzw. Block-JSON url/href/src). Kommt der Verweis zusätzlich irgendwo anders vor
// (Fliesstext, Script, anderes Attribut) oder zu oft, wird NICHTS geändert – die Stelle ist dann nicht eindeutig.
export function patchReference(text, { attr, brokenPath, fullUrl = null, replacement, domain, blockJson = false, maxOccurrences = MAX_OCCURRENCES_PER_OBJECT }) {
  if (typeof text !== "string" || !attr || !brokenPath || !replacement || brokenPath === replacement) return { ok: false, reason: "invalid_input" };
  let out = text, total = 0;
  const diff = [];
  for (const form of refForms({ brokenPath, fullUrl, domain })) {
    const raw = countRe(text, standalone(form));
    if (!raw) continue;
    const pats = attrPatterns(attr, form, blockJson);
    const inAttr = pats.reduce((n, re) => n + countRe(text, re), 0);
    if (inAttr !== raw) return { ok: false, reason: "ambiguous_location" }; // Vorkommen ausserhalb des Attributs → nie raten
    const to = /^https?:\/\//.test(form) ? form.slice(0, form.length - brokenPath.length) + replacement : replacement;
    for (const re of pats) out = out.replace(re, (_m, a, b) => `${a}${to}${b}`);
    total += raw;
    diff.push({ before: form, after: to, count: raw });
  }
  if (!total) return { ok: false, reason: "not_found" };
  if (total > maxOccurrences) return { ok: false, reason: "too_many_occurrences" };
  // Lokale Validierung: Markup-Struktur unverändert, Längendifferenz exakt erklärbar.
  if (countRe(out, /</g) !== countRe(text, /</g) || countRe(out, />/g) !== countRe(text, />/g)) return { ok: false, reason: "structure_changed" };
  const expected = diff.reduce((n, d) => n + d.count * (d.after.length - d.before.length), 0);
  if (out.length - text.length !== expected) return { ok: false, reason: "unexpected_diff" };
  return { ok: true, text: out, count: total, diff };
}

// Exakte CSS-Korrektur: genau ein Vorkommen des belegten Ausschnitts in genau dieser Datei, sonst nichts.
export function patchExact(text, { from, to }) {
  if (typeof text !== "string" || !from || typeof to !== "string" || from === to) return { ok: false, reason: "invalid_input" };
  const n = text.split(from).length - 1;
  if (n !== 1) return { ok: false, reason: n ? "ambiguous_location" : "not_found" };
  return { ok: true, text: text.replace(from, () => to), count: 1, diff: [{ before: from, after: to, count: 1 }] };
}

// ---------- Domain-Bindung (unmittelbar vor JEDEM Write) ----------
export class DomainBindingError extends Error { constructor(msg) { super(msg); this.code = "DOMAIN_MISMATCH"; } }
export function assertDomainBinding(order = {}, { accessDomain = null, liveDomain = null } = {}) {
  const d = normDomain(order.domain);
  const checks = [["authorized_domain", order.authorization?.authorized_domain], ["access_domain", order.access_intake?.access_domain ?? accessDomain],
    ["credential_domain", accessDomain], ["live_domain", liveDomain]];
  if (!d) throw new DomainBindingError("Auftrag ohne Domain.");
  for (const [what, v] of checks) if (v != null && normDomain(v) !== d) throw new DomainBindingError(`Domain-Bindung verletzt (${what}) – STOP.`);
  if (order.customer_authorized_repair !== true) throw new DomainBindingError("Keine Reparaturfreigabe – STOP.");
}
// Öffentliche Seite abrufen (passiv) und prüfen, dass sie NICHT auf eine fremde Domain weiterleitet.
export async function liveTarget(fetchFn, url, domain, { timeoutMs = 20_000 } = {}) {
  const r = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "JarvisRepair/1.0" } });
  let host = null; try { host = new URL(r.url || url).hostname; } catch {}
  if (normDomain(host) !== normDomain(domain)) throw new DomainBindingError("Weiterleitung auf eine fremde Domain – STOP.");
  return { status: r.status, html: await r.text().catch(() => ""), final_url: r.url || url };
}

// ---------- Fehler bereinigen (nie Zugangsdaten in Meldungen) ----------
export function sanitizeText(s, secrets = []) {
  let out = String(s ?? "");
  for (const v of secrets) if (typeof v === "string" && v.length >= 4) out = out.split(v).join("[redacted]");
  out = out.replace(/-----BEGIN [^-]*-----[\s\S]*?(-----END [^-]*-----|$)/g, "[redacted-key]")
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/\b(authorization|password|passwort|secret|token|passphrase)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [redacted]").replace(/\bBearer\s+\S+/g, "Bearer [redacted]");
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}
export const sanitizeError = (e, secrets = []) => { const x = new Error(sanitizeText(e?.message || e, secrets) || "Adapter-Fehler"); if (e?.code) x.code = String(e.code).slice(0, 40); return x; };
// Nur erlaubte Metadaten übernehmen; enthält ein Wert dennoch ein Secret → harter Fehler (fail closed).
export function pickMeta(result, secrets = [], keys = PERSISTABLE_KEYS) {
  if (!result || typeof result !== "object") return result ?? null;
  const out = {};
  for (const k of keys) if (result[k] !== undefined) out[k] = k === "capabilities" ? onlyCapabilities(result[k]) : result[k];
  const raw = JSON.stringify(out);
  for (const v of secrets) if (typeof v === "string" && v.length >= 4 && raw.includes(v)) throw new Error("Adapter-Antwort enthielt Zugangsdaten – verworfen.");
  return out;
}

// ---------- Lokales Objekt-Backup (VPS, nur Inhalte der Website, NIE Zugangsdaten) ----------
// <worker>/repair_backups/<order_id>.json (600, Unterordner → nicht im Cloud-State-Backup). Vor JEDEM Write ein Eintrag mit
// Originalinhalt + Hash; Rollback stellt genau diese Inhalte wieder her. backup_ref enthält keine Pfade.
export const REPAIR_BACKUP_DIR = "repair_backups";
const ORDER_RE = /^RF480-\d{8}-[0-9a-f]{6}$/;
export function objectBackups(workerDir, orderId) {
  if (!ORDER_RE.test(String(orderId))) throw new Error("order_id ungültig.");
  const f = path.join(workerDir, REPAIR_BACKUP_DIR, `${orderId}.json`);
  const read = () => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return { order_id: orderId, entries: [] }; } };
  const write = (data) => {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f + ".tmp", JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
  };
  return {
    file: f,
    entries: () => read().entries,
    add(entry, now = new Date()) {
      const data = read();
      const backup_id = "B" + sha256(`${orderId}|${entry.object_type}|${entry.object_id}|${entry.original_hash}|${data.entries.length}`).slice(0, 12);
      const e = { backup_id, object_type: entry.object_type, object_id: String(entry.object_id), original_hash: entry.original_hash,
        original_content: Buffer.from(String(entry.original_content), "utf8").toString("base64"), mode: entry.mode ?? null,
        modified_at: entry.modified_at || null, backup_created_at: now.toISOString(), after_hash: null, status: "pending" };
      data.entries.push(e);
      write(data);
      return e;
    },
    update(backup_id, patch) {
      const data = read();
      const e = data.entries.find((x) => x.backup_id === backup_id);
      if (!e) throw new Error("Backup-Eintrag fehlt.");
      Object.assign(e, patch);
      write(data);
      return e;
    },
    content: (e) => Buffer.from(e.original_content, "base64").toString("utf8"),
    verifyWritable() { write(read()); return true; },
  };
}
