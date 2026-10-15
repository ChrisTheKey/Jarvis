// Jarvis Lead-CRM (TF-053) – Oberfläche. Liest die CRM-Sicht über /api/crm und schreibt NUR über die crm.*-Allowlist
// (Auftrag → VPS-Dienst prüft und speichert). Links (Website, tel:, mailto:, Gmail-Entwurf) öffnen nur – keine automatische Aktion,
// kein Senden, kein Anruf, keine SMS/WhatsApp. Alle Inhalte per textContent (nie innerHTML mit Daten).
import { SALES_STAGES, STAGE_LABEL, CALL_STATUSES, CALL_LABEL, CONTACT_STATUSES, CONTACT_LABEL, DRAFT_LABEL, FOLLOW_UP_LABEL, CARDS,
  SORTS, filterLeads, sortLeads, crmStats, nextBestLead, followUpBucket,
  ERROR_CARDS, PIPELINE_CARDS, AUDIT_LABEL, ISSUE_CATEGORIES, ISSUE_LABEL, SEVERITY_LABEL, errorCount, errorShort, errorLong, topIssues, repairLine, HISTORY_LABEL, issueLines, issueFacts } from "./crm-model.js";

const $ = (id) => document.getElementById(id);
const MOBILE = matchMedia("(max-width: 860px)");
const key = () => { try { return JSON.parse(localStorage.getItem("jarvis.cloudKey") || '""'); } catch { return ""; } };
const S = { leads: [], filters: {}, sort: "priority", card: "", sel: null, online: false, generated_at: null, backup: null, timer: null, facets: false, showAll: {} };

