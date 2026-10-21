# TF-JARVIS-022 – Hetzner-Deployment (Bericht)

Stand: 2026-10-21 · **Ergebnis: DEPLOYED – Mail-Worker auf `16f17f5`, healthy, Fiverr unverändert.**
Ein Deployment-Durchlauf, kein Rollback nötig. Keine echten Kundenkontakte, keine Live-Zahlungen, keine Compliance-Sperre gelockert.
Das Repository ist öffentlich: Serverdetails (Pfade, Konten, Konfiguration, Backup-Orte) sind bewusst nicht aufgeführt; die Rohbelege liegen nur lokal bei Chris.

## Ponytail (global)

Nicht installiert. Quelle geprüft (`DietrichGebert/ponytail@09c434a`, v5.3.2; Hooks nur lokal, Netzwerk nur über einen optionalen, standardmässig leeren Webhook).
Die Installation wurde zweimal vom Claude-Code-Auto-Mode blockiert und nicht umgangen → Chris installiert per `/plugin marketplace add DietrichGebert/ponytail`
und `/plugin install ponytail@ponytail`.

## Release und CI

| Punkt | Wert |
|---|---|
| Branch | `tf-jarvis-021-cloud-ci` |
| Release-Commit | **`16f17f5`** (`16f17f51fbc48ea4f9258358204f0216eca6b34e`), deployt aus einem sauberen Checkout genau dieses Commits |
| CI | [39608530114](https://github.com/ChrisTheKey/Jarvis/actions/runs/39608530114) – alle 9 Jobs + Release-Gate `success` |
| Release 9cb42e9 | nicht deployt, nicht gleichgesetzt (nie in CI). `16f17f5` enthält denselben TF-016-Patch (patch-id `c413784423eb`) plus TF-088/020/021 |
| Ausgerollt (Mail-Worker cfc5b36 → 16f17f5) | TF-016 `lead-finder.js`; TF-088 E2E-Sperre im Outbox-Konsumenten (Standard AUS, fail closed). Dockerfile, Compose und Deploy-Skript unverändert, keine neuen Abhängigkeiten, keine Datenmigration |

Tests (Lauf 39608530114): Unit 1166 (1154 ✓, 0 ✗, 12 übersprungen) · E2E 1/1 · repair 18/18 · repair-quality 5/5 · separation 8/8 · browser 10/10 · full-order 8/8.

## Zustand vor dem Deployment (2026-10-21 13:59 UTC, nur lesend)

- 9 Container, alle running/healthy: 3 × Fiverr, 6 × Jarvis (mail, repair, crm, contacts, calling, vn). Jedes Projekt mit eigenem Docker-Netz; Jarvis mountet nichts von Fiverr.
- Deploy-Stände: Mail-Worker **cfc5b36**, Repair-Service **b2163bc**.
- Ressourcen ausreichend (Disk > 20 GB frei, RAM ~1,9 GB verfügbar). Produktionskonfiguration vollständig (nur Schlüsselnamen geprüft).
- Rollback-Basis vorhanden (vorheriges Image getaggt, vorheriger App-Stand), zusätzlich unmittelbar vor dem Deploy ein frisches, geprüftes Server-Backup des Mail-Stacks.

## Deployment-Gates

| # | Gate | Status |
|---|---|---|
| 1 | Pflicht-CI-Jobs erfolgreich | ✅ |
| 2 | Getesteter = Release-Commit | ✅ 16f17f5 |
| 3 | Keine ungeprüften Änderungen | ✅ |
| 4 | Keine Secrets im Repository | ✅ Secret-Scan |
| 5 | SSH-Zugang | ✅ dokumentierter Weg |
| 6 | Produktionskonfiguration vollständig | ✅ |
| 7 | Daten bleiben erhalten | ✅ Deploy ändert Daten/Secrets nicht; Backup |
| 8 | Rollback-Pfad | ✅ |
| 9 | Speicherplatz | ✅ |
| 10 | Andere Projekte unverändert | ✅ Baseline erfasst |
| 11 | Deploy-Skript geprüft | ✅ `deploy/vps/deploy.sh` |
| 12 | Serverstand eindeutig | ✅ |

## Deployment

- Umfang: **nur Mail-Worker** (freigegebener Release-Pfad B4). Repair, CRM, Contacts, Calling, VN nicht berührt.
- Zeitpunkt: **2026-10-21 14:01:51–14:02:17 UTC**, Exit-Code 0, ein Durchlauf.

## Verifikation nach dem Deployment (14:02:55 UTC)

| Prüfung | Ergebnis |
|---|---|
| Mail-Worker | healthy nach ~10 s, Restarts 0 |
| Release-SHA | Deploy-Marker und Laufzeit-Commit = **16f17f5** |
| Readiness-Check (read-only) | Core, Payments, CHF150/CHF480, Access Intake, Adapter, Profile Builder, Host-Key, Browser, Backup, Authority, Disk, Release Gate **OK**; **Mail/Delivery FAIL** (Gmail OAuth, s. u.) |
| Übrige Jarvis-Container | unverändert (StartedAt, Image, Restarts) und healthy |
| Datenintegrität | Daten, Secrets, Outbox nicht verändert; Zahlungsbuch lesbar |

### Gmail OAuth – vorbestehend, nicht durch den Deploy verursacht

Im persistenten Worker-Log erster Auth-Fehler **2026-10-20 19:26 UTC**, danach stündlich fehlgeschlagene Abrufe (zuletzt 13:52 UTC, vor dem Deploy). Status `expired_or_revoked`.
Ein Rollback würde das nicht beheben → **kein Rollback**. Behebung: neue OAuth-Zustimmung durch Chris (Blocker G1).

## Fiverr-Isolationsnachweis

| Container | StartedAt vorher = nachher | Image | Restarts |
|---|---|---|---|
| fiverr-api | 2026-10-20T10:49:21.474611444Z | unverändert | 0 |
| fiverr-litellm | 2026-10-20T10:49:21.114662155Z | unverändert | 0 |
| fiverr-worker | 2026-10-20T10:49:21.830211108Z | unverändert | 0 |

**Fiverr unverändert.**

## Rollback

Nicht ausgeführt (Healthchecks bestanden). Vorbereiteter, datenneutraler Rückweg auf cfc5b36 für den Mail-Worker ist vorhanden.

## Offene Blocker

| # | Blocker | Wer |
|---|---|---|
| G1 | ~~Gmail OAuth `expired_or_revoked`~~ → **behoben 2026-10-21 14:32 UTC** (Neuautorisierung + Token-Tausch, `MAIL AUTH READY`, Details in `TF-JARVIS-023-MANUAL-ORDER-TEST-RESULTS.md`) | erledigt |
| R1 | Repair-Service noch auf b2163bc (für TF-023 nötig: `deploy-repair.sh` von 16f17f5) | Chris (Freigabe) |
| P1 | Ponytail-Installation | Chris |
| B1–B3, B5 | Cold-E-Mail CH, CH-/VN-Calling, Stripe Live | Chris + Rechtsberatung |

## Nächste Schritte

1. Gmail OAuth neu autorisieren (G1), danach Readiness-Check → `Mail: OK`.
2. Repair-Service-Deploy von `16f17f5` nach Freigabe (R1).
3. TF-JARVIS-023 gemäss `docs/TF-JARVIS-023-MANUAL-ORDER-TEST-PLAN.md`.

## Bewertung

- TECHNICAL COMPLETION: **94 %**
- CI VERIFICATION: **100 %**
- DEPLOYMENT READINESS: **85 %** – Mail-Worker produktiv auf dem getesteten Release; offen: Repair-Update, Gmail OAuth
- BUSINESS PRODUCTION READINESS: **45 %** – ohne gültiges Gmail-OAuth keine Zustellung; dazu rechtliche Freigaben B1–B3 und Stripe Live
