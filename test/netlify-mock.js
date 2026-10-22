// Hermetische Netlify-Attrappe (TF-JARVIS-PRAXIS-002): API (Sites, Deploys, Dateilisten, Entwurf, Upload, Restore) + Deploy-Permalinks
// + ein HTTP-Proxy, über den ein echter Chromium dieselben Inhalte sieht. Keine echte Netlify-Site, kein Netzwerk nach aussen.
import crypto from "node:crypto";
import http from "node:http";

export const GOOD_TOKEN = "nfp_test_good_token_0123456789";
export const READONLY_TOKEN = "nfp_test_readonly_token_0123456789";
const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");
const hex = (n) => crypto.randomBytes(n).toString("hex");

// hostSuffix: zusätzliche Test-Endung für Permalinks (z. B. «netlify-mock.test») – echte Browser (Chrome stable) erzwingen für *.netlify.app
// HTTPS (HSTS-Preload), der Mock-Proxy spricht nur HTTP.
export function createNetlifyMock({ siteName = "praxis-test", siteId = "11111111-2222-4333-8444-555555555555", files = {}, repoUrl = null, customDomain = null, hostSuffix = null } = {}) {
  const blobs = new Map();
  const deploys = new Map();
  const calls = [];
  const put = (content) => { const b = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"); const s = sha1(b); blobs.set(s, b); return s; };
  const mkDeploy = (fileMap, extra = {}) => { const id = hex(12); deploys.set(id, { id, site_id: siteId, state: "ready", files: fileMap, created_at: new Date().toISOString(), ...extra }); return id; };
  const initial = Object.fromEntries(Object.entries(files).map(([p, c]) => [p, put(c)]));
  const site = { id: siteId, site_id: siteId, name: siteName, url: `http://${siteName}.netlify.app`, ssl_url: `https://${siteName}.netlify.app`, custom_domain: customDomain, domain_aliases: [],
    build_settings: repoUrl ? { repo_url: repoUrl } : {}, published_deploy: { id: null } };
  site.published_deploy.id = mkDeploy(initial);
  const state = { site, deploys, blobs, calls, failNextPublish: false, failDraft: null };
  const json = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // Inhalt einer Datei eines Deploys (Permalink bzw. Live-Domain). "/" → /index.html (Pretty URLs: /index.html leitet um).
  function serve(deployId, p) {
    const d = deploys.get(deployId);
    if (!d || d.state !== "ready") return null;
    if (p === "/index.html") return { redirect: "/" };
    const key = p.endsWith("/") ? `${p}index.html` : p;
    const s = d.files[key];
    return s ? { body: blobs.get(s), type: key.endsWith(".html") ? "text/html; charset=utf-8" : key.endsWith(".css") ? "text/css" : key.endsWith(".png") ? "image/png" : "application/octet-stream" } : null;
  }
  function resolveHost(host) {
    const m = String(host).toLowerCase().match(/^([0-9a-f]{24})--([a-z0-9-]+)\.(.+)$/);
    if (m && m[2] === siteName && (m[3] === "netlify.app" || (hostSuffix && m[3] === hostSuffix))) return m[1];
    if (host === `${siteName}.netlify.app` || (customDomain && host === customDomain)) return site.published_deploy.id;
    return null;
  }

  async function fetchFn(url, opts = {}) {
    const u = new URL(String(url));
    const method = (opts.method || "GET").toUpperCase();
    if (u.hostname !== "api.netlify.com") {
      const id = resolveHost(u.hostname);
      const r = id ? serve(id, decodeURI(u.pathname)) : null;
      if (!r) return new Response("not found", { status: 404 });
      if (r.redirect) return new Response(null, { status: 301, headers: { location: r.redirect } });
      return new Response(r.body, { status: 200, headers: { "content-type": r.type } });
    }
    const p = u.pathname.replace(/^\/api\/v1/, "");
    const auth = String(opts.headers?.authorization || "");
    calls.push({ method, path: p });
    if (auth !== `Bearer ${GOOD_TOKEN}` && auth !== `Bearer ${READONLY_TOKEN}`) return json(401, { code: 401, message: "Access Denied" });
    const ro = auth === `Bearer ${READONLY_TOKEN}`;
    let m;
    if (method === "GET" && (m = p.match(/^\/sites\/([^/]+)$/))) return m[1] === siteId ? json(200, structuredClone(site)) : json(404, { code: 404 });
    if (method === "GET" && (m = p.match(/^\/sites\/([^/]+)\/deploys$/))) return m[1] === siteId ? json(200, [...deploys.values()].slice(-Number(u.searchParams.get("per_page") || 10)).map(({ files, ...d }) => d)) : json(404, {});
    if (method === "GET" && (m = p.match(/^\/deploys\/([0-9a-f]{24})$/))) { const d = deploys.get(m[1]); return d ? json(200, (({ files, ...x }) => x)(d)) : json(404, {}); }
    if (method === "GET" && (m = p.match(/^\/deploys\/([0-9a-f]{24})\/files$/))) {
      const d = deploys.get(m[1]); if (!d) return json(404, {});
      const page = Number(u.searchParams.get("page") || 1), per = Number(u.searchParams.get("per_page") || 100);
      return json(200, Object.entries(d.files).sort().slice((page - 1) * per, page * per).map(([path, sha]) => ({ id: path, path, sha, size: blobs.get(sha)?.length || 0, mime_type: "application/octet-stream" })));
    }
    if (method === "POST" && (m = p.match(/^\/sites\/([^/]+)\/deploys$/))) {
      if (m[1] !== siteId) return json(404, {});
      if (ro) return json(403, { code: 403, message: "Forbidden" });
      if (state.failDraft) return json(state.failDraft, {});
      const body = JSON.parse(opts.body || "{}");
      const id = mkDeploy({ ...body.files }, { state: "uploading", draft: body.draft === true, title: body.title || null });
      const required = [...new Set(Object.values(body.files || {}).filter((s) => !blobs.has(s)))];
      deploys.get(id).required = required;
      if (!required.length) deploys.get(id).state = "ready";
      return json(200, { id, required, state: deploys.get(id).state });
    }
    if (method === "PUT" && (m = p.match(/^\/deploys\/([0-9a-f]{24})\/files(\/.+)$/))) {
      const d = deploys.get(m[1]); if (!d) return json(404, {});
      if (ro) return json(403, {});
      const buf = Buffer.from(opts.body);
      const s = sha1(buf);
      if (d.files[decodeURI(m[2])] !== s) return json(422, { message: "sha mismatch" });
      blobs.set(s, buf);
      d.required = (d.required || []).filter((x) => x !== s);
      if (!d.required.length) d.state = "ready";
      return json(200, { id: decodeURI(m[2]), sha: s });
    }
    if (method === "POST" && (m = p.match(/^\/sites\/([^/]+)\/deploys\/([0-9a-f]{24})\/restore$/))) {
      if (m[1] !== siteId || !deploys.has(m[2])) return json(404, {});
      if (ro) return json(403, {});
      if (state.failNextPublish) { state.failNextPublish = false; return json(500, {}); }
      site.published_deploy = { id: m[2] };
      return json(200, { id: m[2] });
    }
    return json(404, { code: 404, message: `mock: ${method} ${p}` });
  }

  // HTTP-Proxy für Chromium (--proxy-server): gleiche Inhalte wie fetchFn, über echte HTTP-Antworten.
  function startProxy() {
    return new Promise((resolve) => {
      const srv = http.createServer(async (req, res) => {
        let target; try { target = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
        const r = await fetchFn(target.href, { method: req.method });
        const headers = Object.fromEntries(r.headers.entries());
        res.writeHead(r.status, headers);
        res.end(Buffer.from(await r.arrayBuffer()));
      });
      srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => new Promise((r) => srv.close(r)) }));
    });
  }
  const filesOf = (deployId) => Object.fromEntries(Object.entries(deploys.get(deployId)?.files || {}).map(([p, s]) => [p, blobs.get(s)]));
  const addDeploy = (fileContents) => mkDeploy(Object.fromEntries(Object.entries(fileContents).map(([p, c]) => [p, put(c)])));
  const publish = (id) => { site.published_deploy = { id }; };
  return { fetchFn, state, site, calls, startProxy, filesOf, addDeploy, publish, sha1, siteId, siteName };
}
