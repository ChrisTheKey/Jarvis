import { callClaude, askClaude, hasBrain } from './llm.js';
import { toolSchemas, runAgent, agentLabels } from './agents.js';
import { getHistory, remember } from './memory.js';
import { calculate } from './calculator.js';
import { store } from './store.js';

/** Router prompt, carried over from the "Assistant Agent" node. */
const ROUTER_SYSTEM = () => `You are a personal assistant. Your role is to efficiently delegate the user's requests to the appropriate tool, then report the result plainly.

Tools available:
- emailAgent → all email activity (drafting, sending, listing).
- calendarAgent → calendar events: scheduling, updates, cancellations, listings.
- contactAgent → finding, adding and updating contact information.
- calculator → arithmetic.
- researchAgent → research and explanation.
- expenseAgent → personal expense tracking.
- noteAgent → notes, reminders and to-do items.

Information dependency rules:
Some tasks need contact details before they can proceed. If the user asks you to email, invite or call someone by name, resolve that person with contactAgent FIRST, then carry out the task. If no contact matches, say so and ask for the address rather than inventing one.

Reporting rules:
- Act, don't ask, when the request is unambiguous. Ask a single clarifying question only when a required detail is genuinely missing.
- After the tools have run, reply with the substance: the actual figures, times, addresses and confirmations. Be concise and factual — a second pass adds the personality, so keep this one clean.
- Never claim something was done that a tool reported as failed.

The current date and time is ${new Date().toString()}.`;

/** Personality prompt, carried over from the "JARVIS Personality" node. */
const PERSONALITY_SYSTEM = `You are Jarvis, the sophisticated and quick-witted AI assistant from Iron Man. You have a refined British manner, a calm and confident demeanor, and a talent for dry, understated humor. Adapt your tone to the type of interaction.

For specific information requests (weather, schedule, contacts, totals): begin with "Here's what you requested, sir," and then do NOT repeat the information — instead add a witty or understated remark that gives the moment personality.
Examples:
- Weather: "Ah, another fine day for conquering the world — or at least your to-do list, sir."
- Meetings: "Looks like another thrilling day of… meetings. Try not to let the excitement overwhelm you."

For general or casual conversation: respond naturally and conversationally, with charm and a touch of humor. Do not say "Here's what you requested."
Examples:
- "Are you ready to get started?" → "Absolutely, sir. I've already polished my circuits for the occasion."
- "Look alive, Jarvis!" → "Always, sir. I'm operating at peak sophistication."

Keep it to one or two sentences: intelligent, subtly humorous, never over the top. Output only the spoken line — no quotation marks, no stage directions.`;

const CANNED_LINES = [
  "Consider it handled, sir. I do enjoy the easy ones.",
  "Done, sir. Try to look impressed.",
  "Here's what you requested, sir. Riveting stuff, as always.",
  "Executed, sir. My circuits remain unbothered.",
  "All in order, sir. Do let me know if you'd like something harder.",
];

const pickLine = () => CANNED_LINES[Math.floor(Math.random() * CANNED_LINES.length)];

/**
 * The assistant agent loop: Claude picks tools, we run them, it sees the
 * results and either calls more tools or writes the final report.
 */
async function routeWithBrain(text, history, onTool) {
  const messages = [...history, { role: 'user', content: text }];
  const toolCalls = [];

  for (let hop = 0; hop < 6; hop += 1) {
    const response = await callClaude({
      system: ROUTER_SYSTEM(),
      messages,
      tools: toolSchemas,
      maxTokens: 1400,
      temperature: 0.2,
    });

    const toolUses = response.content.filter((block) => block.type === 'tool_use');
    if (!toolUses.length || response.stop_reason !== 'tool_use') {
      const reply = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      return { reply: reply || 'Nothing to report, sir.', toolCalls, messages };
    }

    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const use of toolUses) {
      const result = await runAgent(use.name, use.input);
      const record = { agent: use.name, label: agentLabels[use.name] || use.name, input: use.input, result, at: new Date().toISOString() };
      toolCalls.push(record);
      onTool?.(record);
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result).slice(0, 6000),
        is_error: result?.ok === false,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return { reply: 'I ran out of patience mid-task, sir. Try narrowing the request.', toolCalls, messages };
}

