// Repair Integration Lab (TF-044): echte Docker-Integration (OpenSSH/SFTP, SSH, WordPress REST + MariaDB, HTTPS über Caddy) –
// getrennt von der schnellen Unit-Suite (npm test). Release-Gate TF-044: npm run test:release-044 (Unit + Integration).
// TF-045: --browser startet stattdessen die Browser-Integration (echtes Chromium gegen dasselbe Lab): npm run test:browser-integration.
// Release-Gate TF-045: npm run test:release-045 (Unit + TF-044-Lab + TF-045-Browser) – fehlt Docker oder Chromium, schlägt es fehl.
// TF-046: --full-order startet den vollständigen Kundenauftrag (Full Order Dry-Run) gegen dasselbe Lab mit echtem Chromium:
// npm run test:full-order-integration. Release-Gate TF-046: npm run test:release-046 (Unit + TF-044 + TF-045 + TF-046) – ohne Skip.
// Läuft nur lokal/isoliert (Docker Desktop bzw. Docker-Engine), nie auf dem Produktions-VPS; räumt Container/Volumes/Netze ab.
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const browser = args.includes("--browser");
const fullOrder = args.includes("--full-order");
const file = fullOrder ? "test/integration/full-order-046/full-order.integration.test.js"
  : browser ? "test/integration/repair-lab/browser-validation.integration.test.js" : "test/integration/repair-lab/repair-lab.integration.test.js";
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=1800000", ...args.filter((a) => a !== "--browser" && a !== "--full-order"), file],
  { stdio: "inherit", env: { ...process.env, JARVIS_REPAIR_LAB: "1" } });
process.exit(r.status ?? 1);
