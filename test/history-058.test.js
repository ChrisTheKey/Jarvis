// TF-058: historische Website-Fehler-Leads im CRM (discovery_issue_history.json) + Neubewertung alter QUALIFIED-Leads (Cold-Queue).
// Nur synthetische Daten, kein echtes Netz, kein Gmail, kein Senden.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSources, writeSources } from "./crm-fixture.js";
import { buildCrmView, crmUniverse, cleanCrmLead } from "../lead-crm.js";
import { createSourceReader, loadCrm } from "../crm-service.js";
import { errorShort, errorLong, crmStats, HISTORY_LABEL } from "../public/crm-model.js";
import { historyRecord, upsertHistory, emptyHistory, ingestDiscovered, migrateHistory, recheckStep, refreshRecheckQueue, readHistory, readRecheck, writeRecheck,
  knownDomainFn, HISTORY_FILE, RECHECK_FILE } from "../discovery-history.js";
import { fullAuditEntry, SITE_FINDINGS_FILE } from "../site-findings.js";
import { createAuditor } from "../site-auditor.js";
import { createBackup, decryptBackup } from "../backup.js";
import { requeueQualified, evidenceComplete } from "../scripts/tf058-requeue-qualified.mjs";
import { extractFromPayloads } from "../scripts/tf058-history-from-backups.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-10-14T10:00:00Z");
const DAY = 86_400_000;
const ago = (d) => new Date(+NOW - d * DAY).toISOString();
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };

// Discovery-Ergebnis wie lead-finder.js (Rohbefunde mit Evidence). status: blocked_no_legal_basis | low_score | no_contact | no_issues | audit_error
const issue = (d, type, sev, url, at, extra = {}) => ({ type, url, page: `https://${d}/`, evidence: `HTTP 404 (verlinkt auf https://${d}/)`, severity: sev, detectedAt: at, ...extra });
const LINK = (d, at, n = "team") => issue(d, "broken_link", "medium", `https://${d}/${n}-alt`, at, { label: n === "team" ? "Unser Team" : `Seite ${n}` });
const CONTACT = (d, at) => issue(d, "contact_page_broken", "high", `https://${d}/kontakt`, at);
const IMAGE = (d, at) => issue(d, "broken_image", "medium", `https://${d}/img/a.jpg`, at, { evidence: `Bild liefert HTTP 404 (eingebunden auf https://${d}/)` });
const disc = (d, status, issues, { at = ago(1), email = `info@${d}`, company = `${d.split(".")[0]} AG` } = {}) => ({
  email, business_email: email, company, website: `https://${d}/`, domain: d, uid: "CHE-123.456.789", approved: false, consentBasis: null, status, auditedAt: at, discoveredAt: at,
  reachable: true, title: `${company} – Schreinerei`, discoverySource: "OpenStreetMap node/1 (Winterthur, craft)", canton: "ZH", municipality: "Winterthur", category: "craft",
  contact_source: "impressum", source_url: `https://${d}/impressum`, collected_at: at, contact_confidence: "medium", websiteIssues: issues });
const regQ = (d, extra = {}) => ({ lead_id: d, domain: d, company: `${d.split(".")[0]} AG`, business_email: `info@${d}`, status: "QUALIFIED", qualified: true, audited: true,
  gmail_draft_status: "none", customer_status: "none", reply_status: "none", do_not_contact: false, opt_out: false, suppressed: false, manual_send_detected: false,
  last_audited_at: ago(1), customer_visible_findings: ["Ein Link führt auf eine Fehlerseite"], ...extra });

// CRM-Datei vorhanden (sonst hält registryBlock fail-safe an) – mit einem CRM-Do-Not-Contact.
const CRM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-058-crm-"));
fs.writeFileSync(path.join(CRM_DIR, "lead_crm.json"), JSON.stringify({ schema: 1, leads: { "crmdnc.ch": { lead_id: "crmdnc.ch", do_not_contact: true } } }));
process.env.JARVIS_CRM_DIR = CRM_DIR;

