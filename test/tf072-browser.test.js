// TF-072 Browser-Test (echter Chromium): direkte Fehlerlinks im CRM-Detail (Chris, CH-Kette site_findings → CRM-Dienst → /api/crm → UI)
// und in der Anrufansicht von Kudoshin (vi-VN). Jeder Link öffnet nur die betroffene Seite im neuen Tab (noopener noreferrer); unbekannte
// Seiten zeigen «Direktlink nicht verfügbar», unsichere Adressen werden nie verlinkt. Keine externen Requests, keine Anrufe.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, exe, openCrm, loginAs, noOverflow } from "./crm-browser-harness.js";
import { PW, vnLeads } from "./tf063-helpers.js";
import { fullAuditEntry, SITE_FINDINGS_FILE } from "../site-findings.js";
import { cleanCrmLead } from "../lead-crm.js";

const AT = new Date(Date.now() - 3_600_000).toISOString();
const COMPLETE = { links_found: 3, links_checked: 3, images_found: 1, images_checked: 1, deadline_hit: false };
const H = "https://firma-021.ch";
function prepare({ data }) {
  const issues = [{ type: "contact_page_broken", url: `${H}/kontakt/`, page: `${H}/`, evidence: `HTTP 404 (verlinkt auf ${H}/)`, severity: "high", label: "Kontakt" },
    { type: "broken_link", url: `${H}/angebot/alt`, page: `${H}/angebot/`, evidence: `HTTP 404 (verlinkt auf ${H}/angebot/)`, label: "Alt" },
    { type: "broken_image", url: `${H}/img/team.jpg`, page: `${H}/leistungen/`, evidence: `Bild liefert HTTP 404 (eingebunden auf ${H}/leistungen/)` }];
  const unknown = { key: "text|telefon", type: null, category: "contact", text: "Telefonnummer auf der Website falsch", page: null, target: null, severity: "high", verified_at: AT, status: "OPEN" };
  fs.writeFileSync(path.join(data, SITE_FINDINGS_FILE), JSON.stringify({ schema: 1, domains: {
    "firma-021.ch": { domain: "firma-021.ch", full: fullAuditEntry({ reachable: true, coverage: COMPLETE, issues }, { domain: "firma-021.ch", audited_at: AT }) },
    "firma-022.ch": { domain: "firma-022.ch", full: { domain: "firma-022.ch", audited_at: AT, complete: true, findings: [unknown] } } } }));
}
const linkInfo = (page, sel) => page.locator(sel).evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.textContent })));
const allHrefs = (page) => page.locator("#crmDrawer a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));

test("TF-072 CRM-Detail (Chris, CH): je Fehler betroffene Seite + «Fehler öffnen» im neuen Tab; unbekannt → «Direktlink nicht verfügbar»",
  { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    const srv = await startServer({ n: 40, prepare });
    try {
      const { page, errors, posts } = await openCrm(browser, srv, { viewport: { width: 1440, height: 900 } });
      await page.waitForFunction(() => document.querySelectorAll("#crmMain tbody tr").length === 40, null, { timeout: 90_000 });
      await page.click('#crmMain tr[data-id="firma-021.ch"]');
      await page.waitForSelector("#crmDrawer:not([hidden]) .crm-iopen");
      const opens = await linkInfo(page, "#crmDrawer .crm-find:not(.crm-topd) a.crm-iopen");
      assert.deepEqual(opens.map((x) => x.href).sort(), [`${H}/`, `${H}/angebot/`, `${H}/leistungen/`].sort(), "jeder Fehler mit eigener betroffener Seite");
      for (const x of [...opens, ...(await linkInfo(page, "#crmDrawer a.crm-itarget"))]) {
        assert.equal(x.target, "_blank"); assert.equal(x.rel, "noopener noreferrer");
      }
      assert.ok(opens.every((x) => x.text === "Fehler öffnen"));
      const targets = (await linkInfo(page, "#crmDrawer .crm-find:not(.crm-topd) a.crm-itarget")).map((x) => x.href).sort();
      assert.deepEqual(targets, [`${H}/angebot/alt`, `${H}/img/team.jpg`, `${H}/kontakt/`].sort());
      const d = await page.locator("#crmDrawer").innerText();
      assert.match(d, /Fehler: Startseite → «Kontakt»/); assert.match(d, /Betroffene Seite:/);
      // TF-076: Anrufer-Karten ganz oben – FEHLER · SEITE · POSITION · WARUM FEHLER · AUSWIRKUNG, je Fehler einzeln.
      const top = page.locator("#crmDrawer .crm-errtop");
      assert.equal(await top.locator(".crm-icard").count(), 3);
      const tt = await top.innerText();
      for (const x of ["FEHLER", "SEITE", "POSITION", "WARUM FEHLER", "AUSWIRKUNG", "Kontaktseite nicht erreichbar", "Kaputter Link", "Bild wird nicht geladen", "«Alt»", "HTTP 404"]) assert.ok(tt.includes(x), x);
      assert.deepEqual((await linkInfo(page, "#crmDrawer .crm-errtop a.crm-iopen")).map((x) => x.href), [`${H}/`, `${H}/angebot/`, `${H}/leistungen/`]);
      assert.ok(await page.evaluate(() => { const a = document.querySelector("#crmDrawer .crm-errtop"), b = [...document.querySelectorAll("#crmDrawer h4")].find((h) => /Kontakt/.test(h.textContent)); return !!a && !!b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) > 0; }), "Fehler vor den Kontaktdaten");
      assert.ok(await page.evaluate(() => document.getElementById("crmDrawer").scrollWidth <= document.getElementById("crmDrawer").clientWidth + 1), "kein Querscrollen");
      // Unbekannte Seite: kein Link, ehrlicher Hinweis, nie die Startseite als Ersatz.
      await page.click('#crmMain tr[data-id="firma-022.ch"]');
      await page.waitForFunction(() => /Telefonnummer auf der Website falsch/.test(document.getElementById("crmDrawer").innerText));
      assert.equal(await page.locator("#crmDrawer a.crm-iopen").count(), 0);
      assert.match(await page.locator("#crmDrawer").innerText(), /Direktlink nicht verfügbar/);
      assert.deepEqual(errors, []); assert.deepEqual(posts, []);
    } finally { srv.close(); await browser.close(); }
  });

