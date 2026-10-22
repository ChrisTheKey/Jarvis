// NETLIFY-DROP-ADAPTER (TF-JARVIS-PRAXIS-002) für CHECK & REPARATUR CHF 480. Repariert Websites, die OHNE Git-Anbindung direkt auf
// Netlify veröffentlicht werden (Netlify Drop / manueller Upload), ausschliesslich über die offizielle Netlify-API:
//
//   checkAccess     Site eindeutig (Site-ID aus der Zuordnung), Site trägt die Auftrags-Domain, keine Git-Anbindung, Token gültig,
//                   Auftragsbindung (Domain ↔ Site-ID ↔ Ziel ↔ Quelle) stimmt. 401 = ungültiger Token, 403 = keine Berechtigung,
//                   404 = falsche Site-ID/kein Zugriff.
//   backup          veröffentlichten Deploy (= Rollback-Punkt) festhalten, Quell-Deploy (Standard: der veröffentlichte; per
//                   Auftragsbindung ein ausdrücklich genannter früherer Deploy derselben Site) VOLLSTÄNDIG sichern: Dateiliste über
//                   die API, jede Datei geladen und gegen den SHA-1 von Netlify geprüft. Unvollständig → kein Backup (fail closed).
//   locate/applyFix nur über static-site-fixes.js (eindeutige Minimal-Fixes) auf einer lokalen Arbeitskopie – nie live.
//   validate        neuen Deploy als ENTWURF (draft) mit der vollständigen Dateiliste anlegen: unveränderte Dateien per SHA-1
//                   übernommen (nicht neu hochgeladen), nur geänderte Dateien hochgeladen; warten bis «ready»; geänderte Dateien in
//                   der Vorschau gegen den erwarteten SHA-1 prüfen → preview_url (Browser-Gate der Engine läuft auf der Vorschau).
//                   Gleiches Artefakt erneut angefordert → derselbe Entwurf (keine Doppel-Deploys).
//   deployProduction veröffentlichen NUR, wenn der Produktionsstand noch der Rollback-Punkt ist (niemand hat inzwischen etwas
//                   geändert) – über «restore» des geprüften Entwurfs; danach published_deploy == Entwurf bestätigt. Idempotent.
//   rollback        vor der Veröffentlichung: nichts zu tun (Produktion unverändert, wird geprüft); danach: Rollback-Punkt
//                   wiederherstellen und bestätigen.
//
// Sicherheit: Token nur aus der Umgebung (JARVIS_REPAIR_NETLIFY_TOKEN bzw. Datei JARVIS_REPAIR_NETLIFY_TOKEN_FILE) – nie in Logs,
// Aufträgen, Berichten oder Fehlermeldungen. Nie eine Site erraten: jede Domain braucht einen Eintrag in repair_netlify_drop.json
// (nur Metadaten). Andere Sites werden nie angefasst; keine Site-Einstellungen, kein DNS, keine Team-Konfiguration.
// Protokoll: netlify_drop_log.jsonl (Aktion, Site-ID, Deploy-ID, Zeitstempel, Ergebnis – nie Inhalte oder Tokens).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore } from "../mail-worker.js";
import { normDomain } from "./common.js";
import { locateStaticFix, applyStaticFix, sha1, sha256, STATIC_FIX_TYPES } from "../static-site-fixes.js";

export const NETLIFY_DROP_FILE = "repair_netlify_drop.json";
export const NETLIFY_DROP_LOG = "netlify_drop_log.jsonl";
export const NETLIFY_TOKEN_ENV = "JARVIS_REPAIR_NETLIFY_TOKEN";
export const NETLIFY_TOKEN_FILE_ENV = "JARVIS_REPAIR_NETLIFY_TOKEN_FILE";
export const NETLIFY_DROP_CAPABILITIES = Object.freeze(["READ_FILES", "WRITE_FILES", "ATOMIC_REPLACE", "BACKUP", "ROLLBACK", "BUILD_TEST", "HEALTH_CHECK"]);
export const DEPLOY_TARGETS = Object.freeze(["production"]);
const NF = "https://api.netlify.com/api/v1";
const SITE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOY_ID_RE = /^[0-9a-f]{24}$/i;
const SAFE_PATH_RE = /^\/(?:[\w@%+~.-]+\/)*[\w@%+~.-]+$/;
const MAX_FILES = 500, MAX_BYTES = 50 * 1024 * 1024;
const TEXT_EXT = /\.(html?|css|js|mjs|json|svg|txt|xml|webmanifest)$/i;
const fail = (what, status) => Object.assign(new Error(`${what} fehlgeschlagen (HTTP ${status}).`), { status });
const REASON_BY_STATUS = { 401: "invalid_credentials", 403: "no_permission", 404: "site_not_found" };
const safePath = (p) => typeof p === "string" && SAFE_PATH_RE.test(p) && !p.split("/").includes("..");

