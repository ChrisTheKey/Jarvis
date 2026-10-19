// TF-080 – E2E-Testläufe (Kontaktformular → CRM → Auftrag → Stripe-TESTzahlung → sicherer Zugang → Reparatur) im echten System, aber isoliert.
//
// Ein Testlauf ist NUR dann ein aktiver E2E-Lauf, wenn ALLES zutrifft (sonst bleibt die Test-Einsendung sichtbar als TEST, läuft aber nicht weiter):
//   - Einsendung wird als Eigentümer-Test erkannt (contact-form.js isTestSubmission – unverändert, das Wort «test» allein genügt nie)
//   - JARVIS_E2E_TEST_ENABLED=true (Server-Konfiguration, Mail-Worker UND Repair-Service)
//   - Kundenadresse ∈ JARVIS_E2E_TEST_MAILBOXES (Test-Postfach des Eigentümers, keine fremden Empfänger)
//   - «Ihre Website» ∈ JARVIS_E2E_TEST_DOMAINS (Sandbox-Allowlist – ohne Wert keine Test-Reparatur, nie eine Kundenwebsite)
// Test-Aufträge (test_order: true, environment TEST) zahlen nur im Stripe-TESTmodus, erzeugen nie Umsatz, Provision, Verkäufer-Kennzahlen, Anrufe oder
// Cold-Outreach und werden vor JEDEM Zugangs-/Reparaturschritt erneut gegen die Allowlist geprüft (repair-workflow.js).
//
//   node e2e-test.js status               Konfiguration (nur JA/NEIN + Anzahl, nie Werte)
//   node e2e-test.js list                 Testläufe dieses Containers (Mail: Einsendungen, Repair: Aufträge/Testzahlungen)
//   node e2e-test.js cleanup <test_run_id> Testlauf archivieren (nur Datensätze mit is_test/test_order UND genau dieser ID; nie Platzhalter)
// Nichts wird gelöscht: Einsendungen → archived_test (aus dem CRM), offene Test-Aufträge → CANCELLED (Tresor zerstört), Testzahlungen bleiben
// als is_test im Zahlungsbuch (zählen nie zu Summen). Echte Leads, Zahlungen, Aufträge, Mails und Zugangsdaten werden nie berührt.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_RUN_ID_RE = /^e2e-[0-9a-f]{12}$/;
export const TEST_LEAD_PREFIX = "test-cf-";
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const list = (v) => String(v || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean);
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

// Konfiguration – nur aus der Server-Umgebung, nie aus Kundendaten. Ungültige Einträge fallen weg (fail closed).
export function e2eConfig(env = process.env) {
  const get = typeof env === "function" ? env : (k) => env?.[k];
  const domains = new Set(list(get("JARVIS_E2E_TEST_DOMAINS")).filter((d) => DOMAIN_RE.test(d)));
  const mailboxes = new Set(list(get("JARVIS_E2E_TEST_MAILBOXES")).filter((e) => EMAIL_RE.test(e)));
  const enabled = String(get("JARVIS_E2E_TEST_ENABLED") || "").trim().toLowerCase() === "true";
  return Object.freeze({ enabled, domains, mailboxes, ready: enabled && domains.size > 0 && mailboxes.size > 0 });
}
export const e2eStatus = (cfg = e2eConfig()) => ({ e2e_test_mode: cfg.ready ? "READY" : "NOT_READY", enabled: cfg.enabled, domains: cfg.domains.size, mailboxes: cfg.mailboxes.size });
export const isE2eDomain = (cfg, domain) => !!cfg?.enabled && cfg.domains.has(String(domain || "").toLowerCase().replace(/^www\./, ""));
export const isE2eMailbox = (cfg, email) => !!cfg?.enabled && cfg.mailboxes.has(String(email || "").trim().toLowerCase());
// Stabile, sichere Kennungen aus der Einsendungs-Kennung (Hash) – nie aus Name/Adresse.
export const testRunId = (key) => `e2e-${sha(`run|${key}`).slice(0, 12)}`;
export const testLeadId = (key) => `${TEST_LEAD_PREFIX}${sha(`lead|${key}`).slice(0, 16)}`;
export const isTestLeadId = (id) => String(id || "").startsWith(TEST_LEAD_PREFIX);

