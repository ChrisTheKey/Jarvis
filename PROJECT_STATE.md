# PROJECT_STATE – ALWAYS-ONLINE-MAIL-021 + SWISS-REPAIR-022 + SWISS-STRICT-EMAIL-COMPLIANCE-024 + SWISS-COLD-LEAD-DRAFT-025

Fortsetzbarer Rollout-Stand. Nur nicht-sensitive Fakten – niemals Tokens, Keys oder Credentials hier eintragen.

Letzte Aktualisierung: 2026-10-08

## CLOUD-FIRST (Rollout ab 2026-10-07) – Zielbild: VPS = Gehirn/24-7-Runtime, Netlify = UI, GitHub = Code, Windows = optionaler Client
Entscheidungen Chris (2026-10-07): (1) VPS nur AUSGEHEND, kein offener Port – Netlify-Functions sind das authentifizierte Gateway;
(2) Storage = bestehende atomare JSON-Stores + Schema-Versionierung/Migrationen (kein SQLite-Umbau); (3) VPS-Reboot nur per
Konfig-Prüfung + Jarvis-Container-Neustart (echter Reboot durch Chris, da /opt/fiverr auf demselben Host); (4) Offsite-Backup
verschlüsselt (Public Key auf VPS, Private Key nur bei Chris) in Netlify Blobs + lokale Rotation auf dem VPS.
Cloud Core = im Mail-Worker-Prozess auf dem VPS integriert (eine Runtime, ein Schreiber je JSON-Datei), Code `cloud-core.js`.
| Phase | Inhalt | Status |
|---|---|---|
| A | Cloud Core: Schema v1 + Migrationen (fail closed bei neuerem Stand), Core-Status (Scheduler-Checkpoints, Discovery, Backup) im Heartbeat; Cloud übernimmt Business/Sales nur vom Core (Windows-Client nie mehr); `sync.lastCorePushAt`/`lastClientPushAt`; `scripts/secret-scan.mjs` | ERLEDIGT 2d9a9f0, VPS live (schema v1 migriert 18:54 UTC, Core-Status in der Cloud sichtbar) |
| B | Migration Windows → VPS mit `scripts/merge-state.mjs` (Dry-Run Standard; additiv, Einträge atomar, VPS gewinnt Konflikte, Suppression vereinigt, nur `offer` aus config, nie Secrets) | ERLEDIGT 18:58 UTC: +3 Leads, 9 Konflikte → VPS behalten, offer → CHF 150/480; Backup `/opt/jarvis-mail/backups/pre-merge-*.tgz` (600 root); 2. Dry-Run = 0 Änderungen; Authority unverändert |
| C | Netlify/HUD: System / Jarvis Core (CLOUD ONLINE) / Local Client / Mail Worker / Authority / Pending Queue / AI Service; Gesamtsystem ONLINE = Cloud Core + Mail-Worker, PC optional (Local Client OFFLINE ist gelb, kein Systemfehler); CLOUD-Modus begrüsst mit Cloud-Status | Code fertig, Tests grün |
| D | Windows = OPTIONAL_CLIENT (`/api/health` role=optional_client; PC rechnet im Standby keine Sales; Cloud nimmt Business/Sales nur vom Core) | ERLEDIGT ed521f8; live 19:07 UTC: Cloud-Sales = VPS-Sales (gleicher Zeitstempel), lastCorePushAt/lastClientPushAt getrennt |
| E | Backup `backup.js` (RSA-OAEP-256 + AES-256-GCM, Public Key `deploy/vps/backup-public.pem`, key_id f671042283a91eaf; täglich ab 03:00 Zürich; VPS `secrets/backups/` 14 Gen.; Netlify Blobs `jarvis-backups` via `/api/backup` 30 Gen.; nie Secrets) + `scripts/restore-state.mjs` (nur in leeres Verzeichnis) + `scripts/bootstrap-windows.ps1` + `docs/DISASTER_RECOVERY.md` (Secret-Recovery) | ERLEDIGT bc51524 (VPS live). 19:11 UTC erstes echtes Backup: lokal `secrets/backups/state-20261007T191157482Z.json` (600) + offsite `daily/2026-10-07` ok, 10 Dateien, key_id f671042283a91eaf. Restore-Test offsite→leeres Verzeichnis ok (64 Leads, Schema 1), zweiter Restore ins selbe Ziel verweigert. Bootstrap (Prüfmodus) auf diesem PC: 13 OK, Cloud verbunden, PC self=false. **Chris: `.secrets/backup_private.pem` in den Passwort-Manager kopieren.** |
| F | Disaster-Tests A–E (`scripts/dr-probe.mjs`, nur lesend, nur Cloud-Core-Credential) | ERLEDIGT 2026-10-07 – alle PASS, siehe unten |

### Disaster-Recovery-Test 2026-10-07 (keine echte Mail, Authority nie manuell geändert)
- A Windows komplett offline (19:22–19:33 UTC): Local Core + Windows-Mail-Worker DOWN. Cloud-UI 200, System ONLINE, Jarvis Core CLOUD ONLINE,
  VPS ACTIVE, Authority VPS, Heartbeat lief weiter, 64 Leads / 12 Gesprächsbeiträge / Queue 0 unverändert, Local Client + Windows OFFLINE. PASS.
  LEKTION: `Stop-ScheduledTask "Jarvis Mail Worker"` beendet den Worker NICHT (Supervisor + Kind laufen weiter, PIDs im Lock) –
  für einen echten Offline-Test die Prozesse aus `.secrets/mail_worker/worker.lock` (Worker) und dessen Supervisor beenden.
