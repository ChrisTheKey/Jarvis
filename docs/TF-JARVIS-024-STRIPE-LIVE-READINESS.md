# TF-JARVIS-024 – Stripe-Live-Bereitschaft

Stand: 2026-10-21 · Branch `tf-jarvis-024-stripe-live` (Basis `64eb42c` = TF-JARVIS-023, enthält den produktiven Mail-Worker-Release `16f17f5`)
Öffentliches Repository: keine Secrets, keine Hosts/IPs, keine Kundendaten. Es wurde **nichts** deployt, kein Schlüssel installiert, keine Zahlung und keine Live-Checkout-Session erzeugt.

**Empfehlung: NO-GO für Live-Zahlungen** (Begründung in §11) – **GO** für den nächsten Schritt: Freigabe des Repair-Deploys mit diesen Fixes, danach TF-023 im Stripe-**Testmodus**.

Legende: **LOKAL GETESTET** = automatisierte Tests mit Attrappen auf diesem PC · **PRODUKTIV VERIFIZIERT** = heute auf Netlify/Hetzner beobachtet · **NICHT VERIFIZIERT** = weder noch.

## 1. Aktueller technischer Stripe-Status

Jarvis hat zwei getrennte Stripe-Wege (bestehende Produktdefinition, unverändert):

| Weg | Angebot | Betrag an Stripe | Preisquelle | Braucht Secret Key? |
|---|---|---|---|---|
| A – Anzahlungs-Checkout (TF-080) | «Check & Reparatur» CHF 480, bestätigter Auftrag aus dem Kontaktformular | **CHF 240.00** (erste Hälfte), serverseitig erzeugte Checkout Session | `pricing.js` | **ja** (`STRIPE_SECRET_KEY`, nur Repair-Service) |
| B – statische Payment Links (TF-081) | «Check & Anleitung» CHF 150 / «Check & Reparatur» CHF 480 | voller Festpreis, **im Stripe-Dashboard festgelegt** | Stripe-Dashboard (Jarvis prüft den Betrag beim Webhook) | **nein** – nur Webhook-Secret auf Netlify |

- Es gibt **keine** serverseitige Checkout Session für CHF 150 – das ist so definiert (Payment Link), keine Abweichung im Code. Abweichung zur Aufgabenstellung (§3 «Jarvis erstellt serverseitig eine Checkout Session») dokumentiert, nicht still geändert.
- Zahlungsnachweis ist ausschliesslich ein **signierter Webhook** (Netlify `/api/payments` → Inbox → Repair-Service) oder der autoritative Abruf der Session bei Stripe. Die Rückkehrseite `zahlung.html` schaltet nichts frei.
- `deploy/vps/install-stripe-keys.sh` kennt **bereits** einen `live`-Modus. Die Ausgangslage «akzeptiert ausschliesslich Testschlüssel» gilt nur für den Aufruf mit `test`.

## 2. Nachgewiesen funktionierende Komponenten

| Komponente | Nachweis | Stufe |
|---|---|---|
| Stripe-API-Authentifizierung LIVE (Full-Access-Key) | manueller `GET /v1/account` → HTTP 200 (Ausgangslage, **nicht erneut geprüft**) | Angabe Chris |
| Netlify `/api/payments` erreichbar, GET ohne Sitzung → 401 | heute abgefragt | **PRODUKTIV VERIFIZIERT** |
| Netlify `/api/payments` POST ohne Signatur → **400 `INVALID_SIGNATURE`** (TF-080: noch 503) ⇒ mindestens **ein** Stripe-Webhook-Secret ist auf Netlify gesetzt | heute abgefragt (kein Inhalt gespeichert) | **PRODUKTIV VERIFIZIERT** – welches (LIVE/TEST) **nicht verifiziert** |
| `zahlung.html` live, rein informativ | heute abgerufen | **PRODUKTIV VERIFIZIERT** |
| Checkout CHF 480 (Anzahlung 24000 Rappen, CHF, Metadaten, Idempotenz, genau eine Session) | `test/tf024-stripe-live.test.js` | LOKAL GETESTET |
| CHF 150 / CHF 480 über Payment Link, Zuordnung nur über `client_reference_id` | tf024 + `tf081-stripe.test.js` | LOKAL GETESTET |
| Signaturprüfung (HMAC-SHA256, Zeittoleranz 300 s, timing-safe, LIVE/TEST-Secret ↔ `livemode`) | tf024 + tf080 | LOKAL GETESTET |
| Duplikat-/Idempotenzschutz (Ereignis-ID, Inbox-Schlüssel, Referenz `stripe:<payment_intent>`) | tf024 + tf080/081 | LOKAL GETESTET |
| Reparatur startet nie allein durch Zahlung (Zahlung ≠ Freigabe; sicherer Zugang + Pflicht-Zustimmung + Domain-Bindung; geschützte Bereiche nur mit Zusatzfreigabe) | Code-Review `repair-workflow.js`, bestehende Tests | LOKAL GETESTET |

