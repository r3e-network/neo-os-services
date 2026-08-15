import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __laplaceNoiseFromUnitForTests,
  __addLaplaceNoiseForTests,
  executeBuiltinCompute,
  BUILTIN_COMPUTE_CATALOG,
} from './index.js';

// A10 — Laplace noise inverse-CDF sampling must never produce NaN/±Infinity at
// the uniform-draw endpoints (the raw CSPRNG draw is in [0, 1); the endpoints
// drive log(1 - 2|u - 0.5|) -> log(0) -> -Infinity without clamping).

test('laplaceNoiseFromUnit stays finite at and beyond the (0,1) endpoints', () => {
  const value = 42;
  const scale = 2.5;
  for (const rawUnit of [0, 1, -0.0001, 1.0001, 0.5, Number.EPSILON, 1 - Number.EPSILON]) {
    const noisy = __laplaceNoiseFromUnitForTests(value, scale, rawUnit);
    assert.ok(Number.isFinite(noisy), `expected finite noisy value for rawUnit=${rawUnit}`);
    assert.ok(!Number.isNaN(noisy), `expected non-NaN noisy value for rawUnit=${rawUnit}`);
  }
});

test('laplaceNoiseFromUnit produces exactly the input at the midpoint draw', () => {
  // u = 0.5 -> u - 0.5 = 0 -> sign(0) = 0 -> zero noise.
  assert.equal(__laplaceNoiseFromUnitForTests(7, 1, 0.5), 7);
});

test('addLaplaceNoise never yields NaN/Infinity across many random draws', () => {
  for (let i = 0; i < 5000; i += 1) {
    const noisy = __addLaplaceNoiseForTests(100, 1.0);
    assert.ok(Number.isFinite(noisy), `draw ${i} produced non-finite value ${noisy}`);
  }
});

test('privacy.add_noise builtin returns a finite noisy_value across many calls', async () => {
  for (let i = 0; i < 2000; i += 1) {
    const { result } = await executeBuiltinCompute({
      function: 'privacy.add_noise',
      input: { value: 10, scale: 1.0 },
    });
    assert.ok(
      Number.isFinite(result.noisy_value),
      `call ${i} produced non-finite noisy_value ${result.noisy_value}`
    );
  }
});

test('privacy.add_noise catalog entry is labelled as illustrative, not calibrated DP', () => {
  const entry = BUILTIN_COMPUTE_CATALOG.find((item) => item.name === 'privacy.add_noise');
  assert.ok(entry, 'privacy.add_noise must be present in the catalog');
  assert.match(entry.description, /illustrative|not a calibrated|demonstration/i);
});

test('builtin compute rejects oversized bigint and matrix work before execution', async () => {
  await assert.rejects(
    executeBuiltinCompute({
      function: 'math.modexp',
      input: { base: '2', exponent: '9'.repeat(1025), modulus: '17' },
    }),
    /bigint input limit/
  );

  const side = 64;
  const matrix = Array.from({ length: side }, () => Array(side).fill(1));
  await assert.rejects(
    executeBuiltinCompute({
      function: 'matrix.multiply',
      input: { left: matrix, right: matrix },
    }),
    /work estimate exceeds limit/
  );
});
