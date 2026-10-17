// TF-057: alle qualifizierten Website-Fehler-Leads im CRM – auch vor dem Gmail-Entwurf (QUALIFIED, WAITING_FOR_DRAFT, queued).
// Nur synthetische Daten (test/crm-fixture.js), kein Netz, kein Senden, keine Entwurfsänderung.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeSources, writeSources, COLD } from "./crm-fixture.js";
import { buildCrmView, buildCrmLead, crmUniverse, cleanCrmLead, qualifiedPreDraft } from "../lead-crm.js";
import { createSourceReader, loadCrm } from "../crm-service.js";
import { crmStats, pipelinePhase, PIPELINE_CARDS, filterLeads, errorShort, DRAFT_LABEL, DRAFT_STATUSES } from "../public/crm-model.js";
import { fullAuditEntry, SITE_FINDINGS_FILE } from "../site-findings.js";

const NOW = new Date("2026-10-14T10:00:00Z");
const FINDINGS = ["Der Link zu Ihrer Kontaktseite führt auf eine Fehlerseite", "Auf Ihrer Startseite wird ein Bild nicht angezeigt", "Ein E-Mail-Link funktioniert nicht"];
// Registry-Eintrag wie lead-registry.js fromDiscovered + mergeLead (qualifizierter Discovery-Lead ohne Entwurf).
const regLead = (domain, extra = {}) => ({ lead_id: domain, domain, company: `Neu ${domain} GmbH`, business_email: `info@${domain}`, canton: "BE", municipality: "Bern", language: "de",
  status: "QUALIFIED", qualified: true, audited: true, gmail_draft_status: "none", customer_status: "none", reply_status: "none", do_not_contact: false, opt_out: false, suppressed: false,
  manual_send_detected: false, last_audited_at: "2026-10-13T08:00:00Z", customer_visible_findings: [FINDINGS[0]], offer_class: "REPAIR_FIX_500", ...extra });
function scenario(mutate) {
  const src = makeSources(20);
  mutate?.(src);
  const dirs = writeSources(src);
  const sources = createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail });
  return { src, ...dirs, sources, view: () => buildCrmView({ ...sources(), crm: loadCrm(dirs.data) }, NOW) };
}
const byId = (v) => Object.fromEntries(v.leads.map((l) => [l.lead_id, l]));

test("A: QUALIFIED ohne Gmail-Entwurf erscheint im CRM (Stufe NEU, kein Entwurf, Befund sichtbar)", () => {
  const s = scenario((src) => { src.registry.leads["qual-a.ch"] = regLead("qual-a.ch"); });
  const v = s.view(), l = byId(v)["qual-a.ch"];
  assert.equal(v.total, 21);
  assert.ok(l, "QUALIFIED erscheint");
  assert.equal(l.sales_stage, "NEW"); assert.equal(l.draft_status, null); assert.equal(l.draft_url, null);
  assert.equal(l.company, "Neu qual-a.ch GmbH"); assert.equal(l.email, "info@qual-a.ch");
  assert.equal(l.findings_confirmed, 1);
  assert.equal(pipelinePhase(l), "no_draft");
  assert.ok(cleanCrmLead(l), "Cloud-Allowlist akzeptiert den neuen Lead");
});

test("B: WAITING_FOR_DRAFT erscheint im CRM als „Wartet auf Entwurf“", () => {
  const s = scenario((src) => { src.registry.leads["wait-b.ch"] = regLead("wait-b.ch", { status: "WAITING_FOR_DRAFT", gmail_draft_status: "queued" }); });
  const l = byId(s.view())["wait-b.ch"];
  assert.ok(l);
  assert.equal(l.draft_status, "QUEUED"); assert.equal(DRAFT_LABEL[l.draft_status], "Wartet auf Entwurf");
  assert.equal(l.sales_stage, "NEW"); assert.equal(pipelinePhase(l), "waiting_draft");
  assert.equal(cleanCrmLead(l).draft_status, "QUEUED", "QUEUED übersteht die Cloud-Allowlist");
});

