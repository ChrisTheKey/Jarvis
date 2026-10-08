// TF-025 Swiss Cold Lead Draft Outreach: Jarvis findet Schweizer Repair-Leads und geschäftliche Kontakte und legt Gmail-ENTWÜRFE
// an – sendet sie aber nie (Worker, VPS, Kampagne, Cloud-Queue). Chris versendet manuell; das erzeugt nie eine Rechtsgrundlage.
// Ohne Netzwerk, ohne echte Mail: Gmail ist eine Attrappe bzw. gmail.js läuft gegen ein gefälschtes fetch.
import { test, beforeEach, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as swiss from "../swiss-repair.js";
import { discoverBusinessContact, qualifyRepairLead, createColdDraft, ensureColdDraft, coldDraftAction, coldDuplicate, buildColdDraft, markManualSend,
  COLD_DRAFTS_FILE, COLD_MODE, COLD_FOOTER } from "../swiss-repair.js";
import { OFFERS, OFFER_CLASSES, loadPipeline, computeMetrics } from "../sales.js";
import { createWorker, createStore, legalBasis, zurichDay, HARD_LIMIT, WINDOW_LIMIT, SEND_WINDOWS, OPT_OUT_RE } from "../mail-worker.js";
import { runDiscovery } from "../lead-finder.js";
import { createAuditor } from "../site-auditor.js";
import { sanitizeState, findSensitiveKeys } from "../shared-state.js";
// TF-024: vollständig belegte Grundlagen (Empfänger, Quelle, Datum, Umfang, Beleg, vorher eingeholt, aktiv, Vertrauen HIGH).
const OPTIN = { approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular helvetic-webdesign.ch mit Einwilligungs-Checkbox",
  consentScope: "Hinweise und Angebote zu Website-Prüfung und Website-Reparatur von Helvetic Webdesign", consentEvidence: "Double-Opt-in bestätigt am 2026-09-01 (Formular-Eintrag 4711)",
  obtainedBeforeMarketingSend: true, withdrawalStatus: "active", consentConfidence: "HIGH" };
const optIn = (email) => ({ ...OPTIN, consentRecipient: email });
const CUSTOMER = { approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true,
  customerRelationshipEvidence: "Auftrag und Rechnung 2025-118 (Website-Wartung)", relationshipDate: "2025-05-10", previousService: "Website-Wartung",
  advertisedService: "Website-Reparatur", similarityRationale: "Gleiche Website, gleiche Art Leistung (Pflege/Reparatur)", emailSource: "Kundenkorrespondenz zum Auftrag 2025-118",
  sameProvider: true, optOutStatus: "none", customerConfidence: "HIGH" };

const T0 = new Date("2026-10-06T08:00:00Z"); // 10:00 Zürich – Morgenfenster 09:30
const DAY = 86_400_000;
const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const SENDER = { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" };
const issue = (type, severity, evidence, url = "https://muster.ch/") => ({ type, url, evidence: evidence || `Beleg für ${type}`, severity, detectedAt: T0.toISOString() });
const BROKEN = issue("broken_link", "medium", "HTTP 404 (verlinkt auf https://muster.ch/)", "https://muster.ch/team-alt");
const lead = (over = {}) => ({
  email: "info@muster.ch", company: "Muster AG", website: "https://muster.ch/", domain: "muster.ch", uid: "CHE-123.456.789", approved: false, consentBasis: null,
  consentAt: null, consentSource: null, existingCustomer: false, similarService: false, status: "blocked_no_legal_basis", auditedAt: T0.toISOString(), reachable: true,
  title: "Muster AG – Schreinerei", discoverySource: "OpenStreetMap node/1 (Winterthur, craft)", contact_source: "impressum", source_url: "https://muster.ch/impressum",
  collected_at: T0.toISOString(), contact_confidence: "medium", websiteIssues: [BROKEN], ...over,
});

let dir, store, g, clock;
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const read = (name, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fb; } };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-025-"));
  store = createStore(dir);
  g = fakeGmail();
  clock = T0;
  write("config.json", { dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: SENDER });
});

