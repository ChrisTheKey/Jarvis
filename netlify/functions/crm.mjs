// /api/crm – Jarvis Lead-CRM (TF-053). Siehe crm-api.js. Braucht in Netlify nur die bestehenden Variablen JARVIS_PASSWORD und
// JARVIS_SERVER_CONTROL_TOKEN (der CRM-Dienst auf dem VPS nutzt einen daraus abgeleiteten, eigenen Schlüssel).
import { createCrmHandler } from "../../crm-api.js";
import { netlifyBlobStore } from "../../shared-state.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];
const blobs = async (name) => (await import("@netlify/blobs")).getStore({ name, consistency: "strong" });

export default createCrmHandler({
  env,
  getQueueStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "queue"),
  getViewStore: async () => netlifyBlobStore(await blobs("jarvis-crm"), "view"),
  getBackupStore: async () => blobs("jarvis-backups"),
});

export const config = { path: "/api/crm" };
