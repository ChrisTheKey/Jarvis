// /api/auth/* – Multi-User-Login (TF-063). Siehe auth-api.js. Speicher: Netlify Blobs "jarvis-auth" (nur scrypt-Hashes und
// SHA-256 der Session-Tokens). Nutzt die bestehende Variable JARVIS_PASSWORD nur als Owner-Bootstrap für Chris.
// TF-073: Deaktiviert Chris ein Verkäufer-Konto, enden auch alle Geräte-Sitzungen dieses Verkäufers (device-api.js).
import { createAuthHandler } from "../../auth-api.js";
import { netlifyAuthStore } from "../../auth-core.js";
import { netlifyDeviceStore } from "../../device-core.js";
import { terminateUserDevices } from "../../device-api.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createAuthHandler({ env, getStore: netlifyAuthStore,
  onUserDisabled: async (user_id, actor_user_id) => terminateUserDevices(await netlifyDeviceStore(), { user_id, actor_user_id }) });

export const config = { path: ["/api/auth/*"] };
