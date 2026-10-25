// Pure caller/resolver contracts: never import the example entrypoints or sign tickets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const worker = read('workers/nitro-worker/src/neodid/index.js');
const core = read('workers/nitro-worker/src/platform/core.js');
const crypto = read('workers/nitro-worker/src/oracle/crypto.js');
const probe = read('examples/scripts/test-n3-aa-recovery-cross-account-boundary.mjs');
const extract = (source, name) => {
  const match = source.match(
    new RegExp(`(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}$`, 'm')
  );
  assert.ok(match, name);
  return match[0].replace(/^export /, '');
};
const trimString = (value) => String(value || '').trim();
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const resolveRequiredText = (value) => {
  assert.ok(trimString(value));
  return trimString(value);
};
const derive = new Function(
  'sha256Hex',
  'trimString',
  'resolveRequiredText',
  `${extract(worker, 'resolveRecoveryActionId')};return resolveRecoveryActionId;`
)(sha256Hex, trimString, resolveRequiredText);
const caller = new Function(
  'createHash',
  `${extract(probe, 'computeRecoveryActionId')};return computeRecoveryActionId;`
)(createHash);
const hash = (byte) => `0x${byte.repeat(20)}`;

test('recovery probe action ID matches worker raw-byte derivation, including byte order', () => {
  // Asymmetric bytes ensure an accidental reversal cannot pass.
  const context = {
    network: 'neo_n3',
    aaContract: '0x00112233445566778899aabbccddeeff00112233',
    accountIdRaw: '0x102132435465768798a9bacbdcedfe0f10213243',
    newOwner: hash('55'),
    recoveryNonceText: '7',
  };
  const expected = derive(
    {},
    context.network,
    context.aaContract,
    context.accountIdRaw,
    context.newOwner,
    context.recoveryNonceText
  );
  assert.equal(caller(context), expected);
  assert.notEqual(caller({ ...context, accountIdRaw: hash('22') }), expected);
  assert.notEqual(caller({ ...context, network: 'neo3-mainnet' }), expected);
  assert.notEqual(caller({ ...context, newOwner: hash('66') }), expected);
  assert.notEqual(caller({ ...context, recoveryNonceText: '8' }), expected);
  assert.throws(
    () =>
      derive(
        { action_id: expected },
        context.network,
        context.aaContract,
        hash('22'),
        context.newOwner,
        '7'
      ),
    /derived recovery action/
  );
});

test('both probe call sites use the corresponding internal raw account, before use', () => {
  for (const letter of ['A', 'B']) {
    const match = probe.match(
      new RegExp(
        `const recoveryActionId${letter} = computeRecoveryActionId\\(\\{([\\s\\S]*?)\\}\\);`
      )
    );
    assert.ok(match);
    assert.match(match[1], new RegExp(`accountIdRaw: accountIdRaw${letter}Internal`));
    assert.ok(probe.indexOf(`const accountIdRaw${letter}Internal =`) < match.index);
    assert.doesNotMatch(match[1], /accountIdText/);
  }
});

test('matrix recovery success payloads supply nonzero raw account and address', () => {
  const source = read('examples/scripts/test-n3-neodid-oracle-matrix.mjs');
  const values = {
    aaContractHash: hash('11'),
    aaVerifierHash: hash('33'),
    recoveryAccountIdA: 'acct-a',
    recoveryAccountIdB: 'acct-b',
    newOwnerA: hash('55'),
    newOwnerB: hash('66'),
    recoveryAccountAddressA: hash('44'),
    recoveryAccountAddressB: hash('45'),
    recoveryAccountIdRawA: hash('22'),
    recoveryAccountIdRawB: hash('23'),
  };
  for (const letter of ['A', 'B']) {
    const declaration = source.match(
      new RegExp(`const recoveryPayload${letter} = ([\\s\\S]*?);`)
    )[1];
    const payload = new Function(...Object.keys(values), `return (${declaration});`)(
      ...Object.values(values)
    );
    assert.match(payload.account_address || '', /^0x[0-9a-f]{40}$/);
    assert.match(payload.account_id_raw || '', /^0x[0-9a-f]{40}$/);
    assert.notEqual(payload.account_id_raw, hash('00'));
    assert.equal(payload.account_address, values[`recoveryAccountAddress${letter}`]);
    assert.equal(payload.account_id_raw, values[`recoveryAccountIdRaw${letter}`]);
  }
});

