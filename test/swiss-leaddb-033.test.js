// FULL SWITZERLAND DISCOVERY + PERSISTENT LEAD DATABASE (033)
// Ganze Schweiz (26 Kantone, alle Gemeinden, geografische Rotation, persistenter Cursor) und die dauerhafte Lead-Datenbank
// (Status, Dedupe, manueller Versand, Antwort, Kunde, Suppression/Opt-out/Do-not-contact, Migration, Backup/Restore, CSV, Cloud).
// Alles mit Attrappen – kein Netzwerk, kein Gmail, keine Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDiscovery, discoveryStatus, DEFAULT_DISCOVERY, overpassSearch } from "../lead-finder.js";
import { swissIndex, loadGeo, saveGeo, nextJob, advance, findMunicipality, GEO_FILE } from "../swiss-areas.js";
import { createWorker, createStore } from "../mail-worker.js";
import { REVIEWS_FILE, COLD_MODE } from "../swiss-repair.js";
import { reconcileRegistry, recordLead, loadRegistry, registryBlock, markDoNotContact, publicRegistry, REGISTRY_FILE, knownKeys } from "../lead-registry.js";
import { deriveStatus, mergeLead, leadsToCsv, CSV_COLUMNS, filterLeads, leadStats, publicLead, PUBLIC_FIELDS, LEAD_STATUSES } from "../lead-db.js";
import { createBackup, decryptBackup, restoreTo } from "../backup.js";
import { createServerControlHandler, cleanDiscovery } from "../server-control.js";
import { memoryStore } from "../shared-state.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const T0 = new Date("2026-10-11T07:00:00Z");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
let dir, g, clock, store;
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const readJ = (name, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fb; } };
const reviews = () => readJ(REVIEWS_FILE, { reviews: {} }).reviews;
const cfg = (discovery = {}) => write("config.json", { dryRun: false, sendMode: "compliant_auto", sender: SENDER, excludeAddresses: ["chris@helvetic-webdesign.ch"], discovery: { draftPaceMs: 0, intervalMinutes: 0, ...discovery } });
function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, calls: [], n: 0, manual: [] };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async createDraft({ to, subject, body, mode, leadId }) { f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "t" + id, to, subject, body, mode, leadId, createdAt: clock.toISOString() }; return { draftId: id, threadId: "t" + id, messageId: "m" + id }; },
    async sendDraft(id) { f.calls.push("SEND " + id); throw new Error("COLD_LEAD_DRAFT_ONLY – nicht sendbar"); },
    // Chris hat einen Cold-Entwurf in Gmail selbst gesendet: wie gmail.syncColdDrafts (Register: drafts → sent, manual: true)
    async syncColdDrafts() {
      const out = [];
      for (const id of f.manual.splice(0)) {
        const e = f.reg.drafts[id]; if (!e) continue;
        delete f.reg.drafts[id];
        const sentAt = clock.toISOString();
        f.reg.sent["msg-" + id] = { messageId: "msg-" + id, threadId: e.threadId, to: e.to, subject: e.subject, fromDraft: id, sentAt, manual: true, mode: COLD_MODE, leadId: e.leadId, legalBasis: "NONE" };
        out.push({ draftId: id, leadId: e.leadId, status: "manually_sent", messageId: "msg-" + id, threadId: e.threadId, sentAt });
      }
      return out;
    },
    async readThread() { return { messages: [] }; }, async updateDraft() {}, async deleteDraft() {}, async markDraftForReview() {},
  });
  return f;
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-033-")); store = createStore(dir); g = fakeGmail(); clock = T0; cfg(); write("suppression.json", {}); });

const impressum = (host) => `<html><body><h1>Impressum</h1><p>${host.split(".")[0]} AG<br>Hauptstrasse 1, 3098 Köniz<br>E-Mail: <a href="mailto:info@${host}">info@${host}</a><br>UID: CHE-123.456.789</p></body></html>`;
const broken = (host) => ({ type: "broken_link", url: `https://${host}/team-alt`, page: `https://${host}/`, label: "Unser Team", evidence: `HTTP 404 (verlinkt auf https://${host}/)`, severity: "medium", detectedAt: T0.toISOString() });
const audit = (host, issues = [broken(host)]) => ({ reachable: true, title: `${host} – Treuhand`, finalUrl: `https://${host}/`, issues, impressumUrl: `https://${host}/impressum`, contactUrl: `https://${host}/kontakt`, teamUrl: null,
  pages: { home: `<html lang="de"><head><title>${host}</title></head><body>Treuhand in Köniz, Schweiz. Telefon +41 31 123 45 67</body></html>`, impressum: impressum(host), contact: "<html><body>Kontakt</body></html>" } });
const hostOf = (url) => new URL(url).hostname.replace(/^www\./, "");
const auditor = (withIssue = () => true) => { const a = { calls: [] }; a.audit = async (url) => { const h = hostOf(url); a.calls.push(h); return audit(h, withIssue(h) ? [broken(h)] : []); }; return a; };
const cand = (host, extra = {}) => ({ company: `${host.split(".")[0]} AG`, website: `https://${host}/`, email: "", chain: false, category: "office=accountant", source: "OpenStreetMap node/1 (Köniz, office=accountant)", ...extra });
const hosts = (n, p = "firma") => Array.from({ length: n }, (_, i) => `${p}${i + 1}.ch`);
const run = (opts = {}) => runDiscovery({ dir, gmail: g, auditor: opts.auditor || auditor(), now: () => clock, log: () => {}, pid: process.pid, ...opts });
const worker = () => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", subject: "Re", body: "Guten Tag." }) });
const review = (h, extra = {}) => ({ lead_id: h, domain: h, company: `${h.split(".")[0]} AG`, recipient: `info@${h}`, subject: "Hinweis zu Ihrer Website", body: "Guten Tag", draft_hash: "h", status: "queued",
  draft_mode: COLD_MODE, legal_basis: "NONE", message_class: "DRAFT_ONLY", automatic_send_allowed: false, manual_send_decision_required: true, offer_class: "REPAIR_FIX_500", repair_fit_score: 72,
  customer_findings: [{ key: "broken_link", text: "Der Link «Unser Team» führt auf eine Seite, die nicht mehr existiert." }], created_at: T0.toISOString(), updated_at: T0.toISOString(), ...extra });
