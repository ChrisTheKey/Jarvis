# Jarvis – Capability Matrix: Local vs. Cloud vs. Mobile

Stand: 2026-10-09. Zielbild (Cloud-first seit 2026-10-07): **VPS = Gehirn und 24/7-Runtime (authoritative), Netlify = UI + authentifiziertes
Gateway, GitHub = Code, Windows-PC = OPTIONAL_CLIENT.** Ist der PC aus, ist das Gesamtsystem ONLINE; nur „Local Client“ ist OFFLINE.

Spalten:
- **Local** – Jarvis im LOCAL-Modus (Browser erreicht den Local Core auf dem PC, Claude Code läuft dort).
- **Cloud** – Jarvis im CLOUD-Modus (Browser spricht nur mit Netlify-Functions; der VPS holt alles ausgehend ab).
- **Mobile** – dieselbe Cloud-Oberfläche auf dem Smartphone (`https://chrisjarvis.netlify.app/`, Viewports 390×844 / 430×932).
- **Backend** – wo die Funktion tatsächlich läuft bzw. ihre Daten liegen.
- **Status** – `OK` (live, ohne PC), `OK (PC)` (nur mit PC), `TEILWEISE`, `LOCAL_ONLY` (bewusst nicht in die Cloud), `SAFE_CLOUD_EQUIVALENT` (sichere Cloud-Entsprechung).

Legende Mobile: ✅ voll nutzbar · 🟡 nur Zähler/Anzeige · ❌ nicht verfügbar (bewusst).

## Kernfunktionen

