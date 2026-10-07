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
| 2 | VPS-Deploy nach `/opt/jarvis-mail` inkl. einmaliger Secret-Migration | ERLEDIGT (vom Benutzer ausgeführt, deployed Commit c4b9b2c) |
| 3 | Docker Compose: Container RUNNING, unless-stopped, HEALTHY | ERLEDIGT |
| 4 | VPS-Worker verifizieren (2-min-Polling, Heartbeat, kein Crash-Loop) | ERLEDIGT – Standby (Cloud antwortet 401, erwartet) |
| 5 | Netlify `JARVIS_MAIL_WORKER_TOKEN` setzen + Production-Redeploy | WARTET AUF BENUTZER (manuell im Netlify-UI) |
| 6 | Send Authority VPS, Windows Standby | offen |
| 7 | Windows-Task „Jarvis Mail Worker“ neu starten, Standby prüfen | offen |
| 8–12 | Cloud/HUD, Offline-Szenario, Reply-Pipeline, Schedule, Security | offen |

## Live-Zustand
- VPS `ubuntu-4gb-fsn1-1` (SSH-Host `fiverr`, Windows-OpenSSH): erreichbar, sudo ok, Docker vorhanden
- `/opt/fiverr`: bestehendes Projekt – NICHT anfassen
- `/opt/jarvis-mail`: deployed. Container `jarvis-mail-mail-worker-1` running, healthy, restart=unless-stopped, 0 Restarts.
  Rechte: `.env` 600 root, `secrets/` 700, Secret-Dateien 600. Worker-Log: `secrets/mail_worker/worker.log` (nicht `docker logs`).
  Authority-Datei VPS: holder=local, self=false (Standby bis Netlify-Token gesetzt).
- Aktueller Gmail-Sender: Windows-Worker
- Netlify `JARVIS_MAIL_WORKER_TOKEN`: noch NICHT gesetzt (absichtlich, erst nach HEALTHY)

## Sicherheitslogik (wichtig beim Fortsetzen)
- VPS-Worker startet im Standby, solange Netlify seinen Token mit 401 ablehnt → kein Doppel-Sender vor Schritt 5.
- `deploy/vps/deploy.sh fiverr --with-secrets` überschreibt bestehende VPS-Secrets nie (VPS ist dann führend).
  Bei erneutem Deploy ohne Secret-Änderung: `deploy/vps/deploy.sh fiverr` (ohne Flag).

## Nächster Schritt
Schritt 5: Netlify `JARVIS_MAIL_WORKER_TOKEN` = Wert aus `.secrets/vps_worker.env` setzen, Production neu deployen.

## Offene Blocker
- Netlify CLI auf diesem PC nicht installiert/angemeldet/verknüpft → Schritt 5 muss Chris im Netlify-UI machen:
  Site chrisjarvis → Site configuration → Environment variables → `JARVIS_MAIL_WORKER_TOKEN` = Wert aus `.secrets/vps_worker.env`,
  danach Deploys → Trigger deploy → Deploy site. Erst danach Schritte 6–13 fortsetzen (Claude prüft dann Authority etc.).
