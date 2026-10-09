# Jarvis – Mobile/Cloud Runbook (Betrieb vom Handy, ohne PC)

Stand: 2026-10-09. Gilt für den CLOUD-Modus: der Windows-PC ist aus, kaputt oder nicht erreichbar. Alles hier läuft auf dem VPS
(Cloud Core + Mail-Worker + Server-Agent) und in Netlify (UI + Functions). Keine Secrets in diesem Dokument.

## 1. URL
- `https://chrisjarvis.netlify.app/` – einzige Adresse, auf dem Handy als Lesezeichen oder „Zum Home-Bildschirm“ (Chrome/Safari).
- Es gibt keine App und keinen anderen Zugang. Der VPS hat keinen offenen Port; alles läuft über die Netlify-Functions.

## 2. Login
- Beim ersten Öffnen: „Cloud-Passwort“ eingeben (= `JARVIS_PASSWORD` in Netlify, Wert nur im Passwort-Manager). Es wird nur auf
  diesem Gerät im Browser gespeichert (`localStorage`), nie an Dritte gesendet; es ist der Header `x-jarvis-key` für `/api/cloud`,
  `/api/state`, `/api/mail-requests`, `/api/server-control`.
- Alternativ Einmal-Link `https://chrisjarvis.netlify.app/?key=…` (speichert das Passwort und entfernt es aus der Adresszeile).
- Falsches Passwort → 401, das Passwortfeld erscheint erneut. Abmelden = Browserdaten der Seite löschen.
- Oben rechts steht **CLOUD** (gelb), sobald kein Local Core erreichbar ist. Das ist der Normalfall auf dem Handy, kein Fehler.

## 3. Handy-Nutzung
- Layout ≤ 860 px: eine Spalte, scrollbar. Reihenfolge: Kopfzeile → **Quick-Status** → Meldungen → **Mail** → Verkäufe → Vertrieb →
  Protokoll → Status → Server. Der Composer (Textfeld + SENDEN, Mikrofon-Taste) bleibt unten festgepinnt.
- Quick-Status: JARVIS `CLOUD ONLINE` · VPS CORE `ONLINE` · MAIL WORKER `VPS ACTIVE` · AUTHORITY `VPS` · WINDOWS CLIENT `OFFLINE`/`STANDBY`
  (gelb = normal) · QUEUE `n` · AI SERVICE `ONLINE`/`PAUSED — CREDIT LIMIT` · SERVER CONTROL `ONLINE`.
- Panels: Titel antippen klappt auf/zu (Status, Server, Verkäufe, Vertrieb, Protokoll sind anfangs zu; Meldungen und Mail offen).
- Chat: Text eingeben, Enter/SENDEN. Während Jarvis antwortet wird der Knopf zu STOPP. „Neues Gespräch“ setzt nur den Verlauf zurück.
- Mikrofon: Taste antippen und sprechen (Wake-Word ist auf Handys standardmässig aus). Stimme = Browser-TTS.
- Meldungen: „Gelesen“, „Erledigt“ (bleibt erledigt, Tombstone), „Mit Jarvis besprechen“ füllt den Composer.
- Server: Werte aus dem VPS-Snapshot (≤ 3 min alt). Unter „Server Control“: Health Check, Run Backup, Restart Mail Worker, Restart
  Jarvis Core (Restarts fragen nach). Mehr gibt es nicht – bewusst.
- Vertrieb/LEADS: in der Cloud nur Zähler; der LEADS-Dialog mit Details ist nur im LOCAL-Modus (Leads bleiben auf VPS/PC).

## 4. Gmail-Draft-Workflow
1. Im Chat: „Schreib eine Mail an name@firma.ch, Betreff …, Inhalt …“ (oder Jarvis den Text formulieren lassen und bestätigen).
2. Jarvis ruft `mail_request` mit `delivery: "draft"` auf (ohne ausdrücklichen Sendebefehl immer Entwurf; fehlt `delivery`, ist es ein
   Entwurf). Das HUD meldet „Entwurf an … übergeben … gesendet wird nur durch Sie“ und das Mail-Panel zeigt `ENTWURF · WARTET AUF MAIL-WORKER`.
