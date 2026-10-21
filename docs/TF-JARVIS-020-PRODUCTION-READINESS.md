# TF-JARVIS-020 – Production Readiness (Stand 2026-10-21)

Branch `tf-jarvis-020` (neuer Worktree `C:\Users\Administrator\Documents\Chris\Jarvis-tf020`, Basis `2bff67e`, Branch `claude/jarvis-voice-dashboard-9phl5w`).
Der Haupt-Worktree (`Jarvis`, uncommittete Änderungen an `stripe-payments.js`, `test/tf080.test.js` u. a.) und der Release-Worktree
`Jarvis-release-tf016` (9cb42e9, wartet auf Mail-Deploy) wurden **nicht verändert**. Keine Commits, kein Push, kein Deploy, keine Produktionsaktion.

## 1. Skill-/MCP-Status (Phase 0)

| Werkzeug | Status | Nachweis |
|---|---|---|
| Playwright MCP | **funktionsfähig** | `https://example.com` geöffnet, Titel «Example Domain» gelesen, Screenshot `docs/tf-jarvis-020/tf020-phase0-example.png` |
| Ponytail | **PONYTAIL_NOT_VERIFIED – nicht installiert** | Weder in `~/.claude/skills`, `~/.agents/skills` noch im offiziellen Marketplace (`anthropics/claude-plugins-official`). Öffentliche Quelle: Drittanbieter-Plugin `DietrichGebert/ponytail` (MIT). Es bringt einen **SessionStart-Hook** mit (Skript bei jedem Sessionstart) und wird über `/plugin marketplace add` installiert – das ist eine sicherheitsrelevante, globale Konfigurationsänderung, die Chris selbst freigeben muss. Kein ähnlich benannter Skill wurde als Ersatz verwendet. |
| Skills | vorhanden (u. a. webapp-testing, systematic-debugging, verification-before-completion) | `~/.claude/skills` |

## 2. Vorheriger Zustand (verifiziert, nicht angenommen)

- Repository sehr weit entwickelt (TF-016 … TF-088): Discovery 24/7, Website-Audit, Lead-Registry, CRM-Dienst, Mail-Worker (Draft-only für Cold Leads),
  Calling (LiveKit Agents, Dry-Run-Dialer), Stripe Checkout/Payment Links mit Signaturprüfung, Aufträge CHF 150/480, Dashboard (Netlify + VPS-Snapshot).
- **Baseline `npm test` auf HEAD 2bff67e: 1165 Tests, 1148 bestanden, 5 fehlgeschlagen, 12 übersprungen** (Docker-Labs ohne `JARVIS_REPAIR_LAB=1`).
- Ursachen der 5 Fehler – **alle Testumgebung, kein Produktionscode-Fehler**:
  | Test | Ursache |
  |---|---|
  | `crm-browser-053` K, L | Fixture-Zeitpunkte fest auf 14.10.2026, Browser/Server laufen mit echter Uhr → nach 7 Tagen «veraltet». |
  | `site-findings-055` Backfill | `buildCrmLead(..., src())` ohne die Test-Uhr `NOW` → echte Uhr → STALE. |
  | `dnc-mail-053` G, `lead-crm-053` L | Windows-Checkout mit `core.autocrlf=true` (CRLF); Regex erwartete `\n` bzw. Kommentar-Entfernung scheiterte an `\r`. |
- `blocked_no_legal_basis` ist **kein Fehler**, sondern der beabsichtigte Status jedes qualifizierten Cold Leads ohne Versandgrundlage (`lead-finder.js:577`,
  `TRACKED_DISCOVERY` in `lead-registry.js:25`). Die historischen 639 blockierten Kandidaten zeigen, dass die TF-024-Prüfung greift. Es wurde nichts daran geändert.
- Die historischen Dry-Run-Zahlen (639 / 305 / 334) betreffen Produktionsdaten auf dem VPS; sie wurden **nicht** neu erhoben (kein SSH/Produktionszugriff in diesem Auftrag).

## 3. Komponenten-Matrix (Phase 1)

