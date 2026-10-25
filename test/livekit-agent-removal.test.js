import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("autonomous call.start is explicitly unavailable while human CRM calling remains", () => {
  const api = read("calling-api.js");
  assert.match(api, /AUTONOMOUS_CALLING_REMOVED/);
  const crm = read("public/crm.js");
  for (const action of ["crm.addCall", "crm.addNote", "crm.setNextAction", "crm.updateCallStatus"]) assert.match(crm, new RegExp(action.replace(".", "\\.")));
});

test("no active application or dependency path retains LiveKit Agents", () => {
  const files = ["calling/agent.js", "calling/service.js", "calling/package.json", "calling/package-lock.json", "deploy/vps/Dockerfile.calling", "deploy/vps/calling/docker-compose.yml"];
  for (const file of files) assert.equal(fs.existsSync(new URL(`../${file}`, import.meta.url)), false, file);
});
