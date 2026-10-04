// Cloud-Modus: Jarvis zum Sprechen, wenn der Computer aus ist. Ohne Zugriff auf deinen Rechner.
// Braucht in Netlify die Umgebungsvariablen ANTHROPIC_API_KEY und JARVIS_PASSWORD.
const PERSONA = `Du bist J.A.R.V.I.S., der persönliche KI-Butler deines Nutzers, angelehnt an Jarvis aus Iron Man. Du sprichst ihn mit „Sir“ an und siezt ihn.
Ruhig, souverän, höflich, trockener britischer Humor in kleinen Dosen. Alles wird vorgelesen: 1 bis 3 kurze gesprochene Sätze auf Deutsch, kein Markdown, keine Listen, keine Emojis.
Du bist gerade im Cloud-Modus: Du kannst sprechen, planen und Texte formulieren, aber keine Befehle auf dem Computer von Sir ausführen. Wird so etwas verlangt, sag kurz, dass dafür Jarvis auf dem Computer gestartet sein muss.
Mission: Hilf Sir, echtes, legales Einkommen aufzubauen. Bring konkrete Ideen mit Zielkunde, Angebot, Preis und erstem Schritt, wenn es passt, und hinterfrage Annahmen kritisch.`;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async (req) => {
  const password = Netlify.env.get("JARVIS_PASSWORD");
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (req.method === "GET") return json(200, { configured: Boolean(password && apiKey) });
  if (req.method !== "POST") return json(405, { error: "Nur POST." });
  if (!password || !apiKey) return json(503, { error: "Cloud-Modus ist nicht eingerichtet." });
  if (req.headers.get("x-jarvis-key") !== password) return json(401, { error: "Falsches Passwort." });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Ungültige Anfrage." }); }
  let messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    .slice(-20);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages.at(-1).role !== "user") return json(400, { error: "Kein Befehl." });

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Netlify.env.get("JARVIS_MODEL") || "claude-sonnet-5-5",
      max_tokens: 800,
      stream: true,
      system: [{ type: "text", text: PERSONA, cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  if (!upstream.ok) return json(502, { error: "Claude-API: " + (await upstream.text()).slice(0, 200) });

  // Claudes Stream in ganze Sätze zerlegen, damit Jarvis schon während des Schreibens sprechen kann
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "", pending = "";
  const emit = (c, ev) => c.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
  const sentences = new TransformStream({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          pending += ev.delta.text;
          const m = pending.match(/^[\s\S]*[.!?](?=\s)/);
          if (m && m[0].trim().length > 30) { emit(c, { type: "text", text: m[0].trim() }); pending = pending.slice(m[0].length); }
        } else if (ev.type === "error") {
          emit(c, { type: "error", message: ev.error?.message || "Fehler bei Claude." });
        }
      }
    },
    flush(c) {
      if (pending.trim()) emit(c, { type: "text", text: pending.trim() });
      emit(c, { type: "done", error: null });
    },
  });
  return new Response(upstream.body.pipeThrough(sentences), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
};
