// Einmaliger interner E2E-Testmail-Vertrag (Praxis Kälin). Eigenes, abhängigkeitsfreies Modul: mail-worker.js wird auch vom Repair-Service
// importiert, und das Repair-Image darf mail-requests.js nicht enthalten (Test service-separation-047).
// Eng begrenzter einmaliger interner E2E-Test. Diese Bindung ist absichtlich im Mailpfad
// wiederholt und nicht nur in der CRM-Oberfläche hinterlegt: Empfänger, Betreff, Domain,
// Testkennzeichnung und beide Sandbox-Links dürfen nicht von einem allgemeinen Auftrag abweichen.
export const MANUAL_TEST_MAIL = Object.freeze({
  lead_id: "praxis-kaelin.netlify.app",
  recipient: "helvetic.webdesign@proton.me",
  subject: "[TEST] Technische Auffälligkeiten auf Ihrer Webseite – Praxis Kälin",
  check_link: "https://buy.stripe.com/test_dRm3cw5A5fo3caR9ov7Re00",
  repair_link: "https://buy.stripe.com/test_7sY00k5A54JpcaR1W37Re01",
});

export function isManualTestMail(input = {}) {
  if (!input || typeof input !== "object" || input.manual_test !== true || input.manual_test_lead_id !== MANUAL_TEST_MAIL.lead_id) return false;
  if (String(input.recipient || "").trim().toLowerCase() !== MANUAL_TEST_MAIL.recipient || input.subject !== MANUAL_TEST_MAIL.subject) return false;
  if (input.delivery !== undefined && input.delivery !== "send") return false;
  if (input.optional_thread_reference || input.draft_ref || input.meta) return false;
  const body = typeof input.body === "string" ? input.body : "";
  return body.includes(MANUAL_TEST_MAIL.lead_id) && body.includes("5 technische Fehler") && body.includes("CHF 150.–") && body.includes("CHF 480.–")
    && body.includes(MANUAL_TEST_MAIL.check_link) && body.includes(MANUAL_TEST_MAIL.repair_link)
    // The reviewed E2E copy labels each link as "Test-Zahlungslink"; keep that
    // explicit marker equivalent to the standalone uppercase TEST marker.
    && (/\bTEST\b/u.test(body) || body.includes("Test-Zahlungslink"));
}
