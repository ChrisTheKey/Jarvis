// Jarvis Lead-CRM (TF-053) – gemeinsames Modell ohne Abhängigkeiten: Browser (ES-Modul), Netlify-Funktion und VPS-Dienst.
// Stufen, Telefon-/Kontaktstatus, Priorität (transparente Punkte, keine Blackbox), Follow-up-Fälligkeit, Befund-Anzeige,
// Filter, Sortierung, Kennzahlen und CSV-Export. Nichts hier löst je eine Aktion aus (kein Senden, kein Anruf, keine SMS).

export const SALES_STAGES = Object.freeze(["NEW", "DRAFT_READY", "TO_CONTACT", "CONTACTED", "INTERESTED", "FOLLOW_UP", "CHECK_150_INTEREST",
  "REPAIR_480_INTEREST", "CUSTOMER", "NOT_INTERESTED", "DO_NOT_CONTACT", "CLOSED"]);
export const STAGE_LABEL = Object.freeze({ NEW: "Neu", DRAFT_READY: "Entwurf bereit", TO_CONTACT: "Zu kontaktieren", CONTACTED: "Kontaktiert",
  INTERESTED: "Interessiert", FOLLOW_UP: "Follow-up", CHECK_150_INTEREST: "Interesse CHF 150", REPAIR_480_INTEREST: "Interesse CHF 480",
  CUSTOMER: "Kunde", NOT_INTERESTED: "Kein Interesse", DO_NOT_CONTACT: "Nicht kontaktieren", CLOSED: "Abgeschlossen" });
export const CALL_STATUSES = Object.freeze(["NOT_CALLED", "NO_ANSWER", "CALLBACK_REQUESTED", "SPOKE_TO_EMPLOYEE", "SPOKE_TO_DECISION_MAKER",
  "INTERESTED", "NOT_INTERESTED", "WRONG_NUMBER", "DO_NOT_CALL"]);
export const CALL_LABEL = Object.freeze({ NOT_CALLED: "Nicht angerufen", NO_ANSWER: "Keine Antwort", CALLBACK_REQUESTED: "Rückruf erbeten",
  SPOKE_TO_EMPLOYEE: "Mitarbeiter gesprochen", SPOKE_TO_DECISION_MAKER: "Entscheider gesprochen", INTERESTED: "Interessiert",
  NOT_INTERESTED: "Kein Interesse", WRONG_NUMBER: "Falsche Nummer", DO_NOT_CALL: "Nicht anrufen" });
export const CONTACT_STATUSES = Object.freeze(["NOT_CONTACTED", "EMAIL_SENT", "CALLED", "REACHED", "REPLIED", "MEETING", "NO_RESPONSE"]);
export const CONTACT_LABEL = Object.freeze({ NOT_CONTACTED: "Nicht kontaktiert", EMAIL_SENT: "E-Mail gesendet (manuell)", CALLED: "Angerufen",
  REACHED: "Erreicht", REPLIED: "Antwort erhalten", MEETING: "Termin vereinbart", NO_RESPONSE: "Keine Reaktion" });
// QUEUED (TF-057): Cold-Entwurf in der Queue, Gmail-Entwurf folgt. Ohne Status (null): qualifiziert, aber kein Entwurf eingeplant.
export const DRAFT_STATUSES = Object.freeze(["QUEUED", "DRAFT", "MANUALLY_SENT", "NO_LONGER_DRAFT", "SKIPPED"]);
export const DRAFT_LABEL = Object.freeze({ QUEUED: "Wartet auf Entwurf", DRAFT: "Entwurf", MANUALLY_SENT: "Manuell gesendet", NO_LONGER_DRAFT: "Kein Entwurf mehr", SKIPPED: "Übersprungen" });
export const FOLLOW_UP_LABEL = Object.freeze({ OVERDUE: "Überfällig", TODAY: "Heute fällig", LATER: "Später" });
export const PRIORITY_LEVELS = Object.freeze(["HIGH", "MEDIUM", "LOW"]);
// Stufen, die keine Kontaktaufnahme mehr empfehlen (Anruf-Empfehlung, Outreach-Queue, Follow-up).
export const CLOSED_STAGES = Object.freeze(["CUSTOMER", "NOT_INTERESTED", "DO_NOT_CONTACT", "CLOSED"]);
export const NO_CALL_STATUSES = Object.freeze(["WRONG_NUMBER", "DO_NOT_CALL", "NOT_INTERESTED"]);

// ---------- Datum (Europe/Zurich) ----------
export const zurichDay = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
// Follow-up: nur ein Datum (YYYY-MM-DD) oder ISO-Zeitpunkt; Vergleich nach Zürcher Kalendertag.
export function followUpBucket(lead, now = new Date()) {
  if (!lead || lead.do_not_contact || !lead.next_action_at) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(lead.next_action_at) ? lead.next_action_at : zurichDay(new Date(lead.next_action_at));
  const today = zurichDay(now);
  return day < today ? "OVERDUE" : day === today ? "TODAY" : "LATER";
}

// ---------- Befunde: 0 → keiner, 1–3 → alle, 4+ → Top 3 prominent, Rest unter „Weitere Probleme“ ----------
export const TOP_FINDINGS = 3;
export function splitFindings(findings = []) {
  const list = Array.isArray(findings) ? findings : [];
  return { top: list.slice(0, TOP_FINDINGS), more: list.slice(TOP_FINDINGS), total: list.length };
}
// Kontakt-, Reservations- oder Bestellweg betroffen? (Befund-Schlüssel, Text, Seite – ohne Raten über die Wirkung)
const CONTACT_PATH_RE = /kontakt|contact|reserv|bestell|order|booking|buchen|buchung|termin|anfrage|formular|warenkorb|checkout|shop|e-mail-link/i;
export const isContactPathFinding = (f) => !!f && (f.key === "contact" || String(f.key || "").startsWith("mailto:") || CONTACT_PATH_RE.test(`${f.text || ""} ${f.page || ""}`));