- B neuer PC ohne Jarvis: Cloud-UI + APIs ohne PC nutzbar (= A). PASS.
- C neuer PC + Bootstrap: `scripts/bootstrap-windows.ps1` (Prüfmodus) verbindet sich, PC self=false; Unit-Test: leerer Client überschreibt keinen Cloud-State. PASS.
- D Container-Neustart: mehrfach (Deploys, Merge) – kommt healthy zurück, State erhalten. PASS.
- E ECHTER VPS-REBOOT (von Chris angeordnet): `sync` + Reboot ausgelöst 19:30:30 UTC, gebootet 19:30:51, Jarvis-Container automatisch
  gestartet 19:31:04 (healthy, 0 Restarts), SSH zurück 19:31:54. docker + containerd enabled/active, restart=unless-stopped.
  Vorher/Nachher identisch: 64 Leads, Suppression 0, Registry 2/1, Schema 1, 12 Gesprächsbeiträge, Inbox/Queue 0, Authority vps/self=true,
  Backup + Gmail-Secret-Dateien + `.env` (600 root) vorhanden. 0 Send-Events. PASS.
- Danach Windows als OPTIONAL_CLIENT wieder gestartet (19:33 UTC): Local Core role=optional_client, Windows-Worker `standby_no_send_authority`.
  check-mail-auth: Windows 200 self=false, VPS 200 self=true → genau ein Sender.
Bestandsaufnahme 2026-10-07: Gmail-Registry Windows = VPS; Suppression/Opt-outs beide leer (kein Compliance-Konflikt);
VPS-`config.offer` war der ALTE Text (ohne CHF 150/480), Windows seit 14:32 UTC der neue; 6 entdeckte Leads nur auf Windows.

## SERVER CONTROL (2026-10-08) – Cloud-Jarvis steuert den VPS sicher, ohne Shell
Weg: Browser (`x-jarvis-key` = JARVIS_PASSWORD) → Netlify `/api/server-control` (`netlify/functions/server-control.mjs`,
Blobs `jarvis-server-control`) ← VPS-Agent im Cloud-Core-Prozess holt ab (nur ausgehend, `x-jarvis-control`). Code: `server-control.js`
(Allowlist `ACTIONS`, `DANGEROUS`, `validateAction`, Redaction, Snapshot-Whitelist, Handler mit Rate Limit + Audit) und `server-agent.js`
(VPS: `safePath`, `readLogs`, `collectSnapshot`, `createVpsActions`, `createControlAgent`, `startServerControl`); HUD `public/server-status.js` + Panel SERVER.
- Auth: eigenes Secret `JARVIS_SERVER_CONTROL_TOKEN` (64 Zeichen, Fingerprint 762125d5f799) – nur `.secrets/vps_worker.env`, VPS `/opt/jarvis-mail/.env`
  (600 root) und Netlify-Env. Worker-/Sync-Token, Anthropic-Key, Gmail-Token gelten dort NICHT. Timing-safe Vergleich, deny by default.
  Fehlt der Token in Netlify → 503 „nicht konfiguriert“ (fail closed), Agent fragt dann nur alle 5 min.
- READ (sofort aus dem VPS-Status, ≤3 min alt, sonst SERVER_OFFLINE): system.health/uptime/resources, docker/jarvis/mail/scheduler/queue/backup/deploy.status;
  service.logs (Auftrag; Quelle nur core|mail|scheduler|backup|deploy, ≤100 Zeilen, nur ts/level/event + Zahlen + bereinigte Felder).
- CONTROL (Auftrag → VPS, TTL 3 min, Lease 2 min, Cooldowns Cloud + VPS, max. 6 je 10 min): runHealthCheck, runSafeDiagnostics, runBackup (`backupNow`),
  restartScheduler / restartMailWorker (im Prozess), restartCore (sauberes Prozessende nach dem laufenden Durchlauf → Docker `unless-stopped`
  startet neu; erst NACH bestätigter Rückmeldung, sonst kein Neustart).
- DANGEROUS (immer 403): reboot, shutdown, upgrade/packages, firewall, ssh, state/backup delete, secrets.rotate, docker prune/exec, shell.exec.
- Pfade: nur `/data/secrets/mail_worker` (= `/opt/jarvis-mail/secrets/mail_worker`); gesperrt u. a. fiverr, .ssh, /root, /etc/shadow|passwd, .env, .pem,
  Gmail-/Sync-/Worker-Dateien. `/opt/fiverr` ist im Container gar nicht eingebunden. Kein exec/spawn/Docker-Socket.
- Audit: Cloud (300 Einträge: ts, request_id, action, tier, source, outcome, reason) + VPS `mail_worker/control_audit.jsonl`. Keine Secrets.
- Takt: Panel „Server Control“ offen → Agent alle 5 s, sonst 60 s. Deploy-Stand: `deploy.sh` setzt Build-Args JARVIS_COMMIT/JARVIS_DEPLOYED_AT.
- Tests: `test/server-control.test.js` (16).
- Live 2026-10-08 (Commit fb17e16): Netlify-Funktion live (ohne Auth 401); VPS deployt (fb17e16, healthy, 0 Restarts, `server_control_started`,
  Token im Container vorhanden, JARVIS_COMMIT/JARVIS_DEPLOYED_AT gesetzt). Worker-Token als Control-Credential → 401 (keine Wiederverwendung).
  ERLEDIGT 2026-10-08 (früher offen): **`JARVIS_SERVER_CONTROL_TOKEN` in Netlify setzen (Site settings → Environment variables, Scope Functions; Wert = Zeile in
  `.secrets/vps_worker.env`, Fingerprint 762125d5f799) und danach „Trigger deploy“.** Bis dahin antwortet die Cloud dem Agenten 401 (fail closed),
  der Agent fragt nur alle 5 min, das HUD zeigt SERVER „NICHT KONFIGURIERT“ bzw. keinen Status. Danach Live-Read-Test (health, uptime, docker, Jarvis-Status, backup).
- Token-Panne 2026-10-08 vormittags: Netlify hatte zunächst einen 106-Zeichen-Wert (falsche Zwischenablage); per Probe (e7ade22,
  `GET /api/server-control?probe=1`, nur configured/Länge) erkannt, Chris hat 64 Zeichen gesetzt. Letzte 401 des Agenten 11:37 UTC.
