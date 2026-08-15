#!/usr/bin/env node
// Deploy a compiled EVM contract to Neo X. Dual-gated: requires DEPLOY_APPLY=1.
// Usage: NEOX_DEPLOY_PK=0x.. DEPLOY_APPLY=1 node deploy/evm/deploy.mjs MorpheusOracleEVM [constructorArgsJson]
//   constructorArgsJson e.g. '["0x0000...0000","0x0000...0000"]'  (defaults to [])
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const name = process.argv[2];
const ctorArgs = process.argv[3] ? JSON.parse(process.argv[3]) : [];
if (!name) {
  console.error('usage: deploy.mjs <ContractName> [ctorArgsJson]');
  process.exit(1);
}

const RPC = process.env.NEOX_RPC || 'https://mainnet-1.rpc.banelabs.org';
const CHAIN_ID = Number(process.env.NEOX_CHAIN_ID || 47763);
const NET = process.env.NEOX_NET || 'neox-mainnet';
const PK = process.env.NEOX_DEPLOY_PK || process.env.NEOX_FEED_PK;
if (!PK) {
  console.error('set NEOX_DEPLOY_PK');
  process.exit(1);
}

const abi = JSON.parse(readFileSync(resolve(ROOT, `contracts-evm/build/${name}.abi.json`), 'utf8'));
const bin = '0x' + readFileSync(resolve(ROOT, `contracts-evm/build/${name}.bin`), 'utf8').trim();

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(PK, provider);

const bal = ethers.formatEther(await provider.getBalance(wallet.address));
console.log(`deployer ${wallet.address}  balance ${bal} GAS  net ${NET} (chainId ${CHAIN_ID})`);
console.log(`contract ${name}  ${bin.length / 2 - 1} bytes  ctorArgs ${JSON.stringify(ctorArgs)}`);

if (process.env.DEPLOY_APPLY !== '1') {
  console.log('\nDRY RUN — set DEPLOY_APPLY=1 to broadcast.');
  process.exit(0);
}

const factory = new ethers.ContractFactory(abi, bin, wallet);
const contract = await factory.deploy(...ctorArgs);
const tx = contract.deploymentTransaction();
console.log(`deploy tx ${tx.hash} — waiting for receipt...`);
await contract.waitForDeployment();
const address = await contract.getAddress();
const rc = await provider.getTransactionReceipt(tx.hash);
console.log(`✅ deployed ${name} at ${address}  (block ${rc.blockNumber}, gasUsed ${rc.gasUsed})`);

const rec = {
  network: NET,
  chainId: CHAIN_ID,
  address,
  deployTx: tx.hash,
  deployer: wallet.address,
  ctorArgs,
  deployedAt: new Date().toISOString(),
};
writeFileSync(
  resolve(ROOT, `contracts-evm/build/${name}.${NET}.json`),
  JSON.stringify(rec, null, 2)
);
console.log(`record -> contracts-evm/build/${name}.${NET}.json`);
