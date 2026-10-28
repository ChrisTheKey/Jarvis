// TF-JARVIS-024: sichere, serverseitig gebundene Erstmail-Vorschau.
// Dieses Modul erzeugt keinen Versand und führt keine Reparatur aus.
import crypto from "node:crypto";
import { accessLink, newIntakeToken } from "./access-token.js";
import { evaluateSwissEmailPermission } from "./email-permission.js";
import { paymentLinkFor, testPaymentLinkUrl } from "./payment-links.js";

export { newIntakeToken } from "./access-token.js";

export const SALES_INTAKE_SUBJECT = "Ihre Webseite – festgestellte Probleme und mögliche Lösungen";
export const SALES_INTAKE_SCOPE = "Website-Analyse und Website-Reparatur";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SALES_TEST_PAYMENT_LINKS = Object.freeze({
  payment150: "https://buy.stripe.com/test_dRm3cw5A5fo3caR9ov7Re00",
  payment480: "https://buy.stripe.com/test_7sY00k5A54JpcaR1W37Re01",
});
export const SALES_DIRECT_OFFERS = Object.freeze({
  CHF150: Object.freeze({ offer: "CHF150", kind: "CHECK", offer_class: "REPAIR_CHECK_150", price: 150, order_key: "order150Id", payment_key: "payment150", label: "Check & Anleitung" }),
  CHF480: Object.freeze({ offer: "CHF480", kind: "FIX", offer_class: "REPAIR_FIX_500", price: 480, order_key: "order480Id", payment_key: "payment480", label: "Check & Reparatur" }),
});
const clean = (v) => String(v ?? "").trim();
const domainOf = (lead) => clean(lead.domain || lead.website).replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
const findingsOf = (lead) => (Array.isArray(lead.errors?.items) ? lead.errors.items : Array.isArray(lead.websiteIssues) ? lead.websiteIssues : [])
  .filter((x) => x && typeof x === "object" && clean(x.text || x.description || x.message))
  .slice(0, 3)
  .map((x) => clean(x.text || x.description || x.message));
const surnameOf = (lead) => clean(lead.last_name || lead.lastName || lead.contact_last_name || lead.contact?.last_name);

export function salesOrderRefs(leadId, now = new Date()) {
  const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
  const hex = crypto.createHash("sha256").update(`${leadId}:${day}`).digest("hex");
  return { order150Id: `CA150-${day}-${hex.slice(0, 6)}`, order480Id: `RF480-${day}-${hex.slice(6, 12)}` };
}

export function salesVaultLink({ origin, leadId, orderId, secret } = {}) {
  if (!/^https:\/\//i.test(String(origin || "")) || !clean(secret) || !clean(leadId) || !clean(orderId)) return null;
  const token = crypto.createHmac("sha256", String(secret)).update(`${leadId}:${orderId}`).digest("base64url");
  return `${String(origin).replace(/\/+$/, "")}/access.html#t=${encodeURIComponent(token)}`;
}

export function salesIntakeEligibility(lead, { now = new Date() } = {}) {
  if (!lead || !clean(lead.lead_id)) return { ok: false, code: "INVALID_LEAD", reason: "Lead-ID fehlt." };
  if (lead.do_not_contact || lead.opt_out || lead.suppressed || String(lead.status || "").toLowerCase() === "do_not_contact") {
    return { ok: false, code: "CONTACT_BLOCKED", reason: "Kontakt ist durch DNC, Opt-out oder Suppression gesperrt." };
  }
  const email = clean(lead.email || lead.business_email).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, code: "NO_EMAIL", reason: "Keine gültige Kunden-E-Mail-Adresse vorhanden." };
  const findings = findingsOf(lead);
  if (!findings.length) return { ok: false, code: "NO_CONFIRMED_FINDINGS", reason: "Es liegen keine bestätigten Audit-Probleme für die Vorschau vor." };
  const permission = evaluateSwissEmailPermission({ ...lead, email }, { type: "SOLICITED_RESPONSE", recipient: email, scope: SALES_INTAKE_SCOPE }, now);
  if (!permission.allowed) return { ok: false, code: "NO_CONTACT_PERMISSION", reason: "Keine dokumentierte Kontaktberechtigung für diese Nachricht.", permission };
  return { ok: true, email, findings, permission, domain: domainOf(lead), surname: surnameOf(lead) };
}

