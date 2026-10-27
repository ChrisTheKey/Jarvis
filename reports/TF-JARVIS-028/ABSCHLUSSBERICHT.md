# TF-JARVIS-028 – Abschlussbericht

Stand: 2026-10-27
Branch: `agent-codex/tf028`
Basis: `e8634df` (`agent-codex/tf027-integration`)
Produktionsdeployment: nicht durchgeführt

## Ergebnis

Die beiden Abschlussmail-Vorlagen, die Quittungsprüfung und der CHF-330-
Upgradepfad sind im isolierten TF-028-Branch implementiert. Der Status bleibt
`BLOCKED`: Die neuen gezielten Tests sind grün, der abschließende Vollcheck
enthält jedoch noch historische Tests, die den bisherigen Abschlussmail-
und Auftragsvertrag erwarten. Zusätzlich wurden die isolierten Docker-/Repair-
Labs nicht als bestanden gezählt.

## Architektur und geänderte Bereiche

- `completion-artifacts.js` ersetzt die bisherigen Abschlussmail-Artefakte.
  Die CHF-150-Mail wird nur bei vollständigem Prüfbericht, vollständiger
  Quittung und sicherem Upgrade-Checkout versandbereit. Die CHF-480-Mail wird
  nur bei verifizierter Reparatur und ausschließlich tatsächlich behobenen
  Problemen bereitgestellt.
- Die Quittung wird aus dem verifizierten Zahlungsledger erzeugt. Eine fehlende
  Geschäftsadresse führt zu `MANUAL_REVIEW_REQUIRED`; es wird keine Adresse
  erfunden. Es wird keine MWST berechnet oder ausgewiesen. Die Quittung enthält
  den Hinweis, dass Helvetic Webdesign nicht mehrwertsteuerpflichtig ist.
- `stripe-payments.js` erzeugt den CHF-330-Checkout serverseitig im vorhandenen
  Stripe-Pfad. Die Metadaten binden den Checkout an ursprüngliche Order-ID,
  Lead-ID, Kunden-ID soweit vorhanden, Domain, Ursprungsangebot, Upgradeangebot,
  Betrag, Währung und Umgebung.
- `upgrade-workflow.js` persistiert die eindeutige Zuordnung und macht den
  Vorgang idempotent. `stripe-webhook.js` ist die autoritative Stelle für die
  bestätigte Zahlung; Betrag, Währung, Modus, Session, Metadaten und
  Wiederholungen werden geprüft. Eine bloße Erfolgsseiten-Weiterleitung genügt
  nicht.
- `repair-workflow.js` erzeugt die CHF-480-Mail erst nach erfolgreicher,
  verifizierter Reparatur und protokolliert die tatsächliche Lösung pro Problem.
  Offene oder manuell erforderliche Punkte blockieren die Mail.
- `lead-crm.js`, `crm-service.js`, `public/crm.js` und `public/i18n.js` zeigen
  den sicheren, schreibgeschützten Abschluss-/Upgrade-/Reparaturstatus und
  offene Punkte im CRM; sie starten keine zusätzliche Versandaktion.
- Die Docker-Kopiellisten wurden um `completion-artifacts.js` und
  `upgrade-workflow.js` ergänzt.

## Sicherheitsverhalten

- Bestehende Authentifizierungs-, DNC-, Opt-out-, Versandfenster-,
  Zahlungs-, Outbox- und Browser-Gates bleiben aktiv.
- Ein bestätigtes Upgrade materialisiert den Reparaturauftrag zunächst ohne
  `customer_authorized_repair`; die bestehende Zugriffs- und
  Browserfreigabe muss weiterhin erfüllt sein.
- TEST und LIVE werden über den bestehenden Modus getrennt. Die synthetischen
  Tests verwenden ausschließlich Testdaten und Stripe-TEST-Konfiguration.
- Wiederholte Webhooks und wiederholte Versandversuche erzeugen keine zweite
  Zahlung, keinen zweiten Auftrag und keine zweite Abschlussmail.
