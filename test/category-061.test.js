// TF-061 – lesbare CRM-Branchen aus der gemeinsamen Taxonomie (category-labels.js). Rohdaten bleiben unverändert. Nur synthetische Daten.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CATEGORY_LABELS, categoryLabel, categoryKey, displayCategory } from "../category-labels.js";
import * as swiss from "../swiss-areas.js";
import { makeSources, writeSources } from "./crm-fixture.js";
import { buildCrmView, cleanCrmLead } from "../lead-crm.js";
import { createSourceReader, loadCrm } from "../crm-service.js";
import { filterLeads, searchMatch } from "../public/crm-model.js";
import { historyRecord, emptyHistory, upsertHistory, HISTORY_FILE } from "../discovery-history.js";

const NOW = new Date("2026-10-14T10:00:00Z");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

test("A–F: shop → Geschäft, amenity=restaurant → Restaurant, Restaurant bleibt, office=accountant → Treuhand, shop=car_repair → Autogarage, unbekannt nicht zerstört", () => {
  assert.equal(displayCategory("shop"), "Geschäft");
  assert.equal(displayCategory("amenity=restaurant"), "Restaurant");
  assert.equal(displayCategory("Restaurant"), "Restaurant");
  assert.equal(displayCategory("office=accountant"), "Treuhand");
  assert.equal(displayCategory("shop=car_repair"), "Autogarage");
  for (const v of ["Treuhand", "Hotel", "Handwerk", "Geschäft", "Firma / Büro"]) assert.equal(displayCategory(v), v);
  assert.equal(displayCategory("restaurant"), "Restaurant", "Schreibweise einer bekannten Bezeichnung vereinheitlicht");
  assert.equal(displayCategory(" Amenity = Restaurant "), "Restaurant");
  // unbekannt: bereits lesbar bleibt, unbekannter Rohwert bleibt wie vorhanden (nie geraten)
  assert.equal(displayCategory("Bäckerei"), "Bäckerei");
  assert.equal(displayCategory("amenity=pharmacy"), "amenity=pharmacy");
  assert.equal(displayCategory("shop=bakery"), "Geschäft", "Oberbegriff aus der bestehenden Taxonomie");
  for (const v of [null, undefined, "", "  ", 42]) assert.equal(displayCategory(v), null);
});

