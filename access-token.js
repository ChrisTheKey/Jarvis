// Runtime-neutrale Teile des sicheren Kundenlinks (TF-041).
// Diese kleine Schicht wird auch von Netlify Edge benötigt; die vollständige
// access-intake.js bleibt beim Node/VPS-Repair-Worker und enthält Dateisystem-,
// Zahlungs- und Tresorlogik.
import crypto from "node:crypto";

export const INTAKE_TTL_MS = 72 * 3600_000;
export const tokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export function newIntakeToken({ now = new Date(), ttlMs = INTAKE_TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, token_hash: tokenHash(token), expires_at: new Date(+now + ttlMs).toISOString() };
}

// URL-Fragmente werden nicht an den Server gesendet; der Klartext-Token bleibt
// ausschließlich im temporären Kundenlink.
export const accessLink = (origin, token, locale = "de-CH") => `${String(origin).replace(/\/+$/, "")}/access.html#t=${encodeURIComponent(token)}${locale === "vi-VN" ? "&l=vi" : ""}`;
