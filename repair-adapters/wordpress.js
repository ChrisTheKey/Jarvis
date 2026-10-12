// WordPress-REST-Adapter für CHECK & REPARATUR CHF 480 (TF-042). Repariert ausschliesslich eindeutig lokalisierte Verweise
// (href/src) in Seiten, Beiträgen und Navigations-Objekten über die WordPress REST API – nie über wp-admin, nie per Browser.
//
// Sicherheitsmodell:
//   - Auth: Application Password bzw. temporärer Benutzer mit minimalen Rechten (HTTP Basic über HTTPS). Zugangsdaten nur
//     zur Laufzeit im Credential-Kontext (router.js), nie gespeichert, nie geloggt, nie in Fehlermeldungen.
//   - HTTPS Pflicht; REST-Basis muss exakt auf der Auftrags-Domain liegen; Weiterleitungen werden mit Zugangsdaten NIE verfolgt.
//   - Nur lesende Rechte → BLOCKED_NO_ACCESS. Rechte werden nie erweitert, Benutzer nie erstellt.
//   - Schreiben NUR auf /wp/v2/(pages|posts|navigation)/<id> (harte Allowlist im Code). Nie Plugins, Themes, Benutzer,
//     Einstellungen, PHP, SQL, WooCommerce/Checkout, Preise oder rechtliche Seiten.
//   - Vor JEDEM Write: Originalobjekt (raw content + Hash + modified) lokal gesichert; ohne Backup kein Write. Nach dem Write
//     wird der Hash geprüft; Rollback stellt exakt den Originalinhalt wieder her und prüft ihn erneut.
import { WORKER_DIR } from "../mail-worker.js";
import { ISSUE_FIX_MATRIX, fixSpecFor, requiredCapabilities, patchReference, isProtectedText, assertDomainBinding, liveTarget,
  objectBackups, sha256, normDomain, DomainBindingError, MAX_FILES_PER_FIX } from "./common.js";

export const WP_OBJECT_TYPES = Object.freeze(["pages", "posts", "navigation"]);
// Einzige Schreibziele. Alles andere (plugins, themes, users, settings, …) wird vor dem Request verweigert.
export const WP_WRITE_PATH_RE = /^\/wp\/v2\/(pages|posts|navigation)\/\d+$/;
const EDIT_CAPS = ["edit_pages", "edit_published_pages", "edit_posts", "edit_published_posts"];
const CAPS = Object.freeze(["REST_CONTENT_READ", "REST_CONTENT_WRITE", "BACKUP", "ROLLBACK", "HEALTH_CHECK"]);
const clean = (s) => s.toLowerCase().replace(/\.(html?|php)$/i, "").replace(/[-_](alt|old|neu|new|backup|kopie|copy|\d)$/i, "");

