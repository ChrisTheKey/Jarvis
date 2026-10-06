// Lead-Finder und Website-Audit: nur nachweisbare Befunde, Duplikate vermeiden, nie Freigabe oder Versand ohne Grundlage.
// Läuft ohne Netzwerk – Websites, Suche, Gmail und Textgenerator sind Attrappen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createAuditor, parseRobots } from "../site-auditor.js";
import { runDiscovery, discoveryReport, scoreLead, DISCOVERY_LOCK } from "../lead-finder.js";
import { createWorker, zurichDay } from "../mail-worker.js";

const T0 = new Date("2026-10-06T08:00:00Z");
const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");

// ---------- Website-Attrappe ----------
let web, fetched;
const page = ({ title = "Muster Schreinerei AG", desc = "Schreinerei in Winterthur", viewport = true, lang = true, links = ["/kontakt", "/impressum"], extra = "" } = {}) =>
  `<!doctype html><html${lang ? ' lang="de"' : ""}><head><title>${title}</title>` +
  (desc ? `<meta name="description" content="${desc}">` : "") + (viewport ? '<meta name="viewport" content="width=device-width">' : "") +
  `</head><body><img src="/logo.png" alt="Logo">${links.map((l) => `<a href="${l}">${l.slice(1)}</a>`).join(" ")}${extra}<footer>© 2026</footer></body></html>`;
const IMPRESSUM = (email, more = "") => `<html><body><h1>Impressum</h1><p>Muster Schreinerei AG<br>Hauptstrasse 1, 8400 Winterthur<br>E-Mail: <a href="mailto:${email}">${email}</a><br>UID: CHE-123.456.789</p>${more}</body></html>`;

function site(host, routes = {}) {
  web[`http://${host}/`] = { status: 301, headers: { location: `https://${host}/` } };
  web[`https://${host}/`] = { body: page() };
  web[`https://${host}/robots.txt`] = { body: "", type: "text/plain" };
  web[`https://${host}/kontakt`] = { body: "<html><body>Kontakt</body></html>" };
  web[`https://${host}/impressum`] = { body: IMPRESSUM(`info@${host.replace(/^www\./, "")}`) };
  web[`https://${host}/logo.png`] = { body: "x", type: "image/png" };
  Object.assign(web, Object.fromEntries(Object.entries(routes).map(([p, v]) => [p.startsWith("http") ? p : `https://${host}${p}`, v])));
}
async function fakeFetch(url) {
  const u = new URL(url);
  const key = `${u.protocol}//${u.host}${u.pathname}`;
  fetched.push(key);
  const r = url.includes("&amp;") ? { status: 404 } : web[key]; // undekodierte Entities würden wie beim echten CDN scheitern
  if (!r) return new Response("nicht gefunden", { status: 404, headers: { "content-type": "text/html" } });
  if (r.error) throw Object.assign(new TypeError("fetch failed"), { cause: { code: r.error } });
  if (r.throw) throw new Error(r.throw);
  return new Response(r.body ?? "", { status: r.status || 200, headers: { "content-type": r.type || "text/html; charset=utf-8", ...(r.headers || {}) } });
}
const auditor = () => createAuditor({ fetchFn: fakeFetch, delayMs: 0, now: () => T0 });
const types = (r) => r.issues.map((i) => i.type).sort();

// ---------- Gmail-/Worker-Attrappen ----------
let dir, g, sent, composed, composeResult;
function fakeGmail() {
  const f = { reg: { drafts: {}, sent: {} }, calls: [], n: 0 };
  Object.assign(f, {
    listOwned: () => structuredClone(f.reg),
    async readThread(id) { f.calls.push("read " + id); return { threadId: id, messages: [] }; },
    async replyToThread(id) { f.calls.push("reply " + id); throw new Error("unerwartet"); },
    async createDraft({ to, subject, body }) { f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "new" + id, to, subject, body }; return { draftId: id, threadId: "new" + id }; },
    async updateDraft() { throw new Error("unerwartet"); },
    async markDraftForReview(id) { f.calls.push("review " + id); },
    async sendDraft(id) {
      f.calls.push("SEND " + id);
      const d = f.reg.drafts[id];
      if (Object.values(f.reg.sent).filter((s) => zurichDay(new Date(s.sentAt)) === zurichDay(T0)).length >= 100) throw new Error("Tageslimit");
      delete f.reg.drafts[id];
      f.reg.sent["s" + id] = { ...d, fromDraft: id, sentAt: T0.toISOString() };
      sent.push(f.reg.sent["s" + id]);
    },
  });
  return f;
}
const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const discover = (candidates, opts = {}) => runDiscovery({ dir, gmail: g, search: async () => candidates, auditor: opts.auditor || auditor(), now: () => T0, log: () => {}, force: true, ...opts });
const cand = (host, extra = {}) => ({ company: "Muster Schreinerei AG", website: `https://${host}`, email: "", chain: false, source: `OpenStreetMap node/1 (${host})`, ...extra });
const AUTO = { dryRun: false, sendMode: "compliant_auto", offer: "Website-Reparatur", sender: { name: "Chris Kälin", company: "Helvetic Webdesign", email: "chris@helvetic-webdesign.ch" } };
const worker = () => createWorker({ dir, gmail: g, now: () => T0, log: () => {}, compose: async (task) => { composed.push(task); return composeResult(task); } });
const OPTIN = { approved: true, consentBasis: "opt_in", consentAt: "2026-09-01T10:00:00Z", consentSource: "Kontaktformular" };

