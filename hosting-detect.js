// TF-071 – Hosting-/CMS-Erkennung VOR dem sicheren Zugang. Reiner Kern ohne Node-Abhängigkeiten (Repair-Service, Mail-Worker,
// Cloud und Tests benutzen ihn gemeinsam; das Einsammeln der öffentlichen Signale macht hosting-probe.js auf dem VPS).
//
// Grundsätze (fail closed, nie raten):
//   - Nur öffentliche Signale: DNS (A/AAAA/CNAME/NS/PTR), HTTP-Header, Weiterleitungen, HTML-Metadaten (generator), bekannte
//     Asset-Pfade, CDN-/Hosting-Signaturen. Keine Logins, keine Port-Scans, keine Zugangsdaten.
//   - Jede Kategorie (CMS, Deployment, Panel, DNS, Hosting) bekommt eine eigene Konfidenz HIGH | MEDIUM | LOW | UNKNOWN.
//     HIGH nur mit mindestens einem STARKEN Signal und Gesamtgewicht ≥ 3; nur schwache Signale (z. B. das Wort «wordpress» im Text)
//     ergeben höchstens LOW – egal wie viele. Zwei konkurrierende starke Kandidaten → höchstens MEDIUM.
//   - Automatisch weiter (sicherer Link) nur bei HIGH für die Kategorie, die den Zugangsweg bestimmt. Sonst HOSTING_UNKNOWN →
//     Jarvis fragt den Kunden im Auftrags-Thread (nie nach Passwörtern).
//   - Gespeichert/angezeigt werden NUR feste Wörter aus den Listen unten – nie freie Kundentexte, nie Zugangsdaten.
//   - Der Zugangsweg ist immer der minimal nötige, bevorzugt delegiert/temporär (Mitarbeiter-/Collaborator-Einladung, temporärer
//     Admin) – nie das Haupt- oder Inhaber-Passwort.

export const CONFIDENCE = Object.freeze(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]);
export const CMS_PLATFORMS = Object.freeze(["WORDPRESS", "WOOCOMMERCE", "SHOPIFY", "WIX", "SQUARESPACE", "WEBFLOW", "JOOMLA", "TYPO3", "DRUPAL", "STATIC"]);
export const DEPLOYMENT_PLATFORMS = Object.freeze(["NETLIFY", "VERCEL", "GITHUB_PAGES", "CLOUDFLARE_PAGES"]);
export const PANELS = Object.freeze(["CPANEL", "PLESK"]);
// Hosting-/DNS-Anbieter (feste Wörter). Plattformen, die selbst hosten, stehen ebenfalls hier.
export const PROVIDERS = Object.freeze(["HOSTPOINT", "INFOMANIAK", "CYON", "METANET", "HOSTTECH", "GREEN_CH", "NOVATREND", "SWISSCOM", "STRATO", "IONOS",
  "GODADDY", "HOSTINGER", "SITEGROUND", "OVH", "HETZNER", "DIGITALOCEAN", "AWS", "GOOGLE_CLOUD", "AZURE", "BLUEHOST", "CLOUDFLARE",
  "PA_VIETNAM", "MATBAO", "NHAN_HOA", "TENTEN", "INET", "AZDIGI", "BKNS", "VIETNIX", "VIETTEL_IDC", "VNPT", "FPT",
  "SHOPIFY", "WIX", "SQUARESPACE", "WEBFLOW", "NETLIFY", "VERCEL", "GITHUB_PAGES", "CLOUDFLARE_PAGES"]);
export const PROVIDER_NAMES = Object.freeze({ HOSTPOINT: "Hostpoint", INFOMANIAK: "Infomaniak", CYON: "cyon", METANET: "METANET", HOSTTECH: "Hosttech", GREEN_CH: "green.ch",
  NOVATREND: "Novatrend", SWISSCOM: "Swisscom", STRATO: "Strato", IONOS: "IONOS", GODADDY: "GoDaddy", HOSTINGER: "Hostinger", SITEGROUND: "SiteGround", OVH: "OVHcloud",
  HETZNER: "Hetzner", DIGITALOCEAN: "DigitalOcean", AWS: "AWS", GOOGLE_CLOUD: "Google Cloud", AZURE: "Azure", BLUEHOST: "Bluehost", CLOUDFLARE: "Cloudflare",
  PA_VIETNAM: "PA Vietnam", MATBAO: "Mắt Bão", NHAN_HOA: "Nhân Hòa", TENTEN: "Tenten", INET: "iNET", AZDIGI: "AZDIGI", BKNS: "BKNS", VIETNIX: "Vietnix",
  VIETTEL_IDC: "Viettel IDC", VNPT: "VNPT", FPT: "FPT", SHOPIFY: "Shopify", WIX: "Wix", SQUARESPACE: "Squarespace", WEBFLOW: "Webflow", NETLIFY: "Netlify",
  VERCEL: "Vercel", GITHUB_PAGES: "GitHub Pages", CLOUDFLARE_PAGES: "Cloudflare Pages",
  WORDPRESS: "WordPress", WOOCOMMERCE: "WooCommerce", JOOMLA: "Joomla", TYPO3: "TYPO3", DRUPAL: "Drupal", STATIC: "statische Website", CPANEL: "cPanel", PLESK: "Plesk" });
export const nameOf = (w) => PROVIDER_NAMES[w] || null;

// Minimal nötiger Zugangsweg je Plattform (§6). connector = bestehende Zugangsart des sicheren Formulars (access-intake-api ACCESS_TYPES).
export const ACCESS_KINDS = Object.freeze(["WORDPRESS_ADMIN", "CMS_ADMIN", "CPANEL", "PLESK", "SFTP", "SHOPIFY_STAFF", "WIX_COLLABORATOR", "WEBFLOW_COLLABORATOR",
  "SQUARESPACE_CONTRIBUTOR", "NETLIFY_TEAM", "VERCEL_TEAM", "GITHUB_COLLABORATOR"]);
