// TF-065 Calling Agent – Oberfläche für Chris (Owner-HUD «CALLING AGENT», Deutsch) und Kudoshin (Verkäufer-App «TRỢ LÝ GỌI ĐIỆN», komplett Vietnamesisch).
// Nur Anzeige + Aufrufe von /api/calling. Der Browser sendet nie Telefonnummer, Caller-ID, Trunk, Room oder Agent-Namen – nur lead_id,
// Markt, Modus und Parallelität. Jede Grenze (Rolle, Scope, Berechtigung, DNC, Zeitfenster, Limits) prüft der Server.
const T = {
  "de-CH": {
    title: "CALLING AGENT", sub: "LiveKit Outbound – nur Chris und Kudoshin · keine Aufnahme", refresh: "AKTUALISIEREN", close: "SCHLIESSEN",
    livekit: "LiveKit", sip_ch: "SIP CH", sip_vn: "SIP VN", dry: "Testmodus (Dry Run)", rec: "Aufnahme", yes: "JA", no: "NEIN", off: "AUS",
    st: { ONLINE: "ONLINE", NOT_CONFIGURED: "NOT CONFIGURED", OFFLINE: "OFFLINE", READY: "READY", NOT_VERIFIED: "NICHT VERIFIZIERT", CONFIGURED: "KONFIGURIERT", DISABLED: "DEAKTIVIERT" },
    s: { active: "Aktive Gespräche", queued: "Warteschlange", called: "Heute angerufen", reached: "Erreicht", no_answer: "Keine Antwort", interested: "Interessiert", callbacks: "Callbacks", dnc: "DNC", errors: "Fehler" },
    market: "Markt", mk: { CH: "Schweiz", VN: "Vietnam" }, mode: "Modus", md: { SINGLE: "EINZELN", SEQUENTIAL: "SEQUENZ", PARALLEL: "PARALLEL" }, conc: "Parallelität", prio: "Priorität", all: "alle",
    preview: "VORSCHAU", start: "STARTEN", notConfigured: "LiveKit/SIP noch nicht eingerichtet",
    pv: { leads_in_filter: "Leads im Filter", phone_present: "Telefon vorhanden", CALL_ALLOWED: "CALL_ALLOWED", BLOCKED_CONSENT: "BLOCKED_CONSENT", BLOCKED_DNC: "BLOCKED_DNC",
      BLOCKED_TIME_WINDOW: "BLOCKED_TIME_WINDOW", BLOCKED_FREQUENCY: "BLOCKED_FREQUENCY (24 h)", BLOCKED_LEGAL: "BLOCKED_PENDING_LEGAL_REVIEW", BLOCKED_OTHER: "BLOCKED_OTHER", planned_max_calls: "Geplante maximale Calls" },
    onlyAllowed: "Nur CALL_ALLOWED wird wirklich gewählt. Kein «force» – auch nicht für den Owner.",
    confirm: (x, n) => `Calling Agent starten?\nEs werden ${x} zulässige Leads angerufen.\nParallelität: ${n}.`,
    singleHint: "EINZELN: im CRM beim Lead «AGENT ANRUFEN» wählen.",
    limits: "Limits (nur Owner)", cap: "Tageslimit echte Calls", size: "Max. Kampagnengrösse", save: "SPEICHERN", today: (a, b) => `Heute ${a} / ${b} echte Calls`,
    camps: "Kampagnen", pause: "PAUSE", resume: "FORTSETZEN", stop: "STOPP", endActive: "AKTIVE ANRUFE BEENDEN", endOne: "BEENDEN",
    endActive_q: "Aktive Gespräche dieser Kampagne jetzt beenden?", stop_q: "Kampagne stoppen? Laufende Gespräche werden normal fertig geführt.",
    activeCalls: "Aktive Gespräche", recent: "Letzte Gespräche", none: "–", dryTag: "SIMULATION", review: "PRÜFEN",
    cs: { RUNNING: "LÄUFT", PAUSED: "PAUSIERT", STOPPED: "GESTOPPT", FINISHED: "FERTIG" },
    lead: { h: "Calling Agent", last: "Letzter Anruf", status: "Status", result: "Ergebnis", dur: "Dauer", next: "Nächster Rückruf", attempts: "Anzahl Versuche", sum: "Kurze Zusammenfassung",
      elig: "Anruf-Berechtigung", call: "AGENT ANRUFEN", call_q: (c) => `Calling Agent starten?\nEs wird 1 zulässiger Lead angerufen (${c}).\nParallelität: 1.`, noRec: "Keine Audioaufnahme." },
    err: (s, b) => b?.error || `Fehler ${s}`, ok: "Gespeichert.", queued: (n) => `Gestartet – ${n} Lead(s) eingeplant.`, forbidden: "Kein Zugang.",
    monitorOnly: "Owner: nur Überwachung, Konfiguration, Statistik, Audit und Notstopp – Kampagnen startet ausschliesslich Kudoshin. Nur Vietnam (CH-Calling deaktiviert).",
    legal: "Rechtsprüfung VN", voice: "VN-Männerstimme", callerId: "Caller-ID VN", costs: "Kosten heute", noCost: "keine Provider-Daten",
    lg: { APPROVED: "FREIGEGEBEN", BLOCKED_PENDING_LEGAL_REVIEW: "BLOCKED_PENDING_LEGAL_REVIEW" }, vc: { VOICE_VERIFIED: "VERIFIZIERT", VOICE_NOT_VERIFIED: "VOICE_NOT_VERIFIED" },
    halt: "NOTSTOPP", release: "NOTSTOPP AUFHEBEN", halted: "NOTSTOPP AKTIV – keine neuen Anrufe.", halt_q: "Notstopp auslösen? Alle Kampagnen werden gestoppt und aktive Gespräche beendet.",
    reason: "Begründung (Pflicht, wird auditiert):", audit: "Audit", callbacks: "Rückrufe",
  },
  "vi-VN": {
    title: "TRỢ LÝ GỌI ĐIỆN", sub: "Cuộc gọi tự động qua LiveKit · không ghi âm", refresh: "LÀM MỚI", close: "ĐÓNG",
    livekit: "LiveKit", sip_ch: "SIP CH", sip_vn: "SIP VN", dry: "Chế độ thử (Dry Run)", rec: "Ghi âm", yes: "CÓ", no: "KHÔNG", off: "TẮT",
    st: { ONLINE: "TRỰC TUYẾN", NOT_CONFIGURED: "CHƯA CẤU HÌNH", OFFLINE: "NGOẠI TUYẾN", READY: "SẴN SÀNG", NOT_VERIFIED: "CHƯA XÁC MINH", CONFIGURED: "ĐÃ CẤU HÌNH", DISABLED: "ĐÃ TẮT" },
    s: { active: "Cuộc gọi đang hoạt động", queued: "Hàng đợi", called: "Đã gọi hôm nay", reached: "Đã kết nối", no_answer: "Không trả lời", interested: "Quan tâm", callbacks: "Gọi lại", dnc: "Không gọi lại", errors: "Lỗi" },
    market: "Thị trường", mk: { CH: "Thụy Sĩ", VN: "Việt Nam" }, mode: "Chế độ", md: { SINGLE: "Gọi một số", SEQUENTIAL: "Gọi lần lượt", PARALLEL: "Gọi song song" }, conc: "Số cuộc gọi đồng thời", prio: "Mức ưu tiên", all: "tất cả",
    preview: "XEM TRƯỚC", start: "BẮT ĐẦU", notConfigured: "LiveKit/SIP chưa được cấu hình",
    pv: { leads_in_filter: "Khách hàng trong bộ lọc", phone_present: "Có số điện thoại", CALL_ALLOWED: "Được phép gọi", BLOCKED_CONSENT: "Chặn – chưa có đồng ý", BLOCKED_DNC: "Chặn – không gọi lại",
      BLOCKED_TIME_WINDOW: "Chờ khung giờ (08:00–17:00)", BLOCKED_FREQUENCY: "Chờ 24 giờ (tối đa 1 cuộc/ngày)", BLOCKED_LEGAL: "Chờ kiểm tra pháp lý", BLOCKED_OTHER: "Chặn – lý do khác", planned_max_calls: "Số cuộc gọi tối đa dự kiến" },
    onlyAllowed: "Chỉ những khách hàng được phép mới được gọi. Không có chế độ bỏ qua quy định.",
    confirm: (x, n) => `Khởi động trợ lý gọi điện?\n${x} khách hàng đủ điều kiện sẽ được gọi.\nSố cuộc gọi đồng thời: ${n}.`,
    singleHint: "Gọi một số: mở khách hàng trong CRM và chọn «GỌI BẰNG TRỢ LÝ».",
    limits: "Giới hạn", cap: "Giới hạn mỗi ngày", size: "Quy mô tối đa", save: "LƯU", today: (a, b) => `Hôm nay ${a} / ${b} cuộc gọi thật`,
    camps: "Chiến dịch", pause: "TẠM DỪNG", resume: "TIẾP TỤC", stop: "DỪNG", endActive: "KẾT THÚC CÁC CUỘC GỌI ĐANG DIỄN RA", endOne: "KẾT THÚC",
    endActive_q: "Kết thúc ngay các cuộc gọi đang diễn ra của chiến dịch này?", stop_q: "Dừng chiến dịch? Các cuộc gọi đang diễn ra sẽ kết thúc bình thường.",
    activeCalls: "Cuộc gọi đang hoạt động", recent: "Cuộc gọi gần đây", none: "–", dryTag: "MÔ PHỎNG", review: "CẦN KIỂM TRA",
    cs: { RUNNING: "ĐANG CHẠY", PAUSED: "TẠM DỪNG", STOPPED: "ĐÃ DỪNG", FINISHED: "HOÀN TẤT" },
    lead: { h: "Trợ lý gọi điện", last: "Cuộc gọi gần nhất", status: "Trạng thái", result: "Kết quả", dur: "Thời lượng", next: "Lần gọi lại tiếp theo", attempts: "Số lần gọi", sum: "Tóm tắt ngắn",
      elig: "Quyền gọi", call: "GỌI BẰNG TRỢ LÝ", call_q: (c) => `Khởi động trợ lý gọi điện?\n1 khách hàng đủ điều kiện sẽ được gọi (${c}).\nSố cuộc gọi đồng thời: 1.`, noRec: "Không ghi âm." },
    err: (s, b) => (s === 409 && /LiveKit/.test(b?.error || "") ? "LiveKit/SIP chưa được cấu hình" : s === 403 ? "Không có quyền." : s === 409 ? "Không thể thực hiện lúc này." : `Lỗi ${s}`),
    ok: "Đã lưu.", queued: (n) => `Đã bắt đầu – ${n} khách hàng trong hàng đợi.`, forbidden: "Không có quyền truy cập.",
    monitorOnly: "", legal: "Kiểm tra pháp lý", voice: "Giọng nam tiếng Việt", callerId: "Số gọi đi", costs: "Chi phí hôm nay", noCost: "chưa có dữ liệu",
    lg: { APPROVED: "ĐÃ DUYỆT", BLOCKED_PENDING_LEGAL_REVIEW: "ĐANG CHỜ KIỂM TRA PHÁP LÝ – chưa được gọi" }, vc: { VOICE_VERIFIED: "ĐÃ XÁC MINH", VOICE_NOT_VERIFIED: "CHƯA XÁC MINH" },
    halt: "", release: "", halted: "DỪNG KHẨN CẤP – không có cuộc gọi mới.", halt_q: "", reason: "", audit: "", callbacks: "Lịch gọi lại",
  },
};
const OUT = {
  "de-CH": { QUEUED: "Wartet", DIALING: "Wählt", RINGING: "Klingelt", ANSWERED: "Verbunden", COMPLETED: "Beendet", NO_ANSWER: "Keine Antwort", BUSY: "Besetzt", VOICEMAIL: "Combox",
    INTERESTED: "Interessiert", CALLBACK_REQUESTED: "Rückruf erbeten", NOT_INTERESTED: "Kein Interesse", DO_NOT_CALL: "Nicht mehr anrufen", TRANSFERRED: "Übergeben", FAILED: "Fehler", CANCELLED: "Abgebrochen" },
  "vi-VN": { QUEUED: "Đang chờ", DIALING: "Đang quay số", RINGING: "Đang đổ chuông", ANSWERED: "Đã kết nối", COMPLETED: "Đã kết thúc", NO_ANSWER: "Không trả lời", BUSY: "Máy bận", VOICEMAIL: "Hộp thư thoại",
    INTERESTED: "Quan tâm", CALLBACK_REQUESTED: "Hẹn gọi lại", NOT_INTERESTED: "Không quan tâm", DO_NOT_CALL: "Không gọi lại", TRANSFERRED: "Đã chuyển máy", FAILED: "Lỗi", CANCELLED: "Đã hủy" },
};
const ELIG = {
  "de-CH": { ALLOWED: "zulässig", BLOCKED: "gesperrt", WAITING: "wartet auf Zeitfenster", REVIEW: "Prüfung nötig (kein autonomer Anruf)" },
  "vi-VN": { ALLOWED: "được phép", BLOCKED: "bị chặn", WAITING: "chờ khung giờ", REVIEW: "cần kiểm tra (không gọi tự động)" },
};
const FLAG = { "vi-VN": { CALL_ALLOWED: "Được phép gọi", CALL_BLOCKED: "Bị chặn", CONSENT_UNKNOWN: "Chưa có đồng ý", DO_NOT_CONTACT: "Không liên hệ" } };
export const callingTexts = (locale) => T[locale] || T["de-CH"];

