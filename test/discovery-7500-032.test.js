// 7500/DAY DISCOVERY (032): 5× Durchsatz – 105 Websites je Lauf, 315/h, harter Deckel 7500/Tag – mit begrenzter Parallelität (maxConcurrency),
// Quellen-Limiter (Retry-After, Backoff), atomarem Dedupe und unveränderten Qualitäts-/Suppression-/Cold-Draft-Regeln.
// Alles mit Attrappen – kein Netzwerk, kein Gmail, keine Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDiscovery, discoveryStatus, DEFAULT_DISCOVERY, overpassSearch, parseRetryAfter } from "../lead-finder.js";
import { createAuditor } from "../site-auditor.js";
import { createWorker } from "../mail-worker.js";
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
const cfg = (discovery = {}) => write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, discovery: { draftPaceMs: 0, intervalMinutes: 0, ...discovery } });
function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, calls: [], n: 0 };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async createDraft({ to, subject, body, mode }) { f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "t" + id, to, subject, body, mode, createdAt: clock.toISOString() }; return { draftId: id, threadId: "t" + id, messageId: "m" + id }; },
    async sendDraft(id) { f.calls.push("SEND " + id); throw new Error("COLD_LEAD_DRAFT_ONLY – nicht sendbar"); },
    async readThread() { return { messages: [] }; }, async updateDraft() {}, async deleteDraft() {}, async markDraftForReview() {},
  });
  return f;
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-032-")); g = fakeGmail(); clock = T0; cfg(); write("suppression.json", {}); });

const impressum = (host) => `<html><body><h1>Impressum</h1><p>${host.split(".")[0]} AG<br>Hauptstrasse 1, 8400 Winterthur<br>E-Mail: <a href="mailto:info@${host}">info@${host}</a><br>UID: CHE-123.456.789</p></body></html>`;
const broken = (host) => ({ type: "broken_link", url: `https://${host}/team-alt`, page: `https://${host}/`, label: "Unser Team", evidence: `HTTP 404 (verlinkt auf https://${host}/)`, severity: "medium", detectedAt: T0.toISOString() });
const audit = (host, issues = [broken(host)]) => ({ reachable: true, title: `${host} – Schreinerei`, finalUrl: `https://${host}/`, issues, impressumUrl: `https://${host}/impressum`, contactUrl: `https://${host}/kontakt`, teamUrl: null,
  pages: { home: `<html lang="de"><head><title>${host}</title></head><body>Schreinerei in Winterthur, Schweiz. Telefon +41 52 123 45 67</body></html>`, impressum: impressum(host), contact: "<html><body>Kontakt</body></html>" } });
const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");
// Auditor mit Zähler: Aufrufe je Domain, gleichzeitig aktive Audits (gesamt und je Domain), optional verzögert.
function countingAuditor({ withIssue = () => true, delayMs = 0 } = {}) {
  const a = { calls: {}, active: 0, peak: 0, domainPeak: 0, activeBy: {} };
  a.audit = async (url) => {
    const h = hostOf(url);
    a.calls[h] = (a.calls[h] || 0) + 1; a.active++; a.peak = Math.max(a.peak, a.active); a.activeBy[h] = (a.activeBy[h] || 0) + 1; a.domainPeak = Math.max(a.domainPeak, a.activeBy[h]);
    try { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return audit(h, withIssue(h) ? [broken(h)] : []); }
    finally { a.active--; a.activeBy[h]--; }
  };
  a.total = () => Object.values(a.calls).reduce((s, n) => s + n, 0);
  return a;
}
const cand = (host, extra = {}) => ({ company: `${host.split(".")[0]} AG`, website: `https://${host}/`, email: "", chain: false, source: "OpenStreetMap node/1 (Winterthur, craft)", ...extra });
const hosts = (n, p = "firma") => Array.from({ length: n }, (_, i) => `${p}${i + 1}.ch`);
const run = (candidates, auditor, opts = {}) => runDiscovery({ dir, gmail: g, search: opts.search || (async () => candidates), auditor, now: () => clock, log: () => {}, pid: process.pid, ...opts });
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", subject: "Re", body: "Guten Tag." }) });
const queued = (n, p = "q") => Object.fromEntries(hosts(n, p).map((h) => [h, { lead_id: h, domain: h, company: h, recipient: `info@${h}`, subject: "Hinweis", body: "Guten Tag", draft_hash: "h", status: "queued", draft_mode: COLD_MODE, legal_basis: "NONE", message_class: "DRAFT_ONLY", automatic_send_allowed: false, manual_send_decision_required: true, created_at: T0.toISOString(), updated_at: T0.toISOString() }]));

