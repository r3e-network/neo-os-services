#!/usr/bin/env node
import { createHash, randomInt } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sc, tx, u, wallet } from '@cityofzion/neon-js';
import { trimString } from '../lib-strings.mjs';
import {
  readReviewedNetworkRegistrySync,
  resolveReviewedNeoN3Magic,
} from '../lib-network-registry.mjs';

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const VALID_FOR_BLOCKS = 120;
const MAX_INT64 = 0x7fffffffffffffffn;
const ZERO_HASH160 = `0x${'00'.repeat(20)}`;
const HASH160_PATTERN = /^0x[0-9a-f]{40}$/i;
const PUBLIC_KEY_PATTERN = /^(?:02|03)[0-9a-f]{64}$/i;
const TXID_PATTERN = /^0x[0-9a-f]{64}$/i;

class RpcError extends Error {
  constructor(method, code, message) {
    super(`RPC ${method} error ${code}: ${message}`);
    this.name = 'RpcError';
    this.code = code;
  }
}

function requiredEnv(env, name) {
  const value = trimString(env[name]);
  if (!value) throw new Error(`${name} is required and must be non-empty`);
  return value;
}

function normalizeHash160(value, label) {
  const normalized = trimString(value);
  if (HASH160_PATTERN.test(normalized)) return normalized.toLowerCase();
  if (wallet.isAddress(normalized)) {
    return `0x${wallet.getScriptHashFromAddress(normalized).toLowerCase()}`;
  }
  throw new Error(`${label} must be a Neo N3 address or a 20-byte 0x-prefixed script hash`);
}

function normalizePublicKey(value, label) {
  const normalized = trimString(value);
  if (!PUBLIC_KEY_PATTERN.test(normalized) || !wallet.isPublicKey(normalized)) {
    throw new Error(`${label} must be a valid compressed secp256r1 public key without 0x`);
  }
  return normalized.toLowerCase();
}

function normalizeSignature(value) {
  const normalized = trimString(value);
  if (!/^[0-9a-f]{128}$/i.test(normalized)) {
    throw new Error('CVM /sign/payload signature must be exactly 64 bytes of hex');
  }
  return normalized.toLowerCase();
}

function normalizeTxid(value, label) {
  const normalized = trimString(value);
  if (!TXID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a 32-byte 0x-prefixed transaction hash`);
  }
  return normalized.toLowerCase();
}

function normalizePayloadHash(value) {
  const normalized = trimString(value).replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(normalized)) {
    throw new Error('CVM /sign/payload payload_hash must be a 32-byte hash');
  }
  return normalized.toLowerCase();
}

function isLoopbackUrl(url) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
}

function parseEndpoint(value, label, requireHttps) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must not contain credentials, a query, or a fragment`);
  }
  if (requireHttps && url.protocol !== 'https:' && !isLoopbackUrl(url)) {
    throw new Error(`${label} must use HTTPS for non-loopback endpoints`);
  }
  return value.replace(/\/+$/, '');
}

