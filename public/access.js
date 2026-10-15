// Kundenformular für den sicheren Website-Zugang (TF-041). Der Link-Token steht im URL-Fragment (#t=…), wird sofort aus
// der Adresszeile entfernt und nur an /api/access-intake geschickt. Zugangsdaten werden hier verschlüsselt (access-crypto.js);
// der Server bekommt nur Chiffrat und antwortet nie mit Zugangsdaten. Nach dem Senden werden alle Felder geleert.
import { sealForVps } from "./access-crypto.js";

const $ = (id) => document.getElementById(id);
const hash = new URLSearchParams(location.hash.slice(1));
const token = hash.get("t") || "";
// TF-064: VN-Aufträge (VNFIX-…) – Link mit &l=vi bzw. Antwort locale vi-VN → Formular vollständig auf Vietnamesisch.
let VI = hash.get("l") === "vi";
try { history.replaceState(null, "", location.pathname); } catch {}

const HINTS = {
  github_netlify: "Empfohlen: laden Sie uns als Collaborator ein und tragen Sie unten nur das Repository bzw. die Site ein – kein Passwort nötig.",
  wordpress_cms: "Bitte einen temporären Benutzer mit nur den nötigen Rechten anlegen – kein Haupt-Administrator-Passwort.",
  sftp: "Bitte einen temporären SFTP-Benutzer nur für das Website-Verzeichnis anlegen.",
  ssh: "Bitte einen temporären SSH-Benutzer mit minimalen Rechten anlegen (kein root).",
  hosting: "Bitte beim Hosting-Anbieter eine eigene Zugriffsberechtigung bzw. einen Mitarbeiterzugang für uns einrichten.",
  other: "Beschreiben Sie kurz den Zugangsweg. Bitte nur temporäre Zugänge mit minimalen Rechten.",
};
// Vietnamesische Texte je data-t / data-ph (Deutsch steht unverändert im HTML).
const VI_T = {
  h1: "Quyền truy cập website an toàn", lead: "Đơn hàng «Kiểm tra & sửa lỗi website» · Helvetic Webdesign", loading: "Đang kiểm tra đường liên kết …",
  invalid: "Đường liên kết không hợp lệ, đã được sử dụng hoặc đã hết hạn. Vui lòng liên hệ với chúng tôi.",
  hkDone: "Cảm ơn anh/chị – chúng tôi đã nhận được phản hồi. Đường liên kết này hiện không còn hiệu lực.",
  done1: "Cảm ơn anh/chị – quyền truy cập đã được gửi dưới dạng mã hóa. Đường liên kết này hiện không còn hiệu lực.",
  done2: "Chúng tôi sẽ sao lưu toàn bộ website trước, sau đó mới bắt đầu sửa lỗi như đã thỏa thuận. Khi hoàn tất, chúng tôi sẽ nhờ anh/chị xóa quyền truy cập tạm thời.",
  site: "Website:", validUntil: "Đường liên kết có hiệu lực đến", noteH: "Vui lòng cấp quyền ít nhất có thể – theo thứ tự sau:",
  n1: "Mời chúng tôi làm cộng tác viên (ví dụ GitHub, Netlify, hệ thống website của anh/chị) – khi đó không cần mật khẩu.",
  n2: "Tạo một tài khoản tạm thời trong hệ thống website (CMS) chỉ với các quyền cần thiết.", n3: "Tạo một tài khoản SFTP/SSH tạm thời chỉ cho thư mục website.",
  n4: "Chỉ khi không thể làm các cách trên: nhập thông tin truy cập tại đây.", noteA: "Vui lòng", noteB: "không", noteC: "gửi mật khẩu chính hoặc mật khẩu quản trị, và không gửi mật khẩu qua email. Thông tin của anh/chị được mã hóa ngay trong trình duyệt trước khi gửi đi.",
  lblType: "Loại quyền truy cập", optGh: "GitHub / Netlify (mời làm cộng tác viên)", optWp: "WordPress / hệ thống website (CMS)", optHosting: "Tài khoản hosting (quyền truy cập)", optOther: "Khác",
  lblHost: "Địa chỉ đăng nhập / máy chủ / repository (không bắt buộc)", lblUser: "Tên đăng nhập / người dùng được mời (không bắt buộc)",
  lblSecret: "Mật khẩu tạm thời / token / mã mời (không bắt buộc)", legend: "Thông tin máy chủ cho SFTP/SSH (đều không bắt buộc – giúp chúng tôi bắt đầu an toàn mà không cần hỏi lại)",
  lblRoot: "Thư mục website trên máy chủ", hintRoot: "Nếu không biết: để trống. Khi đó chúng tôi chỉ tìm ở chế độ đọc và sẽ hỏi lại nếu chưa rõ ràng.",
  lblHostKey: "Fingerprint của máy chủ (SSH host key, SHA256:…)", hintHostKey: "Thường có trong khu vực khách hàng của nhà cung cấp hosting. Nếu không điền, sau này chúng tôi sẽ nhờ anh/chị xác nhận ngắn – trước đó chúng tôi không kết nối.",
  lblPass: "Passphrase của khóa (chỉ khi khóa SSH có passphrase)", lblStack: "Hệ thống website", stUnknown: "Không biết", stStatic: "Website HTML đơn giản", stPhp: "Website PHP khác", stOther: "Khác",
  lblProvider: "Nhà cung cấp hosting", lblNotes: "Ghi chú (không bắt buộc)", lblDom: "Tên miền của website (vui lòng xác nhận)", send: "Gửi dưới dạng mã hóa",
  hkNoteA: "Trước khi kết nối tới máy chủ của anh/chị, chúng tôi kiểm tra dấu hiệu bảo mật kỹ thuật số của máy chủ (fingerprint). Nhờ vậy chắc chắn chúng tôi đang kết nối đúng máy chủ của anh/chị. Vui lòng so sánh dấu hiệu bên dưới",
  hkNoteB: "từng ký tự một", hkNoteC: "với thông tin từ nhà cung cấp hosting (trong khu vực khách hàng ở mục «SSH»/«SFTP» hoặc hỏi bộ phận hỗ trợ). Cho đến khi anh/chị xác nhận, chúng tôi không kết nối bằng thông tin truy cập của anh/chị.",
  lblFp: "Fingerprint do máy chủ cung cấp", hkYes: "Fingerprint trùng khớp", hkNo: "KHÔNG trùng khớp",
  phRoot: "VD: public_html", phProvider: "VD: tên nhà cung cấp hosting",
};
const VI_HINTS = {
  github_netlify: "Khuyến nghị: mời chúng tôi làm cộng tác viên và chỉ điền repository hoặc site bên dưới – không cần mật khẩu.",
  wordpress_cms: "Vui lòng tạo một tài khoản tạm thời chỉ với các quyền cần thiết – không dùng mật khẩu quản trị chính.",
  sftp: "Vui lòng tạo một tài khoản SFTP tạm thời chỉ cho thư mục website.", ssh: "Vui lòng tạo một tài khoản SSH tạm thời với quyền tối thiểu (không phải root).",
  hosting: "Vui lòng nhờ nhà cung cấp hosting tạo một quyền truy cập riêng hoặc tài khoản nhân viên cho chúng tôi.",
  other: "Mô tả ngắn cách truy cập. Vui lòng chỉ dùng quyền truy cập tạm thời với quyền tối thiểu.",
};
const VI_ERR = { consent: "Vui lòng xác nhận quyền cung cấp truy cập và đồng ý cho việc sửa lỗi.", domain: (d) => `Tên miền phải chính xác là ${d}.`,
  port: "Cổng chỉ gồm chữ số (ví dụ 22).", fp: "Fingerprint có dạng SHA256:… (43 ký tự). Nếu không chắc: để trống.", send: "Gửi thất bại. Vui lòng thử lại.",
  crypto: "Mã hóa hoặc gửi thất bại. Vui lòng thử lại.", hkConsent: "Vui lòng xác nhận rằng anh/chị đã so sánh fingerprint.",
  hkReject: "Cảm ơn anh/chị đã báo – chúng tôi sẽ KHÔNG kết nối và sẽ liên hệ trực tiếp với anh/chị. Đường liên kết này hiện không còn hiệu lực." };