// ---------- Website-Fehler (TF-055): genaue Zahl nur aus vollständigem, aktuellem Audit – sonst „mindestens“ ----------
// lead.errors kommt aus site-findings.js siteHealth (Audit FULL | STALE | PARTIAL | NONE). Reine Anzeige – keine Outreach-Logik.
export const AUDIT_LABEL = Object.freeze({ FULL: "Vollständig", STALE: "Veraltet", PARTIAL: "Teilprüfung", NONE: "Nicht geprüft" });
// Gleiche Reihenfolge/Schlüssel wie site-findings.js ISSUE_CATEGORIES (Test prüft die Übereinstimmung).
export const ISSUE_CATEGORIES = Object.freeze(["contact", "navigation", "http", "images", "mobile", "other"]);
export const ISSUE_LABEL = Object.freeze({ contact: "Kontakt", navigation: "Navigation", http: "404/5xx", images: "Bilder", mobile: "Mobile", other: "Andere" });
export const SEVERITY_LABEL = Object.freeze({ critical: "kritisch", high: "hoch", medium: "mittel", low: "niedrig" });
const errs = (l) => (l?.errors && typeof l.errors === "object" ? l.errors : { audit: "NONE", count: null, top: [], items: [] });
// Zahl für Zähler/Filter: nur geprüfte Leads (FULL/STALE: Zahl, PARTIAL: Mindestzahl), sonst null.
export const errorCount = (l) => { const e = errs(l); return e.audit === "NONE" || !Number.isInteger(e.count) ? null : e.count; };
// Kurz (Tabelle/Karte): „7“, „≥3“, „7 (veraltet)“, „–“. Nie eine Teilmenge als genaue Zahl.
// TF-063: Texte über ein Wörterbuch (Standard Deutsch, unverändert; Vietnamesisch in i18n.js) – die Logik bleibt identisch.
export const ERR_WORDS_DE = Object.freeze({ staleFull: (n) => `${n} (veraltet)`, staleMin: (n) => `≥${n} · veraltet`, partialZero: "0 (Teilprüfung)",
  notChecked: "Nicht geprüft", fullN: (n) => `${n} Fehler (verifiziert)`, noneVerified: "Keine aktuell verifizierten Fehler",
  staleFullLong: (n) => `Letzte vollständige Prüfung veraltet – damals ${n} Fehler`, staleMinLong: (n) => `Letzte Teilprüfung veraltet – damals mindestens ${n} Fehler`,
  minN: (n) => `Mindestens ${n} verifizierte Fehler`, noneVerifiedPartial: "Keine aktuell verifizierten Fehler (nur Teilprüfung)",
  repairManual: (r, m) => `Automatisch repariert (${r}) + ${m} manuelle${m === 1 ? "r Punkt" : " Punkte"} offen`, repairDone: (r) => `Automatisch repariert (${r}) – keine geplanten reparierbaren Punkte offen` });
export function errorShort(l, w = ERR_WORDS_DE) {
  const e = errs(l), n = errorCount(l);
  if (n == null) return "–";
  if (e.audit === "FULL") return String(n);
  if (e.audit === "STALE") return e.full_checked_at ? w.staleFull(n) : w.staleMin(n); // TF-058: alte Teilprüfung bleibt „mindestens“
  return n ? `≥${n}` : w.partialZero;
}
// Lang (Detail): „7 Fehler“, „Mindestens 3 Fehler“, „Keine aktuell verifizierten Fehler“, „Letzte vollständige Prüfung veraltet …“.
export function errorLong(l, w = ERR_WORDS_DE) {
  const e = errs(l), n = errorCount(l);
  if (n == null) return w.notChecked;
  if (e.audit === "FULL") return n ? w.fullN(n) : w.noneVerified;
  if (e.audit === "STALE") return e.full_checked_at ? w.staleFullLong(n) : w.staleMinLong(n);
  return n ? w.minN(n) : w.noneVerifiedPartial;
}
export const errorBucket = (l) => { const n = errorCount(l); return n == null ? null : n === 0 ? "0" : n <= 2 ? "1-2" : n <= 5 ? "3-5" : "6+"; };
export const ERROR_BUCKETS = Object.freeze(["0", "1-2", "3-5", "6+"]);
// TF-076: die Übertragung lässt errors.top weg (= die ersten zwei Einträge von items) – dann aus items abgeleitet.
export const topIssues = (l) => { const e = errs(l); return (Array.isArray(e.top) && e.top.length ? e.top : Array.isArray(e.items) ? e.items : []).slice(0, 2); };

// ---------- TF-077B: «E-Mail lossenden» (SEND_PREPARED_LEAD_DRAFT) – Zustand je Lead und Entwurf (nur Anzeige) ----------
// requests = eigene Sendeaufträge (/api/mail-requests, Verkäufer-Sicht). Gesendet gilt nur, was der Mail-Worker als gesendet meldet bzw. was
// das CRM als manuell/vom Verkäufer gesendet führt – nie aus dem Klick allein.
export const SEND_STATES = Object.freeze(["NO_DRAFT", "DRAFT_READY", "SEND_IN_PROGRESS", "SENT", "SEND_FAILED"]);
export function sellerSendState(lead, requests = []) {
  if (!lead) return "NO_DRAFT";
  const mine = (Array.isArray(requests) ? requests : []).filter((r) => r && r.delivery === "send_prepared" && r.lead_id === lead.lead_id);
  if (lead.draft_status === "MANUALLY_SENT" || mine.some((r) => r.status === "sent")) return "SENT";
  if (!lead.draft_ref) return "NO_DRAFT";
  const cur = mine.filter((r) => r.draft_ref === lead.draft_ref).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
  if (!cur) return "DRAFT_READY";
  if (["pending", "processing", "accepted_local"].includes(cur.status)) return "SEND_IN_PROGRESS";
  return "SEND_FAILED"; // failed / blocked / expired – nie fälschlich «gesendet»; ein neuer Klick ist ein sicherer neuer Versuch
}

// ---------- TF-077B: Kontaktformular CONTACT_FORM_P0 (höchste Priorität, eigener Abschnitt ganz oben) ----------
export const contactFormOpen = (l) => !!l?.contact_form && l.contact_form.lead_source === "CONTACT_FORM" && l.contact_form.open === true && !l.archived;
// Rangstufe der kanonischen Reihenfolge: 0 offene Kontaktformular-Anfrage · 1 ausdrücklicher Rückruf/heisser Lead · 2 übrige.
const HOT_STAGES = ["INTERESTED", "CHECK_150_INTEREST", "REPAIR_480_INTEREST"];
export function hotRank(l, now = new Date()) {
  if (contactFormOpen(l)) return 0;
  if (!l?.do_not_contact && (l?.call_status === "CALLBACK_REQUESTED" || HOT_STAGES.includes(l?.sales_stage) || l?.replied === true || ["TODAY", "OVERDUE"].includes(followUpBucket(l, now)))) return 1;
  return 2;
}
// Innerhalb von P0: älteste unbeantwortete Anfrage zuerst (nichts wird vergessen), dann Eingang, dann Lead-ID (deterministisch).
const cfOrder = (a, b) => String(a.contact_form?.open_since || a.contact_form?.received_at || "").localeCompare(String(b.contact_form?.open_since || b.contact_form?.received_at || ""))
  || String(a.lead_id).localeCompare(String(b.lead_id));