| Komponente | Existiert | Funktioniert (lokal belegt) | Getestet | Blocker | Aktion |
|---|---|---|---|---|---|
| Lead Discovery + Domain-Normalisierung + Dedupe | ja (`lead-finder.js`, `lead-db.js`, `lead-registry.js`) | ja | ja + TF-020 E2E | – | E2E-Abdeckung ergänzt |
| Website-Audit + Fehlernachweis | ja (`site-auditor.js`, `site-backfill.js`, `site-findings.js`) | ja (nur GET, robots.txt) | ja + E2E | – | Test-Zeitbombe behoben |
| Stale-Audit-Recheck / Resume | ja (TF-016, Checkpoint/Backoff) | ja | ja | Release 9cb42e9 nicht deployt | – |
| CRM (Dienst, Allowlist, Idempotenz, Audit) | ja (`crm-service.js`, `lead-crm.js`) | ja | ja + E2E + Browser | – | CRLF-Testfix |
| Ausschlussgründe | ja (Status `no_issues`, `low_score`, `no_contact`, `excluded_*`, `suppressed`, `duplicate`; CRM `excluded` je Admission) | ja | ja | – | – |
| E-Mail-Eligibility (TF-024), DNC/Opt-out, Cooldown 180 Tage, Duplikat-Sperre | ja (`email-permission.js`, `swiss-repair.js`, `mail-worker.js`) | ja | ja + E2E | Schweizer Rechtsfrage Cold-E-Mail (s. Blocker) | keine Umgehung |
| Gmail-Draft, Queue, Retry/Backoff, Send-Lock, Logs | ja | Tests mit Fake-Gmail | ja | echter Gmail-OAuth nur auf VPS | – |
| Calling (LiveKit Agents, SIP, Dry-Run, Human Handoff, keine Aufnahme, KI-Offenlegung) | ja (`calling/`, `calling-core.js`, `calling-api.js`) | Dry-Run | ja (`calling-065/068`) + E2E-Sperre CH | CH-Outbound gesperrt; VN nur mit Einwilligung + DNC-Register + `legal.set APPROVED` | keine Änderung |
| Angebote CHF 150 / 480 | ja (`pricing.js`) | ja | ja + E2E | – | – |
| Stripe Checkout/Payment Links, Webhook-Signatur, Idempotenz, TEST/LIVE-Trennung | ja (`stripe-payments.js`, `stripe-webhook.js`, `payments.js`) | ja (Fixtures, Test-Secret) | ja + E2E | Live-Schlüssel/Live-Aktivierung = Freigabe Chris | – |
| Aufträge + Status + Zuordnung Zahlung → Auftrag → Kunde | ja (`check-150-workflow.js`, `repair-workflow.js`) | ja | ja + E2E | – | – |
| Dashboard (CRM, Onboarding, Verkäufer-App, Server-Control) | ja (`public/`) | ja (Playwright MCP) | ja (Browser-Tests) | – | – |
| Auth/Session/Rollen | ja (`auth-api.js`, `auth-core.js`) | ja (Playwright MCP) | ja | – | – |
| Backup, Health Checks, Restart Policies | ja (`backup.js`, Compose) | Konfiguration geprüft | ja | Offsite-Backup-Status nur auf VPS prüfbar | – |
| Docker-Labs (Repair/Browser/Full-Order/Separation/Quality) | ja (`test/integration/`) | siehe Abschnitt 6 | siehe Abschnitt 6 | Docker Desktop war gestoppt | lokal gestartet und ausgeführt |

## 4. Implementierte Änderungen

Nur Tests, Test-Werkzeug und Dokumentation – **kein Produktionscode geändert**, keine neue Dependency.

| Datei | Änderung | Grund |
|---|---|---|
| `test/tf020-e2e-pipeline.test.js` (neu) | Synthetischer End-to-End-Regressionstest über alle 13 Schritte mit den echten Modulen | Phase 6 – bisher deckte kein Test Discovery → Audit → CRM → Entwurf → Zahlung → Auftrag zusammen ab |
| `scripts/tf020-ui-harness.mjs` (neu) | Lokaler UI-Prüfstand (gleiches Gerüst wie die Browser-Tests, synthetische Leads + 2 Aufträge) für Playwright-MCP | Phase 7 – reproduzierbare Browserprüfung ohne Produktionsdaten |
| `package.json` | Skript `test:tf020-e2e` | gezielter Aufruf |
| `test/crm-browser-harness.js` | Fixture-Zeitpunkte auf «jetzt» verschieben | identisch mit der bereits im Haupt-Worktree liegenden, uncommitteten Korrektur übernommen (kein Merge-Konflikt) |
| `test/site-findings-055.test.js` | `buildCrmLead(..., src(), NOW)` | Test-Zeitbombe |
| `test/dnc-mail-053.test.js` | `read()` normalisiert CRLF | Windows-Checkout |
| `test/lead-crm-053.test.js` | `split(/\r?\n/)` | Windows-Checkout |
| `docs/TF-JARVIS-020-PRODUCTION-READINESS.md`, `docs/tf-jarvis-020/*` | Bericht + Screenshots | Abschluss |