// REST-Basis aus Profil bzw. Zugangsdaten – nur HTTPS, nur exakt die Auftrags-Domain. Sonst null (kein Zugang).
export function resolveApiBase(cred = {}, order = {}) {
  const src = cred.api_base || cred.host || "";
  let u; try { u = new URL(/^[a-z]+:\/\//i.test(src) ? src : `https://${src}`); } catch { return { error: "api_base_invalid" }; }
  if (u.protocol !== "https:") return { error: "https_required" };
  if (normDomain(u.hostname) !== normDomain(order.domain)) return { error: "domain_mismatch" };
  const i = u.pathname.indexOf("/wp-json");
  const base = `${u.origin}${i >= 0 ? u.pathname.slice(0, i) : u.pathname.replace(/\/+$/, "")}/wp-json`.replace(/([^:])\/\/+/g, "$1/");
  return { base, host: u.hostname };
}

export function wordpressAdapter({ dir = WORKER_DIR, fetchFn = globalThis.fetch, timeoutMs = 20_000, maxObjects = 100 } = {}) {
  const backups = (order) => objectBackups(dir, order.order_id);

  async function api(cred, base, p, { method = "GET", body = null } = {}) {
    if (method !== "GET" && !WP_WRITE_PATH_RE.test(p.split("?")[0])) throw new Error(`WordPress-Write auf ${p.split("?")[0]} verweigert (nicht in der Allowlist).`);
    const r = await fetchFn(base + p, { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: "Basic " + Buffer.from(`${cred.username}:${cred.password}`).toString("base64"), accept: "application/json",
        "user-agent": "JarvisRepair/1.0", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.status >= 300 && r.status < 400) throw new DomainBindingError("REST-Weiterleitung – Zugangsdaten werden nie weitergereicht, STOP.");
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, json, total_pages: Number(r.headers?.get?.("x-wp-totalpages") || 1) };
  }
  const baseOf = (cred, order) => { const b = resolveApiBase(cred, order); if (b.error) throw new Error(`WordPress-REST-Basis ungültig (${b.error}).`); return b; };
  const getObject = async (cred, base, type, id) => {
    const r = await api(cred, base, `/wp/v2/${type}/${id}?context=edit`);
    if (r.status !== 200 || typeof r.json?.content?.raw !== "string") throw new Error(`Objekt ${type}/${id} nicht lesbar (HTTP ${r.status}).`);
    return { raw: r.json.content.raw, modified: r.json.modified_gmt || r.json.modified || null, slug: r.json.slug || "", title: r.json.title?.raw || r.json.title?.rendered || "" };
  };
  const writeObject = async (cred, base, type, id, raw) => {
    const r = await api(cred, base, `/wp/v2/${type}/${id}`, { method: "POST", body: { content: raw } });
    if (r.status !== 200) throw new Error(`Speichern von ${type}/${id} fehlgeschlagen (HTTP ${r.status}).`);
    const after = typeof r.json?.content?.raw === "string" ? r.json.content.raw : (await getObject(cred, base, type, id)).raw;
    return sha256(after);
  };

  // Eindeutiges Ersatzziel: veröffentlichte Seite/Beitrag mit passendem Slug bzw. Medium mit gleichem Dateinamen – GENAU EINS.
  async function replacementFor(cred, base, spec, brokenPath, domain) {
    const name = brokenPath.split("/").filter(Boolean).pop() || "";
    if (!name) return null;
    let found = [];
    if (spec.attr === "href") {
      const slug = clean(decodeURIComponent(name));
      if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
      for (const type of ["pages", "posts"]) {
        const r = await api(cred, base, `/wp/v2/${type}?slug=${encodeURIComponent(slug)}&status=publish&_fields=id,link,slug`);
        if (r.status === 200 && Array.isArray(r.json)) found.push(...r.json.filter((x) => x.slug === slug).map((x) => x.link));
      }
    } else {
      const stem = name.replace(/\.[a-z0-9]+$/i, "");
      if (!/^[\w.-]{1,120}$/.test(stem)) return null;
      const r = await api(cred, base, `/wp/v2/media?search=${encodeURIComponent(stem)}&per_page=20&_fields=id,source_url`);
      if (r.status === 200 && Array.isArray(r.json)) found = r.json.map((x) => x.source_url).filter((s) => { try { return new URL(s).pathname.split("/").pop().toLowerCase() === name.toLowerCase(); } catch { return false; } });
    }
    const paths = [...new Set(found.map((l) => { try { const u = new URL(l); return normDomain(u.hostname) === normDomain(domain) ? u.pathname : null; } catch { return null; } }))];
    if (paths.length !== 1 || paths[0] === brokenPath) return null; // 0 oder mehrere Kandidaten → nicht eindeutig
    return paths[0];
  }

  return {
    stack: "wordpress",
    detectCapabilities: () => [...CAPS],

    async checkAccess(order, cred) {
      if (!cred?.username || !cred?.password) return { ok: false, reason: "no_credentials" };
      const b = resolveApiBase(cred, order);
      if (b.error) return { ok: false, reason: b.error };
      const index = await api(cred, b.base, "/");
      if (index.status !== 200 || !Array.isArray(index.json?.namespaces) || !index.json.namespaces.includes("wp/v2")) return { ok: false, reason: "rest_unavailable" };
      const me = await api(cred, b.base, "/wp/v2/users/me?context=edit");
      if (me.status === 401 || me.status === 403) return { ok: false, reason: "auth_failed" };
      if (me.status !== 200 || !me.json?.capabilities) return { ok: false, reason: "capabilities_unknown" };
      const canWrite = EDIT_CAPS.some((c) => me.json.capabilities[c] === true);
      // Nur lesend → kein Repair. Rechte werden nie erweitert, es wird kein Benutzer angelegt.
      if (!canWrite) return { ok: false, reason: "read_only", capabilities: ["REST_CONTENT_READ"] };
      backups(order).verifyWritable();
      return { ok: true, connector: "wordpress_rest", capabilities: [...CAPS] };
    },

    async backup(order, cred) {
      const b = baseOf(cred, order);
      backups(order).verifyWritable();
      return { production_ref: `wp:${sha256(b.base).slice(0, 12)}`, backup_ref: "local:object-backup", rollback_point: "per-object-original" };
    },

    // Nur eindeutige Ursachen: genau ein Ersatzziel, betroffene Objekte vollständig bekannt (≤ 3), jede Stelle exakt patchbar.
    async locate(issue, order, cred) {
      const spec = fixSpecFor(issue?.type);
      if (!spec || !spec.families.includes("content") || !spec.attr) return null;
      let broken; try { broken = new URL(issue.url); } catch { return null; }
      if (normDomain(broken.hostname) !== normDomain(order.domain)) return null; // externer Verweis – Ziel unbekannt
      const brokenPath = broken.pathname;
      if (!brokenPath || brokenPath === "/") return null;
      let pagePath = ""; try { pagePath = new URL(issue.page || issue.url).pathname; } catch {}
      if (isProtectedText(pagePath, brokenPath)) return null;
      const b = baseOf(cred, order);
      const replacement = await replacementFor(cred, b.base, spec, brokenPath, order.domain);
      if (!replacement || isProtectedText(replacement)) return null;
      // Ziel muss öffentlich erreichbar sein (gleiche Domain, kein Fehler) – sonst wäre die Korrektur geraten.
      const live = await liveTarget(fetchFn, `https://${normDomain(order.domain)}${replacement}`, order.domain).catch(() => null);
      if (!live || live.status >= 400) return null;
      const hits = [];
      for (const type of WP_OBJECT_TYPES) {
        const r = await api(cred, b.base, `/wp/v2/${type}?context=edit&status=publish&per_page=${maxObjects}&_fields=id,slug,title,content,modified_gmt`);
        if (r.status !== 200 || !Array.isArray(r.json)) { if (type === "navigation") continue; return null; }
        if (r.total_pages > 1) return null; // nicht vollständig gelesen → Eindeutigkeit nicht belegbar
        for (const o of r.json) {
          const raw = o?.content?.raw;
          if (typeof raw !== "string") continue;
          const p = patchReference(raw, { attr: spec.attr, brokenPath, fullUrl: issue.url, replacement, domain: order.domain, blockJson: true });
          if (p.reason === "not_found") continue;
          if (!p.ok) return null; // Verweis da, aber nicht exakt patchbar → nie raten
          if (isProtectedText(o.slug, o.title?.raw || o.title?.rendered)) return null; // geschützte Seite → nie automatisch
          hits.push({ object_type: type, object_id: Number(o.id), before_hash: sha256(raw), modified: o.modified_gmt || null, occurrences: p.count });
        }
      }
      if (!hits.length || hits.length > MAX_FILES_PER_FIX) return null;
      const where = hits.map((h) => `WordPress ${h.object_type}#${h.object_id}`).join(", ");
      return {
        family: "content", fix_type: spec.fix, attr: spec.attr, brokenPath, fullUrl: issue.url, replacement, objects: hits,
        required_capabilities: requiredCapabilities("content"), risk: "niedrig", target: where,
        cause: `${where} verweist auf ${brokenPath} (existiert nicht); ${replacement} existiert genau einmal.`,
        planned_change: `${spec.attr} ${brokenPath} → ${replacement} (nur dieser Verweis)`,
      };
    },

    async applyFix(issue, location, order, cred) {
      if (location?.family !== "content" || !ISSUE_FIX_MATRIX[issue?.type] || !Array.isArray(location.objects) || !location.objects.length) return { ok: false, reason: "invalid_location" };
      const b = baseOf(cred, order);
      // Domain-Bindung unmittelbar vor dem Write: Auftrag, Freigabe, Zugang, REST-Host und Live-Ziel (keine fremde Weiterleitung).
      try {
        const live = await liveTarget(fetchFn, order.website || `https://${order.domain}/`, order.domain);
        assertDomainBinding(order, { accessDomain: b.host, liveDomain: new URL(live.final_url).hostname });
      } catch (e) { if (e.code === "DOMAIN_MISMATCH") return { ok: false, domain_mismatch: true, reason: "domain_mismatch" }; throw e; }
      const bk = backups(order);
      const done = [];
      try {
        for (const obj of location.objects.slice(0, MAX_FILES_PER_FIX)) {
          if (!WP_OBJECT_TYPES.includes(obj.object_type)) throw new Error("Objekttyp nicht erlaubt.");
          const cur = await getObject(cred, b.base, obj.object_type, obj.object_id);
          const curHash = sha256(cur.raw);
          // TF-044: seit dem Plan nur durch einen EIGENEN, bereits angewendeten Fix dieses Auftrags verändert (mehrere Befunde im
          // selben Objekt) – jede fremde Änderung → kein Write.
          if (curHash !== obj.before_hash && !bk.entries().some((e) => e.object_type === `wp_${obj.object_type}` && e.object_id === String(obj.object_id) && e.status === "applied" && e.after_hash === curHash))
            throw new Error("Objekt wurde seit dem Plan verändert – kein Write.");
          if (isProtectedText(cur.slug, cur.title)) throw new Error("Geschütztes Objekt – kein Write.");
          const p = patchReference(cur.raw, { attr: location.attr, brokenPath: location.brokenPath, fullUrl: location.fullUrl, replacement: location.replacement, domain: order.domain, blockJson: true });
          if (!p.ok) throw new Error(`Verweis nicht exakt patchbar (${p.reason}).`);
          const entry = bk.add({ object_type: `wp_${obj.object_type}`, object_id: obj.object_id, original_hash: curHash, original_content: cur.raw, modified_at: cur.modified });
          const afterHash = await writeObject(cred, b.base, obj.object_type, obj.object_id, p.text);
          if (afterHash !== sha256(p.text)) { bk.update(entry.backup_id, { after_hash: afterHash, status: "applied" }); done.push(entry.backup_id); throw new Error("Gespeicherter Inhalt weicht ab."); }
          bk.update(entry.backup_id, { after_hash: afterHash, status: "applied" });
          done.push(entry.backup_id);
        }
      } catch (e) {
        // Teilweise geschrieben → genau diese Objekte sofort zurücksetzen (kein halber Fix bleibt live).
        if (done.length) await restoreEntries(cred, b.base, bk, done).catch(() => {});
        throw e;
      }
      const last = bk.entries().find((x) => x.backup_id === done[done.length - 1]);
      return { ok: true, change_ref: `wp:${location.objects.map((o) => `${o.object_type}/${o.object_id}`).join(",")}`, before_hash: location.objects[0].before_hash, after_hash: last?.after_hash || null };
    },

    // Objekt entspricht exakt dem geschriebenen Stand UND die öffentliche Seite verweist nicht mehr auf das kaputte Ziel.
    async validate(issue, order, cred) {
      const loc = issue?.location;
      if (!loc || loc.family !== "content") return { build_ok: false };
      const b = baseOf(cred, order);
      const applied = backups(order).entries().filter((e) => e.status === "applied");
      for (const obj of loc.objects) {
        const e = applied.filter((x) => x.object_type === `wp_${obj.object_type}` && x.object_id === String(obj.object_id)).pop(); // letzter Fix des Objekts
        if (!e) return { build_ok: false };
        const cur = await getObject(cred, b.base, obj.object_type, obj.object_id);
        if (sha256(cur.raw) !== e.after_hash) return { build_ok: false };
      }
      const live = await liveTarget(fetchFn, issue.page || order.website, order.domain);
      if (live.status >= 400) return { build_ok: false };
      const still = patchReference(live.html, { attr: loc.attr, brokenPath: loc.brokenPath, fullUrl: loc.fullUrl, replacement: loc.replacement, domain: order.domain });
      return { build_ok: still.reason === "not_found" };
    },

    // Änderungen über die REST API sind sofort live – „Production“ = Health Check der öffentlichen Seite (gleiche Domain).
    async deployProduction(order) {
      const live = await liveTarget(fetchFn, order.website || `https://${order.domain}/`, order.domain);
      return live.status < 400 ? { ok: true, deploy_ref: "live:wordpress_rest" } : { ok: false, reason: `health_${live.status}` };
    },

    async rollback(order, _backup, cred) {
      const b = baseOf(cred, order);
      const bk = backups(order);
      const ids = bk.entries().filter((e) => e.status === "applied").map((e) => e.backup_id);
      if (!ids.length) return { ok: true };
      return { ok: await restoreEntries(cred, b.base, bk, ids) };
    },

    async cleanup() { return { ok: true, revoked_required: true }; },
  };

  // Rückwärts wiederherstellen; nur wenn der aktuelle Stand exakt unser geschriebener ist (sonst hat jemand anderes geändert).
  async function restoreEntries(cred, base, bk, ids) {
    let ok = true;
    for (const id of [...ids].reverse()) {
      const e = bk.entries().find((x) => x.backup_id === id);
      const [, type] = e.object_type.match(/^wp_(pages|posts|navigation)$/) || [];
      if (!type) { ok = false; continue; }
      const cur = await getObject(cred, base, type, e.object_id);
      const h = sha256(cur.raw);
      if (h === e.original_hash) { bk.update(id, { status: "restored" }); continue; }
      if (h !== e.after_hash) { ok = false; continue; }
      const restored = await writeObject(cred, base, type, e.object_id, bk.content(e));
      if (restored === e.original_hash) bk.update(id, { status: "restored" }); else ok = false;
    }
    return ok;
  }
}
