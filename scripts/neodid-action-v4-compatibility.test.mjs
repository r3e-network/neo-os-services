// Pure source-bound functions only: no worker startup, provider, signer or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const extract = (source, name) => {
  const match = source.match(
    new RegExp(`(?:export )?(?:async )?function ${name}\\([\\s\\S]*?^}$`, 'm')
  );
  assert.ok(match, name);
  return match[0].replace(/^export /, '');
};
const strings = read('workers/morpheus-relayer/src/lib/strings.js');
const router = read('workers/morpheus-relayer/src/router.js');
const names = [
  'encodeLengthPrefixedUtf8',
  'encodeHash160Bytes',
  'encodeHashBytes',
  'encodeSignatureBytes',
  'encodeNeoN3RecoveryTicketV1',
  'encodeNeoN3ActionTicketV1',
  'encodeNeoN3RecoveryTicketV3',
  'encodeNeoN3ActionTicketV3',
  'resolveCompactCallbackBytes',
];
for (const name of ['encodeNeoN3ActionTicketV4']) {
  if (router.includes(`function ${name}(`)) names.unshift(name);
}
const compact = new Function(
  `${['trimString', 'normalizeRequestType', 'strip0x'].map((n) => extract(strings, n)).join('\n')}\n${names.map((n) => extract(router, n)).join('\n')}\nreturn resolveCompactCallbackBytes;`
)();
const core = read('workers/nitro-worker/src/platform/core.js');
const crypto = read('workers/nitro-worker/src/oracle/crypto.js');
const resolver = (network) =>
  new Function(
    'env',
    'trimString',
    'namesTargetChain',
    `${extract(core, 'normalizeMorpheusNetwork')}\n${extract(core, 'resolvePayloadNetwork')}\n${extract(crypto, 'resolveEncryptedRefNetwork')}\nreturn resolveEncryptedRefNetwork;`
  )(
    () => network,
    (v) => String(v || '').trim(),
    () => false
  );
const master = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const action = Buffer.from(Array.from({ length: 32 }, (_, i) => 63 - i));
const signature = Buffer.alloc(64, 0x33); // Inert bytes; no signing is performed.
const maximum = '57896044618658097711785492504343953926634992332820282019728792003956564819967';
const body = {
  callback_encoding: 'neo_n3_action_v4',
  master_nullifier: `0x${master.toString('hex')}`,
  authorization_epoch: '2',
  action_nullifier: `0x${action.toString('hex')}`,
  signature: `0x${signature.toString('hex')}`,
};
const run = (value) => compact('neodid_action_ticket', { body: value });

test('action-v4 compact callback matches exact five-segment bytes', () => {
  assert.equal(
    run(body)?.toString(),
    `4|${master.toString('base64')}|2|${action.toString('base64')}|${signature.toString('base64')}`
  );
  assert.equal(
    run({ ...body, master_nullifier: master.toString('hex').toUpperCase() })?.toString(),
    run(body)?.toString()
  );
});
test('action-v4 compact fields reject wrong types, padding, hex and lengths', () => {
  for (const [field, bytes] of [
    ['master_nullifier', 32],
    ['action_nullifier', 32],
    ['signature', 64],
  ]) {
    for (const bad of [
      undefined,
      null,
      1,
      {},
      [],
      '',
      'zz'.repeat(bytes),
      '11'.repeat(bytes - 1),
      '11'.repeat(bytes + 1),
      ` ${'11'.repeat(bytes)}`,
      `${'11'.repeat(bytes)} `,
    ]) {
      assert.throws(() => run({ ...body, [field]: bad }), /action-v4/, `${field}: ${String(bad)}`);
    }
  }
});
test('action-v4 epoch is canonical positive bounded decimal text', () => {
  for (const bad of [
    undefined,
    null,
    1,
    {},
    '',
    '0',
    '00',
    '01',
    '-1',
    '+1',
    '1.0',
    '1e3',
    ' 1',
    '1 ',
    `1|2`,
    '9'.repeat(78),
    (BigInt(maximum) + 1n).toString(),
  ]) {
    assert.throws(() => run({ ...body, authorization_epoch: bad }), /action-v4/, String(bad));
  }
  for (const epoch of ['1', maximum])
    assert.equal(
      run({ ...body, authorization_epoch: epoch })
        ?.toString()
        .split('|')[2],
      epoch
    );
});
test('action-v4 selector does not change generic, v1, v2 or v3 callback paths', () => {
  assert.equal(compact('neodid_recovery_ticket', { body }), null);
  assert.equal(run({ ...body, callback_encoding: 'neo_n3_action_v2' }), null);
  const old = run({ ...body, callback_encoding: 'neo_n3_action_v3' });
  assert.equal(old.toString(), `3|${action.toString('base64')}|${signature.toString('base64')}`);
  const v1 = run({
    ...body,
    callback_encoding: 'neo_n3_action_v1',
    disposable_account: `0x${'44'.repeat(20)}`,
    action_id: 'a',
  });
  assert.deepEqual(
    v1,
    Buffer.concat([
      Buffer.from([1]),
      Buffer.alloc(20, 0x44),
      Buffer.from([1, 97]),
      action,
      signature,
    ])
  );
});
for (const deployment of ['mainnet', 'testnet']) {
  for (const key of ['callback_encoding', 'result_encoding']) {
    test(`action-v4 ${deployment} ${key}: opaque text and every deployment alias`, () => {
      const resolve = resolver(deployment);
      const value = { network: ' neo_n3 e\u0301 ', [key]: 'neo_n3_action_v4' };
      const before = structuredClone(value);
      assert.equal(resolve(value), deployment);
      assert.deepEqual(value, before);
      for (const alias of ['morpheus_network', 'runtime_network', 'environment']) {
        assert.equal(resolve({ ...value, [alias]: deployment }), deployment);
        for (const bad of [
          deployment === 'mainnet' ? 'testnet' : 'mainnet',
          'unknown',
          false,
          0,
          {},
        ])
          assert.throws(() => resolve({ ...value, [alias]: bad }), /network/);
      }
      assert.throws(
        () =>
          resolve({
            ...value,
            morpheus_network: deployment,
            environment: deployment === 'mainnet' ? 'testnet' : 'mainnet',
          }),
        /network/
      );
      assert.throws(
        () =>
          resolve({
            ...value,
            network: deployment,
            runtime_network: deployment === 'mainnet' ? 'testnet' : 'mainnet',
          }),
        /network/
      );
    });
  }
}

