import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const script = path.join(repoRoot, 'scripts/check-control-plane-env.mjs');

// The checker merges process.env over the .env file it finds in cwd, so it is
// driven entirely from the spawn environment when cwd holds no .env.
const COMPLETE_ENV = {
  SUPABASE_URL: 'https://supabase.example.com',
  SUPABASE_SECRET_KEY: 'supabase-service-role-key',
  MORPHEUS_CONTROL_PLANE_API_KEY: 'control-plane-key',
  UPSTASH_REDIS_REST_URL: 'https://upstash.example.com',
  UPSTASH_REDIS_REST_TOKEN: 'upstash-token',
  MORPHEUS_EXECUTION_BASE_URL: 'https://execution.example.com',
  MORPHEUS_EXECUTION_TOKEN: 'execution-token',
};

function runCheck(env, args = []) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'control-plane-env-'));
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '', HOME: cwd, ...env },
  });
  return { ...result, report: JSON.parse(result.stdout) };
}

test('a complete control-plane environment passes both the plain and the strict check', () => {
  const plain = runCheck(COMPLETE_ENV);
  assert.equal(plain.status, 0, plain.stderr || plain.stdout);
  assert.equal(plain.report.ok, true);

  const strict = runCheck(COMPLETE_ENV, ['--strict']);
  assert.equal(strict.status, 0, strict.stderr || strict.stdout);
  assert.equal(strict.report.ok, true);
  assert.equal(strict.report.mode.strict, true);
});

test('--strict fails a missing rate-limit backend that the plain check only recommends', () => {
  const env = { ...COMPLETE_ENV };
  delete env.UPSTASH_REDIS_REST_TOKEN;

  // The plain check keeps its existing behaviour: a recommendation, exit 0.
  const plain = runCheck(env);
  assert.equal(plain.status, 0, plain.stderr || plain.stdout);
  assert.equal(plain.report.ok, true);
  assert.deepEqual(plain.report.optional_recommendations.rate_limit, [
    'UPSTASH_REDIS_REST_TOKEN',
  ]);
  assert.deepEqual(plain.report.missing_strict_required.rate_limit, []);

  // --strict must actually mean something: the worker declares rate limits and
  // now refuses ingest without a backend, so the deploy gate has to catch it.
  const strict = runCheck(env, ['--strict']);
  assert.equal(strict.status, 1);
  assert.equal(strict.report.ok, false);
  assert.deepEqual(strict.report.missing_strict_required.rate_limit, [
    'UPSTASH_REDIS_REST_TOKEN',
  ]);
});

test('--strict also promotes the ingress-auth and execution-plane sections', () => {
  const withoutAuth = { ...COMPLETE_ENV };
  delete withoutAuth.MORPHEUS_CONTROL_PLANE_API_KEY;
  const authStrict = runCheck(withoutAuth, ['--strict']);
  assert.equal(authStrict.status, 1);
  assert.deepEqual(authStrict.report.missing_strict_required.auth, [
    'MORPHEUS_CONTROL_PLANE_API_KEY | MORPHEUS_OPERATOR_API_KEY',
  ]);

  const withoutExecution = { ...COMPLETE_ENV };
  delete withoutExecution.MORPHEUS_EXECUTION_BASE_URL;
  delete withoutExecution.MORPHEUS_EXECUTION_TOKEN;
  const executionStrict = runCheck(withoutExecution, ['--strict']);
  assert.equal(executionStrict.status, 1);
  assert.ok(executionStrict.report.missing_strict_required.execution_plane.length > 0);
});

test('deploy:control-plane validates the control-plane environment before wrangler', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/deploy-control-plane.mjs'), 'utf8');
  const checkIndex = source.indexOf('check-control-plane-env.mjs');
  const deployIndex = source.indexOf("'deploy'");
  assert.ok(checkIndex > 0, 'the deploy command must run the control-plane env check');
  assert.ok(
    source.includes("'--strict'"),
    'the deploy command must run the env check in strict mode'
  );
  assert.ok(
    checkIndex < deployIndex,
    'the env check must run before wrangler deploy, not after it'
  );
});
