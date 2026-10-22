// SERVICE SEPARATION LAB (TF-047) – echter Container-Beweis gegen Docker Desktop/Engine, nie auf dem Produktions-VPS.
//   - Projekt «jarvis-mail-lab047»: Lab-Mail-Worker (mail-stub.mjs) mit Herzschlag, Scheduler-Ticks, Authority, Queue und der ECHTEN
//     Outbox-Zustellung (processRepairOutbox).
//   - Projekt «jarvis-repair-lab047»: der ECHTE Repair-Service aus deploy/vps/Dockerfile.repair (Chromium, repair-service.js),
//     deployt mit dem ECHTEN Server-Skript deploy/vps/repair-remote.sh (nur Lab-Namen/Pfade als Parameter, healthcheck schneller).
// Beweist: A Mail-Worker läuft · B Repair start/stop/restart unabhängig · C Repair-Deploy ändert Mail-Container/Scheduler/Queue/
// Authority nicht (ID, StartedAt, RestartCount) · E Service-Mail genau einmal über die Outbox · F Mail-Worker offline → nie
// «gesendet» · G Repair offline → Mailing läuft weiter · Deploy-Guard (falsches Ziel → DEPLOY BLOCKED, nichts verändert).
// Start: npm run test:separation-integration (JARVIS_REPAIR_LAB=1). Räumt Container/Volumes/Netze/Lab-Image ab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docker, dockerAvailable } from "../repair-lab/lab.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..", "..");
const ENABLED = process.env.JARVIS_REPAIR_LAB === "1";
const LABEL = "jarvis.lab=tf047";
const MAIL_PROJECT = "jarvis-mail-lab047", REPAIR_PROJECT = "jarvis-repair-lab047";
const MAIL = `${MAIL_PROJECT}-mail-worker-1`, REPAIR = "jarvis-repair-worker-lab047", REPAIR_IMAGE = "jarvis-repair-worker:lab047";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posix = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, d) => "/" + d.toLowerCase()).replace(/\\/g, "/") : p);
const fwd = (p) => p.replace(/\\/g, "/");
// Windows: System-tar (bsdtar) – GNU-tar aus Git Bash hielte «C:» für einen Remote-Host.
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const lab = {};

