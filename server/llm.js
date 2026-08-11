import { config } from './config.js';

export class LlmUnavailableError extends Error {
  constructor() {
    super('No ANTHROPIC_API_KEY configured — JARVIS is running without his brain.');
    this.name = 'LlmUnavailableError';
  }
}

export const hasBrain = () => Boolean(config.anthropic.apiKey);

/**
 * Thin wrapper over the Anthropic Messages API.
 * Returns the raw response so callers can inspect `content` blocks (tool_use).
 */
export async function callClaude({ system, messages, tools, maxTokens = 1024, temperature = 0.7 }) {
  if (!hasBrain()) throw new LlmUnavailableError();

  const body = {
    model: config.anthropic.model,
    max_tokens: maxTokens,
    temperature,
    messages,
  };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools;

  const response = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': config.anthropic.version,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${detail.slice(0, 500)}`);
  }
  return response.json();
}

/** Convenience helper for single-shot text completions. */
export async function askClaude({ system, prompt, maxTokens = 700, temperature = 0.7 }) {
  const result = await callClaude({
    system,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature,
  });
  return result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