// Gmail-Attrappe mit derselben Regel wie gmail.js: Cold-Entwürfe sind nicht sendbar, fremde Entwürfe nicht anfassbar.
function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, threads: {}, calls: [], n: 0, manual: [] };
  const owned = (id) => { if (!f.reg.drafts[id]) throw new Error(`Entwurf ${id} wurde nicht von Jarvis erstellt – Zugriff verweigert.`); return f.reg.drafts[id]; };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async readThread(id) { f.calls.push("read " + id); if (!Object.values(f.reg.sent).some((s) => s.threadId === id)) throw new Error("nicht von Jarvis begonnen"); return { threadId: id, messages: structuredClone(f.threads[id] || []) }; },
    async replyToThread(id, { body }) { f.calls.push("reply " + id); const d = "dr" + ++f.n; f.reg.drafts[d] = { threadId: id, to: Object.values(f.reg.sent).find((s) => s.threadId === id).to, body, createdAt: clock.toISOString() }; return { draftId: d, threadId: id }; },
    async createDraft({ to, subject, body, mode, leadId }) {
      f.calls.push("create " + to);
      const id = "dr" + ++f.n;
      f.reg.drafts[id] = { threadId: "t" + id, messageId: "m" + id, to, subject, body, createdAt: clock.toISOString(), ...(mode === COLD_MODE ? { mode, leadId, legalBasis: "NONE" } : {}) };
      return { draftId: id, messageId: "m" + id, threadId: "t" + id };
    },
    async updateDraft(id, { subject, body }) { f.calls.push("update " + id); Object.assign(owned(id), { subject, body }); return { draftId: id }; },
    async deleteDraft(id) { f.calls.push("delete " + id); owned(id); delete f.reg.drafts[id]; return { draftId: id, deleted: true }; },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft(id, { window = null } = {}) {
      f.calls.push("SEND " + id);
      const d = owned(id);
      if (d.mode === COLD_MODE) throw new Error("Cold-Lead-Entwurf – Jarvis sendet ihn nie.");
      delete f.reg.drafts[id];
      f.reg.sent["s" + id] = { messageId: "s" + id, threadId: d.threadId, to: d.to, subject: d.subject, fromDraft: id, window, sentAt: clock.toISOString() };
    },
    // Chris schickt einen Entwurf selbst in Gmail ab (simuliert); syncColdDrafts erkennt es wie gmail.js.
    chrisSendsManually(id) {
      const d = f.reg.drafts[id];
      f.manual.push(id);
      f.threads[d.threadId] = [{ messageId: "ms" + id, from: SENDER.email, to: d.to, subject: d.subject, body: d.body, sent: true, draft: false, internalDate: +clock }];
      f.pendingManual = { ...(f.pendingManual || {}), [id]: d };
    },
    async syncColdDrafts() {
      const out = [];
      for (const [id, d] of Object.entries(f.pendingManual || {})) {
        delete f.reg.drafts[id];
        f.reg.sent["ms" + id] = { messageId: "ms" + id, threadId: d.threadId, to: d.to, subject: d.subject, fromDraft: id, sentAt: clock.toISOString(), manual: true, mode: COLD_MODE, legalBasis: "NONE" };
        out.push({ draftId: id, leadId: d.leadId, status: "manually_sent", messageId: "ms" + id, threadId: d.threadId, sentAt: clock.toISOString() });
      }
      f.pendingManual = {};
      return out;
    },
  });
  return f;
}
const worker = (compose) => createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: compose || (async () => ({ decision: "draft", subject: "Re", body: "Guten Tag, gerne." })) });
const sends = () => g.calls.filter((c) => c.startsWith("SEND"));
const creates = () => g.calls.filter((c) => c.startsWith("create"));
const cold = (id = "muster.ch") => read(COLD_DRAFTS_FILE, { reviews: {} }).reviews[id];
const queue = (l = lead()) => ensureColdDraft(store, l, { sender: SENDER, now: clock });

// ---------- Qualifizierung + Kontakt ----------

test("Swiss repair cold lead + public business email → draft yes; same lead → automatic send no", () => {
  const q = qualifyRepairLead(lead(), { now: T0 });
  assert.equal(q.contact_basis, COLD_MODE);
  assert.deepEqual([q.draft_creation_eligible, q.automatic_marketing_send_eligible, q.automatic_send_allowed, q.automatic_send_eligible], [true, false, false, false]);
  assert.deepEqual([q.legal_basis, q.message_class, q.stage], ["NONE", "DRAFT_ONLY", "cold_lead_draft_only"]);
  assert.equal(legalBasis(lead(), T0), null);
  // Weder Fund noch Befund noch .ch noch guter Score machen daraus eine Versandgrundlage.
  assert.equal(legalBasis(lead({ approved: true, contact_confidence: "high", repair_fit_score: 99 }), T0), null);
});

test("info@ → Entwurf erlaubt, wenn geschäftliche Adresse auf Firmendomain", () => {
  const c = discoverBusinessContact({ domain: "muster.ch", pages: { impressum: "<p>Muster AG<br>E-Mail: <a href='mailto:info@muster.ch'>info@muster.ch</a></p>" }, urls: { impressum: "https://muster.ch/impressum" }, now: T0 });
  assert.deepEqual([c.business_email, c.contact_name, c.contact_source, c.source_url, c.collected_at, c.contact_confidence], ["info@muster.ch", null, "impressum", "https://muster.ch/impressum", T0.toISOString(), "medium"]);
  assert.equal(qualifyRepairLead(lead({ email: c.business_email }), { now: T0 }).draft_creation_eligible, true);
});