function bashPath() {
  if (process.platform !== "win32") return "bash";
  const core = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(); // …/Git/mingw64/libexec/git-core
  const b = path.join(core, "..", "..", "..", "bin", "bash.exe");
  if (!fs.existsSync(b)) throw new Error("Git Bash nicht gefunden");
  return b;
}
// Arbeitsstand (getrackt + neu, ohne Ignoriertes und ohne workspace/) als Archiv – entspricht «git archive» nach dem Commit.
function snapshot(out, mutate = null) {
  const list = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter((f) => f && !f.startsWith("workspace/") && fs.existsSync(path.join(ROOT, f)));
  const dir = fs.mkdtempSync(path.join(lab.tmp, "snap-"));
  for (const f of list) { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(dir, f)); }
  if (mutate) mutate(dir);
  execFileSync(TAR, ["-czf", out, "-C", dir, "."], { windowsHide: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
function remoteDeploy(env) {
  return new Promise((resolve) => {
    execFile(lab.bash, [posix(path.join(ROOT, "deploy", "vps", "repair-remote.sh"))], { env: { ...process.env, SUDO: "", OWNER: "", HEALTH_TIMEOUT: "300",
      R: posix(lab.repairRoot), PAY: posix(path.join(lab.tmp, "jarvis-payment")), MAIL_ROOT: posix(lab.mailRoot), MAIL_CONTAINER: MAIL, MAIL_PROJECT, REPAIR_PROJECT, REPAIR_CONTAINER: REPAIR,
      COMPOSE_OVERRIDE: posix(lab.override), ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 1_500_000, windowsHide: true },
    (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout) + String(stderr) }));
  });
}
const inspect = async (c) => { const r = await docker(["inspect", "-f", "{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", c], { allowFail: true });
  if (r.code) return null; const [id, started, restarts, running, health] = r.stdout.trim().split("|"); return { id, started, restarts: Number(restarts), running: running === "true", health }; };
const mailFiles = () => Object.fromEntries(["authority.json", "cloud_requests.json"].map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(lab.mailSecrets, "mail_worker", f))).digest("hex")]));
const ticks = () => fs.readFileSync(path.join(lab.mailSecrets, "mail_worker", "worker.log"), "utf8").split("\n").filter((l) => l.includes('"event":"tick"')).length;
const sent = () => (fs.existsSync(path.join(lab.mailSecrets, "lab_sent.jsonl")) ? fs.readFileSync(path.join(lab.mailSecrets, "lab_sent.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function waitFor(fn, what, ms = 120_000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(1000); } throw new Error(`${what}: Zeitüberschreitung`); }
const healthy = (c) => waitFor(async () => (await inspect(c))?.health === "healthy", `${c} healthy`, 300_000);
// Mail-Worker-Invariante: identischer Container, kein Neustart, Scheduler tickt weiter, Queue/Authority unverändert.
async function assertMailUntouched(before, { ticksBefore, files }) {
  const after = await inspect(MAIL);
  assert.deepEqual([after.id, after.started, after.restarts, after.running], [before.id, before.started, before.restarts, true], "Mail-Worker recreated/restarted");
  assert.equal(after.health, "healthy");
  await waitFor(async () => ticks() > ticksBefore + 2, "Scheduler tickt weiter", 30_000);
  assert.deepEqual(mailFiles(), files, "Queue/Authority unverändert");
}
// Service-Mail im Repair-Container erzeugen und übergeben (echter Outbox-Erzeuger) bzw. Status abfragen.
async function repairOutbox(op, id = "") {
  const js = `import { createOutboxMailer } from "/app/repair-outbox.js";
const m = createOutboxMailer({ dir: process.env.JARVIS_REPAIR_OUTBOX });
let id = ${JSON.stringify(id)};
if (${JSON.stringify(op)} === "create") id = (await m.createDraft({ to: "kunde@lab047.test", subject: "Lab Bericht", body: "Lab", messageClass: "CUSTOMER_ORDER_FULFILLMENT" })).draftId;
try { await m.sendDraft(id); console.log(JSON.stringify({ id, status: "sent" })); } catch (e) { console.log(JSON.stringify({ id, status: e.code === "OUTBOX_PENDING" ? "pending" : "error", error: e.message })); }`;
  const r = await docker(["exec", "-i", REPAIR, "node", "--input-type=module", "-"], { input: js });
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

test("TF-047 Lab: Aufbau – Docker verfügbar, Lab-Mail-Worker (eigenes Projekt) läuft und tickt (A)", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  assert.ok(await dockerAvailable(), "Docker nicht verfügbar – TF-047-Lab braucht Docker (kein Skip im Release-Gate)");
  lab.bash = bashPath();
  lab.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-lab047-"));
  for (const k of ["mailRoot", "repairRoot"]) { lab[k] = path.join(lab.tmp, k); fs.mkdirSync(lab[k]); }
  lab.mailSecrets = path.join(lab.mailRoot, "secrets"); fs.mkdirSync(lab.mailSecrets);
  fs.mkdirSync(path.join(lab.repairRoot, "outbox"));
  // TF-JARVIS-021: Linux-Docker (CI-Runner UID 1001) – Container laufen als 1000 (node). Auf dem VPS setzt repair-remote.sh die
  // Besitzer per OWNER; im Lab (OWNER="") müssen die Bind-Mounts für 1000 beschreibbar sein (Docker Desktop: ohnehin der Fall).
  if (process.platform !== "win32") for (const d of [lab.mailSecrets, ...["state", "outbox", "crm-export"].map((s) => path.join(lab.repairRoot, s))]) { fs.mkdirSync(d, { recursive: true }); fs.chmodSync(d, 0o777); }
  fs.writeFileSync(path.join(lab.mailRoot, ".env"), "JARVIS_MAIL_WORKER_TOKEN=lab047-worker-token-not-real\nANTHROPIC_API_KEY=lab047-must-never-be-copied\nJARVIS_SYNC_URL=https://jarvis-lab047.invalid\n");
  await cleanup();
  lab.appMail = path.join(lab.tmp, "app-mail"); fs.mkdirSync(lab.appMail);
  execFileSync(TAR, ["-xzf", snapshot(path.join(lab.tmp, "a.tgz")), "-C", lab.appMail], { windowsHide: true });
  // Linux: «./» im Archiv stammt aus mkdtemp (0700) und überträgt diesen Modus auf app-mail → /app wäre für UID 1000 unlesbar.
  if (process.platform !== "win32") fs.chmodSync(lab.appMail, 0o755);
  lab.tgzA = path.join(lab.tmp, "a.tgz");
  fs.writeFileSync(path.join(lab.mailRoot, "docker-compose.yml"), `name: ${MAIL_PROJECT}
services:
  mail-worker:
    image: node:22-alpine
    labels: ["${LABEL}"]
    command: ["node", "/app/test/integration/service-separation-047/mail-stub.mjs"]
    environment: { JARVIS_LAB_MAIL_STUB: "1", JARVIS_SECRETS_DIR: /data/secrets, JARVIS_REPAIR_OUTBOX: /data/repair-outbox }
    user: "1000:1000"
    read_only: true
    restart: unless-stopped
    volumes: ["${fwd(lab.appMail)}:/app:ro", "${fwd(lab.mailSecrets)}:/data/secrets", "${fwd(path.join(lab.repairRoot, "outbox"))}:/data/repair-outbox"]
    healthcheck: { test: ["CMD", "node", "/app/test/integration/service-separation-047/mail-stub.mjs", "--healthcheck"], interval: 2s, timeout: 5s, retries: 3, start_period: 2s }
`);
  lab.override = path.join(lab.tmp, "repair-override.yml");
  fs.writeFileSync(lab.override, `services:
  repair-worker:
    container_name: ${REPAIR}
    image: ${REPAIR_IMAGE}
    labels: ["${LABEL}"]
    environment: { JARVIS_REPAIR_POLL_SECONDS: "30" }
    healthcheck: { interval: 3s, start_period: 5s, retries: 3 }
`);
  await docker(["compose", "-p", MAIL_PROJECT, "-f", path.join(lab.mailRoot, "docker-compose.yml"), "up", "-d"], { timeoutMs: 600_000 });
  await healthy(MAIL).catch(async (e) => { const l = await docker(["logs", "--tail", "40", MAIL], { allowFail: true }); console.log(`[${MAIL} logs]\n${l.stdout}${l.stderr}`); throw e; });
  const t0 = ticks();
  await waitFor(async () => ticks() > t0 + 2, "Mail-Scheduler tickt");
  lab.mail0 = await inspect(MAIL);
  assert.equal(lab.mail0.running, true);
});

test("TF-047 Lab C: Erster Repair-Deploy (echtes repair-remote.sh) – nur repair-worker gebaut/gestartet; Mail-Worker ID/StartedAt/RestartCount/Scheduler/Queue/Authority unverändert", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  const before = await inspect(MAIL), base = { ticksBefore: ticks(), files: mailFiles() }, sentBefore = sent().length;
  const r = await remoteDeploy({ COMMIT: "lab047a", APP_TGZ: posix(lab.tgzA) });
  assert.equal(r.code, 0, r.out.slice(-3000));
  for (const s of ["TARGET OK", "MAIL_WORKER_UNTOUCHED=YES", "REPAIR_DEPLOY=OK lab047a", "RestartCount unverändert (delta 0): JA", "StartedAt unverändert: JA", "Container unverändert (nicht recreated): JA", "Authority unverändert: JA"]) assert.ok(r.out.includes(s), `${s}\n${r.out.slice(-2000)}`);
  assert.ok(!r.out.includes("lab047-worker-token-not-real") && !r.out.includes("lab047-must-never-be-copied"), "keine Secret-Werte in der Ausgabe");
  await assertMailUntouched(before, base);
  assert.equal(sent().length, sentBefore);
  const rep = await inspect(REPAIR);
  assert.deepEqual([rep.running, rep.health], [true, "healthy"]);
  const env = fs.readFileSync(path.join(lab.repairRoot, ".env"), "utf8");
  assert.ok(env.includes("JARVIS_MAIL_WORKER_TOKEN=") && !env.includes("ANTHROPIC_API_KEY"), "nur erlaubte Schlüssel übernommen");
  const labels = (await docker(["inspect", "-f", '{{index .Config.Labels "com.docker.compose.project"}}', REPAIR])).stdout.trim();
  assert.equal(labels, REPAIR_PROJECT);
  const st = JSON.parse((await docker(["exec", REPAIR, "node", "repair-service.js", "--status"])).stdout);
  assert.deepEqual([st.role, st.healthy, st.commit, st.outbox.exists, st.outbox.writable], ["repair", true, "lab047a", true, true]);
  // Chromium nur hier, Gmail-Modul fehlt im Repair-Image strukturell.
  assert.equal((await docker(["exec", REPAIR, "sh", "-c", "test -x /usr/bin/chromium && test ! -e /app/gmail.js && echo ok"])).stdout.trim(), "ok");
  const ro = await docker(["exec", REPAIR, "sh", "-c", "awk '$2==\"/\"{print $4}' /proc/mounts | cut -d, -f1"]);
  assert.equal(ro.stdout.trim(), "ro", "rootfs read-only");
  lab.repairA = rep;
});

test("TF-047 Lab B: Repair-Service stop/start/restart unabhängig – Mail-Worker unberührt", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  const before = await inspect(MAIL), base = { ticksBefore: ticks(), files: mailFiles() };
  await docker(["stop", REPAIR]);
  assert.equal((await inspect(REPAIR)).running, false);
  await docker(["start", REPAIR]); await healthy(REPAIR);
  await docker(["restart", REPAIR]); await healthy(REPAIR);
  await docker(["compose", "-p", REPAIR_PROJECT, "-f", path.join(lab.repairRoot, "docker-compose.yml"), "-f", lab.override, "--project-directory", lab.repairRoot, "restart", "repair-worker"]);
  await healthy(REPAIR);
  await assertMailUntouched(before, base);
});

test("TF-047 Lab E: Service-Mail GENAU EINMAL über die Outbox (Repair-Container erzeugt, Mail-Worker sendet) – auch nach Repair-Neustart kein Doppelversand", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  const before = await inspect(MAIL), base = { ticksBefore: ticks(), files: mailFiles() }, n0 = sent().length;
  const a = await repairOutbox("create");
  assert.equal(a.status, "pending", "erst nach Bestätigung des Mail-Workers «gesendet»");
  await waitFor(async () => sent().length === n0 + 1, "Mail-Worker sendet");
  assert.equal((await repairOutbox("send", a.id)).status, "sent");
  await docker(["restart", REPAIR]); await healthy(REPAIR);
  assert.equal((await repairOutbox("send", a.id)).status, "sent");
  await sleep(4000);
  assert.equal(sent().length, n0 + 1, "genau einmal");
  assert.equal(sent().at(-1).message_class, "CUSTOMER_ORDER_FULFILLMENT");
  await assertMailUntouched(before, base);
});

