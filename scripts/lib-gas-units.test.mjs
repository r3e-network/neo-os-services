import test from 'node:test';
import assert from 'node:assert/strict';

import { parseGasToRaw } from './lib-gas-units.mjs';

test('parseGasToRaw pins the canonical 0.1 GAS conversion exactly', () => {
  assert.equal(parseGasToRaw('0.1', 0n), 10000000n);
});

test('parseGasToRaw converts plain decimals exactly', () => {
  assert.equal(parseGasToRaw('0', 1n), 0n);
  assert.equal(parseGasToRaw('1', 0n), 100000000n);
  assert.equal(parseGasToRaw('+2.5', 0n), 250000000n);
  assert.equal(parseGasToRaw('0.00000001', 0n), 1n);
  assert.equal(parseGasToRaw(' 3.00000000 ', 0n), 300000000n);
  assert.equal(parseGasToRaw('123456789.12345678', 0n), 12345678912345678n);
});

test('parseGasToRaw does not inherit float drift from the old parser', () => {
  // Math.ceil(Number('0.07') * 1e8) === 7000001 because 0.07 * 1e8 lands an
  // epsilon above the exact product; the BigInt parser must stay exact.
  assert.equal(parseGasToRaw('0.07', 0n), 7000000n);
});

test('parseGasToRaw rounds sub-base-unit precision up (ceil semantics)', () => {
  assert.equal(parseGasToRaw('0.000000001', 0n), 1n);
  assert.equal(parseGasToRaw('0.123456789', 0n), 12345679n);
  assert.equal(parseGasToRaw('1.000000010', 0n), 100000001n); // trailing zeros beyond 8 are exact
});

test('parseGasToRaw returns the fallback for empty or malformed input', () => {
  const fallback = 2000000n;
  assert.equal(parseGasToRaw(undefined, fallback), fallback);
  assert.equal(parseGasToRaw(null, fallback), fallback);
  assert.equal(parseGasToRaw('', fallback), fallback);
  assert.equal(parseGasToRaw('   ', fallback), fallback);
  assert.equal(parseGasToRaw('abc', fallback), fallback);
  assert.equal(parseGasToRaw('-1', fallback), fallback);
  assert.equal(parseGasToRaw('1e2', fallback), fallback);
  assert.equal(parseGasToRaw('0x10', fallback), fallback);
  assert.equal(parseGasToRaw('1.2.3', fallback), fallback);
  assert.equal(parseGasToRaw(0.1, fallback), fallback); // numbers must arrive as strings
});
