// 24/7 CLOUD LEAD DISCOVERY (030): kontinuierliche Lead-Suche auf dem VPS ohne PC – Limits, Backoff, Pause/Resume, Dedupe,
// nur sichtbare belegte Probleme, Gmail Draft-only. Alles mit Attrappen: kein Netzwerk, kein Gmail, keine Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDiscovery, discoveryStatus, setDiscoveryPaused, discoveryReport, DEFAULT_DISCOVERY, DISCOVERY_LOCK } from "../lead-finder.js";
import { createWorker, createStore, zurichDay } from "../mail-worker.js";
import { REVIEWS_FILE, COLD_MODE } from "../swiss-repair.js";
import { ACTIONS, DANGEROUS, validateAction, cleanSnapshot, cleanDiscovery, createServerControlHandler } from "../server-control.js";
import { createVpsActions, createControlAgent, collectSnapshot } from "../server-agent.js";
import { memoryStore } from "../shared-state.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-10T07:00:00Z"); // 09:00 Zürich – kein Versandfenster
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const MIN = 60_000;

let dir, g, clock;
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const readJ = (name, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fb; } };
const reviews = () => readJ(REVIEWS_FILE, { reviews: {} }).reviews;
function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, calls: [], n: 0 };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async createDraft({ to, subject, body, mode }) { f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "t" + id, to, subject, body, mode, createdAt: clock.toISOString() }; return { draftId: id, threadId: "t" + id, messageId: "m" + id }; },
    async sendDraft(id) { f.calls.push("SEND " + id); if (f.reg.drafts[id]?.mode === COLD_MODE) throw new Error("COLD_LEAD_DRAFT_ONLY – nicht sendbar"); throw new Error("unerwartet"); },
    async readThread() { return { messages: [] }; }, async updateDraft() {}, async deleteDraft() {}, async markDraftForReview() {},
  });
  return f;
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-030-"));
  g = fakeGmail();
  clock = T0;
  write("config.json", { dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: SENDER });
});
// Website-Attrappe: Audit-Ergebnis je Host (Befunde frei wählbar), Impressum mit UID und Firmenadresse.
const impressum = (host) => `<html><body><h1>Impressum</h1><p>${host.split(".")[0]} AG<br>Hauptstrasse 1, 8400 Winterthur<br>E-Mail: <a href="mailto:info@${host}">info@${host}</a><br>UID: CHE-123.456.789</p></body></html>`;
const broken = (host) => ({ type: "broken_link", url: `https://${host}/team-alt`, page: `https://${host}/`, label: "Unser Team", evidence: `HTTP 404 (verlinkt auf https://${host}/)`, severity: "medium", detectedAt: T0.toISOString() });
const audit = (host, issues = [broken(host)]) => ({ reachable: true, title: `${host} – Schreinerei`, finalUrl: `https://${host}/`, issues, impressumUrl: `https://${host}/impressum`, contactUrl: `https://${host}/kontakt`, teamUrl: null,
  pages: { home: `<html lang="de"><head><title>${host}</title></head><body>Schreinerei in Winterthur, Schweiz. Telefon +41 52 123 45 67</body></html>`, impressum: impressum(host), contact: "<html><body>Kontakt</body></html>" } });
const fakeAuditor = (map) => ({ audit: async (url) => { const host = new URL(url).hostname.replace(/^www\./, ""); const r = map[host]; if (r instanceof Error) throw r; if (!r) throw new Error("unbekannt " + host); return r; } });
const cand = (host, extra = {}) => ({ company: `${host.split(".")[0]} AG`, website: `https://${host}/`, email: "", chain: false, source: `OpenStreetMap node/1 (Winterthur, craft)`, ...extra });
const run = (candidates, auditor, opts = {}) => runDiscovery({ dir, gmail: g, search: opts.search || (async () => candidates), auditor, now: () => clock, log: () => {}, pid: process.pid, ...opts });
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", subject: "Re", body: "Guten Tag." }) });

