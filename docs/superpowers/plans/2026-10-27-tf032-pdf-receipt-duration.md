# TF-032 – PDF-Quittung und Bearbeitungsdauer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eine verifizierte CHF-480-PDF-Quittung sicher an die bestehende Abschlussmail anhängen und eine statusabhängige, unverbindliche Bearbeitungsdauer in der Auftragsbestätigung ausgeben.

**Architecture:** `completion-artifacts.js` prüft den CHF-480-Ledger, erzeugt deterministische Belegdaten und rendert die PDF mit der vorhandenen `pdfkit`-Abhängigkeit. `repair-workflow.js`, `repair-outbox.js` und `gmail.js` reichen eine validierte PDF-Anlage durch den bestehenden Draft-/Outbox-/Worker-Pfad. Eine reine Statusfunktion erzeugt die vier Zeitphasen und wird nur in Bestätigungs-/Onboarding-Mails verwendet; die Abschlussmail bestätigt ausschließlich den Abschluss.

**Tech Stack:** Node.js ESM, `node:test`, bestehender Zahlungsledger, Repair-Outbox, Gmail MIME, `pdfkit`, synthetische Temp-Stores.

---

### Task 1: TF-032-Spezifikation und Baseline

**Files:**
- Create: `docs/superpowers/specs/2026-10-27-tf032-pdf-receipt-duration-design.md`
- Create: `docs/superpowers/plans/2026-10-27-tf032-pdf-receipt-duration.md`

- [x] **Step 1: Architektur festschreiben**

Die Spezifikation dokumentiert Ledger-Prüfung, PDF-Rendering, bestehende Outbox-/Gmail-Kette, Statusschätzung und Fail-Closed-Gates.

- [x] **Step 2: Baseline prüfen**

Im neuen Worktree auf `db36d2c` wurden Abhängigkeiten isoliert installiert; die vorhandenen TF-028-Artefakte und `pdfkit` wurden gelesen. Vor Änderungen laufen die betroffenen TF-028-/Gmail-Tests.

- [ ] **Step 3: Spezifikations-Commit**

```powershell
git add docs/superpowers/specs/2026-10-27-tf032-pdf-receipt-duration-design.md docs/superpowers/plans/2026-10-27-tf032-pdf-receipt-duration.md
git commit -m "docs(tf032): design receipt and processing duration"
```

### Task 2: CHF-480-Quittung und PDF als rote Tests

**Files:**
- Modify: `test/tf028-completion-upgrade.test.js`
- Create: `test/tf032-pdf-receipt-duration.test.js`

- [ ] **Step 1: Synthetische Fixture definieren**

Die Fixture verwendet einen Temp-Store, einen synthetischen `REPAIR_FIX_500`-Auftrag, eine vollständige Schweizer Geschäftsadresse und ausschließlich `TEST`-Ledger-Einträge. Es werden keine echten Empfänger, URLs oder Provider aufgerufen.

- [ ] **Step 2: Rote Quittungs-/PDF-Tests schreiben**

Die Tests müssen vor der Implementierung prüfen:

```js
const receipt = buildRepairReceipt(store, order.order_id, { now: NOW });
assert.equal(receipt.status, RECEIPT_READY);
assert.equal(receipt.paid_amount_chf, 480);
assert.match(receipt.text, /Helvetic Webdesign/);
assert.match(receipt.pdf.toString("latin1", 0, 5), /%PDF-/);
assert.match(receipt.text, /Nicht mehrwertsteuerpflichtig/);
assert.equal(buildRepairReceipt(store, order.order_id, { now: NOW }).receipt_number, receipt.receipt_number);
```

Zusätzliche rote Fälle erwarten `MANUAL_REVIEW_REQUIRED` ohne PDF bei fehlender Adresse, falscher Währung, falschem Betrag, fehlendem Zahlungsdatum oder nicht passendem TEST-/LIVE-Modus.

- [ ] **Step 3: Rote Tests ausführen**

```powershell
node --test --test-concurrency=1 test/tf032-pdf-receipt-duration.test.js
```

