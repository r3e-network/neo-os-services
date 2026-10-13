import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BASELINE_PATH,
  MAX_EXPIRY_HORIZON_DAYS,
  addDays,
  auditBaselineShrink,
  auditRouteParity,
  loadBaseline,
  maskRust,
  maskScript,
  parseArgs,
  parseCapabilityRegistry,
  parseEdgePassthrough,
  parseHostRoutes,
  parseIsoDate,
  parseProxyCalls,
  partition,
  readDeclaredCapabilities,
  readEdgePassthrough,
  readHostRoutes,
  readWebProxyTargets,
} from './check-capability-route-parity.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./check-capability-route-parity.mjs', import.meta.url));

const REGISTRY = 'workers/nitro-worker/src/capabilities.js';
const HOST_DIRECTORY = 'workers/nitro-enclave-host/src';
const HOST_ROUTES = `${HOST_DIRECTORY}/routes.rs`;
const HOST_FILES = [HOST_ROUTES, `${HOST_DIRECTORY}/dispatch.rs`, `${HOST_DIRECTORY}/sign.rs`];
const WEB_API = 'apps/web/app/api';
const EDGE_WORKER = 'deploy/cloudflare/morpheus-edge-gateway/worker.mjs';

// The gate reads the real UTC day. Every child process here runs with the clock
// pinned by this preload (the technique check-rust-production-topology.test.mjs
// uses), so no test depends on the day it happens to run, and the baseline's own
// expiry cannot turn a test red on a date nobody chose.
const PINNED_NOW = '2026-10-05T12:00:00Z';
const PINNED_TODAY = '2026-10-05';
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
const FAKE_CLOCK_IMPORT = `data:text/javascript,${encodeURIComponent(FAKE_CLOCK_SOURCE)}`;

function runGate(root, { args = [], now = PINNED_NOW, entry = script, env: extraEnv = {} } = {}) {
  const env = { ...process.env, FAKE_NOW: now, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ['--import', FAKE_CLOCK_IMPORT, entry, '--root', root, ...args],
    { encoding: 'utf8', env }
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

function gitIn(root, ...args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    delete env[name];
  }
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

function routeFilesUnder(directory) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/^route\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) found.push(path);
    }
  };
  walk(directory);
  return found;
}

/**
 * A throwaway copy of everything the gate reads: the registry, the host route
 * table and the files it follows, the baseline, and EVERY web route file. Copying
 * the real ones keeps the fixture honest: the gate must parse what ships, not a
 * hand-written stub that can drift from it. With `git`, the copy is committed, so
 * `--base HEAD` has a base to compare against.
 */
function fixtureTree(t, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'route-parity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    REGISTRY,
    ...HOST_FILES,
    EDGE_WORKER,
    BASELINE_PATH,
    ...routeFilesUnder(WEB_API),
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(root, file));
  }
  if (git) {
    gitIn(root, 'init', '-q', '--initial-branch=main');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-q', '-m', 'base');
  }
  return root;
}

function editFile(root, file, change) {
  const path = join(root, file);
  const before = readFileSync(path, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, `${file}: the edit changed nothing`);
  writeFileSync(path, after);
}

function writeFile(root, file, text) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

const readBaseline = (root) => JSON.parse(readFileSync(join(root, BASELINE_PATH), 'utf8'));
const editBaseline = (root, change) => {
  const baseline = readBaseline(root);
  change(baseline);
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
};

/** The audit of a fixture tree, in process, on the pinned day. */
function auditTree(root, today = PINNED_TODAY) {
  return auditRouteParity(
    {
      declared: readDeclaredCapabilities(root),
      host: readHostRoutes(root),
      proxies: readWebProxyTargets(root),
      edge: { passthrough: readEdgePassthrough(root) },
      baseline: loadBaseline(readBaseline(root)),
    },
    { today }
  );
}

function realTree() {
  const declared = readDeclaredCapabilities(repoRoot);
  const host = readHostRoutes(repoRoot);
  const proxies = readWebProxyTargets(repoRoot);
  return { declared, host, proxies, parts: partition({ declared, host, proxies }) };
}

// A synthetic lane, so the lifecycle tests do not depend on which real lane a
// later change happens to fix: CU-149 will give the host real routes and delete
// real baseline entries, and none of these tests should notice.
const PROBE_ID = 'parity_probe_lane';
const PROBE_ROUTE = '/parity/probe';
const probeEntry = () => ({
  id: PROBE_ID,
  declared_route: PROBE_ROUTE,
  reason: 'a synthetic lane the test declares',
  owner: 'the test',
  expires: '2026-11-30',
});
const addProbeLane = (root) =>
  editFile(root, REGISTRY, (source) =>
    source.replace(
      'const CAPABILITIES = [\n',
      `const CAPABILITIES = [
  {
    id: '${PROBE_ID}',
    paths: [{ match: '${PROBE_ROUTE}' }],
    featurePath: 'parity/probe',
    handler: async () => json(200, {}),
  },
`
    )
  );
const giveHostAProbeRoute = (root, route) =>
  editFile(root, HOST_ROUTES, (source) =>
    source.replace(
      '        if matches_route(path, "/oracle/feed") {',
      `        if matches_route(path, "${route}") {\n            return Target::OracleFeed;\n        }\n        if matches_route(path, "/oracle/feed") {`
    )
  );
const giveHostTheProbeRoute = (root) => giveHostAProbeRoute(root, PROBE_ROUTE);

// The same synthetic treatment for the web-proxy lifecycle. Those tests used to
// reach into the shipped baseline for whichever real dead proxy was listed
// first and rewrite it, which made them notice exactly the change they exist to
// survive: CU-149 repairs or removes those proxies. A probe proxy aimed at a
// route the host does not have keeps the rules under test separate from the
// debt under repair, so deleting the last real entry is a non-event here.
const PROBE_PROXY_ROUTE = '/api/parity/probe-proxy';
const PROBE_PROXY_TARGET = '/parity/probe-proxy';
const PROBE_PROXY_METHOD = 'POST';
const probeProxyEntry = (overrides = {}) => ({
  route: PROBE_PROXY_ROUTE,
  target: PROBE_PROXY_TARGET,
  method: PROBE_PROXY_METHOD,
  reason: 'a synthetic proxy the test aims at a route the host does not have',
  owner: 'the test',
  expires: '2026-11-30',
  ...overrides,
});
const addProbeProxy = (root) => {
  writeFile(
    root,
    `${WEB_API}/parity/probe-proxy/route.ts`,
    [
      "import { proxyToNitro } from '@/lib/nitro';",
      '',
      'export async function POST(request) {',
      '  const body = await request.text();',
      `  return proxyToNitro('${PROBE_PROXY_TARGET}', { method: '${PROBE_PROXY_METHOD}', body }, { route: '${PROBE_PROXY_ROUTE}' });`,
      '}',
      '',
    ].join('\n')
  );
  editBaseline(root, (baseline) => baseline.dead_web_proxies.push(probeProxyEntry()));
};

/** A registry with the given entries, in whatever layout the test wants to try. */
const registryWith = (entries) => `const CAPABILITIES = [\n${entries}\n];\n`;
const entry = (id, route = `/${id}`) =>
  `  {\n    id: '${id}',\n    paths: [{ match: '${route}' }],\n    featurePath: '${id}',\n    handler: noop,\n  }`;

// ---------------------------------------------------------------------------
// The scanners
// ---------------------------------------------------------------------------

test('maskScript blanks comments and fills literals, and every index still points at the source', () => {
  const source = [
    "const a = { b: 'x,}', // tail }",
    '  /* c, } */ c: `t${ { d: "e}" }.d } ${`n${1}`}`,',
    '  r: /[/\'"]}/g,',
    '};',
  ].join('\n');
  const masked = maskScript(source);
  assert.equal(masked.length, source.length);
  assert.equal(
    [...masked].filter((c) => c === '{').length,
    5,
    'the object, one interpolation, the object inside it, and two more interpolations'
  );
  assert.equal([...masked].filter((c) => c === '}').length, 5, 'and every one of them closes');
  assert.ok(!masked.includes('x,}'), 'a brace inside a string is not structure');
  assert.ok(!masked.includes('c, }'), 'a block comment is blank');
  assert.ok(!masked.includes('//'), 'a line comment is blank');
  assert.ok(masked.includes('/______/g'), 'a regular expression keeps its delimiters and flags');
  assert.ok(masked.includes('"__"'), 'a string inside an interpolation is masked like any other');
});

test('maskScript tells a division from a regular expression', () => {
  const masked = maskScript(
    "const half = (a + b) / 2; const third = a / b / c; const s = 'a//b'; // end\n" +
      'function f(y) { return /x\'"/.test(y); }'
  );
  assert.ok(masked.includes('(a + b) / 2'));
  assert.ok(masked.includes('a / b / c'));
  assert.ok(masked.includes("'____'"), 'a // inside a string is not a comment');
  assert.ok(!masked.includes(' end'));
  assert.ok(masked.includes('return /___/.test(y)'), 'a slash after return starts a regex');
});

