import { test } from "node:test";
import assert from "node:assert/strict";
import { splitCrmView } from "../crm-service.js";
import { createCrmHandler, crmAgentToken } from "../crm-api.js";
import { memoryStore } from "../shared-state.js";

function lead(i) {
  return { lead_id: `lead-${i}.ch`, domain: `lead-${i}.ch`, company: `Lead ${i}`, errors: { count: 1, top: [{ key: "x", text: "x" }] } };
}

test("CRM view pagination splits 2001 leads into bounded upload pages without loss or duplicates", () => {
  const view = { leads: Array.from({ length: 2001 }, (_, i) => lead(i)), total: 2001, generated_at: "2026-10-24T00:00:00.000Z", stats: { all: 2001 } };
  const pages = splitCrmView(view, 20000);
  assert.ok(pages.length > 1);
  assert.equal(pages.reduce((n, p) => n + p.leads.length, 0), 2001);
  assert.equal(new Set(pages.flatMap((p) => p.leads.map((l) => l.lead_id))).size, 2001);
  for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify({ op: "pull", view_page: page })) < 20000);
  assert.equal(pages[0].page_count, pages.length);
  assert.equal(pages.at(-1).page_index, pages.length - 1);
});

test("CRM API commits paged upload atomically after the final page", async () => {
  const queue = memoryStore(), view = memoryStore(), control = "c".repeat(48);
  const handler = createCrmHandler({ getQueueStore: async () => queue, getViewStore: async () => view,
    env: (key) => key === "JARVIS_SERVER_CONTROL_TOKEN" ? control : undefined });
  const source = { leads: Array.from({ length: 2001 }, (_, i) => ({ ...lead(i), errors: { count: 1, items: [{ key: "x", text: "confirmed" }], audit: "FULL" } })) };
  const pages = splitCrmView({ ...source, total: 2001, generated_at: "2026-10-24T00:00:00.000Z" }, 20000);
  const post = async (body) => handler(new Request("https://jarvis.test/api/crm", { method: "POST", headers: { "content-type": "application/json", "x-jarvis-crm": crmAgentToken(control) }, body: JSON.stringify(body) }));
  for (let i = 0; i < pages.length; i++) {
    const response = await post({ op: "pull", view_page: pages[i] });
    assert.equal(response.status, 200);
    if (i < pages.length - 1) assert.equal((await response.json()).upload_complete, false);
  }
  const stored = (await view.get()).state;
  assert.equal(stored.leads.length, 2001);
  assert.equal(new Set(stored.leads.map((l) => l.lead_id)).size, 2001);
  assert.equal(stored._crm_page_uploads, undefined);
});
