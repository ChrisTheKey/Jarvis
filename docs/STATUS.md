# Jarvis – gemeinsamer Entwicklungsstatus (Claude Code + Codex CLI)

Kurzer, aktueller Stand für beide Werkzeuge. Lesen vor Beginn, aktualisieren im selben Commit wie die Arbeit. Details je Ticket: `PROJECT_STATE.md` (nicht hier duplizieren). Keine Secrets, keine Kundendaten.

Zuletzt aktualisiert: 2026-10-28 (TF-JARVIS-034: finale lokale Docker-Abnahme und Full-Check grün; kein produktiver Versand/Deployment)

## Erledigt (Code fertig laut PROJECT_STATE.md, Produktionsstand siehe dort)
- TF-JARVIS-024 Produktions-Image-Fix: `sales-intake-bundle.js` ist im Repair-Image enthalten; der isolierte Service-Separation-Gate-Test ist danach 9/9 gruen.
- TF-JARVIS-024 Phase 3: Offer-Intent-Bundle, verifizierte Auswahl/Materialisierung, CHF-480-Tresoraktivierung über den bestehenden Access-Intake und bestehende Zahlungs-/Completion-Gates lokal implementiert und gezielt getestet; lokaler Commit vorhanden, nicht deployed.
- TF-JARVIS-024 Direct-Mail: Button „Mail senden“ im Leadpanel, exakt freigegebene Erstmail mit auftragsgebundenem One-Time-Access-Link und ausschliesslichen Stripe-Sandbox-Links, serverseitige Sandbox-/Synthetic-Gates, Queue-Idempotenz und Worker-Prüfung implementiert; direkte Tests 5/5, relevante Regressionen 38/38 und isolierter Browsernachweis 1/1 (Desktop, Mobile, Reload, genau ein Auftrag) grün; kein echter Versand.
- TF-JARVIS-033: gemeinsamer Adaptervertrag und fail-closed Provider-Erkennung implementiert; Commit `5c0c226`, Full-Check 1'213/1'201/0/12 mit Exit 0, Abschlussbericht unter `reports/TF-JARVIS-033-ABSCHLUSSBERICHT.md`; Docker-Labs und Produktionsfreigabe bleiben BLOCKED.
- TF-JARVIS-031: CRM-Refresh-/Pointer-DOM-Race in `public/crm.js` minimal behoben; synthetische Regressionstests N2/N3 ergänzt; N/N2/N3 sowie der vollständige `crm-browser-053`-Lauf und TF-024 Phase 5 grün; abschließender Full-Check 1199/1187/0/12 mit Exit 0. Docker-Labs bleiben wegen des blockierten read-only Docker-Aufrufs offen.
- TF-JARVIS-025 Produktionsprüfung: tatsächlicher Worker-Status überschreibt im CRM keinen veralteten lokalen Queue-Hinweis mehr; `vn-order-064` übernimmt die `lead_id` auch beim CHF-150-Check-Auftrag. Browser-, Direkt-, Sicherheits- und E2E-Regressionsprüfungen sind mit vorhandenem Chromium grün; vier isolierte Screenshots liegen unter `reports/TF-JARVIS-025/screenshots/`. Der Produktionsversand bleibt bis zur ausdrücklichen Freigabe gesperrt.
- P0-Sicherheitsstufe und Entfernung der autonomen LiveKit-Agententelefonie im lokalen Codex-Worktree: CRM-Anruflisten, Historie, Status, Rückrufe und Vertriebs-/Zahlungs-/Provisionspfade bleiben erhalten; nicht deployt.
- Korrektur des LiveKit-Entfernungsauftrags: menschlicher Calling-Lesezugang für alle vier Rollen, CRM-Call-History/Rückrufe im Calling-Dashboard und CH/VN-Mitarbeiter-UI wiederhergestellt; autonome Start-/Worker-/Providerpfade bleiben fail-closed.
- Finale Freigabeprüfung: 14 ursprüngliche Fehler klassifiziert (11 Chromium-/Umgebungsfehler mit vorhandenem Binary behoben, 3 veraltete autonome Calling-Erwartungen in Tests aktualisiert); menschliche Vertriebs-Regressionen 98/98 grün.
- TF-JARVIS-026 Produktionsvorbereitung: Repository-/Branch-Integration, Hetzner-/Docker-/Netlify-/Mail-/Repair-/Stripe-/Zugangstresor-Abhängigkeiten sowie priorisierte Deployment- und Rollback-Risiken read-only aus Dokumentation und Konfiguration bewertet; drei TF-026-Berichte erstellt. Status bleibt BLOCKED, weil der Codex-Stand noch nicht integriert ist, der direkte CRM-Mailweg weiterhin absichtlich TEST-only ist und der reale VPS-/Netlify-Stand ohne SSH nicht verifiziert wurde.
- TF-JARVIS-027 sichere Integration: `agent-codex/main` (`b9649bc`) wurde im isolierten Branch `agent-codex/tf027-integration` gegen `claude/jarvis-voice-dashboard-9phl5w` (`07b68c5`) zusammengeführt; einziger Konflikt war `docs/STATUS.md`, Integrationscommit `29b7527`. Lokale Nicht-Docker-Regressionen 1181/1169/0/12 und gezielte TF-024-Prüfung 17/17 grün; Docker-/Repair-Gates wegen des vor Ausführung blockierten Docker-Aufrufs nicht gestartet, daher BLOCKED.
- P0-Abschlussprüfung: Gmail-, Stripe-, Discovery- und CRM-Einstiegspunkte verwenden das zentrale Capability-Gate; Dockerfile-Kopiellisten ergänzt; Chromium-Testpfad mit vorhandenem Chromium verifiziert.
- Always-on Mail-Worker auf VPS (alleiniger Sender), Gmail-OAuth, Versandfenster/Tageslimit, DNC-Durchsetzung (TF-047…056).
- CRM-Dienst `jarvis-crm` mit allen qualifizierten Leads (TF-053/057), Reparatur-Dienst `jarvis-repair`.
- Stripe-Anzahlung, Zahlungslinks, Nachfassen, Webhook, Zahlungs-Gate (TF-080/081/084/085).
- Kontaktformular → Gespräch → sicherer Zugang → Reparatur (TF-079), Geräte-Kopplung (TF-074).
- Kontrollierter E2E-Test CHF 150 (TF-088, Standard AUS) und CRM-Test-Kennzeichnung (TF-086).
- Netlify-Drop-Adapter, Browser-Audit, interner CHF-480-Testauftrag (TF-JARVIS-PRAXIS-002: «CODE READY, nicht deployt»).
- Development Control Center: `AGENTS.md`, `CLAUDE.md`, Worktrees `agent-claude/main` + `agent-codex/main`, `scripts/dev-check.mjs`, Codex-/Claude-Schutzregeln.
- Regulärer Node-Testlauf entdeckt nur versionierte Dateien aus `test/`; der manuelle CRM-Browser-Test bleibt als expliziter Direktaufruf erhalten.