function mailState({ registry = {}, discovered = {}, reviews = {}, gmail = { sent: {}, drafts: {} }, suppression = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-058-mail-")), W = path.join(dir, "mail_worker");
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, "lead_registry.json"), JSON.stringify({ schema: 1, leads: registry }));
  fs.writeFileSync(path.join(W, "discovered.json"), JSON.stringify({ leads: discovered }));
  fs.writeFileSync(path.join(W, "individual_reviews.json"), JSON.stringify({ reviews }));
  fs.writeFileSync(path.join(W, "config.json"), JSON.stringify({ sender: SENDER }));
  fs.writeFileSync(path.join(W, "suppression.json"), JSON.stringify(suppression));
  fs.writeFileSync(path.join(dir, "gmail_jarvis.json"), JSON.stringify(gmail));
  return { dir, W, reviews: () => JSON.parse(fs.readFileSync(path.join(W, "individual_reviews.json"), "utf8")).reviews };
}
const run = (s, opts = {}) => requeueQualified({ secretsDir: s.dir, base: ROOT, now: NOW, dryRun: false, repairStateDir: null, ...opts });

// ---------- Ziel 1: alte QUALIFIED-Leads neu bewerten ----------
test("A: alter QUALIFIED-Lead, 1 aktueller Befund, geschäftliche Adresse → queued (COLD_LEAD_DRAFT_ONLY, nie senden)", async () => {
  const d = "alt-a.ch";
  const s = mailState({ registry: { [d]: regQ(d) }, discovered: { [d]: disc(d, "blocked_no_legal_basis", [LINK(d, ago(1))]) } });
  const dry = await run(s, { dryRun: true });
  assert.equal(dry.queue, 1); assert.deepEqual(s.reviews(), {}, "Dry-Run schreibt nichts");
  const r = await run(s);
  assert.equal(r.queued, 1); assert.equal(r.fresh_audit, 1); assert.equal(r.rechecked, 0);
  const rv = s.reviews()[d];
  assert.equal(rv.status, "queued"); assert.equal(rv.draft_mode, "COLD_LEAD_DRAFT_ONLY"); assert.equal(rv.automatic_send_allowed, false); assert.equal(rv.legal_basis, "NONE");
  assert.equal(rv.gmail_draft_id, null); assert.equal(rv.customer_findings.length, 1); assert.equal(rv.recipient, `info@${d}`);
  assert.ok(fs.readdirSync(s.W).some((f) => f.startsWith("individual_reviews.json.bak-tf058-")), "Sicherung vor dem Schreiben");
  const again = await run(s);
  assert.equal(again.queued, 0, "idempotent: kein zweiter Eintrag"); assert.equal(Object.keys(s.reviews()).length, 1);
});

test("B: alter QUALIFIED-Lead ohne aktuellen Befund → kein Entwurf (auch nach Neuprüfung; Prüfung fehlgeschlagen = kein Befund)", async () => {
  const ok = "frei-b.ch", old = "alt-b.ch", down = "weg-b.ch", fixedNow = "neu-b.ch";
  const s = mailState({ registry: { [ok]: regQ(ok), [old]: regQ(old), [down]: regQ(down), [fixedNow]: regQ(fixedNow), "ohne-disc.ch": regQ("ohne-disc.ch") }, discovered: {
    [ok]: disc(ok, "blocked_no_legal_basis", [issue(ok, "missing_title", "medium", `https://${ok}/`, ago(1))]),
    [old]: disc(old, "blocked_no_legal_basis", [LINK(old, ago(10))], { at: ago(10) }), [down]: disc(down, "blocked_no_legal_basis", [LINK(down, ago(9))], { at: ago(9) }),
    [fixedNow]: disc(fixedNow, "blocked_no_legal_basis", [LINK(fixedNow, ago(12))], { at: ago(12) }) } });
  const calls = [];
  const auditor = { audit: async (u) => { calls.push(u); if (u.includes(down)) return { reachable: false, issues: [] };
    if (u.includes(fixedNow)) return { reachable: true, issues: [CONTACT(fixedNow, NOW.toISOString())] }; return { reachable: true, issues: [] }; } };
  const dry = await run(s, { dryRun: true });
  assert.equal(dry.would_recheck, 3, ">7 Tage alte Audits → Neuprüfung");
  const r = await run(s, { auditor });
  assert.equal(r.rechecked, 3); assert.equal(calls.length, 3);
  const rv = s.reviews();
  assert.ok(!rv[ok] && !rv[old] && !rv[down] && !rv["ohne-disc.ch"]);
  assert.equal(r.skip_no_current_finding, 4);
  assert.equal(rv[fixedNow]?.status, "queued", "Neuprüfung bestätigt einen aktuellen Fehler → queued");
  assert.match(rv[fixedNow].customer_findings[0].text, /Kontaktseite/);
});

