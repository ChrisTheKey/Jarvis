# TF-JARVIS-024 – Bestandsaufnahme Verkauf → Reparatur

Stand: 2026-10-25 · Branch `agent-codex/main` · nur lokaler Code-/Fixture-Stand

## Ergebnis in Kürze

Der technische Ablauf ist bereits weitgehend vorhanden. Die sichere Lücke ist kein fehlender Zahlungs-, Tresor- oder Reparaturbaustein, sondern eine zusammenhängende CRM-Aktion «Erstmail senden & Auftrag starten» mit Vorschau, ausdrücklicher Bestätigung und einer serverseitig gebundenen Auftragsanlage.

Der bestehende Cold-Lead-Pfad darf dafür nicht umgangen werden: Eine öffentliche Adresse, ein Website-Befund, ein Telefonat ohne dokumentierte Anfrage/Einwilligung oder die Freigabe eines Mitarbeiters sind nach `email-permission.js` keine Versandgrundlage. Ein neuer Button muss deshalb fail-closed bleiben und darf nur bereits serverseitig belegte Rechtsgrundlagen verwenden.

## Bestand

| Bereich | Status | Vorhandene Komponenten / Beleg |
|---|---|---|
| CRM und Lead-Detailansicht | VORHANDEN | `public/crm.js`, `lead-crm.js`, `crm-api.js`; Desktop-/Mobile-Detailtests TF-059 |
| Rollen, Scope und Berechtigungen | VORHANDEN | `auth-core.js`, `sales-scope.js`, serverseitige Scope-Prüfung in `crm-api.js` |
| Website-Befunde | VORHANDEN | `site-findings.js`, `site-auditor.js`, konkrete Evidence-Allowlist und CRM-Darstellung |
| Mailvorlagen / Mail-Worker / Outbox | VORHANDEN | `mail-worker.js`, `mail-requests.js`, `repair-outbox.js`; alleinige Sender Authority und Send-Locks |
| Erstmail für Cold Leads | TEILWEISE VORHANDEN | belegte Befunde, Angebote und rechtliche Prüfung vorhanden; Cold-Leads bleiben absichtlich `DRAFT_ONLY` bzw. manuelle Entscheidung |
| CHF-150-Angebot | VORHANDEN | `check-150-workflow.js`; Zahlungsgate, Audit, Anleitung, Bericht, Zustellung und Abschlusszustand |
| CHF-480-Angebot | VORHANDEN | `repair-workflow.js`; Autorisierung, Zahlung, Zugang, Backup, Reparatur, Validierung, Retest und Zustellung |
| Stripe-Zahlung | VORHANDEN | `stripe-webhook.js`, `stripe-payments.js`, `payments.js`; Signatur, Test/Live-Trennung, Betrag/Währung, Referenz und Idempotenz |
| Zahlungszuordnung | VORHANDEN | `client_reference_id` → `order_id`; falsche/nicht eindeutige Zahlungen werden nicht verbucht |
| Kundentresor | VORHANDEN | `access-intake.js`, `access-intake-api.js`, `public/access.html`, `public/access.js`, `public/access-crypto.js`; Token-Hash, Ablauf, Verschlüsselung, Zerstörung |
| Hosting/CMS-Erkennung | VORHANDEN | `hosting-detect.js`, Adapter-/Profil-Gates im Reparaturworkflow |
| Abschlussmail | VORHANDEN | CHF-150-Lieferlogik in `check-150-workflow.js`, CHF-480-Fulfillment in `repair-workflow.js`; Zustellung vor `COMPLETED`, Send-Lock gegen Doppelversand |
| Auftragsstatus / Provision | VORHANDEN | persistente Zustandsmaschinen und `commission-ledger.js`; Testaufträge bleiben ohne Provision |
| CRM-Ein-Klick-Aktion | FEHLT | keine gemeinsame, serverseitig atomare Aktion für Vorschau → Bestätigung → Erstmail → Auftrag |
| Bearbeitbare zentrale Erstmail-Vorlage | TEILWEISE VORHANDEN | Worker-Writer/Angebotskonfiguration vorhanden; kein sicherer CRM-Vorschauvertrag für Betreff/Text und keine gemeinsam gebundene Auftragsanlage |

## Sicherheitsentscheidungen für die nächste Implementierung

1. Der Browser darf nur `lead_id`, einen kurzlebigen Preview-/Draft-Referenzwert und eine Bestätigung senden. Empfänger, Betreff, Text, Rechtsgrundlage, Preise und Links kommen serverseitig aus dem Lead-/Auftragskontext.
2. Preview und Send müssen dieselbe unveränderliche Referenz prüfen. Änderungen am Lead, DNC, Opt-out, Suppression, fehlender E-Mail, fehlender Rechtsgrundlage oder fehlendem Befund blockieren den Versand.
3. Die Auftragsanlage muss atomar/idempotent an die bestätigte Mailaktion gebunden sein; ein zweiter Klick darf weder eine zweite Mail noch einen zweiten Auftrag erzeugen.
4. «Telefonat geführt» allein wird nicht als Rechtsgrundlage erfunden. Für einen zulässigen Versand muss der vorhandene, dokumentierte Nachweis eine der bestehenden erlaubten Grundlagen erfüllen.
5. Tests bleiben lokal und synthetisch. Kein Gmail-/Stripe-Live-Versand, keine Kundendaten, kein Deployment und keine Websiteänderung.

## Vorhandene gezielte Testabdeckung

- CRM-Detailansicht Desktop/Mobile und belegte Website-Fakten: `test/crm-detail-059.test.js`
- Rollen-/Mailzugriff und vorbereitete Sendung mit Idempotenz: `test/tf077b.test.js`
- Stripe-Testlinks, Signatur, Betrag/Währung, Zuordnung und Duplicate-Events: `test/tf081-stripe.test.js`
- Verschlüsselter Zugang, One-Time-Link, Geheimnis-Lebenszyklus: `test/secure-access-041.test.js`
- CHF-150-Test-Erfüllung und Outbox-Zustellung: `test/f088.test.js` bzw. die versionierte TF-088-Testdatei
- CHF-480-Reparaturqualität, manuelle Freigabe und Browser-Gates: `test/repair-quality-054.test.js`, `test/repair-manual-055.test.js`

## Nicht produktionsbereit / offen

- Der neue CRM-Button mit Preview-/Confirm-/Atomic-Order-Vertrag ist noch nicht implementiert.
- Die kontrollierte externe E2E bleibt bis zu den bestehenden manuellen Gates blockiert; vorhandene Produktions-/Historiennachweise werden nicht als aktuelle Testbelege verwendet.
- Die Abschlussmail darf erst nach bestätigter Zustellung bzw. bestätigtem Reparaturergebnis ausgelöst werden; dies bleibt durch die bestehenden Workflows erzwungen.
