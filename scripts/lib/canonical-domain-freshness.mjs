import assert from 'node:assert/strict';

export function assertFreshResponse(response) {
  assert.doesNotMatch(
    response.headers.get('x-upstream-source') || '',
    /(?:^|[^a-z])stale(?:[^a-z]|$)/i,
    'upstream returned stale fallback'
  );
  for (const header of ['x-edge-cache', 'cf-cache-status']) {
    assert.doesNotMatch(
      response.headers.get(header) || '',
      /^(?:STALE|UPDATING)$/i,
      'edge returned stale fallback'
    );
  }
  assert.equal(
    response.headers.has('x-n3index-stale-age-seconds'),
    false,
    'response carries a stale age'
  );
  assert.doesNotMatch(
    response.headers.get('warning') || '',
    /(?:^|,)\s*11[01]\b/,
    'response carries a stale warning'
  );
}

export function assertFreshTimestamp(timestampMs, nowMs = Date.now(), maxAgeMs = 300_000) {
  assert.ok(
    Number.isSafeInteger(timestampMs) && timestampMs > 0,
    'missing or invalid data timestamp'
  );
  const ageMs = nowMs - timestampMs;
  assert.ok(
    ageMs >= -30_000 && ageMs <= maxAgeMs,
    `data timestamp is outside freshness bounds: ageMs=${ageMs}`
  );
}

export function assertLatestHeight(blockHeight, indexedHeight) {
  assert.ok(Number.isSafeInteger(blockHeight) && blockHeight > 0);
  assert.ok(Number.isSafeInteger(indexedHeight) && indexedHeight > 0);
  const delta = indexedHeight - blockHeight;
  assert.ok(Math.abs(delta) <= 20, `block list and indexer status disagree by ${delta} blocks`);
}
