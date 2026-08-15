import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { wallet } from '@cityofzion/neon-js';

import {
  NEO_N3_SIGNER_ENV_KEYS,
  normalizeMorpheusNetwork,
  normalizeHash160,
  materializeNeoN3Secret,
  getPinnedNeoN3Role,
  resolvePinnedNeoN3Role,
  resolvePinnedNeoN3RolePreferMatch,
  reportPinnedNeoN3Role,
  reportPinnedNeoN3Roles,
  resolvePinnedNeoN3UpdaterHash,
  resolvePinnedNeoN3VerifierPublicKey,
} from './neo-signers.js';

// ---------------------------------------------------------------------------
// Deterministic test accounts (generated once, stable across runs)
// ---------------------------------------------------------------------------

function generateTestAccount() {
  const pk = wallet.generatePrivateKey();
  return new wallet.Account(pk);
}

// We generate these lazily so neon-js import time isn't a problem.
let ACCOUNT_A;
let ACCOUNT_B;

before(() => {
  ACCOUNT_A = generateTestAccount();
  ACCOUNT_B = generateTestAccount();
});

// ---------------------------------------------------------------------------
// Env isolation helpers
// ---------------------------------------------------------------------------

const ALL_SIGNER_ENV_KEYS = [...NEO_N3_SIGNER_ENV_KEYS, 'MORPHEUS_ALLOW_UNPINNED_SIGNERS'];

