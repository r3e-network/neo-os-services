import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repoRoot, 'scripts/check-service-capability-registry.mjs');
const registry = path.join(repoRoot, 'docs/service-capability-registry.v1.json');

test('service capability registry accepts the six retired NeoSwap records', () => {
  const output = execFileSync(process.execPath, [checker], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(output, /PASS \(6 retired NeoSwap entries\)/);
});

test('service capability registry fails closed when a retired entry is re-enabled', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'neoos-service-registry-'));
  try {
    const mutated = JSON.parse(fs.readFileSync(registry, 'utf8'));
    mutated.entries[0].runtimeEnabled = true;
    const mutatedPath = path.join(temporaryDirectory, 'registry.json');
    fs.writeFileSync(mutatedPath, JSON.stringify(mutated));
    assert.throws(
      () =>
        execFileSync(process.execPath, [checker], {
          cwd: repoRoot,
          env: { ...process.env, NEOOS_SERVICE_CAPABILITY_REGISTRY: mutatedPath },
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      /runtimeEnabled/
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
