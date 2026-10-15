// TF-063 Owner-Bereich „ZUGÄNGE“: Verkäufer-Zugänge (Passwort setzen/zurücksetzen, Sessions abmelden, aktiv/inaktiv), Provisionen aller
// Verkäufer und Lead-Zuweisungen. Nur Anzeige + Aufrufe der Owner-APIs – jede Berechtigung prüft der Server (Verkäufer erhalten 403).
// Passwörter werden nur einmal an den Server geschickt (HTTPS) und nie angezeigt, gespeichert oder protokolliert.
import { mountCalling } from "./calling-ui.js";
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...kids) {
  const x = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") x.className = v; else if (k.startsWith("on")) x.addEventListener(k.slice(2), v); else x.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) x.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return x;
}
const fmt = (v) => (v ? new Date(v).toLocaleString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "–");
const ROLE = { SALES_MANAGER_CH: "Vertriebsleitung Schweiz", SALES_AGENT_CH: "Vertrieb Schweiz", SALES_AGENT_VN: "Vertrieb Vietnam", OWNER: "Owner" };
const LANG = { "de-CH": "Deutsch (de-CH)", "vi-VN": "Vietnamesisch (vi-VN)" };
const SCOPE = { giuliano: "Alle CH-Leads ausser Mario-/Damiano-Portfolio (inkl. neue CH-Leads)", mario: "Nur eigenes Portfolio (200 CH-Leads)",
  damiano: "Nur eigenes Portfolio (200 CH-Leads)", lap: "Nur Vietnam-Leads" };
