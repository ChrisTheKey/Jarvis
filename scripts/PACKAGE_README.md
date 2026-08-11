# JARVIS 2.0 — Netlify-Paket

Fertig gebaut. Netlify muss hier nichts kompilieren.

## Hochladen

**Weg A — Ziehen und fallen lassen (kein Konto-Setup nötig)**

1. Diesen Ordner `jarvis-netlify` entpacken.
2. Auf [app.netlify.com/drop](https://app.netlify.com/drop) gehen.
3. Den **Ordner** (nicht die einzelnen Dateien) ins Fenster ziehen.
4. Fertig — du bekommst sofort eine Adresse `https://<name>.netlify.app`.

**Weg B — Netlify CLI**

```bash
npm install -g netlify-cli
cd jarvis-netlify
netlify deploy --prod
```

## Danach: Keys eintragen

Ohne Keys läuft JARVIS im lokalen Modus mit der Systemstimme — das genügt
bereits, und das Mikrofon funktioniert, weil die Adresse https ist.

Mehr geht über **Site configuration → Environment variables**:

| Variable | Wirkung |
| --- | --- |
| `ANTHROPIC_API_KEY` | JARVIS denkt mit und kombiniert mehrere Schritte. |
| `ELEVENLABS_API_KEY` | Echte JARVIS-Stimme statt Systemstimme. |
| `OPENAI_API_KEY` | Spracherkennung per Whisper — nötig für iPhone/Safari. |
| `JARVIS_ACCESS_CODE` | **Empfohlen.** Ohne diesen Code kein Zugriff auf die Server-Funktionen. |
| `ELEVENLABS_VOICE_ID` | Andere Stimme; Standard ist `h029Xu7odsKARnf0xDjw`. |

Nach dem Setzen der Variablen einmal **Deploys → Trigger deploy → Deploy site**
drücken, damit die Functions sie sehen.

Die Seite erkennt beim Start selbst, was der Server kann: Liegt ein
Anthropic-Key bereit, steht oben **„KI · Server"**, und das Key-Feld
verschwindet.

## Deine Adresse ist öffentlich

Wer die URL kennt, kann Anfragen auf deine Rechnung stellen. Setz deshalb
`JARVIS_ACCESS_CODE`. Anfragen von fremden Seiten werden ohnehin abgewiesen,
und Modell sowie Token-Grenze legt der Server fest, nicht der Browser.

## Auf dem Handy

Adresse öffnen → **„Stimme & KI" → „Als App installieren"**. Danach startet
JARVIS vom Startbildschirm ohne Browser-Leiste, und das Mikrofon funktioniert.

## Inhalt

```
netlify.toml        Routing (/api/* → Functions), Publish-Ordner, Header
site/index.html     die komplette App — eine Datei, kein Build
functions/
  status.mjs        meldet dem Browser, was dieser Server kann
  claude.mjs        Anthropic-Proxy, der Key bleibt auf dem Server
  speak.mjs         ElevenLabs-Stimme
  transcribe.mjs    Whisper-Spracherkennung
```