### Inhalt des E2E-Tests (synthetische Domain `jarvis-e2e-firma.ch`, Temp-Verzeichnisse, kein Netz)
1. Lead erfassen: 3 Schreibweisen (Website, `www.`, Grossbuchstaben-Adresse) → **genau 1** Registry-Eintrag, ID = normalisierte Domain.
2. Website analysieren: echter `createAuditor` mit gemocktem `fetchFn` (nur GET, nur Testdomain, sonst Abbruch).
3. Fehlernachweis: `site_findings.json` → `broken_link`, HTTP 404, Seite, Zeitpunkt; zweiter Audit ohne Doppel-Befunde.
4. CRM: genau 1 Lead, Audit FULL, zweite Sicht identisch.
5. Berechtigung: `legalBasis` = keine; `approved:true` ohne Nachweis bleibt gesperrt; `COLD_LEAD_DRAFT_ONLY`, `automatic_send_allowed=false`; Suppression → kein Entwurf.
6. Entwurf: nur lokal `queued`, `DRAFT_ONLY`, kein Gmail; zweiter Entwurf → Duplikat-Sperre; Suppression → blockiert.
7. Kontaktstatus `EMAIL_SENT` (idempotent über `request_id`); Aktion ausserhalb Allowlist abgelehnt.
8. Anruf: Outbound-Agent für CH → `CH_CALLING_DISABLED`; DNC → BLOCKED; manuell dokumentierter Anruf `NO_ANSWER`; Zeitpunkt in der Zukunft abgelehnt.
9. Angebot: CHF 150 / CHF 480 aus `pricing.js`.
10. Sandbox-Zahlung über den echten `/api/payments`-Handler: falsche Signatur abgelehnt; falscher Betrag → Prüfung, nichts gebucht; korrekt → genau 1 Buchung (TEST, CHF 480); Wiederholung desselben Ereignisses → keine zweite Buchung.
11. Auftrag RF480 als TEST-Auftrag, Domain = Lead; Zahlungsschwelle vorher offen, danach erfüllt.
12. Status: Testlauf storniert (`CANCELLED`), Zahlungsbuch bleibt erhalten.
13. Dashboard: `cleanRepair(publicRepairOrders())` zeigt den Auftrag ohne Kunden-E-Mail; TEST zählt nicht als offener Live-Auftrag; CRM-Lead mit Anruf-/Kontaktstatus.

## 5. Playwright-MCP-Browserprüfung (Phase 7)

Prüfstand: `node scripts/tf020-ui-harness.mjs` (synthetische Daten, kein Netz nach aussen).

| Prüfung | Ergebnis |
|---|---|
| Ohne Session → Weiterleitung `login.html` | OK |
| Falsches Passwort | OK – generische Meldung «Benutzername oder Passwort falsch.», Passwortfeld geleert |
| Login Owner / Session über Reload | OK |
| Logout → `/api/auth/me` und `/api/crm` = 401 | OK |
| CRM-Liste Desktop 1440×900 (46 Leads, 14 Karten, 12 Spalten, kein Querscrollen) | OK – `tf020-crm-desktop.jpg` |
| Suche (`firma-008` → 1 von 46) | OK |
| Lead-Detail mit Fehlernachweisen (Seite, Ziel, HTTP-Status, Zeitpunkt, Schweregrad) | OK |
| DNC-Lead: Banner, Anruf/Status/Follow-up deaktiviert, kein ANRUFEN | OK (Hinweis s. Blocker B6) |
| Mobile 390×844: kein Querscrollen, keine abgeschnittenen Bedienelemente, keine Ziele < 24 px | OK – `tf020-crm-mobile.jpg` |
| Kunden-Onboarding: Auftrag RF480, Zahlungsschwelle «Erfüllt», Zugang «Link gesendet», keine Zugangsdaten | OK – `tf020-onboarding-desktop.jpg` |
| Verkäufer (Kudoshin, vi-VN, mobil): nur 6 eigene VN-Leads, CH-Daten auch bei `?market=CH` nicht sichtbar, Admin-API 403, Anrufstatus/«Ghi lại cuộc gọi» | OK – `tf020-seller-vn-mobile.jpg` |
| Konsolenfehler | nur 401 vor Login und 404 auf `/api/status`, `/api/system` (Local-Core-APIs sind im Prüfstand absichtlich nicht vorhanden) |

