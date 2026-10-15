// Website-Paket nach einer CHF-480-Reparatur (TF-059). Erst NACH bestandenem Abschluss-Gate (Retest + Regression + Browser-Gate)
// liest der Adapter den bereits autorisierten Webroot read-only aus; daraus entsteht genau EIN ZIP je Auftrag:
//
//   NETLIFY_READY              statische Website, ZIP selbst geprüft (entpackt, index.html im Root, keine verbotenen Dateien, keine
//                              lokalen absoluten Pfade, keine fehlenden internen Assets, lokal serviert + Chromium Desktop 1440×900 /
//                              Mobile 390×844 ohne JS-Fehler, ohne fehlende Assets, ohne massiven Overflow) → website-netlify-ready.zip
//   FULL_BACKUP_ONLY           vollständig exportierbar, aber PHP/WordPress/serverseitig bzw. ohne index.html → website-repaired-backup.zip
//                              (NICHT DIREKT AUF NETLIFY DEPLOYBAR)
//   PACKAGE_VALIDATION_FAILED  statisch, aber die Selbstprüfung schlug fehl → website-repaired-backup.zip (nie „Netlify Ready“)
//   EXPORT_NOT_AVAILABLE       Adapter kann den Webroot nicht vollständig/sicher lesen (z. B. WordPress-REST) – der Auftrag bleibt erfolgreich
//
// Sicherheit: nie .env*, .git/, SSH-/Private Keys, Zertifikate, Credentials/Secrets, Session-Dateien, DB-Konfiguration/-Dumps,
// Backups/Logs, node_modules, Jarvis-Temp-Dateien; Inhalte mit Schlüssel-/Token-Mustern oder den Zugangsdaten des Auftrags werden
// verworfen. Keine Pfadtraversierung (.., absolut, Backslash, Steuerzeichen), keine Symlinks. Ablage <artifacts>/<ORDER_ID>/ mit
// Verzeichnis 700 und Dateien 600, daneben artifact.json (ohne Zugangsdaten, ohne interne Pfade).
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const PACKAGE_STATES = Object.freeze(["NETLIFY_READY", "FULL_BACKUP_ONLY", "PACKAGE_VALIDATION_FAILED", "EXPORT_NOT_AVAILABLE"]);
export const NETLIFY_ZIP = "website-netlify-ready.zip";
export const BACKUP_ZIP = "website-repaired-backup.zip";
export const ARTIFACT_JSON = "artifact.json";
export const ORDER_ID_RE = /^RF480-\d{8}-[0-9a-f]{6}$/;
export const LIMITS = Object.freeze({ maxFiles: 5000, maxFileBytes: 40 * 1024 * 1024, maxTotalBytes: 150 * 1024 * 1024, maxDepth: 16 });
export const DESKTOP = Object.freeze({ width: 1440, height: 900 });
export const MOBILE = Object.freeze({ width: 390, height: 844 });
const OVERFLOW_MAX_PX = 40; // „massiver“ Overflow: deutlich breiter als der Bildschirm
const MAX_NAV_LINKS = 20;

