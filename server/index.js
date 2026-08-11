import express from 'express';
import multer from 'multer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, capabilities } from './config.js';
import { handleMessage, dashboardState } from './jarvis.js';
import { transcribe, speak } from './voice.js';
import { forget, sessionCount } from './memory.js';
import { store } from './store.js';
import { agents } from './agents.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(root, 'public')));

const fail = (res, error) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error.message || 'Something went wrong.' });
};

app.get('/api/status', (_req, res) => {
  res.json({
    ...capabilities(),
    sessions: sessionCount(),
    agents: agents.map(({ name, label, description }) => ({ name, label, description })),
  });
});

/** The main turn: text in → factual reply + spoken personality line + tool trace. */
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'A message is required.' });
  try {
    const result = await handleMessage({ sessionId: sessionId || 'default', text: message.trim() });
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'An audio file is required.' });
  try {
    const text = await transcribe(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({ text });
  } catch (error) {
    fail(res, error);
  }
});

app.post('/api/speak', async (req, res) => {
  const { text } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Text is required.' });
  try {
    const audio = await speak(text.trim().slice(0, 2000));
    res.set('content-type', 'audio/mpeg').send(audio);
  } catch (error) {
    fail(res, error);
  }
});

app.get('/api/dashboard', (_req, res) => res.json(dashboardState()));

/** Direct panel edits — deleting a draft, removing an expense, and so on. */
app.delete('/api/records/:collection/:id', (req, res) => {
  const { collection, id } = req.params;
  if (!['emails', 'events', 'expenses', 'contacts', 'notes'].includes(collection)) {
    return res.status(400).json({ error: 'Unknown collection.' });
  }
  const row = store.remove(collection, id);
  return row ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found.' });
});

app.post('/api/session/reset', (req, res) => {
  forget(req.body?.sessionId || 'default');
  res.json({ ok: true });
});

app.listen(config.port, () => {
  const caps = capabilities();
  console.log(`\n  JARVIS 2.0 online → http://localhost:${config.port}`);
  console.log(`  brain: ${caps.brain ? caps.model : 'offline (set ANTHROPIC_API_KEY)'}`);
  console.log(`  ears:  ${caps.transcription ? 'Whisper' : 'browser speech recognition'}`);
  console.log(`  voice: ${caps.voice ? `ElevenLabs ${caps.voiceId}` : 'browser speech synthesis'}\n`);
});
