// TF-050 Cold-Draft-Rewrite – bestehende Jarvis-eigene Cold-Entwürfe auf die aktuelle Vorlage bringen (1 Befund genügt, höchstens 3).
// Nur Entwürfe, die im Jarvis-Register eindeutig als COLD_LEAD_DRAFT_ONLY desselben Leads geführt sind (nie anhand von Betreff,
// Empfänger oder Textähnlichkeit). Befunde werden vorher auf der öffentlichen Website erneut geprüft (nur normale Seitenaufrufe:
// kein Login, kein Formular, keine Bestellung). 0 bestätigte Befunde → Entwurf bleibt unverändert (nichts wird erfunden).
// Dieses Modul sendet nie und spricht Gmail nie schreibend an: es setzt nur subject/body + pending_update im lokalen Cold-Register;
// der Mail-Worker aktualisiert den Gmail-Entwurf danach in place über gmail.updateDraft (Besitzprüfung, Empfänger/Thread bleiben).
import crypto from "node:crypto";
import { UA } from "./site-auditor.js";
import { COLD_MODE, COLD_DRAFTS_FILE, qualifyRepairLead, buildColdDraft, selectCustomerVisibleFindings, draftHash } from "./swiss-repair.js";

export const REWRITE_OUTCOMES = Object.freeze(["UPDATE", "UNCHANGED", "SKIPPED_NO_VERIFIED_FINDING", "SKIPPED_AMBIGUOUS_OWNERSHIP", "SKIPPED_ATTACHMENT",
  "SKIPPED_ALREADY_MANUALLY_SENT", "SKIPPED_NOT_A_DRAFT", "SKIPPED_EDITED", "SKIPPED_BLOCKED"]);
// Nur diese Befundtypen lassen sich per normalem Seitenaufruf erneut belegen (alle anderen bleiben ungeprüft → nicht verwendet).
export const REVERIFIABLE = new Set(["broken_link", "contact_page_broken", "broken_image", "broken_mailto", "https_certificate"]);

const TLS_RE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME|ALTNAME/i;
const BROKEN = (status) => status === 404 || status === 410 || status >= 500; // wie site-auditor.js: 400/401/403/429 können Bot-Schutz sein
const errCode = (e) => e?.cause?.code || e?.code || (e?.name === "AbortError" || e?.name === "TimeoutError" ? "TIMEOUT" : e?.message || "ERROR");
const ENTITIES = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
const decode = (v) => v?.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m);
const attr = (tag, name) => decode(tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v !== undefined));
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || [];
const key = (u, base) => { try { const x = new URL(u, base); return `${x.host.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`; } catch { return null; } };
const VALID_MAIL = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}$/i;

// Erneute Prüfung EINES Rohbefunds auf der öffentlichen Website. Netzfehler/Timeouts gelten nie als Beleg (fail closed).
export function createVerifier({ fetchFn = globalThis.fetch, timeoutMs = 15_000, gapMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = 0;
  const pages = new Map();
  async function get(url, { body = true } = {}) {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const r = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
      const html = body && /html|text\/plain/i.test(r.headers.get("content-type") || "") ? (await r.text()).slice(0, 2_000_000) : "";
      if (!html) await r.body?.cancel?.().catch(() => {});
      return { status: r.status, html, url: r.url || url };
    } catch (e) { return { error: errCode(e), url }; }
  }
  const page = (u) => { if (!pages.has(u)) pages.set(u, get(u)); return pages.get(u); };
  async function verify(issue = {}) {
    if (!REVERIFIABLE.has(issue.type)) return { verified: false, reason: "not_reverifiable" };
    if (issue.type === "https_certificate") {
      let host; try { host = new URL(issue.url).hostname; } catch { return { verified: false, reason: "bad_url" }; }
      const r = await get(`https://${host}/`, { body: false });
      return r.error && TLS_RE.test(r.error) ? { verified: true } : { verified: false, reason: r.error ? "other_error" : "no_warning" };
    }
    const where = issue.page || issue.evidence?.match(/\((?:verlinkt|eingebunden) auf (https?:\/\/[^\s)]+)\)/)?.[1];
    if (!where) return { verified: false, reason: "no_page" };
    const p = await page(where);
    if (p.error || p.status >= 400 || !p.html) return { verified: false, reason: "page_unavailable" };
    if (issue.type === "broken_mailto") {
      const bad = tags(p.html, "a").map((t) => attr(t, "href") || "").filter((h) => /^mailto:/i.test(h))
        .map((h) => { try { return decodeURIComponent(h.slice(7).split("?")[0]).trim(); } catch { return h.slice(7); } }).filter((m) => !VALID_MAIL.test(m));
      return bad.length ? { verified: true } : { verified: false, reason: "fixed" };
    }
    // Link/Bild muss auf der Seite noch vorhanden sein UND das Ziel weiterhin eine Fehlerseite liefern.
    const target = key(issue.url);
    const refs = issue.type === "broken_image" ? tags(p.html, "img").map((t) => attr(t, "src")) : tags(p.html, "a").map((t) => attr(t, "href"));
    if (!target || !refs.some((r) => r && key(r, p.url) === target)) return { verified: false, reason: "no_longer_linked" };
    const t = await get(issue.url, { body: false });
    if (t.error) return { verified: false, reason: "network" };
    return BROKEN(t.status) ? { verified: true } : { verified: false, reason: "fixed" };
  }
  return { verify };
}

