// Hermetic public packaging controls; never invoke Docker, Nitro, AWS or RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('dual image packaging boundaries and measured-build orchestration', () => {
  const result = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./dual_image_test.py', import.meta.url)), '-v'],
    { encoding: 'utf8', timeout: 120000 }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// The normal ops lane also compiles and executes authoritative Rust preparation.
// A caller may explicitly supply its own private Cargo target to reuse deps.
test('dual public inputs use the exact host Rust preparation boundary', () => {
  const args = ['-B', fileURLToPath(new URL('./test-dual-preparation.py', import.meta.url))];
  if (process.env.CARGO_TARGET_DIR) args.push('--target-dir', process.env.CARGO_TARGET_DIR);
  const result = spawnSync('python3', args, {
    encoding: 'utf8',
    timeout: 1200000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

// Explicit native builder and LinuxKit adapter controls use synthetic inputs.
test('pinned native-cross inputs and explicit LinuxKit architecture adapter', () => {
  const result = spawnSync(
    'python3',
    ['-B', fileURLToPath(new URL('./dual_cross_test.py', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 120000,
    }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
