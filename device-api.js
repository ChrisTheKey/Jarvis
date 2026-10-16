// /api/devices/* – Geräte pro Benutzer (TF-073). Siehe device-core.js für Modell und Kernregel.
//
// Benutzer (Session-Cookie, CSRF über resolveActor):
//   GET  /api/devices                     eigene Geräte (keine → code DEVICE_NOT_PAIRED; nie ein Fallback auf Chris' Computer)
//   POST /api/devices/pair/start          Einmal-Code für ein EIGENES Gerät (10 min, einmalig, an Benutzer + Ablauf gebunden)
//   GET  /api/devices/{id}                eigenes Gerät + letzte Aktionen (nur Eigentümer)
//   POST /api/devices/{id}/revoke         Gerät widerrufen (nur Eigentümer)
//   POST /api/devices/{id}/session        Geräte-Sitzung öffnen (nur Eigentümer, Gerät aktiv, Konto aktiv)
//   POST /api/devices/{id}/session/close  { session_id }
//   POST /api/devices/{id}/actions        { session_id, action_id } – nur DEVICE_ACTIONS
// Owner (Cloud-Admin, KEINE Geräte-Steuerung):
//   GET  /api/devices/admin               Metadaten aller Geräte (Verkäufer, Name, Typ, online/offline, zuletzt gesehen)
//   POST /api/devices/{id}/disable|enable Gerät administrativ sperren/freigeben – öffnet nie eine Verbindung
//   POST /api/devices/{id}/release        widerrufenes/gesperrtes Gerät für eine explizite Neu-Kopplung freigeben (Eigentümerwechsel)
// Gerät (nur ausgehend, kein Cookie):
//   POST /api/devices/pair/complete       { flow, pairing_code, device_fp, device_name, device_type } → einmalig { device_id, device_credential }
//   POST /api/devices/channel             x-jarvis-device + x-jarvis-device-fp; { op: poll | result | rotate }
//
// Fremde Geräte (auch für Chris): immer 403 DEVICE_FORBIDDEN – gleiche Antwort für "gibt es nicht" und "gehört jemand anderem".
import { USERS, isOwner, sha256Hex, userRecord } from "./auth-core.js";
import { DEVICE_TYPES, PAIRING_FLOW, PAIRING_TTL_MS, MAX_OPEN_PAIRINGS, MAX_DEVICES_PER_USER, SESSION_TTL_MS, DEVICE_ACTIONS, DEVICE_HEADER, DEVICE_FP_HEADER,
  FP_RE, authorizeDeviceAccess, publicDevice, adminDevice, cleanDeviceName, cleanResult, parseDeviceCredential, credentialMatches, isDeviceId, isPairingCode,
  isSessionToken, isCommandId, newDeviceId, newCommandId, newDeviceSecret, newPairingCode, newSessionToken, emptyDevices, emptyPairings, emptyDeviceSessions,
  emptyCommands, emptyDeviceAudit } from "./device-core.js";

const AUDIT_KEEP = 2000, COMMANDS_KEEP = 500;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const FORBIDDEN = { error: "Kein Zugriff auf dieses Gerät.", code: "DEVICE_FORBIDDEN" };

async function update(store, key, fn, empty) {
  for (let i = 0; i < 6; i++) {
    const { state, etag } = await store[key].get();
    const cur = structuredClone(state || empty());
    const res = fn(cur);
    if (res === false) return false;
    if (await store[key].set(cur, etag)) return res === undefined ? true : res;
  }
  throw new Error("Gleichzeitige Änderung – bitte erneut versuchen.");
}
// Audit: nie Secrets, Codes, Tokens, Fingerprints oder Inhalte – nur Zeit, Akteur, Aktion, Gerät, Eigentümer, Ergebnis.
export async function deviceAudit(store, entry, now = new Date()) {
  await update(store, "audit", (a) => { a.entries = [...(a.entries || []), { ts: now.toISOString(), ...entry }].slice(-AUDIT_KEEP); }, emptyDeviceAudit).catch(() => {});
}

