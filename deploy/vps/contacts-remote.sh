#!/usr/bin/env bash
# Kontaktverzeichnis-Deploy, Server-Teil (TF-051). Wird von deploy/vps/deploy-contacts.sh per SSH (bash -s) ausgeführt. Gibt nie Secrets aus.
# Ändert AUSSCHLIESSLICH das Compose-Projekt «jarvis-contacts» (Service contacts-worker) und legt /opt/jarvis-mail/data + /exports an.
# Nie: docker compose im Projekt jarvis-mail, ein Neustart/Recreate des Mail-Workers. Vorher/nachher wird der Mail-Worker verglichen.
#
#   STEP=build     neuen Stand entpacken, Ziel prüfen, Image bauen (Dienst bleibt wie er ist)
#   STEP=backfill  einmaliger Backfill-Container (detached, Name jarvis-contacts-backfill); Fortschritt: docker logs -f
#   STEP=start     Dienst starten/aktualisieren (nur contacts-worker, --no-deps)
#   STEP=status    nur Kennzahlen (keine personenbezogenen Daten)
set -euo pipefail
: "${STEP:?STEP fehlt}"
: "${COMMIT:=unknown}"
APP_TGZ="${APP_TGZ:-/tmp/jarvis-contacts-app.tgz}"
R=/opt/jarvis-contacts
MAIL_ROOT=/opt/jarvis-mail
MAIL_CONTAINER=jarvis-mail-mail-worker-1
PROJECT=jarvis-contacts
SERVICE=contacts-worker
CONTAINER=jarvis-contacts-worker
D() { sudo -n docker "$@"; }
blocked() { echo "DEPLOY BLOCKED: $*"; exit 3; }
probe() { D inspect -f '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Running}}' "$MAIL_CONTAINER"; }
C=(compose -p "$PROJECT" -f "$R/docker-compose.yml" --project-directory "$R")

BEFORE="$(probe)" || blocked "Mail-Worker nicht gefunden – nichts verändert."
echo "Mail-Worker vorher: id=$(echo "$BEFORE" | cut -c1-12) restarts=$(echo "$BEFORE" | cut -d' ' -f3)"

case "$STEP" in
  build)
    sudo -n mkdir -p "$R" "$MAIL_ROOT/data" "$MAIL_ROOT/exports"
    sudo -n chown 1000:1000 "$MAIL_ROOT/data" "$MAIL_ROOT/exports" && sudo -n chmod 700 "$MAIL_ROOT/data" "$MAIL_ROOT/exports"
    sudo -n rm -rf "$R/app.new" && sudo -n mkdir -p "$R/app.new" && sudo -n tar -xzf "$APP_TGZ" -C "$R/app.new"
    NEW="$R/docker-compose.yml.new"; sudo -n cp "$R/app.new/deploy/vps/contacts/docker-compose.yml" "$NEW"
    SERVICES="$(cd "$R" && D compose -p "$PROJECT" -f "$NEW" --project-directory "$R" config --services)"
    [ "$SERVICES" = "$SERVICE" ] || blocked "Compose definiert nicht genau den Service $SERVICE ($SERVICES)."
    CFG="$(cd "$R" && D compose -p "$PROJECT" -f "$NEW" --project-directory "$R" config --format json)"
    printf '%s' "$CFG" | grep -q docker.sock && blocked "Compose mountet den Docker-Socket."
    printf '%s' "$CFG" | grep -qE '"image": *"jarvis-mail' && blocked "Compose nutzt das Mail-Image."
    # Mail-Secrets nur lesend
    printf '%s' "$CFG" | D run --rm -i --network none node:22-alpine node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).services["contacts-worker"].volumes;const m=v.find(x=>x.source==="/opt/jarvis-mail/secrets");process.exit(m&&m.read_only===true&&v.filter(x=>x.source.startsWith("/opt/jarvis-mail")&&!x.read_only).every(x=>/\/opt\/jarvis-mail\/(data|exports)$/.test(x.source))?0:1)})' \
      || blocked "Mail-Secrets nicht read-only oder unerwarteter schreibender Mount unter $MAIL_ROOT."
    echo "TARGET OK: Projekt $PROJECT · Service $SERVICE · Mail-Secrets read-only · kein Docker-Socket"
    [ -d "$R/app" ] && sudo -n rm -rf "$R/app.old" && sudo -n mv "$R/app" "$R/app.old"
    sudo -n mv "$R/app.new" "$R/app" && sudo -n mv "$NEW" "$R/docker-compose.yml"
    echo "$COMMIT" | sudo -n tee "$R/DEPLOYED_COMMIT" >/dev/null
    (cd "$R" && sudo -n env JARVIS_COMMIT="$COMMIT" docker "${C[@]}" build "$SERVICE" 2>&1 | tail -3)
    ;;
  backfill)
    D inspect "$CONTAINER" >/dev/null 2>&1 && [ "$(D inspect -f '{{.State.Running}}' "$CONTAINER")" = true ] && blocked "Dienst läuft – Backfill nur bei gestopptem Dienst (ein Schreiber)."
    D rm -f jarvis-contacts-backfill >/dev/null 2>&1 || true
    (cd "$R" && D "${C[@]}" run -d --name jarvis-contacts-backfill --no-deps "$SERVICE" node lead-contacts.js --backfill ${BACKFILL_ARGS:-})
    echo "Backfill gestartet: sudo docker logs -f jarvis-contacts-backfill"
    ;;
  start)
    (cd "$R" && sudo -n env JARVIS_COMMIT="$COMMIT" docker "${C[@]}" up -d --no-deps --no-build "$SERVICE")
    H=starting
    for _ in $(seq 1 180); do H="$(D inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"; [ "$H" = healthy ] && break; [ "$H" = unhealthy ] && break; sleep 1; done
    echo "Kontaktdienst: $CONTAINER health=$H"
    ;;
  status)
    D run --rm -v "$MAIL_ROOT/data:/data/contacts:ro" --read-only --cap-drop ALL --user 1000:1000 jarvis-contacts-worker:latest node lead-contacts.js --report
    sudo -n ls -l "$MAIL_ROOT/exports" | tail -n +2 | awk '{print $1, $5, $9}'
    ;;
  *) blocked "Unbekannter STEP $STEP" ;;
esac

AFTER="$(probe)" || { echo "TF-051 FAIL: Mail-Worker nicht auffindbar"; exit 1; }
if [ "$BEFORE" = "$AFTER" ]; then echo "MAIL_WORKER_UNTOUCHED=YES"; else echo "MAIL_WORKER_UNTOUCHED=NO"; exit 1; fi
