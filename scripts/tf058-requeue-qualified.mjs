// TF-058 Ziel 1 – alte QUALIFIED-Leads (Lead-Datenbank, noch ohne Entwurf) nach der TF-050-Regel neu bewerten und – nur wenn
// mindestens 1 aktuell verifizierter, für Besucher sichtbarer Befund + geschäftliche Adresse + Schweiz-/Repair-Regeln + Dedupe OK –
// als Cold-Entwurf COLD_LEAD_DRAFT_ONLY mit Status «queued» in individual_reviews.json einplanen. Den Gmail-ENTWURF legt danach der
// laufende Mail-Worker mit seinem bestehenden Pacing an. NIE senden, kein Gmail-Aufruf in diesem Skript, kein Mail-Worker-Neustart.
//
// Audit jünger als 7 Tage mit vollständiger Evidence → verwenden; sonst passiv neu prüfen (site-auditor.js: nur GET, robots.txt, keine
// Formulare/Logins). Schreiben: Sicherung + Compare-and-retry (Datei unverändert seit dem Lesen, sonst neu lesen und neu planen).
//
// Läuft im Mail-Worker-Container (Module unter /app, Zustand unter /data/secrets), per stdin – das Image bleibt unverändert:
//   docker exec -i -e TF058_RUN=1 -e TF058_MODE=dry|apply jarvis-mail-mail-worker-1 node --input-type=module - < scripts/tf058-requeue-qualified.mjs
// Ausgabe: nur Zahlen (keine Firmen, Adressen, Domains).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FRESH_MS = 7 * 86_400_000;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const iso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Vollständige, reproduzierbare Evidence: jeder Befund mit Typ, URL, Beleg und Zeitpunkt.
export const evidenceComplete = (issues) => Array.isArray(issues) && issues.length > 0 && issues.every((i) => i?.type && i.url && i.evidence && iso(i.detectedAt));

