// CHECK & REPARATUR CHF 480 — AUTOPILOT (035): persistenter Reparatur-Workflow. Ohne dokumentierte Kundenfreigabe wird NIE etwas
// verändert (nur passiver Audit); Cold-Outreach ist nie eine Freigabe; ohne Zugang/Stack/Backup wird blockiert (fail closed);
// Regression → Rollback; Zustand überlebt einen Neustart. Keine Mail, kein Netzwerk – Auditor und Adapter sind Attrappen.
// Seit TF-041 gilt zusätzlich die Zahlungsschwelle (CHF 240) VOR jedem Zugang – die Fixtures hier verbuchen sie (pay);
// die Gate-Fälle selbst stehen in payments-041.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { OFFERS } from "../sales.js";
import {
  ORDER_STATES, BLOCKED_STATES, REPAIR_ORDERS_FILE, REPAIR_OFFER, AUTHORIZATION_SOURCES,
  createRepairOrder, authorizeRepair, completeOrder, createRepairEngine, detectStack, fullSiteAudit,
  buildCustomerReport, repairOrdersStatus, isProtectedChange, normDomain,
} from "../repair-workflow.js";
import { CUSTOMER_JARGON_RE } from "../swiss-repair.js";
import { recordPayment } from "../payments.js";

const T0 = new Date("2026-10-11T08:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-repair-"));
const HOME = "https://muster.ch/";

// Audit-Attrappe: liefert vorgegebene Befunde je Ziel-URL (vorher/nachher unterscheidbar).
const rawIssue = (type, severity, url, extra = {}) => ({ type, url, page: HOME, evidence: `HTTP 404 (verlinkt auf ${HOME})`, severity, detectedAt: T0.toISOString(), ...extra });
const BROKEN_LINK = rawIssue("broken_link", "medium", "https://muster.ch/team-alt", { label: "Unser Team" });
const BROKEN_IMAGE = rawIssue("broken_image", "medium", "https://muster.ch/img/team.jpg", { evidence: `Bild liefert HTTP 404 (eingebunden auf ${HOME})` });
const IMPRESSUM_LINK = rawIssue("broken_link", "medium", "https://muster.ch/impressum-alt", { page: "https://muster.ch/impressum" });
function fakeAuditor(byUrl) {
  const calls = [];
  return {
    calls,
    audit: async (website) => {
      calls.push(website);
      const entry = byUrl[website] ?? byUrl["*"] ?? { issues: [] };
      return { website, host: "muster.ch", reachable: entry.reachable !== false, finalUrl: website, title: "Muster AG",
        issues: entry.issues || [], pages: { home: entry.html ?? "<html><head><meta name=viewport content=x></head><body>statisch</body></html>" }, requests: 3 };
    },
  };
}

// Adapter-Attrappe (statischer Stack) – zeichnet alle Aufrufe auf.
function fakeAdapter(over = {}) {
  const calls = { checkAccess: 0, backup: 0, locate: 0, applyFix: 0, validate: 0, deployProduction: 0, rollback: 0 };
  return {
    calls,
    checkAccess: async () => { calls.checkAccess++; return { ok: true, connector: "test-connector", token: "GEHEIM-DARF-NIE-GESPEICHERT-WERDEN" }; },
    backup: async (order, { branch }) => { calls.backup++; return { production_ref: "deploy-42", backup_ref: "backup-1", rollback_point: "deploy-42", branch }; },
    locate: async (issue) => { calls.locate++; return { target: "index.html", cause: `Verweis auf ${issue.url} zeigt ins Leere`, planned_change: "Linkziel korrigieren" }; },
    applyFix: async () => { calls.applyFix++; return { ok: true, change_ref: "commit-abc" }; },
    ...over,
  };
}

