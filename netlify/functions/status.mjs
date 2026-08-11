/**
 * Tells the page which server-side capabilities this deployment has, so it can
 * decide between the server brain and its local one without the visitor having
 * to configure anything.
 */
export default async () => Response.json({
  chat: Boolean(process.env.ANTHROPIC_API_KEY),
  voice: Boolean(process.env.ELEVENLABS_API_KEY),
  transcribe: Boolean(process.env.OPENAI_API_KEY),
  requiresCode: Boolean(process.env.JARVIS_ACCESS_CODE),
  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
}, { headers: { 'cache-control': 'no-store' } });
