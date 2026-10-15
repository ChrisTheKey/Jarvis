// TF-063: gemeinsamer Lesezugriff auf CRM-Sichten (CH + VN), Zuweisungen und Snapshot – für /api/sales, /api/mail-requests und
// die Edge-Function (Verkäufer-Kontext). Ohne Node-Abhängigkeiten; Netlify-Blobs-Adapter in netlifySalesData().
import { scopeLeads, canSeeLead, emptyAssignments } from "./sales-scope.js";
import { netlifyBlobStore } from "./shared-state.js";

export function createSalesData({ getViewStore, getVnViewStore = null, getSalesStore, getControlStore = null }) {
  const read = async (get) => (get ? (await (await get()).get()).state : null);
  async function leads() {
    const [v, vn] = await Promise.all([read(getViewStore), read(getVnViewStore)]);
    return [...(v?.leads || []).map((l) => ({ ...l, market: "CH" })), ...(vn?.leads || []).map((l) => ({ ...l, market: "VN" }))];
  }
  const assignments = async () => (await read(() => getSalesStore("assignments"))) || emptyAssignments();
  return {
    leads, assignments,
    vnView: () => read(getVnViewStore),
    snapshot: async () => (await read(getControlStore))?.snapshot || null,
    async scoped(actor) { return scopeLeads(actor, await leads(), await assignments()); },
    // Ein Lead im Scope des Akteurs – sonst 403 (existiert, aber fremd) bzw. 403 auch für Unbekanntes (kein Existenz-Orakel für Verkäufer).
    async resolveLead(actor, leadId) {
      if (typeof leadId !== "string" || !/^[a-z0-9][a-z0-9.@_+-]{2,252}$/.test(leadId)) return { status: 400, code: "BAD_PARAMS" };
      const [all, asg] = await Promise.all([leads(), assignments()]);
      const l = all.find((x) => x.lead_id === leadId);
      if (!l) return { status: actor.role === "OWNER" ? 404 : 403, code: actor.role === "OWNER" ? "UNKNOWN_LEAD" : "OUT_OF_SCOPE" };
      return canSeeLead(actor, l, asg) ? { lead: l } : { status: 403, code: "OUT_OF_SCOPE" };
    },
  };
}
export async function netlifySalesData() {
  const { getStore } = await import("@netlify/blobs");
  const crm = getStore({ name: "jarvis-crm", consistency: "strong" }), sales = getStore({ name: "jarvis-sales", consistency: "strong" });
  const control = getStore({ name: "jarvis-server-control", consistency: "strong" });
  return createSalesData({ getViewStore: async () => netlifyBlobStore(crm, "view"), getVnViewStore: async () => netlifyBlobStore(crm, "vn-view"),
    getSalesStore: async (k) => netlifyBlobStore(sales, k), getControlStore: async () => netlifyBlobStore(control, "control") });
}