TF-JARVIS-028: Neue CHF-150-/CHF-480-Abschlussmailvorlagen, vollständige Quittungsgates, CHF-330-Upgrade-Zuordnung, Webhook-Idempotenz und CRM-Statusanzeige sind im isolierten Branch implementiert. Gezielte Tests und alle TF-028-Fälle im Vollcheck sind grün; der Vollcheck endete mit 1.197 Tests, 1.172 bestanden, 13 Fehlern in historischen Vertragsfällen und 12 übersprungenen Docker-/Repair-Labs. Siehe `reports/TF-JARVIS-028/ABSCHLUSSBERICHT.md`.

## In Arbeit
| Wer | Branch/Worktree | Aufgabe |
|---|---|---|
| Chris | `Jarvis` (Hauptordner) | uncommittete Änderungen: `crm-api.js`, `crm-service.js`, `stripe-payments.js`, Tests (CRM-Pagination u. a.), `.gitignore`, `package.json`. Nicht in den Worktrees enthalten. |
| Claude | `agent-claude/main` | – (frei) |
| Codex | `agent-codex/tf033` / `Jarvis-tf033` | – (fertig; kein Push, Merge oder Deployment) |
| Codex | `agent-codex/tf034` / `Jarvis-tf034` | TF-034 lokal abgenommen; fünf isolierte Docker-Gruppen und Full-Check grün; kein Push/Merge/Deployment |

