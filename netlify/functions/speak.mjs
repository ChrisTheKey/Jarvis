/**
 * A deployed site is public, and this endpoint spends real money. Two cheap
 * defences: the request must come from this site, and — if JARVIS_ACCESS_CODE
 * is set — carry that code. Neither is a login; they stop a leaked URL from
 * quietly draining an account.
 */
const jsonError = (message, status = 400) =>
  Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });

function guard(request) {
  const origin = request.headers.get("origin");
  if (origin) {
    let sameSite = false;
    try {
      sameSite = new URL(origin).host === request.headers.get("host");
    } catch { /* an unparseable Origin is not this site */ }
    if (!sameSite) return jsonError("Cross-site requests are not accepted.", 403);
  }
  const expected = process.env.JARVIS_ACCESS_CODE;
  if (expected && request.headers.get("x-jarvis-code") !== expected) {
    return jsonError("Wrong or missing access code.", 401);
  }
  return null;
}

/** ElevenLabs synthesis — the actual JARVIS voice, key held server-side. */
export default async (request) => {
  if (request.method !== 'POST') return jsonError('Use POST.', 405);
  if (!process.env.ELEVENLABS_API_KEY) return jsonError('This deployment has no ELEVENLABS_API_KEY.', 501);

  const denied = guard(request);
  if (denied) return denied;

  let text;
  try {
    ({ text } = await request.json());
  } catch {
    return jsonError('Malformed JSON.', 400);
  }
  if (!text?.trim()) return jsonError('text is required.', 400);

  const voiceId = process.env.ELEVENLABS_VOICE_ID || 'h029Xu7odsKARnf0xDjw';
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'audio/mpeg',
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
    },
    body: JSON.stringify({
      text: text.trim().slice(0, 1200),
      model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return jsonError(`ElevenLabs ${response.status}: ${detail.slice(0, 200)}`, 502);
  }

  return new Response(await response.arrayBuffer(), {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
  });
};