// ---------- Ziele ----------
test("Defaults: 20 min · 105 je Lauf · 315 je Stunde · 7500 je Tag; Parallelität zentral und begrenzt; Entwürfe ohne Business-Cap (null)", () => {
  assert.equal(DEFAULT_DISCOVERY.intervalMinutes, 20); assert.equal(DEFAULT_DISCOVERY.sitesPerRun, 105);
  assert.equal(DEFAULT_DISCOVERY.maxSitesPerHour, 315); assert.equal(DEFAULT_DISCOVERY.maxSitesPerDay, 7500);
  assert.equal(DEFAULT_DISCOVERY.sitesPerRun * 3, DEFAULT_DISCOVERY.maxSitesPerHour, "3 Läufe je Stunde");
  assert.ok(DEFAULT_DISCOVERY.sitesPerRun * 3 * 24 >= DEFAULT_DISCOVERY.maxSitesPerDay, "Taktung reicht rechnerisch für 7500");
  assert.ok(Number.isInteger(DEFAULT_DISCOVERY.maxConcurrency) && DEFAULT_DISCOVERY.maxConcurrency >= 1 && DEFAULT_DISCOVERY.maxConcurrency <= 16, "begrenzt, nie unlimitiert");
  assert.equal(DEFAULT_DISCOVERY.maxDraftsPerHour, null); assert.equal(DEFAULT_DISCOVERY.maxDraftsPerDay, null);
  assert.ok(DEFAULT_DISCOVERY.areas.length * DEFAULT_DISCOVERY.categories.length >= 1500, "breite Quelle: viele Orte × Branchen");
  assert.ok(DEFAULT_DISCOVERY.maxSearchesPerRun >= 2 && DEFAULT_DISCOVERY.searchMinGapMs >= 3000, "mehrere, aber gedrosselte Quellenabfragen je Lauf");
  assert.equal(new Set(DEFAULT_DISCOVERY.areas).size, DEFAULT_DISCOVERY.areas.length, "keine doppelten Orte");
  const sl = cleanDiscovery({ status: "ACTIVE", limits: { max_drafts_per_day: 20, max_concurrency: 4 } });
  assert.equal(sl.limits.max_drafts_per_day, null); assert.equal(sl.limits.max_concurrency, 4);
});

test("Niemals 7501: über viele Läufe genau 7500 Audits, danach bis zum nächsten Tag keines; Tagesreset danach", async () => {
  cfg({ sitesPerRun: 1000, maxSitesPerHour: 1_000_000 });
  const a = countingAuditor({ withIssue: () => false });
  for (let i = 0; i < 9; i++) { clock = new Date(+clock + 1000); await run(hosts(1000, `d${i}-`).map(cand), a); }
  assert.equal(a.total(), 7500, "harter Tagesdeckel");
  assert.equal(discoveryStatus(dir, clock).audited_today, 7500); assert.equal(discoveryStatus(dir, clock).websites_limit, 7500);
  clock = new Date(+clock + 1000);
  assert.equal((await run(hosts(5, "x").map(cand), a)).skipped, "day_limit");
  assert.equal(a.total(), 7500, "7501 wird nie geprüft");
  clock = new Date("2026-10-12T07:00:00Z"); // neuer Zürcher Tag
  await run(hosts(5, "y").map(cand), a);
  assert.equal(a.total(), 7505, "Tagesreset");
  assert.equal(discoveryStatus(dir, clock).audited_today, 5);
});

