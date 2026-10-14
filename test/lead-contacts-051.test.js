// TF-051 Lead-Kontaktverzeichnis: wachsende Liste aller Jarvis-eigenen Cold Leads (Register + Gmail-Mapping) mit öffentlich
// publizierter Geschäfts-Telefonnummer und Inhaber/Geschäftsführung. Nichts raten (null statt Vermutung), keine privaten Nummern,
// keine Duplikate, CSV/PDF atomar, 0 Send-Aktionen, Anreicherung blockiert nie die Entwurfserstellung.
// Unit-Tests ohne Netzwerk; Integration gegen einen lokalen HTTP-Server (echtes fetch, robots.txt, Links, Drosselung).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import {
  COLD_MODE, DIRECTORY_FILE, CSV_NAME, PDF_NAME, CSV_HEADERS, ownedColdLeads, loadDirectory, saveDirectory, syncDirectory, findEntryKey, normalizeSwissPhone,
  extractPhones, choosePhone, extractPeople, choosePeople, createResearcher, applyEnrichment, enrichPending, directoryStats, directoryToCsv, writeExports,
  maybeExport, syncFromMail, dueForEnrichment, acquireDirLock, releaseDirLock,
} from "../lead-contacts.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T0 = new Date("2026-10-14T08:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tf051-"));
const review = (id, over = {}) => ({ lead_id: id, company: `Firma ${id}`, domain: id, recipient: `info@${id}`, draft_mode: COLD_MODE, status: "draft_created",
  gmail_draft_id: `d-${id}`, draft_created_at: T0.toISOString(), ...over });
const gmailFor = (reviews) => ({ drafts: Object.fromEntries(Object.entries(reviews).filter(([, r]) => r.status === "draft_created").map(([id, r]) => [r.gmail_draft_id, { mode: COLD_MODE, leadId: id }])), sent: {} });
const page = (body, title = "x") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const research = (res) => async () => res;
const found = (phone, people = []) => ({ ok: true, phone, people, sources: [{ url: "https://x.ch/impressum", kind: "impressum", used_for: ["phone"] }] });
const PHONE = { phone: "+41 31 123 45 67", phone_normalized: "+41 31 123 45 67", phone_original: "031 123 45 67", phone_source_url: "https://keller.ch/impressum", phone_confidence: "high" };
const PERSON = { first_name: "Hans", last_name: "Keller", role: "Geschäftsführer", source_url: "https://keller.ch/impressum", confidence: "high" };
const mailDir = (reviews, gmail = gmailFor(reviews)) => {
  const m = tmp();
  fs.mkdirSync(path.join(m, "mail_worker"));
  fs.writeFileSync(path.join(m, "mail_worker", "individual_reviews.json"), JSON.stringify({ reviews }));
  fs.writeFileSync(path.join(m, "gmail_jarvis.json"), JSON.stringify(gmail));
  return m;
};

// ---------- Eigentum: nur Register + Gmail-Mapping ----------
test("Jarvis-eigen nur mit Cold-Register UND passendem Gmail-Mapping (Entwurf oder aus dem Entwurf gesendet)", () => {
  const reviews = { "a.ch": review("a.ch"), "b.ch": review("b.ch", { status: "manually_sent" }), "c.ch": review("c.ch"), "d.ch": review("d.ch", { draft_mode: "INDIVIDUAL" }), "e.ch": review("e.ch") };
  const gmail = { drafts: { "d-a.ch": { mode: COLD_MODE, leadId: "a.ch" }, "d-c.ch": { mode: COLD_MODE, leadId: "anders.ch" }, "d-d.ch": { mode: COLD_MODE, leadId: "d.ch" },
    "d-e.ch": { mode: COLD_MODE, leadId: "e.ch", messageClass: "transactional" } }, sent: { m1: { fromDraft: "d-b.ch", mode: COLD_MODE, leadId: "b.ch" } } };
  const owned = ownedColdLeads(reviews, gmail);
  assert.deepEqual(owned.map((o) => [o.lead_id, o.draft_status]), [["a.ch", "DRAFT"], ["b.ch", "MANUALLY_SENT"]]);
  assert.equal(owned[0].email, "info@a.ch");
});

