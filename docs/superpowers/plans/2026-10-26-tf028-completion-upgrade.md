# TF-JARVIS-028 – Abschlussmails und Reparatur-Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ersetze die CHF-150-/CHF-480-Abschlussartefakte durch die freigegebenen, datenbelegten Vorlagen und führe ein idempotentes CHF-330-Upgrade mit bestehender Repair-Gate-Kette ein.

**Architecture:** completion-artifacts.js validiert Quittungen und erzeugt die kundenlesbaren Abschlussinhalte aus Auftrags-, Audit- und Ledgerdaten. upgrade-workflow.js verwaltet die eindeutig gebundene CHF-330-Checkout-Session und materialisiert nach autoritativem Webhook einen CHF-480-Auftrag mit verknüpfter CHF-150-Gutschrift. Bestehende Check-, Stripe-, Repair-, Outbox- und CRM-Module werden nur an den notwendigen Übergabepunkten erweitert.

**Tech Stack:** Node.js ESM, node:test, createStore/Temp-Verzeichnisse, Payment-Ledger, Stripe-Test-Fetch-Attrappen, bestehende Repair-/Browser-Gates, Repair-Outbox und CRM-Allowlist.

---

## Verbindliche Datenregeln

- CHF 150 ist REPAIR_CHECK_150; CHF 480 ist REPAIR_FIX_500.
- Das Upgrade ist exakt CHF 330 in CHF.
- Der ursprüngliche CHF-150-Auftrag bleibt unverändert nachvollziehbar.
- Der Reparaturauftrag enthält source_check_order_id und eine live berechnete Gutschrift aus dem vollständig bezahlten Quellauftrag.
- Der CHF-330-Ledger-Eintrag wird am Reparaturauftrag mit source stripe_test_upgrade bzw. stripe_upgrade und einer eindeutigen Stripe-Referenz verbucht.
- provider_mode und test_order müssen in beiden verknüpften Aufträgen übereinstimmen.
- Geschäftsadresse, Kundenname, Zahlungsdatum und Beträge werden ausschließlich aus vorhandenen Daten gelesen.
- Fehlt die Geschäftsadresse, werden Receipt und Abschlussmail MANUAL_REVIEW_REQUIRED; der Bericht bleibt verfügbar.
- Helvetic Webdesign ist nicht mehrwertsteuerpflichtig. Die Quittung enthält nur den Hinweis Nicht mehrwertsteuerpflichtig – keine MWST erhoben und keinen MWST-Betrag.

## Dateien und Verantwortungen

Neu:
- completion-artifacts.js – Receipt-Validierung, Receipt-Nummer, CHF-150-Abschlussmail und CHF-480-Abschlussmail.
- upgrade-workflow.js – CHF-330-Konstanten, Upgrade-Datensatz, Checkout-Bindung und Repair-Auftragsaktivierung.
- test/tf028-completion-upgrade.test.js – synthetische Red-Green-Regression und vollständiger lokaler Upgrade-Test.

Zu ändern:
- check-150-workflow.js – neue CHF-150-Vorlage, Receipt-/Report-Gate, Upgrade-Link, MANUAL_REVIEW_REQUIRED-Wiederaufnahme und Statusfelder.
- stripe-payments.js – CHF-330-Session, Zweck, Metadaten und Upgrade-Idempotenz.
- stripe-webhook.js – autoritative CHF-330-Buchung und idempotente Aktivierung.
- payments.js – live berechnete Gutschrift des CHF-150-Quellauftrags.
- mail-worker.js – Upgrade-/Repair-Aufruf über die vorhandenen Worker-Pfade.
- repair-workflow.js und repair-outbox.js – Quellauftrag-/Finding-Bindung und verifizierte CHF-480-Mail.
- lead-crm.js, crm-service.js, public/crm-model.js, public/crm.js, public/i18n.js – sichere Statusanzeige und offene Punkte.
- docs/STATUS.md und reports/TF-JARVIS-028/ABSCHLUSSBERICHT.md – Status und Nachweis.

### Task 1: Receipt und CHF-150-Vorlage testgetrieben beginnen

**Files:**
- Create: test/tf028-completion-upgrade.test.js
- Create after RED: completion-artifacts.js
- Modify after RED: check-150-workflow.js

