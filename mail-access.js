// Mail-Aktionen im CRM je Benutzer (TF-077, TF-077B) – ohne Abhängigkeiten (Netlify-Funktion, Mail-Worker, CRM-Dienst, Tests). Serverseitig:
// die CRM-Sicht eines Verkäufers enthält nie eine Gmail-URL von Chris, und kein Verkäufer bekommt Gmail-Zugang.
//
//   OWNER (chris)              OWNER_GMAIL: eigener Gmail-Entwurf je Lead (draft_url) + E-Mail-Adresse als mailto + VN-Entwurfsaufträge – unverändert
//   giuliano / mario / damiano SERVER_SEND (TF-077B): genau EINE Mail-Aktion je Lead – «E-Mail lossenden» = SEND_PREPARED_LEAD_DRAFT. Der Browser
//                              schickt nur lead_id + draft_ref (Hash der Gmail-Message-ID des aktuellen Jarvis-Entwurfs, nie eine URL); Empfänger,
//                              Betreff und Text kommen ausschliesslich aus CRM bzw. dem vorbereiteten Entwurf. Gesendet wird nur vom Mail-Worker
//                              (bestehende Jarvis-Sendeberechtigung). Kein Gmail-Link, kein Inbox-/Entwurfs-Zugriff, kein freier Versand.
//   Kudoshin                   OWN_MAILBOX hathanhlap261096@gmail.com – nur seine eigene Mailbox. Der einzige Gmail-Zugang von Jarvis (gmail.js,
//                              gmail_token.json) gehört Chris; eine Verbindung für Kudoshins Mailbox existiert nicht → KUDOSHIN_MAILBOX_NOT_CONNECTED:
//                              kein Gmail-Link, kein Entwurf, kein Versand (er liefe sonst über Chris' Gmail), nie ein Fallback auf Chris.
// Kein Passwort, kein OAuth-Secret hier. Die Gmail-Adresse ist kein Secret.
import { VN_SELLER_ID } from "./seller-identity.js";

export const SELLER_MAILBOXES = Object.freeze({ [VN_SELLER_ID]: "hathanhlap261096@gmail.com" });
export const MAIL_MODES = Object.freeze(["OWNER_GMAIL", "SERVER_SEND", "OWN_MAILBOX", "MAIL_ACTIONS_DISABLED"]);
export const SEND_ACTION = "SEND_PREPARED_LEAD_DRAFT";
// Nur diese Verkäufer (CH) dürfen einen vorbereiteten Jarvis-Entwurf über den Server senden lassen.
export const SERVER_SEND_USERS = Object.freeze(["giuliano", "mario", "damiano"]);
// Schutz gegen Massenversand: ein Klick = ein Lead; höchstens so viele Verkäufer-Sendungen je Verkäufer und Kalendertag.
export const SELLER_SEND_DAILY_LIMIT = 40;
export const MAILBOX_CONNECT_PATH = "Eigener Gmail-OAuth-Zugang für diese Mailbox (separate Token-Datei, nie Chris' gmail_token.json) – vom Owner einzurichten; bis dahin keine Jarvis-Entwürfe.";

const notConnected = (userId) => `${String(userId).toUpperCase()}_MAILBOX_NOT_CONNECTED`;
const base = { gmail_drafts: false, mailto: false, draft_requests: false, send_prepared: false };
export function mailAccessFor(actor) {
  if (actor?.role === "OWNER") return { ...base, mode: "OWNER_GMAIL", state: "OWNER_GMAIL", mailbox: null, gmail_drafts: true, mailto: true, draft_requests: true };
  if (actor && SERVER_SEND_USERS.includes(actor.user_id) && ["SALES_MANAGER_CH", "SALES_AGENT_CH"].includes(actor.role))
    return { ...base, mode: "SERVER_SEND", state: SEND_ACTION, mailbox: null, send_prepared: true };
  const mailbox = actor ? SELLER_MAILBOXES[actor.user_id] || null : null;
  // Bewusst KEIN Schalter „verbunden“: Entwürfe/Sendungen laufen allein über Chris' Gmail-Token. Erst ein eigener Weg je Mailbox
  // (eigener Token, eigener Worker-Pfad, Tests) darf das für Verkäufer öffnen – sonst landete alles in Chris' Gmail.
  if (mailbox) return { ...base, mode: "OWN_MAILBOX", state: notConnected(actor.user_id), mailbox, connect_path: MAILBOX_CONNECT_PATH };
  return { ...base, mode: "MAIL_ACTIONS_DISABLED", state: "MAIL_ACTIONS_DISABLED", mailbox: null };
}

// Referenz auf den aktuellen Entwurf eines Leads: FNV-Hash (16 Hex) der Gmail-Message-ID. Ändert sich der Entwurf (Gmail vergibt bei jeder
// Aktualisierung eine neue Message-ID), ändert sich die Referenz – ein alter Klick sendet nie einen neueren Text.
const fnv = (s) => { let h = 0x811c9dc5; for (const ch of String(s)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
export const DRAFT_REF_RE = /^[a-f0-9]{16}$/;
export const draftRef = (messageId) => (typeof messageId === "string" && /^[0-9a-f]{10,24}$/.test(messageId) ? fnv(`a|${messageId}`) + fnv(`b|${messageId}`) : null);
const DRAFT_URL_RE = /^https:\/\/mail\.google\.com\/mail\/u\/0\/#drafts\?compose=([0-9a-f]{10,24})$/;
// Nur ein noch offener Jarvis-Entwurf (draft_status DRAFT) mit E-Mail-Adresse, ohne Sperre, im CH-Markt hat eine sendbare Referenz.
export function draftRefOf(lead) {
  if (!lead || lead.draft_status !== "DRAFT" || !lead.email || lead.do_not_contact || lead.market === "VN") return null;
  const m = DRAFT_URL_RE.exec(String(lead.draft_url || ""));
  return m ? draftRef(m[1]) : null;
}
// Sicht eines Leads für diesen Benutzer: ohne Gmail-Recht nie eine Gmail-Entwurfs-URL (auch nicht im DOM/API). SERVER_SEND bekommt
// stattdessen nur die Referenz des vorbereiteten Entwurfs.
export function leadForMail(lead, access) {
  if (!lead || access?.gmail_drafts) return lead;
  const out = { ...lead, draft_url: null };
  if (access?.send_prepared) out.draft_ref = draftRefOf(lead);
  return out;
}
