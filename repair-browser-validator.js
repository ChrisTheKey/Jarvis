// BROWSER REPAIR VALIDATION & VISUAL REGRESSION GATE (TF-045) für CHECK & REPARATUR (CHF 480).
// Nach einer automatischen Reparatur beweist ein ECHTER Browser (Chromium über playwright-core), dass die Website wie für einen
// Besucher funktioniert: Desktop 1440×900 + Smartphone 390×844, Navigation, reparierter Befund, keine neuen Regressionen.
//
// Harte Regeln (fail closed):
//   - NUR PASSIV. Der Validator verändert nie eine Website. Erlaubt sind ausschliesslich die Aktionen aus SAFE_INTERACTIONS
//     (Seite öffnen, Navigation öffnen, Navigationsziel prüfen, reparierten Link anklicken, Bild/Ziel-URL prüfen, Overflow messen).
//     Kein Login, kein Formular, kein Checkout, keine Zahlung, kein Newsletter, kein Upload, keine Cookie-Einstellung, nie Tippen.
//     Technisch erzwungen: jede Anfrage ausser GET/HEAD wird im Browser abgebrochen (kein Formular kann je abgesendet werden),
//     Dialoge werden verworfen, Popups geschlossen, Downloads/Service Worker gesperrt.
//   - Pro Lauf ein frischer Browser-Kontext ohne gespeicherten Zustand (Cookies/Storage verschwinden mit dem Kontext); HOME der
//     Browser-Instanz liegt in einem Temp-Verzeichnis, das danach gelöscht wird.
//   - Ergebnis = ausschliesslich sichere Metadaten (Zähler, Flags, Codes, bereinigte URLs, kurze Hashes). Nie DOM, Seitentexte,
//     Console-Texte, Cookies, Header, Tokens oder POST-Bodies. URLs werden vor jeder Persistenz bereinigt (sanitizeUrl).
//   - Screenshots nur auf ausdrücklichen Wunsch, nur temporär, nach dem Lauf gelöscht (nie Git/PROJECT_STATE/Cloud/Kundendatensatz).
//   - Vergleich VORHER/NACHHER über robuste Layout-Indikatoren statt Pixelvergleich; nicht eindeutig → MANUAL_REVIEW.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { VIEWPORTS } from "./repair-render-test.js";
import { siteAuditProbe, BROWSER_AUDIT_TYPES } from "./browser-site-audit.js";

export { VIEWPORTS };
export const BROWSER_METHOD = "Chromium Browser-Validierung (Desktop 1440×900, Smartphone 390×844)";
export const REGRESSION_LEVELS = Object.freeze(["NONE", "LOW", "MEDIUM", "HIGH"]);
// Abschluss nur bei NONE oder klar akzeptablem LOW. MEDIUM/HIGH → Rollback.
export const ACCEPTABLE_LEVELS = Object.freeze(["NONE", "LOW"]);
export const SAFE_INTERACTIONS = Object.freeze(["open_page", "open_navigation", "check_navigation_target", "click_repaired_link", "verify_image",
  "verify_target_url", "measure_overflow"]);
const OVERFLOW_TOLERANCE_PX = 2;
const MASSIVE_OVERFLOW_PX = 50;
const MAX_NAV_TARGETS = 3;
const MAX_ENTRIES = 20;
const rank = (l) => REGRESSION_LEVELS.indexOf(l);
const maxLevel = (...ls) => ls.reduce((a, b) => (rank(b) > rank(a) ? b : a), "NONE");
const short = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
export const normDomain = (d = "") => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[:/].*$/, "");
const sameDomain = (host, expected) => normDomain(host) === normDomain(expected);
// Für die Einordnung von Console-/Netzwerkfehlern zählen Subdomains zur eigenen Website (cdn.<domain>), für Klicks nicht.
const sameSite = (host, expected) => { const h = normDomain(host), d = normDomain(expected); return !!d && (h === d || h.endsWith("." + d)); };
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };

