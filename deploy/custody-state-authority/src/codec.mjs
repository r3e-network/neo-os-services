import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { MAX_U64 } from './constants.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HEX_256 = /^[0-9a-f]{64}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;

export function requireObject(value, label = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', `${label} must be a JSON object`);
  }
  return value;
}

export function requireExactKeys(value, allowed, label = 'body') {
  requireObject(value, label);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    const details = [
      unknown.length ? `unknown fields: ${unknown.sort().join(', ')}` : '',
      missing.length ? `missing fields: ${missing.join(', ')}` : '',
    ].filter(Boolean);
    throw new ApiError(400, 'invalid_request_shape', `${label} has ${details.join('; ')}`);
  }
  return value;
}

export function identifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new ApiError(
      400,
      'invalid_identifier',
      `${field} must match ${IDENTIFIER.source} and must not contain a path separator or #`
    );
  }
  return value;
}

export function nullableIdentifier(value, field) {
  return value === null ? null : identifier(value, field);
}

export function sha256(value, field) {
  if (typeof value !== 'string' || !HEX_256.test(value)) {
    throw new ApiError(
      400,
      'invalid_sha256',
      `${field} must be 64 lowercase hexadecimal characters`
    );
  }
  return value;
}

export function u64(value, field, { allowZero = true } = {}) {
  if (typeof value !== 'string' || !U64.test(value)) {
    throw new ApiError(400, 'invalid_counter', `${field} must be a canonical u64 decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_U64 || (!allowZero && parsed === 0n)) {
    throw new ApiError(400, 'invalid_counter', `${field} is outside the accepted u64 range`);
  }
  return value;
}

export function incrementU64(value, field) {
  const next = BigInt(u64(value, field)) + 1n;
  if (next > MAX_U64) {
    throw new ApiError(409, 'counter_exhausted', `${field} cannot be incremented`);
  }
  return next.toString();
}

export function decrementU64(value, field) {
  const parsed = BigInt(u64(value, field, { allowZero: false }));
  return (parsed - 1n).toString();
}

export function positiveSize(value, field, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ApiError(400, 'invalid_size', `${field} must be an integer in [1, ${maximum}]`);
  }
  return value;
}

export function boundedString(value, field, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new ApiError(400, 'invalid_string', `${field} must contain 1-${maximum} characters`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new ApiError(400, 'invalid_string', `${field} must not contain control characters`);
  }
  return value;
}

export function sessionToken(value) {
  if (typeof value !== 'string' || !BASE64URL_TOKEN.test(value)) {
    throw new ApiError(401, 'invalid_session', 'a valid custody session bearer token is required');
  }
  return value;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new TypeError('canonical numbers must be safe integers');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical objects must be plain objects');
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          if (value[key] === undefined) throw new TypeError(`canonical field ${key} is undefined`);
          return [key, canonicalValue(value[key])];
        })
    );
  }
  throw new TypeError(`unsupported canonical value type: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fingerprint(value) {
  return sha256Hex(canonicalJson(value));
}

export function randomBase64Url(randomBytes, size) {
  const value = randomBytes(size);
  if (!Buffer.isBuffer(value) || value.length !== size) {
    throw new Error('random source returned the wrong number of bytes');
  }
  return value.toString('base64url');
}

export function randomHex(randomBytes, size) {
  const value = randomBytes(size);
  if (!Buffer.isBuffer(value) || value.length !== size) {
    throw new Error('random source returned the wrong number of bytes');
  }
  return value.toString('hex');
}
