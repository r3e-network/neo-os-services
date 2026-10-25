// Tests for scripts/check-npm-audit.mjs, the blocking npm audit gate of ci.yml lint-and-format.
//
// Policy under test: production dependencies (`npm audit --omit=dev`) must carry no advisory at or
// above the blocking severity, and every dev-only advisory must be covered by a dated, owner-assigned
// exception in config/npm-audit-exceptions.json. One test per rule; the rules that matter most also
// run through the CLI so the exit path is pinned, with a fake `npm` on PATH (the same seam
// check-rust-audit.test.mjs uses for `cargo`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..');
const checker = join(repoRoot, 'scripts', 'check-npm-audit.mjs');
const loadGate = () => import('./check-npm-audit.mjs');

const OWNER = 'NeoOS program lead (delegated by the owner)';
const TODAY = '2026-10-05';

// The report `npm audit --json` printed for this repository's lock at origin/main 0fb1f80 (npm
// 10.9.2): ONE advisory, GHSA-vfj7-8cjw-p6xm on braces, carried by four more packages through
// string `via` chains. Kept verbatim so the tests run against npm's real shape.
const REAL_DEV_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    '@next/eslint-plugin-next': {
      name: '@next/eslint-plugin-next',
      severity: 'high',
      isDirect: false,
      via: ['fast-glob'],
      effects: ['eslint-config-next'],
      range: '>=14.3.0-canary.0',
      nodes: ['apps/web/node_modules/@next/eslint-plugin-next'],
      fixAvailable: {
        name: 'eslint-config-next',
        version: '14.2.35',
        isSemVerMajor: true,
      },
    },
    braces: {
      name: 'braces',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1240992,
          name: 'braces',
          dependency: 'braces',
          title:
            'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
          url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
          severity: 'high',
          cwe: ['CWE-674'],
          cvss: {
            score: 7.5,
            vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
          },
          range: '<=3.0.3',
        },
      ],
      effects: ['micromatch'],
      range: '*',
      nodes: ['node_modules/braces'],
      fixAvailable: {
        name: 'eslint-config-next',
        version: '14.2.35',
        isSemVerMajor: true,
      },
    },
    'eslint-config-next': {
      name: 'eslint-config-next',
      severity: 'high',
      isDirect: true,
      via: ['@next/eslint-plugin-next'],
      effects: [],
      range: '>=14.3.0-canary.0',
      nodes: ['apps/web/node_modules/eslint-config-next'],
      fixAvailable: {
        name: 'eslint-config-next',
        version: '14.2.35',
        isSemVerMajor: true,
      },
    },
    'fast-glob': {
      name: 'fast-glob',
      severity: 'high',
      isDirect: false,
      via: ['micromatch'],
      effects: ['@next/eslint-plugin-next'],
      range: '*',
      nodes: ['node_modules/fast-glob'],
      fixAvailable: {
        name: 'eslint-config-next',
        version: '14.2.35',
        isSemVerMajor: true,
      },
    },
    micromatch: {
      name: 'micromatch',
      severity: 'high',
      isDirect: false,
      via: ['braces'],
      effects: ['fast-glob'],
      range: '>=0.2.0',
      nodes: ['node_modules/micromatch'],
      fixAvailable: {
        name: 'eslint-config-next',
        version: '14.2.35',
        isSemVerMajor: true,
      },
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 5,
      critical: 0,
      total: 5,
    },
    dependencies: {
      prod: 367,
      dev: 367,
      optional: 126,
      peer: 2,
      peerOptional: 0,
      total: 804,
    },
  },
};

function report(vulnerabilities = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const vulnerability of Object.values(vulnerabilities)) {
    counts[vulnerability.severity] += 1;
    counts.total += 1;
  }
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: counts,
      dependencies: { prod: 1, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 2 },
    },
  };
}

