import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffFeedRegistry,
  parseOnchainFeedRecords,
  summarizeFeedRegistryDrift,
} from './lib-feed-registry-drift.mjs';

test('parseOnchainFeedRecords decodes feed structs into comparable rows', () => {
  const rows = parseOnchainFeedRecords(
    {
      type: 'Array',
      value: [
        {
          type: 'Struct',
          value: [
            {
              type: 'ByteString',
              value: Buffer.from('TWELVEDATA:NEO-USD', 'utf8').toString('base64'),
            },
            { type: 'Integer', value: '7' },
            { type: 'Integer', value: '2951000' },
            { type: 'Integer', value: '1776386082' },
            { type: 'ByteString', value: Buffer.from('abcd', 'utf8').toString('base64') },
            { type: 'Integer', value: '1' },
          ],
        },
      ],
    },
    Date.parse('2026-04-17T00:00:00.000Z'),
    720
  );

  assert.deepEqual(rows, [
    {
      pair: 'TWELVEDATA:NEO-USD',
      round_id: '7',
      price: '2951000',
      timestamp: '1776386082',
      attestation_hash: 'abcd',
      source_set_id: '1',
      iso: '2026-04-17T00:34:42.000Z',
      age_min: -35,
      cadence: 'continuous',
      threshold_min: 720,
      stale: false,
    },
  ]);
});

test('diffFeedRegistry identifies missing and extra on-chain pairs', () => {
  const diff = diffFeedRegistry(
    ['TWELVEDATA:NEO-USD', 'TWELVEDATA:GAS-USD'],
    [{ pair: 'TWELVEDATA:NEO-USD' }, { pair: 'TWELVEDATA:OBSOLETE-USD' }]
  );

  assert.deepEqual(diff.missing_onchain_pairs, ['TWELVEDATA:GAS-USD']);
  assert.deepEqual(diff.extra_onchain_pairs, ['TWELVEDATA:OBSOLETE-USD']);
});

test('summarizeFeedRegistryDrift keeps legacy extra pairs non-blocking but flags stale configured pairs', () => {
  const summary = summarizeFeedRegistryDrift([
    {
      network: 'testnet',
      missing_onchain_pairs: [],
      extra_onchain_pairs: ['TWELVEDATA:OBSOLETE-USD'],
      rows: [
        { pair: 'TWELVEDATA:NEO-USD', stale: true },
        { pair: 'TWELVEDATA:OBSOLETE-USD', stale: true },
      ],
    },
  ]);

  assert.equal(summary.status, 'fail');
  assert.equal(summary.missing_onchain_pair_count, 0);
  assert.equal(summary.configured_onchain_stale_pair_count, 1);
  assert.equal(summary.blocking_issue_count, 1);
  assert.deepEqual(summary.reports[0].legacy_extra_onchain_pairs, ['TWELVEDATA:OBSOLETE-USD']);
});
