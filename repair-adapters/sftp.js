// SFTP-Adapter für CHECK & REPARATUR CHF 480 (TF-042). Repariert ausschliesslich eindeutig lokalisierte Verweise (href/src)
// in statischen HTML-Dateien bzw. eine exakt belegte CSS-Stelle – innerhalb einer harten Pfad-Sandbox (remote_root).
//
// Sicherheitsmodell:
//   - Nur SFTP (SSH-Dateiübertragung, verschlüsselt). Kein FTP, keine Shell. Host-Key MUSS vorab von Chris im Zugangsprofil
//     hinterlegt sein (SHA256-Fingerprint) – sonst keine Verbindung (kein Trust-on-first-use).
//   - Zugangsdaten (Passwort/Private Key) nur zur Laufzeit im Credential-Kontext; nie gespeichert, nie geloggt.
//   - Login als root → BLOCKED_UNSAFE_ACCESS. remote_root Pflicht, kanonisch, kein Systemverzeichnis.
//   - Jeder Pfad bleibt kanonisch in remote_root: kein ../, kein absoluter Escape, kein Symlink-Escape, keine .ssh/.env/
//     .htaccess/Schlüssel-/Konfigurationsdateien. Schreiben nur .html/.htm/.css, nie PHP/Server-Konfiguration/Secrets.
//   - Vor JEDEM Write: Remote-Datei lesen, Hash prüfen, Original lokal sichern (Backup). Write nur atomar: Temp-Datei im
//     selben Verzeichnis → Rechte prüfen → Inhalt verifizieren → atomarer Rename (posix-rename). Ohne atomaren Rename → kein Write.
import crypto from "node:crypto";
import path from "node:path";
import { WORKER_DIR } from "../mail-worker.js";
import { uniqueReplacement, uniqueImageReplacement } from "./github-netlify.js";
import { ISSUE_FIX_MATRIX, fixSpecFor, requiredCapabilities, patchReference, patchExact, isProtectedText, assertDomainBinding, liveTarget,
  objectBackups, sha256, normDomain, MAX_FILES_PER_FIX } from "./common.js";

const P = path.posix;
export const WRITABLE_EXT = /\.(html?|css)$/i;
const READABLE_EXT = /\.(html?|css)$/i;
// Verbotene Pfadbestandteile (Gross-/Kleinschreibung egal) – Secrets, Server-/App-Konfiguration, Versionsverwaltung.
export const FORBIDDEN_SEGMENT_RE = /^(\.ssh|\.gnupg|\.git|\.svn|\.env.*|\.htaccess|\.htpasswd|\.user\.ini|php\.ini|wp-config\.php|authorized_keys|known_hosts|id_(rsa|dsa|ecdsa|ed25519).*|.*\.(pem|key|p12|pfx|crt)|\.bash.*|\.profile|\.npmrc|\.netrc|\.my\.cnf|config\.(php|json|ya?ml)|settings\.php|credentials.*|secrets?.*|wp-admin|wp-includes|cgi-bin|node_modules|vendor)$/i;
// Systemverzeichnisse: remote_root darf weder eines davon sein noch darunter liegen.
export const SYSTEM_DIRS = Object.freeze(["/etc", "/root", "/bin", "/sbin", "/usr", "/lib", "/lib32", "/lib64", "/boot", "/dev", "/proc", "/sys", "/run", "/var/lib", "/var/log", "/var/spool", "/var/run", "/snap"]);
const within = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/");

export class SandboxError extends Error { constructor(msg) { super(msg); this.code = "SANDBOX"; } }

// remote_root: absolut, normalisiert, kein Systemverzeichnis, nicht / oder /home bzw. ein ganzes Home, keine verbotenen Teile.
export function validateRemoteRoot(root) {
  if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0") || root.includes("\\")) return { ok: false, reason: "remote_root_missing" };
  const n = P.normalize(root).replace(/\/+$/, "") || "/";
  if (n !== root.replace(/\/+$/, "") || root.split("/").includes("..")) return { ok: false, reason: "remote_root_not_canonical" };
  if (n === "/" || SYSTEM_DIRS.some((d) => within(n, d))) return { ok: false, reason: "remote_root_system_dir", unsafe: true };
  if (/^\/home(\/[^/]+)?$/.test(n) || n === "/var" || n === "/srv" || n === "/opt" || n === "/tmp") return { ok: false, reason: "remote_root_too_broad", unsafe: true };
  if (n.split("/").filter(Boolean).some((s) => FORBIDDEN_SEGMENT_RE.test(s))) return { ok: false, reason: "remote_root_forbidden", unsafe: true };
  return { ok: true, root: n };
}