// ---------- 24/7 ----------
test("24/7: kleiner Lauf alle intervalMinutes (Default 20) rund um die Uhr, unabhängig von den Versandfenstern; Windows ist nirgends beteiligt", async () => {
  assert.equal(DEFAULT_DISCOVERY.intervalMinutes, 20);
  const a = fakeAuditor({ "muster.ch": audit("muster.ch") });
  const r1 = await run([cand("muster.ch")], a);
  assert.equal(r1.found.length, 1);
  assert.equal((await run([cand("zwei.ch")], a)).skipped, "not_due", "innerhalb des Intervalls kein zweiter Lauf");
  clock = new Date(+T0 + 21 * MIN);
  const r2 = await run([cand("zwei.ch")], fakeAuditor({ "zwei.ch": audit("zwei.ch") }));
  assert.equal(r2.found.length, 1, "nach 20 min läuft der nächste Zyklus – 09:21 Zürich, kein Versandfenster nötig");
  clock = new Date("2026-10-10T20:30:00Z"); // 22:30 Zürich – auch nachts
  assert.equal((await run([cand("drei.ch")], fakeAuditor({ "drei.ch": audit("drei.ch") }))).found.length, 1);
  assert.doesNotMatch(read("lead-finder.js").replace(/\/\/.*$/gm, ""), /localhost|127\.0\.0\.1|server\.js|sendWindow/, "Discovery kennt weder Local Core noch Versandfenster");
  assert.match(read("mail-worker.js"), /const d = await finder\.runDiscovery\(\{ gmail, log \}\);/, "im VPS-Worker-Loop in jedem Durchlauf");
  assert.match(read("deploy/vps/docker-compose.yml"), /restart: unless-stopped/, "nach VPS-Reboot automatisch wieder da");
});

test("Ein sichtbarer belegter Fehler → lokaler Cold-Entwurf (queued, COLD_LEAD_DRAFT_ONLY); kein sichtbarer Fehler → kein Entwurf", async () => {
  await run([cand("muster.ch"), cand("sauber.ch"), cand("langsam.ch")], fakeAuditor({
    "muster.ch": audit("muster.ch"),
    "sauber.ch": audit("sauber.ch", []),
    "langsam.ch": audit("langsam.ch", [{ type: "slow_response", url: "https://langsam.ch/", evidence: "Ladezeit 7.2 s", severity: "medium", detectedAt: T0.toISOString() }]),
  }));
  const rv = reviews();
  assert.deepEqual(Object.keys(rv), ["muster.ch"]);
  assert.equal(rv["muster.ch"].status, "queued"); assert.equal(rv["muster.ch"].draft_mode, COLD_MODE); assert.equal(rv["muster.ch"].legal_basis, "NONE");
  assert.equal(rv["muster.ch"].automatic_send_allowed, false);
  assert.match(rv["muster.ch"].body, /vollständigen Webseiten-Check/); assert.match(rv["muster.ch"].body, /CHF 150/); assert.match(rv["muster.ch"].body, /CHF 480/);
  assert.doesNotMatch(rv["muster.ch"].body, /HTTP 404|team-alt/);
  const leads = readJ("discovered.json").leads;
  assert.equal(leads["sauber.ch"].status, "no_issues");
  assert.ok(["low_score", "blocked_no_legal_basis"].includes(leads["langsam.ch"].status) && !rv["langsam.ch"], "Ladezeit allein ist nicht sichtbar → kein Entwurf");
  const s = discoveryStatus(dir, clock);
  assert.equal(s.status, "ACTIVE"); assert.equal(s.audited_today, 3); assert.equal(s.new_leads_today, 3); assert.equal(s.drafts_today, 1); assert.equal(s.queue, 1);
});

// ---------- Dedupe / Schutz ----------
test("Duplikate: gleiche Domain/Firma nicht erneut, offener Entwurf → kein zweiter, bereits kontaktiert → kein Cold-Draft", async () => {
  const a = fakeAuditor({ "muster.ch": audit("muster.ch"), "kontakt.ch": audit("kontakt.ch") });
  await run([cand("muster.ch")], a);
  assert.equal(Object.keys(reviews()).length, 1);
  clock = new Date(+clock + 25 * MIN);
  const r = await run([cand("muster.ch"), cand("www.muster.ch"), cand("muster.ch", { company: "Muster AG" })], a);
  assert.equal(r.found.length, 0, "Domain/Firma bekannt → nicht erneut geprüft");
  assert.equal(Object.keys(reviews()).length, 1, "kein zweiter Entwurf");
  // bereits kontaktiert (eigener Gmail-Entwurf/Send an die Adresse) → Lead als duplicate, kein Cold-Draft
  g.reg.drafts.dx = { threadId: "tx", to: "info@kontakt.ch", subject: "x", body: "y" };
  clock = new Date(+clock + 25 * MIN);
  await run([cand("kontakt.ch")], a);
  assert.equal(readJ("discovered.json").leads["kontakt.ch"].status, "duplicate");
  assert.ok(!reviews()["kontakt.ch"]);
});

