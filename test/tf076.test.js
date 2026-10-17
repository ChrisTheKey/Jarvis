// TF-076 Tests – (A) aktives CRM nur mit ≥ 1 verifiziertem Website-Fehler (VPS-Sicht, VN-Sicht, Cloud-Speicher/-Lesen, Calling, Zähler);
// unvollständige/fehlgeschlagene Audits nie als „sauber“; Recheck ohne Fehler → raus aus dem aktiven CRM, Historie bleibt.
// (B) genaue Fehlerbeschreibung je Befund: Fehler, Seite, Position (nur belegt, sonst ehrlicher Ersatz), Beleg, Auswirkung, Direktlink.
// Alles RAM/Temp – keine Anrufe, Zahlungen, Mails oder echten Websites.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setup, makeReq, CONTROL, env } from "./tf063-helpers.js";
import { memoryStore } from "../shared-state.js";
import { authStoreFrom } from "../auth-core.js";
import { buildCrmView, buildCrmLead, crmUniverse, cleanCrmLead } from "../lead-crm.js";
import { crmAdmission, crmActive, verifiedErrorCount, issueDetail, issuePosition, issueDetails, compactCrmLead, topIssues, crmStats, priorityOf, DETAIL_WORDS_DE } from "../public/crm-model.js";
import { DETAIL_WORDS_VI } from "../public/i18n.js";
import { normalizeIssue, fullAuditEntry, siteHealth } from "../site-findings.js";
import { createAuditor, createLocator } from "../site-auditor.js";
import { cleanVnLeads, cleanChLeads } from "../crm-api.js";
import { createCallingHandler, callIssueLinks } from "../calling-api.js";
import { eligibility } from "../calling-core.js";
import { buildVnView } from "../vn-discovery.js";
import { admissionSync, createSourceReader, ADMISSION_FILE, saveCrm } from "../crm-service.js";
import { SELLER_COMMISSION_BPS } from "../pricing.js";
import { RATE_BPS, SELLERS } from "../commission-ledger.js";

const NOW = new Date("2026-10-17T10:00:00.000Z");
const AT = "2026-10-17T08:00:00.000Z";
const OLD = "2026-09-01T08:00:00.000Z";
const COMPLETE = { links_found: 1, links_checked: 1, links_skipped: 0, links_unverified: 0, images_found: 0, images_checked: 0, images_skipped: 0, images_unverified: 0, deadline_hit: false };

// ---------- Quellen-Welt (wie der CRM-Dienst sie liest) ----------
const dirLead = (d) => ({ lead_id: d, domain: d, company_name: `Firma ${d}`, website_url: `https://${d}/`, email: `info@${d}`, phone: "031 111 11 11", phone_normalized: "+41311111111" });
const brokenLink = (d, path = "/impressum-alt", extra = {}) => ({ type: "broken_link", url: `https://${d}${path}`, page: `https://${d}/kontakt`, evidence: `HTTP 404 (verlinkt auf https://${d}/kontakt)`, severity: "medium", label: "Impressum", area: "footer", ...extra });
const full = (d, issues, at = AT) => fullAuditEntry({ reachable: true, coverage: COMPLETE, issues }, { domain: d, audited_at: at });
function world(entries) {
  const directory = { leads: {} }, siteFindings = { domains: {} };
  for (const [d, sf] of Object.entries(entries)) { directory.leads[d] = dirLead(d); if (sf) siteFindings.domains[d] = { domain: d, ...sf }; }
  return { registry: { leads: {} }, reviews: {}, gmail: null, directory, siteFindings, repairFindings: { orders: {} }, history: { leads: {} }, contactForms: { leads: {} }, crm: { leads: {} } };
}

