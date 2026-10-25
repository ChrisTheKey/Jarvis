// Entwicklungszentrale (Claude Code + Codex CLI): gemeinsame Regeln und Schutzdateien dürfen nicht verschwinden oder auseinanderlaufen.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("CLAUDE.md importiert AGENTS.md (eine gemeinsame Regelquelle)", () => {
  assert.match(read("CLAUDE.md"), /^@AGENTS\.md$/m);
});

test("AGENTS.md nennt Worktrees, Statusdatei und Freigabepflicht", () => {
  const a = read("AGENTS.md");
  for (const s of ["Jarvis-claude", "Jarvis-codex", "docs/STATUS.md", "Freigabe", ".secrets"]) assert.ok(a.includes(s), s);
});

test("Claude-Berechtigungen sperren Push, Deploy, SSH, Docker und Secrets", () => {
  const deny = JSON.parse(read(".claude/settings.json")).permissions.deny.join("\n");
  for (const s of ["git push", "ssh", "docker", "netlify", "deploy/vps", ".secrets", ".env"]) assert.ok(deny.includes(s), s);
});

test("Codex: Sandbox auf Worktree, kein Netzwerk, Produktions-Befehle verboten", () => {
  const c = read(".codex/config.toml");
  assert.match(c, /sandbox_mode\s*=\s*"workspace-write"/);
  assert.match(c, /network_access\s*=\s*false/);
  const r = read(".codex/rules/jarvis.rules");
  for (const s of ["git", "push", "ssh", "docker", "netlify", "deploy/vps/deploy.sh"]) assert.ok(r.includes(s), s);
});

test("pre-commit-Hook ruft dev-check auf", () => {
  assert.match(read(".githooks/pre-commit"), /dev-check\.mjs/);
});
