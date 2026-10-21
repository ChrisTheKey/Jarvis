# TF-JARVIS-023 – Manueller Kundenauftragstest (Ergebnisse, laufend)

Stand: 2026-10-21 · Status: **Vorbereitung – Gmail OAuth repariert; Testauftrag noch nicht gestartet.**
Öffentliches Repository: keine Tokens, Pfade, Konten oder Kundendaten.

## 1. Gmail OAuth (Blocker G1) – BEHOBEN

| Schritt | Ergebnis |
|---|---|
| Ursache | Refresh-Token `expired_or_revoked` seit 2026-10-20 19:26 UTC – genau 7 Tage nach der letzten Neuautorisierung (TF-049, 2026-10-13) → Muster des Google-«Testing»-Veröffentlichungsstatus |
| Neuautorisierung | lokal durch Chris (`npm run gmail -- auth`), lokal `MAIL AUTH READY` |
| Vorabprüfung | neuer Token 2026-10-21 14:27 UTC, Refresh-Token vorhanden, Scopes `gmail.modify`/`gmail.labels`, OAuth-Client identisch mit dem Server (Hash-Vergleich, ohne Inhalt) |
| Transfer (TF-049-Verfahren) | per SSH unter `umask 077` als temporäre Datei ins Secret-Verzeichnis, Plausibilitätsprüfung, Rückfallkopie des alten Tokens (600), atomares `mv`, Rechte 600 / Besitzer unverändert – 2026-10-21 14:32 UTC |
| Verifikation (ohne Versand) | im Produktiv-Mail-Worker `gmail.js check` (nur `users.getProfile`) → **MAIL AUTH READY**; Readiness: Mail OK, Delivery OK (Outbox-Consumer aktiv, offen 0), Authority OK |
| Laufender Worker | liest die Token-Datei bei jedem Zugriff (`gmail.js` `accessToken()`), kein Neustart nötig – Mail-Worker nicht neu gestartet |
| Rückfallkopie | nach erfolgreicher Verifikation mit `shred -u` entfernt (wie TF-049) |
| Keine Mail, kein Entwurf, keine Label-Änderung | ✅ |
| Fiverr / andere Projekte | unverändert (StartedAt, Image, Restarts identisch) |

**Risiko:** Steht die Google-OAuth-App weiterhin auf «Testing», läuft der Token am **2026-10-28** erneut ab. Abhilfe: Veröffentlichungsstatus auf «In Produktion» (Chris, Google Cloud Console).

## 2. Offene Voraussetzungen für den Testauftrag

| # | Voraussetzung | Status |
|---|---|---|
| V1 | Mail-Worker auf 16f17f5 | ✅ |
| V2 | Gmail OAuth | ✅ (siehe oben) |
| V3 | Repair-Service von b2163bc auf 16f17f5 (`deploy-repair.sh`) | ⏳ wartet auf ausdrückliche Freigabe |
| V4 | Test-Postfach (von Chris kontrolliert) | ⏳ Angabe fehlt |
| V5 | Sandbox-Domain (< 6 Befunde; für CHF 480 mit unterstütztem Zugang und eingebautem behebbarem Fehler) | ⏳ Angabe fehlt |
| V6 | Stripe-Testmodus: TEST-Schlüssel auf dem VPS (derzeit nicht konfiguriert), TEST-Webhook-Secret in Netlify | ⏳ Chris (verdeckte Eingabe) |
| V7 | Mail-Worker-Neuerstellung (gleicher Commit) zum Ein- und Ausschalten der E2E-Schalter | ⏳ wartet auf ausdrückliche Freigabe |

## 3. Testauftrag, Zahlung, Reparatur, Kommunikation, Abschluss

Noch nicht gestartet.
