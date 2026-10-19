// TF-063: gemeinsamer Lesezugriff auf CRM-Sichten (CH + VN), Zuweisungen und Snapshot – für /api/sales, /api/mail-requests und
// die Edge-Function (Verkäufer-Kontext). Ohne Node-Abhängigkeiten; Netlify-Blobs-Adapter in netlifySalesData().
import { scopeLeads, canSeeLead, emptyAssignments } from "./sales-scope.js";
import { netlifyBlobStore } from "./shared-state.js";
import { crmActive, isTestLead } from "./public/crm-model.js";

export function createSalesData({ getViewStore, getVnViewStore = null, getSalesStore, getControlStore = null }) {
  const read = async (get) => (get ? (await (await get()).get()).state : null);
  async function allLeads() {
    const [v, vn] = await Promise.all([read(getViewStore), read(getVnViewStore)]);
    // TF-077B: VN-Kontaktformular-Inbound-Leads liegen im CH-CRM, gehören aber zum Markt VN (Bereich Kudoshin).
    const chMarket = (l) => (l.market === "VN" && l.contact_form?.lead_source === "CONTACT_FORM" && l.contact_form.inbound === true ? "VN" : "CH");
    return [...(v?.leads || []).map((l) => ({ ...l, market: chMarket(l) })), ...(vn?.leads || []).map((l) => ({ ...l, market: "VN" }))];
  }
  // TF-076: nur aktive CRM-Leads (≥ 1 verifizierter Website-Fehler) – Verkäufer-Zähler, Chat-Kontext, neue Aufträge.
  // TF-080: E2E-Testleads nie in Verkäufer-Zählern, Chat-Kontext oder neuen Aufträgen (nur im CRM sichtbar).
  const leads = async () => (await allLeads()).filter(crmActive).filter((l) => !isTestLead(l));
  const assignments = async () => (await read(() => getSalesStore("assignments"))) || emptyAssignments();
  return {
    leads, assignments,
    allLeads, // Provisions-Zuordnung bestehender Aufträge: nie an der Aufnahmeregel scheitern lassen
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