// ---------- A–F: Speicherung, Duplikate ----------
test("A: neuer Lead + Telefon + Geschäftsführer → korrekt gespeichert", () => {
  const d = loadDirectory(tmp());
  syncDirectory(d, ownedColdLeads({ "keller.ch": review("keller.ch") }, gmailFor({ "keller.ch": review("keller.ch") })), T0);
  const e = applyEnrichment(d.leads["keller.ch"], found(PHONE, [PERSON]), T0);
  assert.equal(e.lead_id, "keller.ch"); assert.equal(e.company_name, "Firma keller.ch"); assert.equal(e.email, "info@keller.ch");
  assert.equal(e.phone, "+41 31 123 45 67"); assert.equal(e.phone_original, "031 123 45 67"); assert.equal(e.phone_confidence, "high");
  assert.deepEqual([e.first_name, e.last_name, e.role, e.person_confidence], ["Hans", "Keller", "Geschäftsführer", "high"]);
  assert.equal(e.draft_status, "DRAFT"); assert.equal(e.gmail_draft_id, "d-keller.ch"); assert.equal(e.contact_enriched_at, T0.toISOString());
  assert.equal(e.enrichment.status, "done"); assert.ok(e.sources.length);
});
test("B: Telefon gefunden, Person nicht → Telefon gespeichert, Person null", () => {
  const e = applyEnrichment({ lead_id: "x.ch", domain: "x.ch" }, found(PHONE, []), T0);
  assert.equal(e.phone, PHONE.phone);
  assert.deepEqual([e.first_name, e.last_name, e.role, e.person_confidence], [null, null, null, null]);
});
test("C: Person gefunden, Telefon nicht → Person gespeichert, Telefon null", () => {
  const e = applyEnrichment({ lead_id: "x.ch", domain: "x.ch" }, found(null, [PERSON]), T0);
  assert.deepEqual([e.phone, e.phone_normalized, e.phone_confidence], [null, null, null]);
  assert.equal(e.last_name, "Keller");
});
test("D: nichts gefunden bzw. Website nicht erreichbar → Lead bleibt erhalten (Retry mit Backoff)", async () => {
  const dir = tmp();
  const d = loadDirectory(dir);
  syncDirectory(d, [{ lead_id: "a.ch", domain: "a.ch", email: "info@a.ch", company: "A", draft_status: "DRAFT" }, { lead_id: "b.ch", domain: "b.ch", email: "info@b.ch", company: "B", draft_status: "DRAFT" }], T0);
  saveDirectory(dir, d, T0);
  const s = await enrichPending(dir, { research: async (e) => (e.lead_id === "a.ch" ? found(null, []) : { ok: false, error: "ENOTFOUND" }), now: () => T0 });
  assert.equal(s.processed, 2); assert.equal(s.errors, 1);
  const after = loadDirectory(dir);
  assert.equal(Object.keys(after.leads).length, 2);
  assert.equal(after.leads["a.ch"].enrichment.status, "done"); assert.equal(after.leads["a.ch"].phone, null);
  assert.equal(after.leads["b.ch"].enrichment.status, "failed"); assert.ok(after.leads["b.ch"].enrichment.next_retry_at > T0.toISOString());
  assert.equal(dueForEnrichment(after.leads["b.ch"], T0), false);
  assert.equal(dueForEnrichment(after.leads["b.ch"], new Date(T0.getTime() + 2 * 3_600_000)), true);
});
test("E: gleicher Lead erneut → kein Duplikat (Lead-ID, Fallback Domain + Adresse)", () => {
  const d = loadDirectory(tmp());
  const inc = { lead_id: "a.ch", domain: "a.ch", email: "info@a.ch", company: "A", draft_status: "DRAFT" };
  assert.equal(syncDirectory(d, [inc], T0).created, 1);
  assert.equal(syncDirectory(d, [inc], new Date(T0.getTime() + 60_000)).created, 0);
  assert.equal(findEntryKey(d, { lead_id: "neu-id", domain: "WWW.A.CH", email: "Info@A.ch" }), "a.ch");
  syncDirectory(d, [{ ...inc, lead_id: "neu-id", domain: "www.a.ch", email: "INFO@a.ch" }], T0);
  assert.equal(Object.keys(d.leads).length, 1);
  assert.equal(directoryStats(d).duplicates, 0);
});
test("F: Draft aktualisiert (neuer Hash/Status) → gleicher Directory-Eintrag, Anreicherung bleibt; verschwundene Leads nie gelöscht", () => {
  const d = loadDirectory(tmp());
  syncDirectory(d, [{ lead_id: "a.ch", domain: "a.ch", email: "info@a.ch", company: "A", draft_status: "DRAFT", gmail_draft_id: "d1" }, { lead_id: "b.ch", domain: "b.ch", email: "info@b.ch", draft_status: "DRAFT" }], T0);
  applyEnrichment(d.leads["a.ch"], found(PHONE, [PERSON]), T0);
  const r = syncDirectory(d, [{ lead_id: "a.ch", domain: "a.ch", email: "info@a.ch", company: "A AG", draft_status: "MANUALLY_SENT", gmail_draft_id: "d1" }], new Date(T0.getTime() + 60_000));
  assert.equal(Object.keys(d.leads).length, 2);
  assert.equal(d.leads["a.ch"].draft_status, "MANUALLY_SENT"); assert.equal(d.leads["a.ch"].company_name, "A AG");
  assert.equal(d.leads["a.ch"].phone, PHONE.phone); assert.equal(d.leads["a.ch"].first_seen_at, T0.toISOString());
  assert.equal(d.leads["b.ch"].draft_status, "NO_LONGER_DRAFT"); assert.equal(r.missing, 1);
  // Leeres Register (Lese-/Mount-Problem) stuft nichts um
  syncDirectory(d, [], T0);
  assert.equal(d.leads["a.ch"].draft_status, "MANUALLY_SENT");
});

