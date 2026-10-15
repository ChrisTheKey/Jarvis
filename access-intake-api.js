// /api/access-intake – sicherer, auftragsgebundener One-Time-Zugangsweg für CHF-480-Kunden (TF-041), Cloud-Seite (Netlify Blobs
// "jarvis-access-intake"). Der VPS hat keinen eingehenden Port: er REGISTRIERT je Auftrag einen Link, der Kunde reicht seinen
// Zugang über public/access.html ein, der VPS HOLT die Einreichung ab und QUITTIERT sie (danach ist der Eintrag gelöscht).
//
//   VPS (x-jarvis-worker = JARVIS_MAIL_WORKER_TOKEN): register | pull | ack (ack per token_hash)
//   Kunde (nur mit dem Link-Token):                    info | submit
// Blob-Schlüssel ist sha256(token); der Kundenlink enthält nur den Token (keine Auftrags-ID, keine internen Daten).
//
// Harte Regeln (fail closed):
//   - Token: 32 Zufallsbytes (base64url) – hier liegt NUR sha256(token); Vergleich in konstanter Zeit. Der Klartext-Token steht
//     ausschliesslich im Link der Kundenmail (URL-Fragment #…, wird nie an einen Server/Log übertragen).
//   - Gebunden an ORDER_ID + Domain, Ablauf (Standard 72 h), nach EINER Einreichung ungültig (atomar per ETag).
//   - Zugangsdaten verlassen den Browser NUR verschlüsselt (RSA-OAEP-256 + AES-256-GCM mit dem Public Key des VPS). Netlify kennt
//     nur diesen Public Key und das Chiffrat – nie Klartext, nie den Private Key. Antworten enthalten nie Zugangsdaten.
//   - Reparaturfreigabe ist Pflicht (consent = true, Text nennt die Domain); Domain-Abweichung → abgelehnt.
//   - TF-043: zweiter Link-Zweck «host_key_confirmation». Der VPS registriert den vom Server präsentierten SSH-Fingerprint (nicht
//     geheim) als Kandidaten; der Kunde vergleicht ihn mit der Angabe seines Hosting-Anbieters und bestätigt bzw. meldet eine
//     Abweichung. Kein Chiffrat nötig, keine Zugangsdaten. Gleiche Regeln: Token-Hash, Ablauf, einmalig, Domain exakt.
import crypto from "node:crypto";
import { safeEqual } from "./shared-state.js";
import { vnConsentText, vnHostKeyConfirmText, VN_REPAIR_SCOPE } from "./vn-customer-texts.js";

export const ACCESS_TYPES = Object.freeze(["github_netlify", "wordpress_cms", "sftp", "ssh", "hosting", "other"]);
export const INTAKE_PURPOSES = Object.freeze(["access", "host_key_confirmation"]);
export const HOST_KEY_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const ACCESS_ENVELOPE_ALG = "RSA-OAEP-256+A256GCM";
export const INTAKE_TTL_MS = 72 * 3600_000;
const MAX_TTL_MS = 7 * 24 * 3600_000;
export const MAX_ENVELOPE_CHARS = 16_000;
const MAX_BODY = 32_000;
export const ORDER_ID_RE = /^(RF480|VNFIX)-\d{8}-[0-9a-f]{6}$/; // TF-064: VN-Reparaturaufträge (VNFIX-…) gleicher Weg
export const INTAKE_LOCALES = Object.freeze(["de-CH", "vi-VN"]);
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
export const normDomain = (d = "") => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
export const tokenHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
export const consentText = (domain, locale = "de-CH") => locale === "vi-VN" ? vnConsentText(domain) : `Ich bestätige, dass ich berechtigt bin, diesen Zugang bereitzustellen, und erlaube Helvetic Webdesign/Jarvis, die vereinbarten Reparaturen auf ${domain} im Rahmen dieses Auftrags durchzuführen.`;
export const hostKeyConfirmText = (domain, locale = "de-CH") => locale === "vi-VN" ? vnHostKeyConfirmText(domain) : `Ich habe den angezeigten Fingerprint mit der Angabe meines Hosting-Anbieters für ${domain} verglichen – er stimmt exakt überein.`;
export const REPAIR_SCOPE = "Vereinbarte Reparaturen im Rahmen des Auftrags «Check & Reparatur» (CHF 480) – keine Erweiterung des Umfangs.";
export const repairScope = (locale = "de-CH") => (locale === "vi-VN" ? VN_REPAIR_SCOPE : REPAIR_SCOPE);

