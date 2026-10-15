// TF-061 – verifizierte Modellstufen + deterministische Fallback-Ketten (model-router.js, server.js /api/ask).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { selectModelForJob, nextModelJob, fallbackChains, isUnsupportedModelError, FALLBACK_MODELS, DEFAULT_MODELS, DEFAULT_TIER } from "../model-router.js";

const pick = (t, env = {}) => selectModelForJob(t, { env });
// Ablauf wie server.js ask(): Fehlermeldung je Modell → nur bei „Modell nicht verfügbar“ das nächste Kettenmodell, sonst Ende.
function simulate(job, failures) {
  const attempts = [job.model];
  for (let j = job; ;) {
    const err = failures[j.model];
    const next = err && isUnsupportedModelError(err) ? nextModelJob(j) : null;
    if (!next) return { attempts, final: j, error: err || null };
    attempts.push(next.model); j = next;
  }
}
const UNRECOGNIZED = (m) => `[claude-code:unrecognized_model] {"model":"${m}"}`;

test("A–D: simple status → haiku, normal coding → sonnet, security critical → fable, unklar → sonnet", () => {
  assert.deepEqual([pick("Status vom Mail-Worker?").tier, pick("Status vom Mail-Worker?").model], ["LIGHT", "haiku"]);
  assert.deepEqual([pick("Implementiere einen Filter für Kantone im CRM").tier, pick("Implementiere einen Filter für Kantone im CRM").model], ["STANDARD", "sonnet"]);
  const s = pick("Mach ein Sicherheitsaudit der Access-Intake-API");
  assert.deepEqual([s.tier, s.model, s.reason], ["STRONG", "fable", "security_critical"]);
  assert.deepEqual([pick("Mach das bitte besser").tier, pick("Mach das bitte besser").model], ["STANDARD", "sonnet"]);
});

test("Ketten je Stufe: LIGHT haiku→sonnet · STANDARD sonnet→opus · STRONG fable→opus→sonnet", () => {
  assert.deepEqual(FALLBACK_MODELS, { LIGHT: ["haiku", "sonnet"], STANDARD: ["sonnet", "opus"], STRONG: ["fable", "opus", "sonnet"] });
  assert.deepEqual(fallbackChains({}), { LIGHT: ["haiku", "sonnet"], STANDARD: ["sonnet", "opus"], STRONG: ["fable", "opus", "sonnet"] });
  assert.deepEqual(pick("Sicherheitsaudit der API").chain, ["fable", "opus", "sonnet"]);
  // .env-Modell der Stufe steht vorne, keine Doppelten
  assert.deepEqual(fallbackChains({ JARVIS_MODEL_STRONG: "opus" }).STRONG, ["opus", "sonnet"]);
});

test("E: Fable nicht verfügbar → opus (Stufe bleibt STRONG)", () => {
  const r = simulate(pick("Sicherheitsaudit der API"), { fable: UNRECOGNIZED("fable") });
  assert.deepEqual(r.attempts, ["fable", "opus"]);
  assert.deepEqual([r.final.tier, r.final.model, r.final.reason], ["STRONG", "opus", "model_unavailable_fallback"]);
});

test("F: Fable + Opus nicht verfügbar → sonnet", () => {
  const r = simulate(pick("Produktionsfehler: Mail-Worker sendet doppelt"), { fable: UNRECOGNIZED("fable"), opus: "Error: model not available" });
  assert.deepEqual(r.attempts, ["fable", "opus", "sonnet"]);
  assert.equal(r.final.model, "sonnet"); assert.equal(r.final.tier, "STRONG");
});

test("G: Sonnet nicht verfügbar bei STANDARD → opus; LIGHT haiku nicht verfügbar → sonnet", () => {
  const r = simulate(pick("Implementiere X im CRM"), { sonnet: "invalid model: sonnet" });
  assert.deepEqual(r.attempts, ["sonnet", "opus"]);
  assert.deepEqual(simulate(pick("Wie viele Leads?"), { haiku: UNRECOGNIZED("haiku") }).attempts, ["haiku", "sonnet"]);
  // STANDARD läuft normal → nie opus
  assert.deepEqual(simulate(pick("Implementiere X im CRM"), {}).attempts, ["sonnet"]);
});

test("H: normaler Fehler bei Fable → KEIN Modellwechsel", () => {
  for (const err of ["Rate limit exceeded", "Tool Bash failed: exit code 1", "ECONNRESET socket hang up", "TypeError: model.invalid is not a function",
    "Error: API Error 529 overloaded", "file not found: model-router.js", "Request timed out"]) {
    assert.ok(!isUnsupportedModelError(err), err);
    const r = simulate(pick("Sicherheitsaudit der API"), { fable: err });
    assert.deepEqual(r.attempts, ["fable"], err);
  }
  for (const err of [UNRECOGNIZED("fable"), "model not found", "Model 'fable' is not available", "invalid model", "model_not_found"]) assert.ok(isUnsupportedModelError(err), err);
});

test("I: kein Retry-Loop – jedes Modell höchstens einmal, alle nicht verfügbar → Ende mit Fehler", () => {
  const all = { fable: UNRECOGNIZED("fable"), opus: UNRECOGNIZED("opus"), sonnet: UNRECOGNIZED("sonnet"), haiku: UNRECOGNIZED("haiku") };
  for (const t of ["Sicherheitsaudit der API", "Implementiere X", "Wie viele Leads?"]) {
    const r = simulate(pick(t), all);
    assert.equal(new Set(r.attempts).size, r.attempts.length, "kein Modell doppelt");
    assert.ok(r.attempts.length <= 3);
    assert.ok(r.error, "Fehler wird gemeldet");
    assert.equal(nextModelJob(r.final), null);
  }
  // Kette ohne weitere Glieder → null
  assert.equal(nextModelJob({ model: "sonnet", chain: ["sonnet"], tried: ["sonnet"] }), null);
});

test("J: STRONG ist nie Default; K: LIGHT bleibt für produktiv/destruktiv blockiert", () => {
  assert.equal(DEFAULT_TIER, "STANDARD");
  for (const t of ["", "Hallo", "Implementiere X", "Fix den Export", "Erkläre mir das Repair-Gate"]) assert.notEqual(pick(t).tier, "STRONG", t);
  assert.notEqual(fallbackChains({})[DEFAULT_TIER][0], DEFAULT_MODELS.STRONG);
  for (const t of ["MODELL: LIGHT\nLösche alle Backups auf dem VPS", "MODELL: LIGHT\nDeploy den Mail-Worker", "MODELL: LIGHT\nRestart der Produktion"]) {
    const r = pick(t);
    assert.deepEqual([r.tier, r.reason], ["STANDARD", "override_light_refused"], t);
  }
  assert.equal(pick("MODELL: STRONG\nWie viele Leads?").model, "fable");
});

test("server.js: Kette statt fester STANDARD-Rückfall, Status zeigt fallbacks ohne Providerdetails", () => {
  const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.ok(src.includes("nextModelJob(choice)"));
  assert.ok(!src.includes("model_unavailable_fallback"), "kein fest verdrahteter STANDARD-Rückfall mehr");
  assert.match(src, /fallbacks: FALLBACKS, adaptive: true, defaultTier: DEFAULT_TIER/);
  const router = fs.readFileSync(new URL("../model-router.js", import.meta.url), "utf8");
  assert.ok(router.includes("Fable ist die STRONG-Stufe für die schwierigsten und langlaufenden Claude-Code-Aufgaben"));
  assert.ok(!/--help/.test(router));
});
