import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  detectUnknownEnvVars,
  formatConfigDump,
  resolveConfigReport,
  validateRelayerConfig,
} from './config-introspect.js';
import { CONFIG_SCHEMA, knownEnvAliases } from './config-schema.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// A minimal env that, combined with a feed_only mode, builds a valid config
// (no signer / oracle contract needed) so validateRelayerConfig does not crash
// on the pinned-role resolution.
function feedOnlyEnv(overrides = {}) {
  return {
    MORPHEUS_NETWORK: 'testnet',
    MORPHEUS_RELAYER_MODE: 'feed_only',
    MORPHEUS_ACTIVE_CHAINS: 'neo_n3',
    ...overrides,
  };
}

test('validate flags a missing required setting (neo_n3 oracle contract)', () => {
  // combined mode with neo_n3 active, derived keys ON (so no signer needed) but
  // no oracle contract configured -> the conditional requirement must fire.
  // An explicit config keeps the test hermetic (no real process.env / registry).
  const explicit = validateRelayerConfig({
    env: { MORPHEUS_NETWORK: 'testnet' },
    config: {
      network: 'testnet',
      mode: 'combined',
      activeChains: ['neo_n3'],
      useDerivedKeys: true,
      neo_n3: { oracleContract: '', updaterWif: '', updaterPrivateKey: '' },
      neox: {},
    },
  });

  assert.equal(explicit.ok, false);
  const keys = explicit.errors.map((error) => error.key);
  assert.ok(
    keys.includes('neo_n3.oracleContract'),
    `expected neo_n3.oracleContract error, got: ${JSON.stringify(explicit.errors)}`
  );
  // derived keys on => signer is NOT required
  assert.ok(!keys.includes('neo_n3.updaterSigner'));
});

test('validate requires the neo_n3 updater signer when derived keys are off', () => {
  const result = validateRelayerConfig({
    env: { MORPHEUS_NETWORK: 'testnet' },
    config: {
      network: 'testnet',
      mode: 'combined',
      activeChains: ['neo_n3'],
      useDerivedKeys: false,
      neo_n3: { oracleContract: '0xabc', updaterWif: '', updaterPrivateKey: '' },
      neox: {},
    },
  });
  assert.equal(result.ok, false);
  const keys = result.errors.map((error) => error.key);
  assert.ok(keys.includes('neo_n3.updaterSigner'));
  // oracle contract IS set here, so it must NOT be flagged
  assert.ok(!keys.includes('neo_n3.oracleContract'));
});

