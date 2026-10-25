import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("menschlicher Vertriebsworkflow bleibt im CRM erreichbar", () => {
  const crm = read("public/crm.js");
  for (const action of ["crm.addCall", "crm.addNote", "crm.setNextAction", "crm.updateCallStatus"]) {
    assert.match(crm, new RegExp(action.replace(".", "\\.")), action);
  }
  assert.match(crm, /callingTexts|leadCallBox/);
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
