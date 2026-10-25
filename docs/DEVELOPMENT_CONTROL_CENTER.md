# Jarvis – Development Control Center (Claude Code + Codex CLI)

Claude Code und OpenAI Codex CLI sind gleichberechtigte Entwicklungswerkzeuge. Beide lesen dieselben Regeln (`AGENTS.md`; `CLAUDE.md` importiert sie), arbeiten in getrennten Git-Worktrees, melden ihren Stand in `docs/STATUS.md` und sind technisch von Produktion und Secrets abgeschirmt. Chris integriert und gibt frei.

## 1. Architektur (Kurzfassung)
```
Browser/Handy ──► Netlify (public/ + netlify/functions + edge)   Cloud-Gateway, Login, Zustand in Netlify Blobs
                        │  (Token-authentifiziert)
                        ▼
Hetzner-VPS (deploy/vps/*, Docker):  jarvis-mail (mail-worker.js, EINZIGER Mail-Sender, Gmail)
                                     jarvis-repair (repair-service.js, Hosting-Adapter, Browser-Validierung)
                                     jarvis-crm (crm-service.js, Lead-CRM)   jarvis-vn / -contacts / -calling
Windows-PC (optional):               server.js (Dashboard + Claude Code für Chris' Jarvis), device-agent.js
Stripe (Anzahlung CHF 150/480 → Webhook stripe-webhook.js) · Gmail OAuth · Anthropic · ElevenLabs · AssemblyAI
```
Wichtige Flüsse: Lead-Suche (`lead-finder.js`, `vn-discovery.js`) → `lead-crm.js` → Entwurf (`cold-draft-rewrite.js`) → Mail-Worker mit Versandfenstern, Tageslimit, DNC → Kontaktformular/Onboarding (`contact-form*.js`, `onboarding-*.js`) → Zahlungs-Gate (`stripe-*.js`, `payment*.js`) → Reparatur (`repair-workflow.js`, `repair-adapters/`, Rollback bei Fehlern) → Provision (`commission-ledger.js`). Ausführliche Historie je TF-Ticket: `PROJECT_STATE.md`; Funktionsübersicht: `docs/JARVIS_CAPABILITY_MATRIX.md`; Betrieb: `docs/DISASTER_RECOVERY.md`, `docs/MOBILE_CLOUD_RUNBOOK.md`, `E2E_CHECK150_RUNBOOK.md`.

## 2. Wichtige Verzeichnisse
Siehe `AGENTS.md` (Abschnitt «Verzeichnisse»). Zusätzlich: `.claude/` (Claude-Berechtigungen), `.codex/` (Codex-Sandbox + Regeln), `.githooks/` (pre-commit), `scripts/dev-check.mjs`, `scripts/setup-dev-worktrees.ps1`.

## 3. Arbeitsmodell
| | Claude Code | Codex CLI |
|---|---|---|
| Worktree | `C:\Users\Administrator\Documents\Chris\Jarvis-claude` | `C:\Users\Administrator\Documents\Chris\Jarvis-codex` |
| Branch | `agent-claude/main` | `agent-codex/main` |
| Regeln | `CLAUDE.md` → `@AGENTS.md` | `AGENTS.md` |
| Schutz | `.claude/settings.json` (deny-Liste) | `.codex/config.toml` (Sandbox `workspace-write`, kein Netz, Approval `on-request`) + `.codex/rules/jarvis.rules` |
| Zugriff | liest/schreibt/testet/committet den ganzen Quellcode des Worktrees | dasselbe |

- Beide Branches starten vom selben Stand und sind unabhängig. Hauptordner `Jarvis` (Branch `claude/jarvis-voice-dashboard-9phl5w`) ist Chris' Integrationsstand und wird von den Werkzeugen nicht bearbeitet.
- Worktrees enthalten keine `.secrets/`, kein `.env`, keine `data/`-Kundendaten (sind git-ignoriert) – die Werkzeuge können Produktion nicht versehentlich ansprechen. Tests nutzen Attrappen.
- Integration (durch Chris oder auf Anweisung): in `Jarvis` `git merge agent-claude/main` bzw. `git merge agent-codex/main` (oder `git cherry-pick`), Tests, dann erst Push/Deploy. Konflikte entscheidet Chris; wer zweiter integriert, rebased: `git rebase claude/jarvis-voice-dashboard-9phl5w`.
- Isolation: eigenes `node_modules` je Worktree; Git-Schreibrechte von Codex nur auf `refs/heads/agent-codex/*` und den eigenen Worktree-Index (Claude nutzt `agent-claude/*`), so kann keiner den Branch des anderen oder `main` verändern.
- Worktrees (neu) einrichten: `powershell -File scripts/setup-dev-worktrees.ps1` (idempotent).

