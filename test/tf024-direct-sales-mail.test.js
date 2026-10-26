import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { actorFor } from "../auth-core.js";
import { tokenHash } from "../access-intake-api.js";
import { createMailRequestHandler } from "../mail-requests.js";
import { memoryStore } from "../shared-state.js";
import { buildSalesIntakeMail, SALES_INTAKE_SUBJECT, salesIntakeEligibility } from "../sales-intake.js";

const NOW = new Date("2026-10-26T10:00:00.000Z");
const EXPIRES = "2026-10-29T10:00:00.000Z";
const TOKEN = "A".repeat(43);
const ENV = {
  JARVIS_WEB_ORIGIN: "https://synthetic.jarvis.test",
  JARVIS_SALES_SANDBOX_MODE: "true",
};
const LEAD = {
  lead_id: "synthetic-024.ch",
  is_test: true,
  market: "CH",
  email: "kontakt@synthetic-024.ch",
  website: "https://synthetic-024.ch/",
  domain: "synthetic-024.ch",
  company: "Synthetic 024 AG",
  errors: { items: [{ text: "Ein bestätigter synthetischer Website-Befund." }] },
  request: {
    basis: "REQUESTED_CONTACT",
    requestSource: "Synthetische Testanfrage TF-JARVIS-024",
    requestDate: "2026-10-25T09:00:00.000Z",
    requestScope: "Website-Reparatur",
    responseScope: "Website-Analyse und Website-Reparatur",
    requestEvidence: "Synthetische Testanfrage TF-JARVIS-024",
    recipientOrSubmissionChannel: "kontakt@synthetic-024.ch",
    requestConfidence: "HIGH",
  },
};

const refs = { order150Id: "CA150-20261026-a1b2c3", order480Id: "RF480-20261026-d4e5f6" };
const requestBody = (leadId = LEAD.lead_id) => ({ op: "sales_intake_send", lead_id: leadId });
const expectedLinks = {
  payment150: "https://buy.stripe.com/test_dRm3cw5A5fo3caR9ov7Re00?client_reference_id=CA150-20261026-a1b2c3&prefilled_email=kontakt%40synthetic-024.ch",
  payment480: "https://buy.stripe.com/test_7sY00k5A54JpcaR1W37Re01?client_reference_id=RF480-20261026-d4e5f6&prefilled_email=kontakt%40synthetic-024.ch",
  access: `https://synthetic.jarvis.test/access.html#t=${TOKEN}`,
};

function expectedBody() {
  return [
    "Guten Tag",
    "",
    "Vielen Dank für Ihr Vertrauen.",
    "",
    "Um die in Auftrag gegebene Dienstleistung zu bestätigen, folgen Sie dem temporären & sicheren Link zum Zugangsdaten-Tresor und zur Zahlungsabwicklung.",
    "",
    `Damit ich die Reparatur Ihrer Website ${LEAD.website} sauber durchführen kann, brauche ich die folgenden zwei Dinge:`,
    "",
    "1. Einen temporären, sicheren Zugang über Ihren persönlichen, nur für diesen Auftrag gültigen Link (gültig bis 2026-10-29T10:00:00.000Z, nur einmal verwendbar):",
    "",
    expectedLinks.access,
    "",
    "Bitte senden Sie keine Passwörter oder Zugangsdaten per E-Mail.",
    "",
    "Verwenden Sie dafür ausschliesslich den sicheren Link.",
    "",
    "Ihre Website läuft über [Name des Anbieters]. Bitte laden Sie mich mit dieser E-Mail-Adresse zu Ihrer Webseite bei Netlify ein, damit ich darauf zugreifen kann.",
    "",
    "Im Formular bestätigen Sie nur noch den Namen der Seite und die vereinbarte Dienstleistung.",
    "",
    "Vor der ersten Änderung erstelle ich eine vollständige Sicherung Ihrer Website; zum Abschluss erhalten Sie einen ausführlichen Bericht.",
    "",
    "2. Unsere zwei Angebote:",
    "",
    "1. Webseiten-Check & Anleitung – CHF 150.–",
    "",
    "Technische Prüfung mit Problemübersicht und Anleitung zur Behebung.",
    "",
    "Stripe-Sandbox-Testlink (keine echte Zahlung):",
    "",
    expectedLinks.payment150,
    "",
    "2. Webseiten-Check & Reparatur – CHF 480.–",
    "",
    "Technische Prüfung und Behebung der Probleme.",
    "",
    "Stripe-Sandbox-Testlink (keine echte Zahlung):",
    "",
    expectedLinks.payment480,
    "",
    "Freundliche Grüsse",
    "",
    "Christoph Kälin",
    "",
    "Helvetic Webdesign",
  ].join("\n");
}

function setup({ lead = LEAD, env = ENV, actor = actorFor("chris") } = {}) {
  const store = memoryStore();
  const handler = createMailRequestHandler({
    getStore: async () => store,
    env: (key) => env[key],
    now: () => NOW,
    resolveActor: async (req) => req.headers.get("x-test-user") ? { actor } : { actor: null, status: 401, error: "Nicht angemeldet." },
    resolveLead: async (_actor, leadId) => leadId === lead.lead_id ? { lead } : { status: 403, code: "OUT_OF_SCOPE" },
  });
  const call = (body = requestBody(), user = "chris") => handler(new Request("https://jarvis.test/api/mail-requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://jarvis.test", ...(user ? { "x-test-user": user } : {}) },
    body: JSON.stringify(body),
  }));
  return { store, handler, call };
}

