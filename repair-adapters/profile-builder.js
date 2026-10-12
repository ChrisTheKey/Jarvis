// Automatisches Zugangsprofil + Preflight für CHECK & REPARATUR CHF 480 (TF-043). Ersetzt für normale Aufträge den manuellen
// Schritt «node repair-adapters/router.js --profile <domain> --root <webroot> --host-key <fingerprint>» – ohne eine einzige
// Sicherheitsprüfung abzuschwächen. Ergebnis NUR bei eindeutigem, sicherem Befund (PROFILE_READY); sonst fail closed.
//
//   Input:  Auftrag (Domain, Freigabe), gerouteter Adapter, sicher übermittelter Zugang (Tresor, nur im Speicher), Capabilities
//   Output: { profile_status, reason, profile: { interface, port, remote_root, host_key_sha256, capabilities, profile_created_at,
//            host_key_source, webroot_source, webroot_signals, host_key_candidate? } } – NIE Zugangsdaten, nie Host/Benutzer.
//
// Regeln:
//   - WordPress REST: PROFILE_READY nur nach erfolgreicher Prüfung (HTTPS, REST, Domain-Bindung, Auth, Schreibrecht).
//   - GitHub+Netlify: PROFILE_READY nur mit GENAU EINER Zuordnung Domain→Repo→Branch→Site; sonst MANUAL_REVIEW_REQUIRED.
//   - SFTP/SSH, Host-Key: vertraut wird nur einer sicheren Quelle – (A) Fingerprint des Kunden aus dem Formular, (B) Profil von
//     Chris, (C) bestätigter Fingerprint (Kunde über den Bestätigungslink bzw. Chris) bzw. künftig eine vertrauenswürdige Provider-
//     API (TRUSTED_HOST_KEY_PROVIDERS, bewusst leer). Der vom Server präsentierte Fingerprint wird OHNE Zugangsdaten erfasst
//     (hostVerifier lehnt ab → keine Anmeldung). Keine Quelle → HOST_KEY_CONFIRMATION_REQUIRED (nur Kandidat gespeichert);
//     Abweichung → MANUAL_REVIEW_REQUIRED. Zugangsdaten gehen nur an einen Server mit vertrauenswürdigem Host-Key.
//   - Webroot: Profil von Chris > Angabe des Kunden (kanonisch, Sandbox, im Login-Root, existiert, Index vorhanden) > NUR LESENDE
//     Discovery weniger typischer Kandidaten innerhalb des Login-Roots (kein Traversal, keine Symlinks, keine System-/fremden
//     Home-Verzeichnisse). Automatisch übernommen nur bei GENAU EINEM plausiblen Kandidaten mit mehreren Signalen:
//     WordPress = wp-config.php + wp-content/ + wp-includes/ + index.php (nur Existenz – wp-config.php wird NIE gelesen);
//     statisch = index.html + Inhalt passt zur öffentlich abgerufenen Domain. 0 oder >1 Kandidaten → WAITING_FOR_ACCESS_PROFILE.
//   - Login als root, Login-Root in einem Systemverzeichnis, unsicheres remote_root → BLOCKED_UNSAFE_ACCESS.
//   - Kein Write: der Preflight liest nur (stat/readdir, index.html). Fehler enthalten nie Zugangsdaten (nur feste Codes).
//   - TF-044 Host-Key-Typ: der Server wird je sicherem Algorithmus (host-key.js: Ed25519, ECDSA, RSA-SHA2 – nie ssh-rsa/SHA-1,
//     nie ssh-dss) OHNE Login abgefragt. Genau EIN angebotener Schlüssel = vertrauenswürdiger Fingerprint → host_key_verified
//     + host_key_algorithm (für das Login-Pinning). Kein Treffer bzw. mehrere → MANUAL_REVIEW_REQUIRED; nur Legacy-Schlüssel →
//     BLOCKED_UNSAFE_ACCESS. Zugangsdaten erst danach – und nur an diesen Schlüssel/Algorithmus gebunden.
import path from "node:path";
import { validateRemoteRoot, ssh2SftpConnector, SYSTEM_DIRS } from "./sftp.js";
import { liveTarget, normDomain, onlyCapabilities, parseHost, normFingerprint, sha256 } from "./common.js";
import { ssh2ProbeHostKeyAlgorithm, discoverHostKeys, matchHostKey, safeHostKeyAlgorithms, isSafeHostKeyAlgorithm, fingerprintOf } from "./host-key.js";