const reg = () => loadRegistry(store).leads;

// ==================== 18) GANZE SCHWEIZ ====================

test("Gebietsindex: 26 Kantone, über 2000 Gemeinden, Bern/Köniz/Zürich/Lausanne/Genève/Lugano/Chur mit korrektem Kanton; alle vier Sprachregionen", () => {
  const idx = swissIndex();
  assert.equal(idx.cantons.length, 26);
  assert.deepEqual(idx.cantons.map((c) => c.code).sort(), ["AG", "AI", "AR", "BE", "BL", "BS", "FR", "GE", "GL", "GR", "JU", "LU", "NE", "NW", "OW", "SG", "SH", "SO", "SZ", "TG", "TI", "UR", "VD", "VS", "ZG", "ZH"]);
  assert.ok(idx.municipalities.length > 2000, "Gemeindeliste nicht leer, flächendeckend");
  assert.ok(idx.cantons.every((c) => c.municipalities > 0), "jeder Kanton hat Gemeinden");
  for (const [name, canton, lang] of [["Bern", "BE", "de"], ["Köniz", "BE", "de"], ["Zürich", "ZH", "de"], ["Lausanne", "VD", "fr"], ["Genève", "GE", "fr"], ["Lugano", "TI", "it"], ["Chur", "GR", "de"]]) {
    const m = findMunicipality(name);
    assert.ok(m, `${name} vorhanden`); assert.equal(m.canton, canton, `${name} liegt in ${canton}`); assert.equal(m.language, lang, `${name}: ${lang}`);
    assert.ok(Number.isInteger(m.bfs) && m.bfs > 0, "BFS-Gemeindenummer");
  }
  assert.deepEqual([...new Set(idx.municipalities.map((m) => m.language))].sort(), ["de", "fr", "it", "rm"], "deutsch, französisch, italienisch, rätoromanisch");
  assert.equal(new Set(idx.municipalities.map((m) => m.bfs)).size, idx.municipalities.length, "keine doppelten Gemeinden");
  assert.equal(idx.order.length, idx.municipalities.length, "Rotation enthält jede Gemeinde genau einmal");
  // Gleichnamige Gemeinden werden nicht verwechselt: Reinach (AG) ≠ Reinach (BL)
  assert.equal(findMunicipality("Reinach (AG)").canton, "AG"); assert.equal(findMunicipality("Reinach (BL)").canton, "BL"); assert.equal(findMunicipality("Reinach"), null, "mehrdeutig → nie geraten");
});

