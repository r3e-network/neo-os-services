import test from 'node:test';
import assert from 'node:assert/strict';

import runtimeCatalog from '../../../apps/web/public/morpheus-runtime-catalog.json' with { type: 'json' };
import {
  buildPublicRuntimeCatalogSummary,
  buildPublicRuntimeStatusSnapshot,
  getPublicRuntimeStatusNotes,
} from './public-runtime.js';

test('buildPublicRuntimeCatalogSummary preserves canonical discovery links and workflow ids', () => {
  const summary = buildPublicRuntimeCatalogSummary(runtimeCatalog);

  assert.equal(summary.envelope.version, runtimeCatalog.envelope.version);
  assert.equal(summary.topology.executionPlane, 'tee_runtime');
  assert.equal(summary.risk.observer, 'independent_observer');
  assert.equal(summary.workflows.count, runtimeCatalog.workflows.length);
  assert.ok(summary.workflows.ids.includes('automation.upkeep'));
  assert.deepEqual(summary.links, {
    catalog: '/api/runtime/catalog',
    workflows: '/api/workflows',
    policies: '/api/policies',
  });
});

test('buildPublicRuntimeStatusSnapshot combines origin probes into an operational public snapshot', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'ok' },
    },
    info: {
      ok: true,
      status: 200,
      body: {
        version: '1.2.3',
        dstack: {
          app_id: 'app-123',
          compose_hash: 'compose-hash-123',
          client_kind: 'dstack',
        },
      },
    },
  });

  assert.equal(snapshot.catalog.envelope.version, runtimeCatalog.envelope.version);
  assert.equal(snapshot.catalog.workflows.count, runtimeCatalog.workflows.length);
  assert.equal(snapshot.catalog.links.catalog, '/api/runtime/catalog');
  assert.equal(snapshot.runtime.status, 'operational');
  assert.equal(snapshot.runtime.health.state, 'ok');
  assert.equal(snapshot.runtime.info.appId, 'app-123');
  assert.equal(snapshot.runtime.info.composeHash, 'compose-hash-123');
});

test('buildPublicRuntimeStatusSnapshot reports the emergency shim payload as degraded despite status ok', () => {
  // Exact live payload served by the emergency fallback runtime during a TEE
  // outage: HTTP 200 + status 'ok' but explicitly degraded with a reason.
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-06-11T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: {
        status: 'ok',
        degraded: true,
        reason: 'runtime_control_plane_disabled',
      },
    },
    info: {
      ok: true,
      status: 200,
      body: { version: 'emergency-vercel-runtime' },
    },
  });

  assert.equal(snapshot.runtime.status, 'degraded');
  assert.equal(snapshot.runtime.health.state, 'degraded');
  assert.equal(snapshot.runtime.health.detail, 'runtime_control_plane_disabled');
});

test('buildPublicRuntimeStatusSnapshot keeps a down status string authoritative over the degraded flag', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-06-11T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'down', degraded: true, reason: 'runtime offline' },
    },
    info: {
      ok: false,
      status: 503,
      body: { error: 'runtime info unavailable' },
    },
  });

  assert.equal(snapshot.runtime.status, 'down');
  assert.equal(snapshot.runtime.health.state, 'down');
});

test('buildPublicRuntimeStatusSnapshot reports degraded when info is unavailable but health is ok', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'ok' },
    },
    info: {
      ok: false,
      status: 503,
      body: { error: 'runtime info unavailable' },
    },
  });

  assert.equal(snapshot.runtime.status, 'degraded');
  assert.equal(snapshot.runtime.info.ok, false);
  assert.equal(snapshot.runtime.info.detail, 'runtime info unavailable');
});

test('buildPublicRuntimeStatusSnapshot keeps the runtime operational when info metadata is auth-protected', () => {
  // /info can sit behind runtime auth: a 401/403 there only means the optional
  // metadata is protected, not that the runtime is unhealthy.
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'ok' },
    },
    info: {
      ok: false,
      status: 401,
      body: { error: 'unauthorized' },
    },
  });

  assert.equal(snapshot.runtime.status, 'operational');
  assert.equal(snapshot.runtime.health.state, 'ok');
  assert.equal(snapshot.runtime.info.ok, false);
  assert.equal(snapshot.runtime.info.detail, 'unauthorized');
});

