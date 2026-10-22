#!/usr/bin/env bash
# Repair-Deploy, Server-Teil (TF-047). Wird von deploy/vps/deploy-repair.sh per SSH (bash -s) ausgeführt – und unverändert vom
# lokalen Separation-Lab (test/integration/service-separation-047) gegen Docker Desktop. Gibt nie Secrets aus.
#
# Ändert AUSSCHLIESSLICH das Compose-Projekt «jarvis-repair» (Service repair-worker). Nie: docker compose down, ein globaler
# Docker-/containerd-Neustart, ein Build/Start im Projekt jarvis-mail, ein Zugriff auf den Mail-Worker ausser read-only
# (docker inspect + read-only Probe per docker exec). Vorher/nachher wird der Mail-Worker verglichen – jede Abweichung = FAIL.
#
# Parameter (Umgebung): COMMIT (Pflicht), APP_TGZ (Archiv des Commits), R=/opt/jarvis-repair, MAIL_ROOT=/opt/jarvis-mail,
# MAIL_CONTAINER=jarvis-mail-mail-worker-1, MAIL_PROJECT=jarvis-mail, REPAIR_PROJECT=jarvis-repair,
# REPAIR_CONTAINER=jarvis-repair-worker, SUDO=sudo, OWNER=1000:1000 (leer = kein chown), COMPOSE_OVERRIDE (nur Lab),
# HEALTH_TIMEOUT=240 (Sekunden), PAY=/opt/jarvis-payment (nur Lab abweichend).
set -euo pipefail
: "${COMMIT:?COMMIT fehlt}"
APP_TGZ="${APP_TGZ:-/tmp/jarvis-repair-app.tgz}"
R="${R:-/opt/jarvis-repair}"
MAIL_ROOT="${MAIL_ROOT:-/opt/jarvis-mail}"
MAIL_CONTAINER="${MAIL_CONTAINER:-jarvis-mail-mail-worker-1}"
MAIL_PROJECT="${MAIL_PROJECT:-jarvis-mail}"
REPAIR_PROJECT="${REPAIR_PROJECT:-jarvis-repair}"
REPAIR_CONTAINER="${REPAIR_CONTAINER:-jarvis-repair-worker}"
SUDO="${SUDO-sudo}"
OWNER="${OWNER-1000:1000}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
# TF-JARVIS-PRAXIS-002: Ablage der Stripe-/E2E-Konfiguration (Standard /opt/jarvis-payment – Server unverändert); nur das Lab setzt
# einen eigenen Pfad (Docker Desktop ohne root kann /opt nicht anlegen). Compose liest denselben Wert (JARVIS_PAYMENT_DIR).
PAY="${PAY:-/opt/jarvis-payment}"
export JARVIS_PAYMENT_DIR="$PAY"
SERVICE=repair-worker
D() { $SUDO docker "$@"; }
blocked() { echo "DEPLOY BLOCKED: $*"; exit 3; }

# ---------- Read-only Probe des Mail-Workers ----------
# Container: ID, StartedAt, RestartCount, Health. Innen (read-only, Skript über stdin – rootfs bleibt read-only):
# Scheduler = Alter des Herzschlags (worker.lock) + des letzten Ticks, Queue = Cloud-Aufträge (pending/processing, lesbar),
# Authority = authority.json (holder/self). Nur Zahlen/Wörter, nie Adressen/Inhalte.
PROBE_JS='
const fs = require("fs"), path = require("path");
const dir = path.join(process.env.JARVIS_SECRETS_DIR || "/data/secrets", "mail_worker");
const rd = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
const now = Date.now(), lock = rd("worker.lock"), auth = rd("authority.json"), inbox = rd("cloud_requests.json");
let lastTick = null;
try { const f = path.join(dir, "worker.log"), st = fs.statSync(f), n = Math.min(st.size, 262144), b = Buffer.alloc(n), fd = fs.openSync(f, "r");
  fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
  for (const l of b.toString("utf8").split("\n").reverse()) { if (l.includes("\"event\":\"tick\"") || l.includes("\"event\":\"standby_no_send_authority\"")) { try { lastTick = Date.parse(JSON.parse(l).ts); break; } catch {} } } } catch {}
const st = inbox ? Object.values(inbox).map((e) => e.status) : null;
const age = (t) => (t ? Math.round((now - t) / 1000) : -1);
console.log(["beat_age_s=" + age(lock && lock.beat), "tick_age_s=" + age(lastTick), "holder=" + ((auth && auth.holder) || "none"), "self=" + !!(auth && auth.self),
  "queue_readable=" + (inbox !== null || !fs.existsSync(path.join(dir, "cloud_requests.json"))), "pending=" + (st ? st.filter((x) => x === "pending").length : -1), "processing=" + (st ? st.filter((x) => x === "accepted_local").length : -1)].join(" "));
