// /api/crm – Jarvis Lead-CRM (TF-053, Multi-User TF-063). Siehe crm-api.js. Braucht in Netlify nur die bestehende Variable
// JARVIS_SERVER_CONTROL_TOKEN (CRM-/VN-Dienst nutzen daraus abgeleitete, eigene Schlüssel); Browser per Session-Cookie (jarvis-auth).
import { createCrmHandler } from "../../crm-api.js";
import { netlifyBlobStore } from "../../shared-state.js";
import { netlifyAuthStore } from "../../auth-core.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];
const blobs = async (name) => (await import("@netlify/blobs")).getStore({ name, consistency: "strong" });

export default createCrmHandler({
  env,
  getQueueStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "queue"),
  getViewStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "view"),
  getVnQueueStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "vn-queue"),
  getVnViewStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "vn-view"),
  getSalesStore: async (k) => netlifyBlobStore(await blobs("jarvis-sales"), k),
  getAuthStore: netlifyAuthStore,
  getBackupStore: async () => blobs("jarvis-backups"),
});

export const config = { path: "/api/crm" };
