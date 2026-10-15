#!/usr/bin/env bash
# Vietnam-Discovery-Deploy, Server-Teil (TF-063). Wird von deploy/vps/deploy-vn.sh per SSH (bash -s) ausgeführt. Gibt nie Secrets aus.
# Ändert AUSSCHLIESSLICH das Compose-Projekt «jarvis-vn» (Service vn-discovery). Nie: docker compose in jarvis-mail/-repair/-crm/-contacts.
# Mail-Worker, Repair-Worker, CRM-Dienst und Kontaktdienst werden vorher/nachher verglichen (Id, StartedAt, RestartCount, Running).
#
#   STEP=build    neuen Stand entpacken, Ziel prüfen, Image bauen, VN-Agent-Schlüssel ableiten (.env 600) – Dienst bleibt wie er ist
#   STEP=start    Dienst starten/aktualisieren (nur vn-discovery, --no-deps)
#   STEP=status   Container-Zustand (ohne Daten)
#   STEP=report   Kennzahlen aus dem laufenden Dienst (keine personenbezogenen Daten)
set -euo pipefail
: "${STEP:?STEP fehlt}"
: "${COMMIT:=unknown}"
APP_TGZ="${APP_TGZ:-/tmp/jarvis-vn-app.tgz}"
R=/opt/jarvis-vn
MAIL_ROOT=/opt/jarvis-mail
PROJECT=jarvis-vn
SERVICE=vn-discovery
CONTAINER=jarvis-vn-discovery
OTHERS=(jarvis-mail-mail-worker-1 jarvis-repair-worker jarvis-crm-worker jarvis-contacts-worker)
D() { sudo -n docker "$@"; }
blocked() { echo "DEPLOY BLOCKED: $*"; exit 3; }
probe() { D inspect -f '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Running}}' "$1" 2>/dev/null || echo none; }
C=(compose -p "$PROJECT" -f "$R/docker-compose.yml" --project-directory "$R")

declare -A BEFORE
for c in "${OTHERS[@]}"; do BEFORE[$c]="$(probe "$c")"; done
[ "${BEFORE[jarvis-mail-mail-worker-1]}" != none ] || blocked "Mail-Worker nicht gefunden – nichts verändert."

case "$STEP" in
  build)
    sudo -n mkdir -p "$R" "$R/data"
    sudo -n chown 1000:1000 "$R/data" && sudo -n chmod 700 "$R/data"
    sudo -n rm -rf "$R/app.new" && sudo -n mkdir -p "$R/app.new" && sudo -n tar -xzf "$APP_TGZ" -C "$R/app.new"
    NEW="$R/docker-compose.yml.new"; sudo -n cp "$R/app.new/deploy/vps/vn/docker-compose.yml" "$NEW"
    [ -f "$R/.env" ] || sudo -n install -m 600 /dev/null "$R/.env"
    SERVICES="$(cd "$R" && D compose -p "$PROJECT" -f "$NEW" --project-directory "$R" config --services)"
    [ "$SERVICES" = "$SERVICE" ] || blocked "Compose definiert nicht genau den Service $SERVICE ($SERVICES)."
    CFG="$(cd "$R" && D compose -p "$PROJECT" -f "$NEW" --project-directory "$R" config --format json)"
    printf '%s' "$CFG" | grep -q docker.sock && blocked "Compose mountet den Docker-Socket."
    printf '%s' "$CFG" | grep -qE '"image": *"jarvis-(mail|contacts|crm|repair)' && blocked "Compose nutzt ein fremdes Image."
    printf '%s' "$CFG" | grep -qE '/opt/jarvis-(mail|crm|repair|contacts)' && blocked "Compose mountet Daten eines anderen Dienstes."
    echo "TARGET OK: Projekt $PROJECT · Service $SERVICE · nur /opt/jarvis-vn/data · kein Docker-Socket · keine fremden Daten"
    if [ -d "$R/app" ]; then sudo -n rm -rf "$R/app.old" && sudo -n mv "$R/app" "$R/app.old"; fi
    sudo -n mv "$R/app.new" "$R/app" && sudo -n mv "$NEW" "$R/docker-compose.yml"
    echo "$COMMIT" | sudo -n tee "$R/DEPLOYED_COMMIT" >/dev/null
    (cd "$R" && sudo -n env JARVIS_COMMIT="$COMMIT" docker "${C[@]}" build "$SERVICE" 2>&1 | tail -3)
    # VN-Agent-Schlüssel: HMAC aus dem Server-Control-Token, im VN-Image ohne Netz berechnet (stdin → stdout), nie ausgegeben.
    TMPENV="$(sudo -n mktemp "$R/.env.new.XXXXXX")"
    if ! sudo -n cat "$MAIL_ROOT/.env" | D run --rm -i --network none --read-only --cap-drop ALL jarvis-vn-discovery:latest node deploy/vps/vn-derive-token.mjs \
        | sudo -n tee "$TMPENV" >/dev/null; then
      sudo -n rm -f "$TMPENV"; blocked "VN-Agent-Schlüssel nicht ableitbar (JARVIS_SERVER_CONTROL_TOKEN fehlt?)."
    fi
    sudo -n chmod 600 "$TMPENV" && sudo -n mv "$TMPENV" "$R/.env"
    echo "VN-AGENT-SCHLÜSSEL: $(sudo -n grep -c '^JARVIS_VN_AGENT_TOKEN=[0-9a-f]\{64\}$' "$R/.env") Eintrag abgeleitet (Wert nicht ausgegeben) · .env $(sudo -n stat -c %a "$R/.env")"
    ;;
  start)
    (cd "$R" && sudo -n env JARVIS_COMMIT="$COMMIT" docker "${C[@]}" up -d --no-deps --no-build "$SERVICE")
    H=starting
    for _ in $(seq 1 180); do H="$(D inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"; [ "$H" = healthy ] && break; [ "$H" = unhealthy ] && break; sleep 1; done
    echo "VN-Dienst: $CONTAINER health=$H"
    ;;
  status)
    D inspect -f '{{.Name}} {{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$CONTAINER"
    echo "DEPLOYED_COMMIT $(cat "$R/DEPLOYED_COMMIT" 2>/dev/null)"
    D logs --tail 30 "$CONTAINER" 2>&1 | grep -oE '"event":"[a-z_]+"(,"[a-z_]+":("[^"]{0,40}"|[0-9a-z.]+))*' | tail -20 || true
    ;;
  report) D exec "$CONTAINER" node vn-discovery.js --report ;;
  *) blocked "Unbekannter STEP $STEP" ;;
esac

FAIL=0
for c in "${OTHERS[@]}"; do
  AFTER="$(probe "$c")"
  if [ "${BEFORE[$c]}" = "$AFTER" ]; then echo "UNTOUCHED $c=YES"; else echo "UNTOUCHED $c=NO"; FAIL=1; fi
done
exit $FAIL
