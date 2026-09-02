import { isHexString, strip0x, trimString } from '../../platform/core.js';
import { relayNeoN3Invocation } from '../../chain/index.js';
import { maybeSignNeoN3Bytes } from '../../chain/signing.js';
import { decimalToIntegerString } from './decimal.js';
import { clampFeedTimestampSec } from './shared.js';
import { resolveFeedSubmissionWait, resolveFeedSubmissionWaitTimeoutMs } from './sync-policy.js';

// Resolve the on-chain submission timestamp for a single-feed updateFeed call.
// Prefer an already-clamped value (computed in the batch path against the
// previous on-chain timestamp); otherwise clamp the quote's own timestamp so a
// standalone caller is still protected from anchoring a future-dated value that
// would permanently stall the strictly-monotonic MorpheusDataFeed (B9).
function resolveSubmitTimestampSec(quote, explicitTimestampSec) {
  if (explicitTimestampSec !== undefined && explicitTimestampSec !== null) {
    const explicit = Number(explicitTimestampSec);
    if (Number.isFinite(explicit)) return Math.floor(explicit);
  }
  const parsed = Date.parse(quote?.timestamp);
  const nowSec = Math.floor(Date.now() / 1000);
  const upstreamSec = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : nowSec;
  return clampFeedTimestampSec({ upstreamSec, prevTs: 0, nowSec });
}

export function buildNeoN3RelaySigningPayload(payload = {}) {
  const signingKey = trimString(payload.private_key || payload.signing_key);
  const wif = trimString(payload.wif);
  return {
    ...(signingKey ? { private_key: signingKey } : {}),
    ...(wif ? { wif } : {}),
  };
}

// C1 — carry the ECDSA signature + signer public key (produced at submit time by
// signFeedUpdate over the canonical on-chain message) into the persisted feed
// record so the anchored value CAN be re-verified once an on-chain verification
// key is registered. While no key is registered the contract ignores these
// fields and the write stays updater-witness only, so this is additive and
// backward compatible. Returns an empty object when the update was not signed.
export function buildFeedSignatureFields(quote = {}) {
  const signature = trimString(quote?.feed_signature || quote?.signature || '');
  const signerPublicKey = trimString(
    quote?.feed_signer_public_key || quote?.public_key || quote?.signer_public_key || ''
  );
  if (!signature && !signerPublicKey) return {};
  return {
    ...(signature ? { signature } : {}),
    ...(signerPublicKey ? { signer_public_key: signerPublicKey } : {}),
  };
}

const FEED_SIGNATURE_DOMAIN = Buffer.from('morpheus-datafeed-v2', 'ascii');

// Match the relay's ByteArray conversion exactly: even-length hex is decoded as
// bytes, canonical base64 is decoded as bytes, and all other values are UTF-8.
// This matters for attestation_hash because the contract signs the bytes it will
// actually receive, not the caller's textual representation.
function toNeoByteStringBytes(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  const raw = trimString(value);
  if (!raw) return Buffer.alloc(0);
  if (isHexString(raw)) return Buffer.from(strip0x(raw), 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length > 0 && decoded.toString('base64') === raw) return decoded;
  }
  return Buffer.from(raw, 'utf8');
}

function encodeSegment(value) {
  const bytes = Buffer.from(value || []);
  if (bytes.length > 255) throw new Error('feed signature segment too long');
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function encodeHash160LittleEndian(contractHash) {
  const raw = strip0x(contractHash);
  if (!/^[0-9a-f]{40}$/i.test(raw)) throw new Error('valid data-feed contract hash is required');
  return Buffer.from(raw, 'hex').reverse();
}

function encodeNetworkMagicLittleEndian(networkMagic) {
  const value = Number(networkMagic);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('valid Neo network magic is required');
  }
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}

// C1 — the EXACT canonical v2 message the contract's BuildFeedMessage builds:
// domain | executing script hash (VM LE) | network magic (LE) | length-prefixed
// pair | price | timestamp | round | attestation bytes | source-set id. All
// values that affect the stored record are covered by the signature.
export function buildCanonicalFeedMessage({
  contractHash,
  networkMagic,
  storagePair,
  priceUnits,
  timestampSec,
  roundId,
  attestationHash,
  sourceSetId,
}) {
  const payload = Buffer.concat([
    FEED_SIGNATURE_DOMAIN,
    encodeHash160LittleEndian(contractHash),
    encodeNetworkMagicLittleEndian(networkMagic),
    encodeSegment(Buffer.from(String(storagePair ?? ''), 'utf8')),
    encodeSegment(Buffer.from(String(priceUnits ?? ''), 'utf8')),
    encodeSegment(Buffer.from(String(timestampSec ?? ''), 'utf8')),
    encodeSegment(Buffer.from(String(roundId ?? ''), 'utf8')),
    encodeSegment(toNeoByteStringBytes(attestationHash)),
    encodeSegment(Buffer.from(String(sourceSetId ?? ''), 'utf8')),
  ]);
  // Keep the existing test/export API string-shaped while signing the decoded
  // bytes below. This also makes vectors easy to compare across languages.
  return payload.toString('hex');
}

