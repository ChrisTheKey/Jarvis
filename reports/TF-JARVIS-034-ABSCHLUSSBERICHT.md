# JARVIS TF-034 – Final Production Readiness

Stand: 2026-10-28
Branch: `agent-codex/tf034`  
Ausgangscommit: `c45b2d2`
Deployment: nicht ausgeführt; kein Push und kein Merge.

## Ergebnis

**Status: READY_FOR_DEPLOY_APPROVAL**

Die verpflichtenden lokalen Prüfungen sind mit synthetischen Daten erfolgreich abgeschlossen. Produktionsfreigabe, Push, Merge und Deployment bleiben getrennte menschliche Entscheidungen.

## Ursachen und Korrekturen

- Veraltete Repair- und Full-Order-Fixtures erwarteten CHF 240 als ausreichende Reparaturzahlung. Sie verwenden jetzt die verbindliche CHF-480-Vollzahlung; CHF 0, CHF 150, CHF 239, CHF 240 und CHF 479 bleiben blockiert.
- Die CHF-150-Fixture schliesst den Check mit CHF 150 ab und bleibt reparaturfrei; ein optionales CHF-330-Upgrade ist synthetisch gebunden und ergibt nur bei korrekter Zuordnung CHF 480.
- Der sichere Kundenpfad benötigte ein deklaratives `SFTP_HOSTING`-Providerprofil für SFTP/SSH. Domain-, Zahlungs-, Zugangs-, Host-Key- und Adapter-Gates bleiben aktiv.
- Full-Order-Fixtures erhielten synthetische Geschäftsadressdaten und aktuelle Erwartungen für manuelle Restpunkte, Quittung und Abschlussbericht.
- Das Separation-Lab parametrisiert Zahlungsdateipfad und Besitzer nur für sein temporäres Lab; Produktionsdefaults bleiben `/opt/jarvis-payment` und `root:root`.
- Die gemeldete TLS-Fehlermeldung `EPROTO` wurde im finalen Lauf nicht reproduziert. SNI-, Hostname-, Zertifikats- und Domain-Bindungstests bestanden; die TLS-Prüfung wurde nicht abgeschwächt.

## Geänderte Dateien

- `access-provider-registry.js`
- `deploy/vps/repair/docker-compose.yml`
- `deploy/vps/repair-remote.sh`
- `test/integration/repair-lab/repair-lab.integration.test.js`
- `test/integration/repair-lab/browser-validation.integration.test.js`
- `test/integration/full-order-046/full-order.integration.test.js`
- `test/integration/repair-quality-054/repair-quality.integration.test.js`
- `test/integration/service-separation-047/separation.integration.test.js`
- `test/tf088.test.js`
- `docs/STATUS.md`

## Tatsächlich ausgeführte Tests

Alle fünf freigegebenen Docker-Testgruppen liefen lokal mit `JARVIS_REPAIR_LAB=1`, synthetischen Daten und dedizierten Lab-Ressourcen:

| Testgruppe | Ergebnis | Exit |
|---|---:|---:|
| `npm run test:repair-integration` | 18 bestanden, 0 fehlgeschlagen, 0 übersprungen | 0 |
| `npm run test:browser-integration` | 10 bestanden, 0 fehlgeschlagen, 0 übersprungen | 0 |
| `npm run test:full-order-integration` | 8 bestanden, 0 fehlgeschlagen, 0 übersprungen | 0 |
| `npm run test:separation-integration` | 8 bestanden, 0 fehlgeschlagen, 0 übersprungen | 0 |
| `npm run test:repair-quality-integration` | 5 bestanden, 0 fehlgeschlagen, 0 übersprungen | 0 |

Docker-Summe: **49 bestanden, 0 fehlgeschlagen, 0 übersprungen**. Nach jeder Gruppe meldete das label-beschränkte Cleanup `containers: 0`, `volumes: 0`, `networks: 0`.

Der vollständige Projektcheck `node scripts/dev-check.mjs --full` lief danach ohne Lab-Umgebungsvariable und bestand mit **1'215 Tests, 1'203 bestanden, 0 fehlgeschlagen, 12 übersprungen**, Exit 0, `CHECK OK`. Die 12 Übersprungenen sind die separat ausgeführten Docker-Lab-Tests und wurden nicht als Full-Check-Pass gezählt. Secret-Scan: 416 Dateien, 0 bekannte Secretwerte, 0 Treffer.

Der gezielte lokale Browserlauf `test/crm-browser-053.test.js` bestand 6/6. Die zuvor einmal unter Last aufgetretene DNC-Drawer-Wartezeit wurde nicht als fachlicher Fehler reproduziert.

## Fachliche und Sicherheitsabdeckung

Nachgewiesen wurden insbesondere CHF 150 als Check/Anleitung ohne Reparatur, CHF 480 erst nach Vollzahlung und gültiger Kundenautorisierung, korrekt gebundenes CHF-330-Upgrade, Zahlungszuordnung, Refund/Chargeback-Gates, Kundenautorisierung, sichere Einmal-Links mit Ablauf, WordPress, GitHub/Netlify, SFTP/SSH, Host-Key-Verifikation, Backup/Rollback, Idempotenz gegen doppelte Reparaturen, sichere Mail-Outbox, Service-Isolation, Geheimnisschutz und Fehlerbehandlung.

Die Tests verwendeten ausschliesslich synthetische Domains, Testzahlungen, temporäre Zugangsdaten, eigene Lab-Netzwerke/Volumes/Container und loopback-gebundene Testports. Keine privilegierten Container, produktiven Mounts, Produktionszugangsdaten, echten Zahlungen, echten E-Mails, Kundenwebsites oder produktiven Container wurden verwendet oder verändert.

Playwright-MCP war in dieser Sitzung nicht verfügbar. Die vorhandenen lokalen `playwright-core`-Tests liefen mit dem vorhandenen Chromium; Browser-/Sicherheitsabdeckung bestand im gezielten Lauf und im Full-Check.

## Verbleibende Risiken

Es wurde kein Live-System geprüft oder verändert. Produktionskonfiguration, reale OAuth-/Stripe-Live-Zustellung und ein Deployment benötigen weiterhin separate Freigabe und menschliche Prüfung. Das ist kein offener lokaler TF-034-Testfehler.

## Git

Geprüfter Branch: `agent-codex/tf034`. Die finalen lokalen Commit-Hashes werden nach dem Dokumentationscommit ergänzt. Kein Push, Merge oder Deployment.
