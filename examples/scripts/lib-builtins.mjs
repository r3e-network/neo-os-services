import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { keccak256, toUtf8Bytes } from 'ethers';

function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function sha256Hex(value) {
  return createHash('sha256')
    .update(Buffer.from(stableStringify(value), 'utf8'))
    .digest('hex');
}

function bigintPowMod(base, exponent, modulus) {
  let result = 1n;
  let b = BigInt(base) % BigInt(modulus);
  let e = BigInt(exponent);
  const m = BigInt(modulus);
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return result.toString();
}

function polynomialValue(coefficients, x, modulus = null) {
  let result = 0n;
  const bx = BigInt(x);
  const mod = modulus ? BigInt(modulus) : null;
  for (const coefficient of coefficients) {
    result = result * bx + BigInt(coefficient);
    if (mod !== null) result = ((result % mod) + mod) % mod;
  }
  return result.toString();
}

function merkleRoot(leaves) {
  const leafHashes = leaves.map((leaf) =>
    createHash('sha256')
      .update(Buffer.from(String(leaf), 'utf8'))
      .digest()
  );
  let level = leafHashes;
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      next.push(
        createHash('sha256')
          .update(Buffer.concat([left, right]))
          .digest()
      );
    }
    level = next;
  }
  return level[0].toString('hex');
}

function buildRsaVerifyFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const payload = 'neo-morpheus-rsa';
  const signer = createSign('RSA-SHA256');
  signer.update(payload);
  signer.end();
  return {
    payload,
    public_key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signature: signer.sign(privateKey).toString('hex'),
  };
}

export function extractBuiltinInnerResult(callbackEnvelope) {
  return callbackEnvelope?.result?.result || null;
}

export async function buildBuiltinComputeCases(targetChain) {
  const rsaFixture = buildRsaVerifyFixture();
  return [
    {
      name: 'hash.sha256',
      payload: {
        mode: 'builtin',
        function: 'hash.sha256',
        input: { alpha: 1, beta: [2, 3] },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.digest, sha256Hex({ alpha: 1, beta: [2, 3] }));
      },
    },
    {
      name: 'hash.keccak256',
      payload: {
        mode: 'builtin',
        function: 'hash.keccak256',
        input: { alpha: 1, beta: [2, 3] },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(
          inner.digest,
          keccak256(toUtf8Bytes(stableStringify({ alpha: 1, beta: [2, 3] })))
        );
      },
    },
    {
      name: 'crypto.rsa_verify',
      payload: {
        mode: 'builtin',
        function: 'crypto.rsa_verify',
        input: rsaFixture,
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.is_valid, true);
      },
    },
    {
      name: 'math.modexp',
      payload: {
        mode: 'builtin',
        function: 'math.modexp',
        input: { base: '2', exponent: '10', modulus: '17' },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.value, bigintPowMod(2, 10, 17));
      },
    },
    {
      name: 'math.polynomial',
      payload: {
        mode: 'builtin',
        function: 'math.polynomial',
        input: { coefficients: [2, 3, 5], x: 4, modulus: 17 },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.value, polynomialValue([2, 3, 5], 4, 17));
      },
    },
    {
      name: 'matrix.multiply',
      payload: {
        mode: 'builtin',
        function: 'matrix.multiply',
        input: {
          left: [
            [1, 2],
            [3, 4],
          ],
          right: [
            [5, 6],
            [7, 8],
          ],
        },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.deepEqual(inner.matrix, [
          [19, 22],
          [43, 50],
        ]);
      },
    },
    {
      name: 'vector.cosine_similarity',
      payload: {
        mode: 'builtin',
        function: 'vector.cosine_similarity',
        input: { left: [1, 2, 3], right: [1, 2, 3] },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(Number(inner.similarity), 1);
      },
    },
    {
      name: 'merkle.root',
      payload: {
        mode: 'builtin',
        function: 'merkle.root',
        input: { leaves: ['a', 'b', 'c'] },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.root, merkleRoot(['a', 'b', 'c']));
      },
    },
    {
      name: 'zkp.public_signal_hash',
      payload: {
        mode: 'builtin',
        function: 'zkp.public_signal_hash',
        input: { circuit_id: 'configured-circuit', signals: [1, 2, 3] },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.digest, sha256Hex({ circuit_id: 'configured-circuit', signals: [1, 2, 3] }));
      },
    },
    {
      name: 'zkp.proof_digest',
      payload: {
        mode: 'builtin',
        function: 'zkp.proof_digest',
        input: { proof: { a: '1' }, verifying_key: 'vk-1' },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.digest, sha256Hex({ proof: { a: '1' }, verifying_key: 'vk-1' }));
      },
    },
    {
      name: 'zkp.witness_digest',
      payload: {
        mode: 'builtin',
        function: 'zkp.witness_digest',
        input: { witness: { x: 9 }, circuit_id: 'configured-circuit' },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.digest, sha256Hex({ witness: { x: 9 }, circuit_id: 'configured-circuit' }));
      },
    },
    {
      name: 'zkp.groth16.prove.plan',
      payload: {
        mode: 'builtin',
        function: 'zkp.groth16.prove.plan',
        input: { constraints: 100000, witness_count: 5000 },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.deepEqual(inner, {
          constraints: 100000,
          witness_count: 5000,
          estimated_segments: 2,
          estimated_memory_mb: 5,
        });
      },
    },
    {
      name: 'zkp.plonk.prove.plan',
      payload: {
        mode: 'builtin',
        function: 'zkp.plonk.prove.plan',
        input: { gates: 131072 },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.deepEqual(inner, {
          gates: 131072,
          estimated_polynomials: 2,
          estimated_memory_mb: 5,
        });
      },
    },
    {
      name: 'fhe.batch_plan',
      payload: {
        mode: 'builtin',
        function: 'fhe.batch_plan',
        input: { slot_count: 16, ciphertext_count: 3 },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.deepEqual(inner, { slot_count: 16, ciphertext_count: 3, slots_per_ciphertext: 6 });
      },
    },
    {
      name: 'fhe.noise_budget_estimate',
      payload: {
        mode: 'builtin',
        function: 'fhe.noise_budget_estimate',
        input: { multiplicative_depth: 2, scale_bits: 40, modulus_bits: 218 },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.deepEqual(inner, {
          multiplicative_depth: 2,
          scale_bits: 40,
          modulus_bits: 218,
          estimated_noise_budget: 138,
        });
      },
    },
    {
      name: 'fhe.rotation_plan',
      payload: {
        mode: 'builtin',
        function: 'fhe.rotation_plan',
        input: { indices: [1, -1, 4, 1] },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.deepEqual(inner, {
          indices: [1, -1, 4, 1],
          unique_rotations: [-1, 1, 4],
          key_switch_steps: 4,
        });
      },
    },
    {
      name: 'privacy.mask',
      payload: {
        mode: 'builtin',
        function: 'privacy.mask',
        input: { value: 'secret-token-1234', unmasked_left: 3, unmasked_right: 2 },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(inner.masked, 'sec************34');
      },
    },
    {
      name: 'privacy.add_noise',
      payload: {
        mode: 'builtin',
        function: 'privacy.add_noise',
        input: { value: 10, scale: 0.5 },
        target_chain: targetChain,
      },
      validate(inner) {
        assert.equal(Number.isFinite(inner.noisy_value), true);
      },
    },
  ];
}
