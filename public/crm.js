// Jarvis Lead-CRM (TF-053, Multi-User/i18n TF-063) – Oberfläche. Liest die CRM-Sicht über /api/crm (serverseitig auf den Bereich des
// angemeldeten Benutzers gefiltert) und schreibt NUR über die crm.*-Allowlist (Auftrag → VPS-Dienst prüft und speichert). Anmeldung über
// das HttpOnly-Session-Cookie – kein Passwort/Token im Browser-Speicher. Links (Website, tel:, mailto:, Gmail-Entwurf) öffnen nur – keine
// automatische Aktion, kein Senden, kein Anruf, keine SMS/WhatsApp. Alle Inhalte per textContent (nie innerHTML mit Daten).
// Sprache: de-CH (Standard, unverändert) oder vi-VN (setLocale) – Firmennamen, Domains, Telefonnummern und Kundeninhalte bleiben wie sie sind.
import { SALES_STAGES, CALL_STATUSES, CONTACT_STATUSES, CARDS, SORTS, filterLeads, sortLeads, crmStats, nextBestLead, followUpBucket,
  ERROR_CARDS, PIPELINE_CARDS, ISSUE_CATEGORIES, errorCount, errorShort, errorLong, topIssues, repairLine, issueLines, issueFacts } from "./crm-model.js";
import { createI18n } from "./i18n.js";
import { callingTexts, leadCallBox } from "./calling-ui.js";
import { onboardingTexts, leadOnboardingBox, onboardingPanel } from "./onboarding-ui.js";