test("C: queued Cold-Review ohne gmail_draft_id erscheint im CRM (nicht erst mit Gmail-Entwurf)", () => {
  const s = scenario((src) => {
    // Nur das Cold-Register kennt den Lead (Registry-Abgleich noch nicht gelaufen): queued genügt.
    src.reviews["queue-c.ch"] = { lead_id: "queue-c.ch", company: "Queue C AG", domain: "queue-c.ch", recipient: "info@queue-c.ch", draft_mode: COLD, status: "queued",
      created_at: "2026-10-14T08:00:00Z", updated_at: "2026-10-14T08:00:00Z",
      customer_findings: [{ key: "contact", text: FINDINGS[0], internal_refs: [{ issue_type: "contact_page_broken", url: "https://queue-c.ch/kontakt" }] }], issue_evidence: [] };
    // Nicht-Cold-Review und verworfene Queue bleiben draussen.
    src.reviews["other-mode.ch"] = { lead_id: "other-mode.ch", draft_mode: "INDIVIDUAL_REVIEW", status: "queued" };
  });
  const by = byId(s.view());
  assert.ok(by["queue-c.ch"]); assert.equal(by["queue-c.ch"].draft_status, "QUEUED"); assert.equal(by["queue-c.ch"].draft_url, null);
  assert.equal(by["queue-c.ch"].errors.audit, "PARTIAL"); assert.equal(errorShort(by["queue-c.ch"]), "≥1");
  assert.equal(by["other-mode.ch"], undefined);
});

test("D: DRAFT_CREATED weiterhin genau einmal (Registry + Review + Verzeichnis + Gmail)", () => {
  const s = scenario();
  const v = s.view(), ids = v.leads.map((l) => l.lead_id);
  assert.equal(v.total, 20); assert.equal(new Set(ids).size, 20);
  assert.equal(ids.filter((id) => id === "firma-015.ch").length, 1);
  assert.equal(byId(v)["firma-015.ch"].draft_status, "DRAFT"); assert.equal(byId(v)["firma-015.ch"].sales_stage, "DRAFT_READY");
});

test("E: gleiche Domain in Registry + Review + Verzeichnis → genau 1 CRM-Lead; abweichende ID derselben Firma → kein zweiter Datensatz", () => {
  const s = scenario((src) => {
    src.registry.leads["same-e.ch"] = regLead("same-e.ch", { status: "WAITING_FOR_DRAFT", gmail_draft_status: "queued" });
    // TF-076: aktiver CRM-Lead nur mit verifiziertem Fehler.
    src.reviews["same-e.ch"] = { lead_id: "same-e.ch", domain: "same-e.ch", company: "Same E GmbH", recipient: "info@same-e.ch", draft_mode: COLD, status: "queued", customer_findings: [{ key: "contact", text: "Der Link zur Kontaktseite führt auf eine Fehlerseite" }], issue_evidence: [] };
    src.directory.leads["same-e.ch"] = { lead_id: "same-e.ch", company_name: "Same E GmbH", domain: "same-e.ch", email: "info@same-e.ch", phone: "+41 31 999 99 99", phone_normalized: "+41319999999", phone_confidence: "high" };
    // Derselbe Betrieb unter anderer ID (geschäftliche Adresse als ID, www-Domain) – Registry führt ihn bereits.
    src.registry.leads["dup-e.ch"] = regLead("dup-e.ch");
    src.directory.leads["info@dup-e.ch"] = { lead_id: "info@dup-e.ch", company_name: "Dup E GmbH", domain: "www.dup-e.ch", email: "info@dup-e.ch" };
    src.reviews["kontakt@dup-e.ch"] = { lead_id: "kontakt@dup-e.ch", domain: "dup-e.ch", recipient: "kontakt@dup-e.ch", draft_mode: COLD, status: "queued", customer_findings: [], issue_evidence: [] };
  });
  const v = s.view(), ids = v.leads.map((l) => l.lead_id);
  assert.equal(ids.filter((id) => id === "same-e.ch").length, 1);
  assert.equal(byId(v)["same-e.ch"].phone_tel, "tel:+41319999999", "Verzeichnisdaten am selben Lead");
  assert.ok(ids.includes("dup-e.ch")); assert.ok(!ids.includes("info@dup-e.ch")); assert.ok(!ids.includes("kontakt@dup-e.ch"));
  const doms = v.leads.map((l) => l.domain);
  assert.equal(doms.length, new Set(doms).size, "keine Domain doppelt");
  // Mit eigenen CRM-Daten bleibt ein solcher Eintrag sichtbar (nie Datenverlust).
  const src = { ...s.sources(), crm: { leads: { "info@dup-e.ch": { lead_id: "info@dup-e.ch", notes: [{ id: "n1", at: "2026-10-14T09:00:00Z", text: "Notiz" }] } } } };
  assert.ok(crmUniverse(src).has("info@dup-e.ch"));
});

