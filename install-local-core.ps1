# Richtet den Jarvis Local Core als Windows-Aufgabe "Jarvis Local Core" ein: Start bei Anmeldung, unsichtbar,
# Neustart nach Fehlern. Startet den bestehenden Server (server.js) über `node server.js --supervise` – nur 127.0.0.1.
# Wiederholbar: vorhandene Aufgabe wird ersetzt, alte Local-Core-Prozesse dieses Ordners beendet, dann neu gestartet.
# Andere Jarvis-Aufgaben werden nie angefasst. Keine Secrets in Argumenten oder im Log.
#   powershell -ExecutionPolicy Bypass -File install-local-core.ps1             einrichten, starten, prüfen
#   powershell -ExecutionPolicy Bypass -File install-local-core.ps1 -Uninstall  entfernen und beenden
# Normalerweise ohne Administratorrechte; nur wenn Windows das Anlegen verweigert, folgt eine UAC-Abfrage.
param([switch]$Uninstall, [switch]$Elevated, [string]$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$ErrorActionPreference = "Stop"
$TaskName = "Jarvis Local Core"
$Root = $PSScriptRoot
$Server = Join-Path $Root "server.js"
$CoreDir = Join-Path $Root ".secrets\local_core"
$Log = Join-Path $CoreDir "install.log"

# Port wie server.js: PORT aus .env, sonst 3000
$Port = 3000
$EnvFile = Join-Path $Root ".env"
if (Test-Path $EnvFile) {
  $m = Select-String -Path $EnvFile -Pattern '^\s*PORT\s*=\s*"?(\d+)"?\s*$' | Select-Object -First 1
  if ($m) { $Port = [int]$m.Matches[0].Groups[1].Value }
}
$Health = "http://localhost:$Port/api/health"

New-Item -ItemType Directory -Force $CoreDir | Out-Null
# Log begrenzen
if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Move-Item $Log "$Log.1" -Force }
Start-Transcript -Path $Log -Append | Out-Null

function Test-Core {
  try { $r = Invoke-RestMethod -Uri $Health -TimeoutSec 3; return ($r.service -eq "jarvis-local-core") } catch { return $false }
}
# Nur Local-Core-Prozesse dieses Ordners (server.js) – alle anderen node.exe bleiben unberührt.
function Stop-OldCore {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Server) })
  # Zuerst die Aufpasser (--supervise), damit sie den Server nicht sofort neu starten.
  foreach ($p in ($procs | Sort-Object { -not $_.CommandLine.Contains("--supervise") })) {
    Write-Host "Beende alten Local Core PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  # Falls die Befehlszeile nicht lesbar ist: den Jarvis auf dem Port beenden – aber nur, wenn er sich als Local Core meldet.
  if (Test-Core) {
    $owner = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($owner) {
      $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq "node") { Write-Host "Beende laufenden Jarvis auf Port $Port (PID $owner)"; Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue }
    }
  }
  Remove-Item (Join-Path $CoreDir "core.lock") -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20 -and (Test-Core); $i++) { Start-Sleep -Milliseconds 500 }
}

try {
  if ($Uninstall) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Stop-OldCore
    Write-Host "Autostart '$TaskName' entfernt und Local Core beendet."
    exit 0
  }

  $Node = (Get-Command node -ErrorAction Stop).Source
  # conhost --headless: kein Fenster. --supervise: startet server.js nach Abstürzen neu, verhindert Doppelstarts.
  $Action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
    -Argument "--headless `"$Node`" `"$Server`" --supervise" -WorkingDirectory $Root
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

  try {
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
      -Description "Jarvis Local Core: lokaler Jarvis-Server (nur localhost), startet bei Anmeldung und nach Fehlern neu." -Force | Out-Null
  } catch {
    if ($Elevated) { throw }
    # Nur falls Windows das Anlegen ohne Adminrechte verweigert: einmalig per UAC erhöht wiederholen.
    Write-Host "Anlegen ohne Adminrechte verweigert ($($_.Exception.Message)) – frage per UAC nach."
    Stop-Transcript | Out-Null
    $ArgList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Elevated", "-User", "`"$User`"")
    $p = Start-Process powershell -Verb RunAs -ArgumentList $ArgList -Wait -PassThru
    exit $p.ExitCode
  }

  # Prüfen: Aufgabe existiert, ist aktiviert und zeigt auf diesen Jarvis-Ordner.
  $Task = Get-ScheduledTask -TaskName $TaskName
  $Check = $Task.Actions[0]
  if ($Check.WorkingDirectory -ne $Root -or -not $Check.Arguments.Contains($Server) -or -not $Check.Arguments.Contains("--supervise")) { throw "Aufgabe zeigt nicht auf $Server" }
  if ($Task.Settings.Enabled -ne $true) { Enable-ScheduledTask -TaskName $TaskName | Out-Null }

  # Alten Kern (älterer Code-Stand oder manuell gestartet) ersetzen und über die Aufgabe neu starten.
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Stop-OldCore
  Start-ScheduledTask -TaskName $TaskName
  $ok = $false
  for ($i = 0; $i -lt 60 -and -not $ok; $i++) { Start-Sleep -Milliseconds 500; $ok = Test-Core }
  if (-not $ok) { throw "Local Core antwortet nicht auf $Health – siehe .secrets\local_core\core.log" }

  # Nur 127.0.0.1 – nie öffentlich gebunden.
  $listen = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalAddress -Unique)
  if ($listen | Where-Object { $_ -ne "127.0.0.1" }) { throw "Port $Port ist nicht nur lokal gebunden: $($listen -join ', ')" }

  Write-Host "OK: Aufgabe '$TaskName' eingerichtet ($((Get-ScheduledTask -TaskName $TaskName).State)), Local Core antwortet auf $Health, gebunden an $($listen -join ', ')."
  Write-Host "Log: .secrets\local_core\core.log"
} catch {
  Write-Host "FEHLER: $($_.Exception.Message)"
  exit 1
} finally {
  try { Stop-Transcript | Out-Null } catch {}
}
