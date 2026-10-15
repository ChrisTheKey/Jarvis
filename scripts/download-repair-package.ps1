<#
  TF-059: Website-Paket eines abgeschlossenen CHF-480-Auftrags vom VPS auf diesen PC holen.

  Aufruf (im Jarvis-Ordner):
    .\scripts\download-repair-package.ps1 -OrderId RF480-20261015-a1b2c3

  - nutzt den bestehenden SSH-Alias "fiverr" (Windows OpenSSH), fragt keine Secrets ab
  - liest NUR /opt/jarvis-repair/artifacts/<ORDER_ID>/artifact.json und genau die darin genannte ZIP-Datei
    (website-netlify-ready.zip oder website-repaired-backup.zip) – keine anderen VPS-Dateien
  - Order-ID wird strikt geprüft (RF480-JJJJMMTT-xxxxxx), bevor irgendein Befehl entsteht
  - speichert nach .\exports\repair-packages\<ORDER_ID>\ (exports/ ist nicht im Git)
  - prüft SHA-256 gegen artifact.json; bei Abweichung wird die Datei gelöscht (Exit 1)
  - meldet danach exakt den lokalen Dateipfad
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OrderId,
  [string]$HostAlias = "fiverr"
)
$ErrorActionPreference = "Stop"

if ($OrderId -cnotmatch '^RF480-\d{8}-[0-9a-f]{6}$') { Write-Error "Ungültige Order-ID (erwartet RF480-JJJJMMTT-xxxxxx)."; exit 2 }
if ($HostAlias -cnotmatch '^[A-Za-z0-9._-]{1,64}$') { Write-Error "Ungültiger SSH-Alias."; exit 2 }

$ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
$scp = Join-Path $env:WINDIR "System32\OpenSSH\scp.exe"
foreach ($exe in @($ssh, $scp)) { if (-not (Test-Path $exe)) { Write-Error "Windows OpenSSH fehlt: $exe"; exit 2 } }

$remoteDir = "/opt/jarvis-repair/artifacts/$OrderId"
$root = Split-Path -Parent $PSScriptRoot
$localDir = Join-Path $root "exports\repair-packages\$OrderId"

# 1) artifact.json lesen (nur diese Datei, BatchMode: nie eine Passwortabfrage)
$json = & $ssh -o BatchMode=yes $HostAlias "cat $remoteDir/artifact.json"
if ($LASTEXITCODE -ne 0 -or -not $json) { Write-Error "Kein Website-Paket für $OrderId gefunden (artifact.json fehlt oder SSH nicht erreichbar)."; exit 1 }
try { $artifact = ($json -join "`n") | ConvertFrom-Json } catch { Write-Error "artifact.json ist ungültig."; exit 1 }

if ($artifact.order_id -cne $OrderId) { Write-Error "artifact.json gehört nicht zu $OrderId."; exit 1 }
$file = [string]$artifact.file
if ($file -cnotin @("website-netlify-ready.zip", "website-repaired-backup.zip")) { Write-Error "Unerwarteter Dateiname im Artifact."; exit 1 }
$expected = ([string]$artifact.sha256).ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') { Write-Error "SHA-256 im Artifact fehlt oder ist ungültig."; exit 1 }

# 2) genau diese ZIP-Datei holen
New-Item -ItemType Directory -Force -Path $localDir | Out-Null
$target = Join-Path $localDir $file
$partial = "$target.part"
Remove-Item -Force -ErrorAction SilentlyContinue $partial
& $scp -q -o BatchMode=yes "${HostAlias}:$remoteDir/$file" $partial
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $partial)) { Remove-Item -Force -ErrorAction SilentlyContinue $partial; Write-Error "Download fehlgeschlagen."; exit 1 }

# 3) SHA-256 prüfen – erst danach liegt die Datei unter ihrem endgültigen Namen
$actual = (Get-FileHash -Algorithm SHA256 -Path $partial).Hash.ToLowerInvariant()
if ($actual -ne $expected) { Remove-Item -Force $partial; Write-Error "SHA-256 stimmt NICHT (erwartet $expected, erhalten $actual) – Datei verworfen."; exit 1 }
Move-Item -Force $partial $target
($json -join "`n") | Set-Content -Encoding utf8 (Join-Path $localDir "artifact.json")

$kind = if ($artifact.netlify_ready -eq $true -and $artifact.type -ceq "NETLIFY_READY") { "NETLIFY READY (Netlify Drop: ZIP direkt hochladen)" } else { "BACKUP – NICHT DIREKT AUF NETLIFY DEPLOYBAR" }
Write-Output "Website-Paket: $kind"
Write-Output "SHA-256 geprüft: OK ($actual)"
Write-Output "Lokale Datei: $((Resolve-Path $target).Path)"