// ---------- Bereinigung (vor jeder Persistenz) ----------
const SENSITIVE_KEY_RE = /token|key|secret|pass(word)?|pwd|auth|code|session|sid|sig(nature)?|jwt|credential|nonce|otp/i;
const OPAQUE_VALUE_RE = /^[A-Za-z0-9_\-.~+/=]{24,}$/;
export function sanitizeUrl(raw, { max = 200 } = {}) {
  let u; try { u = new URL(String(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return u.protocol; // data:, blob: … – nie den Inhalt
  u.username = ""; u.password = ""; u.hash = "";
  for (const [k, v] of [...u.searchParams.entries()]) if (SENSITIVE_KEY_RE.test(k) || OPAQUE_VALUE_RE.test(v)) u.searchParams.set(k, "REDACTED");
  return u.href.slice(0, max);
}
const pathOf = (u) => { try { return new URL(u).pathname.slice(0, 160); } catch { return null; } };
// TF-JARVIS-028: Seitenschlüssel für Link-Vergleiche. Hoster mit «Pretty URLs» (Netlify) liefern href="/x.html" als href="/x" aus
// und bedienen /x, /x/ und /x.html gleich – daher gelten diese (und /index.html ≡ /) als dieselbe Seite. Nur .html/.htm und ein
// abschliessender Schrägstrich fallen weg; andere Endungen, Gross-/Kleinschreibung, Host, Query und Fragment bleiben unberührt
// (Query/Fragment sind im pathname ohnehin nicht enthalten). Im Seitenkontext (browserProbeScript, locateScript) steht dieselbe Zeile inline.
export const pagePathKey = (p) => String(p || "/").replace(/\/index\.html?$/i, "/").replace(/\.html?$/i, "").replace(/(.)\/+$/, "$1") || "/";

// ---------- Erlaubte Klickziele (alles andere wird nie angeklickt) ----------
export const PROTECTED_INTERACTION_RE = /log-?in|anmeld|sign[- ]?(in|up)|registr|passw|checkout|kasse|warenkorb|\bcart\b|basket|bestell|\border\b|kaufen|\bbuy\b|\bpay|zahl|twint|newsletter|abonn|subscri|cookie|consent|akzept|accept|zustimm|einwillig|delete|lösch|entfern|upload|hochlad|account|konto|admin|wp-login|logout|abmeld|submit|absenden|\bsenden\b|\bsend\b/i;
export function isSafeClickTarget(d = {}) {
  if (!d || typeof d !== "object" || d.in_form || d.contenteditable) return false;
  const words = `${d.href_path || ""} ${d.text || ""} ${d.label || ""}`;
  if (PROTECTED_INTERACTION_RE.test(words)) return false;
  if (d.tag === "a") return !!d.href_path && /^https?:$/.test(d.protocol || "") && !d.download;
  if (d.tag === "button" || d.role === "button") return d.menu_toggle === true && !["submit", "reset"].includes(String(d.type || "").toLowerCase());
  return false;
}

// ---------- Konservativer Filter für bekannte harmlose Drittanbieter-Fehler ----------
// Nur fremde Hosts dieser Liste (Tracking/Werbung/Chat-Widgets) – Fehler der eigenen Website werden NIE ignoriert. Zusätzlich
// der automatische /favicon.ico-Abruf des Browsers (kein Inhalt der Seite).
export const HARMLESS_THIRD_PARTY_RE = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|facebook\.net|facebook\.com|connect\.facebook\.net|hotjar\.com|clarity\.ms|bing\.com|linkedin\.com|licdn\.com|tiktok\.com|pinterest\.com|twitter\.com|x\.com|tawk\.to|intercom\.io|hubspot\.com|hs-analytics\.net|cookiebot\.com|usercentrics\.eu|onetrust\.com)$/i;
export function classifyConsoleSource(url, expected) {
  const host = hostOf(url);
  if (pathOf(url) === "/favicon.ico") return "ignored";
  if (!host || sameSite(host, expected)) return "same_site"; // ohne Quelle (Inline-Skript) → eigene Seite, nie ignoriert
  return HARMLESS_THIRD_PARTY_RE.test(host) ? "ignored" : "third_party";
}

// ---------- Im Seitenkontext (page.evaluate): reine DOM-Lesung, keine Veränderung ----------
// arg = { broken: [pfad], expected: [pfad] } – liefert nur Zahlen/Flags/Pfade/Struktur-Signaturen.
export function browserProbeScript(arg = {}) {
  // Layout-Viewport: bei Mobile-Emulation zoomt Chromium breite Seiten heraus (innerWidth wächst mit) – clientWidth bleibt 390.
  const de = document.documentElement, vw = de.clientWidth || window.innerWidth, vh = de.clientHeight || window.innerHeight;
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0; };
  const res = (u) => { try { const x = new URL(u, location.href); return { host: x.hostname, path: x.pathname, protocol: x.protocol }; } catch { return null; } };
  const pageKey = (p) => String(p || "/").replace(/\/index\.html?$/i, "/").replace(/\.html?$/i, "").replace(/(.)\/+$/, "$1") || "/"; // = pagePathKey
  const linkTo = (a, p) => { const r = res(a.getAttribute("href")); return !!r && pageKey(r.path) === pageKey(p); }; // Pretty URLs: /x.html ≡ /x ≡ /x/
  const q = (s) => document.querySelector(s);
  const header = q("header, [role=banner]"), nav = q("nav, [role=navigation]"), main = q("main, [role=main]"), footer = q("footer, [role=contentinfo]");
  const hero = q(".hero, #hero, [class*=hero]"), cta = q("a.cta, .cta a, a[class*=cta], a.btn-primary, a.button-primary");
  const sig = (el) => (el ? [el.tagName, el.children.length, el.querySelectorAll("a").length, el.querySelectorAll("img").length, el.querySelectorAll("h1,h2,h3").length, el.querySelectorAll("button").length].join(":") : null);
  const all = [...document.querySelectorAll("body *")].slice(0, 4000);
  const scrollWidth = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  let offscreen = 0, clipped = 0;
  for (const el of all) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (s.position !== "fixed" && r.width > 0 && r.height > 0 && r.right > vw + 8 && r.left < vw) offscreen++;
    if (/^(H1|H2|H3|P|A|BUTTON|LI|SPAN|LABEL)$/.test(el.tagName) && /hidden|clip/.test(s.overflowX + s.overflow) && el.scrollWidth > el.clientWidth + 2 && (el.textContent || "").trim().length > 3 && s.textOverflow !== "ellipsis") clipped++;
  }
  const imgs = [...document.images].filter(vis);
  const brokenImgs = imgs.filter((i) => i.complete && i.naturalWidth === 0);
  // Navigation = Links im nav-Element (falls vorhanden), sonst im Header – ein sichtbares Logo zählt nicht als bedienbare Navigation.
  const navLinks = [...document.querySelectorAll(nav ? "nav a[href], [role=navigation] a[href]" : "header a[href]")].filter(vis).slice(0, 30)
    .map((a) => res(a.getAttribute("href"))).filter((x) => x && /^https?:$/.test(x.protocol));
  const toggles = [...document.querySelectorAll("header button, nav button, header [role=button], nav [role=button], [aria-controls], [aria-expanded]")]
    .filter((b) => vis(b) && !b.closest("form") && /men[uü]|navigation|\bnav\b|burger|toggle|☰/i.test(`${b.textContent} ${b.getAttribute("aria-label") || ""} ${b.className} ${b.id}`));
  let mainCovered = null;
  if (main && vis(main)) {
    const r = main.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + Math.min(20, r.width / 2), 0), vw - 1), y = Math.min(Math.max(r.top + 10, 0), vh - 1);
    if (r.top < vh) { const hit = document.elementFromPoint(x, y); mainCovered = !(hit && (main.contains(hit) || hit === main || hit.contains(main))); }
  }
  const findings = { broken: {}, expected: {} };
  for (const p of arg.broken || []) {
    findings.broken[p] = { links: [...document.querySelectorAll("a[href]")].filter((a) => linkTo(a, p) && res(a.getAttribute("href"))?.host === location.hostname).length,
      images: [...document.images].filter((i) => res(i.getAttribute("src"))?.path === p).length };
  }
  for (const p of arg.expected || []) {
    const as = [...document.querySelectorAll("a[href]")].filter((a) => linkTo(a, p));
    const is = [...document.images].filter((i) => res(i.getAttribute("src"))?.path === p);
    findings.expected[p] = { links: as.length, links_visible: as.filter(vis).length,
      images: is.length, images_visible: is.filter(vis).length, images_loaded: is.filter((i) => i.complete && i.naturalWidth > 0).length };
  }
  return {
    viewport_width: vw, viewport_height: vh, scroll_width: scrollWidth, doc_height: de.scrollHeight,
    text_length: ((main || document.body || {}).innerText || "").trim().length, body_visible: vis(document.body),
    critical: { header: vis(header), nav: vis(nav), main: vis(main), footer: vis(footer), hero: vis(hero), cta: vis(cta), main_covered: mainCovered },
    offscreen_elements: offscreen, clipped_text: clipped,
    images_visible: imgs.length, images_broken: brokenImgs.length, images_over_viewport: imgs.filter((i) => i.getBoundingClientRect().width > vw + (arg.tolerance || 2)).length,
    broken_image_paths: brokenImgs.slice(0, 10).map((i) => res(i.getAttribute("src"))?.path || null).filter(Boolean),
    nav_links: navLinks.map((x) => ({ host: x.host, path: x.path })), menu_toggles: toggles.length,
    signatures: { header: sig(header), nav: sig(nav), main: sig(main), footer: sig(footer) }, findings,
  };
}