test("C: DNC (Lead-Datenbank, CRM, Opt-out, Suppression) → kein Entwurf", async () => {
  const at = ago(1);
  const ids = ["dnc-c.ch", "crmdnc.ch", "optout-c.ch", "supp-c.ch"];
  const s = mailState({ registry: { "dnc-c.ch": regQ("dnc-c.ch", { do_not_contact: true }), "crmdnc.ch": regQ("crmdnc.ch"), "optout-c.ch": regQ("optout-c.ch", { opt_out: true }),
    "supp-c.ch": regQ("supp-c.ch") }, discovered: Object.fromEntries(ids.map((d) => [d, disc(d, "blocked_no_legal_basis", [LINK(d, at)])])),
    suppression: { "info@supp-c.ch": { reason: "opt-out" } } });
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.skip_dnc, 4); assert.deepEqual(s.reviews(), {});
});

test("D: bereits vorhandener Entwurf / manuell gesendet / Sperrfrist → kein zweiter", async () => {
  const at = ago(1), a = "draft-d.ch", b = "sent-d.ch", c = "same-co.ch";
  const s = mailState({ registry: { [a]: regQ(a), [b]: regQ(b), [c]: regQ(c, { company: "draft AG" }) },
    discovered: { [a]: disc(a, "blocked_no_legal_basis", [LINK(a, at)]), [b]: disc(b, "blocked_no_legal_basis", [LINK(b, at)]), [c]: disc(c, "blocked_no_legal_basis", [LINK(c, at)], { company: "draft AG" }) },
    reviews: { [a]: { lead_id: a, domain: a, company: "draft AG", recipient: `info@${a}`, draft_mode: "COLD_LEAD_DRAFT_ONLY", status: "draft_created", gmail_draft_id: "r1", created_at: ago(2), updated_at: ago(2) } },
    gmail: { sent: { m1: { to: `info@${b}`, sentAt: ago(3), manual: true } }, drafts: {} } });
  const before = s.reviews();
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.skip_duplicate, 3, "gleiche Domain, kontaktierte Adresse, gleiche Firma");
  assert.deepEqual(s.reviews(), before, "bestehender Entwurf unverändert");
});

test("Ziel 1: Evidence-Prüfung + Schweiz-Regel (nicht verifiziert → kein Entwurf) + kein Gmail-/Sendepfad im Skript", async () => {
  assert.equal(evidenceComplete([LINK("x.ch", ago(1))]), true);
  assert.equal(evidenceComplete([{ type: "broken_link", url: "https://x.ch/a" }]), false);
  assert.equal(evidenceComplete([]), false);
  const d = "foreign-x.de";
  const s = mailState({ registry: { [d]: regQ(d) }, discovered: { [d]: { ...disc(d, "blocked_no_legal_basis", [LINK(d, ago(1))]), uid: null, discoverySource: "manual", title: "Foreign GmbH", canton: null } } });
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.skip_not_eligible + r.skip_no_current_finding, 1);
  const src = fs.readFileSync(path.join(ROOT, "scripts", "tf058-requeue-qualified.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/gmail\.js|createDraft\(|sendDraft|messages\.send|child_process/.test(src));
});

// ---------- Ziel 2: historische Website-Fehler-Leads ----------
function crmScenario({ discovered = {}, history = null, siteFindings = null, crm = null, registry = {} } = {}) {
  const src = makeSources(5);
  Object.assign(src.registry.leads, registry);
  const dirs = writeSources(src);
  fs.writeFileSync(path.join(dirs.mail, "mail_worker", "discovered.json"), JSON.stringify({ leads: discovered }));
  fs.writeFileSync(path.join(dirs.mail, "mail_worker", "audited_index.json"), JSON.stringify({ domains: {} }));
  if (history) fs.writeFileSync(path.join(dirs.data, HISTORY_FILE), JSON.stringify(history));
  if (siteFindings) fs.writeFileSync(path.join(dirs.data, SITE_FINDINGS_FILE), JSON.stringify({ schema: 1, domains: siteFindings }));
  if (crm) fs.writeFileSync(path.join(dirs.data, "lead_crm.json"), JSON.stringify({ schema: 1, leads: crm, meta: { applied: {} } }));
  const sources = createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail });
  const view = () => buildCrmView({ ...sources(), crm: loadCrm(dirs.data) }, NOW);
  const by = () => Object.fromEntries(view().leads.map((l) => [l.lead_id, l]));
  return { ...dirs, sources, view, by, migrate: (o = {}) => migrateHistory({ dataDir: dirs.data, mailDir: dirs.mail, sources, now: NOW, dryRun: false, ...o }) };
}