- [ ] **Step 1: Schreibe einen roten Receipt-Test.**

  Erzeuge einen synthetischen CA150-Auftrag, ein config.json business_profile mit Straße, PLZ, Ort und Land, sowie eine CHF-150-TEST-Ledgerzahlung. Erwartet werden status READY, ZAHLUNGSQUITTUNG, CHF 150.00 und der Hinweis Nicht mehrwertsteuerpflichtig – keine MWST erhoben. Der Text darf weder 8,1 % noch MWST-Nummer enthalten.

- [ ] **Step 2: Führe den gezielten Test aus und bestätige den richtigen RED-Fehler.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: gezielter Fehler, weil buildCheck150Receipt und completion-artifacts.js fehlen. Import-/Syntaxfehler zuerst korrigieren, bis der Test an der fehlenden Funktion scheitert.

- [ ] **Step 3: Implementiere die minimale Receipt-API.**

  Exportiere aus completion-artifacts.js:

      export const RECEIPT_READY = "READY";
      export const MANUAL_REVIEW_REQUIRED = "MANUAL_REVIEW_REQUIRED";
      export function receiptReadiness(store, order, { now = new Date(), providerProfile = null } = {}) {}
      export function buildCheck150Receipt(store, orderId, { now = new Date(), providerProfile = null } = {}) {}

  Validiert werden Auftrag, Kundenname, Geschäftsadresse, Ausstellungsdatum, Zahlungsdatum, CHF-Währung, passender Provider-Modus und exakt CHF 150 RECEIVED. Die Quittungsnummer wird deterministisch aus Auftrag und Zahlungsdaten gebildet; keine Secrets werden gespeichert.

- [ ] **Step 4: Führe den Receipt-Test GREEN aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: der Receipt-Test besteht; Folgefälle dürfen noch rot sein.

- [ ] **Step 5: Ergänze rote Tests für fehlende Adresse und Teilzahlung.**

  Ohne vollständige business_profile.address muss status MANUAL_REVIEW_REQUIRED sein und die fehlende Geschäftsadresse als reason enthalten. Bei CHF 75 muss das Dokument Zahlungsbestätigung heißen, paid_amount_chf 75 und open_amount_chf 75 ausweisen und darf nicht als vollständig bezahlt gelten.

### Task 2: CHF-150-Abschlussmail und Versandfreigabe

**Files:**
- Modify: completion-artifacts.js
- Modify: check-150-workflow.js
- Test: test/tf028-completion-upgrade.test.js

- [ ] **Step 1: Schreibe rote Assertions für die freigegebene Vorlage.**

  Zwei synthetische Findings mit kritischer, hoher, mittlerer und geringer Priorität prüfen die exakten Überschriften Umfang, Zusammenfassung, Festgestellte Probleme und Abschließender Hinweis, jeden PROBLEM-Block, Anleitungsschritte, Prioritätssummen, CHF-330-Angebot, Quittung und Signatur. Der alte Mailtext und der Platzhalter PERSONALISIERTER STRIPE-CHECKOUT-LINK müssen fehlen.

- [ ] **Step 2: Führe den Vorlage-Test rot aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: Fehler an fehlenden neuen Überschriften oder dynamischen Feldern.

- [ ] **Step 3: Implementiere die neue CHF-150-Darstellung.**

  buildCheck150Report erzeugt pro gespeichertem Finding genau einen Block mit Wo, Was Besucher erleben, So beheben Sie es, Aufwand, Schritt-für-Schritt-Anleitung und Danach prüfen. Prioritäten werden aus den tatsächlichen Findings summiert. Keine nicht geprüften Punkte werden ergänzt.

  buildCheck150CompletionMail verbindet Report, vollständige Receipt und den vom Upgrade-Adapter gelieferten persönlichen CHF-330-Link. Ein statischer Payment-Link ist kein Fallback.

- [ ] **Step 4: Erzwinge das Versand-Gate.**

  Vor DELIVERY_DRAFT_CREATED müssen Report, Receipt READY, vollständige CHF-150-Zahlung, Empfänger und Upgrade-Link vorhanden sein. Bei fehlender Geschäftsadresse bleiben Report und Anleitung gespeichert, der Auftrag erhält MANUAL_REVIEW_REQUIRED, blocked_reason nennt die Adresse und es wird weder Draft noch Sendstatus erzeugt. Ein späterer Worker-Lauf nimmt den Zustand nach Profilergänzung wieder auf.

