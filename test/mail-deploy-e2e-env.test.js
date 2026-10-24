import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploy = () => fs.readFileSync(path.join(ROOT, "deploy", "vps", "deploy.sh"), "utf8");

test("Mail-Deploy prüft e2e.env mit sudo nach dem root-only Verzeichniswechsel", () => {
  const sh = deploy();
  assert.match(sh, /sudo test -f \/opt\/jarvis-payment\/e2e\.env/);
  assert.doesNotMatch(sh, /\[ -f \/opt\/jarvis-payment\/e2e\.env \]/,
    "der unprivilegierte Test darf nach chmod 700 nicht verwendet werden");
});

test("Mail-Deploy legt e2e.env nur bei Abwesenheit an und trunciert keine bestehende Datei", () => {
  const sh = deploy();
  assert.match(sh, /sudo install -m 600 \/dev\/null \/opt\/jarvis-payment\/e2e\.env/);
  assert.doesNotMatch(sh, /: > \/opt\/jarvis-payment\/e2e\.env/,
    "ein bestehender E2E-Konfigurationspfad darf nie geleert werden");
});

test("Mail-Compose bindet weiterhin genau die externe E2E-Konfiguration ein", () => {
  const compose = fs.readFileSync(path.join(ROOT, "deploy", "vps", "docker-compose.yml"), "utf8");
  assert.match(compose, /env_file:[\s\S]*\/opt\/jarvis-payment\/e2e\.env/);
});