test("E/F/G/H: low_score + no_contact mit belegtem Fehler → CRM (ohne Entwurf); no_issues, audit_error, excluded, ohne sichtbaren Befund → nicht", async () => {
  const at = ago(1);
  const s = crmScenario({ discovered: {
    "low-e.ch": disc("low-e.ch", "low_score", [LINK("low-e.ch", at)]),
    "nocon-f.ch": disc("nocon-f.ch", "no_contact", [CONTACT("nocon-f.ch", at)], { email: null }),
    "clean-g.ch": disc("clean-g.ch", "no_issues", []),
    "err-h.ch": { ...disc("err-h.ch", "audit_error", []), auditedAt: undefined, error: "ETIMEDOUT" },
    "priv.ch": disc("priv.ch", "excluded_private", [LINK("priv.ch", at)]),
    "noco.ch": disc("noco.ch", "excluded_no_company", [LINK("noco.ch", at)], { company: null }),
    "seo.ch": disc("seo.ch", "low_score", [issue("seo.ch", "missing_meta_description", "low", "https://seo.ch/", at), issue("seo.ch", "slow_response", "medium", "https://seo.ch/", at)]) } });
  assert.equal(historyRecord(disc("x.ch", "no_issues", [])).skip, "no_issues");
  assert.equal(historyRecord({ status: "audit_error", domain: "y.ch", company: "Y" }).skip, "audit_error");
  const dry = await s.migrate({ dryRun: true });
  assert.equal(dry.would_add_to_crm, 2); assert.ok(!fs.existsSync(path.join(s.data, HISTORY_FILE)), "Dry-Run schreibt nichts");
  const r = await s.migrate();
  assert.equal(r.would_add_to_crm, 2); assert.equal(r.crm_after, r.crm_before + 2);
  const by = s.by();
  assert.equal(by["low-e.ch"].history_badge, "HISTORICAL"); assert.equal(by["low-e.ch"].draft_status, null); assert.equal(by["low-e.ch"].sales_stage, "NEW");
  assert.equal(by["nocon-f.ch"].email, null, "kein geschäftlicher Kontakt → E-Mail –"); assert.equal(by["nocon-f.ch"].draft_status, null);
  for (const id of ["clean-g.ch", "err-h.ch", "priv.ch", "noco.ch", "seo.ch"]) assert.equal(by[id], undefined, id);
  assert.equal(HISTORY_LABEL[by["low-e.ch"].history_badge], "HISTORISCHER FUND");
  assert.equal(cleanCrmLead(by["low-e.ch"]).history_badge, "HISTORICAL", "Cloud-Allowlist");
  assert.equal(crmStats(s.view().leads, NOW).history, 2);
  const again = await s.migrate();
  assert.equal(again.history_added, 0); assert.equal(again.would_add_to_crm, 0, "idempotent");
});

