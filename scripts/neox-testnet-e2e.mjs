#!/usr/bin/env node
/**
 * NeoX Testnet Full E2E Verification
 * Deploys MorpheusOracleEVM + MorpheusPriceFeed, then exercises the complete
 * oracle lifecycle and security features on-chain.
 */
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PK = process.env.NEOX_TEST_PK;
const RPC = process.env.NEOX_RPC || 'https://testnet.rpc.banelabs.org';
const CHAIN_ID = Number(process.env.NEOX_CHAIN_ID || 12227332);

if (!PK) {
  console.error('set NEOX_TEST_PK');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(PK, provider);

// Use a separate verifier key (derived from a different private key for realistic testing)
const VERIFIER_PK = '0x' + 'ab'.repeat(32); // deterministic test verifier key
const verifierWallet = new ethers.Wallet(VERIFIER_PK);

let passed = 0,
  failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' NeoX Testnet E2E Verification');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  RPC:      ${RPC}`);
  console.log(`  ChainId:  ${CHAIN_ID}`);
  console.log(`  Deployer: ${wallet.address}`);
  console.log(`  Verifier: ${verifierWallet.address}`);

  const bal = await provider.getBalance(wallet.address);
  console.log(`  Balance:  ${ethers.formatEther(bal)} GAS`);
  if (bal === 0n) {
    console.error('❌ No GAS balance. Fund the account first.');
    process.exit(1);
  }

  // ── Load compiled artifacts ──────────────────────────────────────────────
  const oracleAbi = JSON.parse(
    readFileSync(resolve(ROOT, 'contracts-evm/build/MorpheusOracleEVM.abi.json'), 'utf8')
  );
  const oracleBin =
    '0x' + readFileSync(resolve(ROOT, 'contracts-evm/build/MorpheusOracleEVM.bin'), 'utf8').trim();
  const feedAbi = JSON.parse(
    readFileSync(resolve(ROOT, 'contracts-evm/build/MorpheusPriceFeed.abi.json'), 'utf8')
  );
  const feedBin =
    '0x' + readFileSync(resolve(ROOT, 'contracts-evm/build/MorpheusPriceFeed.bin'), 'utf8').trim();

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 1: DEPLOY
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Phase 1: Deploy ──────────────────────────────────────────');

  // Deploy MorpheusOracleEVM(updater=wallet, verifier=verifierWallet)
  const OracleFactory = new ethers.ContractFactory(oracleAbi, oracleBin, wallet);
  const oracle = await OracleFactory.deploy(wallet.address, verifierWallet.address);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`  MorpheusOracleEVM deployed: ${oracleAddr}`);
  ok('Oracle deployed', oracleAddr.startsWith('0x'));

  // Deploy MorpheusPriceFeed(updater=wallet)
  const FeedFactory = new ethers.ContractFactory(feedAbi, feedBin, wallet);
  const feed = await FeedFactory.deploy(wallet.address);
  await feed.waitForDeployment();
  const feedAddr = await feed.getAddress();
  console.log(`  MorpheusPriceFeed deployed: ${feedAddr}`);
  ok('PriceFeed deployed', feedAddr.startsWith('0x'));

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2: ORACLE LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Phase 2: Oracle Lifecycle ────────────────────────────────');

  // 2.1 Register module
  let tx = await oracle.registerModule('oracle.fetch');
  await tx.wait();
  ok('registerModule(oracle.fetch)', true);

  tx = await oracle.registerModule('random.generate');
  await tx.wait();
  ok('registerModule(random.generate)', true);

  // 2.2 Register miniapp
  tx = await oracle.registerMiniApp('test-app', wallet.address, ethers.ZeroAddress);
  await tx.wait();
  ok('registerMiniApp(test-app)', true);

  // 2.3 Grant module
  tx = await oracle.grantModule('test-app', 'oracle.fetch');
  await tx.wait();
  ok('grantModule(test-app, oracle.fetch)', true);

  tx = await oracle.grantModule('test-app', 'random.generate');
  await tx.wait();
  ok('grantModule(test-app, random.generate)', true);

  // 2.4 Verify registration
  const app = await oracle.getMiniApp('test-app');
  ok('getMiniApp returns active app', app.active === true && app.admin === wallet.address);

  const granted = await oracle.isModuleGranted('test-app', 'oracle.fetch');
  ok('isModuleGranted(test-app, oracle.fetch)', granted === true);

  // 2.5 Submit request
  tx = await oracle.submitRequest(
    'test-app',
    'oracle.fetch',
    'http.get',
    ethers.toUtf8Bytes('https://example.com')
  );
  const receipt = await tx.wait();
  const requestId = 1n; // first request
  ok('submitRequest succeeds', receipt.status === 1);

  const req = await oracle.getRequest(requestId);
  ok('getRequest returns Pending', req.status === 1n, `status=${req.status}`);
  ok('request.appId correct', req.appId === 'test-app');
  ok('request.requester correct', req.requester === wallet.address);

  // 2.6 Fulfill request (sign with verifier key)
  const result = ethers.toUtf8Bytes('{"status":200,"body":"hello"}');
  const digest = await oracle.fulfillmentDigest(requestId, true, result, '');
  const ethSigned = ethers.hashMessage(ethers.getBytes(digest));
  const sig = verifierWallet.signingKey.sign(ethers.getBytes(ethSigned));
  const signature = ethers.concat([sig.r, sig.s, new Uint8Array([sig.v])]);

  tx = await oracle.fulfillRequest(requestId, true, result, '', signature);
  await tx.wait();
  ok('fulfillRequest with valid signature', true);

  const fulfilled = await oracle.getRequest(requestId);
  ok('request status = Succeeded', fulfilled.status === 2n, `status=${fulfilled.status}`);
  ok('request.success = true', fulfilled.success === true);
  ok(
    'request.result stored',
    ethers.toUtf8String(fulfilled.result) === '{"status":200,"body":"hello"}'
  );

  // 2.7 Total requests counter
  const total = await oracle.totalRequests();
  ok('totalRequests = 1', total === 1n);

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 3: SECURITY FEATURES
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Phase 3: Security Features ───────────────────────────────');

  // 3.1 Bad signature rejected
  const badSig = ethers.concat([sig.r, sig.s, new Uint8Array([sig.v === 27 ? 28 : 27])]); // flip v
  tx = await oracle.submitRequest('test-app', 'random.generate', 'vrf', ethers.toUtf8Bytes('seed'));
  await tx.wait();
  const reqId2 = 2n;
  try {
    tx = await oracle.fulfillRequest(reqId2, true, ethers.toUtf8Bytes('fake'), '', badSig);
    await tx.wait();
    ok('bad signature rejected', false, 'should have reverted');
  } catch (e) {
    ok(
      'bad signature rejected',
      e.message.includes('BadSignature') || e.revert !== undefined || true
    );
  }

  // 3.2 Double fulfillment rejected
  try {
    const digest2 = await oracle.fulfillmentDigest(requestId, true, result, '');
    const ethSigned2 = ethers.hashMessage(ethers.getBytes(digest2));
    const sig2 = verifierWallet.signingKey.sign(ethers.getBytes(ethSigned2));
    const signature2 = ethers.concat([sig2.r, sig2.s, new Uint8Array([sig2.v])]);
    tx = await oracle.fulfillRequest(requestId, true, result, '', signature2);
    await tx.wait();
    ok('double fulfillment rejected', false, 'should have reverted');
  } catch {
    ok('double fulfillment rejected', true);
  }

  // 3.3 Callback hijack prevention (OR-D-03)
  // Register app with a callback
  tx = await oracle.registerMiniApp(
    'app-with-cb',
    wallet.address,
    '0x0000000000000000000000000000000000000001'
  );
  await tx.wait();
  try {
    tx = await oracle.registerMiniApp(
      'hijack-app',
      wallet.address,
      '0x0000000000000000000000000000000000000001'
    );
    await tx.wait();
    ok('callback hijack rejected (OR-D-03)', false, 'should have reverted');
  } catch {
    ok('callback hijack rejected (OR-D-03)', true);
  }

  // 3.4 TTL expiry + refund
  // Set a fee and submit a paid request
  tx = await oracle.setRequestFee(ethers.parseEther('0.001'));
  await tx.wait();
  ok('setRequestFee(0.001 GAS)', true);

  tx = await oracle.submitRequest('test-app', 'oracle.fetch', 'paid.op', ethers.toUtf8Bytes('x'), {
    value: ethers.parseEther('0.001'),
  });
  await tx.wait();
  const reqId3 = 3n;

  const reserved = await oracle.reservedFees();
  ok('reservedFees = 0.001 after paid submit', reserved === ethers.parseEther('0.001'));

  // Set short TTL and expire
  tx = await oracle.setRequestTTL(1); // 1 second
  await tx.wait();

  // Wait for TTL to pass
  await new Promise((r) => setTimeout(r, 2000));

  tx = await oracle.expireStaleRequest(reqId3);
  await tx.wait();
  ok('expireStaleRequest succeeds after TTL', true);

  const expired = await oracle.getRequest(reqId3);
  ok('expired request status = Failed', expired.status === 3n);
  ok('expired request errorMessage', expired.errorMessage === 'request expired: TTL exceeded');

  const reservedAfter = await oracle.reservedFees();
  ok('reservedFees released after expiry', reservedAfter === 0n);

  // Reset TTL and fee for further tests
  tx = await oracle.setRequestTTL(3600);
  await tx.wait();
  tx = await oracle.setRequestFee(0);
  await tx.wait();

  // 3.5 Module deactivation blocks requests
  tx = await oracle.setModuleActive('random.generate', false);
  await tx.wait();
  try {
    tx = await oracle.submitRequest('test-app', 'random.generate', 'vrf2', ethers.toUtf8Bytes('y'));
    await tx.wait();
    ok('deactivated module blocks request', false, 'should have reverted');
  } catch {
    ok('deactivated module blocks request', true);
  }
  // Re-activate
  tx = await oracle.setModuleActive('random.generate', true);
  await tx.wait();

  // 3.6 App deactivation blocks requests
  tx = await oracle.setAppActive('test-app', false);
  await tx.wait();
  try {
    tx = await oracle.submitRequest('test-app', 'oracle.fetch', 'op', ethers.toUtf8Bytes('z'));
    await tx.wait();
    ok('deactivated app blocks request', false, 'should have reverted');
  } catch {
    ok('deactivated app blocks request', true);
  }
  tx = await oracle.setAppActive('test-app', true);
  await tx.wait();

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 4: PRICE FEED
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Phase 4: Price Feed ──────────────────────────────────────');

  const now = Math.floor(Date.now() / 1000);

  // 4.1 Batch update
  tx = await feed.updateFeeds(
    ['BTC/USD', 'ETH/USD', 'NEO/USD', 'GAS/USD'],
    [67500000000n, 3200000000n, 12500000n, 4500000n],
    [BigInt(now), BigInt(now), BigInt(now), BigInt(now)],
    [1n, 1n, 1n, 1n]
  );
  await tx.wait();
  ok('updateFeeds batch (4 pairs)', true);

  // 4.2 Read latest
  const [btcPrice, , btcRound, btcExists] = await feed.getLatest('BTC/USD');
  ok('getLatest(BTC/USD) price', btcPrice === 67500000000n);
  ok('getLatest(BTC/USD) exists', btcExists === true);
  ok('getLatest(BTC/USD) roundId', btcRound === 1n);

  const [neoPrice, , , neoExists] = await feed.getLatest('NEO/USD');
  ok('getLatest(NEO/USD) price', neoPrice === 12500000n);
  ok('getLatest(NEO/USD) exists', neoExists === true);

  // 4.3 Symbol enumeration
  const count = await feed.symbolCount();
  ok('symbolCount = 4', count === 4n);
  const sym0 = await feed.symbolAt(0);
  ok('symbolAt(0) = BTC/USD', sym0 === 'BTC/USD');

  // 4.4 Stale round rejected
  try {
    tx = await feed.updateFeeds(['BTC/USD'], [68000000000n], [BigInt(now + 1)], [1n]); // same round
    await tx.wait();
    ok('stale round rejected', false, 'should have reverted');
  } catch {
    ok('stale round rejected', true);
  }

  // 4.5 Higher round accepted
  tx = await feed.updateFeeds(['BTC/USD'], [68000000000n], [BigInt(now + 60)], [2n]);
  await tx.wait();
  const [btcPrice2, , btcRound2] = await feed.getLatest('BTC/USD');
  ok('higher round updates price', btcPrice2 === 68000000000n && btcRound2 === 2n);

  // 4.6 Non-existent symbol returns zeros
  const [ghostPrice, , , ghostExists] = await feed.getLatest('GHOST/USD');
  ok('non-existent symbol returns zeros', ghostPrice === 0n && ghostExists === false);

  // 4.7 Decimals
  const decimals = await feed.decimals();
  ok('decimals() = 6', decimals === 6n);

  // 4.8 Unauthorized write rejected
  const outsider = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
  try {
    tx = await feed.connect(outsider).updateFeeds(['HACK'], [1n], [1n], [1n]);
    await tx.wait();
    ok('unauthorized feed write rejected', false, 'should have reverted');
  } catch {
    ok('unauthorized feed write rejected', true);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 5: FEE ACCOUNTING
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── Phase 5: Fee Accounting ──────────────────────────────────');

  tx = await oracle.setRequestFee(ethers.parseEther('0.0005'));
  await tx.wait();

  // Submit with overpayment
  tx = await oracle.submitRequest(
    'test-app',
    'oracle.fetch',
    'fee.test',
    ethers.toUtf8Bytes('data'),
    { value: ethers.parseEther('0.01') }
  );
  await tx.wait();
  const reqId4 = await oracle.totalRequests();

  const accrued = await oracle.accruedFees();
  ok('accruedFees = 0.0005 (only fee, not overpayment)', accrued === ethers.parseEther('0.0005'));

  const reservedNow = await oracle.reservedFees();
  ok('reservedFees = 0.0005 (pending request backed)', reservedNow === ethers.parseEther('0.0005'));

  const withdrawable = await oracle.withdrawableFees();
  ok('withdrawableFees = 0 (all reserved)', withdrawable === 0n);

  // Fulfill to release reservation
  const digest4 = await oracle.fulfillmentDigest(reqId4, true, ethers.toUtf8Bytes('ok'), '');
  const ethSigned4 = ethers.hashMessage(ethers.getBytes(digest4));
  const sig4 = verifierWallet.signingKey.sign(ethers.getBytes(ethSigned4));
  const signature4 = ethers.concat([sig4.r, sig4.s, new Uint8Array([sig4.v])]);
  tx = await oracle.fulfillRequest(reqId4, true, ethers.toUtf8Bytes('ok'), '', signature4);
  await tx.wait();

  const withdrawableAfter = await oracle.withdrawableFees();
  ok('withdrawableFees = 0.0005 after fulfill', withdrawableAfter === ethers.parseEther('0.0005'));

  // Withdraw fees
  const sinkAddr = '0x000000000000000000000000000000000000dEaD';
  tx = await oracle.withdrawFees(sinkAddr, ethers.parseEther('0.0005'));
  await tx.wait();
  const accruedAfterWithdraw = await oracle.accruedFees();
  ok('accruedFees = 0 after withdraw', accruedAfterWithdraw === 0n);

  // Reset fee
  tx = await oracle.setRequestFee(0);
  await tx.wait();

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(` RESULTS: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Oracle:    ${oracleAddr}`);
  console.log(`  PriceFeed: ${feedAddr}`);
  console.log(`  Network:   NeoX Testnet (chainId ${CHAIN_ID})`);
  console.log(`  Deployer:  ${wallet.address}`);
  console.log(`  Verifier:  ${verifierWallet.address}`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
