// FIRST CUSTOMER PRODUCTION READINESS (TF-046) – read-only Preflight für Chris, bevor der erste echte CHF-480-/CHF-150-Kunde
// durch Jarvis läuft. Auf dem VPS (TF-047, separater Repair-Service):  sudo docker exec jarvis-repair-worker node production-readiness.js
// Im Repair-Service (JARVIS_WORKER_ROLE=repair) prüft er statt Gmail/Authority: Isolation (keine Sender Authority) und den
// Zustellweg über die Repair-Outbox (Mail-Worker bestätigt per Herzschlag).
// Lokal (nur Entwicklungsstand):  node production-readiness.js
//
// Harte Regeln:
//   - LÖST NIE EINE AKTION AUS: keine Mail, kein Entwurf, kein Netlify-/Kunden-Aufruf, keine Zahlung, kein Auftrag, kein Schreiben in
//     den Worker-Zustand, kein Schlüssel wird erzeugt (accessKeys wird bewusst NICHT aufgerufen). Netzwerk: nur im Mail-Worker der
//     read-only Gmail-Auth-Check (TF-049: Token-Refresh im Speicher + users.getProfile, gmail.checkAuth). Der Repair-Service liest den
//     Gmail-Status nur aus dem Outbox-Herzschlag des Mail-Workers. Einzige weitere Nebenwirkung: optionaler Chromium-Starttest
//     (about:blank, Temp-Profil in os.tmpdir(), danach gelöscht; --no-launch = ohne).
//   - READY nur mit funktionierendem Gmail OAuth (TF-049): Mail-Worker gesund + Authority VPS + Outbox-Consumer aktiv + read-only
//     Gmail-Check OK. Ein registrierter Outbox-Consumer allein reicht nie.
//   - AUSGABE NUR STATUS: OK / WARN / FAIL bzw. YES / NO. Nie Token, API-Key, Passwort, Private Key, Fingerprint, Host, Benutzer,
//     Bankdaten oder Kundendaten. Secrets nur als «vorhanden: YES/NO».
//   - Ergebnis: «READY FOR FIRST CUSTOMER» nur, wenn kein Punkt FAIL ist; sonst «NOT READY» mit konkreten, sicheren Gründen.
//     Exit-Code 0 = READY, 1 = NOT READY.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const RELEASE_GATE = "TF-049";
export const RELEASE_GATE_SCRIPT = "test:release-049";
export const MIN_FREE_DISK_GB = 10; // konservativ: Chromium-Image + Temp-Profile + Zustand/Backups wachsen
export const WARN_FREE_DISK_GB = 20;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const GB = 1024 ** 3;

