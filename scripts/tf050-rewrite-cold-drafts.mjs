// TF-050: bestehende Jarvis-eigene Cold-Entwürfe auf die aktuelle Vorlage bringen – läuft IM Mail-Worker-Container (Gmail-Token nur dort).
//   TF050_MODE=plan  (Standard) nur lesen: Register, Gmail drafts.get (read-only, Token nur im Speicher), öffentliche Website-Prüfung.
//                    Ergebnis nach /tmp/tf050/plan.json, Ausgabe nur aggregiert (keine Adressen, keine Mailtexte).
//   TF050_MODE=apply [TF050_LIMIT=n] übernimmt die geplanten Änderungen ins Cold-Register (subject/body + pending_update).
//                    Der laufende Mail-Worker aktualisiert die Gmail-Entwürfe danach IN PLACE (gmail.updateDraft, Besitzprüfung).
// Nie senden, nie neu anlegen, nie löschen. Module aus TF050_MODULE_DIR (Standard /app).
import fs from "node:fs";
import path from "node:path";

const M = process.env.TF050_MODULE_DIR || "/app";
const { planColdDraftRewrite, applyColdDraftRewrites, createVerifier, candidateIssues, gmailDraftState, planDigest } = await import(`${M}/cold-draft-rewrite.js`);
const { createStore } = await import("/app/mail-worker.js");
const { registryBlock, loadRegistry } = await import("/app/lead-registry.js");
const SECRETS = process.env.JARVIS_SECRETS_DIR || "/data/secrets";
const DIR = path.join(SECRETS, "mail_worker");
const PLAN = "/tmp/tf050/plan.json";
const store = createStore(DIR);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const mode = process.env.TF050_MODE || "plan";
const count = (xs, k) => xs.reduce((a, x) => (a[x[k]] = (a[x[k]] || 0) + 1, a), {});

if (mode === "apply") {
  const saved = readJson(PLAN, null);
  if (!saved?.plans) throw new Error("Kein Plan vorhanden – erst TF050_MODE=plan.");
  const limit = Number(process.env.TF050_LIMIT || Infinity);
  const ids = new Set(saved.plans.filter((p) => p.outcome === "UPDATE").slice(0, limit).map((p) => p.id));
  const res = applyColdDraftRewrites(store, saved.plans.filter((p) => ids.has(p.id)), new Date());
  console.log(JSON.stringify({ mode, digest: saved.digest, applied: res.applied.length, stale: res.stale.length }));
  process.exit(0);
}

