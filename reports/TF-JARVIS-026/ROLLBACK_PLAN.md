# TF-JARVIS-026 – Rollback-Plan

Dieser Rollback-Plan gilt für einen späteren, ausdrücklich freigegebenen Deploymentversuch. Er wurde in TF-026 nicht ausgeführt. Er unterscheidet Code-Rollback, Konfigurationsrollback und Daten-/Auftragszustand; ein alter Code darf keinen neueren persistenten Zustand blind überschreiben.

## 1. Grundsätze

- Rollback ist komponentenbezogen; kein globales `docker compose down` und kein Neustart aller Container.
- Persistente Volumes, Queue-Einträge, Access-Tresor-Hashes, Stripe-Ledger und CRM-Daten bleiben erhalten.
- Bei unbekanntem Mail-Versandausgang niemals automatisch erneut senden.
- `app.old` und `DEPLOYED_COMMIT` sind Code-Rollback-Punkte. Sie ersetzen keine verschlüsselten Backups.
- Ein produktiver Website-Rollback ist nur Teil des bestehenden, auftragsgebundenen Repair-Workflows und darf nicht aus einem allgemeinen Infrastruktur-Rollback heraus ausgelöst werden.
- Jeder Abbruch wird mit Commit, Container-ID, Zeit, Status und Grund dokumentiert; keine Secrets oder Mailinhalte in den Bericht schreiben.

## 2. Rollback-Auslöser

Sofort anhalten und Rollback prüfen bei:

1. Healthcheck fehlgeschlagen oder Restart-Schleife;
2. falschem `DEPLOYED_COMMIT`, Image oder Service-Ziel;
3. Mail-Worker nicht mehr VPS-authoritativ;
4. Queue-/Outbox-Zähler oder Idempotenzregister unerwartet verändert;
5. `SENT` ohne bestätigten Worker-Erfolg oder möglichem Doppelversand;
6. TEST-/LIVE-Modusabweichung;
7. fehlendem Access-Link, falscher Order-/Domain-Bindung oder fehlerhaftem Ablauf;
8. DNC-/Opt-out-/Auth-/Scope-Gate nicht mehr aktiv;
9. Repair-Deploy verändert Mail-Worker, CRM oder Contacts;
10. Netlify-Function oder Healthcheck zeigt eine inkompatible Version.

## 3. Gemeinsame Sofortmaßnahmen

1. Rollout stoppen; keine weiteren Container aktualisieren.
2. Bei Mail-Problemen keine neuen direkten Mailaufträge aus CRM-Test oder Produktion anlegen.
3. Offene Claims, Queue-Zähler und Status read-only erfassen.
4. Bei unklarem Versand: Auftrag als manuell zu prüfen markieren, nicht wiederholen.
5. Container-Logs nur redigiert und ohne Secrets sichern; keine Kundendaten kopieren.
6. Freigabeinhaber informieren und entscheiden, ob nur der betroffene Dienst oder der gesamte Release zurück muss.

## 4. Netlify-Rollback

Anwendungsfall: UI, Edge oder Function nach dem Deploy fehlerhaft; VPS ist unverändert.

1. Aktuellen veröffentlichten Commit und vorherigen Netlify-Deploy dokumentieren.
2. Keine weiteren Netlify-Builds starten.
3. In der freigegebenen Netlify-Oberfläche den letzten bekannten guten Deploy veröffentlichen oder den integrierten Release-Commit per Git-Revert zurücknehmen.
4. Read-only prüfen: Startseite, CSP, Auth-Login, `/api/mail-requests` ohne Auth (`401`), sichere Health-Endpunkte.
5. CRM-Queue- und Workerstatus prüfen; ein UI-Rollback darf Queue-State nicht duplizieren.

Ein Netlify-Rollback korrigiert keinen bereits laufenden Mail-Worker und darf keine Queue-Einträge löschen.

## 5. Repair-Service-Rollback

Anwendungsfall: nur `jarvis-repair` ist fehlerhaft und der Mail-Worker-Vorher-/Nachher-Vergleich ist unverändert.

1. Repair-Aufträge nicht weiter starten; laufende Kundenaufträge entsprechend dem bestehenden Repair-State sichern.
2. Vorherigen `DEPLOYED_COMMIT`, `app.old`, Container-ID und Outbox-Zustand prüfen.
3. Den vorhandenen `deploy-repair.sh`-/`repair-remote.sh`-Mechanismus mit dem vorherigen geprüften Stand verwenden oder den vorhandenen `app.old`-Stand zurücksetzen.
4. Nur das Compose-Projekt `jarvis-repair` und nur `repair-worker` mit `--no-deps` aktualisieren.
5. Repair-Health, Chromium, Adapterstatus und Outbox prüfen.
6. Vorher-/Nachher-Probe des Mail-Workers wiederholen: ID, Startzeit, Restart-Zähler, Health, Authority und Queue dürfen sich durch den Repair-Rollback nicht verändern.
7. Auftragsstatus nur aus dem autoritativen State lesen. Keine erneute Zahlung, Access-Mail oder Abschlussmail erzwingen.

Für eine Reparatur auf einer Kundenwebsite gilt weiterhin der separate Website-Backup-/Browser-Gate-/Rollback-Mechanismus. Ein Container-Rollback stellt nicht automatisch eine Kundenwebsite wieder her.

## 6. CRM-Service-Rollback