// Rein lexikalische Sandbox: relativer (oder absoluter, aber innerhalb liegender) Pfad → kanonischer Pfad in root.
export function sandboxPath(root, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || rel.includes("\\") || /[\r\n]/.test(rel)) throw new SandboxError("Pfad ungültig.");
  let r = rel;
  if (P.isAbsolute(r)) {
    if (!within(P.normalize(r), root)) throw new SandboxError("Absoluter Pfad ausserhalb von remote_root.");
    r = P.relative(root, P.normalize(r)) || ".";
  }
  const segs = r.split("/").filter((s) => s && s !== ".");
  if (segs.includes("..")) throw new SandboxError("Pfad-Traversal (../) verweigert.");
  for (const s of segs) if (FORBIDDEN_SEGMENT_RE.test(s)) throw new SandboxError("Geschützte Datei/Verzeichnis verweigert.");
  const full = P.normalize(P.join(root, ...segs));
  if (!within(full, root)) throw new SandboxError("Pfad ausserhalb von remote_root.");
  return full;
}

// Symlink-sichere Auflösung über den Server: realpath des Ziels (bzw. seines Ordners) muss in realpath(remote_root) liegen.
export async function resolveSafe(client, root, rel, { mustExist = true, forWrite = false } = {}) {
  const full = sandboxPath(root, rel);
  const realRoot = await client.realpath(root);
  if (realRoot !== root) throw new SandboxError("remote_root ist selbst ein Symlink.");
  let st = null;
  try { st = await client.lstat(full); } catch { if (mustExist) throw new SandboxError("Datei existiert nicht."); }
  if (st?.isSymlink) {
    const real = await client.realpath(full);
    if (!within(real, realRoot)) throw new SandboxError("Symlink-Escape verweigert.");
    if (forWrite) throw new SandboxError("Schreiben über einen Symlink verweigert.");
  }
  const realDir = await client.realpath(P.dirname(full));
  if (!within(realDir, realRoot)) throw new SandboxError("Symlink-Escape (Verzeichnis) verweigert.");
  if (forWrite && !WRITABLE_EXT.test(full)) throw new SandboxError("Dateityp darf nicht automatisch verändert werden.");
  return { full, st };
}

