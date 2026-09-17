import { constants as cryptoConstants, verify as cryptoVerify } from 'node:crypto';
import { REQUEST_PROOF_ALGORITHM, REQUEST_PROOF_SCHEMA } from './constants.mjs';
import { ApiError } from './errors.mjs';
import { canonicalRequestProof } from './protocol.mjs';
import { validateAttestedPublicKey } from './session-sealer.mjs';
import { sha256Hex } from './codec.mjs';

const HEX_256 = /^[0-9a-f]{64}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function reject(message = 'request proof is absent, stale, replayed or invalid') {
  throw new ApiError(401, 'invalid_request_proof', message);
}

function hash(value) {
  if (typeof value !== 'string' || !HEX_256.test(value)) reject();
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !U64.test(value)) reject();
  const parsed = BigInt(value);
  if (parsed > MAX_U64) reject();
  return parsed;
}

function signature(value, expectedLength) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8192 ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value)
  ) {
    reject();
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== value) reject();
  return decoded;
}

export function verifySessionRequestProof({
  session,
  tokenHash,
  proof,
  nowMs,
  maximumClockSkewSeconds,
  expectedMethod,
  expectedPath,
}) {
  if (
    !session ||
    !proof ||
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(maximumClockSkewSeconds) ||
    maximumClockSkewSeconds < 1 ||
    !['GET', 'POST'].includes(proof.method) ||
    typeof proof.path !== 'string' ||
    proof.method !== expectedMethod ||
    proof.path !== expectedPath
  ) {
    reject();
  }
  const normalizedTokenHash = hash(tokenHash);
  const nonceHex = hash(proof.nonceHex);
  const bodySha256 = hash(proof.bodySha256);
  const timestampMs = timestamp(proof.timestampMs);
  const difference =
    timestampMs >= BigInt(nowMs) ? timestampMs - BigInt(nowMs) : BigInt(nowMs) - timestampMs;
  if (difference > BigInt(maximumClockSkewSeconds) * 1000n) reject();

  let key;
  try {
    key = validateAttestedPublicKey({
      publicKeyDerBase64: session.publicKeyDerBase64,
      publicKeySha256: session.publicKeySha256,
    });
  } catch {
    reject();
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (!Number.isInteger(modulusLength) || modulusLength % 8 !== 0) reject();
  let signedBytes;
  let valid = false;
  try {
    signedBytes = canonicalRequestProof({
      schema: REQUEST_PROOF_SCHEMA,
      method: proof.method,
      path: proof.path,
      session_token_sha256: normalizedTokenHash,
      timestamp_ms: timestampMs.toString(),
      nonce: nonceHex,
      body_sha256: bodySha256,
    });
    valid = cryptoVerify(
      'sha256',
      signedBytes,
      {
        key,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature(proof.signatureBase64, modulusLength / 8)
    );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    reject();
  }
  if (!valid) reject();
  return Object.freeze({
    algorithm: REQUEST_PROOF_ALGORITHM,
    nonceHex,
    timestampMs: timestampMs.toString(),
    requestDigest: sha256Hex(signedBytes),
    method: proof.method,
    path: proof.path,
    bodySha256,
  });
}
