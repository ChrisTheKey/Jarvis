// /api/state – gemeinsamer, sicherer Jarvis-Zustand in Netlify Blobs.
// Braucht in Netlify: JARVIS_PASSWORD (Sir im Browser: lesen, als gelesen markieren, Gespräch) und
// JARVIS_SYNC_TOKEN (nur der lokale Jarvis-Kern: Status, Benachrichtigungen, Gespräch synchronisieren).
import { createStateHandler, netlifyBlobStore } from "../../shared-state.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createStateHandler({
  env,
  getStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    return netlifyBlobStore(getStore({ name: "jarvis-state", consistency: "strong" }));
  },
});

export const config = { path: "/api/state" };
