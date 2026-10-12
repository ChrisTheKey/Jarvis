// SSH-Host-Key-Verifier für CHECK & REPARATUR CHF 480 (TF-044). Löst die TF-043-Einschränkung «Kunde bestätigt den
// Fingerprint eines anderen Host-Key-Typs, als ssh2 automatisch aushandelt» – ohne einen einzigen Schlüssel blind zu akzeptieren.
//
//   - Nur moderne, sichere Host-Key-Algorithmen (SAFE_HOST_KEY_ALGORITHMS, Schnittmenge mit ssh2). NIE ssh-rsa (SHA-1) oder
//     ssh-dss – auch nicht als Rückfall (ssh2 hätte ssh-rsa sonst im Default).
//   - Discovery: je erlaubtem Algorithmus eine EIGENE Verbindung, die nur bis zur Host-Key-Prüfung läuft. hostVerifier lehnt
//     immer ab → keine Anmeldung, es werden weder Benutzername-Passwort noch Schlüssel übertragen.
//   - Match: genau EIN angebotener Schlüssel entspricht dem bestätigten Fingerprint → host_key_algorithm. rsa-sha2-512 und
//     rsa-sha2-256 sind derselbe RSA-Schlüssel (gleicher Blob) und zählen als EIN Treffer; gepinnt wird die bevorzugte Variante.
//     Mehrere verschiedene Schlüssel → fail closed (MANUAL_REVIEW_REQUIRED). Kein Treffer → MANUAL_REVIEW_REQUIRED.
//   - Login: exakt dieser Algorithmus (serverHostKey = [alg]) + Fingerprint + Schlüsseltyp als harte Bedingung. Abweichung →
//     HostKeyError HOST_KEY_CHANGED (Workflow: BLOCKED_HOST_KEY_CHANGED, 0 Write).
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { normFingerprint } from "./common.js";

// Reihenfolge = Präferenz (erster Treffer wird gepinnt).
export const MODERN_HOST_KEY_ALGORITHMS = Object.freeze(["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256"]);
// Nie automatisch aktivieren.
export const LEGACY_HOST_KEY_ALGORITHMS = Object.freeze(["ssh-rsa", "ssh-dss"]);
// Signatur-Algorithmus → Schlüsseltyp im Blob (RSA-SHA2 nutzt einen «ssh-rsa»-Schlüssel, aber SHA-2-Signaturen).
export const KEY_TYPE_OF = Object.freeze({ "ssh-ed25519": "ssh-ed25519", "ecdsa-sha2-nistp256": "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384": "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521": "ecdsa-sha2-nistp521", "rsa-sha2-512": "ssh-rsa", "rsa-sha2-256": "ssh-rsa" });

const require = createRequire(import.meta.url);
let supported = null;
// Nur Algorithmen, die ssh2 tatsächlich unterstützt (Schnittmenge, Reihenfolge der Präferenz).
export function safeHostKeyAlgorithms() {
  if (!supported) {
    let lib = [];
    try { lib = require("ssh2/lib/protocol/constants.js").SUPPORTED_SERVER_HOST_KEY || []; } catch {}
    supported = Object.freeze(MODERN_HOST_KEY_ALGORITHMS.filter((a) => lib.includes(a)));
  }
  return supported;
}
export const isSafeHostKeyAlgorithm = (a) => typeof a === "string" && MODERN_HOST_KEY_ALGORITHMS.includes(a) && !LEGACY_HOST_KEY_ALGORITHMS.includes(a);
export function hostKeyVerifierStatus() {
  const algorithms = safeHostKeyAlgorithms();
  return { status: algorithms.length ? "ACTIVE" : "UNAVAILABLE", algorithms: [...algorithms], legacy_allowed: false };
}

export class HostKeyError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

// Fingerprint (ssh-keygen -lf) und Schlüsseltyp aus dem Wire-Blob des Host-Keys.
export const fingerprintOf = (blob) => "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
export function keyTypeOf(blob) {
  try { const n = blob.readUInt32BE(0); return n > 0 && n < 64 ? blob.subarray(4, 4 + n).toString("ascii") : null; } catch { return null; }
}

// Eine Verbindung NUR bis zur Host-Key-Prüfung, genau EIN erlaubter Algorithmus. Nie Zugangsdaten (es gibt keine im Aufruf).
// Ergebnis { algorithm, fingerprint, key_type } – oder HostKeyError: ALG_NOT_OFFERED | UNREACHABLE | KEY_TYPE_MISMATCH.
export async function ssh2ProbeHostKeyAlgorithm({ host, port = 22, algorithm, timeoutMs = 15_000 } = {}) {
  if (!safeHostKeyAlgorithms().includes(algorithm)) throw new HostKeyError("ALGORITHM_NOT_ALLOWED", "Host-Key-Algorithmus nicht erlaubt.");
  const mod = await import("ssh2");
  const Client = mod.Client || mod.default?.Client;
  const conn = new Client();
  return new Promise((resolve, reject) => {
    let seen = null, settled = false;
    const done = (fn) => { if (settled) return; settled = true; clearTimeout(t); try { conn.end(); } catch {} fn(); };
    const finish = (e) => done(() => {
      if (seen) return seen.key_type === KEY_TYPE_OF[algorithm] ? resolve(seen) : reject(new HostKeyError("KEY_TYPE_MISMATCH", "Schlüsseltyp passt nicht zum Algorithmus."));
      reject(/no matching host key/i.test(String(e?.message)) ? new HostKeyError("ALG_NOT_OFFERED", "Algorithmus vom Server nicht angeboten.") : new HostKeyError("UNREACHABLE", "Host-Key nicht ermittelbar."));
    });
    const t = setTimeout(() => finish(new Error("timeout")), timeoutMs + 1000);
    conn.on("error", finish);
    conn.on("close", () => finish(null));
    conn.on("ready", () => done(() => reject(new HostKeyError("UNEXPECTED_LOGIN", "Unerwartete Anmeldung – abgebrochen."))));
    conn.connect({ host, port: Number(port) || 22, username: "jarvis-hostkey-probe", readyTimeout: timeoutMs, tryKeyboard: false, agent: undefined,
      algorithms: { serverHostKey: [algorithm] },
      hostVerifier: (key) => { seen = { algorithm, fingerprint: fingerprintOf(key), key_type: keyTypeOf(key) }; return false; } });
  });
}
ssh2ProbeHostKeyAlgorithm.algorithmAware = true;

