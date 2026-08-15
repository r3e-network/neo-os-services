import { trimString } from './lib-strings.mjs';
import { experimental, rpc as neoRpc, sc, wallet } from '@cityofzion/neon-js';
import { loadDotEnv } from './lib-env.mjs';
import { normalizeMorpheusNetwork, resolvePinnedNeoN3Role } from './lib-neo-signers.mjs';

const requestedNetwork = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || 'testnet');
await loadDotEnv();
const network = normalizeMorpheusNetwork(process.env.MORPHEUS_NETWORK || requestedNetwork);
await loadDotEnv(new URL(`../deploy/nitro/morpheus.${network}.env`, import.meta.url), {
  override: true,
});

const rpcAddress = trimString(
  process.env.NEO_RPC_URL ||
    (network === 'mainnet' ? 'https://api.n3index.dev/mainnet' : 'https://api.n3index.dev/testnet')
);
const networkMagic = Number(
  process.env.NEO_NETWORK_MAGIC || (network === 'mainnet' ? 860833102 : 894710606)
);
const oracleHash = trimString(process.env.CONTRACT_MORPHEUS_ORACLE_HASH || '');
const updaterHash = trimString(process.env.MORPHEUS_UPDATER_HASH || '');

if (!oracleHash) throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH is required');
if (!updaterHash) throw new Error('MORPHEUS_UPDATER_HASH is required');

const signer = resolvePinnedNeoN3Role(network, 'updater', { env: process.env });
const account = new wallet.Account(
  signer.materialized?.wif || signer.materialized?.private_key || ''
);
const oracle = new experimental.SmartContract(oracleHash, {
  rpcAddress,
  networkMagic,
  account,
});
const rpcClient = new neoRpc.RPCClient(rpcAddress);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(txid, timeoutMs = 120000) {
  const normalized = String(txid).startsWith('0x') ? String(txid) : `0x${txid}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const log = await rpcClient.getApplicationLog(normalized);
      const execution = log?.executions?.[0];
      if (execution) {
        return {
          txid: normalized,
          vmstate: execution.vmstate,
          exception: execution.exception || null,
        };
      }
    } catch {}
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${normalized}`);
}

const txid = await oracle.invoke('setUpdater', [sc.ContractParam.hash160(updaterHash)]);
const result = await waitFor(txid);

console.log(
  JSON.stringify(
    {
      network,
      rpc: rpcAddress,
      oracle_hash: oracleHash,
      updater_hash: updaterHash,
      signer_address: account.address,
      txid: result.txid,
      vmstate: result.vmstate,
      exception: result.exception,
    },
    null,
    2
  )
);

if (result.vmstate !== 'HALT') {
  process.exitCode = 1;
}
