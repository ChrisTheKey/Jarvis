// TF-052 Firmenname + Website im Lead-Kontaktverzeichnis: Website nur aus der offiziellen Lead-Domain (nie raten, nie fremde Domain),
// im PDF als anklickbarer Link (sichtbar nur die Domain), in der CSV als vollständige URL; fehlend → „Nicht verifiziert“.
// PDF wird für die Prüfung unkomprimiert erzeugt, damit Text und Link-Annotationen direkt lesbar sind.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CSV_HEADERS, NOT_VERIFIED, loadDirectory, saveDirectory, syncDirectory, applyEnrichment, websiteOf, directoryStats, directoryToCsv, renderPdf, writeExports, sortedEntries,
} from "../lead-contacts.js";

const T0 = new Date("2026-10-14T08:00:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tf052-"));
const LONG_COMPANY = "Genossenschaft für biologisch-dynamische Landwirtschaft, Gemüsebau und Direktvermarktung im Emmental und Oberaargau";
const LONG_EMAIL = "kundendienst.und.bestellungen.direktvermarktung@demeter-feldhof-emmental-oberaargau.ch";
// Text je TJ-Operator (= eine Zeile einer Zelle), Link-Ziele der Annotationen.
const pdfLines = (buf) => [...buf.toString("latin1").matchAll(/\[([^\]]*)\] TJ/g)].map((m) => [...m[1].matchAll(/<([0-9a-f]*)>/g)].map((h) => Buffer.from(h[1], "hex").toString("latin1")).join(""));
const pdfLinks = (buf) => [...buf.toString("latin1").matchAll(/\/URI \(([^)]*)\)/g)].map((m) => m[1]);

const sample = () => {
  const d = loadDirectory(tmp());
  syncDirectory(d, [
    { lead_id: "demeter-feldhof.ch", domain: "demeter-feldhof.ch", email: "info@demeter-feldhof.ch", company: "Demeter Feldhof GmbH", draft_status: "DRAFT" },
    { lead_id: "ohne-firma.ch", domain: "ohne-firma.ch", email: "info@ohne-firma.ch", company: null, draft_status: "DRAFT" },
    { lead_id: "ohne-website", domain: null, email: "kontakt@ohne-website-test.ch", company: "Ohne Website AG", draft_status: "DRAFT" },
    { lead_id: "lang.ch", domain: "lang.ch", email: LONG_EMAIL, company: LONG_COMPANY, draft_status: "DRAFT" },
  ], T0);
  applyEnrichment(d.leads["demeter-feldhof.ch"], { ok: true, phone: { phone: "+41 34 123 45 67", phone_normalized: "+41 34 123 45 67", phone_confidence: "high" },
    people: [{ first_name: "Anna", last_name: "Feld", role: "Inhaberin", source_url: "https://www.demeter-feldhof.ch/impressum", confidence: "high" }],
    sources: [{ url: "https://www.demeter-feldhof.ch/de/start", kind: "home" }, { url: "https://www.demeter-feldhof.ch/impressum", kind: "impressum" }] }, T0);
  return d;
};
const render = async (d) => { const f = path.join(tmp(), "x.pdf"); const r = await renderPdf(d, f, { now: T0, compress: false }); return { ...r, buf: fs.readFileSync(f) }; };

test("Website: nur offizielle Lead-Domain, verifizierte Startseite (www) bevorzugt, fremde Domain/Subdomain/http nie", () => {
  assert.deepEqual(websiteOf({ domain: "demeter-feldhof.ch" }), { url: "https://demeter-feldhof.ch/", label: "demeter-feldhof.ch" });
  assert.deepEqual(websiteOf({ domain: "www.Demeter-Feldhof.ch" }), { url: "https://demeter-feldhof.ch/", label: "demeter-feldhof.ch" });
  assert.equal(websiteOf({ domain: "x.ch", sources: [{ kind: "home", url: "https://www.x.ch/de/home" }] }).url, "https://www.x.ch/");
  for (const url of ["https://andere-firma.ch/", "https://shop.x.ch/", "http://www.x.ch/", "https://x.ch.evil.com/", "https://x.ch:8443/"])
    assert.equal(websiteOf({ domain: "x.ch", sources: [{ kind: "home", url }] }).url, "https://x.ch/", url);
  assert.equal(websiteOf({ domain: "x.ch", sources: [{ kind: "impressum", url: "https://www.x.ch/impressum" }] }).url, "https://x.ch/"); // keine Quell-URL als Website
  assert.equal(websiteOf({ domain: null }), null);
  assert.equal(websiteOf({ domain: "localhost" }), null);
  assert.equal(websiteOf({ domain: "xn--bckerei-5wa.ch" }).label, "bäckerei.ch");
});

