import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditRustMigration,
  dockerInstructions,
  documentationCoverage,
} from './check-rust-migration.mjs';

test('docker source comments cannot trigger the measured-runtime gate', () => {
  const instructions = dockerInstructions(`
    # Node is retained only in a separate compatibility image.
    FROM debian:bookworm-slim
    COPY target/release/enclave_host /app/bin/enclave_host
  `);

  assert.doesNotMatch(instructions, /\bnode\b/i);
  assert.match(instructions, /^FROM debian:bookworm-slim/m);
});

test('the repository satisfies its documented Rust ownership boundary', () => {
  assert.deepEqual(documentationCoverage(), {
    documented: 4,
    total: 4,
    percentage: 100,
    missing: [],
  });
  assert.deepEqual(auditRustMigration(), []);
});
