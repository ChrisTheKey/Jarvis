// Cloud-First Phase A/B: Cloud Core (Schema/Migration, Core-Status im Heartbeat) und VPS als Inhaber des Operational State.
// Keine echten Mails, kein Netzwerk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateStateDir, schemaVersion, coreStatus, cleanCore, STATE_SCHEMA_VERSION, SCHEMA_FILE } from "../cloud-core.js";
import { createMailRequestHandler } from "../mail-requests.js";
import { createStateHandler, memoryStore } from "../shared-state.js";
import { SEND_WINDOWS, zurichDay } from "../mail-worker.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-test-token", JARVIS_MAIL_WORKER_TOKEN: "worker-test-token" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-core-"));
const mreq = (method, body, headers = {}) => new Request("https://jarvis.test/api/mail-requests", { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const sreq = (method, body, headers = {}) => new Request("https://jarvis.test/api/state", { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("Schema: frischer Stand → v1, zweiter Lauf ändert nichts, andere Dateien bleiben unberührt", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "suppression.json"), '{"a":1}');
  const r1 = migrateStateDir(dir);
  assert.deepEqual([r1.from, r1.to, r1.applied], [0, STATE_SCHEMA_VERSION, [1]]);
  assert.equal(schemaVersion(dir), 1);
  const r2 = migrateStateDir(dir);
  assert.deepEqual(r2.applied, [], "idempotent");
  assert.equal(fs.readFileSync(path.join(dir, "suppression.json"), "utf8"), '{"a":1}', "keine historischen Daten überschrieben");
});

test("Schema: neuerer Stand als der Code → fail closed (SCHEMA_TOO_NEW), nichts wird verändert", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, SCHEMA_FILE), JSON.stringify({ version: 99, history: [] }));
  assert.throws(() => migrateStateDir(dir), (e) => e.code === "SCHEMA_TOO_NEW");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, SCHEMA_FILE), "utf8")).version, 99);
});

test("Schema: Migrationen laufen der Reihe nach, Abbruch setzt beim letzten Schritt wieder an", () => {
  const dir = tmp(), ran = [];
  const migrations = [{ version: 1, name: "a", up: () => ran.push(1) }, { version: 2, name: "b", up: () => { ran.push(2); throw new Error("boom"); } }];
  assert.throws(() => migrateStateDir(dir, { migrations, target: 2 }));
  assert.equal(schemaVersion(dir), 1, "v1 festgehalten");
  migrations[1].up = () => ran.push("2b");
  assert.deepEqual(migrateStateDir(dir, { migrations, target: 2 }).applied, [2]);
  assert.deepEqual(ran, [1, 2, "2b"]);
});

test("Core-Status: Scheduler Europe/Zurich 09:30/14:30 je 50, Checkpoints, nur Whitelist-Felder", () => {
  const dir = tmp(), now = new Date("2026-10-07T13:00:00Z");
  migrateStateDir(dir);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ windows: { [zurichDay(now)]: { morning: { executedAt: now.toISOString() } } } }));
  fs.writeFileSync(path.join(dir, "discovered.json"), JSON.stringify({ lastRunAt: "2026-10-07T12:00:00.000Z", leads: { "x.ch": { email: "geheim@x.ch" } } }));
  const c = cleanCore(coreStatus({ dir, role: "vps", startedAt: "2026-10-07T10:00:00.000Z", now, windows: SEND_WINDOWS, zurichDay }));
  assert.deepEqual(c.scheduler, { tz: "Europe/Zurich", morning: { start: "09:30", limit: 50, executed: true }, afternoon: { start: "14:30", limit: 50, executed: false } });
  assert.equal(c.schema_version, 1);
  assert.equal(c.discovery_last_run, "2026-10-07T12:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(c), /geheim|x\.ch/);
  const dirty = cleanCore({ ...c, token: "t", email: "a@b.ch", scheduler: { morning: { start: "evil", limit: 1e9, executed: "yes", leak: 1 } } });
  assert.deepEqual(Object.keys(dirty).sort(), ["backup", "discovery_last_run", "role", "scheduler", "schema_version", "started_at"]);
  assert.deepEqual(dirty.scheduler.morning, { start: null, limit: 1000, executed: false });
});

