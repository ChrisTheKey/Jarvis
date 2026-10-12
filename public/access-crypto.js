// Verschlüsselung der Zugangsdaten IM BROWSER (TF-041) – Netlify und Logs sehen nur Chiffrat.
// Verfahren wie backup.js / access-intake.js: zufälliger AES-256-GCM-Schlüssel, verpackt mit dem RSA-Public-Key des VPS
// (RSA-OAEP, SHA-256). Den Private Key hat nur der VPS. Läuft unverändert in Browser und Node (WebCrypto).
export const ACCESS_ENVELOPE_ALG = "RSA-OAEP-256+A256GCM";

const b64 = (buf) => { let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s); };
const pemToDer = (pem) => Uint8Array.from(atob(String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));

export async function sealForVps(publicKeyPem, payload, cryptoImpl = globalThis.crypto) {
  const subtle = cryptoImpl.subtle;
  const pub = await subtle.importKey("spki", pemToDer(publicKeyPem), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const raw = await subtle.exportKey("raw", aes);
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(JSON.stringify(payload)));
  const wrapped = await subtle.encrypt({ name: "RSA-OAEP" }, pub, raw);
  return { alg: ACCESS_ENVELOPE_ALG, wrapped_key: b64(wrapped), iv: b64(iv), ciphertext: b64(ct) };
}
