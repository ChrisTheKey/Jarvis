# J.A.R.V.I.S. auf Claude Code

Sprachgesteuerter Jarvis im Iron-Man-Stil. Du sprichst, Jarvis antwortet mit Stimme und führt über Claude Code echte Befehle auf deinem Computer aus: Programme und Webseiten öffnen, im Web recherchieren, Dateien lesen und schreiben, Pläne und Texte erstellen. Er merkt sich, was er über dich erfährt.

## Einmalig einrichten (10 Minuten)

1. **Node.js** installieren (Version 18 oder neuer): https://nodejs.org
2. **Claude Code** installieren und anmelden – im Terminal:
   ```
   npm install -g @anthropic-ai/claude-code
   claude
   ```
   Beim ersten Start meldest du dich mit deinem Claude-Konto an (Pro/Max) oder mit einem API-Schlüssel. Danach mit `/exit` beenden.
3. Optional: `.env.example` zu `.env` kopieren und anpassen (Modell, Vollzugriff, ElevenLabs-Stimme).

## Starten

- **Windows:** Doppelklick auf `start.bat`
- **macOS:** Doppelklick auf `start.command` (beim ersten Mal: Rechtsklick → Öffnen)
- **Linux / Terminal:** `npm start` im Ordner, dann http://localhost:3000 öffnen

Öffne die Seite in **Chrome oder Edge** (Firefox kann keine Spracherkennung), klicke **System starten** und erlaube das Mikrofon.

## Auf Netlify hosten

Netlify zeigt die Jarvis-Oberfläche unter einer festen Adresse, auch auf dem Handy. Die Befehle führt weiterhin der Jarvis auf deinem Computer aus, denn Netlify kann nichts auf deinem PC tun.

1. Auf https://app.netlify.com **Add new site → Import an existing project → GitHub** wählen und dieses Repository verbinden. Netlify liest `netlify.toml` und braucht keine weiteren Build-Einstellungen.
2. Freigegeben ist bereits `https://chrisjarvis.netlify.app`: Nur diese Seite darf den Jarvis auf deinem Rechner steuern. Bei einer anderen Adresse diese in die `.env` eintragen: `JARVIS_WEB_ORIGIN=https://andere-adresse.netlify.app`
3. Jarvis auf dem Computer starten (`start.bat` / `start.command`), dann die Netlify-Adresse in Chrome oder Edge öffnen. Fragt Chrome nach Zugriff auf Geräte im lokalen Netzwerk: **Zulassen**.

**Cloud-Modus (optional):** Ist der Computer aus, kann Jarvis über Netlify trotzdem sprechen und planen, aber nichts ausführen. Dafür in Netlify unter **Site configuration → Environment variables** anlegen:
- `ANTHROPIC_API_KEY` – API-Schlüssel von https://console.anthropic.com (kostet pro Nutzung, getrennt vom Claude-Abo)
- `JARVIS_PASSWORD` – ein langes Passwort, damit niemand sonst dein Guthaben verbraucht

**Ohne Passwort-Abfrage öffnen:** Öffne auf jedem Gerät einmal `https://DEINE-SEITE.netlify.app/?key=DEIN-JARVIS_PASSWORD`. Das Gerät merkt sich das Passwort, danach reicht die normale Adresse. Den Link nicht teilen.

Wichtig: Einfaches Drag-and-drop der ZIP bei Netlify lädt nur die Seite hoch, nicht den Cloud-Modus. Über GitHub verbunden funktioniert alles.

## Bedienung

- **„Jarvis, …“** sagen – zum Beispiel „Jarvis, öffne YouTube“ oder „Jarvis, recherchiere drei Geschäftsideen für Webdesign in meiner Stadt“.
- Nur **„Jarvis“** sagen → Signalton → dann den Befehl.
- Nach jeder Antwort hast du 6 Sekunden für eine Rückfrage ohne „Jarvis“.
- **Leertaste** oder Mikrofon-Taste = Sprechen ohne Wake-Word. **Esc** oder „Jarvis, stopp“ = abbrechen.
- Tippen geht auch, unten im Eingabefeld.
- **Neues Gespräch** löscht den Gesprächsverlauf, nicht das Gedächtnis.

## Was Jarvis darf

| Modus | Darf ohne Rückfrage |
|---|---|
| **Standard** | Web-Suche, Webseiten lesen, Dateien lesen, Programme/Webseiten öffnen, Dateien im Ordner `workspace/` anlegen und ändern |
| **Vollzugriff** (`JARVIS_FULL_ACCESS=1` in `.env`) | **Alles**, jeder Terminal-Befehl auf deinem Rechner |

