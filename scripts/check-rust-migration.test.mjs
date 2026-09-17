import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditRustMigration,
  cargoMetadataFails,
  cargoWorkspaceExclude,
  cargoWorkspaceMembers,
  dockerInstructions,
  documentationCoverage,
  retiredManifestIsArchiveStub,
  retiredMarkdownHasActionableCommands,
  RETIRED_ACTIONABLE_COMMAND,
} from './check-rust-migration.mjs';

test('every workspace member is visible to measured Docker build resolution', () => {
  const members = cargoWorkspaceMembers();
  assert.ok(members.includes('workers/neo-signer'));
  assert.ok(members.includes('workers/neo-os-relayer'));
  assert.ok(members.includes('workers/nitro-enclave-host'));
  assert.ok(members.includes('crates/neo-os-service-runtime'));
});

test('retired heartbeat crate stays outside the active workspace', () => {
  const members = cargoWorkspaceMembers();
  const excluded = cargoWorkspaceExclude();
  assert.ok(!members.includes('workers/morpheus-relater-rs'));
  assert.ok(excluded.includes('workers/morpheus-relater-rs'));
});

test('retired archive manifests are not Cargo packages', () => {
  assert.ok(
    retiredManifestIsArchiveStub('# Retired archive.\n# Historical manifest: Cargo.toml.retired\n')
  );
  assert.ok(!retiredManifestIsArchiveStub('[package]\nname = "morpheus-relayer-rs"\n'));
  assert.ok(cargoMetadataFails(process.cwd(), 'workers/morpheus-relater-rs/Cargo.toml'));
  assert.ok(
    cargoMetadataFails(
      process.cwd(),
      'workers/morpheus-relater-rs/crates/tee-attestation/Cargo.toml'
    )
  );
});

test('retired docs reject actionable start commands', () => {
  assert.match('cargo build --release', RETIRED_ACTIONABLE_COMMAND);
  assert.match('docker run -d morpheus-relater', RETIRED_ACTIONABLE_COMMAND);
  assert.doesNotMatch(
    'cargo run --locked -p neo-os-relayer -- config:validate',
    RETIRED_ACTIONABLE_COMMAND
  );
  assert.ok(retiredMarkdownHasActionableCommands('```bash\ncargo build --release\n```\n'));
  assert.ok(
    !retiredMarkdownHasActionableCommands(
      'Prose may mention cargo build.\n\n```bash\ncargo test -p neo-os-relayer --locked\n```\n'
    )
  );
});

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
    documented: 6,
    total: 6,
    percentage: 100,
    missing: [],
  });
  assert.deepEqual(auditRustMigration(), []);
});
