// TF-071 – HOSTING / CMS DETECTION BEFORE SECURE ACCESS. Hermetisch: keine echten DNS-/HTTP-Anfragen (Fake-Resolver/-Fetch bzw.
// fester Befund), keine echte Mail (Fake-Gmail mit Threads), keine echte Website (Lab-Adapter), Access-Intake-Handler in-memory.
// Abgedeckt: §2/§3/§12 Erkennung + Konfidenz (WordPress, WooCommerce, Shopify, Wix, Webflow, Netlify, Vercel, Plesk, DNS, unbekannt,
// schwache Signale nie HIGH), §5 Antwort-Parser, §6 Zugangs-Engine, §7 adaptives Formular, §13 Onboarding (erkannt/unbekannt/CHECK/VN),
// §9 Passwort per Mail, §10 ACCESS_VALIDATION_FAILED, §11 CRM-Sicht, §14 Sicherheit (CRM, Verkäufer, Cross-Customer, Ablauf, Wiederverwendung).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../mail-worker.js";
import { recordPayment } from "../payments.js";
import { REPAIR_ORDERS_FILE, createConfirmedRepairOrder, createRepairOrder, runRepairOrders, buildAccessRequestMail, buildHostingQuestionMail, completionGate } from "../repair-workflow.js";
import { CHECK150_ORDERS_FILE, createCheck150Order, runCheck150Orders } from "../check-150-workflow.js";
import { recordDirectSale } from "../sales.js";
import { createAccessIntakeHandler, memoryIntakeStore, tokenHash } from "../access-intake-api.js";
import { intakeClient, sealEnvelope, accessKeys } from "../access-intake.js";
import { gateDecision } from "../repair-browser-validator.js";
import { processRepairOutbox } from "../repair-outbox.js";
import { repairServiceIteration } from "../repair-service.js";
import * as C from "../onboarding-core.js";
import { createOnboarding, loadOnboarding, attachOnboarding } from "../onboarding-dialogue.js";
import { readOrdersExport } from "../onboarding-store.js";
import { cleanRepair } from "../server-control.js";
import { platformRows, onboardingTexts } from "../public/onboarding-ui.js";
import { setup as salesSetup, makeReq } from "./tf063-helpers.js";
import { detectPlatform, parsePlatformAnswer, resolvePlatform, accessRequirement, cleanStated, cleanPlatform, ACCESS_FORMS, HOSTING_QUESTION_DE, HOSTING_NO_PW_DE,
  HOSTING_QUESTION_VI, HOSTING_NO_PW_VI } from "../hosting-detect.js";
import { probeDomain, createPlatformDetector, isPrivateIp } from "../hosting-probe.js";

const T0 = new Date("2026-10-16T08:00:00Z");
const H = 3600_000;
const DOMAIN = "hosting-kunde.test", SITE = `https://${DOMAIN}/`, EMAIL = "auftrag@hosting-kunde.test";
const VN_DOMAIN = "quan-ca-phe.vn", VN_SITE = `https://${VN_DOMAIN}/`, VN_EMAIL = "lienhe@quan-ca-phe.vn";
const GOOD = "Tf71-Gut-Secret-4d2a", BAD = "Tf71-Falsch-Secret-9b1c";
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf071-")); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const GERMAN = /\b(Hallo|Guten|Freundliche|Grüsse|Sie|Ihre|Ihrer|Ihrem|bitte|Bitte|und|der|die|das|nicht|Zugang|Reparatur|Auftrag|Bericht|Webseiten|Prüfung|behoben|geprüft|Passwort|Link)\b/;
const assertVn = (text, label) => {
  assert.ok(!/CHF|Franken/.test(text), `${label}: kein CHF`);
  assert.ok(!GERMAN.test(text), `${label}: kein deutscher Rest (${(text.match(GERMAN) || [])[0]})`);
  assert.ok(/[ạảãàáâậầấẩẫăặằắẳẵệềếểễọỏõòóôộồốổỗơợờớởỡụủũùúưựừứửữịỉĩìíỵỷỹỳýđ]/i.test(text), `${label}: vietnamesisch`);
};
// Nie: Aufforderung, Benutzername/Passwort per E-Mail zu senden.
const ASKS_PASSWORD_BY_MAIL = /(senden|schicken|mailen|teilen) Sie (mir|uns) (bitte )?(Ihr(en)?|das|den) (Passwort|Benutzernamen|Zugangsdaten|Login)|(?<!không )gửi (mật khẩu|tên đăng nhập) (cho chúng tôi )?qua email/i;

// ---------- öffentliche Signale (Fixtures) ----------
const SIG = {
  wordpress: { headers: { link: '<https://k.test/wp-json/>; rel="https://api.w.org/"' }, html: '<html><head><meta name="generator" content="WordPress 6.6"><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head><body>Hi</body></html>', ns: ["ns1.hostpoint.ch", "ns2.hostpoint.ch"] },
  woocommerce: { html: '<html><head><meta name="generator" content="WordPress 6.6"></head><body class="woocommerce-no-js"><script src="/wp-content/plugins/woocommerce/assets/js/x.js"></script></body></html>' },
  shopify: { headers: { "x-shopid": "123", "powered-by": "Shopify" }, html: '<html><script src="https://cdn.shopify.com/s/files/x.js"></script></html>', a: ["23.227.38.65"] },
  wix: { headers: { "x-wix-request-id": "abc", server: "Pepyaka" }, html: '<html><meta name="generator" content="Wix.com Website Builder"><img src="https://static.wixstatic.com/media/x.jpg"></html>' },
  webflow: { html: '<html data-wf-site="5f" data-wf-page="6a"><meta content="Webflow" name="generator"><link href="https://cdn.prod.website-files.com/x.css"></html>', cname: ["proxy-ssl.webflow.com"] },
  netlify: { headers: { "x-nf-request-id": "01J", server: "Netlify" }, html: "<html><body>Static</body></html>", cname: ["kunde.netlify.app"] },
  vercel: { headers: { "x-vercel-id": "fra1::abc", "x-vercel-cache": "HIT", server: "Vercel" }, html: '<html><script id="__NEXT_DATA__">{}</script></html>', a: ["76.76.21.21"] },
  unknown: { headers: { server: "Apache" }, html: "<html><body><h1>Kunde AG</h1><p>Willkommen</p></body></html>" },
};

