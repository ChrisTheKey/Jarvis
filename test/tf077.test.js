// TF-077 Teil A (angepasst durch TF-077B) – Mail-Aktionen im CRM je Benutzer. Serverseitig (/api/crm, /api/mail-requests) und im echten Chromium:
//   Chris: kein allgemeiner E-Mail-Knopf oben, eigener Gmail-Entwurf je Lead + mailto bleiben.
//   Giuliano/Mario/Damiano: weder «E-Mail öffnen» noch «Gmail-Entwurf öffnen», keine Gmail-URL in API/DOM (TF-077B: einzige Aktion «E-Mail lossenden», tf077b.test.js).
//   Kudoshin: nie eine Gmail-URL (weder von Chris noch ein Verfassen-Link); Mailbox hathanhlap261096@gmail.com, KUDOSHIN_MAILBOX_NOT_CONNECTED (kein Fallback).
import test from "node:test";
import assert from "node:assert/strict";
import { setup, makeReq, PW, vnLeads } from "./tf063-helpers.js";
import { startServer, exe, loginAs } from "./crm-browser-harness.js";
import { mailAccessFor, leadForMail, SELLER_MAILBOXES } from "../mail-access.js";
import { actorFor } from "../auth-core.js";

const KUDOSHIN_MAILBOX = "hathanhlap261096@gmail.com";
const CHRIS_DRAFT = "https://mail.google.com/mail/u/0/#drafts?compose=0123456789abcdef";
const SELLERS = ["giuliano", "mario", "damiano", "Kudoshin"];

test("TF-077 Mail-Policy je Benutzer (mail-access.js)", () => {
  const m = Object.fromEntries(["chris", ...SELLERS].map((u) => [u, mailAccessFor(actorFor(u))]));
  assert.deepEqual([m.chris.mode, m.chris.gmail_drafts, m.chris.mailto, m.chris.draft_requests], ["OWNER_GMAIL", true, true, true]);
  for (const u of ["giuliano", "mario", "damiano"]) assert.deepEqual([m[u].mode, m[u].gmail_drafts, m[u].mailto, m[u].draft_requests, m[u].send_prepared, m[u].mailbox], ["SERVER_SEND", false, false, false, true, null], u);
  assert.deepEqual([m.Kudoshin.mode, m.Kudoshin.mailbox, m.Kudoshin.state, m.Kudoshin.gmail_drafts, m.Kudoshin.draft_requests, m.Kudoshin.send_prepared, "compose" in m.Kudoshin],
    ["OWN_MAILBOX", KUDOSHIN_MAILBOX, "KUDOSHIN_MAILBOX_NOT_CONNECTED", false, false, false, false]);
  assert.ok(m.Kudoshin.connect_path && !/token=|secret|passwor[dt]\s*[:=]/i.test(m.Kudoshin.connect_path));
  assert.deepEqual(SELLER_MAILBOXES, { Kudoshin: KUDOSHIN_MAILBOX }, "nur Kudoshin hat eine eigene Mailbox");
  assert.equal(mailAccessFor(null).mode, "MAIL_ACTIONS_DISABLED", "ohne Akteur nichts");
  // Lead-Sicht: ohne Gmail-Recht nie eine Entwurfs-URL.
  assert.equal(leadForMail({ lead_id: "a.ch", draft_url: CHRIS_DRAFT }, m.chris).draft_url, CHRIS_DRAFT);
  for (const u of SELLERS) assert.equal(leadForMail({ lead_id: "a.ch", draft_url: CHRIS_DRAFT }, m[u]).draft_url, null, u);
});

