// GitHub+Netlify-Stack-Adapter für CHECK & REPARATUR CHF 480 (TF-036). Repariert ausschliesslich Websites, deren
// Produktionsworkflow BEREITS über GitHub (Code) + Netlify (Deploy) läuft und die Chris EXPLIZIT zugeordnet hat.
//
// Sicherheitsmodell:
//   - NIE ein Repository oder eine Netlify-Site erraten: jede Domain braucht einen Eintrag in repair_mappings.json
//     (domain → repo → production_branch → netlify_site_id; enthält KEINE Secrets). Ohne Eintrag: kein Zugang.
//   - Credentials NUR aus der VPS-Umgebung (JARVIS_REPAIR_GITHUB_TOKEN, JARVIS_REPAIR_NETLIFY_TOKEN). Sie werden nie
//     ausgegeben, nie geloggt, nie in repair_orders.json/Lead-DB/Berichte geschrieben und nie an den Browser geschickt.
//   - Die Netlify-Site muss die Auftrags-Domain wirklich tragen (custom_domain/alias) – falsche Zuordnung = kein Zugang.
//   - Alle Änderungen zuerst im Branch repair/<order-id>; Production nur über den bestehenden Weg (Merge → Netlify-Build).
//   - Rollback über Netlify-Deploy-Restore auf den vor der Reparatur veröffentlichten Deploy.
//   - locate() liefert nur Fixes mit EINDEUTIGER Ursache (genau ein Ersatzziel, höchstens 3 betroffene Dateien) – sonst null,
//     und die State-Machine schickt den Befund in MANUAL_REVIEW. Es wird nie geraten.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_DIR, createStore } from "../mail-worker.js";
import { normDomain } from "../repair-workflow.js";

export const REPAIR_MAPPINGS_FILE = "repair_mappings.json";
export const GITHUB_TOKEN_ENV = "JARVIS_REPAIR_GITHUB_TOKEN";
export const NETLIFY_TOKEN_ENV = "JARVIS_REPAIR_NETLIFY_TOKEN";
const GH = "https://api.github.com";
const NF = "https://api.netlify.com/api/v1";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SOURCE_EXT = /\.(html?|js|jsx|ts|tsx|css|md|vue|svelte|astro)$/i;
const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|\.git)\//;

// Fehlertexte dürfen nie Tokens enthalten – wir bauen sie nur aus Status + API-Pfad (nie aus Headern).
const fail = (what, status) => new Error(`${what} fehlgeschlagen (HTTP ${status}).`);

export function loadRepairMappings(store) {
  const data = store.read(REPAIR_MAPPINGS_FILE, { schema: 1, mappings: {} });
  return data.mappings || {};
}
export function setRepairMapping(store, domain, { repo, production_branch = "main", netlify_site_id }) {
  const d = normDomain(domain);
  if (!d) throw new Error("Domain erforderlich.");
  if (!REPO_RE.test(repo || "")) throw new Error("Repository als owner/name angeben.");
  if (!/^[\w./-]{1,100}$/.test(production_branch)) throw new Error("Ungültiger Branch-Name.");
  if (!/^[\w-]{10,64}$/.test(netlify_site_id || "")) throw new Error("Netlify-Site-ID erforderlich (keine URL, kein Token).");
  const data = store.read(REPAIR_MAPPINGS_FILE, { schema: 1, mappings: {} });
  data.mappings = { ...(data.mappings || {}), [d]: { repo, production_branch, netlify_site_id, updated_at: new Date().toISOString() } };
  store.write(REPAIR_MAPPINGS_FILE, data);
  return data.mappings[d];
}

// Eindeutiges Ersatzziel für einen kaputten Pfad: gleicher Name ohne -alt/-old/-neu/-2-Suffix bzw. gleicher Dateiname an
// anderem Ort. GENAU EIN Kandidat, sonst null (nicht eindeutig → manuelle Prüfung).
export function uniqueReplacement(brokenPath, treePaths) {
  const clean = (s) => s.toLowerCase().replace(/\.(html?|php)$/i, "").replace(/[-_](alt|old|neu|new|backup|kopie|copy|\d)$/i, "");
  const base = clean(path.posix.basename(brokenPath));
  if (!base) return null;
  const toUrl = (p) => "/" + p.replace(/(^|\/)index\.html?$/i, "$1").replace(/\/$/, "");
  const candidates = [...new Set(treePaths
    .filter((p) => SOURCE_EXT.test(p) && !SKIP_PATH.test("/" + p) && /\.html?$/i.test(p))
    .filter((p) => clean(path.posix.basename(p)) === base)
    .map(toUrl))].filter((u) => u.replace(/\/$/, "") !== brokenPath.replace(/\/$/, ""));
  return candidates.length === 1 ? candidates[0] : null;
}
// Bild: gleicher Dateiname an genau einem anderen Ort im Repository.
export function uniqueImageReplacement(brokenPath, treePaths) {
  const base = path.posix.basename(brokenPath).toLowerCase();
  const candidates = treePaths.filter((p) => !SKIP_PATH.test("/" + p) && path.posix.basename(p).toLowerCase() === base).map((p) => "/" + p);
  return candidates.length === 1 && candidates[0] !== brokenPath ? candidates[0] : null;
}
// Ersetzt den kaputten Verweis (voller URL und Pfad-Form) durch das neue Ziel – nichts anderes wird angefasst.
export function replaceRefs(content, { fullUrl, brokenPath, replacement }) {
  let out = content;
  if (fullUrl) { try { const u = new URL(fullUrl); out = out.split(u.href).join(u.origin + replacement); } catch {} }
  return out.split(brokenPath).join(replacement);
}

