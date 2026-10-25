// Wegwerf-Zertifikat für hermetische Browser-Tests (nur im Speicher, nie auf Platte, kein eingecheckter Schlüssel).
// Nötig, weil *.netlify.app in der HSTS-Preload-Liste steht: Chromium erzwingt HTTPS, auch für die Test-Attrappe.
import crypto from "node:crypto";

const len = (n) => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]));
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const oid = (bytes) => tlv(0x06, Buffer.from(bytes));
const SHA256_RSA = seq(oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), tlv(0x05));
const name = (cn) => seq(tlv(0x31, seq(oid([0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from(cn)))));
const utc = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));

export function makeSelfSignedCert(dnsNames = ["*.netlify.app", "netlify.app"]) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const san = seq(...dnsNames.map((n) => tlv(0x82, Buffer.from(n))));
  const ext = seq(seq(oid([0x55, 0x1d, 0x11]), tlv(0x04, san)));
  const now = Date.now();
  const tbs = seq(tlv(0xa0, tlv(0x02, Buffer.from([2]))), tlv(0x02, Buffer.from([1, ...crypto.randomBytes(7)])), SHA256_RSA, name("jarvis-test"),
    seq(utc(new Date(now - 86_400_000)), utc(new Date(now + 86_400_000))), name("jarvis-test"), publicKey.export({ type: "spki", format: "der" }), tlv(0xa3, ext));
  const sig = crypto.sign("sha256", tbs, privateKey);
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n")}\n-----END CERTIFICATE-----\n`;
  return { cert, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
