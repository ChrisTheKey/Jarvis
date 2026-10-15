// TF-053/TF-055 Browser-Test: echte Oberfläche (public/index.html + crm.js) in Chromium, Desktop 1440×900 und Smartphone 390×844.
// Lokaler HTTP-Server: statische Dateien aus public/ + echte /api/crm-Funktion (Speicher im RAM) + echter CRM-Dienst (Temp-Verzeichnis,
// synthetische 387 Leads). Kein Netz nach aussen (fremde Anfragen werden blockiert), keine echten Daten, kein Senden.
// Ohne lokalen Chrome/Edge/Chromium wird der Test übersprungen. Screenshots optional nach $CRM_SHOTS.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadCrm } from "../crm-service.js";
import { fullAuditEntry, SITE_FINDINGS_FILE, REPAIR_FINDINGS_FILE } from "../site-findings.js";
import { exe, startServer, openCrm, noOverflow, shot } from "./crm-browser-harness.js";

test("N: Desktop-Rendering (1440×900) – Tabelle, Karten, Drawer A–F, Links, Speichern über /api/crm, Do Not Contact", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer();
  try {
    const { page, errors, external, posts } = await openCrm(browser, srv, { viewport: { width: 1440, height: 900 } });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain tbody tr").length === 387, null, { timeout: 90_000 });
    assert.equal(await page.locator("#crmCards .crm-card").count(), 13); // TF-058: + „Historische Funde“
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 1440 });
    const heads = await page.locator(".crm-table th").allTextContents();
    for (const h of ["Firma", "Branche", "Website", "Fehler", "Wichtigste Fehler", "Ansprechpartner", "Telefon", "E-Mail", "Draft", "Status", "Telefonstatus", "Nächster Schritt"]) assert.ok(heads.includes(h), h);
    assert.deepEqual(heads.slice(0, 3), ["Firma", "Branche", "Website"], "TF-060: Branche direkt nach Firma");
    assert.equal(await page.locator('#crmMain tr[data-id="firma-021.ch"] td:nth-child(2)').innerText(), "Treuhand");
    assert.equal(await page.locator('#crmMain tr[data-id="firma-022.ch"] td:nth-child(2)').innerText(), "Restaurant");
    const tels = await page.locator('#crmMain a[href^="tel:"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert.ok(tels.length > 200 && tels.every((h) => /^tel:\+41\d{9}$/.test(h)));
    const mails = await page.locator('#crmMain a[href^="mailto:"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    assert.ok(mails.length > 300 && mails.every((h) => /^mailto:[^?&]+$/.test(h)), "mailto ohne Betreff/Text");
    const sites = await page.locator("#crmMain td:nth-child(3) a").evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.target, a.rel]));
    assert.ok(sites.every(([h, t, r]) => /^https:\/\//.test(h) && t === "_blank" && /noopener/.test(r)));
    await shot(page, "crm-desktop.png");
    // Suche + Kartenfilter
    await page.fill("#crmF_q", "firma-007");
    assert.equal(await page.locator("#crmMain tbody tr").count(), 1);
    // TF-060: freie Suche findet die Branche, Branchenfilter bleibt
    await page.fill("#crmF_q", "Treuhand");
    const treu = await page.locator("#crmMain tbody tr td:nth-child(2)").allTextContents();
    assert.ok(treu.length > 100 && treu.every((t) => t === "Treuhand"));
    await page.fill("#crmF_q", "");
    await page.selectOption("#crmF_category", "Restaurant");
    const rest = await page.locator("#crmMain tbody tr td:nth-child(2)").allTextContents();
    assert.ok(rest.length > 100 && rest.every((t) => t === "Restaurant"));
    await page.selectOption("#crmF_category", "");
    await page.click(".crm-card:has-text('Kunden')");
    assert.equal(await page.locator("#crmMain tbody tr").count(), 1);
    await page.click(".crm-card:has-text('Alle Leads')");
    // Detail
    await page.click('#crmMain tr[data-id="firma-021.ch"]');
    await page.waitForSelector("#crmDrawer:not([hidden])");
    const h4 = await page.locator("#crmDrawer h4").allTextContents();
    for (const s of ["A · Kontakt", "B · Website", "C · Website-Zustand", "D · Outreach", "E · Telefon", "F · Notizen"]) assert.ok(h4.includes(s), s);
    assert.match(await page.locator("#crmDrawer .kv").first().innerText(), /Branche\s+Treuhand/);
    assert.equal(await page.locator('#crmDrawer a:has-text("ANRUFEN")').getAttribute("href"), "tel:+41311234567");
    assert.ok(await page.locator('#crmDrawer a:has-text("GMAIL-ENTWURF ÖFFNEN")').count());
    await shot(page, "crm-desktop-detail.png");
    // Notiz speichern (Auftrag → Dienst → Ergebnis)
    await page.fill('#crmDrawer textarea[placeholder^="Neue Notiz"]', "Browser-Testnotiz");
    await page.click('#crmDrawer button:has-text("NOTIZ HINZUFÜGEN")');
    await page.waitForFunction(() => document.getElementById("crmActStatus")?.textContent.includes("Gespeichert"), null, { timeout: 20_000 });
    assert.ok((await page.locator("#crmDrawer .crm-hist").allTextContents()).join(" ").includes("Browser-Testnotiz"));
    assert.equal(loadCrm(srv.dirs.data).leads["firma-021.ch"].notes[0].text, "Browser-Testnotiz");
    // Anruf dokumentieren
    await page.click('#crmDrawer button:has-text("ANRUF DOKUMENTIEREN")');
    await page.selectOption("#crmCallForm select", "CALLBACK_REQUESTED");
    await page.fill("#crmCallForm textarea", "Bitte Donnerstag anrufen");
    await page.click('#crmCallForm button:has-text("ANRUF SPEICHERN")');
    await page.waitForFunction(() => document.getElementById("crmActStatus")?.textContent.includes("Gespeichert"), null, { timeout: 20_000 });
    assert.equal(loadCrm(srv.dirs.data).leads["firma-021.ch"].call_history[0].result, "CALLBACK_REQUESTED");
    // Do Not Contact
    page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Browser-Test" : undefined));
    await page.click('#crmDrawer button:has-text("DO NOT CONTACT SETZEN")');
    await page.waitForSelector("#crmDrawer .crm-dnc-banner", { timeout: 20_000 });
    assert.equal(await page.locator('#crmDrawer a:has-text("ANRUFEN")').count(), 0, "kein Anruf-Knopf bei Do Not Contact");
    assert.equal(await page.locator('#crmMain tr.dnc[data-id="firma-021.ch"]').count(), 1);
    assert.equal(loadCrm(srv.dirs.data).leads["firma-021.ch"].do_not_contact, true);
    assert.deepEqual(errors, []);
    assert.ok(external.every((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)), "keine fremden Anfragen ausser Schriften (blockiert)");
    assert.ok(posts.length && posts.every((p) => p === "/api/crm"), "Schreiben nur über /api/crm");
  } finally { srv.close(); await browser.close(); }
});

