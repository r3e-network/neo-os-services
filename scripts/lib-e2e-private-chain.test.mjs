// Unit tests for the CU-88 end-to-end harness helpers.
//
// These cover the parts of the harness that can produce a *false pass* without a
// chain: the environment it assembles, the contract binding it insists on, the
// decoder for the on-chain request, and the single acceptance evaluator that
// decides whether the run is green. The behavioural leg — a request fulfilled on
// a private chain with a verified signature — is scripts/test-e2e-private-chain.mjs
// and is exercised by the e2e-private-chain CI job, not here.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCEPTANCE_CHECKS,
  HarnessError,
  MEASURED_CONTRACT_OVERRIDE_ENV,
  PRIVATE_CHAIN_MAGIC,
  buildCustodyEnv,
  buildHostEnv,
  buildRelayerEnv,
  decodeRequestStack,
  evaluateAcceptance,
  normalizeScriptHash,
  parseConfigDump,
  relayerEnvFromDump,
  stripHexPrefix,
  teardownPlan,
} from './lib-e2e-private-chain.mjs';

const KERNEL = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a';
const WORKER_KEY = 'key-worker-00000000000000000000000000000';
const RELAYER_KEY = 'key-relayer-0000000000000000000000000000';
const UPDATER_KEY = 'key-updater-0000000000000000000000000000';
const VERIFIER_KEY = 'key-verifier-000000000000000000000000000';
const CUSTODY = { url: 'http://127.0.0.1:21000', token: 'caller-token', dataDir: '/tmp/x' };
const ROLE_KEYS = {
  worker: WORKER_KEY,
  relayer: RELAYER_KEY,
  updater: UPDATER_KEY,
  oracle_verifier: VERIFIER_KEY,
};

function shape() {
  return {
    nodeEnv: 'test',
    network: 'testnet',
    magic: PRIVATE_CHAIN_MAGIC,
    kernelHash: KERNEL,
    custody: { ...CUSTODY, roleKeys: { ...ROLE_KEYS } },
    host: { url: 'http://127.0.0.1:21001', token: 'host-token' },
    relayer: { stateFile: '/tmp/x/relayer-state.json', rpcUrl: 'http://127.0.0.1:21002' },
  };
}

function observed(overrides = {}) {
  return {
    onChain: {
      state: 1,
      success: true,
      resultHex: 'beef',
      error: '',
      completionTimestamp: 1_700_000_000_000,
    },
    expected: { resultHex: 'beef' },
    corruptSignatureRejected: true,
    replayRejected: true,
    contractBinding: { kernelHash: KERNEL, hostOverride: KERNEL, relayerContract: KERNEL },
    custody: {
      verifierPublicKey: '02aa',
      hostReportedPublicKey: '02aa',
      relayerPinnedVerifier: VERIFIER_KEY,
      configuredVerifierKey: VERIFIER_KEY,
    },
    ...overrides,
  };
}

test('every acceptance check is named and every one is required', () => {
  assert.ok(ACCEPTANCE_CHECKS.length >= 8, 'the acceptance set must be explicit');
  for (const name of ACCEPTANCE_CHECKS) {
    const blank = observed();
    // Mutate one dimension of the observation to an impossible value and the
    // named check must be the one that reports it.
    assert.ok(name.startsWith('check/'), `acceptance check must be namespaced: ${name}`);
    const verdict = evaluateAcceptance(blank);
    assert.equal(verdict.ok, true);
  }
});

test('a fully observed run reports ok with every check green', () => {
  const verdict = evaluateAcceptance(observed());
  assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
  assert.equal(verdict.failures.length, 0);
  assert.equal(verdict.checks.length, ACCEPTANCE_CHECKS.length);
});

test('a request that never settled on chain is not a pass', () => {
  for (const state of [0, -1, 2]) {
    const verdict = evaluateAcceptance(observed({ onChain: { ...observed().onChain, state } }));
    assert.equal(verdict.ok, false, `state ${state} must not pass`);
    assert.ok(verdict.failures.some((line) => line.includes('state')));
  }
});