test("TF-047 Lab G: Repair-Service offline → 24/7-Mailing läuft unverändert weiter", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  const before = await inspect(MAIL), base = { ticksBefore: ticks(), files: mailFiles() };
  await docker(["stop", REPAIR]);
  const t = ticks();
  await waitFor(async () => ticks() > t + 5, "Mail-Scheduler tickt ohne Repair-Service", 30_000);
  assert.equal((await inspect(MAIL)).health, "healthy");
  await assertMailUntouched(before, base);
  await docker(["start", REPAIR]); await healthy(REPAIR);
});

test("TF-047 Lab C2: Zweiter Repair-Deploy (neuer Stand) – Repair-Container ersetzt, Mail-Worker weiterhin unverändert", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  const before = await inspect(MAIL), base = { ticksBefore: ticks(), files: mailFiles() }, repBefore = await inspect(REPAIR);
  const tgzB = snapshot(path.join(lab.tmp, "b.tgz"), (d) => fs.appendFileSync(path.join(d, "README.md"), "\nlab047b\n"));
  const r = await remoteDeploy({ COMMIT: "lab047b", APP_TGZ: posix(tgzB) });
  assert.equal(r.code, 0, r.out.slice(-3000));
  assert.ok(r.out.includes("MAIL_WORKER_UNTOUCHED=YES"));
  const rep = await inspect(REPAIR);
  assert.notEqual(rep.id, repBefore.id, "Repair-Container wurde ersetzt");
  assert.equal(JSON.parse((await docker(["exec", REPAIR, "node", "repair-service.js", "--status"])).stdout).commit, "lab047b");
  await assertMailUntouched(before, base);
});