// ---------- Telefon ----------
test("Telefon: Schweizer Formate normalisiert, Mehrwert-/fremde Nummern nie", () => {
  assert.equal(normalizeSwissPhone("031 123 45 67").normalized, "+41 31 123 45 67");
  assert.equal(normalizeSwissPhone("+41 (0)44 123 45 67").normalized, "+41 44 123 45 67");
  assert.equal(normalizeSwissPhone("0041 91 123 45 67").normalized, "+41 91 123 45 67");
  assert.equal(normalizeSwissPhone("0800 123 456").normalized, "+41 800 123 456");
  assert.equal(normalizeSwissPhone("079 123 45 67").kind, "mobile");
  assert.equal(normalizeSwissPhone("0901 123 456"), null);
  assert.equal(normalizeSwissPhone("+49 30 1234567"), null);
  assert.equal(normalizeSwissPhone("01.12.2024 08"), null);
});
test("Telefon: Impressum/tel:-Link/JSON-LD → high; Fax und UID/IBAN nie", () => {
  const html = page(`<h2>Impressum</h2><p>Keller Schreinerei GmbH<br>Bahnhofstrasse 1<br>3000 Bern<br>Tel. 031 123 45 67<br>Fax 031 123 45 68<br>UID CHE-123.456.789<br>IBAN CH93 0076 2011 6238 5295 7</p>`);
  const c = extractPhones(html, { url: "https://keller.ch/impressum", kind: "impressum" });
  assert.deepEqual(c.map((x) => x.normalized), ["+41 31 123 45 67"]);
  const p = choosePhone(c);
  assert.equal(p.phone, "+41 31 123 45 67"); assert.equal(p.phone_confidence, "high"); assert.equal(p.phone_source_url, "https://keller.ch/impressum");
  const ld = extractPhones(`<script type="application/ld+json">{"@type":"LocalBusiness","telephone":"+41 61 222 33 44"}</script>`, { url: "https://k.ch/", kind: "home" });
  assert.equal(choosePhone(ld).phone_confidence, "high");
  const link = extractPhones(page(`<footer><a href="tel:+41445556677">044 555 66 77</a></footer>`), { url: "https://k.ch/", kind: "home" });
  assert.equal(choosePhone(link).phone, "+41 44 555 66 77");
});
test("G: private/persönliche Nummer ohne Business-Kontext → nicht speichern", () => {
  // als „privat“ bezeichnet
  const priv = extractPhones(page(`<p>Kontakt<br>Telefon Geschäft: 031 111 22 33<br>Privat: 079 999 88 77</p>`), { url: "u", kind: "kontakt" });
  const p = choosePhone(priv);
  assert.equal(p.phone, "+41 31 111 22 33");
  assert.ok(priv.some((c) => c.rejected === "private" && c.normalized === "+41 79 999 88 77"));
  assert.ok(!priv.some((c) => !c.rejected && c.kind === "mobile"));
  // „privat“ in der Nachbarzeile macht die Geschäftsnummer nicht privat
  assert.equal(choosePhone(extractPhones(page(`<p>Privat: 079 999 88 77<br>Tel. 031 111 22 33</p>`), { url: "u", kind: "impressum" })).phone, "+41 31 111 22 33");
  // privater tel:-Link → nie
  assert.equal(choosePhone(extractPhones(page(`<p>Privat <a href="tel:0799998877">079 999 88 77</a></p>`), { url: "u", kind: "impressum" })), null);
  // nur privat → nichts
  assert.equal(choosePhone(extractPhones(page(`<p>Privat: 079 999 88 77</p>`), { url: "u", kind: "impressum" })), null);
  // Mobile in Fliesstext auf „Über uns“ ohne Label/Link → nichts
  assert.equal(choosePhone(extractPhones(page(`<p>Hans erreichen Sie abends unter 079 999 88 77 gerne auch am Wochenende.</p>`), { url: "u", kind: "about" })), null);
  // Mobile eines Mitarbeiters auf der Teamseite neben Festnetz → Festnetz
  const team = [...extractPhones(page(`<p>Petra Brunner<br>Mobile 079 555 44 33</p>`), { url: "t", kind: "team" }), ...extractPhones(page(`<p>Tel. 031 444 55 66</p>`), { url: "k", kind: "kontakt" })];
  assert.equal(choosePhone(team).phone, "+41 31 444 55 66");
  // Mobile auf Teamseite allein → nicht (kein zentraler Geschäftskontakt)
  assert.equal(choosePhone(extractPhones(page(`<p>Petra Brunner<br>Mobile 079 555 44 33</p>`), { url: "t", kind: "team" })), null);
  // Einzelunternehmen: zentrale Mobile im Impressum beschriftet → erlaubt, höchstens medium
  const solo = choosePhone(extractPhones(page(`<p>Impressum<br>Malerei Brunner<br>Natel 079 555 44 33</p>`), { url: "i", kind: "impressum" }));
  assert.equal(solo.phone, "+41 79 555 44 33"); assert.equal(solo.phone_confidence, "medium");
  // Nummer der Webagentur im Impressum-Nachweis → nie
  assert.equal(choosePhone(extractPhones(page(`<p>Webdesign: Pixel Studio GmbH<br>Tel. 044 999 00 11</p>`), { url: "i", kind: "impressum" })), null);
});