test("Keine riesige hardcoded Städteliste: Standard = ganze Schweiz aus versionierter Datei, nichts wird im Lauf heruntergeladen; 7500/Tag-Ziel unverändert", () => {
  assert.equal(DEFAULT_DISCOVERY.areas, undefined);
  assert.equal(DEFAULT_DISCOVERY.maxSitesPerDay, 7500); assert.equal(DEFAULT_DISCOVERY.maxSitesPerHour, 315); assert.equal(DEFAULT_DISCOVERY.sitesPerRun, 105); assert.equal(DEFAULT_DISCOVERY.intervalMinutes, 20);
  assert.equal(DEFAULT_DISCOVERY.maxConcurrency, 6); assert.equal(DEFAULT_DISCOVERY.maxSearchesPerRun, 6); assert.equal(DEFAULT_DISCOVERY.searchMinGapMs, 6000);
  const data = JSON.parse(read("data/swiss-municipalities.json"));
  assert.match(data.version, /^bfs-\d{4}-\d{2}-\d{2}$/); assert.match(data.source, /BFS/);
  const src = read("swiss-areas.js");
  assert.doesNotMatch(src, /fetch\(|https?:\/\/(?!www\.)/, "Gebietsindex lädt nichts herunter");
  assert.match(read("deploy/vps/Dockerfile"), /COPY data\/swiss-municipalities\.json/);
});

test("Geografische Rotation: reihum alle 26 Kantone, Grossstädte dominieren nicht, jede Gemeinde genau einmal je Zyklus, danach neuer Zyklus", () => {
  const idx = swissIndex();
  const first26 = idx.order.slice(0, 26).map((b) => idx.byBfs.get(b).canton);
  assert.equal(new Set(first26).size, 26, "die ersten 26 Abfragen decken alle 26 Kantone ab");
  const first260 = idx.order.slice(0, 260).map((b) => idx.byBfs.get(b).canton);
  const big = first260.filter((c) => ["ZH", "BE", "BS"].includes(c)).length;
  assert.ok(big / 260 <= 0.15, `Zürich/Bern/Basel nur ${big}/260 der Abfragen`);
  // Einen ganzen Zyklus simulieren: keine Gemeinde doppelt, danach Zyklus 2 ab vorne
  const gs = loadGeo(store, T0), seen = new Set();
  for (let i = 0; i < idx.order.length; i++) { const j = nextJob(gs, { slot: 0, splitUsed: 0, maxSplit: 2 }); assert.ok(!seen.has(j.bfs), "Gemeinde nicht wiederholt"); seen.add(j.bfs); advance(gs, j.m, T0); }
  assert.equal(seen.size, idx.municipalities.length, "alle Gemeinden besucht");
  assert.equal(gs.cycle, 2); assert.equal(gs.cursor, 0); assert.equal(gs.cycles_completed, 1); assert.ok(gs.last_cycle_completed_at);
});

test("Discovery-Lauf: Overpass je Gemeinde über BFS-Nummer + Kanton, Cursor wird nach jeder Abfrage gespeichert und überlebt einen Neustart", async () => {
  cfg({ sitesPerRun: 105, maxSearchesPerRun: 6 });
  const asked = [];
  const search = async (p) => { asked.push(p); return []; };
  await run({ search });
  assert.equal(asked.length, 6, "6 gedrosselte Abfragen");
  assert.ok(asked.every((p) => Number.isInteger(p.bfs) && /^[A-Z]{2}$/.test(p.canton) && Array.isArray(p.categories) && p.categories.length >= 20), "Gemeinde eindeutig + alle Branchen");
  assert.equal(new Set(asked.map((p) => p.canton)).size, 6, "6 verschiedene Kantone");
  const geo1 = readJ(GEO_FILE);
  assert.equal(geo1.cursor, 6); assert.equal(geo1.visited, 6);
  // „Neustart“: neuer Prozess liest nur die Dateien – macht beim nächsten Gebiet weiter, keine Gemeinde doppelt
  clock = new Date(+clock + 21 * 60_000);
  const before = asked.map((p) => p.bfs); asked.length = 0;
  await run({ search });
  assert.equal(asked[0].bfs, swissIndex().order[6], "weiter beim 7. Gebiet");
  assert.ok(asked.every((p) => !before.includes(p.bfs)), "Gemeinden nicht ständig wiederholt");
  const st = discoveryStatus(dir, clock);
  assert.equal(st.coverage.mode, "FULL"); assert.equal(st.coverage.cantons_total, 26); assert.ok(st.coverage.municipalities_total > 2000); assert.equal(st.coverage.cycle_visited, 12);
  const clean = cleanDiscovery(st);
  assert.equal(clean.coverage.mode, "FULL"); assert.equal(clean.coverage.cantons_total, 26); assert.equal(typeof clean.coverage.current_municipality, "string");
});

test("Fairness: Grossstadt (gesättigt) → Folgeabfragen je Branche, höchstens 2 je Lauf und höchstens 35 neue Firmen je Abfrage", async () => {
  cfg({ sitesPerRun: 105, maxSearchesPerRun: 6, maxSitesPerHour: 100_000, searchLimit: 250 });
  let n = 0; const asked = [];
  const search = async (p) => {
    asked.push(p);
    const list = hosts(p.bfs === swissIndex().order[0] ? 250 : 3, `g${n++}-`).map((h) => cand(h));
    Object.defineProperty(list, "meta", { value: { areaFound: true, saturated: list.length >= p.limit } });
    return list;
  };
  const a = auditor(() => false);
  const r = await run({ search, auditor: a });
  const geo = readJ(GEO_FILE);
  assert.equal(geo.queue.length, DEFAULT_DISCOVERY.categories.length, "gesättigte Gemeinde → je Branche eine Folgeabfrage (Gemeinde → Branche)");
  assert.ok(r.audited <= 35 + 5 * 3, `höchstens 35 aus der Grossstadt (${r.audited})`);
  clock = new Date(+clock + 21 * 60_000); asked.length = 0;
  await run({ search, auditor: a });
  const split = asked.filter((p) => p.categories.length === 1);
  assert.ok(split.length <= 2, "höchstens 2 Folgeabfragen je Lauf"); assert.ok(split.length >= 1, "Folgeabfragen laufen");
  assert.ok(asked.length - split.length >= 4, "der Rest kommt reihum aus den Kantonen");
});

test("Overpass-Abfrage: Gemeindefläche über ref:bfs_Gemeindenummer (keine Namensverwechslung), alle Branchen in einer Abfrage, Fallback über Name im Kanton", async () => {
  const bodies = []; let call = 0;
  const fetchFn = async (url, init) => {
    bodies.push(decodeURIComponent(String(init.body)).replace(/\+/g, " "));
    const elements = call++ === 0 ? [{ type: "node", id: 1, tags: { name: "Muster Treuhand AG", website: "https://muster.ch", office: "accountant" } }] : [];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ elements }) };
  };
  const s = overpassSearch({ fetchFn });
  const list = await s({ area: "Köniz", osmName: "Köniz", bfs: 355, canton: "BE", categories: [{ key: "office", value: "accountant" }, { key: "craft" }], limit: 50 });
  assert.match(bodies[0], /ref:bfs_Gemeindenummer"="355"/); assert.match(bodies[0], /\.a out ids;/); assert.match(bodies[0], /"office"="accountant"/); assert.match(bodies[0], /\["craft"\]/);
  assert.match(bodies[1], /ISO3166-2"="CH-BE"/, "Fläche nicht gefunden → einmal über den Namen im Kanton"); assert.match(bodies[1], /"name"="Köniz"/);
  assert.equal(list.meta.areaFound, false);
  assert.equal(bodies.length, 2);
  // Treffer tragen die Branche
  const ok = overpassSearch({ fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ elements: [{ type: "area", id: 3600000001 }, { type: "node", id: 9, tags: { name: "Coiffeur X", website: "x.ch", shop: "hairdresser" } }] }) }) });
  const hits = await ok({ area: "Bern", bfs: 351, canton: "BE", categories: [{ key: "shop" }, { key: "shop", value: "hairdresser" }], limit: 50 });
  assert.equal(hits.length, 1); assert.equal(hits[0].category, "shop=hairdresser", "spezifischste Branche"); assert.equal(hits.meta.areaFound, true);
});

