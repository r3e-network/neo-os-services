import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'services-local-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const servicesRoot = path.join(root, 'neo-os-services');
  const scriptsDir = path.join(servicesRoot, 'scripts');
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.join(servicesRoot, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(scriptsDir, 'run_local_validation_gates.sh');
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'run_local_validation_gates.sh'), script);

  const logFile = path.join(root, 'npm-env.log');
  fs.writeFileSync(logFile, '');
  const npm = path.join(binDir, 'npm');
  fs.writeFileSync(
    npm,
    '#!/bin/sh\nprintf \'%s|%s|%s|%s\\n\' "$MORPHEUS_NETWORK" "$NEXT_PUBLIC_MORPHEUS_NETWORK" "$1" "$2" >> "$LOG_FILE"\n'
  );
  fs.chmodSync(npm, 0o755);
  return { root, script, logFile, binDir };
}

function runWithNetwork(fixture, network) {
  const env = {
    ...process.env,
    PATH: `${fixture.binDir}:/usr/bin:/bin`,
    LOG_FILE: fixture.logFile,
  };
  delete env.MORPHEUS_NETWORK;
  delete env.NEXT_PUBLIC_MORPHEUS_NETWORK;
  if (network !== undefined) env.MORPHEUS_NETWORK = network;
  const result = spawnSync('/bin/bash', [fixture.script, '--web-only'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return fs.readFileSync(fixture.logFile, 'utf8');
}

test('local web validation defaults both network variables to testnet', (t) => {
  const fixture = createFixture(t);
  const lines = runWithNetwork(fixture).trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) assert.equal(line.startsWith('testnet|testnet|'), true);
});

test('local web validation preserves an explicit network', (t) => {
  const fixture = createFixture(t);
  const lines = runWithNetwork(fixture, 'mainnet').trim().split('\n');
  assert.equal(lines.length, 3);
  for (const line of lines) assert.equal(line.startsWith('mainnet|mainnet|'), true);
});

test('network defaults are scoped to the web gate only', (t) => {
  const fixture = createFixture(t);
  const result = spawnSync('/bin/bash', [fixture.script], {
    env: {
      ...process.env,
      PATH: `${fixture.binDir}:/usr/bin:/bin`,
      LOG_FILE: fixture.logFile,
      MORPHEUS_NETWORK: '',
      NEXT_PUBLIC_MORPHEUS_NETWORK: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = fs.readFileSync(fixture.logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 8);
  for (const line of lines.slice(0, 5)) assert.equal(line.startsWith('||'), true);
  for (const line of lines.slice(5)) assert.equal(line.startsWith('testnet|testnet|'), true);
});
