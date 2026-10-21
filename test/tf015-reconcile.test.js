// TF-JARVIS-CRM-015: Abgleich QUALIFIED-Leads ↔ Cold-Queue. Nur synthetische Daten, kein Netz, kein Gmail, kein Senden.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileQualified, CATEGORIES, RECHECK_RESULTS_FILE } from "../scripts/tf015-reconcile-qualified.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = new Date("2026-10-20T10:00:00Z");
const DAY = 86_400_000;
const ago = (d) => new Date(+NOW - d * DAY).toISOString();
const SENDER = { name: "Test Sender", company: "Test Firma", email: "sender@example.ch" };

const issue = (d, type, sev, url, at, extra = {}) => ({ type, url, page: `https://${d}/`, evidence: `HTTP 404 (verlinkt auf https://${d}/)`, severity: sev, detectedAt: at, ...extra });
const LINK = (d, at) => issue(d, "broken_link", "medium", `https://${d}/team-alt`, at, { label: "Unser Team" });
const disc = (d, status, issues, { at = ago(1), email = `info@${d}`, company = `${d.split(".")[0]} AG` } = {}) => ({
  email, business_email: email, company, website: `https://${d}/`, domain: d, uid: "CHE-123.456.789", approved: false, consentBasis: null, status, auditedAt: at, discoveredAt: at,
  reachable: true, title: `${company} – Schreinerei`, discoverySource: "OpenStreetMap node/1 (Winterthur, craft)", canton: "ZH", municipality: "Winterthur", category: "craft",
  contact_source: "impressum", source_url: `https://${d}/impressum`, collected_at: at, contact_confidence: "medium", websiteIssues: issues });
const regQ = (d, extra = {}) => ({ lead_id: d, domain: d, company: `${d.split(".")[0]} AG`, business_email: `info@${d}`, status: "QUALIFIED", qualified: true, audited: true,
  gmail_draft_status: "none", customer_status: "none", reply_status: "none", do_not_contact: false, opt_out: false, suppressed: false, manual_send_detected: false,
  last_audited_at: ago(1), customer_visible_findings: ["Ein Link führt auf eine Fehlerseite"], ...extra });

const CRM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-015-crm-"));
fs.writeFileSync(path.join(CRM_DIR, "lead_crm.json"), JSON.stringify({ schema: 1, leads: {} }));
process.env.JARVIS_CRM_DIR = CRM_DIR;