Erwartung: gezieltes Fehlschlagen wegen der noch fehlenden CHF-480-Receipt-/PDF-Schnittstelle.

### Task 3: Quittungsdaten und PDF minimal implementieren

**Files:**
- Modify: `completion-artifacts.js`
- Test: `test/tf032-pdf-receipt-duration.test.js`

- [ ] **Step 1: Verifizierte CHF-480-Readiness implementieren**

Die Readiness verwendet `offerInfo(order.offer_class)`, `paymentSummary`, `paymentsForOrder`, `paymentCurrency`, `isTestPayment` und `config.business_profile.address`. Der bereinigte Betrag muss im passenden Modus exakt CHF 480 betragen; ohne vollständige Pflichtdaten gibt es nur `MANUAL_REVIEW_REQUIRED`.

- [ ] **Step 2: Deterministische Quittungsnummer implementieren**

Die Nummer wird aus Zahlungsdatum, `order_id`, sortierten Ledger-Payment-IDs und dem bestätigten Betrag gehasht. Sie enthält keine E-Mail-, Karten-, Stripe- oder internen Referenzwerte im Kundentext.

- [ ] **Step 3: PDF im Speicher rendern**

`PDFDocument` erzeugt eine kleine A4-PDF mit Anbieter, Inhaber, verifizierter Adresse, Kundenangabe, Nummer, Ausstellungs-/Zahlungsdatum, Leistung, CHF 480.00, tatsächlicher Zahlung und dem nicht mehrwertsteuerpflichtigen Hinweis. Das Ergebnis wird als `Buffer` und Base64-Anlage mit `application/pdf` zurückgegeben.

- [ ] **Step 4: Quittungstests grün ausführen**

```powershell
node --test --test-concurrency=1 test/tf032-pdf-receipt-duration.test.js
```

### Task 4: Abschlussmail und bestehende Versandkette

**Files:**
- Modify: `completion-artifacts.js`
- Modify: `repair-workflow.js`
- Modify: `repair-outbox.js`
- Modify: `gmail.js`
- Modify: `test/tf028-completion-upgrade.test.js`
- Modify: `test/full-order-046.test.js`
- Modify: `test/gmail.test.js`
- Modify: `test/service-separation-047.test.js`

- [ ] **Step 1: Rote Mail-/Anlagentests schreiben**

Ein verifizierter CHF-480-Abschluss liefert `attachments.length === 1`, Dateiname `quittung-<nummer>.pdf`, MIME `application/pdf`, und die PDF enthält die Quittungsdaten. Ohne Receipt bleibt `MANUAL_REVIEW_REQUIRED`. Ein bestehender Test prüft weiterhin, dass eine nicht verifizierte Reparatur keine Abschlussmail erzeugt.

- [ ] **Step 2: Anlage durch die Outbox reichen**

`createOutboxMailer.createDraft` validiert Dateiname, MIME, Größe und Base64-Inhalt und speichert die PDF als geschützten serialisierten Attachment-Wert. `processRepairOutbox` reicht ausschließlich diese Anlage an `gmail.createDraft` weiter. Claim-, Ergebnis- und Cleanup-Logik bleiben unverändert.

- [ ] **Step 3: Gmail-MIME für PDF ergänzen**

`rawMessage` erzeugt bei Anlagen `multipart/mixed` mit einem UTF-8-Textteil und einer Base64-kodierten PDF-Part. Ohne Anlagen bleibt die bisherige `text/plain`-Nachricht bytekompatibel. Headerwerte und Dateinamen werden ohne Zeilenumbrüche übernommen.

- [ ] **Step 4: Repair-Workflow binden**

`buildRepairDeliveryMail(order, { store })` erzeugt die Receipt aus dem Ledger und übergibt sie an `buildRepairCompletionMail`. `deliver` übergibt `mail.attachments` bei der Draft-Erstellung, speichert einen Hash von Text und Anlage und blockiert bei fehlender Receipt. Die vorhandenen Versand- und Statusgates bleiben bestehen.

- [ ] **Step 5: Betroffene Tests grün ausführen**

