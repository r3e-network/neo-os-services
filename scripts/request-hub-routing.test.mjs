import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function readRepoFile(relativePath) {
  // Normalize: the service-block regexes below match on bare \n, while an
  // autocrlf Windows checkout materializes these YAML/Caddy files with \r\n.
  // What is under test is the file's structure, not the checkout's line endings.
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function extractCloudflareDefaultNetwork(source) {
  const match = source.match(
    /if\s*\(path === '\/' \|\| path === ''\)\s*\{\s*return\s*\{\s*network:\s*'([^']+)'/s
  );
  assert.ok(match, 'could not find Cloudflare default network');
  return match[1];
}

function extractBareCaddyRoute(source) {
  const match = source.match(
    /handle\s*\{\s*reverse_proxy ([a-z0-9-]+):8080\s*\{\s*header_up X-Morpheus-Network ([a-z]+)\s*\}\s*\}/s
  );
  assert.ok(match, 'could not find request-hub bare Caddy route');
  return { service: match[1], network: match[2] };
}

function extractNetworkCaddyRoute(source, network) {
  const match = source.match(
    new RegExp(
      `handle \/${network}\/\\*\\s*\\{\\s*reverse_proxy ([a-z0-9-]+):8080\\s*\\{\\s*header_up X-Morpheus-Network ${network}\\s*\\}\\s*\\}`,
      's'
    )
  );
  assert.ok(match, `could not find request-hub ${network} Caddy route`);
  return match[1];
}

test('request-hub bare routes stay aligned with the edge default network', () => {
  const edgeWorker = readRepoFile('deploy/cloudflare/morpheus-edge-gateway/worker.mjs');
  const standaloneCaddy = readRepoFile('deploy/nitro/Caddyfile.request-hub');
  const inlineCompose = readRepoFile('deploy/nitro/docker-compose.request-hub.yml');

  const defaultNetwork = extractCloudflareDefaultNetwork(edgeWorker);
  assert.equal(defaultNetwork, 'testnet');
  assert.deepEqual(extractBareCaddyRoute(standaloneCaddy), {
    service: 'testnet-request-worker',
    network: defaultNetwork,
  });
  assert.equal(extractNetworkCaddyRoute(standaloneCaddy, 'mainnet'), 'mainnet-request-worker');
  assert.equal(extractNetworkCaddyRoute(standaloneCaddy, 'testnet'), 'testnet-request-worker');
  assert.deepEqual(extractBareCaddyRoute(inlineCompose), {
    service: 'testnet-request-worker',
    network: defaultNetwork,
  });
  assert.equal(extractNetworkCaddyRoute(inlineCompose, 'mainnet'), 'mainnet-request-worker');
  assert.equal(extractNetworkCaddyRoute(inlineCompose, 'testnet'), 'testnet-request-worker');
});

function extractServiceBlock(source, serviceName) {
  const match = source.match(
    new RegExp(`\\n  ${serviceName}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9-]+:\\n|\\nvolumes:)`)
  );
  assert.ok(match, `could not find ${serviceName} service block`);
  return match[1];
}

for (const [composePath, services] of [
  [
    'deploy/nitro/docker-compose.request-hub.yml',
    ['mainnet-request-relayer', 'testnet-request-relayer'],
  ],
  ['deploy/nitro/docker-compose.feed-hub.yml', ['mainnet-feed-relayer', 'testnet-feed-relayer']],
]) {
  test(`${composePath} relayers expose tick-freshness healthchecks`, () => {
    const source = readRepoFile(composePath);
    for (const service of services) {
      const block = extractServiceBlock(source, service);
      assert.match(block, /healthcheck:/, `${service} should have a healthcheck`);
      assert.match(
        block,
        /workers\/morpheus-relayer\/src\/healthcheck\.js/,
        `${service} healthcheck should use the relayer freshness checker`
      );
    }
  });
}

test('request-hub services receive custody signer env and network-scoped public keys', () => {
  const source = readRepoFile('deploy/nitro/docker-compose.request-hub.yml');
  const mainnetWorkerBlock = extractServiceBlock(source, 'mainnet-request-worker');
  const testnetWorkerBlock = extractServiceBlock(source, 'testnet-request-worker');
  const mainnetBlock = extractServiceBlock(source, 'mainnet-request-relayer');
  const testnetBlock = extractServiceBlock(source, 'testnet-request-relayer');

  // Custody migration invariant (docs/SIGNER_SERVICE.md §5): the relayer holds
  // no signing key material — every signing lane resolves through the custody
  // signer service, one role key id per signing role.
  for (const [name, block] of [
    ['mainnet request relayer', mainnetBlock],
    ['testnet request relayer', testnetBlock],
  ]) {
    for (const key of [
      'SIGNER_SERVICE_URL',
      'SIGNER_SERVICE_TOKEN',
      'SIGNER_ROLE_UPDATER_KEY_ID',
      'SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID',
    ]) {
      assert.match(
        block,
        new RegExp(`${key}:\\s*\\$\\{${key}:-\\}`),
        `${name} should receive ${key}`
      );
    }
    assert.doesNotMatch(block, /WIF|PRIVATE_KEY/, `${name} must not receive signing key material`);
  }

  assert.match(
    mainnetWorkerBlock,
    /MORPHEUS_RUNTIME_CONFIG_JSON:\s*\$\{MAINNET_RUNTIME_CONFIG_JSON\}/,
    'mainnet request worker should receive only the mainnet runtime config'
  );
  assert.match(mainnetWorkerBlock, /MORPHEUS_NETWORK:\s*mainnet/);
  assert.match(
    mainnetWorkerBlock,
    /MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_MAINNET:/,
    'mainnet request worker should receive the verifier PUBLIC key for on-chain result checks'
  );
  assert.doesNotMatch(mainnetWorkerBlock, /TESTNET_RUNTIME_CONFIG_JSON|_TESTNET:-/);

  assert.match(
    testnetWorkerBlock,
    /MORPHEUS_RUNTIME_CONFIG_JSON:\s*\$\{TESTNET_RUNTIME_CONFIG_JSON\}/,
    'testnet request worker should receive only the testnet runtime config'
  );
  assert.match(testnetWorkerBlock, /MORPHEUS_NETWORK:\s*testnet/);
  assert.match(
    testnetWorkerBlock,
    /MORPHEUS_ORACLE_VERIFIER_PUBLIC_KEY_TESTNET:/,
    'testnet request worker should receive the verifier PUBLIC key for on-chain result checks'
  );
  assert.doesNotMatch(testnetWorkerBlock, /MAINNET_RUNTIME_CONFIG_JSON/);
  assert.doesNotMatch(testnetWorkerBlock, /_MAINNET:-/);

  assert.doesNotMatch(
    source,
    /WIF:\s*\$\{|PRIVATE_KEY:\s*\$\{/,
    'compose must not pass signing key material to any service'
  );
});

test('request-hub relayers and workers keep network-specific dependencies and shared storage', () => {
  const source = readRepoFile('deploy/nitro/docker-compose.request-hub.yml');
  const services = {
    mainnetWorker: extractServiceBlock(source, 'mainnet-request-worker'),
    testnetWorker: extractServiceBlock(source, 'testnet-request-worker'),
    mainnetRelayer: extractServiceBlock(source, 'mainnet-request-relayer'),
    testnetRelayer: extractServiceBlock(source, 'testnet-request-relayer'),
  };

  assert.match(
    services.mainnetRelayer,
    /mainnet-request-worker:\s*\n\s+condition: service_healthy/
  );
  assert.match(services.mainnetRelayer, /NITRO_API_URL:\s*http:\/\/mainnet-request-worker:8080/);
  assert.match(
    services.testnetRelayer,
    /testnet-request-worker:\s*\n\s+condition: service_healthy/
  );
  assert.match(services.testnetRelayer, /NITRO_API_URL:\s*http:\/\/testnet-request-worker:8080/);

  for (const [name, block] of Object.entries(services)) {
    assert.match(
      block,
      /morpheus-request-data:\/data/,
      `${name} must retain shared request storage`
    );
  }
});

test('request-hub deploy keeps both network request relayers active by default', () => {
  const source = readRepoFile('deploy/nitro/docker-compose.request-hub.yml');
  const mainnetBlock = extractServiceBlock(source, 'mainnet-request-relayer');
  const testnetBlock = extractServiceBlock(source, 'testnet-request-relayer');

  assert.doesNotMatch(mainnetBlock, /^\s+profiles:/m);
  assert.doesNotMatch(testnetBlock, /^\s+profiles:/m);
});
