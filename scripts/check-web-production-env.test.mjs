import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatMissingGroups,
  parseEnvironmentFile,
  validateWebProductionEnvironment,
} from './check-web-production-env.mjs';

const baseline = {
  MORPHEUS_RUNTIME_URL: 'https://confidential.example.com',
  MORPHEUS_RUNTIME_TOKEN: 'runtime-token',
  MORPHEUS_CONTROL_PLANE_API_KEY: 'control-plane-token',
  MORPHEUS_WORKFLOW_API_KEY: 'workflow-token',
  MORPHEUS_SIGNING_ADMIN_API_KEY: 'signing-admin-token',
  MORPHEUS_RELAY_ADMIN_API_KEY: 'relay-admin-token',
  MORPHEUS_CRON_SECRET: 'cron-token',
  morpheus_SUPABASE_URL: 'https://supabase.example.com',
  morpheus_SUPABASE_SERVICE_ROLE_KEY: 'service-key',
};

test('accepts native Upstash credentials', () => {
  const result = validateWebProductionEnvironment({
    ...baseline,
    UPSTASH_REDIS_REST_URL: 'https://upstash.example.com',
    UPSTASH_REDIS_REST_TOKEN: 'token',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('accepts Vercel Marketplace Redis credentials', () => {
  const result = validateWebProductionEnvironment({
    ...baseline,
    KV_REST_API_URL: 'https://marketplace.example.com',
    KV_REST_API_TOKEN: 'token',
  });
  assert.equal(result.ok, true);
});

test('accepts the transactional Supabase rate-limit backend', () => {
  const result = validateWebProductionEnvironment(baseline);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('rejects mixed or incomplete Redis credentials when Supabase service auth is absent', () => {
  const result = validateWebProductionEnvironment({
    MORPHEUS_RUNTIME_URL: baseline.MORPHEUS_RUNTIME_URL,
    MORPHEUS_RUNTIME_TOKEN: baseline.MORPHEUS_RUNTIME_TOKEN,
    MORPHEUS_CONTROL_PLANE_API_KEY: baseline.MORPHEUS_CONTROL_PLANE_API_KEY,
    MORPHEUS_WORKFLOW_API_KEY: baseline.MORPHEUS_WORKFLOW_API_KEY,
    MORPHEUS_SIGNING_ADMIN_API_KEY: baseline.MORPHEUS_SIGNING_ADMIN_API_KEY,
    MORPHEUS_RELAY_ADMIN_API_KEY: baseline.MORPHEUS_RELAY_ADMIN_API_KEY,
    MORPHEUS_CRON_SECRET: baseline.MORPHEUS_CRON_SECRET,
    morpheus_SUPABASE_URL: baseline.morpheus_SUPABASE_URL,
    UPSTASH_REDIS_REST_URL: 'https://upstash.example.com',
    KV_REST_API_TOKEN: 'wrong-provider-token',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.missing.map((group) => group.name),
    ['supabase_service_key', 'distributed_rate_limit']
  );
  const distributedLine = formatMissingGroups(result.missing).find((line) =>
    line.startsWith('distributed_rate_limit:')
  );
  assert.match(distributedLine, /UPSTASH_REDIS_REST_URL/);
  assert.match(distributedLine, /KV_REST_API_URL/);
});

test('runtime auth does not satisfy control-plane or workflow auth', () => {
  const result = validateWebProductionEnvironment({
    ...baseline,
    MORPHEUS_CONTROL_PLANE_API_KEY: '',
    MORPHEUS_WORKFLOW_API_KEY: '',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.missing.map((group) => group.name),
    ['control_plane_auth', 'workflow_auth']
  );
});

test('a public runtime URL does not satisfy the confidential production route', () => {
  const result = validateWebProductionEnvironment({
    ...baseline,
    MORPHEUS_RUNTIME_URL: '',
    NEXT_PUBLIC_MORPHEUS_RUNTIME_URL: 'https://oracle.meshmini.app/mainnet',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.missing.map((group) => group.name),
    ['confidential_runtime_url']
  );
});

test('rejects control-plane credentials that reuse the runtime token value', () => {
  const result = validateWebProductionEnvironment({
    ...baseline,
    MORPHEUS_CONTROL_PLANE_API_KEY: baseline.MORPHEUS_RUNTIME_TOKEN,
    MORPHEUS_WORKFLOW_API_KEY: baseline.MORPHEUS_RUNTIME_TOKEN,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.reusedRuntimeCredentialEnv, [
    'MORPHEUS_CONTROL_PLANE_API_KEY',
    'MORPHEUS_WORKFLOW_API_KEY',
  ]);
});

test('rejects every cross-domain production credential collision', () => {
  const result = validateWebProductionEnvironment({
    ...baseline,
    MORPHEUS_RELAYER_API_KEY: 'shared-privileged-token',
    MORPHEUS_SIGNING_ADMIN_API_KEY: 'shared-privileged-token',
    MORPHEUS_RELAY_ADMIN_API_KEY: 'shared-privileged-token',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.credentialDomainCollisions, [
    {
      domains: ['relay', 'relayer', 'signing'],
      names: [
        'MORPHEUS_RELAYER_API_KEY',
        'MORPHEUS_RELAY_ADMIN_API_KEY',
        'MORPHEUS_SIGNING_ADMIN_API_KEY',
      ],
    },
  ]);
});

test('rejects host WIF/private-key variables in Vercel production', () => {
  const result = validateWebProductionEnvironment({
    ...baseline,
    MORPHEUS_RELAYER_NEO_N3_WIF: 'host-key',
    NEOX_UPDATER_PK: '0xhost-key',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.forbiddenSignerEnv, ['MORPHEUS_RELAYER_NEO_N3_WIF', 'NEOX_UPDATER_PK']);
});

test('parses Vercel dotenv output without exposing values', () => {
  assert.deepEqual(
    parseEnvironmentFile(`
# Generated by Vercel
export MORPHEUS_RUNTIME_TOKEN="runtime-token"
KV_REST_API_URL='https://marketplace.example.com'
KV_REST_API_TOKEN=token
INVALID LINE
`),
    {
      MORPHEUS_RUNTIME_TOKEN: 'runtime-token',
      KV_REST_API_URL: 'https://marketplace.example.com',
      KV_REST_API_TOKEN: 'token',
    }
  );
});
