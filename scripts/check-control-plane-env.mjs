import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDotEnv } from './lib-env.mjs';
import { trimString } from './lib-strings.mjs';
import { findCredentialDomainCollisions } from './lib-credential-separation.mjs';

const envPath = path.resolve(process.cwd(), '.env');
const strict = process.argv.includes('--strict');

function getValue(env, keys) {
  for (const key of keys) {
    const value = trimString(env[key]);
    if (value) return value;
  }
  return '';
}

function buildUrlStatus(value) {
  const raw = trimString(value);
  if (!raw) return { ok: false, value: '' };
  try {
    const parsed = new URL(raw);
    return {
      ok: parsed.protocol === 'https:' || parsed.protocol === 'http:',
      value: raw,
    };
  } catch {
    return { ok: false, value: raw };
  }
}

function isSectionConfigured(env, keys) {
  return keys.some((key) => trimString(env[key]));
}

let fileEnv = {};
try {
  fileEnv = parseDotEnv(await fs.readFile(envPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const env = {
  ...fileEnv,
  ...Object.fromEntries(
    Object.entries(process.env).map(([key, value]) => [key, trimString(value)])
  ),
};

const required = {
  control_plane_worker: [
    ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'morpheus_SUPABASE_URL'],
    ['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'morpheus_SUPABASE_SECRET_KEY'],
  ],
};

const optional = {
  auth: [['MORPHEUS_CONTROL_PLANE_API_KEY', 'MORPHEUS_OPERATOR_API_KEY']],
  rate_limit: [['UPSTASH_REDIS_REST_URL'], ['UPSTASH_REDIS_REST_TOKEN']],
  execution_plane: [
    ['MORPHEUS_MAINNET_EXECUTION_BASE_URL', 'MORPHEUS_EXECUTION_BASE_URL'],
    ['MORPHEUS_TESTNET_EXECUTION_BASE_URL', 'MORPHEUS_EXECUTION_BASE_URL'],
    [
      'MORPHEUS_MAINNET_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_MAINNET_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_MAINNET_EXECUTION_BASE_URL',
      'MORPHEUS_EXECUTION_BASE_URL',
    ],
    [
      'MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_TESTNET_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_TESTNET_EXECUTION_BASE_URL',
      'MORPHEUS_EXECUTION_BASE_URL',
    ],
    ['MORPHEUS_EXECUTION_TOKEN'],
  ],
  app_backend: [
    ['MORPHEUS_APP_BACKEND_URL'],
    ['MORPHEUS_WORKFLOW_API_KEY', 'MORPHEUS_APP_BACKEND_TOKEN'],
  ],
  web_cutover: [['MORPHEUS_CONTROL_PLANE_URL']],
};

// `--strict` promotes the worker's own runtime dependencies from a
// recommendation to a requirement. Without this the strict alias was
// byte-identical to the plain run, so "we ran the strict check" was evidence of
// nothing — and a deploy could ship a worker whose declared rate limits have no
// enforcement backend. app_backend and web_cutover stay recommendations: they
// describe callers of the worker, not what the worker needs to run.
const STRICT_REQUIRED_SECTIONS = ['auth', 'rate_limit', 'execution_plane'];

const missing = {};
for (const [section, groups] of Object.entries(required)) {
  missing[section] = groups.filter((keys) => !getValue(env, keys)).map((keys) => keys.join(' | '));
}

const optionalRecommendations = {};
for (const [section, groups] of Object.entries(optional)) {
  optionalRecommendations[section] = groups
    .filter((keys) => !getValue(env, keys))
    .map((keys) => keys.join(' | '));
}

const mainnetExecutionConfigured = Boolean(trimString(env.MORPHEUS_MAINNET_EXECUTION_BASE_URL));
const testnetExecutionConfigured = Boolean(trimString(env.MORPHEUS_TESTNET_EXECUTION_BASE_URL));
const sharedExecutionConfigured = Boolean(trimString(env.MORPHEUS_EXECUTION_BASE_URL));
const mainnetFeedExecutionConfigured = Boolean(
  getValue(env, [
    'MORPHEUS_MAINNET_FEED_EXECUTION_BASE_URL',
    'MORPHEUS_MAINNET_DATAFEED_EXECUTION_BASE_URL',
    'MORPHEUS_FEED_EXECUTION_BASE_URL',
    'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
  ])
);
const testnetFeedExecutionConfigured = Boolean(
  getValue(env, [
    'MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL',
    'MORPHEUS_TESTNET_DATAFEED_EXECUTION_BASE_URL',
    'MORPHEUS_FEED_EXECUTION_BASE_URL',
    'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
  ])
);
const executionPlaneConfigured =
  mainnetExecutionConfigured ||
  testnetExecutionConfigured ||
  sharedExecutionConfigured ||
  mainnetFeedExecutionConfigured ||
  testnetFeedExecutionConfigured ||
  Boolean(trimString(env.MORPHEUS_EXECUTION_TOKEN));
const appBackendConfigured = isSectionConfigured(env, ['MORPHEUS_APP_BACKEND_URL']);
const webCutoverConfigured = isSectionConfigured(env, ['MORPHEUS_CONTROL_PLANE_URL']);

function buildOptionalUrlStatus(value) {
  const raw = trimString(value);
  return raw ? buildUrlStatus(raw) : { ok: true, value: '' };
}

const urls = {
  control_plane_url: webCutoverConfigured
    ? buildUrlStatus(getValue(env, ['MORPHEUS_CONTROL_PLANE_URL']))
    : { ok: true, value: '' },
  app_backend_url: appBackendConfigured
    ? buildUrlStatus(getValue(env, ['MORPHEUS_APP_BACKEND_URL']))
    : { ok: true, value: '' },
  mainnet_execution_url: trimString(env.MORPHEUS_MAINNET_EXECUTION_BASE_URL)
    ? buildUrlStatus(getValue(env, ['MORPHEUS_MAINNET_EXECUTION_BASE_URL']))
    : { ok: true, value: '' },
  testnet_execution_url: trimString(env.MORPHEUS_TESTNET_EXECUTION_BASE_URL)
    ? buildUrlStatus(getValue(env, ['MORPHEUS_TESTNET_EXECUTION_BASE_URL']))
    : { ok: true, value: '' },
  mainnet_feed_execution_url: buildOptionalUrlStatus(
    getValue(env, [
      'MORPHEUS_MAINNET_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_MAINNET_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_MAINNET_EXECUTION_BASE_URL',
      'MORPHEUS_EXECUTION_BASE_URL',
    ])
  ),
  testnet_feed_execution_url: buildOptionalUrlStatus(
    getValue(env, [
      'MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_TESTNET_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_TESTNET_EXECUTION_BASE_URL',
      'MORPHEUS_EXECUTION_BASE_URL',
    ])
  ),
};

const report = {
  env_path: envPath,
  missing,
  optional_recommendations: optionalRecommendations,
  mode: {
    strict,
    strict_required_sections: STRICT_REQUIRED_SECTIONS,
    execution_plane_configured: executionPlaneConfigured,
    app_backend_configured: appBackendConfigured,
    web_cutover_configured: webCutoverConfigured,
  },
  urls,
  forbidden_signer_env: Object.keys(env)
    .filter((name) => {
      if (!trimString(env[name])) return false;
      const normalized = name.toUpperCase();
      return (
        /(?:^|_)WIF(?:_|$)/.test(normalized) ||
        (/(?:^|_)(?:PRIVATE_KEY|PK)(?:_|$)/.test(normalized) &&
          /(NEO|NEOX|EVM|MORPHEUS|SIGNER)/.test(normalized))
      );
    })
    .sort(),
  reused_runtime_credential_env: [],
  credential_domain_collisions: [],
  ok: false,
};

const runtimeCredentialValues = new Set(
  ['MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN', 'NITRO_SHARED_SECRET']
    .map((name) => trimString(env[name]))
    .filter(Boolean)
);
report.reused_runtime_credential_env = [
  'MORPHEUS_CONTROL_PLANE_API_KEY',
  'MORPHEUS_OPERATOR_API_KEY',
  'MORPHEUS_WORKFLOW_API_KEY',
  'MORPHEUS_APP_BACKEND_TOKEN',
].filter(
  (name) => Boolean(trimString(env[name])) && runtimeCredentialValues.has(trimString(env[name]))
);
report.credential_domain_collisions = findCredentialDomainCollisions(env);

const requiredOk =
  Object.values(missing).every((items) => items.length === 0) &&
  Object.values(urls).every((entry) => entry.ok);

const partiallyConfiguredMissing = {};

if (executionPlaneConfigured) {
  const executionMissing = [];
  if (mainnetExecutionConfigured || sharedExecutionConfigured) {
    if (!getValue(env, ['MORPHEUS_MAINNET_EXECUTION_BASE_URL', 'MORPHEUS_EXECUTION_BASE_URL'])) {
      executionMissing.push('MORPHEUS_MAINNET_EXECUTION_BASE_URL');
    }
  }
  if (
    mainnetFeedExecutionConfigured &&
    !getValue(env, [
      'MORPHEUS_MAINNET_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_MAINNET_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_MAINNET_EXECUTION_BASE_URL',
      'MORPHEUS_EXECUTION_BASE_URL',
    ])
  ) {
    executionMissing.push('MORPHEUS_MAINNET_FEED_EXECUTION_BASE_URL');
  }
  if (testnetExecutionConfigured || sharedExecutionConfigured) {
    if (!getValue(env, ['MORPHEUS_TESTNET_EXECUTION_BASE_URL', 'MORPHEUS_EXECUTION_BASE_URL'])) {
      executionMissing.push('MORPHEUS_TESTNET_EXECUTION_BASE_URL');
    }
  }
  if (
    testnetFeedExecutionConfigured &&
    !getValue(env, [
      'MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_TESTNET_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_FEED_EXECUTION_BASE_URL',
      'MORPHEUS_DATAFEED_EXECUTION_BASE_URL',
      'MORPHEUS_TESTNET_EXECUTION_BASE_URL',
      'MORPHEUS_EXECUTION_BASE_URL',
    ])
  ) {
    executionMissing.push('MORPHEUS_TESTNET_FEED_EXECUTION_BASE_URL');
  }
  if (!getValue(env, ['MORPHEUS_EXECUTION_TOKEN'])) {
    executionMissing.push('MORPHEUS_EXECUTION_TOKEN');
  }
  partiallyConfiguredMissing.execution_plane = executionMissing;
}

if (appBackendConfigured) {
  const backendMissing = [];
  if (!getValue(env, ['MORPHEUS_APP_BACKEND_URL'])) {
    backendMissing.push('MORPHEUS_APP_BACKEND_URL');
  }
  if (!getValue(env, ['MORPHEUS_WORKFLOW_API_KEY', 'MORPHEUS_APP_BACKEND_TOKEN'])) {
    backendMissing.push('MORPHEUS_WORKFLOW_API_KEY | MORPHEUS_APP_BACKEND_TOKEN');
  }
  partiallyConfiguredMissing.app_backend = backendMissing;
}

if (webCutoverConfigured) {
  partiallyConfiguredMissing.web_cutover = !getValue(env, ['MORPHEUS_CONTROL_PLANE_URL'])
    ? ['MORPHEUS_CONTROL_PLANE_URL']
    : [];
}

report.missing_optional_when_configured = partiallyConfiguredMissing;

const missingStrictRequired = Object.fromEntries(
  STRICT_REQUIRED_SECTIONS.map((section) => [
    section,
    strict ? (optionalRecommendations[section] ?? []) : [],
  ])
);
report.missing_strict_required = missingStrictRequired;

report.ok =
  requiredOk &&
  report.forbidden_signer_env.length === 0 &&
  report.credential_domain_collisions.length === 0 &&
  Object.values(partiallyConfiguredMissing).every((v) => v.length === 0) &&
  Object.values(missingStrictRequired).every((v) => v.length === 0);

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
