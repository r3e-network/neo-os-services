import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');

function collectServiceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectServiceFiles(absolute);
    return entry.name.endsWith('.service') ? [absolute] : [];
  });
}

test('tracked systemd units use the canonical NeoOS code root', () => {
  const serviceFiles = collectServiceFiles(path.join(repoRoot, 'deploy'));
  assert.ok(serviceFiles.length > 0);

  for (const file of serviceFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\/opt\/(?:neo-morpheus-oracle|morpheus\/neo-morpheus-oracle)/);

    for (const line of source.split('\n')) {
      if (!/^(?:ExecStart|WorkingDirectory)=/.test(line)) continue;
      if (!line.includes('/opt/')) continue;
      if (line.includes('/opt/morpheus/nitro/')) continue;
      assert.match(
        line,
        /\/opt\/neoos\/services/,
        `${path.relative(repoRoot, file)} contains a non-canonical code path: ${line}`
      );
    }
  }
});

test('deployment documentation separates code from compatibility state paths', () => {
  const deployment = fs.readFileSync(path.join(repoRoot, 'docs', 'DEPLOYMENT.md'), 'utf8');
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

  assert.match(deployment, /code checkout: `\/opt\/neoos\/services`/);
  assert.match(deployment, /secrets, generated environment[\s\S]*`\/opt\/morpheus\/nitro`/);
  assert.match(deployment, /install:code-path-compat/);
  assert.match(readme, /\/opt\/neoos\/services/);
  assert.match(readme, /\/opt\/morpheus\/nitro/);
});
