# JARVIS TF-034 – Final Production Readiness

Stand: 2026-10-27  
Branch: `agent-codex/tf034`  
Basis: TF-033 `fda4094`  
Deployment: nicht ausgeführt; kein Push und kein Merge.

## Ergebnis

**Status: BLOCKED**

Die lokale Zahlungs- und Reparaturlogik ist für die verpflichtenden synthetischen Prüfungen grün. Produktionsbereitschaft kann nicht als freigegeben gelten, weil die zwölf Docker-Labs nicht ausgeführt werden durften und kein Playwright-MCP in der aktuellen Sitzung exponiert war.

## Änderungen

- `createRepairEngine` verwendet nun in allen Reparaturpfaden `fullPaymentGateForOrder`. CHF 240 schaltet weder Zugang noch Reparatur frei.
- CHF 150 bleibt im getrennten Check-/Anleitungs-Workflow ohne automatische Website-Reparatur.
- CHF 150 plus verifiziertes CHF-330-Upgrade ergibt über die bestehende Quellauftrags-Gutschrift genau CHF 480; doppelte Zahlungsreferenzen und Rückerstattungen bleiben fail closed.
- Historische synthetische Reparatur-Fixtures wurden auf die Vollzahlungsregel angepasst.
- Zwei TF-034-Regressionstests decken Legacy-Blockierung, Upgrade-Zuordnung, Idempotenz und Rückerstattung ab.

## Tests

- Ausgangsstand TF-033 verifiziert: 1'213 Tests, 1'201 bestanden, 0 fehlgeschlagen, 12 übersprungen; Commit `fda4094`.
- TF-034 nach Änderung: **1'215 Tests, 1'203 bestanden, 0 fehlgeschlagen, 12 übersprungen**.
- `node scripts/dev-check.mjs` und Secret-Scan: bestanden.
- Lokales Chromium für Browser-Fixtures vorhanden und mit `JARVIS_CHROMIUM_PATH`/`CHROME_PATH` verwendet.
- Synthetische E2E-Nachweise: CHF 150, CHF 480, CHF 330-Upgrade, CHF 479 blockiert, CHF 480 freigeschaltet, Refund/Chargeback-relevante Gates, sicherer Zugang, WordPress, GitHub/Netlify, SFTP/SSH, Backup, Rollback, Geheimnisschutz und idempotente Verarbeitung.

## Docker-Labs

Die statische Prüfung bestätigt eigene Lab-Labels, eigene Netzwerke und Volumes, loopback-gebundene Ports, synthetische Laufzeitdaten, keine Produktions-Mounts sowie label-beschränkte Cleanup-Routinen.

Der read-only-Aufruf `docker context show` / `docker version --format '{{.Server.Version}}'` wurde vor Ausführung vom Sicherheits-Guard abgewiesen: `Rejected: Keine Container ohne Freigabe.` Es wurden keine Container, Netzwerke oder Volumes verändert. Die zwölf Labs sind daher **BLOCKED / NOT RUN**, nicht bestanden.

Erforderlich für einen separaten kontrollierten Lauf: freigegebener read-only Docker-Daemon sowie ausdrückliche Ausführungsfreigabe für die isolierte lokalen Lab-Suite; Produktions-Contexts, Produktions-Mounts und produktive Secrets bleiben ausgeschlossen.

## Anbieterstatus

| Anbieter | Status | Automatisch verifizierte Reparaturen |
|---|---|---|
| WordPress / WooCommerce | AUTO_REPAIR_VERIFIED | ausgewählte defekte Links und einfache, klar lokalisierte HTML-/Content-Fixes; Backup, Validierung und Rollback |
| GitHub / Netlify | AUTO_REPAIR_VERIFIED | gemappte Repository-/Site-Reparatur, ausgewählte Link-/Asset-Fixes, isolierter Branch/Preview, Retest und Rollback |
| SFTP / SSH | AUTO_REPAIR_VERIFIED | allowlist-basierte statische HTML-/CSS-/JS-Dateifixes mit sicherem Pfad, atomarem Backup/Rollback und allowlist Health-Checks |
| Shopify | VAULT_ONLY | Zugangserfassung; keine als sicher verifizierte automatische Änderung |
| Webflow | VAULT_ONLY | Zugangserfassung; sichere Automatisierung nicht nachgewiesen |
| Wix | VAULT_ONLY | Zugangserfassung; sichere Automatisierung nicht nachgewiesen |
| unbekannter Anbieter | MANUAL_REVIEW_REQUIRED | keine automatische Reparatur, keine erratene Adapterwahl |

## Sicherheitsnachweise und offene Punkte

- Keine Reparatur ohne vollständige bestätigte Zahlung, Kundenautorisierung, gültigen Zugang, Backup und Rollback.
- Stripe-Zuordnung bleibt an die bestehende verifizierte Order-/Webhook-Zuordnung gebunden; Browser-Rückleitungen oder freie Parameter schalten nichts frei.
- Keine Secrets in Logs, Berichten oder öffentlichen Snapshots; keine echten Kundenwebsites, Zahlungen oder E-Mails verwendet.
- Playwright-MCP war in dieser Sitzung nicht verfügbar. Die lokalen `playwright-core`-Fixtures sind kein Ersatz für einen kontrollierten externen MCP-Nachweis.
- Kein produktives Deployment und keine Produktionsfreigabe erteilt.

## Commit

Der finale Commit wird nach `node scripts/dev-check.mjs` erstellt. Der resultierende Hash ist im Übergabebericht zu ergänzen.
