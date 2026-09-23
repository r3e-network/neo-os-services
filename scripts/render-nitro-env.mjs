// Renders the two local-only provisioning inputs of a Nitro host:
//   morpheus-nitro-signer.env — what deploy/nitro/start-nitro-signer.sh reads to
//     provision the Rust frontier: the frontier bearer token, its KMS-sealed
//     envelope (MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64) and the KMS-sealed
//     custody caller envelope (SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64). The
//     start script refuses to provision without either ciphertext, so this
//     renderer refuses to render without them (unless --allow-missing).
//   neo-os-relayer.env — the Rust relayer's custody signer configuration.
// Neo N3 signing is custody-side (SIGNER_ROLE_*_KEY_ID). The frontier holds no
// Neo N3 key, so the former MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64 /
// MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64 inputs are neither required nor
// rendered; when a source still carries them they are reported by name only.
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
const custodyTokenCiphertext = pick(env, ['SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64']);
const RETIRED_N3_SIGNER_CIPHERTEXTS = [
  'MORPHEUS_UPDATER_NEO_N3_KMS_CIPHERTEXT_BASE64',
  'MORPHEUS_ORACLE_VERIFIER_KMS_CIPHERTEXT_BASE64',
];
const retiredInputsIgnored = RETIRED_N3_SIGNER_CIPHERTEXTS.filter((key) => pick(env, [key]));
// start-nitro-signer.sh (neoos_require_base64) refuses anything else.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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

if (!custodyTokenCiphertext && !args.allowMissing) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: 'missing KMS-sealed custody caller token',
        required: 'SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64',
        detail:
          'start-nitro-signer.sh provisions the frontier with this envelope; without it the frontier has no custody caller and cannot sign',
        checked_sources: sources,
      },
      null,
      2
    )
  );
  process.exit(2);
}
const malformedCiphertexts = Object.entries({
  MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: runtimeTokenCiphertext,
  SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64: custodyTokenCiphertext,
})
  .filter(([, value]) => value && !BASE64.test(value))
  .map(([key]) => key);
if (malformedCiphertexts.length) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        reason: 'KMS ciphertext is not base64',
        malformed: malformedCiphertexts,
        checked_sources: sources,
      },
      null,
      2
    )
  );
  process.exit(2);
}
const complete = Boolean(runtimeToken && runtimeTokenCiphertext && custodyTokenCiphertext);
// The frontier's host bridge on this network: the live mainnet frontier is on
// 8787 (start-nitro-signer.sh's default); the TestNet frontier is on 8791
// (deploy/nitro/morpheus-nitro-testnet.env.example), off mainnet's and custody's
// ports, and the relayer on that host must call it there.
const frontierUrl = network === 'testnet' ? 'http://127.0.0.1:8791' : 'http://127.0.0.1:8787';