Vollzugriff heißt: Ein falsch verstandener Satz kann echte Dateien löschen. Schalte ihn nur ein, wenn du das bewusst willst. Die erlaubten Befehle im Standardmodus stehen in `workspace/.claude/settings.json` und lassen sich dort erweitern.

## Anpassen

- **Persönlichkeit:** `persona.md` (Ton, Anrede „Chris“, Mission)
- **Gedächtnis:** `workspace/memory/chris.md` – Jarvis schreibt selbst hinein, du kannst es auch.
- **Ergebnisse:** Längere Texte, Pläne und Recherchen legt Jarvis in `workspace/ergebnisse/` ab.
- **Film-Stimme:** ElevenLabs-Schlüssel in `.env` eintragen; die Browser-Stimme ist kostenlos, klingt aber roboterhafter. In Edge klingen „Conrad“ und „Killian“ am besten.
- **Tempo:** `JARVIS_MODEL=haiku` antwortet am schnellsten, `opus` am klügsten. Standard ist `sonnet`.

## Gmail

Jarvis kann E-Mail-Entwürfe anlegen, bearbeiten und senden – aber **ausschließlich seine eigenen**. Jeder von Jarvis erzeugte Entwurf bekommt das Gmail-Label `JARVIS` und wird mit Message-ID und Thread-ID in `.secrets/gmail_jarvis.json` registriert. Vor jedem Bearbeiten oder Senden prüft `gmail.js` Register, Label und Thread-ID; fremde Nachrichten und Entwürfe werden abgelehnt.

1. OAuth-Client (Typ „Desktop-App“) als `.secrets/gmail_credentials.json` ablegen.
2. Einmal anmelden: `node gmail.js auth` (das Token landet in `.secrets/gmail_token.json`).
3. Verwenden:
   - `node gmail.js draft --to a@b.de --subject "Betreff" --body "Text"`
   - `node gmail.js update <draftId> --body "Neuer Text"`
   - `node gmail.js send <draftId>`
   - `node gmail.js list`

`.secrets/` ist per `.gitignore` von Git ausgeschlossen – Zugangsdaten und Tokens nie committen. Tests: `npm test`.

### Mail-Worker (Hintergrund)

`mail-worker.js` prüft alle 5 Minuten die registrierten Jarvis-Threads auf Antworten, Opt-outs und fällige Follow-ups (nach 3 und weiteren 5 Tagen, danach Schluss) und bearbeitet freigegebene Leads. Fremde Mails und Threads werden nie gelesen oder verändert. Entwürfe für Follow-ups und Erstkontakte entstehen 08:30–18:30; automatisch gesendet wird nur in zwei Versandläufen um 09:30 und 14:30 (Europe/Zurich, je höchstens 50, zusammen höchstens 100 erfolgreiche Sends pro Tag). Jeder Lauf wird vor dem ersten Send gespeichert und auch nach einem Neustart nicht wiederholt.

- Einstellungen: `.secrets/mail_worker/config.json`
  - `dryRun: true` – nur anzeigen. `sendMode: "drafts"` – nur Entwürfe. `sendMode: "compliant_auto"` + `dryRun: false` – versandberechtigte Mails werden selbst gesendet.
  - `offer` und `sender` (`name`, `company`, `email`, optional `signature`) müssen echt ausgefüllt sein; ohne `sender.name` wird nie gesendet und es gibt keine Erstkontakte.
- Selbst gesendet wird nur: Erstkontakte an Leads mit Versandgrundlage, Follow-ups und Antworten in genau diesen Threads. Alles andere bleibt Entwurf. Heikle Fälle (Verträge, Zahlungen, Rabatte, Passwörter, rechtliche Beschwerden, Unklares) sind immer Entwürfe mit Label `JARVIS-PRUEFEN`.
- Leads: `.secrets/mail_worker/leads.json` (nie ins Git):
  ```json
  [{ "email": "anna@firma.ch", "name": "Anna Muster", "company": "Firma AG", "website": "https://firma.ch", "language": "de",
     "approved": true, "consentBasis": "opt_in", "consentAt": "2026-09-01T10:00:00Z", "consentSource": "Kontaktformular",
     "existingCustomer": false, "similarService": false, "websiteIssues": ["Kontaktformular sendet nicht ab"] }]
  ```
  Versandgrundlage: `approved: true` und entweder `consentBasis: "opt_in"` mit `consentAt` und `consentSource`, oder `consentBasis: "existing_customer"` mit `existingCustomer: true` und `similarService: true`. Fehlt sie, setzt der Worker `"status": "blocked_no_legal_basis"` und schreibt den Lead nicht an. Eine öffentliche Adresse (z. B. info@) ist keine Grundlage.
