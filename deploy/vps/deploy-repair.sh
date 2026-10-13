#!/usr/bin/env bash
# Deploy NUR des Repair-Service (TF-047) auf den VPS – der 24/7-Mail-Worker (jarvis-mail-mail-worker-1) wird nicht gestoppt,
# restarted, recreated oder neu gebaut. Gibt nie Secrets aus.
#   deploy/vps/deploy-repair.sh <ssh-host>
# Ablauf (deploy/vps/repair-remote.sh): Mail-Worker-Baseline (read-only) → Ziel beweisen (eigenes Projekt jarvis-repair, genau ein
# Service, kein Mail-Mount, kein Docker-Socket; sonst DEPLOY BLOCKED) → nur repair-worker bauen + starten (--no-deps) →
# Mail-Worker vorher/nachher vergleichen (ID, StartedAt, RestartCount, Health, Scheduler, Queue, Authority) – Abweichung = FAIL.
# Für den Mail-Worker gilt weiterhin ausschliesslich deploy/vps/deploy.sh (geplante Wartung).
set -euo pipefail
HOST="${1:?ssh-host fehlt}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
SSH=ssh; SCP=scp
if [ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ]; then SSH=/c/WINDOWS/System32/OpenSSH/ssh.exe; SCP=/c/WINDOWS/System32/OpenSSH/scp.exe; fi
COMMIT="$(git rev-parse --short HEAD)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/app.tgz" HEAD
"$SCP" -q "$TMP/app.tgz" "$HOST:/tmp/jarvis-repair-app.tgz"
"$SSH" "$HOST" "COMMIT=$COMMIT APP_TGZ=/tmp/jarvis-repair-app.tgz bash -s; rc=\$?; rm -f /tmp/jarvis-repair-app.tgz; exit \$rc" < deploy/vps/repair-remote.sh
echo "Repair-Deploy $COMMIT abgeschlossen. Readiness: ssh $HOST 'sudo docker exec jarvis-repair-worker node production-readiness.js'"
