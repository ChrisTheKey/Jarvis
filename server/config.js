import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5',
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    version: '2023-06-01',
  },

  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1',
    baseUrl: 'https://api.openai.com',
  },

  elevenlabs: {
    apiKey: env.ELEVENLABS_API_KEY || '',
    voiceId: env.ELEVENLABS_VOICE_ID || 'h029Xu7odsKARnf0xDjw',
    modelId: env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5',
    baseUrl: 'https://api.elevenlabs.io',
  },

  /** Window Buffer Memory: how many turns are replayed to the agent. */
  memoryWindow: Number(env.MEMORY_WINDOW || 12),
};

export const capabilities = () => ({
  brain: Boolean(config.anthropic.apiKey),
  transcription: Boolean(config.openai.apiKey),
  voice: Boolean(config.elevenlabs.apiKey),
  model: config.anthropic.model,
  voiceId: config.elevenlabs.voiceId,
});
