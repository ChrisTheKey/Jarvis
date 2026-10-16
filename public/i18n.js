// Jarvis i18n (TF-063) – eine Oberfläche, zwei Sprachen: de-CH (bestehende Schweizer Terminologie, unverändert) und vi-VN (Kudoshin).
// Reines ES-Modul ohne DOM: Browser (crm.js, sales-app.js, login.js) UND Netlify-Funktion (CSV-Kopfzeilen). Firmennamen, Domains,
// Telefonnummern und Kundeninhalte werden nie übersetzt; interne Codes werden nie direkt angezeigt (immer über die Label-Tabellen).
import { STAGE_LABEL, CALL_LABEL, CONTACT_LABEL, DRAFT_LABEL, FOLLOW_UP_LABEL, AUDIT_LABEL, ISSUE_LABEL, SEVERITY_LABEL, HISTORY_LABEL,
  CARDS, PIPELINE_CARDS, ERROR_CARDS, SORTS, ERR_WORDS_DE, ISSUE_WORDS_DE, CSV_COLUMNS } from "./crm-model.js";

export const LOCALES = Object.freeze(["de-CH", "vi-VN"]);
// TF-064: Anzeige von Beträgen (nur Darstellung – Preise kommen immer vom Server/pricing.js): CHF 150.00 bzw. 990.000 ₫.
export function money(amount, currency = "CHF") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "–";
  if (currency === "VND") { const v = Math.round(n); return `${v < 0 ? "-" : ""}${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")} ₫`; }
  return `${currency} ${n.toFixed(2)}`;
}
export const normLocale = (l) => (LOCALES.includes(l) ? l : "de-CH");
const labelsOf = (cards) => Object.fromEntries(Object.entries(cards).map(([k, c]) => [k, c.label]));

