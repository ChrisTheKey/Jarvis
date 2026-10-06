// Erledigte Meldungen (Tombstones): dürfen nach keinem Abgleich Lokal ↔ Cloud wieder auftauchen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStateHandler, memoryStore, sanitizeState, mergeState, mergeDismissed, pruneDismissed, mergeNotifications, findSensitiveKeys, LIMITS } from "../shared-state.js";
import { createLocalState, syncWithCloud } from "../local-state.js";

const T0 = new Date("2026-10-06T08:00:00Z");
const ENV = { JARVIS_PASSWORD: "pw-test", JARVIS_SYNC_TOKEN: "sync-test-token" };
const asLocal = { "x-jarvis-sync": ENV.JARVIS_SYNC_TOKEN }, asSir = { "x-jarvis-key": ENV.JARVIS_PASSWORD };
const req = (method, body, headers = {}) => new Request("https://jarvis.test/api/state", { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
const viaHandler = (handler) => async (url, opts) => handler(new Request(url, opts));
const cfg = { url: "https://jarvis.test/api/state", token: ENV.JARVIS_SYNC_TOKEN };
const note = (id, createdAt = T0.toISOString(), extra = {}) => ({ id, type: "human_contact_requested", priority: "high", createdAt, updatedAt: createdAt, summary: "Muster AG möchte telefonieren.", status: "unread", ...extra });

let dir, local, store, handler;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-dismiss-"));
  local = createLocalState({ file: path.join(dir, "shared_state.json"), now: () => T0 });
  store = memoryStore();
  handler = createStateHandler({ getStore: async () => store, env: (k) => ENV[k], now: () => T0 });
});
const sync = () => syncWithCloud({ local, fetchFn: viaHandler(handler), config: cfg, force: true, now: () => T0 });

test("lokal erledigt → verschwindet auch in der Cloud und kommt nach weiteren Syncs nicht zurück", async () => {
  const a = local.addNotification({ sourceId: "msg-1", company: "Muster AG", summary: "Muster AG möchte telefonieren.", threadId: "t1" });
  local.addNotification({ sourceId: "msg-2", company: "Beta GmbH", summary: "Beta möchte einen Termin.", threadId: "t2" });
  await sync();
  assert.equal(store.peek().notifications.length, 2);
  local.dismiss(a.id);
  assert.ok(!local.read().notifications.some((n) => n.id === a.id));
  for (let i = 0; i < 3; i++) await sync();
  assert.ok(!local.read().notifications.some((n) => n.id === a.id), "lokal nicht auferstanden");
  assert.ok(!store.peek().notifications.some((n) => n.id === a.id), "Cloud übernimmt den Tombstone");
  assert.deepEqual(store.peek().dismissed.ids.map((x) => x.id), [a.id]);
  assert.equal(store.peek().notifications.length, 1, "andere Meldungen bleiben");
});

test("in der Cloud erledigt → lokal entfernt; ein alter lokaler Stand bringt sie nicht zurück", async () => {
  const a = local.addNotification({ sourceId: "msg-1", summary: "Muster AG möchte telefonieren.", threadId: "t1" });
  await sync();
  const r = await handler(req("POST", { op: "dismiss", id: a.id }, asSir));
  assert.equal(r.status, 200);
  assert.ok(!(await r.json()).notifications.some((n) => n.id === a.id));
  await sync();
  assert.ok(!local.read().notifications.some((n) => n.id === a.id));
  // Ein anderer lokaler Stand ohne Tombstone (z. B. Backup) synchronisiert die Meldung erneut – sie bleibt weg.
  await handler(req("POST", { op: "sync", state: { notifications: [note(a.id)] } }, asLocal));
  assert.ok(!store.peek().notifications.some((n) => n.id === a.id));
  // Die gleiche Gmail-Nachricht erzeugt keinen neuen Alarm mehr
  assert.equal(local.addNotification({ sourceId: "msg-1", summary: "nochmal" }).created, false);
  assert.ok(!local.read().notifications.some((n) => n.id === a.id));
});

