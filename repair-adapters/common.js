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

// Host-Angabe aus dem Zugangsformular (sftp://host:22, host:2222, https://…) → nicht geheime Bestandteile. Nie geraten.
export function parseHost(host = "") {
  const h = String(host || "").trim();
  if (!h) return { scheme: null, hostname: null, port: null, raw: "" };
  const m = h.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (m) { try { const u = new URL(h); return { scheme: m[1].toLowerCase(), hostname: u.hostname, port: u.port ? Number(u.port) : null, path: u.pathname, raw: h }; } catch { return { scheme: "invalid", hostname: null, port: null, raw: h }; } }
  const hp = h.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/i);
  return hp ? { scheme: null, hostname: hp[1].toLowerCase(), port: hp[2] ? Number(hp[2]) : null, raw: h } : { scheme: "invalid", hostname: null, port: null, raw: h };
}
// SSH-Host-Key-Fingerprint normalisieren (ssh-keygen -lf: «SHA256:<43 Zeichen Base64>», «=» am Ende optional).
// null = nicht angegeben, undefined = angegeben, aber ungültig (fail closed, nie «reparieren»).
export function normFingerprint(v) {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim().replace(/^SHA256:/i, "").replace(/=+$/, "");
  return /^[A-Za-z0-9+/]{43}$/.test(s) ? `SHA256:${s}` : undefined;
}
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
  // TF-066: vom Kunden im Auftragsdialog ausdrücklich bestätigte Inhaltsänderung (alter → neuer Text, Telefon, E-Mail …).
  // Nur sichtbarer Text (patchVisibleText), nie Code, Attribute, Skripte, Dateinamen oder Datenbanken; ≤ 3 Stellen, ≤ 3 Objekte.
  customer_content_change: Object.freeze({ fix: "replace_text", attr: null, families: ["content", "files"] }),
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