function parsePositiveInteger(value, fallback, label) {
  const normalized = trimString(value);
  if (!normalized) return fallback;
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseFee(value, label) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const normalized = trimString(String(value ?? ''));
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a positive integer`);
  const parsed = BigInt(normalized);
  if (parsed <= 0n || parsed > MAX_INT64) {
    throw new Error(`${label} must be a positive int64`);
  }
  return parsed;
}

export function buildApplyConfirmation({ network, oracleHash, expectedAdminHash }) {
  return `apply:${network}:${oracleHash}:${expectedAdminHash}`;
}

export function parseRecoveryConfig({ argv, env, resolveNetworkMagic }) {
  const { values: flags } = parseArgs({
    args: argv,
    options: {
      network: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'confirm-apply': { type: 'string' },
    },
    allowPositionals: false,
  });
  if (flags.apply && flags['dry-run']) {
    throw new Error('--apply and --dry-run are mutually exclusive');
  }

  const apply = flags.apply === true;
  const network = trimString(flags.network);
  if (!network) throw new Error('--network mainnet|testnet is required; there is no default');
  if (!['mainnet', 'testnet'].includes(network)) {
    throw new Error('--network must be mainnet or testnet');
  }
  if (trimString(flags['confirm-apply']) && !apply) {
    throw new Error('--confirm-apply is only valid together with --apply');
  }

  const rpcUrl = parseEndpoint(requiredEnv(env, 'NEO_RPC_URL'), 'NEO_RPC_URL', apply);
  const cvmUrl = parseEndpoint(requiredEnv(env, 'NITRO_RUNTIME_URL'), 'NITRO_RUNTIME_URL', true);
  const oracleInput = requiredEnv(env, 'CONTRACT_MORPHEUS_ORACLE_HASH');
  if (!HASH160_PATTERN.test(oracleInput)) {
    throw new Error('CONTRACT_MORPHEUS_ORACLE_HASH must be a 20-byte 0x-prefixed script hash');
  }
  const oracleHash = oracleInput.toLowerCase();
  const expectedAdminHash = normalizeHash160(
    requiredEnv(env, 'EXPECTED_ADMIN_ADDRESS'),
    'EXPECTED_ADMIN_ADDRESS'
  );
  const targetAdminHash = normalizeHash160(
    requiredEnv(env, 'TARGET_ADMIN_ADDRESS'),
    'TARGET_ADMIN_ADDRESS'
  );
  if (expectedAdminHash !== targetAdminHash) {
    throw new Error('EXPECTED_ADMIN_ADDRESS and TARGET_ADMIN_ADDRESS identify different admins');
  }

  const updaterInput = trimString(env.NEW_UPDATER_HASH);
  const verifierInput = trimString(env.NEW_VERIFIER_PUBLIC_KEY);
  if (!updaterInput && !verifierInput) {
    throw new Error('at least one NEW_UPDATER_HASH or NEW_VERIFIER_PUBLIC_KEY change is required');
  }
  const newUpdaterHash = updaterInput ? normalizeHash160(updaterInput, 'NEW_UPDATER_HASH') : null;
  if (newUpdaterHash === ZERO_HASH160) throw new Error('NEW_UPDATER_HASH must not be zero');
  const newVerifierPublicKey = verifierInput
    ? normalizePublicKey(verifierInput, 'NEW_VERIFIER_PUBLIC_KEY')
    : null;

  if (apply) {
    const expectedConfirmation = buildApplyConfirmation({
      network,
      oracleHash,
      expectedAdminHash,
    });
    if (trimString(flags['confirm-apply']) !== expectedConfirmation) {
      throw new Error(`--apply requires --confirm-apply exactly matching ${expectedConfirmation}`);
    }
  }
  const maxSystemFee = apply
    ? parseFee(requiredEnv(env, 'MAX_SYSTEM_FEE'), 'MAX_SYSTEM_FEE')
    : null;
  const maxNetworkFee = apply
    ? parseFee(requiredEnv(env, 'MAX_NETWORK_FEE'), 'MAX_NETWORK_FEE')
    : null;
  const maxTotalFee = apply ? parseFee(requiredEnv(env, 'MAX_TOTAL_FEE'), 'MAX_TOTAL_FEE') : null;
  if (typeof resolveNetworkMagic !== 'function') {
    throw new Error('a reviewed network magic resolver is required');
  }
  const networkMagic = resolveNetworkMagic(network);
  if (!Number.isSafeInteger(networkMagic) || networkMagic <= 0 || networkMagic > 0xffffffff) {
    throw new Error('reviewed network magic must be a positive uint32');
  }

  return {
    network,
    networkMagic,
    rpcUrl,
    cvmUrl,
    cvmToken: trimString(env.NITRO_API_TOKEN),
    oracleHash,
    expectedAdminHash,
    targetAdminHash,
    newUpdaterHash,
    newVerifierPublicKey,
    maxSystemFee,
    maxNetworkFee,
    maxTotalFee,
    apply,
    dryRun: !apply,
    confirmationTimeoutMs: parsePositiveInteger(
      env.TX_CONFIRMATION_TIMEOUT_MS,
      DEFAULT_CONFIRMATION_TIMEOUT_MS,
      'TX_CONFIRMATION_TIMEOUT_MS'
    ),
    pollIntervalMs: parsePositiveInteger(
      env.TX_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      'TX_POLL_INTERVAL_MS'
    ),
  };
}

async function fetchJson(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error' });
  } catch (error) {
    throw new Error(`${label} request failed: ${error.message}`, { cause: error });
  }
  const raw = await response.text();
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} must return a JSON object`);
  }
  return body;
}

