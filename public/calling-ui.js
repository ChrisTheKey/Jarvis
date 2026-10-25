// Mitarbeiter-Dashboard für CRM-Anrufe. Autonome Telefonie und Providersteuerung
// sind entfernt; Mitarbeiter erfassen Gespräche weiterhin im CRM.
const T = {
  "de-CH": { title: "VERTRIEBSANRUFE", sub: "Mitarbeiter-Dashboard · manuelle Gespräche", refresh: "AKTUALISIEREN", close: "SCHLIESSEN", recent: "Letzte Gespräche", callbacks: "Rückrufe", none: "Keine Einträge", manual: "Gespräch manuell führen und danach im CRM erfassen.", last: "Letzter Anruf", status: "Status", result: "Ergebnis", next: "Rückruf", summary: "Notiz", eligibility: "Berechtigung", noAccess: "Kein Zugang.", error: (s) => `Fehler ${s}` },
  "vi-VN": { title: "CUỘC GỌI BÁN HÀNG", sub: "Bảng điều khiển nhân viên · gọi thủ công", refresh: "LÀM MỚI", close: "ĐÓNG", recent: "Cuộc gọi gần đây", callbacks: "Gọi lại", none: "Không có dữ liệu", manual: "Nhân viên thực hiện cuộc gọi và ghi nhận trong CRM.", last: "Cuộc gọi cuối", status: "Trạng thái", result: "Kết quả", next: "Gọi lại", summary: "Ghi chú", eligibility: "Quyền gọi", noAccess: "Không có quyền.", error: (s) => `Lỗi ${s}` }
};
const text = (locale) => T[locale] || T["de-CH"];
const esc = (v) => String(v ?? "—").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => v ? new Date(v).toLocaleString() : "—";
const api = async (body = null, query = "") => fetch(`/api/calling${query}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
const row = (label, value) => `<div class="calling-kv"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
const calls = (items, t) => (items || []).map((x) => `<article class="calling-item">${row(t.last, fmt(x.started_at || x.created_at))}${row(t.status, x.status)}${row(t.result, x.result || x.outcome)}${row(t.next, fmt(x.callback_at))}${row(t.summary, x.summary || x.note)}</article>`).join("") || `<p>${t.none}</p>`;

export const callingTexts = (locale) => ({ lead: text(locale).title, h: text(locale).title });

export function mountCalling(box, { locale = "de-CH", onClose = null } = {}) {
  const t = text(locale);
  const render = (data = {}) => {
    box.innerHTML = `<section class="calling-panel"><header><div><h2>${t.title}</h2><p>${t.sub}</p></div><div><button data-calling-refresh>${t.refresh}</button>${onClose ? `<button data-calling-close>${t.close}</button>` : ""}</div></header><p class="calling-manual">${t.manual}</p><h3>${t.recent}</h3><div class="calling-list">${calls(data.recent_calls, t)}</div><h3>${t.callbacks}</h3><div class="calling-list">${calls(data.callbacks, t)}</div></section>`;
    box.querySelector("[data-calling-refresh]")?.addEventListener("click", load);
    box.querySelector("[data-calling-close]")?.addEventListener("click", onClose);
  };
  const load = async () => { try { const r = await api(); render(r.ok ? await r.json() : { recent_calls: [{ status: t.error(r.status) }] }); } catch { render({ recent_calls: [{ status: t.error("offline") }] }); } };
  render(); load();
  return { refresh: load };
}

export function leadCallBox(lead, locale = "de-CH") {
  const t = text(locale);
  const box = document.createElement("section");
  box.className = "lead-call-box";
  box.innerHTML = `<h3>${t.title}</h3><p>${t.manual}</p><div class="calling-list"><p>${t.last}: …</p></div>`;
  api(null, `?lead=${encodeURIComponent(lead.lead_id || lead.id || "")}`).then(async (r) => {
    if (!r.ok) return;
    const data = await r.json();
    box.querySelector(".calling-list").innerHTML = calls(data.recent_calls || data.calls, t) || `<p>${t.none}</p>`;
  }).catch(() => {});
  return box;
}