// Ein Prüfpunkt: { name, status: OK|WARN|FAIL, detail } – detail ist ein fester, sicherer Text (nie Werte aus Secrets/Env).
const ok = (name, detail) => ({ name, status: "OK", detail });
const warn = (name, detail) => ({ name, status: "WARN", detail });
const fail = (name, detail) => ({ name, status: "FAIL", detail });
const yes = (b) => (b ? "YES" : "NO");
const exists = (f) => { try { return fs.existsSync(f); } catch { return false; } };
const readJson = (f, fallback = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
const parses = (f) => !exists(f) || readJson(f, undefined) !== undefined;

export function freeDiskGb(dir, statfs = fs.statfsSync) {
  let d = dir;
  while (d && !exists(d)) { const up = path.dirname(d); if (up === d) break; d = up; }
  const s = statfs(d || "/");
  return Math.floor((Number(s.bavail) * Number(s.bsize) / GB) * 10) / 10;
}
export function diskCheck(freeGb) {
  if (!Number.isFinite(freeGb)) return fail("Disk", "freier Speicher nicht messbar");
  if (freeGb < MIN_FREE_DISK_GB) return fail("Disk", `${freeGb} GB frei – unter dem Minimum von ${MIN_FREE_DISK_GB} GB (keine automatische Löschung; Chris räumt auf)`);
  if (freeGb < WARN_FREE_DISK_GB) return warn("Disk", `${freeGb} GB frei – über dem Minimum ${MIN_FREE_DISK_GB} GB, aber unter ${WARN_FREE_DISK_GB} GB`);
  return ok("Disk", `${freeGb} GB frei (Minimum ${MIN_FREE_DISK_GB} GB)`);
}

// Secret-Präsenz – nur YES/NO, nie Werte. required = für den ersten Kundenauftrag zwingend.
export function secretsPresence({ env = process.env, secretsDir, workerDir, service = "mail" }) {
  if (service === "repair") return [
    { name: "JARVIS_MAIL_WORKER_TOKEN", present: !!env.JARVIS_MAIL_WORKER_TOKEN, required: true, why: "sicherer Zugangslink (Intake)" },
    { name: "access_intake_private.pem", present: exists(path.join(workerDir, "access_intake_private.pem")), required: false, why: "wird beim ersten Kundenzugang erzeugt" },
  ];
  return [
    { name: "JARVIS_MAIL_WORKER_TOKEN", present: !!env.JARVIS_MAIL_WORKER_TOKEN, required: true, why: "send_authority + sicherer Zugangslink (Intake)" },
    { name: "ANTHROPIC_API_KEY", present: !!env.ANTHROPIC_API_KEY, required: false, why: "Antworttexte" },
    { name: "JARVIS_SERVER_CONTROL_TOKEN", present: !!env.JARVIS_SERVER_CONTROL_TOKEN, required: false, why: "Server Control" },
    { name: "gmail_credentials.json", present: exists(path.join(secretsDir, "gmail_credentials.json")), required: true, why: "Gmail" },
    { name: "gmail_token.json", present: exists(path.join(secretsDir, "gmail_token.json")), required: true, why: "Gmail" },
    { name: "access_intake_private.pem", present: exists(path.join(workerDir, "access_intake_private.pem")), required: false, why: "wird beim ersten Kundenzugang erzeugt" },
  ];
}

// Alle Prüfungen – read-only. deps erlauben Tests ohne VPS (env, Verzeichnisse, statfs, Chromium-Start).
export async function readinessReport({ env = process.env, secretsDir = env.JARVIS_SECRETS_DIR || path.join(ROOT, ".secrets"),
  workerDir = path.join(secretsDir, "mail_worker"), statfs = fs.statfsSync, launchChromium = true, now = Date.now(),
  service = env.JARVIS_WORKER_ROLE === "repair" ? "repair" : "mail", outboxDir = env.JARVIS_REPAIR_OUTBOX || path.join(secretsDir, "repair_outbox"),
  gmailCheck = null } = {}) {
  const checks = [];
  const add = (c) => { checks.push(c); return c; };
  const load = async (name, spec) => { try { return await import(spec); } catch (e) { add(fail(name, `Modul nicht ladbar (${String(e.code || "Fehler").slice(0, 40)})`)); return null; } };

  // ---------- Core ----------
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const mw = await load("Core", "./mail-worker.js");
  if (service === "repair") {
    // ---------- TF-047: Repair-Service (eigener Container) ----------
    const rs = await load("Core", "./repair-service.js");
    const ob = await load("Delivery", "./repair-outbox.js");
    if (rs) {
      if (nodeMajor < 18) add(fail("Core", `Node ${nodeMajor} – mindestens 18`));
      else if (!exists(workerDir)) add(fail("Core", "Repair-Zustand fehlt"));
      else if (!rs.serviceHealthy(workerDir, now)) add(fail("Core", "Repair-Service läuft nicht (kein Herzschlag in den letzten 5 Minuten)"));
      else add(ok("Core", `Repair-Service läuft · Node ${nodeMajor}`));
      const bad = rs.isolationViolations({ secretsDir, env });
      add(bad.length ? fail("Isolation", `${bad.length} Verstoss/Verstösse – Repair-Service darf keine Sender Authority haben`) : ok("Isolation", "kein Gmail-Zugang, keine Sender Authority, kein Anthropic-Key"));
    }
    if (ob) {
      const st = ob.outboxStatus(outboxDir, { now });
      // TF-049: Gmail OAuth des Mail-Workers – nur aus seinem Herzschlag (der Repair-Service hat bewusst keinen Gmail-Zugang).
      const ga = st.gmail_auth;
      const mailOk = !!(st.consumer_online && ga?.fresh && ga.ok);
      if (!st.consumer_online || !ga) add(fail("Mail", "Mail-Worker meldet keinen Gmail-OAuth-Status (kein Herzschlag oder Mail-Worker-Update nötig)"));
      else if (!ga.fresh) add(fail("Mail", "Gmail-OAuth-Status des Mail-Workers veraltet"));
      else if (!ga.ok) add(fail("Mail", `Gmail OAuth FAIL (${ga.category})`));
      else add(ok("Mail", "Gmail OAuth OK (read-only Prüfung durch den Mail-Worker)"));
      if (!st.exists || !st.writable) add(fail("Delivery", "Repair-Outbox fehlt oder ist nicht beschreibbar"));
      else if (!st.consumer_online) add(fail("Delivery", "Mail-Worker stellt die Repair-Outbox (noch) nicht zu – kein Herzschlag (Mail-Worker-Update nötig)"));
      else if (!mailOk) add(fail("Delivery", "Zustellung unmöglich – Gmail OAuth des Mail-Workers nicht bestätigt"));
      else add(ok("Delivery", `Service-Mails über die Outbox → Mail-Worker (Sender Authority) · offen ${st.pending}`));
    }
  } else if (mw) {
    const beat = mw.healthy(workerDir, now);
    const role = mw.workerRole(env);
    if (nodeMajor < 18) add(fail("Core", `Node ${nodeMajor} – mindestens 18`));
    else if (!exists(workerDir)) add(fail("Core", "Worker-Zustand fehlt"));
    else if (!beat) add(fail("Core", "Mail-Worker läuft nicht (kein Herzschlag in den letzten 5 Minuten)"));
    else add(ok("Core", `Worker läuft · Rolle ${role === "vps" ? "VPS" : "LOKAL"} · Node ${nodeMajor}`));
  }

  // ---------- Authority (genau ein Sender: VPS) – nur im Mail-Worker ----------
  const auth = readJson(path.join(workerDir, "authority.json"), null);
  const role = env.JARVIS_WORKER_ROLE === "vps" ? "vps" : "local";
  if (service === "repair") { /* Repair-Service ist nie Sender Authority (siehe Isolation/Delivery) */ }
  else if (role !== "vps") add(fail("Authority", "kein VPS-Worker (lokaler Stand hat keine Send Authority)"));
  else if (auth?.holder !== "vps" || auth?.self !== true) add(fail("Authority", "VPS ist (noch) nicht als send_authority bestätigt"));
  else add(ok("Authority", "VPS hat send_authority"));

  // ---------- Secrets (nur YES/NO) ----------
  const secrets = secretsPresence({ env, secretsDir, workerDir, service });

  // ---------- Mail ----------
  const gmailReady = secrets.filter((s) => s.why === "Gmail").every((s) => s.present);
  const registryOk = parses(path.join(secretsDir, "gmail_jarvis.json"));
  const gm = service === "repair" ? null : await load("Mail", "./gmail.js");
  let mailAuthOk = false;
  if (gm) {
    const classes = gm.SERVICE_MESSAGE_CLASSES || [];
    if (!gmailReady) add(fail("Mail", "Gmail-Zugang fehlt (Credentials/Token)"));
    else if (!registryOk) add(fail("Mail", "Gmail-Register nicht lesbar"));
    else if (!["CUSTOMER_ORDER_FULFILLMENT", "CUSTOMER_ACCESS_REQUEST"].every((c) => classes.includes(c))) add(fail("Mail", "Service-Mailklassen fehlen"));
    else {
      // TF-049: Gmail OAuth wirklich prüfen – read-only (Refresh im Speicher + users.getProfile), nie Senden/Entwurf/Label.
      const cats = gm.AUTH_FAIL_CATEGORIES || [];
      const check = gmailCheck || ((o) => gm.checkAuth(o));
      const a = await Promise.resolve().then(() => check({ secretsDir })).catch(() => ({ ok: false, category: "unknown_auth_error" }));
      mailAuthOk = a?.ok === true;
      if (!mailAuthOk) add(fail("Mail", `Gmail OAuth FAIL (${cats.includes(a?.category) ? a.category : "unknown_auth_error"})`));
      else add(ok("Mail", "Gmail OAuth OK (read-only users.getProfile) · Service-Klassen CUSTOMER_ACCESS_REQUEST + CUSTOMER_ORDER_FULFILLMENT"));
    }
  }
  // ---------- Delivery (Mail-Worker): Repair-Outbox-Consumer aktiv + Gmail funktionsfähig ----------
  if (service !== "repair") {
    const ob = await load("Delivery", "./repair-outbox.js");
    if (ob) {
      const st = ob.outboxStatus(outboxDir, { now });
      if (!st.exists) add(fail("Delivery", "Repair-Outbox fehlt (Mount /data/repair-outbox)"));
      else if (!st.consumer_online) add(fail("Delivery", "Repair-Outbox-Consumer nicht aktiv (kein Herzschlag in den letzten 10 Minuten)"));
      else if (!mailAuthOk) add(fail("Delivery", "Zustellung unmöglich – Gmail OAuth FAIL"));
      else add(ok("Delivery", `Repair-Outbox-Consumer aktiv · Gmail OAuth OK · offen ${st.pending}`));
    }
  }

  // ---------- Payments ----------
  const pay = await load("Payments", "./payments.js");
  if (pay) {
    const t150 = pay.paymentThresholdChf("REPAIR_CHECK_150"), t480 = pay.paymentThresholdChf("REPAIR_FIX_500");
    if (t150 !== 75 || t480 !== 240) add(fail("Payments", "Zahlungsschwellen weichen ab"));
    else if (!parses(path.join(workerDir, pay.PAYMENTS_FILE))) add(fail("Payments", "Zahlungsbuch nicht lesbar"));
    else add(ok("Payments", "Ledger lesbar · Schwellen CHF 75 / CHF 240"));
  }

  // ---------- CHF 150 ----------
  const sales = await load("CHF150", "./sales.js");
  const c150 = await load("CHF150", "./check-150-workflow.js");
  if (sales && c150) {
    if (sales.OFFERS.REPAIR_CHECK_150?.price !== 150) add(fail("CHF150", "Preis weicht ab"));
    else if (c150.FULFILLMENT_CLASS !== "CUSTOMER_ORDER_FULFILLMENT") add(fail("CHF150", "Liefer-Mailklasse fehlt"));
    else if (!parses(path.join(workerDir, c150.CHECK150_ORDERS_FILE))) add(fail("CHF150", "Auftragsdatei nicht lesbar"));
    else add(ok("CHF150", "Check & Anleitung · Deposit CHF 75 · automatische Lieferung (ATTACHMENT_REQUIRED bei langem Bericht)"));
  }

  // ---------- CHF 480 ----------
  const rw = await load("CHF480", "./repair-workflow.js");
  if (sales && rw) {
    const src = rw.runRepairOrders.toString();
    if (sales.OFFERS.REPAIR_FIX_500?.price !== 480) add(fail("CHF480", "Preis weicht ab"));
    else if (!/requireBrowser = true/.test(src) || !/autoDeliver = true/.test(src)) add(fail("CHF480", "Produktionslauf ohne Browser-Gate oder ohne Lieferung"));
    else if (!parses(path.join(workerDir, rw.REPAIR_ORDERS_FILE))) add(fail("CHF480", "Auftragsdatei nicht lesbar"));
    else add(ok("CHF480", "Check & Reparatur · Deposit CHF 240 · Browser-Gate Pflicht · Lieferung CUSTOMER_ORDER_FULFILLMENT"));
  }

  // ---------- Sicherer Zugangslink (Intake) – Konfiguration nur geprüft, nie aufgerufen ----------
  const ls = await load("CHF480", "./local-state.js");
  const ai = await load("CHF480", "./access-intake.js");
  if (ls && ai) {
    // Ursprung wie im Worker (syncConfig), Worker-Token aus dem geprüften env – nur Konfiguration, kein Aufruf.
    const client = ai.intakeClient({ config: { ...ls.syncConfig(), workerToken: env.JARVIS_MAIL_WORKER_TOKEN || "" }, fetchFn: async () => { throw new Error("readiness: kein Netz"); } });
    if (!client) add(fail("Access Intake", "sicherer Zugangslink nicht konfiguriert (Worker-Token/HTTPS-Ursprung)"));
    else add(ok("Access Intake", "sicherer One-Time-Link konfiguriert (HTTPS)"));
  }

  // ---------- Adapter Registry / Profile Builder / Host-Key ----------
  const router = await load("Adapter Registry", "./repair-adapters/router.js");
  if (router) {
    try {
      const reg = await router.createAdapterRegistry({ dir: workerDir, fetchFn: async () => { throw new Error("readiness: kein Netz"); } });
      const keys = Object.keys(reg.adapters).sort();
      const need = ["sftp", "ssh", "wordpress"];
      if (!need.every((k) => keys.includes(k))) add(fail("Adapter Registry", "Adapter fehlen"));
      else add(ok("Adapter Registry", `ACTIVE · ${need.length} Kunden-Adapter (WordPress, SFTP, SSH) + GitHub/Netlify mit Mapping`));
      if (!reg.preflight || typeof reg.preflight.run !== "function") add(fail("Profile Builder", "Preflight nicht verfügbar"));
    } catch { add(fail("Adapter Registry", "Registry nicht erstellbar")); }
  }
  const pb = await load("Profile Builder", "./repair-adapters/profile-builder.js");
  if (pb && !checks.some((c) => c.name === "Profile Builder")) {
    if (!pb.PROFILE_STATUSES?.includes("PROFILE_READY")) add(fail("Profile Builder", "Profilstatus fehlt"));
    else add(ok("Profile Builder", "ACTIVE · automatisches PROFILE_READY (nur lesend)"));
  }
  let ssh2 = false; try { require.resolve("ssh2"); ssh2 = true; } catch {}
  const hk = await load("Host-Key", "./repair-adapters/host-key.js");
  if (hk) add(ssh2 ? ok("Host-Key", "ACTIVE · Verifier ladbar (ssh2), Pinning + kein Legacy-Downgrade") : fail("Host-Key", "SSH-Bibliothek fehlt"));

  // ---------- Browser Validator / Chromium ----------
  const bv = await load("Browser", "./repair-browser-validator.js");
  if (bv) {
    const rt = bv.browserRuntimeStatus();
    add(rt.library ? ok("Browser", "Browser-Validator ladbar (playwright-core)") : fail("Browser", "playwright-core fehlt"));
    if (!rt.chromium) add(fail("Chromium", "Chromium nicht installiert"));
    else if (!launchChromium) add(warn("Chromium", "installiert · Starttest übersprungen (--no-launch)"));
    else {
      const v = await bv.loadBrowserValidator().catch(() => null); // startet + schliesst Chromium (about:blank), Temp-Profil wird gelöscht
      add(v ? ok("Chromium", "installiert · headless Start erfolgreich") : fail("Chromium", "Chromium startet nicht"));
    }
  }

  // ---------- Backup ----------
  const bk = await load("Backup", "./backup.js");
  if (bk && mw) {
    const pem = (() => { try { return mw.backupPublicKey(); } catch { return null; } })();
    const info = bk.backupInfo(workerDir);
    const ageH = info?.last_at ? (now - Date.parse(info.last_at)) / 3600e3 : Infinity;
    if (!pem) add(fail("Backup", "Backup-Public-Key fehlt"));
    else if (!info?.last_at) add(fail("Backup", "noch kein State-Backup"));
    // Repair-Service: nur lokal verschlüsselt (Offsite je Tag gehört dem Mail-Worker) – kein Offsite ist hier kein Fehler.
    else if (service === "repair" && ageH <= 48) add(ok("Backup", `letztes lokales State-Backup vor ${Math.max(0, Math.round(ageH))} h · Generationen ${info.generations ?? "–"} (verschlüsselt)`));
    else if (info.ok === false) add(fail("Backup", "letztes State-Backup fehlgeschlagen"));
    else if (ageH > 48) add(fail("Backup", `letztes State-Backup älter als 48 h (${Math.round(ageH)} h)`));
    else add(ok("Backup", `letztes State-Backup vor ${Math.max(0, Math.round(ageH))} h · Generationen ${info.generations ?? "–"}`));
  }

  // ---------- Disk ----------
  try { add(diskCheck(freeDiskGb(workerDir, statfs))); } catch { add(fail("Disk", "freier Speicher nicht messbar")); }

  // ---------- Release Gate ----------
  const pkg = readJson(path.join(ROOT, "package.json"), {});
  add(pkg.scripts?.[RELEASE_GATE_SCRIPT] ? ok("Release Gate", `${RELEASE_GATE} (npm run ${RELEASE_GATE_SCRIPT})${env.JARVIS_COMMIT ? ` · Deploy ${String(env.JARVIS_COMMIT).replace(/[^0-9a-f]/gi, "").slice(0, 12)}` : ""}`)
    : warn("Release Gate", `${RELEASE_GATE} – Skript im Image nicht enthalten`));

  for (const s of secrets) if (s.required && !s.present) checks.push(fail("Secrets", `${s.name} fehlt (${s.why})`));
  const failed = checks.filter((c) => c.status === "FAIL");
  return { release_gate: RELEASE_GATE, service, ready: failed.length === 0, checks, secrets: secrets.map(({ name, present, required }) => ({ name, present: yes(present), required })),
    reasons: failed.map((c) => `${c.name}: ${c.detail}`) };
}

export function formatReport(r) {
  const order = ["Core", "Isolation", "Delivery", "Mail", "Payments", "CHF150", "CHF480", "Access Intake", "Adapter Registry", "Profile Builder", "Host-Key", "Browser", "Chromium", "Backup", "Authority", "Disk", "Release Gate"];
  const lines = [`JARVIS PRODUCTION READINESS (${r.release_gate}${r.service === "repair" ? ", Repair-Service" : ""}) – read-only, keine Aktion ausgelöst`, ""];
  for (const name of order) for (const c of r.checks.filter((x) => x.name === name)) lines.push(`${(c.name + ":").padEnd(18)} ${c.status.padEnd(4)}  ${c.detail}`);
  lines.push("", "Secrets (nur vorhanden ja/nein):");
  for (const s of r.secrets) lines.push(`  ${s.name.padEnd(28)} ${s.present}${s.required ? "  (Pflicht)" : ""}`);
  lines.push("", r.ready ? "READY FOR FIRST CUSTOMER" : "NOT READY");
  if (!r.ready) for (const why of r.reasons) lines.push(`  - ${why}`);
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes("--json");
  readinessReport({ launchChromium: !process.argv.includes("--no-launch") }).then((r) => {
    console.log(json ? JSON.stringify(r, null, 2) : formatReport(r));
    process.exit(r.ready ? 0 : 1);
  }, (e) => { console.error(`NOT READY\n  - Readiness-Prüfung abgebrochen (${String(e.message).slice(0, 80)})`); process.exit(1); });
}
