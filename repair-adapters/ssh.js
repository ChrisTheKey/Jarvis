// SSH/SFTP-Adapter für CHECK & REPARATUR CHF 480 (TF-042). KEINE freie Shell: es gibt nur typisierte Funktionen
// (statFile, readFile, hashFile, listDirectory, writeTempFile, atomicRename, runConfiguredBuildCheck, runConfiguredHealthCheck).
// Dateiänderungen laufen AUSSCHLIESSLICH über die SFTP-Schicht (repair-adapters/sftp.js: Sandbox, Backup, atomarer Write);
// SSH-Ausführung gibt es nur für von Chris im Zugangsprofil konfigurierte Build-/Health-Checks (IDs), deren Argumente gegen
// eine harte Allowlist geprüft werden. Nie wird eine Modellantwort, ein Befund oder Kundentext als Befehl ausgeführt.
//
//   - Login als root → BLOCKED_UNSAFE_ACCESS; nie sudo/su, nie Privilege Escalation.
//   - Erlaubte Programme: npm (nur `--prefix <pfad-in-root> run <script>` bzw. `test`), php (nur `-l <datei.php in root>`),
//     node (nur `--check <datei.js in root>`). Jedes Argument: nur [A-Za-z0-9_.,/:=@%+-], keine Shell-Metazeichen
//     (; && || | ` $() > < Zeilenumbruch Leerzeichen Quotes Wildcards), kein ../, nichts ausserhalb von remote_root.
import { WORKER_DIR } from "../mail-worker.js";
import { sftpAdapter, ssh2Session, sandboxPath, validateRemoteRoot, SandboxError, FORBIDDEN_SEGMENT_RE, assertHostKeyPinned } from "./sftp.js";
import { sha256 } from "./common.js";

