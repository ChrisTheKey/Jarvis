// /api/backup – verschlüsselte State-Backups des Cloud Core (Netlify Blobs, Store "jarvis-backups"). Siehe backup-api.js. OWNER ONLY (TF-063).
import { createBackupHandler } from "../../backup-api.js";
import { resolveActor, netlifyAuthStore } from "../../auth-core.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createBackupHandler({
  env,
  resolveActor: (req) => resolveActor(req, { env, getAuthStore: netlifyAuthStore }),
  getStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: "jarvis-backups", consistency: "strong" });
  },
});

export const config = { path: "/api/backup" };