function state({ registry = {}, discovered = {}, reviews = {}, gmail = { sent: {}, drafts: {} }, suppression = {}, sales = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-015-mail-")), W = path.join(dir, "mail_worker");
  fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(path.join(W, "lead_registry.json"), JSON.stringify({ schema: 1, leads: registry }));
  fs.writeFileSync(path.join(W, "discovered.json"), JSON.stringify({ leads: discovered }));
  fs.writeFileSync(path.join(W, "individual_reviews.json"), JSON.stringify({ reviews }));
  fs.writeFileSync(path.join(W, "config.json"), JSON.stringify({ sender: SENDER }));
  fs.writeFileSync(path.join(W, "suppression.json"), JSON.stringify(suppression));
  if (sales) fs.writeFileSync(path.join(W, "sales.json"), JSON.stringify({ records: sales }));
  fs.writeFileSync(path.join(dir, "gmail_jarvis.json"), JSON.stringify(gmail));
  const file = path.join(W, "individual_reviews.json");
  return { dir, W, file, reviews: () => JSON.parse(fs.readFileSync(file, "utf8")).reviews };
}
const run = (s, opts = {}) => reconcileQualified({ secretsDir: s.dir, base: ROOT, now: NOW, dryRun: false, repairStateDir: null, ...opts });
const dry = (s, opts = {}) => run(s, { dryRun: true, ...opts });
const one = (d, status = "blocked_no_legal_basis", issues, o) => ({ registry: { [d]: regQ(d) }, discovered: { [d]: disc(d, status, issues ?? [LINK(d, ago(1))], o) } });

test("1 eligible: Dry-Run zählt recoverable und schreibt nichts; Apply legt genau einen queued-Eintrag an (kein Gmail, nie senden)", async () => {
  const d = "ok-1.ch", s = state(one(d));
  const r0 = await dry(s);
  assert.equal(r0.recoverable, 1); assert.equal(r0.consistent, true); assert.deepEqual(s.reviews(), {});
  const r = await run(s);
  assert.equal(r.queued, 1);
  const rv = s.reviews()[d];
  assert.equal(rv.status, "queued"); assert.equal(rv.gmail_draft_id, null); assert.equal(rv.draft_mode, "COLD_LEAD_DRAFT_ONLY"); assert.equal(rv.automatic_send_allowed, false);
  assert.ok(fs.readdirSync(s.W).some((f) => f.startsWith("individual_reviews.json.bak-tf015-")), "Sicherung vor dem Schreiben");
});

test("2 bestehender Queue-Eintrag (gleiche Domain bzw. gleiche Firma unter anderem Schlüssel) → represented_queue_entry, unverändert", async () => {
  const a = "q-2.ch", b = "co-2.ch";
  const s = state({ registry: { [a]: regQ(a), [b]: regQ(b, { company: "Gleich AG" }) },
    discovered: { [a]: disc(a, "blocked_no_legal_basis", [LINK(a, ago(1))]), [b]: disc(b, "blocked_no_legal_basis", [LINK(b, ago(1))], { company: "Gleich AG" }) },
    reviews: { [a]: { lead_id: a, domain: a, status: "queued", created_at: ago(1) }, "andere-domain.ch": { lead_id: "andere-domain.ch", domain: "andere-domain.ch", company: "Gleich AG", recipient: "x@andere-domain.ch", status: "draft_created", created_at: ago(2) } } });
  const before = s.reviews();
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.represented_queue_entry, 2); assert.deepEqual(s.reviews(), before);
});

test("3 bestehender Gmail-Entwurf an dieselbe Adresse oder Domain → represented_gmail (kein doppelter Entwurf)", async () => {
  const a = "gm-3.ch", b = "gmdom-3.ch";
  const s = state({ registry: { [a]: regQ(a), [b]: regQ(b) }, discovered: { [a]: disc(a, "blocked_no_legal_basis", [LINK(a, ago(1))]), [b]: disc(b, "blocked_no_legal_basis", [LINK(b, ago(1))]) },
    gmail: { sent: {}, drafts: { r1: { to: `info@${a}` }, r2: { to: `chef@${b}` } } } });
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.represented_gmail, 2); assert.deepEqual(s.reviews(), {});
});

test("4 Suppression (Adresse und Domain) sowie DNC/Opt-out im Register → blocked_dnc", async () => {
  const a = "supp-4.ch", b = "suppdom-4.ch", c = "dnc-4.ch";
  const s = state({ registry: { [a]: regQ(a), [b]: regQ(b), [c]: regQ(c, { do_not_contact: true }) },
    discovered: Object.fromEntries([a, b, c].map((d) => [d, disc(d, "blocked_no_legal_basis", [LINK(d, ago(1))])])),
    suppression: { [`info@${a}`]: { reason: "opt-out" }, [`office@${b}`]: { reason: "opt-out" } } });
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.blocked_dnc, 3);
});

test("5 fehlende Kontaktgrundlage: Freemail-Adresse / ausländischer Lead → kein Entwurf", async () => {
  const a = "free-5.ch", b = "foreign-5.de";
  const s = state({ registry: { [a]: regQ(a), [b]: regQ(b) }, discovered: {
    [a]: disc(a, "blocked_no_legal_basis", [LINK(a, ago(1))], { email: "firma5@gmail.com" }),
    [b]: { ...disc(b, "blocked_no_legal_basis", [LINK(b, ago(1))]), uid: null, canton: null, discoverySource: "manual", title: "Foreign GmbH" } } });
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.blocked_no_business_email, 1); assert.equal(r.excluded_not_cold_stage + r.excluded_no_visible_finding, 1);
});

