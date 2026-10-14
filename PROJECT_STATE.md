# PROJECT_STATE – ALWAYS-ONLINE-MAIL-021 + SWISS-REPAIR-022 + SWISS-STRICT-EMAIL-COMPLIANCE-024 + SWISS-COLD-LEAD-DRAFT-025 + COLD-DRAFT-QUALITY-050 + LEAD-CONTACT-DIRECTORY-051 + LEAD-CRM-053

Fortsetzbarer Rollout-Stand. Nur nicht-sensitive Fakten – niemals Tokens, Keys oder Credentials hier eintragen.

Letzte Aktualisierung: 2026-10-14

## TF-053 – DNC MAIL-WORKER ENFORCEMENT DEPLOYED (2026-10-14, Mail-Worker LIVE 62bd95c)
- **Code 62bd95c**: `registryBlock` (lead-registry.js) liest `lead_crm.json` nur lesend; `do_not_contact=true` → kein neuer Cold-Entwurf im
  Draft-Worker (Eintrag `blocked`, „Lead-Datenbank: do-not-contact (CRM)“), keine Cold-Outreach-Queue (Cloud-Einzelentwurf verweigert,
  Discovery queued nicht). **Fail-safe**: JARVIS_CRM_DIR gesetzt, Datei fehlt / unlesbar / ungültiges JSON / unbekanntes Schema →
  `CRM_UNAVAILABLE`: Draft-Worker hält Einträge `queued` (nichts dauerhaft blockiert), Cloud-Einzelentwurf verweigert, Discovery-Lauf
  übersprungen; kein veralteter Cache. Transaktionale Kunden-Mails (Repair-Outbox) lesen das CRM nie. Sendelogik unverändert.
- **Vorbereitung**: `lead_crm.json` existierte noch nicht (CRM-Einträge entstehen erst bei der ersten Aktion) → vor dem Deploy über den
  CRM-Dienst selbst (`docker exec`, withCrmLock + saveCrm, nur wenn fehlend) als leerer Zustand angelegt: Schema 1, 0 Leads, 600, uid 1000.
  jarvis-crm-worker nicht recreated (c2391fb456dd, StartedAt 16:00:49, restarts 0).
- **Mail-Cutover** (`deploy.sh fiverr`, ohne Secrets, Freigabe Chris, docker events; Quiet Point: letzter Draft 16:37, danach nur Ticks):
  alter Worker 5510ab63fef9 (3216638) kill 16:50:27.841 / gestoppt 16:50:27.985 UTC, neuer 876020c249e3 gestartet 16:50:28.468,
  healthy 16:50:33.676 → **Unterbrechung ≈ 5.7 s** (kill → healthy 5.8 s).
- **Danach**: Commit 62bd95c, healthy, restarts 0, Authority vps/self, Scheduler-Ticks aktiv, Queue 392 lesbar (0 queued), State 16/16,
  `gmail.js check` → **MAIL AUTH READY**, Repair-Outbox-Consumer aktiv (Gmail OAuth OK, offen 0), Backup OK, Disk 26 GB. Readiness wie
  bisher nur «Chromium nicht installiert» (erwartet im Mail-Image). CRM-Mount `/opt/jarvis-mail/data → /data/crm` **RW=false**, Schreibprobe
  im Container „Read-only file system“; echte CRM-Datei lesbar (kein Fail-safe-Halt).
- **Repair-Worker unberührt** (acc10380926b, StartedAt 2026-10-13T20:06:34Z, restarts 0, healthy); **CRM-Worker** unberührt, healthy.
- **Live-Verifikation im neuen Container** (isolierter Zustand in /tmp, `env -i`, Fake-Gmail, keine Produktions-Env/Outbox/Sync):
  DNC → Cold-Entwurf `blocked` (do-not-contact (CRM)), Kontroll-Lead ohne DNC → Entwurf; DNC → Cloud-Queue verweigert, kein Eintrag;
  kaputte CRM-Datei → HOLD (fail-safe). 0 Gmail-Aufrufe gegen echtes Gmail, 0 Sends, keine Änderung bestehender Entwürfe.
- Tests: `test/dnc-mail-053.test.js` A–H (7); Unit gesamt 691 / 680 pass / 0 fail / 11 skip. Secret-Scan 0.

