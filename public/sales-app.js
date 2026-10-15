// TF-063 Verkäufer-Oberfläche: eigene Leads (CRM, serverseitig gefiltert), eigene Provision, eigener Jarvis-Chat (user-scoped Verlauf).
// Sprache aus der Sitzung (/api/auth/me): Giuliano/Mario/Damiano de-CH, Lap vi-VN – alle sichtbaren Texte über i18n.js.
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
  $("aComStats").replaceChildren(stat("warn", `${c.currency} ${c.pending}`, t("com.pending")), stat("ok", `${c.currency} ${c.payable}`, t("com.payable")),
    stat("bad", `${c.currency} ${c.reversed}`, t("com.reversed")), stat("", String(c.paid_completed_orders), t("com.orders")),
    stat("", t("com.rate", c.rate_bps / 100), t("com.title")));
  $("aComOrders").replaceChildren(...(c.orders.length ? c.orders.map((o) => { const li = document.createElement("li");
    li.textContent = `${t("com.order")} ${o.order_id} · ${t(`com.st.${o.status}`)} · ${t("com.price")} ${o.currency} ${o.price} · ${t("com.amount")} ${o.currency} ${o.commission}`; return li; })
    : [Object.assign(document.createElement("li"), { textContent: t("com.none") })]));
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
  // CRM-Modul erst jetzt laden – mit der Sprache des Benutzers (Lap: vi-VN).
  document.documentElement.dataset.locale = me.locale;
  await import("./crm.js");
  window.JarvisCrm.setLocale(me.locale);
  $("crmBtn").textContent = I.t("app.leads_open");
  if (location.hash === "#crm") window.JarvisCrm.open();
  $("aLogout").addEventListener("click", async () => { try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch {} toLogin(); });
  $("aChatForm").addEventListener("submit", (e) => { e.preventDefault(); const v = $("aChatIn").value.trim(); if (!v) return; $("aChatIn").value = ""; ask(v); });
  await Promise.all([loadSummary(), loadChat()]);
}
start().catch(() => { $("aMsg").textContent = I.t("app.unreachable"); });
