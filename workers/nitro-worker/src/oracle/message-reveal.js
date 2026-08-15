import { ethers } from 'ethers';
import { env, json, jsonError, sanitizeErrorMessage } from '../platform/core.js';
import { decryptEncryptedToken } from './crypto.js';

// Recipient-gated confidential reveal for Neo Message recipient-only messages
// (unlockTime == 0). Unlike the time-locked lane (/oracle/decrypt, which posts
// the plaintext on-chain after the contract has gated the unlock), a
// recipient-only message must NEVER have its plaintext written on-chain — only
// the designated recipient may read it. This lane therefore:
//   1. reads the message from a TRUSTED, worker-configured contract (the
//      contract address is never taken from the caller — otherwise a hostile
//      contract could claim any recipient),
//   2. requires an EIP-191 signature, bound to chain + contract + messageId +
//      a freshness timestamp, that recovers to the on-chain recipient, and
//   3. decrypts inside the enclave host and returns the plaintext only in the
//      authenticated HTTP response (still token-gated end-to-end via the edge).

const DEFAULT_NEOX_CHAIN_ID = 47763;
const REVEAL_FRESHNESS_WINDOW_SECONDS = 600; // ±10 min tolerance for clock skew
const MESSAGE_READ_TIMEOUT_MS = 10_000; // ethers defaults to 300s — far too long for a request lane

const MESSAGE_ABI = [
  'function getMessage(uint256 id) view returns (tuple(address sender,address recipient,bytes envelope,uint64 unlockTime,uint64 sentAt,bool revealed,string plaintext))',
];

const NEOX_CHAIN_ALIASES = new Set(['neox', 'neo_x', 'neo-x']);

/**
 * Canonical statement the recipient signs (EIP-191 personal_sign). The frontend
 * MUST construct the byte-identical string. Binding chain + contract + messageId
 * stops a signature being replayed across messages, contracts, or chains, and
 * `issued` bounds replay to a short freshness window.
 */
export function buildRevealStatement(chainId, contract, messageId, issuedAt) {
  return [
    'Morpheus Neo Message',
    'Recipient reveal request',
    `chain: ${Number(chainId)}`,
    `contract: ${String(contract).toLowerCase()}`,
    `message: ${String(messageId)}`,
    `issued: ${Number(issuedAt)}`,
  ].join('\n');
}

export function recoverRevealSigner(statement, signature) {
  try {
    return ethers.verifyMessage(statement, signature);
  } catch {
    return null;
  }
}

export function addressesEqual(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.length === 42 &&
    b.length === 42 &&
    a.toLowerCase() === b.toLowerCase()
  );
}

export function isRevealTimestampFresh(
  issuedAt,
  nowSeconds,
  window = REVEAL_FRESHNESS_WINDOW_SECONDS
) {
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) return false;
  if (!Number.isFinite(nowSeconds) || nowSeconds <= 0) return false;
  return Math.abs(nowSeconds - issuedAt) <= window;
}

export function parseMessageId(value) {
  if (value === undefined || value === null) return null;
  try {
    const id = BigInt(value);
    if (id <= 0n) return null;
    return id;
  } catch {
    return null;
  }
}

function parseIssuedAt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function buildMessageRpcConnection(rpcUrl) {
  const connection = new ethers.FetchRequest(rpcUrl);
  connection.timeout = MESSAGE_READ_TIMEOUT_MS;
  return connection;
}

export function __buildMessageRpcConnectionForTests(rpcUrl) {
  return buildMessageRpcConnection(rpcUrl);
}

export async function readMessageFromChain({ rpcUrl, chainId, contract, messageId }) {
  const provider = new ethers.JsonRpcProvider(buildMessageRpcConnection(rpcUrl), chainId);
  try {
    const reader = new ethers.Contract(contract, MESSAGE_ABI, provider);
    return await reader.getMessage(messageId);
  } finally {
    provider.destroy();
  }
}

export const NEOX_DECRYPT_CHAIN_ALIASES = NEOX_CHAIN_ALIASES;