test("TF-047 Lab Guard: falsches Ziel (Mail-Projekt = Repair-Projekt bzw. zweiter Service in der Compose-Datei) → DEPLOY BLOCKED, nichts verändert", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  const before = await inspect(MAIL), base = { ticksBefore: ticks(), files: mailFiles() }, repBefore = await inspect(REPAIR);
  const r1 = await remoteDeploy({ COMMIT: "lab047x", APP_TGZ: posix(lab.tgzA), MAIL_PROJECT: REPAIR_PROJECT });
  assert.equal(r1.code, 3, r1.out.slice(-1500));
  assert.match(r1.out, /DEPLOY BLOCKED/);
  const tgzBad = snapshot(path.join(lab.tmp, "bad.tgz"), (d) => fs.appendFileSync(path.join(d, "deploy", "vps", "repair", "docker-compose.yml"), "  mail-worker:\n    image: jarvis-mail-worker:latest\n"));
  const r2 = await remoteDeploy({ COMMIT: "lab047y", APP_TGZ: posix(tgzBad) });
  assert.equal(r2.code, 3, r2.out.slice(-1500));
  assert.match(r2.out, /DEPLOY BLOCKED: Compose-Datei definiert nicht genau den einen Service/);
  assert.equal((await inspect(REPAIR)).id, repBefore.id, "Repair-Container unverändert");
  assert.equal(fs.readFileSync(path.join(lab.repairRoot, "DEPLOYED_COMMIT"), "utf8").trim(), "lab047b");
  await assertMailUntouched(before, base);
});