test("M: Mobile-Rendering (390×844) – Karten, grosse ANRUFEN/WEBSITE/ENTWURF-Knöpfe, kein Querscrollen, Drawer bildschirmbreit", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer();
  try {
    const { page, errors } = await openCrm(browser, srv, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain li.crm-lcard").length === 387, null, { timeout: 90_000 });
    assert.equal(await page.locator("#crmMain table").count(), 0, "Karten statt Tabelle");
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 390 });
    const card = page.locator('#crmMain li[data-id="firma-021.ch"]');
    const text = await card.textContent();
    for (const s of ["Firma 21 AG", "Fehler", "Wichtigste 2", "Telefon", "Ansprechpartner", "Entwurf bereit"]) assert.ok(text.includes(s), s);
    assert.match(await card.locator(".crm-cat").innerText(), /^Branche:\s+Treuhand$/i, "TF-060: Branche auf der Karte");
    const call = card.locator('a:has-text("ANRUFEN")');
    assert.equal(await call.getAttribute("href"), "tel:+41311234567");
    const box = await call.boundingBox();
    assert.ok(box.height >= 44, "Touch-Ziel ≥ 44 px");
    assert.ok(await card.locator('a:has-text("WEBSITE ÖFFNEN")').count());
    assert.ok(await card.locator('a:has-text("ENTWURF ÖFFNEN")').count());
    assert.equal(await page.locator('#crmMain li[data-id="firma-011.ch"] a:has-text("ANRUFEN")').count(), 0, "DNC-Lead ohne Anruf-Knopf");
    await shot(page, "crm-mobile.png");
    await card.locator("h3").tap();
    await page.waitForSelector("#crmDrawer:not([hidden])");
    const w = await page.locator("#crmDrawer").evaluate((d) => d.getBoundingClientRect().width);
    assert.equal(Math.round(w), 390);
    const inputs = await page.locator("#crmDrawer textarea, #crmDrawer input, #crmDrawer select").evaluateAll((xs) => xs.filter((x) => x.offsetParent).map((x) => parseFloat(getComputedStyle(x).fontSize)));
    assert.ok(inputs.every((f) => f >= 16), "kein iOS-Zoom (Schrift ≥ 16 px)");
    assert.ok(await page.evaluate(() => document.getElementById("crmDrawer").scrollWidth <= 391));
    await shot(page, "crm-mobile-detail.png");
    assert.deepEqual(errors, []);
  } finally { srv.close(); await browser.close(); }
});

