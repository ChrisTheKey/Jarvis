const $ = (sel) => document.querySelector(sel);

const els = {
  statusStrip: $('#statusStrip'),
  transcript: $('#transcript'),
  form: $('#composerForm'),
  input: $('#messageInput'),
  sendBtn: $('#sendBtn'),
  micBtn: $('#micBtn'),
  resetBtn: $('#resetBtn'),
  voiceReplies: $('#voiceReplies'),
  activityFeed: $('#activityFeed'),
  activityCount: $('#activityCount'),
  agentRoster: $('#agentRoster'),
  recordsBody: $('#recordsBody'),
  tabs: $('#tabs'),
  stats: document.querySelectorAll('.stat'),
  player: $('#player'),
  hint: $('#hint'),
};

const state = {
  sessionId: localStorage.getItem('jarvis.session') || crypto.randomUUID(),
  status: { brain: false, transcription: false, voice: false, agents: [] },
  tab: 'events',
  busy: false,
  recorder: null,
  recognition: null,
  listening: false,
  dispatched: 0,
};
localStorage.setItem('jarvis.session', state.sessionId);

/* ------------------------------------------------------------------ status */

async function loadStatus() {
  try {
    state.status = await (await fetch('/api/status')).json();
  } catch {
    return;
  }
  const { brain, transcription, voice, model } = state.status;
  els.statusStrip.innerHTML = [
    chip(brain ? `brain · ${model}` : 'brain · offline', brain),
    chip(transcription ? 'ears · whisper' : 'ears · browser', transcription, true),
    chip(voice ? 'voice · elevenlabs' : 'voice · browser', voice, true),
  ].join('');

  els.agentRoster.innerHTML = (state.status.agents || [])
    .map((a) => `<li data-agent="${a.name}" title="${escapeHtml(a.description)}">${escapeHtml(a.label)}</li>`)
    .join('');

  if (!brain) {
    addBubble(
      'system',
      'Reasoning core offline — no ANTHROPIC_API_KEY is set. Direct commands still work: arithmetic, logging an expense, reading the calendar, looking up a contact, taking a note.',
    );
  }
}

const chip = (label, on, fallback = false) =>
  `<span class="chip ${on ? 'on' : fallback ? 'fallback' : ''}">${escapeHtml(label)}</span>`;

/* -------------------------------------------------------------- transcript */

function addBubble(kind, text, spoken) {
  const el = document.createElement('div');
  el.className = `bubble ${kind}`;
  const who = { user: 'You', jarvis: 'Jarvis', system: 'System', error: 'Fault' }[kind] || kind;
  el.innerHTML =
    (kind === 'system' ? '' : `<span class="who">${who}</span>`) +
    `<div class="body">${escapeHtml(text)}</div>` +
    (spoken ? `<div class="spoken">${escapeHtml(spoken)}</div>` : '');
  els.transcript.append(el);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return el;
}

function addThinking() {
  const el = document.createElement('div');
  el.className = 'bubble jarvis';
  el.innerHTML = '<span class="who">Jarvis</span><div class="thinking"><i></i><i></i><i></i></div>';
  els.transcript.append(el);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return el;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ turn */

async function send(text) {
  if (!text.trim() || state.busy) return;
  state.busy = true;
  els.sendBtn.disabled = true;
  addBubble('user', text);
  els.input.value = '';
  const pending = addThinking();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: text }),
    });
    const data = await response.json();
    pending.remove();

    if (!response.ok) {
      addBubble('error', data.error || 'The request failed.');
      return;
    }

    renderActivity(data.toolCalls || []);
    addBubble('jarvis', data.reply, data.voiceLine);
    if (els.voiceReplies.checked && data.voiceLine) speakLine(data.voiceLine);
    refreshDashboard();
  } catch (error) {
    pending.remove();
    addBubble('error', error.message || 'Could not reach the server.');
  } finally {
    state.busy = false;
    els.sendBtn.disabled = false;
    els.input.focus();
  }
}