## 4. Entwicklungsbefehle
```
npm start                                   # Dashboard lokal (http://localhost:3000)
node scripts/dev-check.mjs                  # Schnellcheck: Syntax, Secret-Scan, Regeldateien
node scripts/dev-check.mjs --full           # + komplette Unit-Suite
npm test                                    # alle Unit-Tests (isoliertes Temp-Verzeichnis)
node scripts/run-unit-tests.mjs test/X.test.js   # einzelne Datei(en)
npm run test:tf080                          # thematische Gates (package.json: test:tfNNN, test:release-NNN)
npm run test:repair-integration             # Reparatur-Integration (Sandbox)
node scripts/secret-scan.mjs                # Secrets in getrackten Dateien
npm run readiness                           # read-only Produktions-Bereitschaft (gegen Produktion nur mit Freigabe)
```
Browser-Tests brauchen Chromium. Passt die installierte Playwright-Version nicht, `JARVIS_CHROMIUM_PATH=<Pfad zu chrome.exe>` setzen (hier: `%LOCALAPPDATA%\ms-playwright\chromium-1248\chrome-win64\chrome.exe`).

## 5. Tests für Änderungen
- Pre-commit-Hook (`.githooks/pre-commit`, aktiv über `git config core.hooksPath .githooks`): `dev-check` auf gestagten Dateien – blockiert Syntaxfehler, Secret-/Kundendaten-Pfade, Secret-Scan-Treffer.
- Jede Änderung bekommt einen passenden Test in `test/` (Konvention `test/<thema>-<TF>.test.js`, `node:test`, Fixtures statt Netz). Vor Übergabe `dev-check --full`; Zahlen (pass/fail) in `docs/STATUS.md`. Ein Fehlschlag, der schon vor der Änderung bestand, steht unter «Bekannte Fehler» – nicht still ignorieren und nicht durch Lockern der Prüfung «lösen».
- `test/dev-control-center.test.js` schützt diese Zentrale selbst (Regeln, Sperrlisten, Hook).

## 6. Deployment (nur mit ausdrücklicher Freigabe von Chris, nie durch die Werkzeuge)
Deploy-Skripte liegen in `deploy/vps/`; sie bauen aus `git archive HEAD` und starten Container neu. Ablauf nach Freigabe: 1) Tests grün + Secret-Scan; 2) Änderung in `claude/jarvis-voice-dashboard-9phl5w` integriert und committet; 3) Wartungsfenster, Mail-Queue prüfen (kein Versand läuft); 4) `deploy/vps/deploy.sh <host>` (Mail-Worker, unterbricht das 24/7-Mailing!) bzw. `deploy-repair.sh` / `deploy-crm.sh` / `deploy-vn.sh` / `deploy-calling.sh` / `deploy-contacts.sh` (ohne Mail-Unterbruch); 5) Healthcheck (`docker inspect` Health, `node scripts/check-mail-auth.mjs`); 6) `PROJECT_STATE.md` mit Commit und Zeit ergänzen. Netlify (Oberfläche) deployt bei Push auf den Hauptbranch.

## 7. Rollback
- **Code lokal:** `git revert <commit>` (nie `reset --hard` auf geteilten Branches). Worktree verwerfen: `git worktree remove ..\Jarvis-codex` + Branch löschen, danach `setup-dev-worktrees.ps1`.
- **VPS-Dienste:** jedes Deploy behält die Vorversion als `/opt/<dienst>/app.old` und die Commit-ID in `DEPLOYED_COMMIT`. Rollback: früheren Commit auschecken und dasselbe Deploy-Skript erneut (Freigabe nötig) – oder `app.old` zurückbenennen und `docker compose up -d --build`.
- **Netlify:** im Dashboard ein früheres Production-Deploy «Publish deploy», oder Revert-Commit pushen.
- **Zustand/Daten:** `docs/DISASTER_RECOVERY.md` (verschlüsselte Backups, `scripts/restore-state.mjs`; Restore überschreibt nie Bestehendes).
- **Reparaturen bei Kunden:** Backup + Rollback sind Teil von `repair-workflow.js` und den Adaptern.

## 8. Sicherheitsregeln
Verbindlich in `AGENTS.md` («Sicherheitsregeln»). Kurz: keine Deployments, Zahlungen, Kundenmails, Anrufe, kostenpflichtigen API-Aufrufe oder Produktionsdaten-Änderungen ohne separate Freigabe; keine Secrets lesen/ausgeben/committen; keine bestehende Prüfung umgehen oder abschwächen; im Zweifel stoppen und fragen. Technisch unterstützt durch Worktrees ohne Secrets, `.claude/settings.json`, `.codex/config.toml` + `.codex/rules/jarvis.rules`, pre-commit-Hook und Secret-Scan.
Grenze: Die Sperrlisten sind Präfix-Regeln gegen Versehen. Ein Werkzeug mit Shell könnte sie über Umwege (z. B. `node -e`) umgehen; deshalb gilt die Regel zusätzlich als Anweisung, und die Worktrees besitzen keine Zugangsdaten. Der Hauptordner `Jarvis` enthält Secrets und ist nicht abgeschirmt.

## 9. Freigaben, die nur Chris erteilt
Push/Merge in den Hauptbranch · jedes Deployment/jeder Container-Neustart · SSH/VPS-Zugriff · Stripe Live · E2E-Läufe mit echten Mails (TF-080/088) · kostenpflichtige APIs · Lockerung der Sandbox (`danger-full-access`, Netzwerk an) · Installation weiterer Werkzeuge.