test("TF-072 Anrufansicht Kudoshin (vi-VN, Mobile): Website, Fehler, Auswirkung, betroffene Seite, «Mở lỗi»; unsichere URLs nie verlinkt",
  { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
    const leads = vnLeads(4);
    const d0 = leads[0].domain;
    const items = [
      { key: "mailto|page:/lien-he", type: "broken_mailto", category: "contact", text: "Liên kết email trên trang Liên hệ không hoạt động", page: `https://${d0}/lien-he`, severity: "high", verified_at: AT, status: "OPEN", source: "full_audit" },
      { key: `link|${d0}/dich-vu/cu`, type: "broken_link", category: "http", text: "Liên kết dẫn tới trang lỗi", page: `https://${d0}/dich-vu`, target: `https://${d0}/dich-vu/cu`, http_status: 404, severity: "medium", verified_at: AT, status: "OPEN", source: "full_audit" },
      { key: "text|cu", type: null, category: "other", text: "Phát hiện cũ không có trang", page: null, severity: "low", verified_at: AT, status: "OPEN", source: "cold" },
      { key: "cert|site", type: "https_certificate", category: "navigation", text: "Trình duyệt hiển thị cảnh báo", page: "http://192.168.1.10/", severity: "high", verified_at: AT, status: "OPEN", source: "full_audit" },
      { key: "area:x", type: "visible_layout_error", category: "other", text: "Bố cục bị lệch", page: `https://${d0}/`, affected_url: "javascript:alert(1)", location: "Đầu trang", severity: "low", verified_at: AT, status: "OPEN", source: "full_audit" }];
    leads[0] = cleanCrmLead({ ...leads[0], errors: { audit: "FULL", count: 5, exact: true, checked_at: AT, full_checked_at: AT, scope: "x", top: items.slice(0, 2), items, resolved: 0, manual_open: 0 } });
    const srv = await startServer({ n: 20, vnLeads: leads, sellers: { Kudoshin: PW.Kudoshin } });
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await loginAs(ctx, srv, "Kudoshin", PW.Kudoshin);
      const page = await ctx.newPage();
      const errors = [], external = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.route("**/*", (r) => { const u = r.request().url(); if (!u.startsWith(srv.url)) { external.push(u); return r.abort(); } return r.continue(); });
      page.on("dialog", (d) => d.dismiss());
      await page.goto(srv.url + "/sales.html");
      await page.waitForFunction(() => !document.getElementById("app").hidden);
      await page.click("#crmBtn");
      await page.waitForFunction(() => document.querySelectorAll("#crmMain [data-id]").length > 0);
      await page.click(`#crmMain [data-id="${d0}"]`);
      await page.waitForSelector("#crmDrawer:not([hidden]) .crm-callissues .crm-iopen", { timeout: 15_000 })
        .catch(async (e) => { console.log("DRAWER:", (await page.evaluate(() => document.getElementById("crmDrawer").innerText)).slice(0, 3000), errors); throw e; });
      const box = page.locator("#crmDrawer .crm-callissues");
      const t = await box.innerText();
      // TF-076: gleiche Anrufer-Karten wie im Detail (LỖI · TRANG · VỊ TRÍ · VÌ SAO LÀ LỖI · ẢNH HƯỞNG).
      for (const s of ["Website", d0, "LỖI", "TRANG", "VỊ TRÍ", "VÌ SAO LÀ LỖI", "ẢNH HƯỞNG", "Liên kết email bị lỗi", "Mở lỗi", "Không có liên kết trực tiếp", "Khách không gửi được email qua liên kết này."]) assert.ok(t.includes(s), s);
      const opens = await linkInfo(page, "#crmDrawer .crm-callissues a.crm-iopen");
      assert.deepEqual(opens.map((x) => x.href), [`https://${d0}/lien-he`, `https://${d0}/dich-vu`], "zwei bekannte Seiten einzeln, Reihenfolge wie Priorität");
      for (const x of opens) { assert.equal(x.target, "_blank"); assert.equal(x.rel, "noopener noreferrer"); assert.equal(x.text, "Mở lỗi"); }
      assert.equal(await box.locator(".crm-inone").count(), 3, "unbekannt + privat + javascript → kein Link");
      const hrefs = await allHrefs(page);
      assert.ok(!hrefs.some((h) => /^javascript:|^data:|192\.168\.|127\.0\.0\.1/i.test(h)), hrefs.join("\n"));
      assert.equal(await page.locator(`#crmDrawer a.crm-iopen[href="https://${d0}/"]`).count(), 0, "kein Startseiten-Ersatz");
      assert.deepEqual((await noOverflow(page)).doc, true);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      await ctx.close();
    } finally { srv.close(); await browser.close(); }
  });
