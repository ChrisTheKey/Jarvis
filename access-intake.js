// Sicherer Kunden-Zugang (TF-041), VPS-Seite: Schlüssel, One-Time-Link, Abholung der Einreichungen, verschlüsselter Tresor.
// Gegenstück zur Cloud-Seite access-intake-api.js (Netlify /api/access-intake) und zum Kundenformular public/access.html.
//
//   1. Nach erfüllter CHF-240-Schwelle erzeugt repair-workflow.js je Auftrag EINEN Token (newIntakeToken) und registriert nur
//      sha256(token) + Domain + Ablauf + den Public Key bei Netlify; der Klartext-Token steht ausschliesslich im Kundenlink.
//   2. Der Kunde reicht im Browser Zugangsart, Domain, Pflicht-Freigabe und die IM BROWSER verschlüsselten Zugangsdaten ein.
//   3. syncAccessIntake holt die Einreichung ab, prüft fail closed (Auftrag, Token-Hash, Ablauf, Domain, Freigabe, Zahlung,
//      entschlüsselbar), legt NUR das Chiffrat im Tresor ab und quittiert – damit ist der Eintrag in der Cloud gelöscht.
//   4. Entschlüsselt wird nur im Speicher, wenn ein Adapter den Zugang braucht (openAccessCredential). Nach COMPLETED/CANCELLED
//      wird der Tresor-Eintrag zerstört (destroyAccessSecret); am Auftrag bleiben nur Metadaten.
//
// Speicherorte (nur VPS, nie Git/Backup/Cloud/Dashboard): <worker>/access_intake_private.pem (600, wird beim ersten Bedarf auf
// dem VPS erzeugt) und <worker>/access_vault/<order_id>.json (nur Chiffrat). Das State-Backup erfasst beides nicht
// (backup.stateFiles nimmt nur *.json direkt im Worker-Verzeichnis). Zugangsdaten erscheinen nie in Logs, Order-JSON,
// sales.json, payments.json, lead_registry.json, Snapshot, Dashboard, Bericht oder PROJECT_STATE.
//
//   node access-intake.js status <order_id>                     nur Metadaten (Zugangsart, Zeitpunkte) – nie Zugangsdaten
//   node access-intake.js destroy <order_id> --reason "<grund>" Tresor-Eintrag sofort zerstören
//   node access-intake.js reveal <order_id> --confirm           NUR für Chris auf dem VPS (manueller Zugang ohne Adapter):
//                                                               gibt die Zugangsdaten auf stdout aus, nie in Logs/Dateien
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore } from "./mail-worker.js";
import { paymentGateForOrder } from "./payments.js";
import { safeEqual } from "./shared-state.js";
import { ACCESS_TYPES, ACCESS_ENVELOPE_ALG, INTAKE_TTL_MS, ORDER_ID_RE, repairScope, INTAKE_PURPOSES, normDomain, tokenHash, consentText,
  hostKeyConfirmText, validEnvelope } from "./access-intake-api.js";
import { PROVIDER_REGISTRY, providerProfileForDetection } from "./access-provider-registry.js";
import { accessLink, newIntakeToken } from "./access-token.js";

export { ACCESS_TYPES, INTAKE_TTL_MS, INTAKE_PURPOSES, tokenHash, consentText, hostKeyConfirmText };
export { accessLink, newIntakeToken };
export const ACCESS_KEY_FILE = "access_intake_private.pem";
export const ACCESS_VAULT_DIR = "access_vault";
export const ACCESS_AUTH_SOURCE = "secure_order_access_form";
export const ACCESS_REQUEST_CLASS = "CUSTOMER_ACCESS_REQUEST";
const REPAIR_ORDERS_FILE = "repair_orders.json"; // lokal (wie payments.js), damit kein Import-Zyklus mit repair-workflow.js entsteht
// TF-043: zusätzlich strukturierte Server-Angaben (port, remote_root, ssh_host_key_sha256, website_stack_hint, provider_name) und
// die Passphrase eines Schlüssels – alles nur im Chiffrat; geheim sind secret + passphrase (profile-builder.js SECRET_FIELDS).
const PAYLOAD_KEYS = new Set(["access_type", "host", "username", "secret", "notes", "port", "remote_root", "ssh_host_key_sha256", "passphrase",
  "website_stack_hint", "provider_name"]);