const newOrder = (store) => createRepairOrder(store, { domain: "muster.ch", website: HOME, company: "Muster AG", now: T0 });
const authorize = (store, id) => authorizeRepair(store, id, { authorized_domain: "muster.ch", source: "customer_reply_email", reference: "Antwort vom 2026-10-11", now: T0 });
// Zahlungsschwelle CHF 240 (TF-041) erfüllen – die Gate-Fälle selbst testet payments-041.test.js.
const pay = (store, id) => recordPayment(store, { order_id: id, amount_chf: 240, now: T0 });
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];

test("Zustandsmodell entspricht der Vorgabe", () => {
  assert.deepEqual(ORDER_STATES, ["ORDER_RECEIVED", "AUTHORIZATION_REQUIRED", "PAYMENT_REQUIRED", "ACCESS_CHECK", "ACCESS_REQUESTED",
    "BACKUP", "FULL_AUDIT", "REPAIR_PLAN", "REPAIRING", "VALIDATION", "RETEST", "READY_FOR_DELIVERY", "COMPLETED"]);
  assert.deepEqual(BLOCKED_STATES, ["BLOCKED_NO_ACCESS", "BLOCKED_NO_AUTHORIZATION", "BLOCKED_UNSUPPORTED_STACK", "REPAIR_FAILED", "VALIDATION_FAILED", "MANUAL_REVIEW_REQUIRED", "PAYMENT_REVIEW_REQUIRED", "BLOCKED_UNSAFE_ACCESS"]);
});

test("Auftrag: REPAIR_FIX_500, CHF 480 aus OFFERS, persistiert; nur ein offener Auftrag je Domain", () => {
  const store = createStore(tmp());
  const o = newOrder(store);
  assert.equal(o.offer_class, REPAIR_OFFER);
  assert.equal(o.price_chf, OFFERS.REPAIR_FIX_500.price);
  assert.equal(o.price_chf, 480);
  assert.equal(o.state, "ORDER_RECEIVED");
  assert.equal(o.customer_authorized_repair, false);
  assert.equal(readOrder(store, o.order_id).order_id, o.order_id);
  assert.throws(() => newOrder(store), /läuft bereits/);
});

test("Ohne Freigabe: nur passiver Audit, Status AUTHORIZATION_REQUIRED, kein Adapter-Aufruf", async () => {
  const store = createStore(tmp());
  const o = newOrder(store);
  const adapter = fakeAdapter();
  const engine = createRepairEngine({ store, adapters: { static: adapter }, auditor: fakeAuditor({ "*": { issues: [BROKEN_LINK] } }), now: () => T0 });
  await engine.processAll();
  const saved = readOrder(store, o.order_id);
  assert.equal(saved.state, "AUTHORIZATION_REQUIRED");
  assert.ok(saved.audit_preview);
  assert.equal(Object.keys(saved.audit_preview.issues).length, 1);
  assert.deepEqual(adapter.calls, { checkAccess: 0, backup: 0, locate: 0, applyFix: 0, validate: 0, deployProduction: 0, rollback: 0 });
  // Zweiter Lauf bleibt wartend – es wird nicht erneut auditiert und weiterhin nichts verändert.
  await engine.processAll();
  assert.equal(readOrder(store, o.order_id).state, "AUTHORIZATION_REQUIRED");
  assert.equal(adapter.calls.applyFix, 0);
});

test("Cold-Outreach ist NIE eine Freigabe; Domain muss exakt übereinstimmen; Quellen sind Whitelist", () => {
  const store = createStore(tmp());
  const o = newOrder(store);
  assert.throws(() => authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "cold_outreach" }), /NIE eine Reparaturfreigabe/);
  assert.throws(() => authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "irgendwas" }), /Unbekannte Freigabequelle/);
  assert.throws(() => authorizeRepair(store, o.order_id, { authorized_domain: "andere-firma.ch", source: "customer_reply_email" }), /stimmt nicht mit dem Auftrag/);
  assert.equal(readOrder(store, o.order_id).customer_authorized_repair, false);
  assert.ok(AUTHORIZATION_SOURCES.every((s) => !["cold_outreach", "cold_mail"].includes(s)));
  const ok = authorize(store, o.order_id); pay(store, o.order_id);
  assert.equal(ok.customer_authorized_repair, true);
  assert.equal(ok.state, "ACCESS_CHECK");
});

