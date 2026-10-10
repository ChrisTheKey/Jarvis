// Schweiz-Gebietsindex für die 24/7-Discovery: CH → Kanton → Gemeinde → Branche.
// Quelle ist die versionierte statische Datei data/swiss-municipalities.json (BFS-Gemeindeverzeichnis, siehe scripts/build-swiss-areas.mjs) –
// es wird bei keinem Discovery-Lauf etwas heruntergeladen.
//
// Rotation (persistent in discovery_geo.json, überlebt Neustarts):
//   - Hauptcursor über ALLE Gemeinden, geografisch fair verzahnt: reihum je Kanton eine Gemeinde (ZH, BE, LU, … JU, dann wieder ZH …),
//     innerhalb eines Kantons in BFS-Reihenfolge (nach Bezirk). Jede Gemeinde genau einmal je Zyklus, danach beginnt ein neuer Zyklus.
//   - Eine Abfrage je Gemeinde über alle Branchen. Liefert sie mehr Firmen, als ein Lauf je Gebiet prüfen darf (maxAuditsPerAreaPerRun),
//     oder ist sie gesättigt (Trefferlimit), kommen Folgeabfragen je Branche (Gemeinde → Branche) in eine kleine Warteschlange.
//     Die Warteschlange bekommt höchstens maxSplitSearchesPerRun der Abfragen eines Laufs – Grossstädte können die Prüfungen nie dominieren.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "swiss-municipalities.json");
export const GEO_FILE = "discovery_geo.json";

let cache = null;
export function swissIndex() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const municipalities = raw.municipalities.map(([bfs, name, canton, district, language]) => ({ bfs, name, canton, district, language, osmName: osmName(name) }));
  const byBfs = new Map(municipalities.map((m) => [m.bfs, m]));
  const cantons = raw.cantons.map((c) => ({ ...c, municipalities: municipalities.filter((m) => m.canton === c.code).length }));
  cache = { version: raw.version, source: raw.source, cantons, municipalities, byBfs, order: fairOrder(cantons, municipalities) };
  return cache;
}
// BFS-Namen tragen zur Unterscheidung oft den Kanton: "Reinach (AG)" → in OSM meist "Reinach".
export const osmName = (name = "") => String(name).replace(/\s*\((?:[A-Z]{2}|[A-Z]{2}\s*[,/].*)\)\s*$/, "").trim();

// Reihum je Kanton eine Gemeinde: früh im Zyklus sind alle 26 Kantone vertreten, kein Kanton wird bevorzugt.
export function fairOrder(cantons, municipalities) {
  const queues = cantons.map((c) => municipalities.filter((m) => m.canton === c.code).sort((a, b) => a.bfs - b.bfs));
  const order = [];
  for (let i = 0; order.length < municipalities.length; i++) for (const q of queues) if (q[i]) order.push(q[i].bfs);
  return order;
}

