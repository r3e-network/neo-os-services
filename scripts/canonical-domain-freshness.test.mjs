import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertFreshResponse,
  assertFreshTimestamp,
  assertLatestHeight,
} from './lib/canonical-domain-freshness.mjs';

test('a successful stale fallback must fail the production probe', () => {
  for (const headers of [
    { 'x-upstream-source': 'stale-if-error' },
    { 'x-edge-cache': 'STALE' },
    { 'cf-cache-status': 'UPDATING' },
    { 'x-upstream-source': 'stale-readiness-rejected' },
    { 'x-n3index-stale-age-seconds': '1' },
    { warning: '110 - "Response is stale"' },
    { warning: '111 - "Revalidation failed"' },
  ])
    assert.throws(() => assertFreshResponse(new Response('{}', { status: 200, headers })));
  assertFreshResponse(new Response('{}', { headers: { 'x-upstream-source': 'origin' } }));
});

test('freshness uses data time rather than a cached ready flag', () => {
  const now = 1_789_072_260_000;
  assertFreshTimestamp(now - 30_000, now);
  for (const timestamp of [now - 300_001, now + 30_001, NaN, null, 0, 'today']) {
    assert.throws(() => assertFreshTimestamp(timestamp, now));
  }
});

test('latest block validation catches the observed stale height despite HTTP 200', () => {
  assert.throws(() => assertLatestHeight(13_119_036, 13_119_885));
  assertLatestHeight(13_119_890, 13_119_885);
  assert.throws(() => assertLatestHeight(13_119_885, 0));
});
