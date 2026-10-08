// Passiver Website-Check für Jarvis – nur normale öffentliche Seitenaufrufe, wie ein Besucher mit dem Browser.
// Keine Formulare, keine Logins, keine Sicherheits- oder Portprüfungen. robots.txt wird beachtet, Anfragen sind gedrosselt.
// Jeder Befund trägt einen nachprüfbaren Beleg (type, url, evidence, severity, detectedAt) – ohne Beleg kein Befund.
export const UA = "Mozilla/5.0 (compatible; JarvisSiteCheck/1.0; Helvetic Webdesign)";
const TLS_RE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ALTNAME/i;
const SLOW_MS = 6000;
const MAX_BODY = 2_000_000;

const errCode = (e) => e?.cause?.code || e?.code || (e?.name === "AbortError" || e?.name === "TimeoutError" ? "TIMEOUT" : e?.message || "ERROR");
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
const decode = (v) => v?.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);
const attr = (tag, name) => decode(tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v !== undefined));
// Nur eindeutige Fehler zählen: 404/410 (fehlt) und 5xx (Serverfehler). 400/401/403/429 können Bot-Schutz sein.
const BROKEN = (status) => status === 404 || status === 410 || status >= 500;
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || [];
const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

// robots.txt: Regeln für „*“ bzw. JarvisSiteCheck; fehlt die Datei, ist alles erlaubt.
export function parseRobots(body = "") {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, value] = m;
    if (key.toLowerCase() === "user-agent") {
      if (!lastWasAgent) groups.push((cur = { agents: [], disallow: [], allow: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (cur) {
      lastWasAgent = false;
      if (key.toLowerCase() === "disallow" && value) cur.disallow.push(value);
      if (key.toLowerCase() === "allow" && value) cur.allow.push(value);
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a.includes("jarvissitecheck")));
  const rules = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const disallow = rules.flatMap((g) => g.disallow), allow = rules.flatMap((g) => g.allow);
  return (pathname) => {
    const d = Math.max(-1, ...disallow.filter((p) => pathname.startsWith(p)).map((p) => p.length));
    const a = Math.max(-1, ...allow.filter((p) => pathname.startsWith(p)).map((p) => p.length));
    return d < 0 || a >= d;
  };
}

export function createAuditor({ fetchFn = globalThis.fetch, delayMs = 1500, timeoutMs = 15_000, maxLinks = 10, maxImages = 6, now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {

  async function audit(website) {
    let requests = 0, last = 0;
    const issues = [];
    // extra (optional, nur intern): page = Seite, auf der der Fehler sichtbar ist; label = sichtbarer Linktext – für den einfachen Kundentext.
    const add = (type, url, evidence, severity, extra = {}) => issues.push({ type, url, evidence, severity, detectedAt: now().toISOString(), ...extra });

    // Höchstens eine Anfrage je delayMs an dieselbe Website.
    async function get(url, { redirect = "manual", body = true } = {}) {
      const wait = last + delayMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      requests++;
      const t0 = Date.now();
      try {
        const r = await fetchFn(url, { redirect, signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
        const type = r.headers.get("content-type") || "";
        const html = body && /html|text\/plain/i.test(type) ? (await r.text()).slice(0, MAX_BODY) : "";
        if (!html) await r.body?.cancel?.().catch(() => {});
        return { status: r.status, location: r.headers.get("location"), type, html, ms: Date.now() - t0, url: r.url || url };
      } catch (e) {
        return { error: errCode(e), ms: Date.now() - t0, url };
      }
    }

    // Weiterleitungen selbst verfolgen, damit Schleifen sichtbar werden.
    async function load(url) {
      const chain = [];
      let cur = url;
      for (let i = 0; i < 10; i++) {
        const r = await get(cur);
        if (r.error) return { ...r, url: cur, chain };
        if (r.status >= 300 && r.status < 400 && r.location) {
          chain.push(cur);
          const next = new URL(r.location, cur).href;
          if (chain.includes(next)) return { loop: true, url: next, chain: [...chain, next] };
          cur = next;
          continue;
        }
        return { ...r, url: cur, chain };
      }
      return { loop: true, url: cur, chain };
    }

    let host;
    try { host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase(); }
    catch { return { website, reachable: false, issues, pages: {}, requests, error: "ungültige Website-Adresse" }; }
    const result = (reachable, extra = {}) => ({ website, host, reachable, issues, requests, ...extra });

    // 1) Erreichbarkeit, HTTPS, Weiterleitungen
    const https = await load(`https://${host}/`);
    const tlsBad = !!(https.error && TLS_RE.test(https.error));
    if (tlsBad) add("https_certificate", `https://${host}/`, `TLS-Fehler beim Aufruf: ${https.error}`, "high");
    if (https.loop) add("redirect_loop", `https://${host}/`, `Weiterleitungsschleife: ${https.chain.join(" → ")}`, "high");
    let page = https.error || https.loop ? null : https;
    if (!page) {
      const http = await load(`http://${host}/`);
      if (http.loop) { if (!https.loop) add("redirect_loop", `http://${host}/`, `Weiterleitungsschleife: ${http.chain.join(" → ")}`, "high"); }
      else if (!http.error) {
        page = http;
        if (!tlsBad && !https.loop) add("no_https", `https://${host}/`, `HTTPS nicht erreichbar (${https.error}); Website nur unverschlüsselt über HTTP`, "medium");
      } else if (!https.loop) add("unreachable", `https://${host}/`, `Keine Antwort: HTTPS ${https.error}, HTTP ${http.error}`, "high");
    } else {
      const plain = await get(`http://${host}/`, { body: false });
      if (plain.status === 200) add("no_https_redirect", `http://${host}/`, "HTTP-Aufruf liefert die Seite ohne Weiterleitung auf HTTPS", "low");
    }
    if (!page) return result(false, { pages: {} });
    if (page.status >= 400) { add("http_error", page.url, `Startseite antwortet mit HTTP ${page.status}`, "high"); return result(true, { finalUrl: page.url, pages: {} }); }

    const origin = new URL(page.url).origin;
    const robotsRes = await get(`${origin}/robots.txt`);
    const allowed = parseRobots(robotsRes.status === 200 ? robotsRes.html : "");
    const html = page.html || "";

    if (page.ms > SLOW_MS) {
      const again = await get(page.url, { body: true });
      const best = Math.min(page.ms, again.error ? Infinity : again.ms);
      if (best > SLOW_MS) add("slow_response", page.url, `Ladezeit der Startseite ${(best / 1000).toFixed(1)} s (schnellster von 2 Abrufen)`, "medium");
    }

    // 2) Inhalt der Startseite
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    if (!title) add("missing_title", page.url, "Kein oder leerer <title> im HTML", "medium");
    const metas = tags(html, "meta");
    const meta = (name) => metas.find((m) => (attr(m, "name") || "").toLowerCase() === name);
    if (!(attr(meta("description") || "", "content") || "").trim()) add("missing_meta_description", page.url, "Keine Meta Description im HTML", "low");
    if (!meta("viewport")) add("no_mobile_viewport", page.url, "Kein viewport-Meta-Tag – Smartphones zeigen die Seite verkleinert in Desktop-Breite", "medium");
    if (!/<html\b[^>]*\slang\s*=\s*["']?[a-z]/i.test(html)) add("missing_lang", page.url, "Kein lang-Attribut am <html>-Element (Barrierefreiheit)", "low");
    const imgs = tags(html, "img");
    const noAlt = imgs.filter((t) => attr(t, "alt") === undefined).length;
    if (noAlt) add("missing_alt", page.url, `${noAlt} von ${imgs.length} Bildern ohne alt-Attribut (Barrierefreiheit)`, "low");
    if (origin.startsWith("https:")) {
      const insecure = [...tags(html, "img"), ...tags(html, "script"), ...tags(html, "iframe"), ...tags(html, "link").filter((t) => /stylesheet/i.test(attr(t, "rel") || ""))]
        .map((t) => attr(t, "src") || attr(t, "href") || "").filter((u) => /^http:\/\//i.test(u));
      if (insecure.length) add("mixed_content", page.url, `Unverschlüsselt eingebunden auf HTTPS-Seite: ${[...new Set(insecure)].slice(0, 3).join(", ")}`, "medium");
    }
    if (/<frameset\b/i.test(html)) add("outdated_technology", page.url, "Seite ist mit <frameset> aufgebaut", "medium");
    if (/<(object|embed)\b[^>]*\.swf/i.test(html)) add("outdated_technology", page.url, "Flash-Inhalt (.swf) eingebunden – wird von keinem Browser mehr angezeigt", "high");
    const gen = attr(meta("generator") || "", "content") || "";
    const wp = gen.match(/WordPress\s+(\d+)\.(\d+)/i), joomla = gen.match(/Joomla!?\s+(\d+)/i);
    if (wp && +wp[1] < 5) add("outdated_cms", page.url, `meta generator: ${gen}`, "medium");
    if (joomla && +joomla[1] < 4) add("outdated_cms", page.url, `meta generator: ${gen}`, "medium");
    const jq = html.match(/jquery[-.\/]?(\d)\.(\d+)(?:\.\d+)?(?:\.min)?\.js/i);
    if (jq && +jq[1] < 2) add("outdated_library", page.url, `jQuery ${jq[0].match(/\d+\.\d+(\.\d+)?/)[0]} eingebunden`, "low");
    const years = [...text(html).matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => +m[1]);
    const year = now().getFullYear();
    if (years.length && Math.max(...years) <= year - 3) add("outdated_content", page.url, `Copyright-Angabe ${Math.max(...years)} im Seiteninhalt`, "low");

    // Fehlerhafte E-Mail-Links (nur der HTML-Text wird gelesen, nichts wird gesendet).
    const badMail = tags(html, "a").map((t) => attr(t, "href") || "").filter((h) => /^mailto:/i.test(h))
      .map((h) => { try { return decodeURIComponent(h.slice(7).split("?")[0]).trim(); } catch { return h.slice(7); } })
      .filter((m) => !/^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}$/i.test(m));
    if (badMail.length) add("broken_mailto", page.url, `Ungültige mailto-Adresse im Link: ${[...new Set(badMail)].slice(0, 2).map((m) => `"${m || "(leer)"}"`).join(", ")}`, "medium", { page: page.url });

    // 3) Interne Links und Bilder – nur echte HTTP-Fehler zählen, Netzaussetzer nicht.
    const links = [];
    // Sichtbarer Linktext je Ziel (erster Treffer) – damit der Kundentext sagen kann, WELCHER Link nicht funktioniert.
    const linkText = new Map();
    for (const a of html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []) {
      const href = attr(a, "href"), label = text(a).trim();
      if (!href || !label) continue;
      try { const u = new URL(href, page.url); u.hash = ""; if (!linkText.has(u.href)) linkText.set(u.href, label.slice(0, 60)); } catch {}
    }
    for (const t of tags(html, "a")) {
      const href = attr(t, "href");
      if (!href || /^(mailto|tel|javascript|data):|^#/i.test(href)) continue;
      let u; try { u = new URL(href, page.url); } catch { continue; }
      if (u.hostname.replace(/^www\./, "") !== host.replace(/^www\./, "") || !/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      links.push(u.href);
    }
    const unique = [...new Set(links)].filter((u) => u !== page.url);
    const near = (re) => unique.find((u) => re.test(u)) || (() => {
      const a = (html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []).find((x) => re.test(text(x)));
      if (!a) return null;
      try { return new URL(attr(a, "href"), page.url).href; } catch { return null; }
    })();
    const contactUrl = near(/kontakt|contact|contatto/i);
    const impressumUrl = near(/impressum|imprint|mentions-l[ée]gales|colophon|note-legali/i);
    const teamUrl = near(/\bteam\b|ueber-uns|über-uns|uber-uns|about-us|qui-sommes|chi-siamo/i);
    const pages = { home: html };
    const toCheck = [...new Set([contactUrl, impressumUrl, teamUrl, ...unique].filter(Boolean))].slice(0, maxLinks);
    for (const u of toCheck) {
      const path = new URL(u).pathname;
      if (!allowed(path)) continue;
      const r = await get(u, { redirect: "follow" });
      if (r.error) continue;
      if (BROKEN(r.status)) {
        const isContact = u === contactUrl;
        add(isContact ? "contact_page_broken" : "broken_link", u, `HTTP ${r.status} (verlinkt auf ${page.url})`, isContact ? "high" : "medium",
          { page: page.url, ...(linkText.get(u) ? { label: linkText.get(u) } : {}) });
      } else if (r.status < 400) {
        if (u === contactUrl) pages.contact = r.html;
        if (u === impressumUrl) pages.impressum = r.html;
        if (u === teamUrl && teamUrl !== contactUrl && teamUrl !== impressumUrl) pages.team = r.html;
      }
    }
    const imgUrls = [...new Set(imgs.map((t) => attr(t, "src")).filter((s) => s && !/^data:/i.test(s)).map((s) => { try { return new URL(s, page.url).href; } catch { return null; } }).filter(Boolean))];
    for (const u of imgUrls.slice(0, maxImages)) {
      if (new URL(u).hostname === new URL(page.url).hostname && !allowed(new URL(u).pathname)) continue;
      const r = await get(u, { redirect: "follow", body: false });
      if (!r.error && BROKEN(r.status)) add("broken_image", u, `Bild liefert HTTP ${r.status} (eingebunden auf ${page.url})`, "medium", { page: page.url });
    }

    return result(true, { finalUrl: page.url, title, pages, contactUrl, impressumUrl, teamUrl });
  }

  return { audit };
}
