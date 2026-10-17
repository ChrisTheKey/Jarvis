// TF-053 DO-NOT-CONTACT IM MAIL-WORKER: lead_crm.json (CRM-Dienst = einziger Schreiber) wird nur gelesen und sperrt neue Cold-Entwürfe
// (Discovery-Queue, Gmail-Draft-Worker, Cloud-Einzelentwurf). Fail-safe: CRM eingebunden, aber fehlend/unlesbar/ungültig → Cold Outreach
// angehalten (Queue bleibt queued). Transaktionale Kunden-Mails (Repair-Outbox) lesen das CRM nie. Nur Attrappen – kein Netz, kein Gmail.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDiscovery } from "../lead-finder.js";
import { createWorker, createStore, coldDraftFromCloud } from "../mail-worker.js";
import { REVIEWS_FILE, COLD_MODE } from "../swiss-repair.js";
import { registryBlock, crmDoNotContact, loadRegistry, CRM_UNAVAILABLE } from "../lead-registry.js";
import { CRM_SCHEMA, emptyCrmState } from "../lead-crm.js";
import { createOutboxMailer, processRepairOutbox } from "../repair-outbox.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-14T08:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
let dir, crm, g, store;
const made = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const readJ = (name, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fb; } };
const reviews = () => readJ(REVIEWS_FILE, { reviews: {} }).reviews;
const setCrm = (dnc = []) => { const s = emptyCrmState(T0); for (const id of dnc) s.leads[id] = { lead_id: id, do_not_contact: true, do_not_contact_at: T0.toISOString() }; fs.writeFileSync(path.join(crm, "lead_crm.json"), JSON.stringify(s)); };
function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, calls: [], n: 0 };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async createDraft({ to, mode, leadId }) { f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "t" + id, to, mode, leadId, createdAt: T0.toISOString() }; return { draftId: id, threadId: "t" + id, messageId: "m" + id }; },
    async sendDraft(id) { f.calls.push("SEND " + id); throw new Error("COLD_LEAD_DRAFT_ONLY – nicht sendbar"); },
    async syncColdDrafts() { return []; }, async readThread() { return { messages: [] }; }, async updateDraft() { f.calls.push("UPDATE"); }, async deleteDraft() { f.calls.push("DELETE"); }, async markDraftForReview() {},
  });
  return f;
}
const worker = () => createWorker({ dir, gmail: g, now: () => T0, log: () => {}, compose: async () => ({ decision: "draft", subject: "Re", body: "Guten Tag." }) });
const review = (h, extra = {}) => ({ lead_id: h, domain: h, company: `${h.split(".")[0]} AG`, recipient: `info@${h}`, subject: "Hinweis zu Ihrer Website", body: "Guten Tag", draft_hash: "h", status: "queued",
  draft_mode: COLD_MODE, legal_basis: "NONE", message_class: "DRAFT_ONLY", automatic_send_allowed: false, manual_send_decision_required: true, offer_class: "REPAIR_FIX_500", repair_fit_score: 72,
  customer_findings: [{ key: "broken_link", text: "Der Link «Unser Team» führt auf eine Seite, die nicht mehr existiert." }], created_at: T0.toISOString(), updated_at: T0.toISOString(), ...extra });
const queue = (...hosts) => write(REVIEWS_FILE, { reviews: Object.fromEntries(hosts.map((h) => [h, review(h)])) });

beforeEach(() => {
  dir = tmp("jarvis-dnc053-"); crm = tmp("jarvis-dnc053-crm-"); store = createStore(dir); g = fakeGmail();
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, excludeAddresses: [SENDER.email], discovery: { draftPaceMs: 0, intervalMinutes: 0 } });
  write("suppression.json", {});
  process.env.JARVIS_CRM_DIR = crm;
});
afterEach(() => { delete process.env.JARVIS_CRM_DIR; });
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test("A: bekannter Lead ohne DNC → Cold-Draft-Logik unverändert (Gmail-ENTWURF, nie gesendet)", async () => {
  setCrm(["andere.ch"]);
  queue("normal.ch");
  await worker().tick();
  assert.equal(reviews()["normal.ch"].status, "draft_created");
  assert.deepEqual(g.calls, ["create info@normal.ch"]);
});