## 3. Noch nicht getestete / nicht verifizierte Komponenten

| Punkt | Stufe | Warum |
|---|---|---|
| Hetzner: Container-Status, Repair-Stand, `stripe.env`-Schlüsselnamen, `node stripe-webhook.js status` | **NICHT VERIFIZIERT** | Lesender SSH-Zugriff wurde in dieser Sitzung vom Claude-Code-Auto-Mode blockiert (nicht umgangen). Letzter bekannter Stand (TF-022): Repair-Service `b2163bc`, Stripe LIVE/TEST NOT_CONFIGURED |
| Netlify: welche Variablen gesetzt sind (`STRIPE_WEBHOOK_SECRET` / `STRIPE_TEST_WEBHOOK_SECRET` / `PAYMENT_MONITOR_PROVIDER`) | **NICHT VERIFIZIERT** | Netlify-CLI nicht installiert; nur indirekt (400 statt 503) |
| Stripe-Dashboard: registrierter Webhook-Endpunkt (LIVE/TEST), aktivierte Ereignisse | **NICHT VERIFIZIERT** | kein Dashboard-Zugriff; bewusst kein Live-API-Aufruf |
| Stripe-Dashboard: Betrag/Währung der beiden Payment Links (CHF 150.00 / 480.00, keine Mengenanpassung, keine Promo-Codes) | **NICHT VERIFIZIERT** | Jarvis lehnt Abweichungen ab (`AMOUNT_MISMATCH`), korrekt muss es trotzdem im Dashboard sein |
| Echte Stripe-Checkout-Seite, TWINT/Karte, echte Webhook-Zustellung | **NICHT VERIFIZIERT** | nur mit TF-023 (Testmodus) bzw. Live-Pilot |
| Kompletter Auftrag Ende-zu-Ende in Produktion (TF-023) | **NICHT VERIFIZIERT** | V3–V7 offen |

## 4. Gefundene Sicherheitsrisiken

