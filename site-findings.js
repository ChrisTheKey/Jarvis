// Website-Fehlerinventar (TF-055) – abgeleitete, normalisierte Sicht auf „tatsächliche“ Website-Fehler je Lead. Ohne Abhängigkeiten
// (CRM-Dienst, Repair-Service, Tests). KEINE zweite Fehlerdatenbank: die Quellen bleiben authoritativ, hier wird nur gezählt/sortiert.
//
//   Vollständiger Audit (FULL)   site_findings.json (passiver Hintergrund-Audit des CRM-Dienstes, site-backfill.js) bzw.
//                                repair_findings.json (Repair-Service nach bestandenem Retest, Stand NACH der Reparatur)
//   Teilprüfung (PARTIAL)        Cold-/Discovery-Befunde (individual_reviews.json, lead_registry.json) → nur „mindestens N“
//
// Gezählt werden ausschliesslich aktuell verifizierte, reproduzierbare, für Besucher sichtbare Befunde (COUNTED_TYPES) – keine
// SEO-/Barrierefreiheits-/Technik-Hinweise, keine Vermutungen, keine RESOLVED-Befunde, Duplikate/gleiche Ursache nur einmal.
// Nie Seitentexte, Evidence oder Adressen: je Befund nur Typ, Kategorie, kurzer Text, Seite, Ziel-URL, Schweregrad, Zeitpunkt, Status.

export const SITE_FINDINGS_FILE = "site_findings.json";
export const REPAIR_FINDINGS_FILE = "repair_findings.json";
export const SITE_FINDINGS_SCHEMA = 1;
export const FULL_AUDIT_MAX_AGE_MS = 7 * 86_400_000; // danach „Letzte vollständige Prüfung veraltet“
// Gleicher Umfang wie der Voll-Audit eines CHF-480-Auftrags (repair-workflow.js fullSiteAudit).
export const FULL_AUDIT_OPTIONS = Object.freeze({ maxLinks: 80, maxImages: 25, totalMs: 10 * 60_000 });
export const FULL_AUDIT_SCOPE = "Startseite, alle dort verlinkten eigenen Unterseiten und alle Bilder der Startseite";
export const AUDIT_STATES = Object.freeze(["FULL", "STALE", "PARTIAL", "NONE"]);
export const FINDING_SOURCES = Object.freeze(["full_audit", "repair", "cold"]);
// Priorität (transparent, deterministisch): 1 Kontakt/Anfrage/Reservation/Bestellung · 2 Hauptseite/Navigation/Button · 3 404/5xx ·
// 4 Bilder/zentrale Inhalte · 5 Mobile · 6 sonstige sichtbare Fehler. Innerhalb gleicher Kategorie: Schweregrad, dann Text.
export const ISSUE_CATEGORIES = Object.freeze(["contact", "navigation", "http", "images", "mobile", "other"]);
const CATEGORY_RANK = Object.fromEntries(ISSUE_CATEGORIES.map((c, i) => [c, i + 1]));
const SEVERITIES = ["critical", "high", "medium", "low"];
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const CONTACT_RE = /kontakt|contact|contatto|reserv|bestell|booking|buchen|buchung|termin|anfrage|formular|warenkorb|checkout|\bshop\b|e-mail-link/i;
const VISUAL = new Set(["mobile_text_overlap", "mobile_content_cut_off", "button_broken", "visible_layout_error", "contact_form_broken"]);

// ---------- Hilfen ----------
const iso = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const maxIso = (...xs) => xs.filter((x) => iso(x)).sort().at(-1) || null;
const short = (s, n = 140) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "") || null;
const httpUrl = (u) => { if (typeof u !== "string" || u.length > 400) return null; try { const x = new URL(u); return ["http:", "https:"].includes(x.protocol) ? x.href : null; } catch { return null; } };
export const normDomain = (u = "") => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
// Gleiches Ziel = gleicher Fehler (Host ohne www, Pfad ohne Schrägstrich am Ende, Fragment egal).
const targetKey = (u) => { try { const x = new URL(u); return `${x.host.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "") || "/"}${x.search}`; } catch { return null; } };
const pathOf = (u) => { try { return new URL(u).pathname || "/"; } catch { return null; } };
const pageOfEvidence = (e) => (typeof e === "string" ? e.match(/\((?:verlinkt|eingebunden) auf (https?:\/\/[^\s)]+)\)/)?.[1] : null) || null;
const label40 = (l) => (typeof l === "string" && l.trim() && l.trim().length <= 40 && !/https?:|www\.|[<>{}«»]/i.test(l) ? l.trim() : null);
const pageName = (u) => {
  const p = pathOf(u); if (p == null) return null;
  let seg = p.split("/").filter(Boolean).pop() || "";
  try { seg = decodeURIComponent(seg); } catch {}
  seg = seg.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ").trim();
  return seg ? `Seite «${seg.charAt(0).toUpperCase() + seg.slice(1)}»` : "Startseite";
};

