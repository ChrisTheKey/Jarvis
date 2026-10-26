// TF-JARVIS-024: sichere, serverseitig gebundene Erstmail-Vorschau.
// Dieses Modul erzeugt keinen Versand und führt keine Reparatur aus.
import crypto from "node:crypto";
import { evaluateSwissEmailPermission } from "./email-permission.js";
import { paymentLinkFor } from "./payment-links.js";

export const SALES_INTAKE_SUBJECT = "Ihre Webseite – festgestellte Probleme und mögliche Lösungen";
export const SALES_INTAKE_SCOPE = "Website-Analyse und Website-Reparatur";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
