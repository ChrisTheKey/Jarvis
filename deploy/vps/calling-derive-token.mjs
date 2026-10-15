// TF-065: liest die Mail-.env über stdin und schreibt NUR den abgeleiteten Calling-Schlüssel + URL auf stdout.
// Läuft im Calling-Image ohne Netz (calling-remote.sh). Der Server-Control-Token selbst wird nie ausgegeben; Exit 4 ohne gültigen Token.
// Gleiche Ableitung wie calling-api.js callingAgentToken (HMAC-SHA256(Token, "jarvis-calling-agent-v1")) – Test prüft die Übereinstimmung.
import crypto from "node:crypto";

export const deriveCallingToken = (control) => { const t = String(control || "").trim(); return t.length >= 32 ? crypto.createHmac("sha256", t).update("jarvis-calling-agent-v1").digest("hex") : ""; };

if (process.argv[1] && process.argv[1].endsWith("calling-derive-token.mjs")) {
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const kv = Object.fromEntries(s.split(/\r?\n/).map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]));
    const t = deriveCallingToken(kv.JARVIS_SERVER_CONTROL_TOKEN || "");
    if (t.length !== 64) process.exit(4);
    const origin = String(kv.JARVIS_SYNC_URL || "https://chrisjarvis.netlify.app").replace(/\/api\/state$/, "").replace(/\/+$/, "");
    process.stdout.write(`JARVIS_CALLING_AGENT_TOKEN=${t}\nJARVIS_CALLING_URL=${origin}\n`);
  });
}
