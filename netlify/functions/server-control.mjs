// /api/server-control – geschützte Server-Steuerung des Jarvis-VPS (nur feste Aktionen, keine Shell). Siehe server-control.js.
// Braucht in Netlify: JARVIS_PASSWORD (Chris im Browser) und JARVIS_SERVER_CONTROL_TOKEN (nur der VPS-Agent; eigenes Secret).
import { createServerControlHandler } from "../../server-control.js";
import { netlifyBlobStore } from "../../shared-state.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createServerControlHandler({
  env,
  getStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    return netlifyBlobStore(getStore({ name: "jarvis-server-control", consistency: "strong" }), "control");
  },
  // Lead-Datenbank (Allowlist vom VPS) – eigener Schlüssel, damit der Status-Blob klein bleibt.
  getLeadDbStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    return netlifyBlobStore(getStore({ name: "jarvis-server-control", consistency: "strong" }), "leaddb");
  },
});

export const config = { path: "/api/server-control" };
