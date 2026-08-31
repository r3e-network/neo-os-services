import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasReceivedCallback } from './lib-smoke-oracle-fallback.mjs';

describe('hasReceivedCallback', () => {
  it('rejects the current adapter empty-record sentinel', () => {
    const emptyRecord = {
      type: 'Array',
      value: Array.from({ length: 7 }, () => ({ type: 'ByteString', value: '' })).concat({
        type: 'Integer',
        value: '0',
      }),
    };

    assert.equal(hasReceivedCallback(emptyRecord), false);
  });

  it('accepts a delivered current-adapter record and legacy four-field records', () => {
    const deliveredRecord = {
      type: 'Array',
      value: Array.from({ length: 7 }, () => ({ type: 'ByteString', value: '' })).concat({
        type: 'Integer',
        value: '1788123456789',
      }),
    };
    const legacyRecord = {
      type: 'Array',
      value: Array.from({ length: 4 }, () => ({ type: 'ByteString', value: '' })),
    };

    assert.equal(hasReceivedCallback(deliveredRecord), true);
    assert.equal(hasReceivedCallback(legacyRecord), true);
  });
});
