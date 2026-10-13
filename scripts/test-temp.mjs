// Test-Temp-Isolation (TF-047): jeder Testlauf bekommt EIN eigenes, frisches Temp-Verzeichnis (%TEMP%\jarvis-testrun-*) als
// TEMP/TMP/TMPDIR. Alle mkdtemp-Verzeichnisse der Tests (jarvis-*) entstehen darin und verschwinden mit ihm am Ende des Laufs.
// Es wird ausschliesslich dieses vom Lauf selbst angelegte Verzeichnis gelöscht – nie etwas anderes im echten %TEMP%
// (insbesondere nie %TEMP%\jarvis-live-034-*, die reale State-/Lead-Daten enthalten können).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const RUN_PREFIX = "jarvis-testrun-";

export function runIsolated(nodeArgs, { env = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), RUN_PREFIX));
  try {
    const r = spawnSync(process.execPath, nodeArgs, { stdio: "inherit", env: { ...process.env, ...env, TEMP: base, TMP: base, TMPDIR: base } });
    return r.status ?? 1;
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}