| # | Risiko | Schwere | Status |
|---|---|---|---|
| R1 | **Doppelbelastung still verbucht:** War das Gate schon durch eine andere Zahlung erfüllt (Payment Link CHF 480, Banküberweisung), verbuchte `bookCheckout` eine danach bezahlte, noch offene CHF-240-Session trotzdem (Payment Links hatten diesen Schutz bereits). | mittel | **behoben** (§5) |
| R2 | **`payment-reconcile.js pull` quittierte auch Checkout-Ereignisse.** Im Mail-Worker-Container (anderer Zustand) landeten Payment-Link-Zahlungen als `UNKNOWN_SESSION` und waren für den Repair-Service verloren; im Repair-Container lief die CLI ohne Lock parallel zum Service. | mittel | **behoben** (§5) |
| R3 | **LIVE-Aktivierung ohne Rückfrage, kein Rollback:** `install-stripe-keys.sh … live` setzte den Schlüssel und startete den Repair-Service sofort neu. Ab dann erhalten alle bestätigten CHF-480-Aufträge automatisch eine LIVE-Checkout-Session per Kundenmail. | mittel | **behoben** (§5) |
| R4 | **Live-Geld fliesst evtl. schon heute:** Kontaktformular-Auto-Antworten und Antwortentwürfe enthalten die statischen **LIVE**-Payment-Links (CHF 150/480). Sind die Links in Stripe aktiv, können Kunden zahlen, auch ohne Secret Key. Ohne Auftrags-ID (`client_reference_id`) landet jede solche Zahlung in der Prüfung (nie automatisch verbucht). Ob Jarvis sie überhaupt sieht, hängt am LIVE-Webhook (§3, nicht verifiziert). | hoch (organisatorisch) | **offen** – Chris prüft Dashboard + Webhook, Zahlungseingänge in Stripe manuell mit `payment-reconcile.js reviews` / `stripe-webhook.js status` abgleichen |
| R5 | **Full-Access-Key:** Jarvis braucht nur `POST /v1/checkout/sessions` und `GET /v1/checkout/sessions/:id`. Ein kompromittierter Full-Access-Key erlaubt Rückerstattungen, Auszahlungen, Kundendaten. | mittel | **Empfehlung:** eingeschränkter Schlüssel `rk_live_…` mit nur «Checkout Sessions: Write» (Jarvis unterstützt `rk_live_` bereits; getestet). Nicht eigenmächtig ersetzt. |
| R6 | Payment-Link-Preis wird im Dashboard gepflegt, nicht im Code. | niedrig | Jarvis verbucht nur exakt 15000/48000 Rappen CHF; alles andere → `AMOUNT_MISMATCH` (getestet) |
| R7 | Overpayment-Fall (R1) erzeugt eine Prüfung, aber keine automatische Rückerstattung und die offene Session wird nicht bei Stripe beendet. | niedrig | bewusst (nie automatisch erstatten); Chris erstattet im Dashboard |
| R8 | Netlify-Inbox kürzt auf 2000 Einträge (`INBOX_KEEP`); bei Rückstau könnten älteste ausstehende Ereignisse verdrängt werden. | niedrig | offen (Repair-Service holt alle 2 min ab; Session-Abgleich alle 10 min als Fallback) |
| R10 | **KI-Antworten mit Zahlungslink ohne Nachprüfung:** Reply-Aufgaben erhalten `paymentOptions()` (Links ohne Auftrags-ID); in «compliant threads» werden Antworten automatisch versendet. Es gibt keine Prüfung, dass jeder `buy.stripe.com`-Link in der fertigen Mail exakt einem Eintrag aus `PAYMENT_LINKS` entspricht (verändert/erfunden → fremde oder kaputte Zahlungsadresse beim Kunden). | mittel | **offen** – Empfehlung: Ausgangsprüfung «nur offizielle Links, sonst eskalieren» (eigener Auftrag, nicht in TF-024 umgesetzt) |
| R9 | Uncommittete lokale Arbeit im Haupt-Checkout (`stripe-payments.js` Checkout-Studio-Parameter + `ui_mode`-Prüfung, `STRIPE_INTEGRATION_TODO.md`) ist **nicht** Teil eines Releases und nicht Teil dieses Branches. | – | Entscheidung Chris (separat committen/testen) |

### Statische LIVE-Payment-Links (CHF 150 / CHF 480) – Verwendung und Risiken

Quelle: `payment-links.js` `PAYMENT_LINKS` (zwei `https://buy.stripe.com/…`-Links ohne `test_`, öffentlich im Repository – kein Secret). Testlinks sind bewusst ausgeschlossen (nur CLI `check-150-workflow.js --create-test`).

| Verwendung | Datei | Auftrags-ID im Link? | Versand | Folge einer Zahlung |
|---|---|---|---|---|
| Kontaktformular-Antwort mit zugeordnetem, unbezahltem CH-Auftrag | `contact-form.js` `paymentContextOf` → `composeReply` | **ja** (`client_reference_id`) | automatisch bei `autoReply` (laut TF-077B live aktiv) | automatische Zuordnung, wenn Betrag/Modus/Auftrag stimmen |
| Kontaktformular-Antwort ohne Auftrag, Formular mit `offer_links` | dto. (Paket aus «Interesse an», sonst beide) | nein (nur `prefilled_email`) | automatisch bei `autoReply` | **immer** `PAYMENT_LINK_NO_REFERENCE` → Prüfung durch Chris |
| KI-Antwort in Mail-Threads (Reply-Aufgabe) | `mail-worker.js` → `paymentOptions()`, Regeln in `mail-writer.md` | nein | Entwurf; Auto-Versand nur in «compliant threads» ohne Eskalation | immer Prüfung (keine Referenz); R10 |
| Zahlungs-Nachfassen | `payment-followup.js` | ja | nur wenn `paymentFollowup.enabled` (Standard AUS; Produktivwert nicht verifiziert) | automatische Zuordnung |
| Nie | Reparatur-Interesse (`REPAIR_INTEREST`), E2E-Testläufe, VN-Anfragen, bezahlte/stornierte Aufträge | – | – | – |

Risiken: (a) Zahlungen über diese Links funktionieren **ohne** Secret Key – Live-Geld kann also schon heute fliessen (R4); (b) ohne Auftrags-ID nie automatische Leistung, Kunde wartet bis Chris prüft; (c) ob Jarvis die Zahlung überhaupt sieht, hängt am LIVE-Webhook (nicht verifiziert); (d) Preis im Dashboard gepflegt (R6); (e) `client_reference_id` ist im Link vom Kunden änderbar – verbucht wird nur auf einen existierenden, bezahlbaren Auftrag mit exakt passendem Betrag, sonst Prüfung; (f) KI-Antworten ohne Link-Nachprüfung (R10); (g) öffentliche, nicht ablaufende Links → Stripe Radar für Kartentests aktiv lassen.

