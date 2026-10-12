// Adapter-Router + Registry für CHECK & REPARATUR CHF 480 (TF-042).
//
//   routeRepair(...)   wählt den Adapter nach TATSÄCHLICHEN Fähigkeiten (Zugangsart, Art der Zugangsdaten, Zugangsprofil von
//                      Chris, explizites GitHub+Netlify-Mapping, erkannter Stack) – nie blind nach Formularfeld, nie „probieren“.
//                      github_netlify → bestehender GitHub+Netlify-Adapter, wordpress_cms → WordPress REST, sftp → SFTP,
//                      ssh → SSH/SFTP (ohne konfigurierte Checks: SFTP über SSH = minimal nötige Rechte),
//                      hosting → nur über eine klar erkennbare Schnittstelle (Profil/Schema/Mapping), sonst
//                      BLOCKED_UNSUPPORTED_STACK; other → BLOCKED_UNSUPPORTED_STACK. Kein Browser-Login, keine Hoster-Portale.
//   Zugangsprofil      repair_access_profiles.json (Worker-Verzeichnis, KEINE Secrets): je Domain Schnittstelle (für hosting),
//                      Port, remote_root, SSH-Host-Key-Fingerprint, WordPress-REST-Basis, konfigurierte Build-/Health-Checks.
//                      TF-043: für normale Aufträge erzeugt der Preflight (profile-builder.js) das Profil automatisch am Auftrag
//                      (order.access_profile); ein Profil von Chris hat Vorrang und bleibt für Sonderfälle (Checks, Webroot).
//   Credential-Kontext entsteht NUR zur Laufzeit je Adapter-Aufruf (Tresor entschlüsseln → sofort verwenden → verwerfen).
//   Brücke             übersetzt den Contract (common.js) in die Aufrufe der Engine; übernimmt nur Metadaten und bereinigt Fehler.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore } from "../mail-worker.js";
import { CAPABILITIES, hasCapabilities, onlyCapabilities, pickMeta, sanitizeError, normDomain, sha256, parseHost, normFingerprint } from "./common.js";
import { validateRemoteRoot } from "./sftp.js";
import { validateChecks } from "./ssh.js";
import { createProfilePreflight, PROFILE_ROUTING_KEYS, repairMappingsFor } from "./profile-builder.js";