- **LIVE-TEST BESTANDEN 2026-10-08 12:00–12:08 UTC** (Browser-Credential im Playwright-Fenster von Chris eingegeben, danach gelöscht):
  READ 10/10 grün aus dem VPS-Status: Host-Uptime 16h, 2 CPUs ~3 %, RAM 27 % von 3.7 GB, Disk 23 % (28.6 GB frei), Docker ONLINE,
  Container HEALTHY, Core HEALTHY (schema 1, node v22), Mail VPS ACTIVE (Authority VPS, self=true), Scheduler ONLINE (09:30/14:30 je 50),
  Queue 0/0, Backup OK (2 Gen., offsite ok), Deploy fb17e16. HUD-Panel SERVER: alle Werte grün, keine Eingabefelder, kein Token im DOM.
  Security live: falscher Control-Token / Worker-Token / Anthropic-Key / x-jarvis-worker → 401; system.format, Injection, {command} → 400;
  shell.exec, system.reboot → 403 DANGEROUS_BLOCKED; service.logs mit /opt/fiverr, ../../root/.ssh, path/file-Parametern → 400 BAD_PARAMS;
  nichts in die Warteschlange; keine Secrets/ENV-Werte/Adressen in Antworten, Audit oder HUD.
  Audit: READ wird seit 5ea98c2 ebenfalls auditiert (live geprüft: ts, request_id, action, tier, outcome). Abgelehnte Versuche als „denied“ mit Grund.
  EINE Control-Aktion: jarvis.runHealthCheck (12:07:57 → done 12:08:20, 8/8 Checks ok; Audit queued → success, VPS control_audit.jsonl success).
  Keine Restart-/Backup-Aktion, kein Reboot, kein Docker-Exec. Danach: VPS healthy, 0 Restarts, VPS ACTIVE self=true, Windows STANDBY self=false,
  genau ein Sender, 0 Send-Events.
- **Re-Check nach PC-Neustart 2026-10-08 15:22–15:30 UTC** (Netlify Production laut Chris neu deployt):
  Probe `configured=true, length=64`. check-mail-auth: VPS 200 self=true, Windows 200 self=false, holder=vps, pending 0.
  dr-probe: HUD System ONLINE, Jarvis Core CLOUD ONLINE, Local Client ONLINE, Mail Worker VPS ACTIVE, Authority VPS, Windows STANDBY,
  Queue 0, AI ONLINE; Core-Heartbeat frisch, Core-Start 10:42 UTC (kein Container-Neustart), Schema 1, Scheduler 09:30/14:30 je 50 ausgeführt,
  Backup OK (2 Gen., offsite 2). Windows-Tasks „Jarvis Local Core“ + „Jarvis Mail Worker“ Running (Optional Client), kein Eingriff nötig.
  Security live (ohne Credential): zufälliger Control-Token / falsches Passwort / ohne Header → 401; Worker-Token als x-jarvis-control
  bzw. x-jarvis-key → 401; shell.exec und service.logs(/opt/fiverr) ohne gültige Auth → 401.
  NICHT erneut live: READ 10/10, Audit, Gates 400/403 und jarvis.runHealthCheck – brauchen JARVIS_PASSWORD (lokal nicht vorhanden,
  bewusst nicht erfragt); SSH zum VPS im Agent-Modus gesperrt. Agent-Auth daher nur indirekt (Token-Länge 64 unverändert, Test 12:00 UTC grün).
  → Chris: HUD-Panel SERVER einmal öffnen (READ-Werte grün) – oder Freigabe für den Lauf mit Passwort im Browserfenster.
  Tests: HEAD 279/279 grün (sauberer Worktree); Working Tree 278/280 – die 2 Fehler stammen aus fremden, nicht committeten
  Entwurfs-Änderungen (delivery "draft", Cloud-Prompt), unangetastet. Authority unverändert, keine Mail gesendet, kein Restart/Reboot.
- **Agent-Verifikation per SSH 2026-10-08 15:49 UTC** (Windows-`ssh-agent` war nach dem Neustart nur gestoppt; `Start-Service ssh-agent`
  genügte, der Key war noch geladen): Container running/healthy, 0 Restarts, Start 10:42 UTC; `server_control_started` 10:42:12 UTC;
  letzte `control_pull_refused` (401) 11:37:23 UTC, danach keine 401 und nie `control_pull_failed` → Agent holt seit dem Token-Fix
  erfolgreich ab. JARVIS_SERVER_CONTROL_TOKEN im Container vorhanden (Länge 64, Wert nicht ausgegeben). authority.json holder=vps self=true,
  0 Send-Events im Worker-Log, Ticks alle 2 min. VPS control_audit.jsonl: letzter Eintrag = runHealthCheck 12:08:20 success (Felder ts/
  request_id/action/source/outcome/reason, keine Secrets). check-mail-auth: VPS self=true, Windows self=false.
  READ 10/10 über die Cloud weiterhin NICHT erneut ausgeführt: Der Nutzerpfad von `/api/server-control` akzeptiert nur `x-jarvis-key`
  (= JARVIS_PASSWORD), der Agent-Token nur pull/result – ohne Passwort gibt es keinen anderen READ-Weg.