const P = path.posix;
export const PROFILE_STATUSES = Object.freeze(["PROFILE_READY", "HOST_KEY_CONFIRMATION_REQUIRED", "WAITING_FOR_ACCESS_PROFILE",
  "MANUAL_REVIEW_REQUIRED", "BLOCKED_UNSAFE_ACCESS", "BLOCKED_NO_ACCESS", "PREFLIGHT_RETRY"]);
// Geheim: verlässt den Tresor nur zur Laufzeit. Nicht geheim: Metadaten für das Profil (trotzdem nie im Dashboard).
export const SECRET_FIELDS = Object.freeze(["secret", "passphrase"]);
export const ACCESS_META_FIELDS = Object.freeze(["access_type", "host", "port", "username", "remote_root", "host_key_sha256", "website_stack_hint", "provider_name"]);
export const STACK_HINTS = Object.freeze(["unknown", "wordpress", "static", "php", "other"]);
// Felder, die vom Auftragsprofil in den Credential-Kontext gelangen dürfen (router.js effectiveProfile).
export const PROFILE_ROUTING_KEYS = Object.freeze(["interface", "port", "remote_root", "host_key_sha256", "host_key_algorithm"]);
// Felder, die am Auftrag gespeichert werden (Allowlist) – nie Host, Benutzer, Passwörter, Schlüssel.
export const PROFILE_RECORD_KEYS = Object.freeze(["interface", "port", "remote_root", "host_key_sha256", "host_key_algorithm", "host_key_verified",
  "host_key_source", "host_key_candidate", "host_key_seen_at", "webroot_source", "webroot_signals", "capabilities", "profile_hash", "profile_created_at"]);
// Profil-Hash (TF-044): nur nicht geheime Verbindungs-Metadaten – nie password/private_key/passphrase/token, nie Host/Benutzer.
export const PROFILE_HASH_KEYS = Object.freeze(["interface", "port", "remote_root", "host_key_sha256", "host_key_algorithm", "capabilities"]);
export function profileHash(p = {}) {
  return sha256(JSON.stringify(PROFILE_HASH_KEYS.map((k) => [k, k === "capabilities" ? [...(p[k] || [])].sort() : p[k] ?? null])));
}
export const HOST_KEY_CONFIRMED_SOURCES = Object.freeze(["customer_confirmation", "chris_confirmation"]);
export const WEBROOT_CANDIDATES = Object.freeze(["public_html", "www", "htdocs", "httpdocs", "web", "site"]);
// Quelle C (künftig): Provider, deren API Host-Keys verlässlich liefert. Bewusst leer – nie stillschweigend erweitern.
export const TRUSTED_HOST_KEY_PROVIDERS = Object.freeze({});
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const within = (p, root) => root === "/" || p === root || p.startsWith(root + "/");

