import { store } from './store.js';
import { calculate } from './calculator.js';
import { askClaude, hasBrain } from './llm.js';

/**
 * The "Agent Army" from the JARVIS 2.0 workflow, re-implemented as local tools.
 * Each agent owns one collection in the datastore and returns a plain object;
 * the object is fed back to the assistant agent as a tool result.
 */

const money = (n) => `$${Number(n).toFixed(2)}`;

export const agents = [
  {
    name: 'emailAgent',
    label: 'Email',
    description:
      'Handles all email-related tasks: drafting, queueing a message for sending, listing the outbox, and reading back a draft. Recipient may be given as a name — resolve it with contactAgent first if you only have a name.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['draft', 'send', 'list', 'delete'] },
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string' },
        body: { type: 'string' },
        id: { type: 'string', description: 'Id of an existing message, for send/delete.' },
        query: { type: 'string', description: 'Filter for list.' },
      },
      required: ['action'],
    },
    run({ action, to, subject, body, id, query }) {
      switch (action) {
        case 'draft': {
          const row = store.insert('emails', { to, subject, body, status: 'draft' });
          return { ok: true, summary: `Draft to ${to || 'unknown recipient'} saved.`, email: row };
        }
        case 'send': {
          const row = id
            ? store.update('emails', id, { status: 'queued', queuedAt: new Date().toISOString() })
            : store.insert('emails', { to, subject, body, status: 'queued', queuedAt: new Date().toISOString() });
          if (!row) return { ok: false, error: `No email with id ${id}.` };
          return {
            ok: true,
            summary: `Message to ${row.to} queued in the outbox.`,
            note: 'No SMTP provider is connected, so the message sits in the local outbox rather than leaving the building.',
            email: row,
          };
        }
        case 'list':
          return { ok: true, emails: store.search('emails', query).slice(0, 20) };
        case 'delete': {
          const row = store.remove('emails', id);
          return row ? { ok: true, summary: 'Message deleted.' } : { ok: false, error: `No email with id ${id}.` };
        }
        default:
          return { ok: false, error: `Unknown action ${action}.` };
      }
    },
  },

  {
    name: 'calendarAgent',
    label: 'Calendar',
    description:
      'Manages calendar events: create, list (optionally filtered), reschedule and cancel. Always pass absolute ISO 8601 datetimes — resolve relative dates like "tomorrow" yourself using the current date given to you.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'cancel'] },
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601 start datetime.' },
        end: { type: 'string', description: 'ISO 8601 end datetime.' },
        attendees: { type: 'array', items: { type: 'string' } },
        location: { type: 'string' },
        notes: { type: 'string' },
        id: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['action'],
    },
    run({ action, title, start, end, attendees, location, notes, id, query }) {
      switch (action) {
        case 'create': {
          if (!title || !start) return { ok: false, error: 'A title and an ISO start datetime are required.' };
          const row = store.insert('events', { title, start, end: end || null, attendees: attendees || [], location: location || '', notes: notes || '', status: 'confirmed' });
          return { ok: true, summary: `"${title}" scheduled for ${new Date(start).toUTCString()}.`, event: row };
        }
        case 'list': {
          const events = store.search('events', query)
            .filter((e) => e.status !== 'cancelled')
            .sort((a, b) => new Date(a.start) - new Date(b.start));
          return { ok: true, events: events.slice(0, 20) };
        }
        case 'update': {
          const patch = Object.fromEntries(Object.entries({ title, start, end, attendees, location, notes }).filter(([, v]) => v !== undefined));
          const row = store.update('events', id, patch);
          return row ? { ok: true, summary: `"${row.title}" updated.`, event: row } : { ok: false, error: `No event with id ${id}.` };
        }
        case 'cancel': {
          const row = store.update('events', id, { status: 'cancelled' });
          return row ? { ok: true, summary: `"${row.title}" cancelled.` } : { ok: false, error: `No event with id ${id}.` };
        }
        default:
          return { ok: false, error: `Unknown action ${action}.` };
      }
    },
  },

  {
    name: 'contactAgent',
    label: 'Contacts',
    description:
      'Finds, adds and updates contact records. Call this FIRST whenever a task refers to a person by name and you need their email address or phone number.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['find', 'add', 'update', 'delete'] },
        query: { type: 'string', description: 'Name, email or role fragment to search for.' },
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        role: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
    run({ action, query, name, email, phone, role, id }) {
      switch (action) {
        case 'find': {
          const matches = store.search('contacts', query);
          return matches.length
            ? { ok: true, contacts: matches.slice(0, 20) }
            : { ok: false, error: `No contact matching "${query}". Ask the user for the address, or add the contact.` };
        }
        case 'add': {
          if (!name) return { ok: false, error: 'A name is required.' };
          const row = store.insert('contacts', { name, email: email || '', phone: phone || '', role: role || '' });
          return { ok: true, summary: `${name} added to contacts.`, contact: row };
        }
        case 'update': {
          const patch = Object.fromEntries(Object.entries({ name, email, phone, role }).filter(([, v]) => v !== undefined));
          const row = store.update('contacts', id, patch);
          return row ? { ok: true, summary: `${row.name} updated.`, contact: row } : { ok: false, error: `No contact with id ${id}.` };
        }
        case 'delete': {
          const row = store.remove('contacts', id);
          return row ? { ok: true, summary: `${row.name} removed.` } : { ok: false, error: `No contact with id ${id}.` };
        }
        default:
          return { ok: false, error: `Unknown action ${action}.` };
      }
    },
  },

  {
    name: 'expenseAgent',
    label: 'Expenses',
    description:
      'Tracks personal expenses: log a spend, list recent ones, and summarise totals by category. Amounts are plain numbers in the account currency.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['log', 'list', 'summary', 'delete'] },
        amount: { type: 'number' },
        category: { type: 'string' },
        merchant: { type: 'string' },
        note: { type: 'string' },
        date: { type: 'string', description: 'ISO 8601 date; defaults to today.' },
        query: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
    run({ action, amount, category, merchant, note, date, query, id }) {
      switch (action) {
        case 'log': {
          if (typeof amount !== 'number') return { ok: false, error: 'A numeric amount is required.' };
          const row = store.insert('expenses', {
            amount,
            category: category || 'uncategorised',
            merchant: merchant || '',
            note: note || '',
            date: date || new Date().toISOString().slice(0, 10),
          });
          return { ok: true, summary: `${money(amount)} logged under ${row.category}.`, expense: row };
        }
        case 'list':
          return { ok: true, expenses: store.search('expenses', query).slice(0, 25) };
        case 'summary': {
          const rows = store.search('expenses', query);
          const byCategory = {};
          for (const row of rows) byCategory[row.category] = (byCategory[row.category] || 0) + row.amount;
          const total = rows.reduce((sum, row) => sum + row.amount, 0);
          return { ok: true, total, formattedTotal: money(total), count: rows.length, byCategory };
        }
        case 'delete': {
          const row = store.remove('expenses', id);
          return row ? { ok: true, summary: 'Expense removed.' } : { ok: false, error: `No expense with id ${id}.` };
        }
        default:
          return { ok: false, error: `Unknown action ${action}.` };
      }
    },
  },

  {
    name: 'researchAgent',
    label: 'Research',
    description:
      'Researches a topic and returns a written briefing, then files it under notes so it can be recalled later. Use for questions that need explanation, comparison or background rather than a record lookup.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The question or subject to research.' },
        depth: { type: 'string', enum: ['brief', 'detailed'], description: 'Defaults to brief.' },
      },
      required: ['topic'],
    },
    async run({ topic, depth = 'brief' }) {
      if (!hasBrain()) {
        return { ok: false, error: 'Research requires ANTHROPIC_API_KEY to be configured.' };
      }
      const briefing = await askClaude({
        system:
          'You are a research analyst. Produce a factual, well-organised briefing. ' +
          'Lead with the answer, then supporting detail as short bullets. ' +
          'You have no live web access, so flag anything that may have changed recently and state what you are unsure about.',
        prompt: `Topic: ${topic}\nDepth: ${depth === 'detailed' ? '6-10 bullets' : '3-5 bullets'}`,
        maxTokens: depth === 'detailed' ? 1200 : 600,
        temperature: 0.3,
      });
      const row = store.insert('notes', { topic, briefing, source: 'researchAgent' });
      return { ok: true, topic, briefing, noteId: row.id, note: 'Compiled from model knowledge — no live web access is wired up.' };
    },
  },

  {
    name: 'calculator',
    label: 'Calculator',
    description: 'Evaluates an arithmetic expression. Supports + - * / % ^, parentheses, and sqrt/abs/round/floor/ceil/log/sin/cos/tan.',
    input_schema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'e.g. "(1250 * 0.0825) + 40"' } },
      required: ['expression'],
    },
    run({ expression }) {
      try {
        return { ok: true, expression, result: calculate(expression) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  },

  {
    name: 'noteAgent',
    label: 'Notes',
    description: 'Saves and recalls free-form notes, reminders and to-do items for the user.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete'] },
        topic: { type: 'string' },
        briefing: { type: 'string', description: 'The note body.' },
        query: { type: 'string' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
    run({ action, topic, briefing, query, id }) {
      switch (action) {
        case 'save': {
          const row = store.insert('notes', { topic: topic || 'Note', briefing: briefing || '', source: 'user' });
          return { ok: true, summary: 'Noted.', note: row };
        }
        case 'list':
          return { ok: true, notes: store.search('notes', query).slice(0, 20) };
        case 'delete': {
          const row = store.remove('notes', id);
          return row ? { ok: true, summary: 'Note deleted.' } : { ok: false, error: `No note with id ${id}.` };
        }
        default:
          return { ok: false, error: `Unknown action ${action}.` };
      }
    },
  },
];

export const toolSchemas = agents.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

export const agentLabels = Object.fromEntries(agents.map((a) => [a.name, a.label]));

export async function runAgent(name, input) {
  const agent = agents.find((a) => a.name === name);
  if (!agent) return { ok: false, error: `Unknown agent ${name}.` };
  try {
    return await agent.run(input || {});
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
