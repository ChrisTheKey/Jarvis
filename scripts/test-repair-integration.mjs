// Repair Integration Lab (TF-044): echte Docker-Integration (OpenSSH/SFTP, SSH, WordPress REST + MariaDB, HTTPS über Caddy) –
// getrennt von der schnellen Unit-Suite (npm test). Release-Gate TF-044: npm run test:release-044 (Unit + Integration).
// TF-045: --browser startet stattdessen die Browser-Integration (echtes Chromium gegen dasselbe Lab): npm run test:browser-integration.
// Release-Gate TF-045: npm run test:release-045 (Unit + TF-044-Lab + TF-045-Browser) – fehlt Docker oder Chromium, schlägt es fehl.
// Läuft nur lokal/isoliert (Docker Desktop bzw. Docker-Engine), nie auf dem Produktions-VPS; räumt Container/Volumes/Netze ab.
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const browser = args.includes("--browser");
const file = browser ? "test/integration/repair-lab/browser-validation.integration.test.js" : "test/integration/repair-lab/repair-lab.integration.test.js";
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=1800000", ...args.filter((a) => a !== "--browser"), file],
  { stdio: "inherit", env: { ...process.env, JARVIS_REPAIR_LAB: "1" } });
process.exit(r.status ?? 1);
