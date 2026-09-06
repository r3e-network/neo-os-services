// Neo X (EVM) chain adapter for the multi-chain oracle relayer.
//
// Implements the same adapter shape the generic engine (request-processor.js)
// already uses for Neo N3: hasConfig / getLatestRequestId / scan(byRequestId),
// plus the two chain-specific fulfillment primitives the shared fulfillment
// pipeline branches into — signNeoXFulfillment (EVM keccak digest + secp256k1
// EIP-191 signature) and fulfillNeoXRequest (ethers fulfillRequest submission).
//
// Work lanes (VRF / oracle.fetch / compute) are produced chain-agnostically by
// fulfillment.js BEFORE these run; this module only encodes/signs/submits the
// result for the EVM MorpheusOracleEVM kernel.
import { ethers } from 'ethers';
import {
  mapWithConcurrency,
  resolveScanConcurrency,
  trimString,
} from '@r3e-network/neo-os-services-shared/utils';
import { LEGACY_CALLBACK_METHOD } from '@r3e-network/neo-os-services-shared/callback-methods';

// Minimal ABI for the MorpheusOracleEVM kernel (request_cursor scan + fulfil).
const ORACLE_ABI = [
  'function totalRequests() view returns (uint256)',
  'function oracleVerifier() view returns (address)',
  // NB: 'error' is a reserved word in ethers' human-readable ABI grammar, so the
  // string fields are named errorText/errorArg (param names do not affect encoding).
  'function getRequest(uint256) view returns (tuple(uint256 id, string appId, string moduleId, string operation, bytes payload, address requester, address callbackContract, uint8 status, uint64 createdAt, uint64 fulfilledAt, bool success, bytes resultBytes, string errorText))',
  'function fulfillRequest(uint256 requestId, bool success, bytes result, string errorArg, bytes signature)',
  // Custom errors — required so ethers decodes the revert reason (name) from a
  // failed staticCall simulation; without these fragments the reason is opaque.
  'error RequestNotPending()',
  'error BadSignature()',
  'error NotUpdater()',
  'error AppNotFound()',
  'error ModuleNotGranted()',
];

const FULFILLMENT_DOMAIN = 'morpheus-evm-fulfillment-v1';
const STATUS_PENDING = 1; // Status enum: None=0, Pending=1, Succeeded=2, Failed=3

const providerCache = new Map();
const signerCache = new Map();
// The verifier wallet (digest-signing only, not on-chain txs) is immutable for the process
// lifetime, so memoize it per private key — avoids re-running the secp256k1 key parse in
// ethers.Wallet on every Neo X fulfill. (Round-2 R2-2.4, mirrors signerCache.)
const verifierWalletCache = new Map();
// Per-signer submission queue: serialize tx build+send+wait+reset so concurrent
// engine workers never race on the shared NonceManager (out-of-order nonces) or
// reset() it mid-flight. EVM submission is fast + Neo X volume is low.
const submitQueues = new Map();

function isProductionRuntime(config) {
  return (
    String(config?.nodeEnv || process.env.NODE_ENV || '')
      .trim()
      .toLowerCase() === 'production'
  );
}

export function assertHostNeoXSigningAllowed(config) {
  if (!isProductionRuntime(config)) return;
  throw new Error(
    'Neo X production relaying is unavailable: custody supports secp256k1/NeoX signing, but ' +
      'Rust relayer transaction construction, broadcast, and confirmation are not complete'
  );
}

function signerKey(config) {
  return `${trimString(config?.neox?.updaterPrivateKey || '')}|${trimString(config?.neox?.rpcUrl || '')}`;
}

function runExclusive(key, fn) {
  const prev = submitQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn); // run after the previous settles (success or failure)
  submitQueues.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

function providerForUrl(rpcUrl, chainId) {
  const key = `${rpcUrl}|${chainId || ''}`;
  let provider = providerCache.get(key);
  if (!provider) {
    provider = new ethers.JsonRpcProvider(rpcUrl, chainId);
    providerCache.set(key, provider);
  }
  return provider;
}

function getProvider(config) {
  // Primary provider — also the one PINNED to the submit/signer path so failover
  // never rotates the URL used for nonce management (signerKey stays stable).
  const rpcUrl = trimString(config?.neox?.rpcUrl || '');
  const chainId = Number(config?.neox?.chainId || 0) || undefined;
  return providerForUrl(rpcUrl, chainId);
}