export const SAFE_ARG_RE = /^[A-Za-z0-9_.,/:=@%+-]{1,200}$/;
export const SHELL_META_RE = /[;&|`$()<>\n\r\t "'\\*?~!{}[\]#]/;
export const FORBIDDEN_BINARIES = Object.freeze(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish", "powershell", "pwsh", "cmd", "eval", "exec", "sudo", "su", "doas",
  "rm", "rmdir", "dd", "mkfs", "curl", "wget", "nc", "ncat", "socat", "ssh", "scp", "apt", "apt-get", "yum", "dnf", "apk", "pip", "gem", "passwd", "useradd",
  "userdel", "usermod", "groupadd", "chpasswd", "iptables", "ufw", "nft", "docker", "podman", "systemctl", "service", "chmod", "chown", "crontab", "kill",
  "pkill", "reboot", "shutdown", "mysql", "psql", "env", "xargs", "find", "perl", "python", "python3", "ruby", "npx"]);
export const ALLOWED_BINARIES = Object.freeze(["npm", "php", "node"]);
const ID_RE = /^[a-z0-9_-]{1,40}$/;

export class CommandRejected extends Error { constructor(msg) { super(msg); this.code = "COMMAND_REJECTED"; } }

// Verteidigung in der Tiefe: wird vor JEDER Ausführung erneut geprüft (auch im Transport).
export function assertSafeArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 8) throw new CommandRejected("Befehl muss ein Argument-Array sein.");
  for (const a of argv) {
    if (typeof a !== "string" || SHELL_META_RE.test(a) || !SAFE_ARG_RE.test(a)) throw new CommandRejected("Argument mit unzulässigen Zeichen verweigert.");
    if (a.split("/").includes("..")) throw new CommandRejected("Pfad-Traversal im Argument verweigert.");
  }
  const bin = argv[0];
  if (FORBIDDEN_BINARIES.includes(bin.split("/").pop()) || !ALLOWED_BINARIES.includes(bin)) throw new CommandRejected(`Programm "${bin}" nicht erlaubt.`);
  return argv;
}

// Konfigurierter Check (aus dem Zugangsprofil von Chris) → validiertes argv. Nichts wird erfunden.
export function checkArgv(check, root) {
  if (!check || typeof check !== "object" || !ALLOWED_BINARIES.includes(check.binary) || !Array.isArray(check.args)) throw new CommandRejected("Check nicht korrekt konfiguriert.");
  const argv = assertSafeArgv([check.binary, ...check.args]);
  const inRoot = (p) => { const full = sandboxPath(root, p); return full; };
  const a = argv.slice(1);
  if (check.binary === "npm") {
    if (a[0] !== "--prefix" || !a[1] || !(a[2] === "run" && a[3] && /^[\w:-]{1,40}$/.test(a[3]) && a.length === 4 || a[2] === "test" && a.length === 3)) throw new CommandRejected("npm nur als --prefix <pfad> run <script> | test.");
    return ["npm", "--prefix", inRoot(a[1]), ...a.slice(2)];
  }
  if (check.binary === "php") {
    if (a[0] !== "-l" || a.length !== 2 || !/\.php$/i.test(a[1])) throw new CommandRejected("php nur als -l <datei.php>.");
    return ["php", "-l", inRoot(a[1])];
  }
  if (a[0] !== "--check" || a.length !== 2 || !/\.m?js$/i.test(a[1])) throw new CommandRejected("node nur als --check <datei.js>.");
  return ["node", "--check", inRoot(a[1])];
}

export function validateChecks(checks = {}, root) {
  const out = { build: {}, health: {} };
  for (const kind of ["build", "health"]) for (const [id, c] of Object.entries(checks?.[kind] || {})) {
    if (!ID_RE.test(id)) throw new CommandRejected("Check-ID ungültig.");
    checkArgv(c, root); // wirft bei jeder Abweichung
    out[kind][id] = { binary: c.binary, args: [...c.args] };
  }
  return out;
}

// Transport: SSH-Sitzung mit SFTP-Client + argv-Ausführung (nur nach assertSafeArgv; Ergebnis nur Exit-Code).
export const ssh2Connector = (opts = {}) => async (cred) => {
  const s = await ssh2Session(cred, opts);
  return {
    sftp: s.client,
    host_key: s.host_key, // TF-044: verifizierter Fingerprint + Algorithmus dieser Sitzung (Pinning)
    exec: (argv, { timeoutMs = 10 * 60_000 } = {}) => new Promise((resolve, reject) => {
      try { assertSafeArgv(argv); } catch (e) { reject(e); return; }
      // Alle Argumente sind metazeichenfrei geprüft – das Leerzeichen-Join erzeugt keine Shell-Semantik.
      s.conn.exec(argv.join(" "), (err, stream) => {
        if (err) { reject(new Error("SSH-Ausführung fehlgeschlagen.")); return; }
        const t = setTimeout(() => { try { stream.close(); } catch {} reject(new Error("Check: Zeitüberschreitung.")); }, timeoutMs);
        stream.on("data", () => {}); stream.stderr?.on("data", () => {});
        stream.on("close", (code) => { clearTimeout(t); resolve({ exit_code: Number(code) }); });
      });
    }),
    close: () => s.close(),
  };
};

export function sshAdapter({ dir = WORKER_DIR, connect = ssh2Connector(), fetchFn = globalThis.fetch } = {}) {
  // Dateien ausschliesslich über die SFTP-Schicht derselben SSH-Sitzung.
  const files = sftpAdapter({ dir, fetchFn, connector: "ssh+sftp", connect: async (cred) => {
    const s = await connect(cred);
    if (!s.sftp) { await s.close?.(); throw new Error("SFTP-Subsystem nicht verfügbar – keine Dateiänderung über SSH."); }
    return { ...s.sftp, close: () => s.close?.() };
  } });
  const { listTree, readText, atomicWrite, rootOf } = files._internals;
  const withSession = async (cred, fn) => { const s = await connect(cred); try { assertHostKeyPinned(s, cred); return await fn(s); } finally { try { await s.close?.(); } catch {} } };

  // Typisierte Operationen – die EINZIGE Schnittstelle zum Server. Kein exec(string), keine freie Shell.
  function typedOps(session, cred) {
    const root = rootOf(cred);
    const checks = validateChecks(cred.checks || {}, root);
    const sftp = session.sftp;
    if (!sftp) throw new Error("SFTP-Subsystem nicht verfügbar.");
    const run = async (kind, id) => {
      if (!ID_RE.test(String(id)) || !checks[kind][id]) throw new CommandRejected(`${kind}-Check "${id}" ist nicht konfiguriert.`);
      const argv = checkArgv(checks[kind][id], root);
      const r = await session.exec(argv);
      return { ok: r?.exit_code === 0, exit_code: r?.exit_code ?? null };
    };
    return Object.freeze({
      statFile: async (p) => { const full = sandboxPath(root, p); const st = await sftp.lstat(full); return { is_file: !!st?.isFile, is_dir: !!st?.isDir, size: st?.size ?? null }; },
      readFile: (p) => readText(sftp, root, p),
      hashFile: async (p) => sha256(await readText(sftp, root, p)),
      listDirectory: async (p = "") => { const full = p ? sandboxPath(root, p) : root; return (await sftp.readdir(full)).map((e) => e.filename).filter((n) => !FORBIDDEN_SEGMENT_RE.test(n)); },
      writeTempFile: async (p, data) => { const full = sandboxPath(root, p); if (!/\.jarvis-[0-9a-f]+\.tmp$/.test(full)) throw new SandboxError("Nur Jarvis-Temp-Dateien."); await sftp.writeFile(full, Buffer.from(String(data), "utf8")); return { ok: true }; },
      atomicRename: async (from, to) => { const a = sandboxPath(root, from), b = sandboxPath(root, to); if (!/\.jarvis-[0-9a-f]+\.tmp$/.test(a)) throw new SandboxError("Nur Jarvis-Temp-Dateien umbenennen."); await sftp.rename(a, b); return { ok: true }; },
      runConfiguredBuildCheck: (id) => run("build", id),
      runConfiguredHealthCheck: (id) => run("health", id),
      configured: { build: Object.keys(checks.build), health: Object.keys(checks.health) },
    });
  }

  return {
    stack: "ssh",
    detectCapabilities: () => ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK", "BUILD_TEST", "HEALTH_CHECK"],
    typedOps,
    _internals: { listTree, atomicWrite },

    async checkAccess(order, cred) {
      if (String(cred?.username || "").trim().toLowerCase() === "root") return { ok: false, reason: "root_login", blocked_state: "BLOCKED_UNSAFE_ACCESS" };
      const v = validateRemoteRoot(cred?.remote_root);
      if (!v.ok) return { ok: false, reason: v.reason, ...(v.unsafe ? { blocked_state: "BLOCKED_UNSAFE_ACCESS" } : {}) };
      try { validateChecks(cred.checks || {}, v.root); } catch { return { ok: false, reason: "checks_invalid", blocked_state: "BLOCKED_UNSAFE_ACCESS" }; }
      const r = await files.checkAccess(order, cred);
      if (!r.ok) return r;
      const caps = [...r.capabilities];
      if (Object.keys(cred.checks?.build || {}).length) caps.push("BUILD_TEST");
      return { ok: true, connector: "ssh+sftp", capabilities: [...new Set(caps)] };
    },
    backup: (order, cred) => files.backup(order, cred),
    locate: (issue, order, cred) => files.locate(issue, order, cred),
    applyFix: (issue, loc, order, cred) => files.applyFix(issue, loc, order, cred),

    // Validierung: SFTP-Prüfung (Hash + öffentliche Seite) und – falls konfiguriert – alle Build-Checks (Exit-Code 0).
    async validate(issue, order, cred) {
      const v = await files.validate(issue, order, cred);
      if (v.build_ok !== true) return v;
      const ids = Object.keys(cred.checks?.build || {});
      if (!ids.length) return v;
      return withSession(cred, async (s) => {
        const ops = typedOps(s, cred);
        for (const id of ids) if (!(await ops.runConfiguredBuildCheck(id)).ok) return { build_ok: false };
        return { build_ok: true };
      });
    },
    // Live: öffentliche Seite (gleiche Domain) + konfigurierte Health-Checks.
    async deployProduction(order, cred) {
      const d = await files.deployProduction(order, cred);
      if (d.ok !== true) return d;
      const ids = Object.keys(cred.checks?.health || {});
      if (!ids.length) return { ...d, deploy_ref: "live:ssh+sftp" };
      return withSession(cred, async (s) => {
        const ops = typedOps(s, cred);
        for (const id of ids) if (!(await ops.runConfiguredHealthCheck(id)).ok) return { ok: false, reason: "health_check_failed" };
        return { ok: true, deploy_ref: "live:ssh+sftp" };
      });
    },
    rollback: (order, backup, cred) => files.rollback(order, backup, cred),
    async cleanup() { return { ok: true, revoked_required: true }; },
  };
}