function el(tag, attrs = {}, ...kids) {
  const x = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") x.className = v; else if (k === "text") x.textContent = v; else if (k.startsWith("on")) x.addEventListener(k.slice(2), v);
    else x.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) x.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return x;
}
const fmt = (v) => { if (!v) return "–"; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + "T12:00:00Z" : v); if (Number.isNaN(+d)) return "–";
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? d.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }) : d.toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const person = (l) => [l.first_name, l.last_name].filter(Boolean).join(" ");
const stop = (e) => e.stopPropagation();
// Nur geprüfte Ziele: Website http(s) (Cloud-Allowlist), Telefon nur tel:+41…, E-Mail nur Adresse, Entwurf nur mail.google.com.
const link = (href, text, cls = "", blank = true) => href ? el("a", { class: cls, href, ...(blank ? { target: "_blank", rel: "noopener noreferrer" } : {}), onclick: stop }, text) : el("span", { class: cls }, text);
const telLink = (l, cls = "", label = null) => l.phone_tel && !l.do_not_contact ? link(l.phone_tel, label || l.phone, cls, false) : el("span", { class: cls }, l.phone || "–");
const mailLink = (l, cls = "", label = null) => l.email && !l.do_not_contact ? link(`mailto:${l.email}`, label || l.email, cls, false) : el("span", { class: cls }, l.email || "–");
const badge = (cls, text) => el("span", { class: `crm-badge ${cls}` }, text);
const fmtDay = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(+d) ? d.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" }) : "–"; };
// TF-055 Website-Fehler: genaue Zahl nur bei vollständigem, aktuellem Audit („7“), sonst „≥3“ bzw. „veraltet“ – nie eine Teilmenge als Gesamtzahl.
const auditOf = (l) => l.errors?.audit || "NONE";
const auditBadge = (l) => badge(`au-${auditOf(l)}`, AUDIT_LABEL[auditOf(l)]);
const errNum = (l) => el("span", { class: `crm-err${errorCount(l) ? "" : " zero"}${auditOf(l) === "FULL" ? "" : " approx"}`, title: errorLong(l) }, errorShort(l));
const noTop = (l) => (auditOf(l) === "NONE" ? "Noch nicht geprüft" : "Keine aktuell verifizierten Fehler");
// TF-059: konkret „Startseite → «Kontakt»“ / „/kontakt/ → HTTP 404“ (crm_title/crm_detail vom Dienst, sonst lokal abgeleitet).
const lines = (f) => (f.crm_title ? { title: f.crm_title, detail: f.crm_detail || null } : issueLines(f));
const issueLi = (f) => { const x = lines(f); return el("li", { title: f.text || "" }, el("span", { class: "it" }, x.title), x.detail ? el("span", { class: "id" }, x.detail) : ""); };
const top2 = (l) => { const t = topIssues(l); return t.length ? el("ol", { class: "crm-top2" }, t.map((f) => issueLi(f))) : el("small", {}, noTop(l)); };
// Detail: alle vorhandenen Fakten (nur belegte – fehlende Werte werden weggelassen bzw. ehrlich als unbekannt benannt).
const factLine = (f) => { const x = issueFacts(f); return [["Quellseite", x.source], ["Element", x.element], ["Ziel", x.target], ["Beobachtet", x.result],
  ["HTTP-Status", x.http_status ? String(x.http_status) : null]].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · "); };
const pageText = (f) => (f.page ? f.page.replace(/^https?:\/\//, "") : "–");
// TF-058: historischer Discovery-Fund (nur Anzeige – daraus entsteht nie ein Entwurf).
const histBadge = (l) => (HISTORY_LABEL[l.history_badge] ? badge(`hist-${l.history_badge}`, HISTORY_LABEL[l.history_badge]) : "");
const stageBadge = (l) => l.do_not_contact ? badge("dnc", "DO NOT CONTACT") : badge(`st-${l.sales_stage}`, STAGE_LABEL[l.sales_stage] || l.sales_stage);

// ---------- Laden ----------
async function api(query = "", opts = {}) {
  const r = await fetch("/api/crm" + query, { cache: "no-store", ...opts, headers: { "x-jarvis-key": key(), ...(opts.body ? { "content-type": "application/json" } : {}) } });
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json().catch(() => null) : r };
}
async function load() {
  setMeta("Lade CRM …");
  try {
    const { status, body } = await api("?watch=1");
    if (status === 401) return setMeta("Nicht berechtigt – Cloud-Passwort fehlt oder ist falsch.", true);
    if (status === 404) return setMeta("CRM nur über die Cloud-Oberfläche verfügbar.", true);
    if (status !== 200 || !body) return setMeta(`CRM nicht verfügbar (Fehler ${status}).`, true);
    S.leads = Array.isArray(body.leads) ? body.leads : [];
    S.online = !!body.online; S.generated_at = body.generated_at; S.backup = body.backup;
    render();
  } catch { setMeta("Cloud nicht erreichbar.", true); }
}
function setMeta(text, bad = false) { const m = $("crmMeta"); m.textContent = text; m.style.color = bad ? "var(--red)" : ""; }

// ---------- Ansicht ----------
function readFilters() {
  const f = {};
  for (const k of ["q", "stage", "canton", "category", "phone", "person", "draft", "errors", "audit", "issue", "contact", "call", "followup", "dnc", "archived"]) {
    const v = $("crmF_" + k)?.value; if (v) f[k] = v;
  }
  if (S.card) f.card = S.card;
  S.filters = f; S.sort = $("crmSort").value || "priority";
}
function visible() { readFilters(); return sortLeads(filterLeads(S.leads, S.filters), S.sort); }
function render() {
  const now = new Date(), st = crmStats(S.leads, now);
  setMeta(`${S.leads.length} Leads · Stand VPS ${fmt(S.generated_at)} · Dienst ${S.online ? "ONLINE" : "OFFLINE – Änderungen nicht möglich"}${S.backup?.last_at ? ` · Backup ${fmt(S.backup.last_at)}${S.backup.offsite_ok ? "" : " (offsite offen)"}` : ""}`, !S.online);
  const cards = $("crmCards");
  cards.replaceChildren(...Object.entries(CARDS).map(([k, c]) => el("button", { type: "button", class: `crm-card${k === "dnc" ? " dnc" : k === "follow_ups" ? " fu" : k === "customers" ? " ok" : ""}`,
    "aria-pressed": String(S.card === k || (k === "all" && !S.card)), onclick: () => { S.card = k === "all" ? "" : S.card === k ? "" : k; renderList(); renderCardsPressed(); } },
    el("b", {}, String(k === "follow_ups" ? `${st.follow_ups}` : st[k] ?? 0)), el("span", {}, c.label + (k === "follow_ups" && st.follow_ups_overdue ? ` · ${st.follow_ups_overdue} überfällig` : "")))));
  // TF-057: Pipeline – qualifizierte Leads gesamt und davon je genau eine Phase (Summe = gesamt). Nie mit der Entwurfszahl verwechseln.
  $("crmPipeCards").replaceChildren(el("span", { class: "crm-cards-h" }, `Gesamte qualifizierte Leads: ${st.all} – davon`), ...Object.entries(PIPELINE_CARDS).map(([k, c]) => el("button", { type: "button", class: `crm-card pipe${k === "pipe_customer" ? " ok" : ""}`,
    "aria-pressed": String(S.card === k), onclick: () => { S.card = S.card === k ? "" : k; renderList(); renderCardsPressed(); } }, el("b", {}, String(st[k] ?? 0)), el("span", {}, c.label))));
  // TF-055: Website-Fehler-Übersicht (nur Anzeige/Schnellfilter, keine Outreach-Automatik).
  $("crmErrCards").replaceChildren(el("span", { class: "crm-cards-h" }, "Website-Fehler"), ...Object.entries(ERROR_CARDS).map(([k, c]) => el("button", { type: "button", class: "crm-card err", "aria-pressed": String(S.card === k),
    onclick: () => { S.card = S.card === k ? "" : k; renderList(); renderCardsPressed(); } }, el("b", {}, String(st[k] ?? 0)), el("span", {}, c.label))));
  facets();
  const nb = nextBestLead(S.leads);
  $("crmNext").replaceChildren(...(nb ? ["Nächster bester Lead:", el("button", { type: "button", class: "crm-btn", onclick: () => openLead(nb.lead_id) }, `${nb.company || nb.domain} · ${nb.priority.level} (${nb.priority.score})`),
    el("span", {}, nb.priority.reasons.join(" · "))] : ["Kein offener Lead in der Outreach-Queue."]));
  renderList();
  if (S.sel) renderDrawer();
}
function renderCardsPressed() {
  [...$("crmCards").children].forEach((b, i) => { const k = Object.keys(CARDS)[i]; b.setAttribute("aria-pressed", String(S.card === k || (k === "all" && !S.card))); });
  [...$("crmPipeCards").querySelectorAll("button")].forEach((b, i) => b.setAttribute("aria-pressed", String(S.card === Object.keys(PIPELINE_CARDS)[i])));
  [...$("crmErrCards").querySelectorAll("button")].forEach((b, i) => b.setAttribute("aria-pressed", String(S.card === Object.keys(ERROR_CARDS)[i])));
}
function facets() {
  if (S.facets || !S.leads.length) return;
  const fill = (id, values) => { const s = $(id); for (const [v, label] of values) s.append(el("option", { value: v }, label)); };
  const count = (k) => { const m = {}; for (const l of S.leads) if (l[k]) m[l[k]] = (m[l[k]] || 0) + 1; return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0], "de")); };
  fill("crmF_canton", count("canton").map(([v, n]) => [v, `${v} (${n})`]));
  fill("crmF_category", count("category").map(([v, n]) => [v, `${v} (${n})`]));
  S.facets = true;
}
function renderList() {
  const list = visible(), main = $("crmMain");
  $("crmCount").textContent = `${list.length} von ${S.leads.length}`;
  if (!list.length) { main.replaceChildren(el("p", { class: "crm-empty" }, S.leads.length ? "Keine Leads für diese Filter." : "Noch keine CRM-Daten vom VPS.")); return; }
  main.replaceChildren(MOBILE.matches ? cardsView(list) : tableView(list));
}
function errorsCell(l) {
  const at = l.errors?.checked_at;
  return el("div", {}, errNum(l), el("small", {}, auditBadge(l)), at ? el("small", {}, fmtDay(at)) : "");
}
function nextCell(l) {
  const fu = followUpBucket(l);
  return el("div", {}, l.next_action || (l.next_action_at ? "" : "–"), l.next_action_at ? el("small", {}, fmt(l.next_action_at), " ", fu ? badge(`fu-${fu}`, FOLLOW_UP_LABEL[fu]) : "") : "");
}
function tableView(list) {
  const head = ["Firma", "Website", "Fehler", "Wichtigste Fehler", "Ansprechpartner", "Telefon", "E-Mail", "Draft", "Status", "Telefonstatus", "Nächster Schritt"];
  const rows = list.map((l) => el("tr", { class: `${l.do_not_contact ? "dnc" : ""}${S.sel === l.lead_id ? " sel" : ""}`, "data-id": l.lead_id, tabindex: "0",
    onclick: () => openLead(l.lead_id), onkeydown: (e) => { if (e.key === "Enter") openLead(l.lead_id); } },
    el("td", { class: "co" }, el("b", {}, l.company || l.domain || l.lead_id), el("small", {}, [l.municipality, l.canton].filter(Boolean).join(" · ") || ""), badge(l.priority?.level || "LOW", `${l.priority?.level || "LOW"} ${l.priority?.score ?? 0}`), histBadge(l)),
    el("td", {}, link(l.website, l.domain || "Website")),
    el("td", { class: "err" }, errorsCell(l)),
    el("td", { class: "top" }, top2(l)),
    el("td", {}, person(l) || "–", l.role ? el("small", {}, l.role) : ""),
    el("td", {}, telLink(l)),
    el("td", {}, mailLink(l)),
    el("td", {}, l.draft_status ? badge(`draft-${l.draft_status}`, DRAFT_LABEL[l.draft_status]) : "–", l.draft_url ? el("small", {}, link(l.draft_url, "öffnen")) : ""),
    el("td", {}, stageBadge(l)),
    el("td", {}, CALL_LABEL[l.call_status] || "–"),
    el("td", {}, nextCell(l))));
  return el("table", { class: "crm-table" }, el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows));
}
function cardsView(list) {
  return el("ul", { class: "crm-list" }, list.map((l) => el("li", { class: `crm-lcard${l.do_not_contact ? " dnc" : ""}`, "data-id": l.lead_id, tabindex: "0",
    onclick: () => openLead(l.lead_id), onkeydown: (e) => { if (e.key === "Enter") openLead(l.lead_id); } },
    el("div", { class: "row" }, el("h3", {}, l.company || l.domain || l.lead_id), stageBadge(l)),
    l.domain ? el("small", { class: "dom" }, l.domain) : "", histBadge(l),
    el("div", { class: "crm-errline" }, el("span", { class: "lbl" }, "Fehler:"), errNum(l), auditBadge(l)),
    el("div", { class: "crm-top2wrap" }, el("span", { class: "lbl" }, "Wichtigste 2:"), top2(l)),
    el("div", {}, "Ansprechpartner: ", person(l) ? `${person(l)}${l.role ? ` · ${l.role}` : ""}` : "–"),
    el("div", {}, "Telefon: ", l.phone || "–"),
    el("div", { class: "acts" },
      l.phone_tel && !l.do_not_contact ? link(l.phone_tel, "ANRUFEN", "crm-btn big primary", false) : "",
      l.website ? link(l.website, "WEBSITE ÖFFNEN", "crm-btn big") : "",
      l.draft_url ? link(l.draft_url, "ENTWURF ÖFFNEN", "crm-btn big") : ""))));
}