// fields: welche Felder das Formular zeigt (nur diese landen im verschlüsselten Payload). Delegierte Zugänge haben KEIN Passwortfeld.
export const ACCESS_FORMS = Object.freeze({
  WORDPRESS_ADMIN: { connector: "wordpress_cms", fields: ["host", "user", "secret", "notes"] },
  CMS_ADMIN: { connector: "other", fields: ["host", "user", "secret", "notes"] },
  CPANEL: { connector: "hosting", fields: ["host", "user", "secret", "notes"] },
  PLESK: { connector: "hosting", fields: ["host", "user", "secret", "notes"] },
  SFTP: { connector: "sftp", fields: ["host", "port", "user", "secret", "root", "hostKey", "passphrase", "provider", "notes"] },
  SHOPIFY_STAFF: { connector: "other", fields: ["host", "notes"] },
  WIX_COLLABORATOR: { connector: "other", fields: ["host", "notes"] },
  WEBFLOW_COLLABORATOR: { connector: "other", fields: ["host", "notes"] },
  SQUARESPACE_CONTRIBUTOR: { connector: "other", fields: ["host", "notes"] },
  NETLIFY_TEAM: { connector: "github_netlify", fields: ["host", "notes"] },
  VERCEL_TEAM: { connector: "github_netlify", fields: ["host", "notes"] },
  GITHUB_COLLABORATOR: { connector: "github_netlify", fields: ["host", "notes"] },
});
export const connectorOf = (kind) => ACCESS_FORMS[kind]?.connector || null;
export const PLATFORM_SOURCES = Object.freeze(["automatic", "customer"]);
// Zugangsstatus fürs CRM/Dashboard (§11) – feste Wörter, nie Zugangsdaten.
export const ACCESS_FLOW_STATUSES = Object.freeze(["DETECTING_PLATFORM", "HOSTING_UNKNOWN", "WAITING_FOR_HOSTING_INFO", "WAITING_FOR_SECURE_ACCESS", "ACCESS_RECEIVED",
  "ACCESS_VALIDATED", "ACCESS_VALIDATION_FAILED", "READY_FOR_REPAIR"]);

// ---------- Signale ----------
const lc = (s) => String(s ?? "").toLowerCase();
const hostEnds = (h, suffix) => { const x = lc(h).replace(/\.$/, ""); return x === suffix || x.endsWith("." + suffix); };
const anyEnds = (list, suffixes) => (list || []).some((h) => suffixes.some((s) => hostEnds(h, s)));
const ipIn = (list, prefixes) => (list || []).some((ip) => prefixes.some((p) => String(ip).startsWith(p)));
// NS/PTR-Suffixe → Anbieter (DNS-Anbieter bzw. Server-Betreiber).
const PROVIDER_HOSTS = [
  ["CLOUDFLARE", ["cloudflare.com"]], ["HOSTPOINT", ["hostpoint.ch"]], ["INFOMANIAK", ["infomaniak.ch", "infomaniak.com", "infomaniak.network"]], ["CYON", ["cyon.ch", "cyon.net"]],
  ["METANET", ["metanet.ch"]], ["HOSTTECH", ["hosttech.eu", "hosttech.ch"]], ["GREEN_CH", ["green.ch"]], ["NOVATREND", ["novatrend.ch"]], ["SWISSCOM", ["swisscom.com", "swisscom.ch", "bluewin.ch"]],
  ["STRATO", ["strato.de", "rzone.de"]], ["IONOS", ["ui-dns.com", "ui-dns.de", "ui-dns.org", "ui-dns.biz", "ionos.com", "1and1.com"]], ["GODADDY", ["domaincontrol.com", "secureserver.net"]],
  ["HOSTINGER", ["hostinger.com", "dns-parking.com"]], ["SITEGROUND", ["siteground.net", "sgvps.net"]], ["OVH", ["ovh.net", "ovh.ca", "anycast.me"]], ["HETZNER", ["hetzner.com", "hetzner.de", "your-server.de", "second-ns.com"]],
  ["DIGITALOCEAN", ["digitalocean.com"]], ["AWS", ["awsdns-00.com", "amazonaws.com"]], ["GOOGLE_CLOUD", ["googledomains.com", "googleusercontent.com", "google.com"]],
  ["AZURE", ["azure-dns.com", "azure-dns.net", "cloudapp.net"]], ["BLUEHOST", ["bluehost.com"]],
  ["PA_VIETNAM", ["pavietnam.vn"]], ["MATBAO", ["matbao.com", "matbao.net"]], ["NHAN_HOA", ["nhanhoa.com", "nhanhoa.net"]], ["TENTEN", ["tenten.vn"]], ["INET", ["inet.vn"]],
  ["AZDIGI", ["azdigi.com"]], ["BKNS", ["bkns.vn"]], ["VIETNIX", ["vietnix.vn"]], ["VIETTEL_IDC", ["viettelidc.com.vn", "viettel.vn"]], ["VNPT", ["vnpt.vn"]], ["FPT", ["fpt.vn"]],
  ["WIX", ["wixdns.net"]], ["SQUARESPACE", ["squarespacedns.com"]], ["VERCEL", ["vercel-dns.com"]],
];
const providerOfHost = (h) => { for (const [p, sufs] of PROVIDER_HOSTS) if (sufs.some((s) => hostEnds(h, s) || (s.startsWith("awsdns") && /awsdns-\d+\./.test(lc(h))))) return p; return null; };

