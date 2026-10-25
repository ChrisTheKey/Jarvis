# Richtet die getrennten Worktrees für Claude Code und Codex CLI ein (idempotent, ändert nichts Bestehendes).
#   powershell -File scripts/setup-dev-worktrees.ps1 [-Base <Branch/Commit>]
# Ergebnis: ..\Jarvis-claude (Branch agent-claude/main), ..\Jarvis-codex (Branch agent-codex/main), eigenes node_modules (npm ci), Hook-Pfad .githooks.
param([string]$Base = "HEAD")
$ErrorActionPreference = "Stop"
$root = (git -C $PSScriptRoot rev-parse --show-toplevel).Trim() -replace '/', '\'
$parent = Split-Path $root -Parent
git -C $root config core.hooksPath .githooks
foreach ($t in @(@{n="Jarvis-claude"; b="agent-claude/main"}, @{n="Jarvis-codex"; b="agent-codex/main"})) {
  $dir = Join-Path $parent $t.n
  if (-not (Test-Path $dir)) {
    if (git -C $root branch --list $t.b) { git -C $root worktree add $dir $t.b } else { git -C $root worktree add -b $t.b $dir $Base }
  }
  foreach ($rel in @(".", "calling")) {
    $d = Join-Path $dir $rel
    if ((Test-Path (Join-Path $d "package-lock.json")) -and -not (Test-Path (Join-Path $d "node_modules"))) { npm ci --ignore-scripts --no-audit --no-fund --prefix $d }
  }
  Write-Host "OK $($t.n) -> $($t.b)"
}