// ---------- Statuswörter / Karten ----------
const DE_LABELS = {
  stage: STAGE_LABEL, call: CALL_LABEL, contact: CONTACT_LABEL, draft: DRAFT_LABEL, followUp: FOLLOW_UP_LABEL, audit: AUDIT_LABEL, issue: ISSUE_LABEL,
  severity: SEVERITY_LABEL, history: HISTORY_LABEL, cards: labelsOf(CARDS), pipeline: labelsOf(PIPELINE_CARDS), errorCards: labelsOf(ERROR_CARDS), sorts: labelsOf(SORTS),
  level: { HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" }, category: {}, reasons: {},
};
const VI_LABELS = {
  stage: { NEW: "Mới", DRAFT_READY: "Bản nháp sẵn sàng", TO_CONTACT: "Cần liên hệ", CONTACTED: "Đã liên hệ", INTERESTED: "Quan tâm", FOLLOW_UP: "Theo dõi tiếp",
    CHECK_150_INTEREST: "Quan tâm gói kiểm tra", REPAIR_480_INTEREST: "Quan tâm gói sửa lỗi", CUSTOMER: "Khách hàng", NOT_INTERESTED: "Không quan tâm",
    DO_NOT_CONTACT: "Không liên hệ", CLOSED: "Đã đóng" },
  call: { NOT_CALLED: "Chưa gọi", NO_ANSWER: "Không nghe máy", CALLBACK_REQUESTED: "Hẹn gọi lại", SPOKE_TO_EMPLOYEE: "Đã nói chuyện với nhân viên",
    SPOKE_TO_DECISION_MAKER: "Đã nói chuyện với người quyết định", INTERESTED: "Quan tâm", NOT_INTERESTED: "Không quan tâm", WRONG_NUMBER: "Sai số", DO_NOT_CALL: "Không gọi" },
  contact: { NOT_CONTACTED: "Chưa liên hệ", EMAIL_SENT: "Đã gửi email (thủ công)", CALLED: "Đã gọi", REACHED: "Đã liên lạc được", REPLIED: "Đã nhận phản hồi",
    MEETING: "Đã hẹn gặp", NO_RESPONSE: "Không phản hồi" },
  draft: { QUEUED: "Đang chờ bản nháp", DRAFT: "Bản nháp", MANUALLY_SENT: "Đã gửi thủ công", NO_LONGER_DRAFT: "Không còn bản nháp", SKIPPED: "Đã bỏ qua" },
  followUp: { OVERDUE: "Quá hạn", TODAY: "Đến hạn hôm nay", LATER: "Sau này" },
  audit: { FULL: "Đầy đủ", STALE: "Đã cũ", PARTIAL: "Kiểm tra một phần", NONE: "Chưa kiểm tra" },
  issue: { contact: "Liên hệ", navigation: "Điều hướng", http: "Lỗi trang (404/5xx)", images: "Hình ảnh", mobile: "Điện thoại di động", other: "Khác" },
  severity: { critical: "nghiêm trọng", high: "cao", medium: "trung bình", low: "thấp" },
  history: { HISTORICAL: "PHÁT HIỆN CŨ", REVERIFIED: "ĐÃ XÁC MINH LẠI" },
  cards: { all: "Tất cả", new: "Mới", to_contact: "Cần liên hệ", contacted: "Đã liên hệ", interested: "Quan tâm", follow_ups: "Cần theo dõi", customers: "Khách hàng",
    dnc: "Không liên hệ", with_phone: "Có số điện thoại", with_person: "Có người liên hệ", with_draft: "Có bản nháp", with_findings: "Có ít nhất 1 lỗi website", history: "Phát hiện cũ" },
  pipeline: { pipe_waiting: "Đang chờ bản nháp", pipe_no_draft: "Chưa có bản nháp", pipe_draft: "Bản nháp sẵn sàng", pipe_contacted: "Đã liên hệ", pipe_customer: "Khách hàng" },
  errorCards: { err_0: "0 lỗi đã xác minh", err_1_2: "1–2 lỗi", err_3_5: "3–5 lỗi", err_6: "6+ lỗi", audit_full: "Đã kiểm tra đầy đủ", audit_partial: "Chỉ kiểm tra một phần" },
  sorts: { priority: "Mức ưu tiên", company: "Công ty", problems: "Số lỗi", stage: "Trạng thái", last_contact: "Lần liên hệ gần nhất", follow_up: "Lần theo dõi tiếp theo", updated: "Cập nhật gần nhất" },
  level: { HIGH: "CAO", MEDIUM: "TRUNG BÌNH", LOW: "THẤP" },
  // Branchen: deutsche Anzeige-Bezeichnung (category-labels.js) → Vietnamesisch. Unbekannt → Rohwert (nie geraten).
  category: { Handwerk: "Thủ công / Thợ", "Geschäft": "Cửa hàng", "Firma / Büro": "Công ty / Văn phòng", Immobilien: "Bất động sản", Restaurant: "Nhà hàng", Zahnarzt: "Nha khoa",
    Physiotherapie: "Vật lý trị liệu", Hotel: "Khách sạn", Treuhand: "Kế toán", Coiffeur: "Tiệm cắt tóc", Anwalt: "Luật sư", Architekt: "Kiến trúc sư", Versicherung: "Bảo hiểm",
    Steuerberatung: "Tư vấn thuế", IT: "Công nghệ thông tin", Beratung: "Tư vấn", "Café": "Quán cà phê", Arztpraxis: "Phòng khám", Tierarzt: "Thú y", Fitness: "Phòng tập thể hình",
    "Gästehaus": "Nhà nghỉ", Autogarage: "Gara ô tô", Kosmetik: "Thẩm mỹ", Arzt: "Bác sĩ" },
  // Priorisierungspunkte (crm-model priorityOf, Text nach der Punktzahl).
  reasons: { "Kontakt-/Reservations-/Bestellproblem": "Lỗi liên hệ/đặt chỗ/đặt hàng", "weitere wichtige kaputte Seite": "Thêm trang quan trọng bị lỗi",
    "Telefon vorhanden": "Có số điện thoại", "Ansprechpartner vorhanden": "Có người liên hệ", "2+ Befunde": "Từ 2 lỗi trở lên", "Do Not Contact": "Không liên hệ", "kein Interesse": "Không quan tâm" },
};
export const ERR_WORDS_VI = Object.freeze({ staleFull: (n) => `${n} (đã cũ)`, staleMin: (n) => `≥${n} · đã cũ`, partialZero: "0 (kiểm tra một phần)",
  notChecked: "Chưa kiểm tra", fullN: (n) => `${n} lỗi (đã xác minh)`, noneVerified: "Không có lỗi nào được xác minh hiện tại",
  staleFullLong: (n) => `Lần kiểm tra đầy đủ gần nhất đã cũ – khi đó có ${n} lỗi`, staleMinLong: (n) => `Lần kiểm tra một phần gần nhất đã cũ – khi đó có ít nhất ${n} lỗi`,
  minN: (n) => `Ít nhất ${n} lỗi đã xác minh`, noneVerifiedPartial: "Không có lỗi nào được xác minh (chỉ kiểm tra một phần)",
  repairManual: (r, m) => `Đã tự động sửa (${r}) + còn ${m} mục cần xử lý thủ công`, repairDone: (r) => `Đã tự động sửa (${r}) – không còn mục cần sửa theo kế hoạch` });
export const ISSUE_WORDS_VI = Object.freeze({ home: "Trang chủ", unknownPage: "Trang không xác định", linkTo: (t) => `Liên kết tới ${t}`, contactLink: "Liên kết tới trang liên hệ",
  link: "Liên kết", http: (s) => `HTTP ${s}`, unreachable: "Không truy cập được trang đích", image: (f) => (f ? `Hình «${f}»` : "Hình ảnh"),
  imgFail: (s) => (s ? `không tải được / HTTP ${s}` : "không tải được"), mailLink: "Liên kết email", mailBad: "địa chỉ email trong liên kết không hợp lệ",
  form: (l) => (l ? `Biểu mẫu liên hệ · «${l}»` : "Biểu mẫu liên hệ"), formFail: "Gửi biểu mẫu thất bại (lặp lại được)", button: (l) => (l ? `Nút «${l}»` : "Nút"),
  buttonFail: "không hoạt động", mobile: (s) => `Di động / ${s}`, areaUnknown: "Khu vực không xác định", overlap: "chữ bị chồng lên nội dung", cut: "bị cắt",
  atPx: (v) => ` ở ${v} px`, pageRender: "Hiển thị trang", desktopWidth: "Hiển thị khổ máy tính, bị thu nhỏ", shifted: "hiển thị bị lệch", siteCall: "Truy cập website",
  loop: "Vòng lặp chuyển hướng – không tải được", cert: "Trình duyệt hiện cảnh báo chứng chỉ", error: "Lỗi" });
// Kurztexte je Befund-Typ (VN-Leads tragen den Typ; der Text wird je Sprache angezeigt).
export const ISSUE_TYPE_TEXT = Object.freeze({
  "de-CH": { broken_link: "Ein Link führt auf eine Fehlerseite", contact_page_broken: "Der Link zur Kontaktseite führt auf eine Fehlerseite", broken_image: "Ein Bild wird nicht angezeigt",
    broken_mailto: "Ein E-Mail-Link funktioniert nicht", https_certificate: "Der Browser zeigt beim Öffnen eine Warnmeldung", redirect_loop: "Die Website lädt beim Aufruf nicht",
    no_mobile_viewport: "Auf dem Handy wird die Seite verkleinert angezeigt", http_error: "Die Startseite antwortet mit einem Fehler" },
  "vi-VN": { broken_link: "Một liên kết dẫn tới trang lỗi", contact_page_broken: "Liên kết tới trang liên hệ dẫn tới trang lỗi", broken_image: "Một hình ảnh không hiển thị",
    broken_mailto: "Một liên kết email không hoạt động", https_certificate: "Trình duyệt hiện cảnh báo khi mở website", redirect_loop: "Website không tải được khi truy cập",
    no_mobile_viewport: "Trên điện thoại, trang bị thu nhỏ", http_error: "Trang chủ trả về lỗi" },
});

// ---------- Oberflächentexte ----------
const DE = {
  // Login / Sitzung
  "login.title": "Anmelden", "login.user": "Benutzername", "login.password": "Passwort", "login.submit": "Anmelden", "login.busy": "Anmeldung läuft …",
  "login.bad": "Benutzername oder Passwort falsch.", "login.rate": "Zu viele Fehlversuche – bitte 15 Minuten warten.", "login.error": "Anmeldung nicht möglich – bitte später erneut versuchen.",
  "login.hint": "Persönlicher Zugang. Das Passwort wird nie gespeichert oder angezeigt.", "login.lang": "Sprache",
  "app.logout": "Abmelden", "app.leads": "Meine Leads", "app.commission": "Provision", "app.chat": "Jarvis", "app.role.SALES_MANAGER_CH": "Vertriebsleitung Schweiz",
  "app.role.SALES_AGENT_CH": "Vertrieb Schweiz", "app.role.SALES_AGENT_VN": "Vertrieb Vietnam", "app.role.OWNER": "Owner", "app.market.CH": "Schweiz", "app.market.VN": "Vietnam",
  "app.session_expired": "Sitzung abgelaufen – bitte neu anmelden.", "app.leads_open": "CRM ÖFFNEN", "app.leads_text": (n) => `${n} Leads in Ihrem Bereich`,
  "app.loading": "Lade …", "app.unreachable": "Cloud nicht erreichbar.",
  // Provision
  "com.title": "Provision", "com.rate": (p) => `Satz: ${p} %`, "com.pending": "Ausstehend", "com.payable": "Auszahlbar", "com.reversed": "Storniert",
  "com.orders": "Abgeschlossene, voll bezahlte Aufträge", "com.rule": "Provision wird erst auszahlbar, wenn der Auftrag abgeschlossen UND vollständig bezahlt ist.",
  "com.none": "Noch keine Aufträge mit Provision.", "com.order": "Auftrag", "com.status": "Status", "com.price": "Preis", "com.amount": "Provision",
  "com.st.PENDING": "Ausstehend", "com.st.PAYABLE": "Auszahlbar", "com.st.REVERSED": "Storniert", "com.payout_note": "Jarvis zahlt nichts automatisch aus.",
  "com.paid_out": "Ausbezahlt", "com.outstanding": "Offen auszuzahlen", "sales.title": "Meine Verkäufe", "sales.none": "Noch keine Aufträge.", "sales.offer": "Angebot", "sales.paid": "Bezahlt", "sales.state": "Auftragsstatus", "sales.pay": "Zahlungsstatus",
  // Chat
  "chat.placeholder": "Frage an Jarvis …", "chat.send": "Senden", "chat.error": "Jarvis ist gerade nicht erreichbar.", "chat.empty": "Fragen Sie Jarvis zu Ihren Leads und Ihrer Provision.",
  "chat.you": "Sie", "chat.reset": "Verlauf löschen",
  // CRM
  "crm.title": "CRM", "crm.loading": "Lade CRM …", "crm.e401": "Nicht angemeldet – bitte neu anmelden.", "crm.e404": "CRM nur über die Cloud-Oberfläche verfügbar.",
  "crm.eStatus": (s) => `CRM nicht verfügbar (Fehler ${s}).`, "crm.unreachable": "Cloud nicht erreichbar.",
  "crm.meta": (n, at, online) => `${n} Leads · Stand VPS ${at} · Dienst ${online ? "ONLINE" : "OFFLINE – Änderungen nicht möglich"}`,
  "crm.metaBackup": (at, offsite) => ` · Backup ${at}${offsite ? "" : " (offsite offen)"}`, "crm.overdue": (n) => ` · ${n} überfällig`,
  "crm.pipeHead": (n) => `Gesamte qualifizierte Leads: ${n} – davon`, "crm.errHead": "Website-Fehler", "crm.nextBest": "Nächster bester Lead:",
  "crm.noNext": "Kein offener Lead in der Outreach-Queue.", "crm.count": (a, b) => `${a} von ${b}`, "crm.emptyFilter": "Keine Leads für diese Filter.",
  "crm.emptyNone": "Noch keine CRM-Daten vom VPS.", "crm.open": "öffnen", "crm.notChecked": "Noch nicht geprüft", "crm.noneVerified": "Keine aktuell verifizierten Fehler",
  "th.company": "Firma", "th.category": "Branche", "th.website": "Website", "th.errors": "Fehler", "th.top": "Wichtigste Fehler", "th.person": "Ansprechpartner", "th.phone": "Telefon",
  "th.email": "E-Mail", "th.draft": "Draft", "th.status": "Status", "th.call": "Telefonstatus", "th.next": "Nächster Schritt",
  "card.category": "Branche:", "card.errors": "Fehler:", "card.top2": "Wichtigste 2:", "card.person": "Ansprechpartner: ", "card.phone": "Telefon: ",
  "btn.call": "ANRUFEN", "btn.website": "WEBSITE ÖFFNEN", "btn.draftOpen": "ENTWURF ÖFFNEN", "btn.gmail": "GMAIL-ENTWURF ÖFFNEN", "btn.mail": "E-MAIL ÖFFNEN",
  "fact.source": "Quellseite", "fact.element": "Element", "fact.target": "Ziel", "fact.result": "Beobachtet", "fact.http": "HTTP-Status", "fact.page": "Betroffene Seite: ",
  // TF-072: Direktlinks je Fehler (CRM-Detail + Anrufansicht) – nur geprüfte öffentliche http(s)-Adressen, nie erfunden.
  "link.err": "Fehler", "link.page": "Betroffene Seite", "link.open": "Fehler öffnen", "link.target": "Ziel öffnen", "link.none": "Direktlink nicht verfügbar",
  "link.impact": "Auswirkung", "sec.callIssues": "Fehler für das Gespräch",
  "impact.contact": "Anfragen oder Bestellungen können verloren gehen", "impact.navigation": "Besucher kommen auf der Website nicht weiter",
  "impact.http": "Besucher landen auf einer Fehlerseite", "impact.images": "Inhalte werden unvollständig angezeigt",
  "impact.mobile": "Auf dem Handy schlecht nutzbar", "impact.other": "Sichtbarer Darstellungsfehler",
  "dnc": "DO NOT CONTACT", "other": "Andere", "severity": "Schweregrad", "manualItem": "manueller Punkt", "verified": "verifiziert",
  "kv.verified": "Verifizierte Fehler", "kv.audit": "Audit", "kv.lastChecked": "Zuletzt geprüft", "kv.hint": "Hinweis", "kv.repair": "Reparatur",
  "hint.staleFull": "Letzte vollständige Prüfung veraltet – Zahl nicht mehr garantiert aktuell, Neuprüfung ist eingeplant.",
  "hint.staleHist": "Veraltet – historische Befunde, nicht als aktuelle Fehlerzahl zu verstehen. Neuprüfung ist eingeplant.",
  "hint.partial": "Nur Teilprüfung – es können weitere Fehler vorhanden sein.", "h.top": "Wichtigste Fehler",
  "h.all": (n, full) => `Alle verifizierten Fehler (${n}${full ? "" : ", Mindestzahl"})`, "sevLine": (s, c, d) => `Schweregrad: ${s} · ${c} · verifiziert ${d}`,
  "aria.stage": "Sales Stage", "aria.contact": "Kontaktstatus", "aria.call": "Call Status", "btn.close": "SCHLIESSEN", "aria.closeDetail": "Details schliessen",
  "priority": (lv, sc) => `Priorität ${lv} · ${sc}`, "histNote": "Historischer Discovery-Fund: im CRM sichtbar, aber keine Outreach-Quelle – ein Entwurf entsteht nur über die reguläre Qualifikation.",
  "dncBanner": "DO NOT CONTACT – keine Anrufe, kein Follow-up, keine neuen Cold-Entwürfe", "dncSource": (s) => ` (Quelle: ${s})`, "src.opt_out": "Opt-out", "src.suppression": "Suppression",
  "src.registry": "Lead-Datenbank", "noReasons": "keine Priorisierungspunkte",
  "sec.contact": "A · Kontakt", "sec.website": "B · Website", "sec.health": "C · Website-Zustand", "sec.outreach": "D · Outreach", "sec.phone": "E · Telefon", "sec.followup": "Follow-up",
  "sec.notes": "F · Notizen", "sec.admin": "Verwaltung", "sec.draft": "G · E-Mail-Entwurf",
  "kv.email": "E-Mail", "kv.phone": "Telefon", "kv.first": "Vorname", "kv.last": "Nachname", "kv.role": "Rolle", "kv.place": "Ort", "kv.category": "Branche", "kv.region": "Region",
  "kv.website": "Website", "kv.reachable": "Erreichbar", "yes": "ja", "no": "nein", "reach.no": "nein / umgeleitet", "reach.unknown": "nicht geprüft", "kv.lastCheck": "Letzte Prüfung",
  "kv.first_check": "Erstprüfung (Cold)", "firstCheck": (c, m) => `${c} bestätigt${m ? ` · ${m} weitere` : ""}`, "kv.updated": "Aktualisiert", "kv.draftStatus": "Draft-Status",
  "kv.draftCreated": "Draft erstellt", "kv.manualSent": "Manuell gesendet", "kv.lastContact": "Letzter Kontakt", "kv.contactStatus": "Kontaktstatus", "kv.callStatus": "Call Status",
  "kv.callRec": "Anruf empfohlen", "btn.stage": "STATUS ÄNDERN", "btn.contact": "KONTAKTSTATUS", "btn.callStatus": "TELEFONSTATUS", "btn.logCall": "ANRUF DOKUMENTIEREN",
  "hist.next": "Nächster Schritt: ", "hist.fu": "Follow-up: ", "noCalls": "Noch keine Anrufe dokumentiert.", "noNotes": "Noch keine Notizen.",
  "dncLocked": "Sperre aus Opt-out/Suppression/Lead-Datenbank – im CRM nicht aufhebbar.", "dncLift?": "Do Not Contact für diesen Lead aufheben?",
  "dncSet?": "DO NOT CONTACT setzen? Keine Anrufe, kein Follow-up, keine neuen Cold-Entwürfe. Bestehende Daten bleiben erhalten.", "reason?": "Grund (optional):",
  "btn.dncLift": "DO NOT CONTACT AUFHEBEN", "btn.dncSet": "DO NOT CONTACT SETZEN", "btn.unarchive": "AUS ARCHIV HOLEN", "btn.archive": "ARCHIVIEREN",
  "footer": "Jarvis sendet, ruft und schreibt nie automatisch. Links öffnen nur Website, Telefon-App, Mail-Programm oder den bestehenden Gmail-Entwurf.",
  "ph.callNote": "Notiz zum Anruf", "ph.next": "z. B. Angebot CHF 150 schicken", "lbl.when": "Datum/Zeit", "lbl.result": "Ergebnis", "lbl.note": "Notiz", "lbl.next": "Nächster Schritt",
  "lbl.fuDate": "Follow-up Datum", "btn.saveCall": "ANRUF SPEICHERN", "ph.nextShort": "Nächster Schritt", "btn.setFu": "FOLLOW-UP SETZEN", "btn.remove": "ENTFERNEN",
  "fuNote": "Follow-up erzeugt keine Mail und keine automatische Kontaktaufnahme.", "ph.note": "Neue Notiz (wird mit Zeitstempel angehängt, bestehende bleiben)", "btn.addNote": "NOTIZ HINZUFÜGEN",
  "act.saving": "Wird gespeichert … (VPS)", "act.err": (s) => `Fehler ${s}`, "act.ok": "Gespeichert ✓", "act.notSaved": (s) => `Nicht gespeichert (${s}).`,
  "act.noConfirm": "Noch keine Bestätigung vom VPS – Stand später prüfen.", "act.offline": "Cloud nicht erreichbar – nicht gespeichert.", "export.fail": (m) => `Export fehlgeschlagen (${m}).`,
  "btn.refresh": "AKTUALISIEREN", "btn.csv": "EXPORT CSV", "aria.pipe": "Qualifizierte Leads", "aria.cards": "Übersicht", "aria.errs": "Website-Fehler",
  "ph.search": "Suche: Firma, Domain, E-Mail, Telefon, Name, Ort …", "aria.search": "Suche", "aria.sort": "Sortierung", "sortBy": (s) => `Sortierung: ${s}`, "filters": "Filter",
  "f.stage": "Sales Stage", "f.canton": "Kanton", "f.region": "Region", "f.category": "Branche", "f.phone": "Telefon", "f.phone1": "mit Telefon", "f.phone0": "ohne Telefon",
  "f.person": "Ansprechpartner", "f.person1": "mit Ansprechpartner", "f.person0": "ohne", "f.draft": "Draft", "f.draft1": "Entwurf vorhanden", "f.draft0": "kein Entwurf",
  "f.errors": "Fehler", "f.audit": "Audit", "f.issue": "Wichtiges Problem", "f.contact": "Kontaktstatus", "f.call": "Call Status", "f.followup": "Follow-up",
  "f.fuDue": "fällig (heute + überfällig)", "f.fuOver": "überfällig", "f.fuToday": "heute fällig", "f.fuLater": "später", "f.fuNone": "keins", "f.dnc": "Do Not Contact",
  "f.dnc1": "nur Do Not Contact", "f.dnc0": "ohne Do Not Contact", "f.archived": "Archiv: ausblenden", "f.archOnly": "nur archivierte", "f.archAll": "alle inkl. Archiv", "btn.reset": "ZURÜCKSETZEN",
  "draft.h": "E-Mail-Entwurf (nur Entwurf, nie Versand)", "draft.subject": "Betreff", "draft.body": "Text", "draft.btn": "ENTWURF ANLEGEN",
  "draft.note": "Empfänger wird serverseitig aus diesem Lead bestimmt. Jarvis legt nur einen Entwurf an – Versand erfolgt nie automatisch.",
  "draft.queued": "Entwurf beauftragt ✓ – erscheint in Kürze im Gmail-Entwurfsordner.", "draft.fail": "Entwurf nicht möglich.", "draft.noEmail": "Für diesen Lead ist keine E-Mail-Adresse bekannt.",
  "code.OUT_OF_SCOPE": "Dieser Lead gehört nicht zu Ihrem Bereich.", "code.SERVER_OFFLINE": "Dienst auf dem VPS meldet sich nicht – nichts gespeichert.",
  "code.RATE_LIMIT": "Zu viele Änderungen – bitte kurz warten.", "code.DO_NOT_CONTACT": "Do Not Contact – keine Kontaktaktion.", "code.UNKNOWN_LEAD": "Unbekannter Lead.",
  "code.BAD_PARAMS": "Ungültige Eingabe.", "code.FORBIDDEN": "Keine Berechtigung.", "code.NO_EMAIL": "Für diesen Lead ist keine E-Mail-Adresse bekannt.",
  "code.default": "Aktion fehlgeschlagen.",
  // TF-064 Aufträge (VN-Lead, Sicht Owner)
  "sec.order": "H · Auftrag", "ord.CHECK": "Check & Anleitung", "ord.FIX": "Check & Reparatur", "ord.confirm": "Der Kunde hat die Bestellung dieser Leistung bestätigt.",
  "ord.create": "AUFTRAG ANLEGEN", "ord.cancel": "ABBRECHEN", "ord.choose": "Leistung wählen – der Preis ist fest und wird vom Server bestimmt.",
  "ord.id": "Auftrags-Nr.", "ord.service": "Leistung", "ord.total": "Gesamtpreis", "ord.paid": "Bezahlt", "ord.rest": "Offen", "ord.payStatus": "Zahlungsstatus",
  "ord.workStatus": "Arbeitsstatus", "ord.commission": "Erwartete Provision", "ord.creating": "Auftrag wird angelegt …", "ord.failed": "Auftrag nicht angelegt",
  "ord.queued": "Auftrag bestätigt ✓ – wird auf dem VPS angelegt.", "ord.none": "Noch kein Auftrag für diesen Lead.", "ord.open": "Es besteht bereits ein offener Auftrag.",
  "ord.payNote": "Zahlungen erfasst ausschliesslich Chris. Die Arbeit beginnt nach Eingang der ersten Hälfte (Anzahlung).", "ord.needConfirm": "Bitte die Kundenbestätigung anhaken.",
  "pay.UNPAID": "Unbezahlt", "pay.PARTIAL": "Teilweise bezahlt", "pay.DEPOSIT_MET": "Anzahlung erhalten", "pay.PAID_FULL": "Vollständig bezahlt", "pay.REFUNDED": "Zurückerstattet",
  "pay.PAYMENT_REVIEW_REQUIRED": "Zahlung wird geprüft",
  "code.DUPLICATE_OPEN_ORDER": "Für diesen Lead besteht bereits ein offener Auftrag.", "code.NOT_CONFIRMED": "Kundenbestätigung fehlt.", "code.BAD_STATUS": "Lead-Status erlaubt keinen Auftrag.",
  "code.PRICE_MISMATCH": "Preisprüfung fehlgeschlagen – nichts angelegt.", "code.CREATE_FAILED": "Auftrag konnte nicht angelegt werden.",
};
const VI = {
  "login.title": "Đăng nhập", "login.user": "Tên đăng nhập", "login.password": "Mật khẩu", "login.submit": "Đăng nhập", "login.busy": "Đang đăng nhập …",
  "login.bad": "Tên đăng nhập hoặc mật khẩu không đúng.", "login.rate": "Đăng nhập sai quá nhiều lần – vui lòng đợi 15 phút.", "login.error": "Không thể đăng nhập – vui lòng thử lại sau.",
  "login.hint": "Tài khoản cá nhân. Mật khẩu không bao giờ được lưu hoặc hiển thị.", "login.lang": "Ngôn ngữ",
  "app.logout": "Đăng xuất", "app.leads": "Khách hàng tiềm năng của tôi", "app.commission": "Hoa hồng", "app.chat": "Jarvis", "app.role.SALES_MANAGER_CH": "Quản lý kinh doanh Thụy Sĩ",
  "app.role.SALES_AGENT_CH": "Nhân viên kinh doanh Thụy Sĩ", "app.role.SALES_AGENT_VN": "Nhân viên kinh doanh Việt Nam", "app.role.OWNER": "Chủ sở hữu", "app.market.CH": "Thụy Sĩ", "app.market.VN": "Việt Nam",
  "app.session_expired": "Phiên đăng nhập đã hết hạn – vui lòng đăng nhập lại.", "app.leads_open": "MỞ DANH SÁCH", "app.leads_text": (n) => `${n} khách hàng tiềm năng trong phạm vi của bạn`,
  "app.loading": "Đang tải …", "app.unreachable": "Không kết nối được máy chủ.",
  "com.title": "Hoa hồng", "com.rate": (p) => `Tỷ lệ: ${p} %`, "com.pending": "Đang chờ", "com.payable": "Có thể thanh toán", "com.reversed": "Đã hủy",
  "com.orders": "Đơn hàng đã hoàn thành và thanh toán đủ", "com.rule": "Hoa hồng chỉ được thanh toán khi đơn hàng đã hoàn thành VÀ khách đã thanh toán đầy đủ.",
  "com.none": "Chưa có đơn hàng nào có hoa hồng.", "com.order": "Đơn hàng", "com.status": "Trạng thái", "com.price": "Giá", "com.amount": "Hoa hồng",
  "com.st.PENDING": "Đang chờ", "com.st.PAYABLE": "Có thể thanh toán", "com.st.REVERSED": "Đã hủy", "com.payout_note": "Jarvis không tự động chi trả tiền.",
  "com.paid_out": "Đã chi trả", "com.outstanding": "Còn phải chi trả", "sales.title": "Đơn hàng của tôi", "sales.none": "Chưa có đơn hàng.", "sales.offer": "Dịch vụ", "sales.paid": "Đã thanh toán", "sales.state": "Trạng thái đơn hàng", "sales.pay": "Trạng thái thanh toán",
  "chat.placeholder": "Hỏi Jarvis …", "chat.send": "Gửi", "chat.error": "Jarvis hiện không phản hồi.", "chat.empty": "Hãy hỏi Jarvis về khách hàng tiềm năng và hoa hồng của bạn.",
  "chat.you": "Bạn", "chat.reset": "Xóa lịch sử",
  "crm.title": "Khách hàng tiềm năng", "crm.loading": "Đang tải danh sách …", "crm.e401": "Chưa đăng nhập – vui lòng đăng nhập lại.", "crm.e404": "Danh sách chỉ có trên giao diện đám mây.",
  "crm.eStatus": (s) => `Không tải được danh sách (lỗi ${s}).`, "crm.unreachable": "Không kết nối được máy chủ.",
  "crm.meta": (n, at, online) => `${n} khách hàng tiềm năng · Cập nhật ${at} · Dịch vụ ${online ? "TRỰC TUYẾN" : "NGOẠI TUYẾN – không thể thay đổi"}`,
  "crm.metaBackup": () => "", "crm.overdue": (n) => ` · ${n} quá hạn`,
  "crm.pipeHead": (n) => `Tổng số khách hàng tiềm năng: ${n} – trong đó`, "crm.errHead": "Lỗi website", "crm.nextBest": "Nên liên hệ tiếp theo:",
  "crm.noNext": "Không có khách hàng tiềm năng nào đang chờ liên hệ.", "crm.count": (a, b) => `${a} / ${b}`, "crm.emptyFilter": "Không có kết quả cho bộ lọc này.",
  "crm.emptyNone": "Chưa có dữ liệu.", "crm.open": "mở", "crm.notChecked": "Chưa kiểm tra", "crm.noneVerified": "Không có lỗi nào được xác minh hiện tại",
  "th.company": "Công ty", "th.category": "Ngành", "th.website": "Website", "th.errors": "Lỗi", "th.top": "Lỗi quan trọng nhất", "th.person": "Người liên hệ", "th.phone": "Điện thoại",
  "th.email": "Email", "th.draft": "Bản nháp", "th.status": "Trạng thái", "th.call": "Trạng thái cuộc gọi", "th.next": "Bước tiếp theo",
  "card.category": "Ngành:", "card.errors": "Lỗi:", "card.top2": "2 lỗi quan trọng nhất:", "card.person": "Người liên hệ: ", "card.phone": "Điện thoại: ",
  "btn.call": "GỌI ĐIỆN", "btn.website": "MỞ WEBSITE", "btn.draftOpen": "MỞ BẢN NHÁP", "btn.gmail": "MỞ BẢN NHÁP GMAIL", "btn.mail": "MỞ EMAIL",
  "fact.source": "Trang nguồn", "fact.element": "Thành phần", "fact.target": "Đích", "fact.result": "Quan sát được", "fact.http": "Mã HTTP", "fact.page": "Trang bị ảnh hưởng: ",
  "link.err": "Lỗi", "link.page": "Trang bị ảnh hưởng", "link.open": "Mở lỗi", "link.target": "Mở trang đích", "link.none": "Không có liên kết trực tiếp",
  "link.impact": "Ảnh hưởng", "sec.callIssues": "Lỗi để trao đổi khi gọi",
  "impact.contact": "Yêu cầu hoặc đơn hàng của khách có thể bị mất", "impact.navigation": "Khách truy cập không thể tiếp tục trên website",
  "impact.http": "Khách truy cập gặp trang lỗi", "impact.images": "Nội dung hiển thị không đầy đủ",
  "impact.mobile": "Khó sử dụng trên điện thoại", "impact.other": "Lỗi hiển thị có thể nhìn thấy",
  "dnc": "KHÔNG LIÊN HỆ", "other": "Khác", "severity": "Mức độ", "manualItem": "mục xử lý thủ công", "verified": "xác minh",
  "kv.verified": "Lỗi đã xác minh", "kv.audit": "Kiểm tra", "kv.lastChecked": "Kiểm tra gần nhất", "kv.hint": "Lưu ý", "kv.repair": "Sửa chữa",
  "hint.staleFull": "Lần kiểm tra đầy đủ gần nhất đã cũ – số lỗi có thể không còn chính xác, đã lên lịch kiểm tra lại.",
  "hint.staleHist": "Đã cũ – đây là phát hiện trước đây, không phải số lỗi hiện tại. Đã lên lịch kiểm tra lại.",
  "hint.partial": "Chỉ kiểm tra một phần – có thể còn lỗi khác.", "h.top": "Lỗi quan trọng nhất",
  "h.all": (n, full) => `Tất cả lỗi đã xác minh (${n}${full ? "" : ", tối thiểu"})`, "sevLine": (s, c, d) => `Mức độ: ${s} · ${c} · xác minh ${d}`,
  "aria.stage": "Trạng thái bán hàng", "aria.contact": "Trạng thái liên hệ", "aria.call": "Trạng thái cuộc gọi", "btn.close": "ĐÓNG", "aria.closeDetail": "Đóng chi tiết",
  "priority": (lv, sc) => `Ưu tiên ${lv} · ${sc}`, "histNote": "Phát hiện cũ: hiển thị để tham khảo, không dùng để tự động liên hệ.",
  "dncBanner": "KHÔNG LIÊN HỆ – không gọi điện, không theo dõi, không tạo bản nháp mới", "dncSource": (s) => ` (Nguồn: ${s})`, "src.opt_out": "Đã từ chối nhận tin",
  "src.suppression": "Danh sách chặn", "src.registry": "Cơ sở dữ liệu", "noReasons": "không có điểm ưu tiên",
  "sec.contact": "A · Liên hệ", "sec.website": "B · Website", "sec.health": "C · Tình trạng website", "sec.outreach": "D · Tiếp cận", "sec.phone": "E · Điện thoại", "sec.followup": "Theo dõi tiếp",
  "sec.notes": "F · Ghi chú", "sec.admin": "Quản lý", "sec.draft": "G · Bản nháp email",
  "kv.email": "Email", "kv.phone": "Điện thoại", "kv.first": "Tên", "kv.last": "Họ", "kv.role": "Chức vụ", "kv.place": "Địa điểm", "kv.category": "Ngành", "kv.region": "Tỉnh/Thành phố",
  "kv.website": "Website", "kv.reachable": "Truy cập được", "yes": "có", "no": "không", "reach.no": "không / bị chuyển hướng", "reach.unknown": "chưa kiểm tra", "kv.lastCheck": "Kiểm tra gần nhất",
  "kv.first_check": "Kiểm tra ban đầu", "firstCheck": (c, m) => `${c} đã xác nhận${m ? ` · ${m} khác` : ""}`, "kv.updated": "Cập nhật", "kv.draftStatus": "Trạng thái bản nháp",
  "kv.draftCreated": "Ngày tạo bản nháp", "kv.manualSent": "Đã gửi thủ công", "kv.lastContact": "Liên hệ gần nhất", "kv.contactStatus": "Trạng thái liên hệ", "kv.callStatus": "Trạng thái cuộc gọi",
  "kv.callRec": "Nên gọi điện", "btn.stage": "ĐỔI TRẠNG THÁI", "btn.contact": "LƯU TRẠNG THÁI LIÊN HỆ", "btn.callStatus": "LƯU TRẠNG THÁI CUỘC GỌI", "btn.logCall": "GHI LẠI CUỘC GỌI",
  "hist.next": "Bước tiếp theo: ", "hist.fu": "Theo dõi: ", "noCalls": "Chưa ghi lại cuộc gọi nào.", "noNotes": "Chưa có ghi chú.",
  "dncLocked": "Bị chặn do từ chối nhận tin/danh sách chặn – không thể gỡ tại đây.", "dncLift?": "Gỡ trạng thái Không liên hệ cho khách hàng này?",
  "dncSet?": "Đặt KHÔNG LIÊN HỆ? Không gọi điện, không theo dõi, không tạo bản nháp mới. Dữ liệu hiện có được giữ nguyên.", "reason?": "Lý do (không bắt buộc):",
  "btn.dncLift": "GỠ KHÔNG LIÊN HỆ", "btn.dncSet": "ĐẶT KHÔNG LIÊN HỆ", "btn.unarchive": "LẤY RA KHỎI LƯU TRỮ", "btn.archive": "LƯU TRỮ",
  "footer": "Jarvis không bao giờ tự động gửi, gọi hoặc viết. Liên kết chỉ mở website, ứng dụng điện thoại, ứng dụng email hoặc bản nháp đã có.",
  "ph.callNote": "Ghi chú cuộc gọi", "ph.next": "VD: gửi thông tin dịch vụ", "lbl.when": "Ngày/Giờ", "lbl.result": "Kết quả", "lbl.note": "Ghi chú", "lbl.next": "Bước tiếp theo",
  "lbl.fuDate": "Ngày theo dõi", "btn.saveCall": "LƯU CUỘC GỌI", "ph.nextShort": "Bước tiếp theo", "btn.setFu": "ĐẶT LỊCH THEO DÕI", "btn.remove": "XÓA",
  "fuNote": "Lịch theo dõi không tạo email và không tự động liên hệ.", "ph.note": "Ghi chú mới (được thêm kèm thời gian, ghi chú cũ được giữ lại)", "btn.addNote": "THÊM GHI CHÚ",
  "act.saving": "Đang lưu …", "act.err": (s) => `Lỗi ${s}`, "act.ok": "Đã lưu ✓", "act.notSaved": () => "Chưa lưu được.",
  "act.noConfirm": "Chưa nhận được xác nhận – vui lòng kiểm tra lại sau.", "act.offline": "Không kết nối được máy chủ – chưa lưu.", "export.fail": () => "Xuất tệp thất bại.",
  "btn.refresh": "LÀM MỚI", "btn.csv": "XUẤT CSV", "aria.pipe": "Khách hàng tiềm năng", "aria.cards": "Tổng quan", "aria.errs": "Lỗi website",
  "ph.search": "Tìm: công ty, tên miền, email, điện thoại, tên, địa điểm …", "aria.search": "Tìm kiếm", "aria.sort": "Sắp xếp", "sortBy": (s) => `Sắp xếp: ${s}`, "filters": "Bộ lọc",
  "f.stage": "Trạng thái bán hàng", "f.canton": "Bang", "f.region": "Tỉnh/Thành phố", "f.category": "Ngành", "f.phone": "Điện thoại", "f.phone1": "có điện thoại", "f.phone0": "không có điện thoại",
  "f.person": "Người liên hệ", "f.person1": "có người liên hệ", "f.person0": "không có", "f.draft": "Bản nháp", "f.draft1": "có bản nháp", "f.draft0": "chưa có bản nháp",
  "f.errors": "Lỗi", "f.audit": "Kiểm tra", "f.issue": "Vấn đề chính", "f.contact": "Trạng thái liên hệ", "f.call": "Trạng thái cuộc gọi", "f.followup": "Theo dõi",
  "f.fuDue": "đến hạn (hôm nay + quá hạn)", "f.fuOver": "quá hạn", "f.fuToday": "đến hạn hôm nay", "f.fuLater": "sau này", "f.fuNone": "không có", "f.dnc": "Không liên hệ",
  "f.dnc1": "chỉ Không liên hệ", "f.dnc0": "trừ Không liên hệ", "f.archived": "Lưu trữ: ẩn", "f.archOnly": "chỉ mục đã lưu trữ", "f.archAll": "tất cả kể cả lưu trữ", "btn.reset": "ĐẶT LẠI",
  "draft.h": "Bản nháp email (chỉ bản nháp, không bao giờ tự gửi)", "draft.subject": "Tiêu đề", "draft.body": "Nội dung", "draft.btn": "TẠO BẢN NHÁP",
  "draft.note": "Người nhận được hệ thống xác định từ khách hàng này. Jarvis chỉ tạo bản nháp – không bao giờ tự động gửi.",
  "draft.queued": "Đã yêu cầu tạo bản nháp ✓ – bản nháp sẽ sớm xuất hiện trong thư mục nháp.", "draft.fail": "Không thể tạo bản nháp.", "draft.noEmail": "Khách hàng này chưa có địa chỉ email.",
  "code.OUT_OF_SCOPE": "Khách hàng này không thuộc phạm vi của bạn.", "code.SERVER_OFFLINE": "Dịch vụ chưa sẵn sàng – chưa lưu.",
  "code.RATE_LIMIT": "Thao tác quá nhiều – vui lòng đợi một chút.", "code.DO_NOT_CONTACT": "Không liên hệ – không thể thực hiện.", "code.UNKNOWN_LEAD": "Không tìm thấy khách hàng.",
  "code.BAD_PARAMS": "Dữ liệu nhập không hợp lệ.", "code.FORBIDDEN": "Bạn không có quyền.", "code.NO_EMAIL": "Khách hàng này chưa có địa chỉ email.", "code.default": "Thao tác thất bại.",
  // TF-064 Đơn hàng
  "sec.order": "H · Đơn hàng", "ord.CHECK": "Kiểm tra & hướng dẫn", "ord.FIX": "Kiểm tra & sửa lỗi", "ord.confirm": "Khách hàng đã xác nhận đặt dịch vụ này.",
  "ord.create": "TẠO ĐƠN HÀNG", "ord.cancel": "HỦY", "ord.choose": "Chọn dịch vụ – giá cố định do hệ thống xác định.",
  "ord.id": "Mã đơn hàng", "ord.service": "Dịch vụ", "ord.total": "Tổng giá", "ord.paid": "Đã thanh toán", "ord.rest": "Còn lại", "ord.payStatus": "Trạng thái thanh toán",
  "ord.workStatus": "Trạng thái công việc", "ord.commission": "Hoa hồng dự kiến", "ord.creating": "Đang tạo đơn hàng …", "ord.failed": "Không tạo được đơn hàng",
  "ord.queued": "Đã xác nhận đơn hàng ✓ – hệ thống đang tạo đơn.", "ord.none": "Chưa có đơn hàng cho khách hàng này.", "ord.open": "Khách hàng này đã có một đơn hàng đang mở.",
  "ord.payNote": "Chỉ Chris ghi nhận thanh toán. Công việc bắt đầu sau khi nhận được một nửa giá trị (tiền đặt cọc).", "ord.needConfirm": "Vui lòng đánh dấu xác nhận của khách hàng.",
  "pay.UNPAID": "Chưa thanh toán", "pay.PARTIAL": "Đã thanh toán một phần", "pay.DEPOSIT_MET": "Đã đủ tiền đặt cọc", "pay.PAID_FULL": "Đã thanh toán đầy đủ", "pay.REFUNDED": "Đã hoàn tiền",
  "pay.PAYMENT_REVIEW_REQUIRED": "Đang kiểm tra thanh toán",
  "code.DUPLICATE_OPEN_ORDER": "Khách hàng này đã có một đơn hàng đang mở.", "code.NOT_CONFIRMED": "Thiếu xác nhận của khách hàng.", "code.BAD_STATUS": "Trạng thái khách hàng không cho phép tạo đơn hàng.",
  "code.PRICE_MISMATCH": "Kiểm tra giá thất bại – chưa tạo đơn hàng.", "code.CREATE_FAILED": "Không tạo được đơn hàng.",
};
// TF-064: Arbeitsstatus (Phase des Auftrags) je Sprache.
export const PHASE_LABELS = Object.freeze({
  "de-CH": { WAITING_FOR_CONFIRMATION: "Wartet auf Bestätigung", WAITING_FOR_DEPOSIT: "Wartet auf Anzahlung", DEPOSIT_RECEIVED: "Anzahlung erhalten", AUDITING: "Website wird geprüft",
    REPORT: "Bericht wird erstellt", READY_FOR_DELIVERY: "Bereit zur Übergabe", SENT: "Bericht gesendet", COMPLETED: "Abgeschlossen", COMPLETED_WITH_MANUAL_ITEMS: "Abgeschlossen (manuelle Punkte offen)",
    CANCELLED: "Storniert", BLOCKED: "Angehalten", WAITING_FOR_ACCESS: "Wartet auf Zugang", ACCESS_REQUEST_SENT: "Zugangs-Anfrage gesendet", ACCESS_RECEIVED: "Zugang erhalten",
    ACCESS_PROFILE_PREFLIGHT: "Zugang wird geprüft", HOST_KEY_CONFIRMATION: "Wartet auf Sicherheitsbestätigung", WAITING_FOR_ACCESS_PROFILE: "Wartet auf Zugangsangaben", WAITING_FOR_CUSTOMER_BRIEF: "Wartet auf Kundenangaben", BACKUP: "Sicherung läuft",
    REPAIRING: "Reparatur läuft", VALIDATING: "Ergebnis wird geprüft", LIVE_RETEST: "Erneute Prüfung", MANUAL_REVIEW: "Manuelle Prüfung nötig", PAYMENT_REVIEW_REQUIRED: "Zahlung wird geprüft" },
  "vi-VN": { WAITING_FOR_CONFIRMATION: "Chờ xác nhận", WAITING_FOR_DEPOSIT: "Chờ tiền đặt cọc", DEPOSIT_RECEIVED: "Đã nhận tiền đặt cọc", AUDITING: "Đang kiểm tra website",
    REPORT: "Đang soạn báo cáo", READY_FOR_DELIVERY: "Sẵn sàng bàn giao", SENT: "Đã gửi báo cáo", COMPLETED: "Hoàn thành", COMPLETED_WITH_MANUAL_ITEMS: "Hoàn thành (còn mục xử lý thủ công)",
    CANCELLED: "Đã hủy", BLOCKED: "Tạm dừng", WAITING_FOR_ACCESS: "Chờ quyền truy cập", ACCESS_REQUEST_SENT: "Đã gửi yêu cầu truy cập", ACCESS_RECEIVED: "Đã nhận quyền truy cập",
    ACCESS_PROFILE_PREFLIGHT: "Đang kiểm tra quyền truy cập", HOST_KEY_CONFIRMATION: "Chờ xác nhận bảo mật", WAITING_FOR_ACCESS_PROFILE: "Chờ thông tin truy cập", WAITING_FOR_CUSTOMER_BRIEF: "Chờ thông tin từ khách hàng", BACKUP: "Đang sao lưu",
    REPAIRING: "Đang sửa lỗi", VALIDATING: "Đang kiểm tra kết quả", LIVE_RETEST: "Đang kiểm tra lại", MANUAL_REVIEW: "Cần kiểm tra thủ công", PAYMENT_REVIEW_REQUIRED: "Đang kiểm tra thanh toán" },
});
export const DICTS = Object.freeze({ "de-CH": DE, "vi-VN": VI });
export const LABELS = Object.freeze({ "de-CH": DE_LABELS, "vi-VN": VI_LABELS });

export function createI18n(locale) {
  const loc = normLocale(locale);
  const D = DICTS[loc], L = LABELS[loc];
  const t = (key, ...args) => { const v = D[key] ?? DE[key]; return typeof v === "function" ? v(...args) : v ?? key; };
  const vi = loc === "vi-VN";
  return {
    locale: loc, t, L, vi,
    errWords: vi ? ERR_WORDS_VI : ERR_WORDS_DE, issueWords: vi ? ISSUE_WORDS_VI : ISSUE_WORDS_DE,
    tz: vi ? "Asia/Ho_Chi_Minh" : "Europe/Zurich", dateLocale: loc,
    category: (c) => (c ? L.category[c] || c : null),
    reason: (r) => { const m = String(r || "").match(/^([+-]?\d+)\s+(.*)$/); return m ? `${m[1]} ${L.reasons[m[2]] || m[2]}` : r; },
    // vi: Text je Befund-Typ (VN-Leads liefern ihn bereits vietnamesisch); de: der bestehende Kurztext unverändert.
    issueText: (f) => (vi && f?.type && ISSUE_TYPE_TEXT[loc][f.type]) || f?.text || "",
    money, phase: (p) => (p ? PHASE_LABELS[loc][p] || (vi ? "–" : p) : "–"),
    codeMsg: (code, fallback) => (D[`code.${code}`] ? t(`code.${code}`) : vi ? t("code.default") : fallback || t("code.default")),
  };
}
// CSV-Kopfzeilen/Statuswörter für den Export (Netlify-Funktion). de-CH → null (bestehendes Format unverändert).
export function csvLabelsFor(locale) {
  if (normLocale(locale) !== "vi-VN") return null;
  return { headers: ["Công ty", "Website", "Email", "Điện thoại", "Tên", "Họ", "Chức vụ", "Số lỗi", "Lỗi (mô tả)", "Trạng thái bán hàng", "Trạng thái cuộc gọi",
    "Liên hệ gần nhất", "Bước tiếp theo", "Theo dõi", "Có ghi chú"].slice(0, CSV_COLUMNS.length), stage: VI_LABELS.stage, call: VI_LABELS.call, yes: "có", no: "không" };
}
