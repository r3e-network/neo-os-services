import test from 'node:test';
import assert from 'node:assert/strict';
import { jsonError, sanitizeErrorMessage } from './core.js';

test('jsonError passes benign error messages through with the requested status', async () => {
  const response = jsonError(502, new Error('twelvedata upstream returned HTTP 429'));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'twelvedata upstream returned HTTP 429' });
});

test('jsonError redacts messages matching the sensitive-pattern blacklist', async () => {
  const sensitive = [
    new Error('failed to load private_key from disk'),
    new Error('open /home/morpheus/.aws/credentials: permission denied'),
    new Error('at handler (worker.js:12:34)'),
  ];
  for (const error of sensitive) {
    const response = jsonError(400, error);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'internal error' });
  }
});

test('jsonError stringifies non-Error throwables', async () => {
  const response = jsonError(400, 'decrypt failed');
  assert.deepEqual(await response.json(), { error: 'decrypt failed' });
  assert.equal(sanitizeErrorMessage('x'.repeat(300)).length, 200);
});