test("Unbekannter Stack → BLOCKED_UNSUPPORTED_STACK; bekannter Stack ohne Adapter → BLOCKED_NO_ACCESS", async () => {
  // other
  let store = createStore(tmp());
  let o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  await createRepairEngine({ store, adapters: {}, auditor: fakeAuditor({ "*": { issues: [], html: "" } }), now: () => T0 }).processAll();
  assert.equal(readOrder(store, o.order_id).state, "BLOCKED_UNSUPPORTED_STACK");
  // wordpress erkannt, aber kein Adapter/Zugang konfiguriert
  store = createStore(tmp());
  o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  await createRepairEngine({ store, adapters: {}, auditor: fakeAuditor({ "*": { issues: [], html: "<html><link href=/wp-content/a.css></html>" } }), now: () => T0 }).processAll();
  const saved = readOrder(store, o.order_id);
  assert.equal(saved.state, "BLOCKED_NO_ACCESS");
  assert.equal(saved.stack.type, "wordpress");
  assert.match(saved.blocked_reason, /nie erraten/);
});

test("Adapter-Antworten werden nie mit Secrets gespeichert (nur connector/ok/checked_at)", async () => {
  const store = createStore(tmp());
  const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  await createRepairEngine({ store, adapters: { static: fakeAdapter() }, auditor: fakeAuditor({ "*": { issues: [] } }), now: () => T0 }).processAll();
  const saved = readOrder(store, o.order_id);
  assert.deepEqual(Object.keys(saved.access).sort(), ["checked_at", "connector", "ok"]);
  assert.ok(!JSON.stringify(saved).includes("GEHEIM-DARF-NIE-GESPEICHERT-WERDEN"));
});