test("benannter geschäftlicher Kontakt → bevorzugt (Web/Marketing/IT > Geschäftsführung > info@), Name nur wenn sicher zugeordnet", () => {
  const team = `<h2>Team</h2><div>Anna Muster<br>Geschäftsführerin<br>anna.muster@muster.ch</div>
    <div>Beat Beispiel<br>Leiter Marketing und Website<br><a href="mailto:beat.beispiel@muster.ch">beat.beispiel@muster.ch</a></div><p>info@muster.ch</p>`;
  const c = discoverBusinessContact({ domain: "muster.ch", pages: { team }, urls: { team: "https://muster.ch/team" }, now: T0 });
  assert.deepEqual([c.business_email, c.contact_name, c.contact_source, c.contact_confidence], ["beat.beispiel@muster.ch", "Beat Beispiel", "team", "high"]);
  assert.match(c.contact_role, /Marketing|Website/);
  const gf = discoverBusinessContact({ domain: "muster.ch", pages: { team: "<div>Anna Muster, Geschäftsführerin, anna.muster@muster.ch</div><p>info@muster.ch</p>" }, now: T0 });
  assert.equal(gf.business_email, "anna.muster@muster.ch");
  // Persönliche Adresse ohne sicher zuordenbaren Namen wird nicht verwendet → info@
  const unsure = discoverBusinessContact({ domain: "muster.ch", pages: { kontakt: "", contact: "<p>Kontakt: xy@muster.ch oder info@muster.ch</p>" }, now: T0 });
  assert.equal(unsure.business_email, "info@muster.ch");
  const q = qualifyRepairLead(lead({ email: c.business_email, contact_name: c.contact_name, contact_role: c.contact_role }), { now: T0 });
  assert.equal(q.draft_creation_eligible, true);
  const d = buildColdDraft(lead({ email: c.business_email }), q, SENDER);
  assert.match(d.body, /^Hallo Beat Beispiel,\n/);
  assert.doesNotMatch(d.body, /Frau|Herr/, "kein geratenes Geschlecht");
});

test("private persönliche E-Mail (Freemail/fremde Domain) → kein Entwurf", () => {
  const c = discoverBusinessContact({ domain: "muster.ch", pages: { contact: "<p>Hans Muster: hans.muster@gmail.com, privat: h.m@bluewin.ch, Partner: x@andere.ch</p>" }, now: T0 });
  assert.equal(c.business_email, null);
  assert.deepEqual(c.rejected.map((r) => r.reason).sort(), ["not_company_domain", "private_or_freemail", "private_or_freemail"]);
  const q = qualifyRepairLead(lead({ email: "hans.muster@gmail.com" }), { now: T0 });
  assert.equal(q.draft_creation_eligible, false);
  assert.throws(() => createColdDraft(lead({ email: "hans.muster@gmail.com" }), { sender: SENDER, now: T0 }), /Nur für COLD_LEAD_DRAFT_ONLY/);
});

test("kein Repair-Befund / redesign_likely / nicht Schweiz → kein Repair-Entwurf", () => {
  for (const l of [lead({ websiteIssues: [] }), lead({ websiteIssues: [issue("missing_alt", "low")] }),
    lead({ websiteIssues: [BROKEN, issue("outdated_technology", "high")] }),
    lead({ domain: "muster.de", website: "https://muster.de/", uid: null, discoverySource: "", email: "info@muster.de" })]) {
    const q = qualifyRepairLead(l, { now: T0 });
    assert.equal(q.draft_creation_eligible, false, JSON.stringify(l.websiteIssues.map((i) => i.type)) + l.domain);
    assert.throws(() => createColdDraft(l, { sender: SENDER, now: T0 }));
  }
});

test("suppression und do_not_contact → kein Entwurf (Qualifizierung, lokale Anlage und Worker)", async () => {
  assert.equal(qualifyRepairLead(lead(), { now: T0, suppressed: true }).draft_creation_eligible, false);
  assert.equal(qualifyRepairLead(lead({ status: "do_not_contact" }), { now: T0 }).draft_creation_eligible, false);
  write("suppression.json", { "info@muster.ch": { reason: "opt-out", at: T0.toISOString() } });
  assert.deepEqual(queue(), { blocked: "suppression" });
  write("suppression.json", { "chef@muster.ch": { reason: "opt-out", at: T0.toISOString() } });
  assert.deepEqual(queue(), { blocked: "suppression" }, "gesperrte Adresse derselben Firmendomain sperrt die Firma");
  // Abmeldung nach lokaler Anlage, vor dem Gmail-Entwurf: Worker legt nichts an.
  write("suppression.json", {});
  queue();
  write("suppression.json", { "info@muster.ch": { reason: "opt-out", at: T0.toISOString() } });
  await worker().tick();
  assert.deepEqual(creates(), []);
  assert.deepEqual([cold().status, cold().blocked_reason], ["blocked", "suppression"]);
});

test("Duplikate: offener Entwurf, gleiche Firma/Adresse, bereits kontaktiert, Sperrfrist", () => {
  const first = queue();
  assert.equal(first.status, "queued");
  assert.match(queue().blocked, /offener Entwurf/);
  assert.match(queue(lead({ domain: "muster-ag.ch", email: "info@muster-ag.ch" })).blocked, /offener Entwurf/, "gleiche Firma, andere Domain");
  assert.match(queue(lead({ domain: "anders.ch", company: "Anders GmbH", email: "info@muster.ch" })).blocked, /offener Entwurf/, "gleicher Empfänger");
  assert.match(coldDuplicate({}, lead(), { contacted: new Set(["info@muster.ch"]) }), /bereits kontaktiert/);
  const discarded = { "muster.ch": { ...first, status: "discarded", updated_at: T0.toISOString() } };
  assert.match(coldDuplicate(discarded, lead(), { now: new Date(+T0 + 30 * DAY) }), /Sperrfrist/);
  assert.equal(coldDuplicate(discarded, lead(), { now: new Date(+T0 + 200 * DAY) }), null);
  assert.match(coldDuplicate({ "muster.ch": { ...first, status: "manually_sent" } }, lead(), { now: new Date(+T0 + 400 * DAY) }), /bereits kontaktiert/);
});

