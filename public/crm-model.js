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
export const DRAFT_LABEL = Object.freeze({ DRAFT: "Entwurf", MANUALLY_SENT: "Manuell gesendet", NO_LONGER_DRAFT: "Kein Entwurf mehr", SKIPPED: "Übersprungen" });
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
  if (lead?.do_not_contact) add(-10, "Do Not Contact");
  if (lead?.sales_stage === "NOT_INTERESTED" || lead?.call_status === "NOT_INTERESTED") add(-5, "kein Interesse");
  const level = lead?.do_not_contact ? "LOW" : score >= 6 ? "HIGH" : score >= 3 ? "MEDIUM" : "LOW";
  return { score, level, reasons };
}
// Anruf-Empfehlung: nur mit Geschäftsnummer, nie bei Do Not Contact, abgeschlossenen Stufen oder „nicht anrufen“.
export const callRecommended = (l) => !!l?.phone && !l.do_not_contact && !l.archived && !CLOSED_STAGES.includes(l.sales_stage) && !NO_CALL_STATUSES.includes(l.call_status);
// Outreach-Queue (nur Anzeige, nie Versand): offene Leads ohne Sperre.
export const inOutreachQueue = (l) => !!l && !l.do_not_contact && !l.archived && ["NEW", "DRAFT_READY", "TO_CONTACT", "FOLLOW_UP"].includes(l.sales_stage);

// ---------- Suche, Filter, Sortierung ----------
export const FILTER_KEYS = Object.freeze(["q", "stage", "canton", "category", "phone", "person", "draft", "problems", "contact", "call", "followup", "dnc", "archived", "card"]);
const has = (hay, needle) => String(hay || "").toLowerCase().includes(String(needle).toLowerCase());
const digits = (s) => String(s || "").replace(/\D+/g, "");
export function searchMatch(l, q) {
  const s = String(q || "").trim();
  if (!s) return true;
  if ([l.company, l.domain, l.email, l.first_name, l.last_name, l.municipality, `${l.first_name || ""} ${l.last_name || ""}`].some((v) => has(v, s))) return true;
  const d = digits(s);
  if (d.length >= 3) { const p = digits(l.phone); if (p.includes(d) || p.replace(/^41/, "0").includes(d)) return true; }
  return false;
}
// Übersichtskarten = Schnellfilter (Zähler und Filter benutzen dieselbe Definition).
export const CARDS = Object.freeze({
  all: { label: "Alle Leads", test: () => true },
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
});
const yes = (v) => v === "1" || v === "yes" || v === true;
const no = (v) => v === "0" || v === "no" || v === false;
export function filterLeads(list = [], f = {}, now = new Date()) {
  return list.filter((l) => {
    if (!(f.archived === "only" ? l.archived : f.archived === "all" ? true : !l.archived)) return false;
    if (f.card && CARDS[f.card] && !CARDS[f.card].test(l, now)) return false;
    if (!searchMatch(l, f.q)) return false;
    if (f.stage && l.sales_stage !== f.stage) return false;
    if (f.canton && l.canton !== f.canton) return false;
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
  problems: { label: "Anzahl Probleme", cmp: (a, b) => (b.findings_total || 0) - (a.findings_total || 0) },
  stage: { label: "Status", cmp: (a, b) => SALES_STAGES.indexOf(a.sales_stage) - SALES_STAGES.indexOf(b.sales_stage) },
  last_contact: { label: "Letzter Kontakt", cmp: (a, b) => String(b.last_contact_at || "").localeCompare(String(a.last_contact_at || "")) },
  follow_up: { label: "Nächster Follow-up", cmp: (a, b) => (a.next_action_at ? 0 : 1) - (b.next_action_at ? 0 : 1) || String(a.next_action_at || "").localeCompare(String(b.next_action_at || "")) },
  updated: { label: "Zuletzt aktualisiert", cmp: (a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")) },
});
export function sortLeads(list = [], key = "priority") {
  const s = SORTS[key] || SORTS.priority;
  return [...list].sort((a, b) => s.cmp(a, b) || SORTS.company.cmp(a, b));
}
// „Next best lead“: höchste Priorität unter den offenen, nicht gesperrten Leads (Anzeige – keine Aktion).
export function nextBestLead(list = []) {
  return sortLeads(list.filter(inOutreachQueue), "priority")[0] || null;
}
export function crmStats(list = [], now = new Date()) {
  const out = {};
  for (const [k, c] of Object.entries(CARDS)) out[k] = list.filter((l) => !l.archived || k === "all").filter((l) => c.test(l, now)).length;
  out.archived = list.filter((l) => l.archived).length;
  out.all = list.filter((l) => !l.archived).length;
  out.follow_ups_overdue = list.filter((l) => followUpBucket(l, now) === "OVERDUE").length;
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
export function crmToCsv(list = []) {
  const rows = [CSV_COLUMNS.map(([h]) => h).join(";"), ...list.map((l) => CSV_COLUMNS.map(([, f]) => cell(f(l))).join(";"))];
  return "﻿" + rows.join("\r\n") + "\r\n";
}