Geprüft und **in Ordnung** (kein Schutz entfernt oder abgeschwächt): Secret Key nur serverseitig (Repair-Container, root 0600, nie im Deploy-Archiv) · Webhook-Secrets nur Netlify · `sk_/rk_live_` vs. `sk_/rk_test_` strikt getrennt (falsches Präfix = NOT_CONFIGURED) · kein `pk_` im Code (gehostete Checkout-Seite) · Testauftrag ↔ Testzahlung in beiden Richtungen gesperrt · Beträge nur aus `pricing.js`, Antwort von Stripe wird geprüft (Betrag, Währung, `livemode`, URL, Auftrag) · CHF only, keine Umrechnung · Logs/Status nur Codes und Zählwörter · Rückerstattung/Streitfall → Auftrag angehalten, nie automatisch erstattet.

## 5. Implementierte Verbesserungen (Branch `tf-jarvis-024-stripe-live`, nicht deployt)

| Datei | Änderung |
|---|---|
| `stripe-webhook.js` | `bookCheckout`: ist das Gate bereits durch eine **andere** Zahlung erfüllt → `PAYMENT_REVIEW_REQUIRED` / `DUPLICATE_PAYMENT`, nichts verbucht. Wiederholungen derselben Zahlung bleiben `ALREADY_RECORDED`. (R1) |
| `payment-reconcile.js` | `pull` verarbeitet und quittiert nur noch Altereignisse (TF-068); Checkout-Ereignisse bleiben für den Repair-Service in der Inbox. (R2) |
| `deploy/vps/install-stripe-keys.sh` | `live`: zuerst lesende Vorprüfung (`stripe-webhook.js status` im Repair-Container), dann getippte Freigabe `LIVE AKTIVIEREN`, sonst nichts geändert. Neu `live-off`: entfernt `STRIPE_SECRET_KEY` (Rollback, mit Rückfrage) und startet den Repair-Service **nur** neu, wenn der Schlüssel wirklich entfernt wurde. Die Vorprüfung läuft mit `ssh -n` (liest nie Bestätigung/Schlüssel mit – beim Stub-Test gefunden). Verdeckte Eingabe unverändert. (R3) |
| `test/tf024-stripe-live.test.js` | neue Suite (16 Tests + Aufräumen), §6 |

Keine neuen Abhängigkeiten, keine Datenmigration, keine Preis-/Produktänderung, keine Architekturänderung.

## 6. Testergebnisse (LOKAL GETESTET, nur Attrappen)

`test/tf024-stripe-live.test.js` – **16/16 bestanden**. Gegenprobe: gegen den unveränderten Release-Code schlagen genau die zwei Tests zu R1 und R2 fehl.

| Anforderung | Test |
|---|---|
| CHF 150 Checkout | Payment Link LIVE → 150.00 CHF auf den CHECK-Auftrag, Gate CHF 75 |
| CHF 480 Checkout | LIVE-Session 24000 Rappen CHF, Metadaten, Idempotenz, genau eine Session |
| Korrekte CHF-Beträge | `pricing.js` 150/480, Anzahlung 240; VN/CHF-150 ohne Session |
| Erfolgreiche Zahlung | signierter LIVE-Webhook → eine Buchung, Gate offen |
| Fehlgeschlagene Zahlung | nichts verbucht, genau eine Ersatz-Session, danach `EXPIRED_FINAL` |
| Abgebrochener Checkout | keine Buchung ohne Ereignis; `zahlung.html` ohne Skript; `expired` → `EXPIRED` |
| Ungültige Signatur | verändert / fehlend / falsches Secret / abgelaufen / LIVE mit TEST-Secret → 400, Inbox leer |
| Doppelte Zustellung | gleiche Ereignis-ID, neue Ereignis-ID, `async_payment_succeeded`, Abgleich → eine Buchung |
| Unbekannte Bestellnummer | `UNKNOWN_SESSION`, `UNKNOWN_ORDER`, `PAYMENT_LINK_NO_REFERENCE` |
| Manipulierte Preise | Betrag/Währung/Metadaten im Ereignis, gefälschte Auftragsfelder, abweichende Stripe-Antwort |
| Wiederholte Zahlungsbestätigung | `ALREADY_RECORDED`/`DUPLICATE_EVENT`; zweite echte Zahlung → `DUPLICATE_PAYMENT` (R1) |
| Fehlende Umgebungsvariablen | kein Stripe-Aufruf, Status NOT_CONFIGURED, Webhook 503 |
| Verwechslung Live/Test-Schlüssel | `sk_test_` als LIVE, `sk_live_` als TEST, `pk_`/`whsec_` als Key → NOT_CONFIGURED; Modus-Kreuzungen abgelehnt |
| Secrets | in Logs, Zustand, Ledger, Übergabedatei, Status, Fehlermeldungen nie enthalten |
| Inbox-Besitz (R2) | CLI über lokalen HTTP-Server gegen den echten Netlify-Handler |
| Installationsskript (R3) | Reihenfolge Vorprüfung → Freigabe → verdeckte Eingabe, `ssh -n`, `live-off` ohne unnötigen Neustart |

