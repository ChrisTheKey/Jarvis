# Abschlussmail «Check & Reparatur» – verbindlicher Standard

Gilt für jede automatisch erzeugte Abschlussmail des Schweizer Reparaturauftrags (CHF 480). Einzige Quelle:
`repair-workflow.js` → `buildCustomerReport` (Bericht, gespeichert in `order.report`) und `buildRepairDeliveryMail`
(Mail = Kopf + Bericht + Signatur). Versand nur über `deliver()` (Engine) bzw. die Repair-Outbox. Die Mail ist **Text/plain**
(`gmail.js`), es gibt keinen HTML-Teil. Vietnamesische Aufträge (VNFIX) verwenden weiterhin `vn-customer-texts.js`.

Abgesichert durch `test/abschlussmail-standard.test.js` (vollständige Praxis-Kälin-Mail als Referenz).

## Aufbau

```
TESTAUFTRAG (intern) – keine Zahlung, keine Rechnung. Diese Nachricht ging nur an das Test-Postfach.   ← nur interner Admin-Testauftrag

Hallo <contact_name | company>

Hier ist Ihr Abschlussbericht:

Webseiten-Check – Abschlussbericht «Check & Reparatur» (CHF 480)

Website: <order.domain>
Datum: <retest.tested_at>

Was geprüft wurde:
Ihre Startseite und die von dort verlinkten Unterseiten – Links, Navigation, Bilder, Kontaktbereich sowie die Darstellung auf Smartphone und Desktop.

Gefundene Punkte: <alle Befunde ausser Inhaltswünschen des Kunden>

Behoben wurden:
• <Befund> – behoben und erneut geprüft.          ← nur repair_status "repaired"

Nicht behoben (bitte kontaktieren Sie mich):
• <Befund>                                        ← jeder nicht reparierte Befund (offen, gescheitert, zurückgerollt, zur Prüfung)

Abschlusskontrolle:
Desktop: <in Ordnung | nicht in Ordnung> (<Prüfmethode + Auflösung>)
Smartphone: <…>

Desktop geprüft: <Ja|Nein>
Mobile geprüft: <Ja|Nein>
Erneute Prüfung nach der Reparatur (Retest): <Abgeschlossen|Nicht abgeschlossen>

<Ergebnis der Prüfung auf neue Darstellungsfehler>

<«Die Korrekturen sind auf Ihrer Website live …» nur bei deployment.deployed>

Bei Fragen genügt eine kurze Antwort auf diese E-Mail.

Freundliche Grüsse
Chris
Helvetic Webdesign
```

## Regeln (im Code umgesetzt)

1. **Gesamtzahl** = Anzahl aller Befunde des Auftrags (behoben + nicht behoben); bestätigte Inhaltswünsche (`customer_content_change`) zählen nicht als Fehler.
2. **Behoben** nur bei `repair_status === "repaired"`; zurückgerollte Fixes werden von der Engine auf `rolled_back` gesetzt und erscheinen unter «Nicht behoben».
3. **Jeder** nicht reparierte Befund wird einzeln genannt.
4. **Beschreibung:** `customer_text`, sonst `REPORT_TEXT[type]`; «Ein technischer Punkt auf …» nur für Typen ohne jede Beschreibung. Nie volle URLs (reportUnsafe).
5. **Prüfangaben** nur aus `order.retest` / `order.browser_gate`: «geprüft: Ja» nur bei bestandener Prüfung (und bestandenem Browser-Gate, falls gefordert); «Retest: Abgeschlossen» nur bei `http_ok` + Desktop ok + Mobile ok.
6. **Live-Satz** nur bei `order.deployment.deployed === true` (nach Live-Retest gesetzt).
7. **TESTAUFTRAG (intern)** und `[E2E-TEST]`-Betreff nur bei `isInternalTestOrder(order)`.
8. **Kein Erfolgsbericht ohne Abschluss:** der Bericht entsteht erst nach bestandenem Retest + `completionGate`; sonst MANUAL_REVIEW/VALIDATION_FAILED/REPAIR_FAILED und keine Mail. `reportUnsafe` sperrt vor dem Versand.
9. Der Hinweis zum Entfernen des temporären Zugangs bleibt bei `access_intake` erhalten (Sicherheit).