test("TF-077 /api/crm: keine Gmail-URL von Chris an Verkäufer (Liste, Detail, Auftragsergebnis), Mail-Policy in der Antwort", async () => {
  const t = await setup({ vn: 10 });
  // Jeder Lead (CH + VN) trägt im Speicher eine Gmail-Entwurfs-URL von Chris.
  for (const s of [t.stores.view, t.stores.vnView]) { const { state, etag } = await s.get(); state.leads.forEach((l) => { l.draft_url = CHRIS_DRAFT; }); await s.set(state, etag); }
  const get = async (u, q = "") => t.json(await t.crm(makeReq("/api/crm" + q, { cookie: t.cookies[u] })));
  const chris = await get("chris");
  assert.equal(chris.body.mail.mode, "OWNER_GMAIL");
  assert.ok(chris.body.leads.some((l) => l.draft_url === CHRIS_DRAFT), "Chris behält seine Gmail-Entwürfe");
  for (const u of SELLERS) {
    const r = await get(u);
    assert.equal(r.status, 200);
    assert.ok(r.body.leads.length > 0, `${u} sieht Leads`);
    assert.ok(!JSON.stringify(r.body).includes("mail.google.com"), `${u}: keine Gmail-URL in der API`);
    assert.equal(r.body.mail.mode, u === "Kudoshin" ? "OWN_MAILBOX" : "SERVER_SEND");
    if (u === "Kudoshin") assert.deepEqual([r.body.mail.mailbox, r.body.mail.state], [KUDOSHIN_MAILBOX, "KUDOSHIN_MAILBOX_NOT_CONNECTED"]);
    const id = r.body.leads[0].lead_id;
    const one = await t.json(await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies[u], body: { action: "crm.getLead", params: { lead_id: id } } })));
    assert.equal(one.status, 200); assert.equal(one.body.lead.draft_url, null, `${u} getLead`);
    const all = await t.json(await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies[u], body: { action: "crm.listLeads", params: {} } })));
    assert.ok(!JSON.stringify(all.body).includes("mail.google.com"), `${u} listLeads`);
    // Schreibauftrag → Ergebnis-Abfrage liefert den Lead ebenfalls ohne Gmail-URL.
    const w = await t.json(await t.crm(makeReq("/api/crm", { method: "POST", cookie: t.cookies[u], body: { action: "crm.addNote", params: { lead_id: id, text: "Notiz" } } })));
    assert.equal(w.status, 202, `${u} Notiz (CRM-Notizen bleiben)`);
    const q = (u === "Kudoshin" ? t.stores.vnQueue : t.stores.queue);
    const { state, etag } = await q.get(); const x = state.requests.find((y) => y.request_id === w.body.request.request_id); x.status = "done"; await q.set(state, etag);
    const res = await t.json(await t.crm(makeReq(`/api/crm?request=${w.body.request.request_id}`, { cookie: t.cookies[u] })));
    assert.equal(res.status, 200); assert.ok(res.body.lead && res.body.lead.draft_url === null, `${u} Auftragsergebnis`);
  }
  // CSV-Export enthält keine Entwurfs-URL (für niemanden).
  const csv = await (await t.crm(makeReq("/api/crm?export=csv", { cookie: t.cookies.giuliano }))).text();
  assert.ok(!csv.includes("mail.google.com"));
});

test("TF-077 /api/mail-requests: Entwurfsaufträge (frei formuliert) nur für Chris – Kudoshin NOT_CONNECTED (kein Fallback), Giuliano/Mario/Damiano gesperrt", async () => {
  const t = await setup({ ch: 60, vn: 10 });
  const vn = (await t.json(await t.crm(makeReq("/api/crm", { cookie: t.cookies.Kudoshin })))).body.leads.find((l) => l.email && !l.do_not_contact);
  const post = async (u, body) => t.json(await t.mail(makeReq("/api/mail-requests", { method: "POST", cookie: t.cookies[u], body })));
  const k = await post("Kudoshin", { op: "lead_draft", lead_id: vn.lead_id, subject: "Chào anh/chị", body: "Nội dung" });
  assert.deepEqual([k.status, k.body.code, k.body.mailbox], [403, "KUDOSHIN_MAILBOX_NOT_CONNECTED", KUDOSHIN_MAILBOX]);
  assert.ok(!JSON.stringify(k.body).includes("mail.google.com"));
  for (const u of ["giuliano", "mario", "damiano"]) {
    const r = await post(u, { op: "lead_draft", lead_id: vn.lead_id, subject: "s", body: "b" });
    assert.equal(r.status, 403, u); assert.equal(r.body.code, "FORBIDDEN", u);
    assert.equal((await post(u, { op: "create", recipient: "x@y.ch", subject: "s", body: "b", delivery: "draft" })).status, 403, `${u} create`);
  }
  assert.ok(!(t.stores.mail.peek()?.requests || []).length, "nichts in Chris' Gmail-Warteschlange");
  const c = await post("chris", { op: "lead_draft", lead_id: vn.lead_id, subject: "Chào anh/chị", body: "Nội dung" });
  assert.equal(c.status, 201, "Chris behält VN-Entwürfe (eigenes Gmail)");
});

// ---------- Browser (echter Chromium) ----------
const hrefs = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((a) => a.getAttribute("href")), sel);
const texts = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((a) => a.textContent.trim()), sel);
async function sellerPage(browser, srv, user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await loginAs(ctx, srv, user, PW[user]);
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (r) => (r.request().url().startsWith(srv.url) ? r.continue() : r.abort()));
  await page.goto(srv.url + "/sales.html");
  await page.waitForFunction(() => !document.getElementById("app").hidden);
  await page.click("#crmBtn");
  await page.waitForFunction(() => document.querySelectorAll("#crmMain [data-id]").length > 0, null, { timeout: 90_000 });
  return { ctx, page, errors };
}