// Element + Beschreibung für isSafeClickTarget (im Seitenkontext, per evaluateHandle → geklickt wird GENAU dieses Element).
// kind = "toggle" | "link"; Links im Hauptinhalt haben Vorrang (dort steht der reparierte Verweis), danach der Rest der Seite.
function locateScript({ kind, path: p }) {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const pageKey = (q) => String(q || "/").replace(/\/index\.html?$/i, "/").replace(/\.html?$/i, "").replace(/(.)\/+$/, "$1") || "/"; // = pagePathKey
  const sel = kind === "toggle" ? "header button, nav button, header [role=button], nav [role=button], [aria-controls], [aria-expanded]" : "a[href]";
  const inMain = kind === "link" ? [...document.querySelectorAll("main a[href], [role=main] a[href]")] : [];
  const list = [...new Set([...inMain, ...document.querySelectorAll(sel)])];
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (!vis(el)) continue;
    const text = (el.textContent || "").trim().slice(0, 60), label = el.getAttribute("aria-label") || "";
    if (kind === "toggle") {
      if (!/men[uü]|navigation|\bnav\b|burger|toggle|☰/i.test(`${text} ${label} ${el.className} ${el.id}`)) continue;
      return { el, desc: { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), type: el.getAttribute("type") || (el.tagName === "BUTTON" ? "submit_default" : null),
        in_form: !!el.closest("form"), text, label, menu_toggle: true, expanded: el.getAttribute("aria-expanded") } };
    }
    let u; try { u = new URL(el.getAttribute("href"), location.href); } catch { continue; }
    if (pageKey(u.pathname) !== pageKey(p)) continue;
    return { el, desc: { tag: "a", in_form: !!el.closest("form"), text, label, href_path: u.pathname, protocol: u.protocol, host: u.hostname,
      target_blank: el.getAttribute("target") === "_blank", download: el.hasAttribute("download"), contenteditable: el.isContentEditable } };
  }
  return null;
}
// evaluateHandle → { el: ElementHandle, desc } | null
async function locateElement(page, arg) {
  const h = await page.evaluateHandle(locateScript, arg);
  const el = (await h.getProperty("el").catch(() => null))?.asElement() || null;
  if (!el) { await h.dispose().catch(() => {}); return null; }
  const desc = await (await h.getProperty("desc")).jsonValue();
  return { el, desc };
}

// TF-046: Navigiert die Seite während der Messung selbst (eigenes Skript, Weiterleitung), wird der JS-Kontext ersetzt – dann nach
// dem Laden erneut messen (höchstens zweimal), statt den ganzen Lauf mit einem Fehler abzubrechen.
const CONTEXT_LOST_RE = /Execution context was destroyed|Cannot find context|navigat/i;
async function evaluateStable(page, fn, arg, timeoutMs = 5000) {
  for (let attempt = 0; ; attempt++) {
    try { return await page.evaluate(fn, arg); }
    catch (e) {
      if (attempt >= 2 || !CONTEXT_LOST_RE.test(String(e?.message || ""))) throw e;
      await documentLoaded(page, timeoutMs);
    }
  }
}
// Dokument vollständig geladen – direkt über document.readyState (Playwrights Load-Status kann an einer blockierten, nie
// committenden Folgenavigation hängen bleiben, obwohl die Seite längst «complete» ist).
const documentLoaded = (page, timeoutMs) => page.waitForFunction(() => document.readyState === "complete", null, { timeout: timeoutMs, polling: 100 }).then(() => true, () => false);

