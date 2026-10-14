#!/usr/bin/env bash
# Lead-CRM-Deploy, Server-Teil (TF-053). Wird von deploy/vps/deploy-crm.sh per SSH (bash -s) ausgeführt. Gibt nie Secrets aus.
# Ändert AUSSCHLIESSLICH das Compose-Projekt «jarvis-crm» (Service crm-worker). Nie: docker compose in jarvis-mail/jarvis-contacts,
# Neustart/Recreate von Mail-Worker oder Kontaktdienst. Beide werden vorher/nachher verglichen.
#
#   STEP=build       neuen Stand entpacken, Ziel prüfen, Image bauen, Agent-Schlüssel ableiten (.env 600) – Dienst bleibt wie er ist
#   STEP=start       Dienst starten/aktualisieren (nur crm-worker, --no-deps)
#   STEP=status      Container-Zustand (ohne Daten)
#   STEP=report      Kennzahlen aus dem laufenden Dienst (keine personenbezogenen Daten)
#   STEP=backup-now  sofort ein verschlüsseltes CRM-Backup (lokal + offsite)
set -euo pipefail
: "${STEP:?STEP fehlt}"
: "${COMMIT:=unknown}"
APP_TGZ="${APP_TGZ:-/tmp/jarvis-crm-app.tgz}"
R=/opt/jarvis-crm
MAIL_ROOT=/opt/jarvis-mail
MAIL_CONTAINER=jarvis-mail-mail-worker-1
CONTACTS_CONTAINER=jarvis-contacts-worker
PROJECT=jarvis-crm
SERVICE=crm-worker
CONTAINER=jarvis-crm-worker
D() { sudo -n docker "$@"; }
blocked() { echo "DEPLOY BLOCKED: $*"; exit 3; }
probe() { D inspect -f '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Running}}' "$1"; }
C=(compose -p "$PROJECT" -f "$R/docker-compose.yml" --project-directory "$R")

MAIL_BEFORE="$(probe "$MAIL_CONTAINER")" || blocked "Mail-Worker nicht gefunden – nichts verändert."
CONTACTS_BEFORE="$(probe "$CONTACTS_CONTAINER" 2>/dev/null || echo none)"
echo "Mail-Worker vorher: id=$(echo "$MAIL_BEFORE" | cut -c1-12) restarts=$(echo "$MAIL_BEFORE" | cut -d' ' -f3)"

