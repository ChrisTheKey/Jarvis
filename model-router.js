// Modellwahl je Jarvis-Auftrag (TF-059): immer nur so stark wie nötig. Deterministisch, ohne zusätzliche KI-Abfrage.
//
//   LIGHT     kleinstes/schnellstes Modell – Status, Zahlen, einfache Suche/Zusammenfassung, eine einfache Textänderung
//   STANDARD  Standard – normale Coding-/Debugging-/CRM-/Website-Aufgaben und alles Unklare (DEFAULT)
//   STRONG    stärkstes Modell – NUR Security, Architektur, Produktionsfehler, schwer reproduzierbare Bugs, riskante Migrationen
//             oder ausdrücklich „STANDARD reicht nicht“
//
// Fable ist die STRONG-Stufe für die schwierigsten und langlaufenden Claude-Code-Aufgaben; der lokale Alias wurde zusätzlich
// erfolgreich getestet. Unterstützte Aliasse = mit der installierten Claude-Code-Version (2.1.296) geprüft: `claude -p --model <alias>`
// lief für haiku, sonnet, opus und fable; ein unbekannter Name liefert „unrecognized_model“. Keine erfundenen Modellnamen.
// Fallback-Kette je Stufe (TF-061, FALLBACK_MODELS): jedes Modell höchstens einmal, weiter nur bei eindeutig „Modell nicht verfügbar“.
// Optionaler Override durch Chris als erste Zeile: „MODELL: LIGHT|STANDARD|STRONG“ (wird vor der Weitergabe entfernt).
// Ergebnis: { tier, model, reason } – reason ist ein kurzes Stichwort, nie ein Prompt-Auszug oder eine Begründungskette.
export const SUPPORTED_MODELS = Object.freeze(["haiku", "sonnet", "opus", "fable"]);
export const TIERS = Object.freeze(["LIGHT", "STANDARD", "STRONG"]);
export const DEFAULT_TIER = "STANDARD";
export const DEFAULT_MODELS = Object.freeze({ LIGHT: "haiku", STANDARD: "sonnet", STRONG: "fable" });
// STRONG fällt nie direkt auf sonnet: erst opus. STANDARD nimmt opus nur, wenn sonnet wirklich nicht verfügbar ist.
export const FALLBACK_MODELS = Object.freeze({ LIGHT: Object.freeze(["haiku", "sonnet"]), STANDARD: Object.freeze(["sonnet", "opus"]), STRONG: Object.freeze(["fable", "opus", "sonnet"]) });

// Modell je Stufe (überschreibbar per .env) – nur unterstützte Aliasse, sonst der geprüfte Standard der Stufe.
export function tierModels(env = process.env) {
  const pick = (v, d) => (SUPPORTED_MODELS.includes(String(v || "").trim().toLowerCase()) ? String(v).trim().toLowerCase() : d);
  return {
    LIGHT: pick(env.JARVIS_MODEL_LIGHT, DEFAULT_MODELS.LIGHT),
    // JARVIS_MODEL (bisher das eine statische Modell) gilt weiter als Standard-Stufe.
    STANDARD: pick(env.JARVIS_MODEL_STANDARD || env.JARVIS_MODEL, DEFAULT_MODELS.STANDARD),
    STRONG: pick(env.JARVIS_MODEL_STRONG, DEFAULT_MODELS.STRONG),
  };
}

// Kette je Stufe: das (ggf. per .env gesetzte) Modell der Stufe zuerst, dann die festen Ersatzmodelle – ohne Doppelte.
export function fallbackChains(env = process.env) {
  const models = tierModels(env);
  return Object.fromEntries(TIERS.map((t) => [t, [...new Set([models[t], ...FALLBACK_MODELS[t].slice(1)])]]));
}

// Nächster Versuch nach „Modell nicht verfügbar“: erstes noch nicht versuchtes Modell der Kette, sonst null (kein Retry-Loop).
// Die Stufe bleibt (ein STRONG-Auftrag bleibt STRONG, auch wenn er auf opus läuft).
export function nextModelJob(job) {
  const tried = Array.isArray(job?.tried) ? job.tried : [job?.model];
  const next = (job?.chain || []).find((m) => !tried.includes(m));
  return next ? { ...job, model: next, tried: [...tried, next], reason: "model_unavailable_fallback" } : null;
}