// ---------- Ein Viewport ----------
async function runViewport(browser, { vp, url, expected_domain, findings, timeoutMs, allowHosts, contextOptions, screenshotDir, navigation = true }) {
  const viewport = VIEWPORTS[vp];
  const context = await browser.newContext({ ...contextOptions, viewport: { width: viewport.width, height: viewport.height }, isMobile: vp === "mobile", hasTouch: vp === "mobile",
    deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: "block", locale: "de-CH", javaScriptEnabled: true });
  const out = { viewport: vp, width: viewport.width, height: viewport.height, load_ok: false, status: null, final_same_domain: null, redirected_cross_domain: false,
    metrics: null, overflow: null, critical: null, nav: { links_visible: 0, menu_toggle: false, menu_toggle_used: false, targets_checked: 0, targets_ok: 0, targets_failed: 0 },
    images: null, console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0, errors_ignored: 0 },
    network: { failed_same_site: 0, failed_cross_site: 0, entries: [] }, fingerprints: null, findings: [], blocked_requests: 0, blocked_hosts: 0, interactions: [], screenshots: 0 };
  const failed = [], imageStatus = new Map();
  let lastDoc = null;
  try {
    // Guard: nur GET/HEAD verlassen den Browser. Jede andere Methode (Formular, Login, Bestellung, Upload …) wird abgebrochen.
    // allowHosts (Tests/Lab): nur diese Hosts sind erreichbar – jede andere Adresse wird im Browser abgebrochen.
    await context.route("**/*", async (route, request) => {
      if (!["GET", "HEAD"].includes(request.method())) {
        out.blocked_requests++;
        // TF-046: Navigation (z. B. Formular-Submit) nie absenden, aber auch keine Fehlerseite committen: ein abort() liesse Chromium
        // auf chrome-error:// wechseln (falsches «cross_domain_redirect», zerstörter JS-Kontext mitten in der Messung). 204 lokal
        // beantwortet = der Browser bleibt auf der Seite, der Server sieht nichts.
        if (request.isNavigationRequest()) return route.fulfill({ status: 204, body: "" }).catch(() => {});
        return route.abort("blockedbyclient").catch(() => {});
      }
      if (allowHosts && /^https?:/.test(request.url()) && !allowHosts.includes(hostOf(request.url()))) { out.blocked_hosts++; return route.abort("blockedbyclient").catch(() => {}); }
      return route.continue().catch(() => {});
    });
    const page = await context.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("popup", (p) => p.close().catch(() => {}));
    page.on("pageerror", (e) => { out.console.page_errors++; const k = String(e?.name || "Error").replace(/[^A-Za-z]/g, "").slice(0, 30) || "Error"; if (!out.console.page_error_kinds.includes(k) && out.console.page_error_kinds.length < 5) out.console.page_error_kinds.push(k); });
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const c = classifyConsoleSource(m.location()?.url || "", expected_domain);
      if (c === "same_site") out.console.errors_same_site++; else if (c === "third_party") out.console.errors_third_party++; else out.console.errors_ignored++;
    });
    page.on("response", (r) => {
      const req = r.request(), st = r.status();
      if (req.resourceType() === "image") imageStatus.set(pathOf(r.url()), st);
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) lastDoc = { status: st, url: r.url() }; // letzte Dokument-Antwort (nach Redirects)
      if (st >= 400 && pathOf(r.url()) !== "/favicon.ico") failed.push({ url: r.url(), status: st, resource_type: req.resourceType() });
    });
    page.on("requestfailed", (req) => { if (!/blocked_?by_?client/i.test(req.failure()?.errorText || "")) failed.push({ url: req.url(), status: null, resource_type: req.resourceType() }); });

    out.interactions.push("open_page");
    let resp;
    // TF-046: goto nur bis zum Commit des Dokuments, danach auf dessen load-Event warten. Startet die Seite beim Laden selbst eine
    // (vom Guard blockierte) Navigation, würde goto(waitUntil: "load") auf diese nie committende Navigation warten (Timeout).
    try { resp = await page.goto(url, { waitUntil: "commit", timeout: timeoutMs }); }
    catch { out.error = "load_failed"; return finish(); }
    if (!(await documentLoaded(page, timeoutMs))) { out.error = "load_failed"; return finish(); }
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    out.status = resp ? resp.status() : null;
    const finalHost = hostOf(page.url());
    out.final_same_domain = sameDomain(finalHost, expected_domain);
    out.redirected_cross_domain = !out.final_same_domain;
    out.load_ok = !!resp && out.status < 400;
    if (out.redirected_cross_domain) { out.error = "cross_domain_redirect"; return finish(); } // nur feststellen, nie weiter interagieren
    if (!out.load_ok) return finish();

    const broken = [...new Set(findings.map((f) => f.broken_path).filter(Boolean))];
    const expected = [...new Set(findings.map((f) => f.expected_path).filter(Boolean))];
    out.interactions.push("measure_overflow");
    const probeArg = { broken, expected, tolerance: OVERFLOW_TOLERANCE_PX };
    let probe = await evaluateStable(page, browserProbeScript, probeArg);
    // Hat die Seite währenddessen auf eine fremde Domain navigiert: nur feststellen, nie weiter interagieren.
    if (!sameDomain(hostOf(page.url()), expected_domain)) { out.final_same_domain = false; out.redirected_cross_domain = true; out.error = "cross_domain_redirect"; return finish(); }
    let navVisible = probe.nav_links.length;
    out.nav.menu_toggle = probe.menu_toggles > 0;
    // Navigation bedienbar: ist sie (z. B. auf dem Smartphone) eingeklappt, wird NUR der Menü-Button geöffnet – sonst nichts.
    if (navigation && !navVisible && probe.menu_toggles > 0) {
      const t = await locateElement(page, { kind: "toggle" });
      if (t && isSafeClickTarget(t.desc)) {
        await t.el.click({ timeout: 5000 }).then(() => { out.nav.menu_toggle_used = true; out.interactions.push("open_navigation"); }, () => {});
        await page.waitForTimeout(300);
        const again = await evaluateStable(page, browserProbeScript, probeArg);
        navVisible = again.nav_links.length;
        probe = { ...probe, nav_links: again.nav_links };
      }
    }
    out.nav.links_visible = navVisible;
    out.metrics = { scroll_width: probe.scroll_width, viewport_width: probe.viewport_width, doc_height: probe.doc_height, text_length: probe.text_length };
    const px = Math.max(0, probe.scroll_width - probe.viewport_width);
    out.overflow = { horizontal: px > OVERFLOW_TOLERANCE_PX, px, offscreen_elements: probe.offscreen_elements, images_over_viewport: probe.images_over_viewport, clipped_text: probe.clipped_text };
    out.critical = { ...probe.critical, body_visible: probe.body_visible };
    out.images = { visible: probe.images_visible, broken: probe.images_broken, broken_paths: probe.broken_image_paths.slice(0, 10) };
    out.fingerprints = Object.fromEntries(Object.entries(probe.signatures).map(([k, v]) => [k, v ? short(v) : null]));
    if (screenshotDir) { await page.screenshot({ path: path.join(screenshotDir, `${vp}-${crypto.randomBytes(4).toString("hex")}.png`) }).then(() => { out.screenshots++; }, () => {}); }

    // Navigationsziele (gleiche Domain, keine geschützten Pfade) in einer eigenen Seite desselben Kontexts öffnen – nur lesen.
    if (navigation) {
      const here = pathOf(page.url());
      const targets = [...new Set(probe.nav_links.filter((l) => sameDomain(l.host, expected_domain) && l.path !== here && !PROTECTED_INTERACTION_RE.test(l.path)).map((l) => l.path))].slice(0, MAX_NAV_TARGETS);
      for (const p of targets) {
        out.nav.targets_checked++;
        out.interactions.push("check_navigation_target");
        const r = await openTarget(context, new URL(p, page.url()).href, expected_domain, timeoutMs);
        if (r.ok) out.nav.targets_ok++; else out.nav.targets_failed++;
      }
    }

    // Befund-spezifische Prüfung (nur allowlisted: Bild prüfen, Ziel-URL prüfen, reparierten Link anklicken – zuletzt, da er navigiert).
    const results = [];
    let clickLater = null;
    let auditProbe = null; // TF-JARVIS-PRAXIS-002: gleiche Messung wie der Browser-Audit (Sprungmarken, abgeschnittene Bereiche)
    for (const f of findings) {
      const b = f.broken_path ? probe.findings.broken[f.broken_path] || { links: 0, images: 0 } : null;
      const e = f.expected_path ? probe.findings.expected[f.expected_path] : null;
      const r = { type: f.type, page_path: pathOf(url), ok: null, present: null, code: null, checks: {} };
      if (f.type === "broken_link" || f.type === "contact_page_broken" || f.type === "navigation_broken") {
        r.present = b ? b.links > 0 : null;
        if (f.type === "navigation_broken") { r.checks.nav_visible = navVisible > 0; r.checks.nav_targets_ok = out.nav.targets_failed === 0; }
        if (b) r.checks.broken_reference_gone = b.links === 0;
        if (e) { r.checks.link_present = e.links > 0; if (e.links > 0 && !clickLater) clickLater = { finding: r, path: f.expected_path, same_domain_expected: f.same_domain_expected !== false }; }
        r.ok = Object.values(r.checks).every((v) => v === true) && (r.present !== true);
      } else if (f.type === "broken_image") {
        r.present = b ? b.images > 0 : null;
        if (b) r.checks.broken_reference_gone = b.images === 0;
        if (e) {
          out.interactions.push("verify_image");
          const st = imageStatus.get(f.expected_path);
          Object.assign(r.checks, { image_present: e.images > 0, image_visible: e.images_visible > 0, image_loaded: e.images_loaded > 0 && e.images_loaded === e.images, request_ok: st == null ? e.images_loaded > 0 : st < 400 });
        }
        r.ok = Object.values(r.checks).every((v) => v === true) && r.present !== true;
      } else if (/overflow|cut_off|layout/.test(f.type)) {
        r.present = out.overflow.horizontal;
        r.checks.no_horizontal_overflow = !out.overflow.horizontal;
        r.ok = f.type === "mobile_overflow" && vp !== "mobile" ? true : !out.overflow.horizontal;
      } else if (BROWSER_AUDIT_TYPES.includes(f.type)) {
        if (f.type !== "js_runtime_error") auditProbe ||= await evaluateStable(page, siteAuditProbe).catch(() => null);
        if (f.type === "js_runtime_error") { r.present = out.console.page_errors > 0; r.checks.no_page_errors = !r.present; r.ok = !r.present; }
        else if (!auditProbe) { r.ok = null; r.code = "probe_failed"; }
        else if (f.type === "broken_anchor") { r.present = !!f.anchor && auditProbe.anchors.some((a) => a.anchor === f.anchor); r.checks.anchor_target_exists = !!f.anchor && !r.present; r.ok = r.checks.anchor_target_exists; }
        else { r.present = auditProbe.clipped.length > 0; r.checks.no_clipped_content = !r.present; r.ok = !r.present; }
      } else { r.ok = null; r.code = "no_specific_check"; }
      if (r.ok === false) r.code = r.code || "finding_unresolved";
      results.push(r);
    }
    if (clickLater && findings.some((f) => f.phase === "after")) { // nur nach der Reparatur – Baseline/Rollback klicken nie
      const r = clickLater.finding;
      const loc = await locateElement(page, { kind: "link", path: clickLater.path });
      let nav = null;
      if (loc && isSafeClickTarget(loc.desc) && !loc.desc.target_blank) {
        out.interactions.push("click_repaired_link");
        // Erfolg = URL wechselt UND die letzte Dokument-Antwort des Hauptframes (nach Redirects) ist < 400.
        const before = page.url();
        lastDoc = null;
        await loc.el.click({ timeout: 5000 }).catch(() => {});
        await page.waitForURL((u) => u.href !== before, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
        const moved = page.url() !== before;
        // Vorab geladene Seiten (Speculation Rules/Prefetch, z. B. WordPress ≥ 6.8) liefern kein Response-Event → Status aus der
        // Navigation-Timing-API des Browsers (nur lesend).
        const status = lastDoc ? lastDoc.status : moved ? await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.responseStatus || null).catch(() => null) : null;
        nav = { ok: moved && status != null && status > 0 && status < 400, host: hostOf(page.url()), status };
      } else if (loc && isSafeClickTarget(loc.desc)) {
        out.interactions.push("verify_target_url");
        const t = await openTarget(context, new URL(clickLater.path, url).href, expected_domain, timeoutMs);
        nav = { ok: t.ok, host: t.host, status: t.status };
      } else if (!loc) {
        // Link nicht sichtbar (z. B. eingeklappter Bereich) – Ziel-URL direkt prüfen, nichts anklicken.
        out.interactions.push("verify_target_url");
        const t = await openTarget(context, new URL(clickLater.path, url).href, expected_domain, timeoutMs);
        nav = { ok: t.ok, host: t.host, status: t.status };
      } else { r.checks.safe_click = false; }
      if (nav) {
        r.checks.target_loads = nav.ok;
        r.checks.target_same_domain = sameDomain(nav.host, expected_domain);
        if (!r.checks.target_same_domain) { r.code = "cross_domain_redirect"; if (!clickLater.same_domain_expected) r.checks.target_same_domain = true; }
      }
      r.ok = Object.values(r.checks).every((v) => v === true) && r.present !== true;
      if (r.ok === false && !r.code) r.code = "finding_unresolved";
    }
    out.findings = results;
    return finish();
  } finally {
    await context.close().catch(() => {}); // Cookies/Storage verschwinden mit dem Kontext
  }

  function finish() {
    for (const f of failed) {
      const same = sameSite(hostOf(f.url), expected_domain);
      if (same) out.network.failed_same_site++; else out.network.failed_cross_site++;
      if (out.network.entries.length < MAX_ENTRIES) out.network.entries.push({ url: sanitizeUrl(f.url), status: f.status, resource_type: String(f.resource_type || "other").slice(0, 20), same_domain: same });
    }
    return out;
  }
}

