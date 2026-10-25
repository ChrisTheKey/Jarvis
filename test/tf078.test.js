// TF-078 – Telefonbuch-Compliance über den kommerziellen Anbieter multisource (CallLookup). Nur gemockte Antworten (fetchFn), keine echte
// Abfrage, keine echten Nummern (Vorwahl 099 ist in der Schweiz nicht vergeben), keine Schlüssel (Platzhalter erkennbar unecht).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pb = await import("../phonebook-compliance.js");
const { buildCrmLead, buildCrmView, cleanCrmLead } = await import("../lead-crm.js");
const { callRecommended, crmAdmission } = await import("../public/crm-model.js");
const { eligibility } = await import("../calling-core.js");
const { phonebookBackfill, phonebookDiagnose, loadPhonebookCache, phonebookSummary } = await import("../crm-service.js");
const cf = await import("../contact-form.js");

const FAKE_KEY = "test-not-a-real-key-0000";
const ENV = (extra = {}) => ({ MULTISOURCE_API_KEY: FAKE_KEY, ...extra });
const CONFIRMED = { MULTISOURCE_NOPROMO_FIELD: "flags.noPromo", MULTISOURCE_NOPROMO_SEMANTICS: "TRUE_IS_STAR" };
const N1 = "+41991230001", N2 = "+41991230002", N3 = "+41991230003";
const T0 = new Date("2026-10-17T08:00:00Z");