test("Cloud Core im Heartbeat: VPS meldet Core-Status, Cloud zeigt ihn; Windows ohne Authority kann keinen Heartbeat setzen", async () => {
  const blob = memoryStore(), now = new Date("2026-10-07T13:00:00Z");
  const handler = createMailRequestHandler({ getStore: async () => blob, env: (k) => ENV[k], now: () => now });
  const core = { role: "vps", started_at: "2026-10-07T10:00:00.000Z", schema_version: 1, scheduler: { morning: { start: "09:30", limit: 50, executed: true } }, secret: "x" };
  assert.equal((await handler(mreq("POST", { op: "heartbeat", stats: {}, core }, { "x-jarvis-worker": ENV.JARVIS_MAIL_WORKER_TOKEN }))).status, 200);
  const win = await handler(mreq("POST", { op: "heartbeat", stats: {}, core: { role: "local" } }, { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }));
  assert.notEqual(win.status, 200, "Windows im Standby ist kein Sender");
  const svc = (await (await handler(mreq("GET", null, { "x-jarvis-key": ENV.JARVIS_PASSWORD }))).json()).service;
  assert.deepEqual([svc.online, svc.authority, svc.core.role, svc.core.schema_version, svc.core.scheduler.morning.executed], [true, "vps", "vps", 1, true]);
  assert.doesNotMatch(JSON.stringify(svc), /secret|worker-test-token/);
});

test("Operational State: mit VPS-Authority übernimmt die Cloud Business/Sales nur vom Cloud Core, nie vom Windows-Client", async () => {
  const blob = memoryStore(), t = (m) => new Date(`2026-10-07T13:${m}:00Z`);
  let now = t("00");
  const handler = createStateHandler({ getStore: async () => blob, env: (k) => ENV[k], now: () => now });
  const sync = (token, sales) => handler(sreq("POST", { op: "sync", state: { sales, business: { updatedAt: sales.updatedAt, worker: { todaySent: sales.contacted } } } }, { "x-jarvis-sync": token }));
  assert.equal((await sync(ENV.JARVIS_MAIL_WORKER_TOKEN, { updatedAt: t("00").toISOString(), contacted: 7 })).status, 200);
  now = t("05");
  assert.equal((await sync(ENV.JARVIS_SYNC_TOKEN, { updatedAt: t("05").toISOString(), contacted: 1 })).status, 200);
  const s = blob.peek();
  assert.equal(s.sales.contacted, 7, "veralteter Windows-Stand überschreibt den VPS nicht");
  assert.equal(s.business.worker.todaySent, 7);
  assert.equal(s.sync.lastCorePushAt, t("00").toISOString());
  assert.equal(s.sync.lastClientPushAt, t("05").toISOString(), "Windows-Client sichtbar, aber nicht Inhaber");
  // Ohne VPS (kein Worker-Token) bleibt Windows wie bisher Inhaber – keine Regression.
  const blob2 = memoryStore();
  const h2 = createStateHandler({ getStore: async () => blob2, env: (k) => ({ ...ENV, JARVIS_MAIL_WORKER_TOKEN: undefined })[k], now: () => now });
  await h2(sreq("POST", { op: "sync", state: { sales: { updatedAt: t("05").toISOString(), contacted: 1 } } }, { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }));
  assert.equal(blob2.peek().sales.contacted, 1);
});

test("Windows-Client im Standby rechnet keine eigenen Sales-Zahlen mehr (übernimmt die des Cloud Core)", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /const refreshSales = async \(\) => \{ if \(windowsIsStandby\(\)\) return;/);
  assert.match(server, /read\(AUTHORITY_FILE, null\)\?\.self === false/);
});

// ---------- Phase B: Migration Windows → VPS (scripts/merge-state.mjs) ----------
import { planMerge, additiveMerge, offerDecision } from "../scripts/merge-state.mjs";