// Chiffrat-Format prüfen (Inhalt ist absichtlich nicht lesbar). Nur exakt diese Felder, nur Base64, begrenzte Grösse.
export function validEnvelope(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "alg,ciphertext,iv,wrapped_key") return false;
  if (e.alg !== ACCESS_ENVELOPE_ALG) return false;
  for (const k of ["wrapped_key", "iv", "ciphertext"]) if (typeof e[k] !== "string" || !B64_RE.test(e[k])) return false;
  if (Buffer.from(e.iv, "base64").length !== 12) return false;
  const wk = Buffer.from(e.wrapped_key, "base64").length;
  if (wk < 256 || wk > 512) return false;
  return e.ciphertext.length >= 24 && e.ciphertext.length <= MAX_ENVELOPE_CHARS;
}
const validPublicKey = (pem) => {
  try { const k = crypto.createPublicKey(pem); return k.asymmetricKeyType === "rsa" && k.asymmetricKeyDetails.modulusLength >= 3072; } catch { return false; }
};

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const GONE = "Link ungültig, bereits verwendet oder abgelaufen. Bitte melden Sie sich bei uns.";

// store: { get(key) → { data, etag } | null, set(key, data, { etag?, onlyIfNew? }) → boolean, delete(key), list(prefix) → [key] }
export function createAccessIntakeHandler({ getStore, env, now = () => new Date() }) {
  return async (req) => {
    if (req.method !== "POST") return reply(405, { error: "Nur POST." });
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return reply(413, { error: "Zu gross." });
    const raw = await req.text();
    if (raw.length > MAX_BODY) return reply(413, { error: "Zu gross." });
    let b;
    try { b = JSON.parse(raw); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    if (!b || typeof b !== "object" || Array.isArray(b)) return reply(400, { error: "Ungültige Anfrage." });
    const workerToken = env("JARVIS_MAIL_WORKER_TOKEN");
    const isWorker = !!workerToken && safeEqual(req.headers.get("x-jarvis-worker"), workerToken);
    const store = await getStore();
    const t = now();
    const key = (hash) => `t/${hash}`; // Schlüssel = sha256(token) – der Link enthält nur den Token, keine Auftrags-ID

    if (["register", "pull", "ack"].includes(b.op)) {
      if (!isWorker) return reply(401, { error: "Nicht berechtigt." });
      if (b.op === "register") {
        const exp = Date.parse(b.expires_at);
        const purpose = b.purpose ?? "access";
        const locale = b.locale ?? "de-CH"; // TF-064: Formularsprache (VN-Aufträge vi-VN)
        if (!ORDER_ID_RE.test(b.order_id || "") || !DOMAIN_RE.test(b.domain || "") || !HASH_RE.test(b.token_hash || "")
          || !Number.isFinite(exp) || exp <= +t || exp - +t > MAX_TTL_MS || !validPublicKey(b.public_key) || !INTAKE_PURPOSES.includes(purpose)
          || (purpose === "host_key_confirmation" && !HOST_KEY_RE.test(b.host_key_candidate || "")) || !INTAKE_LOCALES.includes(locale)
          || (String(b.order_id).startsWith("VNFIX-") !== (locale === "vi-VN"))) return reply(400, { error: "Ungültige Registrierung." });
        // Ein Auftrag hat höchstens EINEN gültigen Link: ältere, unbenutzte Registrierungen desselben Auftrags verfallen sofort.
        for (const k of await store.list("t/")) {
          const e = (await store.get(k))?.data;
          if (e?.order_id !== b.order_id) continue;
          if (e.used_at) return reply(409, { error: "Für diesen Auftrag liegt bereits eine Einreichung vor." });
          if (k !== key(b.token_hash)) await store.delete(k);
        }
        await store.set(key(b.token_hash), { order_id: b.order_id, domain: b.domain, token_hash: b.token_hash, expires_at: new Date(exp).toISOString(),
          public_key: b.public_key, registered_at: t.toISOString(), purpose, locale, ...(purpose === "host_key_confirmation" ? { host_key_candidate: b.host_key_candidate } : {}) });
        return reply(200, { ok: true });
      }
      if (b.op === "pull") {
        const submissions = [];
        for (const k of (await store.list("t/")).slice(0, 200)) {
          const e = (await store.get(k))?.data;
          if (!e) continue;
          if (e.submission) submissions.push({ order_id: e.order_id, domain: e.domain, token_hash: e.token_hash, expires_at: e.expires_at, submission: e.submission });
          else if (Date.parse(e.expires_at) <= +t) await store.delete(k); // abgelaufen, nie benutzt → aufräumen
        }
        return reply(200, { submissions });
      }
      if (!HASH_RE.test(b.token_hash || "")) return reply(400, { error: "token_hash ungültig." });
      await store.delete(key(b.token_hash)); // ack: Chiffrat und Registrierung verschwinden aus der Cloud – der Link ist tot
      return reply(200, { ok: true });
    }

    if (b.op === "info" || b.op === "submit") {
      if (!TOKEN_RE.test(b.token || "")) return reply(404, { error: GONE });
      const cur = await store.get(key(tokenHash(b.token)));
      const e = cur?.data;
      if (!e || e.used_at || Date.parse(e.expires_at) <= +t || !safeEqual(tokenHash(b.token), e.token_hash)) return reply(404, { error: GONE });
      const purpose = e.purpose || "access";
      const loc = INTAKE_LOCALES.includes(e.locale) ? e.locale : "de-CH";
      if (b.op === "info") {
        if (purpose === "host_key_confirmation") return reply(200, { purpose, domain: e.domain, expires_at: e.expires_at, host_key_candidate: e.host_key_candidate, confirm_text: hostKeyConfirmText(e.domain, loc), ...(loc === "vi-VN" ? { locale: loc } : {}) });
        return reply(200, { purpose, domain: e.domain, expires_at: e.expires_at, public_key: e.public_key,
          access_types: ACCESS_TYPES, consent_text: consentText(e.domain, loc), scope: repairScope(loc), ...(loc === "vi-VN" ? { locale: loc } : {}) });
      }
      if ((b.purpose ?? "access") !== purpose) return reply(400, { error: "Falsches Formular für diesen Link." });
      if (purpose === "host_key_confirmation") {
        if (normDomain(b.access_domain) !== e.domain) return reply(400, { error: "Die angegebene Domain stimmt nicht mit dem Auftrag überein." });
        if (!["confirm", "reject"].includes(b.decision)) return reply(400, { error: "Bitte wählen Sie «stimmt überein» oder «stimmt nicht überein»." });
        if (b.host_key !== e.host_key_candidate) return reply(400, { error: "Der Fingerprint passt nicht zu diesem Link." });
        if (b.decision === "confirm" && b.consent !== true) return reply(400, { error: "Bitte bestätigen Sie den Vergleich." });
        const next = { ...e, used_at: t.toISOString(), submission: { submitted_at: t.toISOString(), purpose, access_domain: e.domain, decision: b.decision,
          host_key: e.host_key_candidate, consent: b.decision === "confirm", confirm_text: b.decision === "confirm" ? hostKeyConfirmText(e.domain, loc) : null } };
        if (!(await store.set(key(e.token_hash), next, { etag: cur.etag }))) return reply(404, { error: GONE });
        return reply(200, { ok: true });
      }
      if (!ACCESS_TYPES.includes(b.access_type)) return reply(400, { error: "Unbekannte Zugangsart." });
      if (normDomain(b.access_domain) !== e.domain) return reply(400, { error: "Die angegebene Domain stimmt nicht mit dem Auftrag überein." });
      if (b.consent !== true) return reply(400, { error: "Die Reparaturfreigabe ist Pflicht." });
      if (!validEnvelope(b.envelope)) return reply(400, { error: "Zugangsdaten müssen verschlüsselt übermittelt werden." });
      const next = { ...e, used_at: t.toISOString(), submission: { submitted_at: t.toISOString(), access_type: b.access_type, access_domain: e.domain,
        consent: true, consent_text: consentText(e.domain, loc), envelope: b.envelope } };
      // Atomar: nur wenn sich der Eintrag seit dem Lesen nicht verändert hat – eine zweite (parallele) Einreichung scheitert.
      if (!(await store.set(key(e.token_hash), next, { etag: cur.etag }))) return reply(404, { error: GONE });
      return reply(200, { ok: true });
    }
    return reply(400, { error: "Unbekannte Operation." });
  };
}

// In-Memory-Store mit ETags (Tests/lokal) – gleiche Schnittstelle wie der Netlify-Blobs-Adapter.
export function memoryIntakeStore() {
  const m = new Map(); let n = 0;
  return {
    async get(k) { const v = m.get(k); return v ? { data: structuredClone(v.data), etag: v.etag } : null; },
    async set(k, data, { etag = null } = {}) { const cur = m.get(k); if (etag && cur?.etag !== etag) return false; m.set(k, { data: structuredClone(data), etag: String(++n) }); return true; },
    async delete(k) { m.delete(k); },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
    dump: () => JSON.stringify([...m.values()].map((v) => v.data)),
  };
}