// ---------- Gezählte Typen (nur besucherrelevant, reproduzierbar, aus dem passiven Audit belegbar) ----------
// family: gleiche Ursache trotz unterschiedlichem Typ (Link auf die Kontaktseite = derselbe Fehler wie „Kontaktseite kaputt“).
const TYPES = {
  contact_page_broken: { family: "link", category: () => "contact", text: () => "Kontaktseite führt auf eine Fehlerseite" },
  contact_form_broken: { family: "form", category: () => "contact", text: () => "Kontaktformular lässt sich nicht absenden" },
  broken_mailto: { family: "mailto", category: () => "contact", text: (i, page) => `E-Mail-Link auf ${pageName(page) || "der Website"} funktioniert nicht` },
  broken_link: { family: "link", category: (i) => (CONTACT_RE.test(`${i.label || ""} ${pathOf(i.url) || ""}`) ? "contact" : "http"),
    text: (i, page) => `${label40(i.label) ? `Link «${label40(i.label)}»` : `Link zur ${pageName(i.url) || "Unterseite"}`} führt auf eine Fehlerseite${page && pathOf(page) !== "/" ? ` (auf ${pageName(page)})` : ""}` },
  redirect_loop: { family: "home", category: () => "navigation", text: () => "Website lädt beim Aufruf nicht (Weiterleitungsschleife)" },
  https_certificate: { family: "cert", category: () => "navigation", text: () => "Browser zeigt beim Öffnen eine Warnmeldung" },
  button_broken: { family: "area", category: () => "navigation", text: (i) => `Button «${short(i.location, 40)}» funktioniert nicht` },
  broken_image: { family: "image", category: () => "images", text: (i, page) => `Bild auf ${pageName(page) || "der Website"} wird nicht angezeigt` },
  no_mobile_viewport: { family: "viewport", category: () => "mobile", text: () => "Auf dem Handy wird die Seite verkleinert in Desktop-Breite angezeigt" },
  mobile_text_overlap: { family: "area", category: () => "mobile", text: (i) => `Auf dem Handy überlappt Text im Bereich «${short(i.location, 40)}»` },
  mobile_content_cut_off: { family: "area", category: () => "mobile", text: (i) => `Auf dem Handy ist der Bereich «${short(i.location, 40)}» abgeschnitten` },
  visible_layout_error: { family: "area", category: () => "other", text: (i) => `Bereich «${short(i.location, 40)}» wird verschoben dargestellt` },
};
export const COUNTED_TYPES = Object.freeze(Object.keys(TYPES));
// Typen, die der passive Voll-Audit selbst prüft – nur für diese ist „nicht gefunden“ ein Beleg, dass der Fehler weg ist.
export const AUDITABLE_TYPES = Object.freeze(["contact_page_broken", "broken_mailto", "broken_link", "redirect_loop", "https_certificate", "broken_image", "no_mobile_viewport"]);

// Kategorie für Befunde ohne Typ (ältere Lead-Datenbank: nur Kundentext).
export function categoryOfText(text = "") {
  const t = String(text);
  if (CONTACT_RE.test(t)) return "contact";
  if (/Handy|Smartphone|mobil/i.test(t)) return "mobile";
  if (/Bild/i.test(t)) return "images";
  if (/lädt|Warnmeldung|Button|Navigation|Menü/i.test(t)) return "navigation";
  if (/Fehlerseite|nicht gefunden|404/i.test(t)) return "http";
  return "other";
}

