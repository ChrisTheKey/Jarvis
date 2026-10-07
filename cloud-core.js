// Jarvis Cloud Core (VPS): Schema-Version des Operational State, Migrationen und der Core-Status für das HUD.
// Läuft im selben Prozess wie der Mail-Worker (eine Runtime, ein Schreiber pro Datei – keine Doppelzugriffe auf die JSON-Stores).
// Kein offener Port: Der Status geht nur ausgehend als Heartbeat an Netlify. Keine Adressen, IDs oder Secrets im Status.
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_FILE = "schema.json";
// Version des Operational State in WORKER_DIR. Jede Erhöhung braucht eine Migration in MIGRATIONS.
export const STATE_SCHEMA_VERSION = 1;
// Migrationen: idempotent, nur additiv (nie historische Daten überschreiben). v1 = Ausgangsstand (JSON-Stores wie seit TF-021/024/025).
export const MIGRATIONS = [
  { version: 1, name: "baseline", up: () => {} },
];

export class SchemaTooNewError extends Error {
  constructor(found) { super(`Operational State hat Schema ${found}, dieser Code kennt nur ${STATE_SCHEMA_VERSION} – fail closed.`); this.code = "SCHEMA_TOO_NEW"; }
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Bringt WORKER_DIR auf STATE_SCHEMA_VERSION. Neuerer Stand als der Code → SchemaTooNewError (der Worker startet dann nicht).
export function migrateStateDir(dir, { now = () => new Date(), migrations = MIGRATIONS, target = STATE_SCHEMA_VERSION } = {}) {
  const file = path.join(dir, SCHEMA_FILE);
  const cur = readJson(file, null);
  const from = Number.isInteger(cur?.version) ? cur.version : 0;
  if (from > target) throw new SchemaTooNewError(from);
  const history = Array.isArray(cur?.history) ? cur.history : [];
  const applied = [];
  for (const m of migrations.filter((x) => x.version > from && x.version <= target).sort((a, b) => a.version - b.version)) {
    m.up(dir);
    applied.push(m.version);
    history.push({ version: m.version, name: m.name, at: now().toISOString() });
    writeAtomic(file, { version: m.version, history }); // nach jeder Migration festhalten – Abbruch setzt dort wieder an
  }
  return { from, to: applied.length ? applied.at(-1) : from, applied };
}

export function schemaVersion(dir) { const v = readJson(path.join(dir, SCHEMA_FILE), null)?.version; return Number.isInteger(v) ? v : 0; }

// Core-Status für Heartbeat/HUD: nur Zahlen, Zeitpunkte und feste Zustandswörter.
export function coreStatus({ dir, role, startedAt, now = new Date(), windows = [], zurichDay, backup = null }) {
  const state = readJson(path.join(dir, "state.json"), {});
  const disc = readJson(path.join(dir, "discovered.json"), {});
  const today = zurichDay ? zurichDay(now) : null;
  const done = (today && state.windows?.[today]) || {};
  return {
    role: role === "vps" ? "vps" : "local",
    started_at: startedAt || null,
    schema_version: schemaVersion(dir),
    scheduler: {
      tz: "Europe/Zurich",
      ...Object.fromEntries(windows.map((w) => [w.id, { start: w.start, limit: w.limit, executed: !!done[w.id] }])),
    },
    discovery_last_run: typeof disc.lastRunAt === "string" ? disc.lastRunAt : null,
    backup: backup ? { last_at: backup.last_at || null, ok: backup.ok === true, generations: Number(backup.generations) || 0 } : null,
  };
}

// Whitelist für die Cloud: was nicht hier steht, kommt nicht in den Heartbeat.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, HM_RE = /^\d{2}:\d{2}$/;
const iso = (v) => (typeof v === "string" && ISO_RE.test(v) ? v : null);
const int = (v, max = 1_000_000) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0);
export function cleanCore(c) {
  if (!c || typeof c !== "object") return null;
  const win = (w) => (w && typeof w === "object" ? { start: HM_RE.test(w.start) ? w.start : null, limit: int(w.limit, 1000), executed: w.executed === true } : null);
  return {
    role: c.role === "vps" ? "vps" : "local",
    started_at: iso(c.started_at),
    schema_version: int(c.schema_version, 10_000),
    scheduler: { tz: "Europe/Zurich", morning: win(c.scheduler?.morning), afternoon: win(c.scheduler?.afternoon) },
    discovery_last_run: iso(c.discovery_last_run),
    backup: c.backup && typeof c.backup === "object" ? { last_at: iso(c.backup.last_at), ok: c.backup.ok === true, generations: int(c.backup.generations, 1000) } : null,
  };
}