test("Niemals über 315 je Stunde: 3 × 105 → danach hour_limit; neue Stunde → weiter", async () => {
  cfg({ sitesPerRun: 105, maxSitesPerHour: 315, maxSitesPerDay: 7500 });
  const a = countingAuditor({ withIssue: () => false });
  for (let i = 0; i < 3; i++) { clock = new Date(+clock + 1000); assert.equal((await run(hosts(105, `h${i}-`).map(cand), a)).audited, 105); }
  assert.equal(a.total(), 315);
  clock = new Date(+clock + 1000);
  assert.equal((await run(hosts(105, "h9-").map(cand), a)).skipped, "hour_limit");
  assert.equal(a.total(), 315); assert.equal(discoveryStatus(dir, clock).audited_hour, 315);
  clock = new Date(+T0 + 61 * MIN);
  assert.equal((await run(hosts(105, "n-").map(cand), a)).audited, 105);
  assert.equal(discoveryStatus(dir, clock).audited_hour, 105);
});

test("Teilstunde: sitesPerRun 105, aber nur 40 Stundenbudget übrig → genau 40 Audits (Deckel gilt innerhalb des Laufs)", async () => {
  cfg({ sitesPerRun: 105, maxSitesPerHour: 315 });
  const a = countingAuditor({ withIssue: () => false });
  for (let i = 0; i < 2; i++) { clock = new Date(+clock + 1000); await run(hosts(105, `a${i}-`).map(cand), a); }
  write("discovery_counter.json", { day: "2026-10-11", audited: 210, hour: "2026-10-11T07", hourAudited: 275 });
  clock = new Date(+clock + 1000);
  assert.equal((await run(hosts(105, "z-").map(cand), a)).audited, 40);
});

test("Neustart/Absturz: Zählerfile hält den Deckel auch wenn discovered.json den Stand nicht mehr kennt", async () => {
  cfg({ sitesPerRun: 1000, maxSitesPerDay: 1500, maxSitesPerHour: 1_000_000 });
  const a = countingAuditor({ withIssue: () => false });
  await run(hosts(1000, "e-").map(cand), a);
  const d = readJ("discovered.json"); d.stats = {}; d.hourly = {}; write("discovered.json", d); // Absturz: Statistik nicht geschrieben
  clock = new Date(+clock + 1000);
  const r = await run(hosts(1000, "f-").map(cand), a);
  assert.equal(r.audited, 500); assert.equal(a.total(), 1500, "nie über 1500 (hier konfigurierter Deckel)");
  assert.equal(discoveryStatus(dir, clock).audited_today, 1500);
});

// ---------- Parallelität, Dedupe, Race ----------
test("Parallelität begrenzt: nie mehr als maxConcurrency gleichzeitig, pro Domain höchstens eine aktive Prüfung, Reihenfolge der Ergebnisse stabil", async () => {
  cfg({ sitesPerRun: 60, maxConcurrency: 3, maxSitesPerHour: 1000 });
  const a = countingAuditor({ delayMs: 4 });
  const list = hosts(60, "p-");
  const r = await run(list.map(cand), a);
  assert.equal(a.total(), 60); assert.equal(a.peak, 3, "genau die konfigurierte Parallelität, nie mehr"); assert.equal(a.domainPeak, 1);
  assert.deepEqual(r.found.map((l) => l.domain), list, "Ergebnisse in Kandidatenreihenfolge");
  cfg({ sitesPerRun: 20, maxConcurrency: 1, maxSitesPerHour: 1000 });
  const b = countingAuditor({ delayMs: 2 });
  await run(hosts(20, "s-").map(cand), b);
  assert.equal(b.peak, 1, "maxConcurrency 1 = strikt sequenziell");
});

