// /api/sales – Provision (35 %, abgeleitet), Lead-Zuweisungen und Vertriebs-Steuerung (TF-063). Siehe sales-api.js.
import { createSalesHandler } from "../../sales-api.js";
import { netlifyBlobStore } from "../../shared-state.js";
import { netlifyAuthStore } from "../../auth-core.js";
import { netlifySalesData } from "../../sales-data.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createSalesHandler({
  env,
  data: netlifySalesData,
  getAuthStore: netlifyAuthStore,
  getSalesStore: async (k) => netlifyBlobStore((await import("@netlify/blobs")).getStore({ name: "jarvis-sales", consistency: "strong" }), k),
});

export const config = { path: "/api/sales" };
