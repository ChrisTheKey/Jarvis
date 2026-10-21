# TF-JARVIS-021 – Cloud-CI-Readiness (Abschlussbericht)

Stand: 2026-10-21 · Branch `tf-jarvis-021-cloud-ci` · Worktree `Jarvis-tf020` · Repository **öffentlich** (`ChrisTheKey/Jarvis`).
Keine Produktionsdaten verändert, keine Container auf dem VPS angefasst, kein Deployment, keine echten Mails/Anrufe/Zahlungen, kein Force-Push.

## 1. Ponytail (global) – Installation und Funktionsnachweis

| Schritt | Ergebnis |
|---|---|
| Quelle | `github.com/DietrichGebert/ponytail`, geprüft auf Commit `09c434a` (2026-10-18), Plugin-Version 5.3.2 |
| Offizielle Anleitung (`INSTALL.md`, Claude Code) | `/plugin marketplace add DietrichGebert/ponytail`, dann (separater Prompt) `/plugin install ponytail@ponytail` |
| Hooks geprüft | `SessionStart` (`ponytail-activate.js`), `SubagentStart` (`ponytail-subagent.js`), `UserPromptSubmit` (`ponytail-mode-tracker.js`), Band-Modul `hooks/band/register.tsx` |
| Dateizugriffe | nur lokal: `~/.claude/.ponytail-active`, `%APPDATA%\ponytail\config.json`, CSV-Ledger `~/.config/ponytail/band/<projekt>.csv`; liest `~/.claude/settings.json` (statusLine, schlägt Änderung nur vor) und `git ls-files` |
| Datenübertragung | nur über den optionalen Webhook (`userConfig.webhookUrl`, Standard **leer**), nur HTTPS. Keine Secret-Zugriffe |
| Installation | **nicht durchgeführt** – zweimal vom Claude-Code-Auto-Mode-Classifier blockiert («Unauthorized Persistence» / «Blocked by classifier»). Nicht umgangen |
| Funktionsnachweis | **offen** – erst nach Installation durch Chris und Neustart von Claude Code möglich |

## 2. GitHub-Actions-Läufe

| Lauf | Commit | Ergebnis | Link |
|---|---|---|---|
| 39602454518 | `e05a62f` | failure – repair (mtime), separation (UID) | https://github.com/ChrisTheKey/Jarvis/actions/runs/39602454518 |
| 39605476592 | `a24ad45` | failure – nur separation (`/app` 0700) | https://github.com/ChrisTheKey/Jarvis/actions/runs/39605476592 |
| 39607194519 | `924856c` | failure – nur separation C (`chown /opt/jarvis-payment`) | https://github.com/ChrisTheKey/Jarvis/actions/runs/39607194519 |
| **39608530114** | **`16f17f5`** | **success – alle 9 Jobs, Release-Gate grün** | https://github.com/ChrisTheKey/Jarvis/actions/runs/39608530114 |

## 3. Testergebnisse (Lauf 39608530114, Commit `16f17f5`, JUnit-Artefakte ausgewertet)

| Job | Job-ID | Tests | Bestanden | Fehlgeschlagen | Übersprungen |
|---|---|---|---|---|---|
| Syntax, Secret-Scan, Audit | 119250982037 | – | success | 0 | – |
| Unit-Suite | 119251142122 | 1166 | 1154 | **0** | 12 |
| TF-020 End-to-End (13 Stufen) | 119251142031 | 1 | 1 | 0 | 0 |
| Docker-Lab repair | 119251142088 | 18 | 18 | 0 | 0 |
| Docker-Lab repair-quality | 119251142108 | 5 | 5 | 0 | 0 |
| Docker-Lab separation | 119251142190 | 8 | 8 | 0 | 0 |
| Docker-Lab browser | 119251142152 | 10 | 10 | 0 | 0 |
| Docker-Lab full-order | 119251142045 | 8 | 8 | 0 | 0 |
| Release-Gate | 119255054399 | – | success | – | – |

Die 12 übersprungenen Unit-Tests sind die bekannten Lab-/Umgebungs-Skips (bereits in der TF-020-Baseline 12 Skips).

## 4. Repair-Lab-Korrektur (Commit `a24ad45`)

- **Fehler (Lauf 39602454518):** `AssertionError: 0 Write ausserhalb des Webroots`. Vollständigen Ist/Soll-Diff ausgewertet: einzige Abweichung
  `drwxr-sr-x … public_html` mit mtime **12:49 → 12:50**. Ein erlaubter Write *im* Webroot ändert dessen mtime; `outsideSnapshot` nahm sie via `ls -la` mit.
