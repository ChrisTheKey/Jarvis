// /api/payments – Zahlungseingangs-Webhook + Inbox (TF-068). Siehe payments-api.js. Ohne PAYMENT_MONITOR_PROVIDER → PAYMENT_MONITOR_NOT_CONFIGURED.
import { createPaymentsHandler } from "../../payments-api.js";
import { netlifyBlobStore } from "../../shared-state.js";
import { netlifyAuthStore } from "../../auth-core.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createPaymentsHandler({
  env,
  getAuthStore: netlifyAuthStore,
  getStore: async (k) => netlifyBlobStore((await import("@netlify/blobs")).getStore({ name: "jarvis-payments", consistency: "strong" }), k),
});

export const config = { path: "/api/payments" };
