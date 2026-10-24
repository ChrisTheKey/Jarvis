// TF-053 Jarvis Lead-CRM: Sicht aus bestehenden Quellen, CRM-Zustand, Allowlist-Aktionen, Concurrency, Cloud-API, Backup, Export.
// Nur synthetische Daten (test/crm-fixture.js), kein Netz, keine echten Leads, kein Senden.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { makeSources, writeSources, bump } from "./crm-fixture.js";
import { buildCrmView, buildCrmLead, validateCrmAction, applyCrmAction, emptyCrmState, cleanCrmLead, crmUniverse, CRM_ACTIONS, CRM_FILE, findingsOf } from "../lead-crm.js";
import { applyRequest, createSourceReader, loadCrm, withCrmLock, createCrmAgent, crmBackup, BACKUP_FILES } from "../crm-service.js";
import { createCrmHandler, crmAgentToken } from "../crm-api.js";
import { crmToCsv, CSV_COLUMNS, filterLeads, sortLeads, crmStats, followUpBucket, priorityOf, callRecommended, inOutreachQueue, nextBestLead, splitFindings, searchMatch } from "../public/crm-model.js";
import { memoryStore } from "../shared-state.js";
import { createBackup, decryptBackup, restoreTo, verifyBackup } from "../backup.js";
import { registryBlock, crmDoNotContact } from "../lead-registry.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const NOW = new Date("2026-10-14T10:00:00Z");
const rid = () => crypto.randomUUID();
const svc = (n = 387) => { const src = makeSources(n); const dirs = writeSources(src); return { src, ...dirs, sources: createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail }) }; };
const view = (s) => buildCrmView({ ...s.sources(), crm: loadCrm(s.data) }, NOW);
const lead = (s, id) => buildCrmLead(id, { ...s.sources(), crm: loadCrm(s.data) }, NOW);
const write = (s, action, params, extra = {}) => applyRequest({ dataDir: s.data, sources: s.sources, req: { request_id: rid(), action, params }, now: NOW, ...extra });

// ---------- A–D: Sicht aus den bestehenden Quellen ----------
test("A: 387 bestehende Leads erscheinen ohne Migration, ohne Duplikate, mit korrekten Default-Stufen", () => {
  const s = svc();
  const v = view(s);
  assert.equal(v.total, 387);
  assert.equal(new Set(v.leads.map((l) => l.lead_id)).size, 387);
  assert.equal(fs.existsSync(path.join(s.data, CRM_FILE)), false, "keine CRM-Datei nötig – nur zur Laufzeit zusammengeführt");
  const by = Object.fromEntries(v.leads.map((l) => [l.lead_id, l]));
  assert.equal(by["firma-000.ch"].sales_stage, "CONTACTED", "manual_sent → CONTACTED");
  assert.equal(by["firma-010.ch"].sales_stage, "CUSTOMER", "Kunde → CUSTOMER");
  assert.equal(by["firma-011.ch"].sales_stage, "DO_NOT_CONTACT", "bestehende DNC respektiert");
  assert.equal(by["firma-011.ch"].dnc_source, "registry");
  assert.equal(by["firma-020.ch"].sales_stage, "DRAFT_READY", "Gmail-Entwurf → DRAFT_READY");
  assert.ok(by["firma-020.ch"].draft_url.startsWith("https://mail.google.com/mail/u/0/#drafts?compose="));
  assert.equal(by["firma-000.ch"].draft_url, null, "kein Entwurfs-Link ohne bestehenden Entwurf");
  assert.equal(by["firma-001.ch"].phone_tel, "tel:+41311234567");
  assert.equal(by["firma-004.ch"].first_name, "Anna");
  assert.equal(by["firma-012.ch"].website_reachable, false);
  const counts = { DRAFT_READY: 0, CONTACTED: 0 }; for (const l of v.leads) if (counts[l.sales_stage] !== undefined) counts[l.sales_stage]++;
  assert.equal(counts.CONTACTED, 7); assert.equal(counts.DRAFT_READY, 387 - 7 - 2);
});