- **Korrektur (`test/integration/repair-lab/lab.mjs`):** `public_html` aus `ls -la` gefiltert und über `stat -c '%A %U:%G %n'` (Rechte + Besitz) verglichen.
  Alle übrigen Einträge, alle Datei-Hashes ausserhalb und der Webroot-Inhalt (`webrootSnapshot`) bleiben geprüft. **Keine Prüfung abgeschwächt.**
- Nachweis: repair-Lab in den Läufen 39605476592, 39607194519 und 39608530114 grün (18/18). Eigener Regressionstest nicht nötig – der Lab-Test ist die Regression.

## 5. Separation-Lab (Commits `a24ad45`, `924856c`, `16f17f5`)

Drei aufeinanderfolgende, jeweils im CI-Log belegte Ursachen (Linux-Runner UID 1001, Container UID 1000; unter Docker Desktop/Git Bash unsichtbar):

1. Bind-Mounts `secrets/`, `state/outbox/crm-export` 0755 im Besitz des Runners → für UID 1000 nicht beschreibbar. Fix: auf Linux 0777 im Lab-Tmp; Cleanup gibt die
   Container-Dateien per Wegwerf-Container frei. (Alleine nicht ausreichend – Lauf 39605476592 weiter rot.)
2. `snapshot()` archiviert ein `mkdtemp`-Verzeichnis (0700) mit `tar -C dir .`; tar überträgt den Modus von `./` auf `app-mail` (= `/app:ro`) → Node startet nicht.
   Fix: `app-mail` auf 0755; zusätzlich gibt der Test bei Health-Timeout die Container-Logs aus. **Beleg:** Lauf 39607194519 Test A grün (13,8 s statt 300-s-Timeout).
3. `deploy/vps/repair-remote.sh` erzwang `chown root:root /opt/jarvis-payment` auch im Lab (`SUDO="" OWNER=""`) → `Operation not permitted`.
   Fix: wie bereits für `$R/.env` (Zeile 80) nur bei gesetztem `OWNER`. **Produktion unverändert** (`deploy-repair.sh` setzt kein OWNER → Default `1000:1000`, `SUDO=sudo`);
   `chmod 700/600` gilt immer.

Ergebnis: **8/8** in Lauf 39608530114. Keine Assertion verändert.

## 6. Repair-Quality-Lab

5/5 bestanden in allen drei Läufen nach `e05a62f` (zuletzt Job 119251142108).

## 7. Playwright-MCP

- Kein neuer Playwright-MCP-Lauf in diesem Abschluss; die Browser-Prüfungen laufen jetzt reproduzierbar im CI-Job «Docker-Lab browser» (10/10, headless Chrome).
- Ein mobiler CRM-Screenshot aus der vorherigen Sitzung (`docs/tf-jarvis-021/tf021-crm-mobile.jpg`) zeigt **produktive Kennzahlen** («Stand VPS») und wird deshalb
  **nicht** in das öffentliche Repository committet (bleibt lokal).
- Vollständige Playwright-MCP-Ergebnisse: `TF-JARVIS-020-PRODUCTION-READINESS.md`, Abschnitt 5.

## 8. Hetzner (VPS, Alias `fiverr`)

- Geprüft: `~/.ssh/config` (Alias `fiverr`, Benutzer `fiverradmin`, `IdentityFile ~/.ssh/fiverr_hetzner_working_ed25519`, `IdentitiesOnly yes`) und
  `docs/DISASTER_RECOVERY.md:27` (derselbe Schlüssel **mit Passphrase**, geladen über `ssh-agent`).
- Ein Versuch über den dokumentierten Alias (`ssh -o BatchMode=yes fiverr`): `Permission denied (publickey,password)`.
- **Ursache:** Windows-Dienst `ssh-agent` **gestoppt** (StartType Manual, `Error connecting to agent`); lokal bestätigt, dass der Schlüssel passphrasegeschützt ist.
  Keine anderen Schlüssel probiert, nichts auf dem Server hinterlegt, `*.pass.enc` nicht angefasst.
- Folge: keine lesenden Produktionsprüfungen möglich → Blocker H1.

## 9. Release-Status