export const contactFormQueue = (list = []) => list.filter(contactFormOpen).sort(cfOrder);

// ---------- TF-076: CRM-Aufnahmeregel (EINE Definition für VPS-Sicht, VN-Sicht, Cloud-Speicher/-Lesen, Calling, Zähler) ----------
// Aktiver CRM-Lead = erfolgreich geprüft UND ≥ 1 aktuell verifizierter, für Besucher sichtbarer Website-Fehler (errors.items aus
// site-findings.js siteHealth: nur gezählte, reproduzierbare Typen, RESOLVED fällt heraus). Ein unvollständiger/fehlgeschlagener Audit ist
// NIE „sauber“: er bleibt ausserhalb des aktiven CRM, bis ein erfolgreicher Audit einen Fehler belegt. Ausnahme nur Kunden (Auftrag/
// Kundenhistorie bleibt sichtbar, auch wenn die Reparatur alle Fehler behoben hat). Historie (lead_crm.json, Audits) wird nie gelöscht.
// TF-077B: CONTACT_FORM_INBOUND = eigener Pool für Kunden, die selbst das Kontaktformular abgeschickt haben – auch ohne Website-Fehler (eine
// echte Anfrage wird nie verworfen). Das ist NICHT der Pool der gescrapten Fehler-Leads (VERIFIED_ERRORS); Zähler bleiben getrennt.
export const ADMISSION_STATES = Object.freeze(["VERIFIED_ERRORS", "CUSTOMER", "CONTACT_FORM_INBOUND", "NO_VERIFIED_ERRORS", "AUDIT_INCOMPLETE", "AUDIT_FAILED", "AUDIT_RETRY_REQUIRED"]);
export const ACTIVE_ADMISSIONS = Object.freeze(["VERIFIED_ERRORS", "CUSTOMER", "CONTACT_FORM_INBOUND"]);
export const verifiedErrorCount = (l) => { const e = errs(l); if (e.audit === "NONE") return 0; const items = Array.isArray(e.items) ? e.items.filter((f) => f && f.status !== "RESOLVED").length : 0;
  return Math.max(items, Number.isInteger(e.count) ? e.count : 0); };
// auditFailed: der letzte Audit-Versuch ist technisch gescheitert (Timeout, DNS, HTTP-Fehler, Absturz) – nur der VPS weiss das.
export function crmAdmission(l, { auditFailed = false } = {}) {
  const e = errs(l), n = verifiedErrorCount(l);
  if (n >= 1) return { active: true, state: "VERIFIED_ERRORS", count: n };
  // Kunde bzw. Lead mit Reparaturauftrag (errors.repair): Auftrag, Zahlung, Provision und Kundenhistorie bleiben sichtbar.
  if (l?.customer === true || (e.repair && typeof e.repair === "object")) return { active: true, state: "CUSTOMER", count: 0 };
  if (l?.contact_form?.lead_source === "CONTACT_FORM") return { active: true, state: "CONTACT_FORM_INBOUND", count: 0 };
  // 0 Fehler aus einem VOLLSTÄNDIGEN Audit (aktuell oder veraltet) = geprüft und sauber.
  if ((e.audit === "FULL" || (e.audit === "STALE" && !!e.full_checked_at)) && Number.isInteger(e.count)) return { active: false, state: "NO_VERIFIED_ERRORS", count: 0 };
  if (auditFailed) return { active: false, state: "AUDIT_FAILED", count: 0 };
  if (e.audit === "PARTIAL" || e.audit === "STALE") return { active: false, state: "AUDIT_INCOMPLETE", count: 0 };
  return { active: false, state: "AUDIT_RETRY_REQUIRED", count: 0 };
}
export const crmActive = (l) => !!l && crmAdmission(l).active;
// Übertragung/Speicher (Netlify-Limit 6 MB je Anfrage/Antwort): errors.top ist immer items[0..1] → weglassen, topIssues leitet es ab.
export function compactCrmLead(l) {
  const e = l?.errors;
  if (!e || !Array.isArray(e.top) || !e.top.length || !Array.isArray(e.items) || !e.items.length) return l;
  const same = e.top.every((f, i) => f?.key && e.items[i]?.key === f.key);
  return same ? { ...l, errors: { ...e, top: [] } } : l;
}

// ---------- TF-059: konkrete CRM-Fehlerzeile (NUR intern für Chris – der Cold-Mail-Kundentext bleibt kurz und natürlich) ----------
// QUELLSEITE → ELEMENT, darunter ZIEL → TATSÄCHLICH BEOBACHTET. Nur belegte Werte: unbekannter HTTP-Status → „Zielseite nicht
// erreichbar“, unbekannter Linktext → „Link zu /pfad/“, unbekannte Seite → „Seite unbekannt“. Gleiche Domain → nur Pfad (ohne Query).
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const urlOf = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x : null; } catch { return null; } };
const hostOf = (x) => x.hostname.toLowerCase().replace(/^www\./, "");
const pathText = (x) => { let p = x.pathname || "/"; try { p = decodeURI(p); } catch {} return cut(p, 60); };
export const ISSUE_WORDS_DE = Object.freeze({ home: "Startseite", unknownPage: "Seite unbekannt", linkTo: (t) => `Link zu ${t}`, contactLink: "Link zur Kontaktseite", link: "Link",
  http: (s) => `HTTP ${s}`, unreachable: "Zielseite nicht erreichbar", image: (f) => (f ? `Bild «${f}»` : "Bild"), imgFail: (s) => (s ? `lädt nicht / HTTP ${s}` : "lädt nicht"),
  mailLink: "E-Mail-Link", mailBad: "ungültige E-Mail-Adresse im Link", form: (l) => (l ? `Kontaktformular · «${l}»` : "Kontaktformular"), formFail: "Absenden reproduzierbar fehlgeschlagen",
  button: (l) => (l ? `Button «${l}»` : "Button"), buttonFail: "funktioniert nicht", mobile: (s) => `Mobile / ${s}`, areaUnknown: "Bereich unbekannt",
  overlap: "überlappt Inhalt", cut: "abgeschnitten", atPx: (v) => ` bei ${v} px`, pageRender: "Seitendarstellung", desktopWidth: "Desktop-Breite, verkleinert",
  shifted: "verschoben dargestellt", siteCall: "Website-Aufruf", loop: "Weiterleitungsschleife – lädt nicht", cert: "Browser zeigt Zertifikatswarnung", error: "Fehler" });