// Kandidaten für die erneute Prüfung: nur Rohbefunde, die überhaupt in eine Kundenaussage münden können.
export function candidateIssues(issues = []) {
  const refs = new Set(selectCustomerVisibleFindings(issues, { max: Infinity }).flatMap((f) => f.internal_refs.map((r) => `${r.issue_type}|${r.url}`)));
  return (Array.isArray(issues) ? issues : []).filter((i) => i && refs.has(`${i.type}|${i.url}`));
}

// Zustand des Entwurfs in Gmail (format=full) → nur die für die Sicherheitsentscheidung nötigen Flags, kein Inhalt nach aussen.
const b64 = (s = "") => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const norm = (s = "") => String(s).replace(/\r\n/g, "\n").replace(/\s+$/g, "");
const decodeWords = (s = "") => String(s).replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, x) => Buffer.from(x, "base64").toString("utf8"));
export function gmailDraftState(draft, { review, labelId } = {}) {
  const msg = draft?.message;
  if (!msg) return { exists: false };
  const parts = [], walk = (p) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(msg.payload);
  const hdr = (n) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value || "";
  const attachments = parts.filter((p) => p.filename || p.body?.attachmentId).length;
  const plain = parts.filter((p) => /^text\/plain/i.test(p.mimeType || "") && p.body?.data);
  const html = parts.some((p) => /^text\/html/i.test(p.mimeType || ""));
  const body = plain.length === 1 ? b64(plain[0].body.data) : null;
  return {
    exists: true, isDraft: (msg.labelIds || []).includes("DRAFT"), jarvisLabel: !!labelId && (msg.labelIds || []).includes(labelId), attachments,
    toMatches: !!review?.recipient && hdr("to").toLowerCase().replace(/^.*<|>.*$/g, "").trim() === String(review.recipient).toLowerCase(),
    // Unverändert seit Jarvis' letzter Fassung? Sonst hat Chris in Gmail bearbeitet → nicht überschreiben.
    contentMatches: !html && body !== null && norm(body) === norm(review?.body) && decodeWords(hdr("subject")) === (review?.subject || ""),
    hasCc: !!(hdr("cc") || hdr("bcc")),
  };
}

