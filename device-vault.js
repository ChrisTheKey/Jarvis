// Lokaler Geräte-Tresor (TF-074) – Geräte-Credential und Geräte-Identität verschlüsselt auf dem eigenen Rechner.
//
// Aufbau (Verzeichnis .secrets/device/, gitignored):
//   vault.key        Schlüssel (32 Byte) – Windows: mit DPAPI (CurrentUser) geschützt, nur dieses Windows-Konto kann ihn entschlüsseln.
//                    Andere Plattformen: Datei mit Rechten 600 (Einschränkung, dokumentiert in PROJECT_STATE) – kein OS-Tresor angebunden.
//   <name>.enc       AES-256-GCM (Name als AAD), z. B. credential.enc, identity.enc
// TF-073-Klartextdateien (credential.json, identity.json) werden beim ersten Lesen verschlüsselt übernommen und gelöscht.
// Nie: Klartext im Repository, in .env, in Logs, in PROJECT_STATE oder im Browser-localStorage. Kein Secret als Prozess-Argument
// (DPAPI-Daten gehen per stdin an PowerShell, Ergebnis per stdout).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const PROTECTIONS = Object.freeze(["dpapi", "file"]);
// JARVIS_DEVICE_KEY_PROTECTION=dpapi|file (Tests: file). Standard: Windows → DPAPI, sonst Datei.
export function defaultProtection(platform = process.platform) {
  const v = process.env.JARVIS_DEVICE_KEY_PROTECTION;
  if (PROTECTIONS.includes(v)) return v;
  return platform === "win32" ? "dpapi" : "file";
}

const DPAPI_PS = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Security
$raw = ([Console]::In.ReadToEnd() -replace '[^A-Za-z0-9+/=]', '')
$data = [Convert]::FromBase64String($raw)
$ent = [Text.Encoding]::UTF8.GetBytes('jarvis-device-vault-v1')
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($env:JARVIS_DPAPI_OP -eq 'unprotect') { $out = [System.Security.Cryptography.ProtectedData]::Unprotect($data, $ent, $scope) } else { $out = [System.Security.Cryptography.ProtectedData]::Protect($data, $ent, $scope) }
[Console]::Out.Write([Convert]::ToBase64String($out))`;
const DPAPI_ENC = Buffer.from(DPAPI_PS, "utf16le").toString("base64");

// Windows DPAPI über die mitgelieferte Windows PowerShell (keine native Abhängigkeit). Fehler → Ausnahme ohne Dateninhalt.
export function dpapi(op, buf, { exe = "powershell.exe", timeoutMs = 30_000 } = {}) {
  const r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", DPAPI_ENC],
    { input: buf.toString("base64"), encoding: "utf8", windowsHide: true, timeout: timeoutMs, env: { ...process.env, JARVIS_DPAPI_OP: op } });
  if (r.status !== 0 || !r.stdout) throw Object.assign(new Error(`DPAPI ${op} fehlgeschlagen`), { code: "DPAPI_FAILED" });
  return Buffer.from(r.stdout.trim(), "base64");
}

const keyCache = new Map(); // je Verzeichnis: entschlüsselter Schlüssel nur im Prozessspeicher
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writePrivate(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === "string" ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

export function createVault({ dir, protection = defaultProtection(), protector = dpapi } = {}) {
  const keyFile = path.join(dir, "vault.key");
  function key() {
    if (keyCache.has(keyFile)) return keyCache.get(keyFile);
    let k, stored = readJson(keyFile);
    if (stored?.protection === "dpapi") k = protector("unprotect", Buffer.from(stored.blob, "base64"));
    else if (stored?.protection === "file") k = Buffer.from(stored.key, "base64");
    else {
      k = crypto.randomBytes(32);
      stored = protection === "dpapi" ? { v: 1, protection: "dpapi", scope: "CurrentUser", blob: protector("protect", k).toString("base64") } : { v: 1, protection: "file", key: k.toString("base64") };
      writePrivate(keyFile, stored);
    }
    if (k.length !== 32) throw Object.assign(new Error("Tresor-Schlüssel ungültig"), { code: "VAULT_KEY_INVALID" });
    keyCache.set(keyFile, k);
    return k;
  }
  const encFile = (name) => path.join(dir, `${name}.enc`);
  function write(name, obj) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key(), iv);
    c.setAAD(Buffer.from(name));
    const ct = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
    writePrivate(encFile(name), { v: 1, alg: "A256GCM", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
  }
  function read(name) {
    const e = readJson(encFile(name));
    if (e?.ct) {
      const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(e.iv, "base64"));
      d.setAAD(Buffer.from(name)); d.setAuthTag(Buffer.from(e.tag, "base64"));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8"));
    }
    // TF-073-Klartext übernehmen: verschlüsselt schreiben, Klartext löschen.
    const legacy = path.join(dir, `${name}.json`), plain = readJson(legacy);
    if (plain) { write(name, plain); fs.rmSync(legacy, { force: true }); return plain; }
    return null;
  }
  const remove = (name) => { fs.rmSync(encFile(name), { force: true }); fs.rmSync(path.join(dir, `${name}.json`), { force: true }); };
  const protectionInUse = () => readJson(keyFile)?.protection || null;
  const exists = (name) => fs.existsSync(encFile(name)) || fs.existsSync(path.join(dir, `${name}.json`));
  return { read, write, remove, exists, protectionInUse, dir };
}
export const forgetVaultKeys = () => keyCache.clear();

// Für den Zustandsabgleich (local-state.js): Geräte-Header nur, wenn ein Credential vorliegt. Liefert nie das Secret an Aufrufer
// ausser als Header-Wert für genau diese ausgehende Anfrage.
export function loadDeviceAuth(dir, { protection, protector } = {}) {
  const v = createVault({ dir, ...(protection ? { protection } : {}), ...(protector ? { protector } : {}) });
  if (!v.exists("credential")) return null;
  const c = v.read("credential"), id = v.read("identity");
  if (!c?.credential || !id?.key) return null;
  const fp = crypto.createHash("sha256").update(id.key).digest("hex");
  return { device_id: c.device_id, owner_user_id: c.owner_user_id, device_type: c.device_type || null, cloud: c.cloud,
    headers: { "x-jarvis-device": c.credential, "x-jarvis-device-fp": fp, "x-jarvis-device-cv": String(c.credential_version || 1) } };
}
