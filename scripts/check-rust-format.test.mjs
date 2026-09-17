import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CONFIG_SCHEMA_GENERATED_START,
  checkConfigSchemaIdentity,
  checkFormatWorkflows,
  extractGeneratedConfigSchemaTables,
} from './lib-rust-format.mjs';

test('generated config-schema tables start at the committed marker', () => {
  const excerpt = extractGeneratedConfigSchemaTables(
    `// header\n${CONFIG_SCHEMA_GENERATED_START}\npub static DIRECT_CONTROL_ENV_KEYS: &[&str] = &["X"];\n];\n\n/// Every env alias the schema knows about\n`
  );
  assert.equal(
    excerpt,
    `${CONFIG_SCHEMA_GENERATED_START}\npub static DIRECT_CONTROL_ENV_KEYS: &[&str] = &["X"];\n];\n\n`
  );
});

test('committed config-schema tables match the JS generator', () => {
  assert.deepEqual(checkConfigSchemaIdentity(), []);
});

test('repository workflows use the controlled format gate', () => {
  assert.deepEqual(checkFormatWorkflows(), []);
});

test('a workflow that only runs cargo fmt --all --check fails the audit', () => {
  const root = mkdtempSync(join(tmpdir(), 'rust-format-gate-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), '- run: cargo fmt --all --check\n');
  writeFileSync(
    join(root, '.github', 'workflows', 'publish-images.yml'),
    '- run: cargo fmt --all --check\n'
  );
  const problems = checkFormatWorkflows(root);
  assert.ok(problems.some((problem) => problem.includes('controlled Rust format gate')));
  assert.ok(problems.some((problem) => problem.includes('raw cargo fmt --all --check')));
});