function createRpcClient(fetchImpl, rpcUrl) {
  let nextId = 0;
  return async function rpc(method, params = []) {
    const id = ++nextId;
    const body = await fetchJson(
      fetchImpl,
      rpcUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
      },
      `RPC ${method}`
    );
    if (body.jsonrpc !== '2.0' || body.id !== id) {
      throw new Error(`RPC ${method} returned a mismatched JSON-RPC envelope`);
    }
    if (body.error) {
      throw new RpcError(
        method,
        body.error.code ?? 'unknown',
        trimString(body.error.message) || 'unknown error'
      );
    }
    if (!Object.hasOwn(body, 'result')) throw new Error(`RPC ${method} returned no result`);
    return body.result;
  };
}

function createCvmClient(fetchImpl, config) {
  return async function cvmPost(pathname, payload) {
    if (!['/keys/derived', '/sign/payload'].includes(pathname)) {
      throw new Error(`unsupported CVM route ${pathname}`);
    }
    const headers = {
      'content-type': 'application/json',
      'x-morpheus-network': config.network,
    };
    if (config.cvmToken) headers.authorization = `Bearer ${config.cvmToken}`;
    return fetchJson(
      fetchImpl,
      `${config.cvmUrl}${pathname}`,
      { method: 'POST', headers, body: JSON.stringify(payload) },
      `CVM ${pathname}`
    );
  };
}

function assertOptionalNetwork(container, config, label) {
  if (Object.hasOwn(container, 'network') && trimString(container.network) !== config.network) {
    throw new Error(`${label} network does not match ${config.network}`);
  }
}

async function queryDerivedIdentity(cvmPost, config, role) {
  const body = await cvmPost('/keys/derived', { role });
  const derived = body.derived;
  if (!derived || typeof derived !== 'object' || Array.isArray(derived)) {
    throw new Error(`CVM derived ${role} response has no derived identity`);
  }
  assertOptionalNetwork(body, config, `CVM derived ${role} response`);
  assertOptionalNetwork(derived, config, `CVM derived ${role} identity`);
  if (trimString(derived.role || body.role) !== role) {
    throw new Error(`CVM derived ${role} response has a missing or mismatched role`);
  }
  if (Object.hasOwn(body, 'status') && trimString(body.status).toLowerCase() !== 'ok') {
    throw new Error(`CVM derived ${role} response reports a failure`);
  }
  const neo = derived.neo_n3;
  if (!neo || typeof neo !== 'object' || Array.isArray(neo)) {
    throw new Error(`CVM derived ${role} response has no Neo N3 identity`);
  }
  const address = trimString(neo.address);
  const scriptHash = trimString(neo.script_hash);
  if (!address || !scriptHash || !trimString(neo.public_key)) {
    throw new Error(
      `CVM derived ${role} response must include address, script_hash, and public_key`
    );
  }
  const publicKey = normalizePublicKey(neo.public_key, `CVM derived ${role} public_key`);
  const addressHash = normalizeHash160(address, `CVM derived ${role} address`);
  const scriptHashNormalized = normalizeHash160(scriptHash, `CVM derived ${role} script_hash`);
  const publicKeyHash = `0x${wallet.getScriptHashFromPublicKey(publicKey).toLowerCase()}`;
  if (addressHash !== scriptHashNormalized || publicKeyHash !== addressHash) {
    throw new Error(`CVM derived ${role} address, script_hash, and public_key do not match`);
  }
  return {
    hash: addressHash,
    address: wallet.getAddressFromScriptHash(addressHash.slice(2)),
    publicKey,
  };
}

