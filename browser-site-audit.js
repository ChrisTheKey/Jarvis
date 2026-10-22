// BROWSER-AUDIT (TF-JARVIS-PRAXIS-002) – erkennt Fehler, die ein reiner HTTP-Abruf (site-auditor.js) nicht sehen kann, in einem
// ECHTEN Browser (Chromium über playwright-core) auf Desktop 1440×900, Tablet 768×1024 und Smartphone 390×844:
//
//   broken_anchor     Link auf eine Sprungmarke derselben Seite (#x), zu der es kein Element gibt – BESTÄTIGT durch einen Klick
//                     (die Seite bewegt sich nicht). Links mit eigener Skript-Logik (onclick, role=button, aria-controls …) zählen nicht.
//   content_clipped   Raster/Reihe (Grid, Flex ohne Umbruch), deren Elemente von einem Container mit overflow:hidden/clip zu mehr als
//                     der Hälfte abgeschnitten werden. Nicht gezählt: scrollbare Bereiche, Karussells/Slider, dekorative absolute
//                     Elemente, unsichtbare/Screenreader-Elemente.
//   js_runtime_error  Unbehandelter Laufzeitfehler eines Skripts derselben Website (Fremd-Skripte zählen nicht). Zusätzlich wird
//                     belegt, ob ein Inline-Skript nach einer id sucht, die es im DOM nicht gibt (missing_ids, Ursache).
//
// Nur PASSIV: GET/HEAD, keine Formulare, keine Eingaben; einziger Klick = Sprungmarken-Link derselben Seite (navigiert nicht).
// Ergebnis = Befunde im Format von site-auditor.js (type, url, evidence, severity, detectedAt, location, reproducible) + detail
// (nur Metadaten: Sprungmarke, Klassenname, Spaltenzahl, Fehlerart – nie Seitentexte ausser kurzen Beschriftungen).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AUDIT_VIEWPORTS = Object.freeze({
  desktop: { width: 1440, height: 900, label: "Desktop 1440×900" },
  tablet: { width: 768, height: 1024, label: "Tablet 768×1024" },
  mobile: { width: 390, height: 844, label: "Smartphone 390×844" },
});
export const BROWSER_AUDIT_TYPES = Object.freeze(["broken_anchor", "content_clipped", "js_runtime_error"]);
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const pathOf = (u) => { try { return new URL(u).pathname || "/"; } catch { return "/"; } };
const clean = (s, n = 80) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
// Fehlermeldungen: nur Art + kurze Meldung, ohne URLs/Query-Parameter.
export const cleanErrorMessage = (m) => clean(String(m || "").replace(/https?:\/\/\S+/g, "<url>"), 120);

