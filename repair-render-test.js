// Echter Browser-Rendertest (Playwright) für CHECK & REPARATUR (TF-036): Desktop 1440×900 + Smartphone 390×844.
// NUR LESEND – lädt die Seite wie ein Besucher, klickt nichts, füllt nichts aus, sendet nichts, speichert keine Screenshots.
// Geprüft wird je Viewport: Seite lädt und ist sichtbar, kein horizontaler Overflow, keine abgeschnittenen Hauptinhalte,
// keine überlappenden Navigationseinträge, sichtbare Bilder geladen. Zusätzlich (nur informativ, nie ein Fail-Grund,
// um keine funktionierende Reparatur an einer Design-Eigenheit scheitern zu lassen): Buttons/Links/Kontaktbereich vorhanden.
// Ist Playwright nicht installiert, liefert loadRenderRetester() null – die State-Machine nutzt dann die passive Prüfung
// und benennt das ehrlich im Bericht.
export const VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900, label: "Desktop 1440×900" }),
  mobile: Object.freeze({ width: 390, height: 844, label: "Smartphone 390×844" }),
});
export const RENDER_METHOD = "Playwright Rendertest (Desktop 1440×900, Smartphone 390×844)";

// Läuft im Seitenkontext (page.evaluate) – reine DOM-Lesung, keine Interaktion. Als eigenständige Funktion testbar.
export function pageChecksScript() {
  const vw = window.innerWidth;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const problems = [];
  if (!document.body || (document.body.innerText || "").trim().length < 10) problems.push("Seite ohne sichtbaren Inhalt geladen");
  if (document.documentElement.scrollWidth > vw + 1) problems.push(`Horizontaler Overflow (${document.documentElement.scrollWidth}px Inhalt bei ${vw}px Breite)`);
  // Abgeschnittene Hauptinhalte: sichtbare Block-Elemente, die rechts deutlich aus dem Viewport ragen (fixe Deko ausgenommen).
  const cut = [...document.querySelectorAll("main *, header *, nav *, section *, article *, footer *")].slice(0, 1500)
    .filter((el) => visible(el) && getComputedStyle(el).position !== "fixed" && el.getBoundingClientRect().right > vw + 8 && el.getBoundingClientRect().left < vw);
  if (cut.length) problems.push(`${cut.length} Element(e) ragen rechts aus dem sichtbaren Bereich`);
  // Überlappende Hauptnavigation: sichtbare Nav-Links, deren Flächen sich deutlich überschneiden.
  const navLinks = [...document.querySelectorAll("nav a, header a")].filter(visible).slice(0, 20).map((a) => a.getBoundingClientRect());
  let overlaps = 0;
  for (let i = 0; i < navLinks.length; i++) for (let j = i + 1; j < navLinks.length; j++) {
    const a = navLinks[i], b = navLinks[j];
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (x > 4 && y > 4 && x * y > 0.5 * Math.min(a.width * a.height, b.width * b.height)) overlaps++;
  }
  if (overlaps) problems.push(`${overlaps} überlappende Navigationseinträge`);
  const imgs = [...document.querySelectorAll("img")].filter(visible);
  const brokenImgs = imgs.filter((i) => i.complete && i.naturalWidth === 0).length;
  if (brokenImgs) problems.push(`${brokenImgs} sichtbare(s) Bild(er) nicht geladen`);
  const info = {
    links: document.querySelectorAll("a[href]").length,
    buttons: document.querySelectorAll("button, [role=button], input[type=submit], a.button, a.btn").length,
    images_visible: imgs.length,
    contact_found: /kontakt|contact|contatto/i.test(document.body?.innerText || "") || !!document.querySelector('a[href^="mailto:"], a[href^="tel:"], a[href*="kontakt" i], a[href*="contact" i]'),
  };
  return { problems, info };
}

// Einen Viewport prüfen: Navigation + DOM-Checks. page = Playwright-Page (oder Attrappe im Test mit goto/setViewportSize/evaluate).
export async function checkViewport(page, url, viewport, { timeoutMs = 45_000 } = {}) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    status = resp ? resp.status() : null;
  } catch (e) {
    return { ok: false, viewport: viewport.label, problems: [`Seite nicht ladbar: ${String(e?.message || e).slice(0, 120)}`], info: null, status };
  }
  if (status != null && status >= 400) return { ok: false, viewport: viewport.label, problems: [`Seite antwortet mit HTTP ${status}`], info: null, status };
  const { problems, info } = await page.evaluate(pageChecksScript);
  return { ok: problems.length === 0, viewport: viewport.label, problems, info, status };
}

// Retester im Engine-Format: eine Funktion url → Ergebnis beider Viewports. browserFactory liefert { newPage, close }.
export function createRenderRetester({ browserFactory, timeoutMs = 45_000 } = {}) {
  if (typeof browserFactory !== "function") throw new Error("browserFactory erforderlich.");
  return async function retest(url) {
    const browser = await browserFactory();
    try {
      const page = await browser.newPage();
      const desktop = await checkViewport(page, url, VIEWPORTS.desktop, { timeoutMs });
      const mobile = await checkViewport(page, url, VIEWPORTS.mobile, { timeoutMs });
      return { ok: desktop.ok && mobile.ok, method: RENDER_METHOD, desktop, mobile };
    } finally { await browser.close().catch(() => {}); }
  };
}

// Playwright laden, falls installiert – sonst null (passive Prüfung übernimmt, ehrlich benannt). Nie ein harter Fehler.
export async function loadRenderRetester({ timeoutMs = 45_000 } = {}) {
  let pw = null;
  try { pw = await import("playwright"); } catch { return null; }
  if (!pw?.chromium) return null;
  try { const probe = await pw.chromium.launch({ headless: true }); await probe.close(); } catch { return null; }
  return createRenderRetester({
    timeoutMs,
    browserFactory: async () => {
      const browser = await pw.chromium.launch({ headless: true });
      return {
        newPage: async () => { const ctx = await browser.newContext(); return ctx.newPage(); },
        close: () => browser.close(),
      };
    },
  });
}
