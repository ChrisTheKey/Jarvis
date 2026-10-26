# TF-JARVIS-026 – Kontrollierter Deployment-Plan

Dieser Plan beschreibt einen späteren, ausdrücklich freizugebenden Rollout. Er wurde in TF-026 nicht ausgeführt. SSH, Netlify-Deployment, Docker-Builds auf dem VPS, Container-Restarts, Live-Mail und Live-Zahlungen bleiben ausgeschlossen.

## 1. Freigabegrenzen und Release-Identität

Der aktuelle Codex-Commit `9536355` ist ein Kandidat für die Integration, aber noch nicht der freigegebene Produktions-Commit. Die Release-ID darf erst nach dem Merge in `claude/jarvis-voice-dashboard-9phl5w`, der Konfliktprüfung und einem erneuten vollständigen Gate festgelegt werden.

Vor jedem Deploy muss eine unveränderliche Release-Tabelle vorliegen:

| Feld | Pflichtnachweis |
|---|---|
| Release-Commit | vollständiger Git-SHA nach Integration |
| Quellbranch | integrierter Branch, kein Agenten-Worktree |
| Teststatus | `dev-check --full`, Secret-Scan, Release-Gates; Docker-Labs nicht übersprungen |
| Zielkomponenten | Netlify, Mail, Repair, CRM – jeweils begründet |
| Rollback-Commit | vorheriger tatsächlich laufender und getesteter Stand |
| Freigaben | Integration, Serverprüfung, Deploy, ggf. Mail-/Stripe-/Live-Test getrennt |

Ein lokaler Agenten-Commit darf nicht direkt als Produktionszustand bezeichnet werden.

## 2. Integrationsstrategie

Die Integration erfolgt nur im Hauptcheckout durch Chris. Es gibt keinen automatischen Merge in diesem Worktree.

1. Hauptcheckout und fremde WIP-Dateien sichern.
2. Codex-Branch gegen `claude/jarvis-voice-dashboard-9phl5w` diffen.
3. `docs/STATUS.md` manuell zusammenführen.
4. Die neuere Integrationsänderung in `scripts/run-unit-tests.mjs` erhalten und gegen die TF-024/TF-025-Tests ausführen.
5. Fachlich prüfen, dass die TF-024/TF-025-Änderungen weder die zentrale Capability-Gate-Logik noch DNC, Opt-out, Auth, Scope, Zahlungs-Gates, Browser-Gates oder die Entfernung autonomer Calling-Pfade überschreiben.
6. Nur die ausdrücklich integrierten, geprüften Dateien committen.

Git-Automatik ist kein Ersatz für die Prüfung der Runtime-Trennung: Ein automatisch gemergtes Dockerfile kann syntaktisch gültig sein und trotzdem einen falschen Import oder ein falsches Secret-Mount enthalten.

## 3. Voraussetzungen vor der Serverprüfung

Alle folgenden Punkte müssen vor einem Schreibdeploy erfüllt sein:

- ausdrückliche Freigabe des Release-Commits;
- saubere Integrationshistorie und kein unaufgelöster Konflikt;
- `node scripts/dev-check.mjs --full` mit Exit 0;
- Secret-Scan ohne Treffer;
- alle verpflichtenden Release-Gates inklusive der Docker-Labs mit `JARVIS_REPAIR_LAB=1` in einer isolierten Testumgebung;
- Docker-Image-Prüfung für alle importierten Runtime-Module und Chromium nur im Repair-Image;
- bestätigtes Backup, Restore-Nachweis und mindestens 10 GB freier VPS-Speicher, besser 20 GB;
- Mail-Worker gesund, VPS als einzige Senderautorität, keine unbekannten `PROCESSING`-/Send-Status;
- kein laufender kritischer Claim und keine unklare Zustellung;
- TEST und LIVE getrennt und für die gewählte Umgebung eindeutig erkennbar;
- kein produktiver CRM-Direktversand, solange die separate Produktionsfreigabe dafür fehlt.

## 4. Read-only-Serverprüfung (später, nicht in TF-026 ausgeführt)

Die folgenden Muster sind nur für eine ausdrücklich erlaubte, read-only Prüfung auf dem Zielsystem dokumentiert. Platzhalter müssen durch Chris bzw. den autorisierten Betreiber ersetzt werden. Keine Ausgabe darf Secret-Werte enthalten.

```text
ssh <freigegebener-host> "sudo docker ps --format '{{.Names}} {{.Image}} {{.Status}}'"
ssh <freigegebener-host> "sudo docker inspect jarvis-mail-mail-worker-1 --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}'"
ssh <freigegebener-host> "sudo docker inspect jarvis-repair-repair-worker-1 --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}'"
ssh <freigegebener-host> "sudo docker inspect jarvis-crm-crm-worker-1 --format '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}'"
ssh <freigegebener-host> "cd /opt/jarvis-repair && sudo node production-readiness.js --no-launch"
ssh <freigegebener-host> "sudo bash /opt/jarvis-repair/tf082-inspect.sh"
ssh <freigegebener-host> "sudo bash /opt/jarvis-repair/tf082-preflight.sh"
```