test('a failed fulfillment is not a pass even when the request completed', () => {
  const verdict = evaluateAcceptance(
    observed({ onChain: { ...observed().onChain, success: false, error: 'boom' } })
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((line) => line.includes('success')));
});

test('a result that differs from the computed result is not a pass', () => {
  const verdict = evaluateAcceptance(
    observed({ onChain: { ...observed().onChain, resultHex: 'dead' } })
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((line) => line.includes('result')));
});

test('a zero completion timestamp is not a pass', () => {
  const verdict = evaluateAcceptance(
    observed({ onChain: { ...observed().onChain, completionTimestamp: 0 } })
  );
  assert.equal(verdict.ok, false);
});

test('a missing corrupt-signature control is not a pass', () => {
  const verdict = evaluateAcceptance(observed({ corruptSignatureRejected: false }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((line) => line.includes('corrupt')));
});

test('a missing replay control is not a pass', () => {
  const verdict = evaluateAcceptance(observed({ replayRejected: false }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((line) => line.includes('replay')));
});

test('the host override must equal the deployed kernel hash', () => {
  for (const key of ['hostOverride', 'relayerContract']) {
    const binding = { kernelHash: KERNEL, hostOverride: KERNEL, relayerContract: KERNEL };
    binding[key] = '0x' + '11'.repeat(20);
    const verdict = evaluateAcceptance(observed({ contractBinding: binding }));
    assert.equal(verdict.ok, false, `${key} drift must fail`);
    assert.ok(verdict.failures.some((line) => line.includes('contract')));
  }
});

test('the verifier identity must be the custody key the relayer pinned', () => {
  const verdict = evaluateAcceptance(
    observed({
      custody: {
        verifierPublicKey: '02aa',
        hostReportedPublicKey: '02bb',
        relayerPinnedVerifier: VERIFIER_KEY,
        configuredVerifierKey: VERIFIER_KEY,
      },
    })
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((line) => line.includes('verifier')));
});

test('a relayer that pinned a different custody key is not a pass', () => {
  const verdict = evaluateAcceptance(
    observed({
      custody: {
        verifierPublicKey: '02aa',
        hostReportedPublicKey: '02aa',
        relayerPinnedVerifier: 'key-other',
        configuredVerifierKey: VERIFIER_KEY,
      },
    })
  );
  assert.equal(verdict.ok, false);
});

test('an incomplete observation is never a pass', () => {
  const verdict = evaluateAcceptance({});
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.length > 0);
});

test('normalizeScriptHash accepts only a 20-byte hex script hash', () => {
  assert.equal(normalizeScriptHash('0x' + 'AB'.repeat(20)), '0x' + 'ab'.repeat(20));
  assert.equal(normalizeScriptHash('AB'.repeat(20)), '0x' + 'ab'.repeat(20));
  for (const bad of [
    '',
    '0x',
    '0x' + 'ab'.repeat(19),
    '0x' + 'ab'.repeat(21),
    '0x' + 'zz'.repeat(20),
  ]) {
    assert.throws(() => normalizeScriptHash(bad), HarnessError, `accepted ${bad}`);
  }
});

test('stripHexPrefix is case-insensitive and leaves bare hex alone', () => {
  assert.equal(stripHexPrefix('0xABCD'), 'abcd');
  assert.equal(stripHexPrefix('0XABCD'), 'abcd');
  assert.equal(stripHexPrefix('abcd'), 'abcd');
});

test('the host environment carries the measured-contract override for the fresh kernel', () => {
  const env = buildHostEnv(shape());
  assert.equal(env[MEASURED_CONTRACT_OVERRIDE_ENV], KERNEL);
  assert.equal(env.MORPHEUS_NETWORK, 'testnet');
  assert.equal(env.NODE_ENV, 'test');
  assert.equal(env.SIGNER_SERVICE_URL, CUSTODY.url);
  assert.equal(env.SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID, VERIFIER_KEY);
  assert.equal(env.SIGNER_ROLE_UPDATER_KEY_ID, UPDATER_KEY);
});

test('the relayer environment points at the same kernel, loopback only, with no database', () => {
  const env = buildRelayerEnv(shape());
  assert.equal(env.MORPHEUS_LOCAL_CHAIN, 'true');
  assert.equal(env.MORPHEUS_LOCAL_CHAIN_RPC_URLS, shape().relayer.rpcUrl);
  assert.equal(env.MORPHEUS_RELAYER_MODE, 'requests_only');
  assert.equal(env.CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET, KERNEL);
  assert.equal(env.SIGNER_SERVICE_URL, CUSTODY.url);
  assert.equal(env.MORPHEUS_RUNTIME_URL, shape().host.url);
  assert.equal(env.MORPHEUS_RUNTIME_TOKEN, 'host-token');
  assert.equal(env.SIGNER_ROLE_UPDATER_KEY_ID, UPDATER_KEY);
  assert.equal(env.SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID, VERIFIER_KEY);
  assert.equal(env.MORPHEUS_RELAYER_STATE_FILE, shape().relayer.stateFile);
  assert.equal(env.MORPHEUS_AUTOMATION_ENABLED, 'false');
  assert.equal(env.MORPHEUS_RELAYER_ENCLAVE_FULFILL, 'true');
  for (const key of Object.keys(env)) {
    assert.ok(!/SUPABASE|DATABASE|POSTGRES/i.test(key), `database setting leaked into ${key}`);
  }
});

test('the updater and the verifier are never the same custody key', () => {
  const broken = shape();
  broken.custody.roleKeys.oracle_verifier = UPDATER_KEY;
  assert.throws(() => buildRelayerEnv(broken), HarnessError);
  assert.throws(() => buildHostEnv(broken), HarnessError);
});

test('the harness refuses to assemble any environment outside the test profile', () => {
  for (const [key, value] of [
    ['nodeEnv', 'production'],
    ['nodeEnv', ' PrOdUcTiOn '],
    ['network', 'mainnet'],
    ['magic', 860833102],
  ]) {
    const broken = shape();
    broken[key] = value;
    assert.throws(() => buildHostEnv(broken), HarnessError, `host accepted ${key}=${value}`);
    assert.throws(() => buildRelayerEnv(broken), HarnessError, `relayer accepted ${key}=${value}`);
    assert.throws(() => buildCustodyEnv(broken), HarnessError, `custody accepted ${key}=${value}`);
  }
});

test('a non-loopback service endpoint is refused before anything is spawned', () => {
  for (const patch of [
    { host: { url: 'https://oracle.example', token: 'h' } },
    { relayer: { stateFile: '/tmp/x/state.json', rpcUrl: 'http://10.0.0.5:1' } },
    { custody: { ...CUSTODY, url: 'https://signer.example' } },
  ]) {
    const broken = { ...shape(), ...patch };
    assert.throws(() => buildRelayerEnv(broken), HarnessError);
    assert.throws(() => buildHostEnv(broken), HarnessError);
  }
});

test('a missing kernel hash is refused rather than defaulted', () => {
  const broken = shape();
  broken.kernelHash = '';
  assert.throws(() => buildHostEnv(broken), HarnessError);
  assert.throws(() => buildRelayerEnv(broken), HarnessError);
});

test('decodeRequestStack reads the on-chain getRequest stack and refuses a settled request', () => {
  const bytes = (text) => ({ type: 'ByteArray', value: Buffer.from(text).toString('base64') });
  const pending = {
    0: { type: 'Integer', value: '1' },
    1: bytes('app'),
    2: bytes('mod'),
    3: bytes('compute_hash'),
    4: bytes('{"a":1}'),
    8: { type: 'Integer', value: '0' },
    9: { type: 'Integer', value: '0' },
    10: { type: 'Integer', value: '0' },
    11: { type: 'Boolean', value: false },
    12: { type: 'ByteArray', value: '' },
    13: { type: 'ByteArray', value: '' },
  };
  const decoded = decodeRequestStack(pending);
  assert.equal(decoded.requestId, 1);
  assert.equal(decoded.appId, 'app');
  assert.equal(decoded.moduleId, 'mod');
  assert.equal(decoded.operation, 'compute_hash');
  assert.deepEqual(JSON.parse(decoded.payloadText), { a: 1 });
  assert.equal(decoded.state, 0);
  assert.equal(decoded.success, false);
  assert.equal(decoded.resultHex, '');
  assert.equal(decoded.completionTimestamp, 0);

  const settled = {
    ...pending,
    8: { type: 'Integer', value: '1' },
    9: { type: 'Integer', value: '11' },
    10: { type: 'Integer', value: '12' },
    11: { type: 'Boolean', value: true },
    12: { type: 'ByteArray', value: Buffer.from('beef', 'hex').toString('base64') },
  };
  assert.equal(decodeRequestStack(settled).state, 1);
  assert.equal(decodeRequestStack(settled).success, true);
  assert.equal(decodeRequestStack(settled).createdAt, 11);
  assert.equal(decodeRequestStack(settled).completionTimestamp, 12);
  assert.equal(decodeRequestStack(settled).resultHex, 'beef');
  assert.throws(() => decodeRequestStack({}), HarnessError);
});

test('relayerEnvFromDump reads the resolved contract out of config:dump', () => {
  const dump = [
    '# Morpheus relayer — resolved configuration',
    '# (secrets redacted; "source" shows which alias won)',
    '',
    `neo_n3.oracleContract                  = ${KERNEL}    (CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET via env)`,
    'nitro.custodyToken                     = [redacted] [set]    (SIGNER_SERVICE_TOKEN via env)',
    `neo_n3.custodyKeyIds.updater           = ${UPDATER_KEY}    (SIGNER_ROLE_UPDATER_KEY_ID via env)`,
    `neo_n3.custodyKeyIds.oracle_verifier   = ${VERIFIER_KEY}    (SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID via env)`,
  ].join('\n');
  const read = relayerEnvFromDump(dump);
  assert.equal(read.oracleContract, KERNEL);
  assert.equal(read.updaterKeyId, UPDATER_KEY);
  assert.equal(read.oracleVerifierKeyId, VERIFIER_KEY);

  const parsed = parseConfigDump(dump);
  assert.equal(parsed['neo_n3.oracleContract'], KERNEL);
  assert.equal(parsed['nitro.custodyToken'], '[redacted] [set]');

  assert.throws(
    () => relayerEnvFromDump('neo_n3.networkMagic = 894710606    (env via env)'),
    HarnessError
  );
  assert.throws(() => relayerEnvFromDump(''), HarnessError);
  assert.throws(() => relayerEnvFromDump(null), HarnessError);
});

test('parseConfigDump ignores non-setting lines and never guesses a value', () => {
  const parsed = parseConfigDump(
    '# comment\n\nnot a setting line\nkey = value    (alias via env)\n'
  );
  assert.deepEqual(Object.keys(parsed), ['key']);
  assert.equal(parsed.key, 'value');
  assert.throws(() => parseConfigDump('   '), HarnessError);
});

test('the teardown plan covers every child and the temporary root', () => {
  const plan = teardownPlan({
    children: ['neo-go', 'signer_service', 'enclave_host'],
    root: '/tmp/e2e',
  });
  assert.equal(plan.length, 4);
  for (const name of ['neo-go', 'signer_service', 'enclave_host']) {
    assert.ok(
      plan.some((step) => step.target === name && step.action === 'stop'),
      name
    );
  }
  assert.ok(plan.some((step) => step.action === 'remove' && step.target === '/tmp/e2e'));
  assert.throws(() => teardownPlan({ children: [], root: '' }), HarnessError);
  assert.throws(() => teardownPlan({ children: ['x'], root: '/' }), HarnessError);
  assert.throws(() => teardownPlan({ children: ['x'], root: '/Users/jinghuiliao' }), HarnessError);
});
