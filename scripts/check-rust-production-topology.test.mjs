import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

test('generic publish rejects custody images without dropping its dedicated recipe or Rust gate', async () => {
  const source = await fs.readFile(
    new URL('../.github/workflows/publish-images.yml', import.meta.url),
    'utf8'
  );
  assert.deepEqual(checkPublishWorkflow(source), []);
  const row = `          - name: signer
            dockerfile: deploy/nitro/Dockerfile.signer
            image: ghcr.io/\${{ github.repository_owner }}/neo-os-services-signer
`;
  for (const mutant of [
    source.replace('          - name: relayer', row + '          - name: relayer'),
    source.replace(
      'dockerfile: deploy/nitro/Dockerfile.relayer',
      'dockerfile: deploy/nitro/Dockerfile.signer'
    ),
    source.replace(
      'dockerfile: deploy/nitro/Dockerfile.relayer',
      'dockerfile: deploy/nitro/Dockerfile.signer-legacy'
    ),
    source.replaceAll('-p neo-signer', '-p another-package'),
  ]) {
    assert.notEqual(mutant, source);
    assert.notDeepEqual(checkPublishWorkflow(mutant), []);
  }
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
// The exception was first dated 2026-10-07 and renewed once, for 14 days (DEC-CU-3). `expiresOn` is
// the first UTC day the exception no longer holds, so 2026-10-20 is the last day it covers.
const ORIGINAL_EXPIRY = '2026-10-07';
const RENEWED_EXPIRY = '2026-10-21';
const LAST_COVERED_DAY = '2026-10-20';
const IN_WINDOW = '2026-10-15';

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
  assert.equal(excepted[0].expiresOn, RENEWED_EXPIRY);
  assert.match(excepted[0].reason, /Owner: NeoOS program lead \(delegated by the owner\)/);
  assert.match(excepted[0].reason, /Condition: the owner caps the writer cadence/);
});

