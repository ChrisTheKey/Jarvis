import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMPORT_RE = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const resolveLocal = (from, spec) => {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) if (fs.existsSync(candidate)) return candidate;
  return null;
};
function graph(entry) {
  const seen = new Set(), queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_RE)) {
      const next = resolveLocal(file, match[1] || match[2]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

test("Netlify cloud edge graph excludes Node-only repair and document modules", () => {
  const files = graph(path.join(ROOT, "netlify", "edge-functions", "cloud.js"));
  for (const forbidden of ["mail-worker.js", "access-intake.js", "completion-artifacts.js", "repair-workflow.js", "repair-render-test.js", "repair-browser-validator.js"]) {
    assert.equal(files.has(path.join(ROOT, forbidden)), false, `Edge-Graph darf ${forbidden} nicht enthalten`);
  }
  const source = [...files].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const forbidden of ["playwright", "pdfkit", "ssh2", "cpu-features"]) assert.doesNotMatch(source, new RegExp(`(?:from|import\\()\\s*[\\"']${forbidden}`), `Edge-Graph darf ${forbidden} nicht importieren`);
});
