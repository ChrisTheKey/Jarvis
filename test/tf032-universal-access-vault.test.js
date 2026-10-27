// TF-032: universeller, verschlüsselter Zugangstresor – nur synthetische Verträge.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  ACCESS_METHODS,
  PROVIDER_REGISTRY,
  providerProfileForDetection,
  resolveProviderSelection,
  profileCanAutoRepair,
} from "../access-provider-registry.js";
import { createAccessIntakeHandler, memoryIntakeStore, tokenHash } from "../access-intake-api.js";
import { sealEnvelope } from "../access-intake.js";
import { providerRepairGate } from "../repair-workflow.js";
import { fullPaymentGateForOrder } from "../payments.js";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const TOKEN = "u".repeat(43);
const WORKER_TOKEN = "w".repeat(32);
const keyPair = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" });

const response = async (handler, body, worker = false) => {
  const r = await handler(new Request("https://jarvis.test/api/access-intake", {
    method: "POST", headers: { "content-type": "application/json", ...(worker ? { "x-jarvis-worker": WORKER_TOKEN } : {}) }, body: JSON.stringify(body),
  }));
  return { status: r.status, body: await r.json() };
};

test("TF-032 Registry: bekannte Profile sind deklarativ, unbekannte Anbieter bleiben universell und manuell", () => {
  assert.equal(PROVIDER_REGISTRY.WORDPRESS.id, "WORDPRESS");
  assert.equal(PROVIDER_REGISTRY.SHOPIFY.id, "SHOPIFY");
  assert.equal(PROVIDER_REGISTRY.GITLAB.id, "GITLAB");
  assert.ok(ACCESS_METHODS.includes("api_access"));
  assert.ok(ACCESS_METHODS.includes("oauth_connection"));
  assert.ok(ACCESS_METHODS.includes("cloud_iam"));

  assert.equal(providerProfileForDetection({ cms_platform: "WORDPRESS" }).id, "WORDPRESS");
  assert.equal(providerProfileForDetection({ deployment_platform: "NETLIFY" }).id, "NETLIFY");
  assert.equal(providerProfileForDetection({ cms_platform: "UNBEKANNT" }).id, "CUSTOM");

  const custom = resolveProviderSelection({ provider_id: "CUSTOM", provider_name: "Neue Plattform GmbH", access_type: "api_access" });
  assert.deepEqual(custom, { provider_id: "CUSTOM", provider_name: "Neue Plattform GmbH", access_type: "api_access", automation: "manual" });
  assert.equal(profileCanAutoRepair(custom, { wordpress: {} }), false);
  assert.equal(profileCanAutoRepair({ provider_id: "WORDPRESS", automation: "adapter" }, { unrelated: { checkAccess() {} } }), false);
});

test("TF-032 Intake: unbekannter Anbieter wird verschlüsselt erfasst, aber nur als manuelles Metadatum gespeichert", async () => {
  const store = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => store, env: (key) => key === "JARVIS_MAIL_WORKER_TOKEN" ? WORKER_TOKEN : null, now: () => NOW });
  const register = await response(handler, {
    op: "register", order_id: "RF480-20261027-a1b2c3", domain: "unbekannt.test", token_hash: tokenHash(TOKEN),
    expires_at: new Date(+NOW + 3600_000).toISOString(), public_key: publicKey, provider_profile_id: "CUSTOM",
  }, true);
  assert.equal(register.status, 200, JSON.stringify(register.body));

  const info = await response(handler, { op: "info", token: TOKEN });
  assert.equal(info.status, 200);
  assert.equal(info.body.provider_profile.id, "CUSTOM");
  assert.ok(info.body.provider_profiles.some((profile) => profile.id === "SHOPIFY"));
  assert.deepEqual(info.body.access_method_fields.api_access, ["host", "secret", "provider", "notes"]);

  const submit = await response(handler, {
    op: "submit", token: TOKEN, access_type: "api_access", access_domain: "unbekannt.test", consent: true,
    provider: { provider_id: "CUSTOM", provider_name: "Neue Plattform GmbH" },
    envelope: sealEnvelope({ access_type: "api_access", provider_name: "Neue Plattform GmbH", secret: "synthetic-secret" }, publicKey),
  });
  assert.equal(submit.status, 200);
  const pulled = await response(handler, { op: "pull" }, true);
  assert.deepEqual(pulled.body.submissions[0].submission.provider, { provider_id: "CUSTOM", provider_name: "Neue Plattform GmbH", access_type: "api_access", automation: "manual" });
  assert.equal(store.dump().includes("Neue Plattform GmbH"), true);
  assert.equal(store.dump().includes("synthetic-secret"), false);
});