- [ ] **Step 5: Führe die neuen und bestehenden CHF-150-Tests aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js test/payments-041.test.js

  Expected: neue Vorlage-/Receipt-Gates sowie bestehende Zahlungs- und DNC-Sperren bestehen.

### Task 3: Eindeutige CHF-330-Checkout-Session

**Files:**
- Modify: stripe-payments.js
- Create after RED: upgrade-workflow.js
- Test: test/tf028-completion-upgrade.test.js

- [ ] **Step 1: Schreibe rote Session-Tests.**

  Der synthetische Stripe-Fetch muss purpose REPAIR_UPGRADE, source_order_id, lead_id, customer_id sofern vorhanden, domain, source_offer REPAIR_CHECK_150, upgrade_offer REPAIR_FIX_500, upgrade_amount_chf 330, environment TEST, amount_total 33000 und currency chf sehen. Eine Session ohne Originalauftrag oder ein falscher Modus wird abgewiesen.

- [ ] **Step 2: Führe die Session-Tests rot aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: Fehler an fehlendem Upgrade-Purpose oder fehlender Session-Funktion.

- [ ] **Step 3: Erweitere stripe-payments.js minimal.**

  Ergänze UPGRADE_PURPOSE = REPAIR_UPGRADE, UPGRADE_AMOUNT_CHF = 330, upgradeIdempotencyKey(orderId, mode) und createUpgradeCheckoutSession({ env, sourceCheck, lead, mode, origin, fetchFn, now }). Die Funktion nimmt Betrag und Zuordnung ausschließlich aus serverseitigen Daten, nutzt dieselbe Capability-/Hosted-Checkout-Schicht und gibt ohne Testadapter keine Test-URL zurück.

- [ ] **Step 4: Persistiere den Upgrade-Datensatz.**

  upgrade-workflow.js exportiert UPGRADE_FILE = repair_upgrades.json, createUpgrade(store, { sourceCheckOrderId, lead, checkout, now }), upgradeForSession(store, sessionId) und upgradeStatus(store, sourceCheckOrderId). Wiederholte Erstellung liefert den bestehenden offenen Datensatz und keine zweite Session.

- [ ] **Step 5: Führe Session- und Idempotenztests GREEN aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: eindeutige Bindung, TEST-/LIVE-Trennung und wiederholte Erstellung bestehen; kein externer Netzaufruf.

### Task 4: Upgrade-Webhook und Zahlungsgutschrift

**Files:**
- Modify: stripe-payments.js
- Modify: stripe-webhook.js
- Modify: payments.js
- Modify: upgrade-workflow.js
- Test: test/tf028-completion-upgrade.test.js

- [ ] **Step 1: Schreibe rote Webhook-Tests.**

  Ein signiertes synthetisches checkout.session.completed-Event über CHF 330 TEST muss einen RF480-Auftrag mit source_check_order_id und genau einem Upgrade-Ledger-Eintrag erzeugen. Die live berechnete Reparaturzahlung muss CHF 150 Gutschrift plus CHF 330 Upgrade ergeben.

  Falscher Betrag, EUR, unpaid, unbekannte Session, falsche lead_id/Domain, falscher Modus, falsche Signatur, wiederholte Event-ID und wiederholte Payment-Intent-ID dürfen keine zweite Buchung oder Aktivierung erzeugen.

- [ ] **Step 2: Führe die Webhook-Tests rot aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: Fehler, weil der Upgrade-Zweck noch nicht normalisiert und verbucht wird.

- [ ] **Step 3: Erweitere die sichere Stripe-Metadaten-Allowlist.**

  cleanMeta und normalizeCheckoutEvent übernehmen nur formatierte Upgrade-Schlüssel und speichern keine Kunden- oder Zahlungsgeheimnisse. Andere Metadaten werden verworfen.

- [ ] **Step 4: Implementiere die autoritative Buchung.**

  bookCheckout delegiert purpose REPAIR_UPGRADE an eine eigene Funktion, die Session-Historie, Mode, Metadata, Betrag, Währung und payment_status prüft. Danach wird genau ein RF480-Auftrag materialisiert. Er erhält source_check_order_id, lead_id, Domain/Website und customer_authorized_repair=false; der Webhook setzt kein Zugriffs- oder Browser-Gate.

