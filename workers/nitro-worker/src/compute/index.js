import { createVerify, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  assertUntrustedScriptsEnabled,
  assertWasmModuleSizeAllowed,
  cappedDurationMs,
  enforceSerializedSizeLimit,
  env,
  json,
  jsonError,
  normalizeTargetChain,
  parseDurationMs,
  resolveMaxBytes,
  resolveWasmModuleBase64,
  sha256Hex,
  stableStringify,
  trimString,
} from '../platform/core.js';
import { buildSignedResultEnvelope, buildLaneSignedEnvelope } from '../chain/index.js';
import { runScriptWithTimeout } from '../platform/script-runner.js';
import { resolveConfidentialPayload } from '../oracle/crypto.js';
import { validateUserScriptSource } from '../platform/script-policy.js';
import { runWasmWithTimeout } from '../platform/wasm-runner.js';
import { resolveScriptSource } from '../platform/script-source.js';

const DEFAULT_ZKP_VERIFY_MAX_INPUT_BYTES = 128 * 1024;
const DEFAULT_ZKP_VERIFY_TIMEOUT_MS = 15000;
const DEFAULT_BUILTIN_MAX_INPUT_BYTES = 64 * 1024;
const MAX_BIGINT_INPUT_CHARS = 1024;
const MAX_MATRIX_DIMENSION = 128;
const MAX_MATRIX_MULTIPLY_OPS = 250_000;
const MAX_VECTOR_ELEMENTS = 8192;
const MAX_POLYNOMIAL_COEFFICIENTS = 2048;
const MAX_MERKLE_LEAVES = 4096;
const execFile = promisify(execFileCallback);

function assertBoundedInteger(value, fieldName, { nonNegative = false, nonZero = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > MAX_BIGINT_INPUT_CHARS) {
    throw new Error(`${fieldName} exceeds the bigint input limit`);
  }
  let parsed;
  try {
    parsed = BigInt(raw);
  } catch {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (nonNegative && parsed < 0n) throw new Error(`${fieldName} must be non-negative`);
  if (nonZero && parsed === 0n) throw new Error(`${fieldName} must be non-zero`);
  return parsed;
}

function assertFiniteNumericArray(values, fieldName, maxLength) {
  if (!Array.isArray(values) || values.length === 0 || values.length > maxLength) {
    throw new Error(`${fieldName} length exceeds limit`);
  }
  for (const value of values) {
    if (!Number.isFinite(Number(value)))
      throw new Error(`${fieldName} must contain finite numbers`);
  }
}

function enforceBuiltinComputeLimits(fn, input) {
  enforceSerializedSizeLimit(
    input,
    'builtin compute input',
    resolveMaxBytes(
      env('COMPUTE_MAX_BUILTIN_INPUT_BYTES', 'MORPHEUS_MAX_BUILTIN_INPUT_BYTES'),
      DEFAULT_BUILTIN_MAX_INPUT_BYTES,
      1024
    )
  );
  if (fn === 'math.modexp') {
    assertBoundedInteger(input.base, 'base');
    assertBoundedInteger(input.exponent, 'exponent', { nonNegative: true });
    assertBoundedInteger(input.modulus, 'modulus', { nonZero: true });
  } else if (fn === 'math.polynomial') {
    assertFiniteNumericArray(input.coefficients, 'coefficients', MAX_POLYNOMIAL_COEFFICIENTS);
    assertBoundedInteger(Math.floor(Number(input.x)), 'x');
    if (input.modulus !== undefined && input.modulus !== null && input.modulus !== '') {
      assertBoundedInteger(input.modulus, 'modulus', { nonZero: true });
    }
  } else if (fn === 'matrix.multiply') {
    const left = input.left;
    const right = input.right;
    if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) {
      throw new Error('matrix.multiply requires non-empty left/right matrices');
    }
    const rows = left.length;
    const shared = Array.isArray(left[0]) ? left[0].length : 0;
    const cols = Array.isArray(right[0]) ? right[0].length : 0;
    if (
      rows > MAX_MATRIX_DIMENSION ||
      shared > MAX_MATRIX_DIMENSION ||
      right.length > MAX_MATRIX_DIMENSION ||
      cols > MAX_MATRIX_DIMENSION ||
      rows * shared * cols > MAX_MATRIX_MULTIPLY_OPS
    ) {
      throw new Error('matrix.multiply work estimate exceeds limit');
    }
    for (const [name, matrix] of [
      ['left', left],
      ['right', right],
    ]) {
      for (const row of matrix) {
        if (!Array.isArray(row)) throw new Error(`invalid ${name} matrix`);
        for (const value of row) {
          if (!Number.isFinite(Number(value))) throw new Error(`${name} matrix must be finite`);
        }
      }
    }
  } else if (fn === 'vector.cosine_similarity') {
    assertFiniteNumericArray(input.left, 'left vector', MAX_VECTOR_ELEMENTS);
    assertFiniteNumericArray(input.right, 'right vector', MAX_VECTOR_ELEMENTS);
  } else if (fn === 'merkle.root') {
    if (!Array.isArray(input.leaves) || input.leaves.length > MAX_MERKLE_LEAVES) {
      throw new Error('merkle leaves length exceeds limit');
    }
  } else if (fn === 'fhe.rotation_plan') {
    if (Array.isArray(input.indices) && input.indices.length > MAX_VECTOR_ELEMENTS) {
      throw new Error('rotation indices length exceeds limit');
    }
  }
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
  return result;
}