// ---------- Entwurfsinhalt + Metadaten ----------

test("Entwurf: konkreter Befund, richtiges Angebot (CHF 150/500), kein Redesign, nichts erfunden, Footer, Absender", () => {
  const r = createColdDraft(lead(), { sender: SENDER, now: T0 });
  assert.match(r.body, /der Link zur Seite «Team alt» auf eine Fehlerseite führt/, "tatsächlicher Befund, einfach beschrieben");
  assert.equal(r.offer_class, "REPAIR_FIX_500", "Angebotsklasse bleibt intern erhalten");
  // Nur eine allgemeine Ladezeit-Vermutung: intern weiterhin CHECK_150, aber kein für Besucher sichtbarer Fehler → kein Cold-Entwurf.
  const slow = lead({ websiteIssues: [issue("slow_response", "medium", "Ladezeit der Startseite 7.2 s")] });
  assert.equal(qualifyRepairLead(slow, { now: T0 }).offer.offer_class, "REPAIR_CHECK_150");
  assert.throws(() => createColdDraft(slow, { sender: SENDER, now: T0 }), /Nur für COLD_LEAD_DRAFT_ONLY/);
  for (const b of [r.body]) {
    assert.doesNotMatch(b, /redesign|neue website|neubau anbieten|komplettwebsite|2['’]?490|veraltet|dringend|sofort handeln|gefährlich|hacker/i);
    const prices = Object.values(OFFERS).map((o) => o.price).join("|");
    assert.doesNotMatch(b, new RegExp(`CHF (?!(?:${prices})\\b)\\d`), "nur die zwei Angebotspreise");
    assert.match(b, /Ich behebe solche kleineren Website-Probleme für Schweizer Unternehmen\./);
    assert.ok(b.includes(COLD_FOOTER), "sachliche Abmeldemöglichkeit");
    assert.match(b, /Chris Kälin/);
  }
  assert.deepEqual(r.issue_evidence.map((e) => e.url), [BROKEN.url], "nur beobachtete Befunde");
  assert.deepEqual(OFFER_CLASSES, ["REPAIR_CHECK_150", "REPAIR_FIX_500"]);
  assert.equal(Object.keys(OFFERS).length, 2, "genau zwei Angebote");
});

test("Entwurf ist COLD_LEAD_DRAFT_ONLY mit fester Rechtslage – keine Aktion kann sie ändern", () => {
  const r = createColdDraft(lead(), { sender: SENDER, now: T0 });
  const legal = (x) => [x.draft_mode, x.message_class, x.automatic_send_allowed, x.legal_basis, x.manual_send_decision_required, x.legal_status];
  const expected = [COLD_MODE, "DRAFT_ONLY", false, "NONE", true, "NO_AUTOMATIC_SEND_BASIS"];
  assert.deepEqual(legal(r), expected);
  write(COLD_DRAFTS_FILE, { reviews: { "muster.ch": { ...r, status: "draft_created", gmail_draft_id: "dr1" } } });
  const e = coldDraftAction(store, "edit", { lead_id: "muster.ch", body: r.body + "\nPS", legal_basis: "OPT_IN", automatic_send_allowed: true }, T0);
  assert.deepEqual(legal(e), expected, "Bearbeitung setzt keine Rechtsgrundlage");
  assert.equal(e.pending_update, true);
  const m = coldDraftAction(store, "mark-manual-sent", { lead_id: "muster.ch", legal_basis: "EXISTING_CUSTOMER_SIMILAR_SERVICE" }, T0);
  assert.deepEqual(legal(m), expected);
  assert.deepEqual(legal(markManualSend(r, { messageId: "x", threadId: "t", sentAt: T0.toISOString() })), expected);
});

// ---------- Kein Versand durch Jarvis ----------

test("Worker legt Gmail-Entwurf an, sendet ihn nie – auch nicht im Kampagnenfenster (Mail-Worker/Campaign/VPS)", async () => {
  queue();
  const r = await worker().tick();
  assert.equal(r.window, "morning", "Kampagnenfenster läuft");
  assert.deepEqual(creates(), ["create info@muster.ch"]);
  assert.deepEqual(sends(), []);
  assert.deepEqual(r.sends, []);
  const d = cold();
  assert.equal(d.status, "draft_created");
  assert.deepEqual([d.gmail_draft_id, d.message_id, d.thread_id, d.jarvis_draft_id.startsWith("cold:muster.ch:"), d.lead_id, d.recipient], ["dr1", "mdr1", "tdr1", true, "muster.ch", "info@muster.ch"]);
  assert.equal(g.reg.drafts.dr1.mode, COLD_MODE, "Gmail-Register kennt den Modus");
  const st = read("state.json");
  assert.ok(!Object.values(st.actions).some((a) => a.draftId === "dr1"), "nie in der Send-Queue");
  assert.ok(!Object.keys(st.prepared).includes("dr1"), "zählt nicht als Send/Kapazität");
  assert.ok(!st.compliantThreads.tdr1, "keine Versandgrundlage für den Thread");
  // Nachmittagsfenster und VPS-Rolle: ebenfalls nichts.
  clock = new Date("2026-10-06T12:45:00Z");
  await worker().tick();
  const vps = createWorker({ dir, gmail: g, now: () => clock, log: () => {}, compose: async () => ({ decision: "draft", body: "x" }), sendGuard: { acquire: async () => ({ ok: true }), done: async () => {} } });
  await vps.tick();
  assert.deepEqual(sends(), []);
  assert.equal(creates().length, 1, "kein zweiter Entwurf");
  // Selbst wenn jemand den Cold-Entwurf in die Queue schmuggelt: harte Sperre im Versandpfad.
  const s = read("state.json");
  s.actions["outreach:info@muster.ch"] = { status: "prepared", at: clock.toISOString(), kind: "erstkontakt", threadId: "tdr1", draftId: "dr1", to: "info@muster.ch", autoSend: true, paced: true };
  s.compliantThreads.tdr1 = { to: "info@muster.ch", basis: "opt_in" };
  s.windows = {};
  write("state.json", s);
  clock = T0;
  await worker().tick();
  assert.deepEqual(sends(), []);
  assert.equal(read("state.json").actions["outreach:info@muster.ch"].status, "cold_draft_never_auto");
});

test("gmail.js: Cold-Entwurf ist auf unterster Ebene nicht sendbar; fremde Entwürfe nie angefasst (ohne Netzwerk)", async () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-025-gmail-"));
  fs.writeFileSync(path.join(secrets, "gmail_jarvis.json"), JSON.stringify({ labelId: "L", drafts: { c1: { mode: COLD_MODE, to: "info@muster.ch", messageId: "m1", threadId: "t1" } }, sent: {}, sending: {} }));
  fs.writeFileSync(path.join(secrets, "gmail_token.json"), JSON.stringify({ access_token: "x", refresh_token: "r", expiry: Date.now() + 3600e3 }));
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { calls.push(`${opts.method || "GET"} ${url}`); return new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), { status: 404 }); };
  process.env.JARVIS_SECRETS_DIR = secrets;
  try {
    const gm = await import(`../gmail.js?t=${Date.now()}`);
    await assert.rejects(gm.sendDraft("c1"), /Cold-Lead-Entwurf/);
    await assert.rejects(gm.sendDraft("c1", { window: "morning" }), /Cold-Lead-Entwurf/);
    assert.deepEqual(calls, [], "kein Gmail-Aufruf beim Versuch, einen Cold-Entwurf zu senden");
    for (const op of [() => gm.deleteDraft("fremd"), () => gm.updateDraft("fremd", { body: "x" }), () => gm.sendDraft("fremd"), () => gm.markDraftForReview("fremd")])
      await assert.rejects(op(), /nicht von Jarvis erstellt/);
    assert.deepEqual(calls, [], "fremde Entwürfe: weder gelesen, geändert, gelöscht noch gesendet");
    // Entwurf in Gmail verschwunden, eigener Thread existiert nicht → nicht als Jarvis-Thread registriert
    const out = await gm.syncColdDrafts();
    assert.deepEqual(out.map((o) => o.status), ["gone"]);
    assert.deepEqual(Object.keys(gm.listOwned().sent), []);
  } finally { globalThis.fetch = realFetch; delete process.env.JARVIS_SECRETS_DIR; }
});

