// /api/payments – Zahlungseingangs-Webhook + Inbox (TF-068). Netlify Function.
//
//   POST (Provider)        signierter Webhook. Ohne konfigurierten Provider → 503 PAYMENT_MONITOR_NOT_CONFIGURED. Ungültige/abgelaufene
//                          Signatur → 400 (nichts gespeichert). Gültig → normalisiertes Ereignis in die Inbox (idempotent je Transaktion).
//   POST x-jarvis-worker   VPS (payment-reconcile.js pull): { op: "inbox.pull" } | { op: "inbox.ack", keys: [...] }
//   GET  (OWNER-Sitzung)   Überwachungsstatus + Inbox-Zähler (nie Beträge einzelner Kunden, nie Secrets)
// Hier wird NICHTS verbucht – das Zahlungsbuch liegt auf dem VPS (payments.js); der Abgleich läuft dort (payment-reconcile.js).
import { safeEqual } from "./shared-state.js";
import { resolveActor, isOwner, deny, forbidden } from "./auth-core.js";
import { monitorStatus, verifyStripeSignature, normalizeStripeEvent, txKey } from "./payment-monitor.js";

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const MAX_BODY = 256_000, INBOX_KEEP = 2000;
const emptyInbox = () => ({ schema: 1, events: [] });

export function createPaymentsHandler({ env, getStore, getAuthStore = null, now = () => new Date() }) {
  async function mutate(fn) {
    const store = await getStore("inbox");
    for (let i = 0; i < 6; i++) {
      const { state, etag } = await store.get();
      const cur = { ...emptyInbox(), ...(state || {}) };
      const res = fn(cur);
      if (await store.set(cur, etag)) return res;
    }
    throw new Error("conflict");
  }
  return async (req) => {
    const t = now();
    const ms = monitorStatus(env);
    if (req.method === "GET") {
      const a = await resolveActor(req, { env, getAuthStore, now });
      if (!a.actor) return deny(a);
      if (!isOwner(a.actor)) return forbidden("Nur der Owner.");
      const inbox = (await (await getStore("inbox")).get()).state || emptyInbox();
      return reply(200, { monitor: { status: ms.status, provider: ms.provider, kind: ms.kind, missing: ms.missing },
        inbox: { pending: inbox.events.filter((e) => e.status === "pending").length, delivered: inbox.events.filter((e) => e.status === "delivered").length, total: inbox.events.length } });
    }
    if (req.method !== "POST") return reply(405, { error: "Nur GET oder POST." });
    if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return reply(413, { error: "Zu gross." });
    const raw = await req.text();
    if (raw.length > MAX_BODY) return reply(413, { error: "Zu gross." });

    // VPS-Abgleich (gleicher Schlüssel wie die übrigen Dienste)
    if (req.headers.get("x-jarvis-worker") != null) {
      const tok = env("JARVIS_MAIL_WORKER_TOKEN");
      if (!tok || !safeEqual(req.headers.get("x-jarvis-worker"), tok)) return reply(401, { error: "Nicht berechtigt." });
      let body; try { body = JSON.parse(raw || "{}"); } catch { return reply(400, { error: "Ungültiges JSON." }); }
      if (body.op === "inbox.pull") {
        const inbox = (await (await getStore("inbox")).get()).state || emptyInbox();
        return reply(200, { events: inbox.events.filter((e) => e.status === "pending").slice(0, 200).map((e) => ({ key: e.key, tx: e.tx })) });
      }
      if (body.op === "inbox.ack" && Array.isArray(body.keys)) {
        const keys = new Set(body.keys.filter((k) => typeof k === "string").slice(0, 500));
        const n = await mutate((cur) => { let c = 0; for (const e of cur.events) if (keys.has(e.key) && e.status === "pending") { e.status = "delivered"; e.delivered_at = t.toISOString(); c++; } return c; });
        return reply(200, { ok: true, acked: n });
      }
      return reply(400, { error: "Unbekannte Operation." });
    }

    // Provider-Webhook
    if (ms.status !== "CONFIGURED" || ms.kind !== "signed_webhook") return reply(503, { error: "Zahlungsüberwachung nicht konfiguriert.", code: "PAYMENT_MONITOR_NOT_CONFIGURED" });
    let tx = null;
    if (ms.provider === "stripe") {
      const v = verifyStripeSignature(raw, req.headers.get("stripe-signature"), env("STRIPE_WEBHOOK_SECRET"), { now: t });
      if (!v.ok) return reply(400, { error: "Signatur ungültig.", code: v.code });
      let evt; try { evt = JSON.parse(raw); } catch { return reply(400, { error: "Ungültiges JSON." }); }
      tx = normalizeStripeEvent(evt);
    }
    if (!tx) return reply(200, { ok: true, ignored: true });
    const key = txKey(tx);
    if (!key) return reply(200, { ok: true, ignored: true, code: "NO_TRANSACTION_ID" });
    const dup = await mutate((cur) => {
      if (cur.events.some((e) => e.key === key)) return true;
      cur.events = [...cur.events, { key, tx, status: "pending", received_at: t.toISOString() }].slice(-INBOX_KEEP);
      return false;
    });
    return reply(200, { ok: true, duplicate: dup });
  };
}