test("Keine doppelten Audits/Leads: doppelte Domains, www-Varianten und gleiche Firma unter anderer Domain → nur ein Audit; zweiter Lauf prüft nichts erneut", async () => {
  cfg({ sitesPerRun: 50, maxConcurrency: 4 });
  const a = countingAuditor({ delayMs: 3 });
  const list = [cand("dup.ch"), cand("dup.ch"), cand("www.dup.ch", { website: "https://www.dup.ch/" }), cand("dup.ch", { website: "http://DUP.ch/kontakt" }),
    cand("zwilling.ch", { company: "Muster AG" }), cand("muster.ch", { company: "Muster GmbH" }), ...hosts(10, "u-").map(cand)];
  await run(list, a);
  assert.equal(a.calls["dup.ch"], 1, "eine Domain = ein Audit");
  assert.equal((a.calls["zwilling.ch"] || 0) + (a.calls["muster.ch"] || 0), 1, "gleiche Firma, andere Domain → einmal");
  assert.equal(a.total(), 12);
  clock = new Date(+clock + 1000);
  await run(list, a);
  assert.equal(a.total(), 12, "bereits aktuelle Audits werden übersprungen");
  assert.equal(Object.keys(readJ("discovered.json").leads).length, 12);
});

test("Keine doppelten Drafts: 80 qualifizierte Leads (parallel geprüft), zweimal angeboten → je Adresse genau ein Queue-Eintrag und ein Gmail-Entwurf", async () => {
  cfg({ sitesPerRun: 200, maxSitesPerHour: 1000, maxConcurrency: 5, draftsPerPass: 1000 });
  const a = countingAuditor({ delayMs: 1 });
  const list = hosts(80, "k-").map(cand);
  await run(list, a);
  clock = new Date(+clock + 1000);
  await run(list, a);
  assert.equal(Object.keys(reviews()).length, 80); assert.equal(discoveryStatus(dir, clock).waiting_for_draft, 80);
  await worker().tick(); clock = new Date(+clock + 2 * MIN); await worker().tick();
  const creates = g.calls.filter((c) => c.startsWith("create")).map((c) => c.slice(7));
  assert.equal(creates.length, 80); assert.equal(new Set(creates).size, 80, "keine doppelten Gmail-Drafts");
  assert.equal(byStatus().draft_created, 80);
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0, "0 Cold-Send-Events");
});

// ---------- Qualität unverändert ----------
test("Qualitäts-Gate unter Parallelität: kein sichtbarer Befund / Suppression / Opt-out / bereits kontaktiert / ohne Geschäftsadresse → KEIN Draft", async () => {
  cfg({ sitesPerRun: 50, maxConcurrency: 4 });
  write("suppression.json", { "info@supp.ch": { reason: "bounce", at: T0.toISOString() }, "chef@optout.ch": { reason: "opt-out (Antwort)", at: T0.toISOString() } });
  g.reg.sent.s1 = { threadId: "ts", to: "info@kontaktiert.ch", subject: "x", sentAt: T0.toISOString() };
  g.reg.drafts.d1 = { threadId: "td", to: "info@hatdraft.ch", subject: "x", body: "y" };
  const a = countingAuditor({ withIssue: (h) => h !== "leer.ch" });
  const r = await run(["leer.ch", "supp.ch", "optout.ch", "kontaktiert.ch", "hatdraft.ch", "gut.ch"].map(cand), a);
  const st = Object.fromEntries(r.found.map((l) => [l.domain, l.status]));
  assert.equal(st["leer.ch"], "no_issues"); assert.equal(st["supp.ch"], "suppressed"); assert.equal(st["optout.ch"], "suppressed");
  assert.equal(st["kontaktiert.ch"], "duplicate"); assert.equal(st["hatdraft.ch"], "duplicate"); assert.equal(st["gut.ch"], "blocked_no_legal_basis");
  assert.deepEqual(Object.keys(reviews()), ["gut.ch"], "nur der qualifizierte Lead wird vorgemerkt");
  // kein Kontakt auf der Website → no_contact → kein Draft
  const noMail = { audit: async (u) => { const h = hostOf(u); const x = audit(h); x.pages.impressum = "<html><body>Impressum ohne Adresse</body></html>"; return x; } };
  clock = new Date(+clock + 1000);
  const r2 = await run([cand("ohnemail.ch")], noMail);
  assert.ok(["no_contact", "low_score"].includes(r2.found[0].status), r2.found[0].status); assert.ok(!reviews()["ohnemail.ch"]);
  // Befund ohne Beleg gibt es nicht: ein Audit ohne issues kann nie einen Draft erzeugen
  assert.ok(Object.values(reviews()).every((rv) => rv.legal_basis === "NONE" && rv.automatic_send_allowed === false && rv.draft_mode === COLD_MODE));
});

