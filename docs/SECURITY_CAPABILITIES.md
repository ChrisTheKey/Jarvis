# Lokale Capability-Sperre

`security-capabilities.js` ist der zentrale, fail-closed Policy-Kern für
externe und produktive Aktionen. Ohne eine explizite Runtime-Freigabe sind
alle Capabilities `DENY`:

- `lead_discovery`
- `lead_import`
- `gmail_draft`
- `gmail_send`
- `calling_live`
- `crm_write`
- `paid_api`

## Modi

- Kein `JARVIS_CAPABILITY_MODE`: alle Capabilities bleiben gesperrt.
- `JARVIS_CAPABILITY_MODE=approved` aktiviert ausschließlich die in
  `JARVIS_CAPABILITIES` kommasepariert genannten Capabilities.
- `JARVIS_CAPABILITY_MODE=synthetic` erlaubt nur ausdrücklich als synthetisch
  markierte Testpfade. Produktive Gmail-, Calling- und Paid-API-Pfade werden
  dadurch nicht freigeschaltet.

Fehlende oder unbekannte Capabilities führen zu `CAPABILITY_DENIED` bzw.
`UNKNOWN_CAPABILITY`; es gibt keinen permissiven Fallback.

## Entwicklungsregel

Tests verwenden In-Memory-/Temp-Fixtures und dürfen keine produktiven Adapter
instanziieren. Eine produktive Freigabe darf niemals aus Browserdaten,
Lead-Inhalten, Prompts oder `confirmed=true` abgeleitet werden. Die Agenten-
Sandbox (`network_access=false`, getrennte Worktrees und deny-Regeln) bleibt
zusätzlich aktiv; sie wird durch diese Policy nicht ersetzt.
