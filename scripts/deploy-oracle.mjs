#!/usr/bin/env node
/**
 * Deploy MorpheusOracle contract to Neo N3 mainnet.
 * The deployer becomes the admin (per _deploy: Admin = tx.Sender).
 *
 * Signs via CVM's /sign/payload (derived worker key).
 * Broadcasts directly to Neo RPC (no relay endpoint needed).
 *
 * Usage:
 *   node scripts/deploy-oracle.mjs [--dry-run]
 */

import neon from '@cityofzion/neon-js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CVM_URL =
  process.env.NITRO_RUNTIME_URL ||
  process.env.MORPHEUS_RUNTIME_URL ||
  'https://oracle.meshmini.app/mainnet';
const AUTH_TOKEN = process.env.NITRO_API_TOKEN || process.env.MORPHEUS_RUNTIME_TOKEN || '';
const RPC_URL = process.env.NEO_RPC_URL || 'https://api.n3index.dev/mainnet';
const NETWORK_MAGIC = parseInt(process.env.NEO_NETWORK_MAGIC || '860833102');

// ContractManagement native contract hash
const CONTRACT_MANAGEMENT = 'fffdc93764dbaddd97c48f252a53ea4643faa3fd';

const DRY_RUN = process.argv.includes('--dry-run');

if (!AUTH_TOKEN) {
  console.error(
    'ERROR: NITRO_API_TOKEN or MORPHEUS_RUNTIME_TOKEN environment variable is required'
  );
  process.exit(1);
}