test("Tombstone-Merge: Vereinigung beider Seiten, früheste Erledigung, unabhängig von der Reihenfolge", () => {
  const A = { dismissed: { ids: [{ id: "hc-aaaa", at: "2026-10-05T10:00:00Z" }, { id: "hc-bbbb", at: "2026-10-06T07:00:00Z" }] }, notifications: [note("hc-aaaa", "2026-10-05T09:00:00Z"), note("hc-cccc")] };
  const B = { dismissed: { ids: [{ id: "hc-bbbb", at: "2026-10-06T06:00:00Z" }, { id: "hc-cccc", at: "2026-10-06T07:30:00Z" }] }, notifications: [note("hc-bbbb"), note("hc-dddd")] };
  const ab = mergeState(A, B, { fromLocal: true }), ba = mergeState(B, A, { fromLocal: true });
  for (const m of [ab, ba]) {
    assert.deepEqual(m.dismissed.ids.map((x) => x.id).sort(), ["hc-aaaa", "hc-bbbb", "hc-cccc"]);
    assert.equal(m.dismissed.ids.find((x) => x.id === "hc-bbbb").at, "2026-10-06T06:00:00.000Z");
    assert.deepEqual(m.notifications.map((n) => n.id), ["hc-dddd"]);
  }
  // Read/Unread bleibt unverändert: gelesen gewinnt weiterhin
  const merged = mergeNotifications([note("hc-eeee", T0.toISOString(), { status: "read", readAt: T0.toISOString() })], [note("hc-eeee")]);
  assert.equal(merged[0].status, "read");
});

test("Tombstones sind begrenzt und bereinigt – trotzdem keine Auferstehung", () => {
  const ids = Array.from({ length: LIMITS.tombstones + 20 }, (_, i) => ({ id: `hc-${String(i).padStart(6, "0")}`, at: new Date(+T0 - (LIMITS.tombstones + 20 - i) * 60_000).toISOString() }));
  const old = { id: "hc-veryold", at: new Date(+T0 - (LIMITS.tombstoneDays + 5) * 86_400_000).toISOString() };
  const p = pruneDismissed({ ids: [...ids, old, { id: "INVALID ID", at: T0.toISOString() }, { id: "hc-noat" }] }, T0);
  assert.equal(p.ids.length, LIMITS.tombstones);
  assert.ok(!p.ids.some((x) => x.id === "hc-veryold" || x.id === "INVALID ID" || x.id === "hc-noat"));
  assert.ok(p.before, "Verdrängtes wird über 'before' abgedeckt");
  // Eine verdrängte Meldung (früher erstellt als ihr Tombstone) taucht über einen alten Stand nicht wieder auf
  const s = sanitizeState({ dismissed: p, notifications: [note("hc-000000", new Date(+T0 - 10 * 86_400_000).toISOString()), note("hc-veryold", old.at), note("hc-neu1")] });
  assert.deepEqual(s.notifications.map((n) => n.id), ["hc-neu1"]);
  const again = mergeDismissed(p, { ids: [], before: null }, T0);
  assert.equal(again.before, p.before, "before geht beim Merge nie verloren");
});

test("Dismiss-Endpunkt: nur mit Berechtigung, nur gültige IDs, keine sensiblen Felder", async () => {
  assert.equal((await handler(req("POST", { op: "dismiss", id: "hc-aaaa1111" }))).status, 401);
  assert.equal((await handler(req("POST", { op: "dismiss", id: "../../x" }, asSir))).status, 400);
  assert.equal((await handler(req("POST", { op: "dismiss", id: "hc-aaaa1111", threadId: "x" }, asSir))).status, 400);
  assert.equal((await handler(req("POST", { op: "dismiss", id: "hc-aaaa1111" }, asSir))).status, 200);
  assert.deepEqual(findSensitiveKeys(store.peek()), []);
});

test("synthetisches Testevent hc-eefb921a08e33602 lässt sich sauber entfernen", async () => {
  const id = "hc-eefb921a08e33602";
  local.update((s) => ({ ...s, notifications: [note(id, "2026-10-06T07:00:00Z", { status: "read", readAt: "2026-10-06T07:10:00Z" })] }));
  await handler(req("POST", { op: "sync", state: { notifications: [note(id, "2026-10-06T07:00:00Z")] } }, asLocal));
  local.dismiss(id);
  await sync();
  assert.ok(!local.read().notifications.some((n) => n.id === id));
  assert.ok(!store.peek().notifications.some((n) => n.id === id));
});
