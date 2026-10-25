import test from "node:test";
import assert from "node:assert/strict";
import { CRM_ACTIONS, validateCrmAction } from "../lead-crm.js";
import { capabilityDecision } from "../security-capabilities.js";

test("TF-068 human CRM call, note and DNC surfaces remain allowlisted", () => {
  for (const action of ["crm.addCall", "crm.addNote", "crm.setNextAction", "crm.updateCallStatus", "crm.setDoNotContact"]) assert.ok(CRM_ACTIONS[action]);
  assert.equal(validateCrmAction({ action: "crm.addCall", params: { lead_id: "synthetic-068", result: "INTERESTED" } }).ok, true);
  assert.equal(validateCrmAction({ action: "crm.addNote", params: { lead_id: "synthetic-068", text: "Notiz" } }).ok, true);
});

test("TF-068 default-deny keeps autonomous capability denied", () => {
  assert.equal(capabilityDecision("calling_live", { env: {} }).allowed, false);
});