const relayerMode = pick(env, ['MORPHEUS_RELAYER_MODE']) || 'requests_only';
if (!['requests_only', 'feed_only', 'combined'].includes(relayerMode)) {
  console.error(JSON.stringify({ ok: false, reason: `unsupported relayer mode: ${relayerMode}` }));
  process.exit(2);
}
const activeChains = (pick(env, ['MORPHEUS_ACTIVE_CHAINS']) || 'neo_n3')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
if (
  activeChains.length === 0 ||
  activeChains.some((chain) => !['neo_n3', 'neox'].includes(chain))
) {
  console.error(
    JSON.stringify({ ok: false, reason: `unsupported active chains: ${activeChains.join(',')}` })
  );
  process.exit(2);
}
const canonicalActiveChains = [...new Set(activeChains)].join(',');
const feedSyncEnabled = pick(env, ['MORPHEUS_FEED_SYNC_ENABLED']) || 'false';
if (!['true', 'false'].includes(feedSyncEnabled.toLowerCase())) {
  console.error(
    JSON.stringify({ ok: false, reason: 'MORPHEUS_FEED_SYNC_ENABLED must be true or false' })
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
    line('SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64', custodyTokenCiphertext),
  ].join('\n') + '\n';

const relayerEnv =
  [
    line('MORPHEUS_NETWORK', network),
    // The production Rust authority supports N3/NeoX request and feed lanes.
    // Keep generated defaults conservative (N3 requests) and automation closed;
    // operators can opt into the other validated combinations explicitly.
    line('NODE_ENV', 'production'),
    line('MORPHEUS_RELAYER_MODE', relayerMode),
    line('MORPHEUS_ACTIVE_CHAINS', canonicalActiveChains),
    line('MORPHEUS_AUTOMATION_ENABLED', 'false'),
    line('MORPHEUS_FEED_SYNC_ENABLED', feedSyncEnabled.toLowerCase()),
    line('MORPHEUS_FEED_SYMBOLS', pick(env, ['MORPHEUS_FEED_SYMBOLS'])),
    line('MORPHEUS_RELAYER_INSTANCE_ID', pick(env, ['MORPHEUS_RELAYER_INSTANCE_ID'])),
    line(
      'MORPHEUS_RELAYER_STATE_FILE',
      `/var/lib/neo-os-relayer/state.${network}.${relayerMode.replaceAll('_', '-')}.json`
    ),
    line('MORPHEUS_RUNTIME_URL', frontierUrl),
    line('MORPHEUS_RELAYER_ENCLAVE_FULFILL', 'true'),
    line('MORPHEUS_RELAYER_ENCLAVE_FULFILL_URL', frontierUrl),
    line('NITRO_USE_DERIVED_KEYS', 'true'),
    line('MORPHEUS_RUNTIME_TOKEN', runtimeToken),
    // Relayer Neo N3 signing is custody-only: the relayer talks to the custody
    // service directly (its vsock-to-loopback bridge inside the enclave) using
    // a dedicated bearer caller token plus the same SIGNER_SERVICE_URL/TOKEN +
    // SIGNER_ROLE_*_KEY_ID variable names the legacy host-side /sign/payload
    // shim also reads for its own translation route. workload-ed25519 callers
    // intentionally have no bearer token and are not a relayer transport yet.
    line('SIGNER_SERVICE_URL', pick(env, ['SIGNER_SERVICE_URL'])),
    line('SIGNER_SERVICE_TOKEN', pick(env, ['SIGNER_SERVICE_TOKEN'])),
    line('SIGNER_ROLE_UPDATER_KEY_ID', pick(env, ['SIGNER_ROLE_UPDATER_KEY_ID'])),
    line('SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID', pick(env, ['SIGNER_ROLE_ORACLE_VERIFIER_KEY_ID'])),
    line(
      network === 'mainnet' ? 'NEO_RPC_URLS_MAINNET' : 'NEO_RPC_URLS_TESTNET',
      pick(env, [
        network === 'mainnet' ? 'NEO_RPC_URLS_MAINNET' : 'NEO_RPC_URLS_TESTNET',
        network === 'mainnet' ? 'NEO_MAINNET_RPC_URLS' : 'NEO_TESTNET_RPC_URLS',
      ])
    ),
    line(
      network === 'mainnet'
        ? 'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET'
        : 'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
      pick(env, [
        network === 'mainnet'
          ? 'CONTRACT_MORPHEUS_ORACLE_HASH_MAINNET'
          : 'CONTRACT_MORPHEUS_ORACLE_HASH_TESTNET',
        'CONTRACT_MORPHEUS_ORACLE_HASH',
      ])
    ),
    line(
      network === 'mainnet'
        ? 'CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET'
        : 'CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET',
      pick(env, [
        network === 'mainnet'
          ? 'CONTRACT_MORPHEUS_DATAFEED_HASH_MAINNET'
          : 'CONTRACT_MORPHEUS_DATAFEED_HASH_TESTNET',
        'CONTRACT_MORPHEUS_DATAFEED_HASH',
      ])
    ),
    line('SIGNER_ROLE_NEOX_UPDATER_KEY_ID', pick(env, ['SIGNER_ROLE_NEOX_UPDATER_KEY_ID'])),
    line('SIGNER_ROLE_NEOX_VERIFIER_KEY_ID', pick(env, ['SIGNER_ROLE_NEOX_VERIFIER_KEY_ID'])),
    line('MORPHEUS_RELAYER_NEOX_RPC_URL', pick(env, ['MORPHEUS_RELAYER_NEOX_RPC_URL'])),
    line('MORPHEUS_RELAYER_NEOX_RPC_URLS', pick(env, ['MORPHEUS_RELAYER_NEOX_RPC_URLS'])),
    line(
      'MORPHEUS_RELAYER_NEOX_CHAIN_ID',
      pick(env, ['MORPHEUS_RELAYER_NEOX_CHAIN_ID']) ||
        (network === 'mainnet' ? '47763' : '12227332')
    ),
    line('MORPHEUS_RELAYER_NEOX_ORACLE', pick(env, ['MORPHEUS_RELAYER_NEOX_ORACLE'])),
    line('MORPHEUS_RELAYER_NEOX_DATAFEED', pick(env, ['MORPHEUS_RELAYER_NEOX_DATAFEED'])),
    line(
      'MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT',
      pick(env, ['MORPHEUS_RELAYER_NEOX_FEED_GAS_LIMIT']) || '2000000'
    ),
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
await write0600(path.join(outputDir, 'neo-os-relayer.env'), relayerEnv);

console.log(
  JSON.stringify(
    {
      ok: complete,
      output_dir: outputDir,
      signer_env: path.join(outputDir, 'morpheus-nitro-signer.env'),
      relayer_env: path.join(outputDir, 'neo-os-relayer.env'),
      checked_sources: sources,
      kms_ciphertexts: {
        MORPHEUS_RUNTIME_TOKEN_KMS_CIPHERTEXT_BASE64: Boolean(runtimeTokenCiphertext),
        SIGNER_SERVICE_TOKEN_KMS_CIPHERTEXT_BASE64: Boolean(custodyTokenCiphertext),
      },
      retired_inputs_ignored: retiredInputsIgnored,
    },
    null,
    2
  )
);