'
mail_probe() {
  local c
  c="$(D inspect -f 'id={{.Id}} started={{.State.StartedAt}} restarts={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} running={{.State.Running}} project={{index .Config.Labels "com.docker.compose.project"}}' "$MAIL_CONTAINER")" || return 1
  echo "$c $(printf '%s' "$PROBE_JS" | D exec -i "$MAIL_CONTAINER" node - 2>/dev/null || echo probe=failed)"
}
field() { printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1; }

echo "== Mail-Worker BEFORE (read-only) =="
BEFORE="$(mail_probe)" || blocked "Mail-Worker $MAIL_CONTAINER nicht gefunden – nichts verändert."
echo "$BEFORE" | tr ' ' '\n' | grep -v '^id=' ; echo "container_id=$(field "$BEFORE" id | cut -c1-12)"
[ "$(field "$BEFORE" project)" = "$MAIL_PROJECT" ] || blocked "Mail-Worker gehört nicht zum Projekt $MAIL_PROJECT."
[ "$MAIL_PROJECT" != "$REPAIR_PROJECT" ] || blocked "Repair-Projekt = Mail-Projekt."

# ---------- Neuen Stand entpacken (nur unter $R) ----------
$SUDO mkdir -p "$R/state" "$R/outbox" "$R/crm-export"
$SUDO rm -rf "$R/app.new" && $SUDO mkdir -p "$R/app.new"
$SUDO tar -xzf "$APP_TGZ" -C "$R/app.new"
COMPOSE_NEW="$R/docker-compose.yml.new"
$SUDO cp "$R/app.new/deploy/vps/repair/docker-compose.yml" "$COMPOSE_NEW"
OVR=(); [ -n "${COMPOSE_OVERRIDE:-}" ] && OVR=(-f "$COMPOSE_OVERRIDE")

# TF-080: Stripe-/E2E-Konfiguration ausserhalb des Deploys (nur anlegen, wenn sie fehlt – nie überschreiben, nie lesen/ausgeben).
# OWNER leer (nur Lab, ohne root): kein chown root:root – wie bei $R/.env; Rechte 700/600 gelten immer.
$SUDO mkdir -p "$PAY" && { [ -z "$OWNER" ] || $SUDO chown root:root "$PAY"; } && $SUDO chmod 700 "$PAY"
# TF-JARVIS-028: Existenzprüfung mit $SUDO – /opt/jarvis-payment ist 0700; ohne Rechte galt die Datei als fehlend und wurde geleert (Stripe-Schlüssel!).
for f in stripe.env e2e.env; do $SUDO test -f "$PAY/$f" || $SUDO sh -c "umask 077; : > '$PAY/$f'"; [ -z "$OWNER" ] || $SUDO chown root:root "$PAY/$f"; $SUDO chmod 600 "$PAY/$f"; done
$SUDO grep -qE '^(ANTHROPIC_API_KEY|JARVIS_SERVER_CONTROL_TOKEN|GMAIL)' "$PAY/stripe.env" && blocked "stripe.env enthält Mail-Secrets."
echo "Stripe-Konfiguration: LIVE $($SUDO grep -qE '^STRIPE_SECRET_KEY=.+' "$PAY/stripe.env" && echo CONFIGURED || echo NOT_CONFIGURED) · TEST $($SUDO grep -qE '^STRIPE_TEST_SECRET_KEY=.+' "$PAY/stripe.env" && echo CONFIGURED || echo NOT_CONFIGURED)"

# ---------- Ziel beweisen: genau EIN Service, eigenes Projekt, kein Mail-Mount, kein Docker-Socket ----------
[ -f "$R/.env" ] || {
  # Einmalig: nur die erlaubten Schlüssel aus der Mail-.env übernehmen (lesen, nie ausgeben, Mail-Stack unverändert).
  [ -f "$MAIL_ROOT/.env" ] || blocked "$R/.env fehlt und $MAIL_ROOT/.env ist nicht lesbar."
  $SUDO sh -c "umask 077; grep -E '^(JARVIS_MAIL_WORKER_TOKEN|JARVIS_SYNC_URL|JARVIS_WEB_ORIGIN)=' '$MAIL_ROOT/.env' > '$R/.env' || true"
}
[ -n "$OWNER" ] && $SUDO chown root:root "$R/.env" && $SUDO chmod 600 "$R/.env"
echo "Repair-.env Schlüssel: $($SUDO cut -d= -f1 "$R/.env" | grep -E '^[A-Z_]+$' | tr '\n' ' ')"
$SUDO grep -qE '^(ANTHROPIC_API_KEY|JARVIS_SERVER_CONTROL_TOKEN)=' "$R/.env" && blocked "Repair-.env enthält Mail-Secrets."
SERVICES="$(cd "$R" && D compose -p "$REPAIR_PROJECT" -f "$COMPOSE_NEW" "${OVR[@]}" --project-directory "$R" config --services)"
[ "$SERVICES" = "$SERVICE" ] || blocked "Compose-Datei definiert nicht genau den einen Service $SERVICE (gefunden: $(echo $SERVICES))."
CFG="$(cd "$R" && D compose -p "$REPAIR_PROJECT" -f "$COMPOSE_NEW" "${OVR[@]}" --project-directory "$R" config)"
printf '%s' "$CFG" | grep -q "$MAIL_ROOT" && blocked "Repair-Compose referenziert $MAIL_ROOT."
printf '%s' "$CFG" | grep -q "docker.sock" && blocked "Repair-Compose mountet den Docker-Socket."
printf '%s' "$CFG" | grep -qE 'image: *jarvis-mail' && blocked "Repair-Compose nutzt das Mail-Image."
printf '%s' "$CFG" | grep -qE "container_name: *$MAIL_CONTAINER\$" && blocked "Repair-Compose nutzt den Mail-Container-Namen."
echo "TARGET OK: Projekt $REPAIR_PROJECT · Service $SERVICE · kein Mail-Mount · kein Docker-Socket"

