// The worker's test seams are module-private: __setCustodyTransportForTests on
// platform/custody.js, __setSecretsProviderForTests on platform/nitro-signer.js
// and the key material of oracle/crypto.js. Three process-global bridges used
// to stand beside them, globalThis[Symbol.for('neoos.custody.transport')],
// globalThis[Symbol.for('neoos.secrets.factory')] and
// globalThis[Symbol.for('neoos.resolveConfidentialPayload')], so that a second,
// vendored copy of those modules could share the worker's state. This gate keeps
// every such hook out of the worker's production modules. A Symbol.for key that
// starts with "neoos." fails, and so does a key that is not a string literal,
// because it cannot be shown not to be one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_SRC = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_FILE = /\.(?:js|mjs|cjs)$/;
const TEST_FILE = /\.test\.(?:js|mjs|cjs)$/;
const TEST_SUPPORT_DIR = 'test-support';

/** The process-global hook keys `source` names, and every non-literal key. */
function processGlobalHooks(source) {
  const found = [];
  for (const match of source.matchAll(/\bSymbol\s*\.\s*for\s*\(\s*/g)) {
    const rest = source.slice(match.index + match[0].length);
    const literal = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/.exec(rest);
    const isLiteral = literal && !(literal[1] === '`' && literal[2].includes('${'));
    if (!isLiteral) {
      found.push(`non-literal Symbol.for key: ${rest.slice(0, 40).split('\n')[0]}`);
    } else if (literal[2].startsWith('neoos.')) {
      found.push(literal[2]);
    }
  }
  return found;
}

/** Every production module under the worker's src/: tests and test helpers excluded. */
function productionModules(dir = WORKER_SRC) {
  const modules = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== TEST_SUPPORT_DIR) modules.push(...productionModules(path));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      modules.push(relative(WORKER_SRC, path).split(sep).join('/'));
    }
  }
  return modules.sort();
}

test('the hook detector finds neoos keys and non-literal keys only', () => {
  assert.deepEqual(
    processGlobalHooks(
      [
        "const a = Symbol.for('neoos.custody.transport');",
        'const b = globalThis[Symbol.for("neoos.secrets.factory")];',
        'globalThis[Symbol . for ( `neoos.resolveConfidentialPayload` )] = resolve;',
        'const c = Symbol.for(`neoos.${name}`);',
        'const d = Symbol.for(key);',
        "const e = Symbol.for('nodejs.util.inspect.custom');",
      ].join('\n')
    ),
    [
      'neoos.custody.transport',
      'neoos.secrets.factory',
      'neoos.resolveConfidentialPayload',
      'non-literal Symbol.for key: `neoos.${name}`);',
      'non-literal Symbol.for key: key);',
    ]
  );
});

test('no production worker module reads a process-global neoos hook', () => {
  const modules = productionModules();
  // The scan covers the modules the removed bridges lived in and the pinned
  // NeoDID lane that used them.
  for (const module of [
    'neodid/index.js',
    'oracle/crypto.js',
    'platform/custody.js',
    'platform/nitro-signer.js',
    'worker.js',
  ]) {
    assert.ok(modules.includes(module), `${module} is not scanned`);
  }
  const findings = modules.flatMap((module) =>
    processGlobalHooks(readFileSync(join(WORKER_SRC, module), 'utf8')).map(
      (hook) => `${module}: ${hook}`
    )
  );
  assert.deepEqual(findings, []);
});
