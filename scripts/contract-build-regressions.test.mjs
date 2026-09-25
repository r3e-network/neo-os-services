import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('contract build script leaves moved NeoDID source in the canonical repository', () => {
  const buildScript = fs.readFileSync(path.join(repoRoot, 'contracts', 'build.sh'), 'utf8');
  assert.doesNotMatch(buildScript, /NeoDIDRegistry/);
  assert.ok(fs.existsSync(path.join(repoRoot, 'vendor/neo-os-did.pin.json')));
});

test('contracts build script generates source artifacts without hidden compiler errors', (t) => {
  const pinnedNccsPath = path.join(process.env.HOME || '', '.dotnet', 'tools', 'nccs');
  if (!fs.existsSync(pinnedNccsPath)) {
    t.skip(`nccs not available at ${pinnedNccsPath}`);
    return;
  }
  const dotnetProbe = spawnSync('dotnet', ['--info'], { encoding: 'utf8' });
  if (dotnetProbe.status !== 0) {
    t.skip('dotnet runtime is not available for nccs');
    return;
  }
  const result = spawnSync('bash', ['contracts/build.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, combinedOutput);
  assert.doesNotMatch(combinedOutput, /Artifacts compilation error/i);
});
