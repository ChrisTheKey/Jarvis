// TF-066 Kunden-Onboarding – Anzeige im CRM (Lead-Detail für alle Rollen im eigenen Bereich; Übersicht mit Filtern für Chris).
// Nur Anzeige von /api/sales?view=onboarding (serverseitig gescoped). Keine Aktionen, keine Mails aus dem Browser. Nie Passwörter,
// Zugangsdaten, Links oder Token – der Server liefert sie gar nicht erst. Alle Inhalte per textContent.
const T = {
  "de-CH": {
    h: "Kunden-Onboarding", panel: "KUNDEN-ONBOARDING", close: "SCHLIESSEN", refresh: "AKTUALISIEREN", none: "Kein Onboarding für diesen Lead.", noneAll: "Keine Aufträge im Onboarding.",
    unreachable: "Onboarding-Stand nicht erreichbar.", order: "Auftrag", payment: "Zahlungsschwelle", access: "Zugang", content: "Inhaltsänderungen", waiting: "Wartet auf",
    lastCustomer: "Letzte Kundenantwort", lastJarvis: "Letzte Jarvis-Antwort", open: "Offene Punkte", state: "Status", reason: "Hinweis", changes: "Bestätigte bzw. gemeldete Website-Angaben",
    pay: { met: "Erfüllt", open: "Offen" },
    acc: { not_required: "Nicht nötig (Check)", hosting_missing: "Plattform wird geklärt", missing: "Fehlt", link_sent: "Link gesendet", link_expired: "Link abgelaufen", received: "Erhalten", checked: "Geprüft" },
    cnt: { none: "Keine", open: "Offen", confirmed: "Bestätigt", unknown: "Noch keine Antwort" },
    wait: { customer: "Kunde", jarvis: "Jarvis", chris: "Chris", nothing: "Nichts" },
    st: { WAITING_FOR_PAYMENT: "Wartet auf Zahlung", READY_FOR_ONBOARDING: "Bereit", WAITING_FOR_ACCESS: "Wartet auf Zugang", WAITING_FOR_CUSTOMER_INFO: "Wartet auf Kundenangaben",
      WAITING_FOR_CLARIFICATION: "Rückfrage offen", WAITING_FOR_CONFIRMATION: "Wartet auf Bestätigung", WAITING_FOR_HOSTING_INFO: "Wartet auf Hosting-Angabe", ONBOARDING_COMPLETE: "Bereit zur Ausführung", WAITING_CUSTOMER_MANUAL_REVIEW: "Kunde antwortet nicht – Chris",
      MANUAL_REVIEW_REQUIRED: "Manuelle Prüfung", CUSTOMER_STOP_REQUESTED: "Kunde wünscht keine Nachrichten", CANCELLATION_REVIEW_REQUIRED: "Storno-Wunsch – Chris prüft",
      ONBOARDING_AI_PAUSED: "KI pausiert", COMPLETED: "Abgeschlossen" },
    f: { "": "Alle", open: "Onboarding offen", waiting_customer: "Wartet auf Kunde", waiting_access: "Wartet auf Zugang", waiting_confirmation: "Wartet auf Bestätigung", manual_review: "Manuelle Prüfung", ready: "Bereit zur Ausführung" },
    kind: { phone: "Telefon", email: "E-Mail", address: "Adresse", opening_hours: "Öffnungszeiten", text_replacement: "Text", spelling_correction: "Schreibweise", removal: "Entfernen", addition: "Ergänzen", other: "Sonstiges" },
    confirmed: "bestätigt", pending: "noch nicht bestätigt", incomplete: "Angabe fehlt", kinds: { CHECK: "Check", FIX: "Check & Reparatur" },
    secretNote: "Zugangsdaten werden nie angezeigt – nur über den sicheren Link, verschlüsselt im Tresor.",
    // TF-071
    hosting: "Hosting", cms: "CMS", accessType: "Zugangsart", confidence: "Erkennung", accessStatus: "Zugangsstatus", src: { automatic: "automatisch", customer: "Kundenangabe" },
    conf: { HIGH: "sicher", MEDIUM: "wahrscheinlich", LOW: "unsicher", UNKNOWN: "unbekannt" },
    kindName: { WORDPRESS_ADMIN: "Temporärer WordPress-Admin", CMS_ADMIN: "Temporärer CMS-Admin", CPANEL: "cPanel", PLESK: "Plesk", SFTP: "SFTP (temporärer Benutzer)", SHOPIFY_STAFF: "Shopify-Mitarbeiter",
      WIX_COLLABORATOR: "Wix-Mitarbeiter", WEBFLOW_COLLABORATOR: "Webflow-Collaborator", SQUARESPACE_CONTRIBUTOR: "Squarespace-Mitwirkender", NETLIFY_TEAM: "Netlify-Team", VERCEL_TEAM: "Vercel-Team", GITHUB_COLLABORATOR: "GitHub-Collaborator" },
    flow: { DETECTING_PLATFORM: "Plattform wird erkannt", HOSTING_UNKNOWN: "Hosting unbekannt", WAITING_FOR_HOSTING_INFO: "Wartet auf Hosting-Angabe", WAITING_FOR_SECURE_ACCESS: "Wartet auf sicheren Zugang",
      ACCESS_RECEIVED: "Zugang erhalten", ACCESS_VALIDATED: "Zugang geprüft", ACCESS_VALIDATION_FAILED: "Zugang ungültig – neuer Link", READY_FOR_REPAIR: "Bereit für Reparatur" },
  },
  "vi-VN": {
    h: "Tiếp nhận khách hàng", panel: "TIẾP NHẬN KHÁCH HÀNG", close: "ĐÓNG", refresh: "LÀM MỚI", none: "Chưa có quy trình tiếp nhận cho khách hàng này.", noneAll: "Không có đơn hàng đang tiếp nhận.",
    unreachable: "Không tải được trạng thái tiếp nhận.", order: "Đơn hàng", payment: "Mức thanh toán", access: "Quyền truy cập", content: "Thay đổi nội dung", waiting: "Đang chờ",
    lastCustomer: "Phản hồi gần nhất của khách", lastJarvis: "Phản hồi gần nhất của hệ thống", open: "Mục còn thiếu", state: "Trạng thái", reason: "Ghi chú", changes: "Thông tin website đã xác nhận hoặc đã báo",
    pay: { met: "Đã đạt", open: "Chưa đạt" },
    acc: { not_required: "Không cần (kiểm tra)", hosting_missing: "Đang xác định nền tảng", missing: "Chưa có", link_sent: "Đã gửi đường liên kết", link_expired: "Đường liên kết hết hạn", received: "Đã nhận", checked: "Đã kiểm tra" },
    cnt: { none: "Không có", open: "Đang mở", confirmed: "Đã xác nhận", unknown: "Chưa có phản hồi" },
    wait: { customer: "Khách hàng", jarvis: "Hệ thống", chris: "Chris", nothing: "Không" },
    st: { WAITING_FOR_PAYMENT: "Chờ thanh toán", READY_FOR_ONBOARDING: "Sẵn sàng", WAITING_FOR_ACCESS: "Chờ quyền truy cập", WAITING_FOR_CUSTOMER_INFO: "Chờ thông tin từ khách hàng",
      WAITING_FOR_CLARIFICATION: "Đang chờ làm rõ", WAITING_FOR_CONFIRMATION: "Chờ khách xác nhận", WAITING_FOR_HOSTING_INFO: "Chờ thông tin hosting", ONBOARDING_COMPLETE: "Sẵn sàng thực hiện", WAITING_CUSTOMER_MANUAL_REVIEW: "Khách chưa phản hồi – cần kiểm tra",
      MANUAL_REVIEW_REQUIRED: "Cần kiểm tra thủ công", CUSTOMER_STOP_REQUESTED: "Khách không muốn nhận thêm tin nhắn", CANCELLATION_REVIEW_REQUIRED: "Khách muốn hủy – cần kiểm tra",
      ONBOARDING_AI_PAUSED: "Tạm dừng xử lý tự động", COMPLETED: "Hoàn thành" },
    f: { "": "Tất cả", open: "Đang tiếp nhận", waiting_customer: "Chờ khách hàng", waiting_access: "Chờ quyền truy cập", waiting_confirmation: "Chờ xác nhận", manual_review: "Cần kiểm tra thủ công", ready: "Sẵn sàng thực hiện" },
    kind: { phone: "Số điện thoại", email: "Email", address: "Địa chỉ", opening_hours: "Giờ mở cửa", text_replacement: "Nội dung", spelling_correction: "Chính tả", removal: "Xóa", addition: "Bổ sung", other: "Khác" },
    confirmed: "đã xác nhận", pending: "chưa xác nhận", incomplete: "còn thiếu thông tin", kinds: { CHECK: "Kiểm tra & hướng dẫn", FIX: "Kiểm tra & sửa lỗi" },
    secretNote: "Thông tin đăng nhập không bao giờ được hiển thị – chỉ qua đường liên kết bảo mật, được mã hóa.",
    hosting: "Hosting", cms: "CMS", accessType: "Cách truy cập", confidence: "Mức chắc chắn", accessStatus: "Trạng thái truy cập", src: { automatic: "tự động", customer: "khách cung cấp" },
    conf: { HIGH: "chắc chắn", MEDIUM: "có khả năng", LOW: "không chắc", UNKNOWN: "chưa rõ" },
    kindName: { WORDPRESS_ADMIN: "Quản trị WordPress tạm thời", CMS_ADMIN: "Quản trị CMS tạm thời", CPANEL: "cPanel", PLESK: "Plesk", SFTP: "SFTP (tài khoản tạm thời)", SHOPIFY_STAFF: "Nhân viên Shopify",
      WIX_COLLABORATOR: "Cộng tác viên Wix", WEBFLOW_COLLABORATOR: "Cộng tác viên Webflow", SQUARESPACE_CONTRIBUTOR: "Cộng tác viên Squarespace", NETLIFY_TEAM: "Team Netlify", VERCEL_TEAM: "Team Vercel", GITHUB_COLLABORATOR: "Cộng tác viên GitHub" },
    flow: { DETECTING_PLATFORM: "Đang xác định nền tảng", HOSTING_UNKNOWN: "Chưa rõ hosting", WAITING_FOR_HOSTING_INFO: "Chờ thông tin hosting", WAITING_FOR_SECURE_ACCESS: "Chờ quyền truy cập an toàn",
      ACCESS_RECEIVED: "Đã nhận quyền truy cập", ACCESS_VALIDATED: "Đã kiểm tra quyền truy cập", ACCESS_VALIDATION_FAILED: "Quyền truy cập không hợp lệ – đã gửi liên kết mới", READY_FOR_REPAIR: "Sẵn sàng sửa lỗi" },
  },
};
export const onboardingTexts = (locale) => T[locale] || T["de-CH"];

