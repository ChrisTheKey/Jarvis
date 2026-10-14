// TF-055 CRM-Fehlerzahl: tatsächliche, aktuell verifizierte Website-Fehler je Lead – vollständig („7 Fehler“) vs. Teilprüfung
// („Mindestens 3 Fehler“), Deduplikation, RESOLVED zählt nicht, Top 2 deterministisch, Frische (7 Tage), passiver Hintergrund-Audit
// (Checkpoint/Resume, Fehler isoliert, nur GET), Allowlist, kein Outreach-Effekt. Nur synthetische Daten, kein Netz, kein Senden.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSources, writeSources, bump } from "./crm-fixture.js";
import { buildCrmView, buildCrmLead, cleanCrmLead, crmUniverse } from "../lead-crm.js";
import { createSourceReader, loadCrm } from "../crm-service.js";
import { siteHealth, fullAuditEntry, normalizeIssue, dedupeFindings, auditComplete, partialFindings, ISSUE_CATEGORIES as SF_CATEGORIES,
  SITE_FINDINGS_FILE, REPAIR_FINDINGS_FILE, FULL_AUDIT_MAX_AGE_MS } from "../site-findings.js";
import { errorShort, errorLong, errorCount, errorBucket, topIssues, filterLeads, crmStats, sortLeads, ISSUE_CATEGORIES, ERROR_CARDS, priorityOf, inOutreachQueue } from "../public/crm-model.js";
import { createBackfill, auditOne, nextDue, backfillCandidates, readSiteFindings } from "../site-backfill.js";
import { createAuditor } from "../site-auditor.js";

const NOW = new Date("2026-10-14T10:00:00Z");
const AT = "2026-10-14T06:00:00.000Z";
const COMPLETE = { links_found: 5, links_checked: 5, links_skipped: 0, links_unverified: 0, images_found: 3, images_checked: 3, images_skipped: 0, images_unverified: 0, deadline_hit: false };
const iss = (type, url, page, severity = "medium", extra = {}) => ({ type, url, page, severity, evidence: "HTTP 404", detectedAt: AT, ...extra });
// 7 tatsächliche Fehler + nicht gezählte Hinweise + Duplikate (gleiches Ziel von zwei Seiten, Kontakt-Link = Kontaktseite kaputt).
const H = "https://firma-021.ch";
const SEVEN = [
  iss("contact_page_broken", `${H}/kontakt`, `${H}/`, "high"),
  iss("broken_link", `${H}/kontakt`, `${H}/`, "medium", { label: "Kontakt" }),            // Duplikat (gleiche Ursache)
  iss("broken_link", `${H}/team`, `${H}/`, "medium", { label: "Team" }),
  iss("broken_link", `${H}/team/`, `${H}/ueber-uns`, "medium", { label: "Team" }),        // Duplikat (gleiches Ziel, andere Seite)
  iss("broken_link", `${H}/blog`, `${H}/`, "medium", { label: "Blog" }),
  iss("broken_image", `${H}/img/a.jpg`, `${H}/`, "medium"),
  iss("broken_mailto", "mailto:x", `${H}/impressum`, "medium"),
  iss("no_mobile_viewport", `${H}/`, null, "medium"),
  iss("https_certificate", `${H}/`, null, "high"),
  iss("missing_meta_description", `${H}/`, null, "low"), iss("missing_alt", `${H}/`, null, "low"),   // nicht gezählt (SEO/Barrierefreiheit)
  iss("slow_response", `${H}/`, null, "medium"), iss("mixed_content", `${H}/`, null, "medium"),        // nicht gezählt (intern/nicht sicher reproduzierbar)
  iss("broken_link", `${H}/alt`, `${H}/`, "medium", { reproducible: false }),                          // nicht reproduzierbar
];
const full7 = (audited_at = AT) => fullAuditEntry({ reachable: true, coverage: COMPLETE, issues: SEVEN }, { domain: "firma-021.ch", audited_at });

function svc({ siteFindings = null, repair = null, n = 30 } = {}) {
  const src = makeSources(n), dirs = writeSources(src);
  const repairDir = path.join(dirs.base, "repair-export"); fs.mkdirSync(repairDir);
  if (siteFindings) fs.writeFileSync(path.join(dirs.data, SITE_FINDINGS_FILE), JSON.stringify(siteFindings));
  if (repair) fs.writeFileSync(path.join(repairDir, REPAIR_FINDINGS_FILE), JSON.stringify(repair));
  return { src, ...dirs, repairDir, sources: createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail, repairDir }) };
}
const lead = (s, id, now = NOW) => buildCrmLead(id, { ...s.sources(), crm: loadCrm(s.data) }, now);
const view = (s, now = NOW) => buildCrmView({ ...s.sources(), crm: loadCrm(s.data) }, now);