// C1 — produce a secp256r1 signature over the canonical feed message using the
// enclave-resident oracle verifier key, so the contract can enforce it once an
// admin registers the matching verification key. Returns null when no signing key
// is available (the worker then falls back to the unsigned updateFeed path, which
// keeps working until a verification key is registered). Caller-supplied key
// material is never used here — the dstack/env oracle_verifier role signs.
async function signFeedUpdate(
  payload,
  {
    contractHash,
    networkMagic,
    storagePair,
    priceUnits,
    timestampSec,
    roundId,
    attestationHash,
    sourceSetId,
  }
) {
  if (payload.neo_n3_feed_signing_required === false) return null;
  const message = buildCanonicalFeedMessage({
    contractHash,
    networkMagic,
    storagePair,
    priceUnits,
    timestampSec,
    roundId,
    attestationHash,
    sourceSetId,
  });
  const signed = await maybeSignNeoN3Bytes(Buffer.from(message, 'hex'), {
    network: payload.network,
    dstack_key_role: 'oracle_verifier',
  });
  const signature = trimString(signed?.signature || '');
  const publicKey = trimString(signed?.public_key || '');
  if (!signature && payload.neo_n3_feed_signing_required === true) {
    throw new Error('Neo N3 data feed requires signed updates, but the oracle verifier signer is unavailable');
  }
  if (!signature) return null;
  return { signature, public_key: publicKey };
}

// C1 — choose the contract entrypoint for a single feed update: when a signature
// was produced, use the 7-arg signed updateFeedSigned (the signature is appended
// as the 7th ByteArray param so the contract can verify it); otherwise the
// unchanged 6-arg updateFeed.
export function buildFeedUpdateInvocation(baseParams, signed) {
  if (signed && trimString(signed.signature)) {
    return {
      method: 'updateFeedSigned',
      params: [...baseParams, { type: 'ByteArray', value: signed.signature }],
    };
  }
  return { method: 'updateFeed', params: baseParams };
}

export async function submitQuoteToN3(
  dataFeedHash,
  neoContext,
  payload,
  quote,
  storagePair,
  roundId,
  sourceSetId,
  timestampSec
) {
  const priceUnits = decimalToIntegerString(quote.price, quote.decimals);
  // Provider observation timestamp, clamped against the strictly-monotonic
  // MorpheusDataFeed (B9) so a future-dated value cannot stall the feed. The
  // signature below MUST cover this exact submitted value, so resolve it once.
  const submitTimestampSec = String(resolveSubmitTimestampSec(quote, timestampSec));
  const roundIdStr = String(roundId);

  // C1 — sign the canonical message over the EXACT submitted tuple and provenance
  // so a registered on-chain verification key can enforce it. When no signing key
  // is available, signed is null and we use the unsigned updateFeed path (which
  // keeps working until a key is registered).
  const signed = await signFeedUpdate(payload, {
    contractHash: dataFeedHash,
    networkMagic: neoContext.networkMagic,
    storagePair,
    priceUnits,
    timestampSec: submitTimestampSec,
    roundId: roundIdStr,
    attestationHash: quote.attestation_hash,
    sourceSetId: String(sourceSetId),
  });

  const baseParams = [
    { type: 'String', value: storagePair },
    { type: 'Integer', value: roundIdStr },
    { type: 'Integer', value: priceUnits },
    { type: 'Integer', value: submitTimestampSec },
    { type: 'ByteArray', value: quote.attestation_hash },
    { type: 'Integer', value: String(sourceSetId) },
  ];

  const { method, params } = buildFeedUpdateInvocation(baseParams, signed);
  const invokeResult = await relayNeoN3Invocation({
    request_id: trimString(payload.request_id) || `pricefeed:${storagePair}:${Date.now()}`,
    network: payload.network,
    contract_hash: dataFeedHash,
    method,
    params,
    wait: resolveFeedSubmissionWait(payload),
    timeout_ms: resolveFeedSubmissionWaitTimeoutMs(payload),
    rpc_url: neoContext.rpcUrl,
    network_magic: neoContext.networkMagic,
    ...buildNeoN3RelaySigningPayload(payload),
  });
  if (invokeResult.status >= 400) {
    throw new Error(invokeResult.body?.error || 'Neo N3 feed submit failed');
  }
  // Surface the signature so the caller can persist it (buildFeedSignatureFields).
  if (signed) {
    quote.feed_signature = signed.signature;
    quote.feed_signer_public_key = signed.public_key;
  }
  return invokeResult.body;
}

// C1 — error raised when the batch updateFeeds path cannot be used because a
// verification key is registered (so each update must be signed) but updateFeeds
// has no signed batch entrypoint. submitQuotesToN3WithFallback recognizes this and
// routes through the per-feed signed updateFeedSigned submissions instead.
export const SIGNED_FEED_REQUIRES_PER_FEED_PATH = 'neo_n3_updatefeeds_requires_signed_path';

