// TF-055 Abschluss-Semantik: geschützte/manuelle Restpunkte → COMPLETED_WITH_MANUAL_ITEMS (nie COMPLETED, nie «vollständig repariert»),
// offener reparierbarer Befund → weder COMPLETED noch COMPLETED_WITH_MANUAL_ITEMS, Regression → Rollback → REPAIR_FAILED ohne Lieferung.
// Dazu der CRM-Export (repair_findings.json) und die Wirkung auf die CRM-Fehlerzahl. Nur Attrappen (keine Website, keine Mail, keine Zahlung).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, completeOrder, completionGate, manualItems, completionState,
  buildCustomerReport, buildRepairDeliveryMail, repairFindingsExport, writeRepairFindingsExport, publicRepairOrders, repairPhase,
  REPAIR_ORDERS_FILE, FULFILLMENT_CLASS, COMPLETED_WITH_MANUAL_ITEMS, ORDER_STATES } from "../repair-workflow.js";
import { gateDecision } from "../repair-browser-validator.js";
import { siteHealth, fullAuditEntry, REPAIR_FINDINGS_FILE } from "../site-findings.js";
import { cleanRepair } from "../server-control.js";

const T0 = new Date("2026-10-14T08:00:00Z");
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-m55-")); dirs.push(d); return d; };
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
process.on("exit", () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// contact + image: reparierbar (Startseite). protected: Bild auf der Datenschutz-Seite – geschützter Inhalt, nie automatisch.
const ALL = {
  contact: { type: "contact_page_broken", url: "https://muster.ch/kontakt-alt.html", page: "https://muster.ch/", severity: "high", replacement: "/kontakt.html" },
  image: { type: "broken_image", url: "https://muster.ch/assets/lab-logo.svg", page: "https://muster.ch/", severity: "medium", replacement: "/assets/img/lab-logo.svg" },
  protected: { type: "broken_image", url: "https://muster.ch/assets/siegel.png", page: "https://muster.ch/datenschutz.html", severity: "medium" },
};
const REGRESSION = { type: "broken_link", url: "https://muster.ch/neu-kaputt.html", page: "https://muster.ch/", severity: "medium" };
const snap = () => ({ load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
  overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
  critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
  nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 2, targets_ok: 2, targets_failed: 0 }, images: { visible: 2, broken: 0, broken_paths: [] },
  console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 }, network: { failed_same_site: 0, failed_cross_site: 0, entries: [] },
  fingerprints: { header: "a", nav: "b", main: "c", footer: "d" }, findings: [] });

function world({ keys = ["contact", "image"], fail = null, regress = false } = {}) {
  const st = { fixed: new Set(), writes: 0, rollbacks: 0 };
  const keyOf = (url) => keys.find((k) => ALL[k].url === url);
  const adapter = {
    direct_live: true,
    checkAccess: async () => ({ ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] }),
    backup: async () => ({ production_ref: "p1", backup_ref: "b1", rollback_point: "r1" }),
    locate: async (i) => ({ target: "index.html", cause: `${i.url} 404, Ziel existiert genau einmal`, planned_change: "Verweis ersetzen", risk: "niedrig", fix: { replacement: ALL[keyOf(i.url)].replacement } }),
    applyFix: async (item, order) => { const k = keyOf(order.issues[item.issue_id].url); if (k === fail) return { ok: false }; st.writes++; st.fixed.add(k); return { ok: true, change_ref: `lab:${k}` }; },
    validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }),
    rollback: async () => { st.rollbacks++; st.fixed.clear(); return { ok: true }; },
  };
  const auditor = { audit: async (u) => {
    const issues = keys.filter((k) => !st.fixed.has(k)).map((k) => ALL[k]);
    if (regress && st.fixed.size) issues.push(REGRESSION);
    return { website: u, reachable: true, finalUrl: u, title: "Muster", requests: 3, pages: { home: "<html></html>" },
      issues: issues.map((i) => ({ type: i.type, url: i.url, page: i.page, evidence: "HTTP 404", severity: i.severity, reproducible: true, detectedAt: T0.toISOString() })) };
  } };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => { const out = { url, phase, desktop: snap(), mobile: snap() }; if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); } return out; } };
  return { st, adapter, auditor, browserValidator };
}
const fakeGmail = () => { const calls = []; return { calls, createDraft: async (x) => { calls.push({ op: "create", ...x }); return { draftId: "dr" + calls.length }; }, sendDraft: async (id) => { calls.push({ op: "SEND", id }); return {}; } }; };
function setup() {
  const dir = tmp(), store = createStore(dir);
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "kunde@muster.ch", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_reply_email", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: "TF055-Test-Ledger", now: T0 });
  return { dir, store, id: o.order_id };
}
const run = (store, w, gmail, opts = {}) => createRepairEngine({ store, adapters: { static: w.adapter }, auditor: w.auditor, browserValidator: w.browserValidator,
  requireBrowser: true, autoDeliver: true, gmail, now: () => T0, ...opts }).processAll();
