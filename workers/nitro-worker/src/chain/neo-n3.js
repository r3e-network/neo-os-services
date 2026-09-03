import { randomInt, randomUUID } from 'node:crypto';
import { experimental, rpc as neoRpc, sc, tx, u, wallet as neoWallet } from '@cityofzion/neon-js';
import {
  DEFAULT_NEO_NETWORK_MAGIC,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  envForNetwork,
  normalizeBoolean,
  resolveTrustedRpcUrl,
  resolvePayloadNetwork,
  sanitizeErrorMessage,
  strip0x,
  trimString,
} from '../platform/core.js';
import {
  allowlistAllows,
  canonicalizeMethodName,
  checkNeoIntentPolicy,
  normalizeContractHash,
  toNeoContractParam,
} from '../platform/allowlist.js';
import { custodyKeyId, custodyKeyInfo, custodySignTransaction } from '../platform/custody.js';
import { forgetRequestId, rememberRequestId, rejectCallerSuppliedSigningKey } from './signing.js';
import { sleep } from '../platform/core.js';
import { env } from '../platform/core.js';

const SPONSOR_OPERATION_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

// Fee shaping for locally-built Neo N3 transactions (raw GAS fractions,
// 8 decimals), mirroring the relayer's custody-signed flow.
const NEO_N3_TX_VALID_BLOCKS = 120;
const NEO_N3_FEE_PADDING = 100000n; // 0.001 GAS pad on system and network fees

function resolveSponsorOperationHash(payload = {}) {
  const value = trimString(payload.operation_hash || payload.operationHash || '');
  return value.toLowerCase();
}

function resolveSponsorContractHash(payload = {}) {
  const value = trimString(payload.target_contract || payload.targetContract || '');
  return value.toLowerCase();
}

function resolveSponsorMethod(payload = {}) {
  const value = trimString(payload.method || payload.target_method || payload.targetMethod || '');
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : '';
}