// Gebiet zu einem Ortsnamen (Legacy-Modus mit expliziter areas-Liste): nur bei eindeutigem Treffer, sonst null – nie geraten.
export function findMunicipality(name = "") {
  const { municipalities } = swissIndex();
  const n = String(name).trim().toLowerCase();
  const exact = municipalities.filter((m) => m.name.toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const loose = municipalities.filter((m) => m.osmName.toLowerCase() === osmName(name).toLowerCase());
  return loose.length === 1 ? loose[0] : null;
}

// Branchen-Bezeichnung für Lead-Datenbank, Filter und Export (Deutsch).
const CATEGORY_LABELS = {
  craft: "Handwerk", shop: "Geschäft", "office=company": "Firma / Büro", "office=estate_agent": "Immobilien", "amenity=restaurant": "Restaurant", "amenity=dentist": "Zahnarzt",
  "healthcare=physiotherapist": "Physiotherapie", "tourism=hotel": "Hotel", "office=accountant": "Treuhand", "shop=hairdresser": "Coiffeur", "office=lawyer": "Anwalt",
  "office=architect": "Architekt", "office=insurance": "Versicherung", "office=tax_advisor": "Steuerberatung", "office=it": "IT", "office=consulting": "Beratung",
  "amenity=cafe": "Café", "amenity=doctors": "Arztpraxis", "amenity=veterinary": "Tierarzt", "leisure=fitness_centre": "Fitness", "tourism=guest_house": "Gästehaus",
  "shop=car_repair": "Autogarage", "shop=beauty": "Kosmetik", "healthcare=doctor": "Arzt",
};
export const categoryKey = (c) => (c?.value ? `${c.key}=${c.value}` : String(c?.key || ""));
export const categoryLabel = (k) => CATEGORY_LABELS[k] || CATEGORY_LABELS[String(k).split("=")[0]] || (k ? String(k) : null);
// Branche eines OSM-Treffers: die spezifischste passende Kategorie (shop=hairdresser vor shop).
export function matchCategory(tags = {}, categories = []) {
  const specific = categories.filter((c) => c.value && tags[c.key] === c.value);
  if (specific.length) return categoryKey(specific[0]);
  const general = categories.find((c) => !c.value && tags[c.key] != null);
  return general ? categoryKey(general) : null;
}

// ---------- persistenter Cursor ----------
export function loadGeo(store, now = new Date()) {
  const idx = swissIndex();
  const g = store.read(GEO_FILE, null);
  const fresh = { version: 1, dataset: idx.version, cycle: 1, cursor: 0, cycle_started_at: now.toISOString(), cycles_completed: 0, last_cycle_completed_at: null,
    visited: 0, cantons_seen: [], queue: [], last: null };
  if (!g || g.dataset !== idx.version) return g ? { ...fresh, cycle: (g.cycle || 0) + 1, cycles_completed: g.cycles_completed || 0, last_cycle_completed_at: g.last_cycle_completed_at || null } : fresh;
  return { ...fresh, ...g, queue: Array.isArray(g.queue) ? g.queue : [], cantons_seen: Array.isArray(g.cantons_seen) ? g.cantons_seen : [] };
}
export const saveGeo = (store, g) => store.write(GEO_FILE, g, { compact: true });
const qKey = (j) => `${j.bfs}|${j.cat ?? "*"}`;
export function enqueue(g, job) {
  if (g.queue.length >= 5000 || g.queue.some((x) => qKey(x) === qKey(job))) return false;
  g.queue.push({ bfs: job.bfs, cat: job.cat ?? null, kind: job.kind || "split", ...(job.retryAt ? { retryAt: job.retryAt } : {}), tries: job.tries || 0 });
  return true;
}
// Nächste Abfrage: jede dritte Abfrage (Slot 2, 5, …) darf aus der Warteschlange kommen, höchstens maxSplit je Lauf; sonst Hauptcursor.
export function nextJob(g, { slot, splitUsed, maxSplit, now = new Date() }) {
  const idx = swissIndex();
  if (splitUsed < maxSplit && slot % 3 === 2) {
    const i = g.queue.findIndex((x) => !x.retryAt || Date.parse(x.retryAt) <= +now);
    if (i >= 0) {
      const [job] = g.queue.splice(i, 1);
      const m = idx.byBfs.get(job.bfs);
      if (m) return { ...job, m, fromQueue: true };
    }
  }
  const m = idx.byBfs.get(idx.order[g.cursor % idx.order.length]);
  return { bfs: m.bfs, cat: null, kind: "main", m, fromQueue: false };
}
// Nach erledigter Hauptabfrage: Cursor weiter, Zyklus ggf. abschliessen (neuer Zyklus beginnt sofort, Dedupe-/Audit-Alter-Regeln gelten weiter).
export function advance(g, m, now = new Date()) {
  const idx = swissIndex();
  g.cursor += 1; g.visited += 1;
  if (!g.cantons_seen.includes(m.canton)) g.cantons_seen.push(m.canton);
  g.last = { bfs: m.bfs, name: m.name, canton: m.canton, at: now.toISOString() };
  if (g.cursor >= idx.order.length) {
    Object.assign(g, { cycle: g.cycle + 1, cursor: 0, visited: 0, cantons_seen: [], cycles_completed: g.cycles_completed + 1, last_cycle_completed_at: now.toISOString(), cycle_started_at: now.toISOString() });
  }
}
// Abdeckung fürs Dashboard: nur Zahlen, Kantonskürzel und ein Gemeindename.
export function coverage(g) {
  const idx = swissIndex();
  return {
    mode: "FULL", dataset: idx.version, cantons_total: idx.cantons.length, municipalities_total: idx.municipalities.length,
    cycle: g?.cycle || 1, cycle_visited: g?.visited || 0, cycle_progress_pct: Math.round(((g?.visited || 0) / idx.municipalities.length) * 1000) / 10,
    cantons_covered_cycle: g?.cantons_seen?.length || 0, cycles_completed: g?.cycles_completed || 0, last_cycle_completed_at: g?.last_cycle_completed_at || null,
    current_canton: g?.last?.canton || null, current_municipality: g?.last?.name || null, queue: g?.queue?.length || 0,
  };
}
