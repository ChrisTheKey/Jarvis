# Richtet den Jarvis Mail-Worker als Windows-Aufgabe ein (Start bei Anmeldung, unsichtbar, Neustart nach Fehler).
# Keine Secrets in den Argumenten: der Worker liest alles selbst aus .secrets\.
#   powershell -ExecutionPolicy Bypass -File install-mail-worker.ps1            einrichten und sofort starten
#   powershell -ExecutionPolicy Bypass -File install-mail-worker.ps1 -Uninstall entfernen
# Ohne Administratorrechte startet sich das Skript per UAC-Abfrage selbst erhöht neu (nur „Ja“ klicken).
# Hinweis: Ist der Rechner aus, im Ruhezustand oder offline, arbeitet der Worker nicht. Er holt beim nächsten Lauf nach.
param([switch]$Uninstall, [string]$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$ErrorActionPreference = "Stop"
$TaskName = "Jarvis Mail Worker"
$LegacyNames = @("Jarvis Mail-Worker") # frühere Namen: Aufgabe bzw. Autostart-Verknüpfung wird aufgeräumt
$Root = $PSScriptRoot
$Worker = Join-Path $Root "mail-worker.js"
$Startup = [Environment]::GetFolderPath("Startup")
$Log = Join-Path $Root ".secrets\mail_worker\install.log"

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
  # Erhöht neu starten; der angemeldete Benutzer wird mitgegeben, damit die Aufgabe für ihn (nicht für den Admin) läuft.
  $ArgList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-User", "`"$User`"")
  if ($Uninstall) { $ArgList += "-Uninstall" }
  $p = Start-Process powershell -Verb RunAs -ArgumentList $ArgList -Wait -PassThru
  if (Test-Path $Log) { Get-Content $Log -Tail 20 }
  exit $p.ExitCode
}

New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null
Start-Transcript -Path $Log -Append | Out-Null
try {
  # Nur Jarvis-Mail-Worker-Prozesse dieses Ordners beenden – andere node.exe bleiben unberührt.
  function Stop-OldWorker {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Worker) }
    # Zuerst die Aufpasser (--supervise), damit sie den Worker nicht sofort neu starten.
    foreach ($p in ($procs | Sort-Object { -not $_.CommandLine.Contains("--supervise") })) {
      Write-Host "Beende alten Mail-Worker PID $($p.ProcessId): $($p.CommandLine)"
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item (Join-Path $Root ".secrets\mail_worker\worker.lock") -ErrorAction SilentlyContinue
  }
  function Remove-Autostart([string]$Name) {
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Startup "$Name.lnk") -ErrorAction SilentlyContinue
  }

  if ($Uninstall) {
    foreach ($n in @($TaskName) + $LegacyNames) { Remove-Autostart $n }
    Stop-OldWorker
    Write-Host "Autostart '$TaskName' entfernt und Worker beendet."
    exit 0
  }

  $Node = (Get-Command node -ErrorAction Stop).Source
  # conhost --headless startet node ohne sichtbares Fenster; --supervise startet den Worker nach Abstürzen neu.
  $Action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
    -Argument "--headless `"$Node`" `"$Worker`" --supervise" -WorkingDirectory $Root
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal `
    -Description "Jarvis: bereitet Mail-Entwürfe in eigenen Threads vor. Sendet nie selbst." -Force | Out-Null
  foreach ($n in $LegacyNames) { Remove-Autostart $n }
  Remove-Item (Join-Path $Startup "$TaskName.lnk") -ErrorAction SilentlyContinue

  # Prüfen, ob die Aufgabe wirklich existiert und auf diesen Jarvis-Ordner zeigt.
  $Check = (Get-ScheduledTask -TaskName $TaskName).Actions[0]
  if ($Check.WorkingDirectory -ne $Root -or -not $Check.Arguments.Contains($Worker)) { throw "Aufgabe zeigt nicht auf $Root" }

  # Alten Worker (evtl. älterer Code-Stand) ersetzen und über die Aufgabe neu starten.
  Stop-OldWorker
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "OK: Aufgabe '$TaskName' eingerichtet, geprüft und gestartet: $($Check.Execute) $($Check.Arguments) (in $($Check.WorkingDirectory))"
  Write-Host "Log: .secrets\mail_worker\worker.log"
} catch {
  Write-Host "FEHLER: $($_.Exception.Message)"
  exit 1
} finally {
  Stop-Transcript | Out-Null
}
