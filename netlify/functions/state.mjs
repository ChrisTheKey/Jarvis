// /api/state – gemeinsamer, sicherer Jarvis-Zustand in Netlify Blobs.
// Braucht in Netlify: JARVIS_SYNC_TOKEN (nur der lokale Jarvis-Kern) und JARVIS_MAIL_WORKER_TOKEN (VPS). Browser: Session (TF-063) –
// OWNER sieht den gemeinsamen Zustand, Verkäufer nur ihren eigenen Gesprächsverlauf (Store "jarvis-user-state", Schlüssel conv/<user_id>).
import { createStateHandler, netlifyBlobStore } from "../../shared-state.js";
import { resolveActor, netlifyAuthStore } from "../../auth-core.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];
const blobs = async (name) => (await import("@netlify/blobs")).getStore({ name, consistency: "strong" });

export default createStateHandler({
  env,
  getStore: async () => netlifyBlobStore(await blobs("jarvis-state")),
  resolveActor: (req) => resolveActor(req, { env, getAuthStore: netlifyAuthStore }),
  getUserStore: async (userId) => netlifyBlobStore(await blobs("jarvis-user-state"), `conv/${userId}`),
});

export const config = { path: "/api/state" };