async function submitQuotesToN3(dataFeedHash, neoContext, payload, updates) {
  // If a verification key is configured, every update must be signed; the batch
  // updateFeeds entrypoint carries no signature, so signal the per-feed signed
  // fallback rather than submitting an unsigned batch that the contract rejects.
  const probe = await signFeedUpdate(payload, {
    contractHash: dataFeedHash,
    networkMagic: neoContext.networkMagic,
    storagePair: updates[0]?.storagePair,
    priceUnits: decimalToIntegerString(updates[0]?.quote.price, updates[0]?.quote.decimals),
    timestampSec: String(updates[0]?.timestampSec),
    roundId: String(updates[0]?.roundId),
    attestationHash: updates[0]?.quote?.attestation_hash,
    sourceSetId: String(updates[0]?.sourceSetId),
  });
  if (probe) {
    throw new Error(SIGNED_FEED_REQUIRES_PER_FEED_PATH);
  }

  const invokeResult = await relayNeoN3Invocation({
    request_id: trimString(payload.request_id) || `pricefeed:batch:${Date.now()}`,
    network: payload.network,
    contract_hash: dataFeedHash,
    method: 'updateFeeds',
    params: [
      {
        type: 'Array',
        value: updates.map((entry) => ({ type: 'String', value: entry.storagePair })),
      },
      { type: 'Array', value: updates.map((entry) => ({ type: 'Integer', value: entry.roundId })) },
      {
        type: 'Array',
        value: updates.map((entry) => ({
          type: 'Integer',
          value: decimalToIntegerString(entry.quote.price, entry.quote.decimals),
        })),
      },
      {
        type: 'Array',
        value: updates.map((entry) => ({ type: 'Integer', value: String(entry.timestampSec) })),
      },
      {
        type: 'Array',
        value: updates.map((entry) => ({ type: 'ByteArray', value: entry.quote.attestation_hash })),
      },
      {
        type: 'Array',
        value: updates.map((entry) => ({ type: 'Integer', value: String(entry.sourceSetId) })),
      },
    ],
    wait: resolveFeedSubmissionWait(payload),
    timeout_ms: resolveFeedSubmissionWaitTimeoutMs(payload),
    rpc_url: neoContext.rpcUrl,
    network_magic: neoContext.networkMagic,
    ...buildNeoN3RelaySigningPayload(payload),
  });
  if (invokeResult.status >= 400) {
    throw new Error(invokeResult.body?.error || 'Neo N3 batch feed submit failed');
  }
  return invokeResult.body;
}

function toNeoN3BatchUpdateFailureMessage(error) {
  return trimString(error instanceof Error ? error.message : String(error)).toLowerCase();
}

export function isMissingNeoN3BatchUpdateMethod(error) {
  const message = toNeoN3BatchUpdateFailureMessage(error);
  if (!message) return false;
  return (
    message.includes('method not found: updatefeeds/6') ||
    /method\s+["']?updatefeeds["']?\s+with\s+6\s+parameter\(s\)\s+doesn['’]?t\s+exist/.test(
      message
    ) ||
    /method\s+["']?updatefeeds["']?.*doesn['’]?t\s+exist/.test(message)
  );
}

function isUnauthorizedNeoN3BatchUpdate(error) {
  const message = toNeoN3BatchUpdateFailureMessage(error);
  if (!message) return false;
  return (
    message.includes('abortmsg is executed. reason: unauthorized') || message === 'unauthorized'
  );
}

function isSignedFeedPerFeedPathRequired(error) {
  return toNeoN3BatchUpdateFailureMessage(error) === SIGNED_FEED_REQUIRES_PER_FEED_PATH;
}

export function getRecoverableNeoN3BatchUpdateFailureReason(error) {
  if (isSignedFeedPerFeedPathRequired(error)) return SIGNED_FEED_REQUIRES_PER_FEED_PATH;
  if (isMissingNeoN3BatchUpdateMethod(error)) return 'neo_n3_updatefeeds_missing';
  if (isUnauthorizedNeoN3BatchUpdate(error)) return 'neo_n3_updatefeeds_unauthorized';
  return null;
}

export function isRecoverableNeoN3BatchUpdateFailure(error) {
  return Boolean(getRecoverableNeoN3BatchUpdateFailureReason(error));
}

export async function submitQuotesToN3WithFallback(dataFeedHash, neoContext, payload, updates) {
  try {
    return await submitQuotesToN3(dataFeedHash, neoContext, payload, updates);
  } catch (error) {
    const fallbackReason = getRecoverableNeoN3BatchUpdateFailureReason(error);
    if (!fallbackReason) {
      throw error;
    }

    const txs = [];
    for (const entry of updates) {
      const tx = await submitQuoteToN3(
        dataFeedHash,
        neoContext,
        payload,
        entry.quote,
        entry.storagePair,
        entry.roundId,
        entry.sourceSetId,
        entry.timestampSec
      );
      txs.push({
        storage_pair: entry.storagePair,
        tx,
      });
    }

    return {
      mode: 'single_fallback',
      reason: fallbackReason,
      txs,
    };
  }
}