function decodeBase64StackBytes(item, method, allowNull) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(`${method} getter returned a malformed stack item`);
  }
  if (allowNull && item.type === 'Any' && item.value === null) return null;
  if (item.type !== 'ByteString' || typeof item.value !== 'string') {
    throw new Error(`${method} getter must return one ByteString stack item`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.value)) {
    throw new Error(`${method} getter returned non-canonical base64`);
  }
  const bytes = Buffer.from(item.value, 'base64');
  if (bytes.toString('base64') !== item.value) {
    throw new Error(`${method} getter returned non-canonical base64`);
  }
  return bytes;
}

function decodeHash160Getter(response, method, { allowNull = false } = {}) {
  const bytes = decodeGetterStack(response, method, allowNull);
  if (bytes === null) return null;
  if (bytes.length !== 20) throw new Error(`${method} getter must return exactly 20 bytes`);
  return `0x${Buffer.from(bytes).reverse().toString('hex')}`;
}

function decodePublicKeyGetter(response, method) {
  const bytes = decodeGetterStack(response, method, true);
  if (bytes === null) return null;
  return normalizePublicKey(bytes.toString('hex'), `${method} getter`);
}

function decodeGetterStack(response, method, allowNull) {
  if (!response || trimString(response.state).toUpperCase() !== 'HALT') {
    throw new Error(
      `${method} getter did not HALT: ${trimString(response?.exception) || 'unknown VM state'}`
    );
  }
  if (!Array.isArray(response.stack) || response.stack.length !== 1) {
    throw new Error(`${method} getter must return exactly one stack item`);
  }
  return decodeBase64StackBytes(response.stack[0], method, allowNull);
}

async function readChainState(rpc, config) {
  const [adminResponse, updaterResponse, verifierResponse] = await Promise.all([
    rpc('invokefunction', [config.oracleHash, 'admin', []]),
    rpc('invokefunction', [config.oracleHash, 'updater', []]),
    rpc('invokefunction', [config.oracleHash, 'oracleVerificationPublicKey', []]),
  ]);
  return {
    admin: decodeHash160Getter(adminResponse, 'admin'),
    updater: decodeHash160Getter(updaterResponse, 'updater', { allowNull: true }),
    verifier: decodePublicKeyGetter(verifierResponse, 'oracleVerificationPublicKey'),
  };
}

function plannedUpdates(config, currentState) {
  const updates = [];
  if (config.newUpdaterHash) {
    if (currentState.updater === config.newUpdaterHash) {
      throw new Error('NEW_UPDATER_HASH equals the current updater; this is not a change');
    }
    updates.push({
      key: 'updater',
      method: 'setUpdater',
      value: config.newUpdaterHash,
      effect: 'immediate',
    });
  }
  if (config.newVerifierPublicKey) {
    if (currentState.verifier === config.newVerifierPublicKey) {
      throw new Error('NEW_VERIFIER_PUBLIC_KEY equals the current verifier; this is not a change');
    }
    updates.push({
      key: 'verifier',
      method: 'setOracleVerificationPublicKey',
      value: config.newVerifierPublicKey,
      effect: 'timelock-proposal',
    });
  }
  return updates;
}

function placeholderWitness(publicKey) {
  return new tx.Witness({
    invocationScript: `0c40${'00'.repeat(64)}`,
    verificationScript: wallet.getVerificationScriptFromPublicKey(publicKey),
  });
}