```powershell
node --test --test-concurrency=1 test/tf032-pdf-receipt-duration.test.js test/tf028-completion-upgrade.test.js test/gmail.test.js test/service-separation-047.test.js test/full-order-046.test.js
```

### Task 5: Unverbindliche Bearbeitungsdauer

**Files:**
- Modify: `completion-artifacts.js`
- Modify: `onboarding-core.js`
- Modify: `repair-workflow.js`
- Test: `test/tf032-pdf-receipt-duration.test.js`

- [ ] **Step 1: Rote Zeitangaben-Tests schreiben**

Die Tests prüfen vier Phasen und statusabhängige Änderungen:

```js
const estimate = buildProcessingDurationEstimate({ state: "ORDER_RECEIVED", access_request: null }, { now: NOW });
assert.deepEqual(Object.keys(estimate.phases), ["customer_access", "technical_work", "quality_control", "completion_delivery"]);
assert.match(estimate.text, /unverbindlich/i);
assert.match(buildCheckIntroMail({ domain: "synthetic.example", state: "ORDER_RECEIVED" }).body, /Bearbeitungsdauer/i);
assert.doesNotMatch(buildRepairCompletionMail(completeOrder, { receipt: readyReceipt }).body, /voraussichtliche Bearbeitungsdauer/i);
```

- [ ] **Step 2: Statusfunktion minimal implementieren**

Die Funktion markiert erledigte Phasen als abgeschlossen, Zugangswarten als `entfällt`/`offen`, und nutzt ansonsten eine klar unverbindliche konfigurierbare Spanne. Keine feste Liefergarantie wird behauptet.

- [ ] **Step 3: Bestätigungs-/Onboarding-Mails ergänzen**

Die Zeitangabe wird in `buildCheckIntroMail` und die CHF-480-Zugangs-/Auftragsbestätigung eingesetzt. Die Abschlussmail bleibt eine reine Abschlussbestätigung.

- [ ] **Step 4: Zeitangaben regressionssicher testen**

```powershell
node --test --test-concurrency=1 test/tf032-pdf-receipt-duration.test.js test/tf028-completion-upgrade.test.js test/onboarding-066.test.js
```

### Task 6: Vollständige Verifikation und Bericht

**Files:**
- Modify: `docs/STATUS.md`
- Create: `reports/TF-JARVIS-032/ABSCHLUSSBERICHT.md`

- [ ] **Step 1: Ausführbare Suite ausführen**

Mit vorhandenem lokalem Chromium laufen zunächst die betroffenen Tests und anschließend `node scripts/dev-check.mjs --full`. Docker-Labs werden nur nach erfolgreicher read-only Engine-/Ressourcenprüfung gestartet; bei Guard-Blockade bleiben sie `BLOCKED / NOT RUN`.

- [ ] **Step 2: Sicherheits- und Idempotenznachweis dokumentieren**

Der Bericht nennt Quittungsstatus, PDF-Nachweis, falsche Beträge/Währungen, fehlende Adresse, doppelte Entwürfe, Outbox-Claim/Worker-Verhalten, Zeitangabe, Secret-Scan, Testzahlen und Docker-Status. Keine echten Aktionen werden als erfolgt dargestellt.

- [ ] **Step 3: Finalen TF-032-Commit erstellen**

```powershell
node scripts/dev-check.mjs
git diff --check
git add completion-artifacts.js repair-workflow.js repair-outbox.js gmail.js onboarding-core.js test/tf032-pdf-receipt-duration.test.js test/tf028-completion-upgrade.test.js test/full-order-046.test.js test/gmail.test.js test/service-separation-047.test.js docs/STATUS.md docs/superpowers/specs/2026-10-27-tf032-pdf-receipt-duration-design.md docs/superpowers/plans/2026-10-27-tf032-pdf-receipt-duration.md reports/TF-JARVIS-032/ABSCHLUSSBERICHT.md
git commit -m "feat(tf032): attach verified repair receipt"
```

Nach dem Commit werden Branch, sauberer Status, Commitinhalt und der fremde Worktree erneut read-only geprüft. Kein Push, Merge oder Deployment.
