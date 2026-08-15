import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCallbackWithLocalFallback } from './lib-smoke-oracle-fallback.mjs';

describe('resolveCallbackWithLocalFallback', () => {
  it('keeps polling when local fallback loses the race to an already-fulfilled request', async () => {
    const attempts = [];
    const callback = { success: true, result_text: '{"price":"12.34"}' };

    const result = await resolveCallbackWithLocalFallback({
      requestId: 4443,
      callbackTimeoutMs: 100,
      waitForCallback: async () => {
        attempts.push('wait');
        if (attempts.length === 1) {
          throw new Error('timed out waiting for callback 4443');
        }
        return callback;
      },
      beforeLocalFallback: async () => {
        attempts.push('topup');
      },
      fulfillRequestLocally: async () => {
        attempts.push('fulfill');
        throw new Error('Script execution failed. Reason: request already fulfilled');
      },
      onTimeout: () => {
        attempts.push('timeout');
      },
    });

    assert.deepEqual(attempts, ['wait', 'timeout', 'topup', 'fulfill', 'wait']);
    assert.equal(result, callback);
  });

  it('rethrows non-settled local fallback failures', async () => {
    await assert.rejects(
      () =>
        resolveCallbackWithLocalFallback({
          requestId: 7,
          callbackTimeoutMs: 100,
          waitForCallback: async () => {
            throw new Error('timed out waiting for callback 7');
          },
          fulfillRequestLocally: async () => {
            throw new Error('verifier rejected signature');
          },
        }),
      /verifier rejected signature/
    );
  });
});