test("F/G/H: no_issues, low_score, audit_error, excluded_* und Leads ohne verifizierten Befund werden nicht aufgenommen", () => {
  const s = scenario((src) => {
    // So stehen nicht qualifizierte Discovery-Ergebnisse höchstens in der Datenbank: nie qualified, Status AUDITED/DISCOVERED.
    src.registry.leads["noissues-f.ch"] = regLead("noissues-f.ch", { status: "AUDITED", qualified: false, customer_visible_findings: [] });
    src.registry.leads["lowscore-g.ch"] = regLead("lowscore-g.ch", { status: "AUDITED", qualified: false });
    src.registry.leads["auditerr-h.ch"] = regLead("auditerr-h.ch", { status: "DISCOVERED", qualified: false, audited: false, last_audited_at: null, customer_visible_findings: [] });
    // Qualifiziert, aber ohne einen einzigen kundensichtbaren Befund → kein Sales-Lead.
    src.registry.leads["nofinding.ch"] = regLead("nofinding.ch", { customer_visible_findings: [] });
    src.registry.leads["nocompany.ch"] = regLead("nocompany.ch", { company: null });
    src.registry.leads["blocked.ch"] = regLead("blocked.ch", { status: "DO_NOT_CONTACT", do_not_contact: true });
  });
  // discovered.json (Rohdaten) liegt daneben – das CRM liest es nicht.
  fs.writeFileSync(path.join(s.mail, "mail_worker", "discovered.json"), JSON.stringify({ leads: [
    { domain: "raw-noissues.ch", status: "no_issues", company: "X" }, { domain: "raw-low.ch", status: "low_score", company: "Y" },
    { domain: "raw-err.ch", status: "audit_error" }, { domain: "raw-priv.ch", status: "excluded_private" }, { domain: "raw-noco.ch", status: "excluded_no_company" }] }));
  const ids = s.view().leads.map((l) => l.lead_id);
  for (const id of ["noissues-f.ch", "lowscore-g.ch", "auditerr-h.ch", "nofinding.ch", "nocompany.ch", "blocked.ch", "raw-noissues.ch", "raw-low.ch", "raw-err.ch", "raw-priv.ch", "raw-noco.ch"])
    assert.ok(!ids.includes(id), id);
  assert.equal(ids.length, 20);
  assert.equal(qualifiedPreDraft(s.src.registry.leads["nofinding.ch"]), false);
});

test("I/J: neue Leads – Top 2 korrekt, PARTIAL „≥N“, FULL genaue Zahl (TF-055 unverändert)", () => {
  const s = scenario((src) => {
    src.registry.leads["top-i.ch"] = regLead("top-i.ch", { customer_visible_findings: [FINDINGS[1], FINDINGS[2], FINDINGS[0]] });
    src.registry.leads["full-j.ch"] = regLead("full-j.ch");
  });
  const full = fullAuditEntry({ reachable: true, coverage: { links_found: 3, links_checked: 3, images_found: 2, images_checked: 2 }, issues: [
    { type: "broken_link", url: "https://full-j.ch/a", page: "https://full-j.ch/", reproducible: true, severity: "medium" },
    { type: "broken_link", url: "https://full-j.ch/b", page: "https://full-j.ch/", reproducible: true, severity: "medium" },
    { type: "contact_page_broken", url: "https://full-j.ch/kontakt", reproducible: true, severity: "high" },
    { type: "broken_image", url: "https://full-j.ch/x.jpg", page: "https://full-j.ch/", reproducible: true, severity: "medium" }] }, { domain: "full-j.ch", audited_at: "2026-10-14T09:00:00Z" });
  fs.writeFileSync(path.join(s.data, SITE_FINDINGS_FILE), JSON.stringify({ schema: 1, domains: { "full-j.ch": { full } } }));
  const by = byId(s.view());
  const t = by["top-i.ch"].errors;
  assert.equal(t.audit, "PARTIAL"); assert.equal(t.count, 3); assert.equal(t.exact, false); assert.equal(errorShort(by["top-i.ch"]), "≥3");
  assert.equal(t.top.length, 2); assert.equal(t.items.length, 3);
  assert.equal(t.top[0].category, "contact", "Kontaktproblem zuerst"); assert.equal(t.top[1].category, "contact", "E-Mail-Link = Kontaktweg");
  assert.equal(t.checked_at, "2026-10-13T08:00:00Z", "letzte Prüfung aus der Lead-Datenbank");
  const f = by["full-j.ch"].errors;
  assert.equal(f.audit, "FULL"); assert.equal(f.count, 4); assert.equal(f.exact, true); assert.equal(errorShort(by["full-j.ch"]), "4");
  assert.equal(f.top.length, 2); assert.equal(f.top[0].type, "contact_page_broken");
  assert.equal(cleanCrmLead(by["full-j.ch"]).errors.count, 4);
});

