// TF-058 – historische Website-Fehler-Leads aus den verschlüsselten State-Backups (lokal, Private Key nur hier).
//
//   node scripts/tf058-history-from-backups.mjs --dir <Ordner mit state-*.json> --out <import.json> [--key .secrets/backup_private.pem]
//
// - Entschlüsselt jede Backup-Generation NUR im Speicher (backup.js decryptBackup, fail closed) – kein Klartext auf der Platte, keine
//   Ausgabe des Schlüssels oder von Inhalten. Liest daraus ausschliesslich mail_worker/discovered.json.
// - Übernimmt nur Leads mit Firma + Domain + ≥ 1 gültigem, für Besucher sichtbarem Befund (discovery-history.js historyRecord);
//   gleicher Lead über mehrere Backups = ein Datensatz, neuester belegter Audit gewinnt, Befunde dedupliziert.
// - index_meta: Stammdaten (Firma, Gebiet, Branche, geschäftliche Adresse, Status) für Domains ohne Befund – nur damit der spätere
//   passive Recheck einen Firmennamen hat. Keine Roh-Evidence, keine Seiteninhalte.
// Ausgabe auf der Konsole: nur Zahlen.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptBackup } from "../backup.js";
import { historyRecord, upsertHistory, emptyHistory } from "../discovery-history.js";
import { normDomain } from "../site-findings.js";

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const META_KEYS = ["company", "canton", "municipality", "category", "business_email", "status"];

export function extractFromPayloads(payloads, now = new Date()) {
  const st = emptyHistory(), skipped = {}, meta = {};
  let generations = 0, leadsSeen = 0;
  for (const p of payloads) {
    const raw = p?.files?.["mail_worker/discovered.json"];
    if (!raw) continue;
    generations++;
    let leads = {}; try { leads = JSON.parse(raw).leads || {}; } catch { continue; }
    for (const l of Object.values(leads)) {
      leadsSeen++;
      const r = historyRecord(l, { source: "backup" });
      if (r.record) upsertHistory(st, r.record, now);
      else skipped[r.skip] = (skipped[r.skip] || 0) + 1;
      const d = normDomain(l?.domain || "");
      const at = l?.auditedAt || l?.discoveredAt || "";
      if (d && (!meta[d] || at > meta[d]._at)) meta[d] = { _at: at, company: l.company || null, canton: l.canton || null, municipality: l.municipality || null,
        category: l.category || null, business_email: l.business_email || l.email || null, status: l.status || null };
    }
  }
  const index_meta = {};
  for (const [d, m] of Object.entries(meta)) if (!st.leads[d]) index_meta[d] = Object.fromEntries(META_KEYS.map((k) => [k, m[k]]));
  return { generations, leads_seen: leadsSeen, records: Object.values(st.leads), index_meta, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = arg("--dir"), out = arg("--out");
  if (!dir || !out) { console.log("Aufruf: --dir <Backups> --out <import.json> [--key <pem>]"); process.exit(1); }
  const pem = fs.readFileSync(arg("--key") || path.join(process.cwd(), ".secrets", "backup_private.pem"), "utf8");
  const files = fs.readdirSync(dir).filter((f) => /^state-.*\.json$/.test(f)).sort();
  const payloads = [];
  let failed = 0;
  for (const f of files) { try { payloads.push(decryptBackup(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), pem)); } catch { failed++; } }
  const r = extractFromPayloads(payloads);
  payloads.length = 0;
  fs.writeFileSync(out, JSON.stringify(r), { mode: 0o600 });
  console.log(JSON.stringify({ backups: files.length, decrypt_failed: failed, generations_with_discovered: r.generations, leads_seen: r.leads_seen,
    historical_unique_error_leads: r.records.length, index_meta_domains: Object.keys(r.index_meta).length, skipped: r.skipped }));
}
