import test from "node:test";
import assert from "node:assert/strict";
import { USERS, PERMISSIONS } from "../auth-core.js";
import { canSeeLead } from "../sales-scope.js";

test("TF-070 all existing employee accounts retain CRM permissions", () => {
  for (const id of ["chris", "giuliano", "mario", "damiano", "Kudoshin"]) {
    const user = USERS[id];
    assert.ok(user, id);
    assert.ok(user.role === "OWNER" || PERMISSIONS[user.role].includes("crm.read"));
    assert.ok(user.role === "OWNER" || PERMISSIONS[user.role].includes("crm.write"));
  }
});

test("TF-070 human calling still respects seller scope", () => {
  const ch = { lead_id: "synthetic-ch", market: "CH" };
  assert.equal(canSeeLead({ role: "SALES_AGENT_CH", user_id: "giuliano" }, ch, { assignments: {} }), true);
  assert.equal(canSeeLead({ role: "SALES_AGENT_VN", user_id: "Kudoshin" }, ch, { assignments: {} }), false);
});