Die beiden TF-082-Skripte dürfen nur im defaultmäßigen Read-only-Modus laufen; `--apply` ist außerhalb dieser Phase und ohne separate Freigabe verboten. `scripts/check-mail-auth.mjs` und `scripts/dr-probe.mjs` sind ebenfalls nur mit dafür freigegebenen, nicht auszugebenden Credentials vorgesehen.

Bei dieser Prüfung werden nur Status, Zähler, Modus und Health-Kategorien dokumentiert. Nicht ausgeben: `.env`, OAuth-Dateien, Worker-Token, Stripe-Schlüssel, private Schlüssel, Mailinhalte, Empfängeradressen oder Kundendaten.

## 5. Backup und persistente Daten

Vor Schreibzugriffen muss der Betreiber anhand der vorhandenen DR-Struktur nachweisen:

- aktuelles verschlüsseltes Backup von Operational State;
- Offsite-Backup vorhanden und Generation innerhalb der vereinbarten Frist;
- Restore-Test in ein neues leeres Verzeichnis erfolgreich oder explizit manuell freigegeben;
- `/opt/jarvis-mail/secrets` und Mail-State geschützt;
- `/opt/jarvis-repair/state`, `/opt/jarvis-repair/outbox` und `/opt/jarvis-repair/crm-export` geschützt;
- `/opt/jarvis-mail/data` und Netlify-Blobs nicht überschrieben;
- keine State-Rücksetzung auf einen älteren Code ohne Schema-/Kompatibilitätsprüfung.

Die Deploy-Skripte halten zusätzlich `app.old` und `DEPLOYED_COMMIT`. Diese Artefakte sind Rollback-Hilfen für den Code, aber kein Ersatz für ein Datenbackup.

## 6. Zu deployende Komponenten und Reihenfolge

### Phase A – Netlify nach Integration

Nur wenn `public/`, Functions oder `netlify.toml` im Release enthalten sind:

1. Build aus dem integrierten Release-Commit.
2. Prüfen, dass die Function-Routen `/api/mail-requests`, `/api/access-intake`, `/api/payments` und Auth-/CSRF-Header unverändert geschützt bleiben.
3. Netlify-Deploy erst nach separater Freigabe.
4. Veröffentlichte Commit-ID und Function-Status notieren.

Netlify darf nicht als erfolgreich betrachtet werden, nur weil ein lokaler Build erfolgreich ist.

### Phase B – Repair-Service, falls erforderlich

Wenn nur Repair-Code betroffen ist, `deploy/vps/deploy-repair.sh` mit dem freigegebenen Host verwenden. Der vorhandene Remote-Guard:

- schreibt nur unter `/opt/jarvis-repair`;
- baut/startet nur `repair-worker` mit `--no-deps`;
- prüft vor/nachher Mail-Worker-ID, Startzeit, Restart-Zähler, Health, Heartbeat, Authority und Queue;
- bricht ab, wenn der Mail-Worker verändert wurde.

`jarvis-mail`, `jarvis-crm`, `jarvis-contacts` und VN-Dienste bleiben unverändert.

### Phase C – CRM-Service, falls erforderlich

Nur wenn der integrierte Diff Runtime-Dateien des CRM-Dienstes enthält:

1. `deploy-crm.sh <host> build`;
2. Healthcheck und Diff prüfen;
3. `deploy-crm.sh <host> start`;
4. nur `jarvis-crm` prüfen, keine globale Compose-Aktion.

Der CRM-Service bekommt keine Gmail-Schreibrechte und keine Mail-Secrets als Schreibmount.

### Phase D – Mail-Worker, falls Queue-/Direct-Mail-Code betroffen ist

Der Mail-Worker ist die sensible Phase. `deploy/vps/deploy.sh` darf nur in einem freigegebenen Wartungsfenster verwendet werden, weil das Mail-Projekt neu gebaut/gestartet werden kann.

1. Queue- und Claim-Zustand read-only erfassen.
2. Keine neuen schreibenden CRM-Mailaktionen während des Wartungsfensters zulassen.
3. Nur den freigegebenen Release-Commit archivieren.
4. Kein `--with-secrets`, außer eine separate Secret-Migration wurde geprüft und freigegeben.
5. Das Mail-Projekt gezielt aktualisieren; keine anderen Compose-Projekte neu starten.
6. Healthcheck `node mail-worker.js --healthcheck`, Gmail-OAuth-Kategorie und VPS-Authority prüfen.
7. Queue erneut erfassen und auf keine neuen Duplikate prüfen.

Für TF-024 ist wichtig: Ein Repair-Deploy allein aktualisiert den Mail-Worker nicht. Umgekehrt darf ein Mail-Deploy nicht als Rechtfertigung dienen, den aktuellen Sandbox-Gate des CRM-Buttons zu entfernen.

