import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { wallet } from '@cityofzion/neon-js';
import { trimString } from './lib-strings.mjs';

function parseArgs(argv = process.argv.slice(2)) {
  const out = { network: 'mainnet', output: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--network') out.network = argv[++index] || out.network;
    else if (arg.startsWith('--network=')) out.network = arg.slice('--network='.length);
    else if (arg === '--output') out.output = argv[++index] || out.output;
    else if (arg.startsWith('--output=')) out.output = arg.slice('--output='.length);
  }
  return out;
}

function createAccount() {
  const account = new wallet.Account();
  return {
    wif: account.WIF,
    private_key: account.privateKey,
    public_key: account.publicKey,
    address: account.address,
    script_hash: `0x${account.scriptHash}`,
  };
}

function envLine(key, value) {
  return `${key}=${String(value || '').replace(/\n/g, '')}`;
}

async function write0600(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

const args = parseArgs();
const network = trimString(args.network) === 'testnet' ? 'testnet' : 'mainnet';
const suffix = network === 'mainnet' ? 'MAINNET' : 'TESTNET';
const output = path.resolve(args.output || `.secrets/nitro/generated-${network}-signer.env`);

const updater = createAccount();
const verifier = createAccount();
const runtimeToken = crypto.randomBytes(32).toString('base64url');

const content =
  [
    envLine('MORPHEUS_NETWORK', network),
    envLine('PORT', '8080'),
    envLine('NITRO_SIGNER_VSOCK_PORT', '8787'),
    envLine('MORPHEUS_ALLOW_UNPINNED_SIGNERS', 'true'),
    envLine('NITRO_SIGNER_TOKEN', runtimeToken),
    envLine('MORPHEUS_RUNTIME_TOKEN', runtimeToken),
    envLine(`MORPHEUS_UPDATER_NEO_N3_WIF_${suffix}`, updater.wif),
    envLine(`MORPHEUS_UPDATER_NEO_N3_PRIVATE_KEY_${suffix}`, updater.private_key),
    envLine(`MORPHEUS_ORACLE_VERIFIER_WIF_${suffix}`, verifier.wif),
    envLine(`MORPHEUS_ORACLE_VERIFIER_PRIVATE_KEY_${suffix}`, verifier.private_key),
  ].join('\n') + '\n';

await write0600(output, content);

console.log(
  JSON.stringify(
    {
      ok: true,
      network,
      output,
      warning:
        'new signer secrets were written locally but are not active until the Neo N3 contracts are explicitly rotated',
      updater: {
        address: updater.address,
        script_hash: updater.script_hash,
        public_key: updater.public_key,
      },
      oracle_verifier: {
        address: verifier.address,
        script_hash: verifier.script_hash,
        public_key: verifier.public_key,
      },
    },
    null,
    2
  )
);
