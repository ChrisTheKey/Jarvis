// TF-JARVIS-020 – lokaler UI-Prüfstand für manuelle/Playwright-MCP-Browsertests. Startet dasselbe Gerüst wie die Browser-Tests
// (test/crm-browser-harness.js): statische public/-Dateien, echte /api/crm-, /api/auth-, /api/sales-, /api/calling-, /api/mail-requests-Handler
// im RAM, echter CRM-Dienst im Temp-Verzeichnis mit SYNTHETISCHEN Leads (firma-NNN.ch) + zwei synthetischen Aufträgen (CHF 150 / CHF 480).
// Kein Netz nach aussen, keine echten Kunden, keine Secrets (Passwörter sind feste Testwerte des Gerüsts). Läuft, bis Ctrl+C.
//   node scripts/tf020-ui-harness.mjs        → gibt URL + Test-Logins aus
import { startServer } from "../test/crm-browser-harness.js";
import { vnLeads, PW } from "../test/tf063-helpers.js";
import { cleanRepair, cleanCheck150 } from "../server-control.js";

// Synthetischer Auftrag CHF 480 (bezahlt, im Onboarding) + CHF 150 (bestätigt, unbezahlt) – gleiche Form wie test/onboarding-browser-066.test.js.
const onboarding = { kind: "FIX", market: "CH", locale: "de-CH", state: "WAITING_FOR_ACCESS", awaiting: "customer", payment_gate: "met", access: "link_sent", content: "none",
  brief_status: "NO_CONTENT_CHANGES", open_items: 0, reminders: 0, last_customer_reply_at: null, last_jarvis_reply_at: null, manual_reason: null };
const snapshot = {
  repair: cleanRepair({ orders: [{ order_id: "RF480-20261021-bbbbbb", domain: "firma-010.ch", market: "CH", currency: "CHF", offer_class: "REPAIR_FIX_500", price_chf: 480,
    paid_chf: 480, payment_required_chf: 480, payment_status: "PAID_FULL", payment_ok: true, state: "ACCESS_REQUESTED", onboarding }] }),
  check150: cleanCheck150({ orders: [{ order_id: "CA150-20261021-aaaaaa", domain: "firma-001.ch", market: "CH", currency: "CHF", price_chf: 150, paid_chf: 0,
    payment_required_chf: 150, payment_status: "UNPAID", state: "ORDER_CONFIRMED" }] }),
};
const srv = await startServer({ n: 40, vnLeads: vnLeads(6), sellers: { Kudoshin: PW.Kudoshin }, snapshot });
console.log(JSON.stringify({ url: srv.url, owner: { username: "chris", password: srv.password }, seller: { username: "Kudoshin", password: PW.Kudoshin } }));
process.on("SIGINT", () => { srv.close(); process.exit(0); });
