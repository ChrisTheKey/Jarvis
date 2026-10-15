// Vietnamesische Kundentexte für VN-Aufträge (TF-064) – ohne Abhängigkeiten ausser pricing.js/sender-profiles.js.
// Gleicher fachlicher Inhalt wie die Schweizer Texte (check-150-workflow.js / repair-workflow.js), vollständig auf Vietnamesisch,
// Beträge nur in VND. Firmennamen, Domains, URLs und technische Pfade werden nie übersetzt. Keine zusätzlichen Leistungsversprechen.
import { offerFor, formatMoney } from "./pricing.js";
import { VN_SIGNATURE } from "./sender-profiles.js";
import { contentQuestionLines, NO_PASSWORD_VI } from "./onboarding-core.js";

export const isVnOrder = (o) => o?.market === "VN";
const CHECK = offerFor("VN", "CHECK"), FIX = offerFor("VN", "FIX");
export const VN_CHECK_NAME = CHECK.name_vi, VN_FIX_NAME = FIX.name_vi;
const greet = (o) => `Kính gửi ${o.contact_name || o.company || "anh/chị"},`;
const vnDate = (iso, opts = { dateStyle: "long", timeStyle: "short" }) => {
  try { return new Intl.DateTimeFormat("vi-VN", { ...opts, timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso)); } catch { return String(iso).slice(0, 16).replace("T", " "); }
};

// ---------- Seiten / Befunde ----------
export function pageLabelVi(u) {
  let p; try { p = new URL(u).pathname; } catch { return "trang liên quan"; }
  const seg = p.split("/").filter(Boolean).pop() || "";
  const name = decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[-_]+/g, " ").trim();
  return name ? `trang «${name.charAt(0).toUpperCase() + name.slice(1)}»` : "trang chủ";
}
const cleanLabel = (l) => (typeof l === "string" && l.trim() && l.trim().length <= 40 && !/https?:|www\.|[<>{}«»]/i.test(l) ? l.trim() : null);
// Kundentitel + Auswirkung je Befund-Typ (wie CUSTOMER_TEXT in swiss-repair.js, auf Vietnamesisch).
export function vnFindingText(type, { page = null, label = null, location = null } = {}) {
  const pg = pageLabelVi(page || ""), area = location ? `«${location}»` : "";
  switch (type) {
    case "contact_page_broken": return { title: "Liên kết tới trang liên hệ của anh/chị dẫn tới trang lỗi", impact: "Vì vậy khách truy cập không thể liên hệ với anh/chị qua trang liên hệ như mong muốn." };
    case "broken_link": return { title: `Trên ${pg}, liên kết ${cleanLabel(label) ? `«${cleanLabel(label)}» ` : ""}dẫn tới trang lỗi`, impact: "Khách truy cập bị đưa tới trang lỗi thay vì nội dung mong muốn." };
    case "broken_image": return { title: `Trên ${pg}, một hình ảnh không hiển thị`, impact: "Tại vị trí này, khách truy cập chỉ thấy một khoảng trống." };
    case "broken_mailto": return { title: `Trên ${pg}, một liên kết email không hoạt động`, impact: "Người bấm vào liên kết sẽ không thể gửi email cho anh/chị." };
    case "https_certificate": return { title: "Khi mở website, trình duyệt hiện cảnh báo trước", impact: "Khách truy cập phải bỏ qua cảnh báo này mới xem được trang." };
    case "redirect_loop": return { title: "Website không tải được khi truy cập, trình duyệt hiện thông báo lỗi", impact: "Khách truy cập hoàn toàn không xem được trang." };
    case "mobile_text_overlap": return { title: `Trên điện thoại, chữ trong khu vực ${area} bị chồng lên nhau`, impact: "Nội dung vì thế khó đọc." };
    case "mobile_content_cut_off": return { title: `Trên điện thoại, khu vực ${area} bị cắt`, impact: "Khách truy cập không thấy toàn bộ nội dung." };
    case "contact_form_broken": return { title: "Biểu mẫu liên hệ hiện không gửi được", impact: "Khách truy cập không thể gửi tin nhắn cho anh/chị qua biểu mẫu." };
    case "button_broken": return { title: `Nút ${area} hiện không hoạt động`, impact: "Khách truy cập không thể tiếp tục tại vị trí này." };
    case "visible_layout_error": return { title: `Trong khu vực ${area}, trang hiển thị bị lệch`, impact: "Nội dung tại vị trí này khó theo dõi." };
    default: return { title: "Một vấn đề kỹ thuật trên website", impact: "Vấn đề này có thể ảnh hưởng tới khách truy cập." };
  }
}