/** Save, clear, run fn, then restore all signer-related env vars. */
function withCleanSignerEnv(fn) {
  const saved = new Map();
  for (const key of ALL_SIGNER_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ===================================================================
// normalizeMorpheusNetwork
// ===================================================================

describe('normalizeMorpheusNetwork', () => {
  it('defaults to testnet for empty/null/undefined input', () => {
    assert.equal(normalizeMorpheusNetwork(''), 'testnet');
    assert.equal(normalizeMorpheusNetwork(null), 'testnet');
    assert.equal(normalizeMorpheusNetwork(undefined), 'testnet');
  });

  it('returns mainnet for case-insensitive "mainnet"', () => {
    assert.equal(normalizeMorpheusNetwork('mainnet'), 'mainnet');
    assert.equal(normalizeMorpheusNetwork('Mainnet'), 'mainnet');
    assert.equal(normalizeMorpheusNetwork('MAINNET'), 'mainnet');
  });

  it('returns testnet for any non-mainnet string', () => {
    assert.equal(normalizeMorpheusNetwork('testnet'), 'testnet');
    assert.equal(normalizeMorpheusNetwork('devnet'), 'testnet');
    assert.equal(normalizeMorpheusNetwork('random'), 'testnet');
  });

  it('trims whitespace', () => {
    assert.equal(normalizeMorpheusNetwork('  mainnet  '), 'mainnet');
    assert.equal(normalizeMorpheusNetwork('  testnet  '), 'testnet');
  });
});

// ===================================================================
// normalizeHash160
// ===================================================================

describe('normalizeHash160', () => {
  it('returns empty string for falsy input', () => {
    assert.equal(normalizeHash160(''), '');
    assert.equal(normalizeHash160(null), '');
    assert.equal(normalizeHash160(undefined), '');
  });

  it('normalizes a raw 40-hex script hash with 0x prefix', () => {
    const raw = '6d0656f6dd91469db1c90cc1e574380613f43738';
    assert.equal(normalizeHash160(raw), `0x${raw}`);
  });

  it('preserves already-prefixed hash', () => {
    const prefixed = '0x6d0656f6dd91469db1c90cc1e574380613f43738';
    assert.equal(normalizeHash160(prefixed), prefixed);
  });

  it('lowercases mixed-case hashes', () => {
    const mixed = '0x6D0656F6DD91469DB1C90CC1E574380613F43738';
    assert.equal(normalizeHash160(mixed), '0x6d0656f6dd91469db1c90cc1e574380613f43738');
  });

  it('converts a valid Neo N3 address to 0x-prefixed script hash', () => {
    const addr = 'NR3E4D8NUXh3zhbf5ZkAp3rTxWbQqNih32';
    const result = normalizeHash160(addr);
    assert.match(result, /^0x[0-9a-f]{40}$/);
    // Verify round-trip consistency
    assert.equal(normalizeHash160(result), result);
  });

  it('returns empty string for invalid hex', () => {
    assert.equal(normalizeHash160('not-a-hash'), '');
    assert.equal(normalizeHash160('0xZZZZ'), '');
  });
});

// ===================================================================
// materializeNeoN3Secret
// ===================================================================

describe('materializeNeoN3Secret', () => {
  it('returns null for empty/blank secret', () => {
    assert.equal(materializeNeoN3Secret(''), null);
    assert.equal(materializeNeoN3Secret('   '), null);
  });

  it('materializes a valid WIF into a full identity', () => {
    const result = materializeNeoN3Secret(ACCOUNT_A.WIF);
    assert.ok(result, 'should return a non-null result');
    assert.equal(result.wif, ACCOUNT_A.WIF);
    assert.equal(result.private_key, ACCOUNT_A.privateKey);
    assert.equal(result.identity.address, ACCOUNT_A.address);
    assert.equal(result.identity.script_hash, `0x${ACCOUNT_A.scriptHash}`);
    assert.ok(result.identity.public_key, 'should have a public key');
  });

  it('materializes a valid private key hex', () => {
    const result = materializeNeoN3Secret(ACCOUNT_A.privateKey);
    assert.ok(result);
    assert.equal(result.identity.address, ACCOUNT_A.address);
    assert.equal(result.wif, ACCOUNT_A.WIF);
  });

  it('throws on an invalid/malformed secret', () => {
    assert.throws(() => materializeNeoN3Secret('not-a-valid-key'));
  });

  it('trims whitespace around the secret', () => {
    const result = materializeNeoN3Secret(`  ${ACCOUNT_A.WIF}  `);
    assert.ok(result);
    assert.equal(result.wif, ACCOUNT_A.WIF);
  });
});

// ===================================================================
// getPinnedNeoN3Role (registry lookup)
// ===================================================================

describe('getPinnedNeoN3Role', () => {
  it('returns pinned identity for known testnet roles', () => {
    const worker = getPinnedNeoN3Role('testnet', 'worker');
    assert.ok(worker, 'should find testnet worker');
    assert.ok(
      worker.address || worker.script_hash || worker.public_key,
      'pinned identity should have at least one identifier'
    );
  });

  it('pins worker identities to the documented network-specific operators', () => {
    const testnetWorker = getPinnedNeoN3Role('testnet', 'worker');
    const mainnetWorker = getPinnedNeoN3Role('mainnet', 'worker');

    assert.equal(testnetWorker.address, 'NiUs458jFbTH1DA3b9QyeDhMaD282h3iJg');
    assert.equal(testnetWorker.script_hash, '0xe421999c396ee0249a8a8c9dd95bfbdaf55f8bf7');
    assert.equal(mainnetWorker.address, 'NR3E4D8NUXh3zhbf5ZkAp3rTxWbQqNih32');
    assert.equal(mainnetWorker.script_hash, '0x6d0656f6dd91469db1c90cc1e574380613f43738');
  });

  it('returns pinned identity for known mainnet roles', () => {
    const relayer = getPinnedNeoN3Role('mainnet', 'relayer');
    assert.ok(relayer);
    assert.ok(relayer.script_hash || relayer.address);
  });

  it('returns null for unknown role', () => {
    assert.equal(getPinnedNeoN3Role('testnet', 'nonexistent_role'), null);
  });

  it('normalizes network name before lookup', () => {
    const a = getPinnedNeoN3Role('TESTNET', 'worker');
    const b = getPinnedNeoN3Role('testnet', 'worker');
    assert.deepEqual(a, b);
  });

  it('returns oracle_verifier with public_key for mainnet', () => {
    const verifier = getPinnedNeoN3Role('mainnet', 'oracle_verifier');
    assert.ok(verifier);
    assert.ok(verifier.public_key, 'mainnet verifier should have a public_key');
  });
});

// ===================================================================
// resolvePinnedNeoN3Role (strict mode)
// ===================================================================

describe('resolvePinnedNeoN3Role', () => {
  it('throws on unsupported role', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      assert.throws(
        () => resolvePinnedNeoN3Role('testnet', 'fake_role'),
        (err) => err.message.includes('unsupported Neo N3 signer role')
      );
    });
  });

  it('resolves a signer from primary WIF env var (unpinned mode)', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_A.WIF;

      const report = resolvePinnedNeoN3Role('testnet', 'relayer');
      assert.equal(report.ok, true);
      assert.equal(report.network, 'testnet');
      assert.equal(report.role, 'relayer');
      assert.equal(report.selected_source, 'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET');
      assert.equal(report.selected_identity.address, ACCOUNT_A.address);
      assert.ok(report.materialized, 'should include materialized secret');
      assert.equal(report.materialized.wif, ACCOUNT_A.WIF);
    });
  });

  it('resolves from private key env var', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET = ACCOUNT_A.privateKey;

      const report = resolvePinnedNeoN3Role('testnet', 'relayer');
      assert.equal(report.ok, true);
      assert.equal(report.selected_identity.address, ACCOUNT_A.address);
    });
  });

  it('falls back to fallback keys when no primary key is set', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      // For testnet relayer, the generic MORPHEUS_RELAYER_NEO_N3_WIF is a fallback key
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF = ACCOUNT_A.WIF;

      const report = resolvePinnedNeoN3Role('testnet', 'relayer');
      assert.equal(report.ok, true);
      assert.equal(report.selected_source, 'MORPHEUS_RELAYER_NEO_N3_WIF');
    });
  });

  it('throws for transaction signer roles when only a pinned public_key is available', () => {
    withCleanSignerEnv(() => {
      assert.throws(
        () => resolvePinnedNeoN3Role('testnet', 'relayer'),
        (err) => err.message.includes('no usable relayer signer configured')
      );

      const report = reportPinnedNeoN3Role('testnet', 'relayer');
      assert.equal(report.ok, false);
      assert.equal(report.selected_source, null);
      assert.ok(report.public_key, 'should still expose the pinned public_key');
      assert.equal(report.materialized, null);
      assert.ok(report.issues.some((issue) => issue.includes('no usable relayer signer')));
    });
  });

  it('strict mode throws when key does not match pinned identity', () => {
    withCleanSignerEnv(() => {
      // Set a key that does NOT match the pinned identity
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_B.WIF;

      assert.throws(
        () => resolvePinnedNeoN3Role('testnet', 'relayer'),
        (err) => err.message.includes('do not match pinned')
      );
    });
  });
});