test("TF-071 §12 Erkennung: WordPress/WooCommerce/Shopify/Wix/Webflow/Netlify/Vercel → HIGH + minimaler Zugangsweg; unbekannt → kein Zugangsweg", () => {
  const exp = { wordpress: ["WORDPRESS", null, "WORDPRESS_ADMIN", "wordpress_cms"], woocommerce: ["WOOCOMMERCE", null, "WORDPRESS_ADMIN", "wordpress_cms"],
    shopify: ["SHOPIFY", null, "SHOPIFY_STAFF", "other"], wix: ["WIX", null, "WIX_COLLABORATOR", "other"], webflow: ["WEBFLOW", null, "WEBFLOW_COLLABORATOR", "other"],
    netlify: [null, "NETLIFY", "NETLIFY_TEAM", "github_netlify"], vercel: [null, "VERCEL", "VERCEL_TEAM", "github_netlify"] };
  for (const [k, [cms, dep, kind, conn]] of Object.entries(exp)) {
    const d = detectPlatform(SIG[k]);
    if (cms) { assert.equal(d.cms_platform, cms, k); assert.equal(d.cms_confidence, "HIGH", `${k} cms HIGH`); }
    if (dep) { assert.equal(d.deployment_platform, dep, k); assert.equal(d.deployment_confidence, "HIGH", `${k} deploy HIGH`); }
    assert.deepEqual([d.access_type, d.connector_type, d.confidence], [kind, conn, "HIGH"], k);
  }
  // Hosting: Baukasten/Deployment hostet selbst; WordPress: Hoster nur schwach über NS → nicht behauptet als sicher.
  assert.equal(detectPlatform(SIG.shopify).hosting_provider, "SHOPIFY");
  assert.equal(detectPlatform(SIG.netlify).hosting_provider, "NETLIFY");
  const wp = detectPlatform(SIG.wordpress);
  assert.deepEqual([wp.dns_provider, wp.dns_confidence, wp.hosting_provider, wp.hosting_confidence], ["HOSTPOINT", "HIGH", "HOSTPOINT", "LOW"], "NS = DNS sicher, Hosting nur LOW");
  const u = detectPlatform(SIG.unknown);
  assert.equal(u.access_type, null, "unbekannt → kein Zugangsweg");
  assert.ok(["LOW", "UNKNOWN"].includes(u.confidence));
  assert.deepEqual([detectPlatform({}).confidence, detectPlatform({}).access_type, detectPlatform({}).hosting_provider], ["UNKNOWN", null, null], "nichts → UNKNOWN, nie erfunden");
});

test("TF-071 §3/§12 schwache Signale nie HIGH: Wort im Text, NS allein, einzelner generator, Konkurrenz, Plesk neben WordPress, DNS/PTR", () => {
  const weak = detectPlatform({ html: "<html><body>Powered by WordPress. Wir lieben WordPress, wordpress, WORDPRESS und WordPress.</body></html>" });
  assert.deepEqual([weak.cms_platform, weak.cms_confidence, weak.access_type], ["WORDPRESS", "LOW", null], "nur Textnennung → LOW");
  const nsOnly = detectPlatform({ ns: ["ns1.infomaniak.ch"] });
  assert.deepEqual([nsOnly.hosting_confidence, nsOnly.access_type], ["LOW", null], "NS beim Hoster ≠ sicheres Hosting");
  const gen = detectPlatform({ html: '<meta name="generator" content="WordPress 6.5">' });
  assert.deepEqual([gen.cms_confidence, gen.access_type], ["MEDIUM", null], "ein starkes Signal → MEDIUM, nicht automatisch");
  const mixed = detectPlatform({ html: '<meta name="generator" content="WordPress"><script src="https://cdn.shopify.com/x.js"></script>' });
  assert.notEqual(mixed.cms_confidence, "HIGH", "zwei konkurrierende Plattformen → nie HIGH");
  assert.equal(mixed.access_type, null);
  const plesk = detectPlatform({ ...SIG.wordpress, headers: { ...SIG.wordpress.headers, "x-powered-by": "PleskLin" } });
  assert.deepEqual([plesk.panel, plesk.panel_confidence, plesk.access_type], ["PLESK", "HIGH", "WORDPRESS_ADMIN"], "WordPress-Admin vor Plesk");
  assert.equal(detectPlatform({ headers: { "x-powered-by": "PleskLin" }, html: "<html></html>" }).access_type, "PLESK");
  const dns = detectPlatform({ ns: ["ivy.ns.cloudflare.com", "bob.ns.cloudflare.com"], ptr: ["web123.cyon.ch"], headers: { "cf-ray": "x" } });
  assert.deepEqual([dns.dns_provider, dns.dns_confidence, dns.hosting_provider, dns.hosting_confidence, dns.cdn_provider], ["CLOUDFLARE", "HIGH", "CYON", "MEDIUM", "CLOUDFLARE"]);
  // accessRequirement: MEDIUM reicht nur mit Kundenangabe (min MEDIUM), automatisch nie.
  assert.equal(accessRequirement({ cms_platform: "WORDPRESS", cms_confidence: "MEDIUM" }), null);
  assert.equal(accessRequirement({ cms_platform: "WORDPRESS", cms_confidence: "MEDIUM" }, { min: "MEDIUM" }).access_type, "WORDPRESS_ADMIN");
});

test("TF-071 §2 Probe: nur öffentliche Signale, private Ziele nie angefragt, Weiterleitungen nur innerhalb der Domain, Fehler → nicht erkannt", async () => {
  const calls = [];
  const resolver = (a) => ({ resolve4: async () => a, resolve6: async () => [], resolveNs: async () => ["ns1.hostpoint.ch"], resolveCname: async () => [], reverse: async () => ["srv.hostpoint.ch"] });
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.endsWith("/cpanel")) return new Response(null, { status: 302, headers: { location: "https://srv.hostpoint.ch:2083/" } });
    if (url === `https://${DOMAIN}/`) return new Response(null, { status: 301, headers: { location: `https://www.${DOMAIN}/` } });
    return new Response(SIG.wordpress.html, { status: 200, headers: { "content-type": "text/html", "set-cookie": "sid=geheim", ...SIG.wordpress.headers } });
  };
  const s = await probeDomain(DOMAIN, { resolver: resolver(["203.0.113.10"]), fetchFn });
  assert.deepEqual(s.redirects, [`www.${DOMAIN}`]);
  assert.ok(!JSON.stringify(s.headers).includes("geheim"), "Set-Cookie nie übernommen");
  assert.equal(s.cpanel_location, "srv.hostpoint.ch:2083");
  const d = detectPlatform(s);
  assert.deepEqual([d.cms_platform, d.access_type, d.panel, d.hosting_provider], ["WORDPRESS", "WORDPRESS_ADMIN", "CPANEL", "HOSTPOINT"]);
  assert.equal((await createPlatformDetector({ resolver: resolver(["203.0.113.10"]), fetchFn })({ domain: DOMAIN })).access_type, "WORDPRESS_ADMIN");
  // Private/lokale Ziele → keine HTTP-Anfrage.
  calls.length = 0;
  const priv = await probeDomain(DOMAIN, { resolver: resolver(["127.0.0.1"]), fetchFn });
  assert.deepEqual([calls.length, priv.http], [0, "skipped"]);
  for (const ip of ["10.0.0.1", "192.168.1.2", "172.20.0.1", "169.254.169.254", "::1", "fd00::1"]) assert.ok(isPrivateIp(ip), ip);
  // Fremde Weiterleitung wird nicht verfolgt.
  calls.length = 0;
  await probeDomain(DOMAIN, { resolver: resolver(["203.0.113.10"]), fetchFn: async (url) => { calls.push(url); return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }); } });
  assert.ok(!calls.some((u) => u.includes("evil.example")), "fremdes Ziel nie abgerufen");
  await assert.rejects(probeDomain("../etc", { resolver: resolver([]), fetchFn }), /ungültig/);
});

