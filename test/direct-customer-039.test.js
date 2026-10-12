// DIRECT CUSTOMER ORDER INTAKE (TF-039): Echte Direktkunden (Formular/Direktanfrage/Empfehlung/Kontakt) brauchen KEINEN
// Discovery-Lead mehr. `sales.js direct-sale` ist der bewusste CLI-Weg von Chris (= betriebliche Bestätigung) – nie wird
// allein aus einem Domainnamen oder einer Anfrage ein bezahlter Auftrag. Direktkunden erhalten NIE erfundene Discovery-,
// Cold-Outreach- oder Versandgrundlagen-Historie; die Lead-Datenbank wird nur über das bestehende reconcile ergänzt.
// CHF-150-Aufträge: --create-confirmed (Direktverkauf + Auftrag) und --cancel (CANCELLED: terminal, kein Fehler, nie offen).
// Cold-Outreach, CHF-480 und Gmail bleiben unverändert. Ohne Netz; Gmail/Auditor sind Attrappen. 0 Sends, 0 Website-Writes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, legalBasis } from "../mail-worker.js";
import { OFFERS, recordDirectSale, recordSale, lifecycleStatus, DIRECT_CUSTOMER_SOURCE } from "../sales.js";
import { reconcileRegistry, loadRegistry, registryBlock, knownKeys } from "../lead-registry.js";
import { publicLead, contactBlockReason } from "../lead-db.js";
import {
  CHECK150_ORDERS_FILE, CHECK150_CANCELLED, createCheck150Order, cancelCheck150Order, completeCheck150,
  createCheck150Engine, check150Status, publicCheck150Orders, confirmedCheck150Sale,
} from "../check-150-workflow.js";
import { cleanCheck150 } from "../server-control.js";
import { recordPayment } from "../payments.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-12T12:00:00Z");
let dir, store;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-dc-")); store = createStore(dir); });

const issue = (type, severity) => ({ type, url: "https://bestehend.ch/", evidence: `Beleg für ${type}`, severity, detectedAt: T0.toISOString() });
const jarvisLead = () => ({ domain: "bestehend.ch", website: "https://bestehend.ch/", company: "Bestehend AG", email: "info@bestehend.ch",
  status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true, websiteIssues: [issue("broken_link", "medium")] });
const directSale = (over = {}) => recordDirectSale({}, { domain: "neuerkunde.ch", offer: "REPAIR_CHECK_150",
  delivery_email: "kunde@neuerkunde.ch", company: "Neuer Kunde AG", contact_name: "Herr Kunde", now: T0, ...over });

function fakeGmail() {
  const calls = [];
  return { calls,
    createDraft: async (x) => { calls.push({ op: "create", to: x.to }); return { draftId: "dr1", threadId: "t1", messageId: "m1" }; },
    updateDraft: async (id) => { calls.push({ op: "update", id }); return { draftId: id }; },
    // TF-041: nach erfüllter Zahlungsschwelle sendet der CHF-150-Workflow die Service-Mail automatisch über sendDraft.
    sendDraft: async (id) => { calls.push({ op: "SEND", id }); return { messageId: "sent-" + id }; } };
}
function fakeAuditor() {
  const calls = [];
  return { calls, audit: async (website) => { calls.push(website); return { website, host: "neuerkunde.ch", reachable: true, finalUrl: website,
    title: "Neuer Kunde AG", issues: [{ type: "broken_link", severity: "medium", url: "https://neuerkunde.ch/alt", page: "https://neuerkunde.ch/",
      label: "Team", evidence: "HTTP 404 (verlinkt auf https://neuerkunde.ch/)", detectedAt: T0.toISOString() }], pages: {}, requests: 1 }; } };
}