test("Suppression und Opt-out → blockiert (kein Lead-Entwurf, auch domainweit); Sperrfrist nach verworfenem Entwurf", async () => {
  write("suppression.json", { "info@sperr.ch": { reason: "bounce", at: T0.toISOString() }, "chef@optout.ch": { reason: "opt-out (Antwort)", at: T0.toISOString() } });
  await run([cand("sperr.ch"), cand("optout.ch")], fakeAuditor({ "sperr.ch": audit("sperr.ch"), "optout.ch": audit("optout.ch") }));
  const leads = readJ("discovered.json").leads;
  assert.equal(leads["sperr.ch"].status, "suppressed"); assert.equal(leads["optout.ch"].status, "suppressed");
  assert.deepEqual(reviews(), {});
  // verworfener Entwurf → innerhalb der Sperrfrist kein neuer
  write(REVIEWS_FILE, { reviews: { "alt.ch": { lead_id: "alt.ch", domain: "alt.ch", company: "alt AG", recipient: "info@alt.ch", status: "discarded", updated_at: T0.toISOString(), created_at: T0.toISOString() } } });
  clock = new Date(+clock + 25 * MIN);
  await run([cand("alt.ch")], fakeAuditor({ "alt.ch": audit("alt.ch") }));
  assert.equal(reviews()["alt.ch"].status, "discarded", "kein neuer Entwurf innerhalb der Sperrfrist");
  assert.equal(discoveryStatus(dir, clock).blocked_today, 1);
});

// ---------- Limits ----------
test("Tageslimit und Stundenlimit für neue Entwürfe greifen zentral (config.discovery); Websites je Stunde begrenzt", async () => {
  write("config.json", { sender: SENDER, discovery: { maxDraftsPerDay: 1, maxDraftsPerHour: 5, intervalMinutes: 1 } });
  await run([cand("eins.ch"), cand("zwei.ch")], fakeAuditor({ "eins.ch": audit("eins.ch"), "zwei.ch": audit("zwei.ch") }));
  assert.deepEqual(Object.keys(reviews()), ["eins.ch"], "zweiter Entwurf über dem Tageslimit");
  assert.equal(readJ("discovered.json").leads["zwei.ch"].draft_blocked_reason, "Tageslimit Entwürfe");
  const s = discoveryStatus(dir, clock);
  assert.equal(s.drafts_today, 1); assert.equal(s.blocked_today, 1); assert.equal(s.limits.max_drafts_per_day, 1);
  // Stundenlimit
  write("config.json", { sender: SENDER, discovery: { maxDraftsPerDay: 50, maxDraftsPerHour: 1, intervalMinutes: 1 } });
  clock = new Date(+clock + 2 * MIN);
  await run([cand("drei.ch")], fakeAuditor({ "drei.ch": audit("drei.ch") }));
  assert.ok(!reviews()["drei.ch"], "Stundenlimit: eins.ch zählt noch");
  clock = new Date(+clock + 61 * MIN);
  await run([cand("vier.ch")], fakeAuditor({ "vier.ch": audit("vier.ch") }));
  assert.equal(reviews()["vier.ch"].status, "queued", "nach einer Stunde wieder frei");
  // Websites je Stunde
  write("config.json", { sender: SENDER, discovery: { maxSitesPerHour: 1, sitesPerRun: 3, intervalMinutes: 1 } });
  clock = new Date(+clock + 61 * MIN); // neue Stunde (vier.ch zählte in der vorigen)
  const r = await run([cand("a.ch"), cand("b.ch")], fakeAuditor({ "a.ch": audit("a.ch"), "b.ch": audit("b.ch") }));
  assert.equal(r.found.length, 1, "nur eine Website in dieser Stunde");
  clock = new Date(+clock + 2 * MIN);
  assert.equal((await run([cand("b.ch")], fakeAuditor({ "b.ch": audit("b.ch") }))).skipped, "hour_limit");
});

