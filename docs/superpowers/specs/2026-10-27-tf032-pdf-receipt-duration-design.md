# TF-032 – PDF-Quittung und Bearbeitungsdauer

## Freigegebene Architektur

TF-032 ergänzt die bestehende CHF-480-Abschlussmail um genau eine PDF-Quittung und ergänzt die bestehende transaktionale Auftragsbestätigung um eine unverbindliche, statusabhängige Bearbeitungszeitschätzung. Es werden keine neuen Zahlungs-, Versand- oder Reparaturwege eingeführt.

### Quittung

`completion-artifacts.js` erhält eine eigene CHF-480-Quittungsprüfung. Sie liest ausschließlich den persistenten Zahlungsledger, den persistenten Auftrag und das konfigurierte Geschäftsprofil. Bereit ist die Quittung nur, wenn:

- der Auftrag ein gültiger `REPAIR_FIX_500`-Auftrag ist;
- mindestens eine bestätigte Zahlung im zum Auftrag passenden TEST-/LIVE-Modus vorliegt;
- Währung und kumulierter Betrag exakt CHF 480 entsprechen;
- Zahlungsdatum, Kundenangabe und vollständige verifizierte Geschäftsadresse vorhanden sind;
- die Quittungsnummer deterministisch aus Auftrag, Zahlungs-IDs und Betrag gebildet werden kann.

Fehlt eine Pflichtangabe oder ist die Zahlung nicht eindeutig passend, liefert die Funktion `MANUAL_REVIEW_REQUIRED` und erzeugt weder PDF noch Versandentwurf. Die PDF wird mit der bereits vorhandenen `pdfkit`-Abhängigkeit im Speicher erzeugt. Sie enthält nur die kundenrelevanten Pflichtangaben, keinen internen Auftragsschlüssel, keine Zahlungsreferenz und keine Geheimnisse.

### Abschlussmail und Versandkette

`buildRepairDeliveryMail` erzeugt die PDF nur nach erfolgreicher Reparatur-/Qualitätsprüfung und erfolgreicher CHF-480-Quittungsprüfung. Das Mailartefakt enthält eine einzige PDF-Anlage. `repair-workflow.js` übergibt sie an den bestehenden `createDraft`-/`sendDraft`-Pfad. `repair-outbox.js` serialisiert ausschließlich die validierte PDF als geschützten Base64-Inhalt; `gmail.js` erzeugt daraus eine RFC-2046-Multipart-Mail. Claim-Datei, Outbox-Ergebnis, Draft-ID und bestehende Send-Idempotenz bleiben unverändert.

Die Mail wird bei fehlender Quittung blockiert. Eine bereits versandte Mail wird nicht erneut erzeugt. Ein unklarer Versandausgang bleibt wie bisher manuell prüfpflichtig.

### Bearbeitungsdauer

Eine gemeinsame, reine Statusfunktion erzeugt vier verständliche Phasen:

1. Wartezeit auf notwendige Kundenzugänge;
2. technische Bearbeitung;
3. Qualitätskontrolle;
4. Abschluss und Zustellung.

Die Werte werden aus dem aktuellen Auftragsstatus und vorhandenen Zeitstempeln abgeleitet. Falls keine belastbare Berechnung möglich ist, wird eine ausdrücklich unverbindliche Zeitspanne ausgegeben. Die Schätzung wird in die bestehende CHF-150-Auftrags-/Zahlungsbestätigung und in die CHF-480-Zugangs-/Auftragsbestätigung aufgenommen. Die CHF-480-Abschlussmail erhält keine offene Lieferprognose mehr, sondern bestätigt ausschließlich den abgeschlossenen und verifizierten Auftrag.

### Sicherheitsgrenzen

Die bestehenden Auth-, DNC-/Opt-out-, Zahlungs-, Zugang-, Browser-, Qualitäts-, Outbox- und Mail-Worker-Gates bleiben unverändert aktiv. TEST-Zahlungen bleiben TEST; Live-Zahlungen werden nicht synthetisch ersetzt. Keine echte Mail, Zahlung, Website-Änderung oder Produktionsressource wird verwendet.

## Verifikation

Die Umsetzung wird testgetrieben verifiziert: zuerst rote synthetische Tests für Quittungsberechtigung, PDF-Inhalt, Anlage, Idempotenz, Pflichtdaten und Zeitangabe; danach die kleinste Implementierung. Anschließend laufen die betroffenen Regressionen, der vollständige lokale Check und – nur bei nachgewiesener Docker-Isolation – die Docker-Labs. Nicht zugängliche Docker-Labs werden als BLOCKED dokumentiert, nicht als bestanden gezählt.
