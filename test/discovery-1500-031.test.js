// 1500/DAY DISCOVERY – UNLIMITED QUALIFIED DRAFT QUEUE (031): harter Website-Deckel 1500/Tag, 63/h, 21/Lauf; KEIN Business-Limit
// für Cold-Gmail-Entwürfe; persistente Draft-Queue (queued → draft_created) mit technischem Pacing und Backoff; Dedupe vor Gmail;
// Cold Draft-only. Alles mit Attrappen – kein Netzwerk, kein Gmail, keine Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDiscovery, discoveryStatus, DEFAULT_DISCOVERY } from "../lead-finder.js";
import { createWorker, zurichDay } from "../mail-worker.js";
import { REVIEWS_FILE, COLD_MODE } from "../swiss-repair.js";
import { cleanDiscovery } from "../server-control.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-11T07:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const MIN = 60_000;
let dir, g, clock;
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const readJ = (name, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fb; } };
const reviews = () => readJ(REVIEWS_FILE, { reviews: {} }).reviews;
const byStatus = () => Object.values(reviews()).reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
function fakeGmail({ failFor = 0, failWith = "HTTP 429 rate limit" } = {}) {
  const f = { reg: { drafts: {}, sent: {} }, calls: [], n: 0, fails: 0, failFor, failWith };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async createDraft({ to, subject, body, mode }) {
      if (f.fails < f.failFor) { f.fails++; throw new Error(f.failWith); }
      f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "t" + id, to, subject, body, mode, createdAt: clock.toISOString() }; return { draftId: id, threadId: "t" + id, messageId: "m" + id };
    },
    async sendDraft(id) { f.calls.push("SEND " + id); throw new Error(f.reg.drafts[id]?.mode === COLD_MODE ? "COLD_LEAD_DRAFT_ONLY – nicht sendbar" : "unerwartet"); },
    async readThread() { return { messages: [] }; }, async updateDraft() {}, async deleteDraft() {}, async markDraftForReview() {},
  });
  return f;
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-031-"));
  g = fakeGmail();
  clock = T0;
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { draftPaceMs: 0 } });
  write("suppression.json", {});
});
const impressum = (host) => `<html><body><h1>Impressum</h1><p>${host.split(".")[0]} AG<br>Hauptstrasse 1, 8400 Winterthur<br>E-Mail: <a href="mailto:info@${host}">info@${host}</a><br>UID: CHE-123.456.789</p></body></html>`;
const broken = (host) => ({ type: "broken_link", url: `https://${host}/team-alt`, page: `https://${host}/`, label: "Unser Team", evidence: `HTTP 404 (verlinkt auf https://${host}/)`, severity: "medium", detectedAt: T0.toISOString() });
const audit = (host, issues = [broken(host)]) => ({ reachable: true, title: `${host} – Schreinerei`, finalUrl: `https://${host}/`, issues, impressumUrl: `https://${host}/impressum`, contactUrl: `https://${host}/kontakt`, teamUrl: null,
  pages: { home: `<html lang="de"><head><title>${host}</title></head><body>Schreinerei in Winterthur, Schweiz. Telefon +41 52 123 45 67</body></html>`, impressum: impressum(host), contact: "<html><body>Kontakt</body></html>" } });
const anyAuditor = (withIssue = () => true) => ({ audit: async (url) => { const host = new URL(url).hostname.replace(/^www\./, ""); return audit(host, withIssue(host) ? [broken(host)] : []); } });
const cand = (host) => ({ company: `${host.split(".")[0]} AG`, website: `https://${host}/`, email: "", chain: false, source: "OpenStreetMap node/1 (Winterthur, craft)" });
const hosts = (n, p = "firma") => Array.from({ length: n }, (_, i) => `${p}${i + 1}.ch`);
const run = (candidates, auditor, opts = {}) => runDiscovery({ dir, gmail: g, search: async () => candidates, auditor, now: () => clock, log: () => {}, pid: process.pid, force: true, ...opts });
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", subject: "Re", body: "Guten Tag." }) });
const queued = (n, p = "q") => Object.fromEntries(hosts(n, p).map((h) => [h, { lead_id: h, domain: h, company: h, recipient: `info@${h}`, subject: "Hinweis", body: "Guten Tag", draft_hash: "h", status: "queued", draft_mode: COLD_MODE, legal_basis: "NONE", message_class: "DRAFT_ONLY", automatic_send_allowed: false, manual_send_decision_required: true, created_at: T0.toISOString(), updated_at: T0.toISOString() }]));

