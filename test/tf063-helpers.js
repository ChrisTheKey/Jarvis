// TF-063 Test-Gerüst: alle Cloud-Endpunkte mit RAM-Speichern (Auth, CRM CH+VN, Sales, Server Control, Backup, State, Mail),
// synthetische CH-/VN-Leads (keine echten Daten), Owner-Bootstrap über JARVIS_PASSWORD und Verkäufer-Passwörter über die Owner-API.
import { memoryStore } from "../shared-state.js";
import { createStateHandler } from "../shared-state.js";
import { createAuthHandler } from "../auth-api.js";
import { authStoreFrom, resolveActor } from "../auth-core.js";
import { createCrmHandler, crmAgentToken, vnAgentToken } from "../crm-api.js";
import { createSalesHandler } from "../sales-api.js";
import { createSalesData } from "../sales-data.js";
import { createServerControlHandler } from "../server-control.js";
import { createBackupHandler } from "../backup-api.js";
import { createMailRequestHandler } from "../mail-requests.js";
import { cleanCrmLead } from "../lead-crm.js";
import { priorityOf } from "../public/crm-model.js";

export const ORIGIN = "https://jarvis.test";
export const CONTROL = "c".repeat(48);
export const ENV = { JARVIS_PASSWORD: "owner-legacy-pw-123", JARVIS_SERVER_CONTROL_TOKEN: CONTROL, JARVIS_MAIL_WORKER_TOKEN: "w".repeat(48), JARVIS_SYNC_TOKEN: "s".repeat(40) };
export const env = (k) => ENV[k];
export const PW = { giuliano: "Giuliano-Passwort-01", mario: "Mario-Passwort-0002", damiano: "Damiano-Passwort-03", Kudoshin: "Kudoshin-Mat-Khau-0004" };
export const CANTONS = ["ZH", "BE", "LU", "SG", "AG", "TI", "VD", "GE", "BS", "GR", "TG", "SO"];
export const CATS = ["Restaurant", "Treuhand", "Coiffeur", "Hotel", "Geschäft", "Handwerk", "Arztpraxis", "IT"];

// Synthetische CH-Leads (CRM-Sicht) mit gemischten Prioritäten, Kontaktdaten, Kantonen und Branchen.
export function chLeads(n = 900) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const domain = `ch-firma-${String(i).padStart(4, "0")}.ch`;
    const l = { lead_id: domain, company: `CH Firma ${i} AG`, domain, website: `https://${domain}/`, email: i % 6 === 5 ? null : `info@${domain}`,
      phone: i % 3 === 2 ? null : "+41 31 123 45 67", phone_tel: i % 3 === 2 ? null : "tel:+41311234567", canton: CANTONS[(i * 7) % CANTONS.length], municipality: "Ort",
      category: CATS[(i * 5) % CATS.length], first_name: i % 4 === 0 ? "Anna" : null, last_name: i % 4 === 0 ? "Muster" : null,
      findings: Array.from({ length: (i % 4) }, (_, k) => ({ key: `k${k}`, text: k === 0 && i % 2 ? "Der Link zur Kontaktseite führt auf eine Fehlerseite" : "Ein Bild wird nicht angezeigt", confirmed: true, status: "BESTÄTIGT" })),
      sales_stage: i % 50 === 7 ? "CUSTOMER" : i % 40 === 3 ? "NOT_INTERESTED" : "NEW", customer: i % 50 === 7, do_not_contact: i % 30 === 11, dnc_source: i % 30 === 11 ? "opt_out" : null,
      archived: false, contact_status: "NOT_CONTACTED", call_status: "NOT_CALLED", notes: [], call_history: [], updated_at: "2026-10-14T08:00:00Z" };
    l.findings_total = l.findings.length; l.findings_confirmed = l.findings.length;
    l.priority = priorityOf(l);
    out.push(cleanCrmLead(l));
  }
  return out;
}
export function vnLeads(n = 20) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const domain = `vn-cong-ty-${i}.vn`;
    const l = { lead_id: domain, market: "VN", company: `Công ty ${i}`, domain, website: `https://${domain}/`, email: i % 2 ? `lienhe@${domain}` : null, phone: "+84 24 3826 7898", phone_tel: "tel:+842438267898",
      region: i % 2 ? "Đà Nẵng" : "Cà Mau", region_code: i % 2 ? "VN-DN" : "VN-CM", category: "Hotel", language: "vi",
      findings: [{ key: "x", text: "Một liên kết dẫn tới trang lỗi", confirmed: true, status: "AUDIT" }], findings_total: 1, findings_confirmed: 1,
      sales_stage: "NEW", contact_status: "NOT_CONTACTED", call_status: "NOT_CALLED", notes: [], call_history: [], do_not_contact: i === 3, dnc_source: i === 3 ? "crm" : null };
    l.priority = priorityOf(l);
    out.push(cleanCrmLead(l));
  }
  return out;
}

