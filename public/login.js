// TF-063 Login: Benutzername + Passwort → POST /api/auth/login → HttpOnly-Session-Cookie (vom Server gesetzt, für JS unsichtbar).
// Nichts Geheimes im Browser-Speicher: gemerkt wird nur die zuletzt gewählte Anzeigesprache. Danach je Rolle: Owner → /, Verkäufer → /sales.html.
import { createI18n, normLocale } from "./i18n.js";

const $ = (id) => document.getElementById(id);
let loc = normLocale((() => { try { return localStorage.getItem("jarvis.locale"); } catch { return null; } })() || (navigator.language?.startsWith("vi") ? "vi-VN" : "de-CH"));
const target = (u) => (u?.role === "OWNER" ? "/" : "/sales.html");
function apply() {
  const { t, vi } = createI18n(loc);
  document.documentElement.lang = vi ? "vi" : "de"; document.documentElement.dataset.locale = loc;
  document.title = `J.A.R.V.I.S. – ${t("login.title")}`;
  $("lTitle").textContent = t("login.title"); $("lUser").textContent = t("login.user"); $("lPass").textContent = t("login.password");
  $("lSubmit").textContent = t("login.submit"); $("lHint").textContent = t("login.hint");
  document.querySelectorAll(".langs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.loc === loc)));
}
document.querySelectorAll(".langs button").forEach((b) => b.addEventListener("click", () => { loc = b.dataset.loc; try { localStorage.setItem("jarvis.locale", loc); } catch {} apply(); }));
apply();
// Bereits angemeldet → direkt weiter.
fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" }).then(async (r) => { if (r.ok) location.replace(target((await r.json()).user)); }).catch(() => {});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { t } = createI18n(loc), msg = $("lMsg"), btn = $("lSubmit");
  const username = $("user").value.trim(), password = $("pass").value;
  if (!username || !password) return;
  btn.disabled = true; msg.className = "msg"; msg.textContent = t("login.busy");
  try {
    const r = await fetch("/api/auth/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    $("pass").value = "";
    if (r.ok) {
      const u = (await r.json()).user;
      try { localStorage.setItem("jarvis.locale", u.locale); } catch {}
      location.replace(target(u));
      return;
    }
    msg.className = "msg bad"; msg.textContent = r.status === 429 ? t("login.rate") : r.status === 401 ? t("login.bad") : t("login.error");
  } catch { msg.className = "msg bad"; msg.textContent = t("login.error"); }
  finally { btn.disabled = false; }
});
