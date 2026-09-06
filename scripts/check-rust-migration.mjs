import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const REQUIRED_DOCS = [
  'docs/RUST_SERVICE_MIGRATION.md',
  'docs/CRYPTO_OWNERSHIP.md',
  'docs/SIGNER_SERVICE.md',
  'docs/SIGNER_SERVICE_V2.md',
  'docs/rust-migration/SERVICE_CONTRACT_MATRIX.md',
];

const DOCUMENTATION_PAIRS = [
  ['workers/neo-signer/src/lib.rs', 'docs/SIGNER_SERVICE_V2.md'],
  ['workers/nitro-enclave-host/src/lib.rs', 'docs/RUST_SERVICE_MIGRATION.md'],
  ['workers/neo-os-relayer/src/lib.rs', 'docs/RUST_SERVICE_MIGRATION.md'],
  ['crates/neo-os-service-runtime/src/lib.rs', 'docs/RUST_SERVICE_MIGRATION.md'],
  ['crates/neo-os-compute/src/lib.rs', 'docs/RUST_SERVICE_MIGRATION.md'],
  ['crates/neo-os-compute/src/oracle/crypto.rs', 'docs/CRYPTO_OWNERSHIP.md'],
];
const REQUIRED_DOCUMENTATION_SECTIONS = [
  'Overview',
  'API Reference',
  'Usage Examples',
  'Design Decisions',
  'Test Coverage',
];

