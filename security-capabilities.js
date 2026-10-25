// Zentraler Sicherheitsgurt für lokale Entwicklung und Tests.
// Default: alles verweigern. Synthetische Tests dürfen nur explizit markiert
// werden; produktive Freigaben kommen ausschliesslich aus der Runtime.

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
