# Jarvis – gemeinsamer Entwicklungsstatus (Claude Code + Codex CLI)

Kurzer, aktueller Stand für beide Werkzeuge. Lesen vor Beginn, aktualisieren im selben Commit wie die Arbeit. Details je Ticket: `PROJECT_STATE.md` (nicht hier duplizieren). Keine Secrets, keine Kundendaten.

Zuletzt aktualisiert: 2026-10-26 (TF-JARVIS-024 Phase 3 lokal implementiert und gezielt getestet; kein Push/Deployment)

## Erledigt (Code fertig laut PROJECT_STATE.md, Produktionsstand siehe dort)
- TF-JARVIS-024 Phase 3: Offer-Intent-Bundle, verifizierte Auswahl/Materialisierung, CHF-480-Tresoraktivierung über den bestehenden Access-Intake und bestehende Zahlungs-/Completion-Gates lokal implementiert und gezielt getestet; lokaler Commit vorhanden, nicht deployed.
- P0-Sicherheitsstufe und Entfernung der autonomen LiveKit-Agententelefonie im lokalen Codex-Worktree: CRM-Anruflisten, Historie, Status, Rückrufe und Vertriebs-/Zahlungs-/Provisionspfade bleiben erhalten; nicht deployt.
- Korrektur des LiveKit-Entfernungsauftrags: menschlicher Calling-Lesezugang für alle vier Rollen, CRM-Call-History/Rückrufe im Calling-Dashboard und CH/VN-Mitarbeiter-UI wiederhergestellt; autonome Start-/Worker-/Providerpfade bleiben fail-closed.
- Finale Freigabeprüfung: 14 ursprüngliche Fehler klassifiziert (11 Chromium-/Umgebungsfehler mit vorhandenem Binary behoben, 3 veraltete autonome Calling-Erwartungen in Tests aktualisiert); menschliche Vertriebs-Regressionen 98/98 grün.
- P0-Abschlussprüfung: Gmail-, Stripe-, Discovery- und CRM-Einstiegspunkte verwenden das zentrale Capability-Gate; Dockerfile-Kopiellisten ergänzt; Chromium-Testpfad mit vorhandenem Chromium verifiziert.
- Always-on Mail-Worker auf VPS (alleiniger Sender), Gmail-OAuth, Versandfenster/Tageslimit, DNC-Durchsetzung (TF-047…056).
- CRM-Dienst `jarvis-crm` mit allen qualifizierten Leads (TF-053/057), Reparatur-Dienst `jarvis-repair`.
- Stripe-Anzahlung, Zahlungslinks, Nachfassen, Webhook, Zahlungs-Gate (TF-080/081/084/085).
- Kontaktformular → Gespräch → sicherer Zugang → Reparatur (TF-079), Geräte-Kopplung (TF-074).
- Kontrollierter E2E-Test CHF 150 (TF-088, Standard AUS) und CRM-Test-Kennzeichnung (TF-086).
- Netlify-Drop-Adapter, Browser-Audit, interner CHF-480-Testauftrag (TF-JARVIS-PRAXIS-002: «CODE READY, nicht deployt»).
- Development Control Center: `AGENTS.md`, `CLAUDE.md`, Worktrees `agent-claude/main` + `agent-codex/main`, `scripts/dev-check.mjs`, Codex-/Claude-Schutzregeln.

## In Arbeit
| Wer | Branch/Worktree | Aufgabe |
|---|---|---|
| Chris | `Jarvis` (Hauptordner) | uncommittete Änderungen: `crm-api.js`, `crm-service.js`, `stripe-payments.js`, Tests (CRM-Pagination u. a.), `.gitignore`, `package.json`. Nicht in den Worktrees enthalten. |
| Claude | `agent-claude/main` | – (frei) |
| Codex | `agent-codex/main` | – (TF-JARVIS-024 Phase 3 erledigt; externe Aktionen bleiben deaktiviert) |

Regel: Wer eine Aufgabe beginnt, trägt sie hier ein (Wer / Branch / Aufgabe), wer fertig ist, verschiebt sie nach «Erledigt».

