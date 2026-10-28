import assert from "node:assert/strict";
import test from "node:test";
import { actorFor } from "../auth-core.js";
import { createSalesData } from "../sales-data.js";
import { MANUAL_TEST_ACTION, MANUAL_TEST_OFFERS, validateCrmAction } from "../lead-crm.js";

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

test("Manual TEST-Lead erhält feste synthetische Anfragegrundlage für den freigegebenen Empfänger", () => {
  const input = { action: MANUAL_TEST_ACTION, params: {
    name: "Praxis Kälin – E2E",
    domain: TEST_LEAD.lead_id,
    email: TEST_LEAD.email,
    source: "MANUAL_TEST", lead_type: "WEBSITE_REPAIR", environment: "TEST", priority: "HIGH", status: "MANUAL_TEST_AUTHORIZED",
    checked_at: "2026-10-28T12:00:00.000Z",
    findings: [{ key: "PK001", type: "contact_page_broken", text: "Testbefund", page: "https://praxis-kaelin.netlify.app/", severity: "high", confirmed: true }],
    repair_offer: MANUAL_TEST_OFFERS,
  } };
  const result = validateCrmAction(input, { now: new Date("2026-10-28T13:00:00.000Z") });
  assert.equal(result.ok, true);
  assert.deepEqual(result.params.test_request, {
    basis: "requested_contact",
    request_source: "synthetic_e2e_authorization",
    request_date: "2026-10-28T12:00:00.000Z",
    request_scope: "Website-Analyse und Website-Reparatur",
    request_evidence: "Ausdrückliche synthetische E2E-Testanfrage für JARVIS; keine Kundenkontaktaufnahme.",
    response_scope: "Website-Analyse und Website-Reparatur",
    recipient_or_submission_channel: TEST_LEAD.email,
    request_confidence: "HIGH",
  });
  const tampered = validateCrmAction({ ...input, params: { ...input.params, test_request: { basis: "requested_contact" } } });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, "BAD_PARAMS");
});
