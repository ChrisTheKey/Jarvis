import { config } from './config.js';

/**
 * Window Buffer Memory, keyed by session id — the browser's session id plays
 * the role the Telegram chat id played in the original workflow.
 */
const sessions = new Map();

export function getHistory(sessionId) {
  return sessions.get(sessionId) ?? [];
}

export function remember(sessionId, turn) {
  const history = getHistory(sessionId);
  history.push(turn);
  // Keep the last N turns, and never start the window on an assistant turn.
  const windowed = history.slice(-config.memoryWindow);
  while (windowed.length && windowed[0].role !== 'user') windowed.shift();
  sessions.set(sessionId, windowed);
  return windowed;
}

export function forget(sessionId) {
  sessions.delete(sessionId);
}

export function sessionCount() {
  return sessions.size;
}
