import assert from "node:assert/strict";
import test from "node:test";
import { buildSalesIntakePreview, salesIntakeEligibility, SALES_INTAKE_SUBJECT } from "../sales-intake.js";
import { addRequest } from "../mail-requests.js";

const now = new Date("2026-10-25T10:00:00.000Z");
const lead = {
  lead_id: "synthetic-024.ch", email: "kontakt@synthetic-024.ch", domain: "synthetic-024.ch", last_name: "Muster",
  errors: { items: [{ text: "Ein interner Link liefert einen 404-Fehler." }, { text: "Das Seitenbild enthält kein alternatives Textattribut." }, { text: "Die Startseite lädt mit einer blockierenden Ressource." }] },
  request: { basis: "requested_contact", request_source: "Telefonische Bitte um eine Offerte für Website-Reparatur", request_date: "2026-10-24", request_scope: "Website-Reparatur", request_evidence: "Telefonnotiz TF-JARVIS-024", response_scope: "Website-Reparatur", recipient_or_submission_channel: "kontakt@synthetic-024.ch", requestConfidence: "HIGH" },
};

test("TF-024: Erstmail-Vorschau enthält Betreff, genau drei gebundene Links und bestätigte Befunde", () => {
  const r = buildSalesIntakePreview({ lead, order150Id: "CA150-20261025-a1b2c3", order480Id: "RF480-20261025-d4e5f6", vaultLink: "https://synthetic.example/access.html#t=synthetic-token", now });
  assert.equal(r.ok, true);
  assert.equal(r.preview.subject, SALES_INTAKE_SUBJECT);
  assert.equal(Object.keys(r.preview.links).length, 3);
  assert.match(r.preview.body, /404-Fehler/);
  assert.doesNotMatch(r.preview.body, /\[[A-Z_]+\]/);
  assert.match(r.preview.links.payment150, /client_reference_id=CA150-20261025-a1b2c3/);
  assert.match(r.preview.links.payment480, /client_reference_id=RF480-20261025-d4e5f6/);
});

test("TF-024: fehlende Kontaktberechtigung, DNC und fehlende Befunde blockieren fail-closed", () => {
  assert.equal(salesIntakeEligibility({ ...lead, request: undefined }, { now }).code, "NO_CONTACT_PERMISSION");
  assert.equal(salesIntakeEligibility({ ...lead, do_not_contact: true }, { now }).code, "CONTACT_BLOCKED");
  assert.equal(salesIntakeEligibility({ ...lead, errors: { items: [] } }, { now }).code, "NO_CONFIRMED_FINDINGS");
});

test("TF-024: bestätigte Erstmail ist in der bestehenden Queue idempotent", () => {
  const meta = { actor_user_id: "mario", market: "CH", locale: "de-CH", lead_id: lead.lead_id, sales_intake: true, preview_ref: "a".repeat(64), order150_id: "CA150-20261025-a1b2c3", order480_id: "RF480-20261025-d4e5f6" };
  const input = { recipient: lead.email, subject: SALES_INTAKE_SUBJECT, body: "synthetic body", intent: "sales", delivery: "sales_intake" };
  const first = addRequest([], input, { now, requestedBy: "mario", meta });
  const second = addRequest(first.list, input, { now: new Date(+now + 1000), requestedBy: "mario", meta });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.duplicate, true);
  assert.equal(second.request.request_id, first.request.request_id);
});