// ================= A: Aufnahmeregel =================
test("TF-076 Regel: vollständiger Audit + 0 Fehler → NICHT aktiv; 1 Fehler → aktiv; mehrere → genau einmal aktiv", () => {
  const src = world({
    "null-fehler.ch": { full: full("null-fehler.ch", []) },
    "ein-fehler.ch": { full: full("ein-fehler.ch", [brokenLink("ein-fehler.ch")]) },
    "drei-fehler.ch": { full: full("drei-fehler.ch", [brokenLink("drei-fehler.ch", "/a"), brokenLink("drei-fehler.ch", "/b"), { type: "broken_image", url: "https://drei-fehler.ch/x.png", page: "https://drei-fehler.ch/", severity: "medium", evidence: "Bild liefert HTTP 404 (eingebunden auf https://drei-fehler.ch/)" }]) },
  });
  const v = buildCrmView(src, NOW);
  assert.deepEqual(v.leads.map((l) => l.lead_id).sort(), ["drei-fehler.ch", "ein-fehler.ch"]);
  assert.equal(v.leads.filter((l) => l.lead_id === "drei-fehler.ch").length, 1, "mehrere Fehler → ein Lead");
  assert.equal(v.leads.find((l) => l.lead_id === "drei-fehler.ch").errors.count, 3);
  assert.deepEqual([v.candidates, v.total, v.excluded.NO_VERIFIED_ERRORS], [3, 2, 1]);
  assert.equal(buildCrmLead("null-fehler.ch", src, NOW).admission, "NO_VERIFIED_ERRORS");
  assert.equal(crmAdmission({ errors: { audit: "FULL", count: 0, items: [] } }).state, "NO_VERIFIED_ERRORS");
  assert.equal(crmAdmission({ errors: { audit: "STALE", count: 0, items: [], full_checked_at: OLD } }).state, "NO_VERIFIED_ERRORS", "veralteter Voll-Audit ohne Fehler");
  assert.equal(crmActive({ errors: { audit: "FULL", count: 2, items: [{ key: "a", text: "x" }, { key: "b", text: "y" }] } }), true);
});

test("TF-076 Regel: fehlgeschlagener / Timeout / Teil-Audit ohne bekannte Fehler → NIE sauber, NIE aktiv", () => {
  const src = world({
    "timeout.ch": { last_attempt_at: AT, last_error: "TIMEOUT", failures: 2, retry_at: AT },
    "dns.ch": { last_attempt_at: AT, last_error: "UNREACHABLE", failures: 1 },
    "teil.ch": { partial: fullAuditEntry({ reachable: true, coverage: { ...COMPLETE, links_found: 120, links_checked: 80 }, issues: [] }, { domain: "teil.ch", audited_at: AT }) },
    "nie-geprueft.ch": null,
  });
  const v = buildCrmView(src, NOW);
  assert.equal(v.total, 0, "keiner davon aktiv");
  const st = (d) => buildCrmLead(d, src, NOW).admission;
  assert.equal(st("timeout.ch"), "AUDIT_FAILED");
  assert.equal(st("dns.ch"), "AUDIT_FAILED");
  assert.equal(st("teil.ch"), "AUDIT_INCOMPLETE");
  assert.equal(st("nie-geprueft.ch"), "AUDIT_RETRY_REQUIRED");
  for (const d of ["timeout.ch", "dns.ch", "teil.ch", "nie-geprueft.ch"]) assert.notEqual(st(d), "NO_VERIFIED_ERRORS", `${d} nicht als sauber`);
  assert.deepEqual(v.excluded, { NO_VERIFIED_ERRORS: 0, AUDIT_INCOMPLETE: 1, AUDIT_FAILED: 2, AUDIT_RETRY_REQUIRED: 1 });
  // Prüfkandidaten bleiben (Hintergrund-Audit prüft weiter, DNC-Aktionen funktionieren) – sie sind nur kein Verkaufs-Lead.
  assert.equal(crmUniverse(src, NOW).size, 4);
  // Ein früher belegter Fehler bleibt aktiv, auch wenn der letzte Versuch scheiterte (kein erfolgreicher Recheck ohne Fehler).
  const s2 = world({ "frueher.ch": { full: full("frueher.ch", [brokenLink("frueher.ch")]), last_error: "TIMEOUT" } });
  assert.equal(buildCrmView(s2, NOW).total, 1);
});

