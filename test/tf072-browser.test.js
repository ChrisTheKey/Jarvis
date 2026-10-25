import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("TF-072 browser retains manual call detail and issue links", () => {
  const ui = fs.readFileSync(new URL("../public/crm.js", import.meta.url), "utf8");
  assert.match(ui, /callIssuesBox|issueLink|leadCallBox/);
  assert.match(fs.readFileSync(new URL("../public/calling-ui.js", import.meta.url), "utf8"), /leadCallBox/);
});
