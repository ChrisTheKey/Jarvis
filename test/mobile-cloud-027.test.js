// MOBILE + CLOUD PARITY (027): chrisjarvis.netlify.app muss vom Handy aus vollwertig nutzbar sein, auch wenn der PC aus ist.
// Nur Dateiprüfungen und reine Logik – kein Browser, keine Cloud, keine echte Mail.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const html = read("public/index.html");
const mobile = html.slice(html.indexOf("@media (max-width: 860px) {"), html.indexOf("</style>"));

test("Handy-Layout: eine Spalte, Panels sichtbar und scrollbar, Composer unten festgepinnt, kein horizontaler Overflow", () => {
  assert.ok(mobile.length > 500, "Mobile-Block vorhanden");
  assert.doesNotMatch(html, /\.left, \.right \{ display: none; \}/, "Status/Mail/Meldungen/Server werden auf dem Handy nicht mehr versteckt");
  assert.match(mobile, /\.hud \{ display: flex; flex-direction: column;[^}]*overflow-y: auto; overflow-x: hidden;/, "eine scrollbare Spalte, kein horizontaler Overflow");
  assert.match(mobile, /\.hud \{[^}]*pointer-events: auto;/, "HUD-Fläche ist auf dem Handy bedienbar (Scrollen)");
  assert.match(mobile, /\.bottom \{ order: 4; margin-top: auto; position: sticky; bottom: 0;/, "Composer bleibt unten erreichbar");
  assert.match(mobile, /form\.cmd textarea \{ font-size: 16px;/, "16 px: iOS zoomt nicht in das Feld");
  assert.match(mobile, /\.mic \{ width: 48px; height: 48px; \}/, "grosse Touch-Fläche Mikrofon");
  assert.match(mobile, /\.alerts button, \.srv-ctl button, \.panel h2 button, \.leads-box button, \.mail h2 a, \.lead-detail \.acts2 a \{ min-height: 40px;/, "grosse Touch-Flächen für Aktionen");
  assert.match(mobile, /\.panel\.collapsed > :not\(h2\) \{ display: none; \}/, "Panels per Tipp auf den Titel auf-/zuklappbar");
  assert.match(html, /const MOBILE = matchMedia\("\(max-width: 860px\)"\);/);
  assert.match(html, /if \(!MOBILE\.matches \|\| e\.target\.closest\("button, a"\)\) return;/, "Desktop: Klick auf den Titel klappt nichts zu; Buttons im Titel bleiben Buttons");
  // Kein Hover-Zwang: jede Hover-Regel hat eine gleichwertige Nicht-Hover-Bedienung (Klick/Fokus) – geprüft: nur dekorative Hover.
  for (const m of html.matchAll(/([^{}\n]+):hover[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(m[2], /display|visibility|pointer-events/, `Hover nur dekorativ: ${m[1].trim()}`);
});

test("Handy-HUD: Quick-Status mit JARVIS / VPS CORE / MAIL WORKER / AUTHORITY / WINDOWS CLIENT / QUEUE / AI SERVICE / SERVER CONTROL", () => {
  for (const id of ["qJarvis", "qCore", "qMail", "qAuth", "qWin", "qQueue", "qAi", "qSrv"]) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<section class="panel quick" id="quick"/);
  assert.match(mobile, /\.quick \{ display: block; order: 1; \}/, "Quick-Status direkt unter der Kopfzeile");
  assert.match(html, /\.quick \{ display: none; \}/, "Desktop unverändert: dort zeigt das STATUS-Panel alles");
  // Quellen: Cloud (mail-status.js + server-status.js), nie der Local Core.
  assert.match(html, /function renderQuick\(\) \{\s*\n\s*const m = mailHud, s = srvHud;/);
  assert.match(html, /set\("qJarvis", mode === "local" \? "LOCAL ONLINE" : mode === "cloud" \? "CLOUD ONLINE" : "OFFLINE"/);
  assert.match(html, /set\("qWin", mode === "local" \? "ONLINE" : m\?\.windows \|\| "OFFLINE"/, "Windows Client: OFFLINE oder STANDBY, nie Systemfehler");
  assert.match(html, /renderQuick\(\);\s*\n\s*const m = mailHud, tone/, "nach jedem Mail-Status-Update");
  assert.match(html, /srvHud = note \? \{ server: note, online: false \} : m;\s*\n\s*renderQuick\(\);/, "nach jedem Server-Status-Update");
});

test("Mail-Panel: Entwurf in Gmail / gesendet / blockiert sichtbar, Gmail-Entwürfe-Link, Quelle ist die Cloud-Warteschlange", () => {
  assert.match(html, /<section class="panel mail" id="mailPanel"/);
  assert.match(html, /href="https:\/\/mail\.google\.com\/mail\/u\/0\/#drafts" target="_blank" rel="noopener"/, "Entwurf danach in Gmail finden");
  assert.match(html, /function renderMailList\(requests\)/);
  assert.match(html, /\(q\.delivery === "draft" \? "ENTWURF · " : "MAIL · "\) \+ \(MAIL_STATUS\[q\.status\] \|\| q\.status\)\.toUpperCase\(\)/);
  assert.match(html, /drafted: "Entwurf in Gmail"/);
  assert.match(html, /async function loadMailRequests\(\{ serviceToo = true \} = \{\}\) \{\s*\n\s*if \(!HOSTED \|\| !cloudKey\) return;/, "ohne Cloud-Passwort keine Abfrage");
  assert.match(html, /if \(mode === "local" && HOSTED && cloudKey\) loadMailRequests\(\{ serviceToo: false \}\);/, "auch im LOCAL-Modus aus der Cloud (Service-Zeilen bleiben vom Local Core)");
  assert.match(html, /if \(ev\.ok\) \{ mailSeen\[ev\.request\.request_id\] = ev\.request\.status; loadMailRequests\(\); \}/, "nach einem Cloud-Mailauftrag sofort nachladen");
  // Es gibt weiterhin keinen Browser-Weg, einen Entwurf zu senden oder Cold-Mails zu erzwingen.
  assert.doesNotMatch(html, /sendDraft|send[ _-]?anyway|force[ _-]?send|cold-drafts\/(send|force|approve|bulk|batch|all)/i);
});

test("Cloud-Modus ist vollwertig: kein Desktop-/Terminal-Wording, kein „ohne PC-Zugriff“ als Fehler", () => {
  assert.doesNotMatch(html, /OHNE PC-ZUGRIFF|NUR GESPRÄCH|PC erneut suchen/);
  assert.match(html, /"CLOUD \(VPS – PC OPTIONAL\)"/);
  assert.match(html, /mode === "cloud" \? "Keine Verbindung zur Cloud\. Bitte Internetverbindung prüfen und erneut senden\." : "Keine Verbindung zum Jarvis-Server\. Läuft das Terminal-Fenster noch\?"/, "Terminal-Hinweis nur im LOCAL-Modus");
  assert.match(html, /HOSTED \? "Weder die Cloud noch der Local Core sind erreichbar\." : "Der Jarvis-Kern auf dem Computer ist nicht erreichbar\."/);
  assert.match(html, /Cloud-Modus: Jarvis läuft auf dem VPS – Chat, Gmail-Entwürfe, Status und Server Control funktionieren ohne PC\./);
  // Modus-Erkennung unverändert: LOCAL nur wenn der Local Core antwortet, sonst CLOUD (nie OFFLINE, solange /api/cloud konfiguriert ist).
  assert.match(html, /createModeDetector\(\{ probeLocal, probeCloud, onChange: applyMode, isBusy: \(\) => busy, intervalMs: 20_000 \}\)/);
  const cloud = read("netlify/edge-functions/cloud.js");
  assert.match(cloud, /Du bist gerade im Cloud-Modus und läufst auf dem Jarvis-Server \(VPS, rund um die Uhr\) – das ist der normale Betrieb/);
  assert.match(cloud, /„Schreib eine Mail“ ohne ausdrücklichen Sendebefehl heisst immer delivery "draft"/, "Handy: „Schreibe eine Mail …“ = Gmail-Entwurf");
  assert.match(cloud, /du selbst führst keine Server-Befehle aus/);
});

test("Sicherheitsmodell unverändert: keine Shell, kein Dateizugriff, keine Secrets im HUD; Cold Leads bleiben DRAFT_ONLY", () => {
  for (const f of ["public/index.html", "public/mail-status.js", "public/server-status.js", "netlify/edge-functions/cloud.js"]) {
    const src = read(f);
    // (cloud.js prüft nur den NAMEN JARVIS_MAIL_WORKER_TOKEN für dedicated=true – nie den Wert; Worker-/Sync-/Control-Header kennt der Browser nicht.)
    assert.doesNotMatch(src, /shell\.exec|docker\.exec|child_process|readFile\(|JARVIS_SERVER_CONTROL_TOKEN|x-jarvis-control|x-jarvis-worker|x-jarvis-sync/, f);
  }
  // Server-Panel: nur feste Action-IDs, keine freien Befehle; gefährliche Aktionen bleiben serverseitig 403.
  const actions = [...html.matchAll(/<button[^>]*data-action="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(actions, ["jarvis.runHealthCheck", "jarvis.runBackup", "jarvis.restartMailWorker", "jarvis.restartCore", "discovery.pause", "discovery.resume"]);
  assert.doesNotMatch(html, /name="command"|id="shell"|data-command/);
  const sc = read("server-control.js");
  assert.match(sc, /shell\.exec/, "shell.exec ist als DANGEROUS gelistet (immer 403)");
  // Cold-Lead-Entwürfe: nur Entwurf, nie Versand – auch aus der Cloud-Warteschlange (delivery draft = COLD_LEAD_DRAFT_ONLY).
  assert.match(read("mail-worker.js"), /if \(rq\.delivery === "draft"\) \{[\s\S]*mode: COLD_MODE/);
  assert.match(read("mail-requests.js"), /delivery: delivery === "send" \? "send" : "draft"|const delivery = input\.delivery === "draft" \? "draft" : "send";/);
  assert.match(read("netlify/edge-functions/cloud.js"), /delivery: delivery === "send" \? "send" : "draft"/, "Cloud: fehlt delivery → Entwurf, nie stiller Versand");
});

test("Dokumentation: Capability Matrix und Mobile-Runbook vorhanden und vollständig", () => {
  const matrix = read("docs/JARVIS_CAPABILITY_MATRIX.md");
  assert.match(matrix, /\| Funktion \| Local \| Cloud \| Mobile \| Backend \| Status \|/);
  for (const row of ["Chat/Conversation", "Gmail Draft erstellen", "Gmail Reply Draft", "Cold Lead Draft", "Leads anzeigen", "Suppression", "Opt-out", "Mail Queue", "Notifications", "Human Escalation", "Scheduler", "VPS Status", "Server Control", "Backup Status", "AI Service Status", "Health Checks", "Cloud Sync", "Local Client Status"]) assert.match(matrix, new RegExp(`\\| ${row.replace(/[/()]/g, "\\$&")}`), row);
  for (const local of ["Lokale Dateien", "Mikrofon", "Claude Code", "SSH/Admin"]) assert.match(matrix, new RegExp(local), local);
  assert.match(matrix, /LOCAL_ONLY/); assert.match(matrix, /SAFE_CLOUD_EQUIVALENT/);
  assert.match(matrix, /COLD_LEAD_DRAFT_ONLY/);
  const runbook = read("docs/MOBILE_CLOUD_RUNBOOK.md");
  for (const h of ["URL", "Login", "Handy-Nutzung", "Gmail-Draft-Workflow", "Was ohne PC funktioniert", "Was optional lokal bleibt", "Sicherheitsmodell", "Cold-Draft-Regeln", "Recovery"]) assert.match(runbook, new RegExp(`^## .*${h}`, "m"), h);
  assert.match(runbook, /https:\/\/chrisjarvis\.netlify\.app\//);
  assert.doesNotMatch(matrix + runbook, /sk-ant-|ya29\.|BEGIN [A-Z ]*PRIVATE KEY|JARVIS_PASSWORD\s*=\s*\S/, "keine Secrets in den Docs");
});
