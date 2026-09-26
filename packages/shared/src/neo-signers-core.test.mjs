// S5 contract of the shared Neo N3 role resolver: a plaintext private key or WIF
// set under any name a resolution used to read is REFUSED, loudly — never read
// as a signer and never silently ignored. Before this contract the resolver
// returned ok:true / materialized:null for a verifier WIF and "no usable signer"
// for everything else, so a script that read `.materialized?.wif` signed nothing
// without saying why.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { wallet } from '@cityofzion/neon-js';

import {
  NEO_N3_PLAINTEXT_KEY_RETIRED_CODE,
  NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES,
  NEO_N3_SIGNER_ENV_KEYS,
  NEO_N3_SIGNER_PUBLIC_ENV_KEYS,
  assertNoRetiredPlaintextSigner,
  createPinnedRoleResolvers,
  normalizeMorpheusNetwork,
} from './neo-signers-core.js';

const ROLES = ['worker', 'relayer', 'updater', 'oracle_verifier'];
const NETWORKS = ['testnet', 'mainnet'];

it('rejects explicit non-string network values instead of falling back to testnet', () => {
  assert.throws(() => normalizeMorpheusNetwork(false), /unsupported Neo network/);
  assert.throws(() => normalizeMorpheusNetwork(0), /unsupported Neo network/);
  assert.equal(normalizeMorpheusNetwork(null), 'testnet');
  assert.equal(normalizeMorpheusNetwork(''), 'testnet');
});

// A throwaway key generated per run: it only has to be a VALID secret, so that a
// resolver which still materialized plaintext keys would visibly select it.
const SECRET_ACCOUNT = new wallet.Account(wallet.generatePrivateKey());
const VERIFIER_PUBLIC_KEY = new wallet.Account(wallet.generatePrivateKey()).publicKey;

// A synthetic registry: the verifier has a pinned public key on mainnet only, so
// both the public-key-only path and the "no pinned public key" path are reachable.
const REGISTRY = {
  neo_n3: {
    mainnet: {
      roles: {
        worker: { script_hash: `0x${'11'.repeat(20)}` },
        relayer: { script_hash: `0x${'22'.repeat(20)}` },
        updater: { script_hash: `0x${'33'.repeat(20)}` },
        oracle_verifier: { public_key: VERIFIER_PUBLIC_KEY },
      },
    },
    testnet: { roles: {} },
  },
};

const resolvers = createPinnedRoleResolvers(REGISTRY);

function assertRefusal(report, network, role, name) {
  assert.equal(report.ok, false, `${network}/${role}/${name}: report must not be ok`);
  assert.equal(report.materialized, null, `${network}/${role}/${name}: nothing materialized`);
  assert.equal(report.selected_source, null);
  assert.equal(report.selected_identity, null);
  assert.deepEqual(report.retired_plaintext_sources_present, [name]);
  assert.match(report.issues[0], new RegExp(`\\b${name}\\b`));
  assert.match(report.issues[0], /\bS5\b/);
  assert.match(report.issues[0], new RegExp(`SIGNER_ROLE_${role.toUpperCase()}_KEY_ID`));
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(SECRET_ACCOUNT.WIF), false, 'the WIF must never be echoed');
  assert.equal(
    serialized.includes(SECRET_ACCOUNT.privateKey),
    false,
    'the private key must never be echoed'
  );
}

