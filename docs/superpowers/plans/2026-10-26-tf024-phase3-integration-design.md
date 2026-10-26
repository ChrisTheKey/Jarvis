# TF-JARVIS-024 Phase 3 – Offer-Intent-Bundle

## Ziel

Die bestehende CRM-Erstmail erhält einen persistenten Offer-Intent-Bundle mit genau zwei gebundenen Angeboten. Ein verifiziertes Stripe-Testereignis materialisiert und aktiviert genau das gewählte Paket; alle anderen Pfade bleiben geschlossen und fail-closed.

## Leitplanken

- Bestehende `createCheck150Order`, `createConfirmedRepairOrder`, `payments.js`, `stripe-webhook.js`, `access-intake.js`, Workflow-Engines und Abschlussmail wiederverwenden.
- Keine zweite Tresor- oder Zahlungslogik.
- Bundle-/Offer-Zustände persistent im Worker-State, atomar über `createStore`.
- CHF-150- und CHF-480-Anzahlungs-/Restzahlungsschwellen unverändert.
- Keine Reparatur oder Abschlussmail durch Checkout-Link/Preview allein.
- Nur synthetische Fixtures und lokale Mocks.

## Umsetzung in kleinen Schritten

1. Rote Unit-Tests für Bundle-Erstellung, idempotente Auswahl, Schliessen der Gegenofferte, Zahlungsprüfung und Tresoraktivierung schreiben.
2. `sales-intake-bundle.js` als dünne Persistenz-/Orchestrierungsschicht ergänzen.
3. Bestehende Order-Creator um eine validierte, optionale Intent-ID erweitern; keine Zustandslogik duplizieren.
4. Mail-Worker vor dem Erstmailversand Bundle anlegen und bei dauerhaftem Versandfehler schliessen.
5. Stripe-Webhook vor der bestehenden Verbuchung auflösen: Bundle-Intent materialisieren, Gegenofferte schliessen, danach unverändert durch bestehende Ledger-/Betrags-/Währungs-/Idempotenz-Gates laufen.
6. Nach CHF-480-Auswahl den bestehenden verschlüsselten Tresor mit dem vorab gebundenen, zeitlich begrenzten Token registrieren; keine Geheimnisse persistieren oder loggen.
7. Bestehende Workflow-Engines und Completion-Gates anschliessen; Abschlussmail nur über den bestehenden nachgewiesenen Erfüllungspfad.
8. Gezielte Unit-/Integrations-/Negativtests ausführen, Statusbericht aktualisieren, `dev-check` und `--full` prüfen, lokalen Commit erstellen.