3. Der VPS-Mail-Worker holt den Auftrag innerhalb von ~2 min ab, prüft Suppression/Opt-out/Duplikat und legt den Entwurf in Gmail an
   (Label JARVIS, intern `mode=COLD_LEAD_DRAFT_ONLY` → `gmail.sendDraft` verweigert jeden automatischen Versand).
4. Mail-Panel: `ENTWURF · ENTWURF IN GMAIL` (grün) mit Grund „Entwurf liegt in Gmail – senden nur durch Chris.“ Status wird alle 30 s geladen.
5. „GMAIL ENTWÜRFE“ (Link im Mail-Panel) öffnet `https://mail.google.com/mail/u/0/#drafts` – dort prüfen, anpassen, selbst senden oder verwerfen.
6. Antworten auf eigene Jarvis-Threads: Jarvis legt nur Antwort-ENTWÜRFE an; riskante Inhalte werden als Meldung „PRIORITÄT – Antwort prüfen“ eskaliert.
- Senden lassen (nur `manual_chris_mail`, nie Cold Leads): ausdrücklich „sende …“ sagen → `delivery: "send"` → der Worker prüft das
  TF-024 Legal Gate; ohne Grundlage: `blockiert` mit Grund. Jarvis behauptet nie, eine Mail sei gesendet.
- Mögliche Status: wartet auf Mail-Worker · wird verarbeitet · Entwurf in Gmail · gesendet · blockiert · fehlgeschlagen · abgelaufen (24 h).

## 5. Was ohne PC funktioniert
Chat und Gesprächsverlauf, Gmail-Entwürfe und Reply-Entwürfe, sichere Sends mit Grundlage, Mail-Queue und Status, Cold-Lead-Discovery
und Cold-Entwürfe (VPS), Suppression/Opt-out, Meldungen und Eskalationen, Scheduler (09:30/14:30, Discovery, Backup 03:00),
VPS-Status, Server Control, Backups (lokal + offsite), Shared State, AI-Status. Prüfbar ohne Passwort: `node scripts/dr-probe.mjs`.

## 6. Was optional lokal bleibt
Claude Code mit PC-Zugriff (Dateien, Programme, Web-Recherche mit Tools), Lead-Detailansicht und Cold-Draft-Buttons im HUD,
ElevenLabs-Stimme, Systemwerte des PCs, Entwicklung/Deploy (`deploy/vps/deploy.sh`, SSH). Der PC ist `role=optional_client`;
sein Mail-Worker steht im Standby (`standby_no_send_authority`). Details: `docs/JARVIS_CAPABILITY_MATRIX.md`.

## 7. Sicherheitsmodell
- Browser kennt nur das Cloud-Passwort. Gmail-Token, Anthropic-Key, Worker-/Sync-/Control-Token liegen nur auf dem VPS (`.env`, 600 root)
  bzw. in Netlify-Env und erscheinen nie in Antworten, Shared State (Whitelist + Redaction), Audit oder HUD-DOM.
- Cloud-Chat hat genau ein Werkzeug: `mail_request` (strukturierter Auftrag in die Queue). Keine Shell, kein Dateizugriff, keine Anhänge.
- Server Control: Allowlist fester Aktionen, READ nur aus dem VPS-Snapshot, CONTROL mit TTL/Lease/Cooldown (max. 6 je 10 min), Audit in
  Cloud + VPS; `reboot`, `shutdown`, `shell.exec`, `docker.exec`, Firewall, SSH, Secrets, State-/Backup-Löschung → immer 403.
  Pfade nur `/data/secrets/mail_worker`; `/opt/fiverr`, `.ssh`, `.env`, `.pem`, Gmail-Dateien gesperrt. Fehlt der Control-Token → 503 (fail closed).
- Mail: genau ein Sender (VPS, `send_authority`), Send-Locks (jede Mail genau einmal), TF-024 Legal Gate direkt vor dem Send, Limits
  09:30/14:30 je 50, 100/Tag. Human Approval kann das Legal Gate nie überschreiben. Foreign-Gmail-Schutz: nur eigene Jarvis-Threads.
