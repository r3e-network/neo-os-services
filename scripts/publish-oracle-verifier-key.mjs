import { experimental, sc, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from './lib-env.mjs';
import {
  normalizeMorpheusNetwork,
  resolvePinnedNeoN3VerifierPublicKey,
} from './lib-neo-signers.mjs';
import {
  assertOracleKeyTimelockAbi,
  readOracleContractState,
  resolveOracleAdminWif,
} from './lib-oracle-timelock.mjs';

async function main() {
  const requestedNetwork = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'testnet');
  await loadDotEnv();
  const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || requestedNetwork);
  await loadDotEnv(new URL(`../deploy/nitro/morpheus.${network}.env`, import.meta.url), {
    override: true,
  });
  const nitroUrl = (
    process.env[`MORPHEUS_${network.toUpperCase()}_RUNTIME_URL`] ||
    process.env.MORPHEUS_RUNTIME_URL ||
    process.env.NITRO_RUNTIME_URL ||
    process.env.NITRO_API_URL ||
    ''
  ).replace(/\/$/, '');
  const nitroToken = process.env.MORPHEUS_RUNTIME_TOKEN || process.env.NITRO_API_TOKEN || '';
  const rpcUrl =
    process.env.NEO_RPC_URL ||
    (network === 'mainnet' ? 'https://api.n3index.dev/mainnet' : 'https://api.n3index.dev/testnet');
  const networkMagic = Number(
    process.env.NEO_NETWORK_MAGIC || (network === 'mainnet' ? 860833102 : 894710606)
  );
  const oracleHash = process.env.CONTRACT_MORPHEUS_ORACLE_HASH || '';
  const wif = resolveOracleAdminWif(process.env);

  if (!nitroUrl || !oracleHash || !wif) {
    throw new Error(
      'MORPHEUS_RUNTIME_URL, CONTRACT_MORPHEUS_ORACLE_HASH, and the kernel admin key are required'
    );
  }

  assertOracleKeyTimelockAbi(await readOracleContractState(rpcUrl, oracleHash), 'verification');

  const headers = nitroToken ? { authorization: `Bearer ${nitroToken}` } : {};
  let publicKey = resolvePinnedNeoN3VerifierPublicKey(network, process.env);
  if (!publicKey) {
    const res = await fetch(`${nitroUrl}/keys/derived?role=worker`, { headers });
    if (!res.ok) throw new Error(`failed to fetch derived keys: ${res.status}`);
    const body = await res.json();
    publicKey = body?.derived?.neo_n3?.public_key || body?.neo_n3?.public_key || '';
  }
  if (!publicKey) throw new Error('worker neo_n3 public key missing');

  const account = new wallet.Account(wif);
  const contract = new experimental.SmartContract(oracleHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });

  // P0-07 governance timelock: proposeRuntimeVerificationPublicKey records the
  // change; it takes effect when executeRuntimeVerificationPublicKey is invoked
  // after the 24h delay. Run this script again with MODE=execute to finalize.
  const mode = (process.env.MODE || 'propose').toLowerCase();
  if (mode === 'execute') {
    console.log('Executing matured verifier-key change...');
    const txHash = await contract.invoke('executeRuntimeVerificationPublicKey', []);
    console.log(`executeRuntimeVerificationPublicKey tx: ${txHash}`);
    return;
  }

  console.log('Proposing NeoOS Oracle verifier public key (24h timelock)...');
  const txHash = await contract.invoke('proposeRuntimeVerificationPublicKey', [
    sc.ContractParam.publicKey(publicKey),
  ]);
  console.log(`proposeRuntimeVerificationPublicKey tx: ${txHash}`);
  console.log('NOT LIVE YET: re-run with MODE=execute after the 24h timelock matures.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