Keine reproduzierbaren UI-Fehler gefunden → keine UI-Änderung. Beobachtung (niedrige Priorität): Wird auf einer bereits geladenen Seite nur der Hash auf
`#crm` geändert, öffnet sich das CRM erst nach Reload (`public/crm.js:592` prüft den Hash nur beim Laden). In der App öffnet der CRM-Knopf korrekt.

## 6. Testergebnisse (Phase 9)

| Prüfung | Ergebnis |
|---|---|
| Baseline `npm test` (HEAD 2bff67e, vor Änderungen) | 1165 Tests: **1148 bestanden, 5 fehlgeschlagen, 12 übersprungen** (Dauer 652 s) |
| Die 4 zuvor fehlerhaften Dateien nach Fix (`site-findings-055`, `dnc-mail-053`, `lead-crm-053`, `crm-browser-053`) | **50/50 bestanden** |
| Neuer E2E-Test `npm run test:tf020-e2e` | **1/1 bestanden** (13 Schritte, ~3 s) |
| Vollständiger Wiederholungslauf `npm test` nach den Fixes | **nicht verwertbar** – vom System wegen Speichermangels abgebrochen. Zusammenfassung: 307 Tests, 221 bestanden, 86 «fehlgeschlagen» – alle 86 sind Datei-Abbrüche ohne Assertion (`'test failed'` nach 20–40 ms, auch `crm-fixture.js` ohne Tests), d. h. Kindprozesse wurden beendet bzw. starteten nicht. Bis zum Abbruch kein echter Assertion-Fehler. Nicht erneut gestartet. **Offen:** `npm test` einmal mit genügend freiem Speicher vollständig laufen lassen. |
| Docker-Labs (`test:repair-integration`, `test:browser-integration`, `test:full-order-integration`, `test:separation-integration`, `test:repair-quality-integration`) | **nicht ausgeführt** – Docker Desktop war gestoppt; nach dem Start folgte der Speichermangel, Docker Desktop wurde wieder beendet. Die 12 Lab-Tests bleiben ungeprüft. |
| Playwright-MCP-Browsertests | bestanden (Abschnitt 5) |
| Secret-Scan `node scripts/secret-scan.mjs` | 326 Dateien, **0 Treffer** |
| `npm audit --omit=dev` (Root + `calling/`) | **0 Schwachstellen** |
| Syntaxprüfung `node --check` (228 JS/MJS-Dateien ausser `public/`) | **0 Fehler** |
| Docker-Konfiguration (statisch, 6 Compose-Projekte) | alle mit `restart: unless-stopped`, Healthcheck, `read_only: true`, `cap_drop`, Log-Rotation. `docker compose config` nicht ausgeführt (Daemon aus). |
| Build | kein Build-Schritt im Projekt (Node-ESM, Netlify ohne Build) – nicht anwendbar |
| Lint / Typecheck | nicht konfiguriert (B8) |
| `git diff --check` | OK |
| E-Mail-Dry-Run / Calling-Mock / Payment-Sandbox | durch bestehende Suiten (`mail-worker`, `dnc-mail-053`, `swiss-compliance-024`, `calling-065/068`, `tf081-stripe`, `tf084/085/088`) in der Baseline grün + E2E |

## 7. Noch offene Blocker

