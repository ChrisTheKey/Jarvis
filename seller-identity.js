// Vietnam-Verkäufer-Identität (TF-070) – ohne Abhängigkeiten (Netlify Functions, Edge, VPS, Tests). Reine Funktionen.
//
// Das bestehende Konto «lap» wurde in «Kudoshin» umbenannt – KEIN neuer Verkäufer: Passwort, Rolle SALES_AGENT_VN, vi-VN, Markt VN,
// VN-Leads, Aufträge, Provisionen, Auszahlungen, Calling-Kampagnen und Rückrufe gehen vollständig an Kudoshin über.
//   current seller_id: Kudoshin   (einzige aktive Identität; Login, RBAC, neue Datensätze)
//   legacy seller_id:  lap        (nur noch in unveränderlichen Audit-/Verlaufsdaten und in dieser Migrationslogik)
// «lap» meldet sich nicht mehr an, ist kein Verkäufer, kein Alias und wird nie wieder geschrieben.
//
// Migrationen: idempotent, ändern nur die Verkäufer-Identität (nie Preise, Währungen, Status, Beträge), legen nie Einträge an oder
// löschen fachliche Einträge. Audit-Listen (audit[], history[] im Provisionsbuch, Auth-Audit) bleiben bewusst unverändert.
export const VN_SELLER_ID = "Kudoshin";
export const LEGACY_VN_SELLER_ID = "lap";
export const IDENTITY_MIGRATION = "TF-070";

// Für Anzeige/Abgleich historischer Werte: «lap» → «Kudoshin», alles andere unverändert.
export const canonicalSellerId = (id) => (id === LEGACY_VN_SELLER_ID ? VN_SELLER_ID : id);
const isLegacy = (v) => v === LEGACY_VN_SELLER_ID;
const obj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

// Felder eines Datensatzes von «lap» auf «Kudoshin» setzen; zählt Änderungen.
function renameFields(rec, fields, counter) {
  if (!obj(rec)) return rec;
  let next = rec;
  for (const f of fields) if (isLegacy(rec[f])) { if (next === rec) next = { ...rec }; next[f] = VN_SELLER_ID; counter.n++; }
  return next;
}
const result = (doc, changed, counts) => ({ doc, changed, counts });

// ---------- Auth: jarvis-auth/users + sessions ----------
// users.lap → users.Kudoshin (Passwort-Hash, aktiv, Zeitpunkte unverändert übernommen). Hat Kudoshin bereits einen Datensatz,
// gewinnen dessen gesetzte Felder (erneuter Lauf überschreibt nie ein neueres Passwort). users.lap wird entfernt → kein Login mehr.
export function migrateAuthUsers(doc, { now = new Date() } = {}) {
  if (!obj(doc) || !obj(doc.users) || !Object.hasOwn(doc.users, LEGACY_VN_SELLER_ID)) return result(doc, false, { users: 0 });
  const users = { ...doc.users };
  const legacy = obj(users[LEGACY_VN_SELLER_ID]) ? users[LEGACY_VN_SELLER_ID] : {};
  const cur = obj(users[VN_SELLER_ID]) ? users[VN_SELLER_ID] : {};
  const merged = { ...legacy };
  for (const [k, v] of Object.entries(cur)) if (v !== null && v !== undefined) merged[k] = v;
  users[VN_SELLER_ID] = merged;
  delete users[LEGACY_VN_SELLER_ID];
  const mig = { ...(obj(doc.identity_migrations) ? doc.identity_migrations : {}) };
  mig[IDENTITY_MIGRATION] ||= { from: LEGACY_VN_SELLER_ID, to: VN_SELLER_ID, at: now.toISOString(), password_transferred: !!merged.password };
  return result({ ...doc, users, identity_migrations: mig }, true, { users: 1 });
}
// Bestehende «lap»-Sitzungen sind ohnehin ungültig (kein Benutzer «lap» mehr) – sie werden entfernt, nie umgeschrieben.
export function migrateAuthSessions(doc) {
  if (!obj(doc) || !obj(doc.sessions)) return result(doc, false, { sessions: 0 });
  const keep = Object.entries(doc.sessions).filter(([, s]) => !isLegacy(s?.user_id));
  const removed = Object.keys(doc.sessions).length - keep.length;
  return removed ? result({ ...doc, sessions: Object.fromEntries(keep) }, true, { sessions: removed }) : result(doc, false, { sessions: 0 });
}

// ---------- Provisionsbuch: jarvis-sales/commissions ----------
// entries[].seller_id / seller_override und payouts[].seller_id. Beträge, Status, Sperre, history[] und audit[] bleiben unverändert.
export function migrateLedger(L) {
  if (!obj(L)) return result(L, false, { entries: 0, payouts: 0 });
  const e = { n: 0 }, p = { n: 0 };
  let entries = L.entries;
  if (obj(L.entries)) {
    let copy = null;
    for (const [id, x] of Object.entries(L.entries)) { const y = renameFields(x, ["seller_id", "seller_override"], e); if (y !== x) (copy ||= { ...L.entries })[id] = y; }
    if (copy) entries = copy;
  }
  const payouts = Array.isArray(L.payouts) ? L.payouts.map((x) => renameFields(x, ["seller_id"], p)) : L.payouts;
  return e.n || p.n ? result({ ...L, entries, payouts }, true, { entries: e.n, payouts: p.n }) : result(L, false, { entries: 0, payouts: 0 });
}