test("Kanton, Gemeinde, Sprache und Branche werden am Lead und in der Lead-Datenbank gespeichert", async () => {
  cfg({ sitesPerRun: 5, maxSearchesPerRun: 1 });
  let asked = null;
  const search = async (p) => { asked = p; return [cand("treuhand-muster.ch")]; };
  await run({ search });
  const lead = readJ("discovered.json").leads["treuhand-muster.ch"];
  assert.equal(lead.status, "blocked_no_legal_basis", "qualifiziert (Cold Lead, keine Versandgrundlage)");
  assert.equal(lead.canton, asked.canton); assert.equal(lead.municipality, asked.area); assert.equal(lead.municipality_bfs, asked.bfs); assert.ok(["de", "fr", "it", "rm"].includes(lead.language));
  assert.equal(lead.category, "office=accountant");
  const r = reg()["treuhand-muster.ch"];
  assert.ok(r, "in der Lead-Datenbank");
  assert.equal(r.canton, asked.canton); assert.equal(r.municipality, asked.area); assert.equal(r.category_label, "Treuhand");
  assert.equal(r.status, "WAITING_FOR_DRAFT"); assert.equal(r.business_email, "info@treuhand-muster.ch"); assert.equal(r.offer_class, "REPAIR_FIX_500");
  assert.ok(r.customer_visible_findings.length >= 1, "Problem in Kundensprache"); assert.ok(r.repair_fit_score > 0);
  // Treuhänder aus diesem Kanton finden
  const list = filterLeads(publicRegistry(store), { canton: asked.canton, category: "Treuhand" });
  assert.deepEqual(list.map((l) => l.lead_id), ["treuhand-muster.ch"]);
});

// ==================== 19) LEAD-DATENBANK ====================

test("Lebenszyklus: neu → qualifiziert → Draft → manuell versendet → Antwort → Kunde; Lead wird nie gelöscht", async () => {
  recordLead(store, { lead_id: "muster.ch", domain: "muster.ch", company: "Muster AG", business_email: "info@muster.ch", first_discovered_at: T0.toISOString() }, { now: T0 });
  assert.equal(reg()["muster.ch"].status, "DISCOVERED");
  recordLead(store, { lead_id: "muster.ch", qualified: true, audited: true, last_audited_at: T0.toISOString(), offer_class: "REPAIR_CHECK_150" }, { now: T0 });
  assert.equal(reg()["muster.ch"].status, "QUALIFIED");
  write(REVIEWS_FILE, { reviews: { "muster.ch": review("muster.ch") } });
  reconcileRegistry(store, { gmailRegistry: g.listOwned(), now: T0 });
  assert.equal(reg()["muster.ch"].status, "WAITING_FOR_DRAFT");
  await worker().tick(); // Draft-Worker legt den Gmail-ENTWURF an (nie senden)
  assert.equal(reviews()["muster.ch"].status, "draft_created");
  reconcileRegistry(store, { gmailRegistry: g.listOwned(), now: T0 });
  assert.equal(reg()["muster.ch"].status, "DRAFT_CREATED"); assert.ok(reg()["muster.ch"].draft_created_at);
  // Chris sendet den Entwurf selbst in Gmail → Jarvis erkennt es → MANUALLY_SENT, first/last_contacted_at
  clock = new Date(+T0 + 3_600_000);
  g.manual.push(Object.keys(g.reg.drafts)[0]);
  await worker().tick();
  reconcileRegistry(store, { gmailRegistry: g.listOwned(), now: clock });
  let l = reg()["muster.ch"];
  assert.equal(l.status, "MANUALLY_SENT"); assert.equal(l.manual_send_detected, true); assert.equal(l.first_contacted_at, clock.toISOString()); assert.equal(l.last_contacted_at, clock.toISOString());
  assert.ok(l.refs?.gmail_thread_id, "Thread-Referenz intern gespeichert");
  assert.ok(!g.calls.some((c) => c.startsWith("SEND")), "Jarvis hat nie gesendet");
  // Antwort im Jarvis-Thread
  const st = readJ("state.json", { actions: {} }); st.actions["reply:abc"] = { status: "prepared", at: new Date(+clock + 3_600_000).toISOString(), kind: "antwort", to: "info@muster.ch" }; write("state.json", st);
  reconcileRegistry(store, { gmailRegistry: g.listOwned(), now: clock });
  assert.equal(reg()["muster.ch"].status, "REPLIED"); assert.equal(reg()["muster.ch"].reply_status, "replied");
  // Kunde (Verkauf erfasst)
  write("sales.json", { records: { "muster.ch": { status: "customer", sale: { selected_offer: "REPAIR_CHECK_150", sale_value: 150 } } } });
  reconcileRegistry(store, { gmailRegistry: g.listOwned(), now: clock });
  l = reg()["muster.ch"];
  assert.equal(l.status, "CUSTOMER"); assert.equal(l.customer_status, "customer"); assert.equal(l.first_contacted_at, new Date(+T0 + 3_600_000).toISOString(), "Kontakt-Historie bleibt");
  assert.deepEqual(l.history.map((h) => h.status), ["DISCOVERED", "QUALIFIED", "WAITING_FOR_DRAFT", "DRAFT_CREATED", "MANUALLY_SENT", "REPLIED", "CUSTOMER"]);
  // Quellen verschwinden (z. B. Review-Datei geleert) → Lead bleibt vollständig erhalten
  write(REVIEWS_FILE, { reviews: {} }); write("sales.json", { records: {} });
  reconcileRegistry(store, { gmailRegistry: { sent: {}, drafts: {} }, now: clock, force: true });
  assert.equal(reg()["muster.ch"].status, "CUSTOMER", "nie gelöscht, nie zurückgestuft");
});

test("Dedupe: gleiche Domain / gleiche E-Mail / gleiche Firma = kein neuer Lead (Information bleibt als alt_* erhalten)", () => {
  recordLead(store, { lead_id: "alpha.ch", domain: "alpha.ch", company: "Alpha Treuhand AG", business_email: "info@alpha.ch" }, { now: T0 });
  recordLead(store, { lead_id: "www.alpha.ch", domain: "https://www.alpha.ch/kontakt", company: "Alpha", business_email: "info@alpha.ch" }, { now: T0 });
  recordLead(store, { lead_id: "alpha-treuhand.ch", domain: "alpha-treuhand.ch", business_email: "INFO@alpha.ch" }, { now: T0 });
  recordLead(store, { lead_id: "alpha-bern.ch", domain: "alpha-bern.ch", company: "Alpha Treuhand GmbH", business_email: "kontakt@alpha-bern.ch" }, { now: T0 });
  const all = reg();
  assert.equal(Object.keys(all).length, 1, "ein Lead");
  assert.deepEqual(all["alpha.ch"].alt_domains.sort(), ["alpha-bern.ch", "alpha-treuhand.ch"]);
  assert.deepEqual(all["alpha.ch"].alt_emails, ["kontakt@alpha-bern.ch"]);
});

