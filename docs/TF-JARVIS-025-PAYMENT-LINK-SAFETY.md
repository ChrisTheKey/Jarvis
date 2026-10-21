# TF-JARVIS-025 – Zahlungslink-Ausgangsprüfung & CI

Stand: 2026-10-21 · Branch `tf-jarvis-024-stripe-live` (auf TF-JARVIS-024 `d509e127`) · öffentliches Repository: keine Secrets, Hosts oder Kundendaten.
Kein Deployment, keine Konfigurationsänderung, kein Container-Neustart, keine Zahlung, kein Kundenkontakt.

## Ergebnis

Jarvis versendet automatisch nur noch Stripe-Adressen, die **exakt** freigegeben sind. Alles andere sperrt den Versand dauerhaft, markiert den Entwurf
in Gmail mit `JARVIS-PRUEFEN` und führt beim Aufrufer zur manuellen Prüfung (nie zu «später erneut versuchen»).

| Zulässig | Bedingung |
|---|---|
| `https://buy.stripe.com/…` | einer der zwei Links aus `PAYMENT_LINKS` (CHF 150 / CHF 480), Zeichen für Zeichen so, wie `paymentLinkFor` ihn baut: optional nur gültige `client_reference_id` (Auftrags-ID) und `prefilled_email`, keine weiteren Parameter, kein Fragment |
| `https://checkout.stripe.com/…` | nur die Anzahlungs-Session (TF-080), die der **Vorlagen-Code** beim Anlegen des Entwurfs deklariert (`paymentUrls`); ein KI-Text kann keine Session freischalten |
| alles andere mit «stripe» im Hostnamen | gesperrt: anderer Pfad, Zusatz-/Doppelparameter, `http`/ohne Schema, Grossschreibung, Testlinks, `pay.stripe.com`, Doppelgänger (`stripe-zahlung.ch`, `buy.stripe.com.evil.ch`), Vollbreiten-Unicode |

## Umsetzung

| Datei | Änderung |
|---|---|
| `payment-links.js` | `paymentLinkViolations(text, { allowedCheckoutUrls })` – nur Grundcodes (`UNKNOWN_PAYMENT_LINK`, `MODIFIED_PAYMENT_LINK`, `NOT_HTTPS`, `UNDECLARED_CHECKOUT_LINK`, `UNKNOWN_PAYMENT_HOST`, …), nie URLs |
| `gmail.js` | **Letzte Sperre vor jedem Versand** (`sendOwned`: Vorlagen, KI-Antworten, Repair-Outbox, Verkäufer-Klick). Geprüft wird beim Anlegen/Ändern des Entwurfs (`paymentLinkCheck` im Register); da nur gesendet wird, wenn die Message-ID unverändert ist, ist das genau der versendete Text. Ältere Entwürfe ohne Prüfergebnis werden vollständig geladen und geprüft; nicht lesbar → gesperrt. Gesperrt bleibt gesperrt (`paymentLinkBlocked`). |
| `mail-worker.js` | KI-Antwort mit Verstoss → nie für den Auto-Versand vorgemerkt, `JARVIS-PRUEFEN`, Eskalation an Chris («nicht freigegebener Zahlungslink im Antwortentwurf») |
| `contact-form-journey.js` | deklariert die eigene Checkout-Session (`paymentUrls`) – der CHF-240-Anzahlungsweg bleibt funktionsfähig |

## Statische LIVE-Links (ohne Zahlung geprüft)

