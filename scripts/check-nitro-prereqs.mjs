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
  nitro_files: [
    'deploy/nitro/Dockerfile.signer',
    'deploy/nitro/nitro-signer-server.mjs',
    'deploy/nitro/build-nitro-signer-eif.sh',
    'deploy/nitro/start-nitro-signer.sh',
    'deploy/systemd/morpheus-nitro-signer.service',
    'deploy/systemd/morpheus-relayer-nitro.service',
  ].every((entry) => fileExists(path.resolve(repoRoot, entry))),
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