- **LIVE-TEST ABGESCHLOSSEN 2026-10-08 16:02–16:04 UTC** (Passwort von Chris im Playwright-Fenster eingegeben, nie ausgelesen, danach
  aus Seite und localStorage gelöscht; da der Local Core lief = LOCAL-Modus, wurde nur das Passwortfeld im DOM eingeblendet, kein Code geändert):
  READ 10/10 HTTP 200 done, Snapshot frisch (16:02:06): ONLINE, Host-Uptime 20h31m, 2 CPUs 0.5 %, RAM 28 % von 3.7 GB, Disk 23 % (28.6 GB frei),
  Docker ONLINE / Container HEALTHY, Core HEALTHY (vps, schema 1, node v22.23.3), Mail VPS ACTIVE (Authority VPS, self=true),
  Scheduler ONLINE (09:30/14:30 je 50 ausgeführt, Discovery 15:32), Queue 0/0, Backup OK (2 Gen., offsite ok), Deploy fb17e16 / 10:42:09 UTC.
  HUD-Panel SERVER: alle 11 Werte gefüllt/grün, 0 Eingabefelder.
  Security hinter gültigem Login: system.format / foo.bar / Injection → 400 UNKNOWN_ACTION; shell.exec, docker.exec, system.reboot,
  secrets.rotate → 403 DANGEROUS_BLOCKED; {command}-Parameter, service.logs mit /opt/fiverr, ../../root/.ssh, /etc/shadow,
  Private-Key-Pfad, .env, gmail_token → 400 BAD_PARAMS; nichts eingereiht. Antworten, Audit und HUD-DOM: kein Passwort, kein 64-Hex-Token,
  keine Key-/OAuth-/PEM-Muster, keine ENV-Namen, keine Mailadressen.
  Audit (Cloud, 30 Einträge): ts, request_id, action, tier, source, outcome, reason vollständig; READ success, Ablehnungen denied + Grund.
  EINE Control-Aktion: jarvis.runHealthCheck 16:02:50 queued → 16:03:08 success (8/8 Checks ok), VPS control_audit.jsonl success.
  Danach: Container healthy, 0 Restarts (Start 10:42 UTC), authority holder=vps self=true, Windows self=false/STANDBY, genau ein Sender,
  Queue 0, Scheduler ONLINE, 0 Send-Events, kein 401 seit 11:37 UTC. Einmalig 16:03:23 `control_pull_failed` „fetch failed“ (Netzwerk,
  kein Auth-Fehler; nächste Abholung ~16:08 UTC ohne Fehler, bis 16:09 keine weitere). Server-Control-Tests 16/16. Kein Restart, kein Reboot, keine Mail.

## TF-024 SWISS STRICT EMAIL COMPLIANCE (dauerhaft; Code: `email-permission.js`, `legalBasis()` in `mail-worker.js`)
Tests: `test/swiss-compliance-024.test.js` (16). Gegencheck: Entfernen von HIGH-Pflicht, Public-Source-Sperre, Engine-Delegation in
`legalBasis` bzw. Cold-Send-Sperre macht Tests rot. (TF-023 existiert nicht.)
- Zentrale Engine `evaluateSwissEmailPermission(lead, message)` → { allowed, message_class, legal_basis, confidence, evidence[], rationale }.
  `legalBasis()` delegiert ausschliesslich dorthin (plus `approved`, das nie eine Grundlage ersetzt). Kein Override/Bypass/Force/Batch.
- MARKETING Auto-Send NUR: EXPLICIT_OPT_IN (Empfänger, Quelle, Datum, Umfang Website-Leistung, Beleg, obtainedBeforeMarketingSend=true,
  withdrawalStatus=active, consentConfidence=HIGH) oder EXISTING_CUSTOMER_SIMILAR_SERVICE (Beleg der Kundenbeziehung, relationshipDate,
  previousService + advertisedService beide Website-Leistung, similarityRationale, emailSource aus der Kundenbeziehung, sameProvider=true,
  optOutStatus=none, existingCustomer+similarService, customerConfidence=HIGH).
- REQUESTED_CONTACT = SOLICITED_RESPONSE (nie Marketing): requestSource/Date/Scope/Evidence, responseScope, recipientOrSubmissionChannel, HIGH;
  nur innerhalb des angefragten Umfangs (Website-Reparatur), kein Follow-up-Funnel.
- ACTIVE_RFP = nur konkrete SOLICITED_RESPONSE: rfpUrl, rfpDate, rfpScope (Website-Leistung), submissionChannel, Deadline in der Zukunft,
  exactEvidence, serviceMatch=true, stillActive=true, HIGH. Allgemeine Einladungen („Offerten willkommen“, Partner-/Lieferantenseiten) zählen nie.
- MEDIUM/LOW = BLOCK, fehlende Evidence = BLOCK. Öffentliche Adresse (info@, Impressum, Kontaktseite, Verzeichnis, Maps, LinkedIn, Whois,
  Register, .ch), Reparaturbefund, vermutetes Interesse und Chris-Freigabe sind NIE eine Grundlage. Human Approval kann das Legal Gate nicht überschreiben.
- WICHTIG für leads.json: bestehende Einträge mit altem Minimal-Beleg (opt_in nur consentAt+consentSource, Bestandskunde nur zwei Flags)
  werden jetzt BLOCKIERT, bis die TF-024-Felder nachgetragen sind. Feldnamen camelCase (z. B. consentRecipient, consentScope …) oder snake_case.
- 0 Auto-Send-Berechtigte = 0 Auto-Send. 09:30 max 50 / 14:30 max 50 / 100 pro Tag sind nur das technische Maximum.
- Angebote aktuell: REPAIR_CHECK_150 = CHF 150, REPAIR_FIX_500 (interne ID bleibt) = CHF 480. Kein drittes Angebot, kein Redesign, kein Neubau.
- TF-021 VPS/Netlify 401 (Token-Mismatch) bleibt separater offener Blocker; VPS-Authority unverändert.
- Betrieb 2026-10-07 15:08 UTC: Local Core und Windows-Mail-Worker mit Commit a3c05d3 neu gestartet. Der alte Windows-Worker (Start 06.10.,
  Code vor TF-021, ohne Authority-Prüfung) wurde dabei ersetzt. Neuer Windows-Worker: `standby_no_send_authority` (holder=vps, weil Netlify
  dedicated=true meldet). Da der VPS wegen 401 ebenfalls Standby ist, verarbeitet derzeit KEIN Worker Gmail (keine Antwort-Entwürfe,
  keine Cloud-Aufträge, keine Cold-Entwürfe, kein Versand) – nichts geht verloren, alles bleibt pending. Wird aktiv, sobald der
  Netlify-Token-Fix (TF-021 Schritt 5) erledigt ist und der VPS mit aktuellem Commit deployt wurde.