test("A: vollständiger Audit mit 7 Fehlern → CRM „7“ / „7 Fehler (verifiziert)“, Audit Vollständig, Zeitpunkt", () => {
  const s = svc({ siteFindings: { schema: 1, domains: { "firma-021.ch": { domain: "firma-021.ch", full: full7() } } } });
  const l = lead(s, "firma-021.ch");
  assert.equal(l.errors.audit, "FULL"); assert.equal(l.errors.count, 7); assert.equal(l.errors.exact, true);
  assert.equal(l.errors.checked_at, AT);
  assert.equal(errorShort(l), "7"); assert.equal(errorLong(l), "7 Fehler (verifiziert)");
  assert.equal(l.errors.items.length, 7, "Detail: alle verifizierten Fehler");
  assert.deepEqual([...new Set(l.errors.items.map((f) => f.type))].sort(), ["broken_image", "broken_link", "broken_mailto", "contact_page_broken", "https_certificate", "no_mobile_viewport"]);
});

test("B: nur Cold-/Discovery-Befunde (3) → „Mindestens 3 Fehler“, nie „3 Fehler“", () => {
  const s = svc();
  // firma-001: 1 Kundenbefund (Link) + Bild (i%7===1) – Evidence-Link gleicher Schlüssel; dazu ein weiterer Audit-Befund.
  bump(path.join(s.mail, "mail_worker", "individual_reviews.json"), (d) => { d.reviews["firma-001.ch"].issue_evidence.push(
    { issue_type: "broken_image", url: "https://firma-001.ch/b.png", evidence: "Bild liefert HTTP 404 (eingebunden auf https://firma-001.ch/team)", observed_at: "2026-10-09T07:00:00Z", reproducible: true, severity: "medium" }); });
  const l = lead(s, "firma-001.ch");
  assert.equal(l.errors.audit, "PARTIAL"); assert.equal(l.errors.exact, false);
  assert.equal(l.errors.count, 3);
  assert.equal(errorShort(l), "≥3"); assert.equal(errorLong(l), "Mindestens 3 verifizierte Fehler");
  assert.doesNotMatch(errorShort(l), /^3$/); assert.doesNotMatch(errorLong(l), /^3 Fehler/);
  assert.ok(l.errors.checked_at, "Zuletzt geprüft vorhanden");
});

test("C: 5 Rohbefunde mit Duplikat/gleicher Ursache → korrekt dedupliziert", () => {
  const raw = [iss("broken_link", `${H}/a`, `${H}/`), iss("broken_link", `${H}/a/`, `${H}/x`), iss("broken_link", `${H}/b`, `${H}/`),
    iss("contact_page_broken", `${H}/kontakt`, `${H}/`, "high"), iss("broken_link", `${H}/kontakt#form`, `${H}/`)];
  const out = dedupeFindings(raw.map((i) => normalizeIssue(i)).filter(Boolean));
  assert.equal(out.length, 3);
  assert.equal(out.find((f) => f.target?.includes("kontakt")).type, "contact_page_broken", "Kontakt hat Vorrang vor 404");
  const e = fullAuditEntry({ reachable: true, coverage: COMPLETE, issues: raw }, { domain: "x.ch", audited_at: AT });
  assert.equal(siteHealth({ full: e, now: NOW }).count, 3);
});

test("D: RESOLVED-Befund zählt nicht (Repair-Stand)", () => {
  const f = full7().findings;
  const rep = { domain: "firma-021.ch", state: "COMPLETED", completion: "FULL", audited_at: "2026-10-14T08:00:00.000Z",
    findings: f.map((x, i) => ({ ...x, status: i < 2 ? "RESOLVED" : "OPEN", manual: i >= 2 })) };
  const h = siteHealth({ full: full7(), repair: rep, now: NOW });
  assert.equal(h.count, 5); assert.equal(h.resolved, 2);
  assert.ok(h.items.every((x) => x.status === "OPEN"));
});