test("TF-076 Recheck entfernt den letzten Fehler → raus aus dem aktiven CRM (Historie/CRM-Daten bleiben), neuer Fehler → wieder drin", () => {
  const d = "recheck.ch";
  const src = world({ [d]: { full: full(d, [brokenLink(d)]) } });
  src.crm.leads[d] = { lead_id: d, notes: [{ id: "n1", at: AT, text: "Rückruf vereinbart" }], call_history: [], sales_stage: "CONTACTED" };
  assert.equal(buildCrmView(src, NOW).total, 1);
  src.siteFindings.domains[d].full = full(d, [], "2026-10-17T09:00:00.000Z"); // erfolgreicher Recheck, Fehler behoben
  const v = buildCrmView(src, NOW);
  assert.equal(v.total, 0);
  assert.equal(buildCrmLead(d, src, NOW).admission, "NO_VERIFIED_ERRORS");
  assert.equal(src.crm.leads[d].notes.length, 1, "CRM-Notizen nicht gelöscht");
  assert.ok(crmUniverse(src, NOW).has(d), "bleibt Prüfkandidat (nächster Recheck)");
  src.siteFindings.domains[d].full = full(d, [brokenLink(d, "/neu")], "2026-10-17T09:30:00.000Z");
  assert.equal(buildCrmView(src, NOW).total, 1, "neuer verifizierter Fehler → wieder aktiv");
});

test("TF-076 Kunden bleiben sichtbar (Auftrag/Historie), auch wenn die Reparatur alle Fehler behoben hat", () => {
  const d = "kunde.ch";
  const src = world({ [d]: { full: full(d, []) } });
  src.registry.leads[d] = { lead_id: d, domain: d, company: "Kunde AG", customer_status: "customer" };
  const v = buildCrmView(src, NOW);
  assert.equal(v.total, 1);
  assert.equal(v.leads[0].admission, "CUSTOMER");
});

test("TF-076 Admission-Sync (Produktions-Bereinigung): idempotent, löscht nichts, nur Zahlen im Ergebnis", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-076-crm-")), mail = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-076-mail-"));
  fs.mkdirSync(path.join(mail, "mail_worker"), { recursive: true });
  const src = world({ "a-fehler.ch": { full: full("a-fehler.ch", [brokenLink("a-fehler.ch")]) }, "b-sauber.ch": { full: full("b-sauber.ch", []) }, "c-timeout.ch": { last_error: "TIMEOUT", last_attempt_at: AT } });
  fs.writeFileSync(path.join(data, "lead_contact_directory.json"), JSON.stringify(src.directory));
  fs.writeFileSync(path.join(data, "site_findings.json"), JSON.stringify({ schema: 1, domains: src.siteFindings.domains }));
  saveCrm(data, { schema: 1, leads: { "b-sauber.ch": { lead_id: "b-sauber.ch", notes: [{ id: "x", at: AT, text: "Notiz" }], call_history: [] } }, meta: { applied: {} } });
  const sources = createSourceReader({ dataDir: data, mailDir: mail });
  const before = fs.readFileSync(path.join(data, "lead_crm.json"), "utf8");
  const r1 = admissionSync({ dataDir: data, sources, now: NOW });
  assert.deepEqual([r1.candidates, r1.active, r1.excluded.NO_VERIFIED_ERRORS, r1.excluded.AUDIT_FAILED, r1.newly_excluded], [3, 1, 1, 1, 2]);
  const doc1 = JSON.parse(fs.readFileSync(path.join(data, ADMISSION_FILE), "utf8"));
  assert.deepEqual(Object.fromEntries(Object.entries(doc1.excluded).map(([k, x]) => [k, x.state])), { "b-sauber.ch": "NO_VERIFIED_ERRORS", "c-timeout.ch": "AUDIT_FAILED" });
  const r2 = admissionSync({ dataDir: data, sources, now: new Date(+NOW + 3_600_000) });
  assert.deepEqual([r2.active, r2.newly_excluded, r2.readmitted], [1, 0, 0], "zweiter Lauf: gleicher Stand");
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, ADMISSION_FILE), "utf8")).excluded["b-sauber.ch"].since, doc1.excluded["b-sauber.ch"].since, "seit-Zeitpunkt stabil");
  assert.equal(fs.readFileSync(path.join(data, "lead_crm.json"), "utf8"), before, "lead_crm.json unverändert");
  assert.ok(!JSON.stringify(r1).includes(".ch"), "Ergebnis ohne Lead-Daten");
  const dry = admissionSync({ dataDir: data, sources, now: NOW, write: false });
  assert.equal(dry.written, false);
});

