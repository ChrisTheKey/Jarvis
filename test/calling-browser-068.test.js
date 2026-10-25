import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("TF-068 CRM UI exposes human call notes and follow-up context", () => {
  const ui = fs.readFileSync(new URL("../public/crm.js", import.meta.url), "utf8");
  assert.match(ui, /crm\.addCall/);
  assert.match(ui, /crm\.addNote/);
  assert.match(ui, /crm\.setNextAction/);
  assert.match(ui, /leadCallBox/);
});
