# TF-JARVIS-024 – Phase 3 Integration

Stand: 2026-10-26  ·  Branch: `agent-codex/main`  ·  Worktree: `Jarvis-codex`

## Ergebnis

Der lokale Offer-Intent-Bundle-Ablauf ist implementiert und fail-closed getestet:

`CRM-Button → autorisierte Erstmail → persistenter Bundle → verifiziertes Stripe-Ereignis → genau ein Paket → bestehender Workflow → bestehende Abschluss-Gates`

Echte E-Mails, Zahlungen, Website-Änderungen, API-Aufrufe und Deployments wurden nicht ausgeführt.

## Funktionen

| Funktion | Status | Nachweis |
|---|---|---|
| Persistentes Bundle mit CHF 150 + CHF 480 pro Erstmail | IMPLEMENTIERT / GETESTET | `sales_intake_bundles.json`, `tf024-phase3-bundle.test.js` |
| Idempotente Offer-Intent-Zuordnung | IMPLEMENTIERT / GETESTET | Auswahl wiederholt liefert `ALREADY_SELECTED`; Gegenofferte `OFFER_CLOSED` |
| Materialisierung erst nach verifiziertem Stripe-Event | IMPLEMENTIERT / GETESTET | Betrag, Währung, `paid`, Event-Idempotenz und bestehender Ledger werden vor der Materialisierung geprüft |
| CHF-150-Auftrag | IMPLEMENTIERT / GETESTET | Bestehender `check-150-workflow.js`, 150-Bundle-Integration und `payments-041` |
| CHF-480-Auftrag | IMPLEMENTIERT / GETESTET | Bestehender `repair-workflow.js`, 480-Bundle-Integration und `repair-480-035` |
| Anzahlungs-/Restzahlungsregeln | IMPLEMENTIERT / GETESTET | CHF 75 bzw. CHF 240 unverändert; vollständiger Stripe-Link verbucht den Paketbetrag |
| Geschützter Tresor | IMPLEMENTIERT / GETESTET | Vorab nur Token-Hash im Bundle; Registrierung im bestehenden Access-Intake erst nach erfüllter CHF-480-Zahlung |
| Gegenofferte bei späterer Zahlung | IMPLEMENTIERT / GETESTET | Geschlossene Gegenofferte erzeugt `PAYMENT_REVIEW_REQUIRED`, keine Buchung und keinen Auftrag |
| CHF-150-Bericht und bestehende Abschlussmail | IMPLEMENTIERT / GETESTET | Bestehende Workflow-/Completion-Gates unverändert; Regressionstests grün |
| CHF-480-Reparatur und manuelle Produktionsfreigabe | IMPLEMENTIERT / GETESTET | Bestehender Repair-Workflow bleibt zuständig; keine neue Produktivfreigabe und kein autonomer Deploypfad |

## Wiederverwendete Komponenten

- `mail-requests.js` und `mail-worker.js` für serverseitige Berechtigung, Queue und Send-Idempotenz.
- `sales-intake.js` für die gebundene Erstmail und vorhandene Zahlungs-/Tresorlinks.
- `payments.js` und `stripe-webhook.js` für Ledger, Währung, Betrag, Signatur-Inbox und Idempotenz.
- `check-150-workflow.js` und `repair-workflow.js` für Auftragszustände, Bericht, Reparatur, Qualitätsprüfung und Abschlussmail.
- `access-intake.js` für verschlüsselte Tresorspeicherung und One-Time-Token-Registrierung.

## Geänderte Dateien

- `sales-intake-bundle.js` – neue persistente Bundle-Bindung ohne Klartextgeheimnisse.
- `mail-requests.js`, `mail-worker.js` – Bundle-Metadaten, Erstellung vor dem Erstmailversand, Schliessen bei dauerhaftem Versandfehler.
- `stripe-webhook.js` – verifizierte Offer-Auswahl und Materialisierung des gewählten bestehenden Order-Typs.
- `check-150-workflow.js`, `repair-workflow.js` – validierte vom Bundle vorgegebene Order-ID; CHF-480-Vault-Aktivierung über bestehenden Access-Intake.
- `deploy/vps/Dockerfile` – neue Bundle-Datei in der Worker-Kopielliste.
- `test/tf024-phase3-bundle.test.js` – synthetische Phase-3-Integrations- und Negativtests.
- `docs/STATUS.md` – gemeinsamer Status.
- `docs/superpowers/plans/2026-10-26-tf024-phase3-integration-design.md` – umgesetzter TDD-Plan.