function renderActivity(toolCalls) {
  for (const call of toolCalls) {
    const failed = call.result?.ok === false;
    const el = document.createElement('div');
    el.className = `event ${failed ? 'failed' : ''}`;
    const detail = failed
      ? call.result.error
      : call.result?.summary || summarise(call.result) || 'Completed.';
    el.innerHTML =
      `<div class="event-head"><b>${escapeHtml(call.label || call.agent)}</b>` +
      `<time>${new Date(call.at).toLocaleTimeString()}</time></div>` +
      `<p>${escapeHtml(`${describeInput(call.input)} → ${detail}`)}</p>`;
    els.activityFeed.prepend(el);

    const badge = els.agentRoster.querySelector(`[data-agent="${call.agent}"]`);
    if (badge) {
      badge.classList.add('active');
      setTimeout(() => badge.classList.remove('active'), 2200);
    }
  }
  state.dispatched += toolCalls.length;
  els.activityCount.textContent = state.dispatched ? `${state.dispatched} dispatched` : 'idle';
}

function describeInput(input = {}) {
  const parts = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  return parts.join(', ').slice(0, 140) || 'no arguments';
}

function summarise(result = {}) {
  if (result.result !== undefined) return String(result.result);
  if (result.formattedTotal) return `${result.count} items · ${result.formattedTotal}`;
  for (const key of ['events', 'emails', 'contacts', 'expenses', 'notes']) {
    if (Array.isArray(result[key])) return `${result[key].length} ${key} returned`;
  }
  if (result.briefing) return 'briefing filed under notes';
  return '';
}

/* ------------------------------------------------------------------ voice */

async function speakLine(text) {
  els.micBtn.classList.add('speaking');
  const done = () => els.micBtn.classList.remove('speaking');

  if (state.status.voice) {
    try {
      const response = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (response.ok) {
        const url = URL.createObjectURL(await response.blob());
        els.player.src = url;
        els.player.onended = () => { done(); URL.revokeObjectURL(url); };
        await els.player.play();
        return;
      }
    } catch { /* fall back to the browser voice */ }
  }

  if (!('speechSynthesis' in window)) return done();
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const preferred =
    voices.find((v) => /en-GB/i.test(v.lang) && /(daniel|male|arthur|george)/i.test(v.name)) ||
    voices.find((v) => /en-GB/i.test(v.lang)) ||
    voices.find((v) => /en/i.test(v.lang));
  if (preferred) utterance.voice = preferred;
  utterance.rate = 0.98;
  utterance.pitch = 0.9;
  utterance.onend = done;
  utterance.onerror = done;
  speechSynthesis.speak(utterance);
}

/* Recording: Whisper when the server has a key, otherwise the browser recogniser. */
async function startRecording() {
  if (state.status.transcription && navigator.mediaDevices?.getUserMedia) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      setListening(false);
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 1200) return;
      const form = new FormData();
      form.append('audio', blob, 'speech.webm');
      try {
        const response = await fetch('/api/transcribe', { method: 'POST', body: form });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Transcription failed.');
        if (data.text) send(data.text);
      } catch (error) {
        addBubble('error', error.message);
      }
    };
    recorder.start();
    state.recorder = recorder;
    setListening(true);
    return;
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    addBubble('error', 'This browser has no speech recognition. Set OPENAI_API_KEY to use Whisper, or type instead.');
    return;
  }
  const recognition = new Recognition();
  recognition.lang = 'en-GB';
  recognition.interimResults = false;
  recognition.onresult = (event) => send(event.results[0][0].transcript);
  recognition.onerror = (event) => {
    setListening(false);
    if (event.error !== 'aborted' && event.error !== 'no-speech') addBubble('error', `Microphone error: ${event.error}`);
  };
  recognition.onend = () => setListening(false);
  recognition.start();
  state.recognition = recognition;
  setListening(true);
}