const $ = (id) => document.getElementById(id);
const MOBILE = matchMedia("(max-width: 860px)");
let I = createI18n(document.documentElement.dataset.locale || "de-CH");
const t = (...a) => I.t(...a);
const S = { leads: [], filters: {}, sort: "priority", card: "", sel: null, online: false, generated_at: null, backup: null, timer: null, facets: false, showAll: {}, actor: null };

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
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? d.toLocaleDateString(I.dateLocale, { timeZone: I.tz }) : d.toLocaleString(I.dateLocale, { timeZone: I.tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const person = (l) => [l.first_name, l.last_name].filter(Boolean).join(" ");
const stop = (e) => e.stopPropagation();
// Nur geprüfte Ziele: Website http(s) (Cloud-Allowlist), Telefon nur tel:+41…/+84… (VN), E-Mail nur Adresse, Entwurf nur mail.google.com.
const link = (href, text, cls = "", blank = true) => href ? el("a", { class: cls, href, ...(blank ? { target: "_blank", rel: "noopener noreferrer" } : {}), onclick: stop }, text) : el("span", { class: cls }, text);
const telLink = (l, cls = "", label = null) => l.phone_tel && !l.do_not_contact ? link(l.phone_tel, label || l.phone, cls, false) : el("span", { class: cls }, l.phone || "–");
const mailLink = (l, cls = "", label = null) => l.email && !l.do_not_contact ? link(`mailto:${l.email}`, label || l.email, cls, false) : el("span", { class: cls }, l.email || "–");
const badge = (cls, text) => el("span", { class: `crm-badge ${cls}` }, text);
const fmtDay = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(+d) ? d.toLocaleDateString(I.dateLocale, { timeZone: I.tz }) : "–"; };
const place = (l) => [l.municipality, l.canton || l.region].filter(Boolean).join(" · ");
const cat = (l) => I.category(l.category) || "–";
const level = (l) => I.L.level[l.priority?.level || "LOW"] || "";
// TF-055 Website-Fehler: genaue Zahl nur bei vollständigem, aktuellem Audit („7“), sonst „≥3“ bzw. „veraltet“ – nie eine Teilmenge als Gesamtzahl.
const auditOf = (l) => l.errors?.audit || "NONE";
const auditBadge = (l) => badge(`au-${auditOf(l)}`, I.L.audit[auditOf(l)]);
const errNum = (l) => el("span", { class: `crm-err${errorCount(l) ? "" : " zero"}${auditOf(l) === "FULL" ? "" : " approx"}`, title: errorLong(l, I.errWords) }, errorShort(l, I.errWords));
const noTop = (l) => (auditOf(l) === "NONE" ? t("crm.notChecked") : t("crm.noneVerified"));
// TF-059: konkret „Startseite → «Kontakt»“ / „/kontakt/ → HTTP 404“ (crm_title/crm_detail vom Dienst – nur Deutsch; vi immer lokal abgeleitet).
const lines = (f) => (f.crm_title && !I.vi ? { title: f.crm_title, detail: f.crm_detail || null } : issueLines(f, I.issueWords, I.issueText(f)));
const issueLi = (f) => { const x = lines(f); return el("li", { title: I.issueText(f) }, el("span", { class: "it" }, x.title), x.detail ? el("span", { class: "id" }, x.detail) : ""); };
const top2 = (l) => { const tp = topIssues(l); return tp.length ? el("ol", { class: "crm-top2" }, tp.map((f) => issueLi(f))) : el("small", {}, noTop(l)); };
// Detail: alle vorhandenen Fakten (nur belegte – fehlende Werte werden weggelassen bzw. ehrlich als unbekannt benannt).
const factLine = (f) => { const x = issueFacts(f, I.issueWords); return [[t("fact.source"), x.source], [t("fact.element"), x.element], [t("fact.target"), x.target], [t("fact.result"), x.result],
  [t("fact.http"), x.http_status ? String(x.http_status) : null]].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · "); };
const pageText = (f) => (f.page ? f.page.replace(/^https?:\/\//, "") : "–");
// TF-058: historischer Discovery-Fund (nur Anzeige – daraus entsteht nie ein Entwurf).
const histBadge = (l) => (I.L.history[l.history_badge] ? badge(`hist-${l.history_badge}`, I.L.history[l.history_badge]) : "");
const stageBadge = (l) => l.do_not_contact ? badge("dnc", t("dnc")) : badge(`st-${l.sales_stage}`, I.L.stage[l.sales_stage] || "–");
const errMsg = (status, body) => (body?.code ? I.codeMsg(body.code, body.error) : I.vi ? t("act.err", status) : body?.error || t("act.err", status));

// ---------- Laden ----------
async function api(query = "", opts = {}) {
  const r = await fetch("/api/crm" + query, { cache: "no-store", credentials: "same-origin", ...opts, headers: { ...(opts.body ? { "content-type": "application/json" } : {}) } });
  if (r.status === 401) dispatchEvent(new CustomEvent("jarvis:unauthorized"));
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json().catch(() => null) : r };
}
async function load() {
  setMeta(t("crm.loading"));
  try {
    const { status, body } = await api("?watch=1");
    if (status === 401) return setMeta(t("crm.e401"), true);
    if (status === 404) return setMeta(t("crm.e404"), true);
    if (status !== 200 || !body) return setMeta(t("crm.eStatus", status), true);
    S.leads = Array.isArray(body.leads) ? body.leads : [];
    S.online = !!body.online; S.generated_at = body.generated_at; S.backup = body.backup; S.actor = body.actor || null;
    render();
  } catch { setMeta(t("crm.unreachable"), true); }
}
function setMeta(text, bad = false) { const m = $("crmMeta"); if (!m) return; m.textContent = text; m.style.color = bad ? "var(--red)" : ""; }

// ---------- Ansicht ----------
function readFilters() {
  const f = {};
  for (const k of ["q", "stage", "canton", "region", "category", "phone", "person", "draft", "errors", "audit", "issue", "contact", "call", "followup", "dnc", "archived"]) {
    const v = $("crmF_" + k)?.value; if (v) f[k] = v;
  }
  if (S.card) f.card = S.card;
  S.filters = f; S.sort = $("crmSort").value || "priority";
}
function visible() { readFilters(); return sortLeads(filterLeads(S.leads, S.filters), S.sort); }
function render() {
  const now = new Date(), st = crmStats(S.leads, now);
  setMeta(t("crm.meta", S.leads.length, fmt(S.generated_at), S.online) + (S.backup?.last_at ? t("crm.metaBackup", fmt(S.backup.last_at), S.backup.offsite_ok) : ""), !S.online);
  const cards = $("crmCards");
  cards.replaceChildren(...Object.keys(CARDS).map((k) => el("button", { type: "button", class: `crm-card${k === "dnc" ? " dnc" : k === "follow_ups" ? " fu" : k === "customers" ? " ok" : ""}`,
    "aria-pressed": String(S.card === k || (k === "all" && !S.card)), onclick: () => { S.card = k === "all" ? "" : S.card === k ? "" : k; renderList(); renderCardsPressed(); } },
    el("b", {}, String(k === "follow_ups" ? `${st.follow_ups}` : st[k] ?? 0)), el("span", {}, I.L.cards[k] + (k === "follow_ups" && st.follow_ups_overdue ? t("crm.overdue", st.follow_ups_overdue) : "")))));
  // TF-057: Pipeline – qualifizierte Leads gesamt und davon je genau eine Phase (Summe = gesamt). Nie mit der Entwurfszahl verwechseln.
  $("crmPipeCards").replaceChildren(el("span", { class: "crm-cards-h" }, t("crm.pipeHead", st.all)), ...Object.keys(PIPELINE_CARDS).map((k) => el("button", { type: "button", class: `crm-card pipe${k === "pipe_customer" ? " ok" : ""}`,
    "aria-pressed": String(S.card === k), onclick: () => { S.card = S.card === k ? "" : k; renderList(); renderCardsPressed(); } }, el("b", {}, String(st[k] ?? 0)), el("span", {}, I.L.pipeline[k]))));
  // TF-055: Website-Fehler-Übersicht (nur Anzeige/Schnellfilter, keine Outreach-Automatik).
  $("crmErrCards").replaceChildren(el("span", { class: "crm-cards-h" }, t("crm.errHead")), ...Object.keys(ERROR_CARDS).map((k) => el("button", { type: "button", class: "crm-card err", "aria-pressed": String(S.card === k),
    onclick: () => { S.card = S.card === k ? "" : k; renderList(); renderCardsPressed(); } }, el("b", {}, String(st[k] ?? 0)), el("span", {}, I.L.errorCards[k]))));
  facets();
  const nb = nextBestLead(S.leads);
  $("crmNext").replaceChildren(...(nb ? [t("crm.nextBest"), el("button", { type: "button", class: "crm-btn", onclick: () => openLead(nb.lead_id) }, `${nb.company || nb.domain} · ${level(nb)} (${nb.priority.score})`),
    el("span", {}, nb.priority.reasons.map(I.reason).join(" · "))] : [t("crm.noNext")]));
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
  const fill = (id, values) => { const s = $(id); if (!s) return; for (const [v, label] of values) s.append(el("option", { value: v }, label)); };
  const count = (k) => { const m = {}; for (const l of S.leads) if (l[k]) m[l[k]] = (m[l[k]] || 0) + 1; return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0], I.vi ? "vi" : "de")); };
  fill("crmF_canton", count("canton").map(([v, n]) => [v, `${v} (${n})`]));
  fill("crmF_region", count("region").map(([v, n]) => [v, `${v} (${n})`]));
  fill("crmF_category", count("category").map(([v, n]) => [v, `${I.category(v)} (${n})`]));
  // Nur Felder zeigen, die in diesem Bereich vorkommen (Lap: Region statt Kanton).
  if ($("crmF_canton")) $("crmF_canton").hidden = !S.leads.some((l) => l.canton);
  if ($("crmF_region")) $("crmF_region").hidden = !S.leads.some((l) => l.region);
  S.facets = true;
}
function renderList() {
  const list = visible(), main = $("crmMain");
  $("crmCount").textContent = t("crm.count", list.length, S.leads.length);
  if (!list.length) { main.replaceChildren(el("p", { class: "crm-empty" }, S.leads.length ? t("crm.emptyFilter") : t("crm.emptyNone"))); return; }
  main.replaceChildren(MOBILE.matches ? cardsView(list) : tableView(list));
}
function errorsCell(l) {
  const at = l.errors?.checked_at;
  return el("div", {}, errNum(l), el("small", {}, auditBadge(l)), at ? el("small", {}, fmtDay(at)) : "");
}
function nextCell(l) {
  const fu = followUpBucket(l);
  return el("div", {}, l.next_action || (l.next_action_at ? "" : "–"), l.next_action_at ? el("small", {}, fmt(l.next_action_at), " ", fu ? badge(`fu-${fu}`, I.L.followUp[fu]) : "") : "");
}
function tableView(list) {
  const head = ["th.company", "th.category", "th.website", "th.errors", "th.top", "th.person", "th.phone", "th.email", "th.draft", "th.status", "th.call", "th.next"].map((k) => t(k));
  const rows = list.map((l) => el("tr", { class: `${l.do_not_contact ? "dnc" : ""}${S.sel === l.lead_id ? " sel" : ""}`, "data-id": l.lead_id, tabindex: "0",
    onclick: () => openLead(l.lead_id), onkeydown: (e) => { if (e.key === "Enter") openLead(l.lead_id); } },
    el("td", { class: "co" }, el("b", {}, l.company || l.domain || l.lead_id), el("small", {}, place(l) || ""), badge(l.priority?.level || "LOW", `${level(l)} ${l.priority?.score ?? 0}`), histBadge(l)),
    el("td", { class: "cat" }, cat(l)),
    el("td", {}, link(l.website, l.domain || t("th.website"))),
    el("td", { class: "err" }, errorsCell(l)),
    el("td", { class: "top" }, top2(l)),
    el("td", {}, person(l) || "–", l.role ? el("small", {}, l.role) : ""),
    el("td", {}, telLink(l)),
    el("td", {}, mailLink(l)),
    el("td", {}, l.draft_status ? badge(`draft-${l.draft_status}`, I.L.draft[l.draft_status]) : "–", l.draft_url ? el("small", {}, link(l.draft_url, t("crm.open"))) : ""),
    el("td", {}, stageBadge(l)),
    el("td", {}, I.L.call[l.call_status] || "–"),
    el("td", {}, nextCell(l))));
  return el("table", { class: "crm-table" }, el("thead", {}, el("tr", {}, head.map((h) => el("th", { scope: "col" }, h)))), el("tbody", {}, rows));
}
function cardsView(list) {
  return el("ul", { class: "crm-list" }, list.map((l) => el("li", { class: `crm-lcard${l.do_not_contact ? " dnc" : ""}`, "data-id": l.lead_id, tabindex: "0",
    onclick: () => openLead(l.lead_id), onkeydown: (e) => { if (e.key === "Enter") openLead(l.lead_id); } },
    el("div", { class: "row" }, el("h3", {}, l.company || l.domain || l.lead_id), stageBadge(l)),
    l.domain ? el("small", { class: "dom" }, l.domain) : "", histBadge(l),
    el("div", { class: "crm-cat" }, el("span", { class: "lbl" }, t("card.category")), " ", cat(l)),
    el("div", { class: "crm-errline" }, el("span", { class: "lbl" }, t("card.errors")), errNum(l), auditBadge(l)),
    el("div", { class: "crm-top2wrap" }, el("span", { class: "lbl" }, t("card.top2")), top2(l)),
    el("div", {}, t("card.person"), person(l) ? `${person(l)}${l.role ? ` · ${l.role}` : ""}` : "–"),
    el("div", {}, t("card.phone"), l.phone || "–"),
    el("div", { class: "acts" },
      l.phone_tel && !l.do_not_contact ? link(l.phone_tel, t("btn.call"), "crm-btn big primary", false) : "",
      l.website ? link(l.website, t("btn.website"), "crm-btn big") : "",
      l.draft_url ? link(l.draft_url, t("btn.draftOpen"), "crm-btn big") : ""))));
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
    l.website ? link(l.website, t("btn.website"), "crm-btn") : "",
    l.draft_url ? link(l.draft_url, t("btn.gmail"), "crm-btn") : "",
    !blocked && l.phone_tel ? link(l.phone_tel, t("btn.call"), "crm-btn primary", false) : "",
    !blocked && l.email ? link(`mailto:${l.email}`, t("btn.mail"), "crm-btn", false) : "");
  // TF-055 Website-Zustand: Zahl + Audit-Art + Zeitpunkt, die zwei wichtigsten Fehler, danach ALLE aktuell verifizierten Fehler.
  const e = l.errors || { audit: "NONE", top: [], items: [] };
  const sev = (f) => I.L.severity[f.severity] || "–";
  const findItem = (f) => { const x = lines(f); return el("li", { class: f.manual ? "manual" : "" }, el("b", {}, x.title), x.detail ? el("small", { class: "id" }, x.detail) : "",
    el("small", {}, `${I.L.issue[f.category] || t("other")} · ${t("severity")} ${sev(f)}${f.manual ? ` · ${t("manualItem")}` : ""} · ${t("verified")} ${fmt(f.verified_at)}`)); };
  const findings = [
    kv([[t("kv.verified"), errorLong(l, I.errWords)], [t("kv.audit"), `${I.L.audit[e.audit]}${e.scope && !I.vi ? ` – ${e.scope}` : ""}`], [t("kv.lastChecked"), fmt(e.checked_at)],
      ...(e.audit === "STALE" ? [[t("kv.hint"), e.full_checked_at ? t("hint.staleFull") : t("hint.staleHist")]] : []),
      ...(e.audit === "PARTIAL" ? [[t("kv.hint"), t("hint.partial")]] : []),
      ...(repairLine(l, I.errWords) ? [[t("kv.repair"), repairLine(l, I.errWords)]] : [])]),
    el("h5", {}, t("h.top")),
    e.top?.length ? el("ol", { class: "crm-find crm-topd" }, e.top.map((f, i) => { const x = lines(f); return el("li", {}, el("b", {}, `#${i + 1} ${x.title}`),
      x.detail ? el("small", { class: "id" }, x.detail) : "", el("small", {}, factLine(f) || `${t("fact.page")}${pageText(f)}`),
      el("small", {}, t("sevLine", sev(f), I.L.issue[f.category] || t("other"), fmt(f.verified_at)))); }))
      : el("p", {}, noTop(l)),
    ...(e.items?.length ? [el("h5", {}, t("h.all", e.items.length, e.audit === "FULL")), el("ul", { class: "crm-find" }, e.items.map(findItem))] : []),
  ];
  const stageSel = el("select", { class: "crm-sort", "aria-label": t("aria.stage"), disabled: blocked }, options(SALES_STAGES.filter((s) => s !== "DO_NOT_CONTACT"), I.L.stage, l.sales_stage));
  const contactSel = el("select", { class: "crm-sort", "aria-label": t("aria.contact"), disabled: blocked }, options(CONTACT_STATUSES, I.L.contact, l.contact_status));
  const callSel = el("select", { class: "crm-sort", "aria-label": t("aria.call"), disabled: blocked }, options(CALL_STATUSES, I.L.call, l.call_status));
  const save = (label, fn) => el("button", { type: "button", class: "crm-btn", disabled: dis || blocked, onclick: fn }, label);
  const src = l.dnc_source === "opt_out" ? t("src.opt_out") : l.dnc_source === "suppression" ? t("src.suppression") : t("src.registry");
  const unconfirmed = (l.findings_total || 0) - (l.findings_confirmed || 0);
  d.replaceChildren(
    el("div", { class: "crm-top" }, el("h3", {}, l.company || l.domain || l.lead_id), el("button", { type: "button", class: "crm-btn", onclick: closeDrawer, "aria-label": t("aria.closeDetail") }, t("btn.close"))),
    el("div", {}, link(l.website, l.domain || l.website || "–"), " ", stageBadge(l), " ", badge(l.priority?.level || "LOW", t("priority", level(l), l.priority?.score ?? 0)), " ", histBadge(l)),
    l.history_badge ? el("p", { class: "crm-note" }, t("histNote")) : "",
    blocked ? el("div", { class: "crm-dnc-banner" }, `${t("dncBanner")}${l.dnc_source && l.dnc_source !== "crm" ? t("dncSource", src) : ""}`) : "",
    el("small", {}, (l.priority?.reasons || []).map(I.reason).join(" · ") || t("noReasons")),
    qa, status,
    el("h4", {}, t("sec.contact")),
    kv([[t("kv.email"), mailLink(l)], [t("kv.phone"), telLink(l)], [t("kv.first"), l.first_name], [t("kv.last"), l.last_name], [t("kv.role"), l.role],
      [l.region ? t("kv.region") : t("kv.place"), place(l) || "–"], [t("kv.category"), cat(l)]]),
    el("h4", {}, t("sec.website")),
    kv([[t("kv.website"), link(l.website, l.website || "–")], [t("kv.reachable"), l.website_reachable === true ? t("yes") : l.website_reachable === false ? t("reach.no") : t("reach.unknown")],
      [t("kv.lastCheck"), fmt(l.website_checked_at)], [t("kv.first_check"), t("firstCheck", l.findings_confirmed || 0, unconfirmed)],
      [t("kv.updated"), fmt(l.updated_at)]]),
    el("h4", {}, t("sec.health")), ...findings,
    el("h4", {}, t("sec.outreach")),
    kv([[t("kv.draftStatus"), l.draft_status ? I.L.draft[l.draft_status] : "–"], [t("kv.draftCreated"), fmt(l.draft_created_at)], [t("kv.manualSent"), l.manual_sent ? `${t("yes")} · ${fmt(l.manual_sent_at)}` : t("no")],
      [t("kv.lastContact"), fmt(l.last_contact_at)], [t("kv.contactStatus"), I.L.contact[l.contact_status] || "–"]]),
    el("div", { class: "crm-qa" }, stageSel, save(t("btn.stage"), () => act("crm.updateStage", { lead_id: l.lead_id, stage: stageSel.value })),
      contactSel, save(t("btn.contact"), () => act("crm.updateContactStatus", { lead_id: l.lead_id, contact_status: contactSel.value }))),
    el("h4", {}, t("sec.phone")),
    kv([[t("kv.callStatus"), I.L.call[l.call_status] || "–"], [t("kv.callRec"), l.call_recommended ? t("yes") : t("no")]]),
    el("div", { class: "crm-qa" }, callSel, save(t("btn.callStatus"), () => act("crm.updateCallStatus", { lead_id: l.lead_id, call_status: callSel.value })),
      el("button", { type: "button", class: "crm-btn primary", disabled: dis || blocked, onclick: () => { $("crmCallForm").hidden = !$("crmCallForm").hidden; } }, t("btn.logCall"))),
    callForm(l, dis || blocked),
    l.call_history.length ? el("ul", { class: "crm-hist" }, [...l.call_history].reverse().map((c) => el("li", {}, el("time", {}, `${fmt(c.at)} · ${I.L.call[c.result] || "–"}`),
      c.note || "", c.next_action ? `\n${t("hist.next")}${c.next_action}` : "", c.follow_up_at ? `\n${t("hist.fu")}${fmt(c.follow_up_at)}` : ""))) : el("p", { class: "crm-note" }, t("noCalls")),
    el("h4", {}, t("sec.followup")),
    followForm(l, dis || blocked),
    el("h4", {}, t("sec.notes")),
    noteForm(l, dis),
    l.notes.length ? el("ul", { class: "crm-hist" }, [...l.notes].reverse().map((n) => el("li", {}, el("time", {}, fmt(n.at)), n.text))) : el("p", { class: "crm-note" }, t("noNotes")),
    ...(l.market === "VN" ? [el("h4", {}, t("sec.draft")), draftForm(l, blocked)] : []),
    ...(l.market === "VN" && ["SALES_AGENT_VN", "OWNER"].includes(S.actor?.role) ? [el("h4", {}, t("sec.order")), orderBox(l, blocked)] : []),
    // TF-065: Calling-Agent-Sektion (letzter Anruf, Ergebnis, Dauer, Rückruf, Versuche, Zusammenfassung) – nur Chris und Lap, Server prüft den Scope.
    // TF-068: Calling nur Vietnam – Sektion nur bei VN-Leads (Lap: Anrufen, Chris: Überwachung).
    ...(["SALES_AGENT_VN", "OWNER"].includes(S.actor?.role) && l.market === "VN" ? [el("h4", {}, callingTexts(I.locale).lead.h), leadCallBox(l, I.locale)] : []),
    // TF-066: Kunden-Onboarding der Aufträge dieses Leads (Server prüft Bereich/Markt; nie Zugangsdaten).
    el("h4", {}, onboardingTexts(I.locale).h), leadOnboardingBox(l, I.locale),
    el("h4", {}, t("sec.admin")),
    el("div", { class: "crm-qa" },
      l.do_not_contact && l.dnc_source !== "crm" ? el("span", { class: "crm-note" }, t("dncLocked"))
        : el("button", { type: "button", class: `crm-btn ${l.do_not_contact ? "warn" : "danger"}`, disabled: dis, onclick: () => {
          if (l.do_not_contact) { if (confirm(t("dncLift?"))) act("crm.setDoNotContact", { lead_id: l.lead_id, value: false }); return; }
          if (!confirm(t("dncSet?"))) return;
          const reason = (prompt(t("reason?")) || "").slice(0, 200);
          act("crm.setDoNotContact", { lead_id: l.lead_id, value: true, ...(reason.trim() ? { reason } : {}) });
        } }, l.do_not_contact ? t("btn.dncLift") : t("btn.dncSet")),
      el("button", { type: "button", class: "crm-btn", disabled: dis, onclick: () => act("crm.archive", { lead_id: l.lead_id, value: !l.archived }) }, l.archived ? t("btn.unarchive") : t("btn.archive"))),
    el("p", { class: "crm-note" }, t("footer")),
  );
}
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function callForm(l, dis) {
  const at = el("input", { type: "datetime-local", value: localNow(), required: true }), res = el("select", {}, options(CALL_STATUSES.filter((s) => s !== "NOT_CALLED"), I.L.call, "NO_ANSWER"));
  const note = el("textarea", { maxlength: "1000", placeholder: t("ph.callNote") }), next = el("input", { maxlength: "200", placeholder: t("ph.next") }), fu = el("input", { type: "date" });
  return el("form", { class: "crm-form", id: "crmCallForm", hidden: true, onsubmit: (e) => {
    e.preventDefault();
    const iso = new Date(at.value).toISOString();
    act("crm.addCall", { lead_id: l.lead_id, at: iso, result: res.value, ...(note.value.trim() ? { note: note.value } : {}), ...(next.value.trim() ? { next_action: next.value } : {}), ...(fu.value ? { follow_up_at: fu.value } : {}) });
  } }, el("div", { class: "two" }, el("label", {}, t("lbl.when"), at), el("label", {}, t("lbl.result"), res)), el("label", {}, t("lbl.note"), note),
    el("div", { class: "two" }, el("label", {}, t("lbl.next"), next), el("label", {}, t("lbl.fuDate"), fu)),
    el("button", { type: "submit", class: "crm-btn primary", disabled: dis }, t("btn.saveCall")));
}
function followForm(l, dis) {
  const next = el("input", { maxlength: "200", value: l.next_action || "", placeholder: t("ph.nextShort") });
  const date = el("input", { type: "date", value: /^\d{4}-\d{2}-\d{2}$/.test(l.next_action_at || "") ? l.next_action_at : "" });
  const fu = followUpBucket(l);
  return el("form", { class: "crm-form", onsubmit: (e) => { e.preventDefault(); act("crm.setNextAction", { lead_id: l.lead_id, next_action: next.value, next_action_at: date.value || null }); } },
    fu ? el("div", {}, badge(`fu-${fu}`, I.L.followUp[fu]), " ", fmt(l.next_action_at)) : "",
    el("div", { class: "two" }, el("label", {}, t("lbl.next"), next), el("label", {}, t("lbl.fuDate"), date)),
    el("div", { class: "crm-qa" }, el("button", { type: "submit", class: "crm-btn primary", disabled: dis }, t("btn.setFu")),
      el("button", { type: "button", class: "crm-btn", disabled: dis || (!l.next_action && !l.next_action_at), onclick: () => act("crm.setNextAction", { lead_id: l.lead_id, next_action: "", next_action_at: null }) }, t("btn.remove"))),
    el("small", {}, t("fuNote")));
}
function noteForm(l, dis) {
  const tx = el("textarea", { maxlength: "2000", placeholder: t("ph.note") });
  return el("form", { class: "crm-form", onsubmit: (e) => { e.preventDefault(); if (tx.value.trim()) act("crm.addNote", { lead_id: l.lead_id, text: tx.value }); } },
    tx, el("button", { type: "submit", class: "crm-btn primary", disabled: dis }, t("btn.addNote")));
}
// TF-063: Entwurf für einen VN-Lead – nur lead_id + Betreff + Text; der Empfänger wird SERVERSEITIG aus dem Lead bestimmt (nie frei wählbar).
function draftForm(l, blocked) {
  const out = el("p", { class: "crm-status", "aria-live": "polite" });
  if (!l.email) return el("p", { class: "crm-note" }, t("draft.noEmail"));
  const subj = el("input", { maxlength: "200", required: true }), body = el("textarea", { maxlength: "5000", required: true });
  return el("form", { class: "crm-form", onsubmit: async (e) => {
    e.preventDefault();
    out.textContent = t("act.saving"); out.className = "crm-status wait";
    try {
      const r = await fetch("/api/mail-requests", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "lead_draft", lead_id: l.lead_id, subject: subj.value, body: body.value }) });
      const j = await r.json().catch(() => null);
      if (r.ok) { out.textContent = t("draft.queued"); out.className = "crm-status ok"; subj.value = ""; body.value = ""; }
      else { out.textContent = errMsg(r.status, j) || t("draft.fail"); out.className = "crm-status bad"; }
    } catch { out.textContent = t("act.offline"); out.className = "crm-status bad"; }
  } }, el("p", { class: "crm-note" }, t("draft.h")), el("label", {}, t("draft.subject"), subj), el("label", {}, t("draft.body"), body),
    el("button", { type: "submit", class: "crm-btn primary", disabled: blocked }, t("draft.btn")), el("small", {}, t("draft.note")), out);
}