async function buildTransactionPlan(rpc, config, update, workerIdentity, logger) {
  const args =
    update.key === 'updater'
      ? [sc.ContractParam.hash160(update.value)]
      : [sc.ContractParam.publicKey(update.value)];
  const script = sc.createScript({
    scriptHash: config.oracleHash,
    operation: update.method,
    args,
  });
  const blockCount = await rpc('getblockcount', []);
  if (
    !Number.isSafeInteger(blockCount) ||
    blockCount <= 0 ||
    blockCount + VALID_FOR_BLOCKS > 0xffffffff
  ) {
    throw new Error('RPC getblockcount returned an invalid block height');
  }
  const simulation = await rpc('invokescript', [
    u.HexString.fromHex(script).toBase64(),
    [{ account: config.expectedAdminHash, scopes: 'CalledByEntry' }],
  ]);
  if (trimString(simulation?.state).toUpperCase() !== 'HALT') {
    throw new Error(
      `${update.method} simulation did not HALT: ${
        trimString(simulation?.exception) || 'unknown VM state'
      }`
    );
  }
  const systemFee = parseFee(simulation.gasconsumed, `${update.method} simulation gasconsumed`);
  if (systemFee > config.maxSystemFee) {
    throw new Error(
      `${update.method} systemFee ${systemFee} exceeds MAX_SYSTEM_FEE ${config.maxSystemFee}`
    );
  }
  const transaction = new tx.Transaction({
    version: 0,
    nonce: randomInt(0, 2 ** 32),
    systemFee: u.BigInteger.fromDecimal(systemFee.toString(), 0),
    validUntilBlock: blockCount + VALID_FOR_BLOCKS,
    script: u.HexString.fromHex(script),
    signers: [
      {
        account: config.expectedAdminHash.slice(2),
        scopes: tx.WitnessScope.CalledByEntry,
      },
    ],
    attributes: [],
    witnesses: [],
  });
  transaction.witnesses = [placeholderWitness(workerIdentity.publicKey)];
  const networkFeeResult = await rpc('calculatenetworkfee', [
    u.HexString.fromHex(transaction.serialize(true)).toBase64(),
  ]);
  const networkFee = parseFee(
    networkFeeResult?.networkfee,
    `${update.method} calculatenetworkfee networkfee`
  );
  if (networkFee > config.maxNetworkFee) {
    throw new Error(
      `${update.method} networkFee ${networkFee} exceeds MAX_NETWORK_FEE ${config.maxNetworkFee}`
    );
  }
  const totalFee = systemFee + networkFee;
  if (totalFee > config.maxTotalFee) {
    throw new Error(
      `${update.method} total fee ${totalFee} exceeds MAX_TOTAL_FEE ${config.maxTotalFee}`
    );
  }
  transaction.networkFee = u.BigInteger.fromDecimal(networkFee.toString(), 0);
  transaction.witnesses = [];

  const unsignedHex = transaction.serialize(false);
  const unsignedBytes = Buffer.from(unsignedHex, 'hex');
  const digest = createHash('sha256').update(unsignedBytes).digest();
  const magicBytes = Buffer.alloc(4);
  magicBytes.writeUInt32LE(config.networkMagic, 0);
  const expectedPreimage = Buffer.concat([magicBytes, digest]);
  const preimageHex = transaction.getMessageForSigning(config.networkMagic);
  if (preimageHex !== expectedPreimage.toString('hex')) {
    throw new Error(`${update.method} signing preimage does not match the unsigned transaction`);
  }
  const expectedTxid = `0x${Buffer.from(digest).reverse().toString('hex')}`;
  const txid = normalizeTxid(`0x${transaction.hash()}`, `${update.method} local transaction hash`);
  if (txid !== expectedTxid) throw new Error(`${update.method} local transaction hash mismatch`);
  logger.log(
    `${update.method} preflight HALT; systemFee=${systemFee}; networkFee=${networkFee}; txid=${txid}`
  );
  return {
    ...update,
    transaction,
    script,
    unsignedHex,
    preimageHex,
    txid,
    systemFee: systemFee.toString(),
    networkFee: networkFee.toString(),
    totalFee: totalFee.toString(),
  };
}