const FORBIDDEN_CLAIMS = /vollständig repariert|alle (Fehler|Punkte|Befunde|Probleme) (wurden )?behoben|Website (ist )?fehlerfrei/i;

test("Test 1: 2 reparierbare, 0 geschützt → beide repariert → COMPLETED (keine manuellen Punkte)", async () => {
  const { store, id } = setup();
  const gmail = fakeGmail();
  await run(store, world(), gmail);
  const o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED", o.blocked_reason);
  assert.equal(manualItems(o).length, 0);
  assert.deepEqual(o.completion && { kind: o.completion.kind, manual_items: o.completion.manual_items, repaired: o.completion.repaired }, { kind: "FULL", manual_items: 0, repaired: 2 });
  assert.doesNotMatch(o.report.body, /manuelle Prüfung/);
  assert.equal(gmail.calls.filter((c) => c.op === "SEND").length, 1);
});

test("Test 2: 1 reparierbar + 1 geschützt → reparierbarer behoben, geschützter unverändert → COMPLETED_WITH_MANUAL_ITEMS, nie COMPLETED", async () => {
  const { store, id } = setup();
  const w = world({ keys: ["contact", "protected"] }), gmail = fakeGmail();
  await run(store, w, gmail);
  const o = readOrder(store, id);
  assert.equal(o.state, "READY_FOR_DELIVERY", o.blocked_reason);
  assert.notEqual(o.state, "COMPLETED");
  assert.deepEqual(completionGate(o), { ok: true, missing: [] }, "technischer Abschluss bestanden");
  const st = Object.values(o.issues).map((i) => [i.type, i.repair_status, i.protected]).sort();
  assert.deepEqual(st, [["broken_image", "open", true], ["contact_page_broken", "repaired", false]]);
  assert.equal(w.st.writes, 1, "geschützter Befund nie angefasst");
  assert.equal(o.completion.kind, "WITH_MANUAL_ITEMS");
  assert.match(o.report.body, /Die automatisch reparierbaren Probleme wurden behoben\. Weitere Punkte erfordern eine manuelle Prüfung\./);
  assert.equal(gmail.calls.filter((c) => c.op === "create" && c.messageClass === FULFILLMENT_CLASS).length, 0, "keine irreführende Abschlussmail");
  assert.doesNotMatch(o.report.body, FORBIDDEN_CLAIMS);
  assert.match(o.state_history.at(-1).reason, /Abschlussmail nicht freigegeben/);
  // Der technische Zustand bleibt bis zur expliziten Chris-Entscheidung offen.
  assert.equal(completeOrder(store, id).state, COMPLETED_WITH_MANUAL_ITEMS);
  const pub = publicRepairOrders(store.dir).orders[0];
  assert.equal(pub.state, COMPLETED_WITH_MANUAL_ITEMS); assert.equal(pub.phase, COMPLETED_WITH_MANUAL_ITEMS); assert.equal(pub.manual_items_open, 1);
  const clean = cleanRepair(publicRepairOrders(store.dir));
  assert.equal(clean.orders[0].state, COMPLETED_WITH_MANUAL_ITEMS, "Cloud-Allowlist kennt den Zustand");
  assert.equal(clean.completed_with_manual_items, 1);
});