Regel: Wer eine Aufgabe beginnt, trägt sie hier ein (Wer / Branch / Aufgabe), wer fertig ist, verschiebt sie nach «Erledigt».

## TF-JARVIS-034 (2026-10-27)

### Erledigt
- Alle Reparaturpfade verwenden für CHF 480 das Vollzahlungs-Gate; CHF 240 bleibt blockiert.
- CHF-150-Check, CHF-330-Upgrade-Gutschrift, Idempotenz und Refund-Regressionen testgetrieben geprüft.
- Synthetische Reparatur-Fixtures für WordPress, GitHub/Netlify und SFTP/SSH auf CHF 480 aktualisiert.
- Bericht: `reports/TF-JARVIS-034-ABSCHLUSSBERICHT.md`.

### Offen / Blockiert
- Keine offenen lokalen TF-034-Testfehler. Die separate manuelle externe E2E-Abnahme (`reports/TF-JARVIS-MANUAL-E2E-150-480.md`) bleibt `BLOCKED`, weil kein autorisiert erreichbarer JARVIS-API-/Mail-Worker-/Repair-Endpunkt mit Testauthentifizierung vorlag; es wurden 0 Mails und 0 Zahlungen ausgelöst. Produktionsfreigabe, Push, Merge und Deployment wurden nicht ausgeführt und benötigen weiterhin separate menschliche Freigabe.
- Playwright-MCP war nicht exponiert; die lokalen `playwright-core`-Fixtures liefen mit vorhandenem Chromium grün.

### Testergebnis
- TF-034: Full-Check 1'215 Tests, 1'203 bestanden, 0 fehlgeschlagen, 12 übersprungen; Exit 0 / `CHECK OK`. Die 12 Docker-Tests wurden separat in fünf isolierten Gruppen ausgeführt: 49/49 bestanden, 0 fehlgeschlagen, 0 übersprungen; Cleanup jeweils ohne verbleibende eigene Container, Volumes oder Netzwerke. Abschlussbericht: `reports/TF-JARVIS-034-ABSCHLUSSBERICHT.md`, Status `READY_FOR_DEPLOY_APPROVAL`.

Codex-Nachtrag 2026-10-26: `3d5efde` und `10bbf70` sind lokal vorhanden und waren vor TF-025 mit `origin/agent-codex/main` synchronisiert. TF-025 ist lokal committed; der Hash steht im aktuellen Git-Log. Bestehende uncommittete Dateien (`test/crm-fixture.js` und `reports/TF-JARVIS-024/phase5-screenshots/`) wurden nicht verändert oder gestaged.