// ===================================================================
// resolvePinnedNeoN3RolePreferMatch (prefer-match mode)
// ===================================================================

describe('resolvePinnedNeoN3RolePreferMatch', () => {
  it('returns a report without throwing even if keys mismatch', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_B.WIF;

      const report = resolvePinnedNeoN3RolePreferMatch('testnet', 'relayer');
      assert.equal(report.ok, false);
      assert.ok(report.issues.length > 0, 'should report issues');
    });
  });

  it('returns ok=true when key matches pinned identity', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_A.WIF;

      const report = resolvePinnedNeoN3RolePreferMatch('testnet', 'relayer');
      assert.equal(report.ok, true);
      assert.equal(report.issues.length, 0);
    });
  });
});

// ===================================================================
// reportPinnedNeoN3Role / reportPinnedNeoN3Roles (report mode)
// ===================================================================

describe('reportPinnedNeoN3Role', () => {
  it('returns report without throwing even with issues', () => {
    withCleanSignerEnv(() => {
      // Set a key that does NOT match the pinned identity -- produces issues
      // but report mode should not throw
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_B.WIF;
      const report = reportPinnedNeoN3Role('testnet', 'relayer');
      assert.equal(report.network, 'testnet');
      assert.equal(report.role, 'relayer');
      assert.equal(report.ok, false);
      assert.ok(report.issues.length > 0, 'should have issues for mismatching key');
    });
  });

  it('includes primary/fallback/public source lists', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_A.WIF;
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF = ACCOUNT_A.WIF;

      const report = reportPinnedNeoN3Role('testnet', 'relayer');
      assert.ok(report.primary_sources_present.includes('MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET'));
      assert.ok(report.fallback_sources_present.includes('MORPHEUS_RELAYER_NEO_N3_WIF'));
    });
  });

  it('supports allowMissing to suppress missing-signer issues', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      // No keys at all
      const report = reportPinnedNeoN3Role('testnet', 'relayer', { allowMissing: true });
      assert.equal(report.ok, true);
      assert.equal(report.issues.length, 0);
    });
  });
});