// TF-064: Kundenauftrag für einen EIGENEN VN-Lead – der Browser schickt nur lead_id + Angebot (CHECK/FIX) + Kundenbestätigung.
// Preis, Währung, Markt, Domain und E-Mail bestimmt der Server (pricing.js + autorisierter Lead). Keine Zahlungsfunktionen hier.
const OPEN_REQ = new Set(["pending", "processing"]);
const CLOSED = new Set(["COMPLETED", "COMPLETED_WITH_MANUAL_ITEMS", "CANCELLED"]);
function orderBox(l, blocked) {
  const box = el("div", { class: "crm-form crm-order" }, el("p", { class: "crm-note" }, t("app.loading")));
  const load = async () => {
    let j = null;
    try { const r = await fetch(`/api/sales?view=orders&lead_id=${encodeURIComponent(l.lead_id)}`, { cache: "no-store", credentials: "same-origin" }); j = r.ok ? await r.json() : null; } catch {}
    if (!j) { box.replaceChildren(el("p", { class: "crm-note" }, t("crm.unreachable"))); return; }
    const orders = j.orders || [];
    const open = orders.some((o) => OPEN_REQ.has(o.request_status) || (o.request_status === "done" && !CLOSED.has(o.state)));
    const card = (o) => el("div", { class: "crm-lcard" },
      kv([[t("ord.id"), o.order_id || (OPEN_REQ.has(o.request_status) ? t("ord.creating") : o.request_status === "failed" ? `${t("ord.failed")} · ${I.codeMsg(o.code)}` : "–")],
        [t("ord.service"), t(`ord.${o.offer}`)], [t("ord.total"), I.money(o.price, o.currency)], [t("ord.paid"), I.money(o.paid, o.currency)],
        [t("ord.rest"), I.money(o.remaining, o.currency)], [t("ord.payStatus"), t(`pay.${o.payment_status}`)], [t("ord.workStatus"), I.phase(o.phase)],
        [t("ord.commission"), I.money(Number(o.commission_expected), o.currency)]]));
    const out = el("p", { class: "crm-status", "aria-live": "polite" });
    const confirmBox = el("input", { type: "checkbox" });
    let chosen = null;
    const confirmForm = el("div", { hidden: true }, el("label", { class: "consent" }, confirmBox, " ", t("ord.confirm")),
      el("div", { class: "crm-qa" },
        el("button", { type: "button", class: "crm-btn primary", onclick: async (e) => {
          if (!confirmBox.checked) { out.textContent = t("ord.needConfirm"); out.className = "crm-status bad"; return; }
          e.target.disabled = true; out.textContent = t("act.saving"); out.className = "crm-status wait";
          try {
            const r = await fetch("/api/sales", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
              body: JSON.stringify({ op: "order.createConfirmed", lead_id: l.lead_id, offer: chosen, confirmed: true }) });
            const b = await r.json().catch(() => null);
            if (r.ok) { out.textContent = t("ord.queued"); out.className = "crm-status ok"; setTimeout(load, 1500); }
            else { out.textContent = errMsg(r.status, b); out.className = "crm-status bad"; e.target.disabled = false; }
          } catch { out.textContent = t("act.offline"); out.className = "crm-status bad"; e.target.disabled = false; }
        } }, t("ord.create")),
        el("button", { type: "button", class: "crm-btn", onclick: () => { confirmForm.hidden = true; chosen = null; } }, t("ord.cancel"))));
    const buttons = (j.offers || []).map((o) => el("button", { type: "button", class: "crm-btn", disabled: blocked || open,
      onclick: () => { chosen = o.offer; confirmBox.checked = false; confirmForm.hidden = false; } }, `${t(`ord.${o.offer}`)} · ${I.money(o.price, o.currency)}`));
    box.replaceChildren(
      ...(orders.length ? orders.map(card) : [el("p", { class: "crm-note" }, t("ord.none"))]),
      open ? el("p", { class: "crm-note" }, t("ord.open")) : el("p", { class: "crm-note" }, t("ord.choose")),
      el("div", { class: "crm-qa" }, buttons), confirmForm, el("small", {}, t("ord.payNote")), out);
  };
  load();
  return box;
}

