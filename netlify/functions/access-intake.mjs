// /api/access-intake – sicherer One-Time-Zugangsweg für CHF-480-Aufträge (TF-041). Siehe access-intake-api.js.
// Braucht in Netlify nur JARVIS_MAIL_WORKER_TOKEN (bereits vorhanden, für register/pull/ack des VPS). Kein Private Key hier.
import { createAccessIntakeHandler } from "../../access-intake-api.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createAccessIntakeHandler({
  env,
  getStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    const blobs = getStore({ name: "jarvis-access-intake", consistency: "strong" });
    return {
      async get(k) { const r = await blobs.getWithMetadata(k, { type: "json" }); return r ? { data: r.data, etag: r.etag } : null; },
      async set(k, data, { etag = null } = {}) { const r = await blobs.setJSON(k, data, etag ? { onlyIfMatch: etag } : {}); return r?.modified !== false; },
      async delete(k) { await blobs.delete(k); },
      async list(prefix) { const { blobs: list } = await blobs.list({ prefix }); return list.map((b) => b.key); },
    };
  },
});

export const config = { path: "/api/access-intake" };