// ---------- TF-055: Website-Fehlerzahl (gleiche Datei = nacheinander, nie zwei Browser parallel) ----------
// Fehler-Spalte (genau vs. „≥“), Top 2, Detail „Website-Zustand“, Zähler/Filter; synthetische Voll-Audits + Repair-Stand.
const AT = new Date(Date.now() - 3600_000).toISOString();
const COMPLETE = { links_found: 9, links_checked: 9, links_skipped: 0, links_unverified: 0, images_found: 2, images_checked: 2, images_skipped: 0, images_unverified: 0, deadline_hit: false };
const iss = (type, url, page, severity = "medium", extra = {}) => ({ type, url, page, severity, evidence: "HTTP 404", detectedAt: AT, ...extra });
function prepare({ data, repairDir }) {
  const H = "https://firma-021.ch";
  const seven = [iss("contact_page_broken", `${H}/kontakt`, `${H}/`, "high"), iss("broken_link", `${H}/team`, `${H}/`, "medium", { label: "Team" }),
    iss("broken_link", `${H}/blog`, `${H}/`, "medium", { label: "Blog" }), iss("broken_link", `${H}/angebot`, `${H}/`, "medium", { label: "Angebot" }),
    iss("broken_image", `${H}/img/a.jpg`, `${H}/`), iss("no_mobile_viewport", `${H}/`, null), iss("https_certificate", `${H}/`, null, "high")];
  const full = (d, issues, at = AT) => fullAuditEntry({ reachable: true, coverage: COMPLETE, issues }, { domain: d, audited_at: at });
  const domains = {
    "firma-021.ch": { domain: "firma-021.ch", full: full("firma-021.ch", seven) },
    "firma-022.ch": { domain: "firma-022.ch", full: full("firma-022.ch", []) },
    "firma-023.ch": { domain: "firma-023.ch", full: full("firma-023.ch", [iss("broken_image", "https://firma-023.ch/x.png", "https://firma-023.ch/")], "2026-09-01T08:00:00.000Z") },
  };
  fs.writeFileSync(path.join(data, SITE_FINDINGS_FILE), JSON.stringify({ schema: 1, domains }));
  const D = "https://firma-024.ch";
  fs.writeFileSync(path.join(repairDir, REPAIR_FINDINGS_FILE), JSON.stringify({ schema: 1, orders: { "firma-024.ch": { domain: "firma-024.ch", state: "COMPLETED_WITH_MANUAL_ITEMS", completion: "WITH_MANUAL_ITEMS", audited_at: AT,
    findings: [{ key: "link|a", type: "contact_page_broken", category: "contact", text: "Kontaktseite führt auf eine Fehlerseite", page: `${D}/`, severity: "high", verified_at: AT, status: "RESOLVED", source: "repair", manual: false },
      { key: "image|b", type: "broken_image", category: "images", text: "Bild auf Seite «Datenschutz» wird nicht angezeigt", page: `${D}/datenschutz`, severity: "medium", verified_at: AT, status: "OPEN", source: "repair", manual: true },
      { key: "image|c", type: "broken_image", category: "images", text: "Bild auf Seite «Agb» wird nicht angezeigt", page: `${D}/agb`, severity: "medium", verified_at: AT, status: "OPEN", source: "repair", manual: true }] } } }));
}