test("Migration: additiv, VPS gewinnt Konflikte, Suppression wird vereinigt, nichts geht verloren", () => {
  const vps = {
    "mail_worker/discovered.json": { data: { leads: { "a.ch": { status: "audited" }, "b.ch": { status: "contacted" } }, lastRunAt: "2026-10-07T18:00:00Z" }, mtime: "2026-10-07T18:00:00Z" },
    "mail_worker/suppression.json": { data: { "x@a.ch": { reason: "opt_out" } }, mtime: "2026-10-07T18:00:00Z" },
    "gmail_jarvis.json": { data: { drafts: { d1: { t: 1 } }, sent: {} }, mtime: "2026-10-05T00:00:00Z" },
  };
  const win = {
    "mail_worker/discovered.json": { data: { leads: { "b.ch": { status: "audited" }, "c.ch": { status: "audited" } }, lastRunAt: "2026-10-07T14:00:00Z" }, mtime: "2026-10-07T14:00:00Z" },
    "mail_worker/suppression.json": { data: { "y@b.ch": { reason: "opt_out" } }, mtime: "2026-10-07T15:00:00Z" },
    "gmail_jarvis.json": { data: { drafts: { d1: { t: 1 } }, sent: { s1: { t: 2 } } }, mtime: "2026-10-05T00:00:00Z" },
    "mail_worker/leads.json": { data: [{ email: "n@c.ch" }], mtime: "2026-10-05T00:00:00Z" },
  };
  const { changes, report } = planMerge({ vps, win });
  const d = changes["mail_worker/discovered.json"];
  assert.deepEqual(Object.keys(d.leads).sort(), ["a.ch", "b.ch", "c.ch"]);
  assert.equal(d.leads["b.ch"].status, "contacted", "VPS gewinnt den Konflikt");
  // Eintrag atomar: kein Feld aus der Windows-Version wird in den VPS-Eintrag gemischt.
  const { changes: c2 } = planMerge({ vps: { "mail_worker/discovered.json": { data: { leads: { "b.ch": { status: "contacted" } } } } },
    win: { "mail_worker/discovered.json": { data: { leads: { "b.ch": { status: "audited", email: "info@b.ch" } } } } } });
  assert.equal(c2["mail_worker/discovered.json"], undefined, "keine Mischversion");
  assert.equal(d.lastRunAt, "2026-10-07T18:00:00Z");
  assert.ok(report["mail_worker/discovered.json"].conflicts >= 1);
  assert.deepEqual(Object.keys(changes["mail_worker/suppression.json"]).sort(), ["x@a.ch", "y@b.ch"], "Opt-outs beider Seiten bleiben");
  assert.deepEqual(Object.keys(changes["gmail_jarvis.json"].sent), ["s1"]);
  assert.deepEqual(changes["mail_worker/leads.json"], [{ email: "n@c.ch" }], "auf dem VPS fehlende Datei wird übernommen");
  assert.ok(!("mail_worker/individual_reviews.json" in changes));
});

test("Migration: offer nur, wenn Windows neuer ist und genau CHF 150 / CHF 480 nennt", () => {
  const old = { data: { offer: "alt", dryRun: false }, mtime: "2026-10-06T21:42:00Z" };
  const neu = (offer, mtime = "2026-10-07T14:32:00Z") => ({ data: { offer, dryRun: true }, mtime });
  assert.equal(offerDecision({ vps: old, win: neu("Check CHF 150 einmalig, Reparatur CHF 480 einmalig") }).take, true);
  assert.equal(offerDecision({ vps: old, win: neu("Check CHF 150, Reparatur CHF 500") }).take, false, "kein CHF 480");
  assert.equal(offerDecision({ vps: old, win: neu("CHF 150 / CHF 480 / Redesign CHF 2490") }).take, false, "drittes Angebot");
  assert.equal(offerDecision({ vps: old, win: neu("CHF 150 und CHF 480", "2026-10-01T00:00:00Z") }).take, false, "Windows älter");
  const { changes } = planMerge({ vps: { "mail_worker/config.json": old }, win: { "mail_worker/config.json": neu("CHF 150 und CHF 480") } });
  assert.deepEqual(changes["mail_worker/config.json"], { offer: "CHF 150 und CHF 480", dryRun: false }, "nur offer, alle anderen VPS-Werte bleiben");
});

test("Migration: Secrets werden nie übertragen", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "merge-state.mjs"), "utf8");
  const files = src.match(/export const STATE_FILES = \[([^\]]+)\]/)[1];
  assert.doesNotMatch(files, /gmail_token|gmail_credentials|\.env|vps_worker/);
  assert.equal(additiveMerge(undefined, { a: 1 }, { added: 0, conflicts: 0 }).a, 1);
});