test("E: Top 2 transparent priorisiert (Kontakt vor Navigation vor 404/Bilder/Mobile; dann Schweregrad)", () => {
  const h = siteHealth({ full: full7(), now: NOW });
  assert.deepEqual(h.items.map((f) => f.category), ["contact", "contact", "navigation", "http", "http", "images", "mobile"]);
  assert.deepEqual(h.top.map((f) => [f.category, f.severity]), [["contact", "high"], ["contact", "medium"]]);
  assert.equal(h.top[0].text, "Kontaktseite führt auf eine Fehlerseite");
  const order = h.items.map((f) => f.category);
  const rank = { contact: 1, navigation: 2, http: 3, images: 4, mobile: 5, other: 6 };
  assert.deepEqual(order, [...order].sort((a, b) => rank[a] - rank[b]), "Kategorien in Prioritätsreihenfolge");
  // deterministisch: gleiche Eingabe in anderer Reihenfolge → gleiche Top 2
  const shuffled = fullAuditEntry({ reachable: true, coverage: COMPLETE, issues: [...SEVEN].reverse() }, { domain: "firma-021.ch", audited_at: AT });
  assert.deepEqual(siteHealth({ full: shuffled, now: NOW }).top, h.top);
  assert.ok(h.top.every((f) => f.text.length <= 140 && !/HTTP|404|Statuscode/.test(f.text)), "kurze Texte ohne technische Meldungen");
});

test("F/G: genau 1 Fehler → nur Top 1; 0 Fehler → „Keine aktuell verifizierten Fehler“", () => {
  const one = fullAuditEntry({ reachable: true, coverage: COMPLETE, issues: [iss("broken_image", `${H}/i.png`, `${H}/`)] }, { domain: "x.ch", audited_at: AT });
  const h1 = siteHealth({ full: one, now: NOW });
  assert.equal(h1.top.length, 1); assert.equal(topIssues({ errors: h1 }).length, 1);
  const zero = fullAuditEntry({ reachable: true, coverage: COMPLETE, issues: [iss("missing_alt", `${H}/`, null, "low")] }, { domain: "x.ch", audited_at: AT });
  const h0 = siteHealth({ full: zero, now: NOW });
  assert.equal(h0.count, 0); assert.equal(h0.top.length, 0);
  assert.equal(errorShort({ errors: h0 }), "0"); assert.equal(errorLong({ errors: h0 }), "Keine aktuell verifizierten Fehler");
  assert.equal(errorShort({ errors: siteHealth({ now: NOW }) }), "–", "nie geprüft → keine Zahl");
});

test("H: vollständiger Audit älter als 7 Tage → „veraltet“ sichtbar, Zahl nicht als genau behandelt", () => {
  const old = full7(new Date(+NOW - FULL_AUDIT_MAX_AGE_MS - 3600_000).toISOString());
  const h = siteHealth({ full: old, now: NOW });
  assert.equal(h.audit, "STALE"); assert.equal(h.exact, false);
  assert.equal(errorShort({ errors: h }), "7 (veraltet)");
  assert.match(errorLong({ errors: h }), /Letzte vollständige Prüfung veraltet/);
  // Backfill plant die Neuprüfung (älter als 6 Tage → fällig).
  const st = { domains: { "firma-021.ch": { domain: "firma-021.ch", full: old, last_attempt_at: old.audited_at } } };
  assert.equal(nextDue(st, [{ domain: "firma-021.ch", website: "https://firma-021.ch/" }], NOW)?.domain, "firma-021.ch");
});

test("Unvollständiger Voll-Audit (Netzaussetzer/robots/>80 Links/Zeitbudget) zählt nie als vollständig", () => {
  for (const cov of [{ ...COMPLETE, links_unverified: 1, links_checked: 4 }, { ...COMPLETE, links_skipped: 1, links_checked: 4 }, { ...COMPLETE, links_found: 81, links_checked: 80 }, { ...COMPLETE, deadline_hit: true }]) {
    const r = { reachable: true, coverage: cov, issues: SEVEN };
    assert.equal(auditComplete(r), false, JSON.stringify(cov));
    const h = siteHealth({ incomplete: fullAuditEntry(r, { domain: "firma-021.ch", audited_at: AT }), now: NOW });
    assert.equal(h.audit, "PARTIAL"); assert.equal(errorShort({ errors: h }), "≥7");
  }
  assert.equal(auditComplete({ reachable: false, coverage: COMPLETE, issues: [] }), false);
  assert.equal(auditComplete({ reachable: true, coverage: COMPLETE, issues: [{ type: "http_error" }] }), false);
});

