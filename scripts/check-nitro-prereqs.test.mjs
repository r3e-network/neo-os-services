import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./check-nitro-prereqs.mjs', import.meta.url));

/**
 * The prerequisite report depends on local signer material, so its overall
 * `ok` is machine-specific. The measurement fields are not: they are derived
 * from committed files, so they are assertable anywhere. Only the parsed
 * fields are ever put in an assertion message — the report echoes merged
 * dotenv sources.
 */
function report() {
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.ok(result.stdout.trim().length > 0, 'the prerequisite check printed no report');
  return JSON.parse(result.stdout);
}

test('the prerequisite report states whether the enclave measurements are publishable', () => {
  const parsed = report();
  assert.equal(
    typeof parsed.checks?.nitro_measurements,
    'boolean',
    'checks.nitro_measurements must be reported'
  );
  assert.ok(
    Array.isArray(parsed.nitro_measurement_problems),
    'nitro_measurement_problems must be an array'
  );
  assert.equal(
    parsed.checks.nitro_measurements,
    parsed.nitro_measurement_problems.length === 0,
    JSON.stringify(parsed.nitro_measurement_problems)
  );
});

test('the committed tree satisfies the measurement half of the prerequisites', () => {
  const parsed = report();
  assert.deepEqual(parsed.nitro_measurement_problems, []);
  assert.equal(parsed.checks.nitro_measurements, true);
});

test('the existing file-group prerequisite checks are untouched', () => {
  const parsed = report();
  assert.equal(typeof parsed.checks?.nitro_files, 'boolean');
  assert.ok(Array.isArray(parsed.missing_nitro_files));
  assert.ok(Array.isArray(parsed.signer_roles));
});
