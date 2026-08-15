import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { inspectWebCronEnv, WEB_CRON_REQUIRED_ENV } from './lib-web-cron-env.mjs';

function writeEnv(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n') + '\n',
    'utf8'
  );
}

test('web cron env checker requires every Vercel cron heartbeat key without exposing values', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-cron-env-'));
  writeEnv(path.join(repoRoot, 'apps/web/.vercel/.env.production.local'), {
    MORPHEUS_CRON_SECRET: 'secret-value',
    MORPHEUS_BETTERSTACK_CRON_FEED_HEARTBEAT_URL: 'https://heartbeat.example/feed',
    MORPHEUS_BETTERSTACK_CRON_FEED_FAILURE_URL: 'https://heartbeat.example/feed/fail',
    MORPHEUS_BETTERSTACK_CRON_HEALTH_HEARTBEAT_URL: 'https://heartbeat.example/health',
  });

  const result = await inspectWebCronEnv({ repoRoot, env: {} });

  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal(JSON.stringify(result).includes('heartbeat.example'), false);
});

test('web cron env checker reports missing production cron wiring', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'web-cron-env-missing-'));
  const result = await inspectWebCronEnv({ repoRoot, env: {} });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, WEB_CRON_REQUIRED_ENV);
});