const tr = (de, key, ...a) => (VI ? (typeof VI_ERR[key] === "function" ? VI_ERR[key](...a) : VI_ERR[key]) : de);
function applyVi() {
  if (!VI) return;
  document.documentElement.lang = "vi"; document.title = VI_T.h1;
  for (const n of document.querySelectorAll("[data-t]")) if (VI_T[n.dataset.t]) n.textContent = VI_T[n.dataset.t];
  for (const n of document.querySelectorAll("[data-ph]")) if (VI_T[n.dataset.ph]) n.placeholder = VI_T[n.dataset.ph];
}
const dateText = (iso) => new Date(iso).toLocaleString(VI ? "vi-VN" : "de-CH", { dateStyle: "medium", timeStyle: "short", ...(VI ? { timeZone: "Asia/Ho_Chi_Minh" } : {}) });
const show = (id) => { for (const s of ["loading", "invalid", "done", "form", "hkForm", "hkDone"]) $(s).hidden = s !== id; };
// SFTP/SSH/Hosting: strukturierte Server-Angaben (TF-043) – landen nur im verschlüsselten Payload, nie im Browser-Speicher.
const SERVER_TYPES = new Set(["sftp", "ssh", "hosting"]);
const SERVER_FIELDS = ["port", "root", "hostKey", "passphrase", "provider"];
const normDom = (v) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const api = async (body) => {
  const r = await fetch("/api/access-intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, body: j };
};

let info = null;
async function start() {
  applyVi();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return show("invalid");
  const r = await api({ op: "info", token }).catch(() => ({ ok: false, body: {} }));
  if (!r.ok) { if (r.body?.error && !VI) $("invalidMsg").textContent = r.body.error; return show("invalid"); }
  info = r.body;
  if (info.locale === "vi-VN" && !VI) { VI = true; applyVi(); }
  if (info.purpose === "host_key_confirmation") return startHostKey();
  $("domain").textContent = info.domain;
  $("expires").textContent = dateText(info.expires_at);
  $("dom").value = info.domain;
  $("consentText").textContent = info.consent_text;
  const hint = () => { $("typeHint").textContent = (VI ? VI_HINTS : HINTS)[$("type").value] || ""; $("serverFields").hidden = !SERVER_TYPES.has($("type").value); };
  $("type").addEventListener("change", hint); hint();
  show("form");
}

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = (m) => { $("formErr").textContent = m; $("formErr").hidden = false; };
  $("formErr").hidden = true;
  if (!$("consent").checked) return err(tr("Bitte bestätigen Sie die Berechtigung und die Reparaturfreigabe.", "consent"));
  const dom = normDom($("dom").value);
  if (dom !== info.domain) return err(tr(`Die Domain muss genau ${info.domain} lauten.`, "domain", info.domain));
  const server = SERVER_TYPES.has($("type").value);
  const port = $("port").value.trim(), hostKey = $("hostKey").value.trim();
  if (server && port && !/^\d{1,5}$/.test(port)) return err(tr("Der Port besteht nur aus Ziffern (z. B. 22).", "port"));
  if (server && hostKey && !/^(SHA256:)?[A-Za-z0-9+/]{43}=?$/i.test(hostKey)) return err(tr("Der Fingerprint hat die Form SHA256:… (43 Zeichen). Wenn unsicher: leer lassen.", "fp"));
  $("send").disabled = true;
  try {
    const val = (id) => (server ? $(id).value.trim() || null : null);
    const payload = { access_type: $("type").value, host: $("host").value.trim() || null, username: $("user").value.trim() || null,
      secret: $("secret").value || null, notes: $("notes").value.trim() || null,
      port: val("port"), remote_root: val("root"), ssh_host_key_sha256: val("hostKey"), passphrase: server ? $("passphrase").value || null : null,
      website_stack_hint: server ? $("stack").value : null, provider_name: val("provider") };
    const envelope = await sealForVps(info.public_key, payload);
    const r = await api({ op: "submit", token, access_type: payload.access_type, access_domain: dom, consent: true, envelope });
    if (!r.ok) { $("send").disabled = false; return err(VI ? VI_ERR.send : r.body?.error || "Übermittlung fehlgeschlagen. Bitte erneut versuchen."); }
    for (const id of ["host", "user", "secret", "notes", ...SERVER_FIELDS]) $(id).value = ""; // Klartext aus dem Formular entfernen
    show("done");
  } catch { $("send").disabled = false; err(tr("Verschlüsselung oder Übermittlung fehlgeschlagen. Bitte erneut versuchen.", "crypto")); }
});