test("B: neuer Lead erscheint automatisch (Kontaktverzeichnis/Cold-Register wächst)", () => {
  const s = svc(5);
  assert.equal(view(s).total, 5);
  bump(path.join(s.data, "lead_contact_directory.json"), (d) => { d.leads["neu-firma.ch"] = { lead_id: "neu-firma.ch", company_name: "Neu GmbH", domain: "neu-firma.ch", email: "info@neu-firma.ch", draft_status: "DRAFT" }; });
  // TF-076: ohne verifizierten Website-Fehler noch kein aktiver CRM-Lead (nur Prüfkandidat) – erst der Audit mit Fehler nimmt ihn auf.
  assert.equal(view(s).total, 5);
  assert.equal(buildCrmLead("neu-firma.ch", { ...s.sources(), crm: loadCrm(s.data) }).admission, "AUDIT_RETRY_REQUIRED");
  fs.writeFileSync(path.join(s.data, "site_findings.json"), JSON.stringify({ schema: 1, domains: { "neu-firma.ch": { domain: "neu-firma.ch", full: { domain: "neu-firma.ch", complete: true, audited_at: new Date().toISOString(),
    findings: [{ key: "link|neu-firma.ch/alt", type: "broken_link", category: "http", text: "Link führt auf eine Fehlerseite", page: "https://neu-firma.ch/", target: "https://neu-firma.ch/alt", severity: "medium", status: "OPEN" }] } } } }));
  const v = view(s);
  assert.equal(v.total, 6);
  const l = v.leads.find((x) => x.lead_id === "neu-firma.ch");
  assert.equal(l.sales_stage, "DRAFT_READY"); assert.equal(l.company, "Neu GmbH");
});

test("C: Kontaktanreicherung (Telefon/Person/Rolle) erscheint im CRM ohne eigenen Datensatz", () => {
  const s = svc(5);
  write(s, "crm.addNote", { lead_id: "firma-000.ch", text: "vorher" });
  assert.equal(lead(s, "firma-000.ch").phone, null);
  bump(path.join(s.data, "lead_contact_directory.json"), (d) => Object.assign(d.leads["firma-000.ch"], { phone: "+41 44 555 66 77", phone_normalized: "+41445556677", first_name: "Max", last_name: "Beispiel", role: "Geschäftsführer" }));
  const l = lead(s, "firma-000.ch");
  assert.equal(l.phone, "+41 44 555 66 77"); assert.equal(l.phone_tel, "tel:+41445556677"); assert.equal(l.first_name, "Max"); assert.equal(l.role, "Geschäftsführer");
  const crm = JSON.parse(fs.readFileSync(path.join(s.data, CRM_FILE), "utf8")).leads["firma-000.ch"];
  for (const k of ["phone", "email", "first_name", "last_name", "role", "company"]) assert.equal(k in crm, false, `${k} wird nicht kopiert`);
});

test("D: Finding-Update aktualisiert das CRM (Anzahl, Text, Seite)", () => {
  const s = svc(5);
  const file = path.join(s.mail, "mail_worker", "individual_reviews.json");
  assert.equal(lead(s, "firma-003.ch").findings_confirmed, 1);
  bump(file, (j) => { j.reviews["firma-003.ch"].customer_findings.push({ key: "warning", text: "Beim Öffnen Ihrer Website zeigt der Browser zuerst eine Warnmeldung an", internal_refs: [{ issue_type: "https_certificate", url: "https://firma-003.ch/" }] }); });
  let l = lead(s, "firma-003.ch");
  assert.equal(l.findings_confirmed, 2);
  assert.equal(l.findings[0].page, "https://firma-003.ch/team", "betroffene Seite aus der Evidence");
  bump(file, (j) => { j.reviews["firma-003.ch"].customer_findings = []; j.reviews["firma-003.ch"].issue_evidence = []; });
  l = lead(s, "firma-003.ch");
  assert.equal(l.findings_total, 0);
});

test("Befunde: 0/1/2–3/4+ – Top 3 prominent, Rest unter „Weitere Probleme“; Audit-Zusatz ohne technische Diagnose", () => {
  const f = (n) => Array.from({ length: n }, (_, i) => ({ text: `P${i}` }));
  assert.deepEqual(splitFindings([]), { top: [], more: [], total: 0 });
  assert.equal(splitFindings(f(1)).top.length, 1);
  assert.equal(splitFindings(f(3)).more.length, 0);
  const s5 = splitFindings(f(5)); assert.equal(s5.top.length, 3); assert.equal(s5.more.length, 2);
  const rv = makeSources(3).reviews["firma-002.ch"];
  const out = findingsOf(rv, null);
  assert.equal(out[0].status, "BESTÄTIGT");
  const extra = out.find((x) => x.status === "AUDIT");
  assert.ok(extra, "ungedeckter, sichtbarer Audit-Befund erscheint zusätzlich");
  assert.equal(/HTTP|404|mailto/i.test(extra.text), false, "keine technische Diagnose im Text");
  assert.equal(extra.page, "https://firma-002.ch/impressum");
});

// ---------- E–H: CRM-Schreibaktionen, persistent ----------
test("E: Stage-Änderung persistent (neu geladen von Platte)", () => {
  const s = svc(5);
  const r = write(s, "crm.updateStage", { lead_id: "firma-001.ch", stage: "CHECK_150_INTEREST" });
  assert.equal(r.ok, true);
  const s2 = { ...s, sources: createSourceReader({ dataDir: s.data, mailDir: s.mail }) };
  assert.equal(lead(s2, "firma-001.ch").sales_stage, "CHECK_150_INTEREST");
  assert.equal(lead(s2, "firma-001.ch").stage_auto, false);
});