function multiplyMatrices(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) {
    throw new Error('matrix.multiply requires non-empty left/right matrices');
  }
  const rows = left.length;
  const shared = left[0].length;
  const cols = right[0].length;
  if (!left.every((row) => Array.isArray(row) && row.length === shared))
    throw new Error('invalid left matrix');
  if (!right.every((row) => Array.isArray(row) && row.length === cols))
    throw new Error('invalid right matrix');
  if (right.length !== shared) throw new Error('matrix dimensions do not align');
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      let sum = 0;
      for (let k = 0; k < shared; k += 1) sum += Number(left[i][k]) * Number(right[k][j]);
      out[i][j] = sum;
    }
  }
  return out;
}

function cosineSimilarity(left, right) {
  if (
    !Array.isArray(left) ||
    !Array.isArray(right) ||
    left.length !== right.length ||
    left.length === 0
  ) {
    throw new Error('vector.cosine_similarity requires equal-length non-empty vectors');
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = Number(left[i]);
    const b = Number(right[i]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0)
    throw new Error('cosine similarity undefined for zero vector');
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function asLeafHash(value) {
  const raw = trimString(value);
  if (/^(0x)?[0-9a-fA-F]+$/.test(raw) && raw.replace(/^0x/i, '').length % 2 === 0) {
    return Buffer.from(raw.replace(/^0x/i, ''), 'hex');
  }
  return Buffer.from(raw, 'utf8');
}

function maskString(value, unmaskedLeft = 2, unmaskedRight = 2) {
  const str = String(value || '');
  if (str.length <= unmaskedLeft + unmaskedRight) return '*'.repeat(Math.max(str.length, 4));
  return (
    str.slice(0, unmaskedLeft) +
    '*'.repeat(str.length - unmaskedLeft - unmaskedRight) +
    str.slice(-unmaskedRight)
  );
}

function cryptoRandomUnit() {
  return randomBytes(6).readUIntBE(0, 6) / 0x1000000000000;
}

// Inverse-CDF Laplace noise from a uniform draw. `rawUnit` is expected in [0, 1);
// it is clamped to the open interval (0, 1) so the log term can never be log(0).
function laplaceNoiseFromUnit(value, scale, rawUnit) {
  const clamped = rawUnit <= 0 ? Number.EPSILON : rawUnit >= 1 ? 1 - Number.EPSILON : rawUnit;
  const u = clamped - 0.5;
  const noise = -Number(scale) * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
  return Number(value) + noise;
}

function addLaplaceNoise(value, scale = 1.0) {
  return laplaceNoiseFromUnit(value, scale, cryptoRandomUnit());
}

export const __laplaceNoiseFromUnitForTests = laplaceNoiseFromUnit;
export const __addLaplaceNoiseForTests = addLaplaceNoise;

function merkleRoot(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0)
    throw new Error('merkle.root requires at least one leaf');
  let level = leaves.map((leaf) => Buffer.from(sha256Hex(asLeafHash(leaf)), 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      next.push(Buffer.from(sha256Hex(Buffer.concat([left, right])), 'hex'));
    }
    level = next;
  }
  return level[0].toString('hex');
}

function evaluatePolynomial(coefficients, x_value, modulus = null) {
  if (!Array.isArray(coefficients) || coefficients.length === 0) {
    throw new Error('math.polynomial requires at least one coefficient');
  }
  let result = 0n;
  const x = BigInt(Math.floor(Number(x_value)));
  const m = modulus ? BigInt(modulus) : null;

  for (const coefficient of coefficients) {
    const c = BigInt(Math.floor(Number(coefficient)));
    result = result * x + c;
    if (m !== null) {
      result = ((result % m) + m) % m;
    }
  }
  return result.toString();
}

function verifyRSASignature(publicKeyPem, signatureHex, payloadString) {
  try {
    const verify = createVerify('RSA-SHA256');
    verify.update(payloadString);
    verify.end();
    return verify.verify(publicKeyPem, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

function normalizeHexString(value, fieldName) {
  const raw = trimString(value);
  if (!raw) throw new Error(`${fieldName} is required`);
  const normalized = raw.startsWith('0x') ? raw.toLowerCase() : `0x${raw.toLowerCase()}`;
  if (!/^0x[0-9a-f]+$/i.test(normalized)) {
    throw new Error(`${fieldName} must be a hex string`);
  }
  return normalized;
}

function normalizeScalarString(value, fieldName) {
  const raw = trimString(value);
  if (!raw) throw new Error(`${fieldName} is required`);
  return raw;
}

function normalizePublicSignals(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value === undefined || value === null) return [];
  throw new Error('public_signals must be an array');
}

function resolveZkpVerifyMaxInputBytes() {
  return resolveMaxBytes(
    env('COMPUTE_MAX_ZKP_VERIFY_INPUT_BYTES', 'MORPHEUS_MAX_ZKP_VERIFY_INPUT_BYTES'),
    DEFAULT_ZKP_VERIFY_MAX_INPUT_BYTES,
    4096
  );
}

function enforceZkpVerificationSizeLimit(payload) {
  enforceSerializedSizeLimit(payload, 'zkp verification input', resolveZkpVerifyMaxInputBytes());
}

function resolveZkpVerificationRuntime() {
  return (
    trimString(env('MORPHEUS_ZKP_VERIFY_RUNTIME', 'COMPUTE_ZKP_VERIFY_RUNTIME')).toLowerCase() ||
    'disabled'
  );
}

function resolveZkpVerifyTimeoutMs() {
  return parseDurationMs(
    env('MORPHEUS_ZKP_VERIFY_TIMEOUT_MS', 'COMPUTE_ZKP_VERIFY_TIMEOUT_MS'),
    DEFAULT_ZKP_VERIFY_TIMEOUT_MS
  );
}

function resolveSnarkjsCommand() {
  const command = trimString(env('MORPHEUS_SNARKJS_BIN', 'COMPUTE_SNARKJS_BIN')) || 'snarkjs';
  if (command.includes('..')) {
    throw new Error('MORPHEUS_SNARKJS_BIN must not contain path traversal');
  }
  return command;
}

async function verifyGroth16ProofWithCli(verifyingKey, publicSignals, proof) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'morpheus-groth16-'));
  try {
    const verifyingKeyPath = path.join(tempDir, 'verifying-key.json');
    const publicSignalsPath = path.join(tempDir, 'public-signals.json');
    const proofPath = path.join(tempDir, 'proof.json');
    await Promise.all([
      writeFile(verifyingKeyPath, JSON.stringify(verifyingKey)),
      writeFile(publicSignalsPath, JSON.stringify(publicSignals)),
      writeFile(proofPath, JSON.stringify(proof)),
    ]);

    try {
      await execFile(
        resolveSnarkjsCommand(),
        ['groth16', 'verify', verifyingKeyPath, publicSignalsPath, proofPath],
        { timeout: resolveZkpVerifyTimeoutMs(), maxBuffer: 1024 * 1024 }
      );
      return true;
    } catch (error) {
      if (typeof error?.code === 'number' && Number.isFinite(error.code)) return false;
      throw new Error(`groth16 verifier runtime failed: ${error?.message || error}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function verifyGroth16Proof(verifyingKey, publicSignals, proof) {
  enforceZkpVerificationSizeLimit({
    verifying_key: verifyingKey,
    public_signals: publicSignals,
    proof,
  });
  const runtime = resolveZkpVerificationRuntime();
  if (runtime !== 'cli') {
    throw new Error(
      'groth16 verification runtime disabled; set MORPHEUS_ZKP_VERIFY_RUNTIME=cli to enable explicit external verification'
    );
  }
  return verifyGroth16ProofWithCli(verifyingKey, publicSignals, proof);
}

function normalizeZerc20SingleWithdrawStatement(input = {}) {
  const source =
    input.public_inputs && typeof input.public_inputs === 'object' ? input.public_inputs : input;
  return {
    recipient: normalizeHexString(source.recipient, 'recipient'),
    withdraw_value: normalizeScalarString(
      source.withdraw_value ?? source.withdrawValue,
      'withdraw_value'
    ),
    tree_root: normalizeHexString(source.tree_root ?? source.treeRoot, 'tree_root'),
    path_indices: normalizeHexString(source.path_indices ?? source.pathIndices, 'path_indices'),
    blacklisted_root: normalizeHexString(
      source.blacklisted_root ?? source.blacklistedRoot,
      'blacklisted_root'
    ),
  };
}

function compareExpected(label, actual, expected) {
  if (expected === undefined || expected === null || trimString(expected) === '') {
    return { checked: false, ok: true, actual };
  }
  const normalizedExpected = label.includes('value')
    ? normalizeScalarString(expected, label)
    : normalizeHexString(expected, label);
  return {
    checked: true,
    ok: actual === normalizedExpected,
    actual,
    expected: normalizedExpected,
  };
}

async function verifyZerc20SingleWithdraw(input = {}) {
  const statement = normalizeZerc20SingleWithdrawStatement(input);
  const publicSignals = normalizePublicSignals(
    input.public_signals ??
      input.publicSignals ?? [
        statement.recipient,
        statement.withdraw_value,
        statement.tree_root,
        statement.path_indices,
        statement.blacklisted_root,
      ]
  );

  const checks = {
    recipient: compareExpected(
      'expected_recipient',
      statement.recipient,
      input.expected_recipient ?? input.expectedRecipient
    ),
    withdraw_value: compareExpected(
      'expected_withdraw_value',
      statement.withdraw_value,
      input.expected_withdraw_value ?? input.expectedWithdrawValue
    ),
    tree_root: compareExpected(
      'expected_tree_root',
      statement.tree_root,
      input.expected_tree_root ?? input.expectedTreeRoot
    ),
    path_indices: compareExpected(
      'expected_path_indices',
      statement.path_indices,
      input.expected_path_indices ?? input.expectedPathIndices
    ),
    blacklisted_root: compareExpected(
      'expected_blacklisted_root',
      statement.blacklisted_root,
      input.expected_blacklisted_root ?? input.expectedBlacklistedRoot
    ),
  };

  let proofVerified = null;
  if (input.verifying_key || input.verifyingKey) {
    const proof = input.proof;
    if (!proof || typeof proof !== 'object') {
      throw new Error('proof object is required when verifying_key is supplied');
    }
    enforceZkpVerificationSizeLimit({
      verifying_key: input.verifying_key ?? input.verifyingKey,
      public_signals: publicSignals,
      proof,
    });
    proofVerified = await verifyGroth16Proof(
      input.verifying_key ?? input.verifyingKey,
      publicSignals,
      proof
    );
  } else {
    throw new Error('verifying_key is required for zERC20 proof verification');
  }

  const statementsMatch = Object.values(checks).every((entry) => entry.ok);
  const result = {
    statement,
    public_signals: publicSignals,
    statement_hash: sha256Hex(stableStringify(statement)),
    checks,
    proof_verified: proofVerified,
    is_valid: statementsMatch && (proofVerified === null || proofVerified === true),
  };
  return result;
}

export const BUILTIN_COMPUTE_CATALOG = [
  {
    name: 'hash.sha256',
    category: 'hash',
    description: 'Hashes any JSON-serializable payload with SHA-256.',
  },
  {
    name: 'hash.keccak256',
    category: 'hash',
    description: 'Hashes any JSON-serializable payload with Keccak-256.',
  },
  {
    name: 'crypto.rsa_verify',
    category: 'crypto',
    description: 'Verifies an RSA-SHA256 signature (expensive on-chain).',
  },
  {
    name: 'math.modexp',
    category: 'math',
    description: 'Performs big integer modular exponentiation.',
  },
  {
    name: 'math.polynomial',
    category: 'math',
    description: 'Evaluates a polynomial of arbitrary degree.',
  },
  {
    name: 'matrix.multiply',
    category: 'linear_algebra',
    description: 'Multiplies two dense matrices.',
  },
  {
    name: 'vector.cosine_similarity',
    category: 'linear_algebra',
    description: 'Computes cosine similarity between two vectors.',
  },
  {
    name: 'merkle.root',
    category: 'merkle',
    description: 'Builds a SHA-256 Merkle root from a list of leaves.',
  },
  {
    name: 'zkp.public_signal_hash',
    category: 'zkp',
    description: 'Computes a deterministic digest over public signals.',
  },
  {
    name: 'zkp.proof_digest',
    category: 'zkp',
    description: 'Computes a deterministic digest over a proof object.',
  },
  {
    name: 'zkp.witness_digest',
    category: 'zkp',
    description: 'Computes a digest over witness material before proving.',
  },
  {
    name: 'zkp.groth16.verify',
    category: 'zkp',
    description: 'Verifies a Groth16 proof against a verifying key and public signals.',
  },
  {
    name: 'zkp.groth16.prove.plan',
    category: 'zkp',
    description: 'Returns a planning estimate for Groth16 proving workloads.',
  },
  {
    name: 'zkp.plonk.prove.plan',
    category: 'zkp',
    description: 'Returns a planning estimate for PLONK proving workloads.',
  },
  {
    name: 'zkp.zerc20.single_withdraw.verify',
    category: 'zkp',
    description:
      'Verifies zERC20 single-withdraw public inputs and optionally checks a Groth16 proof.',
  },
  { name: 'fhe.batch_plan', category: 'fhe', description: 'Builds a ciphertext batching plan.' },
  {
    name: 'fhe.noise_budget_estimate',
    category: 'fhe',
    description: 'Estimates a rough FHE noise budget.',
  },
  {
    name: 'fhe.rotation_plan',
    category: 'fhe',
    description: 'Returns a rotation/key-switch planning summary.',
  },
  {
    name: 'privacy.mask',
    category: 'privacy',
    description: 'Masks a sensitive string, leaving edges visible.',
  },
  {
    name: 'privacy.add_noise',
    category: 'privacy',
    description:
      'Adds illustrative Laplace noise. Demonstration only — not a calibrated differential-privacy mechanism (no privacy budget / sensitivity accounting).',
  },
];

export function listBuiltinComputeFunctions() {
  return BUILTIN_COMPUTE_CATALOG;
}

export async function executeBuiltinCompute(payload) {
  const fn = trimString(payload.function || payload.compute_fn);
  const input = payload.input ?? payload.compute_args ?? {};
  enforceBuiltinComputeLimits(fn, input);
  switch (fn) {
    case 'hash.sha256':
      return { function: fn, result: { digest: sha256Hex(stableStringify(input)) } };
    case 'hash.keccak256':
      return { function: fn, result: { digest: keccak256(toUtf8Bytes(stableStringify(input))) } };
    case 'crypto.rsa_verify':
      return {
        function: fn,
        result: { is_valid: verifyRSASignature(input.public_key, input.signature, input.payload) },
      };
    case 'math.modexp':
      return {
        function: fn,
        result: { value: bigintPowMod(input.base, input.exponent, input.modulus).toString() },
      };
    case 'math.polynomial':
      return {
        function: fn,
        result: { value: evaluatePolynomial(input.coefficients, input.x, input.modulus) },
      };
    case 'matrix.multiply':
      return { function: fn, result: { matrix: multiplyMatrices(input.left, input.right) } };
    case 'vector.cosine_similarity':
      return { function: fn, result: { similarity: cosineSimilarity(input.left, input.right) } };
    case 'merkle.root':
      return { function: fn, result: { root: merkleRoot(input.leaves || []) } };
    case 'zkp.public_signal_hash':
      return {
        function: fn,
        result: {
          digest: sha256Hex(
            stableStringify({ circuit_id: input.circuit_id || null, signals: input.signals || [] })
          ),
        },
      };
    case 'zkp.proof_digest':
      return {
        function: fn,
        result: {
          digest: sha256Hex(
            stableStringify({
              proof: input.proof || input,
              verifying_key: input.verifying_key || null,
            })
          ),
        },
      };
    case 'zkp.witness_digest':
      return {
        function: fn,
        result: {
          digest: sha256Hex(
            stableStringify({
              witness: input.witness || input,
              circuit_id: input.circuit_id || null,
            })
          ),
        },
      };
    case 'zkp.groth16.verify': {
      // Resolve the verifying key + normalized public signals ONCE and reuse them.
      // normalizePublicSignals maps over the entire signals array, so evaluating it
      // (and the ?? alias resolution) more than once was needless work on this hot ZK
      // path; it is pure and idempotent, so a single call is behavior-identical.
      //
      // The size-limit check is NOT repeated here: verifyGroth16Proof enforces it
      // internally (index.js:264), so an explicit pre-check would run it twice.
      // normalizePublicSignals still runs before the size-limit (inside
      // verifyGroth16Proof), preserving the original throw-order.
      const verifyingKey = input.verifying_key ?? input.verifyingKey;
      const publicSignals = normalizePublicSignals(input.public_signals ?? input.publicSignals);
      return {
        function: fn,
        result: {
          is_valid: await verifyGroth16Proof(verifyingKey, publicSignals, input.proof),
        },
      };
    }
    case 'zkp.groth16.prove.plan': {
      const constraints = Number(input.constraints || 0);
      const witnessCount = Number(input.witness_count || input.witnessCount || 0);
      return {
        function: fn,
        result: {
          constraints,
          witness_count: witnessCount,
          estimated_segments: Math.max(Math.ceil(constraints / 50000), 1),
          estimated_memory_mb: Math.max(Math.ceil((constraints + witnessCount) / 25000), 1),
        },
      };
    }
    case 'zkp.plonk.prove.plan': {
      const gates = Number(input.gates || 0);
      return {
        function: fn,
        result: {
          gates,
          estimated_polynomials: Math.max(Math.ceil(gates / 65536), 1),
          estimated_memory_mb: Math.max(Math.ceil(gates / 30000), 1),
        },
      };
    }
    case 'zkp.zerc20.single_withdraw.verify':
      return { function: fn, result: await verifyZerc20SingleWithdraw(input) };
    case 'fhe.batch_plan': {
      const slotCount = Number(input.slot_count || input.slotCount || 0);
      const ciphertextCount = Number(input.ciphertext_count || input.ciphertextCount || 0);
      const slotsPerCiphertext =
        slotCount > 0 && ciphertextCount > 0 ? Math.ceil(slotCount / ciphertextCount) : slotCount;
      return {
        function: fn,
        result: {
          slot_count: slotCount,
          ciphertext_count: ciphertextCount,
          slots_per_ciphertext: slotsPerCiphertext,
        },
      };
    }
    case 'fhe.noise_budget_estimate': {
      const multiplicativeDepth = Number(
        input.multiplicative_depth || input.multiplicativeDepth || 1
      );
      const scaleBits = Number(input.scale_bits || input.scaleBits || 40);
      const modulusBits = Number(input.modulus_bits || input.modulusBits || 218);
      const estimatedNoiseBudget = Math.max(modulusBits - multiplicativeDepth * scaleBits, 0);
      return {
        function: fn,
        result: {
          multiplicative_depth: multiplicativeDepth,
          scale_bits: scaleBits,
          modulus_bits: modulusBits,
          estimated_noise_budget: estimatedNoiseBudget,
        },
      };
    }
    case 'fhe.rotation_plan': {
      const indices = Array.isArray(input.indices)
        ? input.indices.map((value) => Number(value))
        : [];
      return {
        function: fn,
        result: {
          indices,
          unique_rotations: [...new Set(indices)].sort((a, b) => a - b),
          key_switch_steps: indices.length,
        },
      };
    }
    case 'privacy.mask':
      return {
        function: fn,
        result: { masked: maskString(input.value, input.unmasked_left, input.unmasked_right) },
      };
    case 'privacy.add_noise':
      return { function: fn, result: { noisy_value: addLaplaceNoise(input.value, input.scale) } };
    default:
      throw new Error(`unknown builtin compute function: ${fn}`);
  }
}

async function executeStandaloneCompute(payload) {
  const maxInputBytes = resolveMaxBytes(env('COMPUTE_MAX_INPUT_BYTES'), 64 * 1024, 1024);
  const wasmModuleBase64 = resolveWasmModuleBase64(payload);
  if (wasmModuleBase64) {
    // SECURITY (S1): WASM execution is user-supplied code just like scripts and
    // must be gated behind the same opt-in switch (default off). Also bound the
    // decoded module size so a module cannot OOM the child via linear memory.
    assertUntrustedScriptsEnabled();
    assertWasmModuleSizeAllowed(wasmModuleBase64);
    enforceSerializedSizeLimit(payload.input ?? {}, 'compute input', maxInputBytes);
    const entryPoint =
      trimString(payload.wasm_entry || payload.wasm_entry_point || payload.entry_point || 'run') ||
      'run';
    const timeoutMs = cappedDurationMs(
      payload.wasm_timeout_ms ||
        payload.script_timeout_ms ||
        payload.compute_timeout_ms ||
        env('COMPUTE_WASM_TIMEOUT_MS', 'MORPHEUS_WASM_TIMEOUT_MS') ||
        10_000,
      10_000,
      10_000
    );
    return {
      runtime: 'wasm',
      entry_point: entryPoint,
      result: await runWasmWithTimeout({
        mode: 'compute',
        moduleBase64: wasmModuleBase64,
        entryPoint,
        input: { input: payload.input ?? {} },
        timeoutMs,
      }),
    };
  }

  const script = await resolveScriptSource(payload);
  if (!script) {
    throw new Error('script or script_base64 required');
  }
  assertUntrustedScriptsEnabled();
  validateUserScriptSource(script);
  enforceSerializedSizeLimit(payload.input ?? {}, 'compute input', maxInputBytes);

  const entryPoint = trimString(payload.entry_point || 'process') || 'process';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entryPoint)) {
    throw new Error('entry point must be a valid identifier');
  }
  const timeoutMs = cappedDurationMs(
    payload.script_timeout_ms || payload.compute_timeout_ms || env('COMPUTE_SCRIPT_TIMEOUT_MS'),
    2000,
    10_000
  );

  return {
    runtime: 'script',
    entry_point: entryPoint,
    result: await runScriptWithTimeout({
      mode: 'compute',
      script,
      entryPoint,
      input: payload.input ?? {},
      timeoutMs,
    }),
  };
}

export async function handleComputeExecute(payload) {
  try {
    const resolvedPayload = await resolveConfidentialPayload(payload);
    const mode =
      trimString(
        resolvedPayload.mode ||
          (resolvedPayload.function || resolvedPayload.compute_fn ? 'builtin' : 'script')
      ) || 'script';
    const result =
      mode === 'builtin'
        ? await executeBuiltinCompute(resolvedPayload)
        : await executeStandaloneCompute(resolvedPayload);
    const signed = await buildSignedResultEnvelope(result, resolvedPayload);
    // signed.tee_attestation already binds sha256(stableStringify(result)) (computed once
    // inside buildSignedResultEnvelope via output_hash). Reuse it rather than calling the
    // 8787 /attest endpoint a second time with the same report_data.
    return json(200, {
      mode,
      target_chain: resolvedPayload.target_chain
        ? normalizeTargetChain(resolvedPayload.target_chain)
        : 'neo_n3',
      target_chain_id: resolvedPayload.target_chain_id
        ? String(resolvedPayload.target_chain_id)
        : null,
      ...result,
      // D5 canonical signed-result envelope (output_hash + signature + public_key
      // + attestation_hash + tee_attestation + verification) — single-sourced.
      ...buildLaneSignedEnvelope(signed),
    });
  } catch (error) {
    return jsonError(400, error);
  }
}

export function handleComputeFunctions() {
  const functions = listBuiltinComputeFunctions();
  return json(200, { functions, names: functions.map((item) => item.name) });
}

export function handleComputeJobs(jobId = null) {
  if (jobId) {
    return json(200, {
      id: jobId,
      status: 'completed',
      mode: 'morpheus-compute',
      result: null,
      note: 'Job detail response served by the Morpheus compute module.',
    });
  }

  return json(200, {
    jobs: [],
    mode: 'morpheus-compute',
    note: 'Morpheus compute exposes built-in and script-driven off-chain functions from the same trusted worker runtime.',
  });
}
