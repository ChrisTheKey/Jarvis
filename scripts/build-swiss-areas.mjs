// Erzeugt data/swiss-municipalities.json (versioniert im Repository) aus dem offiziellen BFS-Gemeindeverzeichnis.
// Wird NICHT im Discovery-Lauf ausgeführt – die Discovery liest nur die statische Datei. Neu erzeugen nur bei Gemeindefusionen:
//
//   1) CSV holen (Stichtag TT-MM-JJJJ):  https://www.agvchapp.bfs.admin.ch/api/communes/snapshot?date=01-10-2026
//   2) node scripts/build-swiss-areas.mjs <snapshot.csv> 2026-10-01
//
// Sprache = Hauptsprache der Sprachregion (Kanton, in BE/FR/VS/GR nach Bezirk bzw. einzelnen Gemeinden). Eine Näherung für die
// Lead-Ansicht – sie steuert keinen Versand und keine Rechtsgrundlage.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [csvFile, stichtag] = process.argv.slice(2);
if (!csvFile || !/^\d{4}-\d{2}-\d{2}$/.test(stichtag || "")) { console.error("Aufruf: node scripts/build-swiss-areas.mjs <snapshot.csv> <JJJJ-MM-TT>"); process.exit(1); }

const parse = (line) => { const out = []; let cur = "", q = false; for (const ch of line) { if (ch === '"') { q = !q; continue; } if (ch === "," && !q) { out.push(cur); cur = ""; continue; } cur += ch; } out.push(cur); return out; };
const rows = fs.readFileSync(csvFile, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).slice(1).map(parse);
// Spalten: HistoricalCode,BfsCode,ValidFrom,ValidTo,Level,Parent,Name,ShortName,…  Level 1 = Kanton, 2 = Bezirk, 3 = Gemeinde
const byHist = new Map(rows.map((r) => [r[0], r]));
const cantonOf = (r) => { let x = r; while (x && x[4] !== "1") x = byHist.get(x[5]); return x; };

const FR = new Set(["VD", "NE", "GE", "JU"]), IT = new Set(["TI"]);
const DISTRICT_LANG = {
  "BE:Jura bernois": "fr",
  "FR:La Veveyse": "fr", "FR:La Sarine": "fr", "FR:La Gruyère": "fr", "FR:La Glâne": "fr", "FR:La Broye": "fr", "FR:Sense": "de", "FR:See / Lac": "de",
  "VS:Goms": "de", "VS:Brig": "de", "VS:Visp": "de", "VS:Raron": "de", "VS:Leuk": "de",
  "GR:Moesa": "it", "GR:Bernina": "it", "GR:Surselva": "rm", "GR:Engiadina B./Val Müstair": "rm",
};
const MUNI_LANG = { "Bregaglia": "it", "Biel/Bienne": "de", "Evilard": "de", "Fribourg": "fr", "Murten": "de", "Sierre": "fr", "Salgesch": "de" };
const langOf = (canton, district, name) => MUNI_LANG[name] || DISTRICT_LANG[`${canton}:${district}`]
  || (FR.has(canton) ? "fr" : IT.has(canton) ? "it" : ["FR", "VS"].includes(canton) ? "fr" : "de");

const cantons = rows.filter((r) => r[4] === "1" && !r[3]).map((r) => ({ code: r[7], name: r[6] }));
const municipalities = rows.filter((r) => r[4] === "3" && !r[3]).map((r) => {
  const c = cantonOf(r), parent = byHist.get(r[5]);
  const district = parent && parent[4] === "2" ? parent[7] : null;
  return [Number(r[1]), r[6], c[7], district, langOf(c[7], district, r[6])];
}).sort((a, b) => a[0] - b[0]);
if (cantons.length !== 26) throw new Error(`Erwartet 26 Kantone, gefunden ${cantons.length}`);
if (municipalities.length < 2000) throw new Error(`Zu wenige Gemeinden: ${municipalities.length}`);
for (const c of cantons) c.language = langOf(c.code, null, "");

const out = {
  version: `bfs-${stichtag}`,
  source: `BFS Amtliches Gemeindeverzeichnis der Schweiz (agvchapp.bfs.admin.ch), Stichtag ${stichtag}`,
  fields: ["bfs", "name", "canton", "district", "language"],
  cantons,
  municipalities,
};
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "swiss-municipalities.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
// Eine Gemeinde je Zeile: kleine, gut lesbare Diffs bei Fusionen.
fs.writeFileSync(target, JSON.stringify({ ...out, municipalities: "__M__" }, null, 1).replace('"__M__"', "[\n" + municipalities.map((m) => "  " + JSON.stringify(m)).join(",\n") + "\n ]") + "\n");
console.log(`OK: ${cantons.length} Kantone, ${municipalities.length} Gemeinden → ${path.relative(process.cwd(), target)}`);
