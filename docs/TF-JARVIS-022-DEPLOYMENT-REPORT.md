# TF-JARVIS-022 – Hetzner-Deployment (Bericht)

Stand: 2026-10-21 · **Ergebnis: DEPLOYMENT BLOCKED (Gate 5: SSH-Zugang)** – Stop-Bedingung B.
Es wurde nichts auf dem Server ausgeführt: kein Deploy, kein Rollback, keine Container-Änderung, keine Datenänderung, kein Fiverr-Zugriff.

## Ponytail (global)

Nicht installiert. Quelle geprüft (`DietrichGebert/ponytail@09c434a`, v5.3.2; Hooks nur lokal, Netzwerk nur über optionalen, standardmässig leeren Webhook).
Der Installationsbefehl `claude plugin marketplace add … / plugin install ponytail@ponytail --scope user` wurde zweimal vom Claude-Code-Auto-Mode-Classifier
blockiert und nicht umgangen. Funktionsnachweis daher nicht möglich. Installation durch Chris: siehe «Nächste Schritte».

## Branch, Release-Commit, CI

| Punkt | Wert |
|---|---|
| Branch | `tf-jarvis-021-cloud-ci` (GitHub `ChrisTheKey/Jarvis`) |
| Release-Kandidat | **`16f17f51fbc48ea4f9258358204f0216eca6b34e`** |
| CI-Lauf | **39608530114** – https://github.com/ChrisTheKey/Jarvis/actions/runs/39608530114 – alle 9 Jobs + Release-Gate `success` |
| Release-Branches | `release/tf016-on-cfc5b36` (nur lokal, HEAD `9cb42e9`) |
| Release 9cb42e9 | **nicht** gleichzusetzen: = cfc5b36 + TF-016, nie in CI gelaufen, nicht auf GitHub. Der Kandidat `16f17f5` enthält denselben TF-016-Patch (patch-id `c413784423eb`) plus TF-088, TF-020, TF-021 |
| Serverstand | laut `TF-JARVIS-020-PRODUCTION-READINESS.md` cfc5b36 – **nicht verifiziert** (kein SSH) |

### Was produktiv ausgerollt würde (cfc5b36 → 16f17f5, ohne test/, docs/, .github/)

| Datei | Herkunft | Wirkung |
|---|---|---|
| `lead-finder.js` | TF-016 | Overpass-Zuverlässigkeit, isolierter Stale-Audit-Recheck |
| `repair-outbox.js`, `check-150-workflow.js`, `e2e-test.js`, `E2E_CHECK150_RUNBOOK.md` | TF-088 | kontrollierter E2E-Erfüllungstest CHF 150 (Standard AUS) |
| `deploy/vps/install-stripe-keys.sh` | TF-088 | Hilfsskript (nur manuell) |
| `deploy/vps/repair-remote.sh` | TF-021 | `chown root:root` für `/opt/jarvis-payment` nur bei gesetztem OWNER – Produktionsverhalten unverändert |
| `package.json` | TF-020 | nur npm-Testskript; **keine neuen Abhängigkeiten** |
| `scripts/*` | TF-015/020/021 | Wartungs-/CI-Skripte, nicht im Worker-Pfad |

Keine Datenbank-/Schemamigration im Diff.

## Testergebnisse (Lauf 39608530114)

Unit 1166 Tests (1154 bestanden, 0 fehlgeschlagen, 12 übersprungen) · E2E 1/1 · repair 18/18 · repair-quality 5/5 · separation 8/8 · browser 10/10 ·
full-order 8/8 · Syntax/Secret-Scan/Audit success · Release-Gate success. Details und Fehlerhistorie: `TF-JARVIS-021-CLOUD-CI-READINESS.md`.

## Hetzner-Zugang und Zustand vor dem Deployment

- Geprüft: `~/.ssh/config` → Alias `fiverr`, Benutzer `fiverradmin`, dokumentierter Schlüssel `fiverr_hetzner_working_ed25519`, `IdentitiesOnly yes`;
  Doku `DISASTER_RECOVERY.md:27`: Schlüssel **mit Passphrase** über `ssh-agent`.
