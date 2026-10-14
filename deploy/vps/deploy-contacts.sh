#!/usr/bin/env bash
# Deploy NUR des Lead-Kontaktverzeichnisses (TF-051) auf den VPS – der 24/7-Mail-Worker (jarvis-mail-mail-worker-1) wird nicht
# gestoppt, restarted, recreated oder neu gebaut (vorher/nachher geprüft). Gibt nie Secrets und nie Kontaktdaten aus.
#   deploy/vps/deploy-contacts.sh <ssh-host> build|backfill|start|status
#   deploy/vps/deploy-contacts.sh <ssh-host> fetch [zielordner]   CSV + PDF per SCP holen (Standard: ./exports)
# Reihenfolge beim ersten Mal: build → backfill (docker logs -f jarvis-contacts-backfill) → start → fetch.
set -euo pipefail
HOST="${1:?ssh-host fehlt}"; STEP="${2:?build|backfill|start|status|fetch}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
SSH=ssh; SCP=scp
if [ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ]; then SSH=/c/WINDOWS/System32/OpenSSH/ssh.exe; SCP=/c/WINDOWS/System32/OpenSSH/scp.exe; fi
COMMIT="$(git rev-parse --short HEAD)"
if [ "$STEP" = fetch ]; then
  DEST="${3:-$ROOT/exports}"; mkdir -p "$DEST"
  # Dateien gehören uid 1000 (= SSH-Benutzer) – direkt per SCP, keine Kopie über /tmp.
  "$SCP" -q "$HOST:/opt/jarvis-mail/exports/Jarvis_Lead_Kontaktliste.pdf" "$HOST:/opt/jarvis-mail/exports/Jarvis_Lead_Kontaktliste.csv" "$DEST/"
  ls -l "$DEST"/Jarvis_Lead_Kontaktliste.*
  exit 0
fi
if [ "$STEP" = build ]; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  git archive --format=tar.gz -o "$TMP/app.tgz" HEAD
  "$SCP" -q "$TMP/app.tgz" "$HOST:/tmp/jarvis-contacts-app.tgz"
fi
"$SSH" "$HOST" "STEP=$STEP COMMIT=$COMMIT BACKFILL_ARGS='${BACKFILL_ARGS:-}' bash -s; rc=\$?; rm -f /tmp/jarvis-contacts-app.tgz; exit \$rc" < deploy/vps/contacts-remote.sh
