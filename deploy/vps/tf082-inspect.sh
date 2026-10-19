#!/usr/bin/env bash
# TF-082 – zusätzliche READ-ONLY-Sicht vor dem Deploy: Versandmodus, Kontaktformular-Einstellungen (nur Namen/Schalter) und Repair-Outbox (nur Zähler/Status).
# Nie Adressen, Texte oder Secrets.   ssh <host> 'bash -s' < deploy/vps/tf082-inspect.sh
set -euo pipefail
ROOT="${MAIL_ROOT:-/opt/jarvis-mail}"; REPAIR="${REPAIR_ROOT:-/opt/jarvis-repair}"
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo"
$SUDO python3 - "$ROOT/secrets/mail_worker/config.json" "$REPAIR/outbox" <<'PY'
import json, os, sys, collections
cfgp, ob = sys.argv[1], sys.argv[2]
c = json.load(open(cfgp))
print("Versand: dryRun =", c.get("dryRun"), "| sendMode =", c.get("sendMode"))
cf = c.get("contactForms") if isinstance(c.get("contactForms"), dict) else {}
print("contactForms Schlüssel:", sorted(cf.keys()), "| autoReply =", cf.get("autoReply", "(Standard: an)"))
for f in (cf.get("forms") or []):
    print("  Formular:", {k: f.get(k) for k in ("form_name", "site", "market", "payment_links") if k in f} or "?")
try:
    names = sorted(os.listdir(ob))
    req = [n for n in names if n.endswith(".request.json")]
    res = collections.Counter()
    for n in names:
        if n.endswith(".result.json"):
            try: res[json.load(open(os.path.join(ob, n))).get("status")] += 1
            except Exception: res["?"] += 1
    pend = [n for n in req if n.replace(".request.json", ".result.json") not in names]
    print("Outbox: Entwürfe:", len([n for n in names if n.endswith('.draft.json')]), "| Aufträge offen:", len(pend), "| Ergebnisse:", dict(res))
    for n in names:
        if n.endswith((".draft.json", ".request.json")):
            try: d = json.load(open(os.path.join(ob, n)))
            except Exception: continue
            print("  ", n.rsplit('.', 2)[1], "Klasse:", d.get("message_class"), "| Auftrag:", d.get("order_id") or "-", "| erstellt:", str(d.get("created_at") or d.get("at") or "?")[:19])
except Exception as e:
    print("Outbox nicht lesbar:", type(e).__name__)
PY