| # | Blocker | Art | Wer |
|---|---|---|---|
| B1 | **Cold-E-Mail in der Schweiz** (UWG Art. 3 Abs. 1 lit. o): ohne Einwilligung/Kundenbeziehung keine automatische Werbemail. Jarvis erstellt bewusst nur Entwürfe (`COLD_LEAD_DRAFT_ONLY`), Versand nur manuell durch Chris. Ob und wie manueller Einzelversand an öffentliche Geschäftsadressen zulässig ist, ist eine **ungeklärte Rechtsfrage** – nicht technisch lösbar. | Compliance | Chris + Rechtsberatung |
| B2 | **CH-Outbound-Calls** durch den KI-Agenten gesperrt (`CH_CALLING_DISABLED`); Telefonbuch-Sternchen/Werbeverbot und Einwilligung wären Voraussetzung. | Compliance | Chris + Rechtsberatung |
| B3 | **VN-Calling**: technisch bereit (Dry-Run), aber `legal_vn` = `BLOCKED_PENDING_LEGAL_REVIEW` bis zur ausdrücklichen Freigabe; zusätzlich je Lead Einwilligungsnachweis + DNC-Register ≤ 30 Tage. LiveKit/SIP-Trunk-Secrets nur auf dem VPS. | Freigabe/Zugang | Chris |
| B4 | **Release 9cb42e9 (TF-016) nicht auf dem VPS** (VPS = cfc5b36): Deploy schlug fehl, weil PowerShell `bash` = WSL war (TF-JARVIS-CRM-023). Manueller Deploy mit Git Bash im Wartungsfenster. | Deploy-Freigabe | Chris |
| B5 | Stripe **Live**-Aktivierung (Live-Schlüssel, Live-Webhook-Secret, Payment Links live) – nur Sandbox geprüft. Uncommittete Checkout-Studio-Änderung (`stripe-payments.js`, `STRIPE_INTEGRATION_TODO.md`) im Haupt-Worktree ist nicht Teil dieses Branches. | Freigabe | Chris |
| B6 | Empfehlung: Für DNC-Leads wird «GMAIL-ENTWURF ÖFFNEN» weiterhin angezeigt (bestehender Entwurf; Worker markiert `suppressed_after_draft`). Ausblenden wäre eine Produktentscheidung, kein Fehler. | Produktentscheidung | Chris |
| B7 | Produktions-Laufzeitwerte (Discovery-Backoff, 431 stale Audits, Gmail-OAuth, Offsite-Backup) nur auf dem VPS prüfbar – `node production-readiness.js` im Container ausführen. | Zugang | Chris |
| B8 | Kein Lint/Typecheck konfiguriert (reines ESM-JavaScript, kein ESLint/tsc im Projekt); ersetzt durch `node --check` aller Dateien. Einführung wäre neue Dependency → nicht ohne Auftrag. | Werkzeug | optional |

Latente Härtung (nicht erreichbar, daher nicht geändert): `createUpserter` (`lead-registry.js:44`) normalisiert eine fehlende `lead_id` nicht;
alle heutigen Aufrufer liefern bereits normalisierte Domains (`lead-finder.js:423`).

## 8. Tatsächlich nachgewiesene Produktionsreife

- **Nachgewiesen (lokal, synthetisch):** die komplette Kette Lead → Audit → Nachweis → CRM → Berechtigung → Draft-only-Entwurf → Kontakt-/Anrufprotokoll →
  Angebot → signierte Stripe-TESTzahlung (idempotent, fail closed) → Auftrag → Status → bereinigte Dashboard-Sicht; Compliance-Sperren lassen sich im Test nicht umgehen.
- **Nachgewiesen (Browser):** Login/Session/Logout, Rollen-Trennung Owner/Verkäufer, CRM-Liste/Suche/Detail/Nachweise, Onboarding/Zahlungsschwelle, Desktop + Mobil.
- **Nicht nachgewiesen in diesem Auftrag:** Produktions-Laufzeit (VPS), echter Gmail-OAuth, Docker-Labs, vollständiger Wiederholungslauf der Unit-Suite.

**Bewertung (realistisch):**
- Technische Fertigstellung: **~90 %** – alle Komponenten existieren und sind getestet; offen sind der vollständige Testlauf, die Docker-Labs und der Deploy von 9cb42e9.
- Produktionsreife (Gesamtprozess inkl. Outreach): **~55 %** – Zahlungen/Aufträge/CRM sind betriebsbereit, aber Cold-E-Mail (nur Entwürfe) und Telefonie (CH gesperrt, VN ohne Rechtsfreigabe) hängen an rechtlichen Freigaben, und die Live-Zahlungsaktivierung fehlt.

## 9. Erforderliche manuelle Freigaben

1. Rechtliche Klärung B1/B2 (Cold-E-Mail, CH-Telefonie) – bis dahin bleibt alles gesperrt bzw. Draft-only.
2. `legal.set APPROVED` für VN-Calling nur nach Rechtsprüfung (B3).
3. Mail-Worker-Deploy 9cb42e9 im Wartungsfenster per Git Bash (B4).
4. Stripe-Live-Aktivierung (B5).
5. Review/Merge dieses Branches `tf-jarvis-020` (nur Tests/Doku) durch Chris.
6. Optional: Ponytail-Plugin nur nach eigener Prüfung des SessionStart-Hooks installieren.

## 10. Nächster konkreter Schritt

Mail-Worker-Release 9cb42e9 im Wartungsfenster mit
`& "C:\Program Files\Git\bin\bash.exe" -lc 'cd /c/Users/Administrator/Documents/Chris/Jarvis-release-tf016 && [ "$(git rev-parse --short HEAD)" = 9cb42e9 ] && [ -z "$(git status --porcelain)" ] && bash deploy/vps/deploy.sh fiverr'`
deployen, danach im Container `node production-readiness.js` ausführen und das Ergebnis hier nachtragen.
