// TF-JARVIS-CRM-016: getrennte, kontrollierte Neuprüfung veralteter QUALIFIED-Leads + Verlässlichkeit der Overpass-Suche.
// Nur synthetische Daten, kein Netz, kein Gmail, kein Senden.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileQualified, recheckStale, RECHECK_RESULTS_FILE, RECHECK_LOCK_FILE } from "../scripts/tf015-reconcile-qualified.mjs";
import { overpassSearch, classifySourceError, overpassRuntimeError, runDiscovery, discoveryStatus, DEFAULT_DISCOVERY } from "../lead-finder.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000, MIN = 60_000;
const ago = (d) => new Date(+NOW - d * DAY).toISOString();
const SENDER = { name: "Test Sender", company: "Test Firma", email: "sender@example.ch" };
const LINK = (d, at) => ({ type: "broken_link", url: `https://${d}/team-alt`, page: `https://${d}/`, evidence: `HTTP 404 (verlinkt auf https://${d}/)`, severity: "medium", detectedAt: at, label: "Unser Team" });
const disc = (d, at, issues = [LINK(d, at)]) => ({ email: `info@${d}`, business_email: `info@${d}`, company: `${d.split(".")[0]} AG`, website: `https://${d}/`, domain: d, uid: "CHE-123.456.789", status: "blocked_no_legal_basis",
  auditedAt: at, discoveredAt: at, reachable: true, title: "Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)", canton: "ZH", municipality: "Winterthur", category: "craft",
  contact_source: "impressum", source_url: `https://${d}/impressum`, collected_at: at, contact_confidence: "medium", websiteIssues: issues });
const regQ = (d) => ({ lead_id: d, domain: d, company: `${d.split(".")[0]} AG`, business_email: `info@${d}`, status: "QUALIFIED", qualified: true, audited: true, gmail_draft_status: "none",
  customer_status: "none", reply_status: "none", do_not_contact: false, opt_out: false, suppressed: false, manual_send_detected: false });

const CRM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-016-crm-"));
fs.writeFileSync(path.join(CRM_DIR, "lead_crm.json"), JSON.stringify({ schema: 1, leads: {} }));
process.env.JARVIS_CRM_DIR = CRM_DIR;