// ================= A: Cloud + Calling + VN =================
const errItem = (d, x = {}) => ({ key: `link|${d}/alt`, type: "broken_link", category: "http", text: "Link «Angebot» führt auf eine Fehlerseite", page: `https://${d}/angebot`, target: `https://${d}/alt`,
  label: "Angebot", http_status: 404, area: "nav", severity: "medium", verified_at: AT, status: "OPEN", source: "full_audit", ...x });
const withErr = (l) => { const x = cleanCrmLead({ ...l, errors: { audit: "FULL", count: 1, exact: true, checked_at: AT, full_checked_at: AT, items: [errItem(l.domain)], top: [errItem(l.domain)] } }); x.priority = priorityOf(x); return x; };
const zero = (l) => cleanCrmLead({ ...l, errors: { audit: "FULL", count: 0, exact: true, checked_at: AT, full_checked_at: AT, items: [], top: [] } });

async function cloudWorld() {
  const s = await setup({ ch: 600, vn: 8 });
  const zeroCh = new Set(), zeroVn = new Set();
  for (const key of ["view", "vnView"]) {
    const { state, etag } = await s.stores[key].get();
    // Alter (vor TF-076) gespeicherter Stand: jeder 10. Lead ohne Fehler (vollständig geprüft), einer mit Teilprüfung 0.
    state.leads = state.leads.map((l, i) => {
      const m = key === "vnView" ? "VN" : "CH";
      if (i % 10 === 4) { (m === "VN" ? zeroVn : zeroCh).add(l.lead_id); return zero({ ...l, market: m }); }
      if (i === 6) { (m === "VN" ? zeroVn : zeroCh).add(l.lead_id); return cleanCrmLead({ ...l, market: m, errors: { audit: "PARTIAL", count: 0, items: [], top: [] } }); }
      return withErr({ ...l, market: m });
    });
    assert.ok(await s.stores[key].set(state, etag));
  }
  const crm = async (user) => (await s.json(await s.crm(makeReq("/api/crm", s.as(user))))).body;
  return { s, zeroCh, zeroVn, crm };
}

