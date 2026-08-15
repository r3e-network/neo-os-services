#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { experimental, sc, u, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from './lib-env.mjs';
import { normalizeMorpheusNetwork, resolvePinnedNeoN3Role } from './lib-neo-signers.mjs';
import { trimString } from './lib-strings.mjs';

const { values: flags } = parseArgs({
  options: {
    network: { type: 'string' },
    rpc: { type: 'string' },
    apply: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (flags.apply && flags['dry-run']) {
  throw new Error('--apply and --dry-run are mutually exclusive');
}
if (process.env.UPGRADE_APPLY === '1' && !flags.apply) {
  throw new Error('UPGRADE_APPLY is no longer accepted; use --apply --network explicitly');
}

const explicitNetwork = trimString(flags.network).toLowerCase();
if (explicitNetwork && explicitNetwork !== 'mainnet' && explicitNetwork !== 'testnet') {
  throw new Error('--network must be mainnet or testnet');
}
const applyUpdate = flags.apply === true;
if (applyUpdate && !explicitNetwork) {
  throw new Error('--apply requires explicit --network mainnet|testnet');
}

const requestedNetwork = normalizeMorpheusNetwork(
  explicitNetwork || process.env.MORPHEUS_NETWORK || 'testnet'
);
await loadDotEnv();
const network = normalizeMorpheusNetwork(
  explicitNetwork || process.env.MORPHEUS_NETWORK || requestedNetwork
);
await loadDotEnv(new URL(`../deploy/nitro/morpheus.${network}.env`, import.meta.url), {
  override: true,
});

const rpcAddress = trimString(
  flags.rpc ||
    process.env.NEO_RPC_URL ||
    (network === 'mainnet' ? 'https://api.n3index.dev/mainnet' : 'https://api.n3index.dev/testnet')
);
const networkMagic = Number(
  process.env.NEO_NETWORK_MAGIC || (network === 'mainnet' ? 860833102 : 894710606)
);
const contractTarget = trimString(process.env.CONTRACT_MORPHEUS_DATAFEED_HASH || '');
if (!contractTarget) throw new Error('CONTRACT_MORPHEUS_DATAFEED_HASH is required');
const contractHex = contractTarget.replace(/^0x/i, '').toLowerCase();
const contractHash = /^[0-9a-f]{40}$/.test(contractHex)
  ? `0x${contractHex}`
  : wallet.isAddress(contractTarget)
    ? `0x${wallet.getScriptHashFromAddress(contractTarget).toLowerCase()}`
    : '';
if (!contractHash) throw new Error('CONTRACT_MORPHEUS_DATAFEED_HASH must be a Hash160 or address');
if (!Number.isInteger(networkMagic) || networkMagic < 0 || networkMagic > 0xffffffff) {
  throw new Error('NEO_NETWORK_MAGIC must be a uint32');
}

const nefPath = path.resolve('contracts/build/MorpheusDataFeed.nef');
const manifestPath = path.resolve('contracts/build/MorpheusDataFeed.manifest.json');
const [nefBytes, manifestRaw] = await Promise.all([
  fs.readFile(nefPath),
  fs.readFile(manifestPath, 'utf8'),
]);
const manifest = JSON.parse(manifestRaw);
const artifact = {
  nef: nefPath,
  manifest: manifestPath,
  contract_name: trimString(manifest?.name || ''),
  nef_sha256: createHash('sha256').update(nefBytes).digest('hex'),
  nef_checksum: nefBytes.readUInt32LE(nefBytes.length - 4),
};

if (!applyUpdate) {
  console.log(
    JSON.stringify(
      {
        mode: 'DRY_RUN',
        broadcast: false,
        network,
        network_magic: networkMagic,
        rpc: rpcAddress,
        datafeed_hash: contractHash,
        artifact,
        next_step: `node scripts/upgrade-morpheus-datafeed.mjs --apply --network ${network}`,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const signer = resolvePinnedNeoN3Role(network, 'updater', { env: process.env });
const signingKey = signer.materialized?.wif || signer.materialized?.private_key || '';
if (!signingKey) {
  throw new Error('the pinned Neo N3 updater signing key is required for --apply');
}

const account = new wallet.Account(signingKey);
const contract = new experimental.SmartContract(contractHash, {
  rpcAddress,
  networkMagic,
  account,
});

console.log(
  JSON.stringify(
    {
      mode: 'APPLY',
      broadcast: true,
      network,
      network_magic: networkMagic,
      rpc: rpcAddress,
      datafeed_hash: contractHash,
      admin_address: account.address,
      admin_script_hash: `0x${account.scriptHash}`,
      artifact,
    },
    null,
    2
  )
);

const txid = await contract.invoke('update', [
  sc.ContractParam.byteArray(u.HexString.fromHex(nefBytes.toString('hex'), true)),
  sc.ContractParam.string(manifestRaw),
]);

console.log(`MorpheusDataFeed update tx: ${txid}`);
