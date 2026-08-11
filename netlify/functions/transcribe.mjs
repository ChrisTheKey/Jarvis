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

/**
 * Whisper transcription, for browsers with no speech recognition of their own —
 * Safari and Firefox, which is most iPhones.
 */
export default async (request) => {
  if (request.method !== 'POST') return jsonError('Use POST.', 405);
  if (!process.env.OPENAI_API_KEY) return jsonError('This deployment has no OPENAI_API_KEY.', 501);

  const denied = guard(request);
  if (denied) return denied;

  const incoming = await request.formData().catch(() => null);
  const audio = incoming?.get('audio');
  if (!audio || typeof audio === 'string') return jsonError('An audio file is required.', 400);
  if (audio.size > 20 * 1024 * 1024) return jsonError('Recording too large.', 413);

  const form = new FormData();
  form.append('file', audio, 'speech.webm');
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
  const language = incoming.get('language');
  if (typeof language === 'string' && language) form.append('language', language.slice(0, 5));

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return jsonError(`Whisper ${response.status}: ${detail.slice(0, 200)}`, 502);
  }

  const json = await response.json();
  return Response.json({ text: json.text?.trim() || '' }, { headers: { 'cache-control': 'no-store' } });
};
