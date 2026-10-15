// TF-063 Tests – Lead-Isolation (A–L) und faire Verteilung (Mario/Damiano je 200).
import test from "node:test";
import assert from "node:assert/strict";
import { setup, makeReq, chLeads, CONTROL } from "./tf063-helpers.js";
import { crmAgentToken } from "../crm-api.js";
import { fairDistribution, eligibleForPortfolio, applyDistribution, distributionReport, sellerOf, emptyAssignments } from "../sales-scope.js";
import { createCloudHandler, sellerSystem } from "../netlify/edge-functions/cloud.js";
import { actorFor } from "../auth-core.js";

const list = async (t, u, q = "") => (await t.json(await t.crm(makeReq("/api/crm" + q, { cookie: t.cookies[u] })))).body;
const write = (t, u, lead_id) => t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies[u], body: { action: "crm.addNote", params: { lead_id, text: "Test-Notiz" } } }));

test("TF-063 Isolation A–I: Sichtbarkeit je Rolle (serverseitig gefiltert)", async () => {
  const t = await setup();
  assert.equal(t.assignReport.stored, true);
  const all = await list(t, "chris"), giu = await list(t, "giuliano"), mar = await list(t, "mario"), dam = await list(t, "damiano"), lap = await list(t, "lap");
  const ids = (x) => new Set(x.leads.map((l) => l.lead_id));
  const M = ids(mar), D = ids(dam), G = ids(giu), L = ids(lap);
  assert.equal(M.size, 200, "A Mario 200"); assert.equal(D.size, 200, "B Damiano 200");
  assert.equal([...M].filter((x) => D.has(x)).length, 0, "C kein Overlap");
  assert.equal([...G].filter((x) => M.has(x) || D.has(x)).length, 0, "D Giuliano sieht keinen der 400");
  const chAll = all.leads.filter((l) => l.market === "CH");
  assert.equal(G.size, chAll.length - 400, "E Giuliano sieht alle übrigen CH-Leads");
  assert.ok(lap.leads.every((l) => l.market === "VN") && L.size === 20, "G Lap nur VN");
  for (const x of [giu, mar, dam]) assert.ok(x.leads.every((l) => l.market === "CH"), "H CH-Verkäufer 0 VN");
  assert.equal(all.leads.length, 900 + 20, "I Chris sieht CH + VN");
  assert.ok(all.leads.filter((l) => M.has(l.lead_id)).every((l) => l.seller === "mario"), "Owner sieht Zuständigkeit");
  // Keine CH-Spuren in Laps Antwort (IDs, Domains, Zählwerte fremder Portfolios, Audit, Aufträge).
  const raw = JSON.stringify(lap);
  assert.ok(!/\.ch\b/.test(raw), "keine CH-Domain in Laps Antwort");
  assert.equal(lap.stats.all, 20); assert.equal(lap.backup, null); assert.equal(lap.vn_status, undefined);
});

test("TF-063 Isolation F: neuer, nicht zugewiesener CH-Lead → automatisch Giuliano", async () => {
  const t = await setup();
  const v = t.stores.view.peek();
  const extra = chLeads(901).at(-1);
  await t.stores.view.set({ ...v, leads: [...v.leads, { ...extra, lead_id: "neu-firma.ch", domain: "neu-firma.ch" }] }, (await t.stores.view.get()).etag);
  assert.ok((await list(t, "giuliano")).leads.some((l) => l.lead_id === "neu-firma.ch"));
  assert.ok(!(await list(t, "mario")).leads.some((l) => l.lead_id === "neu-firma.ch"));
  assert.ok(!(await list(t, "lap")).leads.some((l) => l.lead_id === "neu-firma.ch"));
});

test("TF-063 Isolation J: CSV-Export exakt im Scope (Lap vietnamesische Kopfzeile)", async () => {
  const t = await setup();
  const csv = async (u) => (await t.crm(makeReq("/api/crm?export=csv&archived=all", { cookie: t.cookies[u] }))).text();
  const rows = (s) => s.trim().split("\r\n").length - 1;
  assert.equal(rows(await csv("mario")), 200);
  assert.equal(rows(await csv("damiano")), 200);
  const lap = await csv("lap");
  assert.equal(rows(lap), 20);
  assert.ok(lap.includes("Công ty") && !lap.includes("Firma;") && !/\.ch\b/.test(lap));
  assert.equal(rows(await csv("chris")), 920);
});