test('validate passes for a feed_only neo_n3 relayer with no signer/contract', () => {
  const result = validateRelayerConfig({
    env: { MORPHEUS_NETWORK: 'testnet' },
    config: {
      network: 'testnet',
      mode: 'feed_only',
      activeChains: ['neo_n3'],
      useDerivedKeys: false,
      neo_n3: { oracleContract: '', updaterWif: '', updaterPrivateKey: '' },
      neox: {},
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validate flags neox required settings when neox is active', () => {
  const result = validateRelayerConfig({
    env: { MORPHEUS_NETWORK: 'testnet' },
    config: {
      network: 'testnet',
      mode: 'combined',
      activeChains: ['neox'],
      useDerivedKeys: true,
      neo_n3: {},
      neox: { oracleContract: '', updaterPrivateKey: '' },
    },
  });
  assert.equal(result.ok, false);
  const keys = result.errors.map((error) => error.key);
  assert.ok(keys.includes('neox.oracleContract'));
  assert.ok(keys.includes('neox.updaterPrivateKey'));
});

test('dump redacts secrets and reports the winning alias + precedence', () => {
  const env = feedOnlyEnv({
    // a secret, set via a NON-first alias so the winning-alias reporting is
    // exercised (NITRO_API_TOKEN is the 2nd alias of nitro.token)
    NITRO_API_TOKEN: 'super-secret-token-value',
    // a non-secret set via a network-scoped alias
    MORPHEUS_RELAYER_NEO_N3_INDEXER_URL: 'https://indexer.example/rest/v1',
  });
  const dump = formatConfigDump(env);

  // The secret VALUE never appears in the dump.
  assert.ok(!dump.includes('super-secret-token-value'), 'secret value must not leak');
  assert.ok(/nitro\.token\b.*«redacted».*\[set\]/.test(dump), 'secret shown as redacted+set');
  // The winning alias for the secret is reported.
  assert.ok(dump.includes('NITRO_API_TOKEN via env'), 'winning alias + source reported');

  // A non-secret value is shown verbatim with its winning alias.
  assert.ok(dump.includes('https://indexer.example/rest/v1'));
  assert.ok(dump.includes('MORPHEUS_RELAYER_NEO_N3_INDEXER_URL via env'));

  // An unset setting shows its default and "default" source.
  assert.ok(/metricsServer\.port\b.*\(default: 9464\).*\(default\)/.test(dump));
});

test('resolveConfigReport never returns a raw secret value', () => {
  const env = feedOnlyEnv({
    MORPHEUS_RUNTIME_TOKEN: 'tok',
    MORPHEUS_RELAYER_NEOX_UPDATER_PK: '0xdeadbeef',
  });
  const report = resolveConfigReport(env);
  for (const setting of report.settings) {
    if (setting.secret && setting.set) {
      assert.equal(setting.value, '«redacted»', `${setting.key} secret must be redacted`);
    }
  }
  const token = report.settings.find((entry) => entry.key === 'nitro.token');
  assert.equal(token.set, true);
  assert.equal(token.value, '«redacted»');
  assert.equal(token.winningAlias, 'MORPHEUS_RUNTIME_TOKEN');
});

test('resolveConfigReport reports runtime_config_json precedence (env wins over packed)', () => {
  // process.env alias wins over a packed runtime-config entry, even when the
  // packed entry is an earlier alias.
  const env = feedOnlyEnv({
    MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({ LOG_FORMAT: 'text' }),
    MORPHEUS_RELAYER_LOG_FORMAT: 'pretty',
  });
  const report = resolveConfigReport(env);
  const logFormat = report.settings.find((entry) => entry.key === 'logFormat');
  assert.equal(logFormat.source, 'env');
  assert.equal(logFormat.winningAlias, 'MORPHEUS_RELAYER_LOG_FORMAT');
  assert.equal(logFormat.value, 'pretty');

  // When only the packed entry is present, it wins via runtime_config_json.
  const packedOnly = resolveConfigReport(
    feedOnlyEnv({ MORPHEUS_RUNTIME_CONFIG_JSON: JSON.stringify({ LOG_LEVEL: 'debug' }) })
  );
  const logLevel = packedOnly.settings.find((entry) => entry.key === 'logLevel');
  assert.equal(logLevel.source, 'runtime_config_json');
  assert.equal(logLevel.winningAlias, 'LOG_LEVEL');
  assert.equal(logLevel.value, 'debug');
});

test('typo detector flags a misspelled MORPHEUS_ var and suggests the closest alias', () => {
  const env = feedOnlyEnv({
    // typo of MORPHEUS_RELAYER_CONCURRENCY
    MORPHEUS_RELAYER_CONCURENCY: '8',
    // a known alias must NOT be flagged
    MORPHEUS_RELAYER_LOG_LEVEL: 'info',
  });
  const unknown = detectUnknownEnvVars(env);
  const names = unknown.map((item) => item.name);
  assert.ok(names.includes('MORPHEUS_RELAYER_CONCURENCY'));
  assert.ok(!names.includes('MORPHEUS_RELAYER_LOG_LEVEL'));
  const typo = unknown.find((item) => item.name === 'MORPHEUS_RELAYER_CONCURENCY');
  assert.equal(typo.suggestion, 'MORPHEUS_RELAYER_CONCURRENCY');
});

test('typo detector surfaces as validate warnings without affecting ok', () => {
  const result = validateRelayerConfig({
    env: { NITRO_API_TOKN: 'x' },
    config: {
      network: 'testnet',
      mode: 'feed_only',
      activeChains: ['neo_n3'],
      useDerivedKeys: false,
      neo_n3: {},
      neox: {},
    },
  });
  // feed_only with no required settings -> ok despite the typo warning
  assert.equal(result.ok, true);
  const warned = result.warnings.map((warning) => warning.name);
  assert.ok(warned.includes('NITRO_API_TOKN'));
  const warning = result.warnings.find((entry) => entry.name === 'NITRO_API_TOKN');
  assert.ok(warning.message.includes('NITRO_API_TOKEN'));
});

test('schema aliases stay truthful to config.js (drift guard)', () => {
  // Every env alias named in the schema must be resolved by config.js (the file
  // that actually reads them). This catches a stale alias added/removed in one
  // place but not the other. Some aliases are built dynamically in config.js via
  // string interpolation (network-scoped names) rather than appearing as a
  // literal — those are validated against the generic STEM that config.js does
  // contain literally.
  const configSource = fs.readFileSync(path.join(moduleDir, 'config.js'), 'utf8');
  const signerSource = fs.readFileSync(path.join(moduleDir, 'lib', 'neo-signers.js'), 'utf8');
  // The NEO_N3_SIGNER_ENV_KEYS list moved to the shared core (lib/neo-signers.js is
  // now a thin shim), so the env aliases live there — include it in the haystack.
  const coreSource = fs.readFileSync(
    path.join(moduleDir, '..', '..', '..', 'packages', 'shared', 'src', 'neo-signers-core.js'),
    'utf8'
  );
  const haystack = `${configSource}\n${signerSource}\n${coreSource}`;

  // Aliases produced by `${genericKey}_${suffix}` / `MORPHEUS_${network}_...`
  // interpolation in config.js. Each maps the dynamic alias -> the literal stem
  // that MUST appear in config.js (proving the alias is genuinely resolved).
  const dynamicAliasStems = {
    CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET: 'CONTRACT_MORPHEUS_ORACLE_HASH',
    CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET: 'CONTRACT_MORPHEUS_ORACLE_HASH',
    CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET: 'CONTRACT_MORPHEUS_DATAFEED_HASH',
    CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET: 'CONTRACT_MORPHEUS_DATAFEED_HASH',
    MORPHEUS_MAINNET_RUNTIME_URL: 'RUNTIME_URL',
    MORPHEUS_TESTNET_RUNTIME_URL: 'RUNTIME_URL',
    MORPHEUS_MAINNET_NITRO_API_URL: 'NITRO_API_URL',
    MORPHEUS_TESTNET_NITRO_API_URL: 'NITRO_API_URL',
  };

  const missing = [];
  for (const alias of knownEnvAliases()) {
    if (haystack.includes(alias)) continue;
    const stem = dynamicAliasStems[alias];
    if (stem && haystack.includes(stem)) continue;
    missing.push(alias);
  }
  assert.deepEqual(missing, [], `schema aliases not found in config.js/neo-signers.js: ${missing}`);
});

test('every schema setting has a unique key, description, and alias list', () => {
  const seen = new Set();
  for (const setting of CONFIG_SCHEMA) {
    assert.ok(typeof setting.key === 'string' && setting.key.length > 0, 'key present');
    assert.ok(!seen.has(setting.key), `duplicate schema key: ${setting.key}`);
    seen.add(setting.key);
    assert.ok(
      Array.isArray(setting.aliases) && setting.aliases.length > 0,
      `${setting.key} aliases`
    );
    assert.ok(
      typeof setting.description === 'string' && setting.description.length > 0,
      `${setting.key} description`
    );
  }
});
