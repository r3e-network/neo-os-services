import test from 'node:test';
import assert from 'node:assert/strict';
import { acquirePinnedDispatcher, __resetOracleFetchDispatchersForTests } from './fetch.js';

// Creating an undici Agent does not open a socket (sockets open on first request),
// so these exercise the cache mechanics without any network I/O. Every test closes
// the dispatchers it created so the process does not hang on open handles.
test.afterEach(async () => {
  await __resetOracleFetchDispatchersForTests();
});

test('acquirePinnedDispatcher reuses one dispatcher for a host + pinned set within TTL', () => {
  const pinned = [{ address: '203.0.113.10', family: 4 }];
  const first = acquirePinnedDispatcher('example.test', pinned, 1_000);
  const second = acquirePinnedDispatcher('example.test', pinned, 30_000);
  assert.equal(first, second, 'same host + validated address set reuses the pooled dispatcher');
});

test('acquirePinnedDispatcher keys on the exact validated address set', () => {
  const first = acquirePinnedDispatcher(
    'example.test',
    [{ address: '203.0.113.10', family: 4 }],
    1_000
  );
  const second = acquirePinnedDispatcher(
    'example.test',
    [{ address: '203.0.113.11', family: 4 }],
    1_000
  );
  assert.notEqual(first, second, 'a changed validated address set builds a fresh dispatcher');
});

test('acquirePinnedDispatcher keys on the hostname', () => {
  const pinned = [{ address: '203.0.113.10', family: 4 }];
  const a = acquirePinnedDispatcher('a.test', pinned, 1_000);
  const b = acquirePinnedDispatcher('b.test', pinned, 1_000);
  assert.notEqual(a, b, 'different hosts never share a dispatcher');
});

test('acquirePinnedDispatcher rebuilds a dispatcher once its TTL has expired', () => {
  const pinned = [{ address: '203.0.113.10', family: 4 }];
  const first = acquirePinnedDispatcher('example.test', pinned, 1_000);
  const afterTtl = acquirePinnedDispatcher('example.test', pinned, 1_000 + 60_000 + 1);
  assert.notEqual(first, afterTtl, 'an expired entry is retired and replaced');
});

test('address-set ordering does not affect the cache key', () => {
  const first = acquirePinnedDispatcher(
    'example.test',
    [
      { address: '203.0.113.10', family: 4 },
      { address: '203.0.113.11', family: 4 },
    ],
    1_000
  );
  const reordered = acquirePinnedDispatcher(
    'example.test',
    [
      { address: '203.0.113.11', family: 4 },
      { address: '203.0.113.10', family: 4 },
    ],
    2_000
  );
  assert.equal(first, reordered, 'the same set in a different order is one cache entry');
});