test('buildPublicRuntimeStatusSnapshot reports the runtime down when the health probe is unavailable', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: false,
      status: 503,
      body: { error: 'upstream unavailable' },
    },
    info: {
      ok: true,
      status: 200,
      body: {
        dstack: {
          app_id: 'app-123',
        },
      },
    },
  });

  assert.equal(snapshot.runtime.status, 'down');
  assert.equal(snapshot.runtime.health.state, 'down');
  assert.equal(snapshot.runtime.health.detail, 'upstream unavailable');
});

test('getPublicRuntimeStatusNotes builds the public status notes from catalog and runtime info', () => {
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: runtimeCatalog,
    checkedAt: '2026-04-10T00:00:00.000Z',
    health: {
      ok: true,
      status: 200,
      body: { status: 'ok' },
    },
    info: {
      ok: true,
      status: 200,
      body: {
        dstack: {
          app_id: 'app-123',
        },
      },
    },
  });

  assert.deepEqual(getPublicRuntimeStatusNotes(snapshot), [
    'Execution: tee_runtime',
    'Risk: independent_observer',
    'Automation: interval, threshold',
    'VRF: operator-predictable; non-value only; repository policy review required. Custody signatures do not make outputs unpredictable to the operator.',
    'App ID: app-123',
  ]);
});

test('getPublicRuntimeStatusNotes tolerates a catalog without automation.triggerKinds', () => {
  // A minimal/emergency catalog summarizes to automation:{} (no triggerKinds).
  // The notes builder must not crash on the missing array.
  const snapshot = buildPublicRuntimeStatusSnapshot({
    catalog: {},
    checkedAt: '2026-06-14T00:00:00.000Z',
    health: { ok: true, status: 200, body: { status: 'ok' } },
    info: { ok: true, status: 200, body: {} },
  });

  assert.deepEqual(snapshot.catalog.automation, {});

  const notes = getPublicRuntimeStatusNotes(snapshot);
  assert.deepEqual(notes, [
    'Execution: undefined',
    'Risk: undefined',
    'Automation: ',
    'VRF: operator-predictable; non-value only; repository policy review required. Custody signatures do not make outputs unpredictable to the operator.',
  ]);
});

for (const state of ['ok', 'degraded', 'down']) {
  test(`CU-147 unsigned public status discloses predictability when ${state}`, () => {
    const snapshot = buildPublicRuntimeStatusSnapshot({
      catalog: {},
      health: { ok: state !== 'down', status: 200, body: { status: state } },
      info: { ok: true, status: 200, body: {} },
    });
    assert.match(JSON.stringify(snapshot), /operator-predictable/);
    assert.match(getPublicRuntimeStatusNotes(snapshot).join('\n'), /operator-predictable/);
  });
}

import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const gate = resolve(repoRoot, 'scripts/check-vrf-consumers.mjs');
const policyPath = 'baselines/vrf-consumers.json';
const sha = (s) => ({ sha256: createHash('sha256').update(s).digest('hex') });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vrf-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  const put = (p, s) => {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), s);
    git('add', p);
  };
  const source = 'fetch("/vrf/random");';
  const review = {
    consumer: 'probe',
    classification: 'non-value',
    owner: 'services lead',
    justification: 'Probe displays bytes only; no stake, reward or economic settlement.',
    inputs: { 'probe.mjs': sha(source) },
  };
  const policy = { version: 1, reviews: [review] };
  put('probe.mjs', source);
  const save = () => put(policyPath, JSON.stringify(policy));
  save();
  git(
    '-c',
    'user.name=Jimmy',
    '-c',
    'user.email=jimmy@r3e.network',
    'commit',
    '-qm',
    'test: seed fixture'
  );
  const run = (...args) =>
    spawnSync(process.execPath, [gate, '--root', root, ...args], { encoding: 'utf8' });
  return { root, put, policy, review, save, run, git };
}
function red(result, reason) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, reason);
}

