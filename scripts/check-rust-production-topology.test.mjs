import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
} from './check-rust-production-topology.mjs';

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

test('Rust feed authority units must conflict with every Node compatibility writer', () => {
  const problems = checkRustFeedAuthorityUnit(
    'bad.service',
    'Conflicts=morpheus-feed-pusher.service morpheus-feed-pusher.timer\n'
  );
  assert.ok(problems.some((problem) => problem.includes('morpheus-feed-pusher-neox.service')));
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
  assert.ok(problems.some((problem) => problem.includes('default boot chain authority')));
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
