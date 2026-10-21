// TF-JARVIS-021 – Kurzzusammenfassung eines node:test-JUnit-Berichts für $GITHUB_STEP_SUMMARY (Markdown auf stdout).
// Zählt Testfälle, Fehler und Skips; listet fehlgeschlagene Tests namentlich. Fehlt der Bericht, wird das gemeldet (kein Absturz).
//   node scripts/ci-junit-summary.mjs reports/unit.xml
import fs from "node:fs";

const file = process.argv[2];
let xml;
try { xml = fs.readFileSync(file, "utf8"); } catch { console.log(`### ${file}\n\nKein Bericht vorhanden (Lauf abgebrochen?).\n`); process.exit(0); }
const cases = [...xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)];
const attr = (a, k) => (a.match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1] || "";
const failed = cases.filter((c) => /<failure\b/.test(c[3] || "")).map((c) => `${attr(c[1], "classname")} › ${attr(c[1], "name")}`);
const skipped = cases.filter((c) => /<skipped\b/.test(c[3] || "")).length;
console.log([`### ${file}`, "", `| Tests | Bestanden | Fehlgeschlagen | Übersprungen |`, `|---|---|---|---|`,
  `| ${cases.length} | ${cases.length - failed.length - skipped} | ${failed.length} | ${skipped} |`, "",
  ...failed.slice(0, 50).map((f) => `- ❌ ${f}`), ""].join("\n"));