## Tests

Ausgeführt:

- `node scripts/run-unit-tests.mjs test/tf024-phase3-bundle.test.js test/tf024-sales-intake.test.js test/tf081-stripe.test.js test/payments-041.test.js test/repair-480-035.test.js test/repair-quality-054.test.js`
  - **57/57 Tests erfolgreich**.
- `node --check` für alle geänderten JavaScript-Dateien – **erfolgreich**.
- `git diff --check` – **erfolgreich**.
- `node scripts/dev-check.mjs` – **CHECK OK**, Secret-Scan ohne Treffer.
- `node scripts/dev-check.mjs --full` – **nicht abschliessend**: die gezielten Phase-3-/Unit-Tests liefen bis zu den bekannten Chromium-/CRM-Rendering-Umgebungstests; dort traten die dokumentierten Browserfehler bzw. lange Timeouts auf. Der Lauf wurde beendet, damit keine weiteren externen/Browseraktionen stattfinden. Die Phase-3-Zieltests bleiben unabhängig davon 57/57 grün.

Abgedeckte Negativpfade: unbezahlter Auftrag, falscher Betrag, falsche Währung über bestehende Stripe-Tests, falsche Zuordnung, geschlossene Gegenofferte, ungültige/duplizierte Webhook-Ereignisse, fehlende Tresorverfügbarkeit, DNC/Kontaktberechtigung und bestehende Reparatur-/Completion-Fehlerpfade.

Playwright MCP war in dieser Sitzung nicht verfügbar. Es wurden daher keine neuen Browser-Screenshots erzeugt; die vorhandenen lokalen CRM-Tests und die serverseitigen Phase-2-Tests bleiben unverändert.

## Sicherheitsprüfung

- Kein Klartext-Token wird im Bundle persistiert; gespeichert wird nur `token_hash` plus Ablaufzeit.
- Kein Zugang wird vor bestätigter CHF-480-Zahlung registriert.
- Kein Auftrag wird durch einen geöffneten Zahlungslink, eine Rückkehrseite oder eine Erstmail aktiviert.
- Die geschlossene Gegenofferte wird nicht als Zahlung/Refund-Auftrag behandelt; ein späteres Ereignis geht in manuelle Prüfung.
- Bestehende Zahlungsschwellen und Ledger-Gates wurden nicht abgesenkt.
- Es wurden keine Secrets, Kundendaten oder Produktionsdateien geändert.

## Offene Punkte / Freigaben

- **OFFEN:** Der lokale Code ist nicht auf Netlify/VPS deployed; die Produktionsverbindung bleibt absichtlich ungeprüft.
- **OFFEN:** Ein echter kontrollierter Browser-E2E-Lauf mit Playwright MCP und Test-Mailbox muss in einer dafür freigegebenen Sitzung erfolgen.
- **MANUELLE FREIGABE ERFORDERLICH:** CHF-480-Produktivänderungen bleiben hinter den bestehenden Kundenfreigabe-, Backup-, Browser-, Qualitäts- und Deploy-Gates.
- **BLOCKIERT:** Keine produktive Abschlussmail oder Reparatur wurde ausgelöst, weil die verbindlichen Grenzen dieses Auftrags externe Aktionen ausschliessen.

## Produktionsbereitschaft

**Lokal testbar: JA. Produktionsbereit: NEIN, bis Chris separat Deployment, Test-Mailbox/Test-Stripe-E2E und die betrieblichen manuellen Freigaben autorisiert.**

## Git

Lokaler Commit mit Nachricht `TF-024: integrate offer intent bundles` erstellt. Kein Push, Merge oder Deployment; der genaue Hash ist im Übergabeprotokoll dokumentiert.