function decodePushData(token) {
  if (!token?.params) return null;
  const hex = token.params;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

function decodeNeoScriptHash(token) {
  const bytes = decodePushData(token);
  if (!bytes || bytes.length !== 20) return '';
  return Buffer.from(bytes).reverse().toString('hex').toLowerCase();
}

/**
 * Validate that a caller-supplied transaction is exactly the operation that
 * was approved by the paymaster policy. The operation hash is over the unsigned
 * transaction serialization, so adding a sponsor witness does not change it.
 */
export function validateSponsorOperation(transaction, payload = {}) {
  const expectedHash = resolveSponsorOperationHash(payload);
  const targetContract = resolveSponsorContractHash(payload).replace(/^0x/, '');
  const targetMethod = resolveSponsorMethod(payload);
  if (!SPONSOR_OPERATION_HASH_PATTERN.test(expectedHash)) {
    throw new Error('operation_hash (unsigned transaction hash) is required for sponsorship');
  }
  if (!/^([0-9a-f]{40})$/i.test(targetContract) || !targetMethod) {
    throw new Error('target_contract and method are required for sponsorship');
  }
  const actualHash = `0x${transaction.hash().replace(/^0x/i, '').toLowerCase()}`;
  if (actualHash !== expectedHash) {
    throw new Error('operation_hash does not match the unsigned transaction');
  }
  const tokens = sc.OpToken.fromScript(transaction.script.toString());
  const contractCalls = tokens.filter(
    (token) =>
      token.code === sc.OpCode.SYSCALL &&
      token.params === sc.InteropServiceCode.SYSTEM_CONTRACT_CALL
  );
  const syscall = tokens.at(-1);
  const methodToken = tokens.at(-3);
  const contractToken = tokens.at(-2);
  if (
    contractCalls.length !== 1 ||
    !syscall ||
    syscall.code !== sc.OpCode.SYSCALL ||
    syscall.params !== sc.InteropServiceCode.SYSTEM_CONTRACT_CALL
  ) {
    throw new Error('sponsorship transaction must contain a single contract call');
  }
  const methodBytes = decodePushData(methodToken);
  const scriptContract = decodeNeoScriptHash(contractToken);
  if (!methodBytes || methodBytes.toString('utf8') !== targetMethod) {
    throw new Error('transaction method does not match the approved paymaster operation');
  }
  if (scriptContract !== targetContract) {
    throw new Error('transaction target_contract does not match the approved paymaster operation');
  }
  return {
    operation_hash: actualHash,
    target_contract: `0x${targetContract}`,
    method: targetMethod,
  };
}

// Signer scopes arrive as wire bytes for deserialized transactions and as enum
// names for JSON-built ones. A Global-scoped signer authorizes its witness in
// every context, so any scope that carries the Global bit — the composite 0x81
// as much as the bare 0x80, or the string form — must be refused.
function scopeCarriesGlobal(scope) {
  const globalBit = Number(tx.WitnessScope.Global);
  if (typeof scope === 'number') return (scope & globalBit) !== 0;
  const text = trimString(scope == null ? '' : String(scope));
  if (!text) return false;
  if (/^(0x)?[0-9a-f]+$/i.test(text)) return (Number(text) & globalBit) !== 0;
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .includes('global');
}

export function assertSponsorWitnesses(transaction, sponsorScriptHash, userAddress) {
  const sponsor = transaction.signers.find(
    (signer) => String(signer.account) === sponsorScriptHash
  );
  if (
    sponsor &&
    sponsor.scopes !== tx.WitnessScope.None &&
    sponsor.scopes !== tx.WitnessScope.CalledByEntry
  ) {
    throw new Error('sponsor signer scope must be None or CalledByEntry');
  }
  const user = transaction.signers.find(
    (signer) => neoWallet.getAddressFromScriptHash(String(signer.account)) === userAddress
  );
  if (!user || scopeCarriesGlobal(user.scopes)) {
    throw new Error('user signer must be present with a non-global witness scope');
  }
}

// The tx-relay lane signs through the custody service: the identity comes from
// GET /keys/{SIGNER_ROLE_UPDATER_KEY_ID} (the on-chain caller for the oracle
// contract methods it relays) and the witness from POST /sign/transaction. No
// env-provided WIF participates in Neo N3 signing.
async function resolveCustodyRelayIdentity(role = 'worker') {
  const keyId = custodyKeyId(role);
  const info = await custodyKeyInfo(keyId);
  const publicKey = trimString(info.public_key || '').toLowerCase();
  const scriptHash = strip0x(trimString(info.script_hash || '')).toLowerCase();
  if (!/^[0-9a-f]{66}$/.test(publicKey) || !/^[0-9a-f]{40}$/.test(scriptHash)) {
    throw new Error('custody signer returned an incomplete relay key identity');
  }
  const account = new neoWallet.Account(publicKey);
  if (strip0x(String(account.scriptHash)).toLowerCase() !== scriptHash) {
    throw new Error('custody relay key identity mismatch between public key and script hash');
  }
  return { keyId, account, scriptHash: `0x${scriptHash}` };
}

// Returns the custody witness for `transaction` without touching the
// transaction itself: the relay lane installs it as the only witness, the
// sponsor lane appends it next to the user's existing witness.
async function custodySignRelayWitness(identity, transaction) {
  const signed = await custodySignTransaction(identity.keyId, transaction.serialize(false));
  const witness = new tx.Witness({
    invocationScript: u.HexString.fromHex(trimString(signed.invocation_script || '')),
    verificationScript: u.HexString.fromHex(trimString(signed.verification_script || '')),
  });
  const witnessHash = strip0x(String(witness.scriptHash)).toLowerCase();
  if (witnessHash !== strip0x(identity.scriptHash).toLowerCase()) {
    throw new Error('custody signer witness mismatch for the relay key');
  }
  return witness;
}

// The witness shape every signing lane produces: PUSHDATA1-encoded CheckSig
// script (`0c21 <33B pubkey> 4156e7b327`, 40 bytes) — as emitted by
// transaction.sign() and the custody service alike. Fee estimation over a
// placeholder must use this exact shape to land on the real network fee.
function placeholderWitness(publicKey) {
  return new tx.Witness({
    invocationScript: '0c40' + '00'.repeat(64),
    verificationScript: `0c21${publicKey}4156e7b327`,
  });
}

export function getNeoSigners(account, scope = 'CalledByEntry') {
  return [{ account: account.scriptHash, scopes: trimString(scope) || 'CalledByEntry' }];
}

export function normalizeNeoRawTransaction(rawTransaction) {
  const raw = trimString(rawTransaction);
  if (!raw) throw new Error('raw transaction required');
  if (/^(0x)?[0-9a-fA-F]+$/.test(raw) && raw.replace(/^0x/i, '').length % 2 === 0) {
    return u.HexString.fromHex(raw.replace(/^0x/i, '')).toBase64();
  }
  return raw;
}

export async function waitForNeoApplicationLog(
  rpcClient,
  txHash,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await rpcClient.getApplicationLog(txHash);
    } catch {
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(`timed out waiting for Neo application log: ${txHash}`);
}

export function getNeoExecutionSummary(appLog) {
  const execution = appLog?.executions?.[0];
  return {
    vmState: execution?.vmstate || execution?.VMState || null,
    exception: execution?.exception || execution?.Exception || null,
  };
}

export async function loadNeoN3Context(
  payload = {},
  { required = false, requireRpc = false } = {}
) {
  const network = resolvePayloadNetwork(payload);
  const rpcUrl = await resolveTrustedRpcUrl(network, payload.rpc_url);
  if (requireRpc && !rpcUrl) throw new Error('NEO_RPC_URL is required for Neo N3 relay');

  const networkMagic = Number(
    payload.network_magic ||
      envForNetwork(network, 'NEO_NETWORK_MAGIC') ||
      DEFAULT_NEO_NETWORK_MAGIC
  );

  // Raw signing material never belongs in this process. Reject it even for
  // read-only context construction so no caller can probe a latent local lane.
  rejectCallerSuppliedSigningKey(payload);

  const context = {
    network,
    rpcUrl,
    networkMagic: Number.isFinite(networkMagic) ? networkMagic : DEFAULT_NEO_NETWORK_MAGIC,
    account: null,
    custody: null,
    // The signing identity resolves lazily: read-only consumers (on-chain
    // baseline loads, raw broadcasts) never sign and must not require custody
    // provisioning. `required` forces it eagerly for signing lanes. The relay
    // lane signs operator intent on the oracle contract (fulfillRequest /
    // queueAutomationRequest — the txproxy allowlist), so the on-chain caller
    // is the updater account: the same identity the relayer fulfills under.
    resolveSigningIdentity: async () => {
      if (!context.custody) context.custody = await resolveCustodyRelayIdentity('updater');
      return context.custody;
    },
  };
  if (required) await context.resolveSigningIdentity();
  return context;
}

export async function relayNeoN3Invocation(payload) {
  const requestId =
    trimString(payload.request_id || payload.requestId) || `txproxy:${randomUUID()}`;
  const contractHash = normalizeContractHash(payload.contract_hash);
  const method = canonicalizeMethodName(payload.method);
  if (!method) throw new Error('method required');
  if (!allowlistAllows(contractHash, method, payload)) {
    return { status: 403, body: { error: 'contract/method not allowed' } };
  }

  const intentError = checkNeoIntentPolicy({ ...payload, contract_hash: contractHash, method });
  if (intentError) {
    return { status: intentError.status, body: { error: intentError.error } };
  }

  if (!rememberRequestId(requestId)) {
    return { status: 409, body: { error: 'request_id already used', request_id: requestId } };
  }

  try {
    const context = await loadNeoN3Context(payload, { required: true, requireRpc: true });
    const identity = await context.resolveSigningIdentity();
    const account = identity.account;
    const params = Array.isArray(payload.params)
      ? payload.params.map((param) => toNeoContractParam(param))
      : [];
    const rpcClient = new neoRpc.RPCClient(context.rpcUrl);
    const contract = new experimental.SmartContract(contractHash, {
      rpcAddress: context.rpcUrl,
      networkMagic: context.networkMagic,
    });
    const signerScope = normalizeBoolean(env('MORPHEUS_ALLOW_GLOBAL_SCOPE'), false)
      ? payload.signer_scope || payload.scope || 'CalledByEntry'
      : 'CalledByEntry';
    const shouldSkipSimulation =
      payload.skip_simulation === true ||
      trimString(payload.skip_simulation).toLowerCase() === 'true';
    let simulation = null;
    if (!shouldSkipSimulation) {
      simulation = await contract.testInvoke(method, params, getNeoSigners(account, signerScope));
      if (String(simulation?.state || '') === 'FAULT') {
        forgetRequestId(requestId);
        return {
          status: 400,
          body: {
            request_id: requestId,
            error: simulation?.exception || 'Neo invocation simulation failed',
            vm_state: simulation?.state || 'FAULT',
          },
        };
      }
    }

    // Build, fee, sign, broadcast — mirrors the relayer's custody-signed flow:
    // invokescript for the system fee, calculatenetworkfee over a placeholder
    // witness, custody witness, sendrawtransaction.
    const script = sc.createScript({
      scriptHash: contractHash,
      operation: method,
      args: params,
    });
    const blockCount = await rpcClient.getBlockCount();
    const transaction = new tx.Transaction({
      version: 0,
      nonce: randomInt(0, 2 ** 32),
      script: u.HexString.fromHex(script),
      validUntilBlock: blockCount + NEO_N3_TX_VALID_BLOCKS,
      signers: getNeoSigners(account, signerScope),
      attributes: [],
      witnesses: [],
    });
    const gasConsumed = BigInt(simulation?.gasconsumed || '0');
    transaction.systemFee = u.BigInteger.fromDecimal(String(gasConsumed + NEO_N3_FEE_PADDING), 0);
    transaction.witnesses = [placeholderWitness(account.publicKey)];
    const networkFee = await rpcClient.calculateNetworkFee(
      Buffer.from(transaction.serialize(true), 'hex').toString('base64')
    );
    // neon-js parses the RPC result: a JSON number, or the raw node shapes on
    // mock transports.
    const networkFeeRaw =
      typeof networkFee === 'number'
        ? String(networkFee)
        : typeof networkFee === 'string'
          ? networkFee
          : String(networkFee?.networkfee || '0');
    transaction.networkFee = u.BigInteger.fromDecimal(
      String(BigInt(networkFeeRaw || '0') + NEO_N3_FEE_PADDING),
      0
    );
    if (identity.keyId) {
      transaction.witnesses = [await custodySignRelayWitness(identity, transaction)];
    } else {
      transaction.witnesses = [];
      transaction.sign(account, context.networkMagic);
    }
    const txHashRaw = await rpcClient.sendRawTransaction(
      Buffer.from(transaction.serialize(true), 'hex').toString('base64')
    );
    const txHash = trimString(txHashRaw).startsWith('0x')
      ? trimString(txHashRaw)
      : `0x${trimString(txHashRaw)}`;
    let vmState = simulation?.state || 'HALT';
    let exception = simulation?.exception || undefined;
    let appLog;
    if (payload.wait) {
      appLog = await waitForNeoApplicationLog(
        rpcClient,
        txHash,
        Number(payload.timeout_ms) || DEFAULT_WAIT_TIMEOUT_MS,
        Number(payload.poll_interval_ms) || DEFAULT_POLL_INTERVAL_MS
      );
      const summary = getNeoExecutionSummary(appLog);
      vmState = summary.vmState || vmState;
      exception = summary.exception || exception;
    }

    return {
      status: 200,
      body: {
        request_id: requestId,
        tx_hash: txHash,
        vm_state: vmState,
        exception,
        app_log: appLog,
      },
    };
  } catch (error) {
    forgetRequestId(requestId);
    return {
      status: 400,
      body: {
        request_id: requestId,
        error: sanitizeErrorMessage(error),
      },
    };
  }
}

export async function sponsorNeoN3Transaction(payload) {
  if (!normalizeBoolean(env('MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP'), false)) {
    throw new Error(
      'transaction sponsorship is disabled; set MORPHEUS_ALLOW_TRANSACTION_SPONSORSHIP=true after policy review'
    );
  }
  const context = await loadNeoN3Context(payload, { required: true, requireRpc: false });
  const txBase64 = trimString(payload.tx_base64 || payload.txBase64);
  const userAddress = trimString(payload.user_address || payload.userAddress);
  if (!txBase64 || !userAddress) {
    throw new Error('tx_base64 and user_address are required for Neo N3 sponsorship relay');
  }

  const identity = await context.resolveSigningIdentity();
  const sponsorAccount = identity.account;
  const transaction = tx.Transaction.deserialize(txBase64);
  const hasUserSigner = transaction.signers.some(
    (signer) => neoWallet.getAddressFromScriptHash(String(signer.account)) === userAddress
  );
  if (!hasUserSigner) throw new Error('transaction does not belong to the supplied user_address');
  const sponsorScriptHash = sponsorAccount.scriptHash;
  assertSponsorWitnesses(transaction, sponsorScriptHash, userAddress);
  const hasSponsorSigner = transaction.signers.some(
    (signer) => String(signer.account) === sponsorScriptHash
  );
  if (!hasSponsorSigner) {
    transaction.signers.push(
      new tx.Signer({ account: sponsorAccount.scriptHash, scopes: tx.WitnessScope.None })
    );
  }

  const feePerByte = Number(payload.fee_per_byte || payload.feePerByte || 1000);
  const priorityFee = Number(payload.priority_fee || payload.priorityFee || 100000);
  const sponsorPlaceholder = placeholderWitness(sponsorAccount.publicKey);
  const dummySignatures = transaction.signers.map((signer) => {
    if (String(signer.account) === sponsorAccount.scriptHash) {
      return sponsorPlaceholder;
    }
    return new tx.Witness({ invocationScript: '', verificationScript: '' });
  });

  const size =
    transaction.serialize().length / 2 +
    dummySignatures.reduce((sum, witness) => sum + witness.serialize().length / 2, 0);
  const calculatedFee = size * feePerByte + priorityFee;
  const maxFeeGas = Number(env('MORPHEUS_MAX_SPONSOR_FEE_GAS') || 10);
  if (calculatedFee > maxFeeGas * 100_000_000) {
    throw new Error(
      `sponsor network fee (${calculatedFee}) exceeds cap (${maxFeeGas} GAS); set MORPHEUS_MAX_SPONSOR_FEE_GAS to increase`
    );
  }
  transaction.networkFee = u.BigInteger.fromNumber(Math.floor(calculatedFee));
  validateSponsorOperation(transaction, payload);
  if (identity.keyId) {
    transaction.witnesses.push(await custodySignRelayWitness(identity, transaction));
  } else {
    transaction.sign(sponsorAccount, context.networkMagic);
  }

  const sponsoredTx = transaction.serialize(true);
  const result = {
    target_chain: 'neo_n3',
    sponsor_address: sponsorAccount.address,
    sponsor_public_key: sponsorAccount.publicKey,
    network_fee: transaction.networkFee.toString(),
    sponsored_tx_base64: sponsoredTx,
    witnesses: transaction.witnesses.map((witness) => witness.serialize()),
  };

  if (!payload.broadcast) return result;
  if (!context.rpcUrl)
    throw new Error('NEO_RPC_URL is required to broadcast sponsored Neo N3 transactions');

  const rpcClient = new neoRpc.RPCClient(context.rpcUrl);
  const txHashRaw = await rpcClient.sendRawTransaction(normalizeNeoRawTransaction(sponsoredTx));
  const txHash = trimString(txHashRaw).startsWith('0x')
    ? trimString(txHashRaw)
    : `0x${trimString(txHashRaw)}`;
  let appLog;
  if (payload.wait) {
    appLog = await waitForNeoApplicationLog(
      rpcClient,
      txHash,
      Number(payload.timeout_ms) || DEFAULT_WAIT_TIMEOUT_MS,
      Number(payload.poll_interval_ms) || DEFAULT_POLL_INTERVAL_MS
    );
  }

  return { ...result, tx_hash: txHash, app_log: appLog };
}

export async function broadcastNeoN3RawTransaction(payload) {
  if (!normalizeBoolean(env('MORPHEUS_ALLOW_RAW_BROADCAST'), false)) {
    return {
      target_chain: 'neo_n3',
      status: 403,
      error: 'raw broadcast requires MORPHEUS_ALLOW_RAW_BROADCAST=true',
    };
  }
  const context = await loadNeoN3Context(payload, { required: false, requireRpc: true });
  const rpcClient = new neoRpc.RPCClient(context.rpcUrl);
  const txHashRaw = await rpcClient.sendRawTransaction(
    normalizeNeoRawTransaction(
      payload.raw_transaction ||
        payload.raw_tx ||
        payload.signed_tx ||
        payload.tx_base64 ||
        payload.tx_hex
    )
  );
  const txHash = trimString(txHashRaw).startsWith('0x')
    ? trimString(txHashRaw)
    : `0x${trimString(txHashRaw)}`;
  let appLog;
  if (payload.wait) {
    appLog = await waitForNeoApplicationLog(
      rpcClient,
      txHash,
      Number(payload.timeout_ms) || DEFAULT_WAIT_TIMEOUT_MS,
      Number(payload.poll_interval_ms) || DEFAULT_POLL_INTERVAL_MS
    );
  }
  return { target_chain: 'neo_n3', tx_hash: txHash, app_log: appLog };
}
