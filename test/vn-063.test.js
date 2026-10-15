// TF-063 Tests – Vietnam-Discovery (A–L): Tageskontingent 1000, eigener Cursor, Dedupe, Markt VN, 34 Einheiten, CRM-Agent, i18n.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadVnAdmin, vnDay, rollDay, quotaLeft, nextJob, createVnStore, searchStep, auditOne, buildVnView, applyVnRequest, candidateOf, createVnAgent,
  VN_DAILY_WEBSITE_AUDITS, CATEGORY_GROUPS, emptyVnState, vnQuery } from "../vn-discovery.js";
import { createCrmHandler, vnAgentToken } from "../crm-api.js";
import { deriveVnToken } from "../deploy/vps/vn-derive-token.mjs";
import { memoryStore } from "../shared-state.js";
import { DICTS, LABELS, createI18n } from "../public/i18n.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-vn-"));
const units = loadVnAdmin().units;
const el = (i, domain, extra = {}) => ({ type: "node", id: i, tags: { name: `Khách sạn ${i}`, tourism: "hotel", website: `https://${domain}/`, phone: "0236 3822 222", ...extra } });
// Auditor-Attrappe: Website mit kaputtem Link auf der Startseite (sichtbarer, belegter Fehler).
const auditor = { audit: async (website) => { const host = new URL(website).hostname; return { website, host, reachable: true, finalUrl: `https://${host}/`,
  pages: { home: `<a href="mailto:lienhe@${host}">x</a>` }, coverage: { links_found: 2, links_checked: 2, links_skipped: 0, links_unverified: 0, images_found: 0, images_checked: 0, images_skipped: 0, images_unverified: 0, deadline_hit: false },
  issues: [{ type: "broken_link", url: `https://${host}/lien-he`, evidence: `HTTP 404 (verlinkt auf https://${host}/)`, severity: "medium", detectedAt: new Date().toISOString(), page: `https://${host}/`, label: "Liên hệ" }] }; } };

test("TF-063 VN J: aktuelle Geografie – 34 Einheiten (6 Städte + 28 Provinzen), Quelle + Version dokumentiert", () => {
  const raw = JSON.parse(fs.readFileSync(new URL("../data/vietnam-admin.json", import.meta.url), "utf8"));
  assert.equal(raw.units.length, 34);
  assert.equal(raw.units.filter((u) => u.type === "city").length, 6);
  assert.deepEqual(raw.units.filter((u) => u.type === "city").map((u) => u.name).sort(), ["Cần Thơ", "Hà Nội", "Hải Phòng", "Hồ Chí Minh", "Huế", "Đà Nẵng"].sort());
  assert.equal(raw.units.reduce((s, u) => s + u.merged_from.length, 0), 63, "alle 63 früheren Provinzen genau einmal zugeordnet");
  assert.equal(new Set(raw.units.flatMap((u) => u.merged_from)).size, 63);
  assert.ok(raw.dataset && raw.version && raw.legal_basis.includes("202/2025") && raw.sources.length >= 2);
  // Alte, nicht mehr eigenständige Einheiten sind KEINE aktuelle Einheit (z. B. Bình Dương, Quảng Nam, Hà Giang).
  for (const old of ["Bình Dương", "Quảng Nam", "Hà Giang", "Kiên Giang", "Bà Rịa – Vũng Tàu"]) assert.ok(!raw.units.some((u) => u.name === old), old);
});

test("TF-063 VN A/B/C: 1000 Audits je VN-Tag, 1001. startet nicht, Tageswechsel setzt nur den Tageszähler zurück", async () => {
  assert.equal(VN_DAILY_WEBSITE_AUDITS, 1000);
  const dir = tmp(), store = createVnStore(dir), now = new Date("2026-10-15T10:00:00Z");
  store.saveState({ ...emptyVnState(), day: vnDay(now), audits_today: 999, queue: [] });
  assert.equal(quotaLeft(store.state()), 1);
  assert.equal(quotaLeft(store.state(), 1), 0, "läuft schon eins → kein weiteres");
  await auditOne({ store, c: candidateOf(el(1, "ks-1.vn"), { unit: units[0], categories: CATEGORY_GROUPS[3] }), auditor, now: () => now });
  assert.equal(store.state().audits_today, 1000);
  assert.equal(quotaLeft(store.state()), 0, "1001. Audit desselben Tages wird nicht gestartet");
  const idxBefore = store.index().domains;
  // VN-Mitternacht (UTC+7): 17:00 UTC = 00:00 in Hồ Chí Minh
  const next = rollDay(store.state(), new Date("2026-10-15T17:00:01Z"));
  assert.equal(next.audits_today, 0); assert.equal(next.day, "2026-10-16");
  assert.equal(vnDay(new Date("2026-10-15T16:59:59Z")), "2026-10-15");
  assert.deepEqual(store.index().domains, idxBefore, "Dedupe-Index bleibt");
  assert.ok(store.leads().leads["ks-1.vn"], "Leads bleiben");
});

