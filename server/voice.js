import { config } from './config.js';

/** Speech → text via OpenAI Whisper (the "Transcribe" node). */
export async function transcribe(buffer, filename = 'audio.webm', mimetype = 'audio/webm') {
  if (!config.openai.apiKey) {
    const error = new Error('No OPENAI_API_KEY configured — use the browser recogniser instead.');
    error.status = 501;
    throw error;
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype }), filename);
  form.append('model', config.openai.transcribeModel);

  const response = await fetch(`${config.openai.baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.openai.apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Transcription failed (${response.status}): ${detail.slice(0, 300)}`);
    error.status = 502;
    throw error;
  }
  const json = await response.json();
  return json.text?.trim() || '';
}

/** Text → speech via ElevenLabs (the "Text to Speech" node), same voice id. */
export async function speak(text) {
  if (!config.elevenlabs.apiKey) {
    const error = new Error('No ELEVENLABS_API_KEY configured — the browser voice will be used.');
    error.status = 501;
    throw error;
  }

  const response = await fetch(
    `${config.elevenlabs.baseUrl}/v1/text-to-speech/${config.elevenlabs.voiceId}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'audio/mpeg',
        'xi-api-key': config.elevenlabs.apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: config.elevenlabs.modelId,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Speech synthesis failed (${response.status}): ${detail.slice(0, 300)}`);
    error.status = 502;
    throw error;
  }
  return Buffer.from(await response.arrayBuffer());
}
