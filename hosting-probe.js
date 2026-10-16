// TF-071 – öffentliche Signale einer Kunden-Domain einsammeln (nur VPS/Repair-Service). Ausschliesslich das, was jeder Besucher
// sieht: DNS (A/AAAA/NS, CNAME von www, PTR der ersten IPv4), die Startseite (Header, Weiterleitungen, höchstens 400 KB HTML) und
// die öffentliche Weiterleitung von /cpanel. Kein Login, kein Port-Scan, keine Formulare, keine Zugangsdaten.
// Schutz: zeigt die Domain auf private/lokale Adressen, wird keine HTTP-Anfrage gestellt; Weiterleitungen werden nur innerhalb der
// Domain (inkl. Subdomains) verfolgt, fremde Ziele nur als Signal notiert. Auswertung: hosting-detect.js detectPlatform.
import dns from "node:dns/promises";
import { detectPlatform } from "./hosting-detect.js";

const UA = "Mozilla/5.0 (compatible; JarvisSiteCheck/1.0; Helvetic Webdesign)";
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const MAX_HTML = 400_000;
const normDomain = (d = "") => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
export const isPrivateIp = (ip = "") => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
  || /^(::1?$|fc|fd|fe80:|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip);

async function readCapped(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_HTML);
  const reader = res.body.getReader(), chunks = []; let n = 0;
  while (n < MAX_HTML) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
  try { await reader.cancel(); } catch {}
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c)))).slice(0, MAX_HTML);
}

export async function probeDomain(domain, { resolver = dns, fetchFn = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const d = normDomain(domain);
  if (!DOMAIN_RE.test(d)) throw new Error("Domain ungültig.");
  const safe = async (f) => { try { return (await f()) || []; } catch { return []; } };
  const [a, aaaa, ns, cname] = await Promise.all([safe(() => resolver.resolve4(d)), safe(() => resolver.resolve6(d)), safe(() => resolver.resolveNs(d)), safe(() => resolver.resolveCname(`www.${d}`))]);
  const ptr = a[0] ? await safe(() => resolver.reverse(a[0])) : [];
  const out = { domain: d, a, aaaa, ns, cname, ptr, headers: {}, html: "", final_url: null, redirects: [], cpanel_location: null, http: "skipped" };
  if (![...a, ...aaaa].length || [...a, ...aaaa].some(isPrivateIp)) return out; // nie interne Ziele ansprechen
  const inDomain = (h) => h === d || h.endsWith(`.${d}`);
  const get = (url) => fetchFn(url, { redirect: "manual", headers: { "user-agent": UA, accept: "text/html,*/*;q=0.5" }, signal: AbortSignal.timeout(timeoutMs) });
  try {
    let url = `https://${d}/`;
    for (let i = 0; i < 6; i++) {
      const res = await get(url);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, url);
        out.redirects.push(next.hostname);
        if (!/^https?:$/.test(next.protocol) || !inDomain(next.hostname)) { out.final_url = next.origin; break; }
        url = next.href; continue;
      }
      out.headers = Object.fromEntries([...res.headers.entries()].filter(([k]) => !/^set-cookie$/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 300)]));
      out.html = /text\/html|xhtml/i.test(res.headers.get("content-type") || "text/html") ? await readCapped(res) : "";
      out.final_url = new URL(url).origin; out.http = String(res.status);
      break;
    }
  } catch { out.http = "error"; }
  try {
    const r = await get(`https://${d}/cpanel`);
    const loc = r.headers.get("location");
    if (loc) out.cpanel_location = new URL(loc, `https://${d}/`).host.slice(0, 120);
    try { await r.body?.cancel?.(); } catch {}
  } catch {}
  return out;
}

// Für den Repair-Service: Auftrag → Befund (nur feste Wörter + Konfidenz). Fehler → null (= nicht erkannt → Kunde wird gefragt).
export const createPlatformDetector = (opts = {}) => async (order) => detectPlatform(await probeDomain(order.domain, opts));
