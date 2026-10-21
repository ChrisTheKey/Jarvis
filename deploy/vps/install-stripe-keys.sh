#!/usr/bin/env bash
# TF-080: Stripe-Schlüssel bzw. E2E-Konfiguration sicher auf dem VPS hinterlegen – OHNE dass ein Wert im Terminal, in der Shell-History,
# in der Prozessliste, im Git, im Deploy-Archiv oder in Logs erscheint. Eingabe verdeckt (read -s), Übertragung nur über stdin von ssh.
#
#   deploy/vps/install-stripe-keys.sh <ssh-host> live     STRIPE_SECRET_KEY        (sk_live_… / rk_live_… – nur Repair-Service)
#                                                         TF-JARVIS-024: erst lesende Vorprüfung, dann getippte Freigabe «LIVE AKTIVIEREN» – sonst nichts geändert
#   deploy/vps/install-stripe-keys.sh <ssh-host> live-off STRIPE_SECRET_KEY entfernen (Rollback → LIVE NOT_CONFIGURED, keine neuen Live-Checkouts)
#   deploy/vps/install-stripe-keys.sh <ssh-host> test     STRIPE_TEST_SECRET_KEY   (sk_test_… / rk_test_… – nur Repair-Service)
#   deploy/vps/install-stripe-keys.sh <ssh-host> e2e      JARVIS_E2E_TEST_ENABLED / _DOMAINS / _MAILBOXES (keine Secrets; Mail-Worker + Repair)
#   deploy/vps/install-stripe-keys.sh <ssh-host> fulfilment  JARVIS_E2E_FULFILMENT_ENABLED (TF-088, Standard false – nur für den kontrollierten CHF-150-Erfüllungstest)
#   deploy/vps/install-stripe-keys.sh <ssh-host> status   nur Rechte + Schlüsselnamen (nie Werte)
#
# Ablage: /opt/jarvis-payment/stripe.env und /opt/jarvis-payment/e2e.env (root:root, Verzeichnis 0700, Dateien 0600). Deploys überschreiben sie nie.
# Webhook-Secrets (whsec_…) gehören NICHT hierher, sondern in Netlify: STRIPE_WEBHOOK_SECRET (LIVE) / STRIPE_TEST_WEBHOOK_SECRET (TEST).
set -euo pipefail
HOST="${1:?ssh-host fehlt}"; WHAT="${2:?live|test|e2e|status}"
SSH=ssh; [ -x /c/WINDOWS/System32/OpenSSH/ssh.exe ] && SSH=/c/WINDOWS/System32/OpenSSH/ssh.exe

# Remote-Teil: genau EINEN Schlüssel (Name aus fester Liste) aus stdin setzen/ersetzen, Rechte erzwingen, Wert nie ausgeben.
# printf ist ein Shell-Builtin – der Wert erscheint weder in der Prozessliste noch in einer temporären Heredoc-Datei.
REMOTE_SET=$(cat <<'R'
set -euo pipefail
D=/opt/jarvis-payment; F="$D/$1"; K="$2"
case "$1" in stripe.env|e2e.env) ;; *) echo "Unbekannte Datei"; exit 2;; esac
case "$K" in STRIPE_SECRET_KEY|STRIPE_TEST_SECRET_KEY|JARVIS_E2E_TEST_ENABLED|JARVIS_E2E_TEST_DOMAINS|JARVIS_E2E_TEST_MAILBOXES|JARVIS_E2E_FULFILMENT_ENABLED) ;; *) echo "Unbekannter Schlüssel"; exit 2;; esac
IFS= read -r V || true
[ -n "$V" ] || { echo "Leer – nichts geändert."; exit 3; }
sudo mkdir -p "$D"; sudo chown root:root "$D"; sudo chmod 700 "$D"
printf '%s=%s\n' "$K" "$V" | sudo env F="$F" K="$K" sh -c 'umask 077; touch "$F"; grep -v "^$K=" "$F" > "$F.tmp" || true; cat >> "$F.tmp"; mv "$F.tmp" "$F"; chown root:root "$F"; chmod 600 "$F"'
V=""
echo "$K gesetzt (Wert nicht angezeigt)."
R
)
send() { # $1 Datei, $2 Schlüssel; Wert kommt über stdin
  "$SSH" "$HOST" "bash -c $(printf '%q' "$REMOTE_SET") _ $1 $2"
}
# TF-JARVIS-024 Rollback: genau EINEN Stripe-Schlüssel (feste Liste) aus stripe.env entfernen, Rechte erzwingen, nichts ausgeben.
REMOTE_UNSET=$(cat <<'R'
set -euo pipefail
F=/opt/jarvis-payment/stripe.env; K="$1"
case "$K" in STRIPE_SECRET_KEY|STRIPE_TEST_SECRET_KEY) ;; *) echo "Unbekannter Schlüssel"; exit 2;; esac
sudo test -f "$F" && sudo grep -q "^$K=" "$F" || { echo "$K nicht gesetzt – nichts geändert."; exit 3; }
sudo env F="$F" K="$K" sh -c 'umask 077; grep -v "^$K=" "$F" > "$F.tmp" || true; mv "$F.tmp" "$F"; chown root:root "$F"; chmod 600 "$F"'
echo "$K entfernt."
R
)
# Lesende Vorprüfung vor LIVE: Statuswörter/Zähler des Repair-Service (nie Werte). Bestätigte, bezahlbare CHF-480-Aufträge erhalten nach der
# Aktivierung im nächsten Zyklus automatisch eine LIVE-Checkout-Session (Kundenmail) – deshalb vorher ansehen.
preflight_live() {
  echo "Lesende Vorprüfung (Repair-Service):"
  "$SSH" -n "$HOST" "sudo docker exec jarvis-repair-worker node stripe-webhook.js status" || echo # -n: liest nie die folgenden Eingaben mit "  (Repair-Service nicht erreichbar – Status unbekannt)"
}
confirm_live() {
  echo "ACHTUNG: Mit dem LIVE-Schlüssel erzeugt der Repair-Service echte Stripe-Checkout-Sessions (echtes Geld) für bestätigte CHF-480-Aufträge."
  local c; read -r -p "Zum Fortfahren exakt «LIVE AKTIVIEREN» tippen: " c
  [ "$c" = "LIVE AKTIVIEREN" ] || { echo "Nicht bestätigt – nichts geändert."; exit 1; }
}
set_secret() { # $1 Schlüssel, $2 Prüf-Regex, $3 Hinweis
  local v; IFS= read -rs -p "$1 ($3): " v; echo
  [[ "$v" =~ $2 ]] || { echo "Format passt nicht ($3) – nichts geändert."; exit 1; }
  printf '%s\n' "$v" | send stripe.env "$1"
  v=""
}
restart_repair() { "$SSH" "$HOST" "cd /opt/jarvis-repair && sudo docker compose up -d --no-deps --no-build repair-worker >/dev/null && echo 'Repair-Service mit neuer Konfiguration gestartet.'"; }