## TF-025 SWISS COLD LEAD DRAFT OUTREACH (dauerhaft; Code: `swiss-repair.js`, `gmail.js`, `mail-worker.js`, `lead-finder.js`)
Tests: `test/swiss-repair-025.test.js` (20). Gegencheck: Entfernen von Cold-Send-Sperre, Suppression-Sperre bzw. Fremd-Entwurf-Schutz macht Tests rot.
Integriert mit TF-024: Cold Leads = message_class DRAFT_ONLY, legal_basis NONE; die Engine erlaubt für COLD_DRAFT nie einen Versand.
- Jarvis darf Schweizer Repair-Leads finden (TF-022-Kriterien) und öffentliche GESCHÄFTLICHE Kontakte recherchieren: nur Firmenwebsite
  (Team-, Impressum-, Kontakt-, Startseite) und OSM. Nur Adressen auf der Firmendomain; Freemail/fremde Domains werden verworfen.
  Persönliche Adresse nur mit sicher zugeordnetem Namen. Vorrang: Web/Marketing/IT > Geschäftsführung > andere Person > info@.
  Gespeichert: contact_name, contact_role, business_email, contact_source, source_url, collected_at, contact_confidence. Keine Firmenverzeichnisse (noch nicht angebunden).
- COLD_LEAD_DRAFT_ONLY: CH + modern_maintainable/repairable + Repair-Befund + geschäftliche Adresse + keine Auto-Send-Grundlage + nicht gesperrt.
  → draft_creation_eligible=true, automatic_marketing_send_eligible=false, message_class=DRAFT_ONLY, legal_basis=NONE,
  legal_status=NO_AUTOMATIC_SEND_BASIS, manual_send_decision_required=true (fest, keine Aktion kann das ändern).
- Ablauf: Discovery legt höchstens EINEN lokalen Cold-Entwurf je Firma an (`.secrets/mail_worker/individual_reviews.json`), der Mail-Worker
  (Windows) erstellt daraus einen normalen Gmail-Entwurf (Label JARVIS, im Register mit mode=COLD_LEAD_DRAFT_ONLY, leadId, draftHash). Dann STOPP.
- Cold-Entwürfe werden NIE von Jarvis gesendet: `gmail.sendDraft` lehnt mode=COLD_LEAD_DRAFT_ONLY ohne Gmail-Aufruf ab (gilt für Worker,
  VPS, Kampagnenfenster, Cloud-Queue, CLI); zusätzlich Sperre im Versandpfad des Workers. Sie kommen nie in die Send-Queue und zählen nicht als Send.
- Chris entscheidet manuell in Gmail. `gmail.syncColdDrafts` erkennt den manuellen Versand nur bei eindeutigem eigenem Thread
  (Thread-ID, erste Nachricht SENT an denselben Empfänger mit demselben Betreff, nicht älter als der Entwurf) und registriert ihn als
  Jarvis-Thread mit manual=true, legalBasis=NONE (kein Limitverbrauch). Manueller Versand erzeugt NIE eine Rechtsgrundlage.
- Antworten in solchen Threads: bestehende sichere Reply-Regeln (Antwort-ENTWURF, kein Auto-Send ohne Grundlage). Kein automatischer Follow-up.
- Opt-out/Suppression gelten vollständig (auch domainweit für neue Cold-Entwürfe). Opt-out-Erkennung ergänzt: „entfernen Sie mich“,
  „aus Ihrem Verteiler“, „nicht relevant“.
- Duplikate: kein zweiter Cold-Entwurf für dieselbe Firma/Domain/Adresse, solange einer offen ist, nach manuellem Versand nie,
  nach Verwerfen erst nach 180 Tagen.
- Dashboard (LEADS): Zähler Cold Leads, geschäftliche Kontakte, Drafts erstellt/offen/manuell versendet, Auto-Send Leads, Blocked, Opt-outs;
  Hinweis „ENTWURF ERSTELLT — NICHT AUTOMATISCH VERSANDBERECHTIGT“; Aktionen OPEN / EDIT / DISCARD DRAFT, MARK AS MANUALLY SENT
  (Endpunkte `/api/cold-drafts/{edit,discard,mark-manual-sent}`, je genau ein Entwurf). Es gibt kein Senden/Erzwingen/Override.
- Der TF-022-Pfad „Einzelfreigabe → Jarvis sendet“ ist durch TF-025 ersetzt (Jarvis sendet Cold-Mails gar nicht mehr).
- Angebote: weiterhin genau zwei (`OFFERS` in `sales.js`). Stand 2026-10-07 von Chris parallel geändert auf CHF 150 / CHF 480 + Landingpage-Link.

## TF-022 Swiss Repair Outreach Policy (dauerhaft, Code: `swiss-repair.js`)
Status: implementiert, 210/210 Tests grün (28 neue in `test/swiss-repair-022.test.js`). Ändert nichts an VPS/Netlify/Authority (Rollout 021 unten unverändert offen).
Wirkt auf Windows erst nach Neustart von Jarvis Local Core + Mail-Worker; VPS braucht dafür kein Redeploy (keine Einzelprüfungen dort).
- Zielgruppe: NUR Schweizer Firmen (`country=CH`, `swiss_evidence[]`, `swiss_confidence`; Signale: .ch, UID CHE-, CH-Adresse, +41/0xx-Telefon, OSM-Gebiet).
  Widersprüchliche Auslandssignale ohne starkes CH-Signal → `unclear` → nicht qualifiziert.
- Website muss weiterverwendbar sein: `site_condition` ∈ modern_maintainable | repairable | unclear | redesign_likely. Nur die ersten zwei qualifizieren.
  Kein Website-Alter wird behauptet (nur beobachtete Signale).
- Konkreter, passiv belegter Reparaturbefund zwingend (`issue_type, url, evidence, observed_at, reproducible, severity`). Kosmetik zählt nicht.
  Neu im Auditor: `broken_mailto` (ungültige mailto-Adresse, nur HTML gelesen).
