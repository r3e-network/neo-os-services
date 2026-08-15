#!/usr/bin/env node
// Admin/read helper for the Neo X MorpheusOracleEVM kernel.
// Usage:
//   node deploy/evm/oracle-admin.mjs info
//   NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs register-module random.generate
//   NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs register-app <appId> <admin> [callback]
//   NEOX_ADMIN_PK=0x.. node deploy/evm/oracle-admin.mjs grant <appId> <moduleId>
//   node deploy/evm/oracle-admin.mjs request <id>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RPC = process.env.NEOX_RPC || 'https://mainnet-1.rpc.banelabs.org';
const CHAIN_ID = Number(process.env.NEOX_CHAIN_ID || 47763);
const NET = process.env.NEOX_NET || 'neox-mainnet';
const rec = JSON.parse(
  readFileSync(resolve(ROOT, `contracts-evm/build/MorpheusOracleEVM.${NET}.json`), 'utf8')
);
const ADDR = process.env.NEOX_ORACLE || rec.address;
const abi = JSON.parse(
  readFileSync(resolve(ROOT, 'contracts-evm/build/MorpheusOracleEVM.abi.json'), 'utf8')
);
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

const [cmd, ...a] = process.argv.slice(2);
const ZERO = '0x0000000000000000000000000000000000000000';

function signer() {
  const pk = process.env.NEOX_ADMIN_PK || process.env.NEOX_DEPLOY_PK || process.env.NEOX_FEED_PK;
  if (!pk) throw new Error('set NEOX_ADMIN_PK');
  return new ethers.Wallet(pk, provider);
}
async function send(c, fn, args) {
  const tx = await c[fn](...args);
  console.log(`${fn}(${args.join(', ')}) -> ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`  mined block ${rcpt.blockNumber}, gasUsed ${rcpt.gasUsed}`);
}

if (cmd === 'info') {
  const c = new ethers.Contract(ADDR, abi, provider);
  console.log('oracle     ', ADDR, `(${NET}, chainId ${CHAIN_ID})`);
  console.log('owner      ', await c.owner());
  console.log('updater    ', await c.updater());
  console.log('verifier   ', await c.oracleVerifier());
  console.log('requestFee ', (await c.requestFee()).toString(), 'wei');
  console.log('totalReqs  ', (await c.totalRequests()).toString());
} else if (cmd === 'register-module') {
  const c = new ethers.Contract(ADDR, abi, signer());
  await send(c, 'registerModule', [a[0]]);
} else if (cmd === 'register-app') {
  const c = new ethers.Contract(ADDR, abi, signer());
  await send(c, 'registerMiniApp', [a[0], a[1], a[2] || ZERO]);
} else if (cmd === 'grant') {
  const c = new ethers.Contract(ADDR, abi, signer());
  await send(c, 'grantModule', [a[0], a[1]]);
} else if (cmd === 'request') {
  const c = new ethers.Contract(ADDR, abi, provider);
  const r = await c.getRequest(a[0]);
  const dec = (h) => {
    try {
      return ethers.toUtf8String(h);
    } catch {
      return h;
    }
  };
  console.log({
    id: r.id.toString(),
    appId: r.appId,
    moduleId: r.moduleId,
    operation: r.operation,
    requester: r.requester,
    callback: r.callbackContract,
    status: Number(r.status),
    success: r.success,
    result: r.result,
    resultText: dec(r.result),
    error: r.error,
    createdAt: Number(r.createdAt),
    fulfilledAt: Number(r.fulfilledAt),
  });
} else {
  console.error(
    'commands: info | register-module <id> | register-app <appId> <admin> [callback] | grant <appId> <moduleId> | request <id>'
  );
  process.exit(1);
}
