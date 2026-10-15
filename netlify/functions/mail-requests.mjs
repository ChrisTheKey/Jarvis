// /api/mail-requests – Warteschlange für Cloud-Mailaufträge in Netlify Blobs. Sendet nie selbst:
// Der Mail-Worker holt offene Aufträge ab, prüft sie nach allen Regeln und meldet das Ergebnis.
// Browser: Session (TF-063). OWNER legt Aufträge an; Verkäufer nur Entwürfe für eigene VN-Leads (Empfänger serverseitig aus dem Lead).
import { createMailRequestHandler } from "../../mail-requests.js";
import { netlifyBlobStore } from "../../shared-state.js";
import { resolveActor, netlifyAuthStore } from "../../auth-core.js";
import { netlifySalesData } from "../../sales-data.js";

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k];

export default createMailRequestHandler({
  env,
  getStore: async () => {
    const { getStore } = await import("@netlify/blobs");
    return netlifyBlobStore(getStore({ name: "jarvis-mail-requests", consistency: "strong" }), "queue");
  },
  resolveActor: (req) => resolveActor(req, { env, getAuthStore: netlifyAuthStore }),
  resolveLead: async (actor, leadId) => (await netlifySalesData()).resolveLead(actor, leadId),
});

export const config = { path: "/api/mail-requests" };