// ---------- Anleitung je Befund (wie instructionsFor, anbieterneutral, nichts erfunden) ----------
const DIFF = { easy: "Dễ", medium: "Trung bình", expert: "Nên nhờ chuyên gia" };
const openStep = (stackType, page) => stackType === "wordpress"
  ? `Đăng nhập vào trang quản trị WordPress của website và mở ${page} để chỉnh sửa.`
  : stackType === "static" || stackType === "github_netlify"
    ? `Mở tệp HTML tương ứng với ${page} trong chương trình chỉnh sửa anh/chị thường dùng.`
    : `Trong hệ thống website của anh/chị, mở phần chỉnh sửa ${page}.`;
const publishStep = (stackType) => stackType === "static" || stackType === "github_netlify"
  ? "Lưu tệp và tải website lên như thường lệ, hoặc xuất bản thay đổi."
  : "Lưu và xuất bản thay đổi.";
const VERIFY_BOTH = (what) => ["Mở lại website và tải lại trang một lần.", `${what} – một lần trên máy tính và một lần trên điện thoại.`];
export function vnInstructionsFor(finding, stackType = "other") {
  const t = finding.primary_type, page = finding.page_label, area = finding.area ? `«${finding.area}»` : null;
  const mk = (fix_summary, steps, verify, difficulty) => ({ fix_summary, steps, verification_steps: verify, difficulty, expert_recommended: difficulty === DIFF.expert });
  switch (t) {
    case "broken_link":
    case "contact_page_broken":
      return mk(t === "contact_page_broken" ? "Liên kết tới trang liên hệ đang trỏ tới một địa chỉ không còn tồn tại – cần trỏ lại đúng trang liên hệ."
        : "Liên kết đang trỏ tới một địa chỉ không còn tồn tại – cần trỏ lại đúng trang hiện có.",
      [openStep(stackType, page), finding.label ? `Tìm liên kết «${finding.label}».` : "Tìm liên kết bị lỗi (hiện đang dẫn tới trang lỗi).",
        "Kiểm tra địa chỉ đích của liên kết.", t === "contact_page_broken" ? "Nhập đúng trang liên hệ thực tế của anh/chị làm địa chỉ đích." : "Nhập đúng trang hiện có làm địa chỉ đích.",
        publishStep(stackType)],
      VERIFY_BOTH("Bấm vào liên kết và kiểm tra xem có mở đúng trang không"), DIFF.easy);
    case "broken_image":
      return mk("Tệp hình ảnh không còn ở vị trí đã khai báo – cần chọn lại hoặc tải lại hình ảnh.",
        [openStep(stackType, page), "Tìm vị trí bị thiếu hình (hiện đang là một khoảng trống).", "Tải lại hình ảnh mong muốn hoặc chọn lại từ thư viện ảnh.", publishStep(stackType)],
        VERIFY_BOTH("Kiểm tra xem hình ảnh đã hiển thị lại ở vị trí này chưa"), DIFF.easy);
    case "broken_mailto":
      return mk("Liên kết email đang chứa địa chỉ không đầy đủ hoặc sai – cần sửa lại.",
        [openStep(stackType, page), "Tìm liên kết email (ví dụ địa chỉ email trong phần liên hệ).", "Kiểm tra và sửa lại thành địa chỉ email đúng, đầy đủ của anh/chị.", publishStep(stackType)],
        VERIFY_BOTH("Bấm vào liên kết email và kiểm tra xem thư mới có mở tới đúng địa chỉ không"), DIFF.easy);
    case "contact_form_broken":
      return mk("Biểu mẫu liên hệ hiện không nhận tin nhắn – thường do địa chỉ nhận hoặc cài đặt của biểu mẫu.",
        [openStep(stackType, page), "Mở phần cài đặt của biểu mẫu liên hệ.", "Kiểm tra địa chỉ email nhận và các trường bắt buộc.", "Sửa các cài đặt bị sai.", publishStep(stackType),
          "Tự gửi một tin nhắn thử qua biểu mẫu."],
        ["Tự điền và gửi biểu mẫu một lần.", "Kiểm tra xem tin nhắn thử có đến hộp thư không – trên máy tính và trên điện thoại."], DIFF.medium);
    case "button_broken":
      return mk(`Nút ${area || ""} hiện chưa có liên kết hoạt động – cần sửa lại đích của nút.`.replace("  ", " "),
        [openStep(stackType, page), area ? `Chọn nút ${area}.` : "Chọn nút bị lỗi.", "Kiểm tra liên kết hoặc hành động đã khai báo cho nút.", "Nhập đúng đích.", publishStep(stackType)],
        VERIFY_BOTH("Bấm vào nút và kiểm tra xem hành động mong muốn có được thực hiện không"), DIFF.easy);
    case "mobile_text_overlap":
    case "mobile_content_cut_off":
    case "visible_layout_error":
      return mk(`Hiển thị trong khu vực ${area || "liên quan"} chưa đúng – cần điều chỉnh khoảng cách hoặc kích thước của khu vực này cho màn hình hẹp.`,
        [openStep(stackType, page), area ? `Chọn khu vực ${area}.` : "Chọn khu vực bị lỗi.",
          "Mở chế độ xem trước cho điện thoại (nếu có) hoặc thu nhỏ cửa sổ trình duyệt để thấy lỗi.",
          "Điều chỉnh khoảng cách, cỡ chữ hoặc độ rộng của khu vực cho đến khi nội dung hiển thị đầy đủ, không bị chồng lên nhau.", publishStep(stackType)],
        ["Mở trang trên điện thoại và kiểm tra khu vực này.", "Kiểm tra thêm trên máy tính với cửa sổ thu nhỏ xem mọi thứ có hiển thị đầy đủ không."], DIFF.medium);
    case "https_certificate":
      return mk("Việc kiểm tra bảo mật kết nối thất bại – chứng chỉ bảo mật của website cần được gia hạn tại nhà cung cấp hosting.",
        ["Liên hệ nhà cung cấp hosting (nơi lưu trữ website của anh/chị).", "Đề nghị gia hạn chứng chỉ bảo mật của website và bật tự động gia hạn.",
          "Yêu cầu xác nhận rằng website sau đó truy cập được mà không còn cảnh báo."],
        ["Mở website trong một cửa sổ trình duyệt mới.", "Kiểm tra xem trang có tải mà không có cảnh báo không – trên máy tính và trên điện thoại."], DIFF.expert);
    case "redirect_loop":
      return mk("Website chuyển hướng khách truy cập vòng lặp nên không tải được – cần sửa cài đặt chuyển hướng tại hosting hoặc trong cấu hình website.",
        ["Liên hệ nhà cung cấp hosting hoặc người quản lý website của anh/chị.",
          "Mô tả rằng website không tải được và trình duyệt báo lỗi do có quá nhiều lần chuyển hướng.", "Đề nghị kiểm tra và sửa lại cài đặt chuyển hướng."],
        ["Mở website trong một cửa sổ trình duyệt mới.", "Kiểm tra xem trang chủ có tải bình thường không – trên máy tính và trên điện thoại."], DIFF.expert);
    default:
      return mk("Với mục này, chúng tôi khuyên nên nhờ chuyên gia thực hiện – không thể mô tả chắc chắn bằng các bước chung.",
        [`Cho chuyên gia xem mục này trên ${page}.`, "Đề nghị kiểm tra nguyên nhân và thực hiện chỉnh sửa nhỏ nhất cần thiết."],
        VERIFY_BOTH("Kiểm tra lại vị trí liên quan"), DIFF.expert);
  }
}

