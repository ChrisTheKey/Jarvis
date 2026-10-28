import assert from "node:assert/strict";
import test from "node:test";
import { actorFor } from "../auth-core.js";
import { createSalesData } from "../sales-data.js";

const TEST_LEAD = {
  lead_id: "praxis-kaelin.netlify.app", is_test: true, market: "CH", email: "helvetic.webdesign@proton.me",
  errors: { items: [{ text: "Synthetischer bestätigter Befund" }] },
};
const store = async (value) => ({ get: async () => ({ state: value }) });

test("Owner kann den sichtbaren synthetischen TEST-Lead für den freigegebenen E2E-Verkaufsbutton auflösen", async () => {
  const data = createSalesData({
    getViewStore: () => store({ leads: [TEST_LEAD] }),
    getSalesStore: () => store({}),
  });
  const result = await data.resolveLead(actorFor("chris"), TEST_LEAD.lead_id);
  assert.deepEqual(result.lead, TEST_LEAD);
});

test("Verkäufer-Scope bleibt für denselben synthetischen TEST-Lead geschlossen", async () => {
  const data = createSalesData({
    getViewStore: () => store({ leads: [TEST_LEAD] }),
    getSalesStore: () => store({ assignments: {} }),
  });
  const result = await data.resolveLead(actorFor("damiano"), TEST_LEAD.lead_id);
  assert.equal(result.lead, undefined);
  assert.equal(result.status, 403);
});
