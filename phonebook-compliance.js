// TF-077B PhonebookComplianceProvider – Telefonbuch-Sternchen («Keine Werbung», search.ch-Feld tel:nopromo) ohne Abhängigkeiten
// (CRM-Dienst, Netlify-Funktion, Tests).
//
//   PHONEBOOK_STAR_PRESENT   ausdrücklicher, strukturierter Beleg (tel:nopromo positiv) → Nummer nie für Werbe-/Kaltanrufe, auch nicht mit
//                            CONTACT_FORM_P0; die Nummer wird im CRM nicht als anrufbar geführt (phone_tel entfällt, Text bleibt sichtbar).
//   PHONEBOOK_STAR_CLEAR     ausdrücklicher Beleg einer erfolgreichen Abfrage OHNE Sternchen (Quelle + Zeitpunkt + Nummer).
//   PHONEBOOK_STAR_UNKNOWN   kein Beleg («Telefonbuch: NICHT GEPRÜFT») – nie als CLEAR behandelt, nie Beweis für «kein Sternchen».
//   PHONEBOOK_LOOKUP_FAILED  Abfrage technisch gescheitert.
//
// Es gibt derzeit KEINEN erlaubten/konfigurierten Massen-Anbieter: Jarvis fragt search.ch nicht ab und scrapt kein Verzeichnis
// (PHONEBOOK_PROVIDER_NOT_CONFIGURED). Ein Sternchen wird NIE aus einer formatierten Telefonnummer («*» im Text) abgeleitet und nie entfernt.
export const PHONEBOOK_STATES = Object.freeze(["PHONEBOOK_STAR_CLEAR", "PHONEBOOK_STAR_PRESENT", "PHONEBOOK_STAR_UNKNOWN", "PHONEBOOK_LOOKUP_FAILED"]);
export const PROVIDER_NOT_CONFIGURED = "PHONEBOOK_PROVIDER_NOT_CONFIGURED";
export const NOPROMO_FIELD = "tel:nopromo"; // offizielles strukturiertes Feld der search.ch-Telefonbuch-API
const ISO = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const E164 = /^\+\d{8,15}$/;

// Beleg aus einem gespeicherten Datensatz (Kontaktverzeichnis: { phonebook: { status|nopromo|"tel:nopromo", source, checked_at, phone } }).
// Nur strukturierte Felder zählen. Positiv = "*", true, "1", "yes". CLEAR nur mit ausdrücklich negativem Ergebnis + Quelle + Zeitpunkt.
export function phonebookFromRecord(rec, phoneE164 = null) {
  const pb = rec && typeof rec === "object" ? rec.phonebook : null;
  if (!pb || typeof pb !== "object") return { status: "PHONEBOOK_STAR_UNKNOWN", source: null, checked_at: null };
  const src = typeof pb.source === "string" ? pb.source.slice(0, 40) : null, at = ISO(pb.checked_at);
  // Der Beleg gilt nur für die Nummer, für die er erhoben wurde.
  if (pb.phone && phoneE164 && E164.test(String(pb.phone)) && pb.phone !== phoneE164) return { status: "PHONEBOOK_STAR_UNKNOWN", source: src, checked_at: at };
  const raw = pb[NOPROMO_FIELD] ?? pb.nopromo;
  if (pb.status === "PHONEBOOK_STAR_PRESENT" || raw === true || raw === "*" || raw === 1 || /^(true|yes|1|\*)$/i.test(String(raw ?? ""))) return { status: "PHONEBOOK_STAR_PRESENT", source: src, checked_at: at };
  if (pb.status === "PHONEBOOK_LOOKUP_FAILED") return { status: "PHONEBOOK_LOOKUP_FAILED", source: src, checked_at: at };
  if ((pb.status === "PHONEBOOK_STAR_CLEAR" || raw === false) && src && at) return { status: "PHONEBOOK_STAR_CLEAR", source: src, checked_at: at };
  return { status: "PHONEBOOK_STAR_UNKNOWN", source: src, checked_at: at };
}

// Einzelner, bereits vorliegender search.ch-Eintrag (z. B. aus einer erlaubten Einzelabfrage): <tel:nopromo> vorhanden und nicht leer → Sternchen.
export function phonebookFromSearchChEntry(entry, { checked_at = null } = {}) {
  if (!entry || typeof entry !== "object") return { status: "PHONEBOOK_LOOKUP_FAILED", source: "search.ch", checked_at };
  const v = entry[NOPROMO_FIELD];
  return { status: v != null && String(v).trim() !== "" ? "PHONEBOOK_STAR_PRESENT" : "PHONEBOOK_STAR_CLEAR", source: "search.ch", checked_at };
}

// Anbieter: ohne erlaubte, konfigurierte Quelle immer NOT_CONFIGURED – lookup liefert UNKNOWN und ruft nichts ab.
export function createPhonebookProvider(cfg = {}) {
  const lookup = typeof cfg.lookup === "function" && cfg.permitted === true ? cfg.lookup : null;
  return {
    configured: !!lookup, state: lookup ? "PHONEBOOK_PROVIDER_CONFIGURED" : PROVIDER_NOT_CONFIGURED,
    async lookup(phoneE164) {
      if (!lookup) return { status: "PHONEBOOK_STAR_UNKNOWN", reason: PROVIDER_NOT_CONFIGURED };
      try { const r = await lookup(phoneE164); return PHONEBOOK_STATES.includes(r?.status) ? r : { status: "PHONEBOOK_LOOKUP_FAILED" }; }
      catch { return { status: "PHONEBOOK_LOOKUP_FAILED" }; }
    },
  };
}

// Künftige Aufnahme neuer Leads (TF-077B §28): verifizierter Fehler + (mit konfiguriertem Anbieter) Telefonbuch CLEAR. Ohne Anbieter wird
// nur PHONEBOOK_PROVIDER_NOT_CONFIGURED festgehalten – kein erfundenes Ergebnis, bestehende Leads bleiben sichtbar (NICHT GEPRÜFT).
export function phonebookAdmission(phonebook, { providerConfigured = false } = {}) {
  const s = phonebook?.status || "PHONEBOOK_STAR_UNKNOWN";
  if (s === "PHONEBOOK_STAR_PRESENT") return { ok: true, callable: false, state: s }; // Lead bleibt (E-Mail), Nummer nie anrufbar
  if (!providerConfigured) return { ok: true, callable: s === "PHONEBOOK_STAR_CLEAR", state: PROVIDER_NOT_CONFIGURED };
  return { ok: s === "PHONEBOOK_STAR_CLEAR", callable: s === "PHONEBOOK_STAR_CLEAR", state: s };
}
