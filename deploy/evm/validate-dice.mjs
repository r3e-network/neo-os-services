#!/usr/bin/env node
// E2E: place dice bets on Neo X and wait for the relayer's VRF to settle them via
// MiniAppDiceGameEVM.onOracleResult. Usage: NEOX_REQUESTER_PK=0x.. node validate-dice.mjs [count] [face] [stake]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ethers } from 'ethers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NET = process.env.NEOX_NET || 'neox-mainnet';
const rec = JSON.parse(
  readFileSync(resolve(ROOT, `contracts-evm/build/MiniAppDiceGameEVM.${NET}.json`), 'utf8')
);
const DICE = process.env.NEOX_DICE || rec.address;
const RPC = process.env.NEOX_RPC || 'https://mainnet-1.rpc.banelabs.org';
const CHAIN_ID = Number(process.env.NEOX_CHAIN_ID || 47763);
const abi = JSON.parse(
  readFileSync(resolve(ROOT, 'contracts-evm/build/MiniAppDiceGameEVM.abi.json'), 'utf8')
);
const COUNT = Number(process.argv[2] || 3);
const FACE = Number(process.argv[3] || 6);
const STAKE = process.argv[4] || '0.1';

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(
  process.env.NEOX_REQUESTER_PK || process.env.NEOX_FEED_PK,
  provider
);
const dice = new ethers.Contract(DICE, abi, wallet);
const STATUS = { 0: 'None', 1: 'Pending', 2: 'Won', 3: 'Lost', 4: 'Refunded' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function placeAndSettle(i) {
  const tx = await dice.placeBet(FACE, { value: ethers.parseEther(STAKE) });
  const rcpt = await tx.wait();
  let id;
  for (const lg of rcpt.logs) {
    try {
      const p = dice.interface.parseLog(lg);
      if (p?.name === 'DiceBetPlaced') id = p.args.requestId;
    } catch {}
  }
  process.stdout.write(`  bet #${i} face=${FACE} stake=${STAKE} req=${id} ... `);
  for (let k = 0; k < 40; k++) {
    await sleep(5000);
    const b = await dice.getBet(id);
    if (Number(b.status) !== 1) {
      const won = Number(b.status) === 2;
      console.log(
        `${STATUS[Number(b.status)]} (rolled ${b.rolled}${won ? `, payout ${ethers.formatEther((b.stake * 57n) / 10n)} GAS` : ''})`
      );
      return Number(b.status);
    }
  }
  console.log('still pending after ~3min');
  return 1;
}

(async () => {
  console.log(`dice ${DICE} — placing ${COUNT} bet(s), face ${FACE}, stake ${STAKE} GAS each`);
  const before = ethers.formatEther(await dice.availableBankroll());
  let won = 0,
    settled = 0;
  for (let i = 1; i <= COUNT; i++) {
    const s = await placeAndSettle(i);
    if (s === 2) won++;
    if (s !== 1) settled++;
  }
  const after = ethers.formatEther(await dice.availableBankroll());
  console.log(`\nsettled ${settled}/${COUNT}, won ${won}. bankroll ${before} -> ${after} GAS`);
  console.log(
    settled === COUNT
      ? '\n✅✅ NeoX DICE GAME WORKS E2E — placeBet -> relayer VRF -> onOracleResult settlement on Neo X mainnet.'
      : '⚠️ some bets did not settle — check relayer/oracle'
  );
})().catch((e) => console.log('FATAL', String(e.message).slice(0, 200)));