- [ ] **Step 5: Implementiere die live berechnete Gutschrift.**

  payments.js berücksichtigt bei einem Repair-Auftrag mit source_check_order_id nur aktuell RECEIVED- und modusgleiche Zahlungen des vollständig bezahlten Quellauftrags plus eigene Repair-Zahlungen. Void/Refund des Quellauftrags entfernt die Gutschrift beim nächsten Lesen. Es wird kein fingierter Kredit-Ledger-Eintrag geschrieben.

- [ ] **Step 6: Führe Webhook-, Ledger- und bestehende Stripe-Tests GREEN aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js test/tf081-stripe.test.js test/payments-041.test.js

  Expected: CHF-330-Buchung, Gutschrift, falsche Events und Wiederholungen bestehen; bestehende CHF-240-/CHF-480-Gates bleiben grün.

### Task 5: Reparatur nur über die bestehende Gate-Kette starten

**Files:**
- Modify: upgrade-workflow.js
- Modify: mail-worker.js
- Modify: repair-workflow.js
- Test: test/tf028-completion-upgrade.test.js

- [ ] **Step 1: Schreibe rote Gate-Tests.**

  Nach einer gültigen CHF-330-Buchung bleibt der Reparaturauftrag bei fehlender Kundenfreigabe, fehlendem Tresorzugang, fehlendem Backup oder fehlendem Browser-Gate blockiert. Sobald ausschließlich die bestehenden Voraussetzungen synthetisch erfüllt sind, darf der vorhandene Repair-Worker den Auftrag aufnehmen. Der Upgrade-Webhooks selbst darf keine Gates setzen oder überspringen.

- [ ] **Step 2: Führe die Gate-Tests rot aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: fehlende Quellauftragsbindung oder ein unzulässiger direkter Reparaturstart wird sichtbar.

- [ ] **Step 3: Verbinde Upgrade und vorhandenen Repair-Worker.**

  Materialisiere ausschließlich die minimal erforderlichen Repair-Felder. Übergib den Auftrag an runRepairOrders/createRepairEngine über den bestehenden mail-worker-/Repair-Pfad. customer_authorized_repair bleibt bis zum vorhandenen sicheren Freigabeprozess false. Keine neuen Bypass- oder Auto-Authorize-Pfade.

- [ ] **Step 4: Führe den Gate-Test GREEN aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: ungültige Voraussetzungen blockieren; ein synthetisch vollständig freigegebener Auftrag läuft nur durch die vorhandenen Sicherheits- und Browser-Gates.

### Task 6: CHF-480-Abschlussmail erst nach verifizierter Reparatur

**Files:**
- Modify: completion-artifacts.js
- Modify: repair-workflow.js
- Modify: repair-outbox.js
- Test: test/tf028-completion-upgrade.test.js

- [ ] **Step 1: Schreibe rote Abschlussmail-Tests.**

  Vor completionGate/technischer Verifikation ist keine CHF-480-Mail versandbereit. Nach einem synthetisch erfolgreichen Repair-Lauf enthält sie exakt Kundenname, Website, tatsächliche Finding-Anzahl, alle dokumentierten Probleme, nur tatsächlich ausgeführte Lösungen und die unveränderte Signatur. Nicht reparierte oder nicht verifizierte Findings bleiben blockiert.

- [ ] **Step 2: Führe die Mail-Tests rot aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js

  Expected: bisherige generische Repair-Mail oder ein fehlendes completionGate wird als Fehler erkannt.

- [ ] **Step 3: Erzeuge das CHF-480-Artefakt datenbelegt.**

  Implementiere buildRepairCompletionMail ausschließlich aus dem abgeschlossenen Repair-Auftrag, dem Originalbericht und den protokollierten Finding-Lösungen. Die Funktion weist unverifizierte oder fehlende Lösungsdaten mit MANUAL_REVIEW_REQUIRED ab. Die vorhandene repair-outbox-Idempotenz und Statusverfolgung bleiben der einzige Versandpfad.

- [ ] **Step 4: Führe Idempotenz und Erfolgs-Gate GREEN aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js test/repair-480-035.test.js

  Expected: genau ein freigabefähiger Abschlussentwurf nach erfolgreicher Reparatur; erneute Worker-Läufe erzeugen keine zweite Mail.

### Task 7: CRM-Status und offene Quittungsangaben sicher anzeigen