// Ein Rohbefund (site-auditor / repair-workflow / Cold-Evidence) → normalisierter Befund oder null (nicht gezählt).
export function normalizeIssue(i, { verified_at = null, source = "full_audit", status = "OPEN", manual = false } = {}) {
  if (!i || !TYPES[i.type]) return null;
  if (i.reproducible === false) return null; // nicht reproduzierbar → nie gezählt
  if (VISUAL.has(i.type) && (i.reproducible !== true || !short(i.location, 60))) return null; // sichtbarer Fehler nur reproduziert + benannt
  const def = TYPES[i.type];
  const page = httpUrl(i.page) || httpUrl(pageOfEvidence(i.evidence)) || (["broken_link", "broken_image", "broken_mailto"].includes(i.type) ? null : httpUrl(i.url));
  if (["broken_link", "broken_image", "broken_mailto"].includes(i.type) && !page) return null; // ohne betroffene Seite nicht konkret prüfbar
  const target = ["broken_link", "contact_page_broken", "broken_image"].includes(i.type) ? httpUrl(i.url) : null;
  const where = target ? targetKey(target) : VISUAL.has(i.type) ? `area:${short(i.location, 60).toLowerCase()}` : def.family === "home" || def.family === "cert" || def.family === "viewport" ? "site" : `page:${pathOf(page) || "/"}`;
  const category = def.category({ ...i, url: i.url });
  return {
    key: `${def.family}|${where}`, type: i.type, category, text: short(i.customer_text_short || def.text(i, page), 140),
    page, target, severity: SEVERITIES.includes(i.severity) ? i.severity : "medium",
    verified_at: iso(verified_at) || iso(i.detectedAt) || iso(i.verified_at) || null, status: status === "RESOLVED" ? "RESOLVED" : "OPEN",
    source: FINDING_SOURCES.includes(source) ? source : "full_audit", manual: manual === true,
  };
}

// Duplikate/gleiche Ursache zusammenführen: höhere Priorität gewinnt (Kontakt vor 404), OPEN schlägt RESOLVED, jüngster Zeitpunkt.
export function dedupeFindings(list = []) {
  const out = new Map();
  for (const f of list) {
    if (!f?.key) continue;
    const prev = out.get(f.key);
    if (!prev) { out.set(f.key, { ...f }); continue; }
    const better = compareFindings(f, prev) < 0;
    const merged = better ? { ...f } : { ...prev };
    merged.status = prev.status === "OPEN" || f.status === "OPEN" ? "OPEN" : "RESOLVED";
    merged.manual = (prev.status === "OPEN" && prev.manual) || (f.status === "OPEN" && f.manual) || false;
    merged.verified_at = maxIso(prev.verified_at, f.verified_at);
    merged.severity = SEV_RANK[f.severity] < SEV_RANK[prev.severity] ? f.severity : prev.severity;
    out.set(f.key, merged);
  }
  return [...out.values()];
}
export function compareFindings(a, b) {
  return (CATEGORY_RANK[a.category] || 9) - (CATEGORY_RANK[b.category] || 9) || (SEV_RANK[a.severity] ?? 4) - (SEV_RANK[b.severity] ?? 4)
    || String(a.text || "").localeCompare(String(b.text || ""), "de") || String(a.key).localeCompare(String(b.key));
}
export const rankFindings = (list = []) => [...list].sort(compareFindings);

// Vollständiger Audit = erreichbar, Zeitbudget nicht überschritten, ALLE verlinkten Seiten und Bilder tatsächlich geprüft (keine
// Netzaussetzer, nichts wegen robots.txt oder Obergrenze übersprungen). Sonst ist das Ergebnis nur eine Mindestzahl.
export function auditComplete(r, opts = FULL_AUDIT_OPTIONS) {
  const c = r?.coverage;
  if (!r || r.reachable === false || !c || c.deadline_hit) return false;
  if ((r.issues || []).some((i) => i.type === "http_error" || i.type === "unreachable")) return false;
  return c.links_found <= opts.maxLinks && c.links_checked === c.links_found && c.images_found <= opts.maxImages && c.images_checked === c.images_found;
}

// Ergebnis eines Voll-Audits → Eintrag für site_findings.json (nur normalisierte Befunde, keine Seiteninhalte).
export function fullAuditEntry(r, { domain, audited_at }) {
  const findings = rankFindings(dedupeFindings((r?.issues || []).map((i) => normalizeIssue(i, { verified_at: audited_at, source: "full_audit" })).filter(Boolean)));
  return { domain: normDomain(domain), audited_at, complete: auditComplete(r), scope: FULL_AUDIT_SCOPE, findings };
}

// Befunde der Cold-/Discovery-Prüfung (lead-crm.js findingsOf: type/target intern) → normalisierte Teilprüfungs-Befunde.
export function partialFindings(list = []) {
  return rankFindings(dedupeFindings((Array.isArray(list) ? list : []).map((f) => {
    if (!f?.text) return null;
    const n = f.type && TYPES[f.type] ? normalizeIssue({ type: f.type, url: f.target || f.page, page: f.page || null, severity: f.severity, label: f.label, location: f.location,
      reproducible: VISUAL.has(f.type) ? true : undefined, detectedAt: f.verified_at, customer_text_short: f.text }, { verified_at: f.verified_at, source: "cold" }) : null;
    if (n) return n;
    if (f.type && !TYPES[f.type]) return null; // bekannter, aber nicht gezählter Typ
    return { key: `text|${short(f.text, 140).toLowerCase()}`, type: f.type || null, category: categoryOfText(f.text), text: short(f.text, 140), page: httpUrl(f.page), target: null,
      severity: SEVERITIES.includes(f.severity) ? f.severity : "medium", verified_at: iso(f.verified_at), status: "OPEN", source: "cold", manual: false };
  }).filter(Boolean)));
}

