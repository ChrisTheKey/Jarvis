import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, capabilityStatus, assertCapability, assertExternalCapability } from "../security-capabilities.js";

test("P0 capabilities deny every external or productive action by default", () => {
  const status = capabilityStatus({});
  for (const name of CAPABILITIES) assert.equal(status[name], false, name);
  assert.throws(() => assertCapability("gmail_send", { env: {} }), /CAPABILITY_DENIED/);
});

test("synthetic mode permits only explicitly marked synthetic adapters", () => {
  const env = { JARVIS_CAPABILITY_MODE: "synthetic" };
  assert.equal(assertCapability("crm_write", { env, synthetic: true }).mode, "synthetic");
  assert.equal(assertCapability("gmail_send", { env, synthetic: true }).mode, "synthetic");
  assert.throws(() => assertCapability("gmail_send", { env }), /CAPABILITY_DENIED/);
});

test("production capability requires an explicit allowlist", () => {
  const env = { JARVIS_CAPABILITY_MODE: "approved", JARVIS_CAPABILITIES: "crm_write,gmail_send" };
  assert.equal(assertCapability("gmail_send", { env }).mode, "approved");
  assert.throws(() => assertCapability("calling_live", { env }), /CAPABILITY_DENIED/);
});

test("real local adapters remain denied while synthetic adapters are allowed", () => {
  assert.throws(() => assertExternalCapability("paid_api", { env: {} }), /CAPABILITY_DENIED/);
  assert.equal(assertExternalCapability("paid_api", { env: { JARVIS_CAPABILITY_MODE: "synthetic" }, synthetic: true }).mode, "synthetic");
  assert.equal(assertExternalCapability("paid_api", { env: { JARVIS_RUNTIME: "production" } }).mode, "production");
});