// Navigationsziel / Ziel-URL in eigener Seite öffnen (nur GET über den Guard), Ergebnis: lädt? gleiche Domain?
async function openTarget(context, url, expected_domain, timeoutMs) {
  const p = await context.newPage();
  try {
    const r = await p.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null);
    const host = hostOf(p.url());
    return { ok: !!r && r.status() < 400 && sameDomain(host, expected_domain), host, status: r ? r.status() : null };
  } finally { await p.close().catch(() => {}); }
}

// ---------- VORHER/NACHHER-Vergleich (nur sichere Signale) ----------
const EMPTY = Object.freeze({ load_ok: true, redirected_cross_domain: false, overflow: { px: 0, offscreen_elements: 0, images_over_viewport: 0, clipped_text: 0 },
  critical: { header: true, nav: true, main: true, footer: true, hero: false, cta: false, main_covered: false }, nav: { links_visible: 1, targets_failed: 0 },
  images: { broken: 0 }, console: { page_errors: 0, page_error_kinds: [], errors_same_site: 0, errors_third_party: 0 }, network: { entries: [] }, metrics: { doc_height: 0, text_length: 1 } });
export function compareViewport(before, after) {
  const b = before || EMPTY, a = after || {};
  const items = [];
  const add = (code, level) => items.push({ code, level });
  if (!a.load_ok || a.error === "load_failed") add("page_not_loading", "HIGH");
  if (a.redirected_cross_domain && !b.redirected_cross_domain) add("cross_domain_redirect", "HIGH");
  if (!a.load_ok || a.redirected_cross_domain) return summarize(items);
  const ac = a.critical || {}, bc = b.critical || {};
  if ((bc.main || (b.metrics?.text_length || 0) > 20) && !ac.main && (a.metrics?.text_length || 0) < 20) add("main_content_missing", "HIGH");
  if (!ac.body_visible && ac.body_visible !== undefined) add("page_blank", "HIGH");
  if ((b.nav?.links_visible || 0) > 0 && (a.nav?.links_visible || 0) === 0) add("navigation_broken", "HIGH");
  else if ((a.nav?.targets_failed || 0) > (b.nav?.targets_failed || 0)) add("navigation_partially_broken", a.nav.targets_ok === 0 ? "HIGH" : "MEDIUM");
  const newErr = (a.console?.page_errors || 0) > (b.console?.page_errors || 0) || (a.console?.page_error_kinds || []).some((k) => !(b.console?.page_error_kinds || []).includes(k));
  if (newErr) add("new_js_error", "HIGH");
  if ((a.console?.errors_same_site || 0) > (b.console?.errors_same_site || 0)) add("new_same_site_console_error", "MEDIUM");
  if ((a.console?.errors_third_party || 0) > (b.console?.errors_third_party || 0)) add("new_third_party_console_error", "LOW");
  const grow = (a.overflow?.px || 0) - (b.overflow?.px || 0);
  if (grow > OVERFLOW_TOLERANCE_PX) add(a.overflow.px >= MASSIVE_OVERFLOW_PX ? "massive_overflow" : "new_overflow", a.overflow.px >= MASSIVE_OVERFLOW_PX ? "HIGH" : "MEDIUM");
  if ((a.overflow?.offscreen_elements || 0) > 0 && !(b.overflow?.offscreen_elements > 0)) add("element_outside_viewport", "MEDIUM");
  if ((a.overflow?.images_over_viewport || 0) > (b.overflow?.images_over_viewport || 0)) add("image_over_viewport", "MEDIUM");
  if ((a.overflow?.clipped_text || 0) > (b.overflow?.clipped_text || 0)) add("text_clipped", "MEDIUM");
  // Neu kaputte Bilder: über die Anzahl UND die Pfade (ein repariertes + ein neu kaputtes Bild ergäbe sonst «gleich viele»).
  const beforePaths = new Set(b.images?.broken_paths || []);
  const imgs = Math.max((a.images?.broken || 0) - (b.images?.broken || 0), (a.images?.broken_paths || []).filter((p) => !beforePaths.has(p)).length);
  if (imgs >= 2) add("images_broken", "HIGH"); else if (imgs === 1) add("image_broken", "MEDIUM");
  for (const k of ["header", "nav", "footer"]) if (bc[k] && ac[k] === false) add(`${k}_missing`, k === "nav" ? "HIGH" : "MEDIUM");
  if (ac.main_covered === true && bc.main_covered !== true) add("main_covered", "MEDIUM");
  for (const k of ["hero", "cta"]) if (bc[k] && ac[k] === false) add(`${k}_missing`, "LOW");
  const seen = new Set((b.network?.entries || []).map((e) => `${e.url}|${e.status}`));
  const fresh = (a.network?.entries || []).filter((e) => !seen.has(`${e.url}|${e.status}`));
  if (fresh.some((e) => e.same_domain)) add("new_same_site_request_error", "MEDIUM");
  if (fresh.some((e) => !e.same_domain)) add("new_cross_site_request_error", "LOW");
  if (b.fingerprints && a.fingerprints) for (const k of ["header", "nav", "footer"]) if (b.fingerprints[k] && a.fingerprints[k] && b.fingerprints[k] !== a.fingerprints[k]) add(`${k}_structure_changed`, "LOW");
  for (const f of a.findings || []) if (f.ok === false) add(f.code === "cross_domain_redirect" ? "unexpected_redirect" : "finding_unresolved", "HIGH");
  // Massive Layout-Verschiebung ohne erklärenden Fehler → visuell nicht eindeutig → MANUAL_REVIEW.
  const bh = b.metrics?.doc_height || 0, ah = a.metrics?.doc_height || 0;
  // (Eine behobene Überbreite verändert die Höhe erwartungsgemäss – dann kein Zweifelsfall.)
  const unclear = bh > 0 && Math.abs(ah - bh) / bh > 0.5 && !((b.overflow?.px || 0) > OVERFLOW_TOLERANCE_PX && (a.overflow?.px || 0) <= OVERFLOW_TOLERANCE_PX);
  if (unclear) add("massive_layout_shift", "LOW");
  return summarize(items, unclear);
}
function summarize(items, unclear = false) {
  const level = maxLevel(...items.map((i) => i.level));
  return { level, unclear: unclear && !["MEDIUM", "HIGH"].includes(level), items: items.slice(0, 20) };
}

