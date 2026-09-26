import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const consumers = [
  'examples/scripts/common.mjs',
  'scripts/lib-neo-contracts.mjs',
  'scripts/backfill-feed-pairs.mjs',
  'scripts/smoke-oracle-n3.mjs',
  'scripts/verify-canonical-domains.mjs',
  'scripts/custody-plane-e2e.mjs',
  'scripts/deploy-oracle.mjs',
  'scripts/publish-oracle-public-key.mjs',
  'scripts/publish-oracle-verifier-key.mjs',
  'scripts/set-neo-n3-updater.mjs',
  'scripts/upgrade-morpheus-datafeed.mjs',
  'scripts/upgrade-morpheus-oracle.mjs',
  'scripts/ops/call-oracle-admin.mjs',
  'scripts/ops/fix-mainnet-morpheus-runtime.mjs',
  'scripts/ops/fund-accounts.mjs',
  'scripts/ops/write-mainnet-feed-from-public-providers.mjs',
  'scripts/run-testnet-rng-local.sh',
];

test('operational N3 consumers use the reviewed network registry', () => {
  const allExampleScripts = readdirSync('examples/scripts')
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => `examples/scripts/${file}`);
  for (const file of [...consumers, ...allExampleScripts]) {
    if (file === 'examples/scripts/common.mjs') continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /\b(?:860833102|894710606)\b/,
      `${file} contains an unreviewed N3 network magic literal`
    );
  }
  const localTestnetLauncher = readFileSync('scripts/run-testnet-rng-local.sh', 'utf8');
  assert.match(localTestnetLauncher, /conflicts with the reviewed testnet identity/);
  const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(ciWorkflow, /scripts\/network-identity-consumers\.test\.mjs/);
  const addressWriter = readFileSync('scripts/write-address-registry.mjs', 'utf8');
  assert.match(addressWriter, /resolveReviewedNeoN3Magic/);

  const webConsumers = [
    'apps/web/lib/networks.ts',
    'apps/web/app/api/attestation/lookup/route.ts',
    'apps/web/app/api/control-plane/automation/execute/route.ts',
    'apps/web/app/api/control-plane/callbacks/broadcast/route.ts',
    'apps/web/app/api/internal/control-plane/feed-tick/route.ts',
    'apps/web/app/api/emergency-runtime/[...path]/route.ts',
  ];
  for (const file of webConsumers) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /===\s*['"]mainnet['"]\s*\?\s*['"]mainnet['"]\s*:\s*['"]testnet['"]|===\s*['"]mainnet['"]\s*\?\s*'mainnet'\s*:\s*'testnet'/,
      `${file} contains a fail-open network selector`
    );
  }
  const relayerConsumers = [
    'workers/morpheus-relayer/src/persistence.js',
    'workers/morpheus-relayer/src/automation.js',
    'workers/morpheus-relayer/src/workflow-persistence.js',
  ];
  for (const file of relayerConsumers) {
    assert.match(
      readFileSync(file, 'utf8'),
      /normalizeMorpheusNetwork/,
      `${file} must use the strict shared network normalizer`
    );
  }
  const controlPlaneConsumers = [
    'deploy/cloudflare/morpheus-control-plane/lib/queue-consumer.js',
    'deploy/cloudflare/morpheus-control-plane/lib/workflow-dispatch.js',
    'deploy/cloudflare/morpheus-control-plane/lib/workflows-impl.js',
  ];
  for (const file of controlPlaneConsumers) {
    const source = readFileSync(file, 'utf8');
    assert.match(
      source,
      /resolveControlPlaneNetwork/,
      `${file} must use the strict control-plane network resolver`
    );
    assert.doesNotMatch(
      source,
      /===\s*['"]mainnet['"]\s*\?\s*['"]mainnet['"]\s*:\s*['"]testnet['"]|===\s*['"]mainnet['"]\s*\?\s*'mainnet'\s*:\s*'testnet'/,
      `${file} contains a fail-open network selector`
    );
  }
});