// ---------- Person ----------
test("Person: Inhaber/Geschäftsführer aus Impressum/Team, höchste Verantwortung zuerst", () => {
  const imp = extractPeople(page(`<h1>Impressum</h1><p>Keller Schreinerei GmbH<br>Geschäftsführer: Hans Keller<br>Tel. 031 123 45 67</p>`), { url: "i", kind: "impressum", company: "Keller Schreinerei GmbH" });
  assert.deepEqual(imp.map((p) => [p.first_name, p.last_name, p.role]), [["Hans", "Keller", "Geschäftsführer"]]);
  const team = extractPeople(page(`<div><h3>Petra Brunner</h3><p>Inhaberin</p></div><div><h3>Marco Rossi</h3><p>Geschäftsführer</p></div>`), { url: "t", kind: "team" });
  const c = choosePeople([...imp, ...team]);
  assert.deepEqual(c.people.map((p) => [p.first_name, p.last_name, p.role]), [["Petra", "Brunner", "Inhaberin"]]);
  assert.equal(c.people[0].confidence, "high");
  const nameRole = extractPeople(page(`<p>Dr. Anna Maria von Arx, Inhaberin und Geschäftsführerin</p>`), { url: "i", kind: "impressum" });
  assert.deepEqual(nameRole.map((p) => [p.first_name, p.last_name, p.role]), [["Anna Maria", "von Arx", "Inhaberin"]]);
  const slash = extractPeople(page(`<p>Hans Keller, Mitinhaber/Geschäftsführer, eidg. dipl. Schreinermeister</p>`), { url: "h", kind: "home" });
  assert.deepEqual(slash.map((p) => [p.first_name, p.last_name, p.role]), [["Hans", "Keller", "Geschäftsführer"]]);
  assert.equal(extractPeople(page(`<p>Inhaber Hans &amp; Petra.</p>`), { url: "i", kind: "impressum" }).length, 0); // nur Vornamen
  assert.equal(extractPeople(page(`<p>Vertretungsberechtigte Personen</p><p>Hans Keller</p>`), { url: "i", kind: "impressum" }).length, 0); // Rolle unklar
  const joint = choosePeople(extractPeople(page(`<p>Geschäftsleitung</p><p>Hans Keller</p><p>Petra Brunner</p>`), { url: "a", kind: "about" }));
  assert.equal(joint.people.length, 2);
});
test("H: unsichere Personenzuordnung → nicht speichern", () => {
  const none = (html, company = "") => extractPeople(page(html), { url: "i", kind: "impressum", company });
  assert.equal(none(`<p>Ihr Ansprechpartner: Hans Keller</p>`).length, 0); // keine Rolle
  assert.equal(none(`<p>Mitglied der Geschäftsleitung: Hans Keller</p>`).length, 0);
  assert.equal(none(`<p>Stv. Geschäftsführer: Hans Keller</p>`).length, 0);
  assert.equal(none(`<p>Inhaber: Keller Treuhand GmbH</p>`, "Keller Treuhand GmbH").length, 0); // Firma statt Person
  assert.equal(none(`<p>Geschäftsführer: Max Mustermann</p>`).length, 0); // Platzhalter
  assert.equal(none(`<p>Webdesign: Pixel Studio, Geschäftsführer Peter Pixelmann</p>`).length, 0); // Agentur-Nachweis
  assert.equal(none(`<p>Hans Keller ist seit 1990 im Familienbetrieb tätig und übergab die Geschäftsführung 2020 an seinen Sohn, der heute als Geschäftsführer den Betrieb mit viel Erfahrung und Herzblut in dritter Generation weiterführt und ausbaut, seit vielen Jahren schon.</p>`).length, 0);
  // mehr als zwei Personen auf dem höchsten Rang → mehrdeutig → niemand
  const many = choosePeople(extractPeople(page(`<p>Geschäftsleitung</p><p>Hans Keller</p><p>Petra Brunner</p><p>Marco Rossi</p>`), { url: "a", kind: "about" }));
  assert.equal(many.people.length, 0); assert.equal(many.ambiguous, true);
  const e = applyEnrichment({ lead_id: "x.ch", domain: "x.ch" }, { ok: true, phone: null, people: many.people, ambiguous_people: true, sources: [] }, T0);
  assert.equal(e.first_name, null); assert.equal(e.enrichment.note, "person_ambiguous");
});

