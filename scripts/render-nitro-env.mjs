import { trimString } from './lib-strings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readMergedDotEnvFiles } from './lib-env.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    network: 'mainnet',
    outputDir: '',
    source: [],
    allowMissing: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--network') out.network = argv[++index] || out.network;
    else if (arg.startsWith('--network=')) out.network = arg.slice('--network='.length);
    else if (arg === '--output-dir') out.outputDir = argv[++index] || out.outputDir;
    else if (arg.startsWith('--output-dir=')) out.outputDir = arg.slice('--output-dir='.length);
    else if (arg === '--source') out.source.push(argv[++index] || '');
    else if (arg.startsWith('--source=')) out.source.push(arg.slice('--source='.length));
    else if (arg === '--allow-missing') out.allowMissing = true;
  }
  return out;
}

function pick(env, keys) {
  for (const key of keys) {
    const value = trimString(env[key]);
    if (value) return value;
  }
  return '';
}

function line(key, value) {
  return `${key}=${String(value || '').replace(/\n/g, '')}`;
}

async function write0600(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

const args = parseArgs();
const repoRoot = process.cwd();
const network = trimString(args.network) || 'mainnet';
if (!['mainnet', 'testnet'].includes(network)) {
  console.error(JSON.stringify({ ok: false, reason: `unsupported network: ${network}` }, null, 2));
  process.exit(2);
}
const outputDir = path.resolve(args.outputDir || '.secrets/nitro');
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
const runtimeToken = pick(env, ['NITRO_SIGNER_TOKEN', 'MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN']);
const runtimeTokenCiphertext = pick(env, ['MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64']);

if (!runtimeToken && !args.allowMissing) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: 'missing runtime authorization token',
        required_one_of: ['NITRO_SIGNER_TOKEN', 'MORPHEUS_RUNTIME_TOKEN', 'NITRO_API_TOKEN'],
        checked_sources: sources,
      },
      null,
      2
    )
  );
  process.exit(2);
}
if (!runtimeTokenCiphertext && !args.allowMissing) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: 'missing KMS-sealed runtime authorization token',
        required: 'MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64',
        checked_sources: sources,
      },
      null,
      2
    )
  );
  process.exit(2);
}

const signerCiphertexts = {
  updater: pick(env, ['MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64']),
  oracle_verifier: pick(env, ['MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64']),
};
const missingRoles = Object.entries(signerCiphertexts)
  .filter(([, ciphertext]) => !ciphertext)
  .map(([role]) => ({ role, issue: 'missing attestation-gated KMS ciphertext' }));

if (missingRoles.length && !args.allowMissing) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: 'missing KMS-sealed Nitro signer material',
        missing_roles: missingRoles,
        checked_sources: sources,
      },
      null,
      2
    )
  );
  process.exit(2);
}

const signerEnv =
  [
    line('MORPHEUS_NETWORK', network),
    line('PORT', '8080'),
    line('NITRO_SIGNER_VSOCK_PORT', '8787'),
    line(
      'MORPHEUS_ALLOW_UNPINNED_SIGNERS',
      pick(env, ['MORPHEUS_ALLOW_UNPINNED_SIGNERS']) || 'false'
    ),
    line('NITRO_SIGNER_TOKEN', runtimeToken),
    line('MORPHEUS_RUNTIME_TOKEN', runtimeToken),
    line('MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64', runtimeTokenCiphertext),
    line('MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64', signerCiphertexts.updater),
    line('MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64', signerCiphertexts.oracle_verifier),
  ].join('\n') + '\n';

const relayerEnv =
  [
    line('MORPHEUS_NETWORK', network),
    line('MORPHEUS_RELAYER_MODE', 'combined'),
    line('MORPHEUS_ACTIVE_CHAINS', 'neo_n3'),
    line('MORPHEUS_RUNTIME_URL', 'http://127.0.0.1:8787'),
    line('NITRO_USE_DERIVED_KEYS', 'true'),
    line('MORPHEUS_RUNTIME_TOKEN', runtimeToken),
    // Relayer Neo N3 signing is custody-only: the relayer talks to the custody
    // service directly (its vsock-to-loopback bridge inside the enclave) using
    // the same SIGNER_SERVICE_URL/TOKEN + SIGNER_ROLE_*_KEY_ID names the legacy
    // host-side /sign/payload shim also reads for its own translation route.
    line('SIGNER_SERVICE_URL', pick(env, ['SIGNER_SERVICE_URL'])),
    line('SIGNER_SERVICE_TOKEN', pick(env, ['SIGNER_SERVICE_TOKEN'])),
    line('SIGNER_ROLE_UPDATER_KEY_ID', pick(env, ['SIGNER_ROLE_UPDATER_KEY_ID'])),
    line('SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID', pick(env, ['SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID'])),
    line('SIGNER_ROLE_FEE_FUNDER_KEY_ID', pick(env, ['SIGNER_ROLE_FEE_FUNDER_KEY_ID'])),
    line(
      'SUPABASE_URL',
      pick(env, ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'morpheus_SUPABASE_URL'])
    ),
    line(
      'SUPABASE_SECRET_KEY',
      pick(env, [
        'SUPABASE_SECRET_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        'morpheus_SUPABASE_SECRET_KEY',
        'morpheus_SUPABASE_SERVICE_ROLE_KEY',
      ])
    ),
    line(
      'MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL',
      pick(env, ['MORPHEUS_BETTERSTACK_RELAYER_HEARTBEAT_URL'])
    ),
    line(
      'MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL',
      pick(env, ['MORPHEUS_BETTERSTACK_RELAYER_FEED_HEARTBEAT_URL'])
    ),
    line(
      'MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL',
      pick(env, ['MORPHEUS_BETTERSTACK_RELAYER_FAILURE_URL'])
    ),
  ].join('\n') + '\n';

await write0600(path.join(outputDir, 'morpheus-nitro-signer.env'), signerEnv);
await write0600(path.join(outputDir, 'morpheus-relayer.env'), relayerEnv);

console.log(
  JSON.stringify(
    {
      ok: missingRoles.length === 0,
      output_dir: outputDir,
      signer_env: path.join(outputDir, 'morpheus-nitro-signer.env'),
      relayer_env: path.join(outputDir, 'morpheus-relayer.env'),
      checked_sources: sources,
      signer_roles: Object.entries(signerCiphertexts).map(([role, ciphertext]) => ({
        role,
        kms_ciphertext_present: Boolean(ciphertext),
      })),
    },
    null,
    2
  )
);
