// TF-065 Browser-Test (echter Chromium): Kudoshin sieht «TRỢ LÝ GỌI ĐIỆN» komplett auf Vietnamesisch (ohne CH-Daten, START gesperrt ohne LiveKit/SIP),
// Lead-Detail mit vietnamesischer Anruf-Sektion; Giuliano sieht den Bereich nicht. Keine externen Requests, keine Anrufe.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startServer, exe, loginAs } from "./crm-browser-harness.js";
import { vnLeads, PW } from "./tf063-helpers.js";

const GERMAN = /\b(und|der|die|das|nicht|Anruf|Rückruf|Fehler|Aufnahme|Kampagne|Warteschlange|Parallelität|Vorschau|Starten|STOPP|Schweiz|eingerichtet|Erreicht|Keine)\b/i;
const CH_ONLY = /CHF|SIP CH\b/;

test("TF-065 Kudoshin: Trợ lý gọi điện 100 % Vietnamesisch, START gesperrt; Giuliano ohne Calling-Bereich", { skip: !exe && "kein Chromium/Chrome/Edge gefunden", timeout: 180_000 }, async () => {
  const srv = await startServer({ n: 30, vnLeads: vnLeads(6), sellers: { Kudoshin: PW.Kudoshin, giuliano: PW.giuliano } });
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await loginAs(ctx, srv, "Kudoshin", PW.Kudoshin);
    const page = await ctx.newPage();
    const errors = [], external = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/*", (r) => { const u = r.request().url(); if (!u.startsWith(srv.url)) { external.push(u); return r.abort(); } return r.continue(); });
    page.on("dialog", (d) => d.dismiss());
    await page.goto(srv.url + "/sales.html");
    await page.waitForFunction(() => !document.getElementById("aCalling").hidden && /TRỢ LÝ GỌI ĐIỆN/.test(document.getElementById("aCalling").innerText));
    const text = await page.evaluate(() => document.getElementById("aCalling").innerText + "\n" + [...document.querySelectorAll("#aCalling option")].map((o) => o.textContent).join("\n"));
    const bad = text.split("\n").filter((l) => GERMAN.test(l));
    assert.deepEqual(bad, [], "deutsche Reste:\n" + bad.join("\n"));
    for (const w of ["Cuộc gọi đang hoạt động", "Hàng đợi", "Đã gọi hôm nay", "Đã kết nối", "Không trả lời", "Quan tâm", "Gọi lại", "Không gọi lại", "Lỗi", "Gọi một số", "Gọi lần lượt", "Gọi song song", "LiveKit/SIP chưa được cấu hình"]) assert.ok(text.includes(w), w);
    assert.ok(!/Thụy Sĩ/.test(text) && !CH_ONLY.test(text), "kein CH-Markt / keine CH-Daten");
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#aCalling button")].find((b) => b.textContent === "BẮT ĐẦU").disabled), true, "START gesperrt");
    // Lead-Detail: vietnamesische Anruf-Sektion
    await page.click("#crmBtn");
    await page.waitForFunction(() => document.querySelectorAll("#crmMain [data-id]").length > 0);
    await page.click("#crmMain [data-id]");
    await page.waitForFunction(() => /Trợ lý gọi điện/.test(document.getElementById("crmDrawer").textContent) && /Số lần gọi/.test(document.getElementById("crmDrawer").textContent), null, { timeout: 8000 }).catch(async (e) => { console.log("DRAWER:", (await page.evaluate(() => document.getElementById("crmDrawer").textContent)).slice(-700), "ERR", errors); throw e; });
    const dr = await page.evaluate(() => document.getElementById("crmDrawer").textContent);
    const sec = dr.slice(dr.indexOf("Trợ lý gọi điện"), dr.indexOf("Không ghi âm") + 13);
    assert.doesNotMatch(sec, GERMAN, sec);
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await ctx.close();
    // Giuliano: Bereich unsichtbar, API 403
    const g = await browser.newContext();
    await loginAs(g, srv, "giuliano", PW.giuliano);
    const gp = await g.newPage();
    await gp.goto(srv.url + "/sales.html");
    await gp.waitForFunction(() => !document.getElementById("app").hidden);
    assert.equal(await gp.evaluate(() => document.getElementById("aCalling").hidden), true);
    assert.equal((await g.request.get(srv.url + "/api/calling")).status(), 403);
    await g.close();
  } finally { await browser.close(); srv.close(); }
});