beforeEach(() => {
  web = {}; fetched = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-finder-"));
  g = fakeGmail(); sent = []; composed = [];
  composeResult = () => ({ decision: "draft", subject: "Ihre Website", body: "Guten Tag\n\nmir ist bei Ihrer Website etwas aufgefallen." });
  write("config.json", { ...AUTO, discovery: { areas: ["Winterthur"], categories: [{ key: "craft" }], minScore: 6 } });
});

// ---------- Audit ----------

test("gesunde Website: kein erfundener Befund", async () => {
  site("gesund.ch");
  const r = await auditor().audit("https://gesund.ch");
  assert.equal(r.reachable, true);
  assert.deepEqual(r.issues, []);
});

test("Startseite mit 404: korrekt als HTTP-Fehler erkannt", async () => {
  site("kaputt.ch", { "/": { status: 404, body: "Not found" } });
  const r = await auditor().audit("kaputt.ch");
  assert.deepEqual(types(r), ["http_error"]);
  assert.equal(r.issues[0].evidence, "Startseite antwortet mit HTTP 404");
});

test("kaputter interner Link und kaputte Kontaktseite: mit Beleg erkannt", async () => {
  site("links.ch", { "/": { body: page({ links: ["/kontakt", "/impressum", "/angebot"] }) }, "/kontakt": { status: 500, body: "x" }, "/angebot": { status: 404, body: "x" } });
  const r = await auditor().audit("https://links.ch");
  const broken = r.issues.find((i) => i.type === "broken_link");
  assert.deepEqual([broken.url, broken.evidence, broken.severity], ["https://links.ch/angebot", "HTTP 404 (verlinkt auf https://links.ch/)", "medium"]);
  assert.ok(r.issues.find((i) => i.type === "contact_page_broken" && i.evidence.startsWith("HTTP 500")));
  for (const i of r.issues) assert.ok(i.type && i.url && i.evidence && i.severity && i.detectedAt, "jedes Feld belegt");
});

test("nicht erreichbare Website: erkannt, nichts weiter behauptet", async () => {
  web["https://weg.ch/"] = { error: "ENOTFOUND" };
  web["http://weg.ch/"] = { error: "ENOTFOUND" };
  const r = await auditor().audit("weg.ch");
  assert.equal(r.reachable, false);
  assert.deepEqual(types(r), ["unreachable"]);
});

test("Zertifikatsfehler, Weiterleitungsschleife, Mixed Content, fehlende Grundlagen werden belegt", async () => {
  web["https://cert.ch/"] = { error: "CERT_HAS_EXPIRED" };
  web["http://cert.ch/"] = { body: page({ viewport: false, desc: "", lang: false }) };
  for (const p of ["kontakt", "impressum"]) web["http://cert.ch/" + p] = { body: "<html>ok</html>" };
  web["http://cert.ch/logo.png"] = { body: "x", type: "image/png" };
  const a = await auditor().audit("cert.ch");
  assert.deepEqual(types(a), ["https_certificate", "missing_lang", "missing_meta_description", "no_mobile_viewport"]);
  web["https://loop.ch/"] = { status: 302, headers: { location: "https://loop.ch/a" } };
  web["https://loop.ch/a"] = { status: 302, headers: { location: "https://loop.ch/" } };
  web["http://loop.ch/"] = { status: 302, headers: { location: "https://loop.ch/" } };
  web["https://loop.ch/"] = { status: 302, headers: { location: "https://loop.ch/a" } };
  assert.ok(types(await auditor().audit("loop.ch")).includes("redirect_loop"));
  site("mixed.ch", { "/": { body: page({ extra: '<script src="http://cdn.alt.ch/x.js"></script>' }) } });
  const m = await auditor().audit("mixed.ch");
  assert.deepEqual(types(m), ["mixed_content"]);
  assert.match(m.issues[0].evidence, /http:\/\/cdn\.alt\.ch\/x\.js/);
});