// ---------- Signale (auf kleingeschriebenem Text mit ä→ae, ö→oe, ü→ue, ß→ss – damit \b auch bei Umlauten greift) ----------
const fold = (s) => String(s).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/\s+/g, " ").trim();
const STRONG_RULES = [
  ["security_critical", /\b(security|sicherheitskritisch\w*|sicherheitsluecke\w*|sicherheitsaudit\w*|sicherheitspruefung\w*|vulnerab\w*|exploit\w*|cve-\d|pentest\w*|penetrationstest\w*|xss|csrf|sql[- ]?injection|privilege escalation|rechteausweitung)\b|\b(token|secret|schluessel|key|passwort)[- ]?rotation|\brotier\w* (den |die |das )?(token|secret|schluessel|passw)/],
  ["architecture", /\b(architektur\w*|architecture|systemdesign|system design|grundsatzentscheidung\w*)\b/],
  ["production_incident", /\b(produktions?(fehler|ausfall|incident|stoerung|problem)\w*|production (bug|incident|outage|failure)|outage|totalausfall|datenverlust|data loss)\b/],
  ["hard_to_reproduce", /\b(schwer|nicht) reproduzierbar|\b(intermittierend\w*|sporadisch\w*|race condition|heisenbug|deadlock|speicherleck|memory leak)\b/],
  ["risky_migration", /\b(migration|migrier\w*|datenbank[- ]?umzug|schema[- ]?aenderung)\b.*\b(produktiv\w*|produktion|production|live|risiko|risk|gross\w*|alle)\b|\b(grosse|riskante) migration/],
  ["standard_insufficient", /\bstandard(-?modell)? (reicht|genuegt) nicht|\bstaerkere?s? modell/],
];
// LIGHT ist für destruktive/produktive/sicherheitsrelevante oder versendende Aufträge nie erlaubt.
const NO_LIGHT_RE = /\b(loesch\w*|delete\w*|entfern\w*|remove\w*|drop|reset\w*|zuruecksetz\w*|deploy\w*|neu ?start\w*|restart\w*|produktion|production|kunden?website\w*|migration|rollback|force|ueberschreib\w*|secret\w*|token\w*|passw\w*|zugangsdaten|credential\w*|send\w*|versend\w*|schick\w*)\b/;
const CODING_RE = /\b(implementier\w*|implement\w*|refactor\w*|programmier\w*|code|coding|debug\w*|bug\w*|fehler\w*|fix\w*|beheb\w*|repar\w*|test\w*|funktion\w*|modul\w*|datei\w*|crm|website\w*|endpoint\w*|api|script\w*|skript\w*|feature\w*|analys\w*)\b/;
// „Finde den Bug …“ ist keine einfache Suche: echte Coding-/Analysearbeit bleibt mindestens STANDARD.
const REAL_WORK_RE = /\b(bug\w*|debug\w*|implementier\w*|implement\w*|refactor\w*|beheb\w*|repar\w*|programmier\w*|analys\w*|warum|why|ursache)\b/;
const LIGHT_RULES = [
  ["simple_count", /^(wie ?viele|anzahl|zaehl\w*|how many|count)\b/],
  ["simple_status", /^(status|stand|was ist der (aktuelle )?stand|laeuft|ist .{1,40} (online|aktiv|gesund)|wie spaet|uhrzeit|welches datum|datum)\b/],
  ["simple_lookup", /^(zeig\w*|liste\w*|list|finde?|such\w*|wo (ist|liegt|steht)|welche\w*|gibt es|show|find|where)\b/],
  ["simple_summary", /^(fasse\b.*\bzusammen|zusammenfass\w*|summar\w*|kurze? zusammenfassung)/],
  ["simple_edit", /^(aendere|ersetze|korrigiere|fix)\b.{0,80}\b(tippfehler|typo|rechtschreib\w*|titel|ueberschrift|wort|satz)\b/],
];
const LIGHT_MAX_CHARS = 220;

// Optionaler Override in der ersten Zeile. Unbekannte Stufe → ignoriert (normale Wahl), nie ein Absturz.
export function parseOverride(text = "") {
  const m = String(text).match(/^\s*MODELL\s*:\s*([A-Za-z]+)[ \t]*(?:\r?\n|$)/i);
  if (!m) return { tier: null, invalid: false, text: String(text) };
  const t = m[1].toUpperCase();
  const rest = String(text).slice(m[0].length).trim();
  return TIERS.includes(t) ? { tier: t, invalid: false, text: rest } : { tier: null, invalid: true, text: rest };
}

export function selectModelForJob(input, { env = process.env } = {}) {
  const models = tierModels(env);
  const chains = fallbackChains(env);
  const ov = parseOverride(typeof input === "string" ? input : "");
  const text = fold(ov.text);
  const out = (tier, reason) => {
    const model = models[tier] || DEFAULT_MODELS[tier];
    return { tier, model, reason, text: ov.text, chain: chains[tier], tried: [model] };
  };
  if (ov.tier) {
    // LIGHT nie für destruktive/produktive Aufträge – auch nicht auf Wunsch.
    if (ov.tier === "LIGHT" && NO_LIGHT_RE.test(text)) return out("STANDARD", "override_light_refused");
    return SUPPORTED_MODELS.includes(models[ov.tier]) ? out(ov.tier, "manual_override") : out(DEFAULT_TIER, "override_unsupported_fallback");
  }
  if (!text) return out(DEFAULT_TIER, "default_standard");
  for (const [reason, re] of STRONG_RULES) if (re.test(text)) return out("STRONG", reason);
  if (text.length <= LIGHT_MAX_CHARS && !NO_LIGHT_RE.test(text) && !REAL_WORK_RE.test(text)) {
    for (const [reason, re] of LIGHT_RULES) if (re.test(text)) return out("LIGHT", reason);
  }
  return out(DEFAULT_TIER, CODING_RE.test(text) ? "normal_coding" : ov.invalid ? "override_unknown" : "default_standard");
}

// Nur eindeutige Meldungen „Modell nicht verfügbar“ (unrecognized_model, model not found/available, invalid model) lösen den nächsten
// Kettenschritt aus. Normale Tool-/Code-/Netz-/Rate-Limit-Fehler wechseln das Modell nie.
export const isUnsupportedModelError = (s = "") =>
  /unrecognized_model|\bmodel[ _-]not[ _-](found|available)\b|\binvalid[ _-]model\b|\bmodel\b[^\n]{0,40}\b(is )?(not found|not available|nicht verfügbar)\b|not_found_error[^\n]{0,40}\bmodel\b/i.test(String(s));