// Host-Key-Bestätigung (TF-043): Kunde vergleicht den vom Server gemeldeten Fingerprint mit der Angabe seines Hosters.
// Keine Zugangsdaten auf dieser Seite; der Fingerprint ist nicht geheim und wird nur angezeigt.
function startHostKey() {
  $("hkDomain").textContent = info.domain;
  $("hkExpires").textContent = dateText(info.expires_at);
  $("hkFingerprint").textContent = info.host_key_candidate;
  $("hkConfirmText").textContent = info.confirm_text;
  $("hkDom").value = info.domain;
  show("hkForm");
}
async function sendHostKey(decision) {
  const err = (m) => { $("hkErr").textContent = m; $("hkErr").hidden = false; };
  $("hkErr").hidden = true;
  const dom = normDom($("hkDom").value);
  if (dom !== info.domain) return err(tr(`Die Domain muss genau ${info.domain} lauten.`, "domain", info.domain));
  if (decision === "confirm" && !$("hkConsent").checked) return err(tr("Bitte bestätigen Sie, dass Sie den Fingerprint verglichen haben.", "hkConsent"));
  for (const b of ["hkYes", "hkNo"]) $(b).disabled = true;
  const r = await api({ op: "submit", token, purpose: "host_key_confirmation", access_domain: dom, decision, host_key: info.host_key_candidate, consent: decision === "confirm" })
    .catch(() => ({ ok: false, body: {} }));
  if (!r.ok) { for (const b of ["hkYes", "hkNo"]) $(b).disabled = false; return err(VI ? VI_ERR.send : r.body?.error || "Übermittlung fehlgeschlagen. Bitte erneut versuchen."); }
  if (decision === "reject") $("hkDoneMsg").textContent = tr("Danke für den Hinweis – wir verbinden uns NICHT und melden uns persönlich bei Ihnen. Dieser Link ist jetzt ungültig.", "hkReject");
  show("hkDone");
}
$("hkForm").addEventListener("submit", (ev) => { ev.preventDefault(); sendHostKey("confirm"); });
$("hkNo").addEventListener("click", () => sendHostKey("reject"));

start();