test("Dedupe in der Discovery: bekannte Domain/Firma aus der Lead-Datenbank wird nie neu geprüft; angeschriebene Firma bekommt nie einen neuen Cold-Entwurf", async () => {
  recordLead(store, { lead_id: "bekannt.ch", domain: "bekannt.ch", company: "Bekannt AG", business_email: "info@bekannt.ch", first_contacted_at: T0.toISOString(), manual_send_detected: true }, { now: T0 });
  cfg({ sitesPerRun: 10, maxSearchesPerRun: 1 });
  const a = auditor();
  await run({ auditor: a, search: async () => [cand("bekannt.ch"), cand("bekannt-zwei.ch", { company: "Bekannt AG" }), cand("neu.ch")] });
  assert.deepEqual(a.calls, ["neu.ch"], "Domain und Firma aus der Datenbank übersprungen");
  assert.ok(knownKeys(store).domains.includes("bekannt.ch"));
  // Draft-Worker direkt vor Gmail: queued Eintrag zu einer bereits angeschriebenen Firma (gleiche Adresse) → blockiert
  write(REVIEWS_FILE, { reviews: { ...reviews(), "bekannt-neu.ch": review("bekannt-neu.ch", { recipient: "info@bekannt.ch", company: "Andere AG" }) } });
  await worker().tick();
  assert.equal(reviews()["bekannt-neu.ch"].status, "blocked"); assert.match(reviews()["bekannt-neu.ch"].blocked_reason, /Lead-Datenbank: bereits angeschrieben/);
  assert.ok(!g.calls.includes("create info@bekannt.ch"), "kein Gmail-Entwurf");
  assert.equal(registryBlock(store, { email: "info@bekannt.ch" }), "bereits angeschrieben");
  assert.equal(registryBlock(store, { domain: "frisch.ch", email: "info@frisch.ch", company: "Frisch AG" }), null);
});

test("Suppression, Opt-out und Do-not-contact bleiben erhalten (auch wenn die Quelle später fehlt) und haben immer Vorrang", () => {
  for (const d of ["s.ch", "o.ch", "d.ch"]) recordLead(store, { lead_id: d, domain: d, company: d + " AG", business_email: "info@" + d, qualified: true }, { now: T0 });
  write("suppression.json", { "info@s.ch": { reason: "unzustellbar", at: T0.toISOString() }, "info@o.ch": { reason: "opt-out", at: T0.toISOString() } });
  reconcileRegistry(store, { now: T0 });
  markDoNotContact(store, "d.ch", { now: T0 });
  assert.equal(reg()["s.ch"].status, "SUPPRESSED"); assert.equal(reg()["o.ch"].status, "OPT_OUT"); assert.equal(reg()["d.ch"].status, "DO_NOT_CONTACT");
  // Später: Suppression-Datei leer, Antwort und Verkauf erfasst – Sperren bleiben trotzdem
  write("suppression.json", {});
  write("sales.json", { records: { "s.ch": { sale: { selected_offer: "REPAIR_FIX_500", sale_value: 480 } }, "d.ch": { status: "replied" } } });
  reconcileRegistry(store, { now: T0, force: true });
  assert.equal(reg()["s.ch"].suppressed, true); assert.equal(reg()["s.ch"].status, "SUPPRESSED", "Sperre vor Kunde");
  assert.equal(reg()["o.ch"].opt_out, true); assert.equal(reg()["d.ch"].do_not_contact, true); assert.equal(reg()["d.ch"].status, "DO_NOT_CONTACT");
  for (const d of ["s.ch", "o.ch", "d.ch"]) assert.ok(registryBlock(store, { domain: d }), `${d} blockiert jeden neuen Cold-Entwurf`);
  // Statusvorrang
  assert.equal(deriveStatus({ customer_status: "customer", reply_status: "replied", manual_send_detected: true, gmail_draft_status: "draft_created" }), "CUSTOMER");
  assert.equal(deriveStatus({ reply_status: "replied", manual_send_detected: true }), "REPLIED");
  assert.equal(deriveStatus({ customer_status: "customer", opt_out: true }), "OPT_OUT");
  assert.deepEqual(LEAD_STATUSES, ["DISCOVERED", "AUDITED", "QUALIFIED", "WAITING_FOR_DRAFT", "DRAFT_CREATED", "MANUALLY_SENT", "REPLIED", "CUSTOMER", "NOT_INTERESTED", "SUPPRESSED", "OPT_OUT", "DO_NOT_CONTACT", "DISCARDED"]);
});

