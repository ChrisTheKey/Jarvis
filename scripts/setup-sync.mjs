// Richtet den Abgleich Lokal ↔ Cloud ein: legt (falls noch nicht vorhanden) einen zufälligen JARVIS_SYNC_TOKEN
// in .secrets/jarvis_sync.json an und zeigt ihn EINMAL an, damit Chris ihn in Netlify als Umgebungsvariable einträgt.
// Der Token steht nie im Repository und nie in Task-Argumenten.
//   node scripts/setup-sync.mjs
import { ensureSyncToken, syncConfig, SYNC_FILE } from "../local-state.js";

const { created } = ensureSyncToken();
const { token, url } = syncConfig();
console.log(created ? `Neuer Sync-Token angelegt: ${SYNC_FILE}` : `Vorhandener Sync-Token: ${SYNC_FILE}`);
console.log(`\nIn Netlify (Site configuration → Environment variables) eintragen:\n  JARVIS_SYNC_TOKEN = ${token}\n`);
console.log(`Danach neu deployen. Der lokale Worker gleicht dann mit ${url} ab.`);
