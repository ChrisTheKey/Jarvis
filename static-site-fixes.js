// STATISCHE QUELLTEXT-FIXES (TF-JARVIS-PRAXIS-002) für CHECK & REPARATUR CHF 480 – generische, deterministische Minimal-Korrekturen
// in HTML-Dateien einer statischen Website (Netlify Drop, SFTP-Webroot …). Grundlage sind ausschliesslich BROWSER-BEFUNDE
// (browser-site-audit.js: echte DOM-/Laufzeit-Messung) – hier wird nur noch die eindeutige Stelle im Quelltext gesucht.
//
//   broken_anchor     Link auf #x, auf der Seite gibt es kein Element mit id/name x. Fix: Sprungmarke <span id="x"> direkt vor dem
//                     EINDEUTIG passenden vorhandenen Bereich (gleiche Bedeutung/Schreibweise: Synonym-Tabelle de/fr/it/en oder
//                     Tippfehler-Abstand). Damit funktionieren der Link UND die URL …/#x (z. B. in Mails/Visitenkarten). Text bleibt.
//   content_clipped   Raster (CSS-Grid) mit fester Spaltenzahl in einem Container mit overflow:hidden schneidet Inhalte ab. Fix: die
//                     feste Spaltenzahl wird durch auto-fit mit derselben Mindestbreite ersetzt – Tailwind-Klasse, Inline-Style oder
//                     die EINE CSS-Regel des Elements. Keine anderen Gestaltungsänderungen.
//   js_runtime_error  Laufzeitfehler, weil ein Inline-Skript ein Element per id sucht, das es nicht gibt (Tippfehler). Fix: die id im
//                     Skript durch die EINE vorhandene, fast gleich geschriebene id ersetzen (Abstand ≤ 2).
//
// Harte Regeln: nie raten – jede Stelle muss genau einmal vorkommen und das Ersatzziel eindeutig sein, sonst null (→ manuelle
// Prüfung). Keine Massenersetzung, keine Inhalte/Texte, keine geschützten Bereiche (prüft die Engine zusätzlich).
import crypto from "node:crypto";

export const STATIC_FIX_TYPES = Object.freeze(["broken_anchor", "content_clipped", "js_runtime_error"]);
export const sha1 = (s) => crypto.createHash("sha1").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest("hex");
export const sha256 = (s) => crypto.createHash("sha256").update(typeof s === "string" ? Buffer.from(s, "utf8") : s).digest("hex");
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ID_RE = /^[A-Za-z][\w:.-]{0,80}$/;

// Seitenpfad → HTML-Datei der Website (Netlify/statischer Webserver: /a/ → /a/index.html, /a → /a.html oder /a/index.html).
export function htmlFileFor(pagePath, files) {
  let p = "/"; try { p = decodeURIComponent(new URL(pagePath, "https://x.invalid").pathname); } catch {}
  const cands = p.endsWith("/") ? [`${p}index.html`, `${p}index.htm`] : /\.html?$/i.test(p) ? [p] : [`${p}.html`, `${p}/index.html`];
  return cands.find((c) => files.has(c)) || null;
}

