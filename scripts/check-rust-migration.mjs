import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

function dependencyEntries(manifest, workspace) {
  const entries = [];
  const collect = (scope, target) => {
    for (const kind of [
      'dependencies',
      'dev-dependencies',
      'build-dependencies',
      'dev_dependencies',
      'build_dependencies',
    ]) {
      for (const [name, declaration] of Object.entries(scope[kind] || {})) {
        let definition = declaration;
        const inherited = declaration?.workspace === true;
        if (inherited) {
          definition = workspace.dependencies?.[name];
          if (definition === undefined) throw new Error('unresolved workspace dependency');
        }
        entries.push({
          name,
          package: definition?.package || name,
          definition,
          inherited,
          kind,
          target,
        });
      }
    }
  };
  collect(manifest, null);
  for (const [target, scope] of Object.entries(manifest.target || {})) collect(scope, target);
  return entries;
}

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

export function cargoWorkspaceExclude(root = process.cwd()) {
  const manifest = read(root, 'Cargo.toml');
  const exclude = manifest.match(/\bexclude\s*=\s*\[([\s\S]*?)\]/m)?.[1] || '';
  return [...exclude.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

const RETIRED_WORKSPACE_PATHS = ['workers/morpheus-relater-rs'];
const RETIRED_DIRECT_MANIFESTS = [
  'workers/morpheus-relater-rs/Cargo.toml',
  'workers/morpheus-relater-rs/crates/tee-attestation/Cargo.toml',
];
const RETIRED_ACTIONABLE_MARKDOWN = [
  'workers/morpheus-relater-rs/DEPLOYMENT_GUIDE.md',
  'workers/morpheus-relater-rs/README.md',
  'workers/morpheus-relater-rs/RETIRED.md',
  'workers/morpheus-relater-rs/PROJECT_SUMMARY.md',
  'workers/morpheus-relater-rs/PERFORMANCE_COMPARISON.md',
];

export const RETIRED_ACTIONABLE_COMMAND =
  /(?:cargo\s+(?:build|run)(?![^\n]*-p\s+neo-os-relayer)|systemctl\s+(?:enable|start|stop)\b|docker\s+(?:build|run)\b|helm\s+install\b)/;

export function retiredMarkdownHasActionableCommands(source) {
  const blocks = [...source.matchAll(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g)];
  return blocks.some((match) => RETIRED_ACTIONABLE_COMMAND.test(match[1]));
}

export function retiredManifestIsArchiveStub(source) {
  return !/^\s*\[package\]/m.test(source) && /retired archive/i.test(source);
}

export function cargoMetadataFails(root, relativeManifest) {
  const result = spawnSync(
    'cargo',
    ['metadata', '--format-version', '1', '--manifest-path', relativeManifest],
    { cwd: root, encoding: 'utf8' }
  );
  return result.status !== 0;
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

// The host may validate public measured enrollment configuration, but must not
// receive custody state or secret material. Admit only the existing two-name
// import and the fixed mode constant, never the enrollment module generally.
// Like the surrounding ownership checks, this is source drift detection, not
// a Rust parser; behavioral enforcement and exact-source review still apply.
export function embeddedCustodyBypassesApi(source) {
  if (/\b(?:SignerService|ApiState|Store|MasterKey|SigningKey|SecretKey)\b/.test(source)) {
    return true;
  }
  const enrollmentImportsRemoved = source.replace(
    /(^|[;{}])(\s*)use\s+neo_signer\s*::\s*enrollment\s*::\s*\{\s*ValidatedGenesisEnrollment\s*,\s*MAX_MANIFEST_BYTES\s*,?\s*\}\s*;/g,
    '$1$2'
  );
  // Require a declaration boundary before `use`, so a reexport (even with
  // multiline visibility or comments) cannot become an allowed private import.
  // Aliased, glob, nested and additional imports remain outside this boundary.
  if (/\buse\s+neo_signer\s*::\s*enrollment\b/.test(enrollmentImportsRemoved)) return true;
  const publicModeRemoved = enrollmentImportsRemoved.replace(
    /\bneo_signer\s*::\s*enrollment\s*::\s*ENROLLMENT_MODE\b(?!\s*::)/g,
    ''
  );
  return /\bneo_signer\s*(?:as\b|;|::\s*\{)|\bneo_signer\s*::\s*(?!(?:attestation|auth|embedded|network|vault_profile)\b)/.test(
    publicModeRemoved
  );
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
  const workspaceExclude = cargoWorkspaceExclude(root);
  for (const retired of RETIRED_WORKSPACE_PATHS) {
    if (workspaceMembers.includes(retired)) {
      failures.push(`${retired}: retired crate must not be an active Cargo workspace member`);
    }
    if (!workspaceExclude.includes(retired)) {
      failures.push(`${retired}: retired crate must remain in Cargo workspace exclude`);
    }
    for (const dockerfile of [
      'deploy/nitro/Dockerfile.enclave',
      'deploy/nitro/Dockerfile.signer',
    ]) {
      if (!existsSync(resolve(root, dockerfile))) continue;
      reject(
        dockerfile,
        read(root, dockerfile),
        new RegExp(`COPY\\s+${retired.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}/`),
        `measured build copies retired crate ${retired}`
      );
    }
  }
  for (const manifest of RETIRED_DIRECT_MANIFESTS) {
    if (!requireFile(manifest)) continue;
    if (!retiredManifestIsArchiveStub(read(root, manifest))) {
      failures.push(`${manifest}: retired crate still exposes a buildable [package] manifest`);
    }
    const historical = `${manifest}.retired`;
    if (!existsSync(resolve(root, historical))) {
      failures.push(`${historical}: historical manifest is missing`);
    }
    if (!cargoMetadataFails(root, manifest)) {
      failures.push(`${manifest}: cargo metadata on the retired archive must fail`);
    }
  }
  for (const doc of RETIRED_ACTIONABLE_MARKDOWN) {
    if (!requireFile(doc)) continue;
    const source = read(root, doc);
    if (retiredMarkdownHasActionableCommands(source)) {
      failures.push(
        `${doc}: retired archive still contains an actionable build/run/deploy command`
      );
    }
  }
  const migrationDoc = 'docs/RUST_SERVICE_MIGRATION.md';
  if (requireFile(migrationDoc)) {
    const source = read(root, migrationDoc);
    requireMatch(
      migrationDoc,
      source,
      /morpheus-relater-rs/,
      'must name the retired heartbeat crate'
    );
    requireMatch(
      migrationDoc,
      source,
      /already-claimed/,
      'must describe /automation/execute as a one-shot already-claimed adapter'
    );
    requireMatch(
      migrationDoc,
      source,
      /durable (?:relayer )?scheduler/,
      'must distinguish the unimplemented durable automation scheduler'
    );
    reject(
      migrationDoc,
      source,
      /The remaining `\/session\/\*`, `\/automation\/execute`, and `\/oracle\/feed` routes[\s\S]*?rust-compute-lane-unavailable/,
      'must not describe landed host adapters as rust-compute-lane-unavailable'
    );
  }
  const matrixDoc = 'docs/rust-migration/SERVICE_CONTRACT_MATRIX.md';
  if (requireFile(matrixDoc)) {
    const source = read(root, matrixDoc);
    requireMatch(matrixDoc, source, /morpheus-relater-rs/, 'must name the retired heartbeat crate');
    requireMatch(
      matrixDoc,
      source,
      /already-claimed upkeep/,
      'must keep the one-shot automation adapter wording'
    );
    requireMatch(
      matrixDoc,
      source,
      /durable relayer scheduler remains disabled/,
      'must keep the unimplemented durable scheduler wording'
    );
  }
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
  // The approved single-process topology embeds the canonical custody router.
  // This is a source-structure drift check; behavioral admission and exact
  // source review remain mandatory. It is not a Rust parser or sandbox.
  const hostManifestSource = read(root, hostManifest);
  const embeddedBootstrap = 'workers/nitro-enclave-host/src/custody_bootstrap.rs';
  let dependencies = [];
  try {
    dependencies = dependencyEntries(
      parseToml(hostManifestSource),
      parseToml(read(root, 'Cargo.toml')).workspace || {}
    );
  } catch {
    failures.push(`${hostManifest}: cannot validate Cargo dependency declarations`);
  }
  for (const dependency of dependencies) {
    if (['scrypt', 'ed25519-dalek'].includes(dependency.package)) {
      failures.push(
        `${hostManifest}: enclave host must not duplicate private-key custody cryptography`
      );
    }
  }
  const signerDependencies = dependencies.filter(
    (dependency) => dependency.package === 'neo-signer' || dependency.name === 'neo-signer'
  );
  let canonicalSigner = false;
  for (const dependency of signerDependencies) {
    if (dependency.name !== 'neo-signer' || dependency.package !== 'neo-signer') {
      failures.push(
        `${hostManifest}: renamed signer dependencies bypass the reviewed embedded boundary`
      );
    }
    if (
      dependency.name === 'neo-signer' &&
      dependency.package === 'neo-signer' &&
      dependency.kind === 'dependencies' &&
      dependency.target === null &&
      !dependency.inherited &&
      typeof dependency.definition === 'object' &&
      Object.keys(dependency.definition).length === 1 &&
      dependency.definition.path === '../neo-signer'
    ) {
      canonicalSigner = true;
    } else {
      failures.push(`${hostManifest}: embedded custody must use the canonical workspace signer`);
    }
  }
  // Validate the bootstrap whenever signer is declared, even when that
  // declaration is rejected. Never exempt a file solely by its pathname.
  if (signerDependencies.length > 0) {
    if (requireFile(embeddedBootstrap)) {
      const bootstrap = read(root, embeddedBootstrap);
      requireMatch(
        embeddedBootstrap,
        bootstrap,
        /EmbeddedCustodyRuntime::boot\(/,
        'embedded custody must use the measured bootstrap'
      );
      requireMatch(
        embeddedBootstrap,
        bootstrap,
        /BootGuard::required\(/,
        'embedded custody must require attested boot'
      );
      if (embeddedCustodyBypassesApi(bootstrap)) {
        failures.push(
          `${embeddedBootstrap}: embedded bootstrap must not bypass the custody API or access private keys`
        );
      }
    }
  }
  for (const sourcePath of rustSources(root, 'workers/nitro-enclave-host/src')) {
    if (sourcePath !== embeddedBootstrap || !canonicalSigner) {
      reject(
        sourcePath,
        read(root, sourcePath),
        /\bneo_signer\b/,
        'only the measured bootstrap may import custody implementation types'
      );
    }
  }
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
