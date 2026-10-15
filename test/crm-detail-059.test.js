// TF-059 – CRM „Wichtigste Fehler“ konkret: Quellseite + Element + Ziel + tatsächlich beobachtetes Ergebnis. Nur belegte Werte
// (kein erfundener HTTP-Status/Linktext/Seite), Kundentext der Cold-Mail unverändert, Top-2-Reihenfolge unverändert.
// Nur synthetische Daten, kein Netz nach aussen, kein Senden. Browser-Tests I/J nacheinander (nie zwei Chromium parallel).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizeIssue, fullAuditEntry, siteHealth, partialFindings, SITE_FINDINGS_FILE } from "../site-findings.js";
import { cleanCrmLead, cleanErrors, findingsOf } from "../lead-crm.js";
import { issueLines, issueFacts } from "../public/crm-model.js";
import { selectCustomerVisibleFindings, CUSTOMER_JARGON_RE } from "../swiss-repair.js";
import { exe, startServer, openCrm, noOverflow, shot, ROOT } from "./crm-browser-harness.js";

const AT = new Date(Date.now() - 3600_000).toISOString();
const H = "https://firma-021.ch";
const COMPLETE = { links_found: 9, links_checked: 9, links_skipped: 0, links_unverified: 0, images_found: 2, images_checked: 2, images_skipped: 0, images_unverified: 0, deadline_hit: false };
const audit = (type, url, page, evidence, extra = {}) => ({ type, url, page, evidence, severity: "medium", detectedAt: AT, ...extra });
const norm = (i) => normalizeIssue(i, { verified_at: AT });
const both = (f) => { const l = issueLines(f); return `${l.title} | ${l.detail || ""}`; };

test("A: broken_link mit Quellseite, Linktext, Ziel und HTTP 404 → alle vier Informationen sichtbar", () => {
  const f = norm(audit("broken_link", `${H}/ueber-uns/`, `${H}/`, `HTTP 404 (verlinkt auf ${H}/)`, { label: "Über uns" }));
  assert.equal(f.http_status, 404); assert.equal(f.label, "Über uns");
  assert.deepEqual(issueLines(f), { title: "Startseite → «Über uns»", detail: "/ueber-uns/ → HTTP 404" });
  const x = issueFacts(f);
  assert.deepEqual([x.source, x.element, x.target, x.result], ["Startseite", "«Über uns»", "/ueber-uns/", "HTTP 404"]);
  // Über die Cloud-Allowlist: crm_title/crm_detail werden mitgeliefert, Kurztext bleibt natürlich.
  const c = cleanErrors({ audit: "FULL", count: 1, top: [f], items: [f] }).top[0];
  assert.equal(c.crm_title, "Startseite → «Über uns»"); assert.equal(c.crm_detail, "/ueber-uns/ → HTTP 404");
  assert.equal(c.text, "Link «Über uns» führt auf eine Fehlerseite");
  // Unterseite als Quelle, 500
  assert.equal(both(norm(audit("broken_link", `${H}/kontakt/`, `${H}/leistungen/`, `HTTP 500 (verlinkt auf ${H}/leistungen/)`, { label: "Kontakt" }))),
    "/leistungen/ → «Kontakt» | /kontakt/ → HTTP 500");
});

test("B: broken_link ohne HTTP-Code → kein erfundener 404, ehrlich „Zielseite nicht erreichbar“; ohne Linktext „Link zu …“", () => {
  const f = norm(audit("broken_link", `${H}/kontakt/`, `${H}/`, `(verlinkt auf ${H}/)`, { label: "Kontakt" }));
  assert.equal(f.http_status, null);
  assert.equal(both(f), "Startseite → «Kontakt» | /kontakt/ → Zielseite nicht erreichbar");
  assert.ok(!/404|HTTP/.test(both(f)));
  const g = norm(audit("broken_link", `${H}/kontakt/`, `${H}/`, `HTTP 404 (verlinkt auf ${H}/)`));
  assert.equal(both(g), "Startseite → Link zu /kontakt/ | HTTP 404");
  // Query-Tokens nie anzeigen; externe Ziele gekürzt, ohne Query.
  const q = norm(audit("broken_link", `${H}/login?token=abc123secret`, `${H}/`, "HTTP 404", { label: "Login" }));
  assert.ok(!both(q).includes("abc123secret") && !both(q).includes("token="));
  const ext = issueFacts({ type: "broken_link", page: `${H}/`, target: "https://www.partner.example/pfad/seite?sid=geheim", label: "Partner", http_status: 410 });
  assert.equal(ext.target, "partner.example/pfad/seite");
});

