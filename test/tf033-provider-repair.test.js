import assert from "node:assert/strict";
import test from "node:test";
import { detectProviderSuggestion } from "../access-provider-registry.js";
import { bridgeAdapter } from "../repair-adapters/router.js";

test("TF-033 Provider-Erkennung: ein starkes Signal wird vorgeschlagen, mehrere oder schwache bleiben verifikationspflichtig", () => {
  assert.deepEqual(detectProviderSuggestion({ cms_platform: "WORDPRESS", cms_confidence: "HIGH" }), {
    provider_id: "WORDPRESS", status: "DETECTED", confidence: "HIGH", evidence: ["cms_platform"],
  });
  assert.equal(detectProviderSuggestion({ deployment_platform: "SHOPIFY", deployment_confidence: "MEDIUM" }).status,
    "PROVIDER_VERIFICATION_REQUIRED");
  assert.equal(detectProviderSuggestion({ cms_platform: "UNKNOWN", cms_confidence: "HIGH" }).provider_id, "CUSTOM");
  assert.equal(detectProviderSuggestion({ cms_platform: "WORDPRESS", cms_confidence: "HIGH", deployment_platform: "NETLIFY", deployment_confidence: "HIGH" }).status,
    "PROVIDER_VERIFICATION_REQUIRED");
});

test("TF-033 gemeinsamer Adaptervertrag: sichere Brücke exponiert plan/create/apply/validate-Namen ohne alten Vertrag zu brechen", async () => {
  const calls = [];
  const contract = {
    detectCapabilities: () => ["BACKUP", "ROLLBACK"],
    checkAccess: async () => ({ ok: true }),
    backup: async () => { calls.push("backup"); return { rollback_point: "synthetic" }; },
    locate: async () => ({ target: "index.html", fix: { kind: "reference" } }),
    applyFix: async () => { calls.push("apply"); return { ok: true }; },
    validate: async () => { calls.push("validate"); return { build_ok: true }; },
    rollback: async () => { calls.push("rollback"); return { ok: true }; },
  };
  const adapter = bridgeAdapter("synthetic", contract);
  for (const method of ["checkAccess", "backup", "createBackup", "locate", "planRepair", "applyFix", "applyRepair", "validate", "validateRepair", "rollback", "detectCapabilities"]) {
    assert.equal(typeof adapter[method], "function", method);
  }
  const order = { order_id: "RF480-20261027-abcdef", domain: "muster.ch", issues: { i1: { type: "broken_link", repair_status: "repaired" } }, plan: [{ issue_id: "i1", fix: {} }] };
  const ctx = { credential: () => ({ secret: "synthetic-secret", access_type: "other" }) };
  assert.deepEqual(await adapter.createBackup(order, {}, ctx), { rollback_point: "synthetic" });
  assert.deepEqual(await adapter.planRepair({ issue_id: "i1" }, order, ctx), { target: "index.html", cause: undefined, planned_change: undefined, risk: "niedrig", required_capabilities: [], before_hash: null, fix: { kind: "reference" } });
  assert.deepEqual(await adapter.applyRepair({ issue_id: "i1" }, order, ctx), { ok: true });
  assert.deepEqual(await adapter.validateRepair(order, ctx), { build_ok: true });
  assert.deepEqual(await adapter.rollback(order, ctx), { ok: true });
  assert.deepEqual(calls, ["backup", "apply", "validate", "rollback"]);
});
