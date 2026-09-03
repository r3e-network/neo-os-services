import fs from 'node:fs';
import path from 'node:path';
import { readMergedDotEnvFiles } from './lib-env.mjs';
import { reportPinnedNeoN3Role } from './lib-neo-signers.mjs';
import { trimString } from './lib-strings.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const out = { network: 'mainnet', source: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--network') out.network = argv[++index] || out.network;
    else if (arg.startsWith('--network=')) out.network = arg.slice('--network='.length);
    else if (arg === '--source') out.source.push(argv[++index] || '');
    else if (arg.startsWith('--source=')) out.source.push(arg.slice('--source='.length));
  }
  return out;
}

function pick(env, keys) {
  return keys.some((key) => trimString(env[key]));
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

const args = parseArgs();
const repoRoot = process.cwd();
const network = trimString(args.network) || 'mainnet';
const sources = args.source.filter(Boolean).length
  ? args.source
  : [
      '.env',
      '.env.local',
      `deploy/nitro/morpheus.${network}.env`,
      'deploy/nitro/morpheus.hub.env',
      '.automation-logs/hourly-full-stack-validation/20260522-090604/workspace-secrets.env',
    ];
const env = await readMergedDotEnvFiles(sources.map((entry) => path.resolve(repoRoot, entry)));

const signerRoles = ['updater', 'oracle_verifier'].map((role) => {
  const report = reportPinnedNeoN3Role(network, role, { env, allowMissing: false });
  return {
    role,
    ok: report.ok && Boolean(report.materialized),
    selected_source: report.selected_source || null,
    selected_identity: report.selected_identity || null,
    pinned: report.pinned || null,
    issues: report.issues,
  };
});

// Three generations of enclave deployment share this directory, so the file
// check is grouped by which one a file belongs to: the frontier (the merged
// compute+sign enclave, Dockerfile.enclave), custody (the key vault,
// Dockerfile.signer), and the retired Node signer kept only as a rollback
// build target (Dockerfile.signer-legacy). Grouping matters because the names
// do not: build-nitro-signer-eif.sh reads Dockerfile.signer-legacy, not
// Dockerfile.signer, so a flat list can pass while a build input is missing.
const nitroFileGroups = {
  frontier: [
    'deploy/nitro/Dockerfile.enclave',
    'deploy/nitro/build-enclave-eif.sh',
    'deploy/nitro/start-nitro-signer.sh',
    'deploy/nitro/provision-enclave-compute.sh',
    'deploy/nitro/start-egress-proxy.sh',
    'deploy/systemd/morpheus-nitro-signer.service',
    'deploy/systemd/morpheus-nitro-egress.service',
    'deploy/systemd/morpheus-relayer-nitro.service',
  ],
  custody: [
    'deploy/nitro/Dockerfile.signer',
    'deploy/nitro/build-custody-eif.sh',
    'deploy/nitro/start-nitro-custody.sh',
    'deploy/systemd/morpheus-nitro-custody.service',
  ],
  // The legacy signer has no unit of its own: the documented rollback is to
  // repoint MORPHEUS_NITRO_EIF at morpheus-nitro-signer.eif and restart
  // morpheus-nitro-signer.service (AA-EDGE-MIGRATION-RUNBOOK.md), so these are
  // build inputs, not a runnable deployment.
  legacy_signer: [
    'deploy/nitro/Dockerfile.signer-legacy',
    'deploy/nitro/nitro-signer-server.mjs',
    'deploy/nitro/entrypoint-signer.sh',
    'deploy/nitro/build-nitro-signer-eif.sh',
  ],
};
const missingNitroFiles = Object.entries(nitroFileGroups).flatMap(([group, files]) =>
  files
    .filter((entry) => !fileExists(path.resolve(repoRoot, entry)))
    .map((entry) => `${group}: ${entry}`)
);

const checks = {
  signer_material: signerRoles.every((entry) => entry.ok),
  runtime_token: pick(env, ['NITRO_SIGNER_TOKEN', 'MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN']),
  supabase: pick(env, ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'morpheus_SUPABASE_URL']),
  supabase_secret: pick(env, [
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'morpheus_SUPABASE_SECRET_KEY',
    'morpheus_SUPABASE_SERVICE_ROLE_KEY',
  ]),
  nitro_files: missingNitroFiles.length === 0,
};

const missing = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([key]) => key);

console.log(
  JSON.stringify(
    {
      ok: missing.length === 0,
      network,
      missing,
      checks,
      missing_nitro_files: missingNitroFiles,
      signer_roles: signerRoles,
      checked_sources: sources,
      next_action: checks.signer_material
        ? 'render:nitro-env can create relayer and signer env inputs'
        : 'recover the pinned signer material or generate a new Nitro signer identity and rotate on-chain roles',
    },
    null,
    2
  )
);

process.exitCode = missing.length === 0 ? 0 : 2;
