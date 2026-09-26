import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AWS_CREDENTIAL_ENV_KEYS } from './aws-credentials.mjs';

// Captured when the module loads, before any test in this file runs and before
// anything here isolates the environment itself: only the preload can have
// produced this state.
const atStartup = Object.fromEntries(AWS_CREDENTIAL_ENV_KEYS.map((key) => [key, process.env[key]]));

const PRELOAD_FLAG = '--import ./src/test-support/isolate-aws-credentials.mjs';

test('the worker test script preloads the AWS credential isolation for every test file', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.ok(
    pkg.scripts.test.startsWith(`node ${PRELOAD_FLAG} --test `),
    `the test script must start with "node ${PRELOAD_FLAG} --test"; got: ${pkg.scripts.test}`
  );
});

test('this test process started with the AWS credential chain isolated', () => {
  const hint = `run the worker suite through its test script (${PRELOAD_FLAG})`;
  for (const key of AWS_CREDENTIAL_ENV_KEYS) {
    if (
      ['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED'].includes(key)
    ) {
      continue;
    }
    assert.equal(atStartup[key], undefined, `${key} was set at startup; ${hint}`);
  }
  assert.equal(
    atStartup.AWS_EC2_METADATA_DISABLED,
    'true',
    `instance metadata was reachable; ${hint}`
  );
  for (const key of ['AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE']) {
    assert.ok(atStartup[key], `${key} was not redirected at startup; ${hint}`);
    assert.equal(existsSync(atStartup[key]), false, `${key} must not exist`);
    assert.equal(existsSync(dirname(atStartup[key])), false, `${key} directory must not exist`);
  }
});
