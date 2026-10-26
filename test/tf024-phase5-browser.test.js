// TF-JARVIS-024 Phase 5: gezielter Browsernachweis des Verkaufsdialogs.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { exe, startServer, openCrm, shot } from "./crm-browser-harness.js";

const LEAD_ID = "firma-021.ch";

test("TF-024 Phase 5: CRM-Verkaufsdialog zeigt drei gebundene Links und queued die Erstmail idempotent", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer({ n: 40 });
  try {
    const { page, posts, external } = await openCrm(browser, srv, { viewport: { width: 1440, height: 900 } });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain tbody tr").length === 40, null, { timeout: 90_000 });
    await page.locator(`#crmMain tr[data-id="${LEAD_ID}"]`).click();
    const drawer = page.locator(".crm-drawer");
    await drawer.waitFor({ state: "visible" });
    await shot(page, "phase5-lead-detail.png");

    const button = drawer.locator("button.crm-sales-start");
    assert.equal(await button.count(), 1, "Verkaufsbutton fehlt");
    assert.equal(await button.isEnabled(), true, "Verkaufsbutton ist deaktiviert");
    const dialogPromise = new Promise((resolve) => page.once("dialog", (dialog) => {
      const message = dialog.message();
      dialog.accept().then(() => resolve(message));
    }));
    await button.click();
    const dialogMessage = await dialogPromise;
    await shot(page, "phase5-preview.png");
    await page.waitForFunction(() => document.querySelector(".crm-salesbox .crm-sales-msg")?.textContent?.trim(), null, { timeout: 10_000 });

    assert.match(dialogMessage, /info@firma-021\.ch/i, "Empfänger fehlt in der Vorschau");
    assert.match(dialogMessage, /CHF 150:\s+https?:\/\//i, "CHF-150-Link fehlt");
    assert.match(dialogMessage, /CHF 480:\s+https?:\/\//i, "CHF-480-Link fehlt");
    assert.match(dialogMessage, /Kundentresor:\s+https?:\/\//i, "Tresorlink fehlt");
    assert.match(dialogMessage, /Ihre Webseite/i, "Betreff fehlt in der Vorschau");
    await shot(page, "phase5-send-status.png");

    const salesPosts = posts.filter((p) => p.op === "sales_intake_preview" || p.op === "sales_intake_confirm");
    assert.equal(salesPosts.filter((p) => p.op === "sales_intake_preview").length, 1);
    assert.equal(salesPosts.filter((p) => p.op === "sales_intake_confirm").length, 1);
    assert.ok(external.every((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)), `unerlaubte externe Requests: ${external.join(",")}`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.evaluate(() => { document.getElementById("boot").hidden = true; });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain tbody tr").length === 40, null, { timeout: 10_000 });
    await page.locator(`#crmMain tr[data-id="${LEAD_ID}"]`).click();
    const queued = await page.evaluate(async (leadId) => {
      const r = await fetch("/api/mail-requests", { credentials: "same-origin" });
      const j = await r.json();
      return (j.requests || []).filter((x) => x.delivery === "sales_intake" && x.recipient === "info@firma-021.ch");
    }, LEAD_ID);
    assert.equal(queued.length, 1, "Erstmail ist nach Reload nicht persistent genau einmal vorhanden");
    assert.equal(new Set(queued.map((x) => x.request_id)).size, 1, "Erstmail-Auftrag ist nicht eindeutig persistent");
  } finally {
    await browser.close();
    srv.close();
  }
});

test("TF-024 Phase 5: Verkaufsbutton bleibt auf Mobile sichtbar und bedienbar", async () => {
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const srv = await startServer({ n: 40 });
  try {
    const { page } = await openCrm(browser, srv, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.waitForFunction(() => document.querySelectorAll("#crmMain li.crm-lcard").length === 40, null, { timeout: 90_000 });
    await page.locator(`#crmMain li[data-id="${LEAD_ID}"]`).click();
    const button = page.locator(".crm-drawer button.crm-sales-start");
    await button.waitFor({ state: "visible" });
    assert.equal(await button.isEnabled(), true);
    await shot(page, "phase5-mobile-detail.png");
  } finally {
    await browser.close();
    srv.close();
  }
});