test("K: Desktop (1440×900) – Fehler-Spalte (genau vs. „≥“), Top 2 separat, Detail mit allen Fehlern, Zähler + Filter, kein Querscrollen", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer({ prepare });
  try {
    const { page, errors, posts } = await openCrm(browser, srv, { viewport: { width: 1440, height: 900 } });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain tbody tr").length === 387, null, { timeout: 90_000 });
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 1440 });
    const heads = await page.locator(".crm-table th").allTextContents();
    for (const h of ["Firma", "Website", "Fehler", "Wichtigste Fehler", "Ansprechpartner", "Telefon", "Status", "Nächster Schritt"]) assert.ok(heads.includes(h), h);
    const errCol = heads.indexOf("Fehler") + 1, topCol = heads.indexOf("Wichtigste Fehler") + 1;
    const cell = (id, col) => page.locator(`#crmMain tr[data-id="${id}"] td:nth-child(${col})`).innerText();
    assert.match(await cell("firma-021.ch", errCol), /^7\s/, "vollständig: genaue Zahl");
    assert.match(await cell("firma-021.ch", errCol), /Vollständig/i);
    assert.match(await cell("firma-001.ch", errCol), /^≥2\s/, "Teilprüfung: nur Mindestzahl");
    assert.match(await cell("firma-001.ch", errCol), /Teilprüfung/i);
    assert.match(await cell("firma-023.ch", errCol), /1 \(veraltet\)/);
    assert.match(await cell("firma-022.ch", errCol), /^0\s/);
    assert.match(await cell("firma-024.ch", errCol), /^2\s/, "nach Reparatur: nur offene (manuelle) Punkte");
    // TF-059: konkret Quellseite → Element (darunter Ziel → Ergebnis) statt nur Kurztext.
    const top = await page.locator(`#crmMain tr[data-id="firma-021.ch"] td:nth-child(${topCol}) li .it`).allTextContents();
    assert.deepEqual(top, ["Startseite → Link zu /kontakt", "Startseite → Website-Aufruf"]);
    assert.match(await cell("firma-022.ch", topCol), /Keine aktuell verifizierten Fehler/);
    // Zähler
    const card = async (label) => Number(await page.locator(`#crmErrCards .crm-card:has-text("${label}") b`).textContent());
    assert.equal(await card("Vollständig geprüft"), 3);
    assert.equal(await card("6+ Fehler"), 1);
    assert.ok(await card("Nur teilgeprüft") > 300);
    // Filter: Audit, Fehler, Wichtiges Problem, Suche kombiniert
    await page.selectOption("#crmF_audit", "FULL");
    assert.equal(await page.locator("#crmMain tbody tr").count(), 3);
    await page.selectOption("#crmF_errors", "6+");
    assert.deepEqual(await page.locator("#crmMain tbody tr").evaluateAll((rs) => rs.map((r) => r.dataset.id)), ["firma-021.ch"]);
    await page.selectOption("#crmF_errors", ""); await page.selectOption("#crmF_audit", "STALE");
    assert.deepEqual(await page.locator("#crmMain tbody tr").evaluateAll((rs) => rs.map((r) => r.dataset.id)), ["firma-023.ch"]);
    await page.selectOption("#crmF_audit", ""); await page.selectOption("#crmF_issue", "images");
    assert.ok((await page.locator("#crmMain tbody tr").count()) >= 2);
    await page.selectOption("#crmF_issue", "");
    await page.fill("#crmF_q", "firma-021");
    assert.equal(await page.locator("#crmMain tbody tr").count(), 1);
    await page.fill("#crmF_q", "");
    await page.click('#crmErrCards .crm-card:has-text("Vollständig geprüft")');
    assert.equal(await page.locator("#crmMain tbody tr").count(), 3);
    await page.click('#crmErrCards .crm-card:has-text("Vollständig geprüft")');
    assert.equal(await page.locator("#crmMain tbody tr").count(), 387);
    await shot(page, "crm055-desktop.png");
    // Detail: Website-Zustand
    await page.click('#crmMain tr[data-id="firma-021.ch"]');
    await page.waitForSelector("#crmDrawer:not([hidden])");
    const d = await page.locator("#crmDrawer").innerText();
    for (const s of ["WEBSITE-ZUSTAND", "7 Fehler (verifiziert)", "Vollständig", "Zuletzt geprüft", "WICHTIGSTE FEHLER", "#1", "#2", "Quellseite: Startseite", "Schweregrad: hoch", "ALLE VERIFIZIERTEN FEHLER (7)"]) assert.ok(d.toUpperCase().includes(s.toUpperCase()), s);
    assert.equal(await page.locator("#crmDrawer .crm-topd li").count(), 2);
    assert.equal(await page.locator("#crmDrawer .crm-topd + h5 + ul li").count(), 7, "alle verifizierten Fehler");
    await shot(page, "crm055-desktop-detail.png");
    await page.click('#crmDrawer button:has-text("SCHLIESSEN")');
    await page.click('#crmMain tr[data-id="firma-024.ch"]');
    const d2 = await page.locator("#crmDrawer").innerText();
    assert.ok(d2.includes("Automatisch repariert (1) + 2 manuelle Punkte offen"), "Repair-Stand sichtbar");
    assert.ok(d2.includes("manueller Punkt"));
    await page.click('#crmDrawer button:has-text("SCHLIESSEN")');
    await page.click('#crmMain tr[data-id="firma-001.ch"]');
    const d3 = await page.locator("#crmDrawer").innerText();
    assert.ok(d3.includes("Mindestens 2 verifizierte Fehler") && d3.includes("Nur Teilprüfung – es können weitere Fehler vorhanden sein."));
    assert.ok(!/(^|\n)2 Fehler/.test(d3), "Teilmenge nie als genaue Zahl");
    assert.deepEqual(errors, []);
    assert.deepEqual(posts, [], "reines Anzeigen schreibt nichts");
  } finally { srv.close(); await browser.close(); }
});