// Kurze, verständliche Gründe (Order-Historie/CLI). Nie Hosts, Pfade oder Zugangsdaten.
export const PROFILE_REASONS = Object.freeze({
  no_credentials: "Zugangsdaten unvollständig (Server, Benutzer, Passwort/Schlüssel).",
  scheme_unsupported: "Zugangsadresse ist kein SFTP/SSH-Zugang.",
  root_login: "Login als root – unsicher, keine automatische Reparatur.",
  port_invalid: "Port im Formular ungültig.",
  host_key_invalid: "Host-Key-Fingerprint im Formular ungültig (erwartet SHA256:…).",
  remote_root_invalid: "Website-Verzeichnis im Formular ungültig.",
  host_key_unavailable: "Server-Fingerprint nicht ermittelbar (Server nicht erreichbar) – neuer Versuch im nächsten Lauf.",
  host_key_mismatch: "Fingerprint des Servers weicht von der vertrauenswürdigen Angabe ab – keine Verbindung mit Zugangsdaten.",
  host_key_multiple_matches: "Mehrere Server-Schlüssel passen zum Fingerprint – nicht automatisch entschieden, keine Verbindung mit Zugangsdaten.",
  host_key_legacy_only: "Server bietet nur veraltete Host-Key-Algorithmen (ssh-rsa/SHA-1, ssh-dss) – unsicher, keine Verbindung mit Zugangsdaten.",
  host_key_unconfirmed: "Server-Fingerprint unbekannt – Bestätigung durch den Kunden nötig, bis dahin keine Verbindung mit Zugangsdaten.",
  auth_failed: "Anmeldung mit den übermittelten Zugangsdaten fehlgeschlagen.",
  connect_failed: "Verbindung zum Server fehlgeschlagen – neuer Versuch im nächsten Lauf.",
  login_root_unsafe: "Login-Verzeichnis liegt in einem Systemverzeichnis – unsicher.",
  remote_root_unsafe: "Website-Verzeichnis ist ein System-/zu breites Verzeichnis – unsicher.",
  remote_root_outside_login_root: "Website-Verzeichnis liegt ausserhalb des Login-Verzeichnisses – manuell prüfen.",
  remote_root_missing_dir: "Website-Verzeichnis existiert nicht (oder ist ein Symlink).",
  remote_root_not_webroot: "Im Website-Verzeichnis liegt keine Startseite (index.html/index.php).",
  no_webroot_candidate: "Kein Website-Verzeichnis eindeutig gefunden.",
  multiple_webroot_candidates: "Mehrere mögliche Website-Verzeichnisse – nicht automatisch entschieden.",
  webroot_not_verifiable: "Website-Verzeichnis nicht eindeutig belegbar (Inhalt passt nicht sicher zur Domain).",
  no_mapping: "Keine Zuordnung Domain→Repository→Netlify-Site.",
  ambiguous_mapping: "Mehrere Zuordnungen für diese Domain – nicht automatisch entschieden.",
  incomplete_mapping: "Zuordnung unvollständig (Repository/Branch/Site).",
  unknown_adapter: "Kein Profil-Weg für diesen Adapter.",
});
export const profileReason = (code) => PROFILE_REASONS[code] || String(code || "unbekannt").slice(0, 80);

// ---------- Geheim vs. nicht geheim trennen (Tresor-Payload) ----------
export function splitAccessPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const errors = [];
  let port = null;
  if (str(raw.port, 10)) { const n = Number(str(raw.port, 10)); if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n; else errors.push("port_invalid"); }
  const fp = normFingerprint(raw.ssh_host_key_sha256);
  if (fp === undefined) errors.push("host_key_invalid");
  const hint = str(raw.website_stack_hint, 20);
  const meta = { access_type: str(raw.access_type, 40), host: str(raw.host, 300), port, username: str(raw.username, 200),
    remote_root: str(raw.remote_root, 500), host_key_sha256: fp || null, website_stack_hint: STACK_HINTS.includes(hint) ? hint : "unknown",
    provider_name: str(raw.provider_name, 80), errors };
  const secret = { secret: typeof raw.secret === "string" && raw.secret ? raw.secret : null, passphrase: typeof raw.passphrase === "string" && raw.passphrase ? raw.passphrase : null };
  return { meta, secret };
}

