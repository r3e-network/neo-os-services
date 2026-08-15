import fs from 'node:fs/promises';
import path from 'node:path';
import { experimental, sc, wallet } from '@cityofzion/neon-js';
import { resolvePinnedNeoN3Role, normalizeMorpheusNetwork } from './lib-neo-signers.mjs';
import { trimString } from './lib-strings.mjs';

function resolveNeoN3NetworkDefaults() {
  const network = trimString(process.env.MORPHEUS_NETWORK || 'testnet').toLowerCase();
  if (network === 'mainnet') {
    return {
      rpcAddress: 'https://api.n3index.dev/mainnet',
      networkMagic: 860833102,
    };
  }
  return {
    rpcAddress: 'https://api.n3index.dev/testnet',
    networkMagic: 894710606,
  };
}

export async function loadContractArtifacts(baseName, buildDir = path.resolve('contracts/build')) {
  const nefPath = path.join(buildDir, `${baseName}.nef`);
  const manifestPath = path.join(buildDir, `${baseName}.manifest.json`);
  const [nefBytes, manifestRaw] = await Promise.all([
    fs.readFile(nefPath),
    fs.readFile(manifestPath, 'utf8'),
  ]);
  return {
    nef: sc.NEF.fromBuffer(nefBytes),
    manifest: sc.ContractManifest.fromJson(JSON.parse(manifestRaw)),
  };
}

export function getDeployConfig() {
  const defaults = resolveNeoN3NetworkDefaults();
  const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'testnet');
  const rpcAddress = trimString(process.env.NEO_RPC_URL || defaults.rpcAddress);
  const networkMagic = Number(process.env.NEO_NETWORK_MAGIC || defaults.networkMagic);
  const signer = resolvePinnedNeoN3Role(network, 'updater', { env: process.env });
  const account = new wallet.Account(
    signer.materialized?.wif || signer.materialized?.private_key || ''
  );
  return { rpcAddress, networkMagic, account };
}

export async function deployContract(baseName) {
  const { nef, manifest } = await loadContractArtifacts(baseName);
  return experimental.deployContract(nef, manifest, getDeployConfig());
}

export function createContract(hash) {
  const config = getDeployConfig();
  return new experimental.SmartContract(hash, config);
}

export function signer() {
  const { account } = getDeployConfig();
  return [{ account: account.scriptHash, scopes: 'CalledByEntry' }];
}