## Bekannte Fehler / verbleibende Blocker
- Aktueller Vollcheck 2026-10-26 mit vorhandenem Chromium: **1192 Tests, 1180 bestanden, 0 fehlgeschlagen, 12 übersprungen; Exit 0**. Die vier untersuchten Fehlergruppen (`browser-audit-praxis002`, `browser-validation-045`, `crm-browser-053`, `vn-order-064`) sind nicht mehr rot; `service-separation-047` bleibt ebenfalls grün.
- Der Produktionsversand ist absichtlich **BLOCKED**: Es wurde keine Live-E-Mail, keine Live-Zahlung und kein Deployment ausgeführt. Für READY fehlen daher weiterhin die ausdrückliche Produktionsfreigabe, echte Produktionskonfiguration und ein separat freigegebener kontrollierter Live-Nachweis.
- TF-JARVIS-026: Der aktuelle Codex-Branch ist noch nicht in `claude/jarvis-voice-dashboard-9phl5w` integriert; `docs/STATUS.md` hat einen Mergekonflikt und `scripts/run-unit-tests.mjs` enthält eine neuere Integrationsänderung. Der direkte CRM-Mailbutton bleibt wegen `JARVIS_SALES_SANDBOX_MODE`/Synthetic-Gates auf Testleads beschränkt. Der laufende VPS-/Netlify-Stand, Backup-Alter, Volumes, Gmail-OAuth und Stripe-Umgebung sind ohne SSH nicht bestätigt. Die 12 Docker-/Repair-Labs des Vollchecks wurden mangels `JARVIS_REPAIR_LAB=1` übersprungen und nicht als bestanden gezählt.
- TF-JARVIS-027: Integrationscommit `29b7527` existiert nur im isolierten Branch. Docker ist als CLI vorhanden, aber der read-only Aufruf wurde vor Ausführung durch den Ausführungs-Guard blockiert; deshalb sind Docker-/Repair-Images, Compose-Isolation und die 12 übersprungenen Labs nicht verifiziert. Kein Push, kein Merge in den Hauptentwicklungsbranch und kein Produktionszugriff.
- TF-JARVIS-027: Der Codex-Stand `b9649bc` wird in einem separaten Integrations-Worktree gegen `claude/jarvis-voice-dashboard-9phl5w` geprüft. Der Konflikt in dieser Datei wird dokumentiert aufgelöst; Hauptcheckout und Codex-Worktree bleiben unverändert.
- Uncommittete Dateien ausserhalb dieses Auftrags bleiben geschützt: `test/crm-fixture.js` sowie `reports/TF-JARVIS-024/phase5-screenshots/`.
- TF-JARVIS-028: Implementierung und gezielte synthetische Tests bestanden; der Vollcheck hat 13 historische Vertragsfehler und 12 übersprungene Docker-/Repair-Labs. Produktionsversand, Live-Zahlungen und Reparaturen an realen Websites bleiben gesperrt.
- TF-JARVIS-031: Engine-/Container-/Netzwerk-/Volume-Inventar konnte wegen `Rejected: Keine Container ohne Freigabe.` nicht read-only ausgeführt werden. Alle zwölf Docker-/Repair-Labs sind deshalb BLOCKED/NOT RUN. Der CRM-Test N besteht im abschließenden Full-Check; es bleibt kein weiterer nachgewiesener CRM-Fehler offen.
- TF-JARVIS-032 Universal Access Vault: Registry, dynamische Tresorformulare und fail-closed Adapterfreigabe implementiert. Gezielte Regressionen 107/107 grün; finaler Vollcheck 1'211 Tests, 1'199 bestanden, 0 fehlgeschlagen, 12 Docker-Labs übersprungen, Exit 0. Docker-Isolation/Labs und separate Produktionsfreigabe offen. Siehe `reports/TF-JARVIS-032/UNIVERSAL_ACCESS_VAULT_ABSCHLUSSBERICHT.md`; kein Push/Merge/Deployment.

## Historischer Baseline-Hinweis

