import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTestnetChainId } from './neox-testnet-e2e.mjs';

test('Neo X testnet E2E uses the reviewed chain identity', () => {
  assert.equal(resolveTestnetChainId({}), 12227332);
  assert.throws(
    () => resolveTestnetChainId({ NEOX_CHAIN_ID: '12227333' }),
    /conflicts with reviewed testnet identity/
  );
});
