// Testdaten für das Lead-CRM (TF-053): synthetische Leads in der Form der echten Quellen (keine echten Daten).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const COLD = "COLD_LEAD_DRAFT_ONLY";
const hex = (i) => (0x18a0000000000000n + BigInt(i)).toString(16);
export function makeSources(n = 387, { now = new Date("2026-10-14T10:00:00Z") } = {}) {
  const t = now.toISOString();
  const registry = { schema: 1, leads: {} }, reviews = {}, gmail = { drafts: {}, sent: {}, sending: {} }, directory = { schema: 1, leads: {}, meta: { exports: {} } };
  for (let i = 0; i < n; i++) {
    const domain = `firma-${String(i).padStart(3, "0")}.ch`, id = domain, did = `r-${i}`;
    const manual = i < 7, customer = i === 10, dnc = i === 11;
    registry.leads[id] = { lead_id: id, domain, company: `Firma ${i} AG`, canton: i % 3 ? "BE" : "ZH", municipality: i % 3 ? "Bern" : "Zürich", category: "accountant", category_label: i % 2 ? "Treuhand" : "Restaurant",
      language: "de", status: manual ? "MANUALLY_SENT" : "DRAFT_CREATED", gmail_draft_status: manual ? "manually_sent" : "draft_created", customer_status: customer ? "customer" : "none",
      reply_status: "none", do_not_contact: dnc, opt_out: false, suppressed: false, manual_send_detected: manual, last_audited_at: "2026-10-10T08:00:00Z", last_updated_at: "2026-10-12T08:00:00Z",
      customer_visible_findings: ["Ein Link führt auf eine Fehlerseite"] };
    const findings = i % 4 === 0 ? [] : [{ key: i % 5 === 0 ? "contact" : `link:${domain}/x`, text: i % 5 === 0 ? "Der Link zu Ihrer Kontaktseite führt auf eine Fehlerseite" : "Auf der Seite «Team» führt der Link «Blog» auf eine Fehlerseite",
      internal_refs: [{ issue_type: i % 5 === 0 ? "contact_page_broken" : "broken_link", url: `https://${domain}/${i % 5 === 0 ? "kontakt" : "blog"}` }] }];
    if (i % 7 === 1) findings.push({ key: `image:https://${domain}/`, text: "Auf Ihrer Startseite wird ein Bild nicht angezeigt", internal_refs: [{ issue_type: "broken_image", url: `https://${domain}/img.jpg` }] });
    reviews[id] = { lead_id: id, company: `Firma ${i} AG`, domain, recipient: `info@${domain}`, draft_mode: COLD, gmail_draft_id: did, message_id: hex(i), status: manual ? "manually_sent" : "draft_created",
      manual_send_detected: manual, manual_send_at: manual ? "2026-10-11T09:00:00Z" : undefined, created_at: "2026-10-09T08:00:00Z", draft_created_at: "2026-10-09T08:00:00Z", updated_at: "2026-10-13T21:00:00Z",
      customer_findings: findings,
      issue_evidence: [{ issue_type: "broken_link", url: `https://${domain}/blog`, evidence: `HTTP 404 (verlinkt auf https://${domain}/team)`, observed_at: "2026-10-09T07:00:00Z", reproducible: true, severity: "medium" },
        ...(i % 9 === 2 ? [{ issue_type: "broken_mailto", url: "mailto:x", evidence: `ungültig (eingebunden auf https://${domain}/impressum)`, observed_at: "2026-10-09T07:00:00Z", reproducible: true, severity: "medium" }] : [])] };
    if (manual) gmail.sent[`m-${i}`] = { fromDraft: did, mode: COLD, leadId: id, sentAt: "2026-10-11T09:00:00Z", manual: true };
    else gmail.drafts[did] = { messageId: hex(i), mode: COLD, leadId: id, createdAt: "2026-10-09T08:00:00Z" };
    directory.leads[id] = { lead_id: id, company_name: `Firma ${i} AG`, domain, website_url: `https://www.${domain}/`, email: `info@${domain}`,
      phone: i % 5 ? "+41 31 123 45 67" : null, phone_normalized: i % 5 ? "+41311234567" : null, phone_confidence: i % 5 ? "high" : null,
      first_name: i % 4 === 0 ? "Anna" : null, last_name: i % 4 === 0 ? "Muster" : null, role: i % 4 === 0 ? "Inhaberin" : null,
      draft_status: manual ? "MANUALLY_SENT" : "DRAFT", gmail_draft_id: did, first_seen_at: "2026-10-14T08:00:00Z", last_seen_at: t, contact_enriched_at: "2026-10-14T09:00:00Z",
      enrichment: { status: i === 12 ? "failed" : "done", last_attempt_at: "2026-10-14T09:00:00Z" }, sources: [] };
  }
  return { registry, reviews, gmail, directory };
}
// Quellen als Dateien wie auf dem VPS: <mail>/mail_worker/{lead_registry,individual_reviews}.json, <mail>/gmail_jarvis.json, <data>/lead_contact_directory.json
export function writeSources(src, base = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-crm-"))) {
  const data = path.join(base, "data"), mail = path.join(base, "mail");
  fs.mkdirSync(path.join(mail, "mail_worker"), { recursive: true }); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(mail, "mail_worker", "lead_registry.json"), JSON.stringify(src.registry));
  fs.writeFileSync(path.join(mail, "mail_worker", "individual_reviews.json"), JSON.stringify({ reviews: src.reviews }));
  fs.writeFileSync(path.join(mail, "gmail_jarvis.json"), JSON.stringify(src.gmail));
  fs.writeFileSync(path.join(data, "lead_contact_directory.json"), JSON.stringify(src.directory));
  return { base, data, mail };
}
export const bump = (file, mutate) => { const j = JSON.parse(fs.readFileSync(file, "utf8")); mutate(j); fs.writeFileSync(file, JSON.stringify(j)); const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t); };