// ---------- Was nie ins ZIP darf ----------
const EXCLUDED_DIR_RE = /^(secrets?|credentials?|private|\.git|\.svn|\.hg|\.ssh|\.gnupg|\.aws|\.docker|\.idea|\.vscode|node_modules|__macosx|cgi-bin|logs?|tmp|temp|sessions?|\.cache|cache|backups?|\.well-known\/acme-challenge)$/i;
const EXCLUDED_FILE_RE = new RegExp([
  "^\\.env(\\..*)?$", "^\\.htpasswd$", "^\\.htaccess$", "^\\.user\\.ini$", "^php\\.ini$", "^\\.my\\.cnf$", "^\\.pgpass$", "^\\.npmrc$", "^\\.netrc$", "^\\.git-credentials$",
  "^\\.bash.*", "^\\.profile$", "^\\.ds_store$", "^thumbs\\.db$", "^error_log$", "^authorized_keys$", "^known_hosts$", "^id_(rsa|dsa|ecdsa|ed25519).*",
  "\\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|ppk|asc|gpg|kdbx)$", "^wp-config.*\\.php$", "^(config|configuration|settings|local|parameters|database|db)\\.(php|inc|ya?ml|json|xml|ini)$",
  "^(credentials?|secrets?|tokens?|passwords?).*", "^sess_.*", "\\.(sql|sqlite3?|db|mdb|dump|bak|backup|old|orig|swp|swo|tmp|log)(\\.gz|\\.zip)?$", ".*~$",
  "^\\.jarvis-.*","^\\..*\\.jarvis-[0-9a-f]+\\.tmp$", "(backup|dump|sql|database|db|site|www|public_html|htdocs).*\\.(zip|tar|tgz|gz|7z|rar)$",
].join("|"), "i");
// Inhalte, die nach Schlüsseln/Tokens/DB-Passwörtern aussehen → Datei wird verworfen (nur Textdateien bis 2 MB geprüft).
const SECRET_CONTENT_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:sk|rk)_live_[0-9A-Za-z]{16,}|\bgh[pousr]_[0-9A-Za-z]{30,}|\bxox[abprs]-[0-9A-Za-z-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|define\(\s*['"]DB_PASSWORD['"]|\bDB_PASS(?:WORD)?\s*[=:]\s*['"]?[^\s'"]{4,}/;
const TEXT_EXT = /\.(html?|css|js|mjs|json|txt|xml|svg|md|php\d?|phtml|inc|ini|ya?ml|conf|config|env|sh|py|rb|pl|csv|map|webmanifest|htaccess)$/i;
const SERVER_SIDE_EXT = /\.(php\d?|phtml|asp|aspx|jsp|cgi|pl|py|rb)$/i;
const SERVER_SIDE_DIR = /^(wp-content|wp-includes|wp-admin|vendor|app|system|application)\//i;

// Relativer Pfad → kanonisch (posix) oder null (Traversal, absolut, Backslash, Steuerzeichen, zu tief/lang).
export function safeRelPath(rel) {
  if (typeof rel !== "string" || !rel || rel.length > 240 || /[\u0000-\u001f\u007f\\]/.test(rel) || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return null;
  const segs = rel.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "")) return null;
  if (segs.length > LIMITS.maxDepth) return null;
  return segs.join("/");
}
// Grund, warum ein Pfad nie ins ZIP darf (oder null).
export function excludedReason(rel) {
  const p = safeRelPath(rel);
  if (!p) return "unsafe_path";
  const segs = p.split("/");
  for (let i = 0; i < segs.length - 1; i++) if (EXCLUDED_DIR_RE.test(segs[i]) || EXCLUDED_DIR_RE.test(segs.slice(i, i + 2).join("/"))) return "excluded_dir";
  if (EXCLUDED_FILE_RE.test(segs.at(-1))) return "excluded_file";
  return null;
}
const looksText = (rel, buf) => TEXT_EXT.test(rel) || (buf.length <= 4096 && !buf.includes(0));
export function secretContent(rel, buf, secrets = []) {
  if (!Buffer.isBuffer(buf)) return true;
  for (const s of secrets) if (typeof s === "string" && s.length >= 6 && buf.includes(s)) return true;
  if (buf.length > 2 * 1024 * 1024 || !looksText(rel, buf)) return false;
  return SECRET_CONTENT_RE.test(buf.toString("utf8"));
}

// Statisch & Netlify-tauglich? (sonst Backup) – nur aus den exportierten Dateien, nie geraten.
export function classifyWebroot(paths = [], { stack = null } = {}) {
  const has = new Set(paths);
  if (stack === "wordpress" || paths.some((p) => /^wp-(content|includes|admin)\//i.test(p) || /(^|\/)wp-(login|load|settings)\.php$/i.test(p))) return { netlify_candidate: false, reason: "wordpress" };
  if (paths.some((p) => SERVER_SIDE_EXT.test(p))) return { netlify_candidate: false, reason: "server_side_code" };
  if (paths.some((p) => SERVER_SIDE_DIR.test(p) && /\.(php|inc)$/i.test(p))) return { netlify_candidate: false, reason: "server_side_code" };
  if (!has.has("index.html") && !has.has("index.htm")) return { netlify_candidate: false, reason: "no_root_index" };
  if (has.has("package.json") && !has.has("index.html")) return { netlify_candidate: false, reason: "build_required" };
  return { netlify_candidate: true, reason: null };
}

// ---------- ZIP (deflate, ohne Abhängigkeiten) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (buf) => { if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0; let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const dosTime = (d) => ({ time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() });
// Streaming-Schreiber: jede Datei wird sofort geschrieben (kein ganzes ZIP im Speicher).
export function createZipWriter(file, { now = new Date() } = {}) {
  const fd = fs.openSync(file, "wx", 0o600);
  const central = [], names = new Set();
  let offset = 0;
  const write = (b) => { fs.writeSync(fd, b); offset += b.length; };
  const { time, date } = dosTime(now);
  return {
    add(name, data) {
      const p = safeRelPath(name);
      if (!p || names.has(p.toLowerCase())) throw new Error("ZIP: ungültiger oder doppelter Name.");
      names.add(p.toLowerCase());
      const nameBuf = Buffer.from(p, "utf8"), crc = crc32(data), deflated = zlib.deflateRawSync(data, { level: 9 });
      const store = deflated.length >= data.length, body = store ? data : deflated;
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(store ? 0 : 8, 8); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12);
      h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
      const at = offset;
      write(h); write(nameBuf); write(body);
      central.push({ nameBuf, crc, csize: body.length, size: data.length, method: store ? 0 : 8, at });
    },
    finish() {
      const start = offset;
      for (const c of central) {
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(0x031e, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(c.method, 10); h.writeUInt16LE(time, 12); h.writeUInt16LE(date, 14);
        h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24); h.writeUInt16LE(c.nameBuf.length, 28);
        h.writeUInt32LE((0o100644 << 16) >>> 0, 38); h.writeUInt32LE(c.at, 42);
        write(h); write(c.nameBuf);
      }
      const e = Buffer.alloc(22);
      e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length, 8); e.writeUInt16LE(central.length, 10); e.writeUInt32LE(offset - start, 12); e.writeUInt32LE(start, 16);
      write(e); fs.fsyncSync(fd); fs.closeSync(fd);
      return { file_count: central.length };
    },
    abort() { try { fs.closeSync(fd); } catch {} fs.rmSync(file, { force: true }); },
  };
}
// ZIP lesen (nur für die Selbstprüfung): Namen werden streng geprüft, CRC verifiziert.
export function readZip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("ZIP: Verzeichnis fehlt.");
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP: Eintrag beschädigt.");
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38) >>> 16, at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    const lnlen = buf.readUInt16LE(at + 26), lxlen = buf.readUInt16LE(at + 28);
    const raw = buf.subarray(at + 30 + lnlen + lxlen, at + 30 + lnlen + lxlen + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error("ZIP: unbekannte Kompression.");
    if (crc32(data) !== crc) throw new Error("ZIP: Prüfsumme falsch.");
    out.push({ name, data, symlink: (attr & 0o170000) === 0o120000 });
  }
  return out;
}