test("gmail.js: manueller Versand durch Chris wird nur bei eindeutigem eigenem Thread registriert – legalBasis NONE, kein Limitverbrauch", async () => {
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-025-gmail2-"));
  const created = "2026-10-06T08:00:00.000Z";
  fs.writeFileSync(path.join(secrets, "gmail_jarvis.json"), JSON.stringify({ labelId: "L", sent: {}, sending: {}, drafts: {
    c1: { mode: COLD_MODE, leadId: "muster.ch", to: "info@muster.ch", subject: "Muster AG: defekter Link auf muster.ch", messageId: "m1", threadId: "t1", createdAt: created },
    c2: { mode: COLD_MODE, leadId: "anders.ch", to: "info@anders.ch", subject: "Anders", messageId: "m2", threadId: "t2", createdAt: created } } }));
  fs.writeFileSync(path.join(secrets, "gmail_token.json"), JSON.stringify({ access_token: "x", refresh_token: "r", expiry: Date.now() + 3600e3 }));
  const msg = (id, threadId, to, subject, labels, at) => ({ id, threadId, labelIds: labels, internalDate: String(Date.parse(at)), payload: { headers: [{ name: "To", value: to }, { name: "Subject", value: subject }] } });
  const routes = {
    "/threads/t1": { id: "t1", messages: [msg("s1", "t1", "info@muster.ch", "Muster AG: defekter Link auf muster.ch", ["SENT"], "2026-10-06T09:00:00Z")] },
    // t2: an einen anderen Empfänger verschickt → Zuordnung nicht eindeutig
    "/threads/t2": { id: "t2", messages: [msg("s2", "t2", "jemand@else.ch", "Anders", ["SENT"], "2026-10-06T09:00:00Z")] },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const p = new URL(url).pathname.replace(/^.*\/users\/me/, "");
    const hit = Object.entries(routes).find(([k]) => p === k);
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response(JSON.stringify({ error: { message: "Requested entity was not found." } }), { status: 404 });
  };
  process.env.JARVIS_SECRETS_DIR = secrets;
  try {
    const gm = await import(`../gmail.js?t=${Date.now()}b`);
    const out = await gm.syncColdDrafts();
    assert.deepEqual(out.map((o) => [o.leadId, o.status]), [["muster.ch", "manually_sent"], ["anders.ch", "unclear"]]);
    const reg = gm.listOwned();
    assert.deepEqual(Object.keys(reg.sent), ["s1"]);
    assert.deepEqual([reg.sent.s1.threadId, reg.sent.s1.manual, reg.sent.s1.legalBasis, reg.sent.s1.mode], ["t1", true, "NONE", COLD_MODE]);
    assert.equal(gm.sentToday(reg, new Date("2026-10-06T10:00:00Z")), 0, "manueller Versand von Chris belastet kein Jarvis-Limit");
    assert.deepEqual(Object.keys(reg.drafts), []);
  } finally { globalThis.fetch = realFetch; delete process.env.JARVIS_SECRETS_DIR; }
});

