import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  HISTORICAL_MAINNET_FEED_WRITER_ALLOWLIST,
  auditNodeFeedWriterTopology,
  auditProductionTopology,
  checkAuthorityUnit,
  checkCompatCompose,
  checkCustodyBuildScript,
  checkNodeFeedCompatUnit,
  checkPublishWorkflow,
  checkRelayerDockerfile,
  checkRustFeedAuthorityUnit,
  checkSignerDockerfile,
  checkSignerStartScript,
  checkWriterEnablePostureInDocs,
  compatibilityMarkerForFeedWriter,
  discoverNodeFeedWriterUnits,
  isNodeFeedWriterUnitName,
} from './check-rust-production-topology.mjs';

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/feed-writer-topology'
);
const MISSED_TESTNET_ROOT = path.join(FIXTURE_ROOT, 'missed-testnet-writer');
const COMPLIANT_TESTNET_ROOT = path.join(FIXTURE_ROOT, 'compliant-testnet-writer');

test('repository production topology keeps Rust authority and explicit compatibility boundaries', async () => {
  assert.deepEqual(await auditProductionTopology(), []);
});

test('publish policy rejects Node authority images and floating tags', () => {
  const problems = checkPublishWorkflow(`
    dockerfile: workers/morpheus-relayer/Dockerfile
    image: neo-os-services-relayer
    tags: type=raw,value=latest
  `);
  assert.ok(problems.some((problem) => problem.includes('Node worker/relayer')));
  assert.ok(problems.some((problem) => problem.includes('immutable SHA')));
});

test('publish policy rejects the retired relayer preview alias', () => {
  const problems = checkPublishWorkflow('image: neo-os-services-relayer-preview\n');
  assert.ok(problems.some((problem) => problem.includes('retired relayer preview')));
});

test('authority units cannot launch npm behind a production-looking name', () => {
  const problems = checkAuthorityUnit(
    'bad.service',
    '[Service]\nExecStart=/usr/bin/npm --prefix workers/morpheus-relayer run start\n'
  );
  assert.ok(problems.some((problem) => problem.includes('launches Node')));
  assert.ok(problems.some((problem) => problem.includes('production safety contract')));
});

test('production authority units reject the retired relayer preview marker', () => {
  const problems = checkAuthorityUnit(
    'stale.service',
    [
      'ConditionPathExists=/opt/morpheus/nitro/ENABLE_RUST_RELAYER_PREVIEW',
      'Environment=NODE_ENV=production',
      'ExecStartPre=/opt/neoos/services/bin/neo-os-relayer config:validate',
      'ExecStart=/opt/neoos/services/bin/neo-os-relayer loop',
    ].join('\n')
  );
  assert.ok(problems.some((problem) => problem.includes('obsolete')));
});

test('Rust feed authority units must conflict with every discovered Node compatibility writer', () => {
  const problems = checkRustFeedAuthorityUnit(
    'bad.service',
    'Conflicts=morpheus-feed-pusher.service morpheus-feed-pusher.timer\n',
    [
      'morpheus-feed-pusher.service',
      'morpheus-feed-pusher.timer',
      'morpheus-feed-pusher-neox.service',
      'morpheus-feed-pusher-testnet.service',
    ]
  );
  assert.ok(problems.some((problem) => problem.includes('morpheus-feed-pusher-neox.service')));
  assert.ok(problems.some((problem) => problem.includes('morpheus-feed-pusher-testnet.service')));
});

test('Node feed writers require an explicit marker, mutual exclusion, and no boot install', () => {
  const problems = checkNodeFeedCompatUnit(
    'bad.timer',
    [
      'Description=Node writer',
      'Conflicts=morpheus-relayer.service',
      '[Install]',
      'WantedBy=timers.target',
    ].join('\n')
  );
  assert.ok(problems.some((problem) => problem.includes('compatibility-only')));
  assert.ok(problems.some((problem) => problem.includes('compatibility marker')));
  assert.ok(problems.some((problem) => problem.includes('morpheus-relayer-nitro.service')));
  assert.ok(problems.some((problem) => problem.includes('start before Rust authority')));
  assert.ok(problems.some((problem) => problem.includes('default boot chain authority')));
});