test("Migration: discovered.json, individual_reviews.json, Gmail-Register, leads.json, sales.json zusammengeführt – kein Lead verloren, späterer Status gewinnt", () => {
  write("discovered.json", { leads: {
    "q.ch": { domain: "q.ch", company: "Q AG", email: "info@q.ch", status: "blocked_no_legal_basis", discoveredAt: "2026-09-20T08:00:00Z", auditedAt: "2026-09-20T08:00:00Z", websiteIssues: [broken("q.ch")], discoverySource: "OpenStreetMap node/5 (Thun, office=architect)" },
    "nix.ch": { domain: "nix.ch", company: "Nix AG", status: "no_issues", discoveredAt: "2026-09-20T08:00:00Z" },
  } });
  write(REVIEWS_FILE, { reviews: { "r.ch": review("r.ch", { status: "manually_sent", manual_send_detected: true, manual_send_at: "2026-10-01T09:00:00Z", draft_created_at: "2026-09-30T09:00:00Z" }),
    "q.ch": review("q.ch", { status: "draft_created", draft_created_at: "2026-09-21T09:00:00Z" }) } });
  write("leads.json", [{ email: "kontakt@liste.ch", company: "Liste GmbH", website: "https://liste.ch", approved: true }, { email: "anna@gmail.com", company: "Anna Coiffeur" }]);
  write("sales.json", { records: { "k.ch": { sale: { selected_offer: "REPAIR_FIX_500", sale_value: 480 } } } });
  const gmailRegistry = { drafts: {}, sent: { m1: { to: "info@r.ch", sentAt: "2026-10-01T09:00:00Z", manual: true, leadId: "r.ch", threadId: "T1", messageId: "m1" },
    m2: { to: "Info <info@alt.ch>", sentAt: "2026-08-01T09:00:00Z" }, m3: { to: "chris+test@helvetic-webdesign.ch", sentAt: "2026-10-09T19:55:00Z" } } };
  const r = reconcileRegistry(store, { gmailRegistry, full: true, now: T0 });
  const all = reg();
  assert.deepEqual(Object.keys(all).sort(), ["alt.ch", "anna@gmail.com", "k.ch", "liste.ch", "q.ch", "r.ch"], "alle Leads (ohne nicht qualifizierte, ohne Chris’ eigene Adresse)");
  assert.equal(r.total, 6);
  assert.equal(all["r.ch"].status, "MANUALLY_SENT"); assert.equal(all["r.ch"].first_contacted_at, "2026-10-01T09:00:00Z");
  assert.equal(all["q.ch"].status, "DRAFT_CREATED"); assert.equal(all["q.ch"].canton, "BE"); assert.equal(all["q.ch"].municipality, "Thun"); assert.equal(all["q.ch"].category_label, "Architekt");
  assert.equal(all["k.ch"].status, "CUSTOMER"); assert.equal(all["alt.ch"].status, "MANUALLY_SENT", "alter Jarvis-Kontakt bleibt gemerkt");
  assert.equal(all["liste.ch"].business_email, "kontakt@liste.ch"); assert.equal(all["liste.ch"].discovery_source, "leads.json");
  // Zweite Migration: idempotent, keine Duplikate
  const again = reconcileRegistry(store, { gmailRegistry, full: true, now: T0 });
  assert.equal(again.created, 0); assert.equal(Object.keys(reg()).length, 6);
});

test("Neustart und Backup/Restore verlieren keine Leads (lead_registry.json gehört zum verschlüsselten Backup)", () => {
  recordLead(store, { lead_id: "a.ch", domain: "a.ch", company: "A AG", business_email: "info@a.ch", manual_send_detected: true, first_contacted_at: T0.toISOString() }, { now: T0 });
  recordLead(store, { lead_id: "b.ch", domain: "b.ch", company: "B AG", business_email: "info@b.ch", opt_out: true, suppressed: true }, { now: T0 });
  const before = fs.readFileSync(path.join(dir, REGISTRY_FILE), "utf8");
  assert.deepEqual(Object.keys(loadRegistry(createStore(dir)).leads).sort(), ["a.ch", "b.ch"], "Neustart = neu laden, alles da");
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-033-sec-"));
  fs.mkdirSync(path.join(secretsDir, "mail_worker"));
  fs.copyFileSync(path.join(dir, REGISTRY_FILE), path.join(secretsDir, "mail_worker", REGISTRY_FILE));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const env = createBackup({ secretsDir, publicKeyPem: publicKey, now: T0 });
  assert.ok(env.files.includes(`mail_worker/${REGISTRY_FILE}`));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-033-restore-"));
  fs.rmSync(out, { recursive: true });
  restoreTo(decryptBackup(env, privateKey), out);
  assert.equal(fs.readFileSync(path.join(out, "mail_worker", REGISTRY_FILE), "utf8"), before, "byte-genau wiederhergestellt");
  const restored = loadRegistry(createStore(path.join(out, "mail_worker"))).leads;
  assert.equal(restored["b.ch"].opt_out, true); assert.equal(restored["a.ch"].status, "MANUALLY_SENT");
});

test("CSV-Export: alle geforderten Spalten, Excel-tauglich, keine Secrets/IDs, keine Formel-Injection; JSON-Allowlist ohne interne Referenzen", () => {
  recordLead(store, { lead_id: "csv.ch", domain: "csv.ch", company: "=HYPERLINK(\"x\") AG; Test", business_email: "info@csv.ch", contact_name: "Anna Muster", contact_role: "Geschäftsführerin",
    canton: "BE", municipality: "Köniz", language: "de", category: "office=accountant", category_label: "Treuhand", offer_class: "REPAIR_FIX_500", qualified: true,
    first_discovered_at: T0.toISOString(), refs: { gmail_thread_id: "THREAD-SECRET-1", gmail_message_id: "MSG-SECRET-1" } }, { now: T0 });
  const list = publicRegistry(store);
  const csv = leadsToCsv(list);
  const [header, row] = csv.replace(/^﻿/, "").trim().split("\r\n");
  for (const col of ["Firma", "Website", "Domain", "Business-E-Mail", "Kontakt", "Rolle", "Kanton", "Gemeinde", "Sprache", "Status", "Angebot", "Erstes Discovery-Datum", "Letztes Audit", "Erster Kontakt", "Letzter Kontakt", "Antwort", "Kunde", "Suppressed", "Opt-out", "Do-not-contact"])
    assert.ok(header.split(";").includes(col), `Spalte ${col}`);
  assert.ok(csv.startsWith("﻿"), "UTF-8-BOM für Excel");
  assert.match(row, /^"'=HYPERLINK\(""x""\) AG; Test";/, "Formel neutralisiert, Semikolon gequotet");
  assert.match(row, /;Köniz;de;Treuhand;qualifiziert;CHF 480 Check & Reparatur;/);
  assert.doesNotMatch(csv, /THREAD-SECRET|MSG-SECRET|token|refresh|api[_-]?key|sk-ant|ya29\./i);
  assert.equal(CSV_COLUMNS.length, header.split(";").length);
  const p = publicLead(reg()["csv.ch"]);
  assert.deepEqual(Object.keys(p).sort(), [...PUBLIC_FIELDS].sort());
  assert.ok(!("refs" in p) && !("sources" in p) && !("history" in p));
  assert.doesNotMatch(JSON.stringify(list), /THREAD-SECRET|MSG-SECRET/);
});

