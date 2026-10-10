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
- Vertrieb → LEADS: Kurzliste vom VPS (Firma, sichtbares Problem in Kundensprache, Kontakt, Draft-Status). Lead antippen → Details
  (Website, Kontakt, Business-E-Mail, Draft-Status, Suppression/Opt-out, Status) → „GMAIL-ENTWURF ERSTELLEN“ bzw. „ENTWURF VERWERFEN“.
  Der Button ist nur aktiv, wenn der Lead ein Cold Lead mit sichtbarem Problem und geschäftlicher Adresse ist und nicht gesperrt.
  Gesperrte Leads (Suppression/Opt-out) zeigen „GESPERRT“ – keine Aktion möglich. Es gibt keinen Sende-Knopf.

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

## 4b. Cold-Lead-Entwurf vom Handy (LEADS → Lead → „GMAIL-ENTWURF ERSTELLEN“)
1. Aktion geht als `leads.createDraft` mit genau einer `lead_id` an `/api/server-control` (Cloud-Passwort, CONTROL-Tier, Rate Limit, Audit).
2. Der VPS-Agent holt sie ab (5 s, Panel offen), prüft Suppression/Opt-out/Domain-Sperre/Duplikat/Absender und legt nur den lokalen
   Entwurf an (`individual_reviews.json`, Status „queued“, COLD_LEAD_DRAFT_ONLY, legal_basis NONE) und weckt den Worker.
3. Der Worker legt daraus den Gmail-Entwurf an (Label JARVIS) – Status „Entwurf in Gmail“, Link „IN GMAIL ÖFFNEN“.
4. Chris entscheidet allein in Gmail. Jarvis sendet nie; `gmail.sendDraft` verweigert COLD_LEAD_DRAFT_ONLY auf unterster Ebene.
- Antworten des VPS im HUD: „OK: Entwurf wird angelegt …“ oder „Abgelehnt: Empfänger hat sich abgemeldet (Opt-out).“ usw.

## 4d. Lead-Datenbank (VPS authoritative, Handy/Cloud)
- Bereich „Lead-Datenbank“: Gesamt, Heute neu, Qualifiziert, Entwürfe, Angeschrieben, Antworten, Kunden, Suppressed, Opt-out, Do-not-contact.
- ÖFFNEN: Suche (Firma, Domain, E-Mail, Kontakt, Gemeinde), Filter Kanton/Gemeinde/Status/Branche/Angebot/Monat, Schnellfilter Angeschrieben / Ohne Antwort / Mit Antwort /
  Kunden / Gesperrt, Lead antippen → Detail. EXPORT CSV (Excel, Semikolon) bzw. JSON – exportiert genau die gefilterten Leads, ohne Secrets und interne IDs.
- Die Datenbank ist ein Gedächtnis, keine Versandgrundlage: kein Sende-Knopf; angeschriebene, beantwortete, gesperrte Firmen und Kunden werden nie wieder Cold Leads.
- Auf dem VPS: `node lead-registry.js --report`, `--export csv --out /tmp/leads.csv`, `--dnc <domain>` (dauerhaft nicht kontaktieren).

## 4c. 24/7 Lead Discovery (VPS, ohne PC)
- Gebiet: die GANZE SCHWEIZ – 26 Kantone, 2110 Gemeinden (BFS), reihum je Kanton eine Gemeinde, grosse Gemeinden zusätzlich je Branche; Panel zeigt
  „Schweiz-Abdeckung“ und „Gebietsrotation“ (Zyklus, Fortschritt, zuletzt Kanton/Gemeinde).
- Läuft im VPS-Worker rund um die Uhr: alle 20 Minuten ein Lauf mit 105 Websites (315/h, harter Deckel 7500 unterschiedliche Websites/Tag, begrenzte Parallelität `maxConcurrency`).
  Für Cold-Entwürfe gibt es KEIN geschäftliches Maximum (maxDraftsPerHour/Day = null): jeder qualifizierte Lead wird persistent in die Draft-Queue
  aufgenommen (queued → draft_created). Der Draft-Worker arbeitet sie 24/7 mit technischem Pacing ab (25 je Durchlauf, 1,5 s Abstand); bei Gmail-429/5xx
  Backoff 1 → 2 → 4 … max. 60 min – nur Verzögerung, nie Verlust. Quelle (Overpass) 429/5xx/Netz: Backoff 15 → 360 min. Alles in `config.json` → `discovery`.
- Ablauf je Firma: OSM-Suche → Website-Audit → Schweiz-Check → geschäftlicher Kontakt → Dedupe (Domain, Firma, E-Mail, offener Entwurf, kontaktiert,
  Suppression/Opt-out, Kunde, Sperrfrist 180 Tage) → nur bei sichtbarem, belegtem Problem → Cold-Entwurf (Standardvorlage: erster Blick +
  vollständiger Webseiten-Check, CHF 150/480) → Gmail-Entwurf (Label JARVIS, COLD_LEAD_DRAFT_ONLY). Nie Versand.
- Panel „24/7 Discovery“ (Handy: standardmässig offen): ACTIVE/PAUSED/BACKOFF, Websites heute X / 7500, Websites diese Stunde X / 315, Neue Leads, Qualifizierte Leads, Warten auf
  Gmail-Draft, Gmail-Drafts heute erstellt, Gesamt offene Gmail-Drafts, Blockiert, Draft Worker ACTIVE/BACKOFF, Letzter Draft, Letzter Lauf (Websites), Discovery-Rate, Nächster
  Discovery-Lauf, VPS CPU/RAM, Letzter Fehler. Quick-Status: „24/7 Discovery“ und „Websites / Drafts heute“.
- Pausieren/Fortsetzen: Buttons im Panel → `discovery.pause` / `discovery.resume` (nur ein Flag auf dem VPS, Daten bleiben). Keine anderen Scheduler-Befehle.
- Nach VPS-Reboot/Container-Neustart/Netzunterbruch läuft die Discovery von selbst weiter (Docker restart unless-stopped, Zustand in Dateien, verwaistes Lock wird erkannt).

## 5. Was ohne PC funktioniert
Chat und Gesprächsverlauf, Gmail-Entwürfe und Reply-Entwürfe, sichere Sends mit Grundlage, Mail-Queue und Status, Lead-Liste und
Lead-Details, Cold-Entwurf erstellen/verwerfen, Cold-Lead-Discovery (VPS), Suppression/Opt-out, Meldungen und Eskalationen, Scheduler (09:30/14:30, Discovery, Backup 03:00),
VPS-Status, Server Control, Backups (lokal + offsite), Shared State, AI-Status. Prüfbar ohne Passwort: `node scripts/dr-probe.mjs`.

## 6. Was optional lokal bleibt
Claude Code mit PC-Zugriff (Dateien, Programme, Web-Recherche mit Tools), Lead-Detailansicht mit technischer Evidence und Entwurfstext-Edit im HUD,
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