test("Kategorien: CRM-Modell (Browser) und site-findings.js identisch; Teilprüfung ohne Typ → Kategorie aus Text", () => {
  assert.deepEqual([...ISSUE_CATEGORIES], [...SF_CATEGORIES]);
  const p = partialFindings([{ text: "Das Kontaktformular lässt sich derzeit nicht absenden", verified_at: AT }, { text: "Auf dem Handy ist der Bereich «Menü» abgeschnitten", verified_at: AT }]);
  assert.deepEqual(p.map((f) => f.category), ["contact", "mobile"]);
});

test("Bestehende Leads: ohne Migration; Full-Audit verwendet, sonst Teilprüfung, sonst „nicht geprüft“ – keine erfundenen Zahlen", () => {
  const s = svc({ n: 30, siteFindings: { schema: 1, domains: { "firma-021.ch": { domain: "firma-021.ch", full: full7() } } } });
  const v = view(s);
  assert.equal(v.total, 30);
  const by = Object.fromEntries(v.leads.map((l) => [l.lead_id, l]));
  assert.equal(by["firma-021.ch"].errors.audit, "FULL");
  assert.equal(by["firma-004.ch"].errors.audit, "PARTIAL", "Cold-Register ohne Kundenbefund, aber Audit-Evidence");
  assert.ok(v.leads.filter((l) => l.lead_id !== "firma-021.ch").every((l) => ["PARTIAL", "NONE"].includes(l.errors.audit)));
  for (const l of v.leads) if (l.errors.audit !== "FULL") assert.equal(l.errors.exact, false);
});

test("M: Filter Fehler 0/1–2/3–5/6+, Audit Vollständig/Teilprüfung/Veraltet/Nicht geprüft, Wichtiges Problem; Zähler + Sortierung", () => {
  const mk = (id, h) => ({ lead_id: id, company: id, archived: false, errors: h });
  const list = [mk("a", siteHealth({ full: full7(), now: NOW })), mk("b", siteHealth({ partial: [{ text: "Ein Bild wird nicht angezeigt", type: "broken_image", target: `${H}/x.png`, page: `${H}/`, verified_at: AT }], now: NOW })),
    mk("c", siteHealth({ full: fullAuditEntry({ reachable: true, coverage: COMPLETE, issues: [] }, { domain: "c.ch", audited_at: AT }), now: NOW })), mk("d", siteHealth({ now: NOW })),
    mk("e", siteHealth({ full: full7("2026-09-01T00:00:00.000Z"), now: NOW }))];
  const ids = (f) => filterLeads(list, f, NOW).map((l) => l.lead_id);
  assert.deepEqual(ids({ errors: "6+" }), ["a", "e"]); assert.deepEqual(ids({ errors: "1-2" }), ["b"]); assert.deepEqual(ids({ errors: "0" }), ["c"]); assert.deepEqual(ids({ errors: "3-5" }), []);
  assert.deepEqual(ids({ audit: "FULL" }), ["a", "c"]); assert.deepEqual(ids({ audit: "PARTIAL" }), ["b"]); assert.deepEqual(ids({ audit: "STALE" }), ["e"]); assert.deepEqual(ids({ audit: "NONE" }), ["d"]);
  assert.deepEqual(ids({ issue: "contact" }), ["a", "e"]); assert.deepEqual(ids({ issue: "images" }), ["b"]);
  assert.deepEqual(ids({ card: "audit_partial" }), ["b"]);
  const st = crmStats(list, NOW);
  assert.deepEqual([st.err_0, st.err_1_2, st.err_3_5, st.err_6, st.audit_full, st.audit_partial], [1, 1, 0, 2, 2, 1]);
  assert.equal(Object.keys(ERROR_CARDS).length, 6);
  assert.deepEqual(sortLeads(list, "problems").map((l) => l.lead_id), ["a", "e", "b", "c", "d"]);
});

test("Cloud-Allowlist: nur Zahl/Audit/Zeit/Kurztexte – keine Evidence; Zahl einer Teilprüfung bleibt „nicht genau“", () => {
  const s = svc({ siteFindings: { schema: 1, domains: { "firma-021.ch": { domain: "firma-021.ch", full: full7() } } } });
  const c = cleanCrmLead(lead(s, "firma-021.ch"));
  assert.equal(c.errors.count, 7); assert.equal(c.errors.audit, "FULL"); assert.equal(c.errors.top.length, 2); assert.equal(c.errors.items.length, 7);
  assert.ok(!JSON.stringify(c.errors).includes("HTTP 404"), "keine Evidence");
  assert.ok(c.findings.every((f) => !("type" in f) && !("target" in f)), "interne Felder der alten Liste nicht in der Cloud");
  const forged = cleanCrmLead({ ...lead(s, "firma-001.ch"), errors: { audit: "PARTIAL", exact: true, count: 3, items: [{ text: "<script>", category: "x", evidence: "geheim" }] } });
  assert.equal(forged.errors.exact, false); assert.equal(forged.errors.items[0].category, "other"); assert.ok(!("evidence" in forged.errors.items[0]));
  assert.equal(cleanCrmLead({ ...lead(s, "firma-001.ch"), errors: null }).errors.audit, "NONE");
});

