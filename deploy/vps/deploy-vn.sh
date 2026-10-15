#!/usr/bin/env bash
# Deploy NUR der Vietnam-Discovery (TF-063) auf den VPS – Mail-Worker, Repair-Worker, CRM-Dienst und Kontaktdienst werden nicht gestoppt,
# restarted, recreated oder neu gebaut (vorher/nachher geprüft). Gibt nie Secrets und nie Lead-/Kontaktdaten aus.
#   deploy/vps/deploy-vn.sh <ssh-host> build|start|status|report
set -euo pipefail
HOST="${1:?ssh-host fehlt}"; STEP="${2:?build|start|status|report}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
SSH=ssh; SCP=scp
if [ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ]; then SSH=/c/WINDOWS/System32/OpenSSH/ssh.exe; SCP=/c/WINDOWS/System32/OpenSSH/scp.exe; fi
COMMIT="$(git rev-parse --short HEAD)"
if [ "$STEP" = build ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  git archive --format=tar.gz -o "$TMP/app.tgz" HEAD
  "$SCP" -q "$TMP/app.tgz" "$HOST:/tmp/jarvis-vn-app.tgz"
fi
"$SSH" "$HOST" "STEP=$STEP COMMIT=$COMMIT bash -s; rc=\$?; rm -f /tmp/jarvis-vn-app.tgz; exit \$rc" < deploy/vps/vn-remote.sh
