import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import os from 'node:os';

import {
  HISTORICAL_MAINNET_FEED_WRITER_ALLOWLIST,
  REVIEWED_TOPOLOGY_EXCEPTIONS,
  auditBootEnabledChainWriters,
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
  discoverBootEnabledServices,
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

// ── Boot-enabled chain writers (content discovery + reviewed exceptions) ──────

const PUBLIC_WRITER_KEY = 'boot-enabled-chain-writer:morpheus-public-feed-writer';
const BEFORE_EXPIRY = '2026-09-23';

test('repository discovery finds the boot-enabled public feed writer the name pattern missed', async () => {
  // The historical discovery is by name only and never saw it.
  assert.equal(isNodeFeedWriterUnitName('morpheus-public-feed-writer.service'), false);

  const { problems, writers, excepted } = await auditBootEnabledChainWriters(undefined, {
    today: BEFORE_EXPIRY,
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(
    writers.map((writer) => writer.key),
    [PUBLIC_WRITER_KEY],
    'the only boot-enabled chain writer outside the Rust relayers'
  );
  const [writer] = writers;
  assert.equal(writer.relativePath, 'deploy/feed-pusher/morpheus-public-feed-writer.service');
  assert.deepEqual(writer.bootEnabledBy, [
    'morpheus-public-feed-writer.service',
    'morpheus-public-feed-writer.timer',
  ]);
  for (const signal of [
    /workers\/nitro-worker\/\.neoos-live-feed-write\.mjs, which is not in this repository/,
    /--execute/,
    /signer credentials from morpheus-nitro-signer\.env/,
  ]) {
    assert.ok(
      writer.signals.some((entry) => signal.test(entry)),
      `missing signal ${signal}`
    );
  }
  // Reported by name, not passed silently.
  assert.equal(excepted.length, 1);
  assert.equal(excepted[0].key, PUBLIC_WRITER_KEY);
  assert.deepEqual(excepted[0].units, [
    'deploy/feed-pusher/morpheus-public-feed-writer.service',
    'deploy/feed-pusher/morpheus-public-feed-writer.timer',
  ]);
  assert.equal(excepted[0].expiresOn, '2026-10-07');
  assert.match(excepted[0].reason, /owner decision pending, round-9 audit 3a/);
});

test('the public feed writer exception is recorded, not the unit deleted or disabled', async () => {
  const exception = REVIEWED_TOPOLOGY_EXCEPTIONS.find((entry) => entry.key === PUBLIC_WRITER_KEY);
  assert.ok(exception);
  assert.equal(exception.expiresOn, '2026-10-07');
  for (const unit of ['morpheus-public-feed-writer.service', 'morpheus-public-feed-writer.timer']) {
    const source = await fs.readFile(
      path.resolve(FIXTURE_ROOT, '../..', '..', 'deploy/feed-pusher', unit),
      'utf8'
    );
    assert.match(source, /^\[Install\]$/m, `${unit} stays boot-enabled until the owner decides`);
  }
});

test('the production topology gate runs the chain-writer audit', async () => {
  const problems = await auditProductionTopology(undefined, {
    chainWriters: { today: BEFORE_EXPIRY, exceptions: [] },
  });
  assert.ok(
    problems.some((problem) =>
      problem.startsWith('deploy/feed-pusher/morpheus-public-feed-writer.service is a boot-enabled')
    ),
    problems.join('\n')
  );
});

test('without its reviewed exception the public feed writer fails the gate by name', async () => {
  const { problems } = await auditBootEnabledChainWriters(undefined, {
    today: BEFORE_EXPIRY,
    exceptions: [],
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(
    problems[0],
    /^deploy\/feed-pusher\/morpheus-public-feed-writer\.service is a boot-enabled chain writer outside the Rust relayer authority/
  );
  assert.match(
    problems[0],
    /started at boot by morpheus-public-feed-writer\.service, morpheus-public-feed-writer\.timer/
  );
});

test('an expired, stale or malformed reviewed exception fails the gate', async () => {
  const expired = await auditBootEnabledChainWriters(undefined, { today: '2026-10-07' });
  assert.equal(expired.excepted.length, 0);
  assert.ok(
    expired.problems.some((problem) =>
      problem.includes(`reviewed exception ${PUBLIC_WRITER_KEY} expired on 2026-10-07`)
    ),
    expired.problems.join('\n')
  );

  const stale = await auditBootEnabledChainWriters(undefined, {
    today: BEFORE_EXPIRY,
    exceptions: [
      ...REVIEWED_TOPOLOGY_EXCEPTIONS,
      { key: 'boot-enabled-chain-writer:no-such-unit', reason: 'r', expiresOn: '2099-01-01' },
    ],
  });
  assert.deepEqual(stale.problems, [
    'reviewed exception boot-enabled-chain-writer:no-such-unit matches no boot-enabled chain writer under deploy/; remove it',
  ]);

  const malformed = await auditBootEnabledChainWriters(undefined, {
    today: BEFORE_EXPIRY,
    exceptions: [{ key: PUBLIC_WRITER_KEY, reason: '', expiresOn: 'soon' }],
  });
  assert.ok(malformed.problems.some((problem) => problem.includes('must carry')));
  assert.ok(
    malformed.problems.some((problem) => problem.includes('is a boot-enabled chain writer'))
  );
});

async function writeTree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'topology-writers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}

test('discovery classifies boot-enabled units by content, not by name', async (t) => {
  const root = await writeTree(t, {
    // An innocuously named writer, started only by its timer: found by the
    // chain-write call in the script it runs.
    'deploy/ops/nightly-sync.service': [
      '[Unit]',
      'Description=Nightly sync',
      '[Service]',
      'WorkingDirectory=/opt/neoos/services/deploy/ops',
      'ExecStart=/usr/bin/node sync.mjs',
    ].join('\n'),
    'deploy/ops/nightly-sync.timer':
      '[Timer]\nOnCalendar=daily\n[Install]\nWantedBy=timers.target\n',
    'deploy/ops/sync.mjs': "await rpc('sendrawtransaction', [raw]);\n",
    // A boot-enabled Node monitor that writes nothing: not a writer.
    'deploy/ops/monitor.service': [
      '[Service]',
      'WorkingDirectory=/opt/neoos/services/deploy/ops',
      'ExecStart=/usr/bin/node monitor.mjs',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n'),
    'deploy/ops/monitor.mjs': "console.log(await rpc('getblockcount'));\n",
    // The Rust authority is not reported; a second delivery loop under another
    // name is.
    'deploy/systemd/morpheus-relayer.service':
      '[Service]\nExecStart=/opt/neoos/services/bin/neo-os-relayer loop\n[Install]\nWantedBy=multi-user.target\n',
    'deploy/ops/shadow-relayer.service':
      '[Service]\nExecStart=/opt/neoos/services/bin/neo-os-relayer loop\n[Install]\nWantedBy=multi-user.target\n',
    // A writer that is not boot-enabled (no [Install], no enabled timer): not ours.
    'deploy/ops/manual-writer.service':
      '[Unit]\nDescription=Manual feed writer\n[Service]\nExecStart=/usr/bin/node push.mjs --execute\n',
    // A timer that starts a unit nobody shipped.
    'deploy/ops/ghost.timer':
      '[Timer]\nUnit=ghost-writer.service\n[Install]\nWantedBy=timers.target\n',
    // A boot-enabled npm package script: its entry point cannot be traced.
    'deploy/ops/npm-worker.service':
      '[Service]\nExecStart=/usr/bin/npm --prefix workers/x run start\n[Install]\nWantedBy=multi-user.target\n',
  });

  const services = await discoverBootEnabledServices(root);
  assert.deepEqual(
    services.map((entry) => [entry.service, entry.via]),
    [
      ['ghost-writer.service', ['ghost.timer']],
      ['monitor.service', ['monitor.service']],
      ['morpheus-relayer.service', ['morpheus-relayer.service']],
      ['nightly-sync.service', ['nightly-sync.timer']],
      ['npm-worker.service', ['npm-worker.service']],
      ['shadow-relayer.service', ['shadow-relayer.service']],
    ]
  );

  const { problems, writers } = await auditBootEnabledChainWriters(root, {
    today: BEFORE_EXPIRY,
    exceptions: [],
  });
  assert.deepEqual(
    writers.map((writer) => writer.service),
    ['nightly-sync.service', 'npm-worker.service', 'shadow-relayer.service']
  );
  assert.ok(
    writers[0].signals.includes('runs deploy/ops/sync.mjs, which signs or broadcasts transactions')
  );
  assert.deepEqual(writers[1].signals, [
    'runs npm --prefix workers/x run start, whose entry point cannot be traced',
  ]);
  assert.deepEqual(writers[2].signals, ['runs the Rust relayer delivery loop']);
  assert.equal(problems.length, 4, problems.join('\n'));
  assert.ok(
    problems.some((problem) => problem.startsWith('ghost.timer starts ghost-writer.service'))
  );
  assert.ok(problems.some((problem) => problem.startsWith('deploy/ops/nightly-sync.service is')));
  assert.ok(problems.some((problem) => problem.startsWith('deploy/ops/shadow-relayer.service is')));
});
