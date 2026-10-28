# JARVIS – Automatischer Erst-Mail-Versand

Stand: 2026-10-28  
Projekt: `Jarvis-tf034`  
Scope: CHF 150 «Check & Anleitung» und CHF 480 «Check & Reparatur»

## Ziel

Ein berechtigter Verkäufer löst über den bestehenden CRM-Leaddrawer genau einen paketgebundenen Erst-Mail-Auftrag aus. Die Mail wird ausschließlich über die vorhandene JARVIS-Outbox, Gmail-OAuth-Sender Authority und den bestehenden Mail-Worker verarbeitet.

Der Nachweis unterscheidet strikt zwischen:

- Buttonklick und serverseitiger Annahme,
- Outbox-Auftrag,
- Gmail-Provider-Annahme,
- tatsächlicher Zustellung an `helvetic.webdesign@proton.me`.

## Nicht-Ziele und Sicherheitsgrenzen

- Keine zweite Versandarchitektur und keine direkte Gmail-API im Browser.
- Keine Abschwächung von Auth, Rollen-/Lead-Scope, DNC/Opt-out, Versandfenster, Tageslimits oder Idempotenz.
- Keine Kontaktaufnahme mit echten Kunden.
- Keine Stripe-Live-Zahlungen und keine produktiven Reparaturen.
- Keine Secrets, OAuth-Tokens oder Passwörter in Logs, Tests oder Berichten.
- Kein Owner-Override als Ersatz für eine Kontaktberechtigung.

## Autorisierte synthetische Testdaten

Für den Live-Nachweis wird ein eindeutig gekennzeichneter synthetischer TEST-Lead verwendet:

- Website: `https://praxis-kaelin.netlify.app/`
- Empfänger: `helvetic.webdesign@proton.me`
- dokumentierte Grundlage: ausdrückliche synthetische Testanfrage im Test-Lead, Scope Website-Analyse/Website-Reparatur, Testkontaktfreigabe ausschließlich für diesen Empfänger und Testlauf.

Die Testgrundlage muss durch die bestehende Permission-Engine als zulässig erkannt werden. Ein bloßes `is_test`-Flag genügt nicht.

## Architektur und Datenfluss

1. Der CRM-Button sendet `sales_intake_send` mit `lead_id` und `offer`.
2. Das Backend löst den Akteur und den Lead im zulässigen Scope auf.
3. Die Permission-Engine prüft DNC/Opt-out, Empfänger, Kontaktgrundlage und Angebotsumfang.
4. `sales-intake.js` erzeugt die passende Mail und die paketgebundene TEST-Zahlungszuordnung.
5. `mail-requests.js` schreibt idempotent in die bestehende Outbox.
6. Der bestehende Mail-Worker prüft die Outbox erneut, verwendet ausschließlich die konfigurierte Gmail-Sender Authority und meldet den Providerstatus zurück.
7. Das CRM zeigt nur den vom Worker bestätigten Status als `sent`; Annahme, Zustellung und Fehler bleiben unterscheidbar.

Für CHF 150 und CHF 480 gelten getrennte Offer-/Order-Referenzen, Mailinhalte und Idempotenzschlüssel. Ein Doppelklick darf weder einen zweiten Auftrag noch eine zweite Mail erzeugen.

## Sender- und OAuth-Prüfung

Read-only zu prüfen:

- Gmail-OAuth-Verbindung des bestehenden Mail-Workers.
- Worker-Heartbeat und Sender Authority.
- autorisierte/verifizierte Alias-Konfiguration `service@helvetic-webdesign-reparatur.ch` über das Konto `chriskaelin98@gmail.com`.
- tatsächliche Providerantwort des Gmail-Versands.

Falls eine Prüfung fehlende Zugangsdaten oder eine manuelle OAuth-/Alias-Aktion erfordert, wird der Ablauf mit dem konkreten Blocker beendet. Tokens werden nicht ausgelesen oder ausgegeben.

## Tests

### Automatisiert lokal

- getrennte CHF-150-/CHF-480-Payloads und Mailinhalte,
- Autorisierung und Lead-Scope,
- DNC-/fehlende-Berechtigung-Gates,
- Outbox-Anlage,
- Idempotenz bei Wiederholung/Doppelklick,
- Sender-/Providerstatusmodell ohne echte Netzwerkmails.

### Kontrollierter Live-Nachweis

- Live-CRM und synthetischen TEST-Lead mit Playwright MCP öffnen,
- beide Buttons tatsächlich drücken,
- Netzwerkrequest und Antwort sichern,
- Outbox und Mail-Worker-Status prüfen,
- Gmail-Annahme und Proton-Zustellung getrennt bewerten,
- keine Zahlungen auslösen.

## Abnahmekriterien

Der Nachweis ist nur erfolgreich, wenn für beide Angebote jeweils belegt sind:

- sichtbarer und berechtigter Button,
- genau ein erfolgreicher `sales_intake_send`-Auftrag,
- passende Outbox-Daten,
- Versand über `service@helvetic-webdesign-reparatur.ch`,
- Gmail-Provider-Annahme,
- eindeutiger Zustellstatus an die Testadresse oder ausdrücklich dokumentierte Nichtbestätigung.

Fehlt eine dieser Ketten, wird der jeweilige Ablauf als `BLOCKED` oder `FAIL` dokumentiert, nicht als Erfolg.