test("TF-063 VN D/I: Lead nur mit VN-Beleg + sichtbarem Fehler, market VN, Domain nie doppelt, kein Re-Audit am selben Tag", async () => {
  const dir = tmp(), store = createVnStore(dir), now = new Date("2026-10-15T10:00:00Z");
  const search = async () => [el(1, "ks-1.vn"), el(2, "ks-1.vn"), el(3, "facebook.com"), el(4, "chain.com", { brand: "Big Chain" }), { type: "node", id: 5, tags: { tourism: "hotel", website: "https://noname.vn" } }, el(6, "ks-6.com")];
  const r = await searchStep({ store, units, search, now });
  assert.equal(r.added, 2, "Duplikat, Plattform, Kette und namenlose Einträge verworfen");
  for (const c of store.state().queue) await auditOne({ store, c, auditor, now: () => now });
  const view = buildVnView(store, now, units);
  assert.equal(view.leads.length, 2);
  for (const l of view.leads) { assert.equal(l.market, "VN"); assert.match(l.region_code, /^VN-/); assert.match(l.phone_tel, /^tel:\+84/); assert.equal(l.email, `lienhe@${l.domain}`); }
  assert.ok(view.leads.find((l) => l.domain === "ks-6.com"), ".vn ist keine Pflicht (VN-Zuordnung über OSM-Gebiet Vietnam)");
  assert.ok(view.leads[0].findings[0].text.includes("liên kết"), "Befundtext vietnamesisch");
  // Gleiche Domains erneut gefunden → nicht erneut in die Queue (Lead existiert / Cooldown).
  store.saveState({ ...store.state(), queue: [] });
  assert.equal((await searchStep({ store, units, search, now })).added, 0);
  assert.match(vnQuery({ anchor: units[0].anchors[0], categories: CATEGORY_GROUPS[0] }), /area\["ISO3166-1"="VN"\]\["admin_level"="2"\]->\.vn;.*\(area\.vn\)/, "Suche nur innerhalb Vietnams");
});

test("TF-063 VN F/G/H: persistenter, fairer Cursor über alle 34 Einheiten; Schweizer Cursor unberührt", async () => {
  const dir = tmp(), store = createVnStore(dir);
  const chGeo = path.join(dir, "discovery_geo.json"); fs.writeFileSync(chGeo, JSON.stringify({ cursor: { canton: 7, municipality: 123 } }));
  const before = fs.readFileSync(chGeo, "utf8");
  const seen = [];
  for (let i = 0; i < 34; i++) { const s = await searchStep({ store, units, search: async () => [], now: new Date() }); seen.push(s.unit); }
  assert.equal(new Set(seen).size, 34, "jede Einheit genau einmal je Zyklus (keine Konzentration auf HCM/Hanoi)");
  assert.equal(store.state().cycle, 1);
  // Neustart: neuer Store auf demselben Verzeichnis setzt fort.
  const again = createVnStore(dir);
  const s35 = await searchStep({ store: again, units, search: async () => [], now: new Date() });
  assert.equal(s35.unit, units[0].code); assert.equal(s35.cat_index, 1, "zweiter Durchlauf: nächste Branchengruppe");
  assert.equal(fs.readFileSync(chGeo, "utf8"), before, "CH-Cursor unverändert");
  // Anker rotieren je Einheit nach allen Branchengruppen.
  let st = emptyVnState();
  const anchors = new Set();
  for (let i = 0; i < 34 * CATEGORY_GROUPS.length * 3; i++) { const r = nextJob(st, units); st = r.state; if (r.job.unit.code === "VN-SG") anchors.add(r.job.anchor.name); }
  assert.equal(anchors.size, 3, "HCM: alle drei früheren Hauptorte als Such-Anker");
});

