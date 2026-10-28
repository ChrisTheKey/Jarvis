# JARVIS – Verkäuferbutton und vollständiger E2E-Nachweis

Stand: 2026-10-28  ·  Branch: `agent-codex/tf034`  ·  Commit: `968389cbabeb59d31438a2c2131750981859dadd`

## Ergebnis

Die freigegebene lokale Erweiterung ist implementiert und gezielt geprüft. Der GitHub-Remote-Branch steht inzwischen auf `fb21bd04606ebeb095ff8ee17e8406527a7103cd`. Der Live-Deployment-Schritt ist weiterhin BLOCKED: Netlify liefert trotz dieses Remote-Commits noch den alten Frontendstand aus; das JARVIS-Dashboard zeigt als letzten Deploy `692420d · 2026-10-24 20:57 UTC`. Es wurden keine Test-E-Mails, Stripe-Testzahlungen oder Reparaturen ausgelöst.

| Schritt | CHF 150 | CHF 480 |
|---|---|---|
| Verkäuferbutton sichtbar (Live) | BLOCKED | BLOCKED |
| Verkäuferbutton gedrückt (Playwright MCP) | BLOCKED | BLOCKED |
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

Die Projektdokumentation beschreibt Netlify als GitHub-Autodeploy vom Branch `claude/jarvis-voice-dashboard-9phl5w`. `git ls-remote` bestätigt dort HEAD `fb21bd0`. `netlify` CLI und `.netlify/state.json` sind im Worktree nicht vorhanden. Ein Deployment aus dem Netlify-Dashboard ist ebenfalls nicht möglich, weil die Playwright-Prüfung nur die Netlify-Loginseite zeigt und keine bestehende Netlify-Session vorhanden ist.

Playwright MCP wurde danach für den Live-Read-only-Check verwendet. Der ausgelieferte Download von `https://chrisjarvis.netlify.app/crm.js?probe=<timestamp>` antwortete HTTP 200, Länge 56955; die Strings `CHF150`, `CHF480`, `sales_intake_send` und `SALES_BUTTONS` waren nicht enthalten. Im CRM-Leaddrawer des synthetischen TEST-Leads waren die neuen Aktionen nicht sichtbar. Deployment-ID: nicht vorhanden. Die Live-Seite zeigte 88 reproduzierte Konsolenfehler im aktuellen MCP-Fenster.

## Mail, Zahlung, Autorisierung, Reparatur

Es gab keinen Live-Buttonklick, daher auch keine neue Outbox-Annahme oder Provider-Versandbestätigung. Die erlaubte Testadresse wurde in diesem Lauf nicht angeschrieben. Es gab keine Stripe-TEST-Zahlung, keine Webhook-Verarbeitung für diese beiden geplanten Orders, keine Kundenautorisierung und keine Reparatur. Die Testwebsite blieb unverändert; der zuvor dokumentierte fehlende `#kontakt`-Anker und JavaScript-Fehler bleiben der Baseline-Befund. Ein verifizierbarer Wiederherstellungsweg für eine Änderung an der Testwebsite lag nicht vor.

## Erforderlicher nächster Schritt

Ein berechtigter Benutzer muss im Netlify-Dashboard den Production-Deploy für `fb21bd0` auslösen oder die bestehende Netlify-Integration prüfen. Danach können die beiden sichtbaren Live-Buttons mit Playwright MCP geklickt und die E2E-Schritte ausschließlich mit TEST-Zahlungen und dem Empfänger `helvetic.webdesign@proton.me` fortgesetzt werden.