test("L: Mobile (390×844) – Karte FEHLER + WICHTIGSTE 2 + Ansprechpartner/Telefon/Stage, Detail mit allen Fehlern, kein Querscrollen/Abschneiden", { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer({ prepare });
  try {
    const { page, errors } = await openCrm(browser, srv, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain li.crm-lcard").length === 387, null, { timeout: 90_000 });
    assert.deepEqual(await noOverflow(page), { doc: true, crm: true, w: 390 });
    const card = page.locator('#crmMain li[data-id="firma-021.ch"]');
    const t = await card.innerText();
    for (const s of ["Firma 21 AG", "firma-021.ch", "FEHLER:", "7", "VOLLSTÄNDIG", "WICHTIGSTE 2:", "Startseite → Link zu /kontakt", "HTTP 404", "Startseite → Website-Aufruf", "Ansprechpartner", "Telefon", "Entwurf bereit"])
      assert.ok(t.toUpperCase().includes(s.toUpperCase()), s);
    assert.match(await page.locator('#crmMain li[data-id="firma-001.ch"] .crm-err').innerText(), /^≥2$/);
    // Nichts abgeschnitten: jedes Kartenelement passt in die Karte.
    const clipped = await page.locator("#crmMain li.crm-lcard").evaluateAll((cards) => cards.slice(0, 60).flatMap((c) => {
      const cb = c.getBoundingClientRect();
      return [...c.querySelectorAll("*")].filter((x) => { const b = x.getBoundingClientRect(); return b.width && (b.right > cb.right + 1 || b.left < cb.left - 1); }).map((x) => x.className || x.tagName);
    }));
    assert.deepEqual(clipped, []);
    await shot(page, "crm055-mobile.png");
    await card.locator("h3").tap();
    await page.waitForSelector("#crmDrawer:not([hidden])");
    assert.equal(await page.locator("#crmDrawer .crm-topd li").count(), 2);
    assert.equal(await page.locator("#crmDrawer .crm-topd + h5 + ul li").count(), 7);
    assert.ok(await page.evaluate(() => document.getElementById("crmDrawer").scrollWidth <= 391));
    await shot(page, "crm055-mobile-detail.png");
    assert.deepEqual(errors, []);
  } finally { srv.close(); await browser.close(); }
});