// ---------- TF-066: bestätigte Kunden-Inhaltsänderung – nur SICHTBARER Text ----------
// HTML grob in Abschnitte zerlegen: Text (zwischen Tags) vs. alles andere (Tags samt Attributen, Kommentare, <script>, <style>,
// <template>, <noscript>). Ersetzt wird ausschliesslich in Text-Abschnitten. Kommt der alte Text zusätzlich irgendwo anders vor
// (Attribut, Skript, Meta, Dateiname …), wird NICHTS geändert – die Stelle ist dann nicht eindeutig (nie raten, nie global).
// Ausnahme nur für die zugehörigen Kontakt-Links: kind=email → href="mailto:<alt>", kind=phone → href="tel:<gleiche Nummer>".
const RAW_BLOCK_RE = /<(script|style|template|noscript|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->|<[^>]*>/gi;
export function htmlSegments(html) {
  const out = [];
  let last = 0;
  for (const m of String(html).matchAll(RAW_BLOCK_RE)) {
    if (m.index > last) out.push({ text: true, s: html.slice(last, m.index) });
    out.push({ text: false, s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push({ text: true, s: html.slice(last) });
  return out;
}
const countIn = (s, needle) => (needle ? s.split(needle).length - 1 : 0);
// Telefonnummern gleich? (Ziffern; 0… national gegen +CC… international, CH 41 / VN 84 und jede andere 1–3-stellige Vorwahl)
export function samePhone(a, b) {
  const x = String(a).replace(/\D/g, "").replace(/^00/, ""), y = String(b).replace(/\D/g, "").replace(/^00/, "");
  if (!x || !y) return false;
  if (x === y) return true;
  const nat = (d) => (d.startsWith("0") ? d.slice(1) : null);
  for (const [n, i] of [[x, y], [y, x]]) { const core = nat(n); if (core && core.length >= 6 && i.endsWith(core) && i.length - core.length >= 1 && i.length - core.length <= 3) return true; }
  return false;
}
// Neuer tel:-Wert im Stil des alten (international bleibt international, sofern die neue Nummer national angegeben ist).
function telValue(oldHref, from, to) {
  const href = oldHref.replace(/^tel:/i, "").replace(/[^\d+]/g, "").replace(/^00/, "+");
  const next = String(to).replace(/[^\d+]/g, "").replace(/^00/, "+");
  const fromD = String(from).replace(/\D/g, "");
  if (!href.startsWith("+") || !next.startsWith("0") || !fromD.startsWith("0")) return next;
  const hd = href.slice(1), cc = hd.slice(0, hd.length - (fromD.length - 1));
  return /^\d{1,3}$/.test(cc) ? `+${cc}${next.slice(1)}` : next;
}
const TEL_HREF_RE = /(\bhref\s*=\s*["'])(tel:[^"']+)(["'])/gi;
const MAILTO_HREF_RE = /(\bhref\s*=\s*["'])mailto:([^"'?]+)((?:\?[^"']*)?["'])/gi;
export function patchVisibleText(text, { from, to, kind = "text_replacement", maxOccurrences = MAX_OCCURRENCES_PER_OBJECT } = {}) {
  if (typeof text !== "string" || typeof from !== "string" || !from.trim() || typeof to !== "string" || from === to) return { ok: false, reason: "invalid_input" };
  if (/[<>]/.test(from) || /[<>]/.test(to)) return { ok: false, reason: "markup_not_allowed" };
  const segs = htmlSegments(text);
  const inText = segs.filter((s) => s.text).reduce((n, s) => n + countIn(s.s, from), 0);
  let linkHits = 0;
  const patchedSegs = segs.map((s) => {
    if (s.text) return { ...s, out: s.s.split(from).join(to) };
    let out = s.s;
    if (kind === "phone") out = out.replace(TEL_HREF_RE, (m, a, href, b) => (samePhone(href.slice(4), from) ? (linkHits++, `${a}tel:${telValue(href, from, to)}${b}`) : m));
    if (kind === "email") out = out.replace(MAILTO_HREF_RE, (m, a, addr, b) => (addr.trim().toLowerCase() === from.trim().toLowerCase() ? (linkHits++, `${a}mailto:${to}${b}`) : m));
    return { ...s, out };
  });
  if (!inText) return { ok: false, reason: "not_found" };
  // Alter Text ausserhalb des sichtbaren Texts (Attribut, Skript, Meta …), der nicht der zugehörige Kontakt-Link ist → nicht eindeutig.
  const rawElsewhere = segs.filter((s) => !s.text).reduce((n, s) => n + countIn(s.s, from), 0);
  const allowedElsewhere = kind === "email" ? segs.filter((s) => !s.text).reduce((n, s) => n + [...s.s.matchAll(MAILTO_HREF_RE)].filter((m) => m[2].trim().toLowerCase() === from.trim().toLowerCase()).length, 0) : 0;
  if (rawElsewhere > allowedElsewhere) return { ok: false, reason: "ambiguous_location" };
  if (inText + linkHits > maxOccurrences) return { ok: false, reason: "too_many_occurrences" };
  const out = patchedSegs.map((s) => s.out).join("");
  if (countRe(out, /</g) !== countRe(text, /</g) || countRe(out, />/g) !== countRe(text, />/g)) return { ok: false, reason: "structure_changed" };
  return { ok: true, text: out, count: inText + linkHits, diff: [{ before: from, after: to, count: inText }, ...(linkHits ? [{ before: kind === "phone" ? "tel:" : "mailto:", after: kind === "phone" ? "tel:" : "mailto:", count: linkHits }] : [])] };
}
export const visibleIncludes = (html, s) => !!s && htmlSegments(String(html || "")).some((x) => x.text && x.s.includes(s));
// Kandidaten im sichtbaren Text (nur Telefon/E-Mail, wenn der Kunde die bisherige Angabe nicht genannt hat). Genau EIN eindeutiger
// Wert (eine Schreibweise) → dieser wird ersetzt; sonst null (manuell) – nie raten, welche von mehreren Nummern gemeint ist.
const PHONE_SURFACE_RE = /(?:\+\d{1,3}[\s.\/-]?(?:\(0\)\s?)?|\b0)\d{1,4}(?:[\s.\/-]?\d{2,4}){2,4}\b/g;
const EMAIL_SURFACE_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export function visibleCandidates(html, kind) {
  const re = kind === "phone" ? PHONE_SURFACE_RE : kind === "email" ? EMAIL_SURFACE_RE : null;
  if (!re) return [];
  const out = [];
  for (const s of htmlSegments(html)) if (s.text) for (const m of s.s.matchAll(re)) { const v = m[0].trim(); if (kind !== "phone" || v.replace(/\D/g, "").length >= 9) out.push(v); }
  return out;
}
export function uniqueCandidate(values, kind) {
  const forms = [...new Set(values)];
  if (!forms.length) return null;
  if (kind === "phone") return forms.every((f) => samePhone(f, forms[0])) && forms.length === 1 ? forms[0] : null;
  return forms.length === 1 ? forms[0] : null;
}
// Text, der für eine Inhaltsänderung ersetzt wird (alter Wert + neuer Wert je Art) – Adressen nur mit exaktem alten Text.
export function contentChangeTexts(change = {}) {
  const k = change.kind;
  const addr = (a) => [a?.street, [a?.postal_code, a?.city].filter(Boolean).join(" "), a?.country].filter(Boolean).join(", ");
  if (k === "address") return { from: change.old_text || null, to: addr(change.address) || null };
  if (k === "removal") return { from: change.old_text || null, to: "" };
  if (k === "addition" || k === "other") return { from: null, to: null }; // Ergänzungen/sonstiges: Ort im Layout nicht eindeutig → manuell
  return { from: change.old_text || null, to: change.new_text || null };
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
