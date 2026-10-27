# TF-JARVIS-032 – PDF-Quittung und Bearbeitungsdauer

## Ausgangslage und Umfang

- Ausgangscommit: `db36d2c`
- Isolierter Branch/Worktree: `agent-codex/tf032` / `C:\Users\Administrator\Documents\Chris\Jarvis-tf032`
- Architekturentscheid: `b84ca1c` (`docs(tf032): design receipt and processing duration`)
- Kein Push, Merge, Deployment, SSH-Zugriff, Live-E-Mail, Live-Zahlung oder Zugriff auf Kundenwebsites.

## Implementierte Änderungen

### CHF-480-PDF-Quittung

`completion-artifacts.js` erzeugt eine PDF-Quittung ausschliesslich aus dem persistenten Auftrag, dem Zahlungsledger und dem konfigurierten Geschäftsprofil. Versandbereit ist sie nur bei:

- `REPAIR_FIX_500` mit exakt CHF 480 bestätigter Zahlung;
- passendem TEST-/LIVE-Modus und CHF-Währung;
- vollständiger Geschäftsadresse, Kundenangabe und Zahlungsdatum;
- erfolgreicher, verifizierter Reparatur ohne offene manuelle Reparaturpunkte.

Die Quittung enthält Helvetic Webdesign, Christoph Kälin, die verifizierte Geschäftsadresse, Kundenangabe, deterministische Quittungsnummer, Ausstellungs- und Zahlungsdatum, Leistung, CHF 480.00, bezahlten Betrag sowie den Hinweis: «Nicht mehrwertsteuerpflichtig – keine MWST erhoben.» Es werden keine MWST oder MWST-Nummer erfunden oder ausgewiesen.

Bei fehlender Adresse, Teilzahlung, Überzahlung, falscher Währung, falschem Zahlungsmodus oder fehlenden Pflichtdaten wird weder PDF noch Abschlussmail erzeugt (`MANUAL_REVIEW_REQUIRED` beziehungsweise `PARTIAL_PAYMENT`).

Die Anlage wird durch den bestehenden Repair-Draft, die Outbox, einen gebundenen Auftrags-Thread und die Gmail-MIME-Erstellung weitergereicht. Die Outbox akzeptiert dabei nur begrenzte, valide PDF-Anlagen mit sicherem Dateinamen und Base64-Integritätsprüfung. Ohne Anlage bleibt das vorhandene `text/plain`-MIME bytekompatibel; mit Anlage wird `multipart/mixed` erzeugt.

Der ausdrücklich zahlungsfreie interne Admin-E2E-Auftrag bleibt eine Ausnahme: Er ist zusätzlich über Domain, Testpostfach und Lauf-ID abgesichert, trägt den E2E-Testbetreff und erzeugt keine finanzielle Quittung. Dies verhindert eine fingierte Zahlungsbestätigung; echte Kunden-Abschlussmails bleiben ausnahmslos quittungspflichtig.

### Bearbeitungsdauer

`buildProcessingDurationEstimate` beschreibt in der Auftrags- und Zugangsbestätigung vier statusabhängige Phasen:

1. Wartezeit auf notwendige Kundenzugänge
2. Technische Bearbeitung
3. Qualitätskontrolle
4. Abschluss und Zustellung

Die Werte kommen aus Auftragsstatus beziehungsweise optionaler Prozesskonfiguration und sind durchgehend als unverbindlich gekennzeichnet. Nach erfolgreichem Abschluss enthält die Abschlussmail keine offene Lieferzeit mehr.

### Bestehende Tests an die fachliche Quittungsbedingung angepasst

Ältere synthetische CHF-480-End-to-End-Fixtures bildeten nur die CHF-240-Zugangsschwelle ab. Für einen vollständigen Abschluss mit CHF-480-Quittung ergänzen sie jetzt eine zweite synthetische, eindeutig referenzierte TEST-Zahlung und eine synthetische Geschäftsadresse. Die Zugangsschwelle von CHF 240, alle Zahlungs-, DNC-, Opt-out-, Authentifizierungs-, Browser- und Idempotenz-Gates bleiben unverändert.

## Nachweise und Testergebnisse

| Prüfung | Ergebnis |
|---|---:|
| TF-032 PDF-/Anlagen-/Zeit-Tests | 7/7 bestanden |
| Betroffene Repair-, Onboarding-, Stripe- und Abschlussmail-Regressionen | bestanden |
| Praxis-002 Browser-/Outbox-E2E | 5/5 bestanden |
| Gmail-OAuth-Regression | 8/8 bestanden |
| Finaler `node scripts/dev-check.mjs --full` | Exit 0 |
| Vollsuite | 1'206 Tests; 1'194 bestanden; 0 fehlgeschlagen; 12 übersprungen |
| Syntaxprüfung | 18 geänderte Dateien bestanden |
| Secret-Scan | 404 Dateien; 0 Treffer |

Der finale Vollcheck lief mit prozesslokalem `JARVIS_CHROMIUM_PATH` und `CHROME_PATH` auf das vorhandene lokale Chromium. Ausschliesslich synthetische Temp-Stores, Testzahlungen und Testpostfächer kamen zum Einsatz.

## Tatsächliche Bearbeitungsdauer der Entwicklung

Messfenster vom Architekturcommit `b84ca1c` (2026-10-27T15:32:47+01:00) bis zum Beginn der Abschlussdokumentation (2026-10-27T16:50:17+01:00): **77.5 Minuten**. Dies ist die gemessene lokale Entwicklungs- und Verifikationszeit, keine Kundenbearbeitungs- oder Lieferzeit.

## Docker-Status

Docker Desktop-Prozesse waren lokal sichtbar. Die angefragte read-only Docker-CLI-Prüfung wurde jedoch vor Ausführung durch den Ausführungs-Guard mit «Keine Container ohne Freigabe» abgelehnt. Deshalb wurden keine Docker-Kontexte, Container, Netzwerke oder Volumes inventarisiert und die zwölf Docker-/Repair-Labs nicht gestartet. Sie bleiben korrekt als `BLOCKED / NOT RUN` markiert. Es wurden keine Docker-Ressourcen geändert oder gelöscht.

## Offene Blocker und Release-Status

**Release-Status: BLOCKED.**

Es bestehen keine roten lokalen Tests. Für eine technische Releasefreigabe fehlen weiterhin:

1. der nachweisbar isolierte Lauf der zwölf Docker-/Repair-Labs;
2. separat freizugebende Produktionskonfiguration und kontrollierte Live-Nachweise für Zustellung, Stripe und Infrastruktur.

Der nächste notwendige Schritt ist eine ausdrücklich autorisierte, read-only Docker-Inventur. Erst bei nachgewiesener Isolation dürfen die zwölf Labs mit `JARVIS_REPAIR_LAB=1` in einer ausschliesslich lokalen, synthetischen Umgebung gestartet werden.