// Entscheidung für eine Seite (beide Viewports). verdict: PASS | ROLLBACK | MANUAL_REVIEW.
export function gateDecision(pageResult = {}) {
  const d = compareViewport(pageResult.before?.desktop || null, pageResult.desktop);
  const m = compareViewport(pageResult.before?.mobile || null, pageResult.mobile);
  const level = maxLevel(d.level, m.level);
  const unclear = d.unclear || m.unclear;
  const desktop_ok = ACCEPTABLE_LEVELS.includes(d.level) && pageResult.desktop?.load_ok === true;
  const mobile_ok = ACCEPTABLE_LEVELS.includes(m.level) && pageResult.mobile?.load_ok === true;
  const verdict = !ACCEPTABLE_LEVELS.includes(level) || !desktop_ok || !mobile_ok ? "ROLLBACK" : unclear ? "MANUAL_REVIEW" : "PASS";
  return { verdict, level, unclear, desktop_ok, mobile_ok, desktop: d, mobile: m };
}
// Mehrere Seiten zusammenfassen.
export function combineDecisions(list = []) {
  if (!list.length) return { verdict: "MANUAL_REVIEW", level: "NONE", unclear: true, desktop_ok: false, mobile_ok: false, codes: ["no_pages_checked"] };
  const level = maxLevel(...list.map((x) => x.level));
  const codes = [...new Set(list.flatMap((x) => [...x.desktop.items, ...x.mobile.items].filter((i) => i.level !== "NONE").map((i) => `${i.level}:${i.code}`)))].slice(0, 20);
  const verdict = list.some((x) => x.verdict === "ROLLBACK") ? "ROLLBACK" : list.some((x) => x.verdict === "MANUAL_REVIEW") ? "MANUAL_REVIEW" : "PASS";
  return { verdict, level, unclear: list.some((x) => x.unclear), desktop_ok: list.every((x) => x.desktop_ok), mobile_ok: list.every((x) => x.mobile_ok), codes };
}
// Rollback bestätigt den Ausgangszustand: keine Regression gegenüber VORHER (≤ LOW) und jeder Befund ist wieder wie vorher.
export function rollbackMatchesBaseline(baselinePage = {}, rolledBack = {}) {
  for (const vp of ["desktop", "mobile"]) {
    const c = compareViewport(baselinePage[vp] || null, { ...(rolledBack[vp] || {}), findings: [] });
    if (!ACCEPTABLE_LEVELS.includes(c.level) || rolledBack[vp]?.load_ok !== true) return false;
    const before = (baselinePage[vp]?.findings || []).map((f) => f.present);
    const after = (rolledBack[vp]?.findings || []).map((f) => f.present);
    if (before.length && JSON.stringify(before) !== JSON.stringify(after)) return false;
  }
  return true;
}