function advisoryVulnerability(
  name,
  { id = 'GHSA-aaaa-bbbb-cccc', severity = 'high', title = 'test advisory' } = {}
) {
  return {
    name,
    severity,
    isDirect: false,
    via: [
      {
        source: 1000001,
        name,
        dependency: name,
        title,
        url: `https://github.com/advisories/${id}`,
        severity,
        cwe: [],
        cvss: { score: 0, vectorString: null },
        range: '<=1.0.0',
      },
    ],
    effects: [],
    range: '*',
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
}

const CLEAN = report();

function exception(overrides = {}) {
  return {
    advisory: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    reason:
      'dev-only: reachable only through the apps/web devDependency eslint-config-next; ' +
      'npm audit --omit=dev reports no advisory',
    owner: OWNER,
    expiresOn: '2026-11-05',
    ...overrides,
  };
}

function exceptionsDocument(...entries) {
  return { version: 1, exceptions: entries };
}

async function evaluate({
  production = CLEAN,
  full = REAL_DEV_REPORT,
  exceptions = exceptionsDocument(exception()),
  today = TODAY,
} = {}) {
  const { evaluateNpmAudit } = await loadGate();
  return evaluateNpmAudit({ production, full, exceptions, today });
}

function messages(result) {
  return result.problems.join('\n');
}

// ---------------------------------------------------------------------------------------------
// evaluateNpmAudit: the rules
// ---------------------------------------------------------------------------------------------

test('policy constants: moderate blocks, the horizon is capped at 90 days', async () => {
  const { BLOCKING_SEVERITY, MAX_EXCEPTION_HORIZON_DAYS } = await loadGate();
  assert.equal(BLOCKING_SEVERITY, 'moderate');
  assert.equal(MAX_EXCEPTION_HORIZON_DAYS, 90);
});

test('the real dev report is covered by the reviewed exception and production is clean', async () => {
  const result = await evaluate();
  assert.deepEqual(result.problems, []);
  assert.equal(result.excepted.length, 1);
  assert.deepEqual(
    {
      advisory: result.excepted[0].advisory,
      package: result.excepted[0].package,
      severity: result.excepted[0].severity,
      owner: result.excepted[0].owner,
      expiresOn: result.excepted[0].expiresOn,
      daysLeft: result.excepted[0].daysLeft,
    },
    {
      advisory: 'GHSA-vfj7-8cjw-p6xm',
      package: 'braces',
      severity: 'high',
      owner: OWNER,
      expiresOn: '2026-11-05',
      daysLeft: 31,
    }
  );
});

for (const severity of ['moderate', 'high', 'critical']) {
  test(`a production advisory at ${severity} blocks even when it is excepted`, async () => {
    const production = report({
      'left-pad': advisoryVulnerability('left-pad', { id: 'GHSA-pppp-qqqq-rrrr', severity }),
    });
    const withoutException = await evaluate({
      production,
      full: production,
      exceptions: exceptionsDocument(),
    });
    assert.match(
      messages(withoutException),
      new RegExp(`production dependency advisory GHSA-pppp-qqqq-rrrr \\(${severity}\\) in left-pad`)
    );
    const excepted = await evaluate({
      production,
      full: production,
      exceptions: exceptionsDocument(
        exception({ advisory: 'GHSA-pppp-qqqq-rrrr', package: 'left-pad' })
      ),
    });
    assert.match(messages(excepted), /production dependency advisory GHSA-pppp-qqqq-rrrr/);
    assert.match(
      messages(excepted),
      /exception GHSA-pppp-qqqq-rrrr \(left-pad\) .* production scope/
    );
    // It is judged under production only; it is never listed as an accepted dev-only exception.
    assert.deepEqual(excepted.excepted, []);
  });
}

test('a low production advisory does not block, but an exception for it is still refused', async () => {
  const production = report({
    'left-pad': advisoryVulnerability('left-pad', { id: 'GHSA-pppp-qqqq-rrrr', severity: 'low' }),
  });
  const plain = await evaluate({ production, full: production, exceptions: exceptionsDocument() });
  assert.deepEqual(plain.problems, []);
  assert.match(plain.notes.join('\n'), /GHSA-pppp-qqqq-rrrr/);
  const excepted = await evaluate({
    production,
    full: production,
    exceptions: exceptionsDocument(
      exception({ advisory: 'GHSA-pppp-qqqq-rrrr', package: 'left-pad' })
    ),
  });
  assert.match(
    messages(excepted),
    /exception GHSA-pppp-qqqq-rrrr \(left-pad\) .* production scope/
  );
});

test('a dev-only advisory with no exception blocks', async () => {
  const result = await evaluate({ exceptions: exceptionsDocument() });
  assert.match(
    messages(result),
    /dev-only advisory GHSA-vfj7-8cjw-p6xm \(high\) in braces has no exception in config\/npm-audit-exceptions\.json/
  );
});

test('a dev-only advisory below the blocking severity needs no exception', async () => {
  const full = report({
    'minor-dev-tool': advisoryVulnerability('minor-dev-tool', {
      id: 'GHSA-llll-oooo-wwww',
      severity: 'low',
    }),
  });
  const result = await evaluate({ full, exceptions: exceptionsDocument() });
  assert.deepEqual(result.problems, []);
  assert.match(result.notes.join('\n'), /GHSA-llll-oooo-wwww/);
});

test('an exception for the same advisory id on another package does not cover it', async () => {
  const result = await evaluate({
    exceptions: exceptionsDocument(exception({ package: 'micromatch' })),
  });
  assert.match(
    messages(result),
    /dev-only advisory GHSA-vfj7-8cjw-p6xm \(high\) in braces has no exception/
  );
  assert.match(
    messages(result),
    /exception GHSA-vfj7-8cjw-p6xm \(micromatch\) matches no advisory/
  );
});

test('an exception is expired on its expiresOn day and valid the day before', async () => {
  const before = await evaluate({ today: '2026-11-04' });
  assert.deepEqual(before.problems, []);
  assert.equal(before.excepted[0].daysLeft, 1);
  const onDay = await evaluate({ today: '2026-11-05' });
  assert.match(messages(onDay), /exception GHSA-vfj7-8cjw-p6xm \(braces\) expired on 2026-11-05/);
  assert.match(messages(onDay), new RegExp(OWNER.replace(/[()]/g, '\\$&')));
  const long = await evaluate({ today: '2027-03-01' });
  assert.match(messages(long), /expired on 2026-11-05/);
});

test('an exception may not reach more than 90 days beyond today', async () => {
  const atCap = await evaluate({
    exceptions: exceptionsDocument(exception({ expiresOn: '2027-01-03' })),
  });
  assert.deepEqual(atCap.problems, []);
  const overCap = await evaluate({
    exceptions: exceptionsDocument(exception({ expiresOn: '2027-01-04' })),
  });
  assert.match(messages(overCap), /expires on 2027-01-04, more than 90 days after 2026-10-05/);
  const never = await evaluate({
    exceptions: exceptionsDocument(exception({ expiresOn: '9999-12-31' })),
  });
  assert.match(messages(never), /more than 90 days after/);
});

for (const [label, overrides] of [
  ['owner is absent', { owner: undefined }],
  ['owner is blank', { owner: '   ' }],
  ['owner is not a string', { owner: 42 }],
]) {
  test(`an exception whose ${label} blocks`, async () => {
    const result = await evaluate({ exceptions: exceptionsDocument(exception(overrides)) });
    assert.match(messages(result), /GHSA-vfj7-8cjw-p6xm.*"owner" must be a non-empty string/);
  });
}

for (const [label, overrides] of [
  ['expiresOn is absent', { expiresOn: undefined }],
  ['expiresOn is blank', { expiresOn: '' }],
  ['expiresOn is not a string', { expiresOn: 20261105 }],
  ['expiresOn is not an ISO date', { expiresOn: '2026-11-5' }],
  ['expiresOn is not a real calendar date', { expiresOn: '2026-02-30' }],
  ['expiresOn is a placeholder', { expiresOn: '9999-99-99' }],
]) {
  test(`an exception whose ${label} blocks`, async () => {
    const result = await evaluate({ exceptions: exceptionsDocument(exception(overrides)) });
    assert.match(
      messages(result),
      /GHSA-vfj7-8cjw-p6xm.*"expiresOn" must be a real YYYY-MM-DD date/
    );
  });
}

for (const field of ['advisory', 'package', 'reason']) {
  test(`an exception without ${field} blocks`, async () => {
    const result = await evaluate({
      exceptions: exceptionsDocument(exception({ [field]: undefined })),
    });
    assert.match(messages(result), new RegExp(`"${field}" must be a non-empty string`));
  });
}

test('an exception whose advisory is not a GHSA id blocks', async () => {
  const result = await evaluate({
    exceptions: exceptionsDocument(exception({ advisory: 'CVE-2026-0001' })),
  });
  assert.match(messages(result), /"advisory" must be a GHSA id/);
});

test('an exception with a field the gate does not know blocks', async () => {
  const result = await evaluate({ exceptions: exceptionsDocument(exception({ ignore: true })) });
  assert.match(messages(result), /unknown field "ignore"/);
});

test('an exception that matches no advisory in the current audit is stale and blocks', async () => {
  const result = await evaluate({
    exceptions: exceptionsDocument(
      exception(),
      exception({ advisory: 'GHSA-xxxx-yyyy-zzzz', package: 'gone-package' })
    ),
  });
  assert.match(
    messages(result),
    /exception GHSA-xxxx-yyyy-zzzz \(gone-package\) matches no advisory/
  );
  assert.doesNotMatch(messages(result), /exception GHSA-vfj7-8cjw-p6xm .*matches no advisory/);
});

test('advisory ids compare case-insensitively', async () => {
  const result = await evaluate({
    exceptions: exceptionsDocument(exception({ advisory: 'ghsa-VFJ7-8CJW-P6XM' })),
  });
  assert.deepEqual(result.problems, []);
});

for (const [label, document, pattern] of [
  ['is not an object', [], /exceptions file must be a JSON object/],
  ['has no version 1', { exceptions: [] }, /exceptions file "version" must be 1/],
  ['has no exceptions array', { version: 1 }, /"exceptions" must be an array/],
  [
    'has an unknown top-level key',
    { version: 1, exceptions: [], extra: true },
    /unknown field "extra"/,
  ],
]) {
  test(`an exceptions file that ${label} blocks`, async () => {
    const result = await evaluate({ exceptions: document, full: CLEAN });
    assert.match(messages(result), pattern);
  });
}

test('an entry that is not an object blocks', async () => {
  const result = await evaluate({
    exceptions: { version: 1, exceptions: ['GHSA-vfj7-8cjw-p6xm'] },
  });
  assert.match(messages(result), /exceptions\[0\] must be an object/);
});

// Report validation: an audit that did not produce a report is a failure, never "no advisories".
for (const [label, broken, pattern] of [
  [
    'the registry error shape npm prints with exit code 1',
    { message: 'request to https://registry.npmjs.org failed', error: { summary: '', detail: '' } },
    /npm audit \(production\) failed: request to https:\/\/registry\.npmjs\.org failed/,
  ],
  ['a missing report', null, /npm audit \(production\) did not return a JSON object/],
  [
    'a report of another version',
    { ...CLEAN, auditReportVersion: 1 },
    /unsupported auditReportVersion 1/,
  ],
  [
    'a report without vulnerabilities',
    { auditReportVersion: 2, metadata: CLEAN.metadata },
    /no vulnerabilities object/,
  ],
  [
    'a report without metadata',
    { auditReportVersion: 2, vulnerabilities: {} },
    /npm audit \(production\) report has no numeric metadata\.vulnerabilities\.total/,
  ],
  [
    'a report whose total disagrees with its vulnerabilities',
    { ...CLEAN, metadata: { vulnerabilities: { total: 3 } } },
    /metadata\.vulnerabilities\.total is 3 but the report lists 0/,
  ],
]) {
  test(`a production report that is ${label} blocks`, async () => {
    const result = await evaluate({
      production: broken,
      full: CLEAN,
      exceptions: exceptionsDocument(),
    });
    assert.match(messages(result), pattern);
  });
  test(`a full report that is ${label} blocks`, async () => {
    const result = await evaluate({ full: broken, exceptions: exceptionsDocument() });
    assert.match(messages(result), new RegExp(pattern.source.replace('production', 'full')));
  });
}

test('a vulnerable package that traces to no advisory blocks', async () => {
  const orphan = {
    name: 'orphan',
    severity: 'high',
    isDirect: false,
    via: ['not-in-the-report'],
    effects: [],
    range: '*',
    nodes: ['node_modules/orphan'],
    fixAvailable: false,
  };
  const result = await evaluate({ full: report({ orphan }), exceptions: exceptionsDocument() });
  assert.match(messages(result), /vulnerable package orphan traces to no advisory/);
});

test('an advisory without a GHSA identity cannot be excepted and blocks', async () => {
  const vulnerability = advisoryVulnerability('mystery');
  vulnerability.via[0].url = 'https://example.invalid/advisory/1';
  const result = await evaluate({
    full: report({ mystery: vulnerability }),
    exceptions: exceptionsDocument(),
  });
  assert.match(messages(result), /advisory in mystery has no GHSA identity/);
});

test('an advisory with an unknown severity blocks', async () => {
  const vulnerability = advisoryVulnerability('odd');
  vulnerability.via[0].severity = 'catastrophic';
  vulnerability.severity = 'high';
  const result = await evaluate({
    full: report({ odd: vulnerability }),
    exceptions: exceptionsDocument(),
  });
  assert.match(
    messages(result),
    /advisory GHSA-aaaa-bbbb-cccc in odd has unknown severity "catastrophic"/
  );
});

test('a dependency cycle in the via chains terminates', async () => {
  const a = { ...advisoryVulnerability('a'), via: ['b', advisoryVulnerability('a').via[0]] };
  const b = {
    name: 'b',
    severity: 'high',
    isDirect: false,
    via: ['a'],
    effects: [],
    range: '*',
    nodes: ['node_modules/b'],
    fixAvailable: false,
  };
  const result = await evaluate({
    full: report({ a, b }),
    exceptions: exceptionsDocument(exception({ advisory: 'GHSA-aaaa-bbbb-cccc', package: 'a' })),
  });
  assert.deepEqual(result.problems, []);
});

// ---------------------------------------------------------------------------------------------
// The committed exception file
// ---------------------------------------------------------------------------------------------

test('the committed exception file contains no stale exceptions when the audit is clear', async () => {
  const committed = JSON.parse(
    readFileSync(join(repoRoot, 'config', 'npm-audit-exceptions.json'), 'utf8')
  );
  assert.deepEqual(committed, { version: 1, exceptions: [] });
});

// ---------------------------------------------------------------------------------------------
// The CLI exit path
// ---------------------------------------------------------------------------------------------

// Serves <scope>.<n>.json (with <scope>.<n>.rc) on the n-th call of a scope when it exists, and
// <scope>.json afterwards, so a test can script a transient failure followed by a good report.
const FAKE_NPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NPM_DIR/calls.log"
scope=full
case " $* " in
  *" --omit=dev "*) scope=production ;;
