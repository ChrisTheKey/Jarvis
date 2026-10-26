// TF-JARVIS-024: isolierter Browsernachweis des direkten CRM-Mailbuttons.
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { exe, startServer, openCrm, shot } from "./crm-browser-harness.js";

const LEAD_ID = "firma-021.ch";
const RECIPIENT = "info@firma-021.ch";

async function waitForCrm(page, mobile = false) {
  const selector = mobile ? "#crmMain li.crm-lcard" : "#crmMain tbody tr";
  await page.waitForFunction((s) => document.querySelectorAll(s).length === 40, selector, { timeout: 90_000 });
}

async function queuedSalesRequest(srv) {
  const store = srv.mailStore();
  assert.ok(store, "Mail-Queue wurde nicht initialisiert");
  const state = (await store.get()).state;
  const requests = state.requests.filter((r) => r.delivery === "sales_intake" && r.recipient === RECIPIENT);
  assert.equal(requests.length, 1, "genau ein direkter Erstmail-Auftrag muss persistent sein");
  const [request] = requests;
  assert.equal(request.meta.sales_intake_direct, true);
  assert.equal(request.meta.sales_sandbox, true);
  assert.equal(request.meta.synthetic_test, true);
  assert.match(request.body, /^Guten Tag\n\nVielen Dank für Ihr Vertrauen\./);
  assert.match(request.body, /https:\/\/synthetic\.jarvis\.test\/access\.html#t=[A-Za-z0-9_-]{43}/);
  const paymentLinks = [...request.body.matchAll(/https:\/\/buy\.stripe\.com\/[^\s]+/g)].map((match) => match[0]);
  assert.equal(paymentLinks.length, 2, "die Erstmail muss genau zwei Zahlungslinks enthalten");
  assert.ok(paymentLinks.every((link) => /^https:\/\/buy\.stripe\.com\/test_[A-Za-z0-9]{10,64}\?/.test(link)), "nur Stripe-Sandbox-Links zulässig");
  assert.match(request.body, /\[Name des Anbieters\]/);
  return request;
}

function assertNoUnexpectedExternalRequests(external) {
  assert.ok(external.every((url) => /fonts\.(googleapis|gstatic)\.com/.test(url)), `unerlaubte externe Requests: ${external.join(",")}`);
}

test("TF-024 Phase 5: Mail senden queued die Erstmail auf Desktop und Mobile genau einmal und übersteht Reload", { timeout: 180_000 }, async () => {
  assert.ok(exe, "Chromium nicht gefunden; CHROME_PATH muss prozesslokal gesetzt werden");
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const desktopSrv = await startServer({ n: 40 });
  const mobileSrv = await startServer({ n: 40 });
  try {
    const desktop = await openCrm(browser, desktopSrv, { viewport: { width: 1440, height: 900 } });
    await waitForCrm(desktop.page);
    await desktop.page.locator(`#crmMain tr[data-id="${LEAD_ID}"]`).click();
    const drawer = desktop.page.locator(".crm-drawer");
    await drawer.waitFor({ state: "visible" });
    const button = drawer.locator("button.crm-mail-send");
    assert.equal(await button.count(), 1, "Mail-senden-Button fehlt auf Desktop");
    assert.equal(await button.textContent(), "Mail senden");
    assert.equal(await button.isEnabled(), true);
    let dialogSeen = false;
    desktop.page.on("dialog", async (dialog) => { dialogSeen = true; await dialog.dismiss(); });
    await shot(desktop.page, "tf024-direct-desktop-before.png");
    await button.click();
    await desktop.page.waitForFunction(() => !!document.querySelector(".crm-salesbox .crm-sales-msg")?.textContent?.trim(), null, { timeout: 10_000 });
    assert.equal(dialogSeen, false, "der direkte Versand darf keinen Bestätigungsdialog öffnen");
    assert.equal(desktop.posts.filter((p) => p?.op === "sales_intake_send").length, 1);
    assert.equal(desktop.posts.some((p) => p?.op === "sales_intake_preview" || p?.op === "sales_intake_confirm"), false);
    const first = await queuedSalesRequest(desktopSrv);
    assert.equal(first.recipient, RECIPIENT);
    assert.ok(Date.parse(first.meta.access_expires_at) > Date.now(), "Ablaufdatum fehlt oder ist bereits abgelaufen");
    assert.equal(await button.isDisabled(), true, "Button muss nach dem Einreihen gesperrt sein");
    await shot(desktop.page, "tf024-direct-desktop-queued.png");

    const mailStore = desktopSrv.mailStore();
    const queuedState = await mailStore.get();
    const sentAt = new Date().toISOString();
    assert.equal(await mailStore.set({ ...queuedState.state, requests: queuedState.state.requests.map((request) => request.request_id === first.request_id
      ? { ...request, status: "sent", reason: null, updated_at: sentAt } : request) }, queuedState.etag), true, "synthetischer Worker-Status konnte nicht persistiert werden");
    await desktop.page.waitForFunction(() => /Erstmail gesendet/.test(document.querySelector(".crm-sales-msg")?.textContent || ""), null, { timeout: 35_000 });
    assert.equal(await button.textContent(), "Erstmail gesendet", "der Button muss den Worker-Status anzeigen");

    await desktop.page.reload({ waitUntil: "domcontentloaded" });
    await desktop.page.evaluate(() => { document.getElementById("boot").hidden = true; });
    await waitForCrm(desktop.page);
    await desktop.page.locator(`#crmMain tr[data-id="${LEAD_ID}"]`).click();
    await drawer.waitFor({ state: "visible" });
    const reloadedButton = drawer.locator("button.crm-mail-send");
    await reloadedButton.waitFor({ state: "visible" });
    assert.equal(await reloadedButton.isDisabled(), true, "persistenter Queue-Status muss den zweiten Versand verhindern");
    assert.match(await drawer.locator(".crm-sales-msg").textContent(), /eingereiht|gesendet/i);
    assert.equal((await queuedSalesRequest(desktopSrv)).request_id, first.request_id);
    await shot(desktop.page, "tf024-direct-desktop-reloaded.png");
    assertNoUnexpectedExternalRequests(desktop.external);

    const mobile = await openCrm(browser, mobileSrv, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await waitForCrm(mobile.page, true);
    await mobile.page.locator(`#crmMain li[data-id="${LEAD_ID}"]`).click();
    const mobileDrawer = mobile.page.locator(".crm-drawer");
    await mobileDrawer.waitFor({ state: "visible" });
    const mobileButton = mobileDrawer.locator("button.crm-mail-send");
    await mobileButton.waitFor({ state: "visible" });
    assert.equal(await mobileButton.isEnabled(), true, "Mail-senden-Button ist auf Mobile nicht bedienbar");
    await mobileButton.click();
    await mobile.page.waitForFunction(() => !!document.querySelector(".crm-salesbox .crm-sales-msg")?.textContent?.trim(), null, { timeout: 10_000 });
    assert.equal(mobile.posts.filter((p) => p?.op === "sales_intake_send").length, 1);
    assert.equal((await queuedSalesRequest(mobileSrv)).recipient, RECIPIENT);
    assertNoUnexpectedExternalRequests(mobile.external);
    await shot(mobile.page, "tf024-direct-mobile-queued.png");
  } finally {
    await browser.close();
    desktopSrv.close();
    mobileSrv.close();
  }
});