// ---------- Validator ----------
// launch() → Playwright-Browser (Chromium). allowHosts (nur Tests/Lab): ausschliesslich diese Hosts sind erreichbar.
// contextOptions (nur Lab): z. B. ignoreHTTPSErrors für die lokale Test-CA – im Produktivbetrieb leer (echte TLS-Prüfung).
// validate({ url, expected_domain, findings, before_snapshot, validation_scope, phase }) →
//   { url (bereinigt), phase, desktop, mobile, before, decision?, screenshots: { created, deleted } }
export function createBrowserValidator({ launch, allowHosts = null, contextOptions = {}, timeoutMs = 30_000, screenshots = false } = {}) {
  if (typeof launch !== "function") throw new Error("launch erforderlich.");
  async function validate({ url, expected_domain, findings = [], before_snapshot = null, validation_scope = {}, phase = "after" } = {}) {
    if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("URL erforderlich.");
    const expected = normDomain(expected_domain || hostOf(url));
    const scope = { desktop: true, mobile: true, navigation: true, ...validation_scope };
    const fs_ = findings.map((f) => ({ type: String(f.type || ""), broken_path: f.broken_path || null, expected_path: f.expected_path || null,
      same_domain_expected: f.same_domain_expected !== false, phase, ...(typeof f.anchor === "string" ? { anchor: f.anchor.slice(0, 80) } : {}) }));
    const shotDir = screenshots ? fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-shot-")) : null;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chromium-"));
    let browser = null, out = null, created = 0;
    try {
      browser = await launch({ home });
      out = { url: sanitizeUrl(url), expected_domain: expected, phase, desktop: null, mobile: null };
      for (const vp of ["desktop", "mobile"]) {
        if (!scope[vp]) continue;
        out[vp] = await runViewport(browser, { vp, url, expected_domain: expected, findings: fs_, timeoutMs, allowHosts, contextOptions, screenshotDir: shotDir, navigation: scope.navigation });
      }
      if (before_snapshot) { out.before = before_snapshot; out.decision = gateDecision(out); }
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (shotDir) { try { created = fs.readdirSync(shotDir).length; } catch {} fs.rmSync(shotDir, { recursive: true, force: true }); }
      fs.rmSync(home, { recursive: true, force: true });
    }
    // Screenshots nur temporär: Anzahl erzeugt + Beweis, dass das Verzeichnis gelöscht ist (nie ein Pfad im Ergebnis).
    out.screenshots = { created, deleted: !shotDir || !fs.existsSync(shotDir) };
    return out;
  }
  return { method: BROWSER_METHOD, validate };
}

