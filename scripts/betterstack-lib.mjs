import { loadDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';

export async function loadBetterStackEnv() {
  await loadDotEnv('.env.local');
  await loadDotEnv('.env');
}

function getBetterStackUptimeTokens() {
  return [
    trimString(process.env.BETTERSTACK_UPTIME_API_TOKEN),
    trimString(process.env.BETTERSTACK_UPTIME_API_TOKEN_ALT),
  ].filter(Boolean);
}

export async function betterStackApi(pathname, init = {}) {
  const tokens = getBetterStackUptimeTokens();
  if (tokens.length === 0) {
    throw new Error('Missing BETTERSTACK_UPTIME_API_TOKEN');
  }

  let lastError = null;
  for (const token of tokens) {
    try {
      const response = await fetch(`https://uptime.betterstack.com/api/v2${pathname}`, {
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

  throw lastError || new Error('Better Stack API request failed');
}

export function heartbeatFailUrl(url) {
  const value = trimString(url);
  if (!value) return '';
  return value.endsWith('/fail') ? value : `${value}/fail`;
}