// Ordered READ RPC list for failover: the configured rpcUrls (de-duped) with the
// primary rpcUrl guaranteed first. Falls back to the single rpcUrl when no list
// is configured, so a config without rpcUrls behaves exactly as before.
export function resolveNeoXReadRpcUrls(config) {
  const primary = trimString(config?.neox?.rpcUrl || '');
  const configured = Array.isArray(config?.neox?.rpcUrls)
    ? config.neox.rpcUrls.map((entry) => trimString(entry)).filter(Boolean)
    : [];
  const ordered = [];
  const seen = new Set();
  for (const url of [primary, ...configured]) {
    if (url && !seen.has(url)) {
      seen.add(url);
      ordered.push(url);
    }
  }
  return ordered.length > 0 ? ordered : [primary];
}

// A transport/connectivity error (vs a deterministic contract revert / decode
// failure) is the only class that warrants trying the next RPC. A CALL_EXCEPTION
// is per-id deterministic and must NOT fail over (it returns the same result on
// every endpoint); the same applies to a decoded custom-error revert.
function isNeoXTransportError(error) {
  const code = trimString(error?.code || '');
  if (code === 'CALL_EXCEPTION') return false;
  if (error?.revert) return false;
  // ethers transport/network/timeout/server error codes + generic connectivity.
  if (
    code === 'NETWORK_ERROR' ||
    code === 'SERVER_ERROR' ||
    code === 'TIMEOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED'
  ) {
    return true;
  }
  const message = trimString(error?.shortMessage || error?.message || String(error)).toLowerCase();
  return (
    message.includes('failed to detect network') ||
    message.includes('could not coalesce error') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('bad gateway') ||
    message.includes('service unavailable')
  );
}

/**
 * Run a read against each configured RPC in order, failing over to the next only
 * on a transport error. A deterministic error (CALL_EXCEPTION / revert) is thrown
 * immediately (no failover — the next endpoint would return the same). If every
 * endpoint fails with a transport error the last transport error is thrown so the
 * caller (cursor scan) aborts the tick instead of advancing past unscanned ids.
 */
export async function withNeoXReadFailover(config, run) {
  const rpcUrls = resolveNeoXReadRpcUrls(config);
  const chainId = Number(config?.neox?.chainId || 0) || undefined;
  let lastTransportError = null;
  for (const rpcUrl of rpcUrls) {
    const provider = providerForUrl(rpcUrl, chainId);
    const contract = new ethers.Contract(config.neox.oracleContract, ORACLE_ABI, provider);
    try {
      return await run(contract, provider);
    } catch (error) {
      if (!isNeoXTransportError(error)) throw error;
      lastTransportError = error;
      // try the next RPC
    }
  }
  throw lastTransportError || new Error('neox read failed: no rpc endpoints configured');
}

// Cached NonceManager-wrapped updater so concurrent fulfilments (the engine
// processes events with config.concurrency) get sequential nonces instead of
// colliding on the same pending nonce.
function updaterSigner(config) {
  assertHostNeoXSigningAllowed(config);
  const pk = trimString(config?.neox?.updaterPrivateKey || '');
  if (!pk) throw new Error('neox updater private key is not configured');
  const provider = getProvider(config);
  const key = `${pk}|${trimString(config?.neox?.rpcUrl || '')}`;
  let signer = signerCache.get(key);
  if (!signer) {
    signer = new ethers.NonceManager(new ethers.Wallet(pk, provider));
    signerCache.set(key, signer);
  }
  return signer;
}

function verifierWallet(config) {
  assertHostNeoXSigningAllowed(config);
  // SECURITY (S20): do NOT silently fall back to the updater private key for
  // verifier duties — that mixes the roles and lets the updater sign arbitrary
  // fulfillment digests if the chain's oracleVerifier points at the updater
  // address. The verifier key must be configured explicitly.
  const pk = trimString(config?.neox?.verifierPrivateKey || '');
  if (!pk) {
    throw new Error(
      'neox verifier private key is not configured; set neox.verifierPrivateKey explicitly'
    );
  }
  let wallet = verifierWalletCache.get(pk);
  if (!wallet) {
    wallet = new ethers.Wallet(pk);
    verifierWalletCache.set(pk, wallet);
  }
  return wallet;
}

