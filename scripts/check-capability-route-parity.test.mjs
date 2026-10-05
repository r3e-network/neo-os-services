import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_PATH,
  DECLARED_CAPABILITY_COUNT,
  auditRouteParity,
  loadBaseline,
  partition,
  readDeclaredCapabilities,
  readHostRoutes,
  readWebProxyTargets,
} from './check-capability-route-parity.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./check-capability-route-parity.mjs', import.meta.url));

/**
 * A throwaway copy of the three source trees the gate reads. Copying the real
 * ones keeps the fixture honest: the gate must parse the shipped registry, host
 * table and proxy call sites, not a hand-written stub that can drift from them.
 */
function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'route-parity-'));
  for (const dir of [
    'workers/nitro-worker/src',
    'workers/nitro-enclave-host/src',
    'apps/web/app/api',
    'baselines',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  cpSync(
    join(repoRoot, 'workers/nitro-worker/src/capabilities.js'),
    join(root, 'workers/nitro-worker/src/capabilities.js')
  );
  for (const file of ['routes.rs', 'dispatch.rs', 'sign.rs']) {
    cpSync(
      join(repoRoot, 'workers/nitro-enclave-host/src', file),
      join(root, 'workers/nitro-enclave-host/src', file)
    );
  }
  cpSync(join(repoRoot, BASELINE_PATH), join(root, BASELINE_PATH));
  for (const rel of [
    'compute/execute',
    'compute/functions',
    'neodid/runtime',
    'neodid/bind',
    'relay/transaction',
    'sign/payload',
  ]) {
    const src = join(repoRoot, 'apps/web/app/api', rel, 'route.ts');
    const dest = join(root, 'apps/web/app/api', rel, 'route.ts');
    mkdirSync(join(dest, '..'), { recursive: true });
    cpSync(src, dest);
  }
  return root;
}

function runGate(root) {
  return spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
}

function baselineIn(root) {
  return JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'));
}

test('reads the shipped sources: 30 declared ids, the host table and the web proxy targets', () => {
  const declared = readDeclaredCapabilities(repoRoot);
  assert.equal(declared.length, DECLARED_CAPABILITY_COUNT);
  assert.equal(declared.length, 30, 'the registry declares 30 capability ids');
  const ids = declared.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'capability ids are unique');
  assert.ok(ids.includes('relay_transaction'), 'relay_transaction is declared');
  assert.ok(ids.includes('sign_payload'), 'sign_payload is declared');
  // A pattern route must be recognised as a route, not silently dropped.
  const jobs = declared.find((c) => c.id === 'compute_jobs_id');
  assert.equal(jobs.kind, 'pattern');

  const host = readHostRoutes(repoRoot);
  assert.ok(
    host.routes.includes('/relay/transaction') === false,
    'the host has no /relay/transaction'
  );
  assert.ok(host.routes.includes('/compute/execute'), 'the host has /compute/execute');
  assert.ok(host.retired.includes('/sign/payload'), '/sign/payload is a retired host lane');

  const proxies = readWebProxyTargets(repoRoot);
  const targets = proxies.map((p) => p.target);
  assert.ok(targets.includes('/neodid/runtime'));
  assert.ok(targets.includes('/compute/functions'));
  assert.ok(targets.includes('/relay/transaction'));
  assert.ok(targets.includes('/sign/payload'));
});

test('every proxyToNitro call site is read, including template-literal targets', () => {
  // A proxy the gate cannot parse is a proxy the gate cannot vouch for, and a
  // silently dropped one recreates the blind spot this gate exists to close.
  // `app/api/runtime/keys/derived/route.ts` passes a template literal with an
  // interpolated query, which a literal-only reader misses.
  const apiDir = join(repoRoot, 'apps/web/app/api');
  let callSites = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'route.ts') {
        const source = readFileSync(path, 'utf8');
        callSites += (source.match(/proxyToNitro\s*\(/g) || []).length;
      }
    }
  };
  walk(apiDir);
  assert.equal(callSites, 12, 'the web app has twelve proxy call sites');

  // One entry per call site: no call is merged away and none is invented.
  assert.equal(readWebProxyTargets(repoRoot).length, callSites);
  // The template-literal target is read with its query string stripped, because
  // the host table is matched on the path alone.
  const derived = readWebProxyTargets(repoRoot).find(
    (p) => p.route === '/api/runtime/keys/derived'
  );
  assert.ok(derived, 'the template-literal proxy is read');
  assert.equal(derived.target, '/keys/derived');
  assert.ok(!derived.target.includes('?'), 'the query string is not part of the compared path');
});