test("TF-076 Cloud: Liste/Zähler je Benutzer nur mit verifizierten Fehlern (auch aus altem Speicherstand); Besitz der übrigen Leads unverändert", async () => {
  const w = await cloudWorld();
  const chris = await w.crm("chris");
  assert.ok(chris.leads.length > 0);
  assert.ok(chris.leads.every((l) => verifiedErrorCount(l) >= 1), "Chris: nur Leads mit Fehler");
  assert.ok(!chris.leads.some((l) => w.zeroCh.has(l.lead_id) || w.zeroVn.has(l.lead_id)));
  assert.equal(chris.total, chris.leads.length);
  assert.equal(chris.stats.err_0, 0, "Zähler «0 verifizierte Fehler» = 0");
  assert.equal(chris.vn_total, chris.leads.filter((l) => l.market === "VN").length, "VN-Marktzahl ohne Null-Fehler-Leads");
  // Verkäufer: eigene Leads ohne Null-Fehler-Leads; kein fremder Lead dazu (keine Umverteilung).
  const seen = new Map();
  for (const u of ["giuliano", "mario", "damiano", "Kudoshin"]) {
    const b = await w.crm(u);
    assert.ok(b.leads.length > 0, u);
    assert.ok(b.leads.every((l) => verifiedErrorCount(l) >= 1), u);
    assert.equal(b.stats.all, b.leads.filter((l) => !l.archived).length, u);
    for (const l of b.leads) { assert.ok(!seen.has(l.lead_id), `${l.lead_id} doppelt (${seen.get(l.lead_id)}/${u})`); seen.set(l.lead_id, u); }
  }
  assert.equal(seen.size, chris.leads.length, "Summe der Verkäufer-Bereiche = aktive Leads gesamt");
  // Direktzugriff auf einen Null-Fehler-Lead: wie unbekannt (Owner 404, Verkäufer 403) – nie als Verkaufs-Lead lieferbar.
  const z = [...w.zeroCh][0];
  assert.equal((await w.s.crm(makeReq("/api/crm", { ...w.s.as("chris"), method: "POST", body: { action: "crm.getLead", params: { lead_id: z } } }))).status, 404);
  assert.equal((await w.s.crm(makeReq("/api/crm", { ...w.s.as("giuliano"), method: "POST", body: { action: "crm.getLead", params: { lead_id: z } } }))).status, 403);
});

test("TF-076 Cloud-Speicher: CH-/VN-Sicht ohne Null-Fehler-Leads, errors.top kompakt (topIssues leitet ab), 6-MB-Grenze entlastet", () => {
  const leads = [withErr({ lead_id: "mit-fehler.ch", domain: "mit-fehler.ch", company: "A" }), zero({ lead_id: "ohne-fehler.ch", domain: "ohne-fehler.ch", company: "B" })];
  const ch = cleanChLeads(leads);
  assert.deepEqual(ch.map((l) => l.lead_id), ["mit-fehler.ch"]);
  assert.deepEqual(ch[0].errors.top, [], "top nicht doppelt gespeichert");
  assert.equal(topIssues(ch[0])[0].key, ch[0].errors.items[0].key, "Top aus items abgeleitet");
  const vn = cleanVnLeads(leads.map((l) => ({ ...l, lead_id: l.lead_id.replace(".ch", ".vn"), domain: l.domain.replace(".ch", ".vn"), market: "VN" })));
  assert.deepEqual(vn.map((l) => l.lead_id), ["mit-fehler.vn"]);
  const big = withErr({ lead_id: "gross.ch", domain: "gross.ch", company: "G" });
  assert.ok(JSON.stringify(compactCrmLead(big)).length < JSON.stringify(big).length);
});

