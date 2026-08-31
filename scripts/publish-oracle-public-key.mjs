import { experimental, sc, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from './lib-env.mjs';
import { normalizeMorpheusNetwork, resolvePinnedNeoN3Role } from './lib-neo-signers.mjs';

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
  // setOracleEncryptionKey -> SetRuntimeEncryptionKey is gated by ValidateAdmin(), so it
  // MUST be signed by the kernel ADMIN witness, not the updater. Prefer an explicit admin
  // WIF; fall back to the pinned updater role only for deployments where updater == admin.
  let wif = (process.env.MORPHEUS_ORACLE_ADMIN_WIF || process.env.NEO_N3_ADMIN_WIF || '').trim();
  if (!wif) {
    const signer = resolvePinnedNeoN3Role(network, 'updater', { env: process.env });
    wif = signer.materialized?.wif || signer.materialized?.private_key || '';
  }

  if (!nitroUrl || !oracleHash || !wif) {
    throw new Error(
      'MORPHEUS_RUNTIME_URL, CONTRACT_MORPHEUS_ORACLE_HASH, and the kernel admin key (MORPHEUS_ORACLE_ADMIN_WIF) are required'
    );
  }

  const headers = nitroToken ? { authorization: `Bearer ${nitroToken}` } : {};
  const res = await fetch(`${nitroUrl}/oracle/public-key`, { headers });
  if (!res.ok) throw new Error(`failed to fetch oracle public key: ${res.status}`);
  const key = await res.json();

  const account = new wallet.Account(wif);
  const contract = new experimental.SmartContract(oracleHash, {
    rpcAddress: rpcUrl,
    networkMagic,
    account,
  });

  // P0-07 governance timelock: the set* aliases now PROPOSE only. The key
  // takes effect when executeRuntimeEncryptionKey is invoked after the 24h
  // delay. Run this script again with MODE=execute to finalize.
  const mode = (process.env.MODE || 'propose').toLowerCase();
  if (mode === 'execute') {
    console.log('Executing matured encryption-key change...');
    const txHash = await contract.invoke('executeRuntimeEncryptionKey', []);
    console.log(`executeRuntimeEncryptionKey tx: ${txHash}`);
    return;
  }

  console.log('Proposing NeoOS Oracle public key (24h timelock)...');
  const txHash = await contract.invoke('setOracleEncryptionKey', [
    sc.ContractParam.string(key.algorithm),
    sc.ContractParam.string(key.public_key),
  ]);
  console.log(`setOracleEncryptionKey (PROPOSE) tx: ${txHash}`);
  console.log('NOT LIVE YET: re-run with MODE=execute after the 24h timelock matures.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
