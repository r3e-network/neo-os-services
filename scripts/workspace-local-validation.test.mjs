import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-local-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const servicesRoot = path.join(root, 'neo-os-services');
  const aaRoot = path.join(root, 'neo-os-aa');
  const webRoot = path.join(root, 'neo-os-web');
  const scriptsDir = path.join(servicesRoot, 'scripts');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.join(aaRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(webRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const script = path.join(scriptsDir, 'run_workspace_local_validation.sh');
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'run_workspace_local_validation.sh'), script);
  const aaEntrypoint = path.join(aaRoot, 'scripts', 'verify_repo.sh');
  fs.writeFileSync(aaEntrypoint, '#!/usr/bin/env bash\nexit 0\n');

  const logFile = path.join(root, 'calls.log');
  fs.writeFileSync(logFile, '');
  for (const command of ['bash', 'npm']) {
    const stub = path.join(binDir, command);
    fs.writeFileSync(
      stub,
      `#!/bin/sh\nprintf '${command}' >> "$LOG_FILE"\nprintf ' %s' "$@" >> "$LOG_FILE"\nprintf '\\n' >> "$LOG_FILE"\n`
    );
    fs.chmodSync(stub, 0o755);
  }

  return { root, script, aaEntrypoint, logFile, binDir };
}

function runWorkspace(fixture, args) {
  const result = spawnSync('/bin/bash', [fixture.script, ...args], {
    env: { ...process.env, PATH: `${fixture.binDir}:/usr/bin:/bin`, LOG_FILE: fixture.logFile },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return fs.readFileSync(fixture.logFile, 'utf8');
}

test('AA-only workspace validation uses the maintained AA entrypoint', (t) => {
  const fixture = createWorkspace(t);
  const calls = runWorkspace(fixture, ['--aa-only']);
  assert.equal(calls, 'bash scripts/verify_repo.sh --skip-contract-build --skip-e2e\n');
  assert.equal(fs.existsSync(fixture.aaEntrypoint), true);
});

test('full workspace validation preserves services, AA, and web order', (t) => {
  const fixture = createWorkspace(t);
  const calls = runWorkspace(fixture, []);
  assert.equal(
    calls,
    'npm run test:testnet:local-gates\n' +
      'bash scripts/verify_repo.sh --skip-contract-build --skip-e2e\n' +
      'npm run test:testnet:local-gates\n'
  );
});