export function hasNeoXRelayerConfig(config) {
  if (isProductionRuntime(config)) return false;
  return Boolean(
    trimString(config?.neox?.rpcUrl || '') &&
    trimString(config?.neox?.oracleContract || '') &&
    trimString(config?.neox?.updaterPrivateKey || '')
  );
}

export async function getNeoXLatestBlock(config) {
  return withNeoXReadFailover(config, (_contract, provider) => provider.getBlockNumber());
}

export async function getNeoXLatestRequestId(config) {
  const total = await withNeoXReadFailover(config, (contract) => contract.totalRequests());
  return Number(total);
}

function decodePayload(payloadHex) {
  try {
    return ethers.toUtf8String(payloadHex);
  } catch {
    return trimString(payloadHex || '');
  }
}

// The confidential decrypt lane receives its envelope wrapped by the miniapp
// callback contract as abi.encode(uint256 messageId, bytes envelope) — the same
// abi.encode(...) payload convention dice uses (abi.encode(face)). Recover the
// raw base64 envelope string so the decrypt fulfilment lane receives it verbatim;
// fall back to the generic utf8 decode if the payload isn't in that shape.
export function decodeConfidentialEnvelope(payloadHex) {
  try {
    const [, envelopeBytes] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['uint256', 'bytes'],
      payloadHex
    );
    const decoded = ethers.toUtf8String(envelopeBytes);
    if (decoded) return decoded;
  } catch {
    // not abi.encode(uint256,bytes) — fall through to the generic decode
  }
  return decodePayload(payloadHex);
}

// Recover the messageId from the abi.encode(uint256 messageId, bytes envelope) decrypt
// payload so the relayer can bind the /oracle/decrypt request (chain + message_id +
// contract) to the on-chain message. The in-TEE worker now requires this binding by
// default, so the live neox decrypt lane must carry the messageId (it was previously
// decoded and discarded).
export function decodeConfidentialMessageId(payloadHex) {
  try {
    const [messageId] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'bytes'], payloadHex);
    return messageId !== null && messageId !== undefined ? messageId.toString() : '';
  } catch {
    return '';
  }
}

function isConfidentialDecryptOperation(operation) {
  const normalized = operation.toLowerCase();
  return normalized === 'decrypt' || normalized.includes('decrypt');
}

function buildNeoXEventFromRequest(record) {
  const requestId = record.id.toString();
  // Identifier hygiene: carry the on-chain identifier bytes VERBATIM (no trim)
  // so the fulfillment digest reproduces exactly what the kernel keccaks and so
  // ingestion can detect (and reject) whitespace-bearing identifiers. A zeroed
  // struct (missing id) still decodes to an empty operation and is skipped.
  const operation = String(record.operation ?? '');
  if (!operation) return null;
  // Only surface still-pending requests; the engine + reconciliation dedupe the rest.
  if (Number(record.status) !== STATUS_PENDING) return null;
  return {
    chain: 'neox',
    requestId,
    // requestType drives resolveKernelIntent (e.g. 'random' -> random.generate).
    requestType: operation,
    appId: String(record.appId ?? ''),
    moduleId: String(record.moduleId ?? ''),
    operation,
    payloadText: isConfidentialDecryptOperation(operation)
      ? decodeConfidentialEnvelope(record.payload)
      : decodePayload(record.payload),
    // Preserve the on-chain messageId for the decrypt lane so the relayer can bind the
    // /oracle/decrypt request to the stored message (the worker requires binding by default).
    messageId: isConfidentialDecryptOperation(operation)
      ? decodeConfidentialMessageId(record.payload)
      : '',
    requester: trimString(record.requester || ''),
    callbackContract:
      record.callbackContract && record.callbackContract !== ethers.ZeroAddress
        ? trimString(record.callbackContract)
        : '',
    callbackMethod: LEGACY_CALLBACK_METHOD,
    blockNumber: Number(record.createdAt || 0),
    createdAtMs: Number(record.createdAt || 0) * 1000,
    txHash: '',
    logIndex: 0,
  };
}

// Bounded-concurrency map preserving input order: re-uses the shared fail-fast
// helper (@r3e-network/neo-os-services-shared/utils mapWithConcurrency) — once any worker
// throws, idle workers stop pulling new ids so a transport failure does not keep
// issuing RPC calls for the rest of the range. The previous local copy was
// byte-identical to the shared one (G4 consolidation).