// ---------- Ähnlichkeit ----------
export function editDistance(a, b) {
  a = String(a); b = String(b);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // Vertauschung
  }
  return d[a.length][b.length];
}
const norm = (s) => String(s).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/[éèê]/g, "e").replace(/[àâ]/g, "a").replace(/[^a-z0-9]/g, "");
// Übliche Bereichs-Sprungmarken mehrsprachiger Websites (CH: de/fr/it/en). Gruppe = gleiche Bedeutung.
const SYNONYMS = [
  ["kontakt", "contact", "contatto", "kontaktieren", "contacts", "contactez", "contattaci", "contactus"],
  ["termin", "termine", "appointment", "appointments", "booking", "buchung", "rendezvous", "appuntamento"],
  ["leistungen", "angebot", "services", "service", "dienstleistungen", "prestations", "servizi", "offer", "angebote"],
  ["ueberuns", "about", "aboutus", "apropos", "chisiamo", "uber", "ueber"],
  ["team", "equipe", "squadra"],
  ["preise", "pricing", "prices", "tarife", "tarifs", "prezzi"],
  ["anfahrt", "lage", "location", "directions", "standort", "acces", "accesso", "map", "karte"],
  ["oeffnungszeiten", "hours", "openinghours", "horaires", "orari", "sprechstunden", "sprechzeiten"],
  ["notfall", "emergency", "urgence", "urgences", "emergenza", "notfaelle"],
  ["faq", "fragen", "questions", "domande"],
  ["galerie", "gallery", "galleria", "bilder", "photos"],
];
const synGroup = (s) => SYNONYMS.findIndex((g) => g.includes(norm(s)));
// Kandidaten für eine fehlende Sprungmarke: gleiche Bedeutung (Synonym) oder Tippfehler (Abstand ≤ 2, bei kurzen Namen ≤ 1).
export function anchorCandidates(missing, ids) {
  const m = norm(missing), g = synGroup(missing);
  const out = new Set();
  for (const id of ids) {
    const n = norm(id);
    if (!n || id === missing) continue;
    const dist = editDistance(m, n), max = Math.min(m.length, n.length) >= 5 ? 2 : 1;
    if (n === m || (g >= 0 && synGroup(id) === g) || dist <= max) out.add(id);
  }
  return [...out];
}
// Tippfehler-Kandidaten für eine id im Skript (nur Schreibweise, keine Synonyme – Skripte sind exakt).
export function idTypoCandidates(missing, ids) {
  return [...new Set(ids)].filter((id) => id !== missing && Math.abs(id.length - missing.length) <= 2 && editDistance(missing.toLowerCase(), id.toLowerCase()) <= (missing.length >= 5 ? 2 : 1));
}

