// TF-064 Tests – vietnamesische Kundentexte für VN-Aufträge (34): Zugangs-Anfrage, Host-Key, Check-Bericht/Liefermail,
// Reparatur-Abschlussbericht, manuelle Punkte; sicherer Zugangslink/Formular auf Vietnamesisch. Kein CHF, keine deutschen Sätze.
// CH-Texte bleiben unverändert. Nur Temp-Stores, keine Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { createRepairOrder, buildAccessRequestMail, buildHostKeyConfirmationMail, buildCustomerReport, buildRepairDeliveryMail, reportUnsafe } from "../repair-workflow.js";
import { createCheck150Order, buildCheck150Findings, buildCheck150Report, buildDeliveryDraft } from "../check-150-workflow.js";
import { accessLink } from "../access-intake.js";
import { createAccessIntakeHandler, memoryIntakeStore, consentText, hostKeyConfirmText } from "../access-intake-api.js";
import { accessKeys } from "../access-intake.js";

const T0 = new Date("2026-10-15T09:00:00Z");
const HOME = "https://nha-hang.vn/";
let store, dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-064-tx-")); store = createStore(dir); });
const vnFix = () => createRepairOrder(store, { domain: "nha-hang.vn", website: HOME, company: "Nhà hàng Phố Cổ", delivery_email: "lienhe@nha-hang.vn", offer_class: "VN_REPAIR_FIX", now: T0 });
const chFix = () => createRepairOrder(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "a@muster.ch", now: T0 });
// Deutsche Funktionswörter/typische Sätze der CH-Texte – dürfen in VN-Kundentexten nie vorkommen.
const GERMAN = /\b(Hallo|Freundliche|Grüsse|Sie|Ihre|Ihrer|Ihrem|bitte|Bitte|und|der|die|das|nicht|Zugang|Reparatur|Auftrag|Bericht|Webseiten|Prüfung|behoben|geprüft)\b/;
const assertVn = (text, label) => {
  assert.ok(!/CHF|Franken/.test(text), `${label}: kein CHF`);
  assert.ok(!GERMAN.test(text), `${label}: keine deutschen Sätze (${(text.match(GERMAN) || [])[0]})`);
  assert.ok(/[ạảãàáâậầấẩẫăặằắẳẵệềếểễọỏõòóôộồốổỗơợờớởỡụủũùúưựừứửữịỉĩìíỵỷỹỳýđ]/i.test(text), `${label}: vietnamesisch`);
};

test("TF-064 VN Access Request + Host-Key: vollständig Vietnamesisch, Link mit &l=vi, Domain/URL unübersetzt; CH unverändert", () => {
  const o = vnFix();
  const link = accessLink("https://jarvis.test", "A".repeat(43), "vi-VN");
  assert.equal(link, `https://jarvis.test/access.html#t=${"A".repeat(43)}&l=vi`);
  assert.equal(accessLink("https://jarvis.test", "A".repeat(43)), `https://jarvis.test/access.html#t=${"A".repeat(43)}`, "CH-Link unverändert");
  const a = buildAccessRequestMail(o, { link, expires_at: "2026-10-18T09:00:00Z" });
  assert.equal(a.subject, "Sửa lỗi website nha-hang.vn – cần quyền truy cập an toàn");
  assert.equal(a.message_class, "CUSTOMER_ACCESS_REQUEST");
  assert.ok(a.body.includes(link) && a.body.includes("nha-hang.vn") && a.body.includes("Kính gửi Nhà hàng Phố Cổ,"));
  assert.ok(a.body.includes("KHÔNG gửi mật khẩu qua email"));
  assertVn(a.body.replace(link, ""), "Zugangs-Anfrage");
  const h = buildHostKeyConfirmationMail(o, { link, expires_at: "2026-10-18T09:00:00Z" });
  assert.equal(h.subject, "Sửa lỗi website nha-hang.vn – xác nhận bảo mật ngắn");
  assertVn(h.body.replace(link, ""), "Host-Key");
  // CH bleibt exakt Deutsch.
  const c = buildAccessRequestMail(chFix(), { link: "https://jarvis.test/access.html#t=x" });
  assert.ok(c.body.startsWith("Hallo Muster AG") && c.body.includes("Freundliche Grüsse\nChris\nHelvetic Webdesign"));
});