export async function scanNeoXOracleRequestsById(
  config,
  fromRequestId,
  toRequestId,
  contract = null
) {
  if (fromRequestId > toRequestId) return [];
  const requestIds = [];
  for (let id = fromRequestId; id <= toRequestId; id += 1) {
    requestIds.push(id);
  }
  // Per-id read: when an explicit contract is injected (tests) use it directly to
  // preserve the existing stub interface; otherwise route through the RPC failover
  // wrapper so a single dead Neo X RPC does not abort the whole scan. A genuine
  // CALL_EXCEPTION (decode failure / zeroed missing id) is still skipped (deterministic
  // per id, never failed over); a transport error that exhausts every RPC still
  // aborts the tick so the cursor does not advance past an unscanned id.
  const readRequest = contract
    ? (id) => contract.getRequest(id)
    : (id) => withNeoXReadFailover(config, (kernel) => kernel.getRequest(id));
  // Batch the per-id getRequest reads under bounded concurrency; results stay
  // index-ordered so the event list matches the sequential scan exactly.
  const events = await mapWithConcurrency(
    requestIds,
    resolveScanConcurrency(config),
    async (id) => {
      let record;
      try {
        record = await readRequest(id);
      } catch (err) {
        // The EVM kernel's getRequest never reverts (missing ids return a zeroed
        // struct), so only a genuine CALL_EXCEPTION (decode failure) is safe to
        // skip. Transport/RPC failures (after failover is exhausted) must abort
        // the tick so the request cursor does not advance past an unscanned id.
        if (err?.code === 'CALL_EXCEPTION') return null;
        throw err;
      }
      return buildNeoXEventFromRequest(record);
    }
  );
  return events.filter(Boolean);
}

// Raw result bytes the EVM kernel stores + keccaks: the compact callback bytes
// (e.g. 32-byte VRF randomness) when present, otherwise the utf8 result string.
export function resolveResultBytesHex(result, resultBytesBase64) {
  const compact = trimString(resultBytesBase64 || '');
  if (compact) return `0x${Buffer.from(compact, 'base64').toString('hex')}`;
  const text = String(result || '');
  return `0x${Buffer.from(text, 'utf8').toString('hex')}`;
}

// keccak digest matching MorpheusOracleEVM.fulfillmentDigest (bound to chain+contract).
export function buildNeoXDigest(config, fulfillment, resultBytesHex) {
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
      FULFILLMENT_DOMAIN,
      BigInt(config.neox.chainId),
      ethers.getAddress(config.neox.oracleContract),
      BigInt(fulfillment.requestId),
      // Identifier hygiene: hash identifier/error bytes VERBATIM. The deployed
      // kernel keccaks the stored request strings exactly as written, so any
      // trimming here would make a signature over a whitespace-bearing
      // identifier unverifiable on-chain (ingestion rejects malformed ids).
      ethers.keccak256(ethers.toUtf8Bytes(String(fulfillment.appId ?? ''))),
      ethers.keccak256(ethers.toUtf8Bytes(String(fulfillment.moduleId ?? ''))),
      ethers.keccak256(ethers.toUtf8Bytes(String(fulfillment.operation ?? ''))),
      Boolean(fulfillment.success),
      ethers.keccak256(resultBytesHex),
      ethers.keccak256(ethers.toUtf8Bytes(String(fulfillment.error ?? ''))),
    ]
  );
  return ethers.keccak256(enc);
}

export async function signNeoXFulfillment(config, fulfillment) {
  const resultBytesHex = resolveResultBytesHex(fulfillment.result, fulfillment.result_bytes_base64);
  const digest = buildNeoXDigest(config, fulfillment, resultBytesHex);
  const wallet = verifierWallet(config);
  // EIP-191 personal-sign over the 32-byte digest (matches the kernel's
  // "\x19Ethereum Signed Message:\n32" + ecrecover == oracleVerifier check).
  const signature = await wallet.signMessage(ethers.getBytes(digest));
  return {
    signature,
    public_key: wallet.signingKey.publicKey,
    address: wallet.address,
    source: 'relayer_local_evm',
  };
}