test('direct/reference recovery docs carry mandatory account address and raw account ID', () => {
  const docs = read('docs/AA_SOCIAL_RECOVERY.md');
  for (const block of docs.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    assert.ok(
      (block[1].match(/"account_address"\s*:/g) || []).length <= 1,
      'each request declares account_address only once'
    );
  }
  const payloads = [...docs.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((m) => JSON.parse(m[1]))
    .filter((p) => p.new_owner && (p.encrypted_params || p.encrypted_params_ref));
  assert.equal(payloads.length, 2);
  for (const p of payloads) {
    assert.ok(p.account_address);
    assert.ok(p.account_id_raw);
  }
  const guide = read('docs/USER_GUIDE.md')
    .split('### Recovery ticket example')[1]
    .split('### Browser')[0];
  const p = JSON.parse(guide.match(/-d '([\s\S]*?)'/)[1]);
  assert.ok(p.account_address);
  assert.ok(p.account_id_raw);
});

function resolver(network) {
  return new Function(
    'env',
    'trimString',
    `
    ${extract(core, 'normalizeMorpheusNetwork')}
    const SUPPORTED_ORACLE_TARGET_CHAINS = new Set(['neo_n3', 'neox']);
    ${extract(core, 'normalizeTargetChain')}
    ${extract(core, 'resolvePayloadNetwork')}
    ${extract(crypto, 'namesTargetChain')}
    ${extract(crypto, 'resolveEncryptedRefNetwork')}
    return resolveEncryptedRefNetwork;
  `
  )(() => network, trimString);
}

for (const deployment of ['testnet', 'mainnet']) {
  for (const encodingKey of ['callback_encoding', 'result_encoding']) {
    for (const encoding of ['neo_n3_action_v3', 'neo_n3_recovery_v3']) {
      test(`${deployment} ${encodingKey} ${encoding}: opaque label never selects ref deployment`, () => {
        const resolve = resolver(deployment);
        const p = { network: 'neo3-testnet', [encodingKey]: encoding };
        const before = structuredClone(p);
        assert.equal(resolve(p), deployment);
        assert.deepEqual(p, before); // The signed ticket label must not be rewritten.
        for (const alias of ['morpheus_network', 'runtime_network', 'environment']) {
          assert.equal(resolve({ ...p, [alias]: deployment }), deployment);
          assert.throws(
            () => resolve({ ...p, [alias]: deployment === 'testnet' ? 'mainnet' : 'testnet' }),
            /network|deployment/
          );
          assert.throws(() => resolve({ ...p, [alias]: 'unknown' }), /network/);
        }
        assert.throws(
          () =>
            resolve({
              ...p,
              morpheus_network: deployment,
              environment: deployment === 'testnet' ? 'mainnet' : 'testnet',
            }),
          /network|deployment/
        );
        assert.equal(resolve({ ...p, network: undefined }), deployment);
      });
    }
  }
}

test('generic and legacy family reference network behavior remains strict', () => {
  const resolve = resolver('testnet');
  assert.equal(resolve({}), 'testnet');
  assert.equal(resolve({ network: 'mainnet' }), 'mainnet');
  assert.equal(resolve({ network: 'neo_n3' }, { networkNamesChainFamily: true }), 'testnet');
  assert.equal(resolve({ network: 'neox' }, { networkNamesChainFamily: true }), 'testnet');
  assert.throws(() => resolve({ network: 'neo3-testnet' }), /unsupported Neo network/);
  assert.throws(
    () => resolve({ network: 'neo3-testnet', callback_encoding: 'unknown' }),
    /unsupported Neo network/
  );
});

function referenceLookup(network, fetchImpl) {
  return new Function(
    'env',
    'trimString',
    'fetch',
    `
    const SUPPORTED_ORACLE_TARGET_CHAINS = new Set(['neo_n3', 'neox']);
    const getSupabaseRestConfig = () => ({ restUrl: 'https://fixture.invalid/rest/v1', apiKey: '' });
    ${extract(core, 'normalizeMorpheusNetwork')}
    ${extract(core, 'normalizeTargetChain')}
    ${extract(core, 'resolvePayloadNetwork')}
    ${extract(crypto, 'isPlainObject')}
    ${extract(crypto, 'normalizeHash160')}
    ${extract(crypto, 'namesTargetChain')}
    ${extract(crypto, 'resolveEncryptedRefNetwork')}
    ${extract(crypto, 'resolveEncryptedRefRequestId')}
    ${extract(crypto, 'readEncryptedRefConsumedRequestId')}
    ${extract(crypto, 'assertEncryptedRefScope')}
    ${extract(crypto, 'buildEncryptedRefClaimUrl')}
    ${extract(crypto, 'claimEncryptedRef')}
    ${extract(crypto, 'loadEncryptedCiphertextByRef')}
    return loadEncryptedCiphertextByRef;
  `
  )(() => network, trimString, fetchImpl);
}

test('AA ref lookup retains requester, callback and same-request replay boundaries', async () => {
  const row = {
    id: 'public-fixture',
    ciphertext: 'inert-fixture',
    metadata: {
      bound_requester: hash('11'),
      bound_callback_contract: hash('22'),
      _consumed_request_id: '17',
    },
  };
  const calls = [];
  const lookup = referenceLookup('testnet', async (url, options) => {
    calls.push(new URL(url));
    assert.equal(options.method, 'GET'); // Same-request replay must not claim again.
    return { ok: true, json: async () => [row] };
  });
  const p = {
    network: 'neo3-testnet',
    callback_encoding: 'neo_n3_recovery_v3',
    request_id: '17',
    requester: hash('11'),
    callback_contract: hash('22'),
  };
  assert.equal(await lookup('public-fixture', p), 'inert-fixture');
  assert.equal(calls[0].searchParams.get('network'), 'eq.testnet');
  await assert.rejects(lookup('public-fixture', { ...p, request_id: '18' }), /already consumed/);
  await assert.rejects(
    lookup('public-fixture', { ...p, requester: hash('33') }),
    /requester mismatch/
  );
  await assert.rejects(
    lookup('public-fixture', { ...p, callback_contract: hash('33') }),
    /callback mismatch/
  );
  const before = calls.length;
  await assert.rejects(
    lookup('public-fixture', { ...p, runtime_network: 'mainnet' }),
    /worker network/
  );
  await assert.rejects(
    lookup('public-fixture', { ...p, request_id: '' }),
    /request_id is required/
  );
  assert.equal(calls.length, before);
});
