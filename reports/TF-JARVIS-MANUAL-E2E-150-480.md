# JARVIS – Manual E2E Acceptance Test CHF 150 / CHF 480

Stand: 2026-10-28  
Projektstand: Branch `agent-codex/tf034`, HEAD `5a0c6f8`  
Testwebsite: `https://praxis-kaelin.netlify.app/`  
Autorisierte Testadresse: `helvetic.webdesign@proton.me`

## Gesamtstatus

**BLOCKED**

Die verpflichtende Playwright-MCP-Baseline wurde ausgeführt. Der externe Verkaufs-, Mail- und Repair-End-to-End-Lauf wurde sicher nicht gestartet, weil in diesem Worktree kein autorisiert erreichbarer JARVIS-API-/Mail-Worker-/Repair-Service-Endpunkt und keine nutzbare Test-Authentifizierung vorlagen. Es wurden keine Zugangsdaten gelesen oder erfunden, keine E-Mail versendet, keine Stripe-Zahlung bestätigt und keine Websiteänderung ausgelöst.

## Baseline mit Playwright MCP

Ausgeführt auf Desktop 1440×900 und Mobile 390×844:

- Startseite HTTP 200, Titel `Praxis Kälin Psychiatry`.
- Bilder geladen: 2/2 mit `naturalWidth=1024`.
- Kein horizontaler Overflow in der Mobile-Ansicht.
- Navigation und Kontaktformular wurden im Accessibility-Snapshot gefunden.
- Reproduzierbarer Browserfehler auf Desktop und Mobile: `TypeError: Cannot set properties of null (setting 'textContent')`, Zeile 644 der Website.
- Defekter interner Anker: `#kontakt` verweist auf kein vorhandenes Element.
- Zusätzlich wurde die Produktionswarnung für `cdn.tailwindcss.com` protokolliert.

Da der Ausgangszustand bereits relevante Fehler enthielt, wurde kein zusätzlicher kontrollierter Testfehler erzeugt. Eine sichere Änderung und Wiederherstellung war ohne autorisierten JARVIS-/Netlify-Repair-Weg nicht nachweisbar.

## CHF 150 – Check & Anleitung

| Prüfschritt | Ergebnis |
|---|---|
| Synthetischer Auftrag angelegt | NEIN – kein autorisierter JARVIS-Endpunkt erreichbar |
| Erstmail versendet | NEIN |
| Empfänger geprüft | NICHT AUSGEFÜHRT |
| Stripe-Testcheckout geprüft | JA, Seite lesend geöffnet; keine Zahlung ausgelöst |
| Zahlung bestätigt / Ledger | NEIN |
| Website geprüft | JA, Playwright-Baseline |
| Anleitung erstellt | NEIN – kein echter Auftrag/Workflow gestartet |
| Abschlussmail versendet | NEIN |
| Keine Reparatur ausgeführt | JA |

Nachweis der Checkout-Seite: `reports/manual-e2e-150-480/chf150-checkout.png`.

## CHF 480 – Check & Reparatur

| Prüfschritt | Ergebnis |
|---|---|
| Unabhängiger Auftrag angelegt | NEIN – kein autorisierter JARVIS-Endpunkt erreichbar |
| Kontrollierter Testfehler | NEIN – Baseline enthielt bereits Fehler; keine Änderung ausgelöst |
| Erstmail versendet | NEIN |
| Stripe-Testcheckout geprüft | JA, Seite lesend geöffnet; keine Zahlung ausgelöst |
| Vollzahlung CHF 480 bestätigt | NEIN |
| CHF 240 als Vollzahlung akzeptiert | NEIN / nicht geprüft |
| Kundenautorisierung | NEIN |
| Backup | NEIN – keine Websiteänderung |
| Reparatur ausgeführt | NEIN |
| Reparatur validiert | NEIN |
| Abschlussmail versendet | NEIN |

Nachweis der Checkout-Seite: `reports/manual-e2e-150-480/chf480-checkout.png`.

## Abschliessende Websiteprüfung

Die Website blieb unverändert. Der abschliessende Playwright-MCP-Lauf bestätigte weiterhin HTTP 200, geladene Bilder und keinen Mobile-Overflow, aber auch weiterhin den JavaScript-Fehler und den fehlenden `#kontakt`-Anker. Daher:

- Ausgangszustand gesichert: JA, Screenshots und technische Logs vorhanden.
- Abschliessender Playwright-Test bestanden: NEIN.
- Website vollständig funktionsfähig: NEIN.
- Testfehler vollständig beseitigt: NEIN.
- Wiederherstellung erforderlich: NEIN, weil keine Änderung vorgenommen wurde.

## E-Mail- und Zahlungsnachweise

Tatsächlich versendete E-Mails: **0**.  
Tatsächlich bestätigte Stripe-Testzahlungen: **0**.  
Auftrags-IDs, Worker-Versandzeitpunkte und Ledger-Referenzen: **keine**, da kein autorisierter Live-Testlauf gestartet wurde.

Die lokalen synthetischen Regressionstests `test/praxis-kaelin-final.test.js` und `test/praxis-kaelin-mail.test.js` bestanden separat mit **8/8**. Sie sind kein Ersatz für den hier geforderten externen manuellen E2E-Nachweis.

## Nachweise

Ordner: `reports/manual-e2e-150-480/`

- `baseline-desktop.png`, `baseline-mobile.png`
- `baseline-console.log`, `baseline-network.log`
- `baseline-desktop.yml`, `baseline-mobile.yml`, `baseline-metrics.json`
- `chf150-checkout.png`, `chf150-checkout.yml`
- `chf480-checkout.png`, `chf480-checkout.yml`
- `final-mobile.png`

## Blocker und nächster Schritt

Für eine erneute Abnahme ist eine kontrollierte, autorisierte JARVIS-Umgebung mit erreichbarer API, Mail-Worker, Repair-Service, Test-Authentifizierung und signiertem Stripe-TEST-Webhook erforderlich. Danach muss zuerst der Baseline-Fehler geklärt oder durch den autorisierten Repair-Ablauf nachweislich behoben und mit Playwright MCP erneut validiert werden. Bis dahin bleibt der manuelle E2E-Test **BLOCKED**.

Keine produktive Website, kein produktiver Container, kein Live-Payment und kein E-Mail-Versand wurden verändert oder ausgelöst.