- Angebote nur REPAIR_CHECK_150 (CHF 150) / REPAIR_FIX_500 (CHF 500) / NONE. Kein Redesign, kein Neubau, kein Upsell.
- Versandgrundlagen: OPT_IN, EXISTING_CUSTOMER_SIMILAR_SERVICE, REQUESTED_CONTACT (`consentBasis: "requested_contact"` + request_source/request_date/
  request_scope; nur wenn Umfang Website/Reparatur abdeckt) → dürfen in die Fenster 09:30/14:30 (je 50, Tag 100, unverändert).
  INDIVIDUAL_ONE_TO_ONE_REVIEW (neue CH-Firma, nur öffentliche Adresse) → NIE Kampagne/Batch/Follow-up. Discovery legt genau einen Entwurf in
  `.secrets/mail_worker/individual_reviews.json` an; Chris prüft im Dashboard (LEADS) und gibt einzeln frei (Approve this individual email / Edit / Reject).
  Freigabe gebunden an lead_id + Empfänger + draft_hash + Befund-Hash; jede Änderung → Freigabe verfällt. Kein Approve-all (Code + Tests).
- Versand freigegebener Einzelmails: Worker-Klasse `individual_approved_mail` (nicht im Kampagnenfenster, zählt aufs Tageslimit 100), Freigabe wird
  direkt vor dem Send erneut geprüft, Send-Lock/Suppression/Opt-out wie gehabt. Thread-Basis `individual_one_to_one` → keine Follow-ups;
  Antworten laufen über die bestehenden Reply-Regeln. Angefragter Kontakt bekommt ebenfalls keine automatischen Follow-ups (nur opt_in/Bestandskunde).
- Lifecycle (`repair.stage`): discovered → audited → swiss_verified → modern_repair_fit → repair_candidate | individual_review_required |
  blocked_no_contact_basis → approved_one_to_one → contacted → replied → customer | not_interested | do_not_contact. Bisheriges `status` bleibt kompatibel.
- Ranking: `repair_fit_score` = swiss_confidence + site_maintainability + repair_issue_confidence + repair_issue_value + contact_quality.
- Datenminimierung: nur Geschäftsdaten; Kontaktherkunft `contact_source`, `source_url`, `collected_at`. Leads/Entwürfe bleiben lokal in `.secrets/`
  (gitignored); in den Cloud-Zustand gehen nur Zähler.

## Code
- Branch: `claude/jarvis-voice-dashboard-9phl5w`
- Implementierungs-Commit: `97d4b97` (179/179 Tests grün, gepusht)
- Netlify-Version mit Cloud-Mail-Queue: deployed
- AI-Credit-Fail-Closed (AI_BUDGET_EXHAUSTED): implementiert, 182/182 Tests grün – noch NICHT auf VPS/Netlify deployed

## Rollout-Schritte
| # | Schritt | Status |
|---|---------|--------|
| 1 | Zustand prüfen (Git, `.secrets/vps_worker.env` mit beiden Werten, SSH `fiverr`) | ERLEDIGT |
| 2 | VPS-Deploy nach `/opt/jarvis-mail` inkl. einmaliger Secret-Migration | ERLEDIGT (vom Benutzer ausgeführt, deployed Commit c4b9b2c) |
| 3 | Docker Compose: Container RUNNING, unless-stopped, HEALTHY | ERLEDIGT |
| 4 | VPS-Worker verifizieren (2-min-Polling, Heartbeat, kein Crash-Loop) | ERLEDIGT – Standby (Cloud antwortet 401, erwartet) |
| 5 | Netlify `JARVIS_MAIL_WORKER_TOKEN` setzen + Production-Redeploy | ERLEDIGT 2026-10-07 (Token rotiert, Production auf 36f4932) |
| 6 | Send Authority VPS, Windows Standby | ERLEDIGT 2026-10-07 17:04 UTC |
| 7 | Windows-Task „Jarvis Mail Worker“ neu starten, Standby prüfen | ERLEDIGT (Neustart 15:44 UTC, standby_no_send_authority) |
| 8–12 | Cloud/HUD, Offline-Szenario, Reply-Pipeline, Schedule, Security | ERLEDIGT 2026-10-07 17:15 UTC (live lesend + 234/234 synthetisch); HUD-Anzeige visuell durch Chris offen |
| F4–F7 | Anthropic-Credit fail closed + HUD „AI SERVICE“ + Tests | ERLEDIGT (VPS 5cb78a3, Netlify 36f4932) |

## Live-Zustand (2026-10-07 17:11 UTC – Rollout 1–7 ERFOLGREICH)
- VPS `ubuntu-4gb-fsn1-1` (SSH-Host `fiverr`, Windows-OpenSSH; Key passphrase-geschützt → nach Windows-Neustart `Start-Service ssh-agent; ssh-add`)
- `/opt/fiverr`: bestehendes Projekt – NICHT anfassen
- `/opt/jarvis-mail`: DEPLOYED_COMMIT 5cb78a3, Container `jarvis-mail-mail-worker-1` healthy, restart=unless-stopped, 0 Restarts.
  Rechte: `.env` 600 root, `secrets/` 700, Secret-Dateien 600. Worker-Log: `secrets/mail_worker/worker.log` (nicht `docker logs`).
- Netlify Production: Commit 36f4932, `JARVIS_MAIL_WORKER_TOKEN` rotiert (Länge 106, sha256_12 `11ea911ab60c`; lokal = VPS = Netlify).
- check-mail-auth: VPS 200 / Windows 200, authority.dedicated=true, VPS self=true, Windows self=false.
- **Aktiver Gmail-Sender: genau einer = VPS-Worker (ACTIVE).** Windows-Worker: STANDBY (`standby_no_send_authority`, holder=vps).
- Bis hierhin keine echte Mail gesendet (sentToday=0, eligibleLeads=0).
- Token-Werte stehen nie hier; nur Länge/Fingerprint.

