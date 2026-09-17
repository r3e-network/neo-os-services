import { createHash } from 'node:crypto';
import { OPERATION_SCHEMA, RECEIPT_SCHEMA, REQUEST_PROOF_SCHEMA } from './constants.mjs';

const HEX_256 = /^[0-9a-f]{64}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const MAX_U64 = 18_446_744_073_709_551_615n;

function hash(value, name) {
  if (typeof value !== 'string' || !HEX_256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 hex string`);
  }
  return Buffer.from(value, 'hex');
}

function text(value, name, maximum = 2048) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${name} is not a bounded canonical string`);
  }
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function counter(value, name) {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !U64.test(normalized)) {
    throw new TypeError(`${name} must be a canonical u64 decimal string`);
  }
  const parsed = BigInt(normalized);
  if (parsed > MAX_U64) throw new TypeError(`${name} exceeds u64`);
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(parsed);
  return bytes;
}

function prefix(value) {
  return Buffer.from(`${value}\0`, 'ascii');
}

/** Canonical binary commit operation. This is independent of JSON key order. */
export function canonicalOperation(operation) {
  if (operation?.schema !== OPERATION_SCHEMA) {
    throw new TypeError(`operation must use ${OPERATION_SCHEMA}`);
  }
  return Buffer.concat([
    prefix(OPERATION_SCHEMA),
    text(operation.network, 'network', 32),
    hash(operation.vault_id, 'vault_id'),
    hash(operation.profile_id, 'profile_id'),
    hash(operation.network_id, 'network_id'),
    hash(operation.root_commitment, 'root_commitment'),
    text(operation.owner_id, 'owner_id', 128),
    counter(operation.epoch, 'epoch'),
    counter(operation.generation, 'generation'),
    counter(operation.snapshot_fence, 'snapshot_fence'),
    counter(operation.previous_generation, 'previous_generation'),
    counter(operation.previous_snapshot_fence, 'previous_snapshot_fence'),
    hash(operation.previous_snapshot_sha256, 'previous_snapshot_sha256'),
    text(operation.commit_id, 'commit_id', 128),
    hash(operation.mutation_digest, 'mutation_digest'),
    text(operation.snapshot_bucket, 'snapshot_bucket', 255),
    text(operation.snapshot_key, 'snapshot_key', 1024),
    text(operation.snapshot_version_id, 'snapshot_version_id', 1024),
    hash(operation.snapshot_sha256, 'snapshot_sha256'),
    counter(operation.snapshot_size_bytes, 'snapshot_size_bytes'),
  ]);
}

export function operationDigest(operation) {
  return createHash('sha256').update(canonicalOperation(operation)).digest('hex');
}

/** Exact bytes signed by the attested session key for every authenticated request. */
export function canonicalRequestProof(proof) {
  if (proof?.schema !== REQUEST_PROOF_SCHEMA) {
    throw new TypeError(`request proof must use ${REQUEST_PROOF_SCHEMA}`);
  }
  if (!['GET', 'POST'].includes(proof.method)) {
    throw new TypeError('request proof method is not canonical');
  }
  if (
    typeof proof.path !== 'string' ||
    !proof.path.startsWith('/v1/') ||
    proof.path.includes('?') ||
    proof.path.includes('#')
  ) {
    throw new TypeError('request proof path is not canonical');
  }
  return Buffer.concat([
    prefix(REQUEST_PROOF_SCHEMA),
    text(proof.method, 'method', 16),
    text(proof.path, 'path', 2048),
    hash(proof.session_token_sha256, 'session_token_sha256'),
    counter(proof.timestamp_ms, 'timestamp_ms'),
    hash(proof.nonce, 'nonce'),
    hash(proof.body_sha256, 'body_sha256'),
  ]);
}

/** Exact bytes signed by the asymmetric receipt KMS key. */
export function canonicalReceipt(receipt) {
  if (receipt?.schema !== RECEIPT_SCHEMA) {
    throw new TypeError(`receipt must use ${RECEIPT_SCHEMA}`);
  }
  return Buffer.concat([
    prefix(RECEIPT_SCHEMA),
    text(receipt.network, 'network', 32),
    hash(receipt.vault_id, 'vault_id'),
    hash(receipt.profile_id, 'profile_id'),
    hash(receipt.network_id, 'network_id'),
    hash(receipt.root_commitment, 'root_commitment'),
    text(receipt.commit_id, 'commit_id', 128),
    hash(receipt.operation_digest, 'operation_digest'),
    hash(receipt.mutation_digest, 'mutation_digest'),
    counter(receipt.previous_generation, 'previous_generation'),
    counter(receipt.previous_snapshot_fence, 'previous_snapshot_fence'),
    hash(receipt.previous_snapshot_sha256, 'previous_snapshot_sha256'),
    counter(receipt.generation, 'generation'),
    hash(receipt.snapshot_sha256, 'snapshot_sha256'),
    counter(receipt.epoch, 'epoch'),
    counter(receipt.snapshot_fence, 'snapshot_fence'),
    text(receipt.owner_id, 'owner_id', 128),
    text(receipt.snapshot_bucket, 'snapshot_bucket', 255),
    text(receipt.snapshot_key, 'snapshot_key', 1024),
    text(receipt.snapshot_version_id, 'snapshot_version_id', 1024),
    counter(receipt.snapshot_size_bytes, 'snapshot_size_bytes'),
    counter(receipt.lease_expires_at_ms, 'lease_expires_at_ms'),
    counter(receipt.committed_at_ms, 'committed_at_ms'),
    text(receipt.receipt_key_id, 'receipt_key_id', 128),
  ]);
}

export const __protocolInternalsForTests = Object.freeze({ counter, hash, text });