- Befund: Dienst `ssh-agent` **Stopped** (StartType Manual), keine Identität geladen; Schlüssel lokal als passphrasegeschützt bestätigt.
  `ssh -o BatchMode=yes fiverr` → `Permission denied (publickey,password)`.
- Keine weiteren Schlüssel probiert, nichts auf dem Server hinterlegt, keine Zugangsdaten ausgegeben, verschlüsselte Passphrase-Datei nicht angefasst.
- **Zustand vor dem Deployment: nicht erfassbar** (Container, Health, RAM, Disk, Volumes, Backups, Netzwerke, Fiverr-Container-IDs/StartedAt).

## Deployment-Gates

| # | Gate | Status |
|---|---|---|
| 1 | Alle Pflicht-CI-Jobs erfolgreich | ✅ Lauf 39608530114 |
| 2 | Getesteter Commit = Release-Commit | ✅ `16f17f5` (Deploy müsste aus einem sauberen Checkout genau dieses Commits erfolgen; `deploy.sh` nutzt `git archive HEAD`) |
| 3 | Keine ungeprüften Änderungen im Kandidaten | ✅ |
| 4 | Keine Secrets im Repository | ✅ Secret-Scan success |
| 5 | Hetzner-SSH-Zugang funktioniert | ❌ **ssh-agent gestoppt, Schlüssel nicht geladen** |
| 6 | Produktionskonfiguration vollständig | ❓ nicht prüfbar (H1) |
| 7 | Daten bleiben erhalten | ❓ nicht prüfbar (H1); Skript überschreibt Secrets/Zustand nicht |
| 8 | Rollback-Pfad nachweislich verwendbar | ❓ `app.old`-Mechanismus im Skript vorhanden, auf dem Server nicht verifiziert |
| 9 | Speicherplatz verfügbar | ❓ nicht prüfbar |
| 10 | Andere Docker-Projekte unverändert | ❓ Baseline nicht erfassbar |
| 11 | Deployment-Skripte geprüft | ✅ `deploy.sh` (Mail-Worker, Recreate = Wartungsfenster), `deploy-repair.sh`/`repair-remote.sh` (Repair, Mail-Worker unberührt, Guards) |
| 12 | Serverstand eindeutig festgestellt | ❓ nicht prüfbar |

→ **DEPLOYMENT BLOCKED.**

## Deployment, Healthchecks, Fiverr-Isolation, Rollback

- Deployment-Zeitpunkt: – (nicht durchgeführt)
- Deployment-Ergebnis: **blockiert vor jeder Serveraktion**
- Jarvis-Healthchecks: nicht prüfbar
- Fiverr-Isolationsnachweis: trivial erfüllt – keine Verbindung zum Server, daher keinerlei Einwirkung
- Rollback-Status: nicht erforderlich

## Noch offene Blocker

| # | Blocker | Wer |
|---|---|---|
| H1 | `ssh-agent` gestoppt / Schlüssel mit Passphrase nicht geladen | Chris |
| P1 | Ponytail-Installation (Auto-Mode blockiert) | Chris |
| B1–B3, B5 | Rechtliche Freigaben (Cold-E-Mail CH, CH-/VN-Calling), Stripe Live | Chris + Rechtsberatung |

## Nächste Schritte

1. In einer **eigenen PowerShell** (Passphrase aus dem Passwort-Manager):
   `Start-Service ssh-agent; ssh-add $HOME\.ssh\fiverr_hetzner_working_ed25519`
2. In Claude Code (zwei getrennte Prompts): `/plugin marketplace add DietrichGebert/ponytail`, dann `/plugin install ponytail@ponytail`; Claude Code neu starten.
3. TF-JARVIS-022 erneut starten: Pre-Flight lesend (Container, Health, RAM/Disk, Volumes, Backups, Netzwerke, Fiverr-Baseline), dann bei allen Gates ✅ genau ein
   Deploy von `16f17f5` aus einem sauberen Checkout per Git Bash: `bash deploy/vps/deploy.sh fiverr` (Mail-Worker) bzw. `deploy-repair.sh` (Repair).

## Bewertung

- TECHNICAL COMPLETION: **93 %**
- CI VERIFICATION: **100 %**
- DEPLOYMENT READINESS: **60 %**
- BUSINESS PRODUCTION READINESS: **55 %**
