// TF-068 Browser-Test (echter Chromium): Kudoshin – Trợ lý gọi điện weiterhin 100 % Vietnamesisch inkl. Rechtsprüfung/Stimme/Lịch gọi lại und
// «Đơn hàng của tôi»; Chris – CALLING AGENT nur Überwachung (kein STARTEN, NOTSTOPP vorhanden) und Bereich «VERKÄUFE & PROVISIONEN».
// Keine externen Requests, keine Anrufe, keine Zahlungen.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startServer, exe, loginAs } from "./crm-browser-harness.js";
import { vnLeads, PW } from "./tf063-helpers.js";

const GERMAN = /\b(und|der|die|das|nicht|Anruf|Rückruf|Fehler|Aufnahme|Kampagne|Warteschlange|Parallelität|Vorschau|Starten|STOPP|Schweiz|eingerichtet|Erreicht|Keine|Rechtsprüfung|Stimme|Kosten)\b/i;

test("TF-068 Kudoshin vi-VN + Chris Überwachung/Notstopp + VERKÄUFE & PROVISIONEN", { skip: !exe && "kein Chromium/Chrome/Edge gefunden", timeout: 180_000 }, async () => {
  const srv = await startServer({ n: 30, vnLeads: vnLeads(6), sellers: { Kudoshin: PW.Kudoshin } });
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    // ---- Kudoshin ----
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await loginAs(ctx, srv, "Kudoshin", PW.Kudoshin);
    const page = await ctx.newPage();
    const errors = [], external = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.route("**/*", (r) => { const u = r.request().url(); if (!u.startsWith(srv.url)) { external.push(u); return r.abort(); } return r.continue(); });
    page.on("dialog", (d) => d.dismiss());
    await page.goto(srv.url + "/sales.html");
    await page.waitForFunction(() => /Lịch gọi lại/.test(document.getElementById("aCalling").innerText) && !document.getElementById("aSales").hidden);
    const text = await page.evaluate(() => [document.getElementById("aCalling").innerText, document.getElementById("aSales").textContent, document.getElementById("aComStats").textContent].join("\n"));
    const bad = text.split("\n").filter((l) => GERMAN.test(l));
    assert.deepEqual(bad, [], "deutsche Reste:\n" + bad.join("\n"));
    for (const w of ["Kiểm tra pháp lý", "Giọng nam tiếng Việt", "CHƯA XÁC MINH", "Lịch gọi lại", "Đơn hàng của tôi", "Đã chi trả", "Chi phí hôm nay"]) assert.ok(text.includes(w), w);
    assert.ok(!/CHF|Thụy Sĩ|NOTSTOPP/.test(text), "keine CH-Daten, kein Owner-Notstopp");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await ctx.close();
    // ---- Chris ----
    const oc = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await loginAs(oc, srv);
    const op = await oc.newPage();
    const oerr = [];
    op.on("pageerror", (e) => oerr.push(String(e)));
    await op.route("**/*", (r) => (r.request().url().startsWith(srv.url) ? r.continue() : r.abort()));
    op.on("dialog", (d) => d.dismiss());
    await op.goto(srv.url + "/");
    await op.waitForFunction(() => !!document.getElementById("callingBtn"));
    await op.evaluate(() => document.getElementById("callingBtn").click()); // Nav-Leiste je nach Modus eingeklappt
    await op.waitForFunction(() => /CALLING AGENT/.test(document.getElementById("callingAgent").innerText) && /NOTSTOPP/.test(document.getElementById("callingAgent").innerText));
    const ct = await op.evaluate(() => ({ text: document.getElementById("callingAgent").innerText, buttons: [...document.querySelectorAll("#callingAgent button")].map((b) => b.textContent) }));
    assert.ok(!ct.buttons.includes("STARTEN"), "Chris startet keine Kampagnen");
    assert.ok(ct.buttons.includes("NOTSTOPP") && ct.buttons.includes("VORSCHAU"));
    assert.match(ct.text, /nur Überwachung/); assert.match(ct.text, /BLOCKED_PENDING_LEGAL_REVIEW/); assert.match(ct.text, /VOICE_NOT_VERIFIED/);
    await op.keyboard.press("Escape");
    await op.evaluate(() => document.getElementById("accessBtn").click());
    await op.waitForFunction(() => /VERKÄUFE & PROVISIONEN/.test(document.getElementById("ownerAdmin").innerText) && /AUSZAHLUNG ERFASSEN/.test(document.getElementById("ownerAdmin").innerText), null, { timeout: 15_000 });
    const ot = await op.evaluate(() => document.getElementById("ownerAdmin").textContent);
    for (const w of ["Prov. ausstehend", "Prov. fällig", "Prov. storniert", "Prov. ausbezahlt", "Umsatz", "keine automatische Auszahlung"]) assert.ok(ot.includes(w), w);
    assert.deepEqual(oerr, []);
    await oc.close();
  } finally { await browser.close(); srv.close(); }
});