// A) Unbekannte Domain + ALTER Befehl `sales.js sale` → weiterhin sauberer Fehler (kein stiller Kunde aus dem Nichts).
test("A: sales.js sale mit unbekannter Domain bleibt ein Fehler", () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-dc-sec-"));
  fs.mkdirSync(path.join(secrets, "mail_worker"), { recursive: true });
  const r = (() => { try {
    execFileSync(process.execPath, ["sales.js", "sale", "voellig-unbekannt.ch", "REPAIR_CHECK_150"], { cwd: ROOT, env: { ...process.env, JARVIS_SECRETS_DIR: secrets }, encoding: "utf8", stdio: "pipe" });
    return { code: 0, stderr: "" };
  } catch (e) { return { code: e.status, stderr: String(e.stderr) }; } })();
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /nicht gefunden/);
  assert.ok(!fs.existsSync(path.join(secrets, "mail_worker", "sales.json")), "kein Verkauf angelegt");
});

// B+D) Unbekannte Domain + direct-sale → Customer + Sale (CHF 150 aus OFFERS); Registry nur über bestehendes reconcile.
test("B/D: direct-sale legt neuen Direktkunden mit korrektem Verkauf an", () => {
  const records = directSale();
  const rec = records["neuerkunde.ch"];
  assert.equal(rec.status, "customer");
  assert.deepEqual([rec.sale.selected_offer, rec.sale.sale_value, rec.sale.currency, rec.sale.customer_status, rec.sale.work_status],
    ["REPAIR_CHECK_150", OFFERS.REPAIR_CHECK_150.price, "CHF", "customer", "open"]);
  assert.equal(rec.sale.sale_value, 150);
  assert.equal(rec.sale.sale_date, "2026-10-12");
  assert.deepEqual(rec.sale.evidence, [], "keine erfundene Audit-Evidence ohne Audit");
  assert.deepEqual({ ...rec.direct_sale, created_at: null, updated_at: null }, {
    source: DIRECT_CUSTOMER_SOURCE, basis: "manual_confirmed_order", confirmed_by: "chris_cli",
    domain: "neuerkunde.ch", website: "https://neuerkunde.ch/", company: "Neuer Kunde AG",
    delivery_email: "kunde@neuerkunde.ch", contact_name: "Herr Kunde", created_at: null, updated_at: null });
  assert.ok(rec.direct_sale.created_at && rec.direct_sale.updated_at);
  // CHF 480 als Direktverkauf funktioniert ebenfalls – Wert immer aus OFFERS.
  assert.equal(directSale({ offer: "REPAIR_FIX_500" })["neuerkunde.ch"].sale.sale_value, 480);
  // Registry entsteht über die BESTEHENDE reconcile-Logik aus sales.json – keine Parallel-Schreiblogik.
  store.write("sales.json", { records });
  reconcileRegistry(store, { now: T0, force: true });
  const lead = loadRegistry(store).leads["neuerkunde.ch"];
  assert.equal(lead.status, "CUSTOMER");
  assert.equal(lead.customer_status, "customer");
  assert.deepEqual([lead.company, lead.business_email, lead.contact_name, lead.website, lead.discovery_source],
    ["Neuer Kunde AG", "kunde@neuerkunde.ch", "Herr Kunde", "https://neuerkunde.ch/", "direct_customer"]);
});

// C) Bestehender Lead + direct-sale → kein Duplikat, bestehender Datensatz wird Kunde, echte Evidence bleibt.
test("C: direct-sale auf bestehendem Lead dupliziert nichts", () => {
  store.write("discovered.json", { leads: { "bestehend.ch": jarvisLead() } });
  reconcileRegistry(store, { now: T0, full: true, force: true });
  assert.equal(knownKeys(store).total, 1);
  const before = loadRegistry(store).leads["bestehend.ch"];
  assert.notEqual(before.status, "CUSTOMER");
  const records = recordDirectSale({}, { domain: "bestehend.ch", offer: "REPAIR_FIX_500", delivery_email: "auftrag@bestehend.ch", lead: jarvisLead(), now: T0 });
  assert.equal(records["bestehend.ch"].sale.evidence.length, 1, "echte Audit-Evidence des bestehenden Leads");
  assert.equal(records["bestehend.ch"].direct_sale.company, "Bestehend AG", "Stammdaten aus dem bestehenden Lead übernommen");
  store.write("sales.json", { records });
  reconcileRegistry(store, { now: T0, force: true });
  assert.equal(knownKeys(store).total, 1, "kein Duplikat");
  const lead = loadRegistry(store).leads["bestehend.ch"];
  assert.equal(lead.status, "CUSTOMER");
  assert.equal(lead.customer_status, "customer");
  assert.equal(lead.company, "Bestehend AG", "bestehende Stammdaten bleiben führend");
  assert.ok(lead.alt_emails.includes("auftrag@bestehend.ch") || lead.business_email === "auftrag@bestehend.ch", "Lieferadresse gemerkt, nichts verloren");
});

