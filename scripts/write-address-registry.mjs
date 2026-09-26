import fs from 'node:fs/promises';
import path from 'node:path';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from './lib-network-registry.mjs';

const network = String(process.env.MORPHEUS_NETWORK || 'testnet')
  .trim()
  .toLowerCase();
const reviewed = readReviewedNetworkRegistrySync(process.cwd(), network);
const target = path.resolve('config/networks', `${network}.json`);
const current = JSON.parse(await fs.readFile(target, 'utf8'));

const next = {
  ...current,
  neo_n3: {
    ...current.neo_n3,
    rpc_url: process.env.NEO_RPC_URL || current.neo_n3?.rpc_url || '',
    network_magic: Number(
      resolveReviewedNeoN3Magic(
        reviewed,
        network,
        process.env.NEO_NETWORK_MAGIC || String(current.neo_n3?.network_magic || '')
      )
    ),
    contracts: {
      ...current.neo_n3?.contracts,
      morpheus_oracle:
        process.env.CONTRACT_MORPHEUS_ORACLE_HASH ||
        current.neo_n3?.contracts?.morpheus_oracle ||
        '',
      oracle_callback_consumer:
        process.env.CONTRACT_ORACLE_CALLBACK_CONSUMER_HASH ||
        current.neo_n3?.contracts?.oracle_callback_consumer ||
        '',
      morpheus_datafeed:
        process.env.CONTRACT_MORPHEUS_DATAFEED_HASH ||
        current.neo_n3?.contracts?.morpheus_datafeed ||
        '',
    },
  },
};

await fs.writeFile(target, JSON.stringify(next, null, 2) + '\n');
console.log(`updated ${target}`);
