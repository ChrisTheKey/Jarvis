// Jarvis Repair-Service (TF-047) – eigener Container jarvis-repair-worker, getrennt vom 24/7-Mail-Worker.
// Übernimmt ausschliesslich die Kundenaufträge: CHF-480 Check & Reparatur (repair-workflow.js: Freigabe-/Zahlungs-Gates, sicherer
// Zugang/Tresor, Profile Builder, Host-Key, Adapter, Backups, Browser-Gate mit Chromium, Bericht) und CHF-150 Check & Anleitung
// (check-150-workflow.js). Eigener Zustand (JARVIS_SECRETS_DIR, z. B. /data/repair → /data/repair/mail_worker), eigene Locks, eigener
// Healthcheck, eigener Deploy (deploy/vps/deploy-repair.sh) – ein Neustart/Update hier berührt den Mail-Worker nie.
//
// KEINE Sender Authority: kein Gmail-Zugang, kein Cloud-Mail-Claim, kein Heartbeat als Mail-Worker. Service-Mails
// (CUSTOMER_ACCESS_REQUEST / CUSTOMER_ORDER_FULFILLMENT) gehen ausschliesslich über die Repair-Outbox (repair-outbox.js) an den
// Mail-Worker, der sie genau einmal sendet. Liegen Gmail-Secrets oder der Anthropic-Key in diesem Container, startet er nicht.
//
//   node repair-service.js               Service-Schleife (Lock gegen Doppelstart)
//   node repair-service.js --once        genau ein Durchlauf
//   node repair-service.js --healthcheck Exit 0, wenn der Service sich in den letzten 5 Minuten gemeldet hat (Docker)
//   node repair-service.js --status      Zähler: Aufträge + Outbox (nie Adressen/Inhalte)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createLogger, acquireLock, heartbeat, releaseLock, backupPublicKey, zurichDay } from "./mail-worker.js";
import { createOutboxMailer, outboxStatus } from "./repair-outbox.js";
import { onboardingDirOf } from "./onboarding-store.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SECRETS = process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets");
export const SERVICE_LOCK = "repair-service.lock";
export const OUTBOX_DIR = process.env.JARVIS_REPAIR_OUTBOX || path.join(SECRETS, "repair_outbox");
export const SERVICE_ROLE = "repair";
// TF-055: Export-Verzeichnis für repair_findings.json (CRM mountet es read-only). Ohne Variable kein Export.
export const CRM_EXPORT_DIR = process.env.JARVIS_REPAIR_CRM_EXPORT || null;
// Was in diesem Container nie liegen darf – sonst könnte er zur zweiten Sender Authority werden.
export const FORBIDDEN_FILES = Object.freeze(["gmail_token.json", "gmail_credentials.json", "gmail_jarvis.json"]);
export const FORBIDDEN_ENV = Object.freeze(["ANTHROPIC_API_KEY", "JARVIS_SERVER_CONTROL_TOKEN"]);
// TF-066: Kunden-Onboarding-Dialog (Notschalter JARVIS_ONBOARDING=off → Verhalten wie vor TF-066).
export const onboardingEnabled = (env = process.env) => env.JARVIS_ONBOARDING !== "off";
export const pollMs = (env = process.env) => Math.max(30, Number(env.JARVIS_REPAIR_POLL_SECONDS) || 120) * 1000;

// Isolation (fail closed): nur Namen, nie Werte.
export function isolationViolations({ secretsDir = SECRETS, env = process.env } = {}) {
  const v = [];
  for (const f of FORBIDDEN_FILES) if (fs.existsSync(path.join(secretsDir, f))) v.push(`Datei ${f} im Repair-Service`);
  for (const k of FORBIDDEN_ENV) if (env[k]) v.push(`Variable ${k} im Repair-Service`);
  if (env.JARVIS_WORKER_ROLE && env.JARVIS_WORKER_ROLE !== SERVICE_ROLE) v.push("JARVIS_WORKER_ROLE ist nicht «repair»");
  return v;
}

export function serviceHealthy(dir = WORKER_DIR, now = Date.now(), maxAgeMs = 5 * 60_000) {
  try { const l = JSON.parse(fs.readFileSync(path.join(dir, SERVICE_LOCK), "utf8")); return now - (l.beat || 0) < maxAgeMs; } catch { return false; }
}