// ---------- Host-Key-Erfassung OHNE Zugangsdaten (ssh2) ----------
// hostVerifier liefert false → ssh2 bricht VOR jeder Anmeldung ab. Es werden weder Passwort noch Schlüssel übertragen.
export async function ssh2HostKeyProbe({ host, port = 22, timeoutMs = 15_000 } = {}) {
  const mod = await import("ssh2");
  const Client = mod.Client || mod.default?.Client;
  const conn = new Client();
  return new Promise((resolve, reject) => {
    let fp = null, settled = false;
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(t); try { conn.end(); } catch {} fn(); };
    const t = setTimeout(() => done(() => reject(new Error("Host-Key: Zeitüberschreitung."))), timeoutMs + 1000);
    conn.on("error", () => done(() => (fp ? resolve(fp) : reject(new Error("Host-Key nicht ermittelbar.")))));
    conn.on("ready", () => done(() => reject(new Error("Unerwartete Anmeldung – abgebrochen."))));
    conn.on("close", () => done(() => (fp ? resolve(fp) : reject(new Error("Host-Key nicht ermittelbar.")))));
    // TF-044: nur sichere Algorithmen (nie ssh-rsa/SHA-1, nie ssh-dss – ssh2 hätte ssh-rsa sonst im Default).
    conn.connect({ host, port: Number(port) || 22, username: "jarvis-hostkey-probe", readyTimeout: timeoutMs, tryKeyboard: false,
      algorithms: { serverHostKey: [...safeHostKeyAlgorithms()] },
      hostVerifier: (key) => { fp = fingerprintOf(key); return false; } });
  });
}

// ---------- GitHub+Netlify-Zuordnungen (Datei wie github-netlify.js; lokal gelesen, kein Import-Zyklus) ----------
export function repairMappingsFor(store, domain) {
  const d = normDomain(domain);
  const all = store.read("repair_mappings.json", { mappings: {} }).mappings || {};
  return Object.entries(all).filter(([k]) => normDomain(k) === d).map(([, v]) => v);
}