// TF-JARVIS-024: Direkter, bis zur separaten Produktionsfreigabe ausschliesslich synthetischer Sandbox-Versand.
// Der Token kommt aus dem bestehenden Access-Intake-Mechanismus. Im Bundle wird später nur sein Hash persistiert;
// der Klartext bleibt im URL-Fragment der Mail und wird von HTTP nie übertragen.
export function buildSalesIntakeMail({ lead, order150Id, order480Id, offer = null, accessToken, accessExpiresAt, accessOrigin, sandbox = false, now = new Date() } = {}) {
  const eligible = salesIntakeEligibility(lead, { now });
  if (!eligible.ok) return eligible;
  if (!sandbox) return { ok: false, code: "SANDBOX_ONLY", reason: "Der direkte Erstmail-Versand ist bis zur Produktionsfreigabe nur im Sandbox-Modus zulässig." };
  const website = clean(lead.website);
  if (!/^https:\/\/[^\s]+$/i.test(website)) return { ok: false, code: "MISSING_WEBSITE", reason: "Für die Erstmail ist keine gültige Website des ausgewählten Leads vorhanden." };
  const exp = Date.parse(String(accessExpiresAt || ""));
  if (!TOKEN_RE.test(String(accessToken || "")) || !Number.isFinite(exp)) return { ok: false, code: "ACCESS_LINK_UNAVAILABLE", reason: "Der individuelle Zugangstresor-Link konnte nicht sicher erzeugt werden." };
  if (exp <= +now) return { ok: false, code: "ACCESS_LINK_EXPIRED", reason: "Der individuelle Zugangstresor-Link ist abgelaufen." };
  if (!/^https:\/\/[^\s]+$/i.test(String(accessOrigin || ""))) return { ok: false, code: "ACCESS_LINK_UNAVAILABLE", reason: "Die sichere Herkunft des Zugangstresor-Links fehlt." };
  const expiresAt = new Date(exp).toISOString();
  const access = accessLink(accessOrigin, accessToken, "de-CH");
  const link150 = testPaymentLinkUrl(SALES_TEST_PAYMENT_LINKS.payment150, { orderId: order150Id, email: eligible.email });
  const link480 = testPaymentLinkUrl(SALES_TEST_PAYMENT_LINKS.payment480, { orderId: order480Id, email: eligible.email });
  if (!link150 || !link480 || !access) return { ok: false, code: "LINKS_UNAVAILABLE", reason: "Sandbox-Zahlungs- oder Zugangstresorlink konnte nicht sicher erzeugt werden." };
  const selected = offer && SALES_DIRECT_OFFERS[offer];
  if (offer && !selected) return { ok: false, code: "UNSUPPORTED_OFFER", reason: "Das ausgewählte Paket ist nicht zulässig." };
  if (selected) {
    const orderId = selected.order_key === "order150Id" ? order150Id : order480Id;
    const payment = selected.payment_key === "payment150" ? link150 : link480;
    const body = [
      "Guten Tag", "", "Vielen Dank für Ihr Vertrauen.", "",
      `Wie besprochen wurde das Paket ${selected.label} für CHF ${selected.price}.– für Ihre Website ${website} vorbereitet.`, "",
      "Für die sichere Abwicklung verwenden Sie bitte den folgenden Stripe-Sandbox-Testlink (keine echte Zahlung):", "", payment, "",
      "Für den technischen Zugang verwenden Sie bitte ausschliesslich den folgenden temporären, sicheren Link (keine Passwörter per E-Mail):", "", access, "",
      `Die Auftragsreferenz lautet ${orderId}.`, "",
      "Freundliche Grüsse", "", "Christoph Kälin", "", "Helvetic Webdesign",
    ].join("\n");
    const mail = { recipient: eligible.email, subject: SALES_INTAKE_SUBJECT, body, links: { payment, access }, lead_id: lead.lead_id,
      offer: selected.offer, offer_class: selected.offer_class, price: selected.price, order_id: orderId, access_expires_at: expiresAt, legal_basis: eligible.permission.legal_basis };
    const preview_ref = crypto.createHash("sha256").update(JSON.stringify(mail)).digest("hex");
    return { ok: true, preview_ref, mail };
  }
  const body = [
    "Guten Tag",
    "",
    "Vielen Dank für Ihr Vertrauen.",
    "",
    "Um die in Auftrag gegebene Dienstleistung zu bestätigen, folgen Sie dem temporären & sicheren Link zum Zugangsdaten-Tresor und zur Zahlungsabwicklung.",
    "",
    `Damit ich die Reparatur Ihrer Website ${website} sauber durchführen kann, brauche ich die folgenden zwei Dinge:`,
    "",
    `1. Einen temporären, sicheren Zugang über Ihren persönlichen, nur für diesen Auftrag gültigen Link (gültig bis ${expiresAt}, nur einmal verwendbar):`,
    "",
    access,
    "",
    "Bitte senden Sie keine Passwörter oder Zugangsdaten per E-Mail.",
    "",
    "Verwenden Sie dafür ausschliesslich den sicheren Link.",
    "",
    "Ihre Website läuft über [Name des Anbieters]. Bitte laden Sie mich mit dieser E-Mail-Adresse zu Ihrer Webseite bei Netlify ein, damit ich darauf zugreifen kann.",
    "",
    "Im Formular bestätigen Sie nur noch den Namen der Seite und die vereinbarte Dienstleistung.",
    "",
    "Vor der ersten Änderung erstelle ich eine vollständige Sicherung Ihrer Website; zum Abschluss erhalten Sie einen ausführlichen Bericht.",
    "",
    "2. Unsere zwei Angebote:",
    "",
    "1. Webseiten-Check & Anleitung – CHF 150.–",
    "",
    "Technische Prüfung mit Problemübersicht und Anleitung zur Behebung.",
    "",
    "Stripe-Sandbox-Testlink (keine echte Zahlung):",
    "",
    link150,
    "",
    "2. Webseiten-Check & Reparatur – CHF 480.–",
    "",
    "Technische Prüfung und Behebung der Probleme.",
    "",
    "Stripe-Sandbox-Testlink (keine echte Zahlung):",
    "",
    link480,
    "",
    "Freundliche Grüsse",
    "",
    "Christoph Kälin",
    "",
    "Helvetic Webdesign",
  ].join("\n");
  const mail = { recipient: eligible.email, subject: SALES_INTAKE_SUBJECT, body, links: { payment150: link150, payment480: link480, access }, lead_id: lead.lead_id,
    order150_id: order150Id, order480_id: order480Id, access_expires_at: expiresAt, legal_basis: eligible.permission.legal_basis };
  const preview_ref = crypto.createHash("sha256").update(JSON.stringify(mail)).digest("hex");
  return { ok: true, preview_ref, mail };
}