function read(root, relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function rustSources(root, relativeDirectory) {
  const files = [];
  const visit = (relativeDirectoryPath) => {
    for (const entry of readdirSync(resolve(root, relativeDirectoryPath), {
      withFileTypes: true,
    })) {
      const relativePath = join(relativeDirectoryPath, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith('.rs')) files.push(relativePath);
    }
  };
  visit(relativeDirectory);
  return files;
}

export function dockerInstructions(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .join('\n');
}

export function cargoWorkspaceMembers(root = process.cwd()) {
  const manifest = read(root, 'Cargo.toml');
  const members = manifest.match(/\bmembers\s*=\s*\[([\s\S]*?)\]/m)?.[1] || '';
  return [...members.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

export function documentationCoverage(root = process.cwd()) {
  const missing = [];
  let documented = 0;

  for (const [implementation, documentation] of DOCUMENTATION_PAIRS) {
    if (!existsSync(resolve(root, implementation))) {
      missing.push(`${implementation}: paired implementation is missing`);
      continue;
    }
    if (!existsSync(resolve(root, documentation))) {
      missing.push(`${implementation}: paired document ${documentation} is missing`);
      continue;
    }
    const source = read(root, documentation);
    const missingSections = REQUIRED_DOCUMENTATION_SECTIONS.filter(
      (section) => !new RegExp(`^##\\s+${section}(?:\\s|$)`, 'm').test(source)
    );
    if (missingSections.length > 0) {
      missing.push(
        `${implementation}: ${documentation} lacks ${missingSections.join(', ')} section(s)`
      );
      continue;
    }
    documented += 1;
  }

  const total = DOCUMENTATION_PAIRS.length;
  return {
    documented,
    total,
    percentage: total === 0 ? 100 : Math.floor((documented * 100) / total),
    missing,
  };
}

export function auditRustMigration(root = process.cwd()) {
  const failures = [];
  const requireFile = (relativePath) => {
    if (!existsSync(resolve(root, relativePath))) {
      failures.push(`${relativePath}: required file is missing`);
      return false;
    }
    return true;
  };
  const reject = (relativePath, source, pattern, reason) => {
    if (pattern.test(source)) failures.push(`${relativePath}: ${reason}`);
  };
  const requireMatch = (relativePath, source, pattern, reason) => {
    if (!pattern.test(source)) failures.push(`${relativePath}: ${reason}`);
  };

  for (const path of REQUIRED_DOCS) requireFile(path);
  const coverage = documentationCoverage(root);
  failures.push(...coverage.missing.map((failure) => `documentation coverage: ${failure}`));
  if (coverage.percentage < 100) {
    failures.push(
      `documentation coverage is ${coverage.documented}/${coverage.total} ` +
        `(${coverage.percentage}%); required threshold is 100%`
    );
  }

  const workspaceMembers = cargoWorkspaceMembers(root);
  for (const dockerfile of ['deploy/nitro/Dockerfile.enclave', 'deploy/nitro/Dockerfile.signer']) {
    if (!requireFile(dockerfile)) continue;
    const source = read(root, dockerfile);
    const instructions = dockerInstructions(source);
    reject(
      dockerfile,
      instructions,
      /\b(?:node|nodejs|npm|npx|yarn|pnpm)\b|workers\/nitro-worker|enclave-server\.mjs|ENCLAVE_BRIDGE_CHILD/i,
      'measured image instructions include a JavaScript runtime, worker, or child fallback'
    );
    for (const member of workspaceMembers) {
      requireMatch(
        dockerfile,
        source,
        new RegExp(`COPY\\s+${member.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}/Cargo\\.toml\\b`),
        `measured build does not copy workspace member manifest ${member}/Cargo.toml`
      );
    }
  }
  if (requireFile('.dockerignore')) {
    const dockerignore = read(root, '.dockerignore');
    for (const binaryDirectory of [
      'workers/neo-signer/src/bin',
      'workers/nitro-enclave-host/src/bin',
      'crates/nitro-attest/src/bin',
    ]) {
      requireMatch(
        '.dockerignore',
        dockerignore,
        new RegExp(`^!${binaryDirectory.replaceAll('/', '\\/')}/\\*\\*$`, 'm'),
        `Docker context excludes required Rust binary directory ${binaryDirectory}`
      );
    }
  }

  const hostLib = 'workers/nitro-enclave-host/src/lib.rs';
  const hostBin = 'workers/nitro-enclave-host/src/bin/enclave_host.rs';
  const routes = 'workers/nitro-enclave-host/src/routes.rs';
  const hostManifest = 'workers/nitro-enclave-host/Cargo.toml';
  const coreLib = 'crates/neo-os-core/src/lib.rs';
  const coreManifest = 'crates/neo-os-core/Cargo.toml';
  const computeHost = 'workers/nitro-enclave-host/src/compute_execute.rs';

  for (const path of [hostLib, hostBin, routes, hostManifest, coreLib, coreManifest, computeHost]) {
    if (!requireFile(path)) return failures;
  }

  requireFile('workers/nitro-enclave-host/src/bridge.rs');
  if (existsSync(resolve(root, 'workers/nitro-enclave-host/src/child.rs'))) {
    failures.push(
      'workers/nitro-enclave-host/src/child.rs: production child-process supervisor must not exist'
    );
  }

  const productionHost = [
    read(root, hostLib),
    read(root, hostBin),
    read(root, routes),
    read(root, hostManifest),
  ].join('\n');
  reject(
    'workers/nitro-enclave-host',
    productionHost,
    /\b(?:LoopbackBridge|BridgeChild|EXECUTION_PLANE_PASSTHROUGH)\b|Target::Passthrough|ENCLAVE_BRIDGE_CHILD|ENCLAVE_WORKER_PORT/,
    'production Rust host contains a child-process or route-passthrough fallback'
  );
  reject(
    routes,
    read(root, routes),
    /\bPassthrough\b/,
    'route classifier contains a passthrough target'
  );
  reject(
    hostManifest,
    read(root, hostManifest),
    /^\s*(?:neo-signer|scrypt|ed25519-dalek)\s*=/m,
    'enclave host must call custody instead of linking a private-key custody implementation'
  );
  const hostProductionSources = rustSources(root, 'workers/nitro-enclave-host/src')
    .map((relativePath) => read(root, relativePath))
    .join('\n');
  reject(
    'workers/nitro-enclave-host/src',
    hostProductionSources,
    /\b(?:SigningKey|SecretKey|SecretKeyBytes)\b/,
    'enclave host contains a private signing-key implementation instead of custody/public verification'
  );

  const coreSource = `${read(root, coreLib)}\n${read(root, coreManifest)}`;
  reject(
    'crates/neo-os-core',
    coreSource,
    /\b(?:aes-gcm|curve25519-dalek|hkdf)\b|mod confidential/,
    'consensus core contains oracle confidential-crypto ownership'
  );
  if (existsSync(resolve(root, 'crates/neo-os-core/src/confidential.rs'))) {
    failures.push(
      'crates/neo-os-core/src/confidential.rs: duplicate oracle envelope implementation exists'
    );
  }
  requireMatch(
    computeHost,
    read(root, computeHost),
    /neo_os_compute::oracle::crypto/,
    'enclave compute must import the canonical oracle crypto owner'
  );
  for (const directory of [
    'crates/neo-os-compute/src',
    'crates/neo-os-core/src',
    'workers/neo-signer/src',
    'workers/nitro-enclave-host/src',
  ]) {
    for (const path of rustSources(root, directory)) {
      reject(
        path,
        read(root, path),
        /\bRsaPrivateKey\b/,
        'RSA private operations are confined to nitro-attest ephemeral KMS recipient keys'
      );
    }
  }

  const workerPackagePath = 'workers/nitro-worker/package.json';
  const vectorExporter = 'scripts/export-rust-vectors.mjs';
  if (requireFile(workerPackagePath)) {
    const workerPackage = JSON.parse(read(root, workerPackagePath));
    if (!workerPackage.scripts?.test) {
      failures.push(`${workerPackagePath}: compatibility worker has no parity test command`);
    }
  }
  requireFile(vectorExporter);

  return failures;
}

function main() {
  const failures = auditRustMigration();
  if (failures.length > 0) {
    console.error('Rust migration boundary check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  const coverage = documentationCoverage();
  console.log(
    `Documentation coverage: ${coverage.documented}/${coverage.total} ` +
      `(${coverage.percentage}%; required 100%).`
  );
  console.log('Rust migration boundary check passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
