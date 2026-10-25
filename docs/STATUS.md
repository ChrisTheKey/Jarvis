# Jarvis – gemeinsamer Entwicklungsstatus (Claude Code + Codex CLI)

Kurzer, aktueller Stand für beide Werkzeuge. Lesen vor Beginn, aktualisieren im selben Commit wie die Arbeit. Details je Ticket: `PROJECT_STATE.md` (nicht hier duplizieren). Keine Secrets, keine Kundendaten.

Zuletzt aktualisiert: 2026-10-25 (Einrichtung Development Control Center)

## Erledigt (Code fertig laut PROJECT_STATE.md, Produktionsstand siehe dort)
- Always-on Mail-Worker auf VPS (alleiniger Sender), Gmail-OAuth, Versandfenster/Tageslimit, DNC-Durchsetzung (TF-047…056).
- CRM-Dienst `jarvis-crm` mit allen qualifizierten Leads (TF-053/057), Reparatur-Dienst `jarvis-repair`.
- Stripe-Anzahlung, Zahlungslinks, Nachfassen, Webhook, Zahlungs-Gate (TF-080/081/084/085).
- Kontaktformular → Gespräch → sicherer Zugang → Reparatur (TF-079), Geräte-Kopplung (TF-074).
- Kontrollierter E2E-Test CHF 150 (TF-088, Standard AUS) und CRM-Test-Kennzeichnung (TF-086).
- Netlify-Drop-Adapter, Browser-Audit, interner CHF-480-Testauftrag (TF-JARVIS-PRAXIS-002: «CODE READY, nicht deployt»).
- Development Control Center: `AGENTS.md`, `CLAUDE.md`, Worktrees `dev/claude` + `dev/codex`, `scripts/dev-check.mjs`, Codex-/Claude-Schutzregeln.

## In Arbeit
| Wer | Branch/Worktree | Aufgabe |
|---|---|---|
| Chris | `Jarvis` (Hauptordner) | uncommittete Änderungen: `crm-api.js`, `crm-service.js`, `stripe-payments.js`, Tests (CRM-Pagination u. a.), `.gitignore`, `package.json`. Nicht in den Worktrees enthalten. |
| Claude | `dev/claude` | – (frei) |
| Codex | `dev/codex` | – (frei) |

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
- Codex CLI 0.164 (`codex exec` im Worktree `Jarvis-codex`): las `AGENTS.md`, führte `dev-check` aus, committete auf `dev/codex` (nach Freigabe der Git-Schreibpfade in `.codex/config.toml`; erster Versuch scheiterte an der Sandbox). Hinweis: in der Sandbox legt Codex den Index über einen Umweg an – nach einem Codex-Commit `git status` prüfen, ggf. `git reset` (nur Index).
- Claude Code 2.1.310 (`claude -p` im Worktree `Jarvis-claude`): liest `CLAUDE.md` → `AGENTS.md`; `dev-check` über `allow`-Regeln in `.claude/settings.json` ohne Rückfrage ausführbar.
- Unit-Suite im Worktree: 1197 Tests, 1165 pass, 16 fail (Baseline, Fehler siehe oben). Mit `JARVIS_CHROMIUM_PATH` auf den vorhandenen Chromium bestehen die Chromium-Tests; verbleibend (Stichprobe von 8 Dateien, 98 Tests): 7 fail = Punkte 2–5 oben plus «Engine end-to-end» (`browser-audit-praxis002`).
- Neue Tests der Zentrale: `test/dev-control-center.test.js` (5/5 pass).

## Offene Aufgaben (Backlog, Priorität nach Chris)
- Fehler 1–5 oben beheben (je ein kleiner Commit mit Test).
- Commit der uncommitteten Arbeit im Hauptordner (Chris) – danach `dev/*` rebasen.
- TF-JARVIS-PRAXIS-002 und TF-086/088: Deployment ausstehend (nur nach Freigabe von Chris).
- TF-056: Token-Rotation blockiert (kein Netlify-CLI-Login am PC).
- Stripe-Integration: siehe `STRIPE_INTEGRATION_TODO.md`.
- Offene Punkte je Ticket: `PROJECT_STATE.md`, Suche nach «Offen».

## Letzte Verifikation der Zentrale
Siehe Abschnitt am Ende dieser Datei (wird bei der Einrichtung und bei Änderungen der Regeln gepflegt).
### Codex-Verifikation
- 2026-10-25, Check-Ergebnis: `node scripts/dev-check.mjs` OK (Syntax: 0 Dateien; keine Secret-/Kundendaten-Pfade geändert).
