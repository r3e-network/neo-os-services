import { loadDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';

export async function loadBetterStackTelemetryEnv() {
  await loadDotEnv('.env.local');
  await loadDotEnv('.env');
}

function getBetterStackTelemetryTokens() {
  return [
    trimString(process.env.BETTERSTACK_TELEMETRY_TOKEN),
    trimString(process.env.BETTERSTACK_TELEMETRY_TOKEN_ALT),
  ].filter(Boolean);
}

export async function betterStackTelemetryApi(pathname, init = {}) {
  const tokens = getBetterStackTelemetryTokens();
  if (tokens.length === 0) {
    throw new Error('Missing BETTERSTACK_TELEMETRY_TOKEN');
  }

  let lastError = null;
  for (const token of tokens) {
    try {
      const response = await fetch(`https://telemetry.betterstack.com/api/v1${pathname}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(init.headers || {}),
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        lastError = new Error(JSON.stringify(payload || { status: response.status }, null, 2));
        continue;
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Better Stack telemetry API request failed');
}
