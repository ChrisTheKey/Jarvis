# TF-JARVIS-023 – Vollständiger manueller Kundenauftragstest (VORBEREITET, NICHT AUSGEFÜHRT)

Stand: 2026-10-21 · Grundlage: `E2E_CHECK150_RUNBOOK.md` (TF-088), Produktionsstand nach TF-JARVIS-022.
Ziel: ein kompletter Auftrag «Check & Anleitung» (CHF 150) durch die **echte** Produktionskette – Stripe-**Testzahlung** → Auftrag → Audit einer **Sandbox-Domain** →
Bericht → Repair-Outbox → Mail-Worker → **eigenes Test-Postfach** – ohne echten Kunden, ohne Live-Zahlung, ohne Verkauf/Provision/Umsatz.

## Eingangsvoraussetzungen (alle offen bis auf 1)

| # | Voraussetzung | Stand 2026-10-21 |
|---|---|---|
| V1 | Mail-Worker auf einem CI-geprüften Stand mit TF-088 | ✅ `16f17f5` (TF-022) |
| V2 | **Gmail OAuth gültig** (`production-readiness.js`: `Mail: OK`, `Delivery: OK`) | ❌ `expired_or_revoked` seit 2026-10-20 19:26Z |
| V3 | Repair-Service auf `16f17f5` (TF-088: `e2eRunId`, `--approve-e2e-fulfilment`) per `deploy/vps/deploy-repair.sh fiverr` | ❌ läuft b2163bc |
| V4 | Test-Postfach (von Chris kontrolliert, **nicht** das Absender-Postfach) | offen – Chris nennt es |
| V5 | Sandbox-Domain, öffentlich erreichbar, **< 6 Befunde** (sonst Stopp in `READY_FOR_DELIVERY`, bekannte Anhang-Lücke) | offen – Chris nennt sie |
| V6 | Vorhandener Testauftrag `CA150-…` mit `PAID_FULL`/`ORDER_CONFIRMED` aus einer **bestehenden** Stripe-Testzahlung (keine neue Zahlung) – oder neuer Testauftrag über den Stripe-**Sandbox**-Checkout | zu prüfen (lesend) |
| V7 | Ruhige Queue: keine laufenden Live-Aufträge/Versände, Outbox leer | zu prüfen (lesend) |

## Ablauf (jeder Schritt mit eigener Prüfung; Stopp bei jeder Abweichung)

1. **Lesende Vorprüfung** (beide Container): `node production-readiness.js --no-launch`, `node e2e-test.js status`, Outbox-Status, Liste offener Aufträge,
   Fiverr-Baseline (StartedAt/Image-ID) wie in TF-022.
2. **Schalter setzen**: `JARVIS_E2E_TEST_ENABLED=true`, `JARVIS_E2E_TEST_DOMAINS=<sandbox>`, `JARVIS_E2E_TEST_MAILBOXES=<test-postfach>`,
   `JARVIS_E2E_FULFILMENT_ENABLED=true` via `deploy/vps/install-stripe-keys.sh fiverr …` (verdeckte Eingabe, nie ausgegeben).
3. **Env übernehmen**: Mail-Worker liest `e2e.env` nur beim Erzeugen → Mail-Worker neu erstellen (`deploy.sh`, gleicher Commit), danach Repair-Service (`deploy-repair.sh`).
4. **Bereitschaft**: `node e2e-test.js status` → `e2e_fulfilment: READY` in **beiden** Containern; Outbox `consumer_online: true`.
5. **Freigabe pro Auftrag** (einmalig): `node check-150-workflow.js --approve-e2e-fulfilment <CA150-id>` im Repair-Container; Zyklus abwarten oder `--run`.
6. **Manuelle Sichtprüfung** (Chris + Playwright MCP): CRM zeigt den Auftrag mit TEST-Abzeichen, Statusverlauf, Bericht.
7. **Ergebnisprüfung**: genau **1** Mail im Test-Postfach mit `[E2E-TEST]`; Auftrag `COMPLETED`/`delivery_status sent`; Outbox leer; Zahlungsbuch weiterhin 1× CHF 150 TEST;
   kein `sales.json`-Eintrag, keine Provision, kein Umsatz; Live-Aufträge unverändert; Fiverr unverändert.
8. **Zurücksetzen**: `JARVIS_E2E_FULFILMENT_ENABLED=false` (und `JARVIS_E2E_TEST_ENABLED=false`), Mail-Worker + Repair-Service neu erstellen, `e2e-test.js status` → `OFF`.
9. **Bericht** `docs/TF-JARVIS-023-MANUAL-ORDER-TEST-REPORT.md`.

## Sofortiger Abbruch bei

Mail an eine andere Adresse als das Test-Postfach · zweite Mail · Zustand ≠ erwartet · jede Änderung an einem Live-Auftrag · Live-Stripe-Aufruf ·
Fiverr-Container verändert → Auftrag `--cancel`, Schalter aus, Zustand dokumentieren.

## Nicht Teil von TF-023

Echte Kunden, Live-Zahlungen, Cold-E-Mail, Telefonie (B1–B3), Stripe-Live-Aktivierung (B5).

## Von Chris benötigt

Gmail-OAuth-Neuautorisierung (V2), Freigabe des Repair-Deploys (V3), Test-Postfach (V4), Sandbox-Domain (V5), Startfreigabe für TF-023.