// ---------- Schlüssel (Private Key nur hier auf dem VPS) ----------
export function accessKeys(workerDir = WORKER_DIR) {
  const f = path.join(workerDir, ACCESS_KEY_FILE);
  let pem;
  try { pem = fs.readFileSync(f, "utf8"); } catch {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
    pem = privateKey.export({ type: "pkcs8", format: "pem" });
    fs.mkdirSync(workerDir, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(f, pem, { mode: 0o600, flag: "wx" }); }
    catch (e) { if (e.code !== "EEXIST") throw e; pem = fs.readFileSync(f, "utf8"); } // paralleler Erzeuger → dessen Schlüssel gilt
  }
  return { privateKeyPem: pem, publicKeyPem: crypto.createPublicKey(pem).export({ type: "spki", format: "pem" }) };
}

// ---------- Cloud-Client (nur ausgehend, Worker-Token) ----------
export function intakeClient({ config, fetchFn = globalThis.fetch } = {}) {
  if (!config?.workerToken || !config?.url) return null;
  const origin = config.url.replace(/\/api\/state$/, "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return null; // nur HTTPS
  const url = origin + "/api/access-intake";
  const post = async (body) => {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-worker": config.workerToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`access-intake HTTP ${r.status}`); // nie Antwortinhalte loggen
    return j;
  };
  return { origin, register: (x) => post({ op: "register", ...x }), pull: async () => (await post({ op: "pull" })).submissions || [], ack: (token_hash) => post({ op: "ack", token_hash }) };
}

// ---------- Chiffrat (gleiches Verfahren wie backup.js: RSA-OAEP/SHA-256 verpackter AES-256-GCM-Schlüssel) ----------
// Browser (WebCrypto) liefert AES-GCM als Chiffrat||Tag (16 Byte). Wirft bei jeder Abweichung (fail closed).
export function openEnvelope(envelope, privateKeyPem) {
  if (!validEnvelope(envelope)) throw new Error("Chiffrat ungültig.");
  const key = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.wrapped_key, "base64"));
  if (key.length !== 32) throw new Error("Chiffrat ungültig.");
  const buf = Buffer.from(envelope.ciphertext, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  d.setAuthTag(buf.subarray(buf.length - 16));
  const plain = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString("utf8");
  const obj = JSON.parse(plain);
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || Object.keys(obj).some((k) => !PAYLOAD_KEYS.has(k))
    || Object.values(obj).some((v) => v != null && (typeof v !== "string" || v.length > 4000))) throw new Error("Chiffrat-Inhalt ungültig.");
  return obj;
}
// Gegenstück für Tests/Werkzeuge (Node) – identisch zum Browser-Verfahren in public/access-crypto.js.
export function sealEnvelope(payload, publicKeyPem) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), "utf8"), c.final(), c.getAuthTag()]);
  const wrapped = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return { alg: ACCESS_ENVELOPE_ALG, wrapped_key: wrapped.toString("base64"), iv: iv.toString("base64"), ciphertext: ct.toString("base64") };
}

