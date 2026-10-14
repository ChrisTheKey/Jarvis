// TF-053: liest die Mail-.env über stdin und schreibt NUR die CRM-.env (abgeleiteter Agent-Schlüssel + URL) auf stdout.
// Läuft im CRM-Image ohne Netz (crm-remote.sh). Der Server-Control-Token selbst wird nie ausgegeben; Exit 4 ohne gültigen Token.
import { crmAgentToken } from "../../crm-api.js";

let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const kv = Object.fromEntries(s.split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
  const t = crmAgentToken(kv.JARVIS_SERVER_CONTROL_TOKEN || "");
  if (t.length !== 64) process.exit(4);
  const origin = String(kv.JARVIS_SYNC_URL || "https://chrisjarvis.netlify.app").replace(/\/api\/state$/, "").replace(/\/+$/, "");
  process.stdout.write(`JARVIS_CRM_AGENT_TOKEN=${t}\nJARVIS_CRM_URL=${origin}\n`);
});
