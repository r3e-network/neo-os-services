import test from 'node:test';
import assert from 'node:assert/strict';
import {
  neoNetworkMagicLe4,
  encodeUint256Word,
} from '@r3e-network/neo-os-services-shared/neo-encoding';

// Golden vectors that BOTH the JS encoders and the on-chain C# contracts
// (NetworkMagicLe4 / uint256 word) must reproduce. Any change that alters these
// bytes breaks signature verification, so they are pinned here as a regression
// guard for the single-sourcing of the previously-duplicated encoders.

test('neoNetworkMagicLe4 produces the pinned 4-byte little-endian magics', () => {
  assert.equal(neoNetworkMagicLe4(860833102).toString('hex'), '4e454f33', 'mainnet');
  assert.equal(neoNetworkMagicLe4(894710606).toString('hex'), '4e335435', 'testnet');
  assert.equal(neoNetworkMagicLe4(0).toString('hex'), '00000000', 'zero baseline');
  // High-bit-set value proves unsigned 32-bit handling (writeUInt32LE + >>> 0).
  assert.equal(neoNetworkMagicLe4(2147483649).toString('hex'), '01000080', '0x80000001');
  assert.equal(neoNetworkMagicLe4(4294967295).toString('hex'), 'ffffffff', 'max uint32');
});

test('encodeUint256Word produces 32-byte big-endian zero-padded words', () => {
  assert.equal(encodeUint256Word(0).toString('hex'), '0'.repeat(64));
  assert.equal(encodeUint256Word(1).toString('hex'), '0'.repeat(63) + '1');
  assert.equal(encodeUint256Word(4886718345).toString('hex'), '0'.repeat(55) + '123456789');
  assert.equal(encodeUint256Word(2n ** 256n - 1n).toString('hex'), 'f'.repeat(64));
  // String inputs are the common on-chain shape (nonce/deadline are decimal strings).
  assert.equal(encodeUint256Word('1710001234').toString('hex'), '0'.repeat(56) + '65ec8c52');
});

test('encodeUint256Word rejects negatives and overflow instead of truncating', () => {
  assert.throws(() => encodeUint256Word(-1), /must be >= 0/);
  assert.throws(() => encodeUint256Word(2n ** 256n), /overflows uint256/);
  assert.throws(() => encodeUint256Word('not-a-number', 'nonce'), /nonce must be a uint256 string/);
});

// encodeUint256Word parses through BigInt(String(value)) — the StringToBigInt
// grammar, NOT the stricter BigInt literal grammar. The Rust port pins these
// two directions, so the oracle side must pin them too: leading decimal zeros
// are accepted, underscore separators (legal in `1_0n` literals) are not.
test('encodeUint256Word follows the StringToBigInt grammar for string inputs', () => {
  assert.equal(encodeUint256Word('012').toString('hex'), '0'.repeat(62) + '0c', 'leading zero');
  assert.throws(() => encodeUint256Word('1_0'), /must be a uint256 string/, 'underscore');
  assert.equal(encodeUint256Word(' 5 ').toString('hex'), '0'.repeat(63) + '5', 'JS-trimmed');
  assert.equal(encodeUint256Word('-0').toString('hex'), '0'.repeat(64), 'negative zero is 0n');
  // `'' ?? '0'` is '' (?? only collapses null/undefined) and BigInt('') is 0n.
  assert.equal(encodeUint256Word('').toString('hex'), '0'.repeat(64), 'empty string is 0n');
  assert.equal(encodeUint256Word(null).toString('hex'), '0'.repeat(64), "nullish coalesces to '0'");
});