// ---------- Kommandozeile (nur Chris, im jeweiligen Container) ----------
// Ohne Top-Level-await: mail-worker.js → contact-form.js importiert dieses Modul (Zyklus) – die CLI läuft erst nach der Modul-Auswertung.
// NODE_TEST_CONTEXT: «node --test» erkennt *-test.js als Testdatei und startet sie – dann keine CLI (kein Befehl, kein Exit 1).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) (async () => {
  const [cmd, arg] = process.argv.slice(2);
  const { WORKER_DIR, createStore } = await import("./mail-worker.js");
  const store = createStore(WORKER_DIR);
  const cf = await import("./contact-form.js");
  const forms = cf.loadContactForms(store);
  const orders = store.read("repair_orders.json", { orders: {} }).orders || {};
  const payments = Object.values(store.read("payments.json", { payments: {} }).payments || {});
  try {
    if (cmd === "status") console.log(JSON.stringify(e2eStatus(), null, 2));
    else if (cmd === "list") {
      const runs = {};
      for (const it of Object.values(forms.items)) if (it.is_test === true) {
        const id = it.test_run_id || testRunId(it.key);
        runs[id] = { ...(runs[id] || {}), test_run_id: id, submission: { received_at: it.received_at, state: it.state, e2e_run: it.e2e_run === true, historical: !it.test_run_id, archived: it.archived_test === true, journey: it.journey?.state || null, workflow: it.journey?.workflow || null } };
      }
      for (const o of Object.values(orders)) if (o.test_order === true && TEST_RUN_ID_RE.test(String(o.test_run_id || ""))) {
        runs[o.test_run_id] = { ...(runs[o.test_run_id] || {}), test_run_id: o.test_run_id, order: { order_id: o.order_id, state: o.state, test_payments: payments.filter((p) => p.order_id === o.order_id && p.is_test === true).length } };
      }
      console.log(JSON.stringify(Object.values(runs), null, 2));
    } else if (cmd === "cleanup") {
      if (!TEST_RUN_ID_RE.test(String(arg || ""))) throw new Error("Genau eine test_run_id (e2e-<12 hex>) angeben – keine Platzhalter, keine Liste.");
      let items = 0, cancelled = 0;
      for (const it of Object.values(forms.items)) {
        if (it.is_test !== true || (it.test_run_id || testRunId(it.key)) !== arg || it.archived_test === true) continue;
        it.archived_test = true; it.archived_test_at = new Date().toISOString();
        if (it.journey && !["HANDED_OFF", "CUSTOMER_STOP_REQUESTED"].includes(it.journey.state)) it.journey.state = "CUSTOMER_STOP_REQUESTED"; // nie weiterführen
        items++;
      }
      if (items) { store.write(cf.CONTACT_FORMS_FILE, forms); store.write(cf.CONTACT_FORMS_PUBLIC_FILE, cf.publicContactForms(forms)); }
      const rw = Object.values(orders).some((o) => o.test_order === true && o.test_run_id === arg) ? await import("./repair-workflow.js") : null;
      for (const o of Object.values(orders)) {
        if (o.test_order !== true || o.test_run_id !== arg || rw.COMPLETED_STATES.includes(o.state) || o.state === rw.REPAIR_CANCELLED) continue;
        rw.cancelRepairOrder(store, o.order_id, { reason: `E2E-Testlauf ${arg} bereinigt` }); cancelled++;
      }
      console.log(JSON.stringify({ test_run_id: arg, submissions_archived: items, test_orders_cancelled: cancelled }));
    } else { console.log("Befehle: status | list | cleanup <test_run_id>"); process.exit(1); }
  } catch (e) { console.error("Fehler: " + e.message); process.exit(1); }
})();