Die folgenden früheren Baseline-Befunde aus dem Integrationsbranch wurden durch die späteren TF-024/TF-025-Prüfungen ersetzt und sind keine aktuellen TF-027-Blocker: fehlendes Chromium ohne `JARVIS_CHROMIUM_PATH`, alte CRM-Text-Erwartungen, CRLF-empfindliche Quelltextprüfungen, die damalige Repair-Image-Kopielliste, der alte Server-Control-Mock sowie die automatische Entdeckung des manuellen `crm_manual_test.mjs`. Die historische Release-Gate-Dokumentation weiter unten bleibt unverändert erhalten.

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
- TF-JARVIS-025: Nach Sichtung des lokalen Commits muss ein normaler Push auf `origin/agent-codex/main` nach den lokalen Push-Regeln durch Chris erfolgen; kein Force-Push. Keine produktive Versandfreigabe ohne separaten Sicherheitsentscheid.
- Spätere Server-Bereinigung: LiveKit-Agent-Container, Calling-Worker, VPS-Dockerfile/Deploy-Skript und zugehörige Secrets nach ausdrücklicher Freigabe entfernen; diese Arbeiten wurden lokal nicht ausgeführt.
- Fehler 1–5 oben beheben (je ein kleiner Commit mit Test).
- Commit der uncommitteten Arbeit im Hauptordner (Chris) – danach `agent-*/main` rebasen.
- TF-JARVIS-PRAXIS-002 und TF-086/088: Deployment ausstehend (nur nach Freigabe von Chris).
- TF-056: Token-Rotation blockiert (kein Netlify-CLI-Login am PC).
- Stripe-Integration: siehe `STRIPE_INTEGRATION_TODO.md`.
- Offene Punkte je Ticket: `PROJECT_STATE.md`, Suche nach «Offen».

## Letzte Verifikation der Zentrale
## TF-JARVIS-029 (2026-10-27)

### Erledigt
- TF-028-Folgefehler in `full-order-046`, `onboarding-066`, `repair-manual-055`, `repair-no-package-062` und `tf088` klassifiziert und die veralteten synthetischen Testverträge testseitig angepasst.
- Zieltests: 56/56 bestanden; TF-028-Regressionen: 16/16 bestanden.
- `node scripts/dev-check.mjs` und Secret-Scan bestanden; kein Produktivcode geändert.
- Abschlussbericht: `reports/TF-JARVIS-029/ABSCHLUSSBERICHT.md`.

### Bekannte Fehler
- Vollsuite / Full-Check: 1197 Tests, 1185 bestanden, 0 fehlgeschlagen, 12 übersprungen, Exit 0 / `CHECK OK`. Ein separater gezielter Lauf hatte zuvor einmal einen Timeout in `crm-browser-053`; der Test bestand im abschließenden Full-Check und bleibt als intermittierender Baseline-Befund zu beobachten.

### Offen / Blockiert
- Die 12 Docker-/Repair-Labs bleiben BLOCKED, weil `JARVIS_REPAIR_LAB=1` und eine nachweisbar isolierte Docker-Laborumgebung fehlen; der lokale Container-Aufruf wurde vom Ausführungs-Guard abgewiesen. Keine Container oder Volumes wurden verändert.
- TF-029 bleibt wegen der 12 nicht ausgeführten Docker-/Repair-Labs BLOCKED. Der Browser-Baseline-Befund ist nach dem Full-Check kein aktueller roter Test, sollte aber separat stabilisiert werden.

### In Arbeit
- Keine weiteren TF-029-Änderungen im Hauptcheckout. Der isolierte Branch `agent-codex/tf029` bleibt für Prüfung erhalten; kein Push, Merge oder Deployment.

## TF-JARVIS-030 (2026-10-27)

### Erledigt
- Isolierter Worktree `Jarvis-tf030` auf Basis von `8540aca` erstellt; bestehende Worktrees und uncommittete Fremdänderungen wurden nicht verändert.
- Docker-Lab-Vertrag statisch geprüft: Run-IDs, `jarvis.lab`-Labels, eigene Netzwerke/Volumes, loopback-gebundene Testports und synthetische Laufzeitdaten.
- Read-only-Dockerprüfung angesetzt. Der Ausführungs-Guard blockierte `docker context show`/`docker version` vor der Ausführung; es wurden keine Ressourcen gestartet, verändert oder gelöscht.
- Full-Check ausgeführt: 1197 Tests, 1184 bestanden, 1 fehlgeschlagen, 12 übersprungen, Exit 1. Secret-Scan ohne Treffer.
- Abschlussbericht unter `reports/TF-JARVIS-030/ABSCHLUSSBERICHT.md` erstellt.