test('Node feed writers must order themselves before both Rust relayers', () => {
  const problems = checkNodeFeedCompatUnit(
    'no-before.service',
    [
      'Description=COMPATIBILITY ONLY',
      'ConditionPathExists=/opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT',
      'Conflicts=morpheus-relayer.service morpheus-relayer-nitro.service',
    ].join('\n')
  );
  assert.ok(problems.some((problem) => problem.includes('start before Rust authority')));
});

test('each Node chain writer uses its dedicated compatibility marker', () => {
  const problems = checkNodeFeedCompatUnit(
    'topup.service',
    [
      'Description=COMPATIBILITY ONLY',
      'ConditionPathExists=/opt/morpheus/nitro/ENABLE_NODE_FEED_PUSHER_COMPAT',
      'Conflicts=morpheus-relayer.service morpheus-relayer-nitro.service',
    ].join('\n'),
    'ENABLE_NODE_FEE_TOPUP_COMPAT'
  );
  assert.ok(problems.some((problem) => problem.includes('ENABLE_NODE_FEE_TOPUP_COMPAT')));
});

test('signer image must replace the dependency-graph stub with real EVM sources', () => {
  const problems = checkSignerDockerfile(
    'COPY crates/neo-os-chain-evm/Cargo.toml crates/neo-os-chain-evm/Cargo.toml\n'
  );
  assert.ok(problems.some((problem) => problem.includes('real neo-os-chain-evm sources')));
  assert.ok(problems.some((problem) => problem.includes('caller-visible custody bridge')));
  assert.ok(problems.some((problem) => problem.includes('measured workload audience')));
});

test('custody build must measure the caller-visible workload audience', () => {
  const problems = checkCustodyBuildScript('docker build -f Dockerfile.signer .\n');
  assert.ok(problems.some((problem) => problem.includes('caller-visible host port')));
  assert.ok(problems.some((problem) => problem.includes('measure the configured')));
});

test('relayer image must replace every direct path-dependency stub with real sources', () => {
  const problems = checkRelayerDockerfile(
    'COPY crates/neo-os-core ./crates/neo-os-core\nCOPY crates/nitro-attest ./crates/nitro-attest\n'
  );
  assert.ok(problems.some((problem) => problem.includes('neo-os-chain-evm')));
  assert.ok(problems.some((problem) => problem.includes('neo-os-relayer-store')));
});

test('Nitro provisioning refuses incomplete or unhealthy measured custody roles', () => {
  const problems = checkSignerStartScript(
    '["updater", "oracle_verifier", "relayer", "worker", "neox_updater"]\n'
  );
  assert.ok(problems.some((problem) => problem.includes('neox_verifier')));
  assert.ok(problems.some((problem) => problem.includes('unhealthy')));
});

test('compat compose requires unambiguous pinned image variables', () => {
  const problems = checkCompatCompose(
    'bad.yml',
    'services:\n  relayer:\n    image: ${MORPHEUS_RELAYER_IMAGE:-x:latest}\n'
  );
  assert.ok(problems.some((problem) => problem.includes('not labelled')));
  assert.ok(problems.some((problem) => problem.includes('ambiguous')));
  assert.ok(problems.some((problem) => problem.includes('floating')));
});

test('discovery classifies writer units and ignores monitors', () => {
  assert.equal(isNodeFeedWriterUnitName('morpheus-feed-pusher-testnet.timer'), true);
  assert.equal(isNodeFeedWriterUnitName('morpheus-feed-topup-future.service'), true);
  assert.equal(isNodeFeedWriterUnitName('morpheus-neox-fulfiller.service'), true);
  assert.equal(isNodeFeedWriterUnitName('morpheus-feed-monitor-testnet.timer'), false);
  assert.equal(isNodeFeedWriterUnitName('morpheus-db-prune.service'), false);
  assert.equal(
    compatibilityMarkerForFeedWriter('morpheus-feed-pusher-testnet.service'),
    'ENABLE_NODE_FEED_PUSHER_COMPAT'
  );
  assert.equal(
    compatibilityMarkerForFeedWriter('morpheus-feed-topup.timer'),
    'ENABLE_NODE_FEE_TOPUP_COMPAT'
  );
  assert.equal(
    compatibilityMarkerForFeedWriter('morpheus-neox-fulfiller.service'),
    'ENABLE_NODE_NEOX_FULFILLER_COMPAT'
  );
});

