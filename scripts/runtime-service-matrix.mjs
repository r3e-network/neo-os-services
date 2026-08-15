import { trimString } from './lib-strings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, parseDotEnv } from './lib-env.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE_ENVELOPE_ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM';
const ORACLE_ENVELOPE_INFO = 'morpheus-confidential-payload-v2';
const AES_GCM_TAG_LENGTH_BYTES = 16;

function hash160(seed) {
  const text = String(seed || '')
    .padEnd(40, '0')
    .slice(0, 40);
  return `0x${text}`;
}

function hash32(seed) {
  const text = String(seed || '')
    .padEnd(64, '1')
    .slice(0, 64);
  return `0x${text}`;
}

function requestId(prefix) {
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function uniqueHash32(prefix) {
  return `0x${createHash('sha256').update(requestId(prefix)).digest('hex')}`;
}

function computePayload(computeFunction, input) {
  return {
    mode: 'builtin',
    function: computeFunction,
    target_chain: 'neo_n3',
    request_id: requestId(`compute:${computeFunction}`),
    input,
  };
}

function baseProbe({
  id,
  serviceClass,
  capabilityFeature,
  method = 'POST',
  path: probePath,
  auth = true,
  payload = {},
  expectedStatuses = [200],
  requiredFields = [],
  expectation = 'positive',
  computeFunction = null,
  description,
}) {
  return {
    id,
    serviceClass,
    capabilityFeature,
    method,
    path: probePath,
    auth,
    payload,
    expectedStatuses,
    requiredFields,
    expectation,
    computeFunction,
    description,
  };
}

const RECOVERY_PAYLOAD = {
  provider: 'twitter',
  provider_uid: 'runtime-recovery-user',
  network: 'neo_n3',
  aa_contract: hash160('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  verifier_contract: hash160('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
  account_address: hash160('cccccccccccccccccccccccccccccccccccccccc'),
  account_id: 'runtime-account-1',
  new_owner: hash160('dddddddddddddddddddddddddddddddddddddddd'),
  recovery_nonce: '1',
  expires_at: '4102444800',
};

export const RUNTIME_SERVICE_MATRIX = [
  baseProbe({
    id: 'runtime:health',
    serviceClass: 'runtime',
    capabilityFeature: null,
    method: 'GET',
    path: '/health',
    auth: false,
    requiredFields: ['status'],
    description: 'Public runtime health and capability discovery.',
  }),
  baseProbe({
    id: 'runtime:info',
    serviceClass: 'runtime',
    capabilityFeature: null,
    method: 'GET',
    path: '/info',
    auth: true,
    requiredFields: ['dstack', 'overload'],
    description: 'Public runtime dstack and overload state.',
  }),
  baseProbe({
    id: 'runtime:attestation',
    serviceClass: 'runtime',
    capabilityFeature: null,
    method: 'GET',
    path: '/attestation?report_data=runtime-service-matrix',
    auth: false,
    requiredFields: ['attestation'],
    description: 'TEE attestation endpoint.',
  }),
  baseProbe({
    id: 'keys:derived',
    serviceClass: 'runtime',
    capabilityFeature: 'keys/derived',
    path: '/keys/derived',
    payload: { role: 'worker' },
    expectedStatuses: [200, 400],
    expectation: 'optional_tee',
    description: 'Dstack-derived worker key summary; may fail closed outside TEE.',
  }),
  baseProbe({
    id: 'providers:list',
    serviceClass: 'datafeed',
    capabilityFeature: 'providers',
    path: '/providers',
    requiredFields: ['providers'],
    description: 'Provider catalog.',
  }),
  baseProbe({
    id: 'oracle:public-key',
    serviceClass: 'privacy_oracle',
    capabilityFeature: 'oracle/public-key',
    path: '/oracle/public-key',
    requiredFields: ['public_key', 'algorithm'],
    description: 'X25519 public key for confidential payload encryption.',
  }),
  baseProbe({
    id: 'oracle:heartbeat',
    serviceClass: 'privacy_oracle',
    capabilityFeature: 'oracle/heartbeat',
    path: '/oracle/heartbeat',
    requiredFields: ['status', 'providers', 'timestamp'],
    description: 'Oracle provider health heartbeat.',
  }),
  baseProbe({
    id: 'feeds:catalog',
    serviceClass: 'datafeed',
    capabilityFeature: 'feeds/catalog',
    path: '/feeds/catalog',
    requiredFields: ['pairs'],
    description: 'Supported price feed catalog.',
  }),
  baseProbe({
    id: 'feeds:price',
    serviceClass: 'datafeed',
    capabilityFeature: 'feeds/price',
    path: '/feeds/price',
    payload: { symbol: 'NEO-USD', provider: 'twelvedata' },
    description: 'Price feed query by body.',
  }),
  baseProbe({
    id: 'feeds:price-symbol',
    serviceClass: 'datafeed',
    capabilityFeature: 'feeds/price/:symbol',
    path: '/feeds/price/NEO-USD',
    payload: { provider: 'twelvedata' },
    description: 'Price feed query by route parameter.',
  }),
  baseProbe({
    id: 'oracle:query',
    serviceClass: 'privacy_oracle',
    capabilityFeature: 'oracle/query',
    path: '/oracle/query',
    payload: {
      request_id: requestId('oracle:query'),
      target_chain: 'neo_n3',
      provider: 'twelvedata',
      symbol: 'NEO-USD',
      json_path: 'price',
    },
    requiredFields: ['verification'],
    description: 'Privacy oracle provider fetch.',
  }),
  baseProbe({
    id: 'oracle:smart-fetch',
    serviceClass: 'privacy_oracle',
    capabilityFeature: 'oracle/smart-fetch',
    path: '/oracle/smart-fetch',
    payload: {
      request_id: requestId('oracle:smart-fetch'),
      target_chain: 'neo_n3',
      provider: 'twelvedata',
      symbol: 'NEO-USD',
      json_path: 'price',
      script: 'function process(value){ return value.price || value.extracted_value || value; }',
    },
    requiredFields: ['verification'],
    description: 'Programmable privacy oracle smart fetch.',
  }),
  baseProbe({
    id: 'oracle:confidential-query',
    serviceClass: 'privacy_oracle',
    capabilityFeature: 'oracle/query',
    path: '/oracle/query',
    payload: async (ctx) => ({
      request_id: requestId('oracle:confidential-query'),
      target_chain: 'neo_n3',
      encrypted_params: await encryptForOracle(ctx.oraclePublicKey, {
        provider: 'twelvedata',
        symbol: 'NEO-USD',
        json_path: 'price',
      }),
    }),
    requiredFields: ['verification'],
    description: 'Confidential encrypted privacy oracle query.',
  }),
  baseProbe({
    id: 'oracle:decrypt',
    serviceClass: 'privacy_oracle',
    capabilityFeature: 'oracle/decrypt',
    path: '/oracle/decrypt',
    payload: {
      envelope: 'bm90LWEtdmFsaWQtc2VhbGVkLWVudmVsb3Bl',
    },
    expectedStatuses: [400],
    expectation: 'fail_closed',
    description: 'Confidential decrypt lane rejects envelopes not sealed to the oracle key.',
  }),
  baseProbe({
    id: 'oracle:message-reveal',
    serviceClass: 'privacy_oracle',
    capabilityFeature: 'oracle/message-reveal',
    path: '/oracle/message-reveal',
    payload: {
      chain: 'neox',
      messageId: '1',
    },
    expectedStatuses: [400],
    expectation: 'fail_closed',
    description: 'Recipient message reveal rejects requests without a recipient signature.',
  }),
  baseProbe({
    id: 'oracle:feed',
    serviceClass: 'datafeed',
    capabilityFeature: 'oracle/feed',
    path: '/oracle/feed',
    payload: {
      action: 'oracle_feed',
      request_id: requestId('oracle:feed'),
      target_chain: 'neo_n3',
      provider: 'twelvedata',
      symbols: ['NEO-USD'],
      wait: false,
      refresh_onchain_baseline: false,
    },
    expectedStatuses: [200, 202],
    requiredFields: ['mode'],
    description: 'Non-blocking signed datafeed publication request.',
  }),
  baseProbe({
    id: 'vrf:random',
    serviceClass: 'randomness',
    capabilityFeature: 'vrf/random',
    path: '/vrf/random',
    payload: { request_id: requestId('vrf:random'), target_chain: 'neo_n3' },
    requiredFields: ['randomness', 'verification'],
    description: 'Signed randomness / VRF service.',
  }),
  baseProbe({
    id: 'session:start',
    serviceClass: 'game_session',
    capabilityFeature: 'session/start',
    path: '/session/start',
    payload: {
      app_id: 'miniapp-sudoku',
      network: 'testnet',
      contract_hash: '0xc75b181b4561462903bb27d8d9e0b32b637bec12',
      player: '0x13ef519c362973f9a34648a9eac5b71250b2a80a',
      game_id: '1',
      difficulty: 0,
    },
    requiredFields: ['commitment', 'public_key', 'view', 'session_token', 'config'],
    description: 'TEE game session start (deal view + commitment + session token).',
  }),
  baseProbe({
    id: 'session:step',
    serviceClass: 'game_session',
    capabilityFeature: 'session/step',
    path: '/session/step',
    payload: {
      app_id: 'miniapp-sudoku',
      network: 'testnet',
      contract_hash: '0xc75b181b4561462903bb27d8d9e0b32b637bec12',
      player: '0x13ef519c362973f9a34648a9eac5b71250b2a80a',
      game_id: '1',
      difficulty: 0,
      session_token: 'runtime-matrix-invalid-token',
      seq: 0,
      op: { type: 'move', direction: 'left' },
    },
    expectedStatuses: [200, 401],
    description: 'Session step; an invalid token must 401 (proves the route and token gate).',
  }),
  baseProbe({
    id: 'session:finalize',
    serviceClass: 'game_session',
    capabilityFeature: 'session/finalize',
    path: '/session/finalize',
    payload: {
      app_id: 'miniapp-sudoku',
      network: 'testnet',
      contract_hash: '0xc75b181b4561462903bb27d8d9e0b32b637bec12',
      player: '0x13ef519c362973f9a34648a9eac5b71250b2a80a',
      game_id: '1',
      difficulty: 0,
      session_token: 'runtime-matrix-invalid-token',
      op_log: [],
    },
    expectedStatuses: [200, 401],
    description: 'Session finalize; an invalid token must 401 (proves the route and token gate).',
  }),
  baseProbe({
    id: 'compute:functions',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/functions',
    path: '/compute/functions',
    requiredFields: ['functions', 'names'],
    description: 'Built-in compute catalog.',
  }),
  baseProbe({
    id: 'compute:hash.sha256',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('hash.sha256', { data: 'morpheus' }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'hash.sha256',
    description: 'SHA-256 built-in compute.',
  }),
  baseProbe({
    id: 'compute:hash.keccak256',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('hash.keccak256', { data: 'morpheus' }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'hash.keccak256',
    description: 'Keccak-256 built-in compute.',
  }),
  baseProbe({
    id: 'compute:crypto.rsa_verify',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('crypto.rsa_verify', {
      public_key: 'not-a-valid-rsa-key',
      signature: '00',
      payload: 'morpheus',
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'crypto.rsa_verify',
    description: 'RSA verification fail-closed compute path.',
  }),
  baseProbe({
    id: 'compute:math.modexp',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('math.modexp', { base: '2', exponent: '10', modulus: '17' }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'math.modexp',
    description: 'Modular exponentiation compute.',
  }),
  baseProbe({
    id: 'compute:math.polynomial',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('math.polynomial', {
      coefficients: [2, 3, 4],
      x: 5,
      modulus: 97,
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'math.polynomial',
    description: 'Polynomial evaluation compute.',
  }),
  baseProbe({
    id: 'compute:matrix.multiply',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('matrix.multiply', {
      left: [
        [1, 2],
        [3, 4],
      ],
      right: [
        [5, 6],
        [7, 8],
      ],
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'matrix.multiply',
    description: 'Matrix multiplication compute.',
  }),
  baseProbe({
    id: 'compute:vector.cosine_similarity',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('vector.cosine_similarity', { left: [1, 0, 1], right: [0, 1, 1] }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'vector.cosine_similarity',
    description: 'Vector similarity compute.',
  }),
  baseProbe({
    id: 'compute:merkle.root',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('merkle.root', { leaves: ['a', 'b', 'c'] }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'merkle.root',
    description: 'Merkle root compute.',
  }),
  baseProbe({
    id: 'compute:zkp.public_signal_hash',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('zkp.public_signal_hash', {
      circuit_id: process.env.MORPHEUS_RUNTIME_MATRIX_CIRCUIT_ID || 'configured-circuit',
      signals: ['1', '2'],
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'zkp.public_signal_hash',
    description: 'ZKP public signal hashing.',
  }),
  baseProbe({
    id: 'compute:zkp.proof_digest',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('zkp.proof_digest', { proof: { pi_a: ['1', '2'] } }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'zkp.proof_digest',
    description: 'ZKP proof digest.',
  }),
  baseProbe({
    id: 'compute:zkp.witness_digest',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('zkp.witness_digest', {
      circuit_id: process.env.MORPHEUS_RUNTIME_MATRIX_CIRCUIT_ID || 'configured-circuit',
      witness: { secret: 'redacted' },
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'zkp.witness_digest',
    description: 'ZKP witness digest.',
  }),
  baseProbe({
    id: 'compute:zkp.groth16.verify',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('zkp.groth16.verify', {
      verifying_key: { protocol: 'groth16' },
      public_signals: ['1'],
      proof: { pi_a: ['1', '2'] },
    }),
    expectedStatuses: [400],
    expectation: 'fail_closed',
    computeFunction: 'zkp.groth16.verify',
    description: 'Groth16 verification remains disabled unless explicit runtime is configured.',
  }),
  baseProbe({
    id: 'compute:zkp.groth16.prove.plan',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('zkp.groth16.prove.plan', {
      constraints: 120000,
      witness_count: 8000,
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'zkp.groth16.prove.plan',
    description: 'Groth16 proving resource plan.',
  }),
  baseProbe({
    id: 'compute:zkp.plonk.prove.plan',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('zkp.plonk.prove.plan', { gates: 90000 }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'zkp.plonk.prove.plan',
    description: 'PLONK proving resource plan.',
  }),
  baseProbe({
    id: 'compute:zkp.zerc20.single_withdraw.verify',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('zkp.zerc20.single_withdraw.verify', {
      // The live public runtime API supports skipping Groth16 proof verification for
      // statement-shape validation flows. The hourly matrix runs without a real
      // proving key/proof, so validate the request contract using this switch.
      skip_proof_verification: true,
      recipient: hash160('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
      withdraw_value: '100',
      tree_root: hash32('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      path_indices: hash32('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
      blacklisted_root: hash32('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'),
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'zkp.zerc20.single_withdraw.verify',
    description: 'zERC20 privacy withdrawal public input verification.',
  }),
  baseProbe({
    id: 'compute:fhe.batch_plan',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('fhe.batch_plan', { slot_count: 1024, ciphertext_count: 8 }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'fhe.batch_plan',
    description: 'FHE batching plan.',
  }),
  baseProbe({
    id: 'compute:fhe.noise_budget_estimate',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('fhe.noise_budget_estimate', {
      multiplicative_depth: 3,
      scale_bits: 40,
      modulus_bits: 218,
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'fhe.noise_budget_estimate',
    description: 'FHE noise budget estimate.',
  }),
  baseProbe({
    id: 'compute:fhe.rotation_plan',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('fhe.rotation_plan', { indices: [1, 2, 4, 2] }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'fhe.rotation_plan',
    description: 'FHE rotation plan.',
  }),
  baseProbe({
    id: 'compute:privacy.mask',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('privacy.mask', {
      value: 'sensitive-account-id',
      unmasked_left: 3,
      unmasked_right: 2,
    }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'privacy.mask',
    description: 'Privacy masking compute.',
  }),
  baseProbe({
    id: 'compute:privacy.add_noise',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: computePayload('privacy.add_noise', { value: 42, scale: 0.5 }),
    requiredFields: ['result', 'verification'],
    computeFunction: 'privacy.add_noise',
    description: 'Differential privacy noise compute.',
  }),
  baseProbe({
    id: 'compute:confidential-mask',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/execute',
    path: '/compute/execute',
    payload: async (ctx) => ({
      request_id: requestId('compute:confidential-mask'),
      target_chain: 'neo_n3',
      encrypted_params: await encryptForOracle(ctx.oraclePublicKey, {
        mode: 'builtin',
        function: 'privacy.mask',
        input: { value: 'confidential-value', unmasked_left: 2, unmasked_right: 2 },
      }),
    }),
    requiredFields: ['result', 'verification'],
    description: 'Confidential encrypted compute payload.',
  }),
  baseProbe({
    id: 'compute:jobs',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/jobs',
    path: '/compute/jobs',
    requiredFields: ['jobs', 'mode'],
    description: 'Compute job list.',
  }),
  baseProbe({
    id: 'compute:jobs-id',
    serviceClass: 'privacy_compute',
    capabilityFeature: 'compute/jobs/:id',
    path: '/compute/jobs/runtime-matrix',
    requiredFields: ['id', 'status'],
    description: 'Compute job detail route.',
  }),
  baseProbe({
    id: 'neodid:providers',
    serviceClass: 'neodid',
    capabilityFeature: 'neodid/providers',
    path: '/neodid/providers',
    requiredFields: ['providers'],
    description: 'NeoDID provider catalog.',
  }),
  baseProbe({
    id: 'neodid:runtime',
    serviceClass: 'neodid',
    capabilityFeature: 'neodid/runtime',
    path: '/neodid/runtime',
    requiredFields: ['service', 'supported_routes', 'request_types'],
    description: 'NeoDID runtime metadata.',
  }),
  baseProbe({
    id: 'neodid:bind',
    serviceClass: 'neodid',
    capabilityFeature: 'neodid/bind',
    path: '/neodid/bind',
    payload: {
      request_id: requestId('neodid:bind'),
      vault_account: hash160('1111111111111111111111111111111111111111'),
      provider: 'twitter',
      provider_uid: 'runtime-twitter-user',
      claim_type: 'Twitter_Verified',
      claim_value: 'true',
      metadata: { source: 'runtime-service-matrix' },
    },
    requiredFields: ['master_nullifier', 'digest', 'verification'],
    description: 'NeoDID private identity binding ticket.',
  }),
  baseProbe({
    id: 'neodid:action-ticket',
    serviceClass: 'neodid',
    capabilityFeature: 'neodid/action-ticket',
    path: '/neodid/action-ticket',
    payload: {
      request_id: requestId('neodid:action-ticket'),
      disposable_account: hash160('2222222222222222222222222222222222222222'),
      provider: 'github',
      provider_uid: 'runtime-github-user',
      action_id: 'runtime-action-1',
    },
    requiredFields: ['action_nullifier', 'digest', 'verification'],
    description: 'NeoDID single-use action ticket.',
  }),
  baseProbe({
    id: 'neodid:recovery-ticket',
    serviceClass: 'neodid',
    capabilityFeature: 'neodid/recovery-ticket',
    path: '/neodid/recovery-ticket',
    payload: {
      request_id: requestId('neodid:recovery-ticket'),
      ...RECOVERY_PAYLOAD,
    },
    requiredFields: ['master_nullifier', 'action_nullifier', 'verification'],
    description: 'NeoDID account recovery ticket.',
  }),
  baseProbe({
    id: 'neodid:zklogin-ticket',
    serviceClass: 'neodid',
    capabilityFeature: 'neodid/zklogin-ticket',
    path: '/neodid/zklogin-ticket',
    payload: {
      request_id: requestId('neodid:zklogin-ticket'),
      provider: 'web3auth',
      verifier_contract: hash160('3333333333333333333333333333333333333333'),
      account_id_hash: hash160('4444444444444444444444444444444444444444'),
      target_contract: hash160('5555555555555555555555555555555555555555'),
      method: 'executeUserOp',
      args_hash: hash32('6666666666666666666666666666666666666666666666666666666666666666'),
      nonce: '1',
      deadline: '4102444800',
    },
    expectedStatuses: [400],
    expectation: 'fail_closed',
    description: 'NeoDID zkLogin ticket fails closed without a verified Web3Auth id_token.',
  }),
  baseProbe({
    id: 'paymaster:authorize',
    serviceClass: 'paymaster',
    capabilityFeature: 'paymaster/authorize',
    path: '/paymaster/authorize',
    payload: (context) => {
      const operationHash = uniqueHash32(`paymaster:${context.network}`);
      return {
        network: context.network,
        target_chain: 'neo_n3',
        account_id: hash160('7777777777777777777777777777777777777777'),
        dapp_id: `runtime-service-matrix-${context.network}`,
        target_contract: hash160('8888888888888888888888888888888888888888'),
        method: 'executeUserOp',
        userop_target_contract: hash160('9999999999999999999999999999999999999999'),
        userop_method: 'symbol',
        estimated_gas_units: 1000,
        operation_hash: operationHash,
        idempotency_key: operationHash,
      };
    },
    requiredFields: ['mode', 'approved', 'verification'],
    description: 'AA paymaster authorization policy.',
  }),
  baseProbe({
    id: 'chain:sign-payload',
    serviceClass: 'chain_signing',
    capabilityFeature: 'sign/payload',
    path: '/sign/payload',
    payload: {
      target_chain: 'neo_n3',
      data_hex: '0x6d6f727068657573',
    },
    requiredFields: ['signature', 'public_key', 'payload_hash'],
    description: 'TEE-backed chain payload signing.',
  }),
  baseProbe({
    id: 'chain:relay-transaction',
    serviceClass: 'chain_signing',
    capabilityFeature: 'relay/transaction',
    path: '/relay/transaction',
    payload: {
      target_chain: 'neo_n3',
      raw_tx: '00',
    },
    expectedStatuses: [200, 400, 502],
    expectation: 'fail_closed',
    description: 'Relay transaction rejects malformed raw transaction without dead-routing.',
  }),
  baseProbe({
    id: 'chain:txproxy-invoke',
    serviceClass: 'chain_signing',
    capabilityFeature: 'txproxy/invoke',
    path: '/txproxy/invoke',
    payload: {
      target_chain: 'neo_n3',
      contract_hash: hash160('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      method: 'symbol',
    },
    expectedStatuses: [400, 403, 502],
    expectation: 'fail_closed',
    description: 'Tx proxy invocation fail-closed probe.',
  }),
];

function normalizeBaseUrl(value) {
  return trimString(value).replace(/\/$/, '');
}

function parseArgs(argv = []) {
  const args = {
    network: '',
    baseUrl: '',
    outputDir: path.resolve(repoRoot, 'docs', 'reports'),
    timeoutMs: 60000,
    maxLatencyMs: 10000,
    continueOnFailure: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--network' && next) args.network = next;
    else if (arg.startsWith('--network=')) args.network = arg.slice('--network='.length);
    else if (arg === '--base-url' && next) args.baseUrl = next;
    else if (arg.startsWith('--base-url=')) args.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--output-dir' && next) args.outputDir = path.resolve(next);
    else if (arg.startsWith('--output-dir='))
      args.outputDir = path.resolve(arg.slice('--output-dir='.length));
    else if (arg === '--timeout-ms' && next) args.timeoutMs = Number(next);
    else if (arg.startsWith('--timeout-ms='))
      args.timeoutMs = Number(arg.slice('--timeout-ms='.length));
    else if (arg === '--max-latency-ms' && next) args.maxLatencyMs = Number(next);
    else if (arg.startsWith('--max-latency-ms='))
      args.maxLatencyMs = Number(arg.slice('--max-latency-ms='.length));
    else if (arg === '--continue-on-failure') args.continueOnFailure = true;
  }
  return args;
}

function loadLocalEnv(filePath) {
  return fs
    .readFile(filePath, 'utf8')
    .then((raw) => parseDotEnv(raw))
    .catch(() => ({}));
}

async function resolveBaseUrlCandidates({ explicitBaseUrl, network, localEnvOverride } = {}) {
  if (trimString(explicitBaseUrl)) return [normalizeBaseUrl(explicitBaseUrl)];
  const localEnv = localEnvOverride ?? (await loadLocalEnv(path.resolve(repoRoot, '.env.local')));
  const candidates = [];
  const pushCandidate = (value) => {
    const normalized = normalizeBaseUrl(value);
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  const scoped =
    network === 'mainnet'
      ? localEnv.MORPHEUS_MAINNET_CUSTOM_DOMAIN
      : localEnv.MORPHEUS_TESTNET_CUSTOM_DOMAIN;
  if (trimString(scoped)) {
    const domain = trimString(scoped).replace(/^https?:\/\//, '');
    pushCandidate(`https://${domain}`);
  }
  const configPath = path.resolve(repoRoot, 'config', 'networks', `${network}.json`);
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const runtimeRegistry = config?.nitro;
    if (trimString(runtimeRegistry?.public_api_url)) {
      pushCandidate(runtimeRegistry.public_api_url);
    }
  } catch {}
  pushCandidate(`https://oracle.meshmini.app/${network === 'mainnet' ? 'mainnet' : 'testnet'}`);
  return candidates;
}

export async function __resolveBaseUrlCandidatesForTests(options = {}) {
  return resolveBaseUrlCandidates(options);
}

function resolveAuthToken() {
  return trimString(process.env.MORPHEUS_RUNTIME_TOKEN || '');
}

async function encryptForOracle(publicKeyBase64, plaintextObject) {
  const subtle = globalThis.crypto?.subtle || webcrypto.subtle;
  const recipientPublicKeyBytes = Buffer.from(publicKeyBase64, 'base64');
  const recipientKey = await subtle.importKey(
    'raw',
    recipientPublicKeyBytes,
    { name: 'X25519' },
    false,
    []
  );
  const ephemeralKeyPair = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const ephemeralPublicKeyBytes = new Uint8Array(
    await subtle.exportKey('raw', ephemeralKeyPair.publicKey)
  );
  const sharedSecret = new Uint8Array(
    await subtle.deriveBits(
      { name: 'X25519', public: recipientKey },
      ephemeralKeyPair.privateKey,
      256
    )
  );
  const keyMaterial = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  const info = new Uint8Array([
    ...Buffer.from(ORACLE_ENVELOPE_INFO, 'utf8'),
    ...ephemeralPublicKeyBytes,
    ...recipientPublicKeyBytes,
  ]);
  const aesKey = await subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: recipientPublicKeyBytes,
      info,
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encryptedBytes = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      Buffer.from(JSON.stringify(plaintextObject), 'utf8')
    )
  );
  const ciphertextBytes = encryptedBytes.slice(0, encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);
  const tagBytes = encryptedBytes.slice(encryptedBytes.length - AES_GCM_TAG_LENGTH_BYTES);
  return Buffer.from(
    JSON.stringify({
      v: 2,
      alg: ORACLE_ENVELOPE_ALGORITHM,
      epk: Buffer.from(ephemeralPublicKeyBytes).toString('base64'),
      iv: Buffer.from(iv).toString('base64'),
      ct: Buffer.from(ciphertextBytes).toString('base64'),
      tag: Buffer.from(tagBytes).toString('base64'),
    })
  ).toString('base64');
}

async function fetchOraclePublicKey(baseUrl, authToken, timeoutMs) {
  const response = await fetch(`${baseUrl}/oracle/public-key`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`oracle public key probe failed with ${response.status}`);
  }
  const body = await response.json();
  const key = trimString(body.public_key || body.publicKey || '');
  if (!key) throw new Error('oracle public key response did not include public_key');
  return key;
}

function hasField(body, fieldPath) {
  const segments = String(fieldPath).split('.');
  let cursor = body;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) return false;
    cursor = cursor[segment];
  }
  return true;
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return { type: typeof body };
  const summary = { keys: Object.keys(body).slice(0, 12) };
  if ('mode' in body) summary.mode = body.mode;
  if ('status' in body) summary.status = body.status;
  if ('approved' in body) summary.approved = body.approved;
  if ('function' in body) summary.function = body.function;
  if ('error' in body) summary.error = String(body.error).slice(0, 160);
  if ('randomness' in body) summary.randomnessLength = String(body.randomness).length;
  return summary;
}

async function runProbe(entry, context) {
  const startedAt = Date.now();
  const payload =
    typeof entry.payload === 'function' ? await entry.payload(context) : entry.payload || {};
  const headers = { accept: 'application/json' };
  const init = {
    method: entry.method,
    headers,
    signal: AbortSignal.timeout(context.timeoutMs),
  };
  if (entry.auth) headers.authorization = `Bearer ${context.authToken}`;
  if (entry.method !== 'GET') {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(payload);
  }

  let status = 0;
  let body = null;
  let error = null;
  try {
    const response = await fetch(`${context.baseUrl}${entry.path}`, init);
    status = response.status;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
  } catch (probeError) {
    error = probeError instanceof Error ? probeError.message : String(probeError);
  }

  const latencyMs = Date.now() - startedAt;
  const maxLatencyMs = Number(entry.maxLatencyMs || context.maxLatencyMs || 0);
  const latencyOk = !maxLatencyMs || latencyMs <= maxLatencyMs;
  const expectedStatus = entry.expectedStatuses.includes(status);
  const missingFields =
    status === 200 ? entry.requiredFields.filter((field) => !hasField(body, field)) : [];
  const ok = !error && expectedStatus && missingFields.length === 0 && latencyOk;
  return {
    id: entry.id,
    serviceClass: entry.serviceClass,
    capabilityFeature: entry.capabilityFeature,
    expectation: entry.expectation,
    method: entry.method,
    path: entry.path,
    status,
    ok,
    latencyMs,
    maxLatencyMs,
    latencyOk,
    missingFields,
    error: error || (!latencyOk ? `latency ${latencyMs}ms exceeded ${maxLatencyMs}ms SLO` : null),
    bodySummary: summarizeBody(body),
  };
}

function aggregate(results) {
  const byServiceClass = {};
  for (const result of results) {
    if (!byServiceClass[result.serviceClass]) {
      byServiceClass[result.serviceClass] = { pass: 0, fail: 0, total: 0 };
    }
    byServiceClass[result.serviceClass].total += 1;
    if (result.ok) byServiceClass[result.serviceClass].pass += 1;
    else byServiceClass[result.serviceClass].fail += 1;
  }
  return {
    total: results.length,
    pass: results.filter((item) => item.ok).length,
    fail: results.filter((item) => !item.ok).length,
    slow: results.filter((item) => item.latencyOk === false).length,
    byServiceClass,
    p95LatencyMs: percentile(results.map((item) => item.latencyMs).filter(Number.isFinite), 0.95),
    maxLatencyMs: Math.max(...results.map((item) => item.latencyMs).filter(Number.isFinite), 0),
  };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

async function runRuntimeServiceMatrix(options = {}) {
  await loadDotEnv(path.resolve(repoRoot, '.env.local'), { override: false });
  await loadDotEnv(path.resolve(repoRoot, '.env'), { override: false });

  const explicitNetwork = trimString(options.network || '');
  const envNetwork = trimString(process.env.MORPHEUS_NETWORK || '');
  const requestedNetwork = explicitNetwork || envNetwork;
  let network =
    requestedNetwork === 'mainnet' ? 'mainnet' : requestedNetwork === 'testnet' ? 'testnet' : '';
  const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl || '');
  if (normalizedBaseUrl && !explicitNetwork) {
    if (/\/mainnet\b/i.test(normalizedBaseUrl)) network = 'mainnet';
    else if (/\/testnet\b/i.test(normalizedBaseUrl)) network = 'testnet';
  }
  if (!network) network = 'testnet';
  const baseUrlCandidates = await resolveBaseUrlCandidates({
    explicitBaseUrl: options.baseUrl,
    network,
  });
  const authToken = trimString(options.authToken || resolveAuthToken());
  if (!authToken) {
    throw new Error('MORPHEUS_RUNTIME_TOKEN or NITRO_API_TOKEN is required');
  }
  const timeoutMs = Number(options.timeoutMs || 60000);
  const maxLatencyMs = Number(options.maxLatencyMs || 10000);
  let baseUrl = baseUrlCandidates[0];
  let oraclePublicKey = null;
  const baseUrlErrors = [];
  for (const candidate of baseUrlCandidates) {
    try {
      oraclePublicKey = await fetchOraclePublicKey(candidate, authToken, timeoutMs);
      baseUrl = candidate;
      break;
    } catch (error) {
      baseUrlErrors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      if (options.baseUrl) break;
    }
  }
  if (!oraclePublicKey) {
    throw new Error(`failed to fetch oracle public key (${baseUrlErrors.join('; ')})`);
  }
  const context = {
    network,
    baseUrl,
    authToken,
    timeoutMs,
    maxLatencyMs,
    oraclePublicKey,
  };
  const results = [];
  for (const entry of RUNTIME_SERVICE_MATRIX) {
    results.push(await runProbe(entry, context));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    network,
    timeoutMs,
    maxLatencyMs,
    summary: aggregate(results),
    results,
  };
  const outputDir = path.resolve(options.outputDir || path.join(repoRoot, 'docs', 'reports'));
  await fs.mkdir(outputDir, { recursive: true });
  const date = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const outputPath = path.join(outputDir, `runtime-service-matrix.${network}.${date}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, outputPath };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { report, outputPath } = await runRuntimeServiceMatrix(args);
  console.log(JSON.stringify({ outputPath, ...report.summary }, null, 2));
  if (report.summary.fail > 0 && !args.continueOnFailure) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