test('maskScript refuses source it cannot scan to the end', () => {
  for (const source of ["const a = 'abc;\n", 'const a = `abc', '/* open', 'const r = /abc\n']) {
    assert.throws(() => maskScript(source), /unterminated/, JSON.stringify(source));
  }
});

test('maskRust blanks comments (nested ones too), keeps strings readable, and masks them for structure', () => {
  const source = [
    '//! doc comment naming matches_route(path, "/doc")',
    '/* block /* nested */ still a comment: matches_route(path, "/block") */',
    'fn f(path: &str) -> bool {',
    '    let s = "// not a comment { } matches_route(path, \\"/inner\\")";',
    "    let c = '/'; let q = '\"'; let tick: &'static str = \"x\"; // tail",
    '    let raw = r#"has "quotes", { and // slashes"#;',
    '    matches_route(path, "/live")',
    '}',
  ].join('\n');
  const { code, shape } = maskRust(source);
  assert.equal(code.length, source.length);
  assert.equal(shape.length, source.length);
  for (const gone of ['/doc', '/block', 'tail', 'nested']) {
    assert.ok(!code.includes(gone), `${gone} was in a comment`);
  }
  assert.ok(code.includes('// not a comment'), 'a // inside a string is not a comment');
  assert.ok(code.includes('matches_route(path, "/live")'));
  assert.ok(!shape.includes('not a comment'), 'string contents are filled in the shape');
  assert.ok(!shape.includes('quotes'), 'raw string contents are filled in the shape');
  assert.equal(
    [...shape].filter((c) => c === '{').length,
    [...shape].filter((c) => c === '}').length,
    'a brace inside a string is not structure'
  );
  assert.ok(shape.includes("let tick: &'static str"), 'a lifetime tick is not a character literal');
});

// ---------------------------------------------------------------------------
// Source 1: the declared capability registry
// ---------------------------------------------------------------------------

