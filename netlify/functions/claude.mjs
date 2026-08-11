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

const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

/**
 * Proxies the Messages API so the key stays on the server. The model, token
 * ceiling and payload size are fixed here rather than taken from the request —
 * the page is public, so the client does not get to choose how much this costs.
 */
export default async (request) => {
  if (request.method !== 'POST') return jsonError('Use POST.', 405);
  if (!process.env.ANTHROPIC_API_KEY) return jsonError('This deployment has no ANTHROPIC_API_KEY.', 501);

  const denied = guard(request);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Malformed JSON.', 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return jsonError('messages is required.', 400);
  if (JSON.stringify(messages).length > 200_000) return jsonError('Conversation too large.', 413);

  const response = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
      max_tokens: Math.min(Number(body.max_tokens) || 1024, 2048),
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.5,
      ...(body.system ? { system: String(body.system).slice(0, 20_000) } : {}),
      ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
      messages,
    }),
  });

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