// ---------- I/J: CSV + PDF ----------
const sampleDir = (n = 3) => {
  const dir = tmp();
  const d = loadDirectory(dir);
  syncDirectory(d, Array.from({ length: n }, (_, i) => ({ lead_id: `f${i}.ch`, domain: `f${i}.ch`, email: `info@f${i}.ch`, company: i === 0 ? 'Zürcher "Bäckerei"; Söhne AG' : `Firma ${String(i).padStart(3, "0")} Ostschweiz Gartenbau und Unterhalt GmbH`, draft_status: "DRAFT" })), T0);
  applyEnrichment(d.leads["f0.ch"], found(PHONE, [PERSON]), T0);
  if (n > 1) applyEnrichment(d.leads["f1.ch"], found(null, []), T0);
  saveDirectory(dir, d, T0);
  return dir;
};
test("I: CSV korrekt (UTF-8-BOM, Semikolon, Kopf, Umlaute, Quoting, Formelschutz, keine IDs)", () => {
  const d = loadDirectory(sampleDir());
  const csv = directoryToCsv(d);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.equal(lines[0], CSV_HEADERS.join(";"));
  assert.equal(lines.length, 4);
  const row = lines.find((l) => l.includes("Bäckerei"));
  assert.ok(row.startsWith('"Zürcher ""Bäckerei""; Söhne AG";f0.ch;info@f0.ch;\'+41 31 123 45 67;Hans;Keller;Geschäftsführer;ja (hoch);ja (hoch);Entwurf;'), row);
  assert.ok(lines.some((l) => /;nein;nein;Entwurf;/.test(l)));
  assert.ok(!csv.includes("d-") && !csv.includes("http"));
});
test("J: PDF erzeugt (A4 quer, mehrere Seiten, Seitenzahlen, atomar, keine IDs/URLs)", async () => {
  const dir = sampleDir(140), out = tmp();
  const r = await writeExports(loadDirectory(dir), out, { now: T0 });
  const buf = fs.readFileSync(path.join(out, PDF_NAME));
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(buf.subarray(-32).toString().includes("%%EOF"));
  assert.ok(r.pdf.pages >= 3, `Seiten ${r.pdf.pages}`);
  assert.equal((buf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, r.pdf.pages);
  assert.match(buf.toString("latin1"), /\/MediaBox \[0 0 841\.89 595\.28\]/);
  assert.deepEqual(fs.readdirSync(out).sort(), [CSV_NAME, PDF_NAME].sort()); // keine Temp-Reste
  assert.equal(r.csv.rows, 140);
});
test("PDF/CSV entprellt: CSV bei Änderung, PDF höchstens alle 5 Minuten", async () => {
  const dir = sampleDir(2), out = tmp();
  const d = loadDirectory(dir); d.meta.exports.dirty_since = T0.toISOString(); saveDirectory(dir, d, T0);
  const a = await maybeExport(dir, out, { now: T0 });
  assert.ok(a.pdf);
  assert.equal((await maybeExport(dir, out, { now: T0 })).skipped, "clean");
  const d2 = loadDirectory(dir); d2.meta.exports.dirty_since = T0.toISOString(); saveDirectory(dir, d2, T0);
  const b = await maybeExport(dir, out, { now: new Date(T0.getTime() + 60_000) });
  assert.ok(b.csv && !b.pdf);
  assert.ok(loadDirectory(dir).meta.exports.dirty_since, "PDF noch fällig");
  const c = await maybeExport(dir, out, { now: new Date(T0.getTime() + 6 * 60_000) });
  assert.ok(c.pdf);
  assert.equal(loadDirectory(dir).meta.exports.dirty_since, undefined);
});

// ---------- K/L: keine Sendeaktion, Entwurfserstellung nie blockiert ----------
test("K: 0 Send-Aktionen – Modul kennt weder Gmail-Client noch Versand, Websites nur per GET", async () => {
  const src = fs.readFileSync(path.join(ROOT, "lead-contacts.js"), "utf8");
  for (const forbidden of [/from\s+["']\.\/gmail\.js["']/, /import\(["']\.\/gmail\.js["']\)/, /sendMail|sendDraft|drafts\/send|messages\/send|createDraft|updateDraft|nodemailer|smtp/i, /googleapis\.com/])
    assert.ok(!forbidden.test(src), String(forbidden));
  // Liest aus dem Mail-Bereich nur genau diese zwei Dateien (keine Token-/Credential-Datei)
  assert.ok(!/gmail_token|gmail_credentials|["'/]\.env\b/.test(src));
  const methods = new Set();
  const r = createResearcher({ gapMs: 0, sleep: async () => {}, fetchFn: async (url, o) => { methods.add(o.method); return new Response(page(`<a href="/impressum">Impressum</a>`), { status: 200, headers: { "content-type": "text/html" } }); } });
  await r.research({ domain: "x.ch" });
  assert.deepEqual([...methods], ["GET"]);
});
test("L: Enrichment-Fehler blockiert Cold-Draft nicht (Register unverändert, Draft-Pfad importiert das Modul nicht)", async () => {
  const reviews = { "a.ch": review("a.ch") };
  const m = mailDir(reviews);
  const regFile = path.join(m, "mail_worker", "individual_reviews.json"), before = fs.readFileSync(regFile, "utf8");
  const dir = tmp();
  assert.equal(syncFromMail(dir, m, T0).created, 1);
  const s = await enrichPending(dir, { research: async () => { throw new Error("boom"); }, now: () => T0 });
  assert.equal(s.errors, 1);
  assert.equal(fs.readFileSync(regFile, "utf8"), before);
  assert.equal(loadDirectory(dir).leads["a.ch"].enrichment.status, "failed");
  for (const f of ["mail-worker.js", "lead-finder.js", "swiss-repair.js", "gmail.js", "lead-registry.js"])
    assert.ok(!fs.readFileSync(path.join(ROOT, f), "utf8").includes("lead-contacts"), `${f} hängt nicht an der Anreicherung`);
});
test("Lock: nur ein Schreiber (Dienst oder Backfill)", () => {
  const dir = tmp();
  assert.ok(acquireDirLock(dir));
  fs.writeFileSync(path.join(dir, "contacts.lock"), JSON.stringify({ pid: -1, beat: Date.now() }));
  assert.equal(acquireDirLock(dir), false);
  fs.writeFileSync(path.join(dir, "contacts.lock"), JSON.stringify({ pid: -1, beat: Date.now() - 11 * 60_000 }));
  assert.ok(acquireDirLock(dir));
  releaseDirLock(dir);
  assert.ok(!fs.existsSync(path.join(dir, "contacts.lock")));
});
test("Verzeichnis: fail closed bei unbekanntem Schema; Datei nur 600, atomar", () => {
  const dir = tmp();
  saveDirectory(dir, loadDirectory(dir), T0);
  assert.ok(fs.existsSync(path.join(dir, DIRECTORY_FILE)));
  assert.deepEqual(fs.readdirSync(dir), [DIRECTORY_FILE]);
  fs.writeFileSync(path.join(dir, DIRECTORY_FILE), JSON.stringify({ schema: 99, leads: {} }));
  assert.throws(() => loadDirectory(dir), /fail closed/);
});

// ---------- Integration: echter HTTP-Server, echtes fetch ----------
test("Integration: Website-Recherche (Links, Impressum, Kontakt, robots.txt, Cache je Domain) → Backfill mit Checkpoint + Export", async () => {
  const hits = [];
  const site = {
    "/": page(`<nav><a href="/de/impressum">Impressum</a> <a href="/kontakt-anfahrt">Kontakt</a> <a href="/team">Team</a> <a href="/intern/">Intern</a></nav><h1>Keller Schreinerei</h1><footer>T +41 31 123 45 67</footer>`),
    "/de/impressum": page(`<h1>Impressum</h1><p>Keller Schreinerei GmbH<br>Inhaber: Hans Keller<br>Telefon 031 123 45 67</p><p>Webdesign: Pixel Studio GmbH, Tel. 044 999 00 11</p>`),
    "/kontakt-anfahrt": page(`<p>Rufen Sie uns an: <a href="tel:+41311234567">031 123 45 67</a></p>`),
    "/team": page(`<p>Petra Brunner<br>Mobile 079 555 44 33</p>`),
    "/robots.txt": "User-agent: *\nDisallow: /team\n",
  };
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    // Kontaktseite leitet auf eine fremde Website um → wird nie als Quelle verwendet
    if (req.url === "/kontakt-anfahrt") { res.writeHead(302, { location: `http://localhost:${server.address().port}/fremd` }); return res.end(); }
    if (req.url === "/fremd") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page(`<p>Geschäftsführer: Fritz Fremdmann<br>Tel. 044 777 88 99</p>`)); }
    const body = site[req.url];
    if (!body) { res.writeHead(404, { "content-type": "text/html" }); return res.end("nf"); }
    res.writeHead(200, { "content-type": req.url === "/robots.txt" ? "text/plain" : "text/html; charset=utf-8" }); res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const researcher = createResearcher({ gapMs: 5, timeoutMs: 5000 });
    const reviews = { "keller.ch": review("keller.ch", { company: "Keller Schreinerei GmbH" }), "keller-2.ch": review("keller-2.ch") };
    const m = mailDir(reviews), dir = tmp(), out = tmp();
    syncFromMail(dir, m, T0);
    // Checkpoint: erster Lauf nur 1 Lead, zweiter Lauf setzt fort (kein Neustart)
    const s1 = await enrichPending(dir, { research: (e) => researcher.research(e, { origin }), limit: 1, now: () => T0 });
    assert.equal(s1.processed, 1);
    const s2 = await enrichPending(dir, { research: (e) => researcher.research(e, { origin }), now: () => T0 });
    assert.equal(s2.processed, 1);
    const e = loadDirectory(dir).leads["keller.ch"];
    assert.equal(e.phone, "+41 31 123 45 67"); assert.equal(e.phone_confidence, "high");
    assert.deepEqual([e.first_name, e.last_name, e.role, e.person_confidence], ["Hans", "Keller", "Inhaber", "high"]);
    assert.ok(e.sources.some((s) => s.kind === "impressum" && s.used_for.includes("person")));
    assert.ok(e.sources.every((s) => s.url.startsWith(origin)), "keine fremde Website als Quelle");
    assert.ok(!hits.includes("/team"), "robots.txt Disallow respektiert");
    assert.equal(hits.filter((h) => h === "/").length, 2, "je Domain einmal geladen");
    assert.equal(loadDirectory(dir).leads["keller.ch"].enrichment.status, "done");
    const r = await maybeExport(dir, out, { now: T0, force: true });
    assert.equal(r.csv.rows, 2); assert.ok(r.pdf.bytes > 1000);
    assert.equal(directoryStats(loadDirectory(dir)).duplicates, 0);
  } finally { server.close(); }
});
test(".gitignore schützt Verzeichnis und Exporte", () => {
  const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
  assert.match(gi, /^data\/lead_contact_directory\.json$/m);
  assert.match(gi, /^exports\/$/m);
});