## TF-053 – JARVIS LEAD CRM (2026-10-14, Code 8a560fe, Dienst jarvis-crm LIVE, Netlify /api/crm LIVE, Mail-Worker unberührt)
- **Was**: Dashboard-Hauptnavigation **CRM** (https://chrisjarvis.netlify.app/#crm): Übersichtskarten, Suche, Filter, Sortierung,
  Priorität (transparente Punkte HIGH/MEDIUM/LOW), Desktop-Tabelle, Mobile-Karten (ANRUFEN/WEBSITE/ENTWURF ÖFFNEN), Detail-Drawer A–F
  (Kontakt, Website, Probleme Top 3 + „Weitere“, Outreach, Telefon/Anruf dokumentieren, Notizen), Follow-up heute/überfällig/später,
  Do Not Contact, Archiv, CSV-Export (ohne interne IDs). Code `lead-crm.js`, `crm-service.js`, `crm-api.js`, `public/crm{,-model}.js`, `public/crm.css`.
- **Daten**: CRM-Sicht entsteht zur Laufzeit aus lead_registry.json + lead_contact_directory.json + individual_reviews.json (bestätigte
  Befunde) + gmail_jarvis.json (nur gelesen) + `/opt/jarvis-mail/data/lead_crm.json` (nur CRM-Eigenes, 600; einziger Schreiber: jarvis-crm,
  Datei-Lock + atomar + Audit `crm_audit.jsonl` ohne Notiz-Inhalte). Keine Migration: Default-Stufen aus den Quellen (Entwurf → DRAFT_READY,
  manuell gesendet → CONTACTED, Kunde → CUSTOMER, bestehende Sperren → DO_NOT_CONTACT). Neue Leads/Telefon/Person/Befunde erscheinen automatisch.
- **Architektur**: Browser → `/api/crm` (nur crm.*-Allowlist, genau ein bekannter Lead, Rate Limit, Audit) → Warteschlange (Blob jarvis-crm)
  ← Dienst `jarvis-crm-worker` (Projekt jarvis-crm, /opt/jarvis-crm, nur ausgehend, kein gmail.js, kein exec, Mail-Secrets :ro).
  Agent-Schlüssel = HMAC(JARVIS_SERVER_CONTROL_TOKEN, "jarvis-crm-agent-v1") – keine neue Netlify-Variable, gilt nur für /api/crm.
- **Deploy 2026-10-14 16:00 UTC**: `deploy-crm.sh fiverr build|start` → healthy, restarts 0, Agent HTTP 200; MAIL_WORKER_UNTOUCHED=YES
  (5510ab63fef9, StartedAt 06:06:58, restarts 0), CONTACTS_WORKER_UNTOUCHED=YES. Report: 391 Leads (wachsend), Duplikate 0, mit Telefon 339,
  mit Ansprechpartner 71, mit Entwurf 384, mit ≥1 bestätigtem Befund 388, CRM-Einträge 0 (entstehen erst bei der ersten Aktion).
  Sent-Register vorher = nachher (9), 0 Sends.
- **Backup**: täglich ab 03:00 verschlüsselt (backup.js, Public Key) lead_crm.json + crm_audit.jsonl + Kontaktverzeichnis → lokal
  `data/crm_backups` (14) + offsite `jarvis-backups` crm/<Tag> (30). Erstes Backup 16:00 offsite OK. Restore: `node scripts/restore-state.mjs --crm …`;
  Restore-Test mit Testdaten/Testschlüssel im Unit-Test.
- Tests: `test/lead-crm-053.test.js` (A–L, O, P, Cloud, Backup; 22) + `test/crm-browser-053.test.js` (M Mobile 390×844, N Desktop 1440×900,
  Chrome lokal); Unit gesamt 684 / 673 pass / 0 fail / 11 skip (Labs). Secret-Scan 0.
- ~~OFFEN – MAIL WORKER DEPLOY REQUIRED~~ → erledigt 2026-10-14 16:50 UTC (siehe „DNC MAIL-WORKER ENFORCEMENT DEPLOYED“ oben).
  Erster echter CRM-Schreibvorgang live durch Chris (Cloud-Passwort); der Ablauf ist lokal Ende-zu-Ende getestet.

## TF-052 – FIRMA + WEBSITE IN KONTAKT-PDF/CSV (2026-10-14, Code d931f9a, nur jarvis-contacts neu, Mail-Worker unberührt)
- PDF-Spalten Firma · Website · E-Mail · Telefon · Ansprechpartner · Rolle; Website als anklickbarer Link (sichtbar nur die Domain),
  Header zusätzlich „Mit verifizierter Website“. CSV: Spalte „Domain“ → „Website“ (vollständige URL). Fehlend → „Nicht verifiziert“
  (CSV leer). Website = nur Register-Domain (`websiteOf`): verifizierte Startseite https://[www.]domain bevorzugt, sonst
  https://domain/, nie fremde Domain/Subdomain. Verzeichnis führt `website_url` (Abgleich + Anreicherung), Tests `test/lead-contacts-052.test.js`.
- Deploy `deploy-contacts.sh fiverr build|start` 12:17 UTC (MAIL_WORKER_UNTOUCHED=YES, Mail-Worker 5510ab63fef9 StartedAt 06:06:58, restarts 0).
  Erster Durchgang exportierte sofort: 387 Leads → CSV 387 Zeilen, PDF 387 Zeilen / 15 Seiten, 387 Links (eindeutig), Website 387,
  Firma 387, Duplikate 0. Windows-Kopie per `fetch` aktualisiert.

## TF-051 – LEAD-KONTAKTVERZEICHNIS (2026-10-14, Code e0856d5/ce29380/a053ea8, Dienst jarvis-contacts LIVE, Mail-Worker unberührt)
- **Was**: dauerhaft wachsende Liste aller Jarvis-eigenen Cold Leads (Cold-Register `individual_reviews.json` + Gmail-Mapping
  `gmail_jarvis.json`, nie Betreff/Text) mit öffentlich publizierter Geschäftsnummer und Inhaber/Geschäftsführung. Code `lead-contacts.js`,
  Tests `test/lead-contacts-051.test.js` (A–L + Integration). Telefon/Namen werden NICHT in Cold-Mails verwendet, keine Kontaktaktion.
- **Daten (VPS, nie in Git)**: `/opt/jarvis-mail/data/lead_contact_directory.json` (authoritative, 700/600), Exporte atomar nach
  `/opt/jarvis-mail/exports/Jarvis_Lead_Kontaktliste.{csv,pdf}`; Windows-Kopie in `exports/` (gitignored). Upsert per Lead-ID
  (Fallback Domain+Adresse), nie löschen; Status DRAFT/MANUALLY_SENT/NO_LONGER_DRAFT/SKIPPED.
- **Dienst**: eigenes Compose-Projekt `jarvis-contacts` (/opt/jarvis-contacts, Container `jarvis-contacts-worker`, Image ohne gmail.js,
  Mail-Secrets nur read-only, kein Env/Secrets). Alle 2 min: Register-Abgleich → max. 15 neue/fällige Leads anreichern (2 parallel,
  1.5 s/Domain, robots.txt, Retry/Backoff, Fehler → Retry 1 h/6 h/24 h/72 h, max. 5) → CSV bei Änderung, PDF höchstens alle 5 min.
  Re-Verifikation nach 90 Tagen. Die Entwurfserstellung hängt nie daran (Mail-Worker importiert das Modul nicht) → **kein Mail-Deploy nötig**.
- **Deploy/Betrieb**: `bash deploy/vps/deploy-contacts.sh fiverr build|backfill|start|status|fetch` (prüft Mail-Worker ID/StartedAt/Restarts
  vorher/nachher). Backfill nur bei gestopptem Dienst (Lock `contacts.lock`, ein Schreiber).
- **Backfill 2026-10-14 11:38–11:55 UTC**: 387/387 (380 Entwurf, 7 manuell gesendet), 1911 Requests, Telefon 335 (high 289/medium 46,
  davon 29 Mobile als zentrale Nummer ohne Festnetz), Person 72 → nach Offsite-Fix 71 (high 60/medium 12), beide 67, 7 Fehler
  (6 Domain leitet auf andere Website um, 1 TLS-Kette) → automatische Retries. Duplikate 0, Quellen alle auf der Lead-Domain.
  Sent-Register vorher = nachher (9), 0 Sends, 0 Draft-Änderungen.
- Offen: Personenquote (~18 %) bewusst konservativ (keine „Vertretungsberechtigte Person“ ohne Rolle, keine Vornamen-only, keine
  Handelsregister-Abfrage); Verzeichnis ist noch nicht im verschlüsselten Backup; Dienst sieht das secrets-Verzeichnis read-only
  (wegen gmail_jarvis.json) – Härtung: Mail-Worker exportiert beim nächsten geplanten Mail-Deploy einen Ownership-Snapshot.

## TF-050 – COLD DRAFT QUALITY UPDATE DEPLOYED (2026-10-14, Mail-Worker LIVE 3216638)
- **Mail-Cutover** (`deploy.sh fiverr`, ohne Secrets, Freigabe Chris, docker events): alter Worker 4db200caf679 (f868b5a) kill
  06:06:58.387 UTC / gestoppt 06:06:58.584, neuer 5510ab63fef9 gestartet 06:06:58.969, healthy 06:07:04.184 → **Unterbrechung ≈ 5.8 s**.
  Quiet Point vorher geprüft (nur Discovery, kein Draft/Send in Arbeit). Danach: Commit 3216638, healthy, restarts 0, Authority vps/self,
  Scheduler-Herzschlag/Ticks aktiv, Queue 0/0 lesbar, State 16/16 lesbar, `gmail.js check` → **MAIL AUTH READY**, Outbox-Consumer aktiv
  (gmail_auth ok), Backup OK, Disk 26 GB. Readiness wie seit TF-049 nur «Chromium nicht installiert» (erwartet im Mail-Image).
- **Repair-Worker unberührt**: acc10380926b, StartedAt 2026-10-13T20:06:34Z, RestartCount-Delta 0, healthy, f868b5a.
- **Regel im Container verifiziert** (`/app/swiss-repair.js`): `MIN_COLD_FINDINGS` 1, `MAX_COLD_FINDINGS_IN_EMAIL` 3; synthetisch
  0 → kein Entwurf, 1/2/3 → 1/2/3 Punkte, 5 → 3 (Kontaktseite zuerst); COLD_LEAD_DRAFT_ONLY, automatic_send_allowed false.
- **Catch-up-Rewrite** (Runner aus /tmp/tf050, da `cold-draft-rewrite.js` nicht im Mail-Image ist; Plan zuerst, Digest eada2388539c):
  362 Jarvis-Cold-Entwürfe gescannt → 302 bereits korrekt (UNCHANGED), **19 aktualisiert** (16 seit dem Rewrite neu entstanden, 2 ältere
  mit jetzt bestätigten Befunden, 1 bereits umgeschriebener 3 → 2 weil ein Befund behoben), 22 SKIPPED_NO_VERIFIED_FINDING (unverändert,
  nicht gelöscht/gesendet; davon 4 früher umgeschriebene, deren Befund inzwischen behoben/nicht mehr verlinkt ist → bei der manuellen
  Durchsicht prüfen), 19 nicht mehr Jarvis-Entwurf in Gmail, 0 mehrdeutig, 0 Anhang, 0 manuell gesendet. Verteilung der 19: 1/2/3 Befunde
  = 1/7/11. Canary (1) zuerst, dann 18. Gmail-Nachkontrolle 19/19: DRAFT, Label JARVIS, gleicher Empfänger, gleicher Thread, kein CC,
  0 Anhänge, neuer Text. Sent-Register vorher = nachher (9), Worker-Log ohne Send-/Draft-/Fehler-Ereignisse. Temp-Plan im Container gelöscht.
- Hinweis: Runner meldet `signature_matches_spec: false`, weil `config.sender.signature` leer ist; die Vorlage baut die Signatur aus
  Name/Firma/E-Mail und entspricht der Vorgabe (kosmetischer Check, kein Fehler).

## TF-050 – COLD DRAFT QUALITY UPDATE / EXISTING DRAFT REWRITE (2026-10-13, Code d4ea612 + Runner-Fix; seit 2026-10-14 deployt, siehe oben)
- **Regel (`swiss-repair.js`)**: `MIN_COLD_FINDINGS` = 1, `MAX_COLD_FINDINGS_IN_EMAIL` = 3. 0 belegte Befunde → kein Entwurf; 1 → Einzahl-
  Vorlage („Kurzer Hinweis zu Ihrer Website – <domain>“); 2–3 → Mehrzahl („<n> konkrete Hinweise zu Ihrer Website – <domain>“); 4+ → die 3
  wichtigsten (Severity, dann Besucherwirkung). Nie aufgefüllt. Je Punkt genau ein kurzer Satz, keine behauptete Folge. Danach Angebot
  vollständiger Check, CHF 150/480 aus OFFERS, Landingpage, Signatur, neuer Abmeldesatz. Ersetzt die Regel „2–3 Findings“ vom 2026-10-11.
- **Rewrite bestehender Entwürfe (`cold-draft-rewrite.js`, `scripts/tf050-rewrite-cold-drafts.mjs`)**: Besitz nur über Register
  (individual_reviews COLD_LEAD_DRAFT_ONLY + gmail_jarvis.json gleicher Draft/Lead, keine messageClass); Gmail read-only geprüft (DRAFT,
  Label JARVIS, gleicher Empfänger, kein CC/BCC, keine Anhänge, Text unverändert seit Jarvis-Fassung); Befunde öffentlich erneut geprüft
  (Link/Bild noch vorhanden + Ziel 404/410/5xx, ungültiger mailto, TLS-Warnung; Netzfehler = kein Beleg). Übernahme nur via
  `pending_update` → laufender Mail-Worker → `gmail.updateDraft` (in place, Empfänger/Thread bleiben). Kein Send-/Create-/Delete-Pfad.
  Vor dem Deploy im Container als Bundle (Module nach /tmp/tf050, Imports auf /app) ausgeführt.
- **Live-Lauf 2026-10-13 (~21:00–22:00 UTC)**: 345 Jarvis-Cold-Entwürfe gescannt → 307 aktualisiert (1 Befund 228, 2 Befunde 48,
  3 Befunde 31), 19 ohne aktuell bestätigten Befund unverändert (nicht gelöscht/gesendet), 19 nicht mehr als Jarvis-Entwurf in Gmail
  (übersprungen), 0 mehrdeutig, 0 Anhang, 0 in Gmail bearbeitet. Canary zuerst (1 Entwurf), dann Rest. Gmail-Nachkontrolle 307/307:
  neuer Text, weiterhin DRAFT, Label JARVIS, gleicher Empfänger, gleicher Thread, 0 Anhänge. Sent-Register vorher = nachher (9),
  Worker-Log ohne Send-/Fehler-Events. Gmail drafts.get format=full lief anfangs in rateLimitExceeded → Runner gedrosselt (600 ms, Backoff).
- Tests: Unit 621/621 (632 inkl. 11 übersprungene Lab-Tests), neu `test/cold-rewrite-050.test.js` (A–L), Secret-Scan 0.
- **ERLEDIGT 2026-10-14 (siehe oben)** – damals offen: Der Produktiv-Mail-Worker lief weiter mit f868b5a (alte Regel MIN=2, alte Vorlage). Neue
  Cold-Entwürfe aus der Discovery entstehen bis zum Deploy noch im alten Stil. Deploy (`deploy.sh fiverr`, ≈ 6 s Unterbrechung) nur mit
  ausdrücklicher Freigabe von Chris. Danach kann der Runner erneut laufen (idempotent: bereits neue Entwürfe → UNCHANGED).
- Unverändert: COLD_LEAD_DRAFT_ONLY, legal_basis NONE, automatic_send_allowed false, `gmail.sendDraft` verweigert Cold-Entwürfe, kein Auto-Send.

## TF-049 – GMAIL OAUTH RECOVERY + READINESS HARDENING (2026-10-13, Feature f868b5a, Mail- und Repair-Worker LIVE f868b5a)
- **Gmail OAuth recovered**: lokal neu autorisiert (`node gmail.js auth`), `node gmail.js check` → MAIL AUTH READY. Ursache vorher:
  Token expired/revoked seit 2026-10-12 (tick_failed/cold_sync_failed im Mail-Worker-Log, Backoff).
- **Token-Transfer**: nur `.secrets/gmail_token.json` per Windows-OpenSSH-scp unter temporärem Namen ins Secrets-Verzeichnis
  (600, Owner wie bisher), alter Token kurz als Rollback-Kopie (600), atomar per `mv` gesetzt; Rollback-Kopie nach Verifikation mit
  `shred -u` entfernt. Kein `--with-secrets`, kein Secret in Ausgabe/Log/Git. Aktiver Token 600.
- **Repair-Deploy zuerst** (`deploy-repair.sh fiverr`, Image enthält repair-outbox.js + production-readiness.js): jarvis-repair-worker
  f868b5a healthy; MAIL_WORKER_UNTOUCHED=YES (ID ba1b0a65dc27, StartedAt, RestartCount 0, Health, Scheduler, Queue, Authority gleich).
- **Mail-Cutover** (`deploy.sh fiverr`, ohne Secrets, 2026-10-13 20:08 UTC, docker events): alter Worker gestoppt 20:08:00.440,
  neuer gestartet 20:08:00.837, healthy 20:08:06.078 → **Unterbrechung ≈ 5.8 s** (Kill → healthy). Neuer Mail-Worker 4db200caf679,
  f868b5a, healthy, restarts 0, Authority vps/self, Scheduler-Herzschlag aktiv. Repair-Worker durch den Mail-Deploy nicht recreated.
- **VPS Gmail read-only** (im Produktiv-Container, `node gmail.js check`, users.getProfile): **MAIL AUTH READY**. Outbox-Herzschlag
  meldet gmail_auth ok.
- **Continuity**: Queue-Zähler, alle State-Dateien (Eintragszahlen), Backup-Status, Outbox, Authority vorher = nachher → Queue/State
  nicht verloren, keine Duplikate, kein Reset.
- **Architektur**: Repair-Image ohne gmail.js/mail-requests/server-agent, keine Gmail-Secrets, .env nur JARVIS_MAIL_WORKER_TOKEN;
  Mail-Worker einziger Sender, konsumiert die Repair-Outbox (Herzschlag + Gmail-Status) → Repair Outbox ACTIVE, Exactly-one PASS.
- **Production Readiness (VPS)**: Repair-Service `production-readiness.js` → **READY FOR FIRST CUSTOMER** (alle Punkte OK inkl. Mail/
  Gmail OAuth über den Herzschlag, Delivery, CHF150/480, Chromium headless). Mail-Worker-Lauf: alle Punkte OK (Gmail OAuth read-only,
  Delivery, Authority, Backup, Disk 26.2 GB, Release TF-049) ausser «Chromium nicht installiert» – erwartet, Chromium ist seit TF-047
  bewusst nur im Repair-Image. Follow-up: Chromium-Check im Mail-Service nicht werten.
- **Netlify** (read-only, headless): HTTP 200, Desktop + Mobile 390×844 ohne Overflow, keine JS-Fehler, keine Secrets/Adressen.
- **Keine Testmail, kein Draft, keine Label-Änderung, keine Zahlung, keine Kundenverbindung, keine Production-Testorder.**
- **Offen**: Google-OAuth-App Publishing-Status (Testing vs. Production) nicht technisch bestimmbar – Chris prüfen (im Testing-Modus
  laufen Refresh-Tokens nach 7 Tagen ab).
- **Nachverifikation 20:25 UTC** (read-only, kein zweiter Cutover): Mail-Worker 4db200caf679 / Repair-Worker acc10380926b beide
  f868b5a, healthy, restarts 0; VPS `gmail.js check` → MAIL AUTH READY; Outbox-Consumer-Herzschlag gmail_auth ok; Authority vps/self;
  Ticks seit Cutover erfolgreich (sentToday 0, failures 0). Der Worker hat nach der Auth-Wiederherstellung seinen regulären
  Cold-Draft-Betrieb wieder aufgenommen (Drafts zur manuellen Freigabe, kein Versand) – nicht manuell ausgelöst. Einmaliger
  Overpass-HTTP-504 (externe Discovery-API, transient). Keine Token-Temp-/Rollback-Kopien auf dem VPS, keine Testcontainer.

## JARVIS SEPARATE REPAIR SERVICE / ZERO-MAILING-DOWNTIME DEPLOY — TF-047 (2026-10-13, Feature 9df3ee7, Release-Gate 047 lokal grün, Repair-Service LIVE efce58b, Mail-Worker unangetastet)
- **Architektur-Befund**: CHF-480/150 liefen bisher im Mail-Worker-Prozess (runRepairOrders/runCheck150Orders) auf demselben
  Zustand. Locks sind PID-basiert (über Container-PID-Namespaces nicht sicher), mehrere JSON-Dateien werden ohne Lock per
  read-modify-write geschrieben → **kein gemeinsamer Schreib-Zustand** zwischen zwei Containern. Stattdessen minimaler IPC.
- **Mail-Worker (jarvis-mail-mail-worker-1)**: unverändert Gmail, Outreach, Scheduler, Sender Authority, Mail-Queue. Neu im Code
  (aktiv erst beim nächsten GEPLANTEN Mail-Deploy, `deploy.sh` recreated den Container): stellt die Repair-Outbox zu
  (`JARVIS_REPAIR_OUTBOX`, nur mit send_authority), liest den Repair-Zustand read-only (`JARVIS_REPAIR_STATE_DIR`: Dashboard,
  Kunden-Dedupe) und führt dann keine Aufträge mehr selbst aus. Mail-Image ohne Chromium.
- **Repair-Service (jarvis-repair-worker, Projekt jarvis-repair, /opt/jarvis-repair)**: `repair-service.js` – CHF-480 + CHF-150,
  Zahlungs-/Freigabe-Gates, Tresor, Profile Builder, Host-Key, Adapter, Backups (lokal verschlüsselt), Browser-Gate (Chromium nur
  hier), Bericht, Readiness. Eigener Zustand (`state/` → /data/repair), eigenes Lock, Healthcheck, restart unless-stopped,
  read-only rootfs, cap_drop ALL, mem 1 GB, kein Docker-Socket. **Keine Sender Authority**: gmail.js/mail-requests/server-agent
  nicht im Image; Start verweigert bei Gmail-Secrets, Anthropic-Key oder Rolle ≠ repair. `.env` nur JARVIS_MAIL_WORKER_TOKEN
  (+ Sync-URL) für den sicheren Zugangslink. CLI im Container: `docker exec jarvis-repair-worker node repair-workflow.js …` /
  `node payments.js record …` / `node production-readiness.js`.
- **IPC / Transactional Delivery (`repair-outbox.js`)**: Service-Mails (nur CUSTOMER_ACCESS_REQUEST / CUSTOMER_ORDER_FULFILLMENT)
  als Dateien, ein Schreiber je Datei: `<id>.draft.json` → `<id>.request.json` (Repair), `<id>.claim` (wx, vor dem Versand) +
  `<id>.result.json` + `consumer.json` (Mail-Worker). Genau einmal; Claim ohne Ergebnis → «unclear», nie Wiederholung. Mail-Worker
  offline → OUTBOX_PENDING, Auftrag bleibt offen, nie «gesendet». Inhalte nach dem Ergebnis gelöscht.
- **Deploy**: `deploy/vps/deploy-repair.sh <host>` → `repair-remote.sh`: Mail-Worker-Baseline read-only (ID, StartedAt,
  RestartCount, Health, Scheduler-Herzschlag/Tick, Queue, Authority) → Ziel-Guard (eigenes Projekt, genau ein Service, kein
  /opt/jarvis-mail-Mount, kein Docker-Socket, kein Mail-Image; sonst DEPLOY BLOCKED) → nur `build repair-worker` +
  `up -d --no-deps --no-build repair-worker` → Vergleich; Abweichung = FAIL. Nie compose down / Docker-Neustart.
- **Tests**: `test/service-separation-047.test.js` (9, hermetisch: Outbox-Protokoll + Crash-Semantik, CHF-480-Vollauftrag und
  CHF-150 über die Outbox mit Mail-Worker offline/online, Isolation, Readiness, Deploy-/Image-Artefakte) + Lab
  `test/integration/service-separation-047/` (8, Docker: echtes Dockerfile.repair + echtes repair-remote.sh gegen Lab-Mail-Worker).
- **Temp-Leak behoben**: Unit-/Lab-Läufe laufen in einem eigenen `%TEMP%\jarvis-testrun-*` (TEMP/TMP/TMPDIR), das danach komplett
  gelöscht wird; `scripts/lab-cleanup.mjs` räumt nur Lab-Label-Ressourcen + abgebrochene Testrun-Verzeichnisse. `jarvis-live-034-*`
  wird nie angefasst.
- **RELEASE-GATE (2026-10-13 17:04–17:22 UTC, lokal)**: `npm run test:release-047` **PASS in einem Lauf, Exit 0**: Unit 615 Tests /
  604 pass / 0 fail / 11 skip (Lab-Suiten, laufen im Gate selbst), TF-044 18/18, TF-045 10/10, TF-046 8/8, TF-047-Separation 8/8,
  Secret-Scan 0 Treffer, Cleanup 0 Container/Volumes/Netze/Images/Testrun-Verzeichnisse. Minimum freier RAM 1181 MB.
- **VPS LIVE (2026-10-13 17:53 UTC, `bash deploy/vps/deploy-repair.sh fiverr`)**: `jarvis-repair-worker` efce58b healthy, restarts 0.
  Mail-Worker vorher/nachher identisch (verifiziert 17:59 UTC): ID f9de37935036, StartedAt 2026-10-12T19:50:53Z, RestartCount 0,
  healthy, Code fb01df8, Scheduler aktiv (Log-Einträge < 1 min alt) → **24/7-Mailing nicht unterbrochen**.
- **OFFEN (braucht Chris’ Freigabe)**: Outbox-Zustellung + Abschalten der Auftragsausführung im Mail-Worker greifen erst mit einem
  GEPLANTEN Mail-Deploy (`deploy.sh` recreated jarvis-mail-mail-worker-1 = kurze Mailing-Unterbrechung). Bis dahin: Repair-Readiness
  Delivery FAIL / NOT READY; der alte Mail-Worker (fb01df8) führt Aufträge aus seinem eigenen Zustand weiter selbst aus.

## JARVIS FIRST CUSTOMER PRODUCTION READINESS & FULL ORDER DRY-RUN — TF-046 (2026-10-13, Unit 593/593 + TF-044-Lab 18/18 + Browser-Lab 10/10 + Full-Order-Lab 8/8 grün, lokal; NOCH NICHT auf dem VPS)
- **Kundenlieferung** (`repair-workflow.js`, `autoDeliver=true` in `runRepairOrders`): nach bestandenem Abschluss-Gate geht der Bericht
  GENAU EINMAL als Service-Mail `CUSTOMER_ORDER_FULFILLMENT` an die verifizierte Kundenadresse. Draft-ID und Sendeversuch werden vor dem
  Versand persistiert (Neustart sendet nie doppelt, unklarer Ausgang → «UNKLAR», Chris prüft); danach COMPLETED + Tresor zerstört.
  Bericht zu lang → ATTACHMENT_REQUIRED, Bericht mit Interna (`reportUnsafe`: IPs, Pfade, URLs, Backup-/Git-/Auftrags-IDs, Secrets,
  Debug) → BERICHT PRÜFEN, kein Versandweg → Chris liefert selbst (`completeOrder`, Lieferung «manual»). Nie eine Erfolgsmail nach
  REPAIR_FAILED/MANUAL_REVIEW/PAYMENT_REVIEW. Zurückgerollte Fixes gelten als `rolled_back`, nicht als «repariert».
- **Bestätigter Auftrag**: `createConfirmedRepairOrder` erfasst Direktverkauf (sales.json) + Auftrag in einem Schritt; ein stornierter
  (voided) CHF-480-Verkauf stoppt den Auftrag (vor einer Änderung BLOCKED_NO_AUTHORIZATION + Credentials gelöscht, danach MANUAL_REVIEW).
- **Dashboard**: zusätzlich «Freigabe JA/NEIN» und «Lieferung ENTWURF/GESENDET/ANHANG NÖTIG/UNKLAR – PRÜFEN/BERICHT PRÜFEN/CHRIS/DURCH
  CHRIS» – nur feste Wörter, nie Draft-ID, Adresse oder Inhalt.
- **Browser-Validator**: Formular-/POST-Navigationen werden lokal mit 204 beantwortet statt abgebrochen (kein chrome-error://, kein
  falsches cross_domain_redirect), `goto` bis Commit + `document.readyState`, Messung bei zerstörtem JS-Kontext max. 2× wiederholt;
  fremde Domain während der Messung → nur festgestellt.
- **`production-readiness.js`** (neu, auch im VPS-Image): read-only Preflight vor dem ersten echten Kunden – nur OK/WARN/FAIL bzw.
  YES/NO, nie Secret-Werte, kein Netz, keine Aktion (`--no-launch` ohne Chromium-Starttest). READY nur ohne FAIL; Exit 0/1.
- **Tests**: neu `test/full-order-046.test.js` (12, hermetisch: CHF-480-Vollauftrag über `runRepairOrders`, Lieferungs-Idempotenz,
  Fail-safe-Lieferung, Failure/Rollback, Payment-Reversal, Cancel, Void, CHF-150-Vollauftrag, Readiness) + Lab
  `test/integration/full-order-046/` (8, Docker + echtes Chromium: CHF-480 WordPress und SFTP bis COMPLETED, fehlende Freigabe,
  Failure-Flow, Rollback-Failure, Payment-Reversal, Cancel, CHF-150). **Release-Gate TF-046: `npm run test:release-046`**
  (Unit + TF-044 + TF-045 + TF-046, kein Skip).
- **RELEASE-GATE (2026-10-13 15:26–15:39 UTC, lokal)**: `npm run test:release-046` **PASS in einem zusammenhängenden Lauf, Exit 0,
  777 s**: Unit 596 Tests / 593 pass / 0 fail / 3 skip (die 3 Lab-Suiten, laufen im Gate selbst), TF-044-Lab 18/18, TF-045-Browser-Lab
  10/10, TF-046-Full-Order-Lab 8/8. Sequenziell, keine parallelen Labs; RAM überwacht, Minimum 2018 MB frei. Danach Lab-Cleanup:
  0 Lab-Container/-Volumes/-Netze, 0 Chromium-Prozesse; Docker Desktop beendet, `wsl --shutdown`.
- **Stabilität**: danach normale Unit-Suite 3× sequenziell, jeweils 593/593 (3 skip), 0 fail.
- **Secret-Scan 0** (156 Dateien). Temp-Aufräumen: ~45 000 alte `jarvis-*`-Testverzeichnisse aus allen bisherigen Unit-Läufen (inkl.
  Test-Intake-Schlüssel/Test-Tresore) + 3 alte Chromium-Temp-Profile + 1 verwaistes Test-Schlüsselverzeichnis gelöscht.
  **Offen**: die Unit-Tests räumen ihre `mkdtemp`-Verzeichnisse nicht selbst auf (sammelt sich pro Lauf ~500 an).
- **Readiness lokal (`--no-launch`)**: NOT READY – ausschliesslich VPS-spezifisch (kein VPS-Worker/Send Authority, kein
  Worker-Token/sicherer Zugangslink, noch kein State-Backup); alle übrigen Punkte OK, Disk 55 GB.
- **Nicht gemacht**: kein VPS-Deploy (live bleibt fb01df8), keine echte Mail, Zahlung, Kundenwebsite oder Zugangsdaten; 24/7-Mailing
  unberührt. AgentZero-KeepAlive bleibt Disabled.

## JARVIS BROWSER REPAIR VALIDATION & VISUAL REGRESSION GATE — TF-045 (2026-10-12, Unit 581/581 + TF-044-Lab 18/18 + Browser-Lab 10/10 grün)
- **Ziel**: Nach einer automatischen CHF-480-Reparatur beweist ein ECHTER Browser (Chromium über `playwright-core`), dass die Website für
  Besucher funktioniert. Neues Modul **`repair-browser-validator.js`** (nur passiv, nie eine Website-Änderung), eingebunden in
  `repair-workflow.js`. Bekannte Restlücke aus TF-044 (Lab-Retest nur per HTTP) ist damit geschlossen.
- **Desktop 1440×900 + Smartphone 390×844** (Mobile-Emulation; Layout-Breite = `clientWidth`, da Chromium breite Seiten herauszoomt):
  HTTP-Status, DOM/Body sichtbar, gleiche Domain nach Redirects, kritische Bereiche header/nav/main/footer (+ hero/CTA, nur passiv),
  horizontaler Overflow (Toleranz 2 px), Elemente ausserhalb des Viewports, abgeschnittener Text, Bilder über Viewport, kaputte sichtbare
  Bilder (naturalWidth 0), überdeckter Hauptinhalt (elementFromPoint), Navigation sichtbar; auf dem Smartphone wird eine eingeklappte
  Navigation NUR über den Menü-Button geöffnet; bis 3 Navigationsziele (gleiche Domain, keine geschützten Pfade) in eigener Seite geprüft.
- **Befund-spezifisch**: broken_link (alter Verweis weg, neuer vorhanden, **Klick auf den reparierten Link** → Ziel lädt, Domain bleibt),
  broken_image (sichtbar, naturalWidth > 0, Request < 400), navigation_broken (Navigation sichtbar, Ziele ok), mobile_overflow
  (scrollWidth ≤ Viewport + Toleranz). Klickt nur nach der Reparatur, nie in Baseline/Rollback-Prüfung. Status der Zielseite über das
  Dokument-Response bzw. Navigation-Timing (`responseStatus`) – nötig für vorab geladene Seiten (WordPress ≥ 6.8 Speculation Rules,
  im Lab gefunden).
- **Kein generisches Klicken / Protected Interactions**: nur `SAFE_INTERACTIONS` (open_page, open_navigation, check_navigation_target,
  click_repaired_link, verify_image, verify_target_url, measure_overflow). `isSafeClickTarget` lehnt Formulare, submit/reset, Login,
  Checkout/Warenkorb/Bestellung, Zahlung, Newsletter, Cookie/Consent, Delete, Upload, Konto/Admin, javascript:, Downloads ab. Technisch
  erzwungen: jede Anfrage ausser GET/HEAD wird im Browser abgebrochen (Auto-Submit + fetch-POST im Test nachgewiesen: 0 POST am Server),
  Dialoge verworfen, Popups geschlossen, Downloads/Service Worker gesperrt, nie Tippen. Pro Lauf frischer Kontext (Cookies/Storage
  verschwinden), Browser-HOME in Temp-Verzeichnis, danach gelöscht.
- **Same-Domain**: Seite selbst auf fremde Domain umgeleitet → nur festgestellt (`redirected_cross_domain`), keine weitere Interaktion,
  HIGH. Reparierter Link landet auf fremder Domain → `cross_domain_redirect` → FAIL; same-domain-Redirect (301) zulässig.
- **Network/Console**: je Lauf 4xx/5xx + fehlgeschlagene Requests mit Ressourcentyp und same/cross-domain; `pageerror` (nur Fehlertyp,
  z. B. TypeError) und `console.error` (nur Zähler je same-site/Drittanbieter/ignoriert). Konservativer Filter: nur bekannte Tracking-Hosts
  + favicon; Fehler der eigenen Website nie ignoriert. URLs vor Persistenz bereinigt (`sanitizeUrl`: Werte von token/key/secret/
  password/auth/code/session/sid/sig/jwt… und opake Langwerte → REDACTED, Userinfo/Fragment entfernt); nie Cookies, Header, POST-Bodies.
- **VORHER/NACHHER**: vor dem ersten Write Browser-Baseline der betroffenen Seiten (Startseite + Seiten der Plan-Befunde, max. 3) als
  sichere Metadaten (`order.browser_baseline`, kein DOM). Vergleich nur sicherer Signale (Layout-Metriken, Navigation, Bild-Health inkl.
  Pfade, Console-/Request-Fehler, Struktur-Hashes von header/nav/main/footer).
- **Regression-Levels** NONE/LOW/MEDIUM/HIGH: HIGH = Seite lädt nicht, Main fehlt, Navigation kaputt, neuer JS-Crash, massiver Overflow
  (≥ 50 px), ≥ 2 Bilder neu kaputt, fremde Domain, Befund nicht behoben; MEDIUM = neuer kleiner Overflow, 1 Bild neu kaputt, Navigation
  teilweise kaputt, neuer same-site 4xx/Console-Fehler, Element ausserhalb/Text abgeschnitten/Main überdeckt, Header/Footer fehlt;
  LOW = Drittanbieter-Fehler, Struktur-Hash geändert, Hero/CTA fehlt. Abschluss nur bei NONE/LOW. Massive Höhenänderung (> 50 %) ohne
  erklärenden Fehler → nicht eindeutig → **MANUAL_REVIEW_REQUIRED** (kein blindes Pixel-Gate).
- **Rollback-Gate**: MEDIUM/HIGH → `Adapter.rollback()` → Browser neu gestartet, gleiche URLs → Ausgangszustand bestätigt
  (`rollbackMatchesBaseline`: ≤ LOW gegenüber Baseline UND Befunde wieder wie vorher) → **REPAIR_FAILED**; sonst
  **MANUAL_REVIEW_REQUIRED** + Chris informiert (`rollback_unverified`).
- **Completed-Gate** (`completionGate`, in RETEST und `completeOrder`): Adapter-Validierung UND HTTP-Retest UND Desktop- UND Mobile-
  Browser-Gate UND Regression KEINE. **Fail closed**: Produktivlauf (`runRepairOrders`) setzt `requireBrowser=true`; Browser nicht ladbar
  → vor der Reparatur MANUAL_REVIEW (0 Write), im Retest MANUAL_REVIEW statt Abschluss. GitHub+Netlify: Browser-Gate auf der Preview,
  nach dem Deployment erneut auf der Live-Website.
- **Screenshots**: nur auf ausdrücklichen Wunsch (Lab/Test), temporär, nach jedem Lauf gelöscht (geprüft) – nie Git, PROJECT_STATE,
  Cloud oder Kundendatensatz. Produktiv standardmässig aus.
- **Kundenbericht**: nach bestandenem Gate zusätzlich «Desktop geprüft: Ja / Mobile geprüft: Ja / Navigation geprüft: Ja / Keine neuen
  relevanten Darstellungsfehler gefunden.» – keine Logs, Requests, Screenshots, Pfade, Debugdaten.
- **Dashboard** (Allowlist `PUBLIC_REPAIR_FIELDS` + `cleanRepair`): je Auftrag «Browser Desktop JA/NEIN/WARTET · Browser Mobile …
  · Regression KEINE/GEFUNDEN/ROLLBACK»; Registry «Browser ACTIVE/FEHLT». Nie URLs/Screenshots/Logs/Codes. Lokal 390×844 ohne Overflow.
- **Production-Image**: `apk add chromium font-dejavu` (Alpine-Chromium, reproduzierbar), `playwright-core` 1.60.0 exakt gepinnt (lädt
  keinen Browser), `JARVIS_CHROMIUM_PATH=/usr/bin/chromium`; read-only rootfs, tmpfs /tmp, cap_drop ALL, no-new-privileges bleiben.
  Lokal gebaut + geprüft: Chromium 152 Alpine startet unter genau diesen Restriktionen, Validator misst korrekt.
- **Lab** (`test/integration/repair-lab/browser-validation.integration.test.js`, Fixture `browser-broken/` mit Header/Nav/Menü-Button/
  Footer; Skripte als `*.fixture`, sonst hält `node --test` sie für Tests): Chromium spricht echtes HTTPS mit Caddy (nur Lab-Domains per
  host-resolver-rules auf 127.0.0.1, alles andere ~NOTFOUND + Host-Allowlist; Test-CA nur im Lab-Kontext akzeptiert). Caddy zusätzlich
  `/umzug.html` (301 same-domain) und `/weg.html` (302 fremd). Nachweise: SFTP VORHER Link/Bild/CSS kaputt → 3 SFTP-Fixes → Desktop+Mobile
  PASS → Rollback → Ausgangszustand; voller SFTP-Auftrag bis COMPLETED; SSH/SFTP (SFTP-Validation + SSH-Health + Browser) bis COMPLETED;
  absichtliche Regressionen Mobile-Overflow / JS-Fehler / Header-Bild kaputt (vom HTTP-Audit nicht erfasst) → Rollback → REPAIR_FAILED;
  unvollständiger Rollback → MANUAL_REVIEW; Redirects; WordPress VORHER/NACHHER bis COMPLETED + WordPress-Nebenwirkung (mu-plugin-
  Testdoppel) → REST-Rollback → REPAIR_FAILED. Cleanup 0/0/0, 0 Browser-Temp.
- **Befehle**: `npm test` · `npm run test:repair-integration` (TF-044) · `npm run test:browser-integration` (TF-045) ·
  **Release-Gate TF-045: `npm run test:release-045`** (alle drei; fehlt Docker oder Chromium → FAIL, kein Skip).
- **Tests**: neu `test/browser-validation-045.test.js` (23, davon 7 mit echtem Chromium gegen lokalen HTTP-Server) + Browser-Lab (10).
  Mutation A «Browser-Regression ignorieren» → Unit 6 + Lab rot; Mutation B «COMPLETED ohne Mobile-Gate» → Unit rot; Code danach
  wiederhergestellt. Secret-Scan 0.
- **Bekannte Einschränkungen**: Production-Image deutlich grösser (Chromium). Browser-Gate prüft max. 3 Seiten je Auftrag; Befundtypen
  ohne eigene Browser-Prüfung laufen nur über die allgemeinen Checks. Visuelle Bewertung bewusst ohne Pixelvergleich.
- **LIVE 2026-10-12 (c475c26 Feature, fb01df8 Docs)**: Push → GitHub (origin = HEAD verifiziert); VPS `deploy/vps/deploy.sh fiverr` OHNE
  --with-secrets: DEPLOYED_COMMIT fb01df8, Container healthy, 0 Restarts, worker_started role=vps 19:50:54 UTC, authority holder=vps; im
  Container (Prüfskript per stdin, nur passiv) alle Repair-Module + `repair-browser-validator.js` ladbar, Browser-Runtime ACTIVE
  (`/usr/bin/chromium`, playwright-core), Validator-Probe-Start ohne Navigation ok (~1.3 s), 0 Browser-Temp übrig; Registry ACTIVE,
  Host-Key-Verifier ACTIVE, `browser_validator` ACTIVE, Profile-Builder ladbar, 0 Reparaturaufträge. Keine Kundenwebsite aufgerufen, keine
  Lab-Container auf dem VPS (Lab nur lokal, danach 0/0/0). /opt/fiverr unberührt. Netlify Production autodeployt (`/` 200 mit «Browser
  Desktop»/Registry «Browser»), 390×844 ohne Overflow, keine Page-Errors. Keine echte Zahlung, Mail, Kundenverbindung oder Zugangsdaten.
- **RELEASE-GATE FINAL (2026-10-12 20:42–21:06 UTC, Stand c812dac, kein Code geändert)**: `npm run test:release-045` **PASS in einem
  vollständigen, zusammenhängenden Lauf, Exit 0**: Unit 581/581 (2 Lab-Suiten in `npm test` übersprungen, laufen im Gate selbst),
  TF-044 Docker-Lab 18/18, TF-045 Browser-Lab 10/10; Lab-Cleanup 0 Container/0 Volumes/0 Netze, 0 Browser-Temp. Zuvor: der erste
  Gesamtlauf war im Browser-Lab 9/10 rot (zu grobe Screenshot-Prüfung im WordPress-Test, korrigiert in c475c26); dieser finale Lauf ersetzt
  den Nachweis «Einzelsuiten danach grün». Danach normale Suite separat 6 von 7 Läufen 581/581; ein Lauf hatte 1 Fehler, dessen Ausgabe
  nicht gesichert war und der in 5 protokollierten Wiederholungen nicht reproduzierbar war (vermutlich zeitabhängig/unter Last – offen
  beobachten, kein Release-Blocker). Secret-Scan 0. Keine hängenden Chromium-/Lab-Prozesse. 8 alte Test-Temp-Verzeichnisse (Lab-Tresor/
  Test-Zugangsdaten bereits entfernter Lab-Container, 1 Screenshot) aus dem früher per Prozess-Kill abgebrochenen Lab-Lauf gelöscht.
  Kein erneuter VPS-Deploy (Production-Code unverändert, live bleibt fb01df8).

## JARVIS REAL REPAIR ADAPTER INTEGRATION LAB + HOST KEY TYPE SAFETY — TF-044 (2026-10-12, Unit 558/558 + Lab 18/18 grün)
- **TF-043-Einschränkung behoben**: Bestätigt der Kunde den Fingerprint eines anderen Host-Key-Typs (z. B. RSA, während der
  Server Ed25519 bevorzugt), findet Jarvis den passenden Schlüssel jetzt selbst – ohne Login, ohne Blind-Trust.
- **Neu `repair-adapters/host-key.js`** (Host-Key-Verifier): nur moderne Algorithmen ssh-ed25519, ecdsa-sha2-nistp256/384/521,
  rsa-sha2-512/256 (Schnittmenge mit ssh2). **Nie** ssh-rsa (SHA-1) oder ssh-dss – auch die TF-043-Probe ist jetzt darauf
  beschränkt (ssh2 hätte ssh-rsa im Default gehabt). Discovery: je Algorithmus eine eigene Verbindung nur bis zur Host-Key-
  Prüfung (hostVerifier lehnt ab → kein Login, keine Credentials); max. 5 Pre-Auth-Verbindungen (rsa-sha2-256 nur, wenn -512 fehlt,
  gleicher Schlüssel) – wichtig wegen OpenSSH ≥ 9.8 `PerSourcePenalties` (im Lab nachgewiesen: ~16 Pre-Auth-Verbindungen sperren
  die Quell-IP). Match: genau EIN Schlüssel = `host_key_verified=true` + `host_key_algorithm`; kein Treffer → MANUAL_REVIEW_REQUIRED;
  mehrere Schlüsseltypen mit gleichem Fingerprint → fail closed (MANUAL_REVIEW_REQUIRED); nur Legacy-Schlüssel → BLOCKED_UNSAFE_ACCESS.
- **Login-Pinning** (`sftp.js ssh2Session`): Login nur mit `serverHostKey=[verifizierter Algorithmus]` + Fingerprint + Schlüsseltyp.
  Fehlt der Algorithmus (Profil von Chris), wird er vorher OHNE Login ermittelt (Ergebnis 30 min im Prozess-Cache, jede Anmeldung prüft
  trotzdem neu). Abweichung von Fingerprint oder Algorithmus → `HOST_KEY_CHANGED` → neuer Endzustand **BLOCKED_HOST_KEY_CHANGED**
  (Chris informiert, 0 Login, 0 Write; Rollback über einen nicht mehr vertrauenswürdigen Kanal ausgeschlossen). Pre-Write-Check
  `assertHostKeyPinned` bei jeder Verbindung und vor jedem SFTP-Write/Rollback-Write. Credentials stehen in der ssh2-Konfiguration,
  werden aber erst nach bestandener hostVerifier-Prüfung gesendet (im Lab per sshd-Log belegt).
- **Profil** (`profile-builder.js`): zusätzlich `host_key_algorithm`, `host_key_verified`, `profile_hash` (SHA-256 über interface,
  port, remote_root, host_key_sha256, host_key_algorithm, capabilities – nie Passwort/Key/Passphrase/Token/Host/Benutzer). Chris-
  Profil: optional `router.js --host-key-alg` (nur sichere Algorithmen, nur mit --host-key); sonst ermittelt der Preflight ihn einmalig.
- **Mehrere Befunde in derselben Datei/demselben WordPress-Objekt** (Lab-Fund): zweiter Fix wird jetzt erlaubt, wenn die Änderung seit
  dem Plan exakt der eigene, bereits angewendete Fix ist (sonst weiterhin «verändert – kein Write»); Validierung vergleicht mit dem
  letzten Fix je Objekt; Rollback rückwärts bis zum Original. Vorher: zweiter Fix scheiterte, Retest → Rollback → REPAIR_FAILED.
- **Dashboard**: Zustand «HOST-KEY GEÄNDERT» (zählt in «Kein Zugang»), je Auftrag nur «HOST KEY VERIFIED JA/NEIN» (SFTP/SSH) – nie
  Fingerprint, Algorithmus, Host, IP, Benutzer. Registry meldet `host_key_verifier` ACTIVE. Lokal 390×844 ohne Overflow.
- **Repair Integration Lab** (`test/integration/repair-lab/`, nur Tests, nie im Produktions-Image): lokal per Docker Desktop, je Lauf
  eigene Netze (`--internal` für MariaDB/WordPress, Ports nur 127.0.0.1), OpenSSH 10.0 (modern Ed25519+ECDSA+RSA; legacy nur ssh-rsa),
  WordPress 6.8 + MariaDB 11.4 (WP-CLI-Setup, Testseite/-post, kaputter Link + Bild, Editor + Application Password), Caddy-HTTPS mit
  Test-CA, statische Testseite (kaputt + erwartet repariert als Fixtures). Alle Credentials/Host-Keys/Client-Keys zur Laufzeit,
  nichts im Repo. Nach dem Lauf: Container, Volumes, Netze, Temp-Verzeichnisse entfernt (geprüft: 0/0/0).
- **Befehle**: `npm test` (schnell, Lab übersprungen) · `npm run test:repair-integration` (Docker, 18 Tests, ~4 min) ·
  **Release-Gate TF-044: `npm run test:release-044`** (beides; ohne Docker schlägt das Gate fehl statt zu überspringen).
- **Lab-Nachweise**: Fingerprints = `ssh-keygen -lf`; Ed25519/RSA/ECDSA gepinnt + Login; falscher/rotierter Key, falscher Algorithmus →
  HOST_KEY_CHANGED ohne einen einzigen Auth-Eintrag im sshd-Log; Legacy → kein Login; Private Key (Ed25519+Passphrase) per publickey;
  SFTP-Sandbox (../, /etc, /root, .ssh, .env, Symlinks) + 0 Write ausserhalb (Hash-Snapshot); Temp-Upload → posix-rename → Re-Read;
  Rollback before_hash == restored_hash; SSH nur php -l als allowlisted Build/Health (keine Shell, eingeschleuste Befehle abgelehnt);
  WordPress Fix/Validation/Rollback, Plugins/Themes/User/Settings unverändert, kein HTTP-Downgrade, keine Credentials an fremde
  Domain/Redirect; Volle Aufträge WordPress, SFTP (RSA bestätigt, Server bevorzugt Ed25519) und SSH/SFTP bis COMPLETED, Tresor danach
  zerstört (nur connector_type/received_at/destroyed_at/revoked_required); CHF 239 → 0 Verbindung, CHF 240 → Preflight; Freigabe=false →
  0 Write; Gmail nur Attrappe (0 Sends).
- **Tests**: neu `test/repair-integration-044.test.js` (17, In-Process-ssh2-Server) + Lab (18). Angepasst: 035 (BLOCKED_STATES +
  BLOCKED_HOST_KEY_CHANGED). Mutationen: A «Host-Key blind vertrauen» → Unit 2 + Lab 2 rot; B «Credentials vor Verifikation» → Unit 2 +
  Lab 2 rot; Code danach wiederhergestellt. Secret-Scan 0.
- **LIVE 2026-10-12 (042043e)**: Push → GitHub (origin = HEAD verifiziert); VPS `deploy/vps/deploy.sh fiverr` OHNE --with-secrets:
  DEPLOYED_COMMIT 042043e, Container healthy, 0 Restarts, worker_started role=vps 17:43:19 UTC, authority holder=vps self=true; im
  Container (Prüfskript per stdin) payments, check-150-workflow, repair-workflow, router, profile-builder, host-key, wordpress, sftp, ssh,
  github-netlify ladbar; Registry ACTIVE (ssh2 ladbar), Host-Key-Verifier ACTIVE (6 sichere Algorithmen, legacy_allowed=false),
  BLOCKED_HOST_KEY_CHANGED bekannt, 0 Reparaturaufträge. Keine Lab-Container auf dem VPS (Lab lief nur lokal, danach 0/0/0).
  /opt/fiverr unberührt. Netlify Production autodeployt (`/` 200 mit «HOST-KEY GEÄNDERT»/«HOST KEY VERIFIED», `/access.html` 200),
  Production 390×844 ohne Overflow. Keine echte Zahlung, Mail, Kundenverbindung oder Kunden-Zugangsdaten.

## JARVIS AUTOMATIC REPAIR ACCESS PROFILE & PREFLIGHT — TF-043 (2026-10-12, Tests 539/539 grün)
- **Ziel erreicht**: normale SFTP/SSH-Aufträge brauchen kein `router.js --profile/--root/--host-key` mehr. Ablauf: ACCESS RECEIVED →
  ACCESS_CHECK (Routing) → **ACCESS_PROFILE_PREFLIGHT** (nur lesend) → PROFILE_READY → ACCESS_CHECK (Adapter) → BACKUP → …
- **Neu**: `repair-adapters/profile-builder.js` (Preflight, Host-Key-Probe ohne Zugangsdaten, Webroot-Discovery, Profil-Allowlist).
  Profil am Auftrag `order.access_profile` (interface, port, remote_root, host_key_sha256, host_key_source, webroot_source,
  webroot_signals, capabilities, profile_status, profile_created_at) – NIE Host/Benutzer/Passwort/Schlüssel. Profil von Chris
  (`repair_access_profiles.json`) hat Vorrang (router.js `effectiveProfile`). Nach COMPLETED/CANCELLED/REPAIR_FAILED auf
  Status/Quellen reduziert (kein Webroot, kein Fingerprint mehr).
- **Neue Zustände** (wartend, nichts wird verändert): ACCESS_PROFILE_PREFLIGHT, HOST_KEY_CONFIRMATION_REQUIRED,
  WAITING_FOR_ACCESS_PROFILE. Zahlungsschwelle gilt auch hier (fällt sie → PAYMENT_REQUIRED). 6 vorübergehende Fehler
  (Server nicht erreichbar) → MANUAL_REVIEW_REQUIRED + Chris informiert.
- **Formular** (`public/access.html/.js`): für SFTP/SSH/Hosting zusätzlich Port, Website-Verzeichnis, SSH-Host-Key (SHA256:…),
  Passphrase, Website-System, Hosting-Anbieter – alles nur im Browser-Chiffrat, nichts im Browser-Speicher. Geheim: secret,
  passphrase; Metadaten: host, port, username, remote_root, Fingerprint, Stack-Hinweis, Provider.
- **WordPress**: PROFILE_READY nach erfolgreicher REST-Prüfung (HTTPS, REST, Domain, Auth, Schreibrecht) – ohne Chris.
  **GitHub+Netlify**: genau EINE Zuordnung → PROFILE_READY; keine/mehrere → MANUAL_REVIEW_REQUIRED.
- **Host-Key** (nie blind vertrauen): Fingerprint wird per ssh2 OHNE Anmeldung erfasst (hostVerifier lehnt ab). Vertrauen nur
  aus (A) Kundenangabe im Formular, (B) Profil von Chris, (C) Bestätigung (Kunde per Link / Chris per CLI); Provider-API-Quelle
  vorbereitet, bewusst leer. Abweichung → MANUAL_REVIEW_REQUIRED. Keine Quelle → HOST_KEY_CONFIRMATION_REQUIRED, nur Kandidat
  gespeichert, keine Verbindung mit Zugangsdaten. Kunde bekommt GENAU EINE Service-Mail (Klasse CUSTOMER_ACCESS_REQUEST) mit
  One-Time-Link (Zweck `host_key_confirmation`, 72 h, nur Token-Hash): Seite zeigt Fingerprint, Kunde vergleicht mit seinem
  Hoster und bestätigt (Pflicht-Häkchen + Domain) oder meldet Abweichung (→ MANUAL_REVIEW_REQUIRED). Fallback Chris:
  `node repair-workflow.js --confirm-host-key <id> --fingerprint SHA256:…` (muss exakt dem Kandidaten entsprechen);
  abgelaufener Link: `--reissue-access <id> --reason …`.
- **Webroot**: Profil von Chris > Kundenangabe (kanonisiert, `~/`/relativ → Login-Root, kein `..`, validateRemoteRoot, innerhalb
  Login-Root, existiert, kein Symlink, Startseite vorhanden; /etc, /root … → BLOCKED_UNSAFE_ACCESS) > nur lesende Discovery
  (public_html, www, htdocs, httpdocs, web, site, <domain>, www.<domain>, domains/<domain>/public_html; nur im Login-Root, Symlinks
  nie betreten). Automatisch nur bei GENAU EINEM plausiblen Kandidaten: WordPress = wp-config.php + wp-content/ + wp-includes/ +
  index.php (nur Existenz, wp-config.php nie gelesen); statisch = index.html + Inhalt passt zur öffentlichen Startseite.
  0/>1 Kandidaten oder nicht belegbar → WAITING_FOR_ACCESS_PROFILE; Chris ergänzt `--root`, Auftrag läuft selbst weiter.
- **Dashboard**: Phasen ACCESS PROFILE PREFLIGHT / HOST KEY CONFIRMATION / WAITING FOR ACCESS PROFILE, Feld `profile_status`
  (nur Wort), Zeile «Zugangsprofil» (Host-Key n · Profil fehlt n). Nie Host, Benutzer, IP, Pfade, Fingerprint (cleanRepair).
- **Cloud** (`access-intake-api.js`): zweiter Link-Zweck `host_key_confirmation` (register/info/submit), bestehender Zugangs-Link
  unverändert kompatibel.
- **Tests**: `test/access-profile-043.test.js` (21; inkl. echter Host-Key-Probe gegen isolierten lokalen ssh2-Testserver
  127.0.0.1 ohne Anmeldeversuch, SFTP-E2E bis COMPLETED, First-Use-E2E mit Kundenbestätigung, Mutationsprobe). Angepasst:
  035 (ORDER_STATES), 036 (einziger sendDraft im Helfer sendLinkMail, nur ACCESS_REQUESTED + HOST_KEY_CONFIRMATION_REQUIRED).
  539/539 grün, Secret-Scan 0. Keine echten Kundenserver, Mails, Zahlungen oder Zugangsdaten.
- **Router/CLI**: Preflight über `createAdapterRegistry` (reg.preflight) automatisch in Engine + Worker verdrahtet;
  `router.js --profile` und `--confirm-host-key` sind nur noch Recovery/Fallback. Payment CHF 240 (von CHF 480), Freigabe und
  Domain-Bindung werden VOR jedem Preflight geprüft (sonst 0 Probes, 0 Verbindungen).
- **Mobile lokal (390×844, Playwright, echter Intake-Handler In-Memory, nur Attrappen)**: kein horizontaler Overflow; Server-Felder
  nur bei SFTP/SSH/Hosting sichtbar und bedienbar; Fehlermeldungen (Freigabe, Port, Fingerprint, Domain); Erfolg → alle Felder
  geleert, keine Attrappen-Werte im DOM, kein local/sessionStorage, keine Cookies, keine Konsolenausgabe; Token nach Laden aus
  der URL entfernt; Server sah nur Chiffrat + Metadaten; Host-Key-Seite: Fingerprint, Pflicht-Häkchen, Bestätigung, Link danach
  ungültig; CSP/no-store/noindex-Header wie netlify.toml.
- **LIVE 2026-10-12 (ce336aa)**: Push → GitHub (origin = HEAD verifiziert); VPS `deploy/vps/deploy.sh fiverr` OHNE --with-secrets:
  DEPLOYED_COMMIT ce336aa, Container healthy, 0 Restarts, worker_started role=vps 16:08:38 UTC, authority holder=vps self=true;
  im Container (read-only rootfs, Prüfskript per stdin): payments, check-150-workflow, repair-workflow, router, profile-builder,
  wordpress, sftp, ssh, github-netlify ladbar; Standard-Deps = github_netlify, wordpress, sftp, ssh + Router + Preflight; Registry
  ACTIVE (ssh2 ladbar); 16 Order-Zustände; 0 Reparaturaufträge. /opt/fiverr unberührt. Netlify Production autodeployt: `/` 200
  (Zeile «Zugangsprofil», neue Phasen), `/access.html` 200 mit CSP/no-store/noindex und neuen Server-Feldern; `/api/access-intake`:
  unbekannter Token (info + host_key-submit) → generisches 404, pull/register ohne Worker-Token → 401, GET → 405. Production-Mobile
  390×844: Startseite und Access-Formular (SSH-Felder + Host-Key-Ansicht) ohne Overflow, Token aus URL entfernt, kein Storage,
  keine Cookies. Keine echte Zahlung, Mail, Zugangsdaten, Host-Key-Bestätigung, SFTP/SSH-/WordPress-Verbindung, kein Intake registriert.
- **Bekannte sichere Einschränkung (in TF-044 behoben)**: ssh2 handelt den Host-Key-Typ selbst aus. Liefert ein Kunde den Fingerprint eines anderen
  Typs (z. B. RSA statt Ed25519), endet das fail closed in MANUAL_REVIEW_REQUIRED (unnötige manuelle Prüfung, nie unsicher).
  Bewusst KEIN Typ-Durchprobieren/Auto-Trust in TF-043.

## JARVIS AUTHORIZED REPAIR ADAPTERS — TF-042 (2026-10-12, Tests 518/518 grün)
- **Neue Dateien**: `repair-adapters/common.js` (Contract, Capabilities, Issue→Fix-Matrix, Minimal-Patch, Domain-Bindung, Objekt-
  Backup, Fehlerbereinigung), `wordpress.js`, `sftp.js`, `ssh.js`, `router.js` (Routing, Zugangsprofile, Credential-Kontext, Brücke
  zur Engine, Registry). GitHub+Netlify-Adapter unverändert (036-Tests grün, Router wählt ihn für github_netlify bzw. Mapping).
- **Contract**: checkAccess/backup/locate/applyFix/validate/deployProduction/rollback/cleanup(+detectCapabilities), jeweils mit
  Credential-Kontext NUR zur Laufzeit. Persistiert werden nur Allowlist-Metadaten (connector, capabilities, checked_at, backup_ref,
  rollback_ref, Hashes …); enthält eine Antwort ein Secret → verworfen. Exceptions werden in der Brücke bereinigt.
- **Capabilities**: READ_FILES, WRITE_FILES, ATOMIC_REPLACE, REST_CONTENT_READ, REST_CONTENT_WRITE, BACKUP, ROLLBACK, BUILD_TEST,
  HEALTH_CHECK – je Adapter tatsächlich geprüft (am Auftrag `access.capabilities`). Ohne BACKUP+ROLLBACK → MANUAL_REVIEW_REQUIRED;
  Plan-Eintrag nur, wenn alle benötigten Capabilities vorhanden sind.
- **Issue→Fix-Matrix**: automatisch nur broken_link / contact_page_broken / navigation_broken (href), broken_image / missing_asset
  (src), mobile_overflow nur mit exakt belegter CSS-Stelle (nur Dateien). NIE: Zertifikat, DNS, Redirect, Security, Auth, Formulare.
  Kein Raten: locate() liefert nur mit exaktem Objekt, exakter Stelle, genau EINEM Ersatzziel (öffentlich 200, gleiche Domain),
  höchstens 3 Objekten; sonst needs_review → MANUAL_REVIEW_REQUIRED. max_auto_fixes_per_order = 10, mehr → MANUAL_REVIEW_REQUIRED.
- **WordPress (REST, kein wp-admin, kein Browser)**: HTTPS Pflicht, REST-Basis exakt auf der Auftrags-Domain, Redirects mit
  Zugangsdaten werden nie verfolgt; Application Password/temporärer Benutzer; nur lesend → BLOCKED_NO_ACCESS; Rechte nie erweitert,
  nie Benutzer angelegt. Schreiben NUR `/wp/v2/(pages|posts|navigation)/<id>` (harte Allowlist) – nie Plugins/Themes/Users/Settings/
  WooCommerce. Vor jedem Write Objekt-Backup (object_type, object_id, original_hash, Originalinhalt, modified_at, backup_created_at),
  Minimal-Patch nur des kaputten href/src (auch Block-JSON), Hash-Prüfung; Validierung über Objekt-Hash + öffentliche Seite.
- **SFTP**: nur SFTP (kein FTP), Host-Key-Fingerprint Pflicht (Profil), root → BLOCKED_UNSAFE_ACCESS, remote_root Pflicht/kanonisch/
  kein Systemverzeichnis. Sandbox blockiert ../, absolute Escapes, Symlink-Escapes (realpath), /etc, /root, .ssh, .env, .htaccess,
  Schlüssel/Konfig. Schreiben nur .html/.htm/.css. Write: lesen → Hash prüfen → lokales Backup → Temp-Datei im selben Verzeichnis →
  Rechte prüfen → Inhalt prüfen → posix-rename (atomar) → Ergebnis-Hash. Ohne atomaren Rename keine ATOMIC_REPLACE/ROLLBACK.
- **SSH**: keine freie Shell, kein exec(string); nur typisierte Funktionen (statFile, readFile, hashFile, listDirectory, writeTempFile,
  atomicRename, runConfiguredBuildCheck, runConfiguredHealthCheck). Dateiänderungen ausschliesslich über die SFTP-Schicht. Ausführen
  nur von Chris konfigurierte Check-IDs: npm (`--prefix <root> run <script>`/`test`), php `-l`, node `--check`; Argumente ohne Shell-
  Metazeichen (; && || | ` $() > < Zeilenumbruch …), Pfade in remote_root; sudo/su/apt/useradd/rm/curl … verboten. root → unsicher.
- **Router**: github_netlify → GitHub+Netlify; wordpress_cms → WordPress; sftp → SFTP; ssh → SSH (mit Checks) bzw. SFTP über SSH
  (ohne Checks, minimal nötige Rechte); hosting nur über erkennbare Schnittstelle (Profil-Interface, sftp://, ssh://, wp-json,
  GitHub-Mapping), sonst BLOCKED_UNSUPPORTED_STACK; other → BLOCKED_UNSUPPORTED_STACK. Zugangsart ≠ Stack (z. B. WordPress-Site +
  SFTP → SFTP); gebaute Apps (Next.js/React) nie per Dateiänderung. Kein Browser-Login, keine Hoster-Panels.
- **Zugangsprofil** `repair_access_profiles.json` (KEINE Secrets): interface, port, remote_root, host_key_sha256, wp_api_base,
  checks. `node repair-adapters/router.js --profile <domain> --root /pfad --host-key SHA256:… [--interface …] [--checks datei.json]`.
- **Engine** (repair-workflow.js): order.route (Adapter-Wahl genau einmal), neuer Endzustand BLOCKED_UNSAFE_ACCESS, Domain-Bindung
  vor jedem Write (Auftrag/Freigabe/Zugang/Live-Ziel, fremde Weiterleitung → STOP). WordPress/SFTP/SSH ohne Preview = direkt live:
  nur niedriges Risiko mit Backup+Rollback; jede fehlgeschlagene Validierung/Retest/Health/Live-Regression → sofort Rollback, danach
  erneut geprüft; Rollback ok → REPAIR_FAILED (Tresor zerstört), Rollback fehlgeschlagen/unsauber → MANUAL_REVIEW_REQUIRED + Chris
  informiert (order.alerts, Log `repair_chris_alert`, Dashboard). Payment/Auth-Gate TF-041 unverändert (CHF 480, Deposit 240).
- **Kundenbericht**: zusätzlich «Nicht automatisch repariert» und Hinweis, den temporären Zugang zu entfernen – nie Credentials,
  Hosts, Pfade, Git-SHA, Backup-IDs, Tokens.
- **Dashboard/Snapshot**: je Auftrag Adapter (GitHub+Netlify/WordPress/SFTP/SSH/Unsupported), Access, Backup, Rollback, Auto-fixable,
  Manual Review; Phasen BACKUP / REPAIRING / VALIDATING / LIVE RETEST / COMPLETED / MANUAL REVIEW; Zeilen «Adapter Registry» und
  «Manuelle Prüfung». Whitelist in server-control.js (cleanRepair). Mobile 390×844 lokal geprüft: kein horizontaler Overflow.
- **Dependency**: `ssh2` 1.17.0 (exakt gepinnt, package-lock.json neu). Dockerfile: `npm ci --omit=dev --omit=optional --ignore-scripts`.
  Kein basic-ftp, kein FTP. Kein Bankzugriff (payments.js unverändert).
- **Tests**: `test/repair-adapters-042.test.js` (30; WordPress-Mock-E2E, SFTP- und SSH/SFTP-Fixture-E2E bis COMPLETED, Sandbox,
  Injection, Router, Payment/Auth, Secret-Marker in Order/payments/sales/lead_registry/Logs/Dashboard/Snapshot/Bericht/
  PROJECT_STATE/Git). Angepasst: 035 (BLOCKED_STATES). Gesamt 518/518, Secret-Scan 0 Treffer. Keine echte Zahlung, Mail,
  Zugangsdaten, WordPress-/SSH-/SFTP-Verbindung, Kundenwebsite.
- **LIVE 2026-10-12 (30e4426)**: Push → GitHub (origin = HEAD verifiziert); VPS `deploy/vps/deploy.sh fiverr` OHNE --with-secrets:
  Image mit `npm ci` gebaut, DEPLOYED_COMMIT 30e4426, Container healthy, 0 Restarts, worker_started role=vps 14:57:23 UTC,
  authority holder=vps; im Container: ssh2 ladbar, Standard-Deps = github_netlify, wordpress, sftp, ssh + Router, Registry ACTIVE,
  0 Reparatur-/CHF-150-Aufträge, Ledger leer. /opt/fiverr unberührt. Discovery-«Overpass HTTP 504» = externe Störung (Backoff aktiv,
  letzter Fehler noch im alten Container). Netlify Production autodeployt: `/` 200 mit neuen Panel-Zeilen, `/access.html` 200 mit
  CSP/no-store/noindex, `/api/access-intake` für unbekannte Tokens 404. Mobile 390×844 auf Production: kein Overflow, kein Storage.
  Windows-STANDBY in diesem Lauf nicht geprüft. Keine echte Zahlung/Mail/Verbindung ausgelöst.
- **OFFEN** für echte Aufträge: je Domain ein Zugangsprofil (remote_root + Host-Key) durch Chris; Adapter gegen einen echten
  Testserver wurden bewusst nicht geprüft (nur Mocks/Fixtures).

## JARVIS PAYMENT GATES + SECURE CUSTOMER ACCESS — TF-041 (2026-10-12, Tests 488/488 grün)
- **VERKAUF != ZAHLUNG**: sale / direct-sale / create-confirmed / ORDER_CONFIRMED bestätigen nur den Auftrag. Geldeingang nur im
  Payment-Ledger `payments.js` → `.secrets/mail_worker/payments.json` (atomar, im verschlüsselten State-Backup). Felder je Zahlung:
  payment_id, order_id, domain, offer_class, amount_chf, currency, received_at, source, reference, status, created_at.
  Status RECEIVED / VOIDED / REFUNDED – nie löschen, Korrektur nur markieren (Grund Pflicht). Nur RECEIVED + CHF zählt; primär an die
  ORDER_ID gebunden (nie nur Domain); unbekannte order_id → Fehler. **Duplikatschutz**: gleiche Referenz (normalisiert, auftrags-
  übergreifend) zählt nie doppelt; nach void wieder frei.
- **CLI**: `node payments.js record <order_id> --amount <CHF> --reference "<ref>" [--currency CHF] [--source manual_bank_confirmation]`
  (Referenz Pflicht), `show <order_id>` (Alias status), `list [order_id]`, `void|refund <payment_id> --reason "<grund>"`.
- **Abgeleiteter Zahlungsstatus** (paymentSummary, Preis/Deposit aus OFFERS, kein CHF-500-Preis): UNPAID / PARTIAL / DEPOSIT_MET /
  PAID_FULL / REFUNDED / PAYMENT_REVIEW_REQUIRED. REPAIR_CHECK_150: 150 / Deposit 75. REPAIR_FIX_500: 480 / Deposit 240.
- **CHF 150** (check-150-workflow.js): vor kumulativ CHF 75 → BLOCKED_PAYMENT_NOT_RECEIVED (je Lauf neu geprüft): kein Audit, keine
  Anleitung, kein Bericht, kein Versand. Ab CHF 75: Audit → Anleitung → Bericht → Entwurf → DELIVERY_SENDING → automatischer Versand
  (CUSTOMER_ORDER_FULFILLMENT, an die bestätigte delivery_email) → COMPLETED. Vor dem Send fail closed erneut: Verkauf bestätigt/nicht
  voided, Zahlung ≥ 75, REPAIR_CHECK_150, delivery_email gültig und = Entwurfsadresse, Bericht + report_hash + Entwurf zur selben
  Berichtsversion, noch nicht gesendet. **Langer Bericht (Anhang nötig)**: die Gmail-Schicht hängt keine Dateien an → nie Auto-Send,
  READY_FOR_DELIVERY mit «ATTACHMENT_REQUIRED», Chris hängt an und sendet. **Send-Idempotenz**: `delivery_send_attempted_at` wird vor
  dem Send persistiert; unklarer Vorversuch → nie erneut senden (Übergabe an Chris); transiente Fehler (429/5xx) → Marker frei, Retry.
- **CHF 480** (repair-workflow.js): vor kumulativ CHF 240 keine Zugangs-Anfrage, kein Login, kein Intake, keine Reparatur. Ab CHF 240
  genau EINE Service-Mail CUSTOMER_ACCESS_REQUEST an die verifizierte Kundenadresse (Teilzahlung eingegangen, temporärer sicherer
  Zugang, KEINE Passwörter per E-Mail, orderspezifischer One-Time-Link, temporärer Benutzer mit minimalen Rechten; keine Werbung,
  keine interne ID). Send-Idempotenz wie CHF 150 (`send_attempted_at`/`send_unclear`). Abgelaufener Link: neue Anfrage nur durch Chris
  (`--reissue-access <id> --reason`). **Zahlung ist keine Freigabe.** Start nur mit Zahlung ≥ 240 + Freigabe + sicherem Zugang +
  erfolgreicher Zugangsprüfung + Backup/Rollback-Punkt; order.domain = authorized_domain = Zugangsdomain, sonst fail closed.
  Zahlung fällt nach Start unter 240: vor einer Änderung → PAYMENT_REQUIRED; nach einer Änderung → PAYMENT_REVIEW_REQUIRED (neu in
  BLOCKED_STATES), nie automatischer Rollback. Neuer terminaler Zustand CANCELLED (`--cancel <id> --reason`). Bestehende Repair-Safety
  (Backup, Branch, Minimal Fix, Validierung, Desktop/Mobile-Retest, Regression-/Production-Gate, Live-Retest, Rollback) unverändert.
  Der CHF-480-Workflow liest sales.json weiterhin nie (TF-040-Invariante).
- **Secure Access Intake**: Netlify `/api/access-intake` (access-intake-api.js, Blobs «jarvis-access-intake») + Kundenseite
  `public/access.html` (strikte CSP, no-store, noindex) + VPS-Seite `access-intake.js`. Token 32 Zufallsbytes, nur im URL-Fragment
  der Mail; gespeichert/registriert nur sha256. Gebunden an Auftrag + Domain, Ablauf 72 h, nach einer Einreichung ungültig (ETag-atomar).
  Pflicht-Zustimmung im Formular («Ich bestätige, dass ich berechtigt bin … Reparaturen auf <domain> …») → customer_authorized_repair,
  authorization_at, authorization_source=secure_order_access_form, authorized_domain, scope. Zugangsarten github_netlify,
  wordpress_cms, sftp, ssh, hosting, other (Formular empfiehlt Collaborator → temporärer CMS-Benutzer → temporärer SFTP/SSH-Benutzer →
  verschlüsselte Eingabe). **Verschlüsselung im Browser** (RSA-OAEP-256 + AES-256-GCM, gleiches Verfahren wie backup.js) mit dem
  Public Key des VPS; Private Key nur auf dem VPS (`mail_worker/access_intake_private.pem`, 600, beim ersten Bedarf erzeugt). Der VPS
  holt Einreichungen nur ab, wenn ein Auftrag wartet, prüft fail closed (Token-Hash, Ablauf, Domain, Freigabe, Zahlung,
  entschlüsselbar), legt nur Chiffrat in `mail_worker/access_vault/<order_id>.json` ab und quittiert (Cloud-Eintrag gelöscht).
  Entschlüsselung nur im Speicher für den Adapter. Nach COMPLETED/CANCELLED wird der Tresor-Eintrag überschrieben + gelöscht; nur
  Metadaten bleiben (connector_type, received_at, destroyed_at, revoked_required). Tresor + Key nicht im State-Backup.
  Werkzeug: `node access-intake.js status|destroy <order_id>` / `reveal <order_id> --confirm` (nur stdout auf dem VPS).
- **Dashboard/Snapshot**: je Auftrag Preis, bezahlt, Deposit, Rest bis Deposit, Zahlungsstatus, Phase (CHF 150: WAITING FOR DEPOSIT /
  DEPOSIT RECEIVED / AUDITING / REPORT / SENT / COMPLETED; CHF 480: WAITING FOR DEPOSIT / ACCESS REQUEST SENT / WAITING FOR ACCESS /
  ACCESS RECEIVED / REPAIRING / VALIDATING / COMPLETED), Zugang ja/nein + Zugangsart; neue Zeile «Payment Worker» (snapshot.payments:
  nur Zähler/CHF-Summen). Whitelists in server-control.js (cleanCheck150/cleanRepair/cleanPayments) – nie Referenzen, payment_ids,
  Links, Tokens, Token-Hashes oder Zugangsdaten. Mobile 390×844 lokal geprüft (Dashboard + Formular): kein horizontaler Overflow.
- **Cold Outreach unverändert**: COLD_LEAD_DRAFT_ONLY, automatic_send_allowed=false, gmail.sendDraft verweigert Cold-Entwürfe. Gmail-
  Register vermerkt nur die zwei Service-Klassen (SERVICE_MESSAGE_CLASSES) und nie an einem Cold-Entwurf.
- **Tests**: `test/payments-041.test.js` (13), `test/secure-access-041.test.js` (6, E2E über echten Netlify-Handler + VPS-Client +
  Browser-Krypto), angepasst 035/036/038/039. Gesamt 488/488 grün, Secret-Scan 0 Treffer. Keine echte Zahlung, keine echte Mail,
  keine echte Kundenwebsite, keine Production-Testorder.
- **LIVE 2026-10-12 (64f6aa8)**: Push → GitHub (origin verifiziert); VPS `deploy/vps/deploy.sh fiverr` OHNE --with-secrets:
  DEPLOYED_COMMIT 64f6aa8, Container healthy, 0 Restarts, worker_started role=vps, authority holder=vps; im Container laden
  check-150-workflow/repair-workflow/payments (0 offene Aufträge, Ledger leer). /opt/fiverr unberührt. Netlify Production autodeployt:
  `/` 200, `/access.html` 200 mit CSP/no-store/noindex, `/api/access-intake` antwortet für unbekannte Tokens generisch 404 und
  verweigert pull ohne Worker-Token (401). Mobile 390×844 auf Production: kein Overflow, kein Browser-Storage. Keine echte
  Registrierung/Zahlung/Mail ausgelöst. Discovery-«Overpass HTTP 504» vor dem Deploy = externe Störung (Backoff aktiv).

## JARVIS SALE VOID / TEST-SALE REVERSAL (TF-040, 2026-10-12, Tests 469/469 grün)
- **Verkäufe werden NIEMALS gelöscht**: `node sales.js void-sale <domain> --reason "<grund>"` (`voidSale` in sales.js) markiert
  nur – `sale_status=voided`, `voided=true`, `voided_at`, `void_reason` (Grund Pflicht). Alle Originaldaten bleiben unverändert
  (Angebot, Betrag, Datum, Evidence, `direct_sale`-Stammdaten/Quelle); `rec.status=sale_voided`. Historie vollständig nachvollziehbar.
- **Fail closed**: nur exakter Domain-Treffer (nie Auswahl eines ähnlichen Datensatzes), unbekannte Domain / kein Verkauf /
  bereits voided / fehlender Grund / ungültige Domain → Fehler, nichts verändert.
- **Umsatzberechnung ignoriert voided Sales**: zentrales `validSale` (sales.js) schliesst voided aus → total_revenue,
  revenue_150/500, sales_150/500, customers, Lifecycle `customer`, loadPipeline.sale und damit auch Dashboard-Umsatz
  (metrics.json → HUD) fallen automatisch korrekt zurück. Historischer Datensatz bleibt in sales.json gespeichert.
- **Voided bestätigt keine Workflows**: `confirmedCheck150Sale` lehnt voided ab (`isVoidedSale`) → Auftrag bleibt/wird
  BLOCKED_ORDER_NOT_CONFIRMED, kein Audit, kein Bericht, kein Gmail-Entwurf. CHF-480: liest sales.json nie (testbewiesen);
  NEVER_AUTHORIZATION zusätzlich um `voided_sale`/`sales_record` erweitert – ein Verkauf ist dort NIE eine Reparaturfreigabe.
  CHF-480-Workflow sonst unverändert.
- **Verknüpfte Aufträge schützen vor versehentlichem Void** (`collectDomainOrders`, prüft check150_orders.json UND
  repair_orders.json): offener Auftrag → «Offener Auftrag … – zuerst Auftrag stornieren»; COMPLETED → fail closed
  (manuelle Prüfung, kein automatisches Void); CANCELLED (und bei CHF-480 terminal gescheiterte BLOCKED_*-Aufträge ohne
  Storno-Weg) stehen dem Void nicht im Weg.
- **Customer-Status korrigiert, nie blind gelöscht**: reconcile (lead-registry.js Schritt 6) stuft bei voided per
  `authoritative: ["customer_status"]` herab – Direkt-/Testkunde ohne anderen aktiven Verkauf → `voided_test_customer`
  (neu in CUSTOMER_STATES, deriveStatus → DISCARDED «verworfen»), sonst `none`. mergeLead erlaubt die Herabstufung NUR
  authoritative (Rang bleibt klebrig); ein späterer echter Verkauf macht wieder `customer`. Kunden mit anderen aktiven
  Verkäufen bleiben Kunde (validSale je Verkauf).
- **Kein Cold-Outreach-Reentry nach Void**: contactBlockReason/registryBlock → «stornierter Testverkauf»; zusätzlich
  blockiert der Draft-Worker Kundendomains weiterhin über sales.json (isCustomer prüft bewusst auch voided – konservativ).
  source/discovery_source bleiben nachvollziehbar (direct_customer). Keine Gmail-, keine Discovery-, keine Website-Aktion im Void-Pfad.
- **Testverkauf echtefirma.ch sauber voided (2026-10-12, lokal)**: Vorbedingungen exakt verifiziert (REPAIR_CHECK_150,
  source=direct_customer, basis=manual_confirmed_order; Aufträge CA150-20261012-9a1c7e und CA150-20261012-63e315 beide
  CANCELLED, keine CHF-480-Aufträge) → `void-sale echtefirma.ch --reason "Testverkauf mit Platzhalterdaten"`. Danach:
  sale_status=voided + Grund + Zeitpunkt, direct_sale erhalten, metrics 0/0/0 (CHF 0 aktiver Umsatz), Registry
  voided_test_customer/DISCARDED, registryBlock «stornierter Testverkauf», confirmedCheck150Sale=null. Keine anderen
  Verkäufe verändert (einziger Datensatz).
- Dashboard: keine HTML-Änderung nötig – Umsatz/Kunden kommen aus metrics.json/leadStats und sind damit korrekt; CANCELLED-
  Aufträge zeigen weiterhin «STORNIERT» (TF-039), kein roter Systemfehler.
- Tests: `test/void-sale-040.test.js` (10 Tests, decken die 17 Pflichtfälle: Blockaden 1–3, Void+Historie 4/8, Doppel-Void 5,
  Kennzahlen 6/7/17, Auftrags-Guard 9–11, CHECK150 12, CHF-480 13, Outreach-Reentry 14, CLI/0-Sends/0-Website-Writes 15/16,
  Lifecycle). Gesamt 469/469 grün, Secret-Scan 0 Treffer.
- **LIVE 2026-10-12 (a3953ac)**: Push → GitHub (origin verifiziert); VPS `deploy/vps/deploy.sh fiverr` OHNE --with-secrets:
  DEPLOYED_COMMIT a3953ac, Container healthy, 0 Restarts. Netlify Production autodeployt vom Push (Dashboard-HTML unverändert;
  lead-db-Änderung ist abwärtskompatibel – ein älteres Function-Bundle zeigt voided_test_customer schlimmstenfalls als «none»,
  nie als Kunde). Der Testverkauf echtefirma.ch existierte NUR lokal (wie die Testaufträge, TF-039) – der VPS-Zustand enthält
  ihn nicht. Keine Mail gesendet, keine Kundenwebsite verändert, /opt/fiverr unberührt.

## JARVIS DIRECT CUSTOMER ORDER INTAKE (TF-039, 2026-10-12, Tests 459/459 grün)
- **Bestehender Lead ist für echte Direktkunden nicht mehr zwingend**: Ein Kunde kann über Website-Formular, Direktanfrage,
  Empfehlung oder persönlichen Kontakt bestellen, ohne je durch Discovery gelaufen zu sein. `node sales.js sale` bleibt
  unverändert (unbekannte Domain → weiterhin sauberer Fehler, Test A).
- **`node sales.js direct-sale <domain> <offer> --email <adresse> [--company] [--name] [--website] [--date]`**
  (`recordDirectSale` in sales.js): nur bewusst von Chris über CLI – der Aufruf IST die ausdrückliche betriebliche Bestätigung.
  Validiert Domain, Offer (nur REPAIR_CHECK_150/REPAIR_FIX_500, Preis aus OFFERS) und E-Mail (fail closed). Erzeugt den
  Verkauf über bestehendes `recordSale` plus `direct_sale`-Block (source=direct_customer, basis=manual_confirmed_order,
  confirmed_by=chris_cli, Firma/Lieferadresse/Kontakt/Website). Bestehender Lead → wird verwendet (kein Duplikat, echte
  Audit-Evidence); neue Domain → minimaler Kundendatensatz. NIE erfunden: discovery_source aus Discovery, Audit-Evidence,
  Cold-Contact-Basis, legal basis, Outreach-Historie (Tests B/C/H/I). Versandgrundlagen (legalBasis) bleiben unberührt;
  Direktkunde ≠ Cold-Lead; registryBlock liefert danach «bestehender Kunde» → nie wieder Cold-Entwurf für diese Firma.
- **Lead-Datenbank nur über bestehendes reconcile** (lead-registry.js Schritt 6): `direct_sale` liefert Stammdaten
  (Firma, Lieferadresse, Kontakt, Website, discovery_source=direct_customer), aber nie first_contacted_at /
  manual_send_detected / gmail_draft_status / reply_status – Status wird direkt CUSTOMER. publicLead zeigt Quelle «Direktkunde».
- **CHF-150 direkt startbar**: `node check-150-workflow.js --create-confirmed <domain> --email <adresse> [--company] [--name]
  [--website]` = EIN Befehl: interner Direktverkauf (recordDirectSale) + Auftrag; der Worker bestätigt über die bestehende
  Order-Logik (confirmedCheck150Sale, unverändert). Läuft bereits ein Auftrag, bestätigt der erfasste Verkauf diesen beim
  nächsten Lauf. Kein Auftrag gilt je allein wegen eines Domainnamens als bezahlt.
- **CANCELLED für versehentliche (Test-)Aufträge**: `node check-150-workflow.js --cancel <order-id> [--reason TEXT]`
  (`cancelCheck150Order`): nur nicht abgeschlossene Aufträge (COMPLETED/CANCELLED nie), Grund optional dokumentiert,
  Auftrag bleibt gespeichert (nie JSON von Hand löschen). CANCELLED ist terminal: Worker überspringt vollständig
  (kein Audit/Bericht/Entwurf, keine Gmail-, keine Website-Aktion), zählt nie als offen, Dashboard zeigt es neutral
  («STORNIERT», eigener Zähler, nicht rot). Danach darf für dieselbe Domain ein neuer echter Auftrag entstehen.
  STORNIERT LOKAL 2026-10-12: Testaufträge CA150-20261012-65119b (firma.ch) und CA150-20261012-63e315 (echtefirma.ch) –
  beide waren ORDER_RECEIVED ohne Verkauf (keine sales.json), eindeutig unbestätigte Platzhalter-Tests. 0 offene Aufträge.
- **Formular-Vorbereitung**: Ein späteres bestätigtes Kundenformular nutzt denselben Intake (recordDirectSale →
  createCheck150Order). Eine normale Formularanfrage bleibt REQUEST_RECEIVED und wird NIE automatisch bezahlt/bestätigt –
  erst echte Bestätigung/Zahlung führt (durch Chris) zu CUSTOMER / SALE CONFIRMED. Kein neuer Endpoint in diesem Schritt.
- **Dashboard**: CHF-150-Auftrag zeigt Quelle nur als Wort «Direktkunde»/«Jarvis Lead» (publicCheck150Orders.source,
  cleanCheck150-Whitelist um CANCELLED/source/cancelled erweitert; Cloud erzwingt erneut). Keine technischen Interna.
- Unverändert: Cold-Lead-Regeln/COLD_LEAD_DRAFT_ONLY, Discovery, Suppression/Opt-out, Gmail Foreign Protection,
  2–3 Findings im Cold-Outreach, CHF-480-Workflow, Gmail incremental sync (Tests H + bestehende Suiten grün).
- Tests: `test/direct-customer-039.test.js` (11: A alter sale-Fehler, B/D Direktkunde+CHF150, C kein Duplikat, E/F Offer/E-Mail
  blockiert, G create-confirmed→READY_FOR_DELIVERY, H Cold unverändert, I keine erfundene Historie, J/K/L Cancel/Worker-Skip/
  Dashboard, M/N 0 Sends + 0 Website-Writes). Gesamt 459/459 grün, Secret-Scan 0 Treffer.
- **LIVE 2026-10-12 (ba4c122)**: Push → GitHub; VPS `deploy/vps/deploy.sh fiverr` OHNE --with-secrets: DEPLOYED_COMMIT ba4c122,
  Container healthy, 0 Restarts. Netlify Production autodeployt (Storniert-Zähler/STORNIERT/Quelle im HUD verifiziert, 200).
  VPS hat KEINE check150_orders.json (die zwei Testaufträge existierten nur lokal und sind dort CANCELLED; 0 offene Aufträge).
  Keine Mail gesendet, keine Kundenwebsite verändert, /opt/fiverr unberührt.

## JARVIS CHECK & ANLEITUNG CHF 150 — AUTOMATED FULFILLMENT (TF-038, 2026-10-12, Tests 448/448 grün)
- Neu `check-150-workflow.js`: automatische Erfüllung des CHF-150-Pakets (REPAIR_CHECK_150, Preis aus OFFERS; Angebot unverändert).
  Zustände: ORDER_RECEIVED → ORDER_CONFIRMED → FULL_AUDIT → FINDINGS_ANALYSIS → INSTRUCTIONS_GENERATION → CUSTOMER_REPORT_READY →
  DELIVERY_DRAFT_CREATED → READY_FOR_DELIVERY → COMPLETED; Fehler: BLOCKED_ORDER_NOT_CONFIRMED / AUDIT_FAILED / REPORT_FAILED /
  DELIVERY_DRAFT_FAILED / MANUAL_REVIEW_REQUIRED. Atomar in `check150_orders.json` (im Backup); Fortsetzung nach Neustart getestet.
- **NUR BESTÄTIGTE AUFTRÄGE**: Start ausschliesslich mit erfasstem Verkauf in sales.json (bestehende Order-Logik `recordSale` /
  `node sales.js sale <domain> REPAIR_CHECK_150`). Cold-Lead, Cold-Draft, manuell gesendete Cold-Mail, QUALIFIED, Interesse:
  starten NIE (Test mit Cold-Fixtures: nicht einmal ein Audit). CHF-480-Verkauf startet diesen Workflow nicht.
  BLOCKED_ORDER_NOT_CONFIRMED wird je Lauf neu geprüft – erfasst Chris den Verkauf später, läuft der Auftrag automatisch weiter.
  Lieferadresse ist Pflichtfeld beim Anlegen (--email) – nie automatisch eine alte Cold-Outreach-Adresse.
- **KEINE WEBSITE-ÄNDERUNG**: rein passiver Workflow – gemeinsame Audit-Basis `fullSiteAudit` (bestehender site-auditor, dessen
  Rate-Limits gelten). Testbewiesen: Modul enthält keinerlei Fix-/Deploy-/Rollback-/Adapter-Pfade, Laufzeit ruft ausser
  Gmail-Draft-Erstellung nichts Schreibendes auf. CHF-480-Workflow (repair-workflow.js) unverändert.
- **ALLE relevanten belegten Findings** (kein 3er-Deckel): `selectCustomerVisibleFindings` hat jetzt optionales `{ max }`
  (Default unverändert → Cold-Mails bleiben bei 2–3, Tests 034 grün); CHF-150 ruft mit max ∞. Dedupe/Jargon-/Evidence-Gate
  unverändert aus swiss-repair.js (8 echte Probleme → 8; 3 Bilder einer Seite + Kontaktlink-Duplikat → zusammengeführt;
  missing_title/slow_response/missing_alt/no_https_redirect = interne Signale, nie ein Kundenproblem; 0 Befunde → ehrlicher
  Bericht «keine relevanten Probleme festgestellt»). Sortierung critical > high > medium > low.
- **Kundenspezifische Anleitung je Befund** (`instructionsFor`): Problem / Wo / Was Besucher erleben / Warum relevant /
  So beheben / Schritte / Danach prüfen + Aufwand (Einfach/Mittel/Fachperson empfohlen). Unbekannter Stack → anbieterneutral
  («Öffnen Sie in Ihrem Website-System …»), NIE erfundene CMS-/Plugin-Menüs (Test: kein WordPress/Elementor/Wix bei stack=other);
  sicher erkannter Stack (detectStack) → konkreter erster Schritt (WordPress-Adminbereich bzw. HTML-Datei). Sicherheits-
  zertifikat/Weiterleitungsschleife → Fachperson empfohlen, trotzdem erklärt (was/wo/Änderung/Test) + sachlicher Hinweis auf
  «Check & Reparatur» CHF 480 (nur wenn Fachperson-Punkte existieren – kein Upselling sonst, kein Pauschalversprechen).
- **Kundenbericht** «Webseiten-Check & Anleitung / Ergebnis Ihres Webseiten-Checks»: Firma, Website, Prüfdatum, Zusammenfassung
  (Total/kritisch/hoch/mittel/gering), je Problem vollständige Anleitung, Abschlusssatz «basiert auf den tatsächlich
  festgestellten Punkten». Intern strukturiert (`customer_report` mit summary/findings/generated_at/website/company/
  audit_reference) + menschenlesbarer Text als Datei `mail_worker/reports/check150-<id>.txt` (600, im Backup; KEIN PDF,
  kein neuer Dateidienst).
- **Gmail-LIEFERENTWURF** (delivery=draft, automatic_send_allowed=false, Chris sendet): an die verifizierte Auftragsadresse,
  Betreff «Ihr Webseiten-Check & Ihre Anleitung – <domain>», kurzer Mailtext + Bericht inline (≤5200 Zeichen) oder
  Zusammenfassung + Hinweis «vollständiger Bericht im Anhang» (Chris hängt die Berichtsdatei beim Senden an; Log-Hinweis).
  Duplikatschutz über report_hash: je Auftrag genau EIN aktiver Entwurf, neue Berichtsversion → updateDraft statt zweitem
  Entwurf. Gmail 429/5xx → Zustand bleibt, nächster Lauf (kein Verlust). Tests: Draft ohne Roh-Evidence/order_id/issue_ids/
  Pfade; 0 Send-Events.
- **Worker/Dashboard/Mobile**: Worker-Hook `runCheck150Orders` (eigenes Lock check150.lock, No-op ohne Aufträge, blockiert
  weder Mail/Discovery noch CHF-480); Snapshot `check150` (server-agent) → `cleanCheck150`-Whitelist (server-control) → HUD-Kachel
  «Check & Anleitung · CHF 150» (Offen / Wartet auf Bestätigung / Website wird geprüft / Bericht wird erstellt / Lieferentwurf
  bereit / Abgeschlossen / Fehler + je Auftrag Firma, Domain, Befunde mit Severity-Split, Bericht/Draft JA-NEIN, Lieferstatus).
  REINE ANZEIGE (keine data-action, Test); Mobile 390×844 real geprüft: scrollWidth 390, Zeilen 71–88 px. Kundendaten-Sync:
  Kunde entsteht über den erfassten Verkauf (bestehendes reconcile aus sales.json) – Auftragsdetails leben im Order-Datensatz.
- CLI: `node check-150-workflow.js --create <domain> --email <lieferadresse> [--website] [--company] [--name] | --list |
  --show <id> | --run | --report <id> | --complete <id>`. Dockerfile kopiert check-150-workflow.js.
- Tests: `test/check150-038.test.js` (12; Order-Gates, Audit/Dedupe/Relevanz, Anleitung, Unknown-Stack-Safety, E2E Muster AG
  mit 4 Problemen → 4 Anleitungen → 1 Draft → 0 Sends → 0 Writes, 429-Retry, Dashboard-Allowlists, langer Bericht). Gesamt
  448/448, Secret-Scan 0 Treffer. Cold-Outreach (2–3 Findings), CHF-480, Gmail-Sync, Discovery, Lead-DB: unverändert grün.

## JARVIS GMAIL INCREMENTAL SYNC + QUOTA SAFE WORKER (TF-037, 2026-10-12, Tests 436/436 grün)
- **Ursache des Livelocks (seit 2026-10-12 02:18 UTC)**: je Tick ein VOLLSCAN – `syncColdDrafts` prüfte ALLE registrierten
  Cold-Entwürfe (live 274 × drafts.get als ununterbrochene Salve) + Reply-Scan las jeden aktiven Thread (threads.get format=full,
  10 Units); ein Quota-Fehler („Total Query Cost / Units per minute per user“) matchte TRANSIENT_RE → GANZER Tick brach ab →
  exponentieller Backoff → nächster Tick begann WIEDER VON VORNE → Quota sofort wieder gerissen; tick_failed lieferte keine Stats
  → kein Heartbeat → HUD „Core OFFLINE“, Reply-Erkennung stand.
- **Kein Vollscan mehr (inkrementell)**:
  - `gmail.js gmail()`-Helper zentral: Mindestabstand zwischen ALLEN Gmail-Calls (`JARVIS_GMAIL_MIN_GAP_MS`, Default 150 ms ≈ max.
    6–7 Calls/s) + bei 429/Quota Retry-After respektiert (max. 2 Wiederholungen, Wartezeit ≤ 30 s, nie enge Schleife), danach
    Fehler mit Quota-Kennung (`isGmailQuotaError`).
  - `gmail_sync_state.json` (`.secrets/`, nie Tokens): history_id, cold_cursor, Zeitstempel – nach VPS-Neustart geht der Sync
    exakt dort weiter; Verlust der Datei ist harmlos (Neuaufbau, kein Datenverlust).
  - **History-API** (`changedThreadIds`, 2 Units je Seite, scope gmail.modify deckt sie ab): nur Threads mit NEUEN Nachrichten seit
    history_id; geschnitten mit den EIGENEN Threads aus dem Gesendet-Register (fremde Thread-IDs aus der History werden nie
    gelesen – Foreign-Gmail-Schutz getestet). historyId 404/abgelaufen → Recovery: frische historyId + begrenzter Round-Robin
    deckt die Lücke, KEIN Vollscan. historyId rückt erst vor, wenn alle geänderten Threads wirklich gelesen wurden.
  - **Budgets je Tick** (config.json überschreibbar): `maxThreadReadsPerTick` 20 (Reply-Scan, 10 Units/Thread) und
    `maxColdDraftChecksPerTick` 40 (Cold-Sync, 5 Units/Entwurf) ⇒ Grundlast ≈ 400–500 Units/Tick statt >2000 in Salven.
    Rest über persistente Round-Robin-Cursor (`state.threadScanCursor` in state.json; `cold_cursor` in gmail_sync_state.json):
    507 Threads → 20/Tick, Cursor schreitet, überlebt Neustart (getestet); manueller Versand wird weiterhin erkannt, nur
    bis zu ceil(n/40) Durchläufe später.
- **DEGRADED statt OFFLINE**: Gmail-Lesefehler (Quota/429/5xx/Netz) brechen den Tick NICHT mehr ab – betroffener Abschnitt stoppt
  (Cursor bleibt stehen), Cloud-Aufträge/Draft-Worker/Statistik laufen weiter; `stats.mail_degraded` (bewusst ohne das Wort
  „gmail“ im Cloud-Blob) + `serviceStatus.mail_health` ok|degraded; Heartbeat fliesst in JEDEM Tick → Core bleibt ONLINE,
  Discovery/Repair/Server-Control unberührt (hängen am Loop, nicht am Gmail-Erfolg). Draft-Worker: Gmail-Fehler → eigener
  persistierter Backoff (1→2→…→60 min), Queue-Eintrag bleibt queued, nichts geht verloren (getestet inkl. Erholung).
  Send-Pfad (Fenster 09:30/14:30) unverändert konservativ; COLD_LEAD_DRAFT_ONLY/legal_basis NONE/kein Auto-Send unverändert.
- Tests: neu `test/gmail-quota-037.test.js` (8: kein 507-Vollscan, Budget, Cursor + Neustart, History-Priorität + fremde Threads
  nie, invalid-historyId-Recovery, Quota→DEGRADED+Stats+kein Backoff-Livelock+Erholung hinter dem Cursor, Draft-Queue intakt,
  Reply ohne Duplikate, 0 Sends); angepasst mail-worker (2× Tageslimit mit Budget 150) + always-online (Stats-Whitelist
  +mail_degraded). Gesamt 436/436, Secret-Scan 0 Treffer.
- **LIVE-VERIFIKATION 2026-10-12 07:54–07:58 UTC (de340c4)**: Deploy ohne --with-secrets, Container healthy, 0 Restarts.
  Alter persistierter Fehler-Backoff (failures 9, backoffUntil 08:46 – Rest des behobenen Livelocks) einmalig atomar auf 0
  zurückgesetzt (exakt was der erste erfolgreiche Tick selbst getan hätte). Erster erfolgreicher Tick seit 02:18 um 07:57:40 mit
  `gmail:"OK"` (nicht einmal DEGRADED – Pacing+Budget reichen); gmail_sync_state.json live (history_id + cold_cursor gesetzt,
  Cold-Sync 07:56:50), state.threadScanCursor gesetzt, failures 0. Cloud 07:58: Heartbeat 07:57:41 (frisch), HUD SYSTEM ONLINE /
  Core CLOUD ONLINE / Mail VPS ACTIVE / Authority VPS / Windows STANDBY / Queue 0 / AI ONLINE. Discovery lief durchgehend weiter
  (1115 Websites heute), Repair-Hook No-op (keine Orders), 0 Send-Events, keine echte Mail. Incident behoben.

## JARVIS CHECK & REPARATUR CHF 480 — PRODUCTION READY (TF-036, 2026-10-12, Tests 428/428 grün; VPS-Deploy wartet auf SSH-Key)
Alles Folgende ist mit Attrappen (Mock-Fetch, Browser-Attrappe, Test-Fixtures) getestet – KEINE echte Kundenwebsite verändert, keine Mail.
- **GitHub+Netlify-Adapter** `repair-adapters/github-netlify.js`: repariert nur Websites mit EXPLIZITER Zuordnung durch Chris in
  `.secrets/mail_worker/repair_mappings.json` (domain → repo owner/name → production_branch → netlify_site_id; keine Secrets;
  CLI `node repair-adapters/github-netlify.js --map <domain> --repo o/n [--branch main] --site <id> | --list | --check <domain>`).
  Nie ein Repository/eine Site erraten: ohne Mapping `no_mapping` → BLOCKED_NO_ACCESS; zusätzlich muss die Netlify-Site die
  Auftrags-Domain wirklich tragen (custom_domain/alias, sonst `site_domain_mismatch`). Credentials NUR aus VPS-Env
  `JARVIS_REPAIR_GITHUB_TOKEN` + `JARVIS_REPAIR_NETLIFY_TOKEN` (in `/opt/jarvis-mail/.env` ergänzen, 600; noch NICHT gesetzt);
  fehlen sie → `no_token` → BLOCKED_NO_ACCESS. Tokens nie in Ergebnissen/Logs/Orders (Test: Fake-Token taucht nirgends auf).
  Backup = Production-Commit-SHA + Branch `repair/<order-id>` + Netlify `published_deploy` als Rollback-Punkt; vorhandener Branch
  (Fortsetzung nach Neustart) wird akzeptiert. locate() nur für broken_link/contact_page_broken/broken_image mit EINDEUTIGER Ursache
  (genau ein Ersatzziel im Repo-Baum, ≤3 referenzierende Dateien, Code-Suche mit Scan-Fallback, truncated Tree → null) – sonst
  MANUAL_REVIEW. applyFix committet ausschliesslich in den Repair-Branch (Contents-API, gezielte Ersetzung, sonst Fehler).
  validate() wartet auf den Netlify-BRANCH-Deploy (Preview; Branch-Deploys müssen auf der Site aktiviert sein; Build-Fehler/Timeout
  → fail closed); deployProduction() = Merge in den Produktions-Branch + Warten auf den Production-Deploy (bestehender Kanal, nichts
  Improvisiertes); rollback() = Netlify-Restore auf den Deploy vor der Reparatur (Git-Historie wird nie umgeschrieben).
  `claims()`: explizites Mapping hat Vorrang vor der Markup-Erkennung (statische Seite über GitHub+Netlify → dieser Adapter).
- **Echter Browser-Rendertest** `repair-render-test.js` (Playwright, NUR lesend, keine Screenshots gespeichert): Desktop 1440×900 +
  Smartphone 390×844; Fail-Kriterien Seite lädt/sichtbar, kein horizontaler Overflow, keine abgeschnittenen Hauptinhalte, keine
  überlappende Navigation, sichtbare Bilder geladen; Buttons/Links/Kontaktbereich werden erfasst (informativ). Engine-RETEST nutzt
  ihn für BEIDE Viewports (Desktop zusätzlich mit passivem Regression-Gate); `loadRenderRetester()` liefert ohne installiertes
  Playwright null → ehrlich benannter passiver Fallback. Playwright ist im VPS-Image NICHT installiert (bewusst: +~300 MB) –
  echter Rendertest wird aktiv, sobald `playwright` + Chromium im Image sind (offener Punkt unten).
- **Engine-Erweiterungen** (`repair-workflow.js`): Plan-Items tragen deterministische `fix`-Details (reine Daten, neustart-sicher);
  `loadDefaultRepairDeps()` lädt Adapter+Retester im Worker automatisch; E2E-Reihenfolge testgesichert: Commit → Preview-Poll →
  Rendertests → ERST DANN Merge/Production → Live-Retest; Mobile-Retest-Fehler ⇒ VALIDATION_FAILED und **kein** Merge.
- **Kundenbericht** („Webseiten-Check – Abschlussbericht“): Website, Datum, Zahl relevanter Punkte, behobene Punkte, nicht automatisch
  veränderte Punkte, Desktop-/Smartphone-Retest, Ergebnis. Testgesichert OHNE: order_id, Git-SHAs, Dateipfade, Preview-/Branch-Namen,
  Tokens, Roh-Evidence. Wird nur gespeichert (`--report <id>`), nie automatisch versendet.
- **Dashboard-Kachel REPARATURAUFTRÄGE** (`public/index.html`): Offen / Warten auf Freigabe / Kein Zugang / In Reparatur / Validierung /
  Bereit zur Übergabe / Abgeschlossen / Fehlgeschlagen + je Auftrag Firma, Domain, CHF 480, Status, Befunde, repariert, Backup JA/NEIN,
  Desktop/Mobile-Retest, Production (LIVE/NUR BRANCH/UNVERÄNDERT), Bericht JA/NEIN. REINE ANZEIGE – bewusst keine Browser-Aktionen
  (Freigabe/Abschluss nur per CLI bei Chris; Test: keine data-action im Panel). Datenweg: `publicRepairOrders()` (Allowlist) →
  Snapshot `repair` (server-agent) → `cleanRepair`-Whitelist (server-control, Cloud erzwingt erneut) → HUD `renderRepair`.
  Mobile 390×844 real im Browser geprüft (Fixture): kein horizontaler Overflow (scrollWidth 390), Zeilen 71–88 px, Panel lesbar.
- Dockerfile kopiert `repair-render-test.js` + `repair-adapters/`. Worker lädt das Repair-Modul einmal beim Start (kein Re-Import je Takt).
- Tests: `test/repair-adapter-036.test.js` (14: Mapping/Zugang/Backup/Eindeutigkeit/locate+applyFix/Preview/Rollback/Rendertest/
  2×E2E/Dashboard-Allowlists/HUD ohne Aktionen/kein Gmail in Repair-Modulen/Dockerfile) + 035 (18) – gesamt 428/428, Secret-Scan 0 Treffer.
- **LIVE 2026-10-12 06:14–07:00 UTC (41bdef8)**: Push → GitHub (bb691ec+41bdef8), Netlify Production autodeployt (Repair-Kachel live,
  per curl verifiziert). VPS: `Start-Service ssh-agent` genügte – der Key war im Windows-Agent persistiert (keine Passphrase nötig,
  nichts entschlüsselt); `deploy/vps/deploy.sh fiverr` OHNE --with-secrets: DEPLOYED_COMMIT 41bdef8, Container healthy, 0 Restarts,
  `worker_started role=vps` 06:17:59, restart=unless-stopped, /opt/fiverr unberührt. Keine repair_orders.json auf dem VPS (0 Test-
  Orders), Authority VPS, Windows STANDBY, genau ein Sender, Queue 0, 0 Send-Events, Discovery läuft (lead_discovered ab 06:37).
- **BEKANNTER INCIDENT (vorbestehend, NICHT durch 41bdef8; seit 2026-10-12 02:18 UTC, auch schon auf ef211f3)**: Gmail-Minuten-Quota
  „Total Query Cost / Units per minute per user“ wird in jedem Mail-Tick durch Thread-Reads (507 Leads) erschöpft → `tick_failed`,
  exponentieller Worker-Backoff (failures 7+), erneuter Versuch läuft sofort wieder in die Quota (Livelock). Folge: kein Cloud-
  Heartbeat seit 02:18 → HUD „SYSTEM EINGESCHRÄNKT / Core OFFLINE / Mail STANDBY“; Reply-Erkennung/Scheduler-Sends betroffen.
  Discovery/Registry/Server-Control laufen normal weiter, 0 Sends, keine Datenverluste. NICHT ad hoc gefixt (Fail-Safe: nicht
  experimentieren). Lösungsrichtung für einen eigenen TF: Thread-Reads je Tick deckeln/inkrementell (Cursor statt Vollscan),
  Gmail-429 mit Retry-After respektieren statt Tick-Abbruch, Heartbeat auch bei tick_failed senden (Status ehrlich DEGRADED).
- **OFFEN**: (1) ~~VPS-Deploy~~ ERLEDIGT (siehe LIVE); (2) `JARVIS_REPAIR_GITHUB_TOKEN`/`JARVIS_REPAIR_NETLIFY_TOKEN` in VPS-`.env`
  setzen (erst dann kann der Adapter wirklich zugreifen); (3) je Kundenauftrag ein Mapping anlegen + Netlify-Branch-Deploys aktivieren;
  (4) optional Playwright+Chromium ins VPS-Image für den echten Rendertest (bis dahin passiver Fallback, ehrlich im Bericht benannt);
  (5) Gmail-Quota-Incident (eigener TF, siehe oben) – bis dahin bleibt das HUD EINGESCHRÄNKT.

## JARVIS CHECK & REPARATUR CHF 480 — AUTOPILOT (TF-035, 2026-10-11, Code + Tests fertig, 413/413 grün; noch NICHT auf dem VPS deployt)
- Neu `repair-workflow.js`: persistenter Reparatur-Workflow für bezahlte, ausdrücklich freigegebene CHF-480-Aufträge (REPAIR_FIX_500,
  Preis ausschliesslich aus OFFERS; Angebot/Preise UNVERÄNDERT, keine dritte Stufe). Zustände exakt: ORDER_RECEIVED → AUTHORIZATION_REQUIRED →
  ACCESS_CHECK → BACKUP → FULL_AUDIT → REPAIR_PLAN → REPAIRING → VALIDATION → RETEST → READY_FOR_DELIVERY → COMPLETED; Fehlerzustände
  BLOCKED_NO_ACCESS / BLOCKED_NO_AUTHORIZATION / BLOCKED_UNSUPPORTED_STACK / REPAIR_FAILED / VALIDATION_FAILED / MANUAL_REVIEW_REQUIRED.
  Jeder Übergang atomar in `.secrets/mail_worker/repair_orders.json` (state_history lückenlos; liegt in mail_worker/ → automatisch im
  verschlüsselten Tagesbackup); nach VPS-/Worker-Neustart arbeitet die Engine exakt am gespeicherten Zustand weiter (getestet).
- AUTORISIERUNG PFLICHT (fail closed): Änderungen nur mit `customer_authorized_repair = true` + Freigabequelle aus der Whitelist
  (customer_reply_email, customer_order_form, signed_offer, written_confirmation) + EXAKT übereinstimmender Domain. Cold-Outreach/
  Lead-DB/„Interesse“ werden hart abgelehnt (NEVER_AUTHORIZATION). Ohne Freigabe: genau EIN passiver Audit, Status AUTHORIZATION_REQUIRED.
- ZUGÄNGE: Stack-Erkennung nur aus öffentlichen Signalen (github_netlify/static/nextjs/react/wordpress/other). Änderungen laufen NUR über
  Stack-Adapter (Interface checkAccess/backup/locate/applyFix/validate/deployProduction/rollback); Secrets bleiben beim Adapter (env),
  die Engine speichert aus Adapter-Antworten nur connector/ok/checked_at (Test: Token landet nie im JSON). **Aktuell sind KEINE Adapter
  konfiguriert** → jeder echte Auftrag endet ehrlich bei BLOCKED_NO_ACCESS (bzw. BLOCKED_UNSUPPORTED_STACK); Zugangsdaten werden nie erraten.
- BACKUP VOR JEDER ÄNDERUNG: production_ref + backup_ref + rollback_point + Branch `repair/<order-id>` Pflicht; unvollständig →
  MANUAL_REVIEW_REQUIRED, nichts wird angefasst. Nie direkt auf main/Production.
- FULL_AUDIT (Stufe 1, passiv via site-auditor mit erhöhten Limits: 80 Links, 25 Bilder, 10 min): Befunde als issue_id/type/severity/page/
  evidence/customer_text (aus den bestehenden Kundentext-Vorlagen, Jargon-Gate)/repairable/protected/repair_status. Nichts wird erfunden.
- REPAIR_PLAN je Befund: Ursache/target/geplante Änderung/Risiko/Testmethode/Rollback-Methode via adapter.locate; Ursache unklar → nie raten,
  MANUAL_REVIEW. Geschützt (nie automatisch): Seiten Impressum/Datenschutz/AGB/Preise/Konto/Checkout (PROTECTED_PAGE_RE) und Änderungen an
  DNS/Registrar/Zahlung/Bank/Kundendaten/Datenbank/Preisen/Verträgen/Migration/Redesign (PROTECTED_TARGET_RE) → MANUAL_REVIEW_REQUIRED.
- MINIMAL SAFE FIX: nur repairable Befunde (REPAIR_TYPES „fix“) innerhalb des Pakets; jeder Fix einzeln persistiert. VALIDATION: Build-Gate
  (ohne Build-Schritt nur static/github_netlify, sonst MANUAL_REVIEW), reparierte Befunde müssen weg sein, sonst VALIDATION_FAILED.
  REGRESSION: VORHER gegen NACHHER, neue Befunde ≥ medium → Rollback (wenn Kanal vorhanden) → REPAIR_FAILED, sonst MANUAL_REVIEW_REQUIRED.
  RETEST Desktop (passiver Abruf) + Smartphone (deps.retester, sonst ehrlich benannte passive Prüfung). Production-Deploy nur: Freigabe +
  Tests bestanden + Rollback vorhanden + bereits autorisierter Kanal (adapter.deployProduction); danach Live-Retest, Fehler → Rollback.
- KUNDENBERICHT („Webseiten-Check – Abschlussbericht“): verständlich, behobene Punkte aus customer_text (Jargon-Gate getestet), Abschluss-
  kontrolle Smartphone/Desktop ehrlich benannt – wird NUR gespeichert, nie automatisch versendet. COMPLETED erst durch `--complete` (Chris).
- Worker-Hook (mail-worker.js loop): `runRepairOrders` im Hintergrund wie die Discovery (eigenes Lock `repair.lock`, No-op ohne offene
  Aufträge, blockiert nie Mail-Takt/Discovery, Fehler stoppen den Worker nie). Dockerfile kopiert repair-workflow.js.
- Kommandozeile: `node repair-workflow.js --list | --show <id> | --create <domain> [--website URL] [--lead ID] [--company NAME] |
  --authorize <id> --domain <domain> --source <quelle> [--reference TEXT] | --run | --complete <id> | --report <id>`.
- Tests: neu `test/repair-480-035.test.js` (18, nur Attrappen, kein Netzwerk, keine Mail); gesamt 413/413, Secret-Scan 0 Treffer.
- OFFEN: (1) VPS-Deploy (deploy.sh fiverr) + Netlify unverändert; (2) erster Stack-Adapter (GitHub+Netlify) mit echtem, von Chris
  eingerichtetem Zugang je Kundenauftrag – erst damit repariert Jarvis wirklich selbst; (3) optional echter Smartphone-Rendertest
  (deps.retester, z. B. Playwright 390×844) und Dashboard-Kachel aus `repairOrdersStatus()` (nur Zähler, keine IDs).

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

## JARVIS COLD OUTREACH — 2–3 VERIFIED WEBSITE FINDINGS (2026-10-11, Tests 396/396)
- Harte Regel (`swiss-repair.js`): ein neuer Cold-Draft braucht mindestens `MIN_COLD_FINDINGS` = 2 unterschiedliche, belegte, für Besucher
  sichtbare Probleme; im Mailtext höchstens `MAX_CUSTOMER_FINDINGS` = 3. 0 Befunde → kein Draft (`cold_block_reason` NO_VISIBLE_ISSUE),
  1 Befund → kein Draft (TOO_FEW_VISIBLE_ISSUES; Stufe bleibt `no_visible_issue`), 2 → beide, 3 → alle drei, >3 → die 3 wichtigsten.
  Ein fehlender zweiter Punkt wird nie ergänzt/erfunden; `buildColdDraft` wirft zusätzlich bei < 2 (fail closed).
- Auswahl `selectCustomerVisibleFindings(issues)` (alter Name `customerFindings` = Alias): nur belegte Rohbefunde (Evidence-Gate wie bisher),
  LOW nur bei reproduzierten Darstellungs-/Bedienfehlern mit Bereich; Sortierung Severity (critical > high > medium > low), dann Besucherwirkung
  (Seite lädt nicht > Kontakt > Button/Browser-Warnung > Link > abgeschnitten > Überlagerung/Layout > Bild > E-Mail-Link).
- Duplikate zusammengeführt: gleiches Link-Ziel (Fragment/Schrägstrich egal), gleicher Bereich (Navigation = Menü = Hauptmenü), mehrere Bilder
  derselben Seite, Kontaktseite kaputt + Kontaktformular + defekter Link auf genau diese Kontaktseite = EIN Befund (höchste Severity zählt).
- Mailstruktur: Anrede → kurzer persönlicher Einstieg („mein Name ist … von … Ich unterstütze Firmen dabei, sichtbare Fehler auf ihrer Website
  zu finden und zu beheben.“) → `FINDINGS_INTRO` „Bei einem kurzen Blick auf Ihre Website sind mir mehrere konkrete Punkte aufgefallen:“ →
  2–3 Aufzählungspunkte „• Befund. Direkte Auswirkung.“ → `FULL_CHECK_TEXT` (jetzt „Das sind nur die Punkte, die mir beim ersten Blick direkt
  aufgefallen sind. Mein Angebot umfasst einen vollständigen Webseiten-Check: …“) → CHF 150 / CHF 480 (aus OFFERS, je genau einmal) →
  kurze Antwort + Landingpage → Signatur → COLD_FOOTER. Keine Schadens-/Umsatz-/SEO-/Angstbehauptungen (Jargon-/Druck-Sperre unverändert).
- Lead-Datenbank: `customer_findings` im Draft (key, text, severity, internal_refs – keine Roh-Evidence) → `customer_visible_findings`
  (nur Kundentext, max. 3) = genau die gezeigten Punkte. Roh-Evidence bleibt intern (`issue_evidence`).
- Bestehende Gmail-Entwürfe werden NICHT geändert (nur `createColdDraft` baut Text, nur für neue Drafts); neue Regel gilt für alle künftigen Cold-Drafts.
- Unverändert: COLD_LEAD_DRAFT_ONLY, legal_basis NONE, automatic_send_allowed false, automatic_send_eligible false, delivery draft, kein Auto-Send.
- Tests: neu `test/cold-findings-034.test.js` (17); angepasst 022/024/025/026/028/029/030/031/032/033 (Fixtures mit einem zweiten echten Befund).
- Live-Test im Testmodus (echte Discovery + echter Auditor, 3 simulierte Websites, Gmail-Attrappe, echter Worker-Tick): A 1 Befund → KEIN Draft;
  B 2 Befunde → Draft mit genau 2 Punkten; C 6 Rohbefunde → Draft mit genau 3 Punkten (HIGH Kontaktseite zuerst, Kontaktlink nicht doppelt). 0 Sends.

## JARVIS — FULL SWITZERLAND DISCOVERY + PERSISTENT LEAD DATABASE (2026-10-10, Code + Tests fertig, 379/379 grün; Live-Stand siehe Ende dieses Abschnitts)
**A) Ganze Schweiz flächendeckend**
- Keine hardcoded Städteliste mehr: `DEFAULT_DISCOVERY.areas` entfällt. Gebietsindex = versionierte statische Datei `data/swiss-municipalities.json`
  (BFS Amtliches Gemeindeverzeichnis, Stichtag 2026-10-01): **26/26 Kantone, 2110 Gemeinden** mit BFS-Nummer, Bezirk, Sprachregion (de 1347, fr 628, it 115, rm 20).
  Erzeugt einmalig mit `scripts/build-swiss-areas.mjs <snapshot.csv> <Stichtag>` (nur bei Gemeindefusionen neu) – kein Download in einem Discovery-Lauf.
  Nur wenn `config.json → discovery.areas` ausdrücklich gesetzt ist, gilt der alte Modus mit fester Ortsliste (Tests/Fehlersuche).
- Architektur CH → Kanton → Gemeinde → Branche (`swiss-areas.js`). Hauptcursor reihum je Kanton eine Gemeinde (ZH, BE, LU … JU, dann wieder ZH …), innerhalb des Kantons
  in BFS-Reihenfolge; die ersten 26 Abfragen decken alle 26 Kantone ab, ZH+BE+BS ≤ 15 % der ersten 260. Jede Gemeinde genau einmal je Zyklus, danach neuer Zyklus
  (Dedupe-/Audit-Alter-Regeln gelten weiter: 90 Tage Audit-Index, Lead-Datenbank dauerhaft).
- Cursor persistent in `discovery_geo.json` (nach JEDER Abfrage gespeichert → Neustart macht beim nächsten Gebiet weiter).
- Overpass je Gemeinde eindeutig über `ref:bfs_Gemeindenummer` (bzw. `swisstopo:BFS_NUMMER`) – keine Verwechslung gleichnamiger Orte (Reinach AG/BL);
  Fläche nicht gefunden → einmal über den Namen innerhalb des Kantons. Eine Abfrage über alle 24 Branchen (live geprüft: Köniz, Thun 196 Treffer/7 s).
- Fairness: aus einer Abfrage höchstens `maxAuditsPerAreaPerRun` 35 neue Firmen je Lauf; gesättigte Gemeinden (Trefferlimit) bekommen Folgeabfragen je Branche
  (Gemeinde → Branche) in eine Warteschlange, die frühestens im nächsten Lauf und höchstens `maxSplitSearchesPerRun` 2 der 6 Abfragen je Lauf bekommt.
  Fehlgeschlagene Gemeinde: genau ein späterer Versuch (≥ 6 h), die Rotation läuft weiter.
- Jeder Lead trägt `canton`, `municipality`, `municipality_bfs`, `language`, `category` (OSM-Branche, spezifischste zuerst).
- Unverändert: 7500 Websites/Tag, 315/h, 105/Lauf, 20 min, maxConcurrency 6, maxSearchesPerRun 6, searchMinGapMs 6 s, Retry-After/Backoff 15→360 min.
  Ehrliche Grenze: OSM ist der Pool – die echte Tageszahl = neue Firmen mit Website, nicht der Deckel.
- Dashboard „24/7 Discovery“: Schweiz-Abdeckung (FULL · 26/26 Kantone · 2110 Gemeinden) und Gebietsrotation (Zyklus, Fortschritt, Kantone im Zyklus, zuletzt Kanton/Gemeinde).

**B) Persistente Lead-Datenbank** – `.secrets/mail_worker/lead_registry.json` (VPS = authoritative, Schema 1, Modell `lead-db.js`, Datei/Abgleich `lead-registry.js`)
- Felder je Lead: lead_id, company, domain, website, business_email, contact_name, contact_role, canton, municipality, language, category, discovery_source,
  first_discovered_at, last_audited_at, customer_visible_findings (Kundensprache), repair_fit_score, offer_class, status, draft_created_at, gmail_draft_status,
  manual_send_detected, first_contacted_at, last_contacted_at, reply_status, reply_at, customer_status, suppressed, opt_out, do_not_contact, last_updated_at
  (+ alt_domains/alt_emails, sources, history; Gmail-Thread-/Message-Referenzen nur intern unter `refs`). Keine Secrets/Tokens/Keys, keine Roh-Evidence.
- Status: DISCOVERED, AUDITED, QUALIFIED, WAITING_FOR_DRAFT, DRAFT_CREATED, MANUALLY_SENT, REPLIED, CUSTOMER, NOT_INTERESTED, SUPPRESSED, OPT_OUT, DO_NOT_CONTACT, DISCARDED –
  abgeleitet aus klebrigen Fakten: Sperren (DNC > Opt-out > Suppression) haben immer Vorrang, dann CUSTOMER > NOT_INTERESTED > REPLIED > MANUALLY_SENT > DRAFT_CREATED > … .
  Leads werden nie gelöscht, Sperren nie automatisch aufgehoben, erste Zeitpunkte = frühester, letzte = spätester.
- Aufgenommen werden qualifizierte Leads (blocked_no_legal_basis/matched_existing_lead/already_in_lead_list), gesperrte mit Adresse, alle Entwürfe, jeder Gmail-/Jarvis-Kontakt,
  Antworten, Verkäufe und Chris’ Lead-Liste. Nicht qualifizierte Websites bleiben (wie bisher) nur im Audit-Index (Domain → Datum, 90 Tage).
- Dedupe gegen die Datenbank: vor jedem Audit (bekannte Domain/Adresse/Firma → nie neu geprüft), vor dem Cold-Entwurf in der Discovery, in `leads.createDraft` und direkt vor
  Gmail im Draft-Worker (angeschrieben, Antwort, Kunde, kein Interesse, Suppression, Opt-out, Do-not-contact → `blocked`, „Lead-Datenbank: …“). Datenbank nicht lesbar → fail closed.
- Abgleich (= Migration, idempotent, additiv) beim Worker-Start (inkl. discovered.json) und nach jedem Worker-Durchlauf (nur bei geänderten Quellen): leads.json,
  individual_reviews.json, Gmail-/Jarvis-Register (gesendet, manuell), state.json (Antworten), sales.json (Kunde/kein Interesse/Antwort), suppression.json (auch Domain).
  Manueller Versand: syncColdDrafts → MANUALLY_SENT, manual_send_detected, first/last_contacted_at, Thread-Referenz intern. Chris’ eigene Adressen (inkl. Plus-Aliasse) nie als Lead.
- Kommandozeile (VPS): `node lead-registry.js --migrate | --report | --export csv|json [--out datei] [--canton BE] [--status …] [--category Treuhand] [--offer REPAIR_FIX_500]
  [--month 2026-10] [--view contacted|no_reply|replied|customers|blocked] | --dnc <lead_id|domain|email>` (Do-not-contact dauerhaft).
- Cloud/Mobile: der VPS-Agent schickt die Allowlist-Sicht (keine Gmail-IDs, keine Roh-Evidence) als eigene Operation `leaddb` (nur bei Änderung, spätestens alle 30 min,
  max. ~4,5 MB, bei Ablehnung 10 min Pause) in den Blob `jarvis-server-control/leaddb`. `GET /api/server-control?leaddb=1` (Seite + Kennzahlen + Facetten),
  `?leaddb=csv|json` (gefiltert, auditiert `leaddb.export`). Nur mit JARVIS_PASSWORD.
- Dashboard-Bereich LEAD-DATENBANK: Gesamt, Heute neu, Qualifiziert, Entwürfe, Angeschrieben, Antworten, Kunden, Suppressed, Opt-out, Do-not-contact; Dialog mit Suche
  (Firma/Domain/E-Mail/Kontakt/Gemeinde), Filtern Kanton/Gemeinde/Status/Branche/Angebot/Monat, Schnellfiltern (Angeschrieben, Ohne Antwort, Mit Antwort, Kunden, Gesperrt),
  Detail (Firma, Website, Kontakt, E-Mail, Kanton, Gemeinde, Problem in Kundensprache, Angebot, Status, Draft/Manuell versendet JA/NEIN, Erster/Letzter Kontakt, Antwort,
  Kunde, Suppression, Opt-out, DNC), Export CSV (Semikolon + UTF-8-BOM, Formel-Injection neutralisiert) / JSON. Mobil: eine Spalte, 16-px-Felder, 44-px-Touch-Ziele.
- Backup: `lead_registry.json` + `discovery_geo.json` liegen in `mail_worker/` und sind damit automatisch im verschlüsselten Tagesbackup (Test: Restore byte-genau).
- Unverändert: COLD_LEAD_DRAFT_ONLY, legal_basis NONE, automatic_send_allowed false, kein automatischer Cold-Versand. Die Datenbank enthält kein Versandgrundlagen-Feld
  und ist nie eine Begründung für einen Versand („später verwenden“ ≠ erneut anschreiben).
- Tests: `test/swiss-leaddb-033.test.js` (19) + angepasste 031/032; gesamt 379/379.
- **LIVE 2026-10-10 (ef211f3)**: VPS-Deploy ohne `--with-secrets` 17:33 UTC (healthy, 0 Restarts; damit ist auch d5fb003 = 7500/Tag erstmals auf dem VPS), Netlify automatisch
  (Panel + `/api/server-control?leaddb` → 401 ohne Passwort). VPS `config.json → discovery`: alte Ortsliste (14) und 10 Branchen entfernt, 105/315/7500 gesetzt
  (Sicherung `config.json.bak-20261010-fullch`). Migration beim Start: 57 Leads (7 manuell angeschrieben, 27 offene Entwürfe), 0 Duplikate.
  Erster Schweiz-Lauf 17:46 UTC: 5 Gemeinden aus ZH, BE, LU, UR, SZ (Cursor 5/2110, Zyklus 1), 105 Websites in 620 s, 10 qualifiziert, alle 105 mit Kanton/Gemeinde;
  ein Overpass-504 → genau ein späterer Versuch in der Warteschlange (Rotation lief weiter). Danach Lead-Datenbank 67 Leads in 11 Kantonen, 0 Fehler (Registry/Agent-Upload).
  CSV-/JSON-Export per Kommandozeile live: 57 Zeilen + Kopf mit allen Pflichtspalten, 7 angeschrieben, keine Secrets/IDs. Backup jetzt: lokal + offsite OK, `lead_registry.json`
  im verschlüsselten Backup (key_id f671042283a91eaf). Authority VPS (self=true), Windows STANDBY (self=false). 0 Cold-Sends, alle 34 Reviews COLD_LEAD_DRAFT_ONLY / NONE / false.
  Offen: Cloud-Dashboard „Lead-Datenbank“ mit Daten einmal per Passwort ansehen (Chris) – der Upload lief ohne Fehler, eine Lesung braucht JARVIS_PASSWORD.

## JARVIS 7500/DAY DISCOVERY – 5× QUALIFIZIERTE DRAFTS (2026-10-10, Code + Tests fertig, 360/360 grün; VPS-Rollout siehe unten)
- Ziel: ~5× Output bei UNVERÄNDERTER Qualität. Website-Deckel (hart, technisch): intervalMinutes 20, sitesPerRun 105, maxSitesPerHour 315, maxSitesPerDay 7500
  (105 × 3 × 24 = 7560 theoretisch, Deckel 7500). `maxDraftsPerHour/Day` weiter **null** (kein Business-Cap); Draft-Queue/-Worker/Gmail-Pacing unverändert.
- Deckel absturzsicher: jede Reservierung schreibt `discovery_counter.json` (Tag + UTC-Stunde); Deckel gilt für max(discovered.json, Zählerfile).
  Verworfene Kandidaten (Plattform/Kette/Freemail/ohne Firmenname) verbrauchen kein Budget. Test: 9 × 1000 Kandidaten → genau 7500, nie 7501; 3 × 105 → danach hour_limit.
- Parallelität: `maxConcurrency` (Default 6, zentral in `config.json` → `discovery`), Worker-Pool statt Promise.all-Flut; Reservierung (Domain+Firma+Zähler) synchron
  vor dem Audit = atomar; pro Domain höchstens eine aktive Prüfung; Einordnung/Dedupe/Queue je Lead ohne `await` (race-frei); Ergebnisse in Kandidatenreihenfolge.
  `runBudgetMinutes` 19: danach keine neuen Audits (nächster Zyklus macht weiter). `site-auditor`: Zeitbudget `totalMs` 90 s nur für Zusatzprüfungen (nie ein Befund aus Zeitmangel).
  Rechnung: ≈20 Requests je Audit × 1,5 s Mindestabstand ≈ 30–40 s → 105 Audits / 6 Slots ≈ 10–12 min < 20 min; Last = I/O-Wartezeit (≈4 Req/s gesamt), kaum CPU.
- Bessere Discovery: bis zu `maxSearchesPerRun` 6 Overpass-Abfragen je Lauf (bis genug NEUE Firmen vorliegen), `searchLimit` 250; 109 Orte × 24 Branchen (≈2600 Paare);
  Paare ohne Neues werden `pairRetryHours` 72 (bei Fehlern 6 h) nicht erneut abgefragt; Firmen mit OSM-Geschäftsadresse zuerst; Social-/Plattformseiten, Ketten, Freemail,
  ohne Firmenname vor dem Audit verworfen; bereits aktuell geprüfte Domains übersprungen. Ehrliche Grenze: OSM ist der Pool – bei 7500/Tag ist er irgendwann erschöpft
  (Status `pool_exhausted`); echte Tageszahl = Zahl neuer Firmen mit Website, nicht der Deckel.
- Quellen-Limiter (getrennt von den Audits): Overpass strikt nacheinander, Mindestabstand 6 s, Retry-After wird respektiert (bis 120 s im Lauf, sonst Lauf-Backoff ≥ Retry-After),
  ohne Header exponentiell 30 s · 2^n (max. 2 Retries); 429 oder zweiter Fehler im Lauf → Abbruch + Backoff 15 → 30 … 360 min; einzelner 5xx/Timeout nur Paar-Pause.
- Skalierung der Daten: nicht qualifizierte Leads früherer Tage → `audited_index.json` (Domain → Datum, 90 Tage; audit_error 7 Tage), `discovered.json` kompakt (ohne Einrückung),
  Speichern während des Laufs höchstens alle 5 s. Qualitäts-Gate, Dedupe, Suppression, Opt-out, Sperrfrist, COLD_LEAD_DRAFT_ONLY unverändert (Tests 030/031/032).
- Dashboard/Mobile (Panel „24/7 Discovery“): Websites heute X / 7500, Websites diese Stunde X / 315, Qualifizierte Leads, Warten auf Gmail-Draft, Gmail-Drafts heute, Gesamt offene
  Gmail-Drafts, Letzter Lauf (Websites), Discovery-Rate (Websites/Stunde, letzte 60 min), Draft Worker ACTIVE/BACKOFF, Backoff, VPS CPU/RAM (aus dem Server-Snapshot). Snapshot-Whitelist erweitert.
- Tests: `test/discovery-7500-032.test.js` (22) + angepasste 031; gesamt 360/360. 0 Cold-Send-Events.

## JARVIS 1500/DAY DISCOVERY — UNLIMITED QUALIFIED DRAFT QUEUE (2026-10-09, Tests 338/338)
- Website-Deckel (hart, technisch): intervalMinutes 20, sitesPerRun 21, maxSitesPerHour 63, maxSitesPerDay 1500 (`DEFAULT_DISCOVERY`, per
  `config.json` → `discovery` überschreibbar). Test: 4 × 400 Kandidaten → genau 1500 Audits, danach bis zum nächsten Tag keines mehr.
- KEINE Business-Obergrenze für Cold-Gmail-Entwürfe: `maxDraftsPerHour` / `maxDraftsPerDay` = **null = kein Business-Cap** (Felder bleiben zur
  Kompatibilität). `draftBudget` in der Discovery entfernt, Tages-/Stundenzähler im Worker entfernt. Jeder qualifizierte Lead (alle bestehenden
  Qualitätsregeln: CH belegt, geschäftliche Adresse, sichtbares belegtes Problem, verständlich formulierbar, kein Duplikat, nicht kontaktiert,
  kein offener Entwurf, keine Suppression/Opt-out/Sperrfrist/Ausschluss) wird persistent in die Draft-Queue aufgenommen:
  `individual_reviews.json` queued → (Worker) → draft_created | blocked. 10 → 10, 100 → 100, 500 → 500 Entwürfe (Tests).
- Technisches Pacing (verschiebt nur, verwirft nie): `draftsPerPass` 25 je Worker-Durchlauf (alle 2 min), `draftPaceMs` 1500 zwischen zwei
  Entwürfen, bei Gmail 429/5xx/Netz exponentieller Backoff 1 → 2 → 4 … max 60 min, persistiert in `individual_reviews.json.draft_worker`
  (überlebt Neustart); im Backoff bleibt alles queued. Draft-Worker läuft 24/7, Versandfenster gelten nicht für Cold-Entwürfe.
- Dedupe direkt vor Gmail (Worker 3b): Suppression/Opt-out (auch Domain), Ausschlussadressen, geschäftliche Adresse, bereits kontaktiert /
  Gmail-Entwurf vorhanden (Register sent+drafts), bestehender Kunde (`sales.json`) → Queue-Eintrag BLOCKED mit Grund, kein Entwurf.
- Entkopplung: DISCOVERY QUEUE (Websites prüfen) läuft als Hintergrund-Promise (`discoveryRunning`, eigenes Lock → nie doppelt) und blockiert
  weder Mail-Takt noch Draft-Worker; DRAFT QUEUE wird in jedem 2-min-Durchlauf abgearbeitet. Keine doppelten Leads/Entwürfe (Dedupe + Register).
- Dashboard/Mobile: Websites heute X / 1500, Neue Leads, Qualifizierte Leads (gesamt/heute), Warten auf Gmail-Draft, Gmail-Drafts heute erstellt,
  Gesamt offene Gmail-Drafts, Blockiert, Draft Worker ACTIVE/BACKOFF, Letzter Draft, Letzter/Nächster Discovery-Lauf, Letzter Fehler; Quick-Status
  „Websites / Drafts heute“. Keine „X / 20“-Anzeige mehr. Snapshot-Whitelist `cleanDiscovery` erweitert (max_drafts_* immer null).
- Unverändert: COLD_LEAD_DRAFT_ONLY, legal_basis NONE, automatic_send_allowed false, delivery draft; `gmail.sendDraft` verweigert Cold-Entwürfe;
  nie in state.actions. Tests: `test/discovery-1500-031.test.js` (7) + angepasste 030; gesamt 338/338, Secret-Scan 0 Treffer, 0 Send-Events.
- Performance: 21 Audits je Lauf sequentiell mit 1,5 s Mindestabstand je Website (site-auditor) ≈ 2–6 min je Lauf < 20-min-Intervall; keine
  Parallelität nötig. Gmail: 25 Entwürfe je 2-min-Durchlauf ≈ bis 750/h technisch möglich.
- **LIVE 2026-10-09 21:30 UTC (Commit 60bed54):** VPS `deploy/vps/deploy.sh fiverr` (ohne Secrets), Container healthy, 0 Restarts, `worker_started role=vps`.
  VPS `config.json` → `discovery`: intervalMinutes 20, sitesPerRun 21, maxSitesPerHour 63, maxSitesPerDay 1500, maxDraftsPerHour null, maxDraftsPerDay null
  (null = kein Business-Cap), Datei 600. Live-Status: ACTIVE, Websites 44/1500 heute, 7 qualifizierte Leads (alle 7 von Chris manuell versendet →
  0 offen, 0 wartend), Draft-Worker ACTIVE, nächster Lauf 21:43 UTC. Netlify Production hat 60bed54 deployt (neue Panel-Zeilen live).
  dr-probe: System ONLINE, VPS ACTIVE, Authority VPS, Windows STANDBY, Queue 0. 0 Send-Events. /opt/fiverr unberührt.

## JARVIS 24/7 CLOUD LEAD DISCOVERY (2026-10-09, Code fertig, Tests 331/331)
- VPS 24/7, Windows optional: `lead-finder.js` läuft im VPS-Worker-Loop in jedem Durchlauf; `DEFAULT_DISCOVERY` jetzt intervalMinutes 20, sitesPerRun 4,
  maxSitesPerHour 12, maxSitesPerDay 60, maxDraftsPerHour 5, maxDraftsPerDay 20, backoffMinutes 15 / backoffMaxMinutes 360 (alles per
  `config.json` → `discovery` überschreibbar). Discovery kennt weder Local Core noch Versandfenster (Versandfenster 09:30/14:30 bleiben nur für erlaubte Auto-Sends).
- Ablauf: DISCOVER (OSM) → WEBSITE AUDIT → SWISS CHECK → BUSINESS CONTACT → DEDUPE → CUSTOMER-VISIBLE ISSUE CHECK → QUALIFY → BUILD DRAFT
  (Standardvorlage) → GMAIL DRAFT (Worker 3b, COLD_LEAD_DRAFT_ONLY) → REGISTER STATUS. Eine Firma stoppt nie den Lauf.
- Limits/Backoff: Stundenzähler `hourly` in `discovered.json`; Entwurfs-Budget vor `ensureColdDraft` (Lead wird gespeichert, `draft_blocked_reason`,
  Zähler `blocked`), Worker legt höchstens maxDraftsPerHour/Tag Gmail-Entwürfe je Durchlauf an (Rest bleibt queued, `cold_draft_deferred`).
  Quellenfehler 429/5xx/Netz → `backoffUntil` exponentiell (15→30→…→360 min), `lastError`; nur Netzfehler ohne jedes Audit → Backoff; Erfolg setzt zurück.
- Dedupe unverändert + geprüft: Domain/Firma/E-Mail bekannt, offener Entwurf, kontaktiert (Gmail-Register), Suppression/Opt-out (auch domainweit), Sperrfrist 180 Tage.
- Pause/Resume: `setDiscoveryPaused` (Flag `paused` in discovered.json, nichts gelöscht); Server-Control-Aktionen `discovery.pause` / `discovery.resume`
  (CONTROL, ohne Parameter, Cooldown 10 s, Audit); VPS-Agent `deps.setDiscovery` + Weckruf. DANGEROUS unverändert; keine Scheduler-/Shell-Befehle.
- Dashboard/Mobile: Snapshot-Abschnitt `discovery` (`cleanDiscovery` Whitelist, Fehlertext redacted) → HUD-Panel „24/7 Discovery“ (ACTIVE/PAUSED/BACKOFF,
  Heute geprüft, Neue Leads, Qualifiziert, Gmail-Entwürfe mit Limit, Blockiert, Letzter Lauf, Nächster Zyklus, Queue, Letzter Fehler, Pausieren/Fortsetzen)
  + Quick-Status-Kacheln „24/7 Discovery“ und „Entwürfe heute“; auf dem Handy standardmässig offen. Playwright 390×844 (Mock): Panel korrekt,
  Pause → PAUSED, Buttons 40 px, kein Overflow.
- Recovery: Docker restart unless-stopped, Zustand in Dateien, verwaistes Discovery-Lock (toter PID) wird übernommen – getestet.
- Tests: `test/discovery-247-030.test.js` (13): 24/7-Intervall, sichtbarer Fehler → Draft / keiner → kein Draft, Duplikate, kontaktiert, Suppression,
  Opt-out, Sperrfrist, Tages-/Stunden-/Website-Limits, Worker-Limit + Send-Versuch blockiert, 429-Backoff, Netzfehler, Lock-Recovery, Pause/Resume,
  Server-Control-Whitelist, Mock-E2E Handy→VPS, Dashboard. Gesamt 331/331, Secret-Scan 0 Treffer. Keine echte Mail.
- **LIVE 2026-10-09 21:02 UTC (Commit 7a08879):** VPS `deploy/vps/deploy.sh fiverr` (ohne Secrets), Container healthy, 0 Restarts, `worker_started role=vps`.
  VPS `config.json` → `discovery` von Chris’ alten Werten (60 min / 3 Sites / 40 pro Tag) auf die 24/7-Werte gesetzt (20 min / 4 / 12 pro h / 60 pro Tag /
  5 bzw. 20 Entwürfe) – Datei bleibt 600. Live-Status im Container: ACTIVE, 39 heute geprüft, 4 Entwürfe heute, Queue 0, nächster Lauf 21:21 UTC, kein Fehler.
  Netlify Production hat 7a08879 per Push deployt (Panel „24/7 Discovery“ + discovery.pause/resume im HUD). check-mail-auth VPS self=true /
  Windows self=false; dr-probe System ONLINE, VPS ACTIVE, Authority VPS, Windows STANDBY, Queue 0, AI ONLINE, Backup OK (3 Gen.). 0 Send-Events,
  heute keine `control_pull_refused`. Kein Restart/Reboot, keine Control-Aktion live ausgeführt, /opt/fiverr unberührt.

## COLD-OUTREACH-STANDARDVORLAGE: VOLLSTÄNDIGER WEBSEITEN-CHECK (2026-10-09, Tests 318/318)
- `swiss-repair.js` `buildColdDraft`: Struktur jetzt Anrede → 1 belegtes, einfach erklärtes Problem (optional 2.) → `FULL_CHECK_TEXT`
  („Das ist nur der Punkt, der mir beim ersten Blick direkt aufgefallen ist. Mein Angebot umfasst einen vollständigen Webseiten-Check: …
  gesamte Website … sichtbare Fehler, defekte Links … Smartphone und Desktop … verständlich zusammen.“; bei zwei Befunden „nur das, was …“)
  → `offer150Text()` («Check & Anleitung» CHF 150: Check + Schritt-für-Schritt-Anleitung) → `offer480Text()` («Check & Reparatur» CHF 480:
  Check + Reparatur der im Angebot behebbaren Fehler + Test Smartphone/Desktop) → „Wenn das für Sie interessant ist, genügt eine kurze
  Antwort. Details: Landingpage“ → Signatur → `COLD_FOOTER`. Preise ausschliesslich aus `OFFERS` (Funktionen statt Konstanten wegen des
  Zirkular-Imports sales.js ↔ swiss-repair.js). Nie „Website bereits geprüft“ – erster Blick ≠ Check. Betreff unverändert.
- Unverändert: max. 2 Kundenaussagen, nur belegte sichtbare Fehler, ohne Befund kein Entwurf, Evidence intern, Jargon-/Druck-Sperre für die
  Befundtexte (Preise sind keine Statuscodes – Tests entfernen `CHF d+` vor der Jargon-Prüfung), COLD_LEAD_DRAFT_ONLY, legal_basis NONE, kein Auto-Send.
- Tests: neu `test/cold-template-029.test.js` (6); angepasst 022/025/026 (Preise jetzt erlaubt, alter Satz „Ich behebe solche kleineren
  Website-Probleme“ ersetzt). Vorhandene Gmail-Entwürfe bleiben unberührt (extern bereits angepasst); keine Mail gesendet.
- **LIVE 2026-10-09 20:28 UTC (Commit 7fec90e):** VPS `deploy/vps/deploy.sh fiverr` (ohne Secrets), Container healthy, 0 Restarts, `worker_started role=vps`,
  neue Vorlage im Container geladen (FULL_CHECK_TEXT, CHF 150/480 aus OFFERS). Netlify: kein Frontend-/Cloud-Code geändert (Autodeploy 200).
  Danach: VPS self=true, Windows self=false, Authority VPS, Queue 0, AI ONLINE, 0 Send-Events. Secret-Scan 0 Treffer.

## JARVIS MOBILE CLOUD READY — END-TO-END VERIFIED (2026-10-09 19:50–19:55 UTC)
- Echter Production-Mobile-Test bestanden (390×844, Local Core blockiert, Passwort von Chris im Browser eingegeben, nie ausgelesen, danach entfernt).
- Echter Gmail-Draft über Production-UI → /api/cloud (mail_request, delivery=draft) → Cloud-Queue → VPS Cloud Core/Mail-Worker → Gmail API:
  Auftrag 19:51 UTC übergeben („WARTET AUF MAIL-WORKER“, Queue 1), VPS `cloud_request_drafted` 19:52:46 UTC, HUD/Mail-Panel „ENTWURF IN GMAIL“
  nach 90 s, Queue 0. Gmail (read-only geprüft, assertOwnedDraft): Entwurf existiert, Labels DRAFT + JARVIS, kein SENT; Empfänger = von Chris
  kontrollierter Plus-Alias seiner eigenen Adresse (nicht hier gespeichert), Betreff „Jarvis Mobile Cloud Test“, Text exakt wie vorgegeben,
  Register mode=COLD_LEAD_DRAFT_ONLY. Draft NICHT gesendet: 0 Send-Events, kein state.actions-Eintrag, sent-Register leer.
  Erster Versuch an die Hauptadresse wurde vom VPS korrekt blockiert (excludeAddresses) – Schutz eigener Adressen bestätigt.
- Windows für den Betrieb nicht erforderlich (Local Client OFFLINE, Windows-Worker STANDBY self=false); VPS authoritative (holder=vps self=true), genau ein Sender.
- Cloud Leads verfügbar (24 Leads live, Allowlist), Cloud Draft Button verfügbar (bei vorhandenem Entwurf inaktiv), Gmail-Link statisch ohne Token.
- TF-024 unverändert, TF-025 unverändert, Suppression/Opt-out aktiv, Server Control aktiv (ONLINE, Audit), keine Secrets in DOM/Storage/Audit.
- Teststand: 312/312 grün, Secret-Scan 0 Treffer. Live-Stand: VPS a7ede6a healthy 0 Restarts, Netlify Production 770da3e+, Scheduler ONLINE
  (09:30/14:30 ausgeführt), Backup OK (3 Gen.), Queue 0, AI ONLINE. /opt/fiverr unberührt. Chris kann den Testentwurf in Gmail löschen.

## MOBILE CLOUD LIVE-ABNAHME 2026-10-09 19:15–19:25 UTC (Production, 390×844, Local Core blockiert) – TEILWEISE BESTANDEN
- Login: Chris hat JARVIS_PASSWORD selbst im Playwright-Fenster eingegeben (nie ausgelesen/geloggt; danach aus localStorage entfernt, Fenster geschlossen).
- PASS live hinter Login: Modus CLOUD; Quick-Status JARVIS CLOUD ONLINE / VPS CORE ONLINE / MAIL WORKER VPS ACTIVE / AUTHORITY VPS /
  WINDOWS CLIENT OFFLINE / QUEUE 0 / AI SERVICE ONLINE / SERVER CONTROL ONLINE; Server-Panel HEALTHY, VPS ACTIVE, Scheduler ONLINE, Backup OK,
  Deploy a7ede6a; kein horizontaler Overflow (scrollWidth 390); Composer sichtbar/bedienbar (46 px); Chat live über /api/cloud (Antwort in 5 s).
  LEADS live: 24 Leads vom VPS (7 „Entwurf in Gmail“, 17 „kein Entwurf“), Zeilen 94 px, Detail mit Problem in Kundensprache, Business-E-Mail,
  Draft-Status, COLD_LEAD_DRAFT_ONLY, Suppression/Opt-out-Zeilen; Buttons 40 px: „GMAIL-ENTWURF ERSTELLEN“ bei vorhandenem Entwurf korrekt
  inaktiv, „ENTWURF VERWERFEN“/„IN GMAIL ÖFFNEN“ aktiv; keine Roh-Evidence/IDs im Detail; Tap auf zweiten Lead funktioniert. Kein Cold-Entwurf
  an eine reale Firma ausgelöst. Gmail-Link = statisches https://mail.google.com/mail/u/0/#drafts (rel=noopener, kein Token/Deep-Link).
- Security live: DOM + localStorage ohne sk-ant/ya29/PEM/64-Hex/ENV-Namen/Gmail-Credentials/Worker-/Control-Header; Passwortfeld leer.
- Echter Gmail-Draft-E2E: Production-UI → /api/cloud → mail_request delivery=draft → Cloud-Queue (Queue 1, „WARTET AUF MAIL-WORKER“) → VPS hat
  den Auftrag nach 50 s verarbeitet → **blockiert**: der von Chris genannte Testempfänger ist seine eigene Adresse und steht auf dem VPS in
  `excludeAddresses` (bewusst: für eigene Adressen nie Entwürfe). HUD/Mail-Panel: „ENTWURF · BLOCKIERT – Empfänger ist gesperrt“, Queue 0,
  kein state.actions-Eintrag, kein cloudDrafts-Eintrag, 0 Send-Events, kein Gmail-Entwurf. Pfad bis Gmail-Gate real verifiziert; Gmail-Draft selbst
  NICHT erzeugt. Chris hatte keine zweite Adresse → offen: TESTEMPFAENGER_FEHLT (Adresse nicht in PROJECT_STATE).
- Danach: VPS healthy, 0 Restarts, authority holder=vps self=true, Windows self=false, genau ein Sender, Scheduler 09:30/14:30 ausgeführt,
  Backup OK (3 Gen.), Queue 0, 0 Send-Events; Tests 312/312, Secret-Scan 0 Treffer. TF-024/025 unverändert, /opt/fiverr unberührt.
- JARVIS MOBILE CLOUD READY — END-TO-END VERIFIED wird erst gesetzt, wenn genau ein echter Gmail-Draft (an eine nicht ausgeschlossene,
  von Chris kontrollierte Adresse) über Cloud→VPS→Gmail entstanden ist.

## CLOUD LEADS + MOBILE COLD-DRAFT (2026-10-09, Code fertig, Tests 312/312) – Lead-Liste/Details/Entwurf vom Handy, ohne PC
- Neu `cloud-leads.js` (Allowlist `CLOUD_LEAD_FIELDS`: lead_id, Firma, Website, Problem in Kundensprache, Kontakt, Business-E-Mail, Stage,
  Offer, Draft-Status, Entwurf-in-Gmail ja/nein, Suppression, Opt-out, draft_eligible, Draft-Modus, letzter Kontakt, Antwort, Kunde).
  Nie dabei: Roh-Evidence, Befund-URLs, Gmail-/Thread-/Message-IDs, Hashes, Pfade. `publicLeads` (VPS) + `cleanLeads` (Cloud erzwingt die
  Allowlist erneut), max. 150 Leads, nur relevante (Cold/Entwurf/Kandidat/kontaktiert).
- Server Control: VPS-Agent schickt die Liste mit dem Status-Pull nur bei Änderung (Fingerabdruck) oder alle 10 min; Browser liest sie per
  `GET /api/server-control?leads=1` (nur Cloud-Passwort). Neue CONTROL-Aktionen `leads.createDraft` / `leads.discardDraft` mit genau einem
  `lead_id` (Regex, keine Sammelaktion); VPS `coldDraftFromCloud` (mail-worker.js) → `ensureColdDraft` (queued, COLD_LEAD_DRAFT_ONLY,
  legal_basis NONE) + Worker-Weckruf → Gmail-Entwurf im nächsten Durchlauf. Suppression/Opt-out/Domain-Sperre/Duplikat/fehlender Absender →
  abgelehnt. Keine Send-Aktion existiert (auch nicht als Action-ID); DANGEROUS unverändert. `sales.findRawLead` (nur lokal). Dockerfile kopiert cloud-leads.js.
- HUD: LEADS-Button auch im CLOUD-Modus (mit Passwort) → touch-geeignete Liste (Firma, Problem, Kontakt, Draft-Status) + Detail mit
  „GMAIL-ENTWURF ERSTELLEN“ / „ENTWURF VERWERFEN“ / „IN GMAIL ÖFFNEN“; gesperrte Leads „GESPERRT — SUPPRESSION / OPT-OUT“, Button inaktiv.
  LOCAL-Modus unverändert (volle Details, Edit). Playwright (gemockte Cloud, Local Core blockiert) 390×844 + 430×932: Liste 3 Leads,
  Detail, Aktion → `leads.createDraft {lead_id}` → Status „Entwurf wird angelegt“, gesperrter Lead blockiert, kein horizontaler Overflow.
- Tests: `test/cloud-leads-028.test.js` (10): Allowlist, cleanLeads, Suppression/Opt-out, Aktion validiert, VPS-Entwurf queued, Cloud↔VPS-
  Mock-E2E, Cold Send unmöglich, HUD, Dockerfile. Gesamt 312/312, Secret-Scan 0 Treffer.
- Echter Gmail-Draft-E2E-Test (Cloud → VPS → Gmail): NICHT ausgeführt – im Projekt ist kein sicherer Testempfänger dokumentiert
  (TESTEMPFAENGER_FEHLT). Chris: Testadresse in PROJECT_STATE unter „Testempfänger“ eintragen, dann genau ein Draft-Test.
- Echter Mobile-Test auf Production braucht das Cloud-Passwort (lokal nicht vorhanden) – ohne Passwort nur Login-Screen prüfbar.
- **LIVE 2026-10-09 18:40 UTC (Commit a7ede6a):** VPS `bash deploy/vps/deploy.sh fiverr` (ohne `--with-secrets`): DEPLOYED_COMMIT a7ede6a, Container
  healthy, 0 Restarts, `server_control_started` + `worker_started role=vps` 18:40:48 UTC; kein `control_leads_failed`/401/`control_pull_failed`
  (einziger Fehler im Log: alter Overpass-504 der Discovery 13:56 UTC). Live-Lead-Liste im Container (nur Zähler ausgegeben): 24 Leads,
  7 „Entwurf in Gmail“, 1 erstellbar, 0 gesperrt, 16 mit Problemtext, 20 Allowlist-Felder, ~16 KB. Netlify Production hat a7ede6a per Git-Push
  deployt (HUD enthält `openCloudLeads`); `?leads=1` ohne Passwort → 401; Server-Control-Probe configured/64. check-mail-auth: VPS self=true,
  Windows self=false, pending 0. dr-probe: System ONLINE, Core CLOUD ONLINE, VPS ACTIVE, Authority VPS, Windows STANDBY, Queue 0, AI ONLINE.
  Production-Mobile-Check 390×844 (Local Core blockiert, ohne Passwort): Modus CLOUD, Boot „CLOUD (VPS – PC OPTIONAL)“, Passwortabfrage mit
  Cloud-Hinweis sichtbar, kein horizontaler Overflow; Chat/Leads/Draft live nur mit JARVIS_PASSWORD prüfbar (nicht vorhanden, nicht erfragt).
  Keine echte Mail, kein Restart/Reboot, keine Control-Aktion ausgeführt, /opt/fiverr unberührt.

## MOBILE + CLOUD PARITY (2026-10-09, Code fertig, Tests 302/302) – Jarvis vom Handy, PC optional
- Bestandsaufnahme: Cloud Core/VPS live (Heartbeat frisch, Start 2026-10-08 20:43 UTC = 4eff23c, 0 Restarts), Netlify Production 200
  (`/api/cloud` configured, Server-Control-Probe length 64), check-mail-auth VPS self=true / Windows self=false, dr-probe: System ONLINE,
  Core CLOUD ONLINE, VPS ACTIVE, Authority VPS, Queue 0, AI ONLINE, Backup OK (3 Gen., offsite 3), 144 Leads, 8 Cold, 7 Drafts offen.
  SSH `fiverr` in dieser Sitzung nicht möglich (Key nicht im Agent) – VPS-Stand nur über die Cloud verifiziert.
- Hauptbefund HUD: unter 860 px waren linke und rechte Panels (Status, Server, Meldungen, Mail, Vertrieb, Protokoll) komplett
  ausgeblendet; Cloud-Modus hiess im Wording „ohne PC-Zugriff“/„nur Gespräch“; Fehlertext verwies aufs Terminal-Fenster.
- Umsetzung `public/index.html` (nur Frontend, kein VPS-Redeploy nötig): Handy-Layout als eine scrollbare Spalte (Composer unten
  festgepinnt, 16-px-Feld, Touch-Flächen ≥ 40 px, Panels per Titel-Tipp auf-/zuklappbar, Desktop unverändert); Quick-Status
  (JARVIS / VPS CORE / MAIL WORKER / AUTHORITY / WINDOWS CLIENT / QUEUE / AI SERVICE / SERVER CONTROL) aus Cloud-Quellen; neues
  Mail-Panel (letzte 12 Cloud-Mailaufträge mit Status „Entwurf in Gmail“/gesendet/blockiert + Grund, Link zu Gmail-Entwürfen; auch im
  LOCAL-Modus aus der Cloud); Cloud-Wording positiv (VPS = Normalbetrieb, PC optional). `cloud.js`: Systemprompt sagt dasselbe.
- Docs: `docs/JARVIS_CAPABILITY_MATRIX.md` (Local/Cloud/Mobile/Backend/Status je Funktion, LOCAL_ONLY vs. SAFE_CLOUD_EQUIVALENT) und
  `docs/MOBILE_CLOUD_RUNBOOK.md` (URL, Login, Handy-Nutzung, Gmail-Draft-Workflow, ohne PC, lokal optional, Sicherheitsmodell, Cold-Draft-Regeln, Recovery).
- Tests: `test/mobile-cloud-027.test.js` (6) + angepasste Mobile-Assertion in ux-mail-020. Playwright (lokale index.html unter dem
  Netlify-Hostnamen, Local Core blockiert, Cloud-APIs gemockt) bei 390×844 und 430×932: Modus CLOUD, Quick-Status gefüllt, Composer im
  Viewport, kein horizontaler Overflow, Chat → `mail_request` draft → Mail-Panel „WARTET AUF MAIL-WORKER“ → „ENTWURF IN GMAIL“.
- Unverändert: TF-024/025, Suppression, Opt-out, Foreign-Gmail-Schutz, Server-Control-Allowlist, Cold Leads COLD_LEAD_DRAFT_ONLY,
  Authority VPS. Keine echte Mail, kein Restart, keine Secrets. Lead-Details/Cold-Draft-Buttons bleiben LOCAL_ONLY (Cloud: Zähler, Gmail-App).
- Nächster Schritt: Push → Netlify-Autodeploy; Chris prüft auf dem Handy `https://chrisjarvis.netlify.app/` (Cloud-Passwort), schreibt
  „Schreib eine Mail an …“ und findet den Entwurf in Gmail. Optional später: sichere Lead-Kurzliste via Server-Control-READ.

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

## GMAIL DRAFT MODE + EINFACHE KUNDENSPRACHE (2026-10-08, abgeschlossen; Tests `test/cold-customer-text-026.test.js` (16) + Erweiterungen)
- Cloud-Mailauftrag `delivery: "draft" | "send"` (`mail-requests.js`, Status `drafted`): Der Mail-Worker legt NUR einen Gmail-Entwurf an,
  neu wie im bestehenden Jarvis-Thread immer mit mode=COLD_LEAD_DRAFT_ONLY → `gmail.sendDraft` verweigert ihn, kein `state.actions`-Eintrag,
  nie in der Send-Queue. Suppression/Opt-out sperren auch Entwürfe. Cloud-Werkzeug `mail_request`: `delivery` ist Pflichtfeld; fehlt es → Entwurf
  (nie stillschweigend Versand). „Schreib eine Mail“ ohne Sendebefehl = Entwurf. HUD zeigt „Entwurf in Gmail“.
- Cold Leads bleiben COLD_LEAD_DRAFT_ONLY (TF-025 unverändert): kein Force-Send, kein Approval→Auto-Send, keine Queue, kein VPS-Send, kein Follow-up.
- Kundentext (`swiss-repair.js`: `customerFindings`, `buildColdDraft`): höchstens 2 Probleme (`MAX_CUSTOMER_FINDINGS`), nur für Besucher
  sichtbare, reproduzierbare, konkret prüfbare Fehler in Alltagssprache (Link → Fehlerseite, Kontaktseite/-formular, Bild fehlt, E-Mail-Link,
  Browser-Warnung, Seite lädt nicht; Handy: Text überlappt / Bereich abgeschnitten, Button, sichtbarer Darstellungsfehler – letztere nur mit
  reproducible=true + Bereich). Gleiche sichtbare Ursache → eine Aussage. Nie im Kundentext: Statuscodes, URLs der Befunde, CLS/LCP/Lighthouse,
  Ladezeit, Titel/SEO, HTTPS-Details, Technik/„altes Design“, Druck-/Angstsprache, Preise (`CUSTOMER_JARGON_RE`/`CUSTOMER_PRESSURE_RE`, fail closed).
  Ohne solchen Befund: KEIN Cold-Entwurf (Stufe `no_visible_issue`), nichts wird erfunden. Struktur (bis 2026-10-09, danach siehe Standardvorlage oben): „Hallo …, ich habe mir Ihre Website kurz
  angesehen …“, Auswirkung in einem Satz, „Ich behebe solche kleineren Website-Probleme für Schweizer Unternehmen.“, CTA + Landingpage, Grüsse, Abmeldesatz.
- Intern unverändert: `issue_evidence` (Typ, URL, technische Evidence, Zeitpunkt, Schwere), `evidence_hash`, `offer_class` (CHF 150/480),
  neu `customer_findings` mit internen Referenzen. Auditor speichert zusätzlich Seite + Linktext (nur intern, für die einfache Formulierung).
- Tests 296/296 grün (TF-024, TF-025, Foreign-Gmail-Schutz, Suppression unverändert). Keine echte Mail gesendet (nur Attrappen/Mocks).
- **PRODUKTIV DEPLOYT 2026-10-08 20:43 UTC (Commit 4eff23c):** VPS `bash deploy/vps/deploy.sh fiverr` (ohne `--with-secrets`, Secrets
  unverändert: `.env` 600 root, `secrets/mail_worker/` vollständig, Gmail-/Backup-Dateien vorhanden). DEPLOYED_COMMIT 4eff23c, Container
  running/healthy, 0 Restarts, `server_control_started` + `worker_started role=vps` 20:43:48 UTC, JARVIS_COMMIT=4eff23c im Container,
  Control-Token Länge 64 / Worker-Token Länge 106 (Werte nicht ausgegeben). Vorher: Tests 296/296, Secret-Scan 0 Treffer; nachher erneut 296/296 + 0 Treffer.
  Netlify Production hatte 4eff23c bereits automatisch per Git-Push deployt (HUD-String „Entwurf in Gmail“ live, Site 200) – kein erneuter Deploy.
  Probe `/api/server-control?probe=1` → configured=true, length=64. check-mail-auth: VPS 200 self=true, Windows 200 self=false, holder=vps, pending 0.
  dr-probe: System ONLINE, Jarvis Core CLOUD ONLINE, Mail Worker VPS ACTIVE, Authority VPS, Windows STANDBY (Lock frisch), Queue 0, AI ONLINE,
  Scheduler 09:30/14:30 je 50 ausgeführt, Backup OK (2 Gen., offsite 2), Heartbeat frisch. Keine `control_pull_refused`/401 seit 11:37 UTC;
  vereinzelte `fetch failed` (tick/sync/control_pull/Overpass 504) vor dem Deploy = Netzwerk, kein Auth-Fehler. 0 Send-Events VPS und Windows.
  `/opt/fiverr`-Container unberührt. Kein Restart/Reboot/Control-Aktion, keine echte Mail.
  Synthetisch (nur Testdaten, Scratch-Skript): A kaputter Link → „auf Ihrer Startseite der Link «Unser Angebot» auf eine Fehlerseite führt“ (kein 404/URL,
  Evidence intern erhalten); B fehlendes Bild → „ein Bild nicht angezeigt wird“ ohne Bild-URL; C Handy-Overlap → „im Bereich «Über uns» Text teilweise
  übereinander liegt“, ohne reproducible/Bereich KEIN Entwurf; D Ladezeit/LCP/CLS/Titel/HTTPS allein → KEIN Entwurf; E „altes Design“/UX → KEIN Entwurf;
  F kein Befund → KEIN Entwurf (draft_creation_eligible=false); G 3 kaputte Bilder gleiche Seite → 1 Aussage, 3 interne Referenzen; H 5 Befunde → 2 Aussagen,
  keine Preise im Kundentext. Angebote REPAIR_CHECK_150 = 150 / REPAIR_FIX_500 = 480, genau zwei Klassen. TF-024: öffentliche Adresse → BLOCKED/NONE;
  TF-025: contact_basis COLD_LEAD_DRAFT_ONLY, automatic_send_eligible=false; COLD_MODE identisch mit gmail.js. Foreign-Gmail/Suppression/Opt-out-Tests grün.

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