test("TF-076 Calling: Null-Fehler-Lead nie anrufbar (auch mit Einwilligung/Freigabe), Rechts-Sperren gelten weiter; Kudoshin-Anrufansicht mit Detail", async () => {
  const consent = { evidence: null };
  const zl = { ...zero({ lead_id: "vn-zero.vn", domain: "vn-zero.vn", market: "VN", phone: "+84 24 3826 7898", phone_tel: "tel:+842438267898" }), market: "VN" };
  assert.equal(eligibility(zl, { consent, now: NOW, legal: { status: "APPROVED" } }).code, "NO_VERIFIED_ERRORS");
  const el = { ...withErr({ lead_id: "vn-err.vn", domain: "vn-err.vn", market: "VN", phone: "+84 24 3826 7898", phone_tel: "tel:+842438267898" }), market: "VN" };
  assert.notEqual(eligibility(el, { consent, now: NOW, legal: { status: "APPROVED" } }).code, "NO_VERIFIED_ERRORS", "mit Fehler: weiter die normalen Gates");
  assert.equal(eligibility(el, { consent, now: NOW, legal: { status: "APPROVED" } }).decision, "BLOCKED", "Fehler ersetzt keine Einwilligung");
  assert.equal(eligibility({ ...zl, do_not_contact: true }, { now: NOW }).code, "DNC", "DNC bleibt zuerst");

  const w = await cloudWorld();
  const mem = { control: memoryStore({ config: { legal_vn: { status: "APPROVED", reference: "TEST" } } }), history: memoryStore(), consents: memoryStore({ schema: 1, leads: {}, dnc: {} }) };
  const calling = createCallingHandler({ env, getCallingStore: async (k) => mem[k], getAuthStore: async () => authStoreFrom((k) => (w.s.authMem[k] ||= memoryStore())), getViewStore: async () => w.s.stores.view,
    getVnViewStore: async () => w.s.stores.vnView, getSalesStore: async (k) => (w.s.salesMem[k] ||= memoryStore()), getCrmQueueStore: async () => w.s.stores.queue, getVnQueueStore: async () => w.s.stores.vnQueue });
  const as = async (user, q) => { const r = await calling(makeReq(`/api/calling${q}`, { cookie: w.s.cookies[user] })); return { status: r.status, body: await r.json() }; };
  const own = (await w.crm("Kudoshin")).leads[0];
  const d = await as("Kudoshin", `?lead=${encodeURIComponent(own.lead_id)}`);
  assert.equal(d.status, 200);
  const x = d.body.issues[0];
  assert.deepEqual([x.short_title, x.affected_url, x.page_location], ["Liên kết bị hỏng", `https://${own.domain}/angebot`, "Menu chính → «Angebot»"]);
  assert.match(x.evidence, /HTTP 404/); assert.ok(x.impact);
  // Null-Fehler-VN-Lead: nicht über die Anrufansicht abrufbar.
  const zv = [...w.zeroVn][0];
  assert.notEqual((await as("Kudoshin", `?lead=${encodeURIComponent(zv)}`)).status, 200);
  // Fremder (CH) Lead bleibt 403.
  const ch = (await w.crm("mario")).leads[0];
  assert.equal((await as("Kudoshin", `?lead=${encodeURIComponent(ch.lead_id)}`)).status, 403);
  // Kampagnen-Vorschau: Null-Fehler-Leads zählen nicht mit.
  const prev = await as("Kudoshin", "?leads=ALL_LEADS");
  if (prev.status === 200 && Array.isArray(prev.body.leads)) assert.ok(!prev.body.leads.some((l) => w.zeroVn.has(l.lead_id)));
});

test("TF-076 VN-Discovery: Sicht nur mit verifizierten Fehlern; Basisdaten bleiben; DNC auch für ausgeschlossene Leads anwendbar", () => {
  const base = {
    "a.vn": { domain: "a.vn", company: "A", website: "https://a.vn/", region: "Cà Mau", region_code: "VN-CM", category: "Hotel", audited_at: AT,
      audit: { complete: true, audited_at: AT, findings: [normalizeIssue({ type: "broken_link", url: "https://a.vn/x", page: "https://a.vn/", label: "Liên hệ", area: "footer", evidence: "HTTP 404" }, { verified_at: AT })] } },
    "b.vn": { domain: "b.vn", company: "B", website: "https://b.vn/", region: "Cà Mau", region_code: "VN-CM", category: "Hotel", audited_at: AT, audit: { complete: true, audited_at: AT, findings: [] } },
  };
  const store = { crm: () => ({ schema: 1, leads: {}, meta: { applied: {} } }), leads: () => ({ leads: base }), state: () => ({ day: "2026-10-17", audits_today: 1 }), index: () => ({ domains: {} }) };
  const v = buildVnView(store, NOW);
  assert.deepEqual(v.leads.map((l) => l.lead_id), ["a.vn"]);
  assert.equal(v.leads[0].errors.items[0].area, "footer");
});