test("Verzeichnis führt Firma + Website automatisch (neuer Lead, Anreicherung, bestehender Eintrag ohne Feld)", () => {
  const d = sample();
  assert.equal(d.leads["ohne-firma.ch"].website_url, "https://ohne-firma.ch/");
  assert.equal(d.leads["demeter-feldhof.ch"].website_url, "https://www.demeter-feldhof.ch/");
  assert.equal(d.leads["demeter-feldhof.ch"].company_name, "Demeter Feldhof GmbH");
  assert.equal(d.leads["ohne-website"].website_url, null);
  // Bestand vor TF-052 (kein website_url) → beim nächsten Abgleich ergänzt, keine Duplikate, nichts verloren
  delete d.leads["ohne-firma.ch"].website_url;
  const r = syncDirectory(d, [{ lead_id: "ohne-firma.ch", domain: "ohne-firma.ch", email: "info@ohne-firma.ch", draft_status: "DRAFT" }], T0);
  assert.equal(r.created, 0); assert.equal(r.updated, 1);
  assert.equal(d.leads["ohne-firma.ch"].website_url, "https://ohne-firma.ch/");
  assert.equal(Object.keys(d.leads).length, 4);
  const st = directoryStats(d);
  assert.deepEqual([st.total, st.with_website, st.with_company, st.duplicates], [4, 3, 3, 0]);
});

test("A–H: PDF – Firma, Website als Link, „Nicht verifiziert“, Umbruch langer Firma/E-Mail, nichts abgeschnitten", async () => {
  const d = sample();
  const { buf, rows, pages } = await render(d);
  const lines = pdfLines(buf), all = lines.join("");
  assert.equal(rows, 4); assert.equal(pages, 1);
  // Kopf: Spalten + Kennzahlen
  for (const h of ["Firma", "Website", "E-Mail", "Telefon", "Ansprechpartner", "Rolle"]) assert.ok(lines.includes(h), h);
  assert.ok(lines.includes("Mit verifizierter Website: "));
  assert.equal(lines[lines.indexOf("Mit verifizierter Website: ") + 1], "3");
  // A: Firma vorhanden
  assert.ok(lines.includes("Demeter Feldhof GmbH"));
  // B + C: Website sichtbar als kurze Domain, Link-Ziel vollständige URL
  assert.ok(lines.includes("demeter-feldhof.ch"));
  assert.ok(!all.includes("https://"), "keine URL als sichtbarer Text");
  assert.deepEqual(pdfLinks(buf).sort(), ["https://lang.ch/", "https://ohne-firma.ch/", "https://www.demeter-feldhof.ch/"]);
  assert.equal((buf.toString("latin1").match(/\/Subtype \/Link/g) || []).length, 3);
  // D + E: fehlende Firma/Website → „Nicht verifiziert“ (Firma, Website, Telefon, Person je Zeile möglich)
  const nv = lines.filter((l) => l === NOT_VERIFIED).length;
  assert.equal(nv, 1 /* Firma ohne-firma */ + 1 /* Website ohne-website */ + 3 /* Telefon */ + 3 /* Person */);
  // F + G + H: lange Inhalte über mehrere Zeilen, vollständig (zusammengesetzt) vorhanden
  const companyLines = lines.filter((l) => l.trim().length > 3 && LONG_COMPANY.includes(l.trim()));
  assert.ok(companyLines.length >= 2, "lange Firma umgebrochen");
  assert.equal(companyLines.join("").replace(/\s+/g, ""), LONG_COMPANY.replace(/\s+/g, ""));
  const emailLines = lines.filter((l) => l.length > 3 && LONG_EMAIL.includes(l));
  assert.ok(emailLines.length >= 2, "lange E-Mail umgebrochen");
  assert.equal(emailLines.join(""), LONG_EMAIL);
  for (const e of Object.values(d.leads)) assert.ok(all.includes(e.email), `E-Mail vollständig: ${e.email}`);
  // keine internen IDs / Draft-IDs / Quell-URLs
  assert.ok(!/impressum|\/de\/start|gmail|draft/i.test(all));
});