// ---------- Bestätigte VN-Auftragsanfragen: jarvis-sales/orders ----------
export function migrateOrderRequests(doc) {
  if (!obj(doc) || !Array.isArray(doc.requests)) return result(doc, false, { requests: 0 });
  const c = { n: 0 };
  const requests = doc.requests.map((r) => renameFields(r, ["seller_id", "actor_user_id"], c));
  return c.n ? result({ ...doc, requests }, true, { requests: c.n }) : result(doc, false, { requests: 0 });
}

// ---------- Calling: jarvis-calling/control + history ----------
// Kampagnen (owner_user_id) und Anrufe (seller, seller_id, actor_user_id). Audit, Einwilligungsnachweise und Rückrufe bleiben –
// Rückrufe hängen am Lead (Scope über sales-scope), nicht am Benutzer.
const CALL_FIELDS = ["seller", "seller_id", "actor_user_id"];
export function migrateCallingControl(doc) {
  if (!obj(doc)) return result(doc, false, { campaigns: 0, calls: 0 });
  const camp = { n: 0 }, call = { n: 0 };
  const campaigns = Array.isArray(doc.campaigns) ? doc.campaigns.map((x) => renameFields(x, ["owner_user_id"], camp)) : doc.campaigns;
  let calls = doc.calls;
  if (obj(doc.calls)) {
    let copy = null;
    for (const [id, x] of Object.entries(doc.calls)) { const y = renameFields(x, CALL_FIELDS, call); if (y !== x) (copy ||= { ...doc.calls })[id] = y; }
    if (copy) calls = copy;
  }
  return camp.n || call.n ? result({ ...doc, campaigns, calls }, true, { campaigns: camp.n, calls: call.n }) : result(doc, false, { campaigns: 0, calls: 0 });
}
export function migrateCallingHistory(doc) {
  if (!obj(doc) || !Array.isArray(doc.calls)) return result(doc, false, { calls: 0 });
  const c = { n: 0 };
  const calls = doc.calls.map((x) => renameFields(x, CALL_FIELDS, c));
  return c.n ? result({ ...doc, calls }, true, { calls: c.n }) : result(doc, false, { calls: 0 });
}

// ---------- CRM-Warteschlangen: jarvis-crm/queue + vn-queue (Schreibaufträge des Verkäufers) ----------
export function migrateCrmQueue(doc) {
  if (!obj(doc) || !Array.isArray(doc.requests)) return result(doc, false, { requests: 0 });
  const c = { n: 0 };
  const requests = doc.requests.map((r) => renameFields(r, ["actor_user_id"], c));
  return c.n ? result({ ...doc, requests }, true, { requests: c.n }) : result(doc, false, { requests: 0 });
}

// ---------- Mail-Aufträge: jarvis-mail-requests/queue (requested_by + serverseitige Metadaten) ----------
export function migrateMailQueue(doc) {
  if (!obj(doc) || !Array.isArray(doc.requests)) return result(doc, false, { requests: 0 });
  const c = { n: 0 };
  const requests = doc.requests.map((r) => {
    let x = renameFields(r, ["requested_by"], c);
    if (obj(x?.meta) && isLegacy(x.meta.actor_user_id)) { x = { ...x, meta: { ...x.meta, actor_user_id: VN_SELLER_ID } }; c.n++; }
    return x;
  });
  return c.n ? result({ ...doc, requests }, true, { requests: c.n }) : result(doc, false, { requests: 0 });
}

// ---------- Laufzeit ----------
// Ein Blob-Dokument bedingt (etag) migrieren. Kein Dokument / nichts zu tun → keine Schreiboperation.
export async function migrateStoreDoc(store, migrate) {
  for (let i = 0; i < 6; i++) {
    const { state, etag } = await store.get();
    if (!state) return { changed: false, counts: {} };
    const r = migrate(state);
    if (!r.changed) return r;
    if (await store.set(r.doc, etag)) return r;
  }
  throw new Error("Identitäts-Migration: gleichzeitige Änderung – nächster Aufruf versucht es erneut.");
}
// Einmal je Funktionsinstanz (bei Fehler beim nächsten Aufruf erneut). Ein Fehler blockiert den Request nie.
export function migrateOnce(run) {
  let p = null;
  return () => (p ||= Promise.resolve().then(run).catch((e) => { p = null; console.warn(`[${IDENTITY_MIGRATION}] ${e?.message || e}`); return null; }));
}