const LOCATABLE = new Set(["broken_link", "contact_page_broken", "broken_image"]);

export function githubNetlifyAdapter({ dir = WORKER_DIR, store = createStore(dir), env = process.env, fetchFn = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), buildTimeoutMs = 12 * 60_000, pollMs = 20_000, now = () => new Date() } = {}) {

  const ghToken = env[GITHUB_TOKEN_ENV] || "", nfToken = env[NETLIFY_TOKEN_ENV] || "";
  const req = async (base, p, { token, method = "GET", body = null, accept = "application/vnd.github+json" } = {}) => {
    const r = await fetchFn(`${base}${p}`, { method, signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, accept, ...(body ? { "content-type": "application/json" } : {}), "user-agent": "JarvisRepair/1.0" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  const gh = (p, o = {}) => req(GH, p, { token: ghToken, ...o });
  const nf = (p, o = {}) => req(NF, p, { token: nfToken, accept: "application/json", ...o });
  const mappingFor = (order) => loadRepairMappings(store)[normDomain(order.domain)] || null;
  const branchOf = (order) => order.backup?.branch || `repair/${order.order_id}`;

  // Verzeichnisbaum des Produktionsstands (recursive). truncated → fail closed (null), nie mit halbem Baum arbeiten.
  async function tree(m, sha) {
    const r = await gh(`/repos/${m.repo}/git/trees/${sha}?recursive=1`);
    if (r.status !== 200 || r.json?.truncated) return null;
    return (r.json.tree || []).filter((e) => e.type === "blob").map((e) => e.path);
  }
  async function getFile(m, filePath, ref) {
    const r = await gh(`/repos/${m.repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`);
    if (r.status !== 200 || typeof r.json?.content !== "string") return null;
    return { sha: r.json.sha, content: Buffer.from(r.json.content, "base64").toString("utf8") };
  }
  // Dateien, die den kaputten Pfad referenzieren: GitHub-Code-Suche, sonst begrenzter HTML-Scan.
  // TF-JARVIS-028: Die Suche antwortet für nicht (vollständig) indexierte Repos mit 200, 0 Treffern und incomplete_results – das
  // ist kein Beleg für «nirgends referenziert». Nur vollständige Suchtreffer zählen; sonst (leer/unvollständig/Fehler) der Scan.
  async function filesReferencing(m, brokenPath, paths, ref) {
    const s = await gh(`/search/code?q=${encodeURIComponent(`"${brokenPath}" repo:${m.repo}`)}&per_page=10`);
    if (s.status === 200 && Array.isArray(s.json?.items) && s.json.items.length && s.json.incomplete_results !== true) {
      const hits = [];
      for (const it of s.json.items.slice(0, 10)) {
        const f = await getFile(m, it.path, ref);
        if (f && f.content.includes(brokenPath)) hits.push(it.path);
      }
      if (hits.length) return hits;
    }
    const scan = paths.filter((p) => /\.html?$/i.test(p) && !SKIP_PATH.test("/" + p)).slice(0, 40);
    const hits = [];
    for (const p of scan) {
      const f = await getFile(m, p, ref);
      if (f?.content.includes(brokenPath)) hits.push(p);
      if (hits.length > 3) break;
    }
    return hits;
  }

  return {
    stack: "github_netlify",

    // Explizite Zuordnung vorhanden? Dann gehört der Auftrag zu diesem Adapter – auch wenn das Markup nur „statisch“ zeigt.
    async claims(order) { return !!mappingFor(order); },

    async checkAccess(order) {
      const m = mappingFor(order);
      if (!m) return { ok: false, reason: "no_mapping" }; // Domain nie einem Repo zuordnen, das Chris nicht eingetragen hat
      if (!ghToken || !nfToken) return { ok: false, reason: "no_token" };
      const repo = await gh(`/repos/${m.repo}`);
      if (repo.status !== 200 || repo.json?.permissions?.push !== true) return { ok: false, reason: "github_no_push" };
      const site = await nf(`/sites/${m.netlify_site_id}`);
      if (site.status !== 200) return { ok: false, reason: "netlify_site_unreachable" };
      // Die Site muss die Auftrags-Domain wirklich tragen – schützt vor einer falschen Zuordnung.
      const d = normDomain(order.domain);
      const siteDomains = [site.json.custom_domain, ...(site.json.domain_aliases || []), site.json.default_domain, (() => { try { return new URL(site.json.ssl_url || site.json.url).hostname; } catch { return null; } })()]
        .filter(Boolean).map(normDomain);
      if (!siteDomains.includes(d)) return { ok: false, reason: "site_domain_mismatch" };
      return { ok: true, connector: `github+netlify:${m.repo}` };
    },

    async backup(order, { branch }) {
      const m = mappingFor(order);
      if (!m) throw new Error("Keine Repository-Zuordnung.");
      const ref = await gh(`/repos/${m.repo}/git/ref/heads/${encodeURIComponent(m.production_branch)}`);
      if (ref.status !== 200 || !ref.json?.object?.sha) throw fail("Produktions-Branch lesen", ref.status);
      const sha = ref.json.object.sha;
      const created = await gh(`/repos/${m.repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha } });
      if (created.status !== 201) { // existiert schon (Fortsetzung nach Neustart) → vorhandenen Branch akzeptieren, sonst Fehler
        const existing = await gh(`/repos/${m.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
        if (existing.status !== 200) throw fail("Reparatur-Branch anlegen", created.status);
      }
      const site = await nf(`/sites/${m.netlify_site_id}`);
      const publishedId = site.json?.published_deploy?.id;
      if (site.status !== 200 || !publishedId) throw fail("Aktuellen Netlify-Deploy lesen", site.status);
      return { production_ref: sha, backup_ref: `git:${sha}`, rollback_point: `netlify:${publishedId}`, branch };
    },

    // Nur eindeutige Ursachen: kaputter interner Link/Bildpfad, dessen korrektes Ziel es im Repository GENAU EINMAL gibt.
    async locate(issue, order) {
      if (!LOCATABLE.has(issue.type)) return null;
      const m = mappingFor(order);
      if (!m || !order.backup?.production_ref) return null;
      let brokenPath; try { brokenPath = new URL(issue.url).pathname; } catch { return null; }
      if (!brokenPath || brokenPath === "/") return null;
      const paths = await tree(m, order.backup.production_ref);
      if (!paths) return null;
      const replacement = issue.type === "broken_image" ? uniqueImageReplacement(brokenPath, paths) : uniqueReplacement(brokenPath, paths);
      if (!replacement) return null;
      const files = await filesReferencing(m, brokenPath, paths, branchOf(order));
      if (!files.length || files.length > 3) return null; // 0 = nicht auffindbar, >3 = zu breit für einen Minimal-Fix
      return {
        target: files.join(", "), cause: `${files.join(", ")} verweist auf ${brokenPath}, das es im Repository nicht gibt; ${replacement} existiert genau einmal.`,
        planned_change: `Verweis ${brokenPath} → ${replacement} (nur dieser Verweis, keine weiteren Änderungen)`, risk: "niedrig",
        fix: { files, fullUrl: issue.url, brokenPath, replacement },
      };
    },

    async applyFix(item, order) {
      const m = mappingFor(order);
      const fix = item.fix;
      if (!m || !fix?.files?.length || !fix.brokenPath || !fix.replacement) return { ok: false, error: "Fix-Details fehlen." };
      const branch = branchOf(order);
      let lastCommit = null;
      for (const file of fix.files.slice(0, 3)) {
        const f = await getFile(m, file, branch);
        if (!f) return { ok: false, error: `Datei ${file} nicht lesbar.` };
        const next = replaceRefs(f.content, fix);
        if (next === f.content) return { ok: false, error: `Verweis in ${file} nicht gefunden.` };
        const put = await gh(`/repos/${m.repo}/contents/${encodeURIComponent(file).replace(/%2F/g, "/")}`, { method: "PUT",
          body: { message: `fix(${order.order_id}): ${item.planned_change}`, content: Buffer.from(next, "utf8").toString("base64"), sha: f.sha, branch } });
        if (put.status !== 200 && put.status !== 201) return { ok: false, error: `Commit für ${file} fehlgeschlagen (HTTP ${put.status}).` };
        lastCommit = put.json?.commit?.sha || null;
      }
      return { ok: true, change_ref: lastCommit ? `git:${lastCommit}` : `git:${branch}` };
    },

    // Preview: Netlify baut den Reparatur-Branch (Branch-Deploys müssen auf der Site aktiviert sein). Wir warten auf
    // einen fertigen Branch-Deploy; Build-Fehler oder Timeout → build_ok false (fail closed).
    async validate(order) {
      const m = mappingFor(order);
      if (!m) return { build_ok: false };
      if (!order.plan?.length) return { build_ok: true }; // nichts geändert → nichts zu bauen
      const branch = branchOf(order);
      const deadline = Date.now() + buildTimeoutMs;
      for (;;) {
        const r = await nf(`/sites/${m.netlify_site_id}/deploys?branch=${encodeURIComponent(branch)}&per_page=5`);
        const deploys = r.status === 200 && Array.isArray(r.json) ? r.json : [];
        const ready = deploys.find((d) => d.state === "ready");
        if (ready) return { build_ok: true, preview_url: ready.deploy_ssl_url || ready.ssl_url || ready.deploy_url };
        if (deploys.some((d) => d.state === "error")) return { build_ok: false };
        if (Date.now() > deadline) return { build_ok: false };
        await sleep(pollMs);
      }
    },

    // Production über den BESTEHENDEN Weg: Merge des Reparatur-Branches in den Produktions-Branch → Netlify baut wie immer.
    async deployProduction(order) {
      const m = mappingFor(order);
      if (!m) return { ok: false };
      const branch = branchOf(order);
      const mergedAt = now().toISOString();
      const merge = await gh(`/repos/${m.repo}/merges`, { method: "POST",
        body: { base: m.production_branch, head: branch, commit_message: `fix(${order.order_id}): Check & Reparatur – geprüfte Korrekturen aus ${branch}` } });
      if (merge.status !== 201 && merge.status !== 204) return { ok: false, error: `Merge fehlgeschlagen (HTTP ${merge.status}).` };
      const deadline = Date.now() + buildTimeoutMs;
      for (;;) {
        const r = await nf(`/sites/${m.netlify_site_id}/deploys?branch=${encodeURIComponent(m.production_branch)}&per_page=5`);
        const deploys = r.status === 200 && Array.isArray(r.json) ? r.json : [];
        const ready = deploys.find((d) => d.state === "ready" && (!d.created_at || d.created_at >= mergedAt));
        if (ready) return { ok: true, deploy_ref: `netlify:${ready.id}` };
        if (deploys.some((d) => d.state === "error" && (!d.created_at || d.created_at >= mergedAt))) return { ok: false, error: "Production-Build fehlgeschlagen." };
        if (Date.now() > deadline) return { ok: false, error: "Production-Build nicht rechtzeitig fertig." };
        await sleep(pollMs);
      }
    },

    // Rollback über den bestehenden sicheren Kanal: Netlify stellt den vor der Reparatur veröffentlichten Deploy wieder her.
    // Der Git-Merge bleibt bestehen (Historie wird nie umgeschrieben) – der Auftrag endet ohnehin in REPAIR_FAILED für Chris.
    async rollback(order) {
      const m = mappingFor(order);
      const id = (order.backup?.rollback_point || "").replace(/^netlify:/, "");
      if (!m || !id) return { ok: false };
      const r = await nf(`/sites/${m.netlify_site_id}/deploys/${id}/restore`, { method: "POST" });
      return { ok: r.status === 200 || r.status === 201 };
    },
  };
}

// Kommandozeile: Zuordnung pflegen/prüfen (enthält nie Secrets; Tokens werden nur als vorhanden/fehlend gemeldet).
//   node repair-adapters/github-netlify.js --map <domain> --repo owner/name [--branch main] --site <netlify-site-id>
//   node repair-adapters/github-netlify.js --list | --check <domain>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flagOf = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
  const store = createStore(WORKER_DIR);
  const run = async () => {
    if (argv.includes("--list")) { const m = loadRepairMappings(store); console.log(JSON.stringify(m, null, 2)); return 0; }
    if (flagOf("map")) { const r = setRepairMapping(store, flagOf("map"), { repo: flagOf("repo"), production_branch: flagOf("branch") || "main", netlify_site_id: flagOf("site") }); console.log(`Zuordnung gespeichert: ${flagOf("map")} → ${r.repo} (${r.production_branch}) / Netlify ${r.netlify_site_id}`); return 0; }
    if (flagOf("check")) {
      const adapter = githubNetlifyAdapter({ store });
      const r = await adapter.checkAccess({ domain: flagOf("check") });
      console.log(JSON.stringify({ domain: normDomain(flagOf("check")), ...r, github_token: process.env[GITHUB_TOKEN_ENV] ? "vorhanden" : "fehlt", netlify_token: process.env[NETLIFY_TOKEN_ENV] ? "vorhanden" : "fehlt" }, null, 2));
      return r.ok ? 0 : 1;
    }
    console.log("Befehle: --map <domain> --repo owner/name [--branch main] --site <id> | --list | --check <domain>");
    return 1;
  };
  run().then((c) => process.exit(c), (e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
