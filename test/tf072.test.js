import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { manualCallsFromLeads } from "../calling-api.js";
import { CRM_ACTIONS } from "../lead-crm.js";

test("TF-072 manual calling preserves history, notes and callback planning", () => {
  const [call] = manualCallsFromLeads([{ lead_id: "synthetic-072", company: "Test AG", market: "CH", call_history: [
    { id: "call-072", at: "2026-10-25T11:00:00Z", result: "CALLBACK_REQUESTED", note: "Rückruf", follow_up_at: "2026-10-28" },
  ] }]);
  assert.deepEqual({ outcome: call.outcome, summary: call.summary, callback_at: call.callback_at }, { outcome: "CALLBACK_REQUESTED", summary: "Rückruf", callback_at: "2026-10-28" });
  assert.ok(CRM_ACTIONS["crm.addCall"]);
  assert.ok(CRM_ACTIONS["crm.setNextAction"]);
});

test("TF-072 autonomous start remains fail-closed", () => {
  assert.match(fs.readFileSync(new URL("../calling-api.js", import.meta.url), "utf8"), /AUTONOMOUS_CALLING_REMOVED/);
});