**Endgültige Ergebnisse (2026-10-21, Windows, Node 22):**

| Lauf | Ergebnis |
|---|---|
| Baseline vor Änderungen (`npm test`) | 1166 Tests · 1154 ✓ · 0 ✗ · 12 übersprungen (identisch mit CI-Lauf TF-022) |
| Volle Suite mit allen Code-Änderungen (`npm test`) | **1183 Tests · 1171 ✓ · 0 ✗ · 12 übersprungen** (alle 16 TF-024-Tests ✓) |
| Stripe-Teilmenge nach der letzten Skriptkorrektur (tf024, tf068, tf080, tf081, tf081-stripe, tf084, tf085, tf086, tf088) | **97 / 97 ✓** |
| Gegenprobe gegen unveränderten Release-Code | genau 2 ✗ (R1, R2) – Tests belegen die Fehler |
| `scripts/secret-scan.mjs` | 340 Dateien, 0 Treffer |
| `bash -n deploy/vps/install-stripe-keys.sh` (Git Bash) | OK |
| Verhaltenstest Skript mit `ssh`-Stub (kein Serverkontakt) | falsche Bestätigung / `sk_test_` / `pk_live_` → 0 Schreib-, 0 Neustart-Aufrufe · gültiges Format → genau 1× Setzen (Wert nur über stdin) + 1× Repair-Neustart · `live-off` ohne gesetzten Schlüssel → kein Neustart |

Nicht ausgeführt (nicht Teil der Unit-Suite, benötigen Docker/Browser-Labs): `test:repair-integration`, `test:browser-integration`, `test:full-order-integration`, `test:separation-integration` – laufen in der CI.

## 7. Fehlende Stripe- und Netlify-Konfiguration

| Wo | Was | Stand |
|---|---|---|
| Hetzner `stripe.env` | `STRIPE_SECRET_KEY` (LIVE, empfohlen `rk_live_…` nur Checkout Sessions: Write) | fehlt (TF-022) |
| Hetzner `stripe.env` | `STRIPE_TEST_SECRET_KEY` (für TF-023) | fehlt (TF-023 V6) |
| Netlify | `STRIPE_WEBHOOK_SECRET` (LIVE) und `STRIPE_TEST_WEBHOOK_SECRET` (TEST) – getrennte Werte aus den zwei Stripe-Endpunkten | mind. eines gesetzt, welches unbekannt |
| Stripe LIVE + TEST | Webhook-Endpunkt `https://chrisjarvis.netlify.app/api/payments`, **nur** `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` (keine `payment_intent.*`) | nicht verifiziert |
| Stripe LIVE | Payment Links CHF 150.00 / 480.00, Währung CHF, keine Mengenanpassung, keine Promo-Codes | nicht verifiziert |
| Hetzner Repair-Service | Deploy eines Stands mit diesen Fixes (heute vermutlich `b2163bc`) | ausstehend |

## 8. Sichere Schritte zur späteren Installation des Live-Schlüssels (jeder Schritt einzeln freigeben)

