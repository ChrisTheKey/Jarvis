// TF-059 – adaptive Modellwahl (model-router.js): so stark wie nötig, Default STANDARD, STRONG nie ohne klares Signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectModelForJob, tierModels, parseOverride, isUnsupportedModelError, SUPPORTED_MODELS, DEFAULT_MODELS, DEFAULT_TIER } from "../model-router.js";

const env = {};
const pick = (t, e = env) => selectModelForJob(t, { env: e });

test("Simple Status / Count / Suche / Zusammenfassung → LIGHT", () => {
  for (const [t, reason] of [["Wie viele Leads sind im CRM?", "simple_count"], ["Status vom Mail-Worker?", "simple_status"], ["Läuft der Repair-Worker?", "simple_status"],
    ["Zeig mir die Datei PROJECT_STATE.md", "simple_lookup"], ["Fasse den letzten Report kurz zusammen", "simple_summary"], ["Korrigiere den Tippfehler im Titel der README", "simple_edit"]]) {
    const r = pick(t);
    assert.equal(r.tier, "LIGHT", t); assert.equal(r.model, "haiku"); assert.equal(r.reason, reason, t);
  }
});

test("Normale Coding-Aufgabe → STANDARD", () => {
  for (const t of ["Implementiere einen Filter für Kantone im CRM", "Finde den Bug im Export und behebe ihn", "Warum zeigt die Website-Liste doppelte Einträge?",
    "Refactor lead-crm.js und füge Tests hinzu"]) {
    const r = pick(t);
    assert.equal(r.tier, "STANDARD", t); assert.equal(r.model, "sonnet");
  }
  assert.equal(pick("Implementiere einen Filter für Kantone im CRM").reason, "normal_coding");
});

test("Security-/Architektur-/Produktions-/schwer reproduzierbare Aufgaben → STRONG", () => {
  for (const [t, reason] of [["Mach ein Sicherheitsaudit der Access-Intake-API", "security_critical"], ["Plane die Token-Rotation für den Mail-Worker", "security_critical"],
    ["Architekturentscheidung: Repair-Service aufteilen?", "architecture"], ["Produktionsfehler: Mail-Worker sendet doppelt", "production_incident"],
    ["Ein sporadischer Fehler, schwer reproduzierbar, im Scheduler", "hard_to_reproduce"]]) {
    const r = pick(t);
    assert.deepEqual([r.tier, r.model, r.reason], ["STRONG", "fable", reason], t);
  }
  assert.equal(pick("Grosse Migration aller Leads in die neue Produktion-DB").reason, "risky_migration");
});

test("Unklare Aufgabe → STANDARD (Default), leerer Text → STANDARD", () => {
  for (const t of ["Mach das bitte besser", "Hallo Jarvis", "", "Ich brauche Hilfe beim Angebot für Kunde X"]) {
    const r = pick(t);
    assert.equal(r.tier, "STANDARD", JSON.stringify(t));
  }
  assert.equal(DEFAULT_TIER, "STANDARD");
});

test("Expliziter Override → gewünschte unterstützte Stufe; Override-Zeile wird entfernt", () => {
  const r = pick("MODELL: STRONG\nWie viele Leads?");
  assert.deepEqual([r.tier, r.model, r.reason, r.text], ["STRONG", "fable", "manual_override", "Wie viele Leads?"]);
  assert.equal(pick("modell: light\nzeig mir die README").tier, "LIGHT");
  assert.equal(pick("MODELL: STANDARD\nArchitektur prüfen").tier, "STANDARD");
  // LIGHT nie für destruktive/produktive Aufträge – auch nicht per Override.
  const d = pick("MODELL: LIGHT\nLösche alle Backups auf dem VPS");
  assert.deepEqual([d.tier, d.reason], ["STANDARD", "override_light_refused"]);
  // Unbekannte Stufe → ignoriert, normale Wahl, kein Absturz.
  const u = pick("MODELL: TURBO\nWie viele Leads?");
  assert.equal(u.tier, "LIGHT"); assert.equal(u.text, "Wie viele Leads?");
  assert.equal(parseOverride("MODELL: GIGA").invalid, true);
});

test("Nicht unterstütztes Modell → sicherer Fallback, keine Crash-Schleife", () => {
  const bad = { JARVIS_MODEL: "gpt-9", JARVIS_MODEL_LIGHT: "bogus-model-x", JARVIS_MODEL_STRONG: "claude-ultra" };
  assert.deepEqual(tierModels(bad), DEFAULT_MODELS);
  assert.equal(pick("Wie viele Leads?", bad).model, "haiku");
  assert.equal(pick("MODELL: STRONG\nx", bad).model, "fable");
  assert.ok(Object.values(tierModels(bad)).every((m) => SUPPORTED_MODELS.includes(m)));
  // Claude Code meldet „unrecognized_model“ → server.js nimmt das nächste Modell der Kette (TF-061, model-router-061).
  assert.ok(isUnsupportedModelError('[claude-code:unrecognized_model] {"model":"bogus-model-x"}'));
  assert.ok(!isUnsupportedModelError("Rate limit exceeded"));
  // .env darf die Stufen auf andere unterstützte Aliasse setzen.
  assert.deepEqual(tierModels({ JARVIS_MODEL: "opus", JARVIS_MODEL_STRONG: "opus" }), { LIGHT: "haiku", STANDARD: "opus", STRONG: "opus" });
});

test("Beweis: das stärkste Modell wird NICHT standardmässig gewählt", () => {
  const sample = ["Wie viele Leads?", "Hallo", "Implementiere X", "Fix den Export", "Zeig mir den CRM-Status", "Schreib eine Mail an Kunde Y", "Ändere die Farbe im HUD",
    "Analysiere die Logs von gestern", "Baue eine neue Karte im Dashboard", "Erkläre mir das Repair-Gate", ""];
  const strong = sample.filter((t) => pick(t).tier === "STRONG");
  assert.deepEqual(strong, []);
  assert.notEqual(tierModels({})[DEFAULT_TIER], DEFAULT_MODELS.STRONG);
  // Nach einem STRONG-Auftrag kein dauerhaftes Hochstufen: der nächste Auftrag wird wieder normal gewählt.
  assert.equal(pick("Sicherheitsaudit der API").tier, "STRONG");
  assert.equal(pick("Wie viele Leads?").tier, "LIGHT");
  assert.equal(pick("Implementiere X").tier, "STANDARD");
});

test("server.js nutzt den Router statt eines statischen Modells; Status zeigt nur Stufe/Alias/Stichwort", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.ok(src.includes("selectModelForJob(text)"));
  assert.ok(!/"--model", MODEL,/.test(src), "kein statisches --model mehr");
  assert.ok(src.includes('"--model", choice.model'));
  assert.match(src, /lastJob = \{ tier: choice\.tier, model: choice\.model, reason: choice\.reason, at:/);
});