- Jede werbliche Mail endet mit Absenderidentität und dem Satz „Falls Sie keine weiteren Nachrichten von mir wünschen, antworten Sie einfach mit «Abmelden».“ Ein `List-Unsubscribe`-Header wird bewusst nicht gesetzt: es gibt keinen HTTPS-Abmeldeendpunkt, und eine mailto-Abmeldung käme als neuer, fremder Thread an, den der Worker nicht lesen darf. Abmeldung per Antwort im Thread funktioniert dagegen sicher.
- Opt-outs: `.secrets/mail_worker/suppression.json` (dauerhaft), Log: `.secrets/mail_worker/worker.log`.
- Dry-Run ansehen: `npm run mail-plan` (`node mail-worker.js --dry-run`, ändert nie etwas). Einmal prüfen: `npm run mail-once`.
- Autostart einrichten: `powershell -ExecutionPolicy Bypass -File install-mail-worker.ps1` – fragt per UAC nach Administratorrechten, legt die Aufgabe „Jarvis Mail Worker“ an (Start bei Anmeldung, Neustart nach Fehler), ersetzt einen alten Worker-Prozess und prüft die Einrichtung. Entfernen mit `-Uninstall`.
- `node gmail.js send` verweigert ab 100 heute gesendeten Jarvis-Mails (Europe/Zurich).
- Cloud-Mailaufträge: Der Cloud-Jarvis legt nur strukturierte Aufträge in `/api/mail-requests` ab (Netlify Blobs, ohne Gmail-Zugang). Der lokale Mail-Worker holt sie ab, prüft sie nach denselben Regeln (Versandgrundlage, Suppression, Duplikate, Limits) und sendet nur im nächsten Versandfenster; das Ergebnis (`accepted_local`, `blocked`, `sent`, `failed`, `expired`) geht zurück in die Cloud.
- Ohne VPS läuft der Worker nur, solange der Rechner an, wach und online ist – siehe „Always-on Mail-Worker (VPS)“.

### Always-on Mail-Worker (VPS)

Derselbe `mail-worker.js` läuft 24/7 als Docker-Container auf dem Hetzner-VPS (`deploy/vps/`, Compose-Projekt `jarvis-mail` unter `/opt/jarvis-mail`, `restart: unless-stopped`, Healthcheck `node mail-worker.js --healthcheck`). Der Windows-PC ist für Mails dann nicht mehr nötig.

- **Mailklassen:** `automatic_sales_outreach` und `sales_followup` nur in den Fenstern 09:30/14:30 (je 50, Tag 100). `conversation_reply` und `manual_chris_mail` (Cloud-Auftrag von Chris) zeitnah rund um die Uhr – nach denselben Schutzregeln (Thread-Ownership, Opt-out, Suppression, Versandgrundlage, Duplikate, Limits).
- **Eskalation statt Auto-Antwort:** Vertrag, Zahlung/Bank, Rabatt, Preisänderung, Passwort/Secret, Beschwerde, verbindliche Zusage, unklare Identität, Telefonwunsch → nur Entwurf (`JARVIS-PRUEFEN`) und Meldung `mail_escalation` bzw. `human_contact_requested` in Cloud und Local.
- **send_authority:** Ist in Netlify `JARVIS_MAIL_WORKER_TOKEN` gesetzt, ist allein der VPS Sender: er übernimmt Cloud-Aufträge per Lease (`pending → processing → sent/blocked/failed`), holt vor jedem Gmail-Send ein serverseitiges Lock (Hash-Schlüssel, `lease_owner`, `lease_expires_at`, `status`; ein Lock geht nie an einen anderen Worker über) und meldet alle 2 Minuten einen Heartbeat. Der Windows-Worker erkennt das, merkt es sich in `.secrets/mail_worker/authority.json` und bleibt im Standby (kein Gmail, kein Versand). Ohne den Token bleibt alles wie bisher lokal.
- **Cloud-HUD:** Mail Service ONLINE/OFFLINE (Heartbeat jünger als 5 Minuten), Mail Worker VPS, Wartend, Gesendet heute, Blockiert, Eskalationen, Sales Morgen/Nachmittag/Tag.
- **Secrets nur auf dem VPS:** Gmail-Credentials, Token, Register und Worker-Zustand liegen in `/opt/jarvis-mail/secrets` (700/600, Container-User 1000), `/opt/jarvis-mail/.env` (600) enthält nur `JARVIS_MAIL_WORKER_TOKEN` und `ANTHROPIC_API_KEY` (Texte über die API, da auf dem VPS kein Claude Code angemeldet ist). Nichts davon geht nach Netlify, in den Browser oder ins Git.
- **Einrichtung (einmalig):** `.secrets/vps_worker.env` nach `deploy/vps/env.example` anlegen, dann `deploy/vps/deploy.sh <ssh-host> --with-secrets` (danach Updates ohne `--with-secrets`; vorhandene VPS-Secrets werden nie überschrieben). Erst wenn der Container gesund ist, in Netlify `JARVIS_MAIL_WORKER_TOKEN` (gleicher Wert) setzen und neu deployen – ab dann ist der VPS send_authority. Leads und Suppression werden ab da auf dem VPS gepflegt.