### Phase E – unverändert lassen

Contacts, VN, Calling, lokale Windows-Dienste, Produktionssecrets, Stripe-LIVE-Keys und bestehende Kundendaten werden in TF-026 nicht verändert.

## 7. Healthchecks und Smoke-Tests

Nach jeder betroffenen Komponente:

1. Containername, Image-Tag/Digest, `DEPLOYED_COMMIT`, Health und Restart-Zähler prüfen.
2. Bei Mail: Worker-Authority VPS, OAuth-Kategorie, Outbox-Consumer und Queue-Zähler prüfen.
3. Bei Repair: Repair-Health, Browser-Verfügbarkeit, Adapterstatus, Outbox und Mail-Heartbeat prüfen.
4. Bei CRM: Auth, Seller-Scope, DNC/Opt-out und Status-API prüfen.
5. Bei Netlify: Startseite und sichere read-only Health-/Status-Endpunkte prüfen; keine Schreibaktion aus einem Smoke-Test.
6. Nur mit synthetischen Daten: einen TEST-Queue-Auftrag mit eindeutiger Idempotenz prüfen, einen Worker-Lauf beobachten, Status zurücklesen und genau einen Ergebniszustand nachweisen.
7. Keine echte Kundenadresse, keine Live-Zahlung und keine echte Website verwenden.

Ein erfolgreicher Queue-Insert ist nicht gleichbedeutend mit `SENT`. Der CRM-Button darf erst nach einem autoritativen Worker-Ergebnis „Gesendet“ anzeigen.

## 8. Kontrollierter Testplan nach dem Deploy

### A. CRM-Mailbutton

- synthetischer `is_test`-Lead, eigener Testempfänger nur mit separater Freigabe;
- Lead öffnen, Button oben links prüfen;
- genau ein Klick, keine Vorschau und kein zweiter Bestätigungsdialog;
- Empfänger serverseitig aus dem Lead, nicht aus dem Browserpayload;
- Button zeigt `Wird gesendet`, danach ausschließlich den Workerstatus;
- Doppelklick und Reload erzeugen keinen zweiten Queue-Eintrag;
- DNC, Opt-out, fehlende Berechtigung, fehlender/abgelaufener Access-Link blockieren.

Der aktuelle Pfad bleibt bis zu einer gesonderten Produktionsentscheidung TEST-only. Ein Test an einem echten Kunden ist ausgeschlossen.

### B. CHF 150

- synthetischer TEST-Auftrag;
- Stripe-Testmodus, signiertes TEST-Ereignis, exakter Betrag CHF 150;
- Zuordnung über die konkrete `order_id`, keine Doppelbuchung bei Wiederholung;
- Check-/Berichtspfad ausführen, kein Website-Write;
- Test-Abschlussmail nur über Test-Outbox/Testpostfach;
- Testauftrag bleibt außerhalb Umsatz und Provision.

### C. CHF 480

- synthetischer TEST-Auftrag;
- Stripe-Testzahlung bis zur vorgesehenen Schwelle und danach vollständige TEST-Zahlung;
- individueller, einmaliger Access-Link, richtiger Auftrag/Domain, Ablaufprüfung;
- Test-Vault, Backup, Browser-Gate und simulierte Reparatur auf Sandbox-Domain;
- Validierung, Retest und Test-Abschlussmail;
- Vault-Geheimnis nach Abschluss zerstören; kein Zugriff auf eine echte Website.

### D. Fehler- und Abbruchfälle

- Worker offline: Queue bleibt offen, kein `SENT`;
- Gmail-/Stripe-/Browser-Fehler: sichere Kategorie, kein falscher Erfolg;
- unbekannter Versandausgang: kein automatischer zweiter Versand;
- DNC/Opt-out/Scope-/Domain-Mismatch: fail closed;
- Health-/Commit-/Backup-Abweichung: Rollout abbrechen.

## 9. Abbruchkriterien

Der Rollout wird sofort angehalten bei:

- anderem Commit als freigegeben;
- Mergekonflikt oder unklarer Dateizugehörigkeit;
- fehlendem/zu altem Backup oder weniger als 10 GB freiem Speicher;
- Queue-Aufträgen in unbekanntem Zustand;
- Worker nicht gesund, falscher Authority oder geänderter Container-ID bei einem fremden Service;
- TEST/LIVE-Modusabweichung;
- fehlendem Access-Link, falscher Domain- oder Auftragsbindung;
- wiederholtem/unklarem Sendestatus;
- unerwartetem Secret-Mount, Docker-Socket oder zusätzlichem Service;
- jedem echten Empfänger oder jeder nicht freigegebenen externen Aktion im Test.

Bei einem Abbruch keine automatische Retry-Schleife und kein blindes Zurücksetzen persistenten States. Der Betreiber wechselt in den ROLLBACK_PLAN.