1. Branch reviewen, CI grün, Merge; Repair-Service-Deploy (`deploy/vps/deploy-repair.sh`) – **Freigabe nötig**. Fiverr-Baseline (StartedAt/Image/Restarts) vorher/nachher wie TF-022.
2. TF-023 im **Testmodus** vollständig durchführen (TEST-Key, TEST-Webhook-Secret, Sandbox-Domain, Test-Postfach).
3. Im Stripe-Dashboard: eingeschränkten Schlüssel `rk_live_…` anlegen (nur «Checkout Sessions: Write»); LIVE-Webhook-Endpunkt mit der Ereignisliste aus §7; Payment Links prüfen.
4. LIVE-Webhook-Secret in Netlify setzen (Netlify-UI, nie Chat/Terminal-Ausgabe) – **Freigabe nötig**.
5. Lesend prüfen: `deploy/vps/install-stripe-keys.sh fiverr status` (nur Namen) und im Repair-Container `node repair-service.js --status`: welche bestätigten CHF-480-Aufträge würden sofort eine LIVE-Session erhalten? Unerwünschte vorher stornieren.
6. `deploy/vps/install-stripe-keys.sh fiverr live` – zeigt die Vorprüfung, verlangt `LIVE AKTIVIEREN`, verdeckte Eingabe, startet nur den Repair-Service neu.
7. Danach `node stripe-webhook.js status` → `live: CONFIGURED`, `webhook_inbox: READY`; Logs nur auf `stripe_checkout_created`/`stripe_not_configured` prüfen.
8. Live-Pilot: ein echter, von Chris kontrollierter Auftrag mit echter Zahlung (eigene Karte), danach Rückerstattung im Dashboard → Auftrag muss in `PAYMENT_REVIEW_REQUIRED` gehen. **Gesonderte Freigabe.**

## 9. Rollback-Plan

| Situation | Rückweg |
|---|---|
| LIVE-Key verursacht Probleme | `deploy/vps/install-stripe-keys.sh fiverr live-off` → `STRIPE_SECRET_KEY` entfernt, Repair-Service neu gestartet, LIVE `NOT_CONFIGURED` (keine neuen Sessions). Bereits offene Sessions bleiben bei Stripe bis zum Ablauf (≤ 23 h) bezahlbar und werden per Webhook weiterhin korrekt verbucht – bei Bedarf im Dashboard manuell beenden. |
| Webhook-Probleme | LIVE-Endpunkt im Stripe-Dashboard deaktivieren; Stripe stellt bis zu 3 Tage erneut zu, Jarvis dedupliziert. |
| Repair-Deploy fehlerhaft | vorheriges Image/Release (TF-022-Verfahren, datenneutral). Zahlungsbuch, Stripe-Zustand und Secrets werden vom Deploy nie verändert. |
| Falsche Buchung | `payments.js void|refund <id> --reason …` (nie löschen). |
| Schlüssel kompromittiert | im Stripe-Dashboard sofort rollen, dann `live-off`, danach neuen eingeschränkten Schlüssel installieren. |

## 10. Voraussetzungen für den vollständigen manuellen Kundenauftragstest (TF-023)

V3 Repair-Service-Deploy (jetzt mit diesen Fixes) · V4 Test-Postfach · V5 Sandbox-Domain · V6 `STRIPE_TEST_SECRET_KEY` auf Hetzner **und** `STRIPE_TEST_WEBHOOK_SECRET` auf Netlify + TEST-Webhook-Endpunkt · V7 Mail-Worker-Neuerstellung zum Ein-/Ausschalten der E2E-Schalter · lesender SSH-Zugriff für die Vor-/Nachprüfung (in dieser Sitzung blockiert) · Startfreigabe. Ablauf unverändert gemäss `docs/TF-JARVIS-023-MANUAL-ORDER-TEST-PLAN.md`.

## 11. Go-/No-Go-Empfehlung

**NO-GO** für die Aktivierung von Stripe-Live-Zahlungen heute:

1. Kein einziger Zahlungsweg ist produktiv Ende-zu-Ende verifiziert (TF-023 nicht durchgeführt).
2. Die Fixes R1–R3 sind nicht deployt; produktiv läuft vermutlich noch `b2163bc`.
3. Netlify-Webhook-Secret-Zuordnung (LIVE/TEST) und Stripe-Endpunkt nicht verifiziert.
4. Hetzner-Zustand in dieser Sitzung nicht lesbar.

**GO** für: Review + Merge dieses Branches → Repair-Deploy (Freigabe) → TF-023 im Testmodus. Unabhängig davon sofort klären: R4 (sind die LIVE-Payment-Links in Kundenmails aktiv und wird der LIVE-Webhook empfangen?) und R10 (Ausgangsprüfung für Zahlungslinks in KI-Antworten).

**Produktionsbereitschaft Stripe Live: ca. 55 %** – Code und Tests weitgehend bereit; Deploy, Konfiguration und jede produktive Verifikation fehlen.
