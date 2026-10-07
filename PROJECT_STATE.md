# PROJECT_STATE – TF-JARVIS-ALWAYS-ONLINE-MAIL-021

Fortsetzbarer Rollout-Stand. Nur nicht-sensitive Fakten – niemals Tokens, Keys oder Credentials hier eintragen.

Letzte Aktualisierung: 2026-10-07

## Code
- Branch: `claude/jarvis-voice-dashboard-9phl5w`
- Implementierungs-Commit: `97d4b97` (179/179 Tests grün, gepusht)
- Netlify-Version mit Cloud-Mail-Queue: deployed

## Rollout-Schritte
| # | Schritt | Status |
|---|---------|--------|
| 1 | Zustand prüfen (Git, `.secrets/vps_worker.env` mit beiden Werten, SSH `fiverr`) | ERLEDIGT |
| 2 | VPS-Deploy nach `/opt/jarvis-mail` inkl. einmaliger Secret-Migration | offen |
| 3 | Docker Compose: Container RUNNING, unless-stopped, HEALTHY | offen |
| 4 | VPS-Worker verifizieren (2-min-Polling, Heartbeat, kein Crash-Loop) | offen |
| 5 | Netlify `JARVIS_MAIL_WORKER_TOKEN` setzen + Production-Redeploy | offen – erst nach HEALTHY |
| 6 | Send Authority VPS, Windows Standby | offen |
| 7 | Windows-Task „Jarvis Mail Worker“ neu starten, Standby prüfen | offen |
| 8–12 | Cloud/HUD, Offline-Szenario, Reply-Pipeline, Schedule, Security | offen |

## Live-Zustand
- VPS `ubuntu-4gb-fsn1-1` (SSH-Host `fiverr`, Windows-OpenSSH): erreichbar, sudo ok, Docker vorhanden
- `/opt/fiverr`: bestehendes Projekt – NICHT anfassen
- `/opt/jarvis-mail`: noch nicht vorhanden
- Aktueller Gmail-Sender: Windows-Worker
- Netlify `JARVIS_MAIL_WORKER_TOKEN`: noch NICHT gesetzt (absichtlich, erst nach HEALTHY)

## Sicherheitslogik (wichtig beim Fortsetzen)
- VPS-Worker startet im Standby, solange Netlify seinen Token mit 401 ablehnt → kein Doppel-Sender vor Schritt 5.
- `deploy/vps/deploy.sh fiverr --with-secrets` überschreibt bestehende VPS-Secrets nie (VPS ist dann führend).
  Bei erneutem Deploy ohne Secret-Änderung: `deploy/vps/deploy.sh fiverr` (ohne Flag).

## Nächster Schritt
Schritt 2: `bash deploy/vps/deploy.sh fiverr --with-secrets` (im Repo-Ordner `Documents/Chris/Jarvis`, in Git Bash)

## Offene Blocker
- Schritt 2 noch nicht ausgeführt: Der Deploy-Befehl wurde in der Claude-Code-Session vom Auto-Mode-Berechtigungsfilter (Production Deploy) blockiert. Benutzer muss ihn selbst ausführen oder eine Bash-Erlaubnisregel dafür hinzufügen.
