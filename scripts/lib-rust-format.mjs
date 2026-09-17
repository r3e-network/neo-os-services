import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRootFromHere = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_SCHEMA_PATH = 'crates/neo-os-core/src/config_schema.rs';
export const CONFIG_SCHEMA_GENERATED_START =
  '/// Direct-control env keys consumed outside env() alias chains';
export const CONFIG_SCHEMA_GENERATED_END = '/// Every env alias the schema knows about';
export const GEN_CONFIG_SCHEMA_SCRIPT = 'scripts/gen-config-schema-rust.mjs';

export const FORMAT_GATE_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/publish-images.yml',
];

const BARE_CARGO_FMT = /cargo fmt --all --check/;
const CONTROLLED_FORMAT_GATE = /scripts\/check-rust-format\.mjs/;

export function extractGeneratedConfigSchemaTables(source) {
  const start = source.indexOf(CONFIG_SCHEMA_GENERATED_START);
  if (start < 0) {
    throw new Error(
      `${CONFIG_SCHEMA_PATH} is missing generated marker ${CONFIG_SCHEMA_GENERATED_START}`
    );
  }
  const end = source.indexOf(CONFIG_SCHEMA_GENERATED_END, start);
  if (end < 0) {
    throw new Error(
      `${CONFIG_SCHEMA_PATH} is missing generated end marker ${CONFIG_SCHEMA_GENERATED_END}`
    );
  }
  return source.slice(start, end);
}

export function checkConfigSchemaIdentity(root = repoRootFromHere) {
  const generated = spawnSync(process.execPath, [join(root, GEN_CONFIG_SCHEMA_SCRIPT)], {
    cwd: root,
    encoding: 'utf8',
  });
  if (generated.status !== 0) {
    return [
      `${GEN_CONFIG_SCHEMA_SCRIPT} failed: ${generated.stderr || generated.stdout || generated.status}`,
    ];
  }
  const committed = extractGeneratedConfigSchemaTables(
    readFileSync(join(root, CONFIG_SCHEMA_PATH), 'utf8')
  );
  if (committed.trimEnd() !== generated.stdout.trimEnd()) {
    return [
      `${CONFIG_SCHEMA_PATH} generated tables are not byte-identical to ${GEN_CONFIG_SCHEMA_SCRIPT}`,
    ];
  }
  return [];
}

export function checkFormatWorkflows(root = repoRootFromHere) {
  const problems = [];
  for (const relativePath of FORMAT_GATE_WORKFLOWS) {
    const source = readFileSync(join(root, relativePath), 'utf8');
    if (!CONTROLLED_FORMAT_GATE.test(source)) {
      problems.push(`${relativePath} does not run the controlled Rust format gate`);
    }
    if (BARE_CARGO_FMT.test(source)) {
      problems.push(
        `${relativePath} still uses raw cargo fmt --all --check instead of the controlled format gate`
      );
    }
  }
  return problems;
}

export function runCargoFmtCheck(root = repoRootFromHere) {
  const result = spawnSync('cargo', ['fmt', '--all', '--', '--check', '--color', 'never'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = (result.stdout || result.stderr || '').trim();
    return [
      `cargo fmt --all -- --check failed on handwritten workspace sources${
        detail ? `:\n${detail}` : ''
      }`,
    ];
  }
  return [];
}

export function runProtoIdentity(root = repoRootFromHere) {
  const result = spawnSync(
    'cargo',
    [
      'test',
      '-p',
      'neo-signer',
      '--test',
      'proto_identity',
      '--locked',
      '--',
      '--exact',
      'proto_generation_is_byte_stable',
    ],
    { cwd: root, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    const detail = (result.stdout || result.stderr || '').trim();
    return [`SignClient proto regeneration is not byte-stable${detail ? `:\n${detail}` : ''}`];
  }
  return [];
}

export function auditRustFormat(root = repoRootFromHere) {
  return [
    ...checkFormatWorkflows(root),
    ...checkConfigSchemaIdentity(root),
    ...runCargoFmtCheck(root),
    ...runProtoIdentity(root),
  ];
}