### Bekannte Fehler
- `test/crm-browser-053.test.js` Test N scheiterte im aktuellen Full-Check beim Klick auf `ANRUF SPEICHERN`, weil das Formular-Element während des Klicks aus dem DOM entfernt bzw. unsichtbar wurde. Der Befund ist nicht als behoben klassifiziert.

### Offen / Blockiert
- Alle zwölf Docker-/Repair-Labs sind BLOCKED/NOT RUN. Engine, Docker-Kontext sowie bestehende Container, Netzwerke und Volumes konnten wegen des Ausführungs-Guards und fehlender Docker-Desktop-/Dienstnachweise nicht verifiziert werden.
- TF-030 ist daher nicht releasebereit. Ein sicherer read-only Docker-Nachweis und die anschließende isolierte Lab-Suite sowie eine gezielte Klärung des CRM-Browserfehlers N sind erforderlich.

### In Arbeit
- Keine weiteren TF-030-Änderungen in diesem Worktree; kein Push, Merge oder Deployment.

Siehe Abschnitt am Ende dieser Datei (wird bei der Einrichtung und bei Änderungen der Regeln gepflegt).

## TF-JARVIS-031 (2026-10-27)

### Erledigt

- Isolierter Worktree `Jarvis-tf031` auf Basis von `34a073a` erstellt; der Codex-Worktree und der Hauptcheckout blieben getrennt.
- Docker Desktop nach lokaler Freigabe regulär gestartet; Prozessstatus und der Kontext `desktop-linux` festgestellt. Engine-Version sowie Container-/Netzwerk-/Volume-Inventar wurden vom Ausführungs-Guard vor der Ausführung blockiert.
- CRM-Test N systematisch untersucht: Hintergrund-Refresh ersetzte DOM-Knoten während Pointer-Klicks. `public/crm.js` schützt jetzt mit einem Interaktions-Epoch; ein offener Drawer bleibt stabil und der Erstmailstatus wird in-place aktualisiert.
- N2 reproduzierte den roten Race vor dem Fix; N2/N3, N und der vollständige `crm-browser-053`-Lauf bestehen nach dem Fix. TF-024 Phase 5 besteht mit Desktop, Mobile, Reload und genau einem synthetischen Queue-Auftrag.
- Abschließender Full-Check: 1199 Tests, 1187 bestanden, 0 fehlgeschlagen, 12 übersprungen, Exit 0 / `CHECK OK`. Secret-Scan: 400 Dateien, 0 Treffer.
- Abschlussbericht: `reports/TF-JARVIS-031/ABSCHLUSSBERICHT.md`.

### Bekannte Fehler

- Kein verbleibender nachgewiesener CRM-Browserfehler.

### Offen / Blockiert

- Die zwölf Docker-/Repair-Labs wurden nicht gestartet. Ohne wirksame read-only Docker-Berechtigung und nachweisbare Laufzeitisolation dürfen sie nicht als bestanden gelten.
- TF-031 bleibt deshalb BLOCKED; kein Container, Volume oder Netzwerk wurde durch TF-031 verändert.

### In Arbeit

- Keine weiteren TF-031-Änderungen; Commit nur im isolierten Branch, kein Push, Merge oder Deployment.

## TF-JARVIS-032 (2026-10-27)

### Erledigt

- CHF-480-Abschlussmails erhalten ausschliesslich nach erfolgreicher, verifizierter Reparatur eine im Speicher erzeugte PDF-Quittung. Sie basiert auf dem persistenten Ledger, verlangt exakt CHF 480 im passenden TEST-/LIVE-Modus, Kundenangabe und vollständige konfigurierte Geschäftsadresse und enthält keine MWST.
- Die PDF bleibt über den bestehenden Draft-, Outbox-, gebundenen Thread- und Gmail-MIME-Pfad erhalten. Fehlende Adresse, Teil-/Überzahlung, falsche Währung oder Modus blockieren die Kundenmail fail closed.
- Die Auftrags-/Zugangsbestätigungen enthalten nun vier klar unverbindliche, statusabhängige Phasen zur Bearbeitungsdauer. Die Abschlussmail nennt keine offene Lieferprognose.
- Der interne, strikt allowlist-gebundene Admin-E2E-Auftrag bleibt absichtlich zahlungs- und rechnungslos; er kann keine finanzielle Quittung vortäuschen und geht nur an das freigegebene Testpostfach.
- Finaler Full-Check mit lokalem Chromium: 1206 Tests, 1194 bestanden, 0 fehlgeschlagen, 12 übersprungen, Exit 0. Secret-Scan: 404 Dateien, 0 Treffer. Bericht: `reports/TF-JARVIS-032/ABSCHLUSSBERICHT.md`.