// ================= B: Fehlerort + Beschreibung =================
test("TF-076 Ort: Seite + Bereich + Element vollständig; Seite + Abschnitt; nur Seite → sicherer Ersatz; ältere Befunde → «Position nicht verfügbar»", () => {
  const sel = issueDetail({ type: "broken_link", page: "https://example.ch/kontakt", target: "https://example.ch/impressum-alt", label: "Impressum", area: "footer", http_status: 404, verified_at: AT });
  assert.deepEqual([sel.short_title, sel.affected_url, sel.page_location, sel.location_known], ["Kaputter Link", "https://example.ch/kontakt", "Footer → «Impressum»", true]);
  assert.equal(sel.evidence, "Der Link «Impressum» verweist auf /impressum-alt. Die Zielseite liefert HTTP 404 (Fehlerseite).");
  assert.equal(sel.impact, "Besucher landen auf einer Fehlerseite statt beim gewünschten Inhalt.");
  assert.deepEqual([sel.error_type, sel.verified_at, sel.target_url], ["broken_link", AT, "https://example.ch/impressum-alt"]);
  const sec = issueDetail({ type: "broken_image", page: "https://example.ch/ueber-uns", target: "https://example.ch/img/team.jpg", heading: "Team", area: "main", http_status: 404 });
  assert.equal(sec.page_location, "Abschnitt «Team»");
  assert.equal(sec.evidence, "Das Bild «team.jpg» verweist auf eine Datei, die HTTP 404 liefert. Das Bild wird nicht angezeigt.");
  const pageOnly = issueDetail({ type: "broken_mailto", page: "https://example.ch/kontakt" });
  assert.deepEqual([pageOnly.page_location, pageOnly.location_known, pageOnly.affected_url], ["Genaue Position nicht automatisch bestimmbar", false, "https://example.ch/kontakt"]);
  const legacy = issueDetail({ text: "Der Link zur Kontaktseite führt auf eine Fehlerseite", page: "https://example.ch/" });
  assert.deepEqual([legacy.page_location, legacy.short_title, legacy.evidence], ["Position nicht verfügbar", "Der Link zur Kontaktseite führt auf eine Fehlerseite", "Der Link zur Kontaktseite führt auf eine Fehlerseite"]);
  assert.equal(issuePosition({ type: "redirect_loop" }).text, "Gesamte Website (beim Aufruf)");
  // Nie erfunden: ohne Linktext kein «…», ohne Bereich kein „Footer“.
  const bare = issueDetail({ type: "broken_link", page: "https://example.ch/", target: "https://example.ch/alt" });
  assert.equal(bare.page_location, "Genaue Position nicht automatisch bestimmbar");
  assert.ok(!/«|Footer|Menü|Abschnitt/.test(bare.page_location));
  assert.equal(bare.evidence, "Der Link verweist auf /alt. Die Zielseite ist nicht erreichbar.", "ohne belegten Status keine Zahl");
  // Vietnamesisch für Kudoshin.
  assert.equal(issueDetail({ type: "broken_link", page: "https://a.vn/", label: "Liên hệ", area: "footer", http_status: 404, target: "https://a.vn/lien-he-cu" }, DETAIL_WORDS_VI).page_location, "Chân trang (footer) → «Liên hệ»");
});

test("TF-076 mehrere Fehler: gleiche Seite → jeder einzeln; verschiedene Seiten → je eigene URL; unsicher/unbekannt → kein Link, nie Startseite", () => {
  const d = "multi.ch";
  const lead = cleanCrmLead({ lead_id: d, domain: d, website: `https://${d}/`, errors: { audit: "FULL", count: 5, items: [
    errItem(d, { key: "a", target: `https://${d}/a`, label: "A" }), errItem(d, { key: "b", target: `https://${d}/b`, label: "B" }),
    errItem(d, { key: "c", page: `https://${d}/team`, target: `https://${d}/c`, label: "C" }),
    errItem(d, { key: "d", page: "http://192.168.1.1/admin", label: "D" }), { key: "e", text: "Älterer Fund ohne Seite", category: "other", status: "OPEN", verified_at: AT } ] } });
  const xs = issueDetails(lead);
  assert.equal(xs.length, 5, "jeder Fehler einzeln");
  assert.deepEqual(xs.map((x) => x.page_location), ["Hauptmenü → «A»", "Hauptmenü → «B»", "Hauptmenü → «C»", "Hauptmenü → «D»", "Position nicht verfügbar"]);
  assert.deepEqual(xs.map((x) => x.affected_url), [`https://${d}/angebot`, `https://${d}/angebot`, `https://${d}/team`, null, null]);
  assert.ok(xs.every((x) => x.affected_url !== lead.website), "nie die Startseite als Ersatz");
  assert.deepEqual(callIssueLinks({ ...lead, market: "CH" }).map((x) => x.page_location), xs.map((x) => x.page_location));
});