describe('retired plaintext Neo N3 signer keys (S5)', () => {
  it('names exactly the private-key half of NEO_N3_SIGNER_ENV_KEYS', () => {
    const detected = new Set(
      Object.values(NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES).flatMap((byRole) =>
        Object.values(byRole).flat()
      )
    );
    const privateNames = NEO_N3_SIGNER_ENV_KEYS.filter(
      (name) => !NEO_N3_SIGNER_PUBLIC_ENV_KEYS.includes(name)
    );
    assert.deepEqual([...detected].sort(), [...privateNames].sort());
    for (const name of NEO_N3_SIGNER_PUBLIC_ENV_KEYS) {
      assert.equal(detected.has(name), false, `${name} is public and must stay usable`);
    }
    assert.ok(Object.isFrozen(NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES.mainnet.updater));
  });

  for (const network of NETWORKS) {
    for (const role of ROLES) {
      const names = NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES[network][role];
      it(`${network}/${role}: every retired name is reported, refused, and never materialized`, () => {
        assert.ok(names.length > 0);
        for (const name of names) {
          for (const secret of [SECRET_ACCOUNT.WIF, SECRET_ACCOUNT.privateKey]) {
            const env = { [name]: secret };
            for (const allowMissing of [false, true]) {
              const report = resolvers.reportPinnedNeoN3Role(network, role, { env, allowMissing });
              assertRefusal(report, network, role, name);
              const preferMatch = resolvers.resolvePinnedNeoN3RolePreferMatch(network, role, {
                env,
                allowMissing,
              });
              assertRefusal(preferMatch, network, role, name);
              assert.throws(
                () => resolvers.resolvePinnedNeoN3Role(network, role, { env, allowMissing }),
                (error) =>
                  error.code === NEO_N3_PLAINTEXT_KEY_RETIRED_CODE &&
                  error.message.includes(name) &&
                  /\bS5\b/.test(error.message) &&
                  !error.message.includes(secret) &&
                  error.retired_plaintext_sources.includes(name)
              );
              assert.throws(
                () => assertNoRetiredPlaintextSigner(report),
                (error) => error.code === NEO_N3_PLAINTEXT_KEY_RETIRED_CODE
              );
            }
          }
        }
      });
    }
  }

  it('pins the exact per-(network, role) names each resolution read before S5', () => {
    // The primary-then-fallback lists ROLE_KEY_GROUPS held before 942adfe emptied
    // them. A name dropped from one role here would stop being refused for that
    // role even while another role still lists it.
    const RELAYER_TESTNET = [
      'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET',
      'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET',
    ];
    const RELAYER_BASE = ['MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY', 'MORPHEUS_RELAYER_NEO_N3_WIF'];
    const UPDATER_TESTNET = [
      'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_TESTNET',
      'MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET',
    ];
    const UPDATER_BASE = ['MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY', 'MORPHEUS_UPDATER_NEO_N3_WIF'];
    assert.deepEqual(JSON.parse(JSON.stringify(NEO_N3_RETIRED_PLAINTEXT_KEY_ENV_NAMES)), {
      testnet: {
        worker: [
          'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_TESTNET',
          'MORPHEUS_WORKER_NEO_N3_WIF_TESTNET',
          'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY',
          'MORPHEUS_WORKER_NEO_N3_WIF',
          'NEO_TESTNET_WIF',
          'NEO_N3_WIF',
          ...RELAYER_TESTNET,
          ...RELAYER_BASE,
        ],
        relayer: [...RELAYER_TESTNET, ...UPDATER_TESTNET, ...RELAYER_BASE, ...UPDATER_BASE],
        updater: [...UPDATER_TESTNET, ...RELAYER_TESTNET, ...UPDATER_BASE, ...RELAYER_BASE],
        oracle_verifier: [
          'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_TESTNET',
          'MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET',
          'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
          'MORPHEUS_ORACLE_VERIFIER_WIF',
          ...RELAYER_TESTNET,
          ...RELAYER_BASE,
        ],
      },
      mainnet: {
        worker: [
          'MORPHEUS_WORKER_NEO_N3_PRIVATE_KEY_MAINNET',
          'MORPHEUS_WORKER_NEO_N3_WIF_MAINNET',
          'NEO_N3_WIF',
          'NEO_TESTNET_WIF',
        ],
        relayer: [
          'MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_MAINNET',
          'MORPHEUS_RELAYER_NEO_N3_WIF_MAINNET',
          ...RELAYER_BASE,
          'NEO_N3_WIF',
          'NEO_TESTNET_WIF',
        ],
        updater: [
          'MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET',
          'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
          ...UPDATER_BASE,
          'NEO_N3_WIF',
          'NEO_TESTNET_WIF',
        ],
        oracle_verifier: [
          'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_MAINNET',
          'MORPHEUS_ORACLE_VERIFIER_WIF_MAINNET',
          'MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY',
          'MORPHEUS_ORACLE_VERIFIER_WIF',
        ],
      },
    });
  });

  it('never materializes a key even when it IS the pinned identity (primary/fallback stay empty)', () => {
    // Pin every role to the throwaway key's own identity: a resolution that read
    // any name as a primary or fallback source (a re-added ROLE_KEY_GROUPS entry)
    // would now select it, so `materialized` would stop being null.
    const identity = {
      script_hash: `0x${SECRET_ACCOUNT.scriptHash}`,
      public_key: SECRET_ACCOUNT.publicKey,
    };
    const selfPinned = createPinnedRoleResolvers({
      neo_n3: Object.fromEntries(
        NETWORKS.map((network) => [
          network,
          { roles: Object.fromEntries(ROLES.map((role) => [role, { ...identity }])) },
        ])
      ),
    });
    for (const network of NETWORKS) {
      for (const role of ROLES) {
        for (const name of new Set(NEO_N3_SIGNER_ENV_KEYS)) {
          if (NEO_N3_SIGNER_PUBLIC_ENV_KEYS.includes(name)) continue;
          for (const secret of [SECRET_ACCOUNT.WIF, SECRET_ACCOUNT.privateKey]) {
            const report = selfPinned.reportPinnedNeoN3Role(network, role, {
              env: { [name]: secret },
              allowMissing: true,
            });
            assert.equal(report.materialized, null, `${network}/${role} read ${name}`);
            assert.equal(report.selected_source, null, `${network}/${role} read ${name}`);
            assert.deepEqual(report.primary_sources_present, []);
            assert.deepEqual(report.fallback_sources_present, []);
          }
        }
      }
    }
  });

  it('lists every retired name present, in resolution order', () => {
    const report = resolvers.reportPinnedNeoN3Role('mainnet', 'updater', {
      env: {
        NEO_TESTNET_WIF: SECRET_ACCOUNT.WIF,
        MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET: SECRET_ACCOUNT.WIF,
      },
      allowMissing: true,
    });
    assert.deepEqual(report.retired_plaintext_sources_present, [
      'MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET',
      'NEO_TESTNET_WIF',
    ]);
    assert.match(
      report.issues[0],
      /keys MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET, NEO_TESTNET_WIF are set/
    );
  });

  it('ignores names another (network, role) read, and blank values', () => {
    // MORPHEUS_UPDATER_* was never an oracle_verifier source on mainnet.
    const unrelated = resolvers.reportPinnedNeoN3Role('mainnet', 'oracle_verifier', {
      env: { MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET: SECRET_ACCOUNT.WIF },
    });
    assert.deepEqual(unrelated.retired_plaintext_sources_present, []);
    assert.equal(unrelated.ok, true, unrelated.issues.join('; '));

    const blank = resolvers.reportPinnedNeoN3Role('mainnet', 'updater', {
      env: { MORPHEUS_UPDATER_NEO_N3_WIF_MAINNET: '   ', NEO_N3_WIF: '' },
      allowMissing: true,
    });
    assert.deepEqual(blank.retired_plaintext_sources_present, []);
    assert.equal(blank.ok, true);
    assert.equal(assertNoRetiredPlaintextSigner(blank), blank);
  });

  it('detects a retired name through a getter-function env', () => {
    const seen = [];
    const env = (name) => {
      seen.push(name);
      return name === 'NEO_N3_WIF' ? SECRET_ACCOUNT.WIF : '';
    };
    const report = resolvers.reportPinnedNeoN3Role('mainnet', 'worker', {
      env,
      allowMissing: true,
    });
    assertRefusal(report, 'mainnet', 'worker', 'NEO_N3_WIF');
    assert.ok(seen.includes('NEO_N3_WIF'));
  });

  it('keeps the public-key-only verifier path working when nothing is set', () => {
    const report = resolvers.reportPinnedNeoN3Role('mainnet', 'oracle_verifier', { env: {} });
    assert.equal(report.ok, true, report.issues.join('; '));
    assert.equal(report.materialized, null);
    assert.equal(report.public_key, VERIFIER_PUBLIC_KEY);
    assert.equal(resolvers.resolvePinnedNeoN3VerifierPublicKey('mainnet', {}), VERIFIER_PUBLIC_KEY);
  });

  it('the verifier public-key resolver names the retired key before a missing pin', () => {
    // testnet has no pinned verifier public key: before, the only error was the
    // missing pin, and the operator never learned the WIF they set is refused.
    assert.throws(
      () =>
        resolvers.resolvePinnedNeoN3VerifierPublicKey('testnet', {
          MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET: SECRET_ACCOUNT.WIF,
        }),
      (error) =>
        error.code === NEO_N3_PLAINTEXT_KEY_RETIRED_CODE &&
        error.message.includes('MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET')
    );
    assert.throws(
      () => resolvers.resolvePinnedNeoN3VerifierPublicKey('testnet', {}),
      /no pinned verifier public key/
    );
  });

  it('the updater hash resolver refuses a retired key with the S5 code', () => {
    assert.throws(
      () =>
        resolvers.resolvePinnedNeoN3UpdaterHash('mainnet', {
          MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_MAINNET: SECRET_ACCOUNT.privateKey,
        }),
      (error) => error.code === NEO_N3_PLAINTEXT_KEY_RETIRED_CODE
    );
    assert.equal(resolvers.resolvePinnedNeoN3UpdaterHash('mainnet', {}), `0x${'33'.repeat(20)}`);
  });
});
