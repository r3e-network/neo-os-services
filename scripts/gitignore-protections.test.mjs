// The ignore rules must keep secrets and generated output out of `git add`,
// wherever in the tree they appear, and must not hide tracked sources.
//
// b401ed5 ("standardize .gitignore patterns") anchored node_modules, .next,
// coverage, .vercel, .claude, .serena, .worktrees and .omx to the repository
// root. After one web build `git status` showed apps/web/.next/ (1.1 GB of
// webpack cache) as addable, and nested coverage, Vercel links and tool state
// were no longer ignored. The same change added `**/bin/`, which matched the
// Rust binary sources under src/bin/, and `*.pem`, which matched the pinned AWS
// Nitro root certificate, while a trailing `.env*` kept re-ignoring the
// committed .env examples. Each case below is checked with
// `git check-ignore --no-index`, so the answer comes from the rules alone.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function git(args, input) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', input });
  } catch (error) {
    // check-ignore exits 1 when none of the paths is ignored.
    if (args[0] === 'check-ignore' && error.status === 1) return error.stdout;
    throw error;
  }
}

function ignoredAmong(paths) {
  const output = git(['check-ignore', '--no-index', '--stdin', '-z'], paths.join('\0') + '\0');
  return new Set(output.split('\0').filter(Boolean));
}

function tracked(pattern) {
  return git(['ls-files', '-z', '--', pattern]).split('\0').filter(Boolean);
}

const SECRETS = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.mainnet',
  '.envrc',
  '.env-backup',
  '.env_prod',
  'deploy/.env_prod',
  'apps/web/.env',
  'apps/web/.env.local',
  'apps/web/.env.production.local',
  'workers/nitro-worker/.env',
  'workers/nitro-worker/.env.ci',
  'deploy/evm/neox-fulfiller.env',
  'deploy/nitro/morpheus.mainnet.env',
  'deploy/nitro/signer.env',
  'deploy/cloudflare/morpheus-control-plane/vars.env',
  '.npmrc',
  'apps/web/.npmrc',
  'deploy/nitro/signer.pem',
  'apps/web/lib/attestation/other-root.pem',
  'deploy/keys/admin.key',
  'id_rsa',
  'deploy/client.p12',
  'deploy/client.pfx',
  'backup.gpg',
  '.secrets/oracle.json',
  'private-backups/mainnet/oracle-key.json',
  '.ops-backups/state.json',
  'apps/web/.vercel/project.json',
  'apps/web/.vercel/.env.production.local',
];

const ARTIFACTS = [
  'node_modules/semver/package.json',
  'apps/web/node_modules/next/package.json',
  'workers/nitro-worker/node_modules/undici/index.js',
  'packages/shared/node_modules/x/index.js',
  'deploy/custody-state-authority/node_modules/cbor2/package.json',
  'contracts/neox/node_modules/x/index.js',
  '.next/BUILD_ID',
  'apps/web/.next/BUILD_ID',
  'apps/web/.next/cache/webpack/client-production/0.pack',
  'coverage/index.html',
  'apps/web/coverage/index.html',
  'workers/nitro-worker/coverage/lcov.info',
  'dist/index.js',
  'packages/shared/dist/index.js',
  '.turbo/cache.json',
  'apps/web/.turbo/cache.json',
  'apps/web/tsconfig.tsbuildinfo',
  'test-results/report.json',
  'apps/web/test-results/report.json',
  'target/debug/signer_service',
  'workers/neo-signer/target/debug/signer_service',
  '.claude/settings.local.json',
  'apps/web/.claude/settings.local.json',
  '.serena/cache/index',
  'workers/nitro-worker/.serena/cache/index',
  '.worktrees/branch/README.md',
  'deploy/.worktrees/branch/README.md',
  '.omx/state.json',
  'apps/web/.omx/state.json',
  'graphify-out/graph.json',
  'apps/web/graphify-out/graph.json',
  '.idea/workspace.xml',
  'apps/web/.idea/workspace.xml',
  '.codegraph/codegraph.db',
  'contracts/build/MorpheusOracle.nef',
  'MorpheusOracle.nef',
];

test('representative secret paths are ignored anywhere in the tree', () => {
  const ignored = ignoredAmong(SECRETS);
  assert.deepEqual(
    SECRETS.filter((file) => !ignored.has(file)),
    [],
    'these secret paths could be committed'
  );
});

test('dependencies, build output and tool state are ignored anywhere in the tree', () => {
  const ignored = ignoredAmong(ARTIFACTS);
  assert.deepEqual(
    ARTIFACTS.filter((file) => !ignored.has(file)),
    [],
    'these generated paths could be committed'
  );
});

test('the build output of every tracked .NET project is ignored', () => {
  const projects = tracked('*.csproj');
  assert.ok(projects.length > 0, 'no .csproj found; the check would pass vacuously');
  const outputs = projects.flatMap((project) => {
    const dir = path.posix.dirname(project);
    return [
      `${dir}/bin/Release/net10.0/${path.posix.basename(project, '.csproj')}.dll`,
      `${dir}/bin/sc/${path.posix.basename(project, '.csproj')}.nef`,
      `${dir}/obj/project.assets.json`,
    ];
  });
  const ignored = ignoredAmong(outputs);
  assert.deepEqual(
    outputs.filter((file) => !ignored.has(file)),
    [],
    'this .NET output could be committed'
  );
});

test('committed examples, Rust binary sources and pinned certificates stay addable', () => {
  const rustBinDirs = [
    ...new Set(
      git(['ls-files', '-z'])
        .split('\0')
        .filter((file) => /(^|\/)src\/bin\/[^/]+\.rs$/.test(file))
        .map((file) => path.posix.dirname(file))
    ),
  ];
  assert.ok(rustBinDirs.length > 0, 'no src/bin/ targets found; the check would pass vacuously');
  const mustStayAddable = [
    '.env.example',
    '.env.development.example',
    '.env.production.example',
    'apps/web/.env.example',
    'workers/nitro-worker/.env.example',
    'deploy/evm/neox-fulfiller.env.example',
    'deploy/cloudflare/morpheus-control-plane/vars.example.env',
    'apps/web/lib/attestation/aws-nitro-root.pem',
    '.codegraph/.gitignore',
    // a new binary target next to each existing one
    ...rustBinDirs.map((dir) => `${dir}/new_tool.rs`),
  ];
  const ignored = ignoredAmong(mustStayAddable);
  assert.deepEqual(
    mustStayAddable.filter((file) => ignored.has(file)),
    [],
    'these source paths are hidden from git add'
  );
});

test('no tracked file is ignored except the reviewed exceptions', () => {
  const exceptions = [
    // Curated live-run evidence; later runs write new copies that stay local.
    /^examples\/deployments\/[^/]+\.latest\.json$/,
    // Next.js type shim the web build expects; other generated copies stay out.
    /^apps\/web\/next-env\.d\.ts$/,
  ];
  const trackedButIgnored = git(['ls-files', '-z', '-ci', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  assert.deepEqual(
    trackedButIgnored.filter((file) => !exceptions.some((pattern) => pattern.test(file))),
    [],
    'tracked files matched by an ignore rule: new files beside them would be silently skipped'
  );
});