// Sitzungen + offene Befehle aller Geräte eines Benutzers beenden (Konto deaktiviert). Geräte gehen NICHT an Chris über.
export async function terminateUserDevices(store, { user_id, actor_user_id, reason = "account_disabled", now = new Date() }) {
  const { state } = await store.devices.get();
  const ids = new Set(Object.values(state?.devices || {}).filter((d) => d.owner_user_id === user_id).map((d) => d.device_id));
  let sessions = 0, commands = 0;
  await update(store, "sessions", (s) => { for (const x of Object.values(s.sessions || {})) if (ids.has(x.device_id) && !x.closed_at) { x.closed_at = now.toISOString(); x.close_reason = reason; sessions++; } }, emptyDeviceSessions);
  await update(store, "commands", (c) => { for (const x of c.commands || []) if (ids.has(x.device_id) && ["queued", "delivered"].includes(x.status)) { x.status = "cancelled"; x.done_at = now.toISOString(); commands++; } }, emptyCommands);
  await deviceAudit(store, { actor_user_id, action: "account.disabled", owner_user_id: user_id, result: "device_sessions_terminated", devices: ids.size, sessions, commands }, now);
  return { devices: ids.size, sessions, commands };
}

export function createDeviceHandler({ getStore, getAuthStore, resolveActor, now = () => new Date() }) {
  const audit = async (entry) => deviceAudit(await getStore(), entry, now());
  const readBody = async (req) => { try { return JSON.parse((await req.text()).slice(0, 4000) || "{}"); } catch { return null; } };
  async function accountActive(user_id) {
    if (!getAuthStore) return false; // fail closed
    try { const { state } = await (await getAuthStore()).users.get(); return userRecord(state, user_id).active; } catch { return false; }
  }
  async function devices() { return (await (await getStore()).devices.get()).state || emptyDevices(); }
  const mine = (doc, user_id) => Object.values(doc.devices || {}).filter((d) => d.owner_user_id === user_id);

  // Gemeinsame Prüfung für Benutzer-Zugriffe auf ein Gerät (Kernregel + Audit bei fremden Versuchen).
  async function gate(actor, device_id, action, action_id = null) {
    const d = isDeviceId(device_id) ? (await devices()).devices?.[device_id] : null;
    const a = authorizeDeviceAccess({ requesting_user_id: actor.user_id, device: d, action_id });
    if (!a.ok) {
      if (a.code === "DEVICE_FORBIDDEN") await audit({ actor_user_id: actor.user_id, action, device_id: isDeviceId(device_id) ? device_id : null, owner_user_id: d?.owner_user_id || null, result: "blocked_cross_user" });
      return { res: reply(a.status, a.code === "DEVICE_FORBIDDEN" ? FORBIDDEN : { error: a.error, code: a.code }) };
    }
    if (!(await accountActive(d.owner_user_id))) return { res: reply(403, { error: "Zugang deaktiviert.", code: "ACCOUNT_DISABLED" }) };
    return { device: d };
  }
  async function sessionOf(token, device, user_id) {
    if (!isSessionToken(token)) return null;
    const hash = await sha256Hex(token);
    const s = ((await (await getStore()).sessions.get()).state || emptyDeviceSessions()).sessions?.[hash];
    const t = +now();
    if (!s || s.closed_at || Date.parse(s.expires_at) <= t || s.device_id !== device.device_id || s.user_id !== user_id || s.user_id !== device.owner_user_id) return null;
    return { hash, ...s };
  }

  // ---------- Kopplung ----------
  async function pairStart(actor, body) {
    // Ein Benutzer koppelt nur an das EIGENE Konto – auch Chris nicht für andere.
    if (body.owner_user_id != null && body.owner_user_id !== actor.user_id) {
      await audit({ actor_user_id: actor.user_id, action: "device.pair_start", owner_user_id: String(body.owner_user_id).slice(0, 40), result: "blocked_other_user" });
      return reply(403, { error: "Geräte können nur dem eigenen Konto zugeordnet werden.", code: "PAIR_OTHER_USER" });
    }
    if (mine(await devices(), actor.user_id).filter((d) => d.status === "active").length >= MAX_DEVICES_PER_USER) return reply(409, { error: "Zu viele aktive Geräte.", code: "DEVICE_LIMIT" });
    const t = now(), code = newPairingCode(), hash = await sha256Hex(code), expires_at = new Date(+t + PAIRING_TTL_MS).toISOString();
    const ok = await update(await getStore(), "pairings", (p) => {
      // Abgelaufene/benutzte Codes nach 24 h entfernen (Replay bleibt durch used_at bis dahin nachweisbar).
      p.codes = Object.fromEntries(Object.entries(p.codes || {}).filter(([, c]) => +t - Date.parse(c.expires_at) < 86_400_000));
      const open = Object.values(p.codes).filter((c) => c.user_id === actor.user_id && !c.used_at && Date.parse(c.expires_at) > +t).length;
      if (open >= MAX_OPEN_PAIRINGS) return false;
      p.codes[hash] = { user_id: actor.user_id, flow: PAIRING_FLOW, created_at: t.toISOString(), expires_at, used_at: null };
    }, emptyPairings);
    if (!ok) return reply(429, { error: "Zu viele offene Kopplungs-Codes – bitte ablaufen lassen.", code: "PAIR_LIMIT" });
    await audit({ actor_user_id: actor.user_id, action: "device.pair_start", owner_user_id: actor.user_id, result: "success" });
    return reply(200, { pairing_code: code, flow: PAIRING_FLOW, expires_at });
  }

  async function pairComplete(body) {
    const block = async (status, code, error, extra = {}) => { await audit({ actor_user_id: extra.user_id || null, action: "device.pair_complete", owner_user_id: extra.user_id || null, result: code.toLowerCase() }); return reply(status, { error, code }); };
    if (body.flow !== PAIRING_FLOW || !isPairingCode(body.pairing_code)) return block(403, "PAIRING_INVALID", "Kopplungs-Code ungültig.");
    if (typeof body.device_fp !== "string" || !FP_RE.test(body.device_fp)) return reply(400, { error: "Geräte-Identität fehlt.", code: "BAD_DEVICE" });
    const name = cleanDeviceName(body.device_name);
    if (!name || !DEVICE_TYPES.includes(body.device_type)) return reply(400, { error: "device_name (2–60 Zeichen) und device_type pc|phone nötig.", code: "BAD_DEVICE" });
    const store = await getStore(), t = now(), hash = await sha256Hex(body.pairing_code);
    // Einmalig: Code atomar (etag) verbrauchen, bevor ein Gerät entsteht. Jeder weitere Versuch → PAIRING_USED.
    let why = null, user_id = null;
    await update(store, "pairings", (p) => {
      const c = p.codes?.[hash];
      if (!c || c.flow !== PAIRING_FLOW || !USERS[c.user_id]) { why = "PAIRING_INVALID"; return false; }
      user_id = c.user_id;
      if (c.used_at) { why = "PAIRING_USED"; return false; }
      if (Date.parse(c.expires_at) <= +t) { why = "PAIRING_EXPIRED"; return false; }
      c.used_at = t.toISOString();
    }, emptyPairings);
    if (why) return block(403, why, { PAIRING_INVALID: "Kopplungs-Code ungültig.", PAIRING_USED: "Kopplungs-Code wurde bereits verwendet.", PAIRING_EXPIRED: "Kopplungs-Code abgelaufen." }[why], { user_id });
    if (!(await accountActive(user_id))) return block(403, "ACCOUNT_DISABLED", "Zugang deaktiviert.", { user_id });
    const secret = newDeviceSecret(), credential_hash = await sha256Hex(secret), device_id = newDeviceId();
    let conflict = null;
    await update(store, "devices", (doc) => {
      const same = Object.values(doc.devices || {}).filter((d) => d.device_fp === body.device_fp);
      // Gleiche Geräte-Identität: aktiv → kein zweites Mal; früher fremd → nur nach expliziter Owner-Freigabe (release) neu koppeln.
      if (same.some((d) => d.status === "active")) { conflict = same.find((d) => d.status === "active").owner_user_id === user_id ? "DEVICE_ALREADY_PAIRED" : "DEVICE_OWNED_ELSEWHERE"; return false; }
      if (same.some((d) => d.owner_user_id !== user_id && !d.released_at)) { conflict = "DEVICE_OWNED_ELSEWHERE"; return false; }
      doc.devices ||= {};
      doc.devices[device_id] = { device_id, owner_user_id: user_id, device_type: body.device_type, device_name: name, created_at: t.toISOString(), last_seen_at: null,
        status: "active", device_fp: body.device_fp, credential_hash, credential_rotated_at: t.toISOString() };
    }, emptyDevices);
    if (conflict) return block(conflict === "DEVICE_ALREADY_PAIRED" ? 409 : 403, conflict, conflict === "DEVICE_ALREADY_PAIRED" ? "Gerät ist bereits gekoppelt." : "Gerät gehört einem anderen Konto.", { user_id });
    await audit({ actor_user_id: user_id, action: "device.paired", device_id, owner_user_id: user_id, device_type: body.device_type, result: "success" });
    // Das Secret verlässt den Server genau EINMAL – nur an den Agenten, nie in Listen, Logs oder Audit.
    return reply(200, { device_id, owner_user_id: user_id, device_credential: `${device_id}.${secret}` });
  }

  // ---------- Geräte-Kanal (Agent, nur ausgehend) ----------
  async function channel(req, body) {
    const cred = parseDeviceCredential(req.headers.get(DEVICE_HEADER));
    const fp = req.headers.get(DEVICE_FP_HEADER);
    const unauth = reply(401, { error: "Gerät nicht berechtigt.", code: "DEVICE_UNAUTHORIZED" });
    if (!cred || typeof fp !== "string" || !FP_RE.test(fp)) return unauth;
    const store = await getStore();
    const d = (await devices()).devices?.[cred.device_id];
    if (!d || !(await credentialMatches(d, cred.secret)) || d.device_fp !== fp) return unauth;
    if (d.status !== "active") return reply(403, { error: d.status === "revoked" ? "Gerät widerrufen." : "Gerät deaktiviert.", code: d.status === "revoked" ? "DEVICE_REVOKED" : "DEVICE_DISABLED" });
    if (!(await accountActive(d.owner_user_id))) {
      await terminateUserDevices(store, { user_id: d.owner_user_id, actor_user_id: null, reason: "account_disabled", now: now() });
      return reply(403, { error: "Zugang deaktiviert.", code: "ACCOUNT_DISABLED" });
    }
    const t = now();
    await update(store, "devices", (doc) => { const x = doc.devices?.[d.device_id]; if (!x || x.status !== "active") return false; x.last_seen_at = t.toISOString(); }, emptyDevices);
    if (body.op === "rotate") {
      const secret = newDeviceSecret(), credential_hash = await sha256Hex(secret);
      const ok = await update(store, "devices", (doc) => { const x = doc.devices?.[d.device_id]; if (!x || x.status !== "active" || x.credential_hash !== d.credential_hash) return false; x.credential_hash = credential_hash; x.credential_rotated_at = t.toISOString(); }, emptyDevices);
      if (!ok) return unauth;
      await audit({ actor_user_id: d.owner_user_id, action: "device.credential_rotated", device_id: d.device_id, owner_user_id: d.owner_user_id, result: "success" });
      return reply(200, { device_id: d.device_id, device_credential: `${d.device_id}.${secret}` });
    }
    if (body.op === "poll") {
      const sess = ((await store.sessions.get()).state || emptyDeviceSessions()).sessions || {};
      const live = (c) => { const s = sess[c.session_hash]; return s && !s.closed_at && Date.parse(s.expires_at) > +t && s.device_id === d.device_id && s.user_id === d.owner_user_id; };
      const out = [];
      await update(store, "commands", (c) => {
        out.length = 0;
        for (const x of c.commands || []) {
          if (x.device_id !== d.device_id || x.status !== "queued") continue;
          // Bei der Auslieferung erneut: Anforderer = Eigentümer, Sitzung offen, Aktion erlaubt. Sonst verworfen, nie ausgeführt.
          const ok = x.owner_user_id === d.owner_user_id && live(x) && authorizeDeviceAccess({ requesting_user_id: x.requesting_user_id, device: d, action_id: x.action_id }).ok;
          if (!ok) { x.status = "cancelled"; x.done_at = t.toISOString(); continue; }
          x.status = "delivered"; x.delivered_at = t.toISOString();
          out.push({ command_id: x.command_id, action_id: x.action_id, owner_user_id: x.owner_user_id, requesting_user_id: x.requesting_user_id });
        }
      }, emptyCommands);
      return reply(200, { device_id: d.device_id, owner_user_id: d.owner_user_id, commands: out });
    }
    if (body.op === "result") {
      if (!isCommandId(body.command_id)) return reply(400, { error: "command_id ungültig." });
      const ok = await update(store, "commands", (c) => {
        const x = (c.commands || []).find((y) => y.command_id === body.command_id);
        if (!x || x.device_id !== d.device_id || x.status !== "delivered") return false;
        x.status = body.ok === true ? "done" : "failed"; x.done_at = t.toISOString(); x.result = cleanResult(body.result);
      }, emptyCommands);
      return ok ? reply(200, { ok: true }) : reply(404, { error: "Befehl unbekannt.", code: "UNKNOWN_COMMAND" });
    }
    return reply(400, { error: "op: poll | result | rotate." });
  }

  // ---------- Benutzer-Aktionen am eigenen Gerät ----------
  async function revoke(actor, device_id) {
    const g = await gate(actor, device_id, "device.revoke");
    if (g.res) return g.res;
    const store = await getStore(), t = now().toISOString();
    await update(store, "devices", (doc) => { const x = doc.devices[device_id]; x.status = "revoked"; x.revoked_at = t; x.credential_hash = null; }, emptyDevices);
    await update(store, "sessions", (s) => { for (const x of Object.values(s.sessions || {})) if (x.device_id === device_id && !x.closed_at) { x.closed_at = t; x.close_reason = "device_revoked"; } }, emptyDeviceSessions);
    await update(store, "commands", (c) => { for (const x of c.commands || []) if (x.device_id === device_id && ["queued", "delivered"].includes(x.status)) { x.status = "cancelled"; x.done_at = t; } }, emptyCommands);
    await audit({ actor_user_id: actor.user_id, action: "device.revoked", device_id, owner_user_id: g.device.owner_user_id, result: "success" });
    return reply(200, { ok: true, device: publicDevice({ ...g.device, status: "revoked" }, now()) });
  }
  async function openSession(actor, device_id) {
    const g = await gate(actor, device_id, "device.session_open");
    if (g.res) return g.res;
    const t = now(), token = newSessionToken(), hash = await sha256Hex(token), expires_at = new Date(+t + SESSION_TTL_MS).toISOString();
    await update(await getStore(), "sessions", (s) => {
      s.sessions = Object.fromEntries(Object.entries(s.sessions || {}).filter(([, x]) => +t - Date.parse(x.expires_at) < 86_400_000));
      s.sessions[hash] = { device_id, user_id: actor.user_id, opened_at: t.toISOString(), expires_at, closed_at: null };
    }, emptyDeviceSessions);
    await audit({ actor_user_id: actor.user_id, action: "device.session_opened", device_id, owner_user_id: g.device.owner_user_id, result: "success" });
    return reply(200, { session_id: token, device_id, expires_at });
  }
  async function closeSession(actor, device_id, body) {
    const g = await gate(actor, device_id, "device.session_close");
    if (g.res) return g.res;
    const s = await sessionOf(body.session_id, g.device, actor.user_id);
    if (!s) return reply(404, { error: "Sitzung unbekannt oder beendet.", code: "SESSION_INVALID" });
    await update(await getStore(), "sessions", (doc) => { const x = doc.sessions[s.hash]; if (x) { x.closed_at = now().toISOString(); x.close_reason = "user"; } }, emptyDeviceSessions);
    await audit({ actor_user_id: actor.user_id, action: "device.session_closed", device_id, owner_user_id: g.device.owner_user_id, result: "success" });
    return reply(200, { ok: true });
  }
  async function action(actor, device_id, body) {
    const action_id = typeof body.action_id === "string" ? body.action_id : "";
    const g = await gate(actor, device_id, "device.action", action_id);
    if (g.res) return g.res;
    const s = await sessionOf(body.session_id, g.device, actor.user_id);
    if (!s) return reply(403, { error: "Keine offene Geräte-Sitzung.", code: "SESSION_INVALID" });
    const t = now(), command_id = newCommandId();
    // Jede Aktion trägt requesting_user_id, device_id, owner_user_id und action_id – geprüft vor dem Einreihen und bei der Auslieferung.
    await update(await getStore(), "commands", (c) => {
      c.commands = [...(c.commands || []), { command_id, device_id, owner_user_id: g.device.owner_user_id, requesting_user_id: actor.user_id, action_id, session_hash: s.hash,
        status: "queued", created_at: t.toISOString() }].slice(-COMMANDS_KEEP);
    }, emptyCommands);
    await audit({ actor_user_id: actor.user_id, action: "device.action_queued", device_id, owner_user_id: g.device.owner_user_id, action_id, result: "success" });
    return reply(200, { command_id, status: "queued" });
  }
  async function detail(actor, device_id) {
    const g = await gate(actor, device_id, "device.detail");
    if (g.res) return g.res;
    const cmds = (((await (await getStore()).commands.get()).state || emptyCommands()).commands || []).filter((x) => x.device_id === device_id).slice(-20)
      .map((x) => ({ command_id: x.command_id, action_id: x.action_id, status: x.status, created_at: x.created_at, done_at: x.done_at || null, result: x.result || null }));
    return reply(200, { device: publicDevice(g.device, now()), commands: cmds, actions: Object.entries(DEVICE_ACTIONS).map(([id, a]) => ({ action_id: id, label: a.label })) });
  }

  // ---------- Owner: Monitoring/Admin (keine Fernsteuerung) ----------
  async function adminSet(actor, device_id, op) {
    const d = isDeviceId(device_id) ? (await devices()).devices?.[device_id] : null;
    if (!d) return reply(404, { error: "Gerät unbekannt.", code: "DEVICE_UNKNOWN" });
    const store = await getStore(), t = now().toISOString();
    if (op === "release") {
      if (d.status === "active") return reply(409, { error: "Erst widerrufen oder deaktivieren, dann freigeben.", code: "DEVICE_ACTIVE" });
      await update(store, "devices", (doc) => { const x = doc.devices[device_id]; x.released_at = t; x.released_by = actor.user_id; x.credential_hash = null; }, emptyDevices);
      await audit({ actor_user_id: actor.user_id, action: "device.released_for_repairing", device_id, owner_user_id: d.owner_user_id, result: "success" });
      return reply(200, { ok: true, device: adminDevice({ ...d }, now()) });
    }
    if (d.status === "revoked") return reply(409, { error: "Gerät ist widerrufen – nur neu koppeln.", code: "DEVICE_REVOKED" });
    const status = op === "disable" ? "disabled" : "active";
    await update(store, "devices", (doc) => { const x = doc.devices[device_id]; x.status = status; if (status === "disabled") { x.disabled_at = t; x.disabled_by = actor.user_id; } else x.enabled_at = t; }, emptyDevices);
    if (status === "disabled") {
      await update(store, "sessions", (s) => { for (const x of Object.values(s.sessions || {})) if (x.device_id === device_id && !x.closed_at) { x.closed_at = t; x.close_reason = "device_disabled"; } }, emptyDeviceSessions);
      await update(store, "commands", (c) => { for (const x of c.commands || []) if (x.device_id === device_id && ["queued", "delivered"].includes(x.status)) { x.status = "cancelled"; x.done_at = t; } }, emptyCommands);
    }
    await audit({ actor_user_id: actor.user_id, action: status === "disabled" ? "device.disabled" : "device.enabled", device_id, owner_user_id: d.owner_user_id, result: "success" });
    // Antwort: nur Admin-Metadaten – keine Sitzung, kein Credential, keine Verbindung.
    return reply(200, { ok: true, device: adminDevice({ ...d, status }, now()) });
  }

  return async (req) => {
    const url = new URL(req.url);
    const route = url.pathname.replace(/^\/api\/devices\/?/, "").replace(/\/+$/, "");
    const parts = route ? route.split("/") : [];
    // Geräte-Endpunkte ohne Benutzer-Sitzung (Agent, nur ausgehend).
    if (route === "pair/complete" || route === "channel") {
      if (req.method !== "POST") return reply(405, { error: "Nur POST." });
      const body = await readBody(req);
      if (!body || typeof body !== "object") return reply(400, { error: "Ungültige Anfrage." });
      return route === "channel" ? channel(req, body) : pairComplete(body);
    }
    const r = await resolveActor(req);
    if (!r.actor) return reply(r.status || 401, { error: r.error || "Nicht angemeldet.", ...(r.code ? { code: r.code } : {}) });
    const actor = r.actor;
    if (req.method === "GET" && !route) {
      const list = mine(await devices(), actor.user_id).map((d) => publicDevice(d, now()));
      return reply(200, { devices: list, ...(list.some((d) => d.status === "active") ? {} : { code: "DEVICE_NOT_PAIRED" }) });
    }
    if (route === "admin") {
      if (!isOwner(actor)) { await audit({ actor_user_id: actor.user_id, action: "device.admin_list", result: "forbidden" }); return reply(403, { error: "Nur der Owner.", code: "FORBIDDEN" }); }
      return reply(200, { devices: Object.values((await devices()).devices || {}).map((d) => adminDevice(d, now())), note: "Nur Metadaten – keine Geräte-Steuerung für fremde Geräte." });
    }
    if (route === "pair/start") {
      if (req.method !== "POST") return reply(405, { error: "Nur POST." });
      return pairStart(actor, (await readBody(req)) || {});
    }
    const [id, op, sub] = parts;
    if (!isDeviceId(id)) return reply(404, { error: "Unbekannt." });
    if (req.method === "GET" && parts.length === 1) return detail(actor, id);
    if (req.method !== "POST") return reply(405, { error: "Nur POST." });
    const body = (await readBody(req)) || {};
    if (["disable", "enable", "release"].includes(op) && parts.length === 2) {
      if (!isOwner(actor)) { await audit({ actor_user_id: actor.user_id, action: `device.${op}`, device_id: id, result: "forbidden" }); return reply(403, { error: "Nur der Owner.", code: "FORBIDDEN" }); }
      return adminSet(actor, id, op);
    }
    if (op === "revoke" && parts.length === 2) return revoke(actor, id);
    if (op === "session" && parts.length === 2) return openSession(actor, id);
    if (op === "session" && sub === "close" && parts.length === 3) return closeSession(actor, id, body);
    if (op === "actions" && parts.length === 2) return action(actor, id, body);
    return reply(404, { error: "Unbekannt." });
  };
}
