import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'compile.mjs');

test('compiles contracts with local imports into an isolated output directory', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'neoos-evm-compile-'));
  const result = spawnSync(process.execPath, [SCRIPT, 'MorpheusOracleEVM'], {
    encoding: 'utf8',
    env: { ...process.env, MORPHEUS_EVM_BUILD_DIR: outputDirectory },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const abi = JSON.parse(readFileSync(join(outputDirectory, 'MorpheusOracleEVM.abi.json'), 'utf8'));
  const bytecode = readFileSync(join(outputDirectory, 'MorpheusOracleEVM.bin'), 'utf8');

  assert.ok(
    abi.some((entry) => entry.type === 'function' && entry.name === 'approveCallbackAdmin')
  );
  assert.match(bytecode, /^[0-9a-f]+$/i);
  assert.ok(bytecode.length > 1000);
});

test('rejects contract names that could escape the source directory', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '../package'], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid contract name/);
});