test("Test 2b: Abschluss durch Chris (completeOrder) mit geschütztem Restpunkt → ebenfalls COMPLETED_WITH_MANUAL_ITEMS", async () => {
  const { store, id } = setup();
  await run(store, world({ keys: ["contact", "protected"] }), fakeGmail(), { autoDeliver: false });
  assert.equal(readOrder(store, id).state, "READY_FOR_DELIVERY");
  assert.equal(completeOrder(store, id).state, COMPLETED_WITH_MANUAL_ITEMS);
});

test("Test 3: 1 reparierbarer Befund bleibt offen → weder COMPLETED noch COMPLETED_WITH_MANUAL_ITEMS, keine Lieferung", async () => {
  const { store, id } = setup();
  const gmail = fakeGmail();
  await run(store, world({ keys: ["contact", "image"], fail: "image" }), gmail);
  const o = readOrder(store, id);
  assert.ok(!["COMPLETED", COMPLETED_WITH_MANUAL_ITEMS, "READY_FOR_DELIVERY"].includes(o.state), o.state);
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
  assert.match(o.blocked_reason, /repair_unresolved/);
  assert.equal(gmail.calls.length, 0);
  assert.deepEqual(repairFindingsExport(store.dir).orders, {}, "kein CRM-Stand ohne bestandenen Retest");
});

test("Test 4: Regression nach dem Fix → Rollback → REPAIR_FAILED, keine Erfolgslieferung, kein CRM-«behoben»", async () => {
  const { store, id } = setup();
  const w = world({ regress: true }), gmail = fakeGmail();
  await run(store, w, gmail);
  const o = readOrder(store, id);
  assert.equal(o.state, "REPAIR_FAILED", o.blocked_reason);
  assert.equal(w.st.rollbacks, 1);
  assert.equal(o.report, null);
  assert.equal(gmail.calls.length, 0);
  assert.ok(Object.values(o.issues).every((i) => i.repair_status !== "repaired"), "zurückgerollt = nicht repariert");
  assert.deepEqual(repairFindingsExport(store.dir).orders, {});
});

test("manualItems: low-Hinweise zählen nicht, geschützt/needs_review/≥medium schon; Zustandsliste + Phase", () => {
  const o = (issues) => ({ issues });
  assert.equal(completionState(o({ a: { severity: "low", repair_status: "open" } })), "COMPLETED");
  assert.equal(completionState(o({ a: { severity: "low", repair_status: "open", protected: true } })), COMPLETED_WITH_MANUAL_ITEMS);
  assert.equal(completionState(o({ a: { severity: "low", repair_status: "needs_review" } })), COMPLETED_WITH_MANUAL_ITEMS);
  assert.equal(completionState(o({ a: { severity: "medium", repair_status: "open" } })), COMPLETED_WITH_MANUAL_ITEMS);
  assert.equal(completionState(o({ a: { severity: "high", repair_status: "repaired" } })), "COMPLETED");
  assert.ok(ORDER_STATES.includes(COMPLETED_WITH_MANUAL_ITEMS));
  assert.equal(repairPhase({ state: COMPLETED_WITH_MANUAL_ITEMS }, {}), COMPLETED_WITH_MANUAL_ITEMS);
  // Bericht ohne Reparatur, nur geschützte Punkte: nie «behoben» behaupten.
  const body = buildCustomerReport({ domain: "muster.ch", plan: [], retest: { desktop: { ok: true }, mobile: { ok: true }, http_ok: true },
    issues: { P: { type: "broken_image", severity: "medium", repair_status: "open", protected: true, customer_text: "Auf der Seite «Datenschutz» wird ein Bild nicht angezeigt" } } }).body;
  assert.match(body, /Es gab keine automatisch reparierbaren Probleme\. Die gefundenen Punkte erfordern eine manuelle Prüfung\./);
  assert.doesNotMatch(body, FORBIDDEN_CLAIMS);
  const mail = buildRepairDeliveryMail({ domain: "muster.ch", report: { body }, issues: { P: { severity: "medium", repair_status: "open", protected: true } } });
  assert.equal(mail.status, "MANUAL_REVIEW_REQUIRED");
  assert.equal(mail.body, "");
});

