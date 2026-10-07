# Neuer (oder neu aufgesetzter) Windows-PC als OPTIONALER Jarvis-Client – Cloud-First.
# Der Cloud-Jarvis (VPS + Netlify) läuft unabhängig davon weiter; dieses Skript verbindet den PC nur wieder als Client/Developer.
#
#   git clone https://github.com/ChrisTheKey/Jarvis.git; cd Jarvis
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap-windows.ps1                 nur prüfen + Verzeichnisse
#   powershell -ExecutionPolicy Bypass -File scripts\bootstrap-windows.ps1 -InstallLocalCore  zusätzlich Task "Jarvis Local Core"
#   ... -ConfigureSsh    SSH-Host "fiverr" in ~/.ssh/config eintragen (Key kommt aus dem Passwort-Manager, nie aus Git)
#   ... -InstallMailWorkerStandby   Windows-Mail-Worker als Reserve (bleibt STANDBY, solange der VPS die Authority hat)
#
# Garantien: liest/zieht NIE Secrets aus Git, erzeugt KEINE neuen Tokens, überschreibt KEINEN Cloud-State, sendet keine Mail,
# ändert keine Authority, deployt nichts. Fehlende Secrets werden nur benannt (Wiederherstellung: docs\DISASTER_RECOVERY.md).
param([switch]$InstallLocalCore, [switch]$InstallMailWorkerStandby, [switch]$ConfigureSsh, [string]$Cloud = "https://chrisjarvis.netlify.app")
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$ok = New-Object System.Collections.Generic.List[string]; $todo = New-Object System.Collections.Generic.List[string]
function Ok($m) { $ok.Add($m); Write-Host "  OK    $m" -ForegroundColor Green }
function Todo($m) { $todo.Add($m); Write-Host "  TODO  $m" -ForegroundColor Yellow }

Write-Host "`n[1] Voraussetzungen"
if (Get-Command git -ErrorAction SilentlyContinue) { Ok "git $((git --version) -replace 'git version ','')" } else { Todo "git fehlt: winget install Git.Git" }
if (-not (Test-Path (Join-Path $Root "mail-worker.js"))) { throw "Bitte im geklonten Jarvis-Repository ausführen." }
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $v = (node -v).TrimStart("v"); $major = [int]($v.Split(".")[0])
  if ($major -ge 22) { Ok "Node $v" } else { Todo "Node $v ist zu alt (>= 22 nötig): winget install OpenJS.NodeJS.LTS" }
} else { Todo "Node fehlt: winget install OpenJS.NodeJS.LTS (danach Terminal neu öffnen)" }
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "Claude Code vorhanden (lokale PC-Befehle)" } else { Todo "optional: Claude Code für PC-Befehle – npm install -g @anthropic-ai/claude-code, danach einmal 'claude' anmelden" }

Write-Host "`n[2] Repository und Verzeichnisse"
$branch = (git rev-parse --abbrev-ref HEAD) 2>$null
Ok "Branch $branch @ $((git rev-parse --short HEAD) 2>$null)"
foreach ($d in @(".secrets", ".secrets\local_core", ".secrets\mail_worker")) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
Ok ".secrets\ angelegt (gitignored)"
if ((git check-ignore -q .secrets/x; $LASTEXITCODE) -ne 0) { throw ".secrets ist nicht gitignored – Abbruch." }
if ($node -and -not (Test-Path "node_modules\@netlify\blobs")) { npm install --no-audit --no-fund --silent | Out-Null; Ok "npm install" } elseif ($node) { Ok "node_modules vorhanden" }