### Lead-Finder und Website-Audit (Hintergrund)

`lead-finder.js` sucht stündlich öffentliche Firmeneinträge mit Website aus OpenStreetMap (Overpass API; Gebiete und Branchen in `config.json` unter `discovery`, Ketten mit OSM-`brand` werden übersprungen) und prüft höchstens 3 Websites pro Lauf und 40 pro Tag mit `site-auditor.js`.

- Audit nur über normale Seitenaufrufe (robots.txt wird beachtet, 1,5 s Abstand je Anfrage): Erreichbarkeit, HTTP-Fehler, Zertifikat/HTTPS, Weiterleitungsschleifen, kaputte interne Links/Bilder (nur 404/410/5xx), Kontaktseite, Titel, Meta Description, viewport, lang, alt-Texte, Mixed Content, veraltete Technik, Ladezeit. Keine Formulare, keine Logins, keine Sicherheitstests. Layout-Darstellung wird ohne Browser nicht beurteilt.
- Jeder Befund hat `type`, `url`, `evidence`, `severity`, `detectedAt`. Ohne Befund kein Mangel.
- Ergebnisse: `.secrets/mail_worker/discovered.json` (nie ins Git). Gefundene Leads starten immer mit `approved: false`, `consentBasis: null`; mit Problemen und Kontaktadresse bekommen sie `status: "blocked_no_legal_basis"`. Sie werden **nie** automatisch angeschrieben – eine öffentliche Adresse ist keine Einwilligung.
- Steht dieselbe Firma bereits mit gültiger Versandgrundlage in `leads.json`, hängt der Finder nur die belegten `websiteIssues` dort an; die Mail nennt dann ausschliesslich diese Befunde.
- Kontakt nur aus Impressum/Kontaktseite/Startseite der Firma (Adresse auf der eigenen Domain). Inhaber nur, wenn das Impressum ihn ausdrücklich nennt.
- Score (`auditScore`, `scoreDetails`): Befunde (hoch 3, mittel 2, niedrig 1, max. 10) + Firmenname 2 + UID 2 + Impressum 1 + eigene Geschäftsadresse 2 − 3 bei unerreichbarer Website. Qualifiziert ab `minScore` (6) mit mindestens einem mittleren/hohen Befund.
- Von Hand: `node lead-finder.js --once` (ein Lauf), `node lead-finder.js --report`.

## Sicherheit

Der Server ist nur auf deinem eigenen Rechner erreichbar (localhost) und lehnt Anfragen fremder Webseiten ab. Stelle ihn nicht ins Internet.

### Kundenalarm und gemeinsamer Zustand Lokal ↔ Cloud

- Schreibt ein Kunde in einem eigenen Jarvis-Thread, dass er telefonieren, einen Termin oder persönlich sprechen möchte (`human-contact.js`, satzweise mit Kontext), entsteht sofort eine persistente Meldung `human_contact_requested` (Priorität hoch, je Gmail-Nachricht nur einmal), ein Windows-Toast „Jarvis – Kunde möchte persönlichen Kontakt“ und ein Hinweis im HUD. Die Antwort wird nur als Entwurf zur Prüfung vorbereitet – keine erfundenen Termine, Nummern oder Zusagen.
- `shared-state.js` definiert den sicheren gemeinsamen Zustand (Persona-Version, Notizen aus `memory/chris.md`, begrenzter Gesprächsverlauf, Meldungen, Worker-/Discovery-Zahlen). Alles wird per Whitelist neu aufgebaut; Tokens, Gmail-IDs, Leads, Suppression-Liste, Mailinhalte und lokale Pfade gelangen nie in die Cloud.
- Lokal liegt der Spiegel in `.secrets/shared_state.json`; der Worker und `server.js` gleichen ihn mit `/api/state` (Netlify Function + Netlify Blobs) ab. „Gelesen“ wird in beide Richtungen übernommen und nie wieder auf „ungelesen“ gesetzt. Gmail-Aktionen bleiben ausschliesslich lokal.
- Persona: `persona.md` ist die einzige Quelle. Die Cloud-Fassung erzeugt `npm run build:persona` (läuft auch beim Netlify-Build); Abschnitte zwischen `<!-- nur-lokal -->`-Markierungen gelten nur auf dem PC.
- Einrichtung: `npm run setup-sync` legt einen Sync-Token in `.secrets/jarvis_sync.json` an und zeigt ihn an. In Netlify als `JARVIS_SYNC_TOKEN` eintragen (neben `JARVIS_PASSWORD` und `ANTHROPIC_API_KEY`) und neu deployen.