test("F: Anruf-Log persistent – Status, letzter Kontakt, Stufe, Follow-up", () => {
  const s = svc(5);
  const r = write(s, "crm.addCall", { lead_id: "firma-001.ch", at: "2026-10-14T09:30:00.000Z", result: "SPOKE_TO_DECISION_MAKER", note: "Rückfrage zu CHF 150", next_action: "Angebot schicken", follow_up_at: "2026-10-16" });
  assert.equal(r.ok, true);
  const l = lead(s, "firma-001.ch");
  assert.equal(l.call_history.length, 1); assert.equal(l.call_history[0].note, "Rückfrage zu CHF 150");
  assert.equal(l.call_status, "SPOKE_TO_DECISION_MAKER"); assert.equal(l.contact_status, "REACHED");
  assert.equal(l.last_contact_at, "2026-10-14T09:30:00.000Z");
  assert.equal(l.sales_stage, "FOLLOW_UP"); assert.equal(l.next_action, "Angebot schicken"); assert.equal(l.next_action_at, "2026-10-16");
  write(s, "crm.addCall", { lead_id: "firma-001.ch", result: "INTERESTED" });
  assert.equal(lead(s, "firma-001.ch").sales_stage, "INTERESTED");
  assert.equal(lead(s, "firma-001.ch").call_history.length, 2);
});

test("G: Notizen persistent und nur angehängt (nie überschrieben), idempotent je request_id", () => {
  const s = svc(5);
  const id = rid();
  applyRequest({ dataDir: s.data, sources: s.sources, req: { request_id: id, action: "crm.addNote", params: { lead_id: "firma-002.ch", text: "Erste Notiz" } }, now: NOW });
  const dup = applyRequest({ dataDir: s.data, sources: s.sources, req: { request_id: id, action: "crm.addNote", params: { lead_id: "firma-002.ch", text: "Erste Notiz" } }, now: NOW });
  assert.equal(dup.duplicate, true);
  write(s, "crm.addNote", { lead_id: "firma-002.ch", text: "Zweite Notiz\nmit Zeilenumbruch" });
  const l = lead(s, "firma-002.ch");
  assert.deepEqual(l.notes.map((n) => n.text), ["Erste Notiz", "Zweite Notiz\nmit Zeilenumbruch"]);
  assert.ok(l.notes.every((n) => n.at));
  assert.equal(write(s, "crm.addNote", { lead_id: "firma-002.ch", text: "   " }).code, "BAD_PARAMS");
});

test("H: Follow-up persistent + HEUTE FÄLLIG / ÜBERFÄLLIG / SPÄTER (Europe/Zurich)", () => {
  const s = svc(5);
  write(s, "crm.setNextAction", { lead_id: "firma-001.ch", next_action: "Nachfassen", next_action_at: "2026-10-14" });
  write(s, "crm.setNextAction", { lead_id: "firma-002.ch", next_action: "Nachfassen", next_action_at: "2026-10-13" });
  write(s, "crm.setNextAction", { lead_id: "firma-003.ch", next_action: "Nachfassen", next_action_at: "2026-10-20" });
  const v = view(s), by = Object.fromEntries(v.leads.map((l) => [l.lead_id, l]));
  assert.equal(by["firma-001.ch"].follow_up, "TODAY"); assert.equal(by["firma-002.ch"].follow_up, "OVERDUE"); assert.equal(by["firma-003.ch"].follow_up, "LATER");
  assert.equal(crmStats(v.leads, NOW).follow_ups, 2);
  assert.equal(followUpBucket({ next_action_at: "2026-10-14" }, new Date("2026-10-14T22:30:00Z")), "OVERDUE", "nach Mitternacht Zürich ist gestern überfällig");
  write(s, "crm.setNextAction", { lead_id: "firma-001.ch", next_action: "", next_action_at: null });
  assert.equal(lead(s, "firma-001.ch").next_action_at, null);
});