test("C: broken_image → Bildpfad + Quellseite konkret", () => {
  const f = norm(audit("broken_image", `${H}/assets/team.jpg`, `${H}/leistungen/`, `Bild liefert HTTP 404 (eingebunden auf ${H}/leistungen/)`));
  assert.deepEqual(issueLines(f), { title: "/leistungen/ → Bild «team.jpg»", detail: "/assets/team.jpg → lädt nicht / HTTP 404" });
  const n = norm(audit("broken_image", `${H}/img/a.png`, `${H}/`, `(eingebunden auf ${H}/)`));
  assert.equal(both(n), "Startseite → Bild «a.png» | /img/a.png → lädt nicht");
});

test("D: contact_form_broken → konkrete Seite + Element (Button)", () => {
  const f = norm({ type: "contact_form_broken", url: `${H}/kontakt/`, page: `${H}/kontakt/`, location: "Absenden", reproducible: true, severity: "high", detectedAt: AT });
  assert.deepEqual(issueLines(f), { title: "/kontakt/ → Kontaktformular · «Absenden»", detail: "Absenden reproduzierbar fehlgeschlagen" });
});

test("E: Mobile-Befund → Viewport + Seite + Element", () => {
  const f = norm({ type: "mobile_text_overlap", url: `${H}/`, page: `${H}/`, location: "Navigationsmenü", viewport: 390, reproducible: true, detectedAt: AT });
  assert.deepEqual(issueLines(f), { title: "Mobile / Startseite → «Navigationsmenü»", detail: "überlappt Inhalt bei 390 px" });
  // ohne belegte Breite keine erfundene Zahl
  const g = norm({ type: "mobile_content_cut_off", url: `${H}/`, page: `${H}/`, location: "Preisliste", reproducible: true, detectedAt: AT });
  assert.equal(both(g), "Mobile / Startseite → «Preisliste» | abgeschnitten");
  assert.equal(both(norm({ type: "no_mobile_viewport", url: `${H}/`, detectedAt: AT })), "Mobile / Startseite → Seitendarstellung | Desktop-Breite, verkleinert");
});

test("F: historischer Fund mit wenig Evidence → ehrlich reduzierte Beschreibung (nichts erfunden)", () => {
  // Nur Kundentext, kein Typ/Seite (alte Lead-Datenbank)
  const [t] = partialFindings([{ text: "Ein Link führt auf eine Fehlerseite", verified_at: "2026-09-01T08:00:00Z" }]);
  assert.deepEqual(issueLines(t), { title: "Ein Link führt auf eine Fehlerseite", detail: null });
  // Typ + Ziel, aber ohne Status/Linktext (TF-058-Historie, normalisierter Altbestand)
  const old = { key: "link|firma-021.ch/kontakt", type: "broken_link", category: "contact", text: "Link zur Seite «Kontakt» führt auf eine Fehlerseite", page: `${H}/`, target: `${H}/kontakt`, severity: "medium", verified_at: "2026-09-01T08:00:00Z" };
  const lines = cleanErrors({ audit: "STALE", count: 1, top: [old], items: [old] }).top[0];
  assert.equal(lines.crm_title, "Startseite → Link zu /kontakt"); assert.equal(lines.crm_detail, "Zielseite nicht erreichbar");
  assert.equal(lines.http_status, null);
  // ohne Quellseite
  assert.equal(issueFacts({ type: "broken_link", target: `${H}/x` }).source, "Seite unbekannt");
  // Historisches Abzeichen bleibt (cleanCrmLead-Allowlist)
  assert.equal(cleanCrmLead({ lead_id: "firma-021.ch", history_badge: "HISTORICAL", errors: { audit: "STALE", count: 1, top: [old], items: [old] } }).history_badge, "HISTORICAL");
});

