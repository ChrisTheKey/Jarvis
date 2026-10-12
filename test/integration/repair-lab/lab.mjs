// Repair Integration Lab (TF-044) – Orchestrierung der ISOLIERTEN Testumgebung. Nur für Tests, nie Teil des Produktions-Workers.
//
//   - Eigene Docker-Netze je Lauf: «int» (--internal, ohne Ausgang: MariaDB, WordPress) + «edge» (nur für die zwei auf
//     127.0.0.1 veröffentlichten Ports: Caddy-HTTPS und OpenSSH). Keine öffentlichen Ports, keine Production-Secrets, keine
//     Mounts von /opt/jarvis-mail/.secrets o. ä.
//   - Alle Test-Zugangsdaten (Linux-Passwort, Private Key + Passphrase, WordPress-Passwörter, Application Password,
//     DB-Passwörter) und alle SSH-Host-Keys entstehen zur Laufzeit und verschwinden mit Containern/Volumes (stop()).
//   - HTTPS über Caddy «tls internal» (lokale Test-CA). labFetch löst NUR *.test-Lab-Domains auf 127.0.0.1 auf und vertraut NUR
//     dieser Test-CA – jede andere Adresse wird verweigert (keine Verbindung zu Kunden- oder fremden Systemen).
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const LAB_LABEL = "jarvis.lab=tf044";
export const SSHD_IMAGE = "jarvis-repair-lab-sshd:tf044";
export const IMAGES = Object.freeze({ db: "mariadb:11.4", wp: "wordpress:6.8-php8.3-apache", cli: "wordpress:cli-php8.3", caddy: "caddy:2.10-alpine" });
export const DOMAINS = Object.freeze({ wp: "repair-lab.test", site: "static-lab.test", evil: "evil-lab.test", redirect: "redirect-lab.test", sshRedirect: "ssh-redirect-lab.test" });
export const FIXTURES = path.join(HERE, "fixtures");
const rnd = (n = 12) => crypto.randomBytes(n).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 1×1-PNG für die Mediathek (Testbild, keine Kundendaten).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function docker(args, { input = null, timeoutMs = 300_000, allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile("docker", args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !allowFail) { const e = new Error(`docker ${args[0]} ${args[1] || ""} fehlgeschlagen: ${String(stderr || err.message).slice(0, 400)}`); e.stdout = stdout; e.stderr = stderr; reject(e); return; }
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}
export const dockerAvailable = async () => (await docker(["version", "--format", "{{.Server.Version}}"], { allowFail: true, timeoutMs: 20_000 })).code === 0;

// Reste früherer Läufe (gleiches Label) entfernen – Container, Volumes, Netze. Nie etwas ohne Lab-Label.
export async function cleanupAll() {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${LAB_LABEL}`], { allowFail: true })).stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", "-v", ...ids], { allowFail: true });
  const vols = (await docker(["volume", "ls", "-q", "--filter", `label=${LAB_LABEL}`], { allowFail: true })).stdout.split(/\s+/).filter(Boolean);
  if (vols.length) await docker(["volume", "rm", "-f", ...vols], { allowFail: true });
  const nets = (await docker(["network", "ls", "-q", "--filter", `label=${LAB_LABEL}`], { allowFail: true })).stdout.split(/\s+/).filter(Boolean);
  if (nets.length) await docker(["network", "rm", ...nets], { allowFail: true });
}
export async function labResources() {
  const q = async (kind) => (await docker([...(kind ? [kind, "ls"] : ["ps", "-a"]), "-q", "--filter", `label=${LAB_LABEL}`], { allowFail: true })).stdout.split(/\s+/).filter(Boolean).length;
  return { containers: await q(null), volumes: await q("volume"), networks: await q("network") };
}

async function waitFor(fn, { timeoutMs = 180_000, everyMs = 1000, what = "Lab" } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(everyMs); }
  throw new Error(`${what}: Zeitüberschreitung${last ? ` (${String(last.message).slice(0, 200)})` : ""}`);
}

// ---------- HTTPS-Testtransport: nur Lab-Domains, nur Test-CA, nur 127.0.0.1 ----------
export function createLabFetch({ ca, port, hosts = Object.values(DOMAINS) }) {
  const calls = [];
  let fault = null;
  const one = (url, { method = "GET", headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") { reject(new Error("lab: nur HTTPS")); return; }
    if (!hosts.includes(u.hostname)) { reject(new Error(`lab: Host ${u.hostname} ist keine Lab-Domain – verweigert`)); return; }
    const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    calls.push({ host: u.hostname, path: u.pathname + u.search, method, authorization: !!h.authorization });
    const req = https.request({ host: "127.0.0.1", port, servername: u.hostname, ca, method, path: u.pathname + u.search, headers: { ...h, host: u.hostname }, timeout: 30_000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("lab: timeout")));
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
  async function labFetch(url, init = {}) {
    if (fault) { const r = await fault(String(url), init); if (r) return r; }
    let cur = String(url), headers = { ...(init.headers || {}) }, r;
    for (let hop = 0; hop < 6; hop++) {
      r = await one(cur, { ...init, headers });
      if (r.status >= 300 && r.status < 400 && r.headers.location && init.redirect !== "manual") {
        const next = new URL(r.headers.location, cur);
        if (next.hostname !== new URL(cur).hostname) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "authorization")); // wie fetch
        cur = next.href; continue;
      }
      break;
    }
    return response(r.status, r.body, cur, r.headers);
  }
  labFetch.calls = calls;
  labFetch.setFault = (fn) => { fault = fn; };
  return labFetch;
}
export function response(status, body, url, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
  return { status, ok: status >= 200 && status < 300, url, headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    text: async () => buf.toString("utf8"), json: async () => JSON.parse(buf.toString("utf8")) };
}

// ---------- Lab-Auditor + Retester (passiv, nur über labFetch) ----------
// Startseite + verlinkte Unterseiten derselben Domain (Tiefe 1), geprüft werden <a href> und <img src> im Inhaltsbereich.
const SKIP = /^\/(wp-json|wp-admin|wp-includes|feed|comments|xmlrpc\.php|wp-login\.php)|\/feed\/?$|[?#]/;
const mainOf = (html) => html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
function refs(html, base, host) {
  const out = [];
  for (const m of mainOf(html).matchAll(/<(a|img)\b[^>]*?\b(href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let u; try { u = new URL(m[3], base); } catch { continue; }
    if (u.hostname !== host || !/^https:$/.test(u.protocol) || SKIP.test(u.pathname + u.search)) continue;
    const label = m[1].toLowerCase() === "a" ? (html.slice(m.index + m[0].length).match(/^([^<]{0,80})/)?.[1] || "").trim() : (m[0].match(/alt\s*=\s*["']([^"']*)/i)?.[1] || "");
    out.push({ kind: m[1].toLowerCase() === "img" ? "image" : "link", url: u.origin + u.pathname, label });
  }
  return out;
}
export function labAuditor(fetchFn) {
  return {
    async audit(website) {
      const home = await fetchFn(website);
      const html = await home.text();
      const host = new URL(home.url || website).hostname;
      if (home.status >= 400) return { website, reachable: false, finalUrl: home.url, issues: [], requests: 1, pages: { home: html } };
      const pages = { home: html };
      const found = refs(html, home.url, host).map((r) => ({ ...r, page: website }));
      const status = new Map();
      const check = async (u) => { if (!status.has(u)) status.set(u, (await fetchFn(u)).status); return status.get(u); };
      for (const r of found.filter((x) => x.kind === "link")) {
        if (await check(r.url) >= 400) continue;
        const sub = await fetchFn(r.url);
        const t = await sub.text();
        if (/text\/html/.test(String(sub.headers.get("content-type") || "")) && !pages[r.url]) { pages[r.url] = t; found.push(...refs(t, r.url, host).map((x) => ({ ...x, page: r.url }))); }
      }
      const issues = [], seen = new Set();
      for (const r of found) {
        const key = `${r.kind}|${r.url}|${r.page}`;
        if (seen.has(key)) continue; seen.add(key);
        const st = await check(r.url);
        if (st >= 400) issues.push({ type: r.kind === "image" ? "broken_image" : "broken_link", url: r.url, page: r.page, label: r.label || undefined,
          evidence: `HTTP ${st}`, severity: "medium", reproducible: true, detectedAt: "2026-10-12T00:00:00.000Z" });
      }
      return { website, reachable: true, finalUrl: home.url, title: html.match(/<title[^>]*>([^<]*)/i)?.[1] || null, requests: status.size + 1, issues, pages };
    },
  };
}
// Ehrlich benannt: HTTP-Retest (kein Browser-Rendertest) – Seite erreichbar, gleiche Domain, keine kaputten Verweise im Inhalt.
export function labRetester(fetchFn) {
  const auditor = labAuditor(fetchFn);
  return async (target) => {
    const a = await auditor.audit(target);
    const ok = a.reachable && !a.issues.length;
    const problems = a.issues.map((i) => `${i.type} ${new URL(i.url).pathname}`);
    return { ok, method: "Lab-HTTP-Retest", desktop: { ok, viewport: "Desktop 1440×900 (Lab-HTTP)", problems }, mobile: { ok, viewport: "Smartphone 390×844 (Lab-HTTP)", problems } };
  };
}

// ---------- Lab starten ----------
export async function startLab({ log = () => {} } = {}) {
  const rid = rnd(3);
  const n = (s) => `jarvis-lab-${rid}-${s}`;
  const label = ["--label", LAB_LABEL, "--label", `jarvis.lab.run=${rid}`];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lab44-"));
  const secrets = { labuser_password: "Lp" + rnd(12), key_passphrase: "Kp" + rnd(12), wp_admin_password: "Wa" + rnd(12), wp_editor_password: "We" + rnd(12),
    db_root_password: "Dr" + rnd(12), db_password: "Dp" + rnd(12), wp_app_password: null };
  const lab = { rid, names: { sshd: n("sshd"), legacy: n("sshd-legacy"), db: n("db"), wp: n("wp"), caddy: n("caddy"), int: n("int"), edge: n("edge"),
    site: n("site"), wpvol: n("wpvol"), dbvol: n("dbvol") }, tmp, secrets, log };
  const N = lab.names;
  log("lab: Netze/Volumes");
  await docker(["network", "create", "--internal", ...label, N.int]);
  await docker(["network", "create", ...label, N.edge]);
  for (const v of [N.site, N.wpvol, N.dbvol]) await docker(["volume", "create", ...label, v]);
  log("lab: sshd-Image");
  await docker(["build", "-q", "-t", SSHD_IMAGE, path.join(HERE, "sshd")], { timeoutMs: 600_000 });

  // OpenSSH/SFTP (modern + legacy), nur 127.0.0.1.
  await docker(["run", "-d", "--name", N.sshd, ...label, "--network", N.edge, "-p", "127.0.0.1::22", "-v", `${N.site}:/home/labuser/public_html`, SSHD_IMAGE]);
  await docker(["run", "-d", "--name", N.legacy, ...label, "--network", N.edge, "-p", "127.0.0.1::22", "-e", "LAB_MODE=legacy", SSHD_IMAGE]);
  // WordPress + MariaDB nur im internen Netz (kein Ausgang, kein veröffentlichter Port).
  await docker(["run", "-d", "--name", N.db, ...label, "--network", N.int, "--network-alias", "db", "-v", `${N.dbvol}:/var/lib/mysql`,
    "-e", `MARIADB_ROOT_PASSWORD=${secrets.db_root_password}`, "-e", "MARIADB_DATABASE=wp", "-e", "MARIADB_USER=wp", "-e", `MARIADB_PASSWORD=${secrets.db_password}`, IMAGES.db]);
  lab.wpEnv = ["-e", "WORDPRESS_DB_HOST=db", "-e", "WORDPRESS_DB_USER=wp", "-e", `WORDPRESS_DB_PASSWORD=${secrets.db_password}`, "-e", "WORDPRESS_DB_NAME=wp"];
  await docker(["run", "-d", "--name", N.wp, ...label, "--network", N.int, "--network-alias", "wordpress", "-v", `${N.wpvol}:/var/www/html`, ...lab.wpEnv, IMAGES.wp]);
  // Caddy: HTTPS mit lokaler Test-CA für alle Lab-Domains.
  const caddyfile = [
    "{", "  local_certs", "  skip_install_trust", "  auto_https disable_redirects", "  admin off", "}",
    `${DOMAINS.wp} {`, "  tls internal", "  reverse_proxy wordpress:80", "}",
    `${DOMAINS.site} {`, "  tls internal", "  root * /srv/static", "  file_server", "}",
    `${DOMAINS.sshRedirect} {`, "  tls internal", `  redir https://${DOMAINS.evil}{uri} 302`, "}",
    `${DOMAINS.redirect} {`, "  tls internal", `  redir https://${DOMAINS.evil}{uri} 302`, "}",
    `${DOMAINS.evil} {`, "  tls internal", '  respond "Fremde Domain (Lab)" 200', "}", ""].join("\n");
  fs.writeFileSync(path.join(tmp, "Caddyfile"), caddyfile);
  await docker(["create", "--name", N.caddy, ...label, "--network", N.edge, "-p", "127.0.0.1::443", "-v", `${N.site}:/srv/static:ro`, IMAGES.caddy]);
  await docker(["cp", path.join(tmp, "Caddyfile"), `${N.caddy}:/etc/caddy/Caddyfile`]);
  await docker(["network", "connect", N.int, N.caddy]);
  await docker(["start", N.caddy]);

  const portOf = async (name, p) => Number((await docker(["port", name, p])).stdout.split(/\r?\n/)[0].split(":").pop());
  lab.ssh = { host: "127.0.0.1", port: await portOf(N.sshd, "22/tcp") };
  lab.legacySsh = { host: "127.0.0.1", port: await portOf(N.legacy, "22/tcp") };
  lab.httpsPort = await portOf(N.caddy, "443/tcp");
  for (const c of [N.sshd, N.legacy]) await waitFor(async () => /Server listening/.test((await docker(["logs", c], { allowFail: true })).stderr), { what: `sshd ${c}` });

  // Testbenutzer (kein root, kein sudo): Passwort + autorisierter Schlüssel nur zur Laufzeit.
  log("lab: Testbenutzer + Testseite");
  await docker(["exec", "-i", N.sshd, "chpasswd"], { input: `labuser:${secrets.labuser_password}\n` });
  const { utils } = require("ssh2");
  const kp = utils.generateKeyPairSync("ed25519", { passphrase: secrets.key_passphrase, cipher: "aes256-cbc", rounds: 16, comment: "jarvis-lab" });
  lab.privateKey = kp.private;
  await docker(["exec", "-i", N.sshd, "sh", "-c", "cat > /home/labuser/.ssh/authorized_keys && chown labuser:labuser /home/labuser/.ssh/authorized_keys && chmod 600 /home/labuser/.ssh/authorized_keys"], { input: kp.public + "\n" });
  await resetSite(lab);
  lab.hostKeys = await hostKeysOf(N.sshd);
  lab.legacyHostKeys = await hostKeysOf(N.legacy);

  // Test-CA von Caddy + HTTPS-Transport.
  log("lab: TLS");
  lab.ca = await waitFor(async () => { const r = await docker(["exec", N.caddy, "cat", "/data/caddy/pki/authorities/local/root.crt"], { allowFail: true }); return r.code === 0 && r.stdout.includes("BEGIN CERTIFICATE") ? r.stdout : null; }, { what: "Caddy-CA" });
  lab.fetch = createLabFetch({ ca: lab.ca, port: lab.httpsPort });
  await waitFor(async () => (await lab.fetch(`https://${DOMAINS.site}/`)).status === 200, { what: "statische Testseite" });

  log("lab: WordPress");
  await setupWordPress(lab);
  await waitFor(async () => (await lab.fetch(`https://${DOMAINS.wp}/`)).status === 200, { what: "WordPress" });
  lab.stop = () => stopLab(lab);
  return lab;
}

// Statische Testseite (kaputte Version) frisch in den Webroot legen + Sandbox-Fallen (Symlinks, .env, Datei ausserhalb).
export async function resetSite(lab) {
  const N = lab.names;
  await docker(["exec", N.sshd, "sh", "-c", "find /home/labuser/public_html -mindepth 1 -delete"]);
  await docker(["cp", path.join(FIXTURES, "static-broken") + path.sep + ".", `${N.sshd}:/home/labuser/public_html/`]);
  await docker(["exec", N.sshd, "sh", "-c", [
    "printf 'LAB_DUMMY=1\\n' > /home/labuser/.env",
    "printf '<html>ausserhalb</html>\\n' > /home/labuser/notes.html",
    "printf 'LAB_DUMMY=1\\n' > /home/labuser/public_html/.env",
    "ln -s /etc /home/labuser/public_html/etc-link",
    "ln -s /home/labuser/notes.html /home/labuser/public_html/outside.html",
    "chown -R labuser:labuser /home/labuser/public_html /home/labuser/.env /home/labuser/notes.html",
    "chown -h labuser:labuser /home/labuser/public_html/etc-link /home/labuser/public_html/outside.html",
    "find /home/labuser/public_html -type f -exec chmod 644 {} +",
  ].join(" && ")]);
}
// Host-Key-Fingerprints direkt vom Server (ssh-keygen -lf) – unabhängige Referenz für die Tests.
export async function hostKeysOf(container) {
  const out = (await docker(["exec", container, "sh", "-c", "for f in /etc/ssh/lab/ssh_host_*_key.pub; do ssh-keygen -lf \"$f\"; done"])).stdout;
  const keys = {};
  for (const line of out.split(/\r?\n/).filter(Boolean)) { const m = line.match(/(SHA256:[A-Za-z0-9+/]{43})\b.*\((\w+)\)\s*$/); if (m) keys[m[2].toLowerCase()] = m[1]; }
  return keys; // { ed25519, ecdsa, rsa }
}
// Hashes aller Dateien ausserhalb des Webroots (Home, /etc, /tmp, /srv) – Beweis «0 Write ausserhalb des Test-Webroots».
export async function outsideSnapshot(lab, container = lab.names.sshd) {
  return (await docker(["exec", container, "sh", "-c", "find /home/labuser /etc /tmp /srv /root -path /home/labuser/public_html -prune -o -type f -print0 2>/dev/null | xargs -0 sha256sum 2>/dev/null | sort; ls -la /home/labuser"], { allowFail: true })).stdout;
}
export async function webrootSnapshot(lab, container = lab.names.sshd) {
  return (await docker(["exec", container, "sh", "-c", "cd /home/labuser/public_html && find . -type f -print0 | xargs -0 sha256sum | sort; find . -type l | sort"])).stdout;
}
export async function sshdLog(lab, container = lab.names.sshd) { return (await docker(["logs", container], { allowFail: true })).stderr; }
export async function siteFile(lab, rel) { return (await docker(["exec", lab.names.sshd, "cat", `/home/labuser/public_html/${rel}`])).stdout; }

// ---------- WordPress (nur Testdaten) ----------
export async function wpCli(lab, script, { env = [] } = {}) {
  const r = await docker(["run", "--rm", "-i", "--network", lab.names.int, "--user", "33:33", "-v", `${lab.names.wpvol}:/var/www/html`, "-e", "HOME=/tmp", ...lab.wpEnv, ...env,
    IMAGES.cli, "sh", "-s"], { input: script, timeoutMs: 300_000 });
  return r.stdout;
}
async function setupWordPress(lab) {
  await waitFor(async () => (await docker(["exec", lab.names.wp, "test", "-f", "/var/www/html/wp-config.php"], { allowFail: true })).code === 0, { what: "wp-config" });
  await waitFor(async () => /OK|Success/i.test(await wpCli(lab, "wp db check >/dev/null 2>&1 && echo OK")), { what: "MariaDB", everyMs: 2000 });
  const S = lab.secrets;
  const out = await wpCli(lab, [
    "set -e",
    `wp core install --url=https://${DOMAINS.wp} --title='Repair Lab' --admin_user=labadmin --admin_password="$LAB_ADMIN_PW" --admin_email=admin@${DOMAINS.wp} --skip-email >/dev/null`,
    "wp rewrite structure '/%postname%/' >/dev/null && wp rewrite flush >/dev/null",
    "TEAM=$(wp post create --post_type=page --post_status=publish --post_title=Team --post_name=team --post_content='<p>Unser Team (Testdaten)</p>' --porcelain)",
    `php -r 'file_put_contents("/tmp/lab-logo.png", base64_decode("${PNG_B64}"));'`,
    "MEDIA=$(wp media import /tmp/lab-logo.png --title='Lab Logo' --porcelain)",
    "POST=$(wp post create --post_type=post --post_status=publish --post_title='Lab News' --post_name=lab-news --post_content='<p>Testpost (nur Testdaten).</p><p><img src=\"/wp-content/uploads/2020/01/lab-logo.png\" alt=\"Lab Logo\"></p>' --porcelain)",
    "START=$(wp post create --post_type=page --post_status=publish --post_title=Start --post_name=start --post_content='<p>Repair Lab – nur Testdaten.</p><p><a href=\"/team-alt/\">Unser Team</a> <a href=\"/lab-news/\">Lab News</a></p>' --porcelain)",
    "wp option update show_on_front page >/dev/null && wp option update page_on_front \"$START\" >/dev/null",
    `wp user create jarvislab jarvislab@${DOMAINS.wp} --role=editor --user_pass="$LAB_EDITOR_PW" >/dev/null`,
    "APP=$(wp user application-password create jarvislab jarvis-repair-lab --porcelain)",
    "echo \"IDS $TEAM $MEDIA $POST $START\"",
    "echo \"APP $APP\"",
  ].join("\n"), { env: ["-e", `LAB_ADMIN_PW=${S.wp_admin_password}`, "-e", `LAB_EDITOR_PW=${S.wp_editor_password}`] });
  const ids = out.match(/^IDS (\d+) (\d+) (\d+) (\d+)/m);
  const app = out.match(/^APP (\S+)/m);
  if (!ids || !app) throw new Error("WordPress-Setup unvollständig.");
  lab.wp = { team: +ids[1], media: +ids[2], post: +ids[3], start: +ids[4] };
  S.wp_app_password = app[1];
}
// Zustand, der sich durch eine Reparatur NIE ändern darf: Plugins, Themes, Benutzer, Einstellungen.
export async function wpGuardSnapshot(lab) {
  return wpCli(lab, [
    "wp plugin list --fields=name,status,version --format=json",
    "wp theme list --fields=name,status,version --format=json",
    "wp user list --fields=ID,user_login,user_email,roles,user_registered --format=json",
    "for o in blogname blogdescription siteurl home admin_email users_can_register default_role show_on_front page_on_front page_for_posts permalink_structure active_plugins template stylesheet; do printf '%s=' $o; wp option get $o --format=json; done",
  ].join("\n"));
}
// Kaputte Ausgangsinhalte (nur Testdaten) wiederherstellen – Test-Setup zwischen den Szenarien, kein Teil einer Reparatur.
export const WP_BROKEN = Object.freeze({
  start: '<p>Repair Lab – nur Testdaten.</p><p><a href="/team-alt/">Unser Team</a> <a href="/lab-news/">Lab News</a></p>',
  post: '<p>Testpost (nur Testdaten).</p><p><img src="/wp-content/uploads/2020/01/lab-logo.png" alt="Lab Logo"></p>',
});
export async function resetWp(lab) {
  await wpCli(lab, 'wp post update "$START_ID" --post_content="$START_HTML" >/dev/null && wp post update "$POST_ID" --post_content="$POST_HTML" >/dev/null && echo OK',
    { env: ["-e", `START_ID=${lab.wp.start}`, "-e", `START_HTML=${WP_BROKEN.start}`, "-e", `POST_ID=${lab.wp.post}`, "-e", `POST_HTML=${WP_BROKEN.post}`] });
}
export async function wpContent(lab, id) { return (await wpCli(lab, `wp post get ${Number(id)} --field=post_content`)).replace(/\r?\n$/, ""); }

export async function stopLab(lab) {
  const ids = (await docker(["ps", "-aq", "--filter", `label=jarvis.lab.run=${lab.rid}`], { allowFail: true })).stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", "-v", ...ids], { allowFail: true });
  for (const v of [lab.names.site, lab.names.wpvol, lab.names.dbvol]) await docker(["volume", "rm", "-f", v], { allowFail: true });
  for (const nw of [lab.names.int, lab.names.edge]) await docker(["network", "rm", nw], { allowFail: true });
  try { fs.rmSync(lab.tmp, { recursive: true, force: true }); } catch {}
  for (const k of Object.keys(lab.secrets)) lab.secrets[k] = null;
  lab.privateKey = null;
}