// ---------- Zuordnung Domain → Netlify-Site (nur Metadaten, nie Secrets) ----------
export function loadDropMappings(store) { return store.read(NETLIFY_DROP_FILE, { schema: 1, sites: {} }).sites || {}; }
export function setDropMapping(store, domain, { netlify_site_id, site_name, authorized_by = "chris", reference = null, now = new Date() } = {}) {
  const d = normDomain(domain);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) throw new Error("Domain erforderlich.");
  if (!SITE_ID_RE.test(String(netlify_site_id || ""))) throw new Error("Netlify-Site-ID (UUID) erforderlich – keine URL, kein Token.");
  if (!/^[a-z0-9-]{1,63}$/.test(String(site_name || ""))) throw new Error("Netlify-Site-Name (z. B. praxis-kaelin) erforderlich.");
  const data = store.read(NETLIFY_DROP_FILE, { schema: 1, sites: {} });
  data.sites = { ...(data.sites || {}), [d]: { netlify_site_id: String(netlify_site_id).toLowerCase(), site_name, authorized_by, reference: reference ? String(reference).slice(0, 200) : null, updated_at: now.toISOString() } };
  store.write(NETLIFY_DROP_FILE, data);
  return data.sites[d];
}
export function readNetlifyToken(env = process.env) {
  if (env[NETLIFY_TOKEN_ENV]) return String(env[NETLIFY_TOKEN_ENV]).trim();
  const f = env[NETLIFY_TOKEN_FILE_ENV];
  if (f) { try { return tokenFromFile(fs.readFileSync(f, "utf8")); } catch {} }
  return "";
}
// Token-Datei: entweder nur der Token, oder eine .env-Datei (KEY=value) – dann ausschliesslich JARVIS_REPAIR_NETLIFY_TOKEN
// (Vorrang) bzw. NETLIFY_AUTH_TOKEN (Netlify-CLI-Name); andere Schlüssel werden nie als Token verwendet.
function tokenFromFile(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.some((l) => /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l))) return String(text).trim();
  const vars = {};
  for (const l of lines) {
    const m = l.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) vars[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars[NETLIFY_TOKEN_ENV] || vars.NETLIFY_AUTH_TOKEN || "";
}
// Auftragsbindung (Phase 4): Auftrag ↔ Domain ↔ Site-ID ↔ Ziel ↔ (optional) Quell-Deploy ↔ Testempfänger. Rückgabe: Grund | null.
export function bindingProblem(order = {}, mapping = null) {
  if (!mapping) return "no_mapping";
  const b = order.deploy_binding;
  const isTest = order.test_order === true || order.environment === "TEST";
  if (!b) return isTest ? "test_order_without_binding" : null; // TEST-Aufträge nur mit ausdrücklicher Bindung
  if (normDomain(b.domain) !== normDomain(order.domain)) return "binding_domain_mismatch";
  if (String(b.netlify_site_id || "").toLowerCase() !== mapping.netlify_site_id) return "binding_site_mismatch";
  if (!DEPLOY_TARGETS.includes(b.deploy_target)) return "binding_target_invalid";
  if (b.source_deploy_id != null && !DEPLOY_ID_RE.test(String(b.source_deploy_id))) return "binding_source_invalid";
  if (b.test_recipient != null && String(b.test_recipient).toLowerCase() !== String(order.delivery_email || "").toLowerCase()) return "binding_recipient_mismatch";
  return null;
}
const siteDomains = (site) => [site?.custom_domain, ...(site?.domain_aliases || []), site?.name ? `${site.name}.netlify.app` : null,
  (() => { try { return new URL(site.ssl_url || site.url).hostname; } catch { return null; } })()].filter(Boolean).map(normDomain);