### Offen / Blockiert

- Die zwölf Docker-/Repair-Labs bleiben BLOCKED/NOT RUN. Docker Desktop lief lokal, aber der read-only CLI-Aufruf wurde vor Ausführung durch den Ausführungs-Guard (`Keine Container ohne Freigabe`) blockiert; `JARVIS_REPAIR_LAB=1` wurde deshalb nicht gesetzt. Keine Container, Volumes oder Netzwerke wurden verändert.
- TF-032 ist für ein Produktionsdeployment weiterhin BLOCKED: Es fehlen der Docker-Lab-Nachweis sowie separat freizugebende Live-Konfiguration, reale Zustellungs- und Zahlungsnachweise. Kein Produktionsversand, keine Live-Zahlung und kein Deployment wurden ausgeführt.

### In Arbeit

- Keine weiteren TF-032-Änderungen; lokaler Commit nur im isolierten Branch, kein Push, Merge oder Deployment.

## TF-JARVIS-033 (2026-10-27)

### Erledigt

- Gemeinsame Adapter-Brücke um `createBackup`, `planRepair`, `applyRepair` und `validateRepair` ergänzt, ohne den bestehenden Adaptervertrag zu brechen.
- Fail-closed Provider-Erkennung ergänzt: genau ein HIGH-Signal darf vorschlagen; widersprüchliche oder schwache Signale werden `CUSTOM`/`PROVIDER_VERIFICATION_REQUIRED`.
- TF-033-Test 2/2, Adapter-/Vault-/Payment-/Access-/Backup-/Rollback-Regressionsläufe 51/51 und 69/69 bestanden.
- Abschlussbericht: `reports/TF-JARVIS-033-ABSCHLUSSBERICHT.md`.

### Offen / Blockiert

- Die zwölf Docker-/Repair-Labs bleiben `BLOCKED/NOT RUN`: statische Isolation ist nachgewiesen, der read-only Docker-Aufruf wurde jedoch vor Ausführung durch den Guard (`Rejected: Keine Container ohne Freigabe.`) blockiert. Keine Docker-Ressource wurde verändert.
- Shopify, Webflow und Wix bleiben `VAULT_ONLY`; unbekannte Anbieter bleiben `BLOCKED`/manuell. Kein Adapter darf ohne eigenen synthetischen E2E-Nachweis `AUTO_REPAIR_VERIFIED` werden.
- Zahlungsabweichung offen: Universal-/Onboarding-CHF-480 verlangt Vollzahlung; der ältere Engine-Vertrag ohne `onboardingDir` akzeptiert weiterhin CHF 240 Anzahlung. Keine globale Umstellung in TF-033 ohne separaten Migrations-/Regressionentscheid.
- Vollständiger `node scripts/dev-check.mjs --full`: **1'213 Tests, 1'201 bestanden, 0 fehlgeschlagen, 12 Docker-Labs übersprungen; Exit 0 / CHECK OK**. Implementierung `5c0c226`, Statusdokumentation `f2f736b`; Produktionsbereitschaft bleibt wegen der Docker-Labs, der Legacy-Zahlungsabweichung und der fehlenden separaten Produktionsfreigabe `BLOCKED`.

### In Arbeit

- Keine weiteren TF-033-Änderungen im Worktree; kein Push, Merge oder Deployment.