// ---------- Webroot-Signale (nur stat/readdir; index.html höchstens lesen) ----------
export async function inspectWebroot(c, dir) {
  let st;
  try { st = await c.lstat(dir); } catch { return { exists: false }; }
  if (!st?.isDir || st.isSymlink) return { exists: false, symlink: !!st?.isSymlink };
  if (await c.realpath(dir) !== dir) return { exists: false, symlink: true };
  const entries = await c.readdir(dir);
  const has = (name, kind) => entries.some((e) => e?.filename === name && !e.attrs?.isSymlink && (kind === "dir" ? e.attrs?.isDir : e.attrs?.isFile));
  const indexHtml = ["index.html", "index.htm"].find((n) => has(n, "file")) || null;
  const s = {
    index_html: !!indexHtml, index_php: has("index.php", "file"),
    // WordPress-Struktur: reine Existenz. wp-config.php wird NIE gelesen oder gespeichert.
    wordpress: has("wp-config.php", "file") && has("wp-content", "dir") && has("wp-includes", "dir"),
    structure: ["css", "js", "img", "images", "assets"].some((n) => has(n, "dir")) || entries.filter((e) => /\.html?$/i.test(e?.filename || "") && e.attrs?.isFile).length >= 2,
  };
  return { exists: true, dir, index_file: indexHtml, signals: s, plausible: s.index_html || s.index_php };
}
async function readIndex(c, dir, file) {
  const full = P.join(dir, file);
  const st = await c.lstat(full).catch(() => null);
  if (!st?.isFile || st.isSymlink || (st.size != null && st.size > MAX_INDEX_BYTES)) return null;
  return Buffer.from(await c.readFile(full)).toString("utf8");
}
// Inhalt der Datei passt zur öffentlich abgerufenen Startseite: identisch (Whitespace egal) oder gleicher Titel UND gleiche
// lokale Verweise. Ein einzelnes schwaches Merkmal reicht nie.
export function contentMatches(fileHtml, liveHtml) {
  if (typeof fileHtml !== "string" || typeof liveHtml !== "string" || !fileHtml.trim() || !liveHtml.trim()) return false;
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  if (sha256(norm(fileHtml)) === sha256(norm(liveHtml))) return true;
  const title = (s) => (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().toLowerCase();
  const hrefs = (s) => new Set([...s.matchAll(/\bhref\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1].trim()).filter((h) => !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("//")));
  const a = hrefs(fileHtml), b = hrefs(liveHtml);
  return !!title(fileHtml) && title(fileHtml) === title(liveHtml) && a.size > 0 && a.size === b.size && [...a].every((h) => b.has(h));
}

// Kunden-Angabe kanonisieren: relativ bzw. ~/ → im Login-Root; kein Traversal; danach dieselbe Prüfung wie jedes remote_root.
export function canonicalRemoteRoot(input, loginRoot) {
  const raw = String(input || "").trim();
  if (!raw || raw.includes("\0") || raw.includes("\\") || /[\r\n]/.test(raw)) return { ok: false, reason: "remote_root_invalid" };
  if (raw.split("/").includes("..")) return { ok: false, reason: "remote_root_invalid" };
  const rel = raw.replace(/^~(\/|$)/, "");
  const joined = raw.startsWith("/") ? raw : P.join(loginRoot || "/", rel);
  const n = P.normalize(joined).replace(/\/+$/, "") || "/";
  const v = validateRemoteRoot(n);
  if (!v.ok) return { ok: false, reason: v.unsafe ? "remote_root_unsafe" : "remote_root_invalid", unsafe: !!v.unsafe };
  return { ok: true, root: v.root };
}

// Nur lesende Discovery weniger typischer Kandidaten im Login-Root. Genau EIN plausibler Kandidat mit mehreren Signalen.
export async function discoverWebroot(c, { loginRoot, domain, liveHtml = async () => null }) {
  const d = normDomain(domain);
  const names = [...WEBROOT_CANDIDATES, d, `www.${d}`, `domains/${d}/public_html`];
  const paths = [...new Set([loginRoot, ...names.map((n) => P.join(loginRoot, n))])].filter((p) => within(p, loginRoot) && validateRemoteRoot(p).ok);
  const plausible = [];
  for (const p of paths) {
    const w = await inspectWebroot(c, p).catch(() => ({ exists: false }));
    if (w.exists && w.plausible) plausible.push(w);
  }
  if (!plausible.length) return { ok: false, reason: "no_webroot_candidate", candidates: 0 };
  if (plausible.length > 1) return { ok: false, reason: "multiple_webroot_candidates", candidates: plausible.length };
  const w = plausible[0];
  if (w.signals.wordpress && w.signals.index_php) return { ok: true, root: w.dir, signals: ["single_candidate", "index_php", "wordpress_structure"] };
  if (w.signals.index_html) {
    const live = await liveHtml();
    const file = live ? await readIndex(c, w.dir, w.index_file).catch(() => null) : null;
    if (file != null && contentMatches(file, live)) return { ok: true, root: w.dir, signals: ["single_candidate", "index_html", "content_match", ...(w.signals.structure ? ["site_structure"] : [])] };
  }
  return { ok: false, reason: "webroot_not_verifiable", candidates: 1 };
}

// ---------- Preflight ----------
export function createProfilePreflight({ adapters = {}, capabilitiesOf = () => [], manualProfileFor = () => null, mappingsFor = () => [],
  probeHostKey = ssh2ProbeHostKeyAlgorithm, connect = ssh2SftpConnector(), fetchFn = globalThis.fetch, now = () => new Date() } = {}) {

  const result = (profile_status, reason, profile = {}) => ({ profile_status, reason, profile: profile_status === "PROFILE_READY" ? { ...profile, profile_hash: profileHash(profile) } : profile });
  // Host-Keys OHNE Zugangsdaten erfassen: je sicherem Algorithmus eine eigene Probe (TF-044). Eine Attrappe ohne Algorithmus-
  // Unterstützung liefert genau einen Fingerprint (Algorithmus unbekannt → beim Login per Discovery bestimmt, nie Legacy).
  const discover = async (target) => {
    if (probeHostKey.algorithmAware) return discoverHostKeys(target, { probe: probeHostKey });
    try { const fp = normFingerprint(await probeHostKey(target)); return fp ? { ok: true, keys: [{ algorithm: null, fingerprint: fp, key_type: null }] } : { ok: false, reason: "host_key_unavailable", keys: [] }; }
    catch { return { ok: false, reason: "host_key_unavailable", keys: [] }; }
  };

  async function run(order, { adapter, accessCtx } = {}) {
    const at = now().toISOString();
    const caps = onlyCapabilities(capabilitiesOf(adapter));
    if (adapter === "github_netlify") {
      const m = mappingsFor(order);
      if (!m.length) return result("MANUAL_REVIEW_REQUIRED", "no_mapping");
      if (m.length > 1) return result("MANUAL_REVIEW_REQUIRED", "ambiguous_mapping");
      if (!m[0]?.repo || !m[0]?.production_branch || !m[0]?.netlify_site_id) return result("MANUAL_REVIEW_REQUIRED", "incomplete_mapping");
      return result("PROFILE_READY", "mapping_unique", { interface: "github_netlify", capabilities: caps, profile_created_at: at });
    }
    if (adapter === "wordpress") {
      const a = adapters.wordpress;
      if (typeof a?.checkAccess !== "function") return result("MANUAL_REVIEW_REQUIRED", "unknown_adapter");
      let r;
      try { r = await a.checkAccess(order, accessCtx); } catch { return result("PREFLIGHT_RETRY", "connect_failed"); }
      if (r?.ok !== true) return result("BLOCKED_NO_ACCESS", String(r?.reason || "no_credentials").slice(0, 40));
      return result("PROFILE_READY", "wordpress_rest_verified", { interface: "wordpress_rest", capabilities: onlyCapabilities(r.capabilities || caps), profile_created_at: at });
    }
    if (adapter === "sftp" || adapter === "ssh") return fileProfile(order, adapter, accessCtx, caps, at);
    return result("MANUAL_REVIEW_REQUIRED", "unknown_adapter");
  }

  async function fileProfile(order, adapter, accessCtx, caps, at) {
    const raw = typeof accessCtx?.credential === "function" ? accessCtx.credential() : null;
    const split = splitAccessPayload(raw);
    if (raw && typeof raw === "object") for (const k of Object.keys(raw)) raw[k] = null; // Klartext sofort verwerfen
    if (!split) return result("BLOCKED_NO_ACCESS", "no_credentials");
    const { meta, secret } = split;
    try {
      const manual = manualProfileFor(order) || {};
      const h = parseHost(meta.host);
      if (h.scheme && !["sftp", "ssh"].includes(h.scheme)) return result("BLOCKED_NO_ACCESS", "scheme_unsupported");
      if (!h.hostname || !meta.username || !secret.secret) return result("BLOCKED_NO_ACCESS", "no_credentials");
      if (meta.username.toLowerCase() === "root") return result("BLOCKED_UNSAFE_ACCESS", "root_login");
      if (meta.errors.length) return result("WAITING_FOR_ACCESS_PROFILE", meta.errors[0]);
      const port = manual.port || meta.port || h.port || 22;
      const base = { interface: adapter === "ssh" ? "ssh" : "sftp", port, capabilities: caps, profile_created_at: at };
      // Quelle B: vollständiges Profil von Chris – der Adapter erzwingt den Host-Key bei jeder Verbindung (hostVerifier).
      if (manual.remote_root && manual.host_key_sha256) {
        // TF-044: Algorithmus zum Fingerprint von Chris einmalig OHNE Login ermitteln (sonst müsste jede Verbindung neu suchen).
        let alg = isSafeHostKeyAlgorithm(manual.host_key_algorithm) ? manual.host_key_algorithm : null;
        if (!alg && probeHostKey.algorithmAware) {
          const d = await discover({ host: h.hostname, port });
          if (!d.ok) return d.reason === "host_key_legacy_only" ? result("BLOCKED_UNSAFE_ACCESS", "host_key_legacy_only", { ...base, host_key_verified: false }) : result("PREFLIGHT_RETRY", "host_key_unavailable");
          const m = matchHostKey(d.keys, manual.host_key_sha256);
          if (!m.ok) return result("MANUAL_REVIEW_REQUIRED", m.reason === "host_key_no_match" ? "host_key_mismatch" : m.reason, { ...base, host_key_candidate: d.keys[0].fingerprint, host_key_seen_at: at, host_key_verified: false });
          alg = m.algorithm;
        }
        return result("PROFILE_READY", "chris_profile", { ...base, remote_root: manual.remote_root, host_key_sha256: normFingerprint(manual.host_key_sha256),
          ...(alg ? { host_key_algorithm: alg, host_key_verified: true } : {}),
          host_key_source: "chris_profile", webroot_source: "chris_profile", webroot_signals: ["chris_profile"] });
      }

      // Host-Key: angebotene Schlüssel OHNE Zugangsdaten erfassen (je sicherem Algorithmus), dann nur gegen vertrauenswürdige
      // Quellen prüfen. Erst nach eindeutigem Treffer gehen Zugangsdaten an den Server – gepinnt auf Fingerprint + Algorithmus.
      const d = await discover({ host: h.hostname, port });
      if (!d.ok && d.reason === "host_key_legacy_only") return result("BLOCKED_UNSAFE_ACCESS", "host_key_legacy_only", { ...base, host_key_verified: false });
      if (!d.ok) return result("PREFLIGHT_RETRY", "host_key_unavailable");
      const presented = d.keys[0].fingerprint; // bevorzugter sicherer Schlüssel = Kandidat für die Bestätigung
      const ap = order.access_profile || {};
      const sources = [
        ["chris_profile", manual.host_key_sha256],
        ["customer_form", meta.host_key_sha256],
        ...(HOST_KEY_CONFIRMED_SOURCES.includes(ap.host_key_source) ? [[ap.host_key_source, ap.host_key_sha256]] : []),
      ].map(([source, v]) => ({ source, fp: normFingerprint(v) })).filter((s) => s.fp);
      const review = (reason) => result("MANUAL_REVIEW_REQUIRED", reason, { ...base, host_key_candidate: presented, host_key_seen_at: at, host_key_verified: false });
      if (new Set(sources.map((s) => s.fp)).size > 1) return review("host_key_mismatch"); // Quellen widersprechen sich
      if (!sources.length) return result("HOST_KEY_CONFIRMATION_REQUIRED", "host_key_unconfirmed", { ...base, host_key_candidate: presented, host_key_seen_at: at, host_key_verified: false });
      const m = matchHostKey(d.keys, sources[0].fp);
      if (!m.ok) return review(["host_key_multiple_matches", "host_key_legacy_only"].includes(m.reason) ? m.reason : "host_key_mismatch");
      const keyProfile = { host_key_sha256: m.fingerprint, ...(m.algorithm ? { host_key_algorithm: m.algorithm } : {}), host_key_verified: true, host_key_source: sources[0].source };

      // Ab hier: Verbindung MIT Zugangsdaten, aber nur zum Server mit vertrauenswürdigem Host-Key – und nur lesend.
      const isKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret.secret);
      const cred = { host: h.hostname, port, username: meta.username, password: isKey ? null : secret.secret, private_key: isKey ? secret.secret : null,
        passphrase: isKey ? secret.passphrase : null, host_key_sha256: m.fingerprint, host_key_algorithm: m.algorithm || null };
      let c;
      try { c = await connect(cred); }
      catch (e) { return /authenticat|auth/i.test(String(e?.message)) ? result("BLOCKED_NO_ACCESS", "auth_failed") : result("PREFLIGHT_RETRY", "connect_failed"); }
      finally { cred.password = null; cred.private_key = null; cred.passphrase = null; }
      try {
        const login = await c.realpath(".");
        if (typeof login !== "string" || !login.startsWith("/") || (login !== "/" && SYSTEM_DIRS.some((d) => login === d || login.startsWith(d + "/")))) return result("BLOCKED_UNSAFE_ACCESS", "login_root_unsafe");
        let root, webroot_source, webroot_signals;
        if (manual.remote_root) {
          const w = await inspectWebroot(c, manual.remote_root);
          if (!w.exists) return result("WAITING_FOR_ACCESS_PROFILE", "remote_root_missing_dir", { ...base, ...keyProfile });
          [root, webroot_source, webroot_signals] = [manual.remote_root, "chris_profile", ["chris_profile"]];
        } else if (meta.remote_root) {
          const canon = canonicalRemoteRoot(meta.remote_root, login);
          if (!canon.ok) return result(canon.unsafe ? "BLOCKED_UNSAFE_ACCESS" : "WAITING_FOR_ACCESS_PROFILE", canon.reason, { ...base, ...keyProfile });
          if (!within(canon.root, login)) return result("WAITING_FOR_ACCESS_PROFILE", "remote_root_outside_login_root", { ...base, ...keyProfile });
          const w = await inspectWebroot(c, canon.root);
          if (!w.exists) return result("WAITING_FOR_ACCESS_PROFILE", "remote_root_missing_dir", { ...base, ...keyProfile });
          if (!w.plausible && !w.signals.wordpress) return result("WAITING_FOR_ACCESS_PROFILE", "remote_root_not_webroot", { ...base, ...keyProfile });
          [root, webroot_source, webroot_signals] = [canon.root, "customer_form", ["customer_form", ...Object.entries(w.signals).filter(([, v]) => v).map(([k]) => k)]];
        } else {
          let live;
          const liveHtml = async () => {
            if (live === undefined) live = await liveTarget(fetchFn, `https://${normDomain(order.domain)}/`, order.domain).then((r) => (r.status < 400 ? r.html : null), () => null);
            return live;
          };
          const d = await discoverWebroot(c, { loginRoot: login, domain: order.domain, liveHtml });
          if (!d.ok) return result("WAITING_FOR_ACCESS_PROFILE", d.reason, { ...base, ...keyProfile });
          [root, webroot_source, webroot_signals] = [d.root, "discovery", d.signals];
        }
        return result("PROFILE_READY", `webroot_${webroot_source}`, { ...base, ...keyProfile, remote_root: root, webroot_source, webroot_signals });
      } catch { return result("PREFLIGHT_RETRY", "connect_failed"); }
      finally { try { await c.close?.(); } catch {} }
    } finally { secret.secret = null; secret.passphrase = null; }
  }

  return { run, manualProfileFor };
}