// Alle erlaubten Algorithmen nacheinander prüfen (read-only, ohne Login). Höchstens 5 Pre-Auth-Verbindungen: rsa-sha2-256 wird
// nur geprüft, wenn rsa-sha2-512 fehlt (derselbe RSA-Schlüssel). Wichtig für OpenSSH ≥ 9.8 (PerSourcePenalties: viele
// Verbindungen ohne Anmeldung sperren die Quelle) – eine Discovery je Auftrag bleibt unter der Schwelle, danach nur gepinnte Logins.
//   ok:true  → keys (Präferenz-Reihenfolge)
//   ok:false → reason host_key_unavailable (nicht erreichbar) | host_key_legacy_only (erreichbar, aber kein sicherer Schlüssel)
export async function discoverHostKeys({ host, port = 22 } = {}, { probe = ssh2ProbeHostKeyAlgorithm, algorithms = safeHostKeyAlgorithms(), timeoutMs } = {}) {
  const keys = [], failures = [];
  for (const algorithm of algorithms) {
    if (algorithm === "rsa-sha2-256" && keys.some((k) => k.algorithm === "rsa-sha2-512")) continue;
    try {
      const r = await probe({ host, port, algorithm, ...(timeoutMs ? { timeoutMs } : {}) });
      const fingerprint = normFingerprint(r?.fingerprint);
      if (!fingerprint || r.algorithm !== algorithm) { failures.push("INVALID"); continue; }
      keys.push({ algorithm, fingerprint, key_type: r.key_type || null });
    } catch (e) {
      failures.push(e?.code || "UNREACHABLE");
      if (e?.code === "UNREACHABLE" && !keys.length && failures.every((c) => c === "UNREACHABLE")) break; // Server nicht erreichbar → nicht weiter klopfen
    }
  }
  if (keys.length) return { ok: true, keys };
  if (failures.length && failures.every((c) => c === "ALG_NOT_OFFERED")) return { ok: false, reason: "host_key_legacy_only", keys };
  return { ok: false, reason: "host_key_unavailable", keys };
}

// Bestätigten Fingerprint gegen die angebotenen Schlüssel prüfen. Gleicher Fingerprint = gleicher Schlüssel-Blob; mehrere
// verschiedene Schlüsseltypen mit demselben Fingerprint sind unmöglich – falls doch: fail closed.
export function matchHostKey(keys = [], confirmed) {
  const fp = normFingerprint(confirmed);
  if (!fp) return { ok: false, reason: "host_key_invalid" };
  const hits = keys.filter((k) => normFingerprint(k.fingerprint) === fp);
  if (!hits.length) return { ok: false, reason: "host_key_no_match" };
  const types = new Set(hits.map((k) => k.key_type || `?${k.algorithm}`));
  if (types.size > 1) return { ok: false, reason: "host_key_multiple_matches" };
  if (hits[0].algorithm != null && !isSafeHostKeyAlgorithm(hits[0].algorithm)) return { ok: false, reason: "host_key_legacy_only" };
  return { ok: true, fingerprint: fp, algorithm: hits[0].algorithm ?? null, key_type: hits[0].key_type ?? null };
}

// Login-Pinning: Optionen für ssh2.connect, die NUR den verifizierten Algorithmus zulassen und Fingerprint + Schlüsseltyp
// erzwingen. state.verified wird erst nach bestandener Prüfung gesetzt; state.changed bei jeder Abweichung.
export function pinnedHostKeyOptions({ fingerprint, algorithm }) {
  const fp = normFingerprint(fingerprint);
  if (!fp) throw new HostKeyError("HOST_KEY_MISSING", "Host-Key nicht hinterlegt – keine Verbindung (kein Trust-on-first-use).");
  if (!isSafeHostKeyAlgorithm(algorithm) || !safeHostKeyAlgorithms().includes(algorithm)) throw new HostKeyError("HOST_KEY_ALGORITHM_UNSAFE", "Host-Key-Algorithmus nicht erlaubt.");
  const state = { verified: null, changed: false };
  const options = {
    algorithms: { serverHostKey: [algorithm] },
    hostVerifier: (key) => {
      const ok = fingerprintOf(key) === fp && keyTypeOf(key) === KEY_TYPE_OF[algorithm];
      if (ok) state.verified = { sha256: fp, algorithm };
      else state.changed = true;
      return ok;
    },
  };
  return { options, state };
}