// Ein Durchlauf: CHF-480 und CHF-150 mit der Outbox als einzigem Versandweg. Fehler eines Workflows stoppen den anderen nie.
export async function repairServiceIteration({ dir = WORKER_DIR, outboxDir = OUTBOX_DIR, crmExportDir = CRM_EXPORT_DIR, intake = null, orderIntake = null, log = () => {}, runRepair = null, runCheck150 = null,
  onboarding = false, stripe = null, e2e = undefined } = {}) {
  // TF-080: e2e (e2e-test.js e2eConfig) – Standard aus der Umgebung; Tests übergeben ihn ausdrücklich.
  const e2eOpt = e2e ? { e2e } : {};
  const mailer = createOutboxMailer({ dir: outboxDir });
  const onboardingDir = onboarding ? onboardingDirOf(outboxDir) : null;
  const out = {};
  // TF-064: bestätigte VN-Aufträge (Kudoshin/Chris über /api/sales) übernehmen – vor den Workflows, Fehler stoppen den Service nie.
  if (orderIntake) {
    try { out.vn_orders = await (await import("./order-intake.js")).syncOrderIntake({ dir, client: orderIntake, log }); }
    catch (e) { out.vn_orders = { error: true }; log("error", "vn_order_intake_failed", { error: String(e.message).slice(0, 160) }); }
  }
  // TF-079: ausdrücklich bestätigte «Check & Reparatur»-Aufträge aus dem Kontaktformular-Thread anlegen/binden – vor den Workflows.
  if (onboardingDir) {
    try { out.contact_form_orders = (await import("./onboarding-repair.js")).applyContactFormOrders({ dir, onboardingDir, log, ...e2eOpt }); }
    catch (e) { out.contact_form_orders = { error: true }; log("error", "contact_form_orders_failed", { error: String(e.message).slice(0, 160) }); }
  }
  // TF-080: Stripe-Anzahlung (Checkout anlegen, signierte Ereignisse/Abgleich prüfen, payments.js verbuchen) – VOR den Workflows, damit das
  // CHF-240-Gate im selben Lauf öffnet. Ohne Schlüssel: NOT_CONFIGURED (nichts vorgetäuscht). Fehler stoppen den Service nie.
  if (onboardingDir && stripe) {
    try { out.stripe = await (await import("./stripe-webhook.js")).syncStripePayments({ dir, onboardingDir, log, ...e2eOpt, ...stripe }); if (out.stripe.booked || out.stripe.created) log("info", "stripe_sync", out.stripe); }
    catch (e) { out.stripe = { error: true }; log("error", "stripe_sync_failed", { error: String(e.message).slice(0, 160) }); }
  }
  runRepair ||= (await import("./repair-workflow.js")).runRepairOrders;
  runCheck150 ||= (await import("./check-150-workflow.js")).runCheck150Orders;
  try { out.repair = await runRepair({ dir, gmail: mailer, intake, log, onboardingDir, ...e2eOpt }); if (out.repair?.advanced) log("info", "repair_orders_processed", out.repair); }
  catch (e) { out.repair = { error: true }; log("error", "repair_orders_failed", { error: e.message }); }
  try { out.check150 = await runCheck150({ dir, gmail: mailer, log, onboarding: !!onboardingDir }); if (out.check150?.advanced) log("info", "check150_orders_processed", out.check150); }
  catch (e) { out.check150 = { error: true }; log("error", "check150_orders_failed", { error: e.message }); }
  // TF-055: Stand nach Reparaturen fürs CRM (behoben = RESOLVED, manuelle Punkte bleiben). Fehler stoppen den Service nie.
  if (crmExportDir) {
    try { out.crm_export = (await import("./repair-workflow.js")).writeRepairFindingsExport({ dir, exportDir: crmExportDir }); if (out.crm_export.written) log("info", "repair_crm_export", out.crm_export); }
    catch (e) { out.crm_export = { error: true }; log("error", "repair_crm_export_failed", { error: e.message }); }
  }
  // TF-066: Auftragsfakten für den Onboarding-Dialog im Mail-Worker (nur Allowlist, nie Secrets). Fehler stoppen den Service nie.
  if (onboardingDir) {
    try { out.onboarding = (await import("./onboarding-repair.js")).writeOnboardingOrders({ dir, onboardingDir }); }
    catch (e) { out.onboarding = { error: true }; log("error", "onboarding_export_failed", { error: String(e.message).slice(0, 160) }); }
  }
  out.outbox = outboxStatus(outboxDir);
  return out;
}

