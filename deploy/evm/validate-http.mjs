#!/usr/bin/env node
// E2E: submit an HTTP oracle request on Neo X and wait for the relayer to route
// it to the Nitro worker (oracle.fetch), sign (secp256k1), and fulfil it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NET = process.env.NEOX_NET || 'neox-mainnet';
const rec = JSON.parse(
  readFileSync(resolve(ROOT, `contracts-evm/build/MorpheusOracleEVM.${NET}.json`), 'utf8')
);
const ADDR = process.env.NEOX_ORACLE || rec.address;
const RPC = process.env.NEOX_RPC || 'https://mainnet-1.rpc.banelabs.org';
const CHAIN_ID = Number(process.env.NEOX_CHAIN_ID || 47763);
const APP = process.env.HTTP_APP || 'http-neox';
const abi = JSON.parse(
  readFileSync(resolve(ROOT, 'contracts-evm/build/MorpheusOracleEVM.abi.json'), 'utf8')
);
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(
  process.env.NEOX_REQUESTER_PK || process.env.NEOX_FEED_PK,
  provider
);
const c = new ethers.Contract(ADDR, abi, wallet);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const payload = ethers.toUtf8Bytes(
    JSON.stringify({
      url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
      method: 'GET',
      json_path: 'data.amount',
    })
  );
  const tx = await c.submitRequest(APP, 'oracle.fetch', 'oracle', payload);
  console.log(`submitRequest(${APP}, oracle.fetch, oracle) -> ${tx.hash}`);
  const rcpt = await tx.wait();
  let id;
  for (const lg of rcpt.logs) {
    try {
      const p = c.interface.parseLog(lg);
      if (p?.name === 'RequestQueued') id = p.args.requestId;
    } catch {}
  }
  console.log(
    `HTTP request id ${id} queued (block ${rcpt.blockNumber}) — waiting for relayer + worker...`
  );

  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const r = await c.getRequest(id);
    const st = Number(r.status);
    if (st === 1) {
      console.log(`  [t+${(i + 1) * 5}s] pending`);
      continue;
    }
    let text = '';
    try {
      text = ethers.toUtf8String(r.result).replace(/[^\x20-\x7e]/g, '');
    } catch {}
    console.log('\n=== HTTP REQUEST FULFILLED ===');
    console.log('status ', { 2: 'Succeeded', 3: 'Failed' }[st] || st);
    console.log('result ', r.result.slice(0, 80), text ? `| as-text: ${text.slice(0, 100)}` : '');
    console.log('error  ', r.error || '(none)');
    console.log(
      st === 2
        ? '\n✅✅ NeoX HTTP (oracle.fetch) LANE WORKS E2E — kernel → relayer → Nitro worker fetch → secp256k1-signed fulfillRequest on Neo X mainnet.'
        : `⚠️ fulfilled as Failed: ${r.error}`
    );
    return;
  }
  console.log('⚠️ still pending after ~3.3min — check relayer/worker logs');
})().catch((e) => console.log('FATAL', String(e.message).slice(0, 200)));
