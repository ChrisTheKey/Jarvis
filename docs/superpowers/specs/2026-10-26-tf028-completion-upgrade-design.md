# TF-JARVIS-028 – Design: Abschlussmails, Quittung und Reparatur-Upgrade

**Stand:** 2026-10-26
**Basis:** `e8634df` (`agent-codex/tf027-integration`)
**Arbeitsbranch:** `agent-codex/tf028`
**Freigabe:** Variante 1 durch Chris bestätigt

## Ziel

Die bisherigen Abschlussmail-Vorlagen werden vollständig durch die freigegebenen
Vorlagen für CHF 150 und CHF 480 ersetzt. Ein bezahlter CHF-150-Auftrag erhält
einen eindeutig gebundenen CHF-330-Upgrade-Checkout. Nach bestätigter Zahlung
wird die bestehende Reparaturkette automatisch weitergeführt, sobald ihre
Zugriffs-, Autorisierungs- und Browser-Gates erfüllt sind.

Die Lösung bleibt fail-closed: Keine unvollständige Quittung, kein nicht
verifizierter Reparaturabschluss und keine nicht zuordenbare Stripe-Zahlung
werden als versandbereit oder erfolgreich behandelt.

## Leitentscheidungen

### 1. Abschlussartefakte aus Auftragsdaten

Ein fokussierter Abschlussartefakt-Baustein erzeugt aus dem gespeicherten
Auftrag, dem Prüfbericht, dem Zahlungsledger und dem hinterlegten
Leistungserbringerprofil:

- den vollständigen CHF-150-Prüfbericht mit dynamischen Befunden,
  Prioritätszählung und verständlichen Anleitungen;
- die CHF-150-Quittung mit eindeutiger Nummer, Zahlungs- und Ausstellungsdatum,
  tatsächlichen Ledgerbeträgen und dem festen Hinweis
  `Nicht mehrwertsteuerpflichtig – keine MWST erhoben`;
- die CHF-480-Abschlussmail erst aus tatsächlich behobenen und technisch
  verifizierten Befunden.

Die Geschäftsadresse wird ausschließlich aus dem bestehenden, konfigurierten
Leistungserbringerprofil gelesen. Fehlt sie, wird nichts erfunden.

### 2. CHF-150-Versandfreigabe

Der Prüfbericht und die Reparaturanleitungen dürfen vollständig erzeugt und
gespeichert werden, auch wenn die Quittung noch blockiert ist. Eine
CHF-150-Abschlussmail wird jedoch nur dann als versandbereit an die bestehende
Outbox-/Mail-Worker-Kette übergeben, wenn:

1. der Bericht vollständig ist,
2. alle Befunde und Anleitungen aus dem tatsächlichen Audit stammen,
3. die Quittung vollständig validiert ist,
4. CHF 150 im verifizierten Ledger bezahlt sind,
5. Empfänger-, Auftrags- und Versandberechtigungen gültig sind.

Fehlt die Geschäftsadresse, erhalten Quittung und Mail den Zustand
`MANUAL_REVIEW_REQUIRED`; das CRM zeigt die fehlende Geschäftsadresse als
offenen Punkt. Nach Ergänzung wird die Quittung idempotent vervollständigt und
die bestehende Versandfreigabe erneut geprüft.

### 3. Eindeutiges CHF-330-Upgrade

Der vorhandene statische Stripe-Testlink wird nicht als alleinige Zuordnung
verwendet. Ein statischer Link ohne serverseitig gespeicherte, eindeutige
Auftragsbindung kann den ursprünglichen Auftrag nicht sicher identifizieren.
Jarvis erzeugt daher eine serverseitige Checkout-Session über die bestehende
Stripe-Abstraktion. Jede Session speichert und prüft mindestens:

- ursprüngliche CHF-150-`order_id`,
- `lead_id`,
- vorhandene Kunden-ID,
- Website/Domain,
- Quellpaket `REPAIR_CHECK_150`,
- Upgrade `REPAIR_FIX_500` / CHF 330 Differenz,
- erwarteten Betrag und Währung,
- TEST-/LIVE-Umgebung,
- Checkout-Session-ID.

Der Testlink bleibt ausschließlich Test-Fixture. Kein Live-Link wird erzeugt
oder verwendet.

### 4. Webhook und Idempotenz

Der Stripe-Webhook bleibt die einzige Zahlungsbestätigung. Eine Erfolgsseite,
E-Mail oder Client-Angabe reicht nicht. Der Webhook prüft Signatur, bekannte
Checkout-Session, Umgebung, Zahlungsstatus, Betrag CHF 330, Währung CHF,
Order-/Lead-/Domain-Bindung und die serverseitige Session-Historie.

Ereignis-ID, Checkout-Session-ID und Zahlungsreferenz werden idempotent
verarbeitet. Wiederholte gültige Webhooks führen weder zu einer zweiten
Zahlungsbuchung noch zu einem zweiten Upgrade oder einer zweiten Mail.
Unbekannte Sessions, falsche Beträge, falsche Währungen und Metadatenfehler
gehen in `PAYMENT_REVIEW_REQUIRED` und aktivieren keine Reparatur.

