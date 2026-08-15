// Canonical Neo N3 digest byte encoders.
//
// These primitives feed the fulfillment / NeoDID signing digests, so their byte
// output is consensus-adjacent: it MUST match, byte-for-byte, what the on-chain
// contracts hash (contracts/MorpheusOracle/MorpheusOracle.Fulfillment.cs and
// contracts/NeoDIDRegistry/NeoDIDRegistry.cs). They were previously reimplemented
// in workers/nitro-worker (neodid) and workers/morpheus-relayer (router), plus a
// third divergent copy in the worker test suite. This module is the single JS
// source of truth; packages/shared/src/neo-encoding.test.mjs pins the golden
// vectors that both languages must reproduce.

// 4-byte little-endian network magic. Byte-identical to the authoritative C#
// NetworkMagicLe4() (which takes the low 32 bits of Runtime.GetNetwork() via
// BigInteger arithmetic). Deliberately performs NO magic-range validation: C#
// has no such guard, so adding one here could throw on a magic the contract
// accepts, splitting signer and contract. The caller is responsible for
// resolving/validating the magic (env + network fallback) before encoding.
export function neoNetworkMagicLe4(magic) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(magic >>> 0, 0);
  return bytes;
}

// 32-byte big-endian uint256 word, zero-left-padded. Rejects negatives and any
// value that does not fit in uint256 so a malformed word can never be folded
// into a signed digest. Byte-identical to the prior copies for every valid
// [0, 2**256 - 1] input; the throw-on-overflow behavior replaces the worker
// test's earlier copy, which silently truncated oversized words.
export function encodeUint256Word(value, fieldName = 'value') {
  let parsed;
  try {
    parsed = BigInt(String(value ?? '0'));
  } catch {
    throw new Error(`${fieldName} must be a uint256 string`);
  }
  if (parsed < 0n) throw new Error(`${fieldName} must be >= 0`);
  const hex = parsed.toString(16);
  if (hex.length > 64) throw new Error(`${fieldName} overflows uint256`);
  return Buffer.from(hex.padStart(64, '0'), 'hex');
}