test("G: Top-2-Ranking unverändert (Kontakt vor Zertifikat vor 404 …), nur die Darstellung ist neu", () => {
  const seven = [audit("contact_page_broken", `${H}/kontakt`, `${H}/`, "HTTP 404", { severity: "high" }), audit("broken_link", `${H}/team`, `${H}/`, "HTTP 404", { label: "Team" }),
    audit("broken_link", `${H}/blog`, `${H}/`, "HTTP 500", { label: "Blog" }), audit("broken_image", `${H}/img/a.jpg`, `${H}/`, "Bild liefert HTTP 404"),
    audit("no_mobile_viewport", `${H}/`, null, "meta fehlt"), audit("https_certificate", `${H}/`, null, "cert", { severity: "high" })];
  const e = siteHealth({ full: fullAuditEntry({ reachable: true, coverage: COMPLETE, issues: seven }, { domain: "firma-021.ch", audited_at: AT }) });
  assert.deepEqual(e.top.map((f) => f.type), ["contact_page_broken", "https_certificate"]);
  assert.deepEqual(e.items.map((f) => f.type), ["contact_page_broken", "https_certificate", "broken_link", "broken_link", "broken_image", "no_mobile_viewport"]);
  assert.deepEqual(e.top.map((f) => f.text), ["Kontaktseite führt auf eine Fehlerseite", "Browser zeigt beim Öffnen eine Warnmeldung"], "Kurztexte unverändert");
});

test("H: Cold-Mail-Kundentext unverändert (keine HTTP-Codes/Fachbegriffe), swiss-repair.js nicht verändert", () => {
  const issues = [audit("broken_link", `${H}/kontakt/`, `${H}/`, `HTTP 404 (verlinkt auf ${H}/)`, { label: "Kontakt", http_status: 404, reproducible: true, observedAt: AT }),
    audit("broken_image", `${H}/assets/team.jpg`, `${H}/`, `Bild liefert HTTP 404 (eingebunden auf ${H}/)`, { reproducible: true, observedAt: AT })];
  const withFacts = selectCustomerVisibleFindings(issues).map((f) => f.text);
  const without = selectCustomerVisibleFindings(issues.map(({ http_status, ...i }) => i)).map((f) => f.text);
  assert.deepEqual(withFacts, without);
  for (const t of withFacts) assert.ok(!CUSTOMER_JARGON_RE.test(t), t);
  const diff = execFileSync("git", ["diff", "--stat", "HEAD", "--", "swiss-repair.js", "cold-draft-rewrite.js", "mail-writer.md"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(diff.trim(), "", "Cold-Mail-Erzeugung unverändert");
  // Kundentaugliche Befunde im CRM (findings[].text) bleiben der Kundentext; HTTP-Status nur intern.
  const fs0 = findingsOf({ customer_findings: [{ key: "contact", text: "Der Link zu Ihrer Kontaktseite führt auf eine Fehlerseite", internal_refs: [{ issue_type: "broken_link", url: `${H}/kontakt/` }] }],
    issue_evidence: [{ issue_type: "broken_link", url: `${H}/kontakt/`, evidence: `HTTP 404 (verlinkt auf ${H}/)`, label: "Kontakt", observed_at: AT, reproducible: true, severity: "medium" }], updated_at: AT });
  assert.equal(fs0[0].text, "Der Link zu Ihrer Kontaktseite führt auf eine Fehlerseite");
  assert.equal(fs0[0].http_status, 404); assert.equal(fs0[0].label, "Kontakt");
  const cloud = cleanCrmLead({ lead_id: "firma-021.ch", findings: fs0 }).findings[0];
  assert.deepEqual(Object.keys(cloud).sort(), ["confirmed", "key", "page", "severity", "status", "text", "verified_at"], "Findings-Allowlist unverändert");
  // … und über die Teilprüfung landen die Fakten in der konkreten CRM-Zeile.
  assert.equal(both(siteHealth({ partial: fs0, partialCheckedAt: AT }).top[0]), "Startseite → «Kontakt» | /kontakt/ → HTTP 404");
});

// ---------- Browser (Desktop/Mobile) ----------
function prepare({ data }) {
  const issues = [audit("contact_page_broken", `${H}/kontakt/`, `${H}/`, `HTTP 404 (verlinkt auf ${H}/)`, { severity: "high", label: "Kontakt" }),
    audit("broken_link", `${H}/ueber-uns/`, `${H}/`, `HTTP 500 (verlinkt auf ${H}/)`, { label: "Über uns" }),
    audit("broken_image", `${H}/assets/team-mit-einem-sehr-langen-dateinamen-fuer-den-umbruchtest.jpg`, `${H}/leistungen/`, `Bild liefert HTTP 404 (eingebunden auf ${H}/leistungen/)`)];
  const old = { key: "link|firma-022.ch/kontakt", type: "broken_link", category: "contact", text: "Link zur Seite «Kontakt» führt auf eine Fehlerseite", page: "https://firma-022.ch/", target: "https://firma-022.ch/kontakt", severity: "medium", verified_at: AT, status: "OPEN" };
  fs.writeFileSync(path.join(data, SITE_FINDINGS_FILE), JSON.stringify({ schema: 1, domains: {
    "firma-021.ch": { domain: "firma-021.ch", full: fullAuditEntry({ reachable: true, coverage: COMPLETE, issues }, { domain: "firma-021.ch", audited_at: AT }) },
    "firma-022.ch": { domain: "firma-022.ch", full: { domain: "firma-022.ch", audited_at: AT, complete: true, findings: [old] } } } }));
}

test("I: Desktop CRM (1440×900) – Top 2 konkret (Quelle → Element / Ziel → Ergebnis), Detail mit allen Fakten, kein Querscrollen", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer({ n: 40, prepare });
  try {
    const { page, errors, posts } = await openCrm(browser, srv, { viewport: { width: 1440, height: 900 } });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain tbody tr").length === 40, null, { timeout: 90_000 });
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 1440 });
    const topCol = (await page.locator(".crm-table th").allTextContents()).indexOf("Wichtigste Fehler") + 1;
    const li = page.locator(`#crmMain tr[data-id="firma-021.ch"] td:nth-child(${topCol}) li`);
    assert.deepEqual(await li.locator(".it").allTextContents(), ["Startseite → «Kontakt»", "Startseite → «Über uns»"]);
    assert.deepEqual(await li.locator(".id").allTextContents(), ["/kontakt/ → HTTP 404", "/ueber-uns/ → HTTP 500"]);
    const old = page.locator(`#crmMain tr[data-id="firma-022.ch"] td:nth-child(${topCol}) li`);
    assert.deepEqual(await old.locator(".it").allTextContents(), ["Startseite → Link zu /kontakt"]);
    assert.deepEqual(await old.locator(".id").allTextContents(), ["Zielseite nicht erreichbar"], "kein erfundener Status");
    await shot(page, "crm059-desktop.png");
    await page.click('#crmMain tr[data-id="firma-021.ch"]');
    await page.waitForSelector("#crmDrawer:not([hidden])");
    const d = await page.locator("#crmDrawer").innerText();
    for (const s of ["#1 Startseite → «Kontakt»", "Quellseite: Startseite · Element: «Kontakt» · Ziel: /kontakt/ · Beobachtet: HTTP 404 · HTTP-Status: 404",
      "/leistungen/ → Bild «team-mit-einem-sehr-langen-dateinamen-f…»", "lädt nicht / HTTP 404"]) assert.ok(d.includes(s), s);
    assert.ok(await page.evaluate(() => document.getElementById("crmDrawer").scrollWidth <= document.getElementById("crmDrawer").clientWidth + 1));
    await shot(page, "crm059-desktop-detail.png");
    assert.deepEqual(errors, []); assert.deepEqual(posts, []);
  } finally { srv.close(); await browser.close(); }
});