// Nur erlaubte Profilfelder am Auftrag speichern (Typen geprüft). Nie Zugangsdaten, nie Host/Benutzer.
export function profileRecord(r, { prev = {}, now = new Date() } = {}) {
  const p = r?.profile || {};
  const out = { profile_status: PROFILE_STATUSES.includes(r?.profile_status) ? r.profile_status : "MANUAL_REVIEW_REQUIRED", reason: String(r?.reason || "").slice(0, 60) };
  for (const k of PROFILE_RECORD_KEYS) {
    const v = p[k];
    if (v == null) continue;
    if (k === "port" && Number.isInteger(v)) out.port = v;
    else if (k === "host_key_verified") out.host_key_verified = v === true;
    else if (k === "host_key_algorithm") { if (isSafeHostKeyAlgorithm(v)) out.host_key_algorithm = v; }
    else if (k === "capabilities" || k === "webroot_signals") out[k] = (Array.isArray(v) ? v : []).filter((x) => typeof x === "string").slice(0, 12);
    else if (typeof v === "string") out[k] = v.slice(0, 500);
  }
  if (out.host_key_source && HOST_KEY_CONFIRMED_SOURCES.includes(out.host_key_source) && prev.host_key_confirmed_at) out.host_key_confirmed_at = prev.host_key_confirmed_at;
  out.updated_at = now.toISOString();
  return out;
}
