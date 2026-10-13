// Repair Integration Lab (TF-044): echte Docker-Integration (OpenSSH/SFTP, SSH, WordPress REST + MariaDB, HTTPS über Caddy) –
// getrennt von der schnellen Unit-Suite (npm test). Release-Gate TF-044: npm run test:release-044 (Unit + Integration).
// TF-045: --browser startet stattdessen die Browser-Integration (echtes Chromium gegen dasselbe Lab): npm run test:browser-integration.
// Release-Gate TF-045: npm run test:release-045 (Unit + TF-044-Lab + TF-045-Browser) – fehlt Docker oder Chromium, schlägt es fehl.
// TF-046: --full-order startet den vollständigen Kundenauftrag (Full Order Dry-Run) gegen dasselbe Lab mit echtem Chromium:
// npm run test:full-order-integration. Release-Gate TF-046: npm run test:release-046 (Unit + TF-044 + TF-045 + TF-046) – ohne Skip.
// TF-047: --separation startet das Service-Separation-Lab (Mail-Worker + separater Repair-Service, echtes repair-remote.sh):
// npm run test:separation-integration. Release-Gate TF-047: npm run test:release-047.
// Läuft nur lokal/isoliert (Docker Desktop bzw. Docker-Engine), nie auf dem Produktions-VPS; räumt Container/Volumes/Netze ab.
// Temp-Verzeichnisse des Laufs liegen in einem eigenen Lauf-Verzeichnis und werden danach entfernt (scripts/test-temp.mjs).
import { runIsolated } from "./test-temp.mjs";
const args = process.argv.slice(2);
const flags = ["--browser", "--full-order", "--separation"];
const file = args.includes("--separation") ? "test/integration/service-separation-047/separation.integration.test.js"
  : args.includes("--full-order") ? "test/integration/full-order-046/full-order.integration.test.js"
  : args.includes("--browser") ? "test/integration/repair-lab/browser-validation.integration.test.js" : "test/integration/repair-lab/repair-lab.integration.test.js";
process.exit(runIsolated(["--test", "--test-concurrency=1", "--test-timeout=1800000", ...args.filter((a) => !flags.includes(a)), file], { env: { JARVIS_REPAIR_LAB: "1" } }));