// Gespeicherter Schnappschuss (für order.browser_baseline): nur die Vergleichs-Signale, keine Netzwerk-URLs der Fremd-Hosts.
export function safeSnapshot(vpResult) {
  if (!vpResult) return null;
  const { viewport, load_ok, status, final_same_domain, redirected_cross_domain, metrics, overflow, critical, nav, images, console: c, network, fingerprints, findings, error } = vpResult;
  return { viewport, load_ok, status, final_same_domain, redirected_cross_domain, metrics, overflow, critical, nav, images, console: c,
    network: { failed_same_site: network?.failed_same_site || 0, failed_cross_site: network?.failed_cross_site || 0, entries: (network?.entries || []).slice(0, MAX_ENTRIES) },
    fingerprints, findings: (findings || []).map((f) => ({ type: f.type, ok: f.ok, present: f.present, code: f.code, checks: Object.fromEntries(Object.entries(f.checks || {}).filter(([, v]) => typeof v === "boolean")) })), ...(error ? { error } : {}) };
}

// ---------- Laufzeit (Produktion) ----------
const require = createRequire(import.meta.url);
export const CHROMIUM_ARGS = Object.freeze(["--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--disable-extensions", "--disable-background-networking",
  "--disable-sync", "--disable-crash-reporter", "--disable-breakpad", "--mute-audio", "--no-default-browser-check"]);
const SYSTEM_CHROMIUM = ["/usr/bin/chromium-browser", "/usr/bin/chromium"];
export function chromiumExecutable() {
  const env = process.env.JARVIS_CHROMIUM_PATH;
  if (env && fs.existsSync(env)) return env;
  try { const p = require("playwright-core").chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch {}
  return SYSTEM_CHROMIUM.find((p) => fs.existsSync(p)) || null;
}
// Synchron und ohne Browserstart – für Dashboard/Registry: Bibliothek + ausführbares Chromium vorhanden?
export function browserRuntimeStatus() {
  let library = false; try { require.resolve("playwright-core"); library = true; } catch {}
  const exe = library ? chromiumExecutable() : null;
  return { library, chromium: !!exe, status: library && exe ? "ACTIVE" : "UNAVAILABLE" };
}
// extraArgs nur für Tests/Lab (z. B. --host-resolver-rules: Testdomains → 127.0.0.1, alles andere ~NOTFOUND).
export function chromiumLauncher({ executablePath = chromiumExecutable(), extraArgs = [] } = {}) {
  const pw = require("playwright-core");
  return ({ home } = {}) => pw.chromium.launch({ headless: true, executablePath, args: [...CHROMIUM_ARGS, ...extraArgs],
    env: { ...process.env, HOME: home || os.tmpdir(), XDG_CONFIG_HOME: home || os.tmpdir(), XDG_CACHE_HOME: home || os.tmpdir() } });
}
// Echten Validator laden: Bibliothek + Chromium vorhanden UND ein Probe-Start klappt – sonst null (der Workflow ist dann fail closed).
export async function loadBrowserValidator({ timeoutMs = 30_000 } = {}) {
  const rt = browserRuntimeStatus();
  if (rt.status !== "ACTIVE") return null;
  const launch = chromiumLauncher();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chromium-"));
  try { const b = await launch({ home }); await b.close(); } catch { return null; } finally { fs.rmSync(home, { recursive: true, force: true }); }
  return createBrowserValidator({ launch, timeoutMs });
}