- Es wurden keine echten E-Mails, Zahlungen oder Websiteänderungen ausgeführt.

## Verifikation

| Prüfung | Ergebnis | Exit-Code |
|---|---:|---:|
| `test/tf028-completion-upgrade.test.js` | 16/16 bestanden | 0 |
| `test/service-separation-047.test.js` | 9/9 bestanden | 0 |
| `test/vn-063.test.js` | 6/6 bestanden | 0 |
| `test/always-online-021.test.js` | 22/22 bestanden | 0 |
| `test/browser-audit-praxis002.test.js` – Engine-End-to-End mit Chromium | 1/1 bestanden | 0 |
| `test/payments-041.test.js` | 13/13 bestanden | 0 |
| `test/tf081-stripe-checkout.test.js` | 8/8 bestanden | 0 |
| `test/repair-480-035.test.js` | 17/17 bestanden | 0 |
| `test/crm-detail-059.test.js` | 10/10 bestanden | 0 |
| `test/lead-crm-053.test.js` | 22/22 bestanden | 0 |
| Secret-Scan | 391 Dateien, 0 Treffer | 0 |
| `node scripts/dev-check.mjs` | bestanden | 0 |

Der synthetische TF-028-Test deckt die Kette CHF 150 → Prüfbericht und
Quittung → CHF-330-Checkout/Webhook → RF480-Zuordnung → Reparaturfreigaben →
verifizierte Abschlussmail sowie negative Fälle für fehlende Pflichtdaten,
falsche Beträge/Währungen, unbekannte Sessions, Wiederholungen und fehlende
Zugriffsrechte ab.

Der abschließende vollständige Lauf nach den beiden Korrekturen (Docker-
Kopielliste und internes E2E-Testmailkennzeichen) endete mit Exit 1:
1.197 Tests, 1.172 bestanden, 13 fehlgeschlagen, 12 übersprungen.
Alle TF-028-Tests waren in diesem Lauf grün. Die 13 Fehler verteilen sich auf
vier historische Vertragsfälle in `full-order-046`, einen Fall in
`onboarding-066`, drei Fälle in `repair-manual-055`, einen Fall in
`repair-no-package-062` und vier Fälle in `tf088`. Diese Tests erwarten noch
den bisherigen Abschluss-/Liefervertrag, insbesondere Abschluss trotz
manueller Restpunkte oder CHF-150-Lieferung ohne vollständige TF-028-Quittung.
Die isolierten Docker-/Repair-Labs blieben übersprungen.

## Verbleibende Blocker

1. Historische Vertragstests müssen auf den neuen TF-028-Vertrag migriert oder
   bewusst als separate Legacy-Verträge gekennzeichnet werden:
   `full-order-046`, `onboarding-066` (Abschnitt 59),
   `repair-manual-055`, `repair-no-package-062` und `tf088`.
   Sie erwarten teilweise alte Mailtexte, automatische Zustellung trotz
   manueller Reparaturpunkte oder CHF-150-Abschluss ohne vollständige Quittung.
2. Die 12 Docker-/Repair-Labs wurden mangels explizitem isoliertem
   `JARVIS_REPAIR_LAB=1` nicht ausgeführt und sind daher kein Release-Nachweis.
3. Live-Gmail, Live-Stripe, produktive Geschäftsadresse, produktive Secrets,
   reale Zustellung und reale Websitezugriffe wurden absichtlich nicht geprüft.
   Dafür ist eine separate ausdrückliche Produktionsfreigabe erforderlich.

## Nächster Schritt

Zuerst die fünf historischen Testverträge gezielt auf die neuen Gates
aktualisieren und den vollständigen Check erneut ausführen. Danach die
isolierten Repair-Labs mit ausschließlich synthetischen Daten starten. Erst
wenn beide Nachweise grün sind, darf eine separate manuelle Freigabe für einen
kontrollierten Produktionsplan erwogen werden.
