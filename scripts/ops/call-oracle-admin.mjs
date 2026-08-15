#!/usr/bin/env node
/**
 * Call setUpdater and setOracleVerificationPublicKey on the MorpheusOracle contract
 * using the CVM's derived worker key (on-chain admin) via sign/payload endpoint.
 *
 * Usage:
 *   node scripts/ops/call-oracle-admin.mjs --network mainnet|testnet [--dry-run|--apply]
 */

import neon from '@cityofzion/neon-js';
import crypto from 'crypto';
import { parseArgs } from 'node:util';

const { values: flags } = parseArgs({
  options: {
    network: { type: 'string' },
    apply: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (flags.apply && flags['dry-run']) {
  throw new Error('--apply and --dry-run are mutually exclusive');
}

const NETWORK = String(flags.network || process.env.MORPHEUS_NETWORK || 'testnet').trim();
if (NETWORK !== 'mainnet' && NETWORK !== 'testnet') {
  throw new Error('--network must be mainnet or testnet');
}
if (flags.apply && !flags.network) {
  throw new Error('--apply requires an explicit --network mainnet|testnet');
}
const ENV_SUFFIX = NETWORK.toUpperCase();
const APPLY = flags.apply === true;
const DRY_RUN = !APPLY;

const CVM_URL =
  process.env[`NITRO_RUNTIME_URL_${ENV_SUFFIX}`] ||
  process.env[`MORPHEUS_RUNTIME_URL_${ENV_SUFFIX}`] ||
  process.env.NITRO_RUNTIME_URL ||
  process.env.MORPHEUS_RUNTIME_URL ||
  '';
const AUTH_TOKEN =
  process.env[`NITRO_API_TOKEN_${ENV_SUFFIX}`] ||
  process.env[`MORPHEUS_RUNTIME_TOKEN_${ENV_SUFFIX}`] ||
  process.env.NITRO_API_TOKEN ||
  process.env.MORPHEUS_RUNTIME_TOKEN ||
  '';
const ORACLE_CONTRACT =
  process.env[`CONTRACT_MORPHEUS_ORACLE_HASH_${ENV_SUFFIX}`] ||
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH ||
  process.env.ORACLE_CONTRACT ||
  '';
const RPC_URL = process.env[`NEO_RPC_URL_${ENV_SUFFIX}`] || process.env.NEO_RPC_URL || '';
const NETWORK_MAGIC = Number(
  process.env[`NEO_NETWORK_MAGIC_${ENV_SUFFIX}`] ||
    process.env.NEO_NETWORK_MAGIC ||
    (NETWORK === 'mainnet' ? 860833102 : 894710606)
);
const ADMIN_ADDRESS = process.env.NEO_ADMIN_ADDRESS || '';
const NEW_UPDATER = process.env.MORPHEUS_ORACLE_NEW_UPDATER || '';
const NEW_VERIFIER_PUBKEY = process.env.MORPHEUS_ORACLE_NEW_VERIFIER_PUBKEY || '';

if (!NEW_UPDATER || !NEW_VERIFIER_PUBKEY) {
  throw new Error(
    'explicit MORPHEUS_ORACLE_NEW_UPDATER and MORPHEUS_ORACLE_NEW_VERIFIER_PUBKEY are required'
  );
}
if (!/^0x[0-9a-f]{40}$/i.test(NEW_UPDATER)) {
  throw new Error('MORPHEUS_ORACLE_NEW_UPDATER must be a 20-byte 0x-prefixed script hash');
}
if (!/^(02|03)[0-9a-f]{64}$/i.test(NEW_VERIFIER_PUBKEY)) {
  throw new Error('MORPHEUS_ORACLE_NEW_VERIFIER_PUBKEY must be a compressed public key');
}
if (!/^0x[0-9a-f]{40}$/i.test(ORACLE_CONTRACT)) {
  throw new Error('an explicit ORACLE_CONTRACT or CONTRACT_MORPHEUS_ORACLE_HASH is required');
}
if (!CVM_URL || !RPC_URL || !ADMIN_ADDRESS) {
  throw new Error('explicit runtime URL, NEO_RPC_URL, and NEO_ADMIN_ADDRESS are required');
}
if (!AUTH_TOKEN) {
  throw new Error('a Nitro/Morpheus runtime token is required');
}
if (!Number.isSafeInteger(NETWORK_MAGIC) || NETWORK_MAGIC <= 0) {
  throw new Error('NEO_NETWORK_MAGIC must be a positive integer');
}
if (APPLY) {
  for (const [label, value] of [
    ['runtime URL', CVM_URL],
    ['RPC URL', RPC_URL],
  ]) {
    if (new URL(value).protocol !== 'https:') {
      throw new Error(`${label} must use HTTPS in --apply mode`);
    }
  }
}

async function signWithDerivedKey(dataHex) {
  const resp = await fetch(`${CVM_URL}/sign/payload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Morpheus-Network': NETWORK,
    },
    body: JSON.stringify({
      target_chain: 'neo_n3',
      data_hex: dataHex,
      use_derived_keys: true,
      dstack_key_role: 'worker',
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`sign/payload failed: ${resp.status} ${body}`);
  }
  return resp.json();
}

async function broadcastRawTx(signedTxBase64) {
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'sendrawtransaction',
      params: [signedTxBase64],
      id: 1,
    }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function buildAndSignTx(method, args) {
  const { sc, tx, wallet, u, rpc } = neon;

  // Build script using createScript
  const script = sc.createScript({
    scriptHash: ORACLE_CONTRACT.replace('0x', ''),
    operation: method,
    args: args,
  });

  console.log(`  Script: ${script.toString().substring(0, 60)}...`);

  const rpcClient = new rpc.RPCClient(RPC_URL);
  const blockCount = await rpcClient.getBlockCount();

  // Create transaction
  const signerHash = wallet.getScriptHashFromAddress(ADMIN_ADDRESS);
  const t = new tx.Transaction({
    version: 0,
    nonce: Math.floor(Math.random() * 2 ** 32),
    systemFee: 200000000, // 2 GAS default
    networkFee: 100000000, // 1 GAS default
    validUntilBlock: blockCount + 100,
    script: u.HexString.fromHex(script),
    signers: [
      {
        account: u.HexString.fromHex(signerHash),
        scopes: tx.WitnessScope.CalledByEntry,
      },
    ],
    attributes: [],
    witnesses: [],
  });

  // Estimate fees using testInvoke
  try {
    const result = await rpcClient.invokeScript(u.HexString.fromHex(script), [
      { account: signerHash, scopes: 'CalledByEntry' },
    ]);
    if (result.state === 'FAULT') {
      throw new Error(`VM FAULT: ${result.exception}`);
    }
    console.log(`  VM state: ${result.state}`);
    const gasConsumed = parseInt(result.gas_consumed || '0');
    t.systemFee = new neon.u.BigInteger(Math.max(gasConsumed * 2, 200000000));
  } catch (e) {
    console.log(`  Warning: testInvoke failed: ${e.message}, using default fees`);
  }

  // Serialize transaction (without witnesses) for signing
  const txHex = t.serialize(false);
  const txBytes = Buffer.from(txHex, 'hex');

  // Compute signing message: magic_LE + SHA256(tx_bytes)_BE
  const txHash = crypto.createHash('sha256').update(txBytes).digest();
  const magicBytes = Buffer.alloc(4);
  magicBytes.writeUInt32LE(NETWORK_MAGIC);
  const signingMessage = Buffer.concat([magicBytes, txHash]);
  const signingMessageHex = signingMessage.toString('hex');
  console.log(`  Transaction hash: ${txHash.toString('hex')}`);

  // Sign with derived key
  const signResult = await signWithDerivedKey(signingMessageHex);
  console.log(`  Signed by: ${signResult.address}`);
  console.log(`  Public key: ${signResult.public_key}`);

  // Build witness
  const invocationScript = buildInvocationScript(signResult.signature);
  const verificationScript = buildVerificationScript(signResult.public_key);

  t.witnesses = [
    new tx.Witness({
      invocationScript: u.HexString.fromHex(invocationScript),
      verificationScript: u.HexString.fromHex(verificationScript),
    }),
  ];

  // Serialize signed transaction
  const signedHex = t.serialize(true);
  return Buffer.from(signedHex, 'hex').toString('base64');
}

function buildInvocationScript(signature) {
  // PUSH signature (64 bytes)
  const sigBytes = Buffer.from(signature, 'hex');
  return `0c40${sigBytes.toString('hex')}`;
}

function buildVerificationScript(publicKey) {
  // PUSH public key (33 bytes) + SYSCALL System.Crypto.CheckSig
  const pubBytes = Buffer.from(publicKey, 'hex');
  return `0c21${pubBytes.toString('hex')}4156e7b327`;
}

async function main() {
  console.log('=== Oracle Admin Key Rotation ===\n');
  console.log(`Network: ${NETWORK}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no broadcast)' : 'APPLY'}\n`);

  // Step 1: Call setUpdater
  console.log('Step 1: Calling setUpdater...');
  console.log(`  New updater: ${NEW_UPDATER}`);
  const updaterTx = await buildAndSignTx('setUpdater', [
    neon.sc.ContractParam.hash160(NEW_UPDATER),
  ]);
  console.log(`  Signed transaction (base64): ${updaterTx.substring(0, 40)}...`);

  if (DRY_RUN) {
    console.log('  [DRY RUN] Skipping broadcast');
  } else {
    console.log('  Broadcasting...');
    const result = await broadcastRawTx(updaterTx);
    console.log(`  Result: ${JSON.stringify(result)}`);
  }

  console.log('');

  // Step 2: Call setOracleVerificationPublicKey
  console.log('Step 2: Calling setOracleVerificationPublicKey...');
  console.log(`  New verifier: ${NEW_VERIFIER_PUBKEY}`);
  const verifierTx = await buildAndSignTx('setOracleVerificationPublicKey', [
    neon.sc.ContractParam.publicKey(NEW_VERIFIER_PUBKEY),
  ]);
  console.log(`  Signed transaction (base64): ${verifierTx.substring(0, 40)}...`);

  if (DRY_RUN) {
    console.log('  [DRY RUN] Skipping broadcast');
  } else {
    console.log('  Broadcasting...');
    const result = await broadcastRawTx(verifierTx);
    console.log(`  Result: ${JSON.stringify(result)}`);
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
