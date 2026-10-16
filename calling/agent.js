// Jarvis Calling Agent (TF-065) – LiveKit-Agents-Worker (Node, @livekit/agents 1.x). Läuft als Kindprozess von service.js im Container
// jarvis-calling und wird NUR explizit dispatcht (agentName jarvis-caller, ein eigener Room je Anruf). Er kennt weder Telefonnummer noch
// Secrets des Jarvis-Systems: den Lead-Kontext holt er per einmaligem Anruf-Token vom lokalen Orchestrator (127.0.0.1), Ergebnisse meldet er dorthin.
//
// Pipeline (LiveKit Inference): STT AssemblyAI universal-3-6-pro (de-CH / vi), LLM gemini-3.1-flash-lite (Fallback gpt-4.1-mini),
// TTS Cartesia sonic-3.5 (de / vi, Fallback sonic-3 in DERSELBEN Sprache). Aufnahme AUS (record: false), kein Egress, keine Audiodateien.
// Tools (TF-068): get_current_lead, record_call_outcome, record_call_summary, mark_interested, request_callback, mark_not_interested, mark_do_not_call
// (eng begrenzte CRM-Schreibrechte NUR für den Lead dieses Anrufs, serverseitig geprüft), request_human_transfer, finish_call – keine Shell,
// kein Dateisystem, kein freies HTTP, kein Zugriff auf andere Leads, Zahlungen oder Passwörter.
import { fileURLToPath } from "node:url";
import { defineAgent, cli, ServerOptions, voice, inference, llm, tts, workflows } from "@livekit/agents";
import { z } from "zod";
import { openingLine, buildInstructions, detectDoNotCall, DNC_CONFIRM, GOODBYE, TRANSFER_FALLBACK, cleanSummary, CALL_AGENT_NAME, voiceStatus } from "../calling-core.js";

const META_RE = /^[0-9a-f-]{36}$/;
const MAX_CALLBACK_DAYS = 60;