test("I–K: viele Leads – alle Zeilen im PDF und in der CSV, Kopf je Seite, keine Duplikate", async () => {
  const d = loadDirectory(tmp());
  syncDirectory(d, Array.from({ length: 160 }, (_, i) => ({ lead_id: `l${i}.ch`, domain: i % 9 === 0 ? null : `l${i}.ch`, email: `info@l${i}.ch`,
    company: i % 7 === 0 ? null : `${LONG_COMPANY.slice(0, 20 + (i % 60))} ${i}`, draft_status: "DRAFT" })), T0);
  const { buf, rows, pages } = await render(d);
  const lines = pdfLines(buf), all = lines.join("");
  assert.equal(rows, 160);
  assert.ok(pages >= 4);
  assert.equal(lines.filter((l) => l === "Website").length, pages, "Tabellenkopf auf jeder Seite");
  assert.ok(lines.some((l) => l === `Jarvis – Lead-Kontaktliste · Seite ${pages} von ${pages}`.replace("–", "\x96").replace("·", "\xb7")));
  for (const e of Object.values(d.leads)) assert.ok(all.includes(e.email), e.email);
  assert.equal(new Set(pdfLinks(buf)).size, Object.values(d.leads).filter((e) => e.domain).length);
  const csvRows = directoryToCsv(d).slice(1).trimEnd().split("\r\n").slice(1);
  assert.equal(csvRows.length, 160);
  assert.equal(new Set(csvRows).size, 160);
  assert.equal(directoryStats(d).duplicates, 0);
});

test("CSV: Spalten Firma, Website (vollständige URL) … Letzte Prüfung; keine Quell-URLs/IDs", () => {
  const d = sample();
  const csv = directoryToCsv(d);
  const lines = csv.slice(1).trimEnd().split("\r\n");
  assert.deepEqual(CSV_HEADERS, ["Firma", "Website", "E-Mail", "Telefon", "Vorname", "Nachname", "Rolle", "Telefon verifiziert", "Person verifiziert", "Draft Status", "Letzte Prüfung"]);
  assert.equal(lines[0], CSV_HEADERS.join(";"));
  assert.equal(lines.length, 1 + 4);
  assert.ok(lines.some((l) => l.startsWith("Demeter Feldhof GmbH;https://www.demeter-feldhof.ch/;info@demeter-feldhof.ch;'+41 34 123 45 67;Anna;Feld;Inhaberin;ja (hoch);ja (hoch);Entwurf;")));
  assert.ok(lines.some((l) => l.startsWith(";https://ohne-firma.ch/;info@ohne-firma.ch;")));
  assert.ok(lines.some((l) => l.startsWith("Ohne Website AG;;kontakt@ohne-website-test.ch;")));
  assert.ok(!/impressum|\/de\/start|d-|ohne-website;/.test(csv));
});

test("Export schreibt PDF-Zeilen = CSV-Zeilen = Verzeichnis-Leads", async () => {
  const dir = tmp(), out = tmp();
  saveDirectory(dir, sample(), T0);
  const r = await writeExports(loadDirectory(dir), out, { now: T0 });
  assert.equal(r.pdf.rows, 4); assert.equal(r.csv.rows, 4);
  assert.equal(sortedEntries(loadDirectory(dir)).length, 4);
});
