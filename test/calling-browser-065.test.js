import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("TF-065 browser calling UI remains a manual employee dashboard", () => {
  const ui = fs.readFileSync(new URL("../public/calling-ui.js", import.meta.url), "utf8");
  assert.match(ui, /mountCalling|leadCallBox|manuelle/);
  assert.doesNotMatch(ui, /LiveKit|Calling Agent|campaign\.start|call\.start/);
});