test("Früh verworfen (kein Audit, kein Audit-Budget): Social-/Plattformseiten, Ketten, Freemail, ohne Firmenname", async () => {
  cfg({ sitesPerRun: 50 });
  const a = countingAuditor();
  const list = [cand("facebook.com", { website: "https://www.facebook.com/muster" }), cand("x.com", { website: "https://x.com/muster" }), cand("local.ch", { website: "https://tel.local.ch/x" }),
    cand("kette.ch", { chain: true }), cand("gmail.com", { website: "https://gmail.com" }), cand("ohnename.ch", { company: "" }), cand("echt.ch")];
  const r = await run(list, a);
  assert.deepEqual(Object.keys(a.calls), ["echt.ch"]); assert.equal(r.audited, 1);
  assert.equal(discoveryStatus(dir, clock).audited_today, 1, "verworfene Kandidaten verbrauchen kein Website-Budget");
});

test("Firmen mit hinterlegter Geschäftsadresse (OSM) werden zuerst geprüft", async () => {
  cfg({ sitesPerRun: 3, maxConcurrency: 1 });
  const order = [];
  const a = { audit: async (u) => { order.push(hostOf(u)); return audit(hostOf(u), []); } };
  await run([cand("a.ch"), cand("b.ch"), cand("c.ch", { email: "info@c.ch" }), cand("d.ch", { email: "info@d.ch" })], a);
  assert.deepEqual(order, ["c.ch", "d.ch", "a.ch"]);
});

test("Archiv: nicht qualifizierte Leads früherer Tage wandern in den kompakten Dedupe-Index (nie erneut geprüft), qualifizierte bleiben", async () => {
  cfg({ sitesPerRun: 50 });
  const a = countingAuditor({ withIssue: (h) => h.startsWith("gut") });
  await run([...hosts(5, "gut").map(cand), ...hosts(5, "leer").map(cand)], a);
  assert.equal(Object.keys(readJ("discovered.json").leads).length, 10);
  clock = new Date("2026-10-12T07:00:00Z");
  await run([...hosts(5, "gut").map(cand), ...hosts(5, "leer").map(cand), cand("neu.ch")], a);
  const leads = readJ("discovered.json").leads;
  assert.ok(Object.keys(leads).every((d) => d.startsWith("gut") || d === "neu.ch"), "no_issues-Leads sind ausgelagert");
  assert.equal(Object.keys(readJ("audited_index.json").domains).length, 5);
  assert.equal(a.total(), 11, "kein erneuter Audit der bereits geprüften Domains");
  assert.equal(Object.keys(reviews()).length, 5, "Queue unverändert");
});

// ---------- Queue / Gmail ----------
test("Discovery schneller als Gmail: Queue wächst kontrolliert, nichts geht verloren, nach Neustart geht es weiter; Gmail-429 verliert keinen Lead", async () => {
  cfg({ sitesPerRun: 105, maxSitesPerHour: 100000, maxConcurrency: 4, draftsPerPass: 25 });
  const a = countingAuditor();
  for (let i = 0; i < 3; i++) { clock = new Date(+clock + 1000); await run(hosts(105, `w${i}-`).map(cand), a); }
  assert.equal(discoveryStatus(dir, clock).waiting_for_draft, 315, "Queue wächst");
  await worker().tick();
  assert.equal(byStatus().draft_created, 25); assert.equal(byStatus().queued, 290);
  // Gmail 429 → Backoff, Queue unverändert
  g.createDraft = async () => { throw new Error("HTTP 429 rate limit"); };
  clock = new Date(+clock + 2 * MIN);
  await worker().tick();
  assert.equal(byStatus().queued, 290, "kein Lead verloren"); assert.equal(discoveryStatus(dir, clock).draft_worker.status, "BACKOFF");
  // „Neustart“: neuer Worker, funktionierendes Gmail
  g = fakeGmail(); g.n = 100; clock = new Date(+clock + 70 * MIN);
  for (let i = 0; i < 12; i++) { await worker().tick(); clock = new Date(+clock + 2 * MIN); }
  assert.equal(byStatus().draft_created, 315); assert.equal(byStatus().queued ?? 0, 0);
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0);
});

