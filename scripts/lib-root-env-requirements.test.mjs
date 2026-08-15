import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROOT_ENV_REQUIRED_GROUPS,
  ROOT_ENV_OPTIONAL_GROUPS,
  WEB_RUNTIME_URL_KEYS,
  evaluateRootEnvRequirements,
  getGroupValue,
} from './lib-root-env-requirements.mjs';

function satisfiedWebEnv(overrides = {}) {
  return {
    NEXT_PUBLIC_APP_NAME: 'Morpheus',
    NEXT_PUBLIC_APP_URL: 'https://app.test',
    MORPHEUS_RUNTIME_URL_TESTNET: 'https://runtime.test/testnet',
    NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SECRET_KEY: 'secret-key',
    MORPHEUS_RUNTIME_TOKEN: 'runtime-token',
    MORPHEUS_NETWORK: 'testnet',
    NEO_RPC_URL: 'https://rpc.test',
    NEO_NETWORK_MAGIC: '894710606',
    CONTRACT_MORPHEUS_ORACLE_HASH: '0xabc',
    CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH: '0xdef',
    MORPHEUS_FEED_PROVIDER: 'twelvedata',
    MORPHEUS_FEED_PROJECT_SLUG: 'morpheus',
    MORPHEUS_CRON_SECRET: 'cron-secret',
    MORPHEUS_FEED_SYMBOLS: 'TWELVEDATA:NEO-USD',
    NEO_N3_WIF: 'KwYg...',
    ...overrides,
  };
}

test('a fully configured env reports no missing required groups', () => {
  const missing = evaluateRootEnvRequirements(satisfiedWebEnv(), ROOT_ENV_REQUIRED_GROUPS);
  for (const [section, items] of Object.entries(missing)) {
    assert.deepEqual(items, [], `unexpected missing entries for ${section}`);
  }
});

test('the suffix-form network-scoped runtime URL the web app reads satisfies the web groups', () => {
  const env = satisfiedWebEnv();
  delete env.MORPHEUS_RUNTIME_URL_TESTNET;
  env.MORPHEUS_RUNTIME_URL_MAINNET = 'https://runtime.test/mainnet';
  const missing = evaluateRootEnvRequirements(env, ROOT_ENV_REQUIRED_GROUPS);
  assert.deepEqual(missing.web_public, []);
  assert.deepEqual(missing.web_server, []);
});

test('infix runtime URL names do NOT satisfy the web groups (web never reads them)', () => {
  const env = satisfiedWebEnv();
  delete env.MORPHEUS_RUNTIME_URL_TESTNET;
  env.MORPHEUS_TESTNET_RUNTIME_URL = 'https://runtime.test/testnet';
  env.MORPHEUS_MAINNET_RUNTIME_URL = 'https://runtime.test/mainnet';
  const missing = evaluateRootEnvRequirements(env, ROOT_ENV_REQUIRED_GROUPS);
  const runtimeGroupLabel = WEB_RUNTIME_URL_KEYS.join(' | ');
  assert.ok(
    missing.web_public.includes(runtimeGroupLabel),
    'web_public must flag the runtime URL group when only infix names are set'
  );
  assert.ok(
    missing.web_server.includes(runtimeGroupLabel),
    'web_server must flag the runtime URL group when only infix names are set'
  );
});

test('runtime token aliases mirror appConfig.nitroToken (NITRO_* names accepted)', () => {
  const env = satisfiedWebEnv();
  delete env.MORPHEUS_RUNTIME_TOKEN;
  env.NITRO_API_TOKEN = 'nitro-token';
  const missing = evaluateRootEnvRequirements(env, ROOT_ENV_REQUIRED_GROUPS);
  assert.deepEqual(missing.web_server, []);
});

test('missing groups are reported as pipe-joined alias lists', () => {
  const missing = evaluateRootEnvRequirements({}, ROOT_ENV_REQUIRED_GROUPS);
  assert.ok(missing.web_public.includes('NEXT_PUBLIC_APP_NAME'));
  assert.ok(missing.feed_ops.includes('MORPHEUS_CRON_SECRET'));
  assert.ok(
    missing.n3_scripts.some((entry) => entry.includes('NEO_N3_WIF | NEO_TESTNET_WIF')),
    'n3_scripts group label keeps its alias list'
  );
});

test('optional groups evaluate independently of required groups', () => {
  const missing = evaluateRootEnvRequirements({}, ROOT_ENV_OPTIONAL_GROUPS);
  assert.equal(missing.admin_api.length, 1);
  assert.equal(missing.feed_sync.length, 3);
  assert.equal(missing.oracle_verifier.length, 1);

  const satisfied = evaluateRootEnvRequirements(
    {
      ADMIN_CONSOLE_API_KEY: 'admin',
      MORPHEUS_FEED_PROVIDERS: 'twelvedata',
      MORPHEUS_FEED_CHANGE_THRESHOLD_BPS: '50',
      MORPHEUS_FEED_MIN_UPDATE_INTERVAL_MS: '60000',
      MORPHEUS_ORACLE_VERIFIER_WIF: 'KwYg...',
    },
    ROOT_ENV_OPTIONAL_GROUPS
  );
  assert.deepEqual(satisfied.admin_api, []);
  assert.deepEqual(satisfied.feed_sync, []);
  assert.deepEqual(satisfied.oracle_verifier, []);
});

test('getGroupValue trims whitespace-only values', () => {
  assert.equal(getGroupValue({ A: '   ', B: 'real' }, ['A', 'B']), 'real');
  assert.equal(getGroupValue({ A: '   ' }, ['A']), '');
});
