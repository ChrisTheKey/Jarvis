// Lokaler Dateizugriff des Geräte-Agenten (TF-074) – NUR innerhalb ausdrücklich konfigurierter Jarvis-Arbeitsverzeichnisse.
//
// Die Cloud schickt nie Pfade (Fähigkeiten sind parameterlos, device-core ARBITRARY_FIELDS). Dieser Wächter ist die zweite Linie für die
// festen Dateien der Fähigkeiten (z. B. PROJECT_STATE.md) und blockiert: ../-Traversal, absolute Pfade, Laufwerksbuchstaben, UNC/Netzwerk
// (\\server\share, //server), \\?\-Präfixe, NTFS-Streams (":"), Symlink-/Junction-Ausbruch (realpath muss im Wurzelverzeichnis bleiben)
// und sensible Orte (Secrets, .env, .git, SSH-Schlüssel, Windows, AppData/Browser-Profile, Anmeldedaten, persönliche Notizen, Kundendaten).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Chris' aktueller Rechner: das Jarvis-Repository ist der Jarvis-Arbeitsbereich (PROJECT_STATE.md, README). JARVIS_WORKSPACE_DIRS
// (durch ";" bzw. ":" getrennt) überschreibt das ausdrücklich – nie automatisch das Benutzerprofil oder "Dokumente".
export function workspaceRoots(env = process.env) {
  const v = env.JARVIS_WORKSPACE_DIRS;
  return v ? v.split(path.delimiter).map((x) => x.trim()).filter(Boolean) : [ROOT];
}

// Feste Dateien, die Fähigkeiten lesen dürfen (Schlüssel → relativer Pfad). Keine anderen.
export const WORKSPACE_FILES = Object.freeze({ project_state: "PROJECT_STATE.md" });

// Segmente (case-insensitiv), die nie gelesen werden – auch innerhalb des Arbeitsbereichs.
const SENSITIVE_SEGMENTS = new Set([".secrets", ".git", ".ssh", ".gnupg", ".aws", ".azure", ".config", ".session", ".playwright-mcp", "node_modules",
  "data", "exports", "memory", "deploy", "appdata", "credentials", "microsoft", "google", "mozilla", "chrome", "edge", "user data", "profiles"]);
const SENSITIVE_NAME = /^(\.env(\..*)?|.*token.*\.json|.*secret.*|.*credential.*|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|known_hosts|authorized_keys|.*\.(pem|key|pfx|p12|kdbx|dpapi|enc))$/i;
// Absolute Orte, die nie Wurzel oder Ziel sein dürfen (nach realpath).
const SENSITIVE_ABS = [/^[a-z]:\\windows(\\|$)/i, /\\appdata(\\(?!local\\temp(\\|$))|$)/i, /[\\/]\.ssh([\\/]|$)/i, /\\microsoft\\(credentials|protect|vault)(\\|$)/i,
  /\\(google\\chrome|microsoft\\edge|mozilla\\firefox)\\/i, /^\/(etc|root|proc|sys|dev)(\/|$)/, /^[a-z]:\\programdata(\\|$)/i];

const fail = (code) => ({ ok: false, code });
const isInside = (root, p) => { const r = path.relative(root, p); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); };

export function resolveWorkspacePath(rel, { roots = workspaceRoots(), realpath = fs.realpathSync.native } = {}) {
  if (typeof rel !== "string" || !rel || rel.length > 200 || /[\u0000-\u001f]/.test(rel)) return fail("PATH_INVALID");
  if (/^[\\/]{2}/.test(rel) || /^\\\\\?\\/.test(rel)) return fail("PATH_UNC_BLOCKED");
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel.startsWith("~")) return fail("PATH_ABSOLUTE_BLOCKED");
  if (rel.includes(":")) return fail("PATH_INVALID"); // NTFS-Streams / Laufwerke
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return fail("PATH_INVALID");
  if (segs.some((s) => s === ".." || s === "." || /^\.+$/.test(s.trim()) || s !== s.trim())) return fail("PATH_TRAVERSAL_BLOCKED");
  if (segs.some((s) => SENSITIVE_SEGMENTS.has(s.toLowerCase())) || SENSITIVE_NAME.test(segs.at(-1))) return fail("PATH_SENSITIVE_BLOCKED");
  for (const root of roots) {
    let realRoot;
    try { realRoot = realpath(root); } catch { continue; }
    if (SENSITIVE_ABS.some((re) => re.test(realRoot))) return fail("ROOT_SENSITIVE_BLOCKED");
    const candidate = path.join(realRoot, ...segs);
    if (!isInside(realRoot, candidate)) return fail("PATH_TRAVERSAL_BLOCKED");
    let real;
    try { real = realpath(candidate); } catch { continue; }
    // Symlink/Junction: das Ziel muss im selben Arbeitsbereich liegen und darf kein sensibler Ort sein.
    if (!isInside(realRoot, real)) return fail("PATH_ESCAPE_BLOCKED");
    if (SENSITIVE_ABS.some((re) => re.test(real))) return fail("PATH_SENSITIVE_BLOCKED");
    const relReal = path.relative(realRoot, real).split(/[\\/]+/).filter(Boolean);
    if (relReal.some((s) => SENSITIVE_SEGMENTS.has(s.toLowerCase())) || SENSITIVE_NAME.test(relReal.at(-1) || "")) return fail("PATH_SENSITIVE_BLOCKED");
    return { ok: true, path: real, root: realRoot };
  }
  return fail("PATH_NOT_FOUND");
}

// Liest eine feste Arbeitsbereich-Datei (max. 2 MB). Gibt nie den Pfad an die Cloud zurück.
export function readWorkspaceFile(key, opts = {}) {
  if (!Object.hasOwn(WORKSPACE_FILES, key)) return fail("FILE_NOT_ALLOWED");
  const r = resolveWorkspacePath(WORKSPACE_FILES[key], opts);
  if (!r.ok) return r;
  const st = fs.statSync(r.path);
  if (!st.isFile() || st.size > 2_000_000) return fail("FILE_NOT_ALLOWED");
  return { ok: true, text: fs.readFileSync(r.path, "utf8"), bytes: st.size };
}

// Nur Kopfdaten des Projektstands – kein Dateiinhalt in die Cloud.
export function projectStatusSummary(text) {
  const updated = /Letzte Aktualisierung:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})(?:\s*\((TF-\d{3})\))?/.exec(text || "");
  const tf = /^## (TF-\d{3})/m.exec(text || "");
  return { last_update: updated?.[1] || null, current_tf: updated?.[2] || tf?.[1] || null };
}