**Files:**
- Modify: lead-crm.js
- Modify: crm-service.js
- Modify: public/crm-model.js
- Modify: public/crm.js
- Modify: public/i18n.js
- Test: test/tf028-completion-upgrade.test.js

- [ ] **Step 1: Schreibe rote CRM-Tests.**

  Ein Lead mit fehlender Geschäftsadresse erhält im sicheren CRM-Modell `MANUAL_REVIEW_REQUIRED` und einen offenen Punkt zur Geschäftsadresse. Ein vollständiger Auftrag zeigt Quittungsstatus, CHF-330-Upgrade-Status, Repair-Status und Abschlussmail-Status. Ausgaben dürfen keine Tokens, Zugangstresor-Geheimnisse oder unmaskierten Provider-Referenzen enthalten.

- [ ] **Step 2: Implementiere ausschließlich die Read-only-Allowlist-Erweiterung.**

  Join von Check-/Upgrade-/Repair-Status erfolgt nur über exakte Lead-/Auftrags-IDs. `public/crm-model.js` erhält nur sichere, für die Statusanzeige notwendige Felder; bestehende Kontakt-, DNC-, Opt-out- und Versandfreigaben bleiben unverändert.

- [ ] **Step 3: Ergänze die minimale UI-Anzeige.**

  Das geöffnete Leadpanel zeigt offene Quittungsangaben und die Zustände Bereit, MANUAL_REVIEW_REQUIRED, Wird verarbeitet, Reparatur blockiert oder Abschlussmail bereit. Die UI startet keinen Versand und keine Reparatur automatisch.

- [ ] **Step 4: Führe den CRM-Test GREEN aus.**

  Run: node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js test/crm-detail-059.test.js

  Expected: sichere Statusanzeige und bestehende CRM-Regressionen bestehen.

### Task 8: Vollständige synthetische Abnahme und Nachweis

**Files:**
- Modify: test/tf028-completion-upgrade.test.js
- Create: reports/TF-JARVIS-028/ABSCHLUSSBERICHT.md
- Modify: docs/STATUS.md

- [ ] **Step 1: Führe den synthetischen End-to-End-Test aus.**

  Durchlaufe CHF 150 → Prüfbericht → vollständige/gesperrte Quittung → CHF-330-Test-Checkout → signiertes Webhook → Repair-Gates → synthetische Reparatur und Verifikation → CHF-480-Abschlussentwurf. Prüfe zusätzlich falsche Beträge/Währungen, unbekannte Sessions, falsche Zuordnung, wiederholte Events, fehlenden Zugang, Browser-Gate, fehlgeschlagene Reparatur und doppelte Abschlussmails.

- [ ] **Step 2: Führe die relevanten Regressionen und Sicherheitsprüfungen aus.**

  Run: `node scripts/run-unit-tests.mjs --test-concurrency=1 test/tf028-completion-upgrade.test.js test/payments-041.test.js test/tf081-stripe.test.js test/repair-480-035.test.js test/crm-detail-059.test.js`

  Run: `node scripts/secret-scan.mjs`

  Run: `node scripts/dev-check.mjs --full` with the process-local Chromium path only when a browser check is part of the available suite. No production browser, mail, payment, SSH or deployment action.

- [ ] **Step 3: Dokumentiere ausschließlich nachgewiesene Ergebnisse.**

  Der Abschlussbericht nennt ersetzte Vorlagen, Implementierungsorte, Upgrade-Bindung, Gate-Kette, Test-/Exit-Codes, fehlende Nachweise und verbleibende Risiken. Nicht verifizierte Live-Zustellung, Live-Zahlung, echte Kundenaktionen und produktive Reparaturen werden ausdrücklich als nicht geprüft markiert.

- [ ] **Step 4: Aktualisiere Status und committe nur TF028-Eigentum.**

  `docs/STATUS.md` erhält den finalen TF028-Status. Vor dem Commit: `node scripts/dev-check.mjs`, `git diff --check`, Secret-Scan und gezielte Tests erneut prüfen. Keine fremden Änderungen stage'n; kein Push, Merge oder Deployment.

  Expected: Der Bericht ist reproduzierbar, der Produktionsstatus ist nur dann READY, wenn alle verpflichtenden lokalen Gates nachweisbar grün sind; sonst BLOCKED mit den tatsächlich verbleibenden Blockern.