// Reine Entscheidung für EINEN Register-Eintrag. ctx: registry (gmail_jarvis.json), lead (discovered), gmailState, verifiedIssues,
// blockReason (Lead-Datenbank/Kunde/Suppression), sender, now.
export function planColdDraftRewrite(id, review, { registry = {}, lead = null, gmailState = null, verifiedIssues = null, blockReason = null, sender = {}, now = new Date() } = {}) {
  const skip = (outcome, reason) => ({ id, outcome, reason });
  if (!review || review.draft_mode !== COLD_MODE) return skip("SKIPPED_AMBIGUOUS_OWNERSHIP", "kein Cold-Register-Eintrag");
  if (review.manual_send_detected || ["manually_sent", "sent"].includes(review.status)) return skip("SKIPPED_ALREADY_MANUALLY_SENT");
  if (review.status !== "draft_created" || !review.gmail_draft_id) return skip("SKIPPED_NOT_A_DRAFT", review.status);
  const entry = registry.drafts?.[review.gmail_draft_id];
  // Besitz nur über das Register: Entwurf registriert, Cold-Modus, gleicher Lead. Kein Raten über Betreff/Empfänger/Text.
  if (!entry || entry.mode !== COLD_MODE || entry.leadId !== id || entry.messageClass) return skip("SKIPPED_AMBIGUOUS_OWNERSHIP", "nicht eindeutig im Register");
  const sentFromDraft = Object.values(registry.sent || {}).some((s) => s.fromDraft === review.gmail_draft_id || (s.leadId && s.leadId === id));
  if (sentFromDraft) return skip("SKIPPED_ALREADY_MANUALLY_SENT");
  if (review.discard_requested) return skip("SKIPPED_NOT_A_DRAFT", "Verwerfen angefordert");
  if (review.pending_update) return skip("SKIPPED_EDITED", "Bearbeitung ausstehend");
  if (review.suppressed_after_draft || blockReason) return skip("SKIPPED_BLOCKED", blockReason || "Suppression");
  if (!gmailState?.exists || !gmailState.isDraft || !gmailState.jarvisLabel) return skip("SKIPPED_NOT_A_DRAFT", "nicht mehr als Jarvis-Entwurf in Gmail");
  if (gmailState.attachments > 0) return skip("SKIPPED_ATTACHMENT");
  if (!gmailState.toMatches || gmailState.hasCc) return skip("SKIPPED_AMBIGUOUS_OWNERSHIP", "Empfänger in Gmail weicht ab");
  if (!gmailState.contentMatches) return skip("SKIPPED_EDITED", "in Gmail bearbeitet");
  if (!lead || !Array.isArray(verifiedIssues)) return skip("SKIPPED_NO_VERIFIED_FINDING", "kein Lead-Datensatz");
  const l = { ...lead, domain: review.domain || lead.domain, company: review.company ?? lead.company, websiteIssues: verifiedIssues };
  const q = qualifyRepairLead(l, { now });
  if (!q.customer_findings.length) return skip("SKIPPED_NO_VERIFIED_FINDING");
  let draft;
  try { draft = buildColdDraft(l, { ...q, contact_name: review.contact_name ?? q.contact_name }, sender); }
  catch (e) { return skip("SKIPPED_NO_VERIFIED_FINDING", e.message); }
  const hash = draftHash(draft.subject, draft.body);
  if (hash === review.draft_hash) return { id, outcome: "UNCHANGED", findings: q.customer_findings.length };
  return {
    id, outcome: "UPDATE", findings: q.customer_findings.length, expect_hash: review.draft_hash,
    patch: { subject: draft.subject, body: draft.body, draft_hash: hash, pending_update: true, template: "TF-050",
      customer_findings: q.customer_findings.map(({ key: k, text, severity, internal_refs }) => ({ key: k, text, severity, internal_refs })) },
  };
}

// Übernimmt geplante Änderungen ins Cold-Register – frisch gelesen, nur wenn der Eintrag seit der Planung unverändert ist
// (gleicher draft_hash, weiterhin draft_created, nichts ausstehend). Nie neuer Eintrag, nie Statuswechsel, nie Empfänger/Thread.
export function applyColdDraftRewrites(store, plans = [], now = new Date()) {
  const data = store.read(COLD_DRAFTS_FILE, { reviews: {} });
  const applied = [], stale = [];
  for (const p of plans) {
    if (p.outcome !== "UPDATE") continue;
    const r = data.reviews?.[p.id];
    if (!r || r.status !== "draft_created" || r.draft_mode !== COLD_MODE || r.pending_update || r.discard_requested || r.manual_send_detected || r.draft_hash !== p.expect_hash) { stale.push(p.id); continue; }
    data.reviews[p.id] = { ...r, ...p.patch, updated_at: now.toISOString() };
    applied.push(p.id);
  }
  if (applied.length) store.write(COLD_DRAFTS_FILE, data);
  return { applied, stale };
}

export const planDigest = (plans = []) => crypto.createHash("sha256").update(JSON.stringify(plans.map((p) => [p.id, p.outcome, p.patch?.draft_hash || null]))).digest("hex").slice(0, 12);
