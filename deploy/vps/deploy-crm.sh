#!/usr/bin/env bash
# Deploy NUR des Lead-CRM-Dienstes (TF-053) auf den VPS – Mail-Worker (jarvis-mail-mail-worker-1) und Kontaktdienst
# (jarvis-contacts-worker) werden nicht gestoppt, restarted, recreated oder neu gebaut (vorher/nachher geprüft).
# Gibt nie Secrets und nie Lead-/Kontaktdaten aus.
#   deploy/vps/deploy-crm.sh <ssh-host> build|start|status|report|backup-now
set -euo pipefail
HOST="${1:?ssh-host fehlt}"; STEP="${2:?build|start|status|report|backup-now}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
SSH=ssh; SCP=scp
if [ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ]; then SSH=/c/WINDOWS/System32/OpenSSH/ssh.exe; SCP=/c/WINDOWS/System32/OpenSSH/scp.exe; fi
COMMIT="$(git rev-parse --short HEAD)"
if [ "$STEP" = build ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  git archive --format=tar.gz -o "$TMP/app.tgz" HEAD
  "$SCP" -q "$TMP/app.tgz" "$HOST:/tmp/jarvis-crm-app.tgz"
fi
"$SSH" "$HOST" "STEP=$STEP COMMIT=$COMMIT bash -s; rc=\$?; rm -f /tmp/jarvis-crm-app.tgz; exit \$rc" < deploy/vps/crm-remote.sh