// ---------- Detail ----------
function openLead(id) {
  S.sel = id; renderDrawer();
  [...document.querySelectorAll("#crmMain [data-id]")].forEach((r) => r.classList.toggle("sel", r.dataset.id === id));
}
function closeDrawer() { S.sel = null; $("crmDrawer").hidden = true; document.querySelectorAll("#crmMain .sel").forEach((r) => r.classList.remove("sel")); }
const kv = (rows) => el("div", { class: "kv" }, rows.flatMap(([k, v]) => [el("span", {}, k), el("b", {}, v instanceof Node ? v : v ?? "–")]));
const options = (values, labels, cur) => values.map((v) => el("option", { value: v, selected: v === cur }, labels[v] || v));
function renderDrawer() {
  const l = S.leads.find((x) => x.lead_id === S.sel), d = $("crmDrawer");
  if (!l) { closeDrawer(); return; }
  d.hidden = false;
  const status = el("p", { class: "crm-status", id: "crmActStatus", "aria-live": "polite" });
  const dis = !S.online;
  const blocked = l.do_not_contact;
  // A–F + Schnellaktionen
  const qa = el("div", { class: "crm-qa" },
    l.website ? link(l.website, "WEBSITE ÖFFNEN", "crm-btn") : "",
    l.draft_url ? link(l.draft_url, "GMAIL-ENTWURF ÖFFNEN", "crm-btn") : "",
    !blocked && l.phone_tel ? link(l.phone_tel, "ANRUFEN", "crm-btn primary", false) : "",
    !blocked && l.email ? link(`mailto:${l.email}`, "E-MAIL ÖFFNEN", "crm-btn", false) : "");
  // TF-055 Website-Zustand: Zahl + Audit-Art + Zeitpunkt, die zwei wichtigsten Fehler, danach ALLE aktuell verifizierten Fehler.
  const e = l.errors || { audit: "NONE", top: [], items: [] };
  const sev = (f) => SEVERITY_LABEL[f.severity] || "–";
  const findItem = (f) => { const x = lines(f); return el("li", { class: f.manual ? "manual" : "" }, el("b", {}, x.title), x.detail ? el("small", { class: "id" }, x.detail) : "",
    el("small", {}, `${ISSUE_LABEL[f.category] || "Andere"} · Schweregrad ${sev(f)}${f.manual ? " · manueller Punkt" : ""} · verifiziert ${fmt(f.verified_at)}`)); };
  const findings = [
    kv([["Verifizierte Fehler", errorLong(l)], ["Audit", `${AUDIT_LABEL[e.audit]}${e.scope ? ` – ${e.scope}` : ""}`], ["Zuletzt geprüft", fmt(e.checked_at)],
      ...(e.audit === "STALE" ? [["Hinweis", e.full_checked_at ? "Letzte vollständige Prüfung veraltet – Zahl nicht mehr garantiert aktuell, Neuprüfung ist eingeplant."
        : "Veraltet – historische Befunde, nicht als aktuelle Fehlerzahl zu verstehen. Neuprüfung ist eingeplant."]] : []),
      ...(e.audit === "PARTIAL" ? [["Hinweis", "Nur Teilprüfung – es können weitere Fehler vorhanden sein."]] : []),
      ...(repairLine(l) ? [["Reparatur", repairLine(l)]] : [])]),
    el("h5", {}, "Wichtigste Fehler"),
    e.top?.length ? el("ol", { class: "crm-find crm-topd" }, e.top.map((f, i) => { const x = lines(f); return el("li", {}, el("b", {}, `#${i + 1} ${x.title}`),
      x.detail ? el("small", { class: "id" }, x.detail) : "", el("small", {}, factLine(f) || `Betroffene Seite: ${pageText(f)}`),
      el("small", {}, `Schweregrad: ${sev(f)} · ${ISSUE_LABEL[f.category] || "Andere"} · verifiziert ${fmt(f.verified_at)}`)); }))
      : el("p", {}, noTop(l)),
    ...(e.items?.length ? [el("h5", {}, `Alle verifizierten Fehler (${e.items.length}${e.audit === "FULL" ? "" : ", Mindestzahl"})`), el("ul", { class: "crm-find" }, e.items.map(findItem))] : []),
  ];
  const stageSel = el("select", { class: "crm-sort", "aria-label": "Sales Stage", disabled: blocked }, options(SALES_STAGES.filter((s) => s !== "DO_NOT_CONTACT"), STAGE_LABEL, l.sales_stage));
  const contactSel = el("select", { class: "crm-sort", "aria-label": "Kontaktstatus", disabled: blocked }, options(CONTACT_STATUSES, CONTACT_LABEL, l.contact_status));
  const callSel = el("select", { class: "crm-sort", "aria-label": "Call Status", disabled: blocked }, options(CALL_STATUSES, CALL_LABEL, l.call_status));
  const save = (label, fn) => el("button", { type: "button", class: "crm-btn", disabled: dis || blocked, onclick: fn }, label);
  d.replaceChildren(
    el("div", { class: "crm-top" }, el("h3", {}, l.company || l.domain || l.lead_id), el("button", { type: "button", class: "crm-btn", onclick: closeDrawer, "aria-label": "Details schliessen" }, "SCHLIESSEN")),
    el("div", {}, link(l.website, l.domain || l.website || "–"), " ", stageBadge(l), " ", badge(l.priority?.level || "LOW", `Priorität ${l.priority?.level || "LOW"} · ${l.priority?.score ?? 0}`), " ", histBadge(l)),
    l.history_badge ? el("p", { class: "crm-note" }, "Historischer Discovery-Fund: im CRM sichtbar, aber keine Outreach-Quelle – ein Entwurf entsteht nur über die reguläre Qualifikation.") : "",
    blocked ? el("div", { class: "crm-dnc-banner" }, `DO NOT CONTACT – keine Anrufe, kein Follow-up, keine neuen Cold-Entwürfe${l.dnc_source && l.dnc_source !== "crm" ? ` (Quelle: ${l.dnc_source === "opt_out" ? "Opt-out" : l.dnc_source === "suppression" ? "Suppression" : "Lead-Datenbank"})` : ""}`) : "",
    el("small", {}, (l.priority?.reasons || []).join(" · ") || "keine Priorisierungspunkte"),
    qa, status,
    el("h4", {}, "A · Kontakt"),
    kv([["E-Mail", mailLink(l)], ["Telefon", telLink(l)], ["Vorname", l.first_name], ["Nachname", l.last_name], ["Rolle", l.role],
      ["Ort", [l.municipality, l.canton].filter(Boolean).join(" · ") || "–"], ["Branche", l.category]]),
    el("h4", {}, "B · Website"),
    kv([["Website", link(l.website, l.website || "–")], ["Erreichbar", l.website_reachable === true ? "ja" : l.website_reachable === false ? "nein / umgeleitet" : "nicht geprüft"],
      ["Letzte Prüfung", fmt(l.website_checked_at)], ["Erstprüfung (Cold)", `${l.findings_confirmed || 0} bestätigt${(l.findings_total || 0) - (l.findings_confirmed || 0) ? ` · ${(l.findings_total || 0) - (l.findings_confirmed || 0)} weitere` : ""}`],
      ["Aktualisiert", fmt(l.updated_at)]]),
    el("h4", {}, "C · Website-Zustand"), ...findings,
    el("h4", {}, "D · Outreach"),
    kv([["Draft-Status", l.draft_status ? DRAFT_LABEL[l.draft_status] : "–"], ["Draft erstellt", fmt(l.draft_created_at)], ["Manuell gesendet", l.manual_sent ? `ja · ${fmt(l.manual_sent_at)}` : "nein"],
      ["Letzter Kontakt", fmt(l.last_contact_at)], ["Kontaktstatus", CONTACT_LABEL[l.contact_status] || "–"]]),
    el("div", { class: "crm-qa" }, stageSel, save("STATUS ÄNDERN", () => act("crm.updateStage", { lead_id: l.lead_id, stage: stageSel.value })),
      contactSel, save("KONTAKTSTATUS", () => act("crm.updateContactStatus", { lead_id: l.lead_id, contact_status: contactSel.value }))),
    el("h4", {}, "E · Telefon"),
    kv([["Call Status", CALL_LABEL[l.call_status] || "–"], ["Anruf empfohlen", l.call_recommended ? "ja" : "nein"]]),
    el("div", { class: "crm-qa" }, callSel, save("TELEFONSTATUS", () => act("crm.updateCallStatus", { lead_id: l.lead_id, call_status: callSel.value })),
      el("button", { type: "button", class: "crm-btn primary", disabled: dis || blocked, onclick: () => { $("crmCallForm").hidden = !$("crmCallForm").hidden; } }, "ANRUF DOKUMENTIEREN")),
    callForm(l, dis || blocked),
    l.call_history.length ? el("ul", { class: "crm-hist" }, [...l.call_history].reverse().map((c) => el("li", {}, el("time", {}, `${fmt(c.at)} · ${CALL_LABEL[c.result] || c.result}`),
      c.note || "", c.next_action ? `\nNächster Schritt: ${c.next_action}` : "", c.follow_up_at ? `\nFollow-up: ${fmt(c.follow_up_at)}` : ""))) : el("p", { class: "crm-note" }, "Noch keine Anrufe dokumentiert."),
    el("h4", {}, "Follow-up"),
    followForm(l, dis || blocked),
    el("h4", {}, "F · Notizen"),
    noteForm(l, dis),
    l.notes.length ? el("ul", { class: "crm-hist" }, [...l.notes].reverse().map((n) => el("li", {}, el("time", {}, fmt(n.at)), n.text))) : el("p", { class: "crm-note" }, "Noch keine Notizen."),
    el("h4", {}, "Verwaltung"),
    el("div", { class: "crm-qa" },
      l.do_not_contact && l.dnc_source !== "crm" ? el("span", { class: "crm-note" }, "Sperre aus Opt-out/Suppression/Lead-Datenbank – im CRM nicht aufhebbar.")
        : el("button", { type: "button", class: `crm-btn ${l.do_not_contact ? "warn" : "danger"}`, disabled: dis, onclick: () => {
          if (l.do_not_contact) { if (confirm("Do Not Contact für diesen Lead aufheben?")) act("crm.setDoNotContact", { lead_id: l.lead_id, value: false }); return; }
          if (!confirm("DO NOT CONTACT setzen? Keine Anrufe, kein Follow-up, keine neuen Cold-Entwürfe. Bestehende Daten bleiben erhalten.")) return;
          const reason = (prompt("Grund (optional):") || "").slice(0, 200);
          act("crm.setDoNotContact", { lead_id: l.lead_id, value: true, ...(reason.trim() ? { reason } : {}) });
        } }, l.do_not_contact ? "DO NOT CONTACT AUFHEBEN" : "DO NOT CONTACT SETZEN"),
      el("button", { type: "button", class: "crm-btn", disabled: dis, onclick: () => act("crm.archive", { lead_id: l.lead_id, value: !l.archived }) }, l.archived ? "AUS ARCHIV HOLEN" : "ARCHIVIEREN")),
    el("p", { class: "crm-note" }, "Jarvis sendet, ruft und schreibt nie automatisch. Links öffnen nur Website, Telefon-App, Mail-Programm oder den bestehenden Gmail-Entwurf."),
  );
}
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function callForm(l, dis) {
  const at = el("input", { type: "datetime-local", value: localNow(), required: true }), res = el("select", {}, options(CALL_STATUSES.filter((s) => s !== "NOT_CALLED"), CALL_LABEL, "NO_ANSWER"));
  const note = el("textarea", { maxlength: "1000", placeholder: "Notiz zum Anruf" }), next = el("input", { maxlength: "200", placeholder: "z. B. Angebot CHF 150 schicken" }), fu = el("input", { type: "date" });
  return el("form", { class: "crm-form", id: "crmCallForm", hidden: true, onsubmit: (e) => {
    e.preventDefault();
    const iso = new Date(at.value).toISOString();
    act("crm.addCall", { lead_id: l.lead_id, at: iso, result: res.value, ...(note.value.trim() ? { note: note.value } : {}), ...(next.value.trim() ? { next_action: next.value } : {}), ...(fu.value ? { follow_up_at: fu.value } : {}) });
  } }, el("div", { class: "two" }, el("label", {}, "Datum/Zeit", at), el("label", {}, "Ergebnis", res)), el("label", {}, "Notiz", note),
    el("div", { class: "two" }, el("label", {}, "Nächster Schritt", next), el("label", {}, "Follow-up Datum", fu)),
    el("button", { type: "submit", class: "crm-btn primary", disabled: dis }, "ANRUF SPEICHERN"));
}
function followForm(l, dis) {
  const next = el("input", { maxlength: "200", value: l.next_action || "", placeholder: "Nächster Schritt" });
  const date = el("input", { type: "date", value: /^\d{4}-\d{2}-\d{2}$/.test(l.next_action_at || "") ? l.next_action_at : "" });
  const fu = followUpBucket(l);
  return el("form", { class: "crm-form", onsubmit: (e) => { e.preventDefault(); act("crm.setNextAction", { lead_id: l.lead_id, next_action: next.value, next_action_at: date.value || null }); } },
    fu ? el("div", {}, badge(`fu-${fu}`, FOLLOW_UP_LABEL[fu]), " ", fmt(l.next_action_at)) : "",
    el("div", { class: "two" }, el("label", {}, "Nächster Schritt", next), el("label", {}, "Follow-up Datum", date)),
    el("div", { class: "crm-qa" }, el("button", { type: "submit", class: "crm-btn primary", disabled: dis }, "FOLLOW-UP SETZEN"),
      el("button", { type: "button", class: "crm-btn", disabled: dis || (!l.next_action && !l.next_action_at), onclick: () => act("crm.setNextAction", { lead_id: l.lead_id, next_action: "", next_action_at: null }) }, "ENTFERNEN")),
    el("small", {}, "Follow-up erzeugt keine Mail und keine automatische Kontaktaufnahme."));
}
function noteForm(l, dis) {
  const t = el("textarea", { maxlength: "2000", placeholder: "Neue Notiz (wird mit Zeitstempel angehängt, bestehende bleiben)" });
  return el("form", { class: "crm-form", onsubmit: (e) => { e.preventDefault(); if (t.value.trim()) act("crm.addNote", { lead_id: l.lead_id, text: t.value }); } },
    t, el("button", { type: "submit", class: "crm-btn primary", disabled: dis }, "NOTIZ HINZUFÜGEN"));
}

