import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBooleanEnv } from './utils.js';

test('parseBooleanEnv accepts the canonical truthy tokens case-insensitively', () => {
  for (const token of ['1', 'true', 'TRUE', 'Yes', 'on', 'ON', '  true  ']) {
    assert.equal(parseBooleanEnv(token, false), true, `expected ${JSON.stringify(token)} -> true`);
  }
});

test('parseBooleanEnv accepts the canonical falsy tokens case-insensitively', () => {
  for (const token of ['0', 'false', 'FALSE', 'No', 'off', 'OFF', '  off  ']) {
    assert.equal(parseBooleanEnv(token, true), false, `expected ${JSON.stringify(token)} -> false`);
  }
});

test('parseBooleanEnv returns the fallback for unset or unrecognized values', () => {
  assert.equal(parseBooleanEnv(undefined, true), true);
  assert.equal(parseBooleanEnv(null, true), true);
  assert.equal(parseBooleanEnv('', true), true);
  assert.equal(parseBooleanEnv('   ', true), true);
  assert.equal(parseBooleanEnv('garbage', true), true, 'a typo keeps the intended default');
  assert.equal(parseBooleanEnv('garbage', false), false);
});