# ---------- Aktivieren: nur unter $R ----------
[ -d "$R/app" ] && $SUDO rm -rf "$R/app.old" && $SUDO mv "$R/app" "$R/app.old"
$SUDO mv "$R/app.new" "$R/app"
$SUDO mv "$COMPOSE_NEW" "$R/docker-compose.yml"
echo "$COMMIT" | $SUDO tee "$R/DEPLOYED_COMMIT" >/dev/null
if [ -n "$OWNER" ]; then
  $SUDO chown -R "$OWNER" "$R/state" "$R/outbox" "$R/crm-export" && $SUDO chmod 700 "$R/state" "$R/outbox" "$R/crm-export"
  $SUDO find "$R/state" "$R/outbox" "$R/crm-export" -type d -exec chmod 700 {} + && $SUDO find "$R/state" "$R/outbox" "$R/crm-export" -type f -exec chmod 600 {} +
fi
C=(compose -p "$REPAIR_PROJECT" -f "$R/docker-compose.yml" "${OVR[@]}" --project-directory "$R")
(cd "$R" && $SUDO env JARVIS_COMMIT="$COMMIT" JARVIS_DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" docker "${C[@]}" build "$SERVICE")
(cd "$R" && $SUDO env JARVIS_COMMIT="$COMMIT" docker "${C[@]}" up -d --no-deps --no-build "$SERVICE")

# ---------- Repair-Service gesund? ----------
H=starting
for _ in $(seq 1 "$HEALTH_TIMEOUT"); do
  H="$(D inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$REPAIR_CONTAINER" 2>/dev/null || echo missing)"
  [ "$H" = healthy ] && break; [ "$H" = unhealthy ] && break; sleep 1
done
echo "Repair-Service: $REPAIR_CONTAINER health=$H commit=$(D inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$REPAIR_CONTAINER" | sed -n 's/^JARVIS_COMMIT=//p')"

# ---------- Mail-Worker AFTER + Vergleich ----------
echo "== Mail-Worker AFTER (read-only) =="
AFTER="$(mail_probe)" || { echo "TF-047 FAIL: Mail-Worker nach dem Deploy nicht auffindbar"; exit 1; }
echo "$AFTER" | tr ' ' '\n' | grep -v '^id=' ; echo "container_id=$(field "$AFTER" id | cut -c1-12)"
FAILS=0
chk() { if [ "$2" = "$3" ]; then echo "$1: JA"; else echo "$1: NEIN"; FAILS=$((FAILS + 1)); fi; }
chk "Container unverändert (nicht recreated)" "$(field "$BEFORE" id)" "$(field "$AFTER" id)"
chk "StartedAt unverändert" "$(field "$BEFORE" started)" "$(field "$AFTER" started)"
chk "RestartCount unverändert (delta 0)" "$(field "$BEFORE" restarts)" "$(field "$AFTER" restarts)"
chk "Running" "true" "$(field "$AFTER" running)"
chk "Health unverändert" "$(field "$BEFORE" health)" "$(field "$AFTER" health)"
BA="$(field "$AFTER" beat_age_s)"; [ -n "$BA" ] && [ "$BA" -ge 0 ] && [ "$BA" -lt 300 ] && echo "Scheduler aktiv (Herzschlag ${BA}s): JA" || { echo "Scheduler aktiv: NEIN"; FAILS=$((FAILS + 1)); }
chk "Queue lesbar/healthy" "true" "$(field "$AFTER" queue_readable)"
chk "Authority unverändert" "$(field "$BEFORE" holder)/$(field "$BEFORE" self)" "$(field "$AFTER" holder)/$(field "$AFTER" self)"
[ "$H" = healthy ] || { echo "Repair-Service nicht healthy ($H)"; FAILS=$((FAILS + 1)); }
if [ "$FAILS" -eq 0 ]; then echo "MAIL_WORKER_UNTOUCHED=YES"; echo "REPAIR_DEPLOY=OK $COMMIT"; else echo "MAIL_WORKER_UNTOUCHED=NO"; echo "TF-047 FAIL ($FAILS)"; exit 1; fi
