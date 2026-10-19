#!/usr/bin/env bash
# TF-080: Stripe-Schlüssel bzw. E2E-Konfiguration sicher auf dem VPS hinterlegen – OHNE dass ein Wert im Terminal, in der Shell-History,
# in der Prozessliste, im Git, im Deploy-Archiv oder in Logs erscheint. Eingabe verdeckt (read -s), Übertragung nur über stdin von ssh.
#
#   deploy/vps/install-stripe-keys.sh <ssh-host> live     STRIPE_SECRET_KEY        (sk_live_… / rk_live_… – nur Repair-Service)
#   deploy/vps/install-stripe-keys.sh <ssh-host> test     STRIPE_TEST_SECRET_KEY   (sk_test_… / rk_test_… – nur Repair-Service)
#   deploy/vps/install-stripe-keys.sh <ssh-host> e2e      JARVIS_E2E_TEST_ENABLED / _DOMAINS / _MAILBOXES (keine Secrets; Mail-Worker + Repair)
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
case "$K" in STRIPE_SECRET_KEY|STRIPE_TEST_SECRET_KEY|JARVIS_E2E_TEST_ENABLED|JARVIS_E2E_TEST_DOMAINS|JARVIS_E2E_TEST_MAILBOXES) ;; *) echo "Unbekannter Schlüssel"; exit 2;; esac
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
set_secret() { # $1 Schlüssel, $2 Prüf-Regex, $3 Hinweis
  local v; IFS= read -rs -p "$1 ($3): " v; echo
  [[ "$v" =~ $2 ]] || { echo "Format passt nicht ($3) – nichts geändert."; exit 1; }
  printf '%s\n' "$v" | send stripe.env "$1"
  v=""
}
restart_repair() { "$SSH" "$HOST" "cd /opt/jarvis-repair && sudo docker compose up -d --no-deps --no-build repair-worker >/dev/null && echo 'Repair-Service mit neuer Konfiguration gestartet.'"; }

case "$WHAT" in
  live) set_secret STRIPE_SECRET_KEY '^(sk|rk)_live_[A-Za-z0-9]{8,}$' "sk_live_… oder rk_live_…"; restart_repair ;;
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
  status)
    "$SSH" "$HOST" 'for f in /opt/jarvis-payment/stripe.env /opt/jarvis-payment/e2e.env; do echo "$f:"; if sudo test -f "$f"; then sudo stat -c "  %U:%G %a" "$f"; sudo cut -d= -f1 "$f" | sed "s/^/  gesetzt: /"; else echo "  fehlt"; fi; done' ;;
  *) echo "live|test|e2e|status"; exit 1 ;;
esac