function stopRecording() {
  state.recorder?.state === 'recording' && state.recorder.stop();
  state.recognition?.stop();
  state.recorder = null;
  state.recognition = null;
  setListening(false);
}

function setListening(on) {
  state.listening = on;
  els.micBtn.classList.toggle('listening', on);
  els.micBtn.setAttribute('aria-label', on ? 'Stop listening' : 'Start listening');
  els.hint.textContent = on
    ? 'Listening… click the reactor again when you have finished.'
    : 'Try: “Schedule a design review with Pepper tomorrow at 3pm and email her the agenda.”';
}

/* -------------------------------------------------------------- dashboard */

const renderers = {
  events: (row) => ({
    title: row.title,
    lines: [
      new Date(row.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
        (row.end ? ` – ${new Date(row.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''),
      [row.location, (row.attendees || []).join(', ')].filter(Boolean).join(' · '),
    ],
  }),
  emails: (row) => ({
    title: row.subject || '(no subject)',
    badge: row.status,
    lines: [`To: ${row.to || 'unknown'}`, (row.body || '').slice(0, 160)],
  }),
  expenses: (row) => ({
    title: row.merchant || row.category,
    amount: `$${Number(row.amount).toFixed(2)}`,
    lines: [`${row.date} · ${row.category}`, row.note],
  }),
  contacts: (row) => ({ title: row.name, lines: [row.role, [row.email, row.phone].filter(Boolean).join(' · ')] }),
  notes: (row) => ({ title: row.topic, lines: [(row.briefing || '').slice(0, 220)] }),
};

async function refreshDashboard() {
  let data;
  try {
    data = await (await fetch('/api/dashboard')).json();
  } catch {
    return;
  }
  const totals = data.totals || {};
  for (const stat of els.stats) {
    const key = stat.dataset.stat;
    const value = key === 'expenses' ? `$${Number(totals.expenses || 0).toFixed(0)}` : totals[key] ?? 0;
    stat.querySelector('.stat-value').textContent = value;
  }

  const rows = data[state.tab] || [];
  const render = renderers[state.tab];
  els.recordsBody.innerHTML = rows
    .map((row) => {
      const view = render(row);
      return (
        `<div class="record"><div><h3>${escapeHtml(view.title)}` +
        (view.badge ? `<span class="badge ${escapeHtml(view.badge)}">${escapeHtml(view.badge)}</span>` : '') +
        `</h3>` +
        view.lines.filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join('') +
        `</div><div style="display:flex;align-items:flex-start;gap:8px">` +
        (view.amount ? `<span class="amount">${escapeHtml(view.amount)}</span>` : '') +
        `<button class="del" title="Delete" data-id="${row.id}">×</button></div></div>`
      );
    })
    .join('');
}

/* ----------------------------------------------------------------- events */

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  send(els.input.value);
});

els.micBtn.addEventListener('click', () => {
  if (state.listening) stopRecording();
  else startRecording().catch((error) => addBubble('error', `Microphone unavailable: ${error.message}`));
});

els.resetBtn.addEventListener('click', async () => {
  await fetch('/api/session/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId }),
  });
  els.transcript.innerHTML = '';
  els.activityFeed.innerHTML = '';
  state.dispatched = 0;
  els.activityCount.textContent = 'idle';
  greet();
});

els.tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  state.tab = button.dataset.tab;
  els.tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === button));
  refreshDashboard();
});

els.recordsBody.addEventListener('click', async (event) => {
  const button = event.target.closest('.del');
  if (!button) return;
  await fetch(`/api/records/${state.tab}/${button.dataset.id}`, { method: 'DELETE' });
  refreshDashboard();
});

function greet() {
  addBubble('jarvis', 'Systems online. Calendar, email, contacts, expenses, research and notes are at your disposal, sir.', 'At your service, sir. Do try to keep up.');
}

/* Voice list loads asynchronously in some browsers. */
if ('speechSynthesis' in window) speechSynthesis.getVoices();

await loadStatus();
greet();
refreshDashboard();
els.input.focus();