test("HTML-Entities in URLs werden dekodiert; 403 (möglicher Bot-Schutz) gilt nicht als defekt", async () => {
  site("cdn.ch", { "/": { body: page({ links: ["/kontakt", "/impressum", "/geschuetzt"], extra: '<img src="/bild.jpg?w=1&amp;h=2" alt="x">' }) }, "/bild.jpg": { body: "x", type: "image/jpeg" }, "/geschuetzt": { status: 403 } });
  const r = await auditor().audit("cdn.ch");
  assert.deepEqual(r.issues, []);
  assert.ok(fetched.includes("https://cdn.ch/bild.jpg"));
});

test("Netzaussetzer bei Unterseiten und robots.txt-Sperren erzeugen keine Befunde", async () => {
  site("vorsicht.ch", { "/": { body: page({ links: ["/kontakt", "/impressum", "/intern", "/wackel"] }) }, "/robots.txt": { body: "User-agent: *\nDisallow: /intern", type: "text/plain" }, "/intern": { status: 404 }, "/wackel": { error: "ETIMEDOUT" } });
  const r = await auditor().audit("vorsicht.ch");
  assert.deepEqual(r.issues, []);
  assert.ok(!fetched.includes("https://vorsicht.ch/intern"), "gesperrter Pfad nie aufgerufen");
  assert.equal(parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b")("/a/b/c"), true);
});

// ---------- Finder ----------

test("öffentliche info@-Adresse: Lead entsteht, aber ohne Freigabe und ohne Einwilligung", async () => {
  site("defekt.ch", { "/": { body: page({ viewport: false, links: ["/kontakt", "/impressum", "/team"] }) }, "/team": { status: 404 } });
  const r = await discover([cand("defekt.ch")]);
  const lead = r.found[0];
  assert.equal(lead.email, "info@defekt.ch");
  assert.equal(lead.emailSource.startsWith("impressum"), true);
  assert.deepEqual([lead.approved, lead.consentBasis, lead.consentAt, lead.consentSource, lead.existingCustomer, lead.similarService], [false, null, null, null, false, false]);
  assert.equal(lead.status, "blocked_no_legal_basis");
  assert.equal(lead.uid, "CHE-123.456.789");
  assert.equal(lead.name, null, "kein Inhaber geraten");
  assert.ok(lead.auditScore >= 6 && lead.scoreDetails.length);
  assert.deepEqual(read("discovered.json").leads["defekt.ch"].status, "blocked_no_legal_basis");
  assert.ok(!fs.existsSync(path.join(dir, "leads.json")), "Sirs Lead-Liste wird nicht befüllt");
});

test("Inhaber nur, wenn das Impressum ihn ausdrücklich nennt", async () => {
  site("inhaber.ch", { "/": { body: page({ viewport: false, links: ["/kontakt", "/impressum", "/x"] }) }, "/x": { status: 404 }, "/impressum": { body: IMPRESSUM("info@inhaber.ch", "<p>Inhaber: Peter Muster</p>") } });
  const r = await discover([cand("inhaber.ch")]);
  assert.equal(r.found[0].name, "Peter Muster");
  assert.equal(r.found[0].nameSource, "https://inhaber.ch/impressum");
});

test("gesunde Website: kein Lead mit erfundenem Problem", async () => {
  site("gesund.ch");
  const r = await discover([cand("gesund.ch")]);
  assert.equal(r.found[0].status, "no_issues");
  assert.deepEqual(r.found[0].websiteIssues, []);
  assert.equal(discoveryReport(dir, T0).qualifiedLeads, 0);
});

test("Duplikate: gleiche Domain (auch mit www) und gleiche Firma werden nicht erneut aufgenommen", async () => {
  site("doppelt.ch", { "/": { body: page({ viewport: false }) } });
  await discover([cand("doppelt.ch"), cand("www.doppelt.ch", { company: "Andere" })]);
  await discover([cand("doppelt.ch", { company: "X" }), cand("andere-domain.ch", { company: "Muster Schreinerei AG" })]);
  assert.deepEqual(Object.keys(read("discovered.json").leads), ["doppelt.ch"]);
});

test("Duplikate: E-Mail aus eigenem Jarvis-Thread oder Sirs Lead-Liste wird kein neuer Lead", async () => {
  site("thread.ch", { "/": { body: page({ viewport: false }) } });
  site("liste.ch", { "/": { body: page({ viewport: false }) } });
  g.reg.sent.x = { to: "Info <info@thread.ch>", threadId: "t1", sentAt: T0.toISOString() };
  write("leads.json", [{ email: "info@liste.ch", approved: true }]);
  const r = await discover([cand("thread.ch", { company: "A AG" }), cand("liste.ch", { company: "B AG" })], { auditor: auditor() });
  assert.deepEqual(r.found.map((l) => l.status), ["duplicate", "already_in_lead_list"]);
  assert.ok(!g.calls.some((c) => c.startsWith("read")), "Threads werden dafür nicht geöffnet");
});

test("private Seite und Kette werden ausgeschlossen", async () => {
  site("familie-muster.ch", { "/": { body: page({ title: "Familie Muster – Fotoalbum", viewport: false }) }, "/impressum": { status: 404 } });
  site("kette.ch", { "/": { body: page({ viewport: false }) } });
  const r = await discover([cand("familie-muster.ch", { company: "Familie Muster" }), cand("kette.ch", { company: "Kette", chain: true })]);
  assert.deepEqual(r.found.map((l) => [l.domain, l.status]), [["familie-muster.ch", "excluded_private"]]);
  assert.ok(!fetched.some((u) => u.includes("kette.ch")), "Kette gar nicht geprüft");
});

test("Suppression hat Vorrang: gesperrte Domain wird nie Lead", async () => {
  site("gesperrt.ch", { "/": { body: page({ viewport: false }) } });
  write("suppression.json", { "chef@gesperrt.ch": { reason: "opt-out" } });
  const r = await discover([cand("gesperrt.ch")]);
  assert.equal(r.found[0].status, "suppressed");
});

test("Fehler einer Website stoppt die Pipeline nicht", async () => {
  site("gut.ch", { "/": { body: page({ viewport: false }) } });
  const a = auditor();
  const flaky = { audit: async (w) => { if (w.includes("boom")) throw new Error("Parserfehler"); return a.audit(w); } };
  const r = await discover([cand("boom.ch", { company: "Boom AG" }), cand("gut.ch")], { auditor: flaky });
  assert.deepEqual(r.found.map((l) => l.status), ["audit_error", "blocked_no_legal_basis"]);
  assert.equal(discoveryReport(dir, T0).errorsToday, 1);
});

test("Discovery-Lock: paralleler Lauf wird blockiert", async () => {
  fs.writeFileSync(path.join(dir, DISCOVERY_LOCK), JSON.stringify({ pid: process.ppid, beat: Date.now() }));
  const r = await discover([cand("x.ch")]);
  assert.equal(r.busy, true);
  assert.deepEqual(fetched, []);
});

test("Score ist nachvollziehbar und nur aus dokumentierten Kriterien", () => {
  const s = scoreLead({ issues: [{ severity: "high" }, { severity: "low" }], identity: { uid: "CHE-1", hasImpressum: true, email: "a@b.ch" }, company: "A AG", reachable: true });
  assert.equal(s.score, 4 + 2 + 2 + 1 + 2);
  assert.equal(s.details.length, 5);
  assert.equal(scoreLead({ issues: [], reachable: true }).score, 0);
  assert.equal(scoreLead({ issues: [], reachable: false }).score, -3);
});

// ---------- Versand nur über das bestehende Compliance-Gate ----------

test("gefundener Lead ohne Versandgrundlage: nie Entwurf, nie Send", async () => {
  site("defekt.ch", { "/": { body: page({ viewport: false }) } });
  await discover([cand("defekt.ch")]);
  await worker().tick();
  assert.ok(!g.calls.some((c) => /^(create|SEND)/.test(c)));
});

test("gültiges opt_in in Sirs Liste: Befunde werden angehängt, compliant_auto sendet mit genau diesen Befunden", async () => {
  site("kunde.ch", { "/": { body: page({ viewport: false, links: ["/kontakt", "/impressum", "/preise"] }) }, "/preise": { status: 404 } });
  write("leads.json", [{ email: "info@kunde.ch", company: "Kunde AG", ...OPTIN }]);
  const r = await discover([cand("kunde.ch", { company: "Kunde AG" })]);
  assert.equal(r.found[0].status, "matched_existing_lead");
  const lead = read("leads.json")[0];
  assert.deepEqual(lead.websiteIssues.map((i) => i.type).sort(), ["broken_link", "no_mobile_viewport"]);
  assert.equal(lead.approved, true, "Freigabe bleibt Sirs Eintrag");
  await worker().tick();
  assert.equal(sent.length, 1);
  assert.deepEqual(composed[0].lead.websiteIssues, lead.websiteIssues, "Textgenerator bekommt nur die dokumentierten Befunde");
  assert.match(sent[0].body, /Chris Kälin\nHelvetic Webdesign\nchris@helvetic-webdesign\.ch/);
  assert.match(sent[0].body, /«Abmelden»/);
});

test("Bestandskunde mit ähnlicher Leistung: darf senden", async () => {
  write("leads.json", [{ email: "info@alt.ch", approved: true, consentBasis: "existing_customer", existingCustomer: true, similarService: true }]);
  await worker().tick();
  assert.equal(sent.length, 1);
});

test("Suppression: auch mit Versandgrundlage nie senden", async () => {
  write("leads.json", [{ email: "info@stop.ch", ...OPTIN }]);
  write("suppression.json", { "info@stop.ch": { reason: "opt-out" } });
  await worker().tick();
  assert.equal(sent.length, 0);
});

test("Mail ohne dokumentierte Befunde darf keine Website-Probleme behaupten", async () => {
  write("leads.json", [{ email: "info@ohne.ch", ...OPTIN }]);
  composeResult = () => ({ decision: "draft", subject: "Ihre Website", body: "Guten Tag\n\nIhre Kontaktseite liefert einen 404-Fehler." });
  await worker().tick();
  assert.equal(sent.length, 0);
  assert.ok(g.calls.some((c) => c.startsWith("review")), "nur Entwurf zur Prüfung");
});

test("Tageslimit 100 bleibt bestehen", async () => {
  for (let i = 0; i < 100; i++) g.reg.sent["o" + i] = { to: `x${i}@y.ch`, threadId: "alt" + i, sentAt: T0.toISOString() };
  write("leads.json", [{ email: "info@neu.ch", ...OPTIN }]);
  const r = await worker().tick();
  assert.equal(sent.length, 0);
  assert.equal(r.report.freeToday, 0);
});

test("Bericht enthält alle Discovery- und Versandkennzahlen", async () => {
  site("defekt.ch", { "/": { body: page({ viewport: false }) } });
  await discover([cand("defekt.ch")]);
  const r = await worker().plan();
  for (const k of ["websitesFoundToday", "websitesAuditedToday", "websitesWithIssuesToday", "qualifiedLeads", "leadsWithoutContact", "leadsWithoutLegalBasis", "eligibleLeads", "sentToday", "freeToday", "optOutsTotal", "discoveryErrorsToday"]) assert.ok(k in r.report, k);
  assert.deepEqual([r.report.websitesFoundToday, r.report.websitesWithIssuesToday, r.report.qualifiedLeads, r.report.leadsWithoutLegalBasis], [1, 1, 1, 1]);
});

test("fremde Gmail-Mails bleiben unangetastet", async () => {
  site("defekt.ch", { "/": { body: page({ viewport: false }) } });
  await discover([cand("defekt.ch")]);
  assert.deepEqual(g.calls, [], "Discovery fasst Gmail gar nicht an");
});

test("Finder läuft eigenständig ohne server.js", () => {
  for (const f of ["lead-finder.js", "site-auditor.js"]) assert.ok(!/import[^;]*server\.js|localhost|127\.0\.0\.1/.test(fs.readFileSync(path.join(ROOT, f), "utf8")), f);
  const secrets = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-secrets-"));
  fs.mkdirSync(path.join(secrets, "mail_worker"));
  fs.writeFileSync(path.join(secrets, "mail_worker", "config.json"), JSON.stringify({ discovery: { areas: [] } }));
  const r = spawnSync(process.execPath, ["lead-finder.js", "--once"], { cwd: ROOT, encoding: "utf8", timeout: 30_000, env: { ...process.env, JARVIS_SECRETS_DIR: secrets } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).report.totalKnown, 0);
});

test("echte Lead-Daten bleiben aus Git", () => {
  for (const f of [".secrets/mail_worker/discovered.json", ".secrets/mail_worker/leads.json", ".secrets/mail_worker/discovery.lock"]) execFileSync("git", ["check-ignore", "-q", f], { cwd: ROOT });
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n");
  assert.deepEqual(tracked.filter((f) => /discovered|leads?\.json|\.secrets/i.test(f)), []);
});
