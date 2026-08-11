import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'data');
const dbPath = join(dataDir, 'jarvis.json');

const seed = () => ({
  contacts: [
    { id: 'c1', name: 'Pepper Potts', email: 'pepper@starkindustries.com', phone: '+1 212 555 0142', role: 'CEO, Stark Industries' },
    { id: 'c2', name: 'Happy Hogan', email: 'happy@starkindustries.com', phone: '+1 212 555 0177', role: 'Head of Security' },
    { id: 'c3', name: 'Rhodey Rhodes', email: 'j.rhodes@usaf.mil', phone: '+1 202 555 0119', role: 'USAF Liaison' },
  ],
  emails: [],
  events: [],
  expenses: [],
  notes: [],
});

let db = null;

function load() {
  if (db) return db;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (existsSync(dbPath)) {
    try {
      db = { ...seed(), ...JSON.parse(readFileSync(dbPath, 'utf8')) };
    } catch {
      db = seed();
    }
  } else {
    db = seed();
    persist();
  }
  return db;
}

function persist() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

export const store = {
  all() {
    return load();
  },
  get(collection) {
    return load()[collection] ?? [];
  },
  insert(collection, record) {
    const data = load();
    const row = { id: `${collection[0]}${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`, createdAt: new Date().toISOString(), ...record };
    data[collection] = [row, ...(data[collection] ?? [])];
    persist();
    return row;
  },
  update(collection, id, patch) {
    const data = load();
    const list = data[collection] ?? [];
    const idx = list.findIndex((row) => row.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch, updatedAt: new Date().toISOString() };
    persist();
    return list[idx];
  },
  remove(collection, id) {
    const data = load();
    const list = data[collection] ?? [];
    const idx = list.findIndex((row) => row.id === id);
    if (idx === -1) return null;
    const [row] = list.splice(idx, 1);
    persist();
    return row;
  },
  search(collection, query) {
    const needle = String(query || '').toLowerCase().trim();
    if (!needle) return this.get(collection);
    return this.get(collection).filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
  },
};
