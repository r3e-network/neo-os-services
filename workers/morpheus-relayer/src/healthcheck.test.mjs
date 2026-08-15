import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkRelayerStateFreshness } from './healthcheck.js';

function writeStateFile(state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-relayer-health-'));
  const filePath = path.join(dir, 'state.json');
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
  return filePath;
}

describe('checkRelayerStateFreshness', () => {
  it('passes when the last completed tick is fresh', () => {
    const nowMs = Date.parse('2026-05-05T08:00:00.000Z');
    const stateFile = writeStateFile({
      metrics: {
        last_tick_completed_at: '2026-05-05T07:59:30.000Z',
      },
    });

    const result = checkRelayerStateFreshness({ stateFile, nowMs, maxStaleMs: 120_000 });

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'fresh');
    assert.equal(result.age_ms, 30_000);
  });

  it('fails when the last completed tick is stale', () => {
    const nowMs = Date.parse('2026-05-05T08:00:00.000Z');
    const stateFile = writeStateFile({
      metrics: {
        last_tick_completed_at: '2026-05-05T07:55:00.000Z',
      },
    });

    const result = checkRelayerStateFreshness({ stateFile, nowMs, maxStaleMs: 120_000 });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale_completed_tick');
  });

  it('fails when no completed tick has ever been recorded', () => {
    const stateFile = writeStateFile({ metrics: { last_tick_started_at: '2026-05-05T08:00:00Z' } });

    const result = checkRelayerStateFreshness({ stateFile });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing_completed_tick');
  });
});