export function issueFacts(f = {}, w = ISSUE_WORDS_DE) {
  const page = urlOf(f.page), target = urlOf(f.target);
  const source = page ? (page.pathname === "/" ? w.home : pathText(page)) : w.unknownPage;
  // Externe Ziele bereinigt und gekürzt (Host + Pfad, nie Query/Fragment); gleiche Domain → nur Pfad.
  const tgt = target ? (page && hostOf(target) === hostOf(page) ? pathText(target) : cut(`${hostOf(target)}${target.pathname === "/" ? "" : pathText(target)}`, 60)) : null;
  const status = Number.isInteger(f.http_status) && f.http_status >= 100 && f.http_status <= 599 ? f.http_status : null;
  const label = typeof f.label === "string" && f.label.trim() ? cut(f.label.trim(), 40) : null;
  const loc = typeof f.location === "string" && f.location.trim() ? cut(f.location.trim(), 40) : null;
  const vp = Number.isInteger(f.viewport) ? f.viewport : null;
  const file = target ? cut((() => { const s = target.pathname.split("/").filter(Boolean).pop() || ""; try { return decodeURIComponent(s); } catch { return s; } })(), 40) : null;
  const base = { source, target: tgt, http_status: status, label, location: loc, viewport: vp };
  switch (f.type) {
    case "broken_link": case "contact_page_broken":
      return { ...base, element: label ? `«${label}»` : tgt ? w.linkTo(tgt) : f.type === "contact_page_broken" ? w.contactLink : w.link, result: status ? w.http(status) : w.unreachable };
    case "broken_image":
      return { ...base, element: w.image(file), result: w.imgFail(status) };
    case "broken_mailto":
      return { ...base, element: w.mailLink, target: null, result: w.mailBad };
    case "contact_form_broken":
      return { ...base, element: w.form(loc), target: null, result: w.formFail };
    case "button_broken":
      return { ...base, element: w.button(loc), target: null, result: w.buttonFail };
    case "mobile_text_overlap": case "mobile_content_cut_off":
      return { ...base, source: w.mobile(source), element: loc ? `«${loc}»` : w.areaUnknown, target: null,
        result: `${f.type === "mobile_text_overlap" ? w.overlap : w.cut}${vp ? w.atPx(vp) : ""}` };
    case "no_mobile_viewport":
      return { ...base, source: w.mobile(source), element: w.pageRender, target: null, result: w.desktopWidth };
    case "visible_layout_error":
      return { ...base, element: loc ? `«${loc}»` : w.areaUnknown, target: null, result: w.shifted };
    case "redirect_loop":
      return { ...base, element: w.siteCall, target: null, result: w.loop };
    case "https_certificate":
      return { ...base, element: w.siteCall, target: null, result: w.cert };
    default: // z. B. historischer Fund ohne Typ: ehrlich reduziert – nur der vorhandene Kurztext
      return { ...base, element: null, result: null };
  }
}
// Kompakt (Top 2, 2 Zeilen): title „Startseite → «Kontakt»“, detail „/kontakt/ → HTTP 404“.
export function issueLines(f = {}, w = ISSUE_WORDS_DE, text = typeof f.text === "string" ? f.text : "") {
  const x = issueFacts(f, w);
  if (!x.element) return { title: x.source === w.unknownPage ? text || w.error : `${x.source} → ${text || w.error}`, detail: null };
  // Ziel steht schon im Element („Link zu /kontakt/“) → nicht doppelt.
  const tgt = x.target && !x.element.includes(x.target) ? x.target : null;
  return { title: `${x.source} → ${x.element}`, detail: [tgt, x.result].filter(Boolean).join(" → ") || null };
}
// ---------- TF-072: Direktlink je Fehler (betroffene Seite) ----------
// Nur sichere öffentliche http(s)-Adressen: kein javascript:/data:/file:, keine Zugangsdaten in der URL, nur Standard-Ports, kein
// localhost/.local/.internal, keine IP-Literale aus privaten/reservierten Netzen, keine IPv6-Literale. Reine Anzeige/Navigation –
// Jarvis ruft diese Adressen hier nie ab.
const ip4 = (s) => s.split(".").reduce((a, p) => a * 256 + Number(p), 0);
const PRIVATE_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"].map((c) => { const [a, n] = c.split("/"); return [ip4(a), Number(n)]; });
const LOCAL_HOST_RE = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion|home\.arpa|in-addr\.arpa|ip6\.arpa)$/;
export function safePublicUrl(u) {
  if (typeof u !== "string" || !u || u.length > 400 || /[\s<>"'`\\\u0000-\u001f\u007f]/.test(u)) return null;
  let x; try { x = new URL(u); } catch { return null; }
  if (!["http:", "https:"].includes(x.protocol) || x.username || x.password || x.port) return null;
  const h = x.hostname.toLowerCase().replace(/\.$/, "");
  if (!h || h.startsWith("[") || h.includes(":")) return null;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const ip = ip4(h);
    if (v4.slice(1).some((p) => Number(p) > 255) || PRIVATE_V4.some(([b, n]) => Math.floor(ip / 2 ** (32 - n)) === Math.floor(b / 2 ** (32 - n)))) return null;
    return x.href;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(h) || LOCAL_HOST_RE.test(h)) return null;
  return x.href;
}
// Betroffene Seite = die geprüfte Seite, auf der der Fehler sichtbar ist (affected_url, ältere Befunde: page). Unbekannt → null
// (Anzeige „Direktlink nicht verfügbar“) – nie die Startseite oder eine erratene Adresse als Ersatz. Ziel (nur Link-/Bild-Fehler):
// die kaputte Zieladresse selbst.
const TARGET_LINK_TYPES = new Set(["broken_link", "contact_page_broken", "broken_image"]);
export function issueLink(f = {}) {
  // affected_url vorhanden (auch null = geprüft, aber unbekannt/unsicher) → massgeblich; nur ältere Befunde ohne das Feld nutzen page.
  const affected_url = safePublicUrl(f?.affected_url !== undefined ? f.affected_url : f?.page);
  const target = TARGET_LINK_TYPES.has(f?.type) ? safePublicUrl(f?.target_url ?? f?.target) : null;
  return { affected_url, target_url: target && target !== affected_url ? target : null };
}
// Verifizierte Fehler eines Leads einzeln mit Direktlink (Detail, Anrufansicht, Calling-Agent): nie zusammengefasst, nie erfunden.
export function currentIssues(lead, max = 40) {
  const items = Array.isArray(errs(lead).items) && errs(lead).items.length ? errs(lead).items : Array.isArray(errs(lead).top) ? errs(lead).top : [];
  return items.filter((f) => f && typeof f === "object" && f.status !== "RESOLVED" && (f.crm_title || f.text)).slice(0, max);
}
export function issueLinks(lead, max = 40) {
  return currentIssues(lead, max).map((f) => ({ key: f.key || null, type: f.type || null, category: ISSUE_CATEGORIES.includes(f.category) ? f.category : "other", severity: f.severity || null,
      text: f.text || null, title: f.crm_title || f.text, detail: f.crm_detail || null, ...issueLink(f) }));
}

// ---------- TF-076: verständliche Fehlerbeschreibung je verifiziertem Befund (Verkäufer-tauglich, nur belegte Fakten) ----------
// FEHLER (short_title) · SEITE (affected_url) · POSITION (page_location) · WARUM FEHLER (evidence) · AUSWIRKUNG (impact) · verified_at.
// Position nur aus belegten Audit-Fakten: Seitenbereich (area: header/nav/main/aside/footer), nächste Überschrift (heading), Linktext/
// Bild-Alt-Text (label), benannter Bereich (location). Unbekannt → ehrlicher Ersatztext, nie ein erfundener Selektor/Abschnitt.
export const ISSUE_AREAS = Object.freeze(["header", "nav", "main", "aside", "footer"]);
export const DETAIL_WORDS_DE = Object.freeze({
  area: { header: "Kopfbereich", nav: "Hauptmenü", main: "Inhaltsbereich", aside: "Seitenleiste", footer: "Footer" },
  section: (h) => `Abschnitt «${h}»`, sep: " → ", quote: (s) => `«${s}»`, whole: "Gesamte Website (beim Aufruf)", wholePage: "Ganze Seite",
  unknownPos: "Genaue Position nicht automatisch bestimmbar", noPos: "Position nicht verfügbar", linkWord: "Link", imageWord: "Bild", mailWord: "E-Mail-Link",
  title: { broken_link: "Kaputter Link", contact_page_broken: "Kontaktseite nicht erreichbar", broken_image: "Bild wird nicht geladen", broken_mailto: "Fehlerhafter E-Mail-Link",
    contact_form_broken: "Kontaktformular sendet nicht", button_broken: "Button ohne Funktion", mobile_text_overlap: "Text überlappt auf dem Handy",
    mobile_content_cut_off: "Inhalt auf dem Handy abgeschnitten", no_mobile_viewport: "Nicht für Handys angepasst", visible_layout_error: "Darstellungsfehler",
    redirect_loop: "Website lädt nicht", https_certificate: "Sicherheitswarnung im Browser" },
  link: (label, target, status) => `Der Link${label ? ` «${label}»` : ""} verweist auf ${target || "eine Unterseite"}. ${status ? `Die Zielseite liefert HTTP ${status} (Fehlerseite).` : "Die Zielseite ist nicht erreichbar."}`,
  contactLink: (label, target, status) => `Der Link zur Kontaktseite${label ? ` («${label}»)` : ""} verweist auf ${target || "die Kontaktseite"}. ${status ? `Diese liefert HTTP ${status} (Fehlerseite).` : "Diese ist nicht erreichbar."}`,
  image: (file, status) => `Das Bild${file ? ` «${file}»` : ""} verweist auf eine Datei, die ${status ? `HTTP ${status} liefert` : "nicht geladen werden kann"}. Das Bild wird nicht angezeigt.`,
  mailto: "Der E-Mail-Link enthält keine gültige E-Mail-Adresse. Ein Klick öffnet keine korrekte E-Mail an die Firma.",
  form: "Das Kontaktformular konnte bei der Prüfung reproduzierbar nicht abgesendet werden.",
  button: (l) => `Der Button${l ? ` «${l}»` : ""} reagiert bei der Prüfung nicht.`,
  overlap: (vp) => `Auf dem Handy${vp ? ` (${vp} px Breite)` : ""} überlappt Text mit anderen Inhalten.`,
  cutoff: (vp) => `Auf dem Handy${vp ? ` (${vp} px Breite)` : ""} ist Inhalt abgeschnitten.`,
  viewport: "Die Seite hat keine Handy-Einstellung (viewport). Smartphones zeigen sie verkleinert in Desktop-Breite.",
  layout: "Der Bereich wird verschoben dargestellt.", loop: "Beim Aufruf leitet die Website endlos weiter (Weiterleitungsschleife). Die Seite lädt nicht.",
  cert: "Beim Öffnen meldet der Browser ein Problem mit dem Sicherheitszertifikat.",
  impact: { broken_link: "Besucher landen auf einer Fehlerseite statt beim gewünschten Inhalt.", contact_page_broken: "Interessenten finden die Kontaktseite nicht – Anfragen können verloren gehen.",
    broken_image: "Auf der Seite fehlt ein Bild; sie wirkt unvollständig.", broken_mailto: "Besucher können über diesen Link keine E-Mail senden.",
    contact_form_broken: "Anfragen über das Formular kommen nicht an.", button_broken: "Besucher kommen über diesen Button nicht weiter.",
    mobile_text_overlap: "Auf dem Handy ist der Text schwer lesbar.", mobile_content_cut_off: "Auf dem Handy fehlen Teile des Inhalts.",
    no_mobile_viewport: "Auf dem Handy ist die Seite schwer lesbar und bedienbar.", visible_layout_error: "Die Seite wirkt an dieser Stelle fehlerhaft.",
    redirect_loop: "Besucher sehen die Website gar nicht.", https_certificate: "Viele Besucher brechen beim Warnhinweis ab." },
});
const pathOrUrl = (t, page) => { const x = urlOf(t); if (!x) return null; const p = urlOf(page); return p && hostOf(x) === hostOf(p) ? pathText(x) : cut(`${hostOf(x)}${x.pathname === "/" ? "" : pathText(x)}`, 60); };
const fileOf = (t) => { const x = urlOf(t); if (!x) return null; const s = x.pathname.split("/").filter(Boolean).pop() || ""; let d = s; try { d = decodeURIComponent(s); } catch {} return d ? cut(d, 40) : null; };
const short40 = (s) => (typeof s === "string" && s.trim() ? cut(s.trim().replace(/\s+/g, " "), 40) : null);
const SITE_WIDE = new Set(["redirect_loop", "https_certificate"]);
// Position aus belegten Fakten: Bereich → Überschrift → Element. Ganz ohne Fakten: Ersatztext (Seite bekannt) bzw. „nicht verfügbar“.
export function issuePosition(f = {}, w = DETAIL_WORDS_DE) {
  if (SITE_WIDE.has(f.type)) return { text: w.whole, known: true };
  if (f.type === "no_mobile_viewport") return { text: w.wholePage, known: true };
  const area = ISSUE_AREAS.includes(f.area) ? w.area[f.area] : null, heading = short40(f.heading), label = short40(f.label), loc = short40(f.location);
  const element = ["broken_link", "contact_page_broken", "broken_mailto"].includes(f.type) ? (label ? w.quote(label) : null)
    : f.type === "broken_image" ? (label ? `${w.imageWord} ${w.quote(label)}` : null) : loc ? w.quote(loc) : null;
  // Kopfbereich/Menü/Footer sind für den Anrufer eindeutig; im Inhalt ist „Abschnitt «Team»“ genauer als „Inhaltsbereich“.
  const where = ["header", "nav", "footer"].includes(f.area) ? area : heading ? w.section(heading) : area;
  const parts = [where, element].filter(Boolean);
  if (parts.length) return { text: parts.join(w.sep), known: true };
  // Typisierter Befund (Seite geprüft, Stelle nicht bestimmbar) vs. älterer Befund ohne Typ/Positionsdaten.
  return { text: f.type ? w.unknownPos : w.noPos, known: false };
}
export function issueDetail(f = {}, w = DETAIL_WORDS_DE, fallbackText = typeof f.text === "string" ? f.text : "") {
  const status = Number.isInteger(f.http_status) && f.http_status >= 100 && f.http_status <= 599 ? f.http_status : null;
  const label = short40(f.label), page = f.affected_url !== undefined ? f.affected_url : f.page, tgt = pathOrUrl(f.target_url ?? f.target, page);
  const vp = Number.isInteger(f.viewport) ? f.viewport : null;
  const ev = { broken_link: () => w.link(label, tgt, status), contact_page_broken: () => w.contactLink(label, tgt, status), broken_image: () => w.image(fileOf(f.target_url ?? f.target), status),
    broken_mailto: () => w.mailto, contact_form_broken: () => w.form, button_broken: () => w.button(short40(f.location)), mobile_text_overlap: () => w.overlap(vp),
    mobile_content_cut_off: () => w.cutoff(vp), no_mobile_viewport: () => w.viewport, visible_layout_error: () => w.layout, redirect_loop: () => w.loop, https_certificate: () => w.cert }[f.type];
  const pos = issuePosition(f, w);
  return { error_type: typeof f.type === "string" ? f.type : null, short_title: w.title[f.type] || fallbackText || null,
    // Ohne Typ (ältere Befunde): der gespeicherte, bereits verifizierte Kurztext – nichts hinzuerfunden.
    plain_language_description: ev ? ev() : fallbackText || null, evidence: ev ? ev() : fallbackText || null,
    impact: w.impact[f.type] || null, page_location: pos.text, location_known: pos.known, ...issueLink(f), verified_at: typeof f.verified_at === "string" ? f.verified_at : null };
}
export const issueDetails = (lead, max = 40, w = DETAIL_WORDS_DE, textOf = (f) => f.text || "") => currentIssues(lead, max).map((f) => ({ key: f.key || null, ...issueDetail(f, w, textOf(f)) }));

// Reparatur-Stand (nach CHF-480): „Automatisch repariert + 2 manuelle Punkte offen“.
export function repairLine(l, w = ERR_WORDS_DE) {
  const r = errs(l).repair;
  if (!r) return null;
  if (r.state === "COMPLETED_WITH_MANUAL_ITEMS" || r.manual_open) return w.repairManual(r.repaired, r.manual_open);
  return w.repairDone(r.repaired);
}
// Übersicht Website-Fehler (nur Anzeige/Schnellfilter – nie eine Outreach-Automatik).
export const ERROR_CARDS = Object.freeze({
  err_0: { label: "0 verifizierte Fehler", test: (l) => errorBucket(l) === "0" },
  err_1_2: { label: "1–2 Fehler", test: (l) => errorBucket(l) === "1-2" },
  err_3_5: { label: "3–5 Fehler", test: (l) => errorBucket(l) === "3-5" },
  err_6: { label: "6+ Fehler", test: (l) => errorBucket(l) === "6+" },
  audit_full: { label: "Vollständig geprüft", test: (l) => errs(l).audit === "FULL" },
  audit_partial: { label: "Nur teilgeprüft", test: (l) => errs(l).audit === "PARTIAL" },
});

// ---------- Pipeline (TF-057): qualifizierte Leads gesamt und davon je genau EINE Phase – Summe = gesamt ----------
// Damit „1150 qualifizierte Leads“ nie mit „396 Entwürfe“ verwechselt wird. Kontaktiert = manuell gesendet, Antwort oder spätere Stufe.
const CONTACTED_STAGES = ["CONTACTED", "FOLLOW_UP", "INTERESTED", "CHECK_150_INTEREST", "REPAIR_480_INTEREST", "NOT_INTERESTED", "CLOSED"];
export function pipelinePhase(l) {
  if (!l) return null;
  if (l.customer || l.sales_stage === "CUSTOMER") return "customer";
  if (l.manual_sent || l.replied || CONTACTED_STAGES.includes(l.sales_stage) || ["EMAIL_SENT", "CALLED", "REACHED", "REPLIED", "MEETING"].includes(l.contact_status)) return "contacted";
  if (l.draft_status === "DRAFT") return "draft_ready";
  if (l.draft_status === "QUEUED") return "waiting_draft";
  return "no_draft";
}
export const PIPELINE_CARDS = Object.freeze({
  pipe_waiting: { label: "Wartet auf Entwurf", test: (l) => pipelinePhase(l) === "waiting_draft" },
  pipe_no_draft: { label: "Ohne Entwurf (nicht eingeplant)", test: (l) => pipelinePhase(l) === "no_draft" },
  pipe_draft: { label: "Entwurf bereit", test: (l) => pipelinePhase(l) === "draft_ready" },
  pipe_contacted: { label: "Kontaktiert", test: (l) => pipelinePhase(l) === "contacted" },
  pipe_customer: { label: "Kunde", test: (l) => pipelinePhase(l) === "customer" },
});

// ---------- Priorität: einfache, transparente Punkte (kein „Kaufwahrscheinlichkeits-Score“) ----------
export function priorityOf(lead) {
  const reasons = [];
  let score = 0;
  const add = (pts, why) => { score += pts; reasons.push(`${pts > 0 ? "+" : ""}${pts} ${why}`); };
  const findings = (lead?.findings || []).filter((f) => f.confirmed !== false);
  const contact = findings.some(isContactPathFinding);
  if (contact) add(3, "Kontakt-/Reservations-/Bestellproblem");
  if (findings.some((f) => !isContactPathFinding(f))) add(2, "weitere wichtige kaputte Seite");
  if (lead?.phone) add(2, "Telefon vorhanden");
  if (lead?.first_name && lead?.last_name) add(1, "Ansprechpartner vorhanden");
  if (findings.length >= 2) add(1, "2+ Befunde");
  if (contactFormOpen(lead)) add(20, "Kontaktformular-Anfrage (P0)");
  if (lead?.contact_form?.call_eligibility === "CALLBACK_REQUESTED" && contactFormOpen(lead)) add(3, "Rückruf erbeten");
  if (lead?.do_not_contact) add(-10, "Do Not Contact");
  if (lead?.sales_stage === "NOT_INTERESTED" || lead?.call_status === "NOT_INTERESTED") add(-5, "kein Interesse");
  const level = lead?.do_not_contact ? "LOW" : score >= 6 ? "HIGH" : score >= 3 ? "MEDIUM" : "LOW";
  return { score, level, reasons };
}
// Anruf-Empfehlung: nur mit Geschäftsnummer, nie bei Do Not Contact, abgeschlossenen Stufen oder „nicht anrufen“.
// TF-077B: ausdrücklich belegtes Telefonbuch-Sternchen → nie eine Anruf-Empfehlung (unabhängig von CONTACT_FORM_P0).
export const callRecommended = (l) => !!l?.phone && !l.do_not_contact && !l.archived && !CLOSED_STAGES.includes(l.sales_stage) && !NO_CALL_STATUSES.includes(l.call_status)
  && l.phonebook?.status !== "PHONEBOOK_STAR_PRESENT";
// Outreach-Queue (nur Anzeige, nie Versand): offene Leads ohne Sperre.
export const inOutreachQueue = (l) => !!l && !l.do_not_contact && !l.archived && ["NEW", "DRAFT_READY", "TO_CONTACT", "FOLLOW_UP"].includes(l.sales_stage);

// ---------- Suche, Filter, Sortierung ----------
export const FILTER_KEYS = Object.freeze(["q", "stage", "canton", "region", "category", "phone", "person", "draft", "problems", "errors", "audit", "issue", "contact", "call", "followup", "dnc", "archived", "card"]);
const has = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle).toLowerCase());
const digits = (s) => String(s || "").replace(/\D+/g, "");
export function searchMatch(l, q) {
  const s = String(q || "").trim();
  if (!s) return true;
  if ([l.company, l.domain, l.email, l.first_name, l.last_name, l.municipality, l.region, l.category, `${l.first_name || ""} ${l.last_name || ""}`].some((v) => has(v, s))) return true;
  const d = digits(s);
  if (d.length >= 3) { const p = digits(l.phone); if (p.includes(d) || p.replace(/^41/, "0").includes(d)) return true; }
  return false;
}
// Übersichtskarten = Schnellfilter (Zähler und Filter benutzen dieselbe Definition).
export const CARDS = Object.freeze({
  all: { label: "Alle Leads", test: () => true },
  contact_form: { label: "Kontaktformular – sofort", test: (l) => contactFormOpen(l) }, // TF-077B: CONTACT FORM HOT LEADS
  new: { label: "Neu", test: (l) => l.sales_stage === "NEW" },
  to_contact: { label: "Zu kontaktieren", test: (l) => !l.do_not_contact && ["DRAFT_READY", "TO_CONTACT"].includes(l.sales_stage) },
  contacted: { label: "Kontaktiert", test: (l) => ["CONTACTED", "FOLLOW_UP"].includes(l.sales_stage) },
  interested: { label: "Interessiert", test: (l) => ["INTERESTED", "CHECK_150_INTEREST", "REPAIR_480_INTEREST"].includes(l.sales_stage) },
  follow_ups: { label: "Follow-ups", test: (l, now) => ["TODAY", "OVERDUE"].includes(followUpBucket(l, now)) },
  customers: { label: "Kunden", test: (l) => l.sales_stage === "CUSTOMER" },
  dnc: { label: "Do Not Contact", test: (l) => !!l.do_not_contact },
  with_phone: { label: "Mit Telefonnummer", test: (l) => !!l.phone },
  with_person: { label: "Mit Ansprechpartner", test: (l) => !!(l.first_name && l.last_name) },
  with_draft: { label: "Mit Draft", test: (l) => l.draft_status === "DRAFT" },
  with_findings: { label: "Mit 1+ Website-Fehler", test: (l) => (l.findings_confirmed || 0) >= 1 },
  history: { label: "Historische Funde", test: (l) => !!l.history_badge }, // TF-058: nur Anzeige – nie eine Outreach-Quelle
});
// TF-058 Abzeichen historischer Discovery-Funde (low_score/no_contact/Backup/Recheck).
export const HISTORY_LABEL = Object.freeze({ HISTORICAL: "HISTORISCHER FUND", REVERIFIED: "ERNEUT VERIFIZIERT" });
// TF-075A: Kontaktformular-Anfrage (nur zugeordnete Leads): Abzeichen + Status.
// TF-077B: deutsche Abzeichen (KONTAKTFORMULAR · NEU · ANTWORT GESENDET · SOFORT BEARBEITEN · RÜCKRUF · NICHT ANRUFBAR).
export const CONTACT_FORM_LABEL = Object.freeze({ badge: "KONTAKTFORMULAR", matched: "ZUGEORDNET", NEW: "NEU", DRAFT_CREATED: "ENTWURF ERSTELLT", REVIEW_REQUIRED: "PRÜFEN",
  REPLY_SENT: "ANTWORT GESENDET", urgent: "SOFORT BEARBEITEN", CALLBACK_REQUESTED: "RÜCKRUF", CALL_NOT_CURRENTLY_ELIGIBLE: "NICHT ANRUFBAR" });
