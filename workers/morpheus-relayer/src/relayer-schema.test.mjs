import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MIGRATION = readFileSync(
  resolve(REPO_ROOT, 'db/services/migrations/0016_allow_neox_relayer_jobs.sql'),
  'utf8'
);
const NEOX_ADAPTER = readFileSync(
  resolve(REPO_ROOT, 'workers/morpheus-relayer/src/neox.js'),
  'utf8'
);

test('durable relayer schema accepts the exact chain values emitted by N3 and Neo X adapters', () => {
  assert.match(NEOX_ADAPTER, /chain:\s*['"]neox['"]/);
  assert.match(MIGRATION, /CHECK\s*\(chain\s+IN\s*\(\s*'neo_n3'\s*,\s*'neox'\s*\)\s*\)/i);
  assert.doesNotMatch(MIGRATION, /CHECK\s*\(chain\s+IN\s*\([^)]*testnet/i);
});

test('schema patch replaces and validates the named fail-closed constraint', () => {
  assert.match(MIGRATION, /DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+morpheus_relayer_jobs_chain_check/i);
  assert.match(
    MIGRATION,
    /ADD\s+CONSTRAINT\s+morpheus_relayer_jobs_chain_check[\s\S]*NOT\s+VALID/i
  );
  assert.match(MIGRATION, /VALIDATE\s+CONSTRAINT\s+morpheus_relayer_jobs_chain_check/i);
});
