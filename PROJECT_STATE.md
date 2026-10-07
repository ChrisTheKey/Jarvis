# PROJECT_STATE – TF-JARVIS-ALWAYS-ONLINE-MAIL-021

Fortsetzbarer Rollout-Stand. Nur nicht-sensitive Fakten – niemals Tokens, Keys oder Credentials hier eintragen.

Letzte Aktualisierung: 2026-10-07

## Code
- Branch: `claude/jarvis-voice-dashboard-9phl5w`
- Implementierungs-Commit: `97d4b97` (179/179 Tests grün, gepusht)
- Netlify-Version mit Cloud-Mail-Queue: deployed
- AI-Credit-Fail-Closed (AI_BUDGET_EXHAUSTED): implementiert, 182/182 Tests grün – noch NICHT auf VPS/Netlify deployed

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
| 8–12 | Cloud/HUD, Offline-Szenario, Reply-Pipeline, Schedule, Security | offen (Mock-Tests grün; Live erst nach Schritt 5) |
| F4–F7 | Anthropic-Credit fail closed + HUD „AI SERVICE“ + Tests | Code ERLEDIGT; Deploy offen (VPS: `deploy/vps/deploy.sh fiverr` ohne Flag; Netlify: Production-Deploy) |

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
Schritt 5: Netlify `JARVIS_MAIL_WORKER_TOKEN` = Wert aus `.secrets/vps_worker.env` setzen, Production neu deployen (mit aktuellem Commit,
der auch die HUD-Anzeige AI SERVICE enthält). Danach VPS neu deployen (`bash deploy/vps/deploy.sh fiverr`), dann Schritt 6.

## AI-Credit-Fail-Closed (Kurzbeschreibung)
- Anthropic-Billing-Fehler (402, oder 400/403 mit Credit/Billing/Usage-Limit-Meldung) → `AiBudgetError` (AI_BUDGET_EXHAUSTED), genau ein Versuch.
- Sperre persistiert in `mail_worker/ai_budget.json`; offene KI-Aufträge dort als AI_BUDGET_EXHAUSTED vermerkt, nichts gesendet, kein Entwurf.
- Höchstens ein Prüfversuch je `aiRecheckMinutes` (Default 60, min. 15); bei Erfolg automatische Wiederaufnahme.
- Meldung an Chris (Typ `ai_budget_exhausted`), Heartbeat-Feld `ai_paused` → HUD „AI SERVICE: PAUSED — CREDIT LIMIT“.
- Kein Retry-Loop, kein zweiter Key, kein anderer Anbieter, kein Auto-Reload. Cloud-Aufträge (ohne KI), Heartbeat, Sync, Opt-out laufen weiter.

## Offene Blocker
- Stand 11:21 UTC: Netlify HAT `JARVIS_MAIL_WORKER_TOKEN` (Cloud meldet authority.dedicated=true), aber mit ANDEREM Wert als
  `.secrets/vps_worker.env` → VPS bekommt 401, bleibt Standby. Wahrscheinlich wurde ein alter Zwischenablage-Inhalt eingefügt
  (der PowerShell-Kopierbefehl war fehlgeschlagen).
- Folge bis zur Korrektur: Cloud-Mailaufträge (Handy) werden von niemandem übernommen (bleiben pending, gehen nicht verloren).
  Der laufende Windows-Worker-Prozess tickt weiter (alter Code ohne authority.json) – weiterhin genau ein Gmail-Sender.
- 11:43 UTC: nach erneutem Einfügen per clip.exe + neuem Deploy (neues ETag) weiterhin 401, dedicated=true → Wert in Production
  stimmt immer noch nicht mit der lokalen Datei überein (z. B. kontextspezifischer Override, Team-Variable, Anführungszeichen).
- Live-Netlify-Build enthält 138c460 noch nicht (HUD ohne „AI SERVICE“). VPS noch auf c4b9b2c (ohne AI-Fail-Closed).
- Fix: Token mit `grep '^JARVIS_MAIL_WORKER_TOKEN=' .secrets/vps_worker.env | cut -d= -f2- | tr -d '

' | clip.exe` kopieren,
  in Netlify ersetzen, Production neu deployen; dann `bash deploy/vps/deploy.sh fiverr` (ohne Flag), dann Schritt 6.