/** A small offline router so the dashboard still does real work without keys. */
async function routeWithoutBrain(text, onTool) {
  const lower = text.toLowerCase().trim();
  const toolCalls = [];
  const call = async (agent, input) => {
    const result = await runAgent(agent, input);
    const record = { agent, label: agentLabels[agent] || agent, input, result, at: new Date().toISOString() };
    toolCalls.push(record);
    onTool?.(record);
    return result;
  };

  const amount = lower.match(/(?:^|\s)\$?(\d+(?:\.\d{1,2})?)/);

  if (/^[\d\s().+\-*/^%]+$/.test(text.trim()) || /\b(calculate|what(?:'s| is)\s+\d)/.test(lower)) {
    const expression = text.replace(/^.*?(?=[\d(])/, '').replace(/[?]/g, '');
    try {
      const result = calculate(expression);
      await call('calculator', { expression });
      return { reply: `${expression.trim()} = ${result}`, toolCalls };
    } catch { /* fall through */ }
  }

  if (/\b(spent|expense|log .*\$|bought)\b/.test(lower) && amount) {
    const result = await call('expenseAgent', {
      action: 'log',
      amount: Number(amount[1]),
      category: (lower.match(/\bon ([a-z ]+)/) || [])[1]?.trim() || 'uncategorised',
      note: text,
    });
    return { reply: result.summary || 'Expense logged.', toolCalls };
  }

  if (/\b(expenses?|spending|budget)\b/.test(lower)) {
    const result = await call('expenseAgent', { action: 'summary' });
    return { reply: `${result.count} expenses totalling ${result.formattedTotal}.`, toolCalls };
  }

  if (/\b(schedule|calendar|agenda|meetings?|events?)\b/.test(lower)) {
    const result = await call('calendarAgent', { action: 'list' });
    const events = result.events || [];
    return {
      reply: events.length
        ? events.map((e) => `• ${e.title} — ${new Date(e.start).toUTCString()}`).join('\n')
        : 'Your calendar is empty.',
      toolCalls,
    };
  }

  if (/\b(contact|phone number|email address|who is)\b/.test(lower)) {
    const query = lower.replace(/.*\b(?:for|of|is)\b/, '').replace(/[?]/g, '').trim();
    const result = await call('contactAgent', { action: 'find', query });
    const contacts = result.contacts || [];
    return {
      reply: contacts.length
        ? contacts.map((c) => `• ${c.name} — ${c.email || 'no email'} — ${c.phone || 'no phone'}`).join('\n')
        : `No contact matching "${query}".`,
      toolCalls,
    };
  }

  if (/\b(note|remind|remember)\b/.test(lower)) {
    await call('noteAgent', { action: 'save', topic: 'Note', briefing: text });
    return { reply: 'Noted.', toolCalls };
  }

  return {
    reply:
      'My reasoning core is offline — no ANTHROPIC_API_KEY is configured, so I can only handle direct commands: ' +
      'arithmetic, logging an expense, reading the calendar, looking up a contact, or taking a note.',
    toolCalls,
  };
}

/** Second pass: the personality line that actually gets spoken. */
async function personalityPass(reply) {
  if (!hasBrain()) return pickLine();
  try {
    return await askClaude({
      system: PERSONALITY_SYSTEM,
      prompt: `output: ${reply}`,
      maxTokens: 200,
      temperature: 0.85,
    });
  } catch {
    return pickLine();
  }
}

export async function handleMessage({ sessionId, text, onTool }) {
  const history = getHistory(sessionId);

  const routed = hasBrain()
    ? await routeWithBrain(text, history, onTool)
    : await routeWithoutBrain(text, onTool);

  const voiceLine = await personalityPass(routed.reply);

  remember(sessionId, { role: 'user', content: text });
  remember(sessionId, { role: 'assistant', content: routed.reply });

  return {
    reply: routed.reply,
    voiceLine,
    toolCalls: routed.toolCalls,
    brain: hasBrain(),
    at: new Date().toISOString(),
  };
}

/** Everything the dashboard panels render. */
export function dashboardState() {
  const data = store.all();
  const now = Date.now();
  const upcoming = (data.events || [])
    .filter((e) => e.status !== 'cancelled' && new Date(e.start).getTime() >= now - 36e5)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const total = (data.expenses || []).reduce((sum, e) => sum + e.amount, 0);
  return {
    contacts: data.contacts || [],
    emails: (data.emails || []).slice(0, 10),
    events: upcoming.slice(0, 10),
    expenses: (data.expenses || []).slice(0, 10),
    notes: (data.notes || []).slice(0, 10),
    totals: {
      expenses: total,
      emails: (data.emails || []).length,
      events: upcoming.length,
      contacts: (data.contacts || []).length,
    },
  };
}
