// Release-Gate-Cleanup (TF-047): entfernt nur eindeutig test-eigene Reste und prüft, dass nichts übrig ist.
//   - Docker: Container/Volumes/Netze mit Lab-Label (jarvis.lab=tf044 / tf047) und die Lab-Compose-Projekte *-lab047, Lab-Image.
//   - Temp: nur Lauf-Verzeichnisse der Test-Runner (%TEMP%\jarvis-testrun-*) älter als 10 Minuten (abgebrochene Läufe).
//     NIE andere jarvis-* Verzeichnisse – insbesondere nie %TEMP%\jarvis-live-034-* (mögliche reale State-/Lead-Daten).
// Exit 0 = sauber, 1 = Reste vorhanden.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUN_PREFIX } from "./test-temp.mjs";

const LABELS = ["jarvis.lab=tf044", "jarvis.lab=tf047"];
const sh = (args) => { try { return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); } catch { return null; } };
const ids = (args) => (sh(args) || "").split(/\s+/).filter(Boolean);
let dockerUp = sh(["version", "--format", "{{.Server.Version}}"]) !== null;
const left = { containers: 0, volumes: 0, networks: 0, images: 0, temp_runs: 0 };
if (dockerUp) {
  for (const l of LABELS) {
    const c = ids(["ps", "-aq", "--filter", `label=${l}`]); if (c.length) sh(["rm", "-f", "-v", ...c]);
    const v = ids(["volume", "ls", "-q", "--filter", `label=${l}`]); if (v.length) sh(["volume", "rm", "-f", ...v]);
    const n = ids(["network", "ls", "-q", "--filter", `label=${l}`]); if (n.length) sh(["network", "rm", ...n]);
  }
  for (const p of ["jarvis-mail-lab047", "jarvis-repair-lab047"]) {
    const c = ids(["ps", "-aq", "--filter", `label=com.docker.compose.project=${p}`]); if (c.length) sh(["rm", "-f", "-v", ...c]);
    const n = ids(["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${p}`]); if (n.length) sh(["network", "rm", ...n]);
  }
  sh(["image", "rm", "-f", "jarvis-repair-worker:lab047"]);
  for (const l of LABELS) {
    left.containers += ids(["ps", "-aq", "--filter", `label=${l}`]).length;
    left.volumes += ids(["volume", "ls", "-q", "--filter", `label=${l}`]).length;
    left.networks += ids(["network", "ls", "-q", "--filter", `label=${l}`]).length;
  }
  for (const p of ["jarvis-mail-lab047", "jarvis-repair-lab047"]) left.containers += ids(["ps", "-aq", "--filter", `label=com.docker.compose.project=${p}`]).length;
  left.images = ids(["images", "-q", "jarvis-repair-worker:lab047"]).length;
}
const tmp = os.tmpdir();
for (const d of fs.readdirSync(tmp)) {
  if (!d.startsWith(RUN_PREFIX)) continue;
  const p = path.join(tmp, d);
  try { if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60_000) fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}
left.temp_runs = fs.readdirSync(tmp).filter((d) => d.startsWith(RUN_PREFIX) && Date.now() - fs.statSync(path.join(tmp, d)).mtimeMs > 10 * 60_000).length;
const live034 = fs.readdirSync(tmp).filter((d) => d.startsWith("jarvis-live-034-")).length;
console.log(JSON.stringify({ docker: dockerUp ? "checked" : "not running", left, live034_untouched: live034 }));
process.exit(Object.values(left).every((n) => n === 0) ? 0 : 1);
