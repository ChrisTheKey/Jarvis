// /api/state – gemeinsamer, sicherer Jarvis-Zustand in Netlify Blobs.
// Braucht in Netlify: JARVIS_SYNC_TOKEN (nur der lokale Jarvis-Kern) und JARVIS_MAIL_WORKER_TOKEN (VPS). Browser: Session (TF-063) –
// OWNER sieht den gemeinsamen Zustand, Verkäufer nur ihren eigenen Gesprächsverlauf (Store "jarvis-user-state", Schlüssel conv/<user_id>).
import { createStateHandler, netlifyBlobStore } from "../../shared-state.js";
import { resolveActor, netlifyAuthStore } from "../../auth-core.js";
import { VN_SELLER_ID, LEGACY_VN_SELLER_ID } from "../../seller-identity.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];
const blobs = async (name) => (await import("@netlify/blobs")).getStore({ name, consistency: "strong" });

// TF-070: Gesprächsverlauf des Kontos «lap» einmalig nach conv/Kudoshin übernehmen (nur wenn dort noch nichts liegt), dann conv/lap entfernen.
async function userStore(userId) {
  const b = await blobs("jarvis-user-state");
  if (userId === VN_SELLER_ID) {
    const legacy = await b.get(`conv/${LEGACY_VN_SELLER_ID}`, { type: "json" }).catch(() => null);
    if (legacy) {
      const moved = await b.setJSON(`conv/${VN_SELLER_ID}`, { ...legacy, user_id: VN_SELLER_ID }, { onlyIfNew: true }).catch(() => null);
      if (moved?.modified !== false || (await b.get(`conv/${VN_SELLER_ID}`, { type: "json" }).catch(() => null))) await b.delete(`conv/${LEGACY_VN_SELLER_ID}`).catch(() => {});
    }
  }
  return netlifyBlobStore(b, `conv/${userId}`);
}

export default createStateHandler({
  env,
  getStore: async () => netlifyBlobStore(await blobs("jarvis-state")),
  resolveActor: (req) => resolveActor(req, { env, getAuthStore: netlifyAuthStore }),
  getUserStore: userStore,
});

export const config = { path: "/api/state" };