// ---------- Schreiben: Auftrag → VPS → Ergebnis ----------
let busy = false;
async function act(action, params) {
  if (busy) return;
  busy = true;
  const out = () => $("crmActStatus");
  const say = (tx, cls) => { if (out()) { out().textContent = tx; out().className = `crm-status ${cls}`; } };
  say(t("act.saving"), "wait");
  try {
    const { status, body } = await api("", { method: "POST", body: JSON.stringify({ action, params }) });
    if (status !== 202) { say(errMsg(status, body), "bad"); return; }
    const rid = body.request.request_id;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, i < 4 ? 1000 : 2000));
      const r = await api(`?request=${rid}&watch=1`);
      const q = r.body?.request;
      if (!q || ["pending", "running"].includes(q.status)) continue;
      if (q.status === "done") {
        if (r.body.lead) { const i2 = S.leads.findIndex((x) => x.lead_id === r.body.lead.lead_id); if (i2 >= 0) S.leads[i2] = r.body.lead; }
        render(); say(t("act.ok"), "ok");
      } else say(q.code ? I.codeMsg(q.code, q.error) : I.vi ? t("act.notSaved", q.status) : q.error || t("act.notSaved", q.status), "bad");
      return;
    }
    say(t("act.noConfirm"), "bad");
  } catch { say(t("act.offline"), "bad"); }
  finally { busy = false; }
}
async function exportCsv() {
  readFilters();
  const p = new URLSearchParams({ export: "csv", sort: S.sort });
  for (const [k, v] of Object.entries(S.filters)) p.set(k, v);
  try {
    const r = await fetch("/api/crm?" + p.toString(), { cache: "no-store", credentials: "same-origin" });
    if (!r.ok) throw new Error(t("act.err", r.status));
    const url = URL.createObjectURL(await r.blob());
    const a = el("a", { href: url, download: `jarvis-crm-${new Date().toISOString().slice(0, 10)}.csv` }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (e) { setMeta(t("export.fail", e.message), true); }
}

// ---------- Gerüst ----------
function build() {
  const sel = (k, label, opts) => el("select", { id: "crmF_" + k, "aria-label": label }, el("option", { value: "" }, label), opts.map(([v, tx]) => el("option", { value: v }, tx)));
  const box = $("crm");
  box.replaceChildren(
    el("div", { class: "crm-top" }, el("h2", { id: "crmTitle" }, t("crm.title")), el("span", { class: "meta", id: "crmMeta" }, ""),
      el("button", { type: "button", class: "crm-btn", onclick: load }, t("btn.refresh")), el("button", { type: "button", class: "crm-btn", onclick: exportCsv }, t("btn.csv")),
      el("button", { type: "button", class: "crm-btn", id: "crmOnbBtn", onclick: toggleOnboarding }, onboardingTexts(I.locale).panel),
      el("button", { type: "button", class: "crm-btn", onclick: close }, t("btn.close"))),
    el("div", { id: "crmOnbSlot" }),
    el("div", { class: "crm-cards pipe", id: "crmPipeCards", role: "group", "aria-label": t("aria.pipe") }),
    el("div", { class: "crm-cards", id: "crmCards", role: "group", "aria-label": t("aria.cards") }),
    el("div", { class: "crm-cards errs", id: "crmErrCards", role: "group", "aria-label": t("aria.errs") }),
    el("div", { class: "crm-next", id: "crmNext" }),
    el("div", { class: "crm-bar" }, el("input", { type: "search", class: "crm-search", id: "crmF_q", placeholder: t("ph.search"), "aria-label": t("aria.search"), maxlength: "80", enterkeyhint: "search" }),
      el("select", { class: "crm-sort", id: "crmSort", "aria-label": t("aria.sort") }, Object.keys(SORTS).map((k) => el("option", { value: k }, t("sortBy", I.L.sorts[k])))),
      el("span", { id: "crmCount", class: "crm-next" })),
    el("details", { class: "crm-filters", open: !MOBILE.matches }, el("summary", {}, t("filters")),
      el("div", { class: "crm-fgrid" },
        sel("stage", t("f.stage"), SALES_STAGES.map((s) => [s, I.L.stage[s]])), sel("canton", t("f.canton"), []), sel("region", t("f.region"), []), sel("category", t("f.category"), []),
        sel("phone", t("f.phone"), [["1", t("f.phone1")], ["0", t("f.phone0")]]), sel("person", t("f.person"), [["1", t("f.person1")], ["0", t("f.person0")]]),
        sel("draft", t("f.draft"), [["1", t("f.draft1")], ["0", t("f.draft0")]]),
        sel("errors", t("f.errors"), [["0", "0"], ["1-2", "1–2"], ["3-5", "3–5"], ["6+", "6+"]]),
        sel("audit", t("f.audit"), ["FULL", "PARTIAL", "STALE", "NONE"].map((a) => [a, I.L.audit[a]])),
        sel("issue", t("f.issue"), ISSUE_CATEGORIES.map((c) => [c, I.L.issue[c]])),
        sel("contact", t("f.contact"), CONTACT_STATUSES.map((s) => [s, I.L.contact[s]])), sel("call", t("f.call"), CALL_STATUSES.map((s) => [s, I.L.call[s]])),
        sel("followup", t("f.followup"), [["due", t("f.fuDue")], ["OVERDUE", t("f.fuOver")], ["TODAY", t("f.fuToday")], ["LATER", t("f.fuLater")], ["none", t("f.fuNone")]]),
        sel("dnc", t("f.dnc"), [["1", t("f.dnc1")], ["0", t("f.dnc0")]]),
        sel("archived", t("f.archived"), [["only", t("f.archOnly")], ["all", t("f.archAll")]]),
        el("button", { type: "button", class: "crm-btn", onclick: () => { document.querySelectorAll("#crm .crm-fgrid select, #crmF_q").forEach((x) => { x.value = ""; }); S.card = ""; renderCardsPressed(); renderList(); } }, t("btn.reset")))),
    el("div", { class: "crm-main", id: "crmMain" }),
  );
  // Region-Filter nur, wenn VN-Leads vorhanden sind (facets()); bis dahin ausgeblendet.
  $("crmF_region").hidden = true;
  if (!box.dataset.bound) {
    box.dataset.bound = "1";
    box.addEventListener("input", (e) => { if (e.target.id === "crmF_q") renderList(); });
    box.addEventListener("change", (e) => { if (e.target.closest(".crm-fgrid") || e.target.id === "crmSort") renderList(); });
    MOBILE.addEventListener("change", () => { if (!box.hidden) renderList(); });
  }
}
// TF-066: Übersicht Kunden-Onboarding mit Filtern (Owner: alle Aufträge; Verkäufer: nur eigener Bereich – Server prüft).
function toggleOnboarding() {
  const slot = $("crmOnbSlot");
  if (slot.childElementCount) { slot.replaceChildren(); return; }
  slot.replaceChildren(onboardingPanel(I.locale, { onClose: () => slot.replaceChildren() }));
}
function open() {
  if (!$("crm").childElementCount) build();
  $("crm").hidden = false;
  if (location.hash !== "#crm") history.replaceState(null, "", "#crm");
  load();
  clearInterval(S.timer); S.timer = setInterval(() => { if (document.visibilityState === "visible" && !busy) load(); }, 30_000);
}
function close() { clearInterval(S.timer); closeDrawer(); $("crm").hidden = true; if (location.hash === "#crm") history.replaceState(null, "", location.pathname + location.search); }
// Sprache wechseln (sales-app.js nach /api/auth/me): Gerüst neu aufbauen.
function setLocale(locale) { I = createI18n(locale); document.documentElement.lang = I.vi ? "vi" : "de"; $("crm").replaceChildren(); S.facets = false; }
document.addEventListener("keydown", (e) => { if (e.key !== "Escape" || $("crm").hidden) return; if (!$("crmDrawer").hidden) closeDrawer(); else close(); });
$("crmBtn")?.addEventListener("click", open);
if (location.hash === "#crm" && !document.documentElement.dataset.deferCrm) open();
window.JarvisCrm = { open, close, openLead, setLocale, state: S, get i18n() { return I; } };