case "$WHAT" in
  live) preflight_live; confirm_live; set_secret STRIPE_SECRET_KEY '^(sk|rk)_live_[A-Za-z0-9]{8,}$' "sk_live_… oder rk_live_…"; restart_repair ;;
  live-off)
    read -r -p "STRIPE_SECRET_KEY entfernen und Repair-Service neu starten? (ja/nein): " c; [ "$c" = "ja" ] || { echo "Abgebrochen – nichts geändert."; exit 1; }
    rc=0; "$SSH" "$HOST" "bash -c $(printf '%q' "$REMOTE_UNSET") _ STRIPE_SECRET_KEY" || rc=$?
    if [ "$rc" -eq 0 ]; then restart_repair; elif [ "$rc" -eq 3 ]; then echo "Kein Neustart nötig."; else exit "$rc"; fi ;; # nur neu starten, wenn wirklich entfernt
  test) set_secret STRIPE_TEST_SECRET_KEY '^(sk|rk)_test_[A-Za-z0-9]{8,}$' "sk_test_… oder rk_test_…"; restart_repair ;;
  e2e)
    read -r -p "JARVIS_E2E_TEST_ENABLED (true/false): " en; [[ "$en" =~ ^(true|false)$ ]] || { echo "nur true/false"; exit 1; }
    read -r -p "JARVIS_E2E_TEST_DOMAINS (Sandbox-Domains, Komma-getrennt): " dom; [[ "$dom" =~ ^[a-z0-9.,-]+$ ]] || { echo "nur Domains"; exit 1; }
    read -r -p "JARVIS_E2E_TEST_MAILBOXES (Test-Postfächer, Komma-getrennt): " mb; [[ "$mb" =~ ^[A-Za-z0-9._%+@,-]+$ ]] || { echo "nur Adressen"; exit 1; }
    printf '%s\n' "$en" | send e2e.env JARVIS_E2E_TEST_ENABLED
    printf '%s\n' "$dom" | send e2e.env JARVIS_E2E_TEST_DOMAINS
    printf '%s\n' "$mb" | send e2e.env JARVIS_E2E_TEST_MAILBOXES
    restart_repair
    echo "Mail-Worker liest e2e.env beim nächsten Mail-Deploy (deploy/vps/deploy.sh – geplante Wartung)." ;;
  fulfilment)
    read -r -p "JARVIS_E2E_FULFILMENT_ENABLED (true/false): " fe; [[ "$fe" =~ ^(true|false)$ ]] || { echo "nur true/false"; exit 1; }
    printf '%s\n' "$fe" | send e2e.env JARVIS_E2E_FULFILMENT_ENABLED
    restart_repair
    echo "Mail-Worker liest e2e.env erst nach einem Mail-Deploy (deploy/vps/deploy.sh) – ohne ihn lehnt der Mail-Worker E2E-Testmails ab (fail closed)." ;;
  status)
    "$SSH" "$HOST" 'for f in /opt/jarvis-payment/stripe.env /opt/jarvis-payment/e2e.env; do echo "$f:"; if sudo test -f "$f"; then sudo stat -c "  %U:%G %a" "$f"; sudo cut -d= -f1 "$f" | sed "s/^/  gesetzt: /"; else echo "  fehlt"; fi; done' ;;
  *) echo "live|live-off|test|e2e|fulfilment|status"; exit 1 ;;
esac