async function rpcCall(method, params = []) {
  const resp = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function signWithDerivedKey(dataHex, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(`${CVM_URL}/sign/payload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Morpheus-Network': 'mainnet',
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
    } catch (e) {
      if (i < retries - 1) {
        console.log(`  Retry ${i + 1}/${retries} after error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
}

function buildInvocationScript(signature) {
  const sigBytes = Buffer.from(signature, 'hex');
  return `0c40${sigBytes.toString('hex')}`;
}

function buildVerificationScript(publicKey) {
  const pubBytes = Buffer.from(publicKey, 'hex');
  return `0c21${pubBytes.toString('hex')}4156e7b327`;
}

async function main() {
  console.log('=== Deploy MorpheusOracle Contract ===\n');

  // Load contract artifacts
  const nefPath = path.join(__dirname, '..', 'contracts', 'build', 'MorpheusOracle.nef');
  const manifestPath = path.join(
    __dirname,
    '..',
    'contracts',
    'build',
    'MorpheusOracle.manifest.json'
  );

  const nefBytes = fs.readFileSync(nefPath);
  const manifestJson = fs.readFileSync(manifestPath, 'utf8');

  console.log(`NEF file: ${nefBytes.length} bytes`);
  console.log(`Manifest: ${manifestJson.length} bytes`);

  // Validate NEF magic
  const nefMagic = nefBytes.readUInt32LE(0);
  if (nefMagic !== 0x3346454e) {
    throw new Error(`Invalid NEF magic: 0x${nefMagic.toString(16)}`);
  }
  console.log(`NEF magic: 0x${nefMagic.toString(16)} (valid)`);

  // Build the deploy script: ContractManagement.deploy(nef, manifest)
  // ContractManagement.deploy expects the FULL NEF file bytes (including header)
  const { sc, tx, wallet, u } = neon;

  const script = sc.createScript({
    scriptHash: CONTRACT_MANAGEMENT,
    operation: 'deploy',
    args: [
      sc.ContractParam.byteArray(nefBytes.toString('base64')),
      sc.ContractParam.string(manifestJson),
    ],
  });

  console.log(`\nDeploy script: ${script.toString().substring(0, 80)}...`);

  // Get block count for validUntilBlock
  const blockCount = await rpcCall('getblockcount');
  console.log(`Block count: ${blockCount}`);

  // Deployer = derived worker key
  const deployerAddress = 'NUVmRwZDoSZMKcPj9UCQLHkpno2TPqYVxC';
  const signerHash = wallet.getScriptHashFromAddress(deployerAddress);
  console.log(`Deployer: ${deployerAddress} (${signerHash})`);

  // Create transaction
  const t = new tx.Transaction({
    version: 0,
    nonce: Math.floor(Math.random() * 2 ** 32),
    systemFee: 200000000, // 2 GAS for contract deployment
    networkFee: '50000000', // 0.5 GAS
    validUntilBlock: blockCount + 1000,
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
    const result = await rpcCall('invokefunction', [
      CONTRACT_MANAGEMENT,
      'deploy',
      [
        { type: 'ByteArray', value: nefBytes.toString('base64') },
        { type: 'String', value: manifestJson },
      ],
      [{ account: signerHash, scopes: 'CalledByEntry' }],
    ]);
    if (result.state === 'FAULT') {
      console.log(`  Warning: testInvoke FAULT: ${result.exception}`);
      console.log(`  Proceeding with default fees (contract deployment may still succeed)`);
    } else {
      console.log(`  VM state: ${result.state}`);
      const gasConsumed = parseInt(result.gas_consumed || '0');
      console.log(`  Gas consumed: ${gasConsumed / 100000000} GAS`);
    }
  } catch (e) {
    console.log(`  Warning: testInvoke failed: ${e.message}, using default fees`);
  }
  // Use 15 GAS system fee for contract deployment (actual cost ~10 GAS)
  t.systemFee = new u.BigInteger(1500000000);
  console.log(`  System fee: ${Number(t.systemFee) / 100000000} GAS`);

  // Serialize transaction (without witnesses) for signing
  const txHex = t.serialize(false);
  const txBytes = Buffer.from(txHex, 'hex');

  // Neo N3 signing message: network_magic (4 bytes LE) + SHA256(tx_bytes) in big-endian
  // neon-js getMessageForSigning = num2hexstring(magic, 4, true) + reverseHex(hash())
  // where hash() returns LE, so reverseHex gives BE. We use BE directly.
  const txHash = crypto.createHash('sha256').update(txBytes).digest(); // big-endian
  const magicBytes = Buffer.alloc(4);
  magicBytes.writeUInt32LE(NETWORK_MAGIC);
  const signingMessage = Buffer.concat([magicBytes, txHash]);
  const signingMessageHex = signingMessage.toString('hex');
  console.log(`\nTransaction hash: ${txHash.toString('hex')}`);
  console.log(`Signing message: ${signingMessageHex}`);

  // Sign with derived key
  console.log('Signing with derived worker key...');
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
  const signedBase64 = Buffer.from(signedHex, 'hex').toString('base64');
  console.log(`\nSigned transaction (base64): ${signedBase64.substring(0, 40)}...`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Skipping broadcast');
    console.log(`\nTo broadcast manually:`);
    console.log(
      `  curl -X POST "${RPC_URL}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"sendrawtransaction","params":["${signedBase64}"],"id":1}'`
    );
    return;
  }

  // Broadcast directly to Neo RPC (sendrawtransaction expects base64)
  console.log('\nBroadcasting to Neo RPC...');
  const broadcastResult = await rpcCall('sendrawtransaction', [signedBase64]);
  console.log(`\nBroadcast result: ${JSON.stringify(broadcastResult)}`);

  // Wait for the transaction to be processed and find the new contract hash
  const fullTxHash =
    '0x' + crypto.createHash('sha256').update(Buffer.from(signedHex, 'hex')).digest('hex');
  console.log(`\nTX hash: ${fullTxHash}`);
  console.log('Waiting for transaction to be processed (up to 60s)...');

  const start = Date.now();
  let contractHash = null;
  while (Date.now() - start < 60000) {
    try {
      const appLog = await rpcCall('getapplicationlog', [fullTxHash]);
      if (appLog && appLog.executions && appLog.executions.length > 0) {
        console.log(`\nTransaction processed! VM state: ${appLog.executions[0].vmstate}`);
        const notifications = appLog.executions[0].notifications || [];
        for (const n of notifications) {
          console.log(`  Event: ${n.eventname} on ${n.contract}`);
          if (n.state && n.state.value) {
            const items = Array.isArray(n.state.value) ? n.state.value : [n.state.value];
            for (const item of items) {
              if (item.type === 'ByteString' && item.value) {
                const bytes = Buffer.from(item.value, 'base64');
                if (bytes.length === 20) {
                  contractHash = '0x' + bytes.toString('hex');
                  console.log(`  Found hash: ${contractHash}`);
                }
              }
            }
          }
        }
        break;
      }
    } catch {
      // Not found yet
    }
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write('.');
  }

  if (contractHash) {
    console.log(`\n\nNew oracle contract hash: ${contractHash}`);
    console.log(`\nUpdate these files with the new hash:`);
    console.log(`  1. config/networks/mainnet.json`);
    console.log(`  2. apps/web/public/morpheus-runtime-catalog.json`);
    console.log(`  3. examples/deployments/mainnet.json`);
    console.log(`  4. .env.production.example`);
    console.log(`  5. deploy/nitro/morpheus.env.example`);
    console.log(`  6. apps/web/lib/docs-data.ts`);
    console.log(`  7. docs/USER_GUIDE.md, docs/ASYNC_PRIVACY_ORACLE_SPEC.md`);
    console.log(`  8. MAINNET_RUNTIME_CONFIG_JSON in morpheus.hub.env`);
  } else {
    console.log('\n\nCould not determine contract hash from app log.');
    console.log('Check the transaction on a block explorer for the new contract hash.');
  }

  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