// ---------- HTML-Hilfen (bewusst einfache, eindeutige Muster – nie ein Parser, der «repariert») ----------
export function idsInHtml(html) {
  const ids = [];
  const re = /<[a-zA-Z][\w-]*\b[^>]*?\sid\s*=\s*(["'])([^"']+)\1/g;
  for (let m; (m = re.exec(html));) ids.push(m[2]);
  return ids;
}
// Öffnendes Tag mit genau dieser id – Position + Text. Mehrfach/nie → null.
function uniqueTagWithId(html, id) {
  const re = new RegExp(`<([a-zA-Z][\\w-]*)\\b[^>]*?\\sid\\s*=\\s*(["'])${esc(id)}\\2[^>]*>`, "g");
  const hits = [...html.matchAll(re)];
  return hits.length === 1 ? { index: hits[0].index, tag: hits[0][0], name: hits[0][1].toLowerCase() } : null;
}
const scriptBlocks = (html) => [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => ({ start: m.index + m[0].indexOf(">") + 1, text: m[1] }));
export const ID_LOOKUP_RES = Object.freeze([
  (id) => new RegExp(`getElementById\\(\\s*(["'\`])${esc(id)}\\1\\s*\\)`, "g"),
  (id) => new RegExp(`querySelector(?:All)?\\(\\s*(["'\`])#${esc(id)}\\1\\s*\\)`, "g"),
]);

// ---------- 1) Fehlende Sprungmarke ----------
function locateAnchor(issue, file, html) {
  const missing = String(issue.anchor || "");
  if (!ID_RE.test(missing)) return null;
  const ids = idsInHtml(html);
  if (ids.includes(missing) || new RegExp(`\\sname\\s*=\\s*(["'])${esc(missing)}\\1`).test(html)) return null; // Ziel existiert im Quelltext – Ursache liegt woanders
  const cands = anchorCandidates(missing, ids);
  if (cands.length !== 1) return null;
  const target = cands[0];
  const tag = uniqueTagWithId(html, target);
  if (!tag || !/^(section|div|article|main|aside|footer|header|form|h[1-6]|span|p|ul|ol|table)$/.test(tag.name)) return null;
  const linkRe = new RegExp(`href\\s*=\\s*(["'])#${esc(missing)}\\1`, "g");
  const links = [...html.matchAll(linkRe)].length;
  return {
    target: `${file}: Bereich #${target}`,
    cause: `${links || "Ein"} Link(s) verweisen auf #${missing}; auf der Seite heisst der Bereich aber #${target} – Klick und Direkt-URL …/#${missing} springen nirgendwohin.`,
    planned_change: `Sprungmarke id="${missing}" unmittelbar vor dem Bereich #${target} ergänzen (Link-Texte und Gestaltung unverändert)`,
    risk: "niedrig", required_capabilities: ["READ_FILES", "WRITE_FILES", "BACKUP", "ROLLBACK"],
    fix: { kind: "anchor_alias", file, anchor: missing, target_id: target },
  };
}
function applyAnchor(fix, html) {
  if (idsInHtml(html).includes(fix.anchor)) return null;
  const tag = uniqueTagWithId(html, fix.target_id);
  if (!tag) return null;
  const lineStart = html.lastIndexOf("\n", tag.index - 1) + 1;
  const indent = /^[ \t]*$/.test(html.slice(lineStart, tag.index)) ? html.slice(lineStart, tag.index) : "";
  const insert = `<span id="${fix.anchor}" aria-hidden="true"></span>\n${indent}`;
  return html.slice(0, tag.index) + insert + html.slice(tag.index);
}

// ---------- 2) Abgeschnittenes Raster ----------
// Feste Spaltenzahl erkennen: Tailwind grid-cols-N / grid-cols-[repeat(N,…)] bzw. CSS repeat(N, …) / N explizite Spuren.
const TW_FIXED_RE = /^(grid-cols-\[repeat\((\d+),\s*(?:minmax\(\s*(\d+(?:\.\d+)?)(px|rem)\s*,[^)]*\)|(\d+(?:\.\d+)?)(px|rem))\s*\)\]|grid-cols-(\d+))$/;
const toPx = (v, unit) => (unit === "rem" ? Number(v) * 16 : Number(v));
export function autoFitColumns(minPx) {
  const w = Math.max(120, Math.min(600, Math.round(minPx || 240)));
  return { tailwind: `grid-cols-[repeat(auto-fit,minmax(min(100%,${w}px),1fr))]`, css: `repeat(auto-fit, minmax(min(100%, ${w}px), 1fr))`, min_px: w };
}
function cssFixedColumns(value) {
  const v = String(value || "").trim();
  let m = v.match(/^repeat\(\s*(\d+)\s*,\s*minmax\(\s*(\d+(?:\.\d+)?)(px|rem)\s*,[^)]*\)\s*\)$/i);
  if (m) return { n: +m[1], min: toPx(m[2], m[3]) };
  m = v.match(/^repeat\(\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)(px|rem)\s*\)$/i);
  if (m) return { n: +m[1], min: toPx(m[2], m[3]) };
  const tracks = v.split(/\s+/);
  if (tracks.length >= 3 && tracks.every((t) => /^\d+(?:\.\d+)?(px|rem)$/.test(t))) return { n: tracks.length, min: Math.min(...tracks.map((t) => toPx(parseFloat(t), t.endsWith("rem") ? "rem" : "px"))) };
  return null;
}
function locateClipped(issue, file, html) {
  const el = issue.element || {};
  const cls = typeof el.class === "string" ? el.class.trim() : "";
  const id = typeof el.id === "string" && ID_RE.test(el.id) ? el.id : null;
  const measuredMin = Number(issue.min_child_px) > 0 ? Number(issue.min_child_px) : null;
  // Element im Quelltext: über die id (eindeutig) oder über das exakte class-Attribut (genau einmal).
  let tagText = null, tagIndex = -1;
  if (id) { const t = uniqueTagWithId(html, id); if (t) { tagText = t.tag; tagIndex = t.index; } }
  if (!tagText && cls) {
    const re = new RegExp(`<${esc(String(el.tag || "div").toLowerCase())}\\b[^>]*\\sclass\\s*=\\s*(["'])${esc(cls)}\\1[^>]*>`, "g");
    const hits = [...html.matchAll(re)];
    if (hits.length !== 1) return null;
    tagText = hits[0][0]; tagIndex = hits[0].index;
  }
  if (!tagText) return null;
  const base = { risk: "niedrig", required_capabilities: ["READ_FILES", "WRITE_FILES", "BACKUP", "ROLLBACK"] };
  const area = issue.location ? `«${issue.location}»` : "des Bereichs";
  // a) Tailwind-Klasse mit fester Spaltenzahl (ohne Breakpoint-Präfix) – genau eine im Attribut.
  const classAttr = tagText.match(/\sclass\s*=\s*(["'])([^"']*)\1/)?.[2] || "";
  const fixed = classAttr.split(/\s+/).filter((c) => TW_FIXED_RE.test(c));
  if (fixed.length === 1) {
    const m = fixed[0].match(TW_FIXED_RE);
    const n = Number(m[2] || m[7]);
    const min = m[3] ? toPx(m[3], m[4]) : m[5] ? toPx(m[5], m[6]) : measuredMin || 240;
    if (n >= 2) {
      const af = autoFitColumns(min);
      return { ...base, target: `${file}: Raster ${area} (Klasse ${fixed[0]})`,
        cause: `Das Raster ${area} hat fest ${n} Spalten zu mindestens ${min}px; der Container schneidet überstehende Elemente ab (overflow:hidden) – auf schmaleren Bildschirmen fehlen Inhalte.`,
        planned_change: `Feste Spaltenzahl durch automatische Spalten mit derselben Mindestbreite ersetzen: ${fixed[0]} → ${af.tailwind}`,
        fix: { kind: "grid_autofit_class", file, tag_index_hint: tagIndex, class_attr: classAttr, from: fixed[0], to: af.tailwind } };
    }
  }
  // b) Inline-Style grid-template-columns
  const style = tagText.match(/\sstyle\s*=\s*(["'])([^"']*)\1/)?.[2] || "";
  const sm = style.match(/grid-template-columns\s*:\s*([^;]+)/i);
  if (sm && cssFixedColumns(sm[1])) {
    const c = cssFixedColumns(sm[1]), af = autoFitColumns(c.min);
    return { ...base, target: `${file}: Raster ${area} (Inline-Style)`, cause: `Das Raster ${area} hat fest ${c.n} Spalten (${sm[1].trim()}); der Container schneidet überstehende Elemente ab.`,
      planned_change: `grid-template-columns: ${sm[1].trim()} → ${af.css}`, fix: { kind: "grid_autofit_inline", file, tag: tagText, from: sm[1].trim(), to: af.css } };
  }
  // c) Genau EINE CSS-Regel in <style> für eine Klasse/id des Elements mit fester Spaltenzahl.
  const sels = [...(id ? [`#${id}`] : []), ...classAttr.split(/\s+/).filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).map((c) => `.${c}`)];
  const rules = [];
  for (const blk of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const r of blk[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = r[1].trim();
      if (!sels.includes(selector)) continue; // nur einfache Selektoren genau dieses Elements (keine Media-Query-Varianten raten)
      const d = r[2].match(/grid-template-columns\s*:\s*([^;]+)/i);
      if (d && cssFixedColumns(d[1])) rules.push({ selector, value: d[1].trim(), decl: d[0] });
    }
  }
  if (rules.length === 1) {
    const c = cssFixedColumns(rules[0].value), af = autoFitColumns(c.min);
    return { ...base, target: `${file}: CSS-Regel ${rules[0].selector}`, cause: `Die Regel ${rules[0].selector} legt fest ${c.n} Spalten fest (${rules[0].value}); der Container schneidet überstehende Elemente ab.`,
      planned_change: `grid-template-columns: ${rules[0].value} → ${af.css}`, fix: { kind: "grid_autofit_rule", file, selector: rules[0].selector, from: rules[0].value, to: af.css } };
  }
  return null;
}
function applyClipped(fix, html) {
  if (fix.kind === "grid_autofit_class") {
    const re = new RegExp(`(\\sclass\\s*=\\s*(["']))${esc(fix.class_attr)}\\2`, "g");
    const hits = [...html.matchAll(re)];
    if (hits.length !== 1) return null;
    const tokens = fix.class_attr.split(/(\s+)/);
    const i = tokens.indexOf(fix.from);
    if (i < 0) return null;
    tokens[i] = fix.to;
    const h = hits[0];
    return html.slice(0, h.index) + `${h[1]}${tokens.join("")}${h[2]}` + html.slice(h.index + h[0].length);
  }
  if (fix.kind === "grid_autofit_inline") {
    if (html.split(fix.tag).length !== 2) return null;
    const next = fix.tag.replace(fix.from, fix.to);
    return next === fix.tag ? null : html.replace(fix.tag, () => next);
  }
  if (fix.kind === "grid_autofit_rule") {
    const re = new RegExp(`(${esc(fix.selector)}\\s*\\{[^{}]*grid-template-columns\\s*:\\s*)${esc(fix.from)}`, "g");
    const hits = [...html.matchAll(re)];
    if (hits.length !== 1) return null;
    return html.slice(0, hits[0].index) + hits[0][1] + fix.to + html.slice(hits[0].index + hits[0][0].length);
  }
  return null;
}

// ---------- 3) Laufzeitfehler durch falsche id im Inline-Skript ----------
function locateScriptId(issue, file, html) {
  const missing = (Array.isArray(issue.missing_ids) ? issue.missing_ids : []).filter((x) => ID_RE.test(String(x)));
  if (missing.length !== 1) return null; // genau eine Ursache – sonst nicht eindeutig
  const id = missing[0];
  const ids = idsInHtml(html);
  if (ids.includes(id)) return null;
  const cands = idTypoCandidates(id, ids);
  if (cands.length !== 1 || ids.filter((x) => x === cands[0]).length !== 1) return null;
  let hits = 0;
  for (const b of scriptBlocks(html)) for (const mk of ID_LOOKUP_RES) hits += [...b.text.matchAll(mk(id))].length;
  if (hits !== 1) return null;
  return {
    target: `${file}: Inline-Skript (Suche nach #${id})`,
    cause: `Ein Skript sucht das Element «${id}», das es nicht gibt (vorhanden ist «${cands[0]}») – es bricht mit einem Laufzeitfehler ab${issue.message ? ` (${String(issue.message).slice(0, 80)})` : ""}.`,
    planned_change: `Im Skript «${id}» → «${cands[0]}» (nur diese eine Stelle)`, risk: "niedrig",
    required_capabilities: ["READ_FILES", "WRITE_FILES", "BACKUP", "ROLLBACK"],
    fix: { kind: "script_id_typo", file, from: id, to: cands[0] },
  };
}
function applyScriptId(fix, html) {
  const edits = [];
  for (const b of scriptBlocks(html)) for (const mk of ID_LOOKUP_RES) for (const m of b.text.matchAll(mk(fix.from))) edits.push({ at: b.start + m.index, len: m[0].length, text: m[0] });
  if (edits.length !== 1) return null;
  const e = edits[0];
  const next = e.text.replace(fix.from, fix.to);
  return html.slice(0, e.at) + next + html.slice(e.at + e.len);
}

// ---------- Öffentliche Schnittstelle ----------
// files: Map<pfad, string> (HTML-Dateien der Website). Rückgabe wie adapter.locate (target/cause/planned_change/risk/fix) | null.
export function locateStaticFix(issue = {}, files = new Map()) {
  if (!STATIC_FIX_TYPES.includes(issue.type)) return null;
  const file = htmlFileFor(issue.page_path || issue.page || issue.url || "/", files);
  if (!file) return null;
  const html = files.get(file);
  if (typeof html !== "string") return null;
  const loc = issue.type === "broken_anchor" ? locateAnchor(issue, file, html) : issue.type === "content_clipped" ? locateClipped(issue, file, html) : locateScriptId(issue, file, html);
  if (!loc) return null;
  const after = applyStaticFix(loc.fix, html);
  if (typeof after !== "string" || after === html) return null; // Fix muss sich genau so anwenden lassen
  return { ...loc, before_hash: sha256(html), fix: { ...loc.fix, before_sha256: sha256(html) } };
}
// Wendet den Fix auf den Dateiinhalt an → neuer Inhalt | null (Stelle nicht mehr eindeutig / schon geändert).
export function applyStaticFix(fix = {}, html = "") {
  if (typeof html !== "string") return null;
  switch (fix.kind) {
    case "anchor_alias": return applyAnchor(fix, html);
    case "grid_autofit_class": case "grid_autofit_inline": case "grid_autofit_rule": return applyClipped(fix, html);
    case "script_id_typo": return applyScriptId(fix, html);
    default: return null;
  }
}
