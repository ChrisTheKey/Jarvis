# TF-JARVIS-024 – Direkter CRM-Mailbutton

## Ziel

Den freigegebenen direkten «Mail senden»-Pfad im geöffneten CRM-Leadpanel über die bestehende Mail-Queue und den bestehenden Mail-Worker bereitstellen. Der Versand bleibt bis zu einer separaten Produktionsfreigabe auf synthetische Leads im lokalen Stripe-Sandbox-Modus beschränkt.

## Vorgehen

1. Isolierte synthetische Tests für Template, dynamische Lead-/Auftragswerte, Access-Intake-Link, Berechtigungen, DNC/Opt-out, Sandbox-Gate, Ablaufprüfung und Doppelklick-Idempotenz zuerst rot ausführen.
2. Den bestehenden Access-Intake-Tokenmechanismus (`newIntakeToken`/`accessLink`) mit dem bereits vorhandenen Offer-Intent-Bundle verbinden; nur der Token im URL-Fragment geht in den Mailtext, persistiert wird nur dessen Hash.
3. Eine serverseitige Operation für den direkten Versand ergänzen. Empfänger, Text, Zahlungslinks, Token und Metadaten werden ausschließlich serverseitig aus Session, Lead und Auftrag erzeugt. Die Queue bleibt `sales_intake`; der Worker behält seine Permission-/DNC-/Send-Locks und lehnt direkte Sandbox-Aufträge ohne synthetische Bindung ab.
4. Den Button oben links im Leadpanel ergänzen. Er sendet genau eine direkte POST-Operation, deaktiviert sich während des Vorgangs und zeigt Queue-/Fehlerstatus ohne Vorschau oder Bestätigungsdialog.
5. Den isolierten Browser-Test für Desktop und Smartphone auf den neuen Button ausrichten, inklusive authentifiziertem Status, exakter Queue-Anzahl und Schutz vor externen Requests.
6. Relevante Regressionen, Syntax-/Secret-/Sicherheitsprüfungen und den vollständigen lokalen Check ausführen. `docs/STATUS.md` im selben Commit aktualisieren; vorhandene uncommittete Dateien bleiben unangetastet.

## Sicherheitsgrenzen

- Der neue direkte Pfad verlangt eine explizite lokale Sandbox-Flagge und einen als synthetisch markierten Lead.
- Ohne diese beiden Bedingungen gibt es keinen Queue-Auftrag; Sandbox-Zahlungslinks können daher keinen realen Empfänger erreichen.
- Authentifizierung, Lead-Scope, Kontaktberechtigung, DNC/Opt-out/Suppression, Versand-/Worker-Gates und Send-Locks bleiben aktiv.
- Keine echten E-Mails, Zahlungen, externen API-Aufrufe oder produktiven Daten.