test("I: alter Backup-Fund → CRM STALE („≥2 · veraltet“), Top 2 als historisch", async () => {
  const d = "old-i.ch", at = ago(10);
  const rec = historyRecord(disc(d, "low_score", [LINK(d, at), IMAGE(d, at), CONTACT(d, at)], { at }), { source: "backup" }).record;
  const s = crmScenario();
  const r = await s.migrate({ importData: { generations: 3, records: [rec] } });
  assert.equal(r.backup_generations, 3);
  const l = s.by()[d];
  assert.equal(l.errors.audit, "STALE"); assert.equal(l.errors.exact, false); assert.equal(l.errors.count, 3);
  assert.equal(errorShort(l), "≥3 · veraltet"); assert.match(errorLong(l), /Teilprüfung veraltet – damals mindestens 3/);
  assert.equal(l.history_badge, "HISTORICAL"); assert.equal(l.errors.top.length, 2); assert.equal(l.errors.top[0].category, "contact");
});

test("J: Recheck bestätigt alten Index-Domain-Fehler → CRM aktuell / ERNEUT VERIFIZIERT; 0 Fehler oder Fehlschlag → nicht aufgenommen", async () => {
  const s = crmScenario();
  fs.writeFileSync(path.join(s.mail, "mail_worker", "audited_index.json"), JSON.stringify({ domains: { "idx-j.ch": "2026-10-08", "idx-ok.ch": "2026-10-08", "idx-down.ch": "2026-10-07", "firma-001.ch": "2026-10-07" } }));
  const r = await s.migrate({ importData: { records: [], index_meta: { "idx-j.ch": { company: "Idx J AG", canton: "BE", status: "no_issues" } } } });
  assert.equal(r.recheck_pending, 3, "bekannte Registry-Domain nicht erneut");
  const pages = (d) => ({ home: "<html></html>", impressum: d === "idx-ok.ch" ? "<p>Idx OK GmbH</p>" : "" });
  const auditor = { audit: async (u) => {
    const d = new URL(u).hostname;
    if (d === "idx-down.ch") throw new Error("ETIMEDOUT");
    if (d === "idx-ok.ch") return { reachable: true, finalUrl: u, pages: pages(d), issues: [], coverage: { links_found: 1, links_checked: 1, images_found: 0, images_checked: 0 } };
    return { reachable: true, finalUrl: u, pages: pages(d), coverage: { links_found: 12, links_checked: 10, images_found: 0, images_checked: 0 },
      issues: [{ type: "contact_page_broken", url: `https://${d}/kontakt`, page: u, evidence: "HTTP 404", severity: "high", detectedAt: NOW.toISOString() }] };
  } };
  const known = () => false, now = () => NOW;
  const outs = [];
  for (let i = 0; i < 6; i++) { const x = await recheckStep({ dataDir: s.data, auditor, known, now }); if (!x) break; outs.push(x.outcome); }
  assert.deepEqual(outs.sort(), ["added", "error", "no_finding", "retry"].sort());
  const rq = readRecheck(s.data);
  assert.equal(rq.pending.length, 0); assert.equal(rq.done["idx-down.ch"].outcome, "error");
  const l = s.by()["idx-j.ch"];
  assert.ok(l); assert.equal(l.company, "Idx J AG"); assert.equal(l.history_badge, "REVERIFIED"); assert.equal(l.errors.audit, "PARTIAL"); assert.equal(errorShort(l), "≥1");
  assert.equal(HISTORY_LABEL.REVERIFIED, "ERNEUT VERIFIZIERT");
  assert.equal(s.by()["idx-ok.ch"], undefined); assert.equal(s.by()["idx-down.ch"], undefined);
  assert.equal(readHistory(s.data).leads["idx-j.ch"].source, "index_recheck");
});