// ---------- Tresor (nur Chiffrat) ----------
const vaultFile = (workerDir, orderId) => {
  if (!ORDER_ID_RE.test(String(orderId))) throw new Error("order_id ungültig.");
  return path.join(workerDir, ACCESS_VAULT_DIR, `${orderId}.json`);
};
function storeAccessSecret(workerDir, orderId, envelope, now) {
  const f = vaultFile(workerDir, orderId);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + ".tmp", JSON.stringify({ order_id: orderId, envelope, stored_at: now.toISOString() }), { mode: 0o600 });
  fs.renameSync(f + ".tmp", f);
}
export const hasAccessSecret = (workerDir, orderId) => { try { return fs.existsSync(vaultFile(workerDir, orderId)); } catch { return false; } };
// Nur im Speicher entschlüsseln (Adapter-Aufruf) – nie speichern, nie loggen, nie zurückgeben an Cloud/Dashboard.
export function openAccessCredential(workerDir, orderId) {
  const f = vaultFile(workerDir, orderId);
  if (!fs.existsSync(f)) return null;
  return openEnvelope(JSON.parse(fs.readFileSync(f, "utf8")).envelope, accessKeys(workerDir).privateKeyPem);
}
// Zerstören: Datei mit Zufallsbytes überschreiben, dann löschen. Rückgabe: ob ein Eintrag existierte.
export function destroyAccessSecret(workerDir, orderId) {
  const f = vaultFile(workerDir, orderId);
  if (!fs.existsSync(f)) return false;
  try { const n = fs.statSync(f).size; fs.writeFileSync(f, crypto.randomBytes(Math.max(n, 1))); } catch {}
  fs.rmSync(f, { force: true });
  return true;
}
// Metadaten am Auftrag nachführen (Zerstörung) – nie Zugangsdaten.
export function markSecretDestroyed(order, { now = new Date(), existed = true } = {}) {
  if (!order.access_intake) return order;
  order.access_intake = { ...order.access_intake, status: "DESTROYED", destroyed_at: now.toISOString(), revoked_required: true, ...(existed ? {} : { note: "kein Tresor-Eintrag vorhanden" }) };
  return order;
}

// ---------- Abholen + fail-closed prüfen + übernehmen ----------
export function applyAccessSubmission(store, s, { workerDir = store.dir, now = new Date() } = {}) {
  const reject = (reason) => ({ ok: false, reason });
  if (!s || !ORDER_ID_RE.test(String(s.order_id))) return reject("order_id ungültig");
  if (s.submission?.purpose === "host_key_confirmation") return applyHostKeyConfirmation(store, s, { now });
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const order = data.orders?.[s.order_id];
  if (!order) return reject("Auftrag unbekannt");
  const sub = s.submission || {};
  const deny = (reason) => {
    order.access_intake_rejections = [...(order.access_intake_rejections || []), { at: now.toISOString(), reason }].slice(-10);
    order.updated_at = now.toISOString();
    data.orders[order.order_id] = order; store.write(REPAIR_ORDERS_FILE, data);
    return reject(reason);
  };
  if (order.state !== "ACCESS_REQUESTED") return deny(`Auftrag nicht im Zustand ACCESS_REQUESTED (${order.state})`);
  if (order.access_intake?.status === "RECEIVED") return deny("Zugang bereits erhalten – One-Time-Link");
  const ar = order.access_request || {};
  if (!ar.token_hash || !safeEqual(ar.token_hash, s.token_hash)) return deny("Token passt nicht zum Auftrag");
  if (!Date.parse(sub.submitted_at) || Date.parse(sub.submitted_at) > Date.parse(ar.expires_at)) return deny("Link war abgelaufen");
  if (normDomain(s.domain) !== order.domain || normDomain(sub.access_domain) !== order.domain) return deny("Domain stimmt nicht mit dem Auftrag überein");
  const loc = order.market === "VN" ? "vi-VN" : "de-CH"; // TF-064: Freigabetext in der Sprache des Auftrags
  if (sub.consent !== true || sub.consent_text !== consentText(order.domain, loc)) return deny("Reparaturfreigabe fehlt");
  if (!ACCESS_TYPES.includes(sub.access_type)) return deny("Zugangsart unbekannt");
  const submittedProvider = sub.provider || null;
  // Bereits vor TF-032 übermittelte, gültige Einreichungen enthalten noch kein Profil. Sie bleiben kompatibel;
  // neue Cloud-Einreichungen müssen das serverseitig validierte Profil mitliefern.
  const profile = submittedProvider ? PROVIDER_REGISTRY[submittedProvider.provider_id] : providerProfileForDetection(order.platform || {});
  const provider = submittedProvider || { provider_id: profile.id, access_type: sub.access_type, automation: profile.automation };
  if (!profile || provider.access_type !== sub.access_type || provider.automation !== profile.automation || !profile.access_types.includes(sub.access_type))
    return deny("Anbieterprofil oder Zugangsart ungültig");
  // TF-071: Link für einen bestimmten Zugangsweg → nur dessen Zugangsart (wie in der Cloud geprüft, hier erneut).
  if (order.platform?.connector_type && order.platform.access_type && sub.access_type !== order.platform.connector_type) return deny("Zugangsart passt nicht zum Auftrag");
  if (!paymentGateForOrder(store, order).satisfied) return deny("Zahlungsschwelle nicht erfüllt");
  try { openEnvelope(sub.envelope, accessKeys(workerDir).privateKeyPem); } // nur Prüfung – Klartext wird sofort verworfen
  catch { return deny("Zugangsdaten nicht entschlüsselbar"); }
  storeAccessSecret(workerDir, order.order_id, sub.envelope, now);
  const at = now.toISOString();
  order.access_intake = { status: "RECEIVED", connector_type: sub.access_type,
    ...(submittedProvider ? { provider: { provider_id: profile.id, ...(submittedProvider.provider_name ? { provider_name: submittedProvider.provider_name } : {}), access_type: sub.access_type, automation: profile.automation } } : {}),
    access_domain: order.domain, received_at: at, destroyed_at: null, revoked_required: true };
  // Reparaturfreigabe aus dem Formular – getrennt von der Zahlung, nur mit ausdrücklicher Zustimmung. Keine Zugangsdaten hier.
  order.customer_authorized_repair = true;
  order.authorization = { authorized_domain: order.domain, source: ACCESS_AUTH_SOURCE, reference: `Sicheres Auftragsformular ${sub.submitted_at.slice(0, 10)}`, granted_at: sub.submitted_at, scope: repairScope(loc) };
  Object.assign(order, { authorization_at: sub.submitted_at, authorization_source: ACCESS_AUTH_SOURCE, authorized_domain: order.domain, scope: repairScope(loc) });
  order.updated_at = at;
  data.orders[order.order_id] = order;
  store.write(REPAIR_ORDERS_FILE, data);
  return { ok: true, connector_type: sub.access_type };
}