test("TF-064 VN Repair Completion + Manual Items: Bericht/Liefermail Vietnamesisch, Bericht ohne URL/IDs (reportUnsafe ok)", () => {
  const o = vnFix();
  Object.assign(o, {
    issues: { I1: { issue_id: "I1", type: "broken_link", page: HOME, label: "Thực đơn", url: "https://nha-hang.vn/menu-cu", severity: "medium", repair_status: "repaired", customer_text: "Auf der Startseite führt …" },
      I2: { issue_id: "I2", type: "contact_form_broken", page: HOME, url: HOME, severity: "high", repair_status: "needs_review", customer_text: "Das Kontaktformular …" } },
    retest: { tested_at: "2026-10-16T10:00:00Z", http_ok: true, desktop: { ok: true, method: "browser" }, mobile: { ok: true, method: "browser" } },
    browser_gate: { required: true, desktop: "JA", mobile: "JA", regression: "KEINE", navigation: "JA" }, deployment: { deployed: true }, plan: [{ issue_id: "I1" }], access_intake: { status: "RECEIVED" },
  });
  const rep = buildCustomerReport(o, { now: T0 });
  assert.equal(rep.subject, "Kiểm tra website nha-hang.vn – Báo cáo hoàn tất");
  for (const s of ["Báo cáo hoàn tất «Kiểm tra & sửa lỗi website» (3.900.000 ₫)", "Đã khắc phục:", "«Thực đơn»", "– đã khắc phục và kiểm tra lại.",
    "Các lỗi có thể sửa tự động đã được khắc phục. Một số mục khác cần được kiểm tra thủ công.", "Chưa sửa tự động – cần trao đổi thêm", "Biểu mẫu liên hệ hiện không gửi được",
    "Đã kiểm tra trên máy tính: Có", "Đã kiểm tra trên điện thoại: Có", "Quan trọng: Vui lòng xóa ngay quyền truy cập tạm thời"]) assert.ok(rep.body.includes(s), s);
  assertVn(rep.body, "Abschlussbericht");
  assert.equal(reportUnsafe(rep.body, o), null, "keine URL/Interna im Bericht");
  o.report = rep;
  const m = buildRepairDeliveryMail(o);
  assert.equal(m.message_class, "CUSTOMER_ORDER_FULFILLMENT");
  assert.ok(m.body.includes("Một số mục khác cần được kiểm tra thủ công – chi tiết trong báo cáo hoàn tất:"), "manuelle Punkte klar benannt");
  assert.ok(m.body.endsWith("Trân trọng,\nLap\nHỗ trợ khách hàng Việt Nam\nHelvetic Webdesign\nhttps://lapvietnamese.netlify.app/"));
  assertVn(m.body.replace("https://lapvietnamese.netlify.app/", ""), "Liefermail");
  assert.ok(reportUnsafe(`${rep.body}\n${o.order_id}`, o), "VNFIX-ID im Bericht wäre gesperrt");
});

