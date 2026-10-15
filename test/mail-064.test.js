// TF-064 Tests – Mail (33 A–J): CH-Entwurf unverändert, Lap-/VN-Entwurf mit vietnamesischer Signatur + Abmeldezeile, nie Versand,
// Empfänger nur aus dem eigenen VN-Lead, Metadaten serverseitig. Gmail, Cloud und Leads sind Attrappen – kein Netz, keine echte Mail.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, workerIteration, createStore, finalizeCommercial, finalizeForProfile, UNSUB_LINE } from "../mail-worker.js";
import * as mailRequests from "../mail-requests.js";
import { createMailRequestHandler, cloudSendGuard, createMailQueue } from "../mail-requests.js";
import { memoryStore } from "../shared-state.js";
import { actorFor } from "../auth-core.js";
import { senderProfileFor, VN_SIGNATURE, VN_PROFILE } from "../sender-profiles.js";

const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-windows-token", JARVIS_MAIL_WORKER_TOKEN: "vps-worker-token" };
const NIGHT = new Date("2026-10-15T20:00:00Z");
const CH_SENDER = { name: "Chris", email: "chris@helvetic.test", signature: "Freundliche Grüsse\nChris\nHelvetic Webdesign\nchris@helvetic.test" };
const LEADS = { "vn-a.vn": { lead_id: "vn-a.vn", market: "VN", email: "lienhe@vn-a.vn", company: "Công ty A" }, "vn-b.vn": { lead_id: "vn-b.vn", market: "VN", email: "lienhe@vn-b.vn" },
  "ch-firma.ch": { lead_id: "ch-firma.ch", market: "CH", email: "info@ch-firma.ch" } };