### 5. Automatische Reparatur mit bestehenden Gates

Nach bestätigter Upgrade-Zahlung wird der ursprüngliche Auftrag in einen
gebundenen Upgrade-Zustand überführt. Der bestehende Repair-Service lädt den
ursprünglichen Bericht und übernimmt ausschließlich dessen Befunde.

Die Reparatur startet automatisch erst dann, wenn alle bestehenden Bedingungen
erfüllt sind:

- gültige, auf Auftrag und Domain gebundene Website-Berechtigung;
- vorhandener und gültiger sicherer Zugang;
- ausdrückliche Reparaturautorisierung;
- bestehender Browser-Gate-Nachweis, soweit für den Adapter erforderlich;
- definierter Reparaturumfang ohne Erweiterung;
- Backup-/Rollback-Fähigkeit;
- keine DNC-/Versandprüfung wird umgangen.

Fehlende Zugriffe oder Browserfreigaben halten den Auftrag in einem
manuellen/wartepflichtigen Zustand. Der Upgrade-Webhook selbst führt keine
Website-Änderung außerhalb der bestehenden Repair-Workflow-Gates aus.

### 6. CHF-480-Abschlussmail

Die CHF-480-Mail wird erst nach einem erfolgreichen Repair-Workflow und einer
technischen Verifikation vorbereitet. Jeder tatsächlich behobene Befund wird
über eine stabile Befund-ID mit der tatsächlich ausgeführten Lösung und dem
Verifikationsnachweis verbunden. Nicht behobene, fehlgeschlagene oder nur
teilweise verifizierte Punkte dürfen nicht als gelöst erscheinen.

Die Mail bleibt an den ursprünglichen Auftrag und Lead gebunden und läuft über
die bestehende Repair-Outbox sowie den alleinigen Mail-Worker. Ein erneuter
Repair-Abschluss oder ein wiederholter Worker-Lauf erzeugt keine zweite
Abschlussmail.

## Zustands- und Datenfluss

```text
CHF-150 paid + audit complete
        │
        ├─ report complete ──┐
        ├─ receipt complete ─┼─► CHF-150 delivery eligible
        └─ address missing ─┴─► MANUAL_REVIEW_REQUIRED + CRM open item

CHF-150 delivery eligible
        │
        └─► unique CHF-330 TEST checkout
                  │
                  └─ signed webhook + exact binding + idempotency
                              │
                              └─► UPGRADE_PAID
                                      │
                                      └─ existing access/browser/authorization gates
                                              │
                                              ├─ blocked/waiting → no completion mail
                                              └─ repair + verification passed
                                                      │
                                                      └─ CHF-480 completion mail eligible
```

## Fehlerbehandlung

- Fehlende Pflichtdaten: `MANUAL_REVIEW_REQUIRED`, keine unvollständige
  Quittung und kein Versand.
- Fehlender Bericht oder unvollständige Befunde: keine Abschlussmail.
- Unbekannte oder nicht passende Checkout-Session: Review, keine Buchung.
- Doppelte Webhooks: idempotente Antwort, keine Nebenwirkung.
- Fehlende Zugriffsrechte/Browserfreigabe: Reparatur bleibt blockiert.
- Reparaturfehler oder fehlende Verifikation: kein CHF-480-Versand; Fehler und
  offene Punkte bleiben dem Auftrag zugeordnet.

## Teststrategie

Neue Tests verwenden ausschließlich synthetische Aufträge, Test-Ledger,
Stripe-TEST-Daten, In-Memory-/Temp-Stores und Mail-/Repair-Attrappen. Es gibt
keine echten E-Mails, keine Live-Zahlungen und keine Website-Änderungen.

Abgedeckt werden:

- beide exakten Vorlagen und dynamische Werte;
- vollständige Problemlisten, Anleitungen und Prioritätssummen;
- Quittung, fehlende Geschäftsadresse, Nicht-MWST-Status und Teilzahlung;
- eindeutige CHF-330-Session-Bindung;
- gültige und wiederholte Webhooks, falscher Betrag/Währung, unbekannte Session;
- fehlende Zugriffsrechte, Browser-Gate, erfolgreiche und fehlgeschlagene
  Reparatur;
- verspätete CHF-480-Mail erst nach erfolgreicher Verifikation;
- Idempotenz von Upgrade, Reparatur und Abschlussmail;
- CRM-Status und offene Punkte.

Die Umsetzung erfolgt testgetrieben: Jeder neue Verhaltenstest wird zunächst
gezielt rot ausgeführt, danach minimal implementiert und anschließend mit
gezielten sowie vollständigen lokalen Checks verifiziert.

## Nicht im Umfang

- Produktionsdeployment, SSH, Container-Neustarts oder Änderungen an VPS,
  Netlify, Gmail, Stripe-Live oder Kundensystemen;
- Erfinden fehlender Unternehmens- oder Kundendaten;
- Umgehung von Auth-, Scope-, DNC-, Opt-out-, Access-, Browser- oder
  Zahlungs-Gates;
- Versand echter E-Mails oder Auslösen echter Zahlungen.
