// Repair Integration Lab (TF-044): echte Docker-Integration (OpenSSH/SFTP, SSH, WordPress REST + MariaDB, HTTPS über Caddy) –
// getrennt von der schnellen Unit-Suite (npm test). Release-Gate TF-044: npm run test:release-044 (Unit + Integration).
// Läuft nur lokal/isoliert (Docker Desktop bzw. Docker-Engine), nie auf dem Produktions-VPS; räumt Container/Volumes/Netze ab.
import { spawnSync } from "node:child_process";
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=1800000", ...process.argv.slice(2), "test/integration/repair-lab/repair-lab.integration.test.js"],
  { stdio: "inherit", env: { ...process.env, JARVIS_REPAIR_LAB: "1" } });
process.exit(r.status ?? 1);