test("TF-024 direct: freigegebene Erstmail ersetzt nur die dynamischen Werte und nutzt drei Sandbox-/Access-Links", () => {
  const r = buildSalesIntakeMail({ lead: LEAD, ...refs, accessToken: TOKEN, accessExpiresAt: EXPIRES, accessOrigin: ENV.JARVIS_WEB_ORIGIN, sandbox: true, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.mail.subject, SALES_INTAKE_SUBJECT);
  assert.equal(r.mail.recipient, LEAD.email);
  assert.deepEqual(r.mail.links, expectedLinks);
  assert.equal(r.mail.body, expectedBody());
  assert.doesNotMatch(r.mail.body, /\{(?:WEBSITE|ABLAUFDATUM|ZUGANGSTRESOR_LINK|STRIPE_TEST_LINK_150|STRIPE_TEST_LINK_480)\}/);
  assert.match(r.mail.body, /\[Name des Anbieters\]/);
  assert.equal(tokenHash(TOKEN), tokenHash(TOKEN));
});

test("TF-024 direct: authentifizierter Klick queued genau einmal und Doppelklick bleibt idempotent", async () => {
  const { call, store } = setup();
  const first = await call();
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.ok(firstBody.request);
  assert.equal(firstBody.preview, undefined, "direkter Pfad darf keine Vorschau liefern");
  const second = await call();
  const secondBody = await second.json();
  assert.equal(second.status, 200);
  assert.equal(secondBody.duplicate, true);
  assert.equal(secondBody.request.request_id, firstBody.request.request_id);
  const state = (await store.get()).state;
  assert.equal(state.requests.length, 1);
  const queued = state.requests[0];
  assert.deepEqual([queued.recipient, queued.subject, queued.delivery], [LEAD.email, SALES_INTAKE_SUBJECT, "sales_intake"]);
  assert.match(queued.body, /^Guten Tag\n\nVielen Dank für Ihr Vertrauen\./);
  assert.match(queued.body, /https:\/\/synthetic\.jarvis\.test\/access\.html#t=[A-Za-z0-9_-]{43}/);
  assert.match(queued.body, /https:\/\/buy\.stripe\.com\/test_[A-Za-z0-9]{10,64}\?client_reference_id=CA150-20261026-[0-9a-f]{6}/);
  assert.match(queued.body, /https:\/\/buy\.stripe\.com\/test_[A-Za-z0-9]{10,64}\?client_reference_id=RF480-20261026-[0-9a-f]{6}/);
  assert.match(queued.body, /\[Name des Anbieters\]/);
  assert.deepEqual({ direct: queued.meta.sales_intake_direct, sandbox: queued.meta.sales_sandbox, synthetic: queued.meta.synthetic_test }, { direct: true, sandbox: true, synthetic: true });
  assert.equal(queued.meta.access_expires_at, EXPIRES);
  assert.match(queued.meta.order150_id, /^CA150-20261026-[0-9a-f]{6}$/);
  assert.match(queued.meta.order480_id, /^RF480-20261026-[0-9a-f]{6}$/);
});

test("TF-024 direct: Auth, Sandbox- und synthetischer Lead-Gate blockieren ohne Queue-Auftrag", async () => {
  const unauth = await setup().call(requestBody(), null);
  assert.equal(unauth.status, 401);

  const noSandbox = await setup({ env: { ...ENV, JARVIS_SALES_SANDBOX_MODE: undefined } }).call();
  assert.equal(noSandbox.status, 403);
  assert.equal((await noSandbox.json()).code, "SANDBOX_ONLY");

  const nonSynthetic = await setup({ lead: { ...LEAD, is_test: false } }).call();
  assert.equal(nonSynthetic.status, 403);
  assert.equal((await nonSynthetic.json()).code, "SYNTHETIC_ONLY");

  const dnc = await setup({ lead: { ...LEAD, do_not_contact: true } }).call();
  assert.equal(dnc.status, 409);
  assert.equal((await dnc.json()).code, "CONTACT_BLOCKED");
});

test("TF-024 direct: fehlende oder abgelaufene dynamische Werte blockieren fail-closed", () => {
  assert.equal(buildSalesIntakeMail({ lead: { ...LEAD, website: null }, ...refs, accessToken: TOKEN, accessExpiresAt: EXPIRES, accessOrigin: ENV.JARVIS_WEB_ORIGIN, sandbox: true, now: NOW }).code, "MISSING_WEBSITE");
  assert.equal(buildSalesIntakeMail({ lead: LEAD, ...refs, accessToken: TOKEN, accessExpiresAt: new Date(+NOW - 1_000).toISOString(), accessOrigin: ENV.JARVIS_WEB_ORIGIN, sandbox: true, now: NOW }).code, "ACCESS_LINK_EXPIRED");
  assert.equal(salesIntakeEligibility({ ...LEAD, request: undefined }, { now: NOW }).code, "NO_CONTACT_PERMISSION");
});

test("TF-024 direct: Browserpfad enthält den neuen Button ohne Vorschau-/Bestätigungsdialog", () => {
  const source = fs.readFileSync(new URL("../public/crm.js", import.meta.url), "utf8");
  assert.match(source, /crm-mail-send/);
  assert.match(source, /sales_intake_send/);
  assert.doesNotMatch(source, /window\.confirm\(/, "der direkte Button darf keine zusätzliche Bestätigung öffnen");
});