// Host-Key-Bestätigung des Kunden (TF-043) – fail closed: richtiger Zustand, Token-Hash des Bestätigungslinks, nicht abgelaufen,
// Domain exakt, Zahlungsschwelle erfüllt, bestätigter Fingerprint == gespeicherter Kandidat (exakt). Kein Chiffrat, keine Secrets.
export function applyHostKeyConfirmation(store, s, { now = new Date() } = {}) {
  const reject = (reason) => ({ ok: false, reason });
  const data = store.read(REPAIR_ORDERS_FILE, { schema: 1, orders: {} });
  const order = data.orders?.[s.order_id];
  if (!order) return reject("Auftrag unbekannt");
  const sub = s.submission || {};
  const deny = (reason) => {
    order.access_intake_rejections = [...(order.access_intake_rejections || []), { at: now.toISOString(), reason }].slice(-10);
    order.updated_at = now.toISOString();
    data.orders[order.order_id] = order; store.write(REPAIR_ORDERS_FILE, data);
    return reject(reason);
  };
  if (order.state !== "HOST_KEY_CONFIRMATION_REQUIRED") return deny(`Auftrag nicht im Zustand HOST_KEY_CONFIRMATION_REQUIRED (${order.state})`);
  const hr = order.host_key_request || {};
  if (hr.received_at) return deny("Bestätigung bereits erhalten – One-Time-Link");
  if (!hr.token_hash || !safeEqual(hr.token_hash, s.token_hash)) return deny("Token passt nicht zum Auftrag");
  if (!Date.parse(sub.submitted_at) || Date.parse(sub.submitted_at) > Date.parse(hr.expires_at)) return deny("Link war abgelaufen");
  if (normDomain(s.domain) !== order.domain || normDomain(sub.access_domain) !== order.domain) return deny("Domain stimmt nicht mit dem Auftrag überein");
  const candidate = order.access_profile?.host_key_candidate;
  if (!candidate || hr.host_key_candidate !== candidate || sub.host_key !== candidate) return deny("Fingerprint passt nicht zum gespeicherten Kandidaten");
  if (!["confirm", "reject"].includes(sub.decision)) return deny("Entscheidung fehlt");
  if (sub.decision === "confirm" && (sub.consent !== true || sub.confirm_text !== hostKeyConfirmText(order.domain, order.market === "VN" ? "vi-VN" : "de-CH"))) return deny("Bestätigung fehlt");
  if (!paymentGateForOrder(store, order).satisfied) return deny("Zahlungsschwelle nicht erfüllt");
  const at = now.toISOString();
  order.host_key_request = { ...hr, received_at: at, decision: sub.decision };
  order.access_profile = sub.decision === "confirm"
    ? { ...order.access_profile, host_key_sha256: candidate, host_key_source: "customer_confirmation", host_key_confirmed_at: sub.submitted_at, updated_at: at }
    : { ...order.access_profile, host_key_rejected_at: sub.submitted_at, updated_at: at };
  order.updated_at = at;
  data.orders[order.order_id] = order;
  store.write(REPAIR_ORDERS_FILE, data);
  return { ok: true, connector_type: "host_key_confirmation", decision: sub.decision };
}

