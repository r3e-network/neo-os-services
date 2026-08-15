import { trimString } from './lib-strings.mjs';
import { wallet } from '@cityofzion/neon-js';

const CVM_URL =
  process.env.NITRO_RUNTIME_URL ||
  process.env.MORPHEUS_RUNTIME_URL ||
  process.env.NITRO_API_URL ||
  'https://oracle.meshmini.app/mainnet';
const CVM_TOKEN = process.env.NITRO_API_TOKEN || process.env.MORPHEUS_RUNTIME_TOKEN || '';
const RPC_URL = process.env.NEO_RPC_URL || 'https://api.n3index.dev/mainnet';
const ORACLE_HASH =
  process.env.CONTRACT_MORPHEUS_ORACLE_HASH || '0xf54d8584ef82315c1800373272ab08ae0db2d5ef';

async function cvmPost(path, body) {
  const url = `${CVM_URL.replace(/\/$/, '')}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (CVM_TOKEN) headers['Authorization'] = `Bearer ${CVM_TOKEN}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`CVM ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const targetAdmin = trimString(process.env.TARGET_ADMIN_ADDRESS || '');
  const newUpdaterHash = trimString(process.env.NEW_UPDATER_HASH || '');
  const newVerifierPubKey = trimString(process.env.NEW_VERIFIER_PUBLIC_KEY || '');

  // Step 1: Query CVM for the current admin key
  console.log('=== Step 1: Query CVM derived keys ===');
  const roles = ['worker', 'updater'];

  for (const role of roles) {
    try {
      const result = await cvmPost('/keys/derived', { role });
      const neo = result?.derived?.neo_n3;
      if (neo) {
        console.log(`  ${role}: ${neo.address} (script_hash: ${neo.script_hash})`);
        if (targetAdmin && neo.address === targetAdmin) {
          console.log(`  ^ MATCHES target admin!`);
          // The CVM doesn't return private keys via /keys/derived
          // We need to use the CVM's /sign endpoint instead
        }
      }
    } catch (err) {
      console.log(`  ${role}: FAILED - ${err.message}`);
    }
  }

  // Step 2: Check current on-chain state
  console.log('\n=== Step 2: Current on-chain state ===');
  const { rpc: neoRpc } = await import('@cityofzion/neon-js');
  const rpcClient = new neoRpc.RPCClient(RPC_URL);

  const [adminRes, updaterRes, verifierRes] = await Promise.all([
    rpcClient.invokeFunction(ORACLE_HASH, 'admin', []),
    rpcClient.invokeFunction(ORACLE_HASH, 'updater', []),
    rpcClient.invokeFunction(ORACLE_HASH, 'oracleVerificationPublicKey', []),
  ]);

  const adminHash = Buffer.from(adminRes.stack[0].value, 'base64').toString('hex');
  const updaterHashCurrent = Buffer.from(updaterRes.stack[0].value, 'base64').toString('hex');
  const verifierPubKeyRaw = verifierRes.stack[0].value;

  console.log(`  Admin: ${wallet.getAddressFromScriptHash(adminHash)} (0x${adminHash})`);
  console.log(
    `  Updater: ${wallet.getAddressFromScriptHash(updaterHashCurrent)} (0x${updaterHashCurrent})`
  );
  console.log(`  Verifier pubkey (raw): ${verifierPubKeyRaw}`);

  if (!newUpdaterHash && !newVerifierPubKey) {
    console.log('\nNo NEW_UPDATER_HASH or NEW_VERIFIER_PUBLIC_KEY set. Dry run complete.');
    return;
  }

  // Step 3: If the admin key matches the CVM-derived key, use the CVM to sign
  // Since the CVM doesn't expose private keys, we need to use its sign endpoint
  // OR we need the private key directly

  // For now, try to use the CVM's smart contract invocation endpoint
  console.log('\n=== Step 3: Attempting on-chain updates via CVM ===');

  if (newUpdaterHash) {
    console.log(`\nSetting updater to ${newUpdaterHash}...`);
    try {
      const result = await cvmPost('/invoke', {
        contract: ORACLE_HASH,
        method: 'setUpdater',
        params: [{ type: 'hash160', value: newUpdaterHash }],
      });
      console.log(`  Result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`  CVM invoke failed: ${err.message}`);
      console.log(
        '  The CVM may not support direct invocation. Need to use the admin private key.'
      );
    }
  }

  if (newVerifierPubKey) {
    console.log(`\nSetting verifier pubkey to ${newVerifierPubKey}...`);
    try {
      const result = await cvmPost('/invoke', {
        contract: ORACLE_HASH,
        method: 'setOracleVerificationPublicKey',
        params: [{ type: 'publickey', value: newVerifierPubKey }],
      });
      console.log(`  Result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.log(`  CVM invoke failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