test("Spätere Wiederverwendung: Filter für Bern, Treuhänder, angeschrieben, ohne/mit Antwort, Kunden, CHF 480, Monat – ohne erneutes Anschreiben", () => {
  const add = (id, x) => recordLead(store, { lead_id: id, domain: id, company: id + " AG", business_email: "info@" + id, qualified: true, ...x }, { now: T0 });
  add("bern1.ch", { canton: "BE", municipality: "Bern", category_label: "Treuhand", offer_class: "REPAIR_FIX_500", first_discovered_at: "2026-09-15T08:00:00Z", manual_send_detected: true, first_contacted_at: "2026-09-20T08:00:00Z" });
  add("zh1.ch", { canton: "ZH", municipality: "Zürich", category_label: "Architekt", offer_class: "REPAIR_CHECK_150", first_discovered_at: "2026-10-02T08:00:00Z", first_contacted_at: "2026-10-03T08:00:00Z", reply_status: "replied", reply_at: "2026-10-04T08:00:00Z" });
  add("ge1.ch", { canton: "GE", municipality: "Genève", category_label: "Treuhand", offer_class: "REPAIR_FIX_500", first_discovered_at: "2026-10-05T08:00:00Z", customer_status: "customer", first_contacted_at: "2026-10-06T08:00:00Z", reply_status: "replied" });
  const all = publicRegistry(store), ids = (f) => filterLeads(all, f).map((l) => l.lead_id).sort();
  assert.deepEqual(ids({ canton: "BE" }), ["bern1.ch"]);
  assert.deepEqual(ids({ category: "Treuhand" }), ["bern1.ch", "ge1.ch"]);
  assert.deepEqual(ids({ view: "contacted" }), ["bern1.ch", "ge1.ch", "zh1.ch"]);
  assert.deepEqual(ids({ view: "no_reply" }), ["bern1.ch"]);
  assert.deepEqual(ids({ view: "replied" }), ["ge1.ch", "zh1.ch"]);
  assert.deepEqual(ids({ view: "customers" }), ["ge1.ch"]);
  assert.deepEqual(ids({ offer: "REPAIR_FIX_500" }), ["bern1.ch", "ge1.ch"]);
  assert.deepEqual(ids({ canton: "ZH" }), ["zh1.ch"]);
  assert.deepEqual(ids({ month: "2026-10" }), ["ge1.ch", "zh1.ch"]);
  assert.deepEqual(ids({ from: "2026-09-01", to: "2026-10-31" }), ["bern1.ch", "ge1.ch", "zh1.ch"]);
  const s = leadStats(all, T0);
  assert.equal(s.total, 3); assert.equal(s.contacted, 3); assert.equal(s.replies, 2); assert.equal(s.customers, 1);
  // „später verwenden“ ≠ erneut anschreiben: jede dieser Firmen blockiert einen neuen Cold-Entwurf
  for (const l of all) assert.ok(registryBlock(store, { domain: l.domain }), `${l.lead_id} wird nicht erneut angeschrieben`);
});