// ---------- I: Do Not Contact ----------
test("I: Do Not Contact blockiert Outreach (Queue, Anruf-Empfehlung, Follow-up, Kontaktaktionen, neue Cold-Entwürfe)", () => {
  const s = svc(20);
  write(s, "crm.setNextAction", { lead_id: "firma-001.ch", next_action: "Nachfassen", next_action_at: "2026-10-14" });
  assert.equal(lead(s, "firma-001.ch").call_recommended, true);
  const r = write(s, "crm.setDoNotContact", { lead_id: "firma-001.ch", value: true, reason: "Wunsch des Kunden" });
  assert.equal(r.ok, true);
  const l = lead(s, "firma-001.ch");
  assert.equal(l.do_not_contact, true); assert.equal(l.sales_stage, "DO_NOT_CONTACT");
  assert.equal(l.call_recommended, false); assert.equal(inOutreachQueue(l), false); assert.equal(l.follow_up, null);
  assert.equal(l.priority.level, "LOW"); assert.ok(l.priority.score < 0);
  assert.equal(l.next_action, "Nachfassen", "bestehende Daten bleiben erhalten");
  for (const [a, p] of [["crm.addCall", { result: "NO_ANSWER" }], ["crm.updateStage", { stage: "TO_CONTACT" }], ["crm.setNextAction", { next_action: "x" }], ["crm.updateCallStatus", { call_status: "NO_ANSWER" }]])
    assert.equal(write(s, a, { lead_id: "firma-001.ch", ...p }).code, "DO_NOT_CONTACT", a);
  assert.equal(write(s, "crm.addNote", { lead_id: "firma-001.ch", text: "Dokumentation bleibt möglich" }).ok, true);
  assert.notEqual(nextBestLead(view(s).leads)?.lead_id, "firma-001.ch");
  // Mail-Worker: registryBlock liest lead_crm.json (nur lesend) → kein neuer Cold-Entwurf für diese Firma
  const store = { dir: path.join(s.mail, "mail_worker"), read: (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(s.mail, "mail_worker", n), "utf8")); } catch { return d; } } };
  const reg = { leads: {} };
  assert.equal(registryBlock(store, { lead_id: "firma-001.ch", domain: "firma-001.ch" }, reg), null, "ohne JARVIS_CRM_DIR keine CRM-Sperre");
  assert.equal(crmDoNotContact(s.data).has("firma-001.ch"), true);
  process.env.JARVIS_CRM_DIR = s.data;
  try { assert.equal(registryBlock(store, { domain: "firma-001.ch", email: "info@firma-001.ch" }, reg), "do-not-contact (CRM)"); assert.equal(registryBlock(store, { domain: "firma-002.ch" }, reg), null); }
  finally { delete process.env.JARVIS_CRM_DIR; }
  // Sperre aus der Lead-Datenbank ist im CRM nicht aufhebbar
  assert.equal(write(s, "crm.setDoNotContact", { lead_id: "firma-011.ch", value: false }).code, "REGISTRY_BLOCK");
  assert.equal(write(s, "crm.setDoNotContact", { lead_id: "firma-001.ch", value: false }).ok, true);
  assert.equal(lead(s, "firma-001.ch").do_not_contact, false);
});

// ---------- J: Concurrency ----------
test("J: konkurrierende Writes (6 Prozesse × 15 Notizen + Lock-Wettlauf) verlieren keine Daten", async () => {
  const s = svc(5);
  const mod = pathToFileURL(path.join(ROOT, "crm-service.js")).href;
  const code = `import { applyRequest, createSourceReader } from ${JSON.stringify(mod)}; import crypto from "node:crypto";
    const [data, mail, who] = process.argv.slice(1); const sources = createSourceReader({ dataDir: data, mailDir: mail });
    for (let i = 0; i < 15; i++) { const r = applyRequest({ dataDir: data, sources, req: { request_id: crypto.randomUUID(), action: "crm.addNote", params: { lead_id: "firma-001.ch", text: who + "-" + i } } });
      if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); } }`;
  const run = (who) => new Promise((res) => { const p = spawn(process.execPath, ["--input-type=module", "-e", code, s.data, s.mail, who], { stdio: ["ignore", "ignore", "pipe"] }); let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (c) => res({ c, e })); });
  const results = await Promise.all(["a", "b", "c", "d", "e", "f"].map(run));
  assert.deepEqual(results.map((r) => r.c), [0, 0, 0, 0, 0, 0], results.map((r) => r.e).join("\n"));
  const notes = lead(s, "firma-001.ch").notes.map((n) => n.text);
  assert.equal(notes.length, 90);
  assert.equal(new Set(notes).size, 90);
  assert.equal(fs.readdirSync(s.data).filter((f) => /\.tmp-|crm\.lock/.test(f)).length, 0, "keine Temp-/Lock-Reste");
  const audit = fs.readFileSync(path.join(s.data, "crm_audit.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.equal(audit.filter((a) => a.outcome === "success").length, 90);
  assert.equal(audit.some((a) => "text" in a || /"[a-f]-\d+"/.test(JSON.stringify(a))), false, "Audit ohne Notiz-Inhalte");
});

test("J2: verwaister Lock wird übernommen, belegter Lock blockiert mit Fehler statt zu überschreiben", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-crmlock-"));
  fs.writeFileSync(path.join(dir, "crm.lock"), JSON.stringify({ token: "alt", at: Date.now() - 60_000 }));
  assert.equal(withCrmLock(dir, () => 42), 42);
  fs.writeFileSync(path.join(dir, "crm.lock"), JSON.stringify({ token: "frisch", at: Date.now() }));
  assert.throws(() => withCrmLock(dir, () => 1, { timeoutMs: 200 }), /Lock belegt/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "crm.lock"), "utf8")).token, "frisch");
});