// Ein Abgleich: alle Einreichungen holen, je Auftrag übernehmen oder ablehnen, IMMER quittieren (Link ist danach tot,
// das Chiffrat aus der Cloud entfernt). Netzfehler → nichts verändert, nächster Lauf. Gibt nie Inhalte aus.
export async function syncAccessIntake({ store, intake, now = () => new Date(), log = () => {} }) {
  if (!intake) return { accepted: 0, rejected: 0, skipped: "kein Intake-Client" };
  let subs;
  try { subs = await intake.pull(); } catch (e) { log("warn", "access_intake_pull_failed", { error: String(e.message).slice(0, 80) }); return { accepted: 0, rejected: 0, error: true }; }
  let accepted = 0, rejected = 0;
  for (const s of Array.isArray(subs) ? subs.slice(0, 50) : []) {
    const r = applyAccessSubmission(store, s, { now: now() });
    if (r.ok) { accepted++; log("info", "access_intake_received", { order_id: s.order_id, connector_type: r.connector_type }); }
    else { rejected++; log("warn", "access_intake_rejected", { order_id: ORDER_ID_RE.test(String(s?.order_id)) ? s.order_id : null, reason: r.reason }); }
    try { await intake.ack(s.token_hash); } catch (e) { log("warn", "access_intake_ack_failed", { order_id: s.order_id, error: String(e.message).slice(0, 80) }); }
  }
  return { accepted, rejected };
}

// ---------- Kommandozeile ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, id] = process.argv.slice(2);
  const flag = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  try {
    const data = store.read(REPAIR_ORDERS_FILE, { orders: {} });
    const order = data.orders?.[id];
    if (!order) throw new Error(`Kein Reparaturauftrag "${id}".`);
    if (cmd === "status") {
      console.log(JSON.stringify({ order_id: id, state: order.state, access_intake: order.access_intake || null, vault: hasAccessSecret(WORKER_DIR, id),
        access_request: order.access_request ? { sent_at: order.access_request.sent_at || null, expires_at: order.access_request.expires_at || null } : null }, null, 2));
    } else if (cmd === "destroy") {
      if (!String(flag("reason") || "").trim()) throw new Error('Begründung ist Pflicht: --reason "<grund>".');
      const existed = destroyAccessSecret(WORKER_DIR, id);
      markSecretDestroyed(order, { existed });
      order.state_history.push({ at: new Date().toISOString(), from: order.state, to: order.state, reason: `Zugangsdaten zerstört: ${String(flag("reason")).slice(0, 120)}` });
      store.write(REPAIR_ORDERS_FILE, data);
      console.log(existed ? "Tresor-Eintrag zerstört. Bitte den Kunden bitten, den temporären Zugang zu widerrufen." : "Kein Tresor-Eintrag vorhanden.");
    } else if (cmd === "reveal") {
      if (!process.argv.includes("--confirm")) throw new Error("Nur mit --confirm (Ausgabe nur auf stdout, nie in Logs/Dateien).");
      const c = openAccessCredential(WORKER_DIR, id);
      if (!c) throw new Error("Kein Tresor-Eintrag vorhanden.");
      process.stdout.write(JSON.stringify(c, null, 2) + "\n");
    } else { console.log('Befehle: status <order_id> | destroy <order_id> --reason "<grund>" | reveal <order_id> --confirm'); process.exit(1); }
  } catch (e) { console.error("Fehler: " + e.message); process.exit(1); }
}