test("TF-063 VN E/L: CRM-Agent – VN-Sicht, VN-Queue, eigener Schlüssel; Laps Schreibaktion landet nur im VN-Dienst", async () => {
  const CONTROL = "c".repeat(48);
  assert.equal(deriveVnToken(CONTROL), vnAgentToken(CONTROL));
  const dir = tmp(), store = createVnStore(dir), now = new Date();
  for (const [i, d] of [[1, "ks-1.vn"], [2, "ch-firma.ch"]].entries()) { const c = candidateOf(el(i, d[1]), { unit: units[3], categories: CATEGORY_GROUPS[3] }); store.saveState({ ...store.state(), queue: [] }); await auditOne({ store, c, auditor, now: () => now }); }
  const vq = memoryStore(), vv = memoryStore(), ch = memoryStore({ leads: [{ lead_id: "ch-firma.ch", domain: "ch-firma.ch", company: "CH Firma AG", canton: "ZH" }] });
  const handler = createCrmHandler({ env: (k) => ({ JARVIS_SERVER_CONTROL_TOKEN: CONTROL, JARVIS_PASSWORD: "pw" })[k], getQueueStore: async () => memoryStore(), getViewStore: async () => ch,
    getVnQueueStore: async () => vq, getVnViewStore: async () => vv });
  const agent = createVnAgent({ store, url: "https://jarvis.test", token: vnAgentToken(CONTROL), fetchFn: (u, i) => handler(new Request(u, i)), units });
  assert.equal((await agent.pollOnce()).status, 200);
  assert.deepEqual(vv.peek().leads.map((l) => l.domain), ["ks-1.vn"], "Domain, die schon CH-Lead ist, wird nicht doppelt als VN-Firma angelegt");
  // Falscher Schlüssel / CRM-Schlüssel gilt nicht für VN
  const bad = await handler(new Request("https://jarvis.test/api/crm", { method: "POST", headers: { "x-jarvis-vn": "x".repeat(64) }, body: JSON.stringify({ op: "vn_pull" }) }));
  assert.equal(bad.status, 401);
  // Auftrag aus der Cloud → VN-Dienst wendet an
  vq.peek().requests.push({ request_id: "11111111-1111-1111-1111-111111111111", action: "crm.addNote", params: { lead_id: "ks-1.vn", text: "Đã gọi" }, status: "pending", created_at: now.toISOString(), expires_at: new Date(+now + 60_000).toISOString() });
  await vq.set(vq.peek(), (await vq.get()).etag);
  await agent.pollOnce();
  assert.equal(store.crm().leads["ks-1.vn"].notes[0].text, "Đã gọi");
  assert.equal(vq.peek().requests[0].status, "done");
  assert.equal(applyVnRequest(store, { request_id: "22222222-2222-2222-2222-222222222222", action: "crm.addNote", params: { lead_id: "ch-firma.ch", text: "x" } }).ok, true, "lokal bekannt (VN-Index)");
});

test("TF-063 VN K: vi-VN-Wörterbuch vollständig, keine deutschen Reste in den Hauptansichten", () => {
  const de = DICTS["de-CH"], vi = DICTS["vi-VN"];
  for (const k of Object.keys(de)) assert.ok(Object.hasOwn(vi, k), `vi fehlt: ${k}`);
  const GERMAN = /\b(und|der|die|das|nicht|Firma|Kontakt(?!:)|Telefon|Fehler|Anruf|Notiz|Keine|Suche|Branche|Kanton|Entwurf|Provision|Ausstehend|Auszahlbar|Storniert|Abmelden|Anmelden|Passwort|Benutzername|Sprache|Status ändern|Speichern|Zurücksetzen|Schliessen|Archiv|gesendet|geprüft|Website-Fehler|Wichtigste)\b/i;
  const sample = (v) => (typeof v === "function" ? v(3, "01.01.2026", true) : v);
  for (const [k, v] of Object.entries(vi)) assert.doesNotMatch(String(sample(v)), GERMAN, `deutscher Rest in ${k}: ${sample(v)}`);
  for (const [group, map] of Object.entries(LABELS["vi-VN"])) for (const [k, v] of Object.entries(map)) if (!["level"].includes(group)) assert.doesNotMatch(String(v), GERMAN, `${group}.${k}`);
  const I = createI18n("vi-VN");
  assert.equal(I.L.stage.NEW, "Mới"); assert.equal(I.category("Restaurant"), "Nhà hàng"); assert.equal(I.reason("+2 Telefon vorhanden"), "+2 Có số điện thoại");
  assert.equal(createI18n("de-CH").t("th.company"), "Firma", "Deutsch unverändert");
});
