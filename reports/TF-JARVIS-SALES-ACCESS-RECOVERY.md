# JARVIS – Sales Access Recovery und Manual-E2E-Vorbereitung

Stand: 2026-10-28  
Branch: `agent-codex/tf034`  
Ausgangsstand: `38419a8`

## Status

**BLOCKED**

Die lokale Rollen-, Scope-, Provisions- und Fairnesslogik ist geprüft. Die reale Wiederherstellung von Damiano/Giuliano, eine verbindliche CRM-Zuweisung und der manuelle CHF-150-/CHF-480-E2E-Test wurden nicht ausgeführt, weil kein authentifizierter JARVIS-Zugriff mit bestehender Session oder interaktiv bereitgestellten Zugangsdaten vorlag. Es wurden keine Passwörter gelesen/erraten, keine Konten verändert, keine CRM-Daten verändert, keine Mails versendet und keine Zahlungen ausgelöst.

## Infrastrukturprüfung

Playwright-MCP erreichte `https://chrisjarvis.netlify.app/login.html` und zeigte den Login. Read-only-API-Prüfung ohne Session:

| Endpoint | Ergebnis |
|---|---:|
| `/api/auth/me` | 401 |
| `/api/sales?view=summary` | 401 |
| `/api/crm` | 401 |
| `/api/health` | 404 |

Der lokale Read-only-Aufruf `docker context show`/`docker version` wurde durch die übergeordnete Richtlinie mit `Rejected: Keine Container ohne Freigabe.` blockiert. Es wurde kein Docker-Workaround verwendet und keine Ressource verändert. Die erfolgreiche TF-034-Lab-Abnahme bleibt durch die vorherige Dokumentation nachgewiesen.

## Verkäuferzugänge

| Konto | Realer Login | Dashboard/Leads/Provision | Ergebnis |
|---|---|---|---|
| Damiano | nicht geprüft – Session fehlt | nicht geprüft | BLOCKED |
| Giuliano | nicht geprüft – Session fehlt | nicht geprüft | BLOCKED |

Es wurden keine Duplikatkonten angelegt und keine Rollen oder Passwörter geändert.

## Damiano-Leads

- Tatsächlich aus dem produktiven CRM gelesen: **0**.
- Tatsächlich verbindlich zugewiesen: **0 / 200**.
- Rechtlich kontaktierbar: **nicht bestimmbar ohne authentifizierten CRM-Datenbestand**.
- Gesperrt: **nicht bestimmbar ohne authentifizierten CRM-Datenbestand**.

Die lokale synthetische Prüfung `test/scope-063.test.js test/commission-063.test.js test/tf073.test.js test/tf077b.test.js` bestand mit **45/45**. Sie bestätigt die vorhandene serverseitige Scope-/Rollenlogik, die Provisionserfassung und die deterministische faire 200/200-Zuweisungslogik; sie ist kein Nachweis einer realen CRM-Zuweisung.

## Playwright-MCP

Die öffentliche Login-Seite wurde mit Playwright-MCP geprüft. Ohne Login wurden keine geschützten Aktionen versucht. Daher:

- Öffentliche Erreichbarkeit: PASS
- Authentifizierte Damiano-/Giuliano-Flows: BLOCKED
- Rollen- und API-Rechteprüfung real: BLOCKED
- Keine Zugangsdaten in Screenshots oder Berichten gespeichert

## Manual-E2E CHF 150 / CHF 480

Der Ablauf ist lokal fachlich und synthetisch vorbereitet, aber nicht gestartet:

- CHF 150: BLOCKED – kein authentifizierter JARVIS-Auftrag/Mail-Worker-Zugriff.
- CHF 480: BLOCKED – kein authentifizierter JARVIS-Auftrag/Repair-Service-Zugriff.
- Keine Testmail an `helvetic.webdesign@proton.me` versendet.
- Keine Stripe-Testzahlung ausgelöst oder bestätigt.
- Keine Netlify-Testwebsite geändert.

Die vorherige Baseline der Website und die Checkout-Screenshots sind im Bericht `reports/TF-JARVIS-MANUAL-E2E-150-480.md` dokumentiert. Die Baseline enthielt bereits einen JavaScript-Fehler und einen fehlenden `#kontakt`-Anker; ohne autorisierten Repair-Zugriff wurde kein zusätzlicher Testfehler erzeugt.

## Sicherheitsbewertung

- Keine Secrets, Passwörter oder Tokens gelesen oder ausgegeben.
- Keine fremden Docker-Container oder Volumes verändert.
- Keine Kundendaten gelöscht oder neu zugewiesen.
- Keine echten E-Mails, Live-Zahlungen, Telefonate, Pushes, Merges oder Deployments.
- Keine Sicherheits- oder Zahlungsprüfung umgangen.

## Noch notwendige Schritte

1. Chris stellt in der bestehenden Playwright-MCP-JARVIS-Session eine gültige Owner-/Admin-Session her oder stellt einen ausdrücklich autorisierten, bereits konfigurierten Testzugang bereit.
2. Danach werden Damiano und Giuliano getrennt angemeldet, ihre bestehenden Rollen geprüft und die Rechte per UI und API nachgewiesen.
3. Erst danach wird der vorhandene CRM-Bestand rechtlich gefiltert und – falls mindestens 200 geeignete Datensätze vorhanden sind – genau eine faire Zuweisung an Damiano vorgenommen.
4. Anschliessend kann der manuelle CHF-150-/CHF-480-Test mit Testmails und Stripe-TEST-Webhook kontrolliert vorbereitet werden; Versand/Zahlung bleiben ein separater expliziter Schritt.

**Ausführbarer nächster Prompt:** `Öffne im Playwright-MCP die bestehende JARVIS-Loginseite, melde dich als berechtigter Owner an (Passwort nur direkt im Browser eingeben), und stoppe nach sichtbarem erfolgreichem Login; keine weiteren Aktionen.`

## Git

Die Dokumentation wird lokal committed. Kein Push, Merge oder Deployment.