async function signTransaction(cvmPost, config, plan, workerIdentity) {
  const body = await cvmPost('/sign/payload', {
    target_chain: 'neo_n3',
    data_hex: plan.preimageHex,
    use_derived_keys: true,
    dstack_key_role: 'worker',
  });
  if (
    body.error ||
    body.success === false ||
    body.ok === false ||
    ['error', 'failed', 'failure', 'fault'].includes(trimString(body.status).toLowerCase())
  ) {
    throw new Error(`CVM /sign/payload rejected ${plan.method}`);
  }
  assertOptionalNetwork(body, config, `CVM /sign/payload ${plan.method} response`);
  if (body.target_chain !== 'neo_n3' || body.source !== 'data_hex') {
    throw new Error('CVM /sign/payload returned a mismatched target_chain or source');
  }
  const expectedPayloadHash = createHash('sha256')
    .update(Buffer.from(plan.preimageHex, 'hex'))
    .digest('hex');
  if (normalizePayloadHash(body.payload_hash) !== expectedPayloadHash) {
    throw new Error('CVM /sign/payload payload_hash does not match the exact signing preimage');
  }
  const signature = normalizeSignature(body.signature);
  const publicKey = normalizePublicKey(body.public_key, 'CVM /sign/payload public_key');
  const addressHash = normalizeHash160(body.address, 'CVM /sign/payload address');
  const scriptHash = normalizeHash160(body.script_hash, 'CVM /sign/payload script_hash');
  const publicKeyHash = `0x${wallet.getScriptHashFromPublicKey(publicKey).toLowerCase()}`;
  if (
    publicKey !== workerIdentity.publicKey ||
    publicKeyHash !== config.expectedAdminHash ||
    addressHash !== config.expectedAdminHash ||
    scriptHash !== config.expectedAdminHash ||
    addressHash !== workerIdentity.hash ||
    scriptHash !== workerIdentity.hash
  ) {
    throw new Error('CVM /sign/payload signer identity does not match derived expected admin');
  }
  if (!wallet.verify(plan.preimageHex, signature, publicKey)) {
    throw new Error('CVM /sign/payload signature does not verify over the exact preimage');
  }

  const witness = tx.Witness.fromSignature(signature, publicKey);
  if (
    witness.invocationScript.toString() !== `0c40${signature}` ||
    witness.verificationScript.toString() !==
      wallet.getVerificationScriptFromPublicKey(publicKey) ||
    `0x${witness.scriptHash}`.toLowerCase() !== config.expectedAdminHash
  ) {
    throw new Error('constructed CheckSig witness does not match expected admin');
  }
  plan.transaction.witnesses = [witness];
  const signedHex = plan.transaction.serialize(true);
  const decoded = tx.Transaction.deserialize(signedHex);
  if (
    decoded.serialize(false) !== plan.unsignedHex ||
    decoded.serialize(true) !== signedHex ||
    decoded.script.toString() !== plan.script ||
    decoded.signers.length !== 1 ||
    `0x${String(decoded.signers[0].account).replace(/^0x/i, '')}`.toLowerCase() !==
      config.expectedAdminHash ||
    decoded.signers[0].scopes !== tx.WitnessScope.CalledByEntry ||
    decoded.witnesses.length !== 1 ||
    decoded.witnesses[0].invocationScript.toString() !== `0c40${signature}` ||
    decoded.witnesses[0].verificationScript.toString() !==
      wallet.getVerificationScriptFromPublicKey(publicKey) ||
    normalizeTxid(`0x${decoded.hash()}`, 'deserialized transaction hash') !== plan.txid ||
    decoded.getMessageForSigning(config.networkMagic) !== plan.preimageHex
  ) {
    throw new Error('signed transaction or witness changed the preflight transaction intent');
  }
  return u.HexString.fromHex(signedHex).toBase64();
}

async function broadcastTransaction(rpc, plan, rawTransaction) {
  const result = await rpc('sendrawtransaction', [rawTransaction]);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`RPC sendrawtransaction ${plan.method} returned no hash object`);
  }
  const returnedTxid = normalizeTxid(result.hash, `RPC sendrawtransaction ${plan.method} hash`);
  if (returnedTxid !== plan.txid) {
    throw new Error(
      `RPC sendrawtransaction ${plan.method} hash mismatch: expected ${plan.txid}, got ${returnedTxid}`
    );
  }
}