// Map a Neo X kernel revert onto the relayer's error-classifier vocabulary
// (fulfillment.js classifyError / isAlreadyFulfilledError / isTerminalConfigurationError).
// ethers surfaces a decoded custom error as error.revert.name (when the error
// fragments are in the ABI); fall back to scanning the message text.
export function normalizeNeoXRevert(error) {
  const name = trimString(error?.revert?.name || error?.errorName || '');
  const reason = trimString(
    error?.shortMessage || error?.reason || error?.message || String(error)
  );
  const probe = `${name} ${reason}`.toLowerCase();
  if (probe.includes('requestnotpending')) return new Error('request already fulfilled');
  if (probe.includes('badsignature')) {
    return new Error('invalid signature: verifier rejected signature');
  }
  if (probe.includes('notupdater')) return new Error('unauthorized: updater not set');
  return error instanceof Error ? error : new Error(reason);
}

const DEFAULT_NEOX_CONFIRM_TIMEOUT_MS = 45_000;

export function getNeoXConfirmTimeoutMs(config) {
  const explicit = Number(config?.neox?.confirmTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return DEFAULT_NEOX_CONFIRM_TIMEOUT_MS;
}

// Bound the receipt wait. ethers' tx.wait(1, timeout) rejects on its own once
// the timeout elapses, but the Promise.race deadline also covers a provider
// whose wait() never settles at all (dropped tx + dead subscription) — without
// it a single stuck submission would wedge the per-signer queue and, because
// the relayer awaits each tick, the whole relayer loop. The timeout message
// contains "timed out" so classifyError treats it as transient and the
// fulfillment is retried after signer.reset().
export async function waitForNeoXReceipt(tx, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`neox fulfillRequest confirmation timed out after ${timeoutMs}ms (${tx.hash})`)
        ),
      timeoutMs
    );
    // NOTE: the timer is intentionally NOT unref()'d. Its whole purpose is to
    // FIRE and reject a stuck wait; an unref'd timer does not keep the event loop
    // alive, so on an otherwise-idle loop the process would drain before the
    // deadline fires and the promise would hang forever (the opposite of the
    // intended fail-fast). `finally { clearTimeout }` clears it the instant the
    // race settles, so it is bounded (<= timeoutMs) and never leaks.
  });
  try {
    return await Promise.race([tx.wait(1, timeoutMs), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fulfillNeoXRequest(
  config,
  requestId,
  success,
  result,
  error,
  verificationSignature,
  resultBytesBase64 = ''
) {
  const resultBytesHex = resolveResultBytesHex(result, resultBytesBase64);
  const args = [
    BigInt(requestId),
    Boolean(success),
    resultBytesHex,
    String(error || ''),
    verificationSignature,
  ];
  // Serialize per signer: only one simulate→send→wait runs at a time so the
  // shared NonceManager produces sequential nonces and reset() is never racy.
  return runExclusive(signerKey(config), async () => {
    const signer = updaterSigner(config);
    const kernel = new ethers.Contract(config.neox.oracleContract, ORACLE_ABI, signer);
    // Estimate gas first: this also simulates (decodes custom errors like
    // RequestNotPending / BadSignature so they classify correctly, and avoids
    // burning gas on a tx that would revert). Then send with a generous buffer
    // so the kernel's nested onOracleResult callback (best-effort `.call`) is
    // never starved by the EVM 63/64 gas-forwarding rule — without the buffer a
    // cold-storage callback can run out of gas while the outer tx still succeeds,
    // leaving the consumer's state unsettled.
    let gasLimit;
    try {
      const estimate = await kernel.fulfillRequest.estimateGas(...args);
      gasLimit = estimate * 2n;
    } catch (simErr) {
      throw normalizeNeoXRevert(simErr);
    }
    try {
      const tx = await kernel.fulfillRequest(...args, { gasLimit });
      const receipt = await waitForNeoXReceipt(tx, getNeoXConfirmTimeoutMs(config));
      if (!receipt || receipt.status !== 1) {
        throw new Error(`neox fulfillRequest reverted on-chain (status ${receipt?.status})`);
      }
      return {
        request_id: `neox:fulfill:${requestId}`,
        tx_hash: tx.hash,
        vm_state: 'HALT',
        exception: null,
        target_chain: 'neox',
      };
    } catch (err) {
      // Re-sync the local nonce from chain so a failed/replaced tx doesn't wedge
      // subsequent fulfilments (safe here: submission is serialized per signer).
      try {
        signer.reset();
      } catch {
        /* ignore */
      }
      throw normalizeNeoXRevert(err);
    }
  });
}
