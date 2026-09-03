import { readFileSync, appendFileSync } from 'node:fs';
import pkg from '@cityofzion/neon-js';
const { sc, wallet, tx, u } = pkg;
const RPCS = (
  process.env.FEED_RPCS ||
  'https://api.n3index.dev/mainnet,https://rpc10.n3.nspcc.ru:10331,https://mainnet1.neo.coz.io:443'
)
  .split(',')
  .map((s) => s.trim());
const GAS = 'd2a4cff31913016155e38e474a2c06d08be276cf';
const UPDATER = '0x9fb28bdacfaa7fcc0a4d660d0dc990b0e7d46118';
const THRESHOLD = Number(process.env.TOPUP_THRESHOLD || 25),
  AMOUNT = Number(process.env.TOPUP_AMOUNT || 40);
const LOG = '/opt/morpheus/nitro/feed-topup.log';
const ENV_FILE = process.env.FEED_TOPUP_ENV_FILE || '/opt/morpheus/nitro/feed-topup.env';
const env = {};
// Keep this parser byte-identical with db-prune.mjs (each box script is deployed
// as a standalone file): [A-Z0-9_] key charset + matched surrounding-quote strip.
for (const l of readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
// Custody signer service (docs/SIGNER_SERVICE.md §5): the funding key lives in
// the enclave under the fee_funder role. The script names it by key id and gets
// back either a refusal or a signature — never key material.
const CUSTODY_API = '/signer/api/v1';
const CUSTODY_URL = (env.SIGNER_SERVICE_URL || '').trim().replace(/\/+$/, '');
const CUSTODY_TOKEN = (env.SIGNER_SERVICE_TOKEN || '').trim();
const FUNDER_KEY_ID = (env.SIGNER_ROLE_FEE_FUNDER_KEY_ID || '').trim();
if (!CUSTODY_URL || !CUSTODY_TOKEN || !FUNDER_KEY_ID) {
  throw new Error(
    'custody signer service is not configured (SIGNER_SERVICE_URL / SIGNER_SERVICE_TOKEN / SIGNER_ROLE_FEE_FUNDER_KEY_ID)'
  );
}
const log = (m) => {
  const l = `[${new Date().toISOString()}] ${m}`;
  try {
    appendFileSync(LOG, l + '\n');
  } catch {}
  console.log(l);
};
async function custodyRequest(method, pathname, body) {
  let r;
  try {
    r = await fetch(`${CUSTODY_URL}${CUSTODY_API}${pathname}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        authorization: `Bearer ${CUSTODY_TOKEN}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    throw new Error(`custody signer service unreachable: ${e?.message || e}`);
  }
  const t = await r.text();
  let j = {};
  try {
    j = t ? JSON.parse(t) : {};
  } catch {}
  if (!r.ok) {
    const code = typeof j.code === 'string' && j.code ? j.code : '';
    const detail = typeof j.message === 'string' && j.message ? j.message : '';
    throw new Error(
      code || detail
        ? `custody refused (${r.status}): ${[code, detail].filter(Boolean).join(': ')}`
        : `custody signer service answered ${r.status}`
    );
  }
  // A 2xx that still says no is a refusal envelope (§5), not a success.
  if (j.allowed === false) {
    throw new Error(`custody refused: ${j.code || 'denied'}${j.message ? `: ${j.message}` : ''}`);
  }
  return j;
}
async function rpc(meth, p) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: meth, params: p }),
        signal: AbortSignal.timeout(15000),
      });
      const t = await r.text();
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        throw new Error('non-JSON');
      }
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 100));
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
async function bal(sh) {
  const j = await rpc('invokefunction', [
    `0x${GAS}`,
    'balanceOf',
    [{ type: 'Hash160', value: sh }],
  ]);
  return Number(j.stack[0].value) / 1e8;
}
(async () => {
  const key = await custodyRequest('GET', `/keys/${encodeURIComponent(FUNDER_KEY_ID)}`);
  const funderPublicKey = (key.public_key || '').trim();
  const funderScriptHash = (key.script_hash || '').trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(funderScriptHash) || !funderPublicKey) {
    throw new Error('custody fee_funder key returned an incomplete identity');
  }
  const funderAddress =
    (key.address || '').trim() || wallet.getAddressFromScriptHash(funderScriptHash);
  const upd = await bal(UPDATER);
  if (upd >= THRESHOLD) {
    log(`ok: updater ${upd.toFixed(1)} GAS >= ${THRESHOLD}, no topup needed`);
    return;
  }
  const fund = await bal('0x' + funderScriptHash);
  if (fund < AMOUNT + 1) {
    log(
      `ALERT: updater LOW ${upd.toFixed(1)} AND funding key LOW ${fund.toFixed(1)} — REFILL funding key ${funderAddress}`
    );
    process.exit(1);
  }
  const script = sc.createScript({
    scriptHash: GAS,
    operation: 'transfer',
    args: [
      sc.ContractParam.hash160(funderAddress),
      sc.ContractParam.hash160(UPDATER),
      sc.ContractParam.integer(Math.round(AMOUNT * 1e8)),
      sc.ContractParam.any(null),
    ],
  });
  const count = await rpc('getblockcount', []);
  const txn = new tx.Transaction({
    signers: [{ account: funderScriptHash, scopes: tx.WitnessScope.CalledByEntry }],
    validUntilBlock: count + 500,
    script,
  });
  const inv = await rpc('invokescript', [
    u.HexString.fromHex(script).toBase64(),
    [{ account: '0x' + funderScriptHash, scopes: 'CalledByEntry' }],
  ]);
  txn.systemFee = u.BigInteger.fromNumber(inv.gasconsumed);
  const verif = wallet.getVerificationScriptFromPublicKey(funderPublicKey);
  txn.witnesses = [
    new tx.Witness({ invocationScript: '0c40' + '00'.repeat(64), verificationScript: verif }),
  ];
  const nf = await rpc('calculatenetworkfee', [
    u.HexString.fromHex(txn.serialize(true)).toBase64(),
  ]);
  txn.networkFee = u.BigInteger.fromNumber(nf.networkfee);
  // Fee accounting done with the placeholder witness; the real witness comes
  // from the enclave over the unsigned serialization.
  txn.witnesses = [];
  const signed = await custodyRequest('POST', '/sign/transaction', {
    key_id: FUNDER_KEY_ID,
    unsigned_hex: txn.serialize(false),
  });
  txn.witnesses = [
    new tx.Witness({
      invocationScript: u.HexString.fromHex((signed.invocation_script || '').trim()),
      verificationScript: u.HexString.fromHex((signed.verification_script || '').trim()),
    }),
  ];
  if (`0x${txn.witnesses[0].scriptHash}`.toLowerCase() !== `0x${funderScriptHash}`) {
    throw new Error('custody signer witness mismatch for fee_funder');
  }
  const res = await rpc('sendrawtransaction', [
    u.HexString.fromHex(txn.serialize(true)).toBase64(),
  ]);
  log(
    `TOPPED UP updater +${AMOUNT} GAS (was ${upd.toFixed(1)}, funding key ${fund.toFixed(1)}->${(fund - AMOUNT).toFixed(1)}), txid ${res && res.hash}`
  );
})().catch((e) => {
  log('topup error: ' + e.message);
  process.exit(2);
});
