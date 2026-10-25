# Richtet die getrennten Worktrees für Claude Code und Codex CLI ein (idempotent, ändert nichts Bestehendes).
#   powershell -File scripts/setup-dev-worktrees.ps1 [-Base <Branch/Commit>]
# Ergebnis: ..\Jarvis-claude (Branch dev/claude), ..\Jarvis-codex (Branch dev/codex), node_modules per Junction, Hook-Pfad .githooks.
param([string]$Base = "HEAD")
$ErrorActionPreference = "Stop"
$root = (git -C $PSScriptRoot rev-parse --show-toplevel).Trim() -replace '/', '\'
$parent = Split-Path $root -Parent
git -C $root config core.hooksPath .githooks
foreach ($t in @(@{n="Jarvis-claude"; b="dev/claude"}, @{n="Jarvis-codex"; b="dev/codex"})) {
  $dir = Join-Path $parent $t.n
  if (-not (Test-Path $dir)) {
    if (git -C $root branch --list $t.b) { git -C $root worktree add $dir $t.b } else { git -C $root worktree add -b $t.b $dir $Base }
  }
  foreach ($rel in @("node_modules", "calling\node_modules")) {
    $src = Join-Path $root $rel; $dst = Join-Path $dir $rel
    if ((Test-Path $src) -and -not (Test-Path $dst)) { New-Item -ItemType Junction -Path $dst -Target $src | Out-Null }
  }
  Write-Host "OK $($t.n) -> $($t.b)"
}