test('the public feed writer exception is recorded, not the unit deleted or disabled', async () => {
  const exception = REVIEWED_TOPOLOGY_EXCEPTIONS.find((entry) => entry.key === PUBLIC_WRITER_KEY);
  assert.ok(exception);
  assert.equal(exception.expiresOn, RENEWED_EXPIRY);
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
  const expired = await auditBootEnabledChainWriters(undefined, { today: RENEWED_EXPIRY });
  assert.equal(expired.excepted.length, 0);
  assert.ok(
    expired.problems.some((problem) =>
      problem.includes(`reviewed exception ${PUBLIC_WRITER_KEY} expired on ${RENEWED_EXPIRY}`)
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

// ── The exception renewed once, to 2026-10-21 (CU-21, DEC-CU-3) ────────────────
// The renewal changes the entry and nothing else, so these tests pin both: the entry (date,
// owner, condition, one renewal) and the gate around it (every other rule, the whole gate at
// the boundary, and the CLI exit path with a pinned clock).

const REPO_ROOT = path.resolve(FIXTURE_ROOT, '..', '..', '..');
const PUBLIC_WRITER_UNIT = 'deploy/feed-pusher/morpheus-public-feed-writer.service';
const PUBLIC_WRITER_TIMER = 'deploy/feed-pusher/morpheus-public-feed-writer.timer';
// sha256 of PUBLIC_WRITER_UNIT as reviewed on 2026-10-05. The gate keys the exception by unit
// name only (SVC-V10), so this hash is what ties the renewal to the unit that was reviewed.
const REVIEWED_WRITER_UNIT_SHA256 =
  '4241f91f6b05c51d4ee97ebb2067ff3c6be0389f682fdce73a65d87457805dad';

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function daysBetween(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

async function readShippedWriterUnits() {
  const [service, timer] = await Promise.all([
    fs.readFile(path.join(REPO_ROOT, PUBLIC_WRITER_UNIT), 'utf8'),
    fs.readFile(path.join(REPO_ROOT, PUBLIC_WRITER_TIMER), 'utf8'),
  ]);
  return { service, timer };
}

test('the renewed exception covers 2026-10-20 and every day from 2026-10-21 fails, on the real tree', async () => {
  for (const today of ['2026-10-05', '2026-10-06', ORIGINAL_EXPIRY, IN_WINDOW, LAST_COVERED_DAY]) {
    const { problems, excepted } = await auditBootEnabledChainWriters(undefined, { today });
    assert.deepEqual(problems, [], `${today} is covered`);
    assert.deepEqual(
      excepted.map((entry) => [entry.key, entry.expiresOn]),
      [[PUBLIC_WRITER_KEY, RENEWED_EXPIRY]],
      `${today} reports the excepted unit by name`
    );
  }
  for (const today of [RENEWED_EXPIRY, '2026-10-22', '2026-11-20', '2027-10-20', '2099-12-31']) {
    const { problems, writers, excepted } = await auditBootEnabledChainWriters(undefined, {
      today,
    });
    assert.equal(problems.length, 1, `${today}: ${problems.join('\n')}`);
    assert.ok(
      problems[0].startsWith(
        `${PUBLIC_WRITER_UNIT}: reviewed exception ${PUBLIC_WRITER_KEY} expired on ${RENEWED_EXPIRY} (`
      ),
      problems[0]
    );
    assert.deepEqual(excepted, [], `${today} reports nothing as excepted`);
    assert.equal(writers.length, 1, `${today} still discovers the writer`);
  }
});

test('the shipped exception is one entry, renewed once for 14 days, naming its owner and condition', () => {
  assert.equal(
    REVIEWED_TOPOLOGY_EXCEPTIONS.length,
    1,
    'one reviewed exception, for the public feed writer'
  );
  const exception = REVIEWED_TOPOLOGY_EXCEPTIONS.find((entry) => entry.key === PUBLIC_WRITER_KEY);
  assert.ok(exception);
  assert.deepEqual(
    Object.keys(exception).sort(),
    ['expiresOn', 'key', 'reason'],
    'the exception schema is unchanged'
  );
  assert.ok(isRealDate(exception.expiresOn), `${exception.expiresOn} is a real calendar date`);
  assert.equal(
    daysBetween(ORIGINAL_EXPIRY, exception.expiresOn),
    14,
    'renewed once, for 14 days (DEC-CU-3): a further renewal needs a new recorded decision and a change to this test'
  );
  const { reason } = exception;
  // What the exception tolerates, as first reviewed.
  assert.match(reason, /boot-enabled every 60 s/);
  assert.match(
    reason,
    /workers\/nitro-worker\/\.neoos-live-feed-write\.mjs --execute \(in no repository\)/
  );
  assert.match(reason, /outside the Rust relayer authority and absent from its Conflicts=/);
  assert.match(reason, /kept running, not deleted or disabled/);
  // Who answers for it, and what has to hold while it stands.
  assert.match(reason, /Owner: NeoOS program lead \(delegated by the owner\)/);
  assert.match(
    reason,
    /Condition: the owner caps the writer cadence and funds the updater to at least 30 days \(OP-02\)/
  );
  assert.match(reason, /the runway and stale alerts exist \(CU-11\)/);
  assert.match(reason, /replaces this unit in the 2026-10-21 enclave rebuild window/);
  assert.match(reason, /no second renewal/);
});

test('the excepted unit is the reviewed file: its sha256 is pinned', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, PUBLIC_WRITER_UNIT));
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    REVIEWED_WRITER_UNIT_SHA256,
    `${PUBLIC_WRITER_UNIT} changed while the reviewed exception stands: review the change, then update the hash here`
  );
});

test('with the renewed entry every other chain-writer rule is unchanged', async (t) => {
  const { service, timer } = await readShippedWriterUnits();
  const shipped = { [PUBLIC_WRITER_UNIT]: service, [PUBLIC_WRITER_TIMER]: timer };
  const audit = async (files) =>
    auditBootEnabledChainWriters(await writeTree(t, files), { today: IN_WINDOW });

  // The shipped units alone: excepted by name, no problem.
  let result = await audit(shipped);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(
    result.excepted.map((entry) => entry.key),
    [PUBLIC_WRITER_KEY]
  );

  // A second, plainly named boot-enabled writer is not covered, and the excepted unit stays excepted.
  result = await audit({
    ...shipped,
    'deploy/ops/second-writer.service': [
      '[Unit]',
      'Description=Second feed writer',
      '[Service]',
      'ExecStart=/usr/bin/node /opt/neoos/services/deploy/ops/push.mjs --execute',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n'),
  });
  assert.equal(result.problems.length, 1, result.problems.join('\n'));
  assert.match(
    result.problems[0],
    /^deploy\/ops\/second-writer\.service is a boot-enabled chain writer outside the Rust relayer authority/
  );
  assert.deepEqual(
    result.excepted.map((entry) => entry.key),
    [PUBLIC_WRITER_KEY]
  );

  // The key is the unit name: the same unit under another name is a second writer.
  result = await audit({
    ...shipped,
    'deploy/feed-pusher/morpheus-public-feed-writer-b.service': service,
  });
  assert.equal(result.problems.length, 1, result.problems.join('\n'));
  assert.match(
    result.problems[0],
    /^deploy\/feed-pusher\/morpheus-public-feed-writer-b\.service is a boot-enabled chain writer/
  );

  // An excepted unit that is deleted, or no longer boot-enabled, leaves a stale exception.
  const stale = `reviewed exception ${PUBLIC_WRITER_KEY} matches no boot-enabled chain writer under deploy/; remove it`;
  assert.deepEqual((await audit({})).problems, [stale]);
  const withoutInstall = (source) => source.replace(/^\[Install\][\s\S]*$/m, '');
  assert.doesNotMatch(withoutInstall(service), /\[Install\]/);
  assert.doesNotMatch(withoutInstall(timer), /\[Install\]/);
  result = await audit({
    [PUBLIC_WRITER_UNIT]: withoutInstall(service),
    [PUBLIC_WRITER_TIMER]: withoutInstall(timer),
  });
  assert.deepEqual(result.problems, [stale]);
});

test('across the whole gate the expiry is the only red at the boundary', async () => {
  assert.deepEqual(
    await auditProductionTopology(undefined, { chainWriters: { today: LAST_COVERED_DAY } }),
    []
  );
  const problems = await auditProductionTopology(undefined, {
    chainWriters: { today: RENEWED_EXPIRY },
  });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(
    problems[0],
    new RegExp(`reviewed exception ${PUBLIC_WRITER_KEY} expired on ${RENEWED_EXPIRY}`)
  );
});

// The gate computes its UTC day from `new Date()`. A child process gets this preload, which pins
// the no-argument Date constructor and Date.now() to FAKE_NOW, to reach the CLI exit path.
const FAKE_CLOCK_SOURCE = `
const fixed = Date.parse(process.env.FAKE_NOW);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(fixed);
    else super(...args);
  }
  static now() {
    return fixed;
  }
};
`;

async function runGateCli(t, { now, timeZone }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'topology-clock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'fake-clock.mjs');
  await fs.writeFile(preload, FAKE_CLOCK_SOURCE);
  const env = { ...process.env, FAKE_NOW: now, TZ: timeZone };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        path.join(REPO_ROOT, 'scripts/check-rust-production-topology.mjs'),
      ],
      { env, timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({ code: error ? error.code : 0, stdout, stderr });
      }
    );
  });
}

