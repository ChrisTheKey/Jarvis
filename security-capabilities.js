// Zentraler Sicherheitsgurt für lokale Entwicklung und Tests.
// Default: alles verweigern. Synthetische Tests dürfen nur explizit markiert
// werden; produktive Freigaben kommen ausschliesslich aus der Runtime.
import crypto from "node:crypto";

export const CAPABILITIES = Object.freeze([
  "lead_discovery",
  "lead_import",
  "gmail_draft",
  "gmail_send",
  "calling_live",
  "crm_write",
  "paid_api",
]);

const MODES = new Set(["approved", "synthetic"]);

const envOf = (env) => env || process.env;
const configured = (env) => new Set(String(envOf(env).JARVIS_CAPABILITIES || "")
  .split(",").map((x) => x.trim()).filter(Boolean));

export function capabilityStatus(env = process.env) {
  const e = envOf(env), allow = configured(e);
  return Object.fromEntries(CAPABILITIES.map((name) => [name, e.JARVIS_CAPABILITY_MODE === "approved" && allow.has(name)]));
}

export function capabilityDecision(name, { env = process.env, synthetic = false } = {}) {
  if (!CAPABILITIES.includes(name)) return { allowed: false, mode: "deny", reason: "UNKNOWN_CAPABILITY" };
  const e = envOf(env), mode = String(e.JARVIS_CAPABILITY_MODE || "deny").toLowerCase();
  if (synthetic && mode === "synthetic") return { allowed: true, mode: "synthetic", reason: null };
  if (mode === "approved" && configured(e).has(name)) return { allowed: true, mode: "approved", reason: null };
  return { allowed: false, mode: MODES.has(mode) ? mode : "deny", reason: "CAPABILITY_DENIED" };
}

// Ein explizit markierter synthetischer Adapter darf im Test arbeiten. Ein
// normaler lokaler Prozess bleibt ohne Allowlist gesperrt.
export function assertExternalCapability(name, { env = process.env, synthetic = false } = {}) {
  const e = envOf(env);
  if (String(e.JARVIS_RUNTIME || "").toLowerCase() === "production") return { allowed: true, mode: "production" };
  return assertCapability(name, { env: e, synthetic });
}

export function assertCapability(name, options = {}) {
  const decision = capabilityDecision(name, options);
  if (!decision.allowed) {
    const error = new Error(`${decision.reason}: ${name}`);
    error.code = decision.reason;
    error.capability = name;
    throw error;
  }
  return decision;
}

// TF-040: Klick-Beleg des CRM-Servers für genau EINE manuell ausgelöste Erstmail (delivery "sales_intake").
// HMAC über Auftrag, Empfänger, Inhalt, Lead, Angebot und Benutzer; Schlüssel abgeleitet vom Worker-Token, das nur CRM-Server und Mail-Worker kennen.
// Jede Änderung am Auftrag macht den Beleg ungültig; Felder in der Queue oder in cloud_requests.json allein geben keine Freigabe.
export const CRM_CLICK_RE = /^[A-Za-z0-9_-]{43}$/;
// TF-044: Grund eines eindeutig fehlgeschlagenen Erstmail-Versands; jeder andere failed-Grund gilt als unklar und erlaubt keinen neuen Versuch.
export const SALES_SEND_FAILED_REASON = "Erstmail konnte nicht gesendet werden.";
const crmClickClaims = (rq) => {
  const m = rq?.meta || {};
  return JSON.stringify([rq?.request_id, rq?.delivery, rq?.expires_at, rq?.recipient, rq?.subject, crypto.createHash("sha256").update(String(rq?.body ?? "")).digest("hex"),
    m.actor_user_id, m.market, m.lead_id, m.preview_ref, m.bundle_id, m.idempotency_key, m.offer, m.order_id, m.order150_id, m.order480_id, m.access_expires_at,
    m.sales_intake_direct, m.sales_sandbox, m.synthetic_test].map((v) => v ?? null));
};
const crmClickMac = (secret, rq) => crypto.createHmac("sha256", crypto.createHmac("sha256", String(secret)).update("jarvis-crm-click-v1").digest()).update(crmClickClaims(rq)).digest("base64url");

export function signCrmClick(secret, rq) {
  if (!secret) throw new Error("CRM-Klick-Beleg: Schlüssel fehlt.");
  return crmClickMac(secret, rq);
}

export function verifyCrmClick(rq, now = new Date(), secret = process.env.JARVIS_MAIL_WORKER_TOKEN) {
  const given = rq?.meta?.click_attestation;
  if (!secret || typeof given !== "string" || !CRM_CLICK_RE.test(given)) return false;
  if (rq.delivery !== "sales_intake" || rq.meta.sales_intake !== true || !(Date.parse(rq.expires_at) > +now)) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(crmClickMac(secret, rq)));
}