test('a mainnet-only allowlist misses a boot-enabled testnet writer', async () => {
  const discovered = await discoverNodeFeedWriterUnits(MISSED_TESTNET_ROOT);
  const names = discovered.map((unit) => unit.fileName);
  assert.ok(names.includes('morpheus-feed-pusher-testnet.service'));
  assert.ok(names.includes('morpheus-feed-pusher-testnet.timer'));
  assert.ok(!names.includes('morpheus-feed-monitor-testnet.timer'));

  const leaked = names.filter((name) => !HISTORICAL_MAINNET_FEED_WRITER_ALLOWLIST.includes(name));
  assert.deepEqual(leaked.sort(), [
    'morpheus-feed-pusher-testnet.service',
    'morpheus-feed-pusher-testnet.timer',
  ]);

  const allowlistProblems = [];
  for (const unit of discovered.filter((entry) =>
    HISTORICAL_MAINNET_FEED_WRITER_ALLOWLIST.includes(entry.fileName)
  )) {
    const source = await fs.readFile(path.join(MISSED_TESTNET_ROOT, unit.relativePath), 'utf8');
    allowlistProblems.push(
      ...checkNodeFeedCompatUnit(
        unit.relativePath,
        source,
        compatibilityMarkerForFeedWriter(unit.fileName)
      )
    );
  }
  assert.deepEqual(allowlistProblems, []);

  const { problems } = await auditNodeFeedWriterTopology(MISSED_TESTNET_ROOT);
  assert.ok(problems.some((problem) => problem.includes('morpheus-feed-pusher-testnet.timer')));
  assert.ok(problems.some((problem) => problem.includes('default boot chain authority')));
  assert.ok(
    problems.some((problem) =>
      problem.includes(
        'does not conflict with Node compatibility writer morpheus-feed-pusher-testnet.service'
      )
    )
  );
  assert.ok(
    problems.some((problem) =>
      problem.includes('still enables Node chain writer morpheus-feed-pusher-testnet')
    )
  );
});

test('compliant discovered testnet writer units pass the topology checks', async () => {
  const { problems, writers } = await auditNodeFeedWriterTopology(COMPLIANT_TESTNET_ROOT);
  assert.deepEqual(writers.map((unit) => unit.fileName).sort(), [
    'morpheus-feed-pusher-testnet.service',
    'morpheus-feed-pusher-testnet.timer',
  ]);
  assert.deepEqual(problems, []);
});

test('repository discovery includes the live testnet writer units', async () => {
  const discovered = await discoverNodeFeedWriterUnits();
  const names = discovered.map((unit) => unit.fileName);
  assert.ok(names.includes('morpheus-feed-pusher-testnet.service'));
  assert.ok(names.includes('morpheus-feed-pusher-testnet.timer'));
  assert.ok(names.includes('morpheus-feed-pusher.service'));
});

test('operator docs cannot enable a discovered writer by default', () => {
  const problems = checkWriterEnablePostureInDocs(
    'docs/TESTNET-FEED-WRITER.md',
    'systemctl enable --now morpheus-feed-pusher-testnet.timer\n',
    ['morpheus-feed-pusher-testnet']
  );
  assert.ok(problems.some((problem) => problem.includes('morpheus-feed-pusher-testnet')));
});

test('compose cannot collapse NeoX submission and fulfillment-proof roles', () => {
  const problems = checkCompatCompose(
    'bad-neox.yml',
    [
      '# NODE COMPATIBILITY ONLY',
      'image: ${MORPHEUS_COMPAT_RELAYER_IMAGE:?pin-explicit-node-compat-relayer-image}',
      'SIGNER_ROLE_NEOX_UPDATER_KEY_ID: ${SIGNER_ROLE_NEOX_UPDATER_KEY_ID:-}',
    ].join('\n')
  );
  assert.ok(problems.some((problem) => problem.includes('distinct verifier role')));
});
