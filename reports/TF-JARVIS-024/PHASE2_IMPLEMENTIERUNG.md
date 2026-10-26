# TF-JARVIS-024 – Phase 2: Verkaufsautomation

Stand: 2026-10-26
Branch: `agent-codex/main`
Externe Aktionen: deaktiviert; keine echten E-Mails, Zahlungen, Anrufe oder Reparaturen ausgeführt.

## Ergebnis

| Funktion | Status | Nachweis / Hinweis |
|---|---|---|
| Zentraler CRM-Button oben in der Lead-Detailansicht | IMPLEMENTIERT / GETESTET | `public/crm.js`, Desktop-/Mobile-CSS in `public/crm.css`; bestehender Browser-Regressionslauf grün |
| Serverseitige Berechtigungs-, DNC-, Opt-out- und E-Mail-Prüfung | IMPLEMENTIERT / GETESTET | `sales-intake.js` nutzt die zentrale `email-permission.js`; fail-closed |
| Vorschau vor Versand mit Empfänger, Betreff, Befunden und drei Links | IMPLEMENTIERT / GETESTET | `sales_intake_preview`; Browser sendet keine Maildaten |
| Ausdrückliche Bestätigung und Doppelklickschutz | IMPLEMENTIERT / GETESTET | `sales_intake_confirm`; Queue-Fingerprint/Idempotenz |
| Editierbare Erstmail-Texte | TEILWEISE VORHANDEN | Text liegt zentral in `sales-intake.js`; eine spätere Redaktionsoberfläche ist noch offen |
| CHF-150-/CHF-480-Linkbindung | IMPLEMENTIERT / GETESTET | `paymentLinkFor()` mit `CA150-…`/`RF480-…`; bestehende Stripe-Test-/Webhook-Gates unverändert |
| Mail-Worker-Anbindung | IMPLEMENTIERT / GETESTET | neue Queue-Zustellung `sales_intake`, erneute Permission-Prüfung und Send-Lock in `mail-worker.js` |
| CRM-Aktivität, UNPAID-Auftragsanlage und Zahlungszuordnung | OFFEN | Die bestehenden `check-150-workflow`-/`repair-workflow`-Stores benötigen noch eine gemeinsame, atomare Materialisierung aus `sales_intake` |
| Kundentresor-Linkregistrierung | BLOCKIERT | Der vorhandene Tresor registriert aktive Tokens erst im bezahlten Auftragsweg; die neue Verkaufsaktion darf bis zur Registrierungskopplung nicht produktiv aktiviert werden |
| CHF-150-/CHF-480-Ausführung und Abschlussmail | VORHANDEN / OFFEN ANGEBUNDEN | Bestehende Zahlungs-, Qualitäts- und Abschlussmail-Gates bleiben unverändert; die neue Queue-Referenz ist noch nicht der Trigger dieser Workflows |

## Wiederverwendete Komponenten

- zentrale Schweizer Kontaktberechtigung `email-permission.js`
- bestehende `paymentLinkFor()`-Erzeugung und `pricing.js`-Auftrags-ID-Regeln
- bestehende Mail-Queue, Seller-Scope, Send-Lock und Mail-Worker
- bestehende CRM-Lead-Detailansicht und i18n/CSS
- bestehende Stripe-, Reparatur-, Abschlussmail- und verschlüsselte Tresor-Komponenten wurden nicht dupliziert oder abgeschwächt

## Geänderte Dateien

- `sales-intake.js`
- `mail-requests.js`
- `mail-worker.js`
- `public/crm.js`
- `public/crm.css`
- `public/i18n.js`
- `test/tf024-sales-intake.test.js`
- `test/tf077b.test.js` (bestehenden Browser-Regressionsassertion um den neuen Button ergänzt)
- `docs/STATUS.md`

## Tests

- `node scripts/run-unit-tests.mjs test/tf024-sales-intake.test.js`: 3/3 erfolgreich.
- `node scripts/run-unit-tests.mjs test/tf077b.test.js`: 22/22 erfolgreich, einschliesslich bestehender Verkäufer- und Browser-Regressionsprüfung.
- `node scripts/dev-check.mjs`: Syntax und Secret-Scan erfolgreich; 7 geänderte JavaScript-Dateien geprüft.
- Playwright MCP war in dieser Sitzung nicht verfügbar. Es wurde kein anderes Werkzeug als Playwright-MCP ausgegeben. Die vorhandene lokale Browser-Testinfrastruktur wurde für `tf077b` verwendet; keine externen Systeme wurden geöffnet.
- Keine produktiven Screenshots erstellt. Der lokale Browser-Regressionslauf liefert keinen archivierten Screenshot für diese Phase.

## Offene Blocker und notwendige Freigaben

1. Atomare Auftragserzeugung nach bestätigtem Mailversand muss `sales_intake` an die bestehenden CHF-150-/CHF-480-Order-Stores binden, ohne doppelte Aufträge oder unzugeordnete Stripe-Webhooks.
2. Der geschützte Tresorlink muss über den bestehenden Netlify-Registrierungsweg erzeugt und nach Zahlungs-/Auftragsstatus aktiviert werden. Der derzeitige HMAC-Link ist nur die serverseitige Referenzhülle und kein produktiv registrierter Zugang.
3. Danach sind gezielte Test-Fixtures für verifizierte Test-Webhooks, unpaid/falscher Betrag/doppelter Webhook, Bericht, Reparatursimulation, Qualitätsfreigabe und Abschlussmail auszuführen.
4. Vor einer Aktivierung sind menschliche Qualitätsfreigaben für CHF 480 und eine gesonderte Produktionsfreigabe erforderlich.

Diese offenen Punkte sind bewusst nicht durch eine unsichere Umgehung geschlossen worden. Bis dahin bleibt die neue Verkaufsaktion für produktive Verwendung gesperrt.

## Git

Lokaler Commit: `6701c44 TF-024: add CRM sales intake preview flow`. Kein Push, Merge oder Deployment.