function isMissingTransactionError(error) {
  return (
    error instanceof RpcError &&
    (error.code === -104 || /unknown transaction|unknown script container/i.test(error.message))
  );
}

async function waitForConfirmation(rpc, txid, config, { now, sleep }) {
  const maximumAttempts = Math.max(
    1,
    Math.ceil(config.confirmationTimeoutMs / config.pollIntervalMs)
  );
  const deadline = now() + config.confirmationTimeoutMs;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    let log = null;
    try {
      log = await rpc('getapplicationlog', [txid]);
    } catch (error) {
      if (!isMissingTransactionError(error)) throw error;
    }
    if (log !== null) {
      if (!log || typeof log !== 'object' || Array.isArray(log)) {
        throw new Error(`transaction ${txid} returned a malformed application log`);
      }
      if (normalizeTxid(log.txid, `application log for ${txid}`) !== txid) {
        throw new Error(`application log transaction hash does not match ${txid}`);
      }
      if (!Array.isArray(log.executions) || log.executions.length !== 1) {
        throw new Error(`transaction ${txid} must have exactly one execution`);
      }
      const execution = log.executions[0];
      if (trimString(execution?.trigger) !== 'Application') {
        throw new Error(`transaction ${txid} application log trigger is not Application`);
      }
      const vmState = trimString(execution?.vmstate).toUpperCase();
      if (vmState !== 'HALT') {
        throw new Error(
          `transaction ${txid} executed with ${vmState || 'unknown VM state'}: ${
            trimString(execution?.exception) || 'no exception detail'
          }`
        );
      }
      return { txid, vmState, trigger: 'Application' };
    }
    if (attempt + 1 >= maximumAttempts || now() >= deadline) break;
    await sleep(config.pollIntervalMs);
  }
  throw new Error(`transaction ${txid} was not confirmed within ${config.confirmationTimeoutMs}ms`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publicTransaction(entry) {
  return {
    key: entry.key,
    method: entry.method,
    value: entry.value,
    effect: entry.effect,
    txid: entry.txid,
    status: entry.status,
    vmState: entry.vmState,
    trigger: entry.trigger,
  };
}

export async function runRecovery(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('a fetch implementation is required');
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const logger = dependencies.logger ?? console;
  const rpc = createRpcClient(fetchImpl, config.rpcUrl);
  const cvmPost = createCvmClient(fetchImpl, config);

  logger.log(
    `Mode: ${config.apply ? 'APPLY' : 'DRY-RUN (read-only; signing and broadcast disabled)'}`
  );
  logger.log(`Network: ${config.network}; oracle: ${config.oracleHash}`);

  const version = await rpc('getversion', []);
  if (version?.protocol?.network !== config.networkMagic) {
    throw new Error(
      `RPC network magic ${version?.protocol?.network ?? 'missing'} does not match reviewed ${config.network} magic ${config.networkMagic}`
    );
  }

  const workerIdentity = await queryDerivedIdentity(cvmPost, config, 'worker');
  const updaterIdentity = await queryDerivedIdentity(cvmPost, config, 'updater');
  if (workerIdentity.hash !== config.targetAdminHash) {
    throw new Error(
      `target admin ${config.targetAdminHash} does not match CVM worker custody admin ${workerIdentity.hash}`
    );
  }
  logger.log(`CVM worker custody admin: ${workerIdentity.address}`);
  logger.log(`CVM updater identity: ${updaterIdentity.address}`);

  const currentState = await readChainState(rpc, config);
  if (currentState.admin !== config.expectedAdminHash) {
    throw new Error(
      `on-chain admin ${currentState.admin || 'null'} does not match expected admin ${config.expectedAdminHash}`
    );
  }
  logger.log(`On-chain admin verified: ${currentState.admin}`);
  logger.log(`Current updater: ${currentState.updater || 'null'}`);
  logger.log(`Current verifier: ${currentState.verifier || 'null'}`);

  const updates = plannedUpdates(config, currentState);
  if (updates.length === 0) throw new Error('no updater or verifier changes were requested');
  if (config.dryRun) {
    if (updates.some((update) => update.effect === 'timelock-proposal')) {
      logger.log('Verifier request is a timelock proposal, not an immediate rotation');
    }
    logger.log(
      `DRY-RUN only: validated ${updates.length} requested operation(s); no simulation, signing, broadcast, or state write performed`
    );
    return { mode: 'dry-run', currentState, updates, transactions: [] };
  }
  if (!config.apply) throw new Error('apply mode requires explicit apply authorization');

  const transactions = [];
  try {
    const plans = [];
    let plannedFees = 0n;
    for (const update of updates) {
      const plan = await buildTransactionPlan(rpc, config, update, workerIdentity, logger);
      plannedFees += BigInt(plan.totalFee);
      if (plannedFees > config.maxTotalFee) {
        throw new Error(
          `planned fees ${plannedFees} exceed MAX_TOTAL_FEE ${config.maxTotalFee} before signing`
        );
      }
      plans.push(plan);
    }
    logger.log(`Preflight total fees=${plannedFees}; MAX_TOTAL_FEE=${config.maxTotalFee}`);

    for (const plan of plans) {
      logger.log(`Signing ${plan.method} through CVM /sign/payload`);
      const rawTransaction = await signTransaction(cvmPost, config, plan, workerIdentity);
      await broadcastTransaction(rpc, plan, rawTransaction);
      const entry = { ...plan, status: 'submitted' };
      transactions.push(entry);
      logger.log(`${plan.method} broadcast accepted: ${plan.txid}`);
      const confirmation = await waitForConfirmation(rpc, plan.txid, config, { now, sleep });
      Object.assign(entry, confirmation, { status: 'confirmed' });
      logger.log(`${plan.method} confirmed with Application/HALT: ${plan.txid}`);
    }

    const finalState = await readChainState(rpc, config);
    if (finalState.admin !== config.expectedAdminHash) {
      throw new Error('final on-chain admin differs from the confirmed current admin');
    }
    for (const update of updates) {
      if (finalState[update.key] !== update.value) {
        const proposalDetail =
          update.key === 'verifier'
            ? '; the current contract only confirmed a timelock proposal, not a verifier rotation'
            : '';
        throw new Error(
          `${update.key} final getter mismatch: expected ${update.value}, got ${
            finalState[update.key] || 'null'
          }${proposalDetail}`
        );
      }
    }
    logger.log('APPLY verified: every requested final getter matches');
    return {
      mode: 'apply',
      currentState,
      finalState,
      updates,
      transactions: transactions.map(publicTransaction),
    };
  } catch (error) {
    const confirmedTransactions = transactions
      .filter((entry) => entry.status === 'confirmed')
      .map(publicTransaction);
    const confirmedSummary =
      confirmedTransactions.map((entry) => `${entry.method}=${entry.txid}`).join(', ') || 'none';
    const wrapped = new Error(
      `apply incomplete; confirmed transactions: ${confirmedSummary}; ${error.message}`,
      { cause: error }
    );
    wrapped.confirmedTransactions = confirmedTransactions;
    wrapped.transactions = transactions.map(publicTransaction);
    throw wrapped;
  }
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  repoRoot = process.cwd(),
  dependencies = {},
} = {}) {
  const config = parseRecoveryConfig({
    argv,
    env,
    resolveNetworkMagic(network) {
      const registry = readReviewedNetworkRegistrySync(repoRoot, network);
      return Number(resolveReviewedNeoN3Magic(registry, network, env.NEO_NETWORK_MAGIC));
    },
  });
  return runRecovery(config, dependencies);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runCli();
  } catch (error) {
    console.error(`Fatal: ${error.message}`);
    process.exitCode = 1;
  }
}
