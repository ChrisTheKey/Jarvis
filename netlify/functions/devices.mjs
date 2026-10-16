// /api/devices/* – Geräte pro Benutzer (TF-073). Siehe device-api.js / device-core.js. Speicher: Netlify Blobs "jarvis-devices"
// (nur SHA-256 von Geräte-Secrets, Kopplungs-Codes und Sitzungs-Tokens). Geräte verbinden sich nur ausgehend (HTTPS) – kein offener Port.
import { createDeviceHandler } from "../../device-api.js";
import { netlifyDeviceStore } from "../../device-core.js";
import { resolveActor, netlifyAuthStore } from "../../auth-core.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createDeviceHandler({
  getStore: netlifyDeviceStore,
  getAuthStore: netlifyAuthStore,
  resolveActor: (req) => resolveActor(req, { env, getAuthStore: netlifyAuthStore }),
});

export const config = { path: ["/api/devices", "/api/devices/*"] };
