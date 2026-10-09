// CLOUD LEADS (028): Lead-Liste und Cold-Entwurf vom Handy – READ-only-Allowlist, Aktion nur „Entwurf erstellen/verwerfen“, nie senden.
// Alles mit Mocks und Temp-Verzeichnissen: kein Netzwerk, keine echte Mail, kein Gmail.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publicLead, publicLeads, cleanLead, cleanLeads, leadsFingerprint, CLOUD_LEAD_FIELDS, LEAD_ID_RE, CLOUD_LEAD_LIMIT } from "../cloud-leads.js";
import { ACTIONS, DANGEROUS, validateAction, createServerControlHandler, cleanResult } from "../server-control.js";
import { createVpsActions, createControlAgent, collectSnapshot } from "../server-agent.js";
import { memoryStore } from "../shared-state.js";
import { createStore, coldDraftFromCloud } from "../mail-worker.js";
import { loadPipeline, findRawLead } from "../sales.js";
import { COLD_DRAFTS_FILE, COLD_MODE } from "../swiss-repair.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-09T08:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const issue = (type, severity, url, page) => ({ type, url, page, evidence: `HTTP 404 (verlinkt auf ${page})`, severity, detectedAt: T0.toISOString() });
const rawLead = (over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: "https://muster.ch/", domain: "muster.ch", uid: "CHE-123.456.789", approved: false, consentBasis: null,
  status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true, title: "Muster AG – Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)",
  contact_source: "impressum", source_url: "https://muster.ch/impressum", collected_at: T0.toISOString(), contact_confidence: "medium",
  websiteIssues: [issue("broken_link", "medium", "https://muster.ch/team-alt", "https://muster.ch/")], ...over,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-028-"));
function vpsDir({ leads = [rawLead()], suppression = {} } = {}) {
  const dir = tmp();
  const w = (n, d) => fs.writeFileSync(path.join(dir, n), JSON.stringify(d));
  w("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER });
  w("discovered.json", { leads: Object.fromEntries(leads.map((l) => [l.domain, l])) });
  w("suppression.json", suppression);
  return dir;
}
const fakeGmail = () => ({ listOwned: () => ({ sent: {}, drafts: {} }) });
const CONTROL = "ctl-" + "c".repeat(40);
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SERVER_CONTROL_TOKEN: CONTROL, JARVIS_MAIL_WORKER_TOKEN: "worker-" + "w".repeat(40) };
const URL_ = "https://jarvis.test/api/server-control";
const req = (method, body, headers = {}, q = "") => new Request(URL_ + q, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const USER = { "x-jarvis-key": "pw-test" }, AGENT = { "x-jarvis-control": CONTROL };
function cloud() {
  const store = memoryStore();
  let now = +T0, n = 0;
  const handler = createServerControlHandler({ env: (k) => ENV[k], getStore: async () => store, now: () => new Date(now), newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  const call = async (...a) => { const r = await handler(req(...a)); return { status: r.status, body: await r.json() }; };
  return { call, advance: (ms) => { now += ms; } };
}

// ---------- A. Allowlist ----------
test("publicLead: nur erlaubte Felder – keine Roh-Evidence, keine Befund-URLs, keine Gmail-IDs, keine Pfade; Kundentext + E-Mail bleiben", () => {
  const dir = vpsDir();
  const { leads } = loadPipeline({ dir, registry: { sent: {}, drafts: {} }, now: T0 });
  const l = leads.find((x) => x.domain === "muster.ch");
  assert.equal(l.repair.contact_basis, COLD_MODE);
  const p = publicLead(l, T0);
  assert.deepEqual(Object.keys(p).sort(), [...CLOUD_LEAD_FIELDS].sort());
  assert.equal(p.lead_id, "muster.ch"); assert.equal(p.company, "Muster AG"); assert.equal(p.business_email, "info@muster.ch");
  assert.equal(p.draft_status, "none"); assert.equal(p.draft_eligible, true); assert.equal(p.draft_mode, COLD_MODE);
  assert.ok(p.problems.length >= 1 && p.problems[0].includes("Fehlerseite"), "einfache Kundenbeschreibung");
  const s = JSON.stringify(p);
  assert.doesNotMatch(s, /404|HTTP d|team-alt|https:\/\/muster\.ch\/team|evidence|detectedAt|repair_evidence|issue_evidence|gmail_draft_id|message_id|thread_id|draft_hash|evidence_hash|source_url|\.secrets|\/opt\//i, "keine technische Evidence/IDs/Pfade");
  // Mit Entwurf in Gmail: Status ja/nein, aber nie die ID.
  const withDraft = publicLead({ ...l, review: { status: "draft_created", gmail_draft_id: "r-abc123", message_id: "m1", thread_id: "t1", subject: "x", body: "y", updated_at: T0.toISOString() } }, T0);
  assert.equal(withDraft.draft_status, "draft_created"); assert.equal(withDraft.draft_in_gmail, true); assert.equal(withDraft.draft_eligible, false);
  assert.doesNotMatch(JSON.stringify(withDraft), /r-abc123|m1|t1/);
});

test("cleanLeads (Cloud-Seite): unbekannte Felder fallen weg, Typen erzwungen, URLs im Problemtext verworfen, Limit", () => {
  const dirty = { lead_id: "muster.ch", company: "Muster AG", website: "https://muster.ch/", problems: ["der Link führt auf eine Fehlerseite", "siehe https://muster.ch/x (404)"], business_email: "INFO@Muster.ch",
    draft_status: "draft_created", draft_in_gmail: "yes", suppressed: false, opted_out: false, draft_eligible: true, evidence: [{ url: "x" }], gmail_draft_id: "r1", token: "sk-ant-abc", path: "/opt/fiverr", stage: "cold_lead_draft_only", offer_class: "REPAIR_CHECK_150" };
  const c = cleanLead(dirty);
  assert.deepEqual(Object.keys(c).sort(), [...CLOUD_LEAD_FIELDS].sort());
  assert.deepEqual(c.problems, ["der Link führt auf eine Fehlerseite"]);
  assert.equal(c.business_email, "info@muster.ch"); assert.equal(c.draft_in_gmail, false); assert.equal(c.draft_eligible, true);
  assert.doesNotMatch(JSON.stringify(c), /sk-ant|fiverr|r1|evidence/);
  // gesperrt → nie erstellbar, egal was der Absender behauptet
  assert.equal(cleanLead({ ...dirty, suppressed: true, draft_eligible: true }).draft_eligible, false);
  assert.equal(cleanLead({ ...dirty, opted_out: true }).draft_eligible, false);
  assert.equal(cleanLead({ lead_id: "../etc/passwd" }), null); assert.equal(cleanLead({ lead_id: "a b" }), null);
  assert.equal(cleanLeads(Array.from({ length: 400 }, (_, i) => ({ ...dirty, lead_id: `firma${i}.ch` }))).length, CLOUD_LEAD_LIMIT);
  assert.ok(LEAD_ID_RE.test("muster.ch") && !LEAD_ID_RE.test("/opt/fiverr") && !LEAD_ID_RE.test("a;rm -rf") && !LEAD_ID_RE.test("Muster.CH"));
});

test("publicLeads: suppressed/opt-out → gesperrt und nicht erstellbar; offene Entwürfe zuerst; Fingerabdruck stabil", () => {
  const dir = vpsDir({ leads: [rawLead(), rawLead({ domain: "sperr.ch", email: "info@sperr.ch", company: "Sperr AG", website: "https://sperr.ch/" }), rawLead({ domain: "optout.ch", email: "info@optout.ch", company: "Optout AG", website: "https://optout.ch/" })],
    suppression: { "info@sperr.ch": { reason: "bounce", at: T0.toISOString() }, "info@optout.ch": { reason: "opt-out", at: T0.toISOString() } } });
  const { leads } = loadPipeline({ dir, registry: { sent: {}, drafts: {} }, now: T0 });
  const list = publicLeads(leads, T0);
  const by = Object.fromEntries(list.map((p) => [p.lead_id, p]));
  assert.equal(by["muster.ch"].draft_eligible, true);
  assert.equal(by["sperr.ch"].suppressed, true); assert.equal(by["sperr.ch"].draft_eligible, false);
  assert.equal(by["optout.ch"].opted_out, true); assert.equal(by["optout.ch"].draft_eligible, false);
  assert.equal(leadsFingerprint(list), leadsFingerprint(publicLeads(leads, new Date(+T0 + 60_000))), "updated_at zählt nicht");
  const withOpen = publicLeads(leads.map((l) => (l.domain === "optout.ch" ? { ...l, review: { status: "draft_created", gmail_draft_id: "r1", updated_at: T0.toISOString() } } : l)), T0);
  assert.equal(withOpen[0].lead_id, "optout.ch", "offener Entwurf zuerst");
});

// ---------- B. Aktion: nur Entwurf, nie Versand ----------
test("Server Control: leads.createDraft/discardDraft sind CONTROL mit genau einem lead_id – keine Send-/Approve-Aktion existiert", () => {
  assert.equal(ACTIONS["leads.createDraft"].tier, "control"); assert.equal(ACTIONS["leads.discardDraft"].tier, "control");
  assert.ok(!Object.keys(ACTIONS).some((a) => /send|approve|force|follow/i.test(a)), "keine Sende-/Freigabe-Aktion");
  assert.ok(validateAction({ action: "leads.createDraft", params: { lead_id: "muster.ch" } }).ok);
  for (const bad of [{}, { lead_id: "" }, { lead_id: "../../root/.ssh" }, { lead_id: "/opt/fiverr" }, { lead_id: "a;rm -rf /" }, { lead_id: ["a.ch", "b.ch"] }, { lead_ids: ["a.ch"] }, { all: true }, { lead_id: "muster.ch", send: true }, { lead_id: "x".repeat(300) }]) {
    const v = validateAction({ action: "leads.createDraft", params: bad });
    assert.equal(v.ok, false, JSON.stringify(bad)); assert.equal(v.status, 400);
  }
  for (const a of ["leads.send", "leads.sendDraft", "leads.forceSend", "leads.approveAndSend", "shell.exec"]) assert.equal(validateAction({ action: a, params: { lead_id: "muster.ch" } }).ok, false, a);
  assert.ok(DANGEROUS.includes("shell.exec"));
});

test("VPS: coldDraftFromCloud legt nur einen lokalen Cold-Entwurf an (queued, COLD_LEAD_DRAFT_ONLY, legal_basis NONE) und weckt den Worker", async () => {
  const dir = vpsDir();
  let woke = 0;
  const r = await coldDraftFromCloud({ op: "create", leadId: "muster.ch", gmail: fakeGmail(), dir, wake: () => woke++, now: T0 });
  assert.equal(r.ok, true); assert.equal(woke, 1);
  assert.equal(r.review.status, "queued"); assert.equal(r.review.draft_mode, COLD_MODE); assert.equal(r.review.legal_basis, "NONE");
  assert.equal(r.review.message_class, "DRAFT_ONLY"); assert.equal(r.review.automatic_send_allowed, false); assert.equal(r.review.manual_send_decision_required, true);
  const rv = createStore(dir).read(COLD_DRAFTS_FILE, { reviews: {} }).reviews["muster.ch"];
  assert.equal(rv.status, "queued"); assert.equal(rv.recipient, "info@muster.ch"); assert.equal(rv.automatic_send_allowed, false);
  assert.ok(!fs.existsSync(path.join(dir, "state.json")) || !JSON.stringify(createStore(dir).read("state.json", {})).includes("muster.ch"), "nie in state.actions (Send-Queue)");
  // zweiter Aufruf: Duplikat → blockiert, kein zweiter Entwurf
  const dup = await coldDraftFromCloud({ op: "create", leadId: "muster.ch", gmail: fakeGmail(), dir, now: T0 });
  assert.equal(dup.ok, false); assert.match(dup.error, /offener Entwurf/);
  // verwerfen → discarded
  const d = await coldDraftFromCloud({ op: "discard", leadId: "muster.ch", gmail: fakeGmail(), dir, now: T0 });
  assert.equal(d.ok, true); assert.equal(d.review.status, "discarded"); assert.equal(d.review.legal_basis, "NONE");
  // Unbekannte Aktion/Lead, ungültige ID
  assert.equal((await coldDraftFromCloud({ op: "send", leadId: "muster.ch", gmail: fakeGmail(), dir })).ok, false);
  assert.equal((await coldDraftFromCloud({ op: "create", leadId: "unbekannt.ch", gmail: fakeGmail(), dir })).ok, false);
  assert.equal((await coldDraftFromCloud({ op: "create", leadId: "../x", gmail: fakeGmail(), dir })).ok, false);
  assert.equal(findRawLead(dir, "muster.ch").company, "Muster AG"); assert.equal(findRawLead(dir, "nix.ch"), null);
});

test("VPS: Suppression blockiert, Opt-out blockiert, Domain-Suppression blockiert, ohne Absender kein Entwurf", async () => {
  const dir = vpsDir({ leads: [rawLead(), rawLead({ domain: "optout.ch", email: "info@optout.ch", company: "Optout AG" }), rawLead({ domain: "firma.ch", email: "web@firma.ch", company: "Firma AG" })],
    suppression: { "info@muster.ch": { reason: "bounce", at: T0.toISOString() }, "info@optout.ch": { reason: "opt-out (Antwort)", at: T0.toISOString() }, "chef@firma.ch": { reason: "opt-out", at: T0.toISOString() } } });
  const a = await coldDraftFromCloud({ op: "create", leadId: "muster.ch", gmail: fakeGmail(), dir, now: T0 });
  assert.equal(a.ok, false); assert.match(a.error, /Suppression/);
  const b = await coldDraftFromCloud({ op: "create", leadId: "optout.ch", gmail: fakeGmail(), dir, now: T0 });
  assert.equal(b.ok, false); assert.match(b.error, /Opt-out/);
  const c = await coldDraftFromCloud({ op: "create", leadId: "firma.ch", gmail: fakeGmail(), dir, now: T0 });
  assert.equal(c.ok, false); assert.match(c.error, /Domain/);
  assert.deepEqual(createStore(dir).read(COLD_DRAFTS_FILE, { reviews: {} }).reviews, {}, "nichts angelegt");
  const dir2 = vpsDir(); fs.writeFileSync(path.join(dir2, "config.json"), JSON.stringify({ sender: { name: "" } }));
  assert.equal((await coldDraftFromCloud({ op: "create", leadId: "muster.ch", gmail: fakeGmail(), dir: dir2, now: T0 })).ok, false);
});

// ---------- C. Cloud ↔ VPS ----------
test("Ende-zu-Ende (Mock): Handy → leads.createDraft → VPS-Agent → lokaler Entwurf; Lead-Liste beim Pull nur bei Änderung; GET ?leads=1 nur mit Passwort", async () => {
  const dir = vpsDir();
  const { call, advance } = cloud();
  const gmail = fakeGmail();
  const leads = () => publicLeads(loadPipeline({ dir, registry: gmail.listOwned(), now: T0 }).leads, T0);
  const snap = () => collectSnapshot({ dir, startedAt: T0.toISOString(), core: { role: "vps", schema_version: 1 }, mail: { worker: "VPS ACTIVE", authority: "VPS", self: true, last_iteration_at: T0.toISOString() }, queue: { pending: 0, processing: 0 }, backup: { last_at: T0.toISOString(), ok: true, generations: 2 }, healthy: () => true, lastIterationAt: T0.toISOString() });
  let woke = 0;
  const deps = { snapshot: snap, runBackup: async () => ({ ok: true }), restartCore: () => ({ ok: true }), restartMailWorker: () => ({ ok: true }), restartScheduler: () => ({ ok: true }),
    coldDraft: (op, id) => coldDraftFromCloud({ op, leadId: id, gmail, dir, wake: () => woke++, now: T0 }) };
  const sent = [];
  const fetchFn = async (url, init) => { sent.push(JSON.parse(init.body)); const r = await call("POST", JSON.parse(init.body), AGENT); return { status: r.status, json: async () => r.body }; };
  const agent = createControlAgent({ dir, config: { url: "https://jarvis.test/api/state", controlToken: CONTROL }, actions: createVpsActions({ dir, deps }), snapshot: snap, leads, fetchFn, now: () => T0 });
  await agent.pollOnce();
  assert.ok(Array.isArray(sent[0].leads) && sent[0].leads[0].lead_id === "muster.ch", "Lead-Liste beim ersten Pull");
  await agent.pollOnce();
  assert.equal(sent[1].leads, undefined, "unverändert → nicht erneut geschickt");
  // Browser: ohne Passwort 401, mit Passwort die Allowlist-Liste
  assert.equal((await call("GET", null, {}, "?leads=1")).status, 401);
  assert.equal((await call("GET", null, { "x-jarvis-worker": ENV.JARVIS_MAIL_WORKER_TOKEN }, "?leads=1")).status, 401);
  const g = await call("GET", null, USER, "?leads=1");
  assert.equal(g.status, 200); assert.equal(g.body.leads.length, 1); assert.equal(g.body.leads[0].draft_eligible, true);
  assert.deepEqual(Object.keys(g.body.leads[0]).sort(), [...CLOUD_LEAD_FIELDS].sort());
  assert.equal((await call("GET", null, USER)).body.leads, undefined, "ohne ?leads=1 keine Liste im Statusabruf");
  // Aktion vom Handy
  const p = await call("POST", { action: "leads.createDraft", params: { lead_id: "muster.ch" } }, USER);
  assert.equal(p.status, 202);
  await agent.pollOnce(); // führt aus
  await agent.pollOnce(); // nächster Pull schickt die geänderte Liste
  const after = await call("GET", null, USER, "?leads=1");
  const q = after.body.requests.find((x) => x.request_id === p.body.request.request_id);
  assert.equal(q.status, "done"); assert.equal(q.result.review.status, "queued"); assert.equal(q.result.review.legal_basis, "NONE"); assert.equal(woke, 1);
  assert.doesNotMatch(JSON.stringify(q.result), /@|draft_hash|subject|body/, "Ergebnis ohne Adresse/Entwurfstext");
  assert.equal(after.body.leads[0].draft_status, "queued"); assert.equal(after.body.leads[0].draft_eligible, false, "Liste nach Änderung erneut geschickt");
  assert.ok(after.body.audit.some((a) => a.action === "leads.createDraft" && a.outcome === "success"));
  // Gesperrter Lead über denselben Weg → failure, kein Entwurf
  fs.writeFileSync(path.join(dir, "suppression.json"), JSON.stringify({ "info@muster.ch": { reason: "opt-out", at: T0.toISOString() } }));
  await call("POST", { action: "leads.discardDraft", params: { lead_id: "muster.ch" } }, USER); await agent.pollOnce();
  advance(1000);
  const p2 = await call("POST", { action: "leads.createDraft", params: { lead_id: "muster.ch" } }, USER);
  assert.equal(p2.status, 202); await agent.pollOnce();
  const q2 = (await call("GET", null, USER)).body.requests.find((x) => x.request_id === p2.body.request.request_id);
  assert.equal(q2.status, "failed"); assert.match(q2.result.error, /Opt-out/);
  // Windows ist nirgends beteiligt: nur Cloud-Passwort, Control-Token, VPS-Dateien.
  assert.ok(!JSON.stringify(sent).includes("x-jarvis-sync") && !read("cloud-leads.js").includes("localhost"));
});

test("Cold Send unmöglich: Worker-/Gmail-Sperre unverändert, Cloud-Aktion kennt keinen Sendepfad, Ergebnis-Redaction aktiv", () => {
  const mw = read("mail-worker.js");
  assert.match(mw, /cold_draft_never_auto/); assert.match(mw, /COLD_LEAD_DRAFT_ONLY – nur manueller Versand durch Chris/);
  assert.match(read("gmail.js"), /COLD_LEAD_DRAFT_ONLY/);
  const fn = mw.slice(mw.indexOf("export async function coldDraftFromCloud"), mw.indexOf("export function healthy"));
  assert.doesNotMatch(fn, /sendDraft|sendMail|state\.actions|send_queue|approve/i);
  assert.match(fn, /ensureColdDraft\(store, lead/); assert.match(fn, /coldDraftAction\(store, "discard"/);
  assert.doesNotMatch(read("server-agent.js"), /child_process|exec\(|spawn\(/);
  assert.equal(cleanResult({ review: { status: "queued" }, note: "x", secret_token: "abc" }).secret_token, undefined);
});

// ---------- D. HUD (Handy) ----------
test("HUD: LEADS in der Cloud (READ-only-Liste), Details mit Problem/Kontakt/Draft-Status, Button „Gmail-Entwurf erstellen“, kein Senden", () => {
  const html = read("public/index.html");
  assert.match(html, /const leadsAvailable = \(\) => mode === "local" \|\| \(mode === "cloud" && HOSTED && !!cloudKey\);/);
  assert.match(html, /if \(mode === "cloud"\) return openCloudLeads\(\);/);
  assert.match(html, /serverFetch\(\{\}, "\?leads=1"\)/, "Quelle: /api/server-control?leads=1 (Cloud-Passwort), kein Local Core");
  assert.match(html, /btn\("GMAIL-ENTWURF ERSTELLEN", !!l\.draft_eligible && !blocked, \(\) => cloudLeadAction\("leads\.createDraft", l, msg\)\)/);
  assert.match(html, /btn\("ENTWURF VERWERFEN", \["queued", "draft_created"\]\.includes\(l\.draft_status\)/);
  assert.match(html, /"GESPERRT — SUPPRESSION \/ OPT-OUT"/);
  assert.match(html, /"COLD LEAD — NUR ENTWURF, NICHT AUTOMATISCH VERSANDBERECHTIGT"/);
  assert.match(html, /Jarvis sendet diesen Entwurf nie, es gibt keinen Sende-Knopf/);
  assert.match(html, /params: \{ lead_id: l\.lead_id \}/, "genau ein Lead je Aktion");
  assert.doesNotMatch(html, /leads\.send|leads\.forceSend|SENDEN AN LEAD|COLD SEND|sendDraft/);
  // Liste: Firma, Problem, Kontakt, Draft-Status – touch-geeignet
  assert.match(html, /el\("b", "", l\.company \|\| l\.lead_id\), el\("small", "", \(l\.problems\?\.\[0\] \|\| "kein sichtbares Problem"\)/);
  assert.match(html, /@media \(max-width: 860px\) \{ \.lead-list li \{ padding: 10px 8px; min-height: 44px; \} \}/);
  // Keine technischen Felder im Cloud-Detail (die gibt es nur im LOCAL-Detail showLead)
  const cloudDetail = html.slice(html.indexOf("function showCloudLead"), html.indexOf("async function cloudLeadAction"));
  assert.doesNotMatch(cloudDetail, /repair_evidence|issue_evidence|Repair Evidence|evidence|gmail_draft_id|message_id/);
});

test("Dockerfile kopiert cloud-leads.js; Netlify-Function nutzt denselben Handler", () => {
  assert.match(read("deploy/vps/Dockerfile"), /cloud-leads\.js/);
  assert.match(read("netlify/functions/server-control.mjs"), /createServerControlHandler/);
});
