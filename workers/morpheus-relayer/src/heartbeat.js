import { trimString } from './lib/strings.js';

function resolveTimeoutMs() {
  const configured = Number(process.env.MORPHEUS_HEARTBEAT_TIMEOUT_MS || '');
  if (!Number.isFinite(configured)) return 3000;
  return Math.max(250, Math.trunc(configured));
}

export async function sendHeartbeat(url, payload = null) {
  const target = trimString(url);
  if (!target) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeoutMs());

  try {
    await fetch(target, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'content-type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