| Funktion | Local | Cloud | Mobile | Backend | Status |
|---|---|---|---|---|---|
| Chat/Conversation | Claude Code (`/api/ask`, Streaming) | Edge Function `/api/cloud` → Anthropic (Streaming, Persona identisch) | ✅ | Netlify Edge + Anthropic API | OK |
| Prompt senden | Composer (Enter sendet) | Composer (gleiches Markup) | ✅ Composer unten festgepinnt, 16-px-Feld, SENDEN/STOPP | – | OK |
| Antworten empfangen | SSE-Sätze, Sprache | SSE-Sätze, Browser-TTS | ✅ (TTS je nach Browser) | – | OK |
| Conversation State | Claude-Session auf dem PC + Spiegel in die Cloud | `shared-state` Blob: letzte 12 Beiträge, Reset | ✅ (Verlauf wird beim Start übernommen) | Netlify Blobs `jarvis-state` | OK |
| Memory/Business State | `workspace/memory/chris.md` (PC) + Profil-Notizen | Profil-Notizen (bereinigt) + Business/Sales nur vom Cloud Core | ✅ Anzeige | VPS Cloud Core → Blobs | OK (Notizen nur lesend in der Cloud) |
| Gmail Draft erstellen | Mail-Worker (Standby auf Windows → kein Entwurf vom PC) | `mail_request` mit `delivery: "draft"` → Queue → **VPS-Worker legt Entwurf in Gmail an** (COLD_LEAD_DRAFT_ONLY, nie sendbar) | ✅ „Schreib eine Mail an …“ = Entwurf; Status „Entwurf in Gmail“ im Mail-Panel + Link zu Gmail-Entwürfen | VPS Mail-Worker (Gmail-Token nur dort) | OK |
| Gmail Reply Draft erstellen | – | wie oben mit `optional_thread_reference` (nur eigene Jarvis-Threads); eingehende Antworten → Reply-ENTWURF durch den Worker | ✅ | VPS Mail-Worker | OK |
| Sichere Mail senden (manual_chris_mail) | – (Windows hat keine Send Authority) | `delivery: "send"` nur auf ausdrücklichen Sendebefehl → Worker prüft TF-024 Legal Gate, Suppression, Opt-out, Limits, Send-Lock | ✅ | VPS Mail-Worker | OK (Cold Leads: nie) |
| Cold Lead Draft | Discovery auf dem PC nur im Standby ohne Gmail-Schreibzugriff | Discovery + `individual_reviews` + Gmail-Entwurf durch den VPS-Worker, Label JARVIS, mode=COLD_LEAD_DRAFT_ONLY | ✅ Zähler (Cold Leads, Drafts erstellt/offen/manuell) + Entwürfe direkt in der Gmail-App | VPS `.secrets/mail_worker/` | OK – **immer COLD_LEAD_DRAFT_ONLY** |
| Leads anzeigen (Liste/Details) | LEADS-Dialog (`/api/leads`, Befunde, Evidence) | nur Zähler (Vertrieb-Panel) | 🟡 Zähler | Lead-Datenbank bleibt auf VPS/PC (Datenminimierung TF-022) | LOCAL_ONLY (Details) / SAFE_CLOUD_EQUIVALENT = Zähler; Detail-Liste über Server-Control-READ wäre ein möglicher nächster Schritt |
| Lead Status (Stage, Draft-Status) | Detailansicht | Zähler: Repair-Kandidaten, Blocked, Drafts offen, Kontaktiert, Antworten, Kunden | 🟡 | VPS Cloud Core → `sales` im Shared State | TEILWEISE (Zähler) |
| Cold-Draft-Aktionen (Edit/Discard/Mark manually sent) | `/api/cold-drafts/*` (Local Core, je genau ein Entwurf) | – (Entwurf wird in Gmail selbst bearbeitet/verworfen/gesendet; `syncColdDrafts` erkennt manuellen Versand) | 🟡 via Gmail-App | VPS Worker erkennt Versand | SAFE_CLOUD_EQUIVALENT (Gmail) |
| Suppression | Worker-Datei, gilt vor jedem Entwurf/Send | identisch (VPS-Worker) – auch für Cloud-Entwürfe | ✅ (wirkt automatisch; Zähler Opt-outs) | VPS `suppression.json` | OK |
| Opt-out | Erkennung in Antworten, dauerhaft | identisch (VPS) | ✅ Zähler | VPS | OK |
| Mail Queue | Anzeige Pending (Cloud) | `/api/mail-requests`: anlegen (nur Chris), Status lesen; Worker: claim/result/lock/heartbeat | ✅ Mail-Panel (letzte 12 Aufträge, Status, Grund) + QUEUE im Quick-Status | Netlify Blobs `jarvis-mail-requests` | OK |
| Mail Status (gesendet/blockiert/Eskalationen heute) | Status-Panel | Status-Panel + Quick-Status | ✅ | Worker-Heartbeat | OK |
| Notifications | Meldungen-Panel (Gelesen/Erledigt/Mit Jarvis besprechen) + Browser-Notification | identisch über `/api/state` (read/dismiss mit Tombstones) | ✅ ganz oben auf dem Handy | Netlify Blobs | OK |
| Human Escalation | Meldung `mail_escalation` / `human_contact_requested` (PRIORITÄT) | identisch | ✅ | VPS Worker → Cloud | OK |
| Scheduler (09:30/14:30, Discovery, Backup 03:00) | Anzeige | Anzeige (Core-Status im Heartbeat), Neustart via Server Control | ✅ Server-Panel | VPS Cloud Core | OK |
| VPS Status (Uptime, CPU, RAM, Disk, Docker, Container) | Server-Panel (mit Cloud-Passwort) | Server-Panel (`/api/server-control` READ aus VPS-Snapshot ≤ 3 min) | ✅ Server-Panel (aufklappbar) + SERVER CONTROL im Quick-Status | VPS-Agent (nur ausgehend) | OK |
| Server Control (Health Check, Backup, Restart Mail-Worker, Restart Core) | Buttons (feste Action-IDs) | identisch; Allowlist, Rate Limit, Audit; DANGEROUS (reboot, shell, docker exec …) immer 403 | ✅ Buttons ≥ 40 px, Bestätigung bei Restarts | Netlify Function + VPS-Agent | OK |
| Backup Status | Server-Panel | Server-Panel + Core-Status (letztes Backup, Generationen, offsite) | ✅ | VPS `backup.js` + Netlify Blobs `jarvis-backups` | OK |
| AI Service Status | Status-Panel | ONLINE / PAUSED — CREDIT LIMIT (fail closed) | ✅ Quick-Status | Worker-Heartbeat `ai_paused` | OK |
| Sales/Business State | Verkäufe + Vertrieb | identisch (nur Zähler/CHF-Summen vom Cloud Core) | ✅ (aufklappbar) | VPS → Blobs | OK |
| Health Checks | `/api/health` Local Core | `jarvis.runHealthCheck` (8 Checks) über Server Control; dr-probe (`scripts/dr-probe.mjs`) | ✅ Button | VPS | OK |
| Cloud Sync | Local Core pusht Client-Stand (`lastClientPushAt`) | Cloud Core pusht Core-Stand (`lastCorePushAt`); Business/Sales nur vom Core | ✅ Anzeige „Sync“ | Netlify Blobs | OK |
| Local Client Status | ONLINE | OFFLINE/STANDBY (gelb, kein Systemfehler) | ✅ WINDOWS CLIENT im Quick-Status | – | OK |