### Vertrieb: genau zwei Angebote

`sales.js` ordnet jeden Lead ausschliesslich einer von drei Klassen zu – aus belegten Audit-Befunden (`websiteIssues` mit `type`, `url`, `evidence`, `severity`, `detectedAt`), nie erfunden:

- `REPAIR_CHECK_150` – „Check & Anleitung“ (CHF 150): Fehler prüfen und erklären, Schritt-für-Schritt-Anleitung – die Reparatur macht der Kunde selbst.
- `REPAIR_FIX_500` – „Check & Reparatur“ (CHF 480, die Klassen-ID bleibt aus Kompatibilität): kompletter Check, alle gefundenen Fehler beheben, Test auf Desktop und Smartphone; kein Fix, keine Rechnung.
- Beide Angebote stehen auf der Landingpage https://helvetic-webdesign-reperatur.netlify.app/ (`LANDING_PAGE_URL` in `sales.js`), die jede Werbemail verlinkt.
- `NONE`: kein Angebot begründbar (keine/zu wenig Befunde oder Website nicht erreichbar).

Jede Einordnung enthält `offer_class`, `confidence`, `evidence[]`, `rationale`, `recommended_next_step`. Lebenszyklus (abgeleitet, ohne Migration): discovered, audited, repair_candidate, blocked_no_legal_basis, approved, contacted, replied, customer, not_interested, do_not_contact. Die Versandgrundlage bleibt unverändert `legalBasis()` (opt_in / existing_customer) – eine öffentliche Adresse ist nie eine Grundlage.

- Verkauf erfassen: `node sales.js sale <domain> REPAIR_CHECK_150|REPAIR_FIX_500 [--date JJJJ-MM-TT]` (Wert kommt immer aus dem Angebot). Weitere: `status <domain> replied|not_interested`, `work <domain> open|in_progress|delivered`, `report`, `leads`.
- Daten: `.secrets/mail_worker/sales.json`, Kennzahlen `.secrets/mail_worker/metrics.json`. In die Cloud gehen nur die Zähler/CHF-Summen.
- HUD: Panel „Vertrieb“ und „LEADS“ (Lead-Details mit Befunden, Angebot, Versandgrundlage – nur im Local-Modus).

### Meldungen erledigen

„Erledigt“ im HUD entfernt eine Meldung lokal und in der Cloud. Ihre ID wird als Tombstone gemerkt (höchstens 500, 180 Tage; Älteres deckt ein Zeitstempel ab), deshalb taucht sie nach keinem Abgleich wieder auf.

### Local Core Autostart

`powershell -ExecutionPolicy Bypass -File install-local-core.ps1` legt die Aufgabe „Jarvis Local Core“ an (bei Anmeldung, unsichtbar, Neustart nach Fehlern; nur bei Bedarf UAC). Sie startet `node server.js --supervise`: ein Aufpasser startet den bestehenden Server und startet ihn nach Abstürzen neu. Der Server bindet nur 127.0.0.1; läuft schon ein Jarvis auf dem Port, beendet sich ein zweiter Start sofort. Healthcheck: `http://localhost:3000/api/health`, Log: `.secrets/local_core/core.log` (begrenzt, geschwärzt). Entfernen mit `-Uninstall`. Der Task „Jarvis Mail Worker“ bleibt davon unabhängig.

Das HUD erkennt automatisch LOCAL (Local Core erreichbar, PC-Zugriff) oder CLOUD (nur Gespräch) und prüft alle 20 Sekunden erneut – es wechselt selbst zurück auf LOCAL, sobald der Core online ist.