test('the registry reader agrees with the runtime registry module, id by id and route by route', async () => {
  const runtime = await import(pathToFileURL(join(repoRoot, REGISTRY)).href);
  const declared = readDeclaredCapabilities(repoRoot);
  assert.equal(
    declared.length,
    runtime.listCapabilityFeatures().length,
    'the reader finds every entry the worker publishes'
  );
  assert.equal(new Set(declared.map((c) => c.id)).size, declared.length, 'ids are unique');
  for (const capability of declared) {
    assert.ok(capability.routes.length > 0, `${capability.id} declares a route`);
    for (const route of capability.exact) {
      assert.equal(
        runtime.resolveCapability(route).capability.id,
        capability.id,
        `${route} resolves to ${capability.id} in the runtime`
      );
    }
    for (const literal of capability.patterns) {
      const body = literal.slice(1, literal.lastIndexOf('/'));
      const flags = literal.slice(literal.lastIndexOf('/') + 1);
      const sample = body.replace(/\\\//g, '/').replace(/\.\+/g, 'x');
      assert.ok(new RegExp(body, flags).test(sample), `${literal} accepts ${sample}`);
      assert.equal(
        runtime.resolveCapability(sample).capability.id,
        capability.id,
        `${sample} resolves to ${capability.id} in the runtime`
      );
    }
  }
});

test('the registry reader reads an entry whatever its layout', () => {
  const source = registryWith(
    [
      "  { id: 'one_liner', paths: [{ match: '/one-liner' }], featurePath: 'one-liner', handler: noop },",
      "  {\n    featurePath: 'id-last',\n    handler: async ({ payload }) => handle(payload, { a: 1, b: [2, 3] }),\n    paths: [{ match: '/id-last' }, { match: '/id-last-alias' }],\n    id: 'id_last',\n  },",
      '  {\n    id: "double_quoted",\n    paths: [{ match: "/double-quoted" }],\n    featurePath: "double-quoted",\n    handler: noop,\n  },',
      "  {\n    'id': 'quoted_key',\n    paths: [{ match: `/backtick` }],\n    featurePath: 'quoted-key',\n    handler: noop,\n  },",
      "  // { id: 'in_a_comment', paths: [{ match: '/ghost' }], featurePath: 'ghost', handler: noop },",
      String.raw`  {
    id: 'regex_lane',
    paths: [{ pattern: /\/feeds\/[^/]+\/(?:a|b)\//i }, { match: '/regex-lane' }],
    featurePath: 'regex-lane',
    handler: () => json(200, { '}': ']' }),
  }`,
    ].join('\n')
  );
  const declared = parseCapabilityRegistry(source);
  assert.deepEqual(
    declared.map((c) => c.id),
    ['one_liner', 'id_last', 'double_quoted', 'quoted_key', 'regex_lane']
  );
  assert.deepEqual(declared[0].routes, ['/one-liner']);
  assert.deepEqual(declared[1].routes, ['/id-last', '/id-last-alias']);
  assert.deepEqual(declared[2].routes, ['/double-quoted']);
  assert.deepEqual(declared[3].routes, ['/backtick']);
  assert.equal(declared[4].kind, 'pattern');
  assert.deepEqual(declared[4].exact, ['/regex-lane']);
  assert.deepEqual(declared[4].patterns, [String.raw`/\/feeds\/[^/]+\/(?:a|b)\//i`]);
});

test('the registry reader refuses what it cannot read instead of reading fewer entries', () => {
  const whole = (extra) => registryWith(`${entry('first')},\n${extra}`);
  const refusals = [
    ['a spread element', whole('  ...EXTRA'), /not a single object literal/],
    ['an identifier element', whole('  makeEntry'), /not a single object literal/],
    ['a call element', whole("  makeEntry('x')"), /not a single object literal/],
    [
      'a spread member',
      whole("  { ...base, id: 'x', paths: [{ match: '/x' }], featurePath: 'x' }"),
      /spreads another object/,
    ],
    [
      'a computed key',
      whole("  { [key]: 'x', id: 'x', paths: [{ match: '/x' }], featurePath: 'x' }"),
      /computed key/,
    ],
    [
      'an id that is not a literal',
      whole("  { id: someId, paths: [{ match: '/x' }], featurePath: 'x' }"),
      /id is not a plain string literal/,
    ],
    [
      'an id with an interpolation',
      whole("  { id: `a_${b}`, paths: [{ match: '/x' }], featurePath: 'x' }"),
      /id is not a plain string literal/,
    ],
    [
      'an id with an escape',
      whole("  { id: 'a\\'b', paths: [{ match: '/x' }], featurePath: 'x' }"),
      /escape sequence/,
    ],
    [
      'an entry with no paths',
      whole("  { id: 'x', featurePath: 'x', handler: noop }"),
      /paths is not an array literal/,
    ],
    [
      'paths that is an identifier',
      whole("  { id: 'x', paths: COMMON, featurePath: 'x' }"),
      /paths is not an array literal/,
    ],
    [
      'an empty paths array',
      whole("  { id: 'x', paths: [], featurePath: 'x' }"),
      /declares no route/,
    ],
    [
      'a pattern that is not a regular expression literal',
      whole("  { id: 'x', paths: [{ pattern: new RegExp('x') }], featurePath: 'x' }"),
      /not a regular expression literal/,
    ],
    [
      'a duplicate id',
      registryWith(`${entry('same')},\n${entry('same', '/other')}`),
      /declared twice/,
    ],
    [
      'an entry without a featurePath',
      whole("  { id: 'x', paths: [{ match: '/x' }], handler: noop }"),
      /featurePath keys/,
    ],
    [
      'a featurePath inside a nested object',
      whole(
        "  { id: 'x', paths: [{ match: '/x' }], featurePath: 'x', extra: { featurePath: 'y' } }"
      ),
      /featurePath keys/,
    ],
    [
      'a push after the literal',
      `${whole(entry('second'))}CAPABILITIES.push({ id: 'late' });\n`,
      /changed after its literal/,
    ],
    [
      'an index assignment after the literal',
      `${whole(entry('second'))}CAPABILITIES[0] = other;\n`,
      /changed after its literal/,
    ],
    ['a missing array', 'const OTHER = [];\n', /CAPABILITIES array was not found/],
    ['an unterminated array', 'const CAPABILITIES = [ {', /unterminated/],
  ];
  for (const [name, source, expected] of refusals) {
    assert.throws(() => parseCapabilityRegistry(source), expected, name);
  }
});

test('a prettier-clean one-line entry in the real registry is read, and an undeclared dead lane fails the gate', async (t) => {
  const line =
    "  { id: 'dead', paths: [{ match: '/dead' }], featurePath: 'dead', handler: handleKeysDerived },";
  const { format, resolveConfig } = await import('prettier');
  const options = { ...(await resolveConfig(join(repoRoot, REGISTRY))), parser: 'babel' };
  assert.equal(
    (await format(`const x = [\n${line}\n];\n`, options)).split('\n')[1],
    line,
    'prettier itself leaves this line alone, so format:check does not catch it'
  );
  const root = fixtureTree(t);
  editFile(root, REGISTRY, (source) =>
    source.replace('const CAPABILITIES = [\n', `const CAPABILITIES = [\n${line}\n`)
  );
  assert.ok(readDeclaredCapabilities(root).some((c) => c.id === 'dead'));
  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(
    result.out,
    /capability id dead is declared \(\/dead\) but the host serves no such route/
  );
});

test('an entry the reader cannot read fails the gate with exit 1, not a shorter list', (t) => {
  const root = fixtureTree(t);
  editFile(root, REGISTRY, (source) =>
    source.replace('const CAPABILITIES = [\n', 'const CAPABILITIES = [\n  ...MORE_CAPABILITIES,\n')
  );
  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(
    result.out,
    /could not read its sources: .*CAPABILITIES entry 1 is not a single object literal/
  );
});

// ---------------------------------------------------------------------------
// Source 2: the measured host route table
// ---------------------------------------------------------------------------

const routesRs = (body) => `
pub fn matches_route(path: &str, route: &str) -> bool { path == route }
pub enum Target { Health, NotFound }
pub fn classify(method: &str, path: &str) -> Target {
    let method = method.trim().to_ascii_uppercase();
${body}
    Target::NotFound
}
`;
const hostOf = (body) => parseHostRoutes({ routes: routesRs(body), dispatch: '', sign: '' });

test('the host reader knows which methods reach a route: /keys/derived is POST only', () => {
  const host = readHostRoutes(repoRoot);
  assert.deepEqual(host.methods['/keys/derived'], ['POST']);
  assert.deepEqual(host.methods['/health'], ['GET']);
  assert.deepEqual(host.methods['/attestation'], ['GET', 'POST']);
  assert.deepEqual(host.methods['/oracle/public-key'], ['GET', 'POST']);
  assert.deepEqual(host.routes, Object.keys(host.methods).sort());
});

test("the host reader agrees with the host's own classify tests, method by method", () => {
  const host = readHostRoutes(repoRoot);
  const tests = maskRust(
    readFileSync(join(repoRoot, `${dirname(HOST_DIRECTORY)}/tests/unit/routes.rs`), 'utf8')
  ).code;
  const asserted = [
    ...tests.matchAll(/classify_(get|post)\(\s*"(\/[^"]*)"\s*\)\s*,\s*Target::(\w+)\s*,?\s*\)/g),
  ].map(([, method, path, target]) => ({ method: method.toUpperCase(), path, target }));
  assert.ok(asserted.length >= 20, `the oracle is not vacuous (${asserted.length} assertions)`);
  let compared = 0;
  for (const { method, path, target } of asserted) {
    if (!host.routes.includes(path)) continue;
    compared += 1;
    assert.equal(
      host.methods[path].includes(method),
      target !== 'NotFound',
      `${method} ${path}: the host test says ${target}`
    );
  }
  assert.ok(compared >= 20, `${compared} assertions were comparable`);
});

test('the host reader ignores a route named in a comment, and a // inside a string', () => {
  const host = hostOf(`
    // matches_route(path, "/line-comment") is not served yet
    /* if matches_route(path, "/block-comment") { return Target::Health; } */
    /// matches_route(path, "/doc-comment")
    let note = "// matches_route(path, \\"/in-a-string\\")";
    let shaped = "if { oops (";
    if method == "GET" && matches_route(path, "/served") {
        return Target::Health;
    }`);
  assert.deepEqual(host.routes, ['/served']);
  assert.deepEqual(host.methods, { '/served': ['GET'] });
});

test('the host reader follows nesting and a condition without a method', () => {
  const host = hostOf(`
    if matches_route(path, "/any") { return Target::Health; }
    if method == "POST" {
        if matches_route(path, "/nested") { return Target::Health; }
        if method == "GET" && matches_route(path, "/never") { return Target::Health; }
    }
    if (method == "GET" || method == "POST") {
        if method == "POST" && matches_route(path, "/narrowed") { return Target::Health; }
    }
    if matches_route(path, "/a") || matches_route(path, "/b") { return Target::Health; }`);
  assert.deepEqual(host.methods, {
    '/a': ['*'],
    '/any': ['*'],
    '/b': ['*'],
    '/narrowed': ['POST'],
    '/nested': ['POST'],
    '/never': [],
  });
});

test('the host reader refuses a classify it cannot attribute to methods', () => {
  const refusals = [
    [
      'an else branch',
      'if method == "GET" { return Target::Health; } else { if matches_route(path, "/x") { return Target::Health; } }',
      /else branch/,
    ],
    [
      'a negated method',
      'if method != "GET" && matches_route(path, "/x") { return Target::Health; }',
      /does not understand/,
    ],
    [
      'a method test it cannot parse',
      'if is_read(method) && matches_route(path, "/x") { return Target::Health; }',
      /does not understand/,
    ],
    [
      'a route hidden in a match',
      'match method.as_str() { "GET" => { if matches_route(path, "/x") { return Target::Health; } } _ => {} }',
      /cannot tell which methods reach it/,
    ],
    [
      'a method alternative joined to a route',
      'if method == "GET" || matches_route(path, "/x") { return Target::Health; }',
      /mixes method and route alternatives/,
    ],
  ];
  for (const [name, body, expected] of refusals) {
    assert.throws(() => hostOf(body), expected, name);
  }
  assert.throws(
    () => parseHostRoutes({ routes: 'pub fn other() {}', dispatch: '', sign: '' }),
    /classify function was not found/
  );
});

test('a lane is retired because the source says so: derived from sign.rs and dispatch.rs, never from a comment', () => {
  const read = (file) => readFileSync(join(repoRoot, `${HOST_DIRECTORY}/${file}`), 'utf8');
  const sources = {
    routes: read('routes.rs'),
    dispatch: read('dispatch.rs'),
    sign: read('sign.rs'),
  };
  assert.deepEqual(parseHostRoutes(sources).retired, ['/sign/payload']);
  assert.deepEqual(
    parseHostRoutes({
      ...sources,
      sign: sources.sign.replaceAll('blind_sign_disabled_error', 'a_refusal_nobody_returns'),
    }).retired,
    [],
    'when the handler stops refusing, the lane is no longer retired'
  );
  assert.deepEqual(
    parseHostRoutes({
      ...sources,
      sign: sources.sign.replaceAll(
        'blind_sign_disabled_error()',
        '/* blind_sign_disabled_error() */ Default::default()'
      ),
    }).retired,
    [],
    'a refusal named only in a comment retires nothing'
  );
});

// ---------------------------------------------------------------------------
// Source 3: the web proxy targets
// ---------------------------------------------------------------------------

test('every proxyToNitro call site in the real tree is read, with its target and its method', () => {
  // The independent count: every call of the helper in every route file, found
  // without parsing arguments. Nothing here pins how many there are today.
  let callSites = 0;
  for (const file of routeFilesUnder(WEB_API)) {
    callSites += (readFileSync(join(repoRoot, file), 'utf8').match(/\bproxyToNitro\s*\(/g) || [])
      .length;
  }
  const proxies = readWebProxyTargets(repoRoot);
  assert.ok(callSites > 0, 'the web app proxies something');
  assert.equal(
    proxies.length,
    callSites,
    'one entry per call site: none merged away, none invented'
  );
  for (const proxy of proxies) {
    assert.match(proxy.route, /^\/api(\/|$)/);
    assert.match(proxy.target, /^\/[^?*]*$/, `${proxy.route}: a path, no query`);
    assert.match(proxy.method, /^[A-Z]+$/);
  }
  // The derived-key proxy is the method-repair case: the host serves
  // /keys/derived for POST only, so the proxy sends POST. Its target is a plain
  // literal now; the reader's template-literal handling is pinned by the
  // synthetic case in `parseProxyCalls reads a call whatever its layout`.
  const derived = proxies.find((proxy) => proxy.route === '/api/runtime/keys/derived');
  assert.deepEqual([derived.target, derived.method], ['/keys/derived', 'POST']);
  const execute = proxies.find((proxy) => proxy.route === '/api/compute/execute');
  assert.deepEqual([execute.target, execute.method], ['/compute/execute', 'POST']);
});

test('parseProxyCalls reads a call whatever its layout and ignores what is not a call', () => {
  const cases = [
    ["proxyToNitro('/a', { method: 'POST', body })", [['/a', 'POST']]],
    ['proxyToNitro("/a")', [['/a', 'GET']]],
    ["proxyToNitro('/a', undefined, op)", [['/a', 'GET']]],
    ["proxyToNitro('/a', {}, op)", [['/a', 'GET']]],
    [
      'proxyToNitro(\'/a\', { headers: { "x-a": \'b, c\' }, method: "delete" }, op)',
      [['/a', 'DELETE']],
    ],
    ["proxyToNitro('/a', { 'method': 'PUT' })", [['/a', 'PUT']]],
    [
      "proxyToNitro(\n  // the target\n  '/a', /* init */ {\n    method: 'PATCH', // verb\n  }\n)",
      [['/a', 'PATCH']],
    ],
    [
      "proxyToNitro(`/keys/derived?role=${encodeURIComponent(role)}`, { method: 'GET' })",
      [['/keys/derived', 'GET']],
    ],
    ["proxyToNitro(`/compute/${name}/run`, { method: 'POST' })", [['/compute/*/run', 'POST']]],
    ["proxyToNitro(`/x/${fn({ a: 1 })}`, { method: 'POST' })", [['/x/*', 'POST']]],
    [
      "await proxyToNitro('/one'); await proxyToNitro('/two', { method: 'POST' });",
      [
        ['/one', 'GET'],
        ['/two', 'POST'],
      ],
    ],
    [
      "// proxyToNitro('/ghost')\nconst s = \"proxyToNitro('/ghost2')\";\n/* proxyToNitro('/ghost3') */",
      [],
    ],
    ["import { proxyToNitro } from '@/lib/nitro';\nimport type { Foo } from './foo';", []],
    [
      "import {\n  proxyToNitro,\n  other,\n} from '@/lib/nitro';\nexport const a = proxyToNitro('/m');",
      [['/m', 'GET']],
    ],
  ];
  for (const [source, expected] of cases) {
    assert.deepEqual(
      parseProxyCalls(source, 'fixture.ts').map((call) => [call.target, call.method]),
      expected,
      source
    );
  }
});

test('parseProxyCalls refuses a call it cannot read instead of skipping it', () => {
  const refusals = [
    ["proxyToNitro(target, { method: 'POST' })", /one quoted or template literal/],
    ["proxyToNitro('/a' + suffix)", /one quoted or template literal/],
    ["proxyToNitro(`/a/${x}` + '/b')", /one quoted or template literal/],
    ["proxyToNitro('/a', init)", /not a single object literal/],
    ["proxyToNitro('/a', buildInit())", /not a single object literal/],
    ["proxyToNitro('/a', { ...base, method: 'POST' })", /spreads another object/],
    ["proxyToNitro('/a', { method })", /method is not a string literal/],
    ["proxyToNitro('/a', { method: verb })", /method is not a plain string literal/],
    [
      "proxyToNitro('/a', { method: reads ? 'GET' : 'POST' })",
      /method is not a plain string literal/,
    ],
    [
      "import { proxyToNitro as proxy } from '@/lib/nitro';\nproxy('/a');",
      /imported under another name/,
    ],
    ["const proxy = proxyToNitro;\nproxy('/a');", /other than by a direct call/],
    ['export { proxyToNitro };', /other than by a direct call/],
    ['proxyToNitro()', /without a target/],
    ["proxyToNitro('relative/path')", /not an absolute path/],
    ['proxyToNitro(`${base}/a`)', /not an absolute path/],
    ["proxyToNitro('/a\\n')", /escape sequence/],
  ];
  for (const [source, expected] of refusals) {
    assert.throws(() => parseProxyCalls(source, 'fixture.ts'), expected, source);
  }
});

test('route files of every extension are read, a root route is /api, tests are not routes', (t) => {
  const root = fixtureTree(t);
  const call = (target, method = 'POST') =>
    `import { proxyToNitro } from '@/lib/nitro';\nexport const handler = () => proxyToNitro('${target}', { method: '${method}' });\n`;
  writeFile(root, `${WEB_API}/ext/tsx/route.tsx`, call('/x/tsx'));
  writeFile(root, `${WEB_API}/ext/js/route.js`, call('/x/js'));
  writeFile(root, `${WEB_API}/ext/mjs/route.mjs`, call('/x/mjs'));
  writeFile(root, `${WEB_API}/route.ts`, call('/x/root', 'GET'));
  writeFile(root, `${WEB_API}/ext/js/route.test.js`, 'proxyToNitro(variableTarget);\n');
  const proxies = readWebProxyTargets(root);
  for (const [route, target, method] of [
    ['/api/ext/tsx', '/x/tsx', 'POST'],
    ['/api/ext/js', '/x/js', 'POST'],
    ['/api/ext/mjs', '/x/mjs', 'POST'],
    ['/api', '/x/root', 'GET'],
  ]) {
    assert.ok(
      proxies.some((p) => p.route === route && p.target === target && p.method === method),
      `${route} -> ${method} ${target}`
    );
  }
});

test('a proxy helper wrapped outside the route files is an error, because its target would go unread', (t) => {
  const root = fixtureTree(t);
  writeFile(root, 'apps/web/lib/nitro.ts', 'export async function proxyToNitro() {}\n');
  writeFile(root, 'apps/web/__tests__/nitro.test.ts', 'proxyToNitro(variableTarget);\n');
  writeFile(root, 'apps/web/node_modules/dep/index.js', 'proxyToNitro(variableTarget);\n');
  assert.doesNotThrow(
    () => readWebProxyTargets(root),
    'the definition, tests and dependencies are fine'
  );
  writeFile(
    root,
    'apps/web/lib/runtime-call.ts',
    "import { proxyToNitro } from './nitro';\nexport const call = () => proxyToNitro('/hidden');\n"
  );
  assert.throws(
    () => readWebProxyTargets(root),
    /apps\/web\/lib\/runtime-call\.ts references proxyToNitro outside the route files/
  );
  rmSync(join(root, 'apps/web/lib/runtime-call.ts'));
  writeFile(root, `${WEB_API}/ext/helpers.ts`, "proxyToNitro('/hidden-in-the-api-tree');\n");
  assert.throws(
    () => readWebProxyTargets(root),
    /apps\/web\/app\/api\/ext\/helpers\.ts references proxyToNitro outside the route files/,
    'a helper beside the routes is not a route file either'
  );
});

test('a proxy that switches to a method the host does not serve turns the gate red', (t) => {
  const root = fixtureTree(t);
  editFile(root, `${WEB_API}/compute/execute/route.ts`, (source) =>
    source.replace(
      "proxyToNitro(\n      '/compute/execute',\n      { method: 'POST', body },",
      "proxyToNitro(\n      '/compute/execute',\n      { method: 'GET' },"
    )
  );
  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(result.out, /\/api\/compute\/execute -> GET \/compute\/execute/);
  assert.match(result.out, /the host serves it for POST only, not GET/);
  assert.match(result.out, /by method\)/);
});

// ---------------------------------------------------------------------------
// Source 4: the edge gateway's host-bound passthrough
// ---------------------------------------------------------------------------

test('the edge gateway forwards only to routes the host serves', () => {
  const passthrough = readEdgePassthrough(repoRoot);
  const host = readHostRoutes(repoRoot);
  assert.ok(passthrough.length > 0, 'the edge forwards something to the host today');
  for (const path of passthrough) {
    assert.ok(host.routes.includes(path), `${path} is a host route`);
    assert.ok(!host.retired.includes(path), `${path} is not a retired lane`);
  }
});

test('parseEdgePassthrough reads the list however it is written, and refuses what it cannot read', () => {
  assert.deepEqual(
    parseEdgePassthrough(
      "// const RUNTIME_BOX_PASSTHROUGH = ['/ghost'];\nconst RUNTIME_BOX_PASSTHROUGH = [\n  '/a', // first\n  \"/b\",\n  `/c`,\n];\n"
    ),
    ['/a', '/b', '/c']
  );
  assert.deepEqual(parseEdgePassthrough('const RUNTIME_BOX_PASSTHROUGH = [];'), []);
  const refusals = [
    ['a missing list', 'const OTHER = [];', /RUNTIME_BOX_PASSTHROUGH list was not found/],
    [
      'an element that is not a literal',
      'const RUNTIME_BOX_PASSTHROUGH = ["/a", path];',
      /not a plain string literal/,
    ],
    ['a relative path', "const RUNTIME_BOX_PASSTHROUGH = ['a'];", /not an absolute path/],
    [
      'a push after the literal',
      "const RUNTIME_BOX_PASSTHROUGH = ['/a'];\nRUNTIME_BOX_PASSTHROUGH.push('/b');",
      /changed after its literal/,
    ],
  ];
  for (const [name, source, expected] of refusals) {
    assert.throws(() => parseEdgePassthrough(source), expected, name);
  }
});

test('an edge passthrough the host does not serve, or has retired, turns the gate red', (t) => {
  const root = fixtureTree(t);
  editFile(root, EDGE_WORKER, (source) =>
    source.replace(
      /const RUNTIME_BOX_PASSTHROUGH = \[/,
      "const RUNTIME_BOX_PASSTHROUGH = ['/oracle/ghost', '/sign/payload', "
    )
  );
  const result = runGate(root);
  assert.equal(result.status, 1);
  assert.match(
    result.out,
    /edge gateway passthrough \/oracle\/ghost targets a route the host does not have/
  );
  assert.match(
    result.out,
    /edge gateway passthrough \/sign\/payload targets a host lane that is retired/
  );

  rmSync(join(root, BASELINE_PATH));
  const withoutBaseline = runGate(root);
  assert.match(withoutBaseline.out, /no baseline at/);
  assert.match(
    withoutBaseline.out,
    /edge gateway passthrough \/oracle\/ghost/,
    'reported even with no baseline'
  );
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

test('RUN 1: without the baseline the gate is red, and the report counts what the tree has', (t) => {
  const root = fixtureTree(t);
  const { parts } = realTree();
  rmSync(join(root, BASELINE_PATH));
  const result = runGate(root);
  assert.equal(result.status, 1, 'the gate exits 1 with no baseline');
  assert.match(result.out, /no baseline at baselines\/capability-route-parity\.json/);
  // The real tree's remaining debt is whatever it is: the counts below are
  // asserted against it, not against a fixed number, so a change that repairs
  // a lane (CU-149 did) does not turn this red. Dead ids are still expected —
  // the gate's reason to exist is that they are invisible without it.
  assert.ok(parts.deadIds.length > 0, 'the tree has dead ids today');
  assert.ok(
    result.out.includes(`${parts.deadIds.length} declared capability ids without a host route`),
    `the id count (${parts.deadIds.length}) is reported`
  );
  assert.ok(
    result.out.includes(
      `${parts.deadProxies.length} web proxies target a route the host cannot answer`
    ),
    `the proxy count (${parts.deadProxies.length}) is reported`
  );
  for (const capability of parts.deadIds)
    assert.ok(result.out.includes(capability.id), capability.id);
  for (const proxy of parts.deadProxies) {
    assert.ok(
      result.out.includes(`${proxy.route} -> ${proxy.method} ${proxy.target}`),
      proxy.route
    );
  }
});

test('RUN 2: with the shipped baseline the gate is green on the same sources, and says what it saw', (t) => {
  const root = fixtureTree(t);
  const { declared, proxies, parts } = realTree();
  const baseline = readBaseline(root);
  assert.equal(
    parts.deadIds.length,
    baseline.dead_capability_ids.length,
    'every dead id is baselined and every baselined id is dead'
  );
  assert.equal(parts.deadProxies.length, baseline.dead_web_proxies.length);
  const result = runGate(root);
  assert.equal(result.status, 0, result.out);
  assert.ok(
    result.out.includes(
      `${declared.length} declared capability ids (${parts.liveIds.length} with a live host route, ` +
        `${parts.deadIds.length} baselined as dead` +
        (parts.retiredIds.length ? `, ${parts.retiredIds.length} routed but retired` : '') +
        `), ${proxies.length} web proxies (${parts.liveProxies.length} live, ` +
        `${parts.deadProxies.length} baselined as dead).`
    ),
    result.out
  );
  for (const capability of parts.retiredIds) {
    assert.match(result.out, new RegExp(`Routed but retired .*: ${capability.id}\\.`));
  }
  assert.match(
    result.out,
    /Edge gateway: \d+ host-bound passthrough routes, all live on the host \(/
  );
  assert.match(result.out, /Capability route-parity gate passed\./);
});

test('RUN 3a: a newly declared id without a host route turns the gate red', (t) => {
  const root = fixtureTree(t);
  addProbeLane(root);
  const result = runGate(root);
  assert.equal(result.status, 1, 'a new dead id turns the gate red');
  assert.match(
    result.out,
    new RegExp(`capability id ${PROBE_ID} is declared \\(${PROBE_ROUTE}\\) .* not in the baseline`)
  );
});

test('RUN 3b: a new web proxy to a route the host does not have turns the gate red', (t) => {
  const root = fixtureTree(t);
  writeFile(
    root,
    `${WEB_API}/parity/probe/route.ts`,
    "import { proxyToNitro } from '@/lib/nitro';\nexport async function POST() {\n  return proxyToNitro('/parity/probe/upstream', { method: 'POST' }, { route: '/api/parity/probe' });\n}\n"
  );
  const result = runGate(root);
  assert.equal(result.status, 1, 'a new dead proxy turns the gate red');
  assert.match(
    result.out,
    /web proxy \/api\/parity\/probe -> POST \/parity\/probe\/upstream is dead \(the host has no such route\) and it is not in the baseline/
  );
});

test('the dead-lane rules are distinct: a retired lane is routed for ids and dead for proxies, a wrong method is dead for proxies only', () => {
  const declared = [
    { id: 'signing', kind: 'exact', routes: ['/sign'], exact: ['/sign'], patterns: [] },
    { id: 'reading', kind: 'exact', routes: ['/read'], exact: ['/read'], patterns: [] },
    { id: 'absent', kind: 'exact', routes: ['/absent'], exact: ['/absent'], patterns: [] },
  ];
  const host = {
    routes: ['/read', '/sign'],
    methods: { '/read': ['POST'], '/sign': ['POST'] },
    retired: ['/sign'],
  };
  const proxies = [
    { route: '/api/sign', target: '/sign', method: 'POST' },
    { route: '/api/read-post', target: '/read', method: 'POST' },
    { route: '/api/read-get', target: '/read', method: 'GET' },
    { route: '/api/absent', target: '/absent', method: 'POST' },
  ];
  const parts = partition({ declared, host, proxies });
  assert.deepEqual(
    parts.deadIds.map((c) => c.id),
    ['absent'],
    'only an unrouted id is a dead id'
  );
  assert.deepEqual(
    parts.retiredIds.map((c) => c.id),
    ['signing']
  );
  assert.deepEqual(
    parts.liveIds.map((c) => c.id),
    ['reading']
  );
  assert.deepEqual(
    parts.deadProxies.map((p) => [p.route, p.why]),
    [
      ['/api/sign', 'the host classifies it but the lane is retired'],
      ['/api/read-get', 'the host serves it for POST only, not GET'],
      ['/api/absent', 'the host has no such route'],
    ]
  );
  assert.deepEqual(
    parts.liveProxies.map((p) => p.route),
    ['/api/read-post']
  );
  assert.throws(
    () => partition({ declared, host: { routes: [], retired: [] }, proxies }),
    /host\.methods is missing/
  );
});

test('a host route that serves every method serves GET too', () => {
  const parts = partition({
    declared: [],
    host: { routes: ['/any'], methods: { '/any': ['*'] }, retired: [] },
    proxies: [{ route: '/api/any', target: '/any', method: 'GET' }],
  });
  assert.equal(parts.deadProxies.length, 0);
});

test('the baseline lifecycle: a synthetic dead lane needs its entry, and a fixed lane needs its entry deleted', (t) => {
  const root = fixtureTree(t);
  addProbeLane(root);
  assert.equal(auditTree(root).length, 1, 'declared with no route and no entry: red');

  editBaseline(root, (baseline) => baseline.dead_capability_ids.push(probeEntry()));
  assert.deepEqual(auditTree(root), [], 'declared, baselined, still dead: green');

  giveHostTheProbeRoute(root);
  const stale = auditTree(root);
  assert.equal(stale.length, 1, 'fixed, entry left behind: red');
  assert.match(stale[0], new RegExp(`baseline capability id ${PROBE_ID} is not dead`));

  editBaseline(root, (baseline) => {
    baseline.dead_capability_ids = baseline.dead_capability_ids.filter(
      (entry) => entry.id !== PROBE_ID
    );
  });
  assert.deepEqual(auditTree(root), [], 'fixed, entry deleted: the one edit that stays green');
});

test('an entry for an id the registry no longer declares is stale debt too', (t) => {
  const root = fixtureTree(t);
  editBaseline(root, (baseline) =>
    baseline.dead_capability_ids.push({ ...probeEntry(), id: 'never_declared' })
  );
  const problems = auditTree(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /baseline capability id never_declared is not dead and not declared/);
});

test('a live id baselined as dead is stale, and a retired lane is never a dead id', (t) => {
  const root = fixtureTree(t);
  const { parts } = realTree();
  const live = parts.liveIds[0].id;
  editBaseline(root, (baseline) =>
    baseline.dead_capability_ids.push({ ...probeEntry(), id: live })
  );
  assert.match(
    auditTree(root).join('\n'),
    new RegExp(`baseline capability id ${live} is not dead`)
  );
  assert.ok(
    !readBaseline(repoRoot).dead_capability_ids.some((entry) =>
      parts.retiredIds.some((c) => c.id === entry.id)
    ),
    'the shipped baseline does not list a retired lane as a dead id'
  );
});

test('a baselined proxy pins the target and the method it was recorded with', (t) => {
  const root = fixtureTree(t);
  addProbeProxy(root);

  // Re-pointed at another dead route.
  editFile(root, `${WEB_API}/parity/probe-proxy/route.ts`, (source) =>
    source.replace(`'${PROBE_PROXY_TARGET}'`, `'${PROBE_PROXY_TARGET}-elsewhere'`)
  );
  const moved = auditTree(root);
  assert.equal(moved.length, 1, moved.join('\n'));
  assert.match(moved[0], new RegExp(`web proxy ${PROBE_PROXY_ROUTE} now sends .*-elsewhere`));
  assert.match(
    moved[0],
    new RegExp(`baseline records ${PROBE_PROXY_METHOD} ${PROBE_PROXY_TARGET}`)
  );
});

test('a baselined proxy that changes method is a new finding, not the old debt', (t) => {
  const root = fixtureTree(t);
  addProbeProxy(root);
  editBaseline(root, (baseline) => {
    const entry = baseline.dead_web_proxies.find((e) => e.route === PROBE_PROXY_ROUTE);
    entry.method = 'PUT';
  });
  const problems = auditTree(root);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(
    problems[0],
    new RegExp(
      `web proxy ${PROBE_PROXY_ROUTE} now sends ${PROBE_PROXY_METHOD} ${PROBE_PROXY_TARGET}`
    )
  );
  assert.match(problems[0], new RegExp(`baseline records PUT ${PROBE_PROXY_TARGET}`));
});

test('a baselined proxy that becomes live leaves a stale entry behind', (t) => {
  // The host gains the lane the probe proxy aims at and the probe id declares:
  // both baselined entries go stale at once, which is the edit CU-149 makes.
  const root = fixtureTree(t);
  addProbeLane(root);
  addProbeProxy(root);
  editBaseline(root, (baseline) => baseline.dead_capability_ids.push(probeEntry()));
  giveHostAProbeRoute(root, PROBE_ROUTE);
  giveHostAProbeRoute(root, PROBE_PROXY_TARGET);
  const problems = auditTree(root).join('\n');
  assert.match(problems, new RegExp(`baseline web proxy ${PROBE_PROXY_ROUTE} is not dead`));
  assert.match(problems, new RegExp(`baseline capability id ${PROBE_ID} is not dead`));
});

test('auditRouteParity is pure enough to be driven directly, with no filesystem', () => {
  const declared = [{ id: 'a', kind: 'exact', routes: ['/a'], exact: ['/a'], patterns: [] }];
  const host = { routes: [], methods: {}, retired: [] };
  const proxies = [{ route: '/api/a', target: '/a', method: 'POST' }];
  const problems = auditRouteParity(
    { declared, host, proxies, baseline: { dead_capability_ids: [], dead_web_proxies: [] } },
    { today: PINNED_TODAY }
  );
  assert.equal(problems.length, 2, 'the id has no route, and the proxy aimed at it is dead');
  assert.ok(problems.some((p) => /capability id a is declared/.test(p)));
  assert.ok(problems.some((p) => /web proxy \/api\/a -> POST \/a is dead/.test(p)));
  assert.deepEqual(
    auditRouteParity(
      {
        declared: [],
        host,
        proxies: [],
        baseline: { dead_capability_ids: [], dead_web_proxies: [] },
      },
      { today: PINNED_TODAY }
    ),
    [],
    'an empty tree with an empty baseline is clean'
  );
  assert.throws(
    () =>
      auditRouteParity(
        { declared: [], host, proxies: [], baseline: null },
        { today: '2026-02-30' }
      ),
    /today must be a real YYYY-MM-DD date/
  );
});

// ---------------------------------------------------------------------------
// Dates: the expiry rule, the horizon, and what counts as a date
// ---------------------------------------------------------------------------

const emptyBaseline = () => ({ dead_capability_ids: [], dead_web_proxies: [] });
const deadId = (id, expires) => ({
  id,
  declared_route: `/${id}`,
  reason: 'r',
  owner: 'o',
  expires,
});
const deadProxy = (route, target, method, expires) => ({
  route,
  target,
  method,
  reason: 'r',
  owner: 'o',
  expires,
});
const capability = (id) => ({
  id,
  kind: 'exact',
  routes: [`/${id}`],
  exact: [`/${id}`],
  patterns: [],
});
const oneDeadId = (expires) => ({
  declared: [capability('a')],
  host: { routes: [], methods: {}, retired: [] },
  proxies: [],
  baseline: { ...emptyBaseline(), dead_capability_ids: [deadId('a', expires)] },
});

test('an entry expires on its date: the day before is green, the day itself and every later day are red', () => {
  const expires = addDays(PINNED_TODAY, 30);
  const world = oneDeadId(expires);
  assert.deepEqual(auditRouteParity(world, { today: addDays(expires, -1) }), []);
  for (const today of [expires, addDays(expires, 1), addDays(expires, 400)]) {
    const problems = auditRouteParity(world, { today });
    assert.equal(problems.length, 1, today);
    assert.match(problems[0], new RegExp(`baseline entry a expired on ${expires} \\(owner: o\\)`));
  }
});

test('no entry may be dated beyond the horizon, so a date cannot be pushed out of reach', () => {
  assert.equal(MAX_EXPIRY_HORIZON_DAYS, 60, 'widening the horizon is a decision, made here');
  const audit = (days) =>
    auditRouteParity(oneDeadId(addDays(PINNED_TODAY, days)), { today: PINNED_TODAY });
  assert.deepEqual(audit(MAX_EXPIRY_HORIZON_DAYS), [], 'exactly at the horizon is accepted');
  const beyond = audit(MAX_EXPIRY_HORIZON_DAYS + 1);
  assert.equal(beyond.length, 1);
  assert.match(
    beyond[0],
    /expires on 2026-12-05, more than 60 days after 2026-10-05; the latest date accepted today is 2026-12-04/
  );
  for (const expires of ['2027-06-01', '2099-12-31']) {
    const problems = auditRouteParity(oneDeadId(expires), { today: PINNED_TODAY });
    assert.match(problems.join('\n'), /more than 60 days after/, expires);
  }
});

test('parseIsoDate accepts a real calendar date and nothing else', () => {
  for (const date of ['2026-10-05', '2028-02-29', '1999-12-31']) {
    assert.notEqual(parseIsoDate(date), null, date);
  }
  for (const date of [
    '2027-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-99-99',
    '2026-1-5',
    '2026-10-05T00:00:00Z',
    ' 2026-10-05',
    '',
    null,
    undefined,
    20261005,
  ]) {
    assert.equal(parseIsoDate(date), null, JSON.stringify(date));
  }
});

const shippedBaseline = () =>
  structuredClone(JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), 'utf8')));

test('loadBaseline names what each entry is missing', () => {
  const cases = [
    [
      'an id with an expiry but no owner',
      (b) => delete b.dead_capability_ids[0].owner,
      /has no owner/,
    ],
    ['an owner of only spaces', (b) => (b.dead_capability_ids[0].owner = '  '), /has no owner/],
    ['no reason', (b) => delete b.dead_capability_ids[0].reason, /has no reason/],
    [
      'no expiry',
      (b) => delete b.dead_capability_ids[0].expires,
      /no real calendar date as expiry/,
    ],
    [
      'an impossible date',
      (b) => (b.dead_capability_ids[0].expires = '2026-99-99'),
      /no real calendar date/,
    ],
    // The shipped baseline's proxy list is empty once CU-149 has repaired the
    // last one, so these three seed a synthetic entry to damage rather than
    // reaching for a real one.
    [
      'a proxy without a target',
      (b) => {
        b.dead_web_proxies.push(deadProxy('/api/x', '/x', 'GET', '2026-11-30'));
        delete b.dead_web_proxies[0].target;
      },
      /has no target path/,
    ],
    [
      'a proxy without a method',
      (b) => {
        b.dead_web_proxies.push(deadProxy('/api/x', '/x', 'GET', '2026-11-30'));
        delete b.dead_web_proxies[0].method;
      },
      /has no HTTP method/,
    ],
    [
      'a lower-case method',
      (b) => {
        b.dead_web_proxies.push(deadProxy('/api/x', '/x', 'GET', '2026-11-30'));
        b.dead_web_proxies[0].method = 'get';
      },
      /has no HTTP method/,
    ],
    [
      'an id listed twice',
      (b) => b.dead_capability_ids.push({ ...b.dead_capability_ids[0] }),
      /is listed twice/,
    ],
    [
      'an id list that is not an array',
      (b) => (b.dead_capability_ids = {}),
      /baseline\.dead_capability_ids must be an array/,
    ],
    [
      'a proxy list that is not an array',
      (b) => (b.dead_web_proxies = 'none'),
      /baseline\.dead_web_proxies must be an array/,
    ],
  ];
  for (const [name, change, expected] of cases) {
    const baseline = shippedBaseline();
    change(baseline);
    assert.throws(() => loadBaseline(baseline), expected, name);
  }
  for (const value of [null, [], 'x']) {
    assert.throws(() => loadBaseline(value), /must be a JSON object/);
  }
  const twoMethods = shippedBaseline();
  twoMethods.dead_web_proxies.push(
    deadProxy('/api/x', '/x', 'GET', '2026-11-30'),
    deadProxy('/api/x', '/x', 'DELETE', '2026-11-30')
  );
  assert.doesNotThrow(() => loadBaseline(twoMethods), 'one route may be dead for two methods');
});

test('one route that is dead for two methods needs both recorded', () => {
  const route = '/api/two';
  const proxies = [
    { route, target: '/two', method: 'GET' },
    { route, target: '/two', method: 'POST' },
  ];
  const world = (entries) => ({
    declared: [],
    host: { routes: [], methods: {}, retired: [] },
    proxies,
    baseline: { ...emptyBaseline(), dead_web_proxies: entries },
  });
  const expires = addDays(PINNED_TODAY, 30);
  const both = [
    deadProxy(route, '/two', 'GET', expires),
    deadProxy(route, '/two', 'POST', expires),
  ];
  assert.deepEqual(auditRouteParity(world(both), { today: PINNED_TODAY }), []);
  const onlyOne = auditRouteParity(world(both.slice(0, 1)), { today: PINNED_TODAY });
  assert.equal(onlyOne.length, 1);
  assert.match(onlyOne[0], /web proxy \/api\/two now sends POST \/two/);
});

// ---------------------------------------------------------------------------
// --base: the baseline only shrinks against history
// ---------------------------------------------------------------------------

function commitAll(root) {
  gitIn(root, 'init', '-q', '--initial-branch=main');
  gitIn(root, 'add', '-A');
  gitIn(root, 'commit', '-q', '-m', 'base');
}

const BASE_OK =
  /Baseline shrink check against HEAD: no entry added, none extended, no proxy re-pointed\./;

test('--base: a baseline that is unchanged passes and says what it checked', (t) => {
  const root = fixtureTree(t, { git: true });
  const result = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, BASE_OK);
});

test('--base: a dead id added together with its own baseline entry fails, which the tree alone cannot tell', (t) => {
  const root = fixtureTree(t, { git: true });
  addProbeLane(root);
  editBaseline(root, (baseline) => baseline.dead_capability_ids.push(probeEntry()));
  assert.equal(
    runGate(root).status,
    0,
    'without a base the tree is consistent with itself: this is the hole --base closes'
  );
  const result = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(result.status, 1);
  assert.match(result.out, new RegExp(`baseline capability id ${PROBE_ID} was added since HEAD`));
});

test('--base: a dead proxy added together with its own baseline entry fails', (t) => {
  const root = fixtureTree(t, { git: true });
  writeFile(
    root,
    `${WEB_API}/parity/probe/route.ts`,
    "import { proxyToNitro } from '@/lib/nitro';\nexport async function POST() {\n  return proxyToNitro('/parity/probe/upstream', { method: 'POST' });\n}\n"
  );
  editBaseline(root, (baseline) =>
    baseline.dead_web_proxies.push({
      route: '/api/parity/probe',
      target: '/parity/probe/upstream',
      method: 'POST',
      reason: 'a synthetic proxy',
      owner: 'the test',
      expires: '2026-11-30',
    })
  );
  assert.equal(runGate(root).status, 0);
  const result = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(result.status, 1);
  assert.match(
    result.out,
    /baseline web proxy \/api\/parity\/probe \(POST \/parity\/probe\/upstream\) was added since HEAD/
  );
});

test('--base: pushing an expiry out fails, pulling one in does not', (t) => {
  const root = fixtureTree(t, { git: true });
  const original = readBaseline(root);
  const entries = (baseline) => [...baseline.dead_capability_ids, ...baseline.dead_web_proxies];
  const latest = entries(original)
    .map((entry) => entry.expires)
    .sort()
    .at(-1);

  editBaseline(root, (baseline) => {
    for (const entry of entries(baseline)) entry.expires = addDays(latest, 4);
  });
  assert.equal(
    runGate(root).status,
    0,
    `${addDays(latest, 4)} is inside the horizon, so only the base can tell it was extended`
  );
  const extended = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(extended.status, 1);
  assert.match(
    extended.out,
    new RegExp(`was extended from ${latest} to ${addDays(latest, 4)} since HEAD`)
  );

  editBaseline(root, (baseline) => {
    for (const entry of entries(baseline)) entry.expires = addDays(latest, -5);
  });
  const shortened = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(shortened.status, 0, shortened.out);
});

test('--base: re-pointing a baselined proxy at another dead route fails even when the baseline is edited to match', (t) => {
  const root = fixtureTree(t, { git: true });
  // The probe has to be in the base commit, or the entry would be an addition
  // and the gate would fail for that reason instead of the one under test.
  addProbeProxy(root);
  commitAll(root);
  const moved = `${PROBE_PROXY_TARGET}-elsewhere`;
  editFile(root, `${WEB_API}/parity/probe-proxy/route.ts`, (source) =>
    source.replace(`'${PROBE_PROXY_TARGET}'`, `'${moved}'`)
  );
  editBaseline(root, (baseline) => {
    baseline.dead_web_proxies.find((entry) => entry.route === PROBE_PROXY_ROUTE).target = moved;
  });
  assert.equal(runGate(root).status, 0, 'the tree and the edited baseline agree');
  const result = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(result.status, 1);
  assert.match(
    result.out,
    new RegExp(`baseline web proxy ${PROBE_PROXY_ROUTE} was re-pointed since HEAD`)
  );
});

test('--base: deleting an entry is the edit that passes, but only once the lane works', (t) => {
  const root = fixtureTree(t);
  addProbeLane(root);
  editBaseline(root, (baseline) => baseline.dead_capability_ids.push(probeEntry()));
  commitAll(root);

  editBaseline(root, (baseline) => {
    baseline.dead_capability_ids = baseline.dead_capability_ids.filter((e) => e.id !== PROBE_ID);
  });
  const early = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(early.status, 1, 'the entry is gone but the lane is still dead');
  assert.match(
    early.out,
    new RegExp(`capability id ${PROBE_ID} is declared .* not in the baseline`)
  );

  giveHostTheProbeRoute(root);
  const fixed = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(fixed.status, 0, fixed.out);
  assert.match(fixed.out, BASE_OK);
});

test('--base: a base that has no baseline is the change that introduces it', (t) => {
  const root = fixtureTree(t);
  const shipped = readFileSync(join(root, BASELINE_PATH));
  rmSync(join(root, BASELINE_PATH));
  commitAll(root);
  writeFileSync(join(root, BASELINE_PATH), shipped);
  const result = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /the baseline does not exist there, so this change introduces it/);
});