## Lokale Spezialfunktionen (bewusst nicht in die Cloud kopiert)

| Funktion | Local | Cloud/Mobile | Einstufung | Sichere Entsprechung |
|---|---|---|---|---|
| Lokale Dateien lesen/schreiben (Claude Code Tools) | ja (Workspace) | nein – `/api/cloud` hat keine Tools ausser `mail_request` | LOCAL_ONLY | keine (kein beliebiger Dateizugriff aus dem Browser) |
| Mikrofon / Wake-Word „Jarvis“ | Web Speech API im Browser | im Browser ebenfalls möglich (Mikrofon-Taste; Wake-Word auf Handys aus) | SAFE_CLOUD_EQUIVALENT | Browser-Mikrofon, kein Server-Audio |
| Audio-Ausgabe / ElevenLabs | ElevenLabs über Local Core (`/api/tts`, Key nur auf dem PC) | Browser-TTS | SAFE_CLOUD_EQUIVALENT | Browser-Stimme |
| Claude Code (Befehle ausführen, Programme öffnen) | ja (`claude -p`, optional Vollzugriff) | nein | LOCAL_ONLY | Chat/Planung in der Cloud; Server-Aktionen nur über die Allowlist |
| Lokale Hardware (CPU/RAM/Uptime des PCs) | Systeme-Panel | ausgeblendet | LOCAL_ONLY | VPS-Werte im Server-Panel |
| Lokale Entwicklung (Repo, Tests, Deploy-Skripte) | ja | nein | LOCAL_ONLY | GitHub (Code) + Netlify-Autodeploy |
| SSH/Admin-Funktionen (VPS-Shell, Docker, Secrets, Reboot) | nur Chris per SSH-Key | nie – `shell.exec`, `docker.exec`, `system.reboot`, `secrets.rotate` sind DANGEROUS (403) | LOCAL_ONLY | Server Control (feste Aktionen, Audit) |
| Gmail-Token, Anthropic-Key, Worker-/Sync-/Control-Token | nur `.secrets/` bzw. VPS `.env` (600 root) | nie im Browser, nie im Shared State (Whitelist + Redaction) | LOCAL_ONLY | – |

## Was ohne Windows funktioniert (verifiziert 2026-10-07 DR-Test A, 2026-10-09 dr-probe)
Chat, Conversation, Gmail-Drafts, Replies (Entwürfe), Queue, Leads (Zähler), Scheduler, Notifications, Server Control, Backups,
State, AI, Mail-Worker – alles auf dem VPS bzw. in Netlify. Windows liefert nur: Claude Code mit PC-Zugriff, Lead-Detailansicht,
Cold-Draft-Buttons, ElevenLabs-Stimme, lokale Dateien.

## Authority
- `send_authority`: VPS (`JARVIS_MAIL_WORKER_TOKEN` in Netlify gesetzt → `dedicated=true`, `holder=vps`). Windows-Worker: `standby_no_send_authority`.
- Business/Sales im Shared State werden nur vom Cloud Core übernommen (`ownsBusiness`), ein optionaler Client kann sie nie überschreiben.
- Cold Leads: `message_class=DRAFT_ONLY`, `legal_basis=NONE`, `manual_send_decision_required=true` – keine Aktion in Local, Cloud oder Mobile kann das ändern.
