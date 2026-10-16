// TF-063 Verkäufer-Oberfläche: eigene Leads (CRM, serverseitig gefiltert), eigene Provision, eigener Jarvis-Chat (user-scoped Verlauf).
// Sprache aus der Sitzung (/api/auth/me): Giuliano/Mario/Damiano de-CH, Kudoshin vi-VN – alle sichtbaren Texte über i18n.js.
// Kein Zugriff auf Owner-Funktionen; jede Grenze prüft zusätzlich der Server (403).
import { createI18n } from "./i18n.js";

const $ = (id) => document.getElementById(id);
let I = createI18n("de-CH"), me = null, turns = [];
const toLogin = () => location.replace("/login.html");
addEventListener("jarvis:unauthorized", toLogin);
const get = async (url) => { const r = await fetch(url, { cache: "no-store", credentials: "same-origin" }); if (r.status === 401) toLogin(); return { status: r.status, body: await r.json().catch(() => null) }; };

function texts() {
  const t = I.t;
  document.documentElement.lang = I.vi ? "vi" : "de"; document.documentElement.dataset.locale = I.locale;
  $("aRole").textContent = t(`app.role.${me.role}`); $("aName").textContent = me.name; $("aMarket").textContent = me.markets.map((m) => t(`app.market.${m}`)).join(" · ");
  $("aLogout").textContent = t("app.logout"); $("aLeadsH").textContent = t("app.leads"); $("crmBtn").textContent = t("app.leads_open");
  $("aComH").textContent = t("com.title"); $("aComRule").textContent = `${t("com.rule")} ${t("com.payout_note")}`;
  $("aChatH").textContent = t("app.chat"); $("aChatIn").placeholder = t("chat.placeholder"); $("aChatSend").textContent = t("chat.send");
}
async function loadSummary() {
  const { status, body } = await get("/api/sales?view=summary");
  if (status !== 200 || !body) { $("aMsg").textContent = I.t("app.unreachable"); return; }
  const c = body.commission, t = I.t;
  $("aLeadsText").textContent = t("app.leads_text", body.leads?.total ?? 0);
  const stat = (cls, v, label) => { const d = document.createElement("div"); d.className = cls; const b = document.createElement("b"); b.textContent = v; const s = document.createElement("span"); s.textContent = label; d.append(b, s); return d; };
  // TF-064: Beträge in der Währung des Verkäufers (Kudoshin: VND «346.500 ₫», CH: «CHF 52.50») – nie gemischt.
  const m = (v, cur = c.currency) => I.money(Number(v), cur);
  $("aComStats").replaceChildren(stat("warn", m(c.pending), t("com.pending")), stat("ok", m(c.payable), t("com.payable")),
    stat("bad", m(c.reversed), t("com.reversed")), stat("", m(c.paid_out ?? 0), t("com.paid_out")), stat("", String(c.paid_completed_orders), t("com.orders")),
    stat("", t("com.rate", c.rate_bps / 100), t("com.title")));
  $("aComOrders").replaceChildren(...(c.orders.length ? c.orders.map((o) => { const li = document.createElement("li");
    li.textContent = `${t("com.order")} ${o.order_id} · ${t(`com.st.${o.status}`)} · ${t("com.price")} ${m(o.price, o.currency)} · ${t("com.amount")} ${m(o.commission, o.currency)}`; return li; })
    : [Object.assign(document.createElement("li"), { textContent: t("com.none") })]));
}
// TF-068: eigene Verkäufe (Kudoshin: nur eigene VN-Aufträge, serverseitig gefiltert) – Angebot, Betrag, Zahlungs-/Auftrags-/Provisionsstatus.
async function loadSales() {
  const { status, body } = await get("/api/sales?view=orders");
  if (status !== 200 || !body) return;
  const t = I.t;
  $("aSales").hidden = false; $("aSalesH").textContent = t("sales.title");
  $("aSalesList").replaceChildren(...(body.orders.length ? body.orders.map((o) => Object.assign(document.createElement("li"), { textContent:
    `${o.order_id || "–"} · ${o.company || o.domain} · ${t("sales.offer")} ${o.offer_name || o.offer} · ${I.money(Number(o.price), o.currency)} · ${t("sales.paid")} ${I.money(Number(o.paid), o.currency)} · ${t("sales.pay")} ${o.payment_status} · ${t("sales.state")} ${o.state || "–"} · ${t("com.amount")} ${I.money(Number(o.commission), o.currency)} (${t(`com.st.${o.commission_status}`)})` }))
    : [Object.assign(document.createElement("li"), { textContent: t("sales.none") })]));
}
// TF-073: eigene Geräte – Liste, Einmal-Code zum Koppeln, Widerruf. Keine Fernsteuerung fremder Geräte (Server: 403).
async function loadDevices() {
  const t = I.t, { status, body } = await get("/api/devices");
  $("aDevH").textContent = t("dev.title"); $("aDevNote").textContent = t("dev.note"); $("aDevPair").textContent = t("dev.pair");
  if (status !== 200 || !body) { $("aDevList").replaceChildren(Object.assign(document.createElement("li"), { textContent: t("dev.fail", status) })); return; }
  const live = body.devices.filter((d) => d.status !== "revoked");
  $("aDevList").replaceChildren(...(live.length ? live.map((d) => {
    const li = document.createElement("li");
    li.textContent = `${d.device_name} · ${d.device_type} · ${t(`dev.st.${d.status}`)} · ${d.online ? t("dev.online") : t("dev.offline")} `;
    if (d.status === "active") {
      const b = Object.assign(document.createElement("button"), { type: "button", className: "btn ghost", textContent: t("dev.revoke") });
      b.addEventListener("click", async () => { if (!confirm(t("dev.confirm"))) return; await post(`/api/devices/${encodeURIComponent(d.device_id)}/revoke`, {}); loadDevices(); });
      li.append(b);
    }
    return li;
  }) : [Object.assign(document.createElement("li"), { textContent: t("dev.none") })]));
}
const post = async (url, body) => { const r = await fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (r.status === 401) toLogin(); return { status: r.status, body: await r.json().catch(() => null) }; };
async function pairStart() {
  const t = I.t, r = await post("/api/devices/pair/start", {});
  if (r.status !== 200) { $("aDevCode").textContent = t("dev.fail", r.body?.code || r.status); return; }
  $("aDevCode").textContent = `${t("dev.code", r.body.pairing_code, new Date(r.body.expires_at).toLocaleTimeString(I.locale))} · ${t("dev.howto")}`;
}
// ---------- Chat (eigener Verlauf über /api/state – nie Chris' Kontext) ----------
function renderChat() {
  const log = $("aChatLog");
  if (!turns.length) { log.replaceChildren(Object.assign(document.createElement("li"), { textContent: I.t("chat.empty") })); return; }
  log.replaceChildren(...turns.map((x) => Object.assign(document.createElement("li"), { className: x.role, textContent: x.content })));
  log.scrollTop = log.scrollHeight;
}
async function loadChat() {
  const { status, body } = await get("/api/state");
  if (status === 200) turns = (body?.conversation?.turns || []).map(({ role, content }) => ({ role, content }));
  renderChat();
}
async function ask(text) {
  const msg = $("aChatMsg"); msg.textContent = ""; msg.className = "msg";
  turns.push({ role: "user", content: text }); renderChat();
  let answer = "";
  try {
    const r = await fetch("/api/cloud", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: turns.slice(-20) }) });
    if (r.status === 401) return toLogin();
    if (!r.ok || !r.body) throw new Error(String(r.status));
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = "";
    turns.push({ role: "assistant", content: "" });
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data:")); buf = buf.slice(i + 2);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "text") { answer += (answer ? " " : "") + ev.text; turns[turns.length - 1].content = answer; renderChat(); }
      }
    }
    if (!answer) throw new Error("empty");
    fetch("/api/state", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "conversation", turns: [{ role: "user", content: text }, { role: "assistant", content: answer }] }) }).catch(() => {});
  } catch {
    if (turns.at(-1)?.role === "assistant" && !turns.at(-1).content) turns.pop();
    msg.className = "msg bad"; msg.textContent = I.t("chat.error"); renderChat();
  }
}