## Sicherheitslogik (wichtig beim Fortsetzen)
- VPS-Worker startet im Standby, solange Netlify seinen Token mit 401 ablehnt → kein Doppel-Sender vor Schritt 5.
- `deploy/vps/deploy.sh fiverr --with-secrets` überschreibt bestehende VPS-Secrets nie (VPS ist dann führend).
  Bei erneutem Deploy ohne Secret-Änderung: `deploy/vps/deploy.sh fiverr` (ohne Flag).

## HUD Mail-Status (2026-10-07, Commit cc7be49, Netlify Production live)
- Fehler vorher: HUD „Worker OFFLINE“ (las nur `business.worker.lastCycle` des Windows-Workers, der im Standby nicht tickt),
  „Mail Service/Mail Worker –“ (Mail-Status wurde nur im CLOUD-Modus mit Passwort geladen), „Alle Systeme sind online“ ungeprüft.
- Jetzt: Worker / Mail Service / Mail Worker / Send Authority / Windows Worker / Pending Queue aus der Cloud (send_authority + Heartbeat
  des Zuständigen), unabhängig vom UI-Modus. LOCAL: Local Core `/api/mail-service` (nur GET mit Sync-Token, 15-s-Cache, keine IDs/Tokens);
  CLOUD: wie bisher `/api/mail-requests` mit Passwort. Logik in `public/mail-status.js` (Tests: `test/hud-mail-status.test.js`, 6).
- „Alle Systeme sind online“ nur bei Kern ok UND aktivem Mail-Worker; sonst „Achtung: Kein aktiver Mail-Worker (…)“.
- Live 17:29 UTC: Worker ONLINE, Mail Service VPS, Mail Worker VPS ACTIVE, Authority VPS, Windows Worker STANDBY, Pending 0,
  VPS-Heartbeat in der Cloud frisch (online=true). 240/240 Tests grün. Authority unverändert, keine Mail gesendet.
- Betriebshinweis: Local-Core-Task nach Stop/Start ggf. ein zweites Mal starten (alter Supervisor hält kurz das Lock).

## Verifikation Rollout 8–12 (2026-10-07 17:15 UTC, nur lesend/synthetisch, keine echte Mail)
- Cloud: `/api/state` 200, Sync aktiv (lastLocalPushAt 17:12 UTC); keine sensiblen Schlüssel, keiner von 7 bekannten Secret-Werten im
  Cloud-Zustand. `/api/mail-requests`: VPS 200 self=true, Windows 200 self=false, pending 0.
- VPS: healthy, 0 Restarts, TZ=Europe/Zurich, role=vps, Poll 2 min, authority holder=vps self=true; sentToday=0, free=100, eligibleLeads=0,
  0 Send-Events. Windows: Lock aktuell, `standby_no_send_authority`, 0 Send-Events seit 15:08 UTC. Local Core /api/health ok.
- Git: keine Secret-Dateien getrackt, `.secrets` ignoriert, keiner von 5 echten Secret-Werten in HEAD (Treffer nur Fake-Testwerte/Redaction-Regex).
- Synthetisch (234/234): Offline-Szenarien (Local Core/VPS/Windows aus, Absturz nach Lease, Neustarts), Lease, Send-Lock, Dual-Worker-Lock,
  Reply-Pipeline (eigener Thread, sichere Antwort, Risiko-Eskalation, Opt-out dauerhaft, fremder Thread unberührt), Fenster 09:30/14:30
  Europe/Zurich je 50, 100/Tag, 0 eligible = 0 Send, TF-024-Gate direkt vor Send, TF-025 Cold-Draft nie sendbar (gmail.js, Worker, Queue).
- Erledigt mit HUD-Fix cc7be49: HUD zeigt VPS/Authority auch im LOCAL-Modus; VPS-Heartbeat in der Cloud bestätigt.

## Nächster Schritt
Betrieb: VPS bleibt ACTIVE, Windows bleibt STANDBY; Authority nicht verändern, solange kein Fehler vorliegt. HUD nach Neuladen prüfen.
Bei VPS-Redeploy: `bash deploy/vps/deploy.sh fiverr` (ohne Flag). Bei Token-Rotation: Netlify + `.secrets/vps_worker.env` + VPS `.env`
gleichzeitig, danach `docker compose up -d --no-build --force-recreate mail-worker` (restart liest `.env` nicht neu) + Netlify-Redeploy.

## AI-Credit-Fail-Closed (Kurzbeschreibung)
- Anthropic-Billing-Fehler (402, oder 400/403 mit Credit/Billing/Usage-Limit-Meldung) → `AiBudgetError` (AI_BUDGET_EXHAUSTED), genau ein Versuch.
- Sperre persistiert in `mail_worker/ai_budget.json`; offene KI-Aufträge dort als AI_BUDGET_EXHAUSTED vermerkt, nichts gesendet, kein Entwurf.
- Höchstens ein Prüfversuch je `aiRecheckMinutes` (Default 60, min. 15); bei Erfolg automatische Wiederaufnahme.
- Meldung an Chris (Typ `ai_budget_exhausted`), Heartbeat-Feld `ai_paused` → HUD „AI SERVICE: PAUSED — CREDIT LIMIT“.
- Kein Retry-Loop, kein zweiter Key, kein anderer Anbieter, kein Auto-Reload. Cloud-Aufträge (ohne KI), Heartbeat, Sync, Opt-out laufen weiter.

## Diagnose-Stand 2026-10-07 nach Windows-Neustart (16:00 UTC)
- Git: HEAD c445472 lokal, Push war wegen GitHub-500 gescheitert; `scripts/check-mail-auth.mjs` (nur lesend, gibt keine Tokens aus) mit diesem Stand committet.
- Scheduled Tasks „Jarvis Local Core“ + „Jarvis Mail Worker“: Running (Start 15:44 UTC). Local Core `/api/health` ok.
- Windows-Worker: läuft, Heartbeat frisch, `standby_no_send_authority` (holder=vps). Crash 15:40 UTC = Herunterfahren beim Neustart.
- `node scripts/check-mail-auth.mjs`: Windows-Sync-Credential → HTTP 200, authority { dedicated: true, holder: vps, self: false };
  VPS-Worker-Credential → HTTP 401. Lokaler VPS-Token: Länge 43, kein Whitespace, keine Anführungszeichen.