test('reviewed non-value control passes the CLI', (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
});
for (const [lane, source] of Object.entries({
  direct: 'fetch("/vrf/random", { nonValue: true });',
  automation: 'fetch("/automation/execute", { execution: { type: "random" }});',
  oracle: 'oracle.request("random.generate");',
  alias: 'oracle.request("rng");',
  wager: 'oracle.request("random.generate", {nonValue:true, stake:100, payout:570});',
})) {
  test(`CLI refuses an unlisted ${lane} consumer despite caller claims`, (t) => {
    const f = fixture(t);
    f.put('new-consumer.mjs', source);
    red(f.run(), /unreviewed.*new-consumer/);
  });
}
test('base comparison catches opaque dynamically constructed consumers', (t) => {
  const f = fixture(t);
  f.put('opaque.mjs', 'fetch(["/v", "rf/", "ran", "dom"].join(""));');
  red(f.run('--base', 'HEAD'), /unreviewed.*opaque/);
});
test('changing a reviewed consumer requires a new content review', (t) => {
  const f = fixture(t);
  f.put('probe.mjs', 'fetch("/vrf/random", { stake: 100 });');
  red(f.run(), /hash mismatch/);
});
for (const [name, mutate, reason] of [
  ['missing owner', (f) => delete f.review.owner, /owner/],
  ['missing justification', (f) => delete f.review.justification, /justification/],
  ['caller classification', (f) => (f.review.classification = 'nonValue'), /classification/],
  [
    'arbitrary value classification',
    (f) => (f.review.classification = 'value-bearing'),
    /classification/,
  ],
  ['empty inventory', (f) => (f.review.inputs = {}), /inputs/],
  ['bad hash', (f) => (f.review.inputs['probe.mjs'] = 'abc'), /hash/],
  ['missing input', (f) => (f.review.inputs['absent.mjs'] = sha('')), /missing/],
  [
    'duplicate input',
    (f) => f.policy.reviews.push({ ...f.review, consumer: 'other' }),
    /duplicate/,
  ],
  ['duplicate consumer', (f) => f.policy.reviews.push({ ...f.review }), /duplicate/],
  ['path traversal', (f) => (f.review.inputs['../outside.mjs'] = sha('')), /path/],
  ['unknown policy version', (f) => (f.policy.version = 2), /version/],
]) {
  test(`CLI fails closed: ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    f.save();
    red(f.run(), reason);
  });
}
test('malformed and missing policy fail closed', (t) => {
  const f = fixture(t);
  f.put(policyPath, '{');
  red(f.run(), /JSON|policy/);
  rmSync(join(f.root, policyPath));
  red(f.run(), /ENOENT|policy/);
});
test('unknown CLI options and missing base fail closed', (t) => {
  const f = fixture(t);
  red(f.run('--today', '2026-01-01'), /argument/);
  red(f.run('--base', 'missing-ref'), /base/);
});
test('debt cannot be added through a policy edit', (t) => {
  const f = fixture(t);
  Object.assign(f.review, {
    classification: 'value-bearing-known-debt',
    expires: '2026-11-30',
    remediation: 'E-VRF1',
  });
  f.save();
  red(f.run('--base', 'HEAD'), /debt/);
});
test('repository gate passes and prints the explicit dice debt', () => {
  const r = spawnSync(process.execPath, [gate], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /value-bearing-known-debt.*MiniAppDiceGameEVM/);
  assert.match(r.stdout, /2026-11-30.*E-VRF1/);
});

test('planted compiled dice consumer is refused outside its exact debt inputs', (t) => {
  const f = fixture(t);
  // The retained Foundry reproduction executes this exact contract: a 1 GAS
  // wager reaches random.generate and settles a 5.7 GAS winning callback.
  f.put(
    'contracts-evm/PlantedDice.sol',
    readFileSync(resolve(repoRoot, 'contracts-evm/MiniAppDiceGameEVM.sol'), 'utf8')
  );
  red(f.run(), /unreviewed.*PlantedDice/);
});
function debtFixture(t) {
  const f = fixture(t);
  const debt = JSON.parse(readFileSync(resolve(repoRoot, policyPath))).reviews.find(
    (r) => r.classification === 'value-bearing-known-debt'
  );
  for (const p of Object.keys(debt.inputs)) f.put(p, readFileSync(resolve(repoRoot, p)));
  f.policy.reviews.push(debt);
  f.save();
  f.git(
    '-c',
    'user.name=Jimmy',
    '-c',
    'user.email=jimmy@r3e.network',
    'commit',
    '-qam',
    'test: record approved debt'
  );
  f.debt = debt;
  f.at = (date, ...args) => {
    const preload = `const Original=Date;globalThis.Date=class extends Original{constructor(...a){super(...(a.length?a:['${date}T00:00:00Z']))}static now(){return new Original('${date}T00:00:00Z').getTime()}};`;
    return spawnSync(
      process.execPath,
      [
        '--import',
        `data:text/javascript,${encodeURIComponent(preload)}`,
        gate,
        '--root',
        f.root,
        ...args,
      ],
      { encoding: 'utf8' }
    );
  };
  return f;
}
for (const [name, mutate, reason] of [
  ['extension', (f) => (f.debt.expires = '2026-12-01'), /expiry.*ceiling|extended/],
  ['invalid calendar date', (f) => (f.debt.expires = '2026-11-31'), /calendar/],
  ['wrong owner', (f) => (f.debt.owner = 'someone else'), /unapproved debt/],
  ['wrong remediation', (f) => (f.debt.remediation = 'later'), /unapproved debt/],
  [
    'new debt input',
    (f) => {
      f.put('extra.mjs', '"random"');
      f.debt.inputs['extra.mjs'] = sha('"random"');
    },
    /debt input added/,
  ],
  [
    'changed debt input',
    (f) => {
      const p = Object.keys(f.debt.inputs)[0];
      f.put(p, '"random"');
      f.debt.inputs[p] = sha('"random"');
    },
    /debt input added or changed/,
  ],
  ['laundered debt', (f) => (f.debt.classification = 'non-value'), /debt cannot be reclassified/],
]) {
  test(`debt CLI refuses ${name}`, (t) => {
    const f = debtFixture(t);
    mutate(f);
    f.save();
    red(f.at('2026-10-06', '--base', 'HEAD'), reason);
  });
}
test('debt expires on the UTC boundary and cannot exceed 60 days', (t) => {
  const f = debtFixture(t);
  assert.equal(f.at('2026-11-29').status, 0);
  red(f.at('2026-11-30'), /expired/);
  red(f.at('2026-12-01'), /expired/);
  red(f.at('2026-09-01'), /60 day horizon/);
});
test('base comparison refuses restoring a shortened expiry', (t) => {
  const f = debtFixture(t);
  f.debt.expires = '2026-11-01';
  f.save();
  f.git(
    '-c',
    'user.name=Jimmy',
    '-c',
    'user.email=jimmy@r3e.network',
    'commit',
    '-qam',
    'test: shorten debt'
  );
  f.debt.expires = '2026-11-30';
  f.save();
  red(f.at('2026-10-06', '--base', 'HEAD'), /extended since base/);
});
test('debt can be removed but never reintroduced against the base', (t) => {
  const f = debtFixture(t);
  const debt = f.debt;
  for (const p of Object.keys(debt.inputs)) {
    rmSync(join(f.root, p));
    f.git('rm', p);
  }
  f.policy.reviews.pop();
  f.save();
  assert.equal(f.at('2026-10-06', '--base', 'HEAD').status, 0);
  f.git(
    '-c',
    'user.name=Jimmy',
    '-c',
    'user.email=jimmy@r3e.network',
    'commit',
    '-qam',
    'test: remove debt'
  );
  for (const p of Object.keys(debt.inputs)) f.put(p, readFileSync(resolve(repoRoot, p)));
  f.policy.reviews.push(debt);
  f.save();
  red(f.at('2026-10-06', '--base', 'HEAD'), /debt added since base/);
});
test('unsigned descriptors label all result lanes without changing input envelopes', () => {
  const catalog = { envelope: { version: 'fixture' }, automation: { triggerKinds: ['cron'] } };
  const original = structuredClone(catalog);
  const snapshot = buildPublicRuntimeStatusSnapshot({ catalog });
  assert.equal(snapshot.catalog.vrf.predictability, 'operator-predictable');
  assert.match(snapshot.catalog.vrf.directResult, /vrf\/random/);
  assert.match(snapshot.catalog.vrf.automationResult, /automation\/execute/);
  assert.match(snapshot.catalog.vrf.oracleResult, /32-byte callback/);
  assert.deepEqual(catalog, original);
  assert.deepEqual(snapshot.catalog.envelope, original.envelope);
});
