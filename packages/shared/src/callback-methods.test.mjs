import test from 'node:test';
import assert from 'node:assert/strict';
import { CALLBACK_METHOD, LEGACY_CALLBACK_METHOD } from './callback-methods.js';

// Cross-layer golden values (Round-2 R2-3.2). These strings MUST stay byte-identical to the
// contract literals — the Neo C# kernel (MorpheusOracle.cs CALLBACK_METHOD/LEGACY_CALLBACK_METHOD)
// and the EVM mirror (MorpheusOracleEVM.sol onOracleResult ABI). A drift here vs the contracts
// breaks the off-chain dispatch (the relayer would submit requests with a callback method the
// kernel rejects as "unsupported callback method"). The contract test suites pin the same
// literals independently. This test pins the JS/TS single-source value.
test('CALLBACK_METHOD is the rich onMiniAppResult golden literal', () => {
  assert.equal(CALLBACK_METHOD, 'onMiniAppResult');
});

test('LEGACY_CALLBACK_METHOD is the 5-arg onOracleResult golden literal', () => {
  assert.equal(LEGACY_CALLBACK_METHOD, 'onOracleResult');
});