describe('reportPinnedNeoN3Roles', () => {
  it('returns an array of reports for multiple roles', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_A.WIF;
      process.env.MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET = ACCOUNT_A.WIF;

      const reports = reportPinnedNeoN3Roles('testnet', ['relayer', 'updater']);
      assert.equal(reports.length, 2);
      assert.equal(reports[0].role, 'relayer');
      assert.equal(reports[1].role, 'updater');
    });
  });
});

// ===================================================================
// resolvePinnedNeoN3UpdaterHash
// ===================================================================

describe('resolvePinnedNeoN3UpdaterHash', () => {
  it('returns 0x-prefixed script hash of the resolved updater', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_UPDATER_NEO_N3_WIF_TESTNET = ACCOUNT_A.WIF;

      const hash = resolvePinnedNeoN3UpdaterHash('testnet');
      assert.match(hash, /^0x[0-9a-f]{40}$/);
      assert.equal(hash, `0x${ACCOUNT_A.scriptHash}`);
    });
  });

  it('returns the pinned updater hash for read-only checks without local signer material', () => {
    withCleanSignerEnv(() => {
      const pinned = getPinnedNeoN3Role('mainnet', 'updater');
      const hash = resolvePinnedNeoN3UpdaterHash('mainnet');

      assert.equal(hash, pinned.script_hash);
    });
  });
});

// ===================================================================
// resolvePinnedNeoN3VerifierPublicKey
// ===================================================================

describe('resolvePinnedNeoN3VerifierPublicKey', () => {
  it('returns the pinned verifier public key when env has matching key', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_ORACLE_VERIFIER_WIF_TESTNET = ACCOUNT_A.WIF;

      const pubkey = resolvePinnedNeoN3VerifierPublicKey('testnet');
      assert.match(pubkey, /^[0-9a-f]{66}$/);
    });
  });

  it('throws when no verifier public key is available', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      // No oracle_verifier keys set at all
      assert.throws(
        () => resolvePinnedNeoN3VerifierPublicKey('testnet'),
        (err) => err.message.includes('no pinned verifier public key')
      );
    });
  });
});

// ===================================================================
// env snapshot: function-based env accessor
// ===================================================================

describe('env as function accessor', () => {
  it('resolves signer when env is provided as a getter function', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      const envFn = (key) => {
        if (key === 'MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET') return ACCOUNT_A.WIF;
        return '';
      };

      const report = reportPinnedNeoN3Role('testnet', 'relayer', { env: envFn });
      assert.equal(report.ok, true);
      assert.equal(report.selected_identity.address, ACCOUNT_A.address);
    });
  });
});

// ===================================================================
// Error handling for malformed keys
// ===================================================================

describe('malformed key handling', () => {
  it('records an issue when an env var contains an invalid key', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = 'not-a-valid-wif';

      const report = reportPinnedNeoN3Role('testnet', 'relayer');
      assert.ok(report.issues.length > 0, 'should have issues');
      assert.ok(
        report.issues.some((i) => i.includes('not a valid Neo N3 signer secret')),
        `expected 'not a valid' issue, got: ${report.issues.join('; ')}`
      );
    });
  });

  it('strict mode throws for malformed key', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = 'garbage-wif';

      assert.throws(
        () => resolvePinnedNeoN3Role('testnet', 'relayer'),
        (err) => err.message.includes('signer drift')
      );
    });
  });
});