test("K: Registry + Historie gleiche Domain → genau 1 Lead (Registry gewinnt); gleiche Firma auf zwei Domains → 1 Datensatz", async () => {
  const at = ago(1);
  const s = crmScenario({ registry: { "reg-k.ch": regQ("reg-k.ch", { customer_visible_findings: [], status: "QUALIFIED" }) }, discovered: {
    "firma-002.ch": disc("firma-002.ch", "blocked_no_legal_basis", [LINK("firma-002.ch", at)]),
    "reg-k.ch": disc("reg-k.ch", "blocked_no_legal_basis", [LINK("reg-k.ch", at)]),
    "zwilling-a.ch": disc("zwilling-a.ch", "low_score", [LINK("zwilling-a.ch", at)], { company: "Zwilling Holz AG", email: null }),
    "zwilling-b.ch": disc("zwilling-b.ch", "low_score", [LINK("zwilling-b.ch", at)], { company: "Zwilling Holz AG", email: null }) } });
  await s.migrate();
  const v = s.view(), ids = v.leads.map((l) => l.lead_id), doms = v.leads.map((l) => l.domain);
  assert.equal(ids.filter((i) => i === "firma-002.ch").length, 1); assert.equal(new Set(ids).size, ids.length); assert.equal(new Set(doms).size, doms.length);
  const by = s.by();
  assert.equal(by["firma-002.ch"].history_badge, null, "Registry-/Draft-Lead bleibt ohne Historien-Abzeichen");
  assert.equal(by["firma-002.ch"].company, "Firma 2 AG", "Registry/Verzeichnis-Daten haben Vorrang");
  assert.ok(by["reg-k.ch"], "qualifizierter Registry-Lead ohne Kundentext erscheint über den belegten Fund"); assert.equal(by["reg-k.ch"].history_badge, null);
  assert.equal([by["zwilling-a.ch"], by["zwilling-b.ch"]].filter(Boolean).length, 1, "gleiche Firma = ein Datensatz");
  // knownKeys (Discovery-Dedupe) bleibt unberührt: die Historie schreibt nie in lead_registry.json.
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(s.mail, "mail_worker", "lead_registry.json"), "utf8")).leads).includes("zwilling-a.ch"), false);
});

test("L/M: Top 2 korrekt; FULL (aktueller Voll-Audit) / PARTIAL / STALE; behoben → nicht mehr im CRM", async () => {
  const at = ago(1), old = ago(9);
  const s = crmScenario({ discovered: {
    "top-l.ch": disc("top-l.ch", "low_score", [IMAGE("top-l.ch", at), LINK("top-l.ch", at), CONTACT("top-l.ch", at)]),
    "full-m.ch": disc("full-m.ch", "low_score", [LINK("full-m.ch", old)], { at: old }),
    "fixed-m.ch": disc("fixed-m.ch", "low_score", [LINK("fixed-m.ch", old)], { at: old }) } });
  await s.migrate();
  const full = (d, issues) => fullAuditEntry({ reachable: true, coverage: { links_found: 3, links_checked: 3, images_found: 1, images_checked: 1 }, issues }, { domain: d, audited_at: ago(0.5) });
  fs.writeFileSync(path.join(s.data, SITE_FINDINGS_FILE), JSON.stringify({ schema: 1, domains: {
    "full-m.ch": { full: full("full-m.ch", [CONTACT("full-m.ch", ago(0.5)), LINK("full-m.ch", ago(0.5)), IMAGE("full-m.ch", ago(0.5))]) },
    "fixed-m.ch": { full: full("fixed-m.ch", []) } } }));
  const by = s.by();
  const t = by["top-l.ch"].errors;
  assert.equal(t.audit, "PARTIAL"); assert.equal(t.count, 3); assert.equal(t.top.length, 2); assert.equal(t.items.length, 3);
  assert.equal(t.top[0].type, "contact_page_broken", "Kontakt zuerst"); assert.equal(t.top[1].category, "http");
  assert.equal(by["full-m.ch"].errors.audit, "FULL"); assert.equal(errorShort(by["full-m.ch"]), "3"); assert.equal(by["full-m.ch"].history_badge, "REVERIFIED");
  assert.equal(by["fixed-m.ch"], undefined, "aktueller Voll-Audit ohne offenen Fehler → behoben, nicht mehr im CRM");
});

test("Ingest: discovered.json read-only beobachtet – nur bei Änderung, neue no_contact/low_score-Funde bleiben nach der Auslagerung im CRM", async () => {
  const at = ago(0.2);
  const s = crmScenario({ discovered: { "neu.ch": disc("neu.ch", "no_contact", [LINK("neu.ch", at)], { email: null }) } });
  const file = path.join(s.mail, "mail_worker", "discovered.json"), h = sha(file);
  const r = ingestDiscovered({ dataDir: s.data, mailDir: s.mail, now: NOW });
  assert.equal(r.added, 1); assert.equal(sha(file), h, "discovered.json unverändert");
  assert.equal(ingestDiscovered({ dataDir: s.data, mailDir: s.mail, now: NOW }).skipped, "unchanged");
  // lead-finder.js lagert den Eintrag am Folgetag aus → der Fund bleibt im CRM.
  fs.writeFileSync(file, JSON.stringify({ leads: {} })); const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t);
  ingestDiscovered({ dataDir: s.data, mailDir: s.mail, now: NOW });
  assert.ok(s.by()["neu.ch"]);
});

