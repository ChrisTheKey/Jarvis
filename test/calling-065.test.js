// TF-065: human calling regression coverage. Autonomous LiveKit worker tests
// were intentionally removed with the autonomous calling feature.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canUseCalling, manualCallsFromLeads } from "../calling-api.js";

test("TF-065 human sellers retain the calling dashboard", () => {
  for (const role of ["OWNER", "SALES_MANAGER_CH", "SALES_AGENT_CH", "SALES_AGENT_VN"]) assert.equal(canUseCalling({ role }), true);
  assert.match(fs.readFileSync(new URL("../public/calling-ui.js", import.meta.url), "utf8"), /manuelle|manual/i);
});

test("TF-065 manual CRM call history is read-only dashboard data", () => {
  const [row] = manualCallsFromLeads([{ lead_id: "synthetic-065", market: "CH", call_history: [{ id: "c1", at: "2026-10-25T10:00:00Z", result: "INTERESTED", note: "Interesse" }] }]);
  assert.equal(row.outcome, "INTERESTED");
  assert.equal(row.dry_run, false);
});
