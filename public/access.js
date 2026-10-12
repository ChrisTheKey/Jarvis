// Kundenformular für den sicheren Website-Zugang (TF-041). Der Link-Token steht im URL-Fragment (#t=…), wird sofort aus
// der Adresszeile entfernt und nur an /api/access-intake geschickt. Zugangsdaten werden hier verschlüsselt (access-crypto.js);
// der Server bekommt nur Chiffrat und antwortet nie mit Zugangsdaten. Nach dem Senden werden alle Felder geleert.
import { sealForVps } from "./access-crypto.js";

const $ = (id) => document.getElementById(id);
const hash = new URLSearchParams(location.hash.slice(1));
const token = hash.get("t") || "";
try { history.replaceState(null, "", location.pathname); } catch {}

const HINTS = {
  github_netlify: "Empfohlen: laden Sie uns als Collaborator ein und tragen Sie unten nur das Repository bzw. die Site ein – kein Passwort nötig.",
  wordpress_cms: "Bitte einen temporären Benutzer mit nur den nötigen Rechten anlegen – kein Haupt-Administrator-Passwort.",
  sftp: "Bitte einen temporären SFTP-Benutzer nur für das Website-Verzeichnis anlegen.",
  ssh: "Bitte einen temporären SSH-Benutzer mit minimalen Rechten anlegen (kein root).",
  hosting: "Bitte beim Hosting-Anbieter eine eigene Zugriffsberechtigung bzw. einen Mitarbeiterzugang für uns einrichten.",
  other: "Beschreiben Sie kurz den Zugangsweg. Bitte nur temporäre Zugänge mit minimalen Rechten.",
};
const show = (id) => { for (const s of ["loading", "invalid", "done", "form", "hkForm", "hkDone"]) $(s).hidden = s !== id; };
// SFTP/SSH/Hosting: strukturierte Server-Angaben (TF-043) – landen nur im verschlüsselten Payload, nie im Browser-Speicher.
const SERVER_TYPES = new Set(["sftp", "ssh", "hosting"]);
const SERVER_FIELDS = ["port", "root", "hostKey", "passphrase", "provider"];
const normDom = (v) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
const api = async (body) => {
  const r = await fetch("/api/access-intake", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, body: j };
};

let info = null;
async function start() {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return show("invalid");
  const r = await api({ op: "info", token }).catch(() => ({ ok: false, body: {} }));
  if (!r.ok) { if (r.body?.error) $("invalidMsg").textContent = r.body.error; return show("invalid"); }
  info = r.body;
  if (info.purpose === "host_key_confirmation") return startHostKey();
  $("domain").textContent = info.domain;
  $("expires").textContent = new Date(info.expires_at).toLocaleString("de-CH", { dateStyle: "medium", timeStyle: "short" });
  $("dom").value = info.domain;
  $("consentText").textContent = info.consent_text;
  const hint = () => { $("typeHint").textContent = HINTS[$("type").value] || ""; $("serverFields").hidden = !SERVER_TYPES.has($("type").value); };
  $("type").addEventListener("change", hint); hint();
  show("form");
}

$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = (m) => { $("formErr").textContent = m; $("formErr").hidden = false; };
  $("formErr").hidden = true;
  if (!$("consent").checked) return err("Bitte bestätigen Sie die Berechtigung und die Reparaturfreigabe.");
  const dom = normDom($("dom").value);
  if (dom !== info.domain) return err(`Die Domain muss genau ${info.domain} lauten.`);
  const server = SERVER_TYPES.has($("type").value);
  const port = $("port").value.trim(), hostKey = $("hostKey").value.trim();
  if (server && port && !/^\d{1,5}$/.test(port)) return err("Der Port besteht nur aus Ziffern (z. B. 22).");
  if (server && hostKey && !/^(SHA256:)?[A-Za-z0-9+/]{43}=?$/i.test(hostKey)) return err("Der Fingerprint hat die Form SHA256:… (43 Zeichen). Wenn unsicher: leer lassen.");
  $("send").disabled = true;
  try {
    const val = (id) => (server ? $(id).value.trim() || null : null);
    const payload = { access_type: $("type").value, host: $("host").value.trim() || null, username: $("user").value.trim() || null,
      secret: $("secret").value || null, notes: $("notes").value.trim() || null,
      port: val("port"), remote_root: val("root"), ssh_host_key_sha256: val("hostKey"), passphrase: server ? $("passphrase").value || null : null,
      website_stack_hint: server ? $("stack").value : null, provider_name: val("provider") };
    const envelope = await sealForVps(info.public_key, payload);
    const r = await api({ op: "submit", token, access_type: payload.access_type, access_domain: dom, consent: true, envelope });
    if (!r.ok) { $("send").disabled = false; return err(r.body?.error || "Übermittlung fehlgeschlagen. Bitte erneut versuchen."); }
    for (const id of ["host", "user", "secret", "notes", ...SERVER_FIELDS]) $(id).value = ""; // Klartext aus dem Formular entfernen
    show("done");
  } catch { $("send").disabled = false; err("Verschlüsselung oder Übermittlung fehlgeschlagen. Bitte erneut versuchen."); }
});

// Host-Key-Bestätigung (TF-043): Kunde vergleicht den vom Server gemeldeten Fingerprint mit der Angabe seines Hosters.
// Keine Zugangsdaten auf dieser Seite; der Fingerprint ist nicht geheim und wird nur angezeigt.
function startHostKey() {
  $("hkDomain").textContent = info.domain;
  $("hkExpires").textContent = new Date(info.expires_at).toLocaleString("de-CH", { dateStyle: "medium", timeStyle: "short" });
  $("hkFingerprint").textContent = info.host_key_candidate;
  $("hkConfirmText").textContent = info.confirm_text;
  $("hkDom").value = info.domain;
  show("hkForm");
}
async function sendHostKey(decision) {
  const err = (m) => { $("hkErr").textContent = m; $("hkErr").hidden = false; };
  $("hkErr").hidden = true;
  const dom = normDom($("hkDom").value);
  if (dom !== info.domain) return err(`Die Domain muss genau ${info.domain} lauten.`);
  if (decision === "confirm" && !$("hkConsent").checked) return err("Bitte bestätigen Sie, dass Sie den Fingerprint verglichen haben.");
  for (const b of ["hkYes", "hkNo"]) $(b).disabled = true;
  const r = await api({ op: "submit", token, purpose: "host_key_confirmation", access_domain: dom, decision, host_key: info.host_key_candidate, consent: decision === "confirm" })
    .catch(() => ({ ok: false, body: {} }));
  if (!r.ok) { for (const b of ["hkYes", "hkNo"]) $(b).disabled = false; return err(r.body?.error || "Übermittlung fehlgeschlagen. Bitte erneut versuchen."); }
  if (decision === "reject") $("hkDoneMsg").textContent = "Danke für den Hinweis – wir verbinden uns NICHT und melden uns persönlich bei Ihnen. Dieser Link ist jetzt ungültig.";
  show("hkDone");
}
$("hkForm").addEventListener("submit", (ev) => { ev.preventDefault(); sendHostKey("confirm"); });
$("hkNo").addEventListener("click", () => sendHostKey("reject"));

start();