// ---------- Website-Deckel ----------
test("Live-Defaults: 20 min, 21 je Lauf, 63 je Stunde, 1500 je Tag; Entwürfe ohne Business-Cap (null)", () => {
  assert.equal(DEFAULT_DISCOVERY.intervalMinutes, 20); assert.equal(DEFAULT_DISCOVERY.sitesPerRun, 21);
  assert.equal(DEFAULT_DISCOVERY.maxSitesPerHour, 63); assert.equal(DEFAULT_DISCOVERY.maxSitesPerDay, 1500);
  assert.equal(DEFAULT_DISCOVERY.maxDraftsPerHour, null); assert.equal(DEFAULT_DISCOVERY.maxDraftsPerDay, null);
  assert.ok(DEFAULT_DISCOVERY.draftPaceMs >= 500 && DEFAULT_DISCOVERY.draftsPerPass >= 10, "technisches Pacing vorhanden");
  assert.equal(cleanDiscovery({ status: "ACTIVE", limits: { max_drafts_per_hour: 5, max_drafts_per_day: 20 } }).limits.max_drafts_per_day, null, "Cloud-Whitelist kennt keinen Draft-Cap mehr");
});

test("Niemals mehr als maxSitesPerDay (1500) Website-Audits pro Tag – auch über viele Läufe; danach kein weiteres Audit bis zum nächsten Tag", async () => {
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { maxSitesPerDay: 1500, maxSitesPerHour: 100_000, sitesPerRun: 400, intervalMinutes: 0, draftPaceMs: 0 } });
  let audits = 0;
  const auditor = { audit: async (url) => { audits++; return audit(new URL(url).hostname, []); } };
  for (let i = 0; i < 4; i++) { clock = new Date(+clock + MIN); await run(hosts(400, `t${i}-`).map(cand), auditor); }
  assert.equal(audits, 1500, "harter Deckel");
  assert.equal(discoveryStatus(dir, clock).audited_today, 1500);
  clock = new Date(+clock + MIN);
  await run(hosts(5, "x").map(cand), auditor);
  assert.equal(audits, 1500, "am selben Tag nichts mehr");
  clock = new Date("2026-10-12T07:00:00Z");
  await run(hosts(5, "y").map(cand), auditor);
  assert.equal(audits, 1505, "neuer Tag → weiter");
});

// ---------- Unbegrenzte Draft-Queue ----------
test("10 qualifizierte Leads → 10 Entwürfe; 100 → 100; kein Business-Limit, alle persistent als queued → draft_created", async () => {
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { sitesPerRun: 200, maxSitesPerHour: 1000, maxSitesPerDay: 1500, intervalMinutes: 0, draftPaceMs: 0, draftsPerPass: 1000 } });
  await run(hosts(10, "zehn").map(cand), anyAuditor());
  assert.equal(discoveryStatus(dir, clock).waiting_for_draft, 10);
  await worker().tick();
  assert.equal(byStatus().draft_created, 10); assert.equal(g.calls.filter((c) => c.startsWith("create")).length, 10);
  clock = new Date(+clock + MIN);
  await run(hosts(100, "hundert").map(cand), anyAuditor());
  assert.equal(discoveryStatus(dir, clock).waiting_for_draft, 100);
  await worker().tick();
  const s = byStatus();
  assert.equal(s.draft_created, 110); assert.equal(s.queued ?? 0, 0);
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0, "0 Cold-Send-Events");
  assert.equal(new Set(g.calls.filter((c) => c.startsWith("create")).map((c) => c.slice(7))).size, 110, "keine doppelten Entwürfe");
});

