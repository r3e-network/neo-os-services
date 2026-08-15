import { experimental, sc, wallet } from '@cityofzion/neon-js';

const RPC_URL = process.env.NEO_RPC_URL || '';
const NETWORK_MAGIC = Number(process.env.NEO_NETWORK_MAGIC || 0);
const GAS_HASH = '0xd2a4cff31913016155e38e474a2c06d08be276cf';
const ADMIN_WIF = process.env.NEO_ADMIN_WIF || process.env.ADMIN_WIF || '';
const ALLOW_MAINNET_FUNDING = process.env.ALLOW_MAINNET_FUNDING === '1';
const MAINNET_MAGIC = 860833102;

const RECIPIENTS = [
  { label: 'Relayer', address: 'NMGtkqaWSCTxuuMx9Zx8HT7HzHNnve8uLf' },
  { label: 'Updater', address: 'NhPYsstBAzuecqYyg8JwSDnB6Et35fw73r' },
  { label: 'Verifier', address: 'NRFGK3vj9yz3hvx9QGmVL7tEZSbmWLH8v7' },
];

const AMOUNT_UNITS = '500000000'; // 5 GAS (8 decimals)

async function main() {
  if (!RPC_URL) {
    throw new Error('NEO_RPC_URL is required');
  }
  if (!NETWORK_MAGIC) {
    throw new Error('NEO_NETWORK_MAGIC is required');
  }
  if (!ADMIN_WIF) {
    throw new Error('NEO_ADMIN_WIF is required');
  }
  if ((NETWORK_MAGIC === MAINNET_MAGIC || RPC_URL.includes('mainnet')) && !ALLOW_MAINNET_FUNDING) {
    throw new Error('Refusing mainnet funding without ALLOW_MAINNET_FUNDING=1');
  }

  const admin = new wallet.Account(ADMIN_WIF);
  console.log(`Admin: ${admin.address} (scriptHash: 0x${admin.scriptHash})`);

  // Check admin balance first
  const { rpc: neoRpc } = await import('@cityofzion/neon-js');
  const rpcClient = new neoRpc.RPCClient(RPC_URL);
  const balanceResponse = await rpcClient.invokeFunction(GAS_HASH, 'balanceOf', [
    sc.ContractParam.hash160(`0x${admin.scriptHash}`),
  ]);
  const adminBalance = balanceResponse.stack?.[0]?.value || '0';
  const adminBalanceGas = Number(adminBalance) / 1e8;
  console.log(`Admin GAS balance: ${adminBalanceGas} GAS (${adminBalance} units)`);

  const totalNeeded = RECIPIENTS.length * 5;
  if (adminBalanceGas < totalNeeded) {
    console.error(`Insufficient balance: need ${totalNeeded} GAS but have ${adminBalanceGas}`);
    process.exit(1);
  }

  const gas = new experimental.SmartContract(GAS_HASH, {
    rpcAddress: RPC_URL,
    networkMagic: NETWORK_MAGIC,
    account: admin,
  });

  for (const recipient of RECIPIENTS) {
    console.log(`\nSending 5 GAS to ${recipient.label} (${recipient.address})...`);
    try {
      const txHash = await gas.invoke('transfer', [
        sc.ContractParam.hash160(`0x${admin.scriptHash}`),
        sc.ContractParam.hash160(`0x${wallet.getScriptHashFromAddress(recipient.address)}`),
        sc.ContractParam.integer(AMOUNT_UNITS),
        sc.ContractParam.any(null),
      ]);
      console.log(`  TX Hash: ${txHash}`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      if (err.message?.includes('Insufficient GAS')) {
        console.error('  Admin account does not have enough GAS. Stopping.');
        process.exit(1);
      }
    }
  }

  console.log('\nAll transfers complete.');
}

main().catch(console.error);
