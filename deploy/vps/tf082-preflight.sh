#!/usr/bin/env bash
# TF-082 – Server-Vorprüfung + Konfigurationsänderung für TF-081 (Stripe-Zahlungszuordnung, Absender-Alias, Nachfassen AUS).
# Läuft AUF dem Server (Hetzner), gibt nie Secrets aus (nur Schlüsselnamen, Zähler und die öffentliche Alias-Adresse).
#   ssh <host> 'bash -s' < deploy/vps/tf082-preflight.sh              # nur lesen (Standard): Prüfung + geplante Änderung
#   ssh <host> 'bash -s -- --apply' < deploy/vps/tf082-preflight.sh   # Backup, Merge, Validierung, atomar schreiben
# Ändert NUR config.json (sender.sendAs setzen, paymentFollowup.enabled=false ergänzen, falls fehlend). Sendet nichts, startet nichts neu –
# der Mail-Worker liest config.json bei jedem Durchlauf neu; alter Code ignoriert unbekannte Schlüssel.
set -euo pipefail
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
ROOT="${MAIL_ROOT:-/opt/jarvis-mail}"; REPAIR="${REPAIR_ROOT:-/opt/jarvis-repair}"
ALIAS="${SEND_AS:-chris@helvetic-webdesign.ch}"
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
CFG="$ROOT/secrets/mail_worker/config.json"
ok() { echo "OK    $*"; }; warn() { echo "WARN  $*"; }; fail() { echo "FAIL  $*"; FAILED=1; }; FAILED=0
command -v python3 >/dev/null || { echo "FAIL  python3 fehlt"; exit 2; }

echo "== Deploy-Stand =="
[ -f "$ROOT/DEPLOYED_COMMIT" ] && ok "Mail-Worker Commit: $($SUDO cat "$ROOT/DEPLOYED_COMMIT")" || warn "Kein DEPLOYED_COMMIT"
for c in jarvis-mail-mail-worker-1 jarvis-repair-worker; do
  if $SUDO docker inspect "$c" >/dev/null 2>&1; then ok "$c: $($SUDO docker inspect -f '{{.State.Status}}/{{.State.Health.Status}} restarts={{.RestartCount}}' "$c")"; else warn "$c nicht gefunden"; fi
done

echo "== Ausstehende Mails/Queues (nur Zähler) =="
$SUDO python3 - "$ROOT/secrets" "$REPAIR" <<'PY'
import json, os, sys, collections
sec, rep = sys.argv[1], sys.argv[2]
def load(p):
    try: return json.load(open(p))
    except Exception: return None
cr = load(os.path.join(sec, "mail_worker", "cloud_requests.json"))
if cr is None: print("OK    Cloud-Aufträge: keine Datei (leer)")
else:
    items = cr.get("requests", cr) if isinstance(cr, dict) else cr
    vals = items.values() if isinstance(items, dict) else items
    c = collections.Counter((x.get("status") if isinstance(x, dict) else "?") for x in vals)
    print("OK    Cloud-Aufträge:", dict(c) or "leer")
reg = load(os.path.join(sec, "gmail_jarvis.json"))
if reg:
    d = collections.Counter((v.get("messageClass") or v.get("mode") or "COLD") for v in (reg.get("drafts") or {}).values())
    print("OK    Entwürfe im Register nach Klasse:", dict(d) or "keine", "| unklar 'sending':", len(reg.get("sending") or {}))
ob = os.path.join(rep, "outbox")
try: print("OK    Repair-Outbox-Dateien:", len([f for f in os.listdir(ob) if f.endswith('.json')]))
except Exception as e: print("WARN  Repair-Outbox nicht lesbar:", type(e).__name__)
PY

echo "== config.json =="
$SUDO test -f "$CFG" || { fail "$CFG fehlt"; exit 1; }
PLAN=$($SUDO python3 - "$CFG" "$ALIAS" <<'PY'
import json, sys, re
cfg, alias = sys.argv[1], sys.argv[2]
try: c = json.load(open(cfg))
except Exception as e: print("ERR gültiges JSON fehlt:", type(e).__name__); sys.exit(3)
if not isinstance(c, dict): print("ERR Wurzel ist kein Objekt"); sys.exit(3)
if not re.fullmatch(r"[a-z0-9._%+-]{1,64}@(?:[a-z0-9-]+\.)+[a-z]{2,24}", alias): print("ERR Alias ungültig"); sys.exit(3)
s = c.get("sender") if isinstance(c.get("sender"), dict) else {}
print("KEYS top:", sorted(c.keys()))
print("KEYS sender:", sorted(s.keys()), "| name gesetzt:", bool(s.get("name")), "| email gesetzt:", bool(s.get("email")))
print("sendAs aktuell:", repr(s.get("sendAs")) if s.get("sendAs") else "nicht gesetzt")
pf = c.get("paymentFollowup")
print("paymentFollowup aktuell:", json.dumps(pf) if isinstance(pf, dict) and set(pf) <= {"enabled","reminderHours","maxPerTick"} else ("nicht gesetzt" if pf is None else "unerwartete Form"))
print("PLAN: sender.sendAs ->", alias, "(übrige sender-Felder bleiben)")
if isinstance(pf, dict) and "enabled" in pf: print("PLAN: paymentFollowup.enabled bleibt", pf["enabled"], "(nicht überschrieben)" + ("  !!! ist TRUE – bitte bewusst prüfen" if pf["enabled"] is True else ""))
else: print("PLAN: paymentFollowup.enabled = false (ergänzt)")
if not s.get("name"): print("HINWEIS: sender.name fehlt – ohne Name sendet Jarvis keine Kundenmails")
PY
) || { echo "$PLAN"; fail "config.json nicht prüfbar"; exit 1; }
echo "$PLAN"

if [ "$APPLY" = 1 ]; then
  [ "$FAILED" = 0 ] || { echo "ABBRUCH wegen FAIL"; exit 1; }
  TS=$(date -u +%Y%m%dT%H%M%SZ); BAK="$CFG.bak-TF082-$TS"
  $SUDO cp -p "$CFG" "$BAK" && ok "Backup: $BAK"
  $SUDO python3 - "$CFG" "$ALIAS" <<'PY'
import json, sys, os, tempfile, shutil
cfg, alias = sys.argv[1], sys.argv[2]
c = json.load(open(cfg))
s = c.get("sender") if isinstance(c.get("sender"), dict) else {}
s["sendAs"] = alias; c["sender"] = s
pf = c.get("paymentFollowup") if isinstance(c.get("paymentFollowup"), dict) else {}
pf.setdefault("enabled", False); c["paymentFollowup"] = pf
st = os.stat(cfg)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(cfg), prefix=".config.", suffix=".tmp")
with os.fdopen(fd, "w") as f: json.dump(c, f, indent=2, ensure_ascii=False); f.write("\n")
json.load(open(tmp))                     # Validierung vor dem Austausch
os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o777)
os.replace(tmp, cfg)
PY
  $SUDO python3 -m json.tool "$CFG" >/dev/null && ok "config.json gültig, Rechte: $($SUDO stat -c '%U:%G %a' "$CFG")"
  echo "Rollback: sudo cp -p $BAK $CFG"
else
  echo "Nur Prüfung – nichts geändert. Zum Anwenden: --apply"
fi
[ "$FAILED" = 0 ]
