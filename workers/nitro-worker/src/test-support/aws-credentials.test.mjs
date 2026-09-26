import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { AWS_CREDENTIAL_ENV_KEYS, isolateAwsCredentials } from './aws-credentials.mjs';

test('isolateAwsCredentials clears every credential source and restores the environment', () => {
  const before = Object.fromEntries(AWS_CREDENTIAL_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.AWS_ACCESS_KEY_ID = 'AKIDISOLATIONTEST';
  process.env.AWS_PROFILE = 'isolation-test';
  delete process.env.AWS_CONFIG_FILE;
  const seeded = Object.fromEntries(AWS_CREDENTIAL_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    const restore = isolateAwsCredentials();
    for (const key of AWS_CREDENTIAL_ENV_KEYS) {
      if (
        ['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED'].includes(
          key
        )
      )
        continue;
      assert.equal(process.env[key], undefined, `${key} must be unset`);
    }
    assert.equal(process.env.AWS_EC2_METADATA_DISABLED, 'true');
    for (const key of ['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE']) {
      assert.ok(process.env[key], `${key} must point somewhere`);
      assert.equal(existsSync(process.env[key]), false, `${key} must not exist`);
      assert.equal(existsSync(dirname(process.env[key])), false, `${key} directory must not exist`);
    }
    restore();
    assert.deepEqual(
      Object.fromEntries(AWS_CREDENTIAL_ENV_KEYS.map((key) => [key, process.env[key]])),
      seeded
    );
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('under isolation the worker Secrets Manager client finds no credentials and sends nothing', async (t) => {
  t.after(isolateAwsCredentials());
  // HTTPS_PROXY makes platform/nitro-signer.js hand the SDK its fetch-based
  // handler, so any request the SDK attempted would land in the mock below
  // instead of leaving the process.
  const savedProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  t.after(() => {
    if (savedProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = savedProxy;
  });
  await import('@smithy/fetch-http-handler');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input) => {
    requests.push(String(input?.url ?? input));
    throw new Error('network access is not allowed in this test');
  });

  const signer = await import(`../platform/nitro-signer.js?aws-isolation=${Date.now()}`);
  signer.__resetSecretsProviderStateForTests();
  await assert.rejects(
    signer.deriveKeyBytes('morpheus/test/aws-isolation/v1', 'aws-isolation'),
    /credential/i
  );
  assert.deepEqual(requests, []);
});