test("TF-064 VN Check Delivery: Befunde/Anleitung/Bericht/Liefermail Vietnamesisch; CH-Check unverändert", () => {
  const issues = { a: { type: "broken_image", url: "https://nha-hang.vn/img/a.jpg", page: HOME, severity: "medium", evidence: "x", detectedAt: T0.toISOString() },
    b: { type: "https_certificate", url: HOME, page: HOME, severity: "high", evidence: "TLS", detectedAt: T0.toISOString() } };
  const o = createCheck150Order(store, { domain: "nha-hang.vn", website: HOME, company: "Nhà hàng Phố Cổ", delivery_email: "lienhe@nha-hang.vn", offer_class: "VN_REPAIR_CHECK", now: T0 });
  o.findings = buildCheck150Findings(issues, { stackType: "wordpress", vn: true });
  assert.equal(o.findings.length, 2);
  assert.ok(o.findings.every((f) => f.steps.length && f.verification_steps.length && ["Dễ", "Trung bình", "Nên nhờ chuyên gia"].includes(f.difficulty)));
  const built = buildCheck150Report(o, { now: T0 });
  assert.equal(built.report.title, "Kiểm tra website & hướng dẫn sửa lỗi");
  assert.ok(built.text.includes("Nếu anh/chị không muốn tự sửa") && built.text.includes("3.900.000 ₫"), "Hinweis auf VN FIX in VND");
  assertVn(built.text, "Check-Bericht");
  const d = buildDeliveryDraft(o, built.text);
  assertVn(d.body.replace("https://lapvietnamese.netlify.app/", ""), "Check-Liefermail");
  // CH unverändert Deutsch mit CHF 480.
  const ch = createCheck150Order(store, { domain: "muster.ch", website: "https://muster.ch/", company: "Muster AG", delivery_email: "a@muster.ch", now: T0 });
  ch.findings = buildCheck150Findings({ b: { ...issues.b, url: "https://muster.ch/", page: "https://muster.ch/" } }, { stackType: "other" });
  const chText = buildCheck150Report(ch, { now: T0 }).text;
  assert.ok(chText.startsWith("Webseiten-Check & Anleitung") && chText.includes("CHF 480"));
  assert.ok(buildDeliveryDraft(ch, chText).body.includes("Freundliche Grüsse\nChris\nHelvetic Webdesign"));
});

test("TF-064 Sicherer Zugang VN: Registrierung VNFIX nur mit vi-VN, Formulartexte/Freigabe vietnamesisch; CH-Info ohne locale", async () => {
  const blobs = memoryIntakeStore();
  const WT = "w".repeat(48);
  const h = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined), now: () => T0 });
  const call = async (body, worker = false) => { const r = await h(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json", ...(worker ? { "x-jarvis-worker": WT } : {}) }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  const { publicKeyPem } = accessKeys(dir);
  const tok = "B".repeat(43), hash = (await import("node:crypto")).createHash("sha256").update(tok).digest("hex");
  const reg = { op: "register", order_id: "VNFIX-20261015-abcdef", domain: "nha-hang.vn", token_hash: hash, expires_at: "2026-10-18T09:00:00Z", public_key: publicKeyPem };
  assert.equal((await call(reg, true)).status, 400, "VNFIX ohne vi-VN abgelehnt");
  assert.equal((await call({ ...reg, order_id: "RF480-20261015-abcdef", locale: "vi-VN" }, true)).status, 400, "CH-Auftrag nie vi-VN");
  assert.equal((await call({ ...reg, locale: "vi-VN" }, true)).status, 200);
  const info = await call({ op: "info", token: tok });
  assert.equal(info.body.locale, "vi-VN");
  assert.equal(info.body.consent_text, consentText("nha-hang.vn", "vi-VN"));
  assertVn(info.body.consent_text + " " + info.body.scope, "Freigabetext");
  assert.ok(hostKeyConfirmText("nha-hang.vn", "vi-VN").includes("nha-hang.vn"));
  const html = fs.readFileSync(new URL("../public/access.html", import.meta.url), "utf8"), js = fs.readFileSync(new URL("../public/access.js", import.meta.url), "utf8");
  for (const k of ["h1", "lead", "noteH", "lblType", "lblDom", "send", "hkYes", "hkNo"]) assert.ok(html.includes(`data-t="${k}"`) && js.includes(`${k}:`), k);
  assert.ok(js.includes('hash.get("l") === "vi"') && js.includes("Quyền truy cập website an toàn"));
});