test("Worker: höchstens maxDraftsPerHour/Tag Gmail-Entwürfe je Durchlauf anlegen, Rest bleibt queued – und nie senden", async () => {
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { maxDraftsPerHour: 2, maxDraftsPerDay: 20 } });
  write("suppression.json", {});
  const rv = {};
  for (const h of ["a.ch", "b.ch", "c.ch"]) rv[h] = { lead_id: h, domain: h, company: h, recipient: `info@${h}`, subject: "Hinweis", body: "Guten Tag", draft_hash: "h", status: "queued", draft_mode: COLD_MODE, legal_basis: "NONE", message_class: "DRAFT_ONLY", automatic_send_allowed: false, manual_send_decision_required: true, created_at: T0.toISOString(), updated_at: T0.toISOString() };
  write(REVIEWS_FILE, { reviews: rv });
  await worker().tick();
  const after = reviews();
  assert.equal(Object.values(after).filter((r) => r.status === "draft_created").length, 2);
  assert.equal(Object.values(after).filter((r) => r.status === "queued").length, 1, "dritter wartet auf die nächste Stunde");
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0, "nie gesendet");
  clock = new Date(+T0 + 61 * MIN);
  await worker().tick();
  assert.equal(Object.values(reviews()).filter((r) => r.status === "draft_created").length, 3);
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0);
  // Send-Versuch auf einen Cold-Entwurf scheitert auf Gmail-Ebene
  await assert.rejects(() => g.sendDraft("dr1"), /COLD_LEAD_DRAFT_ONLY/);
});

// ---------- Backoff / Recovery ----------
test("429/5xx der Quelle → Backoff 15 → 30 min, kein aggressives Wiederholen; Erfolg setzt zurück", async () => {
  write("config.json", { sender: SENDER, discovery: { intervalMinutes: 1 } });
  const fail = async () => { throw new Error("Overpass HTTP 429"); };
  const r = await run([], fakeAuditor({}), { search: fail });
  assert.equal(r.errors[0].stage, "search");
  let s = discoveryStatus(dir, clock);
  assert.equal(s.status, "BACKOFF"); assert.equal(s.backoff_count, 1); assert.equal(Date.parse(s.backoff_until), +clock + 15 * MIN); assert.equal(s.next_run_at, s.backoff_until);
  assert.match(s.last_error.message, /429/);
  clock = new Date(+clock + 5 * MIN);
  assert.equal((await run([], fakeAuditor({}), { search: fail })).skipped, "backoff", "während des Backoffs keine neue Anfrage");
  clock = new Date(+clock + 11 * MIN);
  await run([], fakeAuditor({}), { search: fail });
  s = discoveryStatus(dir, clock);
  assert.equal(s.backoff_count, 2); assert.equal(Date.parse(s.backoff_until), +clock + 30 * MIN, "verdoppelt");
  clock = new Date(+clock + 31 * MIN);
  await run([cand("ok.ch")], fakeAuditor({ "ok.ch": audit("ok.ch") }));
  s = discoveryStatus(dir, clock);
  assert.equal(s.status, "ACTIVE"); assert.equal(s.backoff_count, 0); assert.equal(s.backoff_until, null);
});

test("Netzwerkfehler bei Websites: eine Firma stoppt nie den Lauf, Prozess lebt weiter; nur Netzfehler ohne jedes Audit → Backoff", async () => {
  write("config.json", { sender: SENDER, discovery: { intervalMinutes: 1 } });
  const netErr = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const r = await run([cand("tot.ch"), cand("ok.ch")], fakeAuditor({ "tot.ch": netErr, "ok.ch": audit("ok.ch") }));
  assert.equal(r.found.length, 2);
  assert.equal(readJ("discovered.json").leads["tot.ch"].status, "audit_error");
  assert.equal(reviews()["ok.ch"].status, "queued", "zweite Firma trotz Fehler der ersten verarbeitet");
  assert.equal(discoveryStatus(dir, clock).status, "ACTIVE", "ein erfolgreiches Audit → kein Backoff");
  clock = new Date(+clock + 2 * MIN);
  await run([cand("tot2.ch")], fakeAuditor({ "tot2.ch": netErr }));
  const s = discoveryStatus(dir, clock);
  assert.equal(s.status, "BACKOFF"); assert.equal(s.last_error.stage, "audit");
});

test("VPS-Neustart: verwaistes Discovery-Lock (toter Prozess) blockiert nicht, Zustand bleibt, Discovery läuft weiter", async () => {
  write("config.json", { sender: SENDER, discovery: { intervalMinutes: 1 } });
  await run([cand("vor.ch")], fakeAuditor({ "vor.ch": audit("vor.ch") }));
  fs.writeFileSync(path.join(dir, DISCOVERY_LOCK), JSON.stringify({ pid: 999_999, beat: +T0 - 60 * MIN })); // alter Prozess, lange nicht gemeldet
  clock = new Date(+clock + 2 * MIN);
  const r = await run([cand("nach.ch")], fakeAuditor({ "nach.ch": audit("nach.ch") }), { pid: 4242 });
  assert.equal(r.busy, undefined); assert.equal(r.found.length, 1);
  assert.deepEqual(Object.keys(reviews()).sort(), ["nach.ch", "vor.ch"], "nichts verloren, nichts doppelt");
});