export function makeReq(path, { method = "GET", body, cookie, origin = ORIGIN, headers = {} } = {}) {
  return new Request(ORIGIN + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
}
export const cookieOf = (res) => (res.headers.get("set-cookie") || "").split(";")[0];

export async function setup({ ch = 900, vn = 20, now = () => new Date(), assign = true } = {}) {
  const authMem = {}, salesMem = {}, userMem = {};
  const authStore = authStoreFrom((k) => (authMem[k] ||= memoryStore()));
  const getAuthStore = async () => authStore;
  const getSalesStore = async (k) => (salesMem[k] ||= memoryStore());
  const stores = { queue: memoryStore(), view: memoryStore({ leads: chLeads(ch), generated_at: "2026-10-15T08:00:00Z" }), vnQueue: memoryStore(), vnView: memoryStore({ leads: vnLeads(vn), generated_at: "2026-10-15T08:00:00Z" }),
    control: memoryStore(), leaddb: memoryStore(), state: memoryStore(), mail: memoryStore(), backup: new Map() };
  const auth = createAuthHandler({ env, getStore: getAuthStore, now });
  const crm = createCrmHandler({ env, now, getQueueStore: async () => stores.queue, getViewStore: async () => stores.view, getVnQueueStore: async () => stores.vnQueue,
    getVnViewStore: async () => stores.vnView, getSalesStore, getAuthStore });
  const data = async () => createSalesData({ getViewStore: async () => stores.view, getVnViewStore: async () => stores.vnView, getSalesStore, getControlStore: async () => stores.control });
  const sales = createSalesHandler({ env, data, getSalesStore, getAuthStore, now });
  const ra = (req) => resolveActor(req, { env, getAuthStore, now });
  const server = createServerControlHandler({ env, now, getStore: async () => stores.control, getLeadDbStore: async () => stores.leaddb, resolveActor: ra });
  const backupStore = { async get(k) { return stores.backup.has(k) ? JSON.parse(stores.backup.get(k)) : null; }, async set(k, v) { stores.backup.set(k, v); }, async list({ prefix }) { return { blobs: [...stores.backup.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; }, async delete(k) { stores.backup.delete(k); } };
  const backup = createBackupHandler({ env, getStore: async () => backupStore, resolveActor: ra });
  const state = createStateHandler({ env, now, getStore: async () => stores.state, resolveActor: ra, getUserStore: async (u) => (userMem[u] ||= memoryStore()) });
  const mail = createMailRequestHandler({ env, now, getStore: async () => stores.mail, resolveActor: ra, resolveLead: async (a, id) => (await data()).resolveLead(a, id) });
  const cookies = {};
  const login = async (username, password) => auth(makeReq("/api/auth/login", { method: "POST", body: { username, password } }));
  const r = await login("chris", ENV.JARVIS_PASSWORD);
  cookies.chris = cookieOf(r);
  for (const [u, pw] of Object.entries(PW)) await auth(makeReq("/api/auth/admin/password", { method: "POST", cookie: cookies.chris, body: { user_id: u, password: pw } }));
  for (const [u, pw] of Object.entries(PW)) cookies[u] = cookieOf(await login(u, pw));
  // CRM-/VN-Dienst als online melden (Agent-Pull ohne Sicht).
  await crm(makeReq("/api/crm", { method: "POST", origin: null, headers: { "x-jarvis-crm": crmAgentToken(CONTROL) }, body: { op: "pull" } }));
  await crm(makeReq("/api/crm", { method: "POST", origin: null, headers: { "x-jarvis-vn": vnAgentToken(CONTROL) }, body: { op: "vn_pull" } }));
  let assignReport = null;
  if (assign) assignReport = await (await crm(makeReq("/api/crm", { method: "POST", origin: null, headers: { "x-jarvis-crm": crmAgentToken(CONTROL) }, body: { op: "assign_init", dry_run: false } }))).json();
  const as = (user) => ({ cookie: cookies[user] });
  const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers });
  return { auth, crm, sales, server, backup, state, mail, stores, salesMem, authMem, cookies, login, as, json, assignReport, data };
}
