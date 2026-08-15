import { trimString } from '@r3e-network/neo-os-services-shared/utils';

function parseHeartbeatTimeoutMs() {
  const configured = Number(process.env.MORPHEUS_HEARTBEAT_TIMEOUT_MS || '');
  if (!Number.isFinite(configured)) return 3000;
  return Math.max(250, Math.trunc(configured));
}

export async function sendHeartbeat(url: string, payload?: Record<string, unknown>) {
  const target = trimString(url);
  if (!target) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), parseHeartbeatTimeoutMs());

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