test("TF-071 §5/§6 Kundenantwort parsen + minimaler Zugangsweg (nur feste Wörter, nie Zugangsdaten)", () => {
  const cases = [
    ["WordPress bei Hostpoint", "WORDPRESS", "HOSTPOINT", "WORDPRESS_ADMIN"], ["Wix", "WIX", "WIX", "WIX_COLLABORATOR"], ["Shopify", "SHOPIFY", "SHOPIFY", "SHOPIFY_STAFF"],
    ["Webflow", "WEBFLOW", "WEBFLOW", "WEBFLOW_COLLABORATOR"], ["cPanel", null, null, "CPANEL"], ["Plesk", null, null, "PLESK"], ["Netlify", null, "NETLIFY", "NETLIFY_TEAM"],
    ["Vercel", null, "VERCEL", "VERCEL_TEAM"], ["FTP bei Infomaniak", null, "INFOMANIAK", "SFTP"], ["Unsere Website läuft bei cyon.", null, "CYON", "SFTP"],
    ["WordPress ở Mắt Bão", "WORDPRESS", "MATBAO", "WORDPRESS_ADMIN"], ["Chúng tôi dùng Shopify", "SHOPIFY", "SHOPIFY", "SHOPIFY_STAFF"],
  ];
  for (const [text, cms, host, kind] of cases) {
    const p = parsePlatformAnswer(text);
    assert.ok(p, text);
    assert.deepEqual([p.cms_platform, p.hosting_provider, p.platform_only], [cms, host, true], text);
    assert.equal(resolvePlatform({}, cleanStated(p)).access_type, kind, text);
  }
  assert.equal(parsePlatformAnswer("Ich weiss es leider nicht."), null);
  assert.equal(parsePlatformAnswer("Nein"), null);
  assert.equal(parsePlatformAnswer("WordPress bei Hostpoint. Bitte auf der Team-Seite Muller in Müller ändern und die Öffnungszeiten anpassen.").platform_only, false, "mehr als Plattform → normaler Dialog");
  // Kundenangabe «bei Hostpoint» + automatisch MEDIUM WordPress → WordPress-Admin (nicht SFTP).
  assert.equal(resolvePlatform({ cms_platform: "WORDPRESS", cms_confidence: "MEDIUM" }, cleanStated(parsePlatformAnswer("bei Hostpoint"))).access_type, "WORDPRESS_ADMIN");
  // Gespeichert wird nur die Allowlist – nie Kundentext.
  const st = cleanStated({ ...parsePlatformAnswer("WordPress bei Hostpoint"), note: "pw=geheim", cms_platform: "WORDPRESS" });
  assert.ok(!JSON.stringify(st).includes("geheim"));
  assert.deepEqual(cleanPlatform({ cms_platform: "EVIL", hosting_provider: "pw=123", access_type: "ROOT", confidence: "SURE" }),
    { hosting_provider: null, cms_platform: null, dns_provider: null, deployment_platform: null, panel: null, access_type: null, confidence: "UNKNOWN", detection_source: null });
  // Formfelder: delegierte Zugänge ohne Passwortfeld; WordPress mit Admin-Login/Benutzer/Passwort; SFTP mit Host/Port/Benutzer/Passwort.
  for (const k of ["SHOPIFY_STAFF", "WIX_COLLABORATOR", "WEBFLOW_COLLABORATOR", "NETLIFY_TEAM", "VERCEL_TEAM", "GITHUB_COLLABORATOR"]) assert.ok(!ACCESS_FORMS[k].fields.includes("secret"), k);
  assert.deepEqual(ACCESS_FORMS.WORDPRESS_ADMIN.fields, ["host", "user", "secret", "notes"]);
  for (const f of ["host", "port", "user", "secret"]) assert.ok(ACCESS_FORMS.SFTP.fields.includes(f));
  assert.ok(!ACCESS_FORMS.CPANEL.fields.includes("port") && !ACCESS_FORMS.PLESK.fields.includes("root"), "keine irrelevanten Felder");
});