test('a proxy target the parser cannot read is a hard error, not a skip', () => {
  const root = fixtureTree();
  try {
    const route = join(root, 'apps/web/app/api/unreadable/route.ts');
    mkdirSync(join(route, '..'), { recursive: true });
    writeFileSync(
      route,
      [
        "import { proxyToNitro } from '@/lib/nitro';",
        '',
        'const upstream = computeTarget();',
        'export async function POST(request: Request) {',
        '  return proxyToNitro(upstream, { method: "POST" }, {});',
        '}',
        '',
      ].join('\n')
    );
    assert.throws(() => readWebProxyTargets(root), /could not be read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RUN 1 — without the baseline the gate is red: 12 declared ids and 4 dead web proxies', () => {
  const root = fixtureTree();
  try {
    rmSync(join(root, BASELINE_PATH));
    const result = runGate(root);
    assert.equal(result.status, 1, 'the gate exits 1 with no baseline');
    const out = result.stdout + result.stderr;
    assert.match(out, /baseline/i);
    // The two counts the specification names.
    assert.match(out, /12 declared capability ids? without a host route/);
    assert.match(out, /4 web proxies? target/);
    // The named dead ids, so a regression that changes WHICH ids are dead is visible.
    for (const id of [
      'relay_transaction',
      'txproxy_invoke',
      'compute_jobs',
      'neodid_runtime',
      'feeds_catalog',
    ]) {
      assert.ok(out.includes(id), `the report names ${id}`);
    }
    for (const target of [
      '/neodid/runtime',
      '/compute/functions',
      '/relay/transaction',
      '/sign/payload',
    ]) {
      assert.ok(out.includes(target), `the report names the dead proxy target ${target}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RUN 2 — with the shipped baseline the gate is green on the same sources', () => {
  const root = fixtureTree();
  try {
    const result = runGate(root);
    assert.equal(
      result.status,
      0,
      `the gate passes with the baseline: ${result.stdout}${result.stderr}`
    );
    const baseline = baselineIn(root);
    assert.equal(
      baseline.dead_capability_ids.length,
      12,
      'twelve declared ids are baselined as dead'
    );
    assert.equal(baseline.dead_web_proxies.length, 4, 'four web proxies are baselined as dead');
    for (const entry of baseline.dead_capability_ids) {
      assert.ok(entry.owner, `baseline entry ${entry.id} names an owner`);
      assert.match(
        entry.expires,
        /^\d{4}-\d{2}-\d{2}$/,
        `baseline entry ${entry.id} has an ISO date`
      );
    }
    for (const entry of baseline.dead_web_proxies) {
      assert.ok(entry.owner, `baseline proxy ${entry.route} names an owner`);
      assert.match(entry.expires, /^\d{4}-\d{2}-\d{2}$/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the two dead-lane rules are distinct: sign_payload is routed but retired', () => {
  // The count asymmetry the specification names (twelve ids, four proxies) only
  // holds if a routed-but-refusing lane counts against the proxies and not
  // against the ids. Pin it, so collapsing the two rules fails here.
  const root = fixtureTree();
  try {
    const declared = readDeclaredCapabilities(root);
    const host = readHostRoutes(root);
    const proxies = readWebProxyTargets(root);
    const { deadIds, retiredIds, deadProxies, liveIds } = partition({ declared, host, proxies });

    assert.equal(deadIds.length, 12, 'twelve declared ids have no host route at all');
    assert.equal(deadProxies.length, 4, 'four proxies target a dead route');
    assert.deepEqual(
      retiredIds.map((c) => c.id),
      ['sign_payload'],
      'sign_payload is the one routed-but-retired lane'
    );
    assert.equal(liveIds.length, 17);
    // sign_payload is routed, so it is NOT among the dead ids.
    assert.ok(!deadIds.some((c) => c.id === 'sign_payload'));
    // ...but every proxy aimed at it is dead.
    assert.ok(deadProxies.some((p) => p.target === '/sign/payload'));

    // A green run still surfaces the retired lane, so "17 live" is not read as
    // "everything is fine".
    const result = runGate(root);
    const out = result.stdout + result.stderr;
    assert.match(out, /routed but retired/i);
    assert.ok(out.includes('sign_payload'), 'the retired lane is named in the report');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RUN 3a — a newly declared id without a host route turns the gate red', () => {
  const root = fixtureTree();
  try {
    const registry = join(root, 'workers/nitro-worker/src/capabilities.js');
    const source = readFileSync(registry, 'utf8');
    const injected = source.replace(
      'const CAPABILITIES = [',
      `const CAPABILITIES = [
  {
    id: 'parity_probe_new_lane',
    paths: [{ match: '/parity/probe/new-lane' }],
    featurePath: 'parity/probe/new-lane',
    handler: async () => json(200, {}),
  },`
    );
    assert.notEqual(injected, source, 'the fixture registry was extended');
    writeFileSync(registry, injected);

    const result = runGate(root);
    assert.equal(result.status, 1, 'a new dead id turns the gate red');
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('parity_probe_new_lane'), 'the new id is named');
    assert.match(out, /not in the baseline|undeclared in the baseline/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RUN 3b — a new web proxy to a route the host does not have turns the gate red', () => {
  const root = fixtureTree();
  try {
    const route = join(root, 'apps/web/app/api/parity/probe/route.ts');
    mkdirSync(join(route, '..'), { recursive: true });
    writeFileSync(
      route,
      [
        "import { proxyToNitro } from '@/lib/nitro';",
        '',
        'export async function POST(request: Request) {',
        "  return proxyToNitro('/parity/probe/upstream', { method: 'POST' }, { route: '/api/parity/probe' });",
        '}',
        '',
      ].join('\n')
    );
    const result = runGate(root);
    assert.equal(result.status, 1, 'a new dead proxy turns the gate red');
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('/parity/probe/upstream'), 'the new proxy target is named');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the baseline is shrink-only: an added id entry is a failure, not a new allowance', () => {
  const root = fixtureTree();
  try {
    const baseline = baselineIn(root);
    baseline.dead_capability_ids.push({
      id: 'relay_transaction_v2',
      reason: 'invented to widen the allowance',
      owner: 'nobody',
      expires: '2099-01-01',
    });
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
    const result = runGate(root);
    assert.equal(result.status, 1, 'adding a baseline entry fails the gate');
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('relay_transaction_v2'), 'the added entry is named');
    assert.match(out, /not dead|shrink/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the baseline is shrink-only: an added proxy entry is a failure', () => {
  const root = fixtureTree();
  try {
    const baseline = baselineIn(root);
    baseline.dead_web_proxies.push({
      route: '/api/neodid/providers',
      target: '/neodid/providers',
      reason: 'invented to pre-authorise a proxy that does not exist yet',
      owner: 'nobody',
      expires: '2099-01-01',
    });
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
    const result = runGate(root);
    assert.equal(result.status, 1, 'adding a baseline proxy entry fails the gate');
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('/api/neodid/providers'), 'the added proxy entry is named');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the baseline may not be extended: a live id added to it is also a failure', () => {
  const root = fixtureTree();
  try {
    const baseline = baselineIn(root);
    baseline.dead_capability_ids.push({
      id: 'compute_execute',
      reason: 'a live lane must never be baselined as dead',
      owner: 'nobody',
      expires: '2099-01-01',
    });
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
    const result = runGate(root);
    assert.equal(result.status, 1, 'baselining a live id fails the gate');
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('compute_execute'), 'the over-broad entry is named');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lapsed baseline entry is a failure: debt may not sit unrecorded past its date', () => {
  const root = fixtureTree();
  try {
    const baseline = baselineIn(root);
    baseline.dead_capability_ids[0].expires = '2026-01-01';
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
    const result = spawnSync(process.execPath, [script, '--root', root, '--today', '2026-10-05'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, 'a lapsed entry fails the gate');
    const out = result.stdout + result.stderr;
    assert.match(out, /expired/i);
    assert.ok(out.includes(baseline.dead_capability_ids[0].id), 'the lapsed entry is named');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the shipped baseline is pinned: it may not be widened', () => {
  // The gate can only shrink the record against the tree it reads; it cannot
  // see a git history, so "may not be extended" is enforced from this side. If
  // a lane is genuinely fixed, delete the entry (rules 3 and the test below
  // then agree). If one is added, this test fails and the addition has to be
  // argued for in review rather than slipped in.
  const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), 'utf8'));
  assert.deepEqual(
    baseline.dead_capability_ids.map((e) => e.id).sort(),
    [
      'compute_functions',
      'compute_jobs',
      'compute_jobs_id',
      'feeds_catalog',
      'feeds_price',
      'feeds_price_symbol',
      'neodid_providers',
      'neodid_runtime',
      'oracle_heartbeat',
      'providers',
      'relay_transaction',
      'txproxy_invoke',
    ],
    'the baselined capability ids are exactly the twelve dead ones'
  );
  assert.deepEqual(
    baseline.dead_web_proxies.map((e) => e.route).sort(),
    [
      '/api/compute/functions',
      '/api/neodid/runtime',
      '/api/relay/transaction',
      '/api/sign/payload',
    ],
    'the baselined proxies are exactly the four dead ones'
  );
  // sign_payload is routed, so it must never appear as a dead id.
  assert.ok(!baseline.dead_capability_ids.some((e) => e.id === 'sign_payload'));
});

test('shrinking the baseline is the one edit that keeps the gate green', () => {
  const root = fixtureTree();
  try {
    // What CU-149 does for a lane it fixes: give the host the route, then
    // delete the baseline entry. Both halves are required — leaving the entry
    // behind is the stale-debt failure.
    const baseline = baselineIn(root);
    const dropped = baseline.dead_capability_ids.find((e) => e.id === 'feeds_catalog');
    baseline.dead_capability_ids = baseline.dead_capability_ids.filter(
      (e) => e.id !== 'feeds_catalog'
    );
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);

    const hostRoutes = join(root, 'workers/nitro-enclave-host/src/routes.rs');
    const source = readFileSync(hostRoutes, 'utf8');
    const patched = source.replace(
      'if matches_route(path, "/oracle/feed") {',
      'if matches_route(path, "/feeds/catalog") {\n            return Target::OracleFeed;\n        }\n        if matches_route(path, "/oracle/feed") {'
    );
    assert.notEqual(patched, source, 'the fixture host table gained the route');
    writeFileSync(hostRoutes, patched);

    const result = runGate(root);
    assert.equal(
      result.status,
      0,
      `shrinking the baseline passes: ${result.stdout}${result.stderr}`
    );
    const out = result.stdout + result.stderr;
    assert.match(out, /11 baselined as dead/);
    assert.ok(!out.includes(dropped.id), 'the fixed id is no longer reported as debt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('giving a dead lane a host route while LEAVING its baseline entry fails', () => {
  const root = fixtureTree();
  try {
    // The other half of the pair: a fixed lane with a stale entry is still a
    // finding, so the record cannot be left to rot after the fix lands.
    const hostRoutes = join(root, 'workers/nitro-enclave-host/src/routes.rs');
    const source = readFileSync(hostRoutes, 'utf8');
    writeFileSync(
      hostRoutes,
      source.replace(
        'if matches_route(path, "/oracle/feed") {',
        'if matches_route(path, "/feeds/catalog") {\n            return Target::OracleFeed;\n        }\n        if matches_route(path, "/oracle/feed") {'
      )
    );
    const result = runGate(root);
    assert.equal(result.status, 1, 'a stale entry for a fixed lane fails');
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('feeds_catalog'), 'the stale entry is named');
    assert.match(out, /not dead/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the gate reports the live declared ids too, so the registry cannot rot unnoticed', () => {
  const root = fixtureTree();
  try {
    const result = runGate(root);
    assert.equal(result.status, 0);
    const out = result.stdout + result.stderr;
    assert.match(out, /30 declared capability ids/);
    assert.match(out, /17 with a live host route, 12 baselined as dead/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auditRouteParity is pure enough to be driven directly, with no filesystem', () => {
  const problems = auditRouteParity({
    declared: [{ id: 'a', kind: 'exact', routes: ['/a'] }],
    host: { routes: [], retired: [] },
    proxies: [{ route: '/api/a', target: '/a' }],
    baseline: { dead_capability_ids: [], dead_web_proxies: [] },
  });
  // Two findings: the declared id has no host route, and the proxy aimed at it
  // is dead. An empty baseline with an empty tree is a clean pass.
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /\ba\b/.test(p) && /capability id/.test(p)));
  assert.ok(problems.some((p) => /\/api\/a/.test(p)));

  assert.deepEqual(
    auditRouteParity({
      declared: [],
      host: { routes: [], retired: [] },
      proxies: [],
      baseline: { dead_capability_ids: [], dead_web_proxies: [] },
    }),
    [],
    'an empty tree with an empty baseline is clean'
  );
});

test('a retired host lane counts as dead for the proxy rule, not as a live route', () => {
  const problems = auditRouteParity({
    declared: [{ id: 'sign_payload', kind: 'exact', routes: ['/sign/payload'] }],
    host: { routes: ['/sign/payload'], retired: ['/sign/payload'] },
    proxies: [{ route: '/api/sign/payload', target: '/sign/payload' }],
    baseline: { dead_capability_ids: [], dead_web_proxies: [] },
  });
  assert.equal(problems.length, 1, 'the retired lane is the one finding');
  assert.match(problems[0], /\/api\/sign\/payload/);
});

test('loadBaseline rejects a baseline without owner and expiry on every entry', () => {
  assert.throws(
    () => loadBaseline({ dead_capability_ids: [{ id: 'x' }], dead_web_proxies: [] }),
    /owner|expir/i
  );
  assert.throws(
    () => loadBaseline({ dead_capability_ids: [{ id: 'x', owner: 'o' }], dead_web_proxies: [] }),
    /expir/i
  );
});