// ---------- Schreiben: Auftrag → VPS → Ergebnis ----------
let busy = false;
async function act(action, params) {
  if (busy) return;
  busy = true;
  const out = () => $("crmActStatus");
  const say = (t, cls) => { if (out()) { out().textContent = t; out().className = `crm-status ${cls}`; } };
  say("Wird gespeichert … (VPS)", "wait");
  try {
    const { status, body } = await api("", { method: "POST", body: JSON.stringify({ action, params }) });
    if (status !== 202) { say(body?.error || `Fehler ${status}`, "bad"); return; }
    const rid = body.request.request_id;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, i < 4 ? 1000 : 2000));
      const r = await api(`?request=${rid}&watch=1`);
      const q = r.body?.request;
      if (!q || ["pending", "running"].includes(q.status)) continue;
      if (q.status === "done") {
        if (r.body.lead) { const i2 = S.leads.findIndex((x) => x.lead_id === r.body.lead.lead_id); if (i2 >= 0) S.leads[i2] = r.body.lead; }
        render(); say("Gespeichert ✓", "ok");
      } else say(q.error || `Nicht gespeichert (${q.status}).`, "bad");
      return;
    }
    say("Noch keine Bestätigung vom VPS – Stand später prüfen.", "bad");
  } catch { say("Cloud nicht erreichbar – nicht gespeichert.", "bad"); }
  finally { busy = false; }
}
async function exportCsv() {
  readFilters();
  const p = new URLSearchParams({ export: "csv", sort: S.sort });
  for (const [k, v] of Object.entries(S.filters)) p.set(k, v);
  try {
    const r = await fetch("/api/crm?" + p.toString(), { cache: "no-store", headers: { "x-jarvis-key": key() } });
    if (!r.ok) throw new Error("Fehler " + r.status);
    const url = URL.createObjectURL(await r.blob());
    const a = el("a", { href: url, download: `jarvis-crm-${new Date().toISOString().slice(0, 10)}.csv` }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) { setMeta("Export fehlgeschlagen (" + e.message + ").", true); }
}

// ---------- Gerüst ----------
function build() {
  const sel = (k, label, opts) => el("select", { id: "crmF_" + k, "aria-label": label }, el("option", { value: "" }, label), opts.map(([v, t]) => el("option", { value: v }, t)));
  const box = $("crm");
  box.replaceChildren(
    el("div", { class: "crm-top" }, el("h2", { id: "crmTitle" }, "CRM"), el("span", { class: "meta", id: "crmMeta" }, ""),
      el("button", { type: "button", class: "crm-btn", onclick: load }, "AKTUALISIEREN"), el("button", { type: "button", class: "crm-btn", onclick: exportCsv }, "EXPORT CSV"),
      el("button", { type: "button", class: "crm-btn", onclick: close }, "SCHLIESSEN")),
    el("div", { class: "crm-cards pipe", id: "crmPipeCards", role: "group", "aria-label": "Qualifizierte Leads" }),
    el("div", { class: "crm-cards", id: "crmCards", role: "group", "aria-label": "Übersicht" }),
    el("div", { class: "crm-cards errs", id: "crmErrCards", role: "group", "aria-label": "Website-Fehler" }),
    el("div", { class: "crm-next", id: "crmNext" }),
    el("div", { class: "crm-bar" }, el("input", { type: "search", class: "crm-search", id: "crmF_q", placeholder: "Suche: Firma, Domain, E-Mail, Telefon, Name, Ort …", "aria-label": "Suche", maxlength: "80", enterkeyhint: "search" }),
      el("select", { class: "crm-sort", id: "crmSort", "aria-label": "Sortierung" }, Object.entries(SORTS).map(([k, s]) => el("option", { value: k }, `Sortierung: ${s.label}`))),
      el("span", { id: "crmCount", class: "crm-next" })),
    el("details", { class: "crm-filters", open: !MOBILE.matches }, el("summary", {}, "Filter"),
      el("div", { class: "crm-fgrid" },
        sel("stage", "Sales Stage", SALES_STAGES.map((s) => [s, STAGE_LABEL[s]])), sel("canton", "Kanton", []), sel("category", "Branche", []),
        sel("phone", "Telefon", [["1", "mit Telefon"], ["0", "ohne Telefon"]]), sel("person", "Ansprechpartner", [["1", "mit Ansprechpartner"], ["0", "ohne"]]),
        sel("draft", "Draft", [["1", "Entwurf vorhanden"], ["0", "kein Entwurf"]]),
        sel("errors", "Fehler", [["0", "0"], ["1-2", "1–2"], ["3-5", "3–5"], ["6+", "6+"]]),
        sel("audit", "Audit", [["FULL", "Vollständig"], ["PARTIAL", "Teilprüfung"], ["STALE", "Veraltet"], ["NONE", "Nicht geprüft"]]),
        sel("issue", "Wichtiges Problem", ISSUE_CATEGORIES.map((c) => [c, ISSUE_LABEL[c]])),
        sel("contact", "Kontaktstatus", CONTACT_STATUSES.map((s) => [s, CONTACT_LABEL[s]])), sel("call", "Call Status", CALL_STATUSES.map((s) => [s, CALL_LABEL[s]])),
        sel("followup", "Follow-up", [["due", "fällig (heute + überfällig)"], ["OVERDUE", "überfällig"], ["TODAY", "heute fällig"], ["LATER", "später"], ["none", "keins"]]),
        sel("dnc", "Do Not Contact", [["1", "nur Do Not Contact"], ["0", "ohne Do Not Contact"]]),
        sel("archived", "Archiv: ausblenden", [["only", "nur archivierte"], ["all", "alle inkl. Archiv"]]),
        el("button", { type: "button", class: "crm-btn", onclick: () => { document.querySelectorAll("#crm .crm-fgrid select, #crmF_q").forEach((x) => { x.value = ""; }); S.card = ""; renderCardsPressed(); renderList(); } }, "ZURÜCKSETZEN"))),
    el("div", { class: "crm-main", id: "crmMain" }),
  );
  box.addEventListener("input", (e) => { if (e.target.id === "crmF_q") renderList(); });
  box.addEventListener("change", (e) => { if (e.target.closest(".crm-fgrid") || e.target.id === "crmSort") renderList(); });
  MOBILE.addEventListener("change", () => { if (!box.hidden) renderList(); });
}
function open() {
  if (!$("crm").childElementCount) build();
  $("crm").hidden = false;
  if (location.hash !== "#crm") history.replaceState(null, "", "#crm");
  load();
  clearInterval(S.timer); S.timer = setInterval(() => { if (document.visibilityState === "visible" && !busy) load(); }, 30_000);
}
function close() { clearInterval(S.timer); closeDrawer(); $("crm").hidden = true; if (location.hash === "#crm") history.replaceState(null, "", location.pathname + location.search); }
document.addEventListener("keydown", (e) => { if (e.key !== "Escape" || $("crm").hidden) return; if (!$("crmDrawer").hidden) closeDrawer(); else close(); });
$("crmBtn").addEventListener("click", open);
if (location.hash === "#crm") open();
window.JarvisCrm = { open, close, openLead, state: S };