test("Gemeinsames Modul: rein, gleiche Taxonomie, Discovery-Verhalten unverändert", () => {
  const src = fs.readFileSync(new URL("../category-labels.js", import.meta.url), "utf8");
  assert.ok(!/\bimport\b|require\(|fetch\(|process\./.test(src), "keine Imports, kein Netz, keine Umgebung");
  assert.equal(swiss.categoryLabel, categoryLabel); assert.equal(swiss.categoryKey, categoryKey); assert.equal(swiss.CATEGORY_LABELS, CATEGORY_LABELS);
  assert.equal(Object.keys(CATEGORY_LABELS).length, 24);
  // bisheriges categoryLabel/categoryKey/matchCategory
  assert.equal(categoryLabel("office=accountant"), "Treuhand"); assert.equal(categoryLabel("shop=bakery"), "Geschäft");
  assert.equal(categoryLabel("office=foo"), "office=foo"); assert.equal(categoryLabel(""), null);
  assert.equal(categoryKey({ key: "office", value: "accountant" }), "office=accountant"); assert.equal(categoryKey({ key: "craft" }), "craft");
  assert.equal(swiss.matchCategory({ shop: "hairdresser" }, [{ key: "shop" }, { key: "shop", value: "hairdresser" }]), "shop=hairdresser");
  assert.equal(swiss.matchCategory({ shop: "x" }, [{ key: "shop" }, { key: "shop", value: "hairdresser" }]), "shop");
});

function scenario() {
  const src = makeSources(12);
  const L = src.registry.leads;
  L["firma-000.ch"] = { ...L["firma-000.ch"], category: "amenity=restaurant", category_label: undefined };
  L["firma-001.ch"] = { ...L["firma-001.ch"], category: "office=accountant", category_label: undefined };
  L["firma-004.ch"] = { ...L["firma-004.ch"], category: "shop", category_label: undefined };
  L["firma-005.ch"] = { ...L["firma-005.ch"], category: "x", category_label: "Geschäft" };
  L["firma-006.ch"] = { ...L["firma-006.ch"], category: "shop=car_repair", category_label: undefined };
  L["firma-007.ch"] = { ...L["firma-007.ch"], category: "Bäckerei", category_label: undefined };
  const dirs = writeSources(src);
  fs.writeFileSync(path.join(dirs.mail, "mail_worker", "discovered.json"), JSON.stringify({ leads: {} }));
  // L: historischer Lead nur mit hist.category (OSM-Rohwert)
  const d = "hist-raw.ch", at = "2026-10-13T08:00:00Z";
  const rec = historyRecord({ email: `info@${d}`, business_email: `info@${d}`, company: "Hist Raw AG", website: `https://${d}/`, domain: d, status: "low_score", auditedAt: at, discoveredAt: at,
    reachable: true, canton: "ZH", municipality: "Winterthur", category: "amenity=restaurant", contact_source: "impressum", source_url: `https://${d}/impressum`, collected_at: at,
    websiteIssues: [{ type: "broken_link", url: `https://${d}/team-alt`, page: `https://${d}/`, evidence: `HTTP 404 (verlinkt auf https://${d}/)`, severity: "medium", detectedAt: at, label: "Team" }] }).record;
  const hist = emptyHistory(); upsertHistory(hist, rec, NOW);
  fs.writeFileSync(path.join(dirs.data, HISTORY_FILE), JSON.stringify(hist));
  const sources = createSourceReader({ dataDir: dirs.data, mailDir: dirs.mail });
  const files = [path.join(dirs.mail, "mail_worker", "lead_registry.json"), path.join(dirs.data, HISTORY_FILE)];
  return { files, view: () => buildCrmView({ ...sources(), crm: loadCrm(dirs.data) }, NOW) };
}

test("CRM-Lead: Rohwerte lesbar, Filter zusammengeführt (G), Suche (H), historischer Lead (L), Rohdaten unverändert (M)", () => {
  const s = scenario();
  const before = s.files.map(sha);
  const leads = s.view().leads;
  const by = Object.fromEntries(leads.map((l) => [l.lead_id, l]));
  assert.equal(by["firma-000.ch"].category, "Restaurant");
  assert.equal(by["firma-001.ch"].category, "Treuhand");
  assert.equal(by["firma-004.ch"].category, "Geschäft");
  assert.equal(by["firma-005.ch"].category, "Geschäft", "category_label hat Vorrang");
  assert.equal(by["firma-006.ch"].category, "Autogarage");
  assert.equal(by["firma-007.ch"].category, "Bäckerei", "unbekannter lesbarer Wert bleibt");
  assert.equal(by["hist-raw.ch"].category, "Restaurant", "L: historischer Lead");
  assert.equal(cleanCrmLead({ ...by["firma-001.ch"], category: "office=accountant" }).category, "Treuhand", "Cloud-Allowlist normalisiert ältere Schnappschüsse");
  assert.ok(!leads.some((l) => /=/.test(l.category || "")), "keine Rohwerte mehr");
  // G: ein sichtbarer Filterwert „Restaurant“ für Restaurant + amenity=restaurant
  const values = [...new Set(leads.map((l) => l.category).filter(Boolean))];
  assert.equal(values.filter((v) => /restaurant/i.test(v)).length, 1);
  const rest = filterLeads(leads, { category: "Restaurant" }).map((l) => l.lead_id);
  assert.ok(rest.includes("firma-000.ch") && rest.includes("firma-002.ch") && rest.includes("hist-raw.ch"));
  // H: Suche „Treuhand“ findet office=accountant, „Restaurant“ beide Rohvarianten
  assert.ok(filterLeads(leads, { q: "Treuhand" }).some((l) => l.lead_id === "firma-001.ch"));
  assert.ok(searchMatch(by["firma-000.ch"], "Restaurant") && searchMatch(by["firma-002.ch"], "Restaurant"));
  // M: Quellen nicht verändert, Lead-Anzahl (Dedupe) unverändert
  assert.deepEqual(s.files.map(sha), before, "Registry/Historie unverändert");
  assert.equal(leads.length, 13);
  const raw = JSON.parse(fs.readFileSync(s.files[0], "utf8")).leads;
  assert.equal(raw["firma-000.ch"].category, "amenity=restaurant"); assert.equal(raw["firma-001.ch"].category, "office=accountant");
});