const hash = (f) => { try { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };
function staleState(n, prefix = "s", { incomplete = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-016-mail-")), W = path.join(dir, "mail_worker");
  fs.mkdirSync(W, { recursive: true });
  const ds = Array.from({ length: n }, (_, i) => `${prefix}${i}.ch`);
  const leads = Object.fromEntries(ds.map((d, i) => [d, i < incomplete ? disc(d, ago(1), [{ type: "broken_link", url: `https://${d}/x` }]) : disc(d, ago(20))]));
  fs.writeFileSync(path.join(W, "lead_registry.json"), JSON.stringify({ schema: 1, leads: Object.fromEntries(ds.map((d) => [d, regQ(d)])) }));
  fs.writeFileSync(path.join(W, "discovered.json"), JSON.stringify({ leads }));
  fs.writeFileSync(path.join(W, "individual_reviews.json"), JSON.stringify({ reviews: {} }));
  fs.writeFileSync(path.join(W, "config.json"), JSON.stringify({ sender: SENDER }));
  fs.writeFileSync(path.join(W, "suppression.json"), "{}");
  fs.writeFileSync(path.join(dir, "gmail_jarvis.json"), JSON.stringify({ sent: {}, drafts: {} }));
  const protectedFiles = ["individual_reviews.json", "lead_registry.json", "discovered.json", "suppression.json"].map((f) => path.join(W, f)).concat(path.join(dir, "gmail_jarvis.json"));
  return { dir, W, ds, reviews: () => JSON.parse(fs.readFileSync(path.join(W, "individual_reviews.json"), "utf8")).reviews,
    results: () => JSON.parse(fs.readFileSync(path.join(W, RECHECK_RESULTS_FILE), "utf8")).domains, snapshot: () => protectedFiles.map(hash) };
}
const recheck = (s, o = {}) => recheckStale({ secretsDir: s.dir, base: ROOT, now: NOW, dryRun: false, repairStateDir: null, gapMs: 0, retryBaseMs: 0, sleep: async () => {}, ...o });
const reconcile = (s, o = {}) => reconcileQualified({ secretsDir: s.dir, base: ROOT, now: NOW, repairStateDir: null, ...o });
const goodAuditor = (calls = []) => ({ audit: async (u) => { calls.push(u); const d = new URL(u).hostname; return { reachable: true, issues: [LINK(d, NOW.toISOString())] }; } });

// ---------- Neuprüfung (getrennt von der Kontakt-Eignung) ----------
test("R1 Dry-Run (Standard): Grund veraltet/unvollständig, Standard-Batch 10, keine Prüfung, kein Schreiben", async () => {
  const s = staleState(14, "s", { incomplete: 3 }), before = s.snapshot();
  const r = await recheckStale({ secretsDir: s.dir, base: ROOT, now: NOW, repairStateDir: null, auditor: { audit: async () => assert.fail("Dry-Run prüft nie") } });
  assert.equal(r.dry_run, true); assert.equal(r.pending_total, 14);
  assert.deepEqual(r.pending_reason, { stale_audit: 11, incomplete_evidence: 3 });
  assert.equal(r.batch_limit, 10); assert.equal(r.next_batch, 10); assert.equal(r.outreach_authorized, false);
  assert.ok(!fs.existsSync(path.join(s.W, RECHECK_RESULTS_FILE))); assert.deepEqual(s.snapshot(), before);
});

test("R2 Trennung: Neuprüfung schreibt NUR die Ergebnisdatei – keine Queue, kein Register, kein Gmail; Eignung nur gezählt", async () => {
  const s = staleState(3), before = s.snapshot();
  const r = await recheck(s, { auditor: goodAuditor() });
  assert.equal(r.processed, 3); assert.equal(r.outcome.audited, 3); assert.equal(r.evidence_complete, 3);
  assert.deepEqual(s.snapshot(), before, "Queue/Register/Discovery/Suppression/Gmail unverändert");
  assert.deepEqual(s.reviews(), {}, "kein automatischer Queue-Eintrag");
  assert.equal(r.eligibility_after_recheck.recoverable_requires_approval, 3, "nur Zählung – Einreihen braucht den separaten Apply");
  assert.ok(Object.values(s.results()).every((e) => e.outreach_authorized === false));
  const ap = await reconcile(s, { dryRun: false });
  assert.equal(ap.queued, 3, "erst der separate Apply reiht ein (alle Regeln erneut geprüft)");
});

test("R3 kleine Batches + wiederholte Ausführung: höchstens maxBatch je Lauf, nie eine Domain doppelt", async () => {
  const s = staleState(7), calls = [];
  const r1 = await recheck(s, { auditor: goodAuditor(calls), maxBatch: 3 });
  assert.equal(r1.processed, 3); assert.equal(r1.remaining, 4);
  await recheck(s, { auditor: goodAuditor(calls), maxBatch: 3 });
  const r3 = await recheck(s, { auditor: goodAuditor(calls), maxBatch: 3 });
  assert.equal(r3.processed, 1); assert.equal(calls.length, 7); assert.equal(new Set(calls).size, 7);
  const r4 = await recheck(s, { auditor: goodAuditor(calls), maxBatch: 3 });
  assert.equal(r4.processed, 0, "wiederholte Ausführung: nichts mehr zu prüfen"); assert.equal(calls.length, 7);
});

test("R4 Rate-Limit + Zeitgrenze je Website: Mindestabstand; hängende Website → Timeout (vorübergehend, nicht endgültig)", async () => {
  const s = staleState(3), waits = [];
  await recheck(s, { auditor: goodAuditor(), gapMs: 40, sleep: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, ms)); } });
  assert.ok(waits.filter((w) => w > 0).length >= 2, "vor der 2. und 3. Prüfung wird gewartet");
  const h = staleState(1, "h");
  const r = await recheck(h, { auditor: { audit: () => new Promise(() => {}) }, auditTimeoutMs: 20, auditRetries: 1 });
  assert.equal(r.outcome.transient_gave_up, 1); assert.equal(r.retries, 1);
  const e = h.results()["h0.ch"]; assert.equal(e.final, false); assert.equal(e.tries, 2);
});

