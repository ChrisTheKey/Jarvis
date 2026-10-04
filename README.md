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

- **Persönlichkeit:** `persona.md` (Ton, Anrede „Sir“, Mission)
- **Gedächtnis:** `workspace/memory/sir.md` – Jarvis schreibt selbst hinein, du kannst es auch.
- **Ergebnisse:** Längere Texte, Pläne und Recherchen legt Jarvis in `workspace/ergebnisse/` ab.
- **Film-Stimme:** ElevenLabs-Schlüssel in `.env` eintragen; die Browser-Stimme ist kostenlos, klingt aber roboterhafter. In Edge klingen „Conrad“ und „Killian“ am besten.
- **Tempo:** `JARVIS_MODEL=haiku` antwortet am schnellsten, `opus` am klügsten. Standard ist `sonnet`.

## Sicherheit

Der Server ist nur auf deinem eigenen Rechner erreichbar (localhost) und lehnt Anfragen fremder Webseiten ab. Stelle ihn nicht ins Internet.