test("6 kein verifizierter, sichtbarer Website-Fehler → excluded_no_visible_finding", async () => {
  const d = "nofind-6.ch", s = state(one(d, "blocked_no_legal_basis", [issue(d, "missing_title", "medium", `https://${d}/`, ago(1))]));
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.excluded_no_visible_finding, 1);
});

test("7 doppelte Domain: zwei Register-Einträge auf dieselbe Domain → höchstens ein Queue-Eintrag", async () => {
  const d = "dup-7.ch";
  const s = state({ registry: { [d]: regQ(d), [`info@${d}`]: regQ(d, { lead_id: `info@${d}` }) }, discovered: { [d]: disc(d, "blocked_no_legal_basis", [LINK(d, ago(1))]) } });
  const r = await run(s);
  assert.equal(r.queued, 1); assert.equal(Object.keys(s.reviews()).length, 1); assert.equal(r.recoverable, 1); assert.equal(r.represented_queue_entry, 1);
});

test("8 bereits kontaktiert (Register / manuell gesendet) und Sperrfrist → blocked_contacted_or_cooldown bzw. represented_gmail", async () => {
  const a = "sent-8.ch", b = "reply-8.ch", c = "cool-8.ch";
  const s = state({ registry: { [a]: regQ(a), [b]: regQ(b, { reply_status: "replied" }), [c]: regQ(c, { company: "Cool AG" }) },
    discovered: { [a]: disc(a, "blocked_no_legal_basis", [LINK(a, ago(1))]), [b]: disc(b, "blocked_no_legal_basis", [LINK(b, ago(1))]), [c]: disc(c, "blocked_no_legal_basis", [LINK(c, ago(1))], { company: "Cool AG" }) },
    reviews: { "alt-cool.ch": { lead_id: "alt-cool.ch", domain: "alt-cool.ch", company: "Cool AG", recipient: "x@alt-cool.ch", status: "discarded", created_at: ago(30), updated_at: ago(30) } },
    gmail: { sent: { m1: { to: `info@${a}`, sentAt: ago(3), manual: true } }, drafts: {} } });
  const r = await run(s);
  assert.equal(r.queued, 0); assert.equal(r.represented_gmail, 1); assert.equal(r.blocked_contacted_or_cooldown, 2, "Antwort erhalten + Sperrfrist 180 Tage");
});

test("9 Teil-/Altaudit: unvollständige Evidence oder > 7 Tage → pending_recheck; nur endgültige, frische, belegte Neuprüfung zählt als Evidence", async () => {
  const p = "part-9.ch", o = "old-9.ch";
  const s = state({ registry: { [p]: regQ(p), [o]: regQ(o) }, discovered: {
    [p]: disc(p, "blocked_no_legal_basis", [{ type: "broken_link", url: `https://${p}/x`, severity: "medium" }]),
    [o]: disc(o, "blocked_no_legal_basis", [LINK(o, ago(10))], { at: ago(10) }) } });
  const r0 = await dry(s);
  assert.equal(r0.pending_recheck, 2); assert.equal(r0.recoverable, 0);
  assert.equal((await run(s)).queued, 0, "nie aus altem/teilweisem Audit");
  fs.writeFileSync(path.join(s.W, RECHECK_RESULTS_FILE), JSON.stringify({ v: 1, domains: {
    [o]: { at: ago(1), outcome: "audited", final: true, issues: [LINK(o, ago(1))], outreach_authorized: false },
    [p]: { at: ago(1), outcome: "unreachable", final: true, issues: [] } } }));
  const r = await run(s);
  assert.equal(r.recheck_evidence.used_with_finding, 1); assert.equal(r.recheck_evidence.used_no_finding, 1);
  assert.equal(r.queued, 1); assert.equal(r.excluded_no_visible_finding, 1);
  assert.equal(s.reviews()[o].status, "queued"); assert.ok(!s.reviews()[p]);
});