// Trusted, worker-configured Neo X message contract context (the contract is
// NEVER taken from the caller — a hostile contract could otherwise lie about
// recipient/unlockTime). Shared by the recipient-reveal and the time-locked
// /oracle/decrypt gating lanes.
export function resolveNeoxMessageChainContext() {
  return {
    rpcUrl: env('NEOX_MESSAGE_RPC', 'NEOX_RPC', 'EVM_RPC_URL'),
    contract: env('NEOX_MESSAGE_CONTRACT'),
    chainId: Number(env('NEOX_MESSAGE_CHAIN_ID', 'NEOX_CHAIN_ID')) || DEFAULT_NEOX_CHAIN_ID,
  };
}

export async function handleMessageReveal(
  payload = {},
  nowSeconds = Math.floor(Date.now() / 1000),
  { readMessage = readMessageFromChain } = {}
) {
  const chain = String(payload.chain || payload.network || 'neox')
    .trim()
    .toLowerCase();
  if (!NEOX_CHAIN_ALIASES.has(chain)) {
    return json(400, { error: 'recipient reveal currently supports the neox chain only' });
  }

  const messageId = parseMessageId(payload.messageId ?? payload.id);
  if (messageId === null) return json(400, { error: 'valid messageId required' });

  const signature = typeof payload.signature === 'string' ? payload.signature.trim() : '';
  if (!signature) return json(400, { error: 'recipient signature required (field: signature)' });

  const issuedAt = parseIssuedAt(payload.issuedAt ?? payload.issued_at ?? payload.issued);
  if (issuedAt === null) return json(400, { error: 'issuedAt (unix seconds) required' });
  if (!isRevealTimestampFresh(issuedAt, nowSeconds)) {
    return json(403, { error: 'reveal request expired; re-sign with a current timestamp' });
  }

  const rpcUrl = env('NEOX_MESSAGE_RPC', 'NEOX_RPC', 'EVM_RPC_URL');
  const contract = env('NEOX_MESSAGE_CONTRACT');
  const chainId = Number(env('NEOX_MESSAGE_CHAIN_ID', 'NEOX_CHAIN_ID')) || DEFAULT_NEOX_CHAIN_ID;
  if (!rpcUrl || !contract) {
    return json(503, { error: 'recipient reveal is not configured on this worker' });
  }

  let message;
  try {
    message = await readMessage({ rpcUrl, chainId, contract, messageId });
  } catch (error) {
    return json(502, {
      error: `failed to read message on-chain: ${sanitizeErrorMessage(error)}`,
    });
  }

  const recipient = String(message.recipient || '');
  if (!recipient || recipient === ethers.ZeroAddress) {
    return json(400, { error: 'message has no designated recipient' });
  }

  // This lane serves recipient-only messages exclusively. A time-locked message
  // (unlockTime > 0) must go through the contract-gated /oracle/decrypt lane
  // after its unlock has passed — decrypting it here would hand the recipient
  // the plaintext before the time-lock expires.
  if (Number(message.unlockTime || 0) !== 0) {
    return json(403, { error: 'time-locked messages must use the contract-gated reveal lane' });
  }

  const statement = buildRevealStatement(chainId, contract, messageId.toString(), issuedAt);
  const signer = recoverRevealSigner(statement, signature);
  if (!signer) return json(400, { error: 'malformed signature' });
  if (!addressesEqual(signer, recipient)) {
    return json(403, { error: 'signature does not match the message recipient' });
  }

  let envelope;
  try {
    envelope = ethers.toUtf8String(message.envelope);
  } catch {
    return json(400, { error: 'stored envelope is not decodable' });
  }

  try {
    const plaintext = await decryptEncryptedToken(envelope, payload);
    if (plaintext == null) return json(400, { error: 'decryption returned empty result' });
    return json(200, {
      plaintext,
      recipient,
      messageId: messageId.toString(),
      unlockTime: Number(message.unlockTime || 0),
    });
  } catch (error) {
    return jsonError(400, error);
  }
}