test("Cloud-Queue kann Cold-Entwurf/Cold-Thread nicht senden", async () => {
  queue();
  await worker().tick();
  g.chrisSendsManually("dr1");
  await worker().tick();
  const thread = Object.values(g.reg.sent)[0].threadId;
  const threadRef = (id) => crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 12); // wie mail-worker.js
  write("cloud_requests.json", {
    a: { status: "pending", request: { recipient: "info@muster.ch", subject: "Nachfass", body: "Guten Tag, kurze Nachfrage.", expires_at: new Date(+T0 + DAY).toISOString() } },
    b: { status: "pending", request: { recipient: "info@muster.ch", subject: "x", body: "Nachfrage", optional_thread_reference: threadRef(thread), expires_at: new Date(+T0 + DAY).toISOString() } },
  });
  await worker().tick();
  const inbox = read("cloud_requests.json");
  assert.equal(inbox.a.status, "blocked");
  assert.equal(inbox.b.status, "blocked");
  assert.deepEqual(sends(), []);
});

// ---------- Nach manuellem Versand ----------

test("manueller Versand: registriert, keine Rechtsgrundlage, Thread eigen, Antwort nach sicheren Regeln, kein Follow-up", async () => {
  queue();
  await worker().tick();
  g.chrisSendsManually("dr1");
  await worker().tick();
  const d = cold();
  assert.deepEqual([d.status, d.manual_send_detected, d.gmail_message_id, d.thread_id, d.legal_basis, d.automatic_send_allowed], ["manually_sent", true, "msdr1", "tdr1", "NONE", false]);
  assert.ok(d.manual_send_at);
  const st = read("state.json");
  assert.ok(!st.compliantThreads.tdr1, "manueller Versand erzeugt keine Versandgrundlage");
  assert.equal(legalBasis({ ...lead(), approved: true }, T0), null);
  const { leads } = loadPipeline({ dir, registry: g.listOwned(), now: T0 });
  assert.equal(leads.length, 0, "Pipeline liest nur gefundene Leads – hier keine");
  // 10 Tage später, keine Antwort: kein Follow-up.
  clock = new Date(+T0 + 10 * DAY);
  const r = await worker().tick();
  assert.ok(!r.plan.some((p) => String(p.kind).startsWith("follow-up")));
  assert.ok(!g.calls.some((c) => c.startsWith("reply")));
  // Antwort mit Interesse: Antwort-Entwurf im selben Thread, aber nie automatisch gesendet (keine Grundlage).
  g.threads.tdr1.push({ messageId: "in1", from: "Anna <info@muster.ch>", replyTo: "", to: SENDER.email, subject: "Re: x", body: "Danke, was würde die Reparatur kosten?", sent: false, draft: false, internalDate: +clock + 1000 });
  clock = new Date(+clock + 3600e3);
  const r2 = await worker().tick();
  assert.deepEqual(r2.plan.map((p) => [p.kind, p.threadId, p.autoSend]), [["antwort", "tdr1", false]]);
  assert.ok(g.calls.includes("reply tdr1"));
  assert.deepEqual(sends(), []);
});

test("Opt-out nach manuellem Versand: Suppression, kein neuer Entwurf, keine Kampagne, kein Follow-up", async () => {
  queue();
  await worker().tick();
  g.chrisSendsManually("dr1");
  await worker().tick();
  for (const t of ["Bitte entfernen Sie mich aus Ihrem Verteiler.", "Für uns nicht relevant.", "Keine weiteren E-Mails bitte", "stop"]) assert.ok(OPT_OUT_RE.test(t), t);
  assert.ok(!OPT_OUT_RE.test("Können Sie den Fehler entfernen?"), "Bitte um Reparatur ist kein Opt-out");
  g.threads.tdr1.push({ messageId: "in1", from: "info@muster.ch", replyTo: "", to: SENDER.email, subject: "Re", body: "Bitte entfernen Sie mich aus Ihrem Verteiler.", sent: false, draft: false, internalDate: +clock + 1000 });
  clock = new Date(+clock + 3600e3);
  await worker().tick();
  assert.ok(read("suppression.json")["info@muster.ch"], "suppression = true");
  const { leads } = loadPipeline({ dir, now: clock });
  assert.equal(leads.length, 0);
  write("discovered.json", { leads: { "muster.ch": lead() } });
  const p = loadPipeline({ dir, now: clock });
  assert.deepEqual([p.leads[0].repair.stage, p.leads[0].repair.draft_creation_eligible], ["do_not_contact", false]);
  // Neuer Discovery-Treffer derselben Firma (auch andere Adresse): kein neuer Entwurf.
  write(COLD_DRAFTS_FILE, { reviews: {} });
  assert.deepEqual(queue(lead({ email: "beat@muster.ch" })), { blocked: "suppression" });
  clock = new Date(+clock + 20 * DAY);
  await worker().tick();
  assert.deepEqual(sends(), []);
  assert.equal(creates().length, 1);
});