// E+F) Falsches Angebot und ungültige E-Mail werden blockiert – fail closed.
test("E/F: direct-sale blockiert falsches Offer und ungültige E-Mail", () => {
  for (const bad of ["REDESIGN_2490", "NONE", "", undefined, "repair_check_150"])
    assert.throws(() => directSale({ offer: bad }), /Erlaubt sind nur/);
  for (const bad of ["", "foo", "a@b", "info@firma", "kunde@", "@firma.ch", undefined])
    assert.throws(() => directSale({ delivery_email: bad }), /Kunden-E-Mail/);
  for (const bad of ["", "nur-text-ohne-punkt", undefined])
    assert.throws(() => directSale({ domain: bad }), /Domain/);
});

// G) Direkter CHF-150-Kunde → check-150-workflow wird über die bestehende Order-Logik bestätigt; VERKAUF != ZAHLUNG (TF-041):
// erst die verbuchte Zahlung (CHF 75) startet Check/Bericht und den automatischen Versand der Service-Mail.
test("G: Direktverkauf bestätigt den CHF-150-Auftrag (create-confirmed-Pfad), Zahlung startet die Erfüllung", async () => {
  store.write("sales.json", { records: directSale() });
  assert.ok(confirmedCheck150Sale(store, "neuerkunde.ch"), "Verkauf = Bestätigung (bestehende Order-Logik)");
  const o = createCheck150Order(store, { domain: "neuerkunde.ch", website: "https://neuerkunde.ch/", company: "Neuer Kunde AG", delivery_email: "kunde@neuerkunde.ch", contact_name: "Herr Kunde", now: T0 });
  const gmail = fakeGmail(), auditor = fakeAuditor();
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll();
  let saved = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(saved.state, "BLOCKED_PAYMENT_NOT_RECEIVED", "bestätigter Auftrag ohne Zahlung wartet");
  assert.ok(saved.confirmed, "über erfassten Verkauf bestätigt");
  assert.equal(auditor.calls.length, 0, "kein Audit vor der Zahlungsschwelle");
  recordPayment(store, { order_id: o.order_id, amount_chf: 75, now: T0 });
  await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll();
  saved = store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id];
  assert.equal(saved.state, "COMPLETED");
  assert.equal(saved.delivery_status, "sent");
  assert.deepEqual(gmail.calls.map((c) => c.op), ["create", "SEND"], "genau ein Lieferentwurf + genau ein automatischer Versand");
  assert.equal(gmail.calls[0].to, "kunde@neuerkunde.ch");
  // Dashboard-Quelle: Direktkunde (nie technische Interna).
  assert.equal(publicCheck150Orders(dir).orders[0].source, "direct_customer");
});

