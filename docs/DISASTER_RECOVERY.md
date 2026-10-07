# Jarvis – Disaster Recovery (Cloud-First)

Jarvis läuft ohne PC: **VPS** (`/opt/jarvis-mail`, Container `jarvis-mail-mail-worker-1`) ist Cloud Core und Mail-Worker mit Send Authority,
**Netlify** (`https://chrisjarvis.netlify.app`) ist die Oberfläche und das authentifizierte Gateway, **GitHub** ist die Quelle des Codes.
Der Windows-PC ist ein optionaler Client (Claude Code, Mikrofon, Dateien). Er darf aus, offline oder ersetzt sein.

## Was liegt wo

| Ebene | Ort | Sicherung |
|---|---|---|
| Code | GitHub `ChrisTheKey/Jarvis`, Branch `claude/jarvis-voice-dashboard-9phl5w` | Git (Netlify deployt bei jedem Push) |
| Nicht-sensible Konfiguration | Repo (`netlify.toml`, `deploy/vps/*`, `persona.md`, `mail-writer.md`) | Git |
| Operational State | VPS `/opt/jarvis-mail/secrets/mail_worker/*.json`, `gmail_jarvis.json`, `shared_state.json` (Schema: `schema.json`) | täglich verschlüsselt: VPS `secrets/backups/` (14 Generationen) + Netlify Blobs `jarvis-backups` (30 Generationen) |
| Cloud-Zustand fürs UI | Netlify Blobs (`/api/state`, `/api/mail-requests`) | wird vom Cloud Core laufend neu geschrieben |
| Secrets | nur VPS (`/opt/jarvis-mail/.env`, `secrets/gmail_*.json`), Netlify-Umgebungsvariablen, PC `.secrets/` | **nie** in Git, nie in Backups – Wiederherstellung siehe unten |

Backups sind mit dem Public Key `deploy/vps/backup-public.pem` verschlüsselt (RSA-OAEP-256 + AES-256-GCM). Den passenden **Private Key**
hat nur Chris (Passwort-Manager, Datei `backup_private.pem`). Der VPS kann seine eigenen Backups nicht lesen.

## Secret-Recovery

Jedes Secret einzeln. Werte gehören in den Passwort-Manager, nie in Git, Chat, Screenshots oder PROJECT_STATE.md.

| Secret | Wo gebraucht | Wiederherstellen |
|---|---|---|
| `backup_private.pem` | nur für Restore | aus dem Passwort-Manager nach `.secrets/backup_private.pem` (600). **Verloren = Backups unlesbar** → neues Schlüsselpaar erzeugen, Public Key committen, VPS deployen. |
| SSH-Key `fiverr_hetzner_working_ed25519` + Passphrase | Admin/Deploy | aus dem Passwort-Manager nach `~/.ssh/`; `scripts\bootstrap-windows.ps1 -ConfigureSsh`; `Start-Service ssh-agent; ssh-add ~/.ssh/fiverr_hetzner_working_ed25519` |
| `JARVIS_PASSWORD` | Netlify (Browser-Login) | Netlify → Environment variables. Neu setzen und Production neu deployen. |
| `JARVIS_SYNC_TOKEN` | Netlify + PC `.secrets/jarvis_sync.json` | Wert aus dem Passwort-Manager in `jarvis_sync.json` (`{"token":"…"}`). Nur bei Verlust: `node scripts/setup-sync.mjs` erzeugt einen neuen, dann in Netlify ersetzen und neu deployen. |
| `JARVIS_MAIL_WORKER_TOKEN` | Netlify + VPS `.env` (+ PC `.secrets/vps_worker.env` für Admin) | Muss überall identisch sein. Rotation: neuen Wert in Netlify setzen, `.secrets/vps_worker.env` und VPS `.env` angleichen (Fingerprint-Vergleich, nie Werte ausgeben), `docker compose up -d --no-build --force-recreate mail-worker`, Netlify-Production neu deployen, `node scripts/check-mail-auth.mjs` → VPS 200 self=true. |
| `ANTHROPIC_API_KEY` | Netlify (Cloud-Chat) + VPS `.env` (Mail-Texte) | console.anthropic.com → neuen Key; in Netlify und VPS `.env` ersetzen. Nie im Browser. |
| Gmail OAuth (`gmail_credentials.json`, `gmail_token.json`) | VPS `secrets/` (Sender) | Credentials aus Google Cloud Console (OAuth-Client „Desktop“) laden; Token neu erteilen: auf dem PC `npm run gmail -- auth`, dann beide Dateien mit `scp` nach `/opt/jarvis-mail/secrets/` (Besitzer 1000, Rechte 600). Nie in Backups. |

## Restore des Operational State

1. Backups auflisten und prüfen (ohne Schlüssel):
   `node scripts/restore-state.mjs --list` · `node scripts/restore-state.mjs --verify --date 2026-10-07`
2. In ein **neues** Verzeichnis entschlüsseln (überschreibt nie etwas):
   `node scripts/restore-state.mjs --date 2026-10-07 --out restore-2026-10-07`
3. Auf den VPS übernehmen (nur wenn der VPS-Zustand verloren ist, sonst nichts tun):
   Worker stoppen (`cd /opt/jarvis-mail && sudo docker compose stop mail-worker`), Inhalt nach `/opt/jarvis-mail/secrets/` kopieren,
   `sudo chown -R 1000:1000 secrets && sudo find secrets -type f -exec chmod 600 {} +`, Gmail-Secrets nach Tabelle oben ablegen,
   `sudo docker compose up -d`. Der Worker prüft beim Start die Schema-Version (neuerer Stand als der Code → Start verweigert, fail closed).
4. `node scripts/check-mail-auth.mjs` → VPS 200 self=true, PC self=false. Genau ein Sender.

Teil-Rückspielung (z. B. nur Opt-outs) immer additiv mit `scripts/merge-state.mjs`-Regeln: nie bestehende Einträge überschreiben.

## Neuer VPS

1. Ubuntu + Docker, Benutzer mit sudo, SSH-Key hinterlegen. `/opt/fiverr` ist ein anderes Projekt und wird nie angefasst.
2. `bash deploy/vps/deploy.sh <host>` legt `/opt/jarvis-mail` an. `.env` vorher nach `/opt/jarvis-mail/.env` (root, 600).
3. State aus dem Backup (oben, Schritt 3) und Gmail-Secrets zurückspielen, starten, `check-mail-auth` prüfen.

## Neuer PC

```
git clone https://github.com/ChrisTheKey/Jarvis.git
cd Jarvis
git checkout claude/jarvis-voice-dashboard-9phl5w
powershell -ExecutionPolicy Bypass -File scripts\bootstrap-windows.ps1 -InstallLocalCore -ConfigureSsh
```
Das Skript prüft Voraussetzungen, legt Verzeichnisse an, testet die Cloud (nur lesend) und nennt fehlende Secrets. Es erzeugt keine
Tokens, liest keine Secrets aus Git und überschreibt keinen Cloud-State. Der Cloud-Jarvis läuft währenddessen weiter.

## Neustarts

- Container-Neustart/Absturz: `restart: unless-stopped`, Healthcheck alle 60 s, State im Bind-Mount → kommt mit vollem Stand zurück.
- VPS-Reboot: Docker startet beim Booten (`systemctl is-enabled docker` = enabled) und damit den Container. Einen echten Reboot
  zu einem ruhigen Zeitpunkt durchführen (auf demselben Host läuft auch `/opt/fiverr`), danach `check-mail-auth`.
