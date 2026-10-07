// Cloud-First Phase B: Operational State vom (optionalen) Windows-PC auf den VPS (authoritative) übernehmen.
// Regeln (fail closed, nie historische Daten überschreiben):
//  - additiv: nur fehlende Einträge kommen dazu; bei abweichendem Inhalt gewinnt der VPS (Konflikt wird gezählt, nicht gelöst)
//  - suppression.json: Vereinigung – ein Opt-out/Sperre geht nie verloren
//  - config.json: ausschliesslich `offer`, nur wenn Windows nachweislich neuer ist und genau die Angebote CHF 150 / CHF 480 nennt
//  - Secrets (Gmail-Token/Credentials, .env) werden NIE übertragen
//
//   node scripts/merge-state.mjs            → Dry-Run (nur Plan, nichts wird verändert)
//   node scripts/merge-state.mjs --apply    → Backup auf dem VPS, Worker kurz stoppen, mergen, Worker starten
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STATE_FILES = ["mail_worker/discovered.json", "mail_worker/suppression.json", "mail_worker/leads.json", "mail_worker/individual_reviews.json", "gmail_jarvis.json"];
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const itemKey = (x) => (isObj(x) ? x.id || x.leadId || x.email || x.domain || x.threadId || JSON.stringify(x) : JSON.stringify(x));

// Additive Zusammenführung: base (VPS) bleibt massgeblich, extra (Windows) ergänzt nur Fehlendes.
// Ab Tiefe 2 (z. B. leads.<domain>, drafts.<id>) ist ein Eintrag atomar: ganz übernehmen oder gar nicht – nie zwei Versionen mischen.
export function additiveMerge(base, extra, report, depth = 0) {
  if (base === undefined) { report.added++; return structuredClone(extra); }
  if (isObj(base) && isObj(extra) && depth < 2) {
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) out[k] = additiveMerge(base[k], v, report, depth + 1);
    return out;
  }
  if (Array.isArray(base) && Array.isArray(extra)) {
    const have = new Map(base.map((x) => [itemKey(x), x]));
    const out = [...base];
    for (const x of extra) {
      const k = itemKey(x);
      if (!have.has(k)) { out.push(structuredClone(x)); have.set(k, x); report.added++; }
      else if (!same(have.get(k), x)) report.conflicts++;
    }
    return out;
  }
  if (!same(base, extra)) report.conflicts++;
  return base;
}

export function offerDecision({ vps, win }) {
  const v = vps?.data?.offer, w = win?.data?.offer;
  if (typeof w !== "string" || !w) return { take: false, reason: "windows_ohne_offer" };
  if (v === w) return { take: false, reason: "gleich" };
  if (!/CHF\s*150\b/.test(w) || !/CHF\s*480\b/.test(w) || /CHF\s*(2['’]?490|500)\b/.test(w)) return { take: false, reason: "windows_offer_nicht_150_480" };
  if (!(Date.parse(win.mtime) > Date.parse(vps?.mtime || 0))) return { take: false, reason: "vps_neuer_oder_gleich_alt" };
  return { take: true, reason: "windows_neuer_und_150_480" };
}

// files: { [name]: { data, mtime } } je Seite. Ergebnis: geänderte Dateien + Bericht (nur Zahlen/Wörter).
export function planMerge({ vps, win }) {
  const changes = {}, report = {};
  for (const f of STATE_FILES) {
    const r = { added: 0, conflicts: 0 };
    const w = win[f]?.data, v = vps[f]?.data;
    if (w === undefined) { report[f] = { ...r, skipped: "nicht_auf_windows" }; continue; }
    const next = v === undefined ? structuredClone(w) : additiveMerge(v, w, r);
    if (v === undefined) r.added = 1;
    report[f] = r;
    if (!same(next, v)) changes[f] = next;
  }
  const cfg = "mail_worker/config.json", od = offerDecision({ vps: vps[cfg], win: win[cfg] });
  report[cfg] = { offer: od.reason };
  if (od.take) changes[cfg] = { ...vps[cfg].data, offer: win[cfg].data.offer };
  return { changes, report };
}

// ---------- CLI ----------
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SSH = process.platform === "win32" ? "C:/WINDOWS/System32/OpenSSH/ssh.exe" : "ssh";
const HOST = process.env.JARVIS_VPS_HOST || "fiverr";
const R = "/opt/jarvis-mail";

function readLocal(secrets) {
  const out = {};
  for (const f of [...STATE_FILES, "mail_worker/config.json"]) {
    const p = path.join(secrets, f);
    try { out[f] = { data: JSON.parse(fs.readFileSync(p, "utf8")), mtime: fs.statSync(p).mtime.toISOString() }; } catch {}
  }
  return out;
}
// Läuft im Jarvis-Image (gleicher Node, gleiches Volume /data/secrets) – liest bzw. schreibt atomar.
const REMOTE_READ = `import fs from "node:fs";const out={};for(const f of ${JSON.stringify([...STATE_FILES, "mail_worker/config.json"])}){const p="/data/secrets/"+f;try{out[f]={data:JSON.parse(fs.readFileSync(p,"utf8")),mtime:fs.statSync(p).mtime.toISOString()}}catch{}}process.stdout.write(JSON.stringify(out));`;
const remoteWrite = (changes) => `import fs from "node:fs";const c=${JSON.stringify(changes)};for(const[f,d]of Object.entries(c)){const p="/data/secrets/"+f,t=p+".merge.tmp";fs.writeFileSync(t,JSON.stringify(d,null,2),{mode:0o600});fs.renameSync(t,p)}process.stdout.write(JSON.stringify(Object.keys(c)));`;
const ssh = (cmd, input) => execFileSync(SSH, ["-o", "BatchMode=yes", HOST, cmd], { input, encoding: "utf8", maxBuffer: 64 * 2 ** 20 });
const runInImage = (script) => ssh(`cd ${R} && sudo docker compose run --rm --no-deps -T --entrypoint node mail-worker --input-type=module -`, script);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const apply = process.argv.includes("--apply");
  const win = readLocal(process.env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets"));
  if (apply) {
    // 1) Backup des aktuellen VPS-Stands (root, 600), 2) Worker stoppen → kein gleichzeitiger Schreiber
    ssh(`sudo sh -c 'set -e; umask 077; install -d -m 700 ${R}/backups; tar -czf ${R}/backups/pre-merge-$(date -u +%Y%m%dT%H%M%SZ).tgz --exclude=mail_worker/worker.log -C ${R}/secrets mail_worker gmail_jarvis.json; chmod 600 ${R}/backups/*.tgz; cd ${R} && docker compose stop mail-worker >/dev/null 2>&1'`);
  }
  let result;
  try {
    const vps = JSON.parse(runInImage(REMOTE_READ));
    const { changes, report } = planMerge({ vps, win });
    result = { mode: apply ? "apply" : "dry-run", files_to_change: Object.keys(changes), report };
    if (apply && Object.keys(changes).length) result.written = JSON.parse(runInImage(remoteWrite(changes)));
  } finally {
    if (apply) ssh(`cd ${R} && sudo docker compose up -d --no-build mail-worker >/dev/null 2>&1`);
  }
  console.log(JSON.stringify(result, null, 2));
}