test("TF-063 Isolation K/L: Schreiben nur im eigenen Scope – direkter API-Aufruf 403", async () => {
  const t = await setup();
  const mar = (await list(t, "mario")).leads[0].lead_id, dam = (await list(t, "damiano")).leads[0].lead_id, giu = (await list(t, "giuliano")).leads[0].lead_id;
  const vn = (await list(t, "lap")).leads.find((l) => !l.do_not_contact).lead_id;
  assert.equal((await write(t, "mario", dam)).status, 403, "Mario → Damiano-Lead");
  assert.equal((await write(t, "damiano", giu)).status, 403, "Damiano → Giuliano-Lead");
  assert.equal((await write(t, "lap", giu)).status, 403, "Lap → CH-Lead");
  assert.equal((await write(t, "giuliano", mar)).status, 403, "Giuliano → Mario-Lead");
  assert.equal((await write(t, "mario", vn)).status, 403, "Mario → VN-Lead");
  assert.equal((await write(t, "lap", "gibt-es-nicht.ch")).status, 403, "Verkäufer: unbekannt = kein Existenz-Orakel");
  assert.equal((await write(t, "mario", mar)).status, 202, "eigener Lead erlaubt");
  assert.equal((await write(t, "lap", vn)).status, 202, "Lap eigener VN-Lead → VN-Queue");
  assert.equal((await write(t, "chris", dam)).status, 202, "Chris darf alles");
  assert.equal(t.stores.vnQueue.peek().requests.length, 1, "VN-Auftrag in der VN-Queue");
  assert.ok(t.stores.queue.peek().requests.every((r) => r.params.lead_id !== vn));
  // getLead / Auftragsstatus fremder Leads ebenfalls gesperrt
  const g = await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies.lap, body: { action: "crm.getLead", params: { lead_id: giu } } }));
  assert.equal(g.status, 403);
  const marReq = t.stores.queue.peek().requests.find((r) => r.actor_user_id === "mario").request_id;
  assert.equal((await t.crm(makeReq(`/api/crm?request=${marReq}`, { cookie: t.cookies.damiano }))).status, 404, "fremde Aufträge unsichtbar");
  assert.ok(t.stores.queue.peek().audit.some((a) => a.code === "OUT_OF_SCOPE" && a.actor_user_id === "mario"), "Verstoss auditiert");
});

test("TF-063 Lap-Entwurf nur für eigenen VN-Lead, Empfänger serverseitig, nie frei wählbar", async () => {
  const t = await setup();
  const leads = (await list(t, "lap")).leads;
  const withMail = leads.find((l) => l.email && !l.do_not_contact), dnc = leads.find((l) => l.do_not_contact), noMail = leads.find((l) => !l.email && !l.do_not_contact);
  const giu = (await list(t, "giuliano")).leads[0].lead_id;
  const draft = (u, body) => t.json(t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies[u], body: { op: "lead_draft", ...body } })));
  const ok = await t.json(await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies.lap, body: { op: "lead_draft", lead_id: withMail.lead_id, subject: "Chào anh/chị", body: "Nội dung" } })));
  assert.equal(ok.status, 201);
  const q = t.stores.mail.peek().requests.at(-1);
  assert.equal(q.recipient, withMail.email); assert.equal(q.delivery, "draft"); assert.equal(q.requested_by, "lap");
  assert.ok(!JSON.stringify(ok.body).includes(withMail.email), "Antwort verrät die Adresse nicht");
  const bad = await (await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies.lap, body: { op: "lead_draft", lead_id: withMail.lead_id, recipient: "fremd@example.com", subject: "s", body: "b" } }))).json();
  assert.equal(bad.code, "BAD_PARAMS", "kein beliebiger Empfänger");
  assert.equal((await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies.lap, body: { op: "lead_draft", lead_id: giu, subject: "s", body: "b" } }))).status, 403, "CH-Lead");
  assert.equal((await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies.lap, body: { op: "lead_draft", lead_id: dnc.lead_id, subject: "s", body: "b" } }))).status, 409, "DNC");
  if (noMail) assert.equal((await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies.lap, body: { op: "lead_draft", lead_id: noMail.lead_id, subject: "s", body: "b" } }))).status, 400);
  assert.equal((await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies.mario, body: { op: "lead_draft", lead_id: withMail.lead_id, subject: "s", body: "b" } }))).status, 403, "Mario nicht für VN");
  const mine = await t.json(await t.mail(makeReq("/api/mail-requests", { cookie: t.cookies.mario })));
  assert.equal(mine.body.requests.length, 0, "Mario sieht keine fremden Mailaufträge");
  void draft;
});