// ---------- Website-Zustand je Lead ----------
// full: letzter vollständiger Voll-Audit (site_findings.json domains[d].full), incomplete: letzter unvollständiger Versuch (….partial),
// repair: repair_findings.json-Eintrag (je Domain), partial: Cold-Befunde, partialCheckedAt: Zeitpunkt der Teilprüfung. Neuester vollständiger Stand gewinnt; ein unvollständiger Voll-Audit zählt nie als FULL.
export function siteHealth({ full = null, incomplete = null, repair = null, partial = [], partialCheckedAt = null, now = new Date() } = {}) {
  const fullOk = full && full.complete === true && iso(full.audited_at) ? full : null;
  const rep = repair && iso(repair.audited_at) && Array.isArray(repair.findings) ? repair : null;
  const src = fullOk && rep ? (fullOk.audited_at > rep.audited_at ? fullOk : rep) : fullOk || rep;
  const cold = partialFindings(partial);
  const repairInfo = rep ? { state: rep.state || null, completion: rep.completion || null, at: rep.audited_at,
    repaired: rep.findings.filter((f) => f.status === "RESOLVED").length, manual_open: rep.findings.filter((f) => f.status === "OPEN").length } : null;
  if (src) {
    const all = dedupeFindings(src.findings.map((f) => ({ ...f, source: src === rep ? "repair" : "full_audit" })));
    // Nicht passiv prüfbare, reproduzierte Befunde (z. B. Formular, Handy-Darstellung) aus der Teilprüfung bleiben, solange aktuell.
    const extra = cold.filter((f) => f.type && !AUDITABLE_TYPES.includes(f.type) && f.verified_at && +now - Date.parse(f.verified_at) <= FULL_AUDIT_MAX_AGE_MS);
    const items = rankFindings(dedupeFindings([...all.filter((f) => f.status === "OPEN"), ...extra]));
    const stale = +now - Date.parse(src.audited_at) > FULL_AUDIT_MAX_AGE_MS;
    return { audit: stale ? "STALE" : "FULL", count: items.length, exact: !stale, checked_at: src.audited_at, full_checked_at: src.audited_at, scope: FULL_AUDIT_SCOPE,
      top: items.slice(0, 2), items, resolved: all.filter((f) => f.status === "RESOLVED").length, manual_open: items.filter((f) => f.manual).length, repair: repairInfo };
  }
  const coldAt = maxIso(partialCheckedAt, ...cold.map((f) => f.verified_at));
  // Abgebrochener/unvollständiger Voll-Audit (z. B. Netzaussetzer, robots.txt, Zeitbudget): neuer als die Erstprüfung → seine Befunde
  // sind die aktuelle Mindestzahl (plus nicht passiv prüfbare Erstprüfungs-Befunde). Nie als vollständige Zahl.
  const cand = incomplete || (full && full.complete !== true ? full : null);
  const inc = cand && iso(cand.audited_at) && Array.isArray(cand.findings) && +now - Date.parse(cand.audited_at) <= FULL_AUDIT_MAX_AGE_MS
    && (!coldAt || cand.audited_at >= coldAt) ? cand : null;
  const items = inc ? rankFindings(dedupeFindings([...inc.findings.filter((f) => f.status !== "RESOLVED").map((f) => ({ ...f, source: "full_audit" })),
    ...cold.filter((f) => f.type && !AUDITABLE_TYPES.includes(f.type))])) : cold;
  const checked = inc ? inc.audited_at : coldAt;
  if (items.length || checked) {
    return { audit: "PARTIAL", count: items.length, exact: false, checked_at: checked, full_checked_at: null, scope: inc ? "Prüfung unvollständig (Teilprüfung)" : "Erstprüfung (Teilprüfung)",
      top: items.slice(0, 2), items, resolved: 0, manual_open: 0, repair: repairInfo };
  }
  return { audit: "NONE", count: null, exact: false, checked_at: null, full_checked_at: null, scope: null, top: [], items: [], resolved: 0, manual_open: 0, repair: repairInfo };
}