// ---------- Pause / Resume ----------
test("Pause/Resume: discovery.pause stoppt neue Suchen (Daten bleiben), discovery.resume setzt fort; Status PAUSED/ACTIVE", async () => {
  write("config.json", { sender: SENDER, discovery: { intervalMinutes: 1 } });
  await run([cand("vor.ch")], fakeAuditor({ "vor.ch": audit("vor.ch") }));
  setDiscoveryPaused(dir, true, { now: clock });
  clock = new Date(+clock + 2 * MIN);
  assert.equal((await run([cand("nein.ch")], fakeAuditor({ "nein.ch": audit("nein.ch") }))).skipped, "paused");
  let s = discoveryStatus(dir, clock);
  assert.equal(s.status, "PAUSED"); assert.equal(s.paused, true); assert.equal(s.next_run_at, null);
  assert.equal(Object.keys(readJ("discovered.json").leads).length, 1, "nichts gelöscht");
  assert.equal(reviews()["vor.ch"].status, "queued");
  setDiscoveryPaused(dir, false, { now: clock });
  assert.equal((await run([cand("ja.ch")], fakeAuditor({ "ja.ch": audit("ja.ch") }))).found.length, 1);
  s = discoveryStatus(dir, clock);
  assert.equal(s.status, "ACTIVE"); assert.ok(s.next_run_at);
});

// ---------- Server Control / Dashboard / Mobile ----------
test("Server Control: discovery.pause/resume sind feste CONTROL-Aktionen ohne Parameter; keine Scheduler-/Shell-Befehle; Snapshot-Whitelist", async () => {
  assert.equal(ACTIONS["discovery.pause"].tier, "control"); assert.equal(ACTIONS["discovery.resume"].tier, "control");
  assert.ok(validateAction({ action: "discovery.pause" }).ok); assert.ok(validateAction({ action: "discovery.resume", params: {} }).ok);
  assert.equal(validateAction({ action: "discovery.pause", params: { cron: "* * * * *" } }).ok, false);
  for (const a of ["discovery.run", "discovery.setInterval", "discovery.delete", "scheduler.exec", "shell.exec"]) assert.equal(validateAction({ action: a }).ok, false, a);
  assert.ok(DANGEROUS.includes("shell.exec") && DANGEROUS.includes("state.delete"));
  const d = cleanDiscovery({ status: "ACTIVE", paused: false, audited_today: 7, new_leads_today: 7, qualified_today: 2, drafts_today: 1, drafts_hour: 1, blocked_today: 1, errors_today: 0, queue: 1,
    last_run_at: T0.toISOString(), next_run_at: new Date(+T0 + 20 * MIN).toISOString(), last_error: { at: T0.toISOString(), stage: "search", message: "Overpass HTTP 504 token=abc sk-ant-xyz123456789 /opt/fiverr/x" },
    limits: { interval_minutes: 20, max_drafts_per_hour: 5, max_drafts_per_day: 20 }, secret: "x", cmd: "rm -rf" });
  assert.equal(d.status, "ACTIVE"); assert.equal(d.drafts_today, 1); assert.equal(d.limits.max_drafts_per_day, 20);
  assert.doesNotMatch(JSON.stringify(d), /sk-ant-xyz|rm -rf|"secret"|"cmd"|\/opt\/fiverr/);
  assert.equal(cleanSnapshot({ discovery: { status: "PAUSED" } }).discovery.status, "PAUSED");
  assert.equal(cleanSnapshot({}).discovery, null);
});