| Punkt | Befund |
|---|---|
| Git-Status | sauber bis auf `docs/tf-jarvis-021/` (Screenshot, bewusst nicht committet) |
| Getesteter Commit | `16f17f51fbc48ea4f9258358204f0216eca6b34e` (Lauf 39608530114, alle Jobs grün). Nachfolgende Commits ändern nur `docs/` |
| Release `9cb42e9` | Branch `release/tf016-on-cfc5b36` (Worktree `Jarvis-release-tf016`, sauber). **Nicht auf GitHub, nie in CI gelaufen.** = cfc5b36 + TF-016 |
| Verhältnis | TF-016-Patch in 9cb42e9 und `2bff67e` identisch (git patch-id `c413784423eb`). `16f17f5` = cfc5b36 + TF-088 + TF-016 + TF-020 + TF-021 → **Obermenge**, nicht gleich 9cb42e9 |
| Laufzeit-Diff cfc5b36 → 16f17f5 | `lead-finder.js` (TF-016), `repair-outbox.js`, `check-150-workflow.js`, `e2e-test.js`, `deploy/vps/install-stripe-keys.sh` (TF-088), `deploy/vps/repair-remote.sh` (TF-021), `package.json` (nur npm-Skripte, **keine neuen Abhängigkeiten**), Skripte/Doku |
| Deploy-Abhängigkeiten | Git Bash (nicht WSL), `ssh-agent` mit Schlüssel, Wartungsfenster (Mail-Worker-Recreate), `deploy/vps/deploy.sh fiverr` aus einem sauberen Checkout von `16f17f5` |
| Rollback | `deploy.sh` behält `/opt/jarvis-mail/app.old`; Rücksprung = Deploy von cfc5b36 mit demselben Skript. Repair-Seite: `app.old` in `repair-remote.sh` |
| Produktionsrisiken | kurzer Mail-Versand-Stopp beim Recreate (Outbox puffert); gleicher Host wie `/opt/fiverr`; Serverstand (cfc5b36) nur aus Doku, nicht verifiziert |

**Release-Kandidat:** `16f17f5` (statt 9cb42e9, da nur dieser Commit vollständig CI-verifiziert ist). Details und Gate-Prüfung: `TF-JARVIS-022-DEPLOYMENT-REPORT.md`.

## 10. Offene technische Blocker

| # | Blocker | Wer |
|---|---|---|
| H1 | SSH: `ssh-agent` gestoppt, passphrasegeschützter Schlüssel nicht geladen → keine VPS-Prüfung, kein Deploy | Chris |
| P1 | Ponytail-Installation vom Auto-Mode blockiert → manuell auslösen | Chris |
| B4 | Release nicht deployt (VPS laut Doku = cfc5b36) | hängt an H1 |
| B7 | Produktions-Laufzeitwerte nur auf dem VPS prüfbar | hängt an H1 |
| B8 | Kein Lint/Typecheck (ersetzt durch `node --check` in der CI) | optional |

## 11. Rechtliche und betriebliche Freigaben (unverändert aus TF-020)

1. **B1 Cold-E-Mail CH** (UWG Art. 3 Abs. 1 lit. o) – Draft-only bis zur Rechtsklärung.
2. **B2 CH-Outbound-Calls** – gesperrt (`CH_CALLING_DISABLED`).
3. **B3 VN-Calling** – `BLOCKED_PENDING_LEGAL_REVIEW`.
4. **B5 Stripe Live** – nur Sandbox geprüft.
5. Review/Merge von `tf-jarvis-021-cloud-ci`.

Keine Compliance-Sperre wurde umgangen oder gelockert.

## 12. Nächster konkreter Schritt

Chris lädt den Schlüssel (in einer eigenen PowerShell): `Start-Service ssh-agent; ssh-add $HOME\.ssh\fiverr_hetzner_working_ed25519`, danach Ponytail per
`/plugin marketplace add DietrichGebert/ponytail` und `/plugin install ponytail@ponytail` installieren. Dann TF-JARVIS-022 (Pre-Flight + Deploy von `16f17f5`) fortsetzen.

## Bewertung

- Technische Fertigstellung: **93 %** – alle Komponenten getestet, Linux-CI-Fehler behoben; offen nur Deploy und VPS-Laufzeitprüfung.
- CI-Verifikation: **100 %** der Pflicht-Jobs grün (Lauf 39608530114).
- Deployment-Bereitschaft: **60 %** – Release-Kandidat eindeutig und getestet, aber SSH-Zugang und Serverstand ungeprüft.
- Produktionsreife des Geschäftsprozesses: **55 %** – unverändert durch rechtliche Freigaben (B1–B3) und Stripe Live (B5) begrenzt.
