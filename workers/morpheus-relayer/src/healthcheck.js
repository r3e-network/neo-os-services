import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createLogger } from './logger.js';
import { trimString } from './lib/strings.js';

const logger = createLogger({ service: 'morpheus-relayer-healthcheck' });

export function checkRelayerStateFreshness({
  stateFile = process.env.MORPHEUS_RELAYER_STATE_FILE,
  maxStaleMs = Number(process.env.MORPHEUS_RELAYER_HEALTH_MAX_STALE_MS || 120_000),
  nowMs = Date.now(),
} = {}) {
  const filePath = trimString(stateFile);
  if (!filePath) {
    return { ok: false, reason: 'missing_state_file' };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reason: 'unreadable_state_file',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const completedAt = Date.parse(String(parsed?.metrics?.last_tick_completed_at || ''));
  if (!Number.isFinite(completedAt)) {
    return { ok: false, reason: 'missing_completed_tick' };
  }

  const staleMs = Math.max(Number(maxStaleMs || 120_000), 1_000);
  const ageMs = nowMs - completedAt;
  if (ageMs > staleMs) {
    return {
      ok: false,
      reason: 'stale_completed_tick',
      age_ms: ageMs,
      max_stale_ms: staleMs,
      last_tick_completed_at: parsed.metrics.last_tick_completed_at,
    };
  }

  return {
    ok: true,
    reason: 'fresh',
    age_ms: ageMs,
    max_stale_ms: staleMs,
    last_tick_completed_at: parsed.metrics.last_tick_completed_at,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = checkRelayerStateFreshness();
  if (!result.ok) {
    logger.error(result, 'Relayer state is stale or unreadable');
    process.exit(1);
  }
  process.exit(0);
}