// ---------- Messung im Seitenkontext (wird serialisiert – keine Closures) ----------
export function siteAuditProbe() {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0; };
  const label = (el) => (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60);
  // 1) Sprungmarken
  const here = location.origin + location.pathname + location.search;
  const anchors = {};
  for (const a of document.querySelectorAll("a[href]")) {
    let u; try { u = new URL(a.getAttribute("href"), location.href); } catch { continue; }
    if (u.origin + u.pathname + u.search !== here) continue;
    const h = u.hash;
    if (!h || h === "#" || /^#[!/]/.test(h)) continue;
    let id; try { id = decodeURIComponent(h.slice(1)); } catch { continue; }
    if (!id || id.toLowerCase() === "top") continue;
    if (document.getElementById(id) || document.getElementsByName(id).length) continue;
    if (a.hasAttribute("onclick") || a.getAttribute("role") === "button" || a.hasAttribute("aria-controls") || a.hasAttribute("data-toggle") || a.hasAttribute("data-bs-toggle")) continue;
    const e = anchors[id] || (anchors[id] = { anchor: id, links: 0, visible: 0, labels: [], in_header: false });
    e.links++;
    if (vis(a)) { e.visible++; if (a.closest("header, nav, [role=banner], [role=navigation]")) e.in_header = true; }
    const l = label(a); if (l && !e.labels.includes(l) && e.labels.length < 3) e.labels.push(l);
  }
  // 2) Abgeschnittene Raster/Reihen
  const vw = document.documentElement.clientWidth;
  const CAROUSEL = /carousel|slider|swiper|slick|splide|glide|marquee|ticker|scroller|slideshow/i;
  const rootHidden = ["html", "body"].some((t) => /hidden|clip/.test(getComputedStyle(document.querySelector(t)).overflowX));
  const flagged = [];
  const clipped = [];
  for (const g of document.querySelectorAll("body *")) {
    if (flagged.some((f) => f.contains(g))) continue;
    const s = getComputedStyle(g);
    const grid = /grid/.test(s.display), flex = /flex/.test(s.display) && s.flexWrap === "nowrap" && !/column/.test(s.flexDirection);
    if (!grid && !flex) continue;
    if (s.transform && s.transform !== "none") continue;
    const kids = [...g.children].filter((c) => { const cs = getComputedStyle(c); const r = c.getBoundingClientRect();
      return !/absolute|fixed/.test(cs.position) && cs.display !== "none" && cs.visibility !== "hidden" && r.width >= 4 && r.height >= 4
        && ((c.innerText || "").trim().length > 0 || !!c.querySelector("img, svg, video, picture")); });
    if (kids.length < 2) continue;
    // nächster Vorfahre (inkl. selbst), der horizontal abschneidet bzw. scrollt
    let clipEl = null, scrollable = false, carousel = false;
    for (let el = g; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      const es = getComputedStyle(el);
      if (CAROUSEL.test(`${el.className && typeof el.className === "string" ? el.className : ""} ${el.id} ${el.getAttribute("aria-roledescription") || ""}`)) { carousel = true; break; }
      if (/auto|scroll/.test(es.overflowX)) { scrollable = true; break; }
      if (/hidden|clip/.test(es.overflowX)) { clipEl = el; if (es.scrollSnapType && es.scrollSnapType !== "none") carousel = true; break; }
    }
    if (carousel || scrollable) continue;
    let left, right;
    if (clipEl) { const cr = clipEl.getBoundingClientRect(); left = cr.left; right = cr.right; if (rootHidden) { left = Math.max(left, 0); right = Math.min(right, vw); } }
    else if (rootHidden) { left = 0; right = vw; } else continue; // ohne Abschneiden: Überbreite der Seite (prüft der Validator)
    let hidden = 0, full = 0;
    for (const c of kids) {
      const r = c.getBoundingClientRect();
      const visW = Math.max(0, Math.min(r.right, right) - Math.max(r.left, left));
      const frac = visW / r.width;
      if (frac < 0.5) hidden++;
      if (frac < 0.05) full++;
    }
    if (!hidden) continue;
    flagged.push(g);
    const sec = g.closest("section, article, [id]") || g.parentElement;
    const head = sec ? sec.querySelector("h1, h2, h3") : null;
    clipped.push({ tag: g.tagName.toLowerCase(), id: g.id || null, class: (g.getAttribute("class") || "").slice(0, 300), display: s.display,
      columns: grid ? s.gridTemplateColumns.split(" ").filter(Boolean).length : null, children: kids.length, hidden, fully_hidden: full,
      min_child_px: Math.round(Math.min(...kids.map((c) => c.getBoundingClientRect().width))),
      location: (head ? label(head) : "") || (sec && sec.id) || "", clip_tag: clipEl ? clipEl.tagName.toLowerCase() : "html" });
  }
  // 3) Inline-Skripte, die nach einer id suchen, die es nicht gibt (Ursache für «null»-Laufzeitfehler)
  const refs = new Set();
  for (const sc of document.querySelectorAll("script:not([src])")) {
    const t = sc.textContent || "";
    for (const m of t.matchAll(/getElementById\(\s*(["'`])([^"'`]+)\1\s*\)/g)) refs.add(m[2]);
    for (const m of t.matchAll(/querySelector(?:All)?\(\s*(["'`])#([\w-]+)\1\s*\)/g)) refs.add(m[2]);
  }
  const missing_ids = [...refs].filter((id) => !document.getElementById(id)).slice(0, 10);
  return { anchors: Object.values(anchors).slice(0, 20), clipped: clipped.slice(0, 10), missing_ids, viewport_width: vw };
}

// Bestätigung per Klick: Seite oben, ersten sichtbaren Link auf #id anklicken – bewegt sich die Seite (Skript-Scroll), ist es kein Fehler.
function anchorClickScript(id) {
  window.scrollTo(0, 0);
  const a = [...document.querySelectorAll("a[href]")].find((x) => { try { const u = new URL(x.getAttribute("href"), location.href); const r = x.getBoundingClientRect();
    return u.hash === "#" + id || decodeURIComponent(u.hash.slice(1)) === id ? r.width > 0 && r.height > 0 && getComputedStyle(x).visibility !== "hidden" : false; } catch { return false; } });
  if (!a) return { clicked: false };
  const before = window.scrollY;
  a.click();
  return new Promise((res) => setTimeout(() => res({ clicked: true, moved: Math.abs(window.scrollY - before) > 40, hash: location.hash }), 700));
}

// ---------- Ein Viewport ----------
async function auditViewport(browser, { url, vp, timeoutMs, allowHosts, contextOptions }) {
  const v = AUDIT_VIEWPORTS[vp];
  const context = await browser.newContext({ ...contextOptions, viewport: { width: v.width, height: v.height }, isMobile: vp === "mobile", hasTouch: vp !== "desktop",
    deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: "block", locale: "de-CH", javaScriptEnabled: true });
  const out = { viewport: vp, load_ok: false, status: null, page_errors: [], probe: null, anchors_confirmed: {} };
  try {
    await context.route("**/*", (route, request) => {
      if (!["GET", "HEAD"].includes(request.method())) return request.isNavigationRequest() ? route.fulfill({ status: 204, body: "" }).catch(() => {}) : route.abort("blockedbyclient").catch(() => {});
      if (allowHosts && /^https?:/.test(request.url()) && !allowHosts.includes(hostOf(request.url()))) return route.abort("blockedbyclient").catch(() => {});
      return route.continue().catch(() => {});
    });
    const page = await context.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("popup", (p) => p.close().catch(() => {}));
    const pageHost = hostOf(url);
    page.on("pageerror", (e) => {
      // Fremd-Skripte (Stack zeigt nur auf andere Hosts) zählen nicht; Inline/gleiche Website schon.
      const hosts = [...String(e?.stack || "").matchAll(/https?:\/\/([^/:\s)]+)/g)].map((m) => m[1].toLowerCase());
      const sameSite = !hosts.length || hosts.some((h) => h === pageHost || h.endsWith("." + pageHost));
      if (sameSite && out.page_errors.length < 5) out.page_errors.push({ name: String(e?.name || "Error").replace(/[^A-Za-z]/g, "").slice(0, 30) || "Error", message: cleanErrorMessage(e?.message) });
    });
    let resp;
    try { resp = await page.goto(url, { waitUntil: "load", timeout: timeoutMs }); } catch { out.error = "load_failed"; return out; }
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    out.status = resp ? resp.status() : null;
    out.load_ok = !!resp && out.status < 400 && hostOf(page.url()) === pageHost;
    if (!out.load_ok) return out;
    out.final_url = page.url();
    out.probe = await page.evaluate(siteAuditProbe);
    for (const a of out.probe.anchors.filter((x) => x.visible > 0).slice(0, 5)) {
      const r = await page.evaluate(anchorClickScript, a.anchor).catch(() => ({ clicked: false }));
      out.anchors_confirmed[a.anchor] = r.clicked ? !r.moved : null; // true = Klick ohne Wirkung (bestätigt); null = nicht klickbar (nur DOM-Befund)
    }
    return out;
  } finally { await context.close().catch(() => {}); }
}

// ---------- Auswertung über alle Viewports → Befunde ----------
export function browserFindingsFrom(url, results, { now = () => new Date() } = {}) {
  const at = now().toISOString();
  const page = url, page_path = pathOf(url);
  const vpLabel = (vp) => AUDIT_VIEWPORTS[vp]?.label || vp;
  const ok = results.filter((r) => r.load_ok && r.probe);
  const issues = [];
  // Sprungmarken: Befund nur mit Klick-Bestätigung in mindestens einem Viewport (oder ohne sichtbaren Link: DOM-Befund in allen).
  const anchors = new Map();
  for (const r of ok) for (const a of r.probe.anchors) {
    const e = anchors.get(a.anchor) || { ...a, viewports: [], confirmed: false, refuted: false };
    e.viewports.push(r.viewport);
    if (r.anchors_confirmed[a.anchor] === true) e.confirmed = true;
    if (r.anchors_confirmed[a.anchor] === false) e.refuted = true;
    e.in_header = e.in_header || a.in_header; e.visible = Math.max(e.visible, a.visible);
    for (const l of a.labels) if (!e.labels.includes(l) && e.labels.length < 3) e.labels.push(l);
    anchors.set(a.anchor, e);
  }
  for (const e of anchors.values()) {
    if (e.refuted) continue; // Skript übernimmt den Sprung – kein Fehler (keine falsche Positivmeldung)
    if (!e.confirmed && e.viewports.length < ok.length) continue;
    const lbl = e.labels[0] || `#${e.anchor}`;
    issues.push({ type: "broken_anchor", url: page, page, severity: e.in_header ? "high" : "medium", detectedAt: at, reproducible: true, location: clean(lbl, 60), label: clean(lbl, 60),
      evidence: `Link «${clean(lbl, 60)}» verweist auf #${e.anchor}, auf der Seite gibt es kein Element mit dieser id/diesem Namen${e.confirmed ? "; Klick im Browser bewirkt nichts (Seite bleibt stehen)" : ""} (${e.viewports.map(vpLabel).join(", ")}).`,
      detail: { key: `anchor:${e.anchor}`, page_path, anchor: e.anchor, links: e.links, labels: e.labels, click_confirmed: e.confirmed, viewports: e.viewports } });
  }
  // Abgeschnittene Raster: gleiches Element (Klasse/id) über Viewports zusammenfassen.
  const clips = new Map();
  for (const r of ok) for (const c of r.probe.clipped) {
    const k = c.id ? `#${c.id}` : `${c.tag}.${c.class}`;
    const e = clips.get(k) || { ...c, per_vp: [] };
    e.per_vp.push({ viewport: r.viewport, hidden: c.hidden, children: c.children, fully_hidden: c.fully_hidden });
    e.fully_hidden = Math.max(e.fully_hidden, c.fully_hidden); e.min_child_px = Math.min(e.min_child_px, c.min_child_px);
    clips.set(k, e);
  }
  for (const e of clips.values()) {
    const loc = clean(e.location, 60) || "Inhaltsbereich";
    issues.push({ type: "content_clipped", url: page, page, severity: e.fully_hidden > 0 ? "high" : "medium", detectedAt: at, reproducible: true, location: loc,
      evidence: `Im Bereich «${loc}» werden Elemente abgeschnitten (${e.display}${e.columns ? `, ${e.columns} Spalten` : ""} in einem Container mit overflow:hidden): ${e.per_vp.map((p) => `${vpLabel(p.viewport)} ${p.hidden} von ${p.children} nicht sichtbar`).join("; ")}.`,
      detail: { key: `clip:${loc.toLowerCase()}`, page_path, element: { tag: e.tag, id: e.id, class: e.class }, display: e.display, columns: e.columns, min_child_px: e.min_child_px, per_viewport: e.per_vp } });
  }
  // Laufzeitfehler: in mindestens zwei unabhängigen Seitenaufrufen (Viewports) gleich → reproduzierbar.
  const errs = new Map();
  for (const r of ok) for (const pe of r.page_errors) { const k = `${pe.name}:${pe.message}`; const e = errs.get(k) || { ...pe, viewports: [] }; e.viewports.push(r.viewport); errs.set(k, e); }
  const missing = [...new Set(ok.flatMap((r) => r.probe.missing_ids))];
  for (const e of errs.values()) {
    const reproducible = e.viewports.length >= Math.min(2, ok.length);
    if (!reproducible) continue;
    const nullAccess = /null|undefined/i.test(e.message);
    issues.push({ type: "js_runtime_error", url: page, page, severity: "medium", detectedAt: at, reproducible: true, location: "Seitenskript",
      evidence: `Unbehandelter Laufzeitfehler beim Laden: ${e.name}: ${e.message} (${e.viewports.map(vpLabel).join(", ")})${nullAccess && missing.length ? `; Skript sucht nicht vorhandene Element-id(s): ${missing.join(", ")}` : ""}.`,
      detail: { key: `js:${e.name}:${e.message}`.slice(0, 120), page_path, name: e.name, message: e.message, missing_ids: nullAccess ? missing : [], viewports: e.viewports } });
  }
  return issues;
}

// ---------- Auditor ----------
// launch({ home }) → Playwright-Browser. audit(url) → { reachable, finalUrl, issues, viewports } (Befundformat wie site-auditor.js).
export function createBrowserSiteAuditor({ launch, viewports = Object.keys(AUDIT_VIEWPORTS), timeoutMs = 30_000, allowHosts = null, contextOptions = {}, now = () => new Date() } = {}) {
  if (typeof launch !== "function") throw new Error("launch erforderlich.");
  async function audit(url) {
    if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("URL erforderlich.");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-audit-"));
    let browser = null;
    const results = [];
    try {
      browser = await launch({ home });
      for (const vp of viewports) results.push(await auditViewport(browser, { url, vp, timeoutMs, allowHosts, contextOptions }));
    } finally {
      if (browser) await browser.close().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
    }
    const reachable = results.some((r) => r.load_ok);
    return { reachable, finalUrl: results.find((r) => r.final_url)?.final_url || null, issues: reachable ? browserFindingsFrom(url, results, { now }) : [],
      viewports: results.map((r) => ({ viewport: r.viewport, load_ok: r.load_ok, status: r.status, page_errors: r.page_errors.length, anchors: r.probe?.anchors.length || 0, clipped: r.probe?.clipped.length || 0 })) };
  }
  return { method: "Chromium Browser-Audit (Desktop 1440×900, Tablet 768×1024, Smartphone 390×844)", audit };
}

// HTTP-Auditor (site-auditor.js) + Browser-Auditor: Erreichbarkeit/HTML/Seitenzahl vom HTTP-Lauf, Browser-Befunde zusätzlich.
// Fällt der Browser-Lauf aus, gilt der Audit als nicht vollständig (reachable bleibt, browser_ok false) – nie stillschweigend weniger prüfen.
export function combineAuditors(httpAuditor, browserAuditor) {
  return {
    async audit(url) {
      const h = await httpAuditor.audit(url);
      if (!browserAuditor || h.reachable === false) return h;
      const b = await browserAuditor.audit(url).catch((e) => ({ error: String(e?.message || e).slice(0, 120), issues: [] }));
      return { ...h, issues: [...(h.issues || []), ...(b.issues || [])], browser_audit: { ok: !b.error && b.reachable !== false, viewports: b.viewports || [], ...(b.error ? { error: b.error } : {}) } };
    },
  };
}

// Produktivbetrieb: Chromium wie der Browser-Validator (repair-browser-validator.js); nicht startbar → null (fail closed beim Aufrufer).
export async function loadBrowserSiteAuditor({ timeoutMs = 30_000 } = {}) {
  const v = await import("./repair-browser-validator.js");
  if (v.browserRuntimeStatus().status !== "ACTIVE") return null;
  const launch = v.chromiumLauncher();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-chromium-"));
  try { const b = await launch({ home }); await b.close(); } catch { return null; } finally { fs.rmSync(home, { recursive: true, force: true }); }
  return createBrowserSiteAuditor({ launch, timeoutMs });
}
