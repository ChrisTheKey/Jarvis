// TF-JARVIS-020 – synthetischer End-to-End-Regressionstest der ganzen Kette mit den ECHTEN Modulen (keine Nachbauten):
// Discovery-Lead → Domain-Normalisierung/Dedupe → Website-Audit (gemockter fetchFn) → Fehlernachweis → CRM → Kontaktberechtigung (TF-024) →
// Cold-Entwurf (nur lokal, nie Gmail) → Kontaktstatus → Anruf protokollieren (CH-Outbound gesperrt) → Angebot CHF 150/480 → Stripe-TESTzahlung
// (signierter Webhook mit Test-Secret) → Auftrag → Status → Dashboard-Sicht.
// Alles in Temp-Verzeichnissen, synthetische Domain, kein Netz, keine Mail, kein Anruf, keine echte Zahlung, keine Secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore, legalBasis } from "../mail-worker.js";
import { recordLead, fromDiscovered, loadRegistry } from "../lead-registry.js";
import { normDomain } from "../lead-db.js";
import { createAuditor } from "../site-auditor.js";
import { auditOne, readSiteFindings } from "../site-backfill.js";
import { createSourceReader, loadCrm, applyRequest } from "../crm-service.js";
import { buildCrmView } from "../lead-crm.js";
import { contactBasis, ensureColdDraft, qualifyRepairLead, COLD_DRAFTS_FILE } from "../swiss-repair.js";
import { eligibility } from "../calling-core.js";
import { offerInfo } from "../pricing.js";
import { createContactFormRepairOrder, cancelRepairOrder, repairOrdersStatus, publicRepairOrders } from "../repair-workflow.js";
import { paymentGateForOrder, paymentsForOrder } from "../payments.js";
import { memoryStore } from "../shared-state.js";
import { createPaymentsHandler } from "../payments-api.js";
import { signStripePayload } from "../stripe-payments.js";
import { syncStripePayments } from "../stripe-webhook.js";
import { cleanRepair } from "../server-control.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const DOMAIN = "jarvis-e2e-firma.ch", HOME = `https://${DOMAIN}/`;
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
// Nur Fixture-Werte im Format der Stripe-Testsecrets – keine echten Schlüssel.
const WH = { STRIPE_WEBHOOK_SECRET: "whsec_fixtLive", STRIPE_TEST_WEBHOOK_SECRET: "whsec_fixtTest", JARVIS_MAIL_WORKER_TOKEN: "w".repeat(43) };
const rid = () => crypto.randomUUID();

// Synthetische Website: Startseite verlinkt /kontakt (ok), /team (HTTP 404) und ein Bild (ok).
const PAGE = `<html lang="de"><head><title>E2E Firma AG</title><meta name="viewport" content="width=device-width"><meta name="description" content="d"></head><body>
  <a href="/kontakt">Kontakt</a><a href="/team">Unser Team</a><img src="/logo.png" alt="Logo"></body></html>`;
function site() {
  const reqs = [];
  const fetchFn = async (url, init = {}) => {
    reqs.push([init.method || "GET", url]);
    const u = new URL(url);
    if (u.hostname !== DOMAIN) throw new Error(`externer Aufruf im Test: ${url}`);
    const body = u.pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : u.pathname === "/" ? PAGE : "<html><body>ok</body></html>";
    return new Response(body, { status: u.pathname === "/team" ? 404 : 200, headers: { "content-type": u.pathname.endsWith(".png") ? "image/png" : "text/html" } });
  };
  return { reqs, auditor: createAuditor({ fetchFn, delayMs: 0, sleep: async () => {}, maxLinks: 80, maxImages: 25 }) };
}
// Discovery-Ergebnis wie aus lead-finder.js (Status blocked_no_legal_basis = qualifizierter Cold Lead ohne Versandgrundlage).
const discovered = (over = {}) => ({
  email: `info@${DOMAIN}`, company: "E2E Firma AG", website: HOME, domain: DOMAIN, uid: "CHE-123.456.789", approved: false, consentBasis: null,
  status: "blocked_no_legal_basis", auditedAt: NOW.toISOString(), reachable: true, title: "E2E Firma AG – Treuhand", discoverySource: "OpenStreetMap node/1 (Bern, office)",
  contact_source: "impressum", source_url: `${HOME}impressum`, collected_at: NOW.toISOString(), contact_confidence: "medium", canton: "BE",
  websiteIssues: [{ type: "broken_link", url: `${HOME}team`, page: HOME, evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity: "medium", detectedAt: NOW.toISOString(), label: "Unser Team" }],
  ...over,
});