// ---------- Transport (ssh2, nur SFTP-Subsystem) ----------
// Liefert einen normalisierten Client: realpath, lstat, stat, readFile, writeFile, rename (atomar, posix-rename@openssh.com),
// unlink, chmod, readdir, close. Fehler enthalten nie Zugangsdaten. Host-Key-Prüfung ist Pflicht.
const statOf = (s) => (s ? { isSymlink: s.isSymbolicLink?.() === true, isDir: s.isDirectory?.() === true, isFile: s.isFile?.() === true, mode: s.mode, size: s.size, mtime: s.mtime } : null);
export async function ssh2Session(cred, { timeoutMs = 20_000, withSftp = true } = {}) {
  const expected = String(cred?.host_key_sha256 || "").replace(/^SHA256:/, "").replace(/=+$/, "");
  if (!expected) throw new Error("Host-Key nicht hinterlegt – keine Verbindung (kein Trust-on-first-use).");
  if (!cred.host || !cred.username || (!cred.password && !cred.private_key)) throw new Error("Zugangsdaten unvollständig.");
  const mod = await import("ssh2");
  const Client = mod.Client || mod.default?.Client;
  const conn = new Client();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { conn.end(); reject(new Error("SSH-Verbindung: Zeitüberschreitung.")); }, timeoutMs + 1000);
    conn.once("ready", () => { clearTimeout(t); resolve(); });
    conn.once("error", (e) => { clearTimeout(t); reject(new Error(`SSH-Verbindung fehlgeschlagen (${e?.level || e?.code || "error"}).`)); });
    conn.connect({ host: cred.host, port: Number(cred.port) || 22, username: cred.username, readyTimeout: timeoutMs, tryKeyboard: false,
      ...(cred.private_key ? { privateKey: cred.private_key } : { password: cred.password }),
      hostVerifier: (key) => crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "") === expected });
  });
  let sftp = null;
  if (withSftp) sftp = await new Promise((resolve) => conn.sftp((err, s) => resolve(err ? null : s)));
  const op = (name, fn) => new Promise((resolve, reject) => fn((err, v) => (err ? reject(new Error(`SFTP ${name} fehlgeschlagen (${err.code ?? "error"}).`)) : resolve(v))));
  const client = sftp && {
    realpath: (p) => op("realpath", (cb) => sftp.realpath(p, cb)),
    lstat: async (p) => statOf(await op("lstat", (cb) => sftp.lstat(p, cb))),
    stat: async (p) => statOf(await op("stat", (cb) => sftp.stat(p, cb))),
    readFile: (p) => op("read", (cb) => sftp.readFile(p, cb)),
    writeFile: (p, data, { mode } = {}) => op("write", (cb) => sftp.writeFile(p, data, mode != null ? { mode } : {}, cb)),
    rename: (from, to) => op("rename", (cb) => sftp.ext_openssh_rename(from, to, cb)),
    unlink: (p) => op("unlink", (cb) => sftp.unlink(p, cb)),
    chmod: (p, mode) => op("chmod", (cb) => sftp.chmod(p, mode, cb)),
    readdir: async (p) => (await op("readdir", (cb) => sftp.readdir(p, cb))).map((e) => ({ filename: e.filename, attrs: statOf(e.attrs) })),
    close: () => conn.end(),
  };
  return { conn, client, close: () => conn.end() };
}
export const ssh2SftpConnector = (opts = {}) => async (cred) => {
  const s = await ssh2Session(cred, opts);
  if (!s.client) { s.close(); throw new Error("SFTP-Subsystem nicht verfügbar."); }
  return s.client;
};