// ---------- Check & Anleitung (VN CHECK) ----------
export function buildVnCheckReport(order, { now = new Date(), summary }) {
  const f = order.findings || [];
  const expert = f.some((x) => x.expert_recommended);
  return [
    VN_CHECK_NAME,
    "Kết quả kiểm tra website của anh/chị",
    "",
    ...(order.company ? [`Công ty: ${order.company}`] : []),
    `Website: ${order.domain}`,
    `Ngày kiểm tra: ${(order.audit_completed_at || now.toISOString()).slice(0, 10)}`,
    "",
    "Chúng tôi đã kiểm tra trang chủ và các trang con được liên kết từ đó: khả năng truy cập, liên kết, điều hướng, hình ảnh,",
    "phương thức liên hệ và các lỗi hiển thị nhìn thấy được – giống như một khách truy cập dùng trình duyệt, không can thiệp vào website.",
    "",
    f.length ? `Tóm tắt: ${summary.total} vấn đề cần lưu ý (nghiêm trọng ${summary.critical}, cao ${summary.high}, trung bình ${summary.medium}, thấp ${summary.low}).`
      : "Tóm tắt: Không phát hiện vấn đề đáng kể nào mà khách truy cập có thể thấy.",
    "",
    ...f.flatMap((x, i) => [
      `VẤN ĐỀ ${i + 1} — ${x.customer_title}`,
      `Vị trí: ${x.location}`,
      `Khách truy cập gặp phải: ${x.customer_impact}`,
      `Cách khắc phục: ${x.fix_summary}`,
      `Mức độ: ${x.difficulty}`,
      "Các bước:",
      ...x.steps.map((s, n) => `${n + 1}. ${s}`),
      "Kiểm tra lại sau đó:",
      ...x.verification_steps.map((s) => `• ${s}`),
      "",
    ]),
    "Hướng dẫn này dựa trên các vấn đề thực tế được phát hiện trong lần kiểm tra website.",
    ...(expert ? ["", `Nếu anh/chị không muốn tự sửa, chúng tôi có thể thực hiện các công việc thuộc gói «${VN_FIX_NAME}» với giá cố định ${formatMoney(FIX.price, "VND")}.`] : []),
  ].join("\n");
}
export function buildVnCheckDeliveryDraft(order, reportText, inline) {
  const f = order.findings || [];
  const top = f.slice(0, 3).map((x) => `• ${x.customer_title}`);
  const body = [
    greet(order),
    "",
    "Cảm ơn anh/chị đã đặt dịch vụ.",
    "",
    `Chúng tôi đã kiểm tra toàn bộ website ${order.domain}.`,
    f.length ? `Chúng tôi đã tìm thấy ${f.length} vấn đề cần lưu ý.` : "Chúng tôi không tìm thấy vấn đề đáng kể nào mà khách truy cập có thể thấy.",
    ...(top.length ? ["", "Các vấn đề quan trọng nhất:", "", ...top] : []),
    "",
    "Trong báo cáo đầy đủ, với mỗi vấn đề anh/chị sẽ thấy:",
    "- vấn đề nằm ở đâu",
    "- vấn đề gây ảnh hưởng gì",
    "- cách khắc phục",
    "- hướng dẫn từng bước",
    "- cách kiểm tra lại sau khi sửa",
    "",
    inline ? reportText : "Báo cáo đầy đủ kèm toàn bộ hướng dẫn nằm trong tệp đính kèm của email này.",
    "",
    VN_SIGNATURE,
  ].join("\n");
  return { subject: `Kết quả kiểm tra website & hướng dẫn của anh/chị – ${order.domain}`, body, inline };
}

