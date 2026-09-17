import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./check-network-config.mjs', import.meta.url));
const networks = ['mainnet', 'testnet'].map(
  (name) =>
    JSON.parse(readFileSync(new URL(`../config/networks/${name}.json`, import.meta.url), 'utf8'))
      .network
);

function run(args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const network of networks) {
  test(`${network}: valid configuration succeeds with and without fail-on-missing`, () => {
    for (const args of [[], ['--fail-on-missing']]) {
      const result = run(args, { MORPHEUS_NETWORK: network });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /VALIDATION PASSED/);
    }
  });

  for (const style of ['separate', 'equals']) {
    test(`${network}: ${style} expected argument enforces matching and mismatching networks`, () => {
      const args = style === 'separate' ? ['--expected', network] : [`--expected=${network}`];
      const matched = run(args, { MORPHEUS_NETWORK: network });
      assert.equal(matched.status, 0, matched.stdout + matched.stderr);
      assert.match(matched.stdout, /as expected/);
      const mismatch = run(args, { MORPHEUS_NETWORK: networks.find((value) => value !== network) });
      assert.equal(mismatch.status, 1, mismatch.stdout + mismatch.stderr);
      assert.match(mismatch.stdout, /Network mismatch/);
    });
  }
}

test('missing, blank and invalid network labels fail with and without the compatibility flag', () => {
  for (const env of [{}, { MORPHEUS_NETWORK: '  ' }, { MORPHEUS_NETWORK: 'invalid' }]) {
    for (const args of [[], ['--fail-on-missing']]) {
      const result = run(args, env);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /VALIDATION FAILED/);
    }
  }
});

test('public fallback, runtime precedence and normalized labels retain their behavior', () => {
  for (const env of [
    { NEXT_PUBLIC_MORPHEUS_NETWORK: networks[0] },
    { MORPHEUS_NETWORK: ' ', NEXT_PUBLIC_MORPHEUS_NETWORK: networks[0] },
    {
      MORPHEUS_NETWORK: ` ${networks[0].toUpperCase()} `,
      NEXT_PUBLIC_MORPHEUS_NETWORK: networks[1],
    },
  ]) {
    const result = run(['--expected', networks[0], '--fail-on-missing'], env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('malformed expected arguments cannot silently disable the gate', () => {
  for (const args of [
    ['--expected'],
    ['--expected='],
    ['--expected', ''],
    ['--expected', '--fail-on-missing'],
    ['--expected=invalid'],
    ['--expected=mainnet=ignored'],
    ['--unknown'],
  ]) {
    const result = run(args, { MORPHEUS_NETWORK: networks[0] });
    assert.equal(result.status, 1, JSON.stringify(args) + result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /argument|expected/i);
  }
});