test("TF-063 Zuweisung: einmalig, gesperrt, keine stille Neuverteilung; Owner-Neuzuweisung auditiert", async () => {
  const t = await setup();
  const again = await t.crm(makeReq("/api/crm", { method: "POST", origin: null, headers: { "x-jarvis-crm": crmAgentToken(CONTROL) }, body: { op: "assign_init", dry_run: false } }));
  assert.equal(again.status, 409, "zweite Verteilung abgelehnt");
  const doc = t.salesMem.assignments.peek();
  assert.ok(Object.values(doc.assignments).every((a) => a.locked === true && a.market === "CH" && a.assignment_source === "tf063_fair_distribution"));
  const lead = Object.keys(doc.assignments).find((k) => doc.assignments[k].assigned_user_id === "mario");
  assert.equal((await t.sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies.giuliano, body: { op: "reassign", lead_id: lead, user_id: "giuliano" } }))).status, 403);
  assert.equal((await t.sales(makeReq("/api/sales", { method: "POST", cookie: t.cookies.chris, body: { op: "reassign", lead_id: lead, user_id: "damiano" } }))).status, 200);
  assert.ok((await list(t, "damiano")).leads.some((l) => l.lead_id === lead));
  assert.ok(t.salesMem.assignments.peek().audit.some((a) => a.action === "assignments.reassign" && a.from === "mario" && a.to === "damiano"));
  const rep = (await t.json(await t.sales(makeReq("/api/sales?view=assignments", { cookie: t.cookies.chris })))).body;
  assert.equal(rep.report.mario.count + rep.report.damiano.count, 400);
  assert.equal((await t.sales(makeReq("/api/sales?view=assignments", { cookie: t.cookies.mario }))).status, 403);
});

test("TF-063 Fairness: 200/200, Overlap 0, nur geeignete Leads, ähnliche Verteilung, deterministisch", () => {
  const leads = chLeads(900);
  const d1 = fairDistribution(leads), d2 = fairDistribution([...leads].reverse());
  assert.deepEqual(d1.mario, d2.mario, "unabhängig von der Eingabereihenfolge");
  assert.equal(d1.mario.length, 200); assert.equal(d1.damiano.length, 200);
  const byId = new Map(leads.map((l) => [l.lead_id, l]));
  for (const id of [...d1.mario, ...d1.damiano]) assert.ok(eligibleForPortfolio(byId.get(id)), `${id} geeignet`);
  assert.ok([...d1.mario, ...d1.damiano].every((id) => { const l = byId.get(id); return !l.do_not_contact && !l.customer && l.sales_stage !== "NOT_INTERESTED"; }));
  const doc = applyDistribution(emptyAssignments(), d1, { now: new Date("2026-10-15T12:00:00Z") });
  const r = distributionReport(leads, doc);
  assert.equal(r.overlap, 0); assert.equal(r.giuliano_excluded, 400);
  const diff = (k) => Math.abs(r.mario[k] - r.damiano[k]);
  for (const k of ["HIGH", "MEDIUM", "LOW", "with_phone", "with_email"]) assert.ok(diff(k) <= 4, `${k}: ${r.mario[k]} vs ${r.damiano[k]}`);
  assert.ok(Math.abs(r.mario.avg_priority - r.damiano.avg_priority) <= 0.15, `Ø ${r.mario.avg_priority} vs ${r.damiano.avg_priority}`);
  for (const c of new Set([...Object.keys(r.mario.cantons), ...Object.keys(r.damiano.cantons)])) assert.ok(Math.abs((r.mario.cantons[c] || 0) - (r.damiano.cantons[c] || 0)) <= 6, `Kanton ${c}`);
  for (const c of new Set([...Object.keys(r.mario.categories), ...Object.keys(r.damiano.categories)])) assert.ok(Math.abs((r.mario.categories[c] || 0) - (r.damiano.categories[c] || 0)) <= 6, `Branche ${c}`);
  assert.equal(sellerOf({ lead_id: d1.mario[0], market: "CH" }, doc), "mario");
  assert.equal(sellerOf({ lead_id: "x.vn", market: "VN" }, doc), "lap");
});

test("TF-063 Cloud-Jarvis: Verkäufer ohne Chris-Persona, ohne Shared State, ohne Mail-Werkzeug", async () => {
  let sent = null, loaded = 0;
  const h = createCloudHandler({ env: (k) => ({ ANTHROPIC_API_KEY: "sk-test", JARVIS_PASSWORD: "pw" })[k],
    fetchFn: async (u, init) => { sent = JSON.parse(init.body); return new Response("data: {\"type\":\"message_stop\"}\n\n", { status: 200 }); },
    loadState: async () => { loaded++; return { profile: { notes: "GEHEIM Chris" } }; },
    resolveActor: async () => ({ actor: actorFor("lap") }), sellerContext: async () => ({ leads: { total: 20, with_phone: 20, with_email: 10 }, commission: { rate_bps: 3500, currency: "VND", pending: "0", payable: "346500", reversed: "0" } }) });
  const r = await h(new Request("https://jarvis.test/api/cloud", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "Xin chào" }] }) }));
  await r.text();
  assert.equal(loaded, 0, "kein Shared State geladen");
  assert.equal(sent.tools, undefined, "kein Mail-Werkzeug");
  const sys = sent.system.map((x) => x.text).join("\n");
  assert.ok(!sys.includes("Chris") && !sys.includes("GEHEIM"), "kein Chris-Kontext");
  assert.ok(sys.includes("Lap") && sys.includes("tiếng Việt") && sys.includes("346.500 ₫") && !sys.includes("CHF"));
  assert.ok(sellerSystem(actorFor("mario"), {}).includes("Deutsch"));
});
