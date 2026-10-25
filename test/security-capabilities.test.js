import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, capabilityStatus, assertCapability } from "../security-capabilities.js";

test("P0 capabilities deny every external or productive action by default", () => {
  const status = capabilityStatus({});
  for (const name of CAPABILITIES) assert.equal(status[name], false, name);
  assert.throws(() => assertCapability("gmail_send", { env: {} }), /CAPABILITY_DENIED/);
});

test("synthetic mode permits only the explicitly synthetic test path", () => {
  const env = { JARVIS_CAPABILITY_MODE: "synthetic" };
  assert.equal(assertCapability("crm_write", { env, synthetic: true }).mode, "synthetic");
  assert.throws(() => assertCapability("gmail_send", { env, synthetic: true }), /CAPABILITY_DENIED/);
});

test("production capability requires an explicit allowlist", () => {
  const env = { JARVIS_CAPABILITY_MODE: "approved", JARVIS_CAPABILITIES: "crm_write,gmail_send" };
  assert.equal(assertCapability("gmail_send", { env }).mode, "approved");
  assert.throws(() => assertCapability("calling_live", { env }), /CAPABILITY_DENIED/);
});
