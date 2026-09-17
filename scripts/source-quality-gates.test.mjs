import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { getFileInfo } from 'prettier';
import { resolve } from 'node:path';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd });

for (const path of [
  'contracts/__tests__/Generated/NeoDIDRegistry.manifest.json',
  'crates/neo-os-games/src/engine-parity.goldens.json',
  'workers/nitro-worker/src/game/engine-parity.goldens.json',
]) {
  test(`formatter preserves generated artifact bytes: ${path}`, async () => {
    const info = await getFileInfo(resolve(cwd, path), {
      ignorePath: resolve(cwd, '.prettierignore'),
    });
    assert.equal(info.ignored, true);
  });
}

for (const path of [
  'services/neoswap/oracle-aggregator/src/metrics.ts',
  'services/neoswap/oracle-aggregator/src/twap-calculator.ts',
  'services/neoswap/price-feed/src/server.ts',
  'services/neoswap/price-feed/src/server.test.ts',
]) {
  test(`service source satisfies lint rules: ${path}`, async () => {
    const results = await eslint.lintFiles([path]);
    assert.equal(
      results.reduce((count, result) => count + result.errorCount, 0),
      0
    );
  });
}

for (const path of [
  'dist/index.js',
  'services/neoswap/oracle-aggregator/dist/twap-calculator.js',
  'services/neoswap/price-feed/dist/server.js',
]) {
  test(`lint excludes generated output: ${path}`, async () => {
    assert.equal(await eslint.isPathIgnored(path), true);
  });
}

for (const path of [
  'services/neoswap/oracle-aggregator/src/twap-calculator.ts',
  'services/neoswap/price-feed/src/server.ts',
  'scripts/source-quality-gates.test.mjs',
  'tests/cypress/e2e/neoswap-v2.cy.js',
]) {
  test(`lint retains authored source: ${path}`, async () => {
    assert.equal(await eslint.isPathIgnored(path), false);
  });
}
