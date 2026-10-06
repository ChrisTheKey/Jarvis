// Erzeugt aus persona.md (einzige Persona-Quelle) die Cloud-Fassung für die Netlify Edge Function.
// Blöcke zwischen <!-- nur-lokal --> und <!-- /nur-lokal --> gelten nur auf dem PC und entfallen in der Cloud.
//   node scripts/build-persona.mjs          schreibt netlify/shared/persona.generated.js
//   node scripts/build-persona.mjs --check  bricht ab, wenn die erzeugte Datei nicht mehr zu persona.md passt
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { personaVersion } from "../persona-version.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "persona.md");
const TARGET = path.join(ROOT, "netlify", "shared", "persona.generated.js");

export function cloudPersona(md) {
  return md.replace(/\r\n/g, "\n").replace(/<!-- nur-lokal -->[\s\S]*?<!-- \/nur-lokal -->/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function render(md = fs.readFileSync(SOURCE, "utf8")) {
  return `// AUTOMATISCH ERZEUGT aus persona.md – nicht von Hand ändern. Neu erzeugen: npm run build:persona\n` +
    `export const PERSONA_VERSION = ${JSON.stringify(personaVersion(md))};\n` +
    `export const PERSONA = ${JSON.stringify(cloudPersona(md))};\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = render();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== out) { console.error("persona.generated.js ist veraltet – npm run build:persona ausführen."); process.exit(1); }
    console.log("Persona aktuell.");
  } else {
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.writeFileSync(TARGET, out);
    console.log(`Cloud-Persona erzeugt (Version ${personaVersion(fs.readFileSync(SOURCE, "utf8"))}).`);
  }
}