// H) Cold-Lead-Regeln unverändert: direct-sale ändert nie eine Versandgrundlage und schützt den Kunden vor Cold-Outreach.
test("H: Cold-Regeln unverändert; Direktkunde wird nie wieder Cold-Lead", () => {
  const cold = jarvisLead();
  const frozen = structuredClone(cold);
  recordDirectSale({}, { domain: "bestehend.ch", offer: "REPAIR_CHECK_150", delivery_email: "auftrag@bestehend.ch", lead: cold, now: T0 });
  assert.deepEqual(cold, frozen, "direct-sale verändert den Lead nie");
  assert.equal(legalBasis(cold, T0), null, "keine Versandgrundlage erfunden");
  assert.equal(lifecycleStatus(cold, { now: T0 }), "blocked_no_legal_basis", "Cold-Lead bleibt blockiert");
  store.write("sales.json", { records: directSale() });
  reconcileRegistry(store, { now: T0, force: true });
  assert.equal(registryBlock(store, { domain: "neuerkunde.ch" }), "bestehender Kunde", "nie wieder ein neuer Cold-Entwurf für den Kunden");
  // Kein Mechanismus im neuen Code, der Versandgrundlagen oder Gmail-Versand anfasst.
  const src = fs.readFileSync(path.join(ROOT, "sales.js"), "utf8");
  assert.doesNotMatch(src, /sendDraft|createDraft|updateDraft|replyToThread/);
  assert.doesNotMatch(src, /consentBasis\s*[:=]\s*["']|obtainedBeforeMarketingSend\s*[:=]\s*true/);
});

// I) Direct Customer bekommt KEINE erfundene Cold-Outreach-Historie.
test("I: keine erfundene Outreach-Historie beim Direktkunden", () => {
  store.write("sales.json", { records: directSale() });
  reconcileRegistry(store, { now: T0, force: true });
  const lead = loadRegistry(store).leads["neuerkunde.ch"];
  assert.equal(lead.manual_send_detected, false);
  assert.equal(lead.first_contacted_at ?? null, null);
  assert.equal(lead.last_contacted_at ?? null, null);
  assert.equal(lead.gmail_draft_status, "none");
  assert.equal(lead.reply_status, "none", "Kunde hat nie auf Outreach geantwortet – nichts wird behauptet");
  assert.ok(!lead.history.some((h) => ["MANUALLY_SENT", "DRAFT_CREATED", "WAITING_FOR_DRAFT", "REPLIED"].includes(h.status)));
  assert.equal(contactBlockReason(lead), "bestehender Kunde");
  const pub = publicLead(lead);
  assert.equal(pub.discovery_source, "Direktkunde");
  assert.equal(pub.status, "CUSTOMER");
  // Keine erfundenen Audit-/Legal-Felder im Verkaufs-Datensatz.
  const raw = JSON.stringify(store.read("sales.json", {}));
  for (const verboten of ["consentBasis", "opt_in", "existingCustomer", "discoverySource", "outreach", "cold_"]) assert.ok(!raw.includes(verboten), verboten);
});

// J) --cancel: offener Testauftrag → CANCELLED (dokumentiert, bleibt gespeichert); abgeschlossen/storniert nie stornierbar.
test("J: cancelCheck150Order storniert nur nicht abgeschlossene Aufträge", async () => {
  const o = createCheck150Order(store, { domain: "testfirma.ch", delivery_email: "test@testfirma.ch", company: "Testfirma AG", now: T0 });
  const c = cancelCheck150Order(store, o.order_id, { reason: "Versehentlich angelegter Testauftrag", now: T0 });
  assert.equal(c.state, CHECK150_CANCELLED);
  assert.equal(c.cancel_reason, "Versehentlich angelegter Testauftrag");
  assert.ok(c.cancelled_at);
  assert.ok(c.state_history.at(-1).to === "CANCELLED" && /storniert/i.test(c.state_history.at(-1).reason));
  assert.ok(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id], "Auftrag bleibt aus Nachvollziehbarkeit gespeichert");
  assert.throws(() => cancelCheck150Order(store, o.order_id, { now: T0 }), /bereits storniert/);
  assert.throws(() => completeCheck150(store, o.order_id, { now: T0 }), /READY_FOR_DELIVERY/);
  assert.throws(() => cancelCheck150Order(store, "CA150-99999999-ffffff", { now: T0 }), /nicht gefunden/);
  // Abgeschlossene Aufträge sind tabu (mit Zahlung läuft der Auftrag bis COMPLETED inkl. automatischem Versand, TF-041).
  store.write("sales.json", { records: directSale({ domain: "fertig.ch", delivery_email: "k@fertig.ch" }) });
  const done = createCheck150Order(store, { domain: "fertig.ch", delivery_email: "k@fertig.ch", now: T0 });
  recordPayment(store, { order_id: done.order_id, amount_chf: 75, now: T0 });
  await createCheck150Engine({ store, gmail: fakeGmail(), auditor: fakeAuditor(), now: () => T0 }).processAll();
  assert.equal(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[done.order_id].state, "COMPLETED");
  assert.throws(() => cancelCheck150Order(store, done.order_id, { now: T0 }), /Abgeschlossene/);
});

// K) CANCELLED wird vom Worker nie verarbeitet – selbst mit erfasstem Verkauf kein Audit, kein Entwurf, keine Gmail-Aktion.
test("K: Worker überspringt stornierte Aufträge vollständig", async () => {
  store.write("sales.json", { records: directSale() });
  const o = createCheck150Order(store, { domain: "neuerkunde.ch", delivery_email: "kunde@neuerkunde.ch", now: T0 });
  cancelCheck150Order(store, o.order_id, { now: T0 });
  const gmail = fakeGmail(), auditor = fakeAuditor();
  const r = await createCheck150Engine({ store, gmail, auditor, now: () => T0 }).processAll();
  assert.equal(r.processed, 0);
  assert.equal(auditor.calls.length, 0, "kein Audit nach Stornierung");
  assert.equal(gmail.calls.length, 0, "keine Gmail-Aktion nach Stornierung (0 Sends, 0 Drafts)");
  assert.equal(store.read(CHECK150_ORDERS_FILE, { orders: {} }).orders[o.order_id].state, "CANCELLED");
  // Nach Stornierung darf für dieselbe Domain ein neuer, echter Auftrag entstehen.
  assert.ok(createCheck150Order(store, { domain: "neuerkunde.ch", delivery_email: "kunde@neuerkunde.ch", now: T0 }).order_id);
});

// L) Dashboard: CANCELLED zählt nie als offen, erscheint nicht als Fehler; Quelle nur als Direktkunde/Jarvis Lead.
test("L: Status/Allowlist/Dashboard behandeln CANCELLED neutral", () => {
  const o = createCheck150Order(store, { domain: "testfirma.ch", delivery_email: "test@testfirma.ch", now: T0 });
  cancelCheck150Order(store, o.order_id, { now: T0 });
  const st = check150Status(dir);
  assert.equal(st.open, 0, "CANCELLED ist nie offen");
  assert.equal(st.cancelled, 1);
  assert.equal(st.states.CANCELLED, 1);
  const pub = publicCheck150Orders(dir);
  assert.equal(pub.orders[0].state, "CANCELLED");
  assert.equal(pub.orders[0].source, "jarvis_lead", "ohne Direktverkauf gilt der Auftrag als Jarvis Lead");
  const cleaned = cleanCheck150(pub);
  assert.equal(cleaned.orders[0].state, "CANCELLED", "Whitelist kennt CANCELLED");
  assert.equal(cleaned.orders[0].source, "jarvis_lead");
  assert.equal(cleaned.cancelled, 1);
  assert.ok(!JSON.stringify(cleaned).includes("test@testfirma.ch"));
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.ok(html.includes("STORNIERT") && html.includes('id="c150Cancelled"'), "HUD zeigt Storniert-Zähler");
  assert.ok(html.includes('o.state === "CANCELLED" ? ""'), "CANCELLED wird nicht als Fehler (rot) dargestellt");
  assert.ok(html.includes("Direktkunde") && html.includes("Jarvis Lead"), "Quelle als Wort, keine technischen Interna");
});

// M+N) 0 Mail-Sends und 0 Website-Writes im gesamten neuen Pfad (Quelle + Laufzeit bereits oben geprüft).
test("M/N: neue Pfade kennen weder Versand noch Website-Schreiboperationen", () => {
  for (const f of ["sales.js", "lead-registry.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const verboten of ["applyFix", "deployProduction", "rollback(", "repair-adapters", "netlify.com", "api.github.com"]) assert.ok(!src.includes(verboten), `${f} enthält "${verboten}"`);
  }
  // sendDraft ist seit TF-041 der bewusst erlaubte automatische Versand der Service-Mail NACH erfüllter Zahlungsschwelle –
  // Website-Schreibpfade bleiben für den CHF-150-Workflow weiterhin verboten.
  const c150 = fs.readFileSync(path.join(ROOT, "check-150-workflow.js"), "utf8");
  for (const verboten of ["applyFix", "deployProduction", "repair-adapters", "netlify.com", "api.github.com"]) assert.ok(!c150.includes(verboten), `check-150-workflow.js enthält "${verboten}"`);
});
