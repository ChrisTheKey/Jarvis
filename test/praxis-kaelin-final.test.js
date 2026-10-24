import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyCrmAction, buildCrmView, cleanCrmLead, emptyCrmState, validateCrmAction } from "../lead-crm.js";
import { createCrmAgent } from "../crm-service.js";
import { createCrmHandler, crmAgentToken } from "../crm-api.js";
import { crmStats, isTestLead, sortLeads } from "../public/crm-model.js";
import { memoryStore } from "../shared-state.js";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const DOMAIN = "praxis-kaelin.netlify.app";
const EMAIL = "helvetic.webdesign@proton.me";
const FINDINGS = [
  { key: "PK-001", type: "contact_page_broken", text: "Der Link #kontakt erreicht den Kontaktbereich nicht.", page: "https://praxis-kaelin.netlify.app/", severity: "high", confirmed: true },
  { key: "PK-002", type: "javascript_error", text: "Der Footer-Jahreswert verursacht einen JavaScript-Fehler.", page: "https://praxis-kaelin.netlify.app/", severity: "high", confirmed: true },
  { key: "PK-003", type: "mobile_content_cut_off", text: "Die Notfall-Kacheln sind auf schmalen Mobilansichten abgeschnitten.", page: "https://praxis-kaelin.netlify.app/", severity: "medium", confirmed: true },
  { key: "PK-004", type: "broken_link", text: "Die rechtlichen Footer-Links führen auf keinen Inhalt.", page: "https://praxis-kaelin.netlify.app/", severity: "medium", confirmed: true },
  { key: "PK-005", type: "button_broken", text: "Der mobile Menübutton hat keine zugängliche Beschriftung bzw. keinen Zustand.", page: "https://praxis-kaelin.netlify.app/", severity: "medium", confirmed: true },
];
const PARAMS = {
  name: "Praxis Kälin", domain: DOMAIN, email: EMAIL, source: "MANUAL_TEST", lead_type: "WEBSITE_REPAIR",
  environment: "TEST", priority: "HIGH", status: "MANUAL_TEST_AUTHORIZED", checked_at: NOW.toISOString(), findings: FINDINGS,
  repair_offer: { check_chf: 150, repair_chf: 480, check_link: "https://buy.stripe.com/test_dRm3cw5A5fo3caR9ov7Re00", repair_link: "https://buy.stripe.com/test_7sY00k5A54JpcaR1W37Re01" },
};
const REQ = "11111111-1111-4111-8111-111111111111";

const sources = () => ({ registry: { leads: {} }, directory: { leads: {} }, reviews: {}, gmail: { drafts: {}, sent: {} },
  siteFindings: { domains: {} }, repairFindings: { orders: {} }, history: { leads: {} }, contactForms: { leads: {} },
  phonebookCache: null, phonebookProvider: { configured: false } });