export function buildSalesIntakePreview({ lead, order150Id, order480Id, vaultLink, now = new Date() } = {}) {
  const eligible = salesIntakeEligibility(lead, { now });
  if (!eligible.ok) return eligible;
  const link150 = paymentLinkFor("REPAIR_CHECK_150", { orderId: order150Id, email: eligible.email });
  const link480 = paymentLinkFor("REPAIR_FIX_500", { orderId: order480Id, email: eligible.email });
  if (!link150 || !link480 || !/^https:\/\//i.test(String(vaultLink || ""))) {
    return { ok: false, code: "LINKS_UNAVAILABLE", reason: "Zahlungs- oder Tresorlink konnte nicht sicher erzeugt werden." };
  }
  const greeting = eligible.surname ? `Guten Tag Frau/Herr ${eligible.surname}` : "Guten Tag";
  const body = `${greeting}\n\nVielen Dank für das Telefongespräch.\n\nWie besprochen haben wir Ihre Webseite ${eligible.domain} technisch überprüft.\n\nDabei haben wir folgende Probleme festgestellt:\n\n${eligible.findings.map((x) => `- ${x}`).join("\n")}\n\nDiese Probleme können die Funktionalität, Benutzerfreundlichkeit oder Erreichbarkeit Ihrer Webseite beeinträchtigen.\n\nWir bieten Ihnen zwei Möglichkeiten:\n\nOption 1 – CHF 150: Technische Analyse und Reparaturanleitung\nSie erhalten eine verständliche Übersicht der festgestellten Probleme sowie konkrete Anleitungen, wie diese auf Ihrem Hostinganbieter und Ihrem Webseiten-System behoben werden können.\n\n${link150}\n\nOption 2 – CHF 480: Technische Analyse und Reparatur\nWir übernehmen die vereinbarten technischen Reparaturen Ihrer Webseite. Nach der Überprüfung und Bereitstellung der erforderlichen Zugänge führen wir die möglichen Reparaturen durch und kontrollieren anschliessend das Ergebnis.\n\n${link480}\n\nGeschützter Kundenzugang\nFalls Sie die Reparatur durch uns wünschen, können Sie die notwendigen Zugangsinformationen über unseren geschützten Kundentresor übermitteln.\n\n${vaultLink}\n\nBitte senden Sie uns keine Passwörter per E-Mail.\n\nBei Fragen können Sie direkt auf diese Nachricht antworten.\n\nFreundliche Grüsse\n\nHelvetic Webdesign\nWebseiten-Service`;
  const preview = { recipient: eligible.email, subject: SALES_INTAKE_SUBJECT, body, links: { payment150: link150, payment480: link480, vault: vaultLink }, lead_id: lead.lead_id, order150_id: order150Id, order480_id: order480Id, legal_basis: eligible.permission.legal_basis, generated_at: new Date(now).toISOString() };
  const preview_ref = crypto.createHash("sha256").update(JSON.stringify({ ...preview, generated_at: null })).digest("hex");
  return { ok: true, preview_ref, preview };
}