// ---------- Adapter ----------
export function sftpAdapter({ dir = WORKER_DIR, connect = ssh2SftpConnector(), fetchFn = globalThis.fetch, connector = "sftp",
  maxDepth = 5, maxFiles = 400, maxScan = 80 } = {}) {
  const backups = (order) => objectBackups(dir, order.order_id);
  const rootOf = (cred) => { const v = validateRemoteRoot(cred?.remote_root); if (!v.ok) throw new SandboxError(`remote_root ungültig (${v.reason}).`); return v.root; };
  // Verbindung nur für die Dauer eines Aufrufs; danach geschlossen.
  const withClient = async (cred, fn) => { const c = await connect(cred); try { return await fn(c); } finally { try { await c.close?.(); } catch {} } };

  // Begrenzter Verzeichnisbaum (relativ), Symlinks/verbotene Ordner werden nie betreten.
  async function listTree(c, root) {
    const out = [];
    const queue = [["", 0]];
    while (queue.length && out.length < maxFiles) {
      const [rel, depth] = queue.shift();
      const entries = await c.readdir(rel ? P.join(root, rel) : root);
      for (const e of entries) {
        if (!e?.filename || e.filename === "." || e.filename === ".." || FORBIDDEN_SEGMENT_RE.test(e.filename) || e.attrs?.isSymlink) continue;
        const r = rel ? `${rel}/${e.filename}` : e.filename;
        if (e.attrs?.isDir) { if (depth < maxDepth) queue.push([r, depth + 1]); }
        else if (e.attrs?.isFile) out.push(r);
        if (out.length >= maxFiles) return { files: out, complete: false };
      }
    }
    return { files: out, complete: !queue.length };
  }
  const readText = async (c, root, rel) => { const { full } = await resolveSafe(c, root, rel); if (!READABLE_EXT.test(full)) throw new SandboxError("Dateityp nicht lesbar."); return Buffer.from(await c.readFile(full)).toString("utf8"); };

  // Atomarer Austausch: Temp im selben Verzeichnis → Rechte → Inhalt prüfen → posix-rename → Ergebnis prüfen.
  async function atomicWrite(c, root, rel, text, mode) {
    const { full } = await resolveSafe(c, root, rel, { forWrite: true });
    const tmp = P.join(P.dirname(full), `.${P.basename(full)}.jarvis-${crypto.randomBytes(6).toString("hex")}.tmp`);
    sandboxPath(root, tmp);
    await c.writeFile(tmp, Buffer.from(text, "utf8"), { mode: mode != null ? mode & 0o777 : undefined });
    try {
      if (mode != null) {
        let st = await c.stat(tmp);
        if ((st.mode & 0o777) !== (mode & 0o777)) { await c.chmod(tmp, mode & 0o777); st = await c.stat(tmp); }
        if ((st.mode & 0o777) !== (mode & 0o777)) throw new Error("Dateirechte der Temp-Datei weichen ab.");
      }
      if (sha256(Buffer.from(await c.readFile(tmp)).toString("utf8")) !== sha256(text)) throw new Error("Temp-Datei weicht vom Patch ab.");
      await c.rename(tmp, full);
    } catch (e) { try { await c.unlink(tmp); } catch {} throw e; }
    const after = sha256(Buffer.from(await c.readFile(full)).toString("utf8"));
    if (after !== sha256(text)) throw new Error("Datei nach dem Austausch weicht ab.");
    return after;
  }

  async function restore(c, root, bk, ids) {
    let ok = true;
    for (const id of [...ids].reverse()) {
      const e = bk.entries().find((x) => x.backup_id === id);
      if (!e || e.object_type !== "file") { ok = false; continue; }
      const cur = sha256(await readText(c, root, e.object_id));
      if (cur === e.original_hash) { bk.update(id, { status: "restored" }); continue; }
      if (cur !== e.after_hash) { ok = false; continue; } // fremde Änderung → nie überschreiben
      const h = await atomicWrite(c, root, e.object_id, bk.content(e), e.mode);
      if (h === e.original_hash) bk.update(id, { status: "restored" }); else ok = false;
    }
    return ok;
  }

  return {
    stack: connector,
    detectCapabilities: () => ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK", "HEALTH_CHECK"],
    // Für den SSH-Adapter: dieselbe Sandbox/Schreibschicht.
    _internals: { listTree, readText, atomicWrite, withClient, rootOf },

    async checkAccess(order, cred) {
      if (!cred?.host || !cred?.username || (!cred.password && !cred.private_key)) return { ok: false, reason: "no_credentials" };
      if (String(cred.username).trim().toLowerCase() === "root") return { ok: false, reason: "root_login", blocked_state: "BLOCKED_UNSAFE_ACCESS" };
      const v = validateRemoteRoot(cred.remote_root);
      if (!v.ok) return { ok: false, reason: v.reason, ...(v.unsafe ? { blocked_state: "BLOCKED_UNSAFE_ACCESS" } : {}) };
      if (!cred.host_key_sha256) return { ok: false, reason: "host_key_missing" };
      return withClient(cred, async (c) => {
        if (await c.realpath(v.root) !== v.root) return { ok: false, reason: "remote_root_symlink", blocked_state: "BLOCKED_UNSAFE_ACCESS" };
        const top = await c.readdir(v.root);
        if (!top.some((e) => /^index\.html?$/i.test(e.filename) && e.attrs?.isFile)) return { ok: false, reason: "no_webroot_index" };
        const caps = ["READ_FILES", "HEALTH_CHECK"];
        // Schreib-/Rename-Probe nur mit Temp-Dateien im Webroot (keine Inhaltsänderung), danach entfernt.
        const id = crypto.randomBytes(6).toString("hex");
        const a = P.join(v.root, `.jarvis-probe-${id}.tmp`), b = P.join(v.root, `.jarvis-probe-${id}-b.tmp`);
        try {
          await c.writeFile(a, Buffer.from("a")); await c.writeFile(b, Buffer.from("b"));
          caps.push("WRITE_FILES");
          try { await c.rename(a, b); if (Buffer.from(await c.readFile(b)).toString() === "a") caps.push("ATOMIC_REPLACE"); } catch {}
        } catch {} finally { for (const f of [a, b]) { try { await c.unlink(f); } catch {} } }
        try { backups(order).verifyWritable(); caps.push("BACKUP"); } catch {}
        if (caps.includes("WRITE_FILES") && caps.includes("ATOMIC_REPLACE") && caps.includes("BACKUP")) caps.push("ROLLBACK");
        if (!caps.includes("WRITE_FILES")) return { ok: false, reason: "read_only", capabilities: caps };
        return { ok: true, connector, capabilities: caps };
      });
    },

    async backup(order, cred) {
      const root = rootOf(cred);
      backups(order).verifyWritable();
      const manifest = await withClient(cred, async (c) => (await listTree(c, root)).files.sort().join("\n"));
      return { production_ref: `${connector}:${sha256(manifest).slice(0, 16)}`, backup_ref: "local:object-backup", rollback_point: "per-file-original" };
    },

    async locate(issue, order, cred) {
      const spec = fixSpecFor(issue?.type);
      if (!spec || !spec.families.includes("files")) return null;
      const root = rootOf(cred);
      return withClient(cred, async (c) => {
        // Exakte CSS-Korrektur: nur mit belegter Datei + exaktem Ausschnitt (genau einmal vorhanden).
        if (spec.fix === "css_exact") {
          const cf = issue.css_fix;
          if (!cf?.file || !/\.css$/i.test(cf.file) || !cf.from || typeof cf.to !== "string") return null;
          const text = await readText(c, root, cf.file).catch(() => null);
          if (text == null || !patchExact(text, cf).ok || isProtectedText(cf.file)) return null;
          return { family: "files", fix_type: spec.fix, css: { from: cf.from, to: cf.to }, files: [{ path: sandboxPath(root, cf.file).slice(root.length + 1), before_hash: sha256(text) }],
            required_capabilities: requiredCapabilities("files"), risk: "niedrig", target: cf.file, cause: `Belegte CSS-Ursache in ${cf.file}.`, planned_change: "Exakt belegter CSS-Ausschnitt wird ersetzt (nur diese Stelle)" };
        }
        let broken; try { broken = new URL(issue.url); } catch { return null; }
        if (normDomain(broken.hostname) !== normDomain(order.domain)) return null;
        const brokenPath = broken.pathname;
        if (!brokenPath || brokenPath === "/" || isProtectedText(brokenPath)) return null;
        const tree = await listTree(c, root);
        if (!tree.complete) return null; // Baum nicht vollständig gelesen → Eindeutigkeit nicht belegbar
        const replacement = spec.attr === "src" ? uniqueImageReplacement(brokenPath, tree.files) : uniqueReplacement(brokenPath, tree.files);
        if (!replacement || isProtectedText(replacement)) return null;
        const live = await liveTarget(fetchFn, `https://${normDomain(order.domain)}${replacement}`, order.domain).catch(() => null);
        if (!live || live.status >= 400) return null;
        const html = tree.files.filter((f) => /\.html?$/i.test(f));
        if (html.length > maxScan) return null; // zu gross für einen belegbaren Minimal-Fix
        const hits = [];
        for (const f of html) {
          const text = await readText(c, root, f).catch(() => null);
          if (text == null) return null;
          const p = patchReference(text, { attr: spec.attr, brokenPath, fullUrl: issue.url, replacement, domain: order.domain });
          if (p.reason === "not_found") continue;
          if (!p.ok || isProtectedText(f)) return null;
          hits.push({ path: f, before_hash: sha256(text), occurrences: p.count });
        }
        if (!hits.length || hits.length > MAX_FILES_PER_FIX) return null;
        const where = hits.map((h) => h.path).join(", ");
        return { family: "files", fix_type: spec.fix, attr: spec.attr, brokenPath, fullUrl: issue.url, replacement, files: hits,
          required_capabilities: requiredCapabilities("files"), risk: "niedrig", target: where,
          cause: `${where} verweist auf ${brokenPath} (existiert nicht); ${replacement} existiert genau einmal.`,
          planned_change: `${spec.attr} ${brokenPath} → ${replacement} (nur dieser Verweis)` };
      });
    },

    async applyFix(issue, location, order, cred) {
      if (location?.family !== "files" || !ISSUE_FIX_MATRIX[issue?.type] || !Array.isArray(location.files) || !location.files.length || location.files.length > MAX_FILES_PER_FIX) return { ok: false, reason: "invalid_location" };
      const root = rootOf(cred);
      try {
        const live = await liveTarget(fetchFn, order.website || `https://${order.domain}/`, order.domain);
        assertDomainBinding(order, { liveDomain: new URL(live.final_url).hostname });
      } catch (e) { if (e.code === "DOMAIN_MISMATCH") return { ok: false, domain_mismatch: true, reason: "domain_mismatch" }; throw e; }
      const bk = backups(order);
      return withClient(cred, async (c) => {
        const done = [];
        try {
          for (const f of location.files) {
            const { full, st } = await resolveSafe(c, root, f.path, { forWrite: true });
            if (!st?.isFile) throw new SandboxError("Ziel ist keine reguläre Datei.");
            const text = Buffer.from(await c.readFile(full)).toString("utf8");
            if (sha256(text) !== f.before_hash) throw new Error("Datei wurde seit dem Plan verändert – kein Write.");
            const p = location.fix_type === "css_exact" ? patchExact(text, location.css || {})
              : patchReference(text, { attr: location.attr, brokenPath: location.brokenPath, fullUrl: location.fullUrl, replacement: location.replacement, domain: order.domain });
            if (!p.ok) throw new Error(`Stelle nicht exakt patchbar (${p.reason}).`);
            const entry = bk.add({ object_type: "file", object_id: f.path, original_hash: f.before_hash, original_content: text, mode: st.mode ?? null, modified_at: st.mtime ? new Date(Number(st.mtime) * 1000).toISOString() : null });
            const after = await atomicWrite(c, root, f.path, p.text, st.mode ?? null);
            bk.update(entry.backup_id, { after_hash: after, status: "applied" });
            done.push(entry.backup_id);
          }
        } catch (e) {
          if (done.length) await restore(c, root, bk, done).catch(() => {});
          throw e;
        }
        const last = bk.entries().find((x) => x.backup_id === done[done.length - 1]);
        return { ok: true, change_ref: `${connector}:${location.files.length}-file(s)`, before_hash: location.files[0].before_hash, after_hash: last?.after_hash || null };
      });
    },

    async validate(issue, order, cred) {
      const loc = issue?.location;
      if (!loc || loc.family !== "files") return { build_ok: false };
      const root = rootOf(cred);
      const applied = backups(order).entries().filter((e) => e.status === "applied" && e.object_type === "file");
      const filesOk = await withClient(cred, async (c) => {
        for (const f of loc.files) {
          const e = applied.find((x) => x.object_id === f.path);
          if (!e || sha256(await readText(c, root, f.path)) !== e.after_hash) return false;
        }
        return true;
      });
      if (!filesOk) return { build_ok: false };
      if (loc.fix_type === "css_exact") return { build_ok: true };
      const live = await liveTarget(fetchFn, issue.page || order.website, order.domain);
      if (live.status >= 400) return { build_ok: false };
      const still = patchReference(live.html, { attr: loc.attr, brokenPath: loc.brokenPath, fullUrl: loc.fullUrl, replacement: loc.replacement, domain: order.domain });
      return { build_ok: still.reason === "not_found" };
    },

    async deployProduction(order) {
      const live = await liveTarget(fetchFn, order.website || `https://${order.domain}/`, order.domain);
      return live.status < 400 ? { ok: true, deploy_ref: `live:${connector}` } : { ok: false, reason: `health_${live.status}` };
    },

    async rollback(order, _backup, cred) {
      const root = rootOf(cred);
      const bk = backups(order);
      const ids = bk.entries().filter((e) => e.status === "applied" && e.object_type === "file").map((e) => e.backup_id);
      if (!ids.length) return { ok: true };
      return { ok: await withClient(cred, (c) => restore(c, root, bk, ids)) };
    },

    async cleanup() { return { ok: true, revoked_required: true }; },
  };
}