const ST = { PENDING: "Ausstehend", PAYABLE: "Auszahlbar", REVERSED: "Storniert" };
const call = async (url, body) => {
  const r = await fetch(url, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let note = null;
const say = (t, bad = false) => { if (note) { note.textContent = t; note.style.color = bad ? "var(--red)" : "var(--green)"; } };

function userCard(u) {
  const pw = el("input", { type: "password", autocomplete: "new-password", minlength: "12", maxlength: "256", placeholder: "Neues Passwort (mind. 12 Zeichen)", "aria-label": `Neues Passwort für ${u.name}` });
  const act = async (path, body, msg, confirmText) => {
    if (confirmText && !confirm(confirmText)) return;
    const r = await call(`/api/auth/admin/${path}`, { user_id: u.user_id, ...body });
    pw.value = "";
    if (r.status === 200) { say(msg); render(r.body); } else say(r.body?.error || `Fehler ${r.status}`, true);
  };
  return el("li", { class: "crm-lcard" },
    el("div", { class: "row" }, el("h3", {}, u.name), el("span", { class: `crm-badge ${u.active ? "st-CUSTOMER" : "dnc"}` }, u.active ? "AKTIV" : "INAKTIV")),
    el("div", { class: "kv" }, ...[["Rolle", ROLE[u.role]], ["Sprache", LANG[u.locale]], ["Markt", u.markets.join(", ")], ["Lead-Zugriff", SCOPE[u.user_id]],
      ["Provision", `${u.commission_rate_bps / 100} %`], ["Passwort", u.password_set ? `gesetzt (${fmt(u.password_set_at)})` : "NOCH NICHT GESETZT"], ["Letzter Login", fmt(u.last_login_at)],
      ["Aktive Sessions", String(u.active_sessions)]].flatMap(([k, v]) => [el("span", {}, k), el("b", {}, v)])),
    el("form", { class: "crm-form", onsubmit: (e) => { e.preventDefault(); if (pw.value.length < 12) return say("Passwort zu kurz – mindestens 12 Zeichen.", true); act("password", { password: pw.value }, `Passwort für ${u.name} gesetzt (wird nicht angezeigt). Bestehende Sessions beendet.`); } },
      pw, el("div", { class: "crm-qa" },
        el("button", { type: "submit", class: "crm-btn primary" }, "PASSWORT SETZEN"),
        el("button", { type: "button", class: "crm-btn warn", onclick: () => act("reset", {}, `Passwort von ${u.name} zurückgesetzt – kein Login bis ein neues gesetzt ist.`, `Passwort von ${u.name} zurücksetzen? ${u.name} kann sich danach nicht mehr anmelden, bis Sie ein neues setzen.`) }, "PASSWORT ZURÜCKSETZEN"),
        el("button", { type: "button", class: "crm-btn", onclick: () => act("revoke", {}, `Alle Sessions von ${u.name} abgemeldet.`) }, "SESSIONS ABMELDEN"),
        el("button", { type: "button", class: `crm-btn ${u.active ? "danger" : ""}`, onclick: () => act("active", { active: !u.active }, `${u.name} ${u.active ? "deaktiviert" : "aktiviert"}.`, u.active ? `${u.name} deaktivieren? Alle Sessions werden beendet.` : null) }, u.active ? "DEAKTIVIEREN" : "AKTIVIEREN"))));
}
// TF-064: Beträge je Währung – CHF und VND werden nie zu einer Summe addiert.
const money = (v, cur = "CHF") => { const n = Number(v); if (!Number.isFinite(n)) return "–"; return cur === "VND" ? `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫` : `CHF ${n.toFixed(2)}`; };
const SELLER_CUR = { giuliano: "CHF", mario: "CHF", damiano: "CHF", lap: "VND" };
function commissionBox(c) {
  if (!c) return el("p", { class: "crm-note" }, "Provisionen nicht verfügbar.");
  const sel = (e) => el("select", { class: "crm-sort", "aria-label": `Verkäufer für ${e.order_id}`, onchange: async (ev) => {
    const r = await call("/api/sales", { op: "commission.setSeller", order_id: e.order_id, seller_id: ev.target.value || null });
    if (r.status === 200) { say(`Verkäufer für ${e.order_id} gesetzt (auditiert).`); load(); } else say(r.body?.error || `Fehler ${r.status}`, true);
  } }, el("option", { value: "" }, "– zuordnen –"), ["giuliano", "mario", "damiano", "lap"].filter((s) => SELLER_CUR[s] === (e.currency || "CHF")).map((s) => el("option", { value: s }, s)));
  const tot = c.totals_by_currency || { CHF: c.totals };
  const totalRow = (cur) => tot[cur] ? el("tr", {}, el("td", {}, el("b", {}, `Total ${cur}`)), el("td", {}, el("b", {}, money(tot[cur].pending, cur))), el("td", {}, el("b", {}, money(tot[cur].payable, cur))),
    el("td", {}, el("b", {}, money(tot[cur].reversed, cur))), el("td", {}, el("b", {}, String(tot[cur].paid_completed_orders)))) : "";
  return el("div", {},
    el("p", { class: "crm-note" }, `Satz 35 % · auszahlbar erst bei COMPLETED / COMPLETED_WITH_MANUAL_ITEMS UND vollständig bezahlt · gilt ab ${fmt(c.eligible_from)} (nicht rückwirkend) · VN-Preise: ${c.pricing?.VN === "CONFIGURED" ? "konfiguriert (990.000 ₫ / 3.900.000 ₫)" : "noch NICHT konfiguriert"} · keine automatische Auszahlung`),
    el("table", { class: "crm-table" }, el("thead", {}, el("tr", {}, ["Verkäufer", "Ausstehend", "Auszahlbar", "Storniert", "Abgeschl. + bezahlt"].map((h) => el("th", {}, h)))),
      el("tbody", {}, [...c.sellers.map((s) => el("tr", {}, el("td", {}, s.seller_id), el("td", {}, money(s.pending, s.currency)), el("td", {}, money(s.payable, s.currency)), el("td", {}, money(s.reversed, s.currency)), el("td", {}, String(s.paid_completed_orders)))),
        totalRow("CHF"), totalRow("VND")])),
    c.sellers.some((s) => s.orders.length) ? el("ul", { class: "crm-hist" }, c.sellers.flatMap((s) => s.orders.map((o) => el("li", {}, `${s.seller_id} · ${o.order_id} · ${ST[o.status]} · ${o.order_state || "–"} / ${o.payment_status || "–"} · Preis ${money(o.price, o.currency)} · Provision ${money(o.commission, o.currency)}`)))) : "",
    c.unassigned?.length ? el("div", {}, el("h5", {}, "Aufträge ohne Verkäufer (ohne CRM-Lead)"), el("ul", { class: "crm-hist" }, c.unassigned.map((e) => el("li", {}, `${e.order_id} · ${ST[e.status]} `, e.status === "PAYABLE" ? "" : sel(e))))) : "");
}
function assignBox(a) {
  if (!a) return el("p", { class: "crm-note" }, "Zuweisungen nicht verfügbar.");
  const r = a.report, g = (x) => `${x.count} · HIGH ${x.HIGH} / MEDIUM ${x.MEDIUM} / LOW ${x.LOW} · Telefon ${x.with_phone} · E-Mail ${x.with_email} · Ø Priorität ${x.avg_priority}`;
  const vn = a.vn || {};
  return el("div", {}, el("div", { class: "kv" }, ...[["Mario", g(r.mario)], ["Damiano", g(r.damiano)], ["Überschneidung", String(r.overlap)], ["Giuliano ausgeschlossen", String(r.giuliano_excluded)],
    ["Giuliano sichtbar (CH)", String(r.giuliano_visible_ch)], ["CH gesamt", String(r.ch_total)], ["Verteilt am", fmt(a.created_at)],
    ["Vietnam-Discovery", vn.status ? `${vn.status.audited_today}/${vn.status.daily_limit} Audits heute (${vn.status.day}) · ${vn.leads} VN-Leads · Einheit ${vn.status.cursor_unit || "–"} · ${vn.paused ? "PAUSIERT" : "aktiv"}` : "noch kein Status"]]
    .flatMap(([k, v]) => [el("span", {}, k), el("b", {}, v)])),
    el("div", { class: "crm-qa" }, el("button", { type: "button", class: "crm-btn", onclick: async () => { const x = await call("/api/sales", { op: vn.paused ? "vn.resume" : "vn.pause" }); say(x.status === 200 ? (x.body.paused ? "Vietnam-Discovery pausiert." : "Vietnam-Discovery fortgesetzt.") : `Fehler ${x.status}`, x.status !== 200); load(); } }, vn.paused ? "VN-DISCOVERY FORTSETZEN" : "VN-DISCOVERY PAUSIEREN")));
}
let users = null, com = null, asg = null;
function render(u = users) {
  users = u || users;
  const box = $("ownerAdmin");
  note = el("p", { class: "crm-status", "aria-live": "polite" });
  box.replaceChildren(
    el("div", { class: "crm-top" }, el("h2", { id: "oaTitle" }, "ZUGÄNGE"), el("span", { class: "meta" }, "Verkäufer-Zugänge, Provisionen und Zuweisungen – nur Owner"),
      el("button", { type: "button", class: "crm-btn", onclick: load }, "AKTUALISIEREN"), el("button", { type: "button", class: "crm-btn", onclick: () => { box.hidden = true; } }, "SCHLIESSEN")),
    note,
    el("div", { class: "crm-main" },
      users ? el("ul", { class: "crm-list oa-users" }, users.users.map(userCard)) : el("p", {}, "Lade …"),
      el("h4", {}, "PROVISION"), commissionBox(com),
      el("h4", {}, "LEAD-ZUWEISUNG"), assignBox(asg)));
}
async function load() {
  const [u, c, a] = await Promise.all([call("/api/auth/admin/users"), call("/api/sales?view=commission"), call("/api/sales?view=assignments")]);
  if (u.status !== 200) { $("ownerAdmin").replaceChildren(el("p", { class: "crm-empty" }, u.status === 403 ? "Nur für den Owner." : `Nicht verfügbar (Fehler ${u.status}).`)); return; }
  com = c.status === 200 ? c.body : null; asg = a.status === 200 ? a.body : null;
  render(u.body);
}
$("accessBtn")?.addEventListener("click", () => { $("ownerAdmin").hidden = false; render(); load(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("ownerAdmin").hidden) $("ownerAdmin").hidden = true; });
// TF-065: Calling Agent (Owner) – Status, Vorschau, Kampagnen, aktive Anrufe. Der Server prüft Rolle, Scope und Berechtigung.
$("callingBtn")?.addEventListener("click", () => { const b = $("callingAgent"); b.hidden = false; mountCalling(b, { locale: "de-CH", onClose: () => { b.hidden = true; } }); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("callingAgent") && !$("callingAgent").hidden) $("callingAgent").hidden = true; });