// ---------- Quelle: Limiter, Retry-After, Backoff ----------
const resp = (status, headers = {}, body = { elements: [] }) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const pair = { area: "Winterthur", category: { key: "craft" } };

test("Quelle 429: Retry-After wird respektiert; ohne Header exponentiell (30 s · 2^n); nie mehr als maxRetries", async () => {
  const sleeps = [];
  const seq = [resp(429, { "retry-after": "7" }), resp(503), resp(200, {}, { elements: [{ type: "node", id: 1, tags: { name: "A AG", website: "https://a.ch" } }] })];
  const s = overpassSearch({ fetchFn: async () => seq.shift(), sleep: async (ms) => { sleeps.push(ms); }, retryMs: 30_000 });
  const out = await s(pair);
  assert.deepEqual(sleeps, [7000, 60_000], "Retry-After 7 s, danach exponentiell 30 s · 2");
  assert.equal(out[0].website, "https://a.ch");
  const always = overpassSearch({ fetchFn: async () => resp(503), sleep: async () => {}, retryMs: 1 });
  await assert.rejects(() => always(pair), /Overpass HTTP 503/);
  assert.equal(parseRetryAfter("120"), 120_000); assert.equal(parseRetryAfter(""), null); assert.ok(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString()) <= 30_000);
});

test("Quelle: Retry-After länger als maxWaitMs → keine Wartezeit im Lauf, Fehler mit retryAfterMs → Lauf-Backoff mindestens so lang; 5xx → 15 → 30 min", async () => {
  let calls = 0;
  const s = overpassSearch({ fetchFn: async () => { calls++; return resp(429, { "retry-after": "3600" }); }, sleep: async () => { throw new Error("darf nicht warten"); } });
  await assert.rejects(() => s(pair), (e) => e.retryAfterMs === 3_600_000);
  assert.equal(calls, 1, "kein aggressives Wiederholen");
  cfg({ sitesPerRun: 10 });
  const err = Object.assign(new Error("Overpass HTTP 429"), { retryAfterMs: 3_600_000 });
  await run([], countingAuditor(), { search: async () => { throw err; } });
  let st = discoveryStatus(dir, clock);
  assert.equal(st.status, "BACKOFF"); assert.equal(Date.parse(st.backoff_until), +clock + 60 * MIN, "Retry-After (60 min) > Backoff 15 min");
  clock = new Date(+clock + 61 * MIN);
  await run([], countingAuditor(), { search: async () => { throw new Error("Overpass HTTP 503"); } });
  st = discoveryStatus(dir, clock);
  assert.equal(st.backoff_count, 2); assert.equal(Date.parse(st.backoff_until), +clock + 30 * MIN, "exponentiell 15 → 30");
});

