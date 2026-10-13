// npm test: Unit-Suite (node --test) in einem eigenen Temp-Verzeichnis, das danach vollständig entfernt wird (scripts/test-temp.mjs).
// Weitere Argumente werden an node --test durchgereicht (z. B. einzelne Testdateien).
import { runIsolated } from "./test-temp.mjs";
process.exit(runIsolated(["--test", ...process.argv.slice(2)]));
