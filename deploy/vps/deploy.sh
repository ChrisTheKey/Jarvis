#!/usr/bin/env bash
# Deploy des Always-on Mail-Workers auf den VPS. Gibt nie Secrets aus.
#   deploy/vps/deploy.sh <ssh-host> [--with-secrets]
# <ssh-host>: Host aus ~/.ssh/config mit sudo-Rechten (unter Windows Git Bash wird Windows-OpenSSH verwendet).
# --with-secrets: einmalige Migration – kopiert Gmail-Credentials/Token/Register und den Worker-Zustand aus .secrets/
#                 sowie .secrets/vps_worker.env (JARVIS_MAIL_WORKER_TOKEN, ANTHROPIC_API_KEY) auf den VPS (Rechte 600).
set -euo pipefail
HOST="${1:?ssh-host fehlt}"; WITH_SECRETS="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
SSH=ssh; SCP=scp
if [ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ]; then SSH=/c/WINDOWS/System32/OpenSSH/ssh.exe; SCP=/c/WINDOWS/System32/OpenSSH/scp.exe; fi
REMOTE=/opt/jarvis-mail
COMMIT="$(git rev-parse --short HEAD)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

git archive --format=tar.gz -o "$TMP/app.tgz" HEAD
"$SCP" -q "$TMP/app.tgz" "$HOST:/tmp/jarvis-mail-app.tgz"

if [ "$WITH_SECRETS" = "--with-secrets" ]; then
  [ -f .secrets/vps_worker.env ] || { echo "Fehlt: .secrets/vps_worker.env (siehe deploy/vps/env.example)"; exit 1; }
  # Nur, was der Mail-Worker braucht. Keine Ausgabe der Inhalte.
  tar -czf "$TMP/secrets.tgz" -C .secrets gmail_credentials.json gmail_token.json gmail_jarvis.json mail_worker
  "$SCP" -q "$TMP/secrets.tgz" "$HOST:/tmp/jarvis-mail-secrets.tgz"
  "$SCP" -q .secrets/vps_worker.env "$HOST:/tmp/jarvis-mail.env"
fi

"$SSH" "$HOST" "COMMIT=$COMMIT WITH_SECRETS=$WITH_SECRETS bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail
R=/opt/jarvis-mail
sudo mkdir -p "$R/app" "$R/secrets"
sudo rm -rf "$R/app.new" && sudo mkdir -p "$R/app.new"
sudo tar -xzf /tmp/jarvis-mail-app.tgz -C "$R/app.new" && rm -f /tmp/jarvis-mail-app.tgz
[ -d "$R/app" ] && sudo rm -rf "$R/app.old" && sudo mv "$R/app" "$R/app.old"
sudo mv "$R/app.new" "$R/app"
sudo cp "$R/app/deploy/vps/docker-compose.yml" "$R/docker-compose.yml"
echo "$COMMIT" | sudo tee "$R/DEPLOYED_COMMIT" >/dev/null
if [ "$WITH_SECRETS" = "--with-secrets" ]; then
  # Bestehenden Zustand nie überschreiben, wenn der VPS schon läuft (er ist dann die führende Quelle).
  if [ -f "$R/secrets/gmail_jarvis.json" ]; then echo "Secrets auf dem VPS existieren bereits – nicht überschrieben."; rm -f /tmp/jarvis-mail-secrets.tgz /tmp/jarvis-mail.env
  else sudo tar -xzf /tmp/jarvis-mail-secrets.tgz -C "$R/secrets" && rm -f /tmp/jarvis-mail-secrets.tgz
       sudo mv /tmp/jarvis-mail.env "$R/.env"; fi
fi
[ -f "$R/.env" ] || { echo "Fehlt: $R/.env (JARVIS_MAIL_WORKER_TOKEN, ANTHROPIC_API_KEY)"; exit 1; }
# Container läuft als node (uid 1000). Secrets nur für ihn lesbar.
sudo chown root:root "$R/.env" && sudo chmod 600 "$R/.env"
sudo chown -R 1000:1000 "$R/secrets" && sudo chmod 700 "$R/secrets"
sudo find "$R/secrets" -type d -exec chmod 700 {} + && sudo find "$R/secrets" -type f -exec chmod 600 {} +
cd "$R" && sudo JARVIS_COMMIT="$COMMIT" JARVIS_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" docker compose up -d --build
sleep 5
sudo docker compose ps --format 'table {{.Name}}\t{{.Status}}'
sudo docker inspect -f 'restart={{.HostConfig.RestartPolicy.Name}}' jarvis-mail-mail-worker-1
REMOTE_SCRIPT
echo "Deploy $COMMIT abgeschlossen. Gesundheit: ssh $HOST 'sudo docker inspect -f {{.State.Health.Status}} jarvis-mail-mail-worker-1'"
