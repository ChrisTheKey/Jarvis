# AGENTS.md – Projektregeln für Jarvis (gilt für Claude Code UND Codex CLI)

Einzige Quelle der Regeln. `CLAUDE.md` importiert diese Datei. Details: `docs/DEVELOPMENT_CONTROL_CENTER.md`.
Gemeinsamer Stand (fertig / in Arbeit / Fehler / offen): `docs/STATUS.md`. Historie: `PROJECT_STATE.md` (sehr gross, nur gezielt lesen: `grep`).

## Was Jarvis ist
Node.js (>=18, ESM, keine Build-Stufe) – Sprach-Dashboard plus Always-on-Dienste für Schweizer Webseiten-Reparatur/Vertrieb:
Lead-Suche → CRM → Mail-Worker (Gmail) → Kontaktformular/Onboarding → Reparatur → Stripe-Zahlung → Provision.

## Arbeitsweise (Pflicht)
1. Arbeite NUR in deinem Worktree: Claude in `..\Jarvis-claude` (Branch `agent-claude/main`), Codex in `..\Jarvis-codex` (Branch `agent-codex/main`). Nie im Hauptordner `Jarvis` (Chris' Arbeitsstand, enthält uncommittete Änderungen) und nie in den anderen `Jarvis-*`-Worktrees.
2. Vor Beginn: `docs/STATUS.md` lesen; nach Abschluss aktualisieren (Abschnitt «In Arbeit» / «Erledigt» / «Offen» / «Bekannte Fehler»), im selben Commit.
3. Kleine, thematisch getrennte Commits. Vor jedem Commit: `node scripts/dev-check.mjs` (schnell, läuft auch als pre-commit-Hook), vor Übergabe: `node scripts/dev-check.mjs --full`.
4. Keine bestehende Funktion entfernen, keine unnötigen Architekturänderungen, Stil der Umgebung beibehalten (Deutsch in Texten/Kommentaren, `TF-xxx`-Kennungen).
5. Integration in `claude/jarvis-voice-dashboard-9phl5w` und Push nur durch Chris (oder auf seine ausdrückliche Anweisung).

## Sicherheitsregeln (nicht verhandelbar)
- Ohne separate, ausdrückliche Freigabe von Chris NIE: produktives Deployment (Netlify, `deploy/vps/*.sh`, `docker compose` auf dem VPS, SSH auf Produktion), Neustart produktiver Container, echte Zahlungen/Stripe-Live, echte Kunden-/Lead-E-Mails oder Gmail-Versand, Anrufe, kostenpflichtige API-Aufrufe (Anthropic, Stripe live, Google, ElevenLabs …), Änderungen an Produktionsdaten.
- Secrets: `.secrets/`, `.env`, `*token*.json`, `backup_private.pem` nie lesen, ausgeben, committen oder kopieren. Worktrees enthalten sie bewusst nicht. Tests laufen mit Attrappen/Fixtures (`test/netlify-mock.js`, `test/crm-fixture.js`).
- Kundendaten (`data/lead_*`, `data/crm_*`, `exports/`, `local-mail-setup/`) nie committen oder weitergeben.
- Bestehende Sicherheitsprüfungen nie umgehen oder abschwächen: Gmail-Register/Thread-Prüfung, DNC/Opt-out, Versandfenster und Tageslimit, E2E-Allowlists (TF-080/088), Zahlungs-Gate, Auth/Scope (`auth-*.js`, `sales-scope.js`), Secret-Scan, Sandbox-Domain-Beschränkungen. Ein Test, der rot wird, ist zu beheben, nicht zu lockern.
- Schreibende Skripte/Dienste nur gegen Testverzeichnisse (`scripts/test-temp.mjs` isoliert Tests in ein Temp-Verzeichnis).
- Fehlende Werkzeuge nur installieren, wenn gratis und nötig; vorher Quelle prüfen und Chris nennen.
- Zweifel = stoppen und Chris fragen.

## Befehle
| Zweck | Befehl |
|---|---|
| Schnellcheck (Syntax geänderter Dateien + Secret-Scan) | `node scripts/dev-check.mjs` |
| Alle Unit-Tests | `npm test` |
| Einzelne Testdatei | `node scripts/run-unit-tests.mjs test/<datei>.test.js` |
| Voller Check (alles Obige + Integration) | `node scripts/dev-check.mjs --full` |
| Release-Gates | `npm run test:release-049` / `test:release-054`, Themen: `npm run test:tf080` u. a. (siehe `package.json`) |
| Secret-Scan | `node scripts/secret-scan.mjs` |
| Lokaler Start (Dashboard) | `npm start` (Port 3000, lokal, ungefährlich) |
| Worktrees (neu) einrichten | `powershell -File scripts/setup-dev-worktrees.ps1` |

Jeder Worktree hat sein eigenes `node_modules` (`npm ci --ignore-scripts`, kein Teilen mit dem Hauptordner). Chromium für Browser-Tests: `JARVIS_CHROMIUM_PATH` (siehe Handbuch).

## Verzeichnisse
`*.js` im Wurzelverzeichnis = Module (Lead-Suche `lead-*`, `vn-*`; CRM `crm-*`, `lead-crm.js`; Mail `mail-worker.js`, `gmail.js`; Reparatur `repair-*`, `swiss-repair.js`, `check-150-workflow.js`; Zahlung `stripe-*`, `payment*.js`, `commission-ledger.js`; Auth `auth-*`, `access-*`; Server `server.js`, `server-control.js`) · `netlify/` Funktionen + Edge (Cloud-Gateway) · `public/` UI · `deploy/vps/` Dockerfiles + Deploy-Skripte (PRODUKTION) · `repair-adapters/` Hosting-Adapter · `calling/` Anruf-Dienst · `scripts/` Werkzeuge · `test/` Tests · `workspace/` Jarvis-Persona/Arbeitsordner (`workspace/CLAUDE.md` gilt nur für den laufenden Jarvis, nicht für Entwicklung) · `docs/` Doku.