test("I + J: Repair→CRM – vorher 3 Fehler (vollständig), Reparatur behebt 2 → CRM zählt 1, geschützter Punkt bleibt sichtbar", async () => {
  const { store, dir } = setup();
  const w = world({ keys: ["contact", "image", "protected"] });
  // Vollständiger passiver Audit VOR der Reparatur (gleiche drei Befunde).
  const before = fullAuditEntry({ reachable: true, coverage: { links_found: 1, links_checked: 1, images_found: 2, images_checked: 2, links_skipped: 0, links_unverified: 0, images_skipped: 0, images_unverified: 0, deadline_hit: false },
    issues: (await w.auditor.audit("https://muster.ch/")).issues }, { domain: "muster.ch", audited_at: "2026-10-13T08:00:00.000Z" });
  assert.equal(before.complete, true);
  const now = new Date("2026-10-14T09:00:00Z");
  assert.equal(siteHealth({ full: before, now }).count, 3);
  await run(store, w, fakeGmail());
  const exportDir = path.join(dir, "crm-export");
  const r = writeRepairFindingsExport({ dir: store.dir, exportDir, now });
  assert.deepEqual(r, { written: true, domains: 1 });
  assert.deepEqual(writeRepairFindingsExport({ dir: store.dir, exportDir, now: new Date(+now + 60_000) }), { written: false, domains: 1 }, "unverändert → kein erneutes Schreiben");
  const exp = JSON.parse(fs.readFileSync(path.join(exportDir, REPAIR_FINDINGS_FILE), "utf8"));
  const e = exp.orders["muster.ch"];
  assert.equal(e.state, "READY_FOR_DELIVERY");
  assert.deepEqual(e.findings.map((f) => [f.type, f.status, f.manual]).sort(), [["broken_image", "OPEN", true], ["broken_image", "RESOLVED", false], ["contact_page_broken", "RESOLVED", false]]);
  const raw = JSON.stringify(exp);
  for (const bad of ["kunde@muster.ch", "RF480-", "r1", "b1", "live:lab", "HTTP 404", "lab:"]) assert.ok(!raw.includes(bad), `kein ${bad} im Export`);
  const h = siteHealth({ full: before, repair: e, now });
  assert.equal(h.audit, "FULL"); assert.equal(h.count, 1, "3 → 1"); assert.equal(h.exact, true);
  assert.equal(h.items[0].manual, true, "geschützter Punkt bleibt als manueller Punkt sichtbar");
  assert.match(h.items[0].text, /Datenschutz/);
  assert.deepEqual({ repaired: h.repair.repaired, manual_open: h.repair.manual_open, state: h.repair.state }, { repaired: 2, manual_open: 1, state: "READY_FOR_DELIVERY" });
  // Ein neuerer passiver Voll-Audit ersetzt den Repair-Stand (gleiche Website, später geprüft).
  const later = fullAuditEntry({ reachable: true, coverage: before && { links_found: 0, links_checked: 0, images_found: 0, images_checked: 0, deadline_hit: false }, issues: [] }, { domain: "muster.ch", audited_at: "2026-10-14T10:00:00.000Z" });
  assert.equal(siteHealth({ full: later, repair: e, now: new Date("2026-10-14T11:00:00Z") }).count, 0);
});

test("Normales COMPLETED → CRM: 0 offene geplante reparierbare Befunde", async () => {
  const { store } = setup();
  await run(store, world(), fakeGmail());
  const e = repairFindingsExport(store.dir).orders["muster.ch"];
  assert.equal(e.state, "COMPLETED"); assert.equal(e.completion, "FULL");
  const h = siteHealth({ repair: e, now: new Date("2026-10-14T09:00:00Z") });
  assert.equal(h.count, 0); assert.equal(h.repair.manual_open, 0); assert.equal(h.repair.repaired, 2);
});