const SCOPE = { lap: ["vn-a.vn"], chris: ["vn-a.vn", "vn-b.vn", "ch-firma.ch"], mario: ["ch-firma.ch"] };
const VN_BODY = "Kính gửi anh/chị,\n\nChúng tôi thấy trên website của anh/chị có một liên kết dẫn tới trang lỗi.\n\nTrân trọng,\nLap";
let clock, blob, handler, dir, g;
function fakeGmail() {
  const f = { reg: { labelId: "L", drafts: {}, sent: {} }, calls: [], n: 0, listOwned: () => structuredClone(f.reg),
    async readThread() { throw new Error("nicht von Jarvis"); },
    async createDraft({ to, subject, body, mode }) { f.calls.push("create " + to); const id = "dr" + ++f.n; f.reg.drafts[id] = { threadId: "t" + id, to, subject, body, mode, createdAt: clock.toISOString() }; return { draftId: id, threadId: "t" + id }; },
    async replyToThread() { throw new Error("kein Thread"); }, async updateDraft() { return {}; }, async markDraftForReview() {},
    async sendDraft(id) { f.calls.push("SEND " + id); throw new Error("Lab: Senden verboten"); } };
  return f;
}
const req = (method, body, headers = {}) => new Request("https://jarvis.test/api/mail-requests", { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const as = (u) => ({ "x-test-user": u });
const viaHandler = (h) => async (url, opts = {}) => h(new Request(url, opts));
const vpsConfig = { token: ENV.JARVIS_MAIL_WORKER_TOKEN, workerToken: ENV.JARVIS_MAIL_WORKER_TOKEN, url: "https://jarvis.test/api/state" };
const iterate = () => workerIteration({ role: "vps", store: createStore(dir), config: vpsConfig, mailRequests, fetchFn: viaHandler(handler), startedAt: clock.toISOString(),
  worker: createWorker({ dir, gmail: g, now: () => clock, log: () => {}, escalate: async () => {}, aiPaused: async () => {}, compose: async () => ({ decision: "skip" }),
    sendGuard: cloudSendGuard({ config: vpsConfig, fetchFn: viaHandler(handler) }) }) });
const draftTo = (to) => Object.values(g.reg.drafts).find((d) => d.to === to);

beforeEach(() => {
  clock = NIGHT; blob = memoryStore(); g = fakeGmail();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-064-mail-"));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ dryRun: false, sendMode: "compliant_auto", sender: CH_SENDER }));
  handler = createMailRequestHandler({ getStore: async () => blob, env: (k) => ENV[k], now: () => clock,
    resolveActor: async (r) => { const u = r.headers.get("x-test-user"); return u ? { actor: actorFor(u) } : { actor: null, status: 401 }; },
    resolveLead: async (actor, id) => (SCOPE[actor.user_id]?.includes(id) ? { lead: LEADS[id] } : { status: 403, code: "OUT_OF_SCOPE" }) });
});

test("TF-064 Mail A: CH-Entwurf (Owner) – bestehende deutsche Signatur und Abmeldezeile exakt unverändert", async () => {
  const r = await handler(req("POST", { op: "create", recipient: "info@ch-firma.ch", subject: "Ihre Website", body: "Grüezi Frau Muster\n\nkurz zu Ihrer Website.", delivery: "draft" }, as("chris")));
  assert.equal(r.status, 201);
  await iterate();
  const d = draftTo("info@ch-firma.ch");
  assert.equal(d.body, finalizeCommercial("Grüezi Frau Muster\n\nkurz zu Ihrer Website.", CH_SENDER, "de"));
  assert.ok(d.body.endsWith(`${CH_SENDER.signature}\n\n${UNSUB_LINE.de}`));
  assert.ok(!d.body.includes("Trân trọng") && !d.body.includes("Hủy đăng ký"));
  assert.equal(senderProfileFor(null, CH_SENDER).sender, CH_SENDER, "CH-Profil = cfg.sender (unverändert)");
});

test("TF-064 Mail B–H, J: Lap-VN-Entwurf – exakt vietnamesische Lap-Signatur + vi-Abmeldezeile, keine CH-Fusszeile, DRAFT_ONLY, Metadaten serverseitig", async () => {
  // J: Metadaten aus dem Browser werden abgelehnt; der Server setzt sie aus Session + Lead.
  assert.equal((await handler(req("POST", { op: "lead_draft", lead_id: "vn-a.vn", subject: "Website", body: VN_BODY, meta: { market: "CH" } }, as("lap")))).status, 400);
  const r = await handler(req("POST", { op: "lead_draft", lead_id: "vn-a.vn", subject: "Website của anh/chị", body: VN_BODY }, as("lap")));
  assert.equal(r.status, 201);
  const q = (await blob.get()).state.requests[0];
  assert.deepEqual(q.meta, { actor_user_id: "lap", market: "VN", locale: "vi-VN", lead_id: "vn-a.vn" });
  assert.deepEqual([q.recipient, q.delivery, q.requested_by], ["lienhe@vn-a.vn", "draft", "lap"]);
  await iterate();
  const d = draftTo("lienhe@vn-a.vn");
  assert.ok(d, "Entwurf angelegt (Lab-Gmail)");
  // B: exakt die vietnamesische Signatur (genau einmal, keine doppelte Grussformel).
  assert.ok(d.body.includes(VN_SIGNATURE));
  assert.equal(d.body.split("Trân trọng,").length - 1, 1);
  assert.equal(VN_SIGNATURE, "Trân trọng,\nLap\nHỗ trợ khách hàng Việt Nam\nHelvetic Webdesign\nhttps://lapvietnamese.netlify.app/");
  // C/D: vietnamesische Abmeldezeile in einer Zeile, keine deutsche.
  assert.ok(d.body.endsWith("\n\nNếu anh/chị không muốn nhận thêm email từ chúng tôi, chỉ cần trả lời “Hủy đăng ký”."));
  assert.ok(!d.body.includes(UNSUB_LINE.de) && !/Abmelden|abmelden/.test(d.body));
  // E: keine Schweizer Signatur.
  assert.ok(!d.body.includes(CH_SENDER.signature) && !/Freundliche Grüsse|chris@/i.test(d.body));
  // F: keine erfundenen Register-/Adress-/Telefonwerte im VN-Profil.
  assert.ok(!/\+?\d[\d ]{7,}|MST|mã số thuế|Strasse|Straße|Đường|Quận|GPKD|đăng ký kinh doanh/i.test(VN_SIGNATURE + JSON.stringify(VN_PROFILE)));
  // G/H: nur Entwurf (COLD_LEAD_DRAFT_ONLY), kein Send – auch im nächsten Lauf nicht.
  assert.equal(d.mode, "COLD_LEAD_DRAFT_ONLY");
  await iterate();
  assert.deepEqual(g.calls.filter((c) => c.startsWith("SEND")), []);
  assert.equal(g.calls.filter((c) => c.startsWith("create")).length, 1);
  assert.equal((await blob.get()).state.requests[0].status, "drafted");
  // Unsub-Erkennung vi: bereits vorhandene vietnamesische Abmeldezeile wird nicht doppelt angehängt.
  const twice = finalizeForProfile(`${VN_BODY}\n\nNếu không muốn nhận thêm email, xin trả lời "huỷ đăng ký".`, senderProfileFor({ actor_user_id: "lap", market: "VN", locale: "vi-VN", lead_id: "vn-a.vn" }));
  assert.ok(!twice.includes(UNSUB_LINE.vi));
  assert.ok(!finalizeForProfile("Xin chào", senderProfileFor({ market: "VN", actor_user_id: "chris", locale: "vi-VN", lead_id: "vn-b.vn" })).includes("Freundliche"), "market VN → VN-Profil auch für Chris");
  // DE/EN/FR/IT unverändert.
  for (const [l, w] of [["de", "Abmelden"], ["en", "unsubscribe"], ["fr", "désinscrire"], ["it", "disiscrivi"]]) assert.ok(UNSUB_LINE[l].includes(w));
});

test("TF-064 Mail G (Versand): Verkäufer-/VN-Auftrag mit delivery send wird nie gesendet – auch nicht mit vorhandener Adresse", async () => {
  const queue = createMailQueue(blob, { now: () => clock, dedicated: true });
  const r = await queue.create({ recipient: "lienhe@vn-a.vn", subject: "x", body: "y", delivery: "send" }, "lap", { actor_user_id: "lap", market: "VN", locale: "vi-VN", lead_id: "vn-a.vn" });
  assert.equal(r.status, 201);
  await iterate();
  assert.deepEqual(g.calls, [], "kein Entwurf, kein Send");
  assert.match((await blob.get()).state.requests[0].reason, /nur Entwurf/);
});

test("TF-064 Mail I: Lap löst nur den eigenen VN-Lead als Empfänger aus (fremder/CH-Lead 403, freier Empfänger 400)", async () => {
  assert.equal((await handler(req("POST", { op: "lead_draft", lead_id: "vn-b.vn", subject: "s", body: "b" }, as("lap")))).status, 403);
  assert.equal((await handler(req("POST", { op: "lead_draft", lead_id: "ch-firma.ch", subject: "s", body: "b" }, as("lap")))).status, 403);
  assert.equal((await handler(req("POST", { op: "lead_draft", lead_id: "vn-a.vn", recipient: "x@evil.vn", subject: "s", body: "b" }, as("lap")))).status, 400);
  assert.equal((await handler(req("POST", { op: "create", recipient: "x@evil.vn", subject: "s", body: "b", delivery: "draft" }, as("lap")))).status, 403);
  assert.equal((await handler(req("POST", { op: "lead_draft", lead_id: "ch-firma.ch", subject: "s", body: "b" }, as("mario")))).status, 403, "CH-Lead über den VN-Weg nie");
  assert.equal((await blob.get()).state, null, "nichts in der Warteschlange");
});