// ---------- K + L: fremde Leads, keine beliebigen Aktionen ----------
test("K: fremder/unbekannter Lead kann nicht verändert werden (VPS + Cloud)", async () => {
  const s = svc(5);
  for (const id of ["unbekannt.ch", "firma-999.ch", "evil.example"]) assert.equal(write(s, "crm.addNote", { lead_id: id, text: "x" }).code, "UNKNOWN_LEAD");
  assert.equal(fs.existsSync(path.join(s.data, CRM_FILE)), false, "nichts geschrieben");
  const st = emptyCrmState(NOW);
  assert.equal(applyCrmAction(st, { action: "crm.addNote", params: { lead_id: "x.ch", text: "y" } }, { now: NOW, lookup: () => null }).code, "UNKNOWN_LEAD");
  const h = harness(s);
  await h.agentPull();
  const r = await h.user("POST", { action: "crm.addNote", params: { lead_id: "unbekannt.ch", text: "x" } });
  assert.equal(r.status, 404); assert.equal(r.body.code, "UNKNOWN_LEAD");
});

test("L: keine beliebige Server-Aktion – nur die crm.*-Allowlist mit festem Parameter-Schema", async () => {
  const bad = [{ action: "shell.exec", params: { cmd: "ls" } }, { action: "crm.exec" }, { action: "docker.exec" }, { action: "crm.addNote", params: { lead_id: "a.ch", text: "x", path: "/etc/passwd" } },
    { action: "crm.addNote", params: { lead_id: "../../etc", text: "x" } }, { action: "crm.updateStage", params: { lead_id: "a.ch", stage: "SEND_NOW" } }, { action: "crm.updateStage", params: { lead_id: "a.ch", stage: "DO_NOT_CONTACT" } },
    { action: "crm.addNote", params: { lead_id: "a.ch", text: "x" }, extra: 1 }, { action: "crm.archive", params: { lead_id: "a.ch", value: "true" } }, { action: "__proto__" }, { action: "crm.constructor" },
    { action: "crm.addCall", params: { lead_id: "a.ch", result: "NO_ANSWER", at: "2099-01-01T00:00:00Z" } }, { action: "crm.addNote", params: { lead_id: "a.ch", text: "x".repeat(2001) } }, "crm.addNote", null, []];
  for (const b of bad) assert.equal(validateCrmAction(b, { now: NOW }).ok, false, JSON.stringify(b)?.slice(0, 80));
  // TF-077B: + crm.resolveContactForm (Kontaktformular-Anfrage erledigt, nur lead_id).
  assert.deepEqual(Object.keys(CRM_ACTIONS).sort(), ["crm.addCall", "crm.addNote", "crm.archive", "crm.createManualLead", "crm.getLead", "crm.listLeads", "crm.resolveContactForm", "crm.setDoNotContact", "crm.setNextAction", "crm.updateCallStatus", "crm.updateContactStatus", "crm.updateStage"]);
  // Dienst/Cloud: kein child_process, kein exec, kein Docker-Socket, kein Gmail
  for (const f of ["crm-service.js", "crm-api.js", "lead-crm.js", "public/crm-model.js", "public/crm.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "")).join("\n"); // Code ohne Kommentare
    assert.equal(/child_process|execSync|spawn\(|eval\(|new Function|docker\.sock|gmail\.js|sendDraft|createDraft/.test(src), false, f);
  }
  const df = fs.readFileSync(path.join(ROOT, "deploy/vps/Dockerfile.crm"), "utf8");
  assert.equal(/gmail|mail-worker|mail-requests|server-agent/.test(df.split("\n").filter((l) => l.startsWith("COPY")).join("\n")), false, "Image ohne Mail-/Sende-Module");
  const compose = fs.readFileSync(path.join(ROOT, "deploy/vps/crm/docker-compose.yml"), "utf8");
  assert.match(compose, /\/opt\/jarvis-mail\/secrets:\/data\/mail:ro/); assert.equal(/docker\.sock|privileged/.test(compose), false);
  // Agent führt nichts aus, was nicht crm.*-Schreibaktion ist
  const s = svc(3); const h = harness(s);
  h.queue({ request_id: rid(), action: "shell.exec", params: {}, status: "pending", created_at: NOW.toISOString(), expires_at: new Date(+NOW + 60_000).toISOString() });
  const res = await h.agent.pollOnce();
  assert.equal(res.handled, 1);
  assert.equal(fs.existsSync(path.join(s.data, CRM_FILE)), false);
  assert.equal(h.results.at(-1).ok, false);
});

// ---------- Cloud-API: Ablauf Browser → Warteschlange → VPS-Dienst → Ergebnis ----------
function harness(s, { now = () => NOW } = {}) {
  const control = "c".repeat(48), password = "pw-test";
  const qs = memoryStore(), vs = memoryStore(), bs = new Map();
  const backupStore = { set: async (k, v) => bs.set(k, v), list: async ({ prefix }) => ({ blobs: [...bs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }), delete: async (k) => bs.delete(k) };
  const handler = createCrmHandler({ getQueueStore: async () => qs, getViewStore: async () => vs, getBackupStore: async () => backupStore, env: (k) => ({ JARVIS_SERVER_CONTROL_TOKEN: control, JARVIS_PASSWORD: password })[k], now });
  const results = [];
  const fetchFn = async (url, init) => { const body = JSON.parse(init.body); if (body.op === "result") results.push(body); return handler(new Request(url, init)); };
  const agent = createCrmAgent({ dataDir: s.data, sources: s.sources, url: "https://jarvis.test", token: crmAgentToken(control), fetchFn, now });
  const user = async (method, body, query = "") => { const r = await handler(new Request("https://jarvis.test/api/crm" + query, { method, headers: { "x-jarvis-key": password, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() }; };
  return { handler, agent, user, results, control, qs, vs, bs, agentPull: () => agent.pollOnce(),
    queue: (x) => { const st = qs.peek() || { requests: [], audit: [], rate: [] }; st.requests.push(x); qs.set(st, qs.peek() ? undefined : null); } };
}
test("Cloud: Ende-zu-Ende Notiz/Stufe – Auftrag, Abholung, atomare Speicherung, Ergebnis, Sicht aktualisiert", async () => {
  const s = svc(30), h = harness(s);
  // Ohne Dienst: Schreiben abgelehnt (nichts in der Warteschlange)
  const off = await h.user("POST", { action: "crm.addNote", params: { lead_id: "firma-001.ch", text: "x" } });
  assert.equal(off.status, 404, "ohne Sicht kein bekannter Lead");
  await h.agentPull();
  const g = await h.user("GET", null, "?watch=1");
  assert.equal(g.status, 200); assert.equal(g.body.total, 30); assert.equal(g.body.online, true);
  const q = await h.user("POST", { action: "crm.addNote", params: { lead_id: "firma-001.ch", text: "Anruf am Montag" } });
  assert.equal(q.status, 202);
  const id = q.body.request.request_id;
  assert.equal((await h.user("GET", null, `?request=${id}`)).body.request.status, "pending");
  const p = await h.agentPull();
  assert.equal(p.handled, 1);
  const done = await h.user("GET", null, `?request=${id}`);
  assert.equal(done.body.request.status, "done");
  assert.equal(done.body.lead.notes.at(-1).text, "Anruf am Montag");
  assert.equal(loadCrm(s.data).leads["firma-001.ch"].notes.length, 1);
  // Lesen über die Allowlist
  assert.equal((await h.user("POST", { action: "crm.getLead", params: { lead_id: "firma-001.ch" } })).body.lead.notes.length, 1);
  assert.equal((await h.user("POST", { action: "crm.listLeads" })).body.total, 30);
  // Agent-Schlüssel: nur der abgeleitete, nie der Control-Token selbst, nie das Passwort
  for (const hdr of [{ "x-jarvis-crm": h.control }, { "x-jarvis-control": h.control }, { "x-jarvis-crm": "pw-test" }]) {
    const r = await h.handler(new Request("https://jarvis.test/api/crm", { method: "POST", headers: hdr, body: JSON.stringify({ op: "pull" }) }));
    assert.equal(r.status, 401);
  }
  // Browser darf keine Agent-Operationen
  assert.equal((await h.user("POST", { op: "pull", view: { leads: [] } })).status, 400);
  // Cloud speichert nur Allowlist-Felder
  await h.handler(new Request("https://jarvis.test/api/crm", { method: "POST", headers: { "x-jarvis-crm": crmAgentToken(h.control) }, body: JSON.stringify({ op: "pull", view: { leads: [{ lead_id: "x.ch", company: "X", errors: { audit: "FULL", count: 1, items: [{ key: "k", type: "broken_link", text: "Link führt auf eine Fehlerseite", page: "https://x.ch/", status: "OPEN" }] }, secret_token: "abc", gmail_draft_id: "r1", phone_tel: "tel:+999", draft_url: "javascript:alert(1)", website: "javascript:alert(1)" }] } }) }));
  const stored = h.vs.peek().leads[0];
  assert.equal("secret_token" in stored, false); assert.equal("gmail_draft_id" in stored, false); assert.equal(stored.phone_tel, null); assert.equal(stored.draft_url, null); assert.equal(stored.website, null);
});

test("Cloud: VPS-Dienst offline → Schreiben abgelehnt (503), nicht abgeholte Aufträge verfallen sichtbar", async () => {
  let t = NOW; const s = svc(5), h = harness(s, { now: () => t });
  await h.agentPull();
  t = new Date(+NOW + 4 * 60_000);
  const r = await h.user("POST", { action: "crm.addNote", params: { lead_id: "firma-001.ch", text: "x" } });
  assert.equal(r.status, 503); assert.equal(r.body.code, "SERVER_OFFLINE");
  await h.agentPull();
  const q = await h.user("POST", { action: "crm.addNote", params: { lead_id: "firma-001.ch", text: "x" } });
  t = new Date(+t + 4 * 60_000);
  assert.equal((await h.user("GET", null, `?request=${q.body.request.request_id}`)).body.request.status, "expired");
  assert.equal(fs.existsSync(path.join(s.data, CRM_FILE)), false);
});

// ---------- O: Export ----------
test("O: CSV-Export – Spalten, ohne interne IDs, Formel-Schutz, gefiltert (Cloud)", async () => {
  const s = svc(12), h = harness(s);
  write(s, "crm.addNote", { lead_id: "firma-001.ch", text: "=HYPERLINK(\"x\")" });
  write(s, "crm.setNextAction", { lead_id: "firma-001.ch", next_action: "=cmd|' /C calc'!A0", next_action_at: "2026-10-20" });
  await h.agentPull();
  const r = await h.user("GET", null, "?export=csv&phone=1");
  assert.equal(r.status, 200);
  const csv = r.body;
  assert.ok(crmToCsv([]).startsWith("﻿"), "UTF-8-BOM für Excel");
  assert.ok(csv.replace(/^﻿/, "").startsWith("Firma;Website;E-Mail;Telefon;Vorname;Nachname;Rolle;Probleme;Probleme (Text);Sales Stage;Call Status;Letzter Kontakt;Nächster Schritt;Follow-up;Notizen vorhanden"));
  const rows = csv.trim().split("\r\n");
  assert.equal(rows.length - 1, view(s).leads.filter((l) => l.phone).length);
  assert.equal(/firma-0\d\d\.ch;|r-\d|18a0|lead_id|compose=/.test(csv.split("\r\n").map((l) => l.split(";").filter((c, i) => i !== 1 && i !== 2).join(";")).join("\n")), false, "keine internen IDs/Draft-Links");
  assert.match(csv, /'=cmd/); assert.match(csv, /'\+41 31 123 45 67/);
  assert.match(rows.find((x) => x.startsWith("Firma 1 AG")), /;ja$/);
  assert.equal(CSV_COLUMNS.length, 15);
});

// ---------- Priorität, Suche, Filter, Sortierung ----------
test("Priorität transparent: +3 Kontaktweg, +2 weitere Seite, +2 Telefon, +1 Person, +1 2+ Befunde, −10 DNC, −5 kein Interesse", () => {
  const base = { phone: "x", first_name: "A", last_name: "B", findings: [{ key: "contact", text: "Kontaktseite" }, { key: "link:y", text: "Link Blog" }] };
  const p = priorityOf(base);
  assert.equal(p.score, 3 + 2 + 2 + 1 + 1); assert.equal(p.level, "HIGH"); assert.equal(p.reasons.length, 5);
  assert.equal(priorityOf({ ...base, do_not_contact: true }).level, "LOW");
  assert.equal(priorityOf({ ...base, sales_stage: "NOT_INTERESTED" }).score, 4);
  assert.equal(priorityOf({}).level, "LOW");
  assert.equal(callRecommended({ phone: "x", sales_stage: "DRAFT_READY", call_status: "WRONG_NUMBER" }), false);
});
test("Suche (Firma, Domain, E-Mail, Telefon, Vor-/Nachname, Ort), Filter und Sortierung", () => {
  const leads = buildCrmView(makeSources(40), NOW).leads;
  assert.ok(searchMatch(leads.find((l) => l.lead_id === "firma-001.ch"), "031 123 45"));
  assert.ok(searchMatch({ first_name: "Anna", last_name: "Muster" }, "anna muster"));
  assert.equal(filterLeads(leads, { q: "firma-007" }).length, 1);
  assert.equal(filterLeads(leads, { q: "Zürich" }).every((l) => l.municipality === "Zürich"), true);
  assert.ok(filterLeads(leads, { phone: "1" }).every((l) => l.phone));
  assert.ok(filterLeads(leads, { person: "1" }).every((l) => l.first_name));
  assert.ok(filterLeads(leads, { draft: "1" }).every((l) => l.draft_status === "DRAFT"));
  assert.ok(filterLeads(leads, { problems: "0" }).every((l) => l.findings_confirmed === 0));
  assert.ok(filterLeads(leads, { canton: "ZH", category: "Treuhand" }).every((l) => l.canton === "ZH" && l.category === "Treuhand"));
  assert.ok(filterLeads(leads, { dnc: "1" }).every((l) => l.do_not_contact));
  assert.equal(filterLeads(leads, { card: "customers" }).length, 1);
  const s = sortLeads(leads, "problems"); assert.ok(s[0].findings_total >= s.at(-1).findings_total);
  const c = sortLeads(leads, "company"); assert.ok(c[0].company.localeCompare(c[1].company, "de", { numeric: true }) <= 0);
  for (const k of ["priority", "stage", "last_contact", "follow_up", "updated"]) assert.equal(sortLeads(leads, k).length, 40);
  const st = crmStats(leads, NOW);
  for (const k of ["all", "new", "to_contact", "contacted", "interested", "follow_ups", "customers", "dnc", "with_phone", "with_person", "with_draft", "with_findings"]) assert.equal(typeof st[k], "number", k);
});

// ---------- P: keine automatischen Sends ----------
test("P: 0 automatische Sends – CRM hat keinen Sende-/Entwurfs-/Anruf-Pfad", async () => {
  const s = svc(10), h = harness(s);
  let calls = 0;
  const spy = async (url, init) => { calls++; assert.match(String(url), /\/api\/crm$/); return h.handler(new Request(url, init)); };
  const agent = createCrmAgent({ dataDir: s.data, sources: s.sources, url: "https://jarvis.test", token: crmAgentToken(h.control), fetchFn: spy, now: () => NOW });
  await agent.pollOnce();
  for (const a of ["crm.setNextAction", "crm.addCall", "crm.updateStage"]) {
    const p = a === "crm.setNextAction" ? { next_action: "Mail", next_action_at: "2026-10-14" } : a === "crm.addCall" ? { result: "INTERESTED" } : { stage: "TO_CONTACT" };
    assert.equal((await h.user("POST", { action: a, params: { lead_id: "firma-002.ch", ...p } })).status, 202);
  }
  await agent.pollOnce();
  assert.ok(calls >= 2, "nur /api/crm angesprochen");
  const mailWorker = fs.readFileSync(path.join(s.mail, "gmail_jarvis.json"), "utf8");
  assert.equal(JSON.parse(mailWorker).sending && Object.keys(JSON.parse(mailWorker).sending).length, 0, "Gmail-Register unverändert");
  for (const f of ["lead-crm.js", "crm-service.js", "crm-api.js"]) assert.equal(/from "\.\/(gmail|mail-worker|mail-requests|server-agent|swiss-repair|sales)\.js"/.test(fs.readFileSync(path.join(ROOT, f), "utf8")), false, f);
});

// ---------- Backup ----------
test("Backup: CRM-Zustand verschlüsselt (lokal + offsite crm/<Tag>), Restore-Test mit Testdaten", async () => {
  const s = svc(5), h = harness(s);
  write(s, "crm.addNote", { lead_id: "firma-001.ch", text: "Testnotiz für Restore" });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const zurichDay = (d) => d.toISOString().slice(0, 10);
  const r = await crmBackup({ dataDir: s.data, publicKeyPem: publicKey, now: new Date("2026-10-14T03:30:00Z"), zurichDay, upload: h.agent.uploadBackup, force: true });
  assert.equal(r.status.offsite_ok, true); assert.equal(r.status.files, 3);
  assert.deepEqual([...h.bs.keys()], ["crm/2026-10-14"]);
  const env = JSON.parse(h.bs.get("crm/2026-10-14"));
  assert.equal(verifyBackup(env).ok, true);
  assert.equal(JSON.stringify(env).includes("Testnotiz"), false, "nur Chiffrat offsite");
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-crmrestore-")), "r");
  const files = restoreTo(decryptBackup(env, privateKey), out);
  assert.deepEqual(files.sort(), [...BACKUP_FILES].sort());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, CRM_FILE), "utf8")), JSON.parse(fs.readFileSync(path.join(s.data, CRM_FILE), "utf8")));
  // Cloud nimmt nur verschlüsselte Backups an
  const bad = await h.handler(new Request("https://jarvis.test/api/crm", { method: "POST", headers: { "x-jarvis-crm": crmAgentToken(h.control) }, body: JSON.stringify({ op: "backup", backup: { format: "x", files: {} } }) }));
  assert.equal(bad.status, 400);
  // Tageslauf: vor 03:00 nichts, danach einmal
  assert.equal((await crmBackup({ dataDir: s.data, publicKeyPem: publicKey, now: new Date("2026-10-15T00:30:00Z"), zurichDay: () => "2026-10-15" })).skipped, true);
  assert.throws(() => createBackup({ secretsDir: s.data, publicKeyPem: publicKey, files: ["../mail/gmail_jarvis.json"] }), /Unzulässiger Pfad/);
});

test("Cloud-Allowlist ist idempotent und lässt CRM-Sicht unverändert", () => {
  const l = buildCrmView(makeSources(8), NOW).leads;
  for (const x of l) assert.deepEqual(cleanCrmLead(cleanCrmLead(x)), cleanCrmLead(x));
  assert.equal(crmUniverse({ directory: { leads: { "../x": {} } } }).size, 0);
  assert.equal(cleanCrmLead({ lead_id: "<script>" }), null);
});