| Prüfung | Ergebnis |
|---|---|
| Format/Modus | beide `https://buy.stripe.com/<id>` ohne `test_` → LIVE; CHF 150 → `…Re00`, CHF 480 → `…Re01` (gleiches Konto-Suffix) · LOKAL GETESTET |
| Verwendung | Kontaktformular-Antworten (mit/ohne Auftrags-ID), KI-Antworten (`paymentOptions`, ohne ID), Zahlungs-Nachfassen (mit ID, Standard AUS) – Details TF-024 §4 |
| Erreichbarkeit/Betrag | **NICHT VERIFIZIERT.** Nur `HEAD` (kein Seiteninhalt, kein JavaScript): beide Links **und** ein erfundener Link liefern HTTP 200 (Stripe-Single-Page-App) – damit nicht aussagekräftig. Seite bewusst nicht geöffnet: das Laden kann eine LIVE-Checkout-Session anlegen (Stop-Bedingung). |
| Lesender Prüfweg für Chris | Stripe-Dashboard → Payment Links: Betrag CHF 150.00 / 480.00, Währung CHF, keine Mengenanpassung, keine Promo-Codes, aktiv. Alternativ mit einem nur-lesenden eingeschränkten Schlüssel `GET /v1/payment_links/<plink>` und `/line_items` (nie Full-Access-Key im Terminal). |

## Tests (LOKAL GETESTET, nur Attrappen)

- `test/tf025-payment-link-guard.test.js` (9 + Aufräumen): gültige Links und Vorlagentexte, 13 manipulierte, 7 unbekannte Varianten, Checkout-Deklaration, Versandsperre in `gmail.js` (kein `/drafts/send`, Label, Register, bleibt gesperrt, Meldung nie «Wiederholung»), `updateDraft`, Altentwürfe, unlesbarer Inhalt.
- `test/mail-worker.test.js` +2: KI-Antwort mit verändertem/unbekanntem/Doppelgänger-Link → kein Versand + Eskalation; exakter Link → normaler Versand. Mails ohne Zahlungslink: bestehende Versandtests unverändert grün.
- Gegenprobe: ohne die Sperre schlagen 6 der neuen Tests fehl.
- `test/gmail-limits.test.js`: Fixture-Entwürfe tragen jetzt das Prüfergebnis, das `createDraft` immer schreibt (sonst greift korrekt «nicht lesbar → gesperrt»).
- Volle Suite (`npm test`, Windows): **1195 Tests · 1183 ✓ · 0 ✗ · 12 übersprungen**. Ein erster Lauf zeigte zusätzlich 2 ✗ in `repair-integration-044` (ssh2-Schlüssel unter Last, unabhängig von TF-025, einzeln 17/17, im Wiederholungslauf grün).
- `scripts/secret-scan.mjs`: 342 Dateien, 0 Treffer. CI-Ergebnis: siehe Abschlussbericht der Sitzung (SHA erst nach dem Commit bekannt).

## Offene Risiken

1. Repair-Service und Mail-Worker produktiv **ohne** TF-024/025 (Mail-Worker `16f17f5`, Repair vermutlich `b2163bc`).
2. LIVE-Payment-Links: Betrag/Aktivität und LIVE-Webhook nicht verifiziert (TF-024 R4).
3. Prüfung erkennt nur Adressen mit «stripe» im Hostnamen; andere Zahlungsanbieter/Phishing-Domains ohne dieses Wort (z. B. `str1pe`) werden nicht erkannt.
4. Beim ersten Deploy werden offene Entwürfe ohne Prüfergebnis einmal vollständig geladen (eine zusätzliche Gmail-Abfrage je Entwurf); Entwürfe mit Verstoss landen in `JARVIS-PRUEFEN`.
5. TF-023 (Testmodus Ende-zu-Ende) weiterhin offen.

## Deployment-Empfehlung

Reihenfolge, jeder Schritt mit ausdrücklicher Freigabe, Fiverr-Baseline (StartedAt/Image/Restarts) vorher/nachher:

1. **Mail-Worker** zuerst (`deploy/vps/deploy.sh`) – er hält Gmail und damit die Versandsperre; ohne ihn ist die Sperre wirkungslos.
2. **Repair-Service** (`deploy/vps/deploy-repair.sh`) – TF-024-Fixes (Doppelbelastung, Inbox-Besitz).
3. Lesend prüfen: Readiness `Mail/Delivery OK`, Outbox leer, `JARVIS-PRUEFEN` in Gmail ansehen.
4. Danach TF-023 im Stripe-**Testmodus**; Live-Aktivierung erst nach bestandenem TF-023 (TF-024 §8).
