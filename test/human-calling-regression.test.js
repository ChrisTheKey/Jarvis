import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canUseCalling, manualCallsFromLeads } from "../calling-api.js";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("menschlicher Vertriebsworkflow bleibt im CRM erreichbar", () => {
  const crm = read("public/crm.js");
  for (const action of ["crm.addCall", "crm.addNote", "crm.setNextAction", "crm.updateCallStatus"]) {
    assert.match(crm, new RegExp(action.replace(".", "\\.")), action);
  }
  assert.match(crm, /callingTexts|leadCallBox/);
  assert.match(crm, /SALES_MANAGER_CH|SALES_AGENT_CH/);
  assert.match(read("lead-crm.js"), /call_history|callback|call_status/i);
  assert.match(read("commission-ledger.js"), /commission|provision/i);
  assert.match(read("stripe-payments.js"), /payment|checkout|link/i);
});

test("call.start hat keinen autonomen Ausführungspfad", () => {
  const api = read("calling-api.js");
  assert.match(api, /AUTONOMOUS_CALLING_REMOVED/);
  assert.match(api, /call\.start/);
  assert.doesNotMatch(read("public/calling-ui.js"), /call\.start|LiveKit|Calling Agent|campaign\.start/);
});

test("alle Mitarbeiterrollen behalten den menschlichen Calling-Lesezugang", () => {
  for (const role of ["OWNER", "SALES_MANAGER_CH", "SALES_AGENT_CH", "SALES_AGENT_VN"]) {
    assert.equal(canUseCalling({ role }), true, role);
  }
});

test("Calling-Ansicht übernimmt manuelle CRM-Gespräche und Rückrufe", () => {
  const leads = [{ lead_id: "ch-1", company: "Synthetische GmbH", market: "CH", call_history: [
    { id: "call-1", at: "2026-10-25T09:00:00.000Z", result: "CALLBACK_REQUESTED", note: "Rückruf vereinbart", follow_up_at: "2026-10-27" },
  ] }];
  assert.deepEqual(manualCallsFromLeads(leads), [{
    lead_id: "ch-1", company: "Synthetische GmbH", market: "CH", call_id: "call-1", started_at: "2026-10-25T09:00:00.000Z",
    status: "COMPLETED", outcome: "CALLBACK_REQUESTED", summary: "Rückruf vereinbart", callback_at: "2026-10-27", dry_run: false,
  }]);
});