const yes = (v) => v === "1" || v === "yes" || v === true;
const no = (v) => v === "0" || v === "no" || v === false;
export function filterLeads(list = [], f = {}, now = new Date()) {
  return list.filter((l) => {
    if (!(f.archived === "only" ? l.archived : f.archived === "all" ? true : !l.archived)) return false;
    const card = CARDS[f.card] || ERROR_CARDS[f.card] || PIPELINE_CARDS[f.card];
    if (f.card && card && !card.test(l, now)) return false;
    if (!searchMatch(l, f.q)) return false;
    if (f.stage && l.sales_stage !== f.stage) return false;
    if (f.canton && l.canton !== f.canton) return false;
    if (f.region && l.region !== f.region) return false; // TF-063: VN-Verwaltungseinheit
    if (f.category && l.category !== f.category) return false;
    if (yes(f.phone) && !l.phone) return false; if (no(f.phone) && l.phone) return false;
    const person = !!(l.first_name && l.last_name);
    if (yes(f.person) && !person) return false; if (no(f.person) && person) return false;
    const draft = l.draft_status === "DRAFT";
    if (yes(f.draft) && !draft) return false; if (no(f.draft) && draft) return false;
    const n = l.findings_confirmed || 0;
    if (f.problems === "0" && n !== 0) return false;
    if (f.problems === "1+" && n < 1) return false;
    if (["1", "2", "3"].includes(f.problems) && n !== Number(f.problems)) return false;
    if (f.problems === "4+" && (l.findings_total || 0) < 4) return false;
    // TF-055: Fehlerzahl, Audit-Art, wichtigstes Problem (Kategorie eines der zwei wichtigsten Fehler).
    if (ERROR_BUCKETS.includes(f.errors) && errorBucket(l) !== f.errors) return false;
    if (f.audit && AUDIT_LABEL[f.audit] && errs(l).audit !== f.audit) return false;
    if (f.issue && ISSUE_LABEL[f.issue] && !topIssues(l).some((x) => x.category === f.issue)) return false;
    if (f.contact && l.contact_status !== f.contact) return false;
    if (f.call && l.call_status !== f.call) return false;
    const fu = followUpBucket(l, now);
    if (f.followup === "due" && !["TODAY", "OVERDUE"].includes(fu)) return false;
    if (["TODAY", "OVERDUE", "LATER"].includes(f.followup) && fu !== f.followup) return false;
    if (f.followup === "none" && fu) return false;
    if (yes(f.dnc) && !l.do_not_contact) return false; if (no(f.dnc) && l.do_not_contact) return false;
    return true;
  });
}
export const SORTS = Object.freeze({
  priority: { label: "Priorität", cmp: (a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0) },
  company: { label: "Firma", cmp: (a, b) => String(a.company || a.domain || "").localeCompare(String(b.company || b.domain || ""), "de", { sensitivity: "base", numeric: true }) },
  problems: { label: "Anzahl Fehler", cmp: (a, b) => (errorCount(b) ?? -1) - (errorCount(a) ?? -1) || (b.errors?.audit === "FULL") - (a.errors?.audit === "FULL") },
  stage: { label: "Status", cmp: (a, b) => SALES_STAGES.indexOf(a.sales_stage) - SALES_STAGES.indexOf(b.sales_stage) },
  last_contact: { label: "Letzter Kontakt", cmp: (a, b) => String(b.last_contact_at || "").localeCompare(String(a.last_contact_at || "")) },
  follow_up: { label: "Nächster Follow-up", cmp: (a, b) => (a.next_action_at ? 0 : 1) - (b.next_action_at ? 0 : 1) || String(a.next_action_at || "").localeCompare(String(b.next_action_at || "")) },
  updated: { label: "Zuletzt aktualisiert", cmp: (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")) },
});
// TF-077B kanonische Reihenfolge: offene Kontaktformular-Anfragen stehen IMMER zuoberst (älteste unbeantwortete zuerst) – in jeder Sortierung.
// In der Standardsortierung (Priorität) folgen ausdrückliche Rückrufe/heisse Leads, dann die übrigen qualifizierten Leads.
export function sortLeads(list = [], key = "priority", now = new Date()) {
  const s = SORTS[key] || SORTS.priority;
  const rank = (l) => (s === SORTS.priority ? hotRank(l, now) : contactFormOpen(l) ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (contactFormOpen(a) && contactFormOpen(b) ? cfOrder(a, b) : 0) || s.cmp(a, b) || SORTS.company.cmp(a, b));
}
// „Next best lead“: höchste Priorität unter den offenen, nicht gesperrten Leads (Anzeige – keine Aktion).
export function nextBestLead(list = []) {
  return sortLeads(list.filter(inOutreachQueue), "priority")[0] || null;
}
export function crmStats(list = [], now = new Date()) {
  const out = {};
  for (const [k, c] of Object.entries({ ...CARDS, ...ERROR_CARDS, ...PIPELINE_CARDS })) out[k] = list.filter((l) => !l.archived || k === "all").filter((l) => c.test(l, now)).length;
  out.archived = list.filter((l) => l.archived).length;
  out.all = list.filter((l) => !l.archived).length;
  out.follow_ups_overdue = list.filter((l) => followUpBucket(l, now) === "OVERDUE").length;
  // TF-077B: getrennte Zähler – gescrapte Leads mit ≥ 1 verifiziertem Fehler vs. offene Kontaktformular-Anfragen (inkl. Inbound ohne Fehler).
  out.verified_error_leads = list.filter((l) => !l.archived && verifiedErrorCount(l) >= 1).length;
  out.contact_form_hot = list.filter(contactFormOpen).length;
  out.contact_form_inbound = list.filter((l) => !l.archived && crmAdmission(l).state === "CONTACT_FORM_INBOUND").length;
  return out;
}

// ---------- CSV (Semikolon + UTF-8-BOM, wie lead-db.js) – keine internen IDs ----------
const fmtDay = (iso) => { if (!iso) return ""; if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.split("-").reverse().join("."); const d = new Date(iso); return Number.isNaN(+d) ? "" : new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" }).format(d); };
export const CSV_COLUMNS = Object.freeze([
  ["Firma", (l) => l.company], ["Website", (l) => l.website], ["E-Mail", (l) => l.email], ["Telefon", (l) => l.phone],
  ["Vorname", (l) => l.first_name], ["Nachname", (l) => l.last_name], ["Rolle", (l) => l.role],
  ["Probleme", (l) => l.findings_total || 0], ["Probleme (Text)", (l) => (l.findings || []).map((f) => f.text).join(" | ")],
  ["Sales Stage", (l) => STAGE_LABEL[l.sales_stage] || l.sales_stage], ["Call Status", (l) => CALL_LABEL[l.call_status] || l.call_status],
  ["Letzter Kontakt", (l) => fmtDay(l.last_contact_at)], ["Nächster Schritt", (l) => l.next_action], ["Follow-up", (l) => fmtDay(l.next_action_at)],
  ["Notizen vorhanden", (l) => ((l.notes || []).length || (l.call_history || []).some((c) => c.note) ? "ja" : "nein")],
]);
const cell = (v) => {
  let s = v == null ? "" : String(v).replace(/[\r\n]+/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = "'" + s; // keine Formel-Injection; „+41 …“ bleibt Text
  return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// TF-063: labels (optional, i18n.js csvLabelsFor) übersetzen Kopfzeile und Statuswörter – die Daten selbst bleiben unverändert.
export function crmToCsv(list = [], labels = null) {
  const cols = labels ? CSV_COLUMNS.map(([h, f], i) => [labels.headers?.[i] || h, i === 9 ? (l) => labels.stage?.[l.sales_stage] || l.sales_stage
    : i === 10 ? (l) => labels.call?.[l.call_status] || l.call_status : i === 14 ? (l) => (f(l) === "ja" ? labels.yes : labels.no) : f]) : CSV_COLUMNS;
  const rows = [cols.map(([h]) => h).join(";"), ...list.map((l) => cols.map(([, f]) => cell(f(l))).join(";"))];
  return "﻿" + rows.join("\r\n") + "\r\n";
}