// ---------- plan (read-only) ----------
async function accessToken() {
  const t = readJson(path.join(SECRETS, "gmail_token.json"), null);
  if (t?.access_token && t.expiry - 120_000 > Date.now()) return t.access_token;
  const raw = readJson(path.join(SECRETS, "gmail_credentials.json"), null);
  const c = raw?.installed || raw?.web;
  const r = await fetch(c.token_uri || "https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, grant_type: "refresh_token", refresh_token: t.refresh_token }) });
  const b = await r.json();
  if (!r.ok) throw new Error(`Gmail-Auth fehlgeschlagen: ${b.error || r.status}`);
  return b.access_token; // nur im Speicher – Token-Datei bleibt unverändert
}
const token = await accessToken();
let lastGmail = 0;
// Gedrosselt (ein Aufruf zur Zeit, ≥ 600 ms Abstand) – der Mail-Worker nutzt dasselbe Kontingent. 429/rateLimitExceeded → Backoff.
let gmailChain = Promise.resolve();
function getDraft(id) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastGmail + 600 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastGmail = Date.now();
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encodeURIComponent(id)}?format=full`, { headers: { authorization: `Bearer ${token}` } });
      if (r.status === 404) return null;
      if (r.ok) return r.json();
      const body = await r.json().catch(() => ({}));
      const limited = r.status === 429 || (r.status === 403 && /rateLimit|userRateLimit/i.test(JSON.stringify(body.error?.errors || "")));
      if (!limited || attempt >= 6) throw new Error(`drafts.get ${r.status}`);
      await new Promise((res) => setTimeout(res, Math.min(60_000, 2000 * 2 ** attempt)));
    }
  };
  const p = gmailChain.then(run);
  gmailChain = p.catch(() => {});
  return p;
}

const registry = readJson(path.join(SECRETS, "gmail_jarvis.json"), { drafts: {}, sent: {} });
const reviews = store.read("individual_reviews.json", { reviews: {} }).reviews || {};
const leads = store.read("discovered.json", { leads: {} }).leads || {};
const sales = store.read("sales.json", { records: {} }).records || {};
const supp = store.read("suppression.json", {});
const config = store.read("config.json", {});
let leadDb = null; try { leadDb = loadRegistry(store); } catch {}
const sender = config.sender || {};
const sig = (sender.signature || "").trim().split("\n");
const targets = Object.entries(reviews).filter(([, r]) => r?.draft_mode && r.status === "draft_created");
const now = new Date();
const plans = [], verifyStats = {};

async function one([id, r]) {
  const to = String(r.recipient || "").toLowerCase();
  const blockReason = !leadDb ? "Lead-Datenbank nicht lesbar"
    : sales[r.domain]?.sale?.selected_offer ? "bestehender Kunde"
    : supp[to] || Object.keys(supp).some((a) => a.split("@")[1] === r.domain) ? "suppression"
    : registryBlock(store, { lead_id: id, domain: r.domain, email: to, company: r.company }, leadDb);
  let gmailState = null;
  if (registry.drafts?.[r.gmail_draft_id]?.mode === "COLD_LEAD_DRAFT_ONLY") gmailState = gmailDraftState(await getDraft(r.gmail_draft_id), { review: r, labelId: registry.labelId });
  const lead = leads[id] || leads[r.domain] || null;
  // Erst die günstigen Sicherheitsprüfungen; nur wenn der Entwurf überhaupt bearbeitbar ist, die Website erneut prüfen.
  const pre = planColdDraftRewrite(id, r, { registry, lead, gmailState, verifiedIssues: [], blockReason, sender, now });
  if (pre.outcome !== "SKIPPED_NO_VERIFIED_FINDING" && pre.outcome !== "UPDATE" && pre.outcome !== "UNCHANGED") return plans.push(pre);
  const verifier = createVerifier({ gapMs: 1000, timeoutMs: 15_000 });
  const verified = [];
  for (const i of candidateIssues(lead?.websiteIssues || [])) {
    const v = await verifier.verify(i);
    verifyStats[v.verified ? "verified" : v.reason] = (verifyStats[v.verified ? "verified" : v.reason] || 0) + 1;
    if (v.verified) verified.push(i);
  }
  plans.push(planColdDraftRewrite(id, r, { registry, lead, gmailState, verifiedIssues: verified, blockReason, sender, now }));
}
// Gmail-Lesezugriffe nacheinander (gedrosselt), Website-Prüfungen mit höchstens 4 Firmen parallel.
const queue = [...targets];
await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await one(queue.shift()); }));

fs.mkdirSync(path.dirname(PLAN), { recursive: true });
const digest = planDigest(plans);
fs.writeFileSync(PLAN, JSON.stringify({ at: now.toISOString(), digest, plans }), { mode: 0o600 });
const upd = plans.filter((p) => p.outcome === "UPDATE" || p.outcome === "UNCHANGED");
console.log(JSON.stringify({
  mode, digest, scanned: targets.length, outcomes: count(plans, "outcome"),
  findings_distribution: count(upd, "findings"), verify: verifyStats,
  skip_reasons: count(plans.filter((p) => p.outcome.startsWith("SKIPPED")).map((p) => ({ r: `${p.outcome}:${String(p.reason || "").slice(0, 40)}` })), "r"),
  signature_matches_spec: JSON.stringify(sig) === JSON.stringify(["Chris Kälin", "Helvetic Webdesign", "chris@helvetic-webdesign.ch"]),
}, null, 1));