// ---------- Dashboard / Endpunkte ----------

test("Dashboard-Aktionen: nur je ein Entwurf; kein SEND ALL, FORCE SEND, LEGAL OVERRIDE, AUTO SEND COLD LEAD, BATCH SEND", async () => {
  queue();
  for (const p of [[{ lead_id: "muster.ch" }], { lead_ids: ["muster.ch"] }, { lead_id: ["muster.ch"] }, { all: true }])
    assert.throws(() => coldDraftAction(store, "discard", p, T0), /Sammelaktion|Genau eine/);
  for (const op of ["send", "force-send", "approve", "legal-override", "auto-send"]) assert.throws(() => coldDraftAction(store, op, { lead_id: "muster.ch" }, T0), /Unbekannte Aktion/);
  assert.ok(!Object.keys(swiss).some((k) => /send|force|override|batch|bulk|all$/i.test(k) && !/^markManualSend$/.test(k)), Object.keys(swiss).join(","));
  const src = ["server.js", "public/index.html", "swiss-repair.js"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  assert.doesNotMatch(src, /send[ _-]?anyway|force[ _-]?send|legal[ _-]?override|auto[ _-]?send[ _-]?cold|send[ _-]?all|batch[ _-]?send|approve[ _-]?all|cold-drafts\/(send|force|approve|bulk|batch|all)/i);
  assert.match(src, /OPEN DRAFT/); assert.match(src, /EDIT DRAFT/); assert.match(src, /DISCARD DRAFT/);
  assert.match(src, /ENTWURF ERSTELLT — NICHT AUTOMATISCH VERSANDBERECHTIGT/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8"), /LEGAL APPROVED/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "server.js"), "utf8"), /sendDraft|createDraft|updateDraft|deleteDraft|replyToThread/, "Server spricht Gmail nie schreibend an");
});

test("EDIT/DISCARD wirken über den Worker nur auf den eigenen Entwurf", async () => {
  queue();
  await worker().tick();
  coldDraftAction(store, "edit", { lead_id: "muster.ch", subject: "Muster AG: defekter Link", body: "Guten Tag\n\nneuer Text" }, T0);
  await worker().tick();
  assert.ok(g.calls.includes("update dr1"));
  assert.equal(g.reg.drafts.dr1.body, "Guten Tag\n\nneuer Text");
  coldDraftAction(store, "discard", { lead_id: "muster.ch" }, T0);
  await worker().tick();
  assert.ok(g.calls.includes("delete dr1"));
  assert.equal(cold().status, "discarded");
  assert.deepEqual(sends(), []);
  // Fremder Entwurf in Gmail bleibt unangetastet, auch wenn jemand dessen ID einträgt.
  g.foreign = { to: "x@y.ch" };
  write(COLD_DRAFTS_FILE, { reviews: { "muster.ch": { ...cold(), status: "draft_created", gmail_draft_id: "fremd", discard_requested: true } } });
  await worker().tick();
  assert.ok(!g.calls.some((c) => /(update|delete|SEND) fremd/.test(c) && !c.startsWith("delete fremd")));
  assert.equal(cold().status, "draft_created", "Löschen fremder Entwürfe scheitert an der Besitzprüfung");
});

test("Kennzahlen: Cold Leads, Kontakte, Drafts, manuell versendet, Auto-Send, Blocked, Opt-outs – nur Zahlen im gemeinsamen Zustand", async () => {
  write("discovered.json", { leads: {
    "muster.ch": lead(), "b.ch": lead({ domain: "b.ch", company: "B AG", email: "info@b.ch" }), "c.ch": lead({ domain: "c.ch", company: "C AG", email: "info@c.ch" }),
    "opt.ch": lead({ domain: "opt.ch", company: "Opt AG", email: "info@opt.ch", ...optIn("info@opt.ch") }),
    "priv.ch": lead({ domain: "priv.ch", company: "Priv AG", email: "x@gmail.com" }),
  } });
  for (const d of ["muster.ch", "b.ch", "c.ch"]) queue(lead({ domain: d, company: d === "muster.ch" ? "Muster AG" : d[0].toUpperCase() + " AG", email: `info@${d}` }));
  await worker().tick();
  g.chrisSendsManually("dr1");
  write("suppression.json", { "weg@z.ch": { reason: "opt-out", at: T0.toISOString() } });
  await worker().tick();
  const { leads, optOuts } = loadPipeline({ dir, registry: g.listOwned(), now: T0 });
  const m = computeMetrics(leads, T0, { optOuts });
  assert.deepEqual([m.cold_leads_found, m.business_contacts_found, m.drafts_created, m.drafts_open, m.drafts_manually_sent, m.auto_send_eligible, m.opt_outs],
    [3, 4, 3, 2, 1, 1, 1]);
  assert.ok(m.blocked >= 1, "Freemail-Lead ist blockiert");
  const shared = sanitizeState({ sales: { ...m, recipient: "info@muster.ch" } });
  assert.equal(shared.sales.drafts_open, 2);
  assert.ok(!JSON.stringify(shared).includes("muster"));
  assert.deepEqual(findSensitiveKeys(shared), []);
});

test("Discovery: Schweizer Repair-Lead → Kontakt aus Team-Seite, lokaler Cold-Entwurf, Gmail unberührt, keine Fake-Einwilligung", async () => {
  const host = "muster.ch", web = {
    [`https://${host}/`]: `<!doctype html><html lang="de"><head><title>Muster Schreinerei AG</title><meta name="viewport" content="width=device-width"></head><body><a href="/kontakt">Kontakt</a> <a href="/impressum">Impressum</a> <a href="/team">Team</a> <a href="/alt">Alt</a></body></html>`,
    [`https://${host}/kontakt`]: "<html><body>Kontakt: info@muster.ch</body></html>",
    [`https://${host}/team`]: "<html><body><div>Beat Beispiel<br>Leiter Marketing<br>beat.beispiel@muster.ch</div></body></html>",
    [`https://${host}/impressum`]: "<html><body><p>Muster Schreinerei AG<br>Hauptstrasse 1, CH-8400 Winterthur<br><a href=\"mailto:info@muster.ch\">info@muster.ch</a><br>UID: CHE-123.456.789</p></body></html>",
    [`https://${host}/robots.txt`]: "",
  };
  const fetchFn = async (url) => {
    const u = new URL(url), key = `${u.protocol}//${u.host}${u.pathname}`;
    if (u.protocol === "http:") return new Response("", { status: 301, headers: { location: `https://${host}/` } });
    return key in web ? new Response(web[key], { status: 200, headers: { "content-type": "text/html" } }) : new Response("nf", { status: 404, headers: { "content-type": "text/html" } });
  };
  const r = await runDiscovery({ dir, gmail: g, search: async () => [{ company: "Muster Schreinerei AG", website: `https://${host}`, email: "", chain: false, source: "OpenStreetMap node/1 (Winterthur, craft)" }],
    auditor: createAuditor({ fetchFn, delayMs: 0, now: () => T0 }), now: () => T0, log: () => {}, force: true });
  const l = r.found[0];
  assert.deepEqual([l.country, l.site_condition, l.repair_stage, l.contact_basis], ["CH", "modern_maintainable", "cold_lead_draft_only", COLD_MODE]);
  assert.deepEqual([l.email, l.contact_name, l.contact_source, l.source_url, l.contact_confidence], ["beat.beispiel@muster.ch", "Beat Beispiel", "team", "https://muster.ch/team", "high"]);
  assert.match(l.contact_role, /Marketing/);
  assert.deepEqual([l.approved, l.consentBasis], [false, null]);
  const d = cold();
  assert.deepEqual([d.status, d.recipient, d.draft_mode, d.legal_basis], ["queued", "beat.beispiel@muster.ch", COLD_MODE, "NONE"]);
  // Vom echten Auditor: Linktext «Alt» → einfache, prüfbare Aussage; die technische Ziel-URL bleibt intern.
  assert.match(d.body, /auf Ihrer Startseite der Link «Alt» auf eine Fehlerseite führt/);
  assert.ok(!d.body.includes("https://muster.ch/alt") && !/404/.test(d.body));
  assert.ok(d.issue_evidence.some((e) => e.url === "https://muster.ch/alt" && /HTTP 404/.test(e.evidence)));
  assert.deepEqual(g.calls, [], "Discovery fasst Gmail nie an");
});

test("TF-022/Auto-Send-Regeln unverändert: opt_in / Bestandskunde / angefragter Kontakt; 50 + 50 / 100; 0 berechtigt → 0 Sends", async () => {
  assert.equal(legalBasis(lead({ ...optIn("info@muster.ch") }), T0), "opt_in");
  assert.equal(legalBasis(lead({ ...CUSTOMER }), T0), "existing_customer");
  assert.equal(legalBasis(lead({ approved: true, consentBasis: "requested_contact", request_source: "Formular", request_date: "2026-09-20", request_scope: "Website-Reparatur", request_evidence: "Formular-Eintrag «Bitte Offerte Website-Reparatur»", response_scope: "Website-Reparatur", recipient_or_submission_channel: "info@muster.ch", requestConfidence: "HIGH" }), T0), "requested_contact");
  assert.equal(HARD_LIMIT, 100);
  assert.equal(WINDOW_LIMIT, 50);
  assert.deepEqual(SEND_WINDOWS.map((w) => [w.start, w.limit]), [["09:30", 50], ["14:30", 50]]);
  for (const d of ["a.ch", "b.ch"]) queue(lead({ domain: d, company: d, email: `info@${d}` }));
  const r = await worker().tick();
  assert.equal(r.window, "morning");
  assert.deepEqual(r.sends, []);
  assert.equal(creates().length, 2, "Entwürfe unbegrenzt durch Sendelimits, aber nie gesendet");
  assert.equal(r.eligibleLeads, 0);
});