test("J: Mobile CRM (390×844) – konkrete Top 2 umbrechend, kein horizontales Scrollen, nichts abgeschnitten", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer({ n: 40, prepare });
  try {
    const { page, errors } = await openCrm(browser, srv, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain li.crm-lcard").length === 40, null, { timeout: 90_000 });
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 390 });
    const card = page.locator('#crmMain li[data-id="firma-021.ch"]');
    const t = await card.innerText();
    for (const s of ["Startseite → «Kontakt»", "/kontakt/ → HTTP 404", "Startseite → «Über uns»", "/ueber-uns/ → HTTP 500"]) assert.ok(t.includes(s), s);
    const clipped = await page.locator("#crmMain li.crm-lcard").evaluateAll((cards) => cards.flatMap((c) => {
      const cb = c.getBoundingClientRect();
      return [...c.querySelectorAll("*")].filter((x) => { const b = x.getBoundingClientRect(); return b.width && (b.right > cb.right + 1 || b.left < cb.left - 1); }).map((x) => x.className || x.tagName);
    }));
    assert.deepEqual(clipped, []);
    await shot(page, "crm059-mobile.png");
    await card.locator("h3").tap();
    await page.waitForSelector("#crmDrawer:not([hidden])");
    assert.ok(await page.evaluate(() => document.getElementById("crmDrawer").scrollWidth <= 391));
    assert.ok((await page.locator("#crmDrawer").innerText()).includes("/assets/team-mit-einem-sehr-langen"));
    await shot(page, "crm059-mobile-detail.png");
    assert.deepEqual(errors, []);
  } finally { srv.close(); await browser.close(); }
});
