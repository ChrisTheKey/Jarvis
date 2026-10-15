// /api/calling – Jarvis Calling Agent (TF-065). Siehe calling-api.js. Braucht in Netlify nur die bestehende Variable JARVIS_SERVER_CONTROL_TOKEN
// (der Dienst jarvis-calling nutzt daraus einen abgeleiteten, eigenen Schlüssel). KEINE LiveKit-Secrets in Netlify – die liegen nur auf dem VPS.
import { createCallingHandler } from "../../calling-api.js";
import { netlifyBlobStore } from "../../shared-state.js";
import { netlifyAuthStore } from "../../auth-core.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];
const blobs = async (name) => (await import("@netlify/blobs")).getStore({ name, consistency: "strong" });

export default createCallingHandler({
  env,
  getCallingStore: async (k) => netlifyBlobStore(await blobs("jarvis-calling"), k),
  getAuthStore: netlifyAuthStore,
  getViewStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "view"),
  getVnViewStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "vn-view"),
  getCrmQueueStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "queue"),
  getVnQueueStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "vn-queue"),
  getSalesStore: async (k) => netlifyBlobStore(await blobs("jarvis-sales"), k),
});

export const config = { path: "/api/calling" };