test('--base: a ref that is not a commit, or a base baseline that cannot be read, is an error, never a pass', (t) => {
  const root = fixtureTree(t, { git: true });
  const missing = runGate(root, { args: ['--base', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'] });
  assert.equal(missing.status, 1);
  assert.match(missing.out, /is not a commit in this checkout/);
  assert.match(missing.out, /git fetch --no-tags --depth=1 origin deadbeef/);

  writeFileSync(join(root, BASELINE_PATH), '{"dead_capability_ids": 1}\n');
  gitIn(root, 'commit', '-q', '-am', 'break the baseline');
  writeFileSync(join(root, BASELINE_PATH), readFileSync(join(repoRoot, BASELINE_PATH)));
  const broken = runGate(root, { args: ['--base', 'HEAD'] });
  assert.equal(broken.status, 1);
  assert.match(broken.out, /the baseline at HEAD has no dead_capability_ids array/);
});

test('--base reads the checkout it was pointed at, whatever GIT_DIR the caller exports', (t) => {
  const root = fixtureTree(t, { git: true });
  const elsewhere = mkdtempSync(join(tmpdir(), 'route-parity-other-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFile(elsewhere, 'README', 'a different repository, with no baseline in it\n');
  commitAll(elsewhere);
  const result = runGate(root, {
    args: ['--base', 'HEAD'],
    env: { GIT_DIR: join(elsewhere, '.git'), GIT_WORK_TREE: elsewhere },
  });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, BASE_OK, 'compared with the fixture, not with the exported repository');
});

test('auditBaselineShrink lets an owner or a reason change, and nothing else', () => {
  const entry = (extra) => ({
    id: 'a',
    declared_route: '/a',
    reason: 'r',
    owner: 'o',
    expires: '2026-11-30',
    ...extra,
  });
  const proxy = (extra) => ({
    route: '/api/a',
    target: '/a',
    method: 'GET',
    reason: 'r',
    owner: 'o',
    expires: '2026-11-30',
    ...extra,
  });
  const base = { dead_capability_ids: [entry()], dead_web_proxies: [proxy()] };
  const shrink = (current) => auditBaselineShrink({ base, current, ref: 'main' });
  assert.deepEqual(
    shrink({
      dead_capability_ids: [entry({ owner: 'someone else', reason: 'rewritten' })],
      dead_web_proxies: [proxy({ owner: 'someone else', reason: 'rewritten' })],
    }),
    []
  );
  assert.deepEqual(shrink(emptyBaseline()), [], 'deleting everything is a shrink');
  assert.equal(
    shrink({ dead_capability_ids: [entry({ expires: '2026-12-01' })], dead_web_proxies: [] })
      .length,
    1
  );
  assert.equal(
    shrink({ dead_capability_ids: [], dead_web_proxies: [proxy({ method: 'POST' })] }).length,
    1
  );
  assert.equal(
    shrink({ dead_capability_ids: [entry({ id: 'b' })], dead_web_proxies: [] }).length,
    1
  );
});

// ---------------------------------------------------------------------------
// The command line: arguments, the clock, the path it is started through
// ---------------------------------------------------------------------------

test('there is no flag that moves the clock, and an argument nobody defined is an error', (t) => {
  const root = fixtureTree(t);
  for (const args of [
    ['--today', '2099-01-01'],
    ['--nope'],
    ['--base'],
    ['--base=-x'],
    ['--base', '--upload-pack=x'],
  ]) {
    const result = runGate(root, { args });
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.out}`);
    assert.match(result.out, /Usage: node scripts\/check-capability-route-parity\.mjs/);
  }
  assert.throws(() => parseArgs(['--today', '2099-01-01']), /unknown argument "--today"/);
  assert.throws(() => parseArgs(['--root']), /--root needs a value/);
  assert.deepEqual(
    [
      parseArgs(['--root=/x', '--base=HEAD~1']).root,
      parseArgs(['--root=/x', '--base=HEAD~1']).base,
    ],
    ['/x', 'HEAD~1']
  );
});

test('the gate takes its day from the clock, in UTC: green through the window, red from the first expiry', (t) => {
  const root = fixtureTree(t);
  const baseline = readBaseline(root);
  const expiries = [...baseline.dead_capability_ids, ...baseline.dead_web_proxies]
    .map((entry) => entry.expires)
    .sort();
  const earliest = expiries[0];
  const latest = expiries.at(-1);
  const firstDay = addDays(latest, -MAX_EXPIRY_HORIZON_DAYS);
  const lastDay = addDays(earliest, -1);
  assert.ok(firstDay <= lastDay, 'the shipped dates leave a window in which the gate can be green');

  for (const day of [firstDay, PINNED_TODAY, lastDay]) {
    assert.equal(
      runGate(root, { now: `${day}T12:00:00Z` }).status,
      0,
      `${day} is inside the window`
    );
  }
  const tooEarly = runGate(root, { now: `${addDays(firstDay, -1)}T12:00:00Z` });
  assert.equal(tooEarly.status, 1, 'the day before the window: an expiry is beyond the horizon');
  assert.match(tooEarly.out, /more than 60 days after/);
  const expired = runGate(root, { now: `${earliest}T00:00:00Z` });
  assert.equal(expired.status, 1, 'the first day an entry no longer holds');
  assert.match(expired.out, new RegExp(`expired on ${earliest}`));
});

test('the gate reads the UTC day whatever the local zone says', (t) => {
  const root = fixtureTree(t);
  const earliest = [
    ...readBaseline(root).dead_capability_ids,
    ...readBaseline(root).dead_web_proxies,
  ]
    .map((entry) => entry.expires)
    .sort()[0];
  const env = (timeZone) => ({ ...process.env, FAKE_NOW: `${earliest}T00:30:00Z`, TZ: timeZone });
  for (const timeZone of ['Pacific/Honolulu', 'Asia/Shanghai', 'Pacific/Kiritimati']) {
    const environment = env(timeZone);
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ['--import', FAKE_CLOCK_IMPORT, script, '--root', root],
      { encoding: 'utf8', env: environment }
    );
    assert.equal(result.status, 1, `${timeZone}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`expired on ${earliest}`), timeZone);
  }
});

test('the gate still checks when it is started through a symlinked path', (t) => {
  const root = fixtureTree(t);
  rmSync(join(root, BASELINE_PATH)); // a tree that has to fail
  const linkDir = mkdtempSync(join(tmpdir(), 'route-parity-link-'));
  t.after(() => rmSync(linkDir, { recursive: true, force: true }));
  symlinkSync(dirname(script), join(linkDir, 'scripts'));
  const result = runGate(root, {
    entry: join(linkDir, 'scripts', 'check-capability-route-parity.mjs'),
  });
  assert.equal(result.status, 1, `a symlinked start must not read as an import: ${result.out}`);
  assert.match(result.out, /no baseline at/);
});

// ---------------------------------------------------------------------------
// The shipped baseline
// ---------------------------------------------------------------------------

// What the baseline held when it was reviewed on 2026-10-05, entry by entry. It is
// a CEILING, not a mirror: every shipped entry has to be here, with this owner and
// no later date, so adding an entry, handing one to someone else or extending a
// date shows up as a change to this table in review. Deleting an entry - what a
// fix does - leaves the test green. The base comparison (`--base`, run by CI on a
// pull request) is the second line; this one needs no git history.
const OPERATOR = 'neo-os-services platform operator';
const REBUILD = `${OPERATOR} (needs the EIF rebuild window)`;
const CU149_REBUILD = `${OPERATOR} (CU-149, needs the EIF rebuild window)`;
const CU149_PROXY = `${OPERATOR} (CU-149 removes the proxy)`;
const CEILING_EXPIRES = '2026-11-30';
const CEILING_IDS = new Map([
  ['neodid_providers', REBUILD],
  ['neodid_runtime', REBUILD],
  ['providers', REBUILD],
  ['oracle_heartbeat', REBUILD],
  ['feeds_catalog', CU149_REBUILD],
  ['feeds_price_symbol', CU149_REBUILD],
  ['feeds_price', CU149_REBUILD],
  ['txproxy_invoke', REBUILD],
  ['relay_transaction', CU149_PROXY],
  ['compute_functions', CU149_REBUILD],
  ['compute_jobs_id', CU149_REBUILD],
  ['compute_jobs', CU149_REBUILD],
]);
const CEILING_PROXIES = new Map([
  ['/api/neodid/runtime', ['/neodid/runtime', 'GET', CU149_PROXY]],
  ['/api/compute/functions', ['/compute/functions', 'GET', CU149_PROXY]],
  ['/api/relay/transaction', ['/relay/transaction', 'POST', CU149_PROXY]],
  [
    '/api/sign/payload',
    [
      '/sign/payload',
      'POST',
      `${OPERATOR} (CU-149 removes the proxy; the lane itself is a deliberate security retirement, not a gap)`,
    ],
  ],
  [
    '/api/runtime/keys/derived',
    ['/keys/derived', 'GET', `${OPERATOR} (CU-149 repairs or removes the proxy)`],
  ],
]);

test('the shipped baseline is a ceiling: each entry is pinned with its owner and date, and only deletion passes', () => {
  const baseline = shippedBaseline();
  for (const entry of baseline.dead_capability_ids) {
    assert.ok(
      CEILING_IDS.has(entry.id),
      `${entry.id} is not in the reviewed ceiling: it was added`
    );
    assert.equal(entry.owner, CEILING_IDS.get(entry.id), `${entry.id}: the owner changed`);
    assert.ok(
      entry.expires <= CEILING_EXPIRES,
      `${entry.id}: expires ${entry.expires} is later than ${CEILING_EXPIRES}`
    );
  }
  for (const entry of baseline.dead_web_proxies) {
    assert.ok(
      CEILING_PROXIES.has(entry.route),
      `${entry.route} is not in the reviewed ceiling: it was added`
    );
    const [target, method, owner] = CEILING_PROXIES.get(entry.route);
    assert.deepEqual(
      [entry.target, entry.method, entry.owner],
      [target, method, owner],
      entry.route
    );
    assert.ok(
      entry.expires <= CEILING_EXPIRES,
      `${entry.route}: expires ${entry.expires} is later than ${CEILING_EXPIRES}`
    );
  }
  // A retired lane is a dead PROXY (the lane answers 503), never a dead id.
  assert.ok(!baseline.dead_capability_ids.some((entry) => entry.id === 'sign_payload'));
});

test('every shipped entry fits the horizon from the day the baseline was recorded', () => {
  const baseline = shippedBaseline();
  assert.notEqual(parseIsoDate(baseline.recorded_on), null, 'recorded_on is a real date');
  const horizon = addDays(baseline.recorded_on, MAX_EXPIRY_HORIZON_DAYS);
  for (const entry of [...baseline.dead_capability_ids, ...baseline.dead_web_proxies]) {
    assert.ok(
      entry.expires > baseline.recorded_on,
      `${entry.id || entry.route} expires after it was recorded`
    );
    assert.ok(
      entry.expires <= horizon,
      `${entry.id || entry.route} expires within ${MAX_EXPIRY_HORIZON_DAYS} days of recording`
    );
  }
});