test("500 qualifizierte Leads bleiben vollständig zur Verarbeitung erhalten; Pacing je Durchlauf verschiebt nur; Queue überlebt Neustart", async () => {
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { draftPaceMs: 0, draftsPerPass: 25 } });
  write(REVIEWS_FILE, { reviews: queued(500) });
  let created = 0;
  for (let pass = 0; pass < 10; pass++) { await worker().tick(); created = byStatus().draft_created || 0; assert.equal(created, 25 * (pass + 1)); clock = new Date(+clock + 2 * MIN); }
  // „Neustart“: neuer Worker, nur die Dateien bleiben – die Queue läuft weiter
  g = fakeGmail(); g.n = 250;
  for (let pass = 0; pass < 10; pass++) { await worker().tick(); clock = new Date(+clock + 2 * MIN); }
  const s = byStatus();
  assert.equal(s.draft_created, 500); assert.equal(s.queued ?? 0, 0); assert.equal(s.blocked ?? 0, 0, "kein Lead verloren oder verworfen");
  assert.equal(discoveryStatus(dir, clock).open_drafts_total, 500);
});

test("Gmail 429 / 5xx: Queue bleibt erhalten, Draft-Worker geht in Backoff (1 → 2 → 4 min, max 60) und arbeitet danach weiter – keine Verluste, keine Duplikate", async () => {
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { draftPaceMs: 0, draftsPerPass: 100 } });
  write(REVIEWS_FILE, { reviews: queued(6) });
  g = fakeGmail({ failFor: 1, failWith: "HTTP 429 rate limit" });
  await worker().tick();
  let st = discoveryStatus(dir, clock);
  assert.equal(st.draft_worker.status, "BACKOFF"); assert.equal(st.draft_worker.backoff_count, 1); assert.equal(Date.parse(st.draft_worker.backoff_until), +clock + 1 * MIN);
  assert.equal(byStatus().queued, 6, "nichts verworfen");
  clock = new Date(+clock + 30_000);
  await worker().tick();
  assert.equal(byStatus().queued, 6, "im Backoff keine Versuche");
  assert.equal(g.calls.filter((c) => c.startsWith("create")).length, 0);
  clock = new Date(+clock + 60_000);
  g.failFor = 2; g.fails = 1; g.failWith = "HTTP 503 Service Unavailable"; // zweiter Fehler → 2 min
  await worker().tick();
  st = discoveryStatus(dir, clock);
  assert.equal(st.draft_worker.backoff_count, 2); assert.equal(Date.parse(st.draft_worker.backoff_until), +clock + 2 * MIN);
  clock = new Date(+clock + 3 * MIN);
  await worker().tick();
  const s = byStatus();
  assert.equal(s.draft_created, 6); assert.equal(s.queued ?? 0, 0);
  st = discoveryStatus(dir, clock);
  assert.equal(st.draft_worker.status, "ACTIVE"); assert.equal(st.draft_worker.backoff_count, 0); assert.ok(st.draft_worker.last_draft_at);
  assert.equal(new Set(g.calls.filter((c) => c.startsWith("create")).map((c) => c.slice(7))).size, 6, "keine Duplikate");
  assert.equal(readJ(REVIEWS_FILE).draft_worker.backoffCount, 0, "Backoff persistiert in der Datei (überlebt Neustart)");
});

