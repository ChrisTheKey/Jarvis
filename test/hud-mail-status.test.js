// HUD: Mail-Worker-Status aus der Cloud (send_authority + Heartbeat), unabhängig vom UI-Modus LOCAL/CLOUD.
// „Alle Systeme sind online“ nur, wenn Kern und zuständiger Mail-Worker wirklich laufen. Keine echten Mails, kein Netzwerk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createMailRequestHandler, fetchMailService } from "../mail-requests.js";
import { memoryStore } from "../shared-state.js";

const ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-test-token", JARVIS_MAIL_WORKER_TOKEN: "worker-test-token" };
const URL_STATE = "https://jarvis.test/api/state";
const req = (method, body, headers = {}) => new Request("https://jarvis.test/api/mail-requests", { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

function mailStatus() {
  const ctx = {};
  vm.runInNewContext(read("public/mail-status.js"), ctx);
  return ctx.JarvisMailStatus;
}
const { summarizeMail, allSystemsOnline } = mailStatus();
const VPS_UP = { online: true, authority: "vps", pending: 0 };

test("VPS active → HUD Worker ONLINE, Mail Service VPS, Mail Worker VPS ACTIVE", () => {
  const m = summarizeMail({ service: VPS_UP });
  assert.equal(m.worker, "ONLINE");
  assert.equal(m.mailService, "VPS");
  assert.equal(m.mailWorker, "VPS ACTIVE");
  assert.equal(m.healthy, true);
});

test("VPS authority → HUD Send Authority VPS, Pending Queue als Zahl", () => {
  const m = summarizeMail({ service: { ...VPS_UP, pending: 3 } });
  assert.equal(m.authority, "VPS");
  assert.equal(m.pending, 3);
  assert.equal(summarizeMail({ service: { online: true, authority: "local", pending: 0 } }).authority, "WINDOWS");
});

test("Windows standby wird nicht als aktiver Worker angezeigt", () => {
  const m = summarizeMail({ service: VPS_UP, localWorker: { alive: true, standby: true } });
  assert.equal(m.windows, "STANDBY");
  assert.equal(m.mailWorker, "VPS ACTIVE", "aktiv ist der VPS, nicht Windows");
  assert.doesNotMatch(m.mailWorker, /WINDOWS/);
  // Auch ein lebender Windows-Prozess ist ohne Authority nie ACTIVE.
  assert.equal(summarizeMail({ service: { ...VPS_UP, online: false }, localWorker: { alive: true, standby: false } }).windows, "STANDBY");
  // Windows ACTIVE nur mit eigener Authority und frischem Heartbeat.
  assert.equal(summarizeMail({ service: { online: true, authority: "local", pending: 0 }, localWorker: { alive: true, standby: false } }).windows, "ACTIVE");
});

test("kein aktiver Worker → OFFLINE (bzw. STANDBY, wenn nur Windows im Standby läuft); Cloud unbekannt → UNBEKANNT", () => {
  const down = summarizeMail({ service: { online: false, authority: "vps", pending: 2 } });
  assert.deepEqual([down.worker, down.mailService, down.mailWorker, down.healthy], ["OFFLINE", "OFFLINE", "OFFLINE", false]);
  assert.equal(down.authority, "VPS", "Authority bleibt sichtbar, auch wenn der Worker ausgefallen ist");
  const standbyOnly = summarizeMail({ service: { online: false, authority: "vps", pending: 0 }, localWorker: { alive: true, standby: true } });
  assert.deepEqual([standbyOnly.worker, standbyOnly.mailWorker, standbyOnly.healthy], ["OFFLINE", "STANDBY", false]);
  const winDead = summarizeMail({ service: { online: false, authority: "vps", pending: 0 }, localWorker: { alive: false, standby: true } });
  assert.equal(winDead.windows, "OFFLINE");
  const unknown = summarizeMail({ service: null });
  assert.deepEqual([unknown.worker, unknown.authority, unknown.pending, unknown.healthy], ["UNBEKANNT", "UNBEKANNT", null, false]);
  assert.equal(summarizeMail({ service: { online: true, authority: "???", pending: 0 } }).authority, "KEINE");
  assert.equal(summarizeMail({ service: { online: true, authority: "???", pending: 0 } }).healthy, false);
});

test("„Alle Systeme sind online“ nur bei tatsächlich gesundem Zustand", () => {
  assert.equal(allSystemsOnline({ core: true, mail: summarizeMail({ service: VPS_UP }) }), true);
  assert.equal(allSystemsOnline({ core: true, mail: summarizeMail({ service: { ...VPS_UP, online: false } }) }), false, "Worker offline");
  assert.equal(allSystemsOnline({ core: true, mail: summarizeMail({ service: null }) }), false, "Cloud unbekannt");
  assert.equal(allSystemsOnline({ core: true, mail: null }), false, "Status nicht geladen");
  assert.equal(allSystemsOnline({ core: false, mail: summarizeMail({ service: VPS_UP }) }), false, "Kern fehlt");
  const html = read("public/index.html");
  // Der Satz steht nur noch im allOnline-Zweig; das Boot-Protokoll ebenso.
  assert.match(html, /allOnline \? "Alle Systeme sind online\." :/);
  assert.match(html, /allOnline \? "> Alle Systeme online\." :/);
  assert.equal(html.match(/Alle Systeme sind online/g).length, 1);
  assert.match(html, /JarvisMailStatus\.allSystemsOnline\(\{ core: mode === "cloud" \|\| !!status\.claude, mail: mailHud \}\)/);
});

test("LOCAL-UI-Modus + VPS-Mail-Worker gleichzeitig: Worker kommt aus der Cloud, nicht aus dem Windows-Zyklus", async () => {
  const html = read("public/index.html");
  assert.match(html, /<script src="mail-status.js"><\/script>/);
  assert.match(html, /if \(mode === "local"\) \{ shared = await \(await fetch\(CORE \+ "\/api\/shared"\)\)\.json\(\); loadMailService\(\); \}/);
  assert.match(html, /fetch\(CORE \+ "\/api\/mail-service"/);
  assert.doesNotMatch(html, /\$\("kWorker"\)\.textContent = w \?/, "kWorker hängt nicht mehr am Windows-lastCycle");
  for (const id of ["kWorker", "kMailService", "kMailWorker", "kAuthority", "kWinWorker", "kMailPending"]) assert.match(html, new RegExp(`id="${id}"`));
  const server = read("server.js");
  assert.match(server, /url\.pathname === "\/api\/mail-service"/);
  assert.match(server, /"\/mail-status\.js"\]\.includes\(url\.pathname\)/);
  // Local Core (Windows, Sync-Token) liest Cloud-Status: VPS hat Authority und frischen Heartbeat.
  const blob = memoryStore(), now = new Date("2026-10-07T17:00:00Z");
  const handler = createMailRequestHandler({ getStore: async () => blob, env: (k) => ENV[k], now: () => now });
  const hb = await handler(req("POST", { op: "heartbeat", stats: { sent_today: 0 } }, { "x-jarvis-worker": ENV.JARVIS_MAIL_WORKER_TOKEN }));
  assert.equal(hb.status, 200);
  await handler(req("POST", { op: "create", recipient: "anna@laden.ch", subject: "Test", body: "Hallo" }, { "x-jarvis-key": ENV.JARVIS_PASSWORD }));
  const calls = [];
  const fetchFn = async (url, opts = {}) => { calls.push(opts.method || "GET"); return handler(new Request(url, opts)); };
  const r = await fetchMailService({ config: { token: ENV.JARVIS_SYNC_TOKEN, workerToken: "", url: URL_STATE }, fetchFn });
  assert.deepEqual(calls, ["GET"], "nur lesend – kein claim, kein Lease");
  assert.deepEqual(r.authority, { dedicated: true, holder: "vps", self: false });
  assert.deepEqual([r.service.online, r.service.authority, r.service.pending], [true, "vps", 1]);
  assert.ok(!/anna@|worker-test-token|sync-test-token|pw-test/.test(JSON.stringify(r.service)), "Service-Status ohne Adressen/Tokens");
  const m = summarizeMail({ service: r.service, localWorker: { alive: true, standby: r.authority.self === false } });
  assert.deepEqual([m.worker, m.mailService, m.mailWorker, m.authority, m.windows, m.pending], ["ONLINE", "VPS", "VPS ACTIVE", "VPS", "STANDBY", 1]);
  // Cloud nicht erreichbar → null, kein Wurf.
  const down = await fetchMailService({ config: { token: "x", workerToken: "", url: URL_STATE }, fetchFn: async () => { throw new Error("offline"); } });
  assert.deepEqual([down.ok, down.service, down.authority], [false, null, null]);
});
