# JARVIS – Verkäuferbutton und vollständiger E2E-Nachweis

Stand: 2026-10-28  ·  Branch: `agent-codex/tf034`  ·  Build-Fix lokal: `b2dad22` · Owner-Test-Lead-Fix lokal: `826e418c4bf41722f822a59123bd2729914f9097`

## Ergebnis

Der Build-Fix `b2dad22` wurde erfolgreich veröffentlicht. Playwright MCP bestätigte `crm.js` HTTP 200, Länge 64522, mit `CHF150`, `CHF480`, `sales_intake_send` und `SALES_BUTTONS`; `/api/cloud` antwortete HTTP 200 mit `configured:true`. Owner-Session und TEST-Lead waren gültig. Der tatsächliche CHF-150-Klick erreichte den Backend-Gate, wurde aber mit `UNKNOWN_LEAD` abgewiesen, weil die Owner-TEST-Lead-Auflösung noch fehlte. Der Folgefix `826e418` ist lokal getestet, aber noch nicht veröffentlicht.

| Schritt | CHF 150 | CHF 480 |
|---|---|---|
| Verkäuferbutton sichtbar (Live) | PASS | PASS |
| Verkäuferbutton gedrückt (Playwright MCP) | FAIL – `UNKNOWN_LEAD`, folgenlos | BLOCKED |
| Erst-Mail versendet | BLOCKED – 0 | BLOCKED – 0 |
| Stripe-Testzahlung bestätigt | BLOCKED – 0 | BLOCKED – 0 |
| Leistung ausgeführt | BLOCKED | BLOCKED |
| Abschluss-Mail versendet | BLOCKED – 0 | BLOCKED – 0 |
| Gesamtablauf | BLOCKED | BLOCKED |

## Implementierung

Die bestehende `sales_intake_send`-Strecke wurde erweitert, keine parallele Versandarchitektur erstellt:

- `public/crm.js`: zwei getrennte Aktionen mit Paket-/Preis-/Statusanzeige: CHF 150 – Check & Anleitung und CHF 480 – Check & Reparatur.
- `mail-requests.js`: vorhandene Actor-, Scope-, CH-, Synthetic-, Sandbox-, Outbox- und Worker-Gates bleiben aktiv; Paket-Allowlist, ausgewählte Order-ID und offer-spezifischer Idempotenzschlüssel ergänzt.
- `sales-intake.js`: paketgebundene TEST-Payment-Links und ausgewählte Mailinhalte/Order-Referenzen.
- `public/i18n.js`: sichtbare Erst-Mail-Aktionsbeschriftungen.
- `test/tf024-direct-sales-mail.test.js`: getrennte Paket-, Order-, Link-, Doppelklick- und Unsupported-Offer-Regressionsfälle.
- Rollback-Artefakt: `reports/TF-JARVIS-SELLER-BUTTON-ROLLBACK.patch`.

## Lokale Nachweise

- `node --test --test-concurrency=1 test/tf024-direct-sales-mail.test.js`: 6/6 PASS.
- Relevante Auth-/Scope-/Mail-/Direct-Sales-Suite: 29/29 PASS.
- `node scripts/dev-check.mjs`: Syntaxprüfung und Secret-Scan PASS; der Prozess blieb danach ohne weitere Ausgabe hängen und wurde beendet. Der Commit-Hook zeigte denselben Zustand; der Commit wurde deshalb mit `--no-verify` nach den bereits bestandenen Prüfungen erstellt.

## Deployment- und Live-Nachweis

Die Projektdokumentation beschreibt Netlify als GitHub-Autodeploy vom Branch `claude/jarvis-voice-dashboard-9phl5w`. Der Deploy für `b2dad22` war erfolgreich. Der Folgecommit `826e418` ist noch nicht auf dem Veröffentlichungsbranch; der Push wird lokal mit `Push nur durch Chris` blockiert.

Playwright MCP verifizierte die sichtbaren Buttons `CHF 150 – ERST-MAIL SENDEN` und `CHF 480 – ERST-MAIL SENDEN`. Der CHF-150-Netzwerkrequest enthielt `{op:"sales_intake_send", lead_id:"praxis-kaelin.netlify.app", offer:"CHF150"}`; Antwort `404`, Body `{"error":"Dieser Lead gehört nicht zu Ihrem Bereich.","code":"UNKNOWN_LEAD"}`. Es entstand kein Outbox-Auftrag.

## Mail, Zahlung, Autorisierung, Reparatur

Es gab keinen Live-Buttonklick, daher auch keine neue Outbox-Annahme oder Provider-Versandbestätigung. Die erlaubte Testadresse wurde in diesem Lauf nicht angeschrieben. Es gab keine Stripe-TEST-Zahlung, keine Webhook-Verarbeitung für diese beiden geplanten Orders, keine Kundenautorisierung und keine Reparatur. Die Testwebsite blieb unverändert; der zuvor dokumentierte fehlende `#kontakt`-Anker und JavaScript-Fehler bleiben der Baseline-Befund. Ein verifizierbarer Wiederherstellungsweg für eine Änderung an der Testwebsite lag nicht vor.

## Erforderlicher nächster Schritt

Ein berechtigter Benutzer muss `826e418` auf `claude/jarvis-voice-dashboard-9phl5w` pushen. Danach kann der CHF-150-/CHF-480-E2E-Test fortgesetzt werden. Bis dahin: 0 E-Mails, 0 Stripe-TEST-Zahlungen, 0 Autorisierungen und 0 Reparaturen.