test("TF-077 Browser: Chris ohne allgemeinen E-Mail-Knopf, mit eigenem Gmail-Entwurf; Verkäufer ohne Gmail-/Öffnen-Knöpfe; Kudoshin ohne jeden Gmail-Link",
  { skip: !exe && "kein Chrome/Edge/Chromium gefunden", timeout: 300_000 }, async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: exe, headless: true });
    const srv = await startServer({ n: 40, vnLeads: vnLeads(6).map((l) => ({ ...l, draft_url: CHRIS_DRAFT })), sellers: { giuliano: PW.giuliano, mario: PW.mario, damiano: PW.damiano, Kudoshin: PW.Kudoshin } });
    try {
      // Chris (Owner-HUD): Lead mit Gmail-Entwurf öffnen.
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await loginAs(ctx, srv);
      const page = await ctx.newPage();
      await page.route("**/*", (r) => (r.request().url().startsWith(srv.url) ? r.continue() : r.abort()));
      await page.goto(srv.url + "/#crm");
      await page.evaluate(() => { document.getElementById("boot").hidden = true; });
      await page.waitForSelector('#crmMain tr a[href*="#drafts?compose="]', { timeout: 90_000 });
      const withDraft = await page.evaluate(() => document.querySelector('#crmMain tr a[href*="#drafts?compose="]')?.closest("tr").dataset.id);
      assert.ok(withDraft, "Chris sieht Gmail-Entwürfe in der Liste");
      await page.click(`#crmMain tr[data-id="${withDraft}"]`);
      await page.waitForFunction(() => !document.getElementById("crmDrawer").hidden);
      const qa = await page.evaluate(() => [...document.querySelector("#crmDrawer .crm-qa").querySelectorAll("a")].map((a) => a.textContent.trim()));
      assert.ok(qa.includes("GMAIL-ENTWURF ÖFFNEN"), qa.join("|"));
      assert.ok(!qa.includes("E-MAIL ÖFFNEN"), "kein allgemeiner E-Mail-Knopf oben");
      assert.equal(await page.locator("#crmDrawer a", { hasText: "E-MAIL ÖFFNEN" }).count(), 0);
      assert.ok((await hrefs(page, "#crmDrawer .kv a[href^='mailto:']")).length === 1, "Chris: E-Mail-Adresse des Leads bleibt als mailto");
      await ctx.close();

      // Mario/Damiano haben im Browser-Harness kein Portfolio (keine 2×200-Verteilung) – gleicher UI-Pfad wie Giuliano (MAIL_ACTIONS_DISABLED), API-Test oben deckt alle vier ab.
      for (const u of ["giuliano", "Kudoshin"]) {
        const { ctx: c, page: p, errors } = await sellerPage(browser, srv, u);
        await p.click("#crmMain [data-id]");
        await p.waitForFunction(() => !document.getElementById("crmDrawer").hidden);
        const all = await hrefs(p, "#crm a[href], #crmDrawer a[href]");
        assert.ok(!all.some((h) => h.includes("#drafts")), `${u}: kein Gmail-Entwurf`);
        assert.equal((await p.content()).includes("#drafts?compose="), false, `${u}: keine Entwurfs-URL im DOM`);
        const labels = await texts(p, "#crmDrawer a, #crmDrawer button, #crm a");
        for (const bad of ["E-MAIL ÖFFNEN", "GMAIL-ENTWURF ÖFFNEN", "ENTWURF ÖFFNEN", "MỞ EMAIL", "MỞ BẢN NHÁP GMAIL", "MỞ BẢN NHÁP"]) assert.ok(!labels.includes(bad), `${u}: ${bad}`);
        assert.ok(!all.some((h) => h.startsWith("mailto:") || h.includes("mail.google.com")), `${u}: keine Mail-Links (auch kein Verfassen-Link)`);
        if (u === "Kudoshin") {
          assert.ok(await p.locator('#crmDrawer .crm-mailbox[data-state="KUDOSHIN_MAILBOX_NOT_CONNECTED"]').count() >= 1, "NOT_CONNECTED sichtbar");
          assert.match(await p.locator("#crmDrawer").innerText(), /hathanhlap261096@gmail\.com/);
          assert.equal(await p.locator("#crmDrawer .crm-send").count(), 0, "Kudoshin: kein Versand über Chris' Postfach");
        }
        assert.deepEqual(errors, []);
        await c.close();
      }
    } finally { await browser.close(); srv.close(); }
  });
