import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadNetworkMagics } from './lib-network-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./check-network-config.mjs', import.meta.url));
const EXPECTED_NETWORK_MAGICS = Object.freeze({
  mainnet: '860833102',
  testnet: '894710606',
});
const networkConfigs = ['mainnet', 'testnet'].map((name) => {
  const config = JSON.parse(
    readFileSync(new URL(`../config/networks/${name}.json`, import.meta.url), 'utf8')
  );
  return { name: config.network, magic: String(config.neo_n3.network_magic) };
});
const networks = networkConfigs.map(({ name }) => name);

test('network registry retains the canonical Neo N3 magic values', () => {
  assert.deepEqual(loadNetworkMagics(root), EXPECTED_NETWORK_MAGICS);
  for (const { name, magic } of networkConfigs) {
    assert.equal(magic, EXPECTED_NETWORK_MAGICS[name], `${name} network magic drifted`);
  }
});

test('network registry loader rejects malformed magic fields', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'neoos-network-config-'));
  try {
    const fixtureDirectory = join(fixtureRoot, 'config', 'networks');
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(
      join(fixtureDirectory, 'mainnet.json'),
      JSON.stringify({ neo_n3: { network_magic: 860833102 } })
    );
    writeFileSync(
      join(fixtureDirectory, 'testnet.json'),
      JSON.stringify({ neo_n3: { network_magic: '894710606' } })
    );
    assert.throws(() => loadNetworkMagics(fixtureRoot), /invalid network_magic.*testnet/i);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

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

  test(`${network}: configured network magic must match the canonical registry`, () => {
    const expectedMagic = networkConfigs.find(({ name }) => name === network).magic;
    const valid = run([], { MORPHEUS_NETWORK: network, NEO_NETWORK_MAGIC: expectedMagic });
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    const otherMagic = networkConfigs.find(({ name }) => name !== network).magic;
    for (const invalidMagic of [otherMagic, `${expectedMagic}x`]) {
      const invalid = run([], { MORPHEUS_NETWORK: network, NEO_NETWORK_MAGIC: invalidMagic });
      assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
      assert.match(invalid.stdout + invalid.stderr, /network magic mismatch/i);
    }
  });
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

test('missing network magic retains an explicit deployment warning', () => {
  for (const { name, magic } of networkConfigs) {
    const result = run([], { MORPHEUS_NETWORK: name });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, new RegExp(`NEO_NETWORK_MAGIC=${magic}`));
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