export async function serviceStatus({ dir = WORKER_DIR, outboxDir = OUTBOX_DIR } = {}) {
  const { repairOrdersStatus } = await import("./repair-workflow.js");
  const { check150Status } = await import("./check-150-workflow.js");
  const { stripeServiceStatus } = await import("./stripe-webhook.js");
  const { e2eStatus } = await import("./e2e-test.js");
  return { role: SERVICE_ROLE, healthy: serviceHealthy(dir), commit: process.env.JARVIS_COMMIT || null, repair: repairOrdersStatus(dir), check150: check150Status(dir), outbox: outboxStatus(outboxDir),
    stripe: stripeServiceStatus({ dir }), e2e: e2eStatus() };
}
// TF-080: Stripe-Abhängigkeiten des Produktivbetriebs (Inbox /api/payments mit Worker-Token, Rückkehr-Adresse = Netlify-Site). Nie Werte loggen.
async function stripeDeps() {
  const { paymentsInboxClient } = await import("./stripe-webhook.js");
  const { syncConfig } = await import("./local-state.js");
  const inbox = paymentsInboxClient({ config: syncConfig() });
  return { inbox, origin: (String(process.env.JARVIS_WEB_ORIGIN || "").split(",")[0].trim() || inbox?.origin || "").replace(/\/+$/, "") || null };
}

// Lokales, verschlüsseltes State-Backup des Repair-Zustands (kein Offsite-Upload: der Offsite-Schlüssel je Tag gehört dem Mail-Worker).
async function backupLocal({ dir, log, first = false }) {
  const pem = backupPublicKey();
  if (!pem) return;
  const backup = await import("./backup.js");
  if (first && !backup.backupInfo(dir)) await backup.backupNow({ secretsDir: SECRETS, workerDir: dir, publicKeyPem: pem, zurichDay, log });
  else await backup.dailyBackup({ secretsDir: SECRETS, workerDir: dir, publicKeyPem: pem, zurichDay, log });
}

async function loop() {
  const dir = WORKER_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = createLogger(dir);
  const bad = isolationViolations();
  if (bad.length) { log("error", "repair_service_isolation_refused", { reasons: bad }); console.error("Repair-Service verweigert den Start:\n  - " + bad.join("\n  - ")); return 2; }
  if (!acquireLock(dir, { name: SERVICE_LOCK })) { log("info", "repair_service_already_running"); console.log("Repair-Service läuft bereits."); return 3; }
  let stop = false, wake = () => {};
  process.on("exit", () => releaseLock(dir, process.pid, SERVICE_LOCK));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop = true; wake(); });
  const nap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
  setInterval(() => heartbeat(dir, process.pid, SERVICE_LOCK), 60_000).unref();
  const { intakeClient } = await import("./access-intake.js");
  const { orderIntakeClient } = await import("./order-intake.js");
  const { syncConfig } = await import("./local-state.js");
  log("info", "repair_service_started", { pid: process.pid, commit: process.env.JARVIS_COMMIT || null, outbox: outboxStatus(OUTBOX_DIR).exists });
  try { await backupLocal({ dir, log, first: true }); } catch (e) { log("error", "state_backup_failed", { error: e.message }); }
  while (!stop) {
    heartbeat(dir, process.pid, SERVICE_LOCK);
    await repairServiceIteration({ dir, intake: intakeClient({ config: syncConfig() }), orderIntake: orderIntakeClient({ config: syncConfig() }), log, onboarding: onboardingEnabled(), stripe: await stripeDeps() });
    try { await backupLocal({ dir, log }); } catch (e) { log("error", "state_backup_failed", { error: e.message }); }
    if (!stop) await nap(pollMs());
  }
  log("info", "repair_service_stopped", { pid: process.pid });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  process.on("uncaughtException", (e) => { createLogger(WORKER_DIR)("error", "crash", { error: e.stack || e.message }); process.exit(1); });
  process.on("unhandledRejection", (e) => { createLogger(WORKER_DIR)("error", "crash", { error: String(e?.stack || e) }); process.exit(1); });
  const run = {
    "--healthcheck": async () => (serviceHealthy() ? 0 : 1),
    "--status": async () => { console.log(JSON.stringify(await serviceStatus(), null, 2)); return 0; },
    "--once": async () => {
      const bad = isolationViolations();
      if (bad.length) { console.error("Repair-Service verweigert den Lauf:\n  - " + bad.join("\n  - ")); return 2; }
      const { intakeClient } = await import("./access-intake.js");
      const { orderIntakeClient } = await import("./order-intake.js");
      const { syncConfig } = await import("./local-state.js");
      console.log(JSON.stringify(await repairServiceIteration({ intake: intakeClient({ config: syncConfig() }), orderIntake: orderIntakeClient({ config: syncConfig() }), log: createLogger(WORKER_DIR), onboarding: onboardingEnabled(), stripe: await stripeDeps() }), null, 2));
      return 0;
    },
  }[arg] || loop;
  run().then((code) => process.exit(code ?? 0));
}