async function start() {
  const { status, body } = await get("/api/auth/me");
  if (status !== 200 || !body?.user) return toLogin();
  me = body.user;
  if (me.role === "OWNER") return location.replace("/");
  try { localStorage.setItem("jarvis.locale", me.locale); } catch {}
  I = createI18n(me.locale);
  texts();
  $("app").hidden = false;
  // CRM-Modul erst jetzt laden – mit der Sprache des Benutzers (Kudoshin: vi-VN).
  document.documentElement.dataset.locale = me.locale;
  await import("./crm.js");
  window.JarvisCrm.setLocale(me.locale);
  $("crmBtn").textContent = I.t("app.leads_open");
  if (location.hash === "#crm") window.JarvisCrm.open();
  $("aLogout").addEventListener("click", async () => { try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch {} toLogin(); });
  $("aDevPair").addEventListener("click", pairStart);
  $("aChatForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("aChatIn").value.trim(); if (!v) return; $("aChatIn").value = ""; ask(v); });
  // TF-065: Trợ lý gọi điện – nur Kudoshin (VN). Giuliano/Mario/Damiano sehen den Bereich nicht (und erhalten serverseitig 403).
  if (me.role === "SALES_AGENT_VN") { const { mountCalling } = await import("./calling-ui.js"); $("aCalling").hidden = false; mountCalling($("aCalling"), { locale: me.locale }); }
  await Promise.all([loadSummary(), loadChat(), loadDevices(), me.role === "SALES_AGENT_VN" ? loadSales() : null]);
}
start().catch(() => { $("aMsg").textContent = I.t("app.unreachable"); });