// Stripe-TEST-Webhooks über den echten /api/payments-Handler (Signaturprüfung) + Inbox → Buchung im Worker-Verzeichnis.
function stripe(dir) {
  const mem = {};
  const handler = createPaymentsHandler({ env: (k) => WH[k], getStore: async (k) => (mem[k] ||= memoryStore()), now: () => NOW });
  const req = (body, headers) => new Request("https://jarvis.test/api/payments", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const inbox = { pull: async () => (await (await handler(req(JSON.stringify({ op: "inbox.pull" }), { "x-jarvis-worker": WH.JARVIS_MAIL_WORKER_TOKEN }))).json()).events,
    ack: async (keys) => handler(req(JSON.stringify({ op: "inbox.ack", keys }), { "x-jarvis-worker": WH.JARVIS_MAIL_WORKER_TOKEN })) };
  let n = 0;
  return {
    async hook(evt, { secret = WH.STRIPE_TEST_WEBHOOK_SECRET } = {}) {
      const raw = JSON.stringify(evt);
      const r = await handler(req(raw, { "stripe-signature": signStripePayload(raw, secret, Math.floor(+NOW / 1000)) }));
      return r.status;
    },
    sync: () => syncStripePayments({ dir, inbox, env: {}, now: NOW, eventsOnly: true }),
    event({ ref, amount, evt = null }) {
      n++;
      return { id: evt || `evt_e2e${String(n).padStart(4, "0")}`, object: "event", type: "checkout.session.completed", livemode: false, created: Math.floor(+NOW / 1000),
        data: { object: { id: `cs_test_e2eFixture${String(n).padStart(4, "0")}`, object: "checkout.session", livemode: false, status: "complete", payment_status: "paid",
          amount_total: amount, currency: "chf", payment_intent: `pi_e2e${String(n).padStart(6, "0")}`, client_reference_id: ref, payment_link: "plink_1E2eFixture01", metadata: {},
          customer_details: { email: "e2e@helvetic-test.ch" } } } };
    },
  };
}

test("TF-020 E2E: Lead → Audit → Nachweis → CRM → Berechtigung → Entwurf → Kontakt → Anruf → Angebot → Sandbox-Zahlung → Auftrag → Status → Dashboard", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf020-"));
  const mailDir = path.join(base, "mail"), dataDir = path.join(base, "data"), repairDir = path.join(base, "repair-export"), orderDir = path.join(base, "repair");
  for (const d of [path.join(mailDir, "mail_worker"), dataDir, repairDir, orderDir]) fs.mkdirSync(d, { recursive: true });
  const store = createStore(path.join(mailDir, "mail_worker"));
  try {
    // 1) Test-Lead erfassen – Domain normalisiert, Dedupe über Domain/Website-Schreibweise/Adresse: genau EIN Datensatz.
    assert.equal(normDomain("HTTPS://WWW.Jarvis-E2E-Firma.ch/kontakt?x=1"), DOMAIN);
    recordLead(store, fromDiscovered(discovered()), { now: NOW, source: "discovery" });
    recordLead(store, fromDiscovered(discovered({ website: "https://www.jarvis-e2e-firma.ch/", title: "neu" })), { now: NOW, source: "discovery" });
    recordLead(store, { business_email: `INFO@${DOMAIN.toUpperCase()}` }, { now: NOW, source: "replies" });
    let reg = loadRegistry(store);
    assert.deepEqual(Object.keys(reg.leads), [DOMAIN], "eindeutige Lead-ID = normalisierte Domain, keine Duplikate");
    assert.equal(reg.leads[DOMAIN].qualified, true);

    // 2) Test-Website analysieren (nur GET, nur die synthetische Domain) + 3) Fehlernachweis speichern.
    const { reqs, auditor } = site();
    const a1 = await auditOne({ dataDir, candidate: { domain: DOMAIN, website: HOME }, auditor, now: () => NOW });
    assert.equal(a1.outcome, "complete");
    assert.ok(reqs.length > 0 && reqs.every(([m]) => m === "GET"), "Audit nur lesend (GET)");
    const sf = readSiteFindings(dataDir).domains[DOMAIN];
    assert.equal(sf.full.complete, true);
    const ev = sf.full.findings.find((f) => f.type === "broken_link");
    assert.ok(ev, "kaputter Link als Befund gespeichert");
    assert.equal(ev.http_status, 404, "Nachweis: beobachteter HTTP-Status");
    assert.match(ev.page, /jarvis-e2e-firma\.ch/); assert.equal(ev.verified_at, NOW.toISOString());
    // Idempotent: erneuter Audit erzeugt keine doppelten Befunde.
    await auditOne({ dataDir, candidate: { domain: DOMAIN, website: HOME }, auditor, now: () => NOW });
    assert.equal(readSiteFindings(dataDir).domains[DOMAIN].full.findings.length, sf.full.findings.length);

    // 4) CRM-Eintrag – genau einer, Website-Zustand FULL mit verifiziertem Fehler; zweite Sicht identisch (keine Doppel-Einträge).
    const sources = createSourceReader({ dataDir, mailDir, repairDir });
    const view = () => buildCrmView({ ...sources(), crm: loadCrm(dataDir, NOW) }, NOW);
    const v1 = view(), v2 = view();
    assert.equal(v1.leads.filter((l) => l.lead_id === DOMAIN).length, 1);
    assert.equal(v1.total, v2.total);
    const crmLead = v1.leads.find((l) => l.lead_id === DOMAIN);
    assert.equal(crmLead.errors.audit, "FULL"); assert.ok(crmLead.errors.count >= 1);

    // 5) Kontaktberechtigung (TF-024): keine Rechtsgrundlage → nie Auto-Send. Ein gesetztes approved-Flag ohne Nachweis ändert nichts.
    assert.equal(legalBasis(discovered(), NOW), null);
    assert.equal(legalBasis(discovered({ approved: true }), NOW), null, "approved ohne Einwilligungs-/Kundennachweis ist keine Grundlage");
    const cb = contactBasis(discovered(), { candidate: true, now: NOW });
    assert.equal(cb.contact_basis, "COLD_LEAD_DRAFT_ONLY");
    assert.equal(cb.automatic_send_allowed, false); assert.equal(cb.legal_basis, "NONE");
    assert.equal(contactBasis(discovered(), { candidate: true, now: NOW, suppressed: true }).draft_creation_eligible, false, "Opt-out/Suppression → nicht einmal ein Entwurf");

    // 6) Test-E-Mail-Entwurf – nur lokal (queued), fest DRAFT_ONLY; zweiter Versuch = Duplikat-Sperre; Suppression blockiert.
    const draft = ensureColdDraft(store, discovered(), { sender: SENDER, now: NOW, contacted: new Set() });
    assert.equal(draft.status, "queued"); assert.equal(draft.gmail_draft_id, null, "kein Gmail-Aufruf im Test");
    assert.equal(draft.message_class, "DRAFT_ONLY"); assert.equal(draft.automatic_send_allowed, false); assert.equal(draft.manual_send_decision_required, true);
    assert.match(draft.body, /team/i, "Entwurf nennt den belegten Befund");
    assert.match(ensureColdDraft(store, discovered(), { sender: SENDER, now: NOW, contacted: new Set() }).blocked, /offener Entwurf/);
    assert.equal(Object.keys(store.read(COLD_DRAFTS_FILE, { reviews: {} }).reviews).length, 1);
    assert.equal(ensureColdDraft(createStore(fs.mkdtempSync(path.join(base, "s-"))), discovered(), { sender: SENDER, now: NOW, contacted: new Set(), suppression: { [`info@${DOMAIN}`]: true } }).blocked, "suppression");

    // 7) Simulierten Kontaktstatus speichern (idempotent über request_id).
    const write = (action, params, request_id = rid()) => applyRequest({ dataDir, sources, req: { request_id, action, params }, now: NOW });
    const csId = rid();
    const cs = write("crm.updateContactStatus", { lead_id: DOMAIN, contact_status: "EMAIL_SENT" }, csId);
    assert.equal(cs.ok, true); assert.equal(cs.lead.contact_status, "EMAIL_SENT");
    assert.equal(write("crm.updateContactStatus", { lead_id: DOMAIN, contact_status: "EMAIL_SENT" }, csId).duplicate, true);
    assert.equal(write("crm.updateStage", { lead_id: DOMAIN, stage: "SEND_NOW" }).ok, false, "keine Aktion ausserhalb der Allowlist");

    // 8) Telefonanruf: Outbound-Agent für CH gesperrt (Rechtsfreigabe fehlt) → nur manuell dokumentierter Anruf.
    const leadNow = view().leads.find((l) => l.lead_id === DOMAIN);
    assert.equal(eligibility(leadNow, { now: NOW }).code, "CH_CALLING_DISABLED");
    assert.equal(eligibility({ ...leadNow, do_not_contact: true }, { now: NOW }).decision, "BLOCKED");
    const call = write("crm.addCall", { lead_id: DOMAIN, result: "NO_ANSWER", at: NOW.toISOString(), note: "TF-020 synthetischer Testanruf (nicht gewählt)" });
    assert.equal(call.ok, true); assert.equal(call.lead.call_status, "NO_ANSWER");
    assert.equal(write("crm.addCall", { lead_id: DOMAIN, result: "NO_ANSWER", at: "2099-01-01T00:00:00Z" }).ok, false, "kein Anruf in der Zukunft");

    // 9) Angebot: genau die zwei Festpreise in CHF; der Lead bekommt ein bekanntes Angebot.
    const q = qualifyRepairLead(discovered(), { now: NOW });
    assert.ok(["REPAIR_CHECK_150", "REPAIR_FIX_500"].includes(q.offer.offer_class));
    assert.deepEqual([offerInfo("REPAIR_CHECK_150").price, offerInfo("REPAIR_CHECK_150").currency], [150, "CHF"]);
    assert.deepEqual([offerInfo("REPAIR_FIX_500").price, offerInfo("REPAIR_FIX_500").currency], [480, "CHF"]);

    // 11) Auftrag erstellen – als TEST-Auftrag (Sandbox-Lauf), zugeordnet zum Lead.
    const orders = createStore(orderDir);
    const order = createContactFormRepairOrder(orders, { domain: DOMAIN, website: HOME, company: "E2E Firma AG", delivery_email: "e2e@helvetic-test.ch", lead_id: DOMAIN,
      contact_form_key: "cf:" + "e".repeat(24), confirmed_at: NOW.toISOString(), test: { run_id: "e2e-0123456789ab" }, now: NOW });
    assert.equal(order.test_order, true); assert.equal(order.domain, DOMAIN); assert.equal(order.offer_class, "REPAIR_FIX_500");
    assert.equal(paymentGateForOrder(orders, order).satisfied, false);

    // 10) Sandbox-Zahlung: falsche Signatur → abgelehnt; falscher Betrag → Prüfung, nichts verbucht; korrekt → genau eine Buchung; Wiederholung idempotent.
    const s = stripe(orderDir);
    assert.notEqual(await s.hook(s.event({ ref: order.order_id, amount: 48000 }), { secret: "whsec_falsch" }), 200, "Signaturprüfung");
    assert.equal(await s.hook(s.event({ ref: order.order_id, amount: 100 })), 200);
    const bad = await s.sync(); assert.equal(bad.booked, 0); assert.equal(bad.reviews, 1);
    const good = s.event({ ref: order.order_id, amount: 48000 });
    assert.equal(await s.hook(good), 200);
    assert.equal((await s.sync()).booked, 1);
    assert.equal(await s.hook(good), 200);
    assert.equal((await s.sync()).booked, 0, "gleiches Ereignis nie doppelt gebucht");
    const pays = paymentsForOrder(orders, order.order_id);
    assert.equal(pays.length, 1); assert.equal(pays[0].amount, 480); assert.equal(pays[0].currency, "CHF");
    assert.equal(pays[0].provider_mode, "TEST"); assert.equal(pays[0].is_test, true);
    assert.equal(paymentGateForOrder(orders, order).satisfied, true, "Zahlung → Auftrag → Kunde (Domain des Leads)");

    // 12) Auftragsstatus aktualisieren (Testlauf abschliessen = stornieren, nichts gelöscht).
    const done = cancelRepairOrder(orders, order.order_id, { reason: "TF-020 E2E-Testlauf beendet", now: NOW });
    assert.equal(done.state, "CANCELLED");
    assert.equal(paymentsForOrder(orders, order.order_id).length, 1, "Zahlungsbuch bleibt erhalten");

    // 13) Dashboard: Auftrag sichtbar (bereinigt), TEST zählt nie als offener Live-Auftrag; keine Kundenadresse/Referenz in der Sicht.
    const pub = cleanRepair(publicRepairOrders(orderDir)); // gleicher Weg wie Mail-Worker-Snapshot → Server Control
    const row = pub.orders.find((o) => o.domain === DOMAIN);
    assert.ok(row, "Auftrag im Dashboard"); assert.equal(row.state, "CANCELLED");
    assert.ok(!JSON.stringify(pub).includes("e2e@helvetic-test.ch"), "keine Kunden-E-Mail im Dashboard");
    assert.equal(repairOrdersStatus(orderDir).open_live, 0);
    const final = view().leads.find((l) => l.lead_id === DOMAIN);
    assert.equal(final.contact_status, "CALLED", "dokumentierter Anruf führt den Kontaktstatus nach"); assert.equal(final.call_status, "NO_ANSWER"); assert.ok(final.errors.count >= 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