- AI-Credit erschöpft → `AI SERVICE: PAUSED — CREDIT LIMIT`, nichts wird gesendet, kein Retry-Loop; Aufträge bleiben pending.

## 8. Cold-Draft-Regeln (TF-025, unverändert)
- Cold Leads sind **immer** `COLD_LEAD_DRAFT_ONLY`: `message_class=DRAFT_ONLY`, `legal_basis=NONE`, `automatic_send_eligible=false`,
  `manual_send_decision_required=true`. Kein Force-Send, kein Approval→Auto-Send, keine Queue, kein VPS-Send, kein Follow-up.
- Nur sichtbare, reproduzierbare Website-Probleme in einfacher Kundensprache (max. 2), sonst kein Entwurf. Keine Preise, keine Technik, kein Druck.
- Chris entscheidet allein in Gmail. Manueller Versand wird erkannt (`syncColdDrafts`) und erzeugt nie eine Rechtsgrundlage.
- Suppression/Opt-out (auch domainweit) sperren Entwürfe; Duplikate je Firma/Domain/Adresse ausgeschlossen (180 Tage nach Verwerfen).
- Vom Handy aus: Entwürfe in der Gmail-App prüfen/senden/verwerfen; HUD zeigt Zähler (Cold Leads, Drafts erstellt/offen/manuell versendet).

## 9. Recovery
- **Handy zeigt OFFLINE statt CLOUD:** Internet prüfen; `https://chrisjarvis.netlify.app/api/cloud` muss `{"configured":true}` liefern.
  Sonst Netlify-Env (`JARVIS_PASSWORD`, `ANTHROPIC_API_KEY`) und Deploy-Status im Netlify-Dashboard prüfen.
- **MAIL WORKER OFFLINE / QUEUE wächst:** Heartbeat des VPS älter als 5 min. Server-Panel → Jarvis Core `HEALTHY`? Wenn SERVER `ONLINE`:
  „Restart Mail Worker“, dann „Health Check“. Wenn SERVER `OFFLINE` (kein Snapshot ≤ 3 min): Container/VPS down → per SSH
  (`ssh fiverr`, nach Windows-Neustart `Start-Service ssh-agent; ssh-add`) `docker compose -f /opt/jarvis-mail/... up -d`; echter Reboot nur durch Chris.
  Aufträge gehen nicht verloren (pending bis 24 h, danach `abgelaufen` → erneut beauftragen).
- **SERVER CONTROL NICHT KONFIGURIERT:** `JARVIS_SERVER_CONTROL_TOKEN` fehlt in Netlify (Scope Functions) → setzen, „Trigger deploy“;
  Probe `/api/server-control?probe=1` → `configured=true, length=64`.
- **AI PAUSED — CREDIT LIMIT:** Anthropic-Guthaben aufladen; der Worker prüft stündlich und nimmt automatisch wieder auf.
- **Entwurf fehlt in Gmail:** Mail-Panel-Status lesen: `blockiert` (Suppression/Opt-out/ungültig) oder `fehlgeschlagen` (Gmail-Fehler,
  Worker-Log `secrets/mail_worker/worker.log` auf dem VPS). Bei `Entwurf in Gmail` in der Gmail-App unter Entwürfe/Label JARVIS suchen.
- **PC kaputt / neuer PC:** nichts Dringendes – Betrieb läuft auf dem VPS weiter. Neuer PC: `scripts/bootstrap-windows.ps1` (Prüfmodus),
  Secrets aus dem Passwort-Manager, siehe `docs/DISASTER_RECOVERY.md`. Ein leerer Client überschreibt nie den Cloud-State.
- **VPS verloren:** `docs/DISASTER_RECOVERY.md` → Neuer VPS, `scripts/restore-state.mjs` aus dem offsite-Backup (Private Key nur bei Chris).
- Lesender Gesamtcheck jederzeit vom PC: `node scripts/dr-probe.mjs` (ohne Passwort) und `node scripts/check-mail-auth.mjs`.