export async function requeueQualified({ secretsDir, base = "/app", dryRun = true, now = new Date(), auditor = null, repairStateDir = process.env.JARVIS_REPAIR_STATE_DIR || null }) {
  const m = (f) => import(pathToFileURL(path.join(base, f)).href);
  const { qualifyRepairLead, createColdDraft, coldDuplicate, REVIEWS_FILE, FREEMAIL_RE } = await m("swiss-repair.js");
  const { loadRegistry, registryBlock, CRM_UNAVAILABLE } = await m("lead-registry.js");
  const { normEmail } = await m("lead-db.js");
  const W = path.join(secretsDir, "mail_worker");
  const read = (file, fb) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return structuredClone(fb); } };
  const store = { dir: W, read: (name, fb) => read(path.join(W, name), fb), write: () => { throw new Error("read-only"); } };
  const reg = loadRegistry(store);
  const disc = store.read("discovered.json", { leads: {} }).leads || {};
  const sender = store.read("config.json", {}).sender;
  if (!sender?.name) throw new Error("config.sender fehlt – kein Entwurf möglich.");
  const gm = read(path.join(secretsDir, "gmail_jarvis.json"), { sent: {}, drafts: {} });
  const contacted = new Set([...Object.values(gm.sent || {}), ...Object.values(gm.drafts || {})].map((s) => normEmail(s?.to || "")).filter(Boolean));
  const supp = store.read("suppression.json", {});
  const sales = { ...(repairStateDir ? read(path.join(repairStateDir, "sales.json"), { records: {} }).records : {}), ...(store.read("sales.json", { records: {} }).records || {}) };
  const file = path.join(W, REVIEWS_FILE);
  let aud = auditor;

  const plan = async (reviews) => {
    const c = { candidates: 0, fresh_audit: 0, rechecked: 0, would_recheck: 0, queue: 0, skip_no_current_finding: 0, skip_not_eligible: 0, skip_no_contact: 0,
      skip_dnc: 0, skip_customer: 0, skip_duplicate: 0, skip_build_failed: 0, findings_in_mail: { 1: 0, 2: 0, 3: 0 } };
    const add = {};
    for (const l of Object.values(reg.leads)) {
      if (l?.status !== "QUALIFIED") continue; // Pre-Draft: noch kein Entwurf, nicht kontaktiert (WAITING_FOR_DRAFT hat bereits einen Queue-Eintrag)
      c.candidates++;
      const why = registryBlock(store, { lead_id: l.lead_id, domain: l.domain, email: l.business_email, company: l.company }, reg);
      if (why === CRM_UNAVAILABLE) throw new Error("CRM (Do Not Contact) nicht lesbar – fail-safe, nichts eingeplant.");
      if (why) { if (/do-not-contact|opt-out|suppression/.test(why)) c.skip_dnc++; else if (/Kunde|Testverkauf/.test(why)) c.skip_customer++; else c.skip_duplicate++; continue; }
      let lead = disc[l.domain] ? { ...disc[l.domain] } : null;
      if (!lead) { c.skip_no_current_finding++; continue; } // keine Evidence mehr vorhanden → nie aus Registry-Text allein
      const fresh = iso(lead.auditedAt) && +now - Date.parse(lead.auditedAt) <= FRESH_MS && evidenceComplete(lead.websiteIssues);
      if (fresh) c.fresh_audit++;
      else if (!aud) { c.would_recheck++; continue; }
      else {
        let a = null; try { a = await aud.audit(lead.website || `https://${lead.domain}/`); } catch {}
        c.rechecked++;
        if (!a || a.reachable === false) { c.skip_no_current_finding++; continue; } // Prüfung fehlgeschlagen → nie einen Fehler behaupten
        lead = { ...lead, websiteIssues: a.issues, auditedAt: now.toISOString(), reachable: a.reachable };
      }
      const q = qualifyRepairLead(lead, { now });
      if (!q.customer_findings.length) { c.skip_no_current_finding++; continue; }
      if (q.stage !== "cold_lead_draft_only") { c.skip_not_eligible++; continue; } // Schweiz-/Repair-/Kontaktregeln nicht erfüllt
      const to = normEmail(lead.email || lead.business_email || "");
      if (!EMAIL_RE.test(to) || FREEMAIL_RE.test(to)) { c.skip_no_contact++; continue; }
      if (supp[to] || Object.keys(supp).some((x) => x.split("@")[1] === lead.domain && !FREEMAIL_RE.test(x))) { c.skip_dnc++; continue; }
      if (sales[lead.domain]?.sale?.selected_offer) { c.skip_customer++; continue; }
      if (contacted.has(to) || coldDuplicate({ ...reviews, ...add }, { ...lead, email: to }, { contacted, now })) { c.skip_duplicate++; continue; }
      let r; try { r = createColdDraft({ ...lead, email: to }, { sender, now }); } catch { c.skip_build_failed++; continue; }
      add[r.lead_id] = r; c.queue++;
      const n = Math.min(3, r.customer_findings.length); c.findings_in_mail[n] = (c.findings_in_mail[n] || 0) + 1;
    }
    return { c, add };
  };

  if (dryRun) { const { c } = await plan(store.read(REVIEWS_FILE, { reviews: {} }).reviews || {}); return { dry_run: true, ...c }; }
  // Passive Neuprüfungen nur einmal (vor der Schreibschleife), dann Compare-and-retry ohne Netz.
  const audited = new Map();
  aud = auditor && { audit: async (u) => { if (!audited.has(u)) audited.set(u, await auditor.audit(u).catch(() => null)); return audited.get(u); } };
  for (let attempt = 1; attempt <= 10; attempt++) {
    const raw = fs.readFileSync(file, "utf8"), h0 = sha(raw), data = JSON.parse(raw);
    const { c, add } = await plan(data.reviews || {});
    const ids = Object.keys(add).filter((id) => !data.reviews?.[id]);
    if (!ids.length) return { dry_run: false, ...c, queued: 0, attempts: attempt };
    const tag = now.toISOString().replace(/[:.]/g, "").replace(/-/g, "");
    const bak = `${file}.bak-tf058-${tag}`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    for (const id of ids) data.reviews[id] = add[id];
    const tmp = `${file}.tf058-${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Hat der Mail-Worker die Datei seit dem Lesen geändert? Dann verwerfen und mit frischem Stand neu planen (kein Lost Update).
    if (sha(fs.readFileSync(file, "utf8")) !== h0) { fs.rmSync(tmp, { force: true }); await new Promise((r) => setTimeout(r, 300 * attempt)); continue; }
    fs.renameSync(tmp, file);
    const after = JSON.parse(fs.readFileSync(file, "utf8")).reviews || {};
    return { dry_run: false, ...c, queued: ids.filter((id) => after[id]?.status === "queued").length, attempts: attempt, backup: path.basename(bak) };
  }
  throw new Error("individual_reviews.json änderte sich bei jedem Versuch – nichts geschrieben.");
}

if (process.env.TF058_RUN === "1") {
  const dryRun = process.env.TF058_MODE !== "apply";
  const { createAuditor } = await import(pathToFileURL("/app/site-auditor.js").href);
  requeueQualified({ secretsDir: process.env.TF058_SECRETS || "/data/secrets", dryRun, auditor: dryRun ? null : createAuditor({ totalMs: 90_000 }) })
    .then((r) => console.log(JSON.stringify(r)), (e) => { console.log(JSON.stringify({ ok: false, error: String(e.message).slice(0, 200) })); process.exitCode = 1; });
}
