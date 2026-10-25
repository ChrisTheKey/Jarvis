# Entfernung der autonomen Telefonie

Im lokalen Branch `agent-codex/main` wurden ausschließlich die eindeutig
autonomen LiveKit-Agenten-Komponenten entfernt:

- Agent-/Worker-Code und das separate `calling/`-Node-Unterprojekt
- VPS-Dockerfile, Compose-Datei, Token-Ableitung, Remote- und Deploy-Skripte
- die autonome Calling-Agent-Oberfläche und die dafür vorgesehenen Regressionstests

`/api/calling` bleibt als CRM-Lesezugriff für menschliche Vertriebsmitarbeiter
erhalten. Anruflisten, Telefonnummern aus CRM-Daten, Gesprächsnotizen,
Historien, Status, Rückrufplanung, Mitarbeiter-Dashboard, Verkaufsprozesse,
Zahlungslinks, Statistiken und Provisionen werden nicht entfernt. Der frühere
`call.start`-Pfad antwortet lokal mit `AUTONOMOUS_CALLING_REMOVED`; es existiert
kein Worker mehr, der daraus einen Telefonanruf ausführen könnte.

## Spätere Server-Bereinigung (nicht ausgeführt)

Nach separater Freigabe müssen auf dem Hetzner-Server zunächst die laufenden
Abhängigkeiten inventarisiert, der autonome Worker kontrolliert beendet, seine
Container-/Compose-/Deploy-Dateien entfernt und unbenutzte LiveKit-Variablen
aus dem Secret-Store bereinigt werden. SSH, Deployment, Containeränderungen und
Secret-Zugriffe waren Bestandteil dieser lokalen Umsetzung ausdrücklich nicht.

Bei unklarer gemeinsamer Nutzung darf nichts gelöscht werden; insbesondere die
menschliche CRM-Anrufoberfläche und die CRM-Datenmodelle bleiben bestehen.