test("N/O: kein Outreach-Effekt – Priorität/Outreach-Queue unverändert, kein Senden/Entwurf (Quellen unverändert)", () => {
  const s = svc({ siteFindings: { schema: 1, domains: { "firma-021.ch": { domain: "firma-021.ch", full: full7() } } } });
  const files = [path.join(s.mail, "mail_worker", "individual_reviews.json"), path.join(s.mail, "gmail_jarvis.json"), path.join(s.mail, "mail_worker", "lead_registry.json")];
  const before = files.map((f) => fs.readFileSync(f, "utf8"));
  const withFull = lead(s, "firma-021.ch");
  const plain = buildCrmLead("firma-021.ch", { ...s.sources(), siteFindings: { domains: {} }, crm: loadCrm(s.data) }, NOW);
  assert.deepEqual(withFull.priority, plain.priority, "Fehlerzahl ändert die Priorität nicht");
  assert.equal(inOutreachQueue(withFull), inOutreachQueue(plain));
  assert.equal(withFull.draft_status, plain.draft_status); assert.deepEqual(withFull.findings, plain.findings, "Cold-Befunde (max. 3 im Entwurf) unverändert");
  assert.deepEqual(files.map((f) => fs.readFileSync(f, "utf8")), before, "keine Quelle (Register/Gmail) verändert");
  assert.deepEqual(priorityOf(withFull), priorityOf(plain));
});

// ---------- Passiver Hintergrund-Audit ----------
test("Backfill: Kandidaten ohne DNC/archiviert, eine Website je Schritt, Checkpoint/Resume, Fehler isoliert mit Backoff", async () => {
  const s = svc({ n: 6 });
  const seen = [];
  const auditor = { audit: async (u) => {
    seen.push(u);
    if (u.includes("firma-002")) throw Object.assign(new Error("boom"), { code: "ECONNRESET" });
    if (u.includes("firma-003")) return { reachable: true, coverage: { ...COMPLETE, links_unverified: 1, links_checked: 4 }, issues: [iss("broken_link", `${u}x`, u)] };
    return { reachable: true, coverage: COMPLETE, issues: u.includes("firma-001") ? [iss("broken_image", `${u}i.png`, u)] : [] };
  } };
  const src = () => ({ ...s.sources(), crm: loadCrm(s.data) });
  const cands = backfillCandidates(src(), [...crmUniverse(src())]);
  assert.deepEqual(cands.map((c) => c.domain).sort(), ["firma-000.ch", "firma-001.ch", "firma-002.ch", "firma-003.ch", "firma-004.ch", "firma-005.ch"].filter((d) => d !== "firma-011.ch"));
  assert.equal(cands.find((c) => c.domain === "firma-001.ch").website, "https://www.firma-001.ch/", "offizielle Website-Adresse aus dem Kontaktverzeichnis");
  const bf = createBackfill({ dataDir: s.data, sources: src, universe: crmUniverse, auditor, now: () => NOW });
  const results = [];
  for (let i = 0; i < 8; i++) { const r = await bf.step(); if (!r) break; results.push(r); }
  assert.equal(results.length, 6, "jede Website genau einmal, danach nichts fällig");
  assert.equal(seen.length, 6);
  const st = readSiteFindings(s.data);
  assert.equal(st.domains["firma-001.ch"].full.findings.length, 1);
  assert.equal(st.domains["firma-002.ch"].last_error, "ECONNRESET"); assert.equal(st.domains["firma-002.ch"].failures, 1); assert.ok(st.domains["firma-002.ch"].retry_at > NOW.toISOString());
  assert.equal(st.domains["firma-003.ch"].full, undefined); assert.equal(st.domains["firma-003.ch"].partial.complete, false);
  // Resume nach Neustart: neue Instanz, gleiche Datei → nichts doppelt; nach Backoff wird nur die fehlerhafte Website erneut versucht.
  const bf2 = createBackfill({ dataDir: s.data, sources: src, universe: crmUniverse, auditor, now: () => NOW });
  assert.equal(await bf2.step(), null);
  const later = new Date(+NOW + 2 * 3600_000);
  const r = await createBackfill({ dataDir: s.data, sources: src, universe: crmUniverse, auditor, now: () => later }).step();
  assert.equal(r.domain, "firma-002.ch");
  // CRM-Sicht übernimmt den Voll-Audit automatisch.
  const by = Object.fromEntries(view(s).leads.map((l) => [l.lead_id, l]));
  assert.equal(by["firma-001.ch"].errors.audit, "FULL"); assert.equal(by["firma-001.ch"].errors.count, 1);
  assert.equal(by["firma-000.ch"].errors.audit, "FULL"); assert.equal(by["firma-000.ch"].errors.count, 0);
  assert.equal(by["firma-003.ch"].errors.audit, "PARTIAL", "unvollständig → nur Mindestzahl");
  assert.equal(fs.readdirSync(s.data).filter((f) => f.includes(".tmp-")).length, 0, "keine Temp-Reste");
});