test("Zähler: qualifizierte Leads gesamt = Summe der Phasen; Entwürfe ≠ qualifizierte Leads", () => {
  const s = scenario((src) => {
    for (let i = 0; i < 5; i++) src.registry.leads[`q${i}.ch`] = regLead(`q${i}.ch`);
    for (let i = 0; i < 3; i++) src.registry.leads[`w${i}.ch`] = regLead(`w${i}.ch`, { status: "WAITING_FOR_DRAFT", gmail_draft_status: "queued" });
  });
  const v = s.view(), st = crmStats(v.leads, NOW);
  assert.equal(st.all, 28);
  const sum = Object.keys(PIPELINE_CARDS).reduce((a, k) => a + st[k], 0);
  assert.equal(sum, st.all, "jede Phase genau einmal gezählt");
  assert.equal(st.pipe_waiting, 3); assert.equal(st.pipe_no_draft, 5);
  assert.equal(st.pipe_contacted, 7, "7 manuell gesendet"); assert.equal(st.pipe_customer, 1);
  assert.equal(st.pipe_draft, 20 - 7 - 1, "Entwurf bereit = Entwürfe ohne Kontaktierte und Kunde (DNC ist eine Sperre, keine Phase)");
  assert.equal(st.with_draft, 20 - 7, "„Mit Draft“ bleibt die Zahl der Gmail-Entwürfe");
  assert.equal(filterLeads(v.leads, { card: "pipe_waiting" }).length, 3);
  assert.ok(DRAFT_STATUSES.includes("QUEUED"));
});

test("K/L: CRM-Sicht sendet nichts und verändert weder Entwürfe noch Quellen", () => {
  const s = scenario((src) => { src.registry.leads["qual-k.ch"] = regLead("qual-k.ch"); src.registry.leads["wait-k.ch"] = regLead("wait-k.ch", { status: "WAITING_FOR_DRAFT", gmail_draft_status: "queued" }); });
  const files = [path.join(s.mail, "gmail_jarvis.json"), path.join(s.mail, "mail_worker", "individual_reviews.json"), path.join(s.mail, "mail_worker", "lead_registry.json"), path.join(s.data, "lead_contact_directory.json")];
  const hash = () => files.map((f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"));
  const before = hash();
  const origFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error("kein Netz im Test"); };
  try {
    const v = s.view();
    for (const l of v.leads) buildCrmLead(l.lead_id, { ...s.sources(), crm: loadCrm(s.data) }, NOW);
    crmUniverse(s.sources());
  } finally { globalThis.fetch = origFetch; }
  assert.equal(calls, 0, "kein Netzwerkaufruf");
  assert.deepEqual(hash(), before, "Gmail-Register, Cold-Register, Lead-Datenbank, Verzeichnis unverändert");
  assert.equal(JSON.parse(fs.readFileSync(files[0], "utf8")).sent && Object.keys(JSON.parse(fs.readFileSync(files[0], "utf8")).sent).length, 7, "keine neuen Sends");
  const src = fs.readFileSync(new URL("../lead-crm.js", import.meta.url), "utf8");
  assert.ok(!/gmail\.js|drafts\.create|messages\.send|child_process/.test(src.replace(/\/\/.*$/gm, "")), "lead-crm.js hat keinen Sende-/Entwurfspfad");
});