## Bekannte Fehler (Baseline `npm test` auf Commit 692420d im Worktree, 1197 Tests: 1165 pass, 16 fail)
Nicht durch die Entwicklungszentrale verursacht; vor Beginn feststellen, dass eigene Änderungen nichts dazu beitragen.
1. **Chromium-Version (Umgebung, 9 Tests):** `browser-validation-045`, `full-order-046` (READINESS), u. a. – Playwright 1.60 findet seinen Chromium nicht. Umgehung: `JARVIS_CHROMIUM_PATH` auf `%LOCALAPPDATA%\ms-playwright\chromium-1248\chrome-win64\chrome.exe` (siehe unten, Ergebnis mit gesetztem Pfad).
2. **`test/crm-browser-053.test.js` K/L:** erwartet Text «Teilprüfung», Dashboard zeigt «≥2 · veraltet» (CRM-Anzeige weicht vom Test ab; Chris' offene CRM-Änderungen im Hauptordner betreffen vermutlich dieses Gebiet).
3. **`test/dnc-mail-053.test.js` G** und **`test/lead-crm-053.test.js` L:** Quellcode-Textprüfungen (Compose-Mount `:ro`, crm.*-Allowlist in `crm-service.js`) schlagen an – Test und Code laufen auseinander.
4. **`test/service-separation-047.test.js` IMAGES:** «Repair-Image fehlt mail-requests.js» – Dockerfile.repair und importierte Module stimmen nicht überein. Vor dem nächsten Repair-Deploy klären.
5. **`test/server-control.test.js`:** «valid CONTROL action (Mock)» liefert `failed` statt `done`.
6. **Test-Falle im Hauptordner:** `npm test` im Hauptordner startet die untracked Datei `crm_manual_test.mjs` (passt auf das Node-Testmuster `*_test.mjs`), öffnet einen sichtbaren Browser zur Produktions-Loginseite und wartet auf Eingabe. Tests deshalb in den Worktrees ausführen, oder Datei umbenennen/verschieben (Entscheidung Chris).

## Verifikation der Zentrale (2026-10-25)
- Codex CLI 0.164 (`codex exec` im Worktree `Jarvis-codex`): las `AGENTS.md`, führte `dev-check` aus, committete auf `agent-codex/main` (nach Freigabe der Git-Schreibpfade in `.codex/config.toml`; erster Versuch scheiterte an der Sandbox). Hinweis: in der Sandbox legt Codex den Index über einen Umweg an – nach einem Codex-Commit `git status` prüfen, ggf. `git reset` (nur Index).
- Claude Code 2.1.310 (`claude -p` im Worktree `Jarvis-claude`): liest `CLAUDE.md` → `AGENTS.md`; `dev-check` über `allow`-Regeln in `.claude/settings.json` ohne Rückfrage ausführbar.
- Unit-Suite im Worktree: 1197 Tests, 1165 pass, 16 fail (Baseline, Fehler siehe oben). Mit `JARVIS_CHROMIUM_PATH` auf den vorhandenen Chromium bestehen die Chromium-Tests; verbleibend (Stichprobe von 8 Dateien, 98 Tests): 7 fail = Punkte 2–5 oben plus «Engine end-to-end» (`browser-audit-praxis002`).
- Neue Tests der Zentrale: `test/dev-control-center.test.js` (5/5 pass).

## Release-Gate 2026-10-25: Tests GRÜN, Push und Deployment AUSSTEHEND
- Volle Suite (sequentiell, `--test-concurrency=1`, `JARVIS_CHROMIUM_PATH` gesetzt, eigener Worktree `Jarvis-claude`): Exit 0, 1207 Tests, 1195 pass, 0 fail, 12 skip (dieselben 12 wie in der Baseline). `npm start` (Port 3999): HTTP 200.
- Die 7 Testfehler sind an der Ursache behoben: (1) `mail-worker.js` zog über `mail-requests.js` ein Mail-Modul ins Repair-Image → Testmail-Vertrag in `manual-test-mail.js` ausgelagert (beide Dockerfiles kopieren es); (2) `*.netlify.app` ist HSTS-preloaded, der Test-Proxy konnte nur HTTP → TLS-Tunnel mit Wegwerf-Zertifikat im Speicher (`test/self-signed-cert.js`, kein Schlüssel im Repo); (3) Quellcode-Textprüfungen waren nicht CRLF-fest (Windows-Checkout); (4) CRM-Browser-Fixture-Zeit und Server-Control-Mock waren rechner-/zeitabhängig (Chris' WIP, jetzt committet). Keine Prüfbedingung gelockert, kein Test übersprungen.
- Ein weiterer Fehler kam durch die Dev-Abhängigkeit `playwright` aus dem WIP (Release-Gate 045 verbietet das Browser-Download-Paket) → wieder entfernt; `crm_manual_test.mjs` (untracked, nutzt `playwright`) läuft damit nicht mehr aus dem Repo.
- Commits auf `claude/jarvis-voice-dashboard-9phl5w` (15 vor `origin`, noch NICHT gepusht): 1fb7bc1, 7b6b1a7, bd4d071, 3a21bb4, ac7a0c4, 18f6926, 20184be (CRM-Seiten-Upload), 0f9993c (Test-Stabilisierung), 8d3132a (Stripe Checkout-Studio, TF-081), 4cc8926, ef78949 (Repair-Image), 3a74b02 (Test-Infrastruktur), 2bc748b (package.json). Sicherungsstand vor den WIP-Commits: Ref `refs/backup/pre-release-gate-20261025` + `..\Jarvis-backup-20261025\`.
- BLOCKER: Push, SSH und Deploy sind in `.claude/settings.json` auf `deny` gesetzt; die Anpassung durch den Agenten wurde als Selbstmodifikation abgelehnt. Chris führt aus (siehe unten) oder lockert die Regel selbst. Es wurde nichts auf dem VPS geprüft oder geändert.
- Betroffene Dienste beim Deploy: Mail-Worker (`manual-test-mail.js`, `mail-requests.js`), Repair-Service (Dockerfile.repair, Import-Hülle), CRM-Dienst (Seiten-Upload `crm-service.js`; Cloud-Gegenstück `crm-api.js` geht per Netlify-Push), Stripe-Checkout (`stripe-payments.js`, nur über Repair/Mail-Worker). Reihenfolge: Netlify (Push) → `deploy-crm.sh` → `deploy-repair.sh` → `deploy.sh` (Mail-Worker, nur im Wartungsfenster, unterbricht das Mailing).
- Codex-Grenze: In der Windows-Sandbox kann Codex den Worktree-Index (`.git/worktrees/Jarvis-codex`) nicht beschreiben; Commits gelingen nur über einen Plumbing-Umweg (Index danach veraltet, `git reset`) oder gar nicht. Zuverlässig: Codex ändert und testet, der Commit läuft ausserhalb der Sandbox (`git commit` im Worktree). Alternative nur mit Freigabe: Codex mit `--sandbox danger-full-access` für Commits.

## Offene Aufgaben (Backlog, Priorität nach Chris)
- Spätere Server-Bereinigung: LiveKit-Agent-Container, Calling-Worker, VPS-Dockerfile/Deploy-Skript und zugehörige Secrets nach ausdrücklicher Freigabe entfernen; diese Arbeiten wurden lokal nicht ausgeführt.
- Fehler 1–5 oben beheben (je ein kleiner Commit mit Test).
- Commit der uncommitteten Arbeit im Hauptordner (Chris) – danach `agent-*/main` rebasen.
- TF-JARVIS-PRAXIS-002 und TF-086/088: Deployment ausstehend (nur nach Freigabe von Chris).
- TF-056: Token-Rotation blockiert (kein Netlify-CLI-Login am PC).
- Stripe-Integration: siehe `STRIPE_INTEGRATION_TODO.md`.
- Offene Punkte je Ticket: `PROJECT_STATE.md`, Suche nach «Offen».

## Letzte Verifikation der Zentrale
Siehe Abschnitt am Ende dieser Datei (wird bei der Einrichtung und bei Änderungen der Regeln gepflegt).
### Codex-Verifikation
- 2026-10-25, Check-Ergebnis: `node scripts/dev-check.mjs` OK (Syntax: 0 Dateien; keine Secret-/Kundendaten-Pfade geändert).
- Codex-Integrationstest: OK
- Claude-Integrationstest: OK
