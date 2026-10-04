import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

// Where contracts/build.sh finds nccs: $NCCS, then PATH (scripts/dotnet_env.sh adds
// $DOTNET_ROOT/tools, CI adds ~/.dotnet/tools), then the default global-tool directory.
function resolveNccs() {
  if (process.env.NCCS) return fs.existsSync(process.env.NCCS) ? process.env.NCCS : null;
  const onPath = spawnSync('bash', ['-c', 'command -v nccs'], { encoding: 'utf8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim();
  const fallback = path.join(process.env.HOME || '', '.dotnet', 'tools', 'nccs');
  return fs.existsSync(fallback) ? fallback : null;
}

test('contract build script leaves moved NeoDID source in the canonical repository', () => {
  const buildScript = fs.readFileSync(path.join(repoRoot, 'contracts', 'build.sh'), 'utf8');
  assert.doesNotMatch(buildScript, /NeoDIDRegistry/);
  assert.ok(fs.existsSync(path.join(repoRoot, 'vendor/neo-os-did.pin.json')));
});

test('contracts build script generates source artifacts without hidden compiler errors', (t) => {
  if (!resolveNccs()) {
    t.skip('nccs not available through $NCCS, PATH or ~/.dotnet/tools');
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

// A stand-in compiler that only reports a version, so the lookup can be tested without the
// real nccs (build.sh stops at the version check before it compiles anything).
function fakeNccs(dir, version) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'nccs');
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return file;
}

function runBuildWith({ home, pathDirs = [], env = {} }) {
  const baseEnv = {
    PATH: [...pathDirs, '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
  };
  return spawnSync('bash', ['contracts/build.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...baseEnv, ...env },
  });
}

test('contracts build script finds nccs from NCCS, from PATH, or in the default tool directory', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'build-nccs-'));
  try {
    const emptyHome = path.join(scratch, 'home');
    fs.mkdirSync(emptyHome);

    // an explicit NCCS, with no ~/.dotnet at all
    const explicit = fakeNccs(path.join(scratch, 'explicit'), '0.0.1-explicit');
    let result = runBuildWith({ home: emptyHome, env: { NCCS: explicit } });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`Using nccs 0.0.1-explicit (${explicit})`), result.stdout);
    assert.match(result.stderr, /nccs 3\.9\.1 is required; found 0\.0\.1-explicit/);

    // nccs on PATH, with no ~/.dotnet at all
    const onPathDir = path.join(scratch, 'onpath');
    fakeNccs(onPathDir, '0.0.2-path');
    result = runBuildWith({ home: emptyHome, pathDirs: [onPathDir] });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /nccs 3\.9\.1 is required; found 0\.0\.2-path/);

    // NCCS wins over PATH
    result = runBuildWith({ home: emptyHome, pathDirs: [onPathDir], env: { NCCS: explicit } });
    assert.match(result.stderr, /found 0\.0\.1-explicit/);

    // the default global-tool directory still works when DOTNET_ROOT points elsewhere
    const toolHome = path.join(scratch, 'toolhome');
    fakeNccs(path.join(toolHome, '.dotnet', 'tools'), '0.0.3-default');
    result = runBuildWith({
      home: toolHome,
      env: { DOTNET_ROOT: path.join(scratch, 'elsewhere') },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /nccs 3\.9\.1 is required; found 0\.0\.3-default/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('contracts build script refuses a bad NCCS and a missing compiler with the way out', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'build-nccs-'));
  try {
    const emptyHome = path.join(scratch, 'home');
    fs.mkdirSync(emptyHome);

    let result = runBuildWith({
      home: emptyHome,
      env: { NCCS: path.join(scratch, 'does-not-exist') },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NCCS=.*does-not-exist is not an executable file/);

    result = runBuildWith({ home: emptyHome });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /nccs not found; install Neo\.Compiler\.CSharp 3\.9\.1 or set NCCS=/
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