function el(tag, attrs = {}, ...kids) {
  const x = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") x.className = v; else if (k.startsWith("on")) x.addEventListener(k.slice(2), v); else x.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) x.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return x;
}
const api = async (body, query = "") => {
  const r = await fetch(`/api/calling${query}`, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const fmtTime = (v, locale) => (v ? new Date(v).toLocaleString(locale === "vi-VN" ? "vi-VN" : "de-CH", { timeZone: locale === "vi-VN" ? "Asia/Ho_Chi_Minh" : "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");
const kv = (pairs) => el("div", { class: "kv" }, ...pairs.flatMap(([k, v]) => [el("span", {}, k), el("b", {}, v ?? "–")]));

// ---------- Hauptbereich ----------
export function mountCalling(box, { locale = "de-CH", onClose = null } = {}) {
  const t = callingTexts(locale), o = OUT[locale] || OUT["de-CH"];
  let data = null, preview = null, cbs = [];
  const note = el("p", { class: "crm-status", "aria-live": "polite" });
  const say = (m, bad = false) => { note.textContent = m; note.className = `crm-status ${bad ? "bad" : "ok"}`; };
  const market = el("select", { class: "crm-sort", "aria-label": t.market });
  const mode = el("select", { class: "crm-sort", "aria-label": t.mode }, ["SEQUENTIAL", "PARALLEL", "SINGLE"].map((m) => el("option", { value: m }, t.md[m])));
  const conc = el("select", { class: "crm-sort", "aria-label": t.conc });
  const prio = el("select", { class: "crm-sort", "aria-label": t.prio }, el("option", { value: "" }, `${t.prio}: ${t.all}`), ["HIGH", "MEDIUM", "LOW"].map((p) => el("option", { value: p }, p)));
  const startBtn = el("button", { type: "button", class: "crm-btn primary", disabled: true }, t.start);
  const pvBox = el("div", {});
  const resetPreview = () => { preview = null; pvBox.replaceChildren(); startBtn.disabled = true; };
  [market, mode, conc, prio].forEach((s) => s.addEventListener("change", () => { resetPreview(); conc.disabled = mode.value !== "PARALLEL"; }));

  const doPreview = async () => {
    resetPreview();
    if (mode.value === "SINGLE") { say(t.singleHint); return; }
    const r = await api({ op: "campaign.preview", market: market.value, ...(prio.value ? { priority: prio.value } : {}) });
    if (r.status !== 200) return say(t.err(r.status, r.body), true);
    preview = r.body;
    pvBox.replaceChildren(kv(Object.keys(t.pv).map((k) => [t.pv[k], String(preview[k] ?? 0)])), el("p", { class: "crm-note" }, t.onlyAllowed));
    startBtn.disabled = !(preview.can_start?.ok && preview.planned_max_calls > 0);
    if (!preview.can_start?.ok) say(t.notConfigured, true);
  };
  startBtn.addEventListener("click", async () => {
    if (!preview || mode.value === "SINGLE") return;
    const n = mode.value === "PARALLEL" ? Number(conc.value) : 1;
    if (!confirm(t.confirm(preview.planned_max_calls, n))) return;
    const r = await api({ op: "campaign.start", market: market.value, mode: mode.value, concurrency: n, confirmed: true, ...(prio.value ? { priority: prio.value } : {}) });
    if (r.status === 202) { say(t.queued(r.body.planned)); resetPreview(); load(); } else say(t.err(r.status, r.body), true);
  });
  const ctl = async (body, q) => { if (q && !confirm(q)) return; const r = await api(body); if (r.status === 200 || r.status === 202) { say(t.ok); load(); } else say(t.err(r.status, r.body), true); };
  const callRow = (c) => el("li", {}, el("time", {}, `${fmtTime(c.started_at, locale)} · ${c.company || c.lead_id} · ${c.phone} · ${o[c.outcome || c.status] || c.status}`),
    `${c.duration_s != null ? ` · ${c.duration_s}s` : ""}${c.callback_at ? ` · ${t.lead.next}: ${fmtTime(c.callback_at, locale)}` : ""}${c.dry_run ? ` · ${t.dryTag}` : ""}${c.review_required ? ` · ${t.review}` : ""}`,
    c.summary ? el("small", {}, c.summary) : "",
    LIVE.has(c.status) ? el("button", { type: "button", class: "crm-btn warn", onclick: () => ctl({ op: "call.cancel", call_id: c.call_id }) }, t.endOne) : "");

  function render() {
    const d = data, svc = d.service, s = d.stats_today, owner = d.actor.role === "OWNER", starter = d.actor.can_start_calls === true;
    if (!market.options.length) for (const m of d.actor.markets) market.append(el("option", { value: m }, t.mk[m]));
    const max = d.limits.max_concurrency || 1;
    if (conc.options.length !== max) { conc.replaceChildren(...Array.from({ length: max }, (_, i) => el("option", { value: String(i + 1), ...(i + 1 === d.limits.default_concurrency ? { selected: true } : {}) }, String(i + 1)))); }
    conc.disabled = mode.value !== "PARALLEL";
    const cap = el("input", { type: "number", min: "0", max: "500", value: String(d.limits.daily_call_cap), "aria-label": t.cap });
    const size = el("input", { type: "number", min: "1", max: "200", value: String(d.limits.max_campaign_size), "aria-label": t.size });
    const canStartAny = Object.values(d.can_start || {}).some((x) => x.ok);
    box.replaceChildren(
      el("div", { class: "crm-top" }, el("h2", { id: "caTitle" }, t.title), el("span", { class: "meta" }, t.sub),
        el("button", { type: "button", class: "crm-btn", onclick: load }, t.refresh), onClose ? el("button", { type: "button", class: "crm-btn", onclick: onClose }, t.close) : ""),
      note,
      el("div", { class: "crm-main" },
        kv([[t.livekit, t.st[svc.livekit] || svc.livekit], [t.sip_vn, t.st[svc.sip_vn] || svc.sip_vn], [t.voice, t.vc[svc.voice_vn] || svc.voice_vn], [t.callerId, t.st[svc.caller_id_vn] || svc.caller_id_vn],
          [t.legal, t.lg[d.legal?.VN] || d.legal?.VN], [t.dry, svc.dry_run ? t.yes : t.no], [t.rec, t.off]]),
        d.emergency_stop?.active ? el("p", { class: "crm-dnc-banner" }, t.halted) : "",
        owner ? el("p", { class: "crm-note" }, t.monitorOnly) : canStartAny ? "" : el("p", { class: "crm-dnc-banner" }, t.notConfigured),
        owner ? el("div", { class: "crm-qa" }, d.emergency_stop?.active
          ? el("button", { type: "button", class: "crm-btn", onclick: () => { const r = prompt(t.reason); if (r && r.trim().length >= 3) ctl({ op: "emergency.release", reason: r.trim() }); } }, t.release)
          : el("button", { type: "button", class: "crm-btn danger", onclick: () => { if (!confirm(t.halt_q)) return; const r = prompt(t.reason); if (r && r.trim().length >= 3) ctl({ op: "emergency.stop", reason: r.trim() }); } }, t.halt)) : "",
        kv([...Object.keys(t.s).map((k) => [t.s[k], String(s[k] ?? 0)]), [t.costs, typeof s.costs === "object" ? Object.entries(s.costs).map(([c, v]) => `${v} ${c}`).join(" · ") : t.noCost]]),
        el("h4", {}, t.preview),
        el("div", { class: "crm-qa" }, market, mode, conc, prio, el("button", { type: "button", class: "crm-btn", onclick: doPreview }, t.preview), starter ? startBtn : ""),
        el("p", { class: "crm-note" }, `${t.today(d.limits.calls_today, d.limits.daily_call_cap)} · ${t.size}: ${d.limits.max_campaign_size} · ${t.conc}: 1–${max}`),
        pvBox,
        owner ? el("div", {}, el("h4", {}, t.limits), el("div", { class: "crm-qa" }, el("label", {}, `${t.cap} `, cap), el("label", {}, `${t.size} `, size),
          el("button", { type: "button", class: "crm-btn", onclick: () => ctl({ op: "config.set", daily_call_cap: Number(cap.value), max_campaign_size: Number(size.value) }) }, t.save))) : "",
        el("h4", {}, t.camps),
        d.campaigns.length ? el("ul", { class: "crm-hist" }, d.campaigns.map((c) => el("li", {},
          el("time", {}, `${fmtTime(c.created_at, locale)} · ${t.mk[c.market]} · ${t.md[c.mode]} · ${t.conc} ${c.concurrency} · ${t.cs[c.status] || c.status}${c.dry_run ? ` · ${t.dryTag}` : ""}`),
          ` ${c.counts.DONE}/${c.planned} · ${t.s.active} ${c.counts.ACTIVE} · ${t.s.queued} ${c.counts.QUEUED + c.counts.RETRY_LATER + c.counts.QUEUE_WAITING_FOR_WINDOW}${c.counts.CALL_STATE_REVIEW_REQUIRED ? ` · ${t.review} ${c.counts.CALL_STATE_REVIEW_REQUIRED}` : ""}`,
          ["RUNNING", "PAUSED"].includes(c.status) ? el("div", { class: "crm-qa" },
            c.status === "RUNNING" ? el("button", { type: "button", class: "crm-btn", onclick: () => ctl({ op: "campaign.pause", campaign_id: c.campaign_id }) }, t.pause)
              : el("button", { type: "button", class: "crm-btn", onclick: () => ctl({ op: "campaign.resume", campaign_id: c.campaign_id }) }, t.resume),
            el("button", { type: "button", class: "crm-btn warn", onclick: () => ctl({ op: "campaign.stop", campaign_id: c.campaign_id }, t.stop_q) }, t.stop),
            c.counts.ACTIVE ? el("button", { type: "button", class: "crm-btn danger", onclick: () => ctl({ op: "campaign.stop", campaign_id: c.campaign_id, end_active: true }, t.endActive_q) }, t.endActive) : "") : "")))
          : el("p", { class: "crm-note" }, t.none),
        el("h4", {}, t.activeCalls), d.active_calls.length ? el("ul", { class: "crm-hist" }, d.active_calls.map(callRow)) : el("p", { class: "crm-note" }, t.none),
        el("h4", {}, t.recent), d.recent_calls.length ? el("ul", { class: "crm-hist" }, d.recent_calls.map(callRow)) : el("p", { class: "crm-note" }, t.none),
        el("h4", {}, t.callbacks), cbs.length ? el("ul", { class: "crm-hist" }, cbs.map((x) => el("li", {}, `${fmtTime(x.callback_at, locale)} · ${x.company || x.lead_id}`))) : el("p", { class: "crm-note" }, t.none),
        owner && d.audit?.length ? el("div", {}, el("h4", {}, t.audit), el("ul", { class: "crm-hist" }, d.audit.map((x) => el("li", {}, `${fmtTime(x.ts, locale)} · ${x.actor_user_id} · ${x.action} · ${x.result || ""}${x.reason ? ` · ${x.reason}` : ""}`)))) : ""));
    if (preview) startBtn.disabled = !(preview.can_start?.ok && preview.planned_max_calls > 0);
  }
  async function load() {
    const r = await api(null);
    if (r.status !== 200) { box.replaceChildren(el("p", { class: "crm-empty" }, r.status === 403 ? t.forbidden : t.err(r.status, r.body))); return; }
    data = r.body;
    const c = await api(null, "?view=callbacks");
    cbs = c.status === 200 ? c.body.callbacks : [];
    render();
  }
  load();
  return { load };
}
const LIVE = new Set(["QUEUED", "DIALING", "RINGING", "ANSWERED"]);

// ---------- Call-Sektion im Lead-Detail (CRM) – nur Chris und Kudoshin, nur Leads im eigenen Scope ----------
export function leadCallBox(lead, locale = "de-CH") {
  const t = callingTexts(locale), o = OUT[locale] || OUT["de-CH"], e = ELIG[locale] || ELIG["de-CH"];
  const box = el("div", {}, el("p", { class: "crm-note" }, "…"));
  const out = el("p", { class: "crm-status", "aria-live": "polite" });
  (async () => {
    const r = await api(null, `?lead=${encodeURIComponent(lead.lead_id)}`);
    if (r.status !== 200) { box.replaceChildren(el("p", { class: "crm-note" }, r.status === 403 ? t.forbidden : t.err(r.status, r.body))); return; }
    const d = r.body, c = d.last_call;
    const btn = el("button", { type: "button", class: "crm-btn primary", disabled: d.eligibility.decision !== "ALLOWED", onclick: async () => {
      if (!confirm(t.lead.call_q(lead.company || lead.lead_id))) return;
      const x = await api({ op: "call.start", lead_id: lead.lead_id, confirmed: true });
      out.textContent = x.status === 202 ? t.queued(x.body.planned) : t.err(x.status, x.body); out.className = `crm-status ${x.status === 202 ? "ok" : "bad"}`;
    } }, t.lead.call);
    box.replaceChildren(
      kv([[t.lead.last, c ? fmtTime(c.started_at, locale) : "–"], [t.lead.status, c ? o[c.status] || c.status : "–"], [t.lead.result, c?.outcome ? o[c.outcome] : "–"],
        [t.lead.dur, c?.duration_s != null ? `${c.duration_s}s` : "–"], [t.lead.next, fmtTime(d.next_callback, locale)], [t.lead.attempts, String(d.attempts)],
        [t.lead.sum, c?.summary || "–"], [t.lead.elig, locale === "vi-VN" ? e[d.eligibility.decision] || "–" : `${e[d.eligibility.decision] || d.eligibility.decision} (${d.eligibility.code})`], [locale === "vi-VN" ? "Phân loại gọi" : "CRM", (FLAG[locale] || {})[d.call_flag] || d.call_flag || "–"]]),
      d.can_start_calls ? el("div", { class: "crm-qa" }, btn) : "", out, el("small", {}, t.lead.noRec));
  })();
  return box;
}