case "$STEP" in
  build)
    sudo -n mkdir -p "$R" "$MAIL_ROOT/data"
    sudo -n chown 1000:1000 "$MAIL_ROOT/data" && sudo -n chmod 700 "$MAIL_ROOT/data"
    sudo -n rm -rf "$R/app.new" && sudo -n mkdir -p "$R/app.new" && sudo -n tar -xzf "$APP_TGZ" -C "$R/app.new"
    NEW="$R/docker-compose.yml.new"; sudo -n cp "$R/app.new/deploy/vps/crm/docker-compose.yml" "$NEW"
    [ -f "$R/.env" ] || sudo -n install -m 600 /dev/null "$R/.env"
    SERVICES="$(cd "$R" && D compose -p "$PROJECT" -f "$NEW" --project-directory "$R" config --services)"
    [ "$SERVICES" = "$SERVICE" ] || blocked "Compose definiert nicht genau den Service $SERVICE ($SERVICES)."
    CFG="$(cd "$R" && D compose -p "$PROJECT" -f "$NEW" --project-directory "$R" config --format json)"
    printf '%s' "$CFG" | grep -q docker.sock && blocked "Compose mountet den Docker-Socket."
    printf '%s' "$CFG" | grep -qE '"image": *"jarvis-(mail|contacts)' && blocked "Compose nutzt ein fremdes Image."
    # Mail-Secrets nur lesend; schreibend unter /opt/jarvis-mail ausschliesslich data/
    printf '%s' "$CFG" | D run --rm -i --network none node:22-alpine node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).services["crm-worker"].volumes;const m=v.find(x=>x.source==="/opt/jarvis-mail/secrets");process.exit(m&&m.read_only===true&&v.filter(x=>x.source.startsWith("/opt/jarvis-mail")&&!x.read_only).every(x=>x.source==="/opt/jarvis-mail/data")?0:1)})' \
      || blocked "Mail-Secrets nicht read-only oder unerwarteter schreibender Mount unter $MAIL_ROOT."
    echo "TARGET OK: Projekt $PROJECT · Service $SERVICE · Mail-Secrets read-only · kein Docker-Socket"
    if [ -d "$R/app" ]; then sudo -n rm -rf "$R/app.old" && sudo -n mv "$R/app" "$R/app.old"; fi
    sudo -n mv "$R/app.new" "$R/app" && sudo -n mv "$NEW" "$R/docker-compose.yml"
    echo "$COMMIT" | sudo -n tee "$R/DEPLOYED_COMMIT" >/dev/null
    (cd "$R" && sudo -n env JARVIS_COMMIT="$COMMIT" docker "${C[@]}" build "$SERVICE" 2>&1 | tail -3)
    # Agent-Schlüssel: HMAC aus dem Server-Control-Token, im CRM-Image ohne Netz berechnet (stdin → stdout), nie ausgegeben.
    TMPENV="$(sudo -n mktemp "$R/.env.new.XXXXXX")"
    if ! sudo -n cat "$MAIL_ROOT/.env" | D run --rm -i --network none --read-only --cap-drop ALL jarvis-crm-worker:latest node deploy/vps/crm-derive-token.mjs \
        | sudo -n tee "$TMPENV" >/dev/null; then
      sudo -n rm -f "$TMPENV"; blocked "Agent-Schlüssel nicht ableitbar (JARVIS_SERVER_CONTROL_TOKEN fehlt?)."
    fi
    sudo -n chmod 600 "$TMPENV" && sudo -n mv "$TMPENV" "$R/.env"
    echo "AGENT-SCHLÜSSEL: $(sudo -n grep -c '^JARVIS_CRM_AGENT_TOKEN=[0-9a-f]\{64\}$' "$R/.env") Eintrag abgeleitet (Wert nicht ausgegeben) · .env $(sudo -n stat -c %a "$R/.env")"
    ;;
  start)
    (cd "$R" && sudo -n env JARVIS_COMMIT="$COMMIT" docker "${C[@]}" up -d --no-deps --no-build "$SERVICE")
    H=starting
    for _ in $(seq 1 150); do H="$(D inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"; [ "$H" = healthy ] && break; [ "$H" = unhealthy ] && break; sleep 1; done
    echo "CRM-Dienst: $CONTAINER health=$H"
    ;;
  status)
    D inspect -f '{{.Name}} {{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}}' "$CONTAINER"
    echo "DEPLOYED_COMMIT $(cat "$R/DEPLOYED_COMMIT" 2>/dev/null)"
    sudo -n ls -l "$MAIL_ROOT/data" | tail -n +2 | awk '{print $1, $5, $9}'
    D logs --tail 20 "$CONTAINER" 2>&1 | grep -oE '"event":"[a-z_]+"(,"[a-z_]+":("[^"]{0,40}"|[0-9a-z.]+))*' | tail -20 || true
    ;;
  report) D exec "$CONTAINER" node crm-service.js --report ;;
  backup-now) D exec "$CONTAINER" node crm-service.js --backup-now ;;
  *) blocked "Unbekannter STEP $STEP" ;;
esac

MAIL_AFTER="$(probe "$MAIL_CONTAINER")" || { echo "TF-053 FAIL: Mail-Worker nicht auffindbar"; exit 1; }
CONTACTS_AFTER="$(probe "$CONTACTS_CONTAINER" 2>/dev/null || echo none)"
if [ "$MAIL_BEFORE" = "$MAIL_AFTER" ]; then echo "MAIL_WORKER_UNTOUCHED=YES"; else echo "MAIL_WORKER_UNTOUCHED=NO"; exit 1; fi
if [ "$CONTACTS_BEFORE" = "$CONTACTS_AFTER" ]; then echo "CONTACTS_WORKER_UNTOUCHED=YES"; else echo "CONTACTS_WORKER_UNTOUCHED=NO"; exit 1; fi