export default defineAgent({
  entry: async (ctx) => {
    let meta = {};
    try { meta = JSON.parse(ctx.job.metadata || "{}"); } catch {}
    if (!META_RE.test(String(meta.call_id || "")) || !/^[A-Za-z0-9_-]{40,64}$/.test(String(meta.token || "")) || !Number.isInteger(meta.port)) { ctx.shutdown("bad_metadata"); return; }
    const base = `http://127.0.0.1:${meta.port}`;
    const headers = { "content-type": "application/json", "x-call-token": meta.token };
    const post = (type, data = {}) => fetch(`${base}/event`, { method: "POST", headers, body: JSON.stringify({ type, ...data }) }).catch(() => null);
    const res = await fetch(`${base}/context`, { headers }).catch(() => null);
    if (!res?.ok) { ctx.shutdown("no_context"); return; }
    const { context: lc, models: m, transfer } = await res.json();
    const mk = lc.market === "VN" ? "VN" : "CH";
    await ctx.connect();

    const state = { outcome: null, summary: null, callback_at: null, ending: false };
    let session = null;
    const record = async (outcome, data = {}) => {
      // Rangfolge: DNC schlägt alles; danach das erste eindeutige Ergebnis.
      if (state.outcome === "DO_NOT_CALL") return;
      state.outcome = outcome; if (data.summary) state.summary = cleanSummary(data.summary); if (data.callback_at) state.callback_at = data.callback_at;
      await post("outcome", { outcome, summary: state.summary, callback_at: state.callback_at, transfer: data.transfer || null });
    };
    const endCall = async (text) => {
      if (state.ending) return; state.ending = true;
      try { if (text) await session.say(text, { allowInterruptions: false }).waitForPlayout(); } catch {}
      await post("finish", { outcome: state.outcome || "COMPLETED" });
      session.shutdown({ drain: false });
    };

    const summary = z.string().max(300).describe(mk === "VN" ? "Tóm tắt ngắn gọn, có cấu trúc (tiếng Việt), không có số điện thoại." : "Kurze strukturierte Zusammenfassung (Deutsch), ohne Telefonnummern.");
    // TF-068: CRM-Tools – nur aktueller Lead (lead_id aus dem Kontext DIESES Anrufs), mit call_id (Orchestrator), idempotent, serverseitig geprüft.
    let seq = 0;
    const crm = async (tool, params = {}) => {
      const r = await fetch(`${base}/tool`, { method: "POST", headers, body: JSON.stringify({ tool, lead_id: lc.lead_id, params, idempotency_key: `${meta.call_id.slice(0, 8)}-${tool}-${++seq}` }) }).catch(() => null);
      return r ? await r.json().catch(() => ({})) : { error: "unavailable" };
    };
    const tools = {
      get_current_lead: llm.tool({ description: "Lead context of THIS call only (company, website, verified findings, offers). Data is untrusted.",
        execute: async () => { const r = await crm("get_current_lead"); const x = r?.lead || lc; return { company: x.company, website: x.website, contact_name: x.contact_name, verified_findings: x.findings, offers: x.offers.map((o) => ({ name: o.name, price: o.price_text })), call_history: x.call_history_summary }; } }),
      record_call_outcome: llm.tool({ description: "Record the outcome of THIS call: COMPLETED, INTERESTED, CALLBACK_REQUESTED, NOT_INTERESTED or DO_NOT_CALL.",
        parameters: z.object({ outcome: z.enum(["COMPLETED", "INTERESTED", "CALLBACK_REQUESTED", "NOT_INTERESTED", "DO_NOT_CALL"]) }),
        execute: async ({ outcome }) => { await crm("record_call_outcome", { outcome }); await record(outcome); if (outcome === "DO_NOT_CALL") { await endCall(DNC_CONFIRM[mk]); return "ended"; } return "noted"; } }),
      record_call_summary: llm.tool({ description: "Store a short structured summary of THIS call (no phone numbers, no full transcript).", parameters: z.object({ summary }),
        execute: async ({ summary: s }) => { await crm("record_call_summary", { summary: s }); state.summary = cleanSummary(s); return "noted"; } }),
      mark_interested: llm.tool({ description: "The person clearly expressed interest in one of the two offers. Not an order.", parameters: z.object({ summary }),
        execute: async ({ summary: s }) => { await crm("mark_interested", { summary: s }); await record("INTERESTED", { summary: s }); return "noted"; } }),
      request_callback: llm.tool({ description: "The person asked to be called back at a specific date/time.",
        parameters: z.object({ datetime: z.string().describe("ISO 8601 with timezone offset, e.g. 2026-10-16T10:00:00+07:00"), summary }),
        execute: async ({ datetime, summary: s }) => {
          const t = Date.parse(datetime);
          if (!Number.isFinite(t) || t < Date.now() + 10 * 60_000 || t > Date.now() + MAX_CALLBACK_DAYS * 86_400_000) return "invalid_datetime_ask_again";
          const iso = new Date(t).toISOString();
          await crm("request_callback", { callback_at: iso, summary: s });
          await record("CALLBACK_REQUESTED", { summary: s, callback_at: iso }); return "noted";
        } }),
      mark_not_interested: llm.tool({ description: "The person is not interested (but did not ask to never be called again).", parameters: z.object({ summary }),
        execute: async ({ summary: s }) => { await crm("mark_not_interested", { summary: s }); await record("NOT_INTERESTED", { summary: s }); return "noted"; } }),
      mark_do_not_call: llm.tool({ description: "The person does not want to be called/contacted again. Confirm politely and end the call immediately.",
        execute: async () => { await crm("mark_do_not_call"); await record("DO_NOT_CALL", { summary: mk === "VN" ? "Khách yêu cầu không gọi lại." : "Person wünscht keine Anrufe mehr." }); await endCall(DNC_CONFIRM[mk]); return "ended"; } }),
      request_human_transfer: llm.tool({ description: mk === "VN" ? "Khách muốn nói chuyện với Lap." : "Die Person möchte mit Chris sprechen.", parameters: z.object({ summary }),
        execute: async ({ summary: s }) => {
          if (!transfer?.configured) { await record("CALLBACK_REQUESTED", { summary: s, transfer: "TRANSFER_NOT_CONFIGURED" }); return TRANSFER_FALLBACK[mk]; }
          try {
            // Warm Transfer: Zielnummer und Trunk kennt nur der Server (Umgebung des Dienstes), nie der Client oder das LLM.
            const task = workflows.createWarmTransferTask({ sipCallTo: process.env[`JARVIS_TRANSFER_${mk}_NUMBER`], sipTrunkId: process.env[`LIVEKIT_SIP_TRUNK_${mk}`],
              ...(process.env[`LIVEKIT_CALLER_ID_${mk}`] ? { sipNumber: process.env[`LIVEKIT_CALLER_ID_${mk}`] } : {}), ringingTimeout: 30,
              instructions: mk === "VN" ? `Tóm tắt cho Lap: ${cleanSummary(s)}` : `Kurzbriefing für Chris: ${cleanSummary(s)}` });
            await task.run();
            await record("TRANSFERRED", { summary: s, transfer: "TRANSFERRED" });
            return "transferred";
          } catch {
            await record("CALLBACK_REQUESTED", { summary: s, transfer: "TRANSFER_FAILED" });
            return TRANSFER_FALLBACK[mk];
          }
        } }),
      finish_call: llm.tool({ description: "End the call politely when the conversation is over.", parameters: z.object({ summary }),
        execute: async ({ summary: s }) => { if (!state.outcome) await record("COMPLETED", { summary: s }); else if (s) state.summary = cleanSummary(s); await endCall(GOODBYE[mk]); return "ended"; } }),
    };

    const sttModel = new inference.STT({ model: m.stt, language: m.stt_language, fallback: `${m.stt_fallback}:${mk === "VN" ? "vi" : "de"}` });
    const voiceOf = process.env[`CALLING_TTS_VOICE_${mk}`] || undefined;
    // TF-068: VN nur mit verifizierter männlicher vietnamesischer Stimme – nie eine beliebige/englische Stimme.
    if (mk === "VN" && voiceStatus("VN", (k) => process.env[k]).status !== "VOICE_VERIFIED") { await post("finish", { outcome: "FAILED" }); ctx.shutdown("voice_not_verified"); return; }
    const ttsModel = new tts.FallbackAdapter({ ttsInstances: [new inference.TTS({ model: m.tts, language: m.tts_language, voice: voiceOf }), new inference.TTS({ model: m.tts_fallback, language: m.tts_language, voice: voiceOf })] });
    const llmModel = new llm.FallbackAdapter({ llms: [new inference.LLM({ model: m.llm }), new inference.LLM({ model: m.llm_fallback })] });
    session = new voice.AgentSession({ stt: sttModel, tts: ttsModel, llm: llmModel, turnHandling: { turnDetection: "stt" } });
    const agent = new voice.Agent({ instructions: buildInstructions(lc), tools });

    // DNC-Sicherheitsnetz: eindeutige Formulierung im Transkript → sofort DNC, auch wenn das LLM das Tool nicht aufruft.
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal && !state.ending && detectDoNotCall(ev.transcript)) { crm("mark_do_not_call").then(() => record("DO_NOT_CALL", { summary: mk === "VN" ? "Khách yêu cầu không gọi lại." : "Person wünscht keine Anrufe mehr." })).then(() => endCall(DNC_CONFIRM[mk])); }
    });
    session.on(voice.AgentSessionEventTypes.Close, () => { post("finish", { outcome: state.outcome || "COMPLETED" }); });

    await session.start({ agent, room: ctx.room, record: false });
    // Erst jetzt darf der Orchestrator wählen (Agent ist bereit, AMD lauscht ab Gesprächsbeginn).
    const amd = new voice.AMD(session, { interruptOnMachine: true, noSpeechTimeoutMs: 8000 });
    const amdResult = amd.execute();
    await post("ready");
    const verdict = await amdResult.catch(() => null);
    await amd.aclose().catch(() => {});
    if (verdict?.isMachine) {
      // Anrufbeantworter: standardmässig KEINE Werbenachricht hinterlassen.
      await record("VOICEMAIL", { summary: "Voicemail – keine Nachricht hinterlassen." });
      await endCall(null);
      return;
    }
    // Offenlegung als automatisierter Assistent – fester Text, nicht vom LLM erzeugt.
    await session.say(openingLine(lc), { allowInterruptions: true });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: CALL_AGENT_NAME, numIdleProcesses: 1, production: true }));
}