test("Cloud: VPS schickt die Datenbank (Allowlist erzwungen), Chris filtert/exportiert mit Passwort; ohne Passwort nichts; keine Gmail-IDs", async () => {
  const TOKEN = "t".repeat(40), PW = "geheim-pw";
  const control = memoryStore(), leaddb = memoryStore();
  const h = createServerControlHandler({ getStore: async () => control, getLeadDbStore: async () => leaddb, env: (k) => ({ JARVIS_SERVER_CONTROL_TOKEN: TOKEN, JARVIS_PASSWORD: PW })[k], now: () => T0 });
  const agent = (body) => h(new Request("https://x/api/server-control", { method: "POST", headers: { "x-jarvis-control": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const user = (q, key = PW) => h(new Request("https://x/api/server-control?" + q, { headers: key ? { "x-jarvis-key": key } : {} }));
  recordLead(store, { lead_id: "c1.ch", domain: "c1.ch", company: "C1 AG", business_email: "info@c1.ch", canton: "BE", municipality: "Köniz", qualified: true, manual_send_detected: true, first_contacted_at: T0.toISOString(), refs: { gmail_thread_id: "GMAIL-THREAD-X" } }, { now: T0 });
  recordLead(store, { lead_id: "c2.ch", domain: "c2.ch", company: "C2 AG", business_email: "info@c2.ch", canton: "VD", municipality: "Lausanne", qualified: true }, { now: T0 });
  const payload = publicRegistry(store).map((l) => ({ ...l, gmail_thread_id: "GMAIL-THREAD-X", token: "abc" }));
  const res = await agent({ op: "leaddb", leads: payload, total: 2, generated_at: T0.toISOString() });
  assert.equal(res.status, 200);
  assert.doesNotMatch(JSON.stringify(leaddb.peek()), /GMAIL-THREAD-X|"token"/, "Allowlist auf der Cloud-Seite");
  assert.equal((await user("leaddb=1", null)).status, 401, "ohne Passwort nichts");
  const v = await (await user("leaddb=1&canton=BE")).json();
  assert.equal(v.count, 1); assert.equal(v.leads[0].lead_id, "c1.ch"); assert.equal(v.stats.total, 2); assert.equal(v.stats.contacted, 1); assert.equal(v.facets.cantons.VD, 1);
  const st = await (await user("leaddb=1&status=QUALIFIED&page_size=0")).json();
  assert.equal(st.count, 1); assert.deepEqual(st.leads, [], "nur Kennzahlen");
  const csv = await user("leaddb=csv&view=contacted");
  assert.equal(csv.status, 200); assert.match(csv.headers.get("content-type"), /text\/csv/); assert.match(csv.headers.get("content-disposition"), /attachment; filename="jarvis-leads-/);
  const text = await csv.text();
  assert.equal(text.trim().split("\r\n").length, 2, "Kopf + 1 angeschriebener Lead"); assert.doesNotMatch(text, /GMAIL-THREAD-X/);
  const json = await (await user("leaddb=json")).json();
  assert.equal(json.count, 2);
  assert.ok(control.peek().audit.some((a) => a.action === "leaddb.export"), "Export auditiert");
  // Browser darf keine grossen Bodies schicken; Agent schon (eigene Operation)
  const big = await h(new Request("https://x/api/server-control", { method: "POST", headers: { "x-jarvis-key": PW, "content-length": "100000" }, body: "{}" }));
  assert.equal(big.status, 413);
});

test("Cold-Draft-Logik unverändert: COLD_LEAD_DRAFT_ONLY, legal_basis NONE, automatic_send_allowed false; die Datenbank ist nie eine Versandgrundlage", async () => {
  cfg({ sitesPerRun: 3, maxSearchesPerRun: 1 });
  await run({ search: async () => [cand("kalt.ch")] });
  const rv = reviews()["kalt.ch"];
  assert.equal(rv.draft_mode, COLD_MODE); assert.equal(rv.legal_basis, "NONE"); assert.equal(rv.automatic_send_allowed, false);
  await worker().tick();
  g.manual.push(Object.keys(g.reg.drafts)[0]);
  await worker().tick(); reconcileRegistry(store, { gmailRegistry: g.listOwned(), now: clock });
  assert.ok(!g.calls.some((c) => c.startsWith("SEND")), "0 automatische Sends");
  const l = reg()["kalt.ch"];
  for (const k of Object.keys(l)) assert.doesNotMatch(k, /legal|consent|automatic_send|approved|basis/i, `kein Versandgrundlagen-Feld in der Datenbank (${k})`);
  for (const f of ["lead-db.js", "lead-registry.js"]) assert.doesNotMatch(read(f), /sendDraft|\.send\(|messages\/send/, `${f} hat keinen Sendepfad`);
  assert.equal(registryBlock(store, { domain: "kalt.ch" }), "bereits angeschrieben", "nach manuellem Versand nie wieder ein Cold-Entwurf");
});

test("Dashboard/Mobile: Bereich LEAD-DATENBANK mit Kennzahlen, Suche/Filter (Firma, Domain, E-Mail, Kanton, Gemeinde, Status), Detail, Export; kein Sende-Knopf", () => {
  const html = read("public/index.html");
  for (const id of ["leadDbPanel", "lTotal", "lNew", "lQualified", "lDrafts", "lContacted", "lReplies", "lCustomers", "lSuppressed", "lOptOut", "ldbQ", "ldbCanton", "ldbMuni", "ldbStatus", "ldbCsv", "ldbJson", "ldbDetail", "dCoverage", "dCycle"])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /placeholder="Firma, Domain, E-Mail/);
  for (const label of ["Draft erstellt", "Manuell versendet", "Erster Kontakt", "Letzter Kontakt", "GEFUNDENES PROBLEM", "Do-not-contact"]) assert.ok(html.includes(label), label);
  const dialog = html.slice(html.indexOf('id="leadDb"'), html.indexOf('<div class="boot"'));
  assert.doesNotMatch(dialog, /SENDEN|Senden|send/i, "kein Sende-Knopf in der Lead-Datenbank");
  assert.match(html, /\.ldb-filter input, \.ldb-filter select \{ font-size: 16px; min-height: 44px; \}/, "touch-freundlich, kein iOS-Zoom");
  assert.match(html, /\.ldb-filter input, \.ldb-filter select \{ min-width: 0; width: 100%;/, "keine horizontale Überbreite");
});

test("VPS-Agent: Datenbank nur bei Änderung in die Cloud, eigene Operation; lehnt die Cloud ab, 10 Minuten Pause statt Dauerfeuer", async () => {
  const { createControlAgent } = await import("../server-agent.js");
  let t = +T0, status = 400; const posts = [];
  const fetchFn = async (url, init) => { const b = JSON.parse(init.body); posts.push(b.op); return { status: b.op === "leaddb" ? status : 200, json: async () => ({ requests: [], hot: false }) }; };
  recordLead(store, { lead_id: "p.ch", domain: "p.ch", company: "P AG", business_email: "info@p.ch", qualified: true }, { now: T0 });
  const agent = createControlAgent({ dir, config: { url: "https://x/api/state", controlToken: "c".repeat(40) }, actions: {}, snapshot: () => ({}), leadDb: () => publicRegistry(store), fetchFn, now: () => new Date(t) });
  await agent.pollOnce();
  assert.deepEqual(posts, ["pull", "leaddb"], "eigene Operation neben dem Status-Pull");
  await agent.pollOnce(); assert.deepEqual(posts.slice(2), ["pull"], "abgelehnt → Pause");
  t += 11 * 60_000; status = 200;
  await agent.pollOnce(); assert.deepEqual(posts.slice(3), ["pull", "leaddb"], "nach der Pause erneut");
  t += 60_000;
  await agent.pollOnce(); assert.deepEqual(posts.slice(5), ["pull"], "unverändert → nichts schicken");
  recordLead(store, { lead_id: "p.ch", reply_status: "replied" }, { now: new Date(t) });
  await agent.pollOnce(); assert.deepEqual(posts.slice(6), ["pull", "leaddb"], "geändert → sofort");
});