// ---------- Check & Reparatur (VN FIX): Zugang, Host-Key, Bericht, Liefermail ----------
export function buildVnAccessRequestMail(order, { link = null, expires_at = null, onboarding = false } = {}) {
  const until = expires_at ? vnDate(expires_at) : null;
  if (onboarding) {
    // TF-066: Onboarding-Start (§14) – vollständig Vietnamesisch: sicherer Link, keine Passwörter per E-Mail, Inhaltsfrage.
    const [q, ...rest] = contentQuestionLines("vi-VN");
    const body = [
      greet(order),
      "",
      `Cảm ơn anh/chị – chúng tôi đã nhận được khoản thanh toán đầu tiên cho dịch vụ «${VN_FIX_NAME}», mức thanh toán cần thiết đã đạt.`,
      "",
      `Để sửa lỗi website ${order.domain} một cách chính xác, chúng tôi cần thêm hai điều:`,
      "",
      "1. Một quyền truy cập tạm thời và an toàn qua đường liên kết cá nhân, chỉ có hiệu lực cho đơn hàng này" + (until ? ` (có hiệu lực đến ${until}, chỉ dùng được một lần):` : " (chỉ dùng được một lần):"),
      link || "(đường liên kết sẽ được gửi riêng)",
      "",
      "Quan trọng: Vui lòng KHÔNG gửi mật khẩu qua email. " + NO_PASSWORD_VI,
      "An toàn nhất: mời chúng tôi làm cộng tác viên hoặc tạo một tài khoản tạm thời chỉ với các quyền cần thiết (không dùng mật khẩu chính). Trong biểu mẫu, anh/chị cũng xác nhận đồng ý cho việc sửa lỗi đã thỏa thuận.",
      "",
      `2. ${q}`,
      ...rest,
      "",
      "Trước thay đổi đầu tiên, chúng tôi sẽ sao lưu toàn bộ website; khi hoàn tất, anh/chị sẽ nhận được một báo cáo dễ hiểu.",
      "",
      VN_SIGNATURE,
    ].join("\n");
    return { subject: `Sửa lỗi website ${order.domain} – quyền truy cập an toàn và yêu cầu của anh/chị`, body };
  }
  const body = [
    greet(order),
    "",
    `Cảm ơn anh/chị – chúng tôi đã nhận được khoản thanh toán đầu tiên cho dịch vụ «${VN_FIX_NAME}».`,
    "",
    `Để sửa lỗi website ${order.domain} như đã thỏa thuận, chúng tôi cần một quyền truy cập tạm thời và an toàn.`,
    "",
    "Quan trọng: Vui lòng KHÔNG gửi mật khẩu qua email – kể cả mã truy cập hoặc khóa bảo mật.",
    "",
    "Vui lòng chỉ sử dụng đường liên kết cá nhân, chỉ có hiệu lực cho đơn hàng này" + (until ? ` (có hiệu lực đến ${until}, chỉ dùng được một lần):` : " (chỉ dùng được một lần):"),
    link || "(đường liên kết sẽ được gửi riêng)",
    "",
    "An toàn nhất, theo thứ tự sau:",
    "- Mời chúng tôi làm cộng tác viên trong hệ thống website hoặc tại nhà cung cấp hosting của anh/chị – khi đó không cần mật khẩu.",
    "- Hoặc tạo một tài khoản tạm thời chỉ với các quyền cần thiết (vui lòng không dùng mật khẩu chính).",
    "- Hoặc nhờ nhà cung cấp hosting cấp cho chúng tôi một quyền truy cập riêng, có thời hạn.",
    "",
    "Trong biểu mẫu, anh/chị cũng xác nhận rằng mình có quyền cung cấp quyền truy cập và đồng ý cho việc sửa lỗi đã thỏa thuận.",
    "",
    "Sau đó, chúng tôi sẽ sao lưu toàn bộ website trước rồi mới bắt đầu sửa lỗi. Khi hoàn tất, anh/chị sẽ nhận được một báo cáo",
    "dễ hiểu; sau đó anh/chị có thể xóa quyền truy cập tạm thời.",
    "",
    VN_SIGNATURE,
  ].join("\n");
  return { subject: `Sửa lỗi website ${order.domain} – cần quyền truy cập an toàn`, body };
}
export function buildVnHostKeyConfirmationMail(order, { link = null, expires_at = null } = {}) {
  const until = expires_at ? vnDate(expires_at) : null;
  const body = [
    greet(order),
    "",
    `Cảm ơn anh/chị đã cung cấp quyền truy cập cho website ${order.domain}.`,
    "",
    "Trước khi kết nối tới máy chủ của anh/chị, chúng tôi kiểm tra dấu hiệu bảo mật kỹ thuật số của máy chủ (gọi là fingerprint).",
    "Nhờ vậy, chúng tôi chắc chắn đang kết nối đúng máy chủ của anh/chị chứ không phải một máy chủ khác.",
    "",
    "Vui lòng mở đường liên kết cá nhân của anh/chị" + (until ? ` (có hiệu lực đến ${until}, chỉ dùng được một lần):` : " (chỉ dùng được một lần):"),
    link || "(đường liên kết sẽ được gửi riêng)",
    "",
    "Tại đó anh/chị sẽ thấy dấu hiệu này. Vui lòng so sánh với thông tin từ nhà cung cấp hosting (thường nằm trong khu vực khách hàng",
    "ở mục «SSH» hoặc «SFTP» – bộ phận hỗ trợ của nhà cung cấp cũng có thể cho anh/chị biết) và xác nhận xem có trùng khớp không.",
    "",
    "Cho đến khi anh/chị xác nhận, chúng tôi sẽ không kết nối bằng thông tin truy cập của anh/chị. Vui lòng không gửi mật khẩu qua email.",
    "",
    VN_SIGNATURE,
  ].join("\n");
  return { subject: `Sửa lỗi website ${order.domain} – xác nhận bảo mật ngắn`, body };
}
// Bericht ohne Signatur/URLs (läuft durch reportUnsafe); manualOpen/fixed/openForReview wie im Schweizer Bericht.
export function buildVnRepairReport(order, { now = new Date(), fixed, openForReview, relevant, manualOpen }) {
  // TF-066: bestätigte Inhaltsänderung des Kunden mit eigenem vietnamesischem Text.
  const line = (i) => `• ${i.type === "customer_content_change" && i.customer_text_vi ? i.customer_text_vi : vnFindingText(i.type, { page: i.page, label: i.label, location: i.location }).title}`;
  const g = order.browser_gate;
  return [
    `Kiểm tra website – Báo cáo hoàn tất «${VN_FIX_NAME}» (${formatMoney(FIX.price, "VND")})`,
    "",
    `Website: ${order.domain}`,
    `Ngày: ${(order.retest?.tested_at || now.toISOString()).slice(0, 10)}`,
    "",
    "Nội dung đã kiểm tra:",
    "Trang chủ và các trang con được liên kết từ trang chủ – liên kết, điều hướng, hình ảnh, phần liên hệ cũng như hiển thị trên điện thoại và máy tính.",
    "",
    `Số vấn đề cần lưu ý được tìm thấy: ${relevant}`,
    "",
    ...(manualOpen ? [fixed.length ? "Các lỗi có thể sửa tự động đã được khắc phục. Một số mục khác cần được kiểm tra thủ công."
      : "Không có lỗi nào có thể sửa tự động. Các mục được tìm thấy cần được kiểm tra thủ công.", ""] : []),
    fixed.length ? "Đã khắc phục:" : "Không có gì được sửa – không có lỗi nào thuộc phạm vi gói dịch vụ có thể khắc phục tự động.",
    ...fixed.map((i) => `${line(i)} – đã khắc phục và kiểm tra lại.`),
    "",
    ...(openForReview.length ? ["Chưa sửa tự động – cần trao đổi thêm (không bị thay đổi tự động):", ...openForReview.map(line), ""] : []),
    "Kiểm tra cuối cùng:",
    `Máy tính: ${order.retest?.desktop?.ok ? "đã kiểm tra, ổn" : "xem ghi chú"}.`,
    `Điện thoại: ${order.retest?.mobile?.ok ? "đã kiểm tra, ổn" : "xem ghi chú"}.`,
    ...(g?.desktop === "JA" && g?.mobile === "JA" && g?.regression === "KEINE"
      ? ["", "Đã kiểm tra trên máy tính: Có", "Đã kiểm tra trên điện thoại: Có", `Đã kiểm tra điều hướng: ${g.navigation === "JA" ? "Có" : "Không"}`, "Không phát hiện lỗi hiển thị mới đáng kể."] : []),
    ...(order.retest?.http_ok === true && order.retest?.desktop?.ok && order.retest?.mobile?.ok ? ["Kiểm tra lại sau khi sửa: thành công."] : []),
    "",
    order.deployment?.deployed ? "Các chỉnh sửa đã được áp dụng trên website của anh/chị và đã được kiểm tra lại."
      : order.plan?.length ? "Các chỉnh sửa đã được chuẩn bị và sẽ được áp dụng sau khi trao đổi với anh/chị." : "Website của anh/chị không bị thay đổi.",
    "",
    ...(order.access_intake ? ["Quan trọng: Vui lòng xóa ngay quyền truy cập tạm thời mà anh/chị đã tạo cho đơn hàng này (hoặc đổi mật khẩu). Thông tin truy cập sẽ được chúng tôi xóa khi hoàn tất.", ""] : []),
    "Nếu có câu hỏi, anh/chị chỉ cần trả lời email này.",
  ].join("\n");
}
export function buildVnRepairDeliveryMail(order, { manualOpen }) {
  const body = [
    greet(order),
    "",
    manualOpen
      ? `Đơn hàng «${VN_FIX_NAME}» cho ${order.domain} đã hoàn tất. Các lỗi có thể sửa tự động đã được khắc phục. Một số mục khác cần được kiểm tra thủ công – chi tiết trong báo cáo hoàn tất:`
      : `Đơn hàng «${VN_FIX_NAME}» cho ${order.domain} đã hoàn tất. Đây là báo cáo hoàn tất của anh/chị:`,
    "",
    order.report?.body || "",
    "",
    VN_SIGNATURE,
  ].join("\n");
  return { subject: order.report?.subject || `Kiểm tra website ${order.domain} – Báo cáo hoàn tất`, body };
}
export const vnReportSubject = (order) => `Kiểm tra website ${order.domain} – Báo cáo hoàn tất`;

// ---------- Sicherer Zugang (Formulartexte für access.html, VN) ----------
export const vnConsentText = (domain) => `Tôi xác nhận rằng tôi có quyền cung cấp quyền truy cập này và cho phép Helvetic Webdesign/Jarvis thực hiện việc sửa lỗi đã thỏa thuận trên ${domain} trong phạm vi đơn hàng này.`;
export const vnHostKeyConfirmText = (domain) => `Tôi đã so sánh fingerprint hiển thị với thông tin từ nhà cung cấp hosting cho ${domain} – hoàn toàn trùng khớp.`;
export const VN_REPAIR_SCOPE = `Việc sửa lỗi đã thỏa thuận trong phạm vi đơn hàng «${VN_FIX_NAME}» (${formatMoney(FIX.price, "VND")}) – không mở rộng phạm vi.`;
