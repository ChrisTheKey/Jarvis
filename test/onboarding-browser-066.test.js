// TF-066 Browser-Test (echter Chromium): Lead-Detail «Tiếp nhận khách hàng» für Kudoshin komplett Vietnamesisch (nur eigene VN-Aufträge),
// Chris sieht «Kunden-Onboarding» auf Deutsch inkl. Übersicht mit Filtern (Onboarding offen, Wartet auf Kunde/Zugang/Bestätigung,
// Manuelle Prüfung, Bereit zur Ausführung). Nie Zugangsdaten/Links/Kunden-E-Mail im DOM. Keine externen Requests.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startServer, exe, loginAs, openCrm } from "./crm-browser-harness.js";
import { vnLeads, PW } from "./tf063-helpers.js";
import { cleanRepair } from "../server-control.js";

const GERMAN = /\b(und|der|die|das|nicht|Zugang|Kunde|Zahlung|Bestätigung|Inhalte|Wartet|Offen|Keine|Erfüllt|Telefon|Auftrag)\b/;
const onb = (o) => ({ kind: "FIX", market: "CH", locale: "de-CH", state: "WAITING_FOR_CONFIRMATION", awaiting: "customer", payment_gate: "met", access: "link_sent", content: "open",
  brief_status: "WAITING_FOR_CONFIRMATION", open_items: 0, reminders: 1, last_customer_reply_at: "2026-10-16T09:00:00.000Z", last_jarvis_reply_at: "2026-10-16T09:05:00.000Z", manual_reason: null,
  changes: { phone_numbers: [{ id: "cc-1", kind: "phone", page: null, section: null, old_text: null, new_text: "031 111 11 11", address: null, customer_confirmed: false, complete: true }],
    email_addresses: [], addresses: [], opening_hours: [], text_replacements: [], spelling_corrections: [], removals: [], additions: [], other_requests: [] }, ...o });

test("TF-066 CRM: Kudoshin sieht Onboarding nur für eigene VN-Aufträge, 100 % Vietnamesisch; Chris: Kunden-Onboarding + Filter", { skip: !exe && "kein Chromium/Chrome/Edge gefunden", timeout: 180_000 }, async () => {
  const vn = vnLeads(6);
  const lapLead = vn.find((l) => l.email && !l.do_not_contact);
  const snapshot = { repair: cleanRepair({ orders: [
    { order_id: "VNFIX-20261016-aaaaaa", domain: lapLead.domain, market: "VN", state: "ACCESS_REQUESTED",
      onboarding: onb({ market: "VN", locale: "vi-VN", state: "WAITING_FOR_ACCESS", content: "none", brief_status: "NO_CONTENT_CHANGES", changes: undefined }) },
    { order_id: "RF480-20261016-bbbbbb", domain: "ch-firma-0001.ch", market: "CH", state: "ACCESS_REQUESTED", onboarding: onb({ state: "MANUAL_REVIEW_REQUIRED", awaiting: "chris", manual_reason: "Preis-/Zahlungsthema – Chris prüft." }) },
  ] }) };
  const srv = await startServer({ n: 30, vnLeads: vn, sellers: { Kudoshin: PW.Kudoshin }, snapshot });
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    // Kudoshin (vi-VN, Smartphone)
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await loginAs(ctx, srv, "Kudoshin", PW.Kudoshin);
    const page = await ctx.newPage();
    const errors = [], external = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/*", (r) => { const u = r.request().url(); if (!u.startsWith(srv.url)) { external.push(u); return r.abort(); } return r.continue(); });
    await page.goto(srv.url + "/sales.html");
    await page.waitForFunction(() => !document.getElementById("app").hidden);
    await page.click("#crmBtn");
    await page.waitForFunction(() => document.querySelectorAll("#crmMain [data-id]").length > 0);
    await page.click(`#crmMain [data-id="${lapLead.lead_id}"]`);
    await page.waitForFunction(() => /Tiếp nhận khách hàng/.test(document.getElementById("crmDrawer").textContent) && /Mức thanh toán/.test(document.getElementById("crmDrawer").textContent), null, { timeout: 10_000 })
      .catch(async (e) => { console.log("DRAWER:", (await page.evaluate(() => document.getElementById("crmDrawer").textContent)).slice(-900), "ERR", errors, await (await ctx.request.get(srv.url + "/api/sales?view=onboarding")).text()); throw e; });
    const box = await page.evaluate(() => document.querySelector("#crmDrawer .crm-onboarding").innerText);
    assert.doesNotMatch(box, GERMAN, box);
    for (const w of ["Mức thanh toán", "Đã đạt", "Quyền truy cập", "Đã gửi đường liên kết", "Thay đổi nội dung", "Không có", "Đang chờ", "Khách hàng", "Chờ quyền truy cập"]) assert.ok(box.includes(w), w);
    // Übersicht: nur der eigene VN-Auftrag.
    await page.keyboard.press("Escape"); // Detail schliessen (Smartphone: Drawer überdeckt die Leiste)
    await page.click("#crmOnbBtn");
    await page.waitForFunction(() => document.querySelectorAll("#crmOnboarding .crm-onb").length > 0);
    const panel = await page.evaluate(() => document.getElementById("crmOnboarding").innerText);
    assert.ok(panel.includes("VNFIX-20261016-aaaaaa") && !panel.includes("RF480-20261016-bbbbbb"), "keine CH-/fremden Aufträge");
    assert.doesNotMatch(panel.replace(/VNFIX-\S+/g, ""), GERMAN, panel);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await ctx.close();
    // Chris (de-CH, Desktop): Übersicht + Filter «Manuelle Prüfung».
    const { ctx: c, page: cp, errors: cErrors } = await openCrm(browser, srv, { viewport: { width: 1440, height: 900 } });
    await cp.waitForFunction(() => document.getElementById("crmOnbBtn"));
    await cp.click("#crmOnbBtn");
    await cp.waitForFunction(() => document.querySelectorAll("#crmOnboarding .crm-onb").length === 2);
    for (const w of ["Onboarding offen", "Wartet auf Kunde", "Wartet auf Zugang", "Wartet auf Bestätigung", "Manuelle Prüfung", "Bereit zur Ausführung", "Zahlungsschwelle", "Erfüllt", "Link gesendet", "Inhaltsänderungen"])
      assert.ok((await cp.evaluate(() => document.getElementById("crmOnboarding").textContent)).includes(w), w);
    await cp.click('#crmOnboarding [data-filter="manual_review"]');
    await cp.waitForFunction(() => document.querySelectorAll("#crmOnboarding .crm-onb").length === 1 && /RF480-20261016-bbbbbb/.test(document.getElementById("crmOnboarding").innerText));
    const html = await cp.evaluate(() => document.getElementById("crmOnboarding").innerHTML);
    assert.ok(!/access\.html|#t=|@/.test(html), "keine Links/Token/Kunden-E-Mail im DOM");
    await c.close();
  } finally { await browser.close(); srv.close(); }
});
