// Kunden-Onboarding (TF-066) – Datei-Protokoll zwischen Repair-Service und Mail-Worker im gemeinsamen Outbox-Verzeichnis
// (/opt/jarvis-repair/outbox/onboarding). Wie die Repair-Outbox (TF-047): je Datei GENAU EIN Schreiber, jede Datei atomar.
//
//   orders.json                 Repair-Service  Auftragsfakten fürs Onboarding (Zahlungsschwelle, Zugangsstatus, Kunde, Markt …)
//                                               – nie Zugangsdaten, Token, Links, Zahlungsreferenzen oder Berichte
//   briefs/<order_id>.json      Mail-Worker     Kunden-Brief (Status + NUR bestätigte strukturierte Änderungen) fürs Brief-Gate
//   requests/<order_id>-<n>.json Mail-Worker    Bitte um einen NEUEN sicheren Link (abgelaufen; Reminder/Passwort per Mail/Kundenfrage).
//                                               Der Repair-Service quittiert in orders.json (reissues[n]) – nie umgekehrt schreiben.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ORDER_ID_RE } from "./pricing.js";

export const ONBOARDING_SUBDIR = "onboarding";
export const ORDERS_FILE = "orders.json";
export const BRIEFS_DIR = "briefs";
export const REQUESTS_DIR = "requests";
export const onboardingDirOf = (outboxDir) => (outboxDir ? path.join(outboxDir, ONBOARDING_SUBDIR) : null);

const readJson = (f, fb = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
export function writeAtomic(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const okId = (id) => ORDER_ID_RE.test(String(id || ""));

// ---------- orders.json (Schreiber: Repair-Service) ----------
export const readOrdersExport = (dir) => (dir ? readJson(path.join(dir, ORDERS_FILE), null) : null) || { v: 1, orders: {} };
// Nur schreiben, wenn sich etwas geändert hat (ohne Zeitstempel verglichen) – kein unnötiger Schreibverkehr alle 2 Minuten.
export function writeOrdersExport(dir, orders, { now = new Date() } = {}) {
  const cur = readOrdersExport(dir);
  if (JSON.stringify(cur.orders || {}) === JSON.stringify(orders)) return { written: false, orders: Object.keys(orders).length };
  writeAtomic(path.join(dir, ORDERS_FILE), { v: 1, at: now.toISOString(), orders });
  return { written: true, orders: Object.keys(orders).length };
}

// ---------- briefs/<order_id>.json (Schreiber: Mail-Worker) ----------
export function readBrief(dir, orderId) {
  if (!dir || !okId(orderId)) return null;
  const b = readJson(path.join(dir, BRIEFS_DIR, `${orderId}.json`), null);
  return b && b.order_id === orderId ? b : null;
}
export function writeBrief(dir, exp) {
  if (!dir || !okId(exp?.order_id)) return false;
  const f = path.join(dir, BRIEFS_DIR, `${exp.order_id}.json`);
  const cur = readJson(f, null);
  const { updated_at: _a, ...x } = exp, { updated_at: _b, ...y } = cur || {};
  if (cur && JSON.stringify(x) === JSON.stringify(y)) return false;
  writeAtomic(f, exp);
  return true;
}

// ---------- requests/ (Schreiber: Mail-Worker) ----------
export const REISSUE_REASONS = Object.freeze(["reminder", "sensitive", "customer_request"]);
export function writeReissueRequest(dir, { order_id, seq, reason, now = new Date() }) {
  if (!dir || !okId(order_id) || !Number.isInteger(seq) || seq < 1 || seq > 99 || !REISSUE_REASONS.includes(reason)) throw new Error("Ungültige Link-Anfrage.");
  const f = path.join(dir, REQUESTS_DIR, `${order_id}-${seq}.json`);
  if (fs.existsSync(f)) return false;
  writeAtomic(f, { v: 1, order_id, seq, reason, at: now.toISOString() });
  return true;
}
export function listReissueRequests(dir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dir, REQUESTS_DIR)); } catch { return []; }
  return names.filter((n) => /^[A-Z0-9]+-\d{8}-[0-9a-f]{6}-\d{1,2}\.json$/.test(n)).map((n) => readJson(path.join(dir, REQUESTS_DIR, n), null))
    .filter((r) => r && okId(r.order_id) && Number.isInteger(r.seq) && REISSUE_REASONS.includes(r.reason));
}
export function removeReissueRequest(dir, { order_id, seq }) {
  if (!okId(order_id) || !Number.isInteger(seq)) return;
  try { fs.rmSync(path.join(dir, REQUESTS_DIR, `${order_id}-${seq}.json`), { force: true }); } catch {}
}