test("Quellen-Limiter: Abfragen strikt nacheinander (nie parallel) mit Mindestabstand", async () => {
  let active = 0, peak = 0; const starts = [];
  const fetchFn = async () => { active++; peak = Math.max(peak, active); starts.push(Date.now()); await new Promise((r) => setTimeout(r, 5)); active--; return resp(200); };
  const s = overpassSearch({ fetchFn, minGapMs: 30, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
  await Promise.all([s(pair), s(pair), s(pair)]);
  assert.equal(peak, 1, "nie parallel");
  assert.ok(starts[1] - starts[0] >= 25 && starts[2] - starts[1] >= 25, "Mindestabstand eingehalten");
});

test("Mehrere Quellenabfragen je Lauf bis genug neue Firmen vorliegen (Obergrenze maxSearchesPerRun); Ort/Branche ohne Neues wird nicht erneut abgefragt", async () => {
  cfg({ sitesPerRun: 105, maxSearchesPerRun: 4, maxConcurrency: 4, maxSitesPerHour: 100000 });
  let n = 0; const queries = [];
  const search = async (p) => { queries.push(`${p.area}/${p.category.key}${p.category.value || ""}`); return hosts(40, `s${n++}-`).map(cand); };
  const a = countingAuditor({ withIssue: () => false });
  const r = await run([], a, { search });
  assert.equal(r.searches, 3, "3 × 40 ≥ 105 → drei Abfragen"); assert.equal(a.total(), 105); assert.equal(new Set(queries).size, 3);
  clock = new Date(+clock + 1000);
  let q2 = 0; const dead = async () => { q2++; return hosts(40, "s0-").map(cand); }; // nur Bekanntes
  const r2 = await run([], a, { search: dead });
  assert.equal(r2.searches, 4, "Obergrenze maxSearchesPerRun"); assert.equal(a.total(), 105, "nichts erneut geprüft");
  assert.equal(discoveryStatus(dir, clock).pool_exhausted, false);
  const pairs = readJ("discovered.json").pairs;
  assert.ok(Object.values(pairs).filter((p) => p.fresh === 0).length >= 4, "erschöpfte Paare vermerkt");
  clock = new Date(+clock + 1000); q2 = 0;
  await run([], a, { search: dead });
  assert.ok(q2 <= 4 && !queries.includes(undefined));
});

test("Einzelner 5xx/Timeout einer Abfrage stoppt die Quelle nicht (nur dieses Paar wird 6 h pausiert); 429 stoppt sofort", async () => {
  cfg({ sitesPerRun: 20, maxSearchesPerRun: 5 });
  let n = 0;
  const a = countingAuditor({ withIssue: () => false });
  const r = await run([], a, { search: async () => { if (n++ === 0) throw new Error("Overpass HTTP 504"); return hosts(25, "g-").map(cand); } });
  assert.equal(a.total(), 20); assert.equal(r.searches, 2); assert.equal(discoveryStatus(dir, clock).status, "ACTIVE", "kein Backoff");
  assert.equal(Object.values(readJ("discovered.json").pairs).filter((p) => p.error).length, 1);
  clock = new Date(+clock + 21 * MIN);
  let m = 0;
  const r2 = await run([], a, { search: async () => { m++; throw new Error("Overpass HTTP 429"); } });
  assert.equal(m, 1, "429: sofort Schluss"); assert.equal(r2.searches, 1); assert.equal(discoveryStatus(dir, clock).status, "BACKOFF");
});

test("Quellenfehler mitten im Lauf: bereits gefundene Firmen werden trotzdem geprüft, danach Backoff (kein aggressives Wiederholen)", async () => {
  cfg({ sitesPerRun: 105, maxSearchesPerRun: 5 });
  let n = 0;
  const search = async () => { if (n++ === 0) return hosts(30, "ok-").map(cand); throw new Error("Overpass HTTP 503"); };
  const a = countingAuditor({ withIssue: () => false });
  const r = await run([], a, { search });
  assert.equal(a.total(), 30); assert.equal(r.searches, 3, "erster Fehler: nächstes Paar; zweiter Fehler: Abbruch");
  const st = discoveryStatus(dir, clock);
  assert.equal(st.status, "BACKOFF"); assert.equal(st.backoff_count, 1);
});

test("Audit-Zeitbudget: träge Seite → Zusatzprüfungen entfallen, nie ein Befund aus Zeitmangel", async () => {
  const pagesHtml = `<html lang="de"><head><title>T</title><meta name="viewport" content="x"><meta name="description" content="d"></head><body><a href="/a">A</a><a href="/b">B</a><img src="/i.png" alt="x"></body></html>`;
  const fetchFn = async (url) => ({ status: /robots/.test(url) ? 404 : /\/(a|b|i\.png)$/.test(url) ? 404 : 200, url, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html" : null) }, text: async () => pagesHtml, body: { cancel: async () => {} } });
  const slow = await createAuditor({ fetchFn, delayMs: 0, totalMs: -1, now: () => T0 }).audit("https://x.ch");
  assert.ok(!slow.issues.some((i) => /broken_(link|image)/.test(i.type)), "kein Befund ohne geprüften Beleg");
  const normal = await createAuditor({ fetchFn, delayMs: 0, now: () => T0 }).audit("https://x.ch");
  assert.ok(normal.issues.some((i) => i.type === "broken_link"), "mit Zeitbudget werden die Links geprüft");
});

// ---------- Sicherheit / Dashboard ----------
test("Cold-Draft-Sicherheit unverändert: COLD_LEAD_DRAFT_ONLY, kein Auto-Send, kein sendDraft/Force/Approval→Send im Discovery-/Draft-Pfad", async () => {
  cfg({ sitesPerRun: 20, maxConcurrency: 4 });
  await run(hosts(10, "c-").map(cand), countingAuditor());
  await worker().tick();
  for (const r of Object.values(reviews())) {
    assert.equal(r.draft_mode, COLD_MODE); assert.equal(r.legal_basis, "NONE"); assert.equal(r.automatic_send_allowed, false);
    assert.equal(r.automatic_send_eligible ?? false, false); assert.equal(r.delivery ?? "draft", "draft");
  }
  assert.equal(g.calls.filter((c) => c.startsWith("SEND")).length, 0, "0 Cold-Send-Events");
  assert.ok(!Object.keys(readJ("state.json", { actions: {} }).actions || {}).some((k) => /c-\d+\.ch/.test(k)));
  const lf = read("lead-finder.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(lf, /sendDraft|sendMail|force_send|FORCE_SEND|autoSend\s*[:=]\s*true/i, "Discovery kann nicht senden");
  assert.doesNotMatch(read("mail-worker.js"), /maxDraftsPerDay|maxDraftsPerHour|Tageslimit Entwürfe|Stundenlimit Entwürfe/);
});

test("Dashboard/Mobile: Websites heute/Stunde, qualifiziert, warten, Gmail heute, offen, letzter Lauf, Rate, Draft Worker, Backoff, VPS CPU/RAM", async () => {
  cfg({ sitesPerRun: 40, maxConcurrency: 4 });
  const a = countingAuditor();
  await run(hosts(40, "m-").map(cand), a);
  await worker().tick();
  const s = discoveryStatus(dir, clock);
  assert.equal(s.audited_today, 40); assert.equal(s.websites_limit, 7500); assert.equal(s.audited_hour, 40); assert.equal(s.websites_hour_limit, 315);
  assert.equal(s.qualified_total, 40); assert.equal(s.gmail_drafts_today, 25); assert.equal(s.waiting_for_draft, 15); assert.equal(s.open_drafts_total, 25);
  assert.equal(s.last_run_audited, 40); assert.equal(s.discovery_rate_per_hour, 40); assert.equal(s.max_concurrency, 4); assert.equal(s.draft_worker.status, "ACTIVE");
  const c = cleanDiscovery(s);
  for (const k of ["websites_limit", "websites_hour_limit", "last_run_audited", "discovery_rate_per_hour", "max_concurrency", "waiting_for_draft", "gmail_drafts_today", "open_drafts_total", "draft_worker"]) assert.ok(c[k] !== undefined && c[k] !== null, `Cloud-Whitelist: ${k}`);
  assert.equal(c.websites_hour_limit, 315);
  const html = read("public/index.html");
  for (const id of ["dAudited", "dHour", "dQualified", "dQueue", "dDrafts", "dOpen", "dWorker", "dLastN", "dRate", "dCpu", "dRam", "dState", "dError"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /Websites diese Stunde/); assert.match(html, /Discovery-Rate/); assert.match(html, /VPS CPU/); assert.match(html, /VPS RAM/);
  assert.match(html, /\.kv\b/, "gleiches Raster für Handy und Desktop");
  assert.doesNotMatch(html, /harten Tagesdeckel \(1500\)/, "keine veraltete 1500-Anzeige");
  assert.match(read("mail-worker.js"), /if \(!discoveryRunning\) \{/, "Discovery bleibt vom Mail-/Draft-Takt entkoppelt");
});
