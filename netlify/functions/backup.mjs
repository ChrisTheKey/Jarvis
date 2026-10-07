// /api/backup – verschlüsselte State-Backups des Cloud Core (Netlify Blobs, Store "jarvis-backups"). Siehe backup-api.js.
import { createBackupHandler } from "../../backup-api.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createBackupHandler({
  env,
  getStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: "jarvis-backups", consistency: "strong" });
  },
});

export const config = { path: "/api/backup" };