test("Backups: Entschlüsselung im Speicher, gleicher Lead über mehrere Generationen = 1 Datensatz, neuester Audit gewinnt", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const gen = (leads, i) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-058-bk-")); fs.mkdirSync(path.join(dir, "mail_worker"));
    fs.writeFileSync(path.join(dir, "mail_worker", "discovered.json"), JSON.stringify({ leads }));
    return createBackup({ secretsDir: dir, publicKeyPem: publicKey, now: new Date(+NOW - i * DAY) });
  };
  const d = "bk.ch";
  const envs = [gen({ [d]: disc(d, "low_score", [LINK(d, ago(5)), IMAGE(d, ago(5))], { at: ago(5) }), "clean.ch": disc("clean.ch", "no_issues", []) }, 5),
    gen({ [d]: disc(d, "low_score", [CONTACT(d, ago(2))], { at: ago(2) }) }, 2)];
  const r = extractFromPayloads(envs.map((e) => decryptBackup(e, privateKey)), NOW);
  assert.equal(r.generations, 2); assert.equal(r.records.length, 1);
  assert.equal(r.records[0].last_verified_at, ago(2)); assert.deepEqual(r.records[0].verified_findings.map((f) => f.type), ["contact_page_broken"], "neuester Audit gewinnt");
  assert.equal(r.skipped.no_issues, 1); assert.ok(r.index_meta["clean.ch"]); assert.equal(r.index_meta["clean.ch"].status, "no_issues");
  assert.ok(!JSON.stringify(r).includes("HTTP 404"), "keine Evidence-Texte im Import");
});

test("N/O: keine automatische Mail, kein Entwurf aus der Historie, Recheck nur GET (keine Website verändert)", async () => {
  const s = crmScenario();
  fs.writeFileSync(path.join(s.mail, "mail_worker", "audited_index.json"), JSON.stringify({ domains: { "get-o.ch": "2026-10-09" } }));
  await s.migrate({ importData: { records: [], index_meta: { "get-o.ch": { company: "Get O AG" } } } });
  const methods = [];
  const fetchFn = async (url, opts = {}) => { methods.push(opts.method || "GET"); if (opts.body) throw new Error("Body nicht erlaubt");
    return new Response(String(url).endsWith("robots.txt") ? "" : '<html><head><title>Get O</title></head><body><a href="/kontakt">Kontakt</a></body></html>',
      { status: String(url).includes("kontakt") ? 404 : 200, headers: { "content-type": "text/html" } }); };
  const auditor = createAuditor({ fetchFn, delayMs: 0, sleep: async () => {} });
  const origFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error("kein Netz"); };
  try { await recheckStep({ dataDir: s.data, auditor, known: () => false, now: () => NOW }); } finally { globalThis.fetch = origFetch; }
  assert.ok(methods.length > 0); assert.ok(methods.every((m) => m === "GET"), "nur GET");
  const gm = path.join(s.mail, "gmail_jarvis.json"), rv = path.join(s.mail, "mail_worker", "individual_reviews.json"), reg = path.join(s.mail, "mail_worker", "lead_registry.json");
  const h = [sha(gm), sha(rv), sha(reg)];
  const v = s.view();
  const hist = v.leads.filter((l) => l.history_badge);
  assert.ok(hist.length >= 1 && hist.every((l) => !l.draft_status && !l.draft_url), "kein Entwurf aus der Historie");
  assert.deepEqual([sha(gm), sha(rv), sha(reg)], h, "Gmail-Register, Cold-Register, Lead-Datenbank unverändert");
  for (const f of ["discovery-history.js", "lead-crm.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/gmail\.js|createDraft|sendDraft|messages\.send|child_process|individual_reviews/.test(src), f);
  }
  for (const f of ["mail-worker.js", "lead-finder.js", "lead-registry.js", "swiss-repair.js"])
    assert.ok(!fs.readFileSync(path.join(ROOT, f), "utf8").includes("discovery_issue_history"), `${f} liest die Historie nie (keine Outreach-Quelle)`);
});

