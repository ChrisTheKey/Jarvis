// /api/mail-requests – Warteschlange für Cloud-Mailaufträge in Netlify Blobs. Sendet nie selbst:
// Der lokale Mail-Worker holt offene Aufträge ab, prüft sie nach allen Regeln und meldet das Ergebnis.
// Braucht in Netlify: JARVIS_PASSWORD (Chris im Browser) und JARVIS_SYNC_TOKEN (nur der lokale Worker).
import { createMailRequestHandler } from "../../mail-requests.js";
import { netlifyBlobStore } from "../../shared-state.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createMailRequestHandler({
  env,
  getStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    return netlifyBlobStore(getStore({ name: "jarvis-mail-requests", consistency: "strong" }), "queue");
  },
});

export const config = { path: "/api/mail-requests" };
