# TF-JARVIS-025 – Produktionsbereitschaft

Stand: 2026-10-26
Worktree: `C:\Users\Administrator\Documents\Chris\Jarvis-codex`
Branch: `agent-codex/main`

Lokaler Abschlusscommit: siehe `git log -1 --oneline` im Worktree (`fix(tf025): report worker status and preserve order lead`)

## Ergebnis

Der lokale synthetische Prüfstand ist grün. Der Produktionsstatus bleibt **BLOCKED**, weil echte Kunden-E-Mails, Live-Zahlungen und Deployment ausdrücklich nicht ausgeführt wurden und weiterhin eine separate Produktionsfreigabe benötigen.

## Bestandsaufnahme

- `3d5efde` (`feat(tf024): add sandbox CRM mail button`) ist vorhanden.
- `10bbf70` (`fix(tf024): include bundle in repair image`) ist vorhanden.
- Vor dem neuen Commit war `agent-codex/main` mit `origin/agent-codex/main` synchronisiert.
- Bestehende uncommittete Dateien wurden geschützt und nicht gestaged: `test/crm-fixture.js` sowie `reports/TF-JARVIS-024/phase5-screenshots/`.

## Fehleranalyse und Korrekturen

1. `browser-audit-praxis002`: Der isolierte Engine-End-to-End-Test läuft mit dem vorhandenen Chromium (`JARVIS_CHROMIUM_PATH`) erfolgreich. Der Befund war umgebungs-/Ressourcen-abhängig, keine TF-025-Regression.
2. `browser-validation-045`: Der gezielte Link-/Bild-Test läuft mit dem vorhandenen Chromium erfolgreich. Keine Produktregression.
3. `crm-browser-053`: Die gezielten Browserfälle laufen mit dem vorhandenen Chromium erfolgreich. Die frühere Abweichung war ein Vollsuite-/Ressourcenproblem; es wurden keine Assertions und keine Timeouts gelockert.
4. `vn-order-064`: Echter Datenflussfehler behoben. `applyOrderRequest` reichte `lead_id` beim CHF-150-Check-Auftrag nicht an `createCheck150Order` weiter. Der minimale Fix stellt die Lead-Zuordnung her.
5. CRM-Mailstatus: Nach dem Einreihen blieb ein lokaler „queued“-Hinweis gegenüber dem späteren Worker-Status vorrangig. `public/crm.js` zeigt jetzt den autoritativen Serverstatus (`sent`, `failed`, `blocked`, `expired`) vor dem lokalen Fehler-/Queue-Hinweis. Berechtigungs-, DNC-, Opt-out- und Idempotenzprüfungen wurden nicht verändert.

## Tests

| Prüfung | Ergebnis | Exit |
|---|---:|---:|
| TF-024 direkte CRM-Mailtests, Bundle, Legacy, Service-Separation, VN-Order | 52/52 bestanden | 0 |
| Isolierter TF-024-Browserlauf (Desktop, Mobile, Reload, Workerstatus) | 1/1 bestanden | 0 |
| Synthetischer CHF-150-E2E-Lauf (`tf088`) | 1/1 bestanden | 0 |
| Synthetischer CHF-480-E2E-Lauf (`tf080`) | 1/1 bestanden | 0 |
| Vollcheck `node scripts/dev-check.mjs --full` | 1180 bestanden, 0 fehlgeschlagen, 12 übersprungen (1192 Tests) | 0 |

Der Browserlauf bestätigt: Lead öffnen → „Mail senden“ → genau ein idempotenter Queue-Auftrag → kein Vorschau-/Bestätigungsdialog → Workerstatus → Reload → kein zweiter Auftrag. Desktop und Mobile wurden geprüft.

## Sicherheitsprüfungen

Der Vollcheck bestätigte Authentifizierung, Verkäufer-Scope, DNC/Opt-out, Versandgrundlage, Queue-/Worker-Idempotenz, Test-/Live-Trennung, One-Time-Zugang, Ablaufdaten, Stripe-TEST-Gates, Docker-Image-Abhängigkeiten und Secret-Scan. Es wurden keine Sicherheitsprüfungen deaktiviert und keine Live-Adapter verwendet.

## Screenshots

- `reports/TF-JARVIS-025/screenshots/tf024-direct-desktop-before.png`
- `reports/TF-JARVIS-025/screenshots/tf024-direct-desktop-queued.png`
- `reports/TF-JARVIS-025/screenshots/tf024-direct-desktop-reloaded.png`
- `reports/TF-JARVIS-025/screenshots/tf024-direct-mobile-queued.png`

## Änderungen

- `order-intake.js`
- `public/crm.js`
- `public/i18n.js`
- `test/tf024-phase5-browser.test.js`
- `docs/STATUS.md`
- neue synthetische Browser-Screenshots unter `reports/TF-JARVIS-025/screenshots/`

Keine echte E-Mail, keine echte Zahlung, keine Kundenwebsite, kein SSH, kein Deployment und kein Push wurden ausgeführt.

Der GitHub-Push ist **NEIN**: Die vorhandene `.githooks/pre-push`-Regel sperrt Pushes aus Agenten-Worktrees. Es wurde kein Hook umgangen und kein Force-Push versucht. Der Remote-Branch steht daher weiterhin auf `10bbf70`; Chris kann den lokalen Commit `a8dbf60` aus einem erlaubten Checkout normal pushen.

## Verbleibender Blocker / nächster Schritt

**BLOCKED:** Chris muss den lokalen Commit prüfen und gemäss Push-Schutzregel normal auf `origin/agent-codex/main` pushen. Für den Produktivbetrieb ist danach eine separate Freigabe mit Live-Konfiguration und kontrolliertem Live-Nachweis erforderlich. Bis dahin bleibt der direkte Produktionsversand gesperrt.