// Gewicht: 3 = eindeutige Signatur (plattformeigener Header/CNAME), 2 = starkes Signal (generator, Asset-Pfad, dokumentierte IP),
// 1 = schwaches Signal (Wort im Seitentext, NS beim Anbieter ≠ Hosting).
export function collectSignals(s = {}) {
  const out = [];
  const add = (cat, cand, weight, id) => out.push({ cat, cand, weight, id });
  const h = Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [lc(k), lc(Array.isArray(v) ? v.join(",") : v)]));
  const html = String(s.html || "").slice(0, 600_000);
  const gen = lc((html.match(/<meta[^>]+name=["']?generator["']?[^>]*>/i) || [""])[0]);
  const cname = (s.cname || []).map(lc), a = s.a || [], ns = (s.ns || []).map(lc), ptr = (s.ptr || []).map(lc);
  const redirects = (s.redirects || []).map(lc);

  // Deployment
  if ("x-nf-request-id" in h || /netlify/.test(h.server || "")) add("deployment", "NETLIFY", 3, "netlify_header");
  if (anyEnds(cname, ["netlify.app", "netlify.com"])) add("deployment", "NETLIFY", 3, "netlify_cname");
  if (ipIn(a, ["75.2.60.5"])) add("deployment", "NETLIFY", 2, "netlify_ip");
  if ("x-vercel-id" in h || "x-vercel-cache" in h || /vercel/.test(h.server || "")) add("deployment", "VERCEL", 3, "vercel_header");
  if (anyEnds(cname, ["vercel-dns.com", "vercel.app"])) add("deployment", "VERCEL", 3, "vercel_cname");
  if (ipIn(a, ["76.76.21."])) add("deployment", "VERCEL", 2, "vercel_ip");
  if (/^github\.com$/.test(h.server || "") || "x-github-request-id" in h) add("deployment", "GITHUB_PAGES", 3, "github_pages_header");
  if (anyEnds(cname, ["github.io"])) add("deployment", "GITHUB_PAGES", 3, "github_pages_cname");
  if (ipIn(a, ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"])) add("deployment", "GITHUB_PAGES", 2, "github_pages_ip");
  if (anyEnds(cname, ["pages.dev"])) add("deployment", "CLOUDFLARE_PAGES", 3, "cf_pages_cname");
  if (anyEnds(ns, ["vercel-dns.com"])) add("deployment", "VERCEL", 1, "vercel_ns");

  // CMS / Website-Baukasten
  if (/rel=["']?https:\/\/api\.w\.org/.test(h.link || "") || /wp-json/.test(h.link || "")) add("cms", "WORDPRESS", 3, "wp_link_header");
  if (/xmlrpc\.php/.test(h["x-pingback"] || "")) add("cms", "WORDPRESS", 2, "wp_pingback_header");
  if (/wordpress/.test(gen)) add("cms", "WORDPRESS", 2, "wp_generator");
  if (/\/wp-(content|includes)\//i.test(html)) add("cms", "WORDPRESS", 2, "wp_asset_paths");
  if (/\/wp-content\/plugins\/woocommerce\/|woocommerce-no-js|class=["'][^"']*\bwoocommerce\b/i.test(html) || /woocommerce/.test(gen)) add("cms", "WOOCOMMERCE", 2, "woocommerce_assets");
  if ("x-shopid" in h || "x-shopify-stage" in h || "x-sorting-hat-shopid" in h || /shopify/.test(h["powered-by"] || "")) add("cms", "SHOPIFY", 3, "shopify_header");
  if (anyEnds(cname, ["myshopify.com"])) add("cms", "SHOPIFY", 3, "shopify_cname");
  if (ipIn(a, ["23.227.38."])) add("cms", "SHOPIFY", 2, "shopify_ip");
  if (/cdn\.shopify\.com|shopify\.theme|\/\/[a-z0-9-]+\.myshopify\.com/i.test(html)) add("cms", "SHOPIFY", 2, "shopify_assets");
  if ("x-wix-request-id" in h || /pepyaka/.test(h.server || "") || /wix/.test(h["x-seen-by"] || "")) add("cms", "WIX", 3, "wix_header");
  if (/wix\.com website builder/.test(gen)) add("cms", "WIX", 2, "wix_generator");
  if (/static\.wixstatic\.com|static\.parastorage\.com/i.test(html)) add("cms", "WIX", 2, "wix_assets");
  if (ipIn(a, ["185.230.63.", "185.230.60."])) add("cms", "WIX", 2, "wix_ip");
  if (anyEnds(ns, ["wixdns.net"])) add("cms", "WIX", 1, "wix_ns");
  if (/squarespace/.test(h.server || "")) add("cms", "SQUARESPACE", 3, "squarespace_header");
  if (anyEnds(cname, ["squarespace.com"])) add("cms", "SQUARESPACE", 3, "squarespace_cname");
  if (/squarespace/.test(gen)) add("cms", "SQUARESPACE", 2, "squarespace_generator");
  if (/static1\.squarespace\.com|assets\.squarespace\.com/i.test(html)) add("cms", "SQUARESPACE", 2, "squarespace_assets");
  if (ipIn(a, ["198.185.159.", "198.49.23."])) add("cms", "SQUARESPACE", 2, "squarespace_ip");
  if (/webflow/.test(gen)) add("cms", "WEBFLOW", 2, "webflow_generator");
  if (/data-wf-(page|site)=|assets\.website-files\.com|cdn\.prod\.website-files\.com|assets-global\.website-files\.com/i.test(html)) add("cms", "WEBFLOW", 2, "webflow_assets");
  if (anyEnds(cname, ["webflow.io", "proxy-ssl.webflow.com", "proxy.webflow.com"])) add("cms", "WEBFLOW", 3, "webflow_cname");
  if (ipIn(a, ["75.2.70.75", "99.83.190.102"])) add("cms", "WEBFLOW", 2, "webflow_ip");
  if (/joomla/.test(gen)) add("cms", "JOOMLA", 2, "joomla_generator");
  if (/\/media\/jui\/|\/components\/com_[a-z]+\//i.test(html)) add("cms", "JOOMLA", 2, "joomla_assets");
  if (/typo3/.test(gen)) add("cms", "TYPO3", 2, "typo3_generator");
  if (/\/typo3conf\/|\/typo3temp\//i.test(html)) add("cms", "TYPO3", 2, "typo3_assets");
  if (/drupal/.test(gen) || "x-drupal-cache" in h || /drupal/.test(h["x-generator"] || "")) add("cms", "DRUPAL", 2, "drupal_generator");
  if (/\/sites\/default\/files\//i.test(html)) add("cms", "DRUPAL", 2, "drupal_assets");
  // Schwache Hinweise: das Wort im Seitentext/Footer («Made with Wix», «Powered by WordPress», Link zu shopify.com) – allein nie mehr als LOW.
  const text = lc(html.replace(/<[^>]+>/g, " "));
  for (const [cand, re] of [["WORDPRESS", /wordpress/], ["SHOPIFY", /shopify/], ["WIX", /\bwix\b/], ["WEBFLOW", /webflow/], ["SQUARESPACE", /squarespace/], ["JOOMLA", /joomla/]])
    if (re.test(text)) add("cms", cand, 1, `${cand.toLowerCase()}_text_mention`);

  // Hosting-Panel
  if (/plesk(lin|win)/.test(h["x-powered-by"] || "")) add("panel", "PLESK", 3, "plesk_header");
  if (/:8443\b/.test(lc(s.panel_location || "")) || /plesk/.test(lc(s.panel_location || ""))) add("panel", "PLESK", 2, "plesk_redirect");
  if (/:2083\b|:2082\b/.test(lc(s.cpanel_location || ""))) add("panel", "CPANEL", 2, "cpanel_redirect");
  if (/\/cgi-sys\/|cpanel/i.test(redirects.join(" "))) add("panel", "CPANEL", 1, "cpanel_hint");

  // DNS-Anbieter (NS ist für den DNS-Anbieter eindeutig) und Hosting-Betreiber (PTR stark, NS nur schwach).
  for (const n of ns) { const p = providerOfHost(n); if (p) { add("dns", p, 3, "ns"); if (!["CLOUDFLARE", "AWS", "AZURE", "GOOGLE_CLOUD", "WIX", "SQUARESPACE", "VERCEL"].includes(p)) add("hosting", p, 1, "ns_hoster"); } }
  for (const r of ptr) { const p = providerOfHost(r); if (p && p !== "CLOUDFLARE") add("hosting", p, 2, "ptr"); }
  if ("cf-ray" in h || /cloudflare/.test(h.server || "")) add("cdn", "CLOUDFLARE", 3, "cloudflare_header");

  // Statische Website ohne CMS-Spuren (nur als schwacher Hinweis – sagt nichts über den Zugangsweg).
  if (/<html/i.test(html) && !out.some((x) => x.cat === "cms" && x.weight >= 2) && !/<\?php/.test(html)) add("cms", "STATIC", 1, "plain_html");
  // Je Kategorie/Kandidat/Signal nur einmal zählen.
  const seen = new Set();
  return out.filter((x) => { const k = `${x.cat}|${x.cand}|${x.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Konfidenz einer Kategorie: bester Kandidat, HIGH nur mit starkem Signal + Gewicht ≥ 3 und ohne starken Konkurrenten.
function rank(signals, cat) {
  const by = new Map();
  for (const s of signals.filter((x) => x.cat === cat)) {
    const e = by.get(s.cand) || { cand: s.cand, score: 0, strong: false, ids: [] };
    e.score += s.weight; e.strong ||= s.weight >= 2; e.ids.push(s.id);
    by.set(s.cand, e);
  }
  // WooCommerce ist WordPress: Gewicht von WordPress übernehmen, WordPress selbst entfällt als Konkurrent.
  if (cat === "cms" && by.has("WOOCOMMERCE") && by.get("WOOCOMMERCE").strong && by.has("WORDPRESS")) {
    const w = by.get("WORDPRESS"), x = by.get("WOOCOMMERCE");
    by.set("WOOCOMMERCE", { ...x, score: x.score + w.score, strong: true, ids: [...x.ids, ...w.ids] }); by.delete("WORDPRESS");
  }
  const list = [...by.values()].sort((p, q) => q.score - p.score);
  const best = list[0];
  if (!best) return { value: null, confidence: "UNKNOWN", signals: [] };
  let confidence = best.strong ? (best.score >= 3 ? "HIGH" : "MEDIUM") : "LOW";
  const rival = list[1];
  if (rival?.strong && best.strong && rival.cand !== "STATIC") confidence = best.score - rival.score >= 3 ? confidence : confidence === "HIGH" ? "MEDIUM" : "LOW";
  if (best.cand === "STATIC") confidence = "LOW"; // «kein CMS gefunden» ist nie ein sicherer Befund
  return { value: best.cand, confidence, signals: best.ids.slice(0, 8) };
}
const HOSTED_BUILDERS = new Set(["SHOPIFY", "WIX", "SQUARESPACE", "WEBFLOW"]);
const CONF_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
export const atLeast = (c, min) => (CONF_RANK[c] || 0) >= (CONF_RANK[min] || 0);

// Hauptfunktion: öffentliche Signale → Plattform-Befund (nur feste Wörter + Konfidenz).
export function detectPlatform(s = {}) {
  const signals = collectSignals(s);
  const cms = rank(signals, "cms"), dep = rank(signals, "deployment"), panel = rank(signals, "panel"), dns = rank(signals, "dns"), host = rank(signals, "hosting"), cdn = rank(signals, "cdn");
  // Hosting-Betreiber: Baukasten/Deployment-Plattform hostet selbst; sonst PTR/NS – nie aus dem CDN (Cloudflare verdeckt den Hoster).
  let hosting = host;
  if (cms.value && HOSTED_BUILDERS.has(cms.value) && atLeast(cms.confidence, "MEDIUM")) hosting = { value: cms.value, confidence: cms.confidence };
  else if (dep.value && atLeast(dep.confidence, "MEDIUM")) hosting = { value: dep.value, confidence: dep.confidence };
  const result = {
    hosting_provider: hosting.value || null, hosting_confidence: hosting.confidence,
    cms_platform: cms.value || null, cms_confidence: cms.confidence,
    dns_provider: dns.value || null, dns_confidence: dns.confidence,
    deployment_platform: dep.value || null, deployment_confidence: dep.confidence,
    panel: panel.value || null, panel_confidence: panel.confidence,
    cdn_provider: cdn.value || null,
    evidence: [...new Set([...cms.signals, ...dep.signals, ...panel.signals, ...(hosting.signals || [])])].slice(0, 12),
  };
  const need = accessRequirement(result, { min: "HIGH" });
  return { ...result, access_type: need?.access_type || null, connector_type: need ? connectorOf(need.access_type) : null, access_basis: need?.basis || null,
    confidence: need?.confidence || (cms.value || dep.value || hosting.value ? strongestUnder(result) : "UNKNOWN") };
}
const strongestUnder = (r) => ["cms_confidence", "deployment_confidence", "panel_confidence", "hosting_confidence"].map((k) => r[k]).sort((a, b) => CONF_RANK[b] - CONF_RANK[a])[0] || "UNKNOWN";

// ---------- Zugangs-Engine (§6): minimal nötiger, bevorzugt delegierter Zugang ----------
// min = Mindestkonfidenz der entscheidenden Kategorie (automatisch HIGH; mit Kundenangabe MEDIUM). null = nicht entscheidbar → fragen.
export function accessRequirement(p = {}, { min = "HIGH" } = {}) {
  const ok = (v, c) => !!v && atLeast(c, min);
  const pick = (access_type, basis, confidence) => ({ access_type, basis, confidence });
  const cms = p.cms_platform, cc = p.cms_confidence, dep = p.deployment_platform, dc = p.deployment_confidence;
  if (ok(cms, cc) && cms === "SHOPIFY") return pick("SHOPIFY_STAFF", "cms", cc);
  if (ok(cms, cc) && cms === "WIX") return pick("WIX_COLLABORATOR", "cms", cc);
  if (ok(cms, cc) && cms === "WEBFLOW") return pick("WEBFLOW_COLLABORATOR", "cms", cc);
  if (ok(cms, cc) && cms === "SQUARESPACE") return pick("SQUARESPACE_CONTRIBUTOR", "cms", cc);
  // WordPress: temporärer WordPress-Administrator – cPanel/Plesk/SFTP nur, wenn das nicht reicht (Chris entscheidet später).
  if (ok(cms, cc) && ["WORDPRESS", "WOOCOMMERCE"].includes(cms)) return pick("WORDPRESS_ADMIN", "cms", cc);
  if (ok(dep, dc) && dep === "NETLIFY") return pick("NETLIFY_TEAM", "deployment", dc);
  if (ok(dep, dc) && dep === "VERCEL") return pick("VERCEL_TEAM", "deployment", dc);
  if (ok(dep, dc) && dep === "GITHUB_PAGES") return pick("GITHUB_COLLABORATOR", "deployment", dc);
  if (ok(cms, cc) && ["JOOMLA", "TYPO3", "DRUPAL"].includes(cms)) return pick("CMS_ADMIN", "cms", cc);
  if (ok(p.panel, p.panel_confidence) && p.panel === "PLESK") return pick("PLESK", "panel", p.panel_confidence);
  if (ok(p.panel, p.panel_confidence) && p.panel === "CPANEL") return pick("CPANEL", "panel", p.panel_confidence);
  // Kunde nennt (S)FTP bzw. nur einen klassischen Hoster ohne CMS: temporärer SFTP-Benutzer nur fürs Website-Verzeichnis.
  if (p.protocol === "SFTP" && atLeast(p.protocol_confidence, min)) return pick("SFTP", "protocol", p.protocol_confidence);
  if (p.detection_source === "customer" && ok(p.hosting_provider, p.hosting_confidence) && !HOSTED_BUILDERS.has(p.hosting_provider)
    && !DEPLOYMENT_PLATFORMS.includes(p.hosting_provider) && (!cms || cms === "STATIC")) return pick("SFTP", "hosting", p.hosting_confidence);
  return null;
}

// ---------- Kundenantwort parsen (§5): nur bekannte Wörter, nie freie Texte, nie Zugangsdaten ----------
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
const CMS_WORDS = [["WOOCOMMERCE", /\bwoo\s?commerce\b/], ["WORDPRESS", /\bword\s?press\b|\bwp\b/], ["SHOPIFY", /\bshopify\b/], ["WIX", /\bwix\b/], ["SQUARESPACE", /\bsquare\s?space\b/],
  ["WEBFLOW", /\bwebflow\b/], ["JOOMLA", /\bjoomla\b/], ["TYPO3", /\btypo\s?3\b/], ["DRUPAL", /\bdrupal\b/]];
const DEPLOY_WORDS = [["NETLIFY", /\bnetlify\b/], ["VERCEL", /\bvercel\b/], ["GITHUB_PAGES", /\bgithub\s?pages\b|\bgithub\.io\b/]];
const GITHUB_RE = /\bgithub\b/;
const PANEL_WORDS = [["CPANEL", /\bc\s?panel\b/], ["PLESK", /\bplesk\b/]];
const SFTP_RE = /\b(s?ftp|filezilla|ssh)\b/;
const HOSTER_WORDS = [["HOSTPOINT", /\bhostpoint\b/], ["INFOMANIAK", /\binfomaniak\b/], ["CYON", /\bcyon\b/], ["METANET", /\bmetanet\b/], ["HOSTTECH", /\bhosttech\b/],
  ["GREEN_CH", /\bgreen\.ch\b|\bgreen ch\b/], ["NOVATREND", /\bnovatrend\b/], ["SWISSCOM", /\bswisscom\b/], ["STRATO", /\bstrato\b/], ["IONOS", /\bionos\b|\b1\s?(&|und)\s?1\b/],
  ["GODADDY", /\bgo\s?daddy\b/], ["HOSTINGER", /\bhostinger\b/], ["SITEGROUND", /\bsiteground\b/], ["OVH", /\bovh(cloud)?\b/], ["HETZNER", /\bhetzner\b/], ["DIGITALOCEAN", /\bdigital\s?ocean\b/],
  ["AWS", /\baws\b|\bamazon web services\b/], ["GOOGLE_CLOUD", /\bgoogle cloud\b/], ["AZURE", /\bazure\b/], ["BLUEHOST", /\bbluehost\b/],
  ["PA_VIETNAM", /\bpa\s?viet\s?nam\b|\bpavietnam\b/], ["MATBAO", /\bmat\s?bao\b/], ["NHAN_HOA", /\bnhan\s?hoa\b/], ["TENTEN", /\btenten\b/], ["INET", /\binet(\.vn)?\b/],
  ["AZDIGI", /\bazdigi\b/], ["BKNS", /\bbkns\b/], ["VIETNIX", /\bvietnix\b/], ["VIETTEL_IDC", /\bviettel\b/], ["VNPT", /\bvnpt\b/], ["FPT", /\bfpt\b/]];
// Füllwörter einer reinen Plattform-Antwort («Wir haben WordPress bei Hostpoint.») – bleibt danach kaum etwas übrig, war es nur die Plattform.
const FILLER_RE = /\b(bei|mit|uber|ueber|von|via|auf|im|in|der|die|das|den|dem|und|oder|ist|sind|lauft|laeuft|laufen|gehostet|hosting|hoster|anbieter|provider|system|cms|website|webseite|homepage|seite|unsere|unser|meine|mein|wir|haben|hat|ich|es|sie|ihre|hallo|guten|tag|gruezi|danke|vielen|dank|gruss|grusse|grusse|freundliche|beste|lg|mfg|ja|also|nur|alles|via|at|on|with|is|we|use|our|site|o|tai|tren|dung|su dung|chung toi|cua|la|va|he thong|nha cung cap|trang web|website|cam on|xin chao|kinh gui|anh|chi|em|ben|duoc|dang|o tai)\b/g;
export function parsePlatformAnswer(text = "") {
  const t = fold(text).slice(0, 2000);
  if (!t.trim()) return null;
  const find = (list) => list.find(([, re]) => re.test(t))?.[0] || null;
  let cms_platform = find(CMS_WORDS);
  const deployment_platform = find(DEPLOY_WORDS) || (GITHUB_RE.test(t) ? "GITHUB_PAGES" : null);
  const panel = find(PANEL_WORDS);
  const hoster = find(HOSTER_WORDS);
  const protocol = SFTP_RE.test(t) ? "SFTP" : null;
  if (!cms_platform && !deployment_platform && !panel && !hoster && !protocol) return null;
  const hosting_provider = cms_platform && HOSTED_BUILDERS.has(cms_platform) ? cms_platform : deployment_platform || hoster || null;
  const rest = t.replace(/[.,;:!?()«»"'“”\-–/]/g, " ")
    .replace(new RegExp([...CMS_WORDS, ...DEPLOY_WORDS, ...PANEL_WORDS, ...HOSTER_WORDS].map(([, re]) => re.source).join("|"), "g"), " ")
    .replace(/\bgithub\b|\b(s?ftp|filezilla|ssh)\b/g, " ").replace(FILLER_RE, " ").replace(/\s+/g, " ").trim();
  const p = { detection_source: "customer", cms_platform, cms_confidence: cms_platform ? "HIGH" : "UNKNOWN", deployment_platform, deployment_confidence: deployment_platform ? "HIGH" : "UNKNOWN",
    panel, panel_confidence: panel ? "HIGH" : "UNKNOWN", hosting_provider, hosting_confidence: hosting_provider ? "HIGH" : "UNKNOWN", dns_provider: null, dns_confidence: "UNKNOWN",
    protocol, protocol_confidence: protocol ? "HIGH" : "UNKNOWN", platform_only: rest.split(" ").filter((w) => w.length > 1).length <= 2 };
  return p;
}

// Kundenangabe + automatischer Befund zusammenführen: Kundenangabe gewinnt; Lücken nur aus dem Befund mit ≥ MEDIUM. Ergebnis mit
// Zugangsweg (Mindestkonfidenz MEDIUM, da der Kunde selbst bestätigt hat) – sonst access_type null (→ Chris).
export function resolvePlatform(detected = {}, stated = {}) {
  const out = { detection_source: "customer" };
  for (const [k, ck] of [["cms_platform", "cms_confidence"], ["deployment_platform", "deployment_confidence"], ["panel", "panel_confidence"], ["hosting_provider", "hosting_confidence"], ["dns_provider", "dns_confidence"]]) {
    if (stated?.[k]) { out[k] = stated[k]; out[ck] = stated[ck] || "HIGH"; continue; }
    if (detected?.[k] && atLeast(detected[ck], "MEDIUM")) { out[k] = detected[k]; out[ck] = detected[ck]; continue; }
    out[k] = null; out[ck] = "UNKNOWN";
  }
  out.protocol = stated?.protocol || null; out.protocol_confidence = stated?.protocol ? "HIGH" : "UNKNOWN";
  const need = accessRequirement(out, { min: "MEDIUM" });
  return { ...out, access_type: need?.access_type || null, connector_type: need ? connectorOf(need.access_type) : null, access_basis: need?.basis || null, confidence: need?.confidence || "UNKNOWN" };
}

// Nur Allowlist-Wörter weitergeben (Export, Brief, Dashboard). Alles Unbekannte → null.
const w = (v, list) => (list.includes(v) ? v : null);
export function cleanPlatform(p) {
  if (!p || typeof p !== "object") return null;
  return { hosting_provider: w(p.hosting_provider, PROVIDERS), cms_platform: w(p.cms_platform, CMS_PLATFORMS), dns_provider: w(p.dns_provider, PROVIDERS),
    deployment_platform: w(p.deployment_platform, DEPLOYMENT_PLATFORMS), panel: w(p.panel, PANELS), access_type: w(p.access_type, ACCESS_KINDS),
    confidence: w(p.confidence, CONFIDENCE) || "UNKNOWN", detection_source: w(p.detection_source, PLATFORM_SOURCES), ...(p.access_flow !== undefined ? { access_flow: w(p.access_flow, ACCESS_FLOW_STATUSES) } : {}) };
}
// Kundenangabe für den Brief (Mail-Worker → Repair-Service): nur Wörter + HIGH, kein Kundentext.
export function cleanStated(p) {
  if (!p || typeof p !== "object" || p.detection_source !== "customer") return null;
  const c = { detection_source: "customer", cms_platform: w(p.cms_platform, CMS_PLATFORMS), deployment_platform: w(p.deployment_platform, DEPLOYMENT_PLATFORMS), panel: w(p.panel, PANELS),
    hosting_provider: w(p.hosting_provider, PROVIDERS), protocol: p.protocol === "SFTP" ? "SFTP" : null };
  for (const k of ["cms", "deployment", "panel", "hosting", "protocol"]) c[`${k}_confidence`] = c[k === "cms" ? "cms_platform" : k === "deployment" ? "deployment_platform" : k === "hosting" ? "hosting_provider" : k] ? "HIGH" : "UNKNOWN";
  return c.cms_platform || c.deployment_platform || c.panel || c.hosting_provider || c.protocol ? c : null;
}

// ---------- Kundentexte (feste Vorlagen) ----------
export const HOSTING_QUESTION_DE = "Bei welchem Anbieter bzw. mit welchem System wird Ihre Website betrieben? Zum Beispiel WordPress, Wix, Shopify, Webflow oder bei einem Hosting-Anbieter wie Hostpoint, Infomaniak usw.";
export const HOSTING_NO_PW_DE = "Bitte senden Sie uns noch keine Passwörter oder Zugangsdaten per E-Mail.";
export const HOSTING_QUESTION_VI = "Website của anh/chị đang được vận hành trên hệ thống nào hoặc tại nhà cung cấp nào? Ví dụ WordPress, Wix, Shopify, Webflow hoặc tại một nhà cung cấp hosting như PA Vietnam, Mắt Bão, Nhân Hòa, v.v.";
export const HOSTING_NO_PW_VI = "Vui lòng chưa gửi mật khẩu hoặc thông tin đăng nhập qua email.";
export const hostingQuestionLines = (locale) => (locale === "vi-VN" ? [HOSTING_QUESTION_VI, "", HOSTING_NO_PW_VI] : [HOSTING_QUESTION_DE, "", HOSTING_NO_PW_DE]);

// Anleitung je Zugangsweg in der Zugangs-Mail (nie nach Passwörtern per E-Mail, immer delegiert/temporär zuerst).
const INVITE_DE = "an die Adresse, von der Sie diese E-Mail erhalten haben";
const INVITE_VI = "tới địa chỉ email mà anh/chị nhận được thư này";
export const ACCESS_GUIDE = Object.freeze({
  WORDPRESS_ADMIN: { de: "Ihre Website läuft mit WordPress. Am einfachsten: Legen Sie unter «Benutzer → Neu hinzufügen» einen temporären Benutzer mit der Rolle «Administrator» an und tragen Sie ihn im Formular ein. Ihr eigenes Passwort brauche ich nicht.",
    vi: "Website của anh/chị dùng WordPress. Cách đơn giản nhất: vào «Thành viên → Thêm mới», tạo một tài khoản tạm thời với vai trò «Quản trị viên» và nhập tài khoản đó vào biểu mẫu. Chúng tôi không cần mật khẩu riêng của anh/chị." },
  CMS_ADMIN: { de: "Bitte legen Sie in Ihrem Website-System einen temporären Administrator nur für diesen Auftrag an und tragen Sie ihn im Formular ein.",
    vi: "Vui lòng tạo một tài khoản quản trị tạm thời trong hệ thống website chỉ cho đơn hàng này và nhập vào biểu mẫu." },
  CPANEL: { de: "Ihre Website wird über cPanel verwaltet. Bitte richten Sie dort – falls möglich – einen eigenen, temporären Zugang ein und tragen Sie Login-Adresse und Benutzer im Formular ein.",
    vi: "Website của anh/chị được quản lý qua cPanel. Nếu có thể, vui lòng tạo một quyền truy cập riêng, tạm thời và nhập địa chỉ đăng nhập cùng tên người dùng vào biểu mẫu." },
  PLESK: { de: "Ihre Website wird über Plesk verwaltet. Bitte richten Sie dort – falls möglich – einen eigenen, temporären Zugang ein und tragen Sie Login-Adresse und Benutzer im Formular ein.",
    vi: "Website của anh/chị được quản lý qua Plesk. Nếu có thể, vui lòng tạo một quyền truy cập riêng, tạm thời và nhập địa chỉ đăng nhập cùng tên người dùng vào biểu mẫu." },
  SFTP: { de: "Bitte legen Sie im Kundenbereich Ihres Hosting-Anbieters einen temporären SFTP-Benutzer nur für das Website-Verzeichnis an und tragen Sie Server, Port und Benutzer im Formular ein.",
    vi: "Vui lòng tạo một tài khoản SFTP tạm thời chỉ cho thư mục website trong khu vực khách hàng của nhà cung cấp hosting và nhập máy chủ, cổng, tên người dùng vào biểu mẫu." },
  SHOPIFY_STAFF: { de: `Ihre Website läuft mit Shopify. Bitte laden Sie mich unter «Einstellungen → Benutzer und Berechtigungen» als Mitarbeiter ein (${INVITE_DE}) – Ihr Inhaber-Passwort brauche ich nie. Im Formular bestätigen Sie nur noch Ihren Shop.`,
    vi: `Website của anh/chị dùng Shopify. Vui lòng mời chúng tôi làm nhân viên trong «Cài đặt → Người dùng và quyền» (${INVITE_VI}) – chúng tôi không bao giờ cần mật khẩu chủ cửa hàng. Trong biểu mẫu, anh/chị chỉ cần xác nhận cửa hàng.` },
  WIX_COLLABORATOR: { de: `Ihre Website läuft mit Wix. Bitte laden Sie mich unter «Einstellungen → Rollen & Berechtigungen» als Mitarbeiter ein (${INVITE_DE}) – kein Passwort nötig. Im Formular bestätigen Sie nur noch Ihre Website.`,
    vi: `Website của anh/chị dùng Wix. Vui lòng mời chúng tôi làm cộng tác viên trong «Cài đặt → Vai trò & quyền» (${INVITE_VI}) – không cần mật khẩu. Trong biểu mẫu, anh/chị chỉ cần xác nhận website.` },
  WEBFLOW_COLLABORATOR: { de: `Ihre Website läuft mit Webflow. Bitte laden Sie mich im Workspace bzw. bei der Site als Collaborator ein (${INVITE_DE}) – kein Passwort nötig. Im Formular bestätigen Sie nur noch Ihre Site.`,
    vi: `Website của anh/chị dùng Webflow. Vui lòng mời chúng tôi làm cộng tác viên trong workspace hoặc site (${INVITE_VI}) – không cần mật khẩu. Trong biểu mẫu, anh/chị chỉ cần xác nhận site.` },
  SQUARESPACE_CONTRIBUTOR: { de: `Ihre Website läuft mit Squarespace. Bitte laden Sie mich unter «Berechtigungen» als Mitwirkenden ein (${INVITE_DE}) – kein Passwort nötig. Im Formular bestätigen Sie nur noch Ihre Website.`,
    vi: `Website của anh/chị dùng Squarespace. Vui lòng mời chúng tôi làm cộng tác viên trong mục «Quyền» (${INVITE_VI}) – không cần mật khẩu. Trong biểu mẫu, anh/chị chỉ cần xác nhận website.` },
  NETLIFY_TEAM: { de: `Ihre Website läuft über Netlify. Bitte laden Sie mich in Ihr Netlify-Team bzw. zur Site ein (${INVITE_DE}) – kein Passwort nötig. Im Formular bestätigen Sie nur noch den Namen der Site.`,
    vi: `Website của anh/chị chạy trên Netlify. Vui lòng mời chúng tôi vào team hoặc site Netlify (${INVITE_VI}) – không cần mật khẩu. Trong biểu mẫu, anh/chị chỉ cần xác nhận tên site.` },
  VERCEL_TEAM: { de: `Ihre Website läuft über Vercel. Bitte laden Sie mich in Ihr Vercel-Team bzw. Projekt ein (${INVITE_DE}) – kein Passwort nötig. Im Formular bestätigen Sie nur noch den Projektnamen.`,
    vi: `Website của anh/chị chạy trên Vercel. Vui lòng mời chúng tôi vào team hoặc dự án Vercel (${INVITE_VI}) – không cần mật khẩu. Trong biểu mẫu, anh/chị chỉ cần xác nhận tên dự án.` },
  GITHUB_COLLABORATOR: { de: `Bitte laden Sie mich im GitHub-Repository Ihrer Website als Collaborator ein (${INVITE_DE}) – Ihr GitHub-Passwort brauche ich nie. Im Formular bestätigen Sie nur noch das Repository.`,
    vi: `Vui lòng mời chúng tôi làm cộng tác viên trong repository GitHub của website (${INVITE_VI}) – chúng tôi không bao giờ cần mật khẩu GitHub của anh/chị. Trong biểu mẫu, anh/chị chỉ cần xác nhận repository.` },
});
export const accessGuide = (kind, locale) => ACCESS_GUIDE[kind]?.[locale === "vi-VN" ? "vi" : "de"] || null;