function el(tag, attrs = {}, ...kids) {
  const x = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") x.className = v; else if (k === "text") x.textContent = v; else if (k.startsWith("on")) x.addEventListener(k.slice(2), v); else x.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) x.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return x;
}
const fmt = (v, locale) => { if (!v) return "–"; const d = new Date(v); return Number.isNaN(+d) ? "–" : d.toLocaleString(locale, { timeZone: locale === "vi-VN" ? "Asia/Ho_Chi_Minh" : "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
// TF-071: Anzeigenamen der festen Plattform-Wörter (nur Anzeige; unbekannte Wörter erscheinen unverändert).
const PNAME = { WORDPRESS: "WordPress", WOOCOMMERCE: "WooCommerce", SHOPIFY: "Shopify", WIX: "Wix", SQUARESPACE: "Squarespace", WEBFLOW: "Webflow", JOOMLA: "Joomla", TYPO3: "TYPO3", DRUPAL: "Drupal",
  STATIC: "HTML", NETLIFY: "Netlify", VERCEL: "Vercel", GITHUB_PAGES: "GitHub Pages", CLOUDFLARE_PAGES: "Cloudflare Pages", CPANEL: "cPanel", PLESK: "Plesk", HOSTPOINT: "Hostpoint",
  INFOMANIAK: "Infomaniak", CYON: "cyon", METANET: "METANET", GREEN_CH: "green.ch", PA_VIETNAM: "PA Vietnam", MATBAO: "Mắt Bão", NHAN_HOA: "Nhân Hòa", CLOUDFLARE: "Cloudflare" };
const pname = (w) => (w ? PNAME[w] || String(w).replace(/_/g, " ") : null);
export function platformRows(p, L) {
  if (!p) return [];
  return [[L.hosting, pname(p.hosting_provider) || "–"], [L.cms, pname(p.cms_platform) || pname(p.deployment_platform) || "–"], [L.accessType, L.kindName[p.access_type] || "–"],
    [L.confidence, `${L.conf[p.confidence] || "–"}${p.detection_source ? ` (${L.src[p.detection_source] || p.detection_source})` : ""}`], [L.accessStatus, L.flow[p.access_flow] || "–"]];
}
const kv = (rows) => el("div", { class: "kv" }, rows.flatMap(([k, v]) => [el("span", {}, k), el("b", {}, v ?? "–")]));

function changeLines(o, L) {
  const out = [];
  for (const list of Object.values(o.changes || {})) for (const i of list || []) {
    const addr = i.address ? [i.address.street, [i.address.postal_code, i.address.city].filter(Boolean).join(" "), i.address.country].filter(Boolean).join(", ") : "";
    const val = i.kind === "address" ? addr : i.kind === "removal" ? `«${i.old_text || "?"}»` : i.old_text ? `«${i.old_text}» → «${i.new_text || "?"}»` : i.new_text || "";
    const flag = !i.complete ? L.incomplete : i.customer_confirmed ? L.confirmed : L.pending;
    out.push(el("li", {}, el("b", {}, `${L.kind[i.kind] || i.kind}${i.page ? ` · ${i.page}` : ""}: `), val || "–", el("small", {}, flag)));
  }
  return out;
}
export function onboardingCard(x, locale) {
  const L = onboardingTexts(locale), o = x.onboarding || {};
  const lines = changeLines(o, L);
  return el("div", { class: "crm-lcard crm-onb", "data-order": x.order_id },
    kv([[L.order, `${x.order_id} · ${L.kinds[o.kind] || o.kind || ""}`], [L.state, L.st[o.state] || o.state || "–"], [L.payment, L.pay[o.payment_gate] || "–"], [L.access, L.acc[o.access] || "–"],
      [L.content, L.cnt[o.content] || "–"], [L.waiting, L.wait[o.awaiting] || "–"], [L.lastCustomer, fmt(o.last_customer_reply_at, locale)], [L.lastJarvis, fmt(o.last_jarvis_reply_at, locale)],
      [L.open, String(o.open_items ?? 0)], ...platformRows(o.platform, L), ...(o.manual_reason ? [[L.reason, o.manual_reason]] : [])]),
    lines.length ? [el("small", {}, L.changes), el("ul", { class: "crm-hist" }, lines)] : "");
}
async function fetchOnboarding(params) {
  try {
    const r = await fetch(`/api/sales?view=onboarding${params ? `&${params}` : ""}`, { cache: "no-store", credentials: "same-origin" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// Lead-Detail: Onboarding der Aufträge dieses Leads (Server prüft Bereich + Markt).
export function leadOnboardingBox(lead, locale) {
  const L = onboardingTexts(locale);
  const box = el("div", { class: "crm-form crm-onboarding" }, el("p", { class: "crm-note" }, "…"));
  fetchOnboarding(`lead_id=${encodeURIComponent(lead.lead_id)}`).then((j) => {
    if (!j) { box.replaceChildren(el("p", { class: "crm-note" }, L.unreachable)); return; }
    box.replaceChildren(...(j.orders?.length ? j.orders.map((x) => onboardingCard(x, locale)) : [el("p", { class: "crm-note" }, L.none)]), el("small", {}, L.secretNote));
  });
  return box;
}
// Übersicht mit Filtern (Owner-HUD im CRM; Verkäufer sehen dieselbe Ansicht nur für ihren Bereich).
export function onboardingPanel(locale, { onClose = () => {} } = {}) {
  const L = onboardingTexts(locale);
  let filter = "";
  const list = el("div", { class: "crm-onb-list" });
  const bar = el("div", { class: "crm-cards", role: "group", "aria-label": L.panel });
  const load = async () => {
    const j = await fetchOnboarding(filter ? `filter=${filter}` : "");
    if (!j) { list.replaceChildren(el("p", { class: "crm-note" }, L.unreachable)); return; }
    bar.replaceChildren(...Object.keys(L.f).map((k) => el("button", { type: "button", class: "crm-card", "aria-pressed": String(filter === k), "data-filter": k,
      onclick: () => { filter = k; load(); } }, el("b", {}, String(k ? j.counts?.[k] ?? 0 : j.total ?? 0)), el("span", {}, L.f[k]))));
    list.replaceChildren(...(j.orders?.length ? j.orders.map((x) => el("div", {}, el("h4", {}, `${x.company || x.domain || x.order_id}`), onboardingCard(x, locale))) : [el("p", { class: "crm-note" }, L.noneAll)]));
  };
  const root = el("section", { class: "crm-onb-panel", id: "crmOnboarding" },
    el("div", { class: "crm-top" }, el("h3", {}, L.panel), el("button", { type: "button", class: "crm-btn", onclick: load }, L.refresh), el("button", { type: "button", class: "crm-btn", onclick: onClose }, L.close)),
    bar, list, el("small", {}, L.secretNote));
  load();
  return root;
}
