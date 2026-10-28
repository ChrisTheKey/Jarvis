# JARVIS – Sales Access Recovery und Manual-E2E-Vorbereitung

Stand: 2026-10-28  
Branch: `agent-codex/tf034`  
Commit bei Prüfung: `48e596a8a8d0315e7259374897b41613e3ac3698`

## Status

**BLOCKED**

Die geschützte JARVIS-Session ist nun nachweislich als Owner authentifiziert. Die Infrastruktur- und Rollenendpunkte antworteten erfolgreich; es wurden aber keine Passwörter gesetzt, keine Verkäufer-Logins simuliert, keine E-Mails versendet, keine Zahlungen ausgelöst und keine Reparaturen gestartet.

## Infrastrukturprüfung (Playwright-MCP, read-only)

| Prüfung | Ergebnis |
|---|---|
| `/api/auth/me` | HTTP 200, Owner-Session |
| `/api/auth/admin/users` | HTTP 200, Benutzerverwaltung erreichbar |
| `/api/sales?view=assignments` | HTTP 200, Assignment-Report erreichbar |
| `/api/sales?view=commission` | HTTP 200, 6000 bps Verkäufer-Provision |
| `/api/sales?view=sales_overview` | HTTP 200 |
| `/api/crm` | HTTP 200, 2162 CRM-Leads in Owner-Sicht |
| JARVIS-Dashboard | ONLINE; Mail Worker VPS ACTIVE laut Owner-Anzeige |
| Docker CLI | BLOCKED durch übergeordneten Guard `Keine Container ohne Freigabe.`; kein Workaround |

Die Ursache des früheren Blockers war fehlende authentifizierte Session. Mit der vorhandenen Owner-Session ist die API erreichbar. Ein tatsächlicher Verkäufer-Login konnte nicht nachgewiesen werden, weil dafür die berechtigte direkte Eingabe des jeweiligen Passworts erforderlich wäre; Passwörter wurden weder gelesen noch ausgegeben.

## Verkäuferzugänge

| Konto | Serverstatus | Rolle | Passwortstatus | Ergebnis |
|---|---|---|---|---|
| Damiano | AKTIV | `SALES_AGENT_CH` | gesetzt | Konto bereit; Login selbst nicht ausgeführt |
| Giuliano | AKTIV | `SALES_AGENT_CH` | gesetzt | Konto bereit; Login selbst nicht ausgeführt |

Die Owner-Ansicht zeigte getrennte Identitäten und 60 % Provision. Das entspricht CHF 90 bei CHF 150 und CHF 288 bei CHF 480. Es wurden keine Duplikatkonten, Rollenänderungen oder Passwortänderungen vorgenommen.

## Damiano-Leads

Der serverseitige Assignment-Report meldete:

- Persistierte Verteilungsgrößen: Mario 200, Damiano 200.
- Im aktuellen CRM-Snapshot sichtbar: Mario 196, Damiano 194.
- Nicht im aktuellen Snapshot: 10 bereits persistierte Assignment-IDs.
- Überlappung: 0.
- Geeignete, derzeit nicht zugewiesene Ersatzkandidaten nach bestehender Portfolio-Logik: 827.
- Rechtliche Ausschlüsse wurden durch die bestehende Eligibility-Logik berücksichtigt: DNC/Opt-out, Kunden, geschlossene Status, historische Leads, Test-Leads und fehlende CH-Kontaktdaten wurden ausgeschlossen.

Eine Korrektur wurde bewusst nicht geschrieben: Die öffentliche Owner-API bietet nur Einzel-Reassignments, liefert die zehn veralteten IDs absichtlich nicht aus und besitzt keinen autorisierten Rebuild/Cleanup-Endpunkt. Ein bloßes Hinzufügen von zehn Ersatz-Zuweisungen würde die persistierte Zuordnung inkonsistent über 200 hinaus vergrößern. Daher lautet die verbindliche Zuweisung **194/200 sichtbar, BLOCKED**; es wurden keine CRM-Zuordnungen verändert.

## Playwright-MCP und Rechteprüfung

- Owner-Dashboard und Zugangsverwaltung: PASS.
- Aggregierte Assignment-, Rollen- und Provisionsdaten: PASS.
- Damiano-Login, Dashboard, Leadnotiz, Statusänderung, Provision, Logout: BLOCKED (kein direkt eingegebenes Verkäuferpasswort).
- Giuliano-Login, Dashboard, Leadnotiz, Statusänderung, Provision, Logout: BLOCKED (kein direkt eingegebenes Verkäuferpasswort).
- Direkter serverseitiger Scope-/Rechte-Nachweis: PASS in lokaler synthetischer Regression; Verkäufer-Session im kontrollierten externen System nicht ausgeführt.

## Manuelle CHF-150-/CHF-480-E2E-Vorbereitung

Status: **BLOCKED / NOT STARTED**. Es wurden keine Testaufträge angelegt, keine Erst- oder Abschlussmails versendet, kein Stripe-Testcheckout bestätigt, keine Autorisierung verwendet und keine Website-Reparatur ausgeführt. Für den kontrollierten Lauf fehlen weiterhin ein separat eingegebener Testzugang für die vorgesehenen JARVIS-Aktionen sowie die sichere Bereinigung der zehn veralteten Assignment-Referenzen.

## Lokale Regression

Die gezielte Rollen-, Scope-, Provision-, Mail-Policy- und Service-Isolation-Suite wurde erneut gestartet; die ausgegebenen Testfälle waren PASS (historischer kompletter Lauf: 45/45). `node scripts/dev-check.mjs` und der Secret-Scan waren PASS. `node scripts/dev-check.mjs --full` wurde wegen eines hängenden Browser-/Runner-Schritts nach dem erfolgreichen Schnellcheck abgebrochen; deshalb kein Anspruch auf einen aktuellen vollständigen Full-Check.

## Sicherheitsgrenzen und offene Blocker

- Keine Passwörter, Tokens oder API-Schlüssel gelesen, gespeichert oder berichtet.
- Keine echten Kunden-E-Mails, Live-Zahlungen, Anrufe, Reparaturen, Deployments, Pushes oder Merges.
- Docker-Inspektion blieb durch die übergeordnete Ausführungsrichtlinie BLOCKED.
- Seller-Login und vollständige manuelle E2E-Abnahme bleiben BLOCKED.
- Damiano hat im aktuellen CRM-Snapshot 194 statt 200 sichtbare Leads; ein sicherer Cleanup/Rebuild-Endpunkt fehlt.