test("Backup unvollständig (kein Rollback-Punkt) → MANUAL_REVIEW_REQUIRED, keine Reparatur", async () => {
  const store = createStore(tmp());
  const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  const adapter = fakeAdapter({ backup: async () => ({ production_ref: "deploy-42" }) });
  await createRepairEngine({ store, adapters: { static: adapter }, auditor: fakeAuditor({ "*": { issues: [BROKEN_LINK, BROKEN_IMAGE] } }), now: () => T0 }).processAll();
  const saved = readOrder(store, o.order_id);
  assert.equal(saved.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(adapter.calls.applyFix, 0);
});

test("Happy Path: Backup → Voll-Audit → Plan → Minimal-Fix → Validierung → Retest → Bericht → READY → COMPLETED", async () => {
  const store = createStore(tmp());
  const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  const adapter = fakeAdapter();
  // Vorher 2 Befunde, nach der Reparatur 0.
  let repaired = false;
  const auditor = { audit: async (website) => ({ website, host: "muster.ch", reachable: true, finalUrl: website, title: "Muster AG",
    issues: repaired ? [] : [BROKEN_LINK, BROKEN_IMAGE], pages: { home: "<html><head><meta name=viewport content=x></head></html>" }, requests: 3 }) };
  const engine = createRepairEngine({ store, adapters: { static: { ...adapter, applyFix: async (...a) => { repaired = true; return adapter.applyFix(...a); } } }, auditor, now: () => T0 });
  await engine.processAll();
  const saved = readOrder(store, o.order_id);
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.equal(saved.backup.branch, `repair/${o.order_id}`);
  assert.equal(saved.backup.rollback_point, "deploy-42");
  assert.equal(saved.plan.length, 2);
  for (const p of saved.plan) { assert.ok(p.cause && p.target && p.planned_change && p.risk && p.test_method && p.rollback_method); }
  assert.ok(Object.values(saved.issues).every((i) => i.repair_status === "repaired"));
  assert.ok(Object.values(saved.issues).every((i) => typeof i.issue_id === "string" && i.type && i.severity && i.page && i.evidence && "customer_text" in i && "repairable" in i));
  assert.deepEqual(saved.regression.found, []);
  assert.equal(saved.retest.desktop.ok, true);
  assert.equal(saved.retest.mobile.ok, true);
  // Bericht: verständlich, nennt das Paket und die behobenen Punkte – Kundenzeilen ohne Fachjargon.
  assert.ok(saved.report.body.startsWith("Webseiten-Check"));
  assert.ok(saved.report.body.includes("CHF 480"));
  for (const l of saved.report.body.split("\n").filter((x) => x.startsWith("• "))) assert.ok(!CUSTOMER_JARGON_RE.test(l), l);
  // Abschluss nur explizit.
  const done = completeOrder(store, o.order_id, { now: T0 });
  assert.equal(done.state, "COMPLETED");
  assert.throws(() => completeOrder(store, o.order_id), /READY_FOR_DELIVERY/);
});

test("Geschützte Seite (Impressum): Befund wird nie automatisch repariert → manuelle Prüfung", async () => {
  const store = createStore(tmp());
  const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  const adapter = fakeAdapter();
  await createRepairEngine({ store, adapters: { static: adapter }, auditor: fakeAuditor({ "*": { issues: [IMPRESSUM_LINK] } }), now: () => T0 }).processAll();
  const saved = readOrder(store, o.order_id);
  const issue = Object.values(saved.issues)[0];
  assert.equal(issue.protected, true);
  assert.equal(issue.repairable, false);
  assert.equal(adapter.calls.applyFix, 0);
  assert.ok(saved.manual_review.some((m) => /geschützten Seite/.test(m.reason)));
  // Nichts zu reparieren → trotzdem sauber bis READY (Check + Bericht), ohne Änderung.
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.ok(saved.report.body.includes("nichts verändert"));
});

test("Ursache unklar (locate = null) → keine Reparatur, MANUAL_REVIEW_REQUIRED", async () => {
  const store = createStore(tmp());
  const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  const adapter = fakeAdapter({ locate: async () => null });
  await createRepairEngine({ store, adapters: { static: adapter }, auditor: fakeAuditor({ "*": { issues: [BROKEN_LINK] } }), now: () => T0 }).processAll();
  const saved = readOrder(store, o.order_id);
  assert.equal(saved.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(adapter.calls.applyFix, 0);
  assert.equal(Object.values(saved.issues)[0].repair_status, "needs_review");
});

test("Reparierter Befund weiterhin vorhanden → VALIDATION_FAILED", async () => {
  const store = createStore(tmp());
  const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  await createRepairEngine({ store, adapters: { static: fakeAdapter() }, auditor: fakeAuditor({ "*": { issues: [BROKEN_LINK] } }), now: () => T0 }).processAll();
  const saved = readOrder(store, o.order_id);
  assert.equal(saved.state, "VALIDATION_FAILED");
  assert.equal(Object.values(saved.issues)[0].repair_status, "still_broken");
});

test("Regression (neuer relevanter Befund nach der Reparatur) → Rollback → REPAIR_FAILED; ohne Rollback → MANUAL_REVIEW_REQUIRED", async () => {
  const mk = async (withRollback) => {
    const store = createStore(tmp());
    const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
    let repaired = false;
    const NEW_PROBLEM = rawIssue("contact_page_broken", "high", "https://muster.ch/kontakt");
    const auditor = { audit: async (website) => ({ website, host: "muster.ch", reachable: true, finalUrl: website, title: "x",
      issues: repaired ? [NEW_PROBLEM] : [BROKEN_LINK, BROKEN_IMAGE], pages: { home: "<html></html>" }, requests: 1 }) };
    const base = fakeAdapter({ applyFix: async () => { repaired = true; return { ok: true }; } });
    const adapter = withRollback ? { ...base, rollback: async () => { base.calls.rollback++; return { ok: true }; } } : base;
    await createRepairEngine({ store, adapters: { static: adapter }, auditor, now: () => T0 }).processAll();
    return { saved: readOrder(store, o.order_id), calls: base.calls };
  };
  const a = await mk(true);
  assert.equal(a.saved.state, "REPAIR_FAILED");
  assert.equal(a.calls.rollback, 1);
  assert.equal(a.saved.regression.rolled_back, true);
  assert.equal(a.saved.regression.found.length, 1);
  const b = await mk(false);
  assert.equal(b.saved.state, "MANUAL_REVIEW_REQUIRED");
  assert.equal(b.saved.regression.rolled_back, false);
});

test("Production-Deploy nur nach bestandenen Tests; Live-Retest danach; Deploy-Fehler → Rollback", async () => {
  const store = createStore(tmp());
  const o = newOrder(store); authorize(store, o.order_id); pay(store, o.order_id);
  let repaired = false, deployed = false;
  const order = [];
  const auditor = { audit: async (w) => { order.push(w); return { website: w, host: "muster.ch", reachable: true, finalUrl: w, title: "x",
    issues: repaired ? [] : [BROKEN_LINK, BROKEN_IMAGE], pages: { home: "<html><head><meta name=viewport content=x></head></html>" }, requests: 1 }; } };
  const adapter = fakeAdapter({ applyFix: async () => { repaired = true; return { ok: true }; } });
  adapter.deployProduction = async () => { adapter.calls.deployProduction++; deployed = true; return { ok: true, deploy_ref: "deploy-43" }; };
  await createRepairEngine({ store, adapters: { static: adapter }, auditor, now: () => T0 }).processAll();
  const saved = readOrder(store, o.order_id);
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.equal(adapter.calls.deployProduction, 1);
  assert.equal(saved.deployment.deployed, true);
  assert.equal(saved.deployment.live_retest_ok, true);
  assert.ok(deployed);

  // Deploy-Fehler: Rollback wird versucht → REPAIR_FAILED, nie „erfolgreich“.
  const store2 = createStore(tmp());
  const o2 = newOrder(store2); authorize(store2, o2.order_id); pay(store2, o2.order_id);
  let rep2 = false;
  const auditor2 = { audit: async (w) => ({ website: w, host: "muster.ch", reachable: true, finalUrl: w, title: "x",
    issues: rep2 ? [] : [BROKEN_LINK, BROKEN_IMAGE], pages: { home: "<html><head><meta name=viewport content=x></head></html>" }, requests: 1 }) };
  const ad2 = fakeAdapter({ applyFix: async () => { rep2 = true; return { ok: true }; } });
  ad2.deployProduction = async () => ({ ok: false, error: "deploy kaputt" });
  ad2.rollback = async () => { ad2.calls.rollback++; return { ok: true }; };
  await createRepairEngine({ store: store2, adapters: { static: ad2 }, auditor: auditor2, now: () => T0 }).processAll();
  const saved2 = readOrder(store2, o2.order_id);
  assert.equal(saved2.state, "REPAIR_FAILED");
  assert.equal(ad2.calls.rollback, 1);
});

test("Neustart: Engine arbeitet exakt am gespeicherten Zustand weiter", async () => {
  const dir = tmp();
  const store = createStore(dir);
  const o = newOrder(store);
  // Lauf 1 (ohne Freigabe): bleibt AUTHORIZATION_REQUIRED.
  await createRepairEngine({ store, adapters: {}, auditor: fakeAuditor({ "*": { issues: [BROKEN_LINK, BROKEN_IMAGE] } }), now: () => T0 }).processAll();
  assert.equal(readOrder(store, o.order_id).state, "AUTHORIZATION_REQUIRED");
  // „Neustart“: neue Engine-Instanz auf demselben Verzeichnis, Freigabe kommt dazwischen.
  authorize(createStore(dir), o.order_id); pay(createStore(dir), o.order_id);
  let repaired = false;
  const auditor = { audit: async (w) => ({ website: w, host: "muster.ch", reachable: true, finalUrl: w, title: "x",
    issues: repaired ? [] : [BROKEN_LINK, BROKEN_IMAGE], pages: { home: "<html><head><meta name=viewport content=x></head></html>" }, requests: 1 }) };
  const adapter = fakeAdapter({ applyFix: async () => { repaired = true; return { ok: true }; } });
  await createRepairEngine({ store: createStore(dir), adapters: { static: adapter }, auditor, now: () => T0 }).processAll();
  const saved = readOrder(createStore(dir), o.order_id);
  assert.equal(saved.state, "READY_FOR_DELIVERY");
  assert.equal(saved.state_history[0].to, "ORDER_RECEIVED"); // Historie lückenlos über den Neustart hinweg
  assert.ok(saved.state_history.some((h) => h.to === "AUTHORIZATION_REQUIRED") && saved.state_history.some((h) => h.to === "BACKUP"));
});

test("Stack-Erkennung und Schutzfilter", () => {
  assert.equal(detectStack({ html: "<html><script src=/wp-content/x.js></script></html>" }).type, "wordpress");
  assert.equal(detectStack({ html: "<html><script id=__NEXT_DATA__></script></html>" }).type, "nextjs");
  assert.equal(detectStack({ html: "<html><div data-reactroot></div></html>" }).type, "react");
  assert.equal(detectStack({ html: "<html><body>Hallo</body></html>", headers: { Server: "Netlify" } }).type, "github_netlify");
  assert.equal(detectStack({ html: "<html><body>Hallo</body></html>" }).type, "static");
  assert.equal(detectStack({ html: "" }).type, "other");
  assert.ok(isProtectedChange({ target: "dns-zone.txt", planned_change: "Nameserver wechseln" }));
  assert.ok(isProtectedChange({ planned_change: "Preisliste anpassen" }));
  assert.ok(isProtectedChange({ cause: "Fehler in der Datenbank mit Kundendaten" }));
  assert.ok(!isProtectedChange({ target: "index.html", planned_change: "Linkziel korrigieren" }));
  assert.equal(normDomain("https://www.Muster.ch/pfad"), "muster.ch");
});

test("Statuszähler ohne Secrets/Evidence", async () => {
  const dir = tmp();
  const store = createStore(dir);
  const o = newOrder(store);
  await createRepairEngine({ store, adapters: {}, auditor: fakeAuditor({ "*": { issues: [] } }), now: () => T0 }).processAll();
  const s = repairOrdersStatus(dir);
  assert.equal(s.total, 1);
  assert.equal(s.open, 1);
  assert.equal(s.waiting_authorization, 1);
  assert.ok(!JSON.stringify(s).includes(o.order_id)); // nur Zähler, keine IDs
});

test("fullSiteAudit: Befunde mit issue_id/type/severity/page/evidence/customer_text/repairable/repair_status, nichts erfunden", async () => {
  const a = await fullSiteAudit(HOME, { auditor: fakeAuditor({ "*": { issues: [BROKEN_LINK] } }), now: () => T0 });
  const list = Object.values(a.issues);
  assert.equal(list.length, 1);
  const i = list[0];
  assert.deepEqual([i.type, i.severity, i.page, i.repair_status, i.repairable, i.protected], ["broken_link", "medium", HOME, "open", true, false]);
  assert.ok(/^I[0-9a-f]{10}$/.test(i.issue_id));
  assert.ok(i.customer_text && !CUSTOMER_JARGON_RE.test(i.customer_text));
  const empty = await fullSiteAudit(HOME, { auditor: fakeAuditor({ "*": { issues: [] } }), now: () => T0 });
  assert.equal(Object.keys(empty.issues).length, 0);
});