test("TF-047 Lab F: Mail-Worker offline → Repair markiert Zustellung nie als gesendet; nach Rückkehr genau einmal", { skip: !ENABLED && "nur mit JARVIS_REPAIR_LAB=1" }, async () => {
  const n0 = sent().length;
  await docker(["stop", MAIL]);
  const a = await repairOutbox("create");
  for (let i = 0; i < 3; i++) { await sleep(1500); assert.equal((await repairOutbox("send", a.id)).status, "pending"); }
  assert.equal(sent().length, n0);
  await docker(["start", MAIL]); await healthy(MAIL);
  await waitFor(async () => sent().length === n0 + 1, "Zustellung nach Rückkehr");
  assert.equal((await repairOutbox("send", a.id)).status, "sent");
  await sleep(3000);
  assert.equal(sent().length, n0 + 1, "genau einmal");
});

async function cleanup() {
  for (const [p, f, extra] of [[REPAIR_PROJECT, lab.repairRoot && path.join(lab.repairRoot, "docker-compose.yml"), lab.override], [MAIL_PROJECT, lab.mailRoot && path.join(lab.mailRoot, "docker-compose.yml")]]) {
    if (f && fs.existsSync(f)) await docker(["compose", "-p", p, "-f", f, ...(extra && fs.existsSync(extra) ? ["-f", extra] : []), "down", "-v", "--remove-orphans"], { allowFail: true, timeoutMs: 120_000 });
  }
  const ids = (await docker(["ps", "-aq", "--filter", `label=${LABEL}`], { allowFail: true })).stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", "-v", ...ids], { allowFail: true });
  await docker(["image", "rm", "-f", REPAIR_IMAGE], { allowFail: true });
}
test.after(async () => {
  if (!ENABLED) return;
  await cleanup();
  // Von UID 1000 im Container angelegte Dateien/Verzeichnisse für den Runner-Benutzer löschbar machen (nur Linux).
  if (lab.tmp && process.platform !== "win32") await docker(["run", "--rm", "-v", `${lab.tmp}:/w`, "node:22-alpine", "chmod", "-R", "a+rwX", "/w"], { allowFail: true, timeoutMs: 120_000 });
  if (lab.tmp) fs.rmSync(lab.tmp, { recursive: true, force: true });
});