test("R5 Retry: exponentiell, Zufallszuschlag begrenzt, gedeckelt; nach Erschöpfung frühestens nach transientRetryHours erneut", async () => {
  const s = staleState(2), waits = []; let n = 0;
  const flaky = { audit: async (u) => { n++; if (u.includes("s0") && n === 1) throw new Error("fetch failed ECONNRESET"); if (u.includes("s1")) throw new Error("ETIMEDOUT"); return { reachable: true, issues: [LINK("s0.ch", NOW.toISOString())] }; } };
  const r = await recheck(s, { auditor: flaky, auditRetries: 2, retryBaseMs: 100, retryMaxMs: 150, jitter: 0.5, random: () => 1, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [150, 150, 150], "100·1.5 = 150; 200·1.5 → gedeckelt auf 150");
  assert.equal(r.outcome.audited, 1); assert.equal(r.outcome.transient_gave_up, 1); assert.equal(r.retries, 3);
  let again = 0;
  const cnt = { audit: async () => { again++; return { reachable: true, issues: [] }; } };
  const r2 = await recheck(s, { auditor: cnt });
  assert.equal(again, 0, "innerhalb der Wartezeit nicht erneut"); assert.equal(r2.skipped_transient_wait, 1);
  await recheck(s, { auditor: cnt, now: new Date(+NOW + 7 * 3_600_000) });
  assert.equal(again, 1, "danach genau die vorübergehend gescheiterte Domain");
});

test("R6 Circuit-Breaker: vorübergehende Fehlschläge in Folge → Lauf endet, Rest unberührt", async () => {
  const s = staleState(8); let n = 0;
  const r = await recheck(s, { auditor: { audit: async () => { n++; throw new Error("fetch failed"); } }, auditRetries: 0, breakerThreshold: 3 });
  assert.equal(r.circuit_open, true); assert.equal(r.processed, 3); assert.equal(n, 3); assert.equal(r.remaining, 5);
});

test("R7 Unterbrechung + Fortsetzung: Abbruchsignal speichert Erledigtes, Sperre frei; nächster Lauf setzt ohne Doppel fort", async () => {
  const s = staleState(5), calls = [];
  const r1 = await recheck(s, { auditor: goodAuditor(calls), shouldStop: () => calls.length >= 2 });
  assert.equal(r1.interrupted, true); assert.equal(r1.processed, 2); assert.equal(Object.keys(s.results()).length, 2);
  assert.ok(!fs.existsSync(path.join(s.W, RECHECK_LOCK_FILE)), "Sperre freigegeben");
  const r2 = await recheck(s, { auditor: goodAuditor(calls) });
  assert.equal(r2.processed, 3); assert.equal(new Set(calls).size, 5); assert.equal(calls.length, 5);
});

test("R8 Sperre: laufende Neuprüfung blockiert eine zweite; veraltete Sperre (Absturz) wird ersetzt; Temp-Rest entfernt", async () => {
  const s = staleState(2), lock = path.join(s.W, RECHECK_LOCK_FILE);
  fs.writeFileSync(lock, "{}");
  const r = await recheck(s, { auditor: { audit: async () => assert.fail("darf nicht prüfen") } });
  assert.equal(r.locked, true); assert.equal(r.processed, 0);
  const old = new Date(Date.now() - 4 * 3_600_000); fs.utimesSync(lock, old, old);
  const tmp = path.join(s.W, `${RECHECK_RESULTS_FILE}.tf015-4242.tmp`); fs.writeFileSync(tmp, "{kaputt");
  const r2 = await recheck(s, { auditor: goodAuditor() });
  assert.equal(r2.processed, 2); assert.ok(!fs.existsSync(tmp)); assert.ok(!fs.existsSync(lock));
});

test("R9 gleichzeitige Änderung der Ergebnisdatei: fremde Einträge bleiben erhalten (neu einlesen + zusammenführen, atomar)", async () => {
  const s = staleState(2), file = path.join(s.W, RECHECK_RESULTS_FILE);
  let first = true;
  const auditor = { audit: async (u) => {
    if (first) { first = false; fs.writeFileSync(file, JSON.stringify({ v: 1, domains: { "fremd.ch": { at: ago(0), outcome: "audited_no_issue", final: true, issues: [] } } })); }
    return goodAuditor().audit(u);
  } };
  await recheck(s, { auditor });
  const res = s.results();
  assert.ok(res["fremd.ch"], "paralleler Eintrag nicht verloren"); assert.ok(res["s0.ch"] && res["s1.ch"]);
  assert.ok(!fs.readdirSync(s.W).some((f) => f.endsWith(".tmp")));
});

test("R10 gesperrt / bereits kontaktiert / Duplikat: nie neu geprüft; nach Neuprüfung gelten alle Regeln", async () => {
  const s = staleState(4);
  fs.writeFileSync(path.join(s.W, "suppression.json"), JSON.stringify({ "info@s1.ch": { reason: "opt-out" } }));
  fs.writeFileSync(path.join(s.dir, "gmail_jarvis.json"), JSON.stringify({ sent: { m: { to: "info@s2.ch" } }, drafts: {} }));
  fs.writeFileSync(path.join(s.W, "individual_reviews.json"), JSON.stringify({ reviews: { "s3.ch": { lead_id: "s3.ch", domain: "s3.ch", status: "manually_sent", created_at: ago(30) } } }));
  const calls = [];
  const r = await recheck(s, { auditor: goodAuditor(calls) });
  assert.deepEqual(calls, ["https://s0.ch/"], "Suppression, kontaktiert und bestehender Eintrag werden gar nicht erst geprüft");
  const e = r.eligibility_after_recheck;
  assert.equal(e.recoverable_requires_approval, 1); assert.equal(e.consistent, true);
  const after = await reconcile(s, { dryRun: true });
  assert.equal(after.blocked_dnc, 1); assert.equal(after.represented_gmail, 1); assert.equal(after.represented_queue_entry, 1);
});

test("R11 Neuprüfung ohne belegten Befund / unvollständige Evidence: nie als Fehler behauptet, 14 Tage nicht erneut", async () => {
  const s = staleState(3), calls = [];
  const auditor = { audit: async (u) => { calls.push(u); if (u.includes("s0")) return { reachable: true, issues: [] }; if (u.includes("s1")) return { reachable: false, issues: [] };
    return { reachable: true, issues: [{ type: "broken_link", url: u }] }; } }; // s2: Befund ohne Beleg/Zeitpunkt
  const r = await recheck(s, { auditor });
  assert.equal(r.outcome.audited_no_issue, 1); assert.equal(r.outcome.unreachable, 1); assert.equal(r.outcome.audited, 1); assert.equal(r.evidence_complete, 0);
  assert.equal(r.eligibility_after_recheck.recoverable_requires_approval, 0); assert.equal(r.eligibility_after_recheck.excluded_no_visible_finding, 3);
  await recheck(s, { auditor, now: new Date(+NOW + 10 * DAY) });
  assert.equal(calls.length, 3, "innerhalb von 14 Tagen nicht erneut");
});

test("R12 Ausgabe: nur Zahlen/Kategorien – keine Domains, Adressen, Rohfehler", async () => {
  const s = staleState(2);
  const r = await recheck(s, { auditor: { audit: async () => { throw new Error("getaddrinfo ENOTFOUND s0.ch info@s0.ch"); } }, auditRetries: 0 });
  const out = JSON.stringify(r) + JSON.stringify(await recheckStale({ secretsDir: s.dir, base: ROOT, now: NOW, repairStateDir: null }));
  assert.ok(!/s0\.ch|s1\.ch|@|ENOTFOUND/.test(out));
  const src = fs.readFileSync(path.join(ROOT, "scripts", "tf015-reconcile-qualified.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/gmail\.js|createDraft\(|sendDraft|messages\.send|child_process|fetch\(/.test(src));
});

// ---------- Discovery-Quelle ----------
const resp = (status, body = { elements: [] }, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
const pair = { area: "Winterthur", category: { key: "craft" } };
const okBody = { elements: [{ type: "node", id: 1, tags: { name: "A AG", website: "https://a.ch" } }] };

test("D1 Ausweich-Instanz: Fehler auf Instanz 1 → sofort Instanz 2 (ohne Pause); bevorzugt danach die funktionierende", async () => {
  const hits = [], sleeps = [];
  const fetchFn = async (url) => { hits.push(url); return url.includes("one") ? resp(504) : resp(200, okBody); };
  const s = overpassSearch({ fetchFn, urls: ["https://one/api", "https://two/api"], sleep: async (ms) => sleeps.push(ms) });
  const out = await s(pair);
  assert.equal(out[0].website, "https://a.ch"); assert.deepEqual(hits, ["https://one/api", "https://two/api"]); assert.deepEqual(sleeps, []);
  await s(pair);
  assert.equal(hits.at(-1), "https://two/api", "funktionierende Instanz zuerst");
});

test("D2 «runtime error» mit HTTP 200 ist KEIN leeres Gebiet → wird wiederholt bzw. als Fehler gemeldet", async () => {
  assert.ok(overpassRuntimeError({ remark: "runtime error: Query timed out in \"query\" at line 1 after 91 seconds.", elements: [] }));
  assert.equal(overpassRuntimeError({ elements: [] }), null);
  const seq = [resp(200, { remark: "runtime error: Query run out of memory using about 2048 MB of RAM.", elements: [] }), resp(200, okBody)];
  const s = overpassSearch({ fetchFn: async () => seq.shift(), sleep: async () => {}, retryMs: 1 });
  assert.equal((await s(pair)).length, 1);
  const always = overpassSearch({ fetchFn: async () => resp(200, { remark: "runtime error: Query timed out", elements: [] }), sleep: async () => {}, retryMs: 1 });
  await assert.rejects(() => always(pair), /runtime error: timeout/);
});

test("D3 Provider-Timeout / Netzfehler werden wiederholt; dauerhafter Fehler (400) nie wiederholt; 403 = forbidden", async () => {
  let n = 0;
  const s = overpassSearch({ fetchFn: async () => { if (n++ === 0) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); return resp(200, okBody); }, sleep: async () => {}, retryMs: 1 });
  assert.equal((await s(pair)).length, 1); assert.equal(n, 2);
  let m = 0;
  const bad = overpassSearch({ fetchFn: async () => { m++; return resp(400); }, sleep: async () => {} });
  await assert.rejects(() => bad(pair), /HTTP 400/); assert.equal(m, 1);
  assert.equal(classifySourceError(new Error("Overpass HTTP 403")), "forbidden");
});

test("D4 Client-Timeout liegt über dem Server-Timeout [timeout:90]; Fehlerkategorien fest", async () => {
  assert.ok(DEFAULT_DISCOVERY.overpassClientTimeoutMs > 90_000);
  let signal = null;
  const s = overpassSearch({ fetchFn: async (u, o) => { signal = o.signal; return resp(200, okBody); } });
  await s(pair); assert.ok(signal, "AbortSignal gesetzt");
  assert.equal(classifySourceError(new Error("Overpass HTTP 429")), "rate_limited");
  assert.equal(classifySourceError(Object.assign(new Error("x"), { retryAfterMs: 5 })), "rate_limited");
  assert.equal(classifySourceError(new Error("Overpass HTTP 504")), "server_error");
  assert.equal(classifySourceError(new Error("The operation was aborted due to timeout")), "timeout");
  assert.equal(classifySourceError(new Error("fetch failed")), "network");
  assert.equal(classifySourceError(new Error("Overpass runtime error: memory")), "runtime_memory");
  assert.equal(classifySourceError(new Error("Overpass HTTP 400")), "client_error");
  assert.equal(classifySourceError(Object.assign(new Error("Overpass HTTP 503"), { budgetExhausted: true })), "retry_budget_exhausted");
  assert.equal(classifySourceError(Object.assign(new Error("x"), { circuitOpen: true })), "circuit_open");
});

test("D5 Retry-Budget: begrenzte Wiederholungs-Runden je Lauf → danach sofortiger Fehler (keine Fehlerverstärkung); Erschöpfung von maxRetries", async () => {
  let calls = 0;
  const s = overpassSearch({ fetchFn: async () => { calls++; return resp(503); }, retryMs: 1, maxRetries: 5, retryBudget: 2, sleep: async () => {} });
  await assert.rejects(() => s(pair), (e) => classifySourceError(e) === "retry_budget_exhausted");
  assert.equal(calls, 3, "1 Versuch + 2 Wiederholungen aus dem Budget");
  await assert.rejects(() => s(pair), (e) => classifySourceError(e) === "retry_budget_exhausted");
  assert.equal(calls, 4, "Budget aufgebraucht: nächste Abfrage ohne Wiederholung");
  let c2 = 0;
  const ex = overpassSearch({ fetchFn: async () => { c2++; return resp(503); }, retryMs: 1, maxRetries: 2, sleep: async () => {} });
  await assert.rejects(() => ex(pair), /HTTP 503/); assert.equal(c2, 3, "maxRetries erschöpft – keine Endlosschleife");
});

test("D6 Circuit-Breaker je Instanz + Jitter: offene Instanz übersprungen; alle offen → circuit_open ohne Abfrage; Zuschlag begrenzt", async () => {
  const hits = [];
  const s2 = overpassSearch({ fetchFn: async (u) => { hits.push(u); return resp(502); }, urls: ["https://one/api", "https://two/api"], breakerThreshold: 2, retryMs: 1, maxRetries: 5, sleep: async () => {} });
  await assert.rejects(() => s2(pair), (e) => classifySourceError(e) === "circuit_open");
  assert.equal(hits.length, 4, "je Instanz 2 Fehlversuche, dann offen");
  await assert.rejects(() => s2(pair), (e) => e.circuitOpen); assert.equal(hits.length, 4, "keine weitere Abfrage");
  const h2 = [];
  const half = overpassSearch({ fetchFn: async (u) => { h2.push(u); return u.includes("one") ? resp(502) : resp(200, okBody); }, urls: ["https://one/api", "https://two/api"], breakerThreshold: 1, sleep: async () => {} });
  await half(pair); await half({ area: "Thun", category: { key: "craft" } });
  assert.equal(h2.filter((u) => u.includes("one")).length, 1, "offene Instanz wird im Lauf nicht mehr abgefragt");
  const sleeps = [];
  const j = overpassSearch({ fetchFn: async () => resp(503), retryMs: 1000, maxRetries: 1, jitter: 0.2, random: () => 1, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(() => j(pair)); assert.deepEqual(sleeps, [1200], "höchstens +20 %");
  const ra = [];
  const r = overpassSearch({ fetchFn: async () => resp(429, okBody, { "retry-after": "7" }), maxRetries: 1, jitter: 0.2, random: () => 0, sleep: async (ms) => ra.push(ms) });
  await assert.rejects(() => r(pair)); assert.ok(ra[0] >= 7000, "Retry-After nie unterschritten");
});

// ---------- Discovery-Lauf (Backoff, Erholung, dauerhafte Fehler, Duplikate) ----------
const T0 = new Date("2026-10-10T07:00:00Z");
function discoveryDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-016-disc-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", sender: SENDER,
    discovery: { draftPaceMs: 0, intervalMinutes: 0, maxAuditsPerAreaPerRun: 100_000, areas: ["Winterthur", "Thun", "Aarau", "Chur"], maxSearchesPerRun: 4, ...extra } }));
  fs.writeFileSync(path.join(dir, "suppression.json"), "{}");
  return dir;
}
const gmail = { listOwned: () => ({ drafts: {}, sent: {} }), async createDraft() { throw new Error("kein Gmail im Test"); }, async sendDraft() { throw new Error("nie senden"); } };
const cand = (host) => ({ company: `${host.split(".")[0]} AG`, website: `https://${host}/`, email: "", chain: false, source: "OpenStreetMap node/1 (Winterthur, craft)" });
const disco = (dir, clock, o) => runDiscovery({ dir, gmail, auditor: { audit: async () => ({ reachable: true, issues: [] }) }, now: () => clock, log: () => {}, pid: process.pid, ...o });

test("L1 Rate-Limit / Ausfall → Lauf endet + Backoff; Erholung: erste erfolgreiche Suche setzt Backoff zurück", async () => {
  const dir = discoveryDir(); let clock = T0, calls = 0;
  const r = await disco(dir, clock, { search: async () => { calls++; throw Object.assign(new Error("Overpass HTTP 429"), { retryAfterMs: 120_000 }); } });
  assert.equal(calls, 1, "429 → sofort Abbruch"); assert.equal(discoveryStatus(dir, clock).status, "BACKOFF");
  assert.equal((await disco(dir, clock, { search: async () => assert.fail("im Backoff keine Abfrage") })).skipped, "backoff");
  clock = new Date(+T0 + 16 * MIN);
  await disco(dir, clock, { search: async () => [] });
  const st = discoveryStatus(dir, clock);
  assert.equal(st.status, "ACTIVE"); assert.equal(st.backoff_count, 0);
  const stats = JSON.parse(fs.readFileSync(path.join(dir, "discovered.json"), "utf8")).stats;
  assert.equal(Object.values(stats)[0].searchErrors.rate_limited, 1, "Fehlerkategorie aggregiert gezählt");
  assert.equal(r.errors[0].category, "rate_limited");
});

test("L2 dauerhafter Abfragefehler (400) ist keine Quellenstörung: Lauf geht weiter, kein Backoff, begrenzt; 403 → sofort Backoff", async () => {
  const dir = discoveryDir(); let calls = 0;
  const r = await disco(dir, T0, { search: async () => { calls++; throw new Error("Overpass HTTP 400"); } });
  assert.equal(calls, 4, "höchstens maxSearchesPerRun – keine Endlosschleife"); assert.equal(discoveryStatus(dir, T0).status, "ACTIVE");
  assert.ok(r.errors.every((e) => e.category === "client_error"));
  const d2 = discoveryDir(); let c2 = 0;
  await disco(d2, T0, { search: async () => { c2++; throw new Error("Overpass HTTP 403"); } });
  assert.equal(c2, 1); assert.equal(discoveryStatus(d2, T0).status, "BACKOFF", "Zugriff verweigert wird nie umgangen");
});

test("L3 Duplikate im Suchergebnis: dieselbe Domain aus mehreren Treffern/Abfragen wird genau einmal geprüft", async () => {
  const dir = discoveryDir({ sitesPerRun: 20 }), audited = [];
  await runDiscovery({ dir, gmail, now: () => T0, log: () => {}, pid: process.pid,
    search: async () => [cand("dup.ch"), cand("dup.ch"), { ...cand("dup.ch"), website: "https://www.dup.ch/" }, cand("andere.ch")],
    auditor: { audit: async (u) => { audited.push(new URL(u).hostname.replace(/^www\./, "")); return { reachable: true, issues: [] }; } } });
  assert.equal(audited.filter((h) => h === "dup.ch").length, 1); assert.equal(audited.filter((h) => h === "andere.ch").length, 1);
});