// Mock-fetch: zählt Aufrufe, prüft Header/URL, liefert je Nummer eine vorbereitete Antwort.
function mockFetch(byNumber, { status = 200, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const u = new URL(url);
    const num = u.searchParams.get("number");
    const spec = typeof byNumber === "function" ? byNumber(num) : byNumber[num];
    const st = spec?.status ?? status;
    const body = spec && "body" in spec ? spec.body : spec;
    return { status: st, headers: { get: (k) => (spec?.headers || headers)[k.toLowerCase()] ?? null }, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}
const hit = (flags) => ({ results: [{ id: "ref-1", displayName: "Fixture AG", ...(flags ? { flags } : {}) }] });

// ---------------------------------------------------------------------------------------------------------------------------------------
test("Normalisierung: +41 / 0041 / 0xx → eine E.164-Form; Anbieter-Eingabe national 0XXXXXXXXX; Unsinn → null", () => {
  for (const raw of ["+41 99 123 00 01", "0041 99 123 00 01", "099 123 00 01", "099/123.00-01", "(099) 123 00 01"]) assert.equal(pb.normalizeSwissPhone(raw), N1, raw);
  for (const raw of ["", null, "12345", "+49991230001", "0001230001", "+4199123000", "*099 123 00 01x"]) assert.equal(pb.normalizeSwissPhone(raw), null, String(raw));
  assert.equal(pb.multisourceNumber(N1), "0991230001");
  assert.equal(pb.multisourceNumber("+4912345"), null);
  assert.match(pb.phoneHash(N1), /^[a-f0-9]{32}$/);
  assert.notEqual(pb.phoneHash(N1), pb.phoneHash(N2));
});

test("Konfiguration: ohne Schlüssel NOT_CONFIGURED; Feld nur mit Name UND definierter Bedeutung bestätigt; Limits 50/500", () => {
  assert.equal(pb.multisourceConfig({}).configured, false);
  const c = pb.multisourceConfig(ENV());
  assert.deepEqual([c.configured, c.baseUrl, c.fieldConfirmed, c.field, c.maxPerRun, c.maxPerDay], [true, "https://api.multisource.ch", false, null, 50, 500]);
  assert.equal(pb.multisourceConfig(ENV({ MULTISOURCE_NOPROMO_FIELD: "noPromo" })).fieldConfirmed, false, "ohne Bedeutung nicht aktiv");
  assert.equal(pb.multisourceConfig(ENV({ MULTISOURCE_NOPROMO_FIELD: "noPromo", MULTISOURCE_NOPROMO_SEMANTICS: "MAYBE" })).fieldConfirmed, false);
  assert.equal(pb.multisourceConfig(ENV({ MULTISOURCE_NOPROMO_FIELD: "bad field;", MULTISOURCE_NOPROMO_SEMANTICS: "TRUE_IS_STAR" })).fieldConfirmed, false);
  assert.equal(pb.multisourceConfig(ENV(CONFIRMED)).fieldConfirmed, true);
  assert.equal(pb.multisourceConfig(ENV({ MULTISOURCE_API_BASE_URL: "http://evil.example" })).baseUrl, "https://api.multisource.ch", "nur https");
  const lim = pb.multisourceConfig(ENV({ MULTISOURCE_MAX_LOOKUPS_PER_RUN: "5", MULTISOURCE_MAX_LOOKUPS_PER_DAY: "7" }));
  assert.deepEqual([lim.maxPerRun, lim.maxPerDay], [5, 7]);
});

test("Lookup: fehlender Schlüssel → PROVIDER_NOT_CONFIGURED, keine Abfrage", async () => {
  const f = mockFetch({});
  const r = await pb.multisourceLookup(N1, { config: pb.multisourceConfig({}), fetchFn: f });
  assert.deepEqual([r.status, r.reason], ["PHONEBOOK_PROVIDER_NOT_CONFIGURED", "PROVIDER_NOT_CONFIGURED"]);
  assert.equal(f.calls.length, 0);
});

test("Lookup: GET /v2/Search/CallLookup?number=0XXXXXXXXX mit auth-key-Header; Ergebnis ohne Personendaten", async () => {
  const f = mockFetch({ "0991230001": hit({ noPromo: true }) });
  const r = await pb.multisourceLookup(N1, { config: pb.multisourceConfig(ENV(CONFIRMED)), fetchFn: f });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://api.multisource.ch/v2/Search/CallLookup?number=0991230001");
  assert.equal(f.calls[0].headers["auth-key"], FAKE_KEY);
  assert.deepEqual(Object.keys(r).sort(), ["http_status", "matches", "reason", "status"], "keine Namen/Adressen/Nummern im Ergebnis");
  assert.ok(!JSON.stringify(r).includes("Fixture AG"));
});

test("Klassifikation: ausdrücklicher Stern → PRESENT, ausdrücklich klar → CLEAR, Feld fehlt → UNKNOWN, kein Treffer → UNKNOWN", async () => {
  const cfg = pb.multisourceConfig(ENV(CONFIRMED));
  const run = async (resp) => pb.multisourceLookup(N1, { config: cfg, fetchFn: mockFetch(() => resp) });
  assert.deepEqual(pick(await run(hit({ noPromo: true }))), ["PHONEBOOK_STAR_PRESENT", "EXPLICIT_STAR"]);
  assert.deepEqual(pick(await run(hit({ noPromo: false }))), ["PHONEBOOK_STAR_CLEAR", "EXPLICIT_CLEAR"]);
  assert.deepEqual(pick(await run(hit(null))), ["PHONEBOOK_STAR_UNKNOWN", "PROMO_FIELD_MISSING"], "Treffer ohne Feld");
  assert.deepEqual(pick(await run(hit({ noPromo: "false" }))), ["PHONEBOOK_STAR_UNKNOWN", "PROMO_FIELD_MISSING"], "nur echte Booleans");
  assert.deepEqual(pick(await run({ results: [] })), ["PHONEBOOK_STAR_UNKNOWN", "NO_HIT"]);
  assert.deepEqual(pick(await run({ status: 404, body: undefined })), ["PHONEBOOK_STAR_UNKNOWN", "NO_HIT"]);
  // Gemischt: ein Stern genügt; CLEAR nur wenn ALLE Treffer ausdrücklich klar.
  assert.equal((await run({ results: [{ flags: { noPromo: false } }, { flags: { noPromo: true } }] })).status, "PHONEBOOK_STAR_PRESENT");
  assert.equal((await run({ results: [{ flags: { noPromo: false } }, { flags: {} }] })).status, "PHONEBOOK_STAR_UNKNOWN");
  // FALSE_IS_STAR (z. B. «Werbung erlaubt»-Feld).
  const inv = pb.multisourceConfig(ENV({ MULTISOURCE_NOPROMO_FIELD: "adOk", MULTISOURCE_NOPROMO_SEMANTICS: "FALSE_IS_STAR" }));
  assert.equal((await pb.multisourceLookup(N1, { config: inv, fetchFn: mockFetch(() => ({ results: [{ adOk: false }] })) })).status, "PHONEBOOK_STAR_PRESENT");
  assert.equal((await pb.multisourceLookup(N1, { config: inv, fetchFn: mockFetch(() => ({ results: [{ adOk: true }] })) })).status, "PHONEBOOK_STAR_CLEAR");
});
const pick = (r) => [r.status, r.reason];

test("Ohne bestätigtes Feld nie CLEAR: Treffer, Firma, fehlendes nopromo, Nummer ohne «*», sogar ein Feld namens tel:nopromo → UNKNOWN", async () => {
  const cfg = pb.multisourceConfig(ENV());
  for (const resp of [hit(null), hit({ noPromo: false }), { results: [{ "tel:nopromo": "*" }] }, { results: [{ phone: "099 123 00 01" }] }]) {
    const r = await pb.multisourceLookup(N1, { config: cfg, fetchFn: mockFetch(() => resp) });
    assert.deepEqual(pick(r), ["PHONEBOOK_STAR_UNKNOWN", "PROMO_FIELD_NOT_CONFIRMED"]);
  }
});

test("Fehler: 401/403 → LOOKUP_FAILED (AUTH), 429 → LOOKUP_FAILED (RATE_LIMIT + Retry-After), 500 → HTTP_ERROR, Netzwerk → NETWORK, Müll → INVALID_RESPONSE", async () => {
  const cfg = pb.multisourceConfig(ENV(CONFIRMED));
  const st = async (status, extra = {}) => pb.multisourceLookup(N1, { config: cfg, fetchFn: mockFetch(() => ({ status, body: {}, ...extra })) });
  assert.deepEqual(pick(await st(401)), ["PHONEBOOK_LOOKUP_FAILED", "AUTH_FAILED"]);
  assert.deepEqual(pick(await st(403)), ["PHONEBOOK_LOOKUP_FAILED", "AUTH_FAILED"]);
  const rl = await st(429, { headers: { "retry-after": "120" } });
  assert.deepEqual([...pick(rl), rl.retry_after_s], ["PHONEBOOK_LOOKUP_FAILED", "RATE_LIMIT", 120]);
  assert.deepEqual(pick(await st(500)), ["PHONEBOOK_LOOKUP_FAILED", "HTTP_ERROR"]);
  assert.deepEqual(pick(await pb.multisourceLookup(N1, { config: cfg, fetchFn: async () => { throw new Error("ECONNRESET"); } })), ["PHONEBOOK_LOOKUP_FAILED", "NETWORK"]);
  assert.deepEqual(pick(await pb.multisourceLookup(N1, { config: cfg, fetchFn: async () => ({ status: 200, headers: { get: () => null }, text: async () => "<html>" }) })), ["PHONEBOOK_LOOKUP_FAILED", "INVALID_RESPONSE"]);
  assert.deepEqual(pick(await pb.multisourceLookup("12345", { config: cfg, fetchFn: mockFetch({}) })), ["PHONEBOOK_LOOKUP_FAILED", "INVALID_NUMBER"]);
});

test("Schema-Diagnose: nur Feldnamen + Kandidaten, nie Werte", () => {
  const body = { total: 1, results: [{ displayName: "Fixture AG", phone: "0991230001", address: { street: "Fixturweg 1", city: "Testdorf" }, flags: { noPromo: true } }] };
  const s = pb.inspectSchema(body, 200);
  assert.deepEqual(s.top_level_fields, ["results", "total"]);
  assert.ok(s.result_item_fields.includes("address.city") && s.result_item_fields.includes("flags.noPromo"));
  assert.deepEqual(s.candidate_promotion_fields, ["flags.noPromo"]);
  assert.equal(s.candidate_promotion_field_exists, true);
  const out = JSON.stringify(s);
  for (const v of ["Fixture AG", "0991230001", "Fixturweg", "Testdorf"]) assert.ok(!out.includes(v), v);
  assert.equal(pb.inspectSchema({ results: [{ name: "x" }] }, 200).candidate_promotion_field_exists, false);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
test("Cache: frischer Eintrag → keine zweite Abfrage; abgelaufen → Neuprüfung; Nummern getrennt; Stern bleibt bis neues CLEAR", async () => {
  const cache = pb.emptyPhonebookCache();
  const cfg = pb.multisourceConfig(ENV(CONFIRMED));
  const answers = { "0991230001": hit({ noPromo: true }), "0991230002": hit({ noPromo: false }), "0991230003": hit(null) };
  const f = mockFetch((n) => answers[n]);
  const lookup = (e) => pb.multisourceLookup(e, { config: cfg, fetchFn: f });
  const leads = [N1, N2, N3].map((p, i) => ({ lead_id: `l${i}.ch`, market: "CH", phone: p }));
  let clock = T0;
  const s1 = await pb.runPhonebookBackfill({ leads, cache, lookup, now: () => clock });
  assert.equal(f.calls.length, 3);
  assert.deepEqual(s1.by_status, { PHONEBOOK_STAR_CLEAR: 1, PHONEBOOK_STAR_PRESENT: 1, PHONEBOOK_STAR_UNKNOWN: 1, PHONEBOOK_LOOKUP_FAILED: 0 });
  assert.deepEqual([N1, N2, N3].map((n) => pb.phonebookFromCache(cache, n, clock).status), ["PHONEBOOK_STAR_PRESENT", "PHONEBOOK_STAR_CLEAR", "PHONEBOOK_STAR_UNKNOWN"], "je Nummer");
  const e = cache.entries[pb.phoneHash(N2)];
  assert.deepEqual(Object.keys(e).sort(), ["checked_at", "expires_at", "last_attempt_at", "phone_hash", "provider", "provider_reference", "reason", "status"]);
  assert.ok(!JSON.stringify(cache).includes("099123"), "keine Klartext-Nummer im Cache");
  // Zweiter Lauf am selben Tag: alles frisch → 0 Abfragen.
  const s2 = await pb.runPhonebookBackfill({ leads, cache, lookup, now: () => clock });
  assert.deepEqual([f.calls.length, s2.skipped_fresh, s2.looked_up], [3, 3, 0]);
  // Nach 31 Tagen: CLEAR gilt nicht mehr (UNKNOWN), Stern sperrt weiter; Neuprüfung fällig.
  clock = new Date(+T0 + 31 * 24 * 3600_000);
  assert.equal(pb.phonebookFromCache(cache, N2, clock).status, "PHONEBOOK_STAR_UNKNOWN", "abgelaufenes CLEAR ≠ geprüft-sauber");
  assert.equal(pb.phonebookFromCache(cache, N1, clock).status, "PHONEBOOK_STAR_PRESENT", "Stern bleibt sperrend");
  // Neuprüfung schlägt fehl / UNKNOWN → Stern bleibt.
  answers["0991230001"] = { status: 500, body: {} };
  await pb.runPhonebookBackfill({ leads, cache, lookup, now: () => clock });
  assert.equal(f.calls.length, 6, "abgelaufen → erneut abgefragt");
  assert.equal(pb.phonebookFromCache(cache, N1, clock).status, "PHONEBOOK_STAR_PRESENT", "Fehler überschreibt Stern nicht");
  answers["0991230001"] = hit(null);
  clock = new Date(+clock + 2 * 24 * 3600_000);
  await pb.runPhonebookBackfill({ leads: leads.slice(0, 1), cache, lookup, now: () => clock });
  assert.equal(pb.phonebookFromCache(cache, N1, clock).status, "PHONEBOOK_STAR_PRESENT", "UNKNOWN überschreibt Stern nicht");
  answers["0991230001"] = hit({ noPromo: false });
  clock = new Date(+clock + 2 * 24 * 3600_000);
  await pb.runPhonebookBackfill({ leads: leads.slice(0, 1), cache, lookup, now: () => clock });
  assert.equal(pb.phonebookFromCache(cache, N1, clock).status, "PHONEBOOK_STAR_CLEAR", "nur neues massgebliches CLEAR hebt den Stern auf");
});

test("Nutzung: Lauf-Limit, Tages-Limit, nur CH, DNC/ohne Nummer übersprungen, Dubletten einmal, 429 → sofort Stopp + Backoff", async () => {
  const cfg = pb.multisourceConfig(ENV(CONFIRMED));
  const many = Array.from({ length: 12 }, (_, i) => ({ lead_id: `m${i}.ch`, market: "CH", phone: `+4199123${String(100 + i).padStart(4, "0")}` }));
  const f = mockFetch(() => hit({ noPromo: false }));
  const lookup = (e) => pb.multisourceLookup(e, { config: cfg, fetchFn: f });
  const cache = pb.emptyPhonebookCache();
  const r1 = await pb.runPhonebookBackfill({ leads: many, cache, lookup, now: () => T0, maxPerRun: 5, maxPerDay: 8 });
  assert.deepEqual([r1.looked_up, r1.stopped, f.calls.length], [5, "RUN_CAP", 5]);
  const r2 = await pb.runPhonebookBackfill({ leads: many, cache, lookup, now: () => T0, maxPerRun: 5, maxPerDay: 8 });
  assert.deepEqual([r2.looked_up, r2.stopped, f.calls.length, cache.usage.lookups], [3, "DAY_CAP", 8, 8]);
  // Nächster Tag: Zähler neu.
  const next = new Date(+T0 + 24 * 3600_000);
  const r3 = await pb.runPhonebookBackfill({ leads: many, cache, lookup, now: () => next, maxPerRun: 50, maxPerDay: 8 });
  assert.deepEqual([r3.looked_up, r3.skipped_fresh], [4, 8]);
  // Filter.
  const mixed = [{ lead_id: "vn", market: "VN", phone: "+84912345678" }, { lead_id: "dnc.ch", market: "CH", phone: N1, do_not_contact: true }, { lead_id: "nop.ch", market: "CH", phone: null },
    { lead_id: "a.ch", market: "CH", phone: N2 }, { lead_id: "b.ch", market: "CH", phone: "099 123 00 02" }];
  const g = mockFetch(() => hit({ noPromo: false }));
  const r4 = await pb.runPhonebookBackfill({ leads: mixed, cache: pb.emptyPhonebookCache(), lookup: (e) => pb.multisourceLookup(e, { config: cfg, fetchFn: g }), now: () => T0 });
  assert.deepEqual([r4.skipped_non_ch, r4.skipped_dnc, r4.skipped_no_phone, r4.skipped_duplicate, r4.looked_up, g.calls.length], [1, 1, 1, 1, 1, 1]);
  // 429: sofort Stopp, keine Wiederholung, Backoff gespeichert; nächster Lauf vor Ablauf fragt nichts ab.
  const h = mockFetch(() => ({ status: 429, body: {}, headers: { "retry-after": "600" } }));
  const c429 = pb.emptyPhonebookCache();
  const r5 = await pb.runPhonebookBackfill({ leads: many, cache: c429, lookup: (e) => pb.multisourceLookup(e, { config: cfg, fetchFn: h }), now: () => T0 });
  assert.deepEqual([r5.stopped, h.calls.length, r5.looked_up], ["RATE_LIMITED", 1, 1]);
  assert.equal(c429.usage.rate_limited_until, new Date(+T0 + 600_000).toISOString());
  assert.equal(Object.keys(c429.entries).length, 0, "Nummer bleibt fällig, kein 24-h-Fehlereintrag");
  const r6 = await pb.runPhonebookBackfill({ leads: many, cache: c429, lookup: (e) => pb.multisourceLookup(e, { config: cfg, fetchFn: h }), now: () => new Date(+T0 + 60_000) });
  assert.deepEqual([r6.stopped, h.calls.length], ["RATE_LIMITED", 1]);
  assert.equal(pb.providerStatus(c429, cfg, new Date(+T0 + 60_000)).rate_limit, "LIMITED");
  assert.equal(pb.providerStatus(c429, cfg, new Date(+T0 + 700_000)).rate_limit, "OK");
  // Dry-Run fragt nie ab.
  const d = mockFetch(() => hit({ noPromo: false }));
  const r7 = await pb.runPhonebookBackfill({ leads: many, cache: pb.emptyPhonebookCache(), lookup: (e) => pb.multisourceLookup(e, { config: cfg, fetchFn: d }), now: () => T0, dryRun: true });
  assert.deepEqual([r7.due, r7.looked_up, d.calls.length], [12, 0, 0]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// CRM: Sicht + Anruf-Gates
const AT = () => new Date().toISOString();
const errLead = (domain) => ({ domain, full: { domain, complete: true, audited_at: AT(), findings: [{ key: `link|${domain}/alt`, type: "broken_link", category: "http", text: "Link führt auf eine Fehlerseite", page: `https://${domain}/`, target: `https://${domain}/alt`, severity: "medium", status: "OPEN" }] } });
function srcWith(entries, cache) {
  const leads = {}, domains = {};
  for (const [d, phone] of entries) { leads[d] = { lead_id: d, domain: d, company_name: d, phone, phone_normalized: pb.normalizeSwissPhone(phone) }; domains[d] = errLead(d); }
  return { directory: { leads }, siteFindings: { domains }, phonebookCache: cache, phonebookProvider: { configured: true } };
}
function cacheOf(map, now = new Date()) {
  const c = pb.emptyPhonebookCache();
  for (const [n, status] of Object.entries(map)) pb.recordLookup(c, n, { status, reason: status === "PHONEBOOK_STAR_PRESENT" ? "EXPLICIT_STAR" : status === "PHONEBOOK_STAR_CLEAR" ? "EXPLICIT_CLEAR" : "PROMO_FIELD_MISSING" }, now);
  return c;
}

test("CRM: Status je Nummer aus dem Cache; Stern → nicht anrufbar; CLEAR/UNKNOWN sichtbar; Anbieter multisource ohne Schlüssel", () => {
  const src = srcWith([["stern.ch", "099 123 00 01"], ["klar.ch", "099 123 00 02"], ["offen.ch", "099 123 00 03"]], cacheOf({ [N1]: "PHONEBOOK_STAR_PRESENT", [N2]: "PHONEBOOK_STAR_CLEAR", [N3]: "PHONEBOOK_STAR_UNKNOWN" }));
  const v = buildCrmView(src);
  const by = Object.fromEntries(v.leads.map((l) => [l.lead_id, cleanCrmLead(l)]));
  assert.equal(v.total, 3, "alle bleiben im aktiven CRM (verifizierte Fehler)");
  assert.deepEqual([by["stern.ch"].phonebook.status, by["stern.ch"].phone_tel, by["stern.ch"].call_recommended, callRecommended(by["stern.ch"])], ["PHONEBOOK_STAR_PRESENT", null, false, false]);
  assert.equal(by["stern.ch"].phone, "099 123 00 01", "Nummer-Text unverändert sichtbar");
  assert.deepEqual([by["klar.ch"].phonebook.status, by["klar.ch"].phonebook.source, by["klar.ch"].phone_tel], ["PHONEBOOK_STAR_CLEAR", "multisource", "tel:+41991230002"]);
  assert.equal(by["offen.ch"].phonebook.status, "PHONEBOOK_STAR_UNKNOWN");
  assert.ok(!JSON.stringify(v).includes(FAKE_KEY));
  // Explizites Verzeichnis-Sternchen gewinnt über ein Cache-CLEAR.
  src.directory.leads["klar.ch"].phonebook = { "tel:nopromo": "*", source: "search.ch", checked_at: "2026-10-01T00:00:00Z" };
  assert.equal(buildCrmLead("klar.ch", src).phonebook.status, "PHONEBOOK_STAR_PRESENT");
});

test("Bestehende Leads ohne Prüfung bleiben sichtbar (Migration) – CRM wird nicht geleert, wenn der Anbieter fehlt", () => {
  const src = srcWith([["a.ch", "099 123 00 01"], ["b.ch", "099 123 00 02"]], null);
  src.phonebookProvider = { configured: false };
  const v = buildCrmView(src);
  assert.equal(v.total, 2);
  for (const l of v.leads.map(cleanCrmLead)) { assert.ok(!("phonebook" in l), "UI: Nicht geprüft"); assert.ok(l.phone_tel); }
});

test("Autonome Anruf-Gates bleiben entfernt; Telefonbuch-Status erteilt keine menschliche Einwilligung", () => {
  assert.deepEqual(pb.coldCallPhonebookGate({ phonebook: { status: "PHONEBOOK_STAR_PRESENT" } }), { ok: false, code: "PHONEBOOK_STAR_PRESENT" });
  for (const s of ["PHONEBOOK_STAR_UNKNOWN", "PHONEBOOK_LOOKUP_FAILED", undefined]) assert.deepEqual(pb.coldCallPhonebookGate({ phonebook: s ? { status: s } : undefined }), { ok: false, code: "PHONEBOOK_NOT_VERIFIED_CLEAR" });
  assert.equal(pb.coldCallPhonebookGate({ phonebook: { status: "PHONEBOOK_STAR_CLEAR" } }).ok, true);
  // Neue CH-Leads (Anbieter konfiguriert): nur CLEAR ist anrufbar; UNKNOWN nicht.
  assert.deepEqual(pb.phonebookAdmission({ status: "PHONEBOOK_STAR_UNKNOWN" }, { providerConfigured: true }).callable, false);
  assert.deepEqual(pb.phonebookAdmission({ status: "PHONEBOOK_STAR_PRESENT" }, { providerConfigured: true }).callable, false);
  assert.deepEqual(pb.phonebookAdmission({ status: "PHONEBOOK_STAR_CLEAR" }, { providerConfigured: true }).callable, true);
  // Calling: CLEAR allein erlaubt nichts – ohne Einwilligung/Rechtsprüfung/DNC-Register blockiert; CH-Agent bleibt aus.
  const src = srcWith([["klar.ch", "099 123 00 02"], ["stern.ch", "099 123 00 01"]], cacheOf({ [N2]: "PHONEBOOK_STAR_CLEAR", [N1]: "PHONEBOOK_STAR_PRESENT" }));
  const klar = cleanCrmLead(buildCrmLead("klar.ch", src)), stern = cleanCrmLead(buildCrmLead("stern.ch", src));
  assert.equal(eligibility(klar, {}).decision, "BLOCKED");
  assert.equal(eligibility(klar, { legal: { status: "APPROVED" } }).code, "CH_CALLING_DISABLED");
  // Der frühere autonome Dialer ist entfernt. Ein Telefonbuch-Stern bleibt CRM-/Compliance-Information,
  // erzeugt aber keinen autonomen Directory-Blockcode und keine Einwilligung für einen Mitarbeiteranruf.
  assert.equal(eligibility(stern, { legal: { status: "APPROVED" } }).code, "CH_CALLING_DISABLED");
  const vn = { ...klar, market: "VN", phone_tel: "tel:+84912345678" };
  assert.equal(eligibility(vn, { legal: { status: "APPROVED" } }).bucket, "BLOCKED_CONSENT", "kein Anruf ohne Einwilligung, auch mit CLEAR");
});

test("Kontaktformular-Inbound bleibt P0 auch bei UNKNOWN; Telefonbuch erzeugt keine Einwilligung; Stern sperrt Rückruf", () => {
  const pubFrom = (list) => cf.publicContactForms({ items: Object.fromEntries(list.map((x, i) => [`k${i}`, { key: `cf:${String(i).padStart(24, "0")}`, created_at: x.received_at, ...x }])) });
  const SUB = (over = {}) => ({ state: cf.STATES.SENT, verified: true, received_at: "2026-10-16T08:00:00.000Z", sent_at: "2026-10-16T08:01:00.000Z", match_state: cf.MATCH.UNMATCHED, summary: "Formular kaputt", ...over });
  const base = { contactForms: pubFrom([SUB({ customer_email: "info@inbound.ch", phone: "099 123 00 03", phone_e164: N3, callback_requested: false })]) };
  for (const cache of [null, cacheOf({ [N3]: "PHONEBOOK_STAR_UNKNOWN" }), cacheOf({ [N3]: "PHONEBOOK_STAR_CLEAR" })]) {
    const l = buildCrmLead("inbound.ch", { ...base, phonebookCache: cache, phonebookProvider: { configured: true } });
    assert.equal(crmAdmission(l).state, "CONTACT_FORM_INBOUND");
    assert.equal(l.contact_form.open, true, "P0");
    assert.equal(l.contact_form.call_eligibility, "CALL_NOT_CURRENTLY_ELIGIBLE", "Telefonbuch-Status ist keine Einwilligung");
    assert.ok(l.priority.reasons.some((r) => /Kontaktformular/.test(r)));
  }
  const cb = { contactForms: pubFrom([SUB({ customer_email: "info@inbound.ch", phone: "099 123 00 03", phone_e164: N3, callback_requested: true, callback_evidence: "FORM_MESSAGE: Bitte rufen Sie mich an" })]) };
  assert.equal(buildCrmLead("inbound.ch", { ...cb, phonebookCache: cacheOf({ [N3]: "PHONEBOOK_STAR_UNKNOWN" }) }).contact_form.call_eligibility, "CALLBACK_REQUESTED", "ausdrücklicher Rückrufwunsch: bestehende Logik");
  const star = buildCrmLead("inbound.ch", { ...cb, phonebookCache: cacheOf({ [N3]: "PHONEBOOK_STAR_PRESENT" }) });
  assert.deepEqual([star.contact_form.open, star.contact_form.call_eligibility, star.phonebook.status], [true, "CALL_NOT_CURRENTLY_ELIGIBLE", "PHONEBOOK_STAR_PRESENT"], "P0 bleibt, Stern sperrt Anruf");
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Admin-Befehle (crm-service.js) – Datei-Ebene, nur Zähler in der Ausgabe
function svcDir(entries) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-tf078-"));
  const src = srcWith(entries, null);
  const sources = () => ({ ...src, phonebookCache: null, registry: { leads: {} }, reviews: {}, gmail: null, repairFindings: { orders: {} }, history: { leads: {} }, contactForms: { leads: {} } });
  return { data, sources };
}

test("Backfill-Befehl: ohne Schlüssel keine Abfrage; ohne bestätigtes Feld kein Backfill; mit Feld gestaffelt, idempotent, nur Zähler", async () => {
  const s = svcDir([["a.ch", "099 123 00 01"], ["b.ch", "099 123 00 02"], ["c.ch", "099 123 00 03"]]);
  const f = mockFetch(() => hit({ noPromo: false }));
  const r0 = await phonebookBackfill({ dataDir: s.data, sources: s.sources, env: {}, fetchFn: f });
  assert.deepEqual([r0.ok, r0.code, f.calls.length], [false, "PHONEBOOK_PROVIDER_NOT_CONFIGURED", 0]);
  const r1 = await phonebookBackfill({ dataDir: s.data, sources: s.sources, env: ENV(), fetchFn: f });
  assert.deepEqual([r1.ok, r1.code, f.calls.length], [false, "PROMO_FIELD_NOT_CONFIRMED", 0], "kein Massenabruf ohne bestätigtes Feld");
  const dry = await phonebookBackfill({ dataDir: s.data, sources: s.sources, env: ENV(), fetchFn: f, dryRun: true });
  assert.deepEqual([dry.ok, dry.due, dry.looked_up, f.calls.length], [true, 3, 0, 0]);
  const r2 = await phonebookBackfill({ dataDir: s.data, sources: s.sources, env: ENV({ ...CONFIRMED, MULTISOURCE_MAX_LOOKUPS_PER_RUN: "2" }), fetchFn: f });
  assert.deepEqual([r2.ok, r2.looked_up, r2.stopped, f.calls.length], [true, 2, "RUN_CAP", 2]);
  const r3 = await phonebookBackfill({ dataDir: s.data, sources: s.sources, env: ENV({ ...CONFIRMED, MULTISOURCE_MAX_LOOKUPS_PER_RUN: "2" }), fetchFn: f });
  assert.deepEqual([r3.looked_up, r3.skipped_fresh, f.calls.length], [1, 2, 3], "fortgesetzt");
  const r4 = await phonebookBackfill({ dataDir: s.data, sources: s.sources, env: ENV(CONFIRMED), fetchFn: f });
  assert.deepEqual([r4.looked_up, r4.skipped_fresh, f.calls.length], [0, 3, 3], "idempotent");
  const out = JSON.stringify([r2, r3, r4]);
  for (const v of ["0991230001", "+41991230001", "a.ch", FAKE_KEY, "Fixture"]) assert.ok(!out.includes(v), v);
  const cache = loadPhonebookCache(s.data);
  assert.equal(Object.keys(cache.entries).length, 3);
  const st = phonebookSummary(s.data, new Date(), ENV(CONFIRMED));
  assert.deepEqual([st.provider, st.configured, st.field_confirmed, st.lookups_today, st.matches_today, st.rate_limit], ["multisource", true, true, 3, 3, "OK"]);
  assert.ok(!JSON.stringify(st).includes(FAKE_KEY));
});

test("Diagnose-Befehl: genau eine Abfrage, nur HTTP-Status + Feldnamen, keine Werte", async () => {
  const s = svcDir([["a.ch", "099 123 00 01"]]);
  const f = mockFetch(() => ({ total: 1, results: [{ displayName: "Fixture AG", phone: "0991230001", flags: { noPromo: true } }] }));
  const r = await phonebookDiagnose({ dataDir: s.data, sources: s.sources, env: ENV(), fetchFn: f });
  assert.equal(f.calls.length, 1);
  assert.deepEqual([r.ok, r.http_status, r.top_level_fields, r.candidate_promotion_field_exists], [true, 200, ["results", "total"], true]);
  for (const v of ["Fixture AG", "0991230001", "+41991230001", FAKE_KEY]) assert.ok(!JSON.stringify(r).includes(v), v);
  assert.equal((await phonebookDiagnose({ dataDir: s.data, sources: s.sources, env: {}, fetchFn: f })).code, "PHONEBOOK_PROVIDER_NOT_CONFIGURED");
  assert.equal(f.calls.length, 1);
});