Anwendungsfall: nur `jarvis-crm` ist fehlerhaft.

1. CRM-Schreibaktionen und CRM-Mailbutton für die Testphase pausieren.
2. Vorherigen CRM-Commit/Image und `app.old` prüfen.
3. Nur `jarvis-crm` über den vorhandenen CRM-Deploymechanismus zurücksetzen.
4. Auth, Verkäufer-Scope, DNC/Opt-out und Status-API read-only prüfen.
5. Mail-Worker und Contacts nicht neu starten.
6. Bereits eingereihte Queue-Aufträge nicht löschen; die Mail-Worker-Idempotenz entscheidet über ihren Zustand.

## 7. Mail-Worker-Rollback

Anwendungsfall: Queue-, Direct-Mail- oder Worker-Code ist fehlerhaft. Dies ist die kritischste Variante.

1. Wartungsfenster aktivieren und neue CRM-Mailaktionen kontrolliert stoppen.
2. Vorher read-only erfassen: Queue-Anzahl, `PENDING`/`PROCESSING`/`SENT`/`FAILED`/`UNKNOWN`, Claim-/Lock-Informationen, Worker-Health, Authority, Container-ID und `DEPLOYED_COMMIT`.
3. Bei `PROCESSING` oder unbekanntem Sendestatus keinen Auftrag wiederholen. Erst den Worker-/Gmail-Status und das Idempotenzregister klären.
4. Vorherigen, getesteten Mail-Commit bzw. `app.old` zurücksetzen; keine Secret-Datei ersetzen.
5. Nur das Projekt `jarvis-mail` aktualisieren. Kein globales Compose-Stoppen und keine anderen Dienste anfassen.
6. Worker-Healthcheck, Gmail-OAuth-Kategorie, VPS-Authority und Outbox-Consumer prüfen.
7. Queue nach dem Rollback erneut vergleichen. Die Anzahl darf nur durch einen nachvollziehbaren Workerabschluss verändert worden sein.
8. Einen synthetischen, ausdrücklich freigegebenen TEST-Queue-Auftrag beobachten; kein echter Empfänger.
9. Wartungsfenster erst schließen, wenn kein unbekannter Zustand und kein Duplicate-Risiko verbleibt.

Wenn der Versandausgang einer Mail nicht eindeutig bekannt ist, ist der sichere Zustand `MANUAL_REVIEW_REQUIRED`; ein automatisches Retry ist verboten.

## 8. Stripe- und Konfigurationsrollback

- Keine Live-/Test-Schlüssel rotieren oder kopieren, wenn kein gesonderter Incident-Plan vorliegt.
- Falschen Modus sofort sperren; keine Zahlungen erneut einziehen.
- Webhook-Zustand und Event-Idempotenz erhalten.
- Bei falschem Betrag, falscher Währung, falscher `order_id` oder Modus-Mismatch bleibt der Ledger unverändert bzw. in Prüfung.
- Netlify- und VPS-Konfiguration nur auf zuvor verifizierte, passende TEST-/LIVE-Werte zurücksetzen.
- Ein Konfigurationsrollback darf nicht `JARVIS_SALES_SANDBOX_MODE` verwenden, um die Produktionssperre des CRM-Buttons zu umgehen.

## 9. Persistenz und Datenverlustschutz

Nicht zurücksetzen oder löschen:

- Mail-Queue und Worker-Idempotenzregister;
- Gmail-/Mail-Worker-State und Send-Locks;
- CRM-Daten und DNC-/Opt-out-/Suppression-Register;
- Stripe-Ledger und Webhook-Eventregister;
- Access-Token-Hashes, Ablaufzustände und abgeschlossene Vault-Zerstörung;
- Repair-State, Outbox und Website-Backup-Referenzen.

Falls eine State-Schema-Inkompatibilität festgestellt wird, Rollback stoppen und zuerst die vorhandene Disaster-Recovery-Anleitung für einen additiven Restore in ein neues Verzeichnis anwenden. Kein Überschreiben bestehender produktiver Verzeichnisse.

## 10. Nachweis nach dem Rollback

Der Rollback gilt erst als beendet, wenn alle folgenden Punkte dokumentiert sind:

- betroffene Komponente meldet den vorherigen geprüften Commit;
- Healthcheck grün, keine Restart-Schleife;
- Mail-Authority und Worker-Heartbeat korrekt;
- Queue-/Outbox-Zähler und Idempotenzregister plausibel;
- keine neue doppelte Mail und kein doppelter Stripe-Ledger-Eintrag;
- Auth, Scope, DNC, Opt-out, TEST/LIVE-Trennung und Access-Gates aktiv;
- synthetischer Smoke-Test erfolgreich oder sauber `BLOCKED`/`MANUAL_REVIEW_REQUIRED`;
- verbleibende Aufträge und unklare Zustände an Chris übergeben;
- keine Kundenaktion und kein echter Versand ohne separate Freigabe.

## 11. Abbruch des Rollbacks

Wenn der vorherige Stand nicht eindeutig identifiziert werden kann, ein Container-Fingerprint nicht passt, ein Backup fehlt, ein Sendestatus unbekannt ist oder ein Rollback neue Änderungen am falschen Dienst auslösen würde, wird nicht weiter automatisiert. Der Status bleibt `BLOCKED`; es folgt manuelle Incident-/DR-Prüfung.