export const ACCESS_PROFILES_FILE = "repair_access_profiles.json";
export const ADAPTER_KEYS = Object.freeze(["github_netlify", "wordpress", "sftp", "ssh"]);
export const ADAPTER_LABELS = Object.freeze({ github_netlify: "GitHub+Netlify", wordpress: "WordPress", sftp: "SFTP", ssh: "SSH" });
// Bevorzugung: Preview + Rollback (GitHub+Netlify) vor reinen Inhaltsrechten (WordPress REST) vor Dateirechten (SFTP) vor SSH.
const PREFERENCE = ["github_netlify", "wordpress", "sftp", "ssh"];
const INTERFACES = Object.freeze({ github_netlify: "github_netlify", wordpress_rest: "wordpress", sftp: "sftp", ssh: "ssh" });
// Feste, nicht geheime Fähigkeiten des bestehenden GitHub+Netlify-Adapters (Branch-Preview, Netlify-Restore).
export const LEGACY_CAPABILITIES = Object.freeze({ github_netlify: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK", "BUILD_TEST", "HEALTH_CHECK"] });
// Gebaute JS-Apps: HTML-Dateien sind Build-Artefakte – direkte Dateiänderungen würden beim nächsten Build verschwinden.
const BUILT_STACKS = new Set(["nextjs", "react"]);
const PROFILE_KEYS = new Set(["interface", "port", "remote_root", "host_key_sha256", "wp_api_base", "checks"]);

// ---------- Zugangsprofile (nur Metadaten, nie Secrets) ----------
export function loadAccessProfiles(store) { return store.read(ACCESS_PROFILES_FILE, { schema: 1, profiles: {} }).profiles || {}; }
export function setAccessProfile(store, domain, input = {}) {
  const d = normDomain(domain);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error("Domain erforderlich.");
  for (const k of Object.keys(input)) if (!PROFILE_KEYS.has(k)) throw new Error(`Feld "${k}" ist im Zugangsprofil nicht erlaubt (nie Zugangsdaten speichern).`);
  const p = {};
  if (input.interface != null) { if (!INTERFACES[input.interface]) throw new Error(`Schnittstelle unbekannt. Erlaubt: ${Object.keys(INTERFACES).join(", ")}.`); p.interface = input.interface; }
  if (input.port != null) { const n = Number(input.port); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Port ungültig."); p.port = n; }
  if (input.remote_root != null) { const v = validateRemoteRoot(input.remote_root); if (!v.ok) throw new Error(`remote_root ungültig (${v.reason}).`); p.remote_root = v.root; }
  if (input.host_key_sha256 != null) { const fp = normFingerprint(input.host_key_sha256); if (!fp || !/^SHA256:/.test(input.host_key_sha256)) throw new Error("Host-Key als SHA256:<43 Zeichen> angeben (ssh-keygen -lf)."); p.host_key_sha256 = fp; }
  if (input.wp_api_base != null) {
    let u; try { u = new URL(input.wp_api_base); } catch { throw new Error("wp_api_base ungültig."); }
    if (u.protocol !== "https:" || normDomain(u.hostname) !== d || u.username || u.password) throw new Error("wp_api_base: nur HTTPS auf der Auftrags-Domain, ohne Zugangsdaten.");
    p.wp_api_base = u.origin + u.pathname.replace(/\/+$/, "");
  }
  if (input.checks != null) { if (!p.remote_root) throw new Error("Checks nur mit remote_root."); p.checks = validateChecks(input.checks, p.remote_root); }
  const data = store.read(ACCESS_PROFILES_FILE, { schema: 1, profiles: {} });
  data.profiles = { ...(data.profiles || {}), [d]: { ...p, updated_at: new Date().toISOString() } };
  store.write(ACCESS_PROFILES_FILE, data);
  return data.profiles[d];
}

// ---------- Credential-Kontext (nur Laufzeit) ----------
// payload aus dem Tresor: { access_type, host, username, secret, notes } + (TF-043) port, remote_root, ssh_host_key_sha256,
// passphrase, website_stack_hint, provider_name. notes wird nie ausgewertet (kein Raten). remote_root und Host-Key gelangen NIE
// direkt aus dem Formular in den Kontext – nur über ein geprüftes Zugangsprofil (Chris bzw. Preflight, profile-builder.js).
export function buildCredentialContext(order, accessCtx, profile = null) {
  const raw = typeof accessCtx?.credential === "function" ? accessCtx.credential() : null;
  if (!raw || typeof raw !== "object") return null;
  const secret = typeof raw.secret === "string" && raw.secret ? raw.secret : null;
  const passphrase = typeof raw.passphrase === "string" && raw.passphrase ? raw.passphrase : null;
  const isKey = !!secret && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret);
  const h = parseHost(raw.host);
  const formPort = /^\d{1,5}$/.test(String(raw.port ?? "").trim()) && +raw.port >= 1 && +raw.port <= 65535 ? +raw.port : null;
  const ctx = {
    connector_type: accessCtx.connector_type || raw.access_type || null, domain: order.domain,
    scheme: h.scheme, host: h.hostname, port: profile?.port || h.port || formPort || null, username: raw.username || null,
    password: isKey ? null : secret, private_key: isKey ? secret : null, passphrase: isKey ? passphrase : null,
    api_base: profile?.wp_api_base || (h.scheme === "https" || (!h.scheme && h.hostname) ? h.raw : null),
    remote_root: profile?.remote_root || null, host_key_sha256: profile?.host_key_sha256 || null, checks: profile?.checks || null,
    secrets: [secret, passphrase, raw.username && secret ? `${raw.username}:${secret}` : null, secret ? Buffer.from(`${raw.username || ""}:${secret}`).toString("base64") : null].filter(Boolean),
  };
  ctx.wipe = () => { ctx.password = null; ctx.private_key = null; ctx.passphrase = null; ctx.username = null; ctx.secrets.length = 0; };
  return ctx;
}
// Wirksames Zugangsprofil eines Auftrags (TF-043): Profil von Chris (repair_access_profiles.json, Vorrang) ergänzt das vom
// Preflight erzeugte Auftragsprofil (order.access_profile, nur PROFILE_READY). Nur Routing-/Verbindungs-Metadaten, nie Secrets.
export function effectiveProfile(store, order = {}) {
  const manual = loadAccessProfiles(store)[normDomain(order.domain)] || null;
  const ap = order.access_profile?.profile_status === "PROFILE_READY" ? order.access_profile : null;
  if (!ap) return manual;
  const auto = Object.fromEntries(PROFILE_ROUTING_KEYS.filter((k) => ap[k] != null).map((k) => [k, ap[k]]));
  return { ...auto, ...Object.fromEntries(Object.entries(manual || {}).filter(([, v]) => v != null)) };
}
// Nicht geheime Merkmale für den Router (Klartext wird sofort verworfen).
export function credentialMeta(cred) {
  if (!cred) return { present: false };
  return { present: true, scheme: cred.scheme, has_password: !!cred.password, has_private_key: !!cred.private_key,
    username_is_root: String(cred.username || "").trim().toLowerCase() === "root", wp_rest_hint: /\/wp-json\b/.test(String(cred.api_base || "")) };
}

// ---------- Routing ----------
const blocked = (reason) => ({ adapter: null, state: "BLOCKED_UNSUPPORTED_STACK", reason });
export function routeRepair({ access_type, detected_stack = null, capabilities = null, credential_meta = {}, profile = null, has_mapping = false } = {}) {
  if (access_type === "other") return blocked("Zugangsart «other» – keine automatische Reparatur, Chris prüft manuell.");
  const meta = credential_meta || {};
  const scheme = meta.scheme || null;
  const c = new Set();
  switch (access_type) {
    case "github_netlify": c.add("github_netlify"); break;
    case "wordpress_cms": if (!scheme || scheme === "https") c.add("wordpress"); break;
    case "sftp": if (!scheme || scheme === "sftp") c.add("sftp"); break;
    case "ssh": if (!scheme || scheme === "ssh" || scheme === "sftp") c.add("ssh"); break;
    case "hosting":
      // Hosting nur über eine klar erkennbare technische Schnittstelle – nie über ein Login-Panel.
      if (profile?.interface && INTERFACES[profile.interface]) c.add(INTERFACES[profile.interface]);
      if (scheme === "sftp") c.add("sftp");
      if (scheme === "ssh") c.add("ssh");
      if (scheme === "https" && meta.wp_rest_hint) c.add("wordpress");
      if (has_mapping) c.add("github_netlify");
      break;
    default: return blocked("Zugangsart unbekannt.");
  }
  if (!c.size) return blocked(`Zugang (${access_type}) passt zu keiner unterstützten Schnittstelle (GitHub+Netlify, WordPress REST, SFTP, SSH/SFTP).`);
  // SSH ohne konfigurierte Build-/Health-Checks: nur Dateien nötig → SFTP über dieselbe SSH-Sitzung (minimal nötige Rechte).
  const hasChecks = Object.keys(profile?.checks?.build || {}).length + Object.keys(profile?.checks?.health || {}).length > 0;
  if (c.has("ssh") && !hasChecks) { c.delete("ssh"); c.add("sftp"); }
  let ranked = PREFERENCE.filter((k) => c.has(k));
  if (BUILT_STACKS.has(detected_stack)) ranked = ranked.filter((k) => k === "github_netlify" || k === "wordpress");
  if (!ranked.length) return blocked(`Stack "${detected_stack}" ist eine gebaute App – direkte Dateiänderungen nicht sicher.`);
  if (capabilities) {
    ranked = ranked.filter((k) => hasCapabilities(capabilities[k] || [], ["BACKUP", "ROLLBACK"]));
    if (!ranked.length) return { adapter: null, state: "MANUAL_REVIEW_REQUIRED", reason: "Kein Zugangsweg mit Backup UND Rollback." };
  }
  const adapter = ranked[0];
  const label = adapter === "sftp" && access_type === "ssh" ? "SSH/SFTP" : ADAPTER_LABELS[adapter];
  return { adapter, label, state: null, reason: `Zugang ${access_type}${scheme ? ` (${scheme})` : ""} → ${label}` };
}

// ---------- Brücke Contract → Engine ----------
// Die Engine ruft (order, …, accessCtx); hier entsteht je Aufruf der Credential-Kontext und wird danach verworfen.
export function bridgeAdapter(key, contract, { profileFor = () => null } = {}) {
  const call = async (order, accessCtx, fn, { raw = false } = {}) => {
    const cred = buildCredentialContext(order, accessCtx, profileFor(order));
    const secrets = cred ? [...cred.secrets] : [];
    try {
      const r = await fn(cred);
      if (raw) {
        if (r == null) return null;
        const s = JSON.stringify(r);
        for (const v of secrets) if (v.length >= 4 && s.includes(v)) throw new Error("Adapter-Antwort enthielt Zugangsdaten – verworfen.");
        return JSON.parse(s);
      }
      return pickMeta(r, secrets);
    } catch (e) { throw sanitizeError(e, secrets); }
    finally { cred?.wipe(); secrets.length = 0; }
  };
  const issueOf = (order, item) => ({ ...(order.issues?.[item.issue_id] || {}), location: item.fix });
  return {
    stack: key, contract: true, direct_live: true, capabilities: contract.detectCapabilities?.() || [],
    checkAccess: (order, ctx) => call(order, ctx, (c) => (c ? contract.checkAccess(order, c) : { ok: false, reason: "no_credentials" })),
    backup: (order, _opts, ctx) => call(order, ctx, (c) => contract.backup(order, c)),
    async locate(issue, order, ctx) {
      const loc = await call(order, ctx, (c) => contract.locate(issue, order, c), { raw: true });
      if (!loc) return null;
      return { target: loc.target, cause: loc.cause, planned_change: loc.planned_change, risk: loc.risk || "niedrig",
        required_capabilities: onlyCapabilities(loc.required_capabilities), before_hash: (loc.objects || loc.files || [])[0]?.before_hash || null, fix: loc };
    },
    applyFix: (item, order, ctx) => call(order, ctx, (c) => contract.applyFix(order.issues?.[item.issue_id] || { type: null }, item.fix, order, c)),
    async validate(order, ctx) {
      for (const item of order.plan || []) {
        if (order.issues?.[item.issue_id]?.repair_status !== "repaired") continue;
        const v = await call(order, ctx, (c) => contract.validate(issueOf(order, item), order, c));
        if (v?.build_ok !== true) return { build_ok: false };
      }
      return { build_ok: true };
    },
    deployProduction: (order, ctx) => call(order, ctx, (c) => contract.deployProduction(order, c)),
    rollback: (order, ctx) => call(order, ctx, (c) => contract.rollback(order, order.backup, c)),
    cleanup: (order, ctx) => call(order, ctx, (c) => contract.cleanup(order, c)),
  };
}

// ---------- Registry ----------
const require = createRequire(import.meta.url);
export const sshLibraryAvailable = () => { try { require.resolve("ssh2"); return true; } catch { return false; } };
export function adapterRegistryStatus() {
  return { status: "ACTIVE", adapters: [...ADAPTER_KEYS], ssh_library: sshLibraryAvailable() };
}

// Standard-Registry für den Produktivbetrieb: alle vier Adapter + Router. contract-Adapter erhalten ihren Kontext über die Brücke.
// TF-043: zusätzlich der Preflight (profile-builder.js), der aus dem sicher übermittelten Zugang automatisch ein Zugangsprofil
// erzeugt – profileDeps ersetzt in Tests die Netzwerk-Transporte (probeHostKey, connect) durch Attrappen.
export async function createAdapterRegistry({ dir = WORKER_DIR, store = createStore(dir), fetchFn = globalThis.fetch, legacy = {}, contracts = null, profileDeps = {} } = {}) {
  const profileFor = (order) => effectiveProfile(store, order);
  let c = contracts;
  if (!c) {
    const [{ wordpressAdapter }, { sftpAdapter }, { sshAdapter }] = await Promise.all([import("./wordpress.js"), import("./sftp.js"), import("./ssh.js")]);
    c = { wordpress: wordpressAdapter({ dir, fetchFn }), sftp: sftpAdapter({ dir, fetchFn }), ssh: sshAdapter({ dir, fetchFn }) };
  }
  const adapters = { ...legacy };
  for (const [k, a] of Object.entries(c)) adapters[k] = bridgeAdapter(k, a, { profileFor });
  const router = {
    // Klartext nur kurz für die nicht geheimen Merkmale (Schema, Art des Secrets) – danach verworfen.
    route({ order, access_type, detected_stack, accessCtx, has_mapping = false, capabilities = null }) {
      const profile = profileFor(order);
      const cred = buildCredentialContext(order, accessCtx, profile);
      const meta = credentialMeta(cred);
      cred?.wipe();
      return routeRepair({ access_type, detected_stack, capabilities, credential_meta: meta, profile, has_mapping });
    },
    capabilitiesOf: (key) => (adapters[key]?.capabilities?.length ? adapters[key].capabilities : LEGACY_CAPABILITIES[key] || []),
  };
  const preflight = createProfilePreflight({ adapters, fetchFn, capabilitiesOf: router.capabilitiesOf,
    manualProfileFor: (order) => loadAccessProfiles(store)[normDomain(order.domain)] || null, mappingsFor: (order) => repairMappingsFor(store, order.domain), ...profileDeps });
  return { adapters, router, preflight, status: adapterRegistryStatus };
}

export { CAPABILITIES, sha256, parseHost };

// Kommandozeile (nie Secrets): Zugangsprofil je Domain pflegen; Checks als JSON-Datei ({ "build": { id: { binary, args } } }).
//   node repair-adapters/router.js --profile <domain> [--interface sftp|ssh|wordpress_rest|github_netlify] [--root /pfad]
//                                  [--host-key SHA256:…] [--port 22] [--wp-api https://<domain>/wp-json] [--checks checks.json]
//   node repair-adapters/router.js --list | --status
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  try {
    if (argv.includes("--list")) console.log(JSON.stringify(loadAccessProfiles(store), null, 2));
    else if (argv.includes("--status")) console.log(JSON.stringify(adapterRegistryStatus(), null, 2));
    else if (flag("profile")) {
      const p = setAccessProfile(store, flag("profile"), Object.fromEntries(Object.entries({ interface: flag("interface"), remote_root: flag("root"), host_key_sha256: flag("host-key"),
        port: flag("port"), wp_api_base: flag("wp-api"), checks: flag("checks") ? JSON.parse(fs.readFileSync(flag("checks"), "utf8")) : undefined }).filter(([, v]) => v !== undefined)));
      console.log(`Zugangsprofil gespeichert: ${normDomain(flag("profile"))} → ${JSON.stringify(p)}`);
    } else { console.log("Befehle: --profile <domain> [...] | --list | --status"); process.exit(1); }
  } catch (e) { console.error("Fehler: " + e.message); process.exit(1); }
}