test("TF-076 Auditor: Bereich/Überschrift/Linktext/Alt-Text aus dem HTML → normalisierter Befund → «Footer → «Impressum»»", async () => {
  const page = `<html lang="de"><head><title>T</title><meta name="viewport" content="width=device-width"><meta name="description" content="d"></head><body>
    <header><nav class="main-menu"><a href="/kontakt">Kontakt</a></nav></header>
    <main><h2>Unser Team</h2><img src="/img/team.jpg" alt="Teamfoto"><p><a href="mailto:info@">E-Mail schreiben</a></p></main>
    <div id="footer"><ul><li><a href="/impressum-alt">Impressum</a></li></ul></div></body></html>`;
  const fetchFn = async (url) => {
    const u = new URL(url);
    const status = ["/impressum-alt", "/img/team.jpg"].includes(u.pathname) ? 404 : 200;
    return new Response(u.pathname === "/" ? page : "<html></html>", { status, headers: { "content-type": u.pathname.endsWith(".jpg") ? "image/jpeg" : "text/html" } });
  };
  const r = await createAuditor({ fetchFn, delayMs: 0, sleep: async () => {}, maxLinks: 80, maxImages: 25 }).audit("https://muster.ch/");
  const e = fullAuditEntry(r, { domain: "muster.ch", audited_at: AT });
  const by = Object.fromEntries(e.findings.map((f) => [f.type, f]));
  assert.deepEqual([by.broken_link.area, by.broken_link.label], ["footer", "Impressum"]);
  assert.deepEqual([by.broken_image.area, by.broken_image.heading, by.broken_image.label], ["main", "Unser Team", "Teamfoto"]);
  assert.deepEqual([by.broken_mailto.area, by.broken_mailto.label], ["main", "E-Mail schreiben"]);
  assert.equal(issueDetail(by.broken_link).page_location, "Footer → «Impressum»");
  assert.equal(issueDetail(by.broken_image).page_location, "Abschnitt «Unser Team» → Bild «Teamfoto»");
  assert.equal(issueDetail(by.broken_mailto).page_location, "Abschnitt «Unser Team» → «E-Mail schreiben»");
  assert.ok(!JSON.stringify(e).includes("<html"), "keine Seiteninhalte gespeichert");
  // Locator ohne Struktur → keine Felder (nie geraten).
  assert.deepEqual(createLocator("<p><a href=/x>x</a></p>")(3), {});
  // Über Sicht + Cloud-Allowlist bleiben Bereich/Überschrift erhalten.
  const h = siteHealth({ full: { ...e, complete: true }, now: NOW });
  const c = cleanCrmLead({ lead_id: "muster.ch", domain: "muster.ch", errors: h });
  assert.equal(c.errors.items.find((f) => f.type === "broken_link").area, "footer");
});

test("TF-076 Regression: 60 % = 6000 bps für alle Verkäufer, Chris kein Verkäufer", () => {
  assert.equal(SELLER_COMMISSION_BPS, 6000);
  for (const u of SELLERS) assert.equal(RATE_BPS[u], 6000, u);
  assert.equal(RATE_BPS.chris, undefined);
  assert.ok(crmStats([], NOW));
});