test("Manual lead: Payload, Befunde und TEST-Angebote werden streng validiert", () => {
  const ok = validateCrmAction({ action: "crm.createManualLead", params: PARAMS }, { now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(ok.params.domain, DOMAIN);
  assert.equal(ok.params.findings.length, 5);
  assert.equal(validateCrmAction({ action: "crm.createManualLead", params: { ...PARAMS, domain: "https://evil.example/x" } }, { now: NOW }).code, "BAD_PARAMS");
  assert.equal(validateCrmAction({ action: "crm.createManualLead", params: { ...PARAMS, findings: [] } }, { now: NOW }).code, "BAD_PARAMS");
  assert.equal(validateCrmAction({ action: "crm.createManualLead", params: { ...PARAMS, email: "one@example.test, two@example.test" } }, { now: NOW }).code, "BAD_PARAMS");
  assert.equal(validateCrmAction({ action: "crm.createManualLead", params: { ...PARAMS, unexpected: true } }, { now: NOW }).code, "BAD_PARAMS");
});

test("Manual lead: autoritatives Upsert ist domain-dedupliziert und request-idempotent", () => {
  const state = emptyCrmState(NOW);
  const req = { request_id: REQ, action: "crm.createManualLead", params: PARAMS };
  const first = applyCrmAction(state, req, { now: NOW, lookup: () => null, findByDomain: () => null });
  assert.equal(first.ok, true);
  assert.equal(first.lead_id, DOMAIN);
  assert.equal(state.leads[DOMAIN].manual.status, "MANUAL_TEST_AUTHORIZED");
  assert.equal(state.leads[DOMAIN].manual.findings.length, 5);
  assert.equal(applyCrmAction(state, req, { now: NOW, lookup: () => null, findByDomain: () => null }).duplicate, true);
  const foreign = applyCrmAction(emptyCrmState(NOW), { ...req, request_id: "22222222-2222-4222-8222-222222222222" },
    { now: NOW, lookup: () => null, findByDomain: () => ({ lead_id: "anderer.ch", is_test: false }) });
  assert.equal(foreign.code, "DOMAIN_EXISTS");
});

test("Manual lead: CRM-Sicht ist aktiv, sichtbar als TEST, in Statistiken ausgeschlossen und standardmässig ganz oben", () => {
  const state = emptyCrmState(NOW);
  applyCrmAction(state, { request_id: REQ, action: "crm.createManualLead", params: PARAMS }, { now: NOW, lookup: () => null, findByDomain: () => null });
  const view = buildCrmView({ ...sources(), crm: state }, NOW);
  const lead = view.leads.find((l) => l.domain === DOMAIN);
  assert.ok(lead);
  assert.equal(lead.company, "Praxis Kälin");
  assert.equal(lead.email, EMAIL);
  assert.equal(lead.findings_total, 5);
  assert.equal(lead.errors.count, 5);
  assert.equal(lead.is_test, true);
  assert.equal(lead.environment, "TEST");
  assert.equal(lead.manual_test.status, "MANUAL_TEST_AUTHORIZED");
  assert.equal(isTestLead(lead), true);
  const stats = crmStats([cleanCrmLead(lead)], NOW);
  assert.equal(stats.test_leads, 1);
  assert.equal(stats.all, 0);
  assert.equal(stats.verified_error_leads, 0);
  assert.equal(stats.customers, 0);
  const normal = cleanCrmLead({ lead_id: "normal.ch", company: "Normal", errors: { audit: "FULL", count: 1, items: [{ key: "n", text: "x" }] }, priority: { score: 99, level: "HIGH", reasons: [] } });
  assert.equal(sortLeads([normal, cleanCrmLead(lead)], "priority", NOW)[0].domain, DOMAIN);
});

test("Manual lead: Cloud-API akzeptiert nur OWNER, queued sicher und der Agent publiziert denselben Lead", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-praxis-kaelin-") );
  const qs = memoryStore(), vs = memoryStore();
  const control = "c".repeat(48), password = "pw-test";
  const handler = createCrmHandler({ getQueueStore: async () => qs, getViewStore: async () => vs,
    env: (key) => ({ JARVIS_SERVER_CONTROL_TOKEN: control, JARVIS_PASSWORD: password })[key], now: () => NOW });
  const call = async (method, body = null, query = "") => {
    const r = await handler(new Request(`https://jarvis.test/api/crm${query}`, { method, headers: { "x-jarvis-key": password, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const denied = await handler(new Request("https://jarvis.test/api/crm", { method: "POST", headers: { "content-type": "application/json", "x-jarvis-key": password }, body: JSON.stringify({ action: "crm.createManualLead", params: PARAMS }) }));
  assert.equal(denied.status, 503, "ohne CRM-Agent darf nichts lokal gespeichert werden");
  const q0 = await qs.get();
  await qs.set({ ...(q0.state || {}), requests: [], audit: [], rate: [], agent_seen_at: NOW.toISOString() }, q0.etag);
  const queued = await call("POST", { action: "crm.createManualLead", params: PARAMS });
  assert.equal(queued.status, 202);
  const agent = createCrmAgent({ dataDir: root, sources, url: "https://jarvis.test", token: crmAgentToken(control), fetchFn: async (url, init) => handler(new Request(url, init)), now: () => NOW });
  assert.ok(agent);
  assert.equal((await agent.pollOnce()).handled, 1);
  await agent.pollOnce();
  const listed = await call("GET", null, "?watch=1");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.leads.find((l) => l.domain === DOMAIN).is_test, true);
});
