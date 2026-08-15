import test from 'node:test';
import assert from 'node:assert/strict';
import { isSecretName, SECRET_NAME_PATTERN } from './secret-redaction.js';

test('isSecretName covers every fragment the config-dump redactor used', () => {
  // The former config-schema SECRET_NAME_FRAGMENTS list (uppercase env names).
  for (const name of [
    'NEO_N3_UPDATER_WIF',
    'MORPHEUS_RELAYER_NEOX_UPDATER_PRIVATE_KEY',
    'SOME_PRIVATEKEY',
    'NITRO_API_TOKEN',
    'MORPHEUS_SUPABASE_SERVICE_ROLE_KEY',
    'MORPHEUS_SUPABASE_SERVICE_KEY',
    'DB_PASSWORD',
    'WALLET_PASSPHRASE',
    'RECOVERY_SEED',
    'WALLET_MNEMONIC',
    'GENERIC_SECRET',
  ]) {
    assert.equal(isSecretName(name), true, `${name} must be detected as secret`);
  }
});

test('isSecretName covers every fragment the structured logger used', () => {
  for (const key of [
    'wif',
    'privateKey',
    'private_key',
    'apiKey',
    'api_key',
    'secret',
    'token',
    'authorization',
    'envelope',
    'plaintext',
    'seed',
  ]) {
    assert.equal(isSecretName(key), true, `${key} must be detected as secret`);
  }
});

test('isSecretName closes the former cross-sink coverage gaps', () => {
  // Previously LEAKED by config-dump (its list lacked api_key): an env var
  // holding an API key would have had its value printed verbatim.
  assert.equal(isSecretName('TWELVEDATA_API_KEY'), true);
  assert.equal(isSecretName('SOME_PROVIDER_APIKEY'), true);
  // Previously LEAKED by the logger (its regex lacked these): a structured-log
  // key under one of these names would have egressed in cleartext.
  assert.equal(isSecretName('service_role_key'), true);
  assert.equal(isSecretName('serviceRoleKey'), true);
  assert.equal(isSecretName('password'), true);
  assert.equal(isSecretName('passphrase'), true);
  assert.equal(isSecretName('mnemonic'), true);
});

test('isSecretName does not flag ordinary non-secret identifiers', () => {
  for (const value of [
    'MORPHEUS_RELAYER_NEO_N3_INDEXER_URL',
    'MORPHEUS_NETWORK',
    'metricsServer.port',
    'requestId',
    'rpcUrl',
    'status',
  ]) {
    assert.equal(isSecretName(value), false, `${value} must NOT be flagged secret`);
  }
});

test('isSecretName rejects non-string inputs', () => {
  assert.equal(isSecretName(null), false);
  assert.equal(isSecretName(undefined), false);
  assert.equal(isSecretName(123), false);
  assert.equal(isSecretName({ token: 'x' }), false);
});

test('SECRET_NAME_PATTERN is case-insensitive and substring-matching', () => {
  assert.match('FOO_WIF_BAR', SECRET_NAME_PATTERN);
  assert.match('xTokenY', SECRET_NAME_PATTERN);
});
