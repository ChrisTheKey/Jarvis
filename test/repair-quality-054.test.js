// REPAIR QUALITY REVALIDATION (TF-054): COMPLETED nur bei wirklich behobenem Befund – Abschluss-Gate über ALLE Pflichtpunkte
// (Freigabe, Zahlung, Zugang, Profil, Backup, Adapter-Validierung, HTTP, Desktop, Mobile, Regression, Original-Befund behoben),
// Teilreparatur nie COMPLETED, applyFix «ok» allein zählt nie. Nur Attrappen (keine Website, keine Mail, keine Zahlung).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { createRepairOrder, authorizeRepair, createRepairEngine, completeOrder, completionGate, buildCustomerReport, REPAIR_ORDERS_FILE, FULFILLMENT_CLASS } from "../repair-workflow.js";
import { gateDecision } from "../repair-browser-validator.js";

const T0 = new Date("2026-10-14T08:00:00Z");
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-q54-")); dirs.push(d); return d; };
const readOrder = (store, id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id];
process.on("exit", () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Zwei reparierbare Befunde auf der Startseite: Kontakt-Link (404) + Bild (404).
const ISSUES = {
  contact: { type: "contact_page_broken", url: "https://muster.ch/kontakt-alt.html", page: "https://muster.ch/", evidence: "HTTP 404", severity: "high", replacement: "/kontakt.html" },
  image: { type: "broken_image", url: "https://muster.ch/assets/lab-logo.svg", page: "https://muster.ch/", evidence: "HTTP 404", severity: "medium", replacement: "/assets/img/lab-logo.svg" },
};
const snap = () => ({ load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
  overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
  critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
  nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 2, targets_ok: 2, targets_failed: 0 }, images: { visible: 2, broken: 0, broken_paths: [] },
  console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 }, network: { failed_same_site: 0, failed_cross_site: 0, entries: [] },
  fingerprints: { header: "a", nav: "b", main: "c", footer: "d" }, findings: [] });

// fail: Befund, dessen Reparatur scheitert (applyFix ok:false) bzw. «lügt» (applyFix ok:true, Website unverändert).
function world({ fail = null, lie = null } = {}) {
  const st = { fixed: new Set(), writes: 0, rollbacks: 0 };
  const keyOf = (url) => Object.keys(ISSUES).find((k) => ISSUES[k].url === url);
  const adapter = {
    direct_live: true,
    checkAccess: async () => ({ ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] }),
    backup: async () => ({ production_ref: "p1", backup_ref: "b1", rollback_point: "r1" }),
    locate: async (i) => ({ target: "index.html", cause: `${i.url} 404, Ziel existiert genau einmal`, planned_change: "Verweis ersetzen", risk: "niedrig", fix: { replacement: ISSUES[keyOf(i.url)].replacement } }),
    applyFix: async (item, order) => {
      const k = keyOf(order.issues[item.issue_id].url);
      if (k === fail) return { ok: false };
      if (k !== lie) { st.writes++; st.fixed.add(k); }
      return { ok: true, change_ref: `lab:${k}` };
    },
    validate: async () => ({ build_ok: true }),
    deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }),
    rollback: async () => { st.rollbacks++; st.fixed.clear(); return { ok: true }; },
  };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Muster", requests: 3, pages: { home: "<html><body>Muster</body></html>" },
    issues: Object.entries(ISSUES).filter(([k]) => !st.fixed.has(k)).map(([, i]) => ({ type: i.type, url: i.url, page: i.page, evidence: i.evidence, severity: i.severity, reproducible: true, detectedAt: T0.toISOString() })) }) };
  // Browser-Attrappe, die den Befund NICHT sieht (z. B. Befund auf einer Seite ausserhalb der Browser-Stichprobe): nur das
  // Abschluss-Gate kann die Teilreparatur dann noch stoppen.
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    const out = { url, phase, desktop: snap(), mobile: snap() };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  return { st, adapter, auditor, browserValidator };
}
function fakeGmail() {
  const calls = [];
  return { calls, createDraft: async (x) => { calls.push({ op: "create", ...x }); return { draftId: "dr" + calls.length }; }, sendDraft: async (id) => { calls.push({ op: "SEND", id }); return {}; } };
}
function setup() {
  const dir = tmp(), store = createStore(dir);
  const o = createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "kunde@muster.ch", now: T0 });
  authorizeRepair(store, o.order_id, { authorized_domain: "muster.ch", source: "customer_reply_email", now: T0 });
  recordPayment(store, { order_id: o.order_id, amount_chf: 240, reference: "TF054-Test-Ledger", now: T0 });
  return { dir, store, id: o.order_id };
}
const run = (store, w, gmail) => createRepairEngine({ store, adapters: { static: w.adapter }, auditor: w.auditor, browserValidator: w.browserValidator,
  requireBrowser: true, autoDeliver: true, gmail, now: () => T0 }).processAll();

test("Kontrolle: beide Befunde behoben → COMPLETED, genau 1 Lieferung, Abschluss-Gate vollständig", async () => {
  const { store, id } = setup();
  const w = world(), gmail = fakeGmail();
  await run(store, w, gmail);
  const o = readOrder(store, id);
  assert.equal(o.state, "COMPLETED", o.blocked_reason);
  assert.deepEqual(completionGate(o), { ok: true, missing: [] });
  assert.equal(gmail.calls.filter((c) => c.op === "create" && c.messageClass === FULFILLMENT_CLASS).length, 1);
});