- Lokaler Token = Token auf dem VPS (früher verglichen) → Ursache liegt bei Netlify Production (Env-Wert/Scope/Kontext), nicht Windows↔VPS.
- VPS nach Neustart nicht direkt prüfbar: Windows-`ssh-agent` gestoppt, Key nicht geladen. Aus 401 folgt: VPS kann keine Authority haben → Standby.
- Ergebnis: KEIN aktiver Gmail-Sender, kein Dual-Sender. Nichts gesendet. Authority bewusst nicht verändert.
- Nächster Schritt (Chris, Netlify-UI): `JARVIS_MAIL_WORKER_TOKEN` prüfen – Scope „Functions“ aktiv, Wert für Kontext „Production“
  (keine abweichenden Deploy-Context-/Branch-Werte), dann Production-Redeploy mit „Clear cache“; danach `node scripts/check-mail-auth.mjs`
  → erwartet vps_worker 200. Erst dann `bash deploy/vps/deploy.sh fiverr` und Schritt 6.

## Diagnose 2026-10-07 16:27 UTC (Fortsetzung)
- Git sauber, HEAD 4f0d2b6 = origin. Local Core ok (pid 11816). Windows-Worker lebt (Lock/Metrics aktuell), `standby_no_send_authority`.
- check-mail-auth: Windows 200 / dedicated=true / holder=vps / self=false; VPS 401. Lokaler Token: Länge 43, sha256_12 `523a5de6514a`.
- Code-Vergleich (`mail-requests.js` safeEqual, exakt, kein Trim) ist korrekt → 401 = Netlify-Production-Wert ≠ lokaler Wert.
- SSH `fiverr` scheitert: Key `fiverr_hetzner_working_ed25519` ist passphrase-geschützt, ssh-agent nicht geladen → VPS nicht prüfbar.
- **RISIKO / REIHENFOLGE GEÄNDERT:** VPS läuft noch c4b9b2c (vor TF-024/025, ohne Cold-Send-Sperre, alte legalBasis) und hat per
  Secret-Migration leads.json. Sobald der Netlify-Token passt, wird der VPS SOFORT aktiver Sender. Darum ZUERST VPS auf aktuellen
  Commit deployen (bleibt wegen 401 im Standby), DANN Netlify-Token korrigieren.
- Neue Reihenfolge: (a) ssh-agent + Key laden → (b) `bash deploy/vps/deploy.sh fiverr` (ohne Flag) → VPS-Commit prüfen
  → (c) Netlify-Wert per Fingerprint der Zwischenablage gegen `523a5de6514a`/43 prüfen, korrigieren, Production-Redeploy
  → (d) check-mail-auth: VPS 200 self=true, Windows self=false → genau ein Sender.
- 16:37 UTC (a)+(b) ERLEDIGT: Erster Deploy 4f0d2b6 → Crash-Loop `ERR_MODULE_NOT_FOUND /app/swiss-repair.js` (Dockerfile-COPY ohne
  swiss-repair.js/email-permission.js seit TF-022/024; nichts gesendet). Fix 5cb78a3 (+ Test: transitive Imports ⊆ COPY), 234/234 grün,
  neu deployt: DEPLOYED_COMMIT 5cb78a3, Container healthy, restart=unless-stopped, 0 Restarts, worker_started role=vps,
  sync 401 → `standby_no_send_authority`, authority.json holder=local self=false. Commit 5cb78a3 lokal, noch nicht gepusht.
- Nächster Schritt: (c) Netlify-Token per Fingerprint prüfen/korrigieren + Production-Redeploy.

## Offene Blocker (HISTORISCH – 401 am 2026-10-07 17:04 UTC GELÖST)
- Ursache: Netlify-Production-Wert war kein Token (163 Zeichen Text mit Leerzeichen/Anführungszeichen). Behoben durch Rotation.
- Netlify „Repository preparation failure“: Remote-Branch existierte; nach Push 36f4932 lief Production-Deploy durch.
- Stand 11:21 UTC: Netlify HAT `JARVIS_MAIL_WORKER_TOKEN` (Cloud meldet authority.dedicated=true), aber mit ANDEREM Wert als
  `.secrets/vps_worker.env` → VPS bekommt 401, bleibt Standby. Wahrscheinlich wurde ein alter Zwischenablage-Inhalt eingefügt
  (der PowerShell-Kopierbefehl war fehlgeschlagen).
- Folge bis zur Korrektur: Cloud-Mailaufträge (Handy) werden von niemandem übernommen (bleiben pending, gehen nicht verloren).
  Der laufende Windows-Worker-Prozess tickt weiter (alter Code ohne authority.json) – weiterhin genau ein Gmail-Sender.
- 11:43 UTC: nach erneutem Einfügen per clip.exe + neuem Deploy (neues ETag) weiterhin 401, dedicated=true → Wert in Production
  stimmt immer noch nicht mit der lokalen Datei überein (z. B. kontextspezifischer Override, Team-Variable, Anführungszeichen).
- Live-Netlify-Build enthält 138c460 noch nicht (HUD ohne „AI SERVICE“). VPS noch auf c4b9b2c (ohne AI-Fail-Closed).
- Fix: Token mit `grep '^JARVIS_MAIL_WORKER_TOKEN=' .secrets/vps_worker.env | cut -d= -f2- | tr -d '
' | clip.exe` kopieren,
  in Netlify ersetzen, Production neu deployen; dann `bash deploy/vps/deploy.sh fiverr` (ohne Flag), dann Schritt 6.
- 2026-10-07 16:00 UTC: 401 weiterhin vorhanden (siehe Diagnose-Stand). Zusätzlich: GitHub lieferte beim Push HTTP 500.
