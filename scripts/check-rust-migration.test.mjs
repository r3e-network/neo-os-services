import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

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

test('embedded custody ownership rejects bypasses through the actual repository gate', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'neoos-embedded-ownership-'));
  try {
    // Copy only tracked/nonignored inputs, never dependency/build trees or
    // private environment files. Mutations remain in this disposable tree.
    const names = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' }
    )
      .split('\0')
      .filter(Boolean);
    for (const name of new Set(names)) {
      if (name.split('/').some((part) => part === '.env' || part.startsWith('.env.'))) continue;
      const destination = join(fixture, name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(name, destination);
    }
    assert.deepEqual(auditRustMigration(fixture), []);
    const manifest = 'workers/nitro-enclave-host/Cargo.toml';
    const bootstrap = 'workers/nitro-enclave-host/src/custody_bootstrap.rs';
    const library = 'workers/nitro-enclave-host/src/lib.rs';
    const cases = [
      [
        manifest,
        (s) =>
          s.replace('neo-signer = { path = "../neo-signer" }', 'neo-signer = { version = "0.1" }'),
        'canonical workspace signer',
      ],
      [
        manifest,
        (s) => s + '\nother-signer = { package = "neo-signer", path = "../neo-signer" }\n',
        'renamed signer dependencies',
      ],
      [
        bootstrap,
        (s) => s.replace('EmbeddedCustodyRuntime::boot(', 'other_boot('),
        'measured bootstrap',
      ],
      [
        bootstrap,
        (s) => s.replace('BootGuard::required(', 'other_guard('),
        'require attested boot',
      ],
      [bootstrap, (s) => s + '\nuse neo_signer::service::SignerService;\n', 'must not bypass'],
      [bootstrap, (s) => s + '\nuse neo_signer::crypto;\n', 'must not bypass'],
      [bootstrap, (s) => s + '\nuse neo_signer as private_signer;\n', 'must not bypass'],
      [
        library,
        (s) => s + '\nuse neo_signer::embedded::EmbeddedCustodyRuntime;\n',
        'only the measured bootstrap',
      ],
      [
        library,
        (s) => s + '\nuse p256::ecdsa::SigningKey;\n',
        'private signing-key implementation',
      ],
    ];
    for (const [name, corrupt, expected] of cases) {
      const path = join(fixture, name);
      const original = readFileSync(path, 'utf8');
      const changed = corrupt(original);
      assert.notEqual(changed, original, name);
      try {
        writeFileSync(path, changed);
        assert.ok(
          auditRustMigration(fixture).some((failure) => failure.includes(expected)),
          expected
        );
      } finally {
        writeFileSync(path, original);
      }
    }
    const originalManifest = readFileSync(join(fixture, manifest), 'utf8');
    const originalBootstrap = readFileSync(join(fixture, bootstrap), 'utf8');
    const originalLibrary = readFileSync(join(fixture, library), 'utf8');
    const declaration = 'neo-signer = { path = "../neo-signer" }';
    const missed = [];
    for (const [label, replacement, append] of [
      ['quoted key', '"neo-signer" = { path = "../neo-signer" }', ''],
      ['dependency table', '', '\n[dependencies.neo-signer]\npath = "../neo-signer"\n'],
      [
        'literal package alias',
        "private-signer = { package = 'neo-signer', path = '../neo-signer' }",
        '',
      ],
    ]) {
      try {
        const changed = originalManifest.replace(declaration, replacement) + append;
        assert.notEqual(changed, originalManifest, label);
        writeFileSync(join(fixture, manifest), changed);
        const alias = label === 'literal package alias' ? 'private_signer' : 'neo_signer';
        writeFileSync(
          join(fixture, bootstrap),
          originalBootstrap.replaceAll('neo_signer', alias) +
            `\npub type ForbiddenService = ${alias}::service::SignerService;\n`
        );
        writeFileSync(
          join(fixture, library),
          originalLibrary +
            (alias === 'private_signer'
              ? `\npub type ForbiddenService = ${alias}::service::SignerService;\n`
              : '')
        );
        if (
          !auditRustMigration(fixture).some((failure) =>
            /must not bypass|renamed signer dependencies/.test(failure)
          )
        )
          missed.push(label);
      } finally {
        writeFileSync(join(fixture, manifest), originalManifest);
        writeFileSync(join(fixture, bootstrap), originalBootstrap);
        writeFileSync(join(fixture, library), originalLibrary);
      }
    }
    assert.deepEqual(missed, [], 'valid TOML spellings must not disable custody ownership checks');
    for (const [replacement, append] of [
      ['"neo-signer" = { path = "../neo-signer" }', ''],
      ["'neo-signer' = { path = '../neo-signer' }", ''],
      ['', '\n[dependencies.neo-signer]\npath = "../neo-signer"\n'],
    ]) {
      try {
        writeFileSync(
          join(fixture, manifest),
          originalManifest.replace(declaration, replacement) + append
        );
        assert.deepEqual(auditRustMigration(fixture), [], 'equivalent canonical dependency syntax');
        writeFileSync(
          join(fixture, bootstrap),
          originalBootstrap.replace('BootGuard::required(', 'other_guard(')
        );
        assert.ok(
          auditRustMigration(fixture).some((failure) => failure.includes('require attested boot'))
        );
      } finally {
        writeFileSync(join(fixture, manifest), originalManifest);
        writeFileSync(join(fixture, bootstrap), originalBootstrap);
      }
    }
    const rootManifest = readFileSync(join(fixture, 'Cargo.toml'), 'utf8');
    for (const [label, replacement, append, rootAppend, expected] of [
      [
        'conditional alias',
        '',
        "\n[target.'cfg(unix)'.dependencies]\nprivate-signer = { package = 'neo-signer', path = '../neo-signer' }\n",
        '',
        'renamed signer dependencies',
      ],
      [
        'conditional signer',
        '',
        '\n[target.\'cfg(unix)\'.dependencies.neo-signer]\npath = "../neo-signer"\n',
        '',
        'canonical workspace signer',
      ],
      [
        'build alias',
        '',
        "\n[build-dependencies]\nprivate-signer = { package = 'neo-signer', path = '../neo-signer' }\n",
        '',
        'renamed signer dependencies',
      ],
      [
        'workspace alias',
        'private-signer = { workspace = true }',
        '',
        "\n[workspace.dependencies]\nprivate-signer = { package = 'neo-signer', path = 'workers/neo-signer' }\n",
        'renamed signer dependencies',
      ],
      [
        'workspace signer',
        'neo-signer = { workspace = true }',
        '',
        '\n[workspace.dependencies]\nneo-signer = { path = "workers/neo-signer" }\n',
        'canonical workspace signer',
      ],
      [
        'unresolved workspace',
        'private-signer = { workspace = true }',
        '',
        '',
        'cannot validate Cargo',
      ],
      ['missing signer', '', '', '', 'only the measured bootstrap'],
      [
        'optional signer',
        'neo-signer = { path = "../neo-signer", optional = true }',
        '',
        '',
        'canonical workspace signer',
      ],
      ['malformed manifest', 'neo-signer = { path = ', '', '', 'cannot validate Cargo'],
      ['duplicate key', declaration + '\n' + declaration, '', '', 'cannot validate Cargo'],
      [
        'quoted crypto',
        declaration,
        '\n[build-dependencies]\n"scrypt" = "0.11"\n',
        '',
        'must not duplicate',
      ],
      [
        'aliased crypto',
        declaration,
        "\n[target.'cfg(unix)'.dependencies]\nprivate-crypto = { package = 'ed25519-dalek', version = '2' }\n",
        '',
        'must not duplicate',
      ],
    ]) {
      try {
        writeFileSync(
          join(fixture, manifest),
          originalManifest.replace(declaration, replacement) + append
        );
        writeFileSync(join(fixture, 'Cargo.toml'), rootManifest + rootAppend);
        assert.ok(
          auditRustMigration(fixture).some((failure) => failure.includes(expected)),
          label
        );
      } finally {
        writeFileSync(join(fixture, manifest), originalManifest);
        writeFileSync(join(fixture, 'Cargo.toml'), rootManifest);
      }
    }
    assert.deepEqual(auditRustMigration(fixture), []);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