// ---------- Welt: Repair-Service + Outbox + Mail-Worker-Onboarding (wie TF-066) ----------
function threadGmail(clock) {
  let n = 0;
  const reg = { drafts: {}, sent: {} }, threads = new Map(), log = [];
  const owned = (tid) => Object.values(reg.sent).some((s) => s.threadId === tid);
  const g = {
    reg, threads, log, listOwned: () => reg,
    async createDraft({ to, subject, body, messageClass, orderId = null, threadId = null, inReplyTo = "" }) {
      const id = `d${++n}`, tid = threadId || `t${n}`;
      reg.drafts[id] = { to, subject, threadId: tid, messageClass, orderId, body, inReplyTo, createdAt: new Date(clock()).toISOString() };
      return { draftId: id, threadId: tid };
    },
    async replyDraftInThread(threadId, { to, body, messageClass, orderId }) {
      if (!owned(threadId)) throw new Error("Thread nicht von Jarvis.");
      const first = Object.values(reg.sent).find((s) => s.threadId === threadId);
      return g.createDraft({ to, subject: `Re: ${first.subject}`, body, messageClass, orderId, threadId, inReplyTo: threads.get(threadId).at(-1).rfcMessageId });
    },
    async sendDraft(id) {
      const d = reg.drafts[id];
      const mid = `m${++n}`;
      if (!threads.has(d.threadId)) threads.set(d.threadId, []);
      threads.get(d.threadId).push({ messageId: mid, rfcMessageId: `<${mid}@jarvis.test>`, from: "Chris <chris@helvetic.test>", replyTo: "", to: d.to, subject: d.subject, body: d.body, sent: true, draft: false, internalDate: clock() });
      reg.sent[mid] = { messageId: mid, threadId: d.threadId, to: d.to, subject: d.subject, fromDraft: id, messageClass: d.messageClass, orderId: d.orderId, sentAt: new Date(clock()).toISOString() };
      delete reg.drafts[id];
      log.push({ threadId: d.threadId, to: d.to, messageClass: d.messageClass, subject: d.subject, body: d.body, inReplyTo: d.inReplyTo });
      return { messageId: mid, threadId: d.threadId };
    },
    async readThread(threadId) { if (!owned(threadId)) throw new Error("Thread nicht von Jarvis."); return { threadId, messages: threads.get(threadId).map((m) => ({ ...m })) }; },
    customer(threadId, { from, body }) {
      const mid = `c${++n}`;
      threads.get(threadId).push({ messageId: mid, rfcMessageId: `<${mid}@kunde.test>`, from, replyTo: "", to: "chris@helvetic.test", subject: "Re: Ihre Website", body, sent: false, draft: false, internalDate: clock() + 1000 });
      return mid;
    },
    sends: () => log,
  };
  return g;
}
const extractSpy = () => { const calls = []; const fn = async (task) => { calls.push(task); return { facts: [], clarifications: [], classes: ["OTHER"], sensitive_detected: false, customer_says_no_more_changes: false, confirmation: false, correction_requested: false, confidence: "low" }; }; fn.calls = calls; return fn; };
function vp(fixed) {
  return { load_ok: true, status: 200, final_same_domain: true, redirected_cross_domain: false, metrics: { scroll_width: 390, viewport_width: 390, doc_height: 1000, text_length: 400 },
    overflow: { horizontal: false, px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
    critical: { header: true, nav: true, main: true, footer: true, hero: true, cta: false, main_covered: false, body_visible: true },
    nav: { links_visible: 3, menu_toggle: true, menu_toggle_used: true, targets_checked: 3, targets_ok: 3, targets_failed: 0 },
    images: { visible: 3, broken: 0, broken_paths: [] }, console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 },
    network: { failed_same_site: 0, failed_cross_site: 0, entries: [] }, fingerprints: { header: "a", nav: "b", main: "c", footer: "d" },
    findings: [{ type: "broken_link", ok: fixed, present: !fixed, code: fixed ? null : "finding_unresolved" }] };
}
function labWorld(site) {
  const st = { linkFixed: false, checks: [], preflights: [], page: '<html><body><h1>Kunde AG</h1><a href="/team-alt">Team</a></body></html>' };
  const BROKEN = { type: "broken_link", url: `${site}team-alt`, page: site, label: "Team", evidence: "HTTP 404", severity: "medium", detectedAt: T0.toISOString(), reproducible: true };
  const secretOf = (ctx) => ctx?.credential?.()?.secret || null;
  const adapter = { direct_live: true,
    checkAccess: async (_o, ctx) => { st.checks.push(secretOf(ctx)); return secretOf(ctx) === GOOD ? { ok: true, connector: "lab", capabilities: ["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK"] } : { ok: false, reason: "auth_failed" }; },
    backup: async () => ({ production_ref: "p1", backup_ref: "local:object-backup", rollback_point: "per-object-original" }),
    locate: async () => ({ target: "index.html", cause: "Link 404", planned_change: "href ersetzen", risk: "niedrig", fix: { replacement: "/team.html" } }),
    applyFix: async () => { st.linkFixed = true; st.page = st.page.replace("/team-alt", "/team.html"); return { ok: true, change_ref: "lab:link" }; },
    validate: async () => ({ build_ok: true }), deployProduction: async () => ({ ok: true, deploy_ref: "live:lab" }), rollback: async () => ({ ok: true }) };
  const auditor = { audit: async (u) => ({ website: u, reachable: true, finalUrl: u, title: "Kunde AG", requests: 3, pages: { home: st.page }, issues: st.linkFixed ? [] : [BROKEN] }) };
  const browserValidator = { validate: async ({ url, phase, before_snapshot }) => {
    const out = { url, phase, desktop: vp(phase !== "baseline" && st.linkFixed), mobile: vp(phase !== "baseline" && st.linkFixed) };
    if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    return out;
  } };
  // Wie profile-builder: falsche Zugangsdaten → BLOCKED_NO_ACCESS auth_failed.
  const preflight = { run: async (_o, { accessCtx }) => { st.preflights.push(secretOf(accessCtx)); return secretOf(accessCtx) === GOOD
    ? { profile_status: "PROFILE_READY", reason: "lab_verified", profile: { interface: "lab", capabilities: ["READ_FILES", "WRITE_FILES"] } } : { profile_status: "BLOCKED_NO_ACCESS", reason: "auth_failed" }; } };
  return { st, adapter, auditor, browserValidator, preflight, router: { route: async () => ({ adapter: "static", label: "Lab" }) } };
}
const WT = "w".repeat(43);
function cloud(clock = () => new Date()) {
  const blobs = memoryIntakeStore();
  const handler = createAccessIntakeHandler({ getStore: async () => blobs, env: (k) => (k === "JARVIS_MAIL_WORKER_TOKEN" ? WT : undefined), now: clock });
  const call = async (body, headers = {}) => { const r = await handler(new Request("https://jarvis.test/api/access-intake", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  return { blobs, handler, call, client: intakeClient({ config: { url: "https://jarvis.test/api/state", workerToken: WT }, fetchFn: async (url, init) => handler(new Request(url, init)) }) };
}
const linkOf = (body) => body.match(/https:\/\/jarvis\.test\/access\.html#t=[A-Za-z0-9_%-]+(&l=vi)?/)?.[0] || null;
const tokenOf = (link) => decodeURIComponent(link.split("#t=")[1].split("&")[0]);

function world({ detect = "unknown", site = SITE } = {}) {
  const state = tmp(), ob = tmp(), mail = tmp();
  const store = createStore(state);
  let clock = +T0;
  const now = () => new Date(clock);
  const g = threadGmail(() => clock), c = cloud(), w = labWorld(site), notes = [], logs = [], extract = extractSpy();
  const detections = [];
  const platformDetector = async (order) => { detections.push(order.order_id); return detect ? detectPlatform(SIG[detect]) : null; };
  const onbDir = path.join(ob, "onboarding");
  const onb = createOnboarding({ dir: mail, onboardingDir: onbDir, gmail: g, extract, now, notify: async (x) => { notes.push(x); }, log: (...a) => logs.push(JSON.stringify(a)) });
  const runRepair = (opts) => runRepairOrders({ ...opts, adapters: { static: w.adapter }, router: w.router, preflight: w.preflight, browserValidator: w.browserValidator, auditor: w.auditor, platformDetector,
    log: (...a) => logs.push(JSON.stringify(a)) });
  const W = {
    state, ob, mail, store, g, c, w, notes, logs, extract, onb, onbDir, detections,
    advance: (ms) => { clock += ms; },
    repairTick: () => repairServiceIteration({ dir: state, outboxDir: ob, intake: c.client, runRepair, runCheck150: (o) => runCheck150Orders({ ...o, auditor: w.auditor }), onboarding: true }),
    mailTick: async () => { await processRepairOutbox({ dir: ob, gmail: g, onboarding: onb, now }); return onb.process(); },
    tick: async (k = 1) => { for (let i = 0; i < k; i++) { await W.repairTick(); await W.mailTick(); await W.repairTick(); } },
    rec: (id) => loadOnboarding(mail).records[id],
    order: (id) => store.read(REPAIR_ORDERS_FILE, { orders: {} }).orders[id],
    exp: (id) => readOrdersExport(onbDir).orders[id],
    reply: (id, body) => g.customer(W.rec(id).thread_id, { from: `Kunde <${W.rec(id).customer_email}>`, body }),
    lastSend: () => g.sends().at(-1),
    submit: async (link, { access_type, secret = GOOD, domain = DOMAIN }) => {
      const info = await c.call({ op: "info", token: tokenOf(link) });
      return c.call({ op: "submit", token: tokenOf(link), access_type, access_domain: domain, consent: true,
        envelope: sealEnvelope({ access_type, host: `${SITE}wp-admin`, username: "jarvis-temp", secret }, info.body.public_key) });
    },
    allFiles: () => [state, ob, mail].flatMap((d) => fs.readdirSync(d, { recursive: true }).map(String).map((f) => path.join(d, f)))
      .filter((f) => fs.statSync(f).isFile() && !/access_vault|access_intake_private/.test(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n"),
  };
  return W;
}
async function paidFix(W) {
  W.store.write("config.json", { business_profile: { address: { street: "Teststrasse 1", postal_code: "3000", city: "Bern", country: "CH" } } });
  const o = createConfirmedRepairOrder(W.store, { domain: DOMAIN, website: SITE, company: "Kunde AG", delivery_email: EMAIL, contact_name: "Frau Muster", now: T0 });
  recordPayment(W.store, { order_id: o.order_id, amount_chf: 240, reference: `TF71-${o.order_id}-deposit`, now: T0 });
  recordPayment(W.store, { order_id: o.order_id, amount_chf: 240, reference: `TF71-${o.order_id}-balance`, now: T0 });
  await W.tick();
  return o.order_id;
}

test("TF-071 §13 FIX + erkennbares WordPress: Plattform erkannt → direkt sicherer Link (WordPress-Admin), kein Passwort per Mail, Formular nur mit WordPress-Feldern", async () => {
  const W = world({ detect: "wordpress" });
  const id = await paidFix(W);
  const s = W.g.sends();
  assert.equal(s.length, 1, "genau eine Startnachricht, keine Plattform-Frage");
  assert.equal(s[0].messageClass, "CUSTOMER_ACCESS_REQUEST");
  assert.ok(!s[0].body.includes(HOSTING_QUESTION_DE), "keine Hosting-Frage, wenn sicher erkannt");
  assert.match(s[0].body, /Ihre Website läuft mit WordPress\. .*temporären Benutzer mit der Rolle «Administrator»/);
  assert.ok(s[0].body.includes(C.NO_PASSWORD_DE));
  assert.doesNotMatch(s[0].body, ASKS_PASSWORD_BY_MAIL);
  assert.match(s[0].body, /Gibt es neben den von uns gefundenen technischen Fehlern noch Inhalte/, "TF-066 Inhaltsfrage bleibt");
  const o = W.order(id);
  assert.deepEqual([o.platform.cms_platform, o.platform.access_type, o.platform.connector_type, o.platform.confidence, o.platform.detection_source], ["WORDPRESS", "WORDPRESS_ADMIN", "wordpress_cms", "HIGH", "automatic"]);
  assert.deepEqual(W.exp(id).platform, { hosting_provider: "HOSTPOINT", cms_platform: "WORDPRESS", dns_provider: "HOSTPOINT", deployment_platform: null, panel: null, access_type: "WORDPRESS_ADMIN",
    confidence: "HIGH", detection_source: "automatic", access_flow: "WAITING_FOR_SECURE_ACCESS" });
  // Adaptives Formular: feste Zugangsart, nur WordPress-Felder; andere Zugangsart → abgelehnt.
  const link = linkOf(s[0].body);
  const info = await W.c.call({ op: "info", token: tokenOf(link) });
  assert.deepEqual([info.body.access_kind, info.body.access_types, info.body.fields], ["WORDPRESS_ADMIN", ["wordpress_cms"], ["host", "user", "secret", "notes"]]);
  assert.equal((await W.submit(link, { access_type: "sftp" })).status, 400, "falsche Zugangsart für den Link");
  assert.equal((await W.submit(link, { access_type: "wordpress_cms" })).status, 200);
  await W.tick();
  assert.equal(W.order(id).access_intake?.connector_type ?? (W.order(id).access?.ok && "wordpress_cms"), "wordpress_cms");
  assert.ok(["ACCESS_VALIDATED", "ACCESS_RECEIVED"].includes(W.exp(id).platform.access_flow));
  assert.ok(!W.allFiles().includes(GOOD), "Zugangsdaten nie im Klartext ausserhalb des Tresors");
});

test("TF-071 §13 FIX + unbekannte Plattform: zuerst Hosting-Frage (kein Link, keine Registrierung) → «WordPress bei Hostpoint» → Plattform gespeichert → passender sicherer Link im selben Thread → E2E bis Abschluss", async () => {
  const W = world({ detect: "unknown" });
  const id = await paidFix(W);
  const q = W.g.sends();
  assert.equal(q.length, 1);
  assert.equal(q[0].messageClass, C.ONBOARDING_CLASS);
  assert.ok(q[0].body.includes(HOSTING_QUESTION_DE) && q[0].body.includes(HOSTING_NO_PW_DE), "exakte Frage + kein Passwort per Mail");
  assert.ok(!/access\.html|#t=/.test(q[0].body), "kein sicherer Link vor geklärter Plattform");
  assert.doesNotMatch(q[0].body, ASKS_PASSWORD_BY_MAIL);
  assert.doesNotMatch(q[0].body, /Benutzername|Passwort:/);
  assert.match(q[0].body, /Gibt es neben den von uns gefundenen technischen Fehlern noch Inhalte/, "Inhaltsfrage im selben ersten Schreiben");
  assert.equal(JSON.parse(W.c.blobs.dump()).length, 0, "keine Link-Registrierung (kein Credential-Request) vor der Plattform");
  assert.equal(W.order(id).state, "WAITING_FOR_HOSTING_INFO");
  assert.equal(W.exp(id).access_status, "HOSTING_INFO_MISSING");
  assert.equal(W.exp(id).platform.access_flow, "WAITING_FOR_HOSTING_INFO");
  assert.equal(W.rec(id).thread_id, q[0].threadId, "Thread durch die Frage gebunden");
  assert.equal(C.publicOnboarding(W.rec(id), W.exp(id)).state, "WAITING_FOR_CUSTOMER_INFO");
  await W.tick(2);
  assert.equal(W.g.sends().length, 1, "keine zweite Frage, kein Link ohne Antwort");
  // Kunde antwortet.
  W.reply(id, "Guten Tag\n\nWordPress bei Hostpoint.\n\nFreundliche Grüsse\nAnna Muster");
  await W.mailTick();
  assert.equal(W.extract.calls.length, 0, "deterministisch, keine KI");
  assert.equal(W.g.sends().length, 1, "keine eigene Antwort – der Link folgt");
  assert.deepEqual([W.rec(id).platform.cms_platform, W.rec(id).platform.hosting_provider], ["WORDPRESS", "HOSTPOINT"]);
  await W.tick();
  const o = W.order(id);
  assert.deepEqual([o.state, o.platform.cms_platform, o.platform.hosting_provider, o.platform.access_type, o.platform.detection_source], ["ACCESS_REQUESTED", "WORDPRESS", "HOSTPOINT", "WORDPRESS_ADMIN", "customer"]);
  const acc = W.g.sends()[1];
  assert.equal(acc.messageClass, "CUSTOMER_ACCESS_REQUEST");
  assert.equal(acc.threadId, q[0].threadId, "Link im bestehenden Auftrags-Thread");
  assert.ok(acc.inReplyTo, "In-Reply-To gesetzt");
  assert.match(acc.body, /vielen Dank für Ihre Angaben/);
  assert.match(acc.body, /Ihre Website läuft mit WordPress/);
  assert.ok(!/Gibt es neben den von uns gefundenen technischen Fehlern/.test(acc.body), "Inhaltsfrage nicht wiederholt");
  const link = linkOf(acc.body);
  assert.equal((await W.c.call({ op: "info", token: tokenOf(link) })).body.access_kind, "WORDPRESS_ADMIN", "korrektes Formular");
  assert.equal(W.exp(id).platform.access_flow, "WAITING_FOR_SECURE_ACCESS");
  // Zugang + «Nein» (keine Inhaltsänderungen) → Validierung → Reparatur → Abschluss.
  assert.equal((await W.submit(link, { access_type: "wordpress_cms" })).status, 200);
  await W.tick();
  W.reply(id, "Nein, sonst nichts.");
  await W.tick(3);
  const done = W.order(id);
  assert.ok(["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS"].includes(done.state), done.state);
  assert.equal(completionGate(done).missing.includes("platform"), false);
  assert.equal(done.access_validation.status, "ACCESS_VALIDATED");
  assert.equal(W.detections.length, 1, "Erkennung genau einmal");
});

test("TF-071 §13 CHECK-Auftrag: kein Hosting-/Zugangs-Flow, keine Erkennung", async () => {
  const W = world({ detect: "unknown" });
  W.store.write("sales.json", { records: recordDirectSale({}, { domain: DOMAIN, offer: "REPAIR_CHECK_150", delivery_email: EMAIL, company: "Kunde AG", website: SITE, date: "2026-10-16" }) });
  const o = createCheck150Order(W.store, { domain: DOMAIN, website: SITE, company: "Kunde AG", delivery_email: EMAIL, now: T0 });
  recordPayment(W.store, { order_id: o.order_id, amount_chf: 75, reference: "TF71-CHECK", now: T0 });
  await W.tick(2);
  const s = W.g.sends();
  assert.ok(s.length >= 1);
  for (const m of s) { assert.ok(!m.body.includes(HOSTING_QUESTION_DE), "keine Hosting-Frage"); assert.ok(!/access\.html|#t=/.test(m.body), "kein Zugangslink"); }
  assert.equal(W.detections.length, 0, "keine Plattform-Erkennung für CHECK");
  assert.equal(W.exp(o.order_id).platform, null);
  assert.equal(W.exp(o.order_id).access_status, "NOT_REQUIRED");
});

test("TF-071 §9 Passwort per Mail während der Hosting-Frage: nichts gespeichert/geloggt/an die KI, Hinweis ohne Verweis auf einen (noch nicht existierenden) Link, Plattform nicht aus dieser Mail übernommen", async () => {
  const W = world({ detect: "unknown" });
  const id = await paidFix(W);
  W.reply(id, "Hallo, WordPress bei Hostpoint. Benutzer: admin\nPasswort: Geheim-TF71-xyz!\nGruss");
  await W.mailTick();
  const hint = W.lastSend();
  assert.equal(hint.messageClass, C.ONBOARDING_CLASS);
  assert.ok(hint.body.includes(C.SENSITIVE_NOLINK_DE));
  assert.ok(hint.body.includes(HOSTING_QUESTION_DE), "Plattform erneut erfragt (ohne Zugangsdaten)");
  assert.ok(!hint.body.includes("vorherigen Nachricht"), "kein Verweis auf einen Link, den es noch nicht gibt");
  assert.ok(!hint.body.includes("Geheim-TF71"));
  assert.equal(W.extract.calls.length, 0, "nie an die KI");
  assert.equal(W.rec(id).platform, undefined, "nichts aus der Passwort-Mail übernommen");
  assert.ok(!W.allFiles().includes("Geheim-TF71"), "nicht gespeichert (Brief, Export, Outbox, Zustand)");
  assert.ok(!W.logs.join("\n").includes("Geheim-TF71") && !JSON.stringify(W.notes).includes("Geheim-TF71"), "nicht geloggt");
  assert.ok(!JSON.stringify(W.onb.publicByOrder()).includes("Geheim-TF71"), "nicht im CRM");
  // Danach saubere Antwort → Flow läuft normal weiter.
  W.reply(id, "WordPress bei Hostpoint");
  await W.tick();
  assert.equal(W.order(id).platform.access_type, "WORDPRESS_ADMIN");
  // Reminder vor Antwort wiederholt die Plattform-Frage (eigene Welt).
  const R = world({ detect: "unknown" });
  const rid = await paidFix(R);
  R.reply(rid, "Nein");
  await R.mailTick();
  assert.ok(R.lastSend().body.includes(HOSTING_QUESTION_DE), "«Nein» zur Inhaltsfrage → Bestätigung + Plattform-Frage");
  R.advance(25 * H);
  await R.tick();
  assert.ok(R.lastSend().body.includes(HOSTING_QUESTION_DE), "Erinnerung fragt nach der Plattform");
  assert.ok(!/access\.html|#t=/.test(R.lastSend().body));
});

test("TF-071 §10 ACCESS_VALIDATION_FAILED: ungültiger Zugang → zerstört, nie erneut versucht, neuer Link im Auftrags-Thread; gültiger Zugang → ACCESS_VALIDATED; dreimal ungültig → Chris", async () => {
  const W = world({ detect: "wordpress" });
  const id = await paidFix(W);
  const link1 = linkOf(W.g.sends()[0].body);
  assert.equal((await W.submit(link1, { access_type: "wordpress_cms", secret: BAD })).status, 200);
  await W.tick();
  let o = W.order(id);
  assert.equal(o.access_validation.status, "ACCESS_VALIDATION_FAILED");
  assert.equal(o.access_intake, null, "Zugang verworfen");
  assert.ok(!fs.existsSync(path.join(W.state, "access_vault", `${id}.json`)), "Tresor-Eintrag zerstört");
  assert.equal(W.w.st.preflights.filter((x) => x === BAD).length, 1, "ungültige Zugangsdaten genau einmal versucht");
  await W.tick(2);
  assert.equal(W.w.st.preflights.filter((x) => x === BAD).length + W.w.st.checks.filter((x) => x === BAD).length, 1, "nie wiederholt");
  const re = W.g.sends().filter((m) => m.messageClass === "CUSTOMER_ACCESS_REQUEST");
  assert.equal(re.length, 2, "genau ein neuer Link");
  assert.equal(re[1].threadId, W.rec(id).thread_id, "im Auftrags-Thread");
  assert.match(re[1].body, /konnte ich mich mit dem übermittelten Zugang nicht anmelden/);
  const link2 = linkOf(re[1].body);
  assert.notEqual(link2, link1);
  assert.equal((await W.c.call({ op: "info", token: tokenOf(link1) })).status, 404, "alter Link tot");
  assert.equal((await W.c.call({ op: "info", token: tokenOf(link2) })).body.access_kind, "WORDPRESS_ADMIN");
  assert.ok(!W.allFiles().includes(BAD), "ungültiges Secret nirgends im Klartext");
  // Gültiger Zugang → validiert.
  assert.equal((await W.submit(link2, { access_type: "wordpress_cms", secret: GOOD })).status, 200);
  await W.tick();
  o = W.order(id);
  assert.equal(o.access_validation.status, "ACCESS_VALIDATED");
  assert.equal(o.access_validation.failures, 1);
  // Dreimal ungültig → BLOCKED_NO_ACCESS + Chris, keine weitere automatische Anfrage.
  const X = world({ detect: "wordpress" });
  const xid = await paidFix(X);
  for (let i = 0; i < 3; i++) {
    const l = linkOf(X.g.sends().filter((m) => m.messageClass === "CUSTOMER_ACCESS_REQUEST").at(-1).body);
    assert.equal((await X.submit(l, { access_type: "wordpress_cms", secret: BAD })).status, 200);
    await X.tick();
  }
  assert.equal(X.order(xid).state, "BLOCKED_NO_ACCESS");
  assert.equal(X.g.sends().filter((m) => m.messageClass === "CUSTOMER_ACCESS_REQUEST").length, 3, "nach dem 3. Fehlschlag kein weiterer Link");
  assert.ok(X.order(xid).alerts.some((a) => a.kind === "access_validation_failed"), "Chris informiert");
});

test("TF-071 §13/§55 VN: unbekannte Plattform → vietnamesische Hosting-Frage, «WordPress ở Mắt Bão» → vietnamesischer Link mit WordPress-Anleitung", async () => {
  const W = world({ detect: "unknown", site: VN_SITE });
  const o = createRepairOrder(W.store, { domain: VN_DOMAIN, website: VN_SITE, company: "Quán Cà Phê", delivery_email: VN_EMAIL, contact_name: "chị Lan", offer_class: "VN_REPAIR_FIX",
    vn: { lead_id: VN_DOMAIN, seller_id: "Kudoshin", confirmed_by: "Kudoshin", confirmed_at: T0.toISOString(), source: "vn_sales_confirmed", request_id: "00000000-0000-0000-0000-000000000071" }, now: T0 });
  recordPayment(W.store, { order_id: o.order_id, amount: 1950000, currency: "VND", reference: `TF71-${o.order_id}`, now: T0 });
  await W.tick();
  const q = W.g.sends()[0];
  assert.ok(q.body.includes(HOSTING_QUESTION_VI) && q.body.includes(HOSTING_NO_PW_VI));
  assertVn(q.body, "VN Hosting-Frage");
  assertVn(q.subject, "VN Betreff");
  W.reply(o.order_id, "WordPress ở Mắt Bão");
  await W.tick(2);
  const acc = W.g.sends()[1];
  assert.equal(acc.messageClass, "CUSTOMER_ACCESS_REQUEST");
  assertVn(acc.body, "VN Zugangs-Mail");
  assert.match(acc.body, /Website của anh\/chị dùng WordPress/);
  assert.ok(/&l=vi/.test(linkOf(acc.body)));
  assert.equal(W.order(o.order_id).platform.hosting_provider, "MATBAO");
  assert.equal(W.order(o.order_id).seller_id, "Kudoshin", "Verkäuferzuordnung unverändert");
});

test("TF-071 §11/§14 CRM + Sicherheit: nur feste Wörter, nie Zugangsdaten; Verkäufer ohne Klartext/Worker-Rechte; Cross-Customer, abgelaufener und wiederverwendeter Link blockiert", async () => {
  const W = world({ detect: "wordpress" });
  const id = await paidFix(W);
  const link = linkOf(W.g.sends()[0].body);
  assert.equal((await W.submit(link, { access_type: "wordpress_cms" })).status, 200);
  await W.tick();
  const pub = W.onb.publicByOrder()[id];
  assert.equal(pub.platform.cms_platform, "WORDPRESS");
  assert.equal(pub.platform.access_type, "WORDPRESS_ADMIN");
  const snapRepair = cleanRepair(attachOnboarding({ orders: [{ order_id: id, domain: DOMAIN, state: W.order(id).state }] }, { [id]: { ...pub, platform: { ...pub.platform, password: GOOD, username: "jarvis-temp", host: SITE } } }));
  const s = JSON.stringify(snapRepair);
  for (const bad of [GOOD, "jarvis-temp", "password", "wp-admin", "#t="]) assert.ok(!s.includes(bad), `CRM-Snapshot enthält nie ${bad}`);
  assert.deepEqual(Object.keys(snapRepair.orders[0].onboarding.platform).sort(), ["access_flow", "access_type", "cms_platform", "confidence", "deployment_platform", "detection_source", "dns_provider", "hosting_provider", "panel"]);
  assert.ok(!JSON.stringify(pub).includes(GOOD) && !JSON.stringify(W.exp(id)).includes(GOOD), "Export/Onboarding ohne Zugangsdaten");
  // Anzeige (DE/VI): Hosting, CMS, Zugangsart, Erkennung, Zugangsstatus.
  const rows = platformRows(pub.platform, onboardingTexts("de-CH"));
  assert.deepEqual(rows.map((r) => r[0]), ["Hosting", "CMS", "Zugangsart", "Erkennung", "Zugangsstatus"]);
  assert.deepEqual(rows.slice(0, 3).map((r) => r[1]), ["Hostpoint", "WordPress", "Temporärer WordPress-Admin"]);
  // Verkäufer/Chris über die API: Plattform-Wörter sichtbar (eigener Bereich), Zugangsdaten nie.
  const t = await salesSetup();
  const mar = (await t.json(await t.crm(makeReq("/api/crm", { cookie: t.cookies.mario })))).body.leads.find((l) => l.domain);
  const snap = { repair: cleanRepair({ orders: [{ order_id: "RF480-20261016-aaaaaa", domain: mar.domain, market: "CH", state: "ACCESS_CHECK", onboarding: pub }] }) };
  await t.stores.control.set({ snapshot: snap }, (await t.stores.control.get()).etag);
  for (const u of ["chris", "mario", "giuliano", "Kudoshin", "damiano"]) {
    const r = await t.json(await t.sales(makeReq("/api/sales?view=onboarding", { cookie: t.cookies[u] })));
    assert.equal(r.status, 200, u);
    assert.ok(!JSON.stringify(r.body).includes(GOOD), `${u}: nie Klartext`);
    if (u === "chris" || u === "mario") assert.equal(r.body.orders[0].onboarding.platform.access_type, "WORDPRESS_ADMIN", u);
    else assert.equal(r.body.orders.length, 0, `${u}: fremder Kunde nie sichtbar`);
  }
  // Abholung der Einreichungen nur mit Worker-Token – Verkäufer-Sitzung/ohne Token → 401, keine Chiffrate.
  const pull = await W.c.call({ op: "pull" }, { cookie: t.cookies.Kudoshin });
  assert.equal(pull.status, 401);
  assert.equal((await W.c.call({ op: "register", order_id: "RF480-20261016-bbbbbb" })).status, 401);
  // Cross-Customer / Ablauf / Wiederverwendung direkt am Cloud-Handler.
  let clock = +T0;
  const cl = cloud(() => new Date(clock));
  const pub_key = accessKeys(tmp()).publicKeyPem;
  const reg = async (order_id, domain, token) => cl.call({ op: "register", order_id, domain, token_hash: tokenHash(token), expires_at: new Date(clock + 72 * H).toISOString(), public_key: pub_key, access_kind: "WORDPRESS_ADMIN" }, { "x-jarvis-worker": WT });
  const tA = "A".repeat(43), tB = "B".repeat(43);
  assert.equal((await reg("RF480-20261016-aaaaaa", "kunde-a.test", tA)).status, 200);
  assert.equal((await reg("RF480-20261016-bbbbbb", "kunde-b.test", tB)).status, 200);
  assert.equal((await cl.call({ op: "register", order_id: "RF480-20261016-cccccc", domain: "kunde-c.test", token_hash: tokenHash("C".repeat(43)), expires_at: new Date(clock + H).toISOString(), public_key: pub_key, access_kind: "ROOT_SHELL" }, { "x-jarvis-worker": WT })).status, 400, "unbekannter Zugangsweg");
  const env = (domain) => ({ op: "submit", token: tA, access_type: "wordpress_cms", access_domain: domain, consent: true, envelope: sealEnvelope({ access_type: "wordpress_cms", secret: GOOD }, pub_key) });
  assert.equal((await cl.call({ op: "info", token: tA })).body.domain, "kunde-a.test", "Token A sieht nur Auftrag A");
  assert.equal((await cl.call(env("kunde-b.test"))).status, 400, "Cross-Customer: Domain B mit Token A blockiert");
  assert.equal((await cl.call(env("kunde-a.test"))).status, 200);
  assert.equal((await cl.call(env("kunde-a.test"))).status, 404, "wiederverwendeter One-Time-Link blockiert");
  clock += 73 * H;
  assert.equal((await cl.call({ op: "info", token: tB })).status, 404, "abgelaufener Link blockiert");
  assert.ok(!cl.blobs.dump().includes(GOOD), "Cloud speichert nur Chiffrat");
});

test("TF-071 Texte: Hosting-Frage exakt (CH), keine Zugangsdaten-Abfrage in Frage/Zugangs-Mails aller Zugangswege", () => {
  const order = { order_id: "RF480-20261016-abcdef", domain: DOMAIN, contact_name: "Frau Muster", market: "CH" };
  const m = buildHostingQuestionMail(order);
  assert.ok(m.body.includes("Bei welchem Anbieter bzw. mit welchem System wird Ihre Website betrieben? Zum Beispiel WordPress, Wix, Shopify, Webflow oder bei einem Hosting-Anbieter wie Hostpoint, Infomaniak usw."));
  assert.ok(m.body.includes("Bitte senden Sie uns noch keine Passwörter oder Zugangsdaten per E-Mail."));
  for (const kind of Object.keys(ACCESS_FORMS)) for (const askContent of [true, false]) for (const market of ["CH", "VN"]) {
    const o = { ...order, market, ...(market === "VN" ? { order_id: "VNFIX-20261016-abcdef" } : {}) };
    const a = buildAccessRequestMail(o, { link: "https://jarvis.test/access.html#t=x", expires_at: T0.toISOString(), onboarding: true, access_kind: kind, askContent });
    assert.doesNotMatch(a.body, ASKS_PASSWORD_BY_MAIL, `${kind}/${market}`);
    assert.ok(a.body.includes(market === "VN" ? C.NO_PASSWORD_VI : "Bitte senden Sie keine Passwörter oder Zugangsdaten per E-Mail."), `${kind}/${market}`);
    if (market === "VN") assertVn(a.body, `${kind} VN`);
  }
});
