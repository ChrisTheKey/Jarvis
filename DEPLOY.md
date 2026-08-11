# JARVIS auf Netlify

Netlify ist für dieses Projekt die beste Variante: Du bekommst eine
https-Adresse (dadurch **funktioniert das Mikrofon**), und die Keys liegen auf
dem Server statt im Browser (dadurch **funktioniert der KI-Modus**) — beides
zusammen kann weder die gehostete Artifact-Fassung noch die lokale Datei.

## Einrichten (5 Minuten)

1. Auf [app.netlify.com](https://app.netlify.com) → **Add new site → Import an
   existing project → GitHub** → Repository `ChrisTheKey/Jarvis` wählen.
2. Branch auf `claude/jarvis-voice-dashboard-9phl5w` stellen (oder vorher nach
   `main` mergen).
3. **Build-Einstellungen nicht ausfüllen** — Befehl, Publish-Ordner und
   Functions stehen in `netlify.toml`.
4. Unter **Site configuration → Environment variables** eintragen, was du
   nutzen willst:

   | Variable | Wirkung |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | JARVIS denkt mit und kombiniert mehrere Schritte. Ohne die Variable läuft der lokale Befehlsmodus. |
   | `ELEVENLABS_API_KEY` | Er spricht mit der echten JARVIS-Stimme aus deinem n8n-Workflow statt mit der Systemstimme. |
   | `OPENAI_API_KEY` | Spracheingabe per Whisper — nötig für iPhone/Safari und Firefox, die keine eigene Erkennung haben. |
   | `JARVIS_ACCESS_CODE` | Empfohlen. Ohne Code kein Zugriff auf die Server-Funktionen. |
   | `ELEVENLABS_VOICE_ID` | Andere Stimme; Standard ist `h029Xu7odsKARnf0xDjw`. |

5. **Deploy** drücken. Nach dem Build steht die Seite unter
   `https://<name>.netlify.app`.
6. Adresse auf dem Handy öffnen → **„Stimme & KI“ → „Als App installieren“**.

Die Seite merkt beim Start selbst, was der Server kann: Steht ein
`ANTHROPIC_API_KEY` bereit, zeigt sie oben **„KI · Server“** und blendet das
Key-Feld aus — niemand muss mehr einen Key eintippen. Fehlt der Key, läuft
alles Weitere unverändert im lokalen Modus.

## Wichtig: Deine Netlify-Adresse ist öffentlich

Wer die URL kennt, kann Anfragen auf deine Rechnung stellen. Deshalb:

- **Setz `JARVIS_ACCESS_CODE`.** Dann verlangen alle Server-Funktionen diesen
  Code; JARVIS fragt ihn einmal ab und merkt ihn sich im Browser.
- Anfragen von fremden Seiten werden ohnehin abgewiesen (Origin-Prüfung), und
  Modell sowie Token-Obergrenze legt der Server fest, nicht der Browser.

Das ersetzt kein echtes Login. Wenn du es dicht willst, nimm zusätzlich
Netlifys eigenen Passwortschutz oder Netlify Identity.

## Was wo läuft

```
site/index.html          ← Kopie von standalone/jarvis.html (beim Build erzeugt)
netlify/functions/
  status.mjs             meldet dem Browser, was dieser Server kann
  claude.mjs             Anthropic-Proxy — der Key bleibt hier
  speak.mjs              ElevenLabs-Stimme
  transcribe.mjs         Whisper-Spracherkennung
```

Die Agenten selbst (Kalender, Mails, Kontakte, Ausgaben, Notizen) laufen
weiterhin im Browser und speichern in `localStorage`. Das ist Absicht: Deine
Daten verlassen das Gerät nicht, und die Functions bleiben zustandslos — was
sie auf Netlify ohnehin sein müssen.

## Ohne Keys deployen

Geht auch: Einfach ohne Environment-Variablen deployen. Dann hast du eine
https-Adresse mit funktionierendem Mikrofon, der Systemstimme und dem lokalen
Befehlsmodus — kostenlos und ohne laufende Kosten. Einen eigenen Anthropic-Key
kannst du bei Bedarf weiterhin im Browser unter „Stimme & KI“ eintragen.
