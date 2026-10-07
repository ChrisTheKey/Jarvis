// /api/backup – Offsite-Ablage der verschlüsselten State-Backups in Netlify Blobs (Store "jarvis-backups").
// Hochladen: nur der VPS-Worker (x-jarvis-worker). Auflisten/Herunterladen: Worker oder Chris (x-jarvis-key) – es gibt nur Chiffrat;
// entschlüsseln kann allein der Private Key von Chris. Kein Zugriff mit dem Sync-Token des optionalen Windows-Clients.
import { safeEqual } from "./shared-state.js";
import { verifyBackup, BACKUP_FORMAT } from "./backup.js";

export const OFFSITE_KEEP = 30;
export const MAX_BACKUP_BYTES = 5_000_000;
const KEY_RE = /^daily\/\d{4}-\d{2}-\d{2}$/;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function createBackupHandler({ getStore, env }) {
  return async (req) => {
    const workerToken = env("JARVIS_MAIL_WORKER_TOKEN"), password = env("JARVIS_PASSWORD");
    const isWorker = !!workerToken && safeEqual(req.headers.get("x-jarvis-worker"), workerToken);
    const isUser = !!password && safeEqual(req.headers.get("x-jarvis-key"), password);
    if (!isWorker && !isUser) return reply(401, { error: "Nicht berechtigt." });
    const store = await getStore();
    const url = new URL(req.url);
    if (req.method === "GET") {
      const key = url.searchParams.get("key");
      if (key) {
        if (!KEY_RE.test(key)) return reply(400, { error: "Ungültiger Schlüssel." });
        const bak = await store.get(key, { type: "json" });
        return bak ? reply(200, bak) : reply(404, { error: "Nicht gefunden." });
      }
      const { blobs } = await store.list({ prefix: "daily/" });
      return reply(200, { backups: blobs.map((b) => b.key).filter((k) => KEY_RE.test(k)).sort() });
    }
    if (req.method !== "POST") return reply(405, { error: "Nur GET oder POST." });
    if (!isWorker) return reply(403, { error: "Nur der Cloud Core darf Backups ablegen." });
    if (Number(req.headers.get("content-length") || 0) > MAX_BACKUP_BYTES) return reply(413, { error: "Zu gross." });
    const raw = await req.text();
    if (raw.length > MAX_BACKUP_BYTES) return reply(413, { error: "Zu gross." });
    let bak;
    try { bak = JSON.parse(raw); } catch { return reply(400, { error: "Ungültiges JSON." }); }
    // Nur verschlüsselte Backups im bekannten Format – nie Klartext annehmen.
    const v = verifyBackup(bak);
    if (bak?.format !== BACKUP_FORMAT || !v.ok || typeof bak.wrapped_key !== "string") return reply(400, { error: `Kein gültiges verschlüsseltes Backup: ${v.error || "Format"}` });
    const key = `daily/${String(bak.created_at).slice(0, 10)}`;
    if (!KEY_RE.test(key)) return reply(400, { error: "created_at fehlt." });
    await store.set(key, raw);
    const { blobs } = await store.list({ prefix: "daily/" });
    const all = blobs.map((b) => b.key).filter((k) => KEY_RE.test(k)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - OFFSITE_KEEP))) await store.delete(old);
    return reply(200, { ok: true, key, generations: Math.min(all.length, OFFSITE_KEEP) });
  };
}

// Upload-Funktion für den Worker (VPS): POST mit Worker-Token an <origin>/api/backup.
export function backupUploader({ config, fetchFn = globalThis.fetch }) {
  if (!config?.workerToken) return null;
  const url = config.url.replace(/\/api\/state$/, "") + "/api/backup";
  return async (env) => {
    const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-worker": config.workerToken }, body: JSON.stringify(env), signal: AbortSignal.timeout(60_000) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, key: j.key } : { ok: false, error: `HTTP ${r.status}` };
  };
}