// ===================================================================
// Pinned identity matching
// ===================================================================

describe('pinned identity matching', () => {
  it('detects drift when primary key does not match pinned identity', () => {
    withCleanSignerEnv(() => {
      // Do NOT set MORPHEUS_ALLOW_UNPINNED_SIGNERS -- enforce pinned
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_B.WIF;

      const report = reportPinnedNeoN3Role('testnet', 'relayer');
      assert.ok(report.issues.some((i) => i.includes('do not match pinned')));
      assert.equal(report.ok, false);
    });
  });

  it('detects disagreement among multiple primary keys', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      // Set two primary keys for testnet relayer that resolve to different identities
      process.env.MORPHEUS_RELAYER_NEO_N3_PRIVATE_KEY_TESTNET = ACCOUNT_A.privateKey;
      process.env.MORPHEUS_RELAYER_NEO_N3_WIF_TESTNET = ACCOUNT_B.WIF;

      const report = reportPinnedNeoN3Role('testnet', 'relayer');
      assert.ok(
        report.issues.some((i) => i.includes('primary keys disagree')),
        `expected disagreement issue, got: ${report.issues.join('; ')}`
      );
    });
  });
});

// ===================================================================
// NEO_N3_SIGNER_ENV_KEYS export
// ===================================================================

describe('NEO_N3_SIGNER_ENV_KEYS', () => {
  it('is a non-empty array of strings', () => {
    assert.ok(Array.isArray(NEO_N3_SIGNER_ENV_KEYS));
    assert.ok(NEO_N3_SIGNER_ENV_KEYS.length > 0);
    for (const key of NEO_N3_SIGNER_ENV_KEYS) {
      assert.equal(typeof key, 'string');
    }
  });

  it('includes the core relayer and updater env var names', () => {
    assert.ok(NEO_N3_SIGNER_ENV_KEYS.includes('MORPHEUS_WORKER_NEO_N3_WIF'));
    assert.ok(NEO_N3_SIGNER_ENV_KEYS.includes('MORPHEUS_RELAYER_NEO_N3_WIF'));
    assert.ok(NEO_N3_SIGNER_ENV_KEYS.includes('MORPHEUS_UPDATER_NEO_N3_WIF'));
    assert.ok(NEO_N3_SIGNER_ENV_KEYS.includes('MORPHEUS_ORACLE_VERIFIER_WIF'));
  });
});

// ===================================================================
// worker role: MORPHEUS_WORKER_* primary with generic NEO_N3 fallback
// ===================================================================

describe('worker signer resolution', () => {
  it('prefers the network-scoped MORPHEUS_WORKER WIF as primary source', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.MORPHEUS_WORKER_NEO_N3_WIF_TESTNET = ACCOUNT_A.WIF;

      const report = resolvePinnedNeoN3Role('testnet', 'worker');
      assert.equal(report.ok, true);
      assert.equal(report.selected_source, 'MORPHEUS_WORKER_NEO_N3_WIF_TESTNET');
      assert.equal(report.selected_identity.address, ACCOUNT_A.address);
    });
  });

  it('still resolves from a generic NEO_N3 WIF fallback when no MORPHEUS_WORKER key is set', () => {
    withCleanSignerEnv(() => {
      process.env.MORPHEUS_ALLOW_UNPINNED_SIGNERS = 'true';
      process.env.NEO_TESTNET_WIF = ACCOUNT_A.WIF;

      const report = resolvePinnedNeoN3Role('testnet', 'worker');
      assert.equal(report.ok, true);
      assert.equal(report.selected_source, 'NEO_TESTNET_WIF');
      assert.equal(report.selected_identity.address, ACCOUNT_A.address);
    });
  });
});