test("10 unterbrochen: Temp-Rest wird entfernt; gleichzeitige Änderung der Queue → Compare-and-retry ohne Lost Update", async () => {
  const d = "int-10.ch", s = state(one(d));
  const stale = path.join(s.W, "individual_reviews.json.tf015-99999.tmp");
  fs.writeFileSync(stale, "{kaputt");
  let first = true;
  const beforeCommit = () => {
    if (!first) return; first = false;
    const cur = JSON.parse(fs.readFileSync(s.file, "utf8")); cur.reviews["fremd-10.ch"] = { lead_id: "fremd-10.ch", domain: "fremd-10.ch", status: "draft_created", created_at: ago(0) }; fs.writeFileSync(s.file, JSON.stringify(cur));
  };
  const r = await run(s, { beforeCommit });
  assert.ok(!fs.existsSync(stale), "Temp-Rest des abgebrochenen Laufs entfernt");
  assert.equal(r.queued, 1); assert.ok(r.attempts >= 2, "Datei hatte sich geändert → neu gelesen");
  const rv = s.reviews();
  assert.equal(rv["fremd-10.ch"].status, "draft_created", "fremde Änderung bleibt erhalten"); assert.equal(rv[d].status, "queued");
});

test("11 wiederholte Ausführung: idempotent, keine zweiten Einträge, bestehende Status unverändert", async () => {
  const d = "rep-11.ch", s = state(one(d));
  await run(s);
  const after1 = s.reviews();
  const r2 = await run(s), r3 = await run(s);
  assert.equal(r2.queued, 0); assert.equal(r3.queued, 0); assert.deepEqual(s.reviews(), after1);
  assert.equal(r2.represented_queue_entry, 1);
});

test("Neu ggü. TF-058: already_in_lead_list / matched_existing_lead werden bewusst NIE eingereiht; Kunde blockiert; Kategorien decken jeden Kandidaten ab", async () => {
  const a = "list-x.ch", b = "match-x.ch", c = "kunde-x.ch", e = "weg-x.ch";
  const s = state({ registry: { [a]: regQ(a), [b]: regQ(b), [c]: regQ(c), [e]: regQ(e) },
    discovered: { [a]: disc(a, "already_in_lead_list", [LINK(a, ago(1))]), [b]: disc(b, "matched_existing_lead", [LINK(b, ago(1))]), [c]: disc(c, "blocked_no_legal_basis", [LINK(c, ago(1))]) },
    sales: { [c]: { sale: { selected_offer: "repair" } } } });
  const r0 = await dry(s);
  assert.equal(r0.excluded_source_existing_list, 1); assert.equal(r0.excluded_source_matched_existing, 1); assert.equal(r0.blocked_customer, 1); assert.equal(r0.pending_no_discovery_record, 1);
  assert.equal(r0.candidates, 4); assert.equal(r0.consistent, true);
  const r = await run(s);
  assert.equal(r.queued, 0); assert.deepEqual(s.reviews(), {});
});

test("Fail-safe + Sicherheit: CRM unlesbar → Abbruch ohne Schreiben; Skript ohne Gmail-/Sendepfad; Ausgabe ohne Domains/Adressen", async () => {
  const d = "safe-x.ch", s = state(one(d));
  const prev = process.env.JARVIS_CRM_DIR;
  process.env.JARVIS_CRM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-015-nocrm-"));
  await assert.rejects(run(s), /fail-safe/); assert.deepEqual(s.reviews(), {});
  process.env.JARVIS_CRM_DIR = prev;
  const out = JSON.stringify(await dry(s));
  assert.ok(!/safe-x|info@|@/.test(out), "nur Zahlen und Kategorien");
  const src = fs.readFileSync(path.join(ROOT, "scripts", "tf015-reconcile-qualified.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/gmail\.js|createDraft\(|sendDraft|messages\.send|child_process|fetch\(/.test(src));
  assert.ok(CATEGORIES.includes("recoverable"));
});