test("TF-032 Formular: Anbieterprofil und unbekannter Anbieter werden ohne unsichere HTML-Injektion erfasst", () => {
  const html = fs.readFileSync(new URL("../public/access.html", import.meta.url), "utf8");
  const script = fs.readFileSync(new URL("../public/access.js", import.meta.url), "utf8");
  assert.match(html, /id="providerProfile"/);
  assert.match(html, /id="providerName"/);
  assert.match(script, /provider_profiles/);
  assert.match(script, /providerProfile/);
  assert.doesNotMatch(script, /innerHTML\s*=\s*info\.provider/);
});

test("TF-032 Reparaturgate: unbekannte oder nicht adapterfähige Anbieter bleiben manuell", () => {
  assert.deepEqual(providerRepairGate({ access_intake: { provider: { provider_id: "CUSTOM", automation: "manual" } } }, { wordpress: { checkAccess() {} } }),
    { ok: false, reason: "provider_manual_review" });
  assert.deepEqual(providerRepairGate({ access_intake: { provider: { provider_id: "SHOPIFY", automation: "manual" } } }, {}),
    { ok: false, reason: "provider_manual_review" });
  assert.deepEqual(providerRepairGate({ access_intake: { provider: { provider_id: "WORDPRESS", automation: "adapter" } } }, { wordpress: { checkAccess() {} } }),
    { ok: true });
  assert.deepEqual(providerRepairGate({ access_intake: { provider: { provider_id: "WORDPRESS", automation: "adapter" } } }, { wordpress: { checkAccess() {} } }, "wordpress"),
    { ok: true });
  assert.deepEqual(providerRepairGate({ access_intake: { provider: { provider_id: "WORDPRESS", automation: "adapter" } } }, { wordpress: { checkAccess() {} } }, "github_netlify"),
    { ok: false, reason: "provider_manual_review" });
  assert.deepEqual(providerRepairGate({ access_intake: { provider: { provider_id: "WORDPRESS", automation: "adapter" } } }, { unrelated: { checkAccess() {} } }),
    { ok: false, reason: "provider_manual_review" });
});

test("TF-032 Vollzahlungs-Gate: CHF-480-Reparatur wartet bis CHF 480 im passenden Zahlungsmodus bestätigt sind", () => {
  const order = { order_id: "RF480-20261027-a1b2c3", offer_class: "REPAIR_FIX_500", test_order: true };
  const ledger = { payments: {
    deposit: { order_id: order.order_id, amount_chf: 240, currency: "CHF", status: "RECEIVED", is_test: true },
  } };
  const store = { read: () => ledger };
  assert.equal(fullPaymentGateForOrder(store, order).satisfied, false);
  assert.equal(fullPaymentGateForOrder(store, order).required_chf, 480);
  ledger.payments.balance = { order_id: order.order_id, amount_chf: 240, currency: "CHF", status: "RECEIVED", is_test: true };
  assert.equal(fullPaymentGateForOrder(store, order).satisfied, true);
  ledger.payments.wrongMode = { order_id: order.order_id, amount_chf: 480, currency: "CHF", status: "RECEIVED", is_test: false };
  assert.equal(fullPaymentGateForOrder(store, order).paid_chf, 480);
});