test('the gate CLI passes through 2026-10-20 and exits 1 from 2026-10-21, whatever the local zone', async (t) => {
  for (const now of ['2026-10-07T00:00:00Z', '2026-10-20T23:59:59Z']) {
    const { code, stdout, stderr } = await runGateCli(t, { now, timeZone: 'Asia/Shanghai' });
    assert.equal(code, 0, `${now}: ${stderr}`);
    assert.match(
      stderr,
      new RegExp(
        `^WARNING reviewed exception ${PUBLIC_WRITER_KEY} \\(expires ${RENEWED_EXPIRY}\\): `,
        'm'
      )
    );
    assert.match(stderr, /Owner: NeoOS program lead \(delegated by the owner\)/);
    assert.match(stderr, /Condition: the owner caps the writer cadence and funds the updater/);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.reviewed_exceptions.map((entry) => [entry.key, entry.expiresOn]),
      [[PUBLIC_WRITER_KEY, RENEWED_EXPIRY]]
    );
  }
  const expired = await runGateCli(t, { now: '2026-10-21T00:00:00Z', timeZone: 'Asia/Shanghai' });
  assert.equal(expired.code, 1, expired.stderr);
  assert.equal(expired.stdout, '');
  assert.match(expired.stderr, /Rust production topology audit failed:/);
  assert.match(
    expired.stderr,
    new RegExp(`reviewed exception ${PUBLIC_WRITER_KEY} expired on ${RENEWED_EXPIRY}`)
  );
  assert.doesNotMatch(expired.stderr, /^WARNING/m);
});