// ---------- Selbstprüfung NETLIFY_READY ----------
const ATTR_RE = /<(?:img|script|link|source|video|audio|iframe|embed|object|use|a)\b[^>]*?\s(?:src|href|data|poster|xlink:href)\s*=\s*(["'])(.*?)\1/gis;
const SRCSET_RE = /\ssrcset\s*=\s*(["'])(.*?)\1/gis;
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
const LOCAL_PATH_RE = /^(file:|[A-Za-z]:[\\/]|\\\\|\/(home|var\/www|srv|opt|users|tmp|root)\/)/i;
const SKIP_REF_RE = /^(#|mailto:|tel:|javascript:|data:|blob:|about:|sms:|whatsapp:|\{\{|\$\{)/i;
// Ein Verweis aus einer Datei → Pfad im Paket (oder null = extern/irrelevant).
function localTarget(ref, fromRel, domain) {
  const r = ref.trim();
  if (!r || SKIP_REF_RE.test(r)) return null;
  let u;
  try { u = new URL(r, `https://pkg.invalid/${fromRel}`); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "pkg.invalid" && (!domain || host !== domain)) return null; // extern
  if (!/^https?:$/.test(u.protocol)) return null;
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch {}
  return p;
}
// Wie Netlify: /x/ → x/index.html, /x → x | x.html | x/index.html.
export function resolveStatic(files, urlPath) {
  const p = String(urlPath || "/").replace(/^\/+/, "");
  const cands = p === "" ? ["index.html", "index.htm"] : p.endsWith("/") ? [`${p}index.html`, `${p}index.htm`] : [p, `${p}.html`, `${p}/index.html`];
  return cands.find((c) => files.has(c)) || null;
}
export function staticChecks(entries, { domain = null, knownBroken = [] } = {}) {
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const r = { index_root: files.has("index.html"), forbidden: [], unsafe_names: [], symlinks: 0, local_paths: [], missing_assets: [], missing_pages: [] };
  const broken = new Set(knownBroken.map((x) => String(x).replace(/\/+$/, "") || "/"));
  for (const e of entries) {
    if (!safeRelPath(e.name)) r.unsafe_names.push(e.name.slice(0, 60));
    else if (excludedReason(e.name)) r.forbidden.push(e.name.slice(0, 60));
    if (e.symlink) r.symlinks++;
  }
  const check = (from, ref, kind) => {
    if (LOCAL_PATH_RE.test(ref.trim())) { r.local_paths.push(`${from}: ${ref.trim().slice(0, 60)}`); return; }
    const t = localTarget(ref, from, domain);
    if (t == null || resolveStatic(files, t)) return;
    if (kind === "page") { if (!broken.has(t.replace(/\/+$/, "") || "/")) r.missing_pages.push(`${from} → ${t.slice(0, 80)}`); }
    else r.missing_assets.push(`${from} → ${t.slice(0, 80)}`);
  };
  for (const [name, data] of files) {
    if (/\.html?$/i.test(name)) {
      const html = data.toString("utf8");
      for (const m of html.matchAll(ATTR_RE)) check(name, m[2], /^<a\b/i.test(m[0]) ? "page" : "asset");
      for (const m of html.matchAll(SRCSET_RE)) for (const part of m[2].split(",")) check(name, part.trim().split(/\s+/)[0] || "", "asset");
      for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|\sstyle\s*=\s*"([^"]*)"/gi)) for (const u of (m[1] || m[2] || "").matchAll(CSS_URL_RE)) check(name, u[2], "asset");
    } else if (/\.css$/i.test(name)) {
      for (const u of data.toString("utf8").matchAll(CSS_URL_RE)) check(name, u[2], "asset");
    }
  }
  r.ok = r.index_root && !r.forbidden.length && !r.unsafe_names.length && !r.symlinks && !r.local_paths.length && !r.missing_assets.length && !r.missing_pages.length;
  return r;
}

// Lokaler statischer Server NUR auf 127.0.0.1 aus dem entpackten Verzeichnis (Netlify-artige Auflösung, kein Directory-Listing).
const MIME = { ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain", ".xml": "application/xml" };
export async function serveStatic(dir, files) {
  const server = http.createServer((req, res) => {
    let p = "/";
    try { p = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname); } catch {}
    const hit = resolveStatic(files, p);
    if (!hit || req.method !== "GET" && req.method !== "HEAD") { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    const full = path.join(dir, ...hit.split("/"));
    if (!full.startsWith(dir + path.sep)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(hit).toLowerCase()] || "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : fs.readFileSync(full));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// Chromium (Desktop + Mobile) gegen das lokal servierte Paket. launch: wie repair-browser-validator.js chromiumLauncher.
export function createPackageBrowserCheck({ launch, timeoutMs = 30_000 } = {}) {
  if (typeof launch !== "function") throw new Error("launch erforderlich.");
  return async function browserCheck(baseUrl, { navPaths = [], repairedPaths = [] } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pkg-chromium-"));
    const origin = new URL(baseUrl).origin;
    let browser = null;
    const out = { desktop: null, mobile: null, navigation: null, repaired_links: null };
    try {
      browser = await launch({ home });
      for (const [name, vp] of [["desktop", DESKTOP], ["mobile", MOBILE]]) {
        const ctx = await browser.newContext({ viewport: vp, isMobile: name === "mobile", hasTouch: name === "mobile", serviceWorkers: "block" });
        const page = await ctx.newPage();
        const js = [], failed = [];
        page.on("pageerror", (e) => js.push(String(e?.message || e).slice(0, 120)));
        page.on("requestfailed", (rq) => { if (rq.url().startsWith(origin)) failed.push(new URL(rq.url()).pathname.slice(0, 80)); });
        page.on("response", (rs) => { if (rs.url().startsWith(origin) && rs.status() >= 400) failed.push(new URL(rs.url()).pathname.slice(0, 80)); });
        let status = null;
        try { status = (await page.goto(baseUrl + "/", { waitUntil: "load", timeout: timeoutMs }))?.status() ?? null; } catch { status = null; }
        await page.waitForTimeout(400);
        const probe = await page.evaluate(() => {
          const imgs = [...document.images].filter((i) => i.currentSrc && i.currentSrc.startsWith(location.origin));
          return { sw: document.documentElement.scrollWidth, vw: innerWidth, images: imgs.length, broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => new URL(i.currentSrc).pathname.slice(0, 80)),
            text: (document.body?.innerText || "").trim().length, nav: document.querySelectorAll("nav a[href], header a[href]").length };
        }).catch(() => null);
        const overflow = probe ? Math.max(0, probe.sw - probe.vw) : null;
        // Automatische Favicon-Anfrage des Browsers ist kein fehlendes Asset der Website.
        const missing = [...new Set([...failed.filter((p) => p !== "/favicon.ico"), ...(probe?.broken || [])])];
        const res = { ok: status === 200 && !!probe && probe.text > 0 && !js.length && !missing.length && overflow <= OVERFLOW_MAX_PX,
          status, js_errors: js.length, missing_local: missing.slice(0, 10), overflow_px: overflow, images: probe?.images ?? 0, images_broken: probe?.broken.length ?? 0 };
        if (name === "desktop") {
          // Navigation: interne Links der Startseite im Browser öffnen (nur GET auf dem lokalen Paket).
          const nav = [];
          for (const p of navPaths.slice(0, MAX_NAV_LINKS)) {
            const r = await page.goto(baseUrl + p, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null);
            nav.push({ path: p.slice(0, 80), ok: r?.status() === 200 });
          }
          out.navigation = { checked: nav.length, failed: nav.filter((x) => !x.ok).map((x) => x.path) };
          const rep = [];
          for (const p of repairedPaths.slice(0, MAX_NAV_LINKS)) {
            const r = await page.goto(baseUrl + p, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null);
            rep.push({ path: p.slice(0, 80), ok: r?.status() === 200 });
          }
          out.repaired_links = { checked: rep.length, failed: rep.filter((x) => !x.ok).map((x) => x.path) };
        }
        out[name] = res;
        await ctx.close();
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    }
    out.ok = !!(out.desktop?.ok && out.mobile?.ok && !out.navigation?.failed.length && !out.repaired_links?.failed.length);
    return out;
  };
}

// ZIP entpacken (Temp, 700) → statische Prüfung → lokal servieren → Browser. Temp wird immer gelöscht.
export async function validateNetlifyZip(zipFile, { domain = null, knownBroken = [], repairedPaths = [], browserCheck = null } = {}) {
  let entries;
  try { entries = readZip(fs.readFileSync(zipFile)); } catch (e) { return { ok: false, reason: "zip_unreadable", static: null, browser: null }; }
  const st = staticChecks(entries, { domain, knownBroken });
  if (!st.ok) return { ok: false, reason: "static_checks_failed", static: st, browser: null };
  if (typeof browserCheck !== "function") return { ok: false, reason: "browser_unavailable", static: st, browser: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-pkg-"));
  let srv = null;
  try {
    fs.chmodSync(dir, 0o700);
    for (const e of entries) {
      const full = path.join(dir, ...e.name.split("/"));
      if (!full.startsWith(dir + path.sep)) throw new Error("Pfad ausserhalb des Temp-Verzeichnisses.");
      fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
      fs.writeFileSync(full, e.data, { mode: 0o600, flag: "wx" });
    }
    const files = new Set(entries.map((e) => e.name));
    srv = await serveStatic(dir, files);
    const home = entries.find((e) => e.name === "index.html");
    const navPaths = [...new Set([...home.data.toString("utf8").matchAll(/<a\b[^>]*?\shref\s*=\s*(["'])(.*?)\1/gis)].map((m) => localTarget(m[2], "index.html", domain))
      .filter((p) => p && p !== "/" && resolveStatic(files, p)))];
    const browser = await browserCheck(srv.url, { navPaths, repairedPaths: repairedPaths.filter((p) => resolveStatic(files, p)) });
    // Reparierte Ziele, die im Paket fehlen, sind ein Paketfehler (nie „Netlify Ready“).
    const missingRepaired = repairedPaths.filter((p) => !resolveStatic(files, p));
    return { ok: !!browser?.ok && !missingRepaired.length, reason: browser?.ok ? (missingRepaired.length ? "repaired_target_missing" : null) : "browser_checks_failed", static: st, browser, missing_repaired: missingRepaired };
  } catch (e) {
    return { ok: false, reason: "browser_checks_failed", static: st, browser: null, error: String(e?.message || e).slice(0, 120) };
  } finally {
    if (srv) await srv.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Paket erzeugen ----------
const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const atomicJson = (f, data) => { fs.writeFileSync(f + ".tmp", JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); fs.chmodSync(f, 0o600); };
export const orderArtifactDir = (artifactsDir, orderId) => {
  if (!ORDER_ID_RE.test(String(orderId))) throw new Error("order_id ungültig.");
  return path.join(artifactsDir, orderId);
};
// Öffentliche Sicht (Dashboard/Cloud): nur feste Wörter, Dateiname, Grösse, Anzahl, gekürzte SHA – nie Pfade oder Inhalte.
export function packageSummary(pkg) {
  if (!pkg || !PACKAGE_STATES.includes(pkg.status)) return null;
  return { status: pkg.status, file: [NETLIFY_ZIP, BACKUP_ZIP].includes(pkg.file) ? pkg.file : null, size: Number.isInteger(pkg.size) ? pkg.size : null,
    sha256_short: typeof pkg.sha256 === "string" && /^[0-9a-f]{64}$/.test(pkg.sha256) ? pkg.sha256.slice(0, 12) : null, file_count: Number.isInteger(pkg.file_count) ? pkg.file_count : null,
    netlify_ready: pkg.status === "NETLIFY_READY" && pkg.netlify_ready === true };
}

// exportFiles(onFile) → { ok, complete, reason?, symlinks_skipped? } – der Adapter ruft onFile(rel, Buffer) je Datei auf.
// Ergebnis (für order.package): { status, reason, file, sha256, size, file_count, excluded, netlify_ready, validation, created_at }.
export async function createRepairPackage({ order, exportFiles, artifactsDir, browserCheck = null, secrets = [], now = new Date(), limits = LIMITS } = {}) {
  const at = now.toISOString();
  const none = (reason) => ({ status: "EXPORT_NOT_AVAILABLE", reason, file: null, sha256: null, size: null, file_count: 0, netlify_ready: false, created_at: at });
  if (!order || !ORDER_ID_RE.test(String(order.order_id))) return none("invalid_order");
  if (typeof exportFiles !== "function") return none("adapter_cannot_export");
  if (!artifactsDir) return none("no_artifacts_dir");
  const dir = orderArtifactDir(artifactsDir, order.order_id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  const tmpZip = path.join(dir, `.package-${crypto.randomBytes(6).toString("hex")}.zip.tmp`);
  const zip = createZipWriter(tmpZip, { now });
  const excluded = { unsafe_path: 0, excluded_dir: 0, excluded_file: 0, secret_content: 0, symlink: 0, too_large: 0 };
  const paths = [];
  let total = 0, tooBig = false;
  const onFile = (rel, data, meta = {}) => {
    if (meta.symlink) { excluded.symlink++; return false; }
    if (meta.credential_match) { excluded.secret_content++; return false; } // Datei enthält einen Zugangswert dieses Auftrags (Bridge)
    const why = excludedReason(rel);
    if (why) { excluded[why]++; return false; }
    if (!Buffer.isBuffer(data)) { excluded.unsafe_path++; return false; }
    if (data.length > limits.maxFileBytes) { excluded.too_large++; tooBig = true; return "stop"; }
    if (secretContent(rel, data, secrets)) { excluded.secret_content++; return false; }
    if (paths.length >= limits.maxFiles || total + data.length > limits.maxTotalBytes) { tooBig = true; return "stop"; }
    zip.add(rel, data); paths.push(rel); total += data.length;
    return true;
  };
  let exp;
  try { exp = await exportFiles(onFile); }
  catch (e) { zip.abort(); return none("export_failed"); }
  if (!exp?.ok || exp.complete !== true || tooBig || !paths.length) { zip.abort(); return none(!exp?.ok ? exp?.reason || "adapter_cannot_export" : tooBig ? "too_large" : !paths.length ? "empty_webroot" : "incomplete_read"); }
  excluded.symlink += Number.isInteger(exp.symlinks_skipped) ? exp.symlinks_skipped : 0;
  const { file_count } = zip.finish();
  const cls = classifyWebroot(paths, { stack: order.stack?.type || null });
  let status = cls.netlify_candidate ? "PACKAGE_VALIDATION_FAILED" : "FULL_BACKUP_ONLY", validation = null;
  if (cls.netlify_candidate) {
    const repairedPaths = Object.values(order.issues || {}).filter((i) => i.repair_status === "repaired").map((i) => i.location?.replacement || i.fix?.replacement || null)
      .concat((order.plan || []).filter((p) => order.issues?.[p.issue_id]?.repair_status === "repaired").map((p) => p.fix?.replacement || null)).filter((p) => typeof p === "string" && p.startsWith("/"));
    const knownBroken = Object.values(order.issues || {}).filter((i) => i.repair_status !== "repaired" && i.url).map((i) => { try { return new URL(i.url).pathname; } catch { return null; } }).filter(Boolean);
    validation = await validateNetlifyZip(tmpZip, { domain: String(order.domain || "").replace(/^www\./, "").toLowerCase(), knownBroken, repairedPaths: [...new Set(repairedPaths)], browserCheck });
    if (validation.ok) status = "NETLIFY_READY";
  }
  const name = status === "NETLIFY_READY" ? NETLIFY_ZIP : BACKUP_ZIP;
  // Genau ein Paket je Auftrag: ein älteres Paket des anderen Typs wird entfernt.
  for (const f of [NETLIFY_ZIP, BACKUP_ZIP]) if (f !== name) fs.rmSync(path.join(dir, f), { force: true });
  const final = path.join(dir, name);
  fs.renameSync(tmpZip, final); fs.chmodSync(final, 0o600);
  const sha256 = sha256File(final), size = fs.statSync(final).size;
  const v = validation ? { index_root: validation.static?.index_root ?? null, forbidden: validation.static?.forbidden.length ?? null, local_paths: validation.static?.local_paths.length ?? null,
    missing_assets: validation.static?.missing_assets.length ?? null, missing_pages: validation.static?.missing_pages.length ?? null,
    desktop: validation.browser?.desktop ? (validation.browser.desktop.ok ? "PASS" : "FAIL") : null, mobile: validation.browser?.mobile ? (validation.browser.mobile.ok ? "PASS" : "FAIL") : null,
    js_errors: validation.browser ? (validation.browser.desktop?.js_errors || 0) + (validation.browser.mobile?.js_errors || 0) : null,
    navigation_checked: validation.browser?.navigation?.checked ?? null, navigation_failed: validation.browser?.navigation?.failed.length ?? null,
    repaired_links_checked: validation.browser?.repaired_links?.checked ?? null, reason: validation.reason || null } : null;
  const artifact = { schema: 1, order_id: order.order_id, domain: String(order.domain || "").toLowerCase() || null, type: status, file: name, created_at: at, sha256, size, file_count,
    netlify_ready: status === "NETLIFY_READY", deployable_on_netlify: status === "NETLIFY_READY", note: status === "NETLIFY_READY" ? "Netlify Drop: ZIP direkt hochladen." : "NICHT DIREKT AUF NETLIFY DEPLOYBAR",
    classification: cls.reason, excluded, validation: v };
  atomicJson(path.join(dir, ARTIFACT_JSON), artifact);
  return { status, reason: status === "NETLIFY_READY" ? null : cls.reason || v?.reason || null, file: name, sha256, size, file_count, excluded, netlify_ready: status === "NETLIFY_READY", validation: v, created_at: at };
}

// Für den Workflow: vorkonfigurierter Packer (Ablageort + Browser-Prüfung). shouldSkip: verbotene Ordner/Dateien gar nicht lesen.
export const skipPath = (rel, isDir) => (isDir ? excludedReason(`${rel}/x`) === "excluded_dir" || !safeRelPath(rel) : excludedReason(rel) !== null);
export function createPackager({ artifactsDir, browserCheck = null, limits = LIMITS } = {}) {
  return {
    artifactsDir,
    create: ({ order, exportFiles, now = new Date(), secrets = [] }) => createRepairPackage({ order, artifactsDir, browserCheck, secrets, now, limits,
      exportFiles: typeof exportFiles === "function" ? (onFile) => exportFiles(onFile, { shouldSkip: skipPath, maxFiles: limits.maxFiles, maxDepth: limits.maxDepth }) : null }),
  };
}