test("B + C: CRM do_not_contact=true → kein neuer Cold-Draft (Gmail-Worker), keine Cold-Outreach-Queue (Cloud-Einzelentwurf, Discovery)", async () => {
  setCrm(["dnc.ch"]);
  queue("dnc.ch", "frei.ch");
  await worker().tick();
  assert.equal(reviews()["dnc.ch"].status, "blocked"); assert.equal(reviews()["dnc.ch"].blocked_reason, "Lead-Datenbank: do-not-contact (CRM)");
  assert.equal(reviews()["frei.ch"].status, "draft_created", "nur die DNC-Firma ist betroffen");
  assert.ok(!g.calls.includes("create info@dnc.ch"), "kein Gmail-Entwurf für DNC");
  // Treffer auch über Domain/Adresse statt lead_id, Gross-/Kleinschreibung egal
  assert.equal(registryBlock(store, { domain: "DNC.ch", email: "info@dnc.ch" }), "do-not-contact (CRM)");
  // C: Cloud → Queue: kein neuer queued-Eintrag
  write("leads.json", [{ email: "kontakt@dnc-cloud.ch", company: "DNC Cloud AG", website: "https://dnc-cloud.ch", domain: "dnc-cloud.ch" }]);
  setCrm(["dnc.ch", "dnc-cloud.ch"]);
  const r = await coldDraftFromCloud({ op: "create", leadId: "dnc-cloud.ch", gmail: g, dir, now: T0 });
  assert.equal(r.ok, false); assert.equal(r.error, "Blockiert (Lead-Datenbank): do-not-contact (CRM)");
  assert.equal(reviews()["dnc-cloud.ch"], undefined, "keine Cold-Outreach-Queue");
  // C: Discovery-Queue nutzt dasselbe Gate (registryBlock) direkt vor ensureColdDraft
  assert.match(read("lead-finder.js"), /const dbBlock = tracked \? registryBlock\(/);
  assert.match(read("lead-finder.js"), /if \(!dbBlock && lead\.status === "blocked_no_legal_basis"/);
});

test("D: DNC → keine Anruf-/Follow-up-/Outreach-Empfehlung (CRM-Modell)", async () => {
  const { callRecommended, inOutreachQueue, nextBestLead } = await import("../public/crm-model.js");
  const l = { lead_id: "dnc.ch", phone: "+41 31 000 00 00", do_not_contact: true, sales_stage: "FOLLOW_UP", call_status: "NOT_CALLED" };
  assert.equal(callRecommended(l), false); assert.equal(inOutreachQueue(l), false);
  assert.equal(nextBestLead([l]), null);
  assert.equal(callRecommended({ ...l, do_not_contact: false }), true, "ohne DNC wäre der Anruf empfohlen");
});

test("E: transaktionale Kunden-Mail (Repair-Outbox) wird von Cold-DNC und kaputtem CRM nicht blockiert – genau einmal zugestellt", async () => {
  fs.writeFileSync(path.join(crm, "lead_crm.json"), "{ kaputt");
  assert.equal(crmDoNotContact(), null);
  const ob = tmp("jarvis-dnc053-ob-"), m = createOutboxMailer({ dir: ob });
  const sent = [], og = { listOwned: () => ({ sent: {}, drafts: {} }), createDraft: async (x) => { sent.push(x.to); return { draftId: "d" + sent.length }; }, sendDraft: async (id) => ({ messageId: "m-" + id }) };
  const d = await m.createDraft({ to: "auftrag@dnc.ch", subject: "Ihr Bericht", body: "Bericht", messageClass: "REPAIR_DELIVERY" }).catch(() => m.createDraft({ to: "auftrag@dnc.ch", subject: "Ihr Bericht", body: "Bericht", messageClass: "CUSTOMER_ACCESS_REQUEST" }));
  await m.sendDraft(d.draftId).catch(() => {});
  const r = await processRepairOutbox({ dir: ob, gmail: og });
  for (let i = 0; i < 2; i++) await processRepairOutbox({ dir: ob, gmail: og });
  assert.equal(r.sent, 1); assert.deepEqual(sent, ["auftrag@dnc.ch"], "exactly-one delivery");
  // Das CRM-Gate steckt nur in den Cold-Pfaden
  for (const f of ["repair-outbox.js", "email-permission.js", "sales.js", "repair-workflow.js", "check-150-workflow.js"]) assert.doesNotMatch(read(f), /registryBlock|crmDoNotContact|JARVIS_CRM_DIR|lead_crm/, f);
  const mw = read("mail-worker.js");
  // TF-077B: + Verkäufer-Versand des vorbereiteten Cold-Entwurfs (SEND_PREPARED_LEAD_DRAFT) – ebenfalls ein Cold-Pfad, fail closed.
  assert.equal((mw.match(/registryBlock\(/g) || []).length, 3, "nur Draft-Worker + Cloud-Einzelentwurf + Verkäufer-Versand");
});

test("F: CRM fehlt / unlesbar / ungültig / unbekanntes Schema → fail-safe: Cold Outreach angehalten, Queue bleibt queued, nichts dauerhaft blockiert", async () => {
  const cases = { fehlt: null, kaputt: "{ kaputt", array: JSON.stringify({ schema: 1, leads: [] }), ohneLeads: JSON.stringify({ schema: 1 }), schema: JSON.stringify({ schema: CRM_SCHEMA + 1, leads: {} }), nullJson: "null" };
  for (const [name, content] of Object.entries(cases)) {
    const f = path.join(crm, "lead_crm.json");
    fs.rmSync(f, { force: true }); if (content !== null) fs.writeFileSync(f, content);
    assert.equal(crmDoNotContact(), null, name);
    assert.equal(registryBlock(store, { domain: "frei.ch" }), CRM_UNAVAILABLE, name);
  }
  queue("frei.ch");
  await worker().tick();
  assert.equal(reviews()["frei.ch"].status, "queued", "gehalten, nicht blockiert");
  assert.equal(g.calls.length, 0, "kein Gmail-Aufruf");
  write("leads.json", [{ email: "info@frei-cloud.ch", company: "Frei Cloud AG", website: "https://frei-cloud.ch", domain: "frei-cloud.ch" }]);
  const r = await coldDraftFromCloud({ op: "create", leadId: "frei-cloud.ch", gmail: g, dir, now: T0 });
  assert.equal(r.error, `Blockiert (Lead-Datenbank): ${CRM_UNAVAILABLE}`);
  assert.equal(reviews()["frei-cloud.ch"], undefined);
  const disc = await runDiscovery({ dir, gmail: g, search: async () => { throw new Error("darf nicht suchen"); }, auditor: { audit: async () => { throw new Error("x"); } }, now: () => T0, log: () => {}, pid: process.pid });
  assert.equal(disc.skipped, "crm_unavailable");
  // CRM wieder lesbar → der gehaltene Eintrag läuft normal weiter
  setCrm([]);
  await worker().tick();
  assert.equal(reviews()["frei.ch"].status, "draft_created");
  // Stale Cache wird nie benutzt: lesbar (DNC) → kaputt → fail-safe statt altem Stand
  setCrm(["x.ch"]); assert.equal(crmDoNotContact().has("x.ch"), true);
  fs.writeFileSync(path.join(crm, "lead_crm.json"), "{ kaputt, aber länger");
  assert.equal(crmDoNotContact(), null);
  // Ohne JARVIS_CRM_DIR (Windows/Tests ohne CRM) bleibt alles wie vorher
  delete process.env.JARVIS_CRM_DIR;
  assert.equal(crmDoNotContact().size, 0); assert.equal(registryBlock(store, { domain: "frei.ch" }, { leads: {} }), null);
});

test("G: lead_crm.json im Mail-Worker nur read-only (Compose-Mount :ro, read_only-Container, kein Schreibzugriff im Code)", () => {
  const compose = read("deploy/vps/docker-compose.yml");
  assert.match(compose, /- \/opt\/jarvis-mail\/data:\/data\/crm:ro/);
  assert.match(compose, /JARVIS_CRM_DIR: \/data\/crm/);
  assert.match(compose, /read_only: true/);
  const reader = read("lead-registry.js").match(/export function crmDoNotContact[\s\S]*?\n}\n/)[0];
  assert.doesNotMatch(reader, /fs\.(write|append|rename|unlink|rm|copyFile|mkdir|open)\w*\(/, "nur statSync/readFileSync");
  for (const f of ["mail-worker.js", "lead-finder.js"]) assert.doesNotMatch(read(f), /lead_crm|JARVIS_CRM_DIR/, `${f} greift nie selbst auf die CRM-Datei zu`);
  // lead-crm.js ist nicht im Mail-Worker-Image: lead-registry.js darf es nicht importieren; Schema-Konstante muss gleich sein
  assert.doesNotMatch(read("deploy/vps/Dockerfile"), /lead-crm\.js/);
  assert.doesNotMatch(read("lead-registry.js"), /from "\.\/lead-crm\.js"|from "\.\/public\//);
  assert.match(read("lead-registry.js"), new RegExp(`const CRM_SCHEMA = ${CRM_SCHEMA};`));
  for (const m of read("lead-registry.js").matchAll(/from "\.\/([\w-]+\.js)"/g)) assert.match(read("deploy/vps/Dockerfile"), new RegExp(`\\b${m[1].replace(".", "\\.")}\\b`), `${m[1]} im Image`);
});

test("H: 0 automatische Sends, keine Änderung bestehender Entwürfe durch die Tests", async () => {
  setCrm(["dnc.ch"]);
  queue("dnc.ch", "frei.ch");
  await worker().tick(); await worker().tick();
  assert.ok(!g.calls.some((c) => /^(SEND|UPDATE|DELETE)/.test(c)), g.calls.join(","));
  assert.equal(Object.keys(g.reg.sent).length, 0);
  assert.equal(loadRegistry(store).leads["dnc.ch"]?.gmail_draft_status ?? "none", "none");
});
