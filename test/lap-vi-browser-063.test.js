// TF-063 Browser-Test (echter Chromium): Kudoshin meldet sich an und sieht die komplette Oberfläche auf Vietnamesisch – Login, Übersicht,
// Provision, CRM-Liste (Mobile + Desktop), Lead-Detail, Filter. Keine deutschen UI-Reste, keine Schweizer Leads, keine externen Requests.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startServer, exe, loginAs } from "./crm-browser-harness.js";
import { vnLeads, PW } from "./tf063-helpers.js";

const GERMAN = /\b(und|der|die|das|nicht|Firma|Kontaktstatus|Telefon|Fehler|Anruf|Notiz|Keine|Suche|Branche|Kanton|Entwurf|Provision|Ausstehend|Auszahlbar|Storniert|Abmelden|Anmelden|Passwort|Benutzername|Sprache|Speichern|Zurücksetzen|SCHLIESSEN|Archiv|gesendet|geprüft|Wichtigste|Ansprechpartner|Nächster|Sortierung|Übersicht|Verwaltung|Notizen|Kunde|Neu|Leads?)\b/i;

test("TF-063 Kudoshin (vi-VN) im Browser: Login, App, CRM, Detail – 100 % Vietnamesisch, nur VN-Leads", { skip: !exe && "kein Chromium/Chrome/Edge gefunden", timeout: 240_000 }, async () => {
  const srv = await startServer({ n: 40, vnLeads: vnLeads(12), sellers: { Kudoshin: PW.Kudoshin } });
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    // Login-Seite: Sprache Tiếng Việt (gemerkte Anzeigesprache) – auch die Anmeldemaske ist vietnamesisch.
    const c0 = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c0.addInitScript(() => localStorage.setItem("jarvis.locale", "vi-VN"));
    const p0 = await c0.newPage();
    await p0.goto(srv.url + "/login.html");
    await p0.waitForFunction(() => document.getElementById("lSubmit").textContent === "Đăng nhập");
    const loginText = await p0.evaluate(() => [...document.querySelectorAll(".panel label span, #lSubmit, #lHint, #lTitle")].map((x) => x.textContent).join(" | "));
    assert.doesNotMatch(loginText, GERMAN, loginText);
    // Echte Anmeldung über das Formular → Weiterleitung in die Verkäufer-App.
    await p0.fill("#user", "Kudoshin"); await p0.fill("#pass", PW.Kudoshin); await p0.click("#lSubmit");
    await p0.waitForURL(/\/sales\.html/);
    assert.equal(await p0.evaluate(() => localStorage.getItem("jarvis.cloudKey")), null, "kein Passwort im Browser-Speicher");
    await c0.close();

    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const ctx = await browser.newContext({ viewport });
      await loginAs(ctx, srv, "Kudoshin", PW.Kudoshin);
      const page = await ctx.newPage();
      const errors = [], external = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.route("**/*", (r) => { const u = r.request().url(); if (!u.startsWith(srv.url)) { external.push(u); return r.abort(); } return r.continue(); });
      await page.goto(srv.url + "/sales.html");
      await page.waitForFunction(() => !document.getElementById("app").hidden && document.getElementById("aComStats").childElementCount > 0);
      assert.equal(await page.evaluate(() => document.documentElement.lang), "vi");
      const appText = await page.evaluate(() => document.getElementById("app").innerText);
      assert.doesNotMatch(appText, GERMAN, appText);
      assert.match(appText, /Hoa hồng/i); assert.match(appText, /Nhân viên kinh doanh Việt Nam/i);
      // CRM
      await page.click("#crmBtn");
      await page.waitForFunction(() => document.querySelectorAll("#crmMain [data-id]").length > 0);
      const ids = await page.evaluate(() => [...document.querySelectorAll("#crmMain [data-id]")].map((x) => x.dataset.id));
      assert.equal(ids.length, 12, "genau die 12 VN-Leads");
      assert.ok(ids.every((id) => id.endsWith(".vn")), "keine Schweizer Leads");
      await page.click("#crmMain [data-id]");
      await page.waitForFunction(() => !document.getElementById("crmDrawer").hidden);
      const crmText = await page.evaluate(() => document.getElementById("crm").innerText + "\n" + document.getElementById("crmDrawer").innerText
        + "\n" + [...document.querySelectorAll("#crm select option")].map((o) => o.textContent).join("\n"));
      const bad = crmText.split("\n").filter((l) => GERMAN.test(l));
      assert.deepEqual(bad, [], "deutsche Reste:\n" + bad.join("\n"));
      assert.match(crmText, /Khách hàng tiềm năng|Khách sạn/);
      assert.ok(!/\.ch\b/.test(crmText), "keine CH-Domain sichtbar");
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
      await ctx.close();
    }
  } finally { await browser.close(); srv.close(); }
});