test("P: CRM-Notizen/Anrufe bleiben erhalten (Migration fasst lead_crm.json nie an); eigene CRM-Daten halten einen behobenen Fund sichtbar", async () => {
  const at = ago(1), d = "note-p.ch";
  const s = crmScenario({ discovered: { [d]: disc(d, "low_score", [LINK(d, at)]) },
    crm: { [d]: { lead_id: d, notes: [{ id: "n1", at: ago(0.1), text: "Rückruf vereinbart" }], call_history: [{ id: "c1", at: ago(0.1), result: "CALLBACK_REQUESTED" }] },
      "firma-003.ch": { lead_id: "firma-003.ch", notes: [{ id: "n2", at: ago(0.1), text: "Alt" }] } } });
  const crmFile = path.join(s.data, "lead_crm.json"), h = sha(crmFile);
  await s.migrate();
  assert.equal(sha(crmFile), h, "lead_crm.json unverändert");
  const by = s.by();
  assert.equal(by[d].notes[0].text, "Rückruf vereinbart"); assert.equal(by[d].call_history.length, 1); assert.equal(by["firma-003.ch"].notes[0].text, "Alt");
  fs.writeFileSync(path.join(s.data, SITE_FINDINGS_FILE), JSON.stringify({ schema: 1, domains: { [d]: { full: fullAuditEntry({ reachable: true,
    coverage: { links_found: 1, links_checked: 1, images_found: 0, images_checked: 0 }, issues: [] }, { domain: d, audited_at: ago(0.1) }) } } }));
  assert.ok(s.by()[d], "behoben, aber mit Notizen → bleibt sichtbar");
  assert.ok(crmUniverse({ ...s.sources(), crm: loadCrm(s.data) }, NOW).has(d));
});

test("Recheck-Warteschlange: nur unbekannte Index-Domains, excluded_* nie, Checkpoint/Resume", () => {
  const rq = { pending: [], done: {} };
  const known = knownDomainFn({ registry: { leads: { a: { domain: "known.ch" } } }, history: { leads: { "hist.ch": { domain: "hist.ch" } } } });
  const r = refreshRecheckQueue(rq, { index: { domains: { "known.ch": "2026-10-01", "hist.ch": "2026-10-01", "new.ch": "2026-10-02", "priv.ch": "2026-10-03" } }, known,
    meta: { "priv.ch": { status: "excluded_private" } }, now: NOW });
  assert.equal(r.added, 1); assert.deepEqual(rq.pending.map((p) => p.domain), ["new.ch"]); assert.equal(rq.done["priv.ch"].outcome, "excluded");
  assert.equal(refreshRecheckQueue(rq, { index: { domains: { "new.ch": "2026-10-02" } }, known, now: NOW }).added, 0, "idempotent");
  const st = emptyHistory();
  const rec = historyRecord(disc("u.ch", "low_score", [LINK("u.ch", ago(3))], { at: ago(3) })).record;
  assert.equal(upsertHistory(st, rec, NOW), "added"); assert.equal(upsertHistory(st, rec, NOW), "unchanged");
  const newer = historyRecord(disc("u.ch", "low_score", [CONTACT("u.ch", ago(1))], { at: ago(1) })).record;
  assert.equal(upsertHistory(st, newer, NOW), "merged"); assert.equal(st.leads["u.ch"].verified_findings[0].type, "contact_page_broken");
  assert.equal(upsertHistory(st, rec, NOW), "unchanged", "älterer Audit überschreibt nie den neueren");
  assert.ok(fs.existsSync(path.join(ROOT, "deploy", "vps", "Dockerfile.crm")) && fs.readFileSync(path.join(ROOT, "deploy", "vps", "Dockerfile.crm"), "utf8").includes("discovery-history.js"));
  assert.equal(RECHECK_FILE, "discovery_recheck.json"); void writeRecheck;
});