esac
n=$(cat "$FAKE_NPM_DIR/$scope.count" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_NPM_DIR/$scope.count"
if [ -f "$FAKE_NPM_DIR/$scope.$n.json" ]; then
  cat "$FAKE_NPM_DIR/$scope.$n.json"
  exit "$(cat "$FAKE_NPM_DIR/$scope.$n.rc")"
fi
cat "$FAKE_NPM_DIR/$scope.json"
exit "$(cat "$FAKE_NPM_DIR/$scope.rc")"
`;

function isoDay(offsetDays) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function runGate({
  production = CLEAN,
  full = REAL_DEV_REPORT,
  productionRaw,
  fullRaw,
  productionRc = 0,
  fullRc = 1,
  productionSequence = [],
  exceptions = exceptionsDocument(exception({ expiresOn: isoDay(30) })),
  exceptionsRaw,
  withExceptionsFile = true,
  withNpm = true,
} = {}) {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'neoos-npm-audit-'));
  try {
    const bin = join(directory, 'bin');
    mkdirSync(bin);
    mkdirSync(join(directory, 'config'));
    writeFileSync(join(directory, 'production.json'), productionRaw ?? JSON.stringify(production));
    writeFileSync(join(directory, 'production.rc'), String(productionRc));
    writeFileSync(join(directory, 'full.json'), fullRaw ?? JSON.stringify(full));
    writeFileSync(join(directory, 'full.rc'), String(fullRc));
    productionSequence.forEach(({ raw, rc }, index) => {
      writeFileSync(join(directory, `production.${index + 1}.json`), raw);
      writeFileSync(join(directory, `production.${index + 1}.rc`), String(rc));
    });
    if (withNpm) {
      writeFileSync(join(bin, 'npm'), FAKE_NPM);
      chmodSync(join(bin, 'npm'), 0o700);
    }
    if (withExceptionsFile) {
      writeFileSync(
        join(directory, 'config', 'npm-audit-exceptions.json'),
        exceptionsRaw ?? JSON.stringify(exceptions)
      );
    }
    const started = Date.now();
    const result = spawnSync(process.execPath, [checker], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: withNpm ? `${bin}${delimiter}${process.env.PATH ?? ''}` : bin,
        FAKE_NPM_DIR: directory,
      },
    });
    let calls = [];
    try {
      calls = readFileSync(join(directory, 'calls.log'), 'utf8').trim().split('\n');
    } catch {
      calls = [];
    }
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      elapsedMs: Date.now() - started,
      error: result.error,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const output = (result) => `${result.stdout}\n${result.stderr}`;

test('CLI: the real dev report with a valid exception and a clean production scope passes', () => {
  const result = runGate();
  assert.equal(result.status, 0, output(result));
  // The excepted advisory is never silent, and the pass line is the last thing printed.
  const lines = result.stdout.trim().split('\n');
  assert.match(result.stdout, /exception GHSA-vfj7-8cjw-p6xm \(braces, high\)/);
  assert.match(result.stdout, new RegExp(OWNER.replace(/[()]/g, '\\$&')));
  assert.match(lines.at(-1), /^\[check:npm-audit\] passed: /);
  assert.match(lines.at(-1), /production scope: 0 advisories at or above moderate/);
  assert.equal(result.stderr.trim(), '');
});

test('CLI: the gate audits production with --omit=dev and the full tree with --include=dev', () => {
  const result = runGate();
  assert.deepEqual([...result.calls].sort(), [
    'audit --include=dev --json',
    'audit --omit=dev --json',
  ]);
});

test('CLI: an advisory in production scope exits 1', () => {
  const production = report({
    'left-pad': advisoryVulnerability('left-pad', { id: 'GHSA-pppp-qqqq-rrrr', severity: 'high' }),
  });
  const result = runGate({ production, productionRc: 1, full: production });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /production dependency advisory GHSA-pppp-qqqq-rrrr \(high\) in left-pad/
  );
  assert.doesNotMatch(result.stdout, /passed/);
});

test('CLI: the dev advisory also present in production scope exits 1 even though it is excepted', () => {
  const result = runGate({ production: REAL_DEV_REPORT, productionRc: 1 });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /production dependency advisory GHSA-vfj7-8cjw-p6xm \(high\) in braces/
  );
  assert.match(result.stderr, /exception GHSA-vfj7-8cjw-p6xm \(braces\) .* production scope/);
});

test('CLI: an expired exception exits 1', () => {
  const result = runGate({
    exceptions: exceptionsDocument(exception({ expiresOn: '2020-01-01' })),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exception GHSA-vfj7-8cjw-p6xm \(braces\) expired on 2020-01-01/);
  // The accepted-exception line says so instead of printing a negative day count.
  assert.match(result.stdout, /exception GHSA-vfj7-8cjw-p6xm \(braces, high\) .* \(expired\):/);
  assert.doesNotMatch(result.stdout, /-\d+ days left/);
  assert.doesNotMatch(result.stdout, /passed/);
});

test('CLI: an exception that expires today exits 1', () => {
  const day = isoDay(0);
  const result = runGate({ exceptions: exceptionsDocument(exception({ expiresOn: day })) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`expired on ${day}`));
});

test('CLI: an exception without an owner exits 1', () => {
  const result = runGate({
    exceptions: exceptionsDocument(exception({ owner: undefined, expiresOn: isoDay(30) })),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"owner" must be a non-empty string/);
});

test('CLI: an exception without an expiry exits 1', () => {
  const result = runGate({ exceptions: exceptionsDocument(exception({ expiresOn: undefined })) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /"expiresOn" must be a real YYYY-MM-DD date/);
});

test('CLI: an exception that never expires exits 1', () => {
  const result = runGate({
    exceptions: exceptionsDocument(exception({ expiresOn: '9999-12-31' })),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /more than 90 days after/);
});

test('CLI: a dev advisory with no exception exits 1', () => {
  const result = runGate({ exceptions: exceptionsDocument() });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /dev-only advisory GHSA-vfj7-8cjw-p6xm \(high\) in braces has no exception/
  );
});

test('CLI: a stale exception exits 1', () => {
  const result = runGate({ full: CLEAN, fullRc: 0 });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /exception GHSA-vfj7-8cjw-p6xm \(braces\) matches no advisory in the current audit/
  );
});

test('CLI: the registry error shape with exit code 1 is a failure, not a clean audit', () => {
  const registryFailure = {
    message: 'request to http://127.0.0.1:9/-/npm/v1/security/audits/quick failed',
    error: { summary: '', detail: '' },
  };
  const result = runGate({
    production: registryFailure,
    productionRc: 1,
    full: registryFailure,
    fullRc: 1,
    exceptions: exceptionsDocument(),
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /npm audit \(production\) failed: request to http:\/\/127\.0\.0\.1:9/
  );
  assert.match(result.stderr, /npm audit \(full\) failed: request to http:\/\/127\.0\.0\.1:9/);
  assert.doesNotMatch(result.stdout, /passed/);
});

test('CLI: non-JSON output from npm is a failure', () => {
  const result = runGate({
    productionRaw: 'npm ERR! something broke\n',
    exceptions: exceptionsDocument(),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm audit \(production\) did not print JSON/);
});

test('CLI: an npm exit code other than 0 or 1 is a failure', () => {
  const result = runGate({ productionRc: 127 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm audit \(production\) exited with 127/);
  assert.equal(result.calls.filter((call) => call.includes('--omit=dev')).length, 1);
});

const REGISTRY_FAILURE = JSON.stringify({
  message:
    'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed, reason: socket hang up',
  error: { summary: '', detail: '' },
});
const productionCalls = (result) => result.calls.filter((call) => call.includes('--omit=dev'));

test('CLI: a transient registry failure is retried and a good report then passes', () => {
  const result = runGate({ productionSequence: [{ raw: REGISTRY_FAILURE, rc: 1 }] });
  assert.equal(result.status, 0, output(result));
  assert.equal(productionCalls(result).length, 2);
  assert.ok(result.elapsedMs >= 450, `no backoff before the retry (${result.elapsedMs} ms)`);
  assert.match(
    result.stderr,
    /npm audit \(production\) failed: .*socket hang up \(attempt 1\/3\); retrying/
  );
  assert.match(result.stdout.trim().split('\n').at(-1), /^\[check:npm-audit\] passed: /);
});

test('CLI: a registry failure that persists is retried three times and then fails', () => {
  const result = runGate({
    productionRaw: REGISTRY_FAILURE,
    productionRc: 1,
    exceptions: exceptionsDocument(),
  });
  assert.equal(result.status, 1);
  assert.equal(productionCalls(result).length, 3);
  assert.ok(result.elapsedMs >= 1900, `retries are not backed off (${result.elapsedMs} ms)`);
  assert.match(result.stderr, /\(attempt 1\/3\); retrying/);
  assert.match(result.stderr, /\(attempt 2\/3\); retrying/);
  assert.doesNotMatch(result.stderr, /\(attempt 3\/3\)/);
  assert.match(result.stderr, /npm audit \(production\) failed: .*socket hang up/);
  assert.doesNotMatch(result.stdout, /passed/);
});

test('CLI: a valid report with findings is final and is never retried', () => {
  const production = report({
    'left-pad': advisoryVulnerability('left-pad', { id: 'GHSA-pppp-qqqq-rrrr', severity: 'high' }),
  });
  const result = runGate({ production, productionRc: 1, full: production });
  assert.equal(result.status, 1);
  assert.equal(productionCalls(result).length, 1);
  assert.doesNotMatch(result.stderr, /retrying/);
});

test('CLI: a missing npm executable is a failure', () => {
  const result = runGate({ withNpm: false });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /npm audit \(production\) could not run/);
});

test('CLI: a missing exceptions file is a failure', () => {
  const result = runGate({ withExceptionsFile: false });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config\/npm-audit-exceptions\.json could not be read/);
});

test('CLI: a malformed exceptions file is a failure', () => {
  const result = runGate({ exceptionsRaw: '{ "version": 1, ' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /config\/npm-audit-exceptions\.json is not valid JSON/);
});
