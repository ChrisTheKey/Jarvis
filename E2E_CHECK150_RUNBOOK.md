# TF-088 – Kontrollierter E2E-Erfüllungstest «Check & Anleitung» (CHF 150)

Beweist auf dem Server: bestätigte Stripe-**Testzahlung** → Audit der **Sandbox-Domain** → Bericht → Repair-Outbox → **echter Mail-Worker** → **Test-Postfach**.
Standard **AUS**. Keine fest codierte Freigabe: alles kommt aus `/opt/jarvis-payment/e2e.env` (Server) und einer ausdrücklichen Freigabe pro Auftrag.

## Sicherheitsbedingungen (ALLE müssen gelten, sonst passiert nichts)
| # | Bedingung | Wo geprüft |
|---|---|---|
| 1 | `JARVIS_E2E_TEST_ENABLED=true`, `JARVIS_E2E_TEST_DOMAINS`, `JARVIS_E2E_TEST_MAILBOXES` gesetzt | Repair-Service **und** Mail-Worker (je eigene Prüfung) |
| 2 | **Zusätzlich** `JARVIS_E2E_FULFILMENT_ENABLED=true` (separater Schalter, Standard aus) | beide |
| 3 | Auftrag: `test_order=true`, `environment=TEST`, gültige `test_run_id`, CH-CHF-150, E2E-Bestätigung (kein Verkauf) | Engine vor **jedem** Schritt |
| 4 | Domain **und** Lieferadresse stehen **jetzt** in der Allowlist, `website == https://<domain>/` | Engine vor jedem Schritt, Freigabe |
| 5 | Ausdrückliche Freigabe pro Auftrag: `--approve-e2e-fulfilment <id>` (verlangt bereits erfüllte TEST-Zahlung – löst nie eine Zahlung aus; nur 1×) | CLI |
| 6 | Versand **nur** über die Outbox (direkter Gmail-Weg für Testaufträge gesperrt) | Engine |
| 7 | Mail-Worker lehnt `e2e_run_id`/`[E2E-TEST]`-Mails ohne eigene Freigabe oder an fremde Adressen ab (`rejected`, `reason: e2e_blocked`) | Outbox-Konsument |
| 8 | Mail trägt `[E2E-TEST]` im Betreff + Banner; kein Onboarding, kein Verkauf, keine Provision, kein Umsatz, kein Repair-Pfad | Engine / Snapshot-Whitelist |

Ohne eine dieser Bedingungen: Testauftrag bleibt unberührt (TF-084-Verhalten) bzw. stoppt in `MANUAL_REVIEW_REQUIRED` (`E2E_BLOCKED`), nichts gesendet.

## Vor dem Hetzner-Test (Reihenfolge, jeweils nach deiner Freigabe)
1. Commit/Push des Codes (steht noch aus) und Queue-Prüfung wie bei TF-086 (keine laufenden Aufträge/Versände, Outbox leer).
2. Test-Postfach: ein Postfach, das du kontrollierst, **nicht** das Absender-Postfach des Mail-Workers; muss in `JARVIS_E2E_TEST_MAILBOXES` stehen.
3. Sandbox-Domain: in `JARVIS_E2E_TEST_DOMAINS`, öffentlich erreichbar, **wenige Befunde** (≥ 6 Befunde → Bericht braucht Anhang → Stopp in `READY_FOR_DELIVERY`, kein Versand – bekannte Lücke). Der Audit ist passiv (nur Abrufe von der Seite, keine Schreibzugriffe).
4. Testauftrag `CA150-…` existiert, `PAID_FULL`, `ORDER_CONFIRMED` (die vorhandene Stripe-Testzahlung – **keine neue**).
5. Schalter setzen: `deploy/vps/install-stripe-keys.sh fiverr fulfilment` (true). Der **Mail-Worker liest e2e.env erst nach einem Mail-Deploy** (`deploy.sh`, Wartungsfenster) – vorher lehnt er E2E-Mails ab (fail closed).
6. Deploy: Mail-Worker (`deploy.sh`) **vor** Repair-Service (`deploy-repair.sh`).
7. Lesende Vorprüfung: `node e2e-test.js status` in beiden Containern (`e2e_fulfilment: READY`), Outbox `consumer_online: true`, keine weiteren freigegebenen Testaufträge, Live-Aufträge unverändert.
8. Freigabe: `node check-150-workflow.js --approve-e2e-fulfilment <id>` (Repair-Container), dann Zyklus abwarten oder `--run`.
9. Prüfen: Test-Postfach (1 Mail, `[E2E-TEST]`), Auftrag `COMPLETED`/`delivery_status sent`, Outbox leer, Zahlungsbuch weiterhin 1× CHF 150, kein `sales.json`-Eintrag, CRM zeigt TEST, kein Provisionseintrag.
10. Danach: Schalter wieder auf `false` (`install-stripe-keys.sh fiverr fulfilment`) und Mail-Worker beim nächsten Wartungsfenster neu erstellen (liest env nur beim Erzeugen).

Abbruch sofort bei: Mail an eine andere Adresse als das Test-Postfach, zweite Mail, Zustand ≠ erwartet, unerwartete Live-Auftragsänderung → Auftrag `--cancel`, Schalter aus.