export function netlifyDropAdapter({ dir = WORKER_DIR, store = createStore(dir), env = process.env, fetchFn = globalThis.fetch, now = () => new Date(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 3000, deployTimeoutMs = 5 * 60_000, apiBase = NF, permalinkOf = null } = {}) {
  const token = () => readNetlifyToken(env);
  const workRoot = path.join(dir, "netlify_drop");
  const orderDir = (order) => { if (!/^[A-Z0-9]+-\d{8}-[0-9a-f]{6}$/.test(String(order.order_id || ""))) throw new Error("Auftrags-ID ungültig."); return path.join(workRoot, order.order_id); };
  const mappingFor = (order) => loadDropMappings(store)[normDomain(order.domain)] || null;
  const log = (entry) => { try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, NETLIFY_DROP_LOG), JSON.stringify({ at: now().toISOString(), ...entry }) + "\n", { mode: 0o600 }); } catch {} };
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
  const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(tmp, f); };
  const stateFile = (order) => path.join(orderDir(order), "state.json");
  const state = (order) => readJson(stateFile(order), {});
  const saveState = (order, patch) => { const s = { ...state(order), ...patch }; writeJson(stateFile(order), s); return s; };

  async function api(p, { method = "GET", body = null, raw = null, accept = "application/json" } = {}) {
    const t = token();
    if (!t) return { status: 0, json: null };
    const headers = { authorization: `Bearer ${t}`, accept, "user-agent": "JarvisRepair/1.0 (netlify-drop)" };
    let payload;
    if (raw != null) { headers["content-type"] = "application/octet-stream"; payload = raw; }
    else if (body) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
    const r = await fetchFn(`${apiBase}${p}`, { method, headers, signal: AbortSignal.timeout(30_000), ...(payload != null ? { body: payload } : {}) });
    let json = null, buf = null;
    if (accept === "application/json") { try { json = await r.json(); } catch {} } else { try { buf = Buffer.from(await r.arrayBuffer()); } catch {} }
    return { status: r.status, json, buf };
  }
  const permalink = (deployId, site) => (permalinkOf ? permalinkOf(deployId, site) : `https://${deployId}--${site.name}.netlify.app`);

  // Site laden + alle Prüfungen der Zuordnung/Bindung. Rückgabe { ok, site, mapping } | { ok:false, reason }.
  async function verifiedSite(order) {
    const mapping = mappingFor(order);
    const bp = bindingProblem(order, mapping);
    if (bp) return { ok: false, reason: bp };
    if (!token()) return { ok: false, reason: "no_token" };
    const r = await api(`/sites/${mapping.netlify_site_id}`);
    if (r.status !== 200 || !r.json) return { ok: false, reason: REASON_BY_STATUS[r.status] || `site_unreachable_${r.status}` };
    const site = r.json;
    if (String(site.id || site.site_id || "").toLowerCase() !== mapping.netlify_site_id) return { ok: false, reason: "site_id_mismatch" };
    if (site.name !== mapping.site_name) return { ok: false, reason: "site_name_mismatch" };
    if (!siteDomains(site).includes(normDomain(order.domain))) return { ok: false, reason: "site_domain_mismatch" };
    if (site.build_settings?.repo_url) return { ok: false, reason: "site_has_git_repo" }; // gehört zum GitHub+Netlify-Adapter
    return { ok: true, site, mapping };
  }
  async function deploy(id) { const r = await api(`/deploys/${id}`); return r.status === 200 ? r.json : null; }
  async function fileList(deployId) {
    const all = [];
    for (let page = 1; page <= 20; page++) {
      const r = await api(`/deploys/${deployId}/files?page=${page}&per_page=100`);
      if (r.status !== 200 || !Array.isArray(r.json)) return null;
      all.push(...r.json);
      if (r.json.length < 100) return all;
    }
    return null; // zu viele Seiten → nicht vollständig → fail closed
  }
  // Datei aus einem Deploy laden: Permalink des Deploys (öffentlich, GET); SHA-1 muss zur Netlify-Dateiliste passen.
  async function fetchDeployFile(deployId, site, f) {
    const get = async (p) => { const r = await fetchFn(permalink(deployId, site) + encodeURI(p), { signal: AbortSignal.timeout(30_000), redirect: "manual" }); return r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null; };
    const tries = [() => get(f.path), ...(/\/index\.html?$/i.test(f.path) ? [() => get(f.path.replace(/index\.html?$/i, ""))] : []), // «Pretty URLs»: /index.html → /
      async () => { const r = await api(`/deploys/${deployId}/files${encodeURI(f.path)}`, { accept: "application/vnd.bitballoon.v1.raw" }); return r.status === 200 ? r.buf : null; }];
    for (const t of tries) { const b = await t().catch(() => null); if (b && sha1(b) === f.sha) return b; }
    return null;
  }
  const workFile = (order, p) => path.join(orderDir(order), "work", ...p.split("/").filter(Boolean));
  const sourceFile = (order, p) => path.join(orderDir(order), "source", ...p.split("/").filter(Boolean));
  const manifest = (order) => readJson(path.join(orderDir(order), "manifest.json"), null);
  const htmlFiles = (order) => { const m = manifest(order); const map = new Map(); for (const f of m?.files || []) if (/\.html?$/i.test(f.path)) { try { map.set(f.path, fs.readFileSync(workFile(order, f.path), "utf8")); } catch {} } return map; };
  // Vollständige Dateiliste des Artefakts (Pfad → SHA-1): unveränderte Dateien mit Original-SHA, geänderte mit neuem SHA.
  function artifact(order) {
    const m = manifest(order);
    if (!m) return null;
    const files = {}, changed = [];
    for (const f of m.files) {
      const buf = fs.readFileSync(workFile(order, f.path));
      const s = sha1(buf);
      files[f.path] = s;
      if (s !== f.sha1) changed.push({ path: f.path, sha1: s, sha256: sha256(buf), size: buf.length });
    }
    return { files, changed, total: m.files.length, hash: sha256(JSON.stringify(Object.entries(files).sort())) };
  }

  return {
    stack: "netlify_drop", capabilities: [...NETLIFY_DROP_CAPABILITIES], direct_live: false,
    async claims(order) { return !!mappingFor(order); },

    async checkAccess(order) {
      const v = await verifiedSite(order);
      log({ action: "check_access", order_id: order.order_id, site_id: mappingFor(order)?.netlify_site_id || null, ok: v.ok, reason: v.reason || null });
      if (!v.ok) return { ok: false, reason: v.reason, ...(["site_has_git_repo"].includes(v.reason) ? { blocked_state: "BLOCKED_UNSUPPORTED_STACK" } : {}) };
      const pub = v.site.published_deploy?.id;
      if (!pub) return { ok: false, reason: "no_published_deploy" };
      const list = await api(`/sites/${v.site.id}/deploys?per_page=1`); // Lesen der Deploy-Liste = Mindestberechtigung
      if (list.status !== 200) return { ok: false, reason: REASON_BY_STATUS[list.status] || "deploys_unreadable" };
      return { ok: true, connector: `netlify-drop:${v.site.name}`, capabilities: [...NETLIFY_DROP_CAPABILITIES] };
    },

    async backup(order) {
      const v = await verifiedSite(order);
      if (!v.ok) throw new Error(`Netlify-Zugang nicht bestätigt (${v.reason}).`);
      const published = v.site.published_deploy?.id;
      const sourceId = order.deploy_binding?.source_deploy_id || published;
      if (!DEPLOY_ID_RE.test(String(published || "")) || !DEPLOY_ID_RE.test(String(sourceId || ""))) throw new Error("Deploy-IDs nicht lesbar.");
      const src = await deploy(sourceId);
      if (!src || String(src.site_id || "").toLowerCase() !== v.mapping.netlify_site_id) throw new Error("Quell-Deploy gehört nicht zu dieser Site.");
      if (src.state !== "ready") throw new Error(`Quell-Deploy nicht bereit (${src.state}).`);
      if ((src.available_functions || []).length || (src.edge_functions_present === true)) throw new Error("Deploy enthält Functions – nicht über Netlify Drop reparierbar.");
      const list = await fileList(sourceId);
      if (!list || !list.length || list.length > MAX_FILES) throw new Error("Dateiliste unvollständig oder zu gross.");
      const od = orderDir(order);
      fs.rmSync(path.join(od, "source"), { recursive: true, force: true }); fs.rmSync(path.join(od, "work"), { recursive: true, force: true });
      const files = []; let bytes = 0;
      for (const f of list) {
        const p = f.path || f.id;
        if (!safePath(p) || !/^[0-9a-f]{40}$/.test(String(f.sha || ""))) throw new Error("Unsicherer Dateipfad in der Dateiliste.");
        const buf = await fetchDeployFile(sourceId, v.site, { path: p, sha: f.sha });
        if (!buf) { log({ action: "backup_file_failed", order_id: order.order_id, deploy_id: sourceId, path: p }); throw new Error(`Datei ${p} nicht vollständig gesichert (SHA-1 stimmt nicht).`); }
        bytes += buf.length; if (bytes > MAX_BYTES) throw new Error("Website zu gross für eine automatische Reparatur.");
        for (const target of [sourceFile(order, p), workFile(order, p)]) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, buf, { mode: 0o600 }); }
        files.push({ path: p, sha1: f.sha, sha256: sha256(buf), size: buf.length, mime_type: f.mime_type || null });
      }
      const at = now().toISOString();
      writeJson(path.join(od, "manifest.json"), { site_id: v.site.id, site_name: v.site.name, source_deploy_id: sourceId, published_deploy_id: published, created_at: at, files });
      saveState(order, { backup: { at, source_deploy_id: sourceId, published_deploy_id: published, files: files.length, bytes } });
      log({ action: "backup", order_id: order.order_id, site_id: v.site.id, source_deploy_id: sourceId, published_deploy_id: published, files: files.length, bytes });
      const srcUrl = src.deploy_ssl_url && new URL(src.deploy_ssl_url).hostname.endsWith(`--${v.site.name}.netlify.app`) ? src.deploy_ssl_url : permalink(sourceId, v.site);
      return { production_ref: `netlify:${published}`, backup_ref: `netlify-drop-snapshot:${sourceId}:${files.length}`, rollback_point: `netlify:${published}`,
        branch: `draft/${order.order_id}`, source_url: srcUrl.replace(/\/?$/, "/") };
    },

    async locate(issue, order) {
      if (!STATIC_FIX_TYPES.includes(issue.type)) return null;
      const files = htmlFiles(order);
      if (!files.size) return null;
      const loc = locateStaticFix({ ...issue, ...(issue.detail || {}), page_path: issue.detail?.page_path || issue.page || issue.url }, files);
      return loc ? { target: loc.target, cause: loc.cause, planned_change: loc.planned_change, risk: loc.risk, required_capabilities: loc.required_capabilities, before_hash: loc.before_hash, fix: loc.fix } : null;
    },

    async applyFix(item, order) {
      const fix = item.fix;
      if (!fix?.file || !safePath(fix.file)) return { ok: false, error: "Fix-Details fehlen." };
      const m = manifest(order);
      if (!m?.files.some((f) => f.path === fix.file)) return { ok: false, error: "Datei gehört nicht zum gesicherten Stand." };
      const f = workFile(order, fix.file);
      const before = fs.readFileSync(f, "utf8");
      const after = applyStaticFix(fix, before);
      if (typeof after !== "string" || after === before) return { ok: false, error: "Stelle nicht mehr eindeutig – keine Änderung." };
      const tmp = `${f}.tmp`; fs.writeFileSync(tmp, after, { mode: 0o600 }); fs.renameSync(tmp, f); // atomar
      log({ action: "apply_fix", order_id: order.order_id, issue_id: item.issue_id, file: fix.file, kind: fix.kind, before_sha256: sha256(before), after_sha256: sha256(after) });
      return { ok: true, change_ref: `artifact:${fix.file}@${sha256(after).slice(0, 12)}`, before_hash: sha256(before), after_hash: sha256(after) };
    },

    // Entwurf (draft) erstellen, hochladen, warten, prüfen → Vorschau-URL.
    async validate(order) {
      const v = await verifiedSite(order);
      if (!v.ok) { log({ action: "draft_refused", order_id: order.order_id, reason: v.reason }); return { build_ok: false, error: v.reason }; }
      const a = artifact(order);
      if (!a || !a.changed.length) return { build_ok: false, error: "Artefakt leer oder unverändert." };
      if (Object.keys(a.files).length !== manifest(order).files.length) return { build_ok: false, error: "Dateiliste unvollständig." };
      let st = state(order);
      let draftId = st.draft?.artifact_hash === a.hash && st.draft?.deploy_id ? st.draft.deploy_id : null;
      if (draftId) { const d = await deploy(draftId); if (!d || d.state === "error") draftId = null; else log({ action: "draft_reused", order_id: order.order_id, deploy_id: draftId }); }
      if (!draftId) {
        const r = await api(`/sites/${v.site.id}/deploys`, { method: "POST", body: { files: a.files, draft: true, title: `Jarvis ${order.order_id} (Entwurf, ungeprüft)` } });
        if (r.status !== 200 && r.status !== 201) { log({ action: "draft_create_failed", order_id: order.order_id, status: r.status }); return { build_ok: false, error: REASON_BY_STATUS[r.status] || `draft_http_${r.status}` }; }
        draftId = r.json?.id;
        if (!DEPLOY_ID_RE.test(String(draftId || ""))) return { build_ok: false, error: "draft_id_missing" };
        st = saveState(order, { draft: { deploy_id: draftId, artifact_hash: a.hash, created_at: now().toISOString(), changed: a.changed.map((c) => c.path), total_files: a.total } });
        log({ action: "draft_created", order_id: order.order_id, site_id: v.site.id, deploy_id: draftId, files: a.total, changed: a.changed.length, required: (r.json?.required || []).length });
        const required = new Set(r.json?.required || []);
        for (const c of a.changed) {
          if (!required.has(c.sha1)) continue;
          const up = await api(`/deploys/${draftId}/files${encodeURI(c.path)}`, { method: "PUT", raw: fs.readFileSync(workFile(order, c.path)) });
          if (up.status !== 200) { log({ action: "draft_upload_failed", order_id: order.order_id, deploy_id: draftId, path: c.path, status: up.status }); return { build_ok: false, error: `upload_http_${up.status}` }; }
          log({ action: "draft_upload", order_id: order.order_id, deploy_id: draftId, path: c.path, sha1: c.sha1 });
        }
        // Netlify verlangt nur Dateien, deren Inhalt es noch nicht kennt – alles andere (unverändert) wird übernommen.
        const unknown = [...required].filter((s) => !a.changed.some((c) => c.sha1 === s));
        if (unknown.length) { log({ action: "draft_unexpected_required", order_id: order.order_id, deploy_id: draftId, count: unknown.length }); return { build_ok: false, error: "unexpected_required_files" }; }
      }
      const deadline = Date.now() + deployTimeoutMs;
      let d;
      for (;;) {
        d = await deploy(draftId);
        if (d?.state === "ready") break;
        if (!d || d.state === "error" || Date.now() > deadline) { log({ action: "draft_failed", order_id: order.order_id, deploy_id: draftId, state: d?.state || null }); return { build_ok: false, error: "draft_not_ready" }; }
        await sleep(pollMs);
      }
      // Vorschau prüfen: jede geänderte Datei liefert exakt das Artefakt; Stichprobe unveränderter Dateien unverändert.
      for (const c of a.changed) {
        const b = await fetchDeployFile(draftId, v.site, { path: c.path, sha: c.sha1 });
        if (!b) { log({ action: "draft_verify_failed", order_id: order.order_id, deploy_id: draftId, path: c.path }); return { build_ok: false, error: "draft_content_mismatch" }; }
      }
      const files = await fileList(draftId);
      const same = files && files.length === a.total && files.every((f) => a.files[f.path || f.id] === f.sha);
      if (!same) { log({ action: "draft_filelist_mismatch", order_id: order.order_id, deploy_id: draftId }); return { build_ok: false, error: "draft_filelist_mismatch" }; }
      const preview = d.deploy_ssl_url && new URL(d.deploy_ssl_url).hostname.endsWith(`--${v.site.name}.netlify.app`) ? d.deploy_ssl_url : permalink(draftId, v.site);
      saveState(order, { draft: { ...st.draft, state: "ready", verified_at: now().toISOString(), preview_url: preview } });
      log({ action: "draft_ready", order_id: order.order_id, site_id: v.site.id, deploy_id: draftId, files: files.length, preview_url: preview });
      return { build_ok: true, preview_url: preview.replace(/\/?$/, "/") };
    },

    async deployProduction(order) {
      const v = await verifiedSite(order);
      if (!v.ok) return { ok: false, error: v.reason };
      const st = state(order);
      const draftId = st.draft?.deploy_id;
      if (!draftId || st.draft?.state !== "ready" || st.draft?.artifact_hash !== artifact(order)?.hash) return { ok: false, error: "kein geprüfter Entwurf" };
      const rollbackId = String(order.backup?.rollback_point || "").replace(/^netlify:/, "");
      const current = v.site.published_deploy?.id;
      if (current === draftId) { log({ action: "publish_already_live", order_id: order.order_id, deploy_id: draftId }); return { ok: true, deploy_ref: `netlify:${draftId}` }; }
      if (current !== rollbackId) { log({ action: "publish_refused_production_changed", order_id: order.order_id, expected: rollbackId, current }); return { ok: false, error: "Produktionsstand seit dem Backup verändert" }; }
      saveState(order, { publish: { deploy_id: draftId, requested_at: now().toISOString(), previous_deploy_id: current } });
      log({ action: "publish_requested", order_id: order.order_id, site_id: v.site.id, deploy_id: draftId, previous_deploy_id: current });
      const r = await api(`/sites/${v.site.id}/deploys/${draftId}/restore`, { method: "POST" });
      if (r.status !== 200 && r.status !== 201) { log({ action: "publish_failed", order_id: order.order_id, deploy_id: draftId, status: r.status }); return { ok: false, error: REASON_BY_STATUS[r.status] || `publish_http_${r.status}` }; }
      const deadline = Date.now() + deployTimeoutMs;
      for (;;) {
        const s = await api(`/sites/${v.site.id}`);
        if (s.json?.published_deploy?.id === draftId) break;
        if (Date.now() > deadline) { log({ action: "publish_unconfirmed", order_id: order.order_id, deploy_id: draftId }); return { ok: false, error: "Veröffentlichung nicht bestätigt" }; }
        await sleep(pollMs);
      }
      saveState(order, { publish: { ...state(order).publish, confirmed_at: now().toISOString() } });
      log({ action: "published", order_id: order.order_id, site_id: v.site.id, deploy_id: draftId, previous_deploy_id: current });
      return { ok: true, deploy_ref: `netlify:${draftId}` };
    },

    async rollback(order) {
      const mapping = mappingFor(order);
      const rollbackId = String(order.backup?.rollback_point || "").replace(/^netlify:/, "");
      if (!mapping || !DEPLOY_ID_RE.test(rollbackId) || !token()) return { ok: false };
      const s = await api(`/sites/${mapping.netlify_site_id}`);
      if (s.status !== 200) return { ok: false };
      if (s.json?.published_deploy?.id === rollbackId) { log({ action: "rollback_not_needed", order_id: order.order_id, deploy_id: rollbackId }); return { ok: true }; } // nie veröffentlicht → Produktion unverändert
      const r = await api(`/sites/${mapping.netlify_site_id}/deploys/${rollbackId}/restore`, { method: "POST" });
      if (r.status !== 200 && r.status !== 201) { log({ action: "rollback_failed", order_id: order.order_id, deploy_id: rollbackId, status: r.status }); return { ok: false }; }
      const deadline = Date.now() + deployTimeoutMs;
      for (;;) {
        const c = await api(`/sites/${mapping.netlify_site_id}`);
        if (c.json?.published_deploy?.id === rollbackId) { log({ action: "rolled_back", order_id: order.order_id, deploy_id: rollbackId }); return { ok: true }; }
        if (Date.now() > deadline) return { ok: false };
        await sleep(pollMs);
      }
    },
  };
}

// Kommandozeile (nie Secrets; Token nur als vorhanden/fehlend gemeldet):
//   node repair-adapters/netlify-drop.js --map <domain> --site <site-uuid> --name <site-name> [--reference "…"]
//   node repair-adapters/netlify-drop.js --list | --check <domain>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  const run = async () => {
    if (argv.includes("--list")) { console.log(JSON.stringify(loadDropMappings(store), null, 2)); return 0; }
    if (flag("map")) { const r = setDropMapping(store, flag("map"), { netlify_site_id: flag("site"), site_name: flag("name"), reference: flag("reference") || null }); console.log(`Zuordnung gespeichert: ${normDomain(flag("map"))} → Netlify ${r.site_name} (${r.netlify_site_id})`); return 0; }
    if (flag("check")) {
      const r = await netlifyDropAdapter({ store }).checkAccess({ order_id: "CHECK-00000000-000000", domain: flag("check") });
      console.log(JSON.stringify({ domain: normDomain(flag("check")), ...r, netlify_token: readNetlifyToken() ? "vorhanden" : "fehlt" }, null, 2));
      return r.ok ? 0 : 1;
    }
    console.log("Befehle: --map <domain> --site <uuid> --name <site-name> | --list | --check <domain>");
    return 1;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
