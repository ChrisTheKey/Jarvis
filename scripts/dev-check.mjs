// Gemeinsamer Entwicklungs-Check für Claude Code und Codex CLI (docs/DEVELOPMENT_CONTROL_CENTER.md).
//   node scripts/dev-check.mjs           schnell: Syntax aller geänderten/gestagten JS-Dateien + Secret-Scan + Schutzdateien
//   node scripts/dev-check.mjs --full    zusätzlich die komplette Unit-Suite (npm test)
//   node scripts/dev-check.mjs --hook    wie schnell, aber nur gestagte Dateien (pre-commit)
// Berührt weder Netzwerk noch Produktion. Exit 1 bei Fehler.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
let failed = false;
const step = (name, ok, detail = "") => { console.log(`${ok ? "OK  " : "FEHL"} ${name}${detail ? " – " + detail : ""}`); if (!ok) failed = true; };

const staged = git("diff", "--cached", "--name-only", "--diff-filter=ACMR");
const files = args.has("--hook") ? staged : [...new Set([...staged, ...git("diff", "--name-only", "--diff-filter=ACMR", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")])];
const js = files.filter((f) => /\.(m?js)$/.test(f) && fs.existsSync(path.join(ROOT, f)));
const bad = js.filter((f) => spawnSync(process.execPath, ["--check", f], { cwd: ROOT }).status !== 0);
step("Syntax", bad.length === 0, bad.length ? "Fehler in " + bad.join(", ") : `${js.length} Datei(en)`);

const forbidden = files.filter((f) => /(^|\/)(\.secrets|\.env$|data\/lead_|data\/crm_|exports\/)|token\.json$|_token\.json$/.test(f));
step("Keine Secret-/Kundendaten-Pfade geändert", forbidden.length === 0, forbidden.join(", "));

step("Secret-Scan", spawnSync(process.execPath, ["scripts/secret-scan.mjs"], { cwd: ROOT, stdio: "inherit" }).status === 0);

const control = ["AGENTS.md", "CLAUDE.md", "docs/DEVELOPMENT_CONTROL_CENTER.md", "docs/STATUS.md", ".claude/settings.json", ".codex/config.toml", ".codex/rules/jarvis.rules"];
const missing = control.filter((f) => !fs.existsSync(path.join(ROOT, f)));
step("Gemeinsame Regeldateien vorhanden", missing.length === 0, missing.join(", "));

if (args.has("--full")) step("Unit-Suite (npm test)", spawnSync(process.execPath, ["scripts/run-unit-tests.mjs"], { cwd: ROOT, stdio: "inherit" }).status === 0);
console.log(failed ? "\nCHECK FEHLGESCHLAGEN" : "\nCHECK OK");
process.exit(failed ? 1 : 0);