// ---------- Dedupe vor Gmail ----------
test("Direkt vor Gmail: Suppression, Opt-out, bereits kontaktiert, vorhandener Gmail-Draft, Kunde → BLOCKED statt Entwurf; kein sichtbarer Fehler = kein Entwurf", async () => {
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { draftPaceMs: 0 } });
  write("suppression.json", { "info@q1.ch": { reason: "bounce", at: T0.toISOString() }, "info@q2.ch": { reason: "opt-out", at: T0.toISOString() }, "chef@q3.ch": { reason: "opt-out", at: T0.toISOString() } });
  g.reg.sent.s1 = { threadId: "ts", to: "info@q4.ch", subject: "x", sentAt: T0.toISOString() };
  g.reg.drafts.d1 = { threadId: "td", to: "info@q5.ch", subject: "x", body: "y" };
  write("sales.json", { records: { "q6.ch": { sale: { selected_offer: "REPAIR_CHECK_150", sale_date: "2026-09-01", sale_value: 150, work_status: "delivered" } } } });
  write(REVIEWS_FILE, { reviews: queued(7) });
  await worker().tick();
  const rv = reviews();
  for (const [h, reason] of [["q1.ch", "suppression"], ["q2.ch", "suppression"], ["q3.ch", "suppression"], ["q4.ch", "bereits kontaktiert/Entwurf vorhanden"], ["q5.ch", "bereits kontaktiert/Entwurf vorhanden"], ["q6.ch", "bestehender Kunde"]]) {
    assert.equal(rv[h].status, "blocked", h); assert.equal(rv[h].blocked_reason, reason, h);
  }
  assert.equal(rv["q7.ch"].status, "draft_created");
  assert.equal(g.calls.filter((c) => c.startsWith("create")).length, 1);
  // kein sichtbarer Fehler → Discovery legt gar nichts in die Queue
  await run(hosts(3, "leer").map(cand), anyAuditor(() => false));
  assert.equal(discoveryStatus(dir, clock).waiting_for_draft, 0);
});

test("Cold Draft niemals sendbar: 0 Send-Events, Worker-/Gmail-Sperren unverändert, Queue nie in state.actions; Dashboard-Felder", async () => {
  write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { draftPaceMs: 0 } });
  write(REVIEWS_FILE, { reviews: queued(3) });
  await worker().tick();
  assert.equal(byStatus().draft_created, 3);
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0);
  const st = readJ("state.json", { actions: {} });
  assert.ok(!Object.keys(st.actions || {}).some((k) => /q\d\.ch/.test(k)), "nie in der Send-Queue");
  for (const r of Object.values(reviews())) { assert.equal(r.draft_mode, COLD_MODE); assert.equal(r.legal_basis, "NONE"); assert.equal(r.automatic_send_allowed, false); }
  const mw = read("mail-worker.js");
  assert.match(mw, /cold_draft_never_auto/); assert.doesNotMatch(mw, /maxDraftsPerDay|maxDraftsPerHour|Tageslimit Entwürfe|Stundenlimit Entwürfe/, "kein Business-Cap im Worker");
  assert.doesNotMatch(read("lead-finder.js").replace(/\/\/.*$/gm, "").replace(/null,?\s*$/gm, ""), /dayN < cfg\.maxDraftsPerDay|hourN < cfg\.maxDraftsPerHour|draftBudget/, "kein Business-Cap in der Discovery");
  const s = discoveryStatus(dir, clock);
  for (const k of ["audited_today", "websites_limit", "qualified_total", "waiting_for_draft", "gmail_drafts_today", "open_drafts_total", "blocked_today", "draft_worker", "last_run_at", "next_run_at"]) assert.ok(k in s, k);
  assert.equal(s.gmail_drafts_today, 3); assert.equal(s.open_drafts_total, 3);
  const html = read("public/index.html");
  for (const id of ["dAudited", "dQualified", "dQueue", "dDrafts", "dOpen", "dBlocked", "dWorker", "dLastDraft", "dLast", "dNext"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /Limit \$\{d\.limits\?\.max_drafts_per_hour/, "keine Draft-Limit-Anzeige mehr");
  assert.match(html, /Websites heute/); assert.match(html, /Warten auf Gmail-Draft/); assert.match(html, /Gesamt offene Gmail-Drafts/); assert.match(html, /Draft Worker/);
  assert.match(read("mail-worker.js"), /if \(!discoveryRunning\) \{/, "Discovery entkoppelt vom Mail-/Draft-Takt");
});