Write-Host "`n[3] Secrets (nur Vorhandensein – Inhalte werden nie gelesen oder angezeigt)"
$secrets = [ordered]@{
  ".secrets\jarvis_sync.json"      = "Abgleich PC <-> Cloud (JARVIS_SYNC_TOKEN; Wert aus dem Passwort-Manager, NICHT neu erzeugen)";
  ".env"                           = "optional: ElevenLabs-Stimme, Modell, Port";
  ".secrets\backup_private.pem"    = "nur für Restore: Backup-Private-Key aus dem Passwort-Manager";
  ".secrets\vps_worker.env"        = "nur Admin/Deploy: JARVIS_MAIL_WORKER_TOKEN + ANTHROPIC_API_KEY (identisch mit VPS /opt/jarvis-mail/.env)";
  ".secrets\gmail_credentials.json" = "nur für -InstallMailWorkerStandby (Reserve-Worker)";
  ".secrets\gmail_token.json"      = "nur für -InstallMailWorkerStandby (per 'npm run gmail -- auth' neu erteilen)";
}
foreach ($k in $secrets.Keys) { if (Test-Path $k) { Ok "$k vorhanden" } else { Todo "$k fehlt – $($secrets[$k])" } }

Write-Host "`n[4] Verbindung zum bestehenden Cloud-Jarvis (nur lesend)"
try { $p = Invoke-RestMethod -TimeoutSec 20 "$Cloud/api/state?probe=1"; if ($p.configured) { Ok "Cloud erreichbar ($Cloud), Sync konfiguriert" } else { Todo "Cloud erreichbar, aber JARVIS_SYNC_TOKEN in Netlify fehlt" } }
catch { Todo "Cloud nicht erreichbar: $($_.Exception.Message)" }
if ((Test-Path ".secrets\jarvis_sync.json") -and $node) {
  $auth = node scripts/check-mail-auth.mjs | ConvertFrom-Json
  if ($auth.windows_sync.status -eq 200) { Ok "PC-Credential HTTP 200 · Authority $($auth.windows_sync.authority.holder) · PC self=$($auth.windows_sync.authority.self)" } else { Todo "PC-Credential HTTP $($auth.windows_sync.status) – jarvis_sync.json prüfen" }
}

if ($ConfigureSsh) {
  Write-Host "`n[5] SSH (Admin)"
  $cfg = Join-Path $HOME ".ssh\config"
  if (-not (Test-Path (Split-Path $cfg))) { New-Item -ItemType Directory -Path (Split-Path $cfg) | Out-Null }
  if ((Test-Path $cfg) -and (Select-String -Path $cfg -Pattern '^\s*Host\s+fiverr\s*$' -Quiet)) { Ok "SSH-Host fiverr bereits eingetragen" }
  else { Add-Content -Path $cfg -Value "`nHost fiverr`n    HostName 188.245.0.10`n    User fiverradmin`n    IdentityFile ~/.ssh/fiverr_hetzner_working_ed25519`n    IdentitiesOnly yes`n"; Ok "SSH-Host fiverr eingetragen" }
  if (Test-Path (Join-Path $HOME ".ssh\fiverr_hetzner_working_ed25519")) { Ok "SSH-Key vorhanden" } else { Todo "SSH-Key ~/.ssh/fiverr_hetzner_working_ed25519 aus dem Passwort-Manager ablegen; dann: Start-Service ssh-agent; ssh-add" }
}

if ($InstallLocalCore) {
  Write-Host "`n[6] Local Core (optionaler Client)"
  & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "install-local-core.ps1")
  try { $h = Invoke-RestMethod -TimeoutSec 5 http://127.0.0.1:3000/api/health; Ok "Local Core $($h.role) online" } catch { Todo "Local Core antwortet nicht – .secrets\local_core\core.log prüfen" }
}
if ($InstallMailWorkerStandby) {
  Write-Host "`n[7] Reserve-Mail-Worker"
  if (-not ((Test-Path ".secrets\gmail_credentials.json") -and (Test-Path ".secrets\gmail_token.json"))) { Todo "Reserve-Worker übersprungen: Gmail-Credentials/Token fehlen" }
  else { & powershell -ExecutionPolicy Bypass -File (Join-Path $Root "install-mail-worker.ps1"); Ok "Reserve-Worker eingerichtet – bleibt STANDBY, solange der VPS die Authority hat" }
}

Write-Host "`nZusammenfassung: $($ok.Count) OK, $($todo.Count) offen. Der Cloud-Jarvis lief währenddessen unverändert weiter."
if ($todo.Count) { Write-Host "Offen:"; $todo | ForEach-Object { Write-Host " - $_" } }
