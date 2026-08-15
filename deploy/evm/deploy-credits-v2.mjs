#!/usr/bin/env node
/**
 * Neo X MainNet-only deployment entrypoint for MiniAppCreditsV2.
 *
 * The default path is an offline plan: it validates the constructor and local
 * artifacts without creating a provider or reading a deployer key. Broadcasting
 * requires both DEPLOY_APPLY=1 and an exact chain acknowledgement. This script
 * deliberately does not update any production registry or enable a settler.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

export const CONTRACT_NAME = 'MiniAppCreditsV2';
export const NEO_X_MAINNET_CHAIN_ID = 47_763n;
export const MAINNET_ACK = 'neo-x-mainnet:47763';
export const GAS_WEI_PER_CREDIT = 10n ** 16n;
export const CREDITS_PER_GAS = 100n;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ABI_PATH = resolve(ROOT, `contracts-evm/build/${CONTRACT_NAME}.abi.json`);
const BIN_PATH = resolve(ROOT, `contracts-evm/build/${CONTRACT_NAME}.bin`);

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireArtifact(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} artifact missing; run: node deploy/evm/compile.mjs ${CONTRACT_NAME}`);
  }
  return readFileSync(path, 'utf8').trim();
}

export function validateCreditsDeployConfig(env = process.env) {
  const settlerRaw = String(env.NEOX_CREDITS_V2_SETTLER || '').trim();
  if (!ethers.isAddress(settlerRaw) || ethers.getAddress(settlerRaw) === ethers.ZeroAddress) {
    throw new Error('NEOX_CREDITS_V2_SETTLER must be a non-zero EVM address');
  }

  const apply = env.DEPLOY_APPLY === '1';
  if (!apply) {
    return { apply: false, settler: ethers.getAddress(settlerRaw) };
  }

  if (env.NEOX_CREDITS_V2_MAINNET_ACK !== MAINNET_ACK) {
    throw new Error(`broadcast requires NEOX_CREDITS_V2_MAINNET_ACK=${MAINNET_ACK}`);
  }
  const rpcUrl = String(env.NEOX_RPC || '').trim();
  if (!rpcUrl) throw new Error('broadcast requires an explicit NEOX_RPC');
  const deployerKey = String(env.NEOX_DEPLOY_PK || '').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) {
    throw new Error('broadcast requires NEOX_DEPLOY_PK as a 32-byte hex key');
  }
  const confirmationsRaw = String(env.NEOX_CREDITS_V2_CONFIRMATIONS || '5');
  if (!/^[1-9][0-9]*$/.test(confirmationsRaw)) {
    throw new Error('NEOX_CREDITS_V2_CONFIRMATIONS must be a positive integer');
  }
  const confirmations = Number(confirmationsRaw);
  if (!Number.isSafeInteger(confirmations) || confirmations > 100) {
    throw new Error('NEOX_CREDITS_V2_CONFIRMATIONS must be between 1 and 100');
  }

  return {
    apply: true,
    settler: ethers.getAddress(settlerRaw),
    rpcUrl,
    deployerKey,
    confirmations,
  };
}

export function validateCreditsAbi(abi) {
  const event = abi.find((entry) => entry.type === 'event' && entry.name === 'SettlementPosted');
  const expected = [
    'epoch',
    'batchRoot',
    'windowStartExclusive',
    'windowEndInclusive',
    'userCount',
    'totalRequested',
    'totalDebited',
  ];
  if (!event || event.inputs?.map((input) => input.name).join(',') !== expected.join(',')) {
    throw new Error('SettlementPosted ABI does not match the Credits V2 proof receipt');
  }
  for (const name of [
    'buyCredits',
    'computeBatchRoot',
    'postSettlement',
    'backingLiabilityGas',
    'surplusGas',
    'rescueSurplusGas',
  ]) {
    if (!abi.some((entry) => entry.type === 'function' && entry.name === name)) {
      throw new Error(`Credits V2 ABI is missing ${name}`);
    }
  }
  for (const forbidden of ['refundCredits', 'requestExit', 'approveExit', 'claimExit']) {
    if (abi.some((entry) => entry.type === 'function' && entry.name === forbidden)) {
      throw new Error(`Credits V2 ABI must not expose ${forbidden}`);
    }
  }
}

export function loadCreditsArtifacts() {
  const abiText = requireArtifact(ABI_PATH, 'ABI');
  const bytecodeText = requireArtifact(BIN_PATH, 'bytecode');
  const abi = JSON.parse(abiText);
  validateCreditsAbi(abi);
  if (!/^[0-9a-fA-F]+$/.test(bytecodeText) || bytecodeText.length < 2_000) {
    throw new Error('MiniAppCreditsV2 bytecode artifact is invalid');
  }
  return {
    abi,
    bytecode: `0x${bytecodeText}`,
    abiSha256: sha256Hex(abiText),
    bytecodeSha256: sha256Hex(bytecodeText),
  };
}

async function assertDeployedContract(contract, expectedSettler) {
  const [chainId, rate, creditsPerGas, stateVersion, importsV1, settler] = await Promise.all([
    contract.chainId(),
    contract.GAS_WEI_PER_CREDIT(),
    contract.CREDITS_PER_GAS(),
    contract.STATE_VERSION(),
    contract.IMPORTS_V1_BALANCES(),
    contract.settler(),
  ]);
  if (chainId !== NEO_X_MAINNET_CHAIN_ID) throw new Error('deployed contract chain id mismatch');
  if (rate !== GAS_WEI_PER_CREDIT) throw new Error('deployed contract base-unit rate mismatch');
  if (creditsPerGas !== CREDITS_PER_GAS) throw new Error('deployed contract GAS rate mismatch');
  if (stateVersion !== 2n || importsV1 !== false) {
    throw new Error('deployed contract is not a fresh Credits V2 state');
  }
  if (ethers.getAddress(settler) !== expectedSettler) {
    throw new Error('deployed contract settler mismatch');
  }
}

export async function main(env = process.env) {
  const config = validateCreditsDeployConfig(env);
  const artifacts = loadCreditsArtifacts();
  console.log(`contract ${CONTRACT_NAME}`);
  console.log(`target neo-x-mainnet chainId=${NEO_X_MAINNET_CHAIN_ID}`);
  console.log(`settler ${config.settler}`);
  console.log(`rate ${GAS_WEI_PER_CREDIT} wei/credit (${CREDITS_PER_GAS} credits/GAS)`);
  console.log(`abi sha256 ${artifacts.abiSha256}`);
  console.log(`bytecode sha256 ${artifacts.bytecodeSha256}`);

  if (!config.apply) {
    console.log(
      'DRY RUN ONLY — no RPC connection, key access, broadcast, or production enablement.'
    );
    return null;
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== NEO_X_MAINNET_CHAIN_ID) {
    throw new Error(`RPC chain mismatch: expected 47763, received ${network.chainId}`);
  }

  const wallet = new ethers.Wallet(config.deployerKey, provider);
  const factory = new ethers.ContractFactory(artifacts.abi, artifacts.bytecode, wallet);
  const contract = await factory.deploy(config.settler);
  const deploymentTx = contract.deploymentTransaction();
  if (!deploymentTx) throw new Error('deployment transaction unavailable');
  const receipt = await deploymentTx.wait(config.confirmations);
  if (!receipt || receipt.status !== 1) throw new Error('deployment transaction did not succeed');

  const address = await contract.getAddress();
  const runtimeCode = await provider.getCode(address, receipt.blockNumber);
  if (runtimeCode === '0x') throw new Error('deployed runtime code is empty');
  await assertDeployedContract(contract, config.settler);

  const record = {
    schema: 'neoos.credits-v2-deployment/v1',
    productionEnabled: false,
    contract: CONTRACT_NAME,
    network: 'neo-x-mainnet',
    chainId: NEO_X_MAINNET_CHAIN_ID.toString(),
    address,
    deployTx: receipt.hash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    transactionIndex: receipt.index,
    receiptStatus: receipt.status,
    gasUsed: receipt.gasUsed.toString(),
    deployer: wallet.address,
    settler: config.settler,
    confirmations: config.confirmations,
    abiSha256: artifacts.abiSha256,
    bytecodeSha256: artifacts.bytecodeSha256,
    runtimeCodeSha256: sha256Hex(runtimeCode),
    deployedAt: new Date().toISOString(),
  };
  const recordPath = resolve(ROOT, `contracts-evm/build/${CONTRACT_NAME}.neox-mainnet.json`);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  console.log(`deployment receipt written to ${recordPath}`);
  console.log('Production remains disabled; registry activation is a separate reviewed operation.');
  return record;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