test("TEILREPARATUR: Befund 1 behoben, Befund 2 scheitert (applyFix ok:false), Browser sieht es nicht → KEIN READY/COMPLETED, keine Lieferung", async () => {
  const { store, id } = setup();
  const w = world({ fail: "image" }), gmail = fakeGmail();
  await run(store, w, gmail);
  const o = readOrder(store, id);
  assert.notEqual(o.state, "COMPLETED");
  assert.notEqual(o.state, "READY_FOR_DELIVERY");
  assert.equal(o.state, "MANUAL_REVIEW_REQUIRED", o.blocked_reason);
  assert.match(o.blocked_reason, /repair_unresolved/);
  assert.equal(gmail.calls.length, 0, "keine Erfolgsmail");
  const st = Object.values(o.issues).map((i) => [i.type, i.repair_status]).sort();
  assert.deepEqual(st, [["broken_image", "repair_failed"], ["contact_page_broken", "repaired"]]);
  assert.ok(completionGate(o).missing.includes("repair_unresolved"));
  // Auch Chris kann einen so manipulierten Auftrag nicht abschliessen.
  const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
  Object.assign(data.orders[id], { state: "READY_FOR_DELIVERY" });
  store.write(REPAIR_ORDERS_FILE, data);
  assert.throws(() => completeOrder(store, id), /repair_unresolved/);
});

test("applyFix «ok» zählt nicht: Adapter meldet Erfolg, Website unverändert → unabhängiger Audit findet den Befund → Rollback → REPAIR_FAILED", async () => {
  const { store, id } = setup();
  const w = world({ lie: "contact" }), gmail = fakeGmail();
  await run(store, w, gmail);
  const o = readOrder(store, id);
  assert.equal(o.state, "REPAIR_FAILED", o.blocked_reason);
  assert.match(o.blocked_reason, /weiterhin vorhanden/);
  assert.equal(w.st.rollbacks, 1);
  assert.equal(o.report, null);
  assert.equal(gmail.calls.length, 0);
});

for (const [label, b] of [["kein Backup", null], ["ohne Rollback-Punkt", { production_ref: "p1", backup_ref: "b1" }], ["Backup-Fehler", new Error("disk full")]]) {
  test(`Backup Pflicht (${label}): kein Write, MANUAL_REVIEW_REQUIRED`, async () => {
    const { store, id } = setup();
    const w = world();
    w.adapter.backup = async () => { if (b instanceof Error) throw b; return b; };
    await run(store, w, fakeGmail());
    const o = readOrder(store, id);
    assert.equal(o.state, "MANUAL_REVIEW_REQUIRED");
    assert.match(o.blocked_reason, /Backup unvollständig/);
    assert.equal(w.st.writes, 0);
    assert.equal(o.backup, null);
  });
}

test("Abschluss-Gate: jeder Pflichtpunkt einzeln fehlend → kein COMPLETED (Authorization, Payment, Access, Profile, Backup, Adapter, HTTP, Desktop, Mobile, Regression, Befund)", async () => {
  const { store, id } = setup();
  await run(store, world(), fakeGmail());
  const good = readOrder(store, id);
  assert.deepEqual(completionGate(good), { ok: true, missing: [] });
  const cases = [
    ["authorization", (o) => { o.customer_authorized_repair = false; }],
    ["authorization", (o) => { o.authorization = { ...o.authorization, authorized_domain: "andere.ch" }; }],
    ["payment", (o) => { o.payment = { ...o.payment, satisfied: false }; }],
    ["access", (o) => { o.access = null; }],
    ["access_profile", (o) => { o.access_profile = { profile_status: "WAITING_FOR_ACCESS_PROFILE" }; }],
    ["backup", (o) => { o.backup = { ...o.backup, rollback_point: null }; }],
    ["adapter_validation", (o) => { o.validation = { ...o.validation, build_ok: false }; }],
    ["http_retest", (o) => { o.retest = { ...o.retest, http_ok: false }; }],
    ["browser_desktop", (o) => { o.browser_gate = { ...o.browser_gate, desktop: "NEIN" }; }],
    ["browser_mobile", (o) => { o.browser_gate = { ...o.browser_gate, mobile: "NEIN" }; }],
    ["browser_regression", (o) => { o.browser_gate = { ...o.browser_gate, regression: "GEFUNDEN" }; }],
    ["repair_unresolved", (o) => { Object.values(o.issues)[0].repair_status = "still_broken"; }],
    ["repair_unresolved", (o) => { Object.values(o.issues)[0].repair_status = "rolled_back"; }],
  ];
  for (const [want, mutate] of cases) {
    const o = structuredClone(good);
    mutate(o);
    const g = completionGate(o);
    assert.equal(g.ok, false, want);
    assert.ok(g.missing.includes(want), `${want}: ${g.missing}`);
  }
});

test("Bericht behauptet nie «vollständig repariert»: offene Punkte werden als nicht behoben genannt", () => {
  const order = { domain: "muster.ch", plan: [{ issue_id: "A" }], retest: { desktop: { ok: true }, mobile: { ok: true }, http_ok: true },
    issues: { A: { type: "broken_link", severity: "medium", repair_status: "repaired", customer_text: "Link A führte auf eine Fehlerseite" },
      B: { type: "broken_link", severity: "medium", repair_status: "needs_review", customer_text: "Link B führt auf eine Fehlerseite" } } };
  const body = buildCustomerReport(order).body;
  assert.match(body, /Nicht behoben \(bitte kontaktieren Sie mich\):\n• Link B führt auf eine Fehlerseite/); assert.match(body, /Gefundene Punkte: 2/);
  assert.ok(body.includes("Link B führt auf eine Fehlerseite"));
  assert.doesNotMatch(body, /vollständig repariert|alle (Fehler|Punkte|Befunde) (wurden )?behoben/i);
});
