// Branchen-Taxonomie (TF-061) – rein, ohne Imports, ohne Seiteneffekte: Discovery (swiss-areas.js), Lead-Registry und CRM
// (VPS-Dienst UND Netlify-Funktion) nutzen dieselbe Liste. Gespeicherte Rohwerte (z. B. „amenity=restaurant“) bleiben unverändert;
// das CRM übersetzt nur die Anzeige (displayCategory).
export const CATEGORY_LABELS = Object.freeze({
  craft: "Handwerk", shop: "Geschäft", "office=company": "Firma / Büro", "office=estate_agent": "Immobilien", "amenity=restaurant": "Restaurant", "amenity=dentist": "Zahnarzt",
  "healthcare=physiotherapist": "Physiotherapie", "tourism=hotel": "Hotel", "office=accountant": "Treuhand", "shop=hairdresser": "Coiffeur", "office=lawyer": "Anwalt",
  "office=architect": "Architekt", "office=insurance": "Versicherung", "office=tax_advisor": "Steuerberatung", "office=it": "IT", "office=consulting": "Beratung",
  "amenity=cafe": "Café", "amenity=doctors": "Arztpraxis", "amenity=veterinary": "Tierarzt", "leisure=fitness_centre": "Fitness", "tourism=guest_house": "Gästehaus",
  "shop=car_repair": "Autogarage", "shop=beauty": "Kosmetik", "healthcare=doctor": "Arzt",
});
export const categoryKey = (c) => (c?.value ? `${c.key}=${c.value}` : String(c?.key || ""));
// Discovery-Verhalten (unverändert aus swiss-areas.js): genauer Schlüssel, sonst Oberbegriff (shop=bakery → Geschäft), sonst Rohwert.
export const categoryLabel = (k) => CATEGORY_LABELS[k] || CATEGORY_LABELS[String(k).split("=")[0]] || (k ? String(k) : null);

const LABEL_BY_LOWER = new Map(Object.values(CATEGORY_LABELS).map((l) => [l.toLowerCase(), l]));
// CRM-Anzeige: bekannter OSM-Rohwert → deutsche Bezeichnung; bereits lesbarer Wert bleibt (nur Schreibweise einer bekannten
// Bezeichnung wird vereinheitlicht); unbekannter Rohwert bleibt wie vorhanden – nie geraten, keine KI.
export function displayCategory(raw) {
  const v = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!v) return null;
  const k = v.toLowerCase().replace(/\s*=\s*/, "=");
  return CATEGORY_LABELS[k] || LABEL_BY_LOWER.get(k) || (k.includes("=") && CATEGORY_LABELS[k.split("=")[0]]) || v;
}