test("Backfill: DNC/Opt-out/archiviert wird nie geprüft", () => {
  const s = svc({ n: 15 });
  bump(path.join(s.mail, "mail_worker", "lead_registry.json"), (d) => { d.leads["firma-005.ch"].opt_out = true; });
  const src = { ...s.sources(), crm: { leads: { "firma-006.ch": { archived: true }, "firma-007.ch": { do_not_contact: true } } } };
  const doms = backfillCandidates(src, [...crmUniverse(src)]).map((c) => c.domain);
  for (const d of ["firma-005.ch", "firma-006.ch", "firma-007.ch", "firma-011.ch"]) assert.ok(!doms.includes(d), d);
  assert.equal(doms.length, 11);
});

test("Backfill-Schleife blockiert nie und endet sauber (stop)", async () => {
  const s = svc({ n: 3 });
  let calls = 0, stop = false;
  const auditor = { audit: async () => { calls++; return { reachable: true, coverage: COMPLETE, issues: [] }; } };
  const bf = createBackfill({ dataDir: s.data, sources: () => ({ ...s.sources(), crm: loadCrm(s.data) }), universe: crmUniverse, auditor, now: () => NOW,
    sleep: async () => { await new Promise((r) => setImmediate(r)); if (calls >= 3) stop = true; } });
  await bf.run(() => stop, { startDelayMs: 0 });
  assert.equal(calls, 3);
});

test("site-auditor: nur GET, robots.txt beachtet, Abdeckung ehrlich gemeldet (vollständig vs. übersprungen)", async () => {
  const reqs = [];
  const page = `<html lang="de"><head><title>T</title><meta name="viewport" content="width=device-width"><meta name="description" content="d"></head><body>
    <a href="/kontakt">Kontakt</a><a href="/team">Team</a><a href="/intern/x">Intern</a><img src="/a.png" alt="a"></body></html>`;
  const fetchFn = async (url, init = {}) => {
    reqs.push([init.method || "GET", url]);
    const u = new URL(url);
    const body = u.pathname === "/robots.txt" ? "User-agent: *\nDisallow: /intern/" : u.pathname === "/" ? page : "<html></html>";
    const status = u.pathname === "/team" ? 404 : 200;
    return new Response(body, { status, headers: { "content-type": u.pathname.endsWith(".png") ? "image/png" : "text/html" } });
  };
  const r = await createAuditor({ fetchFn, delayMs: 0, sleep: async () => {}, maxLinks: 80, maxImages: 25 }).audit("https://muster.ch/");
  assert.ok(reqs.every(([m]) => m === "GET"), "nur GET");
  assert.ok(!reqs.some(([, u]) => u.includes("/intern/")), "robots.txt beachtet");
  assert.deepEqual(r.coverage, { links_found: 3, links_checked: 2, links_skipped: 1, links_unverified: 0, images_found: 1, images_checked: 1, images_skipped: 0, images_unverified: 0, deadline_hit: false });
  assert.equal(auditComplete(r), false, "übersprungene Seite → keine vollständige Zahl");
  const e = fullAuditEntry(r, { domain: "muster.ch", audited_at: AT });
  assert.deepEqual(e.findings.map((f) => f.type), ["broken_link"]);
  assert.ok(!JSON.stringify(e).includes("<html"), "keine Seiteninhalte gespeichert");
});