test('action-v4 present network requires nonempty text without changing raw bytes', () => {
  for (const deployment of ['mainnet', 'testnet']) {
    for (const key of ['callback_encoding', 'result_encoding']) {
      const resolve = resolver(deployment);
      const base = { [key]: 'neo_n3_action_v4' };
      assert.equal(resolve(base), deployment); // A genuinely absent assertion stays optional.
      for (const invalid of [
        undefined,
        null,
        [],
        ['opaque'],
        {},
        true,
        false,
        0,
        1,
        '',
        ' \t\n ',
      ]) {
        assert.throws(() => resolve({ ...base, network: invalid }), /network/);
      }
      for (const network of ['opaque', ' neo_n3 e\u0301 ', 'e\u0301', '\u00e9']) {
        const payload = { ...base, network };
        const before = structuredClone(payload);
        assert.equal(resolve(payload), deployment);
        assert.deepEqual(payload, before);
      }
    }
  }
});

test('action-v4 present deployment aliases require exact string identity', () => {
  for (const deployment of ['mainnet', 'testnet']) {
    for (const key of ['callback_encoding', 'result_encoding']) {
      const resolve = resolver(deployment);
      const base = { [key]: 'neo_n3_action_v4', network: 'opaque' };
      for (const alias of ['morpheus_network', 'runtime_network', 'environment']) {
        assert.equal(resolve({ ...base, [alias]: deployment }), deployment);
        for (const invalid of [
          undefined,
          null,
          [],
          [deployment],
          {},
          true,
          false,
          0,
          1,
          '',
          ' ',
          ` ${deployment} `,
          deployment.toUpperCase(),
        ]) {
          assert.throws(() => resolve({ ...base, [alias]: invalid }), /network/);
        }
      }
    }
  }
});

test('legacy v1-v3 ref assertion coercion and optional fields remain unchanged', () => {
  for (const deployment of ['mainnet', 'testnet']) {
    const resolve = resolver(deployment);
    for (const encoding of ['neo_n3_action_v3', 'neo_n3_recovery_v3']) {
      assert.equal(
        resolve({ callback_encoding: encoding, network: false, environment: [deployment] }),
        deployment
      );
      assert.equal(
        resolve({ callback_encoding: encoding, network: null, environment: '' }),
        deployment
      );
    }
    for (const encoding of ['neo_n3_action_v1', 'neo_n3_action_v2']) {
      assert.equal(resolve({ callback_encoding: encoding, network: deployment }), deployment);
      assert.throws(() => resolve({ callback_encoding: encoding, network: 'opaque' }), /network/);
    }
  }
});
