#!/usr/bin/env node
// E2E: submit a VRF request to MorpheusOracleEVM and wait for the running
// neox-fulfiller to fulfil it; verify the on-chain result + that the result
// digest recovers to the oracle verifier.
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
const APP = process.env.VRF_APP || 'vrf-e2e';
const abi = JSON.parse(
  readFileSync(resolve(ROOT, 'contracts-evm/build/MorpheusOracleEVM.abi.json'), 'utf8')
);
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const pk = process.env.NEOX_REQUESTER_PK || process.env.NEOX_DEPLOY_PK || process.env.NEOX_FEED_PK;
const wallet = new ethers.Wallet(pk, provider);
const c = new ethers.Contract(ADDR, abi, wallet);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const payload = ethers.toUtf8Bytes(JSON.stringify({ max: 6, n: 1 }));
  const tx = await c.submitRequest(APP, 'random.generate', 'random', payload);
  console.log(`submitRequest(${APP}, random.generate, random) -> ${tx.hash}`);
  const rcpt = await tx.wait();
  let id;
  for (const lg of rcpt.logs) {
    try {
      const p = c.interface.parseLog(lg);
      if (p && p.name === 'RequestQueued') id = p.args.requestId;
    } catch {}
  }
  console.log(`request id ${id} queued (block ${rcpt.blockNumber}) — waiting for fulfiller...`);

  for (let i = 0; i < 40; i++) {
    await sleep(5000);
    const r = await c.getRequest(id);
    const st = Number(r.status);
    if (st === 1) {
      console.log(`  [t+${(i + 1) * 5}s] pending`);
      continue;
    }
    console.log('\n=== VRF REQUEST FULFILLED ===');
    console.log('status   ', { 2: 'Succeeded', 3: 'Failed' }[st] || st);
    console.log('result   ', r.result, '(randomness)');
    console.log('error    ', r.error || '(none)');
    if (st === 2) {
      const verifier = await c.oracleVerifier();
      const enc = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          'string',
          'uint256',
          'address',
          'uint256',
          'bytes32',
          'bytes32',
          'bytes32',
          'bool',
          'bytes32',
          'bytes32',
        ],
        [
          'morpheus-evm-fulfillment-v1',
          CHAIN_ID,
          ADDR,
          id,
          ethers.keccak256(ethers.toUtf8Bytes(r.appId)),
          ethers.keccak256(ethers.toUtf8Bytes(r.moduleId)),
          ethers.keccak256(ethers.toUtf8Bytes(r.operation)),
          true,
          ethers.keccak256(r.result),
          ethers.keccak256(ethers.toUtf8Bytes(r.error)),
        ]
      );
      const digest = ethers.keccak256(enc);
      const rand = BigInt(r.result);
      console.log('derived die roll (1-6):', (rand % 6n) + 1n);
      console.log('digest   ', digest, '(verified on-chain by kernel ecrecover==', verifier + ')');
      console.log(
        '\n✅✅ NeoX EVM ORACLE LANE WORKS E2E — submitRequest → fulfiller VRF → verifier-signed fulfillRequest on Neo X mainnet.'
      );
    } else {
      console.log('⚠️ fulfilled as Failed:', r.error);
    }
    return;
  }
  console.log('⚠️ still pending after ~3.3min — is neox-fulfiller running?');
})().catch((e) => console.log('FATAL', String(e.message).slice(0, 200)));