test("Mock-E2E: Handy → discovery.pause → VPS-Agent setzt Flag → Snapshot PAUSED; resume → ACTIVE; Windows nicht beteiligt", async () => {
  write("config.json", { sender: SENDER, discovery: { intervalMinutes: 1 } });
  const CONTROL = "ctl-" + "c".repeat(40), ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SERVER_CONTROL_TOKEN: CONTROL };
  const store = memoryStore(); let n = 0;
  const handler = createServerControlHandler({ env: (k) => ENV[k], getStore: async () => store, now: () => clock, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  const call = async (method, body, headers = {}, q = "") => { const r = await handler(new Request("https://jarvis.test/api/server-control" + q, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })); return { status: r.status, body: await r.json() }; };
  const snap = () => ({ ...collectSnapshot({ dir, startedAt: T0.toISOString(), core: { role: "vps", schema_version: 1 }, mail: { worker: "VPS ACTIVE", authority: "VPS", self: true, last_iteration_at: clock.toISOString() }, queue: { pending: 0, processing: 0 }, backup: { last_at: T0.toISOString(), ok: true, generations: 2 }, healthy: () => true, lastIterationAt: clock.toISOString() }), discovery: discoveryStatus(dir, clock) });
  let woke = 0;
  const deps = { snapshot: snap, runBackup: async () => ({ ok: true }), restartCore: () => ({ ok: true }), restartMailWorker: () => ({ ok: true }), restartScheduler: () => ({ ok: true }),
    setDiscovery: (op) => { const r = setDiscoveryPaused(dir, op === "pause", { now: clock }); woke++; return { ok: true, ...r, status: r.paused ? "PAUSED" : "ACTIVE" }; } };
  const fetchFn = async (url, init) => { const r = await call("POST", JSON.parse(init.body), { "x-jarvis-control": CONTROL }); return { status: r.status, json: async () => r.body }; };
  const agent = createControlAgent({ dir, config: { url: "https://jarvis.test/api/state", controlToken: CONTROL }, actions: createVpsActions({ dir, deps }), snapshot: snap, fetchFn, now: () => clock });
  await agent.pollOnce();
  assert.equal((await call("GET", null, { "x-jarvis-key": "pw-test" })).body.snapshot.discovery.status, "ACTIVE");
  const p = await call("POST", { action: "discovery.pause" }, { "x-jarvis-key": "pw-test" });
  assert.equal(p.status, 202);
  await agent.pollOnce(); await agent.pollOnce();
  let v = (await call("GET", null, { "x-jarvis-key": "pw-test" })).body;
  assert.equal(v.snapshot.discovery.status, "PAUSED"); assert.equal(v.requests.find((x) => x.request_id === p.body.request.request_id).status, "done"); assert.equal(woke, 1);
  assert.equal((await run([cand("x.ch")], fakeAuditor({ "x.ch": audit("x.ch") }))).skipped, "paused");
  clock = new Date(+clock + 15_000);
  const r2 = await call("POST", { action: "discovery.resume" }, { "x-jarvis-key": "pw-test" });
  assert.equal(r2.status, 202);
  await agent.pollOnce(); await agent.pollOnce();
  v = (await call("GET", null, { "x-jarvis-key": "pw-test" })).body;
  assert.equal(v.snapshot.discovery.status, "ACTIVE");
  assert.ok(v.audit.some((a) => a.action === "discovery.pause" && a.outcome === "success") && v.audit.some((a) => a.action === "discovery.resume"));
  assert.equal((await call("POST", { action: "discovery.pause" }, { "x-jarvis-worker": "w".repeat(40) })).status, 401, "Worker-Token gilt nicht");
});

test("Dashboard/Mobile: Discovery-Panel mit ACTIVE/PAUSED, Heute geprüft, Neue Leads, Qualifiziert, Gmail-Entwürfe, Blockiert, Letzter Lauf, Nächster Zyklus, Queue, Letzter Fehler; Pause/Resume-Buttons; Quick-Status", () => {
  const html = read("public/index.html");
  for (const id of ["discPanel", "dState", "dAudited", "dNew", "dQualified", "dDrafts", "dBlocked", "dLast", "dNext", "dQueue", "dError", "discResult", "qDisc", "qDiscDrafts"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /data-action="discovery\.pause"/); assert.match(html, /data-action="discovery\.resume"/);
  assert.match(html, /renderDiscovery\(m\.online \? data\?\.snapshot\?\.discovery : null/, "Quelle: VPS-Snapshot über /api/server-control (Cloud-Passwort), kein Local Core");
  assert.match(html, /\.disabled = d\.status === "PAUSED";/);
  assert.match(html, /"BACKOFF \(Quelle gestört\)"/);
  assert.match(html, /#srvControl button\[data-action\], #discPanel button\[data-action\]/, "gleicher sicherer Handler, nur feste Action-IDs");
  assert.doesNotMatch(html, /discovery\.run|discovery\.set|name="interval"|data-command/);
  assert.match(html, /\/\/ discPanel bleibt offen/, "auf dem Handy standardmässig sichtbar");
  const report = discoveryReport(dir, clock);
  assert.ok("websitesAuditedToday" in report && "lastRunAt" in report);
});
